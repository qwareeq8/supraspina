"""Verification of machine-local scientific container resources.

FastSurfer and SynthStrip containers stay outside the normal desktop package.
Each reviewed OCI image is acquired by immutable manifest digest, converted with
the reviewed Apptainer release, and activated only when the SIF's pinned size
and SHA-256 match. Offline imports and online pulls share the same verifier and
immutable-generation layout.

Pure command construction, bounded verification, and atomic activation live in
this module. Download progress, authorization, and subprocess cancellation live
in the RPC-facing operation manager.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any

from .bounded_io import BoundedReadError, read_bounded_regular, sha256_bounded_regular

FASTSURFER_VERSION = "2.5.4"
SYNTHSTRIP_VERSION = "1.8"
APPTAINER_VERSION = "1.5.3"

# Use a fixed host environment to prevent APPTAINER_BIND, Python, FreeSurfer,
# and module-system variables from adding undeclared behavior or mounts.
CLEAN_HOST_ENV_PREFIX = (
    "env",
    "-i",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG=C",
)

_DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
_HEX_DIGEST = re.compile(r"^[a-f0-9]{64}$")
_MANIFEST_SCHEMA_VERSION = 1
_MAX_MANIFEST_BYTES = 64 * 1024
_MAX_RESOURCE_METADATA_BYTES = 16 * 1024
_MAX_CURRENT_BYTES = 65
_DEFAULT_COPY_CHUNK_BYTES = 1024 * 1024
#: Leave a staging directory alone until an in-flight copy cannot explain it.
_STAGING_ORPHAN_AGE_SECONDS = 24 * 60 * 60
_DEFAULT_RESERVE_BYTES = 512 * 1024 * 1024


class ManagedResourceError(OSError):
    """Report a managed scientific resource failure safely."""


class ManagedResourceCancelled(ManagedResourceError):
    """Report cancellation before managed-resource activation."""


@dataclass(frozen=True)
class FastSurferVariant:
    """Represent one reviewed FastSurfer OCI variant.

    Parameters
    ----------
    name
        Provide the stable Supraspina variant name, ``cpu`` or ``cuda``.
    platform
        Provide the reviewed OCI platform. Use FastSurfer only on Linux or WSL.
    image
        Provide the Docker Hub image repository without a mutable tag.
    reviewed_tag
        Provide the human-readable upstream tag used during review.
    oci_manifest_digest
        Provide the immutable linux/amd64 manifest digest.
    """

    name: str
    platform: str
    image: str
    reviewed_tag: str
    oci_manifest_digest: str

    @property
    def oci_reference(self) -> str:
        """Return the immutable Docker/OCI URI consumed by Apptainer."""
        return f"docker://{self.image}@{self.oci_manifest_digest}"


FASTSURFER_VARIANTS: Mapping[str, FastSurferVariant] = MappingProxyType(
    {
        "cpu": FastSurferVariant(
            name="cpu",
            platform="linux/amd64",
            image="docker.io/deepmi/fastsurfer",
            reviewed_tag=f"cpu-v{FASTSURFER_VERSION}",
            oci_manifest_digest=(
                "sha256:"
                "de0e93135b54d636316e3f9601b702662794e003365cec07a58b0f613888a5fa"
            ),
        ),
        "cuda": FastSurferVariant(
            name="cuda",
            platform="linux/amd64",
            image="docker.io/deepmi/fastsurfer",
            reviewed_tag=f"cuda-v{FASTSURFER_VERSION}",
            oci_manifest_digest=(
                "sha256:"
                "283d5db0972743aef92a093705a26f0c9d7a2512d782f0f97dd859357a4588a0"
            ),
        ),
    }
)


@dataclass(frozen=True)
class SynthStripSpec:
    """Represent the reviewed CPU SynthStrip OCI resource."""

    variant: str
    platform: str
    image: str
    reviewed_tag: str
    oci_manifest_digest: str

    @property
    def oci_reference(self) -> str:
        """Return the immutable Docker/OCI URI consumed by Apptainer."""
        return f"docker://{self.image}@{self.oci_manifest_digest}"


SYNTHSTRIP_SPEC = SynthStripSpec(
    variant="cpu",
    platform="linux/amd64",
    image="docker.io/freesurfer/synthstrip",
    reviewed_tag=SYNTHSTRIP_VERSION,
    oci_manifest_digest=(
        "sha256:ebbc177221194371f16362513ace68312a22922bb581bdfa618ac7ff9c1d2c06"
    ),
)


@dataclass(frozen=True)
class SifReleasePin:
    """Represent the release identity for one reproducibly generated SIF.

    Parameters
    ----------
    variant
        Provide the ``cpu`` or ``cuda`` FastSurfer variant.
    size_bytes
        Provide the exact generated SIF byte count.
    sha256
        Provide the exact generated SIF SHA-256.
    oci_manifest_digest
        Provide the reviewed OCI source manifest digest.
    apptainer_version
        Provide the Apptainer release used for the reproducible conversion.

    Raises
    ------
    ValueError
        Raise when any identity differs from Supraspina's reviewed FastSurfer release.
    """

    variant: str
    size_bytes: int
    sha256: str
    oci_manifest_digest: str
    apptainer_version: str

    def __post_init__(self) -> None:
        """Validate the complete release identity after initialization."""
        try:
            reviewed = FASTSURFER_VARIANTS[self.variant]
        except KeyError as exc:
            raise ValueError("Select a known FastSurfer variant.") from exc
        if self.size_bytes <= 0:
            raise ValueError("Keep the SIF size positive.")
        if _HEX_DIGEST.fullmatch(self.sha256) is None:
            raise ValueError("Provide a valid SIF SHA-256.")
        if (
            _DIGEST.fullmatch(self.oci_manifest_digest) is None
            or self.oci_manifest_digest != reviewed.oci_manifest_digest
        ):
            raise ValueError("Match the SIF OCI manifest to the reviewed variant.")
        if self.apptainer_version != APPTAINER_VERSION:
            raise ValueError("Match the SIF Apptainer version to the reviewed release.")


@dataclass(frozen=True)
class SynthStripReleasePin:
    """Represent the release identity for the reviewed CPU SynthStrip SIF."""

    size_bytes: int
    sha256: str
    oci_manifest_digest: str
    apptainer_version: str
    variant: str = "cpu"

    def __post_init__(self) -> None:
        """Validate the complete release identity after initialization."""
        if self.variant != SYNTHSTRIP_SPEC.variant:
            raise ValueError("Select a known SynthStrip variant.")
        if self.size_bytes <= 0:
            raise ValueError("Keep the SIF size positive.")
        if _HEX_DIGEST.fullmatch(self.sha256) is None:
            raise ValueError("Provide a valid SIF SHA-256.")
        if (
            _DIGEST.fullmatch(self.oci_manifest_digest) is None
            or self.oci_manifest_digest != SYNTHSTRIP_SPEC.oci_manifest_digest
        ):
            raise ValueError("Match the SIF OCI manifest to reviewed SynthStrip.")
        if self.apptainer_version != APPTAINER_VERSION:
            raise ValueError("Match the SIF Apptainer version to the reviewed release.")


FASTSURFER_RELEASE_PINS: Mapping[str, SifReleasePin] = MappingProxyType(
    {
        "cpu": SifReleasePin(
            variant="cpu",
            size_bytes=1_839_824_896,
            sha256=("cf2a31fb46477b3b51d854a4ecfcc88cad27a246bc887de459620dcb0de038af"),
            oci_manifest_digest=FASTSURFER_VARIANTS["cpu"].oci_manifest_digest,
            apptainer_version=APPTAINER_VERSION,
        ),
        "cuda": SifReleasePin(
            variant="cuda",
            size_bytes=5_520_121_856,
            sha256=("4ec60d2ecc0dec6f826f6cf693a057bd8fc80b2ac159309ad2ca2fa73f7ef1fc"),
            oci_manifest_digest=FASTSURFER_VARIANTS["cuda"].oci_manifest_digest,
            apptainer_version=APPTAINER_VERSION,
        ),
    }
)

SYNTHSTRIP_RELEASE_PIN = SynthStripReleasePin(
    size_bytes=382_562_304,
    sha256="f7faaccded4806780dc27172cd09bdaeffb48164c40edb3996fbec6a4829bfca",
    oci_manifest_digest=SYNTHSTRIP_SPEC.oci_manifest_digest,
    apptainer_version=APPTAINER_VERSION,
)

ReleasePin = SifReleasePin | SynthStripReleasePin


ProgressCallback = Callable[[int, int], None]
CancellationCheck = Callable[[], bool]


def build_fastsurfer_pull_command(
    variant: FastSurferVariant,
    destination: Path,
    *,
    apptainer_executable: str = "apptainer",
) -> list[str]:
    """Build an immutable, reproducible FastSurfer SIF pull command.

    Parameters
    ----------
    variant
        Provide the reviewed CPU or CUDA OCI variant.
    destination
        Provide the new staging SIF path. Activate it separately after
        verification.
    apptainer_executable
        Provide the Apptainer executable name or absolute path.

    Returns
    -------
    list of str
        Return clean-host-environment ``apptainer pull`` argv pinned by digest.
    """
    if variant.name not in FASTSURFER_VARIANTS:
        raise ValueError("Select a known FastSurfer variant.")
    if FASTSURFER_VARIANTS[variant.name] != variant:
        raise ValueError("Match the FastSurfer variant to the reviewed pin.")
    target = str(destination)
    if not target or "\x00" in target:
        raise ValueError("Provide a valid SIF staging destination.")
    return [
        *CLEAN_HOST_ENV_PREFIX,
        apptainer_executable,
        "pull",
        "--reproducible",
        "--disable-cache",
        "--arch",
        "amd64",
        target,
        variant.oci_reference,
    ]


def build_synthstrip_pull_command(
    destination: Path,
    *,
    apptainer_executable: str = "apptainer",
) -> list[str]:
    """Build the immutable, reproducible CPU SynthStrip SIF pull command."""
    target = str(destination)
    if not target or "\x00" in target:
        raise ValueError("Provide a valid SIF staging destination.")
    return [
        *CLEAN_HOST_ENV_PREFIX,
        apptainer_executable,
        "pull",
        "--reproducible",
        "--disable-cache",
        "--arch",
        "amd64",
        target,
        SYNTHSTRIP_SPEC.oci_reference,
    ]


# Remember the digest of a verified SIF against its filesystem identity, so
# planning does not re-hash a multi-hundred-megabyte image for every subject
# and every plan. Any change in device, inode, size, or mtime misses.
_VERIFIED_SIF_LOCK = threading.Lock()
_VERIFIED_SIF: dict[tuple[str, int, int, int, int, str], dict[str, Any]] = {}
_MAX_VERIFIED_SIF = 16


def verify_sif(path: Path, pin: ReleasePin) -> dict[str, Any]:
    """Verify one SIF against its exact release-preparation identity.

    Hash the file once per unchanged filesystem identity in this process;
    a later call with the same device, inode, size, and mtime reuses that
    digest instead of reading the image again.

    Parameters
    ----------
    path
        Provide the candidate SIF. Exclude symlinks and non-regular files.
    pin
        Provide the exact size, SHA-256, OCI source, and Apptainer release
        identity.

    Returns
    -------
    dict
        Return the bounded ``sizeBytes`` and ``sha256`` identity.

    Raises
    ------
    ManagedResourceError
        Raise when the file is absent, unsafe, partial, or tampered.
    """
    try:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise ManagedResourceError("Provide the SIF as a stable regular file.")
        if info.st_size != pin.size_bytes:
            raise ManagedResourceError("Match the SIF size to the release pin.")
        key = (
            str(path),
            info.st_dev,
            info.st_ino,
            info.st_size,
            info.st_mtime_ns,
            pin.sha256,
        )
        with _VERIFIED_SIF_LOCK:
            cached = _VERIFIED_SIF.get(key)
        if cached is not None:
            return dict(cached)
        digest, size = sha256_bounded_regular(path, pin.size_bytes)
    except BoundedReadError as exc:
        raise ManagedResourceError(
            "Provide the SIF as a stable bounded regular file."
        ) from exc
    except ManagedResourceError:
        raise
    except OSError as exc:
        raise ManagedResourceError("Provide a readable SIF.") from exc
    if size != pin.size_bytes:
        raise ManagedResourceError("Match the SIF size to the release pin.")
    if digest != pin.sha256:
        raise ManagedResourceError("Match the SIF SHA-256 to the release pin.")
    identity = {"sizeBytes": size, "sha256": digest}
    with _VERIFIED_SIF_LOCK:
        if len(_VERIFIED_SIF) >= _MAX_VERIFIED_SIF:
            _VERIFIED_SIF.clear()
        _VERIFIED_SIF[key] = dict(identity)
    return identity


def _managed_resource_root(
    user_data: Path,
    resource: str,
    version: str,
    variant: str,
) -> Path:
    return user_data / "scientific-resources" / resource / f"v{version}" / variant


def _resource_root(user_data: Path, variant: str) -> Path:
    if variant not in FASTSURFER_VARIANTS:
        raise ValueError("Select a known FastSurfer variant.")
    return _managed_resource_root(
        user_data,
        "fastsurfer",
        FASTSURFER_VERSION,
        variant,
    )


def _synthstrip_resource_root(user_data: Path, variant: str) -> Path:
    if variant != SYNTHSTRIP_SPEC.variant:
        raise ValueError("Select a known SynthStrip variant.")
    return _managed_resource_root(
        user_data,
        "synthstrip",
        SYNTHSTRIP_VERSION,
        variant,
    )


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _safe_directory(path: Path) -> None:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        try:
            path.mkdir(parents=True, mode=0o700)
        except FileExistsError:
            pass  # A concurrent creation is validated below like any entry.
        except OSError as exc:
            raise ManagedResourceError(
                "Make the machine-local scientific-resource destination writable."
            ) from exc
        info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ManagedResourceError("Provide the managed-resource path as a directory.")


def _discard_orphaned_staging(generations: Path) -> None:
    """Remove staging directories abandoned by an interrupted import.

    A crash between the staging copy and its promotion leaves a directory
    holding a full image. Sweep those before staging another one, so the leak
    cannot accumulate across launches. Skip recently written directories,
    which may belong to an import running in another process right now.
    """
    stale_before = time.time() - _STAGING_ORPHAN_AGE_SECONDS
    try:
        entries = list(os.scandir(generations))
    except OSError:
        return
    for entry in entries:
        if not entry.name.startswith((".tmp-", ".discard-")):
            continue
        try:
            if not entry.is_dir(follow_symlinks=False):
                continue
            if entry.stat(follow_symlinks=False).st_mtime > stale_before:
                continue
        except OSError:
            continue
        shutil.rmtree(entry.path, ignore_errors=True)


def _promote_generation(  # noqa: PLR0913
    temporary: Path,
    final_generation: Path,
    generations: Path,
    pin: ReleasePin,
    *,
    expected_metadata: dict[str, Any],
    sif_filename: str,
) -> None:
    """Publish one staged generation, replacing an invalid predecessor.

    ``os.replace`` refuses a nonempty destination directory, so an interrupted
    or corrupted generation would otherwise block every later import. Quarantine
    the proven app-owned invalid generation, retry the promotion, and restore the
    quarantined bytes when the retry still fails.
    """
    quarantine: Path | None = None
    try:
        os.replace(temporary, final_generation)
    except OSError:
        if _generation_valid(
            final_generation,
            pin,
            expected_metadata=expected_metadata,
            sif_filename=sif_filename,
        ):
            # Another process won the same import. Discard this staging copy;
            # the promotion path never runs its cleanup, and the copy is the
            # size of the whole image.
            shutil.rmtree(temporary, ignore_errors=True)
        else:
            quarantine = _quarantine_invalid_generation(generations, final_generation)
            try:
                os.replace(temporary, final_generation)
            except OSError:
                if quarantine is not None:
                    os.rename(quarantine, final_generation)
                raise
    _fsync_directory(generations)
    if quarantine is not None:
        shutil.rmtree(quarantine, ignore_errors=True)
        _fsync_directory(generations)


def _quarantine_invalid_generation(generations: Path, generation: Path) -> Path | None:
    """Move one proven app-owned invalid generation aside before replacement.

    ``os.replace`` refuses a nonempty destination directory, so an interrupted
    or corrupted generation would otherwise block every later import with
    ``ENOTEMPTY``. Rename it inside the same managed directory instead of
    deleting it, so a failed replacement can restore the previous bytes.

    Refuse anything this module did not create: a symlink, a non-directory, a
    name outside the reviewed generation scheme, or an entry whose parent is not
    the managed generations directory.
    """
    try:
        info = os.lstat(generation)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ManagedResourceError(
            "Resolve the existing managed resource generation before reprovisioning."
        ) from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ManagedResourceError(
            "Remove the unexpected managed resource generation entry manually."
        )
    if (
        generation.parent != generations
        or _HEX_DIGEST.fullmatch(generation.name) is None
    ):
        raise ManagedResourceError(
            "Keep managed resource generations inside their reviewed root."
        )
    quarantine = generations / f".discard-{generation.name}-{uuid.uuid4().hex}"
    os.rename(generation, quarantine)
    return quarantine


def _metadata(pin: SifReleasePin) -> dict[str, Any]:
    reviewed = FASTSURFER_VARIANTS[pin.variant]
    return {
        "schemaVersion": _MANIFEST_SCHEMA_VERSION,
        "resource": "fastsurfer",
        "fastsurferVersion": FASTSURFER_VERSION,
        "variant": pin.variant,
        "platform": reviewed.platform,
        "reviewedTag": reviewed.reviewed_tag,
        "ociManifestDigest": pin.oci_manifest_digest,
        "sifBytes": pin.size_bytes,
        "sifSha256": pin.sha256,
        "apptainerVersion": pin.apptainer_version,
    }


def _synthstrip_metadata(pin: SynthStripReleasePin) -> dict[str, Any]:
    return {
        "schemaVersion": _MANIFEST_SCHEMA_VERSION,
        "resource": "synthstrip",
        "synthstripVersion": SYNTHSTRIP_VERSION,
        "variant": pin.variant,
        "platform": SYNTHSTRIP_SPEC.platform,
        "reviewedTag": SYNTHSTRIP_SPEC.reviewed_tag,
        "ociManifestDigest": pin.oci_manifest_digest,
        "sifBytes": pin.size_bytes,
        "sifSha256": pin.sha256,
        "apptainerVersion": pin.apptainer_version,
    }


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        + "\n"
    ).encode("utf-8")


def _write_fsynced(path: Path, content: bytes, *, mode: int = 0o600) -> None:
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_CLOEXEC", 0)
    )
    fd = os.open(path, flags, mode)
    try:
        view = memoryview(content)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _read_bounded_json(path: Path, maximum_bytes: int) -> dict[str, Any]:
    try:
        info = os.lstat(path)
        if (
            stat.S_ISLNK(info.st_mode)
            or not stat.S_ISREG(info.st_mode)
            or info.st_size > maximum_bytes
        ):
            raise ManagedResourceError("Provide safe managed-resource metadata.")
        value = json.loads(read_bounded_regular(path, maximum_bytes))
    except ManagedResourceError:
        raise
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise ManagedResourceError(
            "Provide readable managed-resource metadata."
        ) from exc
    if not isinstance(value, dict):
        raise ManagedResourceError("Provide valid managed-resource metadata.")
    return value


def _current_generation(root: Path) -> str | None:
    marker = root / "CURRENT"
    try:
        info = os.lstat(marker)
        if (
            stat.S_ISLNK(info.st_mode)
            or not stat.S_ISREG(info.st_mode)
            or info.st_size > _MAX_CURRENT_BYTES
        ):
            return None
        value = read_bounded_regular(marker, _MAX_CURRENT_BYTES).decode("ascii").strip()
    except (OSError, UnicodeError):
        return None
    return value if _HEX_DIGEST.fullmatch(value) else None


def _generation_valid(
    generation: Path,
    pin: ReleasePin,
    *,
    expected_metadata: dict[str, Any],
    sif_filename: str,
) -> bool:
    if generation.name != pin.sha256:
        return False
    try:
        info = os.lstat(generation)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            return False
        metadata = _read_bounded_json(
            generation / "RESOURCE.json", _MAX_RESOURCE_METADATA_BYTES
        )
        if metadata != expected_metadata:
            return False
        verify_sif(generation / sif_filename, pin)
    except (OSError, ValueError, ManagedResourceError):
        return False
    return True


def _active_sif(
    root: Path,
    pin: ReleasePin,
    *,
    expected_metadata: dict[str, Any],
    sif_filename: str,
) -> Path | None:
    current = _current_generation(root)
    if current != pin.sha256:
        return None
    generation = root / "generations" / current
    if not _generation_valid(
        generation,
        pin,
        expected_metadata=expected_metadata,
        sif_filename=sif_filename,
    ):
        return None
    return generation / sif_filename


def active_fastsurfer_sif(user_data: Path, pin: SifReleasePin) -> Path | None:
    """Return the active exact SIF, or ``None`` for missing/invalid state.

    Parameters
    ----------
    user_data
        Provide Electron ``app.getPath("userData")`` from the caller.
    pin
        Provide the release-preparation SIF identity for the selected variant.

    Returns
    -------
    pathlib.Path or None
        Return the verified active SIF path.
    """
    return _active_sif(
        _resource_root(user_data, pin.variant),
        pin,
        expected_metadata=_metadata(pin),
        sif_filename="fastsurfer.sif",
    )


def active_synthstrip_sif(
    user_data: Path,
    pin: SynthStripReleasePin = SYNTHSTRIP_RELEASE_PIN,
) -> Path | None:
    """Return the active exact CPU SynthStrip SIF, or ``None``."""
    return _active_sif(
        _synthstrip_resource_root(user_data, pin.variant),
        pin,
        expected_metadata=_synthstrip_metadata(pin),
        sif_filename="synthstrip.sif",
    )


def _ensure_disk_space(path: Path, payload_bytes: int, reserve_bytes: int) -> None:
    try:
        available = shutil.disk_usage(path).free
    except OSError as exc:
        raise ManagedResourceError(
            "Provide a checkable disk-space destination."
        ) from exc
    if available < payload_bytes + reserve_bytes:
        raise ManagedResourceError(
            "Free enough disk space for the scientific resource."
        )


def _copy_verified(  # noqa: PLR0912, PLR0913
    source: Path,
    destination: Path,
    pin: ReleasePin,
    *,
    progress: ProgressCallback | None,
    cancelled: CancellationCheck | None,
    chunk_bytes: int,
) -> None:
    if chunk_bytes <= 0:
        raise ValueError("Keep the copy chunk size positive.")
    source_flags = (
        os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
    )
    if hasattr(os, "O_NOFOLLOW"):
        source_flags |= os.O_NOFOLLOW
    destination_flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_CLOEXEC", 0)
    )
    try:
        source_fd = os.open(source, source_flags)
    except OSError as exc:
        raise ManagedResourceError("Provide an openable SIF import source.") from exc
    destination_fd: int | None = None
    copied = 0
    digest = hashlib.sha256()
    try:
        source_info = os.fstat(source_fd)
        if (
            not stat.S_ISREG(source_info.st_mode)
            or source_info.st_size != pin.size_bytes
        ):
            raise ManagedResourceError("Keep the SIF import-source size stable.")
        destination_fd = os.open(destination, destination_flags, 0o600)
        while True:
            if cancelled is not None and cancelled():
                raise ManagedResourceCancelled(
                    "Retry the scientific resource import after cancellation."
                )
            chunk = os.read(source_fd, min(chunk_bytes, pin.size_bytes + 1 - copied))
            if not chunk:
                break
            if copied + len(chunk) > pin.size_bytes:
                raise ManagedResourceError(
                    "Keep the SIF import source within its pinned size while copying."
                )
            view = memoryview(chunk)
            while view:
                written = os.write(destination_fd, view)
                view = view[written:]
            digest.update(chunk)
            copied += len(chunk)
            if progress is not None:
                progress(copied, pin.size_bytes)
        if copied != pin.size_bytes:
            raise ManagedResourceError("Provide the complete SIF import source.")
        finished_source_info = os.fstat(source_fd)
        source_snapshot = (
            source_info.st_dev,
            source_info.st_ino,
            stat.S_IFMT(source_info.st_mode),
            source_info.st_size,
            source_info.st_mtime_ns,
            source_info.st_ctime_ns,
        )
        finished_source_snapshot = (
            finished_source_info.st_dev,
            finished_source_info.st_ino,
            stat.S_IFMT(finished_source_info.st_mode),
            finished_source_info.st_size,
            finished_source_info.st_mtime_ns,
            finished_source_info.st_ctime_ns,
        )
        if source_snapshot != finished_source_snapshot:
            raise ManagedResourceError(
                "Keep the SIF import source stable while copying."
            )
        if digest.hexdigest() != pin.sha256:
            raise ManagedResourceError("Keep the SIF import-source SHA-256 stable.")
        os.fsync(destination_fd)
    finally:
        if destination_fd is not None:
            os.close(destination_fd)
        os.close(source_fd)


def _publish_current_marker(root: Path, sha256: str, resource_label: str) -> None:
    """Point the resource's CURRENT marker at one verified generation."""
    marker_tmp = root / f".CURRENT.tmp-{uuid.uuid4().hex}"
    try:
        _write_fsynced(marker_tmp, f"{sha256}\n".encode("ascii"))
        os.replace(marker_tmp, root / "CURRENT")
        _fsync_directory(root)
    except OSError as exc:
        try:
            marker_tmp.unlink()
        except OSError:
            pass
        raise ManagedResourceError(f"Commit the {resource_label} activation.") from exc


