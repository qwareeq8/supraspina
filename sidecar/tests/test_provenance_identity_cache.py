"""Tests for the opt-in file-identity cache used by inventory reads."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import provenance


def _write(path: Path, payload: bytes, *, mtime: int) -> None:
    path.write_bytes(payload)
    os.utime(path, (mtime, mtime))


def test_uncached_identity_always_rereads_the_file(tmp_path: Path) -> None:
    """Read a fresh fingerprint by default.

    Preserve deliberate repeated reads that prove a file did not change across
    a live operation.
    """
    target = tmp_path / "registry.json"
    _write(target, b"first", mtime=1_000)
    first = provenance.file_identity(str(target))

    # Detect changed bytes despite an unchanged filesystem identity.
    _write(target, b"secon", mtime=1_000)
    second = provenance.file_identity(str(target))

    assert first["sha256"] != second["sha256"]


def test_cached_identity_is_reused_only_while_the_file_is_unchanged(
    tmp_path: Path,
) -> None:
    target = tmp_path / "age.csv"
    _write(target, b"participant_id,age\n", mtime=2_000)
    provenance._IDENTITY_CACHE.clear()
    try:
        first = provenance.file_identity(str(target), cached=True)
        assert first["exists"] is True
        assert len(provenance._IDENTITY_CACHE) == 1

        again = provenance.file_identity(str(target), cached=True)
        assert again == first

        # Recompute the fingerprint after the size changes.
        _write(target, b"participant_id,age\nsub-01,42\n", mtime=2_000)
        grown = provenance.file_identity(str(target), cached=True)
        assert grown["sha256"] != first["sha256"]

        # Recompute the fingerprint after only the modification time changes.
        payload = target.read_bytes()
        _write(target, payload[:-4] + b"9\n\n", mtime=3_000)
        touched = provenance.file_identity(str(target), cached=True)
        assert touched["sha256"] != grown["sha256"]
    finally:
        provenance._IDENTITY_CACHE.clear()


def test_cached_identity_never_shares_mutable_state(tmp_path: Path) -> None:
    """Protect retained identities from caller mutation."""
    target = tmp_path / "metadata.csv"
    _write(target, b"participant_id\n", mtime=4_000)
    provenance._IDENTITY_CACHE.clear()
    try:
        first = provenance.file_identity(str(target), cached=True)
        first["sha256"] = "tampered"
        second = provenance.file_identity(str(target), cached=True)
        assert second["sha256"] != "tampered"
    finally:
        provenance._IDENTITY_CACHE.clear()


def test_cached_identity_holds_one_cohort_inventory(tmp_path: Path) -> None:
    """Retain more entries than one cohort's artifact inventory lists.

    A 65-subject project lists about 1400 artifacts; a smaller ceiling evicted
    every entry before the inventory sweep ended, so each Results open re-read
    every artifact's bytes.
    """
    assert provenance._MAX_CACHED_IDENTITIES >= 2000


def test_cached_identity_is_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(provenance, "_MAX_CACHED_IDENTITIES", 32)
    provenance._IDENTITY_CACHE.clear()
    try:
        for index in range(provenance._MAX_CACHED_IDENTITIES + 5):
            target = tmp_path / f"input-{index}.csv"
            _write(target, f"row-{index}\n".encode(), mtime=5_000 + index)
            provenance.file_identity(str(target), cached=True)
        assert len(provenance._IDENTITY_CACHE) == provenance._MAX_CACHED_IDENTITIES
    finally:
        provenance._IDENTITY_CACHE.clear()


def test_a_missing_file_is_never_retained(tmp_path: Path) -> None:
    provenance._IDENTITY_CACHE.clear()
    try:
        absent = tmp_path / "absent.csv"
        missing = provenance.file_identity(str(absent), cached=True)
        assert missing["exists"] is False
        assert "sha256" not in missing
        assert len(provenance._IDENTITY_CACHE) == 0

        _write(absent, b"now here\n", mtime=6_000)
        appeared = provenance.file_identity(str(absent), cached=True)
        assert appeared["exists"] is True
    finally:
        provenance._IDENTITY_CACHE.clear()


class _Adapter:
    """Resolve paths verbatim for the external-input fingerprint helper."""

    def resolve(self, template: str, _cfg: dict) -> str:
        return template

    def build_command(self, _cfg: dict, _subject_id: str | None) -> list[str]:
        return []


def _age_cfg(root: Path) -> dict:
    return {
        "paths": {
            "projectRoot": str(root),
            "ageMetadataFile": str(root / "ages.csv"),
        }
    }


def test_post_exit_external_inputs_bypass_the_pre_execution_cache(
    tmp_path: Path,
) -> None:
    """Detect a same-size, timestamp-restored mutation across an execution."""
    metadata = tmp_path / "ages.csv"
    _write(metadata, b"participant_id,age\nsub-01,42\n", mtime=4_000)
    cfg = _age_cfg(tmp_path)
    provenance._IDENTITY_CACHE.clear()
    try:
        launch = provenance._external_inputs("age", cfg, _Adapter(), cached=True)

        # Rewrite the same byte count and restore the modification time.
        _write(metadata, b"participant_id,age\nsub-01,43\n", mtime=4_000)

        cached = provenance._external_inputs("age", cfg, _Adapter(), cached=True)
        uncached = provenance._external_inputs("age", cfg, _Adapter(), cached=False)

        assert cached == launch
        assert uncached != launch
        assert uncached["ageMetadata"]["size"] == launch["ageMetadata"]["size"]
    finally:
        provenance._IDENTITY_CACHE.clear()


def test_post_exit_external_inputs_match_when_nothing_changed(tmp_path: Path) -> None:
    metadata = tmp_path / "ages.csv"
    _write(metadata, b"participant_id,age\nsub-01,42\n", mtime=5_000)
    cfg = _age_cfg(tmp_path)
    provenance._IDENTITY_CACHE.clear()
    try:
        launch = provenance._external_inputs("age", cfg, _Adapter(), cached=True)
        uncached = provenance._external_inputs("age", cfg, _Adapter(), cached=False)

        assert uncached == launch
    finally:
        provenance._IDENTITY_CACHE.clear()


def test_post_exit_external_inputs_detect_replacement_and_removal(
    tmp_path: Path,
) -> None:
    metadata = tmp_path / "ages.csv"
    _write(metadata, b"participant_id,age\nsub-01,42\n", mtime=6_000)
    cfg = _age_cfg(tmp_path)
    provenance._IDENTITY_CACHE.clear()
    try:
        launch = provenance._external_inputs("age", cfg, _Adapter(), cached=True)

        # Replace the inode while preserving the bytes and the timestamp.
        replacement = tmp_path / "ages-new.csv"
        _write(replacement, b"participant_id,age\nsub-01,42\n", mtime=6_000)
        replacement.replace(metadata)
        assert (
            provenance._external_inputs("age", cfg, _Adapter(), cached=False) == launch
        )

        # Substitute a symlink to different bytes.
        other = tmp_path / "other.csv"
        _write(other, b"participant_id,age\nsub-01,44\n", mtime=6_000)
        metadata.unlink()
        metadata.symlink_to(other)
        substituted = provenance._external_inputs("age", cfg, _Adapter(), cached=False)
        assert substituted["ageMetadata"]["sha256"] != launch["ageMetadata"]["sha256"]

        # Remove the input entirely.
        metadata.unlink()
        other.unlink()
        removed = provenance._external_inputs("age", cfg, _Adapter(), cached=False)
        assert removed["ageMetadata"] == {
            "exists": False,
            "path": str(metadata),
        }
    finally:
        provenance._IDENTITY_CACHE.clear()


def test_post_exit_external_inputs_report_an_unreadable_input(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    metadata = tmp_path / "ages.csv"
    _write(metadata, b"participant_id,age\nsub-01,42\n", mtime=7_000)
    cfg = _age_cfg(tmp_path)
    provenance._IDENTITY_CACHE.clear()
    try:
        launch = provenance._external_inputs("age", cfg, _Adapter(), cached=True)

        def refuse_read(*_args: Any, **_kwargs: Any) -> Any:
            raise PermissionError(str(metadata))

        # Refuse the read directly. Removing the file's permission bits proves
        # nothing when the tests run as root, because root reads the file
        # regardless of its mode.
        monkeypatch.setattr(provenance, "open", refuse_read, raising=False)
        unreadable = provenance._external_inputs("age", cfg, _Adapter(), cached=False)

        assert unreadable != launch
        assert unreadable["ageMetadata"]["exists"] is False
    finally:
        provenance._IDENTITY_CACHE.clear()
