"""The ``supraspina.project.json`` schema mirrored with Pydantic.

The module mirrors the canonical Zod schema in
``src/shared/project-schema.ts`` so the main process and the sidecar validate
the same shape. Keep the two in lockstep; a JSON Schema can be emitted from
either side to cross-check them.
"""

from __future__ import annotations

import math
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

PlatformMode = Literal["linux", "wsl"]
PathStyle = Literal["posix", "windows"]


class _Strict(BaseModel):
    """Forbid unknown keys to catch configuration drift early."""

    model_config = ConfigDict(extra="forbid")


class ProjectMeta(_Strict):
    """Represent the project identity block."""

    name: str
    createdAt: str


class Platform(_Strict):
    """Represent the platform mode and path style."""

    mode: PlatformMode
    pathStyle: PathStyle


class ProjectPaths(_Strict):
    """Represent filesystem locations read and written by the pipeline."""

    projectRoot: str
    rawdataDir: str
    derivativesDir: str
    outputDir: str
    metadataDir: str
    clinicalMetadataFile: str | None = None
    ageMetadataFile: str | None = None
    qcOutputDir: str | None = None


class ToolPaths(_Strict):
    """Represent resolved external tool locations."""

    freesurferHome: str
    freesurferLicense: str
    matlabExecutable: str | None = None
    mcrRoot: str | None = None
    pythonExecutable: str
    rscriptExecutable: str


class Patterns(_Strict):
    """Represent subject and T1w discovery globs."""

    subjectGlob: str
    t1Pattern: str


class RuntimeSettings(_Strict):
    """Represent concurrency and safe-execution defaults."""

    threads: int = Field(ge=1, le=64)
    queueSize: int = Field(ge=1, le=32)
    memoryWarningGB: float = Field(ge=1)
    # Read dryRun strictly, mirroring the canonical Zod boolean. The executor
    # reads the raw JSON value, so a coerced string would let validation and
    # execution disagree about whether commands actually run.
    dryRun: bool = Field(strict=True)
    resumeCompleted: bool
    rerunIncomplete: bool
    stopOnError: bool
    continueIndependentAfterError: bool


class SubjectsSelection(_Strict):
    """Represent explicit subject inclusion and exclusion."""

    include: list[str]
    exclude: list[str]


class StepOverride(_Strict):
    """Represent per-step enablement and parameter overrides."""

    enabled: bool
    params: dict[str, Any]


class PyBrainSettings(_Strict):
    """Represent PyBrainAge model and scaler locations."""

    modelPath: str
    scalerPath: str


class OutputsSettings(_Strict):
    """Represent the output root and manifest location."""

    rootDir: str
    runDir: str
    manifestPath: str


class Provenance(_Strict):
    """Represent reproducibility provenance written at save or run time."""

    configSha256: str
    runId: str
    gitSha: str | None = None


class ProjectConfig(_Strict):
    """Represent the full persisted project configuration."""

    project: ProjectMeta
    platform: Platform
    paths: ProjectPaths
    tools: ToolPaths
    patterns: Patterns
    runtime: RuntimeSettings
    subjects: SubjectsSelection
    steps: dict[str, StepOverride]
    pybrain: PyBrainSettings
    outputs: OutputsSettings
    provenance: Provenance


_UNSAFE_CONTROL = re.compile(r"[\x00\r\n]")
_PLACEHOLDER = re.compile(r"\$\{([^}]+)\}")
_WINDOWS_DRIVE_ROOT = re.compile(r"^[A-Za-z]:[\\/]")
_MAX_TEMPLATE_PASSES = 6

