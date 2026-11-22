"""Tests for provisioning persistence, queue ownership, cancellation, and restart bounds."""

from __future__ import annotations

import json
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import provisioning
from supraspina_sidecar.adapters import pybrainage, tools
from supraspina_sidecar.authorization import AuthorizationLedger
from supraspina_sidecar.project import ProjectEpochs, ProjectIdentity
from supraspina_sidecar.provisioning import ProvisionManager, _Operation


class _Emitter:
    def __init__(self, *, fail: bool = False) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.fail = fail

    def emit(self, method: str, params: dict[str, Any]) -> None:
        if self.fail:
            raise OSError("Treat the renderer as detached.")
        self.events.append((method, params))


class _Workflow:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.released: list[dict[str, Any]] = []

    def emit_provision(self, _project: ProjectIdentity, status: dict[str, Any]) -> None:
        self.events.append(status)

    def process_owner_record(self, **kwargs: Any) -> dict[str, Any]:
        operation_id = str(kwargs["operation_id"])
        return {
            "schemaVersion": 1,
            "claimId": f"claim-{operation_id}",
            "generation": 1,
            "operationKind": "provision",
            "ownerId": operation_id,
            "projectId": kwargs["project"].project_id,
            "projectEpoch": kwargs["project"].epoch,
            "runId": None,
            "jobId": None,
            "operationId": operation_id,
            "pid": 4242,
            "pgid": 4242,
            "startIdentity": "test:4242",
            "state": "claiming",
            "provedStopped": False,
        }

    def announce_process_started(self, owner: dict[str, Any], _proc: Any) -> int:
        owner["state"] = "accepted"
        owner["accepted"] = True
        return int(owner["pgid"])

    def announce_process_settled(
        self, _operation_id: str, _proc: Any, _pgid: Any
    ) -> bool:
        return True

    def release_process_owner(self, owner: dict[str, Any]) -> None:
        self.released.append(owner)

    def reconcile_process_owner(
        self, owner: dict[str, Any]
    ) -> tuple[str, dict[str, Any]]:
        if owner.get("schemaVersion") != 1:
            return "unknown", {**owner, "state": "unknown", "provedStopped": False}
        return "stopped", {**owner, "state": "settled", "provedStopped": True}


def _project(root: Path, *, project_id: str = "provision-boundary") -> dict[str, Any]:
    return {
        "projectId": project_id,
        "root": str(root),
        "configPath": str(root / "supraspina.project.json"),
        "epoch": 1,
    }


def _identity(root: Path, *, project_id: str = "provision-boundary") -> ProjectIdentity:
    raw = _project(root, project_id=project_id)
    return ProjectIdentity(
        raw["projectId"], raw["root"], raw["configPath"], raw["epoch"]
    )


def _cfg(root: Path) -> tuple[dict[str, Any], tuple[Path, Path, Path]]:
    python = root / "env" / "bin" / "python"
    model = root / "models" / "model.pkl"
    scaler = root / "models" / "scaler.pkl"
    return (
        {
            "paths": {"projectRoot": str(root), "outputDir": str(root / "out")},
            "tools": {"pythonExecutable": str(python)},
            "steps": {
                "pybrainage": {
                    "enabled": True,
                    "params": {
                        "pythonExecutable": str(python),
                        "modelPath": str(model),
                        "scalerPath": str(scaler),
                    },
                }
            },
        },
        (python, model, scaler),
    )


def _operation(root: Path, *, project_id: str = "provision-boundary") -> _Operation:
    cfg, _paths = _cfg(root)
    return _Operation(
        operation_id=f"operation-{project_id}",
        project=_identity(root, project_id=project_id),
        cfg=cfg,
        config_revision=3,
        sha256=pybrainage.PYBRAINAGE_ZENODO_SHA256,
    )


def _manager(
    emitter: _Emitter | None = None,
) -> tuple[ProvisionManager, ProjectEpochs, _Workflow]:
    projects = ProjectEpochs()
    workflow = _Workflow()
    return (
        ProvisionManager(
            emitter or _Emitter(), projects, AuthorizationLedger(), workflow
        ),
        projects,
        workflow,
    )


def test_state_write_rejects_oversize_and_cleans_temporary_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    identity = _identity(tmp_path)
    monkeypatch.setattr(provisioning, "_MAX_STATE_BYTES", 10)
    with pytest.raises(OSError, match="within its persistence bound"):
        provisioning._write_state(
            identity, {"message": "Exceed the persistence size bound."}
        )
    assert list((tmp_path / ".supraspina").glob(".provision.tmp-*")) == []

    monkeypatch.setattr(provisioning, "_MAX_STATE_BYTES", 10_000)
    monkeypatch.setattr(
        provisioning.os,
        "replace",
        lambda *_args: (_ for _ in ()).throw(OSError("Simulate a replace fault.")),
    )
    with pytest.raises(OSError, match="Simulate a replace fault"):
        provisioning._write_state(identity, {"message": "small"})
    assert list((tmp_path / ".supraspina").glob(".provision.tmp-*")) == []


