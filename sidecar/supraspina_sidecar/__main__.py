"""Dispatcher wiring and the sidecar JSON-RPC stdio loop.

The module exposes the protocol-level handlers (``ping`` and schema validation)
and the data methods called by the renderer: ``pipeline.listSteps``,
``pipeline.previewCommand``, ``pipeline.runWorkflow``, ``subjects.discover``,
``provision.pybrainage``, ``provision.braincharts``, ``provision.status``,
``env.check``, ``env.optInInstall``, ``env.installStatus``,
``env.createOutputDir``, ``env.toolStatus``, the advisory
``surfaceRegistration.*`` check, the interactive ``groupAnalysis.*``
analysis, and its on-demand atlas labeling.

It imports :mod:`supraspina_sidecar.adapters` at startup so that every adapter's
``register(...)`` call runs before any handler resolves a step. Every shown or
executed command is built through its owning adapter's ``build_command`` or
``preview``; the dispatcher never hardcodes a tool command.
"""

from __future__ import annotations

import copy
import os
import sys
import time
import uuid
from typing import Any

from . import __version__, adapters, env  # noqa: F401 - Populate ADAPTERS on import.
from .adapters import pybrainage
from .adapters.base import ADAPTERS, UnresolvedTemplateError, unresolved_tokens
from .authorization import AuthorizationLedger
from .cohort import (
    T1Resolution,
    discover_t1_resolutions,
    effective_qc_verdict,
    load_qc_records,
)
from .debug_bundle import DebugBundleManager
from .env_install import EnvInstallManager
from .group_analysis.atlas_manager import AtlasLabelingManager
from .group_analysis.manager import GroupAnalysisManager
from .input_fov_review import InputFovReviewManager
from .managed_resources import ManagedResourceManager
from .project import ProjectIdentityError
from .provisioning import ProvisionManager
from .registration_check import SurfaceRegistrationManager
from .registry import STEP_BY_KEY, STEP_DEPENDENCIES, STEP_DESCRIPTORS, STEP_SCOPES
from .registry_store import RegistryStore
from .results import ResultInventory
from .rpc import LIVENESS_METHOD, Dispatcher, Emitter, serve
from .runtime_resources import resolve_runtime_resources
from .sites import SITE_LABEL_RULE
from .workflow import validate_config_revision
from .workflow_manager import WorkflowManager

# Keep the ten matrix columns in load-bearing order and index-aligned with a
# Subject's ``cells`` array. Mirror ``MATRIX_STEPS`` in ``src/shared/steps.ts``.
MATRIX_COLUMNS: tuple[str, ...] = (
    "recon",
    "qcsub",
    "qcic",
    "qcec",
    "feat",
    "pba",
    "norm",
    "stats",
    "agg",
    "rep",
)

# Resolve adapters in registry pipeline order so the most downstream adapter
# that advances a shared column wins.
_ADAPTER_ORDER: tuple[str, ...] = tuple(d["key"] for d in STEP_DESCRIPTORS)

# Matrix columns of stages whose adapter declares none. An adapter's source
# file is bound into its receipts, so a display-only column mapping lives here.
_DISPLAY_ADVANCES: dict[str, tuple[str, ...]] = {"braincharts": ("norm",)}
_NORM_COLUMN = "norm"


def _validate(params: list[Any], _emit: Emitter) -> dict[str, Any]:
    """Validate a project configuration (handler for ``schema.validate``)."""
    data = params[0] if params else None
    try:
        # Import lazily so the loop runs before pydantic is installed.
        from .schema import validate_project_config  # noqa: PLC0415
    except ImportError as exc:
        return {
            "ok": False,
            "errors": [f"validator unavailable: {exc}"],
            "warnings": [],
        }
    ok, errors, warnings = validate_project_config(data)
    return {"ok": ok, "errors": errors, "warnings": warnings}


def _project_validate(params: list[Any], emit: Emitter) -> dict[str, Any]:
    """Validate only structural schema and internal config consistency.

    Allow a valid draft to be saved when host tools or scientific inputs are
    absent. Apply adapter and environment gates during workflow planning and
    live execution, where they surface as explicit run blockers.
    """
    base = _validate(params, emit)
    errors = list(base.get("errors", []))
    warnings = list(base.get("warnings", []))
    return {"ok": not errors, "errors": errors, "warnings": warnings}


def _list_steps(_params: list[Any], _emit: Emitter) -> list[dict[str, Any]]:
    """Return the pipeline step descriptors (handler for ``pipeline.listSteps``)."""
    return list(STEP_DESCRIPTORS)


# -- Pipeline preview / run -----------------------------------------------------


#: Keep this placeholder in a subject-scoped preview that names no subject.
_SUBJECT_PLACEHOLDER = "${subject}"
# The reconstruction input a subject-free preview names. A plan binds each
# subject's discovered T1, its Brain FOV crop, or its defaced copy; none of
# them follows one fixed layout, so the template names the input by role.
PREVIEW_T1_INPUT = "<T1 input for ${subject}>"


def _arg(params: list[Any], index: int, default: Any = None) -> Any:
    """Return ``params[index]`` if present, else ``default``."""
    return params[index] if len(params) > index else default


