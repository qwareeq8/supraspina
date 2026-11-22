"""Tests for critical workflow execution, cancellation, recovery, and shutdown."""

from __future__ import annotations

import copy
import hashlib
import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar

import pytest

from supraspina_sidecar import paths
from supraspina_sidecar import workflow_manager as runtime
from supraspina_sidecar.adapters.base import ExecutionAction, Failure
from supraspina_sidecar.cohort import CohortSnapshot, T1Resolution
from supraspina_sidecar.operator_errors import OperatorError
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.run_store import (
    PersistenceError,
    RunStore,
    execution_fallback_valid,
)
from supraspina_sidecar.workflow import PlannedWorkflow
from supraspina_sidecar.workflow_manager import WorkflowManager, _RunContext


class _Emitter:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def emit(self, method: str, params: dict[str, Any]) -> None:
        self.events.append((method, params))


class _Authorization:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, str, int, str]] = []

    def consume(
        self,
        value: Any,
        *,
        project_id: str,
        config_revision: int,
        purpose: str,
    ) -> None:
        self.calls.append((value, project_id, config_revision, purpose))


class _Adapter:
    def __init__(
        self,
        action: ExecutionAction | None = None,
        *,
        failure: str | None = None,
    ) -> None:
        self.action = action or ExecutionAction(kind="command", argv=("scientific",))
        self.failure = failure

    def execution_action(
        self, _cfg: dict[str, Any], _subject_id: str | None
    ) -> ExecutionAction:
        return self.action

    def parse_failure(
        self, _rc: int, _stdout: str, _stderr: str
    ) -> SimpleNamespace | None:
        return SimpleNamespace(message=self.failure) if self.failure else None

    def required_check_ids(self, _cfg: dict[str, Any]) -> tuple[str, ...]:
        return ("tool",)

    def detect(self, _cfg: dict[str, Any], _subject_id: str | None) -> SimpleNamespace:
        return SimpleNamespace(
            state="pending",
            detail="Report no reconstruction output.",
            artifacts=(),
        )


class _PreparingAdapter(_Adapter):
    def __init__(self, events: list[str]) -> None:
        super().__init__()
        self.events = events

    def prepare_execution(self, _cfg: dict[str, Any], _subject_id: str | None) -> None:
        self.events.append("prepare")


class _Lease:
    def __init__(self, events: list[str]) -> None:
        self.events = events

    def __enter__(self) -> None:
        self.events.append("lease-enter")

    def __exit__(self, *_args: Any) -> None:
        self.events.append("lease-exit")


class _LeasedPreparingAdapter(_PreparingAdapter):
    def execution_lease(self, _cfg: dict[str, Any], _subject_id: str | None) -> _Lease:
        return _Lease(self.events)


class _FallbackAdapter(_Adapter):
    def __init__(self, failure_tag: str) -> None:
        super().__init__()
        self.failure_tag = failure_tag

    def parse_failure(self, rc: int, _stdout: str, _stderr: str) -> Failure | None:
        if rc == 0:
            return None
        return Failure(
            code=rc,
            tag=self.failure_tag,
            message="Report a classified failure.",
        )

    def preview(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        runtime_cfg = cfg.get("_supraspinaRuntime", {})
        backend = runtime_cfg.get("resolvedReconBackend", "unresolved")
        return f"{backend} {subject_id}"


#: Model a spawned process whose group has already gone. A real spawn always
#: records a process group; an unknown group is never proof of settlement.
SETTLED_PGID = 999_331


@pytest.fixture(autouse=True)
def _settled_process_group(monkeypatch: pytest.MonkeyPatch) -> None:
    """Report the fake spawn's process group as gone without a real syscall."""
    real_state = runtime._process_group_state
    real_group = runtime._process_group
    monkeypatch.setattr(
        runtime,
        "_process_group_state",
        lambda pgid: "dead" if pgid == SETTLED_PGID else real_state(pgid),
    )
    monkeypatch.setattr(
        runtime,
        "_process_group",
        lambda proc: (
            SETTLED_PGID
            if getattr(proc, "_supraspina_pgid", None) == SETTLED_PGID
            else real_group(proc)
        ),
    )


class _Proc:
    def __init__(  # noqa: PLR0913
        self,
        *,
        rc: int = 0,
        stdout: tuple[str, ...] | None = (),
        pid: int | None = None,
        alive: bool = False,
        wait_error: Exception | None = None,
        pgid: int | None = SETTLED_PGID,
    ) -> None:
        self._supraspina_pgid: int | None = pgid
        self.rc = rc
        self.stdout = stdout
        self.pid = pid
        self.alive = alive
        self.wait_error = wait_error
        self.killed = 0
        self.terminated = 0

    def poll(self) -> int | None:
        return None if self.alive else self.rc

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        if self.wait_error is not None:
            raise self.wait_error
        self.alive = False
        return self.rc

    def kill(self) -> None:
        self.killed += 1
        self.alive = False

    def terminate(self) -> None:
        self.terminated += 1
        self.alive = False


class _Gate:
    def __init__(self) -> None:
        self.writes: list[str] = []
        self.flushed = False
        self.closed = False

    def write(self, value: str) -> None:
        self.writes.append(value)

    def flush(self) -> None:
        self.flushed = True

    def close(self) -> None:
        self.closed = True


class _GatedProc(_Proc):
    def __init__(self, on_wait: Any | None = None) -> None:
        super().__init__(rc=0, pid=None, alive=True)
        self.gate = _Gate()
        self.stdin = self.gate
        self._supraspina_gate_stream = self.gate
        self._on_wait = on_wait

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        if self._on_wait is not None:
            callback, self._on_wait = self._on_wait, None
            callback()
        self.alive = False
        return self.rc


def _identity(root: Path, *, epoch: int = 1) -> ProjectIdentity:
    return ProjectIdentity(
        "critical-recovery",
        str(root.resolve()),
        str((root / "supraspina.project.json").resolve()),
        epoch,
    )


def _project(root: Path, *, epoch: int = 1) -> dict[str, Any]:
    return _identity(root, epoch=epoch).to_dict()


def _cohort(*subject_ids: str) -> CohortSnapshot:
    return CohortSnapshot(
        analysis_subject_ids=subject_ids,
        selected_subject_ids=subject_ids,
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(),
        qc_verdicts=tuple((value, "pass") for value in subject_ids),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def _cohort_with_t1(path: Path) -> CohortSnapshot:
    subject_id = "sub-01"
    fingerprint = hashlib.sha256(path.read_bytes()).hexdigest()
    return CohortSnapshot(
        analysis_subject_ids=(subject_id,),
        selected_subject_ids=(subject_id,),
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(
            T1Resolution(
                subject_id=subject_id,
                state="resolved",
                path=str(path),
                candidates=(str(path),),
                fingerprint=fingerprint,
            ),
        ),
        qc_verdicts=((subject_id, "pass"),),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def _node(
    step_key: str = "recon",
    *,
    subject_id: str | None = "sub-01",
    status: str = "running",
    dependencies: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "nodeId": f"{step_key}:{subject_id or 'cohort'}",
        "stepKey": step_key,
        "subjectId": subject_id,
        "scope": "subject" if subject_id else "cohort",
        "dependencies": dependencies or [],
        "status": status,
    }


def _job(
    root: Path,
    node: dict[str, Any],
    *,
    job_id: str = "#critical-job",
    status: str = "running",
) -> dict[str, Any]:
    log_path = (
        root / ".supraspina" / "runs" / "run-cafe0002" / "logs" / f"{job_id[1:]}.log"
    )
    return {
        "id": job_id,
        "runId": "run-cafe0002",
        "nodeId": node["nodeId"],
        "projectId": "critical-recovery",
        "projectEpoch": 1,
        "sidecarGeneration": 0,
        "stepKey": node["stepKey"],
        "subjectId": node["subjectId"],
        "scope": node["scope"],
        "plannedAt": 1,
        "startedAt": 2 if status != "queued" else None,
        "endedAt": None,
        "exitCode": None,
        "stdoutPath": str(log_path),
        "stderrPath": str(log_path),
        "status": status,
        "dryRun": False,
        "durable": True,
        "persistenceStatus": "durable",
        "terminalReason": None,
    }


def _context(
    root: Path,
    *,
    nodes: list[dict[str, Any]] | None = None,
    jobs: list[dict[str, Any]] | None = None,
    cohort: CohortSnapshot | None = None,
    cfg: dict[str, Any] | None = None,
) -> _RunContext:
    selected = cohort or _cohort("sub-01")
    identity = _identity(root)
    state = {
        "runId": "run-cafe0002",
        "project": identity.to_dict(),
        "config": copy.deepcopy(cfg or {}),
        "configSha256": "config",
        "scope": selected.to_dict(),
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "nodes": nodes or [],
        "jobs": jobs or [],
        "receipts": [],
        "warnings": [],
        "environmentEvidence": {},
        "scientificEvidence": {},
        "failurePolicy": {
            "stopOnError": False,
            "continueIndependentAfterError": True,
        },
        "status": "running",
        "dryRun": False,
        "durable": True,
        "startedAtMs": 1,
        "endedAtMs": None,
    }
    return _RunContext(
        state=state,
        cfg=copy.deepcopy(cfg or {}),
        effective_cfg=copy.deepcopy(cfg or {}),
        cohort=selected,
        project=identity,
        store=RunStore(str(root)),
        queue_limit=2,
    )


def _auto_fallback_context(
    root: Path,
    *,
    nodes: list[dict[str, Any]],
    jobs: list[dict[str, Any]],
    cohort: CohortSnapshot,
) -> _RunContext:
    sif_path = root / "fastsurfer.sif"
    sif_path.write_bytes(b"verified test FastSurfer SIF")
    sif_bytes = sif_path.stat().st_size
    sif_sha256 = hashlib.sha256(sif_path.read_bytes()).hexdigest()
    cfg = {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(root / "rawdata"),
            "derivativesDir": str(root / "derivatives"),
        },
        "runtime": {"threads": 6},
        "tools": {"freesurferLicense": str(root / "license.txt")},
        "steps": {
            "recon": {
                "enabled": True,
                "params": {
                    "backend": "auto",
                    "fastsurferDevice": "cpu",
                    "threads": 6,
                },
            }
        },
    }
    ctx = _context(root, nodes=nodes, jobs=jobs, cohort=cohort, cfg=cfg)
    ctx.effective_cfg["_supraspinaRuntime"] = {
        "resolvedReconBackend": "freesurfer",
        "authorizedReconBackends": ["freesurfer", "fastsurfer"],
        "resolvedFastSurferDevice": "cpu",
        "fastSurferSifPath": str(sif_path),
        "apptainerExecutable": "apptainer",
        "reconInputBySubject": {
            subject_id: str(root / "rawdata" / subject_id / "anat" / "t1.nii.gz")
            for subject_id in cohort.analysis_subject_ids
        },
    }
    ctx.state["scientificEvidence"] = {
        "managedResources": {
            "fastsurfer": {
                "resource": "fastsurfer",
                "variant": "cpu",
                "version": "2.5.4",
                "role": "authorized-fallback",
                "sifBytes": sif_bytes,
                "sifSha256": sif_sha256,
            }
        }
    }
    return ctx


def _planned(
    nodes: list[dict[str, Any]],
    *,
    cohort: CohortSnapshot | None = None,
    disposition: str = "planned",
    effective_cfg: dict[str, Any] | None = None,
) -> PlannedWorkflow:
    summary = {
        "planned": len(nodes),
        "started": 0,
        "waiting": 0,
        "blocked": sum(node["status"] == "blocked" for node in nodes),
        "skipped": 0,
        "message": "planned",
    }
    return PlannedWorkflow(
        result={
            "runId": None,
            "disposition": disposition,
            "plan": {
                "planId": "run-acde1234beef",
                "nodes": copy.deepcopy(nodes),
                "blockers": [],
                "scientificEvidence": {},
                "summary": summary,
            },
            "summary": summary,
        },
        cohort=cohort,
        effective_cfg=copy.deepcopy(effective_cfg or {}),
        warnings=(),
    )


def _install_execute_basics(
    manager: WorkflowManager,
    monkeypatch: pytest.MonkeyPatch,
    *,
    evidence_state: str = "done",
) -> None:
    def expected(
        ctx: _RunContext,
        step_key: str,
        subject_id: str | None,
        *,
        cached_external_inputs: bool = True,
    ) -> tuple[str, dict[str, Any]]:
        del cached_external_inputs
        action = runtime.ADAPTERS[step_key].execution_action(
            ctx.effective_cfg, subject_id
        )
        return (
            "launch-signature",
            {
                "executionActionDigest": runtime.execution_action_digest(action),
                "externalInputs": {},
            },
        )

    monkeypatch.setattr(
        manager,
        "_expected",
        expected,
    )
    monkeypatch.setattr(manager, "_input_projection_snapshot", lambda *_args: [])
    monkeypatch.setattr(
        manager, "_validate_projection_launch_binding", lambda *_args: None
    )
    monkeypatch.setattr(
        runtime,
        "detector_evidence",
        lambda *_args: {"state": evidence_state, "artifacts": []},
    )
    monkeypatch.setattr(
        runtime, "enrich_evidence", lambda _key, evidence, *_args: evidence
    )
    monkeypatch.setattr(
        runtime, "evidence_is_done", lambda value: value.get("state") == "done"
    )
    monkeypatch.setattr(
        runtime,
        "make_receipt",
        lambda signature, payload, evidence, **kwargs: {
            "signature": signature,
            "payload": payload,
            "detectorEvidence": evidence,
            "stepKey": "recon",
            "subjectId": "sub-01",
            **kwargs,
        },
    )
    monkeypatch.setattr(manager, "_edge_evidence_for_receipt", lambda *_args: {})


def test_terminate_tree_covers_windows_and_posix_process_shapes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commands: list[list[str]] = []
    monkeypatch.setattr(runtime, "_IS_WINDOWS", True)
    monkeypatch.setattr(
        runtime.subprocess,
        "run",
        lambda command, **_kwargs: commands.append(command),
    )
    runtime._terminate_tree(_Proc(rc=0, pid=10))
    runtime._terminate_tree(_Proc(rc=0, pid=11, alive=True), force=False)
    runtime._terminate_tree(_Proc(rc=0, pid=12, alive=True), force=True)
    assert commands == [
        ["taskkill", "/PID", "11", "/T"],
        ["taskkill", "/PID", "12", "/T", "/F"],
    ]

    monkeypatch.setattr(runtime, "_IS_WINDOWS", False)
    signals: list[tuple[int, int]] = []
    monkeypatch.setattr(
        runtime.os, "killpg", lambda pgid, sig: signals.append((pgid, sig))
    )
    with_group = _Proc(alive=True)
    with_group._supraspina_pgid = 22
    runtime._terminate_tree(with_group)
    runtime._terminate_tree(with_group, force=True)
    assert [value[1] for value in signals] == [
        runtime.signal.SIGTERM,
        runtime.signal.SIGKILL,
    ]

    finished = _Proc(rc=0, pgid=None)
    runtime._terminate_tree(finished)
    no_pid = _Proc(alive=True, pgid=None)
    runtime._terminate_tree(no_pid)
    force_no_pid = _Proc(alive=True, pgid=None)
    runtime._terminate_tree(force_no_pid, force=True)
    assert no_pid.terminated == 1
    assert force_no_pid.killed == 1


def test_terminate_tree_falls_back_when_group_signalling_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    proc = _Proc(alive=True)
    proc._supraspina_pgid = 33
    monkeypatch.setattr(runtime, "_IS_WINDOWS", False)
    monkeypatch.setattr(
        runtime.os,
        "killpg",
        lambda *_args: (_ for _ in ()).throw(
            OSError("Treat the process group as gone.")
        ),
    )
    runtime._terminate_tree(proc)
    assert proc.terminated == 1

    proc = _Proc(alive=True)
    proc._supraspina_pgid = 34
    proc.terminate = lambda: (_ for _ in ()).throw(  # type: ignore[method-assign]
        OSError("Treat the process leader as gone.")
    )
    runtime._terminate_tree(proc)


def test_settle_group_posix_escalates_and_windows_reports_leader_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    proc = _Proc(alive=True)
    proc._supraspina_pgid = 44
    states = iter(["alive", "alive", "dead"])
    monkeypatch.setattr(runtime, "_IS_WINDOWS", False)
    monkeypatch.setattr(
        runtime, "_process_group_state", lambda _pgid: next(states, "dead")
    )
    monkeypatch.setattr(runtime.os, "killpg", lambda *_args: None)
    monkeypatch.setattr(runtime.time, "sleep", lambda _delay: None)
    assert runtime._settle_group(proc, 44) is True
    assert proc._supraspina_pgid is None

    monkeypatch.setattr(
        runtime.os,
        "killpg",
        lambda *_args: (_ for _ in ()).throw(ProcessLookupError()),
    )
    monkeypatch.setattr(runtime, "_process_group_state", lambda _pgid: "alive")
    assert runtime._settle_group(_Proc(alive=True), 45) is True

    monkeypatch.setattr(runtime, "_IS_WINDOWS", True)
    assert runtime._settle_group(_Proc(rc=0), 50) is True
    assert runtime._settle_group(_Proc(alive=True), 50) is False


def test_schedule_force_termination_uses_daemon_timer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    proc = object()
    terminated: list[tuple[object, bool]] = []
    timers: list[Any] = []

    class _Timer:
        def __init__(self, delay: float, callback: Any) -> None:
            self.delay = delay
            self.callback = callback
            self.daemon = False
            self.started = False
            timers.append(self)

        def start(self) -> None:
            self.started = True

    monkeypatch.setattr(runtime.threading, "Timer", _Timer)
    monkeypatch.setattr(
        runtime,
        "_terminate_tree",
        lambda value, *, force=False: terminated.append((value, force)),
    )
    runtime._schedule_force_termination(proc)
    timers[0].callback()
    assert timers[0].delay == runtime._CANCEL_GRACE_SECONDS
    assert timers[0].daemon is True
    assert timers[0].started is True
    assert terminated == [(proc, True)]


def test_expected_recurses_through_deface_subjects_and_cohort_dependencies(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = {"steps": {"deface": {"enabled": True}}}
    ctx = _context(tmp_path, cohort=_cohort("sub-01", "sub-02"), cfg=cfg)
    ctx.state["environmentEvidence"] = {"tool": {"status": "ok"}}
    manager = WorkflowManager(_Emitter())
    adapter = _Adapter()
    for key in runtime.ADAPTERS:
        monkeypatch.setitem(runtime.ADAPTERS, key, adapter)
    calls: list[tuple[str, str | None, list[str], dict[str, Any]]] = []

    def expected_signature(  # noqa: PLR0913
        step_key: str,
        subject_id: str | None,
        _cfg: dict[str, Any],
        _cohort: CohortSnapshot,
        _adapter: _Adapter,
        *,
        upstream_signatures: list[str],
        tool_evidence: dict[str, Any],
        provider_evidence: dict[str, Any] | None,
        cached_external_inputs: bool = True,
    ) -> tuple[str, dict[str, Any]]:
        del provider_evidence, cached_external_inputs
        calls.append((step_key, subject_id, upstream_signatures, tool_evidence))
        return f"sig-{step_key}-{subject_id}", {"externalInputs": {}}

    monkeypatch.setattr(runtime, "expected_signature", expected_signature)
    try:
        signature, _payload = manager._expected(ctx, "recon", "sub-01")
        assert signature == "sig-recon-sub-01"
        assert calls[-1][2] == ["sig-deface-sub-01"]

        ctx.cfg["steps"]["deface"]["enabled"] = False
        calls.clear()
        manager._expected(ctx, "enigma", None)
        assert calls[-1][2] == ["sig-recon-sub-01", "sig-recon-sub-02"]

        calls.clear()
        manager._expected(ctx, "age", None)
        assert calls[-1][2] == ["sig-features-None"]
        assert calls[-1][3] == {"tool": {"status": "ok"}}
    finally:
        manager.shutdown()


def test_producer_ready_distinguishes_missing_and_stale_receipts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx = _context(tmp_path)
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(manager, "_expected", lambda *_args: ("signature", {}))
    monkeypatch.setattr(ctx.store, "get_receipt", lambda *_args: None)
    monkeypatch.setattr(
        runtime,
        "detector_evidence",
        lambda *_args: {"state": "done", "identity": "detector"},
    )
    monkeypatch.setattr(
        runtime, "enrich_evidence", lambda _key, evidence, *_args: evidence
    )
    monkeypatch.setattr(
        runtime, "edge_evidence", lambda *_args: {"state": "done", "identity": "edge"}
    )
    monkeypatch.setattr(
        runtime, "evidence_is_done", lambda value: value.get("state") == "done"
    )
    monkeypatch.setattr(
        runtime, "evidence_identity", lambda value: value.get("identity")
    )
    monkeypatch.setattr(
        runtime,
        "make_receipt",
        lambda *_args, **_kwargs: {
            "signature": "signature",
            "stepKey": "recon",
            "subjectId": "sub-01",
        },
    )
    monkeypatch.setattr(manager, "_edge_evidence_for_receipt", lambda *_args: {})
    try:
        ready, reason = manager._producer_ready(ctx, "recon", "enigma", "sub-01")
        assert ready is False
        assert "no matching current provenance receipt" in reason

        ctx.state["receipts"] = [
            {
                "stepKey": "recon",
                "subjectId": "sub-01",
                "signature": "signature",
                "detectorEvidence": {"state": "done", "identity": "old"},
                "edgeEvidence": {"enigma": {"state": "done", "identity": "old-edge"}},
            }
        ]
        monkeypatch.setattr(runtime, "receipt_signature_valid", lambda *_args: True)
        ready, reason = manager._producer_ready(ctx, "recon", "enigma", "sub-01")
        assert ready is False
        assert reason == "Restore current recon->enigma required artifacts."
    finally:
        manager.shutdown()


def test_edge_receipt_evidence_includes_declared_and_dynamic_consumers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = {"steps": {"deface": {"enabled": True}}}
    ctx = _context(tmp_path, cfg=cfg)
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(
        runtime,
        "edge_evidence",
        lambda producer, consumer, *_args: {"edge": f"{producer}->{consumer}"},
    )
    try:
        recon = manager._edge_evidence_for_receipt(ctx, "recon", "sub-01")
        assert set(recon) == {"enigma", "features", "aggregate"}
        deface = manager._edge_evidence_for_receipt(ctx, "deface", "sub-01")
        assert deface == {"recon": {"edge": "deface->recon"}}

        ctx.cfg["steps"]["deface"]["enabled"] = False
        assert manager._edge_evidence_for_receipt(ctx, "deface", "sub-01") == {}
    finally:
        manager.shutdown()


def test_execute_command_streams_redacted_output_and_publishes_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    proc = _Proc(stdout=("first line\n", "second line\r\n"), pid=404)
    emitter = _Emitter()
    manager = WorkflowManager(emitter, spawn=lambda _argv: proc)
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _Adapter())
    monkeypatch.setattr(manager, "announce_process_started", lambda *_args: 405)
    monkeypatch.setattr(manager, "announce_process_settled", lambda *_args: True)
    monkeypatch.setattr(runtime, "_release_spawn", lambda _proc: None)
    monkeypatch.setattr(ctx.store, "put_receipt", lambda receipt: receipt)
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._active_jobs[job["id"]] = job
            manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
            manager._runs.clear()
    finally:
        manager._active_jobs.clear()
        manager.shutdown()

    assert node["status"] == "done"
    assert job["status"] == "done"
    assert job["terminalReason"] == "completed"
    assert len(ctx.state["receipts"]) == 1
    assert job["launchInputSnapshot"]["expectedSignature"] == "launch-signature"
    assert any(method == "pipeline.stdout" for method, _params in emitter.events)
    assert Path(job["stdoutPath"]).read_text(encoding="utf-8") == (
        "first line\nsecond line\n"
    )


def test_execute_backstop_settles_job_when_settlement_raises_unexpectedly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    proc = _Proc(stdout=("finished\n",), pid=404)
    manager = WorkflowManager(_Emitter(), spawn=lambda _argv: proc)
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _Adapter())
    monkeypatch.setattr(manager, "announce_process_started", lambda *_args: 405)
    monkeypatch.setattr(manager, "announce_process_settled", lambda *_args: True)
    monkeypatch.setattr(runtime, "_release_spawn", lambda _proc: None)

    def explode(_receipt: dict[str, Any]) -> None:
        raise OSError("Simulate an unwrapped store fault.")

    monkeypatch.setattr(ctx.store, "put_receipt", explode)
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._active_jobs[job["id"]] = job
        with pytest.raises(OSError, match="unwrapped store fault"):
            manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
        assert job["id"] not in manager._active_jobs
        assert job["status"] == "persistence-error"
        assert job["id"] in manager._persistence_errors
    finally:
        manager._active_jobs.clear()
        manager._runs.clear()
        manager.shutdown()


def test_execute_prefers_completion_when_cancel_races_clean_exit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    proc = _Proc(stdout=("finished\n",), pid=404)
    manager = WorkflowManager(_Emitter(), spawn=lambda _argv: proc)
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _Adapter())
    cancel_event = threading.Event()

    def settle_and_cancel(*_args: Any) -> bool:
        # Land the cancellation inside the window between process settlement
        # and the terminal transition.
        cancel_event.set()
        return True

    monkeypatch.setattr(manager, "announce_process_started", lambda *_args: 405)
    monkeypatch.setattr(manager, "announce_process_settled", settle_and_cancel)
    monkeypatch.setattr(runtime, "_release_spawn", lambda _proc: None)
    published: list[dict[str, Any]] = []
    monkeypatch.setattr(ctx.store, "put_receipt", published.append)
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._active_jobs[job["id"]] = job
            manager._execute(ctx, node["nodeId"], job["id"], cancel_event)
            manager._runs.clear()
    finally:
        manager._active_jobs.clear()
        manager.shutdown()

    assert node["status"] == "done"
    assert job["status"] == "done"
    assert job["terminalReason"] == "completed"
    assert job["exitCode"] == 0
    assert len(ctx.state["receipts"]) == 1
    assert len(published) == 1


