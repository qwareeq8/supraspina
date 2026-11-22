"""Tests for the PyBrainAge prediction adapter."""

from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from supraspina_sidecar import resources
from supraspina_sidecar.adapters import pybrainage, tools
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.adapters.pybrainage import PyBrainAgeAdapter
from tests.test_schema import default_config


def _load_prediction_resource_with_stubs(
    monkeypatch: Any,
) -> ModuleType:
    monkeypatch.setitem(sys.modules, "numpy", ModuleType("numpy"))
    monkeypatch.setitem(sys.modules, "pandas", ModuleType("pandas"))
    path = resources.pybrainage_dir() / "predict.py"
    spec = importlib.util.spec_from_file_location("predict_resource_bounds_test", path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cfg_with_paths(output_dir: str) -> dict[str, Any]:
    """Return a config with concrete output/model/scaler/env paths."""
    cfg = default_config()
    cfg["paths"]["outputDir"] = output_dir
    cfg["pybrain"] = {
        "modelPath": "/models/ExtraTreesModel",
        "scalerPath": "/models/scaler.pkl",
    }
    cfg["steps"]["pybrainage"] = {
        "enabled": True,
        "params": {
            "pythonExecutable": "/envs/pybrainage/bin/python",
            "modelPath": "${pybrain.modelPath}",
            "scalerPath": "${pybrain.scalerPath}",
            "rowFallback": True,
        },
    }
    return cfg


def test_registered_under_key() -> None:
    assert isinstance(ADAPTERS["pybrainage"], PyBrainAgeAdapter)
    adapter = ADAPTERS["pybrainage"]
    assert adapter.key == "pybrainage"
    assert adapter.advances == ("pba",)


def test_param_schema_keys() -> None:
    schema = PyBrainAgeAdapter().param_schema()
    assert set(schema) == {
        "pythonExecutable",
        "modelPath",
        "scalerPath",
        "rowFallback",
    }
    assert schema["rowFallback"]["default"] is True
    assert schema["modelPath"]["default"] == "${pybrain.modelPath}"


def test_build_command_resolves_argv() -> None:
    adapter = PyBrainAgeAdapter()
    cfg = cfg_with_paths("/out/run")
    argv = adapter.build_command(cfg, None)
    generation = "/out/run/.pybrainage/current"
    assert argv == [
        f"{generation}/envs/pybrainage/bin/python",
        str(resources.pybrainage_dir() / "predict.py"),
        "--features",
        "/out/run/features/subject_features.csv",
        "--template",
        str(resources.features_dir() / "rois_input_template.txt"),
        "--model",
        f"{generation}/pybrainage/v3/software/ExtraTreesModel",
        "--scaler",
        f"{generation}/pybrainage/v3/software/scaler.pkl",
        "--output",
        "/out/run/pybrainage/predicted_results.csv",
        "--row-fallback",
    ]


def test_configured_artifact_overrides_cannot_replace_managed_model() -> None:
    cfg = cfg_with_paths("/out/run")
    del cfg["steps"]["pybrainage"]["params"]["modelPath"]
    del cfg["steps"]["pybrainage"]["params"]["scalerPath"]

    argv = PyBrainAgeAdapter().build_command(cfg, None)

    cache = Path(pybrainage.model_root(cfg)) / "software"
    assert argv[argv.index("--model") + 1] == str(
        cache / pybrainage.PYBRAINAGE_MODEL_FILE
    )
    assert argv[argv.index("--scaler") + 1] == str(
        cache / pybrainage.PYBRAINAGE_SCALER_FILE
    )


def test_explicit_blank_artifact_paths_select_provisioned_cache() -> None:
    cfg = cfg_with_paths("/out/run")
    cfg["steps"]["pybrainage"]["params"]["modelPath"] = ""
    cfg["steps"]["pybrainage"]["params"]["scalerPath"] = ""

    argv = PyBrainAgeAdapter().build_command(cfg, None)
    cache = Path(pybrainage.model_root(cfg)) / "software"

    assert argv[argv.index("--model") + 1] == str(
        cache / pybrainage.PYBRAINAGE_MODEL_FILE
    )
    assert argv[argv.index("--scaler") + 1] == str(
        cache / pybrainage.PYBRAINAGE_SCALER_FILE
    )


def test_build_command_omits_row_fallback_when_disabled() -> None:
    adapter = PyBrainAgeAdapter()
    cfg = cfg_with_paths("/out/run")
    cfg["steps"]["pybrainage"]["params"]["rowFallback"] = False
    argv = adapter.build_command(cfg, None)
    assert "--row-fallback" not in argv


def test_build_command_rejects_general_python_fallback() -> None:
    adapter = PyBrainAgeAdapter()
    cfg = cfg_with_paths("/out/run")
    cfg["steps"]["pybrainage"]["params"]["pythonExecutable"] = ""
    cfg["tools"]["pythonExecutable"] = "/envs/orchestration/bin/python"
    argv = adapter.build_command(cfg, None)
    assert argv[0] == pybrainage.env_python(cfg)


def test_build_command_has_no_bare_python_fallback() -> None:
    adapter = PyBrainAgeAdapter()
    cfg = cfg_with_paths("/out/run")
    cfg["steps"]["pybrainage"]["params"]["pythonExecutable"] = ""
    cfg["tools"]["pythonExecutable"] = ""
    argv = adapter.build_command(cfg, None)
    assert argv[0] == pybrainage.env_python(cfg)


def _write_predicted(
    path: Path,
    *,
    with_brainpad: bool,
    subject_ids: tuple[str, ...] = ("sub-01",),
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = ["ID", "Age", "BrainAge", "BrainPAD"]
    if not with_brainpad:
        header = ["ID", "Age", "BrainAge"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        for subject_id in subject_ids:
            row = [subject_id, "42.0", "45.0"]
            if with_brainpad:
                row.append("3.0")
            writer.writerow(row)


def test_detect_pending_when_absent(tmp_path: Path) -> None:
    adapter = PyBrainAgeAdapter()
    cfg = cfg_with_paths(str(tmp_path))
    status = adapter.detect(cfg, None)
    assert status.state == "pending"
    assert status.artifacts == []


def test_detect_done_when_brainpad_present(tmp_path: Path) -> None:
    adapter = PyBrainAgeAdapter()
    cfg = cfg_with_paths(str(tmp_path))
    out = tmp_path / "pybrainage" / "predicted_results.csv"
    _write_predicted(out, with_brainpad=True)
    status = adapter.detect(cfg, None)
    assert status.state == "done"
    assert status.artifacts == [str(out)]


def test_detect_partial_when_brainpad_missing(tmp_path: Path) -> None:
    adapter = PyBrainAgeAdapter()
    cfg = cfg_with_paths(str(tmp_path))
    out = tmp_path / "pybrainage" / "predicted_results.csv"
    _write_predicted(out, with_brainpad=False)
    status = adapter.detect(cfg, None)
    assert status.state == "partial"


def test_detect_requires_exact_ordered_prediction_schema(tmp_path: Path) -> None:
    adapter = PyBrainAgeAdapter()
    cfg = cfg_with_paths(str(tmp_path))
    out = tmp_path / "pybrainage" / "predicted_results.csv"
    out.parent.mkdir(parents=True)
    out.write_text(
        "ID,Age,BrainPAD,BrainAge,unexpected\nsub-01,42,3,45,value\n",
        encoding="utf-8",
    )

    status = adapter.detect(cfg, None)

    assert status.state == "partial"
    assert status.detail == (
        "Use this exact predicted_results.csv schema: ID,Age,BrainAge,BrainPAD"
    )


def test_detect_requires_exact_run_cohort_membership(tmp_path: Path) -> None:
    adapter = PyBrainAgeAdapter()
    cfg = cfg_with_paths(str(tmp_path))
    cfg["_supraspinaRuntime"] = {"reconstructionViewSubjectIds": ["sub-01", "sub-02"]}
    out = tmp_path / "pybrainage" / "predicted_results.csv"
    _write_predicted(
        out,
        with_brainpad=True,
        subject_ids=("sub-01", "sub-extra"),
    )

    status = adapter.detect(cfg, None)

    assert status.state == "partial"
    assert status.detail == (
        "Reconcile the predicted_results.csv cohort: 1 missing, 1 extra, 0 duplicate IDs."
    )


def test_detect_accepts_exact_run_cohort_membership(tmp_path: Path) -> None:
    adapter = PyBrainAgeAdapter()
    cfg = cfg_with_paths(str(tmp_path))
    cfg["_supraspinaRuntime"] = {"reconstructionViewSubjectIds": ["sub-01", "sub-02"]}
    out = tmp_path / "pybrainage" / "predicted_results.csv"
    _write_predicted(
        out,
        with_brainpad=True,
        subject_ids=("sub-02", "sub-01"),
    )

    status = adapter.detect(cfg, None)

    assert status.state == "done"
    assert status.detail == (
        "Confirm predicted_results.csv uses the exact schema and contains 2 expected subjects."
    )


@pytest.mark.parametrize(
    ("row", "detail"),
    [
        ("sub-01,nan,45,nan", "finite Age, BrainAge, and BrainPAD"),
        ("sub-01,42,45,-3", "BrainPAD = BrainAge - Age"),
        ("sub-01,forty-two,45,3", "numeric Age, BrainAge, and BrainPAD"),
    ],
)
def test_detect_rejects_nonfinite_or_inconsistent_predictions(
    tmp_path: Path, row: str, detail: str
) -> None:
    cfg = cfg_with_paths(str(tmp_path))
    out = tmp_path / "pybrainage" / "predicted_results.csv"
    out.parent.mkdir(parents=True)
    out.write_text(f"ID,Age,BrainAge,BrainPAD\n{row}\n", encoding="utf-8")

    status = PyBrainAgeAdapter().detect(cfg, None)

    assert status.state == "partial"
    assert detail in status.detail


def test_detect_reports_subjects_without_a_chronological_age(tmp_path: Path) -> None:
    cfg = cfg_with_paths(str(tmp_path))
    out = tmp_path / "pybrainage" / "predicted_results.csv"
    out.parent.mkdir(parents=True)
    out.write_text(
        "ID,Age,BrainAge,BrainPAD\nsub-01,42,45,3\nsub-02,,47,\nsub-03,,48,\n",
        encoding="utf-8",
    )

    status = PyBrainAgeAdapter().detect(cfg, None)

    assert status.state == "done"
    assert status.detail == (
        "Confirm predicted_results.csv uses the exact schema. Brain-PAD is "
        "empty for 2 subject(s) without a chronological age: sub-02, sub-03."
    )


def test_detect_bounds_the_listed_subjects_without_an_age(tmp_path: Path) -> None:
    cfg = cfg_with_paths(str(tmp_path))
    out = tmp_path / "pybrainage" / "predicted_results.csv"
    out.parent.mkdir(parents=True)
    rows = "".join(f"sub-{index:03d},,45,\n" for index in range(21))
    out.write_text(f"ID,Age,BrainAge,BrainPAD\n{rows}", encoding="utf-8")

    status = PyBrainAgeAdapter().detect(cfg, None)

    assert status.state == "done"
    assert "21 subject(s)" in status.detail
    assert status.detail.count("sub-") == 20
    assert status.detail.endswith("sub-019, ...")


def test_detect_rejects_a_half_empty_age_and_brain_pad_pair(tmp_path: Path) -> None:
    cfg = cfg_with_paths(str(tmp_path))
    out = tmp_path / "pybrainage" / "predicted_results.csv"
    out.parent.mkdir(parents=True)
    out.write_text("ID,Age,BrainAge,BrainPAD\nsub-01,42,45,\n", encoding="utf-8")

    status = PyBrainAgeAdapter().detect(cfg, None)

    assert status.state == "partial"
    assert "Leave Age and BrainPAD both empty" in status.detail
    assert "sub-01" in status.detail


def test_parse_failure_recognizes_scaler_mismatch() -> None:
    adapter = PyBrainAgeAdapter()
    stderr = (
        "ValueError: Check whether the scaler is loaded correctly and the data "
        "use the required format after scaler application fails."
    )
    failure = adapter.parse_failure(1, "", stderr)
    assert failure is not None
    assert failure.tag == "scaler_mismatch"


def test_parse_failure_recognizes_missing_input() -> None:
    adapter = PyBrainAgeAdapter()
    stderr = "FileNotFoundError: No such file or directory: 'subject_features.csv'"
    failure = adapter.parse_failure(2, "", stderr)
    assert failure is not None
    assert failure.tag == "missing_input"


def test_parse_failure_none_on_success() -> None:
    assert PyBrainAgeAdapter().parse_failure(0, "", "") is None


def _prediction_interpreter() -> str:
    """Return an interpreter that can execute predict.py, or skip the test."""
    python = os.environ.get("SUPRASPINA_BRAINPAD_TEST_PYTHON", sys.executable)
    probe = subprocess.run(  # noqa: S603 - Probe the configured interpreter.
        [python, "-c", "import numpy, pandas"],
        check=False,
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        pytest.skip("Provide a PyBrainAge interpreter with numpy and pandas.")
    return python


# Script that predicts with a stubbed scaler and model, so the reviewed ``run``
# path executes without the provisioned Zenodo pickles.
_PREDICT_WITH_STUBS = """
import argparse
import csv
import importlib.util
import sys

import numpy as np

spec = importlib.util.spec_from_file_location("predict_resource", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules["predict_resource"] = module
spec.loader.exec_module(module)

header = module.expected_feature_header(sys.argv[2])
with open(sys.argv[3], "w", newline="", encoding="utf-8") as handle:
    writer = csv.writer(handle)
    writer.writerow(header)
    writer.writerow(["sub-01", "40"] + ["1"] * (len(header) - 2))
    writer.writerow(["sub-02", sys.argv[5]] + ["2"] * (len(header) - 2))


class Stub:
    def transform(self, data):
        return np.asarray(data, dtype=float)

    def predict(self, data):
        return np.full(len(data), 50.0)


module._load_pickle = lambda path: Stub()
module.run(
    argparse.Namespace(
        features=sys.argv[3],
        template=sys.argv[2],
        model="model",
        scaler="scaler",
        output=sys.argv[4],
        row_fallback=False,
    )
)
"""


def _run_prediction_with_stubs(tmp_path: Path, second_age: str) -> Any:
    python = _prediction_interpreter()
    return subprocess.run(  # noqa: S603 - Execute the reviewed resource.
        [
            python,
            "-c",
            _PREDICT_WITH_STUBS,
            str(resources.pybrainage_dir() / "predict.py"),
            str(resources.features_dir() / "rois_input_template.txt"),
            str(tmp_path / "features.csv"),
            str(tmp_path / "predicted_results.csv"),
            second_age,
        ],
        check=False,
        capture_output=True,
        text=True,
    )


def test_prediction_resource_leaves_brain_pad_empty_without_an_age(
    tmp_path: Path,
) -> None:
    completed = _run_prediction_with_stubs(tmp_path, "")

    assert completed.returncode == 0, completed.stderr
    with (tmp_path / "predicted_results.csv").open(
        newline="", encoding="utf-8"
    ) as handle:
        rows = {row["ID"]: row for row in csv.DictReader(handle)}
    assert float(rows["sub-01"]["Age"]) == 40.0
    assert float(rows["sub-01"]["BrainPAD"]) == 10.0
    assert float(rows["sub-02"]["BrainAge"]) == 50.0
    assert rows["sub-02"]["Age"] == ""
    assert rows["sub-02"]["BrainPAD"] == ""
    assert (
        "WARNING: No chronological age for 1 subject(s): sub-02; Brain-PAD is "
        "left empty for them." in completed.stderr
    )


def test_prediction_resource_still_requires_a_finite_supplied_age(
    tmp_path: Path,
) -> None:
    completed = _run_prediction_with_stubs(tmp_path, "inf")

    assert completed.returncode != 0
    assert "Provide finite chronological Age values in years." in completed.stderr


def test_prediction_resource_bounds_feature_rows(tmp_path: Path) -> None:
    python = _prediction_interpreter()
    features = tmp_path / "features.csv"
    features.write_text(
        "ID,Age,feature\n"
        + "".join(f"sub-{index:04d},40,1\n" for index in range(5001)),
        encoding="utf-8",
    )

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [
            python,
            str(resources.pybrainage_dir() / "predict.py"),
            "--features",
            str(features),
            "--template",
            str(resources.features_dir() / "rois_input_template.txt"),
            "--model",
            str(tmp_path / "missing-model"),
            "--scaler",
            str(tmp_path / "missing-scaler"),
            "--output",
            str(tmp_path / "predictions.csv"),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "within 5000 rows" in completed.stderr


def test_prediction_resource_rejects_oversize_before_dataframe(
    tmp_path: Path, monkeypatch: Any
) -> None:
    module = _load_prediction_resource_with_stubs(monkeypatch)
    features = tmp_path / "features.csv"
    features.write_text("ID,Age,feature\nsub-01,40,1\n", encoding="utf-8")
    monkeypatch.setattr(module, "MAX_FEATURE_BYTES", 4)

    with pytest.raises(ValueError, match="within 64 MiB"):
        module._read_features(str(features))


def test_provision_builds_plan_without_side_effects(tmp_path: Path) -> None:
    cfg = cfg_with_paths(str(tmp_path))
    events: list[tuple[str, float]] = []

    def progress(message: str, fraction: float) -> None:
        events.append((message, fraction))

    plan = pybrainage.provision(cfg, progress)

    # Create nothing on disk during planning.
    assert not (tmp_path / ".pybrainage").exists()
    assert events[0][1] == 0.0
    assert events[-1][1] == 1.0

    names = [step["name"] for step in plan["steps"]]
    assert names == [
        "check_micromamba",
        "create_env",
        "install_pip_deps",
        "probe_runtime",
        "fetch_model",
        "verify_model",
        "validate_pickle",
    ]

    manager = plan["steps"][0]["command"]
    assert manager == [pybrainage.micromamba_binary(), "--version"]

    create = plan["steps"][1]["command"]
    assert Path(create[0]).name == "micromamba"
    assert create[1:3] == ["create", "-y"]
    assert create[create.index("--root-prefix") + 1] == pybrainage.mamba_root_prefix(
        cfg
    )
    assert create[create.index("--file") + 1] == pybrainage.environment_lock_path(cfg)
    assert not any(part.startswith("python=") for part in create)
    assert "-c" not in create

    # Install only the hash-locked cliffs-delta wheel into the same environment.
    pip_deps = plan["steps"][2]["command"]
    assert pip_deps[1:4] == ["-I", "-m", "pip"]
    assert "--isolated" in pip_deps
    assert "--require-hashes" in pip_deps
    assert "--only-binary=:all:" in pip_deps
    assert pip_deps[pip_deps.index("--cache-dir") + 1] == pybrainage.pip_cache_dir(cfg)
    assert pip_deps[pip_deps.index("--requirement") + 1] == pybrainage.pip_lock_path(
        cfg
    )

    probe = plan["steps"][3]["command"]
    assert probe[:4] == [pybrainage.env_python(cfg), "-I", "-B", "-c"]

    fetch = plan["steps"][4]["command"]
    assert pybrainage.PYBRAINAGE_ZENODO_URL in fetch

    verify = plan["steps"][5]["command"]
    assert verify[0] == sys.executable
    assert verify[1] == "-c"
    assert verify[-1] == pybrainage.PYBRAINAGE_ZENODO_SHA256

    assert plan["zenodo"]["doi"] == "10.5281/zenodo.10406573"
    assert plan["zenodo"]["bytes"] == 108_063_062
    assert plan["locks"] == {
        "environment": {
            "path": pybrainage.environment_lock_path(cfg),
            "sha256": pybrainage.PYBRAINAGE_ENV_LOCK_SHA256,
        },
        "pip": {
            "path": pybrainage.pip_lock_path(cfg),
            "sha256": pybrainage.PYBRAINAGE_PIP_LOCK_SHA256,
        },
    }


def test_committed_locks_bind_exact_artifacts_and_hashed_pip_wheel() -> None:
    lock_root = Path(pybrainage.__file__).resolve().parents[1] / "pybrainage_locks"
    environment = (lock_root / pybrainage.PYBRAINAGE_ENV_LOCK_NAME).read_bytes()
    pip_lock = (lock_root / pybrainage.PYBRAINAGE_PIP_LOCK_NAME).read_bytes()

    assert hashlib.sha256(environment).hexdigest() == (
        pybrainage.PYBRAINAGE_ENV_LOCK_SHA256
    )
    lines = environment.decode("ascii").splitlines()
    assert lines[0] == "@EXPLICIT"
    assert len(lines) == 179
    for line in lines[1:]:
        url, separator, digest = line.rpartition("#")
        assert separator == "#"
        assert url.startswith("https://conda.anaconda.org/conda-forge/")
        assert "/linux-64/" in url or "/noarch/" in url
        assert len(digest) == 64
        assert all(char in "0123456789abcdef" for char in digest)
        assert url.endswith((".conda", ".tar.bz2"))
    assert hashlib.sha256(pip_lock).hexdigest() == pybrainage.PYBRAINAGE_PIP_LOCK_SHA256
    assert pip_lock.decode("ascii") == (
        "cliffs-delta==1.0.0 "
        "--hash=sha256:2ec087e8254861204aab79e222b2e863a79f3d6f35d69e14f8b188fb6c5b048f\n"
    )


def test_provision_environment_overrides_ambient_roots_and_caches(
    tmp_path: Path, monkeypatch: Any
) -> None:
    monkeypatch.setenv("MAMBA_ROOT_PREFIX", "/ambient/mamba")
    monkeypatch.setenv("CONDA_PKGS_DIRS", "/ambient/conda-pkgs")
    monkeypatch.setenv("PIP_CACHE_DIR", "/ambient/pip")
    cfg = cfg_with_paths(str(tmp_path))

    environment = pybrainage.provision_environment(cfg)

    assert environment["MAMBA_ROOT_PREFIX"] == str(
        tmp_path / ".pybrainage" / "mamba-root"
    )
    assert environment["CONDA_PKGS_DIRS"] == str(
        tmp_path / ".pybrainage" / "mamba-root" / "pkgs"
    )
    assert environment["PIP_CACHE_DIR"] == str(tmp_path / ".pybrainage" / "pip-cache")
    assert not any("/ambient" in value for value in environment.values())


def test_prepare_provision_storage_materializes_and_repairs_reviewed_locks(
    tmp_path: Path,
) -> None:
    cfg = cfg_with_paths(str(tmp_path))

    pybrainage.prepare_provision_storage(cfg)

    environment_lock = Path(pybrainage.environment_lock_path(cfg))
    pip_lock = Path(pybrainage.pip_lock_path(cfg))
    assert hashlib.sha256(environment_lock.read_bytes()).hexdigest() == (
        pybrainage.PYBRAINAGE_ENV_LOCK_SHA256
    )
    assert hashlib.sha256(pip_lock.read_bytes()).hexdigest() == (
        pybrainage.PYBRAINAGE_PIP_LOCK_SHA256
    )
    assert (tmp_path / ".pybrainage" / "mamba-root" / "pkgs").is_dir()
    assert (tmp_path / ".pybrainage" / "pip-cache").is_dir()

    environment_lock.write_text("changed\n", encoding="utf-8")
    pybrainage.prepare_provision_storage(cfg)
    assert hashlib.sha256(environment_lock.read_bytes()).hexdigest() == (
        pybrainage.PYBRAINAGE_ENV_LOCK_SHA256
    )


def test_dependency_probes_use_cleaned_temporary_caches_without_writing_output(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    output = tmp_path / "unsaved-draft-output"
    cfg = cfg_with_paths(str(output))
    selected = tmp_path / "reviewed-micromamba"
    selected.write_bytes(b"synthetic reviewed manager")
    selected.chmod(0o700)
    monkeypatch.setattr(pybrainage, "micromamba_binary", lambda: str(selected))
    monkeypatch.setattr(
        pybrainage,
        "micromamba_identity",
        lambda _candidate=None: (str(selected), pybrainage.MICROMAMBA_SHA256),
    )
    probe_roots: list[Path] = []

    def manager_runner(argv: list[str], **options: Any) -> tools.RunResult:
        assert argv[-1] == "--version"
        assert not output.exists()
        environment = options["env"]
        probe_roots.append(Path(environment["MAMBA_ROOT_PREFIX"]).parents[1])
        assert str(output) not in environment["MAMBA_ROOT_PREFIX"]
        return tools.RunResult(rc=0, stdout="2.7.0\n", stderr="")

    manager = pybrainage.probe_micromamba_version(cfg, runner=manager_runner)

    def runtime_runner(argv: list[str], **options: Any) -> tools.RunResult:
        assert argv[1:4] == ["-I", "-B", "-c"]
        assert not output.exists()
        environment = options["env"]
        probe_roots.append(Path(environment["MAMBA_ROOT_PREFIX"]).parents[1])
        assert str(output) not in environment["PIP_CACHE_DIR"]
        return tools.RunResult(
            rc=0,
            stdout=json.dumps(pybrainage.PYBRAINAGE_RUNTIME_VERSIONS),
            stderr="",
        )

    runtime, versions = pybrainage.probe_runtime_versions(
        cfg,
        runner=runtime_runner,
    )

    assert manager.rc == 0
    assert runtime.rc == 0
    assert versions == pybrainage.PYBRAINAGE_RUNTIME_VERSIONS
    assert not output.exists()
    assert probe_roots
    assert all(not path.exists() for path in probe_roots)


def test_micromamba_probe_rejects_unreviewed_bytes_before_execution(
    tmp_path: Path,
) -> None:
    cfg = cfg_with_paths(str(tmp_path / "draft-output"))
    selected = tmp_path / "micromamba"
    selected.write_bytes(b"not the reviewed micromamba")
    selected.chmod(0o700)
    calls = 0

    def runner(_argv: list[str], **_options: Any) -> tools.RunResult:
        nonlocal calls
        calls += 1
        return tools.RunResult(rc=0, stdout="2.7.0\n", stderr="")

    result = pybrainage.probe_micromamba_version(
        cfg,
        micromamba=str(selected),
        runner=runner,
    )

    assert result.rc == 1
    assert "reviewed SHA-256" in result.stderr
    assert calls == 0
    assert not Path(cfg["paths"]["outputDir"]).exists()


def test_conda_metadata_digest_rejects_entry_overflow(tmp_path: Path) -> None:
    cfg = cfg_with_paths(str(tmp_path))
    metadata = Path(pybrainage.env_dir(cfg)) / "conda-meta"
    metadata.mkdir(parents=True)
    for index in range(pybrainage._MAX_CONDA_METADATA_ENTRIES + 1):
        (metadata / f"record-{index:04d}.json").write_text("{}\n", encoding="utf-8")

    with pytest.raises(OSError, match="entry limit"):
        pybrainage._conda_metadata_digest(cfg)


def test_conda_metadata_digest_accepts_a_large_committed_record(
    tmp_path: Path,
) -> None:
    """Keep the bound above the largest record the committed lock installs.

    ``qt-main-5.15.8-h5d23da1_6.json`` is about 5.6 MiB because a conda record
    lists every installed path, so a smaller bound rejected a valid environment.
    """
    cfg = cfg_with_paths(str(tmp_path))
    metadata = Path(pybrainage.env_dir(cfg)) / "conda-meta"
    metadata.mkdir(parents=True)
    large = metadata / "qt-main-5.15.8-h5d23da1_6.json"
    payload = 6 * 1024 * 1024
    large.write_text(" " * payload, encoding="utf-8")
    assert large.stat().st_size > 2 * 1024 * 1024
    assert large.stat().st_size < pybrainage._MAX_CONDA_RECORD_BYTES

    assert len(pybrainage._conda_metadata_digest(cfg)) == 64


def test_conda_metadata_digest_rejects_a_record_past_the_bound(
    tmp_path: Path,
) -> None:
    cfg = cfg_with_paths(str(tmp_path))
    metadata = Path(pybrainage.env_dir(cfg)) / "conda-meta"
    metadata.mkdir(parents=True)
    oversize = metadata / "oversize.json"
    oversize.write_text(
        " " * (pybrainage._MAX_CONDA_RECORD_BYTES + 1), encoding="utf-8"
    )

    with pytest.raises(OSError, match="within its size bound"):
        pybrainage._conda_metadata_digest(cfg)


def test_conda_metadata_digest_rejects_json_symlink(tmp_path: Path) -> None:
    cfg = cfg_with_paths(str(tmp_path))
    metadata = Path(pybrainage.env_dir(cfg)) / "conda-meta"
    metadata.mkdir(parents=True)
    target = metadata / "target"
    target.write_text("{}\n", encoding="utf-8")
    (metadata / "linked.json").symlink_to(target)

    with pytest.raises(OSError, match="regular conda package records"):
        pybrainage._conda_metadata_digest(cfg)


def test_provision_state_binds_runtime_tools_model_and_conda_metadata(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    cfg = cfg_with_paths(str(tmp_path))
    provision_root = Path(pybrainage.provision_root(cfg))
    generation = provision_root / "generations" / ("a" * 32)
    generation.mkdir(parents=True)
    (provision_root / "current").symlink_to(
        Path("generations") / generation.name, target_is_directory=True
    )
    env_metadata = Path(pybrainage.env_dir(cfg)) / "conda-meta"
    env_metadata.mkdir(parents=True)
    record = env_metadata / "python.json"
    record.write_text('{"name":"python","version":"3.7.12"}\n', encoding="utf-8")
    model_root = Path(pybrainage.model_root(cfg))
    software = model_root / "software"
    software.mkdir(parents=True)
    archive = model_root / pybrainage.PYBRAINAGE_ZENODO_ASSET
    archive.write_bytes(b"synthetic archive")
    (software / pybrainage.PYBRAINAGE_MODEL_FILE).write_bytes(b"model")
    (software / pybrainage.PYBRAINAGE_SCALER_FILE).write_bytes(b"scaler")
    micromamba = tmp_path / "micromamba"
    micromamba.write_bytes(b"reviewed micromamba")
    micromamba.chmod(0o700)
    micromamba_digest = hashlib.sha256(micromamba.read_bytes()).hexdigest()
    monkeypatch.setattr(pybrainage, "micromamba_binary", lambda: str(micromamba))
    monkeypatch.setattr(pybrainage, "MICROMAMBA_SHA256", micromamba_digest)
    monkeypatch.setattr(
        pybrainage,
        "PYBRAINAGE_ZENODO_SHA256",
        hashlib.sha256(archive.read_bytes()).hexdigest(),
    )

    result = pybrainage.record_provision_state(
        cfg, dict(pybrainage.PYBRAINAGE_RUNTIME_VERSIONS)
    )

    assert result.rc == 0
    state = json.loads(Path(pybrainage.provision_state_path(cfg)).read_text())
    assert state["generation"] == generation.name
    assert state["micromamba"]["sha256"] == micromamba_digest
    assert state["environment"]["lockSha256"] == (pybrainage.PYBRAINAGE_ENV_LOCK_SHA256)
    assert state["pip"] == {
        "cliffsDeltaVersion": "1.0.0",
        "lockSha256": pybrainage.PYBRAINAGE_PIP_LOCK_SHA256,
    }
    valid, digest = pybrainage.provision_state_status(cfg)
    assert valid is True
    assert digest == state["provenanceSha256"]

    mutations = (
        (micromamba, "micromamba bytes"),
        (archive, "model artifacts"),
        (software / pybrainage.PYBRAINAGE_MODEL_FILE, "model artifacts"),
        (software / pybrainage.PYBRAINAGE_SCALER_FILE, "model artifacts"),
        (record, "conda package metadata"),
    )
    for path, expected_detail in mutations:
        original = path.read_bytes()
        path.write_bytes(original + b"changed")
        valid, detail = pybrainage.provision_state_status(cfg)
        assert valid is False
        assert expected_detail in detail
        path.write_bytes(original)


def test_pinned_sha256_is_a_hex_digest() -> None:
    digest = pybrainage.PYBRAINAGE_ZENODO_SHA256
    assert len(digest) == 64
    assert all(char in "0123456789abcdef" for char in digest)


def test_provision_defaults_to_pinned_sha256(tmp_path: Path) -> None:
    # Pin the canonical Zenodo SHA-256 when no explicit digest is supplied.
    cfg = cfg_with_paths(str(tmp_path))
    plan = pybrainage.provision(cfg, lambda _message, _fraction: None)
    assert plan["zenodo"]["sha256"] == pybrainage.PYBRAINAGE_ZENODO_SHA256
    verify = next(s["command"] for s in plan["steps"] if s["name"] == "verify_model")
    assert any(pybrainage.PYBRAINAGE_ZENODO_SHA256 in part for part in verify)
