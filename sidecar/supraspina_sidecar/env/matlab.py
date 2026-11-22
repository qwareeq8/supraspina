"""Probe of the MATLAB / MATLAB Runtime QC backend group.

The preferred ENIGMA QC backend is a licensed MATLAB that runs the source
``.m`` files directly. It requires the Image Processing Toolbox, carries no
release ceiling, and rests on end-to-end verification through R2026a. The free
MATLAB Runtime is the fallback for hosts without a licensed MATLAB, and the
reviewed compiled binaries require R2019b (9.7).

Detection never boots MATLAB or the runtime: the MATLAB release is read from
``MATLABROOT/VersionInfo.xml`` after the launcher symlink resolves, and the
runtime release is inferred from its install directory name. Only
:func:`tools.which`-style PATH resolution runs as a subprocess.
"""

from __future__ import annotations

import os
import re
import shlex
import xml.etree.ElementTree as ET
from typing import Any

from .. import resources
from ..adapters import tools
from .base import Check, Installer, Probe, cfg_get, register_probe
from .constants import (
    MATLAB_PRODUCT_URL,
    MCR_DOTTED_VERSION,
    MCR_INSTALL_ROOTS,
    MCR_LANDING_URL,
    MCR_LINUX_ZIP_URL,
    MCR_RELEASE,
    MCR_RUNTIME_LIBRARY,
    MCR_VERSION_LADDER,
)

_MAX_RUNTIME_DIRECTORY_ENTRIES = 4_096

#: Name the compiled ENIGMA programs the ``run_*.sh`` launchers execute
#: directly. The wrapper runs the launchers through ``bash``, so only these
#: three files need the executable bit.
_COMPILED_BINARIES = (
    "FS_external_QC",
    "func_make_corticalpngs_ENIGMA_QC",
    "func_make_subcorticalFS_ENIGMA_QC",
)

#: Match an ``R<year><letter>`` release token, for example ``R2023a``.
_RELEASE_RE = re.compile(r"R(\d{4})([ab])", re.IGNORECASE)


def _parse_release(release: str) -> tuple[int, str] | None:
    """Parse a MATLAB release token into a comparable ``(year, letter)`` tuple.

    Parameters
    ----------
    release
        Provide a release string such as ``R2023a`` (case-insensitive and
        possibly embedded).

    Returns
    -------
    tuple of (int, str) or None
        Return ``(year, letter)`` with a lowercase letter or ``None`` when no
        token is found.
    """
    match = _RELEASE_RE.search(release)
    if match is None:
        return None
    return int(match.group(1)), match.group(2).lower()


def _matlabroot(executable: str) -> str:
    """Resolve a ``matlab`` launcher path to its MATLABROOT.

    Locate the root two directories above the real launcher path, because the
    launcher resides at ``MATLABROOT/bin/matlab`` and is often a symlink.

    Parameters
    ----------
    executable
        Provide the ``matlab`` launcher path (possibly a symlink).

    Returns
    -------
    str
        Return the resolved MATLABROOT directory.
    """
    real = os.path.realpath(executable)
    return os.path.dirname(os.path.dirname(real))


def _read_release(matlabroot: str) -> str:
    """Read the ``<release>`` element from ``MATLABROOT/VersionInfo.xml``.

    Parse only the static version manifest, and never boot MATLAB.

    Returns
    -------
    str
        Return the release string (for example, ``R2026a``), or ``""`` if it
        cannot be read.
    """
    version_info = os.path.join(matlabroot, "VersionInfo.xml")
    if not tools.file_nonempty(version_info):
        return ""
    try:
        root = ET.parse(version_info).getroot()  # noqa: S314 - Parse a local, trusted file.
    except ET.ParseError:
        return ""
    element = root.find("release")
    if element is None or element.text is None:
        return ""
    return element.text.strip()


def _has_image_toolbox(matlabroot: str) -> bool:
    """Return whether the Image Processing Toolbox is present under MATLABROOT.

    Check directory presence (``toolbox/images``) instead of booting MATLAB and
    querying ``ver``.

    Returns
    -------
    bool
        Return ``True`` when ``MATLABROOT/toolbox/images`` exists.
    """
    return tools.exists(os.path.join(matlabroot, "toolbox", "images"))


