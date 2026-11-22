"""Tests for the atlas recipes, output parsers, tool facts, and label cache."""

from __future__ import annotations

import json
import os
import re
import struct
import subprocess
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.group_analysis import atlas_cache, atlas_recipes, atlas_tools
from supraspina_sidecar.group_analysis.atlas_manager import IMPORTABLE_RECIPES
from supraspina_sidecar.group_analysis.spec import parse_measure_id
from tests.atlas_labeling_support import BRAINSTEM, make_freesurfer, make_recon

_ROOT = Path(__file__).resolve().parents[2]
_TS = (_ROOT / "src" / "shared" / "atlas-labeling.ts").read_text(encoding="utf-8")


# -- Recipes -------------------------------------------------------------------------


def _ts_array(block: str, key: str) -> list[str]:
    match = re.search(rf"{key}: (\[.*?\]|SURFACE_INPUTS)", block, re.DOTALL)
    assert match is not None
    text = match.group(1)
    if text == "SURFACE_INPUTS" or "...SURFACE_INPUTS" in text:
        shared = re.search(r"const SURFACE_INPUTS = \[(.*?)\]", _TS, re.DOTALL)
        assert shared is not None
        head = re.findall(r"'([^']+)'", shared.group(1))
        return head + re.findall(r"'([^']+)'", text.replace("...SURFACE_INPUTS", ""))
    return re.findall(r"'([^']+)'", text)


def test_recipes_mirror_the_typescript_inputs_outputs_and_estimates() -> None:
    for recipe in atlas_recipes.RECIPES.values():
        start = _TS.index(f"recipeId: '{recipe.recipe_id}',")
        block = _TS[start : _TS.index("},", start)]
        assert _ts_array(block, "inputs") == list(recipe.inputs)
        assert _ts_array(block, "outputs") == list(recipe.outputs)
        assert _ts_array(block, "tools") == list(recipe.tools)
        estimate = re.search(r"estimateSeconds: (\d+)", block)
        assert estimate is not None
        assert int(estimate.group(1)) == recipe.estimate_seconds
        assert f"kind: '{recipe.kind}'" in block


def test_built_in_atlases_mirror_the_typescript_list() -> None:
    ts_ids = re.findall(r"atlas\(\n\s+'([a-z0-9-]+)',", _TS)
    assert [atlas.atlas_id for atlas in atlas_recipes.BUILT_IN_ATLASES] == ts_ids
    for atlas in atlas_recipes.BUILT_IN_ATLASES:
        start = _TS.index(f"atlas(\n    '{atlas.atlas_id}',")
        block = _TS[start : _TS.index("  ),", start)]
        assert f"'{atlas.label}'" in block
        recipe = f"'{atlas.recipe_id}'" if atlas.recipe_id else "null"
        assert recipe in block


def test_importable_recipes_mirror_the_typescript_set() -> None:
    match = re.search(
        r"IMPORTABLE_RECIPES: ReadonlySet<AtlasRecipeId> = new Set\(\[(.*?)\]\)",
        _TS,
        re.DOTALL,
    )
    assert match is not None
    assert set(re.findall(r"'([^']+)'", match.group(1))) == IMPORTABLE_RECIPES


def test_subregion_commands_run_samseg_under_the_chosen_python() -> None:
    steps = atlas_recipes.recipe_command(
        "brainstem-ss",
        atlas_id="brainstem-ss",
        subject_id="sub-101",
        shadow_subjects_dir="/w/sd",
        out_dir="/w/out",
        freesurfer_home="/fs",
        subregions_python="/py/bin/python",
    )
    assert steps == [
        [
            "/py/bin/python",
            "-s",
            "-m",
            "samseg.cli.segment_subregions",
            "brainstem",
            "--cross",
            "sub-101",
            "--sd",
            "/w/sd",
            "--out-dir",
            "/w/out",
            "--temp-dir",
            "/w/out/work",
            "--threads",
            "1",
        ]
    ]
    thalamic = atlas_recipes.recipe_command(
        "thalamic",
        atlas_id="thalamic",
        subject_id="s",
        shadow_subjects_dir="/w/sd",
        out_dir="/w/out",
        freesurfer_home="/fs",
        subregions_python="/py",
    )
    assert thalamic[0][4] == "thalamus"
    with pytest.raises(ValueError, match=r"Python 3\.12"):
        atlas_recipes.recipe_command(
            "hippo-amygdala",
            atlas_id="hippo-amygdala",
            subject_id="s",
            shadow_subjects_dir="/w/sd",
            out_dir="/w/out",
            freesurfer_home="/fs",
            subregions_python=None,
        )


