"""Tests for the environment aggregator's checks, installers, and tool status."""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Any

import pytest

from supraspina_sidecar import env
from supraspina_sidecar.adapters import tools
from supraspina_sidecar.adapters.tools import RunResult
from supraspina_sidecar.env.base import PROBES, Check, Installer, Probe


class _FixedProbe(Probe):
    """Return a preset list of checks or raise from a fixed probe."""

    def __init__(self, name: str, checks: list[Check], *, boom: bool = False) -> None:
        self.name = name
        self._checks = checks
        self._boom = boom

    def checks(self, cfg: dict[str, Any]) -> list[Check]:
        if self._boom:
            raise RuntimeError("Raise the fixture probe failure.")
        return self._checks


@contextlib.contextmanager
def _only_probes(probes: list[Probe]) -> Iterator[None]:
    """Temporarily replace the global registry with ``probes``."""
    saved = list(PROBES)
    PROBES[:] = probes
    try:
        yield
    finally:
        PROBES[:] = saved


def _command_check(argv: list[str]) -> Check:
    """Return a missing check with a command installer for the given argv."""
    return Check(
        id="x",
        label="X",
        status="missing",
        installer=Installer(kind="command", argv=argv),
    )


def test_check_returns_groups_in_order_with_captured_at() -> None:
    probes = [
        _FixedProbe("Alpha", [Check(id="a1", label="A1", status="found")]),
        _FixedProbe("Beta", [Check(id="b1", label="B1", status="warn")]),
    ]
    with _only_probes(probes):
        report = env.check({})
    assert [g["name"] for g in report["groups"]] == ["Alpha", "Beta"]
    assert report["groups"][0]["checks"][0]["id"] == "a1"
    assert isinstance(report["capturedAt"], str)
    assert "T" in report["capturedAt"]


def test_ids_filter_drops_non_matching_groups() -> None:
    probes = [
        _FixedProbe(
            "Alpha",
            [
                Check(id="a1", label="A1", status="found"),
                Check(id="a2", label="A2", status="found"),
            ],
        ),
        _FixedProbe("Beta", [Check(id="b1", label="B1", status="found")]),
    ]
    with _only_probes(probes):
        report = env.check({}, ids=["a2"])
    assert len(report["groups"]) == 1
    assert report["groups"][0]["name"] == "Alpha"
    ids = [c["id"] for c in report["groups"][0]["checks"]]
    assert ids == ["a2"]


def test_probe_raising_does_not_abort_report() -> None:
    probes = [
        _FixedProbe("Broken", [], boom=True),
        _FixedProbe("Good", [Check(id="g1", label="G1", status="found")]),
    ]
    with _only_probes(probes):
        report = env.check({})
    names = [g["name"] for g in report["groups"]]
    assert names == ["Broken", "Good"]
    broken = report["groups"][0]["checks"]
    assert len(broken) == 1
    assert broken[0]["status"] == "warn"
    assert "probe error" in broken[0]["detail"]


def test_raised_probe_fallback_id_cannot_impersonate_a_real_check() -> None:
    """Report a crashed probe under a reserved id, not a required check id."""
    probes = [
        _FixedProbe("Python / conda", [], boom=True),
        _FixedProbe("Good", [Check(id="python", label="Python", status="found")]),
    ]
    with _only_probes(probes):
        report = env.check({})

    fallback = report["groups"][0]["checks"][0]
    assert fallback["id"] == "probe-python-conda"
    assert fallback["status"] == "warn"
    real_ids = {check["id"] for check in report["groups"][1]["checks"]}
    assert fallback["id"] not in real_ids


def test_opt_in_install_unknown_check_returns_127() -> None:
    with _only_probes([_FixedProbe("Empty", [])]):
        result = env.opt_in_install("nope", {})
    assert result["rc"] == 127
    assert result["stderr"] == "Select a known check that provides an installer."


def test_opt_in_install_refuses_manual_check() -> None:
    manual = Check(
        id="lic",
        label="License",
        status="missing",
        installer=Installer(kind="manual", one_liner="register online"),
    )
    with _only_probes([_FixedProbe("Group", [manual])]):
        result = env.opt_in_install("lic", {})
    assert result["rc"] == 126
    assert "manual install" in result["stderr"]


