"""Tests for authoritative cohort planning and recovery-closure behavior."""

from __future__ import annotations

import io
import json
import os
import re
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import paths, runtime_resources, workflow
from supraspina_sidecar.__main__ import build_dispatcher
from supraspina_sidecar.adapters.base import Validation
from supraspina_sidecar.adapters.final import FinalAdapter
from supraspina_sidecar.cohort import CohortSnapshot, T1Resolution
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.registry import STEP_BY_KEY
from supraspina_sidecar.registry_store import RegistryStore
from supraspina_sidecar.rpc import Emitter
from supraspina_sidecar.run_store import RunStore
from supraspina_sidecar.workflow import RuntimeCfgInputs, build_plan, runtime_cfg
from supraspina_sidecar.workflow_manager import (
    TERMINAL_ERROR_JOB_STATES,
    WorkflowManager,
    _resume_intent,
    _RunContext,
    _terminal_job_error_message,
)


class _Emitter:
    def emit(self, _method: str, _params: dict[str, Any]) -> None:
        return None


class _Adapter:
    def __init__(self, key: str) -> None:
        self.key = key

    def validate(self, _cfg: dict[str, Any], _env: dict[str, Any]) -> Validation:
        return Validation()

    def build_command(self, _cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        return [self.key, subject_id or "cohort"]

    def preview(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        return " ".join(self.build_command(cfg, subject_id))

    def output_path(self, cfg: dict[str, Any], subject_id: str) -> str:
        return str(
            Path(cfg["paths"]["derivativesDir"])
            / "defaced"
            / subject_id
            / f"{subject_id}_T1w.nii.gz"
        )

    def preflight_signature(self, _cfg: dict[str, Any], _subject_id: str) -> str:
        return "a" * 64


def _cfg(root: Path, subject_ids: list[str], step: str) -> dict[str, Any]:
    raw = root / "rawdata"
    for subject_id in subject_ids:
        path = raw / subject_id / "anat" / f"{subject_id}_T1w.nii.gz"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(subject_id.encode())
    return {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(raw),
            "derivativesDir": str(root / "derivatives"),
            "outputDir": str(root / "output"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "subjects": {"include": [], "exclude": []},
        "runtime": {"dryRun": True},
        "steps": {step: {"enabled": True, "params": {}}},
    }


def _request(
    root: Path, cfg: dict[str, Any], step: str, target: dict[str, Any]
) -> dict[str, Any]:
    return {
        "project": {
            "projectId": "planning-project",
            "root": str(root),
            "configPath": str(root / "supraspina.project.json"),
            "epoch": 1,
        },
        "cfg": cfg,
        "configRevision": 1,
        "intent": {"kind": "stage", "stepKey": step, "target": target},
        "acknowledgements": {"includeDeferredAndUnreviewedQc": True},
    }


def _review_evidence() -> dict[str, Any]:
    return {
        "evidenceVersion": 1,
        "reviewer": "workflow-planning-reviewer",
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


def _write_qc(root: Path, verdicts: dict[str, str]) -> None:
    path = root / ".supraspina" / "qc_verdicts.json"
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
                        "reviewEvidence": _review_evidence(),
                        "revision": 1,
                        "updatedAt": "2026-07-23T12:00:00.000Z",
                    }
                    for subject_id, verdict in verdicts.items()
                },
            }
        ),
        encoding="utf-8",
    )


_CHECK_LABELS = {
    "reconall": "recon-all",
    "fshome": "FreeSurfer home",
    "license": "FreeSurfer license",
    "featurepython": "Feature extraction Python",
    "aparcstats": "aparcstats2table",
    "asegstats": "asegstats2table",
    "features_assets": "Feature extraction assets",
}

_FREESURFER_FOUND = {"reconall": "found", "fshome": "found", "license": "found"}


def _env_report(statuses: dict[str, str]) -> dict[str, Any]:
    """Return one environment report carrying the given check statuses.

    Parameters
    ----------
    statuses
        Map each environment-check id to its reported status.

    Returns
    -------
    dict
        Return an ``EnvReport`` with one group holding the named checks.
    """
    return {
        "groups": [
            {
                "checks": [
                    {
                        "id": check_id,
                        "label": _CHECK_LABELS[check_id],
                        "status": status,
                    }
                    for check_id, status in statuses.items()
                ]
            }
        ],
        "availableMemoryGB": 24,
    }


def _install_active_resources(
    monkeypatch: pytest.MonkeyPatch,
    *,
    cpu: bool = True,
    cuda: bool = False,
    cuda_ready: bool = False,
) -> None:
    """Resolve managed FastSurfer resources exactly as a provisioned host does.

    Parameters
    ----------
    monkeypatch
        Provide the pytest patcher for the resource resolver module.
    cpu
        Activate the verified CPU SIF when true.
    cuda
        Activate the verified CUDA SIF when true.
    cuda_ready
        Pass the in-container CUDA smoke when true.
    """

    def _active_fastsurfer(_root: Path, pin: Any) -> Path | None:
        if pin.variant == "cpu" and cpu:
            return Path("/managed/fastsurfer-cpu.sif")
        if pin.variant == "cuda" and cuda:
            return Path("/managed/fastsurfer-cuda.sif")
        return None

    monkeypatch.setattr(
        runtime_resources.shutil,
        "which",
        lambda name: "/usr/bin/apptainer" if name == "apptainer" else None,
    )
    monkeypatch.setattr(
        runtime_resources.scientific_resources,
        "active_fastsurfer_sif",
        _active_fastsurfer,
    )
    monkeypatch.setattr(
        runtime_resources,
        "_cuda_runtime_ready",
        lambda _apptainer, _sif: (cuda_ready, None if cuda_ready else "smoke failed"),
    )


def _recon_request(
    root: Path,
    backend: str,
    *,
    device: str = "auto",
) -> dict[str, Any]:
    """Return one single-subject reconstruction stage request.

    Parameters
    ----------
    root
        Provide the project root that holds the raw T1w input.
    backend
        Provide the configured reconstruction backend.
    device
        Provide the configured FastSurfer device.

    Returns
    -------
    dict
        Return the planning request with a readable FreeSurfer license and a
        run-time context that carries the managed-resource root.
    """
    cfg = _cfg(root, ["sub-001"], "recon")
    license_path = root / "license.txt"
    license_path.write_text("test-license\n", encoding="utf-8")
    cfg["tools"] = {"freesurferLicense": str(license_path)}
    cfg["steps"]["recon"]["params"] = {"backend": backend, "fastsurferDevice": device}
    request = _request(root, cfg, "recon", {"mode": "all"})
    request["runtimeContext"] = {"userDataPath": str(root / "user-data")}
    return request


def test_direct_cohort_stage_ignores_stale_route_subject_selection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001", "sub-002"], "aggregate")
    cfg["steps"]["aggregate"]["params"]["subjectGlob"] = "sub-*"
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS", {"aggregate": _Adapter("aggregate")}
    )

    planned = build_plan(
        _request(
            root,
            cfg,
            "aggregate",
            {"mode": "explicit", "subjectIds": ["sub-stale"]},
        )
    )

    assert planned.result["disposition"] == "planned"
    assert planned.result["plan"]["selectedSubset"]["subjectIds"] == [
        "sub-001",
        "sub-002",
    ]
    assert len(planned.result["plan"]["nodes"]) == 1
    assert planned.result["plan"]["nodes"][0]["subjectId"] is None


