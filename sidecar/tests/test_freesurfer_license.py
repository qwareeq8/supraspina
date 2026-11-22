"""Tests for the FreeSurfer license resolution (freesurfer_license.py).

``.license`` under the FreeSurfer home is FreeSurfer's own fallback, which it
never reaches because Supraspina always exports ``FS_LICENSE``, so the resolver
considers it last. The tests pin that it never moves a selection an
earlier source makes: the resolved path, the ``FS_LICENSE`` export, the
environment evidence the plan binding and receipts digest, and the
registration check's ``environmentSha256`` stay byte-identical to the resolution
without that fallback wherever a project setting, ``FS_LICENSE`` or ``license.txt`` selects the
license. The tests stat real files under ``tmp_path`` and never read a license.
"""

from __future__ import annotations

import itertools
import os
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import registration_check as rc
from supraspina_sidecar.env.freesurfer import FreeSurferProbe
from supraspina_sidecar.freesurfer_environment import freesurfer_runtime_environment
from supraspina_sidecar.freesurfer_license import (
    resolve_freesurfer_home,
    resolve_freesurfer_license_path,
)
from supraspina_sidecar.paths import flatten, interpolate
from supraspina_sidecar.provenance import stable_digest
from supraspina_sidecar.workflow_manager import WorkflowManager

HOME_SOURCES = ("project", "environment", "argument", "none")


def resolve_without_dot_license(
    cfg: dict[str, Any], *, freesurfer_home: str | None = None
) -> str:
    """Resolve the license from the other sources, without the fallback."""
    tools = cfg.get("tools", {})
    configured = tools.get("freesurferLicense") if isinstance(tools, dict) else ""
    configured = configured if isinstance(configured, str) else ""
    selected = configured or os.environ.get("FS_LICENSE", "")
    home = resolve_freesurfer_home(cfg) if freesurfer_home is None else freesurfer_home
    if not selected and home:
        selected = os.path.join(home, "license.txt")
    return interpolate(selected, flatten(cfg)) if selected else ""


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FREESURFER_HOME", raising=False)
    monkeypatch.delenv("FS_LICENSE", raising=False)


def write_home(home: Path, *, license_txt: bool, dot_license: bool) -> Path:
    """Write a FreeSurfer home the registration check accepts."""
    binary = home / "bin" / "mri_surf2surf"
    binary.parent.mkdir(parents=True)
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    for path in rc._atlas_files(str(home / "subjects" / "fsaverage")).values():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Path(path).write_bytes(b"fsaverage atlas stand-in")
    if license_txt:
        (home / "license.txt").write_text("license.txt stand-in\n")
    if dot_license:
        (home / ".license").write_text(".license stand-in\n")
    return home


def license_readings(cfg: dict[str, Any]) -> dict[str, Any]:
    """Collect every value that carries the resolved license path."""
    checks = [check.to_dict() for check in FreeSurferProbe().checks(cfg)]
    report = {"groups": [{"name": "FreeSurfer", "checks": checks}]}
    summary = WorkflowManager._environment_summary(report)
    runtime = freesurfer_runtime_environment(cfg, base_environment={})
    return {
        "resolved": resolve_freesurfer_license_path(cfg),
        "fsLicense": runtime.get("FS_LICENSE"),
        "runtimeEnvironment": runtime,
        "licenseCheck": next(check for check in checks if check["id"] == "license"),
        "environmentEvidence": summary,
        "environmentEvidenceSha256": stable_digest(summary),
        "registrationSha256": rc.environment_digest(rc.freesurfer_availability(cfg)),
    }