def test_state_read_handles_missing_unsafe_invalid_and_mismatched_records(
    tmp_path: Path,
) -> None:
    identity = _identity(tmp_path)
    assert provisioning._read_state(identity) is None
    path = Path(provisioning._state_path(identity))
    path.parent.mkdir(parents=True)
    path.write_text("not-json", encoding="utf-8")
    assert provisioning._read_state(identity)["phase"] == "error"

    path.write_text("[]", encoding="utf-8")
    assert provisioning._read_state(identity)["processOwnership"]["state"] == "unknown"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 99,
                "projectId": identity.project_id,
                "phase": "done",
            }
        ),
        encoding="utf-8",
    )
    assert provisioning._read_state(identity)["processOwnership"]["state"] == "unknown"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "projectId": "different",
                "phase": "done",
            }
        ),
        encoding="utf-8",
    )
    assert provisioning._read_state(identity)["processOwnership"]["state"] == "unknown"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "projectId": identity.project_id,
                "phase": "unexpected",
            }
        ),
        encoding="utf-8",
    )
    assert provisioning._read_state(identity)["processOwnership"]["state"] == "unknown"


def test_state_read_rejects_symlink_without_following_it(tmp_path: Path) -> None:
    identity = _identity(tmp_path)
    path = Path(provisioning._state_path(identity))
    path.parent.mkdir(parents=True)
    outside = tmp_path / "outside.json"
    outside.write_text("{}", encoding="utf-8")
    try:
        path.symlink_to(outside)
    except OSError:
        pytest.skip("Run this test only where symlinks are available.")

    assert provisioning._read_state(identity)["phase"] == "error"


@pytest.mark.parametrize(
    ("request_value", "message"),
    [
        ({}, "Provide cfg for provisioning"),
        ({"cfg": {}}, "Provide configRevision for provisioning"),
    ],
)
def test_start_and_status_require_explicit_config_and_revision(
    request_value: dict[str, Any], message: str
) -> None:
    manager, _projects, _workflow = _manager()
    with pytest.raises(ValueError, match=message):
        manager.start(request_value)
    with pytest.raises(
        ValueError, match=message.replace("provisioning", "provision.status")
    ):
        manager.status(request_value)


def _authorization(project_id: str, revision: int) -> dict[str, Any]:
    return {
        "token": f"opaque-{project_id}-{revision}-authorization",
        "projectId": project_id,
        "configRevision": revision,
        "purpose": "provision",
    }


def test_start_rejects_digest_override_duplicate_and_persistence_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg, _paths = _cfg(tmp_path)
    manager, projects, _workflow = _manager()
    projects.validate(_project(tmp_path), cfg)
    request = {
        "project": _project(tmp_path),
        "cfg": cfg,
        "configRevision": 3,
        "authorization": _authorization("provision-boundary", 3),
        "sha256": "different",
    }
    with pytest.raises(ValueError, match="archive SHA-256 unchanged"):
        manager.start(request)

    active = _operation(tmp_path)
    manager._operations[active.operation_id] = active
    manager._by_project[active.project.project_id] = active.operation_id
    request["sha256"] = pybrainage.PYBRAINAGE_ZENODO_SHA256
    with pytest.raises(ValueError, match="active project provisioning"):
        manager.start(request)

    active.phase = "done"
    active.terminal_persisted = True
    active.completed.set()
    request["authorization"] = _authorization("provision-boundary", 3)
    request["authorization"]["token"] += "-new"
    monkeypatch.setattr(
        manager,
        "_persist_operation",
        lambda _operation, **_kwargs: (_ for _ in ()).throw(
            OSError("Simulate a full disk.")
        ),
    )
    with pytest.raises(RuntimeError, match="writable provisioning-status storage"):
        manager.start(request)
    assert manager.active_count() == 0


