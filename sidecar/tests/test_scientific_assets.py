"""Tests for scientific-asset acquisition, integrity, and atomic activation."""

from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import tarfile
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import scientific_assets
from tests.acquired_assets import acquired_bytes


def _digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _git_blob(value: bytes) -> str:
    header = f"blob {len(value)}\0".encode()
    return hashlib.sha1(header + value, usedforsecurity=False).hexdigest()


def _inventory(
    *,
    local: bytes = b"first-party\n",
    acquired: bytes = b"upstream\n",
    acquired_sha: str | None = None,
    upstream_path: str = "upstream.txt",
    acquired_mode: str = "0600",
) -> dict[str, Any]:
    return {
        "resourceFiles": {
            "resources/local.txt": {
                "delivery": "bundled",
                "mode": "0600",
                "sha256": _digest(local),
                "provenance": {"classification": "fixture"},
            },
            "resources/acquired.txt": {
                "delivery": "checksum-pinned-user-acquisition",
                "mode": acquired_mode,
                "sha256": acquired_sha or _digest(acquired),
                "provenance": {
                    "classification": "byte-identical-upstream",
                    "upstreamPath": upstream_path,
                },
            },
            "resources/historical-readme.txt": {
                "delivery": "source-only-fidelity-reference",
                "mode": "0600",
                "sha256": _digest(b"historical guidance\n"),
                "provenance": {"classification": "fixture"},
            },
        }
    }


def _archive(
    path: Path,
    *,
    value: bytes = b"upstream\n",
    member_name: str = "fixture/upstream.txt",
    symlink: bool = False,
) -> tuple[str, int]:
    with tarfile.open(path, "w:gz") as archive:
        member = tarfile.TarInfo(member_name)
        if symlink:
            member.type = tarfile.SYMTYPE
            member.linkname = "elsewhere"
            archive.addfile(member)
        else:
            member.size = len(value)
            archive.addfile(member, io.BytesIO(value))
    content = path.read_bytes()
    return _digest(content), len(content)


def _activate(  # noqa: PLR0913
    tmp_path: Path,
    *,
    inventory: dict[str, Any] | None = None,
    archive_value: bytes = b"upstream\n",
    member_name: str = "fixture/upstream.txt",
    symlink: bool = False,
    expected_archive_sha: str | None = None,
) -> tuple[Path, Path]:
    bundled = tmp_path / "bundle"
    bundled.mkdir()
    (bundled / "local.txt").write_bytes(b"first-party\n")
    archive = tmp_path / "fixture.tar.gz"
    archive_sha, archive_size = _archive(
        archive,
        value=archive_value,
        member_name=member_name,
        symlink=symlink,
    )
    cache = tmp_path / "cache"
    root = scientific_assets._activate_archive(
        archive,
        bundled_root=bundled,
        inventory=inventory or _inventory(),
        cache_base=cache,
        expected_archive_sha256=expected_archive_sha or archive_sha,
        expected_archive_bytes=archive_size,
        archive_prefix="fixture",
    )
    return root, cache


def test_atomic_activation_verifies_bundled_and_acquired_files(
    tmp_path: Path,
) -> None:
    root, cache = _activate(tmp_path)

    assert (root / "local.txt").read_bytes() == b"first-party\n"
    assert (root / "acquired.txt").read_bytes() == b"upstream\n"
    assert not (root / "historical-readme.txt").exists()
    assert scientific_assets.active_resource_root(_inventory(), cache) == root
    metadata = json.loads(
        (root.parent / "SCIENTIFIC_ASSETS.json").read_text(encoding="utf-8")
    )
    assert metadata["archiveSha256"] == scientific_assets.ARCHIVE_SHA256
    assert metadata["fileCount"] == 3


@pytest.mark.skipif(
    os.name == "nt",
    reason="Run this test only where POSIX executable modes apply.",
)
def test_acquired_executable_is_private_and_runnable(tmp_path: Path) -> None:
    executable = b"#!/bin/sh\nexit 0\n"
    inventory = _inventory(
        acquired=executable,
        acquired_mode="0700",
    )
    root, _cache = _activate(
        tmp_path,
        inventory=inventory,
        archive_value=executable,
    )
    target = root / "acquired.txt"

    assert target.stat().st_mode & 0o777 == 0o700
    # Use the exact private synthetic executable fixture created above.
    subprocess.run([target], check=True, timeout=5)  # noqa: S603


