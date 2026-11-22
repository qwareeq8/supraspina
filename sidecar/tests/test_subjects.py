"""Tests for the subject-discovery subsystem in ``__main__``.

Discovery lists subject directories under the resolved ``rawdataDir`` that match
``patterns.subjectGlob`` and builds one Subject dict per safe row. Missing and
ambiguous T1 inputs stay visible but ineligible. Each subject's ten ``cells``,
aligned by index to ``MATRIX_COLUMNS``, start as pending and advance as each
adapter's ``detect`` result maps onto its owned matrix columns. A raising
detector does not abort discovery; it produces a visible integrity error instead
of being treated as ordinary pending work.

Completion detectors are exercised through sentinel adapters injected over the
module's ``ADAPTERS`` registry and ``_ADAPTER_ORDER``, keeping column mapping,
exception handling, and state translation deterministic without touching real
tool artifacts.
"""

from __future__ import annotations

import json
import os
from typing import Any

import supraspina_sidecar.__main__ as main_module
from supraspina_sidecar.__main__ import (
    _STATE_MAP,
    MATRIX_COLUMNS,
    _discover,
    _empty_cell,
    _refresh_one,
    _subject_record,
)
from supraspina_sidecar.adapters.base import StepStatus
from supraspina_sidecar.adapters.tools import read_csv_member_ids