def test_project_active_count_and_pruning_keep_current_terminal_projection(
    tmp_path: Path,
) -> None:
    manager, _projects, _workflow = _manager()
    operations = OrderedDict()
    for index in range(66):
        operation = _operation(tmp_path, project_id=f"project-{index}")
        operation.operation_id = f"operation-{index}"
        operation.phase = "done"
        operation.terminal_persisted = True
        operation.completed.set()
        operations[operation.operation_id] = operation
        manager._by_project[operation.project.project_id] = operation.operation_id
    running = _operation(tmp_path, project_id="running-project")
    operations[running.operation_id] = running
    manager._by_project[running.project.project_id] = running.operation_id
    unknown = _operation(tmp_path, project_id="unknown-project")
    unknown.phase = "error"
    unknown.process_ownership = {
        "state": "unknown",
        "provedStopped": False,
    }
    operations[unknown.operation_id] = unknown
    manager._by_project[unknown.project.project_id] = unknown.operation_id
    manager._operations = operations

    assert manager.project_active("running-project") is True
    assert manager.project_active("unknown-project") is True
    assert manager.project_active("project-65") is False
    assert manager.active_count() == 2
    manager._prune_locked()
    assert len(manager._operations) == 66
    assert running.operation_id in manager._operations
    assert unknown.operation_id in manager._operations
    assert "project-0" not in manager._by_project
    assert "project-1" not in manager._by_project


def test_unproved_ownership_never_projects_a_terminal_operation(
    tmp_path: Path,
) -> None:
    manager, projects, _workflow = _manager()
    cfg, _paths = _cfg(tmp_path)
    project = projects.validate(_project(tmp_path), cfg)
    operation = _operation(tmp_path)
    operation.project = project
    operation.process_ownership = {
        "schemaVersion": 1,
        "state": "accepted",
        "provedStopped": False,
    }
    manager._operations[operation.operation_id] = operation
    manager._by_project[project.project_id] = operation.operation_id
    assert manager.status_for(operation)["cancellable"] is True
    operation.phase = "error"
    operation.terminal_persisted = True
    operation.completed.set()

    status = manager.status_for(operation)

    assert status["phase"] == "running"
    assert status["cancellable"] is False
    assert manager.project_active(project.project_id) is True
    assert manager.active_count() == 1

    record = manager._record_for(operation)
    record["processOwnership"]["state"] = "settled"
    provisioning._write_state(project, record)
    restarted, restarted_projects, restarted_workflow = _manager()
    restarted_projects.validate(_project(tmp_path), cfg)
    restarted_workflow.reconcile_process_owner = lambda ownership: (
        "stopped",
        ownership,
    )

    recovered = restarted.status(
        {
            "project": _project(tmp_path),
            "cfg": cfg,
            "configRevision": operation.config_revision,
        }
    )

    assert recovered["phase"] == "running"
    assert recovered["cancellable"] is False
    assert restarted.project_active(project.project_id) is True


@pytest.mark.parametrize(
    ("fraction", "phase", "percent"),
    [(0.1, "env", 10), (0.5, "download", 50), (0.9, "validate", 90)],
)
def test_run_progress_maps_fraction_to_phase_and_terminal_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fraction: float,
    phase: str,
    percent: int,
) -> None:
    emitter = _Emitter()
    manager, _projects, _workflow = _manager(emitter)
    operation = _operation(tmp_path)
    monkeypatch.setattr(
        manager, "_persist_operation", lambda _operation, **_kwargs: None
    )

    def execute(_cfg: dict[str, Any], progress: Any, **_kwargs: Any) -> dict[str, Any]:
        progress("progress", fraction)
        return {"ok": False, "message": str(tmp_path / "private-failure")}

    monkeypatch.setattr(pybrainage, "execute_provision", execute)

    manager._run(operation)

    progress_events = [
        params for method, params in emitter.events if method == "provision.progress"
    ]
    assert progress_events[0]["phase"] == phase
    assert progress_events[0]["percent"] == percent
    assert progress_events[-1]["phase"] == "error"
    assert str(tmp_path) not in str(operation.error)


