"""Tests for Rscript location and advisory CRAN-package checks."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import env
from supraspina_sidecar.adapters import tools
from supraspina_sidecar.adapters.tools import RunResult
from supraspina_sidecar.env import r as r_module
from supraspina_sidecar.env.base import PROBES, SAFE_INSTALL_PROGRAMS
from supraspina_sidecar.env.constants import R_CRAN_REPO, R_REQUIRED_PACKAGES
from supraspina_sidecar.env.r import _COMBINED_EXPR, _PKG_MARK, RProbe

#: Pin the reviewed copy-only Ubuntu 22.04/24.04 hints exactly as emitted.
_R_APT_HINT = "sudo apt-get install r-base"
_PANDOC_APT_HINT = "sudo apt-get install pandoc"

#: Use a realistic ``R.version.string`` first line for the combined invocation.
_VERSION_LINE = 'R version 4.3.3 (2024-02-29) -- "Eye Holes"'


def _by_id(checks: list[Any]) -> dict[str, Any]:
    """Index a probe's checks by id."""
    return {c.id: c for c in checks}


def _combined_stdout(packages: str, version_line: str = _VERSION_LINE) -> str:
    """Build the combined Rscript stdout: version, marker, then packages."""
    return f"{version_line}\n{_PKG_MARK}\n{packages}"


def _run_returning(packages: str, *, rc: int = 0) -> Any:
    """Build a fake ``tools.run`` for the single combined Rscript invocation.

    Return the version line, the marker, and ``packages`` in one invocation.
    Serve the ``rscript`` and ``rpkgs`` checks with one fake start.
    """

    def _run(argv: list[str], *, timeout: float | None = None, **_kw: Any) -> RunResult:
        return RunResult(rc=rc, stdout=_combined_stdout(packages), stderr="")

    return _run


def test_rscript_found_reports_version_and_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/Rscript")
    monkeypatch.setattr(tools, "run", _run_returning(" ".join(R_REQUIRED_PACKAGES)))
    checks = _by_id(RProbe().checks({}))
    rscript = checks["rscript"]
    assert rscript.status == "found"
    assert rscript.label == "Rscript"
    assert rscript.detail == "/usr/bin/Rscript runs R 4.3.3."
    assert rscript.installer is None


def test_rscript_and_rpkgs_share_one_invocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Use one Rscript cold start for both checks in a sweep.
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/Rscript")
    calls: list[list[str]] = []

    def _run(argv: list[str], *, timeout: float | None = None, **_kw: Any) -> RunResult:
        calls.append(argv)
        return RunResult(
            rc=0, stdout=_combined_stdout(" ".join(R_REQUIRED_PACKAGES)), stderr=""
        )

    monkeypatch.setattr(tools, "run", _run)
    checks = _by_id(RProbe().checks({}))
    assert checks["rscript"].status == "found"
    assert checks["rpkgs"].status == "found"
    assert len(calls) == 1
    assert calls[0] == ["/usr/bin/Rscript", "-e", _COMBINED_EXPR]
    assert 'Sys.getenv("R_LIBS_USER", unset = "")' in calls[0][2]
    assert ".Platform$path.sep" in calls[0][2]
    assert ".libPaths(unique(c(supraspina_user_libs, .libPaths())))" in calls[0][2]


def test_rscript_prefers_config_over_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/Rscript")
    captured: dict[str, list[str]] = {}

    def _run(argv: list[str], *, timeout: float | None = None, **_kw: Any) -> RunResult:
        captured["argv"] = argv
        return RunResult(
            rc=0, stdout=_combined_stdout(" ".join(R_REQUIRED_PACKAGES)), stderr=""
        )

    monkeypatch.setattr(tools, "run", _run)
    cfg = {"tools": {"rscriptExecutable": "/opt/R/bin/Rscript"}}
    rscript = _by_id(RProbe().checks(cfg))["rscript"]
    assert rscript.status == "found"
    assert rscript.detail == "/opt/R/bin/Rscript runs R 4.3.3."
    assert captured["argv"][0] == "/opt/R/bin/Rscript"


