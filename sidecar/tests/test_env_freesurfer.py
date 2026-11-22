"""Tests for the FreeSurfer environment probe (env/freesurfer.py).

The tests stay hermetic by monkeypatching the shared tools module,
``os.environ``, ``os.stat``, and the open used to read ``build-stamp.txt``, so
nothing depends on the software installed on the host. The license check is
verified for presence and mode only; neither the probe nor the tests read its
bytes.
"""

from __future__ import annotations

import io
import os
import shlex
import stat
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import env
from supraspina_sidecar.adapters import tools
from supraspina_sidecar.env import freesurfer
from supraspina_sidecar.env.constants import (
    FREESURFER_AUTHORED_RELEASE,
    FREESURFER_DOWNLOAD_URL,
    FREESURFER_REGISTER_URL,
)
from supraspina_sidecar.env.freesurfer import FreeSurferProbe

FSHOME = "/usr/local/freesurfer/8.2.0"
LICENSE = "/data/freesurfer/license.txt"


def fs_config(
    fshome: str = FSHOME,
    license_path: str = LICENSE,
    derivatives: str = "/data/derivatives",
) -> dict[str, Any]:
    """Return a minimal config carrying the FreeSurfer paths the probe reads."""
    return {
        "paths": {"derivativesDir": derivatives},
        "tools": {
            "freesurferHome": fshome,
            "freesurferLicense": license_path,
        },
    }


