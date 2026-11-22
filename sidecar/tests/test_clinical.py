"""Tests for the clinical-merge adapter (pipeline step ``clinical``)."""

from __future__ import annotations

import os
import struct
import subprocess
import sys
from pathlib import Path
from typing import Any
from zipfile import ZipFile

import openpyxl
import pytest

from supraspina_sidecar.adapters import clinical, tools
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.adapters.clinical import (
    TEMPLATE_COLUMNS,
    ClinicalAdapter,
)


def make_cfg(output_dir: str) -> dict[str, Any]:
    """Return a minimal config exercising the clinical step's placeholders."""
    return {
        "paths": {
            "outputDir": output_dir,
            "metadataDir": f"{output_dir}/metadata",
            "clinicalMetadataFile": f"{output_dir}/metadata/clinical.csv",
        },
        "tools": {"pythonExecutable": "/envs/pybrainage/bin/python"},
        "steps": {
            "clinical": {
                "enabled": True,
                "params": {
                    "joinKey": "participant_id",
                    "requiredColumns": "Cohort,AIS",
                    "cohortLabels": "control,SCI_nNP,SCI_P",
                },
            },
        },
    }


def test_registered_under_key() -> None:
    assert isinstance(ADAPTERS["clinical"], ClinicalAdapter)
    assert ADAPTERS["clinical"].advances == ("stats",)


def test_param_schema_keys() -> None:
    schema = ClinicalAdapter().param_schema()
    assert set(schema) == {"joinKey", "requiredColumns"}
    assert schema["joinKey"]["default"] == "participant_id"
    assert schema["requiredColumns"]["default"] == "Cohort,AIS"


def test_build_command_resolves_argv() -> None:
    cfg = make_cfg("/runs/out")
    argv = ClinicalAdapter().build_command(cfg, subject_id=None)
    assert argv[0] == "/envs/pybrainage/bin/python"
    assert argv[1] == "-c"
    # Pass predictions, clinical data, workbook, key, reserved cohort label, and
    # required columns after the transform.
    assert argv[3] == "/runs/out/pybrainage/predicted_results.csv"
    assert argv[4] == "/runs/out/metadata/clinical.csv"
    assert argv[5] == "/runs/out/analysis/predicted_results.xlsx"
    assert argv[6] == "participant_id"
    assert argv[7] == "control,SCI_nNP,SCI_P"
    assert argv[8] == "Cohort,AIS"
    # Verify use of pandas, the openpyxl engine, and a left join.
    assert "import" in argv[2]
    assert "pandas" in argv[2]
    assert "to_excel" in argv[2]
    assert "openpyxl" in argv[2]
    assert "how='left'" in argv[2]


def test_build_command_preserves_explicit_required_columns() -> None:
    cfg = make_cfg("/runs/out")
    cfg["steps"]["clinical"]["params"]["requiredColumns"] = (
        "Cohort,AIS,Time since SCI (years)"
    )

    argv = ClinicalAdapter().build_command(cfg, subject_id=None)

    assert argv[8] == "Cohort,AIS,Time since SCI (years)"


def test_build_command_ignores_subject_id() -> None:
    cfg = make_cfg("/runs/out")
    adapter = ClinicalAdapter()
    assert adapter.build_command(cfg, "sub-01") == adapter.build_command(cfg, None)


def test_detect_pending_when_workbook_absent(tmp_path: Path) -> None:
    cfg = make_cfg(str(tmp_path))
    status = ClinicalAdapter().detect(cfg, subject_id=None)
    assert status.state == "pending"
    assert status.artifacts == []


def test_detect_pending_when_workbook_empty(tmp_path: Path) -> None:
    workbook = tmp_path / "analysis" / "predicted_results.xlsx"
    workbook.parent.mkdir(parents=True)
    workbook.write_bytes(b"")
    cfg = make_cfg(str(tmp_path))
    status = ClinicalAdapter().detect(cfg, subject_id=None)
    assert status.state == "pending"