def _infer_mcr_release(path: str) -> str:
    """Infer a MATLAB Runtime release token from its install directory name.

    Match a release token directly (``R2019b``), or map a dotted or compact
    runtime version back through :data:`MCR_VERSION_LADDER`. Compare both forms
    of a ladder entry because MathWorks names the install directory ``v97`` for
    9.7 and ``v914`` for 9.14; avoid splitting the digits positionally because
    that approach cannot distinguish those two shapes.

    Parameters
    ----------
    path
        Provide the runtime install path whose trailing component names the
        version.

    Returns
    -------
    str
        Return a release token (for example, ``R2019b``), or ``""`` if none can
        be inferred.
    """
    name = os.path.basename(path.rstrip("/"))
    parsed = _parse_release(name)
    if parsed is not None:
        return f"R{parsed[0]}{parsed[1]}"
    candidate = name.lower().removeprefix("v")
    for release, version in MCR_VERSION_LADDER.items():
        if candidate in {version, version.replace(".", "")}:
            return release
    return ""


def _provided_runtime_versions(root: str) -> list[str]:
    """List the runtime library versions a MATLAB Runtime root actually ships.

    Report what the operator has so a version mismatch names both sides instead
    of only the requirement.

    Returns
    -------
    list of str
        Return sorted dotted versions from ``libmwmclmcrrt.so.<version>`` or an
        empty list when the directory is absent or has no versioned library.
    """
    directory = os.path.join(root, os.path.dirname(MCR_RUNTIME_LIBRARY))
    names: list[str] = []
    try:
        with os.scandir(directory) as entries:
            for index, entry in enumerate(entries):
                if index >= _MAX_RUNTIME_DIRECTORY_ENTRIES:
                    return []
                names.append(entry.name)
    except OSError:
        return []
    prefix = "libmwmclmcrrt.so."
    return sorted(
        name[len(prefix) :]
        for name in names
        if name.startswith(prefix) and name[len(prefix) :]
    )


def _non_executable_compiled_binaries() -> list[str]:
    """Return the present compiled ENIGMA binaries this host cannot execute.

    Report only files that exist, because an absent asset is already reported
    by the ENIGMA QC asset check. A development checkout is the common source
    of a present binary without its executable bit.

    Returns
    -------
    list of str
        Return the full paths of the non-executable binaries, in wrapper order.
    """
    compiled = resources.enigma_dir() / "compiled"
    return [
        str(compiled / name)
        for name in _COMPILED_BINARIES
        if os.path.isfile(compiled / name) and not os.access(compiled / name, os.X_OK)
    ]


def ambient_mcr_root() -> str:
    """Return the first conventional install root that ships the runtime.

    Try each :data:`MCR_INSTALL_ROOTS` entry as the runtime root itself and with
    the ``v<version>`` directory the MathWorks installer appends below its
    destination folder. Accept a root only when it provides
    :data:`MCR_RUNTIME_LIBRARY` by exact name.

    Returns
    -------
    str
        Return the runtime root path, or ``""`` when no conventional root
        provides the required library.
    """
    release_dir = "v" + MCR_DOTTED_VERSION.replace(".", "")
    for root in MCR_INSTALL_ROOTS:
        for candidate in (os.path.join(root, release_dir), root):
            if tools.exists(os.path.join(candidate, MCR_RUNTIME_LIBRARY)):
                return candidate
    return ""


def _find_mcr_root(cfg: dict[str, Any], probe: Probe) -> str:
    """Resolve the exact MATLAB Runtime root the ENIGMA argv will consume.

    Resolve ``steps.enigma.params.mcrRoot`` when it is set, which is the value
    received by the compiled wrapper. Fall back to :func:`ambient_mcr_root`
    when it is blank, mirroring the source backend's ``matlab`` on ``PATH``
    fallback, so a runtime installed with the recommended one-liner needs no
    further configuration.

    Parameters
    ----------
    probe
        Provide the probe instance used for ``${...}`` resolution.

    Returns
    -------
    str
        Return the configured runtime root path, or ``""`` if it is blank or
        absent.
    """
    configured = cfg_get(cfg, "steps.enigma.params.mcrRoot")
    if not configured:
        return ambient_mcr_root()
    resolved = probe.resolve(configured, cfg)
    return resolved if resolved and tools.exists(resolved) else ""


#: Select the backend automatically: MATLAB when found, else the Runtime.
AUTO_BACKEND = "auto"


def configured_enigma_backend(cfg: dict[str, Any]) -> str:
    """Return the saved ENIGMA backend choice, defaulting to ``auto``."""
    return str(cfg_get(cfg, "steps.enigma.params.backend") or AUTO_BACKEND)