def test_run_forwards_the_staged_archive_path_to_the_verifier(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reject a verifier that cannot accept execute_provision's archive_path."""
    manager, _projects, _workflow = _manager()
    operation = _operation(tmp_path)
    monkeypatch.setattr(
        manager, "_persist_operation", lambda _operation, **_kwargs: None
    )
    seen: dict[str, Any] = {}
    staged = str(tmp_path / "PyBrainAge.zip")

    def verify_model(
        cfg: dict[str, Any],
        expected_sha256: str = pybrainage.PYBRAINAGE_ZENODO_SHA256,
        cancelled: Any = None,
        *,
        archive_path: str | None = None,
    ) -> tools.RunResult:
        seen["cfg"] = cfg
        seen["expected"] = expected_sha256
        seen["archive_path"] = archive_path
        return tools.RunResult(rc=0, stdout="", stderr="")

    def extract_model(cfg: dict[str, Any], _cancelled: Any = None) -> tools.RunResult:
        seen["extracted"] = cfg
        return tools.RunResult(rc=0, stdout="", stderr="")

    monkeypatch.setattr(pybrainage, "verify_model", verify_model)
    monkeypatch.setattr(pybrainage, "extract_model", extract_model)

    def execute(cfg: dict[str, Any], _progress: Any, **kwargs: Any) -> dict[str, Any]:
        # Call the injected callbacks exactly as execute_provision calls them.
        verified = kwargs["verifier"](
            cfg, pybrainage.PYBRAINAGE_ZENODO_SHA256, archive_path=staged
        )
        assert verified.rc == 0
        assert kwargs["extractor"](cfg).rc == 0
        return {"ok": True}

    monkeypatch.setattr(pybrainage, "execute_provision", execute)

    manager._run(operation)

    assert seen["archive_path"] == staged
    assert seen["expected"] == pybrainage.PYBRAINAGE_ZENODO_SHA256
    assert "extracted" in seen
    assert operation.error is None


def test_run_honors_preexisting_cancel_and_exception_cancellation_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _projects, _workflow = _manager()
    monkeypatch.setattr(
        manager, "_persist_operation", lambda _operation, **_kwargs: None
    )
    operation = _operation(tmp_path)
    operation.cancel.set()
    monkeypatch.setattr(
        pybrainage,
        "execute_provision",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("Raise the fixture failure.")
        ),
    )

    manager._run(operation)

    assert operation.phase == "cancelled"
    assert operation.error == "RuntimeError: provisioning failed"


def test_emit_progress_tolerates_detached_renderer_and_marks_persistence_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _projects, workflow = _manager(_Emitter(fail=True))
    operation = _operation(tmp_path)
    monkeypatch.setattr(
        manager,
        "_persist_operation",
        lambda _operation, **_kwargs: (_ for _ in ()).throw(
            OSError("Simulate a full disk.")
        ),
    )

    assert manager._emit_progress(operation, "download", 50, "private") is False
    assert operation.phase == "running"
    assert operation.error == "Choose writable storage for provisioning status."
    assert operation.completed.is_set() is False
    assert workflow.events == []


def test_status_reports_partial_readiness_and_running_operation(
    tmp_path: Path,
) -> None:
    cfg, (python, model, _scaler) = _cfg(tmp_path)
    python.parent.mkdir(parents=True)
    python.write_text("python", encoding="utf-8")
    python.chmod(0o755)
    model.parent.mkdir(parents=True)
    model.write_text("model", encoding="utf-8")
    manager, projects, _workflow = _manager()
    project = projects.validate(_project(tmp_path), cfg)
    operation = _operation(tmp_path)
    operation.project = project
    manager._operations[operation.operation_id] = operation
    manager._by_project[project.project_id] = operation.operation_id

    status = manager.status(
        {"project": _project(tmp_path), "cfg": cfg, "configRevision": 3}
    )

    assert status["envReady"] is False
    assert status["modelReady"] is False
    assert status["pythonExecutable"] is None
    assert status["modelPath"] is None
    assert status["scalerPath"] is None
    assert status["phase"] == "running"
    assert status["cancellable"] is True


def test_bootstrap_none_unknown_cancel_and_shutdown_lifecycle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, projects, _workflow = _manager()
    projects.validate(_project(tmp_path))
    assert manager.bootstrap_status({"project": _project(tmp_path)}) is None
    assert manager.cancel(
        {"project": _project(tmp_path), "operationId": "unknown"}
    ) == {"operationId": "unknown", "accepted": False, "terminal": True}

    running = _operation(tmp_path)
    done = _operation(tmp_path, project_id="other-project")
    done.phase = "done"
    done.terminal_persisted = True
    done.completed.set()
    manager._operations = {
        running.operation_id: running,
        done.operation_id: done,
    }
    calls: list[str] = []
    monkeypatch.setattr(
        manager,
        "cancel",
        lambda request, timeout=5.0: calls.append(request["operationId"]) or {},
    )

    manager.shutdown(timeout=0.01)

    assert calls == [running.operation_id]


