"""Tests for managed FastSurfer SIF pinning and atomic activation."""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import scientific_resources
from supraspina_sidecar.scientific_resources import (
    APPTAINER_VERSION,
    FASTSURFER_RELEASE_PINS,
    FASTSURFER_VARIANTS,
    FASTSURFER_VERSION,
    SYNTHSTRIP_RELEASE_PIN,
    SYNTHSTRIP_SPEC,
    SYNTHSTRIP_VERSION,
    ManagedResourceCancelled,
    ManagedResourceError,
    SifReleasePin,
    SynthStripReleasePin,
)


def _pin(content: bytes, variant: str = "cpu") -> SifReleasePin:
    spec = FASTSURFER_VARIANTS[variant]
    return SifReleasePin(
        variant=variant,
        size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
        oci_manifest_digest=spec.oci_manifest_digest,
        apptainer_version=APPTAINER_VERSION,
    )


def _synthstrip_pin(content: bytes) -> SynthStripReleasePin:
    return SynthStripReleasePin(
        size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
        oci_manifest_digest=SYNTHSTRIP_SPEC.oci_manifest_digest,
        apptainer_version=APPTAINER_VERSION,
    )


def test_fastsurfer_variants_pin_reviewed_254_amd64_manifests() -> None:
    assert FASTSURFER_VERSION == "2.5.4"
    assert FASTSURFER_VARIANTS["cpu"].oci_manifest_digest == (
        "sha256:de0e93135b54d636316e3f9601b702662794e003365cec07a58b0f613888a5fa"
    )
    assert FASTSURFER_VARIANTS["cuda"].oci_manifest_digest == (
        "sha256:283d5db0972743aef92a093705a26f0c9d7a2512d782f0f97dd859357a4588a0"
    )
    assert FASTSURFER_VARIANTS["cpu"].platform == "linux/amd64"
    assert FASTSURFER_VARIANTS["cuda"].platform == "linux/amd64"


def test_release_preparation_pins_exact_generated_fastsurfer_sifs() -> None:
    assert FASTSURFER_RELEASE_PINS["cpu"].size_bytes == 1_839_824_896
    assert FASTSURFER_RELEASE_PINS["cpu"].sha256 == (
        "cf2a31fb46477b3b51d854a4ecfcc88cad27a246bc887de459620dcb0de038af"
    )
    assert FASTSURFER_RELEASE_PINS["cuda"].size_bytes == 5_520_121_856
    assert FASTSURFER_RELEASE_PINS["cuda"].sha256 == (
        "4ec60d2ecc0dec6f826f6cf693a057bd8fc80b2ac159309ad2ca2fa73f7ef1fc"
    )


@pytest.mark.parametrize("variant", ["cpu", "cuda"])
def test_pull_command_uses_digest_reproducible_build_and_clean_host_env(
    tmp_path: Path, variant: str
) -> None:
    destination = tmp_path / f"{variant}.sif"

    argv = scientific_resources.build_fastsurfer_pull_command(
        FASTSURFER_VARIANTS[variant], destination
    )

    assert argv[:4] == [
        "env",
        "-i",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C",
    ]
    assert argv[4:8] == ["apptainer", "pull", "--reproducible", "--disable-cache"]
    assert "--arch" in argv
    assert argv[argv.index("--arch") + 1] == "amd64"
    assert argv[-2] == str(destination)
    assert argv[-1].endswith(f"@{FASTSURFER_VARIANTS[variant].oci_manifest_digest}")
    assert ":cpu-v2.5.4" not in argv[-1]
    assert ":cuda-v2.5.4" not in argv[-1]


