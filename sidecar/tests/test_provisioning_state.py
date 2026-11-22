"""Tests for project-scoped provisioning persistence and restart reconciliation."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.adapters import pybrainage
from supraspina_sidecar.authorization import AuthorizationLedger
from supraspina_sidecar.project import ProjectEpochs, ProjectIdentity
from supraspina_sidecar.provisioning import (
    ProvisionManager,
    _Operation,
    _read_state,
    _write_state,
)
from supraspina_sidecar.workflow_manager import WorkflowManager


class _Emitter:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def emit(self, method: str, params: dict[str, Any]) -> None:
        self.events.append((method, params))


class _Workflow:
    def __init__(self) -> None:
        self.provision_events: list[tuple[ProjectIdentity, dict[str, Any]]] = []

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

    def announce_process_settled(self, _job_id: str, _proc: Any, _pgid: Any) -> bool:
        return True

    def release_process_owner(self, _owner: dict[str, Any]) -> None:
        return None

    def reconcile_process_owner(
        self, owner: dict[str, Any]
    ) -> tuple[str, dict[str, Any]]:
        if owner.get("schemaVersion") != 1:
            return "unknown", {**owner, "state": "unknown", "provedStopped": False}
        return "stopped", {**owner, "state": "settled", "provedStopped": True}

    def emit_provision(self, project: ProjectIdentity, status: dict[str, Any]) -> None:
        self.provision_events.append((project, status))


def _project(root: Path, *, epoch: int = 2) -> dict[str, Any]:
    return {
        "projectId": "project-provision",
        "root": str(root),
        "configPath": str(root / "supraspina.project.json"),
        "epoch": epoch,
    }


def _cfg(root: Path, suffix: str = "ready") -> tuple[dict[str, Any], list[Path]]:
    python = root / suffix / "bin" / "python"
    model = root / suffix / "model.pkl"
    scaler = root / suffix / "scaler.pkl"
    cfg = {
        "paths": {
            "projectRoot": str(root),
            "outputDir": str(root / "derivatives"),
        },
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
    }
    return cfg, [python, model, scaler]


def _create_ready(paths: list[Path]) -> None:
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"ready")
    paths[0].chmod(0o755)


def _operation(root: Path, cfg: dict[str, Any]) -> _Operation:
    return _Operation(
        operation_id="provision-persistence",
        project=ProjectIdentity(
            "project-provision",
            str(root.resolve()),
            str((root / "supraspina.project.json").resolve()),
            2,
        ),
        cfg=cfg,
        config_revision=7,
        sha256=pybrainage.PYBRAINAGE_ZENODO_SHA256,
    )


def test_status_reconciles_orphaned_running_state_and_recomputes_exact_paths(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg, paths = _cfg(root)
    _create_ready(paths)
    identity = ProjectIdentity(
        "project-provision",
        str(root.resolve()),
        str((root / "supraspina.project.json").resolve()),
        2,
    )
    _write_state(
        identity,
        {
            "schemaVersion": 1,
            "projectId": identity.project_id,
            "projectEpoch": identity.epoch,
            "configRevision": 7,
            "operationId": "provision-abandoned",
            "phase": "running",
            "percent": 42,
            "message": "downloading",
            "error": None,
            "pythonExecutable": str(paths[0]),
            "modelPath": str(paths[1]),
            "scalerPath": str(paths[2]),
            "updatedAt": 1,
        },
    )
    projects = ProjectEpochs()
    manager = ProvisionManager(_Emitter(), projects, AuthorizationLedger(), _Workflow())

    status = manager.status(
        {"project": _project(root), "cfg": cfg, "configRevision": 7}
    )

    assert status["phase"] == "running"
    assert status["cancellable"] is False
    assert "Resolve" in status["error"]
    assert status["envReady"] is False
    assert status["modelReady"] is False
    assert status["pythonExecutable"] is None
    assert status["modelPath"] is None
    assert status["scalerPath"] is None
    assert manager.project_active(identity.project_id) is True

    other_cfg, _ = _cfg(root, "missing")
    current = manager.status(
        {"project": _project(root), "cfg": other_cfg, "configRevision": 8}
    )
    assert current["phase"] == "running"
    assert current["cancellable"] is False
    assert current["envReady"] is False
    assert current["modelReady"] is False


@pytest.mark.parametrize(
    ("ownership", "message", "error"),
    [
        (
            {
                "schemaVersion": 1,
                "operationId": "provision-orphaned",
                "state": "accepted",
                "provedStopped": False,
            },
            "Provisioning was interrupted; its prior process tree was stopped.",
            "Provisioning was interrupted; its prior process tree was stopped.",
        ),
        (
            None,
            "Ownership of the prior provisioning process is unresolved.",
            "Resolve the prior process tree before retrying or detaching.",
        ),
    ],
)
def test_reconciled_orphaned_provisioning_records_its_outcome_as_facts(
    tmp_path: Path,
    ownership: dict[str, Any] | None,
    message: str,
    error: str,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    _cfg_value, paths = _cfg(root)
    identity = ProjectIdentity(
        "project-provision",
        str(root.resolve()),
        str((root / "supraspina.project.json").resolve()),
        2,
    )
    _write_state(
        identity,
        {
            "schemaVersion": 1,
            "projectId": identity.project_id,
            "projectEpoch": identity.epoch,
            "configRevision": 7,
            "operationId": "provision-orphaned",
            "phase": "running",
            "percent": 42,
            "message": "downloading",
            "error": None,
            "pythonExecutable": str(paths[0]),
            "modelPath": str(paths[1]),
            "scalerPath": str(paths[2]),
            "updatedAt": 1,
            "processOwnership": ownership,
        },
    )
    manager = ProvisionManager(
        _Emitter(), ProjectEpochs(), AuthorizationLedger(), _Workflow()
    )

    manager.reconcile_project_ownership(_project(root))

    # The message is a state; only the unresolved case keeps a remedy, in error.
    persisted = _read_state(identity)
    assert persisted is not None
    assert persisted["phase"] == "error"
    assert persisted["message"] == message
    assert persisted["error"] == error


def test_runtime_bootstrap_surfaces_reconciled_persisted_provision_state(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg, paths = _cfg(root)
    _create_ready(paths)
    workflow = WorkflowManager(_Emitter())
    provision = ProvisionManager(
        _Emitter(), workflow.project_epochs, AuthorizationLedger(), workflow
    )
    workflow.set_provision_status_provider(provision.bootstrap_status)
    identity = workflow.project_epochs.validate(_project(root), cfg)
    _write_state(
        identity,
        {
            "schemaVersion": 1,
            "projectId": identity.project_id,
            "projectEpoch": identity.epoch,
            "configRevision": 4,
            "operationId": "provision-old",
            "phase": "running",
            "percent": 1,
            "message": "queued",
            "error": None,
            "pythonExecutable": str(paths[0]),
            "modelPath": str(paths[1]),
            "scalerPath": str(paths[2]),
            "updatedAt": 1,
        },
    )
    try:
        snapshot = workflow.bootstrap(
            {"project": _project(root), "runLimit": 1, "logLimit": 0}
        )
    finally:
        workflow.shutdown()

    assert snapshot["provision"] is not None
    assert snapshot["provision"]["phase"] == "running"
    assert snapshot["provision"]["cancellable"] is False
    assert snapshot["provision"]["envReady"] is False
    assert snapshot["provision"]["modelReady"] is False
    assert snapshot["provision"]["pythonExecutable"] is None
    assert os.path.isfile(root / ".supraspina" / "provision.json")


def test_unreadable_persisted_ownership_stays_unknown_blocks_retry_and_is_untouched(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg, _paths = _cfg(root)
    state_path = root / ".supraspina" / "provision.json"
    state_path.parent.mkdir(parents=True)
    original = b'{"schemaVersion":1,"phase":"running"'
    state_path.write_bytes(original)
    manager = ProvisionManager(
        _Emitter(), ProjectEpochs(), AuthorizationLedger(), _Workflow()
    )

    status = manager.status(
        {"project": _project(root), "cfg": cfg, "configRevision": 7}
    )

    assert status["phase"] == "running"
    assert status["cancellable"] is False
    assert "unreadable" in str(status["error"]).lower()
    assert manager.project_active("project-provision") is True
    assert manager.active_count() == 1
    with pytest.raises(ValueError, match="unknown prior provisioning ownership"):
        manager.start(
            {
                "project": _project(root),
                "cfg": cfg,
                "configRevision": 7,
            }
        )
    assert state_path.read_bytes() == original

    state_path.unlink()
    manager.reconcile_project_ownership(_project(root))
    assert manager.project_active("project-provision") is False


def test_status_replays_terminal_state_after_renderer_epoch_advances(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg, paths = _cfg(root)
    _create_ready(paths)
    stored_identity = ProjectIdentity(
        "project-provision",
        str(root.resolve()),
        str((root / "supraspina.project.json").resolve()),
        2,
    )
    _write_state(
        stored_identity,
        {
            "schemaVersion": 1,
            "projectId": stored_identity.project_id,
            "projectEpoch": stored_identity.epoch,
            "configRevision": 7,
            "operationId": "provision-complete",
            "phase": "done",
            "percent": 100,
            "message": "Complete PyBrainAge provisioning.",
            "error": None,
            "pythonExecutable": str(paths[0]),
            "modelPath": str(paths[1]),
            "scalerPath": str(paths[2]),
            "updatedAt": 1,
        },
    )
    manager = ProvisionManager(
        _Emitter(), ProjectEpochs(), AuthorizationLedger(), _Workflow()
    )

    status = manager.status(
        {"project": _project(root, epoch=3), "cfg": cfg, "configRevision": 7}
    )

    assert status["phase"] == "done"
    assert status["operationId"] == "provision-complete"
    assert status["projectEpoch"] == 3
    assert status["envReady"] is False
    assert status["modelReady"] is False
    assert status["pythonExecutable"] is None


def test_done_persistence_failure_retries_and_emits_only_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg, _paths = _cfg(root)
    emitter = _Emitter()
    workflow = _Workflow()
    manager = ProvisionManager(
        emitter, ProjectEpochs(), AuthorizationLedger(), workflow
    )
    operation = _operation(root, cfg)
    persisted_phases: list[str] = []

    original_persist = manager._persist_operation

    def persist(candidate: _Operation, *, record: dict[str, Any] | None = None) -> None:
        snapshot = manager._record_for(candidate) if record is None else record
        persisted_phases.append(str(snapshot["phase"]))
        if len(persisted_phases) == 1:
            raise OSError("Simulate a terminal persistence fault.")
        original_persist(candidate, record=record)

    monkeypatch.setattr(manager, "_persist_operation", persist)
    monkeypatch.setattr(
        pybrainage,
        "execute_provision",
        lambda *_args, **_kwargs: {"ok": True, "message": ""},
    )

    manager._run(operation)

    progress_phases = [
        params["phase"]
        for method, params in emitter.events
        if method == "provision.progress"
    ]
    assert persisted_phases == ["done", "error"]
    assert progress_phases == ["error"]
    assert workflow.provision_events[-1][1]["phase"] == "error"
    assert manager.status_for(operation)["phase"] == "error"
    assert operation.error == "Choose writable storage for provisioning status."
    assert operation.completed.is_set() is True
    assert _read_state(operation.project)["phase"] == "error"


def test_done_and_final_retry_persistence_failures_never_publish_done(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg, _paths = _cfg(root)
    emitter = _Emitter()
    workflow = _Workflow()
    manager = ProvisionManager(
        emitter, ProjectEpochs(), AuthorizationLedger(), workflow
    )
    operation = _operation(root, cfg)
    manager._operations[operation.operation_id] = operation
    manager._by_project[operation.project.project_id] = operation.operation_id
    manager._persist_operation(operation)
    state_path = Path(operation.project.root) / ".supraspina" / "provision.json"
    original_state = state_path.read_bytes()
    persisted_phases: list[str] = []

    def fail_persistence(
        candidate: _Operation, *, record: dict[str, Any] | None = None
    ) -> None:
        snapshot = manager._record_for(candidate) if record is None else record
        persisted_phases.append(str(snapshot["phase"]))
        raise OSError("Simulate a persistent-storage fault.")

    monkeypatch.setattr(manager, "_persist_operation", fail_persistence)
    monkeypatch.setattr(
        pybrainage,
        "execute_provision",
        lambda *_args, **_kwargs: {"ok": True, "message": ""},
    )

    manager._run(operation)

    progress_phases = [
        params["phase"]
        for method, params in emitter.events
        if method == "provision.progress"
    ]
    assert persisted_phases == ["done", "error"]
    assert progress_phases == []
    assert workflow.provision_events == []
    assert manager.status_for(operation)["phase"] == "running"
    assert operation.error == "Choose writable storage for provisioning status."
    assert operation.completed.is_set() is False
    assert manager.project_active(operation.project.project_id) is True
    assert manager.active_count() == 1
    assert state_path.read_bytes() == original_state


def test_runner_streams_child_output_as_log_lines_and_persists_a_log_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg, _paths = _cfg(root)
    emitter = _Emitter()
    manager = ProvisionManager(
        emitter, ProjectEpochs(), AuthorizationLedger(), _Workflow()
    )
    operation = _operation(root, cfg)
    captured: dict[str, Any] = {}

    def fake_execute(
        _cfg: dict[str, Any], progress: Any, *, runner: Any, **_kwargs: Any
    ) -> dict[str, Any]:
        progress("Run the child.", 0.1)
        captured["result"] = runner(
            ["sh", "-c", "echo first line; echo second line; exit 3"]
        )
        return {"ok": True, "message": ""}

    monkeypatch.setattr(pybrainage, "execute_provision", fake_execute)

    manager._run(operation)

    lines = [
        params["line"] for method, params in emitter.events if method == "provision.log"
    ]
    assert "Run the child." in lines
    assert any(line.startswith("$ sh -c ") for line in lines)
    assert "first line" in lines
    assert "second line" in lines
    assert "[exit 3]" in lines
    assert lines[-1] == "PyBrainAge provisioning is complete."
    for method, params in emitter.events:
        if method == "provision.log":
            assert params["operationId"] == operation.operation_id
            assert params["projectId"] == operation.project.project_id
            assert isinstance(params["at"], int)
    assert captured["result"].rc == 3
    assert captured["result"].stdout == "first line\nsecond line\n"
    log_path = Path(ProvisionManager.log_path(cfg, operation.operation_id))
    assert log_path.read_text(encoding="utf-8").splitlines() == lines
    assert operation.log_file is None


def test_publish_log_truncates_a_long_line_and_survives_a_failed_log_write(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg, _paths = _cfg(root)
    emitter = _Emitter()
    manager = ProvisionManager(
        emitter, ProjectEpochs(), AuthorizationLedger(), _Workflow()
    )
    operation = _operation(root, cfg)

    class _BrokenHandle:
        def write(self, _text: str) -> int:
            raise OSError("disk full")

        def flush(self) -> None:
            raise OSError("disk full")

    operation.log_file = _BrokenHandle()  # type: ignore[assignment]
    manager._publish_log(operation, "x" * 2500)
    operation.log_file = False
    manager._publish_log(operation, "after the log file was given up")

    lines = [
        params["line"] for method, params in emitter.events if method == "provision.log"
    ]
    assert len(lines) == 2
    assert lines[0].endswith(" [line truncated]")
    assert len(lines[0]) == 2000 + len(" [line truncated]")
    assert lines[1] == "after the log file was given up"
    assert operation.log_file is False


def test_stream_child_output_ignores_a_process_without_stdout(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg, _paths = _cfg(root)
    emitter = _Emitter()
    manager = ProvisionManager(
        emitter, ProjectEpochs(), AuthorizationLedger(), _Workflow()
    )
    operation = _operation(root, cfg)
    captured: list[str] = []

    manager._stream_child_output(operation, object(), captured)

    assert captured == []
    assert not any(method == "provision.log" for method, _ in emitter.events)
