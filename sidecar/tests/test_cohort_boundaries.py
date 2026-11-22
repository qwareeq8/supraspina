"""Tests for safety bounds and exact-cohort behavior at scientific input boundaries."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import cohort
from supraspina_sidecar.cohort import CohortError, T1Resolution
from supraspina_sidecar.qc_store import QcStoreError


def _cfg(root: Path) -> dict[str, Any]:
    return {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(root / "rawdata"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "subjects": {"include": [], "exclude": []},
    }


def _t1(root: Path, subject_id: str, name: str | None = None) -> Path:
    path = root / "rawdata" / subject_id / "anat" / (name or f"{subject_id}_T1w.nii.gz")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(subject_id.encode())
    return path


@pytest.mark.parametrize("subject_id", ["", "../escape", "sub/01", "sub\\01", "a\0b"])
def test_resolve_t1_rejects_unsafe_subject_ids(tmp_path: Path, subject_id: str) -> None:
    result = cohort.resolve_t1({"paths": {"rawdataDir": str(tmp_path)}}, subject_id)
    assert result.state == "unsafe"
    assert result.path is None


def test_resolve_t1_distinguishes_missing_unsafe_ambiguous_and_resolved(
    tmp_path: Path,
) -> None:
    cfg = _cfg(tmp_path)
    assert cohort.resolve_t1(cfg, "sub-missing").state == "missing"

    _t1(tmp_path, "sub-unsafe")
    cfg["patterns"] = {"t1Pattern": "../*_T1w.nii.gz"}
    assert cohort.resolve_t1(cfg, "sub-unsafe").state == "unsafe"

    cfg["patterns"] = {"t1Pattern": "*_T1w.nii.gz"}
    first = _t1(tmp_path, "sub-many", "first_T1w.nii.gz")
    second = _t1(tmp_path, "sub-many", "second_T1w.nii.gz")
    ambiguous = cohort.resolve_t1(cfg, "sub-many")
    assert ambiguous.state == "ambiguous"
    assert ambiguous.candidates == tuple(sorted((str(first), str(second))))

    resolved_path = _t1(tmp_path, "sub-resolved")
    resolved = cohort.resolve_t1(cfg, "sub-resolved")
    assert resolved.state == "resolved"
    assert resolved.path == str(resolved_path)
    assert resolved.fingerprint == cohort._fingerprint(str(resolved_path))


def test_resolve_t1_enforces_candidate_bound_and_handles_read_race(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _cfg(tmp_path)
    path = _t1(tmp_path, "sub-01")
    monkeypatch.setattr(cohort, "_MAX_T1_CANDIDATES", 0)
    assert cohort.resolve_t1(cfg, "sub-01").state == "unsafe"

    monkeypatch.setattr(cohort, "_MAX_T1_CANDIDATES", 10)
    monkeypatch.setattr(
        cohort,
        "_fingerprint",
        lambda _path: (_ for _ in ()).throw(
            OSError("Remove the input during validation.")
        ),
    )
    raced = cohort.resolve_t1(cfg, "sub-01")
    assert raced.state == "missing"
    assert raced.candidates == (str(path),)


def test_resolve_t1_rejects_unsafe_pattern_and_follows_placed_symlink(
    tmp_path: Path,
) -> None:
    subject = tmp_path / "rawdata" / "sub-01"
    subject.mkdir(parents=True)
    outside = tmp_path / "outside_T1w.nii.gz"
    outside.write_bytes(b"outside")
    link = subject / "linked_T1w.nii.gz"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("Run this test only where symlinks are available.")

    unsafe = _cfg(tmp_path)
    unsafe["patterns"]["t1Pattern"] = "../*"
    assert cohort.resolve_t1(unsafe, "sub-01").state == "unsafe"
    # An operator's symlink placed inside the raw root is followed; the
    # resolution records the link target so provenance names the real file.
    resolved = cohort.resolve_t1(_cfg(tmp_path), "sub-01")
    assert resolved.state == "resolved"
    assert resolved.path == str(outside.resolve())


def test_discover_follows_symlinked_subject_folders(tmp_path: Path) -> None:
    elsewhere = tmp_path / "elsewhere" / "sub-02"
    (elsewhere / "anat").mkdir(parents=True)
    (elsewhere / "anat" / "sub-02_T1w.nii.gz").write_bytes(b"sub-02")
    _t1(tmp_path, "sub-01")
    try:
        (tmp_path / "rawdata" / "sub-02").symlink_to(
            elsewhere, target_is_directory=True
        )
    except OSError:
        pytest.skip("Run this test only where symlinks are available.")

    rows = {
        row.subject_id: row for row in cohort.discover_t1_resolutions(_cfg(tmp_path))
    }
    assert rows["sub-02"].state == "resolved"
    assert rows["sub-02"].path == str(
        (elsewhere / "anat" / "sub-02_T1w.nii.gz").resolve()
    )
    assert cohort.list_subject_ids(_cfg(tmp_path)) == ["sub-01", "sub-02"]


def test_resolve_t1_matches_the_pattern_regardless_of_case(tmp_path: Path) -> None:
    _t1(tmp_path, "sub-01", "sub-01_T1w.nii.gz")
    cfg = _cfg(tmp_path)
    cfg["patterns"]["t1Pattern"] = "*t1*.nii*"
    assert cohort.resolve_t1(cfg, "sub-01").state == "resolved"
    cfg["patterns"]["t1Pattern"] = "*_t1W.NII.GZ"
    assert cohort.resolve_t1(cfg, "sub-01").state == "resolved"
    cfg["patterns"]["t1Pattern"] = "*_T2w.nii.gz"
    assert cohort.resolve_t1(cfg, "sub-01").state == "missing"
    # A bracket expression is used as written.
    cfg["patterns"]["t1Pattern"] = "*_[T]1w.nii.gz"
    assert cohort.resolve_t1(cfg, "sub-01").state == "resolved"
    cfg["patterns"]["t1Pattern"] = "*_[t]1w.nii.gz"
    assert cohort.resolve_t1(cfg, "sub-01").state == "missing"


def test_discover_handles_invalid_config_missing_root_and_unsafe_glob(
    tmp_path: Path,
) -> None:
    assert cohort.discover_t1_resolutions([]) == []  # type: ignore[arg-type]
    assert cohort.discover_t1_resolutions(_cfg(tmp_path)) == []
    (tmp_path / "rawdata").mkdir()
    cfg = _cfg(tmp_path)
    cfg["patterns"] = {"subjectGlob": "../*"}
    with pytest.raises(CohortError, match="safe relative segment"):
        cohort.discover_t1_resolutions(cfg)


def test_discover_applies_safe_include_exclude_and_entry_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for subject_id in ("sub-01", "sub-02", "sub-03"):
        _t1(tmp_path, subject_id)
    cfg = _cfg(tmp_path)
    cfg["subjects"] = {
        "include": ["sub-01", "sub-02", "../unsafe"],
        "exclude": ["sub-02", "../unsafe"],
    }

    rows = cohort.discover_t1_resolutions(cfg)
    assert [row.subject_id for row in rows] == ["sub-01"]
    assert cohort.list_subject_ids(cfg) == ["sub-01"]

    monkeypatch.setattr(cohort, "_MAX_DISCOVERED_SUBJECTS", 0)
    with pytest.raises(CohortError, match="bounded entry limit"):
        cohort.discover_t1_resolutions(cfg)


def _write_qc(root: Path, value: Any) -> None:
    path = root / ".supraspina" / "qc_verdicts.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _review_evidence(
    *,
    reviewer: str = "reviewer",
    reviewed_at: str = "2026-07-31T12:00:00.000Z",
    run_id: str = "run-1234abcd",
    receipt_sha256: str = "a" * 64,
) -> dict[str, Any]:
    return {
        "evidenceVersion": 1,
        "reviewer": reviewer,
        "reviewedAt": reviewed_at,
        "galleries": [
            {
                "tab": tab,
                "label": label,
                "displayPath": f"outputs/qc/{tab}/report.html",
                "runId": run_id,
                "receiptSha256": receipt_sha256,
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


def _canonical_qc(
    verdicts: dict[str, str],
    *,
    evidence_by_subject: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    supplied_evidence = evidence_by_subject or {}
    return {
        "schemaVersion": 2,
        "verdicts": {
            subject_id: {
                "verdict": verdict,
                "note": "",
                "tags": [],
                "reviewEvidence": supplied_evidence.get(subject_id, _review_evidence()),
                "revision": 1,
                "updatedAt": "2026-07-23T12:00:00.000Z",
            }
            for subject_id, verdict in verdicts.items()
        },
    }


@pytest.mark.parametrize("value", [[], {"verdicts": []}])
def test_qc_records_reject_non_mapping_store(tmp_path: Path, value: Any) -> None:
    _write_qc(tmp_path, value)
    with pytest.raises(QcStoreError):
        cohort.load_qc_records(_cfg(tmp_path))


def test_qc_records_reject_semantically_invalid_fields_without_erasing_fail(
    tmp_path: Path,
) -> None:
    _write_qc(
        tmp_path,
        {
            "schemaVersion": 2,
            "verdicts": {
                "sub-fail": {
                    "verdict": "fail",
                    "revision": 1,
                    "note": "",
                    "tags": [],
                    "reviewEvidence": None,
                    "updatedAt": "2026-07-23T12:00:00.000Z",
                },
                "sub-invalid": {
                    "verdict": "unexpected",
                    "revision": 2,
                    "note": "",
                    "tags": [],
                    "reviewEvidence": None,
                    "updatedAt": "2026-07-23T12:01:00.000Z",
                },
            },
        },
    )
    path = tmp_path / ".supraspina" / "qc_verdicts.json"
    original = path.read_bytes()

    with pytest.raises(QcStoreError):
        cohort.load_qc_records(_cfg(tmp_path))
    assert path.read_bytes() == original


@pytest.mark.parametrize(
    ("row", "message"),
    [
        (
            T1Resolution("sub-01", "ambiguous", None, ("first", "second"), None),
            "Choose one T1 input",
        ),
        (T1Resolution("sub-01", "missing", None, (), None), "resolved T1 input"),
    ],
)
def test_cohort_snapshot_rejects_unresolved_t1_rows(
    monkeypatch: pytest.MonkeyPatch, row: T1Resolution, message: str
) -> None:
    monkeypatch.setattr(cohort, "discover_t1_resolutions", lambda _cfg: [row])
    with pytest.raises(CohortError, match=message):
        cohort.build_cohort_snapshot({}, acknowledge_qc_pending=True)


def test_cohort_snapshot_rejects_unsafe_unknown_and_outside_explicit_targets(
    tmp_path: Path,
) -> None:
    _t1(tmp_path, "sub-01")
    _write_qc(tmp_path, _canonical_qc({"sub-01": "pass"}))
    cfg = _cfg(tmp_path)

    with pytest.raises(CohortError, match="safe subject IDs"):
        cohort.build_cohort_snapshot(
            cfg, target_mode="explicit", subject_ids=["../unsafe"]
        )
    with pytest.raises(CohortError, match="outside the analysis cohort"):
        cohort.build_cohort_snapshot(
            cfg, target_mode="explicit", subject_ids=["sub-unknown"]
        )
    with pytest.raises(CohortError, match="known workflow target mode"):
        cohort.build_cohort_snapshot(cfg, target_mode="surprise")


def test_cohort_snapshot_preserves_analysis_order_and_explicit_selection_order(
    tmp_path: Path,
) -> None:
    for subject_id in ("sub-02", "sub-01"):
        _t1(tmp_path, subject_id)
    _write_qc(
        tmp_path,
        _canonical_qc({"sub-01": "pass", "sub-02": "pass"}),
    )

    snapshot = cohort.build_cohort_snapshot(
        _cfg(tmp_path),
        target_mode="explicit",
        subject_ids=["sub-02", "sub-01", "sub-02"],
    )

    assert snapshot.analysis_subject_ids == ("sub-01", "sub-02")
    assert snapshot.selected_subject_ids == ("sub-01", "sub-02")
    assert snapshot.t1_by_subject.keys() == {"sub-01", "sub-02"}
    assert snapshot.to_dict()["qcVerdicts"] == {
        "sub-01": "pass",
        "sub-02": "pass",
    }


@pytest.mark.parametrize("verdict", ["pass", "fail"])
def test_qc_decision_without_review_evidence_is_rejected(
    tmp_path: Path,
    verdict: str,
) -> None:
    _t1(tmp_path, "sub-01")
    _write_qc(
        tmp_path,
        {
            "schemaVersion": 2,
            "verdicts": {
                "sub-01": {
                    "verdict": verdict,
                    "note": "unreviewed decision",
                    "tags": [],
                    "reviewEvidence": None,
                    "revision": 1,
                    "updatedAt": "2026-07-23T12:00:00.000Z",
                }
            },
        },
    )

    with pytest.raises(QcStoreError, match="Include review evidence"):
        cohort.build_cohort_snapshot(_cfg(tmp_path))


@pytest.mark.parametrize(
    "changed_field",
    ["reviewer", "reviewedAt", "displayPath", "runId", "receiptSha256", "openedAt"],
)
def test_membership_digest_ignores_review_evidence(
    tmp_path: Path,
    changed_field: str,
) -> None:
    _t1(tmp_path, "sub-01")
    baseline_evidence = _review_evidence()
    _write_qc(
        tmp_path,
        _canonical_qc(
            {"sub-01": "pass"},
            evidence_by_subject={"sub-01": baseline_evidence},
        ),
    )
    baseline = cohort.build_cohort_snapshot(_cfg(tmp_path))
    changed_evidence = copy.deepcopy(baseline_evidence)
    if changed_field == "reviewer":
        changed_evidence["reviewer"] = "second-reviewer"
    elif changed_field == "reviewedAt":
        changed_evidence["reviewedAt"] = "2026-07-31T13:00:00.000Z"
    elif changed_field == "displayPath":
        changed_evidence["galleries"][0]["displayPath"] = (
            "outputs/qc/subcortical/revised.html"
        )
    elif changed_field == "runId":
        for gallery in changed_evidence["galleries"]:
            gallery["runId"] = "run-5678abcd"
    elif changed_field == "receiptSha256":
        for gallery in changed_evidence["galleries"]:
            gallery["receiptSha256"] = "b" * 64
    else:
        changed_evidence["galleries"][0]["openedAt"] = "2026-07-31T13:01:00.000Z"
    _write_qc(
        tmp_path,
        _canonical_qc(
            {"sub-01": "pass"},
            evidence_by_subject={"sub-01": changed_evidence},
        ),
    )

    changed = cohort.build_cohort_snapshot(_cfg(tmp_path))

    assert changed.analysis_subject_ids == baseline.analysis_subject_ids
    assert changed.qc_verdicts == baseline.qc_verdicts
    assert changed.analysis_digest == baseline.analysis_digest
    assert changed.selected_digest == baseline.selected_digest


def test_membership_digest_ignores_review_evidence_for_excluded_fail(
    tmp_path: Path,
) -> None:
    for subject_id in ("sub-pass", "sub-fail"):
        _t1(tmp_path, subject_id)
    pass_evidence = _review_evidence(reviewer="pass-reviewer")
    fail_evidence = _review_evidence(reviewer="fail-reviewer")
    evidence_by_subject = {
        "sub-pass": pass_evidence,
        "sub-fail": fail_evidence,
    }
    _write_qc(
        tmp_path,
        _canonical_qc(
            {"sub-pass": "pass", "sub-fail": "fail"},
            evidence_by_subject=evidence_by_subject,
        ),
    )
    baseline = cohort.build_cohort_snapshot(_cfg(tmp_path))
    changed_fail_evidence = copy.deepcopy(fail_evidence)
    changed_fail_evidence["reviewedAt"] = "2026-07-31T14:00:00.000Z"
    _write_qc(
        tmp_path,
        _canonical_qc(
            {"sub-pass": "pass", "sub-fail": "fail"},
            evidence_by_subject={
                **evidence_by_subject,
                "sub-fail": changed_fail_evidence,
            },
        ),
    )

    changed = cohort.build_cohort_snapshot(_cfg(tmp_path))

    assert (
        baseline.analysis_subject_ids == changed.analysis_subject_ids == ("sub-pass",)
    )
    assert baseline.excluded_by_qc == changed.excluded_by_qc == ("sub-fail",)
    assert baseline.analysis_digest == changed.analysis_digest


def test_equivalent_recovery_restriction_preserves_analysis_digest(
    tmp_path: Path,
) -> None:
    for subject_id in ("sub-01", "sub-02"):
        _t1(tmp_path, subject_id)
    _write_qc(
        tmp_path,
        _canonical_qc({"sub-01": "pass", "sub-02": "pass"}),
    )
    cfg = _cfg(tmp_path)

    fresh = cohort.build_cohort_snapshot(cfg)
    equivalent_recovery = cohort.build_cohort_snapshot(
        cfg,
        restrict_analysis_subject_ids=["sub-02", "sub-01"],
    )
    narrowed_recovery = cohort.build_cohort_snapshot(
        cfg,
        restrict_analysis_subject_ids=["sub-01"],
    )

    assert equivalent_recovery.analysis_subject_ids == fresh.analysis_subject_ids
    assert equivalent_recovery.analysis_digest == fresh.analysis_digest
    assert narrowed_recovery.analysis_subject_ids == ("sub-01",)
    assert narrowed_recovery.analysis_digest != fresh.analysis_digest


def _mixed_qc_project(root: Path) -> dict[str, Any]:
    """Write a cohort with Pass, Fail, Defer, unreviewed, and excluded rows."""
    for subject_id in ("sub-01", "sub-02", "sub-03", "sub-04", "sub-05"):
        _t1(root, subject_id)
    _write_qc(
        root,
        _canonical_qc(
            {"sub-01": "pass", "sub-02": "fail", "sub-03": "defer"},
            evidence_by_subject={
                "sub-01": _review_evidence(reviewer="pass-reviewer"),
                "sub-02": _review_evidence(reviewer="fail-reviewer"),
                "sub-03": _review_evidence(reviewer="defer-reviewer"),
            },
        ),
    )
    cfg = _cfg(root)
    cfg["subjects"]["exclude"] = ["sub-05"]
    return cfg


def test_analysis_cohort_helper_reproduces_the_planned_snapshot(
    tmp_path: Path,
) -> None:
    # The result inventory judges cohort stages through this helper, so it
    # must bind exactly what the planner binds.
    cfg = _mixed_qc_project(tmp_path)

    analysis = cohort.resolve_analysis_cohort(
        cohort.discover_t1_resolutions(cfg),
        cohort.load_qc_records(cfg),
        ("sub-05",),
    )

    assert analysis.subject_ids == ("sub-01", "sub-03", "sub-04")
    assert analysis.excluded_by_qc == ("sub-02",)
    assert analysis.pending_qc_subject_ids == ("sub-03", "sub-04")
    assert analysis.snapshot(acknowledged=True) == cohort.build_cohort_snapshot(
        cfg, acknowledge_qc_pending=True
    )
    assert analysis.snapshot(
        acknowledged=True, selected_subject_ids=("sub-03",)
    ) == cohort.build_cohort_snapshot(
        cfg,
        target_mode="explicit",
        subject_ids=["sub-03"],
        acknowledge_qc_pending=True,
    )
    assert cohort.load_project_qc_records(str(tmp_path)) == cohort.load_qc_records(cfg)


def test_analysis_digests_are_pinned(tmp_path: Path) -> None:
    # Every cohort receipt binds these digests, so a change to their formula
    # makes every cohort stage run again.
    mixed = cohort.build_cohort_snapshot(
        _mixed_qc_project(tmp_path / "mixed"), acknowledge_qc_pending=True
    )
    unreviewed_root = tmp_path / "unreviewed"
    for subject_id in ("sub-01", "sub-02", "sub-03"):
        _t1(unreviewed_root, subject_id)
    unreviewed = cohort.build_cohort_snapshot(
        _cfg(unreviewed_root), acknowledge_qc_pending=True
    )

    assert mixed.analysis_digest == (
        "b258bea06142b09190eadb46da854d7b4214461ef923f6857fa38a55d1168a14"
    )
    assert mixed.selected_digest == (
        "11baba7e1e657adb6ae8af72929a8b578206430986f1c8015f7e49656093c1ed"
    )
    assert unreviewed.analysis_digest == (
        "36006deee84a5f68257a26a88c0a541f8baca9e90070fff52fd8c3de033c5e68"
    )
    assert unreviewed.selected_digest == (
        "1b1382e8aa95b1fd9b03671e4c10cdb693d23e0409fe9eae5d6a4c13440f46ce"
    )


def _membership_rows(
    subjects: tuple[str, ...] = ("sub-01", "sub-02", "sub-03"),
    fingerprints: dict[str, str] | None = None,
) -> list[T1Resolution]:
    changed = fingerprints or {}
    return [
        T1Resolution(
            subject_id,
            "resolved",
            f"/raw/{subject_id}/anat/{subject_id}_T1w.nii.gz",
            (),
            changed.get(subject_id, f"t1-{subject_id}"),
        )
        for subject_id in subjects
    ]


def _records(
    verdicts: dict[str, str],
    *,
    evidence: dict[str, Any] | None = None,
    note: str = "",
) -> dict[str, dict[str, Any]]:
    return {
        subject_id: {
            "verdict": verdict,
            "note": note,
            "tags": [],
            "reviewEvidence": evidence or _review_evidence(),
            "revision": 1,
            "updatedAt": "2026-07-23T12:00:00.000Z",
        }
        for subject_id, verdict in verdicts.items()
    }


def _snapshot(
    records: dict[str, dict[str, Any]],
    *,
    rows: list[T1Resolution] | None = None,
    acknowledged: bool = True,
    excluded_by_config: tuple[str, ...] = (),
) -> cohort.CohortSnapshot:
    return cohort.resolve_analysis_cohort(
        _membership_rows() if rows is None else rows,
        records,
        excluded_by_config,
    ).snapshot(acknowledged=acknowledged)


def test_membership_digest_ignores_verdicts_evidence_and_acknowledgement() -> None:
    baseline = _snapshot({})
    subjects = ("sub-01", "sub-02", "sub-03")
    edited_evidence = _review_evidence(reviewer="second-reviewer")
    stores = {
        "all pass, no acknowledgement": (
            _records(dict.fromkeys(subjects, "pass")),
            False,
        ),
        "all pass, acknowledged": (_records(dict.fromkeys(subjects, "pass")), True),
        "pass and defer": (
            _records({"sub-01": "pass", "sub-02": "defer", "sub-03": "pass"}),
            True,
        ),
        "all defer": (_records(dict.fromkeys(subjects, "defer")), True),
        "evidence edited": (
            _records(dict.fromkeys(subjects, "pass"), evidence=edited_evidence),
            True,
        ),
        "notes edited": (
            _records(dict.fromkeys(subjects, "pass"), note="Rechecked."),
            True,
        ),
        # A Fail without gallery evidence is effectively unreviewed.
        "fail without evidence": (
            {"sub-02": {"verdict": "fail", "reviewEvidence": None}},
            True,
        ),
    }

    for label, (records, acknowledged) in stores.items():
        snapshot = _snapshot(records, acknowledged=acknowledged)
        assert snapshot.analysis_digest == baseline.analysis_digest, label
        assert snapshot.selected_digest == baseline.selected_digest, label
        # The snapshot keeps the real verdicts and acknowledgement.
        assert snapshot.qc_acknowledged is acknowledged, label
    reviewed = _snapshot(stores["pass and defer"][0])
    assert dict(reviewed.qc_verdicts)["sub-02"] == "defer"


def test_membership_digest_follows_membership() -> None:
    baseline = _snapshot({}).analysis_digest
    failed = _snapshot(_records({"sub-02": "fail"}))
    changed = {
        "evidence-backed fail": failed,
        "configuration exclusion": _snapshot(
            {},
            rows=_membership_rows(("sub-01", "sub-03")),
            excluded_by_config=("sub-02",),
        ),
        "T1 bytes": _snapshot(
            {}, rows=_membership_rows(fingerprints={"sub-02": "t1-changed"})
        ),
        "subject added": _snapshot(
            {}, rows=_membership_rows(("sub-01", "sub-02", "sub-03", "sub-04"))
        ),
        "subject removed": _snapshot({}, rows=_membership_rows(("sub-01", "sub-02"))),
        "narrowed recovery": _snapshot({}, rows=_membership_rows(("sub-01", "sub-03"))),
    }

    assert failed.excluded_by_qc == ("sub-02",)
    for label, snapshot in changed.items():
        assert snapshot.analysis_digest != baseline, label
    # Reverting the Fail restores the membership and its digest.
    assert _snapshot(_records({"sub-02": "pass"})).analysis_digest == baseline


def test_snapshot_scope_keys_and_binding_form() -> None:
    from supraspina_sidecar import results  # noqa: PLC0415

    records = _records({"sub-01": "pass", "sub-02": "defer", "sub-03": "pass"})
    snapshot = _snapshot(records)
    scope = snapshot.to_dict()

    assert set(scope) == {
        "analysisSubjectIds",
        "selectedSubjectIds",
        "analysisDigest",
        "selectedDigest",
        "t1",
        "qcVerdicts",
        "qcAcknowledged",
        "excludedByConfig",
        "excludedByQc",
    }
    assert results._cohort(scope) == snapshot


def test_project_root_rejects_unresolved_and_returns_canonical(tmp_path: Path) -> None:
    with pytest.raises(CohortError, match=r"Resolve paths\.projectRoot"):
        cohort.project_root({})
    assert cohort.project_root(_cfg(tmp_path)) == str(tmp_path.resolve())


def test_a_t1_witness_names_only_an_existing_regular_file(tmp_path: Path) -> None:
    assert cohort._t1_witness(str(tmp_path / "missing.nii.gz")) is None
    assert cohort._t1_witness(str(tmp_path)) is None
    # With no witness, the bytes are read, and a missing file raises.
    with pytest.raises(FileNotFoundError):
        cohort.remembered_fingerprint(str(tmp_path / "missing.nii.gz"))


def test_a_remembered_fingerprint_hashes_again_only_after_a_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    t1 = tmp_path / "sub-01_T1w.nii.gz"
    t1.write_bytes(b"first")
    reads: list[str] = []
    hash_file = cohort._hash_file

    def counted(path: str) -> str:
        reads.append(path)
        return hash_file(path)

    monkeypatch.setattr(cohort, "_hash_file", counted)
    first = cohort.remembered_fingerprint(str(t1))
    assert cohort.remembered_fingerprint(str(t1)) == first
    assert len(reads) == 1

    t1.write_bytes(b"second, longer")
    assert cohort.remembered_fingerprint(str(t1)) != first
    assert len(reads) == 2


def test_a_fingerprint_read_while_the_file_changed_is_not_remembered(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    t1 = tmp_path / "sub-01_T1w.nii.gz"
    t1.write_bytes(b"bytes")
    witnesses = iter([("before",), ("after",)])
    monkeypatch.setattr(cohort, "_t1_witness", lambda _path: next(witnesses))

    cohort._fingerprint(str(t1))

    assert ("before",) not in cohort._REMEMBERED_FINGERPRINTS
    assert ("after",) not in cohort._REMEMBERED_FINGERPRINTS
