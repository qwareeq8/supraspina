"""Resolution and validation of a user-managed FreeSurfer license, never reading it."""

from __future__ import annotations

import os
import stat
from typing import Any

from .paths import flatten, interpolate


def _configured_string(cfg: dict[str, Any], key: str) -> str:
    """Return one string-valued ``tools`` setting, or an empty string."""
    tools = cfg.get("tools", {})
    value = tools.get(key) if isinstance(tools, dict) else ""
    return value if isinstance(value, str) else ""


def resolve_freesurfer_home(cfg: dict[str, Any]) -> str:
    """Resolve the FreeSurfer install root from project config then environment.

    Parameters
    ----------
    cfg
        Provide project configuration whose placeholders may reference other
        fields.

    Returns
    -------
    str
        Return the interpolated install root or an empty string when none is set.
    """
    configured = _configured_string(cfg, "freesurferHome")
    selected = configured or os.environ.get("FREESURFER_HOME", "")
    return interpolate(selected, flatten(cfg)) if selected else ""


def resolve_freesurfer_license_path(
    cfg: dict[str, Any],
    *,
    freesurfer_home: str | None = None,
) -> str:
    """Resolve the selected FreeSurfer license path without reading its bytes.

    Follow the diagnostics selection contract exactly: project
    ``tools.freesurferLicense``, then ``FS_LICENSE``, then ``license.txt`` under
    the resolved FreeSurfer home, then ``.license`` there. ``.license`` is
    FreeSurfer's own fallback, which FreeSurfer never reaches because Supraspina
    always exports ``FS_LICENSE``; select it only when no ``license.txt``
    exists, so every earlier selection stays the same path. Check only whether
    the two install-root candidates exist.

    Parameters
    ----------
    cfg
        Provide project configuration whose placeholders may reference other fields.
    freesurfer_home
        Provide an optional resolved install root. Resolve the project field
        and then ``FREESURFER_HOME`` when it is omitted.

    Returns
    -------
    str
        Return the interpolated selected path, ``license.txt`` under the home
        when neither install-root candidate exists, or an empty string when no
        source exists.
    """
    configured = _configured_string(cfg, "freesurferLicense")
    selected = configured or os.environ.get("FS_LICENSE", "")
    if selected:
        return interpolate(selected, flatten(cfg))
    home = resolve_freesurfer_home(cfg) if freesurfer_home is None else freesurfer_home
    if not home:
        return ""
    values = flatten(cfg)
    license_txt = interpolate(os.path.join(home, "license.txt"), values)
    if os.path.exists(license_txt):
        return license_txt
    dot_license = interpolate(os.path.join(home, ".license"), values)
    return dot_license if os.path.exists(dot_license) else license_txt


def is_readable_freesurfer_license(path: str) -> bool:
    """Return whether ``path`` is a readable, non-empty regular file.

    Inspect only metadata. Never open, read, copy, or hash the license.

    Returns
    -------
    bool
        Return ``True`` only for a readable, non-empty regular file.
    """
    if not path:
        return False
    try:
        info = os.stat(path)
    except (OSError, TypeError, ValueError):
        return False
    return stat.S_ISREG(info.st_mode) and info.st_size > 0 and os.access(path, os.R_OK)
