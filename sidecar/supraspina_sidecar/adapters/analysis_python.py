"""Resolution of the shared Python runtime used by cohort analysis stages.

The separate Age, Clinical, and Brain-PAD adapters run in one environment
because their dependencies overlap and Clinical passes its workbook to
Brain-PAD. Their interpreter selection stays
identical to the Python Diagnostics probe.
"""

from __future__ import annotations

import os
import sys
from typing import Any

from ..paths import flatten, interpolate
from . import tools


def _dig(cfg: dict[str, Any], *keys: str) -> Any:
    """Return a nested configuration value, or ``None`` when it is absent."""
    current: Any = cfg
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def _resolve(raw: Any, cfg: dict[str, Any]) -> str:
    """Resolve one configured value while preserving unresolved placeholders."""
    value = str(raw or "")
    return interpolate(value, flatten(cfg)) if value else ""


def _configured_candidate(raw: Any, cfg: dict[str, Any]) -> str | None:
    """Return one explicit candidate unless it is the frozen sidecar."""
    resolved = _resolve(raw, cfg)
    if not resolved:
        return None
    if "${" in resolved:
        return resolved
    return tools.python_interpreter(resolved, fallback=False)


def pybrainage_env_dir(cfg: dict[str, Any]) -> str:
    """Return the published micromamba prefix for the PyBrainAge environment."""
    output_dir = interpolate("${paths.outputDir}", flatten(cfg))
    generation = cfg.get("_supraspinaProvisionGenerationRoot")
    root = (
        generation
        if isinstance(generation, str) and generation
        else os.path.join(output_dir, ".pybrainage", "current")
    )
    return os.path.join(root, "envs", "pybrainage")


def pybrainage_env_python(cfg: dict[str, Any]) -> str:
    """Return the platform-specific interpreter in the PyBrainAge prefix."""
    filename = (
        "python.exe" if sys.platform == "win32" else os.path.join("bin", "python")
    )
    return os.path.join(pybrainage_env_dir(cfg), filename)


def resolve_analysis_interpreter(
    cfg: dict[str, Any],
    *,
    allow_general_fallback: bool = True,
) -> str:
    """Resolve the interpreter shared by Age, Clinical, and Brain-PAD.

    Preserve an explicit project setting even when its path is unavailable so
    Diagnostics can report that exact failure. Return an unresolved placeholder
    so the workflow command guard fails closed
    instead of silently selecting another environment. Reject a packaged
    sidecar executable as Python before considering the next candidate.

    Parameters
    ----------
    allow_general_fallback
        Choose whether to use a real source/PATH Python after the configured
        analysis interpreter is exhausted.

    Returns
    -------
    str
        Return the resolved executable path or an empty string when no safe
        interpreter is available.
    """
    if candidate := _configured_candidate(_dig(cfg, "tools", "pythonExecutable"), cfg):
        return candidate

    return (
        tools.which("python3") or tools.which("python") or ""
        if allow_general_fallback
        else ""
    )
