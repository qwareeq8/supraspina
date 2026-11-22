"""Tests for Brain-FOV geometry, NIfTI slicing, QC, and publication."""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import random
import struct
import subprocess
import sys
import zlib
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import brainfov as brainfov_module
from supraspina_sidecar.brainfov import (
    BRAINFOV_HELPER_VERSION,
    SYNTHSTRIP_PROVIDER_IDENTITY,
    BrainFovError,
    CropPlanningError,
    ImmutablePublicationError,
    MaskSummary,
    MaskValidationError,
    NiftiValidationError,
    VoxelBounds,
    build_brainfov_provenance,
    build_derivative_paths,
    build_preflight_signature,
    cli_main,
    crop_nifti,
    generate_qc_montage,
    plan_brain_fov_crop,
    publish_derivative_set,
    read_nifti,
    validate_brain_mask,
    validate_cropped_nifti,
    verify_published_derivative_set,
)

Affine = tuple[
    tuple[float, float, float, float],
    tuple[float, float, float, float],
    tuple[float, float, float, float],
    tuple[float, float, float, float],
]


def _identity_affine(
    spacing: tuple[float, float, float] = (1.0, 1.0, 1.0),
    translation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> Affine:
    return (
        (spacing[0], 0.0, 0.0, translation[0]),
        (0.0, spacing[1], 0.0, translation[1]),
        (0.0, 0.0, spacing[2], translation[2]),
        (0.0, 0.0, 0.0, 1.0),
    )


def _pack_values(
    values: Sequence[int | float],
    *,
    datatype: int,
    endian: str,
) -> bytes:
    formats = {
        2: "B",
        4: "h",
        8: "i",
        16: "f",
        64: "d",
        256: "b",
        512: "H",
        768: "I",
        1024: "q",
        1280: "Q",
    }
    if datatype == 2:
        return bytes(values)
    return struct.pack(f"{endian}{len(values)}{formats[datatype]}", *values)


def _write_nifti(  # noqa: PLR0913
    path: Path,
    *,
    shape: tuple[int, int, int] = (8, 7, 6),
    affine: Affine | None = None,
    values: Sequence[int | float] | None = None,
    datatype: int = 4,
    endian: str = "<",
    qform_code: int = 0,
    sform_code: int = 1,
    ndim: int = 3,
    fourth_dim: int = 1,
    magic: bytes = b"n+1\x00",
) -> Path:
    affine = affine or _identity_affine()
    bitpix = {
        2: 8,
        4: 16,
        8: 32,
        16: 32,
        64: 64,
        256: 8,
        512: 16,
        768: 32,
        1024: 64,
        1280: 64,
    }[datatype]
    count = math.prod(shape) * (fourth_dim if ndim == 4 else 1)
    header = bytearray(352)
    struct.pack_into(f"{endian}i", header, 0, 348)
    dimensions = [ndim, *shape, fourth_dim if ndim == 4 else 1, 1, 1, 1]
    struct.pack_into(f"{endian}8h", header, 40, *dimensions)
    struct.pack_into(f"{endian}h", header, 70, datatype)
    struct.pack_into(f"{endian}h", header, 72, bitpix)
    spacing = tuple(
        math.sqrt(sum(affine[row][axis] ** 2 for row in range(3))) for axis in range(3)
    )
    struct.pack_into(
        f"{endian}8f",
        header,
        76,
        1.0,
        *spacing,
        1.0,
        1.0,
        1.0,
        1.0,
    )
    struct.pack_into(f"{endian}f", header, 108, 352.0)
    struct.pack_into(f"{endian}h", header, 252, qform_code)
    struct.pack_into(f"{endian}h", header, 254, sform_code)
    if qform_code > 0:
        struct.pack_into(f"{endian}3f", header, 256, 0.0, 0.0, 0.0)
        struct.pack_into(
            f"{endian}3f",
            header,
            268,
            affine[0][3],
            affine[1][3],
            affine[2][3],
        )
    for row, offset in enumerate((280, 296, 312)):
        struct.pack_into(f"{endian}4f", header, offset, *affine[row])
    header[344:348] = magic
    voxel_payload = (
        b"\x00" * (count * (bitpix // 8))
        if values is None
        else _pack_values(values, datatype=datatype, endian=endian)
    )
    payload = bytes(header) + voxel_payload
    if path.name.endswith(".gz"):
        path.write_bytes(gzip.compress(payload, mtime=0))
    else:
        path.write_bytes(payload)
    return path


def _voxel_values(image: Any) -> tuple[int | float, ...]:
    code_to_format = {
        2: "B",
        4: "h",
        8: "i",
        16: "f",
        64: "d",
        256: "b",
        512: "H",
        768: "I",
        1024: "q",
        1280: "Q",
    }
    count = math.prod(image.shape)
    return struct.unpack(
        f"{image.endian}{count}{code_to_format[image.datatype]}",
        image.voxel_bytes,
    )


def _mask_values(
    shape: tuple[int, int, int],
    bounds: tuple[tuple[int, int, int], tuple[int, int, int]],
) -> bytearray:
    values = bytearray(math.prod(shape))
    start, stop = bounds
    for z_index in range(start[2], stop[2]):
        for y_index in range(start[1], stop[1]):
            for x_index in range(start[0], stop[0]):
                offset = x_index + shape[0] * (y_index + shape[1] * z_index)
                values[offset] = 1
    return values


def _read_png_dimensions(png: bytes) -> tuple[int, int]:
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert png[12:16] == b"IHDR"
    return struct.unpack(">II", png[16:24])


def _read_png_rgb(png: bytes) -> bytes:
    position = 8
    idat = bytearray()
    width = height = 0
    while position < len(png):
        length = struct.unpack(">I", png[position : position + 4])[0]
        kind = png[position + 4 : position + 8]
        data = png[position + 8 : position + 8 + length]
        if kind == b"IHDR":
            width, height = struct.unpack(">II", data[:8])
        elif kind == b"IDAT":
            idat.extend(data)
        elif kind == b"IEND":
            break
        position += 12 + length
    decoded = zlib.decompress(idat)
    rows = []
    stride = width * 3
    for row_index in range(height):
        start = row_index * (stride + 1)
        assert decoded[start] == 0
        rows.append(decoded[start + 1 : start + 1 + stride])
    return b"".join(rows)


def _provider_json() -> str:
    return json.dumps(SYNTHSTRIP_PROVIDER_IDENTITY, sort_keys=True)


def _helper_json() -> str:
    helper_path = Path(brainfov_module.__file__).resolve()
    return json.dumps(
        {
            "name": "supraspina-brainfov",
            "version": "1",
            "sha256": hashlib.sha256(helper_path.read_bytes()).hexdigest(),
        },
        sort_keys=True,
    )


def _write_synthstrip_stub(path: Path, *, exit_code: int = 0) -> Path:
    if exit_code:
        path.write_text(
            f"#!/usr/bin/env python3\nraise SystemExit({exit_code})\n",
            encoding="utf-8",
        )
    else:
        path.write_text(
            """#!/usr/bin/env python3
import gzip
import shutil
import struct
import sys

arguments = sys.argv[1:]
source_path = arguments[arguments.index("-i") + 1]
stripped_path = arguments[arguments.index("-o") + 1]
mask_path = arguments[arguments.index("-m") + 1]
threads = int(arguments[arguments.index("-t") + 1])
assert 1 <= threads <= 32
with gzip.open(source_path, "rb") as source:
    payload = source.read()
endian = "<" if struct.unpack_from("<i", payload, 0)[0] == 348 else ">"
dimensions = struct.unpack_from(f"{endian}8h", payload, 40)
shape = dimensions[1:4]
offset = round(struct.unpack_from(f"{endian}f", payload, 108)[0])
header = bytearray(payload[:offset])
struct.pack_into(f"{endian}h", header, 70, 2)
struct.pack_into(f"{endian}h", header, 72, 8)
struct.pack_into(f"{endian}f", header, 112, 0.0)
struct.pack_into(f"{endian}f", header, 116, 0.0)
mask = bytearray(shape[0] * shape[1] * shape[2])
starts = (70, 15, 15)
stops = (210, 45, 45)
for z_index in range(starts[2], stops[2]):
    for y_index in range(starts[1], stops[1]):
        row = starts[0] + shape[0] * (y_index + shape[1] * z_index)
        mask[row:row + stops[0] - starts[0]] = b"\\x01" * (stops[0] - starts[0])
with open(mask_path, "wb") as output:
    output.write(gzip.compress(bytes(header) + bytes(mask), mtime=0))
shutil.copyfile(source_path, stripped_path)
print("nested tool output must not reach helper stdout")
""",
            encoding="utf-8",
        )
    path.chmod(0o700)
    return path


@pytest.mark.parametrize(
    ("shape", "affine", "expected"),
    [
        ((200, 180, 160), _identity_affine((1.0, 1.0, 1.0)), (200.0, 180.0, 160.0)),
        (
            (200, 180, 160),
            _identity_affine((1.2, 0.8, 1.5)),
            (240.0, 144.0, 240.0),
        ),
        (
            (100, 100, 100),
            (
                (1.0, 0.5, 0.0, 0.0),
                (0.0, 1.0, 0.25, 0.0),
                (0.0, 0.0, 2.0, 0.0),
                (0.0, 0.0, 0.0, 1.0),
            ),
            (100.0, math.sqrt(1.25) * 100, math.sqrt(4.0625) * 100),
        ),
    ],
)
def test_read_nifti_computes_physical_fov_from_affine_column_norms(
    tmp_path: Path,
    shape: tuple[int, int, int],
    affine: Affine,
    expected: tuple[float, float, float],
) -> None:
    path = _write_nifti(tmp_path / "input.nii", shape=shape, affine=affine)

    image = read_nifti(path)

    assert image.fov_mm == pytest.approx(expected)


def test_read_nifti_accepts_big_endian_qform_only_image(tmp_path: Path) -> None:
    affine = _identity_affine((1.2, 0.9, 1.5), (12.0, -4.0, 7.0))
    path = _write_nifti(
        tmp_path / "input.nii.gz",
        affine=affine,
        endian=">",
        qform_code=2,
        sform_code=0,
    )

    image = read_nifti(path)

    assert image.endian == ">"
    assert tuple(value for row in image.affine for value in row) == pytest.approx(
        tuple(value for row in affine for value in row)
    )
    assert image.qform_code == 2
    assert image.sform_code == 0


def test_read_nifti_rejects_limit_plus_one_decompressed_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _write_nifti(tmp_path / "oversized.nii.gz")
    monkeypatch.setattr(brainfov_module, "_MAX_NIFTI_BYTES", 400)

    with pytest.raises(NiftiValidationError, match="bounded reader limit"):
        read_nifti(path)


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda raw: raw.__setitem__(slice(344, 348), b"bad\x00"), "single-file"),
        (
            lambda raw: struct.pack_into("<8h", raw, 40, 4, 8, 7, 6, 2, 1, 1, 1),
            "single-volume 3-D",
        ),
        (
            lambda raw: struct.pack_into("<h", raw, 70, 128),
            "scalar datatype",
        ),
        (
            lambda raw: struct.pack_into("<h", raw, 72, 8),
            "bit depth",
        ),
        (
            lambda raw: (
                struct.pack_into("<h", raw, 252, 0),
                struct.pack_into("<h", raw, 254, 0),
            ),
            "qform or sform",
        ),
    ],
)
def test_read_nifti_rejects_malformed_or_unsupported_images(
    tmp_path: Path,
    mutation: Any,
    message: str,
) -> None:
    path = _write_nifti(tmp_path / "input.nii")
    raw = bytearray(path.read_bytes())
    mutation(raw)
    path.write_bytes(raw)

    with pytest.raises(NiftiValidationError, match=message):
        read_nifti(path)