def by_id(checks: list[Any]) -> dict[str, Any]:
    return {c.id: c for c in checks}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip FreeSurfer env vars so cfg-vs-env precedence is deterministic."""
    monkeypatch.delenv("FREESURFER_HOME", raising=False)
    monkeypatch.delenv("FS_LICENSE", raising=False)


@dataclass
class FakeTree:
    """Represent a synthetic FreeSurfer tree for the shared tools and OS helpers."""

    dirs: set[str] = field(default_factory=set)
    files: set[str] = field(default_factory=set)
    nonempty: set[str] = field(default_factory=set)
    on_path: dict[str, str] = field(default_factory=dict)
    license_mode: int = 0o600
    stamp: str | None = None


def _patch_present(monkeypatch: pytest.MonkeyPatch, tree: FakeTree) -> None:
    """Wire the shared tools + os helpers to a fully synthetic FreeSurfer tree."""
    existing = tree.dirs | tree.files

    monkeypatch.setattr(tools, "exists", lambda p: p in existing)
    monkeypatch.setattr(tools, "file_nonempty", lambda p: p in tree.nonempty)
    monkeypatch.setattr(tools, "which", tree.on_path.get)

    real_stat = freesurfer.os.stat
    real_lstat = freesurfer.os.lstat

    class _FakeStat:
        st_mode = stat.S_IFREG | tree.license_mode

    class _FakeDirStat:
        st_mode = stat.S_IFDIR | 0o755

    def fake_stat(path: str, *args: Any, **kwargs: Any) -> Any:
        if path in tree.dirs:
            return _FakeDirStat()
        if path in tree.files:
            return _FakeStat()
        return real_stat(path, *args, **kwargs)

    def fake_lstat(path: str, *args: Any, **kwargs: Any) -> Any:
        if path in tree.dirs:
            return _FakeDirStat()
        if path in tree.files:
            return _FakeStat()
        if path == "/data/derivatives/freesurfer":
            raise FileNotFoundError(path)
        return real_lstat(path, *args, **kwargs)

    monkeypatch.setattr(freesurfer.os, "stat", fake_stat)
    monkeypatch.setattr(
        freesurfer.os,
        "lstat",
        fake_lstat,
    )
    # Answer every probe from the synthetic tree. Falling through to the real
    # filesystem made the outcome depend on the running user, because root
    # passes a write probe on directories nobody else may write.
    monkeypatch.setattr(freesurfer.os, "access", lambda path, mode: path in tree.dirs)

    if tree.stamp is not None:

        def fake_open(*_args: Any, **_kwargs: Any) -> Any:
            return io.StringIO(tree.stamp + "\n")

        monkeypatch.setattr(freesurfer, "open", fake_open, raising=False)


def test_all_found_live_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    """Warn when the install, binaries, and license exist but SUBJECTS_DIR does not."""
    bins = {
        f"{FSHOME}/bin/{b}"
        for b in (
            "recon-all",
            "aparcstats2table",
            "asegstats2table",
            "mri_segstats",
        )
    }
    stamp_file = f"{FSHOME}/build-stamp.txt"
    _patch_present(
        monkeypatch,
        FakeTree(
            dirs={FSHOME, "/data/derivatives"},
            files=bins | {stamp_file, LICENSE},
            nonempty={stamp_file, LICENSE},
            license_mode=0o600,
            stamp="freesurfer-linux-ubuntu24_x86_64-8.2.0-20260314-d932c45",
        ),
    )

    checks = by_id(FreeSurferProbe().checks(fs_config()))

    assert checks["fshome"].status == "found"
    assert "8.2.0" in checks["fshome"].detail
    assert checks["fshome"].download_url == FREESURFER_DOWNLOAD_URL

    assert checks["reconall"].status == "found"
    assert FREESURFER_AUTHORED_RELEASE in checks["reconall"].detail
    assert "remain valid on 8.x" in checks["reconall"].detail
    assert "keep one FreeSurfer version throughout each cohort" in (
        checks["reconall"].detail
    )

    assert checks["aparcstats"].status == "found"
    assert checks["asegstats"].status == "found"
    assert checks["mriseg"].status == "found"

    assert checks["license"].status == "found"
    assert checks["license"].detail == "The license file is present with mode 600."

    assert checks["subjdir"].status == "warn"
    assert checks["subjdir"].detail.startswith("Create /data/derivatives/freesurfer")


def test_release_falls_back_to_dir_tail(monkeypatch: pytest.MonkeyPatch) -> None:
    """Derive the release from the install directory when build-stamp.txt is absent."""
    bins = {
        f"{FSHOME}/bin/{b}"
        for b in (
            "recon-all",
            "aparcstats2table",
            "asegstats2table",
            "mri_segstats",
        )
    }
    _patch_present(
        monkeypatch,
        FakeTree(dirs={FSHOME}, files=bins | {LICENSE}, nonempty={LICENSE}),
    )

    checks = by_id(FreeSurferProbe().checks(fs_config()))

    assert checks["fshome"].status == "found"
    assert "8.2.0" in checks["fshome"].detail
    assert "release 8.2.0" in checks["reconall"].detail


def test_fshome_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Use $FREESURFER_HOME when the config omits the home directory."""
    monkeypatch.setenv("FREESURFER_HOME", FSHOME)
    _patch_present(
        monkeypatch,
        FakeTree(dirs={FSHOME}, files={f"{FSHOME}/bin/recon-all"}),
    )
    cfg = {"paths": {"derivativesDir": "/data/derivatives"}, "tools": {}}

    checks = by_id(FreeSurferProbe().checks(cfg))

    assert checks["fshome"].status == "found"
    assert checks["fshome"].detail.startswith(FSHOME)