def _import_managed_sif(  # noqa: PLR0913
    source: Path,
    root: Path,
    pin: ReleasePin,
    *,
    expected_metadata: dict[str, Any],
    sif_filename: str,
    resource_label: str,
    progress: ProgressCallback | None = None,
    cancelled: CancellationCheck | None = None,
    reserve_bytes: int = _DEFAULT_RESERVE_BYTES,
    chunk_bytes: int = _DEFAULT_COPY_CHUNK_BYTES,
) -> Path:
    if reserve_bytes < 0:
        raise ValueError("Keep the disk reserve non-negative.")
    verify_sif(source, pin)
    _safe_directory(root)
    generations = root / "generations"
    _safe_directory(generations)
    _discard_orphaned_staging(generations)
    _ensure_disk_space(root, pin.size_bytes, reserve_bytes)

    final_generation = generations / pin.sha256
    if not _generation_valid(
        final_generation,
        pin,
        expected_metadata=expected_metadata,
        sif_filename=sif_filename,
    ):
        temporary = generations / f".tmp-{pin.sha256}-{uuid.uuid4().hex}"
        temporary.mkdir(mode=0o700)
        try:
            _copy_verified(
                source,
                temporary / sif_filename,
                pin,
                progress=progress,
                cancelled=cancelled,
                chunk_bytes=chunk_bytes,
            )
            verify_sif(temporary / sif_filename, pin)
            metadata = _json_bytes(expected_metadata)
            if len(metadata) > _MAX_RESOURCE_METADATA_BYTES:
                raise ManagedResourceError(
                    "Keep managed-resource metadata within its size bound."
                )
            _write_fsynced(temporary / "RESOURCE.json", metadata)
            _fsync_directory(temporary)
            _promote_generation(
                temporary,
                final_generation,
                generations,
                pin,
                expected_metadata=expected_metadata,
                sif_filename=sif_filename,
            )
        except Exception:
            try:
                shutil.rmtree(temporary)
            except OSError:
                pass
            raise
    elif progress is not None:
        progress(pin.size_bytes, pin.size_bytes)

    if not _generation_valid(
        final_generation,
        pin,
        expected_metadata=expected_metadata,
        sif_filename=sif_filename,
    ):
        raise ManagedResourceError(f"Verify the generated {resource_label} resource.")
    _publish_current_marker(root, pin.sha256, resource_label)
    active = _active_sif(
        root,
        pin,
        expected_metadata=expected_metadata,
        sif_filename=sif_filename,
    )
    if active is None:
        raise ManagedResourceError(f"Verify the activated {resource_label} resource.")
    return active