def test_surface_commands_map_or_classify_then_measure(tmp_path: Path) -> None:
    common = {
        "subject_id": "sub-1",
        "shadow_subjects_dir": "/w/sd",
        "out_dir": "/w/out",
        "freesurfer_home": "/fs",
        "subregions_python": None,
    }
    yeo = atlas_recipes.recipe_command("yeo7", atlas_id="yeo7", **common)
    assert [step[0] for step in yeo] == [
        "mri_surf2surf",
        "mris_anatomical_stats",
    ] * 2
    assert "/fs/subjects/fsaverage/label/lh.Yeo2011_7Networks_N1000.annot" in yeo[0]
    assert yeo[1][:3] == ["mris_anatomical_stats", "-noglobal", "-no-th3"]
    assert yeo[1][-3:] == ["sub-1", "lh", "white"]
    gcs = atlas_recipes.recipe_command(
        "user-gcs",
        atlas_id="user-0a1b2c3d",
        atlas_files=("/c/lh.s.gcs", "/c/rh.s.gcs"),
        **common,
    )
    assert gcs[0][0] == "mris_ca_label"
    assert "/c/lh.s.gcs" in gcs[0]
    assert "/w/sd/sub-1/mri/aseg.presurf.mgz" in gcs[0]
    assert gcs[2][-1] == "/w/out/rh.user-0a1b2c3d.annot"
    with pytest.raises(ValueError, match=r"no rh \.gcs"):
        atlas_recipes.recipe_command(
            "user-gcs", atlas_id="user-0a1b2c3d", atlas_files=("/c/lh.s.gcs",), **common
        )
    for hemi in ("lh", "rh"):
        (tmp_path / f"{hemi}.a.annot").write_bytes(struct.pack(">i", 40_962))
    annot = atlas_recipes.recipe_command(
        "user-annot",
        atlas_id="user-0a1b2c3d",
        atlas_files=(str(tmp_path / "lh.a.annot"), str(tmp_path / "rh.a.annot")),
        **common,
    )
    assert annot[0][2] == "fsaverage6"
    template = atlas_recipes.recipe_command(
        "template-fsaverage5", atlas_id="dkt", **common
    )
    assert template[0][5:9] == [
        "fsaverage5",
        "lh",
        "sphere.reg",
        "/fs/average/lh.DKTaparc.atlas.acfb40.noaparc.i12.2016-08-02.gcs",
    ]
    mapped = atlas_recipes.recipe_command(
        "template-fsaverage5",
        atlas_id="user-0a1b2c3d",
        atlas_files=(str(tmp_path / "lh.a.annot"), str(tmp_path / "rh.a.annot")),
        **common,
    )
    assert mapped[1][:5] == [
        "mri_surf2surf",
        "--srcsubject",
        "fsaverage6",
        "--trgsubject",
        "fsaverage5",
    ]
    segstats = atlas_recipes.recipe_command(
        "user-volume",
        atlas_id="user-0a1b2c3d",
        atlas_files=("/c/colortable.txt", "/w/out/user-0a1b2c3d.mgz"),
        **common,
    )
    assert segstats[0][:5] == [
        "mri_segstats",
        "--seg",
        "/w/out/user-0a1b2c3d.mgz",
        "--ctab",
        "/c/colortable.txt",
    ]
    with pytest.raises(ValueError, match="color table and a label map"):
        atlas_recipes.recipe_command(
            "user-volume", atlas_id="user-0a1b2c3d", atlas_files=(), **common
        )
    with pytest.raises(ValueError, match="known labeling recipe"):
        atlas_recipes.recipe_command("nope", atlas_id="x1", **common)


