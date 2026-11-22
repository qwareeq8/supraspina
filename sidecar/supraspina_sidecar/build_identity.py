"""The source identity recorded when the frozen sidecar was built.

``scripts/build-sidecar.sh`` writes ``metadata/build-identity.json`` into the
PyInstaller bundle through ``scripts/build-identity.mjs``. A source checkout,
a test, or a bundle without a valid record reports the unknown identity, so
nothing claims a commit the build did not record. The identity describes the
build only: no provenance receipt binds it, so a new build never makes a
current receipt stale.
"""

from __future__ import annotations

import functools
import json
import re
import sys
from pathlib import Path
from typing import Any

from . import __version__
from .bounded_io import read_bounded_regular

BUILD_IDENTITY_FILE = "build-identity.json"
BUILD_IDENTITY_SCHEMA_VERSION = 1
_MAX_BUILD_IDENTITY_BYTES = 4096
# Accept SHA-1 and SHA-256 object IDs in full; never an abbreviation.
_OBJECT_ID = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")


def unknown_build_identity() -> dict[str, Any]:
    """Return the identity of a build that records no source commit."""
    return {"kind": "unknown", "commit": "", "dirty": False}


def parse_build_identity(value: Any, version: str = __version__) -> dict[str, Any]:
    """Validate one build record for ``version``, else return the unknown identity.

    A release must be clean, and every known build must name a full commit
    and the product version this sidecar reports, so a stale or contradictory
    record never claims to be a release.
    """
    if not isinstance(value, dict):
        return unknown_build_identity()
    kind = value.get("kind")
    commit = value.get("commit")
    dirty = value.get("dirty")
    if (
        value.get("schemaVersion") != BUILD_IDENTITY_SCHEMA_VERSION
        or value.get("version") != version
        or not isinstance(commit, str)
        or _OBJECT_ID.fullmatch(commit) is None
        or not isinstance(dirty, bool)
    ):
        return unknown_build_identity()
    if kind == "development" or (kind == "release" and not dirty):
        return {"kind": kind, "commit": commit, "dirty": dirty}
    return unknown_build_identity()


def _build_identity_path() -> Path | None:
    """Return the embedded record path in a frozen build, else ``None``."""
    if not getattr(sys, "frozen", False):
        return None
    base = getattr(sys, "_MEIPASS", None)
    root = Path(base) if base else Path(sys.executable).resolve().parent
    return root / "metadata" / BUILD_IDENTITY_FILE


@functools.cache
def _load_build_identity() -> tuple[str, str, bool]:
    path = _build_identity_path()
    if path is None:
        identity = unknown_build_identity()
    else:
        try:
            value = json.loads(read_bounded_regular(path, _MAX_BUILD_IDENTITY_BYTES))
        except (OSError, ValueError):
            value = None
        identity = parse_build_identity(value)
    return identity["kind"], identity["commit"], identity["dirty"]


def build_identity() -> dict[str, Any]:
    """Return this sidecar's build identity as ``kind``, ``commit``, ``dirty``."""
    kind, commit, dirty = _load_build_identity()
    return {"kind": kind, "commit": commit, "dirty": dirty}