def test_cancel_terminates_owned_process_and_returns_bounded_pending_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, projects, _workflow = _manager()
    cfg, _paths = _cfg(tmp_path)
    project = projects.validate(_project(tmp_path), cfg)
    operation = _operation(tmp_path)
    operation.project = project
    operation.process = object()
    manager._operations[operation.operation_id] = operation
    manager._by_project[project.project_id] = operation.operation_id
    terminated: list[tuple[Any, bool]] = []
    monkeypatch.setattr(
        provisioning,
        "_terminate_tree",
        lambda proc, *, force=False: terminated.append((proc, force)),
    )

    class _Timer:
        daemon = False

        def __init__(self, _delay: float, callback: Any) -> None:
            self.callback = callback

        def start(self) -> None:
            self.callback()

    monkeypatch.setattr(provisioning.threading, "Timer", _Timer)

    result = manager.cancel(
        {"project": _project(tmp_path), "operationId": operation.operation_id},
        timeout=0,
    )

    assert result == {
        "operationId": operation.operation_id,
        "accepted": True,
        "terminal": False,
    }
    assert operation.cancel.is_set()
    assert terminated == [(operation.process, False), (operation.process, True)]


def test_windows_termination_cannot_consume_the_cancellation_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, projects, _workflow = _manager()
    cfg, _paths = _cfg(tmp_path)
    project = projects.validate(_project(tmp_path), cfg)
    operation = _operation(tmp_path)
    operation.project = project
    operation.process = object()
    manager._operations[operation.operation_id] = operation
    manager._by_project[project.project_id] = operation.operation_id
    termination_started = threading.Event()
    release_termination = threading.Event()

    def block_termination(_proc: Any, *, force: bool = False) -> None:
        del force
        termination_started.set()
        release_termination.wait(timeout=2)

    class _Timer:
        daemon = False

        def __init__(self, _delay: float, _callback: Any) -> None:
            return

        def start(self) -> None:
            return

    monkeypatch.setattr(provisioning, "_BACKGROUND_TERMINATION", True)
    monkeypatch.setattr(provisioning, "_terminate_tree", block_termination)
    monkeypatch.setattr(provisioning.threading, "Timer", _Timer)

    started_at = provisioning.time.monotonic()
    result = manager.cancel(
        {"project": _project(tmp_path), "operationId": operation.operation_id},
        timeout=0.02,
    )
    elapsed = provisioning.time.monotonic() - started_at

    assert termination_started.wait(timeout=1)
    release_termination.set()
    assert result["terminal"] is False
    assert elapsed < 0.2


def test_shutdown_shares_one_timeout_across_all_operations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _projects, _workflow = _manager()
    first = _operation(tmp_path, project_id="first-project")
    second = _operation(tmp_path, project_id="second-project")
    manager._operations = {
        first.operation_id: first,
        second.operation_id: second,
    }
    clock = {"now": 10.0}
    timeouts: list[float] = []

    def cancel(_request: dict[str, Any], timeout: float = 5.0) -> dict[str, Any]:
        timeouts.append(timeout)
        clock["now"] += 0.75
        return {"accepted": True, "terminal": False}

    monkeypatch.setattr(provisioning.time, "monotonic", lambda: clock["now"])
    monkeypatch.setattr(manager, "cancel", cancel)

    manager.shutdown(timeout=1.0)

    assert timeouts == [1.0, 0.25]


def test_fsync_directory_is_a_windows_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []
    monkeypatch.setattr(provisioning.os, "name", "nt")
    monkeypatch.setattr(
        provisioning.os, "open", lambda path, _flags: opened.append(path)
    )

    provisioning._fsync_directory("C:\\project")

    assert opened == []


class _ProvisionProc:
    def __init__(self) -> None:
        self.returncode = 0
        self.waited = False
        self.stdout = iter(["provision output"])

    def poll(self) -> int | None:
        return self.returncode if self.waited else None

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        self.waited = True
        return self.returncode


@pytest.mark.parametrize("cancel_after_release", [False, True])
def test_run_runner_owns_process_and_settles_success_or_late_cancellation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    cancel_after_release: bool,
) -> None:
    manager, _projects, workflow = _manager()
    operation = _operation(tmp_path)
    proc = _ProvisionProc()
    terminated: list[tuple[Any, bool]] = []
    monkeypatch.setattr(
        manager, "_persist_operation", lambda _operation, **_kwargs: None
    )
    monkeypatch.setattr(provisioning, "_spawn", lambda _argv, _cfg, **_options: proc)
    monkeypatch.setattr(
        provisioning,
        "_release_spawn",
        lambda _proc: operation.cancel.set() if cancel_after_release else None,
    )
    monkeypatch.setattr(
        provisioning,
        "_terminate_tree",
        lambda owned, *, force=False: terminated.append((owned, force)),
    )

    def execute(_cfg: dict[str, Any], progress: Any, **kwargs: Any) -> dict[str, Any]:
        progress("creating environment", 0.2)
        result = kwargs["runner"](["python", "-m", "venv"])
        assert result.stdout == "provision output"
        return {"ok": result.rc == 0}

    monkeypatch.setattr(pybrainage, "execute_provision", execute)

    manager._run(operation)

    assert operation.process is None
    assert len(workflow.events) >= 2
    if cancel_after_release:
        assert operation.phase == "cancelled"
        assert terminated == [(proc, False)]
    else:
        assert operation.phase == "done"
        assert proc.waited is True
        assert terminated == []


