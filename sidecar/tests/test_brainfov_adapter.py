"""Tests for Brain-FOV adapter commands, registration, and detection."""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import struct
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import resources, scientific_resources
from supraspina_sidecar.adapters import brainfov as adapter_module
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.adapters.brainfov import BrainFovAdapter
from supraspina_sidecar.brainfov import (
    BRAINFOV_HELPER_VERSION,
    SYNTHSTRIP_PROVIDER_IDENTITY,
    MaskSummary,
    VoxelBounds,
    build_brainfov_provenance,
    build_derivative_paths,
    build_preflight_signature,
    plan_brain_fov_crop,
    publish_derivative_set,
    read_nifti,
)


def _write_nifti(
    path: Path,
    *,
    shape: tuple[int, int, int],
) -> Path:
    header = bytearray(352)
    struct.pack_into("<i", header, 0, 348)
    struct.pack_into("<8h", header, 40, 3, *shape, 1, 1, 1, 1)
    struct.pack_into("<h", header, 70, 2)
    struct.pack_into("<h", header, 72, 8)
    struct.pack_into("<8f", header, 76, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0)
    struct.pack_into("<f", header, 108, 352.0)
    struct.pack_into("<h", header, 254, 1)
    struct.pack_into("<4f", header, 280, 1.0, 0.0, 0.0, -100.0)
    struct.pack_into("<4f", header, 296, 0.0, 1.0, 0.0, -90.0)
    struct.pack_into("<4f", header, 312, 0.0, 0.0, 1.0, -80.0)
    header[344:348] = b"n+1\x00"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(bytes(header) + b"\x00" * math.prod(shape), mtime=0))
    return path


def _cfg(
    tmp_path: Path,
    source: Path,
    helper: Path,
    sif: Path,
) -> dict[str, Any]:
    return {
        "paths": {
            "rawdataDir": str(tmp_path / "rawdata"),
            "derivativesDir": str(tmp_path / "derivatives"),
        },
        "runtime": {"threads": 6},
        "steps": {
            "brainfov": {
                "enabled": True,
                "params": {"marginMm": 30},
            }
        },
        "_supraspinaRuntime": {
            "t1BySubject": {"sub-0001": str(source)},
            "synthStripSifPath": str(sif),
            "apptainerExecutable": "/usr/bin/apptainer",
        },
        "_testHelper": str(helper),
    }


def _patch_helper_and_sif(
    monkeypatch: pytest.MonkeyPatch,
    helper: Path,
) -> list[tuple[Path, object]]:
    verified: list[tuple[Path, object]] = []
    monkeypatch.setattr(resources, "brainfov_helper_path", lambda: helper)
    monkeypatch.setattr(
        scientific_resources,
        "verify_sif",
        lambda path, pin: (
            verified.append((path, pin))
            or {"sizeBytes": path.stat().st_size, "sha256": "a" * 64}
        ),
    )
    return verified


def _helper_identity(helper: Path) -> dict[str, str]:
    return {
        "name": "supraspina-brainfov",
        "version": BRAINFOV_HELPER_VERSION,
        "sha256": hashlib.sha256(helper.read_bytes()).hexdigest(),
    }


def _publish_detectable_set(
    cfg: dict[str, Any],
    source_path: Path,
    helper: Path,
) -> None:
    source = read_nifti(source_path)
    pass_through = all(value <= 256.0 for value in source.fov_mm)
    runtime = (
        {"mode": "passThrough"}
        if pass_through
        else {
            "mode": "crop",
            "synthstripExecutable": "mri_synthstrip",
            "threads": 6,
        }
    )
    signature, payload = build_preflight_signature(
        source_path,
        source,
        margin_mm=30,
        provider=SYNTHSTRIP_PROVIDER_IDENTITY,
        helper=_helper_identity(helper),
        runtime=runtime,
    )
    paths = build_derivative_paths(
        Path(cfg["paths"]["derivativesDir"]),
        source_path,
        signature,
    )
    mask = None
    if pass_through:
        plan = plan_brain_fov_crop(source)
        artifacts = {"qc": b"qc"}
    else:
        mask = MaskSummary(
            bounds=VoxelBounds((70, 15, 15), (210, 45, 45)),
            nonzero_voxels=1,
            largest_component_voxels=1,
            component_count=1,
            dominant_fraction=1.0,
        )
        plan = plan_brain_fov_crop(source, mask)
        artifacts = {"t1": b"crop", "mask": b"mask", "qc": b"qc"}
    provenance = build_brainfov_provenance(
        signature=signature,
        signature_payload=payload,
        source=source,
        plan=plan,
        mask=mask,
        provider=SYNTHSTRIP_PROVIDER_IDENTITY,
        helper=_helper_identity(helper),
        nested_command=[],
        validation={"fixture": True},
    )
    publish_derivative_set(paths, artifacts, provenance)


