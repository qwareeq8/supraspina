"""Tests for the structural-aggregation (Step 8) adapter."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from supraspina_sidecar import resources
from supraspina_sidecar.adapters.aggregate import MODULE_NAME, AggregateAdapter

# Expect these four lowercase CSVs from the aggregate_stats.py module.
_CSVS = (
    "dk_all_stats.csv",
    "cortical_thickness.csv",
    "icv_data.csv",
    "wm_volumes.csv",
)

# Write the header row aggregate_stats.py emits for each cohort CSV.
_HEADERS = {
    "dk_all_stats.csv": "subject,lh_bankssts_thickness",
    "cortical_thickness.csv": "subject,lh_mean_thickness,rh_mean_thickness",
    "icv_data.csv": "subject,eTIV",
    "wm_volumes.csv": "subject,TotalCerebralWM,RightCerebralWM,LeftCerebralWM",
}


def _write_cohort_csv(directory: Path, name: str) -> None:
    """Write one structurally valid cohort CSV with a single data row."""
    (directory / name).write_text(f"{_HEADERS[name]}\nsub-001,1\n", encoding="utf-8")


def _load_aggregate_resource() -> ModuleType:
    path = resources.step8_dir() / MODULE_NAME
    spec = importlib.util.spec_from_file_location("aggregate_resource_test", path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _cfg(out_dir: str = "${paths.outputDir}/structural") -> dict[str, Any]:
    """Return a minimal config exercising the placeholders the adapter resolves."""
    return {
        "paths": {
            "projectRoot": "/repo",
            "derivativesDir": "/data/derivatives",
            "outputDir": "/data/outputs/run",
        },
        "tools": {"freesurferHome": "", "pythonExecutable": "/usr/bin/python3"},
        "patterns": {"subjectGlob": "sub-*"},
        "steps": {
            "aggregate": {"enabled": True, "params": {"outDir": out_dir}},
        },
    }


def test_metadata() -> None:
    adapter = AggregateAdapter()
    assert adapter.key == "aggregate"
    assert adapter.advances == ("agg",)
    assert adapter.name


def test_param_schema_keys() -> None:
    schema = AggregateAdapter().param_schema()
    assert set(schema) == {"subjectGlob", "outDir"}
    assert schema["subjectGlob"]["default"] == "sub-*"
    assert schema["outDir"]["default"] == "${paths.outputDir}/structural"


def test_build_command_argv() -> None:
    adapter = AggregateAdapter()
    argv = adapter.build_command(_cfg(), subject_id=None)

    # Drive the bundled module with the configured interpreter, not bash or sed.
    assert argv[0] == "/usr/bin/python3"
    assert argv[1] == str(resources.step8_dir() / MODULE_NAME)
    assert argv[1].endswith("aggregate_stats.py")
    assert argv[2:] == [
        "--subjects-dir",
        "/data/derivatives/freesurfer",
        "--out-dir",
        "/data/outputs/run/structural",
        "--subject-glob",
        "sub-*",
    ]


def test_build_command_prefers_fspython(tmp_path: Path) -> None:
    # Use bundled fspython when freesurferHome provides it.
    fs_home = tmp_path / "fs"
    (fs_home / "bin").mkdir(parents=True)
    (fs_home / "bin" / "fspython").write_text("#!/bin/sh\n")
    cfg = _cfg()
    cfg["tools"]["freesurferHome"] = str(fs_home)
    argv = AggregateAdapter().build_command(cfg, subject_id=None)
    assert argv[0] == str(fs_home / "bin" / "fspython")


def test_frozen_build_command_rejects_sidecar_as_configured_python(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frozen_sidecar = "/opt/Supraspina/resources/sidecar/supraspina-sidecar"
    host_python = "/usr/bin/python3"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", frozen_sidecar)
    monkeypatch.setattr(
        "supraspina_sidecar.adapters.tools.which",
        lambda name: host_python if name == "python3" else None,
    )
    cfg = _cfg()
    cfg["tools"] = {
        "freesurferHome": "/missing/freesurfer",
        "pythonExecutable": frozen_sidecar,
    }

    argv = AggregateAdapter().build_command(cfg, subject_id=None)

    assert argv[0] == host_python
    assert frozen_sidecar not in argv


def test_build_command_ignores_subject_id() -> None:
    adapter = AggregateAdapter()
    assert adapter.build_command(_cfg(), subject_id="sub-001") == adapter.build_command(
        _cfg(), subject_id=None
    )


def test_detect_pending_when_no_csvs(tmp_path: Path) -> None:
    adapter = AggregateAdapter()
    status = adapter.detect(_cfg(out_dir=str(tmp_path)), subject_id=None)
    assert status.state == "pending"
    assert status.artifacts == []


def test_detect_partial_when_some_csvs(tmp_path: Path) -> None:
    (tmp_path / _CSVS[0]).write_text("subject,sub-001\n")
    adapter = AggregateAdapter()
    status = adapter.detect(_cfg(out_dir=str(tmp_path)), subject_id=None)
    assert status.state == "partial"
    assert len(status.artifacts) == 1
    assert "cortical_thickness.csv" in status.detail


def test_detect_done_when_all_csvs(tmp_path: Path) -> None:
    for csv in _CSVS:
        _write_cohort_csv(tmp_path, csv)
    adapter = AggregateAdapter()
    status = adapter.detect(_cfg(out_dir=str(tmp_path)), subject_id=None)
    assert status.state == "done"
    assert len(status.artifacts) == len(_CSVS)


def test_detect_ignores_empty_csv(tmp_path: Path) -> None:
    for csv in _CSVS:
        _write_cohort_csv(tmp_path, csv)
    (tmp_path / _CSVS[2]).write_text(
        ""
    )  # Exclude empty output from the presence count.
    adapter = AggregateAdapter()
    status = adapter.detect(_cfg(out_dir=str(tmp_path)), subject_id=None)
    assert status.state == "partial"
    assert "icv_data.csv" in status.detail


def test_detect_reports_a_corrupt_csv_header_as_partial(tmp_path: Path) -> None:
    for csv in _CSVS:
        _write_cohort_csv(tmp_path, csv)
    (tmp_path / _CSVS[0]).write_text("bogus,header\nsub-001,1\n", encoding="utf-8")

    status = AggregateAdapter().detect(_cfg(out_dir=str(tmp_path)), subject_id=None)

    assert status.state == "partial"
    assert "Repair the malformed structural CSVs: dk_all_stats.csv." in status.detail
    assert all(not path.endswith(_CSVS[0]) for path in status.artifacts)


def test_parse_failure_success() -> None:
    assert AggregateAdapter().parse_failure(0, "", "") is None


def test_parse_failure_no_subjects() -> None:
    failure = AggregateAdapter().parse_failure(
        2, "", "no subjects matching 'sub-*' with lh/rh aparc.stats + aseg.stats"
    )
    assert failure is not None
    assert failure.tag == "no_subjects"


def test_parse_failure_missing_input() -> None:
    failure = AggregateAdapter().parse_failure(
        4, "", "aggregation failed: [Errno 2] No such file or directory"
    )
    assert failure is not None
    assert failure.tag == "missing_input"


def test_dk_all_stats_reserves_final_merge_column_headroom(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The Step 9 merge adds three metadata columns before its own
    # 1024-column bound, so this stage must reject widths the final
    # stage could never accept.
    module = _load_aggregate_resource()
    assert module.MAX_TABLE_COLUMNS - module.FINAL_MERGE_METADATA_COLUMNS == 1_021
    regions = [f"region{index}" for index in range(2)]
    monkeypatch.setattr(module, "_aparc_region_order", lambda _path: list(regions))
    monkeypatch.setattr(module, "_seg_volumes", lambda _path: (["seg"], {"seg": "1"}))
    monkeypatch.setattr(
        module,
        "_aparc_metrics_by_region",
        lambda _path: {region: ["1"] * len(module.APARC_METRICS) for region in regions},
    )
    monkeypatch.setattr(module, "_OUT_DIR", str(tmp_path))
    # The header is subject + 2 hemis * 2 regions * 9 metrics + 1 aseg = 38.
    monkeypatch.setattr(module, "MAX_TABLE_COLUMNS", 40)
    with pytest.raises(ValueError, match="within 37 columns"):
        module._build_dk_all_stats(str(tmp_path), ["sub-01"], "aparc")

    monkeypatch.setattr(module, "MAX_TABLE_COLUMNS", 41)
    module._build_dk_all_stats(str(tmp_path), ["sub-01"], "aparc")
    written = (tmp_path / "dk_all_stats.csv").read_text(encoding="utf-8")
    assert written.startswith("subject,")


def test_aggregate_resource_bounds_globs_and_stats_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_aggregate_resource()
    assert module.MAX_GLOB_MATCHES == module.MAX_SUBJECTS == 5_000
    (tmp_path / "sub-001").mkdir()
    (tmp_path / "sub-002").mkdir()
    monkeypatch.setattr(module, "MAX_GLOB_MATCHES", 1)
    with pytest.raises(ValueError, match="at most 1 matches"):
        module.discover_subjects(str(tmp_path), "sub-*", "aparc")

    stats = tmp_path / "aseg.stats"
    stats.write_text("# Measure value, v, value, 1, unit\n", encoding="utf-8")
    monkeypatch.setattr(module, "MAX_STATS_BYTES", 4)
    with pytest.raises(ValueError, match="at or below 4 bytes"):
        list(module._bounded_lines(str(stats)))

    stats.write_text("first 1\nsecond 2\n", encoding="utf-8")
    monkeypatch.setattr(module, "MAX_STATS_BYTES", 64)
    monkeypatch.setattr(module, "MAX_STATS_DATA_ROWS", 1)
    with pytest.raises(ValueError, match="within 1 data rows"):
        module._data_rows(str(stats))


# Synthetic wmparc.stats header lines in the FreeSurfer 8.2.0 order: the
# hemisphere keys come first and contain the total's key as a substring.
_WM_MEASURES = (
    "# Measure lhCerebralWhiteMatter, lhCerebralWhiteMatterVol, "
    "Left hemisphere cerebral white matter volume, 111.5, mm^3\n"
    "# Measure rhCerebralWhiteMatter, rhCerebralWhiteMatterVol, "
    "Right hemisphere cerebral white matter volume, 222.5, mm^3\n"
    "# Measure CerebralWhiteMatter, CerebralWhiteMatterVol, "
    "Total cerebral white matter volume, 334.0, mm^3\n"
)
_WM_COLHEADERS = "# ColHeaders  Index SegId NVoxels Volume_mm3 StructName normMean\n"


def _write_subject(
    root: Path, subject: str, wmparc_body: str | None, rows: dict[str, str]
) -> None:
    """Write the minimal stats files discovery needs plus an optional wmparc."""
    stats = root / subject / "stats"
    stats.mkdir(parents=True)
    for hemi in ("lh", "rh"):
        (stats / f"{hemi}.aparc.stats").write_text(
            "# Measure Cortex, MeanThickness, Mean Thickness, 2.5, mm\n"
            "bankssts 1 2 3 4 5 6 7 8 9\n",
            encoding="utf-8",
        )
    (stats / "aseg.stats").write_text(
        "# Measure EstimatedTotalIntraCranialVol, eTIV, Estimated TIV, 9.0, mm^3\n"
        "1 4 10 10.0 Left-Lateral-Ventricle 1\n",
        encoding="utf-8",
    )
    if wmparc_body is None:
        return
    lines = [
        f"{index} {3000 + index} 5 {volume} {name} 1\n"
        for index, (name, volume) in enumerate(rows.items(), start=1)
    ]
    (stats / "wmparc.stats").write_text(
        wmparc_body + _WM_COLHEADERS + "".join(lines), encoding="utf-8"
    )


def _run_aggregate(tmp_path: Path) -> list[list[str]]:
    module = _load_aggregate_resource()
    out = tmp_path / "out"
    code = module.main(["--subjects-dir", str(tmp_path / "fs"), "--out-dir", str(out)])
    assert code == 0
    text = (out / "wm_volumes.csv").read_text(encoding="utf-8")
    return [line.split(",") for line in text.splitlines()]


def test_wm_volumes_leads_with_the_upstream_cerebral_wm_totals(
    tmp_path: Path,
) -> None:
    fs = tmp_path / "fs"
    structures = {"wm-lh-bankssts": "40.5", "wm-rh-bankssts": "41.5"}
    _write_subject(fs, "sub-001", _WM_MEASURES, structures)

    rows = _run_aggregate(tmp_path)

    assert rows[0] == [
        "subject",
        "TotalCerebralWM",
        "RightCerebralWM",
        "LeftCerebralWM",
        "wm-lh-bankssts",
        "wm-rh-bankssts",
    ]
    # Exact key matching keeps the total from reading the lh line first.
    assert rows[1] == ["sub-001", "334.0", "222.5", "111.5", "40.5", "41.5"]


def test_wm_volumes_leaves_missing_totals_and_structures_blank(
    tmp_path: Path,
) -> None:
    # Upstream writes 0 for a missing value; a blank keeps it missing.
    fs = tmp_path / "fs"
    both = {"wm-lh-bankssts": "40.5", "wm-rh-bankssts": "41.5"}
    _write_subject(fs, "sub-001", _WM_MEASURES, both)
    only_rh = _WM_MEASURES.splitlines(keepends=True)[1]
    _write_subject(fs, "sub-002", only_rh, {"wm-rh-bankssts": "42.5"})
    _write_subject(fs, "sub-003", "", both)

    rows = _run_aggregate(tmp_path)

    assert rows[2] == ["sub-002", "", "222.5", "", "", "42.5"]
    assert rows[3] == ["sub-003", "", "", "", "40.5", "41.5"]
    assert all("0" not in row[1:4] for row in rows[1:])


def test_wm_volumes_skips_subjects_without_wmparc(tmp_path: Path) -> None:
    fs = tmp_path / "fs"
    _write_subject(fs, "sub-001", None, {})
    _write_subject(fs, "sub-002", _WM_MEASURES, {"wm-lh-bankssts": "40.5"})

    rows = _run_aggregate(tmp_path)

    assert [row[0] for row in rows] == ["subject", "sub-002"]


def test_wm_volumes_writes_the_totals_header_without_any_wmparc(
    tmp_path: Path,
) -> None:
    _write_subject(tmp_path / "fs", "sub-001", None, {})

    rows = _run_aggregate(tmp_path)

    assert rows == [["subject", "TotalCerebralWM", "RightCerebralWM", "LeftCerebralWM"]]


def test_wm_volumes_counts_the_totals_against_the_column_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_aggregate_resource()
    _write_subject(tmp_path, "sub-001", _WM_MEASURES, {"wm-lh-bankssts": "40.5"})
    monkeypatch.setattr(module, "_OUT_DIR", str(tmp_path))
    # The header is subject + 3 totals + 1 structure = 5 columns.
    monkeypatch.setattr(module, "MAX_TABLE_COLUMNS", 4)
    with pytest.raises(ValueError, match="within 4 columns"):
        module._build_wm_volumes(str(tmp_path), ["sub-001"])

    monkeypatch.setattr(module, "MAX_TABLE_COLUMNS", 5)
    module._build_wm_volumes(str(tmp_path), ["sub-001"])
    assert (tmp_path / "wm_volumes.csv").is_file()
