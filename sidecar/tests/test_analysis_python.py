"""Tests for the shared Age, Clinical, and Brain-PAD Python resolver."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.adapters import tools
from supraspina_sidecar.adapters.age import AgeAdapter
from supraspina_sidecar.adapters.analysis_python import (
    pybrainage_env_python,
    resolve_analysis_interpreter,
)
from supraspina_sidecar.adapters.base import guard_resolved
from supraspina_sidecar.adapters.brainpad import BrainpadAdapter
from supraspina_sidecar.adapters.clinical import ClinicalAdapter


def _cfg(output_dir: str) -> dict[str, Any]:
    """Return a concrete minimal configuration for all three adapters."""
    return {
        "paths": {
            "projectRoot": "/project",
            "outputDir": output_dir,
            "ageMetadataFile": "/project/metadata/age.csv",
            "clinicalMetadataFile": "/project/metadata/clinical.csv",
        },
        "tools": {"pythonExecutable": ""},
        "steps": {
            "age": {"enabled": True, "params": {}},
            "clinical": {"enabled": True, "params": {}},
            "brainpad": {"enabled": True, "params": {}},
            "pybrainage": {
                "enabled": True,
                "params": {"pythonExecutable": ""},
            },
        },
    }


def _stage_interpreters(cfg: dict[str, Any]) -> list[str]:
    """Return the interpreter selected by every shared-runtime adapter."""
    adapters = (AgeAdapter(), ClinicalAdapter(), BrainpadAdapter())
    return [adapter.build_command(cfg, None)[0] for adapter in adapters]


def test_explicit_tool_python_has_priority_for_every_analysis_stage() -> None:
    cfg = _cfg("/project/outputs")
    cfg["tools"]["pythonExecutable"] = "/explicit/bin/python"
    cfg["steps"]["pybrainage"]["params"]["pythonExecutable"] = "/pybrainage/bin/python"

    assert _stage_interpreters(cfg) == ["/explicit/bin/python"] * 3


def test_configured_pybrainage_python_is_not_shared_with_analysis_stages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = _cfg("/project/outputs")
    cfg["steps"]["pybrainage"]["params"]["pythonExecutable"] = "/pybrainage/bin/python"
    monkeypatch.setattr(
        tools,
        "which",
        lambda name: "/usr/bin/python3" if name == "python3" else None,
    )

    assert _stage_interpreters(cfg) == ["/usr/bin/python3"] * 3


def test_existing_provisioned_python_is_not_shared_when_paths_are_unset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _cfg(str(tmp_path))
    provisioned = Path(pybrainage_env_python(cfg))
    provisioned.parent.mkdir(parents=True)
    provisioned.touch()
    monkeypatch.setattr(tools, "which", lambda _name: None)

    assert resolve_analysis_interpreter(cfg) == ""


def test_general_fallback_uses_host_python3_for_every_analysis_stage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cfg = _cfg("/project/outputs")
    monkeypatch.setattr(
        tools,
        "which",
        lambda name: "/usr/bin/python3" if name == "python3" else None,
    )

    assert _stage_interpreters(cfg) == ["/usr/bin/python3"] * 3


def test_unresolved_explicit_tool_path_fails_command_guard_closed() -> None:
    cfg = _cfg("/project/outputs")
    cfg["tools"]["pythonExecutable"] = "${missingRuntime}/bin/python"
    argv = AgeAdapter().build_command(cfg, None)

    with pytest.raises(ValueError, match="unresolved placeholder"):
        guard_resolved("age", argv)


def test_frozen_sidecar_candidate_ignores_configured_pybrainage_python(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frozen_sidecar = "/opt/Supraspina/resources/sidecar/supraspina-sidecar"
    cfg = _cfg("/project/outputs")
    cfg["tools"]["pythonExecutable"] = frozen_sidecar
    cfg["steps"]["pybrainage"]["params"]["pythonExecutable"] = "/pybrainage/bin/python"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", frozen_sidecar)
    monkeypatch.setattr(
        tools,
        "which",
        lambda name: "/usr/bin/python3" if name == "python3" else None,
    )

    assert resolve_analysis_interpreter(cfg) == "/usr/bin/python3"


def test_frozen_sidecar_is_never_returned_without_a_safe_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frozen_sidecar = "/opt/Supraspina/resources/sidecar/supraspina-sidecar"
    cfg = _cfg("/project/outputs")
    cfg["tools"]["pythonExecutable"] = frozen_sidecar
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", frozen_sidecar)
    monkeypatch.setattr(tools, "which", lambda _name: None)

    assert resolve_analysis_interpreter(cfg) == ""


def test_missing_output_config_preserves_provisioning_placeholder() -> None:
    assert pybrainage_env_python({}).startswith("${paths.outputDir}")
