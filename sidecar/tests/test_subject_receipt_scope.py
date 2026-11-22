"""Tests for QC-independent subject and cohort receipt-scope contracts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

import supraspina_sidecar
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.cohort import (
    CohortSnapshot,
    T1Resolution,
    build_cohort_snapshot,
    resolve_analysis_cohort,
)
from supraspina_sidecar.provenance import (
    expected_receipt_payload,
    expected_signature,
    make_receipt,
    receipt_signature_valid,
)
from supraspina_sidecar.run_store import RECEIPT_VERSION


def _cohort(
    *,
    analysis_digest: str,
    selected_digest: str,
    verdicts: tuple[tuple[str, str], ...],
    excluded_by_qc: tuple[str, ...] = (),
    acknowledged: bool = False,
) -> CohortSnapshot:
    subject_ids = tuple(
        subject_id
        for subject_id in ("sub-001", "sub-002")
        if subject_id not in excluded_by_qc
    )
    return CohortSnapshot(
        analysis_subject_ids=subject_ids,
        selected_subject_ids=subject_ids,
        analysis_digest=analysis_digest,
        selected_digest=selected_digest,
        t1=tuple(
            T1Resolution(
                subject_id=subject_id,
                state="resolved",
                path=f"/raw/{subject_id}/anat/{subject_id}_T1w.nii.gz",
                candidates=(),
                fingerprint=f"t1-{subject_id}",
                fingerprint_strategy="sha256-full-v1",
            )
            for subject_id in subject_ids
        ),
        qc_verdicts=verdicts,
        qc_acknowledged=acknowledged,
        excluded_by_config=(),
        excluded_by_qc=excluded_by_qc,
    )


def _cfg(root: Path) -> dict[str, Any]:
    return {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": "/raw",
            "derivativesDir": str(root / "derivatives"),
            "outputDir": str(root / "output"),
        },
        "steps": {
            "recon": {
                "enabled": True,
                "params": {
                    "backend": "freesurfer",
                    "directives": "-all",
                    "parallel": True,
                },
            },
            "features": {
                "enabled": True,
                "params": {"parcellation": "aparc.a2009s"},
            },
        },
        "_supraspinaRuntime": {},
    }


def _signature(
    root: Path,
    step_key: str,
    subject_id: str | None,
    cohort: CohortSnapshot,
    *,
    upstream_signatures: list[str] | None = None,
) -> tuple[str, dict[str, Any]]:
    return expected_signature(
        step_key,
        subject_id,
        _cfg(root),
        cohort,
        ADAPTERS[step_key],
        upstream_signatures=upstream_signatures or [],
        tool_evidence={"reconall": {"status": "found"}},
    )


def _review_evidence() -> dict[str, Any]:
    return {
        "evidenceVersion": 1,
        "reviewer": "reviewer",
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


def _write_qc(
    root: Path,
    verdicts: dict[str, str | None],
    *,
    reviewed: bool = False,
) -> None:
    path = root / ".supraspina/qc_verdicts.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "verdicts": {
                    subject_id: {
                        "verdict": verdict,
                        "note": "",
                        "tags": [],
                        "reviewEvidence": (
                            _review_evidence()
                            if reviewed and verdict is not None
                            else None
                        ),
                        "revision": 1,
                        "updatedAt": "2026-07-31T12:00:00.000Z",
                    }
                    for subject_id, verdict in verdicts.items()
                },
            }
        ),
        encoding="utf-8",
    )


def _discovered_cfg(root: Path, subjects: tuple[str, ...]) -> dict[str, Any]:
    """Return a configuration whose raw data holds one T1 per subject."""
    cfg = _cfg(root)
    raw = root / "rawdata"
    cfg["paths"]["rawdataDir"] = str(raw)
    cfg["patterns"] = {
        "subjectGlob": "sub-*",
        "t1Pattern": "*_T1w.nii.gz",
    }
    cfg["subjects"] = {"include": [], "exclude": []}
    for subject_id in subjects:
        t1 = raw / subject_id / "anat" / f"{subject_id}_T1w.nii.gz"
        t1.parent.mkdir(parents=True, exist_ok=True)
        t1.write_bytes(f"T1:{subject_id}".encode())
    return cfg


def test_pass_defer_transition_keeps_every_receipt_signature(tmp_path: Path) -> None:
    cfg = _discovered_cfg(tmp_path, ("sub-001", "sub-002"))
    _write_qc(tmp_path, {"sub-001": None, "sub-002": None})
    before = build_cohort_snapshot(cfg, acknowledge_qc_pending=True)
    _write_qc(tmp_path, {"sub-001": "pass", "sub-002": "defer"}, reviewed=True)
    after = build_cohort_snapshot(cfg, acknowledge_qc_pending=True)

    assert after.qc_verdicts == (("sub-001", "pass"), ("sub-002", "defer"))
    assert before.analysis_digest == after.analysis_digest
    assert (
        _signature(tmp_path, "recon", "sub-001", before)[0]
        == _signature(tmp_path, "recon", "sub-001", after)[0]
    )
    assert (
        _signature(tmp_path, "features", None, before)[0]
        == _signature(tmp_path, "features", None, after)[0]
    )


def test_pass_fail_transition_changes_only_cohort_stage_signature(
    tmp_path: Path,
) -> None:
    cfg = _discovered_cfg(tmp_path, ("sub-001", "sub-002"))
    _write_qc(tmp_path, {"sub-001": None, "sub-002": None})
    before = build_cohort_snapshot(cfg, acknowledge_qc_pending=True)
    _write_qc(
        tmp_path,
        {"sub-001": "pass", "sub-002": "fail"},
        reviewed=True,
    )
    after = build_cohort_snapshot(cfg)

    assert before.analysis_digest != after.analysis_digest
    assert after.excluded_by_qc == ("sub-002",)
    assert (
        _signature(tmp_path, "recon", "sub-001", before)[0]
        == _signature(tmp_path, "recon", "sub-001", after)[0]
    )
    assert (
        _signature(tmp_path, "features", None, before)[0]
        != _signature(tmp_path, "features", None, after)[0]
    )


def test_review_evidence_change_keeps_every_receipt_signature(
    tmp_path: Path,
) -> None:
    cfg = _discovered_cfg(tmp_path, ("sub-001",))
    _write_qc(tmp_path, {"sub-001": "pass"}, reviewed=True)
    before = build_cohort_snapshot(cfg)
    qc_path = tmp_path / ".supraspina/qc_verdicts.json"
    document = json.loads(qc_path.read_text(encoding="utf-8"))
    document["verdicts"]["sub-001"]["reviewEvidence"]["reviewedAt"] = (
        "2026-07-31T13:00:00.000Z"
    )
    qc_path.write_text(json.dumps(document), encoding="utf-8")

    after = build_cohort_snapshot(cfg)
    before_subject, _ = _signature(tmp_path, "recon", "sub-001", before)
    after_subject, _ = _signature(tmp_path, "recon", "sub-001", after)
    before_cohort, _ = _signature(tmp_path, "features", None, before)
    after_cohort, after_payload = _signature(tmp_path, "features", None, after)

    assert before.analysis_digest == after.analysis_digest
    assert before_subject == after_subject
    assert before_cohort == after_cohort
    assert after_payload["analysisCohortDigest"] == after.membership_digest


def test_subject_receipt_is_stable_across_qc_changes_but_cohort_is_not(
    tmp_path: Path,
) -> None:
    unreviewed = _cohort(
        analysis_digest="analysis-unreviewed",
        selected_digest="selected-unreviewed",
        verdicts=(("sub-001", "unreviewed"), ("sub-002", "unreviewed")),
        acknowledged=True,
    )
    reviewed = _cohort(
        analysis_digest="analysis-reviewed",
        selected_digest="selected-reviewed",
        verdicts=(("sub-001", "pass"),),
        excluded_by_qc=("sub-002",),
    )

    before_subject, before_payload = _signature(
        tmp_path, "recon", "sub-001", unreviewed
    )
    after_subject, after_payload = _signature(tmp_path, "recon", "sub-001", reviewed)
    before_cohort, _ = _signature(tmp_path, "features", None, unreviewed)
    after_cohort, cohort_payload = _signature(tmp_path, "features", None, reviewed)

    assert before_subject == after_subject
    assert before_payload["analysisCohortDigest"] is None
    assert before_payload["selectedSubsetDigest"] is None
    assert before_payload["scopeBinding"] == {
        "bindingVersion": 1,
        "kind": "subject-input",
        "subjectId": "sub-001",
        "inputT1Fingerprint": "t1-sub-001",
        "inputT1FingerprintStrategy": "sha256-full-v1",
    }
    assert after_payload["scopeBinding"] == before_payload["scopeBinding"]
    assert before_cohort != after_cohort
    assert cohort_payload["analysisCohortDigest"] == "analysis-reviewed"
    assert cohort_payload["scopeBinding"] == {
        "bindingVersion": 1,
        "kind": "analysis-cohort",
        "analysisCohortDigest": "analysis-reviewed",
        "analysisSubjectIds": ["sub-001"],
        "qcVerdicts": {"sub-001": "unreviewed"},
        "qcAcknowledged": True,
        "excludedByConfig": [],
        "excludedByQc": ["sub-002"],
    }

    real = _resolved({"sub-001": "pass", "sub-002": "fail"})
    _real_signature, real_payload = _signature(tmp_path, "features", None, real)
    assert real_payload["scopeBinding"] == {
        "bindingVersion": 1,
        "kind": "analysis-cohort",
        "analysisCohortDigest": real.membership_digest,
        "analysisSubjectIds": ["sub-001"],
        "qcVerdicts": {"sub-001": "unreviewed"},
        "qcAcknowledged": True,
        "excludedByConfig": [],
        "excludedByQc": ["sub-002"],
    }


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


def _resolved(
    verdicts: dict[str, str],
    *,
    acknowledged: bool = True,
    reviewer: str = "reviewer",
    note: str = "",
) -> CohortSnapshot:
    """Resolve the two-subject cohort under one set of QC records."""
    evidence = {**_review_evidence(), "reviewer": reviewer}
    records = {
        subject_id: {
            "verdict": verdict,
            "note": note,
            "tags": [],
            "reviewEvidence": evidence,
            "revision": 1,
            "updatedAt": "2026-07-31T12:00:00.000Z",
        }
        for subject_id, verdict in verdicts.items()
    }
    rows = [
        T1Resolution(
            subject_id=subject_id,
            state="resolved",
            path=f"/raw/{subject_id}/anat/{subject_id}_T1w.nii.gz",
            candidates=(),
            fingerprint=f"t1-{subject_id}",
        )
        for subject_id in ("sub-001", "sub-002")
    ]
    return resolve_analysis_cohort(rows, records, ()).snapshot(
        acknowledged=acknowledged
    )


def _payload(
    root: Path,
    step_key: str,
    subject_id: str | None,
    cohort: CohortSnapshot,
    cfg: dict[str, Any] | None = None,
) -> str:
    """Return one real expected payload as canonical JSON."""
    payload = expected_receipt_payload(
        step_key,
        subject_id,
        cfg or _cfg(root),
        cohort,
        ADAPTERS[step_key],
        upstream_signatures=["u" * 64],
        tool_evidence={"reconall": {"status": "found"}},
    )
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


@pytest.mark.parametrize("step_key", _COHORT_STEPS)
def test_cohort_payload_depends_only_on_membership(
    tmp_path: Path, step_key: str
) -> None:
    same_membership = [
        _resolved({}),
        _resolved({"sub-001": "pass", "sub-002": "defer"}),
        _resolved({"sub-001": "defer", "sub-002": "pass"}),
        _resolved({"sub-001": "pass", "sub-002": "pass"}, acknowledged=False),
        _resolved({"sub-001": "pass", "sub-002": "pass"}, reviewer="second"),
        _resolved({"sub-001": "pass", "sub-002": "pass"}, note="Rechecked."),
    ]
    baseline = _payload(tmp_path, step_key, None, same_membership[0])

    for snapshot in same_membership[1:]:
        assert _payload(tmp_path, step_key, None, snapshot) == baseline

    failed = json.loads(
        _payload(tmp_path, step_key, None, _resolved({"sub-002": "fail"}))
    )
    unchanged = json.loads(baseline)
    assert {key for key in unchanged if unchanged[key] != failed[key]} == {
        "analysisCohortDigest",
        "scopeBinding",
    }

    # The runtime copies of the cohort digests are not scientific inputs.
    overlaid = _cfg(tmp_path)
    overlaid["_supraspinaRuntime"] = {
        "analysisCohortDigest": "a" * 64,
        "selectedSubsetDigest": "b" * 64,
    }
    assert _payload(tmp_path, step_key, None, same_membership[1], overlaid) == baseline


@pytest.mark.parametrize("step_key", ["brainfov", "recon", "deface"])
def test_subject_payloads_ignore_the_qc_state(tmp_path: Path, step_key: str) -> None:
    states = [
        _resolved({}),
        _resolved({"sub-001": "pass", "sub-002": "defer"}),
        _resolved({"sub-001": "pass", "sub-002": "fail"}),
    ]

    payloads = {
        _payload(tmp_path, step_key, "sub-001", snapshot) for snapshot in states
    }

    assert len(payloads) == 1


def test_no_adapter_or_membership_module_reads_qc_verdicts() -> None:
    # No stage reads QC verdicts, so cohort receipts bind only the analysis
    # membership. A stage that starts reading verdicts must bind them in its
    # own payload.
    package = Path(supraspina_sidecar.__file__).parent
    sources = [*sorted((package / "adapters").glob("*.py")), package / "membership.py"]
    tokens = (
        "load_qc_records",
        "load_project_qc_records",
        "effective_qc_verdict",
        "load_document",
        "qc_verdicts",
        "qc_acknowledged",
        "qcVerdicts",
    )

    assert len(sources) > 2
    readers = {
        f"{source.name}: {token}"
        for source in sources
        for token in tokens
        if token in source.read_text(encoding="utf-8")
    }
    assert readers == set()


def test_subject_receipt_changes_with_consumed_input_and_lineage(
    tmp_path: Path,
) -> None:
    cohort = _cohort(
        analysis_digest="analysis",
        selected_digest="selected",
        verdicts=(("sub-001", "pass"), ("sub-002", "pass")),
    )
    cfg = _cfg(tmp_path)

    def signature(
        *,
        selected_cfg: dict[str, Any] = cfg,
        selected_cohort: CohortSnapshot = cohort,
        upstream: list[str] | None = None,
        tool_status: str = "found",
    ) -> str:
        return expected_signature(
            "recon",
            "sub-001",
            selected_cfg,
            selected_cohort,
            ADAPTERS["recon"],
            upstream_signatures=upstream or [],
            tool_evidence={"reconall": {"status": tool_status}},
        )[0]

    changed_t1 = CohortSnapshot(
        **{
            **cohort.__dict__,
            "t1": (
                T1Resolution(
                    subject_id="sub-001",
                    state="resolved",
                    path="/raw/sub-001/anat/sub-001_T1w.nii.gz",
                    candidates=(),
                    fingerprint="changed-t1",
                ),
                cohort.t1[1],
            ),
        }
    )
    changed_params = _cfg(tmp_path)
    changed_params["steps"]["recon"]["params"]["directives"] = "-autorecon2"
    baseline = signature()

    assert signature(selected_cohort=changed_t1) != baseline
    assert signature(selected_cfg=changed_params) != baseline
    assert signature(tool_status="missing") != baseline
    assert signature(upstream=["a" * 64]) != baseline


def test_receipt_version_one_payload_is_not_accepted(tmp_path: Path) -> None:
    cohort = _cohort(
        analysis_digest="analysis-original",
        selected_digest="selected-original",
        verdicts=(("sub-001", "unreviewed"), ("sub-002", "unreviewed")),
        acknowledged=True,
    )
    signature, payload = _signature(tmp_path, "recon", "sub-001", cohort)
    receipt = make_receipt(
        signature,
        payload,
        {"state": "done", "artifacts": []},
        run_id="run-abcd1234",
        job_id="#abcd1234",
        committed_at_ms=10,
    )
    downgraded = {**receipt, "receiptVersion": 1}
    downgraded.pop("scopeBinding")

    assert receipt["receiptVersion"] == RECEIPT_VERSION
    assert receipt_signature_valid(receipt, signature)
    assert not receipt_signature_valid(downgraded, signature)
