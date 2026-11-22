"""The ``groupAnalysis.*`` RPC surface and the compute lifecycle.

The manager mirrors ``SurfaceRegistrationManager``: main attaches the saved
configuration to every request; a request for another project stops the
running compute; one compute runs at a time. ``start`` validates and returns
at once; a manager thread snapshots the registry, QC, and registration rows,
then starts the worker (``worker.worker_command()``) in its own session.
``cancel`` kills the worker's process group. The compute is advisory: it is
not in the process-ownership ledger, the switch guard does not count it, and
detach and shutdown stop it rather than wait for it.

A stored result's currency compares what it recorded with the project now:
the digests of the tables its specification reads, the resolved sample, the
registry fields and registration flags it used, and the engine identity.
Each difference is one named stale reason with the subjects it added and
removed; a sample change is attributed to the exclusion reason that changed.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import secrets
import signal
import subprocess
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from .. import __version__
from ..build_identity import build_identity
from ..cohort import load_project_qc_records
from ..project import ProjectEpochs, ProjectIdentity
from ..registry_store import RegistryStore
from ..workflow import validate_config_revision
from . import (
    catalog,
    dataset,
    dataset_v2,
    export,
    result_detail,
    sources,
    store,
    worker,
)
from .identity import ENGINE_ID, ENGINE_ID_V2
from .spec import (
    GroupAnalysisError,
    GroupAnalysisSpec,
    GroupAnalysisSpecV2,
    parse_spec,
    spec_digest,
)

_REQUEST_KEYS = frozenset({"project", "cfg", "configRevision", "configSha256"})
_KEYS: dict[str, frozenset[str]] = {
    "catalog": _REQUEST_KEYS,
    "inputs": _REQUEST_KEYS | {"spec"},
    "start": _REQUEST_KEYS | {"spec", "stageCurrency"},
    "status": _REQUEST_KEYS,
    "cancel": _REQUEST_KEYS | {"operationId"},
    "list": _REQUEST_KEYS,
    "result": _REQUEST_KEYS | {"resultId"},
    "measureDetail": _REQUEST_KEYS | {"resultId", "measureId"},
    "saveSpec": _REQUEST_KEYS | {"specId", "name", "spec", "expectedRevision"},
    "deleteSpec": _REQUEST_KEYS | {"specId", "expectedRevision"},
    "saveSet": _REQUEST_KEYS | {"setId", "name", "measures", "expectedRevision"},
    "lockSet": _REQUEST_KEYS | {"setId", "expectedRevision"},
    "deleteSet": _REQUEST_KEYS | {"setId", "expectedRevision"},
    "exportData": _REQUEST_KEYS | {"resultId", "subjectCsv"},
    "pinResult": _REQUEST_KEYS | {"resultId"},
    "termRows": _REQUEST_KEYS | {"resultId", "termId", "offset"},
    "importVariables": _REQUEST_KEYS | {"path"},
    "deleteVariables": _REQUEST_KEYS | {"tableId"},
}
#: The optional fields a request may add to its exact fields.
_OPTIONAL_KEYS: dict[str, frozenset[str]] = {"measureDetail": frozenset({"termId"})}
TERM_ID = re.compile(r"term-[0-9]{1,4}")
#: The stage currency keys: v1 records, and v2 with the recon currency.
_CURRENCY_KEYS = (
    frozenset({"aggregate", "pybrainage"}),
    frozenset({"aggregate", "pybrainage", "recon"}),
)
_MAX_SUBJECTS = 5_000
_SUBJECT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
OPERATION_ID = re.compile(r"gan-[a-f0-9]{16}")
RESULT_ID = re.compile(r"gar-[a-f0-9]{16}")
_STAGE_STATES = frozenset({"current", "outdated", "unknown"})
MAX_RESULT_BYTES = 2 * 1024 * 1024
_MAX_LISTED = 64
_MAX_EVENT_BYTES = 64 * 1024
_MAX_NAME = 120
_STALE_ORDER = (
    "inputs-changed",
    "qc-changed-sample",
    "registry-changed",
    "registration-changed",
    "engine-changed",
    "sample-too-small",
    "labels-changed",
)
_REASON_CODES = {
    "qc-failed": "qc-changed-sample",
    "qc-not-passed": "qc-changed-sample",
    "registration-flagged": "registration-changed",
    "outlier": "inputs-changed",
    # A table change is inputs-changed; otherwise the fit lost its measures.
    "no-measures": "sample-too-small",
    "config-excluded": "registry-changed",
    "no-group": "registry-changed",
    "not-compared": "registry-changed",
    "missing-covariate": "registry-changed",
    "not-in-population": "registry-changed",
    "subset-filtered": "registry-changed",
    "missing-variable": "registry-changed",
}
_WORKER_EXITED = "The analysis worker stopped before it finished. Compute again."
_WORKER_UNSTARTED = "The analysis worker could not start."
_WORKER_FAILED = "The analysis stopped on an internal error. Compute again."
#: How long a killed worker may take to be reaped.
_REAP_SECONDS = 10.0
#: How long one list call judges results before leaving the rest to a
#: background thread; the RPC thread serves every other request meanwhile.
JUDGE_BUDGET_SECONDS = 0.15
#: The judgments kept by result and project state.
_JUDGED_LIMIT = 512
#: How long cancel waits for the compute thread to record the outcome.
_CANCEL_SETTLE_SECONDS = 2.0

#: Return the ``surfaceRegistration.status`` payload for one request.
RegistrationStatus = Callable[[dict[str, Any]], dict[str, Any]]
#: Start one worker from its argv.
Spawn = Callable[[list[str]], "subprocess.Popen[bytes]"]


@dataclass
class _Operation:
    operation_id: str
    project: ProjectIdentity
    spec_digest: str
    started_at: str
    state: str = "running"
    phase: str | None = "preparing"
    completed: int = 0
    total: int = 0
    message: str | None = None
    finished_at: str | None = None
    result_id: str | None = None
    #: The skip reasons of a compute in which no measure could be fit.
    skipped: list[dict[str, str]] | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    process: subprocess.Popen[bytes] | None = None
    thread: threading.Thread | None = None

    def public(self) -> dict[str, Any]:
        extra = {} if self.skipped is None else {"skipped": list(self.skipped)}
        return {
            "operationId": self.operation_id,
            "state": self.state,
            "phase": self.phase,
            "completed": self.completed,
            "total": self.total,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "message": self.message,
            "specDigest": self.spec_digest,
            "resultId": self.result_id,
            **extra,
        }


timestamp = store.timestamp


def _skipped_rows(value: Any) -> list[dict[str, str]] | None:
    """Keep the well-formed skip reasons of a failed worker event."""
    if not isinstance(value, list):
        return None
    return [
        {"measureId": row["measureId"], "reason": row["reason"][:512]}
        for row in value[: worker.MAX_SKIPPED]
        if isinstance(row, dict)
        and isinstance(row.get("measureId"), str)
        and isinstance(row.get("reason"), str)
        and row["reason"]
    ]


def _spawn_worker(argv: list[str]) -> subprocess.Popen[bytes]:
    return subprocess.Popen(  # noqa: S603 - the argv is worker_command().
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        env=worker.single_threaded_environment(dict(os.environ)),
    )


def _build_label() -> str | None:
    identity = build_identity()
    if identity["kind"] == "unknown":
        return None
    return identity["commit"] + ("-dirty" if identity["dirty"] else "")


def default_name(spec: GroupAnalysisSpec | GroupAnalysisSpecV2) -> str:
    """Name an unsaved specification's result after its contrast or tests."""
    if isinstance(spec, GroupAnalysisSpecV2):
        first = spec.tests[0].label
        more = len(spec.tests) - 1
        name = first if not more else f"{first} and {more} more"
        return name[:_MAX_NAME].rstrip()
    contrast = spec.contrast
    if contrast.type == "groups":
        name = f"{contrast.focal} vs {contrast.reference}"
        if spec.analysis == "brain-age":
            name = f"Brain-PAD, {name}"
    else:
        name = f"Association with {contrast.variable.column}"
    return name[:_MAX_NAME].rstrip()