@pytest.mark.parametrize(
    ("brainfov_enabled", "deface_enabled", "expected"),
    [
        (False, False, {"brainfov": [], "deface": [], "recon": []}),
        (True, False, {"brainfov": [], "deface": [], "recon": ["brainfov"]}),
        (
            True,
            True,
            {"brainfov": [], "deface": ["brainfov"], "recon": ["deface"]},
        ),
        (False, True, {"brainfov": [], "deface": [], "recon": ["deface"]}),
    ],
)
def test_brainfov_deface_recon_subject_dag(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    brainfov_enabled: bool,
    deface_enabled: bool,
    expected: dict[str, list[str]],
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001"], "recon")
    cfg["steps"] = {
        "brainfov": {"enabled": brainfov_enabled, "params": {"marginMm": 30}},
        "deface": {"enabled": deface_enabled, "params": {}},
        "recon": {"enabled": True, "params": {}},
    }
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS",
        {
            "brainfov": _Adapter("brainfov"),
            "deface": _Adapter("deface"),
            "recon": _Adapter("recon"),
        },
    )
    request = _request(root, cfg, "recon", {"mode": "all"})
    request["intent"] = {"kind": "workflow", "target": {"mode": "all"}}

    planned = build_plan(request)

    subject_nodes = {
        node["stepKey"]: node
        for node in planned.result["plan"]["nodes"]
        if node["stepKey"] in expected
    }
    by_id = {
        node["nodeId"]: node["stepKey"] for node in planned.result["plan"]["nodes"]
    }
    assert {
        key: [by_id[node_id] for node_id in subject_nodes[key]["dependencies"]]
        for key in expected
    } == expected


def test_runtime_input_maps_preserve_raw_prepare_deface_order(
    tmp_path: Path,
) -> None:
    raw = tmp_path / "rawdata/sub-001/anat/sub-001_T1w.nii.gz"
    prepared = tmp_path / "derivatives/brainfov/sub-001_T1w.nii.gz"
    cohort = CohortSnapshot(
        analysis_subject_ids=("sub-001",),
        selected_subject_ids=("sub-001",),
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(
            T1Resolution(
                "sub-001",
                "resolved",
                str(raw),
                (str(raw),),
                "1" * 64,
            ),
        ),
        qc_verdicts=(("sub-001", "pass"),),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )
    cfg = {
        "paths": {"derivativesDir": str(tmp_path / "derivatives")},
        "steps": {
            "brainfov": {"enabled": True, "params": {"marginMm": 30}},
            "deface": {"enabled": True, "params": {}},
        },
    }

    effective = runtime_cfg(
        cfg,
        cohort,
        "run-aabbccdd",
        str(tmp_path),
        inputs=RuntimeCfgInputs(
            prepared_bindings={
                "sub-001": {
                    "preparedT1Path": str(prepared),
                    "passThrough": False,
                    "preflightSignature": "2" * 64,
                    "sourceSha256": "1" * 64,
                    "outputSha256": "3" * 64,
                    "decisionSignature": "4" * 64,
                }
            }
        ),
    )
    runtime = effective["_supraspinaRuntime"]

    assert runtime["t1BySubject"]["sub-001"] == str(raw)
    assert runtime["preparedT1BySubject"]["sub-001"] == str(prepared)
    assert runtime["reconInputBySubject"]["sub-001"].endswith(
        "defaced/sub-001/anat/sub-001_T1w.nii.gz"
    )
    assert runtime["inputFovDecisionSignatures"] == {"sub-001": "4" * 64}
    assert runtime["reconstructionViewSubjectIds"] == ["sub-001"]


def test_recon_is_blocked_until_current_crop_is_approved(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001"], "recon")
    cfg["steps"] = {
        "brainfov": {"enabled": True, "params": {"marginMm": 30}},
        "deface": {"enabled": False, "params": {}},
        "recon": {"enabled": True, "params": {}},
    }
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS",
        {
            "brainfov": _Adapter("brainfov"),
            "deface": _Adapter("deface"),
            "recon": _Adapter("recon"),
        },
    )
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.resolve_runtime_resources",
        lambda _cfg, _context: type(
            "Resolution",
            (),
            {
                "runtime": {},
                "blockers": {},
                "advisories": (),
                "evidence": {},
            },
        )(),
    )
    request = _request(root, cfg, "recon", {"mode": "all"})
    request["intent"] = {"kind": "workflow", "target": {"mode": "all"}}

    class _Unreviewed:
        def resolve_each_for_cohort(self, *_args: Any, **_kwargs: Any) -> Any:
            raise ValueError("Leave the brain-FOV crop for sub-001 unreviewed.")

    blocked = build_plan(request, input_fov_reviews=_Unreviewed())
    by_step = {node["stepKey"]: node for node in blocked.result["plan"]["nodes"]}

    assert by_step["brainfov"]["status"] == "planned"
    assert by_step["recon"]["status"] == "blocked"
    assert by_step["recon"]["reason"] == (
        "Leave the brain-FOV crop for sub-001 unreviewed."
    )


def _input_fov_review_for(approved: set[str]) -> Any:
    """Return a review manager that approves only the named subjects."""

    class _PerSubject:
        def resolve_each_for_cohort(
            self,
            _request: dict[str, Any],
            t1_by_subject: dict[str, str],
            *,
            expected_preflight_by_subject: dict[str, str],
        ) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
            resolved: dict[str, dict[str, Any]] = {}
            blockers: dict[str, str] = {}
            for subject_id, raw_path in t1_by_subject.items():
                if subject_id not in approved:
                    blockers[subject_id] = (
                        f"Run Brain FOV for {subject_id}, then approve its crop "
                        "in Input QC."
                    )
                    continue
                resolved[subject_id] = {
                    "preparedT1Path": raw_path,
                    "passThrough": True,
                    "preflightSignature": expected_preflight_by_subject[subject_id],
                    "sourceSha256": "0" * 64,
                    "outputSha256": "0" * 64,
                }
            return resolved, blockers

    return _PerSubject()


def _stub_resource_resolution(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.resolve_runtime_resources",
        lambda _cfg, _context: type(
            "Resolution",
            (),
            {"runtime": {}, "blockers": {}, "advisories": (), "evidence": {}},
        )(),
    )


def test_input_qc_gate_blocks_only_the_subjects_without_an_approved_crop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001", "sub-002"], "recon")
    cfg["steps"]["brainfov"] = {"enabled": True, "params": {"marginMm": 30}}
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS",
        {"brainfov": _Adapter("brainfov"), "recon": _Adapter("recon")},
    )
    _stub_resource_resolution(monkeypatch)
    request = _request(root, cfg, "recon", {"mode": "all"})
    request["intent"] = {"kind": "workflow", "target": {"mode": "all"}}

    planned = build_plan(request, input_fov_reviews=_input_fov_review_for({"sub-001"}))
    recon = {
        node["subjectId"]: node
        for node in planned.result["plan"]["nodes"]
        if node["stepKey"] == "recon"
    }

    assert planned.result["disposition"] == "planned"
    assert recon["sub-001"]["status"] == "waiting"
    assert recon["sub-002"]["status"] == "blocked"
    assert recon["sub-002"]["reason"] == (
        "Run Brain FOV for sub-002, then approve its crop in Input QC."
    )
    assert planned.result["plan"]["blockers"] == [
        {
            "key": "recon",
            "reason": "Run Brain FOV for sub-002, then approve its crop in Input QC.",
            "kind": "input-qc",
            "subjects": ["sub-002"],
        }
    ]
    evidence = planned.effective_cfg["_supraspinaRuntime"]["inputFovEvidence"]
    assert set(evidence) == {"sub-001"}


def test_recon_stage_for_an_approved_subject_ignores_other_unreviewed_crops(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001", "sub-002"], "recon")
    cfg["steps"]["brainfov"] = {"enabled": True, "params": {"marginMm": 30}}
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS",
        {"brainfov": _Adapter("brainfov"), "recon": _Adapter("recon")},
    )
    _stub_resource_resolution(monkeypatch)
    request = _request(
        root, cfg, "recon", {"mode": "explicit", "subjectIds": ["sub-001"]}
    )

    planned = build_plan(request, input_fov_reviews=_input_fov_review_for({"sub-001"}))

    nodes = planned.result["plan"]["nodes"]
    assert [(node["subjectId"], node["status"]) for node in nodes] == [
        ("sub-001", "planned")
    ]
    assert planned.result["disposition"] == "planned"
    assert planned.result["plan"]["blockers"] == []


def test_aggregate_custom_glob_must_match_every_analysis_subject(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001", "sub-002"], "aggregate")
    cfg["steps"]["aggregate"]["params"]["subjectGlob"] = "sub-001"
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS", {"aggregate": _Adapter("aggregate")}
    )

    planned = build_plan(
        _request(root, cfg, "aggregate", {"mode": "all", "subjectIds": []})
    )

    node = planned.result["plan"]["nodes"][0]
    assert node["status"] == "blocked"
    assert node["reason"] == (
        "Set aggregate subjectGlob to match all 2 analysis subjects in the exact "
        "run-scoped view; it currently matches 1."
    )