def _preview_command(params: list[Any], _emit: Emitter) -> str:
    """Return the resolved command preview for one step.

    Accept ``[cfg, key, subjectId]``. Resolve through the owning
    adapter's :meth:`preview`, so the returned string is the same shell-quoted
    command the run handler would spawn.

    Raises
    ------
    UnresolvedTemplateError
        Raise when the config leaves a ``${...}`` placeholder in the command,
        as :func:`supraspina_sidecar.workflow.build_plan` does before it shows a
        planned command. A subject-scoped stage previewed without a subject
        keeps its ``${subject}`` placeholder by design, so only configuration
        placeholders are refused in that case.
    """
    cfg = _arg(params, 0, {})
    key = _arg(params, 1, "")
    subject_id = _arg(params, 2)
    adapter = ADAPTERS[key]
    # Preview against the same run-time overlay the planner builds, so a
    # stage whose backend or device resolves at plan time, such as the
    # auto reconstruction backend, previews the command it would run.
    effective = copy.deepcopy(cfg) if isinstance(cfg, dict) else cfg
    if isinstance(effective, dict):
        runtime = resolve_runtime_resources(cfg, None).runtime
        if subject_id is None:
            # Without a subject the adapters fall back to a fixed BIDS path
            # that this project may not use and a real plan never binds.
            runtime = {
                **runtime,
                "reconInputBySubject": {_SUBJECT_PLACEHOLDER: PREVIEW_T1_INPUT},
            }
        effective["_supraspinaRuntime"] = runtime
    command = adapter.preview(effective, subject_id)
    tokens = unresolved_tokens([command])
    if subject_id is None:
        tokens = [item for item in tokens if item != _SUBJECT_PLACEHOLDER]
    if tokens:
        raise UnresolvedTemplateError(key, tokens)
    return command


# -- Subject discovery ----------------------------------------------------------


def _detector_cfg(
    cfg: dict[str, Any],
    resolutions: list[T1Resolution],
) -> dict[str, Any]:
    """Bind discovery's resolved T1 paths for adapter currentness checks.

    Reconstruct the run-time input maps that project configs do not persist.
    Give detectors the same authoritative T1 resolution,
    especially for BIDS session/acquisition layouts that cannot be represented
    by the flat ``sub-*/anat/sub-*_T1w.nii.gz`` pattern alone.
    """
    effective = dict(cfg)
    configured_runtime = cfg.get("_supraspinaRuntime", {})
    runtime = dict(configured_runtime) if isinstance(configured_runtime, dict) else {}
    runtime["t1BySubject"] = {
        item.subject_id: item.path
        for item in resolutions
        if item.state == "resolved" and item.path is not None
    }
    effective["_supraspinaRuntime"] = runtime
    return effective


def _discover(params: list[Any], _emit: Emitter) -> list[dict[str, Any]]:
    """Discover subjects under ``cfg.paths.rawdataDir`` (``subjects.discover``).

    Retain every safely named subject directory, including rows whose T1 input
    is missing or ambiguous, so the operator can resolve the same integrity
    blockers enforced by planning. Fill each subject's ten ``cells`` and
    per-step ``stepStates`` from every adapter's :meth:`detect`. Keep detector
    failures visible as bounded integrity errors instead of treating them
    as ordinary pending work.

    Accept ``[cfg]``.
    """
    cfg = params[0] if params else {}
    if not isinstance(cfg, dict):
        return []
    store = RegistryStore(str(cfg.get("paths", {}).get("projectRoot", "")))
    registry = {row["subjectId"]: row for row in store.list(cfg)}
    held_sites = store.pending_sites()
    qc = load_qc_records(cfg)
    resolutions = discover_t1_resolutions(cfg)
    detection_cfg = _detector_cfg(cfg, resolutions)
    cohort_members = _cohort_members(detection_cfg)
    subjects: list[dict[str, Any]] = []
    for resolution in resolutions:
        state = resolution.state
        availability = (
            "available"
            if state == "resolved"
            else "missing"
            if state == "missing"
            else "ambiguous"
        )
        unavailable_reason = (
            None
            if state == "resolved"
            else (
                "Provide a T1 input matching the configured pattern for "
                f"{resolution.subject_id}."
            )
            if state == "missing"
            else (
                "Select one T1 input matching the configured pattern for "
                f"{resolution.subject_id}."
            )
            if state == "ambiguous"
            else f"Use a safe configured T1 resolver for {resolution.subject_id}."
        )
        subjects.append(
            _subject_record(
                detection_cfg,
                resolution.subject_id,
                registry.get(resolution.subject_id),
                qc.get(resolution.subject_id),
                t1_availability=availability,
                unavailable_reason=unavailable_reason,
                cohort_members=cohort_members,
                held_site=held_sites.get(resolution.subject_id),
            )
        )
    return subjects


def _empty_cell() -> dict[str, Any]:
    """Return a pending matrix cell mirroring ``emptyCell()`` in the renderer."""
    return {
        "st": "pending",
        "startedAt": None,
        "finishedAt": None,
        "progress": None,
        "rc": None,
        "err": None,
    }


# Map an adapter ``StepStatus.state`` onto a renderer ``CellState``.
_STATE_MAP: dict[str, str] = {
    "done": "done",
    "running": "running",
    "failed": "failed",
    "skipped": "skipped",
    "partial": "pending",
    "pending": "pending",
}


def _detect_state_with_error(
    adapter: Any, cfg: dict[str, Any], subject_id: str
) -> tuple[str, str | None, int | None]:
    """Return a detected state, a raising detector's error type, and a finish time.

    A detector that raises reports only its exception's type name, so no path
    from the exception's message reaches the subject record. The finish time
    is the newest modification time in milliseconds among the detector's
    artifacts, so a subject whose output was imported or produced by an
    earlier session still shows when it last changed.
    """
    try:
        status = adapter.detect(cfg, subject_id)
    except Exception as exc:
        return "pending", type(exc).__name__, None
    state = _STATE_MAP.get(status.state, "pending")
    finished_at = (
        _artifacts_modified_ms(list(getattr(status, "artifacts", []) or []))
        if state == "done"
        else None
    )
    return state, None, finished_at


def _artifacts_modified_ms(artifacts: list[str]) -> int | None:
    """Return the newest artifact modification time in epoch milliseconds."""
    newest: float | None = None
    for path in artifacts:
        try:
            modified = os.stat(path).st_mtime
        except OSError:
            continue
        if newest is None or modified > newest:
            newest = modified
    return None if newest is None else int(newest * 1000)


