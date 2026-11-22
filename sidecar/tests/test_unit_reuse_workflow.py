"""End-to-end per-subject reuse in ENIGMA QC through the real workflow manager.

The synthetic project runs the real planner, launcher, receipts, and the
reviewed ENIGMA wrapper; only reconstruction and the three compiled MATLAB
renderers are stand-ins. No participant data is involved.
"""

from __future__ import annotations

import copy
import hashlib
import json
import shutil
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import env, resources, workflow
from supraspina_sidecar.adapters import enigma as enigma_module
from supraspina_sidecar.adapters.base import ADAPTERS, UNIT_CONTRACTS
from supraspina_sidecar.registry_store import RegistryStore
from supraspina_sidecar.run_store import UNIT_REUSE_KEY, RunStore
from supraspina_sidecar.workflow_manager import WorkflowManager
from tests import synthetic_receipt_project as synth
from tests.test_unit_reuse import _fake_compiled

_DOWNSTREAM = (
    "outliers",
    "features",
    "age",
    "pybrainage",
    "clinical",
    "brainpad",
    "aggregate",
    "final",
)
_NEW_SUBJECT = "sub-909"


class _Project:
    """Hold one synthetic project and run it like the app does."""

    def __init__(self, tmp_path: Path) -> None:
        self.root = tmp_path / "project"
        self.rawdata = tmp_path / "rawdata"
        self.cfg = synth.write_inputs(self.root, self.rawdata)
        base = tmp_path / "enigma"
        compiled, self.render_log = _fake_compiled(tmp_path)
        shutil.copytree(compiled, base / "compiled")
        shutil.copy(
            resources.enigma_dir()
            / "compiled"
            / "enigma_fs_wrapper_script_compiled.sh",
            base / "compiled" / "enigma_fs_wrapper_script_compiled.sh",
        )
        (tmp_path / "mcr").mkdir()
        self.cfg["steps"]["enigma"]["params"].update(
            {
                "backend": "mcr",
                "mcrRoot": str(tmp_path / "mcr"),
                "enigmaScriptDir": str(base),
            }
        )
        for step in _DOWNSTREAM:
            self.cfg["steps"][step]["enabled"] = False
        self.save()

    def save(self) -> None:
        (self.root / synth.PROJECT_FILE).write_text(json.dumps(self.cfg, indent=2))

    def add_subject(self, subject_id: str) -> None:
        synth._write(
            self.rawdata / subject_id / "anat" / f"{subject_id}_T1w.nii.gz",
            f"synthetic T1 placeholder for {subject_id}\n",
        )
        RegistryStore(str(self.root)).upsert(
            {
                "subjectId": subject_id,
                "age": 40,
                "sex": "F",
                "sourceCohortLabel": "CTRL",
                "ais": None,
                "tSinceSci": None,
            }
        )

    def request(self) -> dict[str, Any]:
        return synth._request(self.root, copy.deepcopy(self.cfg))

    @property
    def out_dir(self) -> Path:
        return self.root / "derivatives" / "supraspina" / "qc_review"


def _write_recon(cfg: dict[str, Any], subject_id: str) -> None:
    adapter = ADAPTERS["recon"]
    synth._write_recon(adapter, cfg, subject_id)
    root = Path(adapter._subject_dir(cfg, subject_id))  # type: ignore[attr-defined]
    for relative in (
        "surf/lh.pial.T1",
        "surf/rh.pial.T1",
        "label/lh.aparc.annot",
        "label/rh.aparc.annot",
    ):
        synth._write(root / relative, f"synthetic {relative} for {subject_id}\n")


@contextmanager
def _manager() -> Any:
    current = threading.local()

    def spawn(argv: list[str]) -> Any:
        node, ctx = current.node, current.ctx
        if node["stepKey"] == "recon":
            _write_recon(ctx.effective_cfg, str(node["subjectId"]))
            argv = ["/bin/true"]
        elif argv[0] == "xvfb-run":
            argv = argv[2:]
        return subprocess.Popen(  # noqa: S603 - The planner's own argv.
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )

    manager = WorkflowManager(synth._Emitter(), spawn=spawn)
    original = manager._execute_inner

    def execute(ctx: Any, node_id: str, job_id: str, cancel_event: Any) -> None:
        current.node = next(n for n in ctx.state["nodes"] if n["nodeId"] == node_id)
        current.ctx = ctx
        original(ctx, node_id, job_id, cancel_event)

    manager._execute_inner = execute  # type: ignore[method-assign]
    manager.authorizations.consume = lambda *_args, **_kwargs: None  # type: ignore[method-assign]
    try:
        yield manager
    finally:
        manager.shutdown()