def effective_enigma_backend(cfg: dict[str, Any]) -> str:
    """Resolve the backend the ENIGMA step will run with.

    Keep an explicit ``matlab`` or ``mcr`` choice. Resolve ``auto`` to the
    first backend whose own detection reports ``found``, preferring source
    MATLAB, and to ``matlab`` when neither is installed so the requirement
    still names the preferred route.

    Returns
    -------
    str
        Return ``"matlab"`` or ``"mcr"``.
    """
    configured = configured_enigma_backend(cfg)
    if configured != AUTO_BACKEND:
        return configured
    probe = MatlabProbe()
    if probe._check_matlab(cfg).status == "found":
        return "matlab"
    if probe._check_mcr(cfg).status == "found":
        return "mcr"
    return "matlab"


#: List ENIGMA QC backend ids in host-preference order, paired with the check id
#: that gates each (matlab -> source MATLAB, the preferred backend; mcr -> the
#: free Runtime + compiled binaries, the fallback).
_BACKEND_CHECKS: tuple[tuple[str, str], ...] = (
    ("matlab", "matlab"),
    ("mcr", "mcr"),
)


def viable_enigma_backends(cfg: dict[str, Any]) -> list[str]:
    """Return the ENIGMA QC backends usable on this host, in preference order.

    Derive viability from the same MATLAB / MCR checks surfaced by the
    environment report, and accept a backend only when its backing check is
    ``found``. Keep the run-time gate and requirements UI consistent. Interpret
    ``found`` as a runtime matching R2019b/9.7 for ``mcr`` or a compatible
    source MATLAB with the Image Processing Toolbox for ``matlab``.

    Returns
    -------
    list of str
        Return the viable backend ids as a subset of ``["matlab", "mcr"]`` in
        preference order; return an empty list when no backend is installed.
    """
    index = {check.id: check.status for check in MatlabProbe().checks(cfg)}
    return [
        backend
        for backend, check_id in _BACKEND_CHECKS
        if index.get(check_id) == "found"
    ]


#: Display this label for each backend check when the project does not select it.
_UNSELECTED_LABELS = {
    "matlab": "MATLAB (optional source backend)",
    "mcr": "MATLAB Runtime (optional compiled backend)",
}

#: Explain how to switch to each backend while another one is selected.
_SWITCH_GUIDANCE = {
    "matlab": (
        "Use it as the licensed alternative by selecting the matlab backend "
        "in the ENIGMA QC step options."
    ),
    "mcr": (
        "Use it as the license-free alternative by selecting the mcr backend "
        f"in the ENIGMA QC step options; the compiled route requires the "
        f"{MCR_RELEASE} ({MCR_DOTTED_VERSION}) MATLAB Runtime and the "
        "verified compiled ENIGMA assets."
    ),
}


def _either_backend(check: Check) -> Check:
    """Explain that installing either backend satisfies automatic selection."""
    either = (
        "Install either backend: automatic selection uses source MATLAB when it "
        "is present and the MATLAB Runtime otherwise."
    )
    return Check(
        id=check.id,
        label=check.label,
        status=check.status,
        detail=f"{check.detail} {either}",
        recommended_cmd=check.recommended_cmd,
        download_url=check.download_url,
        installer=check.installer,
        action=check.action,
        identity_detail=(
            None
            if check.identity_detail is None
            else f"{check.identity_detail} {either}"
        ),
    )


def _unselected_backend(check: Check, selected_label: str) -> Check:
    """Present the backend the project did not select as optional.

    Require exactly one ENIGMA execution backend: the one saved by the project.
    Report the other backend truthfully, but prevent it from contributing a
    ``missing``, ``wrong``, or ``warn`` state to the group because installing
    it cannot change whether the selected backend can run. Keep the failing
    backend's remediation content (copyable command, download link, installer)
    so the alternative route stays visible while it is optional.

    Parameters
    ----------
    check
        Provide the unselected backend's own detection result.
    selected_label
        Provide the human label of the backend selected by the project.

    Returns
    -------
    Check
        Return the same result when the backend happens to be present;
        otherwise, return a ``skipped`` check that keeps the backend's
        remediation and states why it is not required.
    """
    label = _UNSELECTED_LABELS[check.id]
    optional = (
        f"This backend is optional because {selected_label} is the selected "
        "ENIGMA QC backend."
    )
    # The identity text the receipt identity digests; see Check.identity_detail.
    optional_identity = (
        f"Treat this backend as optional because {selected_label} is the "
        "selected ENIGMA QC backend."
    )
    if check.status == "found":
        return Check(
            id=check.id,
            label=label,
            status="found",
            detail=f"{check.detail} {optional}",
            identity_detail=f"{check.identity_text} {optional_identity}",
        )
    reason = check.detail or "No installation was detected."
    reason_identity = check.identity_text or "Detect no installation."
    guidance = _SWITCH_GUIDANCE[check.id]
    return Check(
        id=check.id,
        label=label,
        status="skipped",
        detail=f"{reason} {optional} {guidance}",
        recommended_cmd=check.recommended_cmd,
        download_url=check.download_url,
        installer=check.installer,
        action=check.action,
        identity_detail=f"{reason_identity} {optional_identity} {guidance}",
    )