def import_fastsurfer_sif(  # noqa: PLR0913
    source: Path,
    user_data: Path,
    pin: SifReleasePin,
    *,
    progress: ProgressCallback | None = None,
    cancelled: CancellationCheck | None = None,
    reserve_bytes: int = _DEFAULT_RESERVE_BYTES,
    chunk_bytes: int = _DEFAULT_COPY_CHUNK_BYTES,
) -> Path:
    """Verify and atomically activate an online-built or offline FastSurfer SIF.

    Preserve the existing ``CURRENT`` generation until the new SIF and metadata
    are fully copied, fsynced, reverified, and published.
    """
    return _import_managed_sif(
        source,
        _resource_root(user_data, pin.variant),
        pin,
        expected_metadata=_metadata(pin),
        sif_filename="fastsurfer.sif",
        resource_label="FastSurfer",
        progress=progress,
        cancelled=cancelled,
        reserve_bytes=reserve_bytes,
        chunk_bytes=chunk_bytes,
    )


def import_synthstrip_sif(  # noqa: PLR0913
    source: Path,
    user_data: Path,
    pin: SynthStripReleasePin = SYNTHSTRIP_RELEASE_PIN,
    *,
    progress: ProgressCallback | None = None,
    cancelled: CancellationCheck | None = None,
    reserve_bytes: int = _DEFAULT_RESERVE_BYTES,
    chunk_bytes: int = _DEFAULT_COPY_CHUNK_BYTES,
) -> Path:
    """Verify and atomically activate an online-built or offline SynthStrip SIF."""
    return _import_managed_sif(
        source,
        _synthstrip_resource_root(user_data, pin.variant),
        pin,
        expected_metadata=_synthstrip_metadata(pin),
        sif_filename="synthstrip.sif",
        resource_label="SynthStrip",
        progress=progress,
        cancelled=cancelled,
        reserve_bytes=reserve_bytes,
        chunk_bytes=chunk_bytes,
    )


