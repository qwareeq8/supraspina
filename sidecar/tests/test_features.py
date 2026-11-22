"""Tests for the FreeSurfer feature-extraction adapter (``features`` step)."""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from supraspina_sidecar import resources
from supraspina_sidecar.adapters import features as features_module
from supraspina_sidecar.adapters.features import (
    CONCATENATED_NAME,
    FEATURES_COLUMN_COUNT,
    MODULE_NAME,
    TEMPLATE_NAME,
    FeaturesAdapter,
)


def _cfg(
    out_dir: str, *, fs_home: str = "/opt/fs", measure: str = "thickness"
) -> dict[str, Any]:
    """Return a minimal config with concrete feature paths.

    Default ``fs_home`` to a path without ``bin/fspython`` so the interpreter
    falls back to the running sidecar's Python. Keep the argv deterministic.
    """
    return {
        "paths": {
            "derivativesDir": "/data/proj/derivatives",
            "outputDir": "/data/proj/outputs/run",
        },
        "tools": {"freesurferHome": fs_home},
        "patterns": {"subjectGlob": "sub-*"},
        "steps": {
            "features": {
                "enabled": True,
                "params": {
                    "parcellation": "aparc.a2009s",
                    "measure": measure,
                    "outDir": out_dir,
                    "validateFeatureOrder": True,
                },
            },
        },
    }


def _fastsurfer_cfg(
    out_dir: str,
    *,
    view: str = "/project/.supraspina/runs/run-a/inputs/freesurfer",
    view_subject_ids: list[str] | None = None,
) -> dict[str, Any]:
    cfg = _cfg(out_dir, fs_home="")
    cfg["tools"]["freesurferLicense"] = "/licenses/license.txt"
    cfg["steps"]["recon"] = {
        "enabled": True,
        "params": {
            "backend": "fastsurfer",
            "fastsurferDevice": "cpu",
        },
    }
    cfg["_supraspinaRuntime"] = {
        "freesurferView": view,
        "fastSurferSifPath": "/resources/fastsurfer-cpu.sif",
        "apptainerExecutable": "/usr/bin/apptainer",
    }
    if view_subject_ids is not None:
        cfg["_supraspinaRuntime"]["reconstructionViewSubjectIds"] = view_subject_ids
    return cfg


def _header_line(columns: int) -> str:
    """Build a comma-separated header line with ``columns`` fields and ``ID`` first."""
    fields = [str(i) for i in range(columns)]
    fields[0] = "ID"
    return ",".join(fields) + "\n"


def _default_header() -> list[str]:
    """Return the exact default feature header derived from the pinned template."""
    return FeaturesAdapter()._expected_default_header()


