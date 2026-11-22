"""Tests for the BrainCharts stage: the run script, its adapter, and its bindings.

The script is a first-party reimplementation of upstream SCI_Map Step 3 at
``eba4f59``. Upstream's code is unlicensed, so the split is checked against a
from-spec oracle written here rather than a copy. pcntoolkit is replaced by a
recording fake; ``test_braincharts_runtime_real.py`` runs the real model.
"""

from __future__ import annotations

import copy
import csv
import importlib.util
import json
import os
import random
import sys
from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import pytest

from supraspina_sidecar import (
    braincharts_runtime,
    final_r_contract,
    provenance,
    resources,
    workflow,
)
from supraspina_sidecar import workflow_manager as runtime
from supraspina_sidecar.adapters import braincharts as adapter_module
from supraspina_sidecar.adapters.base import ADAPTERS, Validation
from supraspina_sidecar.cohort import CohortSnapshot
from supraspina_sidecar.final_r_contract import (
    ZSCORE_ID_COLUMNS,
    ZSCORE_SUFFIX,
    ZSCORES_FILE,
)
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.provenance import (
    OUTPUT_SCHEMA,
    expected_receipt_payload,
    registry_fields_identity,
    stable_digest,
    uses_detector_edge,
)
from supraspina_sidecar.registry import STEP_BY_KEY, STEP_DESCRIPTORS
from supraspina_sidecar.registry_store import RegistryStore
from supraspina_sidecar.run_store import RunStore
from supraspina_sidecar.schema import validate_project_config
from supraspina_sidecar.workflow import build_plan, runtime_cfg
from supraspina_sidecar.workflow_manager import WorkflowManager, _RunContext

_SCRIPT = resources.resource_dir("braincharts", "braincharts_run.py")
_TEMPLATE = resources.features_dir() / "rois_input_template.txt"
_ADAPTER = ADAPTERS["braincharts"]


