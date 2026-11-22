"""Regression tests for durability and bounded runtime bootstrap."""

from __future__ import annotations

import copy
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import workflow_manager as workflow_module
from supraspina_sidecar.adapters.base import ExecutionAction, StepStatus
from supraspina_sidecar.cohort import CohortSnapshot
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.run_store import RunStore
from supraspina_sidecar.workflow_manager import WorkflowManager, _RunContext

#: Model a spawned process whose group has already gone. A real spawn always
#: records a process group; an unknown group is never proof of settlement.
_SETTLED_PGID = 999_331


@pytest.fixture(autouse=True)
def _settled_process_group(monkeypatch: pytest.MonkeyPatch) -> None:
    """Report the fake spawn's process group as gone without a real syscall."""
    real_state = workflow_module._process_group_state
    real_group = workflow_module._process_group
    monkeypatch.setattr(
        workflow_module,
        "_process_group_state",
        lambda pgid: "dead" if pgid == _SETTLED_PGID else real_state(pgid),
    )
    monkeypatch.setattr(
        workflow_module,
        "_process_group",
        lambda proc: (
            _SETTLED_PGID
            if getattr(proc, "_supraspina_pgid", None) == _SETTLED_PGID
            else real_group(proc)
        ),
    )


class _Emitter:
    def emit(self, _method: str, _params: dict[str, Any]) -> None:
        return None


def _project(root: Path, *, epoch: int = 1) -> dict[str, Any]:
    return {
        "projectId": "project-durable",
        "root": str(root),
        "configPath": str(root / "supraspina.project.json"),
        "epoch": epoch,
    }


def _job(
    root: Path,
    index: int,
    *,
    status: str = "done",
    stdout_path: str | None = None,
) -> dict[str, Any]:
    run_id = "run-12345678"
    return {
        "id": f"#job-{index:04d}",
        "runId": run_id,
        "nodeId": f"recon:sub-{index:04d}",
        "projectId": "project-durable",
        "projectEpoch": 1,
        "sidecarGeneration": 0,
        "stepKey": "recon",
        "subjectId": f"sub-{index:04d}",
        "scope": "subject",
        "plannedAt": index,
        "startedAt": index,
        "endedAt": index if status == "done" else None,
        "exitCode": 0 if status == "done" else None,
        "stdoutPath": stdout_path
        or str(root / ".supraspina" / "runs" / run_id / "logs" / f"{index}.log"),
        "stderrPath": stdout_path
        or str(root / ".supraspina" / "runs" / run_id / "logs" / f"{index}.log"),
        "status": status,
        "dryRun": False,
        "durable": True,
        "persistenceStatus": "durable",
        "terminalReason": "completed" if status == "done" else None,
    }


def _commit(root: Path, jobs: list[dict[str, Any]]) -> None:
    run_id = "run-12345678"
    RunStore(str(root)).commit(
        {
            "runId": run_id,
            "project": _project(root),
            "startedAtMs": 1,
            "endedAtMs": 2,
            "status": "done",
            "dryRun": False,
            "durable": True,
            "scope": {"analysisSubjectIds": ["sub-private"]},
            "nodes": [],
            "jobs": jobs,
            "receipts": [],
            "manifest": {"schemaVersion": 1, "runId": run_id},
        }
    )