def test_execute_holds_adapter_lease_from_prepare_through_settlement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    events: list[str] = []
    proc = _Proc(pid=405)
    manager = WorkflowManager(
        _Emitter(),
        spawn=lambda _argv: events.append("spawn") or proc,
    )
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _LeasedPreparingAdapter(events))
    monkeypatch.setattr(manager, "announce_process_started", lambda *_args: 406)
    monkeypatch.setattr(manager, "announce_process_settled", lambda *_args: True)
    monkeypatch.setattr(runtime, "_release_spawn", lambda _proc: None)
    monkeypatch.setattr(ctx.store, "put_receipt", lambda receipt: receipt)
    try:
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
    finally:
        manager.shutdown()

    assert events == ["lease-enter", "prepare", "spawn", "lease-exit"]


def test_execute_does_not_exit_a_lease_whose_enter_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    events: list[str] = []
    adapter = _PreparingAdapter(events)

    class FailingLease(_Lease):
        def __enter__(self) -> None:
            self.events.append("lease-enter")
            raise RuntimeError("refuse the stale provision generation")

    adapter.execution_lease = lambda _cfg, _subject_id: FailingLease(events)  # type: ignore[attr-defined]
    manager = WorkflowManager(
        _Emitter(), spawn=lambda _argv: events.append("spawn") or _Proc()
    )
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(runtime.ADAPTERS, "recon", adapter)
    try:
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
    finally:
        manager.shutdown()

    assert events == ["lease-enter"]
    assert node["status"] == "failed"
    assert node["reason"] == (
        "An unexpected error (RuntimeError) ended the job. "
        "refuse the stale provision generation"
    )
    assert "refuse the stale provision generation" in Path(job["stdoutPath"]).read_text(
        encoding="utf-8"
    )


def test_execute_refuses_action_drift_before_prepare_or_spawn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    events: list[str] = []
    adapter = _PreparingAdapter(events)
    manager = WorkflowManager(
        _Emitter(),
        spawn=lambda _argv: events.append("spawn") or _Proc(pid=405),
    )
    monkeypatch.setitem(runtime.ADAPTERS, "recon", adapter)
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setattr(
        manager,
        "_expected",
        lambda *_args, **_kwargs: (
            "launch-signature",
            {
                "executionActionDigest": runtime.execution_action_digest(
                    ExecutionAction(kind="command", argv=("changed",))
                ),
                "externalInputs": {},
            },
        ),
    )
    try:
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
    finally:
        manager.shutdown()

    assert events == []
    assert node["status"] == "failed"
    assert node["reason"] == (
        "The bound action changed before launch, so execution was refused."
    )


@pytest.mark.parametrize(
    "case",
    [
        ("nonzero_exit", 1, None, True, True),
        ("oom_killed", 137, None, True, True),
        ("license_error", 1, None, True, True),
        (
            "topology_failure",
            127,
            "An unexpected error (RuntimeError) ended the job.",
            True,
            True,
        ),
        ("topology_failure", 1, None, False, True),
        ("topology_failure", 1, None, True, False),
    ],
)
def test_auto_fallback_rejects_unclassified_or_unproved_failures(
    tmp_path: Path,
    case: tuple[str, int, str | None, bool, bool],
) -> None:
    tag, rc, reason, process_started, settled = case
    node = _node(status="failed")
    job = _job(tmp_path, node, status="running")
    job["backend"] = "freesurfer"
    ctx = _auto_fallback_context(
        tmp_path,
        nodes=[node],
        jobs=[job],
        cohort=_cohort("sub-01"),
    )
    manager = WorkflowManager(_Emitter())
    try:
        allowed = manager._eligible_auto_fallback(
            ctx,
            node,
            job,
            Failure(code=rc, tag=tag, message="Report the classified failure."),
            rc=rc,
            cancelled=False,
            reason=reason,
            process_started=process_started,
            settlement_proved=settled,
        )
    finally:
        manager.shutdown()

    assert allowed is False
    assert "reconstructionFallback" not in ctx.state


@pytest.mark.parametrize(
    "tag",
    ["topology_failure", "inflation_failure", "white_surface_failure"],
)
def test_auto_fallback_accepts_only_current_pre_authorized_algorithm_branch(
    tmp_path: Path, tag: str
) -> None:
    node = _node(status="failed")
    job = _job(tmp_path, node, status="running")
    job["backend"] = "freesurfer"
    ctx = _auto_fallback_context(
        tmp_path,
        nodes=[node],
        jobs=[job],
        cohort=_cohort("sub-01"),
    )
    manager = WorkflowManager(_Emitter())
    failure = Failure(
        code=1,
        tag=tag,
        message="Report a classified algorithm failure.",
    )
    try:
        assert manager._eligible_auto_fallback(
            ctx,
            node,
            job,
            failure,
            rc=1,
            cancelled=False,
            reason=None,
            process_started=True,
            settlement_proved=True,
        )

        Path(ctx.effective_cfg["_supraspinaRuntime"]["fastSurferSifPath"]).write_bytes(
            b"tampered"
        )
        assert not manager._eligible_auto_fallback(
            ctx,
            node,
            job,
            failure,
            rc=1,
            cancelled=False,
            reason=None,
            process_started=True,
            settlement_proved=True,
        )
    finally:
        manager.shutdown()


@pytest.mark.parametrize(
    "invalid_binding",
    [
        "runtime",
        "authorized_backends",
        "primary_backend",
        "device",
        "sif_path",
        "resource_evidence",
        "resource_identity",
    ],
)
def test_auto_fallback_rejects_each_invalid_authorization_binding(
    tmp_path: Path,
    invalid_binding: str,
) -> None:
    node = _node(status="failed")
    job = _job(tmp_path, node, status="failed")
    job["backend"] = "freesurfer"
    ctx = _auto_fallback_context(
        tmp_path,
        nodes=[node],
        jobs=[job],
        cohort=_cohort("sub-01"),
    )
    runtime_cfg = ctx.effective_cfg["_supraspinaRuntime"]
    if invalid_binding == "runtime":
        ctx.effective_cfg["_supraspinaRuntime"] = []
    elif invalid_binding == "authorized_backends":
        runtime_cfg["authorizedReconBackends"] = ["freesurfer"]
    elif invalid_binding == "primary_backend":
        runtime_cfg["resolvedReconBackend"] = "fastsurfer"
    elif invalid_binding == "device":
        runtime_cfg["resolvedFastSurferDevice"] = "mps"
    elif invalid_binding == "sif_path":
        runtime_cfg["fastSurferSifPath"] = ""
    elif invalid_binding == "resource_evidence":
        ctx.state["scientificEvidence"] = []
    else:
        ctx.state["scientificEvidence"]["managedResources"]["fastsurfer"][
            "sifBytes"
        ] = True

    assert WorkflowManager._verified_fastsurfer_fallback_is_current(ctx) is False


@pytest.mark.parametrize(
    ("failure_tag", "include_trigger", "message"),
    [
        ("license_error", True, "eligible failure"),
        ("topology_failure", False, "at least one Reconstruction subject"),
    ],
)
def test_auto_fallback_rejects_invalid_activation_requests(
    tmp_path: Path,
    failure_tag: str,
    include_trigger: bool,
    message: str,
) -> None:
    trigger = _node(status="failed")
    trigger_job = _job(tmp_path, trigger, job_id="#trigger", status="failed")
    trigger_job["backend"] = "freesurfer"
    ctx = _auto_fallback_context(
        tmp_path,
        nodes=[trigger] if include_trigger else [],
        jobs=[trigger_job],
        cohort=_cohort("sub-01"),
    )
    manager = WorkflowManager(_Emitter())
    try:
        with pytest.raises(ValueError, match=message):
            manager._begin_auto_fallback(
                ctx,
                trigger,
                trigger_job,
                Failure(
                    code=1,
                    tag=failure_tag,
                    message="Report a classified failure.",
                ),
            )
    finally:
        manager.shutdown()


def test_auto_fallback_settles_mixed_primary_scheduler_states(
    tmp_path: Path,
) -> None:
    trigger = _node(subject_id="sub-01", status="failed")
    queued = _node(subject_id="sub-02", status="queued")
    planned = _node(subject_id="sub-03", status="planned")
    running = _node(subject_id="sub-04", status="running")
    terminal = _node(subject_id="sub-05", status="failed")
    queued_orphan = _node(subject_id="sub-06", status="queued")
    nodes = [trigger, queued, planned, running, terminal, queued_orphan]

    trigger_job = _job(tmp_path, trigger, job_id="#trigger", status="failed")
    queued_job = _job(tmp_path, queued, job_id="#queued", status="queued")
    running_job = _job(tmp_path, running, job_id="#running", status="running")
    running_job["nodeId"] = "recon:stale-running"
    terminal_job = _job(tmp_path, terminal, job_id="#terminal", status="failed")
    queued_orphan_job = _job(
        tmp_path,
        queued_orphan,
        job_id="#queued-orphan",
        status="queued",
    )
    queued_orphan_job["nodeId"] = "recon:stale-queued"
    irrelevant_job = _job(
        tmp_path,
        queued,
        job_id="#irrelevant",
        status="running",
    )
    irrelevant_job["stepKey"] = "features"
    jobs = [
        trigger_job,
        queued_job,
        running_job,
        terminal_job,
        queued_orphan_job,
        irrelevant_job,
    ]
    for job in jobs[:-1]:
        job["backend"] = "freesurfer"
    irrelevant_job["backend"] = "freesurfer"
    ctx = _auto_fallback_context(
        tmp_path,
        nodes=nodes,
        jobs=jobs,
        cohort=_cohort(*(str(node["subjectId"]) for node in nodes)),
    )
    manager = WorkflowManager(_Emitter())
    manager._active_jobs.update(
        {
            queued_job["id"]: queued_job,
            running_job["id"]: running_job,
            queued_orphan_job["id"]: queued_orphan_job,
        }
    )
    try:
        changed_jobs, processes = manager._begin_auto_fallback(
            ctx,
            trigger,
            trigger_job,
            Failure(
                code=1,
                tag="topology_failure",
                message="Report a topology failure.",
            ),
        )
    finally:
        manager._active_jobs.clear()
        manager.shutdown()

    assert [job["id"] for job in changed_jobs] == [
        "#queued",
        "#running",
        "#queued-orphan",
    ]
    assert processes == []
    assert queued_job["status"] == "cancelled"
    assert running_job["status"] == "cancelling"
    assert queued_orphan_job["status"] == "cancelled"
    assert planned["status"] == "waiting"
    assert irrelevant_job["status"] == "running"
    assert terminal_job["status"] == "failed"


def test_auto_backend_receipt_signature_tracks_the_effective_attempt(
    tmp_path: Path,
) -> None:
    node = _node(status="planned")
    ctx = _auto_fallback_context(
        tmp_path,
        nodes=[node],
        jobs=[],
        cohort=_cohort("sub-01"),
    )
    manager = WorkflowManager(_Emitter())
    try:
        freesurfer_signature, freesurfer_payload = manager._expected(
            ctx, "recon", "sub-01"
        )
        ctx.effective_cfg["_supraspinaRuntime"]["resolvedReconBackend"] = "fastsurfer"
        fastsurfer_signature, fastsurfer_payload = manager._expected(
            ctx, "recon", "sub-01"
        )
    finally:
        manager.shutdown()

    assert freesurfer_payload["reconstruction"]["backend"] == "freesurfer"
    assert fastsurfer_payload["reconstruction"]["backend"] == "fastsurfer"
    assert freesurfer_signature != fastsurfer_signature


