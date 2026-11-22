"""Receipt safety: the trailing stages move no node and change no receipt.

BrainCharts and the z-score comparisons plan after every other stage.
Turning both on plans only their two nodes and changes no other node or
signature.
"""

from __future__ import annotations

import copy
import uuid
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import workflow
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.provenance import (
    bind_projection_inputs,
    bound_tool_evidence,
    expected_signature,
)
from supraspina_sidecar.registry import (
    STEP_BY_KEY,
    STEP_SCOPES,
)
from supraspina_sidecar.registry_store import RegistryStore
from supraspina_sidecar.workflow import PlannedWorkflow, build_plan
from supraspina_sidecar.workflow_manager import WorkflowManager

_RUN_ID = "run-0000000000ab"
_SUBJECTS = {
    "sub-001": ("CTRL", 31, "F"),
    "sub-002": ("CTRL", 42, "M"),
    "sub-003": ("CTRL", 55, "F"),
    "sub-004": ("SCI_P", 38, "M"),
    "sub-005": ("SCI_P", 47, "F"),
    "sub-006": ("SCI_nNP", 60, "M"),
    "sub-007": ("SCI_nNP", 29, "F"),
    # A fourth control, so 2 controls are held out and the z-score
    # comparisons have 2 subjects with z-scores in every group.
    "sub-008": ("CTRL", 50, "M"),
}
_APPENDED = ("braincharts", "zstats")


@pytest.fixture(autouse=True)
def _fixed_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workflow.uuid, "uuid4", lambda: uuid.UUID(int=0xBC))


