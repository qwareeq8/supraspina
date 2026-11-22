"""The environment-probe contract shared by every ENV_GROUP probe module.

Each :class:`Probe` detects one related group of dependencies (Platform,
FreeSurfer, ...) and returns a list of :class:`Check` objects. Each
``Check`` serializes (via :meth:`Check.to_dict`) to exactly the renderer's
``EnvCheck`` shape (``id``, ``label``, ``status``, optional ``detail`` /
``recommendedCmd`` / ``downloadUrl`` / ``installable`` / ``offlineInstall`` /
``action``), so an ``EnvReport`` assembles without field translation. The one
sidecar-only field, ``identityDetail``, keeps a reworded detail's receipt
identity; the renderer's result contract drops it.

A check carries an :class:`Installer` when the operator can fix it. Installers
are clipboard-first: ``manual`` installers (system packages, ``sudo``,
interactive downloads) never run from the sidecar; only user-space ``command``
installers without ``sudo`` run, and only through ``env.optInInstall`` after
the renderer confirms Allow live runs. Any argv that invokes ``sudo`` or whose
program is absent from :data:`SAFE_INSTALL_PROGRAMS` is refused. The FreeSurfer
license is checked for presence and permissions only; its bytes are never read.

Probe modules register themselves in :data:`PROBES` at import time, mirroring
the adapter registry: every probe module is imported for its registration side
effect, then :data:`PROBES` is iterated in registration order.
"""

from __future__ import annotations

import sys
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal

from ..paths import flatten, interpolate
from ..provenance import IDENTITY_DETAIL_KEY

#: Read this path without executing it to detect a WSL host kernel.
_PROC_VERSION = "/proc/version"

#: Read this path without executing it to identify the host distribution.
_OS_RELEASE = "/etc/os-release"

#: Mirror the renderer's EnvCheck status union from ``types.ts``.
Status = Literal["found", "missing", "wrong", "warn", "skipped"]

#: Mirror the collapsed ``ToolStatus`` item shape for the top bar. Reserve
#: ``na`` for a tool the saved pipeline configuration does not use and for a
#: check that was deliberately skipped.
ToolState = Literal["ok", "warn", "missing", "na"]

#: Surface ``manual`` installers as clipboard fixes or download links, and never
#: execute them from the sidecar. Run safe user-space ``command`` installers
#: through ``env.optInInstall`` only after Allow live runs is confirmed.
InstallerKind = Literal["manual", "command"]

#: Name the typed in-app remediations a check can offer. Extend this closed set
#: in lockstep with the renderer's ``EnvCheckAction`` union and the result
#: contract whitelist in ``rpc-result-contracts.ts``.
ActionKind = Literal["create-directory", "setup-pybrainage"]

#: Allow an opt-in ``command`` installer to invoke only these programs. Refuse
#: anything else and any argv containing ``sudo`` to prevent privilege
#: escalation or changes to a system package set.
SAFE_INSTALL_PROGRAMS: frozenset[str] = frozenset(
    {
        "micromamba",
        "mamba",
        "conda",
        "Rscript",
        "python",
        "python3",
        "supraspina-sidecar",
        "supraspina-sidecar.exe",
    }
)


@dataclass
class Installer:
    """Describe how to fix a failing check.

    Parameters
    ----------
    kind
        Choose ``manual`` for clipboard or download instructions that are never
        executed, or choose ``command`` for user-space argv eligible for an
        opt-in run.
    argv
        Provide the argument vector for a ``command`` installer. Leave it empty
        for ``manual``.
    one_liner
        Provide a human-readable shell line for the clipboard (shown as "Copy
        fix").
    note
        Show an optional caveat alongside the fix (for example, a build-deps
        hint).
    offline
        Mark a ``command`` installer that only re-materializes verified bytes
        already on this machine and downloads nothing, so the renderer can
        offer it as a rebuild rather than an acquisition.
    """

    kind: InstallerKind
    argv: list[str] = field(default_factory=list)
    one_liner: str = ""
    note: str = ""
    offline: bool = False


