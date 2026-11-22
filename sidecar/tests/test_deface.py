"""Tests for the optional defacing adapter (step key ``deface``)."""

from __future__ import annotations

import os
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.adapters import tools
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.adapters.deface import DefaceAdapter


def _cfg(derivatives_dir: str, rawdata_dir: str = "/data/rawdata") -> dict[str, Any]:
    """Return a minimal config exercising the deface adapter templates."""
    return {
        "paths": {
            "rawdataDir": rawdata_dir,
            "derivativesDir": derivatives_dir,
        },
        "tools": {"freesurferHome": "/usr/local/freesurfer/8.2.0"},
        "steps": {"deface": {"enabled": False, "params": {}}},
    }


def _fake_which(present: Iterable[str]) -> Callable[[str], str | None]:
    """Return a ``which`` stub reporting only ``present`` executables on PATH."""
    found = set(present)
    return lambda name: f"/usr/bin/{name}" if name in found else None


def test_param_schema_keys() -> None:
    schema = DefaceAdapter().param_schema()
    assert set(schema) == {"tool", "forceOverwrite"}
    assert schema["tool"]["default"] == "mri_deface"
    assert schema["tool"]["options"] == ["mri_deface", "fsl_deface", "pydeface", "skip"]
    assert schema["forceOverwrite"]["default"] is False


def test_advances_is_empty() -> None:
    assert DefaceAdapter().advances == ()


def test_build_command_default_is_mri_deface() -> None:
    # Default to FreeSurfer's mri_deface when no tool overrides it.
    cfg = _cfg("/data/derivatives")
    argv = DefaceAdapter().build_command(cfg, "sub-001")
    assert argv == [
        "mri_deface",
        "/data/rawdata/sub-001/anat/sub-001_T1w.nii.gz",
        "/usr/local/freesurfer/8.2.0/average/talairach_mixed_with_skull.gca",
        "/usr/local/freesurfer/8.2.0/average/face.gca",
        "/data/derivatives/defaced/sub-001/anat/sub-001_T1w.nii.gz",
    ]


def test_build_command_pydeface_force() -> None:
    cfg = _cfg("/data/derivatives")
    cfg["steps"]["deface"]["params"] = {"tool": "pydeface", "forceOverwrite": True}
    argv = DefaceAdapter().build_command(cfg, "sub-001")
    assert argv == [
        "pydeface",
        "/data/rawdata/sub-001/anat/sub-001_T1w.nii.gz",
        "--outfile",
        "/data/derivatives/defaced/sub-001/anat/sub-001_T1w.nii.gz",
        "--force",
    ]


def test_build_command_fsl_deface() -> None:
    cfg = _cfg("/data/derivatives")
    cfg["steps"]["deface"]["params"] = {"tool": "fsl_deface"}
    argv = DefaceAdapter().build_command(cfg, "sub-007")
    assert argv == [
        "fsl_deface",
        "/data/rawdata/sub-007/anat/sub-007_T1w.nii.gz",
        "/data/derivatives/defaced/sub-007/anat/sub-007_T1w.nii.gz",
    ]


def test_build_command_mri_deface_positional_templates() -> None:
    cfg = _cfg("/data/derivatives")
    cfg["steps"]["deface"]["params"] = {"tool": "mri_deface"}
    argv = DefaceAdapter().build_command(cfg, "sub-002")
    assert argv == [
        "mri_deface",
        "/data/rawdata/sub-002/anat/sub-002_T1w.nii.gz",
        "/usr/local/freesurfer/8.2.0/average/talairach_mixed_with_skull.gca",
        "/usr/local/freesurfer/8.2.0/average/face.gca",
        "/data/derivatives/defaced/sub-002/anat/sub-002_T1w.nii.gz",
    ]


def test_build_command_templates_fall_back_to_the_environment_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Match the mri_deface_templates check, which resolves the home from the
    # project field and then the environment, so the gate and the argv agree.
    home = tmp_path / "freesurfer"
    monkeypatch.setenv("FREESURFER_HOME", str(home))
    cfg = _cfg("/data/derivatives")
    cfg["tools"]["freesurferHome"] = ""
    argv = DefaceAdapter().build_command(cfg, "sub-003")
    assert argv == [
        "mri_deface",
        "/data/rawdata/sub-003/anat/sub-003_T1w.nii.gz",
        f"{home}/average/talairach_mixed_with_skull.gca",
        f"{home}/average/face.gca",
        "/data/derivatives/defaced/sub-003/anat/sub-003_T1w.nii.gz",
    ]


def test_build_command_templates_prefer_the_configured_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Keep the project field authoritative over an inherited environment home.
    monkeypatch.setenv("FREESURFER_HOME", str(tmp_path / "inherited"))
    argv = DefaceAdapter().build_command(_cfg("/data/derivatives"), "sub-004")
    assert argv[2:4] == [
        "/usr/local/freesurfer/8.2.0/average/talairach_mixed_with_skull.gca",
        "/usr/local/freesurfer/8.2.0/average/face.gca",
    ]


