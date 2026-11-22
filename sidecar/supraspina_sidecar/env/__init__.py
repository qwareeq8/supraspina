"""Environment probe aggregation and the safety gate for opt-in installs.

The renderer's ``EnvReport`` is assembled by importing every ENV_GROUP probe
module for its ``register_probe`` side effect and iterating :data:`PROBES` in
registration order. Each probe's :class:`Check` list becomes a serialized
group, optionally filtered to a caller-supplied set of check ids. A raised
probe is downgraded to one ``warn`` fallback check, under a reserved
``probe-`` id that no real check carries, so the requirements UI can still
render every group without the fallback impersonating a required check.

The module also gates the two mutating operations exposed by the environment
subsystem. For :func:`opt_in_install`, a :class:`Check` is looked up by id,
and its installer runs only when every safety condition holds. A ``manual``
installer surfaces as a clipboard fix or download link and is never run. A
``command`` installer runs through
:func:`supraspina_sidecar.adapters.tools.run_streamed` only when its argv is
non-empty, its program basename is on
:data:`SAFE_INSTALL_PROGRAMS`, and no element is ``sudo``. Every other argv is
refused to prevent privilege escalation and system package changes. For
:func:`create_output_dir`, the caller names only a check id from a closed set;
the target path is derived from the saved configuration as
``${paths.derivativesDir}/<backend subdirectory>``, symlinks and
non-directories are refused, and creation mirrors the reconstruction
adapter's spawn-time semantics.

The headline checks collapse into the top-bar summary for the selected
reconstruction backend, the QC backend, the analysis Python interpreters,
PyBrainAge, R packages, and the reviewed scientific assets, reusing
:func:`collapse_status` so the bar and the detailed report remain consistent.
The summary follows the saved configuration: an item whose owning stages are
disabled reports ``na`` instead of ``missing``, matching the renderer's
pipeline-aware requirement projection.
"""

from __future__ import annotations

import os
import re
import stat
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from ..adapters import tools
from ..paths import flatten, interpolate
from . import (  # noqa: F401 - Register the probes on import.
    braincharts,
    freesurfer,
    matlab,
    platform,
    python,
    r,
    repo,
    shell,
)
from .base import PROBES, SAFE_INSTALL_PROGRAMS, Check, Probe, collapse_status
from .r import _render_report_enabled

#: Collapse every run of non-identifier characters when naming a fallback check.
_NON_ID_CHARACTERS = re.compile(r"[^a-z0-9]+")

#: Map each selectable ENIGMA QC backend to the check that proves it runnable.
_QC_BACKEND_CHECKS: dict[str, str] = {"matlab": "matlab", "mcr": "mcr"}
#: Mirror the saved-project default in ``shared/steps.ts``: resolve to the
#: first installed backend, preferring source MATLAB.
_DEFAULT_QC_BACKEND = "auto"

#: Describe the reconstruction headline item per selectable backend. Name the
#: label of the runtime the configured backend launches, and source the item
#: from the full check list the matching branch of the ``recon`` entry of
#: ``STEP_CHECK_REQUIREMENTS`` in ``shared/steps.ts`` names, so the top bar
#: never reads healthier than the gate that admits the stage to a run.
_RECON_BACKEND_ITEMS: dict[str, tuple[str, tuple[str, ...]]] = {
    "freesurfer": ("FreeSurfer", ("reconall", "fshome", "license")),
    "fastsurfer": ("FastSurfer", ("license",)),
    "auto": ("FreeSurfer", ("reconall", "fshome", "license")),
}
#: Mirror the saved-project default in ``shared/steps.ts``.
_DEFAULT_RECON_BACKEND = "freesurfer"

#: Source the analysis-Python headline item from the stage interpreters that
#: each adapter's ``required_check_ids`` gates, keyed by their owning stage.
_ANALYSIS_PYTHON_SOURCES: tuple[tuple[str, str], ...] = (
    ("features", "featurepython"),
    ("age", "agepython"),
    ("clinical", "clinicalpython"),
    ("brainpad", "brainpadpython"),
    ("aggregate", "aggregatepython"),
)

#: Source the R headline item from the stage interpreters that the ``outliers``
#: and ``final`` entries of ``STEP_CHECK_REQUIREMENTS`` name, keyed by their
#: owning stage. Read the advisory package check alongside them.
_R_STAGE_SOURCES: tuple[tuple[str, str], ...] = (
    ("outliers", "rscript"),
    ("final", "finalrscript"),
)
#: Name the advisory check covering the R package stack both stages load.
_R_PACKAGE_SOURCE = "rpkgs"