def test_age_outer_reconciliation_counts_reach_plan_state_manifest_and_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001", "sub-002"], "age")
    metadata = root / "age.csv"
    metadata.write_text(
        "participant_id,Age\nsub-001,20\nsub-002,21\nsub-002,21\n",
        encoding="utf-8",
    )
    cfg["paths"]["ageMetadataFile"] = str(metadata)
    cfg["steps"]["age"]["params"] = {
        "join": "outer",
        "subjectIdColumn": "participant_id",
    }
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS", {"age": _Adapter("age")}
    )
    request = _request(root, cfg, "age", {"mode": "all"})

    planned = build_plan(request)
    evidence = planned.result["plan"]["scientificEvidence"]["ageOuterJoin"]
    assert evidence == {
        "join": "outer",
        "policy": "metadata-only-subjects-blocked-v1",
        "subjectIdColumn": "participant_id",
        "analysisCount": 2,
        "metadataRowCount": 3,
        "metadataUniqueIdCount": 2,
        "matchedAnalysisCount": 2,
        "missingAnalysisCount": 0,
        "metadataOnlyCount": 0,
        "duplicateMetadataIds": 1,
    }
    manager = WorkflowManager(_Emitter())
    try:
        project = ProjectIdentity(
            "planning-project",
            str(root.resolve()),
            str((root / "supraspina.project.json").resolve()),
            1,
        )
        state = manager._new_state(
            "run-aabbccdd", request, project, planned, True, {"groups": []}
        )
        assert state["scientificEvidence"]["ageOuterJoin"] == evidence
        assert (
            manager._manifest(state)["scientificEvidence"]["ageOuterJoin"] == evidence
        )
        receipt_evidence = manager._receipt_scientific_evidence(
            state, "age", {"state": "done"}
        )
        assert receipt_evidence["ageOuterReconciliation"] == evidence
    finally:
        manager.shutdown()


def test_age_outer_metadata_only_subject_is_blocked_with_persistable_counts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001"], "age")
    metadata = root / "age.csv"
    metadata.write_text(
        "participant_id,Age\nsub-001,20\nmetadata-only,22\n",
        encoding="utf-8",
    )
    cfg["paths"]["ageMetadataFile"] = str(metadata)
    cfg["steps"]["age"]["params"] = {
        "join": "outer",
        "subjectIdColumn": "participant_id",
    }
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS", {"age": _Adapter("age")}
    )

    planned = build_plan(_request(root, cfg, "age", {"mode": "all"}))

    assert planned.result["plan"]["nodes"][0]["status"] == "blocked"
    assert (
        planned.result["plan"]["scientificEvidence"]["ageOuterJoin"][
            "metadataOnlyCount"
        ]
        == 1
    )


def test_mixed_qc_excludes_fail_and_rejects_explicit_failed_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-pass", "sub-fail"], "recon")
    _write_qc(root, {"sub-pass": "pass", "sub-fail": "fail"})
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS", {"recon": _Adapter("recon")}
    )
    request = _request(root, cfg, "recon", {"mode": "all"})
    request["acknowledgements"]["includeDeferredAndUnreviewedQc"] = False

    planned = build_plan(request)

    assert planned.result["disposition"] == "planned"
    assert planned.result["plan"]["analysisCohort"]["subjectIds"] == ["sub-pass"]
    assert [node["subjectId"] for node in planned.result["plan"]["nodes"]] == [
        "sub-pass"
    ]

    explicit = _request(
        root,
        cfg,
        "recon",
        {"mode": "explicit", "subjectIds": ["sub-fail"]},
    )
    explicit["acknowledgements"]["includeDeferredAndUnreviewedQc"] = False
    rejected = build_plan(explicit)
    assert rejected.result["disposition"] == "blocked"
    assert "outside the analysis cohort" in rejected.result["summary"]["message"]


def test_all_qc_failed_is_an_empty_blocked_analysis_cohort(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001", "sub-002"], "recon")
    _write_qc(root, {"sub-001": "fail", "sub-002": "fail"})
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS", {"recon": _Adapter("recon")}
    )
    request = _request(root, cfg, "recon", {"mode": "all"})
    request["acknowledgements"]["includeDeferredAndUnreviewedQc"] = False

    planned = build_plan(request)

    assert planned.result["disposition"] == "blocked"
    assert planned.result["plan"]["nodes"] == []
    assert planned.result["summary"]["message"] == (
        "Add subjects to the analysis cohort."
    )


def test_defer_and_unreviewed_require_an_exact_boolean_acknowledgement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-defer", "sub-unreviewed"], "recon")
    _write_qc(root, {"sub-defer": "defer"})
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS", {"recon": _Adapter("recon")}
    )

    unacknowledged = _request(root, cfg, "recon", {"mode": "all"})
    unacknowledged["acknowledgements"]["includeDeferredAndUnreviewedQc"] = False
    blocked = build_plan(unacknowledged)
    assert blocked.result["disposition"] == "blocked"
    assert "deferred or unreviewed" in blocked.result["summary"]["message"]

    acknowledged = _request(root, cfg, "recon", {"mode": "all"})
    planned = build_plan(acknowledged)
    assert planned.result["disposition"] == "planned"
    assert planned.result["plan"]["analysisCohort"]["subjectIds"] == [
        "sub-defer",
        "sub-unreviewed",
    ]

    for malformed in ("true", 1):
        invalid = _request(root, cfg, "recon", {"mode": "all"})
        invalid["acknowledgements"]["includeDeferredAndUnreviewedQc"] = malformed
        with pytest.raises(ValueError, match=r"^Provide .+ as a boolean\.$"):
            build_plan(invalid)


def test_unknown_roles_block_only_clinical_final_and_their_dependents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-ambiguous", "sub-missing"], "recon")
    cfg["steps"] = {
        key: {"enabled": True, "params": {}}
        for key in ("recon", "clinical", "brainpad", "final")
    }
    RegistryStore(str(root)).upsert(
        {
            "subjectId": "sub-ambiguous",
            "age": 40,
            "sex": "O",
            "sourceCohortLabel": "unmapped-source-label",
            "ais": None,
            "tSinceSci": None,
        }
    )
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS",
        {key: _Adapter(key) for key in ("recon", "clinical", "brainpad", "final")},
    )
    request = {
        **_request(root, cfg, "recon", {"mode": "all"}),
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
    }

    planned = build_plan(request)
    nodes = planned.result["plan"]["nodes"]
    by_step: dict[str, list[dict[str, Any]]] = {}
    for node in nodes:
        by_step.setdefault(node["stepKey"], []).append(node)

    assert planned.result["disposition"] == "planned"
    assert {node["status"] for node in by_step["recon"]} == {"planned"}
    for key in ("clinical", "final"):
        assert by_step[key][0]["status"] == "blocked"
        assert "Assign registry roles to sub-missing." in by_step[key][0]["reason"]
        assert (
            "Resolve ambiguous registry roles for sub-ambiguous."
            in by_step[key][0]["reason"]
        )
    assert by_step["brainpad"][0]["status"] == "blocked"
    assert by_step["brainpad"][0]["reason"].startswith(
        "Wait for Clinical merge, which is blocked: Prepare Clinical merge."
    )
    assert {
        blocker["key"]
        for blocker in planned.result["plan"]["blockers"]
        if blocker["kind"] == "cohort"
    } == {"clinical", "final"}


def test_stage_scoped_recon_carries_no_registry_blockers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001", "sub-002"], "recon")
    cfg["steps"] = {
        key: {"enabled": True, "params": {}} for key in ("recon", "clinical", "final")
    }
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS",
        {key: _Adapter(key) for key in ("recon", "clinical", "final")},
    )
    request = _request(root, cfg, "recon", {"mode": "all"})

    planned = build_plan(request)

    assert planned.result["disposition"] == "planned"
    assert {node["stepKey"] for node in planned.result["plan"]["nodes"]} == {"recon"}
    assert {node["status"] for node in planned.result["plan"]["nodes"]} == {"planned"}
    assert planned.result["plan"]["blockers"] == []