def _cohort_members(cfg: dict[str, Any]) -> dict[str, frozenset[str] | None]:
    """Read each adapter's current cohort-output membership once per discovery.

    A cohort-wide detector answers for the output as a whole, so its ``done``
    state would otherwise paint every discovered subject green after a run on
    a smaller cohort. Cache the id sets here so one discovery reads each table
    once instead of once per subject.

    A cohort step whose output lists no subjects, such as the R analysis result
    tables, covers at most the subjects its cohort inputs list, so it takes
    their common membership; otherwise a subject added after R analysis ran
    reads as done there.
    """
    members: dict[str, frozenset[str] | None] = {}
    for key in _ADAPTER_ORDER:
        adapter = ADAPTERS.get(key)
        if adapter is None:
            continue
        try:
            members[key] = adapter.members(cfg)
        except Exception:  # Membership is advisory.
            members[key] = None
        if members[key] is None and STEP_SCOPES.get(key) == "cohort":
            members[key] = _input_members(key, members)
    members[_NORM_COLUMN] = _norm_participants(cfg)
    return members


def _input_members(
    key: str, members: dict[str, frozenset[str] | None]
) -> frozenset[str] | None:
    """Return the subjects every cohort input of ``key`` lists, if all are known."""
    inputs = STEP_DEPENDENCIES.get(key, ())
    known = [members.get(dependency) for dependency in inputs]
    if not inputs or any(
        STEP_SCOPES.get(dependency) != "cohort" or listed is None
        for dependency, listed in zip(inputs, known, strict=True)
    ):
        return None
    return frozenset.intersection(*(listed for listed in known if listed is not None))


def _norm_participants(cfg: dict[str, Any]) -> frozenset[str] | None:
    """Return the BrainCharts subjects of a site the model adapted to.

    A subject of a refused site gets no z-scores, so its Norm cell reads
    skipped while the stage itself is done for it. ``None`` when the split
    is unreadable, which leaves every Norm cell as the stage state.
    """
    adapter = ADAPTERS.get("braincharts")
    if adapter is None:
        return None
    try:
        roles = adapter.roles(adapter.out_dir(cfg))  # type: ignore[attr-defined]
    except Exception:  # Membership is advisory.
        return None
    return frozenset(
        subject_id for subject_id, (role, _site) in roles.items() if role != "refused"
    )


def _subject_record(  # noqa: PLR0913
    cfg: dict[str, Any],
    subject_id: str,
    registry_record: dict[str, Any] | None = None,
    qc_record: dict[str, Any] | None = None,
    *,
    t1_availability: str = "available",
    unavailable_reason: str | None = None,
    cohort_members: dict[str, frozenset[str] | None] | None = None,
    held_site: str | None = None,
) -> dict[str, Any]:
    """Build one Subject dict with ten detector-filled cells.

    Run each adapter's :meth:`detect` once and use it for both the matrix cells
    (map it to the columns it advances and let later producers win a shared
    column) and the precise per-step ``stepStates`` map. Let the renderer's
    cross-step dependency gate read ``stepStates`` so a later producer never
    masks an earlier prerequisite. Demote a cohort step's ``done`` to
    ``pending`` for a subject the current cohort output does not list, using
    ``cohort_members`` (read on demand when absent).
    """
    cells = [_empty_cell() for _ in MATRIX_COLUMNS]
    index = {key: pos for pos, key in enumerate(MATRIX_COLUMNS)}
    step_states: dict[str, str] = {}
    integrity_errors: list[str] = []
    if cohort_members is None:
        cohort_members = _cohort_members(cfg)

    for key in _ADAPTER_ORDER:
        adapter = ADAPTERS.get(key)
        if adapter is None:
            continue
        state, detector_error, finished_at = _detect_state_with_error(
            adapter, cfg, subject_id
        )
        members = cohort_members.get(key)
        if state == "done" and members is not None and subject_id not in members:
            state = "pending"
            finished_at = None
        step_states[key] = state
        if detector_error is not None:
            descriptor = STEP_BY_KEY.get(key)
            stage = str(descriptor["name"]) if descriptor else key
            integrity_errors.append(f"The {stage} detector failed ({detector_error}).")
        for column in adapter.advances or _DISPLAY_ADVANCES.get(key, ()):
            pos = index.get(column)
            if pos is None:
                continue
            cell = cells[pos]
            participants = cohort_members.get(column)
            if (
                state == "done"
                and column == _NORM_COLUMN
                and participants is not None
                and subject_id not in participants
            ):
                cell["st"] = "skipped"
                continue
            cell["st"] = state
            if state == "done":
                cell["rc"] = 0
                cell["finishedAt"] = finished_at

    record = registry_record or {}
    qc_value = qc_record or {}
    recorded_verdict = qc_value.get("verdict")
    if recorded_verdict not in {"pass", "fail", "defer"}:
        recorded_verdict = None
    verdict = effective_qc_verdict(qc_value)
    role = str(record.get("cohortRole", "ambiguous"))
    cohort = {
        "healthy": "CTRL",
        "sci-no-neuropathic-pain": "SCI_nNP",
        "sci-neuropathic-pain": "SCI_P",
    }.get(role, "UNKNOWN")
    return {
        "id": subject_id,
        # An unregistered subject, and a registered one whose age at scan was
        # never captured, both report a null age rather than a fabricated 0.
        "age": record.get("age"),
        "sex": record.get("sex", "O"),
        "registered": registry_record is not None,
        "cohort": cohort,
        "ais": record.get("ais"),
        "tSinceSci": record.get("tSinceSci"),
        "cells": cells,
        "stepStates": step_states,
        "qc": None if verdict == "unreviewed" else verdict,
        "recordedQcVerdict": recorded_verdict,
        "qcReviewEvidencePresent": qc_value.get("reviewEvidence") is not None,
        "notes": str(qc_value.get("note", "")),
        "qcTags": list(qc_value.get("tags", [])),
        "qcRevision": int(qc_value.get("revision", 0)),
        "sourceCohortLabel": record.get("sourceCohortLabel", ""),
        "cohortRole": role,
        # The registry site, or None when unset (the key is absent). An
        # unregistered subject reports the site held for its registration.
        "site": record.get("site") if registry_record is not None else held_site,
        "t1Availability": t1_availability,
        "analysisEligible": verdict != "fail" and t1_availability == "available",
        "unavailableReason": unavailable_reason,
        "integrityErrors": integrity_errors,
    }


