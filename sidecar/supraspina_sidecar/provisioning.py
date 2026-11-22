"""Non-blocking, cancellable PyBrainAge and BrainCharts provisioning.

Both kinds share one operation slot per project, so the runtime snapshot,
cancellation, and project-close guards cover either; each keeps its own
executor, log root, and terminal sentences.
"""

from __future__ import annotations

import copy
import json
import os
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from . import braincharts_runtime
from .adapters import pybrainage, tools
from .adapters.base import ADAPTERS
from .authorization import AuthorizationLedger
from .bounded_io import read_bounded_regular
from .project import ProjectEpochs, ProjectIdentity
from .redaction import redact_text
from .workflow_manager import _release_spawn, _settle_group, _spawn, _terminate_tree

_STATE_VERSION = 1
_MAX_STATE_BYTES = 64 * 1024
_STATE_PHASES = {"idle", "running", "done", "error", "cancelled"}
_ENV_PHASE_END = 0.3
_DOWNLOAD_PHASE_END = 0.7
_PERSISTENCE_ERROR = "Choose writable storage for provisioning status."
#: Bound one streamed provisioning log line so a runaway child cannot flood
#: the JSON-RPC channel or the renderer.
_LOG_LINE_CHARS = 2000
_BACKGROUND_TERMINATION = os.name == "nt"
#: The operation kinds and the sentences their terminal states publish.
_KIND_TEXT: dict[str, dict[str, str]] = {
    "pybrainage": {
        "cancelled": "PyBrainAge setup was canceled.",
        "done": "PyBrainAge provisioning is complete.",
    },
    "braincharts": {
        "cancelled": "BrainCharts setup was canceled.",
        "done": "BrainCharts setup is complete.",
    },
}
_BRAINCHARTS_LICENSE_REFUSAL = (
    "Accept the BrainCharts license notice before the download."
)


def _fsync_directory(path: str) -> None:
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _state_path(project: ProjectIdentity) -> str:
    return os.path.join(project.root, ".supraspina", "provision.json")


def _unreadable_state(project: ProjectIdentity) -> dict[str, Any]:
    """Project an existing but unverifiable ownership store as active unknown."""
    return {
        "schemaVersion": _STATE_VERSION,
        "projectId": project.project_id,
        "projectEpoch": project.epoch,
        "configRevision": 0,
        "operationId": None,
        "phase": "error",
        "percent": None,
        "message": "Repair the unreadable persisted provisioning status.",
        "error": "Repair the unreadable persisted provisioning status.",
        "pythonExecutable": None,
        "modelPath": None,
        "scalerPath": None,
        "updatedAt": int(time.time() * 1000),
        "storeUnreadable": True,
        "processOwnership": {
            "projectId": project.project_id,
            "projectEpoch": project.epoch,
            "operationId": None,
            "state": "unknown",
            "provedStopped": False,
            "detail": "Repair the unreadable persisted provisioning ownership.",
        },
    }


def _write_state(project: ProjectIdentity, value: dict[str, Any]) -> None:
    """Atomically persist one bounded project-scoped provisioning snapshot."""
    directory = os.path.dirname(_state_path(project))
    os.makedirs(directory, exist_ok=True)
    payload = (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        + "\n"
    ).encode("utf-8")
    if len(payload) > _MAX_STATE_BYTES:
        raise OSError("Keep the provisioning status within its persistence bound.")
    tmp = os.path.join(directory, f".provision.tmp-{uuid.uuid4().hex}")
    try:
        with open(tmp, "xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, _state_path(project))
        _fsync_directory(directory)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_state(project: ProjectIdentity) -> dict[str, Any] | None:
    """Load only a bounded status matching the explicit project identity."""
    path = _state_path(project)
    try:
        value = json.loads(read_bounded_regular(path, _MAX_STATE_BYTES))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, json.JSONDecodeError):
        return _unreadable_state(project)
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != _STATE_VERSION
        or value.get("projectId") != project.project_id
        or value.get("phase") not in _STATE_PHASES
    ):
        return _unreadable_state(project)
    return value