#: Source the scientific-assets headline item from the stage asset checks each
#: adapter's ``required_check_ids`` gates, keyed by their owning stage, as the
#: ``*_assets`` ids of ``STEP_CHECK_REQUIREMENTS`` in ``shared/steps.ts`` name
#: them. The Final report assets apply only while the Final stage renders its
#: report.
_STAGE_ASSET_SOURCES: tuple[tuple[str, str], ...] = (
    ("enigma", "enigma_assets"),
    ("outliers", "outliers_assets"),
    ("features", "features_assets"),
    ("pybrainage", "pybrainage_assets"),
    ("brainpad", "brainpad_assets"),
    ("aggregate", "aggregate_assets"),
    ("final", "final_assets"),
    ("final", "final_report_assets"),
)
#: Name the check that reports whether the reviewed asset set must be rebuilt
#: or acquired; it applies whenever any stage asset check does, so a stale
#: acquisition reads as missing even before a stage asset row fails.
_SCIENTIFIC_ASSET_SOURCE = "scientific_assets"

#: Use this severity order to select the worst source check. Rank ``na`` below
#: every real verdict so a skipped source never outweighs a probed one.
_TOOL_SEVERITY: dict[str, int] = {"na": 0, "ok": 1, "warn": 2, "missing": 3}


def check(cfg: dict[str, Any], ids: list[str] | None = None) -> dict[str, Any]:
    """Assemble the renderer's ``EnvReport`` from every registered probe.

    Iterate :data:`PROBES` in registration order. Run each probe's ``checks()``
    against ``cfg`` and serialize the result into one group. Retain only
    matching checks and drop groups left empty when ``ids`` is given. Catch a
    raised probe and emit one ``warn`` fallback check so the report still
    renders.

    Parameters
    ----------
    cfg
        Provide the full project configuration mapping, possibly empty or
        ``None``.
    ids
        Provide an optional allowlist of check ids. Use ``None`` to keep every
        check; use a list to retain matches and drop groups that end up empty.

    Returns
    -------
    dict
        Return an ``EnvReport`` with ``capturedAt`` and serialized ``groups``.
    """
    cfg = cfg or {}
    groups: list[dict[str, Any]] = []
    for probe in PROBES:
        group_checks = _run_probe(probe, cfg)
        if ids is not None:
            allow = set(ids)
            group_checks = [c for c in group_checks if c.id in allow]
            if not group_checks:
                continue
        groups.append(
            {
                "name": probe.name,
                "checks": [c.to_dict() for c in group_checks],
            }
        )
    return {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "groups": groups,
        "availableMemoryGB": _available_memory_gb(),
    }


def _available_memory_gb() -> float | None:
    """Return OS-reported available memory when it can be read without a tool."""
    try:
        with open("/proc/meminfo", encoding="ascii") as handle:
            for line in handle:
                if line.startswith("MemAvailable:"):
                    kib = int(line.split()[1])
                    return round(kib / (1024 * 1024), 3)
    except (OSError, ValueError, IndexError):
        return None
    return None


def _probe_fallback_id(name: str) -> str:
    """Return a stable fallback check id for a probe that raised.

    Prefix the probe name with ``probe-`` so a crashed probe reports under an
    id no real check can carry, instead of impersonating the verdict of a
    required check such as ``python`` or ``matlab``.

    Returns
    -------
    str
        Return the reserved fallback id for this probe.
    """
    slug = _NON_ID_CHARACTERS.sub("-", name.lower()).strip("-")
    return f"probe-{slug}" if slug else "probe"


def _run_probe(probe: Probe, cfg: dict[str, Any]) -> list[Check]:
    """Run one probe, downgrading a raised exception to a single warn Check.

    Convert a raised ``checks()`` call into one ``warn`` fallback check carrying
    the exception text. Use this shared runner for report assembly and the
    headline-index scan so one broken probe cannot hide its siblings.

    Parameters
    ----------
    cfg
        Provide the full project configuration mapping, possibly empty.

    Returns
    -------
    list of Check
        Return the probe's checks or one ``warn`` fallback check on failure.
    """
    try:
        return probe.checks(cfg)
    except Exception as exc:
        return [
            Check(
                id=_probe_fallback_id(probe.name),
                label=probe.name,
                status="warn",
                detail=f"Inspect the probe error: {exc}.",
            )
        ]


