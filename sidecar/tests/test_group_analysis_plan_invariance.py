"""Receipt safety: the analysis never changes a plan, a run, or a receipt.

The panel's state lives only under ``.supraspina/analysis/``. A project plans to
the same digests with and without a populated analysis store, and a full
compute (catalog, sample, compute, list, export, library writes) creates or
changes files only under ``.supraspina/analysis/``: ``runs/``, ``receipts/``,
the registry, the QC store, and every pipeline output stay byte-identical.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import workflow
from supraspina_sidecar.group_analysis import store
from supraspina_sidecar.group_analysis.manager import GroupAnalysisManager
from supraspina_sidecar.project import ProjectEpochs
from supraspina_sidecar.workflow_manager import WorkflowManager
from tests.group_analysis_support import (
    example_spec,
    make_project,
    request,
    sample_record,
    write_qc,
)

_SIDECAR = Path(__file__).resolve().parents[1]
_FAKE_WORKER = (
    "from tests.group_analysis_support import fake_run\n"
    "from supraspina_sidecar.group_analysis import engine, worker\n"
    "engine.run = fake_run\n"
    "raise SystemExit(worker.main([]))\n"
)
_DIGESTS = ("digest", "configDigest", "qcDigest", "registryDigest", "environmentDigest")


@pytest.fixture(autouse=True)
def _fixed_plan_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the planner's random plan ID, which the plan digest binds."""
    monkeypatch.setattr(workflow.uuid, "uuid4", lambda: uuid.UUID(int=0xABC))


class _Emitter:
    def emit(self, _method: str, _params: dict[str, Any]) -> None:
        return None


def _project(root: Path) -> dict[str, Any]:
    cfg = make_project(root)
    for number in range(1, 11):
        subject_id = f"sub-{number:02d}"
        t1 = root / "rawdata" / subject_id / "anat" / f"{subject_id}_T1w.nii.gz"
        t1.parent.mkdir(parents=True, exist_ok=True)
        t1.write_bytes(subject_id.encode())
    write_qc(root, {"sub-01": "pass", "sub-02": "fail"})
    cfg["runtime"] = {"dryRun": True}
    cfg["steps"] = {
        key: {"enabled": True, "params": {}}
        for key in ("recon", "aggregate", "outliers", "pybrainage", "final")
    }
    cfg["steps"]["aggregate"]["params"]["outDir"] = "${paths.outputDir}/structural"
    # Existing run state and receipts that the analysis must never touch.
    for relative in (
        ".supraspina/runs/run-aaaaaaaaaaaa/state.json",
        ".supraspina/receipts/aggregate/cohort.json",
        ".supraspina/receipts/pybrainage/cohort.json",
    ):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"fixture": "' + relative + '"}\n', encoding="utf-8")
    return cfg


def _plan(root: Path, cfg: dict[str, Any]) -> dict[str, Any]:
    manager = WorkflowManager(_Emitter(), env_check=lambda _cfg: {"groups": []})
    try:
        return manager.plan(
            {
                "project": {
                    "projectId": "invariance",
                    "root": str(root),
                    "configPath": str(root / "supraspina.project.json"),
                    "epoch": 1,
                },
                "cfg": cfg,
                "configRevision": 1,
                "intent": {"kind": "workflow", "target": {"mode": "all"}},
                "acknowledgements": {"includeDeferredAndUnreviewedQc": True},
            }
        )["plan"]
    finally:
        manager.shutdown()


def _tree(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _spawn(argv: list[str]) -> subprocess.Popen[bytes]:
    del argv
    return subprocess.Popen(  # noqa: S603 - A test worker.
        [sys.executable, "-c", _FAKE_WORKER],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        cwd=_SIDECAR,
    )


def test_a_populated_analysis_store_leaves_the_plan_digest_unchanged(
    tmp_path: Path,
) -> None:
    cfg = _project(tmp_path)
    before = _plan(tmp_path, cfg)
    assert before["nodes"]

    root = str(tmp_path)
    library = store.save_set(
        root,
        set_id=None,
        name="A priori",
        measures=["aseg:Brain-Stem"],
        expected_revision=0,
    )
    store.lock_set(root, set_id=library["sets"][0]["setId"], expected_revision=1)
    for index in range(1, 4):
        store.write_result(
            root, sample_record(f"gar-{index:016x}", f"2026-09-30T12:00:0{index}.000Z")
        )
    (tmp_path / ".supraspina" / "analysis" / "results" / ".tmp-partial").write_text("x")
    # Analysis v2 state: atlas labels, imported variables and their caches.
    for relative, text in (
        ("atlases/brainstem-ss/sub-01/volumes.json", "{}"),
        ("atlases/schaefer400-7/templates/fsaverage5/lh.annot", "annot"),
        ("atlases/revision.json", '{"revision": 3}'),
        ("variables/pain.csv", "subject,pain\nsub-01,4\n"),
        ("variables/index.json", "{}"),
    ):
        path = tmp_path / ".supraspina" / "analysis" / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    after = _plan(tmp_path, cfg)

    assert after == before
    for key in _DIGESTS:
        assert after[key] == before[key], key


def test_a_full_compute_writes_only_under_the_analysis_store(tmp_path: Path) -> None:
    cfg = _project(tmp_path)
    before = _tree(tmp_path)
    plan_before = _plan(tmp_path, cfg)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=_spawn)

    mgr.catalog(request(tmp_path, cfg))
    mgr.inputs(request(tmp_path, cfg, spec=example_spec()))
    saved = mgr.save_spec(
        request(
            tmp_path,
            cfg,
            specId=None,
            name="Primary",
            spec=example_spec(),
            expectedRevision=0,
        )
    )
    mgr.start(
        request(
            tmp_path,
            cfg,
            spec=example_spec(),
            stageCurrency={"aggregate": "current", "pybrainage": "unknown"},
        )
    )
    deadline = time.monotonic() + 60
    while mgr.status(request(tmp_path, cfg))["operation"]["state"] == "running":
        assert time.monotonic() < deadline
        time.sleep(0.05)
    operation = mgr.status(request(tmp_path, cfg))["operation"]
    assert operation["state"] == "done"
    result_id = operation["resultId"]
    mgr.list(request(tmp_path, cfg))
    mgr.result(request(tmp_path, cfg, resultId=result_id))
    mgr.measure_detail(
        request(tmp_path, cfg, resultId=result_id, measureId="aseg:Brain-Stem")
    )
    mgr.export_data(request(tmp_path, cfg, resultId=result_id, subjectCsv=True))
    assert saved["revision"] == 1

    after = _tree(tmp_path)
    changed = {
        path
        for path in before.keys() | after.keys()
        if before.get(path) != after.get(path)
    }
    assert changed
    assert all(path.startswith(".supraspina/analysis/") for path in changed), sorted(
        changed
    )
    assert changed == {
        ".supraspina/analysis/specs.json",
        f".supraspina/analysis/results/{result_id}.json",
    }
    assert _plan(tmp_path, cfg) == plan_before