def test_brainfov_adapter_is_registered_with_exact_parameter_contract() -> None:
    adapter = BrainFovAdapter()

    assert ADAPTERS["brainfov"].__class__ is BrainFovAdapter
    assert adapter.advances == ()
    assert adapter.param_schema() == {
        "marginMm": {
            "kind": "int",
            "default": 30,
            "min": 15,
            "max": 60,
            "label": "Brain FOV margin (mm)",
        }
    }


def test_build_command_uses_verified_sif_clean_containment_and_same_path_mounts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _write_nifti(
        tmp_path
        / "rawdata"
        / "sub-0001"
        / "ses-baseline"
        / "anat"
        / "sub-0001_ses-baseline_acq-prisma_T1w.nii.gz",
        shape=(176, 280, 288),
    )
    helper = tmp_path / "brainfov.py"
    helper.write_bytes(b"reviewed helper")
    sif = tmp_path / "synthstrip.sif"
    sif.write_bytes(b"verified SIF")
    verified = _patch_helper_and_sif(monkeypatch, helper)
    cfg = _cfg(tmp_path, source, helper, sif)

    argv = BrainFovAdapter().build_command(cfg, "sub-0001")

    assert verified == [(sif, scientific_resources.SYNTHSTRIP_RELEASE_PIN)]
    assert argv[:4] == [
        "env",
        "-i",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C",
    ]
    assert argv[4:7] == ["/usr/bin/apptainer", "exec", "--cleanenv"]
    assert "--containall" in argv
    assert "--no-home" in argv
    assert argv[argv.index("--no-mount") + 1] == "hostfs,cwd,home"
    assert argv[argv.index("--network") + 1] == "none"
    assert "--net" in argv
    assert "--nv" not in argv
    assert argv[argv.index("--cwd") + 1] == "/"
    mounts = [argv[index + 1] for index, value in enumerate(argv) if value == "--mount"]
    assert len(mounts) == 3
    assert any(
        f"src={source}" in mount and f"dst={source}" in mount for mount in mounts
    )
    derivatives = Path(cfg["paths"]["derivativesDir"])
    assert any(
        f"src={derivatives}" in mount
        and f"dst={derivatives}" in mount
        and not mount.endswith(",rw")
        for mount in mounts
    )
    assert all(",rw" not in mount for mount in mounts)
    assert any(
        f"src={helper}" in mount and f"dst={helper}" in mount and mount.endswith(",ro")
        for mount in mounts
    )
    sif_index = argv.index(str(sif))
    assert argv[sif_index + 1 : sif_index + 4] == [
        "python3",
        str(helper),
        "prepare",
    ]
    assert argv[argv.index("--input") + 1] == str(source)
    assert argv[argv.index("--derivatives-root") + 1] == str(derivatives)
    assert argv[argv.index("--margin-mm") + 1] == "30"
    assert argv[argv.index("--threads") + 1] == "6"
    assert json.loads(argv[argv.index("--provider-json") + 1]) == (
        SYNTHSTRIP_PROVIDER_IDENTITY
    )
    assert json.loads(argv[argv.index("--helper-json") + 1]) == (
        _helper_identity(helper)
    )


