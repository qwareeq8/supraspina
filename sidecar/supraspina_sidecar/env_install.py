"""Non-blocking operation state for gated environment installations.

``env.optInInstall`` starts one operation and returns its identity instead of
blocking the JSON-RPC reader for the length of a package installation. The
installer runs on a worker thread and publishes ``envInstall.progress``
notifications carrying the owning check, the lifecycle phase, the start time, a
bounded tail of the combined output, and, once terminal, the exit code with the
bounded captured stdout and stderr.

State is process-local. An installation does not survive a sidecar restart, so
nothing is persisted; a renderer that remounts reattaches to a still-running
operation through ``env.installStatus``. Ordinary installers are never
cancelled, because stopping a package manager midway through its transaction is
not known to be safe.
"""

from __future__ import annotations

import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from . import env
from .project import ProjectIdentity

#: Accept only the check-id shape the environment probes produce.
_CHECK_ID = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{0,127}$")
#: Bound the running-output tail carried by every notification.
_MAX_TAIL_CHARS = 8_192
#: Bound terminal stdout and stderr to the renderer parser's string limit.
_MAX_OUTPUT_CHARS = 65_536
#: Publish a running snapshot at most this often, in seconds.
_EMIT_INTERVAL_SECONDS = 0.4
#: Retain this many settled operations for inspection after they finish.
_MAX_OPERATION_HISTORY = 32
#: Wait no longer than this for active installations during shutdown.
_MAX_SHUTDOWN_SECONDS = 30.0
_TERMINAL_PHASES = frozenset({"done", "error"})


def _tail(value: str, limit: int) -> str:
    """Return at most the last ``limit`` characters of ``value``."""
    return value if len(value) <= limit else value[-limit:]


def _now_ms() -> int:
    """Return the current wall-clock time in epoch milliseconds."""
    return int(time.time() * 1000)


@dataclass
class _Operation:
    """One installation, its lifecycle phase, and its bounded output."""

    operation_id: str
    project: ProjectIdentity
    check_id: str
    cfg: dict[str, Any]
    started_at: int
    phase: str = "queued"
    output: str = ""
    rc: int | None = None
    stdout: str = ""
    stderr: str = ""
    updated_at: int = 0
    # Track the last publication so a chatty installer cannot flood the
    # notification stream. Terminal and phase changes always publish.
    last_published: float = 0.0
    completed: threading.Event = field(default_factory=threading.Event)


