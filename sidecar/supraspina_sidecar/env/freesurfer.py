"""Probe of the configured FreeSurfer environment for ``FreeSurfer`` diagnostics.

The probe detects the install root, reported release, ``recon-all``, feature
interpreter, stats-table helpers, segmentation helper, license file, and
backend-owned output directories. It resolves symlinks and reads
``build-stamp.txt`` instead of launching ``recon-all --version``, and it stats
the license for presence and mode without opening, reading, hashing, or copying
its bytes. The detected release is reported without enforcing a version gate.

``tools.freesurferHome`` is read before ``$FREESURFER_HOME``, and
``tools.freesurferLicense`` before ``$FS_LICENSE``, ``<fshome>/license.txt`` and
``<fshome>/.license``. ``${paths.derivativesDir}/freesurfer`` is checked for
the FreeSurfer or automatic backend, and
``${paths.derivativesDir}/fastsurfer`` for the FastSurfer or automatic backend.
Download links and the authored-on release come from
:mod:`supraspina_sidecar.env.constants`.
"""

from __future__ import annotations

import os
import shlex
import stat
from typing import Any

from ..adapters import tools
from ..freesurfer_license import (
    resolve_freesurfer_home,
    resolve_freesurfer_license_path,
)
from .base import Check, CheckAction, Installer, Probe, register_probe
from .constants import (
    FREESURFER_AUTHORED_RELEASE,
    FREESURFER_DOWNLOAD_URL,
    FREESURFER_REGISTER_URL,
)

#: Use this derivatives-root subdirectory as FreeSurfer's ``SUBJECTS_DIR``.
FREESURFER_SUBDIR = "freesurfer"
FASTSURFER_SUBDIR = "fastsurfer"

#: Show this recon-all flag-compatibility note on the ``reconall`` check. Keep a
#: single cohort on one FreeSurfer version because 8.x numerical drift remains
#: possible even though the flags authored on the earlier release remain valid.
_RECON_NOTE = (
    f"Flags authored on {FREESURFER_AUTHORED_RELEASE} remain valid on 8.x; "
    "keep one FreeSurfer version throughout each cohort."
)
#: The note's identity text, which the ``reconall`` identity digests.
_RECON_NOTE_IDENTITY = (
    f"Use flags authored on {FREESURFER_AUTHORED_RELEASE}, which remain valid "
    "on 8.x; keep one FreeSurfer version throughout each cohort."
)


def _read_release(fshome: str) -> str:
    """Return the FreeSurfer release string for an install root.

    Prefer the ``build-stamp.txt`` contents as the canonical build identifier,
    and fall back to the install-root directory name (for example ``8.2.0``).
    Read the stamp once with a single bounded read, and never invoke
    ``recon-all --version``.

    Parameters
    ----------
    fshome
        Provide the FreeSurfer install root.

    Returns
    -------
    str
        Return the build-stamp line, directory basename, or an empty string.
    """
    stamp = os.path.join(fshome, "build-stamp.txt")
    if tools.file_nonempty(stamp):
        try:
            with open(stamp, encoding="utf-8") as handle:
                line = handle.readline().strip()
        except OSError:
            line = ""
        if line:
            return line
    tail = os.path.basename(fshome.rstrip("/"))
    return tail


def _locate(fshome: str, name: str) -> str | None:
    """Locate a FreeSurfer binary under ``<fshome>/bin`` then on ``PATH``.

    Parameters
    ----------
    fshome
        Provide the FreeSurfer install root (possibly empty).
    name
        Provide the binary name (for example, ``recon-all``).

    Returns
    -------
    str or None
        Return the absolute path to the binary, or ``None`` when it is not
        found.
    """
    if fshome:
        candidate = os.path.join(fshome, "bin", name)
        if tools.exists(candidate):
            return candidate
    return tools.which(name)


