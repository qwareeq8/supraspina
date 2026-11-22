"""SHA-256 digests of the sidecar's own module sources, also in a frozen build.

A frozen sidecar carries bytecode only, so it cannot read a module's source.
The PyInstaller spec records the digest of every first-party module source in
``metadata/source-digests.json`` at build time. A source checkout digests the
file itself, so both builds give the same value for the same bytes.
"""

from __future__ import annotations

import functools
import hashlib
import inspect
import json
import re
import sys
from pathlib import Path

from .bounded_io import read_bounded_regular

SOURCE_DIGESTS_FILE = "source-digests.json"
SOURCE_DIGESTS_SCHEMA_VERSION = 1
_MAX_SOURCE_DIGESTS_BYTES = 1024 * 1024
_SHA256 = re.compile(r"[0-9a-f]{64}")


def package_source_digests(package_dir: Path) -> dict[str, str]:
    """Return the SHA-256 of every module source in a package, by module name."""
    digests: dict[str, str] = {}
    for path in sorted(package_dir.rglob("*.py")):
        parts = path.relative_to(package_dir.parent).with_suffix("").parts
        if parts[-1] == "__init__":
            parts = parts[:-1]
        digests[".".join(parts)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return digests


def write_source_digests(package_dir: Path, output: Path) -> None:
    """Write the digest record of a package's module sources for a frozen build."""
    record = {
        "schemaVersion": SOURCE_DIGESTS_SCHEMA_VERSION,
        "modules": package_source_digests(package_dir),
    }
    output.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", "utf-8")


def _frozen_digests_path() -> Path:
    base = getattr(sys, "_MEIPASS", None)
    root = Path(base) if base else Path(sys.executable).resolve().parent
    return root / "metadata" / SOURCE_DIGESTS_FILE


@functools.cache
def _frozen_source_digests() -> dict[str, str]:
    try:
        record = json.loads(
            read_bounded_regular(_frozen_digests_path(), _MAX_SOURCE_DIGESTS_BYTES)
        )
    except (OSError, ValueError):
        return {}
    if not isinstance(record, dict):
        return {}
    modules = record.get("modules")
    if record.get("schemaVersion") != SOURCE_DIGESTS_SCHEMA_VERSION:
        return {}
    if not isinstance(modules, dict):
        return {}
    return {
        name: digest
        for name, digest in modules.items()
        if isinstance(name, str)
        and isinstance(digest, str)
        and _SHA256.fullmatch(digest)
    }


def class_source_sha256(cls: type) -> str | None:
    """Return the SHA-256 of the module source defining ``cls``, or ``None``.

    Read the build-time record in a frozen build and the source file
    otherwise. Answer ``None`` when neither is readable.
    """
    if getattr(sys, "frozen", False):
        return _frozen_source_digests().get(cls.__module__)
    try:
        source = inspect.getsourcefile(cls)
    except TypeError:
        return None
    if not source:
        return None
    try:
        return hashlib.sha256(Path(source).read_bytes()).hexdigest()
    except OSError:
        return None