def test_run_pre_cancelled_runner_and_progress_never_spawn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _projects, _workflow = _manager()
    operation = _operation(tmp_path)
    operation.cancel.set()
    spawned: list[list[str]] = []
    monkeypatch.setattr(
        manager, "_persist_operation", lambda _operation, **_kwargs: None
    )
    monkeypatch.setattr(
        provisioning,
        "_spawn",
        lambda argv, _cfg, **_options: spawned.append(argv),
    )

    def execute(_cfg: dict[str, Any], progress: Any, **kwargs: Any) -> dict[str, Any]:
        progress("ignored after cancellation", 0.4)
        result = kwargs["runner"](["must-not-spawn"])
        assert result.rc == 130
        assert result.stderr == "cancelled"
        return {"ok": False}

    monkeypatch.setattr(pybrainage, "execute_provision", execute)

    manager._run(operation)

    assert spawned == []
    assert operation.phase == "cancelled"


def test_new_operation_states_that_provisioning_has_not_started(
    tmp_path: Path,
) -> None:
    assert _operation(tmp_path).message == "Provisioning has not started yet."


def test_canceled_setup_publishes_and_persists_a_factual_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    emitter = _Emitter()
    manager, _projects, _workflow = _manager(emitter)
    operation = _operation(tmp_path)
    operation.cancel.set()
    persisted: list[dict[str, Any]] = []
    monkeypatch.setattr(
        manager,
        "_persist_operation",
        lambda _operation, **kwargs: persisted.append(dict(kwargs.get("record", {}))),
    )
    monkeypatch.setattr(
        pybrainage, "execute_provision", lambda *_args, **_kwargs: {"ok": False}
    )

    manager._run(operation)

    canceled = "PyBrainAge setup was canceled."
    # PyBrainAge setup shows the terminal progress message as its status line.
    progress = [
        params for method, params in emitter.events if method == "provision.progress"
    ]
    lines = [
        params["line"] for method, params in emitter.events if method == "provision.log"
    ]
    assert operation.phase == "cancelled"
    assert operation.message == canceled
    assert progress[-1]["message"] == canceled
    assert lines[-1] == canceled
    assert persisted[-1]["phase"] == "cancelled"
    assert persisted[-1]["message"] == canceled


def test_run_stops_when_progress_persistence_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, _projects, _workflow = _manager()
    operation = _operation(tmp_path)
    emitted = 0

    def emit_progress(*_args: Any, **_kwargs: Any) -> bool:
        nonlocal emitted
        emitted += 1
        return False

    monkeypatch.setattr(manager, "_emit_progress", emit_progress)
    monkeypatch.setattr(
        manager, "_persist_operation", lambda _operation, **_kwargs: None
    )

    def execute(_cfg: dict[str, Any], progress: Any, **_kwargs: Any) -> dict[str, Any]:
        progress("cannot persist", 0.5)
        raise AssertionError("Stop execution after progress persistence fails.")

    monkeypatch.setattr(pybrainage, "execute_provision", execute)

    manager._run(operation)

    assert emitted == 1
    assert operation.phase == "error"
    assert operation.terminal_persisted is True
    assert operation.completed.is_set() is True


def test_reconciled_record_retains_owned_run_and_bootstrap_routes_full_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, projects, _workflow = _manager()
    cfg, _paths = _cfg(tmp_path)
    project = projects.validate(_project(tmp_path), cfg)
    operation = _operation(tmp_path)
    operation.project = project
    manager._operations[operation.operation_id] = operation
    provisioning._write_state(project, manager._record_for(operation))

    record = manager._reconciled_record(project)

    assert record is not None
    assert record["phase"] == "running"
    expected = {"phase": "synthetic-status"}
    monkeypatch.setattr(manager, "status", lambda _request: expected)
    assert (
        manager.bootstrap_status(
            {
                "project": _project(tmp_path),
                "cfg": cfg,
                "configRevision": 3,
            }
        )
        is expected
    )