class EnvInstallManager:
    """Own opt-in installer processes without blocking the JSON-RPC reader."""

    def __init__(self, emitter: Any) -> None:
        """Initialize the process-local operation ledger."""
        self.emitter = emitter
        self._lock = threading.RLock()
        self._operations: dict[str, _Operation] = {}
        self._active_by_project: dict[str, str] = {}

    def start(
        self,
        project: ProjectIdentity,
        check_id: str,
        cfg: dict[str, Any],
    ) -> dict[str, str]:
        """Start one gated installation and return immediately.

        Parameters
        ----------
        project
            Provide the validated identity of the project that authorized the
            installation.
        cfg
            Provide the saved project configuration the installer resolves.

        Raises
        ------
        ValueError
            Raise when the check id is malformed, or when the project already
            has an installation that has not settled.
        """
        if not isinstance(check_id, str) or _CHECK_ID.fullmatch(check_id) is None:
            raise ValueError("Provide a valid check ID for env.optInInstall.")
        with self._lock:
            active = self._operations.get(
                self._active_by_project.get(project.project_id, "")
            )
            if active is not None and active.phase not in _TERMINAL_PHASES:
                raise ValueError("Wait for the active installation to finish.")
            operation = _Operation(
                operation_id=f"install-{uuid.uuid4().hex[:12]}",
                project=project,
                check_id=check_id,
                cfg=cfg,
                started_at=_now_ms(),
            )
            self._operations[operation.operation_id] = operation
            self._active_by_project[project.project_id] = operation.operation_id
            self._prune_locked()
        self._publish(operation, force=True)
        threading.Thread(
            target=self._run,
            args=(operation,),
            daemon=True,
            name=operation.operation_id,
        ).start()
        return {"operationId": operation.operation_id}

    def status(self, project: ProjectIdentity) -> dict[str, Any]:
        """Return every retained installation for one project generation.

        Parameters
        ----------
        project
            Provide the validated identity whose installations are requested.

        Returns
        -------
        dict
            Return the retained operations in start order, so a remounting
            renderer can reattach to one that is still running.
        """
        with self._lock:
            return {
                "operations": [
                    self._record_locked(operation)
                    for operation in self._operations.values()
                    if operation.project.project_id == project.project_id
                    and operation.project.epoch == project.epoch
                ]
            }

    def active_count(self) -> int:
        """Return the number of unsettled installations."""
        with self._lock:
            return sum(
                operation.phase not in _TERMINAL_PHASES
                for operation in self._operations.values()
            )

    def shutdown(self, timeout: float = 5.0) -> None:
        """Wait a bounded time for every active installation to settle.

        Never terminate an installer: a package manager stopped midway through
        its transaction can leave an environment that neither the probes nor
        the operator can trust. Wait for the shared deadline, then leave the
        remaining daemon workers to end with the process.
        """
        with self._lock:
            operations = [
                operation
                for operation in self._operations.values()
                if operation.phase not in _TERMINAL_PHASES
            ]
        deadline = time.monotonic() + max(0.0, min(timeout, _MAX_SHUTDOWN_SECONDS))
        for operation in operations:
            operation.completed.wait(max(0.0, deadline - time.monotonic()))

    def _run(self, operation: _Operation) -> None:
        """Run one installer to completion and publish its terminal state."""
        try:
            self._set_phase(operation, "running")
            result = env.opt_in_install(
                operation.check_id,
                operation.cfg,
                on_output=lambda line: self._append_output(operation, line),
            )
            rc = int(result.get("rc", 1))
            with self._lock:
                operation.rc = rc
                operation.stdout = _tail(
                    str(result.get("stdout", "")), _MAX_OUTPUT_CHARS
                )
                operation.stderr = _tail(
                    str(result.get("stderr", "")), _MAX_OUTPUT_CHARS
                )
            self._set_phase(operation, "done" if rc == 0 else "error")
        except Exception as exc:  # Report any installer failure as terminal.
            with self._lock:
                operation.rc = -1
                operation.stderr = f"{type(exc).__name__}: the installation failed"
            self._set_phase(operation, "error")
        finally:
            operation.completed.set()

    def _append_output(self, operation: _Operation, line: str) -> None:
        """Append one installer output line to the bounded running tail."""
        with self._lock:
            operation.output = _tail(operation.output + line, _MAX_TAIL_CHARS)
        self._publish(operation, force=False)

    def _set_phase(self, operation: _Operation, phase: str) -> None:
        """Move one operation to a new phase and publish it immediately."""
        with self._lock:
            operation.phase = phase
        self._publish(operation, force=True)

    def _publish(self, operation: _Operation, *, force: bool) -> None:
        """Publish one snapshot, dropping unforced updates while debounced."""
        with self._lock:
            elapsed = time.monotonic() - operation.last_published
            if not force and elapsed < _EMIT_INTERVAL_SECONDS:
                return
            operation.last_published = time.monotonic()
            operation.updated_at = _now_ms()
            payload = self._record_locked(operation)
        try:
            self.emitter.emit("envInstall.progress", payload)
        except (OSError, ValueError):
            pass  # Keep the installation running when its stream is unusable.

    def _record_locked(self, operation: _Operation) -> dict[str, Any]:
        """Build one bounded snapshot. Call this while holding the lock."""
        return {
            "operationId": operation.operation_id,
            "checkId": operation.check_id,
            "projectId": operation.project.project_id,
            "projectEpoch": operation.project.epoch,
            "phase": operation.phase,
            "startedAt": operation.started_at,
            "updatedAt": operation.updated_at or operation.started_at,
            "output": operation.output,
            "rc": operation.rc,
            "stdout": operation.stdout,
            "stderr": operation.stderr,
        }

    def _prune_locked(self) -> None:
        """Retain active operations plus the most recent settled ones."""
        settled = [
            operation_id
            for operation_id, operation in self._operations.items()
            if operation.phase in _TERMINAL_PHASES
        ]
        for operation_id in settled[: max(0, len(settled) - _MAX_OPERATION_HISTORY)]:
            operation = self._operations.pop(operation_id, None)
            if (
                operation is not None
                and self._active_by_project.get(operation.project.project_id)
                == operation_id
            ):
                self._active_by_project.pop(operation.project.project_id, None)
