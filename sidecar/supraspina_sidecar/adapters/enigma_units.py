"""Per-subject units of ENIGMA QC for incremental reuse.

The wrapper renders three montage sets per subject through separate MATLAB
Runtime launchers (Steps 3 to 5), each reading only that subject's files, and
then assembles cohort CSVs and HTML galleries. This contract names those three
units so the workflow engine can leave a verified earlier render in place.

Launching works through a run-owned shim directory passed as ``--script``. Its
``run_*.sh`` launchers skip a listed subject and otherwise run the real
compiled launcher with the same arguments, so upstream's measure extraction
and gallery assembly run unchanged over the full subject list. Only the MATLAB
Runtime backend is covered: the source backend inlines its MATLAB calls.

The contract lives outside :mod:`.enigma` on purpose: provenance binds that
module's bytes into every ENIGMA receipt, and this file changes only how the
work is scheduled.
"""

from __future__ import annotations

import hashlib
import os
import shlex
from typing import Any

from .base import ADAPTERS, ExecutionAction, UnitContract, UnitSpec, register_units

#: Map each unit part to its compiled launcher, the 1-based position of the
#: subject id in that launcher's arguments, and the output subdirectory.
_LAUNCHERS = {
    "subcortical": ("run_func_make_subcorticalFS_ENIGMA_QC.sh", 3, "qc/subcortical"),
    "internal": ("run_func_make_corticalpngs_ENIGMA_QC.sh", 3, "qc/cortical_internal"),
    "external": ("run_FS_external_QC.sh", 4, "qc/cortical_external"),
}
_EXTERNAL_VIEWS = ("lh.lat", "lh.med", "rh.lat", "rh.med")
_EXTERNAL_INPUTS = (
    "surf/lh.pial.T1",
    "surf/rh.pial.T1",
    "label/lh.aparc.annot",
    "label/rh.aparc.annot",
)


#: Digests of runtime files by (path, size, mtime, inode), so a plan does not
#: read the runtime library again while it is unchanged.
_DIGEST_CACHE: dict[tuple[str, int, int, int], str] = {}
_MAX_CACHED_DIGESTS = 16


