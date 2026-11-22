# ruff: noqa: E501
"""Acquisition of upstream scientific pipeline assets with pinned checksums.

Upstream SCI_Map bytes stay out of the installer and the source repository
because the reviewed tree lacks an explicit redistribution license. Packaged
builds and source checkouts both acquire them: one immutable upstream archive
is downloaded or accepted after explicit operator consent. The archive and
every selected file are verified, the reviewed compatibility transformations
are applied, and a machine-local resource generation is activated atomically.
The generation also holds a verified copy of the application's own files, so
each resource directory resolves as one tree.

No tar member is extracted through :mod:`tarfile`. Selected regular-file bytes
are copied through bounded streams into a new private generation, and the
active generation survives a failed or interrupted acquisition.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path, PurePosixPath
from typing import Any

from .bounded_io import read_bounded_regular, sha256_bounded_regular

ARCHIVE_COMMIT = "8a8c2d3586a37bb896bd8bdc3743b43e602827e3"
ARCHIVE_URL = f"https://codeload.github.com/ortizo-117/SCI_Map/tar.gz/{ARCHIVE_COMMIT}"
ARCHIVE_SHA256 = "d6f0c28a19bc71af119774f20d6b82be5d047d21ac78cbc168456c984c28dee7"
ARCHIVE_BYTES = 6_149_418
ARCHIVE_PREFIX = f"SCI_Map-{ARCHIVE_COMMIT}"

_CACHE_SCHEMA_VERSION = 1
_CURRENT_NAME = "CURRENT"
_GENERATION_NAME = re.compile(r"^[a-f0-9]{32}$")
_MAX_METADATA_BYTES = 4 * 1024
_MAX_CURRENT_BYTES = 64
_MAX_INVENTORY_BYTES = 2 * 1024 * 1024
_MAX_SELECTED_FILE_BYTES = 64 * 1024 * 1024
_DOWNLOAD_CHUNK_BYTES = 1024 * 1024
_ACQUISITION_DELIVERIES = {
    "checksum-pinned-user-acquisition",
    "checksum-pinned-user-acquisition-plus-compatibility-transform",
}
_SOURCE_ONLY_DELIVERIES = {"source-only-fidelity-reference"}
_RESOURCE_MODES = {"0600": 0o600, "0700": 0o700}

_SOURCE_WRAPPER = "resources/enigma/enigma_fs_wrapper_script.sh"
_COMPILED_WRAPPER = "resources/enigma/compiled/enigma_fs_wrapper_script_compiled.sh"

_SOURCE_PATH_HELPERS_UPSTREAM = b"""# Add path conversion functions at the start of the script
convert_to_unix_path() {
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" || "$OSTYPE" == "linux-gnu"]]; then
        # Convert Windows path to WSL path
        wslpath -u "$1"
    else
        # Return path as-is for Unix systems
        echo "$1"
    fi
}

convert_to_matlab_path() {
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32"  || "$OSTYPE" == "linux-gnu"]]; then
        # Convert to Windows path for MATLAB
        wslpath -w "$1"
    else
        # Return path as-is for Unix systems
        echo "$1"
    fi
}
"""

_SOURCE_PATH_HELPERS_REVIEWED = b"""# Add path conversion functions at the start of the script.
# Apply path translation only under Windows shells (msys/cygwin/win32) or WSL.
# Treat MATLAB as a Windows build that needs Windows paths under WSL. Detect WSL
# through /proc/version, not $OSTYPE. Account for both native Linux and WSL
# reporting "linux-gnu". Avoid running wslpath on native Linux, and preserve the
# required space before ]]. Keep native Linux and macOS on the identity path.
is_windows_or_wsl() {
    case "$OSTYPE" in
        msys | cygwin | win32) return 0 ;;
    esac
    grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null
}

convert_to_unix_path() {
    if is_windows_or_wsl; then
        # Convert Windows paths to WSL/Unix paths.
        wslpath -u "$1"
    else
        # Return paths unchanged on Unix systems (native Linux and macOS).
        echo "$1"
    fi
}

convert_to_matlab_path() {
    if is_windows_or_wsl; then
        # Convert paths for the Windows MATLAB build.
        wslpath -w "$1"
    else
        # Return paths unchanged on Unix systems (native Linux and macOS).
        echo "$1"
    fi
}
"""

_VERSION_NORMALIZATION = b"""# Normalize the requested FreeSurfer version (5/6/7/8); default to 7 when it is
# unrecognized. FreeSurfer 8 renamed the intensity-normalized volume the QC
# reads (orig_nu.mgz -> nu.mgz), so resolve the right filename once here.
case "${fs_version}" in
    5 | 6 | 7 | 8) ;;
    *)
        echo "FreeSurfer version '${fs_version}' not recognized; defaulting to 7"
        fs_version=7
        ;;
esac
if [[ "${fs_version}" -eq 8 ]]; then
    nu_vol="nu.mgz"
else
    nu_vol="orig_nu.mgz"
fi