def _refresh_one(params: list[Any], _emit: Emitter) -> dict[str, Any]:
    """Re-detect one subject's matrix cells (handler for ``subjects.refreshOne``).

    Accept ``[cfg, id]``. Return the same Subject shape as
    ``subjects.discover`` for a single id, so the renderer can refresh one row
    after a step completes without re-discovering the whole cohort.
    """
    cfg = params[0] if params and isinstance(params[0], dict) else {}
    subject_id = str(params[1]) if len(params) > 1 else ""
    resolutions = discover_t1_resolutions(cfg)
    resolution = next(
        (row for row in resolutions if row.subject_id == subject_id),
        None,
    )
    if resolution is None:
        raise ValueError("Select a subject from the configured cohort.")
    project_root = str(cfg.get("paths", {}).get("projectRoot", ""))
    store = RegistryStore(project_root)
    registry = {row["subjectId"]: row for row in store.list(cfg)}
    qc = load_qc_records(cfg)
    return _subject_record(
        _detector_cfg(cfg, resolutions),
        subject_id,
        registry.get(subject_id),
        qc.get(subject_id),
        t1_availability=(
            "available"
            if resolution.state == "resolved"
            else "missing"
            if resolution.state == "missing"
            else "ambiguous"
        ),
        unavailable_reason=(
            None
            if resolution.state == "resolved"
            else "Provide a T1 input matching the configured pattern."
            if resolution.state == "missing"
            else "Select one safe T1 input matching the configured pattern."
        ),
        held_site=store.pending_sites().get(subject_id),
    )


# -- Environment + provisioning -------------------------------------------------


def _request(params: list[Any]) -> dict[str, Any]:
    """Return the single object request required by project-scoped RPCs."""
    if len(params) != 1 or not isinstance(params[0], dict):
        raise ValueError("Provide exactly one request object.")
    return params[0]


def _env_check(
    params: list[Any], _emit: Emitter, workflow: WorkflowManager
) -> dict[str, Any]:
    """Run every env probe and return an ``EnvReport`` (handler for ``env.check``).

    Accept one explicit project/config request, or a host-scoped request that
    carries no project: the read-only probes then run with an empty config and
    project-scoped checks report as skipped. Retain only matching checks and
    drop empty groups when ``ids`` is given.
    """
    request = _request(params)
    cfg = request.get("cfg") if isinstance(request.get("cfg"), dict) else {}
    validate_config_revision(request.get("configRevision", 0))
    if request.get("project") is not None:
        workflow.project_epochs.validate(request.get("project"), cfg)
    ids = request.get("ids") if isinstance(request.get("ids"), list) else None
    return env.check(cfg, ids)


def _env_opt_in_install(
    params: list[Any],
    _emit: Emitter,
    workflow: WorkflowManager,
    installs: EnvInstallManager,
) -> dict[str, str]:
    """Start a check's gated installer (handler for ``env.optInInstall``).

    Require the check id, project identity, config revision, authorization, and
    exact config used to resolve the installer. Return the started operation's
    identity and report its lifecycle through ``envInstall.progress``. Apply all
    safety gating in :func:`env.opt_in_install`.
    """
    request = _request(params)
    cfg = request.get("cfg") if isinstance(request.get("cfg"), dict) else {}
    revision = validate_config_revision(request.get("configRevision", 0))
    project = workflow.project_epochs.validate(request.get("project"), cfg)
    workflow.authorizations.consume(
        request.get("authorization"),
        project_id=project.project_id,
        config_revision=revision,
        purpose="opt-in-install",
    )
    return installs.start(project, str(request.get("checkId", "")), cfg)


def _env_install_status(
    params: list[Any],
    _emit: Emitter,
    workflow: WorkflowManager,
    installs: EnvInstallManager,
) -> dict[str, Any]:
    """Return retained installations (handler for ``env.installStatus``).

    Require the explicit project identity so a remounting renderer reattaches
    only to the installations of its own project generation.
    """
    request = _request(params)
    project = workflow.project_epochs.validate(request.get("project"))
    return installs.status(project)


def _env_create_output_dir(
    params: list[Any], _emit: Emitter, workflow: WorkflowManager
) -> dict[str, Any]:
    """Create one output parent by check id (handler for ``env.createOutputDir``).

    Require the check id, project identity, config revision, one-use
    opt-in-install authorization, and exact config from which the target path
    is derived. Never accept a path from the caller; apply the closed-set and
    filesystem gating in :func:`env.create_output_dir`.
    """
    request = _request(params)
    cfg = request.get("cfg") if isinstance(request.get("cfg"), dict) else {}
    revision = validate_config_revision(request.get("configRevision", 0))
    project = workflow.project_epochs.validate(request.get("project"), cfg)
    workflow.authorizations.consume(
        request.get("authorization"),
        project_id=project.project_id,
        config_revision=revision,
        purpose="opt-in-install",
    )
    return env.create_output_dir(str(request.get("checkId", "")), cfg)


def _env_tool_status(
    params: list[Any], _emit: Emitter, workflow: WorkflowManager
) -> dict[str, Any]:
    """Return the top-bar tool-status summary (handler for ``env.toolStatus``).

    Require the explicit project identity and config whose summary is requested.
    Ignore ambient state from prior environment calls.
    """
    request = _request(params)
    cfg = request.get("cfg") if isinstance(request.get("cfg"), dict) else {}
    validate_config_revision(request.get("configRevision", 0))
    workflow.project_epochs.validate(request.get("project"), cfg)
    return env.tool_status(cfg)


