"""Controlled full-pipeline durable dry-run integration regression test."""

from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from supraspina_sidecar import workflow as planner
from supraspina_sidecar import workflow_manager as runtime
from supraspina_sidecar.adapters.base import StepStatus, Validation
from supraspina_sidecar.cohort import CohortSnapshot, T1Resolution
from supraspina_sidecar.provenance import stable_digest
from supraspina_sidecar.registry_store import RegistryStore
from supraspina_sidecar.run_store import RunStore
from supraspina_sidecar.workflow_manager import WorkflowManager

_SUBJECT_ROLES = {
    "sub-0001": "control",
    "sub-0002": "control",
    "sub-0003": "SCI_P",
    "sub-0004": "SCI_P",
    "sub-0005": "SCI_nNP",
    "sub-0006": "SCI_nNP",
    # Four controls, so BrainCharts holds 2 out and the z-score comparisons
    # have 2 subjects with z-scores in every group.
    "sub-0007": "control",
    "sub-0008": "control",
}
_SUBJECT_IDS = tuple(_SUBJECT_ROLES)
_STEP_KEYS = (
    "brainfov",
    "deface",
    "recon",
    "enigma",
    "outliers",
    "features",
    "age",
    "pybrainage",
    "clinical",
    "brainpad",
    "aggregate",
    "final",
    "braincharts",
    "zstats",
)
_SCOPES = {
    "brainfov": "subject",
    "deface": "subject",
    "recon": "subject",
    "enigma": "cohort",
    "outliers": "cohort",
    "features": "cohort",
    "age": "cohort",
    "pybrainage": "cohort",
    "clinical": "cohort",
    "brainpad": "cohort",
    "aggregate": "cohort",
    "final": "cohort",
    "braincharts": "cohort",
    "zstats": "cohort",
}


class _Emitter:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def emit(self, method: str, params: dict[str, Any]) -> None:
        self.events.append((method, params))