def _file_sha256(path: str) -> str | None:
    """Return one file's SHA-256, cached while its identity is unchanged."""
    try:
        info = os.stat(path)
    except OSError:
        return None
    key = (path, info.st_size, info.st_mtime_ns, info.st_ino)
    cached = _DIGEST_CACHE.get(key)
    if cached is not None:
        return cached
    try:
        with open(path, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
    except OSError:
        return None
    if len(_DIGEST_CACHE) >= _MAX_CACHED_DIGESTS:
        _DIGEST_CACHE.clear()
    _DIGEST_CACHE[key] = digest
    return digest


def _gallery_files(part: str, subject_id: str) -> tuple[str, ...]:
    """Return the panels the gallery references for one subject and part.

    The detector requires these; ROI images beside them are owned by the
    unit but not required, since the wrapper's fallback render omits them.
    """
    from .enigma import gallery_panels  # noqa: PLC0415

    gallery = {"subcortical": "subcortical", "internal": "cortical_internal"}[part]
    subdir = _LAUNCHERS[part][2]
    files: list[str] = []
    for panel in gallery_panels(gallery, subject_id):
        for relative in (panel.montage_relative, panel.full_relative):
            path = f"{subdir}/{relative}"
            if path not in files:
                files.append(path)
    return tuple(files)


def _normalized_volume(cfg: dict[str, Any]) -> str:
    """Return the intensity volume the wrapper passes for the saved fsVersion.

    Mirror the wrapper: FreeSurfer 8 reads ``nu.mgz``; 5, 6, 7 and any value
    it does not recognize (which it treats as 7) read ``orig_nu.mgz``.
    """
    params = ADAPTERS["enigma"].params(cfg)
    return (
        "mri/nu.mgz"
        if str(params.get("fsVersion") or "7") == "8"
        else ("mri/orig_nu.mgz")
    )


def _launcher_script(skip_file: str, real_launcher: str, position: int) -> str:
    """Return one POSIX launcher that skips listed subjects."""
    return (
        "#!/bin/sh\n"
        "# Written by Supraspina for one run. A listed subject keeps its verified\n"
        "# earlier render; every other subject runs the compiled launcher.\n"
        f'subject="${{{position}}}"\n'
        f'if grep -Fxq -- "$subject" {shlex.quote(skip_file)}; then\n'
        '  echo "Reused the verified earlier render for $subject."\n'
        "  exit 0\n"
        "fi\n"
        f'exec sh {shlex.quote(real_launcher)} "$@"\n'
    )


class EnigmaUnits(UnitContract):
    """Declare ENIGMA QC's subcortical, internal and external renders."""

    step_key = "enigma"
    version = "enigma-qc-units:v1"
    #: MATLAB writes a creation time into every PNG it saves.
    outputs_embed_time = True

    def method_identity(self, cfg: dict[str, Any]) -> dict[str, Any]:
        """Bind the MATLAB Runtime's version file and runtime library bytes.

        The tool evidence names the runtime root and its release, not its
        update level. Resolve the root as the command does: the configured
        ``mcrRoot``, else the conventional install root.
        """
        from ..env.constants import MCR_RUNTIME_LIBRARY  # noqa: PLC0415
        from ..env.matlab import ambient_mcr_root  # noqa: PLC0415

        adapter = ADAPTERS["enigma"]
        root = adapter.resolve(str(adapter.params(cfg).get("mcrRoot") or ""), cfg)
        root = root or ambient_mcr_root()
        return {
            name: _file_sha256(os.path.join(root, *name.split("/")) if root else "")
            for name in ("VersionInfo.xml", MCR_RUNTIME_LIBRARY)
        }

    def applies(self, cfg: dict[str, Any]) -> bool:
        """Cover the MATLAB Runtime backend only."""
        from .enigma import _resolved_backend  # noqa: PLC0415

        return _resolved_backend(cfg) == "mcr"

    def output_root(self, cfg: dict[str, Any]) -> str:
        """Return the wrapper's QC output directory."""
        return str(ADAPTERS["enigma"]._out_dir(cfg))  # type: ignore[attr-defined]

    def units(self, cfg: dict[str, Any], subject_id: str) -> tuple[UnitSpec, ...]:
        """Return the three renders the wrapper makes for one subject."""
        volumes = (_normalized_volume(cfg), "mri/aparc+aseg.mgz")
        external_dir = _LAUNCHERS["external"][2]
        return (
            UnitSpec(
                part="subcortical",
                inputs=volumes,
                output_dir=f"{_LAUNCHERS['subcortical'][2]}/{subject_id}",
                required_files=_gallery_files("subcortical", subject_id),
            ),
            UnitSpec(
                part="internal",
                inputs=volumes,
                output_dir=f"{_LAUNCHERS['internal'][2]}/{subject_id}",
                required_files=_gallery_files("internal", subject_id),
            ),
            UnitSpec(
                part="external",
                inputs=_EXTERNAL_INPUTS,
                output_files=tuple(
                    f"{external_dir}/{subject_id}.{view}.png"
                    for view in _EXTERNAL_VIEWS
                ),
            ),
        )

    def launch_action(
        self,
        cfg: dict[str, Any],
        action: ExecutionAction,
        skipped: dict[str, frozenset[str]],
        work_dir: str,
    ) -> ExecutionAction:
        """Swap ``--script`` for a shim directory that skips reused subjects."""
        del cfg
        argv = list(action.argv)
        if action.kind != "process" or argv.count("--script") != 1:
            raise ValueError("Use the ENIGMA wrapper command with one --script.")
        index = argv.index("--script") + 1
        if index >= len(argv) or not argv[index]:
            raise ValueError("Provide the ENIGMA compiled script directory.")
        compiled = argv[index]
        os.makedirs(work_dir, exist_ok=True)
        for part, (launcher, position, _subdir) in _LAUNCHERS.items():
            skip_file = os.path.join(work_dir, f"{part}.skip")
            with open(skip_file, "w", encoding="utf-8") as handle:
                handle.writelines(
                    f"{subject_id}\n" for subject_id in sorted(skipped.get(part, ()))
                )
            # The wrapper runs each launcher through ``sh``, so no mode bits.
            script = os.path.join(work_dir, launcher)
            with open(script, "w", encoding="utf-8") as handle:
                handle.write(
                    _launcher_script(
                        skip_file, os.path.join(compiled, launcher), position
                    )
                )
        argv[index] = work_dir
        return ExecutionAction(kind=action.kind, argv=tuple(argv))


register_units(EnigmaUnits())
