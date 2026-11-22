"""Bounded detector-backed result inventory with receipt currentness."""

from __future__ import annotations

import copy
import json
import os
import stat
import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import scientific_assets, unit_reuse
from .adapters import aggregate, braincharts, brainpad, enigma, final, recon, zstats
from .adapters.base import ADAPTERS, Adapter
from .adapters.fastsurfer import (
    AUTO_BACKEND,
    FASTSURFER_BACKEND,
    FREESURFER_BACKEND,
    reconstruction_backend_from_receipt,
)
from .bounded_io import read_bounded_regular
from .cohort import (
    CohortError,
    CohortSnapshot,
    T1Resolution,
    config_excluded_subject_ids,
    config_subject_scope,
    discover_t1_resolutions,
    load_project_qc_records,
    remembered_fingerprint,
    resolve_analysis_cohort,
)
from .membership import enrich_evidence
from .project import ProjectEpochs
from .provenance import (
    active_resource_root_spellings,
    bind_projection_inputs,
    bound_tool_evidence,
    detector_evidence,
    environment_check_evidence,
    evidence_identity,
    evidence_is_done,
    expected_signature,
    receipt_signature_valid,
    stable_digest,
)
from .qc_store import QcStoreError
from .registry import STEP_BY_KEY, STEP_DESCRIPTORS, STEP_SCOPES
from .run_store import (
    EXECUTION_FALLBACK_KEY,
    RECEIPT_VERSION,
    UNIT_REUSE_KEY,
    RunStore,
    execution_fallback_valid,
    unit_reuse_valid,
)
from .runtime_resources import resolve_runtime_resources
from .workflow import RuntimeCfgInputs, resolve_input_fov_subjects, runtime_cfg

_MAX_SUBJECTS = 5_000
_MAX_ROWS = 20_000
_MAX_DETECTOR_ARTIFACTS = 256
_MAX_ISSUED = 8_192
_MAX_ATTEMPT_ORDINAL = 1_000_000
_MAX_QUERY_CHARACTERS = 256
_MAX_SIGNING_NOTES = 20
#: Keep the prepared bindings of this many recent runs.
_MAX_SIGNING_CACHE = 4
_MAX_SUBJECT_ID_CHARACTERS = 128
_SHA256_LENGTH = 64
_SHA256_CHARACTERS = frozenset("0123456789abcdef")
_ATTEMPTED = {
    "running",
    "cancelling",
    "done",
    "failed",
    "cancelled",
    "interrupted",
}


@dataclass(frozen=True)
class _ExpectedArtifact:
    label: str
    path: str
    kind: str


@dataclass(frozen=True)
class _IssuedResultMetadata:
    """Represent trusted immutable attribution for an issued result ID."""

    artifact_id: str
    label: str
    step_key: str
    subject_id: str | None
    kind: str
    presence: str
    display_path: str
    run_id: str | None
    producer_node_id: str | None
    receipt_sha256: str | None
    provenance: str
    inventory_run_id: str | None
    config_sha256: str

    def to_dict(self) -> dict[str, Any]:
        """Serialize the trusted metadata for the main process."""
        return {
            "artifactId": self.artifact_id,
            "label": self.label,
            "stepKey": self.step_key,
            "subjectId": self.subject_id,
            "kind": self.kind,
            "presence": self.presence,
            "displayPath": self.display_path,
            "runId": self.run_id,
            "producerNodeId": self.producer_node_id,
            "receiptSha256": self.receipt_sha256,
            "provenance": self.provenance,
            "inventoryRunId": self.inventory_run_id,
            "configSha256": self.config_sha256,
        }


@dataclass(frozen=True)
class _ReconstructionSelection:
    backend: str | None
    device: str | None


def _bounded_text(value: Any, *, limit: int = 512) -> str | None:
    """Return one bounded non-empty string from persisted provenance."""
    if not isinstance(value, str) or not value:
        return None
    return value[:limit]


def _identity(value: Any) -> str | None:
    """Return a bounded identity string without exposing nested raw values."""
    if value is None:
        return None
    if isinstance(value, str):
        return _bounded_text(value)
    try:
        return stable_digest(value)
    except (TypeError, ValueError):
        return None


def _valid_sha256(value: Any) -> bool:
    """Return whether a value is one canonical lowercase SHA-256 digest."""
    return (
        isinstance(value, str)
        and len(value) == _SHA256_LENGTH
        and set(value) <= _SHA256_CHARACTERS
    )


def _receipt_provenance(
    receipt: dict[str, Any] | None,
    state: dict[str, Any],
) -> dict[str, Any]:
    """Return bounded receipt and exact-plan identities for renderer audit."""
    receipt_details: dict[str, Any] | None = None
    if receipt is not None:
        claimed_signature = _bounded_text(receipt.get("signature")) or ""
        try:
            signature_valid = bool(claimed_signature) and receipt_signature_valid(
                receipt, claimed_signature
            )
        except (TypeError, ValueError):
            signature_valid = False
        adapter_implementation = receipt.get("adapterImplementation")
        implementation_sha = (
            adapter_implementation.get("sha256")
            if isinstance(adapter_implementation, dict)
            else None
        )
        upstream = receipt.get("upstreamSignatures")
        receipt_version = receipt.get("receiptVersion")
        fallback = receipt.get(EXECUTION_FALLBACK_KEY)
        committed_at = receipt.get("committedAtMs")
        receipt_details = {
            "receiptVersion": (
                receipt_version
                if isinstance(receipt_version, int)
                and not isinstance(receipt_version, bool)
                else None
            ),
            "signature": claimed_signature,
            "signatureValid": signature_valid,
            "committedAtMs": (
                committed_at
                if isinstance(committed_at, int)
                and not isinstance(committed_at, bool)
                and committed_at >= 0
                else None
            ),
            "jobId": _bounded_text(receipt.get("jobId")),
            "analysisCohortDigest": _bounded_text(receipt.get("analysisCohortDigest")),
            "selectedSubsetDigest": _bounded_text(receipt.get("selectedSubsetDigest")),
            "inputT1Fingerprint": _identity(receipt.get("inputT1Fingerprint")),
            "stepParamsDigest": _bounded_text(receipt.get("stepParamsDigest")),
            "adapterIdentity": _bounded_text(receipt.get("adapterIdentity")),
            "adapterImplementationSha256": _bounded_text(implementation_sha),
            "toolEvidenceDigest": _bounded_text(receipt.get("toolEvidenceDigest")),
            "externalInputsDigest": _identity(receipt.get("externalInputs")),
            "outputSchemaIdentity": _bounded_text(receipt.get("outputSchemaIdentity")),
            "upstreamSignatures": [
                value[:512] for value in upstream if isinstance(value, str) and value
            ][:512]
            if isinstance(upstream, list)
            else [],
            "baselineDigest": _identity(receipt.get("baseline")),
            # The flags a Reconstruction reran with, so the inventory lists
            # the subjects a methods section names; the record is unchanged.
            "executionFallback": (
                copy.deepcopy(fallback) if execution_fallback_valid(fallback) else None
            ),
        }
        unit_record = receipt.get(UNIT_REUSE_KEY)
        if unit_reuse_valid(unit_record):
            # Which subjects a cohort stage computed and which kept verified
            # earlier output; only a receipt with units carries the key.
            receipt_details["unitReuse"] = unit_reuse.record_summary(unit_record)

    plan_binding = state.get("planBinding")
    run_binding: dict[str, str | None] | None = None
    if isinstance(plan_binding, dict):
        run_binding = {
            "planDigest": _bounded_text(plan_binding.get("digest")),
            "configDigest": _bounded_text(plan_binding.get("configDigest")),
            "qcDigest": _bounded_text(plan_binding.get("qcDigest")),
            "registryDigest": _bounded_text(plan_binding.get("registryDigest")),
            "environmentDigest": _bounded_text(plan_binding.get("environmentDigest")),
        }
        if not any(run_binding.values()):
            run_binding = None
    return {"receipt": receipt_details, "runBinding": run_binding}