def _provision_pybrainage(params: list[Any], emit: Emitter) -> dict[str, Any]:
    """Execute PyBrainAge first-run provisioning, streaming ``provision.progress``.

    Accept ``[opts]`` with ``cfg`` and an optional ``sha256`` override. Use the
    pinned :data:`PYBRAINAGE_ZENODO_SHA256` when absent. Run the PyBrainAge plan
    to completion with the bundled-preferred resolved micromamba executable,
    pip-only dependency, pinned Zenodo fetch, SHA-256 verification, stdlib
    extraction, and pickle-load validation. Emit one ``provision.progress``
    notification per step. Require Allow live runs and renderer confirmation.

    Returns
    -------
    dict
        Return ``{"jobId": ..., "ok": bool}`` per the renderer contract.
    """
    opts = params[0] if params and isinstance(params[0], dict) else {}
    cfg = opts.get("cfg") if isinstance(opts.get("cfg"), dict) else {}
    requested_sha = opts.get("sha256")
    if requested_sha not in (None, "", pybrainage.PYBRAINAGE_ZENODO_SHA256):
        raise ValueError("Keep the PyBrainAge archive SHA-256 unchanged.")
    sha256 = pybrainage.PYBRAINAGE_ZENODO_SHA256
    job_id = f"#{uuid.uuid4().hex[:8]}"

    def progress_cb(message: str, fraction: float) -> None:
        percent = max(0, min(100, round(fraction * 100)))
        phase = "done" if fraction >= 1.0 else "env" if fraction <= 0.0 else "download"
        emit.emit(
            "provision.progress",
            {"jobId": job_id, "phase": phase, "percent": percent, "message": message},
        )

    try:
        result = pybrainage.execute_provision(cfg, progress_cb, expected_sha256=sha256)
    except Exception as exc:
        emit.emit(
            "provision.progress",
            {"jobId": job_id, "phase": "error", "percent": None, "message": str(exc)},
        )
        return {"jobId": job_id, "ok": False}
    if not result["ok"]:
        emit.emit(
            "provision.progress",
            {
                "jobId": job_id,
                "phase": "error",
                "percent": None,
                "message": result["message"],
            },
        )
    return {"jobId": job_id, "ok": result["ok"]}


def _provision_status(params: list[Any], _emit: Emitter) -> dict[str, Any]:
    """Report whether the provisioned PyBrainAge environment and model exist.

    Accept optional ``[opts]`` carrying ``cfg`` to resolve the environment prefix
    and model root. Return an all-false status without config. Never open, read,
    or hash files during presence checks.
    """
    opts = params[0] if params and isinstance(params[0], dict) else {}
    cfg = opts.get("cfg") if isinstance(opts.get("cfg"), dict) else {}
    if not cfg:
        return {
            "envReady": False,
            "modelReady": False,
            "pythonExecutable": None,
            "modelPath": None,
        }

    python_exe = os.path.join(pybrainage.env_dir(cfg), "bin", "python")
    root = pybrainage.model_root(cfg)
    model_path = os.path.join(root, "software", pybrainage.PYBRAINAGE_MODEL_FILE)
    scaler_path = os.path.join(root, "software", pybrainage.PYBRAINAGE_SCALER_FILE)

    env_ready = os.path.exists(python_exe)
    model_ready = os.path.exists(model_path) and os.path.exists(scaler_path)
    return {
        "envReady": env_ready,
        "modelReady": model_ready,
        "pythonExecutable": python_exe if env_ready else None,
        "modelPath": model_path if model_ready else None,
    }


def _handshake(params: list[Any], workflow: WorkflowManager) -> dict[str, Any]:
    request = params[0] if params and isinstance(params[0], dict) else {}
    protocol = str(request.get("protocolVersion", "1"))
    if protocol != "1":
        raise ValueError("Use a supported protocol version.")
    product_version = request.get("productVersion")
    if not isinstance(product_version, str) or product_version != __version__:
        raise ValueError("Use a supported product version.")
    workflow.attach_supervisor_generation(request.get("generation"))
    attached = workflow.project_epochs.attached()
    return {
        "productVersion": __version__,
        "protocolVersion": "1",
        "persistenceVersions": {
            "project": 1,
            "runState": 1,
            "manifest": 1,
            "receipt": 1,
        },
        "capabilities": [
            "workflow-v1",
            "run-store-v1",
            "project-identity-v1",
            "runtime-events-v1",
            "artifact-resolution-v1",
            "cancellable-provision-v1",
            "input-fov-review-v1",
            "managed-scientific-resources-v1",
            "cohort-analysis-v1",
            "cohort-analysis-v2",
            "atlas-labeling-v1",
        ],
        "runtimeId": workflow.runtime_id,
        "sidecarGeneration": workflow.sidecar_generation,
        "supervisorGeneration": request.get("generation"),
        "projectAttached": bool(attached),
        "attachedProjects": attached,
    }