def test_rscript_missing_when_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: None)
    monkeypatch.setattr(r_module, "ubuntu_host", lambda: True)
    checks = _by_id(RProbe().checks({}))
    rscript = checks["rscript"]
    assert rscript.status == "missing"
    assert rscript.detail == (
        "Configure Rscript or add it to PATH. Get it opens the official R project site."
    )
    assert rscript.recommended_cmd == _R_APT_HINT
    assert rscript.download_url == "https://www.r-project.org"
    assert rscript.installer is not None
    assert rscript.installer.kind == "manual"
    assert rscript.installer.one_liner == _R_APT_HINT
    # Keep runnable argv out of a manual installer.
    assert rscript.installer.argv == []
    serialized = rscript.to_dict()
    assert serialized["recommendedCmd"] == _R_APT_HINT
    assert serialized["installable"] is False


def test_rscript_missing_keeps_only_the_link_off_ubuntu(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Never recommend an apt command on a host outside the supported targets.
    monkeypatch.setattr(tools, "which", lambda _name: None)
    monkeypatch.setattr(r_module, "ubuntu_host", lambda: False)
    rscript = _by_id(RProbe().checks({}))["rscript"]
    assert rscript.status == "missing"
    assert rscript.recommended_cmd == ""
    assert rscript.download_url == "https://www.r-project.org"
    assert rscript.installer is None
    serialized = rscript.to_dict()
    assert "recommendedCmd" not in serialized
    assert "installable" not in serialized


def test_rscript_configured_but_nonexistent_reports_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _run(argv: list[str], *, timeout: float | None = None, **_kw: Any) -> RunResult:
        return RunResult(rc=127, stdout="", stderr="No such file or directory")

    monkeypatch.setattr(tools, "run", _run)
    monkeypatch.setattr(tools, "exists", lambda _path: False)
    monkeypatch.setattr(r_module, "ubuntu_host", lambda: True)
    cfg = {"tools": {"rscriptExecutable": "/opt/absent/Rscript"}}
    rscript = _by_id(RProbe().checks(cfg))["rscript"]
    assert rscript.status == "missing"
    assert "/opt/absent/Rscript" in rscript.detail
    assert "was not found" in rscript.detail
    assert rscript.download_url == "https://www.r-project.org"
    # Keep the reviewed system route beside the reconfiguration guidance.
    assert rscript.recommended_cmd == _R_APT_HINT
    assert rscript.installer is not None
    assert rscript.installer.kind == "manual"


def test_rscript_failed_probe_reports_missing_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/Rscript")
    monkeypatch.setattr(tools, "exists", lambda _path: True)
    monkeypatch.setattr(tools, "run", _run_returning("", rc=1))
    rscript = _by_id(RProbe().checks({}))["rscript"]
    assert rscript.status == "missing"
    assert rscript.detail == "Reinstall R because /usr/bin/Rscript failed to run."


def test_rpkgs_skipped_when_rscript_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: None)
    rpkgs = _by_id(RProbe().checks({}))["rpkgs"]
    assert rpkgs.status == "skipped"
    assert rpkgs.installer is None


def test_rpkgs_warn_when_query_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    # Warn without offering a reinstall when installed.packages() itself fails.
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/Rscript")
    monkeypatch.setattr(tools, "run", _run_returning("", rc=1))
    rpkgs = _by_id(RProbe().checks({}))["rpkgs"]
    assert rpkgs.status == "warn"
    assert "querying installed packages failed" in rpkgs.detail
    assert "Rscript error" in rpkgs.detail
    assert rpkgs.installer is None
    assert rpkgs.recommended_cmd == ""


