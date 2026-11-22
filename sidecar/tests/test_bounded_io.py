"""Tests for bounded and identity-stable regular-file reads."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from supraspina_sidecar.bounded_io import (
    BoundedReadError,
    read_bounded_regular,
    read_regular_prefix,
    sha256_bounded_regular,
)


def test_read_bounded_regular_returns_exact_payload(tmp_path: Path) -> None:
    path = tmp_path / "record.json"
    path.write_bytes(b"bounded")

    assert read_bounded_regular(path, 7, chunk_bytes=2) == b"bounded"


def test_read_bounded_regular_rejects_limit_plus_one(tmp_path: Path) -> None:
    path = tmp_path / "record.json"
    path.write_bytes(b"oversized")

    with pytest.raises(BoundedReadError, match="bounded regular file"):
        read_bounded_regular(path, len(b"oversized") - 1)


def test_read_bounded_regular_rejects_symlink(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.write_bytes(b"value")
    link = tmp_path / "link"
    link.symlink_to(target)

    with pytest.raises(BoundedReadError, match="bounded regular file"):
        read_bounded_regular(link, 16)


def test_read_bounded_regular_rejects_growth_during_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "growing"
    path.write_bytes(b"abc")
    original_read = os.read
    grew = False

    def growing_read(descriptor: int, count: int) -> bytes:
        nonlocal grew
        chunk = original_read(descriptor, count)
        if chunk and not grew:
            grew = True
            with path.open("ab") as handle:
                handle.write(b"d")
        return chunk

    monkeypatch.setattr(os, "read", growing_read)

    with pytest.raises(BoundedReadError, match="unchanged"):
        read_bounded_regular(path, 8, chunk_bytes=2)


def test_sha256_bounded_regular_streams_digest_and_size(tmp_path: Path) -> None:
    path = tmp_path / "asset"
    path.write_bytes(b"abc")

    digest, size = sha256_bounded_regular(path, 3, chunk_bytes=1)

    assert digest == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    assert size == 3


def test_read_regular_prefix_reports_a_limit_plus_one_source(tmp_path: Path) -> None:
    path = tmp_path / "log"
    path.write_bytes(b"abcdef")

    payload, source_bytes, truncated = read_regular_prefix(path, 5, chunk_bytes=2)

    assert payload == b"abcde"
    assert source_bytes == 6
    assert truncated is True