"""


class ScientificAssetError(RuntimeError):
    """Report a failed acquisition or integrity check safely."""


def _record_mode(record: Mapping[str, Any]) -> int:
    raw_mode = record.get("mode")
    if not isinstance(raw_mode, str) or raw_mode not in _RESOURCE_MODES:
        raise ScientificAssetError(
            "Use a valid file mode in the scientific asset inventory."
        )
    return _RESOURCE_MODES[raw_mode]


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _provenance_path() -> Path:
    override = os.environ.get("SUPRASPINA_PROVENANCE_FILE")
    if override:
        return Path(override)
    if getattr(sys, "frozen", False):
        base = getattr(sys, "_MEIPASS", None)
        root = Path(base) if base else Path(sys.executable).resolve().parent
        return root / "metadata" / "THIRD_PARTY_PROVENANCE.json"
    return Path(__file__).resolve().parents[2] / "THIRD_PARTY_PROVENANCE.json"


def load_inventory(path: Path | None = None) -> dict[str, Any]:
    """Load the bounded reviewed resource inventory."""
    source = path or _provenance_path()
    try:
        info = source.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_INVENTORY_BYTES:
            raise ScientificAssetError("Provide a safe scientific asset inventory.")
        value = json.loads(read_bounded_regular(source, _MAX_INVENTORY_BYTES))
    except (OSError, json.JSONDecodeError) as exc:
        raise ScientificAssetError(
            "Provide a readable scientific asset inventory."
        ) from exc
    resources = value.get("resourceFiles") if isinstance(value, dict) else None
    evidence = (
        value.get("authoritativeEvidence", {}).get("upstreamBaseline")
        if isinstance(value, dict)
        else None
    )
    if not isinstance(value, dict):
        raise ScientificAssetError(
            "Provide the scientific asset inventory in the expected shape."
        )
    if (
        value.get("schemaVersion") != 1
        or not isinstance(resources, dict)
        or not isinstance(evidence, dict)
        or evidence.get("commit") != ARCHIVE_COMMIT
        or evidence.get("sha256") != ARCHIVE_SHA256
        or evidence.get("byteSize") != ARCHIVE_BYTES
        or evidence.get("url") != ARCHIVE_URL
    ):
        raise ScientificAssetError("Match the scientific asset inventory to the pin.")
    for record in resources.values():
        if not isinstance(record, dict):
            raise ScientificAssetError(
                "Provide only valid records in the scientific asset inventory."
            )
        _record_mode(record)
    return value


def _cache_base() -> Path:
    override = os.environ.get("SUPRASPINA_SCIENTIFIC_ASSET_ROOT")
    if override:
        return Path(override)
    # Resolve the XDG data location, the only supported host convention.
    parent = os.environ.get("XDG_DATA_HOME")
    if parent:
        return Path(parent) / "supraspina" / "scientific-assets"
    return Path.home() / ".local" / "share" / "supraspina" / "scientific-assets"


def _safe_relative(path: str) -> PurePosixPath:
    candidate = PurePosixPath(path)
    if (
        not path
        or path.startswith("/")
        or candidate.is_absolute()
        or any(part in {"", ".", ".."} for part in candidate.parts)
        or candidate.parts[0] != "resources"
        or "\\" in path
        or "\x00" in path
    ):
        raise ScientificAssetError(
            "Provide only safe paths in the scientific asset inventory."
        )
    return candidate


def _regular_sha256(path: Path, maximum_bytes: int) -> str | None:
    try:
        digest, _size = sha256_bounded_regular(
            path,
            maximum_bytes,
            chunk_bytes=_DOWNLOAD_CHUNK_BYTES,
        )
        return digest
    except (OSError, ValueError):
        return None


def _generation_metadata(inventory: Mapping[str, Any]) -> dict[str, Any]:
    resource_files = inventory["resourceFiles"]
    inventory_digest = hashlib.sha256(
        json.dumps(resource_files, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    ).hexdigest()
    return {
        "schemaVersion": _CACHE_SCHEMA_VERSION,
        "archiveCommit": ARCHIVE_COMMIT,
        "archiveSha256": ARCHIVE_SHA256,
        "inventorySha256": inventory_digest,
        "fileCount": len(resource_files),
    }


def validate_generation(
    generation: Path, inventory: Mapping[str, Any] | None = None
) -> Path | None:
    """Return a verified generation's resource root, else ``None``."""
    try:
        reviewed = dict(inventory or load_inventory())
        metadata_path = generation / "SCIENTIFIC_ASSETS.json"
        info = metadata_path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_METADATA_BYTES:
            return None
        actual_metadata = json.loads(
            read_bounded_regular(metadata_path, _MAX_METADATA_BYTES)
        )
        if actual_metadata != _generation_metadata(reviewed):
            return None
        for relative, record in reviewed["resourceFiles"].items():
            if (
                isinstance(record, dict)
                and record.get("delivery") in _SOURCE_ONLY_DELIVERIES
            ):
                continue
            if not isinstance(record, dict):
                return None
            safe = _safe_relative(relative)
            expected = record.get("sha256")
            expected_mode = _record_mode(record)
            target = generation.joinpath(*safe.parts)
            target_info = target.lstat()
            if (
                not isinstance(expected, str)
                or not re.fullmatch(r"[a-f0-9]{64}", expected)
                or not stat.S_ISREG(target_info.st_mode)
                or stat.S_IMODE(target_info.st_mode) != expected_mode
                or _regular_sha256(target, _MAX_SELECTED_FILE_BYTES) != expected
            ):
                return None
    except (OSError, ValueError, TypeError, ScientificAssetError, json.JSONDecodeError):
        return None
    return generation / "resources"