@pytest.mark.parametrize(
    "affine",
    [
        (
            (1.0, 0.0, 0.0, math.nan),
            (0.0, 1.0, 0.0, 0.0),
            (0.0, 0.0, 1.0, 0.0),
            (0.0, 0.0, 0.0, 1.0),
        ),
        (
            (1.0, 0.0, 0.0, 0.0),
            (0.0, 1.0, 0.0, 0.0),
            (0.0, 0.0, 0.0, 0.0),
            (0.0, 0.0, 0.0, 1.0),
        ),
    ],
)
def test_read_nifti_rejects_nonfinite_or_singular_affine(
    tmp_path: Path,
    affine: Affine,
) -> None:
    path = _write_nifti(tmp_path / "input.nii", affine=affine)

    with pytest.raises(NiftiValidationError, match="finite, nonsingular"):
        read_nifti(path)


def test_read_nifti_rejects_truncated_voxel_payload(tmp_path: Path) -> None:
    path = _write_nifti(tmp_path / "input.nii")
    path.write_bytes(path.read_bytes()[:-1])

    with pytest.raises(
        NiftiValidationError, match="Provide a complete NIfTI voxel payload"
    ):
        read_nifti(path)


def test_validate_brain_mask_returns_bbox_and_component_evidence(
    tmp_path: Path,
) -> None:
    shape = (30, 28, 26)
    affine = _identity_affine((1.0, 1.2, 0.8))
    source = read_nifti(
        _write_nifti(tmp_path / "source.nii", shape=shape, affine=affine)
    )
    values = _mask_values(shape, ((5, 6, 7), (21, 22, 20)))
    values[0] = 1
    mask = read_nifti(
        _write_nifti(
            tmp_path / "mask.nii",
            shape=shape,
            affine=affine,
            datatype=2,
            values=values,
        )
    )

    summary = validate_brain_mask(source, mask)

    assert summary.bounds.start == (5, 6, 7)
    assert summary.bounds.stop == (21, 22, 20)
    assert summary.component_count == 2
    assert summary.largest_component_voxels == 16 * 16 * 13
    assert summary.dominant_fraction > 0.999


def test_validate_brain_mask_rejects_geometry_mismatch(tmp_path: Path) -> None:
    source = read_nifti(
        _write_nifti(
            tmp_path / "source.nii",
            shape=(20, 20, 20),
            affine=_identity_affine(),
        )
    )
    mask = read_nifti(
        _write_nifti(
            tmp_path / "mask.nii",
            shape=(20, 20, 20),
            affine=_identity_affine(translation=(0.1, 0.0, 0.0)),
            datatype=2,
            values=[1] * 8000,
        )
    )

    with pytest.raises(MaskValidationError, match="affine"):
        validate_brain_mask(source, mask)


def test_validate_brain_mask_rejects_empty_and_fragmented_masks(
    tmp_path: Path,
) -> None:
    shape = (20, 20, 20)
    source = read_nifti(_write_nifti(tmp_path / "source.nii", shape=shape))
    empty = read_nifti(
        _write_nifti(
            tmp_path / "empty.nii",
            shape=shape,
            datatype=2,
            values=[0] * math.prod(shape),
        )
    )
    with pytest.raises(MaskValidationError, match="empty"):
        validate_brain_mask(source, empty)

    values = [0] * math.prod(shape)
    values[0] = 1
    values[-1] = 1
    fragmented = read_nifti(
        _write_nifti(
            tmp_path / "fragmented.nii",
            shape=shape,
            datatype=2,
            values=values,
        )
    )
    with pytest.raises(MaskValidationError, match="dominant connected component"):
        validate_brain_mask(source, fragmented)


def test_validate_brain_mask_rejects_nonfinite_values(tmp_path: Path) -> None:
    shape = (4, 4, 4)
    source = read_nifti(_write_nifti(tmp_path / "source.nii", shape=shape))
    values = [0.0] * math.prod(shape)
    values[21] = math.nan
    mask = read_nifti(
        _write_nifti(
            tmp_path / "mask.nii",
            shape=shape,
            datatype=16,
            values=values,
        )
    )

    with pytest.raises(MaskValidationError, match="non-finite"):
        validate_brain_mask(source, mask)


def test_plan_passes_through_image_at_exact_fov_limit(tmp_path: Path) -> None:
    source = read_nifti(
        _write_nifti(
            tmp_path / "source.nii",
            shape=(256, 128, 128),
            affine=_identity_affine(),
        )
    )

    plan = plan_brain_fov_crop(source)

    assert plan.pass_through is True
    assert plan.bounds.start == (0, 0, 0)
    assert plan.bounds.stop == source.shape
    assert plan.output_fov_mm == pytest.approx((256.0, 128.0, 128.0))