def build_dispatcher(emitter: Emitter) -> Dispatcher:  # noqa: PLR0915
    """Construct a dispatcher with every handler registered.

    Use the :data:`ADAPTERS` registry populated by importing
    :mod:`supraspina_sidecar.adapters`. Resolve each step through its adapter. Route
    scientific execution through
    :class:`~supraspina_sidecar.workflow_manager.WorkflowManager`.
    """
    authorizations = AuthorizationLedger()
    workflow = WorkflowManager(emitter, authorizations=authorizations)
    provision = ProvisionManager(
        emitter,
        workflow.project_epochs,
        authorizations,
        workflow,
    )
    env_installs = EnvInstallManager(emitter)
    input_fov = InputFovReviewManager(workflow.project_epochs)
    surface_registration = SurfaceRegistrationManager(workflow.project_epochs)
    group_analysis = GroupAnalysisManager(
        workflow.project_epochs,
        registration_status=surface_registration.status,
    )
    atlas_labeling = AtlasLabelingManager(workflow.project_epochs)
    results = ResultInventory(workflow.project_epochs, input_fov_reviews=input_fov)
    managed_resources = ManagedResourceManager(
        emitter,
        workflow.project_epochs,
        authorizations,
    )
    workflow.set_provision_status_provider(provision.bootstrap_status)
    workflow.project_epochs.set_switch_guard(
        lambda: (
            workflow.active_counts() == (0, 0)
            and provision.active_count() == 0
            and managed_resources.active_count() == 0
        )
    )
    debug = DebugBundleManager(workflow.project_epochs, results)
    dispatcher = Dispatcher(emitter)
    package_smoke_clinical = None
    if os.environ.get("SUPRASPINA_PACKAGE_SMOKE") == "1":
        from .package_smoke_clinical import (  # noqa: PLC0415
            ClinicalPackageSmoke,
        )

        package_smoke_clinical = ClinicalPackageSmoke()
    dispatcher.register("ping", lambda _p, _e: "pong")
    # The stdin reader thread answers this probe (see rpc.IMMEDIATE_METHODS)
    # while the main thread may be running a slow handler, so keep it free of
    # shared state.
    dispatcher.register(LIVENESS_METHOD, lambda _p, _e: "alive")
    dispatcher.register("system.handshake", lambda p, _e: _handshake(p, workflow))

    def shutdown(params: list[Any], _emit: Emitter) -> dict[str, Any]:
        request = params[0] if params and isinstance(params[0], dict) else {}
        timeout = max(0.1, min(float(request.get("timeoutMs", 10_000)) / 1000, 30.0))
        deadline = time.monotonic() + timeout
        surface_registration.stop_all(timeout=min(timeout, 2.0))
        group_analysis.stop_all(timeout=min(timeout, 2.0))
        atlas_labeling.stop_all(timeout=min(timeout, 2.0))
        managed_resources.shutdown(timeout=min(timeout, 5.0))
        provision.shutdown(timeout=min(timeout, 5.0))
        env_installs.shutdown(timeout=min(timeout, 5.0))
        active_provisioning = provision.active_count()
        active_managed_resources = managed_resources.active_count()
        result = workflow.shutdown(timeout=max(0.0, deadline - time.monotonic()))
        if package_smoke_clinical is not None:
            package_smoke_clinical.cleanup_all(workflow)
        result["activeProvisioning"] = active_provisioning
        result["activeManagedResources"] = active_managed_resources
        return result

    dispatcher.register("system.shutdown", shutdown)
    dispatcher.register(
        "system.acceptProcessClaim",
        lambda p, _e: workflow.accept_process_claim(_request(p)),
    )

    def detach_project(params: list[Any], _emit: Emitter) -> dict[str, bool]:
        request = _request(params)
        raw = request.get("project")
        if not isinstance(raw, dict):
            raise ValueError("Provide a project reference.")
        project_id = str(raw.get("projectId", ""))
        try:
            workflow.reconcile_project_ownership(raw)
            provision.reconcile_project_ownership(raw)
        except ProjectIdentityError:
            # A reference that cannot attach owns no live work in this
            # sidecar generation, because it repeats an already answered
            # detach or carries a superseded epoch. Let detach() choose
            # between the idempotent answer and an identity mismatch.
            return {
                "detached": workflow.project_epochs.detach(raw),
                "projectAttached": bool(workflow.project_epochs.attached()),
            }
        if (
            workflow.project_active(project_id)
            or provision.project_active(project_id)
            or managed_resources.active_count() > 0
        ):
            raise ValueError(
                "Wait for active scientific work to finish before detaching "
                "the project."
            )
        detached = workflow.project_epochs.detach(raw)
        # The registration check and the analysis are advisory: stop them
        # rather than wait for them.
        surface_registration.stop_all()
        group_analysis.stop_all()
        atlas_labeling.stop_all()
        return {
            "detached": detached,
            "projectAttached": bool(workflow.project_epochs.attached()),
        }

    dispatcher.register("system.detachProject", detach_project)
    dispatcher.register("schema.validate", _validate)
    dispatcher.register("project.validate", _project_validate)
    dispatcher.register("pipeline.listSteps", _list_steps)
    dispatcher.register("pipeline.previewCommand", _preview_command)
    dispatcher.register(
        "pipeline.planWorkflow", lambda p, _e: workflow.plan(_request(p))
    )
    dispatcher.register("pipeline.runWorkflow", lambda p, _e: workflow.run(_request(p)))
    dispatcher.register(
        "pipeline.resumeWorkflow",
        lambda p, _e: workflow.resume(_request(p), retry=False),
    )
    dispatcher.register(
        "pipeline.retryWorkflow",
        lambda p, _e: workflow.resume(_request(p), retry=True),
    )
    dispatcher.register(
        "pipeline.cancelRun", lambda p, _e: workflow.cancel_run(_request(p))
    )

    def discover(params: list[Any], emit: Emitter) -> list[dict[str, Any]]:
        request = _request(params)
        cfg = request.get("cfg") if isinstance(request.get("cfg"), dict) else {}
        validate_config_revision(request.get("configRevision", 0))
        workflow.project_epochs.validate(request.get("project"), cfg)
        return _discover([cfg], emit)

    def refresh(params: list[Any], emit: Emitter) -> dict[str, Any]:
        request = _request(params)
        cfg = request.get("cfg") if isinstance(request.get("cfg"), dict) else {}
        validate_config_revision(request.get("configRevision", 0))
        workflow.project_epochs.validate(request.get("project"), cfg)
        return _refresh_one([cfg, request.get("subjectId", "")], emit)

    dispatcher.register("subjects.discover", discover)
    dispatcher.register("subjects.refreshOne", refresh)
    dispatcher.register("inputFov.list", lambda p, _e: input_fov.list(_request(p)))
    dispatcher.register(
        "inputFov.review",
        lambda p, _e: input_fov.review(_request(p)),
    )
    if package_smoke_clinical is not None:
        dispatcher.register(
            "system.packageSmokeClinicalSetup",
            lambda _p, _e: package_smoke_clinical.setup(),
        )
        dispatcher.register(
            "system.packageSmokeClinicalCase",
            lambda p, _e: package_smoke_clinical.apply_case(_request(p)),
        )
        dispatcher.register(
            "system.packageSmokeClinicalExecute",
            lambda p, _e: package_smoke_clinical.execute(_request(p), workflow),
        )
        dispatcher.register(
            "system.packageSmokeClinicalExecutionStatus",
            lambda p, _e: package_smoke_clinical.execution_status(_request(p)),
        )
        dispatcher.register(
            "system.packageSmokePybrainageExecute",
            lambda p, _e: package_smoke_clinical.execute_pybrainage(_request(p)),
        )
        dispatcher.register(
            "system.packageSmokeClinicalCleanup",
            lambda p, _e: package_smoke_clinical.cleanup(_request(p), workflow),
        )
    dispatcher.register("env.check", lambda p, e: _env_check(p, e, workflow))
    dispatcher.register(
        "env.optInInstall",
        lambda p, e: _env_opt_in_install(p, e, workflow, env_installs),
    )
    dispatcher.register(
        "env.installStatus",
        lambda p, e: _env_install_status(p, e, workflow, env_installs),
    )
    dispatcher.register(
        "env.createOutputDir", lambda p, e: _env_create_output_dir(p, e, workflow)
    )
    dispatcher.register("env.toolStatus", lambda p, e: _env_tool_status(p, e, workflow))
    dispatcher.register(
        "provision.pybrainage", lambda p, _e: provision.start(_request(p))
    )
    # The request carries licenseAccepted: true once the operator accepted the
    # GPL-3.0 notice; progress arrives through provision.progress and
    # provision.log, and provision.cancel stops it, as for PyBrainAge.
    dispatcher.register(
        "provision.braincharts",
        lambda p, _e: provision.start(_request(p), kind="braincharts"),
    )

    def provision_managed(
        params: list[Any],
        resource: str,
    ) -> dict[str, str]:
        request = _request(params)
        if request.get("resource") != resource:
            raise ValueError("Match the managed-resource provision method identity.")
        if resource == "synthstrip" and request.get("variant") != "cpu":
            raise ValueError("Use the CPU variant for SynthStrip provisioning.")
        if resource == "fastsurfer" and request.get("variant") not in {
            "cpu",
            "cuda",
        }:
            raise ValueError("Select a valid FastSurfer provisioning variant.")
        return managed_resources.provision(request)

    dispatcher.register(
        "provision.synthstrip",
        lambda p, _e: provision_managed(p, "synthstrip"),
    )
    dispatcher.register(
        "provision.fastsurfer",
        lambda p, _e: provision_managed(p, "fastsurfer"),
    )
    dispatcher.register("provision.status", lambda p, _e: provision.status(_request(p)))
    dispatcher.register("provision.cancel", lambda p, _e: provision.cancel(_request(p)))
    dispatcher.register(
        "managedResource.status",
        lambda p, _e: managed_resources.status(_request(p)),
    )
    dispatcher.register(
        "managedResource.cancel",
        lambda p, _e: managed_resources.cancel(_request(p)),
    )
    dispatcher.register(
        "managedResource.importOffline",
        lambda p, _e: managed_resources.import_offline(_request(p)),
    )
    dispatcher.register(
        "runtime.bootstrap", lambda p, _e: workflow.bootstrap(_request(p))
    )
    dispatcher.register(
        "manifest.forRun",
        lambda p, _e: workflow.manifest_for_run(
            _request(p).get("project", {}), str(_request(p).get("runId", ""))
        ),
    )

    def manifest_list(params: list[Any], _emit: Emitter) -> dict[str, Any]:
        request = _request(params)
        return workflow.manifest_list(
            request.get("project", {}),
            request.get("cursor"),
            int(request.get("limit", 50)),
        )

    dispatcher.register("manifest.list", manifest_list)
    dispatcher.register(
        "manifest.previewDebug", lambda p, _e: debug.preview(_request(p))
    )
    dispatcher.register("manifest.bundleDebug", lambda p, _e: debug.bundle(_request(p)))
    dispatcher.register("results.list", lambda p, _e: results.list(_request(p)))
    dispatcher.register(
        "results.resolveArtifact", lambda p, _e: results.resolve(_request(p))
    )
    dispatcher.register(
        "results.qcGalleryImages", lambda p, _e: results.gallery_images(_request(p))
    )
    dispatcher.register(
        "surfaceRegistration.status",
        lambda p, _e: surface_registration.status(_request(p)),
    )
    dispatcher.register(
        "surfaceRegistration.check",
        lambda p, _e: surface_registration.check(_request(p)),
    )
    dispatcher.register(
        "surfaceRegistration.cancel",
        lambda p, _e: surface_registration.cancel(_request(p)),
    )

    for method, handler in (
        ("groupAnalysis.catalog", group_analysis.catalog),
        ("groupAnalysis.inputs", group_analysis.inputs),
        ("groupAnalysis.start", group_analysis.start),
        ("groupAnalysis.status", group_analysis.status),
        ("groupAnalysis.cancel", group_analysis.cancel),
        ("groupAnalysis.list", group_analysis.list),
        ("groupAnalysis.result", group_analysis.result),
        ("groupAnalysis.measureDetail", group_analysis.measure_detail),
        ("groupAnalysis.saveSpec", group_analysis.save_spec),
        ("groupAnalysis.deleteSpec", group_analysis.delete_spec),
        ("groupAnalysis.saveSet", group_analysis.save_set),
        ("groupAnalysis.lockSet", group_analysis.lock_set),
        ("groupAnalysis.deleteSet", group_analysis.delete_set),
        ("groupAnalysis.termRows", group_analysis.term_rows),
        ("groupAnalysis.atlases", atlas_labeling.atlases),
        ("groupAnalysis.labelStart", atlas_labeling.label_start),
        ("groupAnalysis.labelStatus", atlas_labeling.label_status),
        ("groupAnalysis.labelCancel", atlas_labeling.label_cancel),
        ("groupAnalysis.clearLabels", atlas_labeling.clear_labels),
        # Main-internal: main calls these after its own dialogs, or while
        # writing an export.
        ("groupAnalysis.exportData", group_analysis.export_data),
        ("groupAnalysis.pinResult", group_analysis.pin_result),
        ("groupAnalysis.importVariables", group_analysis.import_variables),
        ("groupAnalysis.deleteVariables", group_analysis.delete_variables),
        ("groupAnalysis.importAtlas", atlas_labeling.import_atlas),
        ("groupAnalysis.importAtlasLabels", atlas_labeling.import_atlas_labels),
    ):
        dispatcher.register(
            method,
            lambda p, _e, handler=handler: handler(_request(p)),
        )

    def registry_list(params: list[Any], _emit: Emitter) -> list[dict[str, Any]]:
        request = _request(params)
        cfg = request.get("cfg") if isinstance(request.get("cfg"), dict) else None
        validate_config_revision(request.get("configRevision", 0))
        project = workflow.project_epochs.validate(request.get("project"), cfg)
        return RegistryStore(project.root).list(cfg)

    def registry_upsert(params: list[Any], _emit: Emitter) -> dict[str, Any]:
        request = _request(params)
        cfg = request.get("cfg") if isinstance(request.get("cfg"), dict) else None
        validate_config_revision(request.get("configRevision", 0))
        project = workflow.project_epochs.validate(request.get("project"), cfg)
        record = (
            request.get("record") if isinstance(request.get("record"), dict) else {}
        )
        return RegistryStore(project.root).upsert(
            record, request.get("expectedRevision")
        )

    def registry_import_csv(params: list[Any], _emit: Emitter) -> dict[str, Any]:
        request = _request(params)
        cfg = request.get("cfg") if isinstance(request.get("cfg"), dict) else None
        validate_config_revision(request.get("configRevision", 0))
        project = workflow.project_epochs.validate(request.get("project"), cfg)
        csv_text = request.get("csvText")
        if not isinstance(csv_text, str):
            raise ValueError("Provide the CSV text to import.")
        on_existing = request.get("onExisting")
        if on_existing not in {"skip", "update"}:
            raise ValueError("Choose skip or update for already-registered subjects.")
        return RegistryStore(project.root).import_csv(csv_text, on_existing)

    def registry_set_site(params: list[Any], _emit: Emitter) -> dict[str, Any]:
        request = _request(params)
        cfg = request.get("cfg") if isinstance(request.get("cfg"), dict) else None
        validate_config_revision(request.get("configRevision", 0))
        project = workflow.project_epochs.validate(request.get("project"), cfg)
        if "site" not in request:
            raise ValueError(SITE_LABEL_RULE)
        # The store validates the selection, revisions, and label before the
        # one atomic write.
        return RegistryStore(project.root).set_site(
            request.get("subjectIds"),
            request["site"],
            request.get("expectedRevisions"),
        )

    def registry_remove(params: list[Any], _emit: Emitter) -> None:
        request = _request(params)
        cfg = request.get("cfg") if isinstance(request.get("cfg"), dict) else None
        validate_config_revision(request.get("configRevision", 0))
        project = workflow.project_epochs.validate(request.get("project"), cfg)
        RegistryStore(project.root).remove(
            str(request.get("subjectId", "")), request.get("expectedRevision")
        )

    dispatcher.register("registry.list", registry_list)
    dispatcher.register("registry.upsert", registry_upsert)
    dispatcher.register("registry.importCsv", registry_import_csv)
    dispatcher.register("registry.remove", registry_remove)
    dispatcher.register("registry.setSite", registry_set_site)
    dispatcher.workflow_manager = workflow
    dispatcher.provision_manager = provision
    dispatcher.env_install_manager = env_installs
    dispatcher.input_fov_review_manager = input_fov
    dispatcher.surface_registration_manager = surface_registration
    dispatcher.group_analysis_manager = group_analysis
    dispatcher.atlas_labeling_manager = atlas_labeling
    dispatcher.managed_resource_manager = managed_resources
    dispatcher.package_smoke_clinical = package_smoke_clinical
    return dispatcher