#: Parts of a reviewed path that names a file inside a resource directory
#: (``resources/<directory>/<file>``).
_NESTED_RECORD_PARTS = 3


def _record_directory(relative: str) -> str:
    """Return the top-level resource directory of one reviewed file, or ``""``."""
    parts = _safe_relative(relative).parts
    return parts[1] if len(parts) >= _NESTED_RECORD_PARTS else ""


def _file_matches(target: Path, record: Mapping[str, Any], *, mode: bool) -> bool:
    """Report whether one file holds its reviewed bytes (and mode, if asked)."""
    expected = record.get("sha256")
    try:
        info = target.lstat()
    except OSError:
        return False
    return (
        isinstance(expected, str)
        and re.fullmatch(r"[a-f0-9]{64}", expected) is not None
        and stat.S_ISREG(info.st_mode)
        and (not mode or stat.S_IMODE(info.st_mode) == _record_mode(record))
        and _regular_sha256(target, _MAX_SELECTED_FILE_BYTES) == expected
    )


def _directory_matches(
    base: Path,
    records: list[tuple[PurePosixPath, Mapping[str, Any]]],
    *,
    mode: bool,
) -> bool:
    """Report whether ``base`` holds every reviewed file of one directory."""
    return all(
        _file_matches(base.joinpath(*safe.parts), record, mode=mode)
        for safe, record in records
    )


def application_resource_root() -> Path:
    """Return the application's own resource files.

    A frozen build stages its redistributable subset beside the sidecar; a
    source checkout holds the same first-party files in its ``resources``
    directory. Neither holds an acquired upstream file.
    """
    if getattr(sys, "frozen", False):
        frozen_base = getattr(sys, "_MEIPASS", None)
        package_root = (
            Path(frozen_base) if frozen_base else Path(sys.executable).resolve().parent
        )
        return package_root / "resources"
    return Path(__file__).resolve().parents[2] / "resources"


def _delivered_by_directory(
    inventory: Mapping[str, Any],
) -> dict[str, list[tuple[PurePosixPath, Mapping[str, Any]]]]:
    """Group the reviewed delivered files by their top-level resource directory."""
    groups: dict[str, list[tuple[PurePosixPath, Mapping[str, Any]]]] = {}
    for relative, record in inventory["resourceFiles"].items():
        if not isinstance(record, dict):
            raise ScientificAssetError(
                "Provide only valid records in the scientific asset inventory."
            )
        if record.get("delivery") in _SOURCE_ONLY_DELIVERIES:
            continue
        groups.setdefault(_record_directory(relative), []).append(
            (_safe_relative(relative), record)
        )
    return groups


def usable_generation(
    generation: Path, inventory: Mapping[str, Any] | None = None
) -> Path | None:
    """Return a generation's resource root when it serves this version, else ``None``.

    The generation must come from the pinned upstream archive and must hold,
    with the reviewed mode and SHA-256, every reviewed file of each resource
    directory that holds an acquired file (``enigma``, ``features``). A
    directory of bundled files only (``step8``, ``step9``, ``braincharts``)
    may be stale or missing in it when the application's own copy holds the
    reviewed bytes: :func:`stale_bundled_directories` names those, and they
    resolve from that copy. When neither copy does, the generation is
    rejected. An upgrade that revises only bundled files therefore keeps the
    generation the operator already acquired, and the ENIGMA QC and
    feature-extraction paths every receipt bound stay the same, without a
    rebuild. :func:`validate_generation` keeps
    the exact check a new generation must pass before it is activated.
    """
    try:
        reviewed = inventory or load_inventory()
        metadata_path = generation / "SCIENTIFIC_ASSETS.json"
        info = metadata_path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_METADATA_BYTES:
            return None
        metadata = json.loads(read_bounded_regular(metadata_path, _MAX_METADATA_BYTES))
        if (
            not isinstance(metadata, dict)
            or metadata.get("schemaVersion") != _CACHE_SCHEMA_VERSION
            or metadata.get("archiveCommit") != ARCHIVE_COMMIT
            or metadata.get("archiveSha256") != ARCHIVE_SHA256
        ):
            return None
        application = application_resource_root().parent
        for records in _delivered_by_directory(reviewed).values():
            if all(record.get("delivery") == "bundled" for _path, record in records):
                if not _directory_matches(
                    generation, records, mode=True
                ) and not _directory_matches(application, records, mode=False):
                    # Neither copy holds the reviewed bytes.
                    return None
                continue
            if not _directory_matches(generation, records, mode=True):
                return None
    except (OSError, ValueError, TypeError, ScientificAssetError, json.JSONDecodeError):
        return None
    return generation / "resources"