class _DeterministicAdapter:
    def __init__(self, key: str) -> None:
        self.key = key

    def validate(self, _cfg: dict[str, Any], _env: dict[str, Any]) -> Validation:
        return Validation()

    def build_command(self, _cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        target = ["--subject", subject_id] if subject_id else ["--cohort"]
        return ["fixture-tool", self.key, *target]

    def preview(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        return " ".join(self.build_command(cfg, subject_id))

    def detect(self, _cfg: dict[str, Any], _subject_id: str | None) -> StepStatus:
        return StepStatus("pending")

    def required_check_ids(self, _cfg: dict[str, Any]) -> tuple[str, ...]:
        return ()

    def output_path(self, cfg: dict[str, Any], subject_id: str) -> str:
        return str(
            Path(cfg["paths"]["derivativesDir"])
            / "defaced"
            / subject_id
            / "anat"
            / f"{subject_id}_T1w.nii.gz"
        )

    def preflight_signature(self, _cfg: dict[str, Any], subject_id: str) -> str:
        return hashlib.sha256(f"brainfov:{subject_id}".encode()).hexdigest()


class _PassThroughInputFovReview:
    def resolve_each_for_cohort(
        self,
        _request: dict[str, Any],
        t1_by_subject: dict[str, str],
        *,
        expected_preflight_by_subject: dict[str, str],
    ) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
        resolved: dict[str, dict[str, Any]] = {}
        for subject_id, raw_path in sorted(t1_by_subject.items()):
            source_sha256 = hashlib.sha256(Path(raw_path).read_bytes()).hexdigest()
            resolved[subject_id] = {
                "preparedT1Path": raw_path,
                "passThrough": True,
                "preflightSignature": expected_preflight_by_subject[subject_id],
                "sourceSha256": source_sha256,
                "outputSha256": source_sha256,
            }
        return resolved, {}


def _project(root: Path) -> dict[str, Any]:
    return {
        "projectId": "full-pipeline-dry-run",
        "root": str(root.resolve()),
        "configPath": str((root / "supraspina.project.json").resolve()),
        "epoch": 1,
    }


def _config(root: Path) -> dict[str, Any]:
    return {
        "paths": {
            "projectRoot": str(root.resolve()),
            "rawdataDir": str((root / "rawdata").resolve()),
            "derivativesDir": str((root / "derivatives").resolve()),
            "outputDir": str((root / "output").resolve()),
        },
        "patterns": {
            "subjectGlob": "sub-*",
            "t1Pattern": "*_T1w.nii.gz",
        },
        "subjects": {"include": [], "exclude": []},
        "runtime": {
            "dryRun": True,
            "queueSize": 1,
            "memoryWarningGB": 10,
            "resumeCompleted": False,
            "rerunIncomplete": False,
        },
        "steps": {
            "brainfov": {"enabled": True, "params": {"marginMm": 30}},
            "deface": {"enabled": True, "params": {}},
            "recon": {
                "enabled": True,
                "params": {
                    "backend": "freesurfer",
                    "fastsurferDevice": "auto",
                },
            },
            "enigma": {"enabled": True, "params": {}},
            "outliers": {"enabled": True, "params": {}},
            "features": {
                "enabled": True,
                "params": {
                    "parcellation": "aparc.a2009s",
                    "measure": "thickness",
                },
            },
            "age": {"enabled": True, "params": {"join": "left"}},
            "pybrainage": {"enabled": True, "params": {}},
            "clinical": {"enabled": True, "params": {}},
            "brainpad": {"enabled": True, "params": {}},
            "aggregate": {
                "enabled": True,
                "params": {"subjectGlob": "sub-*"},
            },
            "final": {"enabled": True, "params": {}},
            "braincharts": {"enabled": True, "params": {"seed": 117}},
            "zstats": {"enabled": True, "params": {"renderReport": True}},
        },
    }


def _cohort(root: Path) -> CohortSnapshot:
    rows = []
    for subject_id in _SUBJECT_IDS:
        path = root / "rawdata" / subject_id / "anat" / f"{subject_id}_T1w.nii.gz"
        fingerprint = hashlib.sha256(path.read_bytes()).hexdigest()
        rows.append(
            T1Resolution(
                subject_id=subject_id,
                state="resolved",
                path=str(path),
                candidates=(str(path),),
                fingerprint=fingerprint,
            )
        )
    digest = stable_digest(list(_SUBJECT_IDS))
    return CohortSnapshot(
        analysis_subject_ids=_SUBJECT_IDS,
        selected_subject_ids=_SUBJECT_IDS,
        analysis_digest=digest,
        selected_digest=digest,
        t1=tuple(rows),
        qc_verdicts=tuple((subject_id, "pass") for subject_id in _SUBJECT_IDS),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def _prepare_project(root: Path) -> CohortSnapshot:
    root.mkdir()
    for index, subject_id in enumerate(_SUBJECT_IDS):
        role = _SUBJECT_ROLES[subject_id]
        path = root / "rawdata" / subject_id / "anat" / f"{subject_id}_T1w.nii.gz"
        path.parent.mkdir(parents=True)
        path.write_bytes(f"deterministic-t1-{subject_id}".encode())
        RegistryStore(str(root)).upsert(
            {
                "subjectId": subject_id,
                "age": 30 + index,
                "sex": "F" if index == 0 else "M",
                "sourceCohortLabel": role,
                "ais": None if role == "control" else "C",
                "tSinceSci": None if role == "control" else 2.0,
            }
        )
    return _cohort(root)


def _expected_dependencies() -> dict[
    tuple[str, str | None], list[tuple[str, str | None]]
]:
    expected: dict[tuple[str, str | None], list[tuple[str, str | None]]] = {}
    for subject_id in _SUBJECT_IDS:
        expected[("brainfov", subject_id)] = []
        expected[("deface", subject_id)] = [("brainfov", subject_id)]
        expected[("recon", subject_id)] = [("deface", subject_id)]
    recon = [("recon", subject_id) for subject_id in _SUBJECT_IDS]
    expected.update(
        {
            ("enigma", None): recon,
            ("outliers", None): [("enigma", None)],
            ("features", None): recon,
            ("age", None): [("features", None)],
            ("pybrainage", None): [("age", None)],
            ("clinical", None): [("pybrainage", None)],
            ("brainpad", None): [("clinical", None)],
            ("aggregate", None): recon,
            ("final", None): [("aggregate", None)],
            ("braincharts", None): [("features", None)],
            ("zstats", None): [("braincharts", None)],
        }
    )
    return expected


def _assert_authoritative_graph(nodes: list[dict[str, Any]]) -> None:
    identities_by_id = {
        node["nodeId"]: (node["stepKey"], node["subjectId"]) for node in nodes
    }
    observed_steps = tuple(dict.fromkeys(node["stepKey"] for node in nodes))
    assert observed_steps == _STEP_KEYS
    assert len(nodes) == len(_SUBJECT_IDS) * 3 + 11
    assert {node["status"] for node in nodes} == {"planned"}
    assert {
        (node["stepKey"], node["subjectId"]): [
            identities_by_id[dependency] for dependency in node["dependencies"]
        ]
        for node in nodes
    } == _expected_dependencies()
    for node in nodes:
        expected_subject = node["subjectId"]
        assert node["scope"] == _SCOPES[node["stepKey"]]
        assert expected_subject is not None or node["scope"] == "cohort"
        target = (
            f"--subject {expected_subject}"
            if expected_subject is not None
            else "--cohort"
        )
        assert node["command"] == f"fixture-tool {node['stepKey']} {target}"


def _assert_durable_dry_run(
    root: Path,
    run_id: str,
    state: dict[str, Any],
) -> None:
    assert state["runId"] == run_id
    assert state["status"] == "planned"
    assert state["terminalReason"] == "dry_run"
    assert state["dryRun"] is True
    assert state["durable"] is True
    assert state["endedAtMs"] is not None
    assert state["receipts"] == []
    _assert_authoritative_graph(state["nodes"])
    jobs = state["jobs"]
    assert [job["nodeId"] for job in jobs] == [
        node["nodeId"] for node in state["nodes"]
    ]
    assert len(jobs) == len(state["nodes"])
    nodes_by_id = {node["nodeId"]: node for node in state["nodes"]}
    for job in jobs:
        assert job["status"] == "planned"
        assert job["dryRun"] is True
        assert job["durable"] is True
        assert job["persistenceStatus"] == "durable"
        assert job["terminalReason"] == "dry_run"
        assert job["startedAt"] is None
        assert job["endedAt"] is not None
        assert job["cmd"] == nodes_by_id[job["nodeId"]]["command"]
        assert job["stdoutPath"] == ""
        assert job["stderrPath"] == ""
    store = RunStore(str(root))
    assert not (Path(store.run_dir(run_id)) / "logs").exists()
    assert not Path(store.receipts_root).exists()


def test_full_pipeline_accepted_dry_run_is_durable_without_execution_and_restarts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "controlled-project"
    cohort = _prepare_project(root)
    cfg = _config(root)
    adapters = {key: _DeterministicAdapter(key) for key in _STEP_KEYS}
    monkeypatch.setattr(planner, "ADAPTERS", adapters)
    monkeypatch.setattr(runtime, "ADAPTERS", adapters)
    monkeypatch.setattr(
        planner,
        "build_cohort_snapshot",
        lambda *_args, **_kwargs: cohort,
    )
    monkeypatch.setattr(
        planner,
        "resolve_runtime_resources",
        lambda *_args, **_kwargs: SimpleNamespace(
            runtime={},
            blockers={},
            advisories=(),
            evidence={},
        ),
    )
    spawn_calls: list[tuple[Any, ...]] = []

    def forbidden_spawn(*args: Any, **_kwargs: Any) -> None:
        spawn_calls.append(args)
        raise AssertionError("Prevent the accepted dry run from spawning.")

    request = {
        "project": _project(root),
        "cfg": cfg,
        "configRevision": 7,
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "acknowledgements": {
            "includeDeferredAndUnreviewedQc": True,
            "acknowledgeMemoryAdvisory": False,
        },
    }
    manager = WorkflowManager(
        _Emitter(),
        spawn=forbidden_spawn,
        env_check=lambda _cfg: {"groups": [], "availableMemoryGB": 24.0},
    )
    manager.input_fov_reviews = _PassThroughInputFovReview()
    try:
        preview = manager.plan(request)
        _assert_authoritative_graph(preview["plan"]["nodes"])
        request["approvedPlan"] = {
            "planId": preview["plan"]["planId"],
            "digest": preview["plan"]["digest"],
        }

        result = manager.run(request)

        assert result["disposition"] == "planned"
        assert result["runId"] == preview["plan"]["planId"]
        assert manager.active_counts() == (0, 0)
        assert spawn_calls == []
        # Say plainly that nothing ran; the plan totals alone read like a start.
        assert result["summary"]["message"].startswith("Dry run only: planned ")
        assert "executed nothing" in result["summary"]["message"]
    finally:
        manager.shutdown()

    store = RunStore(str(root))
    state = store.load(result["runId"])
    _assert_durable_dry_run(root, result["runId"], state)

    restored_manager = WorkflowManager(_Emitter(), spawn=forbidden_spawn)
    try:
        restored = restored_manager.bootstrap(
            {
                "project": _project(root),
                "runLimit": 10,
                "logLimit": 100,
            }
        )
    finally:
        restored_manager.shutdown()

    assert len(restored["runs"]) == 1
    assert restored["runs"][0]["runId"] == result["runId"]
    assert restored["runs"][0]["status"] == "planned"
    assert restored["runs"][0]["dryRun"] is True
    assert restored["runs"][0]["summary"]["planned"] == len(_SUBJECT_IDS) * 3 + 11
    assert len(restored["jobs"]) == len(_SUBJECT_IDS) * 3 + 11
    assert {job["status"] for job in restored["jobs"]} == {"planned"}
    assert all(job["dryRun"] is True for job in restored["jobs"])
    assert restored["logTail"] == []
    assert spawn_calls == []
