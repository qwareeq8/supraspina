"""Cohort receipts bind the analysis membership, not QC verdicts."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import workflow_manager as runtime
from supraspina_sidecar.cohort import (
    CohortSnapshot,
    T1Resolution,
    resolve_analysis_cohort,
)
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.provenance import make_receipt
from supraspina_sidecar.run_store import RunStore
from supraspina_sidecar.workflow_manager import WorkflowManager, _RunContext

_COHORT_STEPS = (
    "enigma",
    "outliers",
    "features",
    "age",
    "pybrainage",
    "clinical",
    "brainpad",
    "aggregate",
    "final",
)
_DONE: dict[str, Any] = {"state": "done", "artifacts": []}
_REUSED = "The current detector-backed receipt is reused."
_NO_RECEIPT = "No earlier run left a receipt for it."
_COHORT_CHANGED = "The analysis cohort changed after it last ran."
_INPUTS_CHANGED = "Its inputs changed after it last ran."
_OUTPUT_CHANGED = "Its output on disk no longer matches its receipt."
_SUBJECTS = tuple(f"sub-{index:03d}" for index in range(1, 13))
#: Every seventh of 100 subjects, 15 in all, stands in for the Defer rows.
_LARGE_SUBJECTS = tuple(f"sub-{index:03d}" for index in range(1, 101))
_LARGE_DEFER = frozenset(_LARGE_SUBJECTS[::7])


class _Emitter:
    def emit(self, method: str, params: dict[str, Any]) -> None:
        del method, params


def _rows(
    subjects: tuple[str, ...], fingerprints: dict[str, str] | None = None
) -> list[T1Resolution]:
    changed = fingerprints or {}
    return [
        T1Resolution(
            subject_id=subject_id,
            state="resolved",
            path=f"/raw/{subject_id}/anat/{subject_id}_T1w.nii.gz",
            candidates=(),
            fingerprint=changed.get(
                subject_id, hashlib.sha256(f"t1-{subject_id}".encode()).hexdigest()
            ),
        )
        for subject_id in subjects
    ]


def _evidence(reviewer: str = "os-user:reviewer") -> dict[str, Any]:
    return {
        "evidenceVersion": 1,
        "reviewer": reviewer,
        "reviewedAt": "2026-09-24T12:00:00.000Z",
        "galleries": [],
    }


def _records(
    verdicts: dict[str, str], *, reviewer: str = "os-user:reviewer", note: str = ""
) -> dict[str, dict[str, Any]]:
    return {
        subject_id: {
            "verdict": verdict,
            "note": note,
            "tags": [],
            "reviewEvidence": _evidence(reviewer),
            "revision": 1,
            "updatedAt": "2026-09-24T12:00:00.000Z",
        }
        for subject_id, verdict in verdicts.items()
    }


def _cohort(
    records: dict[str, dict[str, Any]],
    *,
    subjects: tuple[str, ...] = _SUBJECTS,
    fingerprints: dict[str, str] | None = None,
    excluded_by_config: tuple[str, ...] = (),
    acknowledged: bool = True,
) -> CohortSnapshot:
    rows = [
        row
        for row in _rows(subjects, fingerprints)
        if row.subject_id not in excluded_by_config
    ]
    return resolve_analysis_cohort(rows, records, excluded_by_config).snapshot(
        acknowledged=acknowledged
    )


def _reviewed(subjects: tuple[str, ...] = _SUBJECTS) -> dict[str, str]:
    return {
        subject_id: "defer" if index % 4 == 1 else "pass"
        for index, subject_id in enumerate(subjects)
    }


def _context(root: Path, cohort: CohortSnapshot) -> _RunContext:
    identity = ProjectIdentity(
        "cohort-membership", str(root), str(root / "supraspina.project.json"), 1
    )
    steps = {key: {"enabled": True, "params": {}} for key in ("recon", *_COHORT_STEPS)}
    steps["recon"]["params"] = {"backend": "freesurfer"}
    cfg = {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": "/raw",
            "derivativesDir": str(root / "derivatives"),
            "outputDir": str(root / "output"),
        },
        "runtime": {"resumeCompleted": True, "rerunIncomplete": False},
        "steps": steps,
        "_supraspinaRuntime": {},
    }
    nodes = [
        {
            "nodeId": f"{key}:cohort",
            "stepKey": key,
            "subjectId": None,
            "scope": "cohort",
            "status": "planned",
            "dependencies": [],
        }
        for key in _COHORT_STEPS
    ]
    state = {
        "runId": "run-12345678",
        "project": identity.to_dict(),
        "config": cfg,
        "scope": cohort.to_dict(),
        "intent": {"kind": "workflow"},
        "nodes": nodes,
        "jobs": [],
        "receipts": [],
        "warnings": [],
        "environmentEvidence": {},
        "status": "queued",
        "dryRun": False,
    }
    return _RunContext(
        state=state,
        cfg=cfg,
        effective_cfg=cfg,
        cohort=cohort,
        project=identity,
        store=RunStore(str(root)),
        queue_limit=1,
    )


def _publish(
    manager: WorkflowManager, root: Path, cohort: CohortSnapshot
) -> dict[str, str]:
    """Publish a done receipt for every cohort stage; return their signatures."""
    ctx = _context(root, cohort)
    signatures: dict[str, str] = {}
    with manager._planning_pass(ctx):
        for index, key in enumerate(_COHORT_STEPS):
            signature, payload = manager._expected(ctx, key, None)
            ctx.store.put_receipt(
                make_receipt(
                    signature,
                    payload,
                    _DONE,
                    run_id="run-aaaaaaaa",
                    job_id=f"#{index + 1}",
                    committed_at_ms=index + 1,
                    edge_evidence={consumer: _DONE for consumer in _COHORT_STEPS},
                )
            )
            signatures[key] = signature
    return signatures


def _plan(
    manager: WorkflowManager, root: Path, cohort: CohortSnapshot
) -> tuple[_RunContext, dict[str, dict[str, Any]]]:
    ctx = _context(root, cohort)
    with manager._planning_pass(ctx):
        manager._apply_runtime_policy(ctx)
    return ctx, {node["stepKey"]: node for node in ctx.state["nodes"]}


def _receipt_files(root: Path) -> dict[str, str]:
    receipts = root / ".supraspina" / "receipts"
    return {
        str(path.relative_to(receipts)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(receipts.rglob("*"))
        if path.is_file()
    }


def _assert_reused(nodes: dict[str, dict[str, Any]]) -> None:
    for key in _COHORT_STEPS:
        assert nodes[key]["status"] == "skipped", key
        assert nodes[key]["reason"] == _REUSED, key


def _run_reasons(nodes: dict[str, dict[str, Any]]) -> set[str]:
    """Return the reasons of the nodes the plan runs; ENIGMA QC always runs."""
    assert nodes["enigma"]["status"] == "planned"
    return {
        str(node["reason"])
        for node in nodes.values()
        if node["status"] in {"planned", "waiting"}
    }


@pytest.fixture
def manager(monkeypatch: pytest.MonkeyPatch) -> Iterator[WorkflowManager]:
    monkeypatch.setattr(runtime, "detector_evidence", lambda *_args: dict(_DONE))
    monkeypatch.setattr(runtime, "edge_evidence", lambda *_args: dict(_DONE))
    monkeypatch.setattr(runtime, "enrich_evidence", lambda _key, value, *_a: value)
    manager = WorkflowManager(_Emitter())
    yield manager
    manager.shutdown()


@pytest.mark.parametrize(
    "acknowledged",
    [True, False],
    ids=["pass-and-defer", "all-pass-unacknowledged"],
)
def test_recorded_verdicts_reuse_the_receipts_of_an_unreviewed_store(
    manager: WorkflowManager, tmp_path: Path, acknowledged: bool
) -> None:
    # Receipts written under an empty QC store with the acknowledgement, then
    # 85 Pass and 15 Defer verdicts with gallery evidence for the same 100.
    _publish(manager, tmp_path, _cohort({}, subjects=_LARGE_SUBJECTS))
    before = _receipt_files(tmp_path)
    verdicts = {
        subject_id: "defer" if acknowledged and subject_id in _LARGE_DEFER else "pass"
        for subject_id in _LARGE_SUBJECTS
    }
    reviewed = _cohort(
        _records(verdicts), subjects=_LARGE_SUBJECTS, acknowledged=acknowledged
    )
    assert sum(value == "defer" for value in verdicts.values()) == (
        15 if acknowledged else 0
    )

    _ctx, nodes = _plan(manager, tmp_path, reviewed)

    _assert_reused(nodes)
    assert _receipt_files(tmp_path) == before


@pytest.mark.parametrize(
    "records",
    [
        pytest.param(
            _records(
                {
                    key: "defer" if value == "pass" else "pass"
                    for key, value in _reviewed().items()
                }
            ),
            id="pass-and-defer-swapped",
        ),
        pytest.param(_records({"sub-001": "pass", "sub-002": "defer"}), id="partial"),
        pytest.param(_records({}), id="defer-cleared"),
        pytest.param(_records(_reviewed(), reviewer="second"), id="evidence-edited"),
        pytest.param(_records(_reviewed(), note="Rechecked."), id="notes-edited"),
        pytest.param(
            {"sub-003": {"verdict": "fail", "reviewEvidence": None}},
            id="fail-without-evidence",
        ),
    ],
)
def test_verdict_only_changes_keep_every_cohort_stage_reused(
    manager: WorkflowManager, tmp_path: Path, records: dict[str, dict[str, Any]]
) -> None:
    _publish(manager, tmp_path, _cohort(_records(_reviewed())))
    before = _receipt_files(tmp_path)

    _ctx, nodes = _plan(manager, tmp_path, _cohort(records))

    _assert_reused(nodes)
    assert _receipt_files(tmp_path) == before


def test_all_pass_without_acknowledgement_keeps_every_cohort_stage_reused(
    manager: WorkflowManager, tmp_path: Path
) -> None:
    _publish(manager, tmp_path, _cohort(_records(_reviewed())))
    all_pass = _records(dict.fromkeys(_SUBJECTS, "pass"))

    _ctx, nodes = _plan(manager, tmp_path, _cohort(all_pass, acknowledged=False))

    _assert_reused(nodes)


_MEMBERSHIP_CHANGES: dict[str, dict[str, Any]] = {
    "qc-fail": {"records": _records({**_reviewed(), "sub-003": "fail"})},
    "configuration-exclusion": {"excluded_by_config": ("sub-004",)},
    "t1-change": {"fingerprints": {"sub-004": "0" * 64}},
    "subject-added": {"subjects": (*_SUBJECTS, "sub-013")},
    "subject-removed": {"subjects": _SUBJECTS[:-1]},
    "narrowed-recovery": {"subjects": _SUBJECTS[:6]},
}


@pytest.mark.parametrize("change", sorted(_MEMBERSHIP_CHANGES))
def test_membership_changes_reuse_no_cohort_stage(
    manager: WorkflowManager, tmp_path: Path, change: str
) -> None:
    _publish(manager, tmp_path, _cohort(_records(_reviewed())))
    before = _receipt_files(tmp_path)
    options = dict(_MEMBERSHIP_CHANGES[change])
    records = options.pop("records", _records(_reviewed()))
    changed = _cohort(records, **options)

    _ctx, nodes = _plan(manager, tmp_path, changed)

    assert {key: node["status"] == "skipped" for key, node in nodes.items()} == (
        dict.fromkeys(_COHORT_STEPS, False)
    )
    # Every receipt bound the earlier membership, so the plan names the cause.
    assert _run_reasons(nodes) == {_COHORT_CHANGED}
    assert _receipt_files(tmp_path) == before


def test_reverted_fail_reuses_the_receipts_of_the_restored_membership(
    manager: WorkflowManager, tmp_path: Path
) -> None:
    full = _cohort(_records(_reviewed()))
    failed = _cohort(_records({**_reviewed(), "sub-003": "fail"}))
    _publish(manager, tmp_path, full)
    _publish(manager, tmp_path, failed)
    assert failed.excluded_by_qc == ("sub-003",)

    ctx, nodes = _plan(manager, tmp_path, failed)
    _assert_reused(nodes)
    assert {item["analysisCohortDigest"] for item in ctx.state["receipts"]} == {
        failed.analysis_digest
    }

    reverted = _cohort(_records(_reviewed()))
    assert reverted.analysis_digest == full.analysis_digest
    ctx, nodes = _plan(manager, tmp_path, reverted)
    _assert_reused(nodes)
    assert {item["analysisCohortDigest"] for item in ctx.state["receipts"]} == {
        full.analysis_digest
    }


def test_run_reasons_name_a_stage_without_any_receipt(
    manager: WorkflowManager, tmp_path: Path
) -> None:
    _ctx, nodes = _plan(manager, tmp_path, _cohort(_records(_reviewed())))

    assert _run_reasons(nodes) == {_NO_RECEIPT}


def test_run_reasons_name_changed_inputs_under_the_same_cohort(
    manager: WorkflowManager, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reviewed = _cohort(_records(_reviewed()))
    _publish(manager, tmp_path, reviewed)
    before = _receipt_files(tmp_path)
    original = runtime.expected_signature

    def changed_enigma(step_key: str, *args: Any, **kwargs: Any) -> Any:
        signature, payload = original(step_key, *args, **kwargs)
        if step_key == "enigma":
            signature = hashlib.sha256(f"{signature}:changed".encode()).hexdigest()
        return signature, payload

    monkeypatch.setattr(runtime, "expected_signature", changed_enigma)
    _ctx, nodes = _plan(manager, tmp_path, reviewed)

    assert nodes["enigma"]["status"] == "planned"
    assert nodes["enigma"]["reason"] == _INPUTS_CHANGED
    # Every stage downstream of ENIGMA QC binds its digest and runs for the
    # same reason.
    assert _run_reasons(nodes) == {_INPUTS_CHANGED}
    assert _receipt_files(tmp_path) == before


def test_run_reasons_name_output_that_no_longer_matches_its_receipt(
    manager: WorkflowManager, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reviewed = _cohort(_records(_reviewed()))
    _publish(manager, tmp_path, reviewed)
    before = _receipt_files(tmp_path)
    monkeypatch.setattr(
        runtime,
        "detector_evidence",
        lambda adapter, *_args: (
            {"state": "missing", "artifacts": []}
            if adapter is runtime.ADAPTERS["enigma"]
            else dict(_DONE)
        ),
    )

    _ctx, nodes = _plan(manager, tmp_path, reviewed)

    assert nodes["enigma"]["status"] == "planned"
    assert nodes["enigma"]["reason"] == _OUTPUT_CHANGED
    assert _run_reasons(nodes) == {_OUTPUT_CHANGED}
    assert {key: node["reason"] for key, node in nodes.items() if key != "enigma"} == (
        dict.fromkeys(_COHORT_STEPS[1:], _REUSED)
    )
    assert _receipt_files(tmp_path) == before
