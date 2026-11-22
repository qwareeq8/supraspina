"""Tests for the Step 4 age-metadata-integration adapter (``age``)."""

from __future__ import annotations

import csv
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import resources
from supraspina_sidecar.adapters import age as age_module
from supraspina_sidecar.adapters.age import AgeAdapter


def _cfg(out_dir: str = "/proj/out", repo_root: str = "/proj") -> dict[str, Any]:
    """Return a minimal config with concrete, fully resolvable age-step paths."""
    return {
        "paths": {
            "projectRoot": repo_root,
            "outputDir": out_dir,
            "ageMetadataFile": f"{repo_root}/metadata/age.csv",
        },
        "tools": {"pythonExecutable": "/usr/bin/python3"},
        "steps": {
            "age": {
                "enabled": True,
                "params": {
                    "subjectIdColumn": "participant_id",
                    "ageColumn": "age",
                    "join": "inner",
                    "warnOnMissing": True,
                },
            },
        },
    }


def test_param_schema_keys() -> None:
    schema = AgeAdapter().param_schema()
    assert set(schema) == {"subjectIdColumn", "ageColumn", "join", "warnOnMissing"}
    assert schema["subjectIdColumn"]["default"] == "participant_id"
    assert schema["ageColumn"]["default"] == "age"
    assert schema["join"]["default"] == "left"
    assert schema["join"]["options"] == ["inner", "left", "outer"]
    assert schema["warnOnMissing"]["default"] is True


def test_adapter_identity() -> None:
    adapter = AgeAdapter()
    assert adapter.key == "age"
    assert adapter.advances == ("feat",)


def test_transform_emits_merge_counts() -> None:
    # Report pre/post-merge subject counts so dropped subjects remain visible.
    argv = AgeAdapter().build_command(_cfg(), subject_id=None)
    assert "age-merge:" in argv[2]
    assert "merged rows" in argv[2]


def test_build_command_resolves_argv() -> None:
    argv = AgeAdapter().build_command(_cfg(), subject_id=None)
    assert argv[0] == "/usr/bin/python3"
    assert argv[1] == "-c"
    assert "merge" in argv[2]
    # Pass features, age, output, and parameters after the inline script.
    assert argv[3:] == [
        "/proj/out/features/concatenated_results.csv",
        "/proj/metadata/age.csv",
        "/proj/out/features/subject_features.csv",
        "participant_id",
        "age",
        "inner",
        "1",
    ]


def test_build_command_overrides_and_warn_flag() -> None:
    cfg = _cfg()
    cfg["steps"]["age"]["params"] = {
        "subjectIdColumn": "ID",
        "ageColumn": "Age",
        "join": "left",
        "warnOnMissing": False,
    }
    argv = AgeAdapter().build_command(cfg, subject_id=None)
    assert argv[6:] == ["ID", "Age", "left", "0"]


def _write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    lines = [",".join(header), *[",".join(r) for r in rows]]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_detect_pending_when_output_absent(tmp_path: Path) -> None:
    cfg = _cfg(out_dir=str(tmp_path))
    status = AgeAdapter().detect(cfg, subject_id=None)
    assert status.state == "pending"
    assert status.artifacts == []


def test_detect_done_when_age_populated(tmp_path: Path) -> None:
    features = tmp_path / "features"
    features.mkdir()
    out_csv = features / "subject_features.csv"
    _write_csv(
        out_csv,
        ["ID", "age", "feature1", "feature2"],
        [["Sub_01", "50.6", "2.0", "3.0"], ["Sub_02", "44.1", "2.1", "3.1"]],
    )
    cfg = _cfg(out_dir=str(tmp_path))
    status = AgeAdapter().detect(cfg, subject_id=None)
    assert status.state == "done"
    assert status.artifacts == [str(out_csv)]
    assert "2 subjects" in status.detail


