"""Tests for real POSIX process-tree crash and durable ownership reconciliation."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

import supraspina_sidecar.workflow_manager as runtime
from supraspina_sidecar import provisioning
from supraspina_sidecar.adapters import pybrainage
from supraspina_sidecar.authorization import AuthorizationLedger
from supraspina_sidecar.provisioning import ProvisionManager
from supraspina_sidecar.run_store import RunStore
from supraspina_sidecar.workflow_manager import WorkflowManager


class _Emitter:
    def emit(self, _method: str, _params: dict[str, Any]) -> None:
        return None


def _wait_for(path: Path, timeout: float = 8.0) -> None:
    deadline = time.monotonic() + timeout
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert path.exists()


def _process_running(pid: int) -> bool:
    try:
        value = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except FileNotFoundError:
        return False
    except OSError:
        return True
    close = value.rfind(")")
    fields = value[close + 1 :].strip().split() if close >= 0 else []
    return not fields or fields[0] != "Z"


def _project(root: Path, project_id: str) -> dict[str, Any]:
    return {
        "projectId": project_id,
        "root": str(root.resolve()),
        "configPath": str((root / "supraspina.project.json").resolve()),
        "epoch": 1,
    }


def _provision_cfg(root: Path) -> dict[str, Any]:
    return {
        "paths": {
            "projectRoot": str(root),
            "outputDir": str(root / "derivatives"),
        },
        "tools": {"pythonExecutable": sys.executable},
        "steps": {
            "pybrainage": {
                "enabled": True,
                "params": {
                    "pythonExecutable": sys.executable,
                    "modelPath": str(root / "model" / "ExtraTreesModel"),
                    "scalerPath": str(root / "model" / "scaler.pkl"),
                },
            }
        },
    }


def _scientific_tree_script() -> str:
    return (
        "import json,os,pathlib,subprocess,sys,time;"
        "g=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);"
        "pathlib.Path(sys.argv[1]).write_text("
        "json.dumps({'child':os.getpid(),'grandchild':g.pid}),encoding='utf-8');"
        "time.sleep(60)"
    )


def _assert_tree_stopped(tree: dict[str, int], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while (
        _process_running(tree["child"]) or _process_running(tree["grandchild"])
    ) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert _process_running(tree["child"]) is False
    assert _process_running(tree["grandchild"]) is False


def _assert_live_run_waits_for_tree_settlement(
    manager: WorkflowManager,
    project: Path,
    state: dict[str, Any],
    tree: dict[str, int],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prepared_after_settlement = False

    def prepare_after_settlement(
        _request: dict[str, Any],
        _project_identity: Any,
        _report: dict[str, Any],
        *,
        run_id: str | None = None,
    ) -> tuple[Any, None, None]:
        nonlocal prepared_after_settlement
        assert run_id == "run-cafe00000001"
        assert _process_running(tree["child"]) is False
        assert _process_running(tree["grandchild"]) is False
        prepared_after_settlement = True
        plan = {
            "planId": run_id,
            "digest": "a" * 64,
            "nodes": [],
            "blockers": [{"key": "test", "reason": "test", "kind": "runtime"}],
        }
        return (
            runtime.PlannedWorkflow(
                result={
                    "runId": None,
                    "disposition": "blocked",
                    "plan": plan,
                    "summary": {
                        "planned": 0,
                        "started": 0,
                        "waiting": 0,
                        "blocked": 1,
                        "skipped": 0,
                        "message": "blocked",
                    },
                },
                cohort=None,
                effective_cfg={},
                warnings=(),
            ),
            None,
            None,
        )

    monkeypatch.setattr(manager, "_environment", lambda _cfg: {"groups": []})
    monkeypatch.setattr(manager, "_prepare_plan", prepare_after_settlement)
    monkeypatch.setattr(
        manager.authorizations, "consume", lambda *_args, **_kwargs: None
    )
    result = manager.run(
        {
            "project": state["project"],
            "cfg": {
                "paths": {
                    "projectRoot": str(project),
                    "outputDir": str(project / "derivatives"),
                },
                "runtime": {"dryRun": False},
            },
            "configRevision": 1,
            "approvedPlan": {
                "planId": "run-cafe00000001",
                "digest": "a" * 64,
            },
            "liveExecutionAuthorization": {
                "planDigest": "a" * 64,
            },
        }
    )
    assert result["disposition"] == "blocked"
    assert prepared_after_settlement is True


@pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="Run this integration only with Linux /proc start-identity support.",
)
def test_sigkill_restart_settles_durable_child_and_grandchild_before_interrupt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify that a killed owner leaves enough evidence to stop its old tree."""
    project = tmp_path / "project"
    project.mkdir()
    record_path = tmp_path / "owner.json"
    tree_path = tmp_path / "tree.json"
    sidecar_root = Path(runtime.__file__).parents[1]
    scientific = _scientific_tree_script()
    controller = (
        "import json,os,pathlib,sys,time,uuid;"
        "from supraspina_sidecar.workflow_manager import "
        "_process_group,_process_start_identity,_release_spawn,_spawn;"
        "proc=_spawn([sys.executable,'-c',sys.argv[3],sys.argv[2]],{});"
        "pgid=_process_group(proc);state,identity=_process_start_identity(proc.pid,proc);"
        "record={'schemaVersion':1,'claimId':'claim-'+uuid.uuid4().hex,"
        "'generation':1,'operationKind':'workflow','ownerId':'#crash-job',"
        "'projectId':'crash-project','projectEpoch':1,'runId':'run-deadbeef',"
        "'jobId':'#crash-job','operationId':None,'pid':proc.pid,'pgid':pgid,"
        "'startIdentity':identity,'state':'accepted','accepted':True,"
        "'provedStopped':False};"
        "p=pathlib.Path(sys.argv[1]);p.write_text(json.dumps(record),encoding='utf-8');"
        "fd=os.open(p,os.O_RDONLY);os.fsync(fd);os.close(fd);"
        "_release_spawn(proc);time.sleep(60)"
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = str(sidecar_root)
    owner = subprocess.Popen(  # noqa: S603
        [
            sys.executable,
            "-c",
            controller,
            str(record_path),
            str(tree_path),
            scientific,
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    record: dict[str, Any] = {}
    tree: dict[str, int] = {}
    try:
        _wait_for(record_path)
        _wait_for(tree_path)
        record = json.loads(record_path.read_text(encoding="utf-8"))
        tree = json.loads(tree_path.read_text(encoding="utf-8"))
        assert record["pid"] == tree["child"]
        assert _process_running(tree["child"])
        assert _process_running(tree["grandchild"])

        os.kill(owner.pid, signal.SIGKILL)
        owner.wait(timeout=5)

        node = {
            "nodeId": "recon:sub-01",
            "stepKey": "recon",
            "scope": "subject",
            "subjectId": "sub-01",
            "status": "running",
            "dependencies": [],
        }
        job = {
            "id": "#crash-job",
            "runId": "run-deadbeef",
            "nodeId": node["nodeId"],
            "projectId": "crash-project",
            "projectEpoch": 1,
            "status": "running",
            "startedAt": 1,
            "endedAt": None,
            "processOwnership": record,
        }
        state = {
            "runId": "run-deadbeef",
            "project": {
                "projectId": "crash-project",
                "root": str(project.resolve()),
                "configPath": str(project / "supraspina.project.json"),
                "epoch": 1,
            },
            "status": "running",
            "startedAtMs": 1,
            "endedAtMs": None,
            "nodes": [node],
            "jobs": [job],
            "receipts": [],
            "warnings": [],
            "manifest": {"runId": "run-deadbeef"},
        }
        RunStore(str(project)).commit(state)
        manager = WorkflowManager(_Emitter())
        try:
            _assert_live_run_waits_for_tree_settlement(
                manager,
                project,
                state,
                tree,
                monkeypatch,
            )

            snapshot = manager.bootstrap(
                {
                    "project": state["project"],
                    "runLimit": 10,
                    "logLimit": 0,
                }
            )
            assert snapshot["jobs"][0]["status"] == "interrupted"
            assert snapshot["runs"][0]["status"] == "interrupted"
            assert [
                (item["status"], item["reason"])
                for item in RunStore(str(project)).load("run-deadbeef")["nodes"]
            ] == [
                (
                    "interrupted",
                    "This work was marked interrupted because no process was "
                    "executing it.",
                )
            ]
            assert manager.project_active("crash-project") is False
        finally:
            manager.shutdown()

        _assert_tree_stopped(tree)
    finally:
        if owner.poll() is None:
            os.kill(owner.pid, signal.SIGKILL)
            owner.wait(timeout=5)
        pgid = record.get("pgid")
        if isinstance(pgid, int) and pgid > 1:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="Run this integration only with real POSIX process-group cancellation.",
)
def test_provision_cancel_settles_real_child_and_grandchild(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_root = tmp_path / "project"
    project_root.mkdir()
    tree_path = tmp_path / "provision-tree.json"
    project = _project(project_root, "provision-cancel")
    cfg = _provision_cfg(project_root)
    workflow = WorkflowManager(_Emitter())
    manager = ProvisionManager(
        _Emitter(), workflow.project_epochs, AuthorizationLedger(), workflow
    )

    def execute(
        _cfg: dict[str, Any],
        _progress: Any,
        **kwargs: Any,
    ) -> dict[str, Any]:
        result = kwargs["runner"](
            [sys.executable, "-c", _scientific_tree_script(), str(tree_path)]
        )
        return {"ok": result.rc == 0}

    monkeypatch.setattr(pybrainage, "execute_provision", execute)
    operation_id = manager.start(
        {
            "project": project,
            "cfg": cfg,
            "configRevision": 1,
            "authorization": {
                "token": "provision-cancel-token-unique",
                "projectId": project["projectId"],
                "configRevision": 1,
                "purpose": "provision",
            },
        }
    )["operationId"]
    tree: dict[str, int] = {}
    try:
        _wait_for(tree_path)
        tree = json.loads(tree_path.read_text(encoding="utf-8"))
        assert _process_running(tree["child"])
        assert _process_running(tree["grandchild"])

        result = manager.cancel(
            {"project": project, "operationId": operation_id}, timeout=8
        )

        assert result == {
            "operationId": operation_id,
            "accepted": True,
            "terminal": True,
        }
        _assert_tree_stopped(tree)
        record = provisioning._read_state(
            workflow.project_epochs.validate(project, cfg)
        )
        assert record is not None
        assert record["phase"] == "cancelled"
        assert record["processOwnership"]["provedStopped"] is True
    finally:
        manager.shutdown(timeout=2)
        workflow.shutdown()
        if tree:
            try:
                os.killpg(tree["child"], signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="Run this integration only with Linux /proc crash reconciliation.",
)
def test_provision_restart_settles_persisted_child_and_grandchild(
    tmp_path: Path,
) -> None:
    project_root = tmp_path / "project"
    project_root.mkdir()
    tree_path = tmp_path / "provision-crash-tree.json"
    owner_path = tmp_path / "provision-owner.json"
    state_path = project_root / ".supraspina" / "provision.json"
    sidecar_root = Path(runtime.__file__).parents[1]
    controller = (
        "import json,os,pathlib,sys,time,uuid;"
        "from supraspina_sidecar.workflow_manager import "
        "_process_group,_process_start_identity,_release_spawn,_spawn;"
        "proc=_spawn([sys.executable,'-c',sys.argv[5],sys.argv[3]],{});"
        "pgid=_process_group(proc);_,identity=_process_start_identity(proc.pid,proc);"
        "owner={'schemaVersion':1,'claimId':'claim-'+uuid.uuid4().hex,"
        "'generation':1,'operationKind':'provision','ownerId':'provision-crash',"
        "'projectId':'provision-crash','projectEpoch':1,'runId':None,'jobId':None,"
        "'operationId':'provision-crash','pid':proc.pid,'pgid':pgid,"
        "'startIdentity':identity,'state':'accepted','accepted':True,"
        "'provedStopped':False};"
        "state={'schemaVersion':1,'projectId':'provision-crash','projectEpoch':1,"
        "'configRevision':1,'operationId':'provision-crash','phase':'running',"
        "'percent':50,'message':'running','error':None,'pythonExecutable':None,"
        "'modelPath':None,'scalerPath':None,'updatedAt':1,'processOwnership':owner};"
        "p=pathlib.Path(sys.argv[1]);p.parent.mkdir(parents=True,exist_ok=True);"
        "p.write_text(json.dumps(state),encoding='utf-8');"
        "q=pathlib.Path(sys.argv[2]);q.write_text(json.dumps(owner),encoding='utf-8');"
        "fd=os.open(p,os.O_RDONLY);os.fsync(fd);os.close(fd);"
        "_release_spawn(proc);time.sleep(60)"
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = str(sidecar_root)
    owner_process = subprocess.Popen(  # noqa: S603
        [
            sys.executable,
            "-c",
            controller,
            str(state_path),
            str(owner_path),
            str(tree_path),
            str(project_root),
            _scientific_tree_script(),
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    tree: dict[str, int] = {}
    owner: dict[str, Any] = {}
    try:
        _wait_for(owner_path)
        _wait_for(tree_path)
        owner = json.loads(owner_path.read_text(encoding="utf-8"))
        tree = json.loads(tree_path.read_text(encoding="utf-8"))
        assert owner["pid"] == tree["child"]

        os.kill(owner_process.pid, signal.SIGKILL)
        owner_process.wait(timeout=5)

        workflow = WorkflowManager(_Emitter())
        manager = ProvisionManager(
            _Emitter(), workflow.project_epochs, AuthorizationLedger(), workflow
        )
        project = _project(project_root, "provision-crash")
        try:
            status = manager.bootstrap_status({"project": project})
            assert status is not None
            assert status["phase"] == "error"
            assert manager.project_active("provision-crash") is False
            record = provisioning._read_state(workflow.project_epochs.validate(project))
            assert record is not None
            assert record["processOwnership"]["provedStopped"] is True
        finally:
            manager.shutdown(timeout=2)
            workflow.shutdown()
        _assert_tree_stopped(tree)
    finally:
        if owner_process.poll() is None:
            os.kill(owner_process.pid, signal.SIGKILL)
            owner_process.wait(timeout=5)
        pgid = owner.get("pgid")
        if isinstance(pgid, int) and pgid > 1:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_reconciliation_never_signals_a_reused_pid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = WorkflowManager(_Emitter())
    killed: list[tuple[int, int]] = []
    owner = {
        "schemaVersion": 1,
        "claimId": "claim-reused",
        "generation": 1,
        "operationKind": "workflow",
        "ownerId": "#job",
        "projectId": "project",
        "projectEpoch": 1,
        "runId": "run-deadbeef",
        "jobId": "#job",
        "operationId": None,
        "pid": 4242,
        "pgid": 4242,
        "startIdentity": "linux:boot:10",
        "state": "accepted",
        "provedStopped": False,
    }
    monkeypatch.setattr(
        runtime,
        "_process_start_identity",
        lambda _pid: ("alive", "linux:boot:11"),
    )
    monkeypatch.setattr(
        runtime.os, "killpg", lambda pid, sig: killed.append((pid, sig))
    )
    try:
        outcome, reconciled = manager.reconcile_process_owner(owner)
    finally:
        manager.shutdown()
    assert outcome == "stopped"
    assert reconciled is not None
    assert reconciled["provedStopped"] is True
    assert reconciled["detail"] == (
        "The prior owner is gone: another process reused the recorded PID."
    )
    assert killed == []


def test_reconciliation_never_trusts_settled_without_explicit_proof(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = WorkflowManager(_Emitter())
    probed: list[int] = []
    owner = {
        "schemaVersion": 1,
        "claimId": "claim-unproved-settlement",
        "generation": 1,
        "operationKind": "workflow",
        "ownerId": "#job",
        "projectId": "project",
        "projectEpoch": 1,
        "runId": "run-deadbeef",
        "jobId": "#job",
        "operationId": None,
        "pid": 4242,
        "pgid": 4242,
        "startIdentity": "linux:boot:10",
        "state": "settled",
        "provedStopped": False,
    }
    monkeypatch.setattr(
        runtime,
        "_process_start_identity",
        lambda pid: probed.append(pid) or ("unknown", None),
    )
    try:
        outcome, reconciled = manager.reconcile_process_owner(owner)
    finally:
        manager.shutdown()

    assert outcome == "unknown"
    assert reconciled is not None
    assert reconciled["state"] == "unknown"
    assert reconciled["provedStopped"] is False
    assert reconciled["detail"] == "The process identity could not be verified."
    assert probed == [4242]


@pytest.mark.parametrize(
    "patch",
    [
        {"generation": "1"},
        {"generation": True},
        {"projectEpoch": "1"},
        {"projectEpoch": True},
        {"pid": "4242"},
        {"pid": True},
        {"pgid": "4242"},
        {"ownerId": 42},
        {"jobId": "#different"},
        {"operationId": "provision-for-workflow"},
        {"startIdentity": "opaque:boot:10"},
    ],
)
def test_reconciliation_rejects_malformed_owner_without_probing_or_signalling(
    monkeypatch: pytest.MonkeyPatch,
    patch: dict[str, Any],
) -> None:
    manager = WorkflowManager(_Emitter())
    probed: list[int] = []
    killed: list[tuple[int, int]] = []
    owner = {
        "schemaVersion": 1,
        "claimId": "claim-malformed",
        "generation": 1,
        "operationKind": "workflow",
        "ownerId": "#job",
        "projectId": "project",
        "projectEpoch": 1,
        "runId": "run-deadbeef",
        "jobId": "#job",
        "operationId": None,
        "pid": 4242,
        "pgid": 4242,
        "startIdentity": "linux:boot:10",
        "state": "accepted",
        "provedStopped": False,
        **patch,
    }
    monkeypatch.setattr(
        runtime,
        "_process_start_identity",
        lambda pid: probed.append(pid) or ("alive", "linux:boot:10"),
    )
    monkeypatch.setattr(
        runtime.os, "killpg", lambda pid, sig: killed.append((pid, sig))
    )
    try:
        outcome, reconciled = manager.reconcile_process_owner(owner)
    finally:
        manager.shutdown()
    assert outcome == "unknown"
    assert reconciled is not None
    assert probed == []
    assert killed == []


def test_permission_denied_reconciliation_stays_unknown_and_blocks_project(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    manager = WorkflowManager(_Emitter())
    owner = {
        "schemaVersion": 1,
        "claimId": "claim-permission",
        "generation": 1,
        "operationKind": "workflow",
        "ownerId": "#job",
        "projectId": "project",
        "projectEpoch": 1,
        "runId": "run-deadbeef",
        "jobId": "#job",
        "operationId": None,
        "pid": 4242,
        "pgid": 4242,
        "startIdentity": "linux:boot:10",
        "state": "accepted",
        "provedStopped": False,
    }
    monkeypatch.setattr(
        runtime,
        "_process_start_identity",
        lambda _pid: ("alive", "linux:boot:10"),
    )
    monkeypatch.setattr(runtime, "_process_group_state", lambda _pgid: "unknown")
    try:
        outcome, reconciled = manager.reconcile_process_owner(owner)
        assert outcome == "unknown"
        assert reconciled is not None
        assert reconciled["detail"] == (
            "Process-group ownership could not be verified."
        )
        manager._unresolved_processes["claim-permission"] = reconciled
        assert manager.project_active("project") is True
        with pytest.raises(
            ValueError,
            match=r"Wait for the active workflow to finish before starting another",
        ):
            manager.run(
                {
                    "project": {
                        "projectId": "project",
                        "root": str(tmp_path),
                        "configPath": str(tmp_path / "supraspina.project.json"),
                        "epoch": 1,
                    },
                    "cfg": {
                        "paths": {
                            "projectRoot": str(tmp_path),
                            "outputDir": str(tmp_path / "derivatives"),
                        }
                    },
                    "configRevision": 1,
                    "approvedPlan": {
                        "planId": "run-deadbeef1234",
                        "digest": "a" * 64,
                    },
                }
            )
    finally:
        manager._unresolved_processes.clear()
        manager.shutdown()