# Limit this compact mirror to parameter type constraints. Keep host-dependent
# requirements in adapter preflight checks instead of config-shape validation.
# Align these entries with ``src/shared/steps.ts``.
_STEP_PARAM_SPECS: dict[str, dict[str, tuple[Any, ...]]] = {
    "brainfov": {
        "marginMm": ("int", 15, 60),
    },
    "deface": {
        "tool": ("choice", ("mri_deface", "fsl_deface", "pydeface", "skip")),
        "forceOverwrite": ("bool",),
    },
    "recon": {
        "backend": ("choice", ("freesurfer", "fastsurfer", "auto")),
        "fastsurferDevice": ("choice", ("auto", "cpu", "cuda")),
        "directives": ("text",),
        "parallel": ("bool",),
    },
    "enigma": {
        "backend": ("choice", ("auto", "matlab", "mcr")),
        "matlabExecutable": ("path",),
        "mcrRoot": ("path",),
        "enigmaScriptDir": ("path",),
        "outDir": ("path",),
        "fsVersion": ("choice", ("5", "6", "7", "8")),
    },
    "outliers": {
        "zThreshold": ("float", 0, None),
    },
    "features": {
        "parcellation": (
            "choice",
            ("aparc.a2009s", "aparc.DKTatlas", "aparc"),
        ),
        "measure": ("choice", ("thickness", "area", "volume")),
        "outDir": ("path",),
        "validateFeatureOrder": ("bool",),
    },
    "age": {
        "subjectIdColumn": ("text",),
        "ageColumn": ("text",),
        "join": ("choice", ("inner", "left", "outer")),
        "warnOnMissing": ("bool",),
    },
    "pybrainage": {
        "pythonExecutable": ("path",),
        "modelPath": ("path",),
        "scalerPath": ("path",),
        "rowFallback": ("bool",),
    },
    "clinical": {
        "joinKey": ("text",),
        "requiredColumns": ("text",),
    },
    "brainpad": {
        "outDir": ("path",),
    },
    "aggregate": {
        "subjectGlob": ("text",),
        "outDir": ("path",),
    },
    "final": {
        "rscriptExecutable": ("path",),
        "outDir": ("path",),
        "renderReport": ("bool",),
    },
    "braincharts": {
        "seed": ("int", 0, 2_147_483_647),
    },
    "zstats": {
        "renderReport": ("bool",),
    },
}


def validate_project_config(data: Any) -> tuple[bool, list[str], list[str]]:
    """Validate a candidate project configuration.

    Parameters
    ----------
    data
        Provide the candidate configuration, typically parsed JSON.

    Returns
    -------
    tuple
        Return ``(ok, errors, warnings)`` while mirroring the TypeScript
        validator.
    """
    try:
        cfg = ProjectConfig.model_validate(data)
    except ValidationError as exc:
        errors = [
            f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
        ]
        return False, errors, []
    errors = _structural_errors(cfg)
    if errors:
        return False, errors, []
    return True, [], _advisories(cfg)


def _safe_relative_segment(value: str) -> bool:
    return bool(
        value
        and value != "."
        and "/" not in value
        and "\\" not in value
        and ".." not in value
        and _UNSAFE_CONTROL.search(value) is None
    )


def _duplicates(values: list[str]) -> list[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    return sorted(duplicates)


def _flatten_strings(value: Any) -> dict[str, str]:
    """Match the renderer's dotted and first-seen bare string aliases."""
    out: dict[str, str] = {}

    def walk(node: Any, prefix: str) -> None:
        if isinstance(node, str):
            out[prefix] = node
            leaf = prefix.rsplit(".", 1)[-1]
            if leaf:
                out.setdefault(leaf, node)
            return
        if isinstance(node, dict):
            for key, child in node.items():
                walk(child, f"{prefix}.{key}" if prefix else str(key))
        elif isinstance(node, list):
            for index, child in enumerate(node):
                walk(child, f"{prefix}.{index}" if prefix else str(index))

    walk(value, "")
    return out


def _resolve_template(template: str, flat: dict[str, str]) -> str:
    value = template
    for _ in range(_MAX_TEMPLATE_PASSES):
        if "${" not in value:
            break

        def substitute(match: re.Match[str]) -> str:
            return flat.get(match.group(1).strip(), match.group(0))

        resolved = _PLACEHOLDER.sub(substitute, value)
        if resolved == value:
            break
        value = resolved
    return value


def _is_absolute_project_path(value: str, path_style: str) -> bool:
    """Report whether a resolved path is absolute for the declared path style."""
    candidate = value.strip()
    if path_style == "windows":
        return bool(
            candidate.startswith("/")
            or _WINDOWS_DRIVE_ROOT.match(candidate)
            or candidate.startswith("\\\\")
        )
    return candidate.startswith("/")


def _lexical_path_parts(value: str, path_style: str) -> tuple[str, ...]:
    """Normalize a resolved path for a host-independent containment check."""
    normalized = value.strip()
    if path_style == "windows":
        normalized = normalized.replace("\\", "/").lower()
    parts: list[str] = []
    for part in normalized.split("/"):
        if part in {"", "."}:
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return tuple(parts)


def _paths_overlap(left: str, right: str, path_style: str) -> bool:
    """Return whether either resolved path equals or contains the other."""
    left_parts = _lexical_path_parts(left, path_style)
    right_parts = _lexical_path_parts(right, path_style)

    def prefix(parent: tuple[str, ...], child: tuple[str, ...]) -> bool:
        return len(parent) <= len(child) and child[: len(parent)] == parent

    return prefix(left_parts, right_parts) or prefix(right_parts, left_parts)


def _check_param(  # noqa: PLR0912
    errors: list[str],
    path: str,
    value: Any,
    spec: tuple[Any, ...],
    check_template: Any,
) -> None:
    kind = spec[0]
    if kind == "bool":
        if not isinstance(value, bool):
            errors.append(f"Provide {path} as a boolean.")
    elif kind == "int":
        minimum, maximum = spec[1], spec[2]
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or not minimum <= value <= maximum
        ):
            errors.append(
                f"Keep {path} as an integer from {minimum} through {maximum}."
            )
    elif kind == "float":
        bounds = spec[1:]
        minimum = bounds[0] if bounds else None
        maximum = bounds[1] if len(bounds) > 1 else None
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or (minimum is not None and value < minimum)
            or (maximum is not None and value > maximum)
        ):
            bounds = (
                f" greater than or equal to {minimum}"
                if minimum is not None and maximum is None
                else ""
            )
            errors.append(f"Provide {path} as a finite number{bounds}.")
    elif kind == "text":
        if not isinstance(value, str):
            errors.append(f"Provide text for {path}.")
    elif kind == "path":
        if not isinstance(value, str):
            errors.append(f"Provide a path string for {path}.")
        else:
            check_template(path, value)
    elif kind == "choice":
        options = spec[1]
        if not isinstance(value, str) or value not in options:
            errors.append(f"Select one of {', '.join(options)} for {path}.")


