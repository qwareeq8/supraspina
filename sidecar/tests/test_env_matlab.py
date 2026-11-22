"""Tests for the MATLAB and MATLAB Runtime environment probe (matlab.py)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.adapters import tools
from supraspina_sidecar.env import matlab
from supraspina_sidecar.env.base import Check, Probe
from supraspina_sidecar.env.constants import (
    MATLAB_PRODUCT_URL,
    MCR_LANDING_URL,
    MCR_RUNTIME_LIBRARY,
)


def _checks(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """Run the probe and index its checks by id."""
    results = matlab.MatlabProbe().checks(cfg or {})
    return {check.id: check for check in results}


def _mcr_cfg(**params: Any) -> dict[str, Any]:
    """Build a config that selects the MATLAB Runtime ENIGMA backend."""
    return _backend_cfg("mcr", **params)


def _backend_cfg(backend: str, **params: Any) -> dict[str, Any]:
    """Build a config that selects one ENIGMA backend explicitly."""
    return {"steps": {"enigma": {"params": {"backend": backend, **params}}}}


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Neutralize host state so each test starts from a known-empty world."""
    monkeypatch.delenv("MCR_ROOT", raising=False)
    monkeypatch.setattr(tools, "which", lambda _name: None)
    monkeypatch.setattr(tools, "exists", lambda _path: False)
    monkeypatch.setattr(tools, "file_nonempty", lambda _path: False)