def stale_bundled_directories(
    resource_root: Path,
    bundled_root: Path,
    inventory: Mapping[str, Any] | None = None,
) -> frozenset[str]:
    """Name the bundled-only directories to resolve from ``bundled_root``.

    A directory of bundled files only resolves from the application's own
    copy when the active generation's copy no longer holds the reviewed bytes
    (an upgrade revised or added it) and the application's copy does. A
    source checkout resolves every such directory from its own copy, so an
    edit runs before the inventory is regenerated. Every other directory, and
    every directory when ``resource_root`` is the application's copy itself,
    resolves under ``resource_root``.
    """
    if resource_root == bundled_root:
        return frozenset()
    try:
        groups = _delivered_by_directory(inventory or load_inventory())
    except (KeyError, TypeError, ValueError, ScientificAssetError):
        return frozenset()
    stale: set[str] = set()
    for name, records in groups.items():
        if not name or any(
            record.get("delivery") != "bundled" for _p, record in records
        ):
            continue
        if not getattr(sys, "frozen", False):
            stale.add(name)
            continue
        if all(
            _file_matches(resource_root.joinpath(*safe.parts[1:]), record, mode=True)
            for safe, record in records
        ):
            continue
        if all(
            _file_matches(bundled_root.joinpath(*safe.parts[1:]), record, mode=False)
            for safe, record in records
        ):
            stale.add(name)
    return frozenset(stale)


#: Generation checks remembered for one read-only pass on this thread;
#: ``None`` outside :func:`resolution_scope`.
_RESOLUTION_MEMO: ContextVar[dict[Any, Any] | None] = ContextVar(
    "supraspina_scientific_asset_resolution", default=None
)


@contextmanager
def resolution_scope() -> Iterator[None]:
    """Check each active generation at most once within one pass.

    A plan or a Results inventory resolves the resource root for every bound
    action and resource identity it digests, and each resolution re-hashed
    every acquired file, so a plan over many subjects validated the generation
    thousands of times. Inside this scope the first check of a generation stands for
    the rest of the pass on the calling thread; a changed ``CURRENT`` marker
    still checks the generation it names. A nested scope reuses the outer
    one. Do not open it around a launch binding or a post-exit proof, which
    must see the generation as it is at that moment.
    """
    if _RESOLUTION_MEMO.get() is not None:
        yield
        return
    token = _RESOLUTION_MEMO.set({})
    try:
        yield
    finally:
        _RESOLUTION_MEMO.reset(token)


def _current_generation(base: Path) -> Path | None:
    """Return the generation the ``CURRENT`` marker names, without checking it."""
    current = base / _CURRENT_NAME
    try:
        info = current.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_CURRENT_BYTES:
            return None
        generation_name = (
            read_bounded_regular(current, _MAX_CURRENT_BYTES).decode("ascii").strip()
        )
    except (OSError, UnicodeError):
        return None
    if not _GENERATION_NAME.fullmatch(generation_name):
        return None
    return base / "generations" / generation_name


def active_resource_root(
    inventory: Mapping[str, Any] | None = None, cache_base: Path | None = None
) -> Path | None:
    """Return the resource root of the current generation when it is usable.

    See :func:`usable_generation`. Reuse this pass's check of the same
    generation inside :func:`resolution_scope` when the reviewed inventory is
    the default one.
    """
    generation = _current_generation(cache_base or _cache_base())
    if generation is None:
        return None
    memo = _RESOLUTION_MEMO.get()
    if memo is None or inventory is not None:
        return usable_generation(generation, inventory)
    key = ("usable", str(generation))
    if key not in memo:
        memo[key] = usable_generation(generation)
    return memo[key]


def reviewed_directories() -> tuple[str, ...]:
    """List the top-level resource directories of the reviewed inventory.

    Return an empty tuple when the inventory cannot be read; memoized inside
    :func:`resolution_scope`.
    """
    memo = _RESOLUTION_MEMO.get()
    if memo is not None and "directories" in memo:
        return memo["directories"]
    try:
        groups = _delivered_by_directory(load_inventory())
        names = tuple(sorted(name for name in groups if name))
    except (KeyError, TypeError, ValueError, ScientificAssetError):
        names = ()
    if memo is not None:
        memo["directories"] = names
    return names


def bundled_override(name: str, resource_root: Path, bundled_root: Path) -> bool:
    """Report whether directory ``name`` resolves from the application's copy.

    See :func:`stale_bundled_directories`; memoized inside
    :func:`resolution_scope`.
    """
    memo = _RESOLUTION_MEMO.get()
    key = ("stale", str(resource_root), str(bundled_root))
    if memo is None:
        return name in stale_bundled_directories(resource_root, bundled_root)
    if key not in memo:
        memo[key] = stale_bundled_directories(resource_root, bundled_root)
    return name in memo[key]


def _mixed_bundled_records(
    inventory: Mapping[str, Any],
) -> list[tuple[PurePosixPath, Mapping[str, Any]]]:
    """List the bundled files that share a directory with an acquired file."""
    return [
        (safe, record)
        for records in _delivered_by_directory(inventory).values()
        if any(record.get("delivery") != "bundled" for _path, record in records)
        for safe, record in records
        if record.get("delivery") == "bundled"
    ]


def application_copy_current(inventory: Mapping[str, Any] | None = None) -> bool:
    """Report whether the generation's copies of first-party files are current.

    A directory that holds an acquired file resolves as one tree from the
    generation, including its bundled files. Those copies hold the reviewed
    bytes, so they are current only while the application's own copies hold
    the same bytes; a source checkout that edited one fails this until its
    inventory is regenerated and the generation rebuilt. Memoized inside
    :func:`resolution_scope`.
    """
    memo = _RESOLUTION_MEMO.get()
    if memo is not None and inventory is None and "application" in memo:
        return memo["application"]
    try:
        current = _directory_matches(
            application_resource_root().parent,
            _mixed_bundled_records(inventory or load_inventory()),
            mode=False,
        )
    except (KeyError, TypeError, ValueError, ScientificAssetError):
        current = False
    if memo is not None and inventory is None:
        memo["application"] = current
    return current