def test_multiple_missing_roles_are_named_in_one_clinical_blocker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001", "sub-002", "sub-003"], "recon")
    cfg["steps"] = {
        key: {"enabled": True, "params": {}} for key in ("recon", "clinical")
    }
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS",
        {key: _Adapter(key) for key in ("recon", "clinical")},
    )
    request = {
        **_request(root, cfg, "recon", {"mode": "all"}),
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
    }

    planned = build_plan(request)

    by_step: dict[str, list[dict[str, Any]]] = {}
    for node in planned.result["plan"]["nodes"]:
        by_step.setdefault(node["stepKey"], []).append(node)
    assert planned.result["disposition"] == "planned"
    assert {node["status"] for node in by_step["recon"]} == {"planned"}
    assert by_step["clinical"][0]["status"] == "blocked"
    assert (
        "Assign registry roles to sub-001, sub-002, sub-003."
        in by_step["clinical"][0]["reason"]
    )
    assert [blocker["key"] for blocker in planned.result["plan"]["blockers"]] == [
        "clinical"
    ]


def test_clinical_blocker_carries_every_subject_beyond_the_prose_sample(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Sample eight subjects in the reason while naming all of them structurally."""
    root = tmp_path / "project"
    root.mkdir()
    subject_ids = [f"sub-{index:03d}" for index in range(1, 12)]
    cfg = _cfg(root, subject_ids, "clinical")
    cfg["steps"] = {"clinical": {"enabled": True, "params": {}}}
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS", {"clinical": _Adapter("clinical")}
    )

    planned = build_plan(_request(root, cfg, "clinical", {"mode": "all"}))

    blockers = planned.result["plan"]["blockers"]
    assert len(blockers) == 1
    blocker = blockers[0]
    assert "sub-001, sub-002, sub-003, sub-004" in blocker["reason"]
    assert "(+3 more)" in blocker["reason"]
    assert "sub-011" not in blocker["reason"]
    assert blocker["subjects"] == subject_ids
    assert blocker["subjectCount"] == 11
    assert blocker["action"] == "open-registry"


def test_final_requires_two_subjects_in_each_semantic_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    subjects_and_labels = [
        ("sub-h1", "control"),
        ("sub-h2", "control"),
        ("sub-p1", "SCI_P"),
        ("sub-n1", "SCI_nNP"),
        ("sub-n2", "SCI_nNP"),
    ]
    cfg = _cfg(root, [item[0] for item in subjects_and_labels], "final")
    for subject_id, label in subjects_and_labels:
        RegistryStore(str(root)).upsert(
            {
                "subjectId": subject_id,
                "age": 40,
                "sex": "O",
                "sourceCohortLabel": label,
                "ais": None,
                "tSinceSci": None,
            }
        )
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS", {"final": _Adapter("final")}
    )

    planned = build_plan(_request(root, cfg, "final", {"mode": "all"}))

    node = planned.result["plan"]["nodes"][0]
    assert node["status"] == "blocked"
    assert node["reason"] == (
        "Add or relabel 1 SCI_P subject in the Registry so R analysis has at least "
        "2 subjects per semantic group (current counts: control=2, SCI_P=1, "
        "SCI_nNP=2); then review the plan again."
    )
    assert planned.result["plan"]["blockers"] == [
        {
            "key": "final",
            "reason": node["reason"],
            "kind": "cohort",
            "subjects": ["sub-p1"],
            "subjectCount": 1,
            "action": "open-registry",
        }
    ]


def test_final_accepts_two_subjects_in_each_semantic_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    subjects_and_labels = [
        ("sub-h1", "control"),
        ("sub-h2", "control"),
        ("sub-p1", "SCI_P"),
        ("sub-p2", "SCI_P"),
        ("sub-n1", "SCI_nNP"),
        ("sub-n2", "SCI_nNP"),
    ]
    cfg = _cfg(root, [item[0] for item in subjects_and_labels], "final")
    for subject_id, label in subjects_and_labels:
        RegistryStore(str(root)).upsert(
            {
                "subjectId": subject_id,
                "age": 40,
                "sex": "O",
                "sourceCohortLabel": label,
                "ais": None,
                "tSinceSci": None,
            }
        )
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS", {"final": _Adapter("final")}
    )

    planned = build_plan(_request(root, cfg, "final", {"mode": "all"}))

    assert planned.result["plan"]["nodes"][0]["status"] == "planned"
    assert planned.result["plan"]["blockers"] == []


class _FinalAdapterWithoutEnvChecks(FinalAdapter):
    """Keep the real metadata check while ignoring host tool checks."""

    def required_check_ids(self, cfg: dict[str, Any]) -> tuple[str, ...]:
        del cfg
        return ()


def test_missing_final_metadata_blocks_only_final_at_planning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    subjects_and_labels = [
        ("sub-h1", "control"),
        ("sub-h2", "control"),
        ("sub-p1", "SCI_P"),
        ("sub-p2", "SCI_P"),
        ("sub-n1", "SCI_nNP"),
        ("sub-n2", "SCI_nNP"),
    ]
    cfg = _cfg(root, [item[0] for item in subjects_and_labels], "recon")
    metadata_dir = root / "metadata"
    metadata_dir.mkdir()
    (metadata_dir / "age.csv").write_text("participant_id,Age\n")
    (metadata_dir / "clinical.csv").write_text("participant_id,Cohort,AIS\n")
    cfg["paths"]["metadataDir"] = str(metadata_dir)
    cfg["tools"] = {"rscriptExecutable": "/usr/bin/Rscript"}
    cfg["steps"] = {
        key: {"enabled": True, "params": {}} for key in ("recon", "clinical", "final")
    }
    for subject_id, label in subjects_and_labels:
        RegistryStore(str(root)).upsert(
            {
                "subjectId": subject_id,
                "age": 40,
                "sex": "O",
                "sourceCohortLabel": label,
                "ais": None,
                "tSinceSci": None,
            }
        )
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS",
        {
            "recon": _Adapter("recon"),
            "clinical": _Adapter("clinical"),
            "final": _FinalAdapterWithoutEnvChecks(),
        },
    )
    request = {
        **_request(root, cfg, "recon", {"mode": "all"}),
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
    }

    planned = build_plan(request)

    reason = (
        f"Provide the metadata file {metadata_dir / 'metadata.csv'} with a "
        "subject ID column (participant_id) and a Cohort column; Sex and Age "
        "are optional."
    )
    by_step: dict[str, list[dict[str, Any]]] = {}
    for node in planned.result["plan"]["nodes"]:
        by_step.setdefault(node["stepKey"], []).append(node)
    assert planned.result["disposition"] == "planned"
    assert len(by_step["recon"]) == len(subjects_and_labels)
    assert {node["status"] for node in by_step["recon"]} == {"planned"}
    assert by_step["clinical"][0]["status"] in {"planned", "waiting"}
    assert by_step["final"][0]["status"] == "blocked"
    assert by_step["final"][0]["reason"] == reason
    assert planned.result["plan"]["blockers"] == [
        {"key": "final", "reason": reason, "kind": "environment"}
    ]

    (metadata_dir / "metadata.csv").write_text("participant_id,Cohort\n")
    replanned = build_plan(request)
    final_node = next(
        node for node in replanned.result["plan"]["nodes"] if node["stepKey"] == "final"
    )
    assert final_node["status"] in {"planned", "waiting"}
    assert replanned.result["plan"]["blockers"] == []


@pytest.mark.parametrize(
    ("target", "message"),
    [
        (
            {"mode": "explicit", "subjectIds": "sub-fail"},
            "Provide explicit target subjectIds as an array.",
        ),
        (
            {"mode": "explicit", "subjectIds": ["sub-fail", 7]},
            "Provide only strings in explicit target subjectIds.",
        ),
    ],
)
def test_malformed_explicit_failed_target_is_rejected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    target: dict[str, Any],
    message: str,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-pass", "sub-fail"], "recon")
    _write_qc(root, {"sub-pass": "pass", "sub-fail": "fail"})
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS", {"recon": _Adapter("recon")}
    )

    planned = build_plan(_request(root, cfg, "recon", target))

    assert planned.result["disposition"] == "blocked"
    assert message in planned.result["summary"]["message"]


@pytest.mark.parametrize("revision", [True, "1", 1.0, -1, 2**53])
def test_workflow_config_revision_rejects_coercion_and_unsafe_values(
    tmp_path: Path,
    revision: Any,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001"], "recon")
    request = _request(root, cfg, "recon", {"mode": "all"})
    request["configRevision"] = revision

    with pytest.raises(ValueError, match="configRevision"):
        build_plan(request)


@pytest.mark.parametrize("step", ["deface", "recon"])
def test_plan_authorization_rejects_same_size_same_mtime_t1_change(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    step: str,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001"], step)
    request = _request(root, cfg, step, {"mode": "all"})
    monkeypatch.setattr("supraspina_sidecar.workflow.ADAPTERS", {step: _Adapter(step)})
    manager = WorkflowManager(
        _Emitter(),
        env_check=lambda _cfg: {"groups": [], "availableMemoryGB": 24},
    )
    monkeypatch.setattr(manager, "_apply_runtime_policy", lambda _ctx: None)
    monkeypatch.setattr(manager, "_apply_stage_readiness", lambda _ctx: None)
    t1_path = root / "rawdata" / "sub-001" / "anat" / "sub-001_T1w.nii.gz"
    original = os.stat(t1_path)
    try:
        preview = manager.plan(request)
        request["approvedPlan"] = {
            "planId": preview["plan"]["planId"],
            "digest": preview["plan"]["digest"],
        }
        t1_path.write_bytes(b"changed")
        os.utime(t1_path, ns=(original.st_atime_ns, original.st_mtime_ns))
        observed = os.stat(t1_path)
        assert observed.st_size == original.st_size
        assert observed.st_mtime_ns == original.st_mtime_ns

        with pytest.raises(ValueError, match=r"^Review the stale plan again\.$"):
            manager.run(request)
    finally:
        manager.shutdown()

    assert RunStore(str(root)).run_ids() == []


def test_resume_explicit_selection_intersects_current_cohort_without_widening(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-kept", "sub-new"], "recon")
    source = {
        "kind": "workflow",
        "target": {
            "mode": "explicit",
            "subjectIds": ["sub-kept", "sub-removed"],
        },
    }

    effective, reconciliation = _resume_intent(
        source, cfg, {"includeDeferredAndUnreviewedQc": True}
    )

    assert effective["target"]["subjectIds"] == ["sub-kept"]
    assert "sub-new" not in effective["target"]["subjectIds"]
    assert reconciliation == {
        "sourceSubjectIds": ["sub-kept", "sub-removed"],
        "currentEligibleSubjectIds": ["sub-kept", "sub-new"],
        "retainedSubjectIds": ["sub-kept"],
        "addedSubjectIds": ["sub-new"],
        "removedSubjectIds": ["sub-removed"],
        "deferredAndUnreviewedSubjectIds": ["sub-kept"],
    }


def test_resume_explicit_selection_becomes_empty_noop_target(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-new"], "recon")
    source = {
        "kind": "workflow",
        "target": {"mode": "explicit", "subjectIds": ["sub-removed"]},
    }

    effective, reconciliation = _resume_intent(
        source, cfg, {"includeDeferredAndUnreviewedQc": True}
    )

    assert effective["target"]["subjectIds"] == []
    assert reconciliation is not None
    assert reconciliation["removedSubjectIds"] == ["sub-removed"]


def test_resume_scope_uses_fresh_qc_choice_and_never_adds_new_subjects(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(
        root,
        [
            "sub-source-pass",
            "sub-source-fail",
            "sub-source-defer",
            "sub-source-unreviewed",
            "sub-new-pass",
            "sub-new-fail",
            "sub-new-defer",
            "sub-new-unreviewed",
        ],
        "recon",
    )
    _write_qc(
        root,
        {
            "sub-source-pass": "pass",
            "sub-source-fail": "fail",
            "sub-source-defer": "defer",
            "sub-new-pass": "pass",
            "sub-new-fail": "fail",
            "sub-new-defer": "defer",
        },
    )
    source = {
        "kind": "workflow",
        "target": {"mode": "all"},
    }
    source_subjects = [
        "sub-source-pass",
        "sub-source-fail",
        "sub-source-defer",
        "sub-source-unreviewed",
        "sub-removed",
    ]

    without_fresh_ack, strict_reconciliation = _resume_intent(
        source,
        cfg,
        {"includeDeferredAndUnreviewedQc": False},
        source_analysis_subject_ids=source_subjects,
        source_selected_subject_ids=source_subjects,
    )
    with_fresh_ack, acknowledged_reconciliation = _resume_intent(
        source,
        cfg,
        {"includeDeferredAndUnreviewedQc": True},
        source_analysis_subject_ids=source_subjects,
        source_selected_subject_ids=source_subjects,
    )

    assert without_fresh_ack["target"] == {
        "mode": "explicit",
        "subjectIds": ["sub-source-pass"],
    }
    assert strict_reconciliation == {
        "sourceSubjectIds": source_subjects,
        "currentEligibleSubjectIds": ["sub-new-pass", "sub-source-pass"],
        "retainedSubjectIds": ["sub-source-pass"],
        "addedSubjectIds": ["sub-new-pass"],
        "removedSubjectIds": [
            "sub-source-fail",
            "sub-source-defer",
            "sub-source-unreviewed",
            "sub-removed",
        ],
        "deferredAndUnreviewedSubjectIds": [
            "sub-source-defer",
            "sub-source-unreviewed",
        ],
    }
    assert with_fresh_ack["target"] == {
        "mode": "explicit",
        "subjectIds": [
            "sub-source-pass",
            "sub-source-defer",
            "sub-source-unreviewed",
        ],
    }
    assert acknowledged_reconciliation == {
        "sourceSubjectIds": source_subjects,
        "currentEligibleSubjectIds": [
            "sub-new-defer",
            "sub-new-pass",
            "sub-new-unreviewed",
            "sub-source-defer",
            "sub-source-pass",
            "sub-source-unreviewed",
        ],
        "retainedSubjectIds": [
            "sub-source-pass",
            "sub-source-defer",
            "sub-source-unreviewed",
        ],
        "addedSubjectIds": [
            "sub-new-defer",
            "sub-new-pass",
            "sub-new-unreviewed",
        ],
        "removedSubjectIds": ["sub-source-fail", "sub-removed"],
        "deferredAndUnreviewedSubjectIds": [
            "sub-source-defer",
            "sub-source-unreviewed",
        ],
    }
    assert set(acknowledged_reconciliation["retainedSubjectIds"]).isdisjoint(
        acknowledged_reconciliation["addedSubjectIds"]
    )
    assert (
        "sub-new-fail" not in acknowledged_reconciliation["currentEligibleSubjectIds"]
    )
    assert "sub-new-fail" not in acknowledged_reconciliation["addedSubjectIds"]

    recovered_all, all_reconciliation = _resume_intent(
        source,
        cfg,
        {"includeDeferredAndUnreviewedQc": True},
        source_analysis_subject_ids=source_subjects,
    )
    assert recovered_all["target"]["subjectIds"] == [
        "sub-source-pass",
        "sub-source-defer",
        "sub-source-unreviewed",
    ]
    assert all_reconciliation == acknowledged_reconciliation


def test_resume_cohort_stage_preserves_all_mode_after_source_intersection(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-kept", "sub-new"], "aggregate")
    source = {
        "kind": "stage",
        "stepKey": "aggregate",
        "target": {
            "mode": "explicit",
            "subjectIds": ["sub-kept", "sub-removed"],
        },
    }

    effective, reconciliation = _resume_intent(
        source,
        cfg,
        {"includeDeferredAndUnreviewedQc": True},
        source_analysis_subject_ids=["sub-kept", "sub-removed"],
        source_selected_subject_ids=["sub-kept", "sub-removed"],
    )

    assert effective["target"] == {"mode": "all"}
    assert reconciliation is not None
    assert reconciliation["retainedSubjectIds"] == ["sub-kept"]
    assert reconciliation["addedSubjectIds"] == ["sub-new"]


def _cohort(subjects: list[str]) -> CohortSnapshot:
    return CohortSnapshot(
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


def _context(
    root: Path, nodes: list[dict[str, Any]], subjects: list[str]
) -> _RunContext:
    project = ProjectIdentity("recovery-project", str(root.resolve()), "", 1)
    return _RunContext(
        state={"runId": "run-feedface", "nodes": nodes, "receipts": []},
        cfg={},
        effective_cfg={},
        cohort=_cohort(subjects),
        project=project,
        store=RunStore(str(root)),
        queue_limit=1,
    )


def test_execution_metadata_projection_never_infers_a_missing_registry_role(
    tmp_path: Path,
) -> None:
    source = tmp_path / "metadata.csv"
    source.write_text(
        "participant_id,Cohort,Age\nsub-001,control,40\n", encoding="utf-8"
    )
    destination = tmp_path / "run" / "inputs" / "clinical.csv"
    ctx = _context(tmp_path, [], ["sub-001"])
    manager = WorkflowManager(_Emitter())
    try:
        with pytest.raises(ValueError, match="ambiguous cohort label"):
            manager._metadata_projection(
                ctx,
                str(source),
                str(destination),
                healthy_label="control",
                projection_kind="clinical",
            )
    finally:
        manager.shutdown()

    assert not destination.exists()


def test_retry_flags_reject_string_truthiness(tmp_path: Path) -> None:
    ctx = _context(tmp_path, [], ["sub-001"])
    manager = WorkflowManager(_Emitter())
    try:
        with pytest.raises(
            ValueError,
            match=r"^Provide includeCancelled as a boolean\.$",
        ):
            manager._reconcile_recovery_nodes(
                ctx,
                {
                    "intent": {"kind": "workflow", "target": {"mode": "all"}},
                    "nodes": [],
                },
                {"includeCancelled": "false"},
                retry=True,
            )
    finally:
        manager.shutdown()


def test_resume_all_target_does_not_add_new_analysis_subject(
    tmp_path: Path,
) -> None:
    nodes = [
        {
            "nodeId": "new-r1",
            "stepKey": "recon",
            "subjectId": "s1",
            "status": "planned",
            "dependencies": [],
        },
        {
            "nodeId": "new-r2",
            "stepKey": "recon",
            "subjectId": "s2",
            "status": "planned",
            "dependencies": [],
        },
        {
            "nodeId": "new-a",
            "stepKey": "aggregate",
            "subjectId": None,
            "status": "waiting",
            "dependencies": ["new-r1", "new-r2"],
        },
    ]
    old = {
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "nodes": [
            {
                "nodeId": "old-r1",
                "stepKey": "recon",
                "subjectId": "s1",
                "status": "done",
            },
            {
                "nodeId": "old-a",
                "stepKey": "aggregate",
                "subjectId": None,
                "status": "done",
            },
        ],
    }
    manager = WorkflowManager(_Emitter())
    manager._current_receipt = (  # type: ignore[method-assign]
        lambda _ctx, node: {} if node.get("subjectId") == "s1" else None
    )
    try:
        ctx = _context(tmp_path, nodes, ["s1", "s2"])
        manager._reconcile_recovery_nodes(ctx, old, {}, retry=False)
    finally:
        manager.shutdown()

    assert nodes[0]["status"] == "skipped"
    assert nodes[1]["status"] == "skipped"
    assert nodes[1]["reason"] == (
        "This work is outside the invalid source-node recovery closure, so it "
        "is not scheduled."
    )
    assert nodes[2]["status"] == "waiting"
    assert ctx.state["recoveryRoots"] == [{"stepKey": "aggregate", "subjectId": None}]


def test_resume_explicit_target_does_not_add_new_analysis_subject(
    tmp_path: Path,
) -> None:
    nodes = [
        {
            "nodeId": "new-r1",
            "stepKey": "recon",
            "subjectId": "s1",
            "status": "planned",
            "dependencies": [],
        },
        {
            "nodeId": "new-r2",
            "stepKey": "recon",
            "subjectId": "s2",
            "status": "planned",
            "dependencies": [],
        },
    ]
    old = {
        "intent": {
            "kind": "workflow",
            "target": {"mode": "explicit", "subjectIds": ["s1"]},
        },
        "nodes": [
            {
                "nodeId": "old-r1",
                "stepKey": "recon",
                "subjectId": "s1",
                "status": "done",
            }
        ],
    }
    manager = WorkflowManager(_Emitter())
    manager._current_receipt = lambda _ctx, _node: None  # type: ignore[method-assign]
    try:
        ctx = _context(tmp_path, nodes, ["s1", "s2"])
        manager._reconcile_recovery_nodes(ctx, old, {}, retry=False)
    finally:
        manager.shutdown()

    assert nodes[0]["status"] == "planned"
    assert nodes[1]["status"] == "skipped"
    assert all(root["subjectId"] != "s2" for root in ctx.state["recoveryRoots"])


def test_retry_selected_node_includes_invalid_ancestors_and_downstream_closure(
    tmp_path: Path,
) -> None:
    nodes = [
        {
            "nodeId": "new-r",
            "stepKey": "recon",
            "subjectId": "s1",
            "status": "planned",
            "dependencies": [],
        },
        {
            "nodeId": "new-a",
            "stepKey": "aggregate",
            "subjectId": None,
            "status": "waiting",
            "dependencies": ["new-r"],
        },
        {
            "nodeId": "new-e",
            "stepKey": "enigma",
            "subjectId": None,
            "status": "waiting",
            "dependencies": ["new-r"],
        },
    ]
    old = {
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "nodes": [
            {
                "nodeId": "old-r",
                "stepKey": "recon",
                "subjectId": "s1",
                "status": "done",
            },
            {
                "nodeId": "old-a",
                "stepKey": "aggregate",
                "subjectId": None,
                "status": "done",
            },
            {
                "nodeId": "old-e",
                "stepKey": "enigma",
                "subjectId": None,
                "status": "done",
            },
        ],
    }
    manager = WorkflowManager(_Emitter())
    manager._current_receipt = (  # type: ignore[method-assign]
        lambda _ctx, node: {} if node.get("stepKey") == "enigma" else None
    )
    try:
        ctx = _context(tmp_path, nodes, ["s1"])
        manager._reconcile_recovery_nodes(ctx, old, {"nodeIds": ["old-a"]}, retry=True)
    finally:
        manager.shutdown()

    assert nodes[0]["status"] == "planned"
    assert nodes[1]["status"] == "waiting"
    assert nodes[2]["status"] == "skipped"
    assert {
        (root["stepKey"], root["subjectId"]) for root in ctx.state["recoveryRoots"]
    } == {("recon", "s1"), ("aggregate", None)}


def test_retry_selected_failed_node_overrides_its_current_receipt(
    tmp_path: Path,
) -> None:
    nodes = [
        {
            "nodeId": "new-b",
            "stepKey": "brainfov",
            "subjectId": "s1",
            "status": "planned",
            "dependencies": [],
        },
        {
            "nodeId": "new-r",
            "stepKey": "recon",
            "subjectId": "s1",
            "status": "waiting",
            "dependencies": ["new-b"],
        },
        {
            "nodeId": "new-f",
            "stepKey": "features",
            "subjectId": None,
            "status": "waiting",
            "dependencies": ["new-r"],
        },
    ]
    old = {
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "nodes": [
            {
                "nodeId": "old-b",
                "stepKey": "brainfov",
                "subjectId": "s1",
                "status": "done",
            },
            {
                "nodeId": "old-r",
                "stepKey": "recon",
                "subjectId": "s1",
                "status": "failed",
            },
            {
                "nodeId": "old-f",
                "stepKey": "features",
                "subjectId": None,
                "status": "waiting",
            },
        ],
    }
    manager = WorkflowManager(_Emitter())
    manager._current_receipt = (  # type: ignore[method-assign]
        lambda _ctx, node: {} if node.get("stepKey") in {"brainfov", "recon"} else None
    )
    try:
        ctx = _context(tmp_path, nodes, ["s1"])
        manager._reconcile_recovery_nodes(ctx, old, {"nodeIds": ["old-r"]}, retry=True)
    finally:
        manager.shutdown()

    assert [node["status"] for node in nodes] == ["skipped", "waiting", "waiting"]
    assert ctx.state["recoveryRoots"] == [{"stepKey": "recon", "subjectId": "s1"}]


def test_retry_explicit_empty_node_selection_is_a_noop(tmp_path: Path) -> None:
    nodes = [
        {
            "nodeId": "new-r",
            "stepKey": "recon",
            "subjectId": "s1",
            "status": "planned",
            "dependencies": [],
        }
    ]
    old = {
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "nodes": [
            {
                "nodeId": "old-r",
                "stepKey": "recon",
                "subjectId": "s1",
                "status": "failed",
            }
        ],
    }
    manager = WorkflowManager(_Emitter())
    manager._current_receipt = lambda _ctx, _node: None  # type: ignore[method-assign]
    try:
        ctx = _context(tmp_path, nodes, ["s1"])
        manager._reconcile_recovery_nodes(ctx, old, {"nodeIds": []}, retry=True)
    finally:
        manager.shutdown()

    assert nodes[0]["status"] == "skipped"
    assert ctx.state["recoveryRoots"] == []


def test_resume_does_not_reactivate_cancelled_downstream_descendant(
    tmp_path: Path,
) -> None:
    nodes = [
        {
            "nodeId": "new-r",
            "stepKey": "recon",
            "subjectId": "s1",
            "status": "planned",
            "dependencies": [],
        },
        {
            "nodeId": "new-a",
            "stepKey": "aggregate",
            "subjectId": None,
            "status": "waiting",
            "dependencies": ["new-r"],
        },
    ]
    old = {
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "nodes": [
            {
                "nodeId": "old-r",
                "stepKey": "recon",
                "subjectId": "s1",
                "status": "failed",
            },
            {
                "nodeId": "old-a",
                "stepKey": "aggregate",
                "subjectId": None,
                "status": "cancelled",
            },
        ],
    }
    manager = WorkflowManager(_Emitter())
    manager._current_receipt = lambda _ctx, _node: None  # type: ignore[method-assign]
    try:
        ctx = _context(tmp_path, nodes, ["s1"])
        manager._reconcile_recovery_nodes(ctx, old, {}, retry=False)
    finally:
        manager.shutdown()

    assert nodes[0]["status"] == "planned"
    assert nodes[1]["status"] == "skipped"
    assert ctx.state["recoveryRoots"] == [{"stepKey": "recon", "subjectId": "s1"}]


def test_auto_backend_plans_against_the_resolved_freesurfer_requirements(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Plan automatic reconstruction once the FastSurfer resource resolves."""
    root = tmp_path / "project"
    root.mkdir()
    _install_active_resources(monkeypatch)
    request = _recon_request(root, "auto")

    planned = build_plan(request, env_report=_env_report(dict(_FREESURFER_FOUND)))

    node = planned.result["plan"]["nodes"][0]
    runtime = planned.effective_cfg["_supraspinaRuntime"]
    assert node["status"] == "planned"
    assert node["command"].startswith("recon-all ")
    assert runtime["resolvedReconBackend"] == "freesurfer"
    assert runtime["authorizedReconBackends"] == ["freesurfer", "fastsurfer"]
    assert runtime["resolvedFastSurferDevice"] == "cpu"


def test_auto_backend_stays_blocked_without_a_verified_fastsurfer_resource(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    _install_active_resources(monkeypatch, cpu=False)
    request = _recon_request(root, "auto")

    planned = build_plan(request, env_report=_env_report(dict(_FREESURFER_FOUND)))

    node = planned.result["plan"]["nodes"][0]
    assert node["status"] == "blocked"
    assert node["reason"] == (
        "Provision and exactly verify the requested FastSurfer 2.5.4 SIF."
    )
    assert planned.result["plan"]["blockers"] == [
        {
            "key": "recon",
            "reason": (
                "Provision and exactly verify the requested FastSurfer 2.5.4 SIF."
            ),
            "kind": "environment",
            "subjects": ["sub-001"],
        }
    ]


def test_auto_backend_still_requires_the_resolved_freesurfer_checks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    _install_active_resources(monkeypatch)
    request = _recon_request(root, "auto")
    statuses = dict(_FREESURFER_FOUND)
    statuses["license"] = "missing"

    planned = build_plan(request, env_report=_env_report(statuses))

    node = planned.result["plan"]["nodes"][0]
    assert node["status"] == "blocked"
    assert node["reason"] == ("Resolve the FreeSurfer license check; status: missing.")
    assert planned.result["plan"]["blockers"][0]["kind"] == "environment"
    assert "command" not in node


def test_auto_backend_records_the_cuda_device_after_the_container_smoke(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    _install_active_resources(monkeypatch, cuda=True, cuda_ready=True)
    request = _recon_request(root, "auto")

    planned = build_plan(request, env_report=_env_report(dict(_FREESURFER_FOUND)))

    runtime = planned.effective_cfg["_supraspinaRuntime"]
    assert planned.result["plan"]["nodes"][0]["status"] == "planned"
    assert runtime["resolvedReconBackend"] == "freesurfer"
    assert runtime["resolvedFastSurferDevice"] == "cuda"


@pytest.mark.parametrize(
    ("status", "expected_status"),
    [("found", "planned"), ("missing", "blocked")],
)
def test_explicit_fastsurfer_backend_validates_only_its_license_check(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    status: str,
    expected_status: str,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    _install_active_resources(monkeypatch)
    request = _recon_request(root, "fastsurfer", device="cpu")

    planned = build_plan(
        request,
        env_report=_env_report({"reconall": "missing", "license": status}),
    )

    node = planned.result["plan"]["nodes"][0]
    runtime = planned.effective_cfg["_supraspinaRuntime"]
    assert node["status"] == expected_status
    assert runtime["resolvedReconBackend"] == "fastsurfer"
    assert runtime["resolvedFastSurferDevice"] == "cpu"
    if expected_status == "planned":
        assert "/managed/fastsurfer-cpu.sif" in node["command"]
    else:
        assert node["reason"] == (
            "Resolve the FreeSurfer license check; status: missing."
        )


@pytest.mark.parametrize(
    ("reconall_status", "expected_status"),
    [("found", "planned"), ("missing", "blocked")],
)
def test_explicit_freesurfer_backend_keeps_its_host_requirements(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    reconall_status: str,
    expected_status: str,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    _install_active_resources(monkeypatch, cpu=False)
    request = _recon_request(root, "freesurfer")
    statuses = dict(_FREESURFER_FOUND)
    statuses["reconall"] = reconall_status

    planned = build_plan(request, env_report=_env_report(statuses))

    node = planned.result["plan"]["nodes"][0]
    assert node["status"] == expected_status
    assert planned.effective_cfg["_supraspinaRuntime"]["resolvedReconBackend"] == (
        "freesurfer"
    )
    if expected_status == "blocked":
        assert node["reason"] == "Resolve the recon-all check; status: missing."


def test_plan_workflow_rpc_returns_a_governed_auto_backend_plan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    _install_active_resources(monkeypatch)
    request = _recon_request(root, "auto")
    monkeypatch.setattr(
        "supraspina_sidecar.env.check",
        lambda _cfg: _env_report(dict(_FREESURFER_FOUND)),
    )
    dispatcher = build_dispatcher(Emitter(io.StringIO()))
    try:
        response = dispatcher.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "pipeline.planWorkflow",
                "params": [request],
            }
        )
    finally:
        dispatcher.managed_resource_manager.shutdown()
        dispatcher.provision_manager.shutdown()
        dispatcher.workflow_manager.shutdown()
        dispatcher.workflow_manager.project_epochs.detach_all()

    assert response is not None
    assert "error" not in response
    result = response["result"]
    assert result["disposition"] == "planned"
    assert result["plan"]["nodes"][0]["status"] == "planned"


def test_auto_backend_resolves_feature_extraction_requirements(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    _install_active_resources(monkeypatch)
    request = _recon_request(root, "auto")
    request["cfg"]["steps"]["features"] = {"enabled": True, "params": {}}
    request["intent"] = {
        "kind": "stage",
        "stepKey": "features",
        "target": {"mode": "all"},
    }
    statuses = dict(_FREESURFER_FOUND)
    statuses.update(
        {
            "featurepython": "found",
            "aparcstats": "found",
            "asegstats": "found",
            "features_assets": "found",
        }
    )

    planned = build_plan(request, env_report=_env_report(statuses))

    node = planned.result["plan"]["nodes"][0]
    assert node["stepKey"] == "features"
    assert node["status"] == "planned"


def test_runtime_cfg_returns_a_prepared_configuration(tmp_path: Path) -> None:
    # Planning and every consumer downstream resolve templates against this
    # mapping, so it must flatten itself once rather than once per resolution
    # while staying indistinguishable from the plain dict it wraps.
    cohort = _cohort(["sub-001"])
    effective = runtime_cfg(
        {"paths": {"projectRoot": str(tmp_path)}},
        cohort,
        "run-aabbccdd",
        str(tmp_path),
    )

    assert isinstance(effective, paths.PreparedConfig)
    assert paths.flatten(effective) == paths.flatten(dict(effective))
    assert paths.flatten(effective) is paths.flatten(effective)
    assert json.dumps(effective, sort_keys=True) == json.dumps(
        dict(effective), sort_keys=True
    )


def test_blockers_are_reported_once_per_cause_with_their_subjects(
    tmp_path: Path,
) -> None:
    # One cohort-wide cause on a per-subject stage must not repeat per
    # subject, and dependents must name the stage they wait for and the
    # root cause once instead of nesting it.
    root = tmp_path / "project"
    request = _recon_request(root, "auto")
    request["cfg"]["subjects"] = {"include": ["sub-001", "sub-002"], "exclude": []}
    request["cfg"]["steps"]["features"] = {"enabled": True, "params": {}}
    (root / "rawdata" / "sub-002" / "anat").mkdir(parents=True, exist_ok=True)
    (root / "rawdata" / "sub-002" / "anat" / "sub-002_T1w.nii.gz").write_bytes(
        (root / "rawdata" / "sub-001" / "anat" / "sub-001_T1w.nii.gz").read_bytes()
    )
    request["intent"] = {"kind": "workflow", "target": {"mode": "all"}}
    env = _env_report(
        {
            **_FREESURFER_FOUND,
            "featurepython": "found",
            "aparcstats": "found",
            "asegstats": "found",
            "features_assets": "found",
        }
    )

    planned = build_plan(request, env_report=env)

    blockers = planned.result["plan"]["blockers"]
    recon = [b for b in blockers if b["key"] == "recon"]
    assert len(recon) == 1
    assert recon[0]["subjects"] == ["sub-001", "sub-002"]
    assert len({(b["key"], b["reason"]) for b in blockers}) == len(blockers)


def test_dependents_name_the_stage_they_wait_for_and_the_root_cause_once() -> None:
    nodes = [
        {
            "nodeId": "a",
            "stepKey": "recon",
            "status": "blocked",
            "reason": "Install recon-all.",
            "dependencies": [],
        },
        {
            "nodeId": "b",
            "stepKey": "features",
            "status": "waiting",
            "dependencies": ["a"],
        },
        {"nodeId": "c", "stepKey": "age", "status": "waiting", "dependencies": ["b"]},
        {
            "nodeId": "d",
            "stepKey": "pybrainage",
            "status": "waiting",
            "dependencies": ["c"],
        },
    ]
    blockers: list[dict[str, Any]] = []

    workflow._propagate_blocked_dependencies(nodes, blockers)

    # The reasons enter the plan digest, so they keep their text here; the
    # renderer restates these exact sentences for display (RECORDED_ORDER_FACTS
    # in src/renderer/state/terminal-reason.ts, whose tests pin them too).
    assert [node["reason"] for node in nodes[1:]] == [
        "Wait for Reconstruction, which is blocked: Install recon-all.",
        "Wait for FreeSurfer feature extraction. Reconstruction is blocked: Install recon-all.",
        "Wait for Age metadata integration. Reconstruction is blocked: Install recon-all.",
    ]
    assert all("blockedRoot" not in node for node in nodes)
    assert [b["kind"] for b in blockers] == ["dependency"] * 3


@pytest.mark.parametrize("step", sorted(STEP_BY_KEY))
def test_a_stage_plan_has_no_dependency_edges(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, step: str
) -> None:
    # The scheduler's blocked-dependency reason needs a dependency edge, so a
    # stage plan cannot carry it into a plan node or the plan digest.
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root, ["sub-001", "sub-002"], step)
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS",
        {key: _Adapter(key) for key in STEP_BY_KEY},
    )

    planned = build_plan(_request(root, cfg, step, {"mode": "all"}))

    nodes = planned.result["plan"]["nodes"]
    assert nodes
    assert all(node["dependencies"] == [] for node in nodes)


@pytest.mark.parametrize(
    ("status", "sentence"),
    [
        ("failed", "Reconstruction failed, so this step did not run."),
        ("cancelled", "Reconstruction was canceled, so this step did not run."),
        ("blocked", "Reconstruction was blocked, so this step did not run."),
        (
            "withheld",
            "Reconstruction was withheld by the failure policy, so this step did "
            "not run.",
        ),
        ("interrupted", "Reconstruction was interrupted, so this step did not run."),
        ("stale", "Reconstruction has an unknown run state, so this step did not run."),
        (
            "unknown",
            "Reconstruction has an unresolved outcome, so this step did not run.",
        ),
        ("skipped", "Reconstruction was skipped, so this step did not run."),
        (
            "persistence-error",
            "Reconstruction ended with a storage error, so this step did not run.",
        ),
        ("a-future-status", "Reconstruction did not finish, so this step did not run."),
    ],
)
def test_blocked_dependency_reason_states_each_outcome_as_a_fact(
    status: str, sentence: str
) -> None:
    assert workflow.blocked_dependency_reason("recon", status) == sentence


def test_blocked_dependency_reason_names_the_stage_as_the_app_does() -> None:
    assert (
        workflow.blocked_dependency_reason("enigma", "blocked")
        == "ENIGMA QC was blocked, so this step did not run."
    )
    assert (
        workflow.blocked_dependency_reason("brainfov", "cancelled")
        == "Brain FOV preparation was canceled, so this step did not run."
    )
    # An unregistered key reads as itself instead of failing the scheduler.
    assert (
        workflow.blocked_dependency_reason("retired", "failed")
        == "retired failed, so this step did not run."
    )


_REPO_ROOT = Path(__file__).resolve().parents[2]


def test_step_names_match_the_renderer_pipeline_steps() -> None:
    steps_ts = (_REPO_ROOT / "src" / "shared" / "steps.ts").read_text(encoding="utf-8")
    block = re.search(
        r"export const PIPELINE_STEPS[^=]*=\s*\[(.*?)\n\] as const",
        steps_ts,
        re.DOTALL,
    )
    assert block, "Define PIPELINE_STEPS in steps.ts."
    names = dict(
        re.findall(r"\n    key: '([^']+)',\n    name: '([^']+)',", block.group(1))
    )
    assert names == {key: step["name"] for key, step in STEP_BY_KEY.items()}


def test_terminal_job_error_markers_match_the_renderer_restatement() -> None:
    # The renderer recognizes each marker by the order it opens with and
    # restates it as the job's outcome; an order it does not list would reach
    # the Logs stream as written, raw reason code included.
    source = (
        _REPO_ROOT / "src" / "renderer" / "state" / "terminal-reason.ts"
    ).read_text(encoding="utf-8")
    block = re.search(
        r"const TERMINAL_MARKER_OUTCOME[^=]*= new Map\(\[(.*?)\n\]\)",
        source,
        re.DOTALL,
    )
    assert block, "Define TERMINAL_MARKER_OUTCOME in terminal-reason.ts."
    orders = set(re.findall(r"\[\s*'([^']+)',\s*\{", block.group(1)))
    written = set()
    for status in TERMINAL_ERROR_JOB_STATES:
        message = _terminal_job_error_message(
            {"status": status, "exitCode": 1, "terminalReason": "some_code"}
        )
        assert message is not None
        order, separator, rest = message.partition(" (exit code 1): ")
        assert separator, message
        assert rest == "some_code."
        written.add(order)
    assert orders == written
    # A missing reason is replaced by the filler the renderer reads as none.
    assert _terminal_job_error_message({"status": "failed"}) == (
        "Investigate the failed job: Review terminal status failed."
    )
    assert "/^Review terminal status [\\w-]+\\.$/" in source