def test_cancel_without_process_waits_until_operation_becomes_terminal(
    tmp_path: Path,
) -> None:
    manager, projects, _workflow = _manager()
    cfg, _paths = _cfg(tmp_path)
    project = projects.validate(_project(tmp_path), cfg)
    operation = _operation(tmp_path)
    operation.project = project
    operation.process = None
    manager._operations[operation.operation_id] = operation

    def settle() -> None:
        with manager._lock:
            operation.phase = "cancelled"
            operation.terminal_persisted = True
            operation.completed.set()

    timer = threading.Timer(0.01, settle)
    timer.start()

    try:
        result = manager.cancel(
            {"project": _project(tmp_path), "operationId": operation.operation_id},
            timeout=1,
        )
    finally:
        timer.cancel()
        timer.join(timeout=1)

    assert result == {
        "operationId": operation.operation_id,
        "accepted": True,
        "terminal": True,
    }


def test_cancel_never_projects_an_unpersisted_terminal_phase(
    tmp_path: Path,
) -> None:
    manager, projects, _workflow = _manager()
    cfg, _paths = _cfg(tmp_path)
    project = projects.validate(_project(tmp_path), cfg)
    operation = _operation(tmp_path)
    operation.project = project
    operation.phase = "cancelled"
    operation.terminal_persisted = False
    manager._operations[operation.operation_id] = operation
    manager._by_project[project.project_id] = operation.operation_id

    request = {
        "project": _project(tmp_path),
        "operationId": operation.operation_id,
    }
    assert manager.cancel(request, timeout=0)["terminal"] is False
    assert manager.project_active(project.project_id) is True
    assert manager.active_count() == 1

    operation.terminal_persisted = True
    operation.completed.set()
    assert manager.cancel(request, timeout=0)["terminal"] is True
    assert manager.project_active(project.project_id) is False
    assert manager.active_count() == 0