@dataclass
class _Operation:
    operation_id: str
    project: ProjectIdentity
    cfg: dict[str, Any]
    config_revision: int
    sha256: str
    kind: str = "pybrainage"
    cancel: threading.Event = field(default_factory=threading.Event)
    process: Any | None = None
    process_ownership: dict[str, Any] | None = None
    phase: str = "running"
    error: str | None = None
    percent: int | None = 0
    message: str = "Provisioning has not started yet."
    # Set this only after durably committing a terminal phase. Keep running
    # operations unsettled regardless of this flag.
    terminal_persisted: bool = False
    # Set this only after making terminal state durable and releasing process
    # ownership. Prevent boundary callers from inferring completion from ``phase``.
    completed: threading.Event = field(default_factory=threading.Event)
    # The durable per-operation log file, opened lazily under the provision
    # root, or None while no line has been written or the root is unwritable.
    log_file: Any | None = None


def _check_kind_request(
    request: dict[str, Any], cfg: dict[str, Any], kind: str
) -> None:
    """Refuse a request its kind cannot run, before any grant is consumed."""
    if kind == "braincharts":
        if request.get("licenseAccepted") is not True:
            raise ValueError(_BRAINCHARTS_LICENSE_REFUSAL)
        if not braincharts_runtime.platform_supported():
            raise ValueError(braincharts_runtime.unsupported_platform_detail())
        braincharts_runtime.provision_root(cfg)
        return
    requested_sha = request.get("sha256")
    if requested_sha not in (None, "", pybrainage.PYBRAINAGE_ZENODO_SHA256):
        raise ValueError("Keep the PyBrainAge archive SHA-256 unchanged.")


class _ProvisionPersistenceError(RuntimeError):
    """Stop provisioning after a progress snapshot cannot be persisted."""