def test_rpkgs_found_when_all_present(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/Rscript")
    monkeypatch.setattr(tools, "run", _run_returning(" ".join(R_REQUIRED_PACKAGES)))
    rpkgs = _by_id(RProbe().checks({}))["rpkgs"]
    assert rpkgs.status == "found"
    assert rpkgs.installer is None
    assert rpkgs.recommended_cmd == ""


def test_rpkgs_wrong_when_some_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/Rscript")
    # Report only sysfonts from the advisory package set, plus noise.
    present = [p for p in R_REQUIRED_PACKAGES if p == "sysfonts"]
    monkeypatch.setattr(
        tools, "run", _run_returning(" ".join([*present, "MASS", "base"]))
    )
    rpkgs = _by_id(RProbe().checks({}))["rpkgs"]
    assert rpkgs.status == "wrong"
    assert rpkgs.detail == "Install these missing R packages: writexl, showtext."
    # Include only missing packages in the fix.
    assert "writexl" in rpkgs.recommended_cmd
    assert "showtext" in rpkgs.recommended_cmd
    assert "sysfonts" not in rpkgs.recommended_cmd
    assert rpkgs.recommended_cmd.startswith("Rscript -e 'supraspina_user_libs")
    assert R_CRAN_REPO in rpkgs.recommended_cmd
    assert rpkgs.installer is not None
    assert rpkgs.installer.kind == "command"
    assert rpkgs.installer.argv[0] == "/usr/bin/Rscript"
    assert rpkgs.installer.argv[1] == "-e"
    assert "showtext" in rpkgs.installer.argv[2]
    assert "sysfonts" not in rpkgs.installer.argv[2]
    expression = rpkgs.installer.argv[2]
    assert 'Sys.getenv("R_LIBS_USER", unset = "")' in expression
    assert ".Platform$path.sep" in expression
    assert "dir.create(supraspina_user_lib, recursive = TRUE" in expression
    assert ".libPaths(unique(c(supraspina_user_lib, .libPaths())))" in expression
    assert "lib = supraspina_user_lib" in expression
    assert "system(" not in expression
    assert "shell(" not in expression
    assert "R_LIBS_USER library" in rpkgs.installer.note


def test_rpkgs_missing_when_none_present(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/Rscript")
    # Install only unrelated base packages, leaving every advisory package absent.
    monkeypatch.setattr(tools, "run", _run_returning("MASS base stats utils"))
    rpkgs = _by_id(RProbe().checks({}))["rpkgs"]
    assert rpkgs.status == "missing"
    assert rpkgs.detail == (
        "Install these missing R packages: " + ", ".join(R_REQUIRED_PACKAGES) + "."
    )
    assert rpkgs.installer is not None
    assert rpkgs.installer.kind == "command"
    # Include every advisory package in the install argv when all are missing.
    for name in R_REQUIRED_PACKAGES:
        assert name in rpkgs.installer.argv[2]


def test_rpkgs_command_installer_uses_safe_program(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/Rscript")
    monkeypatch.setattr(tools, "run", _run_returning("MASS base"))
    rpkgs = _by_id(RProbe().checks({}))["rpkgs"]
    program = rpkgs.installer.argv[0].rsplit("/", 1)[-1]
    assert program in SAFE_INSTALL_PROGRAMS
    assert "sudo" not in rpkgs.installer.argv


def test_opt_in_install_runs_exact_user_library_argv(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []

    def run(argv: list[str], **_kwargs: Any) -> RunResult:
        calls.append(argv)
        if argv[2] == _COMBINED_EXPR:
            return RunResult(rc=0, stdout=_combined_stdout("base stats"), stderr="")
        return RunResult(rc=0, stdout="installed", stderr="")

    monkeypatch.setattr(env, "PROBES", [RProbe()])
    monkeypatch.setattr(tools, "which", lambda name: name)
    monkeypatch.setattr(tools, "run", run)
    monkeypatch.setattr(tools, "run_streamed", run)

    result = env.opt_in_install("rpkgs", {})

    assert result == {"rc": 0, "stdout": "installed", "stderr": ""}
    assert len(calls) == 2
    assert calls[1][:2] == ["Rscript", "-e"]
    assert 'Sys.getenv("R_LIBS_USER", unset = "")' in calls[1][2]
    assert "lib = supraspina_user_lib" in calls[1][2]


def test_probe_registered() -> None:
    assert any(p.name == "R" for p in PROBES)


def test_run_reports_a_non_executable_interpreter_instead_of_raising(
    tmp_path: Path,
) -> None:
    """Return a failed probe so one bad path cannot collapse a check group."""
    interpreter = tmp_path / "Rscript"
    interpreter.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    interpreter.chmod(0o644)

    result = tools.run([str(interpreter), "--version"])

    assert result.rc == 126
    assert "not executable" in result.stderr


def _per_path_run(available: dict[str, str]) -> Any:
    """Build a fake ``tools.run`` whose outcome depends on the interpreter path."""

    def _run(argv: list[str], *, timeout: float | None = None, **_kw: Any) -> RunResult:
        packages = available.get(argv[0])
        if packages is None:
            return RunResult(rc=127, stdout="", stderr="not found")
        return RunResult(rc=0, stdout=_combined_stdout(packages), stderr="")

    return _run


def _final_cfg(executable: str | None) -> dict[str, Any]:
    params: dict[str, Any] = (
        {} if executable is None else {"rscriptExecutable": executable}
    )
    return {
        "tools": {"rscriptExecutable": "/usr/bin/Rscript"},
        "steps": {"final": {"enabled": True, "params": params}},
    }


def test_final_rscript_defaults_to_the_shared_tool_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: None)
    monkeypatch.setattr(
        tools, "run", _per_path_run({"/usr/bin/Rscript": " ".join(R_REQUIRED_PACKAGES)})
    )

    checks = _by_id(RProbe().checks(_final_cfg(None)))

    assert checks["finalrscript"].status == "found"
    assert checks["finalrscript"].label == "R analysis Rscript"
    assert checks["finalrscript"].detail == "/usr/bin/Rscript runs R 4.3.3."
    assert checks["rscript"].status == "found"


def test_final_rscript_resolves_the_default_template(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: None)
    monkeypatch.setattr(
        tools, "run", _per_path_run({"/usr/bin/Rscript": " ".join(R_REQUIRED_PACKAGES)})
    )

    checks = _by_id(RProbe().checks(_final_cfg("${tools.rscriptExecutable}")))

    assert checks["finalrscript"].status == "found"


def test_final_rscript_reports_a_missing_stage_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: None)
    monkeypatch.setattr(tools, "exists", lambda path: path == "/usr/bin/Rscript")
    monkeypatch.setattr(
        tools, "run", _per_path_run({"/usr/bin/Rscript": " ".join(R_REQUIRED_PACKAGES)})
    )

    checks = _by_id(RProbe().checks(_final_cfg("/opt/absent/Rscript")))

    assert checks["rscript"].status == "found"
    assert checks["finalrscript"].status == "missing"
    assert "/opt/absent/Rscript" in checks["finalrscript"].detail


def test_final_rscript_reports_a_non_executable_stage_override(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    interpreter = tmp_path / "Rscript"
    interpreter.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    interpreter.chmod(0o644)
    monkeypatch.setattr(tools, "which", lambda _name: None)
    monkeypatch.setattr(
        tools, "run", _per_path_run({"/usr/bin/Rscript": " ".join(R_REQUIRED_PACKAGES)})
    )

    checks = _by_id(RProbe().checks(_final_cfg(str(interpreter))))

    assert checks["rscript"].status == "found"
    assert checks["finalrscript"].status == "missing"
    assert str(interpreter) in checks["finalrscript"].detail


def test_final_report_packages_follow_the_stage_interpreter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "which", lambda name: "/usr/bin/pandoc")
    monkeypatch.setattr(
        tools,
        "run",
        _per_path_run(
            {
                "/usr/bin/Rscript": "rmarkdown knitr " + " ".join(R_REQUIRED_PACKAGES),
                "/opt/R/bin/Rscript": " ".join(R_REQUIRED_PACKAGES),
            }
        ),
    )

    checks = _by_id(RProbe().checks(_final_cfg("/opt/R/bin/Rscript")))

    assert checks["finalrscript"].status == "found"
    assert checks["rmarkdown"].status == "missing"
    assert checks["knitr"].status == "missing"
    assert "/opt/R/bin/Rscript" in checks["rmarkdown"].detail


def test_final_rscript_reuses_one_query_when_the_stage_keeps_the_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []

    def _run(argv: list[str], *, timeout: float | None = None, **_kw: Any) -> RunResult:
        calls.append(argv)
        return RunResult(
            rc=0,
            stdout=_combined_stdout(" ".join(R_REQUIRED_PACKAGES)),
            stderr="",
        )

    monkeypatch.setattr(tools, "which", lambda _name: None)
    monkeypatch.setattr(tools, "run", _run)

    RProbe().checks(_final_cfg(None))

    assert len(calls) == 1


def test_final_rscript_missing_carries_the_system_remediation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Keep the finalrscript row as actionable as the rscript row it mirrors.
    monkeypatch.setattr(tools, "which", lambda _name: None)
    monkeypatch.setattr(r_module, "ubuntu_host", lambda: True)
    final = _by_id(RProbe().checks({}))["finalrscript"]
    assert final.status == "missing"
    assert final.detail == (
        "Configure the Final stage Rscript executable or add it to PATH. "
        "Get it opens the official R project site."
    )
    assert final.recommended_cmd == _R_APT_HINT
    assert final.download_url == "https://www.r-project.org"
    assert final.installer is not None
    assert final.installer.kind == "manual"
    assert final.to_dict()["installable"] is False


def test_missing_report_packages_offer_stage_bound_installers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Bind each report-package installer to the interpreter the stage spawns.
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/pandoc")
    monkeypatch.setattr(
        tools,
        "run",
        _per_path_run(
            {
                "/usr/bin/Rscript": "rmarkdown knitr " + " ".join(R_REQUIRED_PACKAGES),
                "/opt/R/bin/Rscript": " ".join(R_REQUIRED_PACKAGES),
            }
        ),
    )

    checks = _by_id(RProbe().checks(_final_cfg("/opt/R/bin/Rscript")))

    for check_id in ("rmarkdown", "knitr"):
        check = checks[check_id]
        assert check.status == "missing"
        assert check.recommended_cmd.startswith("/opt/R/bin/Rscript -e '")
        assert check.installer is not None
        assert check.installer.kind == "command"
        assert check.installer.argv[0] == "/opt/R/bin/Rscript"
        assert check.installer.argv[1] == "-e"
        expression = check.installer.argv[2]
        assert f'install.packages(c("{check_id}")' in expression
        assert "lib = supraspina_user_lib" in expression
        assert R_CRAN_REPO in expression
        assert "dir.create(supraspina_user_lib, recursive = TRUE" in expression
        assert "sudo" not in check.recommended_cmd
        assert check.to_dict()["installable"] is True


def test_report_package_one_liner_quotes_a_spacey_interpreter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Keep every emitted recommendedCmd valid standalone bash.
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/pandoc")
    monkeypatch.setattr(
        tools,
        "run",
        _per_path_run(
            {
                "/usr/bin/Rscript": "rmarkdown knitr " + " ".join(R_REQUIRED_PACKAGES),
                "/opt/My R/Rscript": " ".join(R_REQUIRED_PACKAGES),
            }
        ),
    )

    checks = _by_id(RProbe().checks(_final_cfg("/opt/My R/Rscript")))

    rmarkdown = checks["rmarkdown"]
    assert rmarkdown.recommended_cmd.startswith("'/opt/My R/Rscript' -e '")
    assert rmarkdown.installer is not None
    assert rmarkdown.installer.argv[0] == "/opt/My R/Rscript"


def test_partial_report_packages_offer_only_the_missing_installer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/pandoc")
    monkeypatch.setattr(
        tools,
        "run",
        _per_path_run(
            {"/usr/bin/Rscript": "rmarkdown " + " ".join(R_REQUIRED_PACKAGES)}
        ),
    )

    checks = _by_id(RProbe().checks(_final_cfg(None)))

    assert checks["rmarkdown"].status == "found"
    assert checks["rmarkdown"].installer is None
    assert checks["rmarkdown"].recommended_cmd == ""
    knitr = checks["knitr"]
    assert knitr.status == "missing"
    assert knitr.installer is not None
    assert 'install.packages(c("knitr")' in knitr.installer.argv[2]
    assert "rmarkdown" not in knitr.installer.argv[2]


def test_report_package_installer_uses_safe_program(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/pandoc")
    monkeypatch.setattr(
        tools,
        "run",
        _per_path_run({"/usr/bin/Rscript": " ".join(R_REQUIRED_PACKAGES)}),
    )

    rmarkdown = _by_id(RProbe().checks(_final_cfg(None)))["rmarkdown"]

    assert rmarkdown.installer is not None
    program = rmarkdown.installer.argv[0].rsplit("/", 1)[-1]
    assert program in SAFE_INSTALL_PROGRAMS
    assert "sudo" not in rmarkdown.installer.argv


def test_opt_in_install_runs_the_report_package_argv(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Prove the rmarkdown installer runs in-app through the existing gate.
    calls: list[list[str]] = []

    def run(argv: list[str], **_kwargs: Any) -> RunResult:
        calls.append(argv)
        if argv[2] == _COMBINED_EXPR:
            return RunResult(
                rc=0,
                stdout=_combined_stdout(" ".join(R_REQUIRED_PACKAGES)),
                stderr="",
            )
        return RunResult(rc=0, stdout="installed", stderr="")

    monkeypatch.setattr(env, "PROBES", [RProbe()])
    monkeypatch.setattr(tools, "which", lambda name: name)
    monkeypatch.setattr(tools, "run", run)
    monkeypatch.setattr(tools, "run_streamed", run)

    result = env.opt_in_install("rmarkdown", {})

    assert result == {"rc": 0, "stdout": "installed", "stderr": ""}
    assert calls[-1][:2] == ["Rscript", "-e"]
    assert 'install.packages(c("rmarkdown")' in calls[-1][2]
    assert "lib = supraspina_user_lib" in calls[-1][2]


def test_pandoc_missing_offers_gated_remediation_on_ubuntu(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The default configuration renders the report, so pandoc is required.
    monkeypatch.setattr(r_module, "ubuntu_host", lambda: True)
    monkeypatch.setattr(
        tools, "which", lambda name: "/usr/bin/Rscript" if name == "Rscript" else None
    )
    monkeypatch.setattr(tools, "run", _run_returning(" ".join(R_REQUIRED_PACKAGES)))
    pandoc = _by_id(RProbe().checks({}))["pandoc"]
    assert pandoc.status == "missing"
    assert pandoc.detail == (
        "Install Pandoc or add it to PATH. Get it opens the official Pandoc "
        "installation instructions."
    )
    assert pandoc.recommended_cmd == _PANDOC_APT_HINT
    assert pandoc.download_url == "https://pandoc.org/installing.html"
    assert pandoc.installer is not None
    assert pandoc.installer.kind == "manual"
    assert pandoc.installer.one_liner == _PANDOC_APT_HINT
    assert pandoc.installer.argv == []
    assert pandoc.to_dict()["installable"] is False


def test_pandoc_is_skipped_with_a_reason_when_report_rendering_is_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Nothing requires pandoc without report rendering, so skip it and offer
    # no action instead of reporting a missing tool.
    monkeypatch.setattr(r_module, "ubuntu_host", lambda: True)
    monkeypatch.setattr(
        tools, "which", lambda name: "/usr/bin/Rscript" if name == "Rscript" else None
    )
    monkeypatch.setattr(tools, "run", _run_returning(" ".join(R_REQUIRED_PACKAGES)))
    cfg = {"steps": {"final": {"params": {"renderReport": False}}}}
    pandoc = _by_id(RProbe().checks(cfg))["pandoc"]
    assert pandoc.status == "skipped"
    assert pandoc.detail == (
        "Pandoc is not needed because the Final stage does not render an HTML report."
    )
    assert pandoc.recommended_cmd == ""
    assert pandoc.download_url == ""
    assert pandoc.installer is None


def test_report_packages_are_skipped_when_report_rendering_is_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Keep each remediation on the row while the report stays disabled.
    monkeypatch.setattr(tools, "which", lambda _name: "/usr/bin/pandoc")
    monkeypatch.setattr(
        tools,
        "run",
        _per_path_run({"/usr/bin/Rscript": " ".join(R_REQUIRED_PACKAGES)}),
    )
    cfg = {
        "tools": {"rscriptExecutable": "/usr/bin/Rscript"},
        "steps": {"final": {"enabled": True, "params": {"renderReport": False}}},
    }
    checks = _by_id(RProbe().checks(cfg))
    for check_id, name in (("rmarkdown", "rmarkdown"), ("knitr", "knitr")):
        assert checks[check_id].status == "skipped"
        assert checks[check_id].detail == (
            f"{name} is not needed because the Final stage does not render an "
            "HTML report."
        )
        assert checks[check_id].installer is not None


def test_pandoc_missing_keeps_only_the_link_off_ubuntu(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(r_module, "ubuntu_host", lambda: False)
    monkeypatch.setattr(
        tools, "which", lambda name: "/usr/bin/Rscript" if name == "Rscript" else None
    )
    monkeypatch.setattr(tools, "run", _run_returning(" ".join(R_REQUIRED_PACKAGES)))
    pandoc = _by_id(RProbe().checks({}))["pandoc"]
    assert pandoc.status == "missing"
    assert pandoc.recommended_cmd == ""
    assert pandoc.download_url == "https://pandoc.org/installing.html"
    assert pandoc.installer is None