def test_the_dot_license_never_moves_an_earlier_selection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    chosen = tmp_path / "chosen" / "license.txt"
    chosen.parent.mkdir()
    chosen.write_text("chosen stand-in\n")
    moved = tmp_path / "moved" / "license.txt"
    projects = ("", str(chosen), str(moved), "${paths.projectRoot}/chosen/license.txt")
    environments = (None, "", str(chosen), str(moved))
    homes: dict[tuple[bool, bool], Path] = {}
    for license_txt, dot_license in itertools.product((False, True), repeat=2):
        home = tmp_path / f"fs-{int(license_txt)}{int(dot_license)}"
        home.mkdir()
        if license_txt:
            (home / "license.txt").write_text("license.txt stand-in\n")
        if dot_license:
            (home / ".license").write_text(".license stand-in\n")
        homes[(license_txt, dot_license)] = home

    moved_by_fallback = 0
    for (license_txt, dot_license), home in homes.items():
        for project, fs_license, home_source in itertools.product(
            projects, environments, HOME_SOURCES
        ):
            cfg: dict[str, Any] = {
                "paths": {"projectRoot": str(tmp_path)},
                "tools": {"freesurferLicense": project},
            }
            kwargs: dict[str, str] = {}
            monkeypatch.delenv("FREESURFER_HOME", raising=False)
            if home_source == "project":
                cfg["tools"]["freesurferHome"] = str(home)
            elif home_source == "environment":
                monkeypatch.setenv("FREESURFER_HOME", str(home))
            elif home_source == "argument":
                kwargs["freesurfer_home"] = str(home)
            if fs_license is None:
                monkeypatch.delenv("FS_LICENSE", raising=False)
            else:
                monkeypatch.setenv("FS_LICENSE", fs_license)

            before = resolve_without_dot_license(cfg, **kwargs)
            after = resolve_freesurfer_license_path(cfg, **kwargs)
            earlier = project or fs_license or license_txt or home_source == "none"
            if earlier or not dot_license:
                assert after == before, (project, fs_license, home_source, home)
            else:
                assert after == str(home / ".license")
                moved_by_fallback += 1
    # Only a home with .license and no license.txt, reached with no project
    # setting and an unset or empty FS_LICENSE, changes: 3 home sources x 2.
    assert moved_by_fallback == 6


@pytest.mark.parametrize("source", ["project", "environment", "license.txt"])
def test_every_license_reading_ignores_a_dot_license_behind_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str
) -> None:
    home = write_home(
        tmp_path / "freesurfer",
        license_txt=source == "license.txt",
        dot_license=False,
    )
    cfg: dict[str, Any] = {
        "paths": {"derivativesDir": str(tmp_path / "derivatives")},
        "tools": {"freesurferHome": str(home)},
    }
    expected = str(home / "license.txt")
    if source != "license.txt":
        selected = tmp_path / "selected" / "license.txt"
        selected.parent.mkdir()
        selected.write_text("selected stand-in\n")
        expected = str(selected)
        if source == "project":
            cfg["tools"]["freesurferLicense"] = expected
        else:
            monkeypatch.setenv("FS_LICENSE", expected)
    without = license_readings(cfg)
    assert without["resolved"] == expected == resolve_without_dot_license(cfg)
    assert without["fsLicense"] == expected
    assert without["licenseCheck"]["status"] == "found"
    assert without["registrationSha256"] is not None

    (home / ".license").write_text(".license stand-in\n")

    assert license_readings(cfg) == without


def test_a_dot_license_alone_serves_every_license_reading(
    tmp_path: Path,
) -> None:
    home = write_home(tmp_path / "freesurfer", license_txt=False, dot_license=True)
    cfg: dict[str, Any] = {"tools": {"freesurferHome": str(home)}}
    dot_license = str(home / ".license")

    readings = license_readings(cfg)
    availability = rc.freesurfer_availability(cfg)

    assert readings["resolved"] == dot_license
    assert readings["fsLicense"] == dot_license
    assert readings["licenseCheck"]["status"] == "found"
    assert availability.available is True
    assert availability.license == dot_license


def test_no_license_under_the_home_still_names_license_txt(
    tmp_path: Path,
) -> None:
    home = write_home(tmp_path / "freesurfer", license_txt=False, dot_license=False)
    cfg: dict[str, Any] = {"tools": {"freesurferHome": str(home)}}

    readings = license_readings(cfg)
    availability = rc.freesurfer_availability(cfg)

    assert readings["resolved"] == str(home / "license.txt")
    assert readings["resolved"] == resolve_without_dot_license(cfg)
    assert readings["fsLicense"] == str(home / "license.txt")
    assert readings["licenseCheck"]["status"] == "missing"
    assert availability.available is False
    assert "license file was not found" in (availability.reason or "")