def _cfg(
    rawdata_dir: str, derivatives_dir: str = "/proj/no_such_derivatives"
) -> dict[str, Any]:
    """Return a discovery config with a real rawdata root and an absent deriv root.

    Keep the derivatives root nonexistent so the real adapters' on-disk
    detectors report pending. Isolate the discovery logic.
    """
    return {
        "paths": {
            "projectRoot": os.path.dirname(rawdata_dir),
            "rawdataDir": rawdata_dir,
            "derivativesDir": derivatives_dir,
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
    }


def _write(path: str) -> None:
    """Create ``path`` and any parent directories, writing a single byte."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("x")


def _review_evidence() -> dict[str, Any]:
    return {
        "evidenceVersion": 1,
        "reviewer": "subject-test-reviewer",
        "reviewedAt": "2026-07-23T12:00:00.000Z",
        "galleries": [
            {
                "tab": tab,
                "label": label,
                "displayPath": f"outputs/qc/{tab}.html",
                "runId": "run-1234abcd",
                "receiptSha256": "a" * 64,
                "openedAt": "2026-07-23T11:59:00.000Z",
            }
            for tab, label in (
                ("subcortical", "Subcortical QC gallery"),
                ("internal", "Cortical-internal QC gallery"),
                ("external", "Cortical-external QC gallery"),
            )
        ],
    }


class _StateAdapter:
    """Report a fixed state for the given columns from a sentinel adapter."""

    def __init__(self, advances: tuple[str, ...], state: str) -> None:
        self.advances = advances
        self._state = state

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        return StepStatus(state=self._state)


class _RaisingAdapter:
    """Model a filesystem failure by raising from a sentinel detector."""

    def __init__(self, advances: tuple[str, ...]) -> None:
        self.advances = advances

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        raise RuntimeError("Raise a detector failure.")


class _ResolvedT1Adapter:
    """Require discovery's authoritative resolved T1 map from a sentinel adapter."""

    advances: tuple[str, ...] = ()

    def __init__(self, expected_path: str) -> None:
        self._expected_path = expected_path

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        runtime = cfg.get("_supraspinaRuntime", {})
        t1_by_subject = (
            runtime.get("t1BySubject", {}) if isinstance(runtime, dict) else {}
        )
        state = (
            "done"
            if isinstance(t1_by_subject, dict)
            and t1_by_subject.get(subject_id) == self._expected_path
            else "pending"
        )
        return StepStatus(state=state)


def _patch_registry(
    monkeypatch: Any, registry: dict[str, Any], order: tuple[str, ...]
) -> None:
    """Swap the module's adapter registry and resolution order for sentinels."""
    monkeypatch.setattr(main_module, "ADAPTERS", registry)
    monkeypatch.setattr(main_module, "_ADAPTER_ORDER", order)


# -- (a) one subject with len(MATRIX_COLUMNS) pending cells ---------------------


def test_discover_anat_t1_yields_one_pending_subject(tmp_path: Any) -> None:
    raw = tmp_path / "rawdata"
    _write(str(raw / "sub-001" / "anat" / "sub-001_T1w.nii.gz"))

    subjects = _discover([_cfg(str(raw))], lambda *_: None)

    assert len(subjects) == 1
    subject = subjects[0]
    assert subject["id"] == "sub-001"
    assert len(subject["cells"]) == len(MATRIX_COLUMNS)
    assert all(cell["st"] == "pending" for cell in subject["cells"])
    assert all(cell["rc"] is None for cell in subject["cells"])


def test_discover_subject_record_default_metadata(tmp_path: Any) -> None:
    raw = tmp_path / "rawdata"
    _write(str(raw / "sub-001" / "anat" / "sub-001_T1w.nii.gz"))

    subject = _discover([_cfg(str(raw))], lambda *_: None)[0]

    assert subject["age"] is None
    assert subject["registered"] is False
    assert subject["sex"] == "O"
    assert subject["cohort"] == "UNKNOWN"
    assert subject["analysisEligible"] is True
    assert subject["ais"] is None
    assert subject["tSinceSci"] is None
    assert subject["qc"] is None
    assert subject["notes"] == ""


def test_subject_record_marks_a_registered_subject_and_keeps_its_age(
    monkeypatch: Any,
) -> None:
    _patch_registry(monkeypatch, {}, ())

    subject = _subject_record(
        {},
        "sub-001",
        registry_record={
            "age": 54.7,
            "sex": "F",
            "cohortRole": "healthy",
            "sourceCohortLabel": "CTRL",
        },
    )

    assert subject["registered"] is True
    assert subject["age"] == 54.7
    assert subject["sex"] == "F"

    unknown_age = _subject_record(
        {},
        "sub-002",
        registry_record={
            "age": None,
            "sex": "M",
            "cohortRole": "healthy",
            "sourceCohortLabel": "CTRL",
        },
    )

    assert unknown_age["registered"] is True
    assert unknown_age["age"] is None


def test_discover_binds_nested_resolved_t1_for_detectors(
    monkeypatch: Any,
    tmp_path: Any,
) -> None:
    raw = tmp_path / "rawdata"
    t1 = (
        raw
        / "sub-001"
        / "ses-baseline"
        / "anat"
        / "sub-001_ses-baseline_acq-prisma_T1w.nii.gz"
    )
    _write(str(t1))
    _patch_registry(
        monkeypatch,
        {"brainfov": _ResolvedT1Adapter(str(t1.resolve()))},
        ("brainfov",),
    )

    subject = _discover([_cfg(str(raw))], lambda *_: None)[0]

    assert subject["stepStates"]["brainfov"] == "done"


def test_analysis_eligibility_depends_only_on_evidence_backed_qc_fail(
    monkeypatch: Any,
) -> None:
    _patch_registry(monkeypatch, {}, ())
    registry_record = {
        "cohortRole": "ambiguous",
        "sourceCohortLabel": "unmapped-source-label",
    }

    for verdict in (None, "pass", "fail", "defer", "unreviewed"):
        qc_record = {} if verdict is None else {"verdict": verdict}
        subject = _subject_record(
            {}, "sub-001", registry_record=registry_record, qc_record=qc_record
        )
        assert subject["analysisEligible"] is True
        assert subject["qc"] == ("defer" if verdict == "defer" else None)
        assert subject["recordedQcVerdict"] == (
            verdict if verdict in {"pass", "fail", "defer"} else None
        )
        assert subject["qcReviewEvidencePresent"] is False
        assert subject["cohortRole"] == "ambiguous"
        assert subject["cohort"] == "UNKNOWN"

    failed = _subject_record(
        {},
        "sub-001",
        registry_record=registry_record,
        qc_record={"verdict": "fail", "reviewEvidence": _review_evidence()},
    )
    assert failed["analysisEligible"] is False
    assert failed["qc"] == "fail"
    assert failed["recordedQcVerdict"] == "fail"
    assert failed["qcReviewEvidencePresent"] is True


def test_discover_projects_evidence_backed_pass_and_fail(
    tmp_path: Any,
) -> None:
    raw = tmp_path / "rawdata"
    for subject_id in ("sub-pass", "sub-fail"):
        _write(str(raw / subject_id / "anat" / f"{subject_id}_T1w.nii.gz"))
    qc_path = tmp_path / ".supraspina" / "qc_verdicts.json"
    qc_path.parent.mkdir(exist_ok=True)
    qc_path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "verdicts": {
                    subject_id: {
                        "verdict": verdict,
                        "note": "reviewed record",
                        "tags": ["reviewed"],
                        "reviewEvidence": _review_evidence(),
                        "revision": 1,
                        "updatedAt": "2026-07-23T12:00:00.000Z",
                    }
                    for subject_id, verdict in (
                        ("sub-pass", "pass"),
                        ("sub-fail", "fail"),
                    )
                },
            }
        ),
        encoding="utf-8",
    )

    reviewed = {
        subject["id"]: subject
        for subject in _discover([_cfg(str(raw))], lambda *_: None)
    }

    assert reviewed["sub-pass"]["qc"] == "pass"
    assert reviewed["sub-pass"]["analysisEligible"] is True
    assert reviewed["sub-fail"]["qc"] == "fail"
    assert reviewed["sub-fail"]["analysisEligible"] is False
    assert all(subject["qcReviewEvidencePresent"] for subject in reviewed.values())