def _load_feature_resource() -> ModuleType:
    """Load the first-party extraction resource for focused semantic checks."""
    path = resources.features_dir() / MODULE_NAME
    spec = importlib.util.spec_from_file_location(
        "extract_features_resource_test", path
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_param_schema_keys() -> None:
    schema = FeaturesAdapter().param_schema()
    assert set(schema) == {
        "parcellation",
        "measure",
        "outDir",
        "validateFeatureOrder",
    }
    assert schema["parcellation"]["default"] == "aparc.a2009s"
    assert schema["parcellation"]["options"] == [
        "aparc.a2009s",
        "aparc.DKTatlas",
        "aparc",
    ]
    assert schema["measure"]["default"] == "thickness"
    assert schema["validateFeatureOrder"]["default"] is True


def test_adapter_identity() -> None:
    adapter = FeaturesAdapter()
    assert adapter.key == "features"
    assert adapter.advances == ("feat",)


def test_build_command_drives_the_bundled_module() -> None:
    cfg = _cfg("/data/proj/outputs/run/features")
    argv = FeaturesAdapter().build_command(cfg, subject_id=None)
    module = str(resources.features_dir() / MODULE_NAME)
    assert argv == [
        sys.executable or "python3",
        module,
        "--subjects-dir",
        "/data/proj/derivatives/freesurfer",
        "--out-dir",
        "/data/proj/outputs/run/features",
        "--parc",
        "aparc.a2009s",
        "--measure",
        "thickness",
        "--subject-glob",
        "sub-*",
        "--aparcstats2table",
        "/opt/fs/bin/aparcstats2table",
        "--asegstats2table",
        "/opt/fs/bin/asegstats2table",
    ]


def test_frozen_build_command_uses_host_python_when_fspython_is_missing(
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

    argv = FeaturesAdapter().build_command(
        _cfg("/out", fs_home="/missing/freesurfer"),
        None,
    )

    assert argv[0] == host_python
    assert frozen_sidecar not in argv


def test_build_command_forwards_measure() -> None:
    # Verify that the measure parameter reaches the tool instead of remaining inert.
    argv = FeaturesAdapter().build_command(_cfg("/out", measure="area"), None)
    assert argv[argv.index("--measure") + 1] == "area"


def test_build_command_omits_tool_paths_without_freesurfer_home() -> None:
    argv = FeaturesAdapter().build_command(_cfg("/out", fs_home=""), None)
    assert "--aparcstats2table" not in argv
    assert argv[argv.index("--subjects-dir") + 1] == "/data/proj/derivatives/freesurfer"


def test_build_command_ignores_subject() -> None:
    cfg = _cfg("/out/features")
    assert FeaturesAdapter().build_command(
        cfg, subject_id="sub-01"
    ) == FeaturesAdapter().build_command(cfg, subject_id=None)


def test_fastsurfer_features_run_stats_tools_inside_verified_container(
    tmp_path: Path,
) -> None:
    view = tmp_path / "run" / "inputs" / "freesurfer"
    argv = FeaturesAdapter().build_command(
        _fastsurfer_cfg(
            "/project/outputs/features",
            view=str(view),
            view_subject_ids=["sub-0012"],
        ),
        None,
    )

    assert argv[:4] == [
        "env",
        "-i",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C",
    ]
    assert argv[4:11] == [
        "/usr/bin/apptainer",
        "exec",
        "--cleanenv",
        "--containall",
        "--no-home",
        "--no-mount",
        "hostfs,cwd,home",
    ]
    assert argv[argv.index("--network") + 1] == "none"
    assert "--net" in argv
    assert "--nv" not in argv
    assert "/resources/fastsurfer-cpu.sif" in argv
    assert "/venv/bin/python3" in argv
    assert "/opt/freesurfer/bin/aparcstats2table" in argv
    assert "/opt/freesurfer/bin/asegstats2table" in argv
    assert sys.executable not in argv
    mounts = [argv[index + 1] for index, value in enumerate(argv) if value == "--mount"]
    assert any(
        f"src={view / 'sub-0012'}" in mount
        and "dst=/supraspina/subjects/sub-0012" in mount
        and mount.endswith(",ro")
        for mount in mounts
    )
    assert not any("dst=/supraspina/subjects,ro" in mount for mount in mounts)
    assert any(
        "src=/project/outputs/features" in mount
        and "dst=/supraspina/output" in mount
        and not mount.endswith(",rw")
        for mount in mounts
    )
    assert all(",rw" not in mount for mount in mounts)
    assert any(
        f"src={resources.features_dir() / MODULE_NAME}" in mount
        and "dst=/supraspina/helper/extract_features.py" in mount
        and mount.endswith(",ro")
        for mount in mounts
    )
    assert any(
        "src=/licenses/license.txt" in mount
        and "dst=/supraspina/license/license.txt" in mount
        and mount.endswith(",ro")
        for mount in mounts
    )


def test_fastsurfer_features_reject_non_symlink_receipt_view_entries(
    tmp_path: Path,
) -> None:
    view = tmp_path / "run" / "inputs" / "freesurfer"
    (view / "sub-0012").mkdir(parents=True)

    with pytest.raises(ValueError, match="receipt-selected symlinks"):
        FeaturesAdapter().build_command(
            _fastsurfer_cfg("/project/outputs/features", view=str(view)),
            None,
        )


def test_fastsurfer_features_bounds_receipt_view_enumeration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    view = tmp_path / "run" / "inputs" / "freesurfer"
    targets = tmp_path / "targets"
    view.mkdir(parents=True)
    targets.mkdir()
    for subject in ("sub-0012", "sub-0013"):
        target = targets / subject
        target.mkdir()
        (view / subject).symlink_to(target, target_is_directory=True)
    monkeypatch.setattr(features_module, "_MAX_RECEIPT_VIEW_SUBJECTS", 1)

    with pytest.raises(ValueError, match="receipt-selected reconstruction view"):
        FeaturesAdapter().build_command(
            _fastsurfer_cfg("/project/outputs/features", view=str(view)),
            None,
        )


def test_fastsurfer_features_do_not_require_host_freesurfer() -> None:
    required = FeaturesAdapter().required_check_ids(
        _fastsurfer_cfg("/project/outputs/features")
    )

    assert required == ("license", "features_assets")
    assert "fshome" not in required
    assert "aparcstats" not in required
    assert "asegstats" not in required


def test_fastsurfer_features_prepare_only_the_output_directory(
    tmp_path: Path,
) -> None:
    output = tmp_path / "features"
    cfg = _fastsurfer_cfg(str(output))

    FeaturesAdapter().prepare_execution(cfg, None)

    assert output.is_dir()


def test_detect_pending_when_missing(tmp_path: Any) -> None:
    out_dir = tmp_path / "features"
    out_dir.mkdir()
    status = FeaturesAdapter().detect(_cfg(str(out_dir)), subject_id=None)
    assert status.state == "pending"
    assert status.artifacts == []


def test_detect_done_with_full_header(tmp_path: Any) -> None:
    out_dir = tmp_path / "features"
    out_dir.mkdir()
    csv_path = out_dir / CONCATENATED_NAME
    header = ",".join(_default_header()) + "\n"
    csv_path.write_text(header + header, encoding="utf-8")
    status = FeaturesAdapter().detect(_cfg(str(out_dir)), subject_id=None)
    assert status.state == "done"
    assert status.artifacts == [os.path.join(str(out_dir), CONCATENATED_NAME)]


def test_detect_partial_with_reordered_default_columns(tmp_path: Any) -> None:
    out_dir = tmp_path / "features"
    out_dir.mkdir()
    header = _default_header()
    header[1], header[2] = header[2], header[1]
    (out_dir / CONCATENATED_NAME).write_text(
        ",".join(header) + "\n",
        encoding="utf-8",
    )

    status = FeaturesAdapter().detect(_cfg(str(out_dir)), subject_id=None)

    assert status.state == "partial"
    assert "column 2" in status.detail
    assert "pinned PyBrainAge feature order" in status.detail


def test_detect_partial_with_wrong_column_count(tmp_path: Any) -> None:
    out_dir = tmp_path / "features"
    out_dir.mkdir()
    (out_dir / CONCATENATED_NAME).write_text(_header_line(10), encoding="utf-8")
    status = FeaturesAdapter().detect(_cfg(str(out_dir)), subject_id=None)
    assert status.state == "partial"
    assert "10 columns" in status.detail


def test_detect_skips_strict_count_for_non_default_measure(tmp_path: Any) -> None:
    # Allow area and volume to differ from the 188-column thickness contract.
    # Apply strict validation only to the default thickness configuration.
    out_dir = tmp_path / "features"
    out_dir.mkdir()
    (out_dir / CONCATENATED_NAME).write_text(_header_line(185), encoding="utf-8")
    cfg = _cfg(str(out_dir), measure="volume")
    status = FeaturesAdapter().detect(cfg, subject_id=None)
    assert status.state == "done"


def test_detect_cannot_disable_default_feature_validation(tmp_path: Any) -> None:
    out_dir = tmp_path / "features"
    out_dir.mkdir()
    (out_dir / CONCATENATED_NAME).write_text(_header_line(10), encoding="utf-8")
    cfg = _cfg(str(out_dir))
    cfg["steps"]["features"]["params"]["validateFeatureOrder"] = False
    status = FeaturesAdapter().detect(cfg, subject_id=None)
    assert status.state == "partial"
    assert "10 columns" in status.detail


def test_default_header_matches_pinned_template_contract() -> None:
    template = resources.features_dir() / TEMPLATE_NAME

    assert template.is_file()
    assert len(_default_header()) == FEATURES_COLUMN_COUNT
    assert _default_header()[0] == "ID"
    assert _default_header()[1] == "lh_G_and_S_frontomargin_thickness"
    assert "Left-Thalamus" in _default_header()
    assert "Left-Thalamus-Proper" not in _default_header()


def test_missing_required_source_column_emits_warning(capsys: Any) -> None:
    module = _load_feature_resource()

    selected = module._select_by_names(
        ["lh_present_thickness", "lh_missing_thickness"],
        ["Measure:thickness", "lh_present_thickness"],
        {"sub-001": ["2.5"]},
    )

    assert selected == {"sub-001": ["2.5", ""]}
    assert capsys.readouterr().err == (
        "Provide all required feature columns; missing: lh_missing_thickness.\n"
    )


def test_feature_resource_bounds_glob_and_generated_table_inputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_feature_resource()
    assert module.MAX_GLOB_MATCHES == module.MAX_SUBJECTS == 5_000
    (tmp_path / "sub-001").mkdir()
    (tmp_path / "sub-002").mkdir()
    monkeypatch.setattr(module, "MAX_GLOB_MATCHES", 1)

    with pytest.raises(ValueError, match="at most 1 matches"):
        module.discover_subjects(str(tmp_path), "sub-*", "aparc.a2009s")

    table = tmp_path / "table.tsv"
    table.write_text("ID\tvalue\nsub-001\t1\n", encoding="utf-8")
    monkeypatch.setattr(module, "MAX_TABLE_BYTES", 4)
    with pytest.raises(ValueError, match="at or below 4 bytes"):
        module._read_table(str(table))


def test_parse_failure_not_sourced() -> None:
    failure = FeaturesAdapter().parse_failure(
        3, "", "aparcstats2table: not found on PATH; source FreeSurfer first"
    )
    assert failure is not None
    assert failure.tag == "freesurfer_not_sourced"


def test_parse_failure_no_subjects() -> None:
    failure = FeaturesAdapter().parse_failure(
        2, "", "no subjects matching 'sub-*' with aparc.a2009s + aseg stats in '/x'"
    )
    assert failure is not None
    assert failure.tag == "no_subjects"


def test_parse_failure_stats_table_failed() -> None:
    failure = FeaturesAdapter().parse_failure(
        4,
        "",
        "Review aparcstats2table lh failed: Report the fixture failure.",
    )
    assert failure is not None
    assert failure.tag == "stats_table_failed"


def test_parse_failure_success_is_none() -> None:
    assert FeaturesAdapter().parse_failure(0, "", "") is None


def test_detect_reports_partial_for_an_empty_concatenated_header(
    tmp_path: Any,
) -> None:
    out_dir = tmp_path / "features"
    out_dir.mkdir()
    (out_dir / CONCATENATED_NAME).write_text("\n", encoding="utf-8")

    status = FeaturesAdapter().detect(
        _cfg(str(out_dir), measure="volume"), subject_id=None
    )

    assert status.state == "partial"
