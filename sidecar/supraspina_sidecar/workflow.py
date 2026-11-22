"""Side-effect-free planning of the authoritative Supraspina workflow graph."""

from __future__ import annotations

import copy
import csv
import fnmatch
import hashlib
import math
import os
import uuid
from dataclasses import dataclass
from typing import Any

from .adapters.base import ADAPTERS, guard_resolved
from .cohort import CohortError, CohortSnapshot, build_cohort_snapshot
from .paths import PreparedConfig, flatten, interpolate
from .provenance import stable_digest
from .registry import STEP_BY_KEY, STEP_DESCRIPTORS, STEP_SCOPES
from .registry_store import RegistryStore
from .runtime_resources import resolve_runtime_resources
from .sites import site_state

_MAX_AGE_METADATA_COLUMNS = 512
_MAX_AGE_METADATA_ROWS = 1_000_000
_MAX_AGE_METADATA_BYTES = 64 * 1024 * 1024
_MAX_SAFE_INTEGER = (1 << 53) - 1
_BLOCKER_SUBJECT_SAMPLE = 8
_METADATA_COHORT_ROLES = {
    "healthy",
    "sci-no-neuropathic-pain",
    "sci-neuropathic-pain",
}
_FINAL_GROUPS = {
    "healthy": "control",
    "sci-neuropathic-pain": "SCI_P",
    "sci-no-neuropathic-pain": "SCI_nNP",
}
_FINAL_MIN_GROUP_SIZE = 2
_OPEN_REGISTRY_ACTION = "open-registry"
# Stages whose science reads the site: the R analysis site-balanced comparisons and
# the BrainCharts adaptation and z-score stages appended after it. A mix of
# set and unset sites blocks them; every other stage ignores sites.
_SITE_STEPS = frozenset({"final", "braincharts", "zstats"})
# The stages that read the registry while planning.
_REGISTRY_STEPS = frozenset({"clinical"}) | _SITE_STEPS
# The stages whose projection needs a resolved cohort role for every subject.
_ROLE_STEPS = frozenset({"clinical", "final", "braincharts"})
# BrainCharts adapts the model to a site only with at least 2 usable controls
# (registry age within the model's -5 to 110 years, sex F or M), as
# braincharts_run.py counts them. The run also refuses a subject with a
# missing region value, which only the feature table shows, so a plan can
# count a control the run then refuses.
_BRAINCHARTS_MIN_CONTROLS = 2
_BRAINCHARTS_SEXES = frozenset({"F", "M"})
_BRAINCHARTS_AGE_RANGE = (-5.0, 110.0)
# Like R analysis, the z-score comparisons need 2 subjects per group, counting
# only the subjects BrainCharts gives z-scores.
_ZSCORE_MIN_GROUP_SIZE = 2
_ZSCORE_SOURCE_BLOCKER = (
    "Enable BrainCharts normative modeling; the z-score comparisons read its z-scores."
)
_SITE_BLOCKER_SAMPLE = 2


@dataclass(frozen=True)
class PlannedWorkflow:
    """Represent a plan and its scheduler-only execution context."""

    result: dict[str, Any]
    cohort: CohortSnapshot | None
    effective_cfg: dict[str, Any]
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class RuntimeCfgInputs:
    """Represent private prepared-input and managed-resource plan bindings."""

    prepared_bindings: dict[str, dict[str, Any]] | None = None
    resource_runtime: dict[str, Any] | None = None


def validate_config_revision(value: Any) -> int:
    """Return a non-negative protocol-safe config revision without coercion."""
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > _MAX_SAFE_INTEGER
    ):
        raise ValueError("Provide configRevision as a non-negative safe integer.")
    return value


def validate_boolean(value: Any, field: str) -> bool:
    """Return an exact JSON boolean and reject truthy strings or numbers."""
    if not isinstance(value, bool):
        raise ValueError(f"Provide {field} as a boolean.")
    return value


def validate_workflow_acknowledgements(value: Any) -> dict[str, Any]:
    """Validate the acknowledgment envelope used by planning and recovery."""
    if value is None:
        source: dict[str, Any] = {}
    elif isinstance(value, dict):
        source = value
    else:
        raise ValueError("Provide acknowledgements as an object.")
    include_pending = validate_boolean(
        source.get("includeDeferredAndUnreviewedQc", False),
        "acknowledgements.includeDeferredAndUnreviewedQc",
    )
    acknowledge_memory = validate_boolean(
        source.get("acknowledgeMemoryAdvisory", False),
        "acknowledgements.acknowledgeMemoryAdvisory",
    )
    return {
        "includeDeferredAndUnreviewedQc": include_pending,
        "acknowledgeMemoryAdvisory": acknowledge_memory,
    }


def _node_id(index: int, step_key: str, subject_id: str | None) -> str:
    token = hashlib.sha256(f"{step_key}:{subject_id or 'cohort'}".encode()).hexdigest()[
        :8
    ]
    return f"node-{index:03d}-{token}"


def _enabled(cfg: dict[str, Any], key: str) -> bool:
    steps = cfg.get("steps", {}) if isinstance(cfg.get("steps"), dict) else {}
    value = steps.get(key, {}) if isinstance(steps.get(key), dict) else {}
    return bool(value.get("enabled", False))


def _target(intent: dict[str, Any]) -> tuple[str, list[str] | None]:
    target = intent.get("target", {}) if isinstance(intent.get("target"), dict) else {}
    mode = str(target.get("mode", "all"))
    subject_ids = target.get("subjectIds") if mode == "explicit" else None
    if mode == "explicit" and not isinstance(subject_ids, list):
        raise CohortError("Provide explicit target subjectIds as an array.")
    if subject_ids is not None and any(
        not isinstance(subject_id, str) for subject_id in subject_ids
    ):
        raise CohortError("Provide only strings in explicit target subjectIds.")
    return mode, subject_ids


@dataclass(frozen=True)
class _CohortBlocker:
    """Represent one registry-derived reason with every subject it names."""

    reason: str
    subjects: tuple[str, ...]


def _cohort_blocker_entry(step_key: str, detail: _CohortBlocker) -> dict[str, Any]:
    """Publish the sampled prose beside the complete affected-subject list."""
    return {
        "key": step_key,
        "reason": detail.reason,
        "kind": "cohort",
        "subjects": list(detail.subjects),
        "subjectCount": len(detail.subjects),
        "action": _OPEN_REGISTRY_ACTION,
    }


