"""Tests for the platform environment probe (env/platform.py).

The tests stay hermetic by monkeypatching every host signal, including
``os.uname``, ``/etc/os-release``, ``/proc/version``, ``sys.platform``, and
``$DISPLAY``, so nothing depends on the machine running the suite.
"""

from __future__ import annotations

import os
from collections import namedtuple
from typing import Any

import pytest

from supraspina_sidecar.env import base
from supraspina_sidecar.env import platform as platform_probe
from supraspina_sidecar.env.base import PROBES
from supraspina_sidecar.env.platform import PlatformProbe

_FakeUname = namedtuple("_FakeUname", "sysname nodename release version machine")


def _fake_uname() -> _FakeUname:
    """Return a deterministic ``os.uname()`` stand-in."""
    return _FakeUname(
        sysname="Linux",
        nodename="test-host",
        release="6.17.0-1023-oem",
        version="#23-Ubuntu",
        machine="x86_64",
    )


def _checks_by_id(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    """Run the probe and index its checks by id."""
    results = PlatformProbe().checks(cfg if cfg is not None else {})
    return {check.id: check for check in results}


@pytest.fixture
def linux_host(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin a native-Linux host: uname, PRETTY_NAME, not-WSL, DISPLAY set."""
    monkeypatch.setattr(platform_probe.os, "uname", _fake_uname)
    monkeypatch.setattr(platform_probe, "host_mode", lambda: "linux")
    monkeypatch.setattr(platform_probe, "_pretty_name", lambda: "Linux Mint 22.3")
    monkeypatch.setenv("DISPLAY", ":0")


@pytest.mark.usefixtures("linux_host")
def test_check_ids_and_order() -> None:
    results = PlatformProbe().checks({})
    assert [c.id for c in results] == ["os", "mode", "wsl", "display"]


@pytest.mark.usefixtures("linux_host")
def test_os_found_combines_uname_and_pretty_name() -> None:
    check = _checks_by_id()["os"]
    assert check.status == "found"
    assert check.detail == "Linux 6.17.0-1023-oem x86_64 / Linux Mint 22.3"
    assert check.recommended_cmd == "uname -srvmp"
    assert check.installer is None


def test_os_detail_omits_separator_when_pretty_name_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(platform_probe.os, "uname", _fake_uname)
    monkeypatch.setattr(platform_probe, "host_mode", lambda: "linux")
    monkeypatch.setattr(platform_probe, "_pretty_name", lambda: "")
    monkeypatch.setenv("DISPLAY", ":0")

    check = _checks_by_id()["os"]
    assert check.detail == "Linux 6.17.0-1023-oem x86_64"
    assert "/" not in check.detail


@pytest.mark.usefixtures("linux_host")
def test_mode_found_linux() -> None:
    check = _checks_by_id()["mode"]
    assert check.status == "found"
    assert check.detail == "linux (native)"


def test_mode_found_wsl(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(platform_probe.os, "uname", _fake_uname)
    monkeypatch.setattr(platform_probe, "host_mode", lambda: "wsl")
    monkeypatch.setenv("DISPLAY", ":0")

    check = _checks_by_id()["mode"]
    assert check.detail == "wsl (Windows Subsystem for Linux)"


@pytest.mark.usefixtures("linux_host")
def test_wsl_skipped_on_native_linux() -> None:
    check = _checks_by_id()["wsl"]
    assert check.status == "skipped"
    assert check.detail == (
        "Supraspina uses paths as they are, without translation, on this non-WSL host."
    )
    assert check.recommended_cmd == "grep -qi microsoft /proc/version"


def test_wsl_found_under_wsl(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(platform_probe.os, "uname", _fake_uname)
    monkeypatch.setattr(platform_probe, "host_mode", lambda: "wsl")
    monkeypatch.setenv("DISPLAY", ":0")

    check = _checks_by_id()["wsl"]
    assert check.status == "found"
    assert (
        check.detail == "Supraspina translates paths through wslpath on this WSL2 host."
    )


@pytest.mark.usefixtures("linux_host")
def test_display_found_when_set() -> None:
    check = _checks_by_id()["display"]
    assert check.status == "found"
    assert check.detail == "DISPLAY=:0"
    assert check.installer is None


def test_display_warn_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(platform_probe.os, "uname", _fake_uname)
    monkeypatch.setattr(platform_probe, "host_mode", lambda: "linux")
    monkeypatch.delenv("DISPLAY", raising=False)

    check = _checks_by_id()["display"]
    assert check.status == "warn"
    assert "xvfb-run" in check.detail
    assert check.installer is None


@pytest.mark.usefixtures("linux_host")
def test_no_check_carries_an_installer() -> None:
    for check in PlatformProbe().checks({}):
        assert check.installer is None


def test_pretty_name_parses_quoted_value(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    release = tmp_path / "os-release"
    release.write_text('NAME="Linux Mint"\nPRETTY_NAME="Linux Mint 22.3"\n')
    monkeypatch.setattr(platform_probe, "_OS_RELEASE", str(release))
    assert platform_probe._pretty_name() == "Linux Mint 22.3"


def test_pretty_name_missing_file_returns_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(platform_probe, "_OS_RELEASE", "/nonexistent/os-release-xyz")
    assert platform_probe._pretty_name() == ""


def test_host_mode_wsl_for_microsoft_kernel(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    proc = tmp_path / "version"
    proc.write_text("Linux version 5.15.0-microsoft-standard-WSL2\n")
    monkeypatch.setattr(base.sys, "platform", "linux")
    monkeypatch.setattr(base, "_PROC_VERSION", str(proc))
    assert base.host_mode() == "wsl"


def test_host_mode_linux_for_native_kernel(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    proc = tmp_path / "version"
    proc.write_text("Linux version 6.17.0-1023-oem\n")
    monkeypatch.setattr(base.sys, "platform", "linux")
    monkeypatch.setattr(base, "_PROC_VERSION", str(proc))
    assert base.host_mode() == "linux"


def test_host_mode_linux_when_proc_version_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(base.sys, "platform", "linux")
    monkeypatch.setattr(base, "_PROC_VERSION", "/nonexistent/proc-xyz")
    assert base.host_mode() == "linux"


@pytest.mark.parametrize("platform", ["darwin", "win32", "freebsd14"])
def test_host_mode_rejects_unsupported_hosts(
    monkeypatch: pytest.MonkeyPatch, platform: str
) -> None:
    monkeypatch.setattr(base.sys, "platform", platform)
    with pytest.raises(RuntimeError, match="supported Linux host"):
        base.host_mode()


def test_ubuntu_host_true_for_ubuntu_id(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    release = tmp_path / "os-release"
    release.write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
    monkeypatch.setattr(base, "_OS_RELEASE", str(release))
    assert base.ubuntu_host() is True


def test_ubuntu_host_true_for_an_ubuntu_derivative(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    release = tmp_path / "os-release"
    release.write_text('ID=linuxmint\nID_LIKE="ubuntu debian"\n')
    monkeypatch.setattr(base, "_OS_RELEASE", str(release))
    assert base.ubuntu_host() is True


def test_ubuntu_host_unquotes_single_quoted_values(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The os-release format permits single-quoted values.
    release = tmp_path / "os-release"
    release.write_text("ID=neon\nID_LIKE='ubuntu debian'\n")
    monkeypatch.setattr(base, "_OS_RELEASE", str(release))
    assert base.ubuntu_host() is True


def test_ubuntu_host_false_for_other_distributions(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    release = tmp_path / "os-release"
    release.write_text("ID=fedora\n")
    monkeypatch.setattr(base, "_OS_RELEASE", str(release))
    assert base.ubuntu_host() is False


def test_ubuntu_host_false_when_os_release_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Recommend no apt command on an unidentified host.
    monkeypatch.setattr(base, "_OS_RELEASE", "/nonexistent/os-release-xyz")
    assert base.ubuntu_host() is False


def test_probe_registered() -> None:
    assert any(isinstance(p, PlatformProbe) and p.name == "Platform" for p in PROBES)


@pytest.mark.usefixtures("linux_host")
def test_serialized_check_matches_envcheck_shape() -> None:
    os_check = _checks_by_id()["os"]
    payload = os_check.to_dict()
    assert payload["id"] == "os"
    assert payload["status"] == "found"
    assert payload["recommendedCmd"] == "uname -srvmp"
    assert "installer" not in payload


@pytest.mark.usefixtures("linux_host")
def test_checks_tolerate_empty_and_partial_cfg() -> None:
    assert len(PlatformProbe().checks({})) == 4
    assert len(PlatformProbe().checks({"paths": {}})) == 4


@pytest.mark.usefixtures("linux_host")
def test_os_environ_unmodified_after_run() -> None:
    before = dict(os.environ)
    PlatformProbe().checks({})
    assert dict(os.environ) == before