def _is_parts_prefix(parent: tuple[str, ...], child: tuple[str, ...]) -> bool:
    return len(parent) <= len(child) and child[: len(parent)] == parent


def _rawdata_overlap_errors(
    data: dict[str, Any],
    flat: dict[str, str],
    path_style: str,
) -> list[str]:
    """Report writable paths that overlap the raw data, once per cause.

    A raw data directory that holds the whole project explains every collision
    inside the project root, and one colliding directory explains its own
    descendants, so those duplicates collapse into the owning message. The
    refusal condition itself is unchanged: the result is non-empty exactly
    when at least one writable path overlaps the raw data directory.

    A path that still carries a ``${...}`` token cannot be compared, so report
    it rather than skipping it. Skipping would clear a configuration this check
    never inspected.
    """
    rawdata_dir = _resolve_template(data["paths"]["rawdataDir"], flat)
    if "${" in rawdata_dir:
        return [
            "Resolve the unresolved or cyclic template reference in "
            "paths.rawdataDir so the writable paths can be checked against it."
        ]
    if not (rawdata_dir and _is_absolute_project_path(rawdata_dir, path_style)):
        return []
    writable_paths = (
        ("paths.derivativesDir", data["paths"].get("derivativesDir")),
        ("paths.outputDir", data["paths"].get("outputDir")),
        ("paths.qcOutputDir", data["paths"].get("qcOutputDir")),
        ("outputs.rootDir", data["outputs"].get("rootDir")),
        ("outputs.runDir", data["outputs"].get("runDir")),
        ("outputs.manifestPath", data["outputs"].get("manifestPath")),
    )
    collisions: list[tuple[str, tuple[str, ...]]] = []
    unresolved: list[str] = []
    for path, raw in writable_paths:
        if not isinstance(raw, str):
            continue
        resolved = _resolve_template(raw, flat)
        if "${" in resolved:
            unresolved.append(
                f"Resolve the unresolved or cyclic template reference in {path} "
                "so it can be checked against paths.rawdataDir."
            )
            continue
        if (
            resolved
            and _is_absolute_project_path(resolved, path_style)
            and _paths_overlap(rawdata_dir, resolved, path_style)
        ):
            collisions.append((path, _lexical_path_parts(resolved, path_style)))
    if not collisions:
        return unresolved
    errors: list[str] = list(unresolved)
    rawdata_parts = _lexical_path_parts(rawdata_dir, path_style)
    project_root = _resolve_template(data["paths"]["projectRoot"], flat)
    project_parts = _lexical_path_parts(project_root, path_style)
    project_inside_rawdata = (
        bool(project_root)
        and "${" not in project_root
        and _is_absolute_project_path(project_root, path_style)
        and _is_parts_prefix(rawdata_parts, project_parts)
    )
    if project_inside_rawdata:
        errors.append(
            "Keep paths.rawdataDir separate from paths.projectRoot: "
            "they resolve to the same directory, so every writable "
            "path inside the project lands in the raw data."
            if _is_parts_prefix(project_parts, rawdata_parts)
            else "Keep paths.rawdataDir separate from "
            "paths.projectRoot: the project directory is inside the "
            "raw data directory, so every writable path inside the "
            "project lands in the raw data."
        )
    reported: list[tuple[str, ...]] = []
    for path, parts in collisions:
        if project_inside_rawdata and _is_parts_prefix(project_parts, parts):
            continue
        explained_by_ancestor = any(
            len(other_parts) < len(parts) and _is_parts_prefix(other_parts, parts)
            for _other_path, other_parts in collisions
        )
        if explained_by_ancestor or any(
            _is_parts_prefix(prev, parts) for prev in reported
        ):
            continue
        reported.append(parts)
        errors.append(f"Keep {path} separate from paths.rawdataDir.")
    return errors


