"""Tests for immediate workflow cancellation and atomic copy-through behavior."""

from __future__ import annotations

import hashlib
import io
import os
import stat
import threading
from pathlib import Path
from typing import Any

import pytest

import supraspina_sidecar.workflow_manager as workflow_module
from supraspina_sidecar.adapters.base import ExecutionAction, StepStatus
from supraspina_sidecar.cohort import CohortSnapshot
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.run_store import PersistenceError, RunStore
from supraspina_sidecar.workflow_manager import WorkflowManager, _RunContext


class _Emitter:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def emit(self, method: str, params: dict[str, Any]) -> None:
        self.events.append((method, params))


class _CommandAdapter:
    def execution_action(
        self, _cfg: dict[str, Any], _subject_id: str | None
    ) -> ExecutionAction:
        return ExecutionAction(kind="command", argv=("scientific",))

    def parse_failure(self, _rc: int, _stdout: str, _stderr: str) -> None:
        return None

    def detect(self, _cfg: dict[str, Any], _subject_id: str | None) -> StepStatus:
        return StepStatus("pending")


class _Gate:
    def __init__(self) -> None:
        self.writes: list[str] = []
        self.closed = False

    def write(self, value: str) -> None:
        self.writes.append(value)

    def flush(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True


#: Model a spawned process whose group has already gone. A real spawn always
#: records a process group; an unknown group is never proof of settlement.
SETTLED_PGID = 999_331


@pytest.fixture(autouse=True)
def _settled_process_group(monkeypatch: pytest.MonkeyPatch) -> None:
    """Report the fake spawn's process group as gone without a real syscall."""
    real_state = workflow_module._process_group_state
    real_group = workflow_module._process_group
    monkeypatch.setattr(
        workflow_module,
        "_process_group_state",
        lambda pgid: "dead" if pgid == SETTLED_PGID else real_state(pgid),
    )
    monkeypatch.setattr(
        workflow_module,
        "_process_group",
        lambda proc: (
            SETTLED_PGID
            if getattr(proc, "_supraspina_pgid", None) == SETTLED_PGID
            else real_group(proc)
        ),
    )


class _GatedProc:
    stdout: tuple[str, ...] = ()

    def __init__(self, *, pid: int | None = None, exited: bool = False) -> None:
        self._supraspina_pgid: int | None = SETTLED_PGID
        self.pid = pid
        self.stdin = _Gate()
        self._supraspina_gate_stream = self.stdin
        self._exit_code: int | None = 0 if exited else None

    def poll(self) -> int | None:
        return self._exit_code

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        if self._exit_code is None:
            self._exit_code = 125
        return self._exit_code

    def terminate(self) -> None:
        self._exit_code = 125

    def kill(self) -> None:
        self._exit_code = 125


def _project(root: Path) -> tuple[ProjectIdentity, dict[str, Any]]:
    raw = {
        "projectId": "cancel-project",
        "root": str(root.resolve()),
        "configPath": str((root / "supraspina.project.json").resolve()),
        "epoch": 1,
    }
    return (
        ProjectIdentity(
            raw["projectId"],
            raw["root"],
            raw["configPath"],
            raw["epoch"],
        ),
        raw,
    )


def _context(root: Path, identity: ProjectIdentity) -> _RunContext:
    run_id = "run-cacacaca"
    nodes = [
        {
            "nodeId": "recon:sub-001",
            "stepKey": "recon",
            "subjectId": "sub-001",
            "scope": "subject",
            "dependencies": [],
            "status": "queued",
        },
        {
            "nodeId": "features:cohort",
            "stepKey": "features",
            "subjectId": None,
            "scope": "cohort",
            "dependencies": ["recon:sub-001"],
            "status": "planned",
        },
    ]
    jobs = [
        {
            "id": "#queued-job",
            "runId": run_id,
            "nodeId": "recon:sub-001",
            "projectId": identity.project_id,
            "projectEpoch": identity.epoch,
            "stepKey": "recon",
            "subjectId": "sub-001",
            "scope": "subject",
            "status": "queued",
            "plannedAt": 1,
            "startedAt": None,
            "endedAt": None,
            "persistenceStatus": "durable",
        }
    ]
    state = {
        "runId": run_id,
        "project": identity.to_dict(),
        "startedAtMs": 1,
        "status": "running",
        "dryRun": False,
        "config": {},
        "scope": {
            "analysisSubjectIds": ["sub-001"],
            "selectedSubjectIds": ["sub-001"],
            "analysisDigest": "analysis",
            "selectedDigest": "selected",
        },
        "intent": {"kind": "workflow"},
        "nodes": nodes,
        "jobs": jobs,
        "receipts": [],
        "warnings": [],
        "environmentEvidence": {},
        "failurePolicy": {
            "stopOnError": False,
            "continueIndependentAfterError": True,
        },
    }
    cohort = CohortSnapshot(
        analysis_subject_ids=("sub-001",),
        selected_subject_ids=("sub-001",),
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(),
        qc_verdicts=(("sub-001", "pass"),),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )
    return _RunContext(
        state=state,
        cfg={},
        effective_cfg={},
        cohort=cohort,
        project=identity,
        store=RunStore(str(root)),
        queue_limit=1,
    )


def test_cancel_run_terminalizes_queued_and_unscheduled_work_without_spawn(
    tmp_path: Path,
) -> None:
    emitter = _Emitter()
    spawn_calls: list[list[str]] = []

    def spawn(argv: list[str], _cfg: dict[str, Any]) -> Any:
        spawn_calls.append(argv)
        raise AssertionError("Prevent canceled queued work from spawning.")

    manager = WorkflowManager(emitter, spawn=spawn)
    identity, raw_project = _project(tmp_path)
    manager.project_epochs.validate(
        raw_project, {"paths": {"projectRoot": str(tmp_path)}}
    )
    ctx = _context(tmp_path, identity)
    job = ctx.state["jobs"][0]
    try:
        # Hold the scheduler condition to make insertion and cancellation one
        # atomic operation without a background-tick race.
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._active_jobs[job["id"]] = job
            result = manager.cancel_run(
                {"project": raw_project, "runId": ctx.state["runId"]},
                timeout=0.1,
            )
        assert result["accepted"] is True
        assert result["terminal"] is True
        assert result["pendingJobIds"] == []
        assert result["message"] == "Cancellation settled."
        assert spawn_calls == []
        persisted = ctx.store.load(ctx.state["runId"])
        assert persisted["status"] == "cancelled"
        assert {node["status"] for node in persisted["nodes"]} == {"cancelled"}
        # Both the queued node and the never-queued node carry the fact.
        assert {node["reason"] for node in persisted["nodes"]} == {
            "This work was canceled before scheduling at the operator's request."
        }
        assert persisted["jobs"][0]["status"] == "cancelled"
        assert persisted["jobs"][0]["terminalReason"] == (
            "operator_cancelled_before_start"
        )
    finally:
        manager.shutdown()


def test_cancel_run_still_terminates_and_retains_ownership_when_commit_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = WorkflowManager(_Emitter())
    identity, raw_project = _project(tmp_path)
    manager.project_epochs.validate(
        raw_project, {"paths": {"projectRoot": str(tmp_path)}}
    )
    ctx = _context(tmp_path, identity)
    job = ctx.state["jobs"][0]
    job["status"] = "running"
    job["startedAt"] = 2
    ctx.state["nodes"][0]["status"] = "running"
    proc = object()
    ctx.processes[job["id"]] = proc
    terminated: list[tuple[object, bool]] = []
    escalated: list[object] = []
    monkeypatch.setattr(
        manager,
        "_commit",
        lambda _ctx: (_ for _ in ()).throw(
            PersistenceError("Fail the simulated disk write.")
        ),
    )
    monkeypatch.setattr(
        workflow_module,
        "_terminate_tree",
        lambda owned, *, force=False: terminated.append((owned, force)),
    )
    monkeypatch.setattr(
        workflow_module, "_schedule_force_termination", escalated.append
    )
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._active_jobs[job["id"]] = job
        result = manager.cancel_run(
            {"project": raw_project, "runId": ctx.state["runId"]}, timeout=0.01
        )

        assert result["accepted"] is True
        assert result["message"] == "The run cancellation could not be persisted."
        assert terminated == [(proc, False)]
        assert escalated == [proc]
        assert ctx.cancel_events[job["id"]].is_set()
        assert manager._runs[ctx.state["runId"]] is ctx
        assert manager._active_jobs[job["id"]] is job
        assert job["status"] == "persistence-error"
        assert ctx.state["status"] == "persistence-error"
    finally:
        with manager._wake:
            ctx.processes.clear()
            manager._active_jobs.clear()
            manager._runs.clear()
        manager.shutdown()


def test_execute_cancellation_before_release_never_opens_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    proc = _GatedProc()
    gate = proc.stdin
    manager = WorkflowManager(_Emitter(), spawn=lambda _argv: proc)
    identity, _raw_project = _project(tmp_path)
    ctx = _context(tmp_path, identity)
    node = ctx.state["nodes"][0]
    job = ctx.state["jobs"][0]
    node["status"] = "running"
    job.update(
        {
            "status": "running",
            "startedAt": 2,
            "stdoutPath": str(tmp_path / "logs" / "cancel-before-release.log"),
        }
    )
    job["stderrPath"] = job["stdoutPath"]
    cancel_event = threading.Event()
    cancel_event.set()
    adapter = _CommandAdapter()
    monkeypatch.setitem(workflow_module.ADAPTERS, "recon", adapter)
    monkeypatch.setattr(
        manager,
        "_expected",
        lambda _ctx, _step, _subject: (
            "launch-signature",
            {
                "executionActionDigest": workflow_module.execution_action_digest(
                    adapter.execution_action(ctx.effective_cfg, node.get("subjectId"))
                ),
                "externalInputs": {},
            },
        ),
    )
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._active_jobs[job["id"]] = job

        manager._execute(ctx, node["nodeId"], job["id"], cancel_event)

        persisted = ctx.store.load(ctx.state["runId"])
        assert proc.stdin is None
        assert proc._supraspina_gate_stream is None
        assert gate.writes == []
        assert gate.closed is True
        assert persisted["jobs"][0]["status"] == "cancelled"
        assert persisted["receipts"] == []
    finally:
        with manager._wake:
            ctx.processes.clear()
            manager._active_jobs.clear()
            manager._runs.clear()
        manager.shutdown()


def test_execute_settlement_failure_retains_unknown_process_ownership(  # noqa: PLR0915
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    emitter = _Emitter()
    proc = _GatedProc(pid=4243, exited=True)
    gate = proc.stdin
    manager = WorkflowManager(emitter, spawn=lambda _argv: proc)
    identity, _raw_project = _project(tmp_path)
    ctx = _context(tmp_path, identity)
    node = ctx.state["nodes"][0]
    job = ctx.state["jobs"][0]
    node["status"] = "running"
    job.update(
        {
            "status": "running",
            "startedAt": 2,
            "stdoutPath": str(tmp_path / "logs" / "unproved-settlement.log"),
        }
    )
    job["stderrPath"] = job["stdoutPath"]
    expected_calls = 0

    adapter = _CommandAdapter()

    def expected(
        _ctx: _RunContext, _step_key: str, _subject_id: str | None
    ) -> tuple[str, dict[str, Any]]:
        nonlocal expected_calls
        expected_calls += 1
        return "launch-signature", {
            "executionActionDigest": workflow_module.execution_action_digest(
                adapter.execution_action(ctx.effective_cfg, node.get("subjectId"))
            ),
            "externalInputs": {},
        }

    monkeypatch.setitem(workflow_module.ADAPTERS, "recon", adapter)
    monkeypatch.setattr(manager, "_expected", expected)
    monkeypatch.setattr(workflow_module, "_process_group", lambda _proc: 4243)
    monkeypatch.setattr(workflow_module, "_settle_group", lambda _proc, _pgid: False)
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._active_jobs[job["id"]] = job

        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())

        persisted = ctx.store.load(ctx.state["runId"])
        persisted_node = next(
            value for value in persisted["nodes"] if value["nodeId"] == node["nodeId"]
        )
        persisted_job = persisted["jobs"][0]
        assert gate.writes == ["1"]
        assert gate.closed is True
        assert expected_calls == 1
        assert persisted_node["status"] == "unknown"
        assert persisted_node["reason"] == (
            "An external process may still be active; Supraspina could not confirm "
            "that it ended."
        )
        assert persisted_job["status"] == "unknown"
        assert persisted_job["endedAt"] is None
        ownership = persisted_job["processOwnership"]
        assert ownership["schemaVersion"] == 1
        assert ownership["claimId"].startswith("claim-")
        assert ownership["operationKind"] == "workflow"
        assert ownership["ownerId"] == job["id"]
        assert ownership["projectId"] == identity.project_id
        assert ownership["projectEpoch"] == identity.epoch
        assert ownership["runId"] == ctx.state["runId"]
        assert ownership["jobId"] == job["id"]
        assert ownership["operationId"] is None
        assert ownership["pid"] == 4243
        assert ownership["pgid"] == 4243
        assert ownership["startIdentity"].startswith("local:4243:")
        assert ownership["state"] == "unknown"
        assert ownership["provedStopped"] is False
        assert ownership["detail"] == (
            "An external process may still be active; Supraspina could not confirm "
            "that it ended."
        )
        assert persisted["status"] == "unknown"
        assert persisted["endedAtMs"] is None
        assert persisted["recovery"]["state"] == "unknown"
        assert persisted["receipts"] == []
        assert ctx.processes[job["id"]] is proc
        assert manager._active_jobs[job["id"]] is job
        assert manager._runs[ctx.state["runId"]] is ctx
        assert manager.project_active(identity.project_id) is True
        assert job["id"] not in manager._terminal_jobs
        assert any(
            method == "system.processSettled" and payload.get("provedStopped") is False
            for method, payload in emitter.events
        )
    finally:
        with manager._wake:
            ctx.processes.clear()
            manager._active_jobs.clear()
            manager._runs.clear()
        manager.shutdown()


def test_execute_refuses_receipt_when_signed_inputs_change_after_launch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Adapter:
        def execution_action(
            self, _cfg: dict[str, Any], _subject_id: str | None
        ) -> ExecutionAction:
            return ExecutionAction(kind="command", argv=("scientific",))

        def parse_failure(self, _rc: int, _stdout: str, _stderr: str) -> None:
            return None

        def detect(self, _cfg: dict[str, Any], _subject_id: str | None) -> StepStatus:
            return StepStatus("pending")

    class _Proc:
        pid = None
        stdout: tuple[str, ...] = ()
        returncode = 0
        _supraspina_pgid = SETTLED_PGID

        def poll(self) -> int:
            return 0

        def wait(self, timeout: float | None = None) -> int:
            return 0

    manager = WorkflowManager(_Emitter(), spawn=lambda _argv: _Proc())
    identity, _raw_project = _project(tmp_path)
    ctx = _context(tmp_path, identity)
    job = ctx.state["jobs"][0]
    job["status"] = "running"
    job["startedAt"] = 2
    job["stdoutPath"] = str(tmp_path / "logs" / "job.log")
    job["stderrPath"] = job["stdoutPath"]
    ctx.state["nodes"][0]["status"] = "running"
    calls = 0

    adapter = _Adapter()
    action_digest = workflow_module.execution_action_digest(
        adapter.execution_action(ctx.effective_cfg, ctx.state["nodes"][0]["subjectId"])
    )

    def expected(
        _ctx: _RunContext, _step_key: str, _subject_id: str | None
    ) -> tuple[str, dict[str, Any]]:
        nonlocal calls
        calls += 1
        signature = "launch-signature" if calls == 1 else "changed-signature"
        return signature, {
            "executionActionDigest": action_digest,
            "externalInputs": {"model": {"sha256": signature}},
        }

    monkeypatch.setitem(workflow_module.ADAPTERS, "recon", adapter)
    monkeypatch.setattr(manager, "_expected", expected)
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._active_jobs[job["id"]] = job
        manager._execute(
            ctx,
            ctx.state["nodes"][0]["nodeId"],
            job["id"],
            threading.Event(),
        )

        persisted = ctx.store.load(ctx.state["runId"])
        assert persisted["receipts"] == []
        assert persisted["jobs"][0]["status"] == "failed"
        assert persisted["jobs"][0]["launchInputSnapshot"] == {
            "expectedSignature": "launch-signature",
            "externalInputs": {"model": {"sha256": "launch-signature"}},
            "inputProjections": [],
        }
        assert "inputs changed" in persisted["nodes"][0]["reason"]
    finally:
        with manager._wake:
            manager._runs.clear()
        manager.shutdown()


def test_execute_rejects_projection_source_change_before_gate_release(  # noqa: PLR0915
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Adapter:
        def execution_action(
            self, _cfg: dict[str, Any], _subject_id: str | None
        ) -> ExecutionAction:
            return ExecutionAction(kind="command", argv=("clinical",))

        def parse_failure(self, _rc: int, _stdout: str, _stderr: str) -> None:
            return None

    spawned: list[list[str]] = []

    def spawn(argv: list[str]) -> None:
        spawned.append(argv)
        raise AssertionError("Prevent mismatched projection inputs from spawning.")

    manager = WorkflowManager(_Emitter(), spawn=spawn)
    identity, _raw_project = _project(tmp_path)
    ctx = _context(tmp_path, identity)
    node = ctx.state["nodes"][0]
    node.update(
        {
            "nodeId": "clinical:cohort",
            "stepKey": "clinical",
            "subjectId": None,
            "scope": "cohort",
            "status": "running",
        }
    )
    ctx.state["nodes"] = [node]
    job = ctx.state["jobs"][0]
    job.update(
        {
            "nodeId": node["nodeId"],
            "stepKey": "clinical",
            "subjectId": None,
            "scope": "cohort",
            "status": "running",
            "startedAt": 2,
            "stdoutPath": str(tmp_path / "logs" / "clinical.log"),
        }
    )
    job["stderrPath"] = job["stdoutPath"]
    ctx.state["jobs"] = [job]
    projection = tmp_path / "runtime" / "clinical.csv"
    ctx.effective_cfg = {
        "_supraspinaRuntime": {"clinicalMetadataFile": str(projection)}
    }
    old_source = {
        "exists": True,
        "kind": "file",
        "path": str(tmp_path / "metadata.csv"),
        "size": 3,
        "sha256": "old-source",
    }
    new_source = {**old_source, "sha256": "new-source"}
    registry_identity = {
        "exists": True,
        "kind": "file",
        "path": str(tmp_path / ".supraspina" / "registry.json"),
        "size": 4,
        "sha256": "registry",
    }

    def prepare(_ctx: _RunContext, _step_key: str) -> None:
        projection.parent.mkdir(parents=True, exist_ok=True)
        projection.write_bytes(b"old projection")
        output_sha = hashlib.sha256(projection.read_bytes()).hexdigest()
        _ctx.state["inputProjections"] = [
            {
                "kind": "clinical",
                "inputIdentity": old_source,
                "inputSha256": old_source["sha256"],
                "outputSha256": output_sha,
                "registryIdentity": registry_identity,
            }
        ]

    bound_payloads: list[dict[str, Any]] = []
    bound_signatures: list[str] = []

    def expected(
        _ctx: _RunContext, _step_key: str, _subject_id: str | None
    ) -> tuple[str, dict[str, Any]]:
        signature, payload = manager._bind_projection_inputs(
            "clinical",
            "base-signature",
            {
                "externalInputs": {
                    "clinicalMetadata": new_source,
                    "subjectRegistry": registry_identity,
                }
            },
        )
        bound_payloads.append(payload)
        bound_signatures.append(signature)
        return signature, payload

    monkeypatch.setitem(workflow_module.ADAPTERS, "clinical", _Adapter())
    monkeypatch.setattr(manager, "_prepare_inputs", prepare)
    monkeypatch.setattr(manager, "_expected", expected)
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._active_jobs[job["id"]] = job
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())

        persisted = ctx.store.load(ctx.state["runId"])
        binding = bound_payloads[0]["externalInputs"]["runScopedProjectionBinding"]
        assert binding["sourceIdentity"] == new_source
        assert binding["registryIdentity"] == registry_identity
        assert bound_signatures[0] == workflow_module.stable_digest(bound_payloads[0])
        assert spawned == []
        assert "launchInputSnapshot" not in persisted["jobs"][0]
        assert persisted["jobs"][0]["status"] == "failed"
        assert persisted["receipts"] == []
    finally:
        with manager._wake:
            manager._runs.clear()
        manager.shutdown()


def _copy(
    source: Path,
    destination: Path,
    *,
    force: bool = False,
    cancel_event: Any | None = None,
) -> io.StringIO:
    log = io.StringIO()
    WorkflowManager._copy_action(
        ExecutionAction(
            kind="copy",
            source=str(source),
            destination=str(destination),
            force=force,
        ),
        cancel_event or threading.Event(),
        log,
    )
    return log


def test_copy_through_preserves_bytes_and_metadata(tmp_path: Path) -> None:
    source = tmp_path / "source.nii.gz"
    destination = tmp_path / "out" / "destination.nii.gz"
    source.write_bytes(b"scientific-input")
    source.chmod(0o640)
    log = _copy(source, destination)
    assert destination.read_bytes() == source.read_bytes()
    assert stat.S_IMODE(destination.stat().st_mode) == 0o640
    assert log.getvalue() == (
        "Supraspina completed the copy-through with metadata preserved.\n"
    )
    assert not list(destination.parent.glob(".destination.nii.gz.tmp-*"))


def test_nonforce_copy_refuses_preexisting_destination(tmp_path: Path) -> None:
    source = tmp_path / "source.nii.gz"
    destination = tmp_path / "destination.nii.gz"
    source.write_bytes(b"new")
    destination.write_bytes(b"existing")
    with pytest.raises(FileExistsError):
        _copy(source, destination)
    assert destination.read_bytes() == b"existing"


def test_nonforce_copy_loses_race_without_overwriting_winner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.nii.gz"
    destination = tmp_path / "destination.nii.gz"
    source.write_bytes(b"copy")
    real_link = os.link

    def racing_link(staged: str, target: str) -> None:
        Path(target).write_bytes(b"race-winner")
        real_link(staged, target)

    monkeypatch.setattr(workflow_module.os, "link", racing_link)
    with pytest.raises(FileExistsError):
        _copy(source, destination)
    assert destination.read_bytes() == b"race-winner"
    assert not list(tmp_path.glob(".destination.nii.gz.tmp-*"))


def test_cancelled_copy_never_publishes_partial_destination(tmp_path: Path) -> None:
    source = tmp_path / "source.nii.gz"
    destination = tmp_path / "destination.nii.gz"
    source.write_bytes(b"x" * (2 * 1024 * 1024))

    class _CancelAfterFirstChunk:
        calls = 0

        def is_set(self) -> bool:
            self.calls += 1
            return self.calls > 1

    with pytest.raises(
        InterruptedError, match="The copy stopped after cancellation\\."
    ):
        _copy(source, destination, cancel_event=_CancelAfterFirstChunk())
    assert not destination.exists()
    assert not list(tmp_path.glob(".destination.nii.gz.tmp-*"))


def test_force_copy_atomically_replaces_existing_destination(tmp_path: Path) -> None:
    source = tmp_path / "source.nii.gz"
    destination = tmp_path / "destination.nii.gz"
    source.write_bytes(b"replacement")
    destination.write_bytes(b"old")
    _copy(source, destination, force=True)
    assert destination.read_bytes() == b"replacement"