def test_build_command_templates_stay_unresolved_without_a_home(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Name the field to fill rather than emitting a plausible absolute path.
    monkeypatch.delenv("FREESURFER_HOME", raising=False)
    cfg = _cfg("/data/derivatives")
    cfg["tools"]["freesurferHome"] = ""
    argv = DefaceAdapter().build_command(cfg, "sub-005")
    assert argv[2:4] == [
        "${tools.freesurferHome}/average/talairach_mixed_with_skull.gca",
        "${tools.freesurferHome}/average/face.gca",
    ]


def test_detect_pending_when_absent(tmp_path: Path) -> None:
    cfg = _cfg(str(tmp_path))
    status = DefaceAdapter().detect(cfg, "sub-001")
    assert status.state == "pending"
    assert status.artifacts == []


def test_detect_done_when_artifact_present(tmp_path: Path) -> None:
    cfg = _cfg(str(tmp_path))
    out = tmp_path / "defaced" / "sub-001" / "anat" / "sub-001_T1w.nii.gz"
    out.parent.mkdir(parents=True)
    out.write_bytes(b"\x1f\x8b nifti-gz placeholder")
    status = DefaceAdapter().detect(cfg, "sub-001")
    assert status.state == "done"
    assert status.detail == "The defaced T1w derivative is prepared."
    assert status.artifacts == [str(out)]


def test_detect_describes_skip_output_as_copy_through(tmp_path: Path) -> None:
    cfg = _cfg(str(tmp_path))
    cfg["steps"]["deface"] = {"enabled": True, "params": {"tool": "skip"}}
    out = tmp_path / "defaced" / "sub-001" / "anat" / "sub-001_T1w.nii.gz"
    out.parent.mkdir(parents=True)
    out.write_bytes(b"\x1f\x8b nifti-gz placeholder")

    status = DefaceAdapter().detect(cfg, "sub-001")

    assert status.state == "done"
    assert status.detail == "The copy-through T1w derivative is prepared."


def test_detect_pending_when_empty_artifact(tmp_path: Path) -> None:
    cfg = _cfg(str(tmp_path))
    out = tmp_path / "defaced" / "sub-001" / "anat" / "sub-001_T1w.nii.gz"
    out.parent.mkdir(parents=True)
    out.touch()
    assert os.path.getsize(out) == 0
    status = DefaceAdapter().detect(cfg, "sub-001")
    assert status.state == "pending"


def test_parse_failure_success_is_none() -> None:
    assert DefaceAdapter().parse_failure(0, "", "") is None


def test_parse_failure_missing_input() -> None:
    failure = DefaceAdapter().parse_failure(1, "", "Error: No input image.")
    assert failure is not None
    assert failure.tag == "missing_input"


def test_parse_failure_tool_missing() -> None:
    failure = DefaceAdapter().parse_failure(127, "", "not found: pydeface")
    assert failure is not None
    assert failure.tag == "tool_missing"


def test_validate_disabled_step_has_no_blocking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Do not block on a missing tool while defacing remains disabled.
    monkeypatch.setattr(tools, "which", _fake_which(set()))
    cfg = _cfg("/data/derivatives")  # Disable the defacing step.
    result = DefaceAdapter().validate(cfg, {})
    assert result.blocking == []


def test_validate_enabled_tool_present_has_no_blocking() -> None:
    cfg = _cfg("/data/derivatives")
    cfg["steps"]["deface"] = {"enabled": True, "params": {"tool": "mri_deface"}}
    env = {
        "groups": [
            {
                "checks": [
                    {"id": "mri_deface", "label": "mri_deface", "status": "found"},
                    {
                        "id": "mri_deface_templates",
                        "label": "mri_deface templates",
                        "status": "found",
                    },
                ]
            }
        ]
    }
    result = DefaceAdapter().validate(cfg, env)
    assert result.blocking == []


def test_validate_enabled_tool_missing_blocks_selected_tool() -> None:
    cfg = _cfg("/data/derivatives")
    cfg["steps"]["deface"] = {"enabled": True, "params": {"tool": "pydeface"}}
    env = {
        "groups": [
            {
                "checks": [
                    {"id": "pydeface", "label": "pydeface", "status": "missing"},
                    {"id": "fsl_deface", "label": "fsl_deface", "status": "found"},
                ]
            }
        ]
    }
    result = DefaceAdapter().validate(cfg, env)
    assert len(result.blocking) == 1
    message = result.blocking[0]
    assert "pydeface" in message
    assert "missing" in message


def test_validate_enabled_no_defacer_present_blocks() -> None:
    cfg = _cfg("/data/derivatives")
    cfg["steps"]["deface"] = {"enabled": True, "params": {"tool": "mri_deface"}}
    result = DefaceAdapter().validate(cfg, {})
    assert len(result.blocking) == 2
    assert "mri_deface" in result.blocking[0]


def test_validate_mri_deface_blocks_when_templates_are_missing() -> None:
    cfg = _cfg("/data/derivatives")
    cfg["steps"]["deface"] = {
        "enabled": True,
        "params": {"tool": "mri_deface"},
    }
    env = {
        "groups": [
            {
                "checks": [
                    {"id": "mri_deface", "label": "mri_deface", "status": "found"},
                    {
                        "id": "mri_deface_templates",
                        "label": "mri_deface templates",
                        "status": "missing",
                    },
                ]
            }
        ]
    }

    result = DefaceAdapter().validate(cfg, env)

    assert result.blocking == [
        "Resolve the mri_deface templates check; status: missing."
    ]


def test_validate_skip_tool_has_no_blocking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "which", _fake_which(set()))
    cfg = _cfg("/data/derivatives")
    cfg["steps"]["deface"] = {"enabled": True, "params": {"tool": "skip"}}
    result = DefaceAdapter().validate(cfg, {})
    assert result.blocking == []


def test_register_puts_adapter_in_registry() -> None:
    assert "deface" in ADAPTERS
    assert isinstance(ADAPTERS["deface"], DefaceAdapter)
