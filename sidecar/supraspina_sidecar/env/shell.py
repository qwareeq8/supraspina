"""Probe of the command-line utilities surfaced by shell diagnostics.

Every check resolves through :func:`tools.which`. ``bash``, ``awk``,
``grep``, ``cat``, and ``mkdir`` back the ENIGMA wrappers. ``sed``, ``bc``,
and ``find`` remain as compatibility checks for imported shell workflows.
``curl`` covers PyBrainAge fetches and the optional MATLAB Runtime installer.
``sha256sum`` covers the Linux micromamba download hint, ``unzip`` the optional
MATLAB Runtime installer, and ``xvfb-run`` the compiled ENIGMA backend.
``dos2unix``, alternate defacers, and WSL-only ``wslpath`` are optional or
platform-scoped checks. The ``dos2unix`` row is informational: Supraspina never
runs it and gates nothing on it, so absence reports as ``skipped`` rather than
``missing``.

Nothing executes during detection. Privileged ``dos2unix`` installation is
offered as a manual clipboard fix only, scoped to Ubuntu-family hosts.
"""

from __future__ import annotations

import os
from typing import Any

from ..adapters import tools
from ..freesurfer_license import resolve_freesurfer_home
from .base import Check, Installer, Probe, host_mode, register_probe, ubuntu_host
from .constants import DOS2UNIX_PACKAGE_HINT

#: Probe these core and compatibility utilities through plain PATH checks.
#: Each entry names the utility, the role it plays, and the identity text
#: its receipt identity digests (see ``Check.identity_detail``).
_CORE_UTILS: tuple[tuple[str, str, str], ...] = (
    (
        "bash",
        "runs the ENIGMA wrapper and the pipeline glue",
        "Use bash for the ENIGMA wrapper and pipeline glue shell",
    ),
    (
        "awk",
        "extracts fields in the QC and aggregation steps",
        "Use awk for field extraction in the QC and aggregation steps",
    ),
    (
        "sed",
        "edits text in place in the pipeline glue",
        "Use sed for in-place text edits in the pipeline glue",
    ),
    (
        "grep",
        "matches patterns in the pipeline glue",
        "Use grep for pattern matching in the pipeline glue",
    ),
    (
        "cat",
        "assembles the ENIGMA subject list and tables",
        "Use cat for ENIGMA subject-list and table assembly",
    ),
    (
        "mkdir",
        "creates the ENIGMA output directories",
        "Use mkdir for ENIGMA output directory creation",
    ),
    (
        "bc",
        "does arithmetic in the shell glue",
        "Use bc for arithmetic in the shell glue",
    ),
    (
        "find",
        "discovers subjects and artifacts",
        "Use find for subject and artifact discovery",
    ),
)

#: Explain the specific workflow or installation path enabled by each extra,
#: in the same shape as :data:`_CORE_UTILS`.
_REQUIRED_EXTRAS: tuple[tuple[str, str, str], ...] = (
    (
        "curl",
        "downloads the MATLAB Runtime and the PyBrainAge model",
        "Use curl to download the MATLAB Runtime and PyBrainAge model",
    ),
    (
        "sha256sum",
        "verifies the Linux micromamba download hint",
        "Use sha256sum to verify the Linux micromamba download hint",
    ),
    (
        "unzip",
        "unpacks the optional MATLAB Runtime installer",
        "Use unzip to unpack the optional MATLAB Runtime installer",
    ),
    (
        "xvfb-run",
        "provides headless OpenGL for ENIGMA step 5",
        "Use xvfb-run for headless OpenGL in ENIGMA step 5",
    ),
)

#: Surface these optional defacers as found or missing without treating absence
#: as an error.
_OPTIONAL_DEFACERS: tuple[tuple[str, str], ...] = (
    ("fsl_deface", "fsl_deface (optional defacer)"),
    ("pydeface", "pydeface (optional defacer)"),
)


def _presence_check(name: str, role: str, identity: str) -> Check:
    """Return a found/missing :class:`Check` for a required tool on PATH.

    Parameters
    ----------
    name
        Provide the executable basename to look up via :func:`tools.which`.
    role
        Provide the verb phrase naming what the tool does in the pipeline.
    identity
        Provide the identity text the check's receipt identity digests.

    Returns
    -------
    Check
        Return ``found`` with the resolved path when on PATH or ``missing``
        otherwise.
    """
    path = tools.which(name)
    if path:
        return Check(
            id=name,
            label=name,
            status="found",
            detail=f"{name} at {path} {role}.",
            identity_detail=f"{identity} ({path}).",
        )
    return Check(
        id=name,
        label=name,
        status="missing",
        detail=f"Install {name}; it {role}.",
        identity_detail=f"{identity}.",
    )