def _index(cfg: dict[str, Any]) -> dict[str, Check]:
    """Map every check id to its :class:`Check` (last registration wins).

    Run every probe and catch failures so one broken probe never hides the rest.
    Index the resulting checks by id. Let the later check win when two probes
    emit the same id, matching report registration order.

    Parameters
    ----------
    cfg
        Provide the full project configuration mapping, possibly empty.

    Returns
    -------
    dict
        Return a mapping of check id to the owning :class:`Check`.
    """
    index: dict[str, Check] = {}
    for probe in PROBES:
        for item in _run_probe(probe, cfg):
            index[item.id] = item
    return index


def _find_check(check_id: str, cfg: dict[str, Any]) -> Check | None:
    """Find one check by id, running only the probes up to the owning one.

    Iterate :data:`PROBES` in registration order and return the first matching
    check. Stop as soon as the owning probe is found so an opt-in install never
    triggers a later unrelated probe's subprocess.

    Parameters
    ----------
    cfg
        Provide the full project configuration mapping, possibly empty.

    Returns
    -------
    Check or None
        Return the owning check or ``None`` when no probe emits ``check_id``.
    """
    for probe in PROBES:
        for item in _run_probe(probe, cfg):
            if item.id == check_id:
                return item
    return None


def _is_world_writable(path: str) -> bool:
    """Treat ``path`` as unsafe when it is world-writable or cannot be stat'd."""
    try:
        return bool(os.stat(path).st_mode & stat.S_IWOTH)
    except OSError:
        return True


def _install_path_refusal(argv0: str) -> str | None:
    """Reject a config-supplied interpreter path that is not on a trusted path.

    Match the install allowlist against ``argv[0]``'s basename. Treat the R and
    Python installer interpreter as config-supplied input. Trust a bare program
    name because the OS resolves it against ``PATH`` at execution time. Honor a
    path-bearing ``argv[0]`` only when its real target and parent directory are
    not writable by untrusted users. Return a refusal reason, or return ``None``
    when the path is trusted.
    """
    has_sep = os.sep in argv0 or bool(os.altsep and os.altsep in argv0)
    if not has_sep:
        return None
    if any(ch in argv0 for ch in ("\x00", "\n", "\r")):
        return "Remove control characters from the interpreter path."
    real = os.path.realpath(argv0)
    parent = os.path.dirname(real) or os.sep
    if _is_world_writable(parent):
        return (
            "Move the config-supplied interpreter out of the world-writable "
            "directory, or use a trusted PATH entry."
        )
    try:
        if os.stat(real).st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            return "Remove group- or world-writable permission from the interpreter."
    except OSError:
        pass  # Let execution fail safely after parent validation misses the target.
    return None


