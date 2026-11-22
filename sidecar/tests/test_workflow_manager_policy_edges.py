"""Tests for workflow-manager lifecycle, failure-policy, receipt, and readiness behavior."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from supraspina_sidecar import workflow_manager as runtime
from supraspina_sidecar.cohort import CohortSnapshot, T1Resolution
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.provenance import make_receipt
from supraspina_sidecar.recon_fallback import KNOWN_FAILURES, Rerun, fallback_record
from supraspina_sidecar.registry_store import RegistryStore
from supraspina_sidecar.run_store import RunStore
from supraspina_sidecar.workflow import PlannedWorkflow
from supraspina_sidecar.workflow_manager import WorkflowManager, _RunContext


class _Emitter:
    def __init__(self, *, fail: bool = False) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.fail = fail

    def emit(self, method: str, params: dict[str, Any]) -> None:
        if self.fail:
            raise OSError("Treat the renderer as detached.")
        self.events.append((method, params))


def _identity(root: Path) -> ProjectIdentity:
    return ProjectIdentity(
        "workflow-policy",
        str(root.resolve()),
        str((root / "supraspina.project.json").resolve()),
        1,
    )


def _project(root: Path) -> dict[str, Any]:
    return _identity(root).to_dict()


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


def _review_evidence() -> dict[str, Any]:
    return {
        "evidenceVersion": 1,
        "reviewer": "workflow-manager-reviewer",
        "reviewedAt": "2026-07-31T12:00:00.000Z",
        "galleries": [
            {
                "tab": tab,
                "label": label,
                "displayPath": f"outputs/qc/{tab}/report.html",
                "runId": "run-1234abcd",
                "receiptSha256": "a" * 64,
                "openedAt": f"2026-07-31T12:0{index}:00.000Z",
            }
            for index, (tab, label) in enumerate(
                (
                    ("subcortical", "Subcortical QC gallery"),
                    ("internal", "Cortical-internal QC gallery"),
                    ("external", "Cortical-external QC gallery"),
                )
            )
        ],
    }


def test_state_summary_surfaces_blocked_reason_and_noop_outcome() -> None:
    blocked = WorkflowManager._state_summary(
        {
            "status": "queued",
            "nodes": [
                {
                    "status": "blocked",
                    "reason": (
                        "Rerun brainfov before recon because no matching current "
                        "provenance receipt exists."
                    ),
                }
            ],
        }
    )
    noop = WorkflowManager._state_summary(
        {
            "status": "planned",
            "nodes": [{"status": "skipped"}],
        }
    )
    cohort_noop = WorkflowManager._state_summary(
        {
            "status": "planned",
            "nodes": [{"status": "skipped"} for _ in range(100)],
        }
    )
    empty = WorkflowManager._state_summary({"status": "planned", "nodes": []})

    assert blocked["message"] == (
        "Resolve 1 blocked node. Rerun brainfov before recon because no matching "
        "current provenance receipt exists."
    )
    # A no-op plan is stated as a fact, not an order to confirm something.
    assert noop["message"] == "No work is scheduled: the 1 node is current."
    assert cohort_noop["message"] == "No work is scheduled: all 100 nodes are current."
    assert empty["message"] == "No work is scheduled."


def test_state_summary_leads_with_runnable_work_when_a_pass_starts() -> None:
    mixed = WorkflowManager._state_summary(
        {
            "status": "queued",
            "nodes": [
                {"status": "planned"},
                {"status": "waiting"},
                {
                    "status": "blocked",
                    "reason": (
                        "Prepare Clinical merge. Assign registry roles to sub-001."
                    ),
                },
                {
                    "status": "blocked",
                    "reason": (
                        "Resolve blocked dependency clinical: Prepare Clinical merge."
                    ),
                },
            ],
        }
    )
    active = WorkflowManager._state_summary(
        {
            "status": "running",
            "nodes": [
                {"status": "done"},
                {"status": "running"},
                {"status": "blocked", "reason": "Prepare Clinical merge."},
            ],
        }
    )

    assert mixed["message"] == (
        "This pass runs 2 nodes (1 waiting on dependencies); 2 blocked nodes "
        "will not run. Prepare Clinical merge. Assign registry roles to "
        "sub-001. 1 more reason applies."
    )
    assert mixed["planned"] == 2
    assert mixed["waiting"] == 1
    assert mixed["blocked"] == 2
    assert active["message"] == (
        "This pass runs 2 nodes; 1 blocked node will not run. Prepare Clinical merge."
    )


def test_state_summary_counts_the_other_blocked_reasons_as_a_fact() -> None:
    summary = WorkflowManager._state_summary(
        {
            "status": "blocked",
            "nodes": [
                {"status": "blocked", "reason": f"Reason {index}."}
                for index in range(3)
            ],
        }
    )

    assert summary["message"] == (
        "Resolve 3 blocked nodes. Reason 0. 2 more reasons apply."
    )


def test_state_summary_states_a_missing_blocked_reason_as_a_fact() -> None:
    def message(nodes: list[dict[str, Any]], status: str = "blocked") -> str:
        summary = WorkflowManager._state_summary({"status": status, "nodes": nodes})
        return str(summary["message"])

    # The lead-in is the only action; the missing reason is stated, not an
    # order to review something, and the renderer still strips the lead-in.
    assert message([{"status": "blocked"}]) == (
        "Resolve 1 blocked node. The blocked node records no reason."
    )
    assert message([{"status": "blocked", "reason": ""}, {"status": "stale"}]) == (
        "Resolve 2 blocked nodes. The blocked nodes record no reason."
    )
    assert message(
        [{"status": "planned"}, {"status": "withheld"}], status="queued"
    ) == (
        "This pass runs 1 node; 1 blocked node will not run. "
        "The blocked node records no reason."
    )


def test_state_summary_states_an_unblocked_run_status_as_a_fact() -> None:
    def message(status: str) -> str:
        summary = WorkflowManager._state_summary(
            {"status": status, "nodes": [{"status": "planned"}]}
        )
        return str(summary["message"])

    # A state reads as one; an ended run reads as what happened to it.
    assert message("planned") == "The run is planned."
    assert message("queued") == "The run is queued."
    assert message("running") == "The run is running."
    assert message("cancelling") == "The run is being canceled."
    assert message("done") == "The run finished."
    assert message("failed") == "The run failed."
    assert message("cancelled") == "The run was canceled."
    assert message("blocked") == "The run is blocked."
    assert message("interrupted") == "The run was interrupted."
    assert message("persistence-error") == "Supraspina could not persist the run state."
    assert message("unknown") == "The run state is unknown."
    # An unmapped status is still stated, never dropped.
    assert message("settling") == "The run status is settling."


def test_provider_summary_retains_only_bounded_freesurfer_release() -> None:
    report = {
        "groups": [
            {
                "checks": [
                    {
                        "id": "reconall",
                        "status": "found",
                        "detail": (
                            "/usr/local/freesurfer/bin/recon-all "
                            "(release freesurfer-linux-8.2.0); supported"
                        ),
                    },
                    {
                        "id": "license",
                        "status": "found",
                        "detail": "/private/license.txt",
                    },
                ]
            }
        ]
    }

    assert WorkflowManager._provider_summary(report) == {
        "freesurfer": {"version": "freesurfer-linux-8.2.0"}
    }
    assert "/usr/local" not in json.dumps(WorkflowManager._provider_summary(report))
    assert "license" not in json.dumps(WorkflowManager._provider_summary(report))


def test_provider_summary_ignores_malformed_or_unversioned_provider_details() -> None:
    report = {
        "groups": [
            {
                "checks": [
                    {"id": "reconall", "status": "found", "detail": None},
                    {
                        "id": "fshome",
                        "status": "found",
                        "detail": "Find an installation without version metadata.",
                    },
                    {
                        "id": "reconall",
                        "status": "found",
                        "detail": "release  ; supported",
                    },
                ]
            }
        ]
    }

    assert WorkflowManager._provider_summary(report) == {}


def test_recovery_reconciliation_lists_source_scope_qc_decisions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = CohortSnapshot(
        analysis_subject_ids=("sub-pass", "sub-defer", "sub-unreviewed", "sub-new"),
        selected_subject_ids=("sub-pass", "sub-defer", "sub-unreviewed", "sub-new"),
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(),
        qc_verdicts=(
            ("sub-pass", "pass"),
            ("sub-defer", "defer"),
            ("sub-unreviewed", "unreviewed"),
            ("sub-new", "pass"),
        ),
        qc_acknowledged=True,
        excluded_by_config=(),
        excluded_by_qc=(),
    )
    monkeypatch.setattr(
        runtime, "build_cohort_snapshot", lambda *_args, **_kwargs: current
    )

    intent, reconciliation = runtime._resume_intent(
        {
            "kind": "stage",
            "stepKey": "recon",
            "target": {
                "mode": "explicit",
                "subjectIds": [
                    "sub-pass",
                    "sub-defer",
                    "sub-unreviewed",
                    "sub-missing",
                ],
            },
        },
        {},
        {
            "includeDeferredAndUnreviewedQc": False,
            "acknowledgeMemoryAdvisory": False,
        },
        source_analysis_subject_ids=[
            "sub-pass",
            "sub-defer",
            "sub-unreviewed",
            "sub-missing",
        ],
        source_selected_subject_ids=[
            "sub-pass",
            "sub-defer",
            "sub-unreviewed",
            "sub-missing",
        ],
    )

    assert reconciliation is not None
    assert reconciliation["deferredAndUnreviewedSubjectIds"] == [
        "sub-defer",
        "sub-unreviewed",
    ]
    assert reconciliation["retainedSubjectIds"] == ["sub-pass"]
    assert reconciliation["addedSubjectIds"] == ["sub-new"]
    assert intent["target"]["subjectIds"] == ["sub-pass"]


def _node(
    step_key: str = "recon",
    *,
    status: str = "planned",
    subject_id: str | None = "sub-01",
    dependencies: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "nodeId": f"{step_key}:{subject_id or 'cohort'}",
        "stepKey": step_key,
        "subjectId": subject_id,
        "scope": "subject" if subject_id else "cohort",
        "status": status,
        "dependencies": dependencies or [],
    }


def _context(  # noqa: PLR0913
    root: Path,
    *,
    nodes: list[dict[str, Any]] | None = None,
    jobs: list[dict[str, Any]] | None = None,
    cfg: dict[str, Any] | None = None,
    dry_run: bool = False,
    cohort: CohortSnapshot | None = None,
) -> _RunContext:
    snapshot = cohort or _cohort()
    state = {
        "runId": "run-12345678",
        "project": _project(root),
        "config": cfg or {},
        "scope": snapshot.to_dict(),
        "intent": {"kind": "workflow"},
        "nodes": nodes or [],
        "jobs": jobs or [],
        "receipts": [],
        "warnings": [],
        "environmentEvidence": {},
        "failurePolicy": {
            "stopOnError": False,
            "continueIndependentAfterError": True,
        },
        "status": "planned" if dry_run else "queued",
        "dryRun": dry_run,
        "startedAtMs": 1,
        "endedAtMs": None,
    }
    return _RunContext(
        state=state,
        cfg=cfg or {},
        effective_cfg=cfg or {},
        cohort=snapshot,
        project=_identity(root),
        store=RunStore(str(root)),
        queue_limit=1,
    )


def test_supervisor_generation_validation_and_process_notifications(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    emitter = _Emitter()
    manager = WorkflowManager(emitter)
    proc = SimpleNamespace(pid=42)
    monkeypatch.setattr(runtime, "_process_group", lambda _proc: 43)
    monkeypatch.setattr(runtime, "_settle_group", lambda _proc, _pgid: True)
    try:
        manager.attach_supervisor_generation(None)
        assert manager.supervisor_generation is None
        for invalid_generation in (
            -1,
            True,
            1.5,
            "7",
            9_007_199_254_740_992,
        ):
            with pytest.raises(
                ValueError,
                match=r"Provide a safe non-negative supervisor generation\.",
            ):
                manager.attach_supervisor_generation(invalid_generation)

        assert manager.announce_process_started("job-1", proc) == 43
        assert emitter.events[-1][1] == {"jobId": "job-1", "pid": 42, "pgid": 43}
        assert manager.announce_process_settled("job-1", proc, 43) is True
        assert emitter.events[-1][1]["provedStopped"] is True

        manager.attach_supervisor_generation(7)
        manager.announce_process_started("job-2", proc)
        assert emitter.events[-1][1]["generation"] == 7
        manager.announce_process_settled("job-2", proc, 43)
        assert emitter.events[-1][1]["generation"] == 7
        assert manager.sidecar_generation == 7

        invalid = SimpleNamespace(pid=None)
        monkeypatch.setattr(runtime, "_process_group", lambda _proc: None)
        assert manager.announce_process_started("job-invalid", invalid) is None
    finally:
        manager.shutdown()


def test_process_notification_failure_terminates_unowned_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = WorkflowManager(_Emitter(fail=True))
    proc = SimpleNamespace(pid=42)
    terminated: list[tuple[Any, bool]] = []
    monkeypatch.setattr(runtime, "_process_group", lambda _proc: 43)
    monkeypatch.setattr(
        runtime,
        "_terminate_tree",
        lambda value, *, force=False: terminated.append((value, force)),
    )
    try:
        with pytest.raises(
            RuntimeError,
            match=r"Supraspina could not hand process ownership to the main process\.",
        ):
            manager.announce_process_started("job-1", proc)
        assert terminated == [(proc, True)]
    finally:
        manager.shutdown()


def test_unaccepted_process_claim_states_the_outcome_as_a_fact(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A job that ends on these errors records them after the unexpected-error
    # lead, so they read as what happened rather than as orders.
    manager = WorkflowManager(_Emitter())
    proc = SimpleNamespace(pid=42)
    terminated: list[tuple[Any, bool]] = []
    monkeypatch.setattr(runtime, "_PROCESS_CLAIM_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(
        runtime,
        "_terminate_tree",
        lambda value, *, force=False: terminated.append((value, force)),
    )
    try:
        manager.attach_supervisor_generation(7)
        owner = {"claimId": "claim-unaccepted", "pid": 42, "pgid": 42}
        with pytest.raises(
            RuntimeError,
            match=r"^Process ownership was not accepted before the timeout \(0 s\)\.$",
        ):
            manager.announce_process_started(owner, proc)
        assert terminated == [(proc, True)]
        with pytest.raises(
            RuntimeError, match=r"^The process ownership claim was not unique\.$"
        ):
            manager.announce_process_started({**owner, "claimId": ""}, proc)
    finally:
        manager.shutdown()


def test_environment_override_and_request_validation_honor_closing_state(
    tmp_path: Path,
) -> None:
    reports: list[dict[str, Any]] = []
    manager = WorkflowManager(
        _Emitter(), env_check=lambda cfg: reports.append(cfg) or {"ok": True}
    )
    try:
        assert manager._environment({"marker": 1}) == {"ok": True}
        assert reports == [{"marker": 1}]
        identity = manager._validate_request(
            {"project": _project(tmp_path)}, require_cfg=False
        )
        assert identity.project_id == "workflow-policy"
        manager._closing = True
        with pytest.raises(
            RuntimeError, match=r"Wait for the sidecar to finish closing\."
        ):
            manager._validate_request(
                {"project": _project(tmp_path)}, require_cfg=False
            )
        manager._closing = False
    finally:
        manager.shutdown()


def test_environment_default_uses_shared_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(
        "supraspina_sidecar.env.check",
        lambda cfg: {"cfgMarker": cfg.get("marker")},
    )
    try:
        assert manager._environment({"marker": "shared"}) == {"cfgMarker": "shared"}
    finally:
        manager.shutdown()


def _planned(
    nodes: list[dict[str, Any]],
    *,
    cohort: CohortSnapshot | None = None,
    disposition: str = "planned",
) -> PlannedWorkflow:
    summary = {
        "planned": len(nodes),
        "started": 0,
        "waiting": 0,
        "blocked": 0,
        "skipped": 0,
        "message": "planned",
    }
    return PlannedWorkflow(
        result={
            "runId": None,
            "disposition": disposition,
            "plan": {
                "planId": "run-aabbccddeeff",
                "nodes": copy.deepcopy(nodes),
                "blockers": [],
                "scientificEvidence": {},
                "summary": summary,
            },
            "summary": summary,
        },
        cohort=cohort,
        effective_cfg={},
        warnings=(),
    )


def test_plan_reclassifies_runtime_blocked_and_noop_nodes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = {"paths": {"projectRoot": str(tmp_path)}}
    request = {
        "project": _project(tmp_path),
        "cfg": cfg,
        "configRevision": 1,
        "acknowledgements": {},
    }
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    try:
        monkeypatch.setattr(
            runtime, "build_plan", lambda *_args, **_kwargs: _planned([])
        )
        assert manager.plan(request)["disposition"] == "planned"

        blocked = _node(status="blocked")
        monkeypatch.setattr(
            runtime,
            "build_plan",
            lambda *_args, **_kwargs: _planned([blocked], cohort=_cohort()),
        )
        monkeypatch.setattr(manager, "_apply_runtime_policy", lambda _ctx: None)
        monkeypatch.setattr(manager, "_apply_stage_readiness", lambda _ctx: None)
        assert manager.plan(request)["disposition"] == "blocked"

        planned_node = _node(status="planned")
        monkeypatch.setattr(
            runtime,
            "build_plan",
            lambda *_args, **_kwargs: _planned([planned_node], cohort=_cohort()),
        )
        assert manager.plan(request)["disposition"] == "planned"

        skipped = _node(status="skipped")
        monkeypatch.setattr(
            runtime,
            "build_plan",
            lambda *_args, **_kwargs: _planned([skipped], cohort=_cohort()),
        )
        assert manager.plan(request)["disposition"] == "noop"
    finally:
        manager.shutdown()


def test_plan_rejects_an_invalid_planner_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = {
        "project": _project(tmp_path),
        "cfg": {"paths": {"projectRoot": str(tmp_path)}},
        "configRevision": 1,
        "acknowledgements": {},
    }
    planned = _planned([], disposition="noop")
    planned.result["plan"]["planId"] = "plan-invalid"
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    monkeypatch.setattr(runtime, "build_plan", lambda *_args, **_kwargs: planned)
    try:
        with pytest.raises(
            ValueError,
            match=r"Reject the planned workflow because its plan identity is invalid\.",
        ):
            manager.plan(request)
    finally:
        manager.shutdown()


def test_run_requires_reviewed_plan_then_live_authorization_and_blocks_duplicate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = {"paths": {"projectRoot": str(tmp_path)}, "runtime": {"dryRun": False}}
    request = {
        "project": _project(tmp_path),
        "cfg": cfg,
        "configRevision": 1,
        "acknowledgements": {},
    }
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    try:
        planned = _planned([_node()], cohort=_cohort())
        monkeypatch.setattr(
            runtime,
            "build_plan",
            lambda *_args, **_kwargs: planned,
        )
        with pytest.raises(ValueError, match="Review the stale plan again"):
            manager.run(request)
        preview = manager.plan(request)
        request["approvedPlan"] = {
            "planId": preview["plan"]["planId"],
            "digest": preview["plan"]["digest"],
        }
        with pytest.raises(
            PermissionError, match="Provide live-workflow authorization"
        ):
            manager.run(request)

        monkeypatch.setattr(manager, "project_active", lambda _project_id: True)
        with pytest.raises(
            ValueError,
            match=r"Wait for the active workflow to finish before starting another",
        ):
            manager.run(request)
    finally:
        manager.shutdown()


def test_run_start_message_counts_the_jobs_queued_before_the_scheduler_wakes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Take the count before the scheduler wakes, or a worker that has
    # already taken nodes drops them out ("0 jobs queued" for a one-job
    # run).
    cfg = {"paths": {"projectRoot": str(tmp_path)}, "runtime": {"dryRun": False}}
    request = {
        "project": _project(tmp_path),
        "cfg": cfg,
        "configRevision": 1,
        "acknowledgements": {},
    }
    nodes = [
        _node(subject_id="sub-01"),
        _node("enigma", status="waiting", subject_id=None),
        _node("brainfov", status="blocked", subject_id="sub-01"),
    ]
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    monkeypatch.setattr(
        runtime,
        "build_plan",
        lambda *_args, **_kwargs: _planned(nodes, cohort=_cohort()),
    )
    monkeypatch.setattr(manager, "_apply_runtime_policy", lambda _ctx: None)
    monkeypatch.setattr(manager, "_apply_stage_readiness", lambda _ctx: None)
    monkeypatch.setattr(
        manager.authorizations, "consume", lambda *_args, **_kwargs: None
    )
    wake = manager._wake.notify_all

    def scheduler_takes_every_node() -> None:
        # A worker woken by the start takes the run's work before the start
        # returns.
        for ctx in manager._runs.values():
            for node in ctx.state["nodes"]:
                if node["status"] in {"planned", "waiting"}:
                    node["status"] = "running"
        wake()

    try:
        preview = manager.plan(request)
        request["approvedPlan"] = {
            "planId": preview["plan"]["planId"],
            "digest": preview["plan"]["digest"],
        }
        request["liveExecutionAuthorization"] = {
            "planDigest": preview["plan"]["digest"],
        }
        with manager._wake:
            monkeypatch.setattr(manager._wake, "notify_all", scheduler_takes_every_node)
            result = manager.run(request)
            manager._runs.clear()
    finally:
        manager.shutdown()

    assert result["disposition"] == "started"
    assert result["summary"]["message"] == (
        f"Started run {result['runId']}: 2 jobs queued. Watch In flight here "
        "and the output in Logs."
    )


def test_run_dry_noop_does_not_create_a_durable_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = {"paths": {"projectRoot": str(tmp_path)}, "runtime": {"dryRun": True}}
    request = {
        "project": _project(tmp_path),
        "cfg": cfg,
        "configRevision": 1,
        "acknowledgements": {},
    }
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    planned = _planned([], cohort=None, disposition="noop")
    monkeypatch.setattr(
        runtime,
        "build_plan",
        lambda *_args, **_kwargs: planned,
    )
    try:
        preview = manager.plan(request)
        request["approvedPlan"] = {
            "planId": preview["plan"]["planId"],
            "digest": preview["plan"]["digest"],
        }
        result = manager.run(request)
        assert result["disposition"] == "noop"
        assert result["runId"] is None
        assert manager.active_counts() == (0, 0)
    finally:
        manager.shutdown()


def test_approved_plan_and_resource_binding_reject_coercion() -> None:
    valid_plan_id = "run-aabbccddeeff"
    valid_digest = "a" * 64
    invalid = [
        {},
        {"planId": 7, "digest": valid_digest},
        {"planId": "plan-aabbccddeeff", "digest": valid_digest},
        {"planId": valid_plan_id, "digest": 7},
        {"planId": valid_plan_id, "digest": "not-a-sha256"},
    ]
    for approved in invalid:
        with pytest.raises(ValueError, match="Review the stale plan again"):
            WorkflowManager._approved_plan({"approvedPlan": approved})
    assert WorkflowManager._approved_plan(
        {
            "approvedPlan": {
                "planId": valid_plan_id,
                "digest": valid_digest,
            }
        }
    ) == (valid_plan_id, valid_digest)

    assert WorkflowManager._plan_resources(
        {"runtime": None},
        {"availableMemoryGB": True},
    ) == {
        "queueSize": 2,
        "availableMemoryGB": None,
        "memoryWarningGB": 10.0,
        "lowMemory": False,
    }
    assert WorkflowManager._plan_resources(
        {
            "runtime": {
                "queueSize": False,
                "memoryWarningGB": "invalid",
            }
        },
        {"availableMemoryGB": 12.04},
    ) == {
        "queueSize": 2,
        "availableMemoryGB": 12.04,
        "memoryWarningGB": 10.0,
        "lowMemory": False,
    }
    assert WorkflowManager._plan_resources(
        {
            "runtime": {
                "queueSize": 0,
                "memoryWarningGB": 12,
            }
        },
        {"availableMemoryGB": "invalid"},
    ) == {
        "queueSize": 1,
        "availableMemoryGB": None,
        "memoryWarningGB": 12.0,
        "lowMemory": False,
    }


def test_runtime_blocker_deduplication_and_retained_receipt_are_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    blocked = _node(status="blocked")
    blocked["reason"] = "Resolve the integrity check failure: Run the detector again."
    planned = _planned([blocked], cohort=_cohort())
    planned.result["plan"]["blockers"] = [
        {
            "key": "recon",
            "reason": blocked["reason"],
            "kind": "integrity",
        }
    ]
    WorkflowManager._sync_runtime_blockers(planned)
    assert len(planned.result["plan"]["blockers"]) == 1

    reusable = _node(status="planned")
    ctx = _context(tmp_path, nodes=[reusable])
    receipt = {"signature": "same", "stepKey": "recon", "subjectId": "sub-01"}
    ctx.state["receipts"] = [copy.deepcopy(receipt)]
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(manager, "_current_receipt", lambda *_args: receipt)
    try:
        manager._apply_runtime_policy(ctx)
    finally:
        manager.shutdown()
    assert reusable["status"] == "skipped"
    assert ctx.state["receipts"] == [receipt]


def test_stale_reconstruction_dependency_offers_full_cohort_normalization() -> None:
    blocked = _node("features", subject_id=None, status="blocked")
    blocked["reason"] = (
        "Rerun recon before features because no matching current provenance receipt "
        "exists."
    )
    planned = _planned([blocked], cohort=_cohort())

    WorkflowManager._sync_runtime_blockers(planned)

    assert planned.result["plan"]["blockers"] == [
        {
            "key": "features",
            "reason": blocked["reason"],
            "kind": "runtime",
            "action": "normalize-reconstruction-cohort",
        }
    ]


def test_run_rejects_an_already_persisted_review_identity(tmp_path: Path) -> None:
    run_id = "run-010203040506"
    state = _context(tmp_path).state
    state["runId"] = run_id
    RunStore(str(tmp_path)).commit(state)
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    request = {
        "project": _project(tmp_path),
        "cfg": {
            "paths": {"projectRoot": str(tmp_path)},
            "runtime": {"dryRun": True},
        },
        "configRevision": 1,
        "approvedPlan": {"planId": run_id, "digest": "a" * 64},
    }
    try:
        with pytest.raises(ValueError, match=r"^Review the stale plan again\.$"):
            manager.run(request)
    finally:
        manager.shutdown()


def test_authoritative_plan_binds_material_inputs_and_rejects_qc_drift(  # noqa: PLR0915
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = {
        "paths": {"projectRoot": str(tmp_path)},
        "runtime": {
            "dryRun": True,
            "queueSize": 2,
            "memoryWarningGB": 10,
        },
    }
    request = {
        "project": _project(tmp_path),
        "cfg": cfg,
        "configRevision": 1,
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "acknowledgements": {},
    }
    memory = {"value": 8.241}
    manager = WorkflowManager(
        _Emitter(),
        env_check=lambda _cfg: {
            "groups": [
                {
                    "name": "runtime",
                    "checks": [{"id": "tool", "status": "ok", "detail": "tool-v1"}],
                }
            ],
            "availableMemoryGB": memory["value"],
        },
    )

    def planned_factory(
        _request: dict[str, Any],
        *,
        run_id: str | None = None,
        env_report: dict[str, Any] | None = None,
    ) -> PlannedWorkflow:
        del env_report
        planned = _planned([_node()], cohort=_cohort())
        planned.result["plan"]["planId"] = run_id or "run-aabbccddeeff"
        return planned

    monkeypatch.setattr(runtime, "build_plan", planned_factory)
    monkeypatch.setattr(manager, "_apply_runtime_policy", lambda _ctx: None)
    monkeypatch.setattr(manager, "_apply_stage_readiness", lambda _ctx: None)
    try:
        baseline = manager.plan(request)["plan"]
        assert re.fullmatch(r"run-[a-f0-9]{12}", baseline["planId"])
        for key in (
            "digest",
            "configDigest",
            "qcDigest",
            "registryDigest",
            "environmentDigest",
        ):
            assert re.fullmatch(r"[a-f0-9]{64}", baseline[key])
        assert baseline["resources"] == {
            "queueSize": 2,
            "availableMemoryGB": 8.241,
            "memoryWarningGB": 10.0,
            "lowMemory": True,
        }
        assert baseline["exclusions"] == {
            "qcFailedSubjectIds": [],
            "configExcludedSubjectIds": [],
        }

        memory["value"] = 8.249
        jitter = manager.plan(request)["plan"]
        assert jitter["resources"]["availableMemoryGB"] == 8.249
        assert jitter["environmentDigest"] == baseline["environmentDigest"]
        assert jitter["digest"] == baseline["digest"]

        changed_cfg = copy.deepcopy(request)
        changed_cfg["cfg"]["runtime"]["queueSize"] = 3
        config_plan = manager.plan(changed_cfg)["plan"]
        assert config_plan["configDigest"] != baseline["configDigest"]

        qc_path = tmp_path / ".supraspina" / "qc_verdicts.json"
        qc_path.parent.mkdir(parents=True, exist_ok=True)
        qc_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "verdicts": {
                        "sub-01": {
                            "verdict": "pass",
                            "note": "reviewed",
                            "tags": [],
                            "reviewEvidence": _review_evidence(),
                            "revision": 1,
                            "updatedAt": "2026-07-23T12:00:00.000Z",
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        qc_plan = manager.plan(request)["plan"]
        assert qc_plan["qcDigest"] != baseline["qcDigest"]

        RegistryStore(str(tmp_path)).upsert(
            {
                "subjectId": "sub-01",
                "age": 31,
                "sex": "F",
                "sourceCohortLabel": "SCI",
            }
        )
        registry_plan = manager.plan(request)["plan"]
        assert registry_plan["registryDigest"] != qc_plan["registryDigest"]

        memory["value"] = 7.9
        same_band_plan = manager.plan(request)["plan"]
        assert same_band_plan["environmentDigest"] == registry_plan["environmentDigest"]
        assert same_band_plan["digest"] == registry_plan["digest"]

        memory["value"] = 10.1
        environment_plan = manager.plan(request)["plan"]
        assert (
            environment_plan["environmentDigest"] != same_band_plan["environmentDigest"]
        )
        assert environment_plan["digest"] != same_band_plan["digest"]

        request["approvedPlan"] = {
            "planId": environment_plan["planId"],
            "digest": environment_plan["digest"],
        }
        document = json.loads(qc_path.read_text(encoding="utf-8"))
        document["verdicts"]["sub-01"]["note"] = "changed after review"
        document["verdicts"]["sub-01"]["revision"] = 2
        qc_path.write_text(json.dumps(document), encoding="utf-8")
        with pytest.raises(ValueError, match=r"^Review the stale plan again\.$"):
            manager.run(request)
        assert RunStore(str(tmp_path)).run_ids() == []
    finally:
        manager.shutdown()


def test_accepted_dry_run_persists_terminal_jobs_without_active_work(  # noqa: PLR0915
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = {
        "paths": {"projectRoot": str(tmp_path)},
        "runtime": {"dryRun": True, "queueSize": 1},
    }
    request = {
        "project": _project(tmp_path),
        "cfg": cfg,
        "configRevision": 1,
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "acknowledgements": {},
    }
    command = "recon-all -sd /derivatives/freesurfer -s sub-01 -all"
    spawned: list[list[str]] = []
    memory = {"value": 8.2}
    manager = WorkflowManager(
        _Emitter(),
        spawn=spawned.append,
        env_check=lambda _cfg: {
            "groups": [],
            "availableMemoryGB": memory["value"],
        },
    )

    def planned_factory(
        _request: dict[str, Any],
        *,
        run_id: str | None = None,
        env_report: dict[str, Any] | None = None,
    ) -> PlannedWorkflow:
        del env_report
        node = _node()
        node["command"] = command
        node["backend"] = "freesurfer"
        node["attemptOrdinal"] = 1
        node["role"] = "primary"
        planned = _planned([node], cohort=_cohort())
        planned.result["plan"]["planId"] = run_id or "run-acde1234beef"
        return planned

    monkeypatch.setattr(runtime, "build_plan", planned_factory)
    monkeypatch.setattr(manager, "_apply_runtime_policy", lambda _ctx: None)
    monkeypatch.setattr(manager, "_apply_stage_readiness", lambda _ctx: None)
    try:
        preview = manager.plan(request)
        request["approvedPlan"] = {
            "planId": preview["plan"]["planId"],
            "digest": preview["plan"]["digest"],
        }
        memory["value"] = 6.75

        result = manager.run(request)

        assert result["disposition"] == "planned"
        assert result["runId"] == preview["plan"]["planId"]
        assert spawned == []
        assert manager.active_counts() == (0, 0)
        assert manager._runs == {}
    finally:
        manager.shutdown()

    state = RunStore(str(tmp_path)).load(preview["plan"]["planId"])
    assert state["status"] == "planned"
    assert state["terminalReason"] == "dry_run"
    assert state["endedAtMs"] is not None
    assert state["planBinding"]["resources"]["availableMemoryGB"] == 6.75
    assert state["receipts"] == []
    assert len(state["jobs"]) == 1
    job = state["jobs"][0]
    assert job["status"] == "planned"
    assert job["dryRun"] is True
    assert job["terminalReason"] == "dry_run"
    assert job["cmd"] == command
    assert job["stdoutPath"] == ""
    assert job["stderrPath"] == ""
    assert job["backend"] == "freesurfer"
    assert job["attemptOrdinal"] == 1
    assert job["role"] == "primary"
    assert not (tmp_path / ".supraspina" / "runs" / result["runId"] / "logs").exists()

    restored_manager = WorkflowManager(_Emitter())
    try:
        restored = restored_manager.bootstrap(
            {"project": _project(tmp_path), "runLimit": 10, "logLimit": 10}
        )
    finally:
        restored_manager.shutdown()
    assert restored["runs"][0]["status"] == "planned"
    assert restored["jobs"][0]["status"] == "planned"
    assert restored["jobs"][0]["cmd"] == command
    assert restored["logTail"] == []


def test_new_job_copies_optional_backend_attempt_lineage(tmp_path: Path) -> None:
    node = _node()
    node.update(
        {
            "backend": "fastsurfer",
            "attemptOrdinal": 2,
            "role": "fallback",
            "supersedesJobId": "#prior",
            "fallbackReasonTag": "freesurfer_topology_failure",
        }
    )
    ctx = _context(tmp_path, nodes=[node])
    manager = WorkflowManager(_Emitter())
    try:
        job = manager._new_job(ctx, node)
        first = manager._new_job(ctx, _node())
    finally:
        manager.shutdown()

    assert {
        key: job[key]
        for key in (
            "backend",
            "attemptOrdinal",
            "role",
            "supersedesJobId",
            "fallbackReasonTag",
        )
    } == {
        "backend": "fastsurfer",
        "attemptOrdinal": 2,
        "role": "fallback",
        "supersedesJobId": "#prior",
        "fallbackReasonTag": "freesurfer_topology_failure",
    }

    assert {key: first[key] for key in ("backend", "attemptOrdinal", "role")} == {
        "backend": "freesurfer",
        "attemptOrdinal": 1,
        "role": "primary",
    }


def test_live_authorization_plan_digest_must_match_before_consumption(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = {"paths": {"projectRoot": str(tmp_path)}, "runtime": {"dryRun": False}}
    request = {
        "project": _project(tmp_path),
        "cfg": cfg,
        "configRevision": 1,
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "acknowledgements": {},
    }
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})

    def planned_factory(
        _request: dict[str, Any],
        *,
        run_id: str | None = None,
        env_report: dict[str, Any] | None = None,
    ) -> PlannedWorkflow:
        del env_report
        planned = _planned([_node()], cohort=_cohort())
        planned.result["plan"]["planId"] = run_id or "run-bbccddeeff00"
        return planned

    monkeypatch.setattr(runtime, "build_plan", planned_factory)
    monkeypatch.setattr(manager, "_apply_runtime_policy", lambda _ctx: None)
    monkeypatch.setattr(manager, "_apply_stage_readiness", lambda _ctx: None)
    try:
        preview = manager.plan(request)["plan"]
        request["approvedPlan"] = {
            "planId": preview["planId"],
            "digest": preview["digest"],
        }
        request["liveExecutionAuthorization"] = {
            "planDigest": "0" * 64,
        }
        with pytest.raises(ValueError, match=r"^Review the stale plan again\.$"):
            manager.run(request)
        assert RunStore(str(tmp_path)).run_ids() == []
    finally:
        manager.shutdown()


def test_detector_exception_is_a_visible_integrity_blocker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _FailingDetector:
        def detect(self, _cfg: dict[str, Any], _subject_id: str | None) -> Any:
            raise RuntimeError("Expose private detector detail.")

    request = {
        "project": _project(tmp_path),
        "cfg": {
            "paths": {"projectRoot": str(tmp_path)},
            "runtime": {"dryRun": True},
        },
        "configRevision": 1,
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "acknowledgements": {},
    }
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    planned = _planned([_node()], cohort=_cohort())
    monkeypatch.setattr(runtime, "build_plan", lambda *_args, **_kwargs: planned)
    monkeypatch.setattr(manager, "_current_receipt", lambda *_args: None)
    monkeypatch.setitem(runtime.ADAPTERS, "recon", _FailingDetector())
    try:
        result = manager.plan(request)
    finally:
        manager.shutdown()

    node = result["plan"]["nodes"][0]
    assert result["disposition"] == "blocked"
    assert node["status"] == "blocked"
    assert node["reason"] == (
        "Resolve the integrity check failure: Run the detector again after "
        "RuntimeError."
    )
    assert result["plan"]["blockers"] == [
        {
            "key": "recon",
            "reason": (
                "Resolve the integrity check failure: Run the detector again after "
                "RuntimeError."
            ),
            "kind": "integrity",
        }
    ]
    assert "Expose private detector detail." not in json.dumps(result)


def test_current_receipt_requires_a_signature_valid_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = WorkflowManager(_Emitter())
    ctx = _context(tmp_path, nodes=[_node()])
    node = ctx.state["nodes"][0]
    receipt = {
        "stepKey": "recon",
        "subjectId": "sub-01",
        "signature": "signature",
        "detectorEvidence": {"state": "done", "identity": "same"},
    }
    ctx.state["receipts"] = [receipt]
    monkeypatch.setattr(
        manager, "_expected", lambda *_args: ("signature", {"payload": True})
    )
    monkeypatch.setattr(
        runtime,
        "receipt_signature_valid",
        lambda value, signature: value["signature"] == signature,
    )
    monkeypatch.setattr(
        runtime,
        "detector_evidence",
        lambda *_args: {"state": "done", "identity": "same"},
    )
    monkeypatch.setattr(
        runtime, "enrich_evidence", lambda _key, evidence, *_args: evidence
    )
    monkeypatch.setattr(
        runtime, "evidence_is_done", lambda evidence: evidence.get("state") == "done"
    )
    monkeypatch.setattr(
        runtime, "evidence_identity", lambda evidence: evidence.get("identity")
    )
    try:
        assert manager._current_receipt(ctx, node) is receipt

        ctx.state["receipts"] = []
        monkeypatch.setattr(ctx.store, "get_receipt", lambda *_args: None)
        assert manager._current_receipt(ctx, node) is None
    finally:
        manager.shutdown()


def _receipt_cohort(
    *,
    analysis_digest: str,
    selected_digest: str,
    verdict: str,
    acknowledged: bool,
) -> CohortSnapshot:
    return CohortSnapshot(
        analysis_subject_ids=("sub-01",),
        selected_subject_ids=("sub-01",),
        analysis_digest=analysis_digest,
        selected_digest=selected_digest,
        t1=(
            T1Resolution(
                subject_id="sub-01",
                state="resolved",
                path="/raw/sub-01/anat/sub-01_T1w.nii.gz",
                candidates=(),
                fingerprint="t1-sub-01",
            ),
        ),
        qc_verdicts=(("sub-01", verdict),),
        qc_acknowledged=acknowledged,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def _receipt_cfg(root: Path) -> dict[str, Any]:
    return {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": "/raw",
            "derivativesDir": str(root / "derivatives"),
        },
        "runtime": {"resumeCompleted": True, "rerunIncomplete": False},
        "steps": {
            "recon": {
                "enabled": True,
                "params": {"backend": "freesurfer", "directives": "-all"},
            }
        },
        "_supraspinaRuntime": {},
    }


def test_subject_receipt_stays_current_after_qc_and_stale_lineage_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = _receipt_cohort(
        analysis_digest="analysis-before-qc",
        selected_digest="selected-before-qc",
        verdict="unreviewed",
        acknowledged=True,
    )
    after = _receipt_cohort(
        analysis_digest="analysis-after-qc",
        selected_digest="selected-after-qc",
        verdict="pass",
        acknowledged=False,
    )
    cfg = _receipt_cfg(tmp_path)
    node = _node("recon", subject_id="sub-01")
    before_ctx = _context(tmp_path, nodes=[copy.deepcopy(node)], cfg=cfg, cohort=before)
    after_ctx = _context(tmp_path, nodes=[copy.deepcopy(node)], cfg=cfg, cohort=after)
    manager = WorkflowManager(_Emitter())
    current_signature, current_payload = manager._expected(
        before_ctx, "recon", "sub-01"
    )
    stale_cfg = copy.deepcopy(cfg)
    stale_cfg["steps"]["recon"]["params"]["directives"] = "-autorecon1"
    stale_ctx = _context(
        tmp_path, nodes=[copy.deepcopy(node)], cfg=stale_cfg, cohort=before
    )
    stale_signature, stale_payload = manager._expected(stale_ctx, "recon", "sub-01")
    evidence = {"state": "done", "artifacts": []}
    current = make_receipt(
        current_signature,
        current_payload,
        evidence,
        run_id="run-current1",
        job_id="#current1",
        committed_at_ms=11,
    )
    stale = make_receipt(
        stale_signature,
        stale_payload,
        evidence,
        run_id="run-stale002",
        job_id="#stale002",
        committed_at_ms=9,
    )
    monkeypatch.setattr(runtime, "detector_evidence", lambda *_args: evidence)
    monkeypatch.setattr(runtime, "enrich_evidence", lambda _key, value, *_args: value)
    try:
        after_ctx.store.put_receipt(current)
        assert manager._current_receipt(after_ctx, after_ctx.state["nodes"][0]) == (
            current
        )

        current_path = after_ctx.store.receipt_path(
            "recon", "sub-01", current_signature
        )
        Path(current_path).unlink()
        after_ctx.store.put_receipt(stale)
        assert manager._current_receipt(after_ctx, after_ctx.state["nodes"][0]) is None

        after_ctx.forced_retry_identities.add(("recon", "sub-01"))
        manager._apply_runtime_policy(after_ctx)
        assert after_ctx.state["nodes"][0]["status"] == "planned"
    finally:
        manager.shutdown()


def test_runtime_policy_reuses_receipt_blocks_partial_and_respects_rerun(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    nodes = [
        _node("recon", subject_id="sub-01"),
        _node("deface", subject_id="sub-01"),
        _node("age", subject_id=None, status="blocked"),
    ]
    ctx = _context(tmp_path, nodes=nodes, cfg={"runtime": {"resumeCompleted": True}})
    manager = WorkflowManager(_Emitter())
    receipt = {"signature": "current"}
    monkeypatch.setattr(
        manager,
        "_current_receipt",
        lambda _ctx, node: receipt if node["stepKey"] == "recon" else None,
    )
    monkeypatch.setattr(
        runtime,
        "detector_evidence",
        lambda adapter, *_args: {
            "state": "partial"
            if adapter is runtime.ADAPTERS.get("deface")
            else "pending"
        },
    )
    try:
        manager._apply_runtime_policy(ctx)
        assert nodes[0]["status"] == "skipped"
        assert nodes[0]["reason"] == "The current detector-backed receipt is reused."
        assert ctx.state["receipts"] == [receipt]
        assert nodes[1]["status"] == "blocked"
        assert "rerunIncomplete" in nodes[1]["reason"]
        assert nodes[2]["status"] == "blocked"

        rerun = _context(
            tmp_path,
            nodes=[_node("deface")],
            cfg={"runtime": {"resumeCompleted": False, "rerunIncomplete": True}},
        )
        manager._apply_runtime_policy(rerun)
        assert rerun.state["nodes"][0]["status"] == "planned"
    finally:
        manager.shutdown()


def test_runtime_policy_blocks_complete_recon_without_current_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sentinel = tmp_path / "freesurfer" / "sub-01" / "scripts" / "recon-all.done"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_bytes(b"historical reconstruction\n")
    node = _node("recon", subject_id="sub-01")
    ctx = _context(
        tmp_path,
        nodes=[node],
        cfg={
            "runtime": {
                "resumeCompleted": False,
                "rerunIncomplete": True,
            }
        },
    )
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(manager, "_current_receipt", lambda *_args: None)
    monkeypatch.setattr(
        runtime,
        "detector_evidence",
        lambda *_args: {
            "state": "done",
            "detail": "Complete FreeSurfer reconstruction.",
            "artifacts": [],
        },
    )
    try:
        manager._apply_runtime_policy(ctx)
    finally:
        manager.shutdown()

    assert node["status"] == "blocked"
    assert node["reason"] == (
        "Choose a fresh derivatives namespace because detector-complete "
        "Reconstruction output has no matching current receipt; preserve the "
        "existing tree."
    )
    assert ctx.state["warnings"] == [node["reason"]]
    assert sentinel.read_bytes() == b"historical reconstruction\n"


def test_runtime_policy_allows_explicit_rerun_with_current_recon_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node("recon", subject_id="sub-01")
    ctx = _context(
        tmp_path,
        nodes=[node],
        cfg={"runtime": {"resumeCompleted": False}},
    )
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(
        manager,
        "_current_receipt",
        lambda *_args: {"signature": "current"},
    )
    monkeypatch.setattr(
        runtime,
        "detector_evidence",
        lambda *_args: {
            "state": "done",
            "detail": "Complete FreeSurfer reconstruction.",
            "artifacts": [],
        },
    )
    try:
        manager._apply_runtime_policy(ctx)
    finally:
        manager.shutdown()

    assert node["status"] == "planned"
    assert node["reason"] == "Reuse of completed work is off in project configuration."


def test_runtime_policy_says_a_forced_retry_node_is_selected_for_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node("recon", subject_id="sub-01")
    ctx = _context(tmp_path, nodes=[node])
    ctx.forced_retry_identities.add(("recon", "sub-01"))
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(
        runtime,
        "detector_evidence",
        lambda *_args: {"state": "failed", "detail": "", "artifacts": []},
    )
    try:
        manager._apply_runtime_policy(ctx)
    finally:
        manager.shutdown()

    assert node["status"] == "planned"
    assert node["reason"] == "It is selected for retry."


def test_stage_readiness_maps_block_wait_and_ignores_workflow_nodes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = WorkflowManager(_Emitter())
    nodes = [
        _node("recon"),
        _node("deface"),
        _node("age", status="blocked", subject_id=None),
    ]
    ctx = _context(tmp_path, nodes=nodes)
    try:
        manager._apply_stage_readiness(ctx)
        assert [node["status"] for node in nodes] == ["planned", "planned", "blocked"]

        ctx.state["intent"] = {"kind": "stage"}
        monkeypatch.setattr(
            manager,
            "_readiness",
            lambda _ctx, node, _by_id: (
                ("blocked", "dependency failed")
                if node["stepKey"] == "recon"
                else ("wait", None)
            ),
        )
        manager._apply_stage_readiness(ctx)
        assert nodes[0]["status"] == "blocked"
        assert nodes[0]["reason"] == "dependency failed"
        assert nodes[1]["status"] == "waiting"
        assert nodes[2]["status"] == "blocked"
    finally:
        manager.shutdown()


def test_tick_applies_stop_policy_to_queued_and_unscheduled_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    failed = _node("recon", status="failed")
    queued = _node("deface", status="queued")
    planned = _node("age", status="planned", subject_id=None)
    job = {
        "id": "job-queued",
        "nodeId": queued["nodeId"],
        "status": "queued",
    }
    ctx = _context(tmp_path, nodes=[failed, queued, planned], jobs=[job])
    ctx.state["failurePolicy"] = {
        "stopOnError": True,
        "continueIndependentAfterError": True,
    }
    manager = WorkflowManager(_Emitter())
    manager._active_jobs[job["id"]] = job
    monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
    monkeypatch.setattr(manager, "_emit_job", lambda *_args: None)
    monkeypatch.setattr(manager, "_emit_run", lambda *_args: None)
    try:
        assert manager._tick(ctx) is True
        assert queued["status"] == "withheld"
        assert planned["status"] == "withheld"
        assert job["status"] == "withheld"
        assert job["terminalReason"] == "failure_policy_withheld"
        # The node reason states what happened; it is not an order.
        assert (
            queued["reason"]
            == planned["reason"]
            == ("Withheld by the failure policy after an earlier failure.")
        )
        assert job["id"] not in manager._active_jobs
    finally:
        manager._active_jobs.clear()
        manager.shutdown()


def test_tick_wait_block_queue_and_queue_cap_transitions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = WorkflowManager(_Emitter())
    emitted_jobs: list[dict[str, Any]] = []
    monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
    monkeypatch.setattr(
        manager, "_emit_job", lambda _ctx, job: emitted_jobs.append(job)
    )
    monkeypatch.setattr(manager, "_emit_run", lambda *_args: None)
    try:
        waiting = _context(tmp_path, nodes=[_node()])
        monkeypatch.setattr(manager, "_readiness", lambda *_args: ("wait", None))
        assert manager._tick(waiting) is False
        assert waiting.state["nodes"][0]["status"] == "waiting"

        blocked = _context(tmp_path, nodes=[_node()])
        monkeypatch.setattr(
            manager, "_readiness", lambda *_args: ("blocked", "dynamic blocker")
        )
        assert manager._tick(blocked) is True
        assert blocked.state["nodes"][0]["status"] == "blocked"
        # The block must leave a durable terminal job so the job-driven
        # surfaces can show the reason the run stopped.
        assert len(blocked.state["jobs"]) == 1
        blocked_job = blocked.state["jobs"][0]
        assert blocked_job["status"] == "blocked"
        assert blocked_job["terminalReason"] == "dynamic blocker"
        assert blocked_job["durable"] is True
        assert blocked_job["persistenceStatus"] == "durable"
        assert blocked_job["startedAt"] is None
        assert blocked_job["endedAt"] is not None
        assert emitted_jobs == [blocked_job]
        emitted_jobs.clear()

        queued = _context(tmp_path, nodes=[_node()])
        monkeypatch.setattr(manager, "_readiness", lambda *_args: ("ready", None))
        assert manager._tick(queued) is True
        assert queued.state["nodes"][0]["status"] == "queued"

        dry = _context(tmp_path, nodes=[], dry_run=True)
        monkeypatch.setattr(manager, "_finish_run_if_terminal", lambda _ctx: True)
        assert manager._tick(dry) is False
        assert len(queued.state["jobs"]) == 1

        manager._runs["active"] = _context(tmp_path)
        manager._runs["active"].state["jobs"] = [{"status": "running"}]
        queued.queue_limit = 1
        monkeypatch.setattr(manager, "_finish_run_if_terminal", lambda _ctx: False)
        assert manager._tick(queued) is False
        assert queued.state["nodes"][0]["status"] == "queued"
    finally:
        manager._runs.clear()
        manager._active_jobs.clear()
        manager.shutdown()


def test_tick_persists_running_run_before_starting_worker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node("deface", status="queued")
    job = {
        "id": "#queued-job",
        "nodeId": node["nodeId"],
        "status": "queued",
        "startedAt": None,
        "durable": True,
    }
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    events: list[tuple[str, str, str, str]] = []

    class _Thread:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def start(self) -> None:
            events.append(
                (
                    "start",
                    str(ctx.state["status"]),
                    str(node["status"]),
                    str(job["status"]),
                )
            )

    manager = WorkflowManager(_Emitter())
    manager._active_jobs[job["id"]] = job
    monkeypatch.setattr(runtime.threading, "Thread", _Thread)
    monkeypatch.setattr(
        manager,
        "_commit",
        lambda current: events.append(
            (
                "commit",
                str(current.state["status"]),
                str(node["status"]),
                str(job["status"]),
            )
        ),
    )
    monkeypatch.setattr(manager, "_emit_job", lambda *_args: None)
    try:
        assert manager._tick(ctx) is True
    finally:
        manager._active_jobs.clear()
        manager.shutdown()

    assert events == [
        ("commit", "running", "running", "running"),
        ("start", "running", "running", "running"),
    ]


def test_tick_emits_running_run_snapshot_when_first_job_starts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    node = _node("deface", status="queued")
    job = {
        "id": "#queued-job",
        "nodeId": node["nodeId"],
        "status": "queued",
        "startedAt": None,
        "durable": True,
    }
    ctx = _context(tmp_path, nodes=[node], jobs=[job])
    assert ctx.state["status"] == "queued"

    class _Thread:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def start(self) -> None:
            pass

    emitter = _Emitter()
    manager = WorkflowManager(emitter)
    manager._active_jobs[job["id"]] = job
    monkeypatch.setattr(runtime.threading, "Thread", _Thread)
    monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
    try:
        assert manager._tick(ctx) is True
    finally:
        manager._active_jobs.clear()
        manager.shutdown()

    runtime_events = [
        params for method, params in emitter.events if method == "runtime.event"
    ]
    assert [event["kind"] for event in runtime_events] == ["job", "run"]
    assert runtime_events[0]["job"]["status"] == "running"
    run_event = runtime_events[1]
    assert run_event["runId"] == ctx.state["runId"]
    assert run_event["run"]["status"] == "running"
    assert run_event["sequence"] > runtime_events[0]["sequence"]


def test_readiness_accepts_disabled_predecessor_with_current_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    predecessor = _node("recon", status="skipped")
    consumer = _node("enigma", subject_id=None, dependencies=[predecessor["nodeId"]])
    ctx = _context(tmp_path, nodes=[predecessor, consumer])
    ctx.state["receipts"] = [
        {
            "stepKey": "recon",
            "subjectId": "sub-01",
            "signature": "current",
            "detectorEvidence": {"state": "done", "identity": "detector"},
            "edgeEvidence": {"enigma": {"state": "done", "identity": "edge"}},
        }
    ]
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(manager, "_expected", lambda *_args: ("current", {}))
    monkeypatch.setattr(runtime, "receipt_signature_valid", lambda *_args: True)
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
    try:
        readiness, reason = manager._readiness(
            ctx,
            consumer,
            {predecessor["nodeId"]: predecessor, consumer["nodeId"]: consumer},
        )
        assert readiness == "ready"
        assert reason is None
    finally:
        manager.shutdown()


def test_readiness_waits_for_active_dependencies_and_blocks_failed_dependencies(
    tmp_path: Path,
) -> None:
    manager = WorkflowManager(_Emitter())
    active = _node("recon", status="running")
    consumer = _node("enigma", subject_id=None, dependencies=[active["nodeId"]])
    ctx = _context(tmp_path, nodes=[active, consumer])
    try:
        assert manager._readiness(
            ctx, consumer, {active["nodeId"]: active, consumer["nodeId"]: consumer}
        ) == ("wait", None)

        active["status"] = "failed"
        readiness, reason = manager._readiness(
            ctx, consumer, {active["nodeId"]: active, consumer["nodeId"]: consumer}
        )
        assert readiness == "blocked"
        assert reason == "Reconstruction failed, so this step did not run."
    finally:
        manager.shutdown()


@pytest.mark.parametrize(
    ("status", "reason"),
    [
        ("failed", "Reconstruction failed, so this step did not run."),
        ("cancelled", "Reconstruction was canceled, so this step did not run."),
        ("blocked", "Reconstruction was blocked, so this step did not run."),
        (
            "withheld",
            "Reconstruction was withheld by the failure policy, so this step "
            "did not run.",
        ),
        ("interrupted", "Reconstruction was interrupted, so this step did not run."),
        (
            "stale",
            "Reconstruction has an unknown run state, so this step did not run.",
        ),
    ],
)
def test_readiness_states_each_unfinished_dependency_as_a_fact(
    tmp_path: Path, status: str, reason: str
) -> None:
    # The reason must not read "Resolve dependency recon because it ended
    # failed.", an order naming the raw stage key.
    manager = WorkflowManager(_Emitter())
    dependency = _node("recon", status=status)
    consumer = _node("enigma", subject_id=None, dependencies=[dependency["nodeId"]])
    ctx = _context(tmp_path, nodes=[dependency, consumer])
    try:
        assert manager._readiness(
            ctx,
            consumer,
            {dependency["nodeId"]: dependency, consumer["nodeId"]: consumer},
        ) == ("blocked", reason)
    finally:
        manager.shutdown()


class _ReasonlessNode(dict[str, Any]):
    """Fail any read of a node's reason, to prove a code path never reads it."""

    def __getitem__(self, key: str) -> Any:
        assert key != "reason", "Read no node reason on this path."
        return super().__getitem__(key)

    def get(self, key: str, default: Any = None) -> Any:
        assert key != "reason", "Read no node reason on this path."
        return super().get(key, default)