def _fallback_terms(row: dict[str, Any]) -> str:
    # The flags a Reconstruction reran with, so a search for one lists them.
    details = row.get("provenanceDetails")
    receipt = details.get("receipt") if isinstance(details, dict) else None
    fallback = (
        receipt.get(EXECUTION_FALLBACK_KEY) if isinstance(receipt, dict) else None
    )
    if not isinstance(fallback, dict):
        return ""
    return " ".join(str(flag) for flag in fallback.get("addedArguments", []))


def _matches_query(row: dict[str, Any], query: str) -> bool:
    """Match case-insensitive AND terms across bounded artifact attribution."""
    if not query:
        return True
    step_key = str(row.get("stepKey") or "")
    descriptor = STEP_BY_KEY.get(step_key)
    step_name = str(descriptor.get("name") or "") if descriptor else ""
    haystack = " ".join(
        str(row.get(field) or "")
        for field in (
            "label",
            "displayPath",
            "subjectId",
            "stepKey",
            "kind",
            "presence",
            "runId",
            "producerNodeId",
        )
    )
    searchable = f"{step_name} {haystack} {_fallback_terms(row)}".casefold()
    return all(term in searchable for term in query.casefold().split())


def _reconstruction_params(cfg: dict[str, Any]) -> dict[str, Any]:
    steps = cfg.get("steps", {}) if isinstance(cfg.get("steps"), dict) else {}
    step = steps.get("recon", {}) if isinstance(steps.get("recon"), dict) else {}
    params = step.get("params", {}) if isinstance(step.get("params"), dict) else {}
    return params if isinstance(params, dict) else {}


def _valid_reconstruction_receipts(
    receipts: list[dict[str, Any]],
) -> list[tuple[dict[str, Any], str]]:
    valid: list[tuple[dict[str, Any], str]] = []
    for receipt in receipts:
        signature = receipt.get("signature")
        if not isinstance(signature, str):
            continue
        try:
            signature_valid = receipt_signature_valid(receipt, signature)
        except (TypeError, ValueError):
            signature_valid = False
        if not signature_valid:
            continue
        backend = reconstruction_backend_from_receipt(receipt)
        if backend in {FREESURFER_BACKEND, FASTSURFER_BACKEND}:
            valid.append((receipt, backend))
    return valid


def _job_reconstruction_backend(
    state: dict[str, Any], analysis_subject_ids: set[str]
) -> tuple[str | None, bool]:
    attempts: list[tuple[int, str]] = []
    for job in state.get("jobs", []):
        if (
            not isinstance(job, dict)
            or job.get("stepKey") != "recon"
            or job.get("subjectId") not in analysis_subject_ids
            or job.get("backend") not in {FREESURFER_BACKEND, FASTSURFER_BACKEND}
        ):
            continue
        ordinal = job.get("attemptOrdinal", 1)
        if (
            isinstance(ordinal, bool)
            or not isinstance(ordinal, int)
            or not 1 <= ordinal <= _MAX_ATTEMPT_ORDINAL
        ):
            continue
        attempts.append((ordinal, str(job["backend"])))
    if not attempts:
        return None, False
    latest_ordinal = max(ordinal for ordinal, _backend in attempts)
    latest_backends = {
        backend for ordinal, backend in attempts if ordinal == latest_ordinal
    }
    if len(latest_backends) != 1:
        return None, True
    return next(iter(latest_backends)), True


def _fastsurfer_device(
    cfg: dict[str, Any],
    state: dict[str, Any],
    valid_receipts: list[tuple[dict[str, Any], str]],
) -> str | None:
    requested = _reconstruction_params(cfg).get("fastsurferDevice", "auto")
    if requested in {"cpu", "cuda"}:
        return str(requested)
    for receipt, backend in reversed(valid_receipts):
        reconstruction = receipt.get("reconstruction")
        if backend == FASTSURFER_BACKEND and isinstance(reconstruction, dict):
            device = reconstruction.get("device")
            if device in {"cpu", "cuda"}:
                return str(device)
    scientific = state.get("scientificEvidence", {})
    managed = (
        scientific.get("managedResources", {}) if isinstance(scientific, dict) else {}
    )
    fastsurfer = managed.get("fastsurfer") if isinstance(managed, dict) else None
    variant = fastsurfer.get("variant") if isinstance(fastsurfer, dict) else None
    return str(variant) if variant in {"cpu", "cuda"} else None


def _reconstruction_selection(
    cfg: dict[str, Any],
    state: dict[str, Any],
    analysis_subject_ids: set[str],
    receipts: list[dict[str, Any]],
) -> _ReconstructionSelection:
    params = _reconstruction_params(cfg)
    requested = params.get("backend", FREESURFER_BACKEND)
    valid_receipts = _valid_reconstruction_receipts(receipts)
    if requested in {FREESURFER_BACKEND, FASTSURFER_BACKEND}:
        backend = str(requested)
    elif requested == AUTO_BACKEND:
        backend, has_concrete_jobs = _job_reconstruction_backend(
            state, analysis_subject_ids
        )
        if has_concrete_jobs and backend is None:
            return _ReconstructionSelection(None, None)
        if backend is None and valid_receipts:
            backend = valid_receipts[-1][1]
    else:
        backend = None
    device = (
        _fastsurfer_device(cfg, state, valid_receipts)
        if backend == FASTSURFER_BACKEND
        else None
    )
    return _ReconstructionSelection(backend, device)


def _kind(path: str) -> str:
    if os.path.isdir(path):
        return "dir"
    suffix = Path(path).suffix.lower().lstrip(".")
    if path.lower().endswith(".nii.gz"):
        return "nii"
    return (
        suffix
        if suffix in {"csv", "png", "html", "xlsx", "pdf", "txt", "nii"}
        else "txt"
    )


def _presence(detector_state: str, exists: bool, attempted: bool) -> str:
    """Classify one declared output from its detector state and the disk."""
    if detector_state == "unknown":
        return "unknown"
    if exists:
        return "produced" if detector_state == "done" else "partial"
    if attempted or detector_state == "partial":
        return "absent"
    return "expected"


def _attempted(state: dict[str, Any], step_key: str, subject_id: str | None) -> bool:
    """Say whether a non-dry run attempted one node."""
    return not bool(state.get("dryRun")) and any(
        node.get("status") in _ATTEMPTED
        for node in state.get("nodes", [])
        if node.get("stepKey") == step_key and node.get("subjectId") == subject_id
    )


def _enigma_gallery_presence(
    state: dict[str, Any],
    config: dict[str, Any],
    run_id: str,
    project_root: str,
) -> list[dict[str, Any]]:
    """Return the presence of a run's ENIGMA rows as its full inventory reports it.

    QC review needs only this to rule out a run recorded under another
    configuration, which cannot be authoritative but can still name the newest
    gallery set. Apply the full inventory's detector and presence rule
    to the same declared outputs without receipts, signatures or provenance.
    Build the run's view without the private signing inputs: the managed
    resource runtime and the reviewed Brain FOV crops bind subject inputs that
    ENIGMA's detector and declared outputs never read, and rebuilding the
    crops hashes every crop publication of the cohort.
    """
    cohort = _cohort(state.get("scope", {}))
    analysis = set(list(cohort.analysis_subject_ids)[:_MAX_SUBJECTS])
    receipts = [
        receipt for receipt in state.get("receipts", []) if isinstance(receipt, dict)
    ]
    effective = _with_reconstruction(
        runtime_cfg(config, cohort, run_id, project_root),
        _reconstruction_selection(config, state, analysis, receipts),
    )
    adapter = ADAPTERS["enigma"]
    detected = enrich_evidence(
        "enigma", detector_evidence(adapter, effective, None), effective, cohort
    )
    detector_state = str(detected.get("state", "unknown"))
    attempted = _attempted(state, "enigma", None)
    rows: list[dict[str, Any]] = []
    known: set[str] = set()

    def row(label: str, kind: str, presence: str, path: str) -> dict[str, Any]:
        return {
            "label": label,
            "stepKey": "enigma",
            "subjectId": None,
            "kind": kind,
            "presence": presence,
            "exists": os.path.exists(path),
        }

    for expected_item in _expected("enigma", adapter, effective, None):
        canonical = os.path.realpath(expected_item.path)
        known.add(canonical)
        presence = _presence(detector_state, os.path.exists(canonical), attempted)
        rows.append(row(expected_item.label, expected_item.kind, presence, canonical))
    for item in detected.get("artifacts", [])[:_MAX_DETECTOR_ARTIFACTS]:
        path = str(item.get("path", "")) if isinstance(item, dict) else ""
        if not path:
            continue
        canonical = os.path.realpath(path)
        if canonical in known or not os.path.exists(canonical):
            continue
        presence = "produced" if detector_state == "done" else "partial"
        label = os.path.basename(canonical) or "enigma"
        rows.append(row(label, _kind(canonical), presence, canonical))
    return rows