def _run(project: _Project) -> tuple[dict[str, Any], dict[str, Any]]:
    """Plan Run all, run it to the end, and return the plan and final state."""
    with _manager() as manager:
        request = project.request()
        plan = manager.plan(request)["plan"]
        request["approvedPlan"] = {"planId": plan["planId"], "digest": plan["digest"]}
        request["liveExecutionAuthorization"] = {"planDigest": plan["digest"]}
        started = manager.run(request)
        deadline = time.monotonic() + 120
        while manager.active_counts() != (0, 0):
            if time.monotonic() > deadline:
                raise TimeoutError("The synthetic run did not finish in 120 s.")
            time.sleep(0.1)
    state = RunStore(str(project.root)).load(str(started["runId"]))
    return plan, state


def _enigma_receipt(state: dict[str, Any]) -> dict[str, Any]:
    return next(r for r in state["receipts"] if r["stepKey"] == "enigma")


def _enigma_job(state: dict[str, Any]) -> dict[str, Any]:
    return next(j for j in state["jobs"] if j["stepKey"] == "enigma")


def _panel_hashes(project: _Project, subject_id: str) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for gallery, subdir, _name in enigma_module._QC_GALLERIES:
        for panel in enigma_module.gallery_panels(gallery, subject_id):
            for relative in (panel.montage_relative, panel.full_relative):
                data = (project.out_dir / subdir / relative).read_bytes()
                hashes[f"{subdir}/{relative}"] = hashlib.sha256(data).hexdigest()
    return hashes


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> _Project:
    if shutil.which("bash") is None:  # pragma: no cover - present on Linux.
        pytest.skip("Run this test only where Bash can execute the ENIGMA wrapper.")
    real = env.check
    monkeypatch.setattr(
        env,
        "check",
        lambda cfg, ids=None: synth.normalized_environment(real(cfg, ids)),
    )
    return _Project(tmp_path)


def _rendered(project: _Project) -> set[str]:
    return {line.split()[1] for line in project.render_log.read_text().splitlines()}


def test_adding_a_subject_renders_only_that_subject(project: _Project) -> None:
    _plan, first = _run(project)
    receipt = _enigma_receipt(first)
    record = receipt[UNIT_REUSE_KEY]
    subjects = [row[0] for row in synth.SUBJECTS]
    assert _rendered(project) == set(subjects)
    assert {u["reason"] for p in record["units"].values() for u in p.values()} == {
        "no-record"
    }
    reviewed = {sid: _panel_hashes(project, sid) for sid in subjects}

    project.render_log.write_text("")
    project.add_subject(_NEW_SUBJECT)
    plan, second = _run(project)

    forecast = plan["unitReuse"]
    assert [item["stepKey"] for item in forecast] == ["enigma"]
    assert forecast[0]["computedSubjectIds"] == [_NEW_SUBJECT]
    assert forecast[0]["reusedSubjectIds"] == subjects
    assert forecast[0]["sourceRunIds"] == [first["runId"]]
    assert _rendered(project) == {_NEW_SUBJECT}
    job = _enigma_job(second)
    assert job["status"] == "done"
    assert job["unitReuse"] == {
        "computedSubjectIds": [_NEW_SUBJECT],
        "reusedSubjectIds": subjects,
        "sourceRunIds": [first["runId"]],
    }
    log = Path(job["stdoutPath"]).read_text()
    assert (
        "Per-subject reuse: computing 1 subject and reusing the verified output "
        f"of 8 subjects from {first['runId']}." in log
    )
    assert "Reused the verified earlier render for sub-901." in log
    assert not (project.out_dir / ".supraspina-held").exists()
    second_record = _enigma_receipt(second)[UNIT_REUSE_KEY]
    assert second_record["sources"] == {first["runId"]: receipt["recordSha256"]}
    reused = second_record["units"]["sub-901"]["subcortical"]
    assert reused["mode"] == "reused"
    assert reused["renderedRunId"] == first["runId"]
    new = second_record["units"][_NEW_SUBJECT]["external"]
    assert (new["mode"], new["reason"]) == ("computed", "new-subject")
    # A reviewer's verdict on an earlier subject still describes these bytes.
    for sid in subjects:
        assert _panel_hashes(project, sid) == reviewed[sid]
    # The galleries and measures cover the whole cohort, as upstream writes.
    status = ADAPTERS["enigma"].detect({**project.cfg, "_supraspinaRuntime": {}}, None)
    assert status.state == "done"
    assert f"{len(subjects) + 1} subjects" in status.detail
    # Published receipts carry the record and validate.
    store = RunStore(str(project.root))
    published = store.get_receipt(
        "enigma", "cohort", _enigma_receipt(second)["signature"]
    )
    assert published is not None
    assert published[UNIT_REUSE_KEY] == second_record


