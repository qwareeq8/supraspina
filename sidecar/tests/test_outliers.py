"""Tests for the histogram and outlier-review adapter."""

from __future__ import annotations

import csv
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import resources
from supraspina_sidecar.adapters import outliers as outliers_module
from supraspina_sidecar.adapters.base import get
from supraspina_sidecar.adapters.outliers import OutliersAdapter


def _cfg(qc_output_dir: str) -> dict[str, Any]:
    """Return a minimal config with the path and parameter keys the adapter reads."""
    return {
        "paths": {
            "projectRoot": "/repo",
            "qcOutputDir": qc_output_dir,
        },
        "tools": {
            "rscriptExecutable": "/usr/bin/Rscript",
        },
        "steps": {
            "outliers": {
                "enabled": True,
                "params": {"zThreshold": 2.698},
            },
        },
    }


def test_param_schema_keys() -> None:
    schema = OutliersAdapter().param_schema()
    assert set(schema) == {"zThreshold"}
    assert schema["zThreshold"]["default"] == 2.698
    assert all(spec["kind"] == "float" for spec in schema.values())


def test_build_command_resolved_argv() -> None:
    adapter = OutliersAdapter()
    argv = adapter.build_command(_cfg("/out/qc"), subject_id=None)
    assert argv == [
        "/usr/bin/Rscript",
        str(resources.enigma_dir() / "outliers_qc.R"),
        "/out/qc/measures",
        "/out/qc/qa_outliers",
        "2.698",
    ]


def test_build_command_falls_back_to_the_path_interpreter() -> None:
    # Fall back before execve receives an empty argv[0] after plan approval.
    adapter = OutliersAdapter()
    cfg = _cfg("/out/qc")
    cfg["tools"]["rscriptExecutable"] = ""

    argv = adapter.build_command(cfg, subject_id=None)

    assert argv[0] == "Rscript"


def test_build_command_uses_defaults_when_params_absent() -> None:
    adapter = OutliersAdapter()
    cfg = _cfg("/out/qc")
    cfg["steps"]["outliers"]["params"] = {}
    argv = adapter.build_command(cfg, subject_id=None)
    assert argv[-1] == "2.698"


def test_build_command_ignores_subject_id() -> None:
    adapter = OutliersAdapter()
    cfg = _cfg("/out/qc")
    assert adapter.build_command(cfg, "sub-01") == adapter.build_command(cfg, None)


def test_measures_dir_honors_enigma_out_dir_override() -> None:
    # The outlier stage must read the measure tables the ENIGMA stage
    # wrote and the dependency gate validated, not a fixed default the
    # operator may have moved away from.
    adapter = OutliersAdapter()
    cfg = _cfg("/out/qc")
    cfg["steps"]["enigma"] = {
        "enabled": True,
        "params": {"outDir": "/data/qc-v2"},
    }
    argv = adapter.build_command(cfg, subject_id=None)
    assert argv[2] == "/data/qc-v2/measures"
    assert adapter._measures_dir(cfg) == "/data/qc-v2/measures"


def test_members_cover_the_measure_table_subjects_only(tmp_path: Path) -> None:
    # A cohort-wide "done" would otherwise paint a subject the review never
    # saw, such as a reconstruction added after the run, as reviewed.
    adapter = OutliersAdapter()
    assert adapter.members(_cfg(str(tmp_path))) is None
    measures_dir = tmp_path / "measures"
    measures_dir.mkdir()
    (measures_dir / "LandRvolumes.csv").write_text(
        "SubjID,Lthal\nsub-001,1.0\nsub-002,2.0\n", encoding="utf-8"
    )
    (measures_dir / "CorticalMeasuresENIGMA_ThickAvg.csv").write_text(
        "SubjID,LThickness\nsub-003,2.5\n", encoding="utf-8"
    )
    assert adapter.members(_cfg(str(tmp_path))) == frozenset(
        {"sub-001", "sub-002", "sub-003"}
    )


def test_detect_pending_when_no_artifacts(tmp_path: Path) -> None:
    adapter = OutliersAdapter()
    status = adapter.detect(_cfg(str(tmp_path)), subject_id=None)
    assert status.state == "pending"
    assert status.artifacts == []


