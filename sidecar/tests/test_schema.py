"""Tests for the Pydantic project-config validator."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import schema
from supraspina_sidecar.schema import validate_project_config


def default_config() -> dict[str, Any]:
    """Return a minimal valid project configuration mirroring the TS default."""
    return {
        "project": {"name": "SUPRASPINA Study", "createdAt": ""},
        "platform": {"mode": "linux", "pathStyle": "posix"},
        "paths": {
            "projectRoot": "/data/projects/supraspina",
            "rawdataDir": "${projectRoot}/rawdata",
            "derivativesDir": "${projectRoot}/derivatives",
            "outputDir": "${projectRoot}/outputs/run",
            "metadataDir": "${projectRoot}/metadata",
        },
        "tools": {
            "freesurferHome": "/usr/local/freesurfer/8.2.0",
            "freesurferLicense": "/data/freesurfer/license.txt",
            "pythonExecutable": "/usr/bin/python3",
            "rscriptExecutable": "/usr/bin/Rscript",
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "runtime": {
            "threads": 6,
            "queueSize": 2,
            "memoryWarningGB": 10,
            "dryRun": True,
            "resumeCompleted": True,
            "rerunIncomplete": False,
            "stopOnError": False,
            "continueIndependentAfterError": True,
        },
        "subjects": {
            "include": [],
            "exclude": [],
        },
        "steps": {
            "brainfov": {"enabled": False, "params": {"marginMm": 30}},
            "deface": {"enabled": False, "params": {}},
            "recon": {
                "enabled": True,
                "params": {
                    "backend": "freesurfer",
                    "fastsurferDevice": "auto",
                },
            },
            "enigma": {"enabled": True, "params": {}},
            "outliers": {"enabled": True, "params": {}},
            "features": {"enabled": True, "params": {"parcellation": "aparc.a2009s"}},
            "age": {"enabled": True, "params": {}},
            "pybrainage": {"enabled": True, "params": {}},
            "clinical": {"enabled": True, "params": {}},
            "brainpad": {"enabled": True, "params": {}},
            "aggregate": {"enabled": True, "params": {}},
            "final": {"enabled": True, "params": {}},
            "braincharts": {"enabled": False, "params": {}},
            "zstats": {"enabled": False, "params": {}},
        },
        "pybrain": {
            "modelPath": "/models/ExtraTreesModel",
            "scalerPath": "/models/scaler.pkl",
        },
        "outputs": {
            "rootDir": "${paths.outputDir}",
            "runDir": "${rootDir}",
            "manifestPath": "${rootDir}/manifest.json",
        },
        "provenance": {"configSha256": "", "runId": ""},
    }


def test_valid_config_passes() -> None:
    ok, errors, _warnings = validate_project_config(default_config())
    assert ok
    assert errors == []


def test_unknown_keys_fail_including_retired_settings() -> None:
    retired = default_config()
    retired["qa"] = {"iqiLow": 0.5, "iqiHigh": 4.0, "zThreshold": 2.698}
    ok, errors, _warnings = validate_project_config(retired)
    assert not ok
    assert any("qa" in error for error in errors)

    subjects = default_config()
    subjects["subjects"]["strictBids"] = False
    ok, errors, _warnings = validate_project_config(subjects)
    assert not ok
    assert any("strictBids" in error for error in errors)

    unknown = default_config()
    unknown["unexpected"] = True
    ok, errors, _warnings = validate_project_config(unknown)
    assert not ok
    assert any("unexpected" in error for error in errors)


def test_pipeline_steps_are_exact_and_complete() -> None:
    missing = default_config()
    del missing["steps"]["outliers"]
    ok, errors, _warnings = validate_project_config(missing)
    assert not ok
    assert any("missing pipeline steps: outliers" in error for error in errors)

    unknown = default_config()
    unknown["steps"]["invented"] = {"enabled": True, "params": {}}
    ok, errors, _warnings = validate_project_config(unknown)
    assert not ok
    assert any("unknown pipeline steps: invented" in error for error in errors)


def test_negative_outlier_threshold_fails() -> None:
    cfg = default_config()
    cfg["steps"]["outliers"]["params"]["zThreshold"] = -0.001

    ok, errors, _warnings = validate_project_config(cfg)

    assert not ok
    assert any("greater than or equal to 0" in error for error in errors)


@pytest.mark.parametrize(
    ("step", "name", "value", "fragment"),
    [
        ("brainfov", "marginMm", 14, "integer from 15 through 60"),
        ("recon", "backend", "other", "freesurfer, fastsurfer, auto"),
        ("recon", "fastsurferDevice", "metal", "auto, cpu, cuda"),
    ],
)
def test_new_subject_preparation_and_backend_constraints_match_renderer(
    step: str,
    name: str,
    value: object,
    fragment: str,
) -> None:
    cfg = default_config()
    cfg["steps"].setdefault(step, {"enabled": True, "params": {}})
    cfg["steps"][step]["params"][name] = value

    ok, errors, _warnings = validate_project_config(cfg)

    assert not ok
    assert any(fragment in error for error in errors)


def test_missing_section_fails() -> None:
    cfg = default_config()
    del cfg["tools"]
    ok, errors, _warnings = validate_project_config(cfg)
    assert not ok
    assert any("tools" in e for e in errors)


def test_out_of_range_threads_fails() -> None:
    cfg = default_config()
    cfg["runtime"]["threads"] = 999
    ok, _errors, _warnings = validate_project_config(cfg)
    assert not ok


def test_non_destrieux_parcellation_advises() -> None:
    cfg = default_config()
    cfg["steps"]["features"]["params"]["parcellation"] = "aparc.DKTatlas"
    ok, _errors, warnings = validate_project_config(cfg)
    assert ok
    assert any("aparc.a2009s" in w for w in warnings)


def test_empty_freesurfer_home_advises() -> None:
    cfg = copy.deepcopy(default_config())
    cfg["tools"]["freesurferHome"] = ""
    _ok, _errors, warnings = validate_project_config(cfg)
    assert any("FreeSurfer folder" in w for w in warnings)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("subjectGlob", "../sub-*"),
        ("subjectGlob", "/absolute"),
        ("t1Pattern", "anat/*_T1w.nii.gz"),
        ("t1Pattern", "..\\*_T1w.nii.gz"),
    ],
)
def test_unsafe_discovery_glob_fails(name: str, value: str) -> None:
    cfg = default_config()
    cfg["patterns"][name] = value
    ok, errors, _warnings = validate_project_config(cfg)
    assert not ok
    assert any(f"patterns.{name}" in error for error in errors)


def test_subject_ids_are_safe_unique_and_overlap_is_allowed() -> None:
    unsafe = default_config()
    unsafe["subjects"]["include"] = ["sub-01", "../sub-02", "sub-01"]
    ok, errors, _warnings = validate_project_config(unsafe)
    assert not ok
    assert any("safe single-segment subject ID" in error for error in errors)
    assert any(
        "duplicate subject IDs from subjects.include: sub-01" in error
        for error in errors
    )

    overlap = default_config()
    overlap["subjects"]["include"] = ["sub-01"]
    overlap["subjects"]["exclude"] = ["sub-01"]
    ok, errors, _warnings = validate_project_config(overlap)
    assert ok
    assert errors == []


def test_unresolved_and_cyclic_path_templates_fail() -> None:
    unresolved = default_config()
    unresolved["paths"]["outputDir"] = "${paths.notConfigured}/outputs"
    ok, errors, _warnings = validate_project_config(unresolved)
    assert not ok
    assert any(
        "paths.outputDir" in error and "unresolved or cyclic" in error
        for error in errors
    )

    cyclic = default_config()
    cyclic["outputs"]["rootDir"] = "${outputs.runDir}"
    cyclic["outputs"]["runDir"] = "${outputs.rootDir}"
    ok, errors, _warnings = validate_project_config(cyclic)
    assert not ok
    assert any(
        "outputs." in error and "unresolved or cyclic" in error for error in errors
    )


@pytest.mark.parametrize(
    ("rawdata_dir", "derivatives_dir", "output_dir"),
    [
        (
            "/data/BIDS/study",
            "/data/BIDS/study/derivatives",
            "/data/projects/supraspina/outputs/run",
        ),
        (
            "/data/projects/supraspina/derivatives/rawdata",
            "/data/projects/supraspina/derivatives",
            "/data/projects/supraspina/outputs/run",
        ),
        (
            "/data/BIDS/study",
            "/data/projects/supraspina/derivatives",
            "/data/BIDS/study/outputs/run",
        ),
    ],
)
def test_writable_roots_must_not_overlap_raw_bids(
    rawdata_dir: str,
    derivatives_dir: str,
    output_dir: str,
) -> None:
    cfg = default_config()
    cfg["paths"]["rawdataDir"] = rawdata_dir
    cfg["paths"]["derivativesDir"] = derivatives_dir
    cfg["paths"]["outputDir"] = output_dir

    ok, errors, _warnings = validate_project_config(cfg)

    assert not ok
    assert any("separate from paths.rawdataDir" in error for error in errors)


def test_writable_root_overlap_is_windows_case_insensitive_but_boundary_aware() -> None:
    overlap = default_config()
    overlap["platform"]["pathStyle"] = "windows"
    overlap["paths"]["rawdataDir"] = r"D:\BIDS\Study"
    overlap["paths"]["derivativesDir"] = "d:/bids/study/DERIVATIVES"
    ok, errors, _warnings = validate_project_config(overlap)
    assert not ok
    assert any(
        "paths.derivativesDir" in error and "separate from paths.rawdataDir" in error
        for error in errors
    )

    sibling = default_config()
    sibling["paths"]["rawdataDir"] = "/data/BIDS/study"
    sibling["paths"]["derivativesDir"] = "/data/BIDS/study-derivatives"
    sibling["paths"]["outputDir"] = "/data/BIDS/study-outputs"
    ok, errors, _warnings = validate_project_config(sibling)
    assert ok
    assert errors == []


def test_raw_data_equal_to_project_root_reports_one_cause_level_error() -> None:
    cfg = default_config()
    cfg["paths"]["rawdataDir"] = "/data/projects/supraspina"

    ok, errors, _warnings = validate_project_config(cfg)

    assert not ok
    assert errors == [
        "Keep paths.rawdataDir separate from paths.projectRoot: they resolve "
        "to the same directory, so every writable path inside the project "
        "lands in the raw data."
    ]


def test_raw_data_containing_the_project_root_reports_one_cause_level_error() -> None:
    cfg = default_config()
    cfg["paths"]["rawdataDir"] = "/data/projects"

    ok, errors, _warnings = validate_project_config(cfg)

    assert not ok
    assert errors == [
        "Keep paths.rawdataDir separate from paths.projectRoot: the project "
        "directory is inside the raw data directory, so every writable path "
        "inside the project lands in the raw data."
    ]


def test_aliased_and_nested_output_collisions_collapse_to_the_owning_path() -> None:
    cfg = default_config()
    cfg["paths"]["rawdataDir"] = "/data/BIDS/study"
    cfg["paths"]["outputDir"] = "/data/BIDS/study/outputs/run"

    ok, errors, _warnings = validate_project_config(cfg)

    assert not ok
    assert errors == ["Keep paths.outputDir separate from paths.rawdataDir."]


def test_missing_host_dependencies_remain_advisory() -> None:
    cfg = default_config()
    cfg["tools"]["freesurferHome"] = ""
    cfg["tools"]["pythonExecutable"] = ""
    cfg["pybrain"]["modelPath"] = ""
    cfg["pybrain"]["scalerPath"] = ""
    ok, errors, warnings = validate_project_config(cfg)
    assert ok
    assert errors == []
    assert any("FreeSurfer folder" in warning for warning in warnings)
    assert any("modelPath" in warning for warning in warnings)


@pytest.mark.parametrize(
    ("step", "name", "value", "fragment"),
    [
        ("brainfov", "marginMm", 0, "integer from 15 through 60"),
        ("deface", "forceOverwrite", "false", "boolean"),
        ("outliers", "zThreshold", float("inf"), "finite number"),
        ("features", "measure", "density", "thickness, area, volume"),
        ("features", "outDir", "${missing}/features", "unresolved or cyclic"),
    ],
)
def test_known_step_parameter_constraints_match_renderer(
    step: str,
    name: str,
    value: object,
    fragment: str,
) -> None:
    cfg = default_config()
    cfg["steps"].setdefault(step, {"enabled": True, "params": {}})
    cfg["steps"][step]["params"][name] = value
    ok, errors, _warnings = validate_project_config(cfg)
    assert not ok
    assert any(fragment in error for error in errors)


@pytest.mark.parametrize("bad_mode", ["windows", "", "Linux"])
def test_invalid_platform_mode_fails(bad_mode: str) -> None:
    cfg = default_config()
    cfg["platform"]["mode"] = bad_mode
    ok, _errors, _warnings = validate_project_config(cfg)
    assert not ok


@pytest.mark.parametrize("bad_dry_run", ["false", "true", 1, 0])
def test_non_boolean_dry_run_fails(bad_dry_run: Any) -> None:
    """Refuse a coercible dryRun the executor would read as raw truthiness."""
    cfg = default_config()
    cfg["runtime"]["dryRun"] = bad_dry_run

    ok, errors, _warnings = validate_project_config(cfg)

    assert not ok
    assert any("runtime.dryRun" in error for error in errors)


@pytest.mark.parametrize("root", ["C:\\data\\proj", "C:/data/proj", "\\\\host\\share"])
def test_windows_project_root_fails_under_a_posix_path_style(root: str) -> None:
    cfg = default_config()
    cfg["paths"]["projectRoot"] = root

    ok, errors, _warnings = validate_project_config(cfg)

    assert not ok
    assert any("paths.projectRoot" in error for error in errors)

    cfg["platform"] = {"mode": "wsl", "pathStyle": "windows"}
    ok, errors, _warnings = validate_project_config(cfg)
    assert ok, errors


def _fixture_document() -> dict[str, Any]:
    """Return the shared cross-language template-resolution fixture."""
    fixtures = Path(__file__).parents[2] / "fixtures" / "template-resolution"
    return json.loads((fixtures / "cases.json").read_text(encoding="utf-8"))


def _is_overlap_error(error: str) -> bool:
    """Report whether an error came from the raw data overlap check itself.

    Keep the generic unresolved-template message out of the comparison, because
    the overlap check owns only the sentences below.
    """
    return (
        error.endswith("so the writable paths can be checked against it.")
        or error.endswith("so it can be checked against paths.rawdataDir.")
        or bool(_OVERLAP_COLLISION.fullmatch(error))
        or error.startswith("Keep paths.rawdataDir separate from paths.projectRoot")
    )


_OVERLAP_COLLISION = re.compile(r"Keep \S+ separate from paths\.rawdataDir\.")


def _blocked_message(field: str) -> str:
    """Return the overlap check's refusal for an unresolved ``field``."""
    if field == "paths.rawdataDir":
        return (
            "Resolve the unresolved or cyclic template reference in "
            "paths.rawdataDir so the writable paths can be checked against it."
        )
    return (
        f"Resolve the unresolved or cyclic template reference in {field} "
        "so it can be checked against paths.rawdataDir."
    )