def _saved_project(root: Path) -> dict[str, Any]:
    """Write a project without sites and with the trailing stages turned off.

    Brain FOV preparation and defacing are off so the plan reaches real
    commands without the managed SynthStrip image.
    """
    raw = root / "rawdata"
    for subject_id, (label, age, sex) in _SUBJECTS.items():
        path = raw / subject_id / "anat" / f"{subject_id}_T1w.nii.gz"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(subject_id.encode())
        RegistryStore(str(root)).upsert(
            {
                "subjectId": subject_id,
                "age": age,
                "sex": sex,
                "sourceCohortLabel": label,
                "ais": None,
                "tSinceSci": None,
            }
        )
    metadata = root / "metadata"
    metadata.mkdir()
    for name, header, row in (
        ("metadata.csv", "participant_id,Cohort", "{subject},x"),
        ("age.csv", "participant_id,age", "{subject},{age}"),
        ("clinical.csv", "participant_id,Cohort,AIS", "{subject},x,A"),
    ):
        (metadata / name).write_text(
            header
            + "\n"
            + "".join(
                row.format(subject=subject, age=values[1]) + "\n"
                for subject, values in _SUBJECTS.items()
            ),
            encoding="utf-8",
        )
    steps = {
        key: {
            "enabled": key not in {"brainfov", "deface", *_APPENDED},
            "params": {},
        }
        for key in STEP_BY_KEY
    }
    steps["features"]["params"] = {
        "parcellation": "aparc.a2009s",
        "measure": "thickness",
    }
    steps["final"]["params"] = {"renderReport": True}
    return {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(raw),
            "derivativesDir": str(root / "derivatives"),
            "outputDir": str(root / "outputs"),
            "metadataDir": str(metadata),
            "ageMetadataFile": str(metadata / "age.csv"),
            "clinicalMetadataFile": str(metadata / "clinical.csv"),
            "qcOutputDir": str(root / "outputs" / "qc"),
        },
        "tools": {
            "freesurferHome": "/opt/freesurfer",
            "freesurferLicense": "/opt/freesurfer/license.txt",
            "pythonExecutable": "/usr/bin/python3",
            "rscriptExecutable": "/usr/bin/Rscript",
        },
        "pybrain": {
            "modelPath": str(root / "models" / "ExtraTreesModel"),
            "scalerPath": str(root / "models" / "scaler.pkl"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "subjects": {"include": [], "exclude": []},
        "runtime": {"dryRun": True, "threads": 2},
        "steps": steps,
    }


def _environment() -> dict[str, Any]:
    """Report every check any stage could require as found."""
    ids = sorted(
        {
            check_id
            for adapter in ADAPTERS.values()
            for check_id in adapter.required_check_ids({})
        }
        | {"rmarkdown", "knitr", "pandoc", "final_report_assets"}
    )
    return {
        "availableMemoryGB": 64,
        "groups": [
            {
                "name": "Tools",
                "checks": [
                    {
                        "id": check_id,
                        "label": check_id,
                        "status": "found",
                        "detail": f"{check_id} 1.0",
                    }
                    for check_id in ids
                ],
            }
        ],
    }


def _plan(root: Path, cfg: dict[str, Any], env: dict[str, Any]) -> PlannedWorkflow:
    return build_plan(
        {
            "project": {
                "projectId": "invariance",
                "root": str(root),
                "configPath": str(root / "supraspina.project.json"),
                "epoch": 1,
            },
            "cfg": copy.deepcopy(cfg),
            "configRevision": 3,
            "intent": {"kind": "workflow", "target": {"mode": "all"}},
            "acknowledgements": {"includeDeferredAndUnreviewedQc": True},
        },
        run_id=_RUN_ID,
        env_report=env,
    )


def _signatures(planned: PlannedWorkflow, env: dict[str, Any]) -> dict[Any, str]:
    """Sign every node through its full lineage, as the scheduler does."""
    cfg = planned.effective_cfg
    cohort = planned.cohort
    assert cohort is not None
    evidence = WorkflowManager._environment_summary(env)
    cache: dict[tuple[str, str | None], str] = {}

    def sign(step_key: str, subject_id: str | None) -> str:
        key = (step_key, subject_id)
        if key not in cache:
            upstream: list[str] = []
            for producer in WorkflowManager._logical_dependencies(cfg, step_key):
                if producer == "recon":
                    upstream.extend(
                        sign("recon", item) for item in cohort.analysis_subject_ids
                    )
                elif STEP_SCOPES[producer] == "subject":
                    upstream.append(sign(producer, subject_id))
                else:
                    upstream.append(sign(producer, None))
            adapter = ADAPTERS[step_key]
            cache[key] = bind_projection_inputs(
                step_key,
                *expected_signature(
                    step_key,
                    subject_id,
                    cfg,
                    cohort,
                    adapter,
                    upstream_signatures=upstream,
                    tool_evidence=bound_tool_evidence(
                        evidence, adapter.required_check_ids(cfg)
                    ),
                ),
            )[0]
        return cache[key]

    return {
        (node["stepKey"], node["subjectId"]): sign(node["stepKey"], node["subjectId"])
        for node in planned.result["plan"]["nodes"]
        if node["stepKey"] not in _APPENDED
    }


def test_planned_nodes_stay_planned_with_the_stages_registered(tmp_path: Path) -> None:
    """The fixture plans real work, so the equalities below are not vacuous."""
    root = tmp_path / "project"
    planned = _plan(root, _saved_project(root), _environment())
    statuses = {
        node["stepKey"]: node["status"] for node in planned.result["plan"]["nodes"]
    }
    assert statuses["features"] in {"planned", "waiting"}
    assert statuses["final"] in {"planned", "waiting"}
    assert statuses["braincharts"] == "skipped"
    assert statuses["zstats"] == "skipped"


def test_turning_both_stages_on_adds_work_only_at_their_nodes(tmp_path: Path) -> None:
    root = tmp_path / "project"
    saved = _saved_project(root)
    env = _environment()
    off = _plan(root, saved, env)
    enabled = copy.deepcopy(saved)
    enabled["steps"]["braincharts"] = {"enabled": True, "params": {"seed": 117}}
    enabled["steps"]["zstats"] = {"enabled": True, "params": {"renderReport": True}}
    on = _plan(root, enabled, env)
    assert on.result["plan"]["nodes"][:-2] == off.result["plan"]["nodes"][:-2]
    braincharts, zstats = on.result["plan"]["nodes"][-2:]
    assert (braincharts["stepKey"], braincharts["status"]) == ("braincharts", "waiting")
    assert (zstats["stepKey"], zstats["status"]) == ("zstats", "waiting")
    assert zstats["dependencies"] == [braincharts["nodeId"]]
    assert [node["nodeId"] for node in on.result["plan"]["nodes"][-2:]] == [
        node["nodeId"] for node in off.result["plan"]["nodes"][-2:]
    ]
    assert on.result["plan"]["blockers"] == off.result["plan"]["blockers"]
    assert _signatures(on, env) == _signatures(off, env)


def test_turning_zstats_on_alone_blocks_only_its_node(tmp_path: Path) -> None:
    root = tmp_path / "project"
    saved = _saved_project(root)
    env = _environment()
    off = _plan(root, saved, env)
    enabled = copy.deepcopy(saved)
    enabled["steps"]["zstats"] = {"enabled": True, "params": {}}
    on = _plan(root, enabled, env)
    assert on.result["plan"]["nodes"][:-1] == off.result["plan"]["nodes"][:-1]
    assert on.result["plan"]["nodes"][-1]["status"] == "blocked"
    assert on.result["plan"]["nodes"][-1]["reason"] == (
        "Enable BrainCharts normative modeling; the z-score comparisons read its "
        "z-scores."
    )
    assert _signatures(on, env) == _signatures(off, env)