def test_a_damaged_image_is_rerendered_and_nothing_else(project: _Project) -> None:
    _run(project)
    project.render_log.write_text("")
    damaged = project.out_dir / "qc" / "cortical_external" / "sub-903.rh.med.png"
    damaged.write_bytes(damaged.read_bytes() + b"\0")

    _plan, second = _run(project)

    assert _enigma_job(second)["status"] == "done"
    assert project.render_log.read_text().splitlines() == ["external sub-903"]
    unit = _enigma_receipt(second)[UNIT_REUSE_KEY]["units"]["sub-903"]
    assert unit["external"]["reason"] == "output-changed"
    assert unit["subcortical"]["mode"] == "reused"


def test_reuse_off_renders_every_subject(project: _Project) -> None:
    _run(project)
    project.render_log.write_text("")
    project.add_subject(_NEW_SUBJECT)
    project.cfg["runtime"]["resumeCompleted"] = False
    project.save()

    plan, second = _run(project)

    assert plan["unitReuse"][0]["reusedSubjectIds"] == []
    assert len(_rendered(project)) == len(synth.SUBJECTS) + 1
    record = _enigma_receipt(second)[UNIT_REUSE_KEY]
    reasons = {
        sid: {u["reason"] for u in parts.values()}
        for sid, parts in record["units"].items()
    }
    assert reasons.pop(_NEW_SUBJECT) == {"new-subject"}
    assert set().union(*reasons.values()) == {"reuse-off"}
    assert record["reuseEnabled"] is False