def test_synthstrip_pin_and_pull_command_use_reviewed_cpu_18_manifest() -> None:
    assert SYNTHSTRIP_VERSION == "1.8"
    assert SYNTHSTRIP_SPEC.platform == "linux/amd64"
    assert SYNTHSTRIP_SPEC.oci_manifest_digest == (
        "sha256:ebbc177221194371f16362513ace68312a22922bb581bdfa618ac7ff9c1d2c06"
    )
    assert SYNTHSTRIP_RELEASE_PIN.size_bytes == 382_562_304
    assert SYNTHSTRIP_RELEASE_PIN.sha256 == (
        "f7faaccded4806780dc27172cd09bdaeffb48164c40edb3996fbec6a4829bfca"
    )

    destination = Path("/staging/synthstrip-1.8.sif")
    argv = scientific_resources.build_synthstrip_pull_command(destination)

    assert argv[:4] == [
        "env",
        "-i",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C",
    ]
    assert argv[4:8] == ["apptainer", "pull", "--reproducible", "--disable-cache"]
    assert argv[argv.index("--arch") + 1] == "amd64"
    assert argv[-2] == str(destination)
    assert argv[-1] == (
        "docker://docker.io/freesurfer/synthstrip@"
        f"{SYNTHSTRIP_SPEC.oci_manifest_digest}"
    )


def test_release_pin_rejects_wrong_source_manifest_or_tool_version() -> None:
    content = b"synthetic-sif"
    spec = FASTSURFER_VARIANTS["cpu"]

    with pytest.raises(ValueError, match="OCI manifest"):
        SifReleasePin(
            variant="cpu",
            size_bytes=len(content),
            sha256=hashlib.sha256(content).hexdigest(),
            oci_manifest_digest="sha256:" + "0" * 64,
            apptainer_version=APPTAINER_VERSION,
        )
    with pytest.raises(ValueError, match="Apptainer"):
        SifReleasePin(
            variant="cpu",
            size_bytes=len(content),
            sha256=hashlib.sha256(content).hexdigest(),
            oci_manifest_digest=spec.oci_manifest_digest,
            apptainer_version="1.4.0",
        )