def _display(path: str, root: str) -> str:
    try:
        relative = os.path.relpath(path, root)
        if relative != ".." and not relative.startswith(".." + os.sep):
            return relative
    except ValueError:
        pass
    return os.path.basename(path)


def _cohort(scope: dict[str, Any]) -> CohortSnapshot:
    t1 = tuple(
        T1Resolution(
            subject_id=str(row.get("subject_id", row.get("subjectId", ""))),
            state=str(row.get("state", "resolved")),  # type: ignore[arg-type]
            path=row.get("path"),
            candidates=tuple(row.get("candidates", [])),
            fingerprint=row.get("fingerprint"),
            fingerprint_strategy=str(
                row.get(
                    "fingerprint_strategy",
                    row.get("fingerprintStrategy", "sha256-full-v1"),
                )
            ),
        )
        for row in scope.get("t1", [])
        if isinstance(row, dict)
    )
    return CohortSnapshot(
        analysis_subject_ids=tuple(scope.get("analysisSubjectIds", [])),
        selected_subject_ids=tuple(scope.get("selectedSubjectIds", [])),
        analysis_digest=str(scope.get("analysisDigest", "")),
        selected_digest=str(scope.get("selectedDigest", "")),
        t1=t1,
        qc_verdicts=tuple(sorted(dict(scope.get("qcVerdicts", {})).items())),
        qc_acknowledged=bool(scope.get("qcAcknowledged", False)),
        excluded_by_config=tuple(scope.get("excludedByConfig", [])),
        excluded_by_qc=tuple(scope.get("excludedByQc", [])),
    )


#: Say why the analysis cohort the next Run all would plan differs from the
#: inspected run's: the analysis subjects themselves changed.
_MEMBERSHIP_CHANGE = "membership"
#: Name what changed the membership, in the order the notices list them.
_SUBJECTS_ADDED = "subjects-added"
_SUBJECTS_REMOVED = "subjects-removed"
_CONFIG_EXCLUSION = "config-exclusion"
_T1_CHANGED = "t1-changed"
_QC_EXCLUSION = "qc-exclusion"
#: Name at most this many subjects per reason; ``count`` keeps the total.
_MAX_REASON_SUBJECTS = 20
#: Read at most this much of the saved project file, as the main process does.
_MAX_PROJECT_CONFIG_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class _LiveCohort:
    """Describe the analysis cohort the next Run all would plan.

    ``snapshot`` holds that cohort only when it binds another digest or other
    T1 inputs than the inspected run's cohort; ``unknown`` marks a cohort that
    cannot be built. ``reasons`` says what changed the membership, and
    ``rebound`` names the analysis subjects whose T1 row differs from the
    run's, so their own stages are judged against the new row.
    """

    snapshot: CohortSnapshot | None = None
    unknown: bool = False
    change: str | None = None
    reasons: tuple[dict[str, Any], ...] = ()
    rebound: frozenset[str] = frozenset()


def _saved_configuration(config_path: str) -> dict[str, Any] | None:
    """Return the project configuration saved on disk, or None if unreadable.

    Run all plans only the saved configuration, so its subject selection and
    discovery patterns decide the analysis cohort the next plan resolves.
    """
    if not config_path:
        return None
    try:
        saved = json.loads(read_bounded_regular(config_path, _MAX_PROJECT_CONFIG_BYTES))
    except (OSError, ValueError):
        return None
    return saved if isinstance(saved, dict) else None


def _reason(kind: str, subject_ids: set[str]) -> dict[str, Any]:
    """Name one membership change and a bounded, sorted list of its subjects."""
    ordered = sorted(subject_ids)
    return {
        "kind": kind,
        "subjectIds": ordered[:_MAX_REASON_SUBJECTS],
        "count": len(ordered),
    }


def _membership_reasons(  # noqa: PLR0913
    recorded: CohortSnapshot,
    live: CohortSnapshot,
    discovered: list[T1Resolution],
    rebound: frozenset[str],
    run_cfg: dict[str, Any],
    saved_cfg: dict[str, Any],
) -> tuple[dict[str, Any], ...]:
    """Say what changed the analysis membership since the run was planned.

    A subject that joined or left because the saved selection now includes or
    excludes it counts as a configuration change, not as an added or removed
    subject. A QC Fail row carries no recorded T1, so only subjects the run
    analyzed can report a changed T1 input.
    """
    run_scope = config_subject_scope(run_cfg)
    saved_scope = config_subject_scope(saved_cfg)

    def in_scope(scope: tuple[set[str], set[str]], subject_id: str) -> bool:
        include, exclude = scope
        return subject_id not in exclude and (not include or subject_id in include)

    before = set(recorded.analysis_subject_ids) | set(recorded.excluded_by_qc)
    after = {row.subject_id for row in discovered}
    added = after - before
    removed = before - after
    selection = {
        subject_id for subject_id in added if not in_scope(run_scope, subject_id)
    } | {subject_id for subject_id in removed if not in_scope(saved_scope, subject_id)}
    added -= selection
    removed -= selection
    recorded_rows = {row.subject_id for row in recorded.t1}
    qc = (set(recorded.excluded_by_qc) ^ set(live.excluded_by_qc)) & before & after
    reasons = []
    if added:
        reasons.append(_reason(_SUBJECTS_ADDED, added))
    if removed:
        reasons.append(_reason(_SUBJECTS_REMOVED, removed))
    if selection or recorded.excluded_by_config != live.excluded_by_config:
        reasons.append(_reason(_CONFIG_EXCLUSION, selection))
    if changed := set(rebound) & recorded_rows:
        reasons.append(_reason(_T1_CHANGED, changed))
    if qc:
        reasons.append(_reason(_QC_EXCLUSION, qc))
    return tuple(reasons)


def _live_analysis_cohort(  # noqa: PLR0911
    state: dict[str, Any],
    recorded: CohortSnapshot,
    project_root: str,
    config_path: str = "",
) -> _LiveCohort:
    """Resolve the analysis cohort the next Run all would plan.

    Rediscover the subjects and T1 inputs under the saved configuration (the
    run's own when none is readable) and apply its exclusions and the live QC
    records through the planner's own binding, acknowledged exactly when the
    cohort holds a Defer or unreviewed row, as Run all sends it. A T1 whose
    identity is unchanged since it was last hashed is not read again (see
    :func:`remembered_fingerprint`). The resolved cohort replaces the run's
    cohort only when its digest or T1 rows differ. A run with no recorded
    QC-store digest or analysis cohort has nothing to compare with and keeps
    its cohort. A
    cohort Run all could not plan (an unreadable store, an unresolved or
    ambiguous T1, or no analysis subject) reads unknown.
    """
    binding = state.get("planBinding")
    planned_qc = binding.get("qcDigest") if isinstance(binding, dict) else None
    if (
        not isinstance(planned_qc, str)
        or not planned_qc
        or not recorded.analysis_digest
    ):
        return _LiveCohort()
    try:
        records = load_project_qc_records(project_root)
    except (QcStoreError, OSError):
        return _LiveCohort(unknown=True)
    run_cfg = state.get("config") if isinstance(state.get("config"), dict) else {}
    saved_cfg = _saved_configuration(config_path) or run_cfg
    try:
        discovered = discover_t1_resolutions(
            saved_cfg, fingerprint=remembered_fingerprint
        )
    except (CohortError, OSError, ValueError):
        return _LiveCohort(unknown=True)
    if any(row.state != "resolved" for row in discovered):
        return _LiveCohort(unknown=True)
    analysis = resolve_analysis_cohort(
        discovered, records, config_excluded_subject_ids(saved_cfg)
    )
    if not analysis.subject_ids:
        return _LiveCohort(unknown=True)
    live = analysis.snapshot(acknowledged=bool(analysis.pending_qc_subject_ids))
    recorded_rows = {row.subject_id: (row.path, row.fingerprint) for row in recorded.t1}
    rebound = frozenset(
        row.subject_id
        for row in live.t1
        if recorded_rows.get(row.subject_id) != (row.path, row.fingerprint)
    )
    if not rebound and recorded.analysis_digest == live.analysis_digest:
        return _LiveCohort()
    return _LiveCohort(
        snapshot=live,
        change=_MEMBERSHIP_CHANGE,
        reasons=_membership_reasons(
            recorded, live, discovered, rebound, run_cfg, saved_cfg
        ),
        rebound=rebound,
    )