@dataclass
class CheckAction:
    """Describe one typed in-app remediation the renderer can request.

    The renderer sends back only the owning check's id; the sidecar derives
    every path and argument from the saved configuration when the gated
    operation runs.

    Parameters
    ----------
    kind
        Name the gated product operation this check offers (for example,
        ``create-directory``).
    label
        Provide the action-button label naming the operation.
    """

    kind: ActionKind
    label: str


@dataclass
class Check:
    """Represent one environment check result.

    Mirror the renderer's ``EnvCheck`` attributes plus an out-of-band
    :attr:`installer` used for ``env.optInInstall``. Send only the serialized
    fields across the IPC boundary.

    A run digests each check's text into the identity its receipts bind (see
    :func:`supraspina_sidecar.provenance.environment_check_evidence`). When a
    copy edit rewords :attr:`detail`, set :attr:`identity_detail` to the
    text the identity digests, byte for byte, so the same probe result keeps
    the identity existing receipts recorded while the operator reads the new
    text. Never edit an ``identity_detail``: that makes every receipt that
    binds the check stale.
    """

    id: str
    label: str
    status: Status
    detail: str = ""
    recommended_cmd: str = ""
    download_url: str = ""
    installer: Installer | None = None
    action: CheckAction | None = None
    identity_detail: str | None = None

    @property
    def identity_text(self) -> str:
        """Return the text a run digests into this result's identity."""
        return self.detail if self.identity_detail is None else self.identity_detail

    def to_dict(self) -> dict[str, Any]:
        """Serialize to the renderer's ``EnvCheck`` shape.

        Omit optional fields when empty so the payload matches the TypeScript
        interface, where ``detail``/``recommendedCmd``/``downloadUrl`` are
        optional. Keep the :attr:`installer` implementation local; send only
        its safe-to-run classification across the boundary as ``installable``,
        and ``offlineInstall`` for a runnable installer that downloads nothing.
        Prevent a clipboard-only manual command from appearing as an in-app
        installer. Add ``identityDetail`` only when the identity text differs
        from the detail; the renderer's result contract drops it.

        Returns
        -------
        dict
            Return ``{"id", "label", "status"}`` plus any non-empty optional
            fields.
        """
        out: dict[str, Any] = {
            "id": self.id,
            "label": self.label,
            "status": self.status,
        }
        if self.detail:
            out["detail"] = self.detail
        if self.recommended_cmd:
            out["recommendedCmd"] = self.recommended_cmd
        if self.download_url:
            out["downloadUrl"] = self.download_url
        if self.recommended_cmd or self.installer is not None:
            out["installable"] = bool(
                self.installer is not None and self.installer.kind == "command"
            )
        if (
            self.installer is not None
            and self.installer.kind == "command"
            and self.installer.offline
        ):
            out["offlineInstall"] = True
        if self.action is not None:
            out["action"] = {"kind": self.action.kind, "label": self.action.label}
        if self.identity_text != self.detail:
            out[IDENTITY_DETAIL_KEY] = self.identity_text
        return out


#: Map each EnvCheck status onto the collapsed top-bar state. A probe reports
#: ``skipped`` for a check it deliberately did not run, so collapse it to the
#: neutral ``na`` rather than presenting an unrun check as a missing tool.
_TOOL_STATE: dict[Status, ToolState] = {
    "found": "ok",
    "warn": "warn",
    "wrong": "warn",
    "missing": "missing",
    "skipped": "na",
}


def collapse_status(status: Status) -> ToolState:
    """Collapse a five-value EnvCheck status onto the top-bar state.

    Parameters
    ----------
    status
        Provide an EnvCheck status
        (``found``/``warn``/``wrong``/``missing``/``skipped``).

    Returns
    -------
    str
        ``ok``, ``warn``, ``missing``, or ``na`` for the top status bar.
    """
    return _TOOL_STATE.get(status, "missing")


