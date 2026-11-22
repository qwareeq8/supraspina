"""Tests for the Step 9 final R-analysis adapter."""

from __future__ import annotations

import csv
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
from openpyxl import load_workbook

from supraspina_sidecar import final_r_contract, provenance, resources
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.adapters.final import (
    COMPARISON_CODES,
    CSV_OUTPUTS,
    PLAIN_SCRIPT,
    RESULT_BLOCKS,
    RMD_TEMPLATE,
    FinalAdapter,
)


def synthetic_cfg(out_dir: str) -> dict[str, Any]:
    """Return a minimal config whose path templates fully resolve.

    Resolve the Step 9 assets bundled with the app to the shipped
    ``FreesurferAnalysisScript.R`` and ``.Rmd`` files. Do not rely on an external
    checkout.

    Parameters
    ----------
    out_dir
        Provide the concrete output directory for the final workbooks and report.

    Returns
    -------
    dict
        Return a configuration sufficient for ``build_command`` and ``detect``.
    """
    return {
        "paths": {
            "projectRoot": "/repo",
            "outputDir": "/work/outputs",
            "metadataDir": "/work/metadata",
        },
        "tools": {
            "rscriptExecutable": "/usr/bin/Rscript",
        },
        "steps": {
            "final": {
                "enabled": True,
                "params": {
                    "rscriptExecutable": "/usr/bin/Rscript",
                    "outDir": out_dir,
                    "renderReport": True,
                },
            }
        },
    }


def _bundle_rmd() -> str:
    """Return the bundled Rmd path as the adapter joins it."""
    return str(resources.step9_dir() / RMD_TEMPLATE)


def _bundle_r() -> str:
    """Return the bundled base-R script path as the adapter joins it."""
    return str(resources.step9_dir() / PLAIN_SCRIPT)


def _write_xlsx(path: Path) -> None:
    """Write a stand-in workbook that begins with the XLSX ZIP signature."""
    path.write_bytes(b"PK\x03\x04xlsx")


def _read_result_table(path: Path) -> list[dict[str, object]]:
    """Read one CSV/XLSX result table without depending on writexl presence."""
    if path.suffix == ".csv":
        with path.open(newline="", encoding="utf-8") as handle:
            return list(csv.DictReader(handle))
    workbook = load_workbook(path, read_only=True, data_only=True)
    worksheet = workbook.active
    rows = worksheet.iter_rows(values_only=True)
    header = [str(value) for value in next(rows)]
    result = [dict(zip(header, row, strict=True)) for row in rows]
    workbook.close()
    return result


def _write_fixed_csvs(out_dir: Path) -> None:
    """Write the three fixed R analysis CSV outputs with multi-column headers."""
    for _key, _label, basename in CSV_OUTPUTS:
        (out_dir / basename).write_text("a,b\n", encoding="utf-8")


def _write_step8_companions(
    structural_dir: Path, subjects: list[tuple[str, str, int]]
) -> None:
    """Write the wm_volumes, icv_data, and cortical_thickness Step 8 tables.

    ``wm_volumes.csv`` follows the aggregate stage: the three cerebral white
    matter totals (blank when wmparc.stats lacks them), then the structures.
    """
    (structural_dir / "wm_volumes.csv").write_text(
        "subject,TotalCerebralWM,RightCerebralWM,LeftCerebralWM,"
        "wm-lh-bankssts,wm-rh-bankssts\n"
        + "".join(
            # The first subject's wmparc.stats lacks the total, so its cell is blank.
            f"{subject},{450000 + base * 100 if index else ''},"
            f"{225000 + base * 50},{225000 + base * 60},"
            f"{1000 + base * 10},{1100 + base * 10}\n"
            for index, (subject, _, base) in enumerate(subjects)
        ),
        encoding="utf-8",
    )
    (structural_dir / "icv_data.csv").write_text(
        "subject,eTIV\n"
        + "".join(f"{subject},{1500000 + base}\n" for subject, _, base in subjects),
        encoding="utf-8",
    )
    (structural_dir / "cortical_thickness.csv").write_text(
        "subject,lh_mean_thickness,rh_mean_thickness\n"
        + "".join(
            f"{subject},{2 + base / 100},{2.1 + base / 100}\n"
            for subject, _, base in subjects
        ),
        encoding="utf-8",
    )


_WM_REGIONS = (
    "TotalCerebralWM",
    "RightCerebralWM",
    "LeftCerebralWM",
    "wm-lh-bankssts",
    "wm-rh-bankssts",
)


def _result_tables(output_dir: Path) -> list[Path]:
    """Return the comparison tables, excluding the fixed CSV outputs."""
    return sorted(
        path
        for path in output_dir.iterdir()
        if path.suffix in {".csv", ".xlsx"} and path.stem.endswith("_results")
    )


def test_param_schema_keys() -> None:
    schema = FinalAdapter().param_schema()
    assert set(schema) == {"rscriptExecutable", "outDir", "renderReport"}
    assert schema["renderReport"]["default"] is True
    assert schema["outDir"]["must"] == "writable"
    assert schema["rscriptExecutable"]["kind"] == "path"


def test_build_command_resolved_argv() -> None:
    adapter = FinalAdapter()
    cfg = synthetic_cfg("/work/outputs/final")
    argv = adapter.build_command(cfg, None)

    assert argv == [
        "/usr/bin/Rscript",
        _bundle_r(),
        "--render-report",
        _bundle_rmd(),
        "/work/outputs/structural",
        "/work/metadata/metadata.csv",
        "/work/outputs/final",
        "5",
        "613",
        "SCI_H,SCI_P,SCI_nNP,SCI",
    ]


def test_build_report_command_preserves_quoted_paths_as_argv() -> None:
    adapter = FinalAdapter()
    cfg = synthetic_cfg('/work/output "quoted"/final')
    cfg["paths"]["outputDir"] = '/work/output "quoted"'
    cfg["paths"]["metadataDir"] = "/work/metadata with spaces"

    argv = adapter.build_command(cfg, None)

    assert "-e" not in argv
    assert argv[4] == '/work/output "quoted"/structural'
    assert argv[5] == "/work/metadata with spaces/metadata.csv"
    assert argv[6] == '/work/output "quoted"/final'


def test_build_command_plain_r_when_report_disabled() -> None:
    # Run the bundled base-R script directly when renderReport is disabled.
    # Pass analysis values as positional argv without rmarkdown or Pandoc.
    adapter = FinalAdapter()
    cfg = synthetic_cfg("/work/outputs/final")
    cfg["steps"]["final"]["params"]["renderReport"] = False
    argv = adapter.build_command(cfg, None)
    assert argv[0] == "/usr/bin/Rscript"
    assert argv[1] == _bundle_r()
    assert argv[2:] == [
        "/work/outputs/structural",
        "/work/metadata/metadata.csv",
        "/work/outputs/final",
        "5",
        "613",
        "SCI_H,SCI_P,SCI_nNP,SCI",
    ]


def test_build_command_ignores_subject_id() -> None:
    adapter = FinalAdapter()
    cfg = synthetic_cfg("/work/outputs/final")
    assert adapter.build_command(cfg, "sub-001") == adapter.build_command(cfg, None)


def test_build_command_honors_aggregate_out_dir_override() -> None:
    # The final stage must read the directory the aggregate stage wrote,
    # not a fixed default the operator may have moved away from.
    adapter = FinalAdapter()
    cfg = synthetic_cfg("/work/outputs/final")
    cfg["steps"]["aggregate"] = {
        "enabled": True,
        "params": {"outDir": "/data/structural-v2"},
    }
    argv = adapter.build_command(cfg, None)
    assert argv[4] == "/data/structural-v2"