def test_detect_done_with_both_artifacts(tmp_path: Path) -> None:
    measures_dir = tmp_path / "measures"
    measures_dir.mkdir()
    (measures_dir / "LandRvolumes.csv").write_text(
        "SubjID,Lthal\nsub-001,1.0\n",
        encoding="utf-8",
    )
    qa_dir = tmp_path / "qa_outliers"
    hist_dir = qa_dir / "hist"
    hist_dir.mkdir(parents=True)
    (qa_dir / "outliers.csv").write_text(
        "SubjID,structure,measure,direction,value,lower,upper\n",
        encoding="utf-8",
    )
    histogram = hist_dir / "subcortical_volume__volume__Lthal_hist.png"
    histogram.write_bytes(b"\x89PNG\r\n")
    status = OutliersAdapter().detect(_cfg(str(tmp_path)), subject_id=None)
    assert status.state == "done"
    assert any(a.endswith("outliers.csv") for a in status.artifacts)
    assert any(a.endswith(histogram.name) for a in status.artifacts)


def test_detect_partial_with_only_csv(tmp_path: Path) -> None:
    qa_dir = tmp_path / "qa_outliers"
    qa_dir.mkdir(parents=True)
    (qa_dir / "outliers.csv").write_text("SubjID\n", encoding="utf-8")
    status = OutliersAdapter().detect(_cfg(str(tmp_path)), subject_id=None)
    assert status.state == "partial"
    assert any(a.endswith("outliers.csv") for a in status.artifacts)


def test_detect_partial_with_only_histograms(tmp_path: Path) -> None:
    hist_dir = tmp_path / "qa_outliers" / "hist"
    hist_dir.mkdir(parents=True)
    (hist_dir / "ICV_hist.png").write_bytes(b"\x89PNG\r\n")
    status = OutliersAdapter().detect(_cfg(str(tmp_path)), subject_id=None)
    assert status.state == "partial"


def test_detect_fails_closed_at_the_histogram_entry_limit(
    tmp_path: Path, monkeypatch: Any
) -> None:
    hist_dir = tmp_path / "qa_outliers" / "hist"
    hist_dir.mkdir(parents=True)
    (hist_dir / "first_hist.png").write_bytes(b"png")
    (hist_dir / "extra.txt").write_text("extra", encoding="utf-8")
    monkeypatch.setattr(outliers_module, "_MAX_HISTOGRAM_DIRECTORY_ENTRIES", 1)

    status = OutliersAdapter().detect(_cfg(str(tmp_path)), subject_id=None)

    assert status.state == "failed"
    assert "entry limit" in status.detail


def test_resource_uses_the_third_argument_as_the_z_threshold(
    tmp_path: Path,
) -> None:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party outlier resource.")
    measures_dir = tmp_path / "measures"
    output_dir = tmp_path / "qa_outliers"
    measures_dir.mkdir()
    (measures_dir / "LandRvolumes.csv").write_text(
        "SubjID,Lthal\nsub-01,0\nsub-02,1\nsub-03,10\n",
        encoding="utf-8",
    )
    script = resources.enigma_dir() / "outliers_qc.R"

    subprocess.run(  # noqa: S603 - Execute the reviewed resource with fixed argv.
        [rscript, str(script), str(measures_dir), str(output_dir), "0.5"],
        check=True,
        capture_output=True,
        text=True,
    )

    assert (output_dir / "outliers.csv").is_file()
    assert (
        output_dir / "hist" / "subcortical_volume__volume__Lthal_hist.png"
    ).is_file()
    with (output_dir / "outliers.csv").open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert [(row["SubjID"], row["direction"], float(row["value"])) for row in rows] == [
        ("sub-01", "low", 0.0),
        ("sub-03", "high", 10.0),
    ]
    source = script.read_text(encoding="utf-8")
    assert "as.numeric(args[3])" in source
    assert "iqi" not in source.lower()