def _start_settling_auto_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> SimpleNamespace:
    trigger = _node(subject_id="sub-01", status="failed")
    running = _node(subject_id="sub-02", status="running")
    retained = _node(subject_id="sub-03", status="skipped")
    trigger_job = _job(tmp_path, trigger, job_id="#trigger", status="running")
    running_job = _job(tmp_path, running, job_id="#running", status="running")
    for job in (trigger_job, running_job):
        job.update(
            {
                "backend": "freesurfer",
                "attemptOrdinal": 1,
                "role": "primary",
            }
        )
    trigger_job.update({"status": "failed", "endedAt": 8, "exitCode": 1})
    cohort = _cohort("sub-01", "sub-02", "sub-03")
    ctx = _auto_fallback_context(
        tmp_path,
        nodes=[trigger, running, retained],
        jobs=[trigger_job, running_job],
        cohort=cohort,
    )
    ctx.state["receipts"] = [
        {
            "stepKey": "recon",
            "subjectId": "sub-03",
            "jobId": "#older-complete",
            "signature": "superseded-signature",
        }
    ]
    proc = _Proc(pid=404, alive=True)
    ctx.processes[running_job["id"]] = proc
    manager = WorkflowManager(_Emitter())
    manager._active_jobs[running_job["id"]] = running_job
    monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _FallbackAdapter("topology_failure"))
    changed_jobs, processes = manager._begin_auto_fallback(
        ctx,
        trigger,
        trigger_job,
        Failure(
            code=1,
            tag="topology_failure",
            message="Report a topology-correction failure.",
        ),
    )
    return SimpleNamespace(
        manager=manager,
        ctx=ctx,
        trigger=trigger,
        running=running,
        retained=retained,
        trigger_job=trigger_job,
        running_job=running_job,
        proc=proc,
        changed_jobs=changed_jobs,
        processes=processes,
    )


def test_auto_fallback_waits_for_freesurfer_settlement_then_requeues_full_cohort(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture = _start_settling_auto_fallback(tmp_path, monkeypatch)
    manager = fixture.manager
    ctx = fixture.ctx
    try:
        assert fixture.processes == [fixture.proc]
        assert fixture.changed_jobs == [fixture.running_job]
        assert ctx.state["reconstructionFallback"]["state"] == "settling"
        assert ctx.state["reconstructionFallback"]["subjectIds"] == [
            "sub-01",
            "sub-02",
            "sub-03",
        ]
        assert fixture.running_job["status"] == "cancelling"
        assert ctx.cancel_events[fixture.running_job["id"]].is_set()
        assert manager._tick(ctx) is False
        assert (
            ctx.effective_cfg["_supraspinaRuntime"]["resolvedReconBackend"]
            == "freesurfer"
        )

        ctx.processes.clear()
        manager._active_jobs.pop(fixture.running_job["id"])
        fixture.running_job.update(
            {
                "status": "cancelled",
                "endedAt": 9,
                "terminalReason": "auto_fallback_superseded",
            }
        )
        fixture.running["status"] = "cancelled"

        assert manager._tick(ctx) is True
        assert (
            ctx.effective_cfg["_supraspinaRuntime"]["resolvedReconBackend"]
            == "fastsurfer"
        )
        assert ctx.state["reconstructionFallback"]["state"] == "active"
        assert ctx.state["receipts"][0]["signature"] == "superseded-signature"
        for node in (fixture.trigger, fixture.running, fixture.retained):
            assert node["status"] == "planned"
            assert node["backend"] == "fastsurfer"
            assert node["attemptOrdinal"] == 2
            assert node["role"] == "fallback"
            assert node["fallbackReasonTag"] == "freesurfer_topology_failure"
            assert node["command"].startswith("fastsurfer ")
        assert fixture.trigger["supersedesJobId"] == "#trigger"
        assert fixture.running["supersedesJobId"] == "#running"
        assert fixture.retained["supersedesJobId"] == "#older-complete"
        assert all(
            job["role"] == "superseded-primary"
            for job in (fixture.trigger_job, fixture.running_job)
        )

        assert manager._tick(ctx) is True
        fallback_job = ctx.state["jobs"][-1]
        assert fallback_job["backend"] == "fastsurfer"
        assert fallback_job["attemptOrdinal"] == 2
        assert fallback_job["role"] == "fallback"
        assert fallback_job["supersedesJobId"] == "#trigger"
        assert fallback_job["fallbackReasonTag"] == "freesurfer_topology_failure"
    finally:
        manager._active_jobs.clear()
        manager.shutdown()


def test_auto_fallback_blocks_full_cohort_for_complete_unreceipted_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture = _start_settling_auto_fallback(tmp_path, monkeypatch)
    manager = fixture.manager
    ctx = fixture.ctx
    ctx.processes.clear()
    manager._active_jobs.pop(fixture.running_job["id"])
    fixture.running_job.update(
        {
            "status": "cancelled",
            "endedAt": 9,
            "terminalReason": "auto_fallback_superseded",
        }
    )
    fixture.running["status"] = "cancelled"

    def detector(cfg: dict[str, Any], subject_id: str) -> SimpleNamespace:
        backend = cfg["_supraspinaRuntime"]["resolvedReconBackend"]
        return SimpleNamespace(
            state=(
                "done"
                if backend == "fastsurfer" and subject_id == "sub-02"
                else "pending"
            ),
            detail="Select the backend detector state.",
            artifacts=(),
        )

    monkeypatch.setattr(runtime.ADAPTERS["recon"], "detect", detector, raising=False)
    monkeypatch.setattr(manager, "_current_receipt", lambda *_args: None)
    try:
        assert manager._tick(ctx) is True
    finally:
        manager._active_jobs.clear()
        manager.shutdown()

    fallback = ctx.state["reconstructionFallback"]
    assert fallback["state"] == "blocked"
    assert fallback["conflictSubjectIds"] == ["sub-02"]
    assert all(node["status"] == "blocked" for node in ctx.state["nodes"])
    assert len(ctx.state["jobs"]) == 2
    assert ctx.state["receipts"][0]["signature"] == "superseded-signature"


def test_execute_blocks_complete_unreceipted_recon_before_prepare_or_spawn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sentinel = tmp_path / "derivatives" / "freesurfer" / "sub-01" / "sentinel"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_bytes(b"historical tree bytes\n")
    events: list[str] = []
    node = _node(status="running")
    job = _job(tmp_path, node, status="running")
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    manager = WorkflowManager(_Emitter(), spawn=lambda _argv: events.append("spawn"))
    adapter = _PreparingAdapter(events)
    monkeypatch.setattr(
        adapter,
        "detect",
        lambda _cfg, _subject_id: SimpleNamespace(
            state="done",
            detail="Complete FreeSurfer reconstruction.",
            artifacts=(str(sentinel),),
        ),
        raising=False,
    )
    monkeypatch.setitem(runtime.ADAPTERS, "recon", adapter)
    _install_execute_basics(manager, monkeypatch, evidence_state="done")
    monkeypatch.setattr(manager, "_current_receipt", lambda *_args: None)

    try:
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
    finally:
        manager.shutdown()

    assert node["status"] == "blocked"
    assert node["reason"] == (
        "Choose a fresh derivatives namespace because detector-complete "
        "Reconstruction output has no matching current receipt; preserve the "
        "existing tree."
    )
    assert job["status"] == "blocked"
    assert job["exitCode"] is None
    assert job["terminalReason"] == "reconstruction_output_conflict"
    assert events == []
    assert sentinel.read_bytes() == b"historical tree bytes\n"


def test_execute_classified_surface_failure_starts_auto_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node(status="running")
    job = _job(tmp_path, node, status="running")
    job.update(
        {
            "backend": "freesurfer",
            "attemptOrdinal": 1,
            "role": "primary",
        }
    )
    ctx = _auto_fallback_context(
        tmp_path,
        nodes=[node],
        jobs=[job],
        cohort=_cohort("sub-01"),
    )
    proc = _Proc(
        rc=1,
        stdout=("mris_make_surfaces: white surface failed\n",),
        pid=404,
    )
    manager = WorkflowManager(_Emitter(), spawn=lambda _argv: proc)
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(
        runtime.ADAPTERS, "recon", _FallbackAdapter("white_surface_failure")
    )
    monkeypatch.setattr(manager, "announce_process_started", lambda *_args: 405)
    monkeypatch.setattr(manager, "announce_process_settled", lambda *_args: True)
    monkeypatch.setattr(runtime, "_release_spawn", lambda _proc: None)
    monkeypatch.setattr(manager, "_direct_scientific_input_snapshot", lambda *_args: [])
    monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
    manager._active_jobs[job["id"]] = job
    try:
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())

        assert node["status"] == "failed"
        assert job["status"] == "failed"
        assert job["role"] == "superseded-primary"
        assert job["fallbackReasonTag"] == "freesurfer_white_surface_failure"
        assert ctx.state["reconstructionFallback"]["state"] == "settling"

        assert manager._tick(ctx) is True
        assert node["status"] == "planned"
        assert node["backend"] == "fastsurfer"
    finally:
        manager._active_jobs.clear()
        manager.shutdown()


def test_execute_copy_file_exists_and_missing_output_fail_honestly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.txt"
    destination = tmp_path / "destination.txt"
    source.write_text("new", encoding="utf-8")
    destination.write_text("existing", encoding="utf-8")
    action = ExecutionAction(
        kind="copy",
        source=str(source),
        destination=str(destination),
        force=False,
    )
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    manager = WorkflowManager(_Emitter())
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _Adapter(action))
    try:
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
    finally:
        manager.shutdown()
    assert node["status"] == "failed"
    assert node["reason"] == (
        "The copy-through destination already exists. Enable forceOverwrite or "
        "choose a new output."
    )
    assert destination.read_text(encoding="utf-8") == "existing"

    missing_node = _node(status="running")
    missing_job = _job(tmp_path, missing_node, job_id="#missing-output")
    missing_ctx = _context(tmp_path, nodes=[missing_node], jobs=[missing_job])
    manager = WorkflowManager(_Emitter())
    _install_execute_basics(manager, monkeypatch, evidence_state="pending")
    monkeypatch.setitem(
        runtime.ADAPTERS,
        "recon",
        _Adapter(
            ExecutionAction(
                kind="copy",
                source=str(source),
                destination=str(tmp_path / "copied.txt"),
                force=False,
            )
        ),
    )
    try:
        manager._execute(
            missing_ctx,
            missing_node["nodeId"],
            missing_job["id"],
            threading.Event(),
        )
    finally:
        manager.shutdown()
    assert missing_node["status"] == "failed"
    assert missing_node["reason"].startswith(
        "The process exited successfully but did not produce the expected output. "
    )


def test_execute_persists_bounded_path_free_detector_failure_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.txt"
    source.write_text("content", encoding="utf-8")
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    manager = WorkflowManager(_Emitter())
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(
        runtime.ADAPTERS,
        "recon",
        _Adapter(
            ExecutionAction(
                kind="copy",
                source=str(source),
                destination=str(tmp_path / "copy.txt"),
                force=False,
            )
        ),
    )
    monkeypatch.setattr(
        runtime,
        "detector_evidence",
        lambda *_args: {
            "state": "unknown",
            "detail": "Run the detector again after RuntimeError.",
            "artifacts": [{"path": str(tmp_path / "private-output.nii.gz")}],
        },
    )
    try:
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
    finally:
        manager.shutdown()

    public_evidence = {
        "state": "unknown",
        "detail": "Run the detector again after RuntimeError.",
    }
    assert node["status"] == "failed"
    assert node["reason"].endswith("Run the detector again after RuntimeError.")
    assert node["detectorEvidence"] == public_evidence
    assert job["detectorEvidence"] == public_evidence

    persisted = ctx.store.load(ctx.state["runId"])
    persisted_node = persisted["nodes"][0]
    persisted_job = persisted["jobs"][0]
    assert persisted_node["detectorEvidence"] == public_evidence
    assert persisted_job["detectorEvidence"] == public_evidence
    assert str(tmp_path) not in str(persisted_node["detectorEvidence"])
    assert str(tmp_path) not in str(persisted_job["detectorEvidence"])


def test_execute_refuses_receipt_when_post_launch_probe_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.txt"
    source.write_text("content", encoding="utf-8")
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    manager = WorkflowManager(_Emitter())
    action = ExecutionAction(
        kind="copy",
        source=str(source),
        destination=str(tmp_path / "copy.txt"),
        force=False,
    )
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _Adapter(action))
    expected_calls = 0

    def expected(*_args: Any) -> tuple[str, dict[str, Any]]:
        nonlocal expected_calls
        expected_calls += 1
        if expected_calls == 2:
            raise ValueError("Change the source during validation.")
        return (
            "launch-signature",
            {
                "executionActionDigest": runtime.execution_action_digest(action),
                "externalInputs": {},
            },
        )

    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setattr(manager, "_expected", expected)
    try:
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
    finally:
        manager.shutdown()

    assert node["status"] == "failed"
    assert node["reason"] == "Scientific inputs changed during execution."
    assert ctx.state["receipts"] == []


@pytest.mark.parametrize(
    ("step_key", "deface_enabled"),
    [("deface", True), ("recon", False)],
)
@pytest.mark.parametrize("drift_phase", ["pre-exec", "post-exit"])
def test_execute_rejects_same_size_same_mtime_t1_drift_without_releasing_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    step_key: str,
    deface_enabled: bool,
    drift_phase: str,
) -> None:
    t1_path = tmp_path / "sub-01_T1w.nii.gz"
    t1_path.write_bytes(b"AAAA1111")
    original = os.stat(t1_path)
    cohort = _cohort_with_t1(t1_path)

    def mutate_t1() -> None:
        t1_path.write_bytes(b"BBBB2222")
        os.utime(
            t1_path,
            ns=(original.st_atime_ns, original.st_mtime_ns),
        )
        observed = os.stat(t1_path)
        assert observed.st_size == original.st_size
        assert observed.st_mtime_ns == original.st_mtime_ns

    if drift_phase == "pre-exec":
        mutate_t1()
    proc = _GatedProc(mutate_t1 if drift_phase == "post-exit" else None)
    cfg = {
        "steps": {"deface": {"enabled": deface_enabled}},
        "_supraspinaRuntime": {
            "t1BySubject": {"sub-01": str(t1_path)},
            "reconInputBySubject": {"sub-01": str(t1_path)},
        },
    }
    current = _node(step_key)
    dependent = _node(
        "features",
        subject_id=None,
        status="waiting",
        dependencies=[current["nodeId"]],
    )
    job = _job(tmp_path, current)
    ctx = _context(
        tmp_path,
        nodes=[current, dependent],
        jobs=[job],
        cohort=cohort,
        cfg=cfg,
    )
    manager = WorkflowManager(_Emitter(), spawn=lambda _argv: proc)
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(runtime.ADAPTERS, step_key, _Adapter())
    monkeypatch.setattr(manager, "announce_process_started", lambda *_args: None)
    try:
        manager._execute(
            ctx,
            current["nodeId"],
            job["id"],
            threading.Event(),
        )
        assert manager._tick(ctx) is True
    finally:
        manager.shutdown()

    expected_reason = (
        "Scientific input changed after planning."
        if drift_phase == "pre-exec"
        else "Scientific input changed during execution."
    )
    assert current["status"] == "failed"
    assert current["reason"] == expected_reason
    assert dependent["status"] == "blocked"
    assert ctx.state["receipts"] == []
    assert job["inputChangeEvidence"][0]["phase"] == drift_phase
    assert "path" not in job["inputChangeEvidence"][0]
    if drift_phase == "pre-exec":
        assert proc.gate.writes == []
    else:
        assert proc.gate.writes == ["1"]
    assert proc.gate.closed is True


def test_direct_scientific_input_snapshot_accepts_unchanged_full_sha256(
    tmp_path: Path,
) -> None:
    t1_path = tmp_path / "sub-01_T1w.nii.gz"
    t1_path.write_bytes(b"stable scientific input")
    cohort = _cohort_with_t1(t1_path)
    cfg = {
        "steps": {"deface": {"enabled": False}},
        "_supraspinaRuntime": {
            "t1BySubject": {"sub-01": str(t1_path)},
            "reconInputBySubject": {"sub-01": str(t1_path)},
        },
    }
    ctx = _context(tmp_path, cohort=cohort, cfg=cfg)
    manager = WorkflowManager(_Emitter())
    try:
        records = manager._direct_scientific_input_snapshot(ctx, "recon", "sub-01")
        manager._verify_direct_scientific_inputs(records)
    finally:
        manager.shutdown()

    assert records[0]["plannedSha256"] == records[0]["launchSha256"]
    assert "path" not in manager._public_direct_inputs(records)[0]