def test_invalid_or_changed_file_mode_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(
        scientific_assets.ScientificAssetError,
        match="valid file mode",
    ):
        _activate(tmp_path, inventory=_inventory(acquired_mode="0755"))

    changed = tmp_path / "changed"
    changed.mkdir()
    root, cache = _activate(
        changed,
        inventory=_inventory(acquired_mode="0700"),
    )
    (root / "acquired.txt").chmod(0o600)
    assert (
        scientific_assets.active_resource_root(
            _inventory(acquired_mode="0700"),
            cache,
        )
        is None
    )


def test_archive_sha_mismatch_cannot_activate(tmp_path: Path) -> None:
    with pytest.raises(scientific_assets.ScientificAssetError, match="archive SHA-256"):
        _activate(tmp_path, expected_archive_sha="0" * 64)
    assert not (tmp_path / "cache" / "CURRENT").exists()


def test_selected_file_tamper_cannot_activate(tmp_path: Path) -> None:
    with pytest.raises(
        scientific_assets.ScientificAssetError,
        match="asset bytes to the reviewed SHA-256",
    ):
        _activate(tmp_path, archive_value=b"tampered\n")
    cache = tmp_path / "cache"
    assert not (cache / "CURRENT").exists()
    assert not any(
        path.name and not path.name.startswith(".")
        for path in (cache / "generations").iterdir()
    )


def test_symlink_member_is_rejected_without_extraction(tmp_path: Path) -> None:
    with pytest.raises(
        scientific_assets.ScientificAssetError,
        match="bounded regular file",
    ):
        _activate(tmp_path, symlink=True)
    assert not (tmp_path / "cache" / "CURRENT").exists()


def test_inventory_reader_rejects_limit_plus_one_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    inventory = tmp_path / "THIRD_PARTY_PROVENANCE.json"
    inventory.write_bytes(b"x" * 9)
    monkeypatch.setattr(scientific_assets, "_MAX_INVENTORY_BYTES", 8)

    with pytest.raises(
        scientific_assets.ScientificAssetError,
        match="safe scientific asset inventory",
    ):
        scientific_assets.load_inventory(inventory)


@pytest.mark.parametrize(
    "upstream_path",
    ["../escape", "/absolute", "directory\\escape", "directory/../escape"],
)
def test_unsafe_upstream_paths_are_rejected(tmp_path: Path, upstream_path: str) -> None:
    inventory = _inventory(upstream_path=upstream_path)
    with pytest.raises(
        scientific_assets.ScientificAssetError,
        match="safe scientific asset upstream path",
    ):
        _activate(
            tmp_path,
            inventory=inventory,
            member_name=f"fixture/{upstream_path}",
        )
    assert not (tmp_path / "cache" / "CURRENT").exists()


def test_corrupt_current_marker_and_generation_fail_closed(tmp_path: Path) -> None:
    root, cache = _activate(tmp_path)
    (cache / "CURRENT").write_text("../escape\n", encoding="ascii")
    assert scientific_assets.active_resource_root(_inventory(), cache) is None

    generation = root.parent
    (cache / "CURRENT").write_text(f"{generation.name}\n", encoding="ascii")
    (root / "acquired.txt").write_bytes(b"tampered\n")
    assert scientific_assets.active_resource_root(_inventory(), cache) is None


