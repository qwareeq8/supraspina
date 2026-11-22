"""Tests for the shell-utilities environment probe (env/shell.py)."""

from __future__ import annotations

from typing import Any

import pytest

from supraspina_sidecar.adapters import ADAPTERS, tools
from supraspina_sidecar.env import shell as shell_probe
from supraspina_sidecar.env.base import PROBES, Check
from supraspina_sidecar.env.constants import DOS2UNIX_PACKAGE_HINT
from supraspina_sidecar.env.shell import ShellProbe


@pytest.fixture(autouse=True)
def _deterministic_host(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default every test to a non-WSL Ubuntu-family host."""
    monkeypatch.setattr(shell_probe, "host_mode", lambda: "linux")
    monkeypatch.setattr(shell_probe, "ubuntu_host", lambda: True)


#: Exercise every required or compatibility tool ID as a found/missing check.
_REQUIRED_IDS = (
    "bash",
    "awk",
    "sed",
    "grep",
    "cat",
    "mkdir",
    "bc",
    "find",
    "curl",
    "sha256sum",
    "unzip",
    "xvfb-run",
)


def _by_id(checks: list[Check]) -> dict[str, Check]:
    """Index a check list by id for direct assertions."""
    return {check.id: check for check in checks}


def _fake_which(present: set[str]) -> Any:
    """Return a ``which`` stub that resolves only names in ``present``."""

    def _which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name in present else None

    return _which


def test_probe_identity_and_registration() -> None:
    assert ShellProbe().name == "Shell utilities"
    assert any(p.name == "Shell utilities" for p in PROBES)


def test_all_required_tools_found(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/tool")
    checks = _by_id(ShellProbe().checks({"platform": {"mode": "linux"}}))
    for tool_id in _REQUIRED_IDS:
        assert checks[tool_id].status == "found"
        assert checks[tool_id].label == tool_id
        assert "/usr/bin/tool" in checks[tool_id].detail


def test_required_tool_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    present = set(_REQUIRED_IDS) - {"xvfb-run"}
    monkeypatch.setattr(tools, "which", _fake_which(present))
    checks = _by_id(ShellProbe().checks({}))
    assert checks["xvfb-run"].status == "missing"
    assert checks["bash"].status == "found"


def test_dos2unix_found(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "which", _fake_which({"dos2unix"}))
    check = _by_id(ShellProbe().checks({}))["dos2unix"]
    assert check.label == "dos2unix (optional)"
    assert check.status == "found"
    assert "/usr/bin/dos2unix" in check.detail
    assert check.recommended_cmd == ""
    assert check.installer is None


def test_dos2unix_found_on_wsl(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shell_probe, "host_mode", lambda: "wsl")
    monkeypatch.setattr(tools, "which", _fake_which({"dos2unix"}))
    check = _by_id(ShellProbe().checks({}))["dos2unix"]
    assert check.status == "found"
    assert "/usr/bin/dos2unix" in check.detail


def test_dos2unix_absent_is_informational_on_linux(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "which", _fake_which(set()))
    check = _by_id(ShellProbe().checks({}))["dos2unix"]
    assert check.label == "dos2unix (optional)"
    assert check.status == "skipped"
    assert "Supraspina never runs dos2unix" in check.detail
    assert "LF" in check.detail
    assert check.recommended_cmd == DOS2UNIX_PACKAGE_HINT
    assert check.installer is not None
    assert check.installer.kind == "manual"
    assert check.installer.argv == []
    assert check.installer.one_liner == DOS2UNIX_PACKAGE_HINT
    serialized = check.to_dict()
    assert serialized["status"] == "skipped"
    assert serialized["recommendedCmd"] == DOS2UNIX_PACKAGE_HINT
    assert serialized["installable"] is False
    assert "action" not in serialized


def test_dos2unix_absent_is_informational_on_wsl(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(shell_probe, "host_mode", lambda: "wsl")
    monkeypatch.setattr(tools, "which", _fake_which(set()))
    check = _by_id(ShellProbe().checks({}))["dos2unix"]
    assert check.status == "skipped"
    assert "Supraspina never runs dos2unix" in check.detail
    assert check.recommended_cmd == DOS2UNIX_PACKAGE_HINT
    assert check.installer is not None
    assert check.installer.kind == "manual"


def test_dos2unix_absent_off_ubuntu_keeps_only_the_fact(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(shell_probe, "ubuntu_host", lambda: False)
    monkeypatch.setattr(tools, "which", _fake_which(set()))
    check = _by_id(ShellProbe().checks({}))["dos2unix"]
    assert check.status == "skipped"
    assert "Supraspina never runs dos2unix" in check.detail
    assert check.recommended_cmd == ""
    assert check.installer is None
    serialized = check.to_dict()
    assert "recommendedCmd" not in serialized
    assert "installable" not in serialized


#: Cover every config-dependent gate branch across the adapter registry.
_GATE_CFG_VARIANTS: tuple[dict[str, Any], ...] = (
    {},
    {
        "steps": {
            "recon": {"params": {"backend": "fastsurfer"}},
            "deface": {"params": {"tool": "fsl_deface"}},
            "enigma": {"params": {"backend": "mcr"}},
            "final": {"params": {"renderReport": False}},
        }
    },
    {
        "steps": {
            "recon": {"params": {"backend": "auto"}},
            "deface": {"params": {"tool": "pydeface"}},
            "final": {"params": {"renderReport": True}},
        },
        "_supraspinaRuntime": {"resolvedReconBackend": "freesurfer"},
    },
    {"steps": {"deface": {"params": {"tool": "skip"}}}},
)


def test_dos2unix_gates_no_adapter() -> None:
    for adapter in ADAPTERS.values():
        assert "dos2unix" not in adapter.required_checks
        for cfg in _GATE_CFG_VARIANTS:
            assert "dos2unix" not in adapter.required_check_ids(cfg)


def test_optional_defacers_found_and_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "which", _fake_which({"fsl_deface"}))
    checks = _by_id(ShellProbe().checks({}))
    assert checks["fsl_deface"].label == "fsl_deface (optional defacer)"
    assert checks["fsl_deface"].status == "found"
    assert checks["pydeface"].label == "pydeface (optional defacer)"
    assert checks["pydeface"].status == "missing"


def test_mri_deface_templates_require_both_configured_files(tmp_path: Any) -> None:
    home = tmp_path / "freesurfer"
    average = home / "average"
    average.mkdir(parents=True)
    (average / "talairach_mixed_with_skull.gca").write_bytes(b"brain")
    checks = _by_id(ShellProbe().checks({"tools": {"freesurferHome": str(home)}}))
    assert checks["mri_deface_templates"].status == "missing"
    assert "1 of 2 is present" in checks["mri_deface_templates"].detail

    (average / "face.gca").write_bytes(b"face")
    checks = _by_id(ShellProbe().checks({"tools": {"freesurferHome": str(home)}}))
    assert checks["mri_deface_templates"].status == "found"


def test_mri_deface_found_under_the_environment_home(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Resolve the binary from $FREESURFER_HOME when PATH does not carry it.
    binary = tmp_path / "freesurfer" / "bin" / "mri_deface"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"#!/bin/sh\n")
    monkeypatch.setenv("FREESURFER_HOME", str(tmp_path / "freesurfer"))
    monkeypatch.setattr(tools, "which", _fake_which(set()))
    check = _by_id(ShellProbe().checks({"tools": {"freesurferHome": ""}}))["mri_deface"]
    assert check.status == "found"
    assert check.detail == str(binary)


def _templates_home(tmp_path: Any) -> Any:
    """Return a FreeSurfer home holding both defacing templates."""
    home = tmp_path / "freesurfer"
    average = home / "average"
    average.mkdir(parents=True)
    (average / "talairach_mixed_with_skull.gca").write_bytes(b"brain")
    (average / "face.gca").write_bytes(b"face")
    return home


def test_mri_deface_templates_fall_back_to_the_environment_home(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Resolve the home like the sibling FreeSurfer checks: cfg, then the
    # environment, so an unconfigured project still finds an installed pair.
    monkeypatch.setenv("FREESURFER_HOME", str(_templates_home(tmp_path)))
    checks = _by_id(ShellProbe().checks({"tools": {"freesurferHome": ""}}))
    assert checks["mri_deface_templates"].status == "found"


def test_mri_deface_templates_prefer_the_configured_home(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Let the project field win so a stale environment cannot mask its home.
    monkeypatch.setenv("FREESURFER_HOME", str(_templates_home(tmp_path / "env")))
    empty = tmp_path / "configured"
    empty.mkdir()
    checks = _by_id(ShellProbe().checks({"tools": {"freesurferHome": str(empty)}}))
    assert checks["mri_deface_templates"].status == "missing"
    assert "0 of 2 are present" in checks["mri_deface_templates"].detail


def test_mri_deface_templates_missing_without_any_home(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("FREESURFER_HOME", raising=False)
    checks = _by_id(ShellProbe().checks({}))
    assert checks["mri_deface_templates"].status == "missing"
    assert "0 of 2 are present" in checks["mri_deface_templates"].detail


def test_wslpath_skipped_outside_wsl(monkeypatch: pytest.MonkeyPatch) -> None:
    # Use host mode as the source of truth, and skip the binary outside WSL.
    monkeypatch.setattr(shell_probe, "host_mode", lambda: "linux")
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/wslpath")
    check = _by_id(ShellProbe().checks({"platform": {"mode": "wsl"}}))["wslpath"]
    assert check.status == "skipped"
    assert check.detail == "wslpath is not needed outside WSL mode."


def test_wslpath_skipped_on_empty_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shell_probe, "host_mode", lambda: "linux")
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/wslpath")
    check = _by_id(ShellProbe().checks({}))["wslpath"]
    assert check.status == "skipped"


def test_wslpath_found_in_wsl(monkeypatch: pytest.MonkeyPatch) -> None:
    # Detect WSL from host_mode even when the config omits it.
    monkeypatch.setattr(shell_probe, "host_mode", lambda: "wsl")
    monkeypatch.setattr(tools, "which", _fake_which({"wslpath"}))
    check = _by_id(ShellProbe().checks({}))["wslpath"]
    assert check.status == "found"
    assert "/usr/bin/wslpath" in check.detail


def test_wslpath_missing_in_wsl(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shell_probe, "host_mode", lambda: "wsl")
    monkeypatch.setattr(tools, "which", _fake_which(set()))
    check = _by_id(ShellProbe().checks({}))["wslpath"]
    assert check.status == "missing"


def test_check_count_and_order(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: None)
    ids = [c.id for c in ShellProbe().checks({})]
    assert ids == [
        "bash",
        "awk",
        "sed",
        "grep",
        "cat",
        "mkdir",
        "bc",
        "find",
        "curl",
        "sha256sum",
        "unzip",
        "xvfb-run",
        "dos2unix",
        "fsl_deface",
        "pydeface",
        "mri_deface",
        "mri_deface_templates",
        "wslpath",
    ]