def _with_reconstruction(
    effective: dict[str, Any], reconstruction: _ReconstructionSelection
) -> dict[str, Any]:
    """Name the reconstruction backend and device the run resolved."""
    runtime = effective.get("_supraspinaRuntime", {})
    if isinstance(runtime, dict) and reconstruction.backend is not None:
        # Replace the whole subtree rather than mutating it in place, so
        # every write to the effective configuration goes through the
        # mapping itself and no holder of the previous subtree can observe
        # a half-applied selection.
        resolved_runtime = {
            **runtime,
            "resolvedReconBackend": reconstruction.backend,
        }
        if reconstruction.device is not None:
            resolved_runtime["resolvedFastSurferDevice"] = reconstruction.device
        effective["_supraspinaRuntime"] = resolved_runtime
    return effective


def _step_enabled(cfg: dict[str, Any], key: str) -> bool:
    """Say whether the configuration enables a step, as the planner reads it."""
    steps = cfg.get("steps", {}) if isinstance(cfg.get("steps"), dict) else {}
    value = steps.get(key, {}) if isinstance(steps.get(key), dict) else {}
    return bool(value.get("enabled", False))


def _logical_dependencies(cfg: dict[str, Any], step_key: str) -> list[str]:
    """Mirror configured scientific data dependencies used by execution."""
    if step_key == "deface" and _step_enabled(cfg, "brainfov"):
        return ["brainfov"]
    if step_key == "recon":
        if _step_enabled(cfg, "deface"):
            return ["deface"]
        if _step_enabled(cfg, "brainfov"):
            return ["brainfov"]
    return list(STEP_BY_KEY[step_key]["dependencies"])


def _expected(  # noqa: PLR0911, PLR0912
    step_key: str,
    adapter: Adapter,
    cfg: dict[str, Any],
    subject_id: str | None,
) -> list[_ExpectedArtifact]:
    """Expand the shared declared output model into concrete run paths."""
    if step_key == "deface":
        path = adapter.output_path(cfg, subject_id)  # type: ignore[attr-defined]
        return [_ExpectedArtifact("Defaced T1w", path, "nii")]
    if step_key == "recon" and subject_id:
        try:
            backend = recon.selected_backend(cfg)
            root = adapter._subject_dir(cfg, subject_id)  # type: ignore[attr-defined]
        except ValueError:
            return []
        marker = recon.reconstruction_artifact_groups(backend)[0][0]
        root_label = (
            "FreeSurfer subject dir"
            if backend == recon.FREESURFER_BACKEND
            else "FastSurfer subject dir"
        )
        marker_label = (
            "recon-all.done"
            if backend == recon.FREESURFER_BACKEND
            else "FastSurfer deep-seg.log"
        )
        return [
            _ExpectedArtifact(root_label, root, "dir"),
            _ExpectedArtifact(marker_label, os.path.join(root, marker), "txt"),
        ]
    if step_key == "enigma":
        root = adapter._out_dir(cfg)  # type: ignore[attr-defined]
        relpaths = (
            ("Subcortical measures", "measures/LandRvolumes.csv", "csv"),
            (
                "Cortical thickness measures",
                "measures/CorticalMeasuresENIGMA_ThickAvg.csv",
                "csv",
            ),
            (
                "Cortical surface-area measures",
                "measures/CorticalMeasuresENIGMA_SurfAvg.csv",
                "csv",
            ),
            (
                "Subcortical QC gallery",
                "qc/subcortical/ENIGMA_Subcortical_QC.html",
                "html",
            ),
            (
                "Cortical-internal QC gallery",
                "qc/cortical_internal/ENIGMA_Cortical_QC.html",
                "html",
            ),
            (
                "Cortical-external QC gallery",
                "qc/cortical_external/ENIGMA_External_QC.html",
                "html",
            ),
        )
        return [
            _ExpectedArtifact(label, os.path.join(root, relpath), kind)
            for label, relpath, kind in relpaths
        ]
    if step_key == "outliers":
        root = adapter._output_dir(cfg)  # type: ignore[attr-defined]
        return [
            _ExpectedArtifact("Outliers", os.path.join(root, "outliers.csv"), "csv"),
            _ExpectedArtifact("Histograms", os.path.join(root, "hist"), "dir"),
        ]
    if step_key == "features":
        root = adapter._out_dir(cfg)  # type: ignore[attr-defined]
        return [
            _ExpectedArtifact(
                "Concatenated features",
                os.path.join(root, "concatenated_results.csv"),
                "csv",
            )
        ]
    if step_key == "age":
        return [
            _ExpectedArtifact(
                "Features with age",
                adapter.resolve(adapter.output_template, cfg),  # type: ignore[attr-defined]
                "csv",
            )
        ]
    if step_key == "pybrainage":
        return [
            _ExpectedArtifact(
                "Predictions",
                adapter.resolve(adapter.output_template, cfg),  # type: ignore[attr-defined]
                "csv",
            )
        ]
    if step_key == "clinical":
        return [
            _ExpectedArtifact(
                "Analysis workbook",
                adapter.resolve(
                    "${paths.outputDir}/analysis/predicted_results.xlsx", cfg
                ),
                "xlsx",
            )
        ]
    if step_key == "brainpad":
        root = adapter._outdir(cfg)  # type: ignore[attr-defined]
        return [
            _ExpectedArtifact(label, os.path.join(root, basename), kind)
            for label, basename, kind in brainpad.OUTPUT_ARTIFACTS
        ]
    if step_key == "aggregate":
        root = adapter._out_dir(cfg)  # type: ignore[attr-defined]
        return [
            _ExpectedArtifact(
                Path(name).stem.replace("_", " "), os.path.join(root, name), "csv"
            )
            for name in aggregate._OUTPUT_CSVS
        ]
    if step_key == "final":
        root = adapter._out_dir(cfg)  # type: ignore[attr-defined]
        include_report = bool(adapter.params(cfg).get("renderReport", True))
        rows: list[_ExpectedArtifact] = []
        for contract in final.output_contracts(root, include_report=include_report):
            path = contract.inventory_path()
            rows.append(_ExpectedArtifact(contract.label, path, _kind(path)))
        return rows
    if step_key == "braincharts":
        root = adapter.out_dir(cfg)  # type: ignore[attr-defined]
        return [
            _ExpectedArtifact(label, os.path.join(root, name), kind)
            for name, label, kind in braincharts.OUTPUT_ARTIFACTS
        ]
    if step_key == "zstats":
        root = adapter.out_dir(cfg)  # type: ignore[attr-defined]
        include_report = bool(adapter.params(cfg).get("renderReport", True))
        return [
            _ExpectedArtifact(contract.label, path, _kind(path))
            for contract in zstats.output_contracts(root, include_report=include_report)
            for path in (contract.inventory_path(),)
        ]
    return []


def _inventory_environment(recorded: Any, cfg: dict[str, Any]) -> dict[str, Any]:
    """Judge the recorded resource checks live, the way the planner does.

    The planner judges the asset checks against the resources it resolves
    now, so a run's recorded asset evidence can differ from what the next
    plan binds. Re-run only the asset checks, which read files and launch
    nothing, and only for check ids the run recorded; keep the recorded
    evidence for tool and interpreter checks.
    """
    environment = dict(recorded) if isinstance(recorded, dict) else {}
    if not environment:
        return environment
    # Import lazily: the env package registers every probe on import and
    # imports the adapters package, which this module imports first.
    from .env.repo import BundledAssetsProbe  # noqa: PLC0415

    try:
        checks = BundledAssetsProbe().checks(cfg)
    except Exception:  # Keep the recorded evidence when the probe fails.
        return environment
    roots = active_resource_root_spellings()
    for check in checks:
        if check.id in environment:
            environment[check.id] = environment_check_evidence(check.to_dict(), roots)
    return environment


