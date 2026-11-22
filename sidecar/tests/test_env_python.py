"""Tests for the Python and conda environment probe (env/python.py)."""

from __future__ import annotations

import importlib.metadata as md
import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.adapters import pybrainage, tools
from supraspina_sidecar.env.constants import (
    PY_ANALYSIS_IMPORTS,
)
from supraspina_sidecar.env.python import (
    _INCOMPATIBLE_MARK,
    _MANAGED_MARK,
    _PEP_668_OPT_OUT,
    _PROBE_SCRIPT,
    _VERSION_MARK,
    PythonProbe,
)
from tests.test_schema import default_config


def python_config(output_dir: str = "/out/run") -> dict[str, Any]:
    """Return a config with a concrete output dir and analysis python."""
    cfg = default_config()
    cfg["paths"]["outputDir"] = output_dir
    cfg["tools"]["pythonExecutable"] = "/usr/bin/python3"
    return cfg


def _checks_by_id(cfg: dict[str, Any]) -> dict[str, Any]:
    """Run the probe and index the returned checks by id."""
    return {check.id: check for check in PythonProbe().checks(cfg)}


@pytest.fixture(autouse=True)
def _isolate_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default to a barren host: nothing on PATH, nothing on disk.

    Let individual tests opt back in by re-patching the specific helper they need.
    """
    monkeypatch.setattr(tools, "which", lambda _name: None)
    monkeypatch.setattr(tools, "exists", lambda _path: False)
    monkeypatch.setattr(tools, "file_nonempty", lambda _path: False)
    monkeypatch.setattr(pybrainage, "micromamba_binary", lambda: "micromamba")
    monkeypatch.setattr(
        pybrainage,
        "micromamba_identity",
        lambda selected=None: (
            selected or "micromamba",
            pybrainage.MICROMAMBA_SHA256,
        ),
    )
    monkeypatch.setattr(
        tools,
        "run",
        lambda _argv, **_kw: tools.RunResult(rc=127, stdout="", stderr="absent"),
    )


# -- Probe identity ------------------------------------------------------------


def test_probe_name_and_check_ids() -> None:
    cfg = python_config()
    checks = PythonProbe().checks(cfg)
    assert PythonProbe().name == "Python / conda"
    assert [c.id for c in checks] == [
        "python",
        "micromamba",
        "pypkgs",
        "pyenv",
        "modelfile",
        "scalerfile",
        "agepython",
        "clinicalpython",
        "brainpadpython",
        "aggregatepython",
        "pybrainpython",
    ]


def test_probe_handles_empty_config() -> None:
    # Raise no exception for a fully empty config.
    checks = PythonProbe().checks({})
    assert {c.id for c in checks} == {
        "python",
        "micromamba",
        "pypkgs",
        "pyenv",
        "modelfile",
        "scalerfile",
        "agepython",
        "clinicalpython",
        "brainpadpython",
        "aggregatepython",
        "pybrainpython",
    }


def test_frozen_aggregate_probe_never_launches_sidecar_as_python(
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
    cfg = python_config()
    cfg["tools"]["freesurferHome"] = "/usr/local/freesurfer/8.2.0al"
    cfg["tools"]["pythonExecutable"] = ""
    calls: list[list[str]] = []

    def run_probe(argv: list[str], **_kwargs: Any) -> tools.RunResult:
        calls.append(argv)
        return tools.RunResult(
            rc=0,
            stdout=f"{_VERSION_MARK}Python 3.12.3\n",
            stderr="",
        )

    monkeypatch.setattr(tools, "run", run_probe)

    check = PythonProbe()._stage_check(
        cfg,
        "aggregate",
        "aggregatepython",
        "Aggregate statistics Python",
    )

    assert check.status == "found"
    assert calls
    assert calls[0][:2] == [host_python, "-c"]
    assert all(call[0] != frozen_sidecar for call in calls)


def test_aggregate_probe_uses_freesurfer_runtime_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    fs_home = tmp_path / "freesurfer"
    fs_bin = fs_home / "bin"
    fs_bin.mkdir(parents=True)
    fspython = fs_bin / "fspython"
    fspython.touch()
    fsfast_bin = fs_home / "fsfast" / "bin"
    fsfast_bin.mkdir(parents=True)
    tktools = fs_home / "tktools"
    tktools.mkdir()
    mni_bin = fs_home / "mni" / "bin"
    mni_bin.mkdir(parents=True)
    mni_lib = fs_home / "mni" / "lib"
    mni_lib.mkdir()
    mni_data = fs_home / "mni" / "data"
    mni_data.mkdir()
    mni_perl = fs_home / "mni" / "share" / "perl5"
    mni_perl.mkdir(parents=True)
    license_path = tmp_path / "license.txt"
    cfg = python_config()
    cfg["tools"]["freesurferHome"] = str(fs_home)
    cfg["tools"]["freesurferLicense"] = str(license_path)
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.delenv("PERL5LIB", raising=False)
    captured: dict[str, Any] = {}

    def run_probe(argv: list[str], **kwargs: Any) -> tools.RunResult:
        captured["argv"] = argv
        captured["env"] = kwargs["env"]
        return tools.RunResult(
            rc=0,
            stdout=f"{_VERSION_MARK}Python 3.8.13\n",
            stderr="",
        )

    monkeypatch.setattr(tools, "run", run_probe)

    check = PythonProbe()._stage_check(
        cfg,
        "aggregate",
        "aggregatepython",
        "Aggregate statistics Python",
    )

    assert check.status == "found"
    assert captured["argv"][0] == str(fspython)
    environment = captured["env"]
    assert {
        key: environment[key]
        for key in (
            "FREESURFER_HOME",
            "FREESURFER_HOME_FSPYTHON",
            "FREESURFER",
            "SUBJECTS_DIR",
            "FS_LICENSE",
        )
    } == {
        "FREESURFER_HOME": str(fs_home),
        "FREESURFER_HOME_FSPYTHON": str(fs_home),
        "FREESURFER": str(fs_home),
        "SUBJECTS_DIR": "/data/projects/supraspina/derivatives/freesurfer",
        "FS_LICENSE": str(license_path),
    }
    assert environment["PATH"] == os.pathsep.join(
        [str(fs_bin), str(fsfast_bin), str(tktools), str(mni_bin), "/usr/bin", "/bin"]
    )
    assert environment["MNI_DIR"] == str(fs_home / "mni")
    assert environment["MINC_BIN_DIR"] == str(mni_bin)
    assert environment["MINC_LIB_DIR"] == str(mni_lib)
    assert environment["MNI_DATAPATH"] == str(mni_data)
    assert environment["MNI_PERL5LIB"] == str(mni_perl)
    assert environment["PERL5LIB"] == str(mni_perl)


def test_pybrainage_probe_ignores_configured_interpreter_and_uses_provisioned_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = python_config()
    configured_python = "/reviewed/pybrainage/bin/python"
    cfg["steps"]["pybrainage"] = {
        "enabled": True,
        "params": {"pythonExecutable": configured_python},
    }
    provisioned_python = pybrainage.env_python(cfg)
    captured: dict[str, Any] = {}
    monkeypatch.setattr(tools, "exists", lambda path: path == provisioned_python)

    def run(argv: list[str], **options: Any) -> tools.RunResult:
        captured["argv"] = argv
        captured["options"] = options
        return tools.RunResult(
            rc=0,
            stdout=json.dumps(pybrainage.PYBRAINAGE_RUNTIME_VERSIONS),
            stderr="",
        )

    monkeypatch.setattr(tools, "run", run)

    check = PythonProbe()._check_pybrainpython(cfg)

    assert check.status == "found"
    assert captured["argv"][:4] == [provisioned_python, "-I", "-B", "-c"]
    assert configured_python not in captured["argv"]
    assert "scipy=1.7.3" in check.detail
    assert "cliffs-delta=1.0.0" in check.detail
    environment = captured["options"]["env"]
    assert environment["MAMBA_ROOT_PREFIX"].endswith("/.pybrainage/mamba-root")
    assert environment["PIP_CACHE_DIR"].endswith("/.pybrainage/pip-cache")
    assert not environment["MAMBA_ROOT_PREFIX"].startswith("/out/run/")
    assert not Path(environment["MAMBA_ROOT_PREFIX"]).exists()


def test_pybrainage_probe_rejects_one_wrong_expanded_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = python_config()
    configured_python = "/reviewed/pybrainage/bin/python"
    cfg["steps"]["pybrainage"] = {
        "enabled": True,
        "params": {"pythonExecutable": configured_python},
    }
    provisioned_python = pybrainage.env_python(cfg)
    versions = {**pybrainage.PYBRAINAGE_RUNTIME_VERSIONS, "statsmodels": "0.14.0"}
    monkeypatch.setattr(tools, "exists", lambda path: path == provisioned_python)
    monkeypatch.setattr(
        tools,
        "run",
        lambda _argv, **_options: tools.RunResult(
            rc=0, stdout=json.dumps(versions), stderr=""
        ),
    )

    check = PythonProbe()._check_pybrainpython(cfg)

    assert check.status == "wrong"
    assert "statsmodels=0.14.0 (expected 0.13.2)" in check.detail


# -- python --------------------------------------------------------------------


def _combined(version: str, present: list[str]) -> Any:
    """Build a fake ``tools.run`` for the single combined interpreter probe.

    Put the version on the marker line and the resolvable import names on the
    remaining lines to mirror the real one-shot probe script.
    """

    def fake_run(argv: list[str], **_kw: Any) -> tools.RunResult:
        body = "\n".join([f"{_VERSION_MARK}{version}", *present]) + "\n"
        return tools.RunResult(rc=0, stdout=body, stderr="")

    return fake_run


def test_python_found_from_config(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[list[str]] = []

    def fake_run(argv: list[str], **_kw: Any) -> tools.RunResult:
        captured.append(argv)
        body = f"{_VERSION_MARK}Python 3.12.3\n"
        return tools.RunResult(rc=0, stdout=body, stderr="")

    monkeypatch.setattr(tools, "run", fake_run)
    check = _checks_by_id(python_config())["python"]
    assert check.status == "found"
    assert check.detail == "/usr/bin/python3 (Python 3.12.3)."
    # Start one interpreter for the combined probe without a separate --version.
    assert captured[0][0] == "/usr/bin/python3"
    assert captured[0][1] == "-c"
    assert "--version" not in captured[0]


def test_python_falls_back_to_path(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = python_config()
    cfg["tools"]["pythonExecutable"] = ""
    monkeypatch.setattr(
        tools, "which", lambda name: "/usr/bin/python" if name == "python" else None
    )
    monkeypatch.setattr(tools, "run", _combined("Python 3.11.0", []))
    check = _checks_by_id(cfg)["python"]
    assert check.status == "found"
    assert check.detail.startswith("/usr/bin/python ")


def test_python_ignores_configured_pybrainage_runtime_when_tool_path_is_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = python_config()
    cfg["tools"]["pythonExecutable"] = ""
    cfg["steps"]["pybrainage"] = {"enabled": True, "params": {}}
    cfg["steps"]["pybrainage"]["params"]["pythonExecutable"] = (
        "/project/runtime/bin/python"
    )
    monkeypatch.setattr(tools, "run", _combined("Python 3.7.17", []))

    check = _checks_by_id(cfg)["python"]

    assert check.status == "missing"
    assert "/project/runtime/bin/python" not in check.detail


def test_python_configured_but_nonexistent_reports_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = python_config()
    cfg["tools"]["pythonExecutable"] = "/opt/absent/python3"
    monkeypatch.setattr(
        tools,
        "run",
        lambda argv, **_kw: tools.RunResult(rc=127, stdout="", stderr="not found"),
    )

    check = _checks_by_id(cfg)["python"]

    assert check.status == "missing"
    assert "/opt/absent/python3" in check.detail
    assert "was not found" in check.detail
    assert check.download_url


def test_python_failed_probe_reports_missing_not_unknown_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = python_config()
    monkeypatch.setattr(tools, "exists", lambda _path: True)
    monkeypatch.setattr(
        tools,
        "run",
        lambda argv, **_kw: tools.RunResult(
            rc=1, stdout="", stderr="interpreter error"
        ),
    )

    checks = _checks_by_id(cfg)

    assert checks["python"].status == "missing"
    assert checks["python"].detail == (
        "Inspect /usr/bin/python3; it failed to run as a Python interpreter."
    )
    # Keep the paired package check consistent with the interpreter row.
    assert checks["pypkgs"].status == "warn"


def test_python_missing_when_absent() -> None:
    cfg = python_config()
    cfg["tools"]["pythonExecutable"] = ""
    check = _checks_by_id(cfg)["python"]
    assert check.status == "missing"
    assert check.download_url


# -- micromamba ----------------------------------------------------------------


def test_micromamba_found_on_path(monkeypatch: pytest.MonkeyPatch) -> None:
    selected = "/usr/local/bin/micromamba"
    captured: dict[str, Any] = {}
    monkeypatch.setattr(pybrainage, "micromamba_binary", lambda: selected)
    monkeypatch.setattr(tools, "exists", lambda path: path == selected)

    def run(argv: list[str], **options: Any) -> tools.RunResult:
        if argv == [selected, "--version"]:
            captured.update(options)
            return tools.RunResult(rc=0, stdout="2.7.0\n", stderr="")
        return tools.RunResult(rc=127, stdout="", stderr="absent")

    monkeypatch.setattr(tools, "run", run)
    check = PythonProbe()._check_micromamba(python_config())
    assert check.status == "found"
    assert selected in check.detail
    assert captured["env"]["MAMBA_ROOT_PREFIX"].endswith("/.pybrainage/mamba-root")
    assert captured["env"]["PIP_CACHE_DIR"].endswith("/.pybrainage/pip-cache")
    assert not captured["env"]["MAMBA_ROOT_PREFIX"].startswith("/out/run/")
    assert not Path(captured["env"]["MAMBA_ROOT_PREFIX"]).exists()


def test_fsl_only_micromamba_is_not_a_provisioning_false_positive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fsl_bin = os.path.expanduser("~/fsl/bin/micromamba")
    monkeypatch.setattr(tools, "exists", lambda path: path == fsl_bin)
    check = _checks_by_id(python_config())["micromamba"]
    assert check.status == "missing"
    assert fsl_bin not in check.detail


def test_conda_only_install_is_not_a_provisioning_false_positive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        tools,
        "which",
        lambda name: "/opt/conda/bin/conda" if name == "conda" else None,
    )
    check = _checks_by_id(python_config())["micromamba"]
    assert check.status == "missing"
    assert "(conda)" not in check.detail


def test_micromamba_wrong_when_selected_version_is_not_exact(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    selected = "/opt/micromamba"
    monkeypatch.setattr(pybrainage, "micromamba_binary", lambda: selected)
    monkeypatch.setattr(tools, "exists", lambda path: path == selected)
    monkeypatch.setattr(
        tools,
        "run",
        lambda argv, **_options: (
            tools.RunResult(rc=0, stdout="2.7.1\n", stderr="")
            if argv == [selected, "--version"]
            else tools.RunResult(rc=127, stdout="", stderr="absent")
        ),
    )

    check = _checks_by_id(python_config())["micromamba"]

    assert check.status == "wrong"
    assert "Use micromamba 2.7.0" in check.detail
    assert "2.7.1" in check.detail


def test_micromamba_wrong_when_selected_digest_is_not_exact(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    selected = "/opt/micromamba"
    calls = 0
    monkeypatch.setattr(pybrainage, "micromamba_binary", lambda: selected)
    monkeypatch.setattr(tools, "exists", lambda path: path == selected)
    monkeypatch.setattr(
        pybrainage,
        "micromamba_identity",
        lambda candidate=None: (candidate or selected, "0" * 64),
    )

    def run(_argv: list[str], **_options: Any) -> tools.RunResult:
        nonlocal calls
        calls += 1
        return tools.RunResult(rc=0, stdout="2.7.0\n", stderr="")

    monkeypatch.setattr(tools, "run", run)

    check = PythonProbe()._check_micromamba(python_config())

    assert check.status == "wrong"
    assert "reviewed SHA-256" in check.detail
    assert calls == 0


def test_micromamba_defers_without_a_resolved_output_dir() -> None:
    check = PythonProbe()._check_micromamba({})
    assert check.status == "skipped"
    assert check.detail == (
        "Supraspina verifies the provisioning micromamba after a project "
        "resolves paths.outputDir."
    )
    serialized = check.to_dict()
    assert "recommendedCmd" not in serialized
    assert "installable" not in serialized


def test_micromamba_missing_with_manual_installer() -> None:
    check = _checks_by_id(python_config())["micromamba"]
    assert check.status == "missing"
    assert check.download_url.endswith("/2.7.0-0/micromamba-linux-64")
    assert check.installer is not None
    assert check.installer.kind == "manual"
    assert (
        "fb4554d61a1c567726890169e39c41aa8495dbba56f50957ee7356572b6c5726"
        in check.installer.one_liner
    )
    assert "sha256sum --check -" in check.installer.one_liner
    assert "latest" not in check.installer.one_liner
    assert "fetch micromamba manually" in check.installer.note


def test_micromamba_missing_uses_the_sole_linux_asset() -> None:
    check = _checks_by_id(python_config())["micromamba"]
    assert check.download_url.endswith("/2.7.0-0/micromamba-linux-64")
    assert "osx" not in check.download_url


# -- pypkgs --------------------------------------------------------------------


def _run_imports(
    present: list[str],
    *,
    externally_managed: bool = False,
    incompatible: list[str] | None = None,
):
    """Build a fake ``tools.run`` for the combined probe reporting ``present``.

    Print the marker version line, the PEP 668 line, and the resolvable import
    names in one invocation. Serve the ``python`` and ``pypkgs`` checks with one
    fake interpreter start.
    """

    def fake_run(argv: list[str], **_kw: Any) -> tools.RunResult:
        body = (
            "\n".join(
                [
                    f"{_VERSION_MARK}Python 3.12.3",
                    f"{_MANAGED_MARK}{'1' if externally_managed else '0'}",
                    *present,
                    *(f"{_INCOMPATIBLE_MARK}{line}" for line in incompatible or []),
                ]
            )
            + "\n"
        )
        return tools.RunResult(rc=0, stdout=body, stderr="")

    return fake_run


def test_stage_check_reports_a_dependency_below_its_declared_minimum(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # pandas refuses an openpyxl older than the minimum its metadata declares,
    # so the brainpad and clinical scripts fail at import even though every
    # module resolves. Report it as a wrong dependency before a run.
    monkeypatch.setattr(
        tools,
        "run",
        _run_imports(
            list(PY_ANALYSIS_IMPORTS),
            incompatible=["openpyxl 3.0.10 below pandas minimum 3.1.5"],
        ),
    )
    checks = _checks_by_id(python_config())
    assert checks["brainpadpython"].status == "wrong"
    assert "openpyxl 3.0.10 below pandas minimum 3.1.5" in (
        checks["brainpadpython"].detail
    )
    assert checks["clinicalpython"].status == "wrong"


def test_probe_script_reports_a_dependency_below_its_declared_minimum(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["probe", "pandas", "openpyxl"])
    monkeypatch.setattr(
        md, "version", lambda name: {"openpyxl": "3.0.10"}.get(name, "0")
    )
    monkeypatch.setattr(
        md,
        "requires",
        lambda name: ['openpyxl>=3.1.5; extra == "excel"'] if name == "pandas" else [],
    )

    exec(compile(_PROBE_SCRIPT, "<probe>", "exec"), {})  # noqa: S102

    lines = capsys.readouterr().out.splitlines()
    assert f"{_INCOMPATIBLE_MARK}openpyxl 3.0.10 below pandas minimum 3.1.5" in lines


def test_pypkgs_found_when_all_present(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "run", _run_imports(list(PY_ANALYSIS_IMPORTS)))
    check = _checks_by_id(python_config())["pypkgs"]
    assert check.status == "found"
    assert check.installer is None


def test_pypkgs_wrong_when_some_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    present = ["pandas", "numpy", "scipy", "matplotlib"]
    monkeypatch.setattr(tools, "run", _run_imports(present))
    check = _checks_by_id(python_config())["pypkgs"]
    assert check.status == "wrong"
    assert "cliffs_delta" in check.detail
    assert "seaborn" in check.detail
    assert "openpyxl" in check.detail
    assert check.installer is not None
    assert check.installer.kind == "command"
    # Map the pip distribution name instead of the import name.
    assert "cliffs-delta==1.0.0" in check.installer.argv
    assert "openpyxl==3.1.5" in check.installer.argv
    assert check.installer.argv[:5] == [
        "/usr/bin/python3",
        "-m",
        "pip",
        "install",
        "--user",
    ]
    assert "sudo" not in check.installer.argv


@pytest.mark.parametrize(
    ("in_virtualenv", "expected"),
    [(False, "1"), (True, "0")],
)
def test_probe_script_reports_pep_668_only_where_pip_enforces_it(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    in_virtualenv: bool,
    expected: str,
) -> None:
    # Ignore a base-interpreter marker visible inside a virtual environment.
    # Avoid offering an opt-out for a policy that pip does not apply there.
    monkeypatch.setattr(sys, "argv", ["probe"])
    monkeypatch.setattr(sys, "base_prefix", "/usr")
    monkeypatch.setattr(sys, "prefix", "/opt/venv" if in_virtualenv else "/usr")
    monkeypatch.setattr(
        os.path,
        "exists",
        lambda path: str(path).endswith("EXTERNALLY-MANAGED"),
    )

    exec(compile(_PROBE_SCRIPT, "<probe>", "exec"), {})  # noqa: S102

    lines = capsys.readouterr().out.splitlines()
    managed = [line for line in lines if line.startswith(_MANAGED_MARK)]
    assert managed == [f"{_MANAGED_MARK}{expected}"]


def test_pypkgs_fix_opts_out_of_pep_668_on_an_externally_managed_python(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Add the required distro-policy opt-out instead of offering an unusable
    # plain --user installer.
    present = [name for name in PY_ANALYSIS_IMPORTS if name != "cliffs_delta"]
    monkeypatch.setattr(tools, "run", _run_imports(present, externally_managed=True))
    checks = _checks_by_id(python_config())
    check = checks["pypkgs"]
    assert check.status == "wrong"
    assert check.installer is not None
    assert check.installer.argv == [
        "/usr/bin/python3",
        "-m",
        "pip",
        "install",
        "--user",
        _PEP_668_OPT_OUT,
        "cliffs-delta==1.0.0",
    ]
    assert check.recommended_cmd == (
        f"/usr/bin/python3 -m pip install --user {_PEP_668_OPT_OUT} cliffs-delta==1.0.0"
    )
    assert check.installer.one_liner == check.recommended_cmd
    assert "PEP 668" in check.detail
    assert "PEP 668" in check.installer.note
    assert "sudo" not in check.installer.argv
    # State the same fact in the interpreter check for operator context.
    assert checks["python"].detail == (
        "/usr/bin/python3 (Python 3.12.3) is under PEP 668 external management."
    )


def test_pypkgs_fix_stays_plain_on_an_unmanaged_python(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    present = [name for name in PY_ANALYSIS_IMPORTS if name != "cliffs_delta"]
    monkeypatch.setattr(tools, "run", _run_imports(present, externally_managed=False))
    checks = _checks_by_id(python_config())
    check = checks["pypkgs"]
    assert check.installer is not None
    assert _PEP_668_OPT_OUT not in check.installer.argv
    assert "PEP 668" not in check.detail
    assert checks["python"].detail == "/usr/bin/python3 (Python 3.12.3)."


def test_pypkgs_missing_when_none_present(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tools, "run", _run_imports([]))
    check = _checks_by_id(python_config())["pypkgs"]
    assert check.status == "missing"


def test_pypkgs_warn_when_probe_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    # Report a non-zero import probe as a probe failure rather than an empty
    # import set. Warn without offering a fix.
    monkeypatch.setattr(
        tools,
        "run",
        lambda _argv, **_kw: tools.RunResult(
            rc=1,
            stdout="",
            stderr="Report the fixture failure.",
        ),
    )
    check = _checks_by_id(python_config())["pypkgs"]
    assert check.status == "warn"
    assert "probing required packages failed" in check.detail
    assert "interpreter error" in check.detail
    assert check.installer is None
    assert check.recommended_cmd == ""


def test_pypkgs_skipped_when_python_absent() -> None:
    cfg = python_config()
    cfg["tools"]["pythonExecutable"] = ""
    check = _checks_by_id(cfg)["pypkgs"]
    assert check.status == "skipped"
    assert check.installer is None


def test_pypkgs_cliffs_hint_when_only_cliffs_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    present = [n for n in PY_ANALYSIS_IMPORTS if n != "cliffs_delta"]
    monkeypatch.setattr(tools, "run", _run_imports(present))
    check = _checks_by_id(python_config())["pypkgs"]
    assert check.status == "wrong"
    assert check.recommended_cmd == (
        "/usr/bin/python3 -m pip install --user cliffs-delta==1.0.0"
    )


def test_pypkgs_never_probes_configured_pybrainage_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = python_config()
    cfg["tools"]["pythonExecutable"] = ""
    cfg["steps"]["pybrainage"] = {"enabled": True, "params": {}}
    cfg["steps"]["pybrainage"]["params"]["pythonExecutable"] = (
        "/project/runtime/bin/python"
    )

    calls: list[list[str]] = []

    def run(argv: list[str], **_options: Any) -> tools.RunResult:
        calls.append(argv)
        return tools.RunResult(rc=127, stdout="", stderr="absent")

    monkeypatch.setattr(tools, "run", run)

    check = _checks_by_id(cfg)["pypkgs"]

    assert check.status == "skipped"
    assert check.installer is None
    assert all(call[0] != "/project/runtime/bin/python" for call in calls)


# -- pyenv ---------------------------------------------------------------------


def test_pyenv_found(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = python_config()
    env_python = os.path.join(pybrainage.env_dir(cfg), "bin", "python")
    monkeypatch.setattr(tools, "exists", lambda path: path == env_python)
    monkeypatch.setattr(
        pybrainage,
        "provision_state_status",
        lambda _cfg: (True, "a" * 64),
    )
    check = _checks_by_id(cfg)["pyenv"]
    assert check.status == "found"
    assert env_python in check.detail
    assert "a" * 64 in check.detail


def test_pyenv_missing_offers_the_typed_setup_action() -> None:
    cfg = python_config()
    check = _checks_by_id(cfg)["pyenv"]
    assert check.status == "missing"
    assert check.detail == (
        "Set up PyBrainAge to create the locked environment and record its provenance."
    )
    assert check.installer is None
    assert check.recommended_cmd == ""
    assert check.download_url == ""
    assert check.action is not None
    assert check.action.kind == "setup-pybrainage"
    assert check.action.label == "Set up PyBrainAge"
    serialized = check.to_dict()
    assert "recommendedCmd" not in serialized
    assert "downloadUrl" not in serialized
    assert "installable" not in serialized
    assert serialized["action"] == {
        "kind": "setup-pybrainage",
        "label": "Set up PyBrainAge",
    }
    assert "provision.pybrainage" not in json.dumps(serialized)


def test_pyenv_wrong_when_provenance_state_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = python_config()
    env_python = pybrainage.env_python(cfg)
    monkeypatch.setattr(tools, "exists", lambda path: path == env_python)
    monkeypatch.setattr(
        pybrainage,
        "provision_state_status",
        lambda _cfg: (False, "Provision PyBrainAge to create provenance state."),
    )

    check = _checks_by_id(cfg)["pyenv"]

    assert check.status == "wrong"
    assert "provenance state" in check.detail
    assert check.action is not None
    assert check.action.kind == "setup-pybrainage"


# -- modelfile -----------------------------------------------------------------


def test_modelfile_found(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = python_config()
    cfg["steps"]["pybrainage"] = {
        "enabled": True,
        "params": {"modelPath": "", "scalerPath": ""},
    }
    model_path = os.path.join(
        pybrainage.model_root(cfg), "software", pybrainage.PYBRAINAGE_MODEL_FILE
    )
    monkeypatch.setattr(tools, "file_nonempty", lambda path: path == model_path)
    monkeypatch.setattr(
        pybrainage,
        "provision_state_status",
        lambda _cfg: (True, "a" * 64),
    )
    check = _checks_by_id(cfg)["modelfile"]
    assert check.status == "found"
    assert model_path in check.detail
    assert "a" * 64 in check.detail


def test_modelfile_rejects_nonempty_file_without_provision_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = python_config()
    model_path = os.path.join(
        pybrainage.model_root(cfg), "software", pybrainage.PYBRAINAGE_MODEL_FILE
    )
    monkeypatch.setattr(tools, "file_nonempty", lambda path: path == model_path)
    monkeypatch.setattr(
        pybrainage,
        "provision_state_status",
        lambda _cfg: (False, "Provision PyBrainAge to restore provenance."),
    )

    assert _checks_by_id(cfg)["modelfile"].status == "missing"


def test_modelfile_missing_offers_the_typed_setup_action() -> None:
    cfg = python_config()
    check = _checks_by_id(cfg)["modelfile"]
    assert check.status == "missing"
    assert "108 MB" in check.detail
    assert "Zenodo record" in check.detail
    assert check.download_url == "https://zenodo.org/records/10406573"
    assert check.installer is None
    assert check.recommended_cmd == ""
    assert check.action is not None
    assert check.action.kind == "setup-pybrainage"
    assert check.action.label == "Set up PyBrainAge"
    assert "provision.pybrainage" not in json.dumps(check.to_dict())


# -- scalerfile ----------------------------------------------------------------


def test_scalerfile_found(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = python_config()
    cfg["steps"]["pybrainage"] = {
        "enabled": True,
        "params": {"modelPath": "", "scalerPath": ""},
    }
    scaler_path = os.path.join(
        pybrainage.model_root(cfg), "software", pybrainage.PYBRAINAGE_SCALER_FILE
    )
    monkeypatch.setattr(tools, "file_nonempty", lambda path: path == scaler_path)
    monkeypatch.setattr(
        pybrainage,
        "provision_state_status",
        lambda _cfg: (True, "b" * 64),
    )
    check = _checks_by_id(cfg)["scalerfile"]
    assert check.status == "found"
    assert scaler_path in check.detail
    assert "b" * 64 in check.detail


def test_scalerfile_rejects_nonempty_file_without_provision_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = python_config()
    scaler_path = os.path.join(
        pybrainage.model_root(cfg), "software", pybrainage.PYBRAINAGE_SCALER_FILE
    )
    monkeypatch.setattr(tools, "file_nonempty", lambda path: path == scaler_path)
    monkeypatch.setattr(
        pybrainage,
        "provision_state_status",
        lambda _cfg: (False, "Provision PyBrainAge to restore provenance."),
    )

    assert _checks_by_id(cfg)["scalerfile"].status == "missing"


def test_scalerfile_missing_offers_the_typed_setup_action() -> None:
    cfg = python_config()
    check = _checks_by_id(cfg)["scalerfile"]
    assert check.status == "missing"
    assert "scaler.pkl" in check.detail
    assert "Zenodo record" in check.detail
    assert check.download_url == "https://zenodo.org/records/10406573"
    assert check.installer is None
    assert check.recommended_cmd == ""
    assert check.action is not None
    assert check.action.kind == "setup-pybrainage"
    assert check.action.label == "Set up PyBrainAge"
    assert "provision.pybrainage" not in json.dumps(check.to_dict())


def test_no_python_check_serializes_an_rpc_method_name() -> None:
    cfg = python_config()
    for check in PythonProbe().checks(cfg):
        assert "provision.pybrainage" not in json.dumps(check.to_dict())
