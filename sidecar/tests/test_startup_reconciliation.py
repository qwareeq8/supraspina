"""Tests for settling persisted nonterminal runs after an interrupted restart."""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.cohort import CohortSnapshot
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.run_store import PersistenceError, RunStore
from supraspina_sidecar.workflow_manager import WorkflowManager, _RunContext


class _Emitter:
    def emit(self, _method: str, _params: dict[str, Any]) -> None:
        return None


def _identity(root: Path) -> ProjectIdentity:
    return ProjectIdentity(
        project_id="startup-reconciliation",
        root=str(root.resolve()),
        config_path=str((root / "supraspina.project.json").resolve()),
        epoch=1,
    )


def _cohort() -> CohortSnapshot:
    return CohortSnapshot(
        analysis_subject_ids=("sub-01",),
        selected_subject_ids=("sub-01",),
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(),
        qc_verdicts=(("sub-01", "pass"),),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def _node(status: str, step_key: str = "recon") -> dict[str, Any]:
    return {
        "nodeId": f"{step_key}:sub-01",
        "stepKey": step_key,
        "subjectId": "sub-01",
        "scope": "subject",
        "dependencies": [],
        "status": status,
    }


def _job(root: Path, run_id: str, node: dict[str, Any], status: str) -> dict[str, Any]:
    log_path = root / ".supraspina" / "runs" / run_id / "logs" / "job.log"
    return {
        "id": "#startup-job",
        "runId": run_id,
        "nodeId": node["nodeId"],
        "projectId": "startup-reconciliation",
        "projectEpoch": 1,
        "sidecarGeneration": 0,
        "stepKey": node["stepKey"],
        "subjectId": node["subjectId"],
        "scope": node["scope"],
        "plannedAt": 1,
        "startedAt": 2,
        "endedAt": 3 if status not in {"queued", "running", "cancelling"} else None,
        "exitCode": 0 if status == "done" else None,
        "stdoutPath": str(log_path),
        "stderrPath": str(log_path),
        "status": status,
        "dryRun": False,
        "durable": True,
        "persistenceStatus": "durable",
        "terminalReason": None,
    }


def _state(
    root: Path,
    *,
    run_id: str = "run-57a47001",
    status: str,
    nodes: list[dict[str, Any]],
    jobs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "runId": run_id,
        "project": _identity(root).to_dict(),
        "configRevision": 1,
        "config": {"paths": {"projectRoot": str(root.resolve())}},
        "configSha256": "startup",
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "acknowledgements": {},
        "scope": _cohort().to_dict(),
        "nodes": nodes,
        "jobs": jobs or [],
        "receipts": [],
        "warnings": [],
        "environmentEvidence": {},
        "scientificEvidence": {},
        "failurePolicy": {
            "stopOnError": False,
            "continueIndependentAfterError": True,
        },
        "status": status,
        "dryRun": False,
        "durable": True,
        "startedAtMs": 1,
        "endedAtMs": None,
        "manifest": {"schemaVersion": 1, "runId": run_id},
    }


def _bootstrap(root: Path, manager: WorkflowManager) -> dict[str, Any]:
    return manager.bootstrap(
        {
            "project": _identity(root).to_dict(),
            "runLimit": 10,
            "logLimit": 0,
        }
    )


def _restart(root: Path, state: dict[str, Any]) -> tuple[dict[str, Any], list[Any]]:
    RunStore(str(root)).commit(state)
    manager = WorkflowManager(_Emitter())
    spawned: list[Any] = []
    manager._spawn_override = lambda *args, **kwargs: spawned.append(args)  # type: ignore[assignment]
    try:
        snapshot = _bootstrap(root, manager)
    finally:
        manager._unresolved_processes.clear()
        manager.shutdown()
    return snapshot, spawned


def test_running_run_without_any_active_job_settles_on_restart(
    tmp_path: Path,
) -> None:
    # Model a crash between the last job commit and the run's terminal commit.
    state = _state(
        tmp_path,
        status="running",
        nodes=[_node("running")],
        jobs=[_job(tmp_path, "run-57a47001", _node("running"), "done")],
    )

    snapshot, spawned = _restart(tmp_path, state)

    projected = next(run for run in snapshot["runs"] if run["runId"] == state["runId"])
    stored = RunStore(str(tmp_path)).load(state["runId"])
    assert projected["status"] == "interrupted"
    assert stored["status"] == "interrupted"
    assert stored["endedAtMs"] is not None
    assert stored["terminalReason"] == "stale_process_tree_settled"
    assert stored["recovery"]["state"] == "interrupted"
    assert stored["nodes"][0]["status"] == "interrupted"
    assert stored["nodes"][0]["reason"] == (
        "This work was marked interrupted because no process was executing it."
    )
    assert spawned == []


def test_running_run_whose_nodes_all_completed_reports_done(tmp_path: Path) -> None:
    state = _state(
        tmp_path,
        status="running",
        nodes=[_node("done")],
        jobs=[_job(tmp_path, "run-57a47001", _node("done"), "done")],
    )

    snapshot, spawned = _restart(tmp_path, state)

    projected = next(run for run in snapshot["runs"] if run["runId"] == state["runId"])
    assert projected["status"] == "done"
    assert RunStore(str(tmp_path)).load(state["runId"])["status"] == "done"
    assert spawned == []


def test_running_run_whose_node_failed_reports_failed(tmp_path: Path) -> None:
    state = _state(
        tmp_path,
        status="running",
        nodes=[_node("failed")],
        jobs=[_job(tmp_path, "run-57a47001", _node("failed"), "failed")],
    )

    snapshot, _spawned = _restart(tmp_path, state)

    projected = next(run for run in snapshot["runs"] if run["runId"] == state["runId"])
    assert projected["status"] == "failed"


def test_cancelling_run_without_an_active_job_settles_as_cancelled(
    tmp_path: Path,
) -> None:
    state = _state(
        tmp_path,
        status="cancelling",
        nodes=[_node("cancelled")],
        jobs=[_job(tmp_path, "run-57a47001", _node("cancelled"), "cancelled")],
    )

    snapshot, spawned = _restart(tmp_path, state)

    projected = next(run for run in snapshot["runs"] if run["runId"] == state["runId"])
    assert projected["status"] == "cancelled"
    assert spawned == []


def test_crash_before_spawn_leaves_no_job_and_still_settles(tmp_path: Path) -> None:
    state = _state(tmp_path, status="running", nodes=[_node("queued")], jobs=[])

    snapshot, spawned = _restart(tmp_path, state)

    projected = next(run for run in snapshot["runs"] if run["runId"] == state["runId"])
    stored = RunStore(str(tmp_path)).load(state["runId"])
    assert projected["status"] == "interrupted"
    assert stored["nodes"][0]["status"] == "interrupted"
    assert spawned == []


def test_queued_run_with_no_jobs_settles_as_interrupted(tmp_path: Path) -> None:
    # run() commits the queued state durably before the scheduler creates
    # any job, so a crash in that window must settle like a crashed
    # running run instead of leaving a phantom live run forever.
    state = _state(tmp_path, status="queued", nodes=[_node("queued")], jobs=[])

    snapshot, spawned = _restart(tmp_path, state)

    projected = next(run for run in snapshot["runs"] if run["runId"] == state["runId"])
    stored = RunStore(str(tmp_path)).load(state["runId"])
    assert projected["status"] == "interrupted"
    assert stored["status"] == "interrupted"
    assert stored["nodes"][0]["status"] == "interrupted"
    assert spawned == []


def test_never_committed_run_directory_does_not_block_the_project(
    tmp_path: Path,
) -> None:
    # An interrupted first commit leaves a run directory with generations
    # but no state.json pointer. Such a run never registered with the
    # scheduler, so bootstrap must settle the debris instead of holding the
    # project in an unresolvable unknown-ownership state forever.
    run_id = "run-0123456789ab"
    (tmp_path / ".supraspina" / "runs" / run_id / "generations").mkdir(parents=True)
    manager = WorkflowManager(_Emitter())
    try:
        snapshot = _bootstrap(tmp_path, manager)
        projected = next(run for run in snapshot["runs"] if run["runId"] == run_id)
        assert projected["status"] == "interrupted"
        assert projected["durable"] is False
        assert manager._unresolved_processes == {}
        assert manager.project_active("startup-reconciliation") is False

        second = _bootstrap(tmp_path, manager)
        assert manager.project_active("startup-reconciliation") is False
        assert any(run["runId"] == run_id for run in second["runs"])
    finally:
        manager.shutdown()


def test_unreadable_commit_pointer_still_fails_closed(tmp_path: Path) -> None:
    # A pointer that exists but cannot be verified keeps the fail-closed
    # unknown-ownership treatment; only definitive absence settles.
    run_id = "run-0123456789ab"
    run_dir = tmp_path / ".supraspina" / "runs" / run_id
    (run_dir / "generations").mkdir(parents=True)
    (run_dir / "state.json").write_text("not json", encoding="utf-8")
    manager = WorkflowManager(_Emitter())
    try:
        snapshot = _bootstrap(tmp_path, manager)
        projected = next(run for run in snapshot["runs"] if run["runId"] == run_id)
        assert projected["status"] == "unknown"
        assert manager.project_active("startup-reconciliation") is True
    finally:
        manager._unresolved_processes.clear()
        manager.shutdown()


def test_unproven_node_ownership_stays_unknown(tmp_path: Path) -> None:
    state = _state(
        tmp_path,
        status="running",
        nodes=[_node("unknown")],
        jobs=[_job(tmp_path, "run-57a47001", _node("unknown"), "interrupted")],
    )

    snapshot, _spawned = _restart(tmp_path, state)

    projected = next(run for run in snapshot["runs"] if run["runId"] == state["runId"])
    stored = RunStore(str(tmp_path)).load(state["runId"])
    assert projected["status"] == "unknown"
    assert projected["endedAt"] is None
    assert stored["terminalReason"] == "process_tree_unverified"
    assert stored["recovery"]["detail"] == (
        "Ownership of the prior scientific process could not be verified."
    )
    assert stored["nodes"][0]["status"] == "unknown"


def test_completed_run_is_left_untouched(tmp_path: Path) -> None:
    state = _state(
        tmp_path,
        status="done",
        nodes=[_node("done")],
        jobs=[_job(tmp_path, "run-57a47001", _node("done"), "done")],
    )
    state["endedAtMs"] = 9
    before = copy.deepcopy(state)

    snapshot, spawned = _restart(tmp_path, state)

    stored = RunStore(str(tmp_path)).load(state["runId"])
    projected = next(run for run in snapshot["runs"] if run["runId"] == state["runId"])
    assert projected["status"] == "done"
    assert stored["status"] == before["status"]
    assert stored["endedAtMs"] == before["endedAtMs"]
    assert "recovery" not in stored
    assert spawned == []


def test_owned_live_run_is_not_settled(tmp_path: Path) -> None:
    state = _state(
        tmp_path,
        status="running",
        nodes=[_node("running")],
        jobs=[_job(tmp_path, "run-57a47001", _node("running"), "done")],
    )
    RunStore(str(tmp_path)).commit(state)
    manager = WorkflowManager(_Emitter())
    owned = _RunContext(
        state={"runId": state["runId"], "nodes": [], "jobs": [], "receipts": []},
        cfg={},
        effective_cfg={},
        cohort=_cohort(),
        project=_identity(tmp_path),
        store=RunStore(str(tmp_path)),
        queue_limit=1,
    )
    try:
        with manager._lock:
            manager._runs[state["runId"]] = owned
        snapshot = _bootstrap(tmp_path, manager)
    finally:
        manager._runs.clear()
        manager._unresolved_processes.clear()
        manager.shutdown()

    projected = next(run for run in snapshot["runs"] if run["runId"] == state["runId"])
    assert projected["status"] == "running"
    assert RunStore(str(tmp_path)).load(state["runId"])["status"] == "running"


def test_stale_active_jobs_settlement_survives_a_commit_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The settlement commit for a run that crashed with active jobs must
    # degrade to a persistence-error snapshot instead of aborting the
    # whole bootstrap, which run() and resume() call through ownership
    # reconciliation.
    node = _node("running")
    job = _job(tmp_path, "run-57a47001", node, "running")
    state = _state(tmp_path, status="running", nodes=[node], jobs=[job])
    RunStore(str(tmp_path)).commit(state)

    def failing_commit(self: RunStore, _state: dict[str, Any]) -> int:
        raise PersistenceError("Retry because the commit was injected to fail.")

    monkeypatch.setattr(RunStore, "commit", failing_commit)
    manager = WorkflowManager(_Emitter())
    try:
        snapshot = _bootstrap(tmp_path, manager)
    finally:
        manager._unresolved_processes.clear()
        manager.shutdown()

    projected = next(run for run in snapshot["runs"] if run["runId"] == state["runId"])
    assert projected["status"] == "persistence-error"
    assert projected["durable"] is False


def test_active_job_with_a_live_reused_pid_is_never_signalled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node("running")
    job = _job(tmp_path, "run-57a47001", node, "running")
    job["processOwnership"] = {
        "operationKind": "workflow",
        "ownerId": job["id"],
        "jobId": job["id"],
        "runId": "run-57a47001",
        "projectId": "startup-reconciliation",
        "projectEpoch": 1,
        "pid": os.getpid(),
        "pgid": os.getpgid(0),
        "startIdentity": "reused-pid-start-identity",
        "state": "running",
    }
    state = _state(tmp_path, status="running", nodes=[node], jobs=[job])
    signalled: list[tuple[int, int]] = []
    monkeypatch.setattr(
        "supraspina_sidecar.workflow_manager.os.killpg",
        lambda pgid, sig: signalled.append((pgid, sig)),
    )

    snapshot, _spawned = _restart(tmp_path, state)

    projected = next(run for run in snapshot["runs"] if run["runId"] == state["runId"])
    assert projected["status"] in {"unknown", "interrupted"}
    assert signalled == []