def test_step9_resource_honors_start_column(tmp_path: Path) -> None:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party Step 9 resource.")
    structural_dir = tmp_path / "structural"
    output_dir = tmp_path / "final"
    structural_dir.mkdir()
    subjects = [
        ("sub-h1", "SCI_H", 1),
        ("sub-h2", "SCI_H", 2),
        ("sub-p1", "SCI_P", 5),
        ("sub-p2", "SCI_P", 6),
        ("sub-n1", "SCI_nNP", 9),
        ("sub-n2", "SCI_nNP", 10),
    ]
    (structural_dir / "dk_all_stats.csv").write_text(
        "subject,excluded,cortical_kept,sub_kept\n"
        + "".join(
            f"{subject},{base},{base + 1},{base + 2}\n" for subject, _, base in subjects
        ),
        encoding="utf-8",
    )
    _write_step8_companions(structural_dir, subjects)
    metadata = tmp_path / "metadata.csv"
    metadata.write_text(
        "SubjectID,Cohort,Sex,Age\n"
        + "".join(
            f"{subject},{cohort},F,{30 + index}\n"
            for index, (subject, cohort, _) in enumerate(subjects)
        ),
        encoding="utf-8",
    )
    script = resources.step9_dir() / "FreesurferAnalysisScript.R"

    subprocess.run(  # noqa: S603 - Execute the reviewed resource with fixed argv.
        [
            rscript,
            str(script),
            str(structural_dir),
            str(metadata),
            str(output_dir),
            "6",
            "3",
            "SCI_H,SCI_P,SCI_nNP,SCI",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    tables = _result_tables(output_dir)
    assert len(tables) == 12
    regions: set[str] = set()
    for table in tables:
        if table.suffix == ".csv":
            with table.open(newline="", encoding="utf-8") as handle:
                regions.update(row["Region"] for row in csv.DictReader(handle))
        else:
            workbook = load_workbook(table, read_only=True, data_only=True)
            worksheet = workbook.active
            rows = worksheet.iter_rows(values_only=True)
            header = list(next(rows))
            region_index = header.index("Region")
            regions.update(str(row[region_index]) for row in rows)
            workbook.close()
    assert regions == {"cortical_kept", "sub_kept", *_WM_REGIONS}

    # Effects are control minus pain, as upstream, so the control group is the
    # reference.
    pvh_table = next(path for path in tables if path.name.startswith("SCI_PvH_"))
    pvh = _read_result_table(pvh_table)
    assert len(pvh) == 1
    assert pvh[0]["Region"] == "cortical_kept"
    assert pvh[0]["Group_ref"] == "SCI_H"
    assert pvh[0]["Group_foc"] == "SCI_P"
    assert pvh[0]["Direction"] == "SCI_H minus SCI_P"
    assert float(pvh[0]["Mean_ref"]) == pytest.approx(2.5)
    assert float(pvh[0]["Mean_foc"]) == pytest.approx(6.5)
    assert int(pvh[0]["N_ref"]) == 2
    assert int(pvh[0]["N_foc"]) == 2
    assert float(pvh[0]["t_statistic"]) == pytest.approx(-5.65685424949238)
    assert float(pvh[0]["Hedges_g"]) == pytest.approx(-5.65685424949238 * 4 / 7)
    assert list(pvh[0]) == list(final_r_contract.RESULT_COLUMNS)


def test_step9_skips_constant_and_all_zero_regions(tmp_path: Path) -> None:
    # Real aseg.stats cohorts always carry all-zero columns such as
    # Left-WM-hypointensities, so one degenerate region must be skipped
    # instead of aborting the whole stage with zero tables.
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party Step 9 resource.")
    structural_dir = tmp_path / "structural"
    output_dir = tmp_path / "final"
    structural_dir.mkdir()
    subjects = [
        ("sub-h1", "SCI_H", 1),
        ("sub-h2", "SCI_H", 2),
        ("sub-p1", "SCI_P", 5),
        ("sub-p2", "SCI_P", 6),
        ("sub-n1", "SCI_nNP", 9),
        ("sub-n2", "SCI_nNP", 10),
    ]
    (structural_dir / "dk_all_stats.csv").write_text(
        "subject,cortical_kept,cortical_zero,sub_kept,sub_constant\n"
        + "".join(
            f"{subject},{base},0.0,{base + 1},5.0\n" for subject, _, base in subjects
        ),
        encoding="utf-8",
    )
    _write_step8_companions(structural_dir, subjects)
    metadata = tmp_path / "metadata.csv"
    metadata.write_text(
        "SubjectID,Cohort\n"
        + "".join(f"{subject},{cohort}\n" for subject, cohort, _ in subjects),
        encoding="utf-8",
    )

    subprocess.run(  # noqa: S603 - Execute the reviewed resource with fixed argv.
        [
            rscript,
            str(resources.step9_dir() / PLAIN_SCRIPT),
            str(structural_dir),
            str(metadata),
            str(output_dir),
            "5",
            "3",
            "SCI_H,SCI_P,SCI_nNP,SCI",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    tables = _result_tables(output_dir)
    assert len(tables) == 12
    regions: set[str] = set()
    for table in tables:
        regions.update(str(row["Region"]) for row in _read_result_table(table))
    assert regions == {"cortical_kept", "sub_kept", *_WM_REGIONS}


def test_step9_accepts_metadata_keyed_by_id(tmp_path: Path) -> None:
    # Planning accepts an ID-keyed metadata table, so the R script must
    # join on the same column instead of rejecting the projected input.
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party Step 9 resource.")
    structural_dir = tmp_path / "structural"
    output_dir = tmp_path / "final"
    structural_dir.mkdir()
    subjects = [
        ("sub-h1", "SCI_H", 1),
        ("sub-h2", "SCI_H", 2),
        ("sub-p1", "SCI_P", 5),
        ("sub-p2", "SCI_P", 6),
        ("sub-n1", "SCI_nNP", 9),
        ("sub-n2", "SCI_nNP", 10),
    ]
    (structural_dir / "dk_all_stats.csv").write_text(
        "subject,cortical_kept,sub_kept\n"
        + "".join(f"{subject},{base},{base + 1}\n" for subject, _, base in subjects),
        encoding="utf-8",
    )
    _write_step8_companions(structural_dir, subjects)
    metadata = tmp_path / "metadata.csv"
    metadata.write_text(
        "ID,Cohort\n"
        + "".join(f"{subject},{cohort}\n" for subject, cohort, _ in subjects),
        encoding="utf-8",
    )

    subprocess.run(  # noqa: S603 - Execute the reviewed resource with fixed argv.
        [
            rscript,
            str(resources.step9_dir() / PLAIN_SCRIPT),
            str(structural_dir),
            str(metadata),
            str(output_dir),
            "5",
            "2",
            "SCI_H,SCI_P,SCI_nNP,SCI",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    assert len(_result_tables(output_dir)) == 12


def test_step9_names_families_whose_every_region_fails_the_test(
    tmp_path: Path,
) -> None:
    # A block whose only region is constant in both groups must exit
    # nonzero with the test-failure reason rather than a raw t.test error.
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party Step 9 resource.")
    structural_dir = tmp_path / "structural"
    output_dir = tmp_path / "final"
    structural_dir.mkdir()
    subjects = [
        ("sub-h1", "SCI_H", 1),
        ("sub-h2", "SCI_H", 2),
        ("sub-p1", "SCI_P", 5),
        ("sub-p2", "SCI_P", 6),
        ("sub-n1", "SCI_nNP", 9),
        ("sub-n2", "SCI_nNP", 10),
    ]
    (structural_dir / "dk_all_stats.csv").write_text(
        "subject,cortical_kept,sub_constant\n"
        + "".join(f"{subject},{base},5.0\n" for subject, _, base in subjects),
        encoding="utf-8",
    )
    _write_step8_companions(structural_dir, subjects)
    metadata = tmp_path / "metadata.csv"
    metadata.write_text(
        "SubjectID,Cohort\n"
        + "".join(f"{subject},{cohort}\n" for subject, cohort, _ in subjects),
        encoding="utf-8",
    )

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [
            rscript,
            str(resources.step9_dir() / PLAIN_SCRIPT),
            str(structural_dir),
            str(metadata),
            str(output_dir),
            "5",
            "2",
            "SCI_H,SCI_P,SCI_nNP,SCI",
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert (
        "Cannot create all twelve required R analysis result tables" in completed.stderr
    )
    assert "SUB_PvH: Welch t-test failed for all 1 eligible region(s)" in (
        completed.stderr
    )


def test_step9_sparse_contrasts_fail_with_exact_missing_families(
    tmp_path: Path,
) -> None:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party Step 9 resource.")
    structural_dir = tmp_path / "structural"
    output_dir = tmp_path / "final"
    structural_dir.mkdir()
    subjects = [
        ("sub-h1", "SCI_H", 1),
        ("sub-h2", "SCI_H", 2),
        ("sub-p1", "SCI_P", 5),
        ("sub-p2", "SCI_P", 6),
        ("sub-n1", "SCI_nNP", 9),
        ("sub-n2", "SCI_nNP", 10),
    ]
    (structural_dir / "dk_all_stats.csv").write_text(
        "subject,cortical_kept,sub_kept\n"
        + "".join(
            f"{subject},{base},{'' if cohort == 'SCI_P' else base + 1}\n"
            for subject, cohort, base in subjects
        ),
        encoding="utf-8",
    )
    _write_step8_companions(structural_dir, subjects)
    metadata = tmp_path / "metadata.csv"
    metadata.write_text(
        "SubjectID,Cohort\n"
        + "".join(f"{subject},{cohort}\n" for subject, cohort, _ in subjects),
        encoding="utf-8",
    )

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [
            rscript,
            str(resources.step9_dir() / PLAIN_SCRIPT),
            str(structural_dir),
            str(metadata),
            str(output_dir),
            "5",
            "2",
            "SCI_H,SCI_P,SCI_nNP,SCI",
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert (
        "Cannot create all twelve required R analysis result tables" in completed.stderr
    )
    assert (
        "SUB_PvH: no region has at least 2 nonmissing observations" in completed.stderr
    )
    assert "maximum SCI_H=2; SCI_P=0" in completed.stderr
    assert (
        "SUB_nNPvP: no region has at least 2 nonmissing observations"
        in completed.stderr
    )
    assert "maximum SCI_P=0; SCI_nNP=2" in completed.stderr
    assert "SUB_IvH:" not in completed.stderr
    assert not output_dir.exists()


def test_step9_empty_block_lists_all_four_missing_families(tmp_path: Path) -> None:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party Step 9 resource.")
    structural_dir = tmp_path / "structural"
    output_dir = tmp_path / "final"
    structural_dir.mkdir()
    subjects = [
        ("sub-h1", "SCI_H", 1),
        ("sub-h2", "SCI_H", 2),
        ("sub-p1", "SCI_P", 5),
        ("sub-p2", "SCI_P", 6),
        ("sub-n1", "SCI_nNP", 9),
        ("sub-n2", "SCI_nNP", 10),
    ]
    (structural_dir / "dk_all_stats.csv").write_text(
        "subject,cortical_kept\n"
        + "".join(f"{subject},{base}\n" for subject, _, base in subjects),
        encoding="utf-8",
    )
    _write_step8_companions(structural_dir, subjects)
    metadata = tmp_path / "metadata.csv"
    metadata.write_text(
        "SubjectID,Cohort\n"
        + "".join(f"{subject},{cohort}\n" for subject, cohort, _ in subjects),
        encoding="utf-8",
    )

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [
            rscript,
            str(resources.step9_dir() / PLAIN_SCRIPT),
            str(structural_dir),
            str(metadata),
            str(output_dir),
            "5",
            "2",
            "SCI_H,SCI_P,SCI_nNP,SCI",
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    for code in COMPARISON_CODES:
        assert (
            f"SUB_{code}: no measure columns were assigned to the SUB block"
            in completed.stderr
        )
    assert not output_dir.exists()


def test_step9_report_wrapper_validates_argv_before_loading_rmarkdown() -> None:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party Step 9 resource.")

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [rscript, _bundle_r(), "--render-report"],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "--render-report <template.Rmd>" in completed.stderr


def test_step9_rejects_oversized_structural_csv_before_reading(
    tmp_path: Path,
) -> None:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party Step 9 resource.")
    structural_dir = tmp_path / "structural"
    structural_dir.mkdir()
    with (structural_dir / "dk_all_stats.csv").open("wb") as handle:
        handle.truncate(64 * 1024 * 1024 + 1)
    metadata = tmp_path / "metadata.csv"
    metadata.write_text("SubjectID,Cohort\n", encoding="utf-8")

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [
            rscript,
            _bundle_r(),
            str(structural_dir),
            str(metadata),
            str(tmp_path / "final"),
            "5",
            "613",
            "SCI_H,SCI_P,SCI_nNP,SCI",
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "dk_all_stats.csv within 64 MiB as a regular CSV file" in completed.stderr


def test_step9_rejects_more_than_5000_structural_rows(tmp_path: Path) -> None:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party Step 9 resource.")
    structural_dir = tmp_path / "structural"
    structural_dir.mkdir()
    (structural_dir / "dk_all_stats.csv").write_text(
        "subject,cortical\n"
        + "".join(f"sub-{index:04d},{index}\n" for index in range(5001)),
        encoding="utf-8",
    )
    metadata = tmp_path / "metadata.csv"
    metadata.write_text("SubjectID,Cohort\n", encoding="utf-8")

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [
            rscript,
            _bundle_r(),
            str(structural_dir),
            str(metadata),
            str(tmp_path / "final"),
            "5",
            "613",
            "SCI_H,SCI_P,SCI_nNP,SCI",
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "dk_all_stats.csv within 5000 cohort rows" in completed.stderr


def test_report_template_enumerates_only_fixed_result_names() -> None:
    source = (resources.step9_dir() / RMD_TEMPLATE).read_text(encoding="utf-8")

    assert "list.files(" not in source
    assert 'c("SCI", "SUB", "WM")' in source
    assert 'paste0("Z_", c("SCI", "SUB"))' in source
    assert 'c("PvH", "nNPvH", "nNPvP", "IvH")' in source
    assert 'c("site_exclusions.csv", "summary_icv.csv", "summary_thickness.csv")' in (
        source
    )


def test_validate_blocks_a_missing_metadata_csv(tmp_path: Path) -> None:
    cfg = synthetic_cfg(str(tmp_path / "final"))
    cfg["paths"]["metadataDir"] = str(tmp_path / "metadata")
    message = (
        f"Provide the metadata file {tmp_path}/metadata/metadata.csv with a "
        "subject ID column (participant_id) and a Cohort column; Sex and Age "
        "are optional."
    )
    assert message in FinalAdapter().validate(cfg, {"groups": []}).blocking
    (tmp_path / "metadata").mkdir()
    (tmp_path / "metadata" / "metadata.csv").write_text("participant_id,Cohort\n")
    assert message not in FinalAdapter().validate(cfg, {"groups": []}).blocking


def test_detect_pending_when_no_artifacts(tmp_path: Path) -> None:
    adapter = FinalAdapter()
    out_dir = tmp_path / "final"
    out_dir.mkdir()
    status = adapter.detect(synthetic_cfg(str(out_dir)), None)
    assert status.state == "pending"
    assert status.artifacts == []


def test_detect_done_with_result_workbooks(tmp_path: Path) -> None:
    adapter = FinalAdapter()
    out_dir = tmp_path / "final"
    out_dir.mkdir()
    for block in RESULT_BLOCKS:
        for code in COMPARISON_CODES:
            _write_xlsx(out_dir / f"{block}_{code}_results.xlsx")
    _write_fixed_csvs(out_dir)
    (out_dir / "report.html").write_text("<html></html>")

    status = adapter.detect(synthetic_cfg(str(out_dir)), None)
    assert status.state == "done"
    expected_table_count = len(RESULT_BLOCKS) * len(COMPARISON_CODES)
    assert expected_table_count == 12
    assert len(status.artifacts) == expected_table_count + len(CSV_OUTPUTS) + 1
    assert (
        sum(a.endswith("_results.xlsx") for a in status.artifacts)
        == expected_table_count
    )


def test_detect_partial_when_one_result_workbook_is_empty(tmp_path: Path) -> None:
    adapter = FinalAdapter()
    out_dir = tmp_path / "final"
    out_dir.mkdir()
    empty = "SUB_nNPvP_results.xlsx"
    for block in RESULT_BLOCKS:
        for code in COMPARISON_CODES:
            name = f"{block}_{code}_results.xlsx"
            if name == empty:
                (out_dir / name).write_text("")
            else:
                _write_xlsx(out_dir / name)
    _write_fixed_csvs(out_dir)
    (out_dir / "report.html").write_text("<html></html>")

    status = adapter.detect(synthetic_cfg(str(out_dir)), None)

    assert status.state == "partial"
    assert "SUB_nNPvP" in status.detail
    assert not any(path.endswith(empty) for path in status.artifacts)


def test_detect_partial_when_required_report_is_empty(tmp_path: Path) -> None:
    adapter = FinalAdapter()
    out_dir = tmp_path / "final"
    out_dir.mkdir()
    for block in RESULT_BLOCKS:
        for code in COMPARISON_CODES:
            _write_xlsx(out_dir / f"{block}_{code}_results.xlsx")
    _write_fixed_csvs(out_dir)
    (out_dir / "report.html").touch()

    status = adapter.detect(synthetic_cfg(str(out_dir)), None)

    assert status.state == "partial"
    assert status.detail == "Create the report."
    assert len(status.artifacts) == len(RESULT_BLOCKS) * len(COMPARISON_CODES) + 3


def test_detect_done_with_csv_result_tables_when_report_disabled(
    tmp_path: Path,
) -> None:
    # Accept .csv output from the base-R path when writexl is absent.
    adapter = FinalAdapter()
    out_dir = tmp_path / "final"
    out_dir.mkdir()
    for block in RESULT_BLOCKS:
        for code in COMPARISON_CODES:
            (out_dir / f"{block}_{code}_results.csv").write_text("Region,p_value\n")
    _write_fixed_csvs(out_dir)
    cfg = synthetic_cfg(str(out_dir))
    cfg["steps"]["final"]["params"]["renderReport"] = False
    status = adapter.detect(cfg, None)
    assert status.state == "done"
    assert len(status.artifacts) == len(RESULT_BLOCKS) * len(COMPARISON_CODES) + 3


def test_detect_report_only_is_partial(tmp_path: Path) -> None:
    adapter = FinalAdapter()
    out_dir = tmp_path / "final"
    out_dir.mkdir()
    (out_dir / "report.html").write_text("<html></html>")

    status = adapter.detect(synthetic_cfg(str(out_dir)), None)
    assert status.state == "partial"
    assert status.artifacts == [str(out_dir / "report.html")]
    assert "missing R analysis outputs" in status.detail


def test_detect_report_and_one_workbook_is_partial(tmp_path: Path) -> None:
    adapter = FinalAdapter()
    out_dir = tmp_path / "final"
    out_dir.mkdir()
    _write_xlsx(out_dir / "SCI_PvH_results.xlsx")
    (out_dir / "report.html").write_text("<html></html>")

    status = adapter.detect(synthetic_cfg(str(out_dir)), None)
    assert status.state == "partial"
    assert len(status.artifacts) == 2


def test_detect_all_sci_tables_without_sub_tables_is_partial(
    tmp_path: Path,
) -> None:
    adapter = FinalAdapter()
    out_dir = tmp_path / "final"
    out_dir.mkdir()
    for code in COMPARISON_CODES:
        _write_xlsx(out_dir / f"SCI_{code}_results.xlsx")
    (out_dir / "report.html").write_text("<html></html>")

    status = adapter.detect(synthetic_cfg(str(out_dir)), None)

    assert status.state == "partial"
    assert "SUB_PvH" in status.detail
    assert "WM_PvH" in status.detail
    assert "site_exclusions" in status.detail
    assert len(status.artifacts) == len(COMPARISON_CODES) + 1


def test_detect_rejects_mixed_csv_and_xlsx_families(tmp_path: Path) -> None:
    adapter = FinalAdapter()
    out_dir = tmp_path / "final"
    out_dir.mkdir()
    for block_index, block in enumerate(RESULT_BLOCKS):
        for code_index, code in enumerate(COMPARISON_CODES):
            suffix = "csv" if (block_index + code_index) % 2 else "xlsx"
            (out_dir / f"{block}_{code}_results.{suffix}").write_text("table")
    (out_dir / "report.pdf").write_text("pdf")

    status = adapter.detect(synthetic_cfg(str(out_dir)), None)

    assert status.state == "failed"
    assert "one table format" in status.detail
    assert len(status.artifacts) == len(RESULT_BLOCKS) * len(COMPARISON_CODES) + 1


def test_detect_rejects_stale_empty_xlsx_alongside_csv_variant(
    tmp_path: Path,
) -> None:
    adapter = FinalAdapter()
    out_dir = tmp_path / "final"
    out_dir.mkdir()
    for block in RESULT_BLOCKS:
        for code in COMPARISON_CODES:
            _write_xlsx(out_dir / f"{block}_{code}_results.xlsx")
    empty_xlsx = out_dir / "SCI_PvH_results.xlsx"
    empty_xlsx.write_text("")
    valid_csv = out_dir / "SCI_PvH_results.csv"
    valid_csv.write_text("Region,p_value\n")
    (out_dir / "report.html").write_text("<html></html>")

    status = adapter.detect(synthetic_cfg(str(out_dir)), None)

    assert status.state == "failed"
    assert "Remove stale output variants for SCI_PvH" in status.detail
    assert str(valid_csv) in status.artifacts
    assert str(empty_xlsx) not in status.artifacts


def test_parse_failure_none_on_success() -> None:
    assert FinalAdapter().parse_failure(0, "", "") is None


def test_parse_failure_missing_r_package() -> None:
    failure = FinalAdapter().parse_failure(
        1,
        "",
        "Error in loadNamespace(x) : there is no package called 'rmarkdown'",
    )
    assert failure is not None
    assert failure.tag == "r_package_missing"
    assert "rmarkdown and knitr" in failure.message


def test_parse_failure_preserves_unestimable_family_reasons() -> None:
    failure = FinalAdapter().parse_failure(
        1,
        "",
        (
            "Error in run_analysis(...) :\n"
            "  Cannot create all twelve required R analysis result tables. "
            "SUB_PvH: no region has at least 2 nonmissing observations in both "
            "cohorts (maximum SCI_H=2; SCI_P=0)\nExecution halted\n"
        ),
    )

    assert failure is not None
    assert failure.tag == "unestimable_results"
    assert "SUB_PvH" in failure.message
    assert "maximum SCI_H=2; SCI_P=0" in failure.message
    assert "Execution halted" not in failure.message


def test_parse_failure_preserves_input_bound_reason() -> None:
    failure = FinalAdapter().parse_failure(
        1,
        "",
        "Keep dk_all_stats.csv within 5000 cohort rows.\nExecution halted\n",
    )

    assert failure is not None
    assert failure.tag == "input_bounds"
    assert failure.message == "Keep dk_all_stats.csv within 5000 cohort rows."


def test_missing_structural_csv_is_classified_as_missing_input(
    tmp_path: Path,
) -> None:
    # The R preflight must name a missing input distinctly from an
    # oversized one so the failure parser reports missing_input.
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party Step 9 resource.")
    structural_dir = tmp_path / "structural"
    structural_dir.mkdir()
    metadata = tmp_path / "metadata.csv"
    metadata.write_text("SubjectID,Cohort\nsub-01,SCI_H\n", encoding="utf-8")

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [
            rscript,
            str(resources.step9_dir() / PLAIN_SCRIPT),
            str(structural_dir),
            str(metadata),
            str(tmp_path / "final"),
            "5",
            "2",
            "SCI_H,SCI_P,SCI_nNP,SCI",
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "no such file exists" in completed.stderr
    failure = FinalAdapter().parse_failure(
        completed.returncode, completed.stdout, completed.stderr
    )
    assert failure is not None
    assert failure.tag == "missing_input"


def test_parse_failure_rscript_missing() -> None:
    failure = FinalAdapter().parse_failure(127, "", "not found: Rscript")
    assert failure is not None
    assert failure.tag == "rscript_missing"


def test_parse_failure_oom() -> None:
    failure = FinalAdapter().parse_failure(137, "", "")
    assert failure is not None
    assert failure.tag == "oom_killed"


def test_register_registers_final() -> None:
    assert "final" in ADAPTERS
    assert ADAPTERS["final"].advances == ("rep",)


def test_detect_reports_a_corrupt_result_table_as_partial(tmp_path: Path) -> None:
    adapter = FinalAdapter()
    out_dir = tmp_path / "final"
    out_dir.mkdir()
    for block in RESULT_BLOCKS:
        for code in COMPARISON_CODES:
            _write_xlsx(out_dir / f"{block}_{code}_results.xlsx")
    corrupt = out_dir / "SCI_IvH_results.xlsx"
    corrupt.write_text("not-an-xlsx", encoding="utf-8")
    _write_fixed_csvs(out_dir)
    (out_dir / "report.html").write_text("<html></html>")

    status = adapter.detect(synthetic_cfg(str(out_dir)), None)

    assert status.state == "partial"
    assert status.detail == "Repair the malformed R analysis tables: SCI_IvH."


def test_detect_reports_a_single_column_csv_table_as_partial(tmp_path: Path) -> None:
    adapter = FinalAdapter()
    out_dir = tmp_path / "final"
    out_dir.mkdir()
    for block in RESULT_BLOCKS:
        for code in COMPARISON_CODES:
            (out_dir / f"{block}_{code}_results.csv").write_text(
                "Region,p_value\n", encoding="utf-8"
            )
    (out_dir / "SUB_IvH_results.csv").write_text("not-a-table\n", encoding="utf-8")
    _write_fixed_csvs(out_dir)
    cfg = synthetic_cfg(str(out_dir))
    cfg["steps"]["final"]["params"]["renderReport"] = False

    status = adapter.detect(cfg, None)

    assert status.state == "partial"
    assert status.detail == "Repair the malformed R analysis tables: SUB_IvH."


_SITE_COHORT = (
    ("sub-h1", "control", "Prisma", 1),
    ("sub-h2", "control", "Prisma", 2),
    ("sub-h3", "control", "Prisma", 4),
    ("sub-p1", "SCI_P", "Prisma", 5),
    ("sub-p2", "SCI_P", "Prisma", 6),
    ("sub-p3", "SCI_P", "Prisma", 8),
    ("sub-n1", "SCI_nNP", "Prisma", 9),
    ("sub-n2", "SCI_nNP", "Prisma", 10),
    ("sub-n3", "SCI_nNP", "Prisma", 12),
)


def _site_project(
    tmp_path: Path, cohort: tuple[tuple[str, str, str, int], ...], *, site: bool
) -> tuple[Path, Path]:
    """Write Step 8 tables and a metadata CSV, with or without a Site column."""
    structural_dir = tmp_path / "structural"
    structural_dir.mkdir()
    subjects = [(subject, label, base) for subject, label, _site, base in cohort]
    (structural_dir / "dk_all_stats.csv").write_text(
        "subject,cortical_kept,sub_kept\n"
        + "".join(
            f"{subject},{base},{base * base + 1}\n" for subject, _, base in subjects
        ),
        encoding="utf-8",
    )
    _write_step8_companions(structural_dir, subjects)
    metadata = tmp_path / "metadata.csv"
    header = "participant_id,Cohort,Sex,Age" + (",Site" if site else "")
    metadata.write_text(
        header
        + "\n"
        + "".join(
            f"{subject},{label},F,40" + (f",{site_label}" if site else "") + "\n"
            for subject, label, site_label, _base in cohort
        ),
        encoding="utf-8",
    )
    return structural_dir, metadata


def _run_step9(
    rscript: str, structural_dir: Path, metadata: Path, output_dir: Path
) -> subprocess.CompletedProcess[str]:
    """Run the raw track with the adapter's default cohorts and a 2-column split."""
    return subprocess.run(  # noqa: S603 - Execute the reviewed resource with fixed argv.
        [
            rscript,
            _bundle_r(),
            str(structural_dir),
            str(metadata),
            str(output_dir),
            "5",
            "2",
            "SCI_H,SCI_P,SCI_nNP,SCI",
        ],
        check=False,
        capture_output=True,
        text=True,
    )


def _read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def _require_rscript() -> str:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party Step 9 resource.")
    return rscript


def test_step9_one_site_label_leaves_every_table_unchanged(tmp_path: Path) -> None:
    rscript = _require_rscript()
    tables: dict[bool, dict[str, list[dict[str, object]]]] = {}
    for site in (False, True):
        root = tmp_path / ("site" if site else "plain")
        root.mkdir()
        structural_dir, metadata = _site_project(root, _SITE_COHORT, site=site)
        completed = _run_step9(rscript, structural_dir, metadata, root / "final")
        assert completed.returncode == 0, completed.stderr
        tables[site] = {
            path.stem: _read_result_table(path)
            for path in _result_tables(root / "final")
        }
        exclusions = root / "final" / final_r_contract.SITE_EXCLUSIONS_FILE
        assert exclusions.read_text(encoding="utf-8").splitlines() == [
            ",".join(f'"{name}"' for name in final_r_contract.SITE_EXCLUSIONS_COLUMNS)
        ]
    assert len(tables[False]) == 12
    assert tables[True] == tables[False]


def test_step9_effects_are_reference_minus_focal(tmp_path: Path) -> None:
    rscript = _require_rscript()
    structural_dir, metadata = _site_project(tmp_path, _SITE_COHORT, site=False)
    completed = _run_step9(rscript, structural_dir, metadata, tmp_path / "final")
    assert completed.returncode == 0, completed.stderr

    expected = {
        "PvH": ("SCI_H", "SCI_P"),
        "nNPvH": ("SCI_H", "SCI_nNP"),
        "nNPvP": ("SCI_P", "SCI_nNP"),
        "IvH": ("SCI_H", "SCI"),
    }
    for block in RESULT_BLOCKS:
        for code, (ref, foc) in expected.items():
            path = next(
                p
                for p in _result_tables(tmp_path / "final")
                if p.stem == f"{block}_{code}_results"
            )
            for row in _read_result_table(path):
                assert list(row) == list(final_r_contract.RESULT_COLUMNS)
                assert (row["Group_ref"], row["Group_foc"]) == (ref, foc)
                assert row["Direction"] == f"{ref} minus {foc}"
                difference = float(row["Mean_ref"]) - float(row["Mean_foc"])  # type: ignore[arg-type]
                assert float(row["t_statistic"]) * difference > 0  # type: ignore[arg-type]
                assert float(row["Hedges_g"]) * difference > 0  # type: ignore[arg-type]
    # Controls (bases 1, 2, 4) sit below SCI_P (5, 6, 8), so control minus
    # SCI_P is negative: 7 / 3 - 19 / 3 = -4.
    pvh = _read_result_table(
        next(
            p for p in _result_tables(tmp_path / "final") if p.stem == "SCI_PvH_results"
        )
    )[0]
    assert float(pvh["Mean_ref"]) - float(pvh["Mean_foc"]) == pytest.approx(-4)  # type: ignore[arg-type]
    # A blank white matter total is missing, not zero: sub-h1 drops out.
    wm_total = _read_result_table(
        next(
            p for p in _result_tables(tmp_path / "final") if p.stem == "WM_PvH_results"
        )
    )[0]
    assert wm_total["Region"] == "TotalCerebralWM"
    assert (int(wm_total["N_ref"]), int(wm_total["N_foc"])) == (2, 3)  # type: ignore[call-overload]
    assert (int(pvh["N_ref"]), int(pvh["N_foc"])) == (3, 3)  # type: ignore[call-overload]


def test_step9_leaves_out_a_site_without_controls(tmp_path: Path) -> None:
    rscript = _require_rscript()
    cohort = (
        *_SITE_COHORT,
        ("sub-i1", "SCI_P", "Ingenia", 20),
        ("sub-i2", "SCI_P", "Ingenia", 21),
        ("sub-i3", "SCI_nNP", "Ingenia", 22),
        ("sub-i4", "SCI_nNP", "Ingenia", 23),
    )
    structural_dir, metadata = _site_project(tmp_path, cohort, site=True)
    completed = _run_step9(rscript, structural_dir, metadata, tmp_path / "final")
    assert completed.returncode == 0, completed.stderr
    output_dir = tmp_path / "final"

    exclusions = _read_csv_rows(output_dir / final_r_contract.SITE_EXCLUSIONS_FILE)
    assert tuple(exclusions[0]) == final_r_contract.SITE_EXCLUSIONS_COLUMNS
    assert [
        (row["comparison"], row["site"], row["n_ref"], row["n_focal"])
        for row in exclusions
    ] == [
        ("PvH", "Ingenia", "0", "2"),
        ("nNPvH", "Ingenia", "0", "2"),
        ("IvH", "Ingenia", "0", "4"),
    ]
    assert exclusions[2]["excluded_subjects"] == "sub-i1;sub-i2;sub-i3;sub-i4"
    assert exclusions[0]["reason"] == "Site Ingenia has no SCI_H subjects in PvH."

    def counts(stem: str) -> tuple[int, int]:
        # Read the last region, which no subject leaves blank.
        path = next(p for p in _result_tables(output_dir) if p.stem == stem)
        row = _read_result_table(path)[-1]
        return int(row["N_ref"]), int(row["N_foc"])  # type: ignore[call-overload]

    for block in RESULT_BLOCKS:
        assert counts(f"{block}_PvH_results") == (3, 3)
        assert counts(f"{block}_IvH_results") == (3, 6)
        # Ingenia holds both SCI groups, so nNPvP keeps it.
        assert counts(f"{block}_nNPvP_results") == (5, 5)


def test_step9_site_rule_applies_to_nnpvp(tmp_path: Path) -> None:
    rscript = _require_rscript()
    cohort = (
        *_SITE_COHORT,
        ("sub-i1", "SCI_P", "Ingenia", 20),
        ("sub-i2", "control", "Ingenia", 21),
    )
    structural_dir, metadata = _site_project(tmp_path, cohort, site=True)
    completed = _run_step9(rscript, structural_dir, metadata, tmp_path / "final")
    assert completed.returncode == 0, completed.stderr

    exclusions = _read_csv_rows(
        tmp_path / "final" / final_r_contract.SITE_EXCLUSIONS_FILE
    )
    assert [(row["comparison"], row["excluded_subjects"]) for row in exclusions] == [
        ("nNPvH", "sub-i2"),
        ("nNPvP", "sub-i1"),
    ]
    assert exclusions[1]["reason"] == "Site Ingenia has no SCI_nNP subjects in nNPvP."


def test_step9_names_the_site_rule_when_a_comparison_empties(tmp_path: Path) -> None:
    rscript = _require_rscript()
    cohort = (
        ("sub-h1", "control", "Prisma", 1),
        ("sub-h2", "control", "Prisma", 2),
        ("sub-p1", "SCI_P", "Prisma", 5),
        ("sub-p2", "SCI_P", "Prisma", 6),
        ("sub-n1", "SCI_nNP", "Ingenia", 9),
        ("sub-n2", "SCI_nNP", "Ingenia", 10),
    )
    structural_dir, metadata = _site_project(tmp_path, cohort, site=True)
    completed = _run_step9(rscript, structural_dir, metadata, tmp_path / "final")

    assert completed.returncode != 0
    assert "Cannot create all twelve required R analysis result tables" in (
        completed.stderr
    )
    # No site holds both controls and SCI_nNP, or both SCI groups.
    message = " ".join(completed.stderr.split())
    assert (
        "SCI_nNPvH: no region has at least 2 nonmissing observations in both "
        "cohorts (maximum SCI_H=0; SCI_nNP=0) after the site rule left out sites "
        "Ingenia and Prisma"
    ) in message
    assert "WM_nNPvP:" in message
    assert "PvH:" not in message.replace("nNPvH:", "").replace("nNPvP:", "")
    assert not (tmp_path / "final").exists()


def test_step9_refuses_mixed_set_and_empty_sites(tmp_path: Path) -> None:
    rscript = _require_rscript()
    cohort = tuple(
        (subject, label, "" if subject in {"sub-h1", "sub-p1"} else site, base)
        for subject, label, site, base in _SITE_COHORT
    )
    structural_dir, metadata = _site_project(tmp_path, cohort, site=True)
    completed = _run_step9(rscript, structural_dir, metadata, tmp_path / "final")

    assert completed.returncode != 0
    assert (
        "Set a site for sub-h1 and sub-p1; some subjects have a site and these "
        "do not." in " ".join(completed.stderr.split())
    )


def test_step9_keeps_a_site_labeled_na(tmp_path: Path) -> None:
    rscript = _require_rscript()
    cohort = tuple(
        (subject, label, "NA", base) for subject, label, _site, base in _SITE_COHORT
    )
    structural_dir, metadata = _site_project(tmp_path, cohort, site=True)
    completed = _run_step9(rscript, structural_dir, metadata, tmp_path / "final")
    assert completed.returncode == 0, completed.stderr
    rows = _read_csv_rows(tmp_path / "final" / "summary_icv.csv")
    assert {row["Site"] for row in rows} == {"NA"}


def test_step9_summarizes_icv_and_thickness_by_cohort_and_site(
    tmp_path: Path,
) -> None:
    rscript = _require_rscript()
    cohort = (
        *_SITE_COHORT,
        ("sub-i1", "SCI_P", "Ingenia", 20),
        ("sub-i2", "SCI_P", "Ingenia", 22),
    )
    structural_dir, metadata = _site_project(tmp_path, cohort, site=True)
    completed = _run_step9(rscript, structural_dir, metadata, tmp_path / "final")
    assert completed.returncode == 0, completed.stderr

    icv = _read_csv_rows(tmp_path / "final" / "summary_icv.csv")
    assert tuple(icv[0]) == ("Cohort", "Site", "Measure", "N", "Mean", "SD")
    by_key = {(row["Cohort"], row["Site"]): row for row in icv}
    assert set(by_key) == {
        ("SCI_H", "Prisma"),
        ("SCI_P", "Ingenia"),
        ("SCI_P", "Prisma"),
        ("SCI_nNP", "Prisma"),
        ("SCI", "Ingenia"),
        ("SCI", "Prisma"),
    }
    assert by_key[("SCI_P", "Ingenia")]["N"] == "2"
    assert float(by_key[("SCI_P", "Ingenia")]["Mean"]) == pytest.approx(1500021)
    assert by_key[("SCI", "Prisma")]["N"] == "6"
    thickness = _read_csv_rows(tmp_path / "final" / "summary_thickness.csv")
    assert {row["Measure"] for row in thickness} == {
        "lh_mean_thickness",
        "rh_mean_thickness",
    }


def test_step9_requires_the_white_matter_table(tmp_path: Path) -> None:
    rscript = _require_rscript()
    structural_dir, metadata = _site_project(tmp_path, _SITE_COHORT, site=False)
    (structural_dir / "wm_volumes.csv").unlink()
    completed = _run_step9(rscript, structural_dir, metadata, tmp_path / "final")

    assert completed.returncode != 0
    failure = FinalAdapter().parse_failure(
        completed.returncode, completed.stdout, completed.stderr
    )
    assert failure is not None
    assert failure.tag == "missing_input"


def _write_zscores(path: Path) -> None:
    """Write a small BrainCharts z-score table with two sites."""
    columns = (
        "lh_G_front_thickness_zscore",
        "rh_S_temporal_thickness_zscore",
        "Left-Thalamus-Proper_zscore",
    )
    rows = [
        ("sub-h1", "Prisma", "control", -0.2),
        ("sub-h2", "Prisma", "control", 0.1),
        ("sub-h3", "Ingenia", "control", 0.3),
        ("sub-h4", "Ingenia", "control", None),
        ("sub-p1", "Prisma", "SCI_P", -1.2),
        ("sub-p2", "Ingenia", "SCI_P", -0.9),
        ("sub-n1", "Prisma", "SCI_nNP", -0.6),
        ("sub-n2", "Ingenia", "SCI_nNP", -0.4),
    ]
    lines = [",".join((*final_r_contract.ZSCORE_ID_COLUMNS, *columns))]
    for index, (subject, site, cohort, value) in enumerate(rows):
        cells = (
            ["", "", ""]
            if value is None
            else [f"{value + offset / 10:.3f}" for offset in (index % 3, 1, 2)]
        )
        lines.append(",".join((subject, site, cohort, "40", "0", *cells)))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_step9_zscore_track_writes_eight_z_tables(tmp_path: Path) -> None:
    rscript = _require_rscript()
    zscores = tmp_path / final_r_contract.ZSCORES_FILE
    _write_zscores(zscores)
    output_dir = tmp_path / "zstats"

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [
            rscript,
            _bundle_r(),
            final_r_contract.TRACK_FLAG,
            final_r_contract.TRACK_ZSCORES,
            str(zscores),
            str(output_dir),
            "SCI_H,SCI_P,SCI_nNP,SCI",
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    tables = _result_tables(output_dir)
    assert sorted(path.stem for path in tables) == sorted(
        f"{final_r_contract.ZSCORE_TABLE_PREFIX}{block}_{code}_results"
        for block in ("SCI", "SUB")
        for code in COMPARISON_CODES
    )
    assert not (output_dir / final_r_contract.SITE_EXCLUSIONS_FILE).exists()
    by_stem = {path.stem: _read_result_table(path) for path in tables}
    assert {row["Region"] for row in by_stem["Z_SCI_PvH_results"]} == {
        "lh_G_front_thickness_zscore",
        "rh_S_temporal_thickness_zscore",
    }
    assert [row["Region"] for row in by_stem["Z_SUB_IvH_results"]] == [
        "Left-Thalamus-Proper_zscore"
    ]
    ivh = by_stem["Z_SUB_IvH_results"][0]
    # The blank row adapts the model and has no z-score, so it is left out.
    assert (ivh["Group_ref"], ivh["N_ref"], ivh["N_foc"]) == ("SCI_H", 3, 4)
    assert ivh["Direction"] == "SCI_H minus SCI"


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        (["--track", "zscores", "z.csv"], "--track zscores <zscores_csv>"),
        (
            ["--track", "zscores", "--render-report"],
            "--track zscores --render-report",
        ),
        (["--track", "normative"], "Set --track to raw or zscores."),
    ],
)
def test_step9_zscore_track_validates_argv(argv: list[str], message: str) -> None:
    rscript = _require_rscript()
    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [rscript, _bundle_r(), *argv],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert message in completed.stderr


def _knit_report(rscript: str, tmp_path: Path, params: dict[str, str]) -> str:
    """Knit the report template to Markdown with knitr alone (no Pandoc)."""
    probe = subprocess.run(  # noqa: S603 - Probe a fixed R expression.
        [rscript, "-e", 'quit(status = !requireNamespace("knitr", quietly = TRUE))'],
        check=False,
        capture_output=True,
    )
    if probe.returncode != 0:
        pytest.skip("Install knitr to knit the Step 9 report template.")
    template_dir = tmp_path / "template"
    template_dir.mkdir()
    for name in (PLAIN_SCRIPT, RMD_TEMPLATE):
        shutil.copyfile(resources.step9_dir() / name, template_dir / name)
    entries = ", ".join(f"{key} = {value}" for key, value in params.items())
    expression = (
        "env <- new.env(); "
        f"env$params <- list({entries}, "
        "cohorts = c('SCI_H', 'SCI_P', 'SCI_nNP', 'SCI')); "
        f"knitr::knit('{template_dir / RMD_TEMPLATE}', "
        f"output = '{tmp_path / 'report.md'}', envir = env, quiet = TRUE)"
    )
    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [rscript, "-e", expression],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    return " ".join((tmp_path / "report.md").read_text(encoding="utf-8").split())


def test_step9_report_states_the_direction_and_the_left_out_site(
    tmp_path: Path,
) -> None:
    rscript = _require_rscript()
    cohort = (
        *_SITE_COHORT,
        ("sub-i1", "SCI_P", "Ingenia", 20),
        ("sub-i2", "SCI_P", "Ingenia", 21),
        ("sub-i3", "SCI_nNP", "Ingenia", 22),
    )
    structural_dir, metadata = _site_project(tmp_path, cohort, site=True)
    report = _knit_report(
        rscript,
        tmp_path,
        {
            "track": "'raw'",
            "structural_dir": f"'{structural_dir}'",
            "metadata_csv": f"'{metadata}'",
            "zscores_csv": "''",
            "out_dir": f"'{tmp_path / 'final'}'",
            "start_column": "5L",
            "cortical_split": "2L",
        },
    )

    assert (
        "Every effect is reference minus focal, as in upstream's esvis::hedg_g: "
        "SCI_H minus SCI_P (PvH), SCI_H minus SCI_nNP (nNPvH), SCI_P minus "
        "SCI_nNP (nNPvP), and SCI_H minus SCI (IvH)."
    ) in report
    assert "Subjects come from 2 sites: Ingenia and Prisma." in report
    assert (
        "PvH, nNPvH, and IvH leave out site Ingenia (3 SCI subjects) because it "
        "has no controls."
    ) in report
    assert "`WM_IvH_results." in report
    assert "`site_exclusions.csv`" in report


def test_step9_report_states_one_site(tmp_path: Path) -> None:
    rscript = _require_rscript()
    structural_dir, metadata = _site_project(tmp_path, _SITE_COHORT, site=False)
    report = _knit_report(
        rscript,
        tmp_path,
        {
            "track": "'raw'",
            "structural_dir": f"'{structural_dir}'",
            "metadata_csv": f"'{metadata}'",
            "zscores_csv": "''",
            "out_dir": f"'{tmp_path / 'final'}'",
            "start_column": "5L",
            "cortical_split": "2L",
        },
    )
    assert "## Sites All subjects come from one site. ##" in report


def test_step9_zscore_report_states_pooled_sites(tmp_path: Path) -> None:
    rscript = _require_rscript()
    zscores = tmp_path / final_r_contract.ZSCORES_FILE
    _write_zscores(zscores)
    report = _knit_report(
        rscript,
        tmp_path,
        {
            "track": "'zscores'",
            "structural_dir": "''",
            "metadata_csv": "''",
            "zscores_csv": f"'{zscores}'",
            "out_dir": f"'{tmp_path / 'zstats'}'",
            "start_column": "5L",
            "cortical_split": "613L",
        },
    )
    assert (
        "Z-scores are adapted per site, so the comparisons pool sites: Ingenia "
        "(4 subjects) and Prisma (4 subjects)."
    ) in report
    assert "`Z_SUB_IvH_results." in report


def test_the_zscore_track_names_the_refused_sites_contract() -> None:
    source = (resources.step9_dir() / PLAIN_SCRIPT).read_text(encoding="utf-8")
    assert f'REFUSED_SITES_FILE <- "{final_r_contract.REFUSED_SITES_FILE}"' in source
    columns = '", "'.join(final_r_contract.REFUSED_SITES_COLUMNS)
    assert f'REFUSED_SITES_COLUMNS <- c("{columns}")' in source


_REFUSED_HEADER = ",".join(final_r_contract.REFUSED_SITES_COLUMNS)


def _write_refused(directory: Path, *rows: str) -> None:
    (directory / final_r_contract.REFUSED_SITES_FILE).write_text(
        "\n".join((_REFUSED_HEADER, *rows)) + "\n", encoding="utf-8"
    )


def _run_track(
    rscript: str, zscores: Path, out_dir: Path
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603 - Execute the reviewed resource with fixed argv.
        [
            rscript,
            _bundle_r(),
            "--track",
            "zscores",
            str(zscores),
            str(out_dir),
            "SCI_H,SCI_P,SCI_nNP,SCI",
        ],
        check=False,
        capture_output=True,
        text=True,
    )


def _zscore_report(rscript: str, tmp_path: Path, zscores: Path) -> str:
    return _knit_report(
        rscript,
        tmp_path,
        {
            "track": "'zscores'",
            "structural_dir": "''",
            "metadata_csv": "''",
            "zscores_csv": f"'{zscores}'",
            "out_dir": f"'{tmp_path / 'zstats'}'",
            "start_column": "5L",
            "cortical_split": "613L",
        },
    )


def test_the_report_states_each_refused_site(tmp_path: Path) -> None:
    rscript = _require_rscript()
    zscores = tmp_path / final_r_contract.ZSCORES_FILE
    _write_zscores(zscores)
    _write_refused(
        tmp_path,
        'Achieva,1,sub-a1,"Site Achieva has 1 control; adapting the model needs at '
        'least 2."',
        'Signa,6,sub-s1;sub-s2;sub-s3;sub-s4;sub-s5;sub-s6,"Site Signa has no '
        "controls, so the model cannot be adapted to it; its 6 subjects get no "
        'z-scores."',
    )
    report = _zscore_report(rscript, tmp_path, zscores)
    assert (
        "Z-scores are adapted per site, so the comparisons pool sites: Ingenia "
        "(4 subjects) and Prisma (4 subjects). Site Achieva was refused by "
        "BrainCharts and has no rows. Site Signa was refused by BrainCharts and "
        "has no rows."
    ) in report


def test_a_header_only_or_absent_refusal_file_states_no_refusal(
    tmp_path: Path,
) -> None:
    rscript = _require_rscript()
    zscores = tmp_path / final_r_contract.ZSCORES_FILE
    _write_zscores(zscores)
    _write_refused(tmp_path)
    report = _zscore_report(rscript, tmp_path, zscores)
    assert "pool sites: Ingenia (4 subjects) and Prisma (4 subjects). ##" in report
    assert "refused" not in report


def _write_na_site_zscores(path: Path) -> None:
    """Write the two-site z-scores with Ingenia renamed NA and NA z-scores."""
    _write_zscores(path)
    text = path.read_text(encoding="utf-8").replace(",Ingenia,", ",NA,")
    # sub-h4's blank z-scores, spelled as the literal NA.
    text = text.replace(",40,0,,,\n", ",40,0,NA,NA,NA\n")
    assert ",NA,NA,NA\n" in text
    path.write_text(text, encoding="utf-8")


def test_a_site_named_na_is_a_site_in_the_zscore_track(tmp_path: Path) -> None:
    rscript = _require_rscript()
    zscores = tmp_path / final_r_contract.ZSCORES_FILE
    _write_na_site_zscores(zscores)

    completed = _run_track(rscript, zscores, tmp_path / "zstats")
    assert completed.returncode == 0, completed.stderr
    assert len(list((tmp_path / "zstats").glob("Z_*_results.*"))) == 8
    report = _zscore_report(rscript, tmp_path, zscores)
    assert (
        "Z-scores are adapted per site, so the comparisons pool sites: NA "
        "(4 subjects) and Prisma (4 subjects)."
    ) in report


def test_a_refused_site_named_na_with_rows_is_refused(tmp_path: Path) -> None:
    rscript = _require_rscript()
    zscores = tmp_path / final_r_contract.ZSCORES_FILE
    _write_na_site_zscores(zscores)
    _write_refused(
        tmp_path, 'NA,4,sub-h3;sub-h4;sub-p2;sub-n2,"Site NA has no controls."'
    )

    completed = _run_track(rscript, zscores, tmp_path / "zstats")

    assert completed.returncode != 0
    assert (
        "Site NA was refused by BrainCharts but has rows in the z-score CSV."
        in " ".join(completed.stderr.split())
    )
    assert not (tmp_path / "zstats").exists()


@pytest.mark.parametrize(
    ("refused", "message"),
    [
        (
            ("site,subjects\nPrisma,1",),
            "Provide braincharts_refused_sites.csv with the columns site, "
            "subjects, subject_ids, and reason.",
        ),
        (
            ('Ingenia,4,sub-h3;sub-h4;sub-p2;sub-n2,"Site Ingenia has no controls."',),
            "Site Ingenia was refused by BrainCharts but has rows in the z-score CSV.",
        ),
    ],
)
def test_the_track_refuses_a_contradictory_refusal_file(
    tmp_path: Path, refused: tuple[str, ...], message: str
) -> None:
    rscript = _require_rscript()
    zscores = tmp_path / final_r_contract.ZSCORES_FILE
    _write_zscores(zscores)
    if refused[0].startswith("site,"):
        (tmp_path / final_r_contract.REFUSED_SITES_FILE).write_text(
            refused[0] + "\n", encoding="utf-8"
        )
    else:
        _write_refused(tmp_path, *refused)
    completed = _run_track(rscript, zscores, tmp_path / "zstats")
    assert completed.returncode != 0
    assert message in " ".join(completed.stderr.split())
    assert not (tmp_path / "zstats").exists()


def test_csv_outputs_follow_the_final_r_contract() -> None:
    assert CSV_OUTPUTS[0][2] == final_r_contract.SITE_EXCLUSIONS_FILE
    source = (resources.step9_dir() / PLAIN_SCRIPT).read_text(encoding="utf-8")
    assert f'SITE_EXCLUSIONS_FILE <- "{final_r_contract.SITE_EXCLUSIONS_FILE}"' in (
        source
    )
    for _key, _label, basename in CSV_OUTPUTS[1:]:
        assert f'"{basename}"' in source


def test_detect_requires_the_fixed_csv_outputs(tmp_path: Path) -> None:
    adapter = FinalAdapter()
    out_dir = tmp_path / "final"
    out_dir.mkdir()
    for block in RESULT_BLOCKS:
        for code in COMPARISON_CODES:
            _write_xlsx(out_dir / f"{block}_{code}_results.xlsx")
    _write_fixed_csvs(out_dir)
    (out_dir / "site_exclusions.csv").unlink()
    (out_dir / "report.html").write_text("<html></html>")

    status = adapter.detect(synthetic_cfg(str(out_dir)), None)

    assert status.state == "partial"
    assert status.detail == "Create the missing R analysis outputs: site_exclusions."


def _write_cortical_and_subcortical_tables(out_dir: Path) -> None:
    """Write the cortical and subcortical tables and the report only."""
    out_dir.mkdir(parents=True)
    for block in ("SCI", "SUB"):
        for code in COMPARISON_CODES:
            _write_xlsx(out_dir / f"{block}_{code}_results.xlsx")
    (out_dir / "report.html").write_text("<html></html>")


def test_detect_reads_tables_without_the_white_matter_block_as_partial(
    tmp_path: Path,
) -> None:
    out_dir = tmp_path / "final"
    _write_cortical_and_subcortical_tables(out_dir)

    status = FinalAdapter().detect(synthetic_cfg(str(out_dir)), None)

    assert status.state == "partial"
    assert (
        status.detail
        == "Create the missing R analysis outputs: "
        + ", ".join(
            [f"WM_{code}" for code in COMPARISON_CODES]
            + [key for key, _label, _basename in CSV_OUTPUTS]
        )
        + "."
    )
    assert len(status.artifacts) == 2 * len(COMPARISON_CODES) + 1


# -- Knit the report from a writable copy of a read-only template --------------

#: A test double for rmarkdown::render that, like the real one (rmarkdown 2.32),
#: works in the template's directory and writes ``<name>.knit.md`` there.
_RMARKDOWN_DOUBLE = """
render <- function(input, output_format = NULL, output_file = NULL,
                   output_dir = NULL, params = NULL, knit_root_dir = NULL, ...) {
  oldwd <- setwd(dirname(normalizePath(input)))
  on.exit(setwd(oldwd), add = TRUE)
  knit_md <- sub("[.]Rmd$", ".knit.md", basename(input))
  on.exit(unlink(knit_md), add = TRUE)
  writeLines("knit", knit_md)
  writeLines("<html></html>", file.path(output_dir, output_file))
  invisible(file.path(output_dir, output_file))
}
"""


def _read_only_step9(tmp_path: Path) -> Path:
    """Copy the shipped template pair into a directory nobody may write."""
    if os.geteuid() == 0:
        pytest.skip("Run as a non-root user so a read-only directory refuses writes.")
    step9 = tmp_path / "opt" / "resources" / "step9"
    step9.mkdir(parents=True)
    for name in (PLAIN_SCRIPT, RMD_TEMPLATE):
        shutil.copyfile(resources.step9_dir() / name, step9 / name)
    step9.chmod(0o555)
    return step9


def _run_cfg(tmp_path: Path, rscript: str = "/usr/bin/Rscript") -> dict[str, Any]:
    cfg = synthetic_cfg(str(tmp_path / "out" / "final"))
    cfg["steps"]["final"]["params"]["rscriptExecutable"] = rscript
    cfg["_supraspinaRuntime"] = {"runDir": str(tmp_path / "runs" / "run-0123456789ab")}
    return cfg


def test_the_report_knits_from_the_runs_copy_of_the_template(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    step9 = _read_only_step9(tmp_path)
    monkeypatch.setattr(FinalAdapter, "_script_dir", lambda _self, _cfg: str(step9))
    adapter = FinalAdapter()
    cfg = _run_cfg(tmp_path)
    staging = tmp_path / "runs" / "run-0123456789ab" / "work" / "final"
    staging = staging / "report-template"

    bound = provenance.bound_action(adapter, cfg, None)
    launched = adapter.execution_action(cfg, None)
    command = adapter.build_command(cfg, None)

    # The receipt binds the reviewed template.
    assert bound.kind == "process"
    assert list(bound.argv) == command
    assert command[3] == str(step9 / RMD_TEMPLATE)
    # Only the template argument moves; the analysis script stays reviewed.
    assert list(launched.argv) == [
        *command[:3],
        str(staging / RMD_TEMPLATE),
        *command[4:],
    ]

    adapter.prepare_execution(cfg, None)
    adapter.prepare_execution(cfg, None)  # A retry in the same run.

    for name in (PLAIN_SCRIPT, RMD_TEMPLATE):
        assert (staging / name).read_bytes() == (step9 / name).read_bytes()
    assert sorted(path.name for path in staging.iterdir()) == sorted(
        (PLAIN_SCRIPT, RMD_TEMPLATE)
    )
    assert sorted(path.name for path in step9.iterdir()) == sorted(
        (PLAIN_SCRIPT, RMD_TEMPLATE)
    )


def test_tables_only_and_runless_commands_launch_as_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    step9 = _read_only_step9(tmp_path)
    monkeypatch.setattr(FinalAdapter, "_script_dir", lambda _self, _cfg: str(step9))
    adapter = FinalAdapter()

    runless = _run_cfg(tmp_path)
    del runless["_supraspinaRuntime"]
    assert adapter.execution_action(runless, None) == adapter.receipt_action(
        runless, None
    )

    tables_only = _run_cfg(tmp_path)
    tables_only["steps"]["final"]["params"]["renderReport"] = False
    assert adapter.execution_action(tables_only, None) == adapter.receipt_action(
        tables_only, None
    )
    adapter.prepare_execution(tables_only, None)
    assert not (tmp_path / "runs").exists()


def test_a_read_only_template_renders_only_from_the_runs_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rscript = _require_rscript()
    step9 = _read_only_step9(tmp_path)
    monkeypatch.setattr(FinalAdapter, "_script_dir", lambda _self, _cfg: str(step9))
    package = tmp_path / "pkg" / "rmarkdown"
    (package / "R").mkdir(parents=True)
    (package / "DESCRIPTION").write_text(
        "Package: rmarkdown\nVersion: 0.0.1\nTitle: Test Double\n"
        "Description: Writes intermediates beside the template.\nLicense: MIT\n"
        "Author: Supraspina\nMaintainer: Supraspina <test@example.org>\n",
        encoding="utf-8",
    )
    (package / "NAMESPACE").write_text("export(render)\n", encoding="utf-8")
    (package / "R" / "render.R").write_text(_RMARKDOWN_DOUBLE, encoding="utf-8")
    library = tmp_path / "rlib"
    library.mkdir()
    installed = subprocess.run(  # noqa: S603 - Install the fixed test double.
        [
            str(Path(rscript).with_name("R")),
            "CMD",
            "INSTALL",
            "--no-docs",
            "--no-help",
            f"--library={library}",
            str(package),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if installed.returncode != 0:
        pytest.skip(f"Install the rmarkdown test double: {installed.stderr[-500:]}")
    env = {**os.environ, "R_LIBS": str(library)}
    adapter = FinalAdapter()
    cfg = _run_cfg(tmp_path, rscript)

    # The bound command: knitr cannot write beside the template.
    bound = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        list(adapter.receipt_action(cfg, None).argv),
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert bound.returncode != 0
    assert "FreesurferAnalysisScript.knit.md': Permission denied" in bound.stderr

    adapter.prepare_execution(cfg, None)
    launched = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        list(adapter.execution_action(cfg, None).argv),
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert launched.returncode == 0, launched.stderr
    report = tmp_path / "out" / "final" / "report.html"
    assert report.read_text(encoding="utf-8") == "<html></html>\n"
    assert sorted(path.name for path in step9.iterdir()) == sorted(
        (PLAIN_SCRIPT, RMD_TEMPLATE)
    )