def test_a_scheduler_block_is_run_state_only_and_writes_no_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The blocked-dependency reason must stay out of every receipt,
    # reuse rule, and plan binding, so rewording it changes no identity.
    failed = _node("recon", status="failed")
    dependent = _node("enigma", subject_id=None, dependencies=[failed["nodeId"]])
    ctx = _context(tmp_path, nodes=[failed, dependent])
    binding = {"planId": "run-12345678", "digest": "d" * 64}
    ctx.state["planBinding"] = copy.deepcopy(binding)
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(manager, "_commit", lambda _ctx: None)
    monkeypatch.setattr(manager, "_emit_job", lambda *_args: None)
    monkeypatch.setattr(manager, "_emit_run", lambda *_args: None)

    def _no_receipt(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise AssertionError("Write no receipt for a blocked node.")

    monkeypatch.setattr(runtime, "make_receipt", _no_receipt)
    sentence = "Reconstruction failed, so this step did not run."
    try:
        assert manager._tick(ctx) is True
        assert dependent["status"] == "blocked"
        assert dependent["reason"] == sentence
        [job] = ctx.state["jobs"]
        assert job["status"] == "blocked"
        assert job["terminalReason"] == sentence
        assert ctx.state["receipts"] == []
        assert ctx.state["planBinding"] == binding
        assert not any("receipt" in path.name for path in tmp_path.rglob("*"))

        # The reuse rule reads a node's stage and subject, never its reason.
        expected: list[tuple[str, str | None]] = []

        def _expected(
            _ctx: _RunContext, step_key: str, subject_id: str | None
        ) -> tuple[str, dict[str, Any]]:
            expected.append((step_key, subject_id))
            return "current", {}

        monkeypatch.setattr(manager, "_expected", _expected)
        monkeypatch.setattr(manager, "_matching_receipt", lambda *_args: None)
        monkeypatch.setattr(
            runtime, "detector_evidence", lambda *_args: {"state": "pending"}
        )
        monkeypatch.setattr(
            runtime, "enrich_evidence", lambda _key, evidence, *_args: evidence
        )
        assert manager._current_receipt(ctx, _ReasonlessNode(dependent)) is None
        assert expected == [("enigma", None)]
    finally:
        manager.shutdown()


def test_the_planning_pass_never_writes_a_blocked_dependency_reason(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A workflow plan skips stage readiness (the planner blocks dependents
    # itself) and a stage plan has no dependency edges, so the reason cannot
    # reach a plan node, a blocker, or the plan digest.
    calls: list[tuple[str, str]] = []
    upstream = _node("recon", status="blocked")
    upstream["reason"] = "Install recon-all."
    dependent = _node(
        "enigma",
        status="waiting",
        subject_id=None,
        dependencies=[upstream["nodeId"]],
    )
    request = {
        "project": _project(tmp_path),
        "cfg": {"paths": {"projectRoot": str(tmp_path)}},
        "configRevision": 1,
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "acknowledgements": {},
    }
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    monkeypatch.setattr(
        runtime,
        "build_plan",
        lambda *_args, **_kwargs: _planned([upstream, dependent], cohort=_cohort()),
    )
    monkeypatch.setattr(manager, "_apply_runtime_policy", lambda _ctx: None)
    digests: list[str] = []
    try:
        for sentinel in ("first wording", "second wording"):

            def _reason(step_key: str, status: str, text: str = sentinel) -> str:
                calls.append((step_key, status))
                return text

            monkeypatch.setattr(runtime, "blocked_dependency_reason", _reason)
            result = manager.plan(request)
            assert sentinel not in json.dumps(result)
            digests.append(result["plan"]["digest"])
        assert calls == []
        assert digests[0] == digests[1]
    finally:
        manager.shutdown()


def test_producer_readiness_loads_disk_receipt_when_run_has_no_inline_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx = _context(tmp_path)
    receipt = {
        "detectorEvidence": {"state": "done", "identity": "detector"},
        "edgeEvidence": {"enigma": {"state": "done", "identity": "edge"}},
    }
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(manager, "_expected", lambda *_args: ("current", {}))
    monkeypatch.setattr(ctx.store, "get_receipt", lambda *_args: receipt)
    monkeypatch.setattr(
        runtime,
        "detector_evidence",
        lambda *_args: {"state": "done", "identity": "detector"},
    )
    monkeypatch.setattr(
        runtime, "enrich_evidence", lambda _key, evidence, *_args: evidence
    )
    monkeypatch.setattr(
        runtime,
        "edge_evidence",
        lambda *_args: {"state": "done", "identity": "edge"},
    )
    monkeypatch.setattr(
        runtime, "evidence_is_done", lambda value: value.get("state") == "done"
    )
    monkeypatch.setattr(
        runtime, "evidence_identity", lambda value: value.get("identity")
    )
    try:
        assert manager._producer_ready(ctx, "recon", "enigma", "sub-01") == (True, "")
    finally:
        manager.shutdown()


def test_projection_binding_applies_only_to_label_consuming_steps() -> None:
    signature, untouched = WorkflowManager._bind_projection_inputs(
        "recon", "signature", {"externalInputs": {}}
    )
    assert signature == "signature"
    assert untouched == {"externalInputs": {}}

    payload = {
        "externalInputs": {
            "clinicalMetadata": {"exists": True, "sha256": "source"},
            "subjectRegistry": {"exists": True, "sha256": "registry"},
        }
    }
    bound_signature, bound = WorkflowManager._bind_projection_inputs(
        "clinical", "old", payload
    )
    assert bound_signature != "old"
    assert bound["externalInputs"]["runScopedProjectionBinding"]["kind"] == (
        "metadata-projection-input-binding-v1"
    )
    assert "runScopedProjectionBinding" not in payload["externalInputs"]


class _FixedCommandAdapter:
    """Supply the test command through this adapter stub."""

    def __init__(self, command: list[str]) -> None:
        self._command = command

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        del cfg, subject_id
        return self._command


def test_unusable_interpreter_names_an_empty_program() -> None:
    # Name an empty argv[0] during planning before execve rejects it after the
    # operator approves the plan.
    reason = runtime._unusable_interpreter(
        _FixedCommandAdapter(["", "/assets/outliers_qc.R"]), {}, None
    )

    assert reason == (
        "Replace the empty configured interpreter in Pipeline, or install the "
        "required tool."
    )


def test_unusable_interpreter_names_an_unresolved_placeholder() -> None:
    reason = runtime._unusable_interpreter(
        _FixedCommandAdapter(["${tools.rscriptExecutable}", "/assets/x.R"]), {}, None
    )

    assert reason == (
        "Resolve the unresolved configured interpreter: ${tools.rscriptExecutable}."
    )
    assert "${tools.rscriptExecutable}" in reason


def test_unusable_interpreter_accepts_an_executable_program() -> None:
    assert (
        runtime._unusable_interpreter(
            _FixedCommandAdapter(["Rscript", "/assets/x.R"]), {}, None
        )
        is None
    )


@pytest.mark.parametrize(
    "reruns",
    [
        [Rerun(KNOWN_FAILURES[0], 1)],
        [Rerun(KNOWN_FAILURES[1], 1)],
        [Rerun(KNOWN_FAILURES[0], 1), Rerun(KNOWN_FAILURES[1], 134)],
    ],
    ids=["no-fix-ga", "no-fix-with-ga", "composed"],
)
def test_a_fallback_receipt_is_current_on_the_next_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, reruns: list[Rerun]
) -> None:
    cohort = _receipt_cohort(
        analysis_digest="analysis",
        selected_digest="selected",
        verdict="pass",
        acknowledged=False,
    )
    cfg = _receipt_cfg(tmp_path)
    node = _node("recon", subject_id="sub-01")
    ctx = _context(tmp_path, nodes=[copy.deepcopy(node)], cfg=cfg, cohort=cohort)
    manager = WorkflowManager(_Emitter())
    signature, payload = manager._expected(ctx, "recon", "sub-01")
    # The rerun leaves the subject imported, so the next plan builds its
    # command without -i; the bound receipt form, and so the plan's signature,
    # stays the same.
    orig = tmp_path / "derivatives" / "freesurfer" / "sub-01" / "mri" / "orig"
    orig.mkdir(parents=True)
    (orig / "001.mgz").write_bytes(b"imported")
    assert manager._expected(ctx, "recon", "sub-01")[0] == signature
    evidence = {"state": "done", "artifacts": []}
    fell_back = make_receipt(
        signature,
        payload,
        evidence,
        run_id="run-fixga01",
        job_id="#fixga01",
        committed_at_ms=11,
        execution_fallback=fallback_record(reruns),
    )
    monkeypatch.setattr(runtime, "detector_evidence", lambda *_args: evidence)
    monkeypatch.setattr(runtime, "enrich_evidence", lambda _key, value, *_args: value)
    try:
        ctx.store.put_receipt(fell_back)
        assert ctx.store.get_receipt("recon", "sub-01", signature) == fell_back
        current = manager._current_receipt(ctx, ctx.state["nodes"][0])
        assert current == fell_back
        assert current is not None
        assert current["executionFallback"]["addedArguments"] == [
            rerun.failure.flag for rerun in reruns
        ]

        manager._apply_runtime_policy(ctx)
        assert ctx.state["nodes"][0]["status"] == "skipped"
        assert ctx.state["nodes"][0]["reason"] == (
            "The current detector-backed receipt is reused."
        )
    finally:
        manager.shutdown()