def _cohort_role_blocker(
    step_name: str,
    analysis_subject_ids: tuple[str, ...],
    registry: dict[str, dict[str, Any]],
) -> _CohortBlocker | None:
    """Describe missing and ambiguous roles for one metadata-producing step."""
    missing = [
        subject_id for subject_id in analysis_subject_ids if subject_id not in registry
    ]
    ambiguous = [
        subject_id
        for subject_id in analysis_subject_ids
        if subject_id in registry
        and registry[subject_id].get("cohortRole") not in _METADATA_COHORT_ROLES
    ]
    if not missing and not ambiguous:
        return None

    def summarize(subject_ids: list[str]) -> str:
        sample = ", ".join(subject_ids[:_BLOCKER_SUBJECT_SAMPLE])
        remaining = len(subject_ids) - _BLOCKER_SUBJECT_SAMPLE
        return f"{sample} (+{remaining} more)" if remaining > 0 else sample

    details = []
    if missing:
        details.append(f"Assign registry roles to {summarize(missing)}")
    if ambiguous:
        details.append(f"Resolve ambiguous registry roles for {summarize(ambiguous)}")
    return _CohortBlocker(
        reason=f"Prepare {step_name}. {'. '.join(details)}.",
        subjects=tuple(sorted(set(missing) | set(ambiguous))),
    )


def _final_group_size_blocker(
    analysis_subject_ids: tuple[str, ...],
    registry: dict[str, dict[str, Any]],
) -> _CohortBlocker | None:
    """Describe semantic groups too small for every R analysis comparison."""
    counts = {label: 0 for label in _FINAL_GROUPS.values()}
    for subject_id in analysis_subject_ids:
        role = registry.get(subject_id, {}).get("cohortRole")
        label = _FINAL_GROUPS.get(str(role))
        if label is not None:
            counts[label] += 1
    ordered = ("control", "SCI_P", "SCI_nNP")
    deficits = [
        (label, _FINAL_MIN_GROUP_SIZE - counts[label])
        for label in ordered
        if counts[label] < _FINAL_MIN_GROUP_SIZE
    ]
    if not deficits:
        return None
    needs = ", ".join(
        f"{count} {label} subject{'s' if count != 1 else ''}"
        for label, count in deficits
    )
    summary = ", ".join(f"{label}={counts[label]}" for label in ordered)
    undersized = {label for label, _ in deficits}
    return _CohortBlocker(
        reason=(
            f"Add or relabel {needs} in the Registry so R analysis has at least 2 "
            f"subjects per semantic group (current counts: {summary}); then "
            "review the plan again."
        ),
        subjects=tuple(
            sorted(
                subject_id
                for subject_id in analysis_subject_ids
                if _FINAL_GROUPS.get(
                    str(registry.get(subject_id, {}).get("cohortRole"))
                )
                in undersized
            )
        ),
    )


def _brainpad_site_advisory(
    analysis_subject_ids: tuple[str, ...],
    registry: dict[str, dict[str, Any]],
) -> str | None:
    """Name the sites without controls whose subjects Brain-PAD statistics pool.

    Brain-PAD statistics pool all sites, so their results do not depend on
    site labels; the advisory states the confound instead. A project without
    sites never reaches ``site_state``.
    """
    if not any(
        registry.get(subject_id, {}).get("site") for subject_id in analysis_subject_ids
    ):
        return None
    state = site_state(registry.values(), analysis_subject_ids)
    lacking = [
        summary["site"]
        for summary in state["sites"]
        if summary["roles"].get("healthy", 0) == 0
    ]
    if not lacking:
        return None
    if len(lacking) == 1:
        named = f"site {lacking[0]} has"
    elif len(lacking) == 2:  # noqa: PLR2004 - "a and b" needs no serial comma
        named = f"sites {lacking[0]} and {lacking[1]} have"
    else:
        named = f"sites {', '.join(lacking[:-1])}, and {lacking[-1]} have"
    return f"Brain-PAD statistics pool all sites; {named} no controls."


def _braincharts_usable(record: dict[str, Any]) -> bool:
    """Say whether BrainCharts can give a subject z-scores from its registry row.

    The age must lie within the model's age range and the sex be F or M; the
    run refuses the others by name.
    """
    age = record.get("age")
    if isinstance(age, bool) or not isinstance(age, (int, float)):
        return False
    low, high = _BRAINCHARTS_AGE_RANGE
    return (
        math.isfinite(age)
        and low <= age <= high
        and record.get("sex") in _BRAINCHARTS_SEXES
    )


def _braincharts_site_controls(
    analysis_subject_ids: tuple[str, ...],
    registry: dict[str, dict[str, Any]],
) -> dict[str, tuple[int, int]]:
    """Count each site's usable controls and usable subjects for BrainCharts.

    See :func:`_braincharts_usable`. An unset site counts as the one unnamed
    site.
    """
    counts: dict[str, list[int]] = {}
    for subject_id in analysis_subject_ids:
        record = registry.get(subject_id, {})
        if not _braincharts_usable(record):
            continue
        site = record.get("site")
        entry = counts.setdefault(site if isinstance(site, str) else "", [0, 0])
        entry[1] += 1
        if record.get("cohortRole") == "healthy":
            entry[0] += 1
    return {site: (controls, subjects) for site, (controls, subjects) in counts.items()}


def _braincharts_site_blocker(
    analysis_subject_ids: tuple[str, ...],
    registry: dict[str, dict[str, Any]],
) -> _CohortBlocker | None:
    """Block BrainCharts when no site has 2 usable controls to adapt the model."""
    counts = _braincharts_site_controls(analysis_subject_ids, registry)
    if any(controls >= _BRAINCHARTS_MIN_CONTROLS for controls, _ in counts.values()):
        return None
    return _CohortBlocker(
        reason="No site has at least 2 controls, so the model cannot be adapted.",
        subjects=tuple(
            sorted(
                subject_id
                for subject_id in analysis_subject_ids
                if registry.get(subject_id, {}).get("cohortRole") == "healthy"
            )
        ),
    )


def _braincharts_site_advisory(
    analysis_subject_ids: tuple[str, ...],
    registry: dict[str, dict[str, Any]],
) -> str | None:
    """State which sites BrainCharts refuses when it adapts to the others."""
    counts = _braincharts_site_controls(analysis_subject_ids, registry)
    refused = sorted(
        site
        for site, (controls, _subjects) in counts.items()
        if controls < _BRAINCHARTS_MIN_CONTROLS
    )
    if not refused:
        return None
    facts = []
    for site in refused:
        controls, subjects = counts[site]
        named = f"Site {site}" if site else "The cohort"
        if controls == 0:
            facts.append(f"{named} has no controls")
        else:
            facts.append(f"{named} has 1 control")
        facts[-1] += (
            f", so its {subjects} subject gets no z-scores"
            if subjects == 1
            else f", so its {subjects} subjects get no z-scores"
        )
    adapted = len(counts) - len(refused)
    return (
        f"BrainCharts adapts the model to {adapted} of {len(counts)} sites. "
        + ". ".join(facts)
        + "."
    )