def _load_bounded_manifest(path: Path, label: str) -> dict[str, Any]:
    try:
        info = os.lstat(path)
        if (
            stat.S_ISLNK(info.st_mode)
            or not stat.S_ISREG(info.st_mode)
            or info.st_size > _MAX_MANIFEST_BYTES
        ):
            raise ManagedResourceError(f"Keep the {label} pin manifest bounded.")
        value = json.loads(read_bounded_regular(path, _MAX_MANIFEST_BYTES))
    except ManagedResourceError:
        raise
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise ManagedResourceError(f"Provide a readable {label} pin manifest.") from exc
    if not isinstance(value, dict):
        raise ManagedResourceError(f"Provide a valid {label} pin manifest.")
    return value


def load_fastsurfer_release_manifest(path: Path) -> dict[str, SifReleasePin]:
    """Load a bounded release-preparation SIF pin manifest.

    Parameters
    ----------
    path
        Provide the JSON manifest committed during release preparation.

    Returns
    -------
    dict
        Return the exact ``cpu`` and ``cuda`` release pins.

    Raises
    ------
    ManagedResourceError
        Raise when the manifest is absent, oversized, malformed, or incomplete.
    """
    value = _load_bounded_manifest(path, "FastSurfer")
    if (
        value.get("schemaVersion") != _MANIFEST_SCHEMA_VERSION
        or value.get("fastsurferVersion") != FASTSURFER_VERSION
        or value.get("apptainerVersion") != APPTAINER_VERSION
    ):
        raise ManagedResourceError("Use a supported FastSurfer pin-manifest release.")
    variants = value.get("variants")
    if not isinstance(variants, dict) or set(variants) != set(FASTSURFER_VARIANTS):
        raise ManagedResourceError(
            "Include every FastSurfer variant in the pin manifest."
        )
    try:
        pins = {
            variant: SifReleasePin(
                variant=variant,
                size_bytes=int(record["sifBytes"]),
                sha256=str(record["sifSha256"]),
                oci_manifest_digest=str(record["ociManifestDigest"]),
                apptainer_version=APPTAINER_VERSION,
            )
            for variant, record in variants.items()
            if isinstance(record, dict)
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise ManagedResourceError(
            "Provide valid FastSurfer pin-manifest entries."
        ) from exc
    if set(pins) != set(FASTSURFER_VARIANTS):
        raise ManagedResourceError("Provide valid FastSurfer pin-manifest entries.")
    return pins


def load_scientific_resource_manifest(
    path: Path,
) -> dict[str, dict[str, ReleasePin]]:
    """Load the committed, bounded release pins for all managed SIFs."""
    value = _load_bounded_manifest(path, "scientific resource")
    if (
        value.get("schemaVersion") != _MANIFEST_SCHEMA_VERSION
        or value.get("apptainerVersion") != APPTAINER_VERSION
    ):
        raise ManagedResourceError("Use a supported scientific-resource pin release.")
    resources = value.get("resources")
    if not isinstance(resources, dict) or set(resources) != {
        "fastsurfer",
        "synthstrip",
    }:
        raise ManagedResourceError("Include every scientific-resource pin.")
    fastsurfer = resources.get("fastsurfer")
    synthstrip = resources.get("synthstrip")
    if (
        not isinstance(fastsurfer, dict)
        or fastsurfer.get("version") != FASTSURFER_VERSION
        or not isinstance(synthstrip, dict)
        or synthstrip.get("version") != SYNTHSTRIP_VERSION
    ):
        raise ManagedResourceError("Use supported scientific-resource pin versions.")
    fastsurfer_variants = fastsurfer.get("variants")
    synthstrip_variants = synthstrip.get("variants")
    if (
        not isinstance(fastsurfer_variants, dict)
        or set(fastsurfer_variants) != set(FASTSURFER_VARIANTS)
        or not isinstance(synthstrip_variants, dict)
        or set(synthstrip_variants) != {"cpu"}
    ):
        raise ManagedResourceError("Include every scientific-resource pin variant.")
    try:
        fastsurfer_pins: dict[str, ReleasePin] = {
            variant: SifReleasePin(
                variant=variant,
                size_bytes=int(record["sifBytes"]),
                sha256=str(record["sifSha256"]),
                oci_manifest_digest=str(record["ociManifestDigest"]),
                apptainer_version=APPTAINER_VERSION,
            )
            for variant, record in fastsurfer_variants.items()
            if isinstance(record, dict)
        }
        synthstrip_record = synthstrip_variants["cpu"]
        if not isinstance(synthstrip_record, dict):
            raise TypeError
        synthstrip_pin = SynthStripReleasePin(
            size_bytes=int(synthstrip_record["sifBytes"]),
            sha256=str(synthstrip_record["sifSha256"]),
            oci_manifest_digest=str(synthstrip_record["ociManifestDigest"]),
            apptainer_version=APPTAINER_VERSION,
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ManagedResourceError(
            "Provide valid scientific-resource pin entries."
        ) from exc
    if set(fastsurfer_pins) != set(FASTSURFER_VARIANTS):
        raise ManagedResourceError("Provide valid scientific-resource pin entries.")
    return {
        "fastsurfer": fastsurfer_pins,
        "synthstrip": {"cpu": synthstrip_pin},
    }


def _resource_status(
    root: Path,
    active: Path | None,
    *,
    variant: str,
    version: str,
) -> dict[str, Any]:
    if active is not None:
        state = "ready"
        path: str | None = str(active)
    elif not root.exists():
        state = "missing"
        path = None
    else:
        current = _current_generation(root)
        marker_missing = current is None and not (root / "CURRENT").exists()
        state = "missing" if marker_missing else "invalid"
        path = None
    return {
        "state": state,
        "path": path,
        "variant": variant,
        "version": version,
    }


def fastsurfer_resource_status(user_data: Path, pin: SifReleasePin) -> dict[str, Any]:
    """Return a bounded status for one managed FastSurfer variant.

    Parameters
    ----------
    user_data
        Provide Electron ``app.getPath("userData")`` from the caller.
    pin
        Provide the selected release-preparation SIF identity.

    Returns
    -------
    dict
        Return ``missing``, ``ready``, or ``invalid`` status without a source
        URL or operator-selected offline path.
    """
    return _resource_status(
        _resource_root(user_data, pin.variant),
        active_fastsurfer_sif(user_data, pin),
        variant=pin.variant,
        version=FASTSURFER_VERSION,
    )


def synthstrip_resource_status(
    user_data: Path,
    pin: SynthStripReleasePin = SYNTHSTRIP_RELEASE_PIN,
) -> dict[str, Any]:
    """Return a bounded status for the managed CPU SynthStrip resource."""
    return _resource_status(
        _synthstrip_resource_root(user_data, pin.variant),
        active_synthstrip_sif(user_data, pin),
        variant=pin.variant,
        version=SYNTHSTRIP_VERSION,
    )