def test_license_from_fs_license_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Use $FS_LICENSE and report its mode when the config omits the license."""
    monkeypatch.setenv("FS_LICENSE", LICENSE)
    _patch_present(
        monkeypatch,
        FakeTree(
            dirs={FSHOME},
            files={LICENSE},
            nonempty={LICENSE},
            license_mode=0o644,
        ),
    )
    cfg = {
        "paths": {"derivativesDir": "/data/derivatives"},
        "tools": {"freesurferHome": FSHOME, "freesurferLicense": ""},
    }

    checks = by_id(FreeSurferProbe().checks(cfg))

    assert checks["license"].status == "found"
    assert checks["license"].detail == "The license file is present with mode 644."


def test_all_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Report the install, binaries, and license as missing in an empty environment."""
    _patch_present(monkeypatch, FakeTree())
    cfg: dict[str, Any] = {}

    checks = by_id(FreeSurferProbe().checks(cfg))

    assert checks["fshome"].status == "missing"
    assert checks["fshome"].download_url == FREESURFER_DOWNLOAD_URL
    assert checks["fshome"].installer is not None
    assert checks["fshome"].installer.kind == "manual"

    assert checks["reconall"].status == "missing"
    assert checks["aparcstats"].status == "missing"
    assert checks["asegstats"].status == "missing"
    assert checks["mriseg"].status == "missing"

    assert checks["license"].status == "missing"
    assert checks["license"].download_url == FREESURFER_REGISTER_URL
    assert checks["license"].installer is not None
    assert checks["license"].installer.kind == "manual"
    assert "FS_LICENSE" in checks["license"].recommended_cmd


def test_frozen_feature_python_check_uses_host_python_when_fspython_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frozen_sidecar = "/opt/Supraspina/resources/sidecar/supraspina-sidecar"
    host_python = "/usr/bin/python3"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", frozen_sidecar)
    monkeypatch.setattr(
        tools,
        "which",
        lambda name: host_python if name == "python3" else None,
    )

    check = FreeSurferProbe()._check_feature_python("/missing/freesurfer")

    assert check.status == "found"
    assert check.detail == host_python


