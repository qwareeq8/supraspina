"""Tests for the labeling worker and the atlas-labeling manager (fake tools)."""

from __future__ import annotations

import dataclasses
import hashlib
import io
import json
import os
import struct
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.group_analysis import (
    atlas_cache,
    atlas_manager,
    atlas_recipes,
    atlas_sources,
    atlas_tools,
    atlas_worker,
)
from supraspina_sidecar.group_analysis.atlas_manager import (
    IMPORT_UNAVAILABLE,
    AtlasLabelingManager,
)
from supraspina_sidecar.group_analysis.spec import GroupAnalysisError
from supraspina_sidecar.project import ProjectEpochs
from tests.atlas_labeling_support import (
    BRAINSTEM,
    make_freesurfer,
    make_recon,
    snapshot,
)
from tests.group_analysis_support import make_project, request

_CURRENT = {
    "aggregate": "current",
    "pybrainage": "current",
    "recon": {"state": "current", "outdatedSubjectIds": []},
}


def _ok_runner(
    argv: list[str], environment: Any, timeout: float
) -> tuple[int, str, str]:
    del argv, environment, timeout
    return 0, '{"python": "3.12.10", "numpy": "1.26.4", "scipy": "1.13.1"}', ""


def _probe(home: str | None, python: str | None) -> atlas_tools.ToolReport:
    return atlas_tools.probe_tools(home, python, runner=_ok_runner)


@pytest.fixture
def project(tmp_path: Path) -> dict[str, Any]:
    """Return a project with a fake FreeSurfer and three recon folders."""
    root = tmp_path / "project"
    root.mkdir()
    cfg = make_project(root)
    home = make_freesurfer(tmp_path)
    cfg["tools"] = {"freesurferHome": str(home)}
    for subject in ("sub-01", "sub-02", "sub-03"):
        make_recon(root, subject)
    cache = tmp_path / "machine-atlases"
    return {
        "root": root,
        "cfg": cfg,
        "home": home,
        "machine": {"subregionsPython": sys.executable, "atlasCacheRoot": str(cache)},
    }


def _job(project: dict[str, Any], **extra: Any) -> dict[str, Any]:
    root = project["root"]
    subjects = extra.pop("subjects", ["sub-01"])
    return {
        "schema": atlas_worker.JOB_SCHEMA,
        "schemaVersion": 1,
        "operationId": "alb-0000000000000001",
        "projectRoot": str(root),
        "atlasId": "brainstem-ss",
        "recipeId": "brainstem-ss",
        "subjects": subjects,
        "jobs": 1,
        "freesurferHome": str(project["home"]),
        "subregionsPython": sys.executable,
        "atlasFiles": [],
        "reconStates": dict.fromkeys(subjects, "current"),
        "reconDirs": {
            subject: str(root / "derivatives" / "freesurfer" / subject)
            for subject in subjects
        },
        "environment": {},
        "tool": {"freesurferBuild": "b1", "interpreter": {"python": "3.12.10"}},
        "hemisphereRules": ["none"],
        "template": False,
        **extra,
    }


def _events(stream: io.StringIO) -> list[dict[str, Any]]:
    return [json.loads(line) for line in stream.getvalue().splitlines()]


# -- Worker --------------------------------------------------------------------------


def test_the_worker_labels_brainstem_subfields_in_a_shadow_folder(
    project: dict[str, Any],
) -> None:
    root = project["root"]
    recon = root / "derivatives" / "freesurfer" / "sub-01"
    before = snapshot(recon)
    out = io.StringIO()
    assert atlas_worker.run_job(_job(project), out) == 0
    events = _events(out)
    assert events[0] == {"event": "subject", "subjectId": "sub-01", "state": "running"}
    assert events[1]["state"] == "current"
    assert events[-1] == {"event": "done"}
    assert snapshot(recon) == before
    labels = atlas_cache.read_labels(str(root), "brainstem-ss", "sub-01")
    assert labels is not None
    assert labels["values"]["vol:brainstem-ss:mid:Pons"] == pytest.approx(14000.25)
    assert [row["relpath"] for row in labels["inputs"]] == [
        "mri/norm.mgz",
        "mri/aseg.mgz",
    ]
    assert labels["argv"][0][1:4] == ["-s", "-m", "samseg.cli.segment_subregions"]
    assert labels["reconState"] == "current"
    assert sorted(item["name"] for item in labels["outputs"]) == [
        "brainstemSsLabels.FSvoxelSpace.mgz",
        "brainstemSsLabels.volumes.txt",
    ]
    folder = Path(atlas_cache.subject_dir(str(root), "brainstem-ss", "sub-01"))
    assert (folder / "brainstemSsLabels.volumes.txt").read_text(encoding="utf-8") == (
        BRAINSTEM
    )
    assert not Path(atlas_cache.work_root(str(root)), "alb-0000000000000001").exists()