def test_detect_done_and_names_the_rows_without_an_age(tmp_path: Path) -> None:
    features = tmp_path / "features"
    features.mkdir()
    out_csv = features / "subject_features.csv"
    _write_csv(
        out_csv,
        ["ID", "age", "feature1"],
        [["Sub_01", "50.6", "2.0"], ["Sub_02", "", "2.1"], ["Sub_03", "", "2.2"]],
    )
    cfg = _cfg(out_dir=str(tmp_path))
    status = AgeAdapter().detect(cfg, subject_id=None)
    assert status.state == "done"
    assert status.artifacts == [str(out_csv)]
    assert status.detail == (
        "1 subject has a populated age. Age is empty for 2 subject(s): Sub_02, Sub_03."
    )


def test_detect_bounds_the_listed_rows_without_an_age(tmp_path: Path) -> None:
    features = tmp_path / "features"
    features.mkdir()
    out_csv = features / "subject_features.csv"
    _write_csv(
        out_csv,
        ["ID", "age", "feature1"],
        [
            ["Sub_00", "50.6", "2.0"],
            *[[f"Sub_{i:02d}", "", "2.1"] for i in range(1, 22)],
        ],
    )

    status = AgeAdapter().detect(_cfg(out_dir=str(tmp_path)), subject_id=None)

    assert status.state == "done"
    assert "Age is empty for 21 subject(s)" in status.detail
    assert status.detail.endswith("Sub_20, ...")


def test_detect_partial_when_no_row_carries_an_age(tmp_path: Path) -> None:
    features = tmp_path / "features"
    features.mkdir()
    out_csv = features / "subject_features.csv"
    _write_csv(
        out_csv,
        ["ID", "age", "feature1"],
        [["Sub_01", "", "2.0"], ["Sub_02", "", "2.1"]],
    )

    status = AgeAdapter().detect(_cfg(out_dir=str(tmp_path)), subject_id=None)

    assert status.state == "partial"
    assert status.detail == "Provide an age value for at least one subject."


def test_detect_partial_when_a_row_has_no_age_cell(tmp_path: Path) -> None:
    features = tmp_path / "features"
    features.mkdir()
    out_csv = features / "subject_features.csv"
    out_csv.write_text("ID,age,feature1\nSub_01,50.6,2.0\nSub_02\n", encoding="utf-8")

    status = AgeAdapter().detect(_cfg(out_dir=str(tmp_path)), subject_id=None)

    assert status.state == "partial"
    assert status.detail == "Provide an age value in every row."


@pytest.mark.parametrize("age", ["nan", "inf", "not-a-number"])
def test_detect_partial_when_age_is_not_finite(tmp_path: Path, age: str) -> None:
    features = tmp_path / "features"
    features.mkdir()
    out_csv = features / "subject_features.csv"
    _write_csv(out_csv, ["ID", "age", "feature1"], [["Sub_01", age, "2.0"]])

    status = AgeAdapter().detect(_cfg(out_dir=str(tmp_path)), subject_id=None)

    assert status.state == "partial"
    assert "finite chronological age" in status.detail


def test_detect_partial_when_age_not_second_column(tmp_path: Path) -> None:
    features = tmp_path / "features"
    features.mkdir()
    out_csv = features / "subject_features.csv"
    _write_csv(
        out_csv,
        ["ID", "feature1", "age"],
        [["Sub_01", "2.0", "50.6"]],
    )
    cfg = _cfg(out_dir=str(tmp_path))
    status = AgeAdapter().detect(cfg, subject_id=None)
    assert status.state == "partial"


def test_detect_fails_closed_at_cohort_row_limit(
    tmp_path: Path, monkeypatch: Any
) -> None:
    features = tmp_path / "features"
    features.mkdir()
    out_csv = features / "subject_features.csv"
    _write_csv(
        out_csv,
        ["ID", "age", "feature1"],
        [["Sub_01", "50.6", "2.0"], ["Sub_02", "44.1", "2.1"]],
    )
    monkeypatch.setattr(age_module, "MAX_COHORT_ROWS", 1)

    status = AgeAdapter().detect(_cfg(out_dir=str(tmp_path)), subject_id=None)

    assert status.state == "partial"
    assert "within 5000 rows" in status.detail