def test_binaries_found_on_path_when_no_fshome(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Resolve recon-all and helpers from PATH when fshome/bin is absent."""
    monkeypatch.setenv("FREESURFER_HOME", FSHOME)
    _patch_present(
        monkeypatch,
        FakeTree(
            dirs={FSHOME},
            on_path={
                "recon-all": "/usr/bin/recon-all",
                "aparcstats2table": "/usr/bin/aparcstats2table",
                "asegstats2table": "/usr/bin/asegstats2table",
                "mri_segstats": "/usr/bin/mri_segstats",
            },
        ),
    )
    cfg = {"paths": {"derivativesDir": "/data/derivatives"}, "tools": {}}

    checks = by_id(FreeSurferProbe().checks(cfg))

    assert checks["reconall"].status == "found"
    assert checks["reconall"].detail.startswith("/usr/bin/recon-all (release ")
    assert checks["aparcstats"].status == "found"
    assert checks["mriseg"].status == "found"


def test_license_empty_file_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Report a zero-byte or unreadable license as missing."""
    # Report a present but empty license as missing.
    _patch_present(monkeypatch, FakeTree(dirs={FSHOME}, files={LICENSE}))

    checks = by_id(FreeSurferProbe().checks(fs_config()))

    assert checks["license"].status == "missing"


def test_subjdir_found_when_present(monkeypatch: pytest.MonkeyPatch) -> None:
    subjects_dir = "/data/derivatives/freesurfer"
    _patch_present(
        monkeypatch,
        FakeTree(dirs={FSHOME, subjects_dir}, files={LICENSE}, nonempty={LICENSE}),
    )

    checks = by_id(FreeSurferProbe().checks(fs_config()))

    assert checks["subjdir"].status == "found"
    assert checks["subjdir"].detail == f"The directory {subjects_dir} is writable."


def test_subjdir_resolves_derivatives_placeholder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Resolve SUBJECTS_DIR to derivativesDir/freesurfer after interpolation."""
    _patch_present(
        monkeypatch,
        FakeTree(dirs={FSHOME}, files={LICENSE}, nonempty={LICENSE}),
    )
    cfg = {
        "paths": {"root": "/study", "derivativesDir": "${root}/derivatives"},
        "tools": {"freesurferHome": FSHOME, "freesurferLicense": LICENSE},
    }

    checks = by_id(FreeSurferProbe().checks(cfg))

    assert checks["subjdir"].detail == (
        "Make the parent of /study/derivatives/freesurfer writable."
    )


def test_output_parent_defers_without_a_resolved_derivatives_root() -> None:
    probe = FreeSurferProbe()
    deferred = probe._check_subjdir({})
    assert deferred.status == "skipped"
    assert deferred.detail == (
        "Supraspina checks this reconstruction output parent after a project "
        "resolves paths.derivativesDir."
    )
    serialized = deferred.to_dict()
    assert "recommendedCmd" not in serialized
    assert "action" not in serialized


def test_output_parent_diagnostics_classify_path_states(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    probe = FreeSurferProbe()
    derivatives = tmp_path / "derivatives"
    derivatives.mkdir()
    cfg = fs_config(derivatives=str(derivatives))

    missing = probe._check_subjdir(cfg)
    assert missing.status == "warn"
    assert missing.detail.startswith(f"Create {derivatives / 'freesurfer'}")

    output = derivatives / "freesurfer"
    output.mkdir()
    writable = probe._check_subjdir(cfg)
    assert writable.status == "found"
    assert writable.detail == f"The directory {output} is writable."

    output.rmdir()
    output.write_text("not a directory", encoding="utf-8")
    not_directory = probe._check_subjdir(cfg)
    assert not_directory.status == "wrong"
    assert not_directory.detail == f"Replace {output} with a directory."

    output.unlink()
    output.mkdir()
    real_access = freesurfer.os.access
    monkeypatch.setattr(
        freesurfer.os,
        "access",
        lambda path, mode: (
            False if str(path) == str(output) else real_access(path, mode)
        ),
    )
    unwritable = probe._check_subjdir(cfg)
    assert unwritable.status == "missing"
    assert unwritable.detail == f"Make {output} writable."


def test_output_parent_diagnostics_follow_selected_reconstruction_backend(
    tmp_path: Path,
) -> None:
    derivatives = tmp_path / "derivatives"
    derivatives.mkdir()
    probe = FreeSurferProbe()

    fastsurfer_cfg = fs_config(derivatives=str(derivatives))
    fastsurfer_cfg["steps"] = {
        "recon": {"enabled": True, "params": {"backend": "fastsurfer"}}
    }
    fastsurfer = by_id(probe.checks(fastsurfer_cfg))
    assert "subjdir" not in fastsurfer
    assert fastsurfer["fastsurferdir"].label == "FastSurfer output directory"
    assert fastsurfer["fastsurferdir"].detail.startswith(
        f"Create {derivatives / 'fastsurfer'}"
    )

    auto_cfg = fs_config(derivatives=str(derivatives))
    auto_cfg["steps"] = {"recon": {"enabled": True, "params": {"backend": "auto"}}}
    automatic = by_id(probe.checks(auto_cfg))
    assert {"subjdir", "fastsurferdir"} <= automatic.keys()


# -- Warn-row remediation -------------------------------------------------------


def test_warn_row_offers_a_quoted_command_and_a_create_action(
    tmp_path: Path,
) -> None:
    derivatives = tmp_path / "deri vatives"
    derivatives.mkdir()
    cfg = fs_config(derivatives=str(derivatives))
    target = str(derivatives / "freesurfer")

    check = FreeSurferProbe()._check_subjdir(cfg)

    assert check.status == "warn"
    assert check.recommended_cmd == f"mkdir -p {shlex.quote(target)}"
    assert shlex.split(check.recommended_cmd) == ["mkdir", "-p", target]
    assert (
        "automatically when reconstruction runs with the FreeSurfer backend"
        in check.detail
    )
    assert check.action is not None
    assert check.action.kind == "create-directory"
    assert check.action.label == "Create directory"
    assert check.installer is None

    serialized = check.to_dict()
    assert serialized["recommendedCmd"] == check.recommended_cmd
    assert serialized["action"] == {
        "kind": "create-directory",
        "label": "Create directory",
    }
    assert serialized["installable"] is False


def test_fastsurferdir_warn_row_carries_the_same_remediation(
    tmp_path: Path,
) -> None:
    """Treat the FastSurfer output-directory warn row identically."""
    derivatives = tmp_path / "derivatives"
    derivatives.mkdir()
    cfg = fs_config(derivatives=str(derivatives))
    cfg["steps"] = {"recon": {"enabled": True, "params": {"backend": "fastsurfer"}}}
    target = str(derivatives / "fastsurfer")

    check = by_id(FreeSurferProbe().checks(cfg))["fastsurferdir"]

    assert check.status == "warn"
    assert check.recommended_cmd == f"mkdir -p {shlex.quote(target)}"
    assert (
        "automatically when reconstruction runs with the FastSurfer backend"
        in check.detail
    )
    assert check.action is not None
    assert check.action.kind == "create-directory"


def test_non_creatable_branches_carry_no_command_or_action(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keep the exists/file/unwritable-parent branches action-free."""
    probe = FreeSurferProbe()

    # An unwritable nearest ancestor is the missing branch, not the warn branch.
    # Deny the write probe explicitly, because root passes it on every real
    # ancestor this path could walk up to.
    with monkeypatch.context() as unwritable:
        unwritable.setattr(freesurfer.os, "access", lambda _path, _mode: False)
        unwritable_parent = probe._check_subjdir(fs_config(derivatives="/study/deriv"))
    assert unwritable_parent.status == "missing"
    assert unwritable_parent.recommended_cmd == ""
    assert unwritable_parent.action is None

    derivatives = tmp_path / "derivatives"
    derivatives.mkdir()
    cfg = fs_config(derivatives=str(derivatives))
    target = derivatives / "freesurfer"
    target.mkdir()
    found = probe._check_subjdir(cfg)
    assert found.status == "found"
    assert found.recommended_cmd == ""
    assert found.action is None

    target.rmdir()
    target.write_text("not a directory", encoding="utf-8")
    wrong = probe._check_subjdir(cfg)
    assert wrong.status == "wrong"
    assert wrong.recommended_cmd == ""
    assert wrong.action is None


# -- Gated output-directory creation --------------------------------------------


def test_create_output_dir_creates_and_write_probes_the_directory(
    tmp_path: Path,
) -> None:
    """Create the derived directory, verify it, and leave no probe file behind."""
    derivatives = tmp_path / "deri vatives"
    derivatives.mkdir()
    cfg = fs_config(derivatives=str(derivatives))
    target = derivatives / "freesurfer"

    result = env.create_output_dir("subjdir", cfg)

    assert result == {"ok": True, "detail": f"Created {target}."}
    assert target.is_dir()
    assert list(target.iterdir()) == []


def test_create_output_dir_reports_an_existing_directory(tmp_path: Path) -> None:
    derivatives = tmp_path / "derivatives"
    derivatives.mkdir()
    target = derivatives / "fastsurfer"
    target.mkdir()
    cfg = fs_config(derivatives=str(derivatives))

    result = env.create_output_dir("fastsurferdir", cfg)

    assert result == {
        "ok": True,
        "detail": f"The directory {target} is writable.",
    }


def test_create_output_dir_refuses_a_file(tmp_path: Path) -> None:
    """Refuse a regular file at the target and leave its bytes untouched."""
    derivatives = tmp_path / "derivatives"
    derivatives.mkdir()
    target = derivatives / "freesurfer"
    target.write_text("keep these bytes", encoding="utf-8")
    cfg = fs_config(derivatives=str(derivatives))

    result = env.create_output_dir("subjdir", cfg)

    assert result == {
        "ok": False,
        "detail": f"Replace {target} with a directory.",
    }
    assert target.read_text(encoding="utf-8") == "keep these bytes"


def test_create_output_dir_refuses_a_symlink(tmp_path: Path) -> None:
    """Refuse a symlink at the target and never create through it."""
    derivatives = tmp_path / "derivatives"
    derivatives.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    target = derivatives / "freesurfer"
    target.symlink_to(elsewhere)
    cfg = fs_config(derivatives=str(derivatives))

    result = env.create_output_dir("subjdir", cfg)

    assert result == {
        "ok": False,
        "detail": f"Replace {target} with a directory.",
    }
    assert target.is_symlink()
    assert list(elsewhere.iterdir()) == []


def test_create_output_dir_creates_a_missing_parent_chain(tmp_path: Path) -> None:
    """Create every missing ancestor exactly as the reconstruction adapter does."""
    derivatives = tmp_path / "nested" / "deeper" / "derivatives"
    cfg = fs_config(derivatives=str(derivatives))
    target = derivatives / "freesurfer"

    result = env.create_output_dir("subjdir", cfg)

    assert result == {"ok": True, "detail": f"Created {target}."}
    assert target.is_dir()


def test_create_output_dir_reports_an_uncreatable_parent(tmp_path: Path) -> None:
    if os.geteuid() == 0:
        pytest.skip("Root bypasses directory permissions.")
    blocked = tmp_path / "blocked"
    blocked.mkdir()
    blocked.chmod(0o500)
    derivatives = blocked / "derivatives"
    cfg = fs_config(derivatives=str(derivatives))
    target = derivatives / "freesurfer"
    try:
        result = env.create_output_dir("subjdir", cfg)
    finally:
        blocked.chmod(0o755)

    assert result == {
        "ok": False,
        "detail": f"Make the parent of {target} writable.",
    }
    assert not derivatives.exists()


def test_create_output_dir_reports_an_unwritable_directory(tmp_path: Path) -> None:
    if os.geteuid() == 0:
        pytest.skip("Root bypasses directory permissions.")
    derivatives = tmp_path / "derivatives"
    derivatives.mkdir()
    target = derivatives / "freesurfer"
    target.mkdir()
    target.chmod(0o500)
    cfg = fs_config(derivatives=str(derivatives))
    try:
        result = env.create_output_dir("subjdir", cfg)
    finally:
        target.chmod(0o755)

    assert result == {"ok": False, "detail": f"Make {target} writable."}


def test_create_output_dir_refuses_a_post_mkdir_symlink_swap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Catch a symlink swapped in behind ``os.makedirs`` with the post-create lstat."""
    derivatives = tmp_path / "derivatives"
    derivatives.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    target = derivatives / "freesurfer"

    def swap_in_symlink(path: str, exist_ok: bool = False) -> None:
        del exist_ok
        os.symlink(str(elsewhere), path)

    monkeypatch.setattr(env.os, "makedirs", swap_in_symlink)

    result = env.create_output_dir("subjdir", fs_config(derivatives=str(derivatives)))

    assert result == {
        "ok": False,
        "detail": f"Replace {target} with a directory.",
    }
    assert list(elsewhere.iterdir()) == []


def test_create_output_dir_refuses_an_unknown_check_id(tmp_path: Path) -> None:
    """Refuse every check id outside the closed output-directory set."""
    cfg = fs_config(derivatives=str(tmp_path))

    for check_id in ("reconall", "license", "", "../escape"):
        result = env.create_output_dir(check_id, cfg)
        assert result == {
            "ok": False,
            "detail": "Select a known output-directory check.",
        }


def test_create_output_dir_refuses_an_unresolved_or_relative_derivatives_dir() -> None:
    expected = {
        "ok": False,
        "detail": (
            "Configure an absolute derivatives directory before creating "
            "output directories."
        ),
    }

    assert env.create_output_dir("subjdir", {}) == expected
    assert (
        env.create_output_dir(
            "subjdir", {"paths": {"derivativesDir": "relative/derivatives"}}
        )
        == expected
    )