def test_bootstrap_replays_bounded_secret_free_committed_logs_after_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project-secret"
    root.mkdir()
    run_dir = root / ".supraspina" / "runs" / "run-12345678"
    logs = run_dir / "logs"
    logs.mkdir(parents=True)
    log_path = logs / "0.log"
    log_path.write_text(
        f"old line\nAPI_KEY=replay-secret-value\nworking in {root} for sub-private\n",
        encoding="utf-8",
    )
    outside = tmp_path / "outside.log"
    outside.write_text("must not replay\n", encoding="utf-8")
    escaped = logs / "escaped.log"
    try:
        escaped.symlink_to(outside)
    except OSError:
        pytest.skip("Run this test only where symlinks are available.")
    _commit(
        root,
        [
            _job(root, 0, stdout_path=str(log_path)),
            _job(root, 1, stdout_path=str(escaped)),
        ],
    )
    monkeypatch.setattr(workflow_module, "_REPLAY_LOG_BYTES_PER_JOB", 4096)
    monkeypatch.setattr(workflow_module, "_REPLAY_LOG_LINES_PER_JOB", 2)

    manager = WorkflowManager(_Emitter())
    try:
        snapshot = manager.bootstrap(
            {"project": _project(root), "runLimit": 10, "logLimit": 20}
        )
    finally:
        manager.shutdown()

    lines = [entry["line"] for entry in snapshot["logTail"]]
    assert any("bounded restart replay" in line for line in lines)
    assert not any("must not replay" in line for line in lines)
    serialized = "\n".join(lines)
    assert "replay-secret-value" not in serialized
    assert "API_KEY=[REDACTED]" in serialized
    # The operator reads their own tail, so the path and the subject stay
    # legible; only an export redacts them.
    assert str(root) in serialized
    assert "sub-private" in serialized