def _braincharts_held_out_controls(controls: int) -> int:
    """Return how many of a site's controls get z-scores (held out of adaptation).

    Mirrors ``adaptation_count`` in ``braincharts_run.py``: fewer than 2 controls
    refuse the site, exactly 2 both adapt, and 3 or more adapt
    ``round(n * 0.5)`` (half to even, at least 1, at most n - 1).
    """
    if controls <= _BRAINCHARTS_MIN_CONTROLS:
        return 0
    return controls - max(1, min(controls - 1, round(controls * 0.5)))


def _zscore_group_counts(
    analysis_subject_ids: tuple[str, ...],
    registry: dict[str, dict[str, Any]],
) -> dict[str, int]:
    """Count the subjects of each R analysis group that BrainCharts gives z-scores.

    Usable subjects are counted as BrainCharts counts them. A refused site
    contributes nothing, adaptation controls get no z-score, and every SCI
    subject of an adapted site does. The split is random only in which
    controls are held out, never in how many.
    """
    by_site: dict[str, dict[str, int]] = {}
    for subject_id in analysis_subject_ids:
        record = registry.get(subject_id, {})
        if not _braincharts_usable(record):
            continue
        label = _FINAL_GROUPS.get(str(record.get("cohortRole")))
        if label is None:
            continue
        site = record.get("site")
        counts = by_site.setdefault(site if isinstance(site, str) else "", {})
        counts[label] = counts.get(label, 0) + 1
    totals = {label: 0 for label in ("control", "SCI_P", "SCI_nNP")}
    for counts in by_site.values():
        controls = counts.get("control", 0)
        if controls < _BRAINCHARTS_MIN_CONTROLS:
            continue
        totals["control"] += _braincharts_held_out_controls(controls)
        totals["SCI_P"] += counts.get("SCI_P", 0)
        totals["SCI_nNP"] += counts.get("SCI_nNP", 0)
    return totals


def _zscore_group_size_blocker(
    analysis_subject_ids: tuple[str, ...],
    registry: dict[str, dict[str, Any]],
) -> _CohortBlocker | None:
    """Block the z-score comparisons when a group would have under 2 z-scores."""
    counts = _zscore_group_counts(analysis_subject_ids, registry)
    undersized = {
        label for label, count in counts.items() if count < _ZSCORE_MIN_GROUP_SIZE
    }
    if not undersized:
        return None
    summary = ", ".join(f"{label}={count}" for label, count in counts.items())
    return _CohortBlocker(
        reason=(
            "Add subjects so each group has at least 2 subjects with z-scores "
            f"(z-score counts: {summary}); adaptation controls and refused sites "
            "get no z-scores. Then review the plan again."
        ),
        subjects=tuple(
            sorted(
                subject_id
                for subject_id in analysis_subject_ids
                if _FINAL_GROUPS.get(
                    str(registry.get(subject_id, {}).get("cohortRole"))
                )
                in undersized
            )
        ),
    )


def _zscore_source_blocker(cfg: dict[str, Any]) -> str | None:
    """Block the z-score comparisons without BrainCharts on or its outputs done.

    A BrainCharts stage turned off may still feed a run from its current
    outputs; the scheduler then checks its receipt like any producer's.
    """
    if _enabled(cfg, "braincharts"):
        return None
    adapter = ADAPTERS.get("braincharts")
    try:
        done = adapter is not None and adapter.detect(cfg, None).state == "done"
    except Exception:  # An unreadable output is not done.
        done = False
    return None if done else _ZSCORE_SOURCE_BLOCKER


def _zscore_blockers(
    cfg: dict[str, Any],
    analysis_subject_ids: tuple[str, ...],
    registry: dict[str, dict[str, Any]],
    nodes: list[dict[str, Any]],
) -> _CohortBlocker | str | None:
    """Return the z-score stage's own blocker, or ``None``.

    A blocked BrainCharts node in the same plan is left to explain itself, as
    dependency propagation names it; the group sizes then follow from it.
    """
    source = _zscore_source_blocker(cfg)
    if source is not None:
        return source
    if any(
        node["stepKey"] == "braincharts" and node["status"] == "blocked"
        for node in nodes
    ):
        return None
    return _zscore_group_size_blocker(analysis_subject_ids, registry)


def _mixed_site_blocker(
    analysis_subject_ids: tuple[str, ...],
    registry: dict[str, dict[str, Any]],
) -> _CohortBlocker | None:
    """Name the subjects without a site when only some subjects have one.

    No site anywhere is one implicit site, so only a mix blocks: it would
    split the cohort into a named site and an unnamed remainder.
    """
    state = site_state(registry.values(), analysis_subject_ids)
    if state["mode"] != "mixed":
        return None
    unset = state["unset"]
    named = _sampled_subjects(unset)
    others = "this subject does not" if len(unset) == 1 else "these do not"
    return _CohortBlocker(
        reason=(f"Set a site for {named}; some subjects have a site and {others}."),
        subjects=tuple(unset),
    )


def _sampled_subjects(subject_ids: list[str]) -> str:
    """Name up to three subjects and count the rest, as plan reasons do."""
    remaining = len(subject_ids) - _SITE_BLOCKER_SAMPLE
    if len(subject_ids) == 1:
        return subject_ids[0]
    if len(subject_ids) == _SITE_BLOCKER_SAMPLE:
        return f"{subject_ids[0]} and {subject_ids[1]}"
    if remaining == 1:
        return f"{', '.join(subject_ids[:2])}, and {subject_ids[2]}"
    return f"{', '.join(subject_ids[:2])}, and {remaining} more subjects"


# The subject and site columns the Final metadata projection reads and
# replaces (workflow_manager._metadata_projection).
_METADATA_ID_COLUMNS = ("participant_id", "SubjectID", "Subject_ID", "ID", "subject")
_METADATA_SITE_COLUMNS = ("Site", "site")