def opt_in_install(
    check_id: str,
    cfg: dict[str, Any],
    *,
    on_output: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Run a check's installer from the allowlist once live runs are allowed.

    Look up the :class:`Check` by id via :func:`_find_check`, running only the
    owning probe and any earlier probes scanned before the match. Return
    ``rc 127`` for an unknown check or a check without an installer. Return
    ``rc 126`` for a ``manual`` installer and direct the operator to its
    clipboard fix or download link. Refuse a ``command`` installer with
    ``rc 126`` when its argv is empty, its program basename is outside
    :data:`SAFE_INSTALL_PROGRAMS`, any element is ``sudo``, an element retains
    an unresolved ``${...}`` placeholder, or a path-bearing ``argv[0]`` fails
    :func:`_install_path_refusal`. Run all remaining argv through
    :func:`tools.run_streamed` with a 30-minute timeout and return the result
    verbatim.

    Parameters
    ----------
    cfg
        Provide the full project configuration mapping, possibly empty.
    on_output
        Provide an optional publisher called with each installer output line
        while the command runs. A refusal publishes nothing.

    Returns
    -------
    dict
        Return an install outcome with ``rc``, ``stdout``, and ``stderr``.
    """
    check_obj = _find_check(check_id, cfg or {})
    installer = check_obj.installer if check_obj is not None else None
    if installer is None:
        return {
            "rc": 127,
            "stdout": "",
            "stderr": "Select a known check that provides an installer.",
        }
    if installer.kind != "command":
        return {
            "rc": 126,
            "stdout": "",
            "stderr": (
                "Complete the manual install from downloadUrl or recommendedCmd."
            ),
        }
    argv = installer.argv
    if (
        not argv
        or os.path.basename(argv[0]) not in SAFE_INSTALL_PROGRAMS
        or "sudo" in argv
    ):
        return {
            "rc": 126,
            "stdout": "",
            "stderr": "Use only an approved, unprivileged install command.",
        }
    if any("${" in element for element in argv):
        return {
            "rc": 126,
            "stdout": "",
            "stderr": (
                "Resolve every config placeholder by running an environment "
                "check first."
            ),
        }
    path_refusal = _install_path_refusal(argv[0])
    if path_refusal is not None:
        return {"rc": 126, "stdout": "", "stderr": path_refusal}
    result = tools.run_streamed(argv, timeout=1800, on_output=on_output)
    return {"rc": result.rc, "stdout": result.stdout, "stderr": result.stderr}


#: Map each creatable output-directory check id onto its derivatives
#: subdirectory. Keep this set closed so ``env.createOutputDir`` can never
#: reach a path outside ``${paths.derivativesDir}``.
_OUTPUT_DIR_SUBDIRS: dict[str, str] = {
    "subjdir": freesurfer.FREESURFER_SUBDIR,
    "fastsurferdir": freesurfer.FASTSURFER_SUBDIR,
}


def _create_refusal(detail: str) -> dict[str, Any]:
    """Return a failed ``EnvCreateDirResult`` with an operator-facing reason."""
    return {"ok": False, "detail": detail}


def _output_dir_target(check_id: str, cfg: dict[str, Any]) -> tuple[str, str]:
    """Resolve a creatable output-directory target, or a refusal reason.

    Return ``(target, "")`` for a check id in :data:`_OUTPUT_DIR_SUBDIRS`
    whose derivatives directory resolves to an absolute path, and
    ``("", reason)`` otherwise. Containment rests on the closed
    :data:`_OUTPUT_DIR_SUBDIRS` map (fixed separator-free subdirectories);
    the normalization comparison below is a defensive invariant guard for
    that assumption, not an independent containment mechanism.
    """
    subdir = _OUTPUT_DIR_SUBDIRS.get(check_id)
    if subdir is None:
        return "", "Select a known output-directory check."
    derivatives = interpolate("${paths.derivativesDir}", flatten(cfg))
    if "${" in derivatives or not os.path.isabs(derivatives):
        return "", (
            "Configure an absolute derivatives directory before creating "
            "output directories."
        )
    target = os.path.join(derivatives, subdir)
    if os.path.normpath(target) != os.path.join(os.path.normpath(derivatives), subdir):
        return "", "Keep the output directory inside the derivatives directory."
    return target, ""


def _write_probe_refusal(target: str) -> str:
    """Verify ``target`` is writable with an exclusive, always-removed probe.

    Mirror ``ReconAdapter.prepare_execution``: write and fsync one probe
    file, remove it, and fsync the directory. Return a refusal reason on
    failure or an empty string on success.
    """
    probe = os.path.join(target, f".supraspina-write-probe-{uuid.uuid4().hex}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(probe, flags, 0o600)
        try:
            os.write(fd, b"ready\n")
            os.fsync(fd)
        finally:
            os.close(fd)
        os.unlink(probe)
        if os.name != "nt":
            directory_fd = os.open(
                target,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
            )
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    except OSError:
        try:
            os.unlink(probe)
        except OSError:
            pass
        return f"Make {target} writable."
    return ""


def create_output_dir(check_id: str, cfg: dict[str, Any]) -> dict[str, Any]:
    """Create one backend-owned reconstruction output parent from its check id.

    Derive the target as ``${paths.derivativesDir}/<subdirectory>`` entirely
    from the configuration; the caller names only a check id from
    :data:`_OUTPUT_DIR_SUBDIRS`, never a path. Mirror
    ``ReconAdapter.prepare_execution``: create with :func:`os.makedirs`,
    refuse a symlink or non-directory via a post-creation :func:`os.lstat`
    (so a link swapped in behind the create is detected instead of created
    over), and verify writability with an exclusive write probe that is
    always removed. The operation is advisory; the reconstruction adapter
    still owns spawn-time creation.

    Parameters
    ----------
    check_id
        Provide the id of the output-directory check to remediate
        (``subjdir`` or ``fastsurferdir``).
    cfg
        Provide the full project configuration mapping, possibly empty.

    Returns
    -------
    dict
        Return an ``EnvCreateDirResult`` with ``ok`` and a ``detail``
        sentence naming the resolved directory.
    """
    target, reason = _output_dir_target(check_id, cfg or {})
    if not target:
        return _create_refusal(reason)
    existed = os.path.lexists(target)
    try:
        os.makedirs(target, exist_ok=True)
    except FileExistsError:
        # Classify the existing non-directory below with a precise refusal.
        pass
    except OSError:
        return _create_refusal(f"Make the parent of {target} writable.")
    try:
        info = os.lstat(target)
    except OSError:
        return _create_refusal(f"Inspect {target}; checking the path failed.")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        return _create_refusal(f"Replace {target} with a directory.")
    probe_refusal = _write_probe_refusal(target)
    if probe_refusal:
        return _create_refusal(probe_refusal)
    detail = f"The directory {target} is writable." if existed else f"Created {target}."
    return {"ok": True, "detail": detail}


def tool_status(cfg: dict[str, Any]) -> dict[str, Any]:
    """Build the top-bar tool-status summary from the headline checks.

    Collapse each headline item built by :func:`_tool_items` onto the
    requirements-bar state. Report ``na`` for an item whose owning stages the
    saved configuration disables, so a stage nobody runs never presents as a
    missing tool. Report ``missing`` when an applicable item has no resolvable
    source check or an absent one. Use the most severe state for ordinary
    multi-source items. Report the reconstruction and ENIGMA QC items from the
    backends the saved configuration selects, so an installed but unselected
    backend can never make the selected one look ready; the plan gate and the
    Pipeline blockers use that same selection. Report summary ``missing`` if any
    item is missing, ``warn`` if any remaining item warns, and ``ok`` otherwise.

    Parameters
    ----------
    cfg
        Provide the full project configuration mapping, possibly empty.

    Returns
    -------
    dict
        Return a ``ToolStatus`` with ``capturedAt``, ``items``, and ``summary``.
    """
    cfg = cfg or {}
    index = _index(cfg)
    items: list[dict[str, str]] = []
    for item_id, label, sources, applicable in _tool_items(cfg, index):
        items.append(
            {
                "id": item_id,
                "label": label,
                "status": _item_status(index, sources) if applicable else "na",
            }
        )
    if any(item["status"] == "missing" for item in items):
        summary = "missing"
    elif any(item["status"] == "warn" for item in items):
        summary = "warn"
    else:
        summary = "ok"
    return {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "items": items,
        "summary": summary,
    }


def _resolve_qc_backend(cfg: dict[str, Any], index: dict[str, Check]) -> str:
    """Resolve the saved ENIGMA backend choice against the probed checks.

    Mirror ``effective_enigma_backend`` in :mod:`.matlab` on the check index
    already built for this report: keep an explicit choice, and resolve
    ``auto`` to the first backend whose check is ``found``, preferring source
    MATLAB, or to ``matlab`` when neither is installed.
    """
    selected = _selected_step_choice(cfg, "enigma", "backend", _DEFAULT_QC_BACKEND)
    if selected != "auto":
        return selected
    for backend, check_id in _QC_BACKEND_CHECKS.items():
        check = index.get(check_id)
        if check is not None and check.status == "found":
            return backend
    return "matlab"


def _tool_items(
    cfg: dict[str, Any], index: dict[str, Check]
) -> tuple[tuple[str, str, tuple[str, ...], bool], ...]:
    """Build the headline items the saved configuration actually uses.

    Interpret each tuple as ``(item id, label, source check ids, applicable)``.
    Mark an item inapplicable when every stage that would need it is disabled,
    and leave the sources empty to fail closed on an unknown backend selection.

    Parameters
    ----------
    cfg
        Provide the full project configuration mapping, possibly empty.
    index
        Provide the probed checks by id, used to resolve the automatic ENIGMA
        backend selection.

    Returns
    -------
    tuple
        Return the headline items in top-bar display order.
    """
    recon_label, recon_sources = _RECON_BACKEND_ITEMS.get(
        _selected_step_choice(cfg, "recon", "backend", _DEFAULT_RECON_BACKEND),
        ("Reconstruction backend", ()),
    )
    qc_check = _QC_BACKEND_CHECKS.get(_resolve_qc_backend(cfg, index))
    analysis_sources = tuple(
        check_id
        for step_key, check_id in _ANALYSIS_PYTHON_SOURCES
        if _step_enabled(cfg, step_key) and _analysis_source_applies(cfg, check_id)
    )
    r_interpreters = tuple(
        check_id
        for step_key, check_id in _R_STAGE_SOURCES
        if _step_enabled(cfg, step_key)
    )
    r_sources = (*r_interpreters, _R_PACKAGE_SOURCE) if r_interpreters else ()
    stage_assets = tuple(
        check_id
        for step_key, check_id in _STAGE_ASSET_SOURCES
        if _step_enabled(cfg, step_key) and _asset_source_applies(cfg, check_id)
    )
    asset_sources = (_SCIENTIFIC_ASSET_SOURCE, *stage_assets) if stage_assets else ()
    return (
        ("fs", recon_label, recon_sources, _step_enabled(cfg, "recon")),
        (
            "qc",
            "QC backend",
            () if qc_check is None else (qc_check,),
            _step_enabled(cfg, "enigma"),
        ),
        (
            "analysis",
            "Analysis Python",
            analysis_sources,
            bool(analysis_sources),
        ),
        (
            "py",
            "PyBrainAge",
            ("pyenv", "modelfile"),
            _step_enabled(cfg, "pybrainage"),
        ),
        ("r", "R packages", r_sources, bool(r_sources)),
        ("assets", "Scientific assets", asset_sources, bool(asset_sources)),
        # Only a project that turns BrainCharts on lists its setup; the stage
        # is off by default, so an absent switch means off here.
        *(
            (("braincharts", "BrainCharts", ("bcenv", "bcmodel"), True),)
            if _step_switched_on(cfg, "braincharts")
            else ()
        ),
    )


def _asset_source_applies(cfg: dict[str, Any], check_id: str) -> bool:
    """Report whether one stage asset check applies to the saved configuration.

    Mirror the ``final`` entry of ``STEP_CHECK_REQUIREMENTS``: the Final report
    assets are gated only while the Final stage renders its HTML report.
    """
    if check_id != "final_report_assets":
        return True
    return _render_report_enabled(cfg)


def _analysis_source_applies(cfg: dict[str, Any], check_id: str) -> bool:
    """Report whether one analysis-Python source applies to the recon backend.

    Mirror the ``features`` entry of ``STEP_CHECK_REQUIREMENTS``: the FastSurfer
    backend runs feature extraction without the FreeSurfer feature interpreter.
    """
    if check_id != "featurepython":
        return True
    backend = _selected_step_choice(cfg, "recon", "backend", _DEFAULT_RECON_BACKEND)
    return backend != "fastsurfer"


def _step_enabled(cfg: dict[str, Any], step_key: str) -> bool:
    """Report whether a stage is enabled, defaulting to enabled when unset."""
    steps = cfg.get("steps") if isinstance(cfg, dict) else None
    step = steps.get(step_key) if isinstance(steps, dict) else None
    enabled = step.get("enabled") if isinstance(step, dict) else None
    return enabled is not False


def _step_switched_on(cfg: dict[str, Any], step_key: str) -> bool:
    """Report whether the configuration explicitly turns a stage on."""
    steps = cfg.get("steps") if isinstance(cfg, dict) else None
    step = steps.get(step_key) if isinstance(steps, dict) else None
    return isinstance(step, dict) and step.get("enabled") is True


def _selected_step_choice(
    cfg: dict[str, Any], step_key: str, param: str, default: str
) -> str:
    """Return one configured stage choice, falling back to the saved default."""
    steps = cfg.get("steps") if isinstance(cfg, dict) else None
    step = steps.get(step_key) if isinstance(steps, dict) else None
    params = step.get("params") if isinstance(step, dict) else None
    value = params.get(param) if isinstance(params, dict) else None
    if isinstance(value, str) and value:
        return value
    return default


def _item_status(index: dict[str, Check], sources: tuple[str, ...]) -> str:
    """Collapse one item's source checks to the worst state.

    Treat an absent source check, and an item with no resolvable source, as
    ``missing``. Collapse present checks via :func:`collapse_status`, which maps
    a skipped check onto ``na``. Return the most severe source state.

    Parameters
    ----------
    sources
        Provide the check ids backing one top-bar item.

    Returns
    -------
    str
        ``ok``, ``warn``, ``missing``, or ``na``.
    """
    if not sources:
        return "missing"
    worst = "na"
    for source in sources:
        present = index.get(source)
        state = collapse_status(present.status) if present is not None else "missing"
        if _TOOL_SEVERITY[state] > _TOOL_SEVERITY[worst]:
            worst = state
    return worst