def test_verify_sif_checks_regular_file_size_and_sha256(tmp_path: Path) -> None:
    source = tmp_path / "fastsurfer.sif"
    content = b"synthetic-sif-content"
    source.write_bytes(content)
    pin = _pin(content)

    identity = scientific_resources.verify_sif(source, pin)

    assert identity == {
        "sizeBytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }

    source.write_bytes(content + b"-tampered")
    with pytest.raises(ManagedResourceError, match="size"):
        scientific_resources.verify_sif(source, pin)


def test_verify_sif_hashes_an_unchanged_file_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "synthstrip.sif"
    content = b"synthetic-sif-content"
    source.write_bytes(content)
    pin = _pin(content)
    calls = 0
    original = scientific_resources.sha256_bounded_regular

    def counted(path: Any, maximum: int, **kwargs: Any) -> tuple[str, int]:
        nonlocal calls
        calls += 1
        return original(path, maximum, **kwargs)

    monkeypatch.setattr(scientific_resources, "sha256_bounded_regular", counted)

    first = scientific_resources.verify_sif(source, pin)
    second = scientific_resources.verify_sif(source, pin)

    assert first == second
    assert calls == 1

    source.write_bytes(content[::-1])
    os.utime(source, ns=(1, 1))
    with pytest.raises(ManagedResourceError, match="SHA-256"):
        scientific_resources.verify_sif(source, pin)
    assert calls == 2


def test_verify_sif_rejects_symlink_even_when_target_bytes_match(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.sif"
    link = tmp_path / "link.sif"
    content = b"synthetic-sif-content"
    source.write_bytes(content)
    link.symlink_to(source)

    with pytest.raises(ManagedResourceError, match="regular file"):
        scientific_resources.verify_sif(link, _pin(content))


def test_copy_verified_rejects_limit_plus_one_growth(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.sif"
    destination = tmp_path / "destination.sif"
    content = b"bounded"
    source.write_bytes(content)
    original_read = os.read
    grew = False

    def growing_read(descriptor: int, count: int) -> bytes:
        nonlocal grew
        chunk = original_read(descriptor, count)
        if chunk and not grew:
            grew = True
            with source.open("ab") as handle:
                handle.write(b"!")
        return chunk

    monkeypatch.setattr(os, "read", growing_read)

    with pytest.raises(ManagedResourceError, match="pinned size while copying"):
        scientific_resources._copy_verified(
            source,
            destination,
            _pin(content),
            progress=None,
            cancelled=None,
            chunk_bytes=2,
        )


def test_offline_import_atomically_activates_exact_verified_generation(
    tmp_path: Path,
) -> None:
    content = b"synthetic-sif-content" * 128
    source = tmp_path / "offline.sif"
    source.write_bytes(content)
    pin = _pin(content)
    progress: list[tuple[int, int]] = []

    active = scientific_resources.import_fastsurfer_sif(
        source,
        tmp_path / "user-data",
        pin,
        progress=lambda copied, total: progress.append((copied, total)),
        reserve_bytes=0,
    )

    assert active.read_bytes() == content
    assert active.name == "fastsurfer.sif"
    assert active.parent.name == pin.sha256
    assert (
        scientific_resources.active_fastsurfer_sif(tmp_path / "user-data", pin)
        == active
    )
    assert progress[-1] == (len(content), len(content))

    metadata = json.loads((active.parent / "RESOURCE.json").read_text(encoding="utf-8"))
    assert metadata["fastsurferVersion"] == FASTSURFER_VERSION
    assert metadata["variant"] == "cpu"
    assert metadata["ociManifestDigest"] == pin.oci_manifest_digest
    assert metadata["sifSha256"] == pin.sha256
    assert metadata["sifBytes"] == pin.size_bytes
    assert metadata["apptainerVersion"] == APPTAINER_VERSION


def test_losing_the_promotion_race_discards_the_staging_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    content = b"synthetic-sif-content" * 64
    source = tmp_path / "offline.sif"
    source.write_bytes(content)
    pin = _pin(content)
    user_data = tmp_path / "user-data"
    winner = scientific_resources.import_fastsurfer_sif(
        source, user_data, pin, reserve_bytes=0
    )
    generations = winner.parent.parent

    real_replace = os.replace

    def refuse_generation_replace(source_path: Any, destination: Any) -> None:
        if os.path.basename(str(destination)) == pin.sha256:
            raise OSError("Model another process winning the same promotion.")
        real_replace(source_path, destination)

    monkeypatch.setattr(scientific_resources.os, "replace", refuse_generation_replace)
    # Force a fresh staging copy by invalidating the generation check once.
    valid = scientific_resources._generation_valid
    calls = {"count": 0}

    def first_check_fails(*args: object, **kwargs: object) -> bool:
        calls["count"] += 1
        if calls["count"] == 1:
            return False
        return valid(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(scientific_resources, "_generation_valid", first_check_fails)

    scientific_resources.import_fastsurfer_sif(source, user_data, pin, reserve_bytes=0)

    assert [entry.name for entry in generations.iterdir()] == [pin.sha256]


def test_import_sweeps_a_staging_directory_abandoned_by_an_earlier_crash(
    tmp_path: Path,
) -> None:
    content = b"synthetic-sif-content"
    source = tmp_path / "offline.sif"
    source.write_bytes(content)
    pin = _pin(content)
    user_data = tmp_path / "user-data"
    generations = (
        scientific_resources._resource_root(user_data, pin.variant) / "generations"
    )
    orphan = generations / f".tmp-{pin.sha256}-abandoned"
    orphan.mkdir(parents=True, mode=0o700)
    (orphan / "fastsurfer.sif").write_bytes(content)
    recent = generations / f".tmp-{pin.sha256}-inflight"
    recent.mkdir(mode=0o700)
    stale = time.time() - 2 * scientific_resources._STAGING_ORPHAN_AGE_SECONDS
    os.utime(orphan, (stale, stale))

    scientific_resources.import_fastsurfer_sif(source, user_data, pin, reserve_bytes=0)

    assert not orphan.exists()
    # Leave a directory a concurrent import may still be writing.
    assert recent.is_dir()


def test_tampered_active_generation_fails_closed(tmp_path: Path) -> None:
    content = b"synthetic-sif-content"
    source = tmp_path / "offline.sif"
    source.write_bytes(content)
    pin = _pin(content)
    active = scientific_resources.import_fastsurfer_sif(
        source, tmp_path / "user-data", pin, reserve_bytes=0
    )
    active.write_bytes(b"tampered")

    assert (
        scientific_resources.active_fastsurfer_sif(tmp_path / "user-data", pin) is None
    )


def test_cancelled_import_preserves_prior_active_generation(tmp_path: Path) -> None:
    user_data = tmp_path / "user-data"
    original = b"original-sif"
    original_source = tmp_path / "original.sif"
    original_source.write_bytes(original)
    original_pin = _pin(original)
    original_active = scientific_resources.import_fastsurfer_sif(
        original_source, user_data, original_pin, reserve_bytes=0
    )

    replacement = b"replacement-sif" * 1024
    replacement_source = tmp_path / "replacement.sif"
    replacement_source.write_bytes(replacement)
    replacement_pin = _pin(replacement)
    cancelled = False

    def progress(copied: int, _total: int) -> None:
        nonlocal cancelled
        if copied:
            cancelled = True

    with pytest.raises(ManagedResourceCancelled):
        scientific_resources.import_fastsurfer_sif(
            replacement_source,
            user_data,
            replacement_pin,
            progress=progress,
            cancelled=lambda: cancelled,
            reserve_bytes=0,
            chunk_bytes=1024,
        )

    assert (
        scientific_resources.active_fastsurfer_sif(user_data, original_pin)
        == original_active
    )
    assert original_active.read_bytes() == original


def test_import_rejects_insufficient_free_space_before_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    content = b"synthetic-sif-content"
    source = tmp_path / "offline.sif"
    source.write_bytes(content)

    class _Usage:
        free = len(content) - 1

    monkeypatch.setattr(
        scientific_resources.shutil,
        "disk_usage",
        lambda _path: _Usage(),
    )

    with pytest.raises(ManagedResourceError, match="disk space"):
        scientific_resources.import_fastsurfer_sif(
            source,
            tmp_path / "user-data",
            _pin(content),
            reserve_bytes=0,
        )


def test_release_manifest_loader_is_bounded_and_validates_both_variants(
    tmp_path: Path,
) -> None:
    cpu = _pin(b"cpu")
    cuda = _pin(b"cuda", "cuda")
    manifest = tmp_path / "fastsurfer-sif-pins.json"
    manifest.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "fastsurferVersion": FASTSURFER_VERSION,
                "apptainerVersion": APPTAINER_VERSION,
                "variants": {
                    "cpu": {
                        "ociManifestDigest": cpu.oci_manifest_digest,
                        "sifBytes": cpu.size_bytes,
                        "sifSha256": cpu.sha256,
                    },
                    "cuda": {
                        "ociManifestDigest": cuda.oci_manifest_digest,
                        "sifBytes": cuda.size_bytes,
                        "sifSha256": cuda.sha256,
                    },
                },
            }
        ),
        encoding="utf-8",
    )

    loaded = scientific_resources.load_fastsurfer_release_manifest(manifest)

    assert loaded == {"cpu": cpu, "cuda": cuda}

    manifest.write_bytes(b"{" + b"x" * (65 * 1024))
    with pytest.raises(ManagedResourceError, match="bounded"):
        scientific_resources.load_fastsurfer_release_manifest(manifest)


def test_status_distinguishes_missing_ready_and_invalid(tmp_path: Path) -> None:
    content = b"synthetic-sif"
    pin = _pin(content)
    user_data = tmp_path / "user-data"

    assert scientific_resources.fastsurfer_resource_status(user_data, pin) == {
        "state": "missing",
        "path": None,
        "variant": "cpu",
        "version": FASTSURFER_VERSION,
    }

    source = tmp_path / "source.sif"
    source.write_bytes(content)
    active = scientific_resources.import_fastsurfer_sif(
        source, user_data, pin, reserve_bytes=0
    )
    ready = scientific_resources.fastsurfer_resource_status(user_data, pin)
    assert ready["state"] == "ready"
    assert ready["path"] == str(active)

    active.write_bytes(b"tampered")
    invalid = scientific_resources.fastsurfer_resource_status(user_data, pin)
    assert invalid["state"] == "invalid"
    assert invalid["path"] is None


def test_synthstrip_offline_import_uses_identical_verifier_and_status(
    tmp_path: Path,
) -> None:
    content = b"synthetic-synthstrip-sif" * 128
    source = tmp_path / "synthstrip.sif"
    source.write_bytes(content)
    pin = _synthstrip_pin(content)
    user_data = tmp_path / "user-data"

    assert scientific_resources.synthstrip_resource_status(user_data, pin) == {
        "state": "missing",
        "path": None,
        "variant": "cpu",
        "version": SYNTHSTRIP_VERSION,
    }

    active = scientific_resources.import_synthstrip_sif(
        source,
        user_data,
        pin,
        reserve_bytes=0,
    )

    assert active.name == "synthstrip.sif"
    assert scientific_resources.active_synthstrip_sif(user_data, pin) == active
    metadata = json.loads((active.parent / "RESOURCE.json").read_text("utf-8"))
    assert metadata["resource"] == "synthstrip"
    assert metadata["synthstripVersion"] == SYNTHSTRIP_VERSION
    assert metadata["variant"] == "cpu"
    assert metadata["ociManifestDigest"] == SYNTHSTRIP_SPEC.oci_manifest_digest

    active.write_bytes(b"tampered")
    invalid = scientific_resources.synthstrip_resource_status(user_data, pin)
    assert invalid["state"] == "invalid"
    assert invalid["path"] is None


def test_committed_resource_manifest_matches_embedded_release_pins() -> None:
    manifest = Path(__file__).resolve().parents[2] / "SCIENTIFIC_RESOURCE_PINS.json"

    loaded = scientific_resources.load_scientific_resource_manifest(manifest)

    assert loaded["fastsurfer"] == FASTSURFER_RELEASE_PINS
    assert loaded["synthstrip"] == {"cpu": SYNTHSTRIP_RELEASE_PIN}


def _generations(user_data: Path, pin: SifReleasePin) -> Path:
    return scientific_resources._resource_root(user_data, pin.variant) / "generations"


def test_invalid_nonempty_generation_is_quarantined_and_reprovisioned(
    tmp_path: Path,
) -> None:
    """Replace a corrupted generation instead of failing with ENOTEMPTY."""
    content = b"synthetic-sif-content" * 8
    source = tmp_path / "offline.sif"
    source.write_bytes(content)
    pin = _pin(content)
    user_data = tmp_path / "user-data"
    scientific_resources.import_fastsurfer_sif(source, user_data, pin, reserve_bytes=0)
    generation = _generations(user_data, pin) / pin.sha256
    (generation / "fastsurfer.sif").write_bytes(b"truncated")
    (generation / "leftover.partial").write_bytes(b"stale")
    assert scientific_resources.active_fastsurfer_sif(user_data, pin) is None

    active = scientific_resources.import_fastsurfer_sif(
        source, user_data, pin, reserve_bytes=0
    )

    assert active.read_bytes() == content
    assert scientific_resources.active_fastsurfer_sif(user_data, pin) == active
    assert not (generation / "leftover.partial").exists()
    assert [
        entry.name
        for entry in _generations(user_data, pin).iterdir()
        if entry.name.startswith(".discard-")
    ] == []


def test_reprovisioning_refuses_a_symlinked_generation(tmp_path: Path) -> None:
    content = b"synthetic-sif-content" * 4
    source = tmp_path / "offline.sif"
    source.write_bytes(content)
    pin = _pin(content)
    user_data = tmp_path / "user-data"
    generations = _generations(user_data, pin)
    generations.mkdir(parents=True, mode=0o700)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "keep.txt").write_bytes(b"user data")
    (generations / pin.sha256).symlink_to(elsewhere, target_is_directory=True)

    with pytest.raises(ManagedResourceError, match="unexpected managed resource"):
        scientific_resources.import_fastsurfer_sif(
            source, user_data, pin, reserve_bytes=0
        )

    assert (elsewhere / "keep.txt").is_file()
    assert (generations / pin.sha256).is_symlink()