@pytest.mark.parametrize(
    ("spacing", "count"),
    [(0.5, 512), (1.0, 256), (0.8, 320), (1.6, 160), (0.25, 1024)],
)
def test_plan_passes_through_a_nominal_256_mm_float32_acquisition(
    tmp_path: Path, spacing: float, count: int
) -> None:
    # NIfTI stores the affine as binary32, so 0.8 mm by 320 reads back as
    # 256.0000038 mm. That representation error must not read as over-limit.
    source = read_nifti(
        _write_nifti(
            tmp_path / "source.nii",
            shape=(count, 8, 6),
            affine=_identity_affine((spacing, 1.0, 1.0)),
        )
    )

    assert source.fov_mm[0] != 256.0 or spacing in {0.5, 1.0, 0.25}
    assert brainfov_module.fov_within_limit(source.fov_mm) is True
    assert plan_brain_fov_crop(source).pass_through is True


@pytest.mark.parametrize(
    ("spacing", "count"),
    [(1.0, 257), (0.8, 321), (1.0009765625, 256), (2.0, 129)],
)
def test_plan_rejects_a_genuinely_larger_field_of_view(
    tmp_path: Path, spacing: float, count: int
) -> None:
    source = read_nifti(
        _write_nifti(
            tmp_path / "source.nii",
            shape=(count, 8, 6),
            affine=_identity_affine((spacing, 1.0, 1.0)),
        )
    )

    assert source.fov_mm[0] > 256.0
    assert brainfov_module.fov_within_limit(source.fov_mm) is False
    with pytest.raises(CropPlanningError, match="brain mask"):
        plan_brain_fov_crop(source)


def test_fov_allowance_stays_below_a_micrometre_at_the_limit() -> None:
    allowance = brainfov_module._length_tolerance_mm(brainfov_module.MAXIMUM_FOV_MM)

    assert 0 < allowance < 1e-4
    assert brainfov_module.fov_within_limit((256.0 + allowance / 2, 1.0, 1.0)) is True
    assert brainfov_module.fov_within_limit((256.0 + allowance * 2, 1.0, 1.0)) is False
    assert brainfov_module.fov_within_limit((256.000001, 1.0, 1.0)) is True
    assert brainfov_module.fov_within_limit((256.001, 1.0, 1.0)) is False


def test_capped_axis_keeps_the_full_nominal_256_mm_voxel_count(
    tmp_path: Path,
) -> None:
    # A 0.8 mm capped axis must retain 320 voxels; an absolute epsilon truncated
    # it to 319 and silently discarded 0.8 mm of reviewed field of view.
    source = read_nifti(
        _write_nifti(
            tmp_path / "source.nii",
            shape=(400, 64, 48),
            affine=_identity_affine((0.8, 1.0, 1.0)),
        )
    )
    mask = MaskSummary(
        bounds=VoxelBounds((60, 16, 16), (340, 48, 32)),
        nonzero_voxels=1,
        largest_component_voxels=1,
        component_count=1,
        dominant_fraction=1.0,
    )

    plan = plan_brain_fov_crop(source, mask)

    assert plan.capped_axes[0] is True
    assert plan.bounds.stop[0] - plan.bounds.start[0] == 320
    assert brainfov_module.fov_within_limit(plan.output_fov_mm) is True


def test_plan_requires_mask_when_any_axis_exceeds_limit(tmp_path: Path) -> None:
    source = read_nifti(
        _write_nifti(
            tmp_path / "source.nii",
            shape=(257, 128, 128),
            affine=_identity_affine(),
        )
    )

    with pytest.raises(CropPlanningError, match="brain mask"):
        plan_brain_fov_crop(source)


def test_plan_adds_requested_physical_margin_for_anisotropic_image(
    tmp_path: Path,
) -> None:
    shape = (300, 200, 180)
    affine = _identity_affine((1.0, 1.2, 0.8))
    source = read_nifti(
        _write_nifti(tmp_path / "source.nii", shape=shape, affine=affine)
    )
    mask_image = read_nifti(
        _write_nifti(
            tmp_path / "mask.nii",
            shape=shape,
            affine=affine,
            datatype=2,
            values=_mask_values(shape, ((80, 50, 40), (220, 150, 140))),
        )
    )
    mask = validate_brain_mask(source, mask_image)

    plan = plan_brain_fov_crop(source, mask, margin_mm=30)

    assert plan.pass_through is False
    assert plan.bounds.start == (50, 25, 2)
    assert plan.bounds.stop == (250, 175, 178)
    assert plan.face_clearance_mm == pytest.approx((30.0, 30.0, 30.0, 30.0, 30.4, 30.4))
    assert plan.capped_axes == (False, False, False)


def test_plan_caps_to_256_mm_while_retaining_minimum_clearance(
    tmp_path: Path,
) -> None:
    shape = (320, 220, 200)
    source = read_nifti(_write_nifti(tmp_path / "source.nii", shape=shape))
    mask_image = read_nifti(
        _write_nifti(
            tmp_path / "mask.nii",
            shape=shape,
            datatype=2,
            values=_mask_values(shape, ((40, 50, 40), (266, 170, 160))),
        )
    )
    mask = validate_brain_mask(source, mask_image)

    plan = plan_brain_fov_crop(source, mask)

    assert plan.bounds.start[0] == 25
    assert plan.bounds.stop[0] == 281
    assert plan.output_fov_mm[0] == pytest.approx(256.0)
    assert plan.face_clearance_mm[0:2] == pytest.approx((15.0, 15.0))
    assert plan.capped_axes == (True, False, False)


def test_sub_0012_source_clamped_crop_needs_no_256_mm_cap(
    tmp_path: Path,
) -> None:
    affine: Affine = (
        (
            0.7370283603668213,
            0.041286081075668335,
            0.03499948978424072,
            -139.7726287841797,
        ),
        (
            -0.037692297250032425,
            0.7316727042198181,
            -0.12713201344013214,
            -122.24067687988281,
        ),
        (
            -0.03085695579648018,
            0.09238069504499435,
            0.9912680983543396,
            -115.3976821899414,
        ),
        (0.0, 0.0, 0.0, 1.0),
    )
    source = read_nifti(
        _write_nifti(
            tmp_path / "sub-0012_ses-baseline_acq-ingenia_T1w.nii.gz",
            shape=(352, 352, 170),
            affine=affine,
            datatype=2,
        )
    )
    mask = MaskSummary(
        bounds=VoxelBounds((89, 62, 9), (271, 288, 154)),
        nonzero_voxels=1,
        largest_component_voxels=1,
        component_count=1,
        dominant_fraction=1.0,
    )

    plan = plan_brain_fov_crop(source, mask)

    assert plan.bounds.start == (48, 21, 0)
    assert plan.bounds.stop == (312, 329, 170)
    assert plan.output_fov_mm == pytest.approx((195.0, 227.5, 170.0))
    assert plan.face_clearance_mm == pytest.approx(
        (30.284, 30.284, 30.284, 30.284, 9.0, 16.0),
        abs=1e-3,
    )
    assert plan.capped_axes == (False, False, False)


def test_crop_validation_accepts_positive_source_clamped_clearance(
    tmp_path: Path,
) -> None:
    shape = (300, 80, 70)
    source = read_nifti(
        _write_nifti(
            tmp_path / "source.nii.gz",
            shape=shape,
            datatype=2,
        )
    )
    mask = MaskSummary(
        bounds=VoxelBounds((80, 5, 1), (220, 70, 60)),
        nonzero_voxels=1,
        largest_component_voxels=1,
        component_count=1,
        dominant_fraction=1.0,
    )
    plan = plan_brain_fov_crop(source, mask)

    cropped = crop_nifti(source, plan, tmp_path / "crop.nii.gz")

    assert plan.capped_axes == (False, False, False)
    assert plan.face_clearance_mm == pytest.approx((30.0, 30.0, 5.0, 10.0, 1.0, 10.0))
    assert validate_cropped_nifti(source, cropped, plan)["boundaryClearance"] is True


def test_plan_rejects_uncapped_mask_touching_source_boundary(
    tmp_path: Path,
) -> None:
    shape = (300, 80, 70)
    source = read_nifti(_write_nifti(tmp_path / "source.nii", shape=shape))
    mask = MaskSummary(
        bounds=VoxelBounds((80, 0, 10), (220, 70, 60)),
        nonzero_voxels=1,
        largest_component_voxels=1,
        component_count=1,
        dominant_fraction=1.0,
    )

    with pytest.raises(
        CropPlanningError, match="Keep the brain mask away from every crop face"
    ):
        plan_brain_fov_crop(source, mask)