class MatlabProbe(Probe):
    """Probe for the MATLAB / MATLAB Runtime QC backend group."""

    name = "MATLAB / MATLAB Runtime"

    def checks(self, cfg: dict[str, Any]) -> list[Check]:
        """Return the MATLAB, MATLAB boot, and Runtime checks.

        Parameters
        ----------
        cfg
            Provide the full project configuration mapping (possibly empty or
            partial).

        Returns
        -------
        list of Check
            Return the three group checks in display order. Require only the
            backend the project resolves to (its saved choice, or the first
            installed one under automatic selection), and prevent the other
            backend from making the group missing.
        """
        configured = configured_enigma_backend(cfg)
        matlab_check = self._check_matlab(cfg)
        mcr_check = self._check_mcr(cfg)
        if configured == AUTO_BACKEND:
            selected = (
                "matlab"
                if matlab_check.status == "found"
                else "mcr"
                if mcr_check.status == "found"
                else None
            )
        else:
            selected = configured
        if selected == "mcr":
            matlab_check = _unselected_backend(matlab_check, "MATLAB Runtime")
        elif selected == "matlab":
            mcr_check = _unselected_backend(mcr_check, "source MATLAB")
        else:
            # Automatic selection with neither backend installed: keep both
            # blocking and say that either one is enough.
            matlab_check = _either_backend(matlab_check)
            mcr_check = _either_backend(mcr_check)
        return [
            matlab_check,
            self._check_matlab_boot(),
            mcr_check,
        ]

    def _check_matlab(self, cfg: dict[str, Any]) -> Check:
        """Locate source MATLAB and classify it as the source ENIGMA QC backend.

        Accept the installation when the Image Processing Toolbox is present.
        Apply no release ceiling, and rely on source-backend verification on
        R2026a.
        """
        configured = cfg_get(cfg, "steps.enigma.params.matlabExecutable")
        executable = self.resolve(configured, cfg) if configured else None
        if configured and (not executable or not tools.exists(executable)):
            return Check(
                id="matlab",
                label="MATLAB",
                status="missing",
                detail=(
                    "Configure an existing MATLAB executable; the saved path "
                    f"was not found: {executable}."
                ),
                download_url=MATLAB_PRODUCT_URL,
            )
        if not configured:
            executable = tools.which("matlab")
        if not executable:
            return Check(
                id="matlab",
                label="MATLAB",
                status="missing",
                detail=(
                    "Install licensed MATLAB with the Image Processing "
                    "Toolbox, then choose its matlab executable in the "
                    "ENIGMA QC configuration on the Diagnostics screen, or "
                    "add matlab to PATH."
                ),
                download_url=MATLAB_PRODUCT_URL,
            )

        matlabroot = _matlabroot(executable)
        release = _read_release(matlabroot)
        if not release:
            return Check(
                id="matlab",
                label="MATLAB",
                status="warn",
                detail=(
                    f"Inspect {executable}; reading {matlabroot}/VersionInfo.xml "
                    "to confirm the release failed."
                ),
            )

        # Apply no release ceiling. Require the Image Processing Toolbox used by
        # the montage renderers, and rely on end-to-end validation through R2026a.
        if not _has_image_toolbox(matlabroot):
            return Check(
                id="matlab",
                label="MATLAB",
                status="warn",
                detail=(
                    "Install the Image Processing Toolbox (toolbox/images) "
                    f"required by source QC; use the current {release} "
                    f"installation at {matlabroot}."
                ),
            )

        return Check(
            id="matlab",
            label="MATLAB",
            status="found",
            detail=(
                f"{release} at {matlabroot} has the Image Processing Toolbox "
                "and is the preferred source ENIGMA QC backend."
            ),
            identity_detail=(
                f"Use {release} at {matlabroot} with the Image Processing "
                "Toolbox as the preferred source ENIGMA QC backend."
            ),
        )

    def _check_matlab_boot(self) -> Check:
        """Report that the cold-start boot probe is intentionally skipped."""
        return Check(
            id="matlabBoot",
            label="MATLAB boot",
            status="skipped",
            detail=(
                "Supraspina does not probe the MATLAB cold start because startup "
                "is slow; run MATLAB manually to check it."
            ),
            identity_detail=(
                "Run MATLAB manually to check its cold start; skip automatic "
                "probing because startup is slow."
            ),
        )

    def _check_mcr(self, cfg: dict[str, Any]) -> Check:
        """Detect the MATLAB Runtime and gate it on the compiled binaries' need.

        Treat MATLAB Runtime releases as non-interchangeable. Check whether the
        configured root contains :data:`MCR_RUNTIME_LIBRARY` by exact name,
        because the compiled ENIGMA programs load that name directly. Ignore
        whether the directory happens to use the expected release name. Mark a
        root containing the library as ``found``; mark a root without it as
        ``wrong`` and name both the required and provided versions; mark an
        absent root as ``missing``.

        Mark a usable runtime ``wrong`` as well while a present compiled binary
        carries no executable bit, because the launchers execute those files
        directly and the run would fail at the first QC step.
        """
        configured = cfg_get(cfg, "steps.enigma.params.mcrRoot")
        root = _find_mcr_root(cfg, self)
        if not root:
            return self._mcr_missing(configured)
        release = _infer_mcr_release(root)
        if tools.exists(os.path.join(root, MCR_RUNTIME_LIBRARY)):
            blocked = _non_executable_compiled_binaries()
            if blocked:
                return Check(
                    id="mcr",
                    label="MATLAB Runtime",
                    status="wrong",
                    detail=(
                        "Make the compiled ENIGMA binaries executable because "
                        "the QC launchers run them directly: "
                        f"{', '.join(blocked)}."
                    ),
                    recommended_cmd=(
                        f"chmod +x {' '.join(shlex.quote(path) for path in blocked)}"
                    ),
                )
            named = f"{release} == {MCR_DOTTED_VERSION}" if release else "runtime"
            return Check(
                id="mcr",
                label="MATLAB Runtime",
                status="found",
                detail=f"{root} ({named}) contains {MCR_RUNTIME_LIBRARY}.",
                identity_detail=(
                    f"Use {root} ({named}); confirm {MCR_RUNTIME_LIBRARY} is present."
                ),
            )
        provided = _provided_runtime_versions(root)
        found_text = (
            f"currently provides {', '.join(provided)}"
            if provided
            else (
                "currently has no "
                f"{os.path.dirname(MCR_RUNTIME_LIBRARY)} runtime library"
            )
        )
        release_text = f"{release} at {root}" if release else root
        return Check(
            id="mcr",
            label="MATLAB Runtime",
            status="wrong",
            detail=(
                f"Install {MCR_RELEASE} ({MCR_DOTTED_VERSION}) for the compiled "
                "ENIGMA binaries; note that they load "
                f"libmwmclmcrrt.so.{MCR_DOTTED_VERSION}, while {release_text} "
                f"{found_text}."
            ),
            recommended_cmd=self._mcr_install_one_liner(),
            download_url=MCR_LANDING_URL,
            installer=Installer(
                kind="manual",
                one_liner=self._mcr_install_one_liner(),
                note=(
                    "Copy and run the silent install yourself because it writes "
                    "under a system root and needs sudo."
                ),
            ),
        )

    @staticmethod
    def _mcr_install_one_liner() -> str:
        """Build the R2019b runtime install one-liner.

        Derive the zip filename from :data:`MCR_LINUX_ZIP_URL` so a constant
        bump propagates to the unzip step automatically.
        """
        zip_name = os.path.basename(MCR_LINUX_ZIP_URL)
        return (
            f"curl -fsSLO {MCR_LINUX_ZIP_URL} && "
            f"unzip {zip_name} -d mcr_installer && "
            "sudo ./mcr_installer/install -mode silent -agreeToLicense yes "
            f"-destinationFolder {MCR_INSTALL_ROOTS[0].rsplit('/', 1)[0]}"
        )

    def _mcr_missing(self, configured: Any = None) -> Check:
        """Build a truthful ``missing`` MATLAB Runtime configuration check."""
        one_liner = self._mcr_install_one_liner()
        detail = (
            "Configure an existing MATLAB Runtime root; the saved path was not "
            f"found: {configured}."
            if isinstance(configured, str) and configured
            else (
                f"Select the installed {MCR_RELEASE} ({MCR_DOTTED_VERSION}) "
                "MATLAB Runtime root for the compiled ENIGMA QC backend."
            )
        )
        return Check(
            id="mcr",
            label="MATLAB Runtime",
            status="missing",
            detail=detail,
            recommended_cmd=one_liner,
            download_url=MCR_LANDING_URL,
            installer=Installer(
                kind="manual",
                one_liner=one_liner,
                note=(
                    "Copy and run the silent install yourself because it writes "
                    "under a system root and needs sudo."
                ),
            ),
        )


register_probe(MatlabProbe())