def test_opt_in_install_refuses_sudo_argv() -> None:
    sudo_check = Check(
        id="bad",
        label="Bad",
        status="missing",
        installer=Installer(
            kind="command",
            argv=["sudo", "conda", "install", "x"],
        ),
    )
    with _only_probes([_FixedProbe("Group", [sudo_check])]):
        result = env.opt_in_install("bad", {})
    assert result["rc"] == 126
    assert result["stderr"] == "Use only an approved, unprivileged install command."


def test_opt_in_install_refuses_non_allowlisted_program() -> None:
    evil = Check(
        id="evil",
        label="Evil",
        status="missing",
        installer=Installer(kind="command", argv=["rm", "-rf", "/"]),
    )
    with _only_probes([_FixedProbe("Group", [evil])]):
        result = env.opt_in_install("evil", {})
    assert result["rc"] == 126
    assert result["stderr"] == "Use only an approved, unprivileged install command."


def test_opt_in_install_runs_allowlisted_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def _fake_run(argv: list[str], **kwargs: Any) -> RunResult:
        captured["argv"] = argv
        captured["timeout"] = kwargs.get("timeout")
        captured["on_output"] = kwargs.get("on_output")
        return RunResult(rc=0, stdout="installed", stderr="")

    monkeypatch.setattr(tools, "run_streamed", _fake_run)
    good = Check(
        id="rpkgs",
        label="R packages",
        status="wrong",
        installer=Installer(
            kind="command",
            argv=["/usr/bin/Rscript", "-e", 'install.packages("dplyr")'],
        ),
    )

    def _publish(line: str) -> None:
        published.append(line)

    published: list[str] = []
    with _only_probes([_FixedProbe("R", [good])]):
        result = env.opt_in_install("rpkgs", {}, on_output=_publish)
    assert result == {"rc": 0, "stdout": "installed", "stderr": ""}
    assert captured["argv"][0] == "/usr/bin/Rscript"
    assert captured["timeout"] == 1800
    # Forward the publisher so a long installation can report its output live.
    assert captured["on_output"] is _publish