@pytest.mark.parametrize(
    "case",
    _fixture_document()["resolution"],
    ids=lambda case: str(case["name"]),
)
def test_validator_resolution_matches_the_shared_table(case: dict[str, Any]) -> None:
    """Resolve the shared table exactly as the renderer and the executor do."""
    flat = schema._flatten_strings(case["config"])

    assert schema._resolve_template(case["template"], flat) == case["expected"]


@pytest.mark.parametrize(
    "case",
    _fixture_document()["rawdataOverlap"],
    ids=lambda case: str(case["name"]),
)
def test_rawdata_overlap_matches_the_shared_table(case: dict[str, Any]) -> None:
    """Refuse, rather than skip, a writable path that still carries a token."""
    cfg = default_config()
    cfg["platform"]["pathStyle"] = case["pathStyle"]
    cfg["paths"] = {**cfg["paths"], **case["paths"]}
    cfg["outputs"] = {**cfg["outputs"], **case["outputs"]}

    _ok, errors, _warnings = validate_project_config(cfg)

    overlap_errors = [error for error in errors if _is_overlap_error(error)]
    expected = [_blocked_message(field) for field in case["blockedFields"]] + [
        f"Keep {field} separate from paths.rawdataDir."
        for field in case["overlappingFields"]
    ]
    assert sorted(overlap_errors) == sorted(expected)