class FreeSurferProbe(Probe):
    """Probe for the FreeSurfer install, helper binaries, and license.

    Emit checks for the install root, ``recon-all``, ``fspython`` or a safe host
    Python, ``aparcstats2table``, ``asegstats2table``, ``mri_segstats``, the
    license file, and each output directory selected by the reconstruction
    backend.
    """

    name = "FreeSurfer"

    def _fshome(self, cfg: dict[str, Any]) -> str:
        """Return the FreeSurfer install root from cfg then ``$FREESURFER_HOME``."""
        return resolve_freesurfer_home(cfg)

    def _license_path(self, cfg: dict[str, Any], fshome: str) -> str:
        """Return the license path from cfg, ``$FS_LICENSE``, or fshome default."""
        return resolve_freesurfer_license_path(
            cfg,
            freesurfer_home=fshome,
        )

    def _subjects_dir(self, cfg: dict[str, Any]) -> str:
        """Return ``SUBJECTS_DIR`` (``${paths.derivativesDir}/freesurfer``)."""
        derivatives = self.resolve("${paths.derivativesDir}", cfg)
        return os.path.join(derivatives, FREESURFER_SUBDIR)

    def _output_dir(self, cfg: dict[str, Any], subdir: str) -> str:
        """Return one backend-owned reconstruction output parent."""
        derivatives = self.resolve("${paths.derivativesDir}", cfg)
        return os.path.join(derivatives, subdir)

    def _recon_backend(self, cfg: dict[str, Any]) -> str:
        """Return the configured reconstruction backend, defaulting safely."""
        steps = cfg.get("steps")
        recon = steps.get("recon") if isinstance(steps, dict) else None
        params = recon.get("params") if isinstance(recon, dict) else None
        backend = params.get("backend") if isinstance(params, dict) else None
        return (
            backend if backend in {"freesurfer", "fastsurfer", "auto"} else "freesurfer"
        )

    def checks(self, cfg: dict[str, Any]) -> list[Check]:
        """Run every FreeSurfer check against the project configuration.

        Parameters
        ----------
        cfg
            Provide the full project configuration mapping (possibly empty or
            partial).

        Returns
        -------
        list of Check
            Return results in display order: ``fshome``, ``reconall``,
            ``featurepython``, ``aparcstats``, ``asegstats``, ``mriseg``,
            ``license``, followed by conditional ``subjdir`` and
            ``fastsurferdir`` checks.
        """
        fshome = self._fshome(cfg)
        release = _read_release(fshome) if fshome and tools.exists(fshome) else ""
        checks = [
            self._check_fshome(fshome, release),
            self._check_reconall(fshome, release),
            self._check_feature_python(fshome),
            self._check_helper(
                fshome,
                "aparcstats2table",
                "aparcstats",
                "aparcstats2table",
            ),
            self._check_helper(
                fshome,
                "asegstats2table",
                "asegstats",
                "asegstats2table",
            ),
            self._check_helper(
                fshome,
                "mri_segstats",
                "mriseg",
                "mri_segstats",
            ),
            self._check_license(cfg, fshome),
        ]
        backend = self._recon_backend(cfg)
        if backend in {"freesurfer", "auto"}:
            checks.append(self._check_subjdir(cfg))
        if backend in {"fastsurfer", "auto"}:
            checks.append(
                self._check_output_parent(
                    cfg,
                    subdir=FASTSURFER_SUBDIR,
                    check_id="fastsurferdir",
                    label="FastSurfer output directory",
                    backend_label="FastSurfer",
                )
            )
        return checks

    def _check_feature_python(self, fshome: str) -> Check:
        """Check the exact interpreter selected by the Features adapter."""
        fspython = os.path.join(fshome, "bin", "fspython") if fshome else ""
        selected = (
            fspython
            if fspython and os.path.isfile(fspython)
            else tools.python_interpreter()
        )
        if selected and os.path.isfile(selected) and os.access(selected, os.X_OK):
            return Check(
                id="featurepython",
                label="Feature extraction Python",
                status="found",
                detail=selected,
            )
        return Check(
            id="featurepython",
            label="Feature extraction Python",
            status="missing",
            detail="Configure an executable FreeSurfer fspython or host Python.",
        )

    def _check_fshome(self, fshome: str, release: str) -> Check:
        """Check the FreeSurfer install root exists."""
        if fshome and tools.exists(fshome):
            detail = f"{fshome} (release {release})" if release else fshome
            return Check(
                id="fshome",
                label="FreeSurfer install root",
                status="found",
                detail=detail,
                download_url=FREESURFER_DOWNLOAD_URL,
            )
        hint = (
            "Set tools.freesurferHome or $FREESURFER_HOME to the FreeSurfer 8.x "
            "install root."
        )
        return Check(
            id="fshome",
            label="FreeSurfer install root",
            status="missing",
            detail="Set FREESURFER_HOME to an existing FreeSurfer directory.",
            recommended_cmd=hint,
            download_url=FREESURFER_DOWNLOAD_URL,
            installer=Installer(
                kind="manual",
                one_liner=hint,
                note="Plan for a large download and an interactive install.",
            ),
        )

    def _check_reconall(self, fshome: str, release: str) -> Check:
        """Check ``recon-all`` is locatable; report release and the version note."""
        path = _locate(fshome, "recon-all")
        if path:
            release_text = release or "unknown release"
            return Check(
                id="reconall",
                label="recon-all",
                status="found",
                detail=f"{path} (release {release_text}). {_RECON_NOTE}",
                identity_detail=(
                    f"Use {path} (release {release_text}). {_RECON_NOTE_IDENTITY}"
                ),
                download_url=FREESURFER_DOWNLOAD_URL,
            )
        return Check(
            id="reconall",
            label="recon-all",
            status="missing",
            detail="Install recon-all under $FREESURFER_HOME/bin or add it to PATH.",
            download_url=FREESURFER_DOWNLOAD_URL,
            installer=Installer(
                kind="manual",
                one_liner="Install FreeSurfer 8.x and source SetUpFreeSurfer.sh.",
                note="Install recon-all through the FreeSurfer distribution.",
            ),
        )

    def _check_helper(
        self, fshome: str, binary: str, check_id: str, label: str
    ) -> Check:
        """Check a FreeSurfer stats/segmentation helper binary is locatable."""
        path = _locate(fshome, binary)
        if path:
            return Check(id=check_id, label=label, status="found", detail=path)
        return Check(
            id=check_id,
            label=label,
            status="missing",
            detail=(f"Install {binary} under $FREESURFER_HOME/bin or add it to PATH."),
            download_url=FREESURFER_DOWNLOAD_URL,
            installer=Installer(
                kind="manual",
                one_liner="Install FreeSurfer 8.x and source SetUpFreeSurfer.sh.",
                note=f"Install {binary} through the FreeSurfer distribution.",
            ),
        )

    def _check_license(self, cfg: dict[str, Any], fshome: str) -> Check:
        """Check the license file: presence and mode only; never read its bytes.

        Use :func:`os.stat` to confirm a regular, non-empty, readable file, and
        report the octal permission bits. Never open, read, hash, or copy the
        license contents.
        """
        path = self._license_path(cfg, fshome)
        if path and tools.file_nonempty(path):
            mode = stat.S_IMODE(os.stat(path).st_mode)
            return Check(
                id="license",
                label="FreeSurfer license",
                status="found",
                detail=f"The license file is present with mode {mode:03o}.",
                identity_detail=f"Use the present license file with mode {mode:03o}.",
            )
        hint = (
            "Register for a free license, then place license.txt in "
            "$FREESURFER_HOME or set $FS_LICENSE to its path."
        )
        return Check(
            id="license",
            label="FreeSurfer license",
            status="missing",
            detail="Provide a nonempty, readable license.txt file.",
            recommended_cmd=hint,
            download_url=FREESURFER_REGISTER_URL,
            installer=Installer(
                kind="manual",
                one_liner=hint,
                note="Register for the free license manually; never automate it.",
            ),
        )

    def _check_subjdir(self, cfg: dict[str, Any]) -> Check:
        """Classify whether the backend-owned output parent can be used safely."""
        return self._check_output_parent(
            cfg,
            subdir=FREESURFER_SUBDIR,
            check_id="subjdir",
            label="SUBJECTS_DIR",
            backend_label="FreeSurfer",
        )

    def _absent_output_parent(
        self,
        subjects_dir: str,
        *,
        check_id: str,
        label: str,
        backend_label: str,
    ) -> Check:
        """Classify an absent output directory by its nearest real ancestor."""
        ancestor = os.path.dirname(subjects_dir)
        while ancestor and not os.path.lexists(ancestor):
            parent = os.path.dirname(ancestor)
            if parent == ancestor:
                break
            ancestor = parent
        if (
            ancestor
            and os.path.isdir(ancestor)
            and os.access(ancestor, os.W_OK | os.X_OK)
        ):
            # Advisory: the reconstruction adapter creates the resolved
            # backend's directory at spawn time, so absence never gates a
            # run. Name the backend so the promise stays exact under
            # "auto", where only the resolved backend's parent is created.
            return Check(
                id=check_id,
                label=label,
                status="warn",
                detail=(
                    f"Create {subjects_dir} now, or let Supraspina create it "
                    "automatically when reconstruction runs with the "
                    f"{backend_label} backend; its parent is writable."
                ),
                recommended_cmd=f"mkdir -p {shlex.quote(subjects_dir)}",
                action=CheckAction(
                    kind="create-directory",
                    label="Create directory",
                ),
            )
        return Check(
            id=check_id,
            label=label,
            status="missing",
            detail=f"Make the parent of {subjects_dir} writable.",
        )

    def _check_output_parent(
        self,
        cfg: dict[str, Any],
        *,
        subdir: str,
        check_id: str,
        label: str,
        backend_label: str,
    ) -> Check:
        """Classify one selected backend's owned reconstruction output parent."""
        subjects_dir = self._output_dir(cfg, subdir)
        if "${" in subjects_dir or not os.path.isabs(subjects_dir):
            # Without a resolved project configuration this check has no
            # directory to inspect; defer it instead of failing.
            return Check(
                id=check_id,
                label=label,
                status="skipped",
                detail=(
                    "Supraspina checks this reconstruction output parent after "
                    "a project resolves paths.derivativesDir."
                ),
            )
        try:
            info = os.lstat(subjects_dir)
        except FileNotFoundError:
            return self._absent_output_parent(
                subjects_dir,
                check_id=check_id,
                label=label,
                backend_label=backend_label,
            )
        except OSError:
            return Check(
                id=check_id,
                label=label,
                status="missing",
                detail=f"Inspect {subjects_dir}; checking the path failed.",
            )
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            return Check(
                id=check_id,
                label=label,
                status="wrong",
                detail=f"Replace {subjects_dir} with a directory.",
            )
        if not os.access(subjects_dir, os.W_OK | os.X_OK):
            return Check(
                id=check_id,
                label=label,
                status="missing",
                detail=f"Make {subjects_dir} writable.",
            )
        if stat.S_ISDIR(info.st_mode):
            return Check(
                id=check_id,
                label=label,
                status="found",
                detail=f"The directory {subjects_dir} is writable.",
                identity_detail=f"Use the writable directory {subjects_dir}.",
            )
        raise AssertionError(
            "Classify every output-parent state before reaching this branch."
        )


register_probe(FreeSurferProbe())
