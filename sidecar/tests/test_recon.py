"""Tests for the FreeSurfer ``recon-all`` adapter."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.adapters import recon as recon_module
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.adapters.recon import ReconAdapter


def _cfg(
    derivatives_dir: str = "/proj/derivatives",
    rawdata_dir: str = "/proj/rawdata",
) -> dict[str, Any]:
    """Return a minimal config exercising the recon adapter templates."""
    return {
        "paths": {
            "rawdataDir": rawdata_dir,
            "derivativesDir": derivatives_dir,
        },
        "tools": {"freesurferHome": "/usr/local/freesurfer/8.2.0"},
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "steps": {"recon": {"enabled": True, "params": {}}},
    }


def test_build_command_resolved_argv() -> None:
    cfg = _cfg()
    argv = ReconAdapter().build_command(cfg, "sub-001")
    assert argv == [
        "recon-all",
        "-subject",
        "sub-001",
        "-i",
        "/proj/rawdata/sub-001/anat/sub-001_T1w.nii.gz",
        "-sd",
        "/proj/derivatives/freesurfer",
        "-all",
        "-parallel",
        "-openmp",
        "6",
    ]


def test_build_command_continues_an_existing_subject_without_import(
    tmp_path: Path,
) -> None:
    cfg = _cfg(derivatives_dir=str(tmp_path / "derivatives"))
    imported = tmp_path / "derivatives" / "freesurfer" / "sub-001" / "mri" / "orig"
    imported.mkdir(parents=True)
    (imported / "001.mgz").write_bytes(b"imported")

    argv = ReconAdapter().build_command(cfg, "sub-001")

    assert "-i" not in argv
    assert argv[:3] == ["recon-all", "-subject", "sub-001"]
    assert argv[3:5] == ["-sd", str(tmp_path / "derivatives" / "freesurfer")]


def test_build_command_respects_param_and_runtime_overrides() -> None:
    cfg = _cfg()
    cfg["steps"]["recon"]["params"] = {"parallel": False}
    cfg["runtime"] = {"threads": 12}
    argv = ReconAdapter().build_command(cfg, "sub-002")
    assert "-parallel" not in argv
    assert argv[-2:] == ["-openmp", "12"]


def test_build_command_without_subject_keeps_placeholder() -> None:
    argv = ReconAdapter().build_command(_cfg(), None)
    assert "${subject}" in argv
    assert "/proj/rawdata/${subject}/anat/${subject}_T1w.nii.gz" in argv


def test_param_schema_keys() -> None:
    schema = ReconAdapter().param_schema()
    assert set(schema) == {
        "backend",
        "fastsurferDevice",
        "directives",
        "parallel",
    }
    assert schema["backend"]["default"] == "freesurfer"
    assert schema["fastsurferDevice"]["default"] == "auto"
    assert schema["directives"]["default"] == "-all"
    assert schema["parallel"]["default"] is True


def _make_recon_tree(root: str, subject: str, *, complete: bool) -> None:
    """Create a FreeSurfer recon tree, optionally omitting the done flag."""
    subj = os.path.join(root, "freesurfer", subject)
    os.makedirs(os.path.join(subj, "scripts"), exist_ok=True)
    os.makedirs(os.path.join(subj, "surf"), exist_ok=True)
    os.makedirs(os.path.join(subj, "stats"), exist_ok=True)
    for rel in (
        "surf/lh.pial",
        "surf/rh.pial",
        "surf/lh.white",
        "surf/rh.white",
        "stats/aseg.stats",
        "stats/wmparc.stats",
        "stats/lh.aparc.stats",
        "stats/rh.aparc.stats",
        "stats/lh.aparc.a2009s.stats",
        "stats/rh.aparc.a2009s.stats",
        "mri/aparc+aseg.mgz",
        "mri/nu.mgz",
    ):
        os.makedirs(os.path.dirname(os.path.join(subj, rel)), exist_ok=True)
        with open(os.path.join(subj, rel), "w", encoding="utf-8") as handle:
            handle.write("x")
    if complete:
        with open(
            os.path.join(subj, "scripts", "recon-all.done"),
            "w",
            encoding="utf-8",
        ) as handle:
            handle.write("done")


def test_detect_done_when_all_artifacts_present(tmp_path: Any) -> None:
    cfg = _cfg(derivatives_dir=str(tmp_path))
    _make_recon_tree(str(tmp_path), "sub-001", complete=True)
    status = ReconAdapter().detect(cfg, "sub-001")
    assert status.state == "done"
    assert status.detail == "The FreeSurfer reconstruction is complete."
    assert any(a.endswith("recon-all.done") for a in status.artifacts)
    assert any(a.endswith("lh.pial") for a in status.artifacts)
    assert any(a.endswith("aseg.stats") for a in status.artifacts)


def test_detect_ignores_complete_other_backend_tree(tmp_path: Any) -> None:
    cfg = _cfg(derivatives_dir=str(tmp_path))
    _make_recon_tree(str(tmp_path), "sub-001", complete=True)
    cfg["steps"]["recon"]["params"] = {
        "backend": "fastsurfer",
        "fastsurferDevice": "cpu",
    }

    status = ReconAdapter().detect(cfg, "sub-001")

    assert status.state == "pending"
    assert status.artifacts == []
    assert (
        tmp_path / "freesurfer" / "sub-001" / "scripts" / "recon-all.done"
    ).read_text(encoding="utf-8") == "done"


def test_detect_pending_when_nothing_produced(tmp_path: Any) -> None:
    cfg = _cfg(derivatives_dir=str(tmp_path))
    status = ReconAdapter().detect(cfg, "sub-404")
    assert status.state == "pending"
    assert status.artifacts == []


def test_detect_partial_when_done_flag_missing(tmp_path: Any) -> None:
    cfg = _cfg(derivatives_dir=str(tmp_path))
    _make_recon_tree(str(tmp_path), "sub-003", complete=False)
    status = ReconAdapter().detect(cfg, "sub-003")
    assert status.state == "partial"
    assert "recon-all.done" in status.detail


def test_detect_pending_when_no_subject() -> None:
    status = ReconAdapter().detect(_cfg(), None)
    assert status.state == "pending"


def test_parse_failure_oom() -> None:
    failure = ReconAdapter().parse_failure(137, "", "Killed")
    assert failure is not None
    assert failure.tag == "oom_killed"


def test_parse_failure_names_the_tool_killed_by_signal_9() -> None:
    log = (
        "predicting 1/1\n"
        "Command terminated by signal 9\n"
        "@#@FSTIME  2026:09:16:17:33:03 mri_synthseg N 11 e 45.97 S 62.05\n"
        "recon-all -s sub-101 exited with ERRORS at Wed Sep 16 17:33:49 EDT 2026\n"
        "To report a problem, see http://surfer.nmr.mgh.harvard.edu/fswiki/BugReporting\n"
    )
    failure = ReconAdapter().parse_failure(1, log, "")
    assert failure is not None
    assert failure.tag == "oom_killed"
    assert "mri_synthseg was killed by signal 9" in failure.message


def test_parse_failure_skips_the_freesurfer_trailer_for_the_generic_reason() -> None:
    log = (
        "mri_convert: unknown input format\n"
        "recon-all -s sub-101 exited with ERRORS at Wed Sep 16 17:33:49 EDT 2026\n"
        "For more details, see the log file /x/recon-all.log\n"
        "To report a problem, see http://surfer.nmr.mgh.harvard.edu/fswiki/BugReporting\n"
    )
    failure = ReconAdapter().parse_failure(1, log, "")
    assert failure is not None
    assert failure.tag == "nonzero_exit"
    assert failure.message == (
        "recon-all -s sub-101 exited with ERRORS at Wed Sep 16 17:33:49 EDT 2026"
    )


def test_parse_failure_names_a_stale_isrunning_marker() -> None:
    log = (
        "ERROR: it appears that recon-all is already running\n"
        "for sub-911 based on the presence of /x/sub-911/scripts/IsRunning.lh+rh.\n"
        "----------------------------------------------------------\n"
    )
    failure = ReconAdapter().parse_failure(1, log, "")
    assert failure is not None
    assert failure.tag == "stale_running_marker"
    assert "IsRunning" in failure.message


def test_clear_stale_running_markers_removes_them_only_without_a_live_recon(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _cfg(str(tmp_path))
    adapter = ReconAdapter()
    scripts = Path(adapter._subjects_dir(cfg)) / "sub-001" / "scripts"
    scripts.mkdir(parents=True)
    (scripts / "IsRunning.lh+rh").write_text("pid 1\n", encoding="utf-8")
    (scripts / "recon-all.log").write_text("log\n", encoding="utf-8")

    monkeypatch.setattr(recon_module, "_recon_all_running_for", lambda _s: True)
    assert adapter.clear_stale_running_markers(cfg, "sub-001") == []
    assert (scripts / "IsRunning.lh+rh").exists()

    monkeypatch.setattr(recon_module, "_recon_all_running_for", lambda _s: False)
    assert adapter.clear_stale_running_markers(cfg, "sub-001") == ["IsRunning.lh+rh"]
    assert not (scripts / "IsRunning.lh+rh").exists()
    assert (scripts / "recon-all.log").exists()
    assert adapter.clear_stale_running_markers(cfg, "sub-001") == []
    assert adapter.clear_stale_running_markers(cfg, None) == []


def test_recon_all_running_for_reads_the_process_table() -> None:
    assert recon_module._recon_all_running_for("sub-never-started") is False


def test_parse_failure_license() -> None:
    failure = ReconAdapter().parse_failure(
        1, "", "ERROR: FreeSurfer license file is not valid"
    )
    assert failure is not None
    assert failure.tag == "license_error"


def test_parse_failure_white_surface() -> None:
    failure = ReconAdapter().parse_failure(
        1, "", "mris_make_surfaces: could not make white surface"
    )
    assert failure is not None
    assert failure.tag == "white_surface_failure"


@pytest.mark.parametrize(
    ("stderr", "expected_tag"),
    [
        ("mris_fix_topology: topology correction failed", "topology_failure"),
        ("mris_inflate: inflation failed", "inflation_failure"),
        (
            "mris_make_surfaces: could not make white surface",
            "white_surface_failure",
        ),
    ],
)
def test_parse_failure_distinguishes_auto_fallback_algorithm_classes(
    stderr: str, expected_tag: str
) -> None:
    failure = ReconAdapter().parse_failure(1, "", stderr)
    assert failure is not None
    assert failure.tag == expected_tag


@pytest.mark.parametrize(
    ("rc", "stderr", "expected_tag"),
    [
        (1, "input field of view is above 256 mm", "nonzero_exit"),
        (1, "permission denied", "nonzero_exit"),
        (137, "Killed", "oom_killed"),
        (1, "FreeSurfer license is not valid", "license_error"),
    ],
)
def test_parse_failure_never_labels_ineligible_errors_as_surface_algorithms(
    rc: int, stderr: str, expected_tag: str
) -> None:
    failure = ReconAdapter().parse_failure(rc, "", stderr)
    assert failure is not None
    assert failure.tag == expected_tag


def test_parse_failure_success_returns_none() -> None:
    assert ReconAdapter().parse_failure(0, "", "") is None


def test_registered_under_key() -> None:
    assert ADAPTERS["recon"].__class__ is ReconAdapter
    assert ADAPTERS["recon"].advances == ("recon",)