def test_annotation_templates_follow_the_vertex_count(tmp_path: Path) -> None:
    path = tmp_path / "lh.x.annot"
    for count, template in atlas_recipes.TEMPLATE_VERTICES.items():
        path.write_bytes(struct.pack(">i", count) + b"rest")
        assert atlas_recipes.annot_template(str(path)) == template
    path.write_bytes(struct.pack(">i", 5))
    with pytest.raises(ValueError, match="not on fsaverage"):
        atlas_recipes.annot_template(str(path))
    path.write_bytes(b"x")
    with pytest.raises(ValueError, match="not a FreeSurfer annotation"):
        atlas_recipes.annot_template(str(path))
    with pytest.raises(ValueError, match="cannot be read"):
        atlas_recipes.annot_vertices(str(tmp_path / "missing.annot"))


# -- Parsers -------------------------------------------------------------------------


def _write(folder: Path, name: str, text: str) -> None:
    (folder / name).write_text(text, encoding="utf-8")


def test_subregion_volumes_become_vol_measures(tmp_path: Path) -> None:
    _write(tmp_path, "brainstemSsLabels.volumes.txt", BRAINSTEM)
    values = atlas_recipes.parse_outputs(
        "brainstem-ss", "brainstem-ss", str(tmp_path), ("none",)
    )
    assert values["vol:brainstem-ss:mid:Medulla"] == pytest.approx(4500.5)
    assert values["vol:brainstem-ss:mid:Whole_brainstem"] == pytest.approx(24491.625)
    assert all(parse_measure_id(key) is not None for key in values)
    _write(tmp_path, "ThalamicNuclei.volumes.txt", "Left-LGN 245.1\nRight-LGN 224\n")
    thalamic = atlas_recipes.parse_outputs(
        "thalamic", "thalamic", str(tmp_path), ("left-right-prefix",)
    )
    assert thalamic == {"vol:thalamic:lh:LGN": 245.1, "vol:thalamic:rh:LGN": 224.0}
    for hemi in ("lh", "rh"):
        _write(tmp_path, f"{hemi}.hippoSfVolumes.txt", "HP-tail 500\n")
        _write(tmp_path, f"{hemi}.amygNucVolumes.txt", "Whole_amygdala 1700\n")
    hippo = atlas_recipes.parse_outputs(
        "hippo-amygdala", "hippo-amygdala", str(tmp_path), ("none",)
    )
    assert hippo["vol:hippo-amygdala:rh:HP-tail"] == 500.0
    assert len(hippo) == 4


def test_surface_and_segstats_tables_become_measures(tmp_path: Path) -> None:
    table = (
        "# ColHeaders StructName NumVert SurfArea GrayVol ThickAvg ThickStd "
        "MeanCurv GausCurv FoldInd CurvInd\n"
        "FreeSurfer_Defined_Medial_Wall 1 1 1 1 1 1 1 1 1\n"
        "7Networks_LH_Vis_1 2 3 4 2.5 0.5 0.1 0.02 3 4\n"
    )
    for hemi in ("lh", "rh"):
        _write(tmp_path, f"{hemi}.user-0a1b2c3d.stats", table)
    values = atlas_recipes.parse_outputs(
        "user-gcs", "user-0a1b2c3d", str(tmp_path), ("lh-rh-underscore-infix",)
    )
    assert values["parc:user-0a1b2c3d:lh:7Networks_Vis_1:ThickAvg"] == 2.5
    assert "parc:user-0a1b2c3d:rh:7Networks_LH_Vis_1:ThickAvg" in values
    assert len(values) == 18
    _write(
        tmp_path,
        "user-0a1b2c3d.stats",
        "# ColHeaders Index SegId NVoxels Volume_mm3 StructName\n"
        "1 1 10 120.5 Nucleus_L\n2 2 11 110 Nucleus_R\n3 3 5 50 Raphe(dorsal)\n",
    )
    volumes = atlas_recipes.parse_outputs(
        "user-volume", "user-0a1b2c3d", str(tmp_path), ("l-r-underscore-suffix",)
    )
    assert volumes == {
        "vol:user-0a1b2c3d:lh:Nucleus": 120.5,
        "vol:user-0a1b2c3d:rh:Nucleus": 110.0,
        "vol:user-0a1b2c3d:mid:Raphe_dorsal_": 50.0,
    }
    assert atlas_recipes.parse_outputs("template-fsaverage5", "dkt", "/x", ()) == {}