def test_discover_surfaces_subject_without_t1_as_ineligible(tmp_path: Any) -> None:
    raw = tmp_path / "rawdata"
    _write(str(raw / "sub-001" / "anat" / "sub-001_T1w.nii.gz"))
    # Add a second subject directory without a T1w file.
    os.makedirs(str(raw / "sub-002" / "anat"), exist_ok=True)
    _write(str(raw / "sub-002" / "anat" / "sub-002_FLAIR.nii.gz"))

    subjects = _discover([_cfg(str(raw))], lambda *_: None)

    assert [subject["id"] for subject in subjects] == ["sub-001", "sub-002"]
    missing = subjects[1]
    assert missing["t1Availability"] == "missing"
    assert missing["analysisEligible"] is False
    assert "Provide a T1 input" in missing["unavailableReason"]


def test_discover_surfaces_ambiguous_t1_candidates(tmp_path: Any) -> None:
    raw = tmp_path / "rawdata"
    _write(str(raw / "sub-001" / "anat" / "first_T1w.nii.gz"))
    _write(str(raw / "sub-001" / "anat" / "second_T1w.nii.gz"))

    subject = _discover([_cfg(str(raw))], lambda *_: None)[0]

    assert subject["t1Availability"] == "ambiguous"
    assert subject["analysisEligible"] is False
    assert "Select one T1 input" in subject["unavailableReason"]


# -- (c) a sentinel detector returning done maps its columns -------------------


def test_subject_record_done_detector_maps_columns(monkeypatch: Any) -> None:
    _patch_registry(
        monkeypatch,
        {"recon": _StateAdapter(("recon",), "done")},
        ("recon",),
    )

    record = _subject_record({}, "sub-001")
    cells = record["cells"]
    recon_index = MATRIX_COLUMNS.index("recon")

    assert cells[recon_index]["st"] == "done"
    assert cells[recon_index]["rc"] == 0
    for index, cell in enumerate(cells):
        if index == recon_index:
            continue
        assert cell["st"] == "pending"
        assert cell["rc"] is None


