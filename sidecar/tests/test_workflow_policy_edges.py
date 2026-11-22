"""Tests for pure workflow-policy edges covering acknowledgment, metadata, and blockers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import workflow
from supraspina_sidecar.adapters.base import Validation
from supraspina_sidecar.cohort import CohortSnapshot, T1Resolution


def _cohort(*subject_ids: str) -> CohortSnapshot:
    return CohortSnapshot(
        analysis_subject_ids=subject_ids,
        selected_subject_ids=subject_ids,
        analysis_digest="analysis",
        selected_digest="selected",
        t1=tuple(
            T1Resolution(subject_id, "resolved", None, (), f"fingerprint-{subject_id}")
            for subject_id in subject_ids
        ),
        qc_verdicts=tuple((subject_id, "pass") for subject_id in subject_ids),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def test_acknowledgement_defaults_and_shape_are_exact() -> None:
    assert workflow.validate_workflow_acknowledgements(None) == {
        "includeDeferredAndUnreviewedQc": False,
        "acknowledgeMemoryAdvisory": False,
    }
    with pytest.raises(ValueError, match="Provide acknowledgements as an object"):
        workflow.validate_workflow_acknowledgements([])


def test_cohort_role_blocker_distinguishes_ready_missing_and_ambiguous() -> None:
    subjects = tuple(f"sub-{index:02d}" for index in range(10))
    ready = {subject_id: {"cohortRole": "healthy"} for subject_id in subjects}
    assert workflow._cohort_role_blocker("Clinical", subjects, ready) is None

    missing = workflow._cohort_role_blocker("Clinical", subjects, {})
    assert missing is not None
    assert "Assign registry roles" in missing.reason
    assert "(+2 more)" in missing.reason
    assert "Resolve ambiguous registry roles" not in missing.reason
    assert missing.subjects == tuple(sorted(subjects))

    ambiguous_registry = {
        subject_id: {"cohortRole": "ambiguous"} for subject_id in subjects[:2]
    }
    ambiguous = workflow._cohort_role_blocker("Final", subjects[:2], ambiguous_registry)
    assert ambiguous is not None
    assert "Resolve ambiguous registry roles" in ambiguous.reason
    assert "Assign registry roles" not in ambiguous.reason
    assert ambiguous.subjects == tuple(sorted(subjects[:2]))


def test_cohort_role_blocker_keeps_every_sampled_and_unsampled_subject() -> None:
    """Keep prose bounded while the structured field names every subject."""
    subjects = tuple(f"sub-{index:02d}" for index in range(12))

    blocker = workflow._cohort_role_blocker("Clinical", subjects, {})

    assert blocker is not None
    assert "sub-00, sub-01, sub-02, sub-03, sub-04, sub-05, sub-06, sub-07 " in (
        blocker.reason
    )
    assert "(+4 more)" in blocker.reason
    assert "sub-11" not in blocker.reason
    assert blocker.subjects == tuple(sorted(subjects))
    assert workflow._cohort_blocker_entry("clinical", blocker) == {
        "key": "clinical",
        "reason": blocker.reason,
        "kind": "cohort",
        "subjects": list(sorted(subjects)),
        "subjectCount": 12,
        "action": "open-registry",
    }


def test_final_group_size_blocker_names_the_undersized_group_subjects() -> None:
    registry = {
        "sub-h1": {"cohortRole": "healthy"},
        "sub-h2": {"cohortRole": "healthy"},
        "sub-p1": {"cohortRole": "sci-neuropathic-pain"},
        "sub-n1": {"cohortRole": "sci-no-neuropathic-pain"},
    }

    blocker = workflow._final_group_size_blocker(tuple(registry), registry)

    assert blocker is not None
    assert "1 SCI_P subject, 1 SCI_nNP subject" in blocker.reason
    assert blocker.subjects == ("sub-n1", "sub-p1")


def test_age_outer_reconciliation_handles_every_bounded_input_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    metadata = tmp_path / "age.csv"
    cfg: dict[str, Any] = {
        "paths": {"ageMetadataFile": str(metadata)},
        "steps": {
            "age": {"params": {"join": "outer", "subjectIdColumn": "participant_id"}}
        },
    }
    cohort = _cohort("sub-01")

    assert workflow._age_outer_reconciliation(
        {"steps": {"age": {"params": {"join": "left"}}}}, cohort
    ) == (None, None)

    metadata.write_text("participant_id,Age\nsub-01,20\n", encoding="utf-8")
    monkeypatch.setattr(workflow.os.path, "getsize", lambda _path: 65 * 1024 * 1024)
    assert "bounded size" in str(workflow._age_outer_reconciliation(cfg, cohort)[1])

    monkeypatch.undo()
    metadata.write_text("wrong,Age\nsub-01,20\n", encoding="utf-8")
    assert "Add 'participant_id'" in str(
        workflow._age_outer_reconciliation(cfg, cohort)[1]
    )

    metadata.write_text("participant_id,Age\nsub-01,20\n", encoding="utf-8")
    monkeypatch.setattr(workflow, "_MAX_AGE_METADATA_COLUMNS", 1)
    assert "Reduce the age outer join metadata column count" in str(
        workflow._age_outer_reconciliation(cfg, cohort)[1]
    )

    monkeypatch.setattr(workflow, "_MAX_AGE_METADATA_COLUMNS", 512)
    monkeypatch.setattr(workflow, "_MAX_AGE_METADATA_ROWS", 0)
    assert "Reduce the age outer join metadata row count" in str(
        workflow._age_outer_reconciliation(cfg, cohort)[1]
    )

    metadata.unlink()
    assert "Provide readable age outer join metadata" in str(
        workflow._age_outer_reconciliation(cfg, cohort)[1]
    )


def test_scientific_blockers_are_step_specific() -> None:
    cohort = _cohort("sub-01")
    assert (
        workflow._scientific_blocker({}, "age", cohort, age_outer_blocker="age blocked")
        == "age blocked"
    )
    incompatible = {
        "steps": {"features": {"params": {"parcellation": "aparc", "measure": "area"}}}
    }
    assert "187-feature" in str(
        workflow._scientific_blocker(incompatible, "pybrainage", cohort)
    )
    compatible = {
        "steps": {
            "features": {
                "params": {"parcellation": "aparc.a2009s", "measure": "thickness"}
            }
        }
    }
    assert workflow._scientific_blocker(compatible, "pybrainage", cohort) is None


class _Adapter:
    advances: tuple[str, ...] = ()

    def __init__(self, *, blocking: tuple[str, ...] = ()) -> None:
        self.blocking = blocking

    def validate(self, _cfg: dict[str, Any], _env: dict[str, Any]) -> Validation:
        return Validation(blocking=self.blocking)

    def build_command(self, _cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        return ["scientific", subject_id or "cohort"]

    def preview(self, _cfg: dict[str, Any], subject_id: str | None) -> str:
        return f"scientific {subject_id or 'cohort'}"


def _request(root: Path, cfg: dict[str, Any], intent: dict[str, Any]) -> dict[str, Any]:
    return {
        "project": {"root": str(root)},
        "cfg": cfg,
        "configRevision": 1,
        "intent": intent,
        "acknowledgements": {"includeDeferredAndUnreviewedQc": False},
    }


def _review_evidence() -> dict[str, Any]:
    return {
        "evidenceVersion": 1,
        "reviewer": "workflow-policy-reviewer",
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


def _cfg(root: Path) -> dict[str, Any]:
    raw = root / "rawdata" / "sub-01" / "anat"
    raw.mkdir(parents=True)
    (raw / "sub-01_T1w.nii.gz").write_bytes(b"input")
    qc = root / ".supraspina" / "qc_verdicts.json"
    qc.parent.mkdir(parents=True)
    qc.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "verdicts": {
                    "sub-01": {
                        "verdict": "pass",
                        "note": "",
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
    return {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(root / "rawdata"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "steps": {"recon": {"enabled": True, "params": {}}},
    }


def test_plan_invalid_intent_explicit_empty_and_empty_stage_are_stable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _cfg(tmp_path)
    monkeypatch.setitem(workflow.ADAPTERS, "recon", _Adapter())

    invalid = workflow.build_plan(_request(tmp_path, cfg, {"kind": "surprise"}))
    assert invalid.result["disposition"] == "blocked"
    assert invalid.result["summary"]["message"] == "Select a valid workflow intent."

    empty_workflow = workflow.build_plan(
        _request(
            tmp_path,
            cfg,
            {"kind": "workflow", "target": {"mode": "explicit", "subjectIds": []}},
        )
    )
    assert empty_workflow.result["disposition"] == "noop"
    assert empty_workflow.result["plan"]["nodes"] == []

    empty_stage = workflow.build_plan(
        _request(
            tmp_path,
            cfg,
            {
                "kind": "stage",
                "stepKey": "recon",
                "target": {"mode": "explicit", "subjectIds": []},
            },
        )
    )
    assert empty_stage.result["disposition"] == "noop"
    assert empty_stage.result["plan"]["nodes"] == []


def test_plan_warnings_state_facts_and_stay_outside_the_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _cfg(tmp_path)
    monkeypatch.setitem(workflow.ADAPTERS, "recon", _Adapter())

    planned = workflow.build_plan(
        _request(
            tmp_path,
            cfg,
            {"kind": "stage", "stepKey": "recon", "target": {"mode": "all"}},
        ),
        env_report={},
    )

    assert planned.warnings[0] == (
        "runtime.memoryWarningGB is an advisory threshold; it never changes "
        "scientific execution."
    )
    # Warnings reach run state only: the plan, which the plan digest covers,
    # never carries their text.
    rendered_plan = json.dumps(planned.result, sort_keys=True)
    assert all(warning not in rendered_plan for warning in planned.warnings)


def test_plan_memory_missing_adapter_and_validation_blockers_are_distinct(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _cfg(tmp_path)
    request = _request(
        tmp_path,
        cfg,
        {"kind": "stage", "stepKey": "recon", "target": {"mode": "all"}},
    )
    cfg["runtime"] = {"memoryWarningGB": 10, "dryRun": False}
    monkeypatch.setitem(workflow.ADAPTERS, "recon", _Adapter())
    memory = workflow.build_plan(request, env_report={"availableMemoryGB": 1})
    assert memory.result["plan"]["blockers"][0]["kind"] == "safety"

    cfg["runtime"]["dryRun"] = True
    monkeypatch.delitem(workflow.ADAPTERS, "recon")
    missing = workflow.build_plan(request, env_report={"availableMemoryGB": 1})
    assert missing.result["plan"]["blockers"][0]["kind"] == "config"

    monkeypatch.setitem(
        workflow.ADAPTERS,
        "recon",
        _Adapter(blocking=("Install the required tool.",)),
    )
    blocked = workflow.build_plan(request, env_report={})
    assert blocked.result["plan"]["blockers"][0] == {
        "key": "recon",
        "reason": "Install the required tool.",
        "kind": "environment",
        "subjects": ["sub-01"],
    }