def _load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("braincharts_run", _SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


bc = _load_script()


def _model_names() -> list[str]:
    """Return the 187 region names in the model's spelling (PyBrainAge order)."""
    return _TEMPLATE.read_text(encoding="utf-8").split()[2:]


def _freesurfer_name(name: str) -> str:
    """Return the FreeSurfer spelling the ``features`` stage writes."""
    return name.replace("&", "_and_").replace("-Thalamus-Proper", "-Thalamus")


# -- Region names ------------------------------------------------------------------


def test_region_names_map_the_feature_table_onto_the_model() -> None:
    """The two key-file rules turn every FreeSurfer column into its model name."""
    names = _model_names()
    assert len(names) == 187
    freesurfer = [_freesurfer_name(name) for name in names]
    assert sum(name != fs for name, fs in zip(names, freesurfer, strict=True)) == 28
    assert [bc.model_region_name(name) for name in freesurfer] == names
    assert bc.model_region_name("Left-Thalamus") == "Left-Thalamus-Proper"
    assert bc.model_region_name("lh_G_and_S_cingul-Ant_thickness") == (
        "lh_G&S_cingul-Ant_thickness"
    )
    assert bc.model_region_name("Brain-Stem") == "Brain-Stem"


# -- Split --------------------------------------------------------------------------


def _upstream_split(
    rows: list[tuple[str, str, str]], seed: int, fraction: float = 0.5
) -> tuple[list[str], list[str], dict[str, int]]:
    """Split as upstream ``split_braincharts_adaptation_test.py`` specifies it.

    Rows are ``(subject, site, cohort)``. One ``random.Random(seed)``, sites
    with controls in sorted order, each site's controls sorted by subject and
    shuffled, one adaptation control for a single control, otherwise
    ``round(n * fraction)`` kept between 1 and ``n - 1``; the test rows are
    the held-out controls and every non-control. Adaptation rows sort by
    (site, subject) and test rows by (site, cohort, subject).
    """
    controls_by_site: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    noncontrols = []
    for row in rows:
        if row[2] == "control":
            controls_by_site[row[1]].append(row)
        else:
            noncontrols.append(row)
    rng = random.Random(seed)  # noqa: S311 - The oracle mirrors the split.
    adaptation: list[tuple[str, str, str]] = []
    test: list[tuple[str, str, str]] = []
    counts: dict[str, int] = {}
    for site in sorted(controls_by_site):
        controls = sorted(controls_by_site[site], key=lambda row: row[0])
        rng.shuffle(controls)
        n = len(controls)
        n_adapt = 1 if n == 1 else max(1, min(n - 1, round(n * fraction)))
        adaptation.extend(controls[:n_adapt])
        test.extend(controls[n_adapt:])
        counts[site] = n_adapt
    test.extend(noncontrols)
    adaptation.sort(key=lambda row: (row[1], row[0]))
    test.sort(key=lambda row: (row[1], row[2], row[0]))
    return [row[0] for row in adaptation], [row[0] for row in test], counts


def _subjects(rows: list[tuple[str, str, str]]) -> list[Any]:
    return [
        bc.Subject(
            subject=subject, site_label=site, cohort=cohort, age_text="40", sex="F"
        )
        for subject, site, cohort in rows
    ]


def _cohort_rows(rng: random.Random, sites: int) -> list[tuple[str, str, str]]:
    rows: list[tuple[str, str, str]] = []
    labels = rng.sample(["Prisma", "Ingenia", "Skyra", "Achieva", "Trio"], sites)
    for label in labels:
        rows.extend(
            (f"sub-{rng.randrange(10**6):06d}", label, "control")
            for _ in range(rng.randint(0, 12))
        )
        for _ in range(rng.randint(0, 4)):
            cohort = rng.choice(["SCI_P", "SCI_nNP"])
            rows.append((f"sub-{rng.randrange(10**6):06d}", label, cohort))
    unique = {row[0]: row for row in rows}
    return list(unique.values())


@pytest.mark.parametrize("case", range(240))
def test_split_matches_the_upstream_split_oracle(case: int) -> None:
    """Sites with 3 or more controls split exactly as upstream, row for row.

    The two approved deviations hold everywhere else: fewer than 2 controls
    refuse the site, and exactly 2 both adapt. Upstream's random stream is
    kept, so a deviating site never changes a later site's split.
    """
    rng = random.Random(case)  # noqa: S311 - Reproducible synthetic cohorts.
    rows = _cohort_rows(rng, 1 + case % 4)
    seed = 117 if case % 3 else rng.randrange(10**6)
    up_adapt, up_test, up_counts = _upstream_split(rows, seed)
    split = bc.split_sites(_subjects(rows), seed)
    site_of = {row[0]: row[1] for row in rows}
    controls = defaultdict(list)
    for row in rows:
        if row[2] == "control":
            controls[row[1]].append(row[0])
    eligible = {site for site, members in controls.items() if len(members) >= 2}

    ours_adapt = [subject.subject for subject in split.adaptation]
    ours_test = [subject.subject for subject in split.test]
    upstream_kept = [
        subject for subject in up_adapt if len(controls[site_of[subject]]) >= 3
    ]
    assert [s for s in ours_adapt if len(controls[site_of[s]]) >= 3] == upstream_kept
    two_control = {site for site, members in controls.items() if len(members) == 2}
    assert ours_test == [
        subject
        for subject in up_test
        if site_of[subject] in eligible
        and not (
            site_of[subject] in two_control and subject in controls[site_of[subject]]
        )
    ]
    for site in eligible:
        report = next(item for item in split.reports if item.site == site)
        expected = len(controls[site]) if len(controls[site]) == 2 else up_counts[site]
        assert report.controls_adaptation == expected
        assert report.refused is False
    assert split.sitenums == {
        label: index + 1 for index, label in enumerate(sorted(eligible))
    }
    for row in rows:
        role = split.roles[row[0]][0]
        assert (role == "refused") is (row[1] not in eligible)


@pytest.mark.parametrize(
    ("controls", "adapting"),
    [(2, 2), (3, 2), (4, 2), (5, 2), (6, 3), (7, 4), (9, 4), (11, 6), (41, 20)],
)
def test_adaptation_count_rounds_half_to_even(controls: int, adapting: int) -> None:
    # 41 controls adapt with 20, since round(20.5) is 20.
    assert bc.adaptation_count(controls) == adapting


def test_fewer_than_two_controls_cannot_adapt() -> None:
    with pytest.raises(ValueError, match="at least 2"):
        bc.adaptation_count(1)


def test_refused_and_two_control_sites_state_their_reasons() -> None:
    rows = [
        ("sub-01", "Prisma", "control"),
        ("sub-02", "Prisma", "control"),
        ("sub-03", "Prisma", "control"),
        ("sub-04", "Prisma", "SCI_P"),
        ("sub-05", "Skyra", "control"),
        ("sub-06", "Skyra", "control"),
        ("sub-07", "Skyra", "SCI_nNP"),
        ("sub-08", "Trio", "control"),
        ("sub-09", "Trio", "SCI_P"),
    ] + [(f"sub-1{index}", "Ingenia", "SCI_P") for index in range(6)]
    split = bc.split_sites(_subjects(rows), 117)
    reasons = {report.site: (report.refused, report.reason) for report in split.reports}
    assert reasons == {
        "Ingenia": (
            True,
            "Site Ingenia has no controls, so the model cannot be adapted to it; "
            "its 6 subjects get no z-scores.",
        ),
        "Prisma": (False, ""),
        "Skyra": (
            False,
            "Site Skyra has 2 controls; both adapt the model, so none are held out.",
        ),
        "Trio": (True, "Site Trio has 1 control; adapting the model needs at least 2."),
    }
    assert split.sitenums == {"Prisma": 1, "Skyra": 2}
    assert split.roles["sub-05"][0] == split.roles["sub-06"][0] == "adaptation"
    assert split.roles["sub-07"] == ("test", "")
    assert split.roles["sub-08"][0] == "refused"


def test_one_unnamed_site_reads_as_the_cohort() -> None:
    split = bc.split_sites(
        _subjects([("sub-1", "", "control"), ("sub-2", "", "SCI_P")]), 117
    )
    assert split.reports[0].reason == (
        "The cohort has 1 control; adapting the model needs at least 2."
    )


# -- Whole-run fixtures ----------------------------------------------------------------


class _FakePcntoolkit:
    """Record every design-matrix and predict call; return simple z-scores."""

    def __init__(self) -> None:
        self.designs: list[dict[str, Any]] = []
        self.predictions: list[dict[str, Any]] = []

    def create_design_matrix(self, covariates: Any, **kwargs: Any) -> Any:
        self.designs.append({"rows": covariates.tolist(), **kwargs})
        return np.column_stack([np.ones(covariates.shape[0]), covariates])

    def predict(self, covfile: str, **kwargs: Any) -> Any:
        groups = np.atleast_1d(np.loadtxt(kwargs["adaptvargroupfile"])).tolist()
        self.predictions.append(
            {"covfile": covfile, "cwd": os.getcwd(), "adaptGroups": groups, **kwargs}
        )
        response = np.atleast_1d(np.loadtxt(kwargs["respfile"]))
        return response, np.ones_like(response), (response - 2.0)[:, None]

    def runtime(self) -> tuple[Any, Any, Any]:
        return np, self.predict, self.create_design_matrix


def _write_lists(root: Path) -> dict[str, Any]:
    names = _model_names()
    docs = root / "docs"
    docs.mkdir(parents=True)
    lists = {
        "phenotypes_ct_lh.txt": names[:75],
        "phenotypes_ct_rh.txt": names[75:150],
        "phenotypes_sc.txt": names[150:],
    }
    for name, values in lists.items():
        (docs / name).write_text("\n".join(values) + "\n", encoding="utf-8")
    (docs / "site_ids_ct_82sites.txt").write_text(
        "TRAIN_A\nTRAIN_B\n", encoding="utf-8"
    )
    model = root / "lifespan_57K_82sites"
    for name in names:
        (model / name / "Models").mkdir(parents=True)
    archive = root / "lifespan_57K_82sites.zip"
    archive.write_bytes(b"model archive")
    return {
        "model": model,
        "archive": archive,
        "sites": docs / "site_ids_ct_82sites.txt",
        "lists": [docs / name for name in lists],
    }


def _write_inputs(
    root: Path, rows: list[tuple[str, str, str, str, str]], *, drop: str | None = None
) -> tuple[Path, Path]:
    """Write the projection and a feature table; rows are subject, age, sex, site, cohort."""
    metadata = root / "metadata.csv"
    with open(metadata, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["subject", "age", "sex", "siteLabel", "cohort"])
        writer.writerows(rows)
    names = [_freesurfer_name(name) for name in _model_names() if name != drop]
    features = root / "features.csv"
    with open(features, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["ID", *names])
        for index, row in enumerate(rows):
            writer.writerow(
                [
                    row[0],
                    *(f"{2 + index / 10 + j / 1000:.4f}" for j in range(len(names))),
                ]
            )
    return metadata, features


_ROWS = [
    ("sub-01", "40", "F", "Prisma", "control"),
    ("sub-02", "41", "M", "Prisma", "control"),
    ("sub-03", "42", "F", "Prisma", "control"),
    ("sub-04", "43", "M", "Prisma", "control"),
    ("sub-05", "44", "F", "Prisma", "SCI_P"),
    ("sub-06", "45", "M", "Prisma", "SCI_nNP"),
    ("sub-07", "46", "F", "Ingenia", "SCI_P"),
    ("sub-08", "", "M", "Prisma", "SCI_P"),
    ("sub-09", "47", "O", "Prisma", "SCI_P"),
]


def _args(
    root: Path, model: dict[str, Any], metadata: Path, features: Path, seed: int = 117
) -> list[str]:
    argv = [
        "--features",
        str(features),
        "--metadata",
        str(metadata),
        "--model-dir",
        str(model["model"]),
        "--model-archive",
        str(model["archive"]),
        "--site-list",
        str(model["sites"]),
    ]
    for path in model["lists"]:
        argv.extend(["--phenotype-list", str(path)])
    argv.extend(
        [
            "--out-dir",
            str(root / "out" / "braincharts"),
            "--work-dir",
            str(root / "work"),
            "--seed",
            str(seed),
        ]
    )
    return argv


def _read(path: Path) -> list[dict[str, str]]:
    with open(path, newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


@pytest.fixture
def ran(tmp_path: Path) -> tuple[Path, _FakePcntoolkit]:
    model = _write_lists(tmp_path / "model")
    metadata, features = _write_inputs(tmp_path, _ROWS)
    fake = _FakePcntoolkit()
    assert (
        bc.run(
            bc.parse_args(_args(tmp_path, model, metadata, features)), fake.runtime()
        )
        == 0
    )
    return tmp_path, fake


def test_run_writes_the_contract_tables(ran: tuple[Path, _FakePcntoolkit]) -> None:
    root, _fake = ran
    out = root / "out" / "braincharts"
    names = _model_names()
    zscores = _read(out / ZSCORES_FILE)
    with open(out / ZSCORES_FILE, encoding="utf-8") as handle:
        header = next(csv.reader(handle))
    assert header == [*ZSCORE_ID_COLUMNS, *(f"{name}{ZSCORE_SUFFIX}" for name in names)]
    split = {row["subject"]: row for row in _read(out / "braincharts_split.csv")}
    held_out = sorted(row["subject"] for row in zscores)
    assert held_out == sorted(
        key for key, row in split.items() if row["role"] == "test"
    )
    assert {row["subject"] for row in zscores} >= {"sub-05", "sub-06"}
    assert split["sub-07"]["reason"] == (
        "Site Ingenia has no controls, so the model cannot be adapted to it; its 1 "
        "subject gets no z-scores."
    )
    assert split["sub-08"] == {
        "subject": "sub-08",
        "siteLabel": "Prisma",
        "cohort": "SCI_P",
        "role": "refused",
        "reason": "sub-08 has no age, so it gets no z-scores.",
    }
    assert (
        split["sub-09"]["reason"] == "sub-09 has sex O; the model takes female or male."
    )
    sexes = {row["subject"]: row["sex"] for row in zscores}
    assert (sexes["sub-05"], sexes["sub-06"]) == ("0", "1")
    refused = _read(out / "braincharts_refused_sites.csv")
    assert refused == [
        {
            "site": "Ingenia",
            "subjects": "1",
            "subject_ids": "sub-07",
            "reason": split["sub-07"]["reason"],
        }
    ]
    report = _read(out / "braincharts_split_report.csv")
    assert [row["site"] for row in report] == ["Ingenia", "Prisma"]
    assert report[1]["controls_adaptation"] == "2"
    summary = _read(out / "braincharts_zscore_summary.csv")
    assert [row["phenotype"] for row in summary] == names
    assert summary[0]["n"] == str(len(zscores))
    full = _read(out / "braincharts_test_with_zscores.csv")
    assert (full[0]["site"], full[0]["sitenum"]) == ("supraspina-site-1", "1")
    record = json.loads((out / "braincharts_run.json").read_text(encoding="utf-8"))
    assert record["seed"] == 117
    assert record["adaptFraction"] == 0.5
    assert record["sitenums"] == {"Prisma": 1}
    assert record["model"]["name"] == "lifespan_57K_82sites"
    assert record["counts"] == {
        "subjects": 9,
        "zscores": 4,
        "adaptation": 2,
        "refused": 3,
    }


def test_run_calls_pcntoolkit_as_upstream(ran: tuple[Path, _FakePcntoolkit]) -> None:
    root, fake = ran
    assert len(fake.predictions) == 187
    call = fake.predictions[0]
    assert call["alg"] == "blr"
    assert call["inputsuffix"] == "estimate"
    assert call["model_path"].endswith(f"{_model_names()[0]}/Models")
    assert {
        "adaptrespfile",
        "adaptcovfile",
        "adaptvargroupfile",
        "testvargroupfile",
    } <= set(call)
    assert call["cwd"] == str(root / "work" / "model_work" / _model_names()[0])
    assert call["adaptGroups"] == [1.0, 1.0]
    for design in fake.designs:
        assert design["basis"] == "bspline"
        assert (design["xmin"], design["xmax"]) == (-5.0, 110.0)
        assert design["all_sites"] == ["TRAIN_A", "TRAIN_B"]
        assert set(design["site_ids"]) == {"supraspina-site-1"}
    # Covariates are age then sex (the B-spline expands column 0).
    assert fake.designs[0]["rows"][0][1] in (0.0, 1.0)


def test_run_publishes_one_bound_generation(
    tmp_path: Path, ran: tuple[Path, _FakePcntoolkit]
) -> None:
    root, _fake = ran
    out = root / "out" / "braincharts"
    assert out.is_symlink()
    first = out.resolve()
    manifest = json.loads((out / ".braincharts-generation.json").read_text())
    assert [record["name"] for record in manifest["files"]] == list(
        adapter_module.OUTPUT_BASENAMES
    )
    assert not (root / "work").exists()
    model = _write_lists(tmp_path / "model-2")
    metadata, features = _write_inputs(tmp_path, _ROWS)
    assert (
        bc.run(
            bc.parse_args(_args(root, model, metadata, features, seed=5)),
            _FakePcntoolkit().runtime(),
        )
        == 0
    )
    second = out.resolve()
    assert second != first
    assert sorted(path.name for path in second.parent.iterdir()) == [second.name]


def test_a_real_output_directory_moves_into_the_generation_store(
    tmp_path: Path,
) -> None:
    model = _write_lists(tmp_path / "model")
    metadata, features = _write_inputs(tmp_path, _ROWS)
    legacy = tmp_path / "out" / "braincharts"
    legacy.mkdir(parents=True)
    (legacy / "old.csv").write_text("x\n", encoding="utf-8")
    assert (
        bc.run(
            bc.parse_args(_args(tmp_path, model, metadata, features)),
            _FakePcntoolkit().runtime(),
        )
        == 0
    )
    assert legacy.is_symlink()
    assert not (legacy / "old.csv").exists()


def test_regions_that_differ_from_the_model_lists_exit_3(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    model = _write_lists(tmp_path / "model")
    metadata, features = _write_inputs(tmp_path, _ROWS, drop="Brain-Stem")
    assert bc.main(_args(tmp_path, model, metadata, features)) == bc.EXIT_REGIONS
    assert capsys.readouterr().err.strip() == (
        "The feature table's regions do not match the model's phenotype lists: "
        "missing Brain-Stem."
    )


def test_no_adaptable_site_exits_4(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    model = _write_lists(tmp_path / "model")
    rows = [
        ("sub-01", "40", "F", "Ingenia", "control"),
        ("sub-02", "50", "M", "Ingenia", "SCI_P"),
    ]
    metadata, features = _write_inputs(tmp_path, rows)
    assert bc.main(_args(tmp_path, model, metadata, features)) == bc.EXIT_NO_SITE
    assert capsys.readouterr().err.strip() == (
        "No site has at least 2 controls, so the model cannot be adapted."
    )
    assert not (tmp_path / "out" / "braincharts").exists()


def test_a_missing_runtime_exits_6(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    model = _write_lists(tmp_path / "model")
    metadata, features = _write_inputs(tmp_path, _ROWS)
    monkeypatch.setitem(sys.modules, "pcntoolkit", None)
    assert bc.main(_args(tmp_path, model, metadata, features)) == bc.EXIT_RUNTIME
    assert "cannot import pcntoolkit" in capsys.readouterr().err


def test_a_prediction_failure_names_the_region(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    model = _write_lists(tmp_path / "model")
    metadata, features = _write_inputs(tmp_path, _ROWS)
    fake = _FakePcntoolkit()

    def fail(*_args: Any, **_kwargs: Any) -> None:
        raise ValueError("Insufficient adaptation data to estimate variance")

    args = bc.parse_args(_args(tmp_path, model, metadata, features))
    with pytest.raises(bc.StageError) as caught:
        bc.run(args, (np, fail, fake.create_design_matrix))
    assert caught.value.code == bc.EXIT_MODEL
    assert str(caught.value) == (
        f"The model could not be applied to {_model_names()[0]}: Insufficient "
        "adaptation data to estimate variance."
    )


def test_the_isolated_runtime_writes_caches_under_the_work_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in (
        "XDG_CACHE_HOME",
        "MPLCONFIGDIR",
        "NUMBA_CACHE_DIR",
        "PYTENSOR_FLAGS",
        "OMP_NUM_THREADS",
    ):
        monkeypatch.delenv(name, raising=False)
    bc.isolate_runtime(tmp_path)
    assert os.environ["NUMBA_CACHE_DIR"].startswith(str(tmp_path))
    assert (
        os.environ["PYTENSOR_FLAGS"]
        == f"base_compiledir={tmp_path / 'cache' / 'pytensor'}"
    )
    assert os.environ["OMP_NUM_THREADS"] == "1"


# -- Adapter -------------------------------------------------------------------------------


def _cfg(root: Path, **runtime_values: Any) -> dict[str, Any]:
    cfg: dict[str, Any] = {
        "paths": {"projectRoot": str(root), "outputDir": str(root / "out")},
        "steps": {"braincharts": {"enabled": True, "params": {"seed": 7}}},
    }
    if runtime_values:
        cfg["_supraspinaRuntime"] = runtime_values
    return cfg


def test_the_adapter_builds_the_fixed_argv(tmp_path: Path) -> None:
    cfg = _cfg(
        tmp_path,
        runDir=str(tmp_path / "run"),
        brainchartsMetadataFile=str(tmp_path / "run" / "inputs" / "bc.csv"),
        brainchartsWorkDir=str(tmp_path / "run" / "work" / "braincharts"),
    )
    argv = _ADAPTER.build_command(cfg, None)
    root = tmp_path / "out" / ".braincharts" / "current"
    assert argv[:4] == [
        str(root / "envs" / "braincharts" / "bin" / "python"),
        "-I",
        "-B",
        str(_SCRIPT),
    ]
    options = dict(zip(argv[4::2], argv[5::2], strict=False))
    assert options["--features"] == str(
        tmp_path / "out" / "features" / "concatenated_results.csv"
    )
    assert options["--metadata"] == str(tmp_path / "run" / "inputs" / "bc.csv")
    assert options["--model-dir"] == str(root / "models" / "lifespan_57K_82sites")
    assert options["--out-dir"] == str(tmp_path / "out" / "braincharts")
    assert options["--seed"] == "7"
    assert argv.count("--phenotype-list") == 3


def test_the_preview_names_run_scoped_inputs(tmp_path: Path) -> None:
    preview = _ADAPTER.preview(_cfg(tmp_path), None)
    assert "'<run-scoped BrainCharts metadata>'" in preview
    assert "--seed 7" in preview


def test_the_adapter_follows_the_features_output_directory(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    cfg["steps"]["features"] = {
        "enabled": True,
        "params": {"outDir": str(tmp_path / "feat")},
    }
    assert _ADAPTER.features_csv(cfg) == str(
        tmp_path / "feat" / "concatenated_results.csv"
    )


def test_the_adapter_requires_the_two_braincharts_checks() -> None:
    assert _ADAPTER.required_check_ids({}) == ("bcenv", "bcmodel")
    blocked = _ADAPTER.validate({}, {"groups": []})
    assert len(blocked.blocking) == 2


def test_the_adapter_names_the_platform_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(braincharts_runtime, "platform_supported", lambda: False)
    assert _ADAPTER.validate({}, {"groups": []}).blocking == [
        "The BrainCharts runtime is available on Linux x86_64 only."
    ]


def _published(tmp_path: Path) -> Path:
    model = _write_lists(tmp_path / "model")
    metadata, features = _write_inputs(tmp_path, _ROWS)
    args = _args(tmp_path, model, metadata, features)
    assert bc.run(bc.parse_args(args), _FakePcntoolkit().runtime()) == 0
    return tmp_path / "out" / "braincharts"


def test_detect_reads_the_published_generation(tmp_path: Path) -> None:
    assert _ADAPTER.detect(_cfg(tmp_path), None).state == "pending"
    out = _published(tmp_path)
    cohort = [row[0] for row in _ROWS]
    status = _ADAPTER.detect(_cfg(tmp_path, reconstructionViewSubjectIds=cohort), None)
    assert status.state == "done", status.detail
    assert status.detail == (
        "Z-scores for 4 subjects; 2 controls adapt the model and get no z-score. "
        "3 subjects get no z-scores: sub-07, sub-08, sub-09."
    )
    assert len(status.artifacts) == 7
    assert _ADAPTER.members(_cfg(tmp_path)) == frozenset(cohort)
    other = _ADAPTER.detect(
        _cfg(tmp_path, reconstructionViewSubjectIds=cohort[:-1]), None
    )
    assert other.state == "partial"
    assert "1 extra" in other.detail
    (out / "braincharts_zscore_summary.csv").write_text("changed\n", encoding="utf-8")
    assert _ADAPTER.detect(_cfg(tmp_path), None).state == "failed"


def test_detect_reports_missing_outputs(tmp_path: Path) -> None:
    out = _published(tmp_path)
    (out / "braincharts_split.csv").unlink()
    status = _ADAPTER.detect(_cfg(tmp_path), None)
    assert status.state == "partial"
    assert (
        status.detail
        == "Create the missing BrainCharts outputs: braincharts_split.csv."
    )


@pytest.mark.parametrize(
    ("rc", "tag"),
    [
        (2, "input_invalid"),
        (3, "regions_mismatch"),
        (4, "no_adaptable_site"),
        (5, "model_failed"),
        (6, "runtime_incomplete"),
    ],
)
def test_parse_failure_keeps_the_closing_sentence(rc: int, tag: str) -> None:
    failure = _ADAPTER.parse_failure(
        rc, "Running IDP 1/187\n", "warn\nThe stated reason.\n"
    )
    assert failure is not None
    assert (failure.tag, failure.message) == (tag, "The stated reason.")
    assert _ADAPTER.parse_failure(0, "", "") is None
    assert _ADAPTER.parse_failure(137, "", "").tag == "oom_killed"  # type: ignore[union-attr]


def test_the_adapter_lists_what_the_script_publishes() -> None:
    assert adapter_module.OUTPUT_BASENAMES == bc.OUTPUT_FILES
    assert adapter_module.MANIFEST_BASENAME == bc.MANIFEST_FILE
    assert adapter_module.SPLIT_COLUMNS == bc.SPLIT_COLUMNS
    assert ZSCORE_ID_COLUMNS == bc.ZSCORE_ID_COLUMNS
    assert ZSCORES_FILE == bc.ZSCORES_FILE
    assert final_r_contract.REFUSED_SITES_FILE == bc.REFUSED_SITES_FILE
    assert final_r_contract.REFUSED_SITES_COLUMNS == bc.REFUSED_SITES_COLUMNS
    assert {
        code: getattr(bc, name)
        for code, name in (
            (adapter_module.EXIT_INPUT, "EXIT_INPUT"),
            (adapter_module.EXIT_REGIONS, "EXIT_REGIONS"),
            (adapter_module.EXIT_NO_SITE, "EXIT_NO_SITE"),
            (adapter_module.EXIT_MODEL, "EXIT_MODEL"),
            (adapter_module.EXIT_RUNTIME, "EXIT_RUNTIME"),
        )
    } == {2: 2, 3: 3, 4: 4, 5: 5, 6: 6}


# -- Registry, receipt, and configuration ------------------------------------------------


def _registry_file(root: Path, records: dict[str, dict[str, Any]]) -> Path:
    path = root / ".supraspina" / "registry.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"schemaVersion": 1, "records": records}), encoding="utf-8"
    )
    return path


def _record(**fields: Any) -> dict[str, Any]:
    return {
        "subjectId": "sub-01",
        "age": 40,
        "sex": "F",
        "cohortRole": "healthy",
        "ais": None,
        "tSinceSci": None,
        "revision": 1,
        "updatedAt": "2026-09-30T00:00:00Z",
        **fields,
    }


def test_registry_fields_bind_only_the_five_used_fields(tmp_path: Path) -> None:
    path = _registry_file(tmp_path, {"sub-01": _record()})
    base = registry_fields_identity(str(path))
    assert (base["exists"], base["kind"]) == (True, "registry-fields-v1")
    _registry_file(tmp_path, {"sub-01": _record(ais="A", tSinceSci=3, revision=9)})
    assert registry_fields_identity(str(path)) == base
    for changed in (
        {"age": 41},
        {"sex": "M"},
        {"site": "Prisma"},
        {"cohortRole": "sci-neuropathic-pain"},
    ):
        _registry_file(tmp_path, {"sub-01": _record(**changed)})
        assert registry_fields_identity(str(path)) != base, changed
    _registry_file(
        tmp_path, {"sub-01": _record(), "sub-02": _record(subjectId="sub-02")}
    )
    assert registry_fields_identity(str(path)) != base
    assert registry_fields_identity(str(tmp_path / "missing.json")) == {"exists": False}


def _cohort() -> CohortSnapshot:
    return CohortSnapshot(
        analysis_subject_ids=("sub-01",),
        selected_subject_ids=("sub-01",),
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(),
        qc_verdicts=(("sub-01", "pass"),),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def test_the_receipt_binds_the_registry_fields_model_and_script(tmp_path: Path) -> None:
    _registry_file(tmp_path, {"sub-01": _record()})
    payload = expected_receipt_payload(
        "braincharts", None, _cfg(tmp_path), _cohort(), _ADAPTER
    )
    assert set(payload["externalInputs"]) == {"registryFields"}
    resources_bound = payload["adapterImplementation"]["scientificResources"]
    assert set(resources_bound) == {"analysis", "model", "modelLists"}
    assert resources_bound["analysis"]["exists"] is True
    assert payload["outputSchemaIdentity"] == OUTPUT_SCHEMA["braincharts"]
    _registry_file(tmp_path, {"sub-01": _record(ais="B")})
    same = expected_receipt_payload(
        "braincharts", None, _cfg(tmp_path), _cohort(), _ADAPTER
    )
    assert same["externalInputs"] == payload["externalInputs"]


def test_projects_require_braincharts_and_validate_its_seed() -> None:
    assert STEP_DESCRIPTORS[-2]["key"] == "braincharts"
    assert STEP_BY_KEY["braincharts"]["dependencies"] == ["features"]
    cfg = _valid_project_config()
    del cfg["steps"]["braincharts"]
    ok, errors, _warnings = validate_project_config(cfg)
    assert not ok
    assert errors == ["Add the missing pipeline steps: braincharts."]
    cfg["steps"]["braincharts"] = {"enabled": True, "params": {"seed": -1}}
    ok, errors, _warnings = validate_project_config(cfg)
    assert not ok
    assert errors == [
        "Keep steps.braincharts.params.seed as an integer from 0 through 2147483647."
    ]


def _valid_project_config() -> dict[str, Any]:
    return {
        "project": {"name": "p", "createdAt": ""},
        "platform": {"mode": "linux", "pathStyle": "posix"},
        "paths": {
            "projectRoot": "/p",
            "rawdataDir": "/p/rawdata",
            "derivativesDir": "/p/derivatives",
            "outputDir": "/p/outputs",
            "metadataDir": "/p/metadata",
        },
        "tools": {
            "freesurferHome": "/fs",
            "freesurferLicense": "/fs/license.txt",
            "pythonExecutable": "",
            "rscriptExecutable": "",
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "runtime": {
            "threads": 1,
            "queueSize": 1,
            "memoryWarningGB": 10,
            "dryRun": True,
            "resumeCompleted": True,
            "rerunIncomplete": False,
            "stopOnError": False,
            "continueIndependentAfterError": True,
        },
        "subjects": {"include": [], "exclude": []},
        "steps": {key: {"enabled": True, "params": {}} for key in STEP_BY_KEY},
        "pybrain": {"modelPath": "/m", "scalerPath": "/s"},
        "outputs": {
            "rootDir": "/p/outputs",
            "runDir": "/p/outputs",
            "manifestPath": "/p/outputs/manifest.json",
        },
        "provenance": {"configSha256": "", "runId": ""},
    }


# -- Planner -----------------------------------------------------------------------------


class _PlanAdapter:
    def __init__(self, key: str) -> None:
        self.key = key

    def validate(self, _cfg: dict[str, Any], _env: dict[str, Any]) -> Validation:
        return Validation()

    def build_command(self, _cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        return [self.key, subject_id or "cohort"]

    def preview(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        return " ".join(self.build_command(cfg, subject_id))


def _plan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    rows: list[tuple[str, str, str | None]],
    *,
    features: dict[str, Any] | None = None,
    ages: dict[str, float] | None = None,
) -> Any:
    root = tmp_path / "project"
    raw = root / "rawdata"
    labels = {
        "healthy": "CTRL",
        "sci-neuropathic-pain": "SCI_P",
        "sci-no-neuropathic-pain": "SCI_nNP",
    }
    for subject_id, role, site in rows:
        path = raw / subject_id / "anat" / f"{subject_id}_T1w.nii.gz"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(subject_id.encode())
        record: dict[str, Any] = {
            "subjectId": subject_id,
            "age": (ages or {}).get(subject_id, 40),
            "sex": "F",
            "sourceCohortLabel": labels[role],
            "ais": None,
            "tSinceSci": None,
        }
        if site is not None:
            record["site"] = site
        RegistryStore(str(root)).upsert(record)
    monkeypatch.setattr(
        workflow,
        "ADAPTERS",
        {key: _PlanAdapter(key) for key in ("features", "braincharts")},
    )
    cfg = {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(raw),
            "derivativesDir": str(root / "derivatives"),
            "outputDir": str(root / "output"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "subjects": {"include": [], "exclude": []},
        "runtime": {"dryRun": True},
        "steps": {
            "features": features or {"enabled": True, "params": {}},
            "braincharts": {"enabled": True, "params": {}},
        },
    }
    return build_plan(
        {
            "project": {
                "projectId": "braincharts-plan",
                "root": str(root),
                "configPath": str(root / "supraspina.project.json"),
                "epoch": 1,
            },
            "cfg": cfg,
            "configRevision": 1,
            "intent": {"kind": "workflow", "target": {"mode": "all"}},
            "acknowledgements": {"includeDeferredAndUnreviewedQc": True},
        },
        run_id="run-00000000000b",
    )


def _node(planned: Any) -> dict[str, Any]:
    return next(
        node
        for node in planned.result["plan"]["nodes"]
        if node["stepKey"] == "braincharts"
    )


def test_two_controls_plan_braincharts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    planned = _plan(
        tmp_path,
        monkeypatch,
        [
            ("sub-1", "healthy", None),
            ("sub-2", "healthy", None),
            ("sub-3", "sci-neuropathic-pain", None),
        ],
    )
    node = _node(planned)
    assert node["status"] == "waiting"
    assert node["dependencies"] == [
        next(
            item["nodeId"]
            for item in planned.result["plan"]["nodes"]
            if item["stepKey"] == "features"
        )
    ]
    assert not any("BrainCharts" in warning for warning in planned.warnings)


def test_no_adaptable_site_blocks_braincharts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    planned = _plan(
        tmp_path,
        monkeypatch,
        [
            ("sub-1", "healthy", "Prisma"),
            ("sub-2", "healthy", "Ingenia"),
            ("sub-3", "sci-neuropathic-pain", "Ingenia"),
        ],
    )
    node = _node(planned)
    assert node["status"] == "blocked"
    assert (
        node["reason"]
        == "No site has at least 2 controls, so the model cannot be adapted."
    )


def test_a_refused_site_is_stated_in_the_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    planned = _plan(
        tmp_path,
        monkeypatch,
        [
            ("sub-1", "healthy", "Prisma"),
            ("sub-2", "healthy", "Prisma"),
            ("sub-3", "sci-neuropathic-pain", "Ingenia"),
            ("sub-4", "sci-no-neuropathic-pain", "Ingenia"),
        ],
    )
    assert _node(planned)["status"] == "waiting"
    assert planned.warnings[-1] == (
        "BrainCharts adapts the model to 1 of 2 sites. Site Ingenia has no controls, "
        "so its 2 subjects get no z-scores."
    )


def test_a_control_outside_the_model_age_range_does_not_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # braincharts_run.py refuses an age outside -5 to 110 years, so the
    # second control cannot make the site adaptable.
    planned = _plan(
        tmp_path,
        monkeypatch,
        [
            ("sub-1", "healthy", None),
            ("sub-2", "healthy", None),
            ("sub-3", "sci-neuropathic-pain", None),
        ],
        ages={"sub-1": 110, "sub-2": 111},
    )
    node = _node(planned)
    assert node["status"] == "blocked"
    assert (
        node["reason"]
        == "No site has at least 2 controls, so the model cannot be adapted."
    )


@pytest.mark.parametrize(
    "features",
    [
        {"enabled": False, "params": {}},
        {"enabled": True, "params": {"parcellation": "aparc"}},
        {"enabled": True, "params": {"measure": "area"}},
    ],
)
def test_braincharts_needs_destrieux_thickness_features(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, features: dict[str, Any]
) -> None:
    planned = _plan(
        tmp_path,
        monkeypatch,
        [("sub-1", "healthy", None), ("sub-2", "healthy", None)],
        features=features,
    )
    node = _node(planned)
    assert node["status"] == "blocked"
    assert node["reason"] == (
        "Enable FreeSurfer feature extraction with aparc.a2009s thickness; "
        "BrainCharts reads its 187 regions."
    )


def test_mixed_sites_block_braincharts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    planned = _plan(
        tmp_path,
        monkeypatch,
        [("sub-1", "healthy", "Prisma"), ("sub-2", "healthy", None)],
    )
    assert _node(planned)["reason"] == (
        "Set a site for sub-2; some subjects have a site and this subject does not."
    )


# -- Run-scoped projection and launch binding --------------------------------------------------


class _Emitter:
    def emit(self, _method: str, _params: dict[str, Any]) -> None:
        return None


def _context(root: Path, subjects: tuple[str, ...]) -> _RunContext:
    cohort = CohortSnapshot(
        analysis_subject_ids=subjects,
        selected_subject_ids=subjects,
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(),
        qc_verdicts=tuple((subject_id, "pass") for subject_id in subjects),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )
    identity = ProjectIdentity(
        "bc-project",
        str(root.resolve()),
        str((root / "supraspina.project.json").resolve()),
        1,
    )
    return _RunContext(
        state={"runId": "run-bc0000000001", "inputProjections": []},
        cfg={},
        effective_cfg={},
        cohort=cohort,
        project=identity,
        store=RunStore(str(root)),
        queue_limit=1,
    )


def test_the_projection_reads_the_registry_and_binds_its_fields(tmp_path: Path) -> None:
    store = RegistryStore(str(tmp_path))
    for subject_id, label, extra in (
        ("sub-01", "CTRL", {"site": "Prisma"}),
        ("sub-02", "SCI_P", {"site": "Ingenia", "age": 40.5}),
        ("sub-03", "SCI_nNP", {"site": "Prisma", "age": None, "sex": "O"}),
    ):
        store.upsert(
            {
                "subjectId": subject_id,
                "age": 40,
                "sex": "M",
                "sourceCohortLabel": label,
                "ais": None,
                "tSinceSci": None,
                **extra,
            }
        )
    ctx = _context(tmp_path, ("sub-01", "sub-02", "sub-03"))
    destination = tmp_path / "run" / "inputs" / "braincharts-metadata.csv"
    manager = WorkflowManager(_Emitter())
    try:
        manager._braincharts_projection(ctx, str(destination))
    finally:
        manager.shutdown()
    assert destination.read_text(encoding="utf-8").splitlines() == [
        "subject,age,sex,siteLabel,cohort",
        # A whole registry age loses its trailing .0, as the tables show it.
        "sub-01,40,M,Prisma,control",
        "sub-02,40.5,M,Ingenia,SCI_P",
        "sub-03,,O,Prisma,SCI_nNP",
    ]
    record = ctx.state["inputProjections"][0]
    fields = registry_fields_identity(store.path)
    assert record["kind"] == "braincharts"
    assert record["registryFieldsIdentity"] == fields
    payload = {"externalInputs": {"registryFields": fields}}
    WorkflowManager._validate_projection_launch_binding(
        "braincharts", payload, [record]
    )
    changed = {"externalInputs": {"registryFields": {**fields, "sha256": "0" * 64}}}
    with pytest.raises(ValueError, match="registry changed"):
        WorkflowManager._validate_projection_launch_binding(
            "braincharts", changed, [record]
        )


def test_preparing_the_stage_writes_its_projection_once(tmp_path: Path) -> None:
    RegistryStore(str(tmp_path)).upsert(
        {
            "subjectId": "sub-01",
            "age": 33,
            "sex": "F",
            "sourceCohortLabel": "CTRL",
            "ais": None,
            "tSinceSci": None,
        }
    )
    ctx = _context(tmp_path, ("sub-01",))
    destination = tmp_path / "run" / "inputs" / "braincharts-metadata.csv"
    ctx.effective_cfg = {
        "_supraspinaRuntime": {"brainchartsMetadataFile": str(destination)}
    }
    manager = WorkflowManager(_Emitter())
    try:
        manager._prepare_inputs(ctx, "braincharts")
        manager._prepare_inputs(ctx, "braincharts")
        snapshot = manager._input_projection_snapshot(ctx, "braincharts")
    finally:
        manager.shutdown()
    assert destination.is_file()
    assert len(ctx.state["inputProjections"]) == 1
    assert snapshot[0]["consumedSha256"] == snapshot[0]["outputSha256"]


def test_the_projection_refuses_an_unresolved_role(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Registry:
        def __init__(self, _root: str) -> None:
            pass

        def list(self, _cfg: dict[str, Any]) -> list[dict[str, Any]]:
            return [
                {"subjectId": "sub-01", "cohortRole": "ambiguous", "age": 1, "sex": "F"}
            ]

    monkeypatch.setattr(runtime, "RegistryStore", _Registry)
    manager = WorkflowManager(_Emitter())
    try:
        with pytest.raises(ValueError, match="registry role of sub-01"):
            manager._braincharts_projection(
                _context(tmp_path, ("sub-01",)), str(tmp_path / "x.csv")
            )
    finally:
        manager.shutdown()


def test_the_runtime_overlay_names_the_run_scoped_inputs(tmp_path: Path) -> None:
    effective = runtime_cfg({"paths": {}}, _cohort(), "run-abc", str(tmp_path))
    overlay = effective["_supraspinaRuntime"]
    run_dir = tmp_path / ".supraspina" / "runs" / "run-abc"
    assert overlay["brainchartsMetadataFile"] == str(
        run_dir / "inputs" / "braincharts-metadata.csv"
    )
    assert overlay["brainchartsWorkDir"] == str(run_dir / "work" / "braincharts")


def test_an_appended_consumer_reads_the_producer_detector_edge() -> None:
    assert uses_detector_edge("features", "braincharts", None)
    assert not uses_detector_edge("enigma", "outliers", None)
    assert not uses_detector_edge("recon", "features", "sub-01")


def test_a_features_receipt_without_a_braincharts_edge_stays_ready(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A features receipt that binds no BrainCharts edge feeds the stage."""
    done = {"state": "done", "detail": "", "artifacts": []}
    monkeypatch.setattr(runtime, "detector_evidence", lambda *_args: dict(done))
    monkeypatch.setattr(runtime, "edge_evidence", lambda *_args: dict(done))
    monkeypatch.setattr(runtime, "enrich_evidence", lambda _key, value, *_a: value)
    ctx = _context(tmp_path, ("sub-01",))
    ctx.cfg = ctx.effective_cfg = {
        "paths": {"projectRoot": str(tmp_path), "outputDir": str(tmp_path / "out")},
        "steps": {"features": {"enabled": True, "params": {}}},
        "_supraspinaRuntime": {},
    }
    ctx.state.update({"receipts": [], "environmentEvidence": {}, "nodes": []})
    manager = WorkflowManager(_Emitter())
    try:
        signature, payload = manager._expected(ctx, "features", None)
        receipt = provenance.make_receipt(
            signature,
            payload,
            done,
            run_id="run-aaaaaaaa",
            job_id="#1",
            committed_at_ms=1,
            edge_evidence={"age": done},
        )
        ctx.store.put_receipt(receipt)
        assert manager._producer_ready(ctx, "features", "braincharts", None) == (
            True,
            "",
        )
        assert manager._producer_ready(ctx, "features", "age", None) == (True, "")
    finally:
        manager.shutdown()


@pytest.mark.parametrize("stored_edges", [{"age": "same"}, {}])
def test_a_features_receipt_with_changed_evidence_is_not_ready_for_braincharts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stored_edges: dict[str, str]
) -> None:
    """The edge fallback never passes once the detector evidence has changed."""

    def done(sha256: str) -> dict[str, Any]:
        return {
            "state": "done",
            "detail": "",
            "artifacts": [{"path": "/out/features.csv", "sha256": sha256}],
        }

    recorded, current = done("a" * 64), done("b" * 64)
    monkeypatch.setattr(runtime, "detector_evidence", lambda *_args: dict(current))
    monkeypatch.setattr(runtime, "edge_evidence", lambda *_args: dict(current))
    monkeypatch.setattr(runtime, "enrich_evidence", lambda _key, value, *_a: value)
    ctx = _context(tmp_path, ("sub-01",))
    ctx.cfg = ctx.effective_cfg = {
        "paths": {"projectRoot": str(tmp_path), "outputDir": str(tmp_path / "out")},
        "steps": {"features": {"enabled": True, "params": {}}},
        "_supraspinaRuntime": {},
    }
    ctx.state.update({"receipts": [], "environmentEvidence": {}, "nodes": []})
    manager = WorkflowManager(_Emitter())
    try:
        signature, payload = manager._expected(ctx, "features", None)
        receipt = provenance.make_receipt(
            signature,
            payload,
            recorded,
            run_id="run-aaaaaaaa",
            job_id="#1",
            committed_at_ms=1,
            edge_evidence={key: recorded for key in stored_edges},
        )
        ctx.store.put_receipt(receipt)
        assert manager._producer_ready(ctx, "features", "braincharts", None) == (
            False,
            "Restore current features->braincharts required artifacts.",
        )
    finally:
        manager.shutdown()


def test_the_adapter_runs_inside_the_runtime_lease(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entered: list[dict[str, Any]] = []

    @contextmanager
    def lease(cfg: dict[str, Any]) -> Iterator[None]:
        entered.append(cfg)
        yield

    monkeypatch.setattr(braincharts_runtime, "execution_lease", lease)
    cfg = _cfg(tmp_path)
    with _ADAPTER.execution_lease(cfg, None):  # type: ignore[attr-defined]
        assert entered == [cfg]


def test_the_payload_of_every_other_step_ignores_the_new_step_settings(
    tmp_path: Path,
) -> None:
    """``steps.braincharts`` binds only into its own step's configuration digest."""
    base = _cfg(tmp_path)
    base["steps"] = {
        key: {"enabled": True, "params": {}}
        for key in STEP_BY_KEY
        if key != "braincharts"
    }
    with_braincharts = copy.deepcopy(base)
    with_braincharts["steps"]["braincharts"] = {"enabled": False, "params": {}}
    for key in STEP_BY_KEY:
        if key == "braincharts":
            continue
        assert stable_digest(
            provenance._scientific_configuration(base, key)
        ) == stable_digest(
            provenance._scientific_configuration(with_braincharts, key)
        ), key