@pytest.mark.parametrize(
    ("name", "text", "message"),
    [
        ("brainstemSsLabels.volumes.txt", "", "empty"),
        ("brainstemSsLabels.volumes.txt", "Medulla abc\n", "malformed"),
        ("brainstemSsLabels.volumes.txt", "Medulla 1e999\n", "not finite"),
        ("brainstemSsLabels.volumes.txt", "Unknown 5\n", "no usable values"),
    ],
)
def test_malformed_outputs_are_refused(
    tmp_path: Path, name: str, text: str, message: str
) -> None:
    _write(tmp_path, name, text)
    with pytest.raises(ValueError, match=message):
        atlas_recipes.parse_outputs(
            "brainstem-ss", "brainstem-ss", str(tmp_path), ("none",)
        )


def test_parser_edges(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="cannot be read"):
        atlas_recipes.read_volumes_txt(str(tmp_path / "absent.txt"))
    (tmp_path / "bin.txt").write_bytes(b"\xff\xfe")
    with pytest.raises(ValueError, match="not text"):
        atlas_recipes.read_volumes_txt(str(tmp_path / "bin.txt"))
    _write(tmp_path, "a.stats", "1 2 3\n")
    with pytest.raises(ValueError, match="no column headers"):
        atlas_recipes.read_stats_table(str(tmp_path / "a.stats"))
    _write(tmp_path, "b.stats", "# comment only\n")
    with pytest.raises(ValueError, match="no column headers"):
        atlas_recipes.read_stats_table(str(tmp_path / "b.stats"))
    _write(tmp_path, "c.stats", "# ColHeaders StructName Volume_mm3\nA 1 2\n")
    with pytest.raises(ValueError, match="row is malformed"):
        atlas_recipes.read_stats_table(str(tmp_path / "c.stats"))
    _write(tmp_path, "d.stats", "# ColHeaders StructName Volume_mm3 Note\nA 1 x\n")
    assert atlas_recipes.read_stats_table(str(tmp_path / "d.stats")) == {
        "A": {"Volume_mm3": 1.0}
    }
    _write(tmp_path, "lut.txt", "# LUT\n0 Unknown 0 0 0 0\n173 Midbrain 1 2 3 0\n")
    assert atlas_recipes.read_color_table(str(tmp_path / "lut.txt")) == {
        0: "Unknown",
        173: "Midbrain",
    }
    for text, message in (("# none\n", "empty"), ("x y\n", "malformed")):
        _write(tmp_path, "bad.txt", text)
        with pytest.raises(ValueError, match=message):
            atlas_recipes.read_color_table(str(tmp_path / "bad.txt"))
    assert atlas_recipes.region_name("Medial_Wall") is None
    assert atlas_recipes.region_name("a/b c") == "a_b_c"
    assert atlas_recipes.region_name("x" * 80) == "x" * 64
    with pytest.raises(ValueError, match="valid atlas ID"):
        atlas_recipes.parse_outputs("yeo7", "Bad", str(tmp_path), ())
    with pytest.raises(ValueError, match="known labeling recipe"):
        atlas_recipes.parse_outputs("nope", "yeo7", str(tmp_path), ())


# -- Tool facts ----------------------------------------------------------------------


def _runner(status: int, out: str, err: str = "") -> atlas_tools.Runner:
    calls: list[list[str]] = []

    def run(argv: list[str], environment: Any, timeout: float) -> tuple[int, str, str]:
        calls.append(argv)
        assert environment["PYTHONPATH"]
        assert os.path.islink(os.path.join(environment["PYTHONPATH"], "samseg"))
        assert timeout == atlas_tools.PROBE_SECONDS
        return status, out, err

    run.calls = calls  # type: ignore[attr-defined]
    return run