def test_a_tool_that_writes_into_the_recon_folder_stops_the_labeling(
    project: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_FS_EVIL", "sub-01")
    out = io.StringIO()
    job = _job(project, subjects=["sub-01", "sub-02"])
    assert atlas_worker.run_job(job, out) == 1
    events = _events(out)
    assert {
        "event": "subject",
        "subjectId": "sub-01",
        "state": "failed",
        "message": "The labeling tool changed files in the recon folder; labeling stopped.",
        "seconds": events[1]["seconds"],
    } == events[1]
    assert events[-1] == {
        "event": "failed",
        "message": "The labeling tool changed files in the recon folder; labeling stopped.",
    }
    assert not any(event.get("subjectId") == "sub-02" for event in events)
    assert (
        atlas_cache.read_labels(str(project["root"]), "brainstem-ss", "sub-01") is None
    )


def test_tool_failures_skips_and_outdated_recons_are_reported(
    project: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    root = project["root"]
    running = (
        root / "derivatives" / "freesurfer" / "sub-02" / "scripts" / "IsRunning.lh"
    )
    running.write_text("", encoding="utf-8")
    job = _job(project, subjects=["sub-01", "sub-02", "sub-03"])
    job["reconStates"]["sub-03"] = "outdated"
    out = io.StringIO()
    assert atlas_worker.run_job(job, out) == 0
    ends = {
        e["subjectId"]: e
        for e in _events(out)
        if e.get("state") not in {None, "running"}
    }
    assert ends["sub-02"]["state"] == "skipped"
    assert ends["sub-02"]["message"] == "The reconstruction is running."
    assert ends["sub-03"]["state"] == "provisional"
    monkeypatch.setenv("FAKE_FS_FAIL", "1")
    out = io.StringIO()
    assert atlas_worker.run_job(_job(project), out) == 0
    failed = _events(out)[1]
    assert failed["state"] == "failed"
    assert failed["message"] == "segment_subregions stopped with exit status 3."


def test_the_worker_labels_surface_templates_and_volume_atlases(
    project: dict[str, Any],
) -> None:
    root = project["root"]
    out = io.StringIO()
    yeo = _job(project, atlasId="yeo7", recipeId="yeo7", subregionsPython=None)
    assert atlas_worker.run_job(yeo, out) == 0
    labels = atlas_cache.read_labels(str(root), "yeo7", "sub-01")
    assert labels is not None
    assert labels["values"]["parc:yeo7:rh:7Networks_2:GrayVol"] == 27500.0
    assert not any("Medial_Wall" in key for key in labels["values"])

    out = io.StringIO()
    template = _job(
        project,
        atlasId="dkt",
        recipeId="template-fsaverage5",
        subjects=[],
        template=True,
    )
    assert atlas_worker.run_job(template, out) == 0
    assert _events(out)[0] == {"event": "template", "state": "current", "message": None}
    annot = Path(atlas_cache.template_dir(str(root))) / "lh.dkt.annot"
    assert struct.unpack(">i", annot.read_bytes()[:4]) == (10242,)

    ctab = root / "colortable.txt"
    ctab.write_text(
        "1001 Nucleus_L 1 2 3 0\n1002 Nucleus_R 1 2 3 0\n", encoding="utf-8"
    )
    map_file = root / "map.mgz"
    map_file.write_bytes(b"labels")
    atlas_cache.store_subject(
        str(root),
        "user-0a1b2c3d",
        "sub-01",
        files={"user-0a1b2c3d.mgz": str(map_file)},
        manifest={
            "schema": atlas_recipes.LABELS_SCHEMA,
            "schemaVersion": 1,
            "atlasId": "user-0a1b2c3d",
            "subjectId": "sub-01",
            "recipeId": "user-volume",
            "recipeVersion": 1,
            "provenance": "imported",
            "inputs": [],
            "values": {},
            "mapOnly": True,
        },
    )
    out = io.StringIO()
    volume = _job(
        project,
        atlasId="user-0a1b2c3d",
        recipeId="user-volume",
        subjects=["sub-01", "sub-02"],
        atlasFiles=[str(ctab)],
        hemisphereRules=["l-r-underscore-suffix"],
    )
    assert atlas_worker.run_job(volume, out) == 0
    ends = {
        e["subjectId"]: e
        for e in _events(out)
        if e.get("state") not in {None, "running"}
    }
    assert ends["sub-02"]["message"] == "No label map was imported for this subject."
    labels = atlas_cache.read_labels(str(root), "user-0a1b2c3d", "sub-01")
    assert labels is not None
    assert labels["values"] == {
        "vol:user-0a1b2c3d:lh:Nucleus": 120.5,
        "vol:user-0a1b2c3d:rh:Nucleus": 110.0,
    }
    assert {item["name"] for item in labels["outputs"]} == {
        "user-0a1b2c3d.stats",
        "user-0a1b2c3d.mgz",
        "user-0a1b2c3d.ctab",
    }
    # The viewer reads the atlas's color table beside its label map.
    kept = atlas_cache.subject_dir(str(root), "user-0a1b2c3d", "sub-01")
    with open(os.path.join(kept, "user-0a1b2c3d.ctab"), encoding="utf-8") as f:
        assert f.read() == ctab.read_text(encoding="utf-8")


def test_the_worker_refuses_malformed_jobs(project: dict[str, Any]) -> None:
    for job in (
        {**_job(project), "extra": 1},
        {**_job(project), "jobs": 9},
        {**_job(project), "subjects": ["../x"]},
        {**_job(project), "schemaVersion": 2},
    ):
        out = io.StringIO()
        assert atlas_worker.run_job(job, out) == 1
        assert _events(out) == [
            {"event": "failed", "message": "The labeling job is malformed."}
        ]


def test_the_worker_process_reads_its_job_from_stdin(
    project: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    payload = json.dumps(_job(project)).encode()
    monkeypatch.setattr(
        atlas_worker.sys, "stdin", io.TextIOWrapper(io.BytesIO(payload))
    )
    monkeypatch.setattr(atlas_worker.os, "nice", lambda _n: 0)
    assert atlas_worker.main([]) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events[-1] == {"event": "done"}
    for payload in (b"{", b"{}"):
        monkeypatch.setattr(
            atlas_worker.sys, "stdin", io.TextIOWrapper(io.BytesIO(payload))
        )
        assert atlas_worker.main([]) == 1


# -- Manager -------------------------------------------------------------------------


def _manager() -> AtlasLabelingManager:
    return AtlasLabelingManager(ProjectEpochs(), probe=_probe)


def _call(project: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return request(project["root"], project["cfg"], **extra)


def _wait(
    mgr: AtlasLabelingManager, project: dict[str, Any], atlas_id: str
) -> dict[str, Any]:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        status = mgr.label_status(_call(project, atlasId=atlas_id))
        if (
            status["operation"] is not None
            and status["operation"]["state"] != "running"
        ):
            return status
        time.sleep(0.05)
    raise AssertionError("The labeling did not finish.")


def _start(
    mgr: AtlasLabelingManager, project: dict[str, Any], **fields: Any
) -> dict[str, Any]:
    body = {
        "atlasId": "brainstem-ss",
        "subjects": "missing",
        "jobs": 2,
        "stageCurrency": _CURRENT,
        "machine": project["machine"],
        **fields,
    }
    return mgr.label_start(_call(project, **body))


def test_the_catalog_lists_every_atlas_with_counts_and_tool_facts(
    project: dict[str, Any],
) -> None:
    mgr = _manager()
    catalog = mgr.atlases(
        _call(project, machine=project["machine"], reconOutdatedSubjectIds=[])
    )
    by_id = {entry["atlasId"]: entry for entry in catalog["atlases"]}
    assert list(by_id) == [atlas.atlas_id for atlas in atlas_recipes.BUILT_IN_ATLASES]
    assert by_id["a2009s"]["counts"]["withFiles"] == 3
    assert by_id["a2009s"]["tier"] == "A"
    assert by_id["dkt"]["available"] is False
    assert by_id["dkt"]["unavailableReason"] == (
        "No subject has these FreeSurfer stats files yet."
    )
    brainstem = by_id["brainstem-ss"]
    assert brainstem["tier"] == "B"
    assert brainstem["available"] is True
    assert brainstem["counts"]["total"] == 11
    assert brainstem["estimateSeconds"] == 11 * 720
    assert brainstem["citation"].startswith("Iglesias JE")
    assert {fact["toolId"] for fact in catalog["tools"]} == {
        "freesurfer-home",
        "segment-subregions",
        "subregions-python",
        *atlas_tools.PROGRAMS,
    }
    assert catalog["subregionsPython"] == sys.executable
    assert catalog["revision"] == 0
    no_python = {**project["machine"], "subregionsPython": None}
    catalog = mgr.atlases(_call(project, machine=no_python, reconOutdatedSubjectIds=[]))
    brainstem = next(e for e in catalog["atlases"] if e["atlasId"] == "brainstem-ss")
    assert brainstem["available"] is False
    assert brainstem["unavailableReason"] == (
        "No Python 3.12 environment is chosen for FreeSurfer subregions."
    )
    mri = project["root"] / "derivatives" / "freesurfer" / "sub-01" / "mri"
    (mri / "brainstemSsLabels.v13.volumes.txt").write_text(BRAINSTEM, encoding="utf-8")
    (mri.parent / "scripts" / "IsRunning.lh+rh").write_text("", encoding="utf-8")
    catalog = mgr.atlases(_call(project, machine=no_python, reconOutdatedSubjectIds=[]))
    brainstem = next(e for e in catalog["atlases"] if e["atlasId"] == "brainstem-ss")
    assert brainstem["available"] is True
    assert brainstem["counts"]["withFiles"] == 1
    assert brainstem["counts"]["reconOutdated"] == 1
    catalog = mgr.atlases(
        _call(
            project,
            machine=no_python,
            reconOutdatedSubjectIds=["sub-01", "sub-02", "sub-99"],
        )
    )
    brainstem = next(e for e in catalog["atlases"] if e["atlasId"] == "brainstem-ss")
    # The running sub-01 counts once; sub-99 is outside the registry.
    assert brainstem["counts"]["reconOutdated"] == 2
    with pytest.raises(GroupAnalysisError, match="out-of-date subjects"):
        mgr.atlases(_call(project, machine=no_python, reconOutdatedSubjectIds=["../x"]))


def test_a_labeling_runs_to_the_end_and_its_labels_become_current(
    project: dict[str, Any],
) -> None:
    mgr = _manager()
    started = _start(mgr, project, subjects=["sub-01", "sub-02", "sub-04"])
    assert started["started"] is True
    assert started["operation"]["total"] == 3
    assert started["operation"]["skipped"] == 1
    status = _wait(mgr, project, "brainstem-ss")
    operation = status["operation"]
    assert operation["state"] == "done"
    assert (operation["completed"], operation["failed"], operation["skipped"]) == (
        2,
        0,
        1,
    )
    assert operation["remainingSeconds"] == 0
    rows = {row["subjectId"]: row for row in status["subjects"]}
    assert rows["sub-01"]["state"] == "current"
    assert rows["sub-01"]["provenance"] == "labeled"
    assert rows["sub-04"]["state"] == "skipped"
    assert rows["sub-04"]["message"] == "No reconstruction was found for this subject."
    assert rows["sub-05"]["state"] == "missing"
    root = str(project["root"])
    assert atlas_cache.revision(root) == 2
    catalog = mgr.atlases(
        _call(project, machine=project["machine"], reconOutdatedSubjectIds=[])
    )
    brainstem = next(e for e in catalog["atlases"] if e["atlasId"] == "brainstem-ss")
    assert brainstem["counts"]["labeled"] == 2
    assert catalog["labeling"]["state"] == "done"

    norm = (
        project["root"] / "derivatives" / "freesurfer" / "sub-02" / "mri" / "norm.mgz"
    )
    norm.write_bytes(b"recon ran again")
    status = mgr.label_status(_call(project, atlasId="brainstem-ss"))
    row = next(row for row in status["subjects"] if row["subjectId"] == "sub-02")
    assert (row["state"], row["staleReasons"]) == ("stale", ["recon-changed"])
    again = _start(mgr, project, subjects="stale")
    assert again["operation"]["total"] == 1
    _wait(mgr, project, "brainstem-ss")
    with pytest.raises(GroupAnalysisError, match="No subject has out-of-date labels"):
        _start(mgr, project, subjects="stale")


def _content(root: Path) -> dict[str, tuple[Any, ...]]:
    """Snapshot every entry's existence, and each file's bytes, size and mtime.

    Detector evidence binds ``mtimeNs`` as well as content, so a touch that
    keeps the bytes would still make receipts stale.
    """
    snapshot: dict[str, tuple[Any, ...]] = {}
    for path in sorted(root.rglob("*")):
        info = path.lstat()
        key = path.relative_to(root).as_posix()
        if path.is_symlink():
            snapshot[key] = ("link", os.readlink(path), info.st_mtime_ns)
        elif path.is_dir():
            snapshot[key] = ("dir",)
        else:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            snapshot[key] = ("file", info.st_size, info.st_mtime_ns, digest)
    return snapshot


def test_a_full_labeling_run_changes_files_only_under_the_analysis_store(
    project: dict[str, Any],
) -> None:
    # Receipt safety: labels live in the analysis cache; every recon folder,
    # run, receipt and pipeline output keeps its bytes, size and mtime.
    root = project["root"]
    before = _content(root)
    mgr = _manager()
    _start(mgr, project, subjects=["sub-01", "sub-02", "sub-04"])
    assert _wait(mgr, project, "brainstem-ss")["operation"]["state"] == "done"
    after = _content(root)
    changed = {
        path
        for path in before.keys() | after.keys()
        if before.get(path) != after.get(path)
    }
    assert changed
    assert all(
        path == ".supraspina/analysis" or path.startswith(".supraspina/analysis/")
        for path in changed
    ), sorted(changed)


def test_labeling_starts_are_validated(project: dict[str, Any]) -> None:
    mgr = _manager()
    for fields, message in (
        ({"jobs": 0}, "1 to 8 parallel"),
        ({"jobs": True}, "1 to 8 parallel"),
        ({"subjects": []}, "Name the subjects"),
        ({"subjects": ["sub-01", "sub-01"]}, "Name the subjects"),
        ({"subjects": ["sub-99"]}, "registry"),
        ({"atlasId": "a2009s"}, "needs no labeling"),
        ({"atlasId": "user-0a1b2c3d"}, "Choose an atlas this project lists"),
        ({"stageCurrency": {"aggregate": "x"}}, "stage currency"),
        (
            {"machine": {**project["machine"], "subregionsPython": None}},
            "No Python 3.12 environment",
        ),
    ):
        with pytest.raises(GroupAnalysisError, match=message):
            _start(mgr, project, **fields)
    outdated = {
        **_CURRENT,
        "recon": {"state": "outdated", "outdatedSubjectIds": ["sub-01"]},
    }
    started = _start(mgr, project, subjects=["sub-01"], stageCurrency=outdated)
    assert started["operation"]["skipped"] == 1
    status = _wait(mgr, project, "brainstem-ss")
    row = next(row for row in status["subjects"] if row["subjectId"] == "sub-01")
    assert row["message"] == "The reconstruction is out of date."


def test_template_labels_and_added_atlases_label_through_the_manager(
    project: dict[str, Any],
) -> None:
    mgr = _manager()
    started = _start(mgr, project, atlasId="dkt")
    assert started["operation"]["total"] == 1
    assert _wait(mgr, project, "dkt")["operation"]["completed"] == 1
    assert (
        Path(atlas_cache.template_dir(str(project["root"]))) / "rh.dkt.annot"
    ).exists()
    gcs = []
    for hemi in ("lh", "rh"):
        path = project["root"] / f"{hemi}.Schaefer2018_100Parcels_7Networks.gcs"
        path.write_bytes(b"gcs")
        gcs.append(str(path))
    added = mgr.import_atlas(
        _call(
            project,
            paths=gcs,
            recipeId="user-gcs",
            label="Schaefer 2018, 100 parcels",
            license={"name": "MIT", "url": "https://opensource.org/license/mit"},
            externalSourceId="schaefer2018",
            machine=project["machine"],
        )
    )["atlas"]
    assert added["origin"] == "added"
    assert added["tier"] == "B"
    assert added["license"]["name"] == "MIT"
    assert added["externalSourceId"] == "schaefer2018"
    started = _start(mgr, project, atlasId=added["atlasId"], subjects=["sub-01"])
    assert started["operation"]["total"] == 2
    status = _wait(mgr, project, added["atlasId"])
    assert status["operation"]["completed"] == 2
    row = next(row for row in status["subjects"] if row["subjectId"] == "sub-01")
    assert row["state"] == "current"
    labels = atlas_cache.read_labels(str(project["root"]), added["atlasId"], "sub-01")
    assert labels is not None
    assert f"parc:{added['atlasId']}:lh:7Networks_1:ThickAvg" in labels["values"]
    catalog = mgr.atlases(
        _call(project, machine=project["machine"], reconOutdatedSubjectIds=[])
    )
    assert catalog["atlases"][-1]["atlasId"] == added["atlasId"]


def test_atlas_imports_check_their_files_and_license(
    project: dict[str, Any], tmp_path: Path
) -> None:
    mgr = _manager()

    def add(
        paths: list[str], recipe: str = "user-gcs", **fields: Any
    ) -> dict[str, Any]:
        body = {
            "paths": paths,
            "recipeId": recipe,
            "label": "Atlas",
            "license": {"name": "MIT", "url": None},
            "externalSourceId": None,
            "machine": project["machine"],
            **fields,
        }
        return mgr.import_atlas(_call(project, **body))

    lh, rh = tmp_path / "lh.a.gcs", tmp_path / "rh.a.gcs"
    for path in (lh, rh):
        path.write_bytes(b"gcs")
    annots = []
    for hemi, count in (("lh", 163_842), ("rh", 10_242)):
        path = tmp_path / f"{hemi}.b.annot"
        path.write_bytes(struct.pack(">i", count))
        annots.append(str(path))
    lut = tmp_path / "lut.txt"
    lut.write_text("1 A_L 0 0 0 0\n", encoding="utf-8")
    for paths, recipe, fields, message in (
        ([str(lh)], "user-gcs", {}, "one lh and one rh .gcs"),
        ([str(lh), str(lh)], "user-gcs", {}, "atlas files to add"),
        (["relative.gcs"], "user-gcs", {}, "atlas files to add"),
        ([str(lh), str(tmp_path / "rh.x.gcs")], "user-gcs", {}, "exist"),
        ([str(lh), str(rh)], "brainstem-ss", {}, "how the atlas labels"),
        ([str(lh), str(rh)], "user-gcs", {"label": ""}, "Name the atlas"),
        ([str(lh), str(rh)], "user-gcs", {"license": {"name": "MIT"}}, "license"),
        (
            [str(lh), str(rh)],
            "user-gcs",
            {"license": {"name": "MIT", "url": "http://x"}},
            "license",
        ),
        (
            [str(lh), str(rh)],
            "user-gcs",
            {"externalSourceId": "nope"},
            "listed atlas source",
        ),
        (annots, "user-annot", {}, "on one template"),
        ([str(lh), str(rh)], "user-volume", {}, "color table"),
        ([str(lh)], "user-volume", {}, "malformed"),
        ([str(tmp_path)], "user-gcs", {}, "regular files"),
    ):
        with pytest.raises(GroupAnalysisError, match=message):
            add(paths, recipe, **fields)
    with pytest.raises(GroupAnalysisError, match="atlas folder is not set"):
        add([str(lh), str(rh)], machine={**project["machine"], "atlasCacheRoot": None})
    volume = add([str(lut)], "user-volume")["atlas"]
    assert volume["kind"] == "volume"
    assert volume["namespace"] == "vol"
    manifest_path = next(
        Path(project["machine"]["atlasCacheRoot"]).rglob("manifest.json")
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["schema"] == "supraspina/atlas-source-cache"
    assert manifest["provenance"] == "imported"
    assert manifest["files"][0]["relpath"] == "colortable.txt"
    assert manifest["license"]["acknowledgedAt"]
    assert manifest["atlases"][0]["recipeId"] == "user-volume"


def test_existing_subregion_outputs_import_with_provenance(
    project: dict[str, Any], tmp_path: Path
) -> None:
    mgr = _manager()
    outputs = tmp_path / "validation" / "brainstem"
    (outputs / "sub-01").mkdir(parents=True)
    (outputs / "sub-01" / "brainstemSsLabels.volumes.txt").write_text(
        BRAINSTEM, encoding="utf-8"
    )
    (outputs / "sub-01" / "brainstemSsLabels.FSvoxelSpace.mgz").write_bytes(b"map")
    (outputs / "sub-02" / "mri").mkdir(parents=True)
    (outputs / "sub-02" / "mri" / "brainstemSsVolumes.v12.txt").write_text(
        "Medulla 4000\nPons 14000\n", encoding="utf-8"
    )
    (outputs / "sub-03").mkdir()
    (outputs / "not-a-subject").mkdir()
    machine = project["machine"]
    result = mgr.import_atlas_labels(
        _call(project, path=str(outputs), atlasId="brainstem-ss", machine=machine)
    )
    assert result == {
        "atlasId": "brainstem-ss",
        "imported": 2,
        "unrecognized": ["sub-03"],
    }
    root = str(project["root"])
    labels = atlas_cache.read_labels(root, "brainstem-ss", "sub-02")
    assert labels is not None
    assert labels["provenance"] == "imported"
    assert labels["values"] == {
        "vol:brainstem-ss:mid:Medulla": 4000.0,
        "vol:brainstem-ss:mid:Pons": 14000.0,
    }
    assert [row["relpath"] for row in labels["inputs"]] == [
        "mri/norm.mgz",
        "mri/aseg.mgz",
    ]
    status = mgr.label_status(_call(project, atlasId="brainstem-ss"))
    rows = {row["subjectId"]: row for row in status["subjects"]}
    assert rows["sub-01"]["state"] == "current"
    assert rows["sub-01"]["provenance"] == "imported"
    assert atlas_cache.revision(root) == 1

    def add(paths: list[Path], recipe: str) -> str:
        for path in paths:
            path.write_text("1 A_L 0 0 0 0\n", encoding="utf-8")
        added = mgr.import_atlas(
            _call(
                project,
                paths=[str(path) for path in paths],
                recipeId=recipe,
                label=f"Added {recipe}",
                license={"name": "MIT", "url": None},
                externalSourceId=None,
                machine=machine,
            )
        )
        return str(added["atlas"]["atlasId"])

    volume = add([tmp_path / "lut.txt"], "user-volume")
    surface = add([tmp_path / "lh.s.gcs", tmp_path / "rh.s.gcs"], "user-gcs")
    for body, message in (
        ({"path": "relative", "atlasId": "brainstem-ss"}, "folder of labeling outputs"),
        (
            {"path": str(tmp_path / "absent"), "atlasId": "brainstem-ss"},
            "folder of labeling",
        ),
        ({"path": str(outputs), "atlasId": "yeo7"}, IMPORT_UNAVAILABLE),
        # An added surface atlas has no label maps to import.
        ({"path": str(outputs), "atlasId": surface}, IMPORT_UNAVAILABLE),
        ({"path": str(outputs), "atlasId": "user-0a1b2c3d"}, "atlas this project"),
    ):
        with pytest.raises(GroupAnalysisError, match=message):
            mgr.import_atlas_labels(_call(project, machine=machine, **body))
    maps = tmp_path / "maps"
    (maps / "sub-01").mkdir(parents=True)
    (maps / "sub-01" / "nuclei.mgz").write_bytes(b"map")
    imported = mgr.import_atlas_labels(
        _call(project, path=str(maps), atlasId=volume, machine=machine)
    )
    assert imported["imported"] == 1
    status = mgr.label_status(_call(project, atlasId=volume))
    assert status["subjects"][0]["state"] == "missing"


def test_clearing_labels_names_the_revision(project: dict[str, Any]) -> None:
    mgr = _manager()
    _start(mgr, project, subjects=["sub-01", "sub-02"])
    _wait(mgr, project, "brainstem-ss")
    root = str(project["root"])
    revision = atlas_cache.revision(root)
    with pytest.raises(GroupAnalysisError, match="labels changed"):
        mgr.clear_labels(
            _call(project, atlasId="brainstem-ss", subjects="all", expectedRevision=0)
        )
    for fields, message in (
        ({"subjects": "missing"}, "Name the subjects"),
        ({"expectedRevision": -1}, "cache revision"),
    ):
        body = {
            "atlasId": "brainstem-ss",
            "subjects": "all",
            "expectedRevision": 0,
            **fields,
        }
        with pytest.raises(GroupAnalysisError, match=message):
            mgr.clear_labels(_call(project, **body))
    cleared = mgr.clear_labels(
        _call(
            project,
            atlasId="brainstem-ss",
            subjects=["sub-01"],
            expectedRevision=revision,
        )
    )
    assert cleared == {"revision": revision + 1, "cleared": 1}
    cleared = mgr.clear_labels(
        _call(
            project,
            atlasId="brainstem-ss",
            subjects="all",
            expectedRevision=revision + 1,
        )
    )
    assert cleared == {"revision": revision + 2, "cleared": 1}
    assert mgr.clear_labels(
        _call(
            project,
            atlasId="brainstem-ss",
            subjects="all",
            expectedRevision=revision + 2,
        )
    ) == {"revision": revision + 2, "cleared": 0}


def test_cancel_kills_the_worker_and_keeps_finished_subjects(
    project: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    mgr = _manager()
    _start(mgr, project, subjects=["sub-01"], jobs=1)
    _wait(mgr, project, "brainstem-ss")
    monkeypatch.setenv("FAKE_FS_SLOW", "30")
    started = _start(mgr, project, subjects=["sub-02", "sub-03"], jobs=1)
    operation_id = started["operation"]["operationId"]
    assert _start(mgr, project, subjects=["sub-02"])["started"] is False
    deadline = time.monotonic() + 30
    while (
        mgr.label_status(_call(project, atlasId=None))["operation"]["current"] is None
    ):
        assert time.monotonic() < deadline
        time.sleep(0.05)
    with pytest.raises(GroupAnalysisError, match="Stop the labeling"):
        mgr.clear_labels(
            _call(project, atlasId="brainstem-ss", subjects="all", expectedRevision=0)
        )
    assert mgr.label_cancel(_call(project, operationId=operation_id)) == {
        "operationId": operation_id,
        "stopped": True,
    }
    status = mgr.label_status(_call(project, atlasId="brainstem-ss"))
    assert status["operation"]["state"] == "cancelled"
    rows = {row["subjectId"]: row for row in status["subjects"]}
    assert rows["sub-01"]["state"] == "current"
    assert rows["sub-02"]["state"] == "missing"
    thread = mgr._operation.thread
    assert thread is not None
    thread.join(15)
    assert not thread.is_alive()
    assert os.listdir(atlas_cache.work_root(str(project["root"]))) == []


def test_tool_reports_are_cached_and_a_slow_probe_reads_as_unknown(
    project: dict[str, Any],
) -> None:
    calls: list[str | None] = []

    def slow(home: str | None, python: str | None) -> atlas_tools.ToolReport:
        calls.append(python)
        time.sleep(0.3)
        return _probe(home, python)

    mgr = AtlasLabelingManager(ProjectEpochs(), probe=slow)
    report = mgr.tool_report(str(project["home"]), sys.executable, wait=0.01)
    assert {fact["state"] for fact in report.facts} == {"unknown"}
    assert report.facts[0]["detail"] == "The tool check did not finish in 5 seconds."
    report = mgr.tool_report(str(project["home"]), sys.executable, wait=5)
    assert report.state("subregions-python") == "ok"
    mgr.tool_report(str(project["home"]), sys.executable)
    assert calls == [sys.executable]

    def broken(home: str | None, python: str | None) -> atlas_tools.ToolReport:
        raise RuntimeError(home or python)

    failing = AtlasLabelingManager(ProjectEpochs(), probe=broken)
    report = failing.tool_report(None, None)
    assert report.facts[0]["detail"] == "The tool check stopped on an error."


def test_a_worker_that_cannot_start_or_dies_fails_the_operation(
    project: dict[str, Any],
) -> None:
    def refuse(argv: list[str]) -> Any:
        raise OSError(argv[0])

    mgr = AtlasLabelingManager(ProjectEpochs(), probe=_probe, spawn=refuse)
    _start(mgr, project, subjects=["sub-01"])
    status = _wait(mgr, project, "brainstem-ss")
    assert status["operation"]["message"] == "The labeling worker could not start."

    def silent(argv: list[str]) -> Any:
        del argv
        import subprocess  # noqa: PLC0415

        return subprocess.Popen(
            [sys.executable, "-c", "import sys; sys.stdin.read()"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            start_new_session=True,
        )

    mgr = AtlasLabelingManager(ProjectEpochs(), probe=_probe, spawn=silent)
    _start(mgr, project, subjects=["sub-01"])
    status = _wait(mgr, project, "brainstem-ss")
    assert status["operation"]["message"] == (
        "The labeling worker stopped before it finished. Label again."
    )


def test_status_for_unlabeled_or_tier_a_atlases(project: dict[str, Any]) -> None:
    mgr = _manager()
    assert mgr.label_status(_call(project, atlasId="a2009s"))["subjects"] == []
    assert mgr.label_status(_call(project, atlasId="nothing-here"))["subjects"] == []
    assert mgr.label_status(_call(project, atlasId=None)) == {
        "operation": None,
        "atlasId": None,
        "subjects": [],
    }
    assert isinstance(atlas_manager.machine_tools(project["machine"]), dict)


def test_a_downloaded_source_lists_each_atlas_it_provides(
    project: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    pinned = atlas_sources.SOURCES["schaefer2018"]
    folder = (
        Path(project["machine"]["atlasCacheRoot"]) / "schaefer2018" / pinned.version
    )
    files = []
    for item in pinned.files:
        path = folder / item.relpath
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = struct.pack(">i", 163_842) + item.relpath.encode()
        path.write_bytes(payload)
        files.append(
            dataclasses.replace(
                item, sha256=hashlib.sha256(payload).hexdigest(), bytes=len(payload)
            )
        )
    source = dataclasses.replace(pinned, files=tuple(files))
    monkeypatch.setitem(atlas_sources.SOURCES, "schaefer2018", source)
    manifest = {
        "schema": "supraspina/atlas-source-cache",
        "schemaVersion": 1,
        "sourceId": "schaefer2018",
        "version": pinned.version,
        "provenance": "downloaded",
        "files": [
            {"relpath": f.relpath, "url": f.url, "sha256": f.sha256, "bytes": f.bytes}
            for f in files
        ],
        "license": {
            "name": "MIT",
            "url": "https://github.com/ThomasYeoLab/CBIG/blob/master/LICENSE.md",
            "acknowledgedAt": "2026-09-30T09:30:00.000Z",
        },
        "retrievedAt": "2026-09-30T09:30:00.000Z",
    }
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (
        folder / "fsaverage/label/lh.Schaefer2018_100Parcels_7Networks_order.annot"
    ).write_bytes(b"short")
    mgr = _manager()
    catalog = mgr.atlases(
        _call(project, machine=project["machine"], reconOutdatedSubjectIds=[])
    )
    added = [entry for entry in catalog["atlases"] if entry["origin"] == "added"]
    assert [entry["atlasId"] for entry in added] == [
        "schaefer100-17",
        "schaefer200-7",
        "schaefer200-17",
        "schaefer400-7",
        "schaefer400-17",
    ]
    assert added[-1]["label"] == "Schaefer 2018, 400 parcels, 17 networks"
    assert added[0]["citation"].startswith("Schaefer A")
    assert added[0]["license"]["acknowledgedAt"] == "2026-09-30T09:30:00.000Z"
    assert added[0]["externalSourceId"] == "schaefer2018"
    started = _start(mgr, project, atlasId="schaefer400-17", subjects=["sub-01"])
    assert started["operation"]["total"] == 2
    status = _wait(mgr, project, "schaefer400-17")
    assert status["operation"]["completed"] == 2
    template = Path(atlas_cache.template_dir(str(project["root"])))
    assert (template / "lh.schaefer400-17.annot").exists()
    rows = {row["subjectId"]: row for row in status["subjects"]}
    assert rows["sub-01"]["state"] == "current"
    (
        folder / "fsaverage/label/rh.Schaefer2018_400Parcels_7Networks_order.annot"
    ).write_bytes(struct.pack(">i", 163_842) + b"x" * (files[-3].bytes - 4))
    with pytest.raises(GroupAnalysisError, match="files changed; download them again"):
        _start(mgr, project, atlasId="schaefer400-7", subjects=["sub-01"])


def test_an_atlas_import_that_cannot_read_its_manifest_back_is_refused(
    project: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lut = tmp_path / "lut.txt"
    lut.write_text("1 A_L 0 0 0 0\n", encoding="utf-8")
    monkeypatch.setattr(atlas_manager, "_manifest_atlases", lambda *_args: [])
    with pytest.raises(GroupAnalysisError) as raised:
        _manager().import_atlas(
            _call(
                project,
                paths=[str(lut)],
                recipeId="user-volume",
                label="Atlas",
                license={"name": "MIT", "url": None},
                externalSourceId=None,
                machine=project["machine"],
            )
        )
    assert type(raised.value) is GroupAnalysisError
    assert str(raised.value) == "The atlas files could not be copied."