def _structural_errors(  # noqa: PLR0912
    cfg: ProjectConfig,
) -> list[str]:
    """Return deterministic config errors without inspecting the host."""
    errors: list[str] = []
    expected_steps = set(_STEP_PARAM_SPECS)
    actual_steps = set(cfg.steps)
    missing_steps = sorted(expected_steps - actual_steps)
    unknown_steps = sorted(actual_steps - expected_steps)
    if missing_steps:
        errors.append(f"Add the missing pipeline steps: {', '.join(missing_steps)}.")
    if unknown_steps:
        errors.append(f"Remove unknown pipeline steps: {', '.join(unknown_steps)}.")
    for name, pattern in vars(cfg.patterns).items():
        if not _safe_relative_segment(pattern):
            errors.append(
                f"Provide patterns.{name} as a non-empty relative single-segment "
                "glob without traversal or control characters."
            )

    for name in ("include", "exclude"):
        values = getattr(cfg.subjects, name)
        for index, subject_id in enumerate(values):
            if not _safe_relative_segment(subject_id):
                errors.append(
                    f"Provide subjects.{name}.{index} as a safe single-segment "
                    "subject ID."
                )
        duplicates = _duplicates(values)
        if duplicates:
            errors.append(
                f"Remove duplicate subject IDs from subjects.{name}: "
                f"{', '.join(duplicates)}."
            )

    data = cfg.model_dump(exclude_none=True)
    flat = _flatten_strings(data)

    def check_template(
        path: str,
        raw: str,
        *,
        required: bool = False,
        absolute: bool = False,
    ) -> None:
        if _UNSAFE_CONTROL.search(raw):
            errors.append(f"Remove NULs and line breaks from {path}.")
            return
        resolved = _resolve_template(raw, flat)
        if "${" in resolved:
            errors.append(
                f"Resolve the unresolved or cyclic template reference in {path}."
            )
            return
        if required and not resolved:
            errors.append(f"Resolve {path} to a non-empty path.")
            return
        if (
            resolved
            and absolute
            and not _is_absolute_project_path(resolved, cfg.platform.pathStyle)
        ):
            errors.append(f"Resolve {path} to an absolute path.")

    required_paths = {
        "projectRoot",
        "rawdataDir",
        "derivativesDir",
        "outputDir",
        "metadataDir",
    }
    for name, value in data["paths"].items():
        check_template(
            f"paths.{name}",
            value,
            required=name in required_paths,
            absolute=True,
        )
    for name, value in data["outputs"].items():
        check_template(f"outputs.{name}", value, required=True, absolute=True)

    errors.extend(_rawdata_overlap_errors(data, flat, cfg.platform.pathStyle))

    for section in ("tools", "pybrain"):
        for name, value in data[section].items():
            check_template(f"{section}.{name}", value)

    for step_name, specs in _STEP_PARAM_SPECS.items():
        step = cfg.steps.get(step_name)
        if step is None:
            continue
        errors.extend(
            f"Remove unknown parameter steps.{step_name}.params.{name}."
            for name in step.params
            if name not in specs
        )
        for name, spec in specs.items():
            if name not in step.params:
                continue
            _check_param(
                errors,
                f"steps.{step_name}.params.{name}",
                step.params[name],
                spec,
                check_template,
            )
    return errors


def _advisories(cfg: ProjectConfig) -> list[str]:
    """Collect non-blocking advisories about a parsed configuration."""
    warnings: list[str] = []
    if not cfg.tools.freesurferHome:
        warnings.append(
            "Set the FreeSurfer folder in Diagnostics before running reconstruction.",
        )
    if not cfg.pybrain.modelPath:
        warnings.append(
            "Provision the PyBrainAge model at pybrain.modelPath.",
        )
    features = cfg.steps.get("features")
    if features is not None:
        parcellation = features.params.get("parcellation")
        if parcellation is not None and parcellation != "aparc.a2009s":
            warnings.append(
                "Use aparc.a2009s (Destrieux) for Steps 3 and 8 instead of "
                f'features.parcellation "{parcellation}".',
            )
    return warnings