def test_detect_done_with_template_columns(tmp_path: Path) -> None:
    workbook = tmp_path / "analysis" / "predicted_results.xlsx"
    workbook.parent.mkdir(parents=True)
    book = openpyxl.Workbook()
    book.active.append(list(TEMPLATE_COLUMNS))
    book.active.append(["190", 45, "Male", "control", 47.2, 2.2, "A", 3.5])
    book.save(workbook)
    cfg = make_cfg(str(tmp_path))
    status = ClinicalAdapter().detect(cfg, subject_id=None)
    assert status.state == "done"
    assert status.artifacts == [str(workbook)]


def test_detect_partial_when_columns_missing(tmp_path: Path) -> None:
    workbook = tmp_path / "analysis" / "predicted_results.xlsx"
    workbook.parent.mkdir(parents=True)
    book = openpyxl.Workbook()
    book.active.append(["Subject_ID", "Age", "BrainAge"])  # Omit required columns.
    book.save(workbook)
    cfg = make_cfg(str(tmp_path))
    status = ClinicalAdapter().detect(cfg, subject_id=None)
    assert status.state == "partial"
    assert "AIS" in status.detail


def test_detect_done_when_only_control_rows_leave_ais_blank(tmp_path: Path) -> None:
    workbook = tmp_path / "analysis" / "predicted_results.xlsx"
    workbook.parent.mkdir(parents=True)
    book = openpyxl.Workbook()
    book.active.append(list(TEMPLATE_COLUMNS))
    book.active.append(["190", 45, "Male", "control", 47.2, 2.2, None, None])
    book.save(workbook)
    status = ClinicalAdapter().detect(make_cfg(str(tmp_path)), subject_id=None)
    assert status.state == "done"


def test_detect_partial_when_an_sci_row_lacks_ais(tmp_path: Path) -> None:
    workbook = tmp_path / "analysis" / "predicted_results.xlsx"
    workbook.parent.mkdir(parents=True)
    book = openpyxl.Workbook()
    book.active.append(list(TEMPLATE_COLUMNS))
    book.active.append(["190", 45, "Male", "control", 47.2, 2.2, None, None])
    book.active.append(["191", 40, "Male", "SCI_P", 49.2, 9.2, None, 3.5])
    book.save(workbook)
    status = ClinicalAdapter().detect(make_cfg(str(tmp_path)), subject_id=None)
    assert status.state == "partial"
    assert "AIS" in status.detail


def test_detect_partial_when_required_column_all_empty(tmp_path: Path) -> None:
    # Keep unmatched subjects after a left join, and report an all-empty Cohort
    # column as partial even when the header is complete.
    workbook = tmp_path / "analysis" / "predicted_results.xlsx"
    workbook.parent.mkdir(parents=True)
    book = openpyxl.Workbook()
    book.active.append(list(TEMPLATE_COLUMNS))
    # Leave Cohort, AIS, and Time blank for every subject.
    book.active.append(["190", 45, "Male", None, 47.2, 2.2, None, None])
    book.save(workbook)
    cfg = make_cfg(str(tmp_path))
    status = ClinicalAdapter().detect(cfg, subject_id=None)
    assert status.state == "partial"
    assert "Cohort" in status.detail


def test_detect_fails_closed_at_workbook_row_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbook = tmp_path / "analysis" / "predicted_results.xlsx"
    workbook.parent.mkdir(parents=True)
    book = openpyxl.Workbook()
    book.active.append(list(TEMPLATE_COLUMNS))
    book.active.append(["190", 45, "Male", "control", 47.2, 2.2, "A", 3.5])
    book.active.append(["191", 46, "Male", "control", 48.2, 2.2, "B", 4.5])
    book.save(workbook)
    monkeypatch.setattr(clinical, "MAX_COHORT_ROWS", 1)

    status = ClinicalAdapter().detect(make_cfg(str(tmp_path)), subject_id=None)

    assert status.state == "partial"
    assert "within 5000 rows and 1024 columns" in status.detail