def stage_currency(value: Any) -> dict[str, Any]:
    """Validate a renderer-supplied stage currency (v1 or v2).

    Parameters
    ----------
    value
        ``{aggregate, pybrainage}`` or, in v2, also ``recon`` with
        ``state`` and ``outdatedSubjectIds``.

    Returns
    -------
    dict
        The currency, unchanged.

    Raises
    ------
    GroupAnalysisError
        When a key or state is invalid.
    """
    if (
        not isinstance(value, dict)
        or set(value) not in _CURRENCY_KEYS
        or value["aggregate"] not in _STAGE_STATES
        or value["pybrainage"] not in _STAGE_STATES
    ):
        raise GroupAnalysisError("Send the aggregate and Brain-PAD stage currency.")
    if "recon" in value:
        recon = value["recon"]
        ids = recon.get("outdatedSubjectIds") if isinstance(recon, dict) else None
        if (
            not isinstance(recon, dict)
            or set(recon) != {"state", "outdatedSubjectIds"}
            or recon["state"] not in _STAGE_STATES
            or not isinstance(ids, list)
            or len(ids) > _MAX_SUBJECTS
            or not all(
                isinstance(item, str) and _SUBJECT_ID.fullmatch(item) for item in ids
            )
        ):
            raise GroupAnalysisError(
                "Send the reconstruction currency with valid subject IDs."
            )
    return value