def test_build_command_can_resolve_active_sif_from_user_data(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _write_nifti(
        tmp_path / "rawdata" / "sub-0001" / "anat" / "sub-0001_T1w.nii.gz",
        shape=(64, 60, 56),
    )
    helper = tmp_path / "brainfov.py"
    helper.write_bytes(b"reviewed helper")
    sif = tmp_path / "active" / "synthstrip.sif"
    sif.parent.mkdir()
    sif.write_bytes(b"verified SIF")
    monkeypatch.setattr(resources, "brainfov_helper_path", lambda: helper)
    received: list[tuple[Path, object]] = []
    monkeypatch.setattr(
        scientific_resources,
        "active_synthstrip_sif",
        lambda root, pin: received.append((root, pin)) or sif,
    )
    cfg = _cfg(tmp_path, source, helper, sif)
    cfg["_supraspinaRuntime"].pop("synthStripSifPath")
    cfg["_supraspinaRuntime"]["userDataPath"] = str(tmp_path / "user-data")

    argv = BrainFovAdapter().build_command(cfg, "sub-0001")

    assert str(sif) in argv
    assert received == [
        (
            tmp_path / "user-data",
            scientific_resources.SYNTHSTRIP_RELEASE_PIN,
        )
    ]


def test_build_command_blocks_when_verified_sif_is_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _write_nifti(
        tmp_path / "rawdata" / "sub-0001" / "anat" / "sub-0001_T1w.nii.gz",
        shape=(64, 60, 56),
    )
    helper = tmp_path / "brainfov.py"
    helper.write_bytes(b"reviewed helper")
    cfg = _cfg(tmp_path, source, helper, tmp_path / "missing.sif")
    cfg["_supraspinaRuntime"].pop("synthStripSifPath")
    cfg["_supraspinaRuntime"]["userDataPath"] = str(tmp_path / "user-data")
    monkeypatch.setattr(resources, "brainfov_helper_path", lambda: helper)
    monkeypatch.setattr(
        scientific_resources,
        "active_synthstrip_sif",
        lambda _root, _pin: None,
    )

    with pytest.raises(ValueError, match=r"^Provision"):
        BrainFovAdapter().build_command(cfg, "sub-0001")


@pytest.mark.parametrize(
    ("shape", "expected_artifact_count"),
    [((64, 60, 56), 2), ((280, 60, 60), 4)],
)
def test_detector_verifies_pass_through_and_crop_publications(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    shape: tuple[int, int, int],
    expected_artifact_count: int,
) -> None:
    source = _write_nifti(
        tmp_path / "rawdata" / "sub-0001" / "anat" / "sub-0001_T1w.nii.gz",
        shape=shape,
    )
    helper = tmp_path / "brainfov.py"
    helper.write_bytes(b"reviewed helper")
    sif = tmp_path / "synthstrip.sif"
    cfg = _cfg(tmp_path, source, helper, sif)
    monkeypatch.setattr(resources, "brainfov_helper_path", lambda: helper)
    _publish_detectable_set(cfg, source, helper)

    status = BrainFovAdapter().detect(cfg, "sub-0001")

    assert status.state == "done"
    assert len(status.artifacts) == expected_artifact_count
    assert any(path.endswith(".json") for path in status.artifacts)
    assert any(path.endswith("_qc.png") for path in status.artifacts)


def test_preflight_signature_selects_the_current_immutable_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _write_nifti(
        tmp_path / "rawdata" / "sub-0001" / "anat" / "sub-0001_T1w.nii.gz",
        shape=(64, 60, 56),
    )
    helper = tmp_path / "brainfov.py"
    helper.write_bytes(b"reviewed helper")
    cfg = _cfg(tmp_path, source, helper, tmp_path / "synthstrip.sif")
    monkeypatch.setattr(resources, "brainfov_helper_path", lambda: helper)
    _publish_detectable_set(cfg, source, helper)

    signature = BrainFovAdapter().preflight_signature(cfg, "sub-0001")

    assert len(signature) == 64
    assert (
        signature[:16]
        in next(Path(cfg["paths"]["derivativesDir"]).rglob("*_T1w.json")).name
    )


def test_preflight_signature_decodes_an_unchanged_t1_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _write_nifti(
        tmp_path / "rawdata" / "sub-0001" / "anat" / "sub-0001_T1w.nii.gz",
        shape=(64, 60, 56),
    )
    helper = tmp_path / "brainfov.py"
    helper.write_bytes(b"reviewed helper")
    cfg = _cfg(tmp_path, source, helper, tmp_path / "synthstrip.sif")
    monkeypatch.setattr(resources, "brainfov_helper_path", lambda: helper)
    decodes = 0
    original = adapter_module.read_nifti

    def counted(path: Path) -> Any:
        nonlocal decodes
        decodes += 1
        return original(path)

    monkeypatch.setattr(adapter_module, "read_nifti", counted)

    first = BrainFovAdapter().preflight_signature(cfg, "sub-0001")
    second = BrainFovAdapter().preflight_signature(cfg, "sub-0001")

    assert first == second
    assert decodes == 1


def test_detector_fails_closed_after_published_artifact_tamper(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _write_nifti(
        tmp_path / "rawdata" / "sub-0001" / "anat" / "sub-0001_T1w.nii.gz",
        shape=(64, 60, 56),
    )
    helper = tmp_path / "brainfov.py"
    helper.write_bytes(b"reviewed helper")
    cfg = _cfg(tmp_path, source, helper, tmp_path / "synthstrip.sif")
    monkeypatch.setattr(resources, "brainfov_helper_path", lambda: helper)
    _publish_detectable_set(cfg, source, helper)
    qc_path = next(Path(cfg["paths"]["derivativesDir"]).rglob("*_qc.png"))
    qc_path.write_bytes(b"tampered")

    status = BrainFovAdapter().detect(cfg, "sub-0001")

    assert status.state == "partial"
    assert status.artifacts == []
    assert "integrity" in status.detail


def test_prepare_execution_creates_only_brainfov_owned_parent(
    tmp_path: Path,
) -> None:
    source = tmp_path / "rawdata/sub-0001/anat/sub-0001_T1w.nii.gz"
    helper = tmp_path / "brainfov.py"
    sif = tmp_path / "synthstrip.sif"
    cfg = _cfg(tmp_path, source, helper, sif)

    BrainFovAdapter().prepare_execution(cfg, "sub-0001")

    owned = tmp_path / "derivatives" / "supraspina-brainfov"
    assert owned.is_dir()
    assert not (owned / "sub-0001").exists()


def test_parse_failure_uses_bounded_helper_json() -> None:
    stderr = "host wrapper detail"
    stdout = json.dumps(
        {
            "ok": False,
            "error": {
                "code": "BRAINFOV_PREPARE_FAILED",
                "message": "Review SynthStrip exit status 7.",
            },
        }
    )

    failure = BrainFovAdapter().parse_failure(1, stdout, stderr)

    assert failure is not None
    assert failure.tag == "synthstrip_failed"
    assert failure.message == "Review SynthStrip exit status 7."
    assert stderr not in failure.message


def test_detector_and_command_accept_a_non_bids_t1_selected_by_pattern(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A study whose T1 files are not BIDS-named is discovered through the
    # configured pattern; the detector must report pending rather than an
    # unknown integrity state, and the helper must receive the subject.
    source = _write_nifti(
        tmp_path
        / "rawdata"
        / "sub-0001"
        / "4_t1_mprage_sag_p2_brainSpine_FOV375_1.3iso.nii.gz",
        shape=(64, 60, 56),
    )
    helper = tmp_path / "brainfov.py"
    helper.write_bytes(b"reviewed helper")
    sif = tmp_path / "synthstrip.sif"
    sif.write_bytes(b"verified SIF")
    _patch_helper_and_sif(monkeypatch, helper)
    cfg = _cfg(tmp_path, source, helper, sif)

    status = BrainFovAdapter().detect(cfg, "sub-0001")
    assert status.state == "pending"
    assert status.detail == "Create the brain-FOV preparation."

    argv = BrainFovAdapter().build_command(cfg, "sub-0001")
    assert argv[argv.index("--subject") + 1] == "sub-0001"
    assert argv[argv.index("--input") + 1] == str(source)


def test_detector_names_the_naming_problem_for_an_unsafe_subject(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _write_nifti(
        tmp_path / "rawdata" / "s1" / "scan.nii.gz",
        shape=(64, 60, 56),
    )
    helper = tmp_path / "brainfov.py"
    helper.write_bytes(b"reviewed helper")
    sif = tmp_path / "synthstrip.sif"
    sif.write_bytes(b"verified SIF")
    _patch_helper_and_sif(monkeypatch, helper)
    cfg = _cfg(tmp_path, source, helper, sif)
    cfg["_supraspinaRuntime"]["t1BySubject"] = {"s1": str(source)}

    status = BrainFovAdapter().detect(cfg, "s1")
    assert status.state == "unknown"
    assert status.detail == "Add a BIDS subject entity to the brain-FOV source."