def test_plan_requires_minimum_clearance_on_all_faces_when_any_axis_is_capped(
    tmp_path: Path,
) -> None:
    shape = (400, 100, 80)
    source = read_nifti(_write_nifti(tmp_path / "source.nii", shape=shape))
    mask = MaskSummary(
        bounds=VoxelBounds((60, 5, 10), (286, 80, 70)),
        nonzero_voxels=1,
        largest_component_voxels=1,
        component_count=1,
        dominant_fraction=1.0,
    )

    with pytest.raises(CropPlanningError, match="15"):
        plan_brain_fov_crop(source, mask)


def test_plan_fails_when_capped_crop_cannot_keep_15_mm_on_all_faces(
    tmp_path: Path,
) -> None:
    shape = (320, 220, 200)
    source = read_nifti(_write_nifti(tmp_path / "source.nii", shape=shape))
    mask_image = read_nifti(
        _write_nifti(
            tmp_path / "mask.nii",
            shape=shape,
            datatype=2,
            values=_mask_values(shape, ((10, 50, 40), (270, 170, 160))),
        )
    )
    mask = validate_brain_mask(source, mask_image)

    with pytest.raises(CropPlanningError, match="15"):
        plan_brain_fov_crop(source, mask)


def test_sub_0001_high_fov_geometry_regression_caps_rotated_axes(
    tmp_path: Path,
) -> None:
    affine: Affine = (
        (1.3000030517578125, 0.0, 0.0, -109.7137680053711),
        (0.0, 1.3020516633987427, -0.009090273641049862, -175.03916931152344),
        (0.0, 0.009090273641049862, 1.3020516633987427, -188.59121704101562),
        (0.0, 0.0, 0.0, 1.0),
    )
    source = read_nifti(
        _write_nifti(
            tmp_path / "sub-0001_ses-baseline_acq-prisma_T1w.nii.gz",
            shape=(176, 280, 288),
            affine=affine,
            datatype=2,
        )
    )
    mask = MaskSummary(
        bounds=VoxelBounds((30, 62, 60), (146, 218, 228)),
        nonzero_voxels=1,
        largest_component_voxels=1,
        component_count=1,
        dominant_fraction=1.0,
    )

    plan = plan_brain_fov_crop(source, mask)

    assert source.fov_mm == pytest.approx(
        (228.800537109375, 364.5833505676984, 375.00001772677544)
    )
    assert plan.bounds.start == (6, 42, 46)
    assert plan.bounds.stop == (170, 238, 242)
    assert plan.capped_axes == (False, True, True)
    assert all(value <= 256.0 for value in plan.output_fov_mm)


def test_crop_slices_exact_encoded_voxels_and_updates_both_forms(
    tmp_path: Path,
) -> None:
    shape = (300, 80, 70)
    affine: Affine = (
        (1.0, 0.2, 0.0, -120.0),
        (0.0, 1.0, 0.3, -80.0),
        (0.0, 0.0, 1.0, -40.0),
        (0.0, 0.0, 0.0, 1.0),
    )
    source = read_nifti(
        _write_nifti(
            tmp_path / "source.nii.gz",
            shape=shape,
            affine=affine,
            values=[index % 30_000 for index in range(math.prod(shape))],
            qform_code=2,
            sform_code=1,
        )
    )
    mask_image = read_nifti(
        _write_nifti(
            tmp_path / "mask.nii.gz",
            shape=shape,
            affine=affine,
            datatype=2,
            values=_mask_values(shape, ((80, 20, 20), (220, 60, 50))),
        )
    )
    plan = plan_brain_fov_crop(
        source,
        validate_brain_mask(source, mask_image),
    )
    destination = tmp_path / "crop.nii.gz"

    cropped = crop_nifti(source, plan, destination)

    source_values = _voxel_values(source)
    cropped_values = _voxel_values(cropped)
    expected = []
    for z_index in range(plan.bounds.start[2], plan.bounds.stop[2]):
        for y_index in range(plan.bounds.start[1], plan.bounds.stop[1]):
            row_start = plan.bounds.start[0] + shape[0] * (y_index + shape[1] * z_index)
            row_stop = row_start + plan.bounds.shape[0]
            expected.extend(source_values[row_start:row_stop])
    assert cropped_values == tuple(expected)

    expected_translation = tuple(
        affine[row][3]
        + sum(affine[row][axis] * plan.bounds.start[axis] for axis in range(3))
        for row in range(3)
    )
    assert tuple(row[3] for row in cropped.affine[:3]) == pytest.approx(
        expected_translation
    )
    assert cropped.qform_code == source.qform_code
    assert cropped.sform_code == source.sform_code
    report = validate_cropped_nifti(source, cropped, plan)
    assert report["sourceVoxelEquality"] is True
    assert report["affineTranslation"] is True
    assert report["qformAffineTranslation"] is True
    assert report["sformAffineTranslation"] is True
    assert report["outputFovWithinLimit"] is True


@pytest.mark.parametrize(
    ("shape", "spacing", "mask_bounds"),
    [
        ((300, 100, 90), (0.9, 1.2, 1.5), ((70, 20, 18), (230, 80, 72))),
        ((180, 300, 90), (1.3, 0.9, 1.4), ((30, 70, 18), (150, 230, 72))),
        ((180, 100, 300), (1.2, 1.4, 0.9), ((30, 20, 70), (150, 80, 230))),
    ],
)
def test_crop_geometry_properties_hold_across_axis_orientations(
    tmp_path: Path,
    shape: tuple[int, int, int],
    spacing: tuple[float, float, float],
    mask_bounds: tuple[tuple[int, int, int], tuple[int, int, int]],
) -> None:
    affine = _identity_affine(spacing, (20.0, -30.0, 40.0))
    source = read_nifti(
        _write_nifti(tmp_path / "source.nii", shape=shape, affine=affine)
    )
    mask_image = read_nifti(
        _write_nifti(
            tmp_path / "mask.nii",
            shape=shape,
            affine=affine,
            datatype=2,
            values=_mask_values(shape, mask_bounds),
        )
    )

    plan = plan_brain_fov_crop(
        source,
        validate_brain_mask(source, mask_image),
    )
    cropped = crop_nifti(source, plan, tmp_path / "crop.nii")

    assert all(value <= 256.0 + 1e-6 for value in cropped.fov_mm)
    assert cropped.shape == plan.bounds.shape
    assert validate_cropped_nifti(source, cropped, plan) == {
        "affineTranslation": True,
        "boundaryClearance": True,
        "datatypePreserved": True,
        "outputFovMatchesPlan": True,
        "outputFovWithinLimit": True,
        "qformAffineTranslation": True,
        "qformCodePreserved": True,
        "sformAffineTranslation": True,
        "sformCodePreserved": True,
        "shapeMatchesPlan": True,
        "sourceVoxelEquality": True,
    }


_PROPERTY_PERMUTATIONS = (
    (0, 1, 2),
    (0, 2, 1),
    (1, 0, 2),
    (1, 2, 0),
    (2, 0, 1),
    (2, 1, 0),
)
_PROPERTY_DATATYPES = (2, 4, 8, 16, 64, 256, 512, 768, 1024, 1280)


def _property_affine(
    spacing: tuple[float, float, float],
    permutation: tuple[int, int, int],
    rng: random.Random,
) -> Affine:
    signs = [rng.choice((-1.0, 1.0)) for _ in range(3)]
    if all(sign < 0 for sign in signs):
        signs[0] = 1.0
    if all(sign > 0 for sign in signs):
        signs[0] = -1.0
    columns = []
    for axis in range(3):
        vector = [0.0, 0.0, 0.0]
        vector[permutation[axis]] = signs[axis]
        shear = rng.choice((-1.0, 1.0)) * rng.uniform(0.05, 0.18)
        vector[permutation[(axis + 1) % 3]] = shear
        norm = math.sqrt(sum(value * value for value in vector))
        columns.append(tuple(value * spacing[axis] / norm for value in vector))
    translation = tuple(rng.uniform(-120.0, 120.0) for _ in range(3))
    rows = tuple(
        (*(columns[column][row] for column in range(3)), translation[row])
        for row in range(3)
    )
    return (rows[0], rows[1], rows[2], (0.0, 0.0, 0.0, 1.0))


