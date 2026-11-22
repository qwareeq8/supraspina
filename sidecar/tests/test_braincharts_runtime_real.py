"""The BrainCharts stage against a real provisioned model and pcntoolkit runtime.

Set ``SUPRASPINA_BRAINCHARTS_OUTPUT_DIR`` to a ``paths.outputDir`` whose
``.braincharts`` setup ``braincharts_runtime.execute_provision`` built; the
tests skip otherwise. Inputs are synthetic; no subject data is involved.
"""

from __future__ import annotations

import csv
import json
import math
import os
import random
import subprocess
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import braincharts_runtime, resources
from supraspina_sidecar.adapters.base import ADAPTERS

_OUTPUT_DIR = os.environ.get("SUPRASPINA_BRAINCHARTS_OUTPUT_DIR", "")
_TEMPLATE = resources.features_dir() / "rois_input_template.txt"
_SCRIPT = resources.resource_dir("braincharts", "braincharts_run.py")

pytestmark = pytest.mark.skipif(
    not _OUTPUT_DIR,
    reason="Set SUPRASPINA_BRAINCHARTS_OUTPUT_DIR to a provisioned setup.",
)


def _cfg(root: Path) -> dict[str, Any]:
    run_dir = root / "run"
    return {
        "paths": {"projectRoot": str(root), "outputDir": _OUTPUT_DIR},
        "steps": {
            "features": {"enabled": True, "params": {"outDir": str(root / "features")}},
            "braincharts": {"enabled": True, "params": {"seed": 117}},
        },
        "_supraspinaRuntime": {
            "runDir": str(run_dir),
            "brainchartsMetadataFile": str(run_dir / "inputs" / "metadata.csv"),
            "brainchartsWorkDir": str(run_dir / "work" / "braincharts"),
        },
    }


def _cohort(onesex: bool = False) -> list[tuple[str, str, str, str, str]]:
    """Return three adapted sites and one refused site of synthetic subjects."""
    rng = random.Random(20260930)  # noqa: S311 - Reproducible synthetic cohort.
    rows = []
    for site, controls, patients in (
        ("Alpha", 9, 5),
        ("Beta", 5, 3),
        ("Gamma", 2, 2),
        ("Delta", 0, 3),
    ):
        for index in range(controls + patients):
            cohort = "control" if index < controls else rng.choice(["SCI_P", "SCI_nNP"])
            sex = "F" if onesex and cohort == "control" else rng.choice("FM")
            rows.append(
                (
                    f"sub-{site[0]}{index:02d}",
                    str(rng.randint(20, 75)),
                    sex,
                    site,
                    cohort,
                )
            )
    return rows


def _write_inputs(
    cfg: dict[str, Any], rows: list[tuple[str, str, str, str, str]]
) -> None:
    rng = random.Random(7)  # noqa: S311 - Reproducible synthetic values.
    names = _TEMPLATE.read_text(encoding="utf-8").split()[2:]
    fs_names = [
        name.replace("&", "_and_").replace("-Thalamus-Proper", "-Thalamus")
        for name in names
    ]
    metadata = Path(cfg["_supraspinaRuntime"]["brainchartsMetadataFile"])
    metadata.parent.mkdir(parents=True)
    with open(metadata, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["subject", "age", "sex", "siteLabel", "cohort"])
        writer.writerows(rows)
    features = Path(ADAPTERS["braincharts"].features_csv(cfg))  # type: ignore[attr-defined]
    features.parent.mkdir(parents=True)
    with open(features, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["ID", *fs_names])
        for row in rows:
            values = []
            for name in names:
                if name.endswith("_thickness"):
                    value = rng.gauss(2.5, 0.15)
                elif name == "EstimatedTotalIntraCranialVol":
                    value = rng.gauss(1.5e6, 1e5)
                elif "Vol" in name:
                    value = rng.gauss(5e5, 3e4)
                else:
                    value = abs(rng.gauss(4000, 600))
                values.append(f"{value:.4f}")
            writer.writerow([row[0], *values])


def test_the_provisioned_setup_is_intact() -> None:
    state = braincharts_runtime.provision_state_status(
        {"paths": {"outputDir": _OUTPUT_DIR}}
    )
    assert state.environment_ok, state.detail
    assert state.model_ok, state.detail