def test_reprovisioning_refuses_a_generation_that_is_not_a_directory(
    tmp_path: Path,
) -> None:
    content = b"synthetic-sif-content" * 2
    source = tmp_path / "offline.sif"
    source.write_bytes(content)
    pin = _pin(content)
    user_data = tmp_path / "user-data"
    generations = _generations(user_data, pin)
    generations.mkdir(parents=True, mode=0o700)
    (generations / pin.sha256).write_bytes(b"not a directory")

    with pytest.raises(ManagedResourceError, match="unexpected managed resource"):
        scientific_resources.import_fastsurfer_sif(
            source, user_data, pin, reserve_bytes=0
        )

    assert (generations / pin.sha256).read_bytes() == b"not a directory"


def test_quarantine_refuses_a_generation_outside_the_managed_root(
    tmp_path: Path,
) -> None:
    generations = tmp_path / "generations"
    generations.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()

    with pytest.raises(ManagedResourceError, match="reviewed root"):
        scientific_resources._quarantine_invalid_generation(generations, outside)

    assert outside.is_dir()


def test_quarantine_refuses_a_generation_named_outside_the_scheme(
    tmp_path: Path,
) -> None:
    generations = tmp_path / "generations"
    generations.mkdir()
    named = generations / "user-supplied"
    named.mkdir()

    with pytest.raises(ManagedResourceError, match="reviewed root"):
        scientific_resources._quarantine_invalid_generation(generations, named)

    assert named.is_dir()