def _property_values(
    count: int,
    datatype: int,
    salt: int,
) -> list[int | float]:
    if datatype in {16, 64}:
        values: list[int | float] = [
            ((index * 37 + salt) % 2_003 - 1_001) / 17.0 for index in range(count)
        ]
    elif datatype == 2:
        values = [(index * 37 + salt) % 251 for index in range(count)]
    elif datatype == 256:
        values = [(index * 37 + salt) % 241 - 120 for index in range(count)]
    elif datatype == 4:
        values = [(index * 37 + salt) % 60_001 - 30_000 for index in range(count)]
    elif datatype == 512:
        values = [(index * 37 + salt) % 65_521 for index in range(count)]
    elif datatype in {8, 1024}:
        values = [
            (index * 1_000_003 + salt) % 2_000_000_001 - 1_000_000_000
            for index in range(count)
        ]
    else:
        values = [(index * 1_000_003 + salt) % 4_000_000_001 for index in range(count)]
    return values


def _expected_encoded_crop(source: Any, bounds: VoxelBounds) -> bytes:
    row_bytes = bounds.shape[0] * source.bytes_per_voxel
    rows = []
    for z_index in range(bounds.start[2], bounds.stop[2]):
        for y_index in range(bounds.start[1], bounds.stop[1]):
            voxel_offset = bounds.start[0] + source.shape[0] * (
                y_index + source.shape[1] * z_index
            )
            byte_offset = voxel_offset * source.bytes_per_voxel
            rows.append(source.voxel_bytes[byte_offset : byte_offset + row_bytes])
    return b"".join(rows)


def _affine_times_voxel_translation(
    affine: Affine,
    start: tuple[int, int, int],
) -> Affine:
    translation: Affine = (
        (1.0, 0.0, 0.0, float(start[0])),
        (0.0, 1.0, 0.0, float(start[1])),
        (0.0, 0.0, 1.0, float(start[2])),
        (0.0, 0.0, 0.0, 1.0),
    )
    return tuple(
        tuple(
            sum(affine[row][inner] * translation[inner][column] for inner in range(4))
            for column in range(4)
        )
        for row in range(4)
    )  # type: ignore[return-value]


def _affine_determinant(affine: Affine) -> float:
    return (
        affine[0][0] * (affine[1][1] * affine[2][2] - affine[1][2] * affine[2][1])
        - affine[0][1] * (affine[1][0] * affine[2][2] - affine[1][2] * affine[2][0])
        + affine[0][2] * (affine[1][0] * affine[2][1] - affine[1][1] * affine[2][0])
    )


_PROPERTY_VALIDATION_FLAGS = {
    "affineTranslation",
    "boundaryClearance",
    "datatypePreserved",
    "outputFovMatchesPlan",
    "outputFovWithinLimit",
    "qformAffineTranslation",
    "qformCodePreserved",
    "sformAffineTranslation",
    "sformCodePreserved",
    "shapeMatchesPlan",
    "sourceVoxelEquality",
}


def _property_geometry(
    index: int,
    rng: random.Random,
) -> tuple[
    tuple[int, int, int],
    tuple[float, float, float],
    int,
    bool,
    MaskSummary,
]:
    spacing_values = [
        rng.uniform(0.85, 1.0),
        rng.uniform(1.15, 1.35),
        rng.uniform(1.55, 1.8),
    ]
    rng.shuffle(spacing_values)
    spacing = tuple(spacing_values)
    high_axis = index % 3
    shape_values = []
    for axis, axis_spacing in enumerate(spacing):
        if axis == high_axis:
            dimension = math.ceil(rng.uniform(285.0, 315.0) / axis_spacing)
        else:
            minimum_padding = math.ceil(20.0 / axis_spacing)
            dimension = max(rng.randint(38, 52), 2 * minimum_padding + 12)
        shape_values.append(dimension)
    shape = tuple(shape_values)
    expect_cap = index % 2 == 0
    mask_start = []
    mask_stop = []
    for axis, (dimension, axis_spacing) in enumerate(zip(shape, spacing, strict=True)):
        if axis == high_axis:
            brain_mm = (
                rng.uniform(206.0, 218.0) if expect_cap else rng.uniform(145.0, 175.0)
            )
            brain_voxels = round(brain_mm / axis_spacing)
            start = (dimension - brain_voxels) // 2
            stop = start + brain_voxels
        else:
            padding = math.ceil(rng.uniform(20.0, 24.0) / axis_spacing)
            start = padding
            stop = dimension - padding
        mask_start.append(start)
        mask_stop.append(stop)
    bounds = VoxelBounds(tuple(mask_start), tuple(mask_stop))
    mask_voxels = math.prod(bounds.shape)
    mask = MaskSummary(
        bounds=bounds,
        nonzero_voxels=mask_voxels,
        largest_component_voxels=mask_voxels,
        component_count=1,
        dominant_fraction=1.0,
    )
    return shape, spacing, high_axis, expect_cap, mask


def _assert_property_crop(
    source: Any,
    cropped: Any,
    plan: Any,
    validation: dict[str, bool],
    expectation: tuple[tuple[int, int, int], int, bool],
) -> bool:
    permutation, high_axis, expect_cap = expectation
    assert plan.pass_through is False
    assert any(plan.capped_axes) is expect_cap
    assert plan.capped_axes[high_axis] is expect_cap
    assert sum(plan.capped_axes) == int(expect_cap)
    assert len({round(value, 4) for value in source.voxel_spacing_mm}) == 3
    columns = tuple(
        tuple(source.affine[row][axis] for row in range(3)) for axis in range(3)
    )
    assert (
        tuple(
            max(range(3), key=lambda row: abs(columns[axis][row])) for axis in range(3)
        )
        == permutation
    )
    assert all(sum(abs(value) > 1e-6 for value in column) == 2 for column in columns)
    assert _affine_determinant(source.affine) != pytest.approx(0.0, abs=1e-5)
    assert cropped.voxel_bytes == _expected_encoded_crop(source, plan.bounds)
    expected_affine = _affine_times_voxel_translation(
        source.affine,
        plan.bounds.start,
    )
    assert tuple(value for row in cropped.affine for value in row) == pytest.approx(
        tuple(value for row in expected_affine for value in row),
        abs=1e-4,
    )
    assert cropped.qform_code == source.qform_code
    assert cropped.sform_code == source.sform_code
    assert all(value <= 256.0 + 1e-6 for value in plan.output_fov_mm)
    assert all(value <= 256.0 + 1e-6 for value in cropped.fov_mm)
    assert set(validation) == _PROPERTY_VALIDATION_FLAGS
    assert all(validation.values())
    return any(plan.capped_axes)


def test_seeded_crop_properties_preserve_encoded_voxels_and_affines(
    tmp_path: Path,
) -> None:
    rng = random.Random(0xB8A1F0)  # noqa: S311 - Use a deterministic test generator.
    permutations = list(_PROPERTY_PERMUTATIONS)
    rng.shuffle(permutations)
    capped_cases = 0
    uncapped_cases = 0
    observed_permutations: set[tuple[int, int, int]] = set()

    for index, datatype in enumerate(_PROPERTY_DATATYPES):
        permutation = permutations[index % len(permutations)]
        observed_permutations.add(permutation)
        shape, spacing, high_axis, expect_cap, mask = _property_geometry(index, rng)
        affine = _property_affine(spacing, permutation, rng)
        source_path = tmp_path / f"source-{index:02d}.nii"
        source = read_nifti(
            _write_nifti(
                source_path,
                shape=shape,
                affine=affine,
                values=_property_values(math.prod(shape), datatype, index * 97),
                datatype=datatype,
                endian=">" if index % 3 == 0 else "<",
                qform_code=index % 3 + 1,
                sform_code=index % 4 + 1,
            )
        )

        plan = plan_brain_fov_crop(source, mask)
        cropped = crop_nifti(source, plan, tmp_path / f"crop-{index:02d}.nii")
        validation = validate_cropped_nifti(source, cropped, plan)

        was_capped = _assert_property_crop(
            source,
            cropped,
            plan,
            validation,
            (permutation, high_axis, expect_cap),
        )
        capped_cases += int(was_capped)
        uncapped_cases += int(not was_capped)

    assert observed_permutations == set(_PROPERTY_PERMUTATIONS)
    assert capped_cases > 0, (
        "Produce at least one capped crop with the seeded generator."
    )
    assert uncapped_cases > 0, (
        "Produce at least one uncapped crop with the seeded generator."
    )


