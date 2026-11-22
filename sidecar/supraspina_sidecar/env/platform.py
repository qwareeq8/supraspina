"""Probe of host OS, platform mode, WSL, and X display for the Platform ENV_GROUP.

These are the four inexpensive host-level signals reported first by the
requirements checker. They stay independent of the project configuration and
describe the machine running the sidecar. No subprocess boots: the probe reads
``os.uname()``, ``/etc/os-release``, ``/proc/version``, and the ``DISPLAY``
environment variable.

The stdlib ``platform`` module is not imported because this module shadows that
name; ``os.uname`` plus ``/etc/os-release`` obtain the same facts without
ambiguity. Platform-mode and WSL detection are delegated to
:func:`supraspina_sidecar.env.base.host_mode`, which mirrors ``detectPlatform()``
in ``src/main/ipc.ts``, keeping the sidecar and main process consistent.
"""

from __future__ import annotations

import os
from typing import Any

from .base import Check, Probe, host_mode, register_probe

#: Surface these recommended-fix strings as the human "Copy fix" line.
_OS_RECOMMENDED_CMD = "uname -srvmp"
_WSL_RECOMMENDED_CMD = "grep -qi microsoft /proc/version"

#: Read this path on a best-effort basis for the distribution's ``PRETTY_NAME``.
_OS_RELEASE = "/etc/os-release"


def _pretty_name() -> str:
    """Return ``PRETTY_NAME`` from ``/etc/os-release``, or an empty string.

    Parse the file defensively, and collapse a missing file, unreadable file, or
    absent key to an empty string instead of raising.

    Returns
    -------
    str
        Return the unquoted ``PRETTY_NAME`` value, or ``""`` when unavailable.
    """
    try:
        with open(_OS_RELEASE, encoding="utf-8") as handle:
            for raw in handle:
                line = raw.strip()
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        return ""
    return ""


class PlatformProbe(Probe):
    """Probe for the host platform: OS, mode, WSL availability, and X display."""

    name = "Platform"

    def checks(self, cfg: dict[str, Any]) -> list[Check]:
        """Return the four host-level platform checks.

        Parameters
        ----------
        cfg
            Accept the full project configuration mapping without using it,
            because every signal here is host level rather than project level.

        Returns
        -------
        list of Check
            Return the ``os``, ``mode``, ``wsl``, and ``display`` checks in
            order.
        """
        mode = host_mode()
        return [
            self._os_check(),
            self._mode_check(mode),
            self._wsl_check(mode),
            self._display_check(),
        ]

    def _os_check(self) -> Check:
        """Build the ``os`` check from ``os.uname()`` and ``PRETTY_NAME``."""
        uname = os.uname()
        head = f"{uname.sysname} {uname.release} {uname.machine}"
        pretty = _pretty_name()
        detail = f"{head} / {pretty}" if pretty else head
        return Check(
            id="os",
            label="Operating system",
            status="found",
            detail=detail,
            recommended_cmd=_OS_RECOMMENDED_CMD,
        )

    def _mode_check(self, mode: str) -> Check:
        """Build the ``mode`` check describing the detected platform mode."""
        kinds = {
            "wsl": "wsl (Windows Subsystem for Linux)",
            "linux": "linux (native)",
        }
        return Check(
            id="mode",
            label="Platform mode",
            status="found",
            detail=kinds.get(mode, f"{mode} (native)"),
        )

    def _wsl_check(self, mode: str) -> Check:
        """Build the ``wsl`` check: found under WSL, skipped otherwise."""
        if mode == "wsl":
            return Check(
                id="wsl",
                label="WSL integration",
                status="found",
                # Translate paths through wslpath, and let the shell-group check
                # report whether the binary is present.
                detail="Supraspina translates paths through wslpath on this WSL2 host.",
                identity_detail=(
                    "Translate paths through wslpath for this detected WSL2 host."
                ),
                recommended_cmd=_WSL_RECOMMENDED_CMD,
            )
        return Check(
            id="wsl",
            label="WSL integration",
            status="skipped",
            detail=(
                "Supraspina uses paths as they are, without translation, on this "
                "non-WSL host."
            ),
            identity_detail="Use paths as-is without translation on this non-WSL host.",
            recommended_cmd=_WSL_RECOMMENDED_CMD,
        )

    def _display_check(self) -> Check:
        """Build the ``display`` check from ``$DISPLAY`` (warn when unset)."""
        display = os.environ.get("DISPLAY", "")
        if display:
            return Check(
                id="display",
                label="X display",
                status="found",
                detail=f"DISPLAY={display}",
            )
        return Check(
            id="display",
            label="X display",
            status="warn",
            detail="Set DISPLAY or run ENIGMA step 5 OpenGL through xvfb-run.",
        )


register_probe(PlatformProbe())