def test_execute_extends_the_launch_snapshot_under_the_manager_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Insert the direct-input evidence while a concurrent commit cannot copy it.

    The launch snapshot is already published on the job, so extending it from
    the job thread can abort a concurrent ``copy.deepcopy`` of the run state
    with a RuntimeError that the persistence-failure handling never sees.
    """
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    manager = WorkflowManager(_Emitter(), spawn=lambda _argv: _Proc(pid=404))
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _Adapter())
    monkeypatch.setattr(manager, "announce_process_started", lambda *_args: 405)
    monkeypatch.setattr(manager, "announce_process_settled", lambda *_args: True)
    monkeypatch.setattr(runtime, "_release_spawn", lambda _proc: None)
    monkeypatch.setattr(ctx.store, "put_receipt", lambda receipt: receipt)
    monkeypatch.setattr(
        manager,
        "_direct_scientific_input_snapshot",
        lambda *_args: [{"role": "t1", "path": str(tmp_path / "t1.nii.gz")}],
    )
    monkeypatch.setattr(
        manager, "_verify_direct_scientific_inputs", lambda *_args: None
    )
    published_under_lock: list[bool] = []

    def public_direct_inputs(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        published_under_lock.append(manager._lock._is_owned())
        return [{"role": record["role"]} for record in records]

    monkeypatch.setattr(manager, "_public_direct_inputs", public_direct_inputs)
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._active_jobs[job["id"]] = job
        # Execute outside the manager lock, exactly as an execution thread does.
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
    finally:
        manager._active_jobs.clear()
        manager._runs.clear()
        manager.shutdown()

    # The launch-snapshot extension is the first use of this projection; the
    # later receipt build only reads the records into a new list.
    assert published_under_lock[0] is True
    assert job["launchInputSnapshot"]["directScientificInputs"] == [{"role": "t1"}]


def test_execute_preexisting_persistence_failure_interrupts_terminal_projection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    manager = WorkflowManager(_Emitter(), spawn=lambda _argv: _Proc())
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _Adapter())
    monkeypatch.setattr(manager, "announce_process_started", lambda *_args: None)
    monkeypatch.setattr(manager, "announce_process_settled", lambda *_args: True)
    monkeypatch.setattr(runtime, "_release_spawn", lambda _proc: None)

    def commit(_ctx: _RunContext) -> None:
        ctx.persistence_failed = True
        raise PersistenceError("Fail the simulated disk write.")

    monkeypatch.setattr(manager, "_commit", commit)
    manager._active_jobs[job["id"]] = job
    try:
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
    finally:
        manager._active_jobs.clear()
        manager.shutdown()

    assert node["status"] == "interrupted"
    assert job["status"] == "persistence-error"
    assert job["id"] in manager._persistence_errors


def test_execute_terminal_retry_recovers_from_transient_persistence_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    ctx.persistence_failed = True
    manager = WorkflowManager(_Emitter(), spawn=lambda _argv: _Proc())
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _Adapter())
    monkeypatch.setattr(manager, "announce_process_started", lambda *_args: None)
    monkeypatch.setattr(manager, "announce_process_settled", lambda *_args: True)
    monkeypatch.setattr(runtime, "_release_spawn", lambda _proc: None)
    monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
    monkeypatch.setattr(ctx.store, "put_receipt", lambda receipt: receipt)
    manager._active_jobs[job["id"]] = job
    try:
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
    finally:
        manager._active_jobs.clear()
        manager.shutdown()

    assert ctx.persistence_failed is False
    assert node["status"] == "done"
    assert job["status"] == "done"
    assert job["terminalReason"] == "completed"
    assert len(ctx.state["receipts"]) == 1


def test_execute_terminal_commit_failure_stops_and_classifies_all_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current = _node()
    running = _node("deface", status="running")
    planned = _node("age", subject_id=None, status="planned")
    complete = _node("features", subject_id=None, status="done")
    current_job = _job(tmp_path, current)
    running_job = _job(tmp_path, running, job_id="#running-other")
    queued_job = _job(tmp_path, planned, job_id="#queued-other", status="queued")
    done_job = _job(tmp_path, complete, job_id="#done-other", status="done")
    ctx = _context(
        tmp_path,
        nodes=[current, running, planned, complete],
        jobs=[current_job, running_job, queued_job, done_job],
    )
    other_proc = object()
    ctx.processes[running_job["id"]] = other_proc
    manager = WorkflowManager(_Emitter(), spawn=lambda _argv: _Proc(rc=4))
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(
        runtime.ADAPTERS, "recon", _Adapter(failure="scientific failure")
    )
    monkeypatch.setattr(manager, "announce_process_started", lambda *_args: None)
    monkeypatch.setattr(manager, "announce_process_settled", lambda *_args: True)
    monkeypatch.setattr(runtime, "_release_spawn", lambda _proc: None)
    terminated: list[object] = []
    monkeypatch.setattr(
        runtime, "_terminate_tree", lambda proc, **_kwargs: terminated.append(proc)
    )
    commit_calls = 0

    def commit(_ctx: _RunContext) -> None:
        nonlocal commit_calls
        commit_calls += 1
        if commit_calls == 2:
            raise PersistenceError("Fail the terminal write.")

    monkeypatch.setattr(manager, "_commit", commit)
    for value in (current_job, running_job, queued_job):
        manager._active_jobs[value["id"]] = value
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._execute(
                ctx,
                current["nodeId"],
                current_job["id"],
                threading.Event(),
            )
            manager._runs.clear()
    finally:
        ctx.processes.clear()
        manager._active_jobs.clear()
        manager.shutdown()

    assert current_job["status"] == "persistence-error"
    assert running["status"] == "interrupted"
    assert planned["status"] == "withheld"
    assert complete["status"] == "done"
    assert running_job["status"] == "running"
    assert ctx.cancel_events[running_job["id"]].is_set()
    assert queued_job["status"] == "persistence-error"
    assert done_job["status"] == "done"
    assert terminated == [other_proc]
    assert ctx.state["status"] == "persistence-error"


def test_execute_receipt_publication_failure_retains_committed_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.txt"
    source.write_text("content", encoding="utf-8")
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    manager = WorkflowManager(_Emitter())
    action = ExecutionAction(
        kind="copy",
        source=str(source),
        destination=str(tmp_path / "copy.txt"),
        force=True,
    )
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _Adapter(action))
    monkeypatch.setattr(
        ctx.store,
        "put_receipt",
        lambda _receipt: (_ for _ in ()).throw(
            PersistenceError("Fill the receipt index.")
        ),
    )
    try:
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
    finally:
        manager.shutdown()

    assert node["status"] == "done"
    assert len(ctx.state["receipts"]) == 1
    assert ctx.state["warnings"][0] == (
        "The global receipt could not be published; the run generation keeps it."
    )
    assert (tmp_path / "copy.txt").read_text(encoding="utf-8") == "content"


def test_execute_force_terminates_live_leader_and_tolerates_wait_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    proc = _Proc(
        rc=1,
        alive=True,
        wait_error=OSError("Treat waiting as unavailable."),
    )
    manager = WorkflowManager(_Emitter(), spawn=lambda _argv: proc)
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _Adapter())
    monkeypatch.setattr(manager, "announce_process_started", lambda *_args: 99)
    monkeypatch.setattr(manager, "announce_process_settled", lambda *_args: True)
    monkeypatch.setattr(runtime, "_release_spawn", lambda _proc: None)
    forced: list[tuple[object, bool]] = []
    monkeypatch.setattr(
        runtime,
        "_terminate_tree",
        lambda owned, *, force=False: forced.append((owned, force)),
    )
    try:
        manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
    finally:
        manager.shutdown()
    assert forced == [(proc, True)]
    assert node["status"] == "failed"


def test_retain_unproved_process_marks_persistence_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(
        manager,
        "_commit",
        lambda _ctx: (_ for _ in ()).throw(
            PersistenceError("Fail the simulated disk write.")
        ),
    )
    try:
        manager._retain_unproved_process(ctx, node, job, _Proc(pid=500), 501, 0)
    finally:
        manager._active_jobs.clear()
        manager.shutdown()
    assert ctx.persistence_failed is True
    assert ctx.state["durable"] is False
    assert job["persistenceStatus"] == "error"
    assert manager._persistence_errors[job["id"]]["status"] == "unknown"


def test_cancel_job_ignores_unknown_job_and_orphaned_context(tmp_path: Path) -> None:
    manager = WorkflowManager(_Emitter())
    try:
        manager.cancel_job("#absent")
        node = _node(status="queued")
        job = _job(tmp_path, node, status="queued")
        manager._active_jobs[job["id"]] = job
        manager.cancel_job(job["id"])
        assert job["status"] == "queued"
    finally:
        manager._active_jobs.clear()
        manager.shutdown()


@pytest.mark.parametrize("commit_fails", [False, True])
def test_cancel_job_terminalizes_queued_work_or_exposes_persistence_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    commit_fails: bool,
) -> None:
    node = _node(status="queued")
    job = _job(tmp_path, node, status="queued")
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(manager, "_emit_job", lambda *_args: None)
    if commit_fails:
        monkeypatch.setattr(
            manager,
            "_commit",
            lambda _ctx: (_ for _ in ()).throw(
                PersistenceError("Fail the simulated disk write.")
            ),
        )
    else:
        monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._active_jobs[job["id"]] = job
            manager.cancel_job(job["id"])
            manager._runs.clear()
    finally:
        manager._active_jobs.clear()
        manager.shutdown()

    assert ctx.cancel_events[job["id"]].is_set()
    if commit_fails:
        assert job["status"] == "persistence-error"
        assert node["status"] == "interrupted"
        assert job["id"] in manager._persistence_errors
    else:
        assert job["status"] == "cancelled"
        assert node["status"] == "cancelled"
        assert job["id"] in manager._terminal_jobs


@pytest.mark.parametrize(
    ("status", "commit_fails"),
    [("unknown", False), ("unknown", True), ("running", False), ("running", True)],
)
def test_cancel_job_requests_live_or_unknown_process_settlement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    status: str,
    commit_fails: bool,
) -> None:
    node = _node(status=status)
    job = _job(tmp_path, node, status=status)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    proc = object()
    ctx.processes[job["id"]] = proc
    manager = WorkflowManager(_Emitter())
    if commit_fails:
        monkeypatch.setattr(
            manager,
            "_commit",
            lambda _ctx: (_ for _ in ()).throw(
                PersistenceError("Fail the simulated disk write.")
            ),
        )
    else:
        monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
    terminated: list[object] = []
    escalated: list[object] = []
    monkeypatch.setattr(runtime, "_terminate_tree", terminated.append)
    monkeypatch.setattr(runtime, "_schedule_force_termination", escalated.append)
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._active_jobs[job["id"]] = job
            manager.cancel_job(job["id"])
            manager._runs.clear()
    finally:
        ctx.processes.clear()
        manager._active_jobs.clear()
        manager.shutdown()

    assert terminated == [proc]
    assert escalated == [proc]
    assert job["terminalReason"] in {
        "operator_cancellation_requested",
        "persistence_error",
    }
    if status == "unknown" and commit_fails:
        assert job["persistenceStatus"] == "error"
    elif status == "running" and commit_fails:
        assert job["status"] == "persistence-error"
        assert node["status"] == "interrupted"
    elif status == "running":
        assert job["status"] == "cancelling"
    else:
        assert job["status"] == "unknown"


def test_finish_run_handles_active_nonterminal_dry_and_persistence_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = WorkflowManager(_Emitter())
    try:
        terminal = _node(status="done")
        ctx = _context(tmp_path, nodes=[terminal])
        ctx.processes["#live"] = object()
        assert manager._finish_run_if_terminal(ctx) is False
        ctx.processes.clear()

        active_job = _job(tmp_path, terminal, status="running")
        manager._active_jobs[active_job["id"]] = active_job
        assert manager._finish_run_if_terminal(ctx) is False
        manager._active_jobs.clear()

        terminal["status"] = "planned"
        assert manager._finish_run_if_terminal(ctx) is False
        terminal["status"] = "done"
        ctx.state["dryRun"] = True
        manager._runs[ctx.state["runId"]] = ctx
        monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
        assert manager._finish_run_if_terminal(ctx) is True
        assert ctx.state["status"] == "planned"
        assert ctx.state["runId"] not in manager._runs

        ctx.state["dryRun"] = False
        manager._runs[ctx.state["runId"]] = ctx
        monkeypatch.setattr(
            manager,
            "_commit",
            lambda _ctx: (_ for _ in ()).throw(
                PersistenceError("Fail the simulated disk write.")
            ),
        )
        assert manager._finish_run_if_terminal(ctx) is True
        assert ctx.state["status"] == "persistence-error"
        assert ctx.state["durable"] is False
    finally:
        manager._active_jobs.clear()
        manager._runs.clear()
        manager.shutdown()


@pytest.mark.parametrize(("unknown", "commit_fails"), [(False, False), (True, True)])
def test_scheduler_failure_interrupts_work_and_preserves_unknown_ownership(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    unknown: bool,
    commit_fails: bool,
) -> None:
    first = _node(status="unknown" if unknown else "running")
    second = _node("deface", status="planned")
    ctx = _context(tmp_path, nodes=[first, second])
    proc = object()
    if unknown:
        ctx.processes["#live"] = proc
    manager = WorkflowManager(_Emitter())
    terminated: list[object] = []
    escalated: list[object] = []
    monkeypatch.setattr(runtime, "_terminate_tree", terminated.append)
    monkeypatch.setattr(runtime, "_schedule_force_termination", escalated.append)
    if commit_fails:
        monkeypatch.setattr(
            manager,
            "_commit",
            lambda _ctx: (_ for _ in ()).throw(
                PersistenceError("Fail the simulated disk write.")
            ),
        )
    else:
        monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._mark_scheduler_failure(ctx)
            manager._runs.clear()
    finally:
        ctx.processes.clear()
        manager.shutdown()

    assert second["status"] == "interrupted"
    if unknown:
        assert first["status"] == "unknown"
        assert terminated == [proc]
        assert escalated == [proc]
        assert ctx.cancel_events["#live"].is_set()
        assert ctx.state["status"] == "persistence-error"
    else:
        assert first["status"] == "interrupted"
        assert ctx.state["status"] == "interrupted"


@pytest.mark.parametrize("commit_fails", [False, True])
def test_scheduler_failure_settles_threadless_active_jobs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, commit_fails: bool
) -> None:
    node = _node(status="queued")
    job = _job(tmp_path, node, job_id="#queued-job", status="queued")
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    manager = WorkflowManager(_Emitter())
    manager._active_jobs[job["id"]] = job
    if commit_fails:
        monkeypatch.setattr(
            manager,
            "_commit",
            lambda _ctx: (_ for _ in ()).throw(
                PersistenceError("Fail the simulated disk write.")
            ),
        )
    else:
        monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._mark_scheduler_failure(ctx)
        assert job["status"] == "interrupted"
        assert job["endedAt"] is not None
        assert job["terminalReason"] == "scheduler_failure"
        assert manager.active_counts() == (0, 0)
        if commit_fails:
            assert job["persistenceStatus"] == "error"
            assert job["durable"] is False
            assert job["id"] in manager._persistence_errors
        else:
            assert job["id"] in manager._terminal_jobs
    finally:
        manager._active_jobs.clear()
        manager._runs.clear()
        manager.shutdown()


def test_scheduler_failure_leaves_threaded_and_terminal_jobs_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    threaded_node = _node(status="running")
    finished_node = _node("deface", status="done")
    threaded = _job(tmp_path, threaded_node, job_id="#threaded", status="running")
    finished = _job(tmp_path, finished_node, job_id="#finished", status="done")
    ctx = _context(
        tmp_path,
        nodes=[threaded_node, finished_node],
        jobs=[threaded, finished],
    )
    ctx.cancel_events[threaded["id"]] = threading.Event()
    ctx.execution_threads.add(threaded["id"])
    manager = WorkflowManager(_Emitter())
    manager._active_jobs[threaded["id"]] = threaded
    manager._active_jobs[finished["id"]] = finished
    monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._mark_scheduler_failure(ctx)
        # The execution thread owns the threaded job's terminal bookkeeping,
        # and a job already terminal needs none.
        assert threaded["status"] == "running"
        assert finished["status"] == "done"
        assert set(manager._active_jobs) == {threaded["id"], finished["id"]}
    finally:
        manager._active_jobs.clear()
        manager._runs.clear()
        manager.shutdown()


class _CommitFailingStore:
    """Delegate to a real run store while failing one chosen commit call."""

    def __init__(
        self, store: RunStore, *, fail_at: int, keep_failing: bool = False
    ) -> None:
        self.store = store
        self.fail_at = fail_at
        self.keep_failing = keep_failing
        self.commits = 0

    def __getattr__(self, name: str) -> Any:
        return getattr(self.store, name)

    def commit(self, state: dict[str, Any]) -> int:
        self.commits += 1
        if self.commits == self.fail_at or (
            self.keep_failing and self.commits > self.fail_at
        ):
            raise PersistenceError("Fail the simulated transition commit.")
        return self.store.commit(state)


def _settle_through_the_scheduler(
    manager: WorkflowManager, ctx: _RunContext, timeout: float = 10.0
) -> bool:
    """Let the real scheduler loop drive one run until it leaves the registry."""
    with manager._wake:
        manager._runs[ctx.state["runId"]] = ctx
        manager._wake.notify_all()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with manager._lock:
            if ctx.state["runId"] not in manager._runs:
                return True
        time.sleep(0.01)
    return False


@pytest.mark.parametrize(
    ("fail_at", "keep_failing"),
    [(1, False), (2, False), (2, True)],
    ids=["queue-transition", "running-transition", "running-transition-broken-store"],
)
def test_scheduler_settles_the_job_whose_transition_commit_failed(
    tmp_path: Path, fail_at: int, keep_failing: bool
) -> None:
    """Leave no phantom active job when either transition commit fails.

    The queued-to-running transition registers a cancel event before the commit
    that can fail, so a cancel event alone must never make the scheduler assume
    an execution thread owns the job's settlement.
    """
    node = _node("deface", status="planned")
    ctx = _context(tmp_path, nodes=[node])
    ctx.store = _CommitFailingStore(  # type: ignore[assignment]
        ctx.store, fail_at=fail_at, keep_failing=keep_failing
    )
    manager = WorkflowManager(_Emitter())
    try:
        assert _settle_through_the_scheduler(manager, ctx) is True
        job = ctx.state["jobs"][-1]
        assert manager._active_jobs == {}
        assert manager.project_active(ctx.project.project_id) is False
        assert manager.active_counts() == (0, 0)
        assert node["status"] == "interrupted"
        assert job["status"] == "interrupted"
        assert job["terminalReason"] == "scheduler_failure"
        assert job["endedAt"] is not None
        if keep_failing:
            assert ctx.state["status"] == "persistence-error"
            assert job["durable"] is False
            assert job["persistenceStatus"] == "error"
            assert job["id"] in manager._persistence_errors
        else:
            assert ctx.state["status"] == "interrupted"
            assert job["id"] in manager._terminal_jobs
    finally:
        manager._active_jobs.clear()
        manager._runs.clear()
        manager.shutdown()


def test_scheduler_settles_a_job_whose_execution_thread_never_started(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    class _UnstartableThread:
        def __init__(self, **_kwargs: Any) -> None:
            self.daemon = False

        def start(self) -> None:
            raise RuntimeError("Refuse to start the execution thread.")

    node = _node("deface", status="planned")
    ctx = _context(tmp_path, nodes=[node])
    manager = WorkflowManager(_Emitter())
    # Refuse execution threads only after the manager owns its scheduler thread.
    monkeypatch.setattr(
        runtime,
        "threading",
        SimpleNamespace(
            Condition=threading.Condition,
            Event=threading.Event,
            Lock=threading.Lock,
            RLock=threading.RLock,
            Thread=_UnstartableThread,
            Timer=threading.Timer,
        ),
    )
    try:
        assert _settle_through_the_scheduler(manager, ctx) is True
        job = ctx.state["jobs"][-1]
        assert ctx.execution_threads == set()
        assert manager._active_jobs == {}
        assert manager.project_active(ctx.project.project_id) is False
        assert manager.active_counts() == (0, 0)
        assert node["status"] == "interrupted"
        assert job["status"] == "interrupted"
        assert job["terminalReason"] == "scheduler_failure"
    finally:
        manager._active_jobs.clear()
        manager._runs.clear()
        manager.shutdown()


def test_execute_backstop_tolerates_a_job_already_out_of_the_active_registry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    manager = WorkflowManager(_Emitter())

    def explode(*_args: Any, **_kwargs: Any) -> None:
        raise OSError("Simulate an unwrapped fault after settlement.")

    monkeypatch.setattr(manager, "_execute_inner", explode)
    try:
        with pytest.raises(OSError, match="unwrapped fault"):
            manager._execute(ctx, node["nodeId"], job["id"], threading.Event())
        # With nothing to settle the backstop leaves the node untouched.
        assert job["id"] not in manager._persistence_errors
        assert node["status"] == "running"
    finally:
        manager.shutdown()


def test_terminal_cache_trim_and_emitter_failure_are_bounded() -> None:
    class _FailingEmitter:
        def emit(self, _method: str, _params: dict[str, Any]) -> None:
            raise ValueError("Treat the renderer as closed.")

    manager = WorkflowManager(_FailingEmitter())
    try:
        for index in range(runtime.TERMINAL_CACHE_LIMIT + 2):
            manager._terminal_jobs[str(index)] = {"id": str(index)}
        manager._trim_terminal()
        manager._emit("ignored", {})
        assert len(manager._terminal_jobs) == runtime.TERMINAL_CACHE_LIMIT
        assert list(manager._terminal_jobs)[:2] == ["2", "3"]
    finally:
        manager.shutdown()


def test_run_snapshot_projects_analysis_and_selected_subject_ids(
    tmp_path: Path,
) -> None:
    ctx = _context(tmp_path, cohort=_cohort("sub-02", "sub-01"))
    ctx.state["scope"]["selectedSubjectIds"] = ["sub-02"]
    manager = WorkflowManager(_Emitter())
    try:
        snapshot = manager._run_snapshot(ctx.state)
    finally:
        manager.shutdown()

    assert snapshot["analysisSubjectIds"] == ["sub-02", "sub-01"]
    assert snapshot["selectedSubjectIds"] == ["sub-02"]


def test_terminal_job_emits_one_attributed_secret_free_error(
    tmp_path: Path,
) -> None:
    node = _node()
    job = _job(tmp_path, node, status="failed")
    job.update(
        {
            "endedAt": 3,
            "exitCode": 17,
            "terminalReason": (
                f"failed at {tmp_path} for sub-01 with API_KEY=emitted-secret"
            ),
        }
    )
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    emitter = _Emitter()
    manager = WorkflowManager(emitter)
    try:
        manager._emit_job(ctx, job)
        manager._emit_job(ctx, job)
    finally:
        manager.shutdown()

    error_events = [
        params["log"]
        for method, params in emitter.events
        if method == "runtime.event"
        and params.get("kind") == "log"
        and params.get("log", {}).get("level") == "ERROR"
    ]
    assert len(error_events) == 1
    assert error_events[0]["runId"] == ctx.state["runId"]
    assert error_events[0]["jobId"] == job["id"]
    assert "Investigate the failed job (exit code 17)" in error_events[0]["line"]
    assert "emitted-secret" not in error_events[0]["line"]
    # The live tail stays on the operator's machine, so it keeps the path and
    # the subject the failure names.
    assert str(tmp_path) in error_events[0]["line"]
    assert "sub-01" in error_events[0]["line"]


def test_log_commit_path_and_replay_reject_unsafe_and_unreadable_inputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RunStore(str(tmp_path))
    run_id = "run-cafe0002"
    logs = Path(store.run_dir(run_id)) / "logs"
    logs.mkdir(parents=True)
    valid = logs / "valid.log"
    valid.write_text("safe", encoding="utf-8")
    outside = tmp_path / "outside.log"
    outside.write_text("outside", encoding="utf-8")
    assert WorkflowManager._committed_log_path(store, run_id, None) is None
    assert WorkflowManager._committed_log_path(store, run_id, "relative.log") is None
    assert WorkflowManager._committed_log_path(store, run_id, str(logs)) is None
    assert WorkflowManager._committed_log_path(store, run_id, str(outside)) is None
    assert WorkflowManager._committed_log_path(store, run_id, str(valid)) == str(valid)

    manager = WorkflowManager(_Emitter())
    job = {
        "id": "#log",
        "runId": run_id,
        "stdoutPath": str(valid),
        "endedAt": 1,
    }
    state = {
        "runId": run_id,
        "scope": {"analysisSubjectIds": "malformed"},
    }
    try:
        empty = manager._replay_log_tail(store, {run_id: state}, [job], [], 0)
        assert empty.tail == []
        assert empty.coverage == []
        monkeypatch.setattr(
            runtime,
            "_tail_text_file",
            lambda _path: (_ for _ in ()).throw(
                OSError("Treat the fixture as unreadable.")
            ),
        )
        unreadable = manager._replay_log_tail(store, {run_id: state}, [job], [], 10)
        # A file the replay could not open reports no coverage, so its log is
        # never called empty.
        assert unreadable.tail == []
        assert unreadable.coverage == []
    finally:
        manager.shutdown()


def test_log_replay_synthesizes_attributed_terminal_error_without_output(
    tmp_path: Path,
) -> None:
    store = RunStore(str(tmp_path))
    run_id = "run-cafe0002"
    job = {
        "id": "#failed-job",
        "runId": run_id,
        "status": "failed",
        "endedAt": 41,
        "exitCode": 9,
        "stdoutPath": str(tmp_path / "missing.log"),
        "terminalReason": (
            f"failure in {tmp_path} for sub-private with API_KEY=leaked-value"
        ),
    }
    state = {
        "runId": run_id,
        "scope": {"analysisSubjectIds": ["sub-private"]},
    }
    manager = WorkflowManager(_Emitter())
    try:
        replay = manager._replay_log_tail(
            store,
            {run_id: state},
            [job],
            [],
            10,
        )
    finally:
        manager.shutdown()
    replayed = replay.tail
    # The log path was never opened, so the job has no coverage entry.
    assert replay.coverage == []

    assert len(replayed) == 1
    assert replayed[0]["runId"] == run_id
    assert replayed[0]["jobId"] == job["id"]
    assert replayed[0]["level"] == "ERROR"
    assert "Investigate the failed job (exit code 9)" in replayed[0]["line"]
    assert "leaked-value" not in replayed[0]["line"]
    # The marker stays in the operator's own tail, so it keeps the path and
    # the subject that make the failure reachable.
    assert str(tmp_path) in replayed[0]["line"]
    assert "sub-private" in replayed[0]["line"]


# Recorded reasons, each with its job, the marker the replay writes for it, and
# that marker's pinned id. A recorded job's marker keeps its text and id,
# because the replay deduplicates on the text and the renderer keys lines on
# the id.
_RECORDED_REASON_MARKERS = (
    (
        "job-0000",
        "failed",
        137,
        "Increase available memory for recon-all; mri_synthseg was killed by "
        "signal 9, which is how the kernel ends a process that ran out of memory. "
        "mri_synthseg alone needs about 24 GB free.",
        "log-replay-6a47eee25de5d34a",
        "Investigate the failed job (exit code 137): Increase available memory for "
        "recon-all; mri_synthseg was killed by signal 9, which is how the kernel "
        "ends a process that ran out of memory. mri_synthseg alone needs about 24 "
        "GB free.",
    ),
    (
        "job-0001",
        "failed",
        1,
        "Refuse execution because the bound action changed before launch.",
        "log-replay-79bc102635855709",
        "Investigate the failed job (exit code 1): Refuse execution because the "
        "bound action changed before launch.",
    ),
    (
        "job-0002",
        "failed",
        127,
        "Resolve the execution failure (RuntimeError). Accept process ownership "
        "before the timeout.",
        "log-replay-a45106726e4f2d97",
        "Investigate the failed job (exit code 127): Resolve the execution failure "
        "(RuntimeError). Accept process ownership before the timeout.",
    ),
    (
        "job-0003",
        "failed",
        127,
        "Resolve the execution failure (ValueError). Restore the metadata "
        "projection source.",
        "log-replay-eebf74a4f13c0815",
        "Investigate the failed job (exit code 127): Resolve the execution failure "
        "(ValueError). Restore the metadata projection source.",
    ),
    (
        "job-0005",
        "blocked",
        None,
        "Resolve dependency recon because it ended failed.",
        "log-replay-8b2bf30ce9f93aca",
        "Resolve the blocked job: Resolve dependency recon because it ended failed.",
    ),
)


def test_log_replay_keeps_the_marker_and_id_of_a_recorded_reason(
    tmp_path: Path,
) -> None:
    store = RunStore(str(tmp_path))
    run_id = "run-000000000001"
    jobs = [
        {
            "id": job_id,
            "runId": run_id,
            "status": status,
            "exitCode": exit_code,
            "terminalReason": reason,
            "startedAt": 1_000_000 + index,
            "endedAt": 2_000_000 + index,
            "stdoutPath": "",
        }
        for index, (job_id, status, exit_code, reason, _id, _line) in enumerate(
            _RECORDED_REASON_MARKERS
        )
    ]
    manager = WorkflowManager(_Emitter())
    try:
        replay = manager._replay_log_tail(
            store, {run_id: {"runId": run_id}}, jobs, [], 100
        )
    finally:
        manager.shutdown()

    assert [(entry["id"], entry["line"]) for entry in replay.tail] == [
        (marker_id, line) for *_recorded, marker_id, line in _RECORDED_REASON_MARKERS
    ]


def test_log_replay_keeps_the_ids_of_the_lines_in_a_job_log(
    tmp_path: Path,
) -> None:
    # A job log keeps its lines, and so their ids.
    store = RunStore(str(tmp_path))
    run_id = "run-000000000001"
    job = _replay_job(
        store,
        run_id,
        "#job-log",
        ended_at=3_000_100,
        text=(
            "Process 93 discovered subjects.\n"
            "Review /x/wm_volumes.csv with 93 rows and 70 structures.\n"
            "Resolve the execution failure (ValueError). Restore the metadata "
            "projection source.\n"
            "Confirm Supraspina copy-through completion with metadata preservation.\n"
        ),
    )
    job["id"] = "job-log"
    manager = WorkflowManager(_Emitter())
    try:
        replay = manager._replay_log_tail(
            store, {run_id: {"runId": run_id}}, [job], [], 100
        )
    finally:
        manager.shutdown()

    assert [entry["id"] for entry in replay.tail] == [
        "log-replay-b845fed448f763a7",
        "log-replay-e4afce38ca74569b",
        "log-replay-0cf10225663b8dcc",
        "log-replay-28ba9ce11a8b1474",
    ]


def _replay_two_committed_jobs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    older_status: str,
) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    """Replay a 1500-line newest job and a 1000-line older job into 2000 lines."""
    # Lift the per-job cap so each job contributes its whole log and only the
    # shared budget decides what stays.
    monkeypatch.setattr(runtime, "_REPLAY_LOG_LINES_PER_JOB", 5_000)
    store = RunStore(str(tmp_path))
    run_id = "run-cafe0003"
    logs = Path(store.run_dir(run_id)) / "logs"
    logs.mkdir(parents=True)
    older_log = logs / "older.log"
    older_log.write_text(
        "".join(f"older line {index}\n" for index in range(1_000)), encoding="utf-8"
    )
    newest_log = logs / "newest.log"
    newest_log.write_text(
        "".join(f"newest line {index}\n" for index in range(1_500)), encoding="utf-8"
    )
    older: dict[str, Any] = {
        "id": "#older",
        "runId": run_id,
        "status": older_status,
        "endedAt": 10_000,
        "stdoutPath": str(older_log),
    }
    if older_status == "failed":
        older["exitCode"] = 127
    newest: dict[str, Any] = {
        "id": "#newest",
        "runId": run_id,
        "status": "done",
        "endedAt": 50_000,
        "stdoutPath": str(newest_log),
    }
    state = {"runId": run_id, "scope": {"analysisSubjectIds": []}}
    manager = WorkflowManager(_Emitter())
    try:
        replayed = manager._replay_log_tail(
            store, {run_id: state}, [older, newest], [], 2_000
        ).tail
    finally:
        manager.shutdown()
    return replayed, older, newest


def test_log_replay_fills_the_budget_newest_job_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    replayed, older, newest = _replay_two_committed_jobs(
        tmp_path, monkeypatch, older_status="done"
    )

    newest_lines = [entry["line"] for entry in replayed if entry["jobId"] == "#newest"]
    older_lines = [entry["line"] for entry in replayed if entry["jobId"] == "#older"]
    assert len(replayed) == 2_000
    assert newest_lines == [f"newest line {index}" for index in range(1_500)]
    assert older_lines == [f"older line {index}" for index in range(500, 1_000)]
    assert replayed[-1]["jobId"] == newest["id"]
    assert replayed[-1]["line"] == "newest line 1499"
    assert [entry["at"] for entry in replayed] == sorted(
        entry["at"] for entry in replayed
    )
    # Each kept line keeps its position in the whole job log.
    assert replayed[0]["at"] == older["endedAt"] + 500


def test_log_replay_sorts_an_older_terminal_error_before_newer_lines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    replayed, older, newest = _replay_two_committed_jobs(
        tmp_path, monkeypatch, older_status="failed"
    )

    errors = [
        index
        for index, entry in enumerate(replayed)
        if entry["jobId"] == older["id"] and entry["level"] == "ERROR"
    ]
    assert len(replayed) == 2_000
    assert len(errors) == 1
    marker = replayed[errors[0]]
    assert "Investigate the failed job (exit code 127)" in marker["line"]
    # The marker stays at its own job's time, right after that job's lines,
    # so the newest job's lines follow it and still end the tail.
    assert marker["at"] == older["endedAt"] + 1_000
    assert replayed[errors[0] - 1]["line"] == "older line 999"
    assert replayed[errors[0] + 1]["line"] == "newest line 0"
    assert replayed[-1]["jobId"] == newest["id"]
    assert replayed[-1]["line"] == "newest line 1499"


def _replay_job(
    store: RunStore,
    run_id: str,
    job_id: str,
    *,
    ended_at: int,
    text: str,
) -> dict[str, Any]:
    """Build one finished job whose committed log holds ``text``."""
    log_path = Path(store.run_dir(run_id)) / "logs" / f"{job_id[1:]}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(text, encoding="utf-8")
    return {
        "id": job_id,
        "runId": run_id,
        "status": "done",
        "startedAt": ended_at - 1,
        "endedAt": ended_at,
        "stdoutPath": str(log_path),
    }


def test_log_replay_reports_an_empty_log_and_a_bounded_tail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(runtime, "_REPLAY_LOG_LINES_PER_JOB", 3)
    store = RunStore(str(tmp_path))
    run_id = "run-cafe0004"
    empty = _replay_job(store, run_id, "#empty", ended_at=300, text="")
    whole = _replay_job(store, run_id, "#whole", ended_at=200, text="a\nb\n")
    long = _replay_job(
        store,
        run_id,
        "#long",
        ended_at=100,
        text="".join(f"line {index}\n" for index in range(10)),
    )
    state = {"runId": run_id, "scope": {"analysisSubjectIds": []}}
    manager = WorkflowManager(_Emitter())
    try:
        replay = manager._replay_log_tail(
            store, {run_id: state}, [long, whole, empty], [], 2_000
        )
    finally:
        manager.shutdown()

    # Newest job first; the empty file reads in full with no line, and the
    # long file is read only as its bounded tail.
    assert replay.coverage == [
        {"runId": run_id, "jobId": "#empty", "lines": 0, "complete": True},
        {"runId": run_id, "jobId": "#whole", "lines": 2, "complete": True},
        {"runId": run_id, "jobId": "#long", "lines": 3, "complete": False},
    ]
    assert not any(entry["jobId"] == "#empty" for entry in replay.tail)


def test_log_replay_gives_no_coverage_past_the_file_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The replay stops after the file limit even with budget left, yet still
    # emits every old failure's marker, so Logs must not call the logs it
    # never read empty.
    monkeypatch.setattr(runtime, "_REPLAY_LOG_FILE_LIMIT", 2)
    store = RunStore(str(tmp_path))
    run_id = "run-cafe0005"
    old_failed = _replay_job(store, run_id, "#old-failed", ended_at=10, text="")
    old_failed.update({"status": "failed", "exitCode": 1})
    jobs = [
        _replay_job(store, run_id, f"#job-{index}", ended_at=100 * index, text="")
        for index in range(1, 5)
    ]
    state = {"runId": run_id, "scope": {"analysisSubjectIds": []}}
    manager = WorkflowManager(_Emitter())
    try:
        replay = manager._replay_log_tail(
            store, {run_id: state}, [old_failed, *jobs], [], 2_000
        )
    finally:
        manager.shutdown()

    # Only the two newest logs were opened; the rest carry no entry.
    assert [entry["jobId"] for entry in replay.coverage] == ["#job-4", "#job-3"]
    assert all(entry["complete"] for entry in replay.coverage)
    # The old failure's terminal marker is still emitted.
    markers = [
        entry
        for entry in replay.tail
        if entry["jobId"] == "#old-failed" and entry["level"] == "ERROR"
    ]
    assert len(markers) == 1
    assert markers[0]["at"] == old_failed["endedAt"]


def test_bootstrap_snapshot_carries_the_log_replay_coverage(tmp_path: Path) -> None:
    state = _old_state(tmp_path, status="done")
    store = RunStore(str(tmp_path))
    job = _replay_job(store, state["runId"], "#empty", ended_at=2, text="")
    job.update(
        {
            "nodeId": state["nodes"][0]["nodeId"],
            "projectId": "critical-recovery",
            "projectEpoch": 1,
            "sidecarGeneration": 0,
            "stepKey": "recon",
            "subjectId": "sub-01",
            "scope": "subject",
            "plannedAt": 1,
            "exitCode": 0,
            "stderrPath": job["stdoutPath"],
            "dryRun": False,
            "durable": True,
            "persistenceStatus": "durable",
            "terminalReason": "completed",
        }
    )
    state["jobs"] = [job]
    store.commit(state)
    manager = WorkflowManager(_Emitter())
    try:
        snapshot = manager.bootstrap(
            {"project": _project(tmp_path), "runLimit": 10, "logLimit": 20}
        )
        silent = manager.bootstrap(
            {"project": _project(tmp_path), "runLimit": 10, "logLimit": 0}
        )
    finally:
        manager.shutdown()

    assert snapshot["logReplay"] == [
        {"runId": state["runId"], "jobId": "#empty", "lines": 0, "complete": True}
    ]
    assert silent["logReplay"] == []


def _old_state(root: Path, *, status: str = "failed") -> dict[str, Any]:
    node = _node(status=status)
    return {
        "runId": "run-50a0ce01",
        "project": _project(root),
        "configRevision": 1,
        "config": {"paths": {"projectRoot": str(root.resolve())}},
        "configSha256": "old",
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "acknowledgements": {},
        "scope": _cohort("sub-01").to_dict(),
        "nodes": [node],
        "jobs": [],
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
        "endedAtMs": 2,
        "manifest": {"schemaVersion": 1, "runId": "run-50a0ce01"},
    }


def _resume_request(
    root: Path,
    *,
    dry_run: bool,
    clean: bool = False,
    include_cancelled: bool = False,
) -> dict[str, Any]:
    return {
        "project": _project(root),
        "cfg": {
            "paths": {"projectRoot": str(root.resolve())},
            "runtime": {"dryRun": dry_run, "queueSize": 0},
        },
        "configRevision": 1,
        "runId": "run-50a0ce01",
        "cleanIncomplete": clean,
        "includeCancelled": include_cancelled,
        "liveExecutionAuthorization": "authorization",
        "acknowledgements": {"acknowledgeMemoryAdvisory": True},
    }


def test_selected_retry_subject_ids_returns_none_without_explicit_nodes() -> None:
    source_nodes = [_node(subject_id="sub-001")]

    assert runtime._selected_retry_subject_ids(source_nodes, {}) is None


@pytest.mark.parametrize(
    ("node_ids", "message"),
    [
        ("source-recon:sub-001", r"Provide retry nodeIds as an array\."),
        ([1], r"Include only strings in retry nodeIds\."),
        (["missing"], r"Select only known source nodes for retry\."),
    ],
)
def test_selected_retry_subject_ids_rejects_invalid_selection(
    node_ids: object, message: str
) -> None:
    source_nodes = [
        {**_node(subject_id="sub-001"), "nodeId": "source-recon:sub-001"},
        {**_node(subject_id="sub-002"), "nodeId": 2},
    ]

    with pytest.raises(ValueError, match=message):
        runtime._selected_retry_subject_ids(source_nodes, {"nodeIds": node_ids})


def test_selected_retry_subject_ids_preserves_source_order_and_deduplicates() -> None:
    source_nodes = [
        {**_node(subject_id="sub-002"), "nodeId": "recon:sub-002"},
        {
            **_node("deface", subject_id="sub-002"),
            "nodeId": "deface:sub-002",
        },
        {**_node(subject_id="sub-001"), "nodeId": "recon:sub-001"},
        {**_node(subject_id="sub-003"), "nodeId": "recon:sub-003"},
    ]

    selected = runtime._selected_retry_subject_ids(
        source_nodes,
        {
            "nodeIds": [
                "recon:sub-001",
                "deface:sub-002",
                "recon:sub-002",
            ]
        },
    )

    assert selected == ["sub-002", "sub-001"]


def test_selected_retry_subject_ids_keeps_cohort_selection_full_scope() -> None:
    source_nodes = [
        {**_node(subject_id="sub-001"), "nodeId": "recon:sub-001"},
        {
            **_node("features", subject_id=None),
            "nodeId": "features:cohort",
        },
    ]

    assert (
        runtime._selected_retry_subject_ids(
            source_nodes, {"nodeIds": ["features:cohort"]}
        )
        is None
    )


def test_selected_retry_subject_ids_accepts_explicit_empty_selection() -> None:
    source_nodes = [_node(subject_id="sub-001")]

    assert runtime._selected_retry_subject_ids(source_nodes, {"nodeIds": []}) == []


def test_resume_without_selection_reconciliation_keeps_source_scope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    old = _old_state(tmp_path)
    RunStore(str(tmp_path)).commit(old)
    planned = _planned(
        [_node(status="planned")],
        cohort=_cohort("sub-01"),
        effective_cfg={"_supraspinaRuntime": {}},
    )
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    monkeypatch.setattr(
        runtime,
        "_resume_intent",
        lambda *_args, **_kwargs: (copy.deepcopy(old["intent"]), None),
    )
    monkeypatch.setattr(runtime, "build_plan", lambda *_args, **_kwargs: planned)
    monkeypatch.setattr(manager, "_current_receipt", lambda *_args: None)
    monkeypatch.setattr(manager, "_apply_runtime_policy", lambda _ctx: None)
    monkeypatch.setattr(manager, "_apply_stage_readiness", lambda _ctx: None)
    request = _resume_request(tmp_path, dry_run=True)
    request["previewOnly"] = True
    try:
        result = manager.resume(request)
    finally:
        manager.shutdown()

    assert "selectionReconciliation" not in result["plan"]
    assert result["plan"]["nodes"][0]["subjectId"] == "sub-01"


def test_retry_selected_failed_recon_preserves_cohort_and_reruns_partial_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    subject_ids = (
        "sub-001",
        "sub-012",
        "sub-019",
        "sub-049",
        "sub-053",
    )
    current = CohortSnapshot(
        analysis_subject_ids=subject_ids,
        selected_subject_ids=subject_ids,
        analysis_digest="analysis-five",
        selected_digest="selected-five",
        t1=(),
        qc_verdicts=tuple((subject_id, "unreviewed") for subject_id in subject_ids),
        qc_acknowledged=True,
        excluded_by_config=(),
        excluded_by_qc=(),
    )
    old_recon_nodes = [
        {
            **_node(
                subject_id=subject_id,
                status="failed" if subject_id == "sub-049" else "done",
            ),
            "nodeId": f"source-recon:{subject_id}",
        }
        for subject_id in subject_ids
    ]
    old_features = {
        **_node(
            "features",
            subject_id=None,
            status="waiting",
            dependencies=[node["nodeId"] for node in old_recon_nodes],
        ),
        "nodeId": "source-features:cohort",
    }
    old_aggregate = {
        **_node(
            "aggregate",
            subject_id=None,
            status="waiting",
            dependencies=[old_features["nodeId"]],
        ),
        "nodeId": "source-aggregate:cohort",
    }
    old = _old_state(tmp_path)
    old["scope"] = current.to_dict()
    old["nodes"] = [*old_recon_nodes, old_features, old_aggregate]
    RunStore(str(tmp_path)).commit(old)

    monkeypatch.setattr(
        runtime, "build_cohort_snapshot", lambda *_args, **_kwargs: current
    )

    def planned_factory(
        request: dict[str, Any],
        *,
        run_id: str | None = None,
        env_report: dict[str, Any] | None = None,
    ) -> PlannedWorkflow:
        del env_report
        analysis_subject_ids = tuple(request["_recoveryAnalysisSubjectIds"])
        selected_subject_ids = tuple(
            request["intent"].get("target", {}).get("subjectIds", [])
        )
        cohort = CohortSnapshot(
            analysis_subject_ids=analysis_subject_ids,
            selected_subject_ids=selected_subject_ids,
            analysis_digest=f"analysis:{','.join(analysis_subject_ids)}",
            selected_digest=f"selected:{','.join(selected_subject_ids)}",
            t1=(),
            qc_verdicts=tuple(
                (subject_id, "unreviewed") for subject_id in analysis_subject_ids
            ),
            qc_acknowledged=request["acknowledgements"][
                "includeDeferredAndUnreviewedQc"
            ],
            excluded_by_config=(),
            excluded_by_qc=(),
        )
        nodes = [
            {
                **_node(subject_id=subject_id, status="planned"),
                "nodeId": f"retry-recon:{subject_id}",
            }
            for subject_id in selected_subject_ids
        ]
        if selected_subject_ids:
            features = {
                **_node(
                    "features",
                    subject_id=None,
                    status="waiting",
                    dependencies=[node["nodeId"] for node in nodes],
                ),
                "nodeId": "retry-features:cohort",
            }
            aggregate = {
                **_node(
                    "aggregate",
                    subject_id=None,
                    status="waiting",
                    dependencies=[features["nodeId"]],
                ),
                "nodeId": "retry-aggregate:cohort",
            }
            nodes.extend((features, aggregate))
        planned = _planned(
            nodes,
            cohort=cohort,
            disposition="planned" if nodes else "noop",
            effective_cfg={"_supraspinaRuntime": {}},
        )
        planned.result["plan"].update(
            {
                "planId": run_id or "run-123456abcdef",
                "analysisCohort": {
                    "subjectIds": list(analysis_subject_ids),
                    "sha256": cohort.analysis_digest,
                },
                "selectedSubset": {
                    "subjectIds": list(selected_subject_ids),
                    "sha256": cohort.selected_digest,
                },
            }
        )
        return planned

    monkeypatch.setattr(runtime, "build_plan", planned_factory)
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    monkeypatch.setattr(manager, "_current_receipt", lambda _ctx, _node: None)
    monkeypatch.setattr(
        runtime,
        "detector_evidence",
        lambda adapter, _cfg, subject_id: {
            "state": (
                "partial"
                if adapter is runtime.ADAPTERS["recon"] and subject_id == "sub-049"
                else "pending"
            ),
            "detail": "Keep the failed FreeSurfer tree on disk.",
        },
    )
    monkeypatch.setattr(manager, "_apply_stage_readiness", lambda _ctx: None)
    request = _resume_request(tmp_path, dry_run=True)
    request["cfg"]["runtime"]["rerunIncomplete"] = False
    request.update(
        {
            "previewOnly": True,
            "nodeIds": ["source-recon:sub-049"],
            "acknowledgements": {
                "includeDeferredAndUnreviewedQc": False,
                "acknowledgeMemoryAdvisory": True,
            },
        }
    )
    try:
        strict = manager.resume(request, retry=True)
        request["acknowledgements"]["includeDeferredAndUnreviewedQc"] = True
        included = manager.resume(request, retry=True)
    finally:
        manager.shutdown()

    assert strict["plan"]["selectionReconciliation"][
        "deferredAndUnreviewedSubjectIds"
    ] == ["sub-049"]
    assert included["plan"]["analysisCohort"]["subjectIds"] == list(subject_ids)
    assert included["plan"]["selectedSubset"]["subjectIds"] == ["sub-049"]
    assert [
        (node["stepKey"], node["subjectId"]) for node in included["plan"]["nodes"]
    ] == [
        ("recon", "sub-049"),
        ("features", None),
        ("aggregate", None),
    ]
    assert all(
        node["status"] in {"planned", "waiting"} for node in included["plan"]["nodes"]
    )


def test_resume_rejects_graphless_foreign_and_active_live_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Store:
        value: ClassVar[dict[str, Any]] = {}

        def __init__(self, _root: str) -> None:
            pass

        def load(self, _run_id: str) -> dict[str, Any]:
            return copy.deepcopy(self.value)

    monkeypatch.setattr(runtime, "RunStore", _Store)
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    request = _resume_request(tmp_path, dry_run=True)
    request["previewOnly"] = True
    try:
        _Store.value = {"nodes": []}
        with pytest.raises(
            ValueError, match=r"Select a run with a resumable authoritative graph\."
        ):
            manager.resume(request)

        _Store.value = _old_state(tmp_path)
        _Store.value["project"]["projectId"] = "different"
        with pytest.raises(
            ValueError, match=r"Select a run from the current project\."
        ):
            manager.resume(request)

        _Store.value = _old_state(tmp_path)
        request = _resume_request(tmp_path, dry_run=False)
        request["approvedPlan"] = {
            "planId": "run-aabbccddeeff",
            "digest": "a" * 64,
        }
        monkeypatch.setattr(manager, "project_active", lambda _project_id: True)
        with pytest.raises(
            ValueError,
            match=r"Wait for the active workflow to finish before starting another",
        ):
            manager.resume(request)
    finally:
        manager.shutdown()


def test_resume_dry_retry_preserves_source_policy_and_previews_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RunStore(str(tmp_path))
    store.commit(_old_state(tmp_path))
    planned_node = _node(status="planned")
    planned = _planned(
        [planned_node],
        cohort=_cohort("sub-01"),
        effective_cfg={"_supraspinaRuntime": {}},
    )
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    monkeypatch.setattr(runtime, "build_plan", lambda *_args, **_kwargs: planned)
    monkeypatch.setattr(manager, "_current_receipt", lambda *_args: None)
    monkeypatch.setattr(manager, "_validate_clean_incomplete", lambda _ctx: None)
    monkeypatch.setattr(manager, "_apply_runtime_policy", lambda _ctx: None)
    monkeypatch.setattr(manager, "_apply_stage_readiness", lambda _ctx: None)
    request = _resume_request(tmp_path, dry_run=True, clean=True)
    request["previewOnly"] = True
    try:
        result = manager.resume(request, retry=True)
    finally:
        manager.shutdown()

    assert result["disposition"] == "planned"
    assert result["runId"] is None
    assert result["plan"]["recovery"]["action"] == "retry"
    assert result["plan"]["recovery"]["cleanIncomplete"] is True
    assert manager._runs == {}
    assert RunStore(str(tmp_path)).run_ids() == ["run-50a0ce01"]


def test_accepted_resume_dry_run_persists_planned_jobs_without_scheduling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RunStore(str(tmp_path))
    store.commit(_old_state(tmp_path))
    command = "recon-all -s sub-01 -all"
    spawned: list[list[str]] = []
    manager = WorkflowManager(
        _Emitter(),
        spawn=spawned.append,
        env_check=lambda _cfg: {"groups": []},
    )

    def planned_factory(
        _request: dict[str, Any],
        *,
        run_id: str | None = None,
        env_report: dict[str, Any] | None = None,
    ) -> PlannedWorkflow:
        del env_report
        node = _node(status="planned")
        node["command"] = command
        planned = _planned(
            [node],
            cohort=_cohort("sub-01"),
            effective_cfg={"_supraspinaRuntime": {}},
        )
        planned.result["plan"]["planId"] = run_id or "run-deadbeef1234"
        return planned

    monkeypatch.setattr(runtime, "build_plan", planned_factory)
    monkeypatch.setattr(
        manager, "_reconcile_recovery_nodes", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(manager, "_apply_runtime_policy", lambda _ctx: None)
    monkeypatch.setattr(manager, "_apply_stage_readiness", lambda _ctx: None)
    request = _resume_request(tmp_path, dry_run=True)
    request["previewOnly"] = True
    try:
        preview = manager.resume(request)
        request["approvedPlan"] = {
            "planId": preview["plan"]["planId"],
            "digest": preview["plan"]["digest"],
        }
        request["previewOnly"] = False

        result = manager.resume(request)

        assert result["disposition"] == "planned"
        assert spawned == []
        assert manager.active_counts() == (0, 0)
    finally:
        manager.shutdown()

    state = store.load(result["runId"])
    assert state["parentRunId"] == "run-50a0ce01"
    assert state["recovery"]["detail"] == "Resumed from run-50a0ce01."
    assert state["cohortReconciliation"]["reason"] == (
        "Only subjects in both the source cohort and the current eligible "
        "cohort are kept; no new subjects are added."
    )
    assert state["jobs"][0]["status"] == "planned"
    assert state["jobs"][0]["dryRun"] is True
    assert state["jobs"][0]["cmd"] == command
    assert state["receipts"] == _old_state(tmp_path)["receipts"]


def test_resume_preview_uses_only_fresh_acknowledgements_and_memory_binding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    old = _old_state(tmp_path)
    old["acknowledgements"] = {
        "includeDeferredAndUnreviewedQc": True,
        "acknowledgeMemoryAdvisory": True,
    }
    store = RunStore(str(tmp_path))
    store.commit(old)
    memory = {"value": 16.0}
    authorization = _Authorization()
    manager = WorkflowManager(
        _Emitter(),
        env_check=lambda _cfg: {
            "groups": [],
            "availableMemoryGB": memory["value"],
        },
        authorizations=authorization,  # type: ignore[arg-type]
    )
    seen_acknowledgements: list[dict[str, Any]] = []

    def planned_factory(
        request: dict[str, Any],
        *,
        run_id: str | None = None,
        env_report: dict[str, Any] | None = None,
    ) -> PlannedWorkflow:
        del env_report
        seen_acknowledgements.append(copy.deepcopy(request["acknowledgements"]))
        planned = _planned(
            [_node(status="planned")],
            cohort=_cohort("sub-01"),
            effective_cfg={"_supraspinaRuntime": {}},
        )
        planned.result["plan"]["planId"] = run_id or "run-c0ffee123456"
        return planned

    monkeypatch.setattr(runtime, "build_plan", planned_factory)
    monkeypatch.setattr(
        runtime,
        "_resume_intent",
        lambda intent, _cfg, ack, **_kwargs: (
            copy.deepcopy(intent),
            {
                "sourceSubjectIds": ["sub-01"],
                "currentEligibleSubjectIds": ["sub-01"],
                "retainedSubjectIds": ["sub-01"],
                "addedSubjectIds": [],
                "removedSubjectIds": [],
            },
        ),
    )
    monkeypatch.setattr(manager, "_current_receipt", lambda *_args: None)
    monkeypatch.setattr(manager, "_apply_runtime_policy", lambda _ctx: None)
    monkeypatch.setattr(manager, "_apply_stage_readiness", lambda _ctx: None)
    request = _resume_request(tmp_path, dry_run=True)
    request["previewOnly"] = True
    request["acknowledgements"] = {
        "includeDeferredAndUnreviewedQc": False,
        "acknowledgeMemoryAdvisory": True,
    }
    try:
        strict = manager.resume(request)
        assert seen_acknowledgements[-1]["includeDeferredAndUnreviewedQc"] is False
        assert strict["runId"] is None
        assert manager._runs == {}
        assert store.run_ids() == ["run-50a0ce01"]

        request["acknowledgements"]["includeDeferredAndUnreviewedQc"] = True
        acknowledged = manager.resume(request)
        assert acknowledged["plan"]["digest"] != strict["plan"]["digest"]
        assert seen_acknowledgements[-1]["includeDeferredAndUnreviewedQc"] is True

        request["approvedPlan"] = {
            "planId": acknowledged["plan"]["planId"],
            "digest": acknowledged["plan"]["digest"],
        }
        request["previewOnly"] = False
        memory["value"] = 8.0
        with pytest.raises(ValueError, match=r"^Review the stale plan again\.$"):
            manager.resume(request)
    finally:
        manager.shutdown()

    assert authorization.calls == []
    assert manager._runs == {}
    assert store.run_ids() == ["run-50a0ce01"]
    assert store.load("run-50a0ce01")["acknowledgements"] == old["acknowledgements"]


@pytest.mark.parametrize("cleanup_fails", [False, True])
def test_resume_live_cleanup_uses_cleanup_authorization_and_blocks_on_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    cleanup_fails: bool,
) -> None:
    store = RunStore(str(tmp_path))
    store.commit(_old_state(tmp_path))
    planned = _planned(
        [_node(status="planned")],
        cohort=_cohort("sub-01"),
        effective_cfg={"_supraspinaRuntime": {}},
    )
    authorization = _Authorization()
    manager = WorkflowManager(
        _Emitter(),
        env_check=lambda _cfg: {"groups": []},
        authorizations=authorization,  # type: ignore[arg-type]
    )
    monkeypatch.setattr(runtime, "build_plan", lambda *_args, **_kwargs: planned)
    monkeypatch.setattr(manager, "_current_receipt", lambda *_args: None)
    monkeypatch.setattr(manager, "_validate_clean_incomplete", lambda _ctx: None)
    monkeypatch.setattr(manager, "_apply_runtime_policy", lambda _ctx: None)
    monkeypatch.setattr(manager, "_apply_stage_readiness", lambda _ctx: None)
    if cleanup_fails:
        monkeypatch.setattr(
            manager,
            "_clean_incomplete_recon",
            lambda _ctx: (_ for _ in ()).throw(ValueError("Reject unsafe cleanup.")),
        )
    else:
        monkeypatch.setattr(
            manager,
            "_clean_incomplete_recon",
            lambda ctx: ctx.state.update({"cleanup": {"subjectIds": ["sub-01"]}}),
        )
    request = _resume_request(tmp_path, dry_run=False, clean=True)
    try:
        preview_request = copy.deepcopy(request)
        preview_request["previewOnly"] = True
        preview = manager.resume(preview_request, retry=True)
        request["approvedPlan"] = {
            "planId": preview["plan"]["planId"],
            "digest": preview["plan"]["digest"],
        }
        request["liveExecutionAuthorization"] = {
            "token": "cleanup-authorization-token",
            "projectId": "critical-recovery",
            "configRevision": 1,
            "purpose": "cleanup",
            "planDigest": preview["plan"]["digest"],
        }
        with manager._wake:
            result = manager.resume(request, retry=True)
            resumed = (
                manager._runs.get(result.get("runId"))
                if result.get("runId") is not None
                else None
            )
            manager._runs.clear()
    finally:
        manager.shutdown()

    assert authorization.calls[0][-1] == "cleanup"
    if cleanup_fails:
        assert result["disposition"] == "blocked"
        assert result["runId"] is None
        assert result["plan"]["nodes"][0]["status"] == "blocked"
        (blocked_run,) = [
            run_id for run_id in store.run_ids() if run_id != "run-50a0ce01"
        ]
        assert store.load(blocked_run)["warnings"] == [
            "The authorized cleanup failed, so no scientific process was launched."
        ]
    else:
        assert result["disposition"] == "started"
        assert resumed is not None
        assert resumed.state["cleanup"]["subjectIds"] == ["sub-01"]


@pytest.mark.parametrize(
    ("status", "expected"), [("blocked", "blocked"), ("skipped", "noop")]
)
def test_resume_returns_without_new_run_when_reconciliation_is_not_runnable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    status: str,
    expected: str,
) -> None:
    RunStore(str(tmp_path)).commit(_old_state(tmp_path))
    planned = _planned([_node(status=status)], cohort=_cohort("sub-01"))
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    monkeypatch.setattr(runtime, "build_plan", lambda *_args, **_kwargs: planned)
    monkeypatch.setattr(
        manager, "_reconcile_recovery_nodes", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(manager, "_apply_runtime_policy", lambda _ctx: None)
    monkeypatch.setattr(manager, "_apply_stage_readiness", lambda _ctx: None)
    try:
        request = _resume_request(tmp_path, dry_run=True)
        request["previewOnly"] = True
        result = manager.resume(request)
    finally:
        manager.shutdown()
    assert result["runId"] is None
    assert result["disposition"] == expected


def test_resume_propagates_selection_reconciliation_and_blocked_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    old = _old_state(tmp_path)
    old["intent"] = {
        "kind": "stage",
        "stepKey": "recon",
        "target": {"mode": "explicit", "subjectIds": ["sub-01", "sub-removed"]},
    }
    RunStore(str(tmp_path)).commit(old)
    planned = _planned([], cohort=None, disposition="blocked")
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    monkeypatch.setattr(
        runtime,
        "_resume_intent",
        lambda *_args, **_kwargs: (
            old["intent"],
            {
                "sourceSubjectIds": ["sub-01", "sub-removed"],
                "currentEligibleSubjectIds": ["sub-01"],
                "retainedSubjectIds": ["sub-01"],
                "addedSubjectIds": [],
                "removedSubjectIds": ["sub-removed"],
            },
        ),
    )
    monkeypatch.setattr(runtime, "build_plan", lambda *_args, **_kwargs: planned)
    try:
        request = _resume_request(tmp_path, dry_run=True)
        request["previewOnly"] = True
        result = manager.resume(request)
    finally:
        manager.shutdown()
    assert result["runId"] is None
    assert result["plan"]["selectionReconciliation"]["removedSubjectIds"] == [
        "sub-removed"
    ]


def test_recovery_selection_validation_and_cancelled_policy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cancelled = _node(status="cancelled")
    downstream = _node(
        "enigma",
        subject_id=None,
        status="planned",
        dependencies=[cancelled["nodeId"]],
    )
    old = {
        "nodes": [copy.deepcopy(cancelled), copy.deepcopy(downstream)],
        "intent": {"target": {"mode": "all"}},
    }
    ctx = _context(
        tmp_path,
        nodes=[copy.deepcopy(cancelled), copy.deepcopy(downstream)],
    )
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(manager, "_current_receipt", lambda *_args: None)
    try:
        with pytest.raises(ValueError, match=r"Provide retry nodeIds as an array\."):
            manager._reconcile_recovery_nodes(ctx, old, {"nodeIds": "bad"}, retry=True)
        with pytest.raises(
            ValueError, match=r"Include only strings in retry nodeIds\."
        ):
            manager._reconcile_recovery_nodes(ctx, old, {"nodeIds": [1]}, retry=True)
        with pytest.raises(
            ValueError, match=r"Select only known source nodes for retry\."
        ):
            manager._reconcile_recovery_nodes(
                ctx, old, {"nodeIds": ["missing"]}, retry=True
            )

        ctx.state["nodes"] = [copy.deepcopy(cancelled), copy.deepcopy(downstream)]
        manager._reconcile_recovery_nodes(ctx, old, {}, retry=True)
        assert [node["status"] for node in ctx.state["nodes"]] == [
            "skipped",
            "planned",
        ]

        ctx.state["nodes"] = [copy.deepcopy(cancelled), copy.deepcopy(downstream)]
        manager._reconcile_recovery_nodes(
            ctx,
            old,
            {"includeCancelled": True, "nodeIds": [downstream["nodeId"]]},
            retry=True,
        )
        assert ctx.state["nodes"][0]["status"] == "cancelled"
        assert ctx.state["nodes"][1]["status"] == "planned"
    finally:
        manager.shutdown()


class _ReconAdapter:
    def __init__(self, subjects_dir: Path, *, state: str = "partial") -> None:
        self.subjects_dir = subjects_dir
        self.state = state

    def detect(self, _cfg: dict[str, Any], _subject_id: str) -> SimpleNamespace:
        return SimpleNamespace(state=self.state)

    def build_command(self, _cfg: dict[str, Any], subject_id: str) -> list[str]:
        return ["recon-all", "-sd", str(self.subjects_dir), "-subjid", subject_id]


def test_clean_incomplete_validation_rejects_non_recon_and_complete_roots(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx = _context(tmp_path)
    manager = WorkflowManager(_Emitter())
    try:
        # Author every refusal for the operator so it reaches the window instead
        # of being replaced by the generic runtime-failure sentence.
        ctx.state["recoveryRoots"] = []
        with pytest.raises(
            OperatorError,
            match=r"Use Resume because Clean and retry has no incomplete Reconstruction",
        ):
            manager._validate_clean_incomplete(ctx)

        ctx.state["recoveryRoots"] = [{"stepKey": "features", "subjectId": None}]
        with pytest.raises(
            OperatorError,
            match=r"can remove only incomplete Reconstruction output\.",
        ):
            manager._validate_clean_incomplete(ctx)

        ctx.state["recoveryRoots"] = [{"stepKey": "recon", "subjectId": "sub-01"}]
        monkeypatch.setitem(
            runtime.ADAPTERS,
            "recon",
            _ReconAdapter(tmp_path / "subjects", state="done"),
        )
        with pytest.raises(OperatorError, match="the detector reports as complete"):
            manager._validate_clean_incomplete(ctx)

        monkeypatch.setitem(
            runtime.ADAPTERS,
            "recon",
            _ReconAdapter(tmp_path / "subjects", state="partial"),
        )
        manager._validate_clean_incomplete(ctx)
    finally:
        manager.shutdown()


def test_clean_incomplete_recon_removes_only_owned_partial_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    subjects_dir = tmp_path / "subjects"
    target = subjects_dir / "sub-01"
    target.mkdir(parents=True)
    (target / "partial.txt").write_text("partial", encoding="utf-8")
    node = _node(status="planned")
    ctx = _context(tmp_path, nodes=[node])
    ctx.state["recoveryRoots"] = [{"stepKey": "recon", "subjectId": "sub-01"}]
    manager = WorkflowManager(_Emitter())
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _ReconAdapter(subjects_dir))
    try:
        manager._clean_incomplete_recon(ctx)
        assert target.exists() is False
        assert ctx.state["cleanup"]["subjectIds"] == ["sub-01"]

        manager._clean_incomplete_recon(ctx)
        assert ctx.state["cleanup"]["subjectIds"] == []
    finally:
        manager.shutdown()


@pytest.mark.parametrize("kind", ["done", "unsafe", "file", "symlink"])
def test_clean_incomplete_recon_rejects_unsafe_or_non_owned_targets(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    kind: str,
) -> None:
    subjects_dir = tmp_path / "subjects"
    subjects_dir.mkdir()
    subject_id = "../escape" if kind == "unsafe" else "sub-01"
    node = _node(subject_id=subject_id, status="planned")
    ctx = _context(tmp_path, nodes=[node], cohort=_cohort(subject_id))
    ctx.state["recoveryRoots"] = [{"stepKey": "recon", "subjectId": subject_id}]
    state = "done" if kind == "done" else "partial"
    monkeypatch.setitem(
        runtime.ADAPTERS, "recon", _ReconAdapter(subjects_dir, state=state)
    )
    target = subjects_dir / "sub-01"
    if kind == "file":
        target.write_text("not owned", encoding="utf-8")
    elif kind == "symlink":
        outside = tmp_path / "outside"
        outside.mkdir()
        target.symlink_to(outside, target_is_directory=True)
    manager = WorkflowManager(_Emitter())
    try:
        message = {
            "done": "the detector reports as complete",
            "unsafe": r"Select a safe Recon cleanup target\.",
            "file": r"Select an owned Recon cleanup directory\.",
            "symlink": r"Select a safe Recon cleanup target\.",
        }[kind]
        # Match the ValueError-free OperatorError refusal on its own class.
        expected = OperatorError if kind == "done" else ValueError
        with pytest.raises(expected, match=message):
            manager._clean_incomplete_recon(ctx)
    finally:
        manager.shutdown()


def test_manifest_list_projects_cursor_and_terminal_page(tmp_path: Path) -> None:
    store = RunStore(str(tmp_path))
    for index in range(2):
        state = _old_state(tmp_path, status="done")
        state["runId"] = f"run-{index + 1:08x}"
        state["manifest"] = {
            "schemaVersion": 1,
            "runId": state["runId"],
        }
        store.commit(state)
    manager = WorkflowManager(_Emitter())
    try:
        first = manager.manifest_list(_project(tmp_path), None, 1)
        second = manager.manifest_list(_project(tmp_path), first["nextCursor"], 10)
    finally:
        manager.shutdown()
    assert len(first["items"]) == 1
    assert first["nextCursor"] == "1"
    assert len(second["items"]) == 1
    assert second["nextCursor"] is None


def test_bootstrap_projects_corrupt_state_as_unknown_and_preserves_owned_state(
    tmp_path: Path,
) -> None:
    current = _old_state(tmp_path, status="running")
    current["runId"] = "run-c0ffee01"
    current["nodes"][0]["status"] = "running"
    current["jobs"] = [
        _job(tmp_path, current["nodes"][0], job_id="#current", status="running")
    ]
    current["jobs"][0]["runId"] = current["runId"]
    current["manifest"] = {"schemaVersion": 1, "runId": current["runId"]}
    foreign = _old_state(tmp_path, status="done")
    foreign["runId"] = "run-f0e16001"
    foreign["project"]["projectId"] = "foreign"
    foreign["manifest"] = {"schemaVersion": 1, "runId": foreign["runId"]}
    store = RunStore(str(tmp_path))
    store.commit(current)
    store.commit(foreign)
    corrupt_dir = Path(store.run_dir("run-c0110071"))
    corrupt_dir.mkdir(parents=True)
    (corrupt_dir / "state.json").write_text("{truncated", encoding="utf-8")
    manager = WorkflowManager(_Emitter())
    owned_ctx = _context(tmp_path, nodes=[_node(status="running")])
    owned_ctx.state["runId"] = current["runId"]
    try:
        with manager._lock:
            manager._runs[current["runId"]] = owned_ctx
        snapshot = manager.bootstrap(
            {"project": _project(tmp_path), "runLimit": 10, "logLimit": 0}
        )
        assert manager.project_active("critical-recovery") is True
        assert manager.active_counts()[0] >= 1
    finally:
        manager._runs.clear()
        manager._unresolved_processes.clear()
        manager.shutdown()
    projected = next(
        run for run in snapshot["runs"] if run["runId"] == current["runId"]
    )
    corrupt = next(run for run in snapshot["runs"] if run["runId"] == "run-c0110071")
    assert projected["status"] == "running"
    assert corrupt["status"] == "unknown"
    assert corrupt["endedAt"] is None
    assert corrupt["durable"] is False
    assert corrupt["summary"]["started"] == 1
    assert all(run["runId"] != foreign["runId"] for run in snapshot["runs"])
    assert store.load(current["runId"])["status"] == "running"


def test_bootstrap_projects_permission_denied_run_index_as_unknown(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = RunStore(str(tmp_path))
    Path(store.runs_root).mkdir(parents=True)

    def verify_index(_store: RunStore) -> None:
        raise PermissionError("Deny the fixture operation.")

    monkeypatch.setattr(RunStore, "verify_index", verify_index)
    manager = WorkflowManager(_Emitter())
    try:
        snapshot = manager.bootstrap(
            {"project": _project(tmp_path), "runLimit": 10, "logLimit": 0}
        )
        assert manager.project_active("critical-recovery") is True
        assert manager.active_counts() == (0, 1)
    finally:
        manager._unresolved_processes.clear()
        manager.shutdown()

    assert len(snapshot["runs"]) == 1
    assert snapshot["runs"][0]["status"] == "unknown"
    assert snapshot["runs"][0]["endedAt"] is None
    assert snapshot["runs"][0]["durable"] is False


def test_bootstrap_republishes_receipts_reports_failure_and_provision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = _old_state(tmp_path, status="done")
    receipt = {
        "signature": "signature",
        "stepKey": "recon",
        "subjectId": "sub-01",
    }
    state["receipts"] = [receipt, {"malformed": True}]
    RunStore(str(tmp_path)).commit(state)
    published: list[dict[str, Any]] = []
    monkeypatch.setattr(RunStore, "get_receipt", lambda *_args: None)

    def publish(_store: RunStore, value: dict[str, Any]) -> None:
        if "signature" not in value:
            raise KeyError("signature")
        published.append(value)

    monkeypatch.setattr(RunStore, "put_receipt", publish)
    manager = WorkflowManager(_Emitter())
    manager.set_provision_status_provider(
        lambda request: {"project": request["project"]}
    )
    try:
        snapshot = manager.bootstrap(
            {"project": _project(tmp_path), "runLimit": 10, "logLimit": 0}
        )
    finally:
        manager.shutdown()
    assert published == [receipt]
    assert snapshot["provision"]["project"]["projectId"] == "critical-recovery"


def test_shutdown_interrupts_active_and_unknown_runs_and_handles_commit_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    interrupted = _node(status="planned")
    unknown = _node("deface", status="unknown")
    first = _context(tmp_path / "first", nodes=[interrupted])
    second = _context(tmp_path / "second", nodes=[unknown])
    second.state["runId"] = "run-bad00002"
    first_job = _job(tmp_path / "first", interrupted, status="running")
    first.state["jobs"] = [first_job]
    manager = WorkflowManager(_Emitter())
    manager._active_jobs[first_job["id"]] = first_job
    monkeypatch.setattr(manager, "cancel_job", lambda _job_id: None)
    commit_calls = 0

    def commit(_ctx: _RunContext) -> None:
        nonlocal commit_calls
        commit_calls += 1
        if commit_calls == 2:
            raise PersistenceError("Fail the simulated disk write.")

    monkeypatch.setattr(manager, "_commit", commit)
    try:
        with manager._wake:
            manager._runs[first.state["runId"]] = first
            manager._runs[second.state["runId"]] = second
        result = manager.shutdown(timeout=0)
    finally:
        manager._active_jobs.clear()

    assert result == {"ok": True, "closing": True, "activeJobs": 1}
    assert interrupted["status"] == "interrupted"
    assert interrupted["reason"] == "The sidecar shut down before this work finished."
    assert first.state["status"] == "interrupted"
    assert unknown["status"] == "unknown"
    assert second.state["status"] == "persistence-error"


def test_shutdown_retries_process_termination_until_jobs_settle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node(status="running")
    job = _job(tmp_path, node, status="running")
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    proc = object()
    ctx.processes[job["id"]] = proc
    manager = WorkflowManager(_Emitter())
    manager._active_jobs[job["id"]] = job
    manager._runs[ctx.state["runId"]] = ctx
    monkeypatch.setattr(manager, "cancel_job", lambda _job_id: None)
    monotonic_values = iter([0.0, 0.0, 2.0, 2.0])
    monkeypatch.setattr(runtime.time, "monotonic", lambda: next(monotonic_values, 2.0))
    monkeypatch.setattr(runtime.time, "sleep", lambda _delay: None)
    terminated: list[tuple[object, bool]] = []
    monkeypatch.setattr(
        runtime,
        "_terminate_tree",
        lambda value, *, force=False: terminated.append((value, force)),
    )
    monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
    result = manager.shutdown(timeout=1)
    manager._active_jobs.clear()
    ctx.processes.clear()
    assert result["closing"] is True
    assert terminated == [(proc, True)]


def _settling_fallback_context(tmp_path: Path) -> tuple[_RunContext, dict[str, Any]]:
    """Return a context whose fallback is settling, ready for activation."""
    node = _node(status="failed")
    job = _job(tmp_path, node, status="running")
    job["backend"] = "freesurfer"
    ctx = _auto_fallback_context(
        tmp_path,
        nodes=[node],
        jobs=[job],
        cohort=_cohort("sub-01"),
    )
    # Mirror what runtime_cfg hands the run: a prepared configuration whose
    # flattened view is cached across every resolution.
    ctx.effective_cfg = paths.PreparedConfig(ctx.effective_cfg)
    ctx.state["reconstructionFallback"] = {
        "state": "settling",
        "fromBackend": "freesurfer",
        "toBackend": "fastsurfer",
        "reasonTag": "algorithm",
        "triggerJobId": job["id"],
        "subjectIds": ["sub-01"],
        "requestedAtMs": 1,
        "activatedAtMs": None,
    }
    return ctx, node


def _resolved_backend_view(ctx: _RunContext) -> str:
    """Return the resolved backend as the flattened view reports it."""
    return paths.flatten(ctx.effective_cfg)["_supraspinaRuntime.resolvedReconBackend"]


def test_fallback_activation_keeps_the_flattened_view_true(tmp_path: Path) -> None:
    # Activation replaces the runtime subtree. A cached flattened view must
    # follow that replacement, or every later resolution reads the backend the
    # run has already moved past.
    ctx, _node_record = _settling_fallback_context(tmp_path)
    manager = WorkflowManager(_Emitter())
    assert _resolved_backend_view(ctx) == "freesurfer"

    manager._activate_auto_fallback(ctx)

    resolved_runtime = ctx.effective_cfg["_supraspinaRuntime"]
    assert resolved_runtime["resolvedReconBackend"] == "fastsurfer"
    assert _resolved_backend_view(ctx) == "fastsurfer"
    assert paths.flatten(ctx.effective_cfg) == paths.flatten(dict(ctx.effective_cfg))


def test_fallback_restore_keeps_the_flattened_view_true(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The restore path returns the run to FreeSurfer when the FastSurfer
    # command cannot be built. That second replacement must reach the
    # flattened view as well.
    ctx, _node_record = _settling_fallback_context(tmp_path)
    manager = WorkflowManager(_Emitter())

    def failing_preview(*_args: Any, **_kwargs: Any) -> list[str]:
        raise RuntimeError("Refuse to build the FastSurfer command.")

    monkeypatch.setattr(runtime.ADAPTERS["recon"], "preview", failing_preview)

    manager._activate_auto_fallback(ctx)

    resolved_runtime = ctx.effective_cfg["_supraspinaRuntime"]
    assert resolved_runtime["resolvedReconBackend"] == "freesurfer"
    assert _resolved_backend_view(ctx) == "freesurfer"
    assert paths.flatten(ctx.effective_cfg) == paths.flatten(dict(ctx.effective_cfg))


#: What recon-all prints when label-cortex finds no gyrus ambiens voxels.
_NO_FIX_GA_OUTPUT = (
    "#@# Cortex Label lh Thu Jan  1 22:15:30 UTC 2026\n",
    "label-cortex --s sub-01 --lh --fix-ga\n",
    "Found 0 label voxels\n",
    "ERROR: found no voxels matching id 1\n",
    "If the error is: found no voxels matching id 1, try rerunning with -no-fix-ga\n",
    "recon-all -s sub-01 exited with ERRORS at Thu Jan  1 22:15:33 UTC 2026\n",
    "To report a problem, see http://surfer.nmr.mgh.harvard.edu/fswiki/BugReporting\n",
)


class _FakeReconAll:
    """Model recon-all for one subject, as the launcher's spawn.

    Every call imports the T1 into ``mri/orig/001.mgz``, as recon-all does
    before any later step. ``outputs`` lists each call's exit code and output;
    a call past its end repeats the last one.
    """

    def __init__(self, root: Path, outputs: list[tuple[int, tuple[str, ...]]]) -> None:
        self.subject_dir = root / "derivatives" / "freesurfer" / "sub-01"
        self.outputs = outputs
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str]) -> _Proc:
        self.calls.append(list(argv))
        orig = self.subject_dir / "mri" / "orig"
        orig.mkdir(parents=True, exist_ok=True)
        (orig / "001.mgz").write_bytes(b"imported")
        rc, stdout = self.outputs[min(len(self.calls), len(self.outputs)) - 1]
        return _Proc(rc=rc, stdout=stdout, pid=404)


def _recon_cfg(root: Path) -> dict[str, Any]:
    return {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(root / "rawdata"),
            "derivativesDir": str(root / "derivatives"),
        },
        "runtime": {"threads": 6},
        "steps": {
            "recon": {
                "enabled": True,
                "params": {"backend": "freesurfer", "directives": "-all"},
            }
        },
    }


def _execute_recon(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    recon_all: _FakeReconAll,
    *,
    cancel_event: threading.Event | None = None,
) -> tuple[_RunContext, dict[str, Any], dict[str, Any], _Emitter]:
    node = _node()
    job = _job(tmp_path, node)
    ctx = _context(tmp_path, nodes=[node], jobs=[job], cfg=_recon_cfg(tmp_path))
    emitter = _Emitter()
    manager = WorkflowManager(emitter, spawn=recon_all)
    _install_execute_basics(manager, monkeypatch)
    monkeypatch.setattr(manager, "announce_process_started", lambda *_args: 405)
    monkeypatch.setattr(manager, "announce_process_settled", lambda *_args: True)
    monkeypatch.setattr(runtime, "_release_spawn", lambda _proc: None)
    monkeypatch.setattr(manager, "_direct_scientific_input_snapshot", lambda *_args: [])
    monkeypatch.setattr(ctx.store, "put_receipt", lambda receipt: receipt)
    try:
        with manager._wake:
            manager._runs[ctx.state["runId"]] = ctx
            manager._active_jobs[job["id"]] = job
        manager._execute(
            ctx, node["nodeId"], job["id"], cancel_event or threading.Event()
        )
    finally:
        manager._runs.clear()
        manager._active_jobs.clear()
        manager.shutdown()
    return ctx, node, job, emitter


def _logged_lines(emitter: _Emitter) -> list[str]:
    return [
        params["line"]
        for method, params in emitter.events
        if method == "pipeline.stdout"
    ]


def test_execute_reruns_recon_once_with_no_fix_ga_and_records_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    recon_all = _FakeReconAll(
        tmp_path, [(1, _NO_FIX_GA_OUTPUT), (0, ("recon-all finished.\n",))]
    )

    ctx, node, job, emitter = _execute_recon(tmp_path, monkeypatch, recon_all)

    first, rerun = recon_all.calls
    assert first[0] == "recon-all"
    assert "-i" in first
    assert "-no-fix-ga" not in first
    # The rerun continues the imported subject: the same command without -i,
    # with -no-fix-ga appended.
    without_import = [
        value
        for index, value in enumerate(first)
        if value != "-i" and (index == 0 or first[index - 1] != "-i")
    ]
    assert rerun == [*without_import, "-no-fix-ga"]
    assert node["status"] == "done"
    assert job["status"] == "done"
    assert job["terminalReason"] == "completed"
    assert job["executionFallback"]["kind"] == "freesurfer-no-fix-ga"
    assert job["executionFallback"]["firstAttemptExitCode"] == 1
    (receipt,) = ctx.state["receipts"]
    # The receipt keeps the plan's signature and records the rerun beside it.
    assert receipt["signature"] == "launch-signature"
    assert receipt["execution_fallback"] == job["executionFallback"]
    line = (
        "recon-all for sub-01 found no gyrus ambiens voxels; the reconstruction "
        "reruns with -no-fix-ga."
    )
    assert line in _logged_lines(emitter)
    log_text = Path(job["stdoutPath"]).read_text(encoding="utf-8")
    assert line in log_text.splitlines()
    assert log_text.endswith("recon-all finished.\n")


def test_execute_fails_with_the_rerun_reason_when_no_fix_ga_also_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rerun_output = (
        "mris_make_surfaces -aseg ../mri/aseg.presurf -white white.preaparc\n",
        "ERROR: could not read surface lh.orig\n",
        "recon-all -s sub-01 exited with ERRORS at Thu Jan  1 23:01:02 UTC 2026\n",
    )
    recon_all = _FakeReconAll(tmp_path, [(1, _NO_FIX_GA_OUTPUT), (1, rerun_output)])

    ctx, node, job, _emitter = _execute_recon(tmp_path, monkeypatch, recon_all)

    assert len(recon_all.calls) == 2
    assert recon_all.calls[1][-1] == "-no-fix-ga"
    assert node["status"] == "failed"
    assert job["status"] == "failed"
    assert ctx.state["receipts"] == []
    # The reason is the rerun's own, from the unchanged adapter.
    expected = runtime.ADAPTERS["recon"].parse_failure(1, "".join(rerun_output), "")
    assert expected is not None
    assert job["terminalReason"] == expected.message
    assert job["failureCause"] == (
        "mris_make_surfaces failed: could not read surface lh.orig"
    )
    assert job["executionFallback"]["kind"] == "freesurfer-no-fix-ga"


def test_execute_does_not_loop_when_the_rerun_asks_for_no_fix_ga_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    recon_all = _FakeReconAll(tmp_path, [(1, _NO_FIX_GA_OUTPUT)])

    _ctx, node, job, _emitter = _execute_recon(tmp_path, monkeypatch, recon_all)

    assert len(recon_all.calls) == 2
    assert node["status"] == "failed"
    assert job["failureCause"] == "label-cortex failed: found no voxels matching id 1"


def test_execute_does_not_rerun_other_recon_failures_and_states_their_cause(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    output = (
        "mri_convert /raw/sub-01_T1w.nii.gz orig/001.mgz\n",
        "ERROR: unsupported input format\n",
        "recon-all -s sub-01 exited with ERRORS at Thu Jan  1 22:15:33 UTC 2026\n",
        "To report a problem, see http://surfer.nmr.mgh.harvard.edu/fswiki/BugReporting\n",
    )
    recon_all = _FakeReconAll(tmp_path, [(1, output)])

    _ctx, node, job, _emitter = _execute_recon(tmp_path, monkeypatch, recon_all)

    assert len(recon_all.calls) == 1
    assert node["status"] == "failed"
    # The recorded reason stays the adapter's, and the cause sits beside it.
    assert job["terminalReason"] == (
        "recon-all -s sub-01 exited with ERRORS at Thu Jan  1 22:15:33 UTC 2026"
    )
    assert job["failureCause"] == "mri_convert failed: unsupported input format"
    assert "executionFallback" not in job


def test_execute_reads_the_no_fix_ga_signature_from_recon_all_log(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _LoggingReconAll(_FakeReconAll):
        def __call__(self, argv: list[str]) -> _Proc:
            proc = super().__call__(argv)
            if len(self.calls) == 1:
                log = self.subject_dir / "scripts" / "recon-all.log"
                log.parent.mkdir(parents=True, exist_ok=True)
                log.write_text("".join(_NO_FIX_GA_OUTPUT), encoding="utf-8")
            return proc

    recon_all = _LoggingReconAll(
        tmp_path,
        [
            (1, ("recon-all -s sub-01 exited with ERRORS at Thu Jan  1\n",)),
            (0, ("recon-all finished.\n",)),
        ],
    )

    _ctx, node, job, _emitter = _execute_recon(tmp_path, monkeypatch, recon_all)

    assert len(recon_all.calls) == 2
    assert node["status"] == "done"
    assert "executionFallback" in job


def test_execute_does_not_rerun_a_cancelled_recon(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cancel_event = threading.Event()
    cancel_event.set()
    terminated: list[Any] = []
    monkeypatch.setattr(
        runtime, "_terminate_tree", lambda proc, **_kw: terminated.append(proc)
    )
    recon_all = _FakeReconAll(tmp_path, [(1, _NO_FIX_GA_OUTPUT)])

    _ctx, node, job, _emitter = _execute_recon(
        tmp_path, monkeypatch, recon_all, cancel_event=cancel_event
    )

    assert len(recon_all.calls) == 1
    assert len(terminated) == 1
    assert node["status"] == "cancelled"
    assert "executionFallback" not in job


def test_execute_without_the_fallback_records_the_same_receipt_as_before(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    recon_all = _FakeReconAll(tmp_path, [(0, ("recon-all finished.\n",))])

    ctx, _node, job, _emitter = _execute_recon(tmp_path, monkeypatch, recon_all)

    assert len(recon_all.calls) == 1
    (receipt,) = ctx.state["receipts"]
    assert receipt["execution_fallback"] is None
    assert "executionFallback" not in job
    assert "failureCause" not in job


#: A recon-all tail in which the genetic topology fixer crashes
#: (FreeSurfer 8.2.0).
_TOPOLOGY_CRASH_OUTPUT = (
    "#@# Fix Topology lh Thu Jan  1 23:12:05 UTC 2026\n",
    " mris_fix_topology -threads 1 -mgz -sphere qsphere.nofix -inflated "
    "inflated.nofix -orig orig.nofix -out orig.premesh -ga -seed 1234 sub-01 lh\n",
    "*** stack smashing detected ***: terminated\n",
    "/usr/local/freesurfer/8.2.0/bin/reconbatchjobs: line 77: 3239019 Aborted"
    "                 (core dumped) exec $JOB >> $LOG 2>&1\n",
    "recon-all -s sub-01 exited with ERRORS at Thu Jan  1 23:28:30 UTC 2026\n",
)
_FINISHED = (0, ("recon-all finished.\n",))
_TOPOLOGY_LINE = (
    "recon-all for sub-01 stopped in the surface topology fix (mris_fix_topology "
    "crashed); the reconstruction reruns with "
)


def _without_import(argv: list[str]) -> list[str]:
    return [
        value
        for index, value in enumerate(argv)
        if value != "-i" and (index == 0 or argv[index - 1] != "-i")
    ]


def test_execute_reruns_recon_once_with_no_fix_with_ga_after_a_topology_crash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    recon_all = _FakeReconAll(tmp_path, [(1, _TOPOLOGY_CRASH_OUTPUT), _FINISHED])

    ctx, node, job, emitter = _execute_recon(tmp_path, monkeypatch, recon_all)

    first, rerun = recon_all.calls
    assert "-no-fix-with-ga" not in first
    assert rerun == [*_without_import(first), "-no-fix-with-ga"]
    assert node["status"] == "done"
    assert job["terminalReason"] == "completed"
    assert job["executionFallback"] == {
        "kind": "freesurfer-no-fix-with-ga",
        "addedArguments": ["-no-fix-with-ga"],
        "reason": (
            "mris_fix_topology crashed in the genetic surface topology fix (-ga), "
            "so recon-all reran with -no-fix-with-ga, which uses the non-genetic "
            "topology fixer."
        ),
        "firstAttemptExitCode": 1,
    }
    (receipt,) = ctx.state["receipts"]
    assert receipt["signature"] == "launch-signature"
    assert receipt["execution_fallback"] == job["executionFallback"]
    line = _TOPOLOGY_LINE + "-no-fix-with-ga."
    assert line in _logged_lines(emitter)
    assert line in Path(job["stdoutPath"]).read_text(encoding="utf-8").splitlines()


def test_execute_reads_the_topology_crash_from_recon_all_log(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _LoggingReconAll(_FakeReconAll):
        def __call__(self, argv: list[str]) -> _Proc:
            proc = super().__call__(argv)
            if len(self.calls) == 1:
                log = self.subject_dir / "scripts" / "recon-all.log"
                log.parent.mkdir(parents=True, exist_ok=True)
                log.write_text("".join(_TOPOLOGY_CRASH_OUTPUT), encoding="utf-8")
            return proc

    recon_all = _LoggingReconAll(
        tmp_path,
        [
            (1, ("recon-all -s sub-01 exited with ERRORS at Thu Jan  1\n",)),
            _FINISHED,
        ],
    )

    _ctx, node, job, _emitter = _execute_recon(tmp_path, monkeypatch, recon_all)

    assert recon_all.calls[1][-1] == "-no-fix-with-ga"
    assert node["status"] == "done"
    assert job["executionFallback"]["kind"] == "freesurfer-no-fix-with-ga"


def test_execute_states_the_topology_crash_when_the_rerun_crashes_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    recon_all = _FakeReconAll(tmp_path, [(1, _TOPOLOGY_CRASH_OUTPUT)])

    ctx, node, job, _emitter = _execute_recon(tmp_path, monkeypatch, recon_all)

    # The rerun shows the same signature again, and a signature reruns once.
    assert len(recon_all.calls) == 2
    assert node["status"] == "failed"
    assert ctx.state["receipts"] == []
    assert job["failureCause"] == (
        "mris_fix_topology failed: stack smashing detected (Aborted, core dumped)"
    )
    assert job["executionFallback"]["addedArguments"] == ["-no-fix-with-ga"]


@pytest.mark.parametrize(
    ("first", "second", "flags"),
    [
        (_NO_FIX_GA_OUTPUT, _TOPOLOGY_CRASH_OUTPUT, ["-no-fix-ga", "-no-fix-with-ga"]),
        (_TOPOLOGY_CRASH_OUTPUT, _NO_FIX_GA_OUTPUT, ["-no-fix-with-ga", "-no-fix-ga"]),
    ],
    ids=["label-cortex-then-topology", "topology-then-label-cortex"],
)
def test_execute_composes_the_reruns_of_two_known_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    first: tuple[str, ...],
    second: tuple[str, ...],
    flags: list[str],
) -> None:
    recon_all = _FakeReconAll(tmp_path, [(1, first), (134, second), _FINISHED])

    ctx, node, job, emitter = _execute_recon(tmp_path, monkeypatch, recon_all)

    initial, rerun, composed = recon_all.calls
    assert rerun == [*_without_import(initial), flags[0]]
    assert composed == [*_without_import(initial), *flags]
    assert node["status"] == "done"
    record = job["executionFallback"]
    assert record["addedArguments"] == flags
    assert record["firstAttemptExitCode"] == 1
    assert [entry["addedArguments"] for entry in record["reruns"]] == [
        [flag] for flag in flags
    ]
    assert [entry["attemptExitCode"] for entry in record["reruns"]] == [1, 134]
    assert record["reason"] == " ".join(entry["reason"] for entry in record["reruns"])
    assert execution_fallback_valid(record)
    (receipt,) = ctx.state["receipts"]
    assert receipt["signature"] == "launch-signature"
    assert receipt["execution_fallback"] == record
    lines = [line for line in _logged_lines(emitter) if "reruns with" in line]
    assert len(lines) == 2
    assert lines[1].endswith(f"reruns with {flags[0]} and {flags[1]}.")


@pytest.mark.parametrize(
    "outputs",
    [
        [_NO_FIX_GA_OUTPUT, _TOPOLOGY_CRASH_OUTPUT, _NO_FIX_GA_OUTPUT],
        [_NO_FIX_GA_OUTPUT, _TOPOLOGY_CRASH_OUTPUT, _TOPOLOGY_CRASH_OUTPUT],
    ],
    ids=["label-cortex-again", "topology-again"],
)
def test_execute_reruns_each_known_failure_at_most_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, outputs: list[tuple[str, ...]]
) -> None:
    recon_all = _FakeReconAll(tmp_path, [(1, output) for output in outputs])

    ctx, node, job, _emitter = _execute_recon(tmp_path, monkeypatch, recon_all)

    assert len(recon_all.calls) == 3
    assert node["status"] == "failed"
    assert ctx.state["receipts"] == []
    assert job["executionFallback"]["addedArguments"] == [
        "-no-fix-ga",
        "-no-fix-with-ga",
    ]


def test_execute_does_not_compose_a_rerun_after_a_cancel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cancel_event = threading.Event()
    terminated: list[Any] = []
    monkeypatch.setattr(
        runtime, "_terminate_tree", lambda proc, **_kw: terminated.append(proc)
    )

    class _CancellingReconAll(_FakeReconAll):
        def __call__(self, argv: list[str]) -> _Proc:
            proc = super().__call__(argv)
            if len(self.calls) == 2:
                cancel_event.set()
            return proc

    recon_all = _CancellingReconAll(
        tmp_path, [(1, _NO_FIX_GA_OUTPUT), (1, _TOPOLOGY_CRASH_OUTPUT), _FINISHED]
    )

    _ctx, node, job, _emitter = _execute_recon(
        tmp_path, monkeypatch, recon_all, cancel_event=cancel_event
    )

    assert len(recon_all.calls) == 2
    assert len(terminated) == 1
    assert node["status"] == "cancelled"
    assert job["executionFallback"]["addedArguments"] == ["-no-fix-ga"]