def test_workbook_preflight_bounds_archive_members(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workbook = tmp_path / "many-members.xlsx"
    with ZipFile(workbook, "w") as archive:
        archive.writestr("[Content_Types].xml", "types")
        archive.writestr("xl/workbook.xml", "workbook")
    monkeypatch.setattr(clinical, "MAX_XLSX_MEMBERS", 1)

    with pytest.raises(ValueError, match="within 1 members"):
        clinical._validate_xlsx_archive(str(workbook))


def test_workbook_preflight_rejects_zip64_directory_sentinel(tmp_path: Path) -> None:
    workbook = tmp_path / "zip64-sentinel.xlsx"
    with ZipFile(workbook, "w") as archive:
        archive.writestr("[Content_Types].xml", "types")
    value = bytearray(workbook.read_bytes())
    eocd = value.rfind(b"PK\x05\x06")
    assert eocd >= 0
    struct.pack_into("<L", value, eocd + 12, 0xFFFFFFFF)
    workbook.write_bytes(value)

    with pytest.raises(ValueError, match="does not require ZIP64"):
        clinical._validate_xlsx_archive(str(workbook))


def test_transform_strips_spaces_in_required_columns(tmp_path: Path) -> None:
    # The detector strips each configured requiredColumns entry, so the
    # transform must parse the same value identically instead of failing
    # on a column literally named " AIS".
    python = os.environ.get("SUPRASPINA_BRAINPAD_TEST_PYTHON", sys.executable)
    probe = subprocess.run(  # noqa: S603 - Probe the configured interpreter.
        [python, "-c", "import openpyxl, pandas"],
        check=False,
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        pytest.skip("Provide an analysis interpreter with pandas and openpyxl.")
    predictions = tmp_path / "predictions.csv"
    predictions.write_text(
        "ID,Age,BrainAge,BrainPAD\nsub-0000,40,42,2\n",
        encoding="utf-8",
    )
    clinical_csv = tmp_path / "clinical.csv"
    clinical_csv.write_text(
        "participant_id,Cohort,AIS\nsub-0000,control,A\n",
        encoding="utf-8",
    )
    cfg = make_cfg(str(tmp_path))
    cfg["steps"]["clinical"]["params"]["requiredColumns"] = "Cohort, AIS"
    workbook = tmp_path / "predicted_results.xlsx"
    argv = ClinicalAdapter().build_command(cfg, None)
    argv[0] = python
    argv[3:6] = [str(predictions), str(clinical_csv), str(workbook)]

    subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        argv,
        check=True,
        capture_output=True,
        text=True,
    )

    assert workbook.stat().st_size > 0


def test_transform_names_analysis_columns_the_metadata_never_supplied(
    tmp_path: Path,
) -> None:
    # The lab project's clinical CSV carried only Cohort and AIS, so the
    # workbook's Sex column came out empty and every sex-stratified Brain-PAD
    # comparison reported n=0 for all 65 subjects with no warning anywhere.
    python = os.environ.get("SUPRASPINA_BRAINPAD_TEST_PYTHON", sys.executable)
    probe = subprocess.run(  # noqa: S603 - Probe the configured interpreter.
        [python, "-c", "import openpyxl, pandas"],
        check=False,
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        pytest.skip("Provide an analysis interpreter with pandas and openpyxl.")
    predictions = tmp_path / "predictions.csv"
    predictions.write_text(
        "ID,Age,BrainAge,BrainPAD\nsub-0000,40,42,2\n", encoding="utf-8"
    )
    clinical_csv = tmp_path / "clinical.csv"
    clinical_csv.write_text(
        "participant_id,Cohort,AIS\nsub-0000,control,A\n", encoding="utf-8"
    )
    argv = ClinicalAdapter().build_command(make_cfg(str(tmp_path)), None)
    argv[0] = python
    argv[3:6] = [
        str(predictions),
        str(clinical_csv),
        str(tmp_path / "predicted_results.xlsx"),
    ]

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        argv,
        check=True,
        capture_output=True,
        text=True,
    )

    assert "no value for" in completed.stderr
    assert "Sex" in completed.stderr
    assert "Time since SCI (years)" in completed.stderr
    assert "Cohort" not in completed.stderr.split("no value for")[1]


def test_transform_rejects_more_than_5000_prediction_rows(tmp_path: Path) -> None:
    python = os.environ.get("SUPRASPINA_BRAINPAD_TEST_PYTHON", sys.executable)
    probe = subprocess.run(  # noqa: S603 - Probe the configured interpreter.
        [python, "-c", "import openpyxl, pandas"],
        check=False,
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        pytest.skip("Provide an analysis interpreter with pandas and openpyxl.")
    predictions = tmp_path / "predictions.csv"
    predictions.write_text(
        "ID,Age,BrainAge,BrainPAD\n"
        + "".join(f"sub-{index:04d},40,42,2\n" for index in range(5001)),
        encoding="utf-8",
    )
    clinical_csv = tmp_path / "clinical.csv"
    clinical_csv.write_text(
        "participant_id,Cohort,AIS\nsub-0000,control,A\n",
        encoding="utf-8",
    )
    argv = ClinicalAdapter().build_command(make_cfg(str(tmp_path)), None)
    argv[0] = python
    argv[3:6] = [
        str(predictions),
        str(clinical_csv),
        str(tmp_path / "predicted_results.xlsx"),
    ]

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        argv,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "within 5000 rows" in completed.stderr


def test_detect_present_workbook_without_openpyxl(tmp_path: Path) -> None:
    # Report partial without raising for a non-XLSX placeholder, whether or not
    # openpyxl is present.
    workbook = tmp_path / "analysis" / "predicted_results.xlsx"
    workbook.parent.mkdir(parents=True)
    workbook.write_text("not really xlsx")
    cfg = make_cfg(str(tmp_path))
    status = ClinicalAdapter().detect(cfg, subject_id=None)
    assert status.state == "partial"
    assert tools.file_nonempty(str(workbook))


def test_detect_reports_missing_runtime_dependency(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workbook = tmp_path / "analysis" / "predicted_results.xlsx"
    workbook.parent.mkdir(parents=True)
    workbook.write_bytes(b"nonempty")

    def unavailable() -> object:
        raise ModuleNotFoundError("No module named 'openpyxl'")

    monkeypatch.setattr(clinical, "_openpyxl_loader", unavailable)
    status = ClinicalAdapter().detect(make_cfg(str(tmp_path)), subject_id=None)
    assert status.state == "failed"
    assert status.detail == "Install the openpyxl runtime dependency."


def test_parse_failure_recognizes_signatures() -> None:
    adapter = ClinicalAdapter()
    assert adapter.parse_failure(0, "", "") is None
    missing = adapter.parse_failure(1, "", "FileNotFoundError: clinical.csv")
    assert missing is not None
    assert missing.tag == "missing_input"
    engine = adapter.parse_failure(
        1, "", "ModuleNotFoundError: No module named 'openpyxl'"
    )
    assert engine is not None
    assert engine.tag == "missing_engine"
    schema = adapter.parse_failure(1, "", "KeyError: 'participant_id'")
    assert schema is not None
    assert schema.tag == "schema_mismatch"
    required = adapter.parse_failure(3, "", "required clinical column missing: Cohort")
    assert required is not None
    assert required.tag == "missing_required_column"
    bounded = adapter.parse_failure(1, "", "Keep the clinical merge within 5000 rows.")
    assert bounded is not None
    assert bounded.tag == "input_bounds"
    generic = adapter.parse_failure(2, "", "some other crash")
    assert generic is not None
    assert generic.tag == "nonzero_exit"


def test_validate_blocks_a_missing_clinical_csv(tmp_path: Path) -> None:
    cfg = make_cfg(str(tmp_path))
    result = ClinicalAdapter().validate(cfg, {"groups": []})
    message = (
        f"Provide the clinical metadata CSV at {tmp_path}/metadata/clinical.csv "
        "with the participant_id, Cohort, and AIS columns."
    )
    assert message in result.blocking
    (tmp_path / "metadata").mkdir()
    (tmp_path / "metadata" / "clinical.csv").write_text("participant_id,Cohort,AIS\n")
    assert message not in ClinicalAdapter().validate(cfg, {"groups": []}).blocking