def test_the_forecast_leaves_the_rest_of_the_plan_unchanged(
    project: _Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only ``plan.unitReuse`` is added; nodes, digests and signatures stay."""
    _run(project)
    project.add_subject(_NEW_SUBJECT)
    monkeypatch.setattr(workflow.uuid, "uuid4", lambda: uuid.UUID(int=0xBC))
    with _manager() as manager:
        with_units = manager.plan(project.request())
    monkeypatch.delitem(UNIT_CONTRACTS, "enigma")
    with _manager() as manager:
        without_units = manager.plan(project.request())

    plan = copy.deepcopy(with_units["plan"])
    assert plan.pop("unitReuse")[0]["computedSubjectIds"] == [_NEW_SUBJECT]
    assert "unitReuse" not in without_units["plan"]
    assert plan == without_units["plan"]
    assert plan["digest"] == without_units["plan"]["digest"]


def _record_verdicts(project: _Project, state: dict[str, Any], ids: list[str]) -> None:
    """Record Pass verdicts reviewed on one run's ENIGMA galleries."""
    receipt = _enigma_receipt(state)
    stamp = "2026-10-01T00:00:00.000Z"
    evidence = {
        "evidenceVersion": 1,
        "reviewer": "synthetic reviewer",
        "reviewedAt": stamp,
        "galleries": [
            {
                "tab": tab,
                "label": tab,
                "displayPath": f"qc/{tab}.html",
                "runId": receipt["runId"],
                "receiptSha256": receipt["recordSha256"],
                "openedAt": stamp,
            }
            for tab in ("subcortical", "internal", "external")
        ],
    }
    document = {
        "schemaVersion": 2,
        "verdicts": {
            sid: {
                "verdict": "pass",
                "note": "",
                "tags": [],
                "reviewEvidence": evidence,
                "revision": 1,
                "updatedAt": stamp,
            }
            for sid in ids
        },
    }
    (project.root / ".supraspina" / "qc_verdicts.json").write_text(json.dumps(document))


def test_a_verdict_on_replaced_images_is_flagged_and_others_stay(
    project: _Project,
) -> None:
    from supraspina_sidecar.results import ResultInventory  # noqa: PLC0415

    _plan, first = _run(project)
    _record_verdicts(project, first, ["sub-901", "sub-902"])
    # An input only the external render reads; a new subject reruns the stage.
    pial = (
        project.root / "derivatives" / "freesurfer" / "sub-901" / "surf" / "lh.pial.T1"
    )
    pial.write_text("edited surface\n")
    project.add_subject(_NEW_SUBJECT)
    project.render_log.write_text("")

    _plan, second = _run(project)

    assert sorted(project.render_log.read_text().splitlines()) == sorted(
        [f"{part} {_NEW_SUBJECT}" for part in ("subcortical", "internal", "external")]
        + ["external sub-901"]
    )
    changed = ResultInventory._images_changed_since_verdict
    root = str(project.root)
    assert changed(root, second, "external", "sub-901") == {
        "renderedRunId": second["runId"],
        "reason": "inputs-changed",
    }
    # Reused images keep the verdict: the same bytes the reviewer saw.
    assert changed(root, second, "subcortical", "sub-901") is None
    assert changed(root, second, "external", "sub-902") is None
    # A subject without a verdict has nothing to flag.
    assert changed(root, second, "external", _NEW_SUBJECT) is None
    # A verdict recorded on the new render is current again.
    _record_verdicts(project, second, ["sub-901"])
    assert changed(root, second, "external", "sub-901") is None


def test_a_silently_failed_render_fails_the_stage_and_records_nothing(
    project: _Project,
) -> None:
    """The wrapper exits 0 after a failed child; earlier images must not pass."""
    _plan, first = _run(project)
    store = RunStore(str(project.root))
    published = store.receipt_signatures("enigma", "cohort")
    pial = (
        project.root / "derivatives" / "freesurfer" / "sub-901" / "surf" / "lh.pial.T1"
    )
    pial.write_text("edited surface\n")
    project.add_subject(_NEW_SUBJECT)
    Path(f"{project.render_log}.silent").write_text("sub-901\n")
    before = (
        project.out_dir / "qc" / "cortical_external" / "sub-901.lh.lat.png"
    ).read_bytes()

    _plan, second = _run(project)

    job = _enigma_job(second)
    assert job["status"] == "failed"
    # With the earlier images set aside, the detector finds them missing.
    assert "Restore the missing or invalid gallery image" in str(job["terminalReason"])
    log = Path(job["stdoutPath"]).read_text()
    assert "Set aside the earlier output of 1 computed unit" in log
    assert "Restored 4 earlier output folders or files; each matches" in log
    assert not (project.out_dir / ".supraspina-held").exists() or not any(
        (project.out_dir / ".supraspina-held").iterdir()
    )
    assert not [
        r
        for r in second["receipts"]
        if r["stepKey"] == "enigma" and r["runId"] == second["runId"]
    ]
    assert store.receipt_signatures("enigma", "cohort") == published
    # The earlier images stay in place; nothing was deleted.
    assert (
        project.out_dir / "qc" / "cortical_external" / "sub-901.lh.lat.png"
    ).read_bytes() == before
    assert first["runId"] != second["runId"]


def test_a_failing_forecast_leaves_planning_intact(
    project: _Project, monkeypatch: pytest.MonkeyPatch
) -> None:
    from supraspina_sidecar import unit_reuse  # noqa: PLC0415

    def broken(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("forecast fault")

    monkeypatch.setattr(unit_reuse, "decide", broken)
    with _manager() as manager:
        planned = manager.plan(project.request())

    assert "unitReuse" not in planned["plan"]
    assert any(node["stepKey"] == "enigma" for node in planned["plan"]["nodes"])