def _python(tmp_path: Path) -> str:
    path = tmp_path / "py312" / "bin" / "python"
    path.parent.mkdir(parents=True)
    path.write_text("#!/bin/sh\n", encoding="utf-8")
    path.chmod(0o755)
    return str(path)


def test_freesurfer_8_2_reports_its_broken_subregions_runtime(tmp_path: Path) -> None:
    home = make_freesurfer(tmp_path)
    facts = atlas_tools.freesurfer_facts(str(home))
    assert (facts.version, facts.fspython_version, facts.bindings_version) == (
        "8.2.0",
        "3.8",
        "3.12",
    )
    assert not facts.own_runtime
    python = _python(tmp_path)
    runner = _runner(
        0, 'noise\n{"python": "3.12.10", "numpy": "1.26.4", "scipy": "1.13.1"}\n'
    )
    report = atlas_tools.probe_tools(str(home), python, runner=runner)
    by_tool = {fact["toolId"]: fact for fact in report.facts}
    assert by_tool["segment-subregions"] == {
        "toolId": "segment-subregions",
        "state": "broken",
        "detail": "FreeSurfer 8.2.0 segment_subregions cannot start: fspython 3.8 "
        "cannot load samseg's Python 3.12 bindings.",
        "fix": "choose-subregions-python",
    }
    assert by_tool["subregions-python"]["state"] == "ok"
    assert by_tool["freesurfer-home"]["detail"].startswith("FreeSurfer 8.2.0 (")
    assert all(by_tool[tool]["state"] == "ok" for tool in atlas_tools.PROGRAMS)
    assert report.identity() == {
        "freesurferBuild": report.build,
        "interpreter": {
            "path": os.path.realpath(python),
            "python": "3.12.10",
            "numpy": "1.26.4",
            "scipy": "1.13.1",
        },
    }
    assert runner.calls[0][:2] == [python, "-s"]  # type: ignore[attr-defined]
    assert (
        atlas_tools.recipe_ready(report, atlas_recipes.RECIPES["brainstem-ss"].tools)
        is None
    )
    assert atlas_tools.subregions_interpreter(report, python) == python


def test_probe_facts_for_missing_or_broken_tools(tmp_path: Path) -> None:
    report = atlas_tools.probe_tools(None, None)
    by_tool = {fact["toolId"]: fact for fact in report.facts}
    assert by_tool["freesurfer-home"]["fix"] == "set-freesurfer-home"
    assert by_tool["subregions-python"]["fix"] == "choose-subregions-python"
    assert by_tool["segment-subregions"]["state"] == "missing"
    assert atlas_tools.recipe_ready(report, ("freesurfer-home",)) == (
        "FreeSurfer is not set for this project."
    )
    assert (
        atlas_tools.recipe_ready(report, ("nope",))
        == "A labeling tool is not available."
    )
    home = make_freesurfer(tmp_path)
    missing = atlas_tools.probe_tools(str(home), str(tmp_path / "nope"))
    assert missing.state("subregions-python") == "missing"
    python = _python(tmp_path)
    broken = atlas_tools.probe_tools(
        str(home), python, runner=_runner(1, "", "Traceback\nImportError: numpy\n")
    )
    fact = next(item for item in broken.facts if item["toolId"] == "subregions-python")
    assert fact["state"] == "broken"
    assert fact["detail"] == (
        "The chosen Python cannot load FreeSurfer's samseg: ImportError: numpy."
    )

    def slow(argv: list[str], environment: Any, timeout: float) -> tuple[int, str, str]:
        raise subprocess.TimeoutExpired(argv, timeout)

    timed = atlas_tools.probe_tools(str(home), python, runner=slow)
    assert timed.state("subregions-python") == "unknown"
    (home / "build-stamp.txt").unlink()
    (home / "bin" / "mri_segstats").unlink()
    stampless = atlas_tools.probe_tools(str(home), None)
    assert stampless.state("freesurfer-home") == "broken"
    assert stampless.state("mri-segstats") == "missing"