def test_detect_skips_validation_of_excluded_measure_columns(
    tmp_path: Path,
) -> None:
    # The R resource never reads excluded columns such as ICV in the
    # ThickAvg table, so a non-numeric token there must not fail a run
    # the analysis completed.
    measures_dir = tmp_path / "measures"
    measures_dir.mkdir()
    (measures_dir / "CorticalMeasuresENIGMA_ThickAvg.csv").write_text(
        "SubjID,L_bankssts_thickavg,ICV\nsub-01,2.5,not-a-number\nsub-02,2.6,1350000\n",
        encoding="utf-8",
    )

    expected = OutliersAdapter()._expected_histograms(_cfg(str(tmp_path)))

    assert expected == {"cortical_thickness__thickness__L_bankssts_thickavg_hist.png"}


def test_resource_rejects_an_all_logical_measure_column(tmp_path: Path) -> None:
    # read.csv type sniffing would turn an all-TRUE/FALSE column into
    # logical 1/0 pseudo-values; the resource must reject the tokens as
    # invalid nonmissing cells instead of computing statistics on them.
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party outlier resource.")
    measures_dir = tmp_path / "measures"
    output_dir = tmp_path / "qa_outliers"
    measures_dir.mkdir()
    (measures_dir / "LandRvolumes.csv").write_text(
        "SubjID,Lthal\nsub-01,TRUE\nsub-02,FALSE\nsub-03,TRUE\n",
        encoding="utf-8",
    )

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [
            rscript,
            str(resources.enigma_dir() / "outliers_qc.R"),
            str(measures_dir),
            str(output_dir),
            "2.698",
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "Provide finite numeric values" in completed.stderr
    assert "Lthal" in completed.stderr


def test_resource_assigns_cortical_semantics_without_histogram_collisions(
    tmp_path: Path,
) -> None:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party outlier resource.")
    measures_dir = tmp_path / "measures"
    output_dir = tmp_path / "qa_outliers"
    measures_dir.mkdir()
    rows = "sub-01,1,2,3,4,5,6\nsub-02,2,3,4,5,6,7\nsub-03,3,4,5,6,7,8\n"
    (measures_dir / "CorticalMeasuresENIGMA_ThickAvg.csv").write_text(
        "SubjID,L_bankssts_thickavg,LThickness,RThickness,LSurfArea,RSurfArea,ICV\n"
        + rows,
        encoding="utf-8",
    )
    (measures_dir / "CorticalMeasuresENIGMA_SurfAvg.csv").write_text(
        "SubjID,L_bankssts_surfavg,LThickness,RThickness,LSurfArea,RSurfArea,ICV\n"
        + rows,
        encoding="utf-8",
    )
    (measures_dir / "LandRvolumes.csv").write_text(
        "SubjID,Lthal,ICV\nsub-01,1,6\nsub-02,2,7\nsub-03,3,8\n",
        encoding="utf-8",
    )

    subprocess.run(  # noqa: S603 - Execute the reviewed resource with fixed argv.
        [
            rscript,
            str(resources.enigma_dir() / "outliers_qc.R"),
            str(measures_dir),
            str(output_dir),
            "2.698",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    names = {path.name for path in (output_dir / "hist").iterdir()}
    assert names == {
        "cortical_thickness__thickness__L_bankssts_thickavg_hist.png",
        "cortical_thickness__thickness__LThickness_hist.png",
        "cortical_thickness__thickness__RThickness_hist.png",
        "cortical_area__area__L_bankssts_surfavg_hist.png",
        "cortical_area__area__LSurfArea_hist.png",
        "cortical_area__area__RSurfArea_hist.png",
        "subcortical_volume__volume__Lthal_hist.png",
        "subcortical_volume__volume__ICV_hist.png",
    }
    assert OutliersAdapter().detect(_cfg(str(tmp_path)), None).state == "done"


@pytest.mark.parametrize("threshold", ["-0.1", "NaN", "Inf"])
def test_resource_rejects_invalid_thresholds(tmp_path: Path, threshold: str) -> None:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party outlier resource.")
    measures_dir = tmp_path / "measures"
    measures_dir.mkdir()
    (measures_dir / "LandRvolumes.csv").write_text(
        "SubjID,Lthal\nsub-01,1\n",
        encoding="utf-8",
    )

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [
            rscript,
            str(resources.enigma_dir() / "outliers_qc.R"),
            str(measures_dir),
            str(tmp_path / "output"),
            threshold,
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "finite value greater than or equal to zero" in completed.stderr


def test_resource_excludes_values_exactly_on_the_threshold_boundary(
    tmp_path: Path,
) -> None:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party outlier resource.")
    measures_dir = tmp_path / "measures"
    output_dir = tmp_path / "output"
    measures_dir.mkdir()
    (measures_dir / "LandRvolumes.csv").write_text(
        "SubjID,Lthal\nsub-01,0\nsub-02,1\nsub-03,2\n",
        encoding="utf-8",
    )

    subprocess.run(  # noqa: S603 - Execute the reviewed resource with fixed argv.
        [
            rscript,
            str(resources.enigma_dir() / "outliers_qc.R"),
            str(measures_dir),
            str(output_dir),
            "1",
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    with (output_dir / "outliers.csv").open(newline="", encoding="utf-8") as handle:
        assert list(csv.DictReader(handle)) == []


def test_resource_preserves_previous_generation_after_invalid_input(
    tmp_path: Path,
) -> None:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party outlier resource.")
    measures_dir = tmp_path / "measures"
    output_dir = tmp_path / "output"
    measures_dir.mkdir()
    output_dir.mkdir()
    marker = output_dir / "previous.txt"
    marker.write_text("complete", encoding="utf-8")
    (measures_dir / "LandRvolumes.csv").write_text(
        "SubjID,Lthal\nsub-01,not-a-number\n",
        encoding="utf-8",
    )

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [
            rscript,
            str(resources.enigma_dir() / "outliers_qc.R"),
            str(measures_dir),
            str(output_dir),
            "2.698",
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "finite numeric values" in completed.stderr
    assert marker.read_text(encoding="utf-8") == "complete"


def test_resource_rejects_oversized_csv_before_reading_it(tmp_path: Path) -> None:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party outlier resource.")
    measures_dir = tmp_path / "measures"
    measures_dir.mkdir()
    oversized = measures_dir / "LandRvolumes.csv"
    with oversized.open("wb") as handle:
        handle.truncate(64 * 1024 * 1024 + 1)

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [
            rscript,
            str(resources.enigma_dir() / "outliers_qc.R"),
            str(measures_dir),
            str(tmp_path / "output"),
            "2.698",
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "within 64 MiB as a regular CSV file" in completed.stderr


def test_resource_rejects_more_than_5000_cohort_rows(tmp_path: Path) -> None:
    rscript = shutil.which("Rscript")
    if rscript is None:
        pytest.skip("Install Rscript to execute the first-party outlier resource.")
    measures_dir = tmp_path / "measures"
    measures_dir.mkdir()
    table = measures_dir / "LandRvolumes.csv"
    table.write_text(
        "SubjID,Lthal\n"
        + "".join(f"sub-{index:04d},{index}\n" for index in range(5001)),
        encoding="utf-8",
    )

    completed = subprocess.run(  # noqa: S603 - Execute reviewed fixed argv.
        [
            rscript,
            str(resources.enigma_dir() / "outliers_qc.R"),
            str(measures_dir),
            str(tmp_path / "output"),
            "2.698",
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "within 5000 cohort rows" in completed.stderr


def test_parse_failure_recognizes_missing_rscript() -> None:
    failure = OutliersAdapter().parse_failure(127, "", "not found: Rscript")
    assert failure is not None
    assert failure.tag == "rscript_missing"


def test_parse_failure_recognizes_input_bounds() -> None:
    failure = OutliersAdapter().parse_failure(
        1, "", "Keep LandRvolumes.csv within 5000 cohort rows.\nExecution halted"
    )
    assert failure is not None
    assert failure.tag == "input_bounds"


def test_parse_failure_none_on_success() -> None:
    assert OutliersAdapter().parse_failure(0, "ok", "") is None


def test_registered_under_key() -> None:
    assert get("outliers").key == "outliers"