def _see_only(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    """Show the probe real files under ``root`` and nothing installed on the host."""

    def inside(path: str) -> bool:
        return Path(path).is_relative_to(root)

    monkeypatch.setattr(tools, "exists", lambda p: inside(p) and Path(p).exists())
    monkeypatch.setattr(
        tools, "file_nonempty", lambda p: inside(p) and Path(p).is_file()
    )


def _write_matlab(root: Path, release: str, *, image_toolbox: bool) -> str:
    """Create a fake MATLABROOT and return the launcher path."""
    (root / "bin").mkdir(parents=True)
    launcher = root / "bin" / "matlab"
    launcher.write_text("#!/bin/sh\n")
    (root / "VersionInfo.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<MathWorks_version_info>\n"
        f"  <release>{release}</release>\n"
        "</MathWorks_version_info>\n"
    )
    if image_toolbox:
        (root / "toolbox" / "images").mkdir(parents=True)
    return str(launcher)


def test_probe_is_registered_and_named() -> None:
    probe = matlab.MatlabProbe()
    assert isinstance(probe, Probe)
    assert probe.name == "MATLAB / MATLAB Runtime"


def test_check_ids_and_order() -> None:
    results = matlab.MatlabProbe().checks({})
    assert [c.id for c in results] == ["matlab", "matlabBoot", "mcr"]


# -- matlab --------------------------------------------------------------------


def test_matlab_found_on_verified_r2026a_release(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Apply no release ceiling. Treat R2026a as the newest end-to-end verified
    # release, and require the Image Processing Toolbox.
    launcher = _write_matlab(tmp_path / "R2026a", "R2026a", image_toolbox=True)
    monkeypatch.setattr(tools, "which", lambda _name: launcher)
    _see_only(monkeypatch, tmp_path)

    check = _checks()["matlab"]

    assert check.status == "found"
    assert "R2026a" in check.detail
    assert "Image Processing Toolbox" in check.detail


def test_matlab_found_when_old_with_image_toolbox(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launcher = _write_matlab(tmp_path / "R2023a", "R2023a", image_toolbox=True)
    cfg = {"steps": {"enigma": {"params": {"matlabExecutable": launcher}}}}
    _see_only(monkeypatch, tmp_path)

    check = _checks(cfg)["matlab"]

    assert check.status == "found"
    assert "R2023a" in check.detail


def test_matlab_warn_when_image_toolbox_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launcher = _write_matlab(tmp_path / "R2022b", "R2022b", image_toolbox=False)
    monkeypatch.setattr(tools, "which", lambda _name: launcher)
    _see_only(monkeypatch, tmp_path)

    check = _checks()["matlab"]

    assert check.status == "warn"
    assert "Image Processing Toolbox" in check.detail


def test_matlab_missing_is_required_when_the_matlab_backend_is_selected() -> None:
    check = _checks()["matlab"]
    assert check.status == "missing"
    assert check.label == "MATLAB"
    # Point at the official MathWorks destination and describe where the
    # executable is configured; licensing stays with the operator.
    assert check.download_url == MATLAB_PRODUCT_URL
    assert "Image Processing Toolbox" in check.detail
    assert "ENIGMA QC configuration" in check.detail
    assert "PATH" in check.detail
    # Never fake a command or an in-app installer for licensed MATLAB.
    assert check.recommended_cmd == ""
    assert check.installer is None
    serialized = check.to_dict()
    assert "recommendedCmd" not in serialized
    assert "installable" not in serialized


def test_matlab_missing_saved_path_keeps_the_official_destination() -> None:
    cfg = {
        "steps": {"enigma": {"params": {"matlabExecutable": "/opt/matlab/bin/matlab"}}}
    }

    check = _checks(cfg)["matlab"]

    assert check.status == "missing"
    assert "was not found: /opt/matlab/bin/matlab." in check.detail
    assert check.download_url == MATLAB_PRODUCT_URL
    assert check.installer is None


@pytest.mark.parametrize("mcr_root", ["", "/opt/mcr/v913", "/opt/mcr/v97"])
def test_selected_mcr_never_requires_source_matlab(
    monkeypatch: pytest.MonkeyPatch, mcr_root: str
) -> None:
    # Ignore an absent source MATLAB whenever MCR is selected, regardless of the
    # runtime state.
    monkeypatch.setattr(tools, "exists", lambda path: path == mcr_root)

    checks = _checks(_mcr_cfg(**({"mcrRoot": mcr_root} if mcr_root else {})))

    assert checks["matlab"].status == "skipped"
    assert checks["matlab"].label == "MATLAB (optional source backend)"
    assert "This backend is optional because MATLAB Runtime is the selected" in (
        checks["matlab"].detail
    )
    assert checks["matlab"].installer is None


def test_selected_matlab_never_requires_the_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "exists", lambda path: path == "/opt/mcr/v913")
    cfg = {
        "steps": {
            "enigma": {"params": {"backend": "matlab", "mcrRoot": "/opt/mcr/v913"}}
        }
    }

    checks = _checks(cfg)

    assert checks["mcr"].status == "skipped"
    assert checks["mcr"].label == "MATLAB Runtime (optional compiled backend)"
    assert "This backend is optional because source MATLAB is the selected" in (
        checks["mcr"].detail
    )


def _root_with_runtime_library(root: str):
    """Build a ``tools.exists`` stub for a runtime root that ships 9.7."""
    library = os.path.join(root, MCR_RUNTIME_LIBRARY)
    return lambda path: path in {root, library}


# -- matlabBoot ----------------------------------------------------------------


def test_matlab_boot_always_skipped() -> None:
    check = _checks()["matlabBoot"]
    assert check.status == "skipped"
    assert check.detail == (
        "Supraspina does not probe the MATLAB cold start because startup is slow; "
        "run MATLAB manually to check it."
    )
    assert check.installer is None


# -- mcr -----------------------------------------------------------------------


def test_mcr_unconfigured_is_headline_blocker_with_manual_installer() -> None:
    check = _checks(_mcr_cfg())["mcr"]
    assert check.status == "missing"
    assert check.detail.startswith("Select the installed R2019b (9.7)")
    assert "compiled ENIGMA QC backend" in check.detail
    assert check.download_url == MCR_LANDING_URL
    assert check.recommended_cmd
    assert check.installer is not None
    assert check.installer.kind == "manual"
    # Keep executable argv out of a manual installer.
    assert check.installer.argv == []
    # Include sudo in the silent-install one-liner.
    assert "sudo" in check.installer.one_liner


def test_mcr_empty_and_nonexistent_paths_read_distinctly() -> None:
    # Give distinct instructions for an unset root and a saved root that vanished.
    empty = _checks(_mcr_cfg(mcrRoot=""))["mcr"]
    absent = _checks(_mcr_cfg(mcrRoot="/usr/local/MATLAB/not-present"))["mcr"]

    assert empty.status == "missing"
    assert empty.detail == (
        "Select the installed R2019b (9.7) MATLAB Runtime root for the compiled "
        "ENIGMA QC backend."
    )
    assert absent.status == "missing"
    assert absent.detail == (
        "Configure an existing MATLAB Runtime root; the saved path was not found: "
        "/usr/local/MATLAB/not-present."
    )


def test_mcr_missing_is_skipped_when_matlab_backend_is_available(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launcher = _write_matlab(tmp_path / "R2026a", "R2026a", image_toolbox=True)
    monkeypatch.setattr(tools, "which", lambda _name: launcher)
    _see_only(monkeypatch, tmp_path)

    check = _checks()["mcr"]

    assert check.status == "skipped"
    assert "This backend is optional because source MATLAB is the selected" in (
        check.detail
    )


def test_unselected_missing_mcr_keeps_its_remediation_while_skipped() -> None:
    # Keep the license-free route visible under an explicit matlab backend:
    # skipped and non-blocking, but with its URL, copyable command, and
    # manual installer intact, plus copy naming the switch requirements.
    check = _checks(_backend_cfg("matlab"))["mcr"]

    assert check.status == "skipped"
    assert check.label == "MATLAB Runtime (optional compiled backend)"
    assert check.download_url == MCR_LANDING_URL
    assert "MATLAB_Runtime_R2019b_Update_9_glnxa64.zip" in check.recommended_cmd
    assert check.installer is not None
    assert check.installer.kind == "manual"
    # Preserve the copy-only sudo boundary on the retained installer.
    assert "sudo" in check.installer.one_liner
    assert "license-free alternative" in check.detail
    assert "selecting the mcr backend" in check.detail
    assert "verified compiled ENIGMA assets" in check.detail
    serialized = check.to_dict()
    assert serialized["status"] == "skipped"
    assert serialized["installable"] is False


def test_unselected_missing_matlab_keeps_the_official_destination() -> None:
    check = _checks(_mcr_cfg())["matlab"]

    assert check.status == "skipped"
    assert check.download_url == MATLAB_PRODUCT_URL
    assert "selecting the matlab backend" in check.detail
    assert check.installer is None


def test_mcr_backend_selection_keeps_mcr_missing_blocking(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launcher = _write_matlab(tmp_path / "R2026a", "R2026a", image_toolbox=True)
    monkeypatch.setattr(tools, "which", lambda _name: launcher)
    _see_only(monkeypatch, tmp_path)

    check = _checks({"steps": {"enigma": {"params": {"backend": "mcr"}}}})["mcr"]

    assert check.status == "missing"
    assert check.installer is not None


def test_mcr_found_via_step_cfg_with_dotted_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = "/opt/MATLAB/MATLAB_Runtime/v97"
    monkeypatch.setattr(tools, "exists", _root_with_runtime_library(root))

    check = _checks({"steps": {"enigma": {"params": {"mcrRoot": root}}}})["mcr"]

    assert check.status == "found"
    assert root in check.detail
    assert "R2019b" in check.detail
    assert "9.7" in check.detail


def _compiled_tree(root: Path, *, executable: bool) -> Path:
    """Build a synthetic ENIGMA asset tree holding the compiled QC binaries."""
    compiled = root / "enigma" / "compiled"
    compiled.mkdir(parents=True)
    for name in matlab._COMPILED_BINARIES:
        binary = compiled / name
        binary.write_bytes(b"compiled QC program")
        binary.chmod(0o700 if executable else 0o600)
    return root / "enigma"


def test_mcr_wrong_when_a_compiled_binary_carries_no_executable_bit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A checkout that delivers the binaries without their executable bit fails
    # at the first QC launcher, so report it before the run starts.
    enigma_dir = _compiled_tree(tmp_path, executable=False)
    monkeypatch.setattr(matlab.resources, "enigma_dir", lambda: enigma_dir)
    root = "/opt/MATLAB/MATLAB_Runtime/v97"
    monkeypatch.setattr(tools, "exists", _root_with_runtime_library(root))

    check = _checks(_mcr_cfg(mcrRoot=root))["mcr"]

    assert check.status == "wrong"
    assert "Make the compiled ENIGMA binaries executable" in check.detail
    for name in matlab._COMPILED_BINARIES:
        assert str(enigma_dir / "compiled" / name) in check.detail
    assert check.recommended_cmd.startswith("chmod +x ")


def test_mcr_found_when_every_compiled_binary_is_executable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    enigma_dir = _compiled_tree(tmp_path, executable=True)
    monkeypatch.setattr(matlab.resources, "enigma_dir", lambda: enigma_dir)
    root = "/opt/MATLAB/MATLAB_Runtime/v97"
    monkeypatch.setattr(tools, "exists", _root_with_runtime_library(root))

    check = _checks(_mcr_cfg(mcrRoot=root))["mcr"]

    assert check.status == "found"
    assert check.recommended_cmd == ""


def test_mcr_backend_ready_marks_absent_source_matlab_optional(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = "/opt/MATLAB/MATLAB_Runtime/v97"
    monkeypatch.setattr(tools, "exists", _root_with_runtime_library(root))

    checks = _checks(_mcr_cfg(mcrRoot=root))

    assert checks["mcr"].status == "found"
    assert checks["mcr"].label == "MATLAB Runtime"
    assert checks["matlab"].status == "skipped"
    assert "This backend is optional because MATLAB Runtime is the selected" in (
        checks["matlab"].detail
    )


def test_mcr_ignores_ambient_env_root(monkeypatch: pytest.MonkeyPatch) -> None:
    # An environment variable is not a conventional install root.
    monkeypatch.setenv("MCR_ROOT", "/srv/mcr/v97")
    monkeypatch.setattr(tools, "exists", _root_with_runtime_library("/srv/mcr/v97"))

    check = _checks(_mcr_cfg())["mcr"]

    assert check.status == "missing"


def test_mcr_ignores_global_tool_root(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = {**_mcr_cfg(), "tools": {"mcrRoot": "/srv/mcr/v97"}}
    monkeypatch.setattr(tools, "exists", _root_with_runtime_library("/srv/mcr/v97"))

    check = _checks(cfg)["mcr"]

    assert check.status == "missing"


@pytest.mark.parametrize(
    "root",
    [
        "/usr/local/MATLAB/MATLAB_Runtime/v97",
        "/usr/local/MATLAB/v97",
        "/opt/MATLAB/MATLAB_Runtime/v97",
        "/opt/mcr/v97",
        "/opt/mcr",
    ],
)
def test_mcr_found_at_a_conventional_root_when_unconfigured(
    monkeypatch: pytest.MonkeyPatch, root: str
) -> None:
    # The recommended one-liner installs below /usr/local/MATLAB, so a blank
    # mcrRoot must still find the runtime it produced.
    monkeypatch.setattr(tools, "exists", _root_with_runtime_library(root))

    assert matlab.ambient_mcr_root() == root
    check = _checks(_mcr_cfg())["mcr"]
    assert check.status == "found"
    assert root in check.detail


def test_auto_backend_uses_the_runtime_and_makes_matlab_optional(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        tools, "exists", _root_with_runtime_library("/usr/local/MATLAB/v97")
    )

    by_id = _checks()
    assert by_id["mcr"].status == "found"
    assert by_id["matlab"].status == "skipped"
    assert "optional" in by_id["matlab"].detail
    assert matlab.effective_enigma_backend({}) == "mcr"


def test_auto_backend_prefers_matlab_when_both_are_found(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = _write_matlab(tmp_path, "R2026a", image_toolbox=True)
    monkeypatch.setattr(
        tools, "which", lambda name: executable if name == "matlab" else None
    )
    library = os.path.join("/opt/mcr/v97", MCR_RUNTIME_LIBRARY)
    _see_only(monkeypatch, tmp_path)
    in_tmp = tools.exists
    monkeypatch.setattr(
        tools,
        "exists",
        lambda path: path in {"/opt/mcr/v97", library} or in_tmp(path),
    )

    by_id = _checks()
    assert by_id["matlab"].status == "found"
    assert by_id["mcr"].status == "found"
    assert matlab.effective_enigma_backend({}) == "matlab"
    assert matlab.effective_enigma_backend(_mcr_cfg()) == "mcr"


def test_auto_backend_with_nothing_installed_blocks_on_either() -> None:
    by_id = _checks()
    assert by_id["matlab"].status == "missing"
    assert by_id["mcr"].status == "missing"
    assert "Install either backend" in by_id["matlab"].detail
    assert "Install either backend" in by_id["mcr"].detail
    assert by_id["mcr"].installer is not None
    assert matlab.effective_enigma_backend({}) == "matlab"


def test_mcr_found_when_the_root_provides_the_required_runtime_library(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Require libmwmclmcrrt.so.9.7 because the compiled binaries load that exact
    # library name.
    monkeypatch.setattr(tools, "exists", _root_with_runtime_library("/opt/mcr/v97"))

    check = _checks(_mcr_cfg(mcrRoot="/opt/mcr/v97"))["mcr"]

    assert check.status == "found"
    assert "R2019b" in check.detail
    assert "9.7" in check.detail
    assert "libmwmclmcrrt.so.9.7" in check.detail


def test_mcr_wrong_when_a_correctly_named_root_lacks_the_runtime_library(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Reject a release-named root that lacks the exact loadable Runtime library.
    # Prevent a false-ready state and a later vendor-binary failure.
    root = tmp_path / "R2023a"
    library_dir = root / "runtime" / "glnxa64"
    library_dir.mkdir(parents=True)
    (library_dir / "libmwmclmcrrt.so.9.14").touch()
    monkeypatch.setattr(tools, "exists", os.path.exists)

    check = _checks(_mcr_cfg(mcrRoot=str(root)))["mcr"]

    assert check.status == "wrong"
    assert "R2023a" in check.detail
    assert "provides 9.14" in check.detail
    assert "libmwmclmcrrt.so.9.7" in check.detail
    assert "R2019b" in check.detail
    assert check.download_url == MCR_LANDING_URL
    assert check.installer is not None
    assert check.installer.kind == "manual"


def test_mcr_wrong_names_an_empty_runtime_directory_plainly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "exists", lambda p: p == "/opt/mcr/garbage")

    check = _checks(_mcr_cfg(mcrRoot="/opt/mcr/garbage"))["mcr"]

    assert check.status == "wrong"
    assert "no runtime/glnxa64 runtime library" in check.detail
    assert "9.7" in check.detail


def test_runtime_version_scan_fails_closed_at_the_entry_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    library_dir = tmp_path / "runtime" / "glnxa64"
    library_dir.mkdir(parents=True)
    (library_dir / "libmwmclmcrrt.so.9.7").touch()
    (library_dir / "extra.txt").touch()
    monkeypatch.setattr(matlab, "_MAX_RUNTIME_DIRECTORY_ENTRIES", 1)

    assert matlab._provided_runtime_versions(str(tmp_path)) == []


def test_matlab_group_survives_non_dict_tools() -> None:
    # Return checks without raising for a malformed tools value, and resolve the
    # selected backend as missing.
    results = matlab.MatlabProbe().checks({"tools": "not-a-dict"})
    by_id = {c.id: c for c in results}

    assert set(by_id) == {"matlab", "matlabBoot", "mcr"}
    assert by_id["matlab"].status == "missing"
    assert by_id["mcr"].status == "missing"


def _patch_backend_checks(
    monkeypatch: pytest.MonkeyPatch, statuses: dict[str, str]
) -> None:
    """Force ``MatlabProbe.checks`` to report the given backend statuses."""

    def fake_checks(_self: Probe, _cfg: dict[str, Any]) -> list[Check]:
        return [
            Check(id=cid, label=cid, status=status)  # type: ignore[arg-type]
            for cid, status in statuses.items()
        ]

    monkeypatch.setattr(matlab.MatlabProbe, "checks", fake_checks)


def test_viable_enigma_backends_maps_found_checks_in_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_backend_checks(
        monkeypatch,
        {"matlab": "wrong", "mcr": "found", "unknown": "found"},
    )
    # Ignore stale unsupported checks, and accept only supported backends.
    assert matlab.viable_enigma_backends({}) == ["mcr"]


def test_viable_enigma_backends_prefers_matlab_when_all_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_backend_checks(
        monkeypatch,
        {"matlab": "found", "mcr": "found"},
    )
    # Prefer the source MATLAB backend over the compiled MCR fallback.
    assert matlab.viable_enigma_backends({}) == ["matlab", "mcr"]


def test_viable_enigma_backends_empty_when_none_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_backend_checks(
        monkeypatch,
        {"matlab": "missing", "mcr": "warn"},
    )
    assert matlab.viable_enigma_backends({}) == []


def test_viable_enigma_backends_empty_on_bare_host() -> None:
    # Use _isolate_env to remove every backend tool, and resolve no viable backend.
    assert matlab.viable_enigma_backends({}) == []