def test_resolution_scope_validates_each_generation_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, cache = _activate(tmp_path)
    monkeypatch.setattr(
        scientific_assets, "load_inventory", lambda _path=None: _inventory()
    )
    validated: list[str] = []
    original = scientific_assets.usable_generation

    def counted(generation: Path, inventory: Any = None) -> Path | None:
        validated.append(generation.name)
        return original(generation, inventory)

    monkeypatch.setattr(scientific_assets, "usable_generation", counted)
    generation = root.parent.name

    assert scientific_assets.active_resource_root(cache_base=cache) == root
    assert scientific_assets.active_resource_root(cache_base=cache) == root
    assert validated == [generation, generation]

    validated.clear()
    with scientific_assets.resolution_scope():
        for _ in range(5):
            assert scientific_assets.active_resource_root(cache_base=cache) == root
        with scientific_assets.resolution_scope():
            assert scientific_assets.active_resource_root(cache_base=cache) == root
        # A changed marker validates the generation it names.
        (cache / "CURRENT").write_text("f" * 32 + "\n", encoding="ascii")
        assert scientific_assets.active_resource_root(cache_base=cache) is None
        (cache / "CURRENT").write_text(f"{generation}\n", encoding="ascii")
        assert scientific_assets.active_resource_root(cache_base=cache) == root
        # An explicit inventory is always validated afresh.
        assert scientific_assets.active_resource_root(_inventory(), cache) == root
    assert validated == [generation, "f" * 32, generation]

    (root / "acquired.txt").write_bytes(b"tampered\n")
    assert scientific_assets.active_resource_root(cache_base=cache) is None


def test_revised_inventory_reuses_the_acquired_generation_offline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # An upgrade that revises a bundled file changes the inventory digest and
    # invalidates the active generation, although the pinned archive did not
    # change. The acquired bytes are already on disk, so no download happens.
    root, cache = _activate(tmp_path)
    previous_generation = root.parent
    bundled = tmp_path / "bundle"
    (bundled / "local.txt").write_bytes(b"first-party v2\n")
    revised = _inventory(local=b"first-party v2\n")
    assert scientific_assets.active_resource_root(revised, cache) is None

    def _no_download(destination: Path) -> None:
        raise AssertionError(f"Reuse the acquired generation instead of {destination}.")

    monkeypatch.setattr(scientific_assets, "_download", _no_download)
    active = scientific_assets._reuse_generation(
        bundled_root=bundled, inventory=revised, cache_base=cache
    )
    assert active is not None
    assert active.parent != previous_generation
    assert (active / "local.txt").read_bytes() == b"first-party v2\n"
    assert (active / "acquired.txt").read_bytes() == b"upstream\n"
    assert scientific_assets.active_resource_root(revised, cache) == active
    # The previous generation is left in place for its own inventory.
    assert scientific_assets.validate_generation(previous_generation, _inventory())

    # A revised acquired file cannot be served from the earlier generation.
    changed = _inventory(local=b"first-party v2\n", acquired=b"upstream v2\n")
    assert (
        scientific_assets._reuse_generation(
            bundled_root=bundled, inventory=changed, cache_base=cache
        )
        is None
    )


def test_offline_rebuild_availability_matches_the_reuse_without_writing(
    tmp_path: Path,
) -> None:
    # Diagnostics asks before offering the rebuild; the answer must match what
    # an acquisition would do and must leave the cache untouched.
    root, cache = _activate(tmp_path)
    bundled = tmp_path / "bundle"
    (bundled / "local.txt").write_bytes(b"first-party v2\n")
    revised = _inventory(local=b"first-party v2\n")

    def _snapshot() -> list[tuple[str, bytes]]:
        return sorted(
            (str(path.relative_to(cache)), path.read_bytes())
            for path in cache.rglob("*")
            if path.is_file()
        )

    before = _snapshot()
    assert scientific_assets.offline_rebuild_available(
        bundled_root=bundled, inventory=revised, cache_base=cache
    )
    assert _snapshot() == before
    assert scientific_assets.active_resource_root(revised, cache) is None

    # A revised acquired file or bundled file that differs from the inventory
    # needs the archive, so no offline rebuild is offered.
    changed = _inventory(local=b"first-party v2\n", acquired=b"upstream v2\n")
    assert not scientific_assets.offline_rebuild_available(
        bundled_root=bundled, inventory=changed, cache_base=cache
    )
    stale_bundle = _inventory(local=b"first-party v3\n")
    assert not scientific_assets.offline_rebuild_available(
        bundled_root=bundled, inventory=stale_bundle, cache_base=cache
    )
    # A tampered earlier generation is not trusted either.
    (root / "acquired.txt").chmod(0o600)
    (root / "acquired.txt").write_bytes(b"tampered\n")
    assert not scientific_assets.offline_rebuild_available(
        bundled_root=bundled, inventory=revised, cache_base=cache
    )
    # Without any earlier generation there is nothing to rebuild from.
    assert not scientific_assets.offline_rebuild_available(
        bundled_root=bundled, inventory=revised, cache_base=tmp_path / "empty"
    )