def _check_application_copy(bundled_root: Path, inventory: Mapping[str, Any]) -> None:
    """Refuse an acquisition whose own first-party files are not the reviewed ones."""
    for records in _delivered_by_directory(inventory).values():
        for safe, record in records:
            if record.get("delivery") == "bundled" and not _file_matches(
                bundled_root.joinpath(*safe.parts[1:]), record, mode=False
            ):
                raise ScientificAssetError(
                    "Match the application's own resource files to the reviewed "
                    "inventory, and regenerate THIRD_PARTY_PROVENANCE.json after "
                    "editing one."
                )


def generation_roots(cache_base: Path | None = None) -> list[Path]:
    """List the resource roots of every acquisition generation on disk.

    Report candidate locations only, without verifying their contents. A
    caller matching a receipt that bound one of these locations verbatim
    relies on the receipt's own content identities, not on this listing.
    """
    generations = (cache_base or _cache_base()) / "generations"
    try:
        return [
            entry / "resources"
            for entry in sorted(generations.iterdir(), key=lambda item: item.name)
            if _GENERATION_NAME.fullmatch(entry.name) and not entry.is_symlink()
        ]
    except OSError:
        return []


def acquisition_required() -> bool:
    """Report whether the application lacks a current acquired asset set."""
    return active_resource_root() is None or not application_copy_current()


def acquisition_command() -> list[str]:
    """Return the exact argv of an acquisition that Allow live runs gates."""
    if getattr(sys, "frozen", False):
        return [sys.executable, "--acquire-scientific-assets"]
    return [
        sys.executable,
        "-m",
        "supraspina_sidecar.scientific_assets",
        "--acquire",
    ]


def _replace_exact(
    value: bytes, old: bytes, new: bytes, expected_count: int = 1
) -> bytes:
    count = value.count(old)
    if count != expected_count:
        raise ScientificAssetError(
            "Match the pinned wrapper to the reviewed compatibility transform."
        )
    return value.replace(old, new)


def _adapt_source_wrapper(value: bytes) -> bytes:
    value = _replace_exact(
        value, _SOURCE_PATH_HELPERS_UPSTREAM, _SOURCE_PATH_HELPERS_REVIEWED
    )
    value = _replace_exact(
        value,
        b"\t--fs7\t\tFreesurfer v7 and above (e.g. --fs true or false)",
        b"\t--fs_version\tFreesurfer version (choose from 5, 6, 7, or 8)",
    )
    value = _replace_exact(value, b"\t--fs7)", b"\t--fs_version)")
    value = _replace_exact(
        value,
        b'matlab_dir=$(convert_to_unix_path "$matlab_dir")\n\n',
        b'matlab_dir=$(convert_to_unix_path "$matlab_dir")\n\n'
        + _VERSION_NORMALIZATION,
    )
    value = _replace_exact(
        value, b'if [[ "${fs_version}" = true ]]', b'if [[ "${fs_version}" -ge 7 ]]'
    )
    value = _replace_exact(
        value,
        b"grep IntraCranialVol",
        b'grep "Measure EstimatedTotalIntraCranialVol"',
        4,
    )
    value = _replace_exact(
        value,
        b'fs_path=$(wslpath -w "',
        b'fs_path=$(convert_to_matlab_path "',
        3,
    )
    value = _replace_exact(
        value,
        b'enigma_qc_path=$(wslpath -w "',
        b'enigma_qc_path=$(convert_to_matlab_path "',
        3,
    )
    value = _replace_exact(
        value,
        b'qc_path=$(wslpath -w "',
        b'qc_path=$(convert_to_matlab_path "',
        3,
    )
    value = _replace_exact(value, b"/mri/orig_nu.mgz", b"/mri/${nu_vol}", 2)
    return value


def _adapt_compiled_wrapper(value: bytes) -> bytes:
    value = _replace_exact(
        value,
        b"\t--fs7\t\tFreesurfer v7 and above (e.g. --fs true or false)",
        b"\t--fs_version\tFreesurfer version (choose from 5, 6, 7, or 8)",
    )
    value = _replace_exact(value, b"\t--fs7)", b"\t--fs_version)")
    value = _replace_exact(
        value,
        b"\n\n#STEP 1: Extract Subcortical Volumes\n",
        b"\n\n" + _VERSION_NORMALIZATION + b"#STEP 1: Extract Subcortical Volumes\n",
    )
    value = _replace_exact(
        value, b'if [[ "${fs_version}" = true ]]', b'if [[ "${fs_version}" -ge 7 ]]'
    )
    value = _replace_exact(
        value,
        b"grep IntraCranialVol",
        b'grep "Measure EstimatedTotalIntraCranialVol"',
        4,
    )
    value = _replace_exact(value, b"/mri/orig_nu.mgz", b"/mri/${nu_vol}", 2)
    return value