class ShellProbe(Probe):
    """Detect the command-line utilities the pipeline shells out to."""

    name = "Shell utilities"

    def checks(self, cfg: dict[str, Any]) -> list[Check]:
        """Probe every shell utility against PATH and the platform mode.

        Parameters
        ----------
        cfg
            Accept the full project configuration mapping (possibly empty).
            Ignore it for ``wslpath`` scoping, and read the live host mode via
            :func:`supraspina_sidecar.env.base.host_mode` instead.

        Returns
        -------
        list of Check
            Return one result per utility in display order.
        """
        results: list[Check] = []
        for name, role, identity in (*_CORE_UTILS, *_REQUIRED_EXTRAS):
            results.append(_presence_check(name, role, identity))
        results.append(self._dos2unix_check())
        for name, label in _OPTIONAL_DEFACERS:
            results.append(self._optional_defacer_check(name, label))
        results.append(self._mri_deface_check(cfg))
        results.append(self._mri_deface_templates_check(cfg))
        results.append(self._wslpath_check())
        return results

    def _mri_deface_check(self, cfg: dict[str, Any]) -> Check:
        """Locate ``mri_deface`` under the resolved FreeSurfer home or ``PATH``.

        Resolve the install root the way the sibling FreeSurfer checks do:
        ``tools.freesurferHome`` first, then ``$FREESURFER_HOME``. Fall back to
        ``PATH`` so a defacer installed outside FreeSurfer still resolves.
        """
        home = resolve_freesurfer_home(cfg if isinstance(cfg, dict) else {})
        executable = ""
        if home:
            candidate = os.path.join(home, "bin", "mri_deface")
            if tools.exists(candidate):
                executable = candidate
        executable = executable or tools.which("mri_deface") or ""
        if executable:
            return Check(
                id="mri_deface",
                label="mri_deface (FreeSurfer defacer)",
                status="found",
                detail=executable,
            )
        return Check(
            id="mri_deface",
            label="mri_deface (FreeSurfer defacer)",
            status="missing",
            detail=(
                "Install mri_deface under the resolved FreeSurfer home or add "
                "it to PATH."
            ),
        )

    def _mri_deface_templates_check(self, cfg: dict[str, Any]) -> Check:
        """Require both positional GCA templates consumed by ``mri_deface``.

        Resolve the install root the way the sibling FreeSurfer checks do:
        ``tools.freesurferHome`` first, then ``$FREESURFER_HOME``. An
        unconfigured project inheriting the install root from its shell would
        otherwise fail this gate while ``mri_deface`` itself resolves.
        """
        home = resolve_freesurfer_home(cfg if isinstance(cfg, dict) else {})
        templates = [
            os.path.join(home, "average", "talairach_mixed_with_skull.gca"),
            os.path.join(home, "average", "face.gca"),
        ]
        present = [path for path in templates if home and os.path.isfile(path)]
        if len(present) == len(templates):
            return Check(
                id="mri_deface_templates",
                label="mri_deface GCA templates",
                status="found",
                detail=(
                    "Both FreeSurfer defacing templates are present under the "
                    "resolved FreeSurfer home."
                ),
                identity_detail=(
                    "Use both FreeSurfer defacing templates under the resolved "
                    "FreeSurfer home."
                ),
            )
        return Check(
            id="mri_deface_templates",
            label="mri_deface GCA templates",
            status="missing",
            detail=(
                "Provide both FreeSurfer defacing templates under the resolved "
                f"FreeSurfer home; {len(present)} of 2 "
                f"{'is' if len(present) == 1 else 'are'} present."
            ),
            identity_detail=(
                "Provide both FreeSurfer defacing templates under the resolved "
                f"FreeSurfer home; currently find {len(present)}/2."
            ),
        )

    @staticmethod
    def _dos2unix_check() -> Check:
        """Return the informational ``dos2unix`` check.

        Return ``found`` when present. Return ``skipped`` when absent because
        nothing in Supraspina runs dos2unix or gates on it: shipped scripts are
        LF-pinned and operator CSV files are read with CRLF tolerance. On
        Ubuntu-family hosts the absent row keeps the copy-only apt hint and a
        ``manual`` installer (never executed) for operators who want the
        converter for external files.
        """
        path = tools.which("dos2unix")
        if path:
            return Check(
                id="dos2unix",
                label="dos2unix (optional)",
                status="found",
                detail=f"The CRLF converter is at {path}.",
                identity_detail=f"Use the CRLF converter at {path}.",
            )
        hint = DOS2UNIX_PACKAGE_HINT if ubuntu_host() else ""
        return Check(
            id="dos2unix",
            label="dos2unix (optional)",
            status="skipped",
            detail=(
                "Supraspina never runs dos2unix; shipped scripts use LF line "
                "endings and operator CSV files are read with CRLF tolerance. "
                "Install this optional converter only for external files."
            ),
            recommended_cmd=hint,
            installer=(Installer(kind="manual", one_liner=hint) if hint else None),
        )

    @staticmethod
    def _optional_defacer_check(name: str, label: str) -> Check:
        """Return a found/missing check for an optional defacer.

        Parameters
        ----------
        name
            Provide the executable basename (``fsl_deface`` or ``pydeface``).

        Returns
        -------
        Check
            Return ``found`` when on PATH or optional ``missing`` otherwise.
        """
        path = tools.which(name)
        if path:
            return Check(id=name, label=label, status="found", detail=path)
        return Check(
            id=name,
            label=label,
            status="missing",
            detail="The default pipeline does not use this optional defacer.",
            identity_detail=(
                "Skip this optional defacer when using the default pipeline."
            ),
        )

    @staticmethod
    def _wslpath_check() -> Check:
        """Return the ``wslpath`` check, scoped to the live host platform mode.

        Return ``skipped`` outside WSL because the check is not applicable.
        Perform a plain found/missing PATH presence check under WSL. Read the
        host mode from :func:`supraspina_sidecar.env.base.host_mode` instead of the
        project config so a real WSL host is detected even when the config omits
        ``platform.mode``.

        Returns
        -------
        Check
            Return ``skipped`` outside WSL or ``found``/``missing`` within WSL.
        """
        if host_mode() != "wsl":
            return Check(
                id="wslpath",
                label="wslpath",
                status="skipped",
                detail="wslpath is not needed outside WSL mode.",
                identity_detail="Skip wslpath outside WSL mode.",
            )
        path = tools.which("wslpath")
        if path:
            return Check(
                id="wslpath",
                label="wslpath",
                status="found",
                detail=f"{path} translates paths under WSL.",
                identity_detail=f"Use {path} for WSL path translation.",
            )
        return Check(
            id="wslpath",
            label="wslpath",
            status="missing",
            detail="Install wslpath for path translation under WSL.",
        )


register_probe(ShellProbe())