def test_build_derivative_paths_preserves_bids_entities_and_layout(
    tmp_path: Path,
) -> None:
    source = (
        tmp_path
        / "rawdata"
        / "sub-0001"
        / "ses-baseline"
        / "anat"
        / "sub-0001_ses-baseline_acq-mprage_run-1_T1w.nii.gz"
    )
    paths = build_derivative_paths(
        tmp_path / "derivatives",
        source,
        "0123456789abcdef" * 4,
    )

    expected_root = (
        tmp_path
        / "derivatives"
        / "supraspina-brainfov"
        / "sub-0001"
        / "ses-baseline"
        / "anat"
    )
    assert paths.t1 == (
        expected_root / "sub-0001_ses-baseline_acq-mprage_run-1_"
        "desc-brainfov0123456789abcdef_T1w.nii.gz"
    )
    assert paths.mask.name.endswith("_desc-brainfov0123456789abcdef_mask.nii.gz")
    assert paths.qc.name.endswith("_desc-brainfov0123456789abcdef_qc.png")
    assert paths.provenance.name.endswith("_desc-brainfov0123456789abcdef_T1w.json")


@pytest.mark.parametrize(
    "name",
    [
        "participant-1_T1w.nii.gz",
        "sub-01_ses-a_T2w.nii.gz",
        "sub-01_ses-a_desc-existing_T1w.nii.gz",
        "sub-01_T1w.zip",
    ],
)
def test_build_derivative_paths_rejects_nonraw_t1_names(
    tmp_path: Path,
    name: str,
) -> None:
    with pytest.raises(BrainFovError):
        build_derivative_paths(tmp_path / "derivatives", tmp_path / name, "a" * 64)


def test_preflight_signature_is_canonical_and_sensitive_to_source_hash(
    tmp_path: Path,
) -> None:
    source_path = _write_nifti(tmp_path / "source.nii.gz")
    source = read_nifti(source_path)
    provider = {
        "name": "SynthStrip",
        "version": "1.8",
        "containerSha256": "a" * 64,
    }
    helper = {"name": "brainfov", "version": "1", "sha256": "b" * 64}

    first, payload = build_preflight_signature(
        source_path,
        source,
        margin_mm=30,
        provider=provider,
        helper=helper,
    )
    second, _ = build_preflight_signature(
        source_path,
        source,
        margin_mm=30,
        provider=dict(reversed(provider.items())),
        helper=dict(reversed(helper.items())),
    )
    changed_path = tmp_path / "changed.nii.gz"
    changed_path.write_bytes(source_path.read_bytes() + b"x")
    changed, _ = build_preflight_signature(
        changed_path,
        source,
        margin_mm=30,
        provider=provider,
        helper=helper,
    )
    changed_helper, _ = build_preflight_signature(
        source_path,
        source,
        margin_mm=30,
        provider=provider,
        helper={**helper, "sha256": "c" * 64},
    )
    changed_model, _ = build_preflight_signature(
        source_path,
        source,
        margin_mm=30,
        provider={
            **provider,
            "model": {
                "name": "synthstrip.1",
                "containerPath": "/freesurfer/models/synthstrip.1.pt",
                "size": 1,
                "sha256": "d" * 64,
            },
        },
        helper=helper,
    )

    assert first == second
    assert first != changed
    assert first != changed_helper
    assert first != changed_model
    assert payload["source"]["sha256"]
    assert payload["policy"] == {
        "marginMm": 30,
        "maximumFovMm": 256.0,
        "minimumMarginMm": 15.0,
    }


def test_synthstrip_provider_names_the_exact_bundled_model() -> None:
    assert SYNTHSTRIP_PROVIDER_IDENTITY["model"] == {
        "name": "synthstrip.1",
        "containerPath": "/freesurfer/models/synthstrip.1.pt",
        "size": 30_851_709,
        "sha256": ("37417f802196186441aae3e7f385d94f8a98c64a88acaeaa2723af995c653e33"),
    }


def test_generate_qc_montage_is_deterministic_2_by_3_png(
    tmp_path: Path,
) -> None:
    shape = (280, 60, 54)
    values = [
        (x_index * 5 + y_index * 3 + z_index * 7) % 1000
        for z_index in range(shape[2])
        for y_index in range(shape[1])
        for x_index in range(shape[0])
    ]
    source = read_nifti(
        _write_nifti(
            tmp_path / "source.nii",
            shape=shape,
            values=values,
        )
    )
    mask_image = read_nifti(
        _write_nifti(
            tmp_path / "mask.nii",
            shape=shape,
            datatype=2,
            values=_mask_values(shape, ((80, 15, 15), (200, 45, 39))),
        )
    )
    mask = validate_brain_mask(source, mask_image)
    plan = plan_brain_fov_crop(source, mask)

    first = generate_qc_montage(source, plan, mask, panel_pixels=48)
    second = generate_qc_montage(source, plan, mask, panel_pixels=48)

    assert first.png == second.png
    assert _read_png_dimensions(first.png) == (160, 104)
    assert first.layout == {
        "columns": ["sagittal", "coronal", "axial"],
        "rows": ["sourceWithCropBoundary", "preparedCrop"],
        "panelPixels": 48,
        "gapPixels": 8,
    }
    rgb = _read_png_rgb(first.png)
    assert b"\xff\xd2\x00" in rgb


def test_generate_qc_montage_supports_maskless_pass_through(
    tmp_path: Path,
) -> None:
    source = read_nifti(
        _write_nifti(
            tmp_path / "source.nii",
            shape=(64, 60, 56),
            datatype=2,
        )
    )
    plan = plan_brain_fov_crop(source)

    montage = generate_qc_montage(source, plan, None, panel_pixels=32)

    assert _read_png_dimensions(montage.png) == (112, 72)
    assert montage.sha256


def test_generate_qc_montage_rejects_crop_without_mask_evidence(
    tmp_path: Path,
) -> None:
    source = read_nifti(
        _write_nifti(
            tmp_path / "source.nii",
            shape=(280, 60, 60),
            datatype=2,
        )
    )
    mask = MaskSummary(
        bounds=VoxelBounds((70, 15, 15), (210, 45, 45)),
        nonzero_voxels=1,
        largest_component_voxels=1,
        component_count=1,
        dominant_fraction=1.0,
    )
    plan = plan_brain_fov_crop(source, mask)

    with pytest.raises(BrainFovError, match="mask evidence"):
        generate_qc_montage(source, plan, None, panel_pixels=32)


def test_provenance_records_crop_geometry_hashes_and_nested_command(
    tmp_path: Path,
) -> None:
    source_path = _write_nifti(
        tmp_path / "sub-0001_T1w.nii",
        shape=(280, 60, 60),
    )
    source = read_nifti(source_path)
    mask_image = read_nifti(
        _write_nifti(
            tmp_path / "mask.nii",
            shape=source.shape,
            datatype=2,
            values=_mask_values(source.shape, ((70, 15, 15), (210, 45, 45))),
        )
    )
    mask = validate_brain_mask(source, mask_image)
    plan = plan_brain_fov_crop(source, mask)
    signature, signature_payload = build_preflight_signature(
        source_path,
        source,
        margin_mm=30,
        provider={"name": "SynthStrip", "version": "1.8"},
    )

    provenance = build_brainfov_provenance(
        signature=signature,
        signature_payload=signature_payload,
        source=source,
        plan=plan,
        mask=mask,
        provider={"name": "SynthStrip", "version": "1.8"},
        helper={"name": "supraspina-brainfov", "version": "1"},
        nested_command=[
            "mri_synthstrip",
            "-i",
            "/input/t1.nii.gz",
            "-m",
            "/work/mask.nii.gz",
        ],
        validation={"sourceVoxelEquality": True},
    )

    assert provenance["signature"] == signature
    assert provenance["crop"]["start"] == list(plan.bounds.start)
    assert provenance["crop"]["stop"] == list(plan.bounds.stop)
    assert provenance["source"]["qformCode"] == source.qform_code
    assert provenance["source"]["sformCode"] == source.sform_code
    assert provenance["nestedCommand"] == [
        "mri_synthstrip",
        "-i",
        "/input/t1.nii.gz",
        "-m",
        "/work/mask.nii.gz",
    ]
    assert provenance["validation"] == {"sourceVoxelEquality": True}