def _install_terminal_persistence_barrier(
    manager: ProvisionManager,
    workflow: _Workflow,
    emitter: _Emitter,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[threading.Event, threading.Event, list[str]]:
    terminal_write_started = threading.Event()
    release_terminal_write = threading.Event()
    order: list[str] = []
    original_persist = manager._persist_operation

    def persist(candidate: _Operation, *, record: dict[str, Any] | None = None) -> None:
        snapshot = manager._record_for(candidate) if record is None else record
        if snapshot["phase"] == "done":
            terminal_write_started.set()
            if not release_terminal_write.wait(timeout=2):
                raise OSError(
                    "Reach the terminal persistence barrier before its timeout."
                )
        original_persist(candidate, record=record)
        if snapshot["phase"] == "done":
            order.append("persist")

    def release_owner(owner: dict[str, Any]) -> None:
        workflow.released.append(owner)
        order.append("release")

    def emit(method: str, params: dict[str, Any]) -> None:
        emitter.events.append((method, params))
        if method == "provision.progress":
            order.append("progress")

    def emit_provision(
        _project_identity: ProjectIdentity, status: dict[str, Any]
    ) -> None:
        workflow.events.append(status)
        order.append("runtime")

    monkeypatch.setattr(manager, "_persist_operation", persist)
    monkeypatch.setattr(workflow, "release_process_owner", release_owner)
    monkeypatch.setattr(workflow, "emit_provision", emit_provision)
    monkeypatch.setattr(emitter, "emit", emit)
    return terminal_write_started, release_terminal_write, order


def test_terminal_persistence_barrier_blocks_acknowledgement_and_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    emitter = _Emitter()
    manager, projects, workflow = _manager(emitter)
    cfg, _paths = _cfg(tmp_path)
    project = projects.validate(_project(tmp_path), cfg)
    operation = _operation(tmp_path)
    operation.project = project
    operation.process_ownership = {
        "schemaVersion": 1,
        "state": "settled",
        "provedStopped": True,
    }
    manager._operations[operation.operation_id] = operation
    manager._by_project[project.project_id] = operation.operation_id
    manager._persist_operation(operation)

    terminal_write_started, release_terminal_write, order = (
        _install_terminal_persistence_barrier(
            manager,
            workflow,
            emitter,
            monkeypatch,
        )
    )
    monkeypatch.setattr(
        pybrainage,
        "execute_provision",
        lambda *_args, **_kwargs: {"ok": True, "message": ""},
    )

    worker = threading.Thread(target=manager._run, args=(operation,), daemon=True)
    worker.start()
    assert terminal_write_started.wait(timeout=1)

    request = {
        "project": _project(tmp_path),
        "operationId": operation.operation_id,
    }
    assert manager.cancel(request, timeout=0)["terminal"] is False
    assert provisioning._read_state(project)["phase"] == "running"
    assert manager.status_for(operation)["phase"] == "running"
    assert operation.completed.is_set() is False
    assert manager.project_active(project.project_id) is True
    assert manager.active_count() == 1
    assert emitter.events == []
    assert workflow.events == []
    assert workflow.released == []

    terminal_result: list[dict[str, Any]] = []
    waiter = threading.Thread(
        target=lambda: terminal_result.append(manager.cancel(request, timeout=1)),
        daemon=True,
    )
    waiter.start()
    waiter.join(timeout=0.05)
    assert waiter.is_alive()

    release_terminal_write.set()
    worker.join(timeout=2)
    waiter.join(timeout=2)

    assert worker.is_alive() is False
    assert waiter.is_alive() is False
    assert terminal_result == [
        {
            "operationId": operation.operation_id,
            "accepted": True,
            "terminal": True,
        }
    ]
    stored = provisioning._read_state(project)
    assert stored["phase"] == "done"
    assert stored["processOwnership"]["provedStopped"] is True
    assert operation.completed.is_set() is True
    assert manager.project_active(project.project_id) is False
    assert manager.active_count() == 0
    assert order == ["persist", "release", "progress", "runtime"]


def test_terminal_publication_precedes_replacement_running_projection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    emitter = _Emitter()
    manager, projects, workflow = _manager(emitter)
    cfg, _paths = _cfg(tmp_path)
    project = projects.validate(_project(tmp_path), cfg)
    operation = _operation(tmp_path)
    operation.project = project
    manager._operations[operation.operation_id] = operation
    manager._by_project[project.project_id] = operation.operation_id
    manager._persist_operation(operation)
    terminal_publication_started = threading.Event()
    release_terminal_publication = threading.Event()

    def emit_provision(
        _project_identity: ProjectIdentity, status: dict[str, Any]
    ) -> None:
        workflow.events.append(status)
        if (
            status["operationId"] == operation.operation_id
            and status["phase"] == "done"
        ):
            terminal_publication_started.set()
            assert release_terminal_publication.wait(timeout=2)

    monkeypatch.setattr(workflow, "emit_provision", emit_provision)
    monkeypatch.setattr(
        pybrainage,
        "execute_provision",
        lambda *_args, **_kwargs: {"ok": True, "message": ""},
    )
    worker = threading.Thread(target=manager._run, args=(operation,), daemon=True)
    worker.start()
    assert terminal_publication_started.wait(timeout=1)

    blocked_request = {
        "project": _project(tmp_path),
        "cfg": cfg,
        "configRevision": 3,
        "authorization": {
            **_authorization(project.project_id, 3),
            "token": "blocked-replacement-authorization",
        },
    }
    with pytest.raises(ValueError, match="active project provisioning"):
        manager.start(blocked_request)

    release_terminal_publication.set()
    worker.join(timeout=2)
    assert worker.is_alive() is False
    monkeypatch.setattr(provisioning.threading.Thread, "start", lambda _self: None)
    replacement = manager.start(
        {
            **blocked_request,
            "authorization": {
                **blocked_request["authorization"],
                "token": "accepted-replacement-authorization",
            },
        }
    )

    assert workflow.events[-1]["operationId"] == replacement["operationId"]
    assert workflow.events[-1]["phase"] == "running"
    assert (
        manager.status(
            {"project": _project(tmp_path), "cfg": cfg, "configRevision": 3}
        )["phase"]
        == "running"
    )


def test_wrong_cancel_id_and_unreconciled_store_never_claim_false_idle(
    tmp_path: Path,
) -> None:
    manager, projects, _workflow = _manager()
    cfg, _paths = _cfg(tmp_path)
    project = projects.validate(_project(tmp_path), cfg)
    operation = _operation(tmp_path)
    operation.project = project
    manager._operations[operation.operation_id] = operation
    manager._by_project[project.project_id] = operation.operation_id

    wrong = manager.cancel(
        {"project": _project(tmp_path), "operationId": "stale-operation"},
        timeout=0,
    )

    assert wrong == {
        "operationId": "stale-operation",
        "accepted": False,
        "terminal": False,
    }

    manager._operations.clear()
    manager._by_project.clear()
    ownership = {
        "schemaVersion": 99,
        "state": "accepted",
        "provedStopped": False,
    }
    record = manager._record_for(operation)
    record["processOwnership"] = ownership
    provisioning._write_state(project, record)

    persisted = manager.cancel(
        {"project": _project(tmp_path), "operationId": operation.operation_id},
        timeout=0,
    )

    assert persisted == {
        "operationId": operation.operation_id,
        "accepted": False,
        "terminal": False,
    }
    assert manager.project_active(project.project_id) is True