def test_the_stage_runs_the_real_model(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    rows = _cohort()
    _write_inputs(cfg, rows)
    # Publish into the test directory, not the provisioned output directory.
    adapter = ADAPTERS["braincharts"]
    argv = adapter.build_command(cfg, None)
    argv[argv.index("--out-dir") + 1] = str(tmp_path / "braincharts")
    result = subprocess.run(  # noqa: S603 - The adapter's own argv.
        argv, capture_output=True, text=True, timeout=1800, check=False
    )
    assert result.returncode == 0, result.stderr[-2000:]
    out = tmp_path / "braincharts"
    with open(out / "braincharts_zscores.csv", newline="", encoding="utf-8") as handle:
        zscores = list(csv.DictReader(handle))
    # Alpha adapts 4 of 9 controls (round(4.5) is 4) and holds out 5, Beta
    # adapts 2 of 5 and holds out 3, and Gamma's 2 controls both adapt.
    controls = [row for row in zscores if row["cohort"] == "control"]
    assert len(controls) == 5 + 3
    assert {row["siteLabel"] for row in zscores} == {"Alpha", "Beta", "Gamma"}
    values = [
        float(value)
        for row in zscores
        for key, value in row.items()
        if key.endswith("_zscore")
    ]
    assert len(values) == len(zscores) * 187
    assert all(math.isfinite(value) for value in values)
    record = json.loads((out / "braincharts_run.json").read_text(encoding="utf-8"))
    assert record["runtime"]["pcntoolkit"] == "0.35.0"
    assert record["model"]["archiveSha256"] == braincharts_runtime.MODEL_ARCHIVE.sha256
    with open(
        out / "braincharts_refused_sites.csv", newline="", encoding="utf-8"
    ) as handle:
        assert [row["site"] for row in csv.DictReader(handle)] == ["Delta"]


_PERMUTATION = r"""
import importlib.util, json, sys
import numpy as np
spec = importlib.util.spec_from_file_location("braincharts_run", sys.argv[1])
bc = importlib.util.module_from_spec(spec)
sys.modules["braincharts_run"] = bc
spec.loader.exec_module(bc)
args = bc.parse_args(sys.argv[2:])
from pathlib import Path
bc.isolate_runtime(Path(args.work_dir))
phenotypes = bc.phenotype_union([bc.read_list(path) for path in args.phenotype_list])[:6]
subjects = bc.read_metadata(args.metadata)
positions, rows = bc.read_features(args.features, bc.phenotype_union([bc.read_list(p) for p in args.phenotype_list]))
bc.attach_features(subjects, bc.phenotype_union([bc.read_list(p) for p in args.phenotype_list]), positions, rows)
split = bc.split_sites([s for s in subjects if s.values], args.seed)
runtime = bc.load_runtime()
sites = bc.read_list(args.site_list)
first = bc.predict_zscores(split, phenotypes, Path(args.model_dir), sites, Path(args.work_dir), runtime)
labels = sorted(split.sitenums)
split.sitenums = {label: len(labels) - index for index, label in enumerate(labels)}
second = bc.predict_zscores(split, phenotypes, Path(args.model_dir), sites, Path(args.work_dir), runtime)
print(json.dumps({"first": first, "second": second, "sitenums": split.sitenums}))
"""


def test_z_scores_do_not_depend_on_the_site_numbering(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    _write_inputs(cfg, _cohort())
    argv = ADAPTERS["braincharts"].build_command(cfg, None)
    python, script = argv[0], argv[3]
    result = subprocess.run(  # noqa: S603
        [python, "-I", "-B", "-c", _PERMUTATION, script, *argv[4:]],
        capture_output=True,
        text=True,
        timeout=1800,
        check=False,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["sitenums"] == {"Alpha": 3, "Beta": 2, "Gamma": 1}
    for name, values in payload["first"].items():
        assert values == pytest.approx(payload["second"][name], rel=0, abs=1e-12), name
    assert str(_SCRIPT) == script


def test_adaptation_controls_of_one_sex_still_adapt(tmp_path: Path) -> None:
    """Expect pcntoolkit 0.35 to shift each site by one residual mean and SD."""
    cfg = _cfg(tmp_path)
    _write_inputs(cfg, _cohort(onesex=True))
    argv = ADAPTERS["braincharts"].build_command(cfg, None)
    argv[argv.index("--out-dir") + 1] = str(tmp_path / "braincharts")
    result = subprocess.run(  # noqa: S603 - The adapter's own argv.
        argv, capture_output=True, text=True, timeout=1800, check=False
    )
    assert result.returncode == 0, result.stderr[-2000:]
    with open(
        tmp_path / "braincharts" / "braincharts_zscores.csv",
        newline="",
        encoding="utf-8",
    ) as handle:
        rows = list(csv.DictReader(handle))
    assert all(
        math.isfinite(float(value))
        for row in rows
        for key, value in row.items()
        if key.endswith("_zscore")
    )