class ProvisionManager:
    """Own provision subprocesses without blocking the JSON-RPC reader."""

    def __init__(
        self,
        emitter: Any,
        projects: ProjectEpochs,
        authorizations: AuthorizationLedger,
        workflow: Any,
    ) -> None:
        self.emitter = emitter
        self.projects = projects
        self.authorizations = authorizations
        self.workflow = workflow
        self._lock = threading.RLock()
        self._operations: dict[str, _Operation] = {}
        self._by_project: dict[str, str] = {}
        self._unresolved: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _ownership_proved_stopped(ownership: Any) -> bool:
        return ownership is None or (
            isinstance(ownership, dict)
            and ownership.get("state") == "settled"
            and ownership.get("provedStopped") is True
        )

    @classmethod
    def _terminal_ready(cls, operation: _Operation) -> bool:
        ownership = operation.process_ownership
        return (
            operation.phase != "running"
            and operation.terminal_persisted
            and cls._ownership_proved_stopped(ownership)
        )

    @classmethod
    def _operation_terminal(cls, operation: _Operation) -> bool:
        return cls._terminal_ready(operation) and operation.completed.is_set()

    @classmethod
    def _projected_record_for(cls, operation: _Operation) -> dict[str, Any]:
        """Project incomplete terminal settlement as active work."""
        record = cls._record_for(operation)
        if not cls._operation_terminal(operation):
            record["phase"] = "running"
        ownership = operation.process_ownership
        record["_cancellable"] = (
            operation.phase == "running"
            and operation.error != _PERSISTENCE_ERROR
            and (
                ownership is None
                or (
                    isinstance(ownership, dict)
                    and (
                        ownership.get("state") in {"claiming", "accepted"}
                        or cls._ownership_proved_stopped(ownership)
                    )
                )
            )
        )
        return record

    def start(
        self, request: dict[str, Any], *, kind: str = "pybrainage"
    ) -> dict[str, str]:
        """Start one project provision operation and return immediately.

        ``kind`` is ``pybrainage`` or ``braincharts``. A BrainCharts request
        must carry ``licenseAccepted: true`` (the operator accepted the GPL-3.0
        notice) and is refused off Linux x86_64, both before the one-use
        authorization is consumed.
        """
        if kind not in _KIND_TEXT:
            raise ValueError("Choose a known provisioning kind.")
        if not isinstance(request.get("cfg"), dict):
            raise ValueError("Provide cfg for provisioning.")
        if "configRevision" not in request:
            raise ValueError("Provide configRevision for provisioning.")
        cfg = request["cfg"]
        project = self.projects.validate(request.get("project"), cfg)
        revision = int(request.get("configRevision", 0))
        prior = self._reconciled_record(project)
        if (
            prior is not None
            and isinstance(prior.get("processOwnership"), dict)
            and prior["processOwnership"].get("state") == "unknown"
        ):
            raise ValueError(
                "Resolve unknown prior provisioning ownership before retrying."
            )
        _check_kind_request(request, cfg, kind)
        self.authorizations.consume(
            request.get("authorization"),
            project_id=project.project_id,
            config_revision=revision,
            purpose="provision",
        )
        with self._lock:
            active_id = self._by_project.get(project.project_id)
            if active_id and self._operations.get(active_id, None) is not None:
                active = self._operations[active_id]
                if not self._operation_terminal(active):
                    raise ValueError("Wait for active project provisioning to finish.")
            operation_id = f"provision-{uuid.uuid4().hex[:12]}"
            operation = _Operation(
                operation_id=operation_id,
                project=project,
                cfg=cfg,
                config_revision=revision,
                sha256=pybrainage.PYBRAINAGE_ZENODO_SHA256
                if kind == "pybrainage"
                else braincharts_runtime.MODEL_ARCHIVE.sha256,
                kind=kind,
            )
            self._operations[operation_id] = operation
            self._by_project[project.project_id] = operation_id
        try:
            self._persist_operation(operation)
        except OSError as exc:
            with self._lock:
                self._operations.pop(operation_id, None)
                if self._by_project.get(project.project_id) == operation_id:
                    self._by_project.pop(project.project_id, None)
            raise RuntimeError("Choose writable provisioning-status storage.") from exc
        self.workflow.emit_provision(project, self.status_for(operation))
        thread = threading.Thread(
            target=self._run,
            args=(operation,),
            daemon=True,
            name=operation_id,
        )
        thread.start()
        return {"operationId": operation_id}

    def project_active(self, project_id: str) -> bool:
        """Return whether provisioning is currently running for a project."""
        with self._lock:
            return (
                any(
                    operation.project.project_id == project_id
                    and not self._operation_terminal(operation)
                    for operation in self._operations.values()
                )
                or project_id in self._unresolved
            )

    def active_count(self) -> int:
        """Return the number of running provision operations."""
        with self._lock:
            active_projects = {
                operation.project.project_id
                for operation in self._operations.values()
                if not self._operation_terminal(operation)
            }
            return len(active_projects | set(self._unresolved))

    def _run(  # noqa: PLR0915
        self, operation: _Operation
    ) -> None:
        def progress(message: str, fraction: float) -> None:
            if operation.cancel.is_set():
                return
            self._publish_log(operation, message)
            phase = (
                "env"
                if fraction < _ENV_PHASE_END
                else "download"
                if fraction < _DOWNLOAD_PHASE_END
                else "validate"
            )
            if not self._emit_progress(
                operation, phase, round(fraction * 100), message
            ):
                raise _ProvisionPersistenceError

        def runner(
            argv: list[str],
            *,
            env: dict[str, str] | None = None,
            timeout: float | None = None,
        ) -> tools.RunResult:
            del timeout  # Process-tree ownership supplies cancellation, not a timer.
            if operation.cancel.is_set():
                return tools.RunResult(rc=130, stdout="", stderr="cancelled")
            self._publish_log(operation, "$ " + " ".join(argv))
            proc = _spawn(argv, operation.cfg, environment=env)
            ownership: dict[str, Any] | None = None
            pgid: int | None = None
            captured: list[str] = []
            try:
                with self._lock:
                    operation.process = proc
                    ownership = self.workflow.process_owner_record(
                        operation_kind="provision",
                        project=operation.project,
                        proc=proc,
                        operation_id=operation.operation_id,
                    )
                    operation.process_ownership = ownership
                self._persist_operation(operation)
                pgid = self.workflow.announce_process_started(ownership, proc)
                self._persist_operation(operation)
                if operation.cancel.is_set():
                    _terminate_tree(proc)
                else:
                    _release_spawn(proc)
                    if operation.cancel.is_set():
                        _terminate_tree(proc)
                self._stream_child_output(operation, proc, captured)
                proc.wait()
            finally:
                if proc.poll() is None:
                    _terminate_tree(proc, force=True)
                    try:
                        proc.wait(timeout=2)
                    except (OSError, subprocess.SubprocessError):
                        pass
                proved = (
                    self.workflow.announce_process_settled(ownership, proc, pgid)
                    if ownership is not None
                    else _settle_group(proc, pgid)
                )
                with self._lock:
                    if ownership is not None:
                        ownership["state"] = "settled" if proved else "unknown"
                        ownership["provedStopped"] = proved
                        ownership["settledAt"] = (
                            int(time.time() * 1000) if proved else None
                        )
                        operation.process_ownership = ownership
                        if proved:
                            self._unresolved.pop(operation.project.project_id, None)
                        else:
                            self._unresolved[operation.project.project_id] = (
                                copy.deepcopy(ownership)
                            )
                    operation.process = None
                try:
                    self._persist_operation(operation)
                except OSError:
                    self._mark_persistence_error(operation)
            rc = int(proc.returncode or 0)
            self._publish_log(operation, f"[exit {rc}]")
            return tools.RunResult(rc=rc, stdout="".join(captured), stderr="")

        terminal_progress: tuple[str, int | None, str] | None = None
        terminal_persisted = False
        text = _KIND_TEXT[operation.kind]
        try:
            result = self._execute(operation, progress, runner)
            if operation.cancel.is_set():
                terminal_progress = ("error", None, text["cancelled"])
                terminal_persisted = self._persist_terminal(
                    operation, "cancelled", None, text["cancelled"]
                )
            elif result.get("ok"):
                terminal_progress = ("done", 100, text["done"])
                terminal_persisted = self._persist_terminal(
                    operation, "done", 100, text["done"]
                )
            else:
                operation.error = redact_text(
                    str(
                        result.get("message")
                        or "Inspect the failed provisioning operation."
                    ),
                    project_root=operation.project.root,
                )
                terminal_progress = ("error", None, operation.error)
                terminal_persisted = self._persist_terminal(
                    operation,
                    "error",
                    None,
                    operation.error,
                    error=operation.error,
                )
        except _ProvisionPersistenceError:
            terminal_progress = ("error", None, _PERSISTENCE_ERROR)
        except Exception as exc:
            operation.error = f"{type(exc).__name__}: provisioning failed"
            operation_phase = "cancelled" if operation.cancel.is_set() else "error"
            terminal_progress = ("error", None, operation.error)
            terminal_persisted = self._persist_terminal(
                operation,
                operation_phase,
                None,
                operation.error,
                error=operation.error,
            )
        finally:
            if not terminal_persisted:
                terminal_progress = ("error", None, _PERSISTENCE_ERROR)
                terminal_persisted = self._persist_terminal(
                    operation,
                    "error",
                    None,
                    _PERSISTENCE_ERROR,
                    error=_PERSISTENCE_ERROR,
                )
            ownership = operation.process_ownership
            if isinstance(ownership, dict) and ownership.get("provedStopped") is True:
                self.workflow.release_process_owner(ownership)
            with self._lock:
                publish_terminal = self._terminal_ready(operation)
            if publish_terminal and terminal_progress is not None:
                self._publish_log(operation, terminal_progress[2])
                self._publish_progress(
                    operation,
                    *terminal_progress,
                    committed_terminal=True,
                )
            self._close_log(operation)
            with self._lock:
                if publish_terminal and self._terminal_ready(operation):
                    operation.completed.set()
                self._prune_locked()

    @staticmethod
    def _execute(
        operation: _Operation,
        progress: Any,
        runner: Any,
    ) -> dict[str, Any]:
        """Run the operation's own executor with the owned process runner."""
        if operation.kind == "braincharts":
            return braincharts_runtime.execute_provision(
                operation.cfg,
                progress,
                runner=runner,
                cancelled=operation.cancel.is_set,
            )
        return pybrainage.execute_provision(
            operation.cfg,
            progress,
            expected_sha256=operation.sha256,
            runner=runner,
            extractor=lambda cfg: pybrainage.extract_model(
                cfg, operation.cancel.is_set
            ),
            # execute_provision names the staged archive explicitly, so the
            # verifier must forward archive_path to hash the exact file it
            # is about to promote.
            verifier=lambda cfg, expected, *, archive_path=None: (
                pybrainage.verify_model(
                    cfg,
                    expected,
                    operation.cancel.is_set,
                    archive_path=archive_path,
                )
            ),
            cancelled=operation.cancel.is_set,
        )

    def _prune_locked(self) -> None:
        """Retain active operations plus at most 64 terminal status records."""
        terminal = [
            operation_id
            for operation_id, operation in self._operations.items()
            if self._operation_terminal(operation)
        ]
        for operation_id in terminal[:-64]:
            operation = self._operations.pop(operation_id, None)
            if (
                operation is not None
                and self._by_project.get(operation.project.project_id) == operation_id
            ):
                self._by_project.pop(operation.project.project_id, None)

    def _emit_progress(
        self,
        operation: _Operation,
        phase: str,
        percent: int | None,
        message: str,
    ) -> bool:
        with self._lock:
            operation.percent = percent
            operation.message = redact_text(
                message, project_root=operation.project.root
            )
            record = self._record_for(operation)
        persisted = True
        try:
            self._persist_operation(operation, record=record)
        except OSError:
            persisted = False
            self._mark_persistence_error(operation)
        if persisted:
            self._publish_progress(operation, phase, percent, operation.message)
        return persisted

    def _mark_persistence_error(self, operation: _Operation) -> None:
        with self._lock:
            operation.completed.clear()
            operation.phase = "running"
            operation.terminal_persisted = False
            operation.error = _PERSISTENCE_ERROR
            operation.percent = None
            operation.message = _PERSISTENCE_ERROR

    def _persist_terminal(
        self,
        operation: _Operation,
        phase: str,
        percent: int | None,
        message: str,
        *,
        error: str | None = None,
    ) -> bool:
        """Commit a terminal phase without projecting a failed write as idle."""
        with self._lock:
            operation.completed.clear()
            operation.terminal_persisted = False
            safe_message = redact_text(message, project_root=operation.project.root)
            record = self._record_for(operation)
            record.update(
                {
                    "phase": phase,
                    "percent": percent,
                    "message": safe_message,
                    "error": error,
                }
            )
        try:
            self._persist_operation(operation, record=record)
        except OSError:
            self._mark_persistence_error(operation)
            return False
        with self._lock:
            operation.phase = phase
            operation.percent = percent
            operation.message = safe_message
            operation.error = error
            operation.terminal_persisted = True
            return True

    @staticmethod
    def log_path(
        cfg: dict[str, Any], operation_id: str, kind: str = "pybrainage"
    ) -> str:
        """Return the durable log file for one provisioning operation."""
        if kind == "braincharts":
            return os.path.join(braincharts_runtime.log_dir(cfg), f"{operation_id}.log")
        return os.path.join(
            pybrainage.provision_root(cfg), "logs", f"{operation_id}.log"
        )

    def _publish_log(self, operation: _Operation, line: str) -> None:
        """Stream one redacted, bounded log line live and append it to disk.

        Never raise: a log line is diagnostic output and must not change the
        outcome of the operation it describes.
        """
        safe = redact_text(line, project_root=operation.project.root)
        if len(safe) > _LOG_LINE_CHARS:
            safe = safe[:_LOG_LINE_CHARS] + " [line truncated]"
        at = int(time.time() * 1000)
        with self._lock:
            if operation.log_file is None:
                try:
                    path = self.log_path(
                        operation.cfg, operation.operation_id, operation.kind
                    )
                    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
                    operation.log_file = open(
                        path, "a", encoding="utf-8", errors="replace"
                    )
                except (OSError, ValueError):
                    operation.log_file = False
            if operation.log_file:
                try:
                    operation.log_file.write(safe + "\n")
                    operation.log_file.flush()
                except OSError:
                    pass
        try:
            self.emitter.emit(
                "provision.log",
                {
                    "projectId": operation.project.project_id,
                    "projectEpoch": operation.project.epoch,
                    "operationId": operation.operation_id,
                    "at": at,
                    "line": safe,
                },
            )
        except (OSError, ValueError):
            pass

    def _stream_child_output(
        self, operation: _Operation, proc: Any, captured: list[str]
    ) -> None:
        """Stream every child line live and keep the full capture for parsers.

        The operator follows micromamba, pip, and validation output as it
        happens instead of one status message per step.
        """
        stream = getattr(proc, "stdout", None)
        if stream is None:
            return
        for raw in stream:
            captured.append(raw)
            self._publish_log(operation, raw.rstrip("\r\n"))

    def _close_log(self, operation: _Operation) -> None:
        with self._lock:
            handle = operation.log_file
            operation.log_file = None
        if handle:
            try:
                handle.close()
            except OSError:
                pass

    def _publish_progress(
        self,
        operation: _Operation,
        phase: str,
        percent: int | None,
        message: str,
        *,
        committed_terminal: bool = False,
    ) -> None:
        """Publish only a durable running snapshot or a completed terminal one."""
        with self._lock:
            payload = {
                "phase": phase,
                "percent": percent,
                "message": message,
                "projectId": operation.project.project_id,
                "projectEpoch": operation.project.epoch,
                "operationId": operation.operation_id,
            }
            record = (
                self._record_for(operation)
                if committed_terminal
                else self._projected_record_for(operation)
            )
            status = self._status_from_cfg(
                operation.project,
                operation.cfg,
                operation.config_revision,
                record,
            )
        try:
            self.emitter.emit("provision.progress", payload)
        except (OSError, ValueError):
            pass
        self.workflow.emit_provision(operation.project, status)

    def status(self, request: dict[str, Any]) -> dict[str, Any]:
        """Recompute readiness for the exact explicit project configuration."""
        if not isinstance(request.get("cfg"), dict):
            raise ValueError("Provide cfg for provision.status.")
        if "configRevision" not in request:
            raise ValueError("Provide configRevision for provision.status.")
        cfg = request["cfg"]
        revision = int(request["configRevision"])
        project = self.projects.validate(request.get("project"), cfg)
        with self._lock:
            operation_id = self._by_project.get(project.project_id)
            operation = self._operations.get(operation_id or "")
            record = (
                self._projected_record_for(operation) if operation is not None else None
            )
        if operation is None or operation.project.epoch != project.epoch:
            record = self._reconciled_record(project)
        if (
            record is not None
            and record.get("phase") != "running"
            and not (
                isinstance(record.get("processOwnership"), dict)
                and record["processOwnership"].get("state") == "unknown"
            )
            and int(record.get("configRevision", -1)) != revision
        ):
            record = None
        return self._status_from_cfg(project, cfg, revision, record)

    def status_for(self, operation: _Operation) -> dict[str, Any]:
        """Build a status using the exact paths PyBrainAge command consumes."""
        with self._lock:
            return self._status_from_cfg(
                operation.project,
                operation.cfg,
                operation.config_revision,
                self._projected_record_for(operation),
            )

    @staticmethod
    def _resolved_paths(cfg: dict[str, Any]) -> tuple[str, str, str]:
        adapter = ADAPTERS["pybrainage"]
        argv = adapter.build_command(cfg, None)
        return (
            argv[0],
            argv[argv.index("--model") + 1],
            argv[argv.index("--scaler") + 1],
        )

    @classmethod
    def _status_from_cfg(
        cls,
        project: ProjectIdentity,
        cfg: dict[str, Any],
        revision: int,
        record: dict[str, Any] | None,
    ) -> dict[str, Any]:
        python, model, scaler = cls._resolved_paths(cfg)
        state_ready, _state_detail = pybrainage.provision_state_status(cfg)
        phase = str(record.get("phase")) if record is not None else "idle"
        ownership = record.get("processOwnership") if record is not None else None
        ownership_unsettled = not cls._ownership_proved_stopped(ownership)
        if ownership_unsettled:
            phase = "running"
        cancellable_hint = record.get("_cancellable") if record is not None else None
        operation_id = record.get("operationId") if record is not None else None
        error = record.get("error") if record is not None else None
        return {
            "envReady": state_ready
            and os.path.isfile(python)
            and os.access(python, os.X_OK),
            "modelReady": state_ready
            and tools.file_nonempty(model)
            and tools.file_nonempty(scaler),
            "pythonExecutable": python
            if state_ready and os.path.isfile(python)
            else None,
            "modelPath": model if state_ready and tools.file_nonempty(model) else None,
            "scalerPath": scaler
            if state_ready and tools.file_nonempty(scaler)
            else None,
            "projectId": project.project_id,
            "projectEpoch": project.epoch,
            "configRevision": revision,
            "operationId": operation_id,
            "phase": phase,
            "cancellable": (
                phase == "running"
                and (
                    cancellable_hint
                    if isinstance(cancellable_hint, bool)
                    else not ownership_unsettled
                )
                and operation_id is not None
            ),
            "error": error,
        }

    @staticmethod
    def _record_for(operation: _Operation) -> dict[str, Any]:
        python, model, scaler = ProvisionManager._resolved_paths(operation.cfg)
        return {
            "schemaVersion": _STATE_VERSION,
            "projectId": operation.project.project_id,
            "projectEpoch": operation.project.epoch,
            "configRevision": operation.config_revision,
            "operationId": operation.operation_id,
            "kind": operation.kind,
            "phase": operation.phase,
            "percent": operation.percent,
            "message": operation.message,
            "error": operation.error,
            "pythonExecutable": python,
            "modelPath": model,
            "scalerPath": scaler,
            "updatedAt": int(time.time() * 1000),
            "processOwnership": copy.deepcopy(operation.process_ownership)
            if operation.process_ownership is not None
            else None,
        }

    def _persist_operation(
        self,
        operation: _Operation,
        *,
        record: dict[str, Any] | None = None,
    ) -> None:
        _write_state(
            operation.project,
            self._record_for(operation) if record is None else record,
        )

    def _reconciled_record(self, project: ProjectIdentity) -> dict[str, Any] | None:
        record = _read_state(project)
        if isinstance(record, dict) and record.get("storeUnreadable") is True:
            ownership = record.get("processOwnership")
            unresolved = (
                copy.deepcopy(ownership)
                if isinstance(ownership, dict)
                else {
                    "projectId": project.project_id,
                    "projectEpoch": project.epoch,
                    "operationId": record.get("operationId"),
                    "state": "unknown",
                    "provedStopped": False,
                    "detail": "Repair the unreadable persisted provisioning ownership.",
                }
            )
            with self._lock:
                self._unresolved[project.project_id] = unresolved
            return record
        if record is None:
            with self._lock:
                self._unresolved.pop(project.project_id, None)
            return None
        ownership = record.get("processOwnership")
        if record.get("phase") != "running" and self._ownership_proved_stopped(
            ownership
        ):
            with self._lock:
                self._unresolved.pop(project.project_id, None)
            return record
        with self._lock:
            operation_id = str(record.get("operationId") or "")
            operation = self._operations.get(operation_id)
            owned = (
                operation is not None
                and operation.phase == "running"
                and operation.project == project
            )
        if owned:
            return record
        record = dict(record)
        if isinstance(ownership, dict):
            outcome, reconciled = self.workflow.reconcile_process_owner(ownership)
        else:
            outcome, reconciled = "unknown", None
        if isinstance(reconciled, dict):
            record["processOwnership"] = reconciled
            if operation is not None:
                with self._lock:
                    operation.process_ownership = copy.deepcopy(reconciled)
        record["percent"] = None
        if outcome == "stopped" and self._ownership_proved_stopped(reconciled):
            record["phase"] = "error"
            record["message"] = (
                "Provisioning was interrupted; its prior process tree was stopped."
            )
            record["error"] = record["message"]
            with self._lock:
                self._unresolved.pop(project.project_id, None)
        else:
            record["phase"] = "error"
            record["message"] = (
                "Ownership of the prior provisioning process is unresolved."
            )
            record["error"] = (
                "Resolve the prior process tree before retrying or detaching."
            )
            unresolved = (
                reconciled
                if isinstance(reconciled, dict)
                else {
                    "projectId": project.project_id,
                    "operationId": record.get("operationId"),
                    "state": "unknown",
                }
            )
            record["processOwnership"] = unresolved
            with self._lock:
                self._unresolved[project.project_id] = unresolved
        record["updatedAt"] = int(time.time() * 1000)
        _write_state(project, record)
        return record

    def reconcile_project_ownership(self, project_raw: dict[str, Any]) -> None:
        """Load and conservatively reconcile persisted provisioning ownership."""
        project = self.projects.validate(project_raw)
        self._reconciled_record(project)

    def bootstrap_status(self, request: dict[str, Any]) -> dict[str, Any] | None:
        """Return persisted lifecycle state for runtime bootstrap after restart."""
        project = self.projects.validate(request.get("project"))
        if isinstance(request.get("cfg"), dict) and "configRevision" in request:
            return self.status(request)
        with self._lock:
            operation_id = self._by_project.get(project.project_id)
            operation = self._operations.get(operation_id or "")
            record = (
                self._projected_record_for(operation)
                if operation is not None and operation.project.epoch == project.epoch
                else None
            )
        if record is None:
            record = self._reconciled_record(project)
        if record is None:
            return None
        phase = str(record.get("phase") or "error")
        ownership = record.get("processOwnership")
        ownership_unsettled = not self._ownership_proved_stopped(ownership)
        if ownership_unsettled:
            phase = "running"
        cancellable_hint = record.get("_cancellable")
        return {
            # A bootstrap record alone cannot revalidate the current generation;
            # status(cfg) performs that digest-bound check before advertising ready.
            "envReady": False,
            "modelReady": False,
            "pythonExecutable": None,
            "modelPath": None,
            "scalerPath": None,
            "projectId": project.project_id,
            "projectEpoch": project.epoch,
            "configRevision": int(record.get("configRevision", 0)),
            "operationId": record.get("operationId"),
            "phase": phase,
            "cancellable": phase == "running"
            and (
                cancellable_hint
                if isinstance(cancellable_hint, bool)
                else not ownership_unsettled
            ),
            "error": record.get("error"),
        }

    def cancel(self, request: dict[str, Any], timeout: float = 5.0) -> dict[str, Any]:
        """Cancel one provision operation and await a bounded terminal state."""
        project = self.projects.validate(request.get("project"))
        operation_id = str(request.get("operationId", ""))
        with self._lock:
            operation = self._operations.get(operation_id)
            if operation is None or operation.project != project:
                unresolved = self._unresolved.get(project.project_id)
                current_id = self._by_project.get(project.project_id)
                current = self._operations.get(current_id or "")
                if (
                    current is not None
                    and current.project == project
                    and not self._operation_terminal(current)
                ):
                    return {
                        "operationId": operation_id,
                        "accepted": False,
                        "terminal": False,
                    }
                if unresolved is not None:
                    return {
                        "operationId": operation_id,
                        "accepted": False,
                        "terminal": False,
                    }
        if operation is None or operation.project != project:
            record = self._reconciled_record(project)
            ownership = (
                record.get("processOwnership") if isinstance(record, dict) else None
            )
            terminal = record is None or (
                record.get("phase") != "running"
                and self._ownership_proved_stopped(ownership)
            )
            with self._lock:
                current_id = self._by_project.get(project.project_id)
                current = self._operations.get(current_id or "")
                if (
                    current is not None
                    and current.project == project
                    and not self._operation_terminal(current)
                ):
                    terminal = False
                if project.project_id in self._unresolved:
                    terminal = False
            return {
                "operationId": operation_id,
                "accepted": False,
                "terminal": terminal,
            }
        with self._lock:
            if self._operation_terminal(operation):
                return {
                    "operationId": operation_id,
                    "accepted": True,
                    "terminal": True,
                }
            operation.cancel.set()
            proc = operation.process
        deadline = time.monotonic() + timeout
        if proc is not None:
            if _BACKGROUND_TERMINATION:
                terminator = threading.Thread(
                    target=_terminate_tree,
                    args=(proc,),
                    daemon=True,
                    name=f"{operation.operation_id}-terminate",
                )
                terminator.start()
            else:
                _terminate_tree(proc)
            timer = threading.Timer(2.0, lambda: _terminate_tree(proc, force=True))
            timer.daemon = True
            timer.start()
        while not operation.completed.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            operation.completed.wait(min(0.02, remaining))
        with self._lock:
            terminal = self._operation_terminal(operation)
        return {
            "operationId": operation_id,
            "accepted": True,
            "terminal": terminal,
        }

    def shutdown(self, timeout: float = 5.0) -> None:
        """Cancel every active operation during sidecar shutdown."""
        with self._lock:
            operations = list(self._operations.values())
        deadline = time.monotonic() + timeout
        for operation in operations:
            if self._operation_terminal(operation):
                continue
            remaining = max(0.0, deadline - time.monotonic())
            self.cancel(
                {
                    "project": operation.project.to_dict(),
                    "operationId": operation.operation_id,
                },
                timeout=remaining,
            )