def test_subject_record_done_detector_multi_column(monkeypatch: Any) -> None:
    # Advance all three QC columns from one done adapter state.
    _patch_registry(
        monkeypatch,
        {"enigma": _StateAdapter(("qcsub", "qcic", "qcec"), "done")},
        ("enigma",),
    )

    cells = _subject_record({}, "sub-001")["cells"]

    for column in ("qcsub", "qcic", "qcec"):
        cell = cells[MATRIX_COLUMNS.index(column)]
        assert cell["st"] == "done"
        assert cell["rc"] == 0


# -- (d) a raising detector degrades to pending without aborting ---------------


def test_subject_record_raising_detector_surfaces_integrity_error(
    monkeypatch: Any,
) -> None:
    _patch_registry(
        monkeypatch,
        {
            "recon": _RaisingAdapter(("recon",)),
            "features": _StateAdapter(("feat",), "done"),
        },
        ("recon", "features"),
    )

    subject = _subject_record({}, "sub-001")
    cells = subject["cells"]
    recon_cell = cells[MATRIX_COLUMNS.index("recon")]
    feat_cell = cells[MATRIX_COLUMNS.index("feat")]

    # Continue discovery without advancing the raising detector's column.
    assert recon_cell["st"] == "pending"
    assert recon_cell["rc"] is None
    # Map a later healthy detector's column to done.
    assert feat_cell["st"] == "done"
    assert feat_cell["rc"] == 0
    # State which stage's detector failed, by the name the app gives the
    # stage, and only the exception type: its message may hold a path.
    assert subject["integrityErrors"] == [
        "The Reconstruction detector failed (RuntimeError)."
    ]


def test_subject_record_names_an_unregistered_detector_by_its_key(
    monkeypatch: Any,
) -> None:
    _patch_registry(monkeypatch, {"retired": _RaisingAdapter(())}, ("retired",))

    subject = _subject_record({}, "sub-001")

    assert subject["integrityErrors"] == ["The retired detector failed (RuntimeError)."]


# -- (e) the partial -> pending _STATE_MAP translation -------------------------


def test_state_map_partial_translates_to_pending() -> None:
    assert _STATE_MAP["partial"] == "pending"
    assert _STATE_MAP["pending"] == "pending"
    assert _STATE_MAP["done"] == "done"
    assert _STATE_MAP["running"] == "running"
    assert _STATE_MAP["failed"] == "failed"
    assert _STATE_MAP["skipped"] == "skipped"


def test_subject_record_partial_detector_stays_pending(monkeypatch: Any) -> None:
    _patch_registry(
        monkeypatch,
        {"recon": _StateAdapter(("recon",), "partial")},
        ("recon",),
    )

    cell = _subject_record({}, "sub-001")["cells"][MATRIX_COLUMNS.index("recon")]
    # Report partial detection as pending without setting a return code.
    assert cell["st"] == "pending"
    assert cell["rc"] is None


# -- (f) _refresh_one returns the same Subject shape for one id ----------------


def test_refresh_one_matches_subject_record_shape(tmp_path: Any) -> None:
    raw = tmp_path / "rawdata"
    _write(str(raw / "sub-007" / "anat" / "sub-007_T1w.nii.gz"))
    cfg = _cfg(str(raw))
    refreshed = _refresh_one([cfg, "sub-007"], lambda *_: None)
    record = _subject_record(cfg, "sub-007")

    assert refreshed["id"] == "sub-007"
    assert sorted(refreshed.keys()) == sorted(record.keys())
    assert len(refreshed["cells"]) == len(MATRIX_COLUMNS)


def test_refresh_one_reflects_done_detector(monkeypatch: Any, tmp_path: Any) -> None:
    _patch_registry(
        monkeypatch,
        {"recon": _StateAdapter(("recon",), "done")},
        ("recon",),
    )

    raw = tmp_path / "rawdata"
    _write(str(raw / "sub-007" / "anat" / "sub-007_T1w.nii.gz"))
    cells = _refresh_one([_cfg(str(raw)), "sub-007"], lambda *_: None)["cells"]
    recon_cell = cells[MATRIX_COLUMNS.index("recon")]
    assert recon_cell["st"] == "done"
    assert recon_cell["rc"] == 0