def _adapt(relative: str, value: bytes) -> bytes:
    if relative == _SOURCE_WRAPPER:
        return _adapt_source_wrapper(value)
    if relative == _COMPILED_WRAPPER:
        return _adapt_compiled_wrapper(value)
    raise ScientificAssetError("Select a known reviewed compatibility transform.")


def _write_regular(path: Path, value: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        with path.open("xb") as handle:
            os.chmod(handle.fileno(), mode)
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as exc:
        raise ScientificAssetError(
            "Choose writable storage for acquired scientific assets."
        ) from exc


def _selected_member_bytes(
    archive: tarfile.TarFile, member_name: str, expected_size_limit: int
) -> bytes:
    safe = PurePosixPath(member_name)
    if (
        safe.is_absolute()
        or any(part in {"", ".", ".."} for part in safe.parts)
        or "\\" in member_name
        or "\x00" in member_name
    ):
        raise ScientificAssetError("Provide a safe pinned archive-member path.")
    try:
        member = archive.getmember(member_name)
    except KeyError as exc:
        raise ScientificAssetError(
            "Include every required asset in the pinned archive."
        ) from exc
    if (
        not member.isfile()
        or member.issym()
        or member.islnk()
        or member.size < 0
        or member.size > min(_MAX_SELECTED_FILE_BYTES, expected_size_limit)
    ):
        raise ScientificAssetError(
            "Provide the pinned archive member as a bounded regular file."
        )
    stream = archive.extractfile(member)
    if stream is None:
        raise ScientificAssetError("Provide a readable pinned archive member.")
    payload = bytearray()
    remaining = member.size + 1
    while remaining > 0:
        chunk = stream.read(min(_DOWNLOAD_CHUNK_BYTES, remaining))
        if not chunk:
            break
        payload.extend(chunk)
        remaining -= len(chunk)
        if len(payload) > member.size:
            raise ScientificAssetError(
                "Keep the pinned archive member within its declared size."
            )
    value = bytes(payload)
    if len(value) != member.size:
        raise ScientificAssetError(
            "Keep the pinned archive-member size stable while reading."
        )
    return value


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _activate_archive(  # noqa: PLR0913
    archive_path: Path,
    *,
    bundled_root: Path,
    inventory: Mapping[str, Any],
    cache_base: Path,
    expected_archive_sha256: str,
    expected_archive_bytes: int,
    archive_prefix: str,
) -> Path:
    """Verify and atomically activate one already-downloaded archive."""
    try:
        archive_info = archive_path.lstat()
    except OSError as exc:
        raise ScientificAssetError(
            "Provide a readable scientific asset archive."
        ) from exc
    if not stat.S_ISREG(archive_info.st_mode):
        raise ScientificAssetError(
            "Provide the scientific asset archive as a regular file."
        )
    if archive_info.st_size != expected_archive_bytes:
        raise ScientificAssetError("Match the scientific asset archive byte size.")
    try:
        archive_payload = read_bounded_regular(archive_path, expected_archive_bytes)
    except OSError as exc:
        raise ScientificAssetError(
            "Provide a safely readable scientific asset archive."
        ) from exc
    if _sha256_bytes(archive_payload) != expected_archive_sha256:
        raise ScientificAssetError("Match the scientific asset archive SHA-256.")

    def _from_archive(relative: PurePosixPath, record: Mapping[str, Any]) -> bytes:
        provenance = record.get("provenance")
        upstream_path = (
            provenance.get("upstreamPath") if isinstance(provenance, dict) else None
        )
        if not isinstance(upstream_path, str):
            raise ScientificAssetError(
                "Include an upstream path in the scientific asset inventory."
            )
        upstream_safe = PurePosixPath(upstream_path)
        if (
            upstream_safe.is_absolute()
            or any(part in {"", ".", ".."} for part in upstream_safe.parts)
            or "\\" in upstream_path
            or "\x00" in upstream_path
        ):
            raise ScientificAssetError("Provide a safe scientific asset upstream path.")
        member_name = f"{archive_prefix}/{upstream_path}"
        value = _selected_member_bytes(archive, member_name, _MAX_SELECTED_FILE_BYTES)
        if str(record.get("delivery", "")).endswith("compatibility-transform"):
            value = _adapt(str(relative), value)
        return value

    try:
        with tarfile.open(fileobj=io.BytesIO(archive_payload), mode="r:gz") as archive:
            return _build_generation(
                _from_archive,
                bundled_root=bundled_root,
                inventory=inventory,
                cache_base=cache_base,
            )
    except tarfile.TarError as exc:
        raise ScientificAssetError(
            "Provide a readable scientific asset archive."
        ) from exc


def _build_generation(  # noqa: PLR0912, PLR0915
    acquired_bytes: Callable[[PurePosixPath, Mapping[str, Any]], bytes],
    *,
    bundled_root: Path,
    inventory: Mapping[str, Any],
    cache_base: Path,
) -> Path:
    """Assemble, verify, and atomically activate one generation.

    ``acquired_bytes`` supplies the bytes of each acquisition-delivered file
    (from the pinned archive, or from an earlier generation of it); bundled
    files come from ``bundled_root``. Every file is checked against the
    reviewed SHA-256 before the generation is published.
    """
    generations = cache_base / "generations"
    generations.mkdir(mode=0o700, parents=True, exist_ok=True)
    if generations.is_symlink():
        raise ScientificAssetError("Provide a safe scientific asset cache.")
    generation_name = uuid.uuid4().hex
    generation = Path(
        tempfile.mkdtemp(prefix=f".{generation_name}-", dir=str(generations))
    )
    os.chmod(generation, 0o700)
    marker_tmp: Path | None = None

    try:
        for relative, raw_record in sorted(inventory["resourceFiles"].items()):
            safe_relative = _safe_relative(relative)
            record = raw_record if isinstance(raw_record, dict) else {}
            delivery = record.get("delivery")
            mode = _record_mode(record)
            if delivery in _SOURCE_ONLY_DELIVERIES:
                continue
            expected = record.get("sha256")
            if not isinstance(expected, str):
                raise ScientificAssetError(
                    "Provide only valid digests in the scientific asset inventory."
                )
            if delivery == "bundled":
                source = bundled_root.joinpath(*safe_relative.parts[1:])
                try:
                    value = read_bounded_regular(source, _MAX_SELECTED_FILE_BYTES)
                except OSError as exc:
                    raise ScientificAssetError(
                        "Provide the bundled scientific support asset."
                    ) from exc
            elif delivery in _ACQUISITION_DELIVERIES:
                try:
                    value = acquired_bytes(safe_relative, record)
                except OSError as exc:
                    raise ScientificAssetError(
                        "Provide the acquired scientific asset bytes."
                    ) from exc
            else:
                raise ScientificAssetError(
                    "Select a known delivery mode in the scientific asset inventory."
                )
            if _sha256_bytes(value) != expected:
                raise ScientificAssetError(
                    "Match the scientific asset bytes to the reviewed SHA-256."
                )
            _write_regular(
                generation.joinpath(*safe_relative.parts),
                value,
                mode,
            )

        metadata = (
            json.dumps(
                _generation_metadata(inventory),
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode("ascii")
        _write_regular(generation / "SCIENTIFIC_ASSETS.json", metadata)
        activated = validate_generation(generation, inventory)
        if activated is None:
            raise ScientificAssetError(
                "Regenerate the scientific assets until final integrity validation passes."
            )
        final_generation = generations / generation_name
        os.replace(generation, final_generation)
        _fsync_directory(generations)
        marker_tmp = cache_base / f".CURRENT-{uuid.uuid4().hex}"
        _write_regular(marker_tmp, f"{generation_name}\n".encode("ascii"))
        os.replace(marker_tmp, cache_base / _CURRENT_NAME)
        _fsync_directory(cache_base)
        active = active_resource_root(inventory, cache_base)
        if active is None:
            raise ScientificAssetError("Activate the scientific asset generation.")
        return active
    except OSError as exc:
        raise ScientificAssetError(
            "Provide a readable scientific asset archive."
        ) from exc
    finally:
        if generation.exists():
            shutil.rmtree(generation, ignore_errors=True)
        if marker_tmp is not None:
            try:
                marker_tmp.unlink(missing_ok=True)
            except OSError:
                pass


def _download(destination: Path) -> None:
    try:
        request = urllib.request.Request(  # noqa: S310 - Open an immutable HTTPS URL.
            ARCHIVE_URL,
            headers={"User-Agent": "Supraspina-scientific-asset-acquisition/1"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            with destination.open("xb") as output:
                os.chmod(output.fileno(), 0o600)
                total = 0
                while total <= ARCHIVE_BYTES:
                    chunk = response.read(
                        min(_DOWNLOAD_CHUNK_BYTES, ARCHIVE_BYTES + 1 - total)
                    )
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > ARCHIVE_BYTES:
                        raise ScientificAssetError(
                            "Keep the scientific asset download within the pinned size."
                        )
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
    except (OSError, urllib.error.URLError) as exc:
        raise ScientificAssetError("Retry the scientific asset download.") from exc


def _reuse_candidates(cache_base: Path) -> list[Path]:
    """List the earlier generations of the pinned archive, newest first.

    Return an empty list when the cache cannot be read, so a caller falls back
    to the archive instead of trusting a partial listing.
    """
    generations = cache_base / "generations"
    candidates: list[tuple[float, Path]] = []
    try:
        for entry in generations.iterdir():
            if not _GENERATION_NAME.fullmatch(entry.name):
                continue
            metadata_path = entry / "SCIENTIFIC_ASSETS.json"
            info = metadata_path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_METADATA_BYTES:
                continue
            metadata = json.loads(
                read_bounded_regular(metadata_path, _MAX_METADATA_BYTES)
            )
            if (
                metadata.get("archiveCommit") == ARCHIVE_COMMIT
                and metadata.get("archiveSha256") == ARCHIVE_SHA256
            ):
                candidates.append((info.st_mtime, entry))
    except (OSError, ValueError, json.JSONDecodeError):
        return []
    return [entry for _mtime, entry in sorted(candidates, reverse=True)]


def _reproduces_inventory(
    previous: Path, bundled_root: Path, inventory: Mapping[str, Any]
) -> bool:
    """Report whether one earlier generation rebuilds every reviewed file.

    Read the same sources :func:`_reuse_generation` would copy (acquired files
    from ``previous``, bundled files from ``bundled_root``) and compare each
    with its reviewed SHA-256 without writing anything.
    """
    try:
        for relative, record in inventory["resourceFiles"].items():
            if not isinstance(record, dict):
                return False
            delivery = record.get("delivery")
            if delivery in _SOURCE_ONLY_DELIVERIES:
                continue
            safe = _safe_relative(relative)
            if delivery == "bundled":
                source = bundled_root.joinpath(*safe.parts[1:])
            elif delivery in _ACQUISITION_DELIVERIES:
                source = previous.joinpath(*safe.parts)
            else:
                return False
            if _regular_sha256(source, _MAX_SELECTED_FILE_BYTES) != record.get(
                "sha256"
            ):
                return False
    except (KeyError, TypeError, ScientificAssetError):
        return False
    return True


def offline_rebuild_available(
    *,
    bundled_root: Path | None = None,
    inventory: Mapping[str, Any] | None = None,
    cache_base: Path | None = None,
) -> bool:
    """Report whether an acquisition would rebuild the assets without a download.

    Mirror :func:`_reuse_generation` read-only: an earlier generation of the
    pinned archive plus the bundled files must reproduce every reviewed file
    with its reviewed SHA-256. When they do, an acquisition only
    re-materializes verified bytes already on this machine. Nothing is written,
    and an unreadable inventory or cache reports ``False``.
    """
    try:
        reviewed = inventory or load_inventory()
    except ScientificAssetError:
        return False
    root = bundled_root or application_resource_root()
    return any(
        _reproduces_inventory(previous, root, reviewed)
        for previous in _reuse_candidates(cache_base or _cache_base())
    )


def _reuse_generation(
    *,
    bundled_root: Path,
    inventory: Mapping[str, Any],
    cache_base: Path,
) -> Path | None:
    """Rebuild the active generation from one acquired earlier, without a download.

    An application upgrade that revises the reviewed inventory (a refreshed
    manifest, a changed bundled file) invalidates the active generation even
    though the pinned upstream archive is unchanged. Every acquired file is
    still on disk, so the new generation is assembled from the newest earlier
    generation of the same archive plus the bundled files, and each file is
    verified against the revised inventory. Any file that no longer matches
    (a revised compatibility transform, say) makes this return ``None`` so the
    caller falls back to the archive.
    """
    for previous in _reuse_candidates(cache_base):

        def _from_previous(
            relative: PurePosixPath,
            record: Mapping[str, Any],
            *,
            previous: Path = previous,
        ) -> bytes:
            del record
            return read_bounded_regular(
                previous.joinpath(*relative.parts), _MAX_SELECTED_FILE_BYTES
            )

        try:
            return _build_generation(
                _from_previous,
                bundled_root=bundled_root,
                inventory=inventory,
                cache_base=cache_base,
            )
        except ScientificAssetError:
            continue
    return None


def acquire_scientific_assets(
    archive_path: Path | None = None,
    *,
    bundled_root: Path | None = None,
    inventory_path: Path | None = None,
    cache_base: Path | None = None,
) -> Path:
    """Acquire and atomically activate the reviewed scientific asset set."""
    inventory = load_inventory(inventory_path)
    if bundled_root is None:
        bundled_root = application_resource_root()
    # Fail before any download when the generation could not verify anyway.
    _check_application_copy(bundled_root, inventory)
    base = cache_base or _cache_base()
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    if base.is_symlink():
        raise ScientificAssetError("Provide a safe scientific asset cache.")
    active = active_resource_root(inventory, base)
    if active is not None:
        return active

    reused = _reuse_generation(
        bundled_root=bundled_root, inventory=inventory, cache_base=base
    )
    if reused is not None:
        return reused

    if archive_path is not None:
        archive = archive_path
        return _activate_archive(
            archive,
            bundled_root=bundled_root,
            inventory=inventory,
            cache_base=base,
            expected_archive_sha256=ARCHIVE_SHA256,
            expected_archive_bytes=ARCHIVE_BYTES,
            archive_prefix=ARCHIVE_PREFIX,
        )

    with tempfile.TemporaryDirectory(prefix="supraspina-acquisition-") as temporary:
        archive = Path(temporary) / "upstream.tar.gz"
        _download(archive)
        return _activate_archive(
            archive,
            bundled_root=bundled_root,
            inventory=inventory,
            cache_base=base,
            expected_archive_sha256=ARCHIVE_SHA256,
            expected_archive_bytes=ARCHIVE_BYTES,
            archive_prefix=ARCHIVE_PREFIX,
        )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Acquire Supraspina's checksum-pinned scientific assets."
    )
    parser.add_argument(
        "--acquire",
        action="store_true",
        help="Download, verify, and activate the pinned assets.",
    )
    parser.add_argument(
        "--archive",
        type=Path,
        help="Use an offline copy of the exact pinned upstream tar.gz.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the explicit acquisition CLI without exposing machine-local paths."""
    args = _parser().parse_args(argv)
    if not args.acquire:
        _parser().error("Pass --acquire.")
    try:
        acquire_scientific_assets(args.archive)
    except ScientificAssetError as exc:
        print(
            f"Resolve the scientific asset acquisition failure: {exc}.", file=sys.stderr
        )
        return 1
    print("Acquired and verified the scientific assets.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