def test_publish_derivative_set_commits_artifacts_immutably_and_reuses_exact_set(
    tmp_path: Path,
) -> None:
    signature = "0123456789abcdef" * 4
    paths = build_derivative_paths(
        tmp_path / "derivatives",
        tmp_path / "sub-0001_T1w.nii.gz",
        signature,
    )
    provenance = {
        "schemaVersion": 1,
        "signature": signature,
        "preflightSignature": {"source": {"sha256": "a" * 64}},
    }
    artifacts = {
        "t1": b"cropped-nifti",
        "mask": b"mask-nifti",
        "qc": b"qc-png",
    }

    first = publish_derivative_set(paths, artifacts, provenance)
    second = publish_derivative_set(paths, artifacts, provenance)

    assert first.reused is False
    assert second.reused is True
    assert paths.t1.read_bytes() == artifacts["t1"]
    assert paths.mask.read_bytes() == artifacts["mask"]
    assert paths.qc.read_bytes() == artifacts["qc"]
    committed = json.loads(paths.provenance.read_text(encoding="utf-8"))
    assert committed["signature"] == signature
    assert committed["artifacts"]["t1"]["sha256"] == first.sha256_by_role["t1"]
    dataset_description = json.loads(
        (
            tmp_path
            / "derivatives"
            / "supraspina-brainfov"
            / "dataset_description.json"
        ).read_text(encoding="utf-8")
    )
    assert dataset_description == {
        "BIDSVersion": "1.10.0",
        "DatasetType": "derivative",
        "GeneratedBy": [
            {
                "Name": "Supraspina brain-FOV preparation",
                "Version": BRAINFOV_HELPER_VERSION,
            }
        ],
        "Name": "Supraspina brain-FOV derivatives",
    }
    assert not list(paths.provenance.parent.glob(".brainfov-stage-*"))


def test_publish_derivative_set_rejects_conflicting_dataset_description(
    tmp_path: Path,
) -> None:
    signature = "1" * 64
    paths = build_derivative_paths(
        tmp_path / "derivatives",
        tmp_path / "sub-0001_T1w.nii.gz",
        signature,
    )
    dataset_root = tmp_path / "derivatives" / "supraspina-brainfov"
    dataset_root.mkdir(parents=True)
    description = dataset_root / "dataset_description.json"
    description.write_text('{"Name":"someone else"}\n', encoding="utf-8")

    with pytest.raises(
        ImmutablePublicationError,
        match="Align the brain-FOV dataset description with Supraspina metadata",
    ):
        publish_derivative_set(
            paths,
            {"qc": b"qc"},
            {"schemaVersion": 1, "signature": signature},
        )

    assert description.read_text(encoding="utf-8") == '{"Name":"someone else"}\n'
    assert not paths.qc.exists()
    assert not paths.provenance.exists()


def test_publication_verifier_requires_dataset_description(
    tmp_path: Path,
) -> None:
    signature = "2" * 64
    paths = build_derivative_paths(
        tmp_path / "derivatives",
        tmp_path / "sub-0001_T1w.nii.gz",
        signature,
    )
    publish_derivative_set(
        paths,
        {"qc": b"qc"},
        {"schemaVersion": 1, "signature": signature},
    )
    (
        tmp_path / "derivatives" / "supraspina-brainfov" / "dataset_description.json"
    ).unlink()

    with pytest.raises(
        ImmutablePublicationError,
        match="Provide the brain-FOV dataset description",
    ):
        verify_published_derivative_set(paths, ["qc"])


def test_publish_derivative_set_detects_signature_prefix_collision(
    tmp_path: Path,
) -> None:
    first_signature = "0123456789abcdef" + "0" * 48
    second_signature = "0123456789abcdef" + "f" * 48
    first_paths = build_derivative_paths(
        tmp_path / "derivatives",
        tmp_path / "sub-0001_T1w.nii.gz",
        first_signature,
    )
    second_paths = build_derivative_paths(
        tmp_path / "derivatives",
        tmp_path / "sub-0001_T1w.nii.gz",
        second_signature,
    )
    publish_derivative_set(
        first_paths,
        {"qc": b"first"},
        {"schemaVersion": 1, "signature": first_signature},
    )

    with pytest.raises(ImmutablePublicationError, match="digest collision"):
        publish_derivative_set(
            second_paths,
            {"qc": b"second"},
            {"schemaVersion": 1, "signature": second_signature},
        )
    assert second_paths.qc.read_bytes() == b"first"


def test_publish_derivative_set_rejects_tamper_and_rolls_back_link_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    signature = "f" * 64
    paths = build_derivative_paths(
        tmp_path / "derivatives",
        tmp_path / "sub-0002_T1w.nii.gz",
        signature,
    )
    provenance = {"schemaVersion": 1, "signature": signature}
    real_link = os.link
    link_calls = 0

    def fail_second_link(source: str | Path, target: str | Path) -> None:
        nonlocal link_calls
        link_calls += 1
        if link_calls == 2:
            raise OSError("Simulate a publication fault.")
        real_link(source, target)

    monkeypatch.setattr(os, "link", fail_second_link)
    with pytest.raises(ImmutablePublicationError, match="atomically"):
        publish_derivative_set(
            paths,
            {"t1": b"crop", "mask": b"mask", "qc": b"qc"},
            provenance,
        )
    assert not paths.t1.exists()
    assert not paths.mask.exists()
    assert not paths.qc.exists()
    assert not paths.provenance.exists()

    monkeypatch.setattr(os, "link", real_link)
    publish_derivative_set(paths, {"qc": b"qc"}, provenance)
    paths.qc.write_bytes(b"tampered")
    with pytest.raises(
        ImmutablePublicationError,
        match="Restore the recorded existing brain-FOV qc bytes",
    ):
        publish_derivative_set(paths, {"qc": b"qc"}, provenance)