def test_refresh_one_binds_nested_resolved_t1_for_detectors(
    monkeypatch: Any,
    tmp_path: Any,
) -> None:
    raw = tmp_path / "rawdata"
    t1 = (
        raw
        / "sub-007"
        / "ses-baseline"
        / "anat"
        / "sub-007_ses-baseline_acq-prisma_T1w.nii.gz"
    )
    _write(str(t1))
    _patch_registry(
        monkeypatch,
        {"brainfov": _ResolvedT1Adapter(str(t1.resolve()))},
        ("brainfov",),
    )

    refreshed = _refresh_one([_cfg(str(raw)), "sub-007"], lambda *_: None)

    assert refreshed["stepStates"]["brainfov"] == "done"


# -- (g) a missing rawdata dir yields an empty list ----------------------------


def test_discover_missing_rawdata_returns_empty(tmp_path: Any) -> None:
    missing = tmp_path / "does_not_exist"
    assert _discover([_cfg(str(missing))], lambda *_: None) == []


def test_discover_blank_rawdata_returns_empty() -> None:
    cfg = {"paths": {"rawdataDir": ""}, "patterns": {}}
    assert _discover([cfg], lambda *_: None) == []


def test_discover_non_dict_config_returns_empty() -> None:
    assert _discover(["not-a-config"], lambda *_: None) == []


# -- _empty_cell shape ---------------------------------------------------------


def test_empty_cell_is_pending_with_null_fields() -> None:
    cell = _empty_cell()
    assert cell == {
        "st": "pending",
        "startedAt": None,
        "finishedAt": None,
        "progress": None,
        "rc": None,
        "err": None,
    }


# -- (e) a cohort step is done only for subjects its output lists -------------


class _MemberAdapter(_StateAdapter):
    """Report ``done`` cohort-wide but list only some subjects as covered."""

    def __init__(self, advances: tuple[str, ...], covered: frozenset[str] | None):
        super().__init__(advances, "done")
        self.covered = covered

    def members(self, cfg: dict[str, Any]) -> frozenset[str] | None:
        del cfg
        return self.covered


def test_subject_record_demotes_done_for_subject_outside_cohort_output(
    monkeypatch: Any,
) -> None:
    _patch_registry(
        monkeypatch,
        {"pybrainage": _MemberAdapter(("pba",), frozenset({"sub-001"}))},
        ("pybrainage",),
    )

    listed = _subject_record({}, "sub-001")
    unlisted = _subject_record({}, "sub-002")
    pba = MATRIX_COLUMNS.index("pba")

    assert listed["cells"][pba]["st"] == "done"
    assert listed["stepStates"]["pybrainage"] == "done"
    assert unlisted["cells"][pba]["st"] == "pending"
    assert unlisted["cells"][pba]["rc"] is None
    assert unlisted["stepStates"]["pybrainage"] == "pending"


def test_subject_record_keeps_done_when_membership_is_unknown(
    monkeypatch: Any,
) -> None:
    _patch_registry(
        monkeypatch,
        {"pybrainage": _MemberAdapter(("pba",), None)},
        ("pybrainage",),
    )

    record = _subject_record({}, "sub-009")

    assert record["cells"][MATRIX_COLUMNS.index("pba")]["st"] == "done"


def test_subject_record_bounds_an_unlisted_cohort_output_by_its_inputs(
    monkeypatch: Any,
) -> None:
    # The R analysis tables list no subjects, so its done state must not reach
    # subjects added after it ran; otherwise the renderer marks that cell
    # out of date and never-processed subjects count as Partly done.
    _patch_registry(
        monkeypatch,
        {
            "aggregate": _MemberAdapter(("agg",), frozenset({"sub-001"})),
            "final": _StateAdapter(("rep",), "done"),
        },
        ("aggregate", "final"),
    )

    listed = _subject_record({}, "sub-001")
    added = _subject_record({}, "sub-new")
    rep = MATRIX_COLUMNS.index("rep")

    assert listed["cells"][rep]["st"] == "done"
    assert listed["stepStates"]["final"] == "done"
    assert added["cells"][rep]["st"] == "pending"
    assert added["stepStates"]["final"] == "pending"