def _analysis_python() -> str:
    """Return an interpreter with pandas, or skip the calling test."""
    python = os.environ.get("SUPRASPINA_BRAINPAD_TEST_PYTHON", sys.executable)
    probe = subprocess.run(  # noqa: S603 - Probe the configured interpreter.
        [python, "-c", "import pandas"],
        check=False,
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        pytest.skip("Provide an analysis interpreter with pandas.")
    return python


def test_transform_writes_the_exact_pybrainage_header(tmp_path: Path) -> None:
    # The bundled predict.py compares the subject_features.csv header
    # case-sensitively against the pinned template, so the transform must
    # emit exactly ``ID,Age`` followed by the trained feature order.
    python = _analysis_python()
    template = resources.features_dir() / "rois_input_template.txt"
    with template.open(newline="", encoding="utf-8") as handle:
        template_header = next(csv.reader(handle, delimiter="\t"))
    assert template_header[:2] == ["ID", "Age"]
    feature_names = [
        name.replace("&", "_and_")
        .replace("Left-Thalamus-Proper", "Left-Thalamus")
        .replace("Right-Thalamus-Proper", "Right-Thalamus")
        for name in template_header[2:]
    ]
    features = tmp_path / "features.csv"
    ages = tmp_path / "ages.csv"
    out_csv = tmp_path / "subject_features.csv"
    _write_csv(
        features,
        ["ID", *feature_names],
        [["sub-01", *["1.0"] * len(feature_names)]],
    )
    _write_csv(ages, ["participant_id", "age"], [["sub-01", "40"]])
    argv = AgeAdapter().build_command(_cfg(), subject_id=None)
    argv[0] = python
    argv[3:6] = [str(features), str(ages), str(out_csv)]

    subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        argv,
        check=True,
        capture_output=True,
        text=True,
    )

    with out_csv.open(newline="", encoding="utf-8") as handle:
        written_header = next(csv.reader(handle))
    assert written_header == ["ID", "Age", *feature_names]


def test_transform_rejects_more_than_5000_rows(tmp_path: Path) -> None:
    python = _analysis_python()
    features = tmp_path / "features.csv"
    ages = tmp_path / "ages.csv"
    _write_csv(
        features,
        ["ID", "feature1"],
        [[f"sub-{index:04d}", "1"] for index in range(5001)],
    )
    _write_csv(ages, ["participant_id", "age"], [["sub-0000", "40"]])
    argv = AgeAdapter().build_command(_cfg(), subject_id=None)
    argv[0] = python
    argv[3:6] = [str(features), str(ages), str(tmp_path / "output.csv")]

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        argv,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "within 5000 rows" in completed.stderr


def test_parse_failure_signatures() -> None:
    adapter = AgeAdapter()
    assert adapter.parse_failure(0, "", "") is None
    missing = adapter.parse_failure(1, "", "FileNotFoundError: no such file: x.csv")
    assert missing is not None
    assert missing.tag == "missing_input"
    bad_col = adapter.parse_failure(1, "", "KeyError: 'participant_id'")
    assert bad_col is not None
    assert bad_col.tag == "missing_column"
    empty = adapter.parse_failure(1, "", "pandas.errors.EmptyDataError: no columns")
    assert empty is not None
    assert empty.tag == "empty_input"
    bounded = adapter.parse_failure(1, "", "Keep the age merge within 5000 rows.")
    assert bounded is not None
    assert bounded.tag == "input_bounds"


def test_validate_blocks_a_missing_age_csv(tmp_path: Path) -> None:
    cfg = _cfg(repo_root=str(tmp_path))
    result = AgeAdapter().validate(cfg, {"groups": []})
    message = (
        f"Provide the age metadata CSV at {tmp_path}/metadata/age.csv with the "
        "configured subject-ID and age columns."
    )
    assert message in result.blocking
    (tmp_path / "metadata").mkdir()
    (tmp_path / "metadata" / "age.csv").write_text("participant_id,age\n")
    assert message not in AgeAdapter().validate(cfg, {"groups": []}).blocking
