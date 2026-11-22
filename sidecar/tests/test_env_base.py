"""Tests for check serialization and registration in the environment-probe contract."""

from __future__ import annotations

from supraspina_sidecar.env.base import (
    PROBES,
    Check,
    Installer,
    Probe,
    collapse_status,
    register_probe,
)


def test_check_to_dict_omits_empty_optionals() -> None:
    check = Check(id="x", label="X", status="found")
    assert check.to_dict() == {"id": "x", "label": "X", "status": "found"}


def test_check_to_dict_includes_set_optionals() -> None:
    check = Check(
        id="reconall",
        label="recon-all",
        status="found",
        detail="v8.2.0",
        recommended_cmd="recon-all --version",
        download_url="https://example.org",
    )
    out = check.to_dict()
    assert out["detail"] == "v8.2.0"
    assert out["recommendedCmd"] == "recon-all --version"
    assert out["downloadUrl"] == "https://example.org"
    assert out["installable"] is False
    assert "installer" not in out


def test_check_to_dict_discloses_only_command_installers_as_installable() -> None:
    manual = Check(
        id="mcr",
        label="MATLAB Runtime",
        status="missing",
        recommended_cmd="sudo ./install",
        installer=Installer(kind="manual", one_liner="sudo ./install"),
    )
    command = Check(
        id="pyenv",
        label="Pinned Python environment",
        status="missing",
        recommended_cmd="micromamba create -n pybrainage",
        installer=Installer(
            kind="command", argv=["micromamba", "create", "-n", "pybrainage"]
        ),
    )

    assert manual.to_dict()["installable"] is False
    assert command.to_dict()["installable"] is True
    assert "offlineInstall" not in command.to_dict()


def test_check_to_dict_discloses_an_offline_command_installer() -> None:
    # Only a runnable installer can promise that it downloads nothing; a
    # manual fix never runs, so an offline mark on it is not disclosed.
    offline = Check(
        id="scientific_assets",
        label="Reviewed scientific assets",
        status="missing",
        recommended_cmd="supraspina-sidecar --acquire-scientific-assets",
        installer=Installer(
            kind="command",
            argv=["supraspina-sidecar", "--acquire-scientific-assets"],
            offline=True,
        ),
    )
    manual = Check(
        id="mcr",
        label="MATLAB Runtime",
        status="missing",
        recommended_cmd="sudo ./install",
        installer=Installer(kind="manual", one_liner="sudo ./install", offline=True),
    )

    assert offline.to_dict()["offlineInstall"] is True
    assert offline.to_dict()["installable"] is True
    assert "offlineInstall" not in manual.to_dict()


def test_collapse_status_maps_to_the_top_bar_states() -> None:
    assert collapse_status("found") == "ok"
    assert collapse_status("warn") == "warn"
    assert collapse_status("wrong") == "warn"
    assert collapse_status("missing") == "missing"
    # A deliberately skipped check is neutral, never a missing tool.
    assert collapse_status("skipped") == "na"


def test_register_probe_dedupes_by_name() -> None:
    before = len(PROBES)

    class _Demo(Probe):
        name = "DemoGroupForTest"

        def checks(self, cfg: dict[str, object]) -> list[Check]:
            return [Check(id="d", label="D", status="found")]

    register_probe(_Demo())
    register_probe(_Demo())
    matching = [p for p in PROBES if p.name == "DemoGroupForTest"]
    assert len(matching) == 1
    # Clean the global registry to avoid polluting other tests.
    PROBES[:] = [p for p in PROBES if p.name != "DemoGroupForTest"]
    assert len(PROBES) == before


def test_installer_defaults() -> None:
    manual = Installer(kind="manual")
    assert manual.argv == []
    cmd = Installer(kind="command", argv=["micromamba", "create"])
    assert cmd.argv[0] == "micromamba"