def _reverse_source_wrapper(value: bytes) -> bytes:
    value = value.replace(
        scientific_assets._SOURCE_PATH_HELPERS_REVIEWED,
        scientific_assets._SOURCE_PATH_HELPERS_UPSTREAM,
    )
    value = value.replace(
        b"\t--fs_version\tFreesurfer version (choose from 5, 6, 7, or 8)",
        b"\t--fs7\t\tFreesurfer v7 and above (e.g. --fs true or false)",
    )
    value = value.replace(b"\t--fs_version)", b"\t--fs7)")
    value = value.replace(scientific_assets._VERSION_NORMALIZATION, b"")
    value = value.replace(
        b'if [[ "${fs_version}" -ge 7 ]]', b'if [[ "${fs_version}" = true ]]'
    )
    value = value.replace(
        b'grep "Measure EstimatedTotalIntraCranialVol"',
        b"grep IntraCranialVol",
    )
    value = value.replace(
        b'\n        fs_path=$(convert_to_matlab_path "',
        b'\n        fs_path=$(wslpath -w "',
    )
    value = value.replace(
        b'\n        enigma_qc_path=$(convert_to_matlab_path "',
        b'\n        enigma_qc_path=$(wslpath -w "',
    )
    value = value.replace(
        b'\n        qc_path=$(convert_to_matlab_path "',
        b'\n        qc_path=$(wslpath -w "',
    )
    return value.replace(b"/mri/${nu_vol}", b"/mri/orig_nu.mgz")


def _reverse_compiled_wrapper(value: bytes) -> bytes:
    value = value.replace(
        b"\t--fs_version\tFreesurfer version (choose from 5, 6, 7, or 8)",
        b"\t--fs7\t\tFreesurfer v7 and above (e.g. --fs true or false)",
    )
    value = value.replace(b"\t--fs_version)", b"\t--fs7)")
    value = value.replace(scientific_assets._VERSION_NORMALIZATION, b"")
    value = value.replace(
        b'if [[ "${fs_version}" -ge 7 ]]', b'if [[ "${fs_version}" = true ]]'
    )
    value = value.replace(
        b'grep "Measure EstimatedTotalIntraCranialVol"',
        b"grep IntraCranialVol",
    )
    return value.replace(b"/mri/${nu_vol}", b"/mri/orig_nu.mgz")


@pytest.mark.parametrize(
    ("relative", "reverse", "adapt", "expected_sha"),
    [
        (
            "resources/enigma/enigma_fs_wrapper_script.sh",
            _reverse_source_wrapper,
            scientific_assets._adapt_source_wrapper,
            "5c175deecf46be4b74de03111efe39d996d1d0eee37a80635ac0e6f10c638837",
        ),
        (
            "resources/enigma/compiled/enigma_fs_wrapper_script_compiled.sh",
            _reverse_compiled_wrapper,
            scientific_assets._adapt_compiled_wrapper,
            "e2bd04f05a3d65988f82863a064101139a3b79bd3269cfcbcbcf834060afb60f",
        ),
    ],
)
def test_reviewed_wrapper_transform_is_exact(
    relative: str,
    reverse: Any,
    adapt: Any,
    expected_sha: str,
) -> None:
    # The acquired wrapper reverses to the pinned upstream blob, so the
    # transform maps the real upstream bytes to the reviewed ones offline.
    fixture = Path(__file__).parent / "fixtures" / "upstream-resource-blobs.json"
    upstream_blob = json.loads(fixture.read_text(encoding="utf-8"))[
        "wrapperAdaptations"
    ][relative]["upstreamBlob"]
    reviewed = acquired_bytes(relative)
    reconstructed_upstream = reverse(reviewed)

    assert _git_blob(reconstructed_upstream) == upstream_blob
    assert adapt(reconstructed_upstream) == reviewed
    assert _digest(reviewed) == expected_sha


def test_active_resource_root_rejects_a_non_ascii_current_marker(
    tmp_path: Path,
) -> None:
    cache = tmp_path / "assets"
    cache.mkdir()
    (cache / "CURRENT").write_bytes(b"\xff\n")

    assert scientific_assets.active_resource_root(_inventory(), cache) is None