def test_a_freesurfer_that_can_load_samseg_uses_fspython(tmp_path: Path) -> None:
    home = make_freesurfer(tmp_path, own_runtime=True)
    runner = _runner(0, '{"python": "3.8.20", "numpy": "1.24.0"}')
    report = atlas_tools.probe_tools(str(home), None, runner=runner)
    assert report.state("segment-subregions") == "ok"
    assert report.state("subregions-python") == "ok"
    assert atlas_tools.subregions_interpreter(report, None) == str(
        home / "bin" / "fspython"
    )
    shutil_samseg = home / "python" / "lib" / "python3.8" / "site-packages" / "samseg"
    for path in sorted(shutil_samseg.rglob("*"), reverse=True):
        path.unlink() if path.is_file() else path.rmdir()
    shutil_samseg.rmdir()
    bare = atlas_tools.probe_tools(str(home), _python(tmp_path))
    assert bare.state("segment-subregions") == "missing"
    assert bare.state("subregions-python") == "unknown"


def test_the_real_probe_runner_captures_output() -> None:
    status, out, _err = atlas_tools.run_probe(
        ["/bin/sh", "-c", "echo hi"], {"PATH": "/usr/bin:/bin"}, 5
    )
    assert (status, out) == (0, "hi\n")


# -- Cache ---------------------------------------------------------------------------


def _manifest(subject: str, **extra: Any) -> dict[str, Any]:
    return {
        "schema": atlas_recipes.LABELS_SCHEMA,
        "schemaVersion": 1,
        "atlasId": "brainstem-ss",
        "subjectId": subject,
        "recipeId": "brainstem-ss",
        "recipeVersion": 1,
        "provenance": "labeled",
        "tool": {"freesurferBuild": "b1", "interpreter": {"python": "3.12.10"}},
        "inputs": [],
        "reconState": "current",
        "values": {"vol:brainstem-ss:mid:Medulla": 4400.0},
        "finishedAt": "2026-09-30T09:30:00.000Z",
        "seconds": 12.5,
        **extra,
    }


def test_the_cache_stores_judges_and_digests_labels(tmp_path: Path) -> None:
    recon = make_recon(tmp_path, "sub-01")
    inputs = atlas_cache.input_facts(str(recon), ["mri/norm.mgz", "mri/aseg.mgz"])
    output = tmp_path / "brainstemSsLabels.volumes.txt"
    output.write_text(BRAINSTEM, encoding="utf-8")
    root = str(tmp_path)
    written = atlas_cache.store_subject(
        root,
        "brainstem-ss",
        "sub-01",
        files={"brainstemSsLabels.volumes.txt": str(output)},
        manifest=_manifest("sub-01", inputs=inputs),
    )
    assert written["outputs"][0]["name"] == "brainstemSsLabels.volumes.txt"
    manifest = atlas_cache.read_labels(root, "brainstem-ss", "sub-01")
    assert manifest is not None
    tool = {"freesurferBuild": "b1", "interpreter": {"python": "3.12.10"}}
    assert atlas_cache.judge(manifest, recon=str(recon), tool=tool) == ("current", [])
    assert atlas_cache.judge(manifest, recon=str(recon), tool=None) == ("current", [])
    newer = {"freesurferBuild": "b2", "interpreter": {"python": "3.12.10"}}
    assert atlas_cache.judge(manifest, recon=str(recon), tool=newer) == (
        "stale",
        ["tool-changed"],
    )
    python = {"freesurferBuild": "b1", "interpreter": {"python": "3.12.11"}}
    assert atlas_cache.judge(manifest, recon=str(recon), tool=python)[1] == [
        "tool-changed"
    ]
    assert atlas_cache.judge(
        {**manifest, "recipeVersion": 0}, recon=str(recon), tool=tool
    )[1] == ["recipe-changed"]
    assert atlas_cache.judge(
        {**manifest, "reconState": "outdated"}, recon=str(recon), tool=tool
    ) == (
        "provisional",
        [],
    )
    os.utime(recon / "mri" / "norm.mgz", ns=(1, 1))
    assert atlas_cache.judge(manifest, recon=str(recon), tool=tool) == ("current", [])
    (recon / "mri" / "norm.mgz").write_bytes(b"new recon")
    assert atlas_cache.judge(manifest, recon=str(recon), tool=tool)[1] == [
        "recon-changed"
    ]
    assert atlas_cache.judge(manifest, recon=None, tool=tool)[1] == ["recon-changed"]

    values, digest = atlas_cache.label_values(
        root, "brainstem-ss", ["sub-01", "sub-02"]
    )
    assert values == {"sub-01": {"vol:brainstem-ss:mid:Medulla": 4400.0}}
    atlas_cache.store_subject(
        root,
        "brainstem-ss",
        "sub-01",
        files={},
        manifest=_manifest("sub-01", values={"vol:brainstem-ss:mid:Medulla": 1.0}),
    )
    assert (
        atlas_cache.label_values(root, "brainstem-ss", ["sub-01", "sub-02"])[1]
        != digest
    )
    assert atlas_cache.labeled_subjects(root, "brainstem-ss") == ["sub-01"]
    assert atlas_cache.revision(root) == 0
    assert atlas_cache.bump_revision(root) == 1
    assert atlas_cache.bump_revision(root) == 2
    assert atlas_cache.remove_subjects(root, "brainstem-ss", ["sub-01", "sub-09"]) == 1
    assert atlas_cache.read_labels(root, "brainstem-ss", "sub-01") is None


