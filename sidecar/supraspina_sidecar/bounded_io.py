"""Bounded, identity-stable snapshot reads of regular files."""

from __future__ import annotations

import hashlib
import os
import stat
from collections.abc import Callable
from pathlib import Path

_DEFAULT_CHUNK_BYTES = 1024 * 1024


class BoundedReadError(OSError):
    """Reject an unsafe, oversized, or concurrently changed file read."""


def _snapshot(info: os.stat_result) -> tuple[int, int, int, int, int, int]:
    """Return metadata fields that must remain stable throughout a read."""
    return (
        info.st_dev,
        info.st_ino,
        stat.S_IFMT(info.st_mode),
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def _stream_regular(
    path: str | os.PathLike[str],
    maximum_bytes: int,
    consume: Callable[[bytes], None],
    *,
    chunk_bytes: int = _DEFAULT_CHUNK_BYTES,
) -> int:
    """Stream one stable regular file through ``consume`` within a byte limit."""
    if maximum_bytes < 0 or chunk_bytes <= 0:
        raise ValueError("Use non-negative bounds and a positive chunk size.")
    candidate = Path(path)
    before = candidate.lstat()
    if (
        stat.S_ISLNK(before.st_mode)
        or not stat.S_ISREG(before.st_mode)
        or before.st_size > maximum_bytes
    ):
        raise BoundedReadError("Read only a bounded regular file.")

    flags = (
        os.O_RDONLY
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    descriptor = os.open(candidate, flags)
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
            or opened.st_size > maximum_bytes
        ):
            raise BoundedReadError("Keep the regular file stable while opening it.")

        total = 0
        remaining = maximum_bytes + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(chunk_bytes, remaining))
            if not chunk:
                break
            total += len(chunk)
            remaining -= len(chunk)
            if total > maximum_bytes:
                raise BoundedReadError("Reduce the file to the configured byte limit.")
            consume(chunk)

        finished = os.fstat(descriptor)
        if _snapshot(opened) != _snapshot(finished) or total != finished.st_size:
            raise BoundedReadError("Keep the regular file unchanged while reading it.")
        return total
    finally:
        os.close(descriptor)


def read_bounded_regular(
    path: str | os.PathLike[str],
    maximum_bytes: int,
    *,
    chunk_bytes: int = _DEFAULT_CHUNK_BYTES,
) -> bytes:
    """Return one stable regular file without reading beyond ``maximum_bytes + 1``."""
    payload = bytearray()
    _stream_regular(path, maximum_bytes, payload.extend, chunk_bytes=chunk_bytes)
    return bytes(payload)


def read_regular_prefix(
    path: str | os.PathLike[str],
    maximum_bytes: int,
    *,
    chunk_bytes: int = _DEFAULT_CHUNK_BYTES,
) -> tuple[bytes, int, bool]:
    """Return a stable regular-file prefix, source size, and truncation flag."""
    if maximum_bytes < 0 or chunk_bytes <= 0:
        raise ValueError("Use a non-negative bound and a positive chunk size.")
    candidate = Path(path)
    before = candidate.lstat()
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise BoundedReadError("Read only a regular file.")

    flags = (
        os.O_RDONLY
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    descriptor = os.open(candidate, flags)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or (before.st_dev, before.st_ino) != (
            opened.st_dev,
            opened.st_ino,
        ):
            raise BoundedReadError("Keep the regular file stable while opening it.")

        payload = bytearray()
        remaining = maximum_bytes + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(chunk_bytes, remaining))
            if not chunk:
                break
            payload.extend(chunk)
            remaining -= len(chunk)

        finished = os.fstat(descriptor)
        if _snapshot(opened) != _snapshot(finished):
            raise BoundedReadError("Keep the regular file unchanged while reading it.")
        if opened.st_size <= maximum_bytes and len(payload) != opened.st_size:
            raise BoundedReadError("Read the complete regular-file snapshot.")
        if opened.st_size > maximum_bytes and len(payload) != maximum_bytes + 1:
            raise BoundedReadError("Read through the configured prefix boundary.")
        return (
            bytes(payload[:maximum_bytes]),
            opened.st_size,
            (opened.st_size > maximum_bytes),
        )
    finally:
        os.close(descriptor)


def sha256_bounded_regular(
    path: str | os.PathLike[str],
    maximum_bytes: int,
    *,
    chunk_bytes: int = _DEFAULT_CHUNK_BYTES,
) -> tuple[str, int]:
    """Return the SHA-256 and size of one stable bounded regular file."""
    digest = hashlib.sha256()
    size = _stream_regular(path, maximum_bytes, digest.update, chunk_bytes=chunk_bytes)
    return digest.hexdigest(), size