def _stage_currency_summary(
    states: dict[str, dict[str | None, str]],
    causes: dict[str, str] | None = None,
) -> dict[str, dict[str, Any]]:
    """Summarize node currency per stage for the Runs stage cards.

    ``causes`` names why an out-of-date cohort stage is out of date, when the
    inventory can tell.
    """
    summary: dict[str, dict[str, Any]] = {}
    for step_key, by_subject in states.items():
        if STEP_SCOPES[step_key] == "cohort":
            entry: dict[str, Any] = {
                "state": by_subject.get(None, "unknown"),
                "outdatedSubjectIds": [],
            }
            cause = (causes or {}).get(step_key)
            if cause is not None and entry["state"] == "outdated":
                entry["cause"] = cause
            summary[step_key] = entry
            continue
        outdated = sorted(
            str(subject_id)
            for subject_id, value in by_subject.items()
            if value == "outdated"
        )
        values = set(by_subject.values())
        summary[step_key] = {
            "state": (
                "outdated"
                if outdated
                else "current"
                if values == {"current"}
                else "unknown"
            ),
            "outdatedSubjectIds": outdated,
        }
    return summary


class ResultInventory:
    """List expected and detected artifacts, resolving only issued identities."""

    def __init__(
        self, projects: ProjectEpochs, input_fov_reviews: Any | None = None
    ) -> None:
        self.projects = projects
        self.input_fov_reviews = input_fov_reviews
        #: Why a subject's reviewed Brain FOV input could not be rebound while
        #: signing the latest page, keyed by subject id and bounded.
        self._last_signing_notes: dict[str, str] = {}
        #: Prepared bindings and notes per run, keyed by the inputs that shape
        #: them, so one Results sweep re-hashes the reviewed inputs once.
        self._signing_cache: dict[
            tuple[str, str, str, str, int], tuple[dict[str, Any], dict[str, str]]
        ] = {}
        self._lock = threading.Lock()
        #: Issued identities by project and ID, least recently used first.
        #: Only an ID held here resolves; past the bound the oldest is evicted.
        self._issued: OrderedDict[tuple[str, str], dict[str, Any]] = OrderedDict()
        #: The held ID of each listed artifact by its listing identity, so a
        #: listing that returns the same artifact again reuses its ID instead
        #: of evicting identities other screens still hold.
        self._issued_by_identity: dict[tuple[Any, ...], str] = {}

    def _hold(self, key: tuple[str, str], record: dict[str, Any]) -> None:
        """Hold one issued record as the most recently used; lock held."""
        self._issued[key] = record
        self._issued.move_to_end(key)
        identity = record.get("identity")
        if identity is not None:
            self._issued_by_identity[identity] = key[1]
        while len(self._issued) > _MAX_ISSUED:
            (_, evicted_id), evicted = self._issued.popitem(last=False)
            evicted_identity = evicted.get("identity")
            if (
                evicted_identity is not None
                and self._issued_by_identity.get(evicted_identity) == evicted_id
            ):
                del self._issued_by_identity[evicted_identity]

    def _signing_inputs(  # noqa: PLR0913
        self,
        request: dict[str, Any],
        state: dict[str, Any],
        config: dict[str, Any],
        cohort: CohortSnapshot,
        run_id: str,
        project_root: str,
    ) -> RuntimeCfgInputs:
        """Rebuild the private inputs the planner signed receipts with.

        Two private bindings shape a signed command and neither is persisted
        in the run's configuration: the managed-resource runtime (SynthStrip
        image, Apptainer binary) and each subject's reviewed Brain FOV input.
        Without them the Brain FOV action binds as unresolved and the
        reconstruction input rebinds to the raw T1, so every receipt read as
        stale right after the run that produced it.
        """
        runtime_context = request.get("runtimeContext")
        resource_runtime = (
            resolve_runtime_resources(config, runtime_context).runtime
            if isinstance(runtime_context, dict)
            else None
        )
        signature_cfg = runtime_cfg(
            config,
            cohort,
            run_id,
            project_root,
            inputs=RuntimeCfgInputs(resource_runtime=resource_runtime),
        )
        steps = config.get("steps") if isinstance(config.get("steps"), dict) else {}
        brainfov = steps.get("brainfov") if isinstance(steps, dict) else None
        brainfov_enabled = isinstance(brainfov, dict) and bool(brainfov.get("enabled"))
        prepared: dict[str, dict[str, Any]] = {}
        notes: dict[str, str] = {}
        if brainfov_enabled and self.input_fov_reviews is not None:
            cache_key = (
                str(project_root),
                run_id,
                stable_digest(config),
                str((runtime_context or {}).get("userDataPath", "")),
                len(state.get("receipts", []) or []),
            )
            cached = self._signing_cache.get(cache_key)
            if cached is not None:
                prepared, notes = cached
            else:
                review_request = {
                    "project": request.get("project"),
                    "cfg": config,
                    "configRevision": state.get("configRevision", 0),
                }
                prepared, blockers = resolve_input_fov_subjects(
                    self.input_fov_reviews,
                    review_request,
                    signature_cfg,
                    dict(cohort.t1_by_subject),
                )
                for subject_id in sorted(blockers):
                    if subject_id in prepared or not blockers[subject_id]:
                        continue
                    if len(notes) >= _MAX_SIGNING_NOTES:
                        break
                    notes[subject_id] = blockers[subject_id]
                while len(self._signing_cache) >= _MAX_SIGNING_CACHE:
                    self._signing_cache.pop(next(iter(self._signing_cache)))
                self._signing_cache[cache_key] = (prepared, notes)
        self._last_signing_notes = dict(notes)
        return RuntimeCfgInputs(
            prepared_bindings=prepared or None,
            resource_runtime=resource_runtime,
        )

    def list(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return one bounded inventory page for an explicit persisted run.

        Validate the active resource generation once for the whole sweep; every
        receipt check digests actions and resources that resolve it. A request
        with ``currentConfigSha256`` for a run recorded under another
        configuration answers with the run's digest and no rows; with
        ``galleryPresence`` for the ENIGMA stage it also carries the presence
        of that stage's rows alone under ``galleryPresence``.
        """
        with scientific_assets.resolution_scope():
            return self._list(request)

    def _list(  # noqa: PLR0912, PLR0915
        self, request: dict[str, Any]
    ) -> dict[str, Any]:
        project = self.projects.validate(request.get("project"))
        requested_step = request.get("stepKey")
        if requested_step is not None and (
            not isinstance(requested_step, str) or requested_step not in STEP_BY_KEY
        ):
            raise ValueError("Select a valid result-stage filter.")
        requested_query = request.get("query", "")
        if not isinstance(requested_query, str):
            raise ValueError("Provide a valid result-search query.")
        query = " ".join(requested_query.split())
        if len(query) > _MAX_QUERY_CHARACTERS:
            raise ValueError("Shorten the result-search query.")
        gallery_presence = request.get("galleryPresence", False)
        if not isinstance(gallery_presence, bool):
            raise ValueError("Provide a valid gallery-presence flag.")
        if gallery_presence and (
            requested_step != "enigma" or request.get("currentConfigSha256") is None
        ):
            raise ValueError(
                "Request gallery presence for the ENIGMA stage with a "
                "configuration digest."
            )
        store = RunStore(project.root)
        run_id = str(request.get("runId") or "")
        if not run_id:
            page = store.list(limit=1)
            if not page["items"]:
                return {"items": [], "nextCursor": None, "truncated": False}
            run_id = str(page["items"][0].get("runId", ""))
        state = store.load(run_id)
        config = state.get("config", {})
        if not isinstance(config, dict):
            config = {}
        config_sha256 = stable_digest(config)
        expected_config = request.get("currentConfigSha256")
        if expected_config is not None:
            if not _valid_sha256(expected_config):
                raise ValueError("Provide a valid configuration digest.")
            if expected_config != config_sha256:
                # The caller needs only the digest of a run whose inventory it
                # cannot use; skip the per-row provenance, which costs seconds
                # for a whole cohort.
                probe: dict[str, Any] = {
                    "items": [],
                    "nextCursor": None,
                    "truncated": False,
                    "runId": run_id,
                    "configSha256": config_sha256,
                    "total": 0,
                }
                if gallery_presence:
                    probe["galleryPresence"] = _enigma_gallery_presence(
                        state, config, run_id, project.root
                    )
                return probe
        cohort = _cohort(state.get("scope", {}))
        analysis = list(cohort.analysis_subject_ids)
        subject_truncated = len(analysis) > _MAX_SUBJECTS
        analysis = analysis[:_MAX_SUBJECTS]
        signing_inputs = self._signing_inputs(
            request, state, config, cohort, run_id, project.root
        )
        receipts = [
            receipt
            for receipt in state.get("receipts", [])
            if isinstance(receipt, dict)
        ]

        def effective_for(
            snapshot: CohortSnapshot, subject_ids: list[str]
        ) -> dict[str, Any]:
            return _with_reconstruction(
                runtime_cfg(
                    config,
                    snapshot,
                    run_id,
                    project.root,
                    inputs=signing_inputs,
                ),
                _reconstruction_selection(config, state, set(subject_ids), receipts),
            )

        effective = effective_for(cohort, analysis)
        environment = _inventory_environment(
            state.get("environmentEvidence", {}), effective
        )
        # Judge cohort-scope stages against the analysis cohort the next Run
        # all would plan, which binds the analysis membership. Rows keep their
        # provenance against the run's own cohort: QC review records verdicts
        # only from a gallery whose provenance is current.
        next_cohort = _live_analysis_cohort(
            state, cohort, project.root, project.config_path
        )
        judged_live = next_cohort.snapshot is not None
        live_cohort = next_cohort.snapshot or cohort
        rebound = next_cohort.rebound
        live_analysis = list(live_cohort.analysis_subject_ids)[:_MAX_SUBJECTS]
        # The configuration and the detector evidence depend on the cohort
        # through its members and their T1 paths only, so a verdict-only
        # change shares them.
        live_effective = (
            effective
            if live_cohort.analysis_subject_ids == cohort.analysis_subject_ids
            and live_cohort.t1_by_subject == cohort.t1_by_subject
            else effective_for(live_cohort, live_analysis)
        )
        evidence_cache: dict[tuple[str, str | None, bool], dict[str, Any]] = {}
        signature_cache: dict[
            tuple[str, str | None, bool], tuple[str, dict[str, Any]]
        ] = {}
        producer_run_cache: dict[str, dict[str, Any] | None] = {run_id: state}

        def producer_node_id(
            receipt: dict[str, Any] | None,
            fallback_job: dict[str, Any] | None,
        ) -> str | None:
            if receipt is None:
                if fallback_job is None:
                    return None
                return str(fallback_job.get("nodeId") or "") or None
            receipt_job = str(receipt.get("jobId") or "")
            receipt_run = str(receipt.get("runId") or run_id)
            if not receipt_job or not receipt_run:
                return None
            if receipt_run not in producer_run_cache:
                try:
                    producer_run_cache[receipt_run] = store.load(receipt_run)
                except (ValueError, OSError):
                    producer_run_cache[receipt_run] = None
            producer_state = producer_run_cache[receipt_run]
            if producer_state is None:
                return None
            producer_jobs = producer_state.get("jobs", [])
            if not isinstance(producer_jobs, list):
                return None
            return next(
                (
                    str(item.get("nodeId"))
                    for item in reversed(producer_jobs)
                    if isinstance(item, dict)
                    and str(item.get("id") or "") == receipt_job
                    and item.get("nodeId")
                ),
                None,
            )

        def evidence(
            step_key: str, subject_id: str | None, live: bool = False
        ) -> dict[str, Any]:
            # Read a detector through the view its signature binds: a
            # subject-scope detector reads the input at the subject's own T1
            # row, so a rebound subject takes the live row, as the planner does.
            live = (
                live
                and (STEP_SCOPES[step_key] == "cohort" or subject_id in rebound)
                and live_effective is not effective
            )
            key = (step_key, subject_id, live)
            if key not in evidence_cache:
                view = live_effective if live else effective
                detected = detector_evidence(ADAPTERS[step_key], view, subject_id)
                evidence_cache[key] = enrich_evidence(
                    step_key, detected, view, live_cohort if live else cohort
                )
            return evidence_cache[key]

        def signature(
            step_key: str,
            subject_id: str | None,
            live: bool = False,
        ) -> tuple[str, dict[str, Any]]:
            # A subject-scope payload binds no analysis cohort, only its own
            # T1 row, so it takes the live cohort only for a subject whose row
            # the next Run all binds differently.
            live = (
                live
                and judged_live
                and (STEP_SCOPES[step_key] == "cohort" or subject_id in rebound)
            )
            key = (step_key, subject_id, live)
            if key in signature_cache:
                return signature_cache[key]
            members = live_analysis if live else analysis
            view = live_effective if live else effective
            judged_cohort = live_cohort if live else cohort
            upstream: list[str] = []
            for producer in _logical_dependencies(config, step_key):
                if producer == "recon":
                    upstream.extend(
                        signature(producer, item, live)[0] for item in members
                    )
                elif STEP_SCOPES[producer] == "subject":
                    upstream.append(signature(producer, subject_id, live)[0])
                else:
                    upstream.append(signature(producer, None, live)[0])
            if step_key in {"deface", "recon"} and subject_id is not None:
                scientific = state.get("scientificEvidence", {})
                input_fov = (
                    scientific.get("inputFov", {})
                    if isinstance(scientific, dict)
                    else {}
                )
                item = (
                    input_fov.get(subject_id) if isinstance(input_fov, dict) else None
                )
                decision = (
                    item.get("decisionSignature") if isinstance(item, dict) else None
                )
                if isinstance(decision, str) and decision:
                    upstream.append(decision)
            adapter = ADAPTERS[step_key]
            tool_evidence = bound_tool_evidence(
                environment, adapter.required_check_ids(view)
            )
            signature_cache[key] = bind_projection_inputs(
                step_key,
                *expected_signature(
                    step_key,
                    subject_id,
                    view,
                    judged_cohort,
                    adapter,
                    upstream_signatures=upstream,
                    tool_evidence=tool_evidence,
                    provider_evidence=state.get("providerEvidence"),
                ),
            )
            return signature_cache[key]

        def matching_receipt(
            candidates: list[dict[str, Any]],
            step_key: str,
            subject_id: str | None,
            *,
            project_store: bool = False,
            live: bool = False,
        ) -> tuple[dict[str, Any] | None, bool]:
            """Return the receipt matching the expected digest, if any.

            Search the run's own receipts. With ``project_store``, also search
            the project's published receipts, as the planner does. With
            ``live``, expect a cohort-scope node to bind the analysis cohort
            the next Run all would plan.
            """
            try:
                expected_sha = signature(step_key, subject_id, live)[0]
            except (TypeError, ValueError):
                return None, False
            found = signed_receipt(candidates, expected_sha)
            if found is None and project_store:
                found = store.get_receipt(
                    step_key, str(subject_id or "cohort"), expected_sha
                )
            return found, True

        def signed_receipt(
            candidates: list[dict[str, Any]], expected_sha: str
        ) -> dict[str, Any] | None:
            for candidate in reversed(candidates):
                if candidate.get("receiptVersion") != RECEIPT_VERSION:
                    continue
                try:
                    valid = receipt_signature_valid(candidate, expected_sha)
                except (TypeError, ValueError):
                    valid = False
                if valid:
                    return candidate
            return None

        def node_receipts(
            step_key: str, subject_id: str | None
        ) -> list[dict[str, Any]]:
            return [
                receipt
                for receipt in receipts
                if receipt.get("stepKey") == step_key
                and receipt.get("subjectId") == subject_id
            ]

        def planner_currency(
            step_key: str, subject_id: str | None, live: bool = False
        ) -> str:
            """Judge one node the way the planner judges reuse.

            A node is current when a receipt in the run or in the project
            store matches the digest this run's configuration and cohort
            yield, in its current or pre-token form, and its detector
            evidence still matches the outputs on disk. Any other node would
            run again, so it is outdated. Other settings saved after this run
            are the plan's to judge. With ``live``, a cohort-scope node is
            judged against the analysis cohort the next Run all would plan,
            and a subject-scope node against the T1 row that cohort binds.
            """
            if subject_truncated and STEP_SCOPES[step_key] == "cohort":
                return "unknown"
            candidates = node_receipts(step_key, subject_id)
            if not candidates and not store.receipt_signatures(
                step_key, str(subject_id or "cohort")
            ):
                # With no receipt anywhere the planner runs the node again.
                return "outdated"
            receipt, calculated = matching_receipt(
                candidates, step_key, subject_id, project_store=True, live=live
            )
            if not calculated:
                return "unknown"
            detected = evidence(step_key, subject_id, live)
            recorded = receipt.get("detectorEvidence", {}) if receipt else {}
            if (
                receipt is not None
                and evidence_is_done(recorded)
                and evidence_is_done(detected)
                and evidence_identity(recorded) == evidence_identity(detected)
            ):
                return "current"
            return "outdated"

        def provenance(
            step_key: str, subject_id: str | None
        ) -> tuple[str, dict[str, Any] | None]:
            candidates = node_receipts(step_key, subject_id)
            if bool(state.get("dryRun")) or not candidates:
                return "unknown", None
            if subject_truncated and STEP_SCOPES[step_key] == "cohort":
                return "unknown", candidates[-1]
            current, calculated = matching_receipt(candidates, step_key, subject_id)
            if not calculated:
                return "unknown", candidates[-1]
            if current is not None:
                detected = evidence(step_key, subject_id)
                if evidence_is_done(detected) and evidence_identity(
                    current.get("detectorEvidence", {})
                ) == evidence_identity(detected):
                    return "current", current
            return "stale", candidates[-1]

        cohort_causes: dict[str, str] = {}

        def stage_currency(step_key: str, subject_id: str | None) -> str:
            """Judge one node against the cohort the next Run all would plan.

            Name the analysis cohort as the cause when a cohort-scope node
            matches under the run's cohort but not under that one. Judge a
            subject-scope node against the T1 row that Run all would bind.
            """
            if STEP_SCOPES[step_key] != "cohort":
                return planner_currency(
                    step_key, subject_id, live=subject_id in rebound
                )
            if next_cohort.unknown:
                return "unknown"
            if not judged_live:
                return planner_currency(step_key, subject_id)
            judged = planner_currency(step_key, subject_id, live=True)
            if (
                judged == "outdated"
                and planner_currency(step_key, subject_id) == "current"
            ):
                cohort_causes[step_key] = "analysis-cohort"
            return judged

        # The planner skips a stage the configuration disables: it neither
        # reuses nor reruns it, so the stage has no currency. Judged like an
        # enabled stage, one that never ran has no receipt and would read out
        # of date.
        judged_steps = {
            descriptor["key"]
            for descriptor in STEP_DESCRIPTORS
            if _step_enabled(config, descriptor["key"])
        }
        rows: list[dict[str, Any]] = []
        pending_registrations: dict[str, dict[str, Any]] = {}
        currency: dict[str, dict[str | None, str]] = {}
        scan_truncated = subject_truncated
        # List in display order: the stages appended after R analysis sit beside
        # the stages they extend, as the stage lists show them.
        for descriptor in sorted(STEP_DESCRIPTORS, key=lambda item: item["id"]):
            step_key = descriptor["key"]
            if requested_step is not None and step_key != requested_step:
                continue
            subjects: list[str | None] = (
                analysis if descriptor["scope"] == "subject" else [None]
            )
            for subject_id in subjects:
                if len(rows) >= _MAX_ROWS:
                    scan_truncated = True
                    break
                detected = evidence(step_key, subject_id)
                detector_state = str(detected.get("state", "unknown"))
                detector_detail = str(detected.get("detail", ""))
                provenance_state, receipt = provenance(step_key, subject_id)
                if step_key in judged_steps:
                    currency.setdefault(step_key, {})[subject_id] = stage_currency(
                        step_key, subject_id
                    )
                attempted = _attempted(state, step_key, subject_id)
                jobs = [
                    job
                    for job in state.get("jobs", [])
                    if job.get("stepKey") == step_key
                    and job.get("subjectId") == subject_id
                ]
                job = jobs[-1] if jobs and attempted else None
                producer_run = (
                    str(receipt.get("runId") or run_id)
                    if receipt is not None
                    else run_id
                    if job is not None
                    else None
                )
                producer_node = producer_node_id(receipt, job)
                provenance_details = _receipt_provenance(receipt, state)

                expected_rows = _expected(
                    step_key, ADAPTERS[step_key], effective, subject_id
                )
                known: set[str] = set()
                for expected_item in expected_rows:
                    canonical = os.path.realpath(expected_item.path)
                    known.add(canonical)
                    presence = _presence(
                        detector_state, os.path.exists(canonical), attempted
                    )
                    rows.append(
                        self._row(
                            project,
                            expected_item.label,
                            step_key,
                            subject_id,
                            expected_item.kind,
                            presence,
                            canonical,
                            producer_run,
                            producer_node,
                            str(receipt.get("recordSha256")) if receipt else None,
                            provenance_state,
                            provenance_details,
                            detector_detail,
                            inventory_run_id=run_id,
                            config_sha256=config_sha256,
                            pending=pending_registrations,
                        )
                    )
                    if len(rows) >= _MAX_ROWS:
                        scan_truncated = True
                        break
                for item in detected.get("artifacts", [])[:_MAX_DETECTOR_ARTIFACTS]:
                    path = str(item.get("path", "")) if isinstance(item, dict) else ""
                    if not path:
                        continue
                    canonical = os.path.realpath(path)
                    if canonical in known or not os.path.exists(canonical):
                        continue
                    rows.append(
                        self._row(
                            project,
                            os.path.basename(canonical) or step_key,
                            step_key,
                            subject_id,
                            _kind(canonical),
                            "produced" if detector_state == "done" else "partial",
                            canonical,
                            producer_run,
                            producer_node,
                            str(receipt.get("recordSha256")) if receipt else None,
                            provenance_state,
                            provenance_details,
                            detector_detail,
                            inventory_run_id=run_id,
                            config_sha256=config_sha256,
                            pending=pending_registrations,
                        )
                    )
                    if len(rows) >= _MAX_ROWS:
                        scan_truncated = True
                        break
            if len(rows) >= _MAX_ROWS:
                break

        produced_step_keys = sorted(
            {
                str(row.get("stepKey"))
                for row in rows
                if row.get("presence") == "produced"
            }
        )
        if query:
            rows = [row for row in rows if _matches_query(row, query)]
        total = len(rows)
        try:
            cursor = max(0, int(request.get("cursor") or 0))
            limit = max(1, min(int(request.get("limit") or 100), 500))
        except (TypeError, ValueError):
            cursor, limit = 0, 100
        page_rows = rows[cursor : cursor + limit]
        next_cursor = cursor + len(page_rows)
        has_more = next_cursor < len(rows)
        # Register only the rows this call returns; registering the whole
        # scan can evict the very IDs on the returned page once an inventory
        # exceeds the issued-ID cache bound.
        with self._lock:
            for row in page_rows:
                record = pending_registrations.get(str(row.get("artifactId")))
                if record is not None:
                    self._hold((project.project_id, str(row["artifactId"])), record)
        return {
            "items": page_rows,
            "nextCursor": str(next_cursor) if has_more else None,
            "truncated": has_more or scan_truncated,
            "runId": run_id,
            "configSha256": config_sha256,
            "total": total,
            "producedStepKeys": produced_step_keys,
            "stageCurrency": _stage_currency_summary(
                {
                    step_key: by_subject
                    for step_key, by_subject in currency.items()
                    # A stage cut short by the row bound is left out rather
                    # than summarized from part of its subjects.
                    if not scan_truncated
                    or STEP_SCOPES[step_key] == "cohort"
                    or len(by_subject) == len(analysis)
                },
                cohort_causes,
            ),
            "analysisCohortChange": (
                None
                if next_cohort.change is None
                else {"cause": next_cohort.change}
                if not next_cohort.reasons
                else {
                    "cause": next_cohort.change,
                    "reasons": [dict(item) for item in next_cohort.reasons],
                }
            ),
            "signingNotes": dict(self._last_signing_notes),
        }

    def _row(  # noqa: PLR0913
        self,
        project: Any,
        label: str,
        step_key: str,
        subject_id: str | None,
        kind: str,
        presence: str,
        path: str,
        run_id: str | None,
        producer_node_id: str | None,
        receipt_sha256: str | None,
        provenance: str,
        provenance_details: dict[str, Any],
        detail: str,
        *,
        inventory_run_id: str | None = None,
        config_sha256: str | None = None,
        pending: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        try:
            info: os.stat_result | None = os.stat(path)
        except OSError:
            info = None
        exists = info is not None
        artifact_id = f"artifact-{uuid.uuid4().hex}"
        display_path = _display(path, project.root)
        if info is not None:
            config_digest = (
                config_sha256 if _valid_sha256(config_sha256) else stable_digest({})
            )
            record_kind = "directory" if stat.S_ISDIR(info.st_mode) else "file"
            # The same file, unchanged, with the same trusted attribution is
            # the same artifact: reuse its held ID so a repeated listing does
            # not evict identities another screen still holds. A changed file
            # or attribution gets a new ID, and an old ID keeps its record.
            identity = (
                project.project_id,
                project.epoch,
                path,
                record_kind,
                info.st_dev,
                info.st_ino,
                info.st_size,
                info.st_mtime_ns,
                label,
                step_key,
                subject_id,
                kind,
                presence,
                display_path,
                run_id,
                producer_node_id,
                receipt_sha256,
                provenance,
                inventory_run_id,
                config_digest,
            )
            with self._lock:
                held = self._issued_by_identity.get(identity)
            # Two rows of one listing never share an ID.
            if held is not None and (pending is None or held not in pending):
                artifact_id = held
            metadata = _IssuedResultMetadata(
                artifact_id=artifact_id,
                label=label,
                step_key=step_key,
                subject_id=subject_id,
                kind=kind,
                presence=presence,
                display_path=display_path,
                run_id=run_id,
                producer_node_id=producer_node_id,
                receipt_sha256=receipt_sha256,
                provenance=provenance,
                inventory_run_id=inventory_run_id,
                config_sha256=config_digest,
            )
            record = {
                "path": path,
                "kind": record_kind,
                "exists": True,
                "projectEpoch": project.epoch,
                "metadata": metadata,
                "identity": identity,
            }
            if pending is not None:
                # Defer registration so a scan larger than the issued-ID
                # cache registers only the rows the call returns.
                pending[artifact_id] = record
            else:
                with self._lock:
                    self._hold((project.project_id, artifact_id), record)
        return {
            "artifactId": artifact_id,
            "label": label,
            "stepKey": step_key,
            "subjectId": subject_id,
            "kind": kind,
            "presence": presence,
            "displayPath": display_path,
            "exists": exists,
            "openable": info is not None and stat.S_ISREG(info.st_mode),
            "revealable": exists,
            "runId": run_id,
            "producerNodeId": producer_node_id,
            "receiptSha256": receipt_sha256,
            "provenance": provenance,
            "provenanceDetails": provenance_details,
            "detail": detail,
        }

    def resolve(self, request: dict[str, Any]) -> dict[str, Any]:
        """Resolve an issued artifact ID for the trusted main process only."""
        project = self.projects.validate(request.get("project"))
        artifact_id = str(request.get("artifactId", ""))
        key = (project.project_id, artifact_id)
        with self._lock:
            record = self._issued.get(key)
            if record is not None and record.get("projectEpoch") == project.epoch:
                # An identity in use stays held longest.
                self._issued.move_to_end(key)
        if record is None or record.get("projectEpoch") != project.epoch:
            raise ValueError("Select a known artifact identity.")
        exists = os.path.exists(record["path"])
        resolved = {
            "path": record["path"],
            "kind": record["kind"],
            "exists": exists,
        }
        metadata = record.get("metadata")
        if isinstance(metadata, _IssuedResultMetadata):
            resolved["metadata"] = metadata.to_dict()
        return resolved

    def gallery_images(self, request: dict[str, Any]) -> dict[str, Any]:
        """Describe one subject's verified ENIGMA montage panels for the app.

        Revalidate the whole requested gallery before describing any panel.
        Issue each accepted image an opaque identity with its verified size and
        SHA-256. Let the trusted main process bind later reads to this evidence.
        """
        project = self.projects.validate(request.get("project"))
        run_id = str(request.get("runId") or "")
        tab = str(request.get("tab") or "")
        subject_id = str(request.get("subjectId") or "")
        if not run_id:
            raise ValueError("Provide the QC gallery run.")
        if tab not in enigma.GALLERY_KEY_BY_TAB:
            raise ValueError("Provide a valid QC gallery selector.")
        if not subject_id or len(subject_id) > _MAX_SUBJECT_ID_CHARACTERS:
            raise ValueError("Provide a valid QC gallery subject.")
        state = RunStore(project.root).load(run_id)
        config = state.get("config", {})
        if not isinstance(config, dict):
            config = {}
        cohort = _cohort(state.get("scope", {}))
        effective = runtime_cfg(config, cohort, run_id, project.root)
        adapter = ADAPTERS["enigma"]
        out_dir = adapter._out_dir(effective)  # type: ignore[attr-defined]
        subjects = tuple(cohort.analysis_subject_ids)
        panels, error = enigma.verified_subject_panels(
            out_dir, tab, subjects, subject_id
        )
        if error is not None:
            raise ValueError(error)
        issued: list[dict[str, Any]] = []
        for panel in panels:
            record = {
                "key": panel["key"],
                "group": panel["group"],
                "detail": panel["detail"],
                "label": panel["label"],
            }
            for role in ("montage", "full"):
                image = panel[role]
                artifact_id = self.register_external(
                    project.project_id, project.epoch, image["path"]
                )
                record[role] = {
                    "artifactId": artifact_id,
                    "relativePath": image["relativePath"],
                    "displayPath": _display(image["path"], project.root),
                    "bytes": image["bytes"],
                    "sha256": image["sha256"],
                }
            issued.append(record)
        described: dict[str, Any] = {
            "runId": run_id,
            "tab": tab,
            "subjectId": subject_id,
            "configSha256": stable_digest(config),
            "panels": issued,
        }
        changed = self._images_changed_since_verdict(
            project.root, state, tab, subject_id
        )
        if changed is not None:
            described["imagesChangedSinceVerdict"] = changed
        return described

    @staticmethod
    def _images_changed_since_verdict(
        project_root: str, state: dict[str, Any], tab: str, subject_id: str
    ) -> dict[str, str] | None:
        """Name the render that replaced the images a recorded verdict saw.

        Display evidence only: the verdict, the analysis cohort, and every
        digest stay as they are.
        """
        try:
            record = load_project_qc_records(project_root).get(subject_id)
        except (OSError, ValueError):
            return None
        evidence = record.get("reviewEvidence") if isinstance(record, dict) else None
        galleries = evidence.get("galleries") if isinstance(evidence, dict) else None
        reviewed_run_id = (
            galleries[0].get("runId")
            if isinstance(galleries, list) and galleries
            else None
        )
        return unit_reuse.superseded_review(
            RunStore(project_root),
            state,
            "enigma",
            subject_id,
            tab,
            reviewed_run_id if isinstance(reviewed_run_id, str) else None,
        )

    def register_external(
        self,
        project_id: str,
        project_epoch: int,
        path: str,
        *,
        kind: str = "file",
    ) -> str:
        """Issue an opaque identity for a wrapper-created external artifact.

        Each call issues a new ID: the main process binds each QC montage
        view's panel IDs to that view's display evidence, so views never
        share one.
        """
        canonical = os.path.realpath(path)
        artifact_id = f"artifact-{uuid.uuid4().hex}"
        with self._lock:
            self._hold(
                (project_id, artifact_id),
                {
                    "path": canonical,
                    "kind": kind,
                    "exists": os.path.exists(canonical),
                    "projectEpoch": project_epoch,
                },
            )
        return artifact_id