def test_invalid_manifests_read_as_absent(tmp_path: Path) -> None:
    root = str(tmp_path)
    folder = Path(atlas_cache.subject_dir(root, "brainstem-ss", "sub-01"))
    folder.mkdir(parents=True)
    for value in (
        [],
        _manifest("sub-02"),
        _manifest("sub-01", values={"x": True}),
        _manifest("sub-01", schemaVersion=2),
    ):
        (folder / "labels.json").write_text(json.dumps(value), encoding="utf-8")
        assert atlas_cache.read_labels(root, "brainstem-ss", "sub-01") is None
    (folder / "labels.json").write_text("{", encoding="utf-8")
    values, _digest = atlas_cache.label_values(root, "brainstem-ss", ["sub-01"])
    assert values == {}
    with pytest.raises(atlas_cache.CacheError, match="valid atlas ID"):
        atlas_cache.atlas_dir(root, "templates")
    with pytest.raises(atlas_cache.CacheError, match="valid subject IDs"):
        atlas_cache.subject_dir(root, "brainstem-ss", "../x")


def test_the_cache_refuses_symlinked_folders_and_escaping_inputs(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    (root / ".supraspina" / "analysis").mkdir(parents=True)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (root / ".supraspina" / "analysis" / "atlases").symlink_to(elsewhere)
    with pytest.raises(atlas_cache.CacheError, match="not a folder"):
        atlas_cache.ensure_dir(atlas_cache.atlas_dir(str(root), "yeo7"), str(root))
    with pytest.raises(atlas_cache.CacheError, match="inside the project"):
        atlas_cache.ensure_dir(str(tmp_path / "x"), str(root))
    recon = make_recon(tmp_path, "sub-01")
    (recon / "mri" / "norm.mgz").unlink()
    (recon / "mri" / "norm.mgz").symlink_to(elsewhere / "norm.mgz")
    with pytest.raises(atlas_cache.CacheError, match="outside the recon folder"):
        atlas_cache.confined_input(str(recon), "mri/norm.mgz")
    with pytest.raises(atlas_cache.CacheError, match="is missing"):
        atlas_cache.confined_input(str(recon), "mri/absent.mgz")
    with pytest.raises(atlas_cache.CacheError, match="not a file"):
        atlas_cache.confined_input(str(recon), "mri")


def test_tripwire_sees_any_change_in_the_recon_folder(tmp_path: Path) -> None:
    recon = make_recon(tmp_path, "sub-01")
    before = atlas_cache.tripwire(str(recon))
    assert atlas_cache.tripwire(str(recon)) == before
    (recon / "mri" / "new.mgz").write_bytes(b"x")
    assert atlas_cache.tripwire(str(recon)) != before
    (recon / "mri" / "new.mgz").unlink()
    # A file made and removed still leaves the folder's mtime changed.
    assert atlas_cache.tripwire(str(recon)) != before
    before = atlas_cache.tripwire(str(recon))
    os.utime(recon / "mri" / "aseg.mgz", ns=(5, 5))
    assert atlas_cache.tripwire(str(recon)) != before
    with pytest.raises(atlas_cache.CacheError, match="cannot be read"):
        atlas_cache.tripwire(str(tmp_path / "absent"))


def test_recon_folders_running_markers_and_sweeps(tmp_path: Path) -> None:
    cfg: dict[str, Any] = {"paths": {"derivativesDir": str(tmp_path / "derivatives")}}
    recon = make_recon(tmp_path, "sub-01")
    assert atlas_cache.recon_folder(cfg, "sub-01") == str(recon)
    assert atlas_cache.recon_folder(cfg, "sub-02") is None
    assert atlas_cache.recon_folder(cfg, "../x") is None
    assert (
        atlas_cache.recon_folder({"paths": {"derivativesDir": "rel"}}, "sub-01") is None
    )
    auto = {**cfg, "steps": {"recon": {"params": {"backend": "auto"}}}}
    assert [os.path.basename(path) for path in atlas_cache.recon_parents(auto)] == [
        "freesurfer",
        "fastsurfer",
    ]
    fast = {**cfg, "steps": {"recon": {"params": {"backend": "fastsurfer"}}}}
    assert atlas_cache.recon_folder(fast, "sub-01") is None
    assert not atlas_cache.recon_running(str(recon))
    (recon / "scripts" / "IsRunning.lh+rh").write_text("", encoding="utf-8")
    assert atlas_cache.recon_running(str(recon))
    assert not atlas_cache.recon_running(str(tmp_path / "absent"))
    root = str(tmp_path)
    work = Path(atlas_cache.work_root(root))
    (work / "alb-0000000000000001" / "sd").mkdir(parents=True)
    (work / "keep").mkdir()
    stage = Path(atlas_cache.atlas_dir(root, "yeo7")) / ".stage-abc"
    stage.mkdir(parents=True)
    atlas_cache.sweep_work(root, keep="keep")
    atlas_cache.sweep_staging(root)
    assert sorted(os.listdir(work)) == ["keep"]
    assert not stage.exists()
    assert atlas_cache.recon_state("outdated") == "outdated"
    assert atlas_cache.recon_state("x") == "unknown"


def test_source_atlas_ids_mirror_the_typescript_catalog_and_name_files() -> None:
    from supraspina_sidecar.group_analysis import atlas_sources  # noqa: PLC0415

    for source in atlas_sources.SOURCES.values():
        start = _TS.index(f"sourceId: '{source.source_id}',")
        block = _TS[start : _TS.index("recipeId:", start)]
        ids = re.search(r"atlasIds: \[(.*?)\]", block, re.DOTALL)
        assert ids is not None
        assert tuple(re.findall(r"'([^']+)'", ids.group(1))) == source.atlas_ids
        assert f"'{source.license_name}'" in re.sub(r"\s+", " ", block)
    schaefer = atlas_sources.SOURCES["schaefer2018"]
    assert atlas_sources.atlas_files(schaefer, "schaefer400-7") == (
        "fsaverage/label/lh.Schaefer2018_400Parcels_7Networks_order.annot",
        "fsaverage/label/rh.Schaefer2018_400Parcels_7Networks_order.annot",
    )
    assert atlas_sources.atlas_files(schaefer, "schaefer300-7") == ()
    assert atlas_sources.atlas_label(schaefer, "schaefer200-17") == (
        "Schaefer 2018, 200 parcels, 17 networks"
    )
    assert atlas_sources.atlas_label(schaefer, "other") == (
        "Schaefer 2018 cortical parcellations (other)"
    )
