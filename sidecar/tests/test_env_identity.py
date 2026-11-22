"""Golden tests for the receipt identity of environment check details.

Receipts bind each required check's ``identitySha256``, which
:func:`provenance.environment_check_evidence` digests from the check's
identity text. The displayed details state facts, but for the same probe
results the identity must stay pinned, or every receipt that binds the check
would read out of date. The expected digests are pinned in
``fixtures/env-identity.json``; a copy edit must never change them.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import resources
from supraspina_sidecar.adapters import enigma, pybrainage, tools
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.env import freesurfer as freesurfer_env
from supraspina_sidecar.env import matlab as matlab_env
from supraspina_sidecar.env import python as python_env
from supraspina_sidecar.env import r as r_env
from supraspina_sidecar.env import repo as repo_env
from supraspina_sidecar.env import shell as shell_env
from supraspina_sidecar.env.base import Check
from supraspina_sidecar.env.platform import PlatformProbe
from supraspina_sidecar.provenance import (
    bound_tool_evidence,
    environment_check_evidence,
    stable_digest,
)
from supraspina_sidecar.workflow_manager import WorkflowManager
from tests.test_schema import default_config

#: Tokenize this resource root, as a packaged build's active root would be.
RESOURCE_ROOT = "/opt/supraspina/resources"
FSHOME = "/usr/local/freesurfer"
PYTHON = "/usr/bin/python3"
RSCRIPT = "/usr/bin/Rscript"
PROVENANCE = "a3" * 32

Case = Callable[[pytest.MonkeyPatch, Path], list[Check]]


def _config(**params: dict[str, Any]) -> dict[str, Any]:
    """Return the default configuration with per-step parameters merged in."""
    cfg = default_config()
    for step, values in params.items():
        cfg["steps"].setdefault(step, {}).setdefault("params", {}).update(values)
    return cfg


def _redirect_path(
    monkeypatch: pytest.MonkeyPatch, fixed: str, real: Path, *names: str
) -> None:
    """Answer ``os`` path queries for ``fixed`` from the real ``real`` path."""
    for name in names:
        original = getattr(os, name)

        def redirected(
            path: Any, *args: Any, _original: Any = original, **kwargs: Any
        ) -> Any:
            target = str(real) if os.fspath(path) == fixed else path
            return _original(target, *args, **kwargs)

        monkeypatch.setattr(os, name, redirected)


# -- FreeSurfer ----------------------------------------------------------------


def _reconall(release: str) -> Case:
    def case(monkeypatch: pytest.MonkeyPatch, _tmp: Path) -> list[Check]:
        monkeypatch.setattr(
            freesurfer_env, "_locate", lambda home, name: f"{home}/bin/{name}"
        )
        return [freesurfer_env.FreeSurferProbe()._check_reconall(FSHOME, release)]

    return case


def _license(mode: int) -> Case:
    def case(monkeypatch: pytest.MonkeyPatch, tmp: Path) -> list[Check]:
        license_file = tmp / "license.txt"
        license_file.write_text("fixture\n", encoding="utf-8")
        license_file.chmod(mode)
        monkeypatch.setattr(
            freesurfer_env.FreeSurferProbe,
            "_license_path",
            lambda _self, _cfg, _home: str(license_file),
        )
        return [freesurfer_env.FreeSurferProbe()._check_license({}, FSHOME)]

    return case


def _output_parent(check_id: str, subdir: str) -> Case:
    def case(monkeypatch: pytest.MonkeyPatch, tmp: Path) -> list[Check]:
        fixed = f"/data/study/derivatives/{subdir}"
        _redirect_path(monkeypatch, fixed, tmp, "lstat", "access")
        cfg = {"paths": {"derivativesDir": "/data/study/derivatives"}}
        return [
            freesurfer_env.FreeSurferProbe()._check_output_parent(
                cfg,
                subdir=subdir,
                check_id=check_id,
                label=check_id,
                backend_label="FreeSurfer",
            )
        ]

    return case


# -- MATLAB / MATLAB Runtime ---------------------------------------------------


def _matlab_host(
    monkeypatch: pytest.MonkeyPatch, *, matlab: bool, mcr_release: str | None
) -> None:
    """Install MATLAB R2026a and, unless ``mcr_release`` is None, a Runtime."""
    monkeypatch.setattr(
        tools, "which", lambda name: "/opt/matlab/bin/matlab" if matlab else None
    )
    monkeypatch.setattr(matlab_env, "_matlabroot", lambda _exe: "/opt/matlab")
    monkeypatch.setattr(matlab_env, "_read_release", lambda _root: "R2026a")
    monkeypatch.setattr(matlab_env, "_has_image_toolbox", lambda _root: True)
    root = "/opt/mcr/v97" if mcr_release is not None else ""
    monkeypatch.setattr(matlab_env, "_find_mcr_root", lambda _cfg, _probe: root)
    monkeypatch.setattr(
        matlab_env, "_infer_mcr_release", lambda _path: mcr_release or ""
    )
    monkeypatch.setattr(tools, "exists", lambda _path: True)
    monkeypatch.setattr(matlab_env, "_non_executable_compiled_binaries", lambda: [])


def _matlab_probe(backend: str, *, matlab: bool, mcr_release: str | None) -> Case:
    def case(monkeypatch: pytest.MonkeyPatch, _tmp: Path) -> list[Check]:
        _matlab_host(monkeypatch, matlab=matlab, mcr_release=mcr_release)
        return matlab_env.MatlabProbe().checks(_config(enigma={"backend": backend}))

    return case


def _unselected_without_detail(
    _monkeypatch: pytest.MonkeyPatch, _tmp: Path
) -> list[Check]:
    blank = Check(id="mcr", label="MATLAB Runtime", status="missing", detail="")
    return [matlab_env._unselected_backend(blank, "source MATLAB")]


# -- Python / conda ------------------------------------------------------------


def _python(managed: bool) -> Case:
    def case(_monkeypatch: pytest.MonkeyPatch, _tmp: Path) -> list[Check]:
        probe = python_env._PythonProbe(
            "Python 3.12.3", list(python_env.PY_ANALYSIS_IMPORTS), managed
        )
        probe_env = python_env.PythonProbe()
        return [
            probe_env._check_python(PYTHON, probe),
            probe_env._check_pypkgs(PYTHON, probe),
        ]

    return case


def _micromamba(monkeypatch: pytest.MonkeyPatch, _tmp: Path) -> list[Check]:
    monkeypatch.setattr(
        pybrainage, "micromamba_binary", lambda: "/opt/supraspina/bin/micromamba"
    )
    monkeypatch.setattr(pybrainage, "provision_root", lambda _cfg: "/out/pybrainage")
    monkeypatch.setattr(
        pybrainage,
        "probe_micromamba_version",
        lambda _cfg, micromamba=None: tools.RunResult(rc=0, stdout="", stderr=""),
    )
    return [python_env.PythonProbe()._check_micromamba(default_config())]


def _stage_pythons(monkeypatch: pytest.MonkeyPatch, _tmp: Path) -> list[Check]:
    for step_key, _check_id, _label in python_env._STAGE_CHECKS:
        monkeypatch.setattr(
            ADAPTERS[step_key],
            "build_command",
            lambda _cfg, _subject: [PYTHON, "-m", "stage"],
        )
    monkeypatch.setattr(python_env, "_stage_runtime_environment", lambda _cfg: {})
    monkeypatch.setattr(
        python_env.PythonProbe,
        "_probe_python",
        lambda _self, _python, imports, env=None: python_env._PythonProbe(
            "Python 3.12.3", list(imports), False, ()
        ),
    )
    probe = python_env.PythonProbe()
    cfg = default_config()
    return [
        probe._stage_check(cfg, *descriptor) for descriptor in python_env._STAGE_CHECKS
    ]


def _pybrainage(monkeypatch: pytest.MonkeyPatch, _tmp: Path) -> list[Check]:
    env_python = "/out/pybrainage/env/bin/python"
    monkeypatch.setattr(
        ADAPTERS["pybrainage"],
        "build_command",
        lambda _cfg, _subject: [
            env_python,
            "--model",
            "/out/pybrainage/software/model.pkl",
            "--scaler",
            "/out/pybrainage/software/scaler.pkl",
        ],
    )
    versions = {
        "python": "3.7.12",
        "numpy": "1.21.6",
        "pandas": "1.3.5",
        "sklearn": "0.24.2",
        "scipy": "1.7.3",
        "openpyxl": "3.1.2",
        "matplotlib": "3.5.3",
        "seaborn": "0.12.2",
        "statsmodels": "0.13.5",
        "pip": "24.0",
        "cliffs-delta": "1.0.0",
    }
    monkeypatch.setattr(
        pybrainage,
        "probe_runtime_versions",
        lambda _cfg, python=None: (
            tools.RunResult(rc=0, stdout="", stderr=""),
            versions,
        ),
    )
    monkeypatch.setattr(pybrainage, "runtime_version_mismatches", lambda _v: [])
    monkeypatch.setattr(pybrainage, "env_python", lambda _cfg: env_python)
    monkeypatch.setattr(
        pybrainage, "provision_state_status", lambda _cfg: (True, PROVENANCE)
    )
    monkeypatch.setattr(tools, "exists", lambda _path: True)
    monkeypatch.setattr(tools, "file_nonempty", lambda _path: True)
    probe = python_env.PythonProbe()
    cfg = default_config()
    return [
        probe._check_pyenv(cfg),
        probe._check_modelfile(cfg),
        probe._check_scalerfile(cfg),
        probe._check_pybrainpython(cfg),
    ]


# -- Shell utilities -----------------------------------------------------------


def _shell(present: bool) -> Case:
    def case(monkeypatch: pytest.MonkeyPatch, tmp: Path) -> list[Check]:
        monkeypatch.setattr(
            tools, "which", lambda name: f"/usr/bin/{name}" if present else None
        )
        monkeypatch.setattr(tools, "exists", lambda _path: present)
        monkeypatch.setattr(
            shell_env, "resolve_freesurfer_home", lambda _cfg: FSHOME if present else ""
        )
        monkeypatch.setattr(
            shell_env, "host_mode", lambda: "wsl" if present else "linux"
        )
        monkeypatch.setattr(shell_env, "ubuntu_host", lambda: present)
        template = tmp / "template.gca"
        template.write_text("fixture\n", encoding="utf-8")
        for name in ("talairach_mixed_with_skull.gca", "face.gca"):
            fixed = f"{FSHOME}/average/{name}"
            _redirect_path(
                monkeypatch, fixed, template if present else tmp / "absent", "stat"
            )
        return shell_env.ShellProbe().checks(default_config())

    return case


def _deface_templates(*names: str) -> Case:
    """Place only the named defacing templates under the FreeSurfer home."""

    def case(monkeypatch: pytest.MonkeyPatch, tmp: Path) -> list[Check]:
        monkeypatch.setattr(shell_env, "resolve_freesurfer_home", lambda _cfg: FSHOME)
        template = tmp / "template.gca"
        template.write_text("fixture\n", encoding="utf-8")
        for name in ("talairach_mixed_with_skull.gca", "face.gca"):
            real = template if name in names else tmp / "absent"
            _redirect_path(monkeypatch, f"{FSHOME}/average/{name}", real, "stat")
        return [shell_env.ShellProbe()._mri_deface_templates_check(default_config())]

    return case


# -- Pipeline assets -----------------------------------------------------------


class _Present:
    """Stand in for a resource path that exists as a regular file."""

    @staticmethod
    def is_file() -> bool:
        return True


def _assets(monkeypatch: pytest.MonkeyPatch, _tmp: Path) -> list[Check]:
    monkeypatch.setattr(resources, "resource_dir", lambda *_parts: _Present())
    monkeypatch.setattr(resources, "enigma_dir", lambda: Path(RESOURCE_ROOT) / "enigma")
    monkeypatch.setattr(resources, "verify_manifest", lambda _directory: ([], []))
    probe = repo_env.BundledAssetsProbe()
    return [
        probe._check_scientific_assets(None),
        probe._check_enigma_assets(None),
        *(
            probe._check_stage_assets(*descriptor, None)
            for descriptor in repo_env._STAGE_ASSETS
        ),
        probe._check_pipeline_assets(None),
    ]


def _damaged_enigma_assets(acquisition: repo_env.Acquisition) -> Case:
    """Report one missing and one mismatched ENIGMA asset."""

    def case(monkeypatch: pytest.MonkeyPatch, _tmp: Path) -> list[Check]:
        monkeypatch.setattr(
            resources, "enigma_dir", lambda: Path(RESOURCE_ROOT) / "enigma"
        )
        monkeypatch.setattr(
            resources,
            "verify_manifest",
            lambda _directory: (["compiled/run.sh"], ["ENIGMA_QC/func_qc.m"]),
        )
        monkeypatch.setattr(
            resources,
            "scientific_asset_acquisition_command",
            lambda: ["supraspina-sidecar", "acquire-assets"],
        )
        probe = repo_env.BundledAssetsProbe()
        return [probe._check_enigma_assets(acquisition)]

    return case


# -- R -------------------------------------------------------------------------


def _r(installed: set[str], render: bool) -> Case:
    def case(monkeypatch: pytest.MonkeyPatch, _tmp: Path) -> list[Check]:
        monkeypatch.setattr(tools, "which", lambda _name: None)
        query = r_env._RscriptQuery(version="4.3.3", installed=installed, ok=True)
        cfg = _config(final={"renderReport": render})
        probe = r_env.RProbe()
        return [
            probe._rscript_check(RSCRIPT, query),
            probe._final_rscript_check(RSCRIPT, query),
            probe._rmarkdown_check(cfg, RSCRIPT, query),
            probe._knitr_check(cfg, RSCRIPT, query),
            probe._pandoc_check(cfg, RSCRIPT, query),
        ]

    return case


# -- Platform ------------------------------------------------------------------


def _wsl(mode: str) -> Case:
    def case(_monkeypatch: pytest.MonkeyPatch, _tmp: Path) -> list[Check]:
        return [PlatformProbe()._wsl_check(mode)]

    return case


CASES: dict[str, Case] = {
    "reconall-release": _reconall("8.2.0"),
    "reconall-unknown-release": _reconall(""),
    "license-644": _license(0o644),
    "license-600": _license(0o600),
    "subjdir-writable": _output_parent("subjdir", "freesurfer"),
    "fastsurferdir-writable": _output_parent("fastsurferdir", "fastsurfer"),
    "matlab-selected-both-found": _matlab_probe(
        "matlab", matlab=True, mcr_release="R2019b"
    ),
    "mcr-selected-both-found": _matlab_probe("mcr", matlab=True, mcr_release="R2019b"),
    "mcr-selected-unnamed-runtime": _matlab_probe("mcr", matlab=True, mcr_release=""),
    "matlab-selected-no-runtime": _matlab_probe(
        "matlab", matlab=True, mcr_release=None
    ),
    "mcr-selected-no-matlab": _matlab_probe("mcr", matlab=False, mcr_release="R2019b"),
    "auto-neither-backend": _matlab_probe("auto", matlab=False, mcr_release=None),
    "unselected-without-detail": _unselected_without_detail,
    "python-unmanaged": _python(False),
    "python-managed": _python(True),
    "micromamba": _micromamba,
    "stage-pythons": _stage_pythons,
    "pybrainage": _pybrainage,
    "shell-present": _shell(True),
    "shell-absent": _shell(False),
    "deface-templates-one": _deface_templates("face.gca"),
    "assets": _assets,
    "enigma-assets-damaged": _damaged_enigma_assets(None),
    "enigma-assets-rebuild": _damaged_enigma_assets("rebuild"),
    "enigma-assets-download": _damaged_enigma_assets("download"),
    "r-report-packages": _r({"knitr", "rmarkdown"}, True),
    "r-no-report": _r(set(), False),
    "wsl-host": _wsl("wsl"),
    "native-host": _wsl("linux"),
}

#: Record an environment in which every checked tool is present.
ENVIRONMENT_CASES = (
    "reconall-release",
    "license-644",
    "subjdir-writable",
    "fastsurferdir-writable",
    "mcr-selected-both-found",
    "python-unmanaged",
    "micromamba",
    "stage-pythons",
    "pybrainage",
    "shell-present",
    "assets",
    "r-report-packages",
    "wsl-host",
)


def case_checks(name: str, monkeypatch: pytest.MonkeyPatch, tmp: Path) -> list[Check]:
    """Run one fixture case and return its checks."""
    return CASES[name](monkeypatch, tmp)


def evidence(check: Check) -> dict[str, Any]:
    """Return the evidence a run records for one check."""
    return environment_check_evidence(check.to_dict(), (RESOURCE_ROOT,))


_GOLDEN = json.loads(
    (Path(__file__).parent / "fixtures" / "env-identity.json").read_text(
        encoding="utf-8"
    )
)
#: Map ``<case>/<check id>`` to its pinned identitySha256.
EXPECTED_IDENTITY: dict[str, str] = _GOLDEN["identity"]
#: Map ``<adapter>/<configuration>`` to its pinned bound tool-evidence digest.
EXPECTED_TOOL_EVIDENCE: dict[str, str] = _GOLDEN["toolEvidence"]

#: Configurations whose required check ids span every adapter branch.
ADAPTER_CONFIGS: dict[str, tuple[dict[str, Any], bool, str]] = {
    "defaults": (
        _config(enigma={"backend": "mcr"}),
        False,
        "",
    ),
    "matlab-fastsurfer-wsl": (
        _config(
            enigma={"backend": "matlab"},
            recon={"backend": "fastsurfer"},
            final={"renderReport": False},
            deface={"tool": "fsl_deface"},
        ),
        True,
        ":0",
    ),
}


@pytest.mark.parametrize("name", sorted(CASES))
def test_check_identity_matches_the_pin(
    name: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    checks = case_checks(name, monkeypatch, tmp_path)
    monkeypatch.undo()
    recorded = {f"{name}/{check.id}": evidence(check) for check in checks}
    expected = {
        key: value
        for key, value in EXPECTED_IDENTITY.items()
        if key.startswith(f"{name}/")
    }
    assert {key: item["identitySha256"] for key, item in recorded.items()} == expected


def _recorded_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> dict[str, Any]:
    environment: dict[str, Any] = {}
    for index, name in enumerate(ENVIRONMENT_CASES):
        workdir = tmp_path / str(index)
        workdir.mkdir()
        checks = case_checks(name, monkeypatch, workdir)
        monkeypatch.undo()
        environment.update({check.id: evidence(check) for check in checks})
    return environment


#: Stages whose bound tool evidence has no pin.
UNPINNED_STAGES = frozenset({"braincharts", "zstats"})


@pytest.mark.parametrize("config_name", sorted(ADAPTER_CONFIGS))
def test_bound_tool_evidence_matches_the_pin(
    config_name: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    environment = _recorded_environment(monkeypatch, tmp_path)
    cfg, wsl, display = ADAPTER_CONFIGS[config_name]
    monkeypatch.setattr(enigma, "_host_is_wsl", lambda: wsl)
    monkeypatch.setenv("DISPLAY", display)
    digests: dict[str, str] = {}
    for key in sorted(ADAPTERS):
        if key in UNPINNED_STAGES:
            continue
        check_ids = ADAPTERS[key].required_check_ids(cfg)
        digests[f"{key}/{config_name}"] = stable_digest(
            bound_tool_evidence(environment, check_ids)
        )
    expected = {
        key: value
        for key, value in EXPECTED_TOOL_EVIDENCE.items()
        if key.split("/")[1] == config_name
    }
    assert digests == expected


#: Mark text that phrases a detected state or outcome as an order.
_ORDER_PHRASES = (
    "Use ",
    "Skip ",
    "Treat this backend",
    "Translate paths",
    "Detect no installation",
    "; confirm ",
    "skip automatic probing",
    "; find ",
    "currently find",
)


@pytest.mark.parametrize("name", sorted(CASES))
def test_details_state_facts(
    name: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    for check in case_checks(name, monkeypatch, tmp_path):
        if check.identity_detail is not None:
            assert check.detail != check.identity_detail
        # Actionable guidance stays imperative, such as "Use it as the
        # license-free alternative by selecting the mcr backend".
        facts = check.detail.replace("Use it as the", "")
        assert not any(phrase in facts for phrase in _ORDER_PHRASES), check.detail


def test_identity_detail_serializes_only_when_it_differs() -> None:
    plain = Check(id="x", label="X", status="found", detail="A fact.")
    same = Check(
        id="x", label="X", status="found", detail="A fact.", identity_detail="A fact."
    )
    reworded = Check(
        id="x", label="X", status="found", detail="A fact.", identity_detail="Old."
    )

    assert "identityDetail" not in plain.to_dict()
    assert "identityDetail" not in same.to_dict()
    assert reworded.to_dict()["identityDetail"] == "Old."
    assert evidence(reworded) == environment_check_evidence(
        {"status": "found", "detail": "Old."}, (RESOURCE_ROOT,)
    )


@pytest.mark.parametrize(
    ("name", "version"),
    [("reconall-release", "8.2.0"), ("reconall-unknown-release", "unknown release")],
)
def test_provider_version_reads_the_reworded_detail(
    name: str, version: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Receipts bind the provider version parsed from the displayed detail.
    (check,) = case_checks(name, monkeypatch, tmp_path)
    report = {"groups": [{"name": "FreeSurfer", "checks": [check.to_dict()]}]}

    assert WorkflowManager._provider_summary(report) == {
        "freesurfer": {"version": version}
    }