def _metadata_sites(source: str) -> list[tuple[str, str]] | None:
    """Read each ``(subject, stated site)`` row of a metadata file, bounded.

    Return ``None`` for a file without a subject or site column, beyond the
    bounds, or unreadable; the Final projection names those when it runs.
    """
    try:
        if os.path.getsize(source) > _MAX_AGE_METADATA_BYTES:
            return None
        with open(source, newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            fields = list(reader.fieldnames or [])
            id_column = next((c for c in _METADATA_ID_COLUMNS if c in fields), None)
            site_column = next((c for c in _METADATA_SITE_COLUMNS if c in fields), None)
            if (
                id_column is None
                or site_column is None
                or len(fields) > _MAX_AGE_METADATA_COLUMNS
            ):
                return None
            rows: list[tuple[str, str]] = []
            for index, row in enumerate(reader):
                if index >= _MAX_AGE_METADATA_ROWS:
                    return None
                rows.append(
                    (
                        str(row.get(id_column) or "").strip(),
                        str(row.get(site_column) or "").strip(),
                    )
                )
            return rows
    except (OSError, UnicodeError, csv.Error):
        return None


def _metadata_site_advisory(
    cfg: dict[str, Any],
    analysis_subject_ids: tuple[str, ...],
    registry: dict[str, dict[str, Any]],
) -> str | None:
    """Name the subjects whose metadata site differs from the registry site.

    The registry is the one site source: the Final projection replaces a
    ``Site`` column of the metadata file, so a differing value there is
    silently unused. An empty cell states no site.
    """
    metadata_dir = interpolate(
        str(cfg.get("paths", {}).get("metadataDir") or ""), flatten(cfg)
    )
    if "${" in metadata_dir or not os.path.isabs(metadata_dir):
        return None
    rows = _metadata_sites(os.path.join(metadata_dir, "metadata.csv"))
    analysis = set(analysis_subject_ids)
    differing = sorted(
        {
            subject_id
            for subject_id, stated in rows or []
            if subject_id in analysis
            and stated
            and stated != _registry_site(registry.get(subject_id, {}))
        }
    )
    if not differing:
        return None
    return (
        f"The metadata file gives {_sampled_subjects(differing)} a different "
        "site from the registry; R analysis uses the registry site."
    )


def _registry_site(record: dict[str, Any]) -> str:
    site = record.get("site")
    return site if isinstance(site, str) else ""


def _propagate_blocked_dependencies(
    nodes: list[dict[str, Any]], blockers: list[dict[str, Any]]
) -> None:
    """Block the transitive dependent closure of an already blocked node."""
    by_id = {node["nodeId"]: node for node in nodes}
    # Track the first non-dependency cause behind each blocked node so a
    # chain of dependents names it once instead of nesting reasons.
    root_by_id: dict[str, dict[str, str]] = {}
    changed = True
    while changed:
        changed = False
        for node in nodes:
            if node["status"] not in {"planned", "waiting"}:
                continue
            blocked_dependency = next(
                (
                    by_id[dependency_id]
                    for dependency_id in node.get("dependencies", [])
                    if dependency_id in by_id
                    and by_id[dependency_id]["status"] == "blocked"
                ),
                None,
            )
            if blocked_dependency is None:
                continue
            # Name the stage this node waits for and carry the root cause
            # once, so a chain of dependents does not nest the same text.
            root = root_by_id.get(blocked_dependency["nodeId"]) or {
                "stepKey": str(blocked_dependency["stepKey"]),
                "reason": str(
                    blocked_dependency.get("reason", "Create a runnable upstream node.")
                ),
            }
            dependency_name = _step_name(str(blocked_dependency["stepKey"]))
            root_reason = str(root["reason"]).rstrip(".")
            reason = (
                f"Wait for {dependency_name}, which is blocked: {root_reason}."
                if root["stepKey"] == blocked_dependency["stepKey"]
                else (
                    f"Wait for {dependency_name}. "
                    f"{_step_name(str(root['stepKey']))} is blocked: {root_reason}."
                )
            )
            node["status"] = "blocked"
            node["reason"] = reason
            root_by_id[node["nodeId"]] = root
            node.pop("command", None)
            blockers.append(
                {"key": node["stepKey"], "reason": reason, "kind": "dependency"}
            )
            changed = True


def _step_name(step_key: str) -> str:
    """Return the operator-facing stage name, or the key when unregistered."""
    descriptor = STEP_BY_KEY.get(step_key)  # type: ignore[call-overload]
    return str(descriptor["name"]) if descriptor else step_key


#: How each dependency outcome that stops a dependent node reads after the
#: dependency's stage name.
DEPENDENCY_OUTCOMES: dict[str, str] = {
    "failed": "failed",
    "cancelled": "was canceled",
    "blocked": "was blocked",
    "withheld": "was withheld by the failure policy",
    "interrupted": "was interrupted",
    "stale": "has an unknown run state",
    "unknown": "has an unresolved outcome",
    "skipped": "was skipped",
    "persistence-error": "ended with a storage error",
}
_DEPENDENCY_OUTCOME_FALLBACK = "did not finish"


def blocked_dependency_reason(step_key: str, status: str) -> str:
    """State why a node did not run because a dependency ended unfinished.

    Parameters
    ----------
    step_key
        The registry key of the dependency's stage.
    status
        The dependency node's terminal status.

    Returns
    -------
    str
        A sentence that names the stage the way the app does and states its
        outcome, for example "Reconstruction failed, so this step did not run."
        An unregistered stage reads as its key and an unlisted status as a
        stage that did not finish.
    """
    outcome = DEPENDENCY_OUTCOMES.get(status, _DEPENDENCY_OUTCOME_FALLBACK)
    return f"{_step_name(step_key)} {outcome}, so this step did not run."


def _collapse_blockers(
    nodes: list[dict[str, Any]], blockers: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Report each distinct cause once, with every subject it blocks.

    Per-subject stages add one blocker per node, so a cohort-wide cause is
    otherwise repeated once per subject. Merge entries that share a stage,
    kind, and reason; list the blocked subjects on the merged entry, and keep
    the first action seen.
    """
    subjects_by_reason: dict[tuple[str, str], set[str]] = {}
    for node in nodes:
        subject_id = node.get("subjectId")
        if node.get("status") == "blocked" and isinstance(subject_id, str):
            key = (str(node.get("stepKey")), str(node.get("reason", "")))
            subjects_by_reason.setdefault(key, set()).add(subject_id)
    collapsed: dict[tuple[str, str, str], dict[str, Any]] = {}
    for blocker in blockers:
        identity = (
            str(blocker.get("key")),
            str(blocker.get("kind", "")),
            str(blocker.get("reason")),
        )
        existing = collapsed.get(identity)
        if existing is None:
            existing = dict(blocker)
            collapsed[identity] = existing
        elif "action" not in existing and "action" in blocker:
            existing["action"] = blocker["action"]
        blocked = subjects_by_reason.get((identity[0], identity[2]))
        if blocked:
            merged = set(existing.get("subjects", [])) | blocked
            existing["subjects"] = sorted(merged)
    return list(collapsed.values())


def runtime_cfg(
    cfg: dict[str, Any],
    cohort: CohortSnapshot,
    run_id: str,
    project_root: str,
    *,
    inputs: RuntimeCfgInputs | None = None,
) -> dict[str, Any]:
    """Overlay run-scoped wrapper inputs without mutating persisted config."""
    effective = copy.deepcopy(cfg)
    run_dir = os.path.join(project_root, ".supraspina", "runs", run_id)
    deface_enabled = _enabled(cfg, "deface")
    deface = ADAPTERS.get("deface")
    t1 = cohort.t1_by_subject
    prepared = dict(t1)
    decision_signatures: dict[str, str] = {}
    prepared_evidence: dict[str, dict[str, Any]] = {}
    private_inputs = inputs or RuntimeCfgInputs()
    for subject_id, binding in (private_inputs.prepared_bindings or {}).items():
        prepared_path = binding.get("preparedT1Path")
        if subject_id in prepared and isinstance(prepared_path, str) and prepared_path:
            prepared[subject_id] = prepared_path
        decision = binding.get("decisionSignature")
        if isinstance(decision, str) and decision:
            decision_signatures[subject_id] = decision
        prepared_evidence[subject_id] = {
            key: copy.deepcopy(binding.get(key))
            for key in (
                "passThrough",
                "preflightSignature",
                "sourceSha256",
                "outputSha256",
                "decisionSignature",
            )
        }
    recon_inputs = dict(prepared)
    if deface_enabled and deface is not None:
        recon_inputs = {
            subject_id: deface.output_path(effective, subject_id)  # type: ignore[attr-defined]
            for subject_id in cohort.analysis_subject_ids
        }
    effective["_supraspinaRuntime"] = {
        "runId": run_id,
        "runDir": run_dir,
        "t1BySubject": t1,
        "preparedT1BySubject": prepared,
        "reconInputBySubject": recon_inputs,
        "inputFovDecisionSignatures": decision_signatures,
        "inputFovEvidence": prepared_evidence,
        "cohortSubjectsFile": os.path.join(run_dir, "inputs", "subjects.txt"),
        "freesurferView": os.path.join(run_dir, "inputs", "freesurfer"),
        "reconstructionViewSubjectIds": list(cohort.analysis_subject_ids),
        "clinicalMetadataFile": os.path.join(
            run_dir, "inputs", "clinical-control-labels.csv"
        ),
        "finalMetadataFile": os.path.join(run_dir, "inputs", "final-sci-h-labels.csv"),
        "brainchartsMetadataFile": os.path.join(
            run_dir, "inputs", "braincharts-metadata.csv"
        ),
        "brainchartsWorkDir": os.path.join(run_dir, "work", "braincharts"),
        "analysisCohortDigest": cohort.analysis_digest,
        "selectedSubsetDigest": cohort.selected_digest,
    }
    effective["_supraspinaRuntime"].update(
        copy.deepcopy(private_inputs.resource_runtime or {})
    )
    # Hand back a prepared mapping so the per-subject runtime entries below are
    # flattened once for the whole run instead of once per resolved template.
    return PreparedConfig(effective)


def _summary(nodes: list[dict[str, Any]], message: str | None = None) -> dict[str, Any]:
    statuses = [node["status"] for node in nodes]
    planned = sum(status in {"planned", "waiting", "queued"} for status in statuses)
    started = sum(
        status in {"running", "done", "failed", "cancelled"} for status in statuses
    )
    waiting = sum(status in {"waiting", "queued"} for status in statuses)
    blocked = sum(status in {"blocked", "withheld", "stale"} for status in statuses)
    skipped = sum(status == "skipped" for status in statuses)
    if message is None:
        message = (
            f"Review plan totals: planned {planned}; waiting {waiting}; "
            f"blocked {blocked}; skipped {skipped}."
        )
    return {
        "planned": planned,
        "started": started,
        "waiting": waiting,
        "blocked": blocked,
        "skipped": skipped,
        "message": message,
    }


def _blocked_result(plan_id: str, reason: str, key: str = "recon") -> PlannedWorkflow:
    summary = _summary([], reason)
    plan = {
        "planId": plan_id,
        "analysisCohort": {"subjectIds": [], "sha256": stable_digest([])},
        "selectedSubset": {"subjectIds": [], "sha256": stable_digest([])},
        "nodes": [],
        "blockers": [{"key": key, "reason": reason, "kind": "cohort"}],
        "summary": summary,
    }
    return PlannedWorkflow(
        result={
            "runId": None,
            "disposition": "blocked",
            "plan": plan,
            "summary": summary,
        },
        cohort=None,
        effective_cfg={},
        warnings=(),
    )


def _age_outer_reconciliation(  # noqa: PLR0911
    cfg: dict[str, Any], cohort: CohortSnapshot
) -> tuple[dict[str, Any] | None, str | None]:
    params = cfg.get("steps", {}).get("age", {}).get("params", {})
    if str(params.get("join", "left")) != "outer":
        return None, None
    metadata = str(cfg.get("paths", {}).get("ageMetadataFile") or "")
    subject_column = str(params.get("subjectIdColumn", "participant_id"))
    try:
        if os.path.getsize(metadata) > 64 * 1024 * 1024:
            return None, "Reduce the age outer join metadata to the bounded size limit."
        with open(metadata, newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            if subject_column not in (reader.fieldnames or []):
                return None, (f"Add {subject_column!r} to the age outer join metadata.")
            if len(reader.fieldnames or []) > _MAX_AGE_METADATA_COLUMNS:
                return None, "Reduce the age outer join metadata column count."
            rows = []
            for index, row in enumerate(reader):
                if index >= _MAX_AGE_METADATA_ROWS:
                    return None, "Reduce the age outer join metadata row count."
                rows.append(str(row.get(subject_column, "")).strip())
    except (OSError, csv.Error):
        return None, "Provide readable age outer join metadata."
    clean = [value for value in rows if value]
    metadata_ids = set(clean)
    analysis = set(cohort.analysis_subject_ids)
    extras = sorted(metadata_ids - analysis)
    missing = analysis - metadata_ids
    evidence = {
        "join": "outer",
        "policy": "metadata-only-subjects-blocked-v1",
        "subjectIdColumn": subject_column,
        "analysisCount": len(analysis),
        "metadataRowCount": len(clean),
        "metadataUniqueIdCount": len(metadata_ids),
        "matchedAnalysisCount": len(analysis & metadata_ids),
        "missingAnalysisCount": len(missing),
        "metadataOnlyCount": len(extras),
        "duplicateMetadataIds": len(clean) - len(metadata_ids),
    }
    if extras:
        return evidence, (
            f"Remove {len(extras)} metadata-only subject(s) from the age outer "
            f"join for the {len(cohort.analysis_subject_ids)}-subject analysis "
            "cohort."
        )
    return evidence, None


def _scientific_blocker(
    cfg: dict[str, Any],
    key: str,
    cohort: CohortSnapshot,
    *,
    age_outer_blocker: str | None = None,
) -> str | None:
    if key == "age":
        return age_outer_blocker
    if key == "pybrainage":
        params = cfg.get("steps", {}).get("features", {}).get("params", {})
        if (
            str(params.get("parcellation", "aparc.a2009s")) != "aparc.a2009s"
            or str(params.get("measure", "thickness")) != "thickness"
            or not bool(params.get("validateFeatureOrder", True))
        ):
            return (
                "Use the validated 187-feature aparc.a2009s thickness contract "
                "for PyBrainAge."
            )
    if key == "braincharts":
        params = cfg.get("steps", {}).get("features", {}).get("params", {})
        if (
            not _enabled(cfg, "features")
            or str(params.get("parcellation", "aparc.a2009s")) != "aparc.a2009s"
            or str(params.get("measure", "thickness")) != "thickness"
        ):
            return (
                "Enable FreeSurfer feature extraction with aparc.a2009s thickness; "
                "BrainCharts reads its 187 regions."
            )
    if key == "aggregate":
        params = cfg.get("steps", {}).get("aggregate", {}).get("params", {})
        subject_glob = str(params.get("subjectGlob") or "sub-*")
        unsafe = (
            not subject_glob
            or os.path.isabs(subject_glob)
            or any(token in subject_glob for token in ("/", "\\", "\x00", ".."))
        )
        matched = (
            []
            if unsafe
            else [
                subject_id
                for subject_id in cohort.analysis_subject_ids
                if fnmatch.fnmatchcase(subject_id, subject_glob)
            ]
        )
        if unsafe or len(matched) != len(cohort.analysis_subject_ids):
            return (
                "Set aggregate subjectGlob to match all "
                f"{len(cohort.analysis_subject_ids)} analysis subjects in the "
                f"exact run-scoped view; it currently matches {len(matched)}."
            )
    return None


def resolve_input_fov_subjects(
    input_fov_reviews: Any,
    review_request: dict[str, Any],
    signature_cfg: dict[str, Any],
    t1_by_subject: dict[str, str],
) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    """Resolve each subject's trusted brain-FOV input or name its blocker.

    One unreviewed subject must not block another whose crop is approved, so
    every subject gets its own binding or blocker. The review manager lists
    and hashes the publications once for the whole mapping; resolving one
    subject per call re-hashed every publication for every subject.
    """
    expected: dict[str, str] = {}
    blockers: dict[str, str] = {}
    brainfov_adapter = ADAPTERS.get("brainfov")
    if brainfov_adapter is None:
        missing = "Register the Brain FOV adapter before resolving reviewed crops."
        return {}, dict.fromkeys(sorted(t1_by_subject), missing)
    for subject_id in sorted(t1_by_subject):
        try:
            expected[subject_id] = brainfov_adapter.preflight_signature(  # type: ignore[attr-defined]
                signature_cfg,
                subject_id,
            )
        except (KeyError, OSError, RuntimeError, ValueError) as exc:  # noqa: PERF203 - Each subject keeps its own blocker.
            blockers[subject_id] = str(exc)
    pending = {
        subject_id: path
        for subject_id, path in t1_by_subject.items()
        if subject_id in expected
    }
    if not pending:
        return {}, blockers
    try:
        resolved, unresolved = input_fov_reviews.resolve_each_for_cohort(
            review_request,
            pending,
            expected_preflight_by_subject=expected,
        )
    except (KeyError, OSError, RuntimeError, ValueError) as exc:
        return {}, {**blockers, **{subject_id: str(exc) for subject_id in pending}}
    return resolved, {**blockers, **unresolved}


def build_plan(  # noqa: PLR0912, PLR0915
    request: dict[str, Any],
    *,
    run_id: str | None = None,
    env_report: dict[str, Any] | None = None,
    input_fov_reviews: Any | None = None,
) -> PlannedWorkflow:
    """Expand one request into the canonical scoped DAG without side effects."""
    validate_config_revision(request.get("configRevision", 0))
    if input_fov_reviews is None:
        input_fov_reviews = request.get("_inputFovReviewManager")
    cfg = request.get("cfg") if isinstance(request.get("cfg"), dict) else {}
    project = request.get("project") if isinstance(request.get("project"), dict) else {}
    intent = request.get("intent") if isinstance(request.get("intent"), dict) else {}
    acknowledgements = validate_workflow_acknowledgements(
        request.get("acknowledgements")
    )
    plan_id = run_id or f"run-{uuid.uuid4().hex[:12]}"
    recovery_subjects = request.get("_recoveryAnalysisSubjectIds")
    if recovery_subjects is not None and (
        not isinstance(recovery_subjects, list)
        or any(not isinstance(subject_id, str) for subject_id in recovery_subjects)
    ):
        raise CohortError(
            "Provide the recovery analysis cohort as an array of strings."
        )
    kind = str(intent.get("kind", "workflow"))
    step_key = str(intent.get("stepKey", "")) if kind == "stage" else None
    if kind not in {"workflow", "stage"} or (
        kind == "stage" and step_key not in STEP_BY_KEY
    ):
        return _blocked_result(
            plan_id, "Select a valid workflow intent.", step_key or "recon"
        )
    try:
        mode, selected = _target(intent)
        if (
            kind == "stage"
            and step_key is not None
            and STEP_SCOPES[step_key] == "cohort"
        ):
            # Give cohort adapters one immutable full-analysis input. Prevent a
            # route-local subject selection from narrowing or invalidating it.
            mode, selected = "all", None
        cohort = build_cohort_snapshot(
            cfg,
            target_mode=mode,
            subject_ids=selected,
            acknowledge_qc_pending=acknowledgements["includeDeferredAndUnreviewedQc"],
            restrict_analysis_subject_ids=recovery_subjects,
        )
    except CohortError as exc:
        return _blocked_result(plan_id, str(exc), step_key or "recon")

    if not cohort.analysis_subject_ids:
        return _blocked_result(
            plan_id,
            "Add subjects to the analysis cohort.",
            step_key or "recon",
        )
    resource_resolution = resolve_runtime_resources(
        cfg,
        request.get("runtimeContext"),
    )
    prepared_bindings: dict[str, dict[str, Any]] | None = None
    # Gate each subject on its own crop review. One unreviewed subject must
    # not block Reconstruction for a subject whose crop is already approved.
    input_fov_blockers: dict[str, str] = {}
    if _enabled(cfg, "brainfov") and input_fov_reviews is not None:
        prepared_bindings = {}
        review_request = {
            "project": project,
            "cfg": cfg,
            "configRevision": validate_config_revision(
                request.get("configRevision", 0)
            ),
        }
        signature_cfg = runtime_cfg(
            cfg,
            cohort,
            plan_id,
            str(project.get("root", "")),
            inputs=RuntimeCfgInputs(resource_runtime=resource_resolution.runtime),
        )
        prepared_bindings, input_fov_blockers = resolve_input_fov_subjects(
            input_fov_reviews,
            review_request,
            signature_cfg,
            dict(cohort.t1_by_subject),
        )

    if kind == "workflow" and mode == "explicit" and not cohort.selected_subject_ids:
        summary = _summary([], "Keep the explicit empty workflow target as a no-op.")
        plan = {
            "planId": plan_id,
            "analysisCohort": {
                "subjectIds": list(cohort.analysis_subject_ids),
                "sha256": cohort.analysis_digest,
            },
            "selectedSubset": {"subjectIds": [], "sha256": cohort.selected_digest},
            "nodes": [],
            "blockers": [],
            "summary": summary,
        }
        return PlannedWorkflow(
            result={
                "runId": None,
                "disposition": "noop",
                "plan": plan,
                "summary": summary,
            },
            cohort=cohort,
            effective_cfg=runtime_cfg(
                cfg,
                cohort,
                plan_id,
                str(project.get("root", "")),
                inputs=RuntimeCfgInputs(
                    prepared_bindings=prepared_bindings,
                    resource_runtime=resource_resolution.runtime,
                ),
            ),
            warnings=resource_resolution.advisories,
        )

    if kind == "stage":
        descriptors = [STEP_BY_KEY[step_key]]  # type: ignore[index]
    else:
        descriptors = STEP_DESCRIPTORS

    registry: dict[str, dict[str, Any]] = {}
    brainpad_planned = any(
        descriptor["key"] == "brainpad" and _enabled(cfg, "brainpad")
        for descriptor in descriptors
    )
    if brainpad_planned or any(
        descriptor["key"] in _REGISTRY_STEPS and _enabled(cfg, descriptor["key"])
        for descriptor in descriptors
    ):
        registry = {
            row["subjectId"]: row
            for row in RegistryStore(str(project.get("root", ""))).list(cfg)
        }

    effective = runtime_cfg(
        cfg,
        cohort,
        plan_id,
        str(project.get("root", "")),
        inputs=RuntimeCfgInputs(
            prepared_bindings=prepared_bindings,
            resource_runtime=resource_resolution.runtime,
        ),
    )
    age_evidence, age_blocker = _age_outer_reconciliation(cfg, cohort)
    scientific_evidence = (
        {"ageOuterJoin": age_evidence} if age_evidence is not None else {}
    )
    if resource_resolution.evidence:
        scientific_evidence["managedResources"] = copy.deepcopy(
            resource_resolution.evidence
        )
    prepared_evidence = effective["_supraspinaRuntime"].get("inputFovEvidence", {})
    if prepared_evidence:
        scientific_evidence["inputFov"] = copy.deepcopy(prepared_evidence)
    nodes: list[dict[str, Any]] = []
    blockers: list[dict[str, Any]] = []
    by_step: dict[str, list[str]] = {}
    runtime = cfg.get("runtime", {}) if isinstance(cfg.get("runtime"), dict) else {}
    available_memory = (env_report or {}).get("availableMemoryGB")
    threshold = float(runtime.get("memoryWarningGB", 10))
    low_memory = (
        isinstance(available_memory, (int, float))
        and float(available_memory) < threshold
    )
    memory_acknowledged = acknowledgements["acknowledgeMemoryAdvisory"]

    for descriptor in descriptors:
        key = descriptor["key"]
        scope = descriptor["scope"]
        subjects: list[str | None]
        if scope == "subject":
            subjects = list(cohort.selected_subject_ids)
        else:
            subjects = [None]
        if kind == "stage" and scope == "cohort":
            subjects = [None]
        if not subjects:
            continue
        enabled = _enabled(cfg, key)
        for subject_id in subjects:
            index = len(nodes)
            node_id = _node_id(index, key, subject_id)
            dependencies: list[str] = []
            if kind == "workflow":
                if key == "deface" and enabled and _enabled(cfg, "brainfov"):
                    dependencies = [
                        node["nodeId"]
                        for node in nodes
                        if node["stepKey"] == "brainfov"
                        and node["subjectId"] == subject_id
                    ]
                elif key == "recon" and _enabled(cfg, "deface"):
                    dependencies = [
                        node["nodeId"]
                        for node in nodes
                        if node["stepKey"] == "deface"
                        and node["subjectId"] == subject_id
                    ]
                elif key == "recon" and _enabled(cfg, "brainfov"):
                    dependencies = [
                        node["nodeId"]
                        for node in nodes
                        if node["stepKey"] == "brainfov"
                        and node["subjectId"] == subject_id
                    ]
                else:
                    for dependency_key in descriptor["dependencies"]:
                        dependencies.extend(by_step.get(dependency_key, []))
            status = "planned" if not dependencies else "waiting"
            reason: str | None = None
            command: str | None = None
            if not enabled:
                status = "skipped"
                reason = f"{descriptor['name']} is off in project configuration."
            else:
                role_blocker = (
                    _cohort_role_blocker(
                        descriptor["name"], cohort.analysis_subject_ids, registry
                    )
                    if key in _ROLE_STEPS
                    else None
                )
                if role_blocker:
                    status = "blocked"
                    reason = role_blocker.reason
                    blockers.append(_cohort_blocker_entry(key, role_blocker))
                elif key == "final":
                    group_blocker = _final_group_size_blocker(
                        cohort.analysis_subject_ids, registry
                    )
                    if group_blocker:
                        status = "blocked"
                        reason = group_blocker.reason
                        blockers.append(_cohort_blocker_entry(key, group_blocker))
                site_blocker = (
                    _mixed_site_blocker(cohort.analysis_subject_ids, registry)
                    if key in _SITE_STEPS and status != "blocked"
                    else None
                )
                if site_blocker:
                    status = "blocked"
                    reason = site_blocker.reason
                    blockers.append(_cohort_blocker_entry(key, site_blocker))
                adaptation_blocker = (
                    _braincharts_site_blocker(cohort.analysis_subject_ids, registry)
                    if key == "braincharts" and status != "blocked"
                    else None
                )
                if adaptation_blocker:
                    status = "blocked"
                    reason = adaptation_blocker.reason
                    blockers.append(_cohort_blocker_entry(key, adaptation_blocker))
                if key == "zstats" and status != "blocked":
                    zscore_blocker = _zscore_blockers(
                        cfg, cohort.analysis_subject_ids, registry, nodes
                    )
                    if isinstance(zscore_blocker, _CohortBlocker):
                        status = "blocked"
                        reason = zscore_blocker.reason
                        blockers.append(_cohort_blocker_entry(key, zscore_blocker))
                    elif zscore_blocker is not None:
                        status = "blocked"
                        reason = zscore_blocker
                        blockers.append(
                            {"key": key, "reason": reason, "kind": "config"}
                        )
                resource_reason = resource_resolution.blockers.get(key)
                if resource_reason and status != "blocked":
                    status = "blocked"
                    reason = resource_reason
                    blockers.append(
                        {"key": key, "reason": reason, "kind": "environment"}
                    )
                input_fov_blocker = (
                    input_fov_blockers.get(subject_id)
                    if key in {"deface", "recon"} and subject_id is not None
                    else None
                )
                if input_fov_blocker and status != "blocked":
                    status = "blocked"
                    reason = input_fov_blocker
                    blockers.append({"key": key, "reason": reason, "kind": "input-qc"})
                if (
                    low_memory
                    and not bool(runtime.get("dryRun", False))
                    and not memory_acknowledged
                    and status != "blocked"
                ):
                    status = "blocked"
                    reason = (
                        "Acknowledge the memory advisory after reviewing "
                        f"{float(available_memory):.2f} GB available against the "
                        f"{threshold:.2f} GB threshold."
                    )
                    blockers.append({"key": key, "reason": reason, "kind": "safety"})
                scientific = _scientific_blocker(
                    cfg, key, cohort, age_outer_blocker=age_blocker
                )
                if scientific and status != "blocked":
                    status = "blocked"
                    reason = scientific
                    blockers.append({"key": key, "reason": reason, "kind": "config"})
                adapter = ADAPTERS.get(key)
                if adapter is None and status != "blocked":
                    status = "blocked"
                    reason = f"Register an adapter for {key}."
                    blockers.append({"key": key, "reason": reason, "kind": "config"})
                elif status not in {"blocked", "skipped"}:
                    # Validate against the run-time overlay so every adapter
                    # reads the same resolved backend and device the plan
                    # executes with.
                    validation = adapter.validate(effective, env_report or {})
                    if validation.blocking:
                        status = "blocked"
                        reason = "; ".join(validation.blocking)
                        blockers.append(
                            {"key": key, "reason": reason, "kind": "environment"}
                        )
                    else:
                        try:
                            argv = adapter.build_command(effective, subject_id)
                            guard_resolved(key, argv)
                            command = adapter.preview(effective, subject_id)
                        except Exception as exc:
                            status = "blocked"
                            reason = (
                                f"Repair command resolution for {key}: "
                                f"{type(exc).__name__}."
                            )
                            blockers.append(
                                {"key": key, "reason": reason, "kind": "config"}
                            )
            node = {
                "nodeId": node_id,
                "stepKey": key,
                "scope": scope,
                "subjectId": subject_id,
                "status": status,
                "dependencies": dependencies,
            }
            if reason:
                node["reason"] = reason
            if command and status not in {"blocked", "withheld"}:
                node["command"] = command
            nodes.append(node)
            by_step.setdefault(key, []).append(node_id)

    _propagate_blocked_dependencies(nodes, blockers)
    blockers = _collapse_blockers(nodes, blockers)

    site_advisory = (
        _brainpad_site_advisory(cohort.analysis_subject_ids, registry)
        if brainpad_planned
        else None
    )
    braincharts_advisory = (
        _braincharts_site_advisory(cohort.analysis_subject_ids, registry)
        if any(
            node["stepKey"] == "braincharts"
            and node["status"] in {"planned", "waiting"}
            for node in nodes
        )
        else None
    )
    metadata_site_advisory = (
        _metadata_site_advisory(cfg, cohort.analysis_subject_ids, registry)
        if registry
        and any(
            node["stepKey"] == "final" and node["status"] in {"planned", "waiting"}
            for node in nodes
        )
        else None
    )
    # The scientific and resource facts plan review shows beside the blockers.
    advisories = (
        *resource_resolution.advisories,
        *((site_advisory,) if site_advisory else ()),
        *((braincharts_advisory,) if braincharts_advisory else ()),
        *((metadata_site_advisory,) if metadata_site_advisory else ()),
    )
    warnings = (
        (
            "runtime.memoryWarningGB is an advisory threshold; it never changes "
            "scientific execution."
        ),
        *advisories,
    )
    summary = _summary(nodes)
    plan = {
        "planId": plan_id,
        "analysisCohort": {
            "subjectIds": list(cohort.analysis_subject_ids),
            "sha256": cohort.analysis_digest,
        },
        "selectedSubset": {
            "subjectIds": list(cohort.selected_subject_ids),
            "sha256": cohort.selected_digest,
        },
        "nodes": nodes,
        "blockers": blockers,
        "advisories": list(advisories),
        "scientificEvidence": scientific_evidence,
        "summary": summary,
    }
    runnable = any(node["status"] in {"planned", "waiting"} for node in nodes)
    disposition = "planned" if runnable else ("noop" if not nodes else "blocked")
    return PlannedWorkflow(
        result={
            "runId": run_id,
            "disposition": disposition,
            "plan": plan,
            "summary": summary,
        },
        cohort=cohort,
        effective_cfg=effective,
        warnings=warnings,
    )