def host_mode() -> str:
    """Return the host platform mode from read-only signals.

    Mirror ``detectPlatform()`` in ``src/main/ipc.ts`` and the platform probe:
    return ``wsl`` when ``/proc/version`` names a Microsoft kernel
    (case-insensitive), and ``linux`` otherwise. Run no subprocess, and report
    ``linux`` when ``/proc/version`` is missing or unreadable. Reject every
    unsupported non-Linux host explicitly.

    Returns
    -------
    str
        ``wsl`` or ``linux``.

    Raises
    ------
    RuntimeError
        Raise when the host is not a supported Linux platform.
    """
    if not sys.platform.startswith("linux"):
        msg = (
            f"Run Supraspina on a supported Linux host; {sys.platform} is unsupported."
        )
        raise RuntimeError(msg)
    try:
        with open(_PROC_VERSION, encoding="utf-8") as handle:
            if "microsoft" in handle.read().lower():
                return "wsl"
    except OSError:
        return "linux"
    return "linux"


def ubuntu_host() -> bool:
    """Report whether ``/etc/os-release`` identifies an Ubuntu-family host.

    Scope reviewed ``apt`` package hints to the supported Ubuntu 22.04 and
    24.04 product targets, native or under WSL, and their derivatives by
    reading the ``ID`` and ``ID_LIKE`` keys. Run no subprocess, and report
    ``False`` when the file is missing or unreadable so no apt command is
    recommended on an unidentified host.

    Returns
    -------
    bool
        Return ``True`` when ``ID`` or ``ID_LIKE`` names ``ubuntu``.
    """
    identifiers: set[str] = set()
    try:
        with open(_OS_RELEASE, encoding="utf-8") as handle:
            for raw in handle:
                line = raw.strip()
                for key in ("ID=", "ID_LIKE="):
                    if line.startswith(key):
                        identifiers.update(
                            line.split("=", 1)[1].strip().strip("\"'").split()
                        )
    except OSError:
        return False
    return "ubuntu" in identifiers


def cfg_get(cfg: dict[str, Any], dotted: str, default: str = "") -> str:
    """Read a dotted config key without raising on a non-mapping level.

    Walk ``cfg`` one dotted segment at a time. Yield ``default`` rather than
    raising when any level is missing or is not a mapping, and keep a malformed
    config (for example, a ``tools`` value that is a string instead of a
    mapping) from collapsing its probe.

    Parameters
    ----------
    cfg
        Provide the full project configuration mapping (possibly empty or
        malformed).
    dotted
        Provide the dotted key path, for example ``tools.mcrRoot``.
    default
        Provide the value to return when the key is absent or a level is not a
        mapping.

    Returns
    -------
    str
        Return the string value at ``dotted``, or ``default``.
    """
    current: Any = cfg
    for segment in dotted.split("."):
        if not isinstance(current, dict) or segment not in current:
            return default
        current = current[segment]
    return current if isinstance(current, str) else default


class Probe(ABC):
    """Use as the base class for one ENV_GROUP probe.

    Set :attr:`name` in subclasses to the group label shown in the requirements
    checker, and implement :meth:`checks`. Expand ``${a.b}`` placeholders with
    :meth:`resolve` against the project configuration, identically to the
    adapter resolver, so probes read the same paths used by adapters.
    """

    #: Set the group name shown as the EnvGroup heading.
    name: str = ""

    @abstractmethod
    def checks(self, cfg: dict[str, Any]) -> list[Check]:
        """Run every check in this group against the project configuration.

        Parameters
        ----------
        cfg
            Provide the full project configuration mapping (possibly empty).

        Returns
        -------
        list of Check
            Return one result per check in display order.
        """

    def resolve(self, template: str, cfg: dict[str, Any]) -> str:
        """Resolve ``${...}`` placeholders in a template against the config.

        Parameters
        ----------
        template
            Provide a string possibly containing ``${a.b}`` placeholders.

        Returns
        -------
        str
            Return the interpolated string, leaving unresolved placeholders
            intact.
        """
        return interpolate(template, flatten(cfg))


#: Populate this probe registry as probe modules are imported. Keep registration
#: order equal to the EnvGroup display order in the report.
PROBES: list[Probe] = []


def register_probe(probe: Probe) -> None:
    """Append a probe to the registry, replacing any earlier one of its name.

    Replace the prior instance in place during re-registration (for example,
    when a module is imported twice under test) instead of duplicating the
    group.
    """
    for index, existing in enumerate(PROBES):
        if existing.name == probe.name:
            PROBES[index] = probe
            return
    PROBES.append(probe)