def test_publish_derivative_set_recovers_a_verified_process_death_transaction(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    signature = "e" * 64
    paths = build_derivative_paths(
        tmp_path / "derivatives",
        tmp_path / "sub-0007_T1w.nii.gz",
        signature,
    )
    provenance = {"schemaVersion": 1, "signature": signature}
    artifacts = {"t1": b"crop", "mask": b"mask", "qc": b"qc"}
    real_link = os.link

    def interrupt_before_second_artifact(
        source: str | Path,
        target: str | Path,
    ) -> None:
        if Path(target) == paths.qc:
            raise KeyboardInterrupt
        real_link(source, target)

    monkeypatch.setattr(os, "link", interrupt_before_second_artifact)
    with pytest.raises(KeyboardInterrupt):
        publish_derivative_set(paths, artifacts, provenance)
    assert paths.mask.is_file()
    assert not paths.provenance.exists()

    monkeypatch.setattr(os, "link", real_link)
    recovered = publish_derivative_set(paths, artifacts, provenance)

    assert recovered.reused is False
    assert paths.t1.read_bytes() == b"crop"
    assert paths.mask.read_bytes() == b"mask"
    assert paths.qc.read_bytes() == b"qc"
    assert paths.provenance.is_file()
    assert not list(paths.provenance.parent.glob(".brainfov-publish-*"))


def test_prepare_cli_pass_through_skips_synthstrip_and_reuses_publication(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    raw = tmp_path / "rawdata" / "sub-0003" / "anat"
    raw.mkdir(parents=True)
    source_path = _write_nifti(
        raw / "sub-0003_acq-small_T1w.nii.gz",
        shape=(64, 60, 56),
        datatype=2,
    )
    original_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
    derivatives = tmp_path / "derivatives"
    arguments = [
        "prepare",
        "--input",
        str(source_path),
        "--derivatives-root",
        str(derivatives),
        "--margin-mm",
        "30",
        "--provider-json",
        _provider_json(),
        "--helper-json",
        _helper_json(),
        "--synthstrip-executable",
        str(tmp_path / "does-not-exist"),
    ]

    assert cli_main(arguments) == 0
    first_output = capsys.readouterr()
    assert first_output.err == ""
    first = json.loads(first_output.out)
    assert first["mode"] == "passThrough"
    assert first["reused"] is False
    assert set(first["artifacts"]) == {"qc"}
    assert not any(derivatives.rglob("*_mask.nii.gz"))
    assert not any(derivatives.rglob("*_desc-brainfov*_T1w.nii.gz"))
    provenance_path = Path(first["provenance"]["path"])
    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    assert provenance["nestedCommand"] == []
    assert provenance["crop"]["passThrough"] is True
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == original_hash

    assert cli_main(arguments) == 0
    second = json.loads(capsys.readouterr().out)
    assert second["reused"] is True
    assert second["signature"] == first["signature"]


def test_prepare_cli_crop_runs_exact_cpu_command_and_publishes_set(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    raw = tmp_path / "rawdata" / "sub-0004" / "ses-baseline" / "anat"
    raw.mkdir(parents=True)
    source_path = _write_nifti(
        raw / "sub-0004_ses-baseline_acq-prisma_T1w.nii.gz",
        shape=(280, 60, 60),
        datatype=4,
    )
    derivatives = tmp_path / "derivatives"
    stub = _write_synthstrip_stub(tmp_path / "mri_synthstrip")
    arguments = [
        "prepare",
        "--input",
        str(source_path),
        "--derivatives-root",
        str(derivatives),
        "--margin-mm",
        "30",
        "--provider-json",
        _provider_json(),
        "--helper-json",
        _helper_json(),
        "--synthstrip-executable",
        str(stub),
        "--threads",
        "4",
    ]

    assert cli_main(arguments) == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    assert len(captured.out.strip().splitlines()) == 1
    result = json.loads(captured.out)
    assert result["mode"] == "crop"
    assert result["reused"] is False
    assert set(result["artifacts"]) == {"t1", "mask", "qc"}
    provenance = json.loads(
        Path(result["provenance"]["path"]).read_text(encoding="utf-8")
    )
    command = provenance["nestedCommand"]
    assert command[0] == str(stub)
    assert command[1:3] == ["-i", str(source_path)]
    assert command[-2:] == ["-t", "4"]
    assert command[3] == "-o"
    assert command[5] == "-m"
    assert provenance["provider"] == SYNTHSTRIP_PROVIDER_IDENTITY
    assert provenance["validation"]["sourceVoxelEquality"] is True
    cropped = read_nifti(Path(result["artifacts"]["t1"]["path"]))
    assert cropped.shape == (200, 60, 60)
    assert cropped.qform_code == 0
    assert cropped.sform_code == 1
    assert not (derivatives / "supraspina-brainfov" / ".work").exists()

    _write_synthstrip_stub(stub, exit_code=9)
    assert cli_main(arguments) == 0
    reused = json.loads(capsys.readouterr().out)
    assert reused["reused"] is True
    assert reused["signature"] == result["signature"]


def test_prepare_cli_reports_nested_failure_without_partial_publication(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    raw = tmp_path / "rawdata" / "sub-0005" / "anat"
    raw.mkdir(parents=True)
    source_path = _write_nifti(
        raw / "sub-0005_T1w.nii.gz",
        shape=(280, 60, 60),
        datatype=2,
    )
    derivatives = tmp_path / "derivatives"
    stub = _write_synthstrip_stub(tmp_path / "mri_synthstrip", exit_code=7)

    exit_code = cli_main(
        [
            "prepare",
            "--input",
            str(source_path),
            "--derivatives-root",
            str(derivatives),
            "--margin-mm",
            "30",
            "--provider-json",
            _provider_json(),
            "--helper-json",
            _helper_json(),
            "--synthstrip-executable",
            str(stub),
        ]
    )

    assert exit_code == 1
    captured = capsys.readouterr()
    assert len(captured.out.strip().splitlines()) == 1
    result = json.loads(captured.out)
    assert result == {
        "error": {
            "code": "BRAINFOV_PREPARE_FAILED",
            "message": "Resolve SynthStrip exit status 7.",
        },
        "ok": False,
    }
    assert not list(derivatives.rglob("*.json"))
    assert not list(derivatives.rglob("*.nii.gz"))


def test_synthstrip_subprocess_retains_only_required_container_python_env(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    monkeypatch.setenv("FREESURFER_HOME", "/freesurfer")
    monkeypatch.setenv("PYTHONUSERBASE", "/freesurfer/env")
    monkeypatch.setenv("LD_LIBRARY_PATH", "/.singularity.d/libs")
    monkeypatch.setenv("UNRELATED_CONTAINER_ENV", "must-not-leak")

    def fake_run(*args: Any, **kwargs: Any) -> Any:
        captured.update(kwargs)
        return type("Completed", (), {"returncode": 0})()

    monkeypatch.setattr(brainfov_module.subprocess, "run", fake_run)

    brainfov_module._run_synthstrip(
        ["mri_synthstrip", "--help"],
        work_directory=tmp_path,
        threads=6,
    )

    environment = captured["env"]
    assert environment["FREESURFER_HOME"] == "/freesurfer"
    assert environment["PYTHONUSERBASE"] == "/freesurfer/env"
    assert environment["LD_LIBRARY_PATH"] == "/.singularity.d/libs"
    assert environment["TMPDIR"] == str(tmp_path)
    assert environment["OMP_NUM_THREADS"] == "6"
    assert "UNRELATED_CONTAINER_ENV" not in environment


def test_prepare_cli_rejects_unbounded_threads_as_json(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = cli_main(
        [
            "prepare",
            "--input",
            "/input/sub-01_T1w.nii.gz",
            "--derivatives-root",
            "/output",
            "--margin-mm",
            "30",
            "--provider-json",
            _provider_json(),
            "--helper-json",
            _helper_json(),
            "--threads",
            "33",
        ]
    )

    assert exit_code == 1
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is False
    assert result["error"]["code"] == "BRAINFOV_PREPARE_FAILED"
    assert "Provide valid brain-FOV helper arguments" in result["error"]["message"]


def test_read_nifti_rejects_a_damaged_deflate_body(tmp_path: Path) -> None:
    """Translate a zlib failure into the documented validation error."""
    source = _write_nifti(tmp_path / "input.nii")
    payload = source.read_bytes()
    compressed = bytearray(gzip.compress(payload, mtime=0))
    # Flip the first deflate byte so zlib rejects the code lengths. zlib.error
    # is not an OSError, so it must be translated explicitly.
    compressed[10] ^= 0xFF
    damaged = tmp_path / "input.nii.gz"
    damaged.write_bytes(bytes(compressed))

    with pytest.raises(NiftiValidationError):
        read_nifti(damaged)


def test_build_derivative_paths_names_a_non_bids_source_after_the_subject(
    tmp_path: Path,
) -> None:
    # The configured T1 pattern may select any NIfTI name; the discovered
    # subject supplies the derivative entities then.
    source = tmp_path / "sub-101" / "4_t1_mprage_sag_p2_brainSpine_FOV375_1.3iso.nii.gz"
    paths = build_derivative_paths(
        tmp_path / "derivatives", source, "a" * 64, subject_id="sub-101"
    )
    assert paths.t1 == (
        tmp_path
        / "derivatives"
        / "supraspina-brainfov"
        / "sub-101"
        / "anat"
        / f"sub-101_desc-brainfov{'a' * 16}_T1w.nii.gz"
    )
    assert paths.provenance.name == f"sub-101_desc-brainfov{'a' * 16}_T1w.json"
    # A BIDS name keeps its own entities even when the subject is supplied.
    bids = build_derivative_paths(
        tmp_path / "derivatives",
        tmp_path / "sub-101_ses-a_T1w.nii.gz",
        "a" * 64,
        subject_id="sub-101",
    )
    assert bids.t1.name == f"sub-101_ses-a_desc-brainfov{'a' * 16}_T1w.nii.gz"
    # Without a subject, or with an unsafe one, a non-BIDS name is rejected.
    with pytest.raises(BrainFovError):
        build_derivative_paths(tmp_path / "derivatives", source, "a" * 64)
    for bad in ("101", "sub-", "sub-1_01", "sub-1/01"):
        with pytest.raises(BrainFovError):
            build_derivative_paths(
                tmp_path / "derivatives", source, "a" * 64, subject_id=bad
            )
    with pytest.raises(BrainFovError):
        build_derivative_paths(
            tmp_path / "derivatives", tmp_path / "sub-101.zip", "a" * 64, "sub-101"
        )


def test_helper_runs_as_a_standalone_script() -> None:
    # The staged helper is executed as a plain script inside the SynthStrip
    # container, where the package is not importable; a relative import would
    # fail before any argument is parsed.
    helper = Path(brainfov_module.__file__)
    completed = subprocess.run(  # noqa: S603
        [sys.executable, str(helper), "prepare", "--help"],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(helper.parent.parent.parent),
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert "--subject" in completed.stdout