def judge_currency(
    record: Mapping[str, Any],
    context: dataset.AnalysisContext,
    memo: dict[str, Any] | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Judge one stored result against the project now.

    Parameters
    ----------
    record
        A stored result (its per-subject detail may be absent).
    context
        The current project snapshot.
    memo
        Resolutions by specification digest, shared by the results one
        snapshot judges, so a specification is resolved once.

    Returns
    -------
    tuple of (str, list of dict)
        ``current``, ``stale``, or ``unknown``, and the
        ``GroupAnalysisStaleReason`` rows in contract order.
    """
    if record.get("schemaVersion") == 2:  # noqa: PLR2004
        return _judge_v2(record, context, {} if memo is None else memo)
    if record.get("schemaVersion") != 1:
        return "unknown", []
    reasons: dict[str, dict[str, Any]] = {}

    def add(code: str, *, added: int = 0, removed: int = 0, sources: Any = ()) -> None:
        entry = reasons.setdefault(
            code, {"code": code, "added": 0, "removed": 0, "sources": set()}
        )
        entry["added"] += added
        entry["removed"] += removed
        entry["sources"].update(sources)

    if record["engine"].get("id") != ENGINE_ID:
        add("engine-changed")
    spec = parse_spec(record["spec"])
    state = record["state"]
    memo = {} if memo is None else memo
    digest = spec_digest(spec)
    if digest not in memo:
        try:
            resolved: dict[str, Any] | None = dataset.resolve_inputs(context, spec)
        except GroupAnalysisError:
            resolved = None
        memo[digest] = (
            resolved,
            resolved["inputs"] if resolved else dataset.input_files(context),
            dataset.context_state(context, spec),
        )
    current, inputs, now_state = memo[digest]
    stored = {row["source"]: row["sha256"] for row in record["inputs"]}
    now = {row["source"]: row["sha256"] for row in inputs}
    changed = [s for s in state.get("usedSources", []) if stored.get(s) != now.get(s)]
    if changed:
        add("inputs-changed", sources=changed)
    registry_changed = now_state["registrySha256"] != state.get("registrySha256")
    registration_changed = now_state["registrationSha256"] != state.get(
        "registrationSha256"
    )
    if registry_changed:
        add("registry-changed")
    if registration_changed:
        add("registration-changed")
    if current is not None:
        _sample_flips(
            record["subjects"],
            current["subjects"],
            add,
            {
                "inputs-changed": bool(changed),
                "registry-changed": registry_changed,
                "registration-changed": registration_changed,
            },
        )
    rows = [
        {
            **reasons[code],
            "sources": [
                s for s in dataset.INPUT_SOURCES if s in reasons[code]["sources"]
            ],
        }
        for code in _STALE_ORDER
        if code in reasons
    ]
    if rows:
        return "stale", rows
    return ("current" if current is not None else "unknown"), []


def _source_order(source: str) -> tuple[int, str]:
    if source in dataset.INPUT_SOURCES:
        return (dataset.INPUT_SOURCES.index(source), "")
    return (len(dataset.INPUT_SOURCES), source)


def _changed_inputs(
    record: Mapping[str, Any],
    context: dataset.AnalysisContext,
    included: list[str],
) -> tuple[list[str], list[str]]:
    """Return a v2 result's changed input sources and changed label sources."""
    state = record["state"]
    reader = sources.ReconReader(context)
    tables = {row["source"]: row for row in dataset.input_files(context)}
    changed: list[str] = []
    relabeled: list[str] = []
    stored = {row["source"]: row["sha256"] for row in record["inputs"]}
    for source in state.get("usedSources", []):
        if source.startswith("labels:"):
            now = sources.labels_input(
                context.project_root, source.split(":", 1)[1], included
            )["sha256"]
            if stored.get(source) != now:
                relabeled.append(source)
            continue
        if source.startswith("stats:"):
            source_id = source.split(":", 1)[1]
            if source_id not in sources.TIER_A_SOURCES:
                continue
            now = sources.combined_digest(reader, source_id, included)["sha256"]
        elif source.startswith("variables:"):
            now = sources.table_input(context.project_root, source.split(":", 1)[1])[
                "sha256"
            ]
        else:
            now = tables.get(source, {}).get("sha256")
        if stored.get(source) != now:
            changed.append(source)
    return changed, relabeled


def _judge_v2(
    record: Mapping[str, Any],
    context: dataset.AnalysisContext,
    memo: dict[str, Any],
) -> tuple[str, list[dict[str, Any]]]:
    """Judge one stored v2 result against the project now.

    As v1, over the v2 inputs: the pipeline tables, one combined digest per
    tier A source over the result's included subjects (``stats:<id>``), and
    each imported table (``variables:<id>``).
    """
    reasons: dict[str, dict[str, Any]] = {}

    def add(code: str, *, added: int = 0, removed: int = 0, sources: Any = ()) -> None:
        entry = reasons.setdefault(
            code, {"code": code, "added": 0, "removed": 0, "sources": set()}
        )
        entry["added"] += added
        entry["removed"] += removed
        entry["sources"].update(sources)

    if record["engine"].get("id") != ENGINE_ID_V2:
        add("engine-changed")
    spec = parse_spec(record["spec"])
    if not isinstance(spec, GroupAnalysisSpecV2):
        return "unknown", []
    state = record["state"]
    digest = f"v2:{spec_digest(spec)}"
    if digest not in memo:
        try:
            resolved: dict[str, Any] | None = {
                "subjects": dataset_v2.resolve(context, spec).data.subjects
            }
        except GroupAnalysisError:
            resolved = None
        memo[digest] = (resolved, dataset_v2.context_state(context, spec))
    current, now_state = memo[digest]
    included = [row["subjectId"] for row in record["subjects"] if row["included"]]
    changed, relabeled = _changed_inputs(record, context, included)
    if changed:
        add("inputs-changed", sources=changed)
    if relabeled:
        add("labels-changed", sources=relabeled)
    registry_changed = now_state["registrySha256"] != state.get("registrySha256")
    registration_changed = now_state["registrationSha256"] != state.get(
        "registrationSha256"
    )
    if registry_changed:
        add("registry-changed")
    if registration_changed:
        add("registration-changed")
    if current is not None:
        _sample_flips(
            record["subjects"],
            current["subjects"],
            add,
            {
                "inputs-changed": bool(changed),
                "registry-changed": registry_changed,
                "registration-changed": registration_changed,
                "labels-changed": bool(relabeled),
            },
        )
    rows = [
        {
            **reasons[code],
            "sources": sorted(reasons[code]["sources"], key=_source_order),
        }
        for code in _STALE_ORDER
        if code in reasons
    ]
    if rows:
        return "stale", rows
    return ("current" if current is not None else "unknown"), []


def _sample_flips(
    before: list[Mapping[str, Any]],
    after: list[Mapping[str, Any]],
    add: Callable[..., None],
    digests: Mapping[str, bool],
) -> None:
    """Attribute each subject that entered or left the sample to one reason."""
    old = {row["subjectId"]: row for row in before}
    new = {row["subjectId"]: row for row in after}
    for subject_id in sorted(old.keys() | new.keys()):
        was = old.get(subject_id)
        now = new.get(subject_id)
        was_in = bool(was and was["included"])
        now_in = bool(now and now["included"])
        if was_in == now_in:
            if (
                was is not None
                and now is not None
                and was_in
                and was["missingHemispheres"] != now["missingHemispheres"]
            ):
                add("registration-changed")
            continue
        reason = (now if was_in else was) or {}
        code = _REASON_CODES.get(str(reason.get("reason")))
        if code == "sample-too-small" and digests["inputs-changed"]:
            code = "inputs-changed"
        if code is None or (
            code not in {"qc-changed-sample", "sample-too-small"} and not digests[code]
        ):
            code = next(
                (name for name, moved in digests.items() if moved),
                code or "registry-changed",
            )
        add(code, added=int(now_in), removed=int(was_in))


def _fingerprint(
    snapshot: dataset.AnalysisContext,
    records: list[Mapping[str, Any]] | None = None,
) -> str:
    """Digest everything a currency judgment reads from the project.

    The configuration, registry, QC records, registration rows, the engine
    identity, each input table's file identity (not its bytes), and, for the
    v2 records listed, the identity of every recon file and imported table
    their sources name.
    """
    used = sorted(
        {
            source
            for record in records or ()
            if record.get("schemaVersion") == 2  # noqa: PLR2004
            for source in (record.get("state") or {}).get("usedSources", [])
            if isinstance(source, str) and ":" in source
        }
    )
    state = {
        "v2": sources.inputs_signature(snapshot, used) if used else [],
        "cfg": snapshot.cfg,
        "registry": list(snapshot.registry),
        "qc": dict(snapshot.qc),
        "registration": list(snapshot.registration),
        "registrationKnown": snapshot.registration_known,
        "engine": ENGINE_ID,
        "tables": [
            dataset.table_signature(snapshot, source)
            for source in dataset.INPUT_SOURCES
        ],
    }
    text = json.dumps(state, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _fit_rows(public: dict[str, Any]) -> dict[str, Any]:
    """Keep the leading first-term rows of a v2 header that fit the cap."""
    rows = public["rows"]
    used = len(json.dumps({**public, "rows": []}, separators=(",", ":")))
    kept = 0
    for row in rows:
        used += len(json.dumps(row, separators=(",", ":"), allow_nan=False)) + 1
        if used > MAX_RESULT_BYTES:
            break
        kept += 1
    return {**public, "rows": rows[:kept]}


def summarize(
    record: Mapping[str, Any], currency: str, reasons: list[dict[str, Any]]
) -> dict[str, Any]:
    """Return the ``GroupAnalysisResultSummary`` of one stored result."""
    v1 = record["schemaVersion"] == 1
    return {
        "resultId": record["resultId"],
        "schemaVersion": record["schemaVersion"],
        "specId": record["specId"],
        "name": record["name"],
        "analysis": record["spec"]["analysis"] if v1 else None,
        "specDigest": record["specDigest"],
        "createdAt": record["createdAt"],
        "measureCount": (
            len(record["rows"]) if v1 else len(record["spec"]["measures"])
        ),
        "significantCount": sum(
            1 for row in record["rows"] if row.get("significant") is True
        ),
        "groups": record["sample"]["groups"],
        "provisional": bool(record["provisional"]),
        "pinned": bool(record["pinned"]),
        "currency": currency,
        "staleReasons": reasons,
    }


class GroupAnalysisManager:
    """Serve the analysis catalog, samples, computes, and the store."""

    def __init__(
        self,
        projects: ProjectEpochs,
        *,
        registration_status: RegistrationStatus | None = None,
        spawn: Spawn | None = None,
    ) -> None:
        """Bind the manager to the project ledger and its collaborators.

        Parameters
        ----------
        projects
            The process-wide project identity ledger.
        registration_status
            Read the surface-registration rows for the inclusion rules.
        spawn
            Start a worker; tests replace it.
        """
        self._projects = projects
        self._registration_status = registration_status
        self._spawn = spawn or _spawn_worker
        self._lock = threading.RLock()
        self._operation: _Operation | None = None
        # (result ID, result digest, project fingerprint) -> judgment.
        self._judged: OrderedDict[tuple[str, str, str], tuple[str, list[Any]]] = (
            OrderedDict()
        )
        # The background judge and the project state it judges.
        self._judging: tuple[threading.Thread, str] | None = None
        # The project state of the newest list; older background judges stop.
        self._latest: str | None = None

    # -- Requests ----

    def _context(
        self, request: Any, method: str
    ) -> tuple[ProjectIdentity, dataset.AnalysisContext]:
        allowed = _KEYS[method]
        optional = _OPTIONAL_KEYS.get(method, frozenset())
        if not isinstance(request, dict) or not (
            allowed <= set(request) <= allowed | optional
        ):
            raise GroupAnalysisError("Send a valid group-analysis request.")
        cfg = request.get("cfg")
        if not isinstance(cfg, dict):
            raise GroupAnalysisError("Send the saved project configuration.")
        revision = validate_config_revision(request.get("configRevision", 0))
        project = self._projects.validate(request.get("project"), cfg)
        self._cancel_foreign(project)
        return project, dataset.AnalysisContext(
            project_root=project.root, cfg=cfg, config_revision=revision
        )

    def _snapshot(
        self, context: dataset.AnalysisContext, request: Mapping[str, Any]
    ) -> dataset.AnalysisContext:
        """Add the registry, QC records, and registration rows to a context.

        Raises
        ------
        GroupAnalysisError
            When the registry or the QC store cannot be read.
        """
        try:
            registry = tuple(RegistryStore(context.project_root).list())
            qc = load_project_qc_records(context.project_root)
        except ValueError as exc:
            raise GroupAnalysisError(str(exc)) from exc
        rows: tuple[Mapping[str, Any], ...] = ()
        known = False
        if self._registration_status is not None:
            try:
                status = self._registration_status(
                    {key: request[key] for key in _REQUEST_KEYS}
                )
                rows = tuple(status["subjects"])
                known = True
            except Exception:  # An unreadable check reads as unjudged.
                rows, known = (), False
        return dataset.AnalysisContext(
            project_root=context.project_root,
            cfg=context.cfg,
            config_revision=context.config_revision,
            registry=registry,
            qc=qc,
            registration=rows,
            registration_known=known,
        )

    def catalog(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return the measure and variable catalog (``groupAnalysis.catalog``)."""
        project, context = self._context(request, "catalog")
        snapshot = self._snapshot(context, request)
        return {
            **catalog.build_catalog(snapshot),
            "variableTables": sources.list_variable_tables(
                project.root, sources.project_subjects(snapshot)
            ),
        }

    def inputs(self, request: dict[str, Any]) -> dict[str, Any]:
        """Resolve a draft's sample without computing (``groupAnalysis.inputs``)."""
        _project, context = self._context(request, "inputs")
        spec = parse_spec(request["spec"])
        snapshot = self._snapshot(context, request)
        if isinstance(spec, GroupAnalysisSpecV2):
            return dataset_v2.resolve_inputs(snapshot, spec)
        return dataset.resolve_inputs(snapshot, spec)

    def start(self, request: dict[str, Any]) -> dict[str, Any]:
        """Start a compute and return at once (``groupAnalysis.start``).

        A compute already running for this project is returned with
        ``started`` false; one for another project was stopped when this
        request attached.
        """
        project, context = self._context(request, "start")
        spec = parse_spec(request["spec"])
        currency = stage_currency(request["stageCurrency"])
        with self._lock:
            running = self._operation
            if running is not None and running.state == "running":
                if self._owns(running, project):
                    return {"operation": running.public(), "started": False}
                self._stop(running, "The project changed.")
            operation = _Operation(
                operation_id=f"gan-{secrets.token_hex(8)}",
                project=project,
                spec_digest=spec_digest(spec),
                started_at=timestamp(),
            )
            self._operation = operation
            thread = threading.Thread(
                target=self._run,
                args=(operation, context, dict(request), spec, dict(currency)),
                name="group-analysis",
                daemon=True,
            )
            operation.thread = thread
            thread.start()
        return {"operation": operation.public(), "started": True}

    def status(self, request: dict[str, Any]) -> dict[str, Any]:
        """Report the project's running or last compute."""
        project, _context = self._context(request, "status")
        with self._lock:
            operation = self._operation
            if operation is None or not self._owns(operation, project):
                return {"operation": None}
            return {"operation": operation.public()}

    def cancel(self, request: dict[str, Any]) -> dict[str, Any]:
        """Stop the project's running compute; a prior result stays.

        A worker that already wrote its result when the cancel arrived wins:
        the operation ends done with that result, and ``stopped`` is false.
        """
        project, _context = self._context(request, "cancel")
        operation_id = request["operationId"]
        if not isinstance(operation_id, str) or not OPERATION_ID.fullmatch(
            operation_id
        ):
            raise GroupAnalysisError("Send a valid analysis operation ID.")
        with self._lock:
            operation = self._operation
            if (
                operation is None
                or operation.operation_id != operation_id
                or not self._owns(operation, project)
                or operation.state != "running"
            ):
                return {"operationId": operation_id, "stopped": False}
            self._stop(operation, None)
        thread = operation.thread
        if thread is not None and thread is not threading.current_thread():
            # The killed worker's last event is read at once; wait for it.
            thread.join(_CANCEL_SETTLE_SECONDS)
        with self._lock:
            stopped = operation.state != "done"
        return {"operationId": operation_id, "stopped": stopped}

    def list(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return the library and every stored result with its currency.

        A result whose currency cannot be judged (the registry or QC store is
        unreadable, or its record no longer parses) is listed as ``unknown``.

        Judgments are kept by result and project state, so an unchanged
        project answers from memory. New ones are made newest first for at
        most ``JUDGE_BUDGET_SECONDS``; the rest are listed as ``unknown``
        while a background thread judges them for the next list, so this
        handler never holds the RPC thread for long.
        """
        project, context = self._context(request, "list")
        try:
            snapshot: dataset.AnalysisContext | None = self._snapshot(context, request)
        except GroupAnalysisError:
            snapshot = None
        records = store.list_results(project.root)[:_MAX_LISTED]
        results = []
        pending: list[Mapping[str, Any]] = []
        if snapshot is not None:
            fingerprint = _fingerprint(snapshot, records)
            with self._lock:
                self._latest = fingerprint
            deadline = time.monotonic() + JUDGE_BUDGET_SECONDS
            memo: dict[str, Any] = {}
            for record in records:
                judged = self._recall(record, fingerprint)
                if judged is None and time.monotonic() < deadline:
                    judged = self._judge(record, snapshot, fingerprint, memo)
                if judged is None:
                    pending.append(record)
                    judged = ("unknown", [])
                results.append(summarize(record, *judged))
            if pending:
                self._judge_later(snapshot, fingerprint, pending)
        else:
            results = [summarize(record, "unknown", []) for record in records]
        return {**store.load_library(project.root), "results": results}

    def _recall(
        self, record: Mapping[str, Any], fingerprint: str
    ) -> tuple[str, list[Any]] | None:
        key = (record["resultId"], record["resultSha256"], fingerprint)
        with self._lock:
            judged = self._judged.get(key)
            if judged is not None:
                self._judged.move_to_end(key)
            return judged

    def _judge(
        self,
        record: Mapping[str, Any],
        snapshot: dataset.AnalysisContext,
        fingerprint: str,
        memo: dict[str, Any],
    ) -> tuple[str, list[Any]]:
        judged: tuple[str, list[Any]] = ("unknown", [])
        with contextlib.suppress(GroupAnalysisError, KeyError, TypeError):
            judged = judge_currency(record, snapshot, memo)
        key = (record["resultId"], record["resultSha256"], fingerprint)
        with self._lock:
            self._judged[key] = judged
            while len(self._judged) > _JUDGED_LIMIT:
                self._judged.popitem(last=False)
        return judged

    def _judge_later(
        self,
        snapshot: dataset.AnalysisContext,
        fingerprint: str,
        records: list[Mapping[str, Any]],
    ) -> None:
        """Judge the records a list left unjudged on one background thread."""

        def judge() -> None:
            memo: dict[str, Any] = {}
            for record in records:
                with self._lock:
                    if self._latest != fingerprint:
                        return  # A newer list judges the newer state.
                if self._recall(record, fingerprint) is None:
                    self._judge(record, snapshot, fingerprint, memo)

        with self._lock:
            if (
                self._judging is not None
                and self._judging[0].is_alive()
                and self._judging[1] == fingerprint
            ):
                return
            thread = threading.Thread(
                target=judge, name="group-analysis-judge", daemon=True
            )
            self._judging = (thread, fingerprint)
            thread.start()

    def _stored(self, project: ProjectIdentity, result_id: Any) -> dict[str, Any]:
        if not isinstance(result_id, str) or not RESULT_ID.fullmatch(result_id):
            raise GroupAnalysisError("Send a valid analysis result ID.")
        record = store.read_result(project.root, result_id)
        if record is None:
            raise GroupAnalysisError("Select a stored analysis result.")
        return record

    def result(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return one stored result without per-subject values.

        A v2 header keeps as many of its first term's rows as fit the
        payload cap; ``termRows`` pages the rest.
        """
        project, _context = self._context(request, "result")
        public = store.public_result(self._stored(project, request["resultId"]))
        size = len(json.dumps(public, separators=(",", ":"), allow_nan=False))
        if size > MAX_RESULT_BYTES and public["schemaVersion"] != 1:
            public = _fit_rows(public)
            size = len(json.dumps(public, separators=(",", ":"), allow_nan=False))
        if size > MAX_RESULT_BYTES:
            raise GroupAnalysisError(
                "The result is larger than the panel shows; export it instead."
            )
        return public

    def term_rows(self, request: dict[str, Any]) -> dict[str, Any]:
        """Page one term's rows of a v2 result (``groupAnalysis.termRows``)."""
        project, _context = self._context(request, "termRows")
        term_id, offset = request["termId"], request["offset"]
        if not isinstance(term_id, str) or not TERM_ID.fullmatch(term_id):
            raise GroupAnalysisError("Send a valid result term ID.")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise GroupAnalysisError("Send a valid row offset.")
        record = self._stored(project, request["resultId"])
        return store.term_rows(record, term_id, offset)

    def measure_detail(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return one measure's row, adjusted group means, and subject values.

        With ``termId`` (a v2 result) the row is that term's, and the detail
        adds the fitted lines and simple slopes (``GroupAnalysisMeasureDetailV2``).
        """
        project, _context = self._context(request, "measureDetail")
        term_id = request.get("termId")
        if term_id is not None and (
            not isinstance(term_id, str) or not TERM_ID.fullmatch(term_id)
        ):
            raise GroupAnalysisError("Send a valid result term ID.")
        record = self._stored(project, request["resultId"])
        if record["schemaVersion"] != 1:
            return result_detail.measure_detail(record, term_id, request["measureId"])
        if term_id is not None:
            raise GroupAnalysisError("Select a term this result contains.")
        measure_id = request["measureId"]
        row = next(
            (item for item in record["rows"] if item["measureId"] == measure_id), None
        )
        if row is None:
            raise GroupAnalysisError("Select a measure this result contains.")
        entry = record["detail"].get("measures", {}).get(measure_id, {})
        return {
            "resultId": record["resultId"],
            "measureId": measure_id,
            "row": row,
            "groupMeans": list(entry.get("groupMeans", [])),
            "subjects": export.subject_rows(record, measure_id),
        }

    def save_spec(self, request: dict[str, Any]) -> dict[str, Any]:
        """Create or replace a saved specification."""
        project, _context = self._context(request, "saveSpec")
        return store.save_spec(
            project.root,
            spec_id=request["specId"],
            name=request["name"],
            spec=parse_spec(request["spec"]),
            expected_revision=request["expectedRevision"],
        )

    def delete_spec(self, request: dict[str, Any]) -> dict[str, Any]:
        """Delete a saved specification."""
        project, _context = self._context(request, "deleteSpec")
        return store.delete_spec(
            project.root,
            spec_id=request["specId"],
            expected_revision=request["expectedRevision"],
        )

    def save_set(self, request: dict[str, Any]) -> dict[str, Any]:
        """Create or replace an unlocked ROI set."""
        project, _context = self._context(request, "saveSet")
        return store.save_set(
            project.root,
            set_id=request["setId"],
            name=request["name"],
            measures=request["measures"],
            expected_revision=request["expectedRevision"],
        )

    def lock_set(self, request: dict[str, Any]) -> dict[str, Any]:
        """Lock a ROI set."""
        project, _context = self._context(request, "lockSet")
        return store.lock_set(
            project.root,
            set_id=request["setId"],
            expected_revision=request["expectedRevision"],
        )

    def delete_set(self, request: dict[str, Any]) -> dict[str, Any]:
        """Delete a ROI set."""
        project, _context = self._context(request, "deleteSet")
        return store.delete_set(
            project.root,
            set_id=request["setId"],
            expected_revision=request["expectedRevision"],
        )

    def import_variables(self, request: dict[str, Any]) -> dict[str, Any]:
        """Copy a variables CSV into the project (main-internal ``importVariables``)."""
        _project, context = self._context(request, "importVariables")
        path = request["path"]
        if not isinstance(path, str) or not os.path.isabs(path):
            raise GroupAnalysisError("Send the absolute path of the variables CSV.")
        return sources.import_variables(self._snapshot(context, request), path)

    def delete_variables(self, request: dict[str, Any]) -> dict[str, Any]:
        """Remove an imported variables table (main-internal ``deleteVariables``)."""
        project, _context = self._context(request, "deleteVariables")
        sources.delete_variables(project.root, request["tableId"])
        return {"tableId": request["tableId"], "removed": True}

    def export_data(self, request: dict[str, Any]) -> dict[str, Any]:
        """Render one result's export tables (main-internal).

        The result is pinned only once main has written the export
        (``pin_result``), so a failed write leaves it prunable.
        """
        project, _context = self._context(request, "exportData")
        if not isinstance(request["subjectCsv"], bool):
            raise GroupAnalysisError("Send subjectCsv as true or false.")
        record = self._stored(project, request["resultId"])
        return export.export_payload(record, subject_csv=request["subjectCsv"])

    def pin_result(self, request: dict[str, Any]) -> dict[str, Any]:
        """Keep an exported result past pruning (main-internal)."""
        project, _context = self._context(request, "pinResult")
        record = self._stored(project, request["resultId"])
        store.pin_result(project.root, record["resultId"])
        return {"resultId": record["resultId"], "pinned": True}

    def stop_all(self, timeout: float = 0.0) -> None:
        """Stop any running compute, for a project detach or sidecar shutdown."""
        with self._lock:
            operation = self._operation
            if operation is not None and operation.state == "running":
                self._stop(operation, None)
        thread = operation.thread if operation is not None else None
        if thread is not None and timeout > 0:
            thread.join(timeout)

    # -- Operation ----

    @staticmethod
    def _owns(operation: _Operation, project: ProjectIdentity) -> bool:
        return (
            operation.project.project_id == project.project_id
            and operation.project.root == project.root
        )

    def _cancel_foreign(self, project: ProjectIdentity) -> None:
        with self._lock:
            operation = self._operation
            if (
                operation is not None
                and operation.state == "running"
                and not self._owns(operation, project)
            ):
                self._stop(operation, "The project changed.")

    def _stop(self, operation: _Operation, message: str | None) -> None:
        operation.cancel.set()
        operation.state = "cancelled"
        operation.phase = None
        operation.message = message
        operation.finished_at = timestamp()
        self._kill(operation.process)

    @staticmethod
    def _kill(process: subprocess.Popen[bytes] | None) -> None:
        if process is not None and process.poll() is None:
            with contextlib.suppress(OSError):
                os.killpg(process.pid, signal.SIGKILL)

    def _finish(
        self,
        operation: _Operation,
        state: str,
        message: str | None,
        result_id: str | None = None,
        skipped: list[dict[str, str]] | None = None,
    ) -> None:
        with self._lock:
            # A result written before a cancel took effect is kept.
            honored = state == "done" and operation.state == "cancelled"
            if operation.state != "running" and not honored:
                return
            operation.result_id = result_id
            operation.skipped = skipped
            operation.state = state
            operation.phase = None
            operation.message = message
            operation.finished_at = timestamp()

    def _job(
        self,
        operation: _Operation,
        context: dataset.AnalysisContext,
        spec: GroupAnalysisSpec | GroupAnalysisSpecV2,
        currency: dict[str, str],
        result_id: str,
    ) -> dict[str, Any]:
        library = store.load_library(context.project_root)
        saved = next(
            (
                item
                for item in library["specs"]
                if item["specDigest"] == operation.spec_digest
            ),
            None,
        )
        return {
            "schema": worker.JOB_SCHEMA,
            "schemaVersion": 1,
            "resultId": result_id,
            "specId": saved["specId"] if saved else None,
            "name": saved["name"] if saved else default_name(spec),
            "projectRoot": context.project_root,
            "spec": spec.model_dump(mode="json", by_alias=True),
            "context": {
                "cfg": dict(context.cfg),
                "configRevision": context.config_revision,
                "registry": [dict(item) for item in context.registry],
                "qc": {key: dict(value) for key, value in context.qc.items()},
                "registration": [dict(item) for item in context.registration],
                "registrationKnown": context.registration_known,
            },
            "stageCurrency": currency,
            "productVersion": __version__,
            "build": _build_label(),
        }

    def _run(
        self,
        operation: _Operation,
        context: dataset.AnalysisContext,
        request: dict[str, Any],
        spec: GroupAnalysisSpec | GroupAnalysisSpecV2,
        currency: dict[str, str],
    ) -> None:
        """Snapshot the project, run one worker, and track it to the end.

        A failure before the worker starts says it could not start; a later
        one says the analysis stopped. Either way the worker is killed if it
        still runs and always reaped, so no zombie is left behind.
        """
        process: subprocess.Popen[bytes] | None = None
        try:
            snapshot = self._snapshot(context, request)
            result_id = f"gar-{secrets.token_hex(8)}"
            payload = json.dumps(
                self._job(operation, snapshot, spec, currency, result_id),
                allow_nan=False,
            ).encode("utf-8")
            with self._lock:
                if operation.state != "running":
                    return
            try:
                process = self._spawn(worker.worker_command())
            except OSError:
                self._finish(operation, "failed", _WORKER_UNSTARTED)
                return
            with self._lock:
                operation.process = process
                if operation.state != "running":
                    self._kill(process)
            self._feed(process, payload)
            try:
                outcome = self._follow(operation, process)
                process.wait()
            finally:
                if process.stdout is not None:
                    process.stdout.close()
            self._conclude(operation, outcome, result_id, snapshot.project_root)
        except GroupAnalysisError as exc:
            self._finish(operation, "failed", str(exc)[:512])
        except Exception:  # One operator-safe sentence, never a trace.
            message = _WORKER_UNSTARTED if process is None else _WORKER_FAILED
            self._finish(operation, "failed", message)
        finally:
            if process is not None:
                self._reap(process)

    def _conclude(
        self,
        operation: _Operation,
        outcome: tuple[str, str | None, list[dict[str, str]] | None] | None,
        result_id: str,
        project_root: str,
    ) -> None:
        """Record the worker's final event on the operation.

        A worker killed (or stopped) after it committed its result file has
        finished: the result counts as done, even when a cancel landed first.
        """
        if (outcome is None or outcome[0] == "cancelled") and store.result_committed(
            project_root, result_id
        ):
            self._finish(operation, "done", None, result_id)
        elif outcome is None:
            self._finish(operation, "failed", _WORKER_EXITED)
        elif outcome[0] == "done":
            self._finish(operation, "done", None, result_id)
        elif outcome[0] == "cancelled":
            self._finish(operation, "cancelled", None)
        else:
            self._finish(operation, "failed", outcome[1], skipped=outcome[2])

    def _reap(self, process: subprocess.Popen[bytes]) -> None:
        """Kill a worker that still runs, wait for it, and close its pipes."""
        self._kill(process)
        with contextlib.suppress(subprocess.TimeoutExpired, OSError):
            process.wait(_REAP_SECONDS)
        for stream in (process.stdin, process.stdout):
            if stream is not None:
                with contextlib.suppress(OSError):
                    stream.close()

    @staticmethod
    def _feed(process: subprocess.Popen[bytes], payload: bytes) -> None:
        stdin = process.stdin
        if stdin is None:
            return
        with contextlib.suppress(OSError):
            stdin.write(payload)
        with contextlib.suppress(OSError):
            stdin.close()

    def _follow(
        self, operation: _Operation, process: subprocess.Popen[bytes]
    ) -> tuple[str, str | None, list[dict[str, str]] | None] | None:
        """Apply the worker's progress lines; return its final event, if any."""
        stdout = process.stdout
        if stdout is None:
            return None
        while True:
            line = stdout.readline(_MAX_EVENT_BYTES)
            if not line:
                return None
            try:
                event = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                continue
            if not isinstance(event, dict):
                continue
            kind = event.get("event")
            if kind == "progress":
                self._progress(operation, event)
            elif kind == "done" and event.get("resultId") is not None:
                return ("done", None, None)
            elif kind == "cancelled":
                return ("cancelled", None, None)
            elif kind == "failed":
                text = event.get("message")
                return (
                    "failed",
                    text[:512] if isinstance(text, str) and text else _WORKER_EXITED,
                    _skipped_rows(event.get("skipped")),
                )

    def _progress(self, operation: _Operation, event: Mapping[str, Any]) -> None:
        phase = event.get("phase")
        completed = event.get("completed")
        total = event.get("total")
        if (
            phase not in worker.PHASES
            or not isinstance(completed, int)
            or not isinstance(total, int)
            or isinstance(completed, bool)
            or isinstance(total, bool)
        ):
            return
        with self._lock:
            if operation.state == "running":
                operation.phase = str(phase)
                operation.completed = max(0, completed)
                operation.total = max(0, total)