def test_opt_in_install_refuses_config_interpreter_in_world_writable_dir(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Refuse an allowlisted Rscript basename from a world-writable directory.
    # Prevent execution of the planted binary even when its basename is valid.
    ran: list[list[str]] = []

    def _run(argv: list[str], **_kw: Any) -> RunResult:
        ran.append(argv)
        return RunResult(rc=0, stdout="", stderr="")

    monkeypatch.setattr(tools, "run", _run)
    monkeypatch.setattr(tools, "run_streamed", _run)
    wide = tmp_path / "wide"
    wide.mkdir()
    wide.chmod(0o777)
    planted = wide / "Rscript"
    with _only_probes(
        [_FixedProbe("Grp", [_command_check([str(planted), "-e", "1"])])]
    ):
        result = env.opt_in_install("x", {})
    assert result["rc"] == 126
    assert "world-writable" in result["stderr"]
    assert ran == []  # Verify that the planted interpreter was never run.


def test_opt_in_install_refuses_world_writable_interpreter_file(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Refuse a world-writable interpreter even inside a trusted directory.
    ran: list[list[str]] = []

    def _run(argv: list[str], **_kw: Any) -> RunResult:
        ran.append(argv)
        return RunResult(rc=0, stdout="", stderr="")

    monkeypatch.setattr(tools, "run", _run)
    monkeypatch.setattr(tools, "run_streamed", _run)
    interp = tmp_path / "python3"
    interp.write_text("#!/bin/sh\n")
    interp.chmod(0o777)
    argv = [str(interp), "-m", "pip", "install", "--user", "x"]
    with _only_probes([_FixedProbe("Grp", [_command_check(argv)])]):
        result = env.opt_in_install("x", {})
    assert result["rc"] == 126
    assert "group- or world-writable" in result["stderr"]
    assert ran == []


def test_opt_in_install_allows_trusted_config_interpreter(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Honor a user-owned interpreter in a non-world-writable directory even when
    # it is absent from PATH.
    captured: dict[str, Any] = {}

    def _run(argv: list[str], **_kw: Any) -> RunResult:
        captured["argv"] = argv
        return RunResult(rc=0, stdout="ok", stderr="")

    monkeypatch.setattr(tools, "run_streamed", _run)
    interp = tmp_path / "Rscript"
    interp.write_text("#!/bin/sh\n")
    interp.chmod(0o755)
    with _only_probes([_FixedProbe("Grp", [_command_check([str(interp), "-e", "1"])])]):
        result = env.opt_in_install("x", {})
    assert result["rc"] == 0
    assert captured["argv"][0] == str(interp)


def test_pyenv_fix_uses_dedicated_provisioner_instead_of_direct_micromamba(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The pyenv row offers only the typed in-app setup action, so opt-in
    # install has no installer to run and must not bypass lock
    # materialization, app-owned caches, version validation, or
    # completed-provision provenance.
    runs: list[list[str]] = []

    def _fake_run(argv: list[str], **kwargs: Any) -> RunResult:
        runs.append(argv)
        return RunResult(rc=0, stdout="", stderr="")

    monkeypatch.setattr(tools, "run", _fake_run)
    monkeypatch.setattr(tools, "run_streamed", _fake_run)
    result = env.opt_in_install("pyenv", {})
    assert result["rc"] == 127
    assert "provides an installer" in result["stderr"]
    # Allow detection probes, but never execute a direct micromamba install argv.
    assert all(argv[0] != "micromamba" for argv in runs)


def test_opt_in_install_runs_only_owning_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Stop opt_in_install at the probe that owns the check. Do not run later
    # probes after resolving an earlier check id.
    ran: list[str] = []

    class _Tracking(Probe):
        def __init__(self, name: str, checks: list[Check]) -> None:
            self.name = name
            self._checks = checks

        def checks(self, cfg: dict[str, Any]) -> list[Check]:
            ran.append(self.name)
            return self._checks

    monkeypatch.setattr(
        tools,
        "run_streamed",
        lambda _argv, **_kw: RunResult(rc=0, stdout="", stderr=""),
    )
    early = _Tracking(
        "Early",
        [
            Check(
                id="early",
                label="Early",
                status="missing",
                installer=Installer(kind="command", argv=["Rscript", "-e", "1"]),
            )
        ],
    )
    later = _FixedProbe("Later", [], boom=True)
    with _only_probes([early, later]):
        result = env.opt_in_install("early", {})
    assert result["rc"] == 0
    assert ran == ["Early"]


#: Name the stage interpreters backing the analysis-Python headline item.
_ANALYSIS_IDS = (
    "featurepython",
    "agepython",
    "clinicalpython",
    "brainpadpython",
    "aggregatepython",
)


def _analysis_probe(status: str = "found") -> _FixedProbe:
    """Return a probe emitting every analysis-Python stage interpreter."""
    return _FixedProbe(
        "Analysis Python",
        [
            Check(id=check_id, label=check_id, status=status)
            for check_id in _ANALYSIS_IDS
        ],
    )


#: Name the asset checks backing the scientific-assets headline item.
_ASSET_IDS = (
    "scientific_assets",
    "enigma_assets",
    "outliers_assets",
    "features_assets",
    "pybrainage_assets",
    "brainpad_assets",
    "aggregate_assets",
    "final_assets",
    "final_report_assets",
)


def _asset_probe(**statuses: str) -> _FixedProbe:
    """Return a probe emitting every asset check, found unless overridden."""
    return _FixedProbe(
        "Pipeline assets",
        [
            Check(id=check_id, label=check_id, status=statuses.get(check_id, "found"))
            for check_id in _ASSET_IDS
        ],
    )


def test_tool_status_maps_headline_items_and_summary() -> None:
    probes = [
        _FixedProbe(
            "FreeSurfer",
            [
                Check(id="reconall", label="recon-all", status="found"),
                Check(id="fshome", label="FREESURFER_HOME", status="found"),
                Check(id="license", label="License", status="found"),
            ],
        ),
        _FixedProbe(
            "QC",
            [
                Check(id="matlab", label="MATLAB", status="missing"),
                Check(id="mcr", label="MATLAB Runtime", status="missing"),
            ],
        ),
        _analysis_probe(),
        _FixedProbe(
            "Python",
            [
                Check(id="pyenv", label="env", status="found"),
                Check(id="modelfile", label="model", status="warn"),
            ],
        ),
        _FixedProbe(
            "R",
            [
                Check(id="rscript", label="Rscript", status="found"),
                Check(id="finalrscript", label="R analysis Rscript", status="found"),
                Check(id="rpkgs", label="R packages", status="found"),
            ],
        ),
        _asset_probe(),
    ]
    with _only_probes(probes):
        status = env.tool_status({})
    by_id = {item["id"]: item for item in status["items"]}
    # Key items as fs/qc/analysis/py/r/assets, and use qc for the backend
    # headline.
    assert [item["id"] for item in status["items"]] == [
        "fs",
        "qc",
        "analysis",
        "py",
        "r",
        "assets",
    ]
    assert by_id["fs"]["status"] == "ok"
    assert by_id["fs"]["label"] == "FreeSurfer"
    assert by_id["qc"]["status"] == "missing"
    assert by_id["qc"]["label"] == "QC backend"
    assert by_id["analysis"]["status"] == "ok"
    assert by_id["analysis"]["label"] == "Analysis Python"
    # Select the worse state from pyenv and modelfile for py.
    assert by_id["py"]["status"] == "warn"
    assert by_id["r"]["status"] == "ok"
    assert by_id["assets"]["status"] == "ok"
    assert by_id["assets"]["label"] == "Scientific assets"
    assert status["summary"] == "missing"
    assert isinstance(status["capturedAt"], str)


def _qc_probes(matlab: str, mcr: str) -> list[_FixedProbe]:
    return [
        _FixedProbe(
            "FreeSurfer",
            [
                Check(id="reconall", label="recon-all", status="found"),
                Check(id="fshome", label="FREESURFER_HOME", status="found"),
                Check(id="license", label="License", status="found"),
            ],
        ),
        _FixedProbe(
            "QC",
            [
                Check(id="matlab", label="MATLAB", status=matlab),
                Check(id="mcr", label="MATLAB Runtime", status=mcr),
            ],
        ),
        _analysis_probe(),
        _FixedProbe(
            "Python",
            [
                Check(id="pyenv", label="env", status="found"),
                Check(id="modelfile", label="model", status="found"),
            ],
        ),
        _FixedProbe(
            "R",
            [
                Check(id="rscript", label="Rscript", status="found"),
                Check(id="finalrscript", label="R analysis Rscript", status="found"),
                Check(id="rpkgs", label="R packages", status="found"),
            ],
        ),
        _asset_probe(),
    ]


def _qc_cfg(backend: str | None) -> dict[str, Any]:
    if backend is None:
        return {}
    return {"steps": {"enigma": {"enabled": True, "params": {"backend": backend}}}}


def test_tool_status_qc_uses_the_default_backend_without_configuration() -> None:
    with _only_probes(_qc_probes("found", "skipped")):
        status = env.tool_status({})
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["qc"]["status"] == "ok"
    assert status["summary"] == "ok"


@pytest.mark.parametrize(
    ("backend", "matlab", "mcr", "expected"),
    [
        # An available but unselected backend never satisfies the selected one.
        ("mcr", "found", "missing", "missing"),
        ("matlab", "missing", "found", "missing"),
        ("mcr", "missing", "found", "ok"),
        ("matlab", "found", "missing", "ok"),
        ("matlab", "found", "found", "ok"),
        ("mcr", "found", "found", "ok"),
        ("matlab", "missing", "missing", "missing"),
        ("mcr", "missing", "missing", "missing"),
        ("mcr", "found", "warn", "warn"),
        # Resolve auto to the first installed backend, preferring MATLAB, and
        # require MATLAB when neither is installed.
        ("auto", "found", "found", "ok"),
        ("auto", "missing", "found", "ok"),
        ("auto", "warn", "found", "ok"),
        ("auto", "found", "missing", "ok"),
        ("auto", "missing", "missing", "missing"),
        ("auto", "warn", "missing", "warn"),
        # Fail closed on an unknown selection.
        ("unknown", "found", "found", "missing"),
    ],
)
def test_tool_status_qc_reports_the_selected_backend(
    backend: str, matlab: str, mcr: str, expected: str
) -> None:
    with _only_probes(_qc_probes(matlab, mcr)):
        status = env.tool_status(_qc_cfg(backend))
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["qc"]["status"] == expected
    assert status["summary"] == ("ok" if expected == "ok" else expected)


def test_tool_status_qc_follows_a_project_switch() -> None:
    with _only_probes(_qc_probes("found", "missing")):
        first = env.tool_status(_qc_cfg("matlab"))
        second = env.tool_status(_qc_cfg("mcr"))
    assert {item["id"]: item["status"] for item in first["items"]}["qc"] == "ok"
    assert {item["id"]: item["status"] for item in second["items"]}["qc"] == "missing"


def test_tool_status_missing_when_source_check_absent() -> None:
    # Report every item missing when no probe emits a headline id.
    with _only_probes([_FixedProbe("Empty", [])]):
        status = env.tool_status({})
    assert {item["status"] for item in status["items"]} == {"missing"}
    assert status["summary"] == "missing"


def _steps_cfg(steps: dict[str, Any]) -> dict[str, Any]:
    return {"steps": steps}


def test_tool_status_names_the_fastsurfer_runtime_for_the_fastsurfer_backend() -> None:
    # FastSurfer runs without recon-all, so read the license the stage gate names.
    probes = _qc_probes("found", "missing")
    probes[0] = _FixedProbe(
        "FreeSurfer",
        [
            Check(id="reconall", label="recon-all", status="missing"),
            Check(id="fshome", label="FREESURFER_HOME", status="missing"),
            Check(id="license", label="License", status="found"),
        ],
    )
    cfg = _steps_cfg({"recon": {"enabled": True, "params": {"backend": "fastsurfer"}}})
    with _only_probes(probes):
        status = env.tool_status(cfg)
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["fs"]["label"] == "FastSurfer"
    assert by_id["fs"]["status"] == "ok"


def test_tool_status_reports_a_disabled_stage_as_not_applicable() -> None:
    cfg = _steps_cfg(
        {
            "recon": {"enabled": False},
            "enigma": {"enabled": False},
            "pybrainage": {"enabled": False},
            "outliers": {"enabled": False},
            "final": {"enabled": False},
            "features": {"enabled": False},
            "age": {"enabled": False},
            "clinical": {"enabled": False},
            "brainpad": {"enabled": False},
            "aggregate": {"enabled": False},
        }
    )
    with _only_probes([_FixedProbe("Empty", [])]):
        status = env.tool_status(cfg)
    assert {item["status"] for item in status["items"]} == {"na"}
    assert status["summary"] == "ok"


def test_tool_status_analysis_python_drops_the_feature_interpreter_on_fastsurfer() -> (
    None
):
    # The FastSurfer branch of the features gate never names featurepython.
    probes = _qc_probes("found", "missing")
    probes[2] = _FixedProbe(
        "Analysis Python",
        [
            Check(id="featurepython", label="feature", status="missing"),
            *(
                Check(id=check_id, label=check_id, status="found")
                for check_id in _ANALYSIS_IDS[1:]
            ),
        ],
    )
    cfg = _steps_cfg({"recon": {"enabled": True, "params": {"backend": "fastsurfer"}}})
    with _only_probes(probes):
        status = env.tool_status(cfg)
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["analysis"]["status"] == "ok"


def test_tool_status_reports_a_skipped_source_as_not_applicable() -> None:
    # A probe that deliberately skipped a check never reads as a missing tool.
    probes = _qc_probes("found", "missing")
    probes[4] = _FixedProbe(
        "R",
        [
            Check(id="rscript", label="Rscript", status="skipped"),
            Check(id="finalrscript", label="R analysis Rscript", status="skipped"),
            Check(id="rpkgs", label="R packages", status="skipped"),
        ],
    )
    with _only_probes(probes):
        status = env.tool_status({})
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["r"]["status"] == "na"
    assert status["summary"] == "ok"


def _recon_probes(reconall: str, fshome: str, license_status: str) -> list[_FixedProbe]:
    """Return the headline probes with a parameterized FreeSurfer group."""
    probes = _qc_probes("found", "missing")
    probes[0] = _FixedProbe(
        "FreeSurfer",
        [
            Check(id="reconall", label="recon-all", status=reconall),
            Check(id="fshome", label="FREESURFER_HOME", status=fshome),
            Check(id="license", label="License", status=license_status),
        ],
    )
    return probes


@pytest.mark.parametrize("backend", ["freesurfer", "auto"])
def test_tool_status_recon_item_blocks_on_a_missing_license(backend: str) -> None:
    # The recon gate names the license, so an absent one may not read as ready.
    cfg = _steps_cfg({"recon": {"enabled": True, "params": {"backend": backend}}})
    with _only_probes(_recon_probes("found", "found", "missing")):
        status = env.tool_status(cfg)
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["fs"]["label"] == "FreeSurfer"
    assert by_id["fs"]["status"] == "missing"


@pytest.mark.parametrize("backend", ["freesurfer", "auto"])
def test_tool_status_recon_item_blocks_on_a_missing_freesurfer_home(
    backend: str,
) -> None:
    # The recon gate also names FREESURFER_HOME.
    cfg = _steps_cfg({"recon": {"enabled": True, "params": {"backend": backend}}})
    with _only_probes(_recon_probes("found", "missing", "found")):
        status = env.tool_status(cfg)
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["fs"]["status"] == "missing"


def test_tool_status_fastsurfer_item_sources_only_the_license() -> None:
    # FastSurfer needs neither recon-all nor FREESURFER_HOME, only the license.
    cfg = _steps_cfg({"recon": {"enabled": True, "params": {"backend": "fastsurfer"}}})
    with _only_probes(_recon_probes("missing", "missing", "found")):
        ready = env.tool_status(cfg)
    with _only_probes(_recon_probes("found", "found", "missing")):
        blocked = env.tool_status(cfg)
    assert {item["id"]: item for item in ready["items"]}["fs"]["status"] == "ok"
    assert {item["id"]: item for item in blocked["items"]}["fs"]["status"] == "missing"


def _r_probes(rscript: str, finalrscript: str, rpkgs: str) -> list[_FixedProbe]:
    """Return the headline probes with a parameterized R group."""
    probes = _recon_probes("found", "found", "found")
    probes[4] = _FixedProbe(
        "R",
        [
            Check(id="rscript", label="Rscript", status=rscript),
            Check(id="finalrscript", label="R analysis Rscript", status=finalrscript),
            Check(id="rpkgs", label="R packages", status=rpkgs),
        ],
    )
    return probes


@pytest.mark.parametrize(
    ("rscript", "finalrscript"),
    [("missing", "found"), ("found", "missing")],
)
def test_tool_status_r_item_blocks_on_a_missing_interpreter(
    rscript: str, finalrscript: str
) -> None:
    # A found package check may not outrank an interpreter the R stages need.
    with _only_probes(_r_probes(rscript, finalrscript, "found")):
        status = env.tool_status({})
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["r"]["status"] == "missing"


def test_tool_status_r_item_sources_only_the_enabled_stage_interpreter() -> None:
    # Reading a disabled stage's interpreter would block a run nobody gates on.
    cfg = _steps_cfg({"final": {"enabled": False}})
    with _only_probes(_r_probes("found", "missing", "found")):
        status = env.tool_status(cfg)
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["r"]["status"] == "ok"


def test_tool_status_r_item_is_not_applicable_without_an_r_stage() -> None:
    cfg = _steps_cfg({"outliers": {"enabled": False}, "final": {"enabled": False}})
    with _only_probes(_r_probes("missing", "missing", "missing")):
        status = env.tool_status(cfg)
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["r"]["status"] == "na"


def _assets_probes(**statuses: str) -> list[_FixedProbe]:
    """Return the headline probes with a parameterized asset group."""
    probes = _qc_probes("found", "missing")
    probes[5] = _asset_probe(**statuses)
    return probes


def test_tool_status_assets_item_is_found_when_every_asset_check_passes() -> None:
    with _only_probes(_assets_probes()):
        status = env.tool_status({})
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["assets"] == {
        "id": "assets",
        "label": "Scientific assets",
        "status": "ok",
    }
    assert status["summary"] == "ok"


def test_tool_status_assets_item_reports_a_stale_acquisition_as_missing() -> None:
    # Only the reviewed-asset checks fail after an update that revised the
    # inventory; every tool is found, so the summary must still read missing.
    with _only_probes(
        _assets_probes(scientific_assets="missing", enigma_assets="missing")
    ):
        status = env.tool_status({})
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["assets"]["status"] == "missing"
    assert {item["id"] for item in status["items"] if item["status"] != "ok"} == {
        "assets"
    }
    assert status["summary"] == "missing"


def test_tool_status_assets_item_reads_the_acquisition_check_alone() -> None:
    with _only_probes(_assets_probes(scientific_assets="missing")):
        status = env.tool_status({})
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["assets"]["status"] == "missing"
    assert status["summary"] == "missing"


@pytest.mark.parametrize(
    ("check_id", "state", "expected"),
    [
        ("enigma_assets", "missing", "missing"),
        # A mismatched ENIGMA file outside a frozen acquisition reads as wrong.
        ("enigma_assets", "wrong", "warn"),
        ("outliers_assets", "missing", "missing"),
        ("features_assets", "missing", "missing"),
        ("pybrainage_assets", "missing", "missing"),
        ("brainpad_assets", "missing", "missing"),
        ("aggregate_assets", "missing", "missing"),
        ("final_assets", "missing", "missing"),
        ("final_report_assets", "missing", "missing"),
    ],
)
def test_tool_status_assets_item_reads_every_enabled_stage_asset(
    check_id: str, state: str, expected: str
) -> None:
    with _only_probes(_assets_probes(**{check_id: state})):
        status = env.tool_status({})
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["assets"]["status"] == expected
    assert status["summary"] == expected


@pytest.mark.parametrize(
    ("step_key", "check_id"),
    [
        ("enigma", "enigma_assets"),
        ("outliers", "outliers_assets"),
        ("features", "features_assets"),
        ("pybrainage", "pybrainage_assets"),
        ("brainpad", "brainpad_assets"),
        ("aggregate", "aggregate_assets"),
    ],
)
def test_tool_status_assets_item_skips_a_disabled_stage_asset(
    step_key: str, check_id: str
) -> None:
    # A stage nobody runs may not block the top bar on its own assets.
    cfg = _steps_cfg({step_key: {"enabled": False}})
    with _only_probes(_assets_probes(**{check_id: "missing"})):
        status = env.tool_status(cfg)
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["assets"]["status"] == "ok"


def test_tool_status_assets_item_skips_report_assets_without_a_report() -> None:
    # The Final gate names the report assets only while it renders the report.
    cfg = _steps_cfg({"final": {"enabled": True, "params": {"renderReport": False}}})
    with _only_probes(_assets_probes(final_report_assets="missing")):
        status = env.tool_status(cfg)
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["assets"]["status"] == "ok"


def test_tool_status_assets_item_is_not_applicable_without_an_asset_stage() -> None:
    # Reconstruction alone reads no reviewed asset, so a stale acquisition may
    # not block a project that runs only FreeSurfer.
    cfg = _steps_cfg(
        {
            step_key: {"enabled": False}
            for step_key in (
                "enigma",
                "outliers",
                "features",
                "pybrainage",
                "brainpad",
                "aggregate",
                "final",
            )
        }
    )
    with _only_probes(_assets_probes(**dict.fromkeys(_ASSET_IDS, "missing"))):
        status = env.tool_status(cfg)
    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["assets"]["status"] == "na"


def _braincharts_probe(env_status: str, model_status: str) -> _FixedProbe:
    return _FixedProbe(
        "BrainCharts",
        [
            Check(id="bcenv", label="BrainCharts runtime", status=env_status),
            Check(id="bcmodel", label="BrainCharts model", status=model_status),
        ],
    )


def _braincharts_cfg(enabled: bool | None) -> dict[str, Any]:
    if enabled is None:
        return {}
    return {"steps": {"braincharts": {"enabled": enabled, "params": {}}}}


def test_tool_status_lists_braincharts_only_while_the_stage_is_on() -> None:
    probes = [*_qc_probes("found", "missing"), _braincharts_probe("missing", "found")]
    with _only_probes(probes):
        absent = env.tool_status(_braincharts_cfg(None))
        off = env.tool_status(_braincharts_cfg(False))
        on = env.tool_status(_braincharts_cfg(True))

    # The stage is off by default, so neither an absent switch nor an
    # explicit off adds an item the top bar would count.
    for status in (absent, off):
        assert "braincharts" not in [item["id"] for item in status["items"]]
    by_id = {item["id"]: item for item in on["items"]}
    assert by_id["braincharts"] == {
        "id": "braincharts",
        "label": "BrainCharts",
        "status": "missing",
    }
    assert on["summary"] == "missing"


def test_tool_status_reports_a_set_up_braincharts_as_ok() -> None:
    probes = [*_qc_probes("found", "missing"), _braincharts_probe("found", "found")]
    with _only_probes(probes):
        status = env.tool_status(_braincharts_cfg(True))

    by_id = {item["id"]: item for item in status["items"]}
    assert by_id["braincharts"]["status"] == "ok"