def test_a_valid_current_generation_is_never_quarantined(tmp_path: Path) -> None:
    content = b"synthetic-sif-content" * 3
    source = tmp_path / "offline.sif"
    source.write_bytes(content)
    pin = _pin(content)
    user_data = tmp_path / "user-data"
    active = scientific_resources.import_fastsurfer_sif(
        source, user_data, pin, reserve_bytes=0
    )
    renames: list[tuple[str, str]] = []
    original = os.rename

    def record(src: Any, dst: Any) -> None:
        renames.append((str(src), str(dst)))
        original(src, dst)

    try:
        scientific_resources.os.rename = record  # type: ignore[assignment]
        again = scientific_resources.import_fastsurfer_sif(
            source, user_data, pin, reserve_bytes=0
        )
    finally:
        scientific_resources.os.rename = original  # type: ignore[assignment]

    assert again == active
    assert renames == []


def test_failed_replacement_restores_the_previous_generation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    content = b"synthetic-sif-content" * 6
    source = tmp_path / "offline.sif"
    source.write_bytes(content)
    pin = _pin(content)
    user_data = tmp_path / "user-data"
    scientific_resources.import_fastsurfer_sif(source, user_data, pin, reserve_bytes=0)
    generation = _generations(user_data, pin) / pin.sha256
    (generation / "fastsurfer.sif").write_bytes(b"truncated")
    preserved = sorted(entry.name for entry in generation.iterdir())

    def always_fail(_src: Any, _dst: Any) -> None:
        raise OSError("Refuse the fixture promotion.")

    monkeypatch.setattr(scientific_resources.os, "replace", always_fail)

    with pytest.raises(OSError, match="Refuse the fixture promotion"):
        scientific_resources.import_fastsurfer_sif(
            source, user_data, pin, reserve_bytes=0
        )

    assert generation.is_dir()
    assert sorted(entry.name for entry in generation.iterdir()) == preserved
    assert (generation / "fastsurfer.sif").read_bytes() == b"truncated"


def test_import_sweeps_an_abandoned_quarantine_directory(tmp_path: Path) -> None:
    content = b"synthetic-sif-content"
    source = tmp_path / "offline.sif"
    source.write_bytes(content)
    pin = _pin(content)
    user_data = tmp_path / "user-data"
    generations = _generations(user_data, pin)
    abandoned = generations / f".discard-{pin.sha256}-abandoned"
    abandoned.mkdir(parents=True, mode=0o700)
    (abandoned / "fastsurfer.sif").write_bytes(content)
    stale = time.time() - 2 * scientific_resources._STAGING_ORPHAN_AGE_SECONDS
    os.utime(abandoned, (stale, stale))

    scientific_resources.import_fastsurfer_sif(source, user_data, pin, reserve_bytes=0)

    assert not abandoned.exists()
