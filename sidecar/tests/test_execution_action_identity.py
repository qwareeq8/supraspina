"""Tests for reusable execution-action identity across run directories."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.adapters.base import ADAPTERS, ExecutionAction
from supraspina_sidecar.cohort import CohortSnapshot, T1Resolution
from supraspina_sidecar.provenance import (
    RUN_DIRECTORY_PLACEHOLDER,
    canonical_action_path,
    execution_action_digest,
    expected_signature,
    make_receipt,
    receipt_signature_valid,
    runtime_run_directory,
)
from supraspina_sidecar.registry import STEP_SCOPES
from supraspina_sidecar.run_store import RECEIPT_VERSION, receipt_payload_keys
from supraspina_sidecar.workflow import RuntimeCfgInputs, runtime_cfg

COHORT_STEPS = tuple(key for key, scope in STEP_SCOPES.items() if scope == "cohort")
SUBJECT_STEPS = tuple(key for key, scope in STEP_SCOPES.items() if scope == "subject")

#: Bind one meaningful, user-visible change per cohort action. Each entry must
#: reach the built argv so a reused digest cannot hide it.
MEANINGFUL_CHANGES: dict[str, tuple[tuple[str, ...], Any]] = {
    "enigma": (("paths", "qcOutputDir"), "/elsewhere/qc"),
    "outliers": (("tools", "rscriptExecutable"), "/opt/other/Rscript"),
    "features": (("paths", "outputDir"), "/elsewhere/output"),
    "age": (("paths", "ageMetadataFile"), "/elsewhere/ages.csv"),
    "pybrainage": (("paths", "outputDir"), "/elsewhere/output"),
    "clinical": (("paths", "outputDir"), "/elsewhere/output"),
    "brainpad": (("paths", "outputDir"), "/elsewhere/output"),
    "aggregate": (("paths", "outputDir"), "/elsewhere/output"),
    "final": (("tools", "rscriptExecutable"), "/opt/other/Rscript"),
    "braincharts": (("paths", "outputDir"), "/elsewhere/output"),
    "zstats": (("tools", "rscriptExecutable"), "/opt/other/Rscript"),
}

#: Bind one saved step parameter per cohort action that must stay digest-bound.
PARAMETER_CHANGES: dict[str, tuple[str, Any]] = {
    "enigma": ("fsVersion", "6"),
    "outliers": ("zThreshold", 3.5),
    "features": ("parcellation", "aparc"),
    "age": ("join", "inner"),
    "pybrainage": ("rowFallback", False),
    "clinical": ("requiredColumns", "Cohort"),
    "brainpad": ("outDir", "analysis-alternate"),
    "aggregate": ("subjectGlob", "control-*"),
    "final": ("renderReport", False),
    "braincharts": ("seed", 7),
    "zstats": ("renderReport", False),
}


def _cohort() -> CohortSnapshot:
    return CohortSnapshot(
        analysis_subject_ids=("sub-001",),
        selected_subject_ids=("sub-001",),
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(
            T1Resolution(
                subject_id="sub-001",
                state="resolved",
                path="/raw/sub-001/anat/sub-001_T1w.nii.gz",
                candidates=(),
                fingerprint="source-sha256",
            ),
        ),
        qc_verdicts=(("sub-001", "pass"),),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def _cfg(root: Path) -> dict[str, Any]:
    return {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(root / "rawdata"),
            "derivativesDir": str(root / "derivatives"),
            "outputDir": str(root / "output"),
            "metadataDir": str(root / "metadata"),
            "qcOutputDir": str(root / "output" / "qc"),
            "ageMetadataFile": str(root / "metadata" / "ages.csv"),
            "clinicalMetadataFile": str(root / "metadata" / "clinical.csv"),
        },
        "tools": {
            "freesurferHome": "/opt/freesurfer",
            "freesurferLicense": "/opt/freesurfer/license.txt",
            "matlabExecutable": "/usr/local/bin/matlab",
            "pythonExecutable": "/usr/bin/python3",
            "rscriptExecutable": "/usr/bin/Rscript",
        },
        "pybrain": {
            "modelPath": str(root / "models" / "ExtraTreesModel"),
            "scalerPath": str(root / "models" / "scaler.pkl"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "subjects": {"include": [], "exclude": []},
        "runtime": {"dryRun": True},
        "steps": {key: {"enabled": True, "params": {}} for key in STEP_SCOPES},
    }


def _digest(cfg: dict[str, Any], step_key: str, subject_id: str | None = None) -> str:
    adapter = ADAPTERS[step_key]
    return execution_action_digest(
        adapter.execution_action(cfg, subject_id), runtime_run_directory(cfg)
    )


def _signature(
    cfg: dict[str, Any],
    step_key: str,
    subject_id: str | None = None,
    cohort: CohortSnapshot | None = None,
) -> str:
    return expected_signature(
        step_key,
        subject_id,
        cfg,
        cohort or _cohort(),
        ADAPTERS[step_key],
        upstream_signatures=[],
        tool_evidence={},
    )[0]


def _set(cfg: dict[str, Any], path: tuple[str, ...], value: Any) -> dict[str, Any]:
    changed = copy.deepcopy(cfg)
    target = changed
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return changed


@pytest.mark.parametrize("step_key", COHORT_STEPS)
def test_cohort_action_digest_survives_a_new_run_directory(
    tmp_path: Path, step_key: str
) -> None:
    saved = _cfg(tmp_path)
    first = runtime_cfg(saved, _cohort(), "run-aaaaaaaa", str(tmp_path))
    second = runtime_cfg(saved, _cohort(), "run-bbbbbbbb", str(tmp_path))

    assert _digest(first, step_key) == _digest(second, step_key)


@pytest.mark.parametrize("step_key", SUBJECT_STEPS)
def test_subject_receipt_survives_a_new_run_directory(
    tmp_path: Path, step_key: str
) -> None:
    # Brain FOV preparation refuses an unverified SynthStrip SIF, so compare the
    # receipt signature that binds either the resolved action or its deterministic
    # blocked specification.
    saved = _cfg(tmp_path)
    resources = {"synthStripSifPath": str(tmp_path / "managed" / "synthstrip.sif")}
    first = runtime_cfg(
        saved,
        _cohort(),
        "run-aaaaaaaa",
        str(tmp_path),
        inputs=RuntimeCfgInputs(resource_runtime=resources),
    )
    second = runtime_cfg(
        saved,
        _cohort(),
        "run-bbbbbbbb",
        str(tmp_path),
        inputs=RuntimeCfgInputs(resource_runtime=resources),
    )

    assert _signature(first, step_key, "sub-001") == _signature(
        second, step_key, "sub-001"
    )


@pytest.mark.parametrize("step_key", COHORT_STEPS)
def test_cohort_action_digest_tracks_a_user_supplied_change(
    tmp_path: Path, step_key: str
) -> None:
    saved = _cfg(tmp_path)
    path, value = MEANINGFUL_CHANGES[step_key]
    changed = _set(saved, path, value)
    baseline = runtime_cfg(saved, _cohort(), "run-aaaaaaaa", str(tmp_path))
    altered = runtime_cfg(changed, _cohort(), "run-aaaaaaaa", str(tmp_path))

    assert _digest(baseline, step_key) != _digest(altered, step_key)


@pytest.mark.parametrize("step_key", COHORT_STEPS)
def test_cohort_action_digest_tracks_a_saved_step_parameter(
    tmp_path: Path, step_key: str
) -> None:
    saved = _cfg(tmp_path)
    name, value = PARAMETER_CHANGES[step_key]
    changed = copy.deepcopy(saved)
    changed["steps"][step_key]["params"][name] = value
    baseline = runtime_cfg(saved, _cohort(), "run-aaaaaaaa", str(tmp_path))
    altered = runtime_cfg(changed, _cohort(), "run-bbbbbbbb", str(tmp_path))

    assert _digest(baseline, step_key) != _digest(altered, step_key)


@pytest.mark.parametrize("step_key", COHORT_STEPS)
def test_cohort_receipt_reuses_one_signature_across_run_directories(
    tmp_path: Path, step_key: str
) -> None:
    saved = _cfg(tmp_path)
    first = runtime_cfg(saved, _cohort(), "run-aaaaaaaa", str(tmp_path))
    second = runtime_cfg(saved, _cohort(), "run-bbbbbbbb", str(tmp_path))

    assert _signature(first, step_key) == _signature(second, step_key)


@pytest.mark.parametrize("step_key", COHORT_STEPS)
def test_cohort_receipt_tracks_the_selected_cohort(
    tmp_path: Path, step_key: str
) -> None:
    saved = _cfg(tmp_path)
    wider = CohortSnapshot(
        analysis_subject_ids=("sub-001", "sub-002"),
        selected_subject_ids=("sub-001", "sub-002"),
        analysis_digest="wider",
        selected_digest="wider",
        t1=(),
        qc_verdicts=(),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )
    baseline = runtime_cfg(saved, _cohort(), "run-aaaaaaaa", str(tmp_path))
    altered = runtime_cfg(saved, wider, "run-bbbbbbbb", str(tmp_path))

    assert _signature(baseline, step_key) != _signature(altered, step_key, cohort=wider)


def test_run_directory_token_replaces_only_the_run_directory(tmp_path: Path) -> None:
    run_dir = str(tmp_path / ".supraspina" / "runs" / "run-aaaaaaaa")
    inside = f"{run_dir}/inputs/subjects.txt"
    sibling = f"{run_dir}-other/inputs/subjects.txt"
    unrelated = str(tmp_path / "rawdata" / "sub-001.nii.gz")

    assert canonical_action_path(run_dir, run_dir) == RUN_DIRECTORY_PLACEHOLDER
    assert canonical_action_path(inside, run_dir) == (
        f"{RUN_DIRECTORY_PLACEHOLDER}/inputs/subjects.txt"
    )
    assert canonical_action_path(sibling, run_dir) == sibling
    assert canonical_action_path(unrelated, run_dir) == unrelated
    assert canonical_action_path(inside, "") == inside


def test_superseded_receipt_versions_fail_closed(tmp_path: Path) -> None:
    saved = _cfg(tmp_path)
    effective = runtime_cfg(saved, _cohort(), "run-aaaaaaaa", str(tmp_path))
    signature, payload = expected_signature(
        "features",
        None,
        effective,
        _cohort(),
        ADAPTERS["features"],
        upstream_signatures=[],
        tool_evidence={},
    )
    receipt = make_receipt(
        signature,
        payload,
        {"state": "done", "artifacts": []},
        run_id="run-aaaaaaaa",
        job_id="job-features",
        committed_at_ms=1,
    )

    assert payload["receiptVersion"] == RECEIPT_VERSION == 4
    assert receipt_signature_valid(receipt, signature)
    assert receipt_payload_keys(3) is None
    assert not receipt_signature_valid({**receipt, "receiptVersion": 3}, signature)


def test_action_kind_source_destination_and_force_stay_bound() -> None:
    run_dir = "/project/.supraspina/runs/run-aaaaaaaa"
    base = ExecutionAction(
        kind="copy",
        argv=(),
        source=f"{run_dir}/inputs/prepared.nii.gz",
        destination="/derivatives/prepared/sub-001_T1w.nii.gz",
        force=False,
    )
    moved = ExecutionAction(
        kind="copy",
        argv=(),
        source="/project/.supraspina/runs/run-bbbbbbbb/inputs/prepared.nii.gz",
        destination="/derivatives/prepared/sub-001_T1w.nii.gz",
        force=False,
    )
    other_run_dir = "/project/.supraspina/runs/run-bbbbbbbb"

    assert execution_action_digest(base, run_dir) == execution_action_digest(
        moved, other_run_dir
    )
    for changed in (
        ExecutionAction(
            kind="move",
            argv=base.argv,
            source=base.source,
            destination=base.destination,
        ),
        ExecutionAction(
            kind=base.kind,
            argv=base.argv,
            source=base.source,
            destination="/derivatives/prepared/sub-002_T1w.nii.gz",
        ),
        ExecutionAction(
            kind=base.kind,
            argv=base.argv,
            source=base.source,
            destination=base.destination,
            force=True,
        ),
        ExecutionAction(
            kind=base.kind,
            argv=("extra",),
            source=base.source,
            destination=base.destination,
        ),
    ):
        assert execution_action_digest(changed, run_dir) != execution_action_digest(
            base, run_dir
        )