def test_subject_record_keeps_an_unlisted_cohort_output_when_inputs_are_unknown(
    monkeypatch: Any,
) -> None:
    _patch_registry(
        monkeypatch,
        {
            "aggregate": _MemberAdapter(("agg",), None),
            "final": _StateAdapter(("rep",), "done"),
        },
        ("aggregate", "final"),
    )

    record = _subject_record({}, "sub-new")

    assert record["cells"][MATRIX_COLUMNS.index("rep")]["st"] == "done"


def test_read_csv_member_ids_reads_the_named_column(tmp_path: Any) -> None:
    path = tmp_path / "predicted_results.csv"
    path.write_text("ID,Age,BrainAge,BrainPAD\nsub-001,40,42,2\n sub-002 ,30,29,-1\n")

    assert read_csv_member_ids(str(path), "ID") == frozenset({"sub-001", "sub-002"})
    assert read_csv_member_ids(str(path), "SubjID") is None
    assert read_csv_member_ids(str(tmp_path / "missing.csv"), "ID") is None
    assert read_csv_member_ids(str(path), "ID", max_rows=1) is None


class _BrainChartsSentinel:
    """Model a finished BrainCharts run whose split refuses one site."""

    advances: tuple[str, ...] = ()

    def __init__(self, roles: dict[str, tuple[str, str]] | None) -> None:
        self._roles_by_subject = roles

    def out_dir(self, cfg: dict[str, Any]) -> str:
        return "/proj/outputs/braincharts"

    def roles(self, out_dir: str) -> dict[str, tuple[str, str]]:
        if self._roles_by_subject is None:
            raise ValueError("The subject-role table is missing.")
        return self._roles_by_subject

    def members(self, cfg: dict[str, Any]) -> frozenset[str] | None:
        return (
            None
            if self._roles_by_subject is None
            else frozenset(self._roles_by_subject)
        )

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        return StepStatus(state="done")


def test_norm_column_shows_braincharts_and_skips_refused_subjects(
    monkeypatch: Any,
) -> None:
    roles = {
        "sub-adapt": ("adaptation", "Prisma"),
        "sub-test": ("test", "Prisma"),
        "sub-refused": ("refused", "Ingenia"),
    }
    _patch_registry(
        monkeypatch, {"braincharts": _BrainChartsSentinel(roles)}, ("braincharts",)
    )
    norm = MATRIX_COLUMNS.index("norm")
    assert MATRIX_COLUMNS[norm - 1] == "pba"

    states = {
        subject_id: _subject_record({}, subject_id)
        for subject_id in ("sub-adapt", "sub-test", "sub-refused")
    }

    assert states["sub-adapt"]["cells"][norm]["st"] == "done"
    assert states["sub-test"]["cells"][norm]["st"] == "done"
    # A refused site's subject gets no z-scores, so its Norm cell is skipped,
    # while the stage itself is done for it and z-score comparisons may run.
    assert states["sub-refused"]["cells"][norm]["st"] == "skipped"
    assert states["sub-refused"]["cells"][norm]["rc"] is None
    assert {
        subject_id: subject["stepStates"]["braincharts"]
        for subject_id, subject in states.items()
    } == dict.fromkeys(states, "done")


def test_norm_column_follows_the_stage_when_the_split_is_unreadable(
    monkeypatch: Any,
) -> None:
    _patch_registry(
        monkeypatch, {"braincharts": _BrainChartsSentinel(None)}, ("braincharts",)
    )
    subject = _subject_record({}, "sub-any")

    assert subject["cells"][MATRIX_COLUMNS.index("norm")]["st"] == "done"