def _load_openpyxl_without_numpy() -> None:
    """Load openpyxl with its optional NumPy probe refused.

    The Clinical detector reads the workbook with openpyxl in this process,
    and openpyxl imports NumPy when it can, which maps NumPy's OpenBLAS and
    its threads here although only the analysis worker computes with NumPy.
    Reading a workbook gives the same values either way. The refusal lasts
    only for this import, and a process that already holds NumPy or
    openpyxl is left alone.
    """
    if "numpy" in sys.modules or "openpyxl" in sys.modules:
        return
    sys.modules["numpy"] = None  # type: ignore[assignment]
    try:
        import openpyxl  # noqa: F401, PLC0415
    except ImportError:
        pass
    finally:
        if sys.modules.get("numpy", False) is None:
            del sys.modules["numpy"]


def main() -> None:
    """Run the sidecar JSON-RPC loop on stdio."""
    _load_openpyxl_without_numpy()
    emitter = Emitter(sys.stdout)
    dispatcher = build_dispatcher(emitter)
    try:
        serve(dispatcher)
    finally:
        for name in ("group_analysis_manager", "atlas_labeling_manager"):
            manager = getattr(dispatcher, name, None)
            if manager is not None:
                manager.stop_all()
        dispatcher.managed_resource_manager.shutdown()
        dispatcher.provision_manager.shutdown()
        dispatcher.env_install_manager.shutdown()
        dispatcher.workflow_manager.shutdown()
        package_smoke_clinical = getattr(dispatcher, "package_smoke_clinical", None)
        if package_smoke_clinical is not None:
            package_smoke_clinical.cleanup_all(dispatcher.workflow_manager)
        dispatcher.workflow_manager.project_epochs.detach_all()


if __name__ == "__main__":
    main()