def test_bootstrap_keeps_all_active_and_only_newest_200_terminal_jobs(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    _commit(root, [_job(root, index) for index in range(250)])
    manager = WorkflowManager(_Emitter())
    try:
        with manager._lock:
            for index in range(3):
                active = _job(root, 1_000 + index, status="running")
                manager._active_jobs[active["id"]] = active
        snapshot = manager.bootstrap(
            {"project": _project(root), "runLimit": 10, "logLimit": 0}
        )
    finally:
        with manager._lock:
            manager._active_jobs.clear()
        manager.shutdown()

    active = [job for job in snapshot["jobs"] if job["status"] == "running"]
    terminal = [job for job in snapshot["jobs"] if job["status"] == "done"]
    assert len(active) == 3
    assert len(terminal) == 200
    assert {job["id"] for job in terminal} == {
        f"#job-{index:04d}" for index in range(50, 250)
    }


def test_bootstrap_never_trims_persistence_error_evidence(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    jobs = [_job(root, index) for index in range(250)]
    for index in range(250, 257):
        failed = _job(root, index, status="persistence-error")
        failed["persistenceStatus"] = "error"
        jobs.append(failed)
    _commit(root, jobs)
    manager = WorkflowManager(_Emitter())
    try:
        snapshot = manager.bootstrap(
            {"project": _project(root), "runLimit": 10, "logLimit": 0}
        )
    finally:
        manager.shutdown()

    assert sum(job["status"] == "done" for job in snapshot["jobs"]) == 200
    assert sum(job["status"] == "persistence-error" for job in snapshot["jobs"]) == 7


_CONFLICT = (
    "Choose a fresh derivatives namespace because detector-complete "
    "Reconstruction output has no matching current receipt; preserve the "
    "existing tree."
)


def _blocked_node(
    step_key: str, subject_id: str | None, reason: str, *, status: str = "blocked"
) -> dict[str, Any]:
    return {
        "nodeId": f"{step_key}:{subject_id or 'cohort'}",
        "stepKey": step_key,
        "subjectId": subject_id,
        "scope": "subject" if subject_id else "cohort",
        "status": status,
        "reason": reason,
        "dependencies": [],
    }


def test_bootstrap_lists_the_nodes_behind_the_quoted_blocked_reason(
    tmp_path: Path,
) -> None:
    # A plan-time blocked node never becomes a job, so after a restart the
    # Recent runs row of an output conflict could name no subject. The
    # committed graph still records the nodes; the snapshot lists those
    # behind the reason its summary quotes.
    root = tmp_path / "project"
    root.mkdir()
    run_id = "run-12345678"
    nodes = [
        _blocked_node("recon", "sub-905", _CONFLICT),
        _blocked_node("recon", "sub-902", _CONFLICT, status="withheld"),
        _blocked_node(
            "enigma", None, "Resolve dependency recon because it was blocked."
        ),
        {
            "nodeId": "recon:sub-901",
            "stepKey": "recon",
            "subjectId": "sub-901",
            "scope": "subject",
            "status": "done",
            "dependencies": [],
        },
    ]
    RunStore(str(root)).commit(
        {
            "runId": run_id,
            "project": _project(root),
            "startedAtMs": 1,
            "endedAtMs": 2,
            "status": "blocked",
            "dryRun": False,
            "durable": True,
            "scope": {},
            "nodes": nodes,
            "jobs": [_job(root, 116)],
            "receipts": [],
            "manifest": {"schemaVersion": 1, "runId": run_id},
        }
    )
    stored = RunStore(str(root)).load(run_id)
    manager = WorkflowManager(_Emitter())
    try:
        snapshot = manager.bootstrap(
            {"project": _project(root), "runLimit": 10, "logLimit": 0}
        )
    finally:
        manager.shutdown()

    (run,) = snapshot["runs"]
    assert run["summary"]["message"] == (
        "This pass runs 1 node; 3 blocked nodes will not run. "
        f"{_CONFLICT} 1 more reason applies."
    )
    assert run["quotedReasonNodes"] == [
        {
            "stepKey": "recon",
            "subjectId": "sub-905",
            "status": "blocked",
            "reason": _CONFLICT,
        },
        {
            "stepKey": "recon",
            "subjectId": "sub-902",
            "status": "withheld",
            "reason": _CONFLICT,
        },
    ]
    # The read writes nothing: the committed record is unchanged.
    assert RunStore(str(root)).load(run_id) == stored


def test_quoted_reason_nodes_are_left_out_rather_than_listed_in_part() -> None:
    quoted = WorkflowManager._quoted_reason_nodes
    assert quoted({"nodes": []}) == {}
    assert quoted({"nodes": [{"stepKey": "recon", "status": "done"}]}) == {}
    # No reason to quote.
    assert quoted({"nodes": [_blocked_node("recon", "sub-01", "")]}) == {}
    at_bound = [_blocked_node("recon", f"sub-{i:03d}", "Blocked.") for i in range(256)]
    assert len(quoted({"nodes": at_bound})["quotedReasonNodes"]) == 256
    over_bound = [*at_bound, _blocked_node("recon", "sub-999", "Blocked.")]
    assert quoted({"nodes": over_bound}) == {}
    # The repeated reason text stays inside its budget.
    long_reason = "x" * 1_000
    many = [_blocked_node("recon", f"sub-{i:03d}", long_reason) for i in range(66)]
    assert quoted({"nodes": many}) == {}
    # A field outside the renderer contract leaves the list out.
    assert quoted({"nodes": [_blocked_node("unknown-step", "sub-01", "B.")]}) == {}
    assert quoted({"nodes": [_blocked_node("recon", "", "B.")]}) == {}


def test_bootstrap_names_an_unknown_persistence_error_job_exactly_once(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    # Model what _retain_unproved_process leaves behind when its commit fails:
    # an active status carrying a failed persistence status.
    unproved = _job(root, 0, status="unknown")
    unproved["persistenceStatus"] = "error"
    unproved["durable"] = False
    _commit(root, [unproved])
    manager = WorkflowManager(_Emitter())
    try:
        with manager._lock:
            manager._active_jobs[unproved["id"]] = copy.deepcopy(unproved)
            manager._persistence_errors[unproved["id"]] = copy.deepcopy(unproved)
        snapshot = manager.bootstrap(
            {"project": _project(root), "runLimit": 10, "logLimit": 0}
        )
    finally:
        with manager._lock:
            manager._active_jobs.clear()
            manager._persistence_errors.clear()
        manager.shutdown()

    job_ids = [job["id"] for job in snapshot["jobs"]]
    assert len(job_ids) == len(set(job_ids))
    assert job_ids.count(unproved["id"]) == 1


def test_bootstrap_reconciles_stale_active_run_beyond_manifest_page(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    store = RunStore(str(root))
    stale_run_id = "run-00000000"
    for index in range(202):
        run_id = f"run-{index:08x}"
        status = "queued" if index == 0 else "done"
        job = _job(root, index, status=status)
        job["id"] = f"#run-job-{index:04d}"
        job["runId"] = run_id
        log = root / ".supraspina" / "runs" / run_id / "logs" / f"{index}.log"
        job["stdoutPath"] = str(log)
        job["stderrPath"] = str(log)
        store.commit(
            {
                "runId": run_id,
                "project": _project(root),
                "startedAtMs": index + 1,
                "endedAtMs": None if status == "queued" else index + 2,
                "status": status,
                "dryRun": False,
                "durable": True,
                "scope": {"analysisSubjectIds": [job["subjectId"]]},
                "nodes": [
                    {
                        "nodeId": job["nodeId"],
                        "stepKey": "recon",
                        "subjectId": job["subjectId"],
                        "scope": "subject",
                        "status": status,
                        "dependencies": [],
                    }
                ],
                "jobs": [job],
                "receipts": [],
                "manifest": {"schemaVersion": 1, "runId": run_id},
            }
        )
    manager = WorkflowManager(_Emitter())
    try:
        snapshot = manager.bootstrap(
            {"project": _project(root), "runLimit": 1, "logLimit": 0}
        )
    finally:
        manager.shutdown()

    assert len(snapshot["runs"]) == 1
    recovered = store.load(stale_run_id)
    assert recovered["status"] == "interrupted"
    assert recovered["jobs"][0]["status"] == "interrupted"
    assert recovered["recovery"]["state"] == "interrupted"


def test_bootstrap_replays_history_and_reconciles_stale_work_after_epoch_change(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    store = RunStore(str(root))
    for run_id, status in (("run-aaaaaaaa", "done"), ("run-bbbbbbbb", "running")):
        job = _job(root, 1, status=status)
        job["id"] = f"#{run_id}"
        job["runId"] = run_id
        job["status"] = status
        job["endedAt"] = 2 if status == "done" else None
        job["terminalReason"] = "completed" if status == "done" else None
        store.commit(
            {
                "runId": run_id,
                "project": _project(root, epoch=1),
                "startedAtMs": 1,
                "endedAtMs": 2 if status == "done" else None,
                "status": status,
                "dryRun": False,
                "durable": True,
                "scope": {"analysisSubjectIds": [job["subjectId"]]},
                "nodes": [
                    {
                        "nodeId": job["nodeId"],
                        "stepKey": "recon",
                        "subjectId": job["subjectId"],
                        "scope": "subject",
                        "status": status,
                        "dependencies": [],
                    }
                ],
                "jobs": [job],
                "receipts": [],
                "manifest": {"schemaVersion": 1, "runId": run_id},
            }
        )

    manager = WorkflowManager(_Emitter())
    try:
        snapshot = manager.bootstrap(
            {
                "project": _project(root, epoch=2),
                "runLimit": 10,
                "logLimit": 0,
            }
        )
    finally:
        manager.shutdown()

    assert {run["runId"] for run in snapshot["runs"]} == {
        "run-aaaaaaaa",
        "run-bbbbbbbb",
    }
    assert {run["projectEpoch"] for run in snapshot["runs"]} == {2}
    assert all(
        run["acknowledgements"]
        == {
            "includeDeferredAndUnreviewedQc": False,
            "acknowledgeMemoryAdvisory": False,
        }
        for run in snapshot["runs"]
    )
    assert {job["projectEpoch"] for job in snapshot["jobs"]} == {2}
    assert store.load("run-aaaaaaaa")["status"] == "done"
    recovered = store.load("run-bbbbbbbb")
    assert recovered["status"] == "unknown"
    assert recovered["jobs"][0]["status"] == "unknown"
    assert recovered["recovery"]["state"] == "unknown"


def test_bootstrap_projects_restored_jobs_into_the_current_sidecar_generation(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    store = RunStore(str(root))
    done = _job(root, 1)
    queued = _job(root, 2, status="queued")
    for job in (done, queued):
        job["sidecarGeneration"] = 4
    store.commit(
        {
            "runId": "run-12345678",
            "project": _project(root, epoch=1),
            "startedAtMs": 1,
            "endedAtMs": None,
            "status": "running",
            "dryRun": False,
            "durable": True,
            "scope": {"analysisSubjectIds": [done["subjectId"], queued["subjectId"]]},
            "nodes": [
                {
                    "nodeId": job["nodeId"],
                    "stepKey": "recon",
                    "subjectId": job["subjectId"],
                    "scope": "subject",
                    "status": job["status"],
                    "dependencies": [],
                }
                for job in (done, queued)
            ],
            "jobs": [done, queued],
            "receipts": [],
            "manifest": {"schemaVersion": 1, "runId": "run-12345678"},
        }
    )

    manager = WorkflowManager(_Emitter())
    manager.attach_supervisor_generation(5)
    try:
        snapshot = manager.bootstrap(
            {
                "project": _project(root, epoch=1),
                "runLimit": 10,
                "logLimit": 0,
            }
        )
    finally:
        manager.shutdown()

    assert snapshot["sidecarGeneration"] == 5
    assert [run["status"] for run in snapshot["runs"]] == ["interrupted"]
    assert {job["id"] for job in snapshot["jobs"]} == {done["id"], queued["id"]}
    assert {job["sidecarGeneration"] for job in snapshot["jobs"]} == {5}
    # The durable record keeps the generation that actually ran each job.
    recovered = store.load("run-12345678")
    assert recovered["status"] == "interrupted"
    assert {job["sidecarGeneration"] for job in recovered["jobs"]} == {4}


def test_workflow_manager_burst_cancels_running_and_queued_then_rehydrates(  # noqa: PLR0915
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Adapter:
        def execution_action(
            self, _cfg: dict[str, Any], _subject_id: str | None
        ) -> ExecutionAction:
            return ExecutionAction(kind="command", argv=("scientific",))

        def required_check_ids(self, _cfg: dict[str, Any]) -> tuple[str, ...]:
            return ()

        def params(self, _cfg: dict[str, Any]) -> dict[str, Any]:
            return {}

        def resolve(self, value: str, _cfg: dict[str, Any]) -> str:
            return value

        def parse_failure(self, _rc: int, _stdout: str, _stderr: str) -> None:
            return None

        def detect(self, _cfg: dict[str, Any], _subject_id: str | None) -> StepStatus:
            return StepStatus("pending")

    class _Proc:
        pid = None
        stdout: tuple[str, ...] = ()
        _supraspina_pgid = _SETTLED_PGID

        def __init__(self, *, immediate: bool) -> None:
            self._settled = threading.Event()
            self.returncode: int | None = None
            if immediate:
                self.returncode = 0
                self._settled.set()

        def poll(self) -> int | None:
            return self.returncode

        def wait(self, timeout: float | None = None) -> int:
            if not self._settled.wait(timeout):
                raise TimeoutError
            return int(self.returncode or 0)

        def terminate(self) -> None:
            self.returncode = 130
            self._settled.set()

        def kill(self) -> None:
            self.terminate()

    root = tmp_path / "project"
    root.mkdir()
    # Cross the real terminal-history boundary with a production-valid queue size.
    # Settle two jobs, keep three running, and leave the rest queued.
    completed_before_burst = 2
    queue_limit = 3
    terminal_limit = workflow_module.TERMINAL_CACHE_LIMIT
    subject_count = terminal_limit + 10
    subjects = [f"sub-{index:04d}" for index in range(subject_count)]
    identity = ProjectIdentity(
        "project-durable",
        str(root.resolve()),
        str((root / "supraspina.project.json").resolve()),
        1,
    )
    nodes = [
        {
            "nodeId": f"recon:{subject_id}",
            "stepKey": "recon",
            "subjectId": subject_id,
            "scope": "subject",
            "dependencies": [],
            "status": "queued",
        }
        for subject_id in subjects
    ]
    state = {
        "runId": "run-baba0001",
        "project": identity.to_dict(),
        "config": {},
        "scope": {
            "analysisSubjectIds": subjects,
            "selectedSubjectIds": subjects,
            "analysisDigest": "analysis",
            "selectedDigest": "selected",
        },
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "nodes": nodes,
        "jobs": [],
        "receipts": [],
        "warnings": [],
        "environmentEvidence": {},
        "failurePolicy": {
            "stopOnError": False,
            "continueIndependentAfterError": True,
        },
        "startedAtMs": 1,
        "endedAtMs": None,
        "status": "queued",
        "dryRun": False,
        "durable": False,
    }
    cohort = CohortSnapshot(
        analysis_subject_ids=tuple(subjects),
        selected_subject_ids=tuple(subjects),
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(),
        qc_verdicts=(),
        qc_acknowledged=True,
        excluded_by_config=(),
        excluded_by_qc=(),
    )
    spawned: list[_Proc] = []
    spawn_lock = threading.Lock()
    burst_ready = threading.Event()

    def spawn(_argv: list[str]) -> _Proc:
        with spawn_lock:
            proc = _Proc(immediate=len(spawned) < completed_before_burst)
            spawned.append(proc)
            if len(spawned) == completed_before_burst + queue_limit:
                burst_ready.set()
            return proc

    monkeypatch.setitem(workflow_module.ADAPTERS, "recon", _Adapter())
    monkeypatch.setattr(
        workflow_module,
        "detector_evidence",
        lambda _adapter, _cfg, _subject_id: {
            "state": "done",
            "detail": "synthetic completion",
            "artifacts": [],
        },
    )
    monkeypatch.setattr(workflow_module, "_schedule_force_termination", lambda _p: None)
    manager = WorkflowManager(_Emitter(), spawn=spawn)
    manager.project_epochs.validate(_project(root))
    ctx = _RunContext(
        state=state,
        cfg={},
        effective_cfg={},
        cohort=cohort,
        project=identity,
        store=RunStore(str(root)),
        queue_limit=queue_limit,
    )
    for node in nodes:
        job = manager._new_job(ctx, node)
        state["jobs"].append(job)
        manager._active_jobs[job["id"]] = job
    manager._commit(ctx)
    try:
        with manager._wake:
            manager._runs[state["runId"]] = ctx
            manager._wake.notify_all()
        assert burst_ready.wait(timeout=10)
        with spawn_lock:
            spawned_count = len(spawned)
        with manager._lock:
            done = sum(job["status"] == "done" for job in state["jobs"])
            running = sum(job["status"] == "running" for job in state["jobs"])
            queued = sum(job["status"] == "queued" for job in state["jobs"])
        assert spawned_count == completed_before_burst + queue_limit
        assert (done, running, queued) == (
            completed_before_burst,
            queue_limit,
            subject_count - spawned_count,
        )

        result = manager.cancel_run(
            {"project": _project(root), "runId": state["runId"]}, timeout=10
        )
        assert result["accepted"] is True
        assert result["terminal"] is True
        assert result["pendingJobIds"] == []

        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and manager.active_counts() != (0, 0):
            time.sleep(0.02)
        assert manager.active_counts() == (0, 0)
        assert len(manager._terminal_jobs) == terminal_limit
        persisted = ctx.store.load(state["runId"])
        statuses = [job["status"] for job in persisted["jobs"]]
        assert len(statuses) == subject_count
        assert "done" in statuses
        assert "cancelled" in statuses
    finally:
        manager.shutdown()

    reloaded = WorkflowManager(_Emitter())
    try:
        snapshot = reloaded.bootstrap(
            {"project": _project(root, epoch=2), "runLimit": 10, "logLimit": 0}
        )
        assert len(snapshot["jobs"]) == terminal_limit
        assert {job["projectEpoch"] for job in snapshot["jobs"]} == {2}
        manifest = reloaded.manifest_for_run(_project(root, epoch=2), state["runId"])
        assert manifest["runId"] == state["runId"]
    finally:
        reloaded.shutdown()
