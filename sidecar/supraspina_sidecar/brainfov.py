"""Fail-closed brain-FOV preparation primitives.

The managed brain-FOV container uses this module for deterministic NIfTI-1
validation, mask inspection, crop planning, encoded-voxel slicing, QC montage
generation, and immutable derivative publication. It depends only on the Python
standard library so the host sidecar does not acquire a second scientific
Python runtime.
"""

from __future__ import annotations

import argparse
import binascii
import gzip
import hashlib
import io
import json
import math
import os
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import zlib
from array import array
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAXIMUM_FOV_MM = 256.0
MINIMUM_MARGIN_MM = 15.0
DEFAULT_MARGIN_MM = 30
DOMINANT_COMPONENT_FRACTION = 0.90
AFFINE_ABSOLUTE_TOLERANCE = 1e-4
BRAINFOV_HELPER_VERSION = "1"
BIDS_VERSION = "1.10.0"
SYNTHSTRIP_PROVIDER_IDENTITY: dict[str, Any] = {
    "name": "SynthStrip",
    "version": "1.8",
    "platform": "linux/amd64",
    "ociManifestDigest": (
        "sha256:ebbc177221194371f16362513ace68312a22922bb581bdfa618ac7ff9c1d2c06"
    ),
    "apptainerVersion": "1.5.3",
    "sifSize": 382_562_304,
    "sifSha256": "f7faaccded4806780dc27172cd09bdaeffb48164c40edb3996fbec6a4829bfca",
    "model": {
        "name": "synthstrip.1",
        "containerPath": "/freesurfer/models/synthstrip.1.pt",
        "size": 30_851_709,
        "sha256": ("37417f802196186441aae3e7f385d94f8a98c64a88acaeaa2723af995c653e33"),
    },
}
#: NIfTI-1 stores pixdim and the qform/sform rows as IEEE-754 binary32, so a
#: nominally exact spacing such as 0.8 mm arrives already rounded to a relative
#: error of at most 2**-24. Multiplying by the voxel count carries that relative
#: error into the physical FOV, which makes a mathematically nominal 256 mm
#: acquisition (0.8 mm by 320) measure 256.0000038 mm. Compare physical lengths
#: with one binary32 unit in the last place at the compared scale, which safely
#: covers that quantization plus the negligible float64 norm and product
#: rounding. At the 256 mm limit the slack is about 30 nm, far below any
#: acquisition or geometry difference the detector is meant to see.
_FLOAT32_ULP_RELATIVE = 2.0**-23
#: Retain an absolute floor so comparisons against zero-scale clearances stay
#: stable.
_FOV_TOLERANCE = 1e-6


def _length_tolerance_mm(*lengths: float) -> float:
    """Return the binary32 representation slack for one physical comparison."""
    scale = max((abs(value) for value in lengths), default=0.0)
    return max(_FOV_TOLERANCE, scale * _FLOAT32_ULP_RELATIVE)


def fov_within_limit(
    fov_mm: Iterable[float], maximum_fov_mm: float = MAXIMUM_FOV_MM
) -> bool:
    """Return whether every axis spans at most the physical FOV limit.

    Accept a length whose only excess is the binary32 representation error of the
    stored spacing; reject any genuinely larger acquisition.
    """
    tolerance = _length_tolerance_mm(maximum_fov_mm)
    return all(value <= maximum_fov_mm + tolerance for value in fov_mm)


_MAX_NIFTI_BYTES = 2 * 1024 * 1024 * 1024
_MONTAGE_GAP_PIXELS = 8
_CROP_BOUNDARY_RGB = (255, 210, 0)
_BACKGROUND_RGB = (20, 24, 28)
_NIFTI1_HEADER_BYTES = 348
_NIFTI1_MINIMUM_OFFSET = 352
_NIFTI_SPATIAL_DIMENSIONS = 3
_MINIMUM_DOMINANT_FRACTION = 0.5
_MINIMUM_CONFIGURED_MARGIN_MM = 15
_MAXIMUM_CONFIGURED_MARGIN_MM = 60
_SHA256_HEX_LENGTH = 64
_BIDS_ENTITY_PREFIX_LENGTH = 4
_MINIMUM_PANEL_PIXELS = 32
_MAXIMUM_PANEL_PIXELS = 1024
_MINIMUM_SYNTHSTRIP_THREADS = 1
_MAXIMUM_SYNTHSTRIP_THREADS = 32
_DEFAULT_SYNTHSTRIP_THREADS = 6
_MAXIMUM_IDENTITY_JSON_BYTES = 16 * 1024
_MAXIMUM_RESULT_JSON_BYTES = 64 * 1024
_MAXIMUM_PUBLICATION_TRANSACTION_BYTES = 64 * 1024
_MAXIMUM_PROVENANCE_BYTES = 256 * 1024
_MAXIMUM_ERROR_MESSAGE_CHARACTERS = 512
_MAXIMUM_EXECUTABLE_CHARACTERS = 4096
_SYNTHSTRIP_TIMEOUT_SECONDS = 4 * 60 * 60
_DATASET_DESCRIPTION = {
    "Name": "Supraspina brain-FOV derivatives",
    "BIDSVersion": BIDS_VERSION,
    "DatasetType": "derivative",
    "GeneratedBy": [
        {
            "Name": "Supraspina brain-FOV preparation",
            "Version": BRAINFOV_HELPER_VERSION,
        }
    ],
}

Affine = tuple[
    tuple[float, float, float, float],
    tuple[float, float, float, float],
    tuple[float, float, float, float],
    tuple[float, float, float, float],
]

_SCALAR_DATATYPES: dict[int, tuple[str, int]] = {
    2: ("B", 8),
    4: ("h", 16),
    8: ("i", 32),
    16: ("f", 32),
    64: ("d", 64),
    256: ("b", 8),
    512: ("H", 16),
    768: ("I", 32),
    1024: ("q", 64),
    1280: ("Q", 64),
}


class BrainFovError(RuntimeError):
    """Represent the base error for brain-FOV preparation."""


class NiftiValidationError(BrainFovError):
    """Raise when an input is not a supported, valid 3-D NIfTI image."""


class MaskValidationError(BrainFovError):
    """Raise when a SynthStrip mask is unsafe to use for cropping."""


class CropPlanningError(BrainFovError):
    """Raise when the brain cannot fit within the fixed crop policy."""


class SynthStripExecutionError(BrainFovError):
    """Raise when the pinned SynthStrip process cannot produce a valid mask."""


class ImmutablePublicationError(BrainFovError):
    """Raise when an immutable derivative set cannot be published safely."""


@dataclass(frozen=True)
class VoxelBounds:
    """Represent half-open three-dimensional voxel bounds."""

    start: tuple[int, int, int]
    stop: tuple[int, int, int]

    def __post_init__(self) -> None:
        """Validate the half-open bounds."""
        if any(
            start < 0 or stop <= start
            for start, stop in zip(self.start, self.stop, strict=True)
        ):
            raise ValueError("Provide positive, non-empty voxel-bound intervals.")

    @property
    def shape(self) -> tuple[int, int, int]:
        """Return the extent of the bounds along each voxel axis."""
        return tuple(
            stop - start for start, stop in zip(self.start, self.stop, strict=True)
        )


@dataclass(frozen=True)
class NiftiImage:
    """Represent a validated single-file scalar three-dimensional NIfTI-1 image."""

    path: Path
    endian: str
    shape: tuple[int, int, int]
    datatype: int
    bitpix: int
    bytes_per_voxel: int
    vox_offset: int
    affine: Affine
    qform_code: int
    sform_code: int
    qform_affine: Affine | None
    sform_affine: Affine | None
    scl_slope: float
    scl_inter: float
    voxel_bytes: bytes
    compressed: bool
    _prefix: bytes

    @property
    def voxel_spacing_mm(self) -> tuple[float, float, float]:
        """Return physical step lengths from the affine column norms."""
        return _column_norms(self.affine)

    @property
    def fov_mm(self) -> tuple[float, float, float]:
        """Return physical FOV lengths along the three voxel axes."""
        return tuple(
            dimension * spacing
            for dimension, spacing in zip(
                self.shape,
                self.voxel_spacing_mm,
                strict=True,
            )
        )


@dataclass(frozen=True)
class MaskSummary:
    """Represent a validated mask bounding box and component evidence."""

    bounds: VoxelBounds
    nonzero_voxels: int
    largest_component_voxels: int
    component_count: int
    dominant_fraction: float

    def to_dict(self) -> dict[str, Any]:
        """Return the stable JSON representation of the mask evidence."""
        return {
            "bounds": {
                "start": list(self.bounds.start),
                "stop": list(self.bounds.stop),
            },
            "nonzeroVoxels": self.nonzero_voxels,
            "largestComponentVoxels": self.largest_component_voxels,
            "componentCount": self.component_count,
            "dominantFraction": self.dominant_fraction,
        }


@dataclass(frozen=True)
class CropPlan:
    """Represent a deterministic pass-through or crop decision."""

    pass_through: bool
    bounds: VoxelBounds
    source_fov_mm: tuple[float, float, float]
    output_fov_mm: tuple[float, float, float]
    requested_margin_mm: int
    minimum_margin_mm: float
    maximum_fov_mm: float
    face_clearance_mm: tuple[float, float, float, float, float, float] | None
    capped_axes: tuple[bool, bool, bool]

    def to_dict(self) -> dict[str, Any]:
        """Return the stable JSON representation of the crop decision."""
        return {
            "passThrough": self.pass_through,
            "start": list(self.bounds.start),
            "stop": list(self.bounds.stop),
            "shape": list(self.bounds.shape),
            "sourceFovMm": list(self.source_fov_mm),
            "outputFovMm": list(self.output_fov_mm),
            "requestedMarginMm": self.requested_margin_mm,
            "minimumMarginMm": self.minimum_margin_mm,
            "maximumFovMm": self.maximum_fov_mm,
            "faceClearanceMm": (
                list(self.face_clearance_mm)
                if self.face_clearance_mm is not None
                else None
            ),
            "cappedAxes": list(self.capped_axes),
        }


@dataclass(frozen=True)
class DerivativePaths:
    """Represent immutable BIDS-derivative paths for one preflight digest."""

    signature: str
    descriptor: str
    t1: Path
    mask: Path
    qc: Path
    provenance: Path

    def by_role(self) -> dict[str, Path]:
        """Return artifact roles and their paths, excluding provenance."""
        return {"t1": self.t1, "mask": self.mask, "qc": self.qc}


@dataclass(frozen=True)
class QcMontage:
    """Represent deterministic 2-by-3 QC montage bytes and layout metadata."""

    png: bytes
    width: int
    height: int
    layout: dict[str, Any]
    sha256: str


@dataclass(frozen=True)
class PublicationResult:
    """Represent the result of an immutable derivative publication."""

    reused: bool
    sha256_by_role: dict[str, str]
    provenance_sha256: str


def _read_bounded_payload(path: Path) -> tuple[bytes, bool]:
    try:
        encoded = read_bounded_regular(path, _MAX_NIFTI_BYTES)
        compressed = encoded[:2] == b"\x1f\x8b"
        if compressed:
            # Use the ceiling as the only available bound when a compressed file
            # cannot declare its decompressed size reliably.
            decoded = bytearray()
            remaining = _MAX_NIFTI_BYTES + 1
            with gzip.GzipFile(fileobj=io.BytesIO(encoded), mode="rb") as handle:
                while remaining > 0:
                    chunk = handle.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    decoded.extend(chunk)
                    remaining -= len(chunk)
            payload = bytes(decoded)
        else:
            payload = encoded
    except (OSError, EOFError, gzip.BadGzipFile, zlib.error) as exc:
        raise NiftiValidationError("Provide a readable NIfTI file.") from exc
    if len(payload) > _MAX_NIFTI_BYTES:
        raise NiftiValidationError(
            "Keep the NIfTI file within the bounded reader limit."
        )
    return payload, compressed


def _header_endian(payload: bytes) -> str:
    if len(payload) < _NIFTI1_MINIMUM_OFFSET:
        raise NiftiValidationError(
            "Provide a complete NIfTI header and extension flag."
        )
    if struct.unpack_from("<i", payload, 0)[0] == _NIFTI1_HEADER_BYTES:
        return "<"
    if struct.unpack_from(">i", payload, 0)[0] == _NIFTI1_HEADER_BYTES:
        return ">"
    raise NiftiValidationError("Use a supported NIfTI-1 header.")


def _determinant3(matrix: Affine) -> float:
    a, b, c = matrix[0][:3]
    d, e, f = matrix[1][:3]
    g, h, i = matrix[2][:3]
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)


def _affine_is_valid(affine: Affine) -> bool:
    return all(
        math.isfinite(value) for row in affine for value in row
    ) and not math.isclose(
        _determinant3(affine),
        0.0,
        abs_tol=1e-12,
    )


def _sform_affine(payload: bytes, endian: str) -> Affine:
    rows = tuple(
        tuple(
            float(value) for value in struct.unpack_from(f"{endian}4f", payload, offset)
        )
        for offset in (280, 296, 312)
    )
    return (rows[0], rows[1], rows[2], (0.0, 0.0, 0.0, 1.0))


def _qform_affine(payload: bytes, endian: str) -> Affine:
    pixdim = struct.unpack_from(f"{endian}8f", payload, 76)
    b_value, c_value, d_value = struct.unpack_from(f"{endian}3f", payload, 256)
    qoffset = struct.unpack_from(f"{endian}3f", payload, 268)
    if not all(
        math.isfinite(value)
        for value in (*pixdim[:4], b_value, c_value, d_value, *qoffset)
    ):
        raise ValueError("Provide finite qform values.")
    if any(value <= 0 for value in pixdim[1:4]):
        raise ValueError("Provide positive qform voxel sizes.")
    quaternion_norm = b_value**2 + c_value**2 + d_value**2
    if quaternion_norm > 1.0 + 1e-5:
        raise ValueError("Provide a valid qform quaternion.")
    a_value = math.sqrt(max(0.0, 1.0 - quaternion_norm))
    qfac = -1.0 if pixdim[0] < 0 else 1.0
    rotation = (
        (
            a_value * a_value
            + b_value * b_value
            - c_value * c_value
            - d_value * d_value,
            2.0 * (b_value * c_value - a_value * d_value),
            2.0 * (b_value * d_value + a_value * c_value),
        ),
        (
            2.0 * (b_value * c_value + a_value * d_value),
            a_value * a_value
            + c_value * c_value
            - b_value * b_value
            - d_value * d_value,
            2.0 * (c_value * d_value - a_value * b_value),
        ),
        (
            2.0 * (b_value * d_value - a_value * c_value),
            2.0 * (c_value * d_value + a_value * b_value),
            a_value * a_value
            + d_value * d_value
            - c_value * c_value
            - b_value * b_value,
        ),
    )
    scales = (pixdim[1], pixdim[2], pixdim[3] * qfac)
    rows = tuple(
        (
            *(rotation[row][column] * scales[column] for column in range(3)),
            float(qoffset[row]),
        )
        for row in range(3)
    )
    return (rows[0], rows[1], rows[2], (0.0, 0.0, 0.0, 1.0))


def _active_affines(
    payload: bytes,
    endian: str,
    qform_code: int,
    sform_code: int,
) -> tuple[Affine, Affine | None, Affine | None]:
    qform: Affine | None = None
    sform: Affine | None = None
    if sform_code > 0:
        candidate = _sform_affine(payload, endian)
        if _affine_is_valid(candidate):
            sform = candidate
    if qform_code > 0:
        try:
            candidate = _qform_affine(payload, endian)
        except ValueError:
            candidate = None
        if candidate is not None and _affine_is_valid(candidate):
            qform = candidate
    selected = sform or qform
    if selected is None:
        raise NiftiValidationError(
            "Provide a valid qform or sform with a finite, nonsingular affine."
        )
    return selected, qform, sform


def read_nifti(path: str | Path) -> NiftiImage:
    """Read and validate a scalar, single-volume, 3-D NIfTI-1 image.

    Parameters
    ----------
    path
        Provide a single-file ``.nii`` or gzip-compressed ``.nii.gz`` image.

    Returns
    -------
    NiftiImage
        Return parsed header geometry and the exact encoded voxel bytes.

    Raises
    ------
    NiftiValidationError
        Raise when the file is unreadable, malformed, unsupported, truncated, or
        lacks a finite nonsingular qform or sform.
    """
    source_path = Path(path)
    payload, compressed = _read_bounded_payload(source_path)
    endian = _header_endian(payload)
    if payload[344:348] != b"n+1\x00":
        raise NiftiValidationError("Use the single-file NIfTI n+1 layout.")
    dimensions = struct.unpack_from(f"{endian}8h", payload, 40)
    if dimensions[0] != _NIFTI_SPATIAL_DIMENSIONS or any(
        value <= 0 for value in dimensions[1:4]
    ):
        raise NiftiValidationError("Provide a single-volume 3-D NIfTI image.")
    shape = (dimensions[1], dimensions[2], dimensions[3])
    datatype = struct.unpack_from(f"{endian}h", payload, 70)[0]
    if datatype not in _SCALAR_DATATYPES:
        raise NiftiValidationError("Use a supported NIfTI scalar datatype.")
    _format, expected_bitpix = _SCALAR_DATATYPES[datatype]
    bitpix = struct.unpack_from(f"{endian}h", payload, 72)[0]
    if bitpix != expected_bitpix:
        raise NiftiValidationError("Align the NIfTI datatype with its bit depth.")
    vox_offset_float = struct.unpack_from(f"{endian}f", payload, 108)[0]
    if (
        not math.isfinite(vox_offset_float)
        or vox_offset_float < _NIFTI1_MINIMUM_OFFSET
        or not math.isclose(vox_offset_float, round(vox_offset_float), abs_tol=1e-3)
    ):
        raise NiftiValidationError("Provide a valid NIfTI voxel offset.")
    vox_offset = round(vox_offset_float)
    voxel_count = math.prod(shape)
    bytes_per_voxel = bitpix // 8
    expected_bytes = voxel_count * bytes_per_voxel
    if vox_offset + expected_bytes > len(payload):
        raise NiftiValidationError("Provide a complete NIfTI voxel payload.")
    qform_code = struct.unpack_from(f"{endian}h", payload, 252)[0]
    sform_code = struct.unpack_from(f"{endian}h", payload, 254)[0]
    affine, qform_affine, sform_affine = _active_affines(
        payload,
        endian,
        qform_code,
        sform_code,
    )
    scl_slope = float(struct.unpack_from(f"{endian}f", payload, 112)[0])
    scl_inter = float(struct.unpack_from(f"{endian}f", payload, 116)[0])
    return NiftiImage(
        path=source_path,
        endian=endian,
        shape=shape,
        datatype=datatype,
        bitpix=bitpix,
        bytes_per_voxel=bytes_per_voxel,
        vox_offset=vox_offset,
        affine=affine,
        qform_code=qform_code,
        sform_code=sform_code,
        qform_affine=qform_affine,
        sform_affine=sform_affine,
        scl_slope=scl_slope,
        scl_inter=scl_inter,
        voxel_bytes=payload[vox_offset : vox_offset + expected_bytes],
        compressed=compressed,
        _prefix=payload[:vox_offset],
    )


def _column_norms(affine: Affine) -> tuple[float, float, float]:
    return tuple(
        math.sqrt(sum(affine[row][column] ** 2 for row in range(3)))
        for column in range(3)
    )


def _iter_scaled_values(image: NiftiImage) -> Iterator[float]:
    value_format = _SCALAR_DATATYPES[image.datatype][0]
    slope = image.scl_slope
    intercept = image.scl_inter
    apply_scaling = math.isfinite(slope) and slope != 0.0
    if not math.isfinite(intercept):
        intercept = 0.0
    for (raw_value,) in struct.iter_unpack(
        f"{image.endian}{value_format}",
        image.voxel_bytes,
    ):
        value = float(raw_value)
        yield value * slope + intercept if apply_scaling else value


def _affines_close(first: Affine, second: Affine) -> bool:
    return all(
        math.isclose(
            first[row][column],
            second[row][column],
            rel_tol=0.0,
            abs_tol=AFFINE_ABSOLUTE_TOLERANCE,
        )
        for row in range(4)
        for column in range(4)
    )


def _component_evidence(
    nonzero: bytearray,
    shape: tuple[int, int, int],
) -> tuple[int, int, tuple[int, int, int], tuple[int, int, int]]:
    size_x, size_y, size_z = shape
    plane = size_x * size_y
    component_count = 0
    largest_count = 0
    largest_start = (0, 0, 0)
    largest_stop = (0, 0, 0)
    search_start = 0
    while (seed := nonzero.find(b"\x01", search_start)) >= 0:
        component_count += 1
        search_start = seed + 1
        nonzero[seed] = 0
        stack = array("I", [seed])
        count = 0
        minimum = [size_x, size_y, size_z]
        maximum = [-1, -1, -1]
        while stack:
            index = stack.pop()
            count += 1
            z_index, within_plane = divmod(index, plane)
            y_index, x_index = divmod(within_plane, size_x)
            coordinates = (x_index, y_index, z_index)
            for axis, coordinate in enumerate(coordinates):
                minimum[axis] = min(minimum[axis], coordinate)
                maximum[axis] = max(maximum[axis], coordinate)
            if x_index > 0 and nonzero[index - 1]:
                nonzero[index - 1] = 0
                stack.append(index - 1)
            if x_index + 1 < size_x and nonzero[index + 1]:
                nonzero[index + 1] = 0
                stack.append(index + 1)
            if y_index > 0 and nonzero[index - size_x]:
                nonzero[index - size_x] = 0
                stack.append(index - size_x)
            if y_index + 1 < size_y and nonzero[index + size_x]:
                nonzero[index + size_x] = 0
                stack.append(index + size_x)
            if z_index > 0 and nonzero[index - plane]:
                nonzero[index - plane] = 0
                stack.append(index - plane)
            if z_index + 1 < size_z and nonzero[index + plane]:
                nonzero[index + plane] = 0
                stack.append(index + plane)
        if count > largest_count:
            largest_count = count
            largest_start = tuple(minimum)
            largest_stop = tuple(value + 1 for value in maximum)
    return component_count, largest_count, largest_start, largest_stop


def validate_brain_mask(
    source: NiftiImage,
    mask: NiftiImage,
    *,
    minimum_dominant_fraction: float = DOMINANT_COMPONENT_FRACTION,
) -> MaskSummary:
    """Validate mask geometry and require one dominant 6-connected component.

    Parameters
    ----------
    source
        Provide the validated source T1 image.
    mask
        Provide the validated scalar mask image.
    minimum_dominant_fraction
        Provide the minimum fraction of nonzero voxels that must belong to the
        largest 6-connected component.

    Returns
    -------
    MaskSummary
        Return bounding-box and connected-component evidence for the dominant brain.

    Raises
    ------
    MaskValidationError
        Raise when geometry differs, values are non-finite, the mask is empty, or
        no component is sufficiently dominant.
    """
    if source.shape != mask.shape:
        raise MaskValidationError("Match the brain mask shape to the source.")
    if not _affines_close(source.affine, mask.affine):
        raise MaskValidationError("Match the brain mask affine to the source.")
    if not _MINIMUM_DOMINANT_FRACTION < minimum_dominant_fraction <= 1.0:
        raise ValueError("Set the minimum dominant fraction within (0.5, 1.0].")
    nonzero = bytearray(math.prod(source.shape))
    nonzero_voxels = 0
    for index, value in enumerate(_iter_scaled_values(mask)):
        if not math.isfinite(value):
            raise MaskValidationError("Remove non-finite values from the brain mask.")
        if value != 0.0:
            nonzero[index] = 1
            nonzero_voxels += 1
    if nonzero_voxels == 0:
        raise MaskValidationError("Provide a non-empty brain mask.")
    component_count, largest_count, start, stop = _component_evidence(
        nonzero,
        source.shape,
    )
    dominant_fraction = largest_count / nonzero_voxels
    if dominant_fraction < minimum_dominant_fraction:
        raise MaskValidationError(
            "Provide one dominant connected component in the brain mask."
        )
    return MaskSummary(
        bounds=VoxelBounds(start, stop),
        nonzero_voxels=nonzero_voxels,
        largest_component_voxels=largest_count,
        component_count=component_count,
        dominant_fraction=dominant_fraction,
    )


def _maximum_voxels(spacing_mm: float, maximum_fov_mm: float) -> int:
    tolerance = _length_tolerance_mm(maximum_fov_mm)
    count = math.floor((maximum_fov_mm + tolerance) / spacing_mm)
    while count > 0 and count * spacing_mm > maximum_fov_mm + tolerance:
        count -= 1
    return count


def _bounded_crop_axis(  # noqa: PLR0913
    dimension: int,
    spacing_mm: float,
    brain_start: int,
    brain_stop: int,
    margin_mm: int,
    minimum_margin_mm: float,
    maximum_fov_mm: float,
) -> tuple[int, int, bool]:
    requested_padding = math.ceil(margin_mm / spacing_mm)
    requested_start = max(0, brain_start - requested_padding)
    requested_stop = min(dimension, brain_stop + requested_padding)
    maximum_voxels = _maximum_voxels(spacing_mm, maximum_fov_mm)
    requested_width = requested_stop - requested_start
    if requested_width <= maximum_voxels:
        return requested_start, requested_stop, False
    minimum_padding = math.ceil((minimum_margin_mm - _FOV_TOLERANCE) / spacing_mm)
    if brain_start < minimum_padding or dimension - brain_stop < minimum_padding:
        raise CropPlanningError(
            f"Retain {minimum_margin_mm:g} mm around both brain mask crop faces."
        )
    minimum_width = brain_stop - brain_start + 2 * minimum_padding
    if maximum_voxels < minimum_width:
        raise CropPlanningError(
            f"Fit the brain plus {minimum_margin_mm:g} mm minimum margins within "
            f"{maximum_fov_mm:g} mm."
        )
    width = min(dimension, maximum_voxels)
    earliest_start = max(0, brain_stop + minimum_padding - width)
    latest_start = min(brain_start - minimum_padding, dimension - width)
    if earliest_start > latest_start:
        raise CropPlanningError(
            f"Retain {minimum_margin_mm:g} mm around both brain mask crop faces."
        )
    requested_center = (requested_start + requested_stop) / 2.0
    centered_start = math.floor(requested_center - width / 2.0 + 0.5)
    crop_start = min(max(centered_start, earliest_start), latest_start)
    return crop_start, crop_start + width, True


def _clearance_satisfies_crop_policy(
    face_clearance_mm: tuple[float, float, float, float, float, float],
    capped_axes: tuple[bool, bool, bool],
    minimum_margin_mm: float,
) -> bool:
    """Return whether all crop faces meet the cap-aware clearance policy."""
    if any(capped_axes):
        tolerance = _length_tolerance_mm(minimum_margin_mm, *face_clearance_mm)
        return all(
            value + tolerance >= minimum_margin_mm for value in face_clearance_mm
        )
    return all(value > _FOV_TOLERANCE for value in face_clearance_mm)


def plan_brain_fov_crop(
    source: NiftiImage,
    mask: MaskSummary | None = None,
    *,
    margin_mm: int = DEFAULT_MARGIN_MM,
    minimum_margin_mm: float = MINIMUM_MARGIN_MM,
    maximum_fov_mm: float = MAXIMUM_FOV_MM,
) -> CropPlan:
    """Plan a pass-through or bounded brain crop in source voxel coordinates.

    Parameters
    ----------
    source
        Provide the validated source T1 image.
    mask
        Provide dominant-component mask evidence when the source exceeds the
        maximum FOV.
    margin_mm
        Provide the requested physical margin per crop face.
    minimum_margin_mm
        Provide the minimum physical clearance permitted when capping a crop.
    maximum_fov_mm
        Provide the maximum physical FOV along every output voxel axis.

    Returns
    -------
    CropPlan
        Return deterministic half-open crop bounds and physical validation evidence.

    Raises
    ------
    CropPlanningError
        Raise when a mask is required or the brain plus minimum margins cannot fit.
    ValueError
        Raise when policy parameters are outside their supported ranges.
    """
    if not isinstance(margin_mm, int) or isinstance(margin_mm, bool):
        raise ValueError("Provide an integer brain-FOV margin.")
    if not (
        _MINIMUM_CONFIGURED_MARGIN_MM <= margin_mm <= _MAXIMUM_CONFIGURED_MARGIN_MM
    ):
        raise ValueError("Set the brain-FOV margin from 15 to 60 mm.")
    if minimum_margin_mm <= 0 or maximum_fov_mm <= 0:
        raise ValueError("Provide positive brain-FOV physical limits.")
    source_fov = source.fov_mm
    full_bounds = VoxelBounds((0, 0, 0), source.shape)
    fov_tolerance = _length_tolerance_mm(maximum_fov_mm)
    if fov_within_limit(source_fov, maximum_fov_mm):
        return CropPlan(
            pass_through=True,
            bounds=full_bounds,
            source_fov_mm=source_fov,
            output_fov_mm=source_fov,
            requested_margin_mm=margin_mm,
            minimum_margin_mm=minimum_margin_mm,
            maximum_fov_mm=maximum_fov_mm,
            face_clearance_mm=None,
            capped_axes=(False, False, False),
        )
    if mask is None:
        raise CropPlanningError(
            "Provide a validated brain mask when the source FOV exceeds the limit."
        )
    if any(
        start < 0 or stop > dimension
        for start, stop, dimension in zip(
            mask.bounds.start,
            mask.bounds.stop,
            source.shape,
            strict=True,
        )
    ):
        raise CropPlanningError("Keep brain mask bounds inside the source image.")
    starts = []
    stops = []
    capped = []
    spacing = source.voxel_spacing_mm
    for axis in range(3):
        start, stop, was_capped = _bounded_crop_axis(
            source.shape[axis],
            spacing[axis],
            mask.bounds.start[axis],
            mask.bounds.stop[axis],
            margin_mm,
            minimum_margin_mm,
            maximum_fov_mm,
        )
        starts.append(start)
        stops.append(stop)
        capped.append(was_capped)
    bounds = VoxelBounds(tuple(starts), tuple(stops))
    output_fov = tuple(
        dimension * axis_spacing
        for dimension, axis_spacing in zip(
            bounds.shape,
            spacing,
            strict=True,
        )
    )
    if any(value > maximum_fov_mm + fov_tolerance for value in output_fov):
        raise CropPlanningError("Keep the planned crop within the maximum FOV.")
    clearance = tuple(
        value
        for axis in range(3)
        for value in (
            (mask.bounds.start[axis] - bounds.start[axis]) * spacing[axis],
            (bounds.stop[axis] - mask.bounds.stop[axis]) * spacing[axis],
        )
    )
    capped_axes = tuple(capped)
    if not _clearance_satisfies_crop_policy(
        clearance,
        capped_axes,
        minimum_margin_mm,
    ):
        if any(capped_axes):
            raise CropPlanningError(
                f"Retain {minimum_margin_mm:g} mm around all six planned crop faces."
            )
        raise CropPlanningError("Keep the brain mask away from every crop face.")
    return CropPlan(
        pass_through=False,
        bounds=bounds,
        source_fov_mm=source_fov,
        output_fov_mm=output_fov,
        requested_margin_mm=margin_mm,
        minimum_margin_mm=minimum_margin_mm,
        maximum_fov_mm=maximum_fov_mm,
        face_clearance_mm=clearance,
        capped_axes=capped_axes,
    )


def _translated_affine(affine: Affine, start: tuple[int, int, int]) -> Affine:
    rows = tuple(
        (
            *(affine[row][column] for column in range(3)),
            affine[row][3] + sum(affine[row][axis] * start[axis] for axis in range(3)),
        )
        for row in range(3)
    )
    return (rows[0], rows[1], rows[2], (0.0, 0.0, 0.0, 1.0))


def _cropped_voxel_bytes(source: NiftiImage, bounds: VoxelBounds) -> bytes:
    row_bytes = bounds.shape[0] * source.bytes_per_voxel
    source_row_bytes = source.shape[0] * source.bytes_per_voxel
    output = bytearray(math.prod(bounds.shape) * source.bytes_per_voxel)
    destination_offset = 0
    for z_index in range(bounds.start[2], bounds.stop[2]):
        for y_index in range(bounds.start[1], bounds.stop[1]):
            source_voxel_offset = bounds.start[0] + source.shape[0] * (
                y_index + source.shape[1] * z_index
            )
            source_offset = source_voxel_offset * source.bytes_per_voxel
            source_row = source.voxel_bytes[source_offset : source_offset + row_bytes]
            if len(source_row) != row_bytes or source_row_bytes <= 0:
                raise NiftiValidationError("Provide a complete source voxel row.")
            output[destination_offset : destination_offset + row_bytes] = source_row
            destination_offset += row_bytes
    return bytes(output)


def _update_header_for_crop(
    source: NiftiImage,
    bounds: VoxelBounds,
) -> bytes:
    header = bytearray(source._prefix)
    struct.pack_into(
        f"{source.endian}3h",
        header,
        42,
        *bounds.shape,
    )
    if source.qform_code > 0 and source.qform_affine is not None:
        translated_qform = _translated_affine(source.qform_affine, bounds.start)
        struct.pack_into(
            f"{source.endian}3f",
            header,
            268,
            translated_qform[0][3],
            translated_qform[1][3],
            translated_qform[2][3],
        )
    if source.sform_code > 0 and source.sform_affine is not None:
        translated_sform = _translated_affine(source.sform_affine, bounds.start)
        for row, offset in enumerate((280, 296, 312)):
            struct.pack_into(
                f"{source.endian}4f",
                header,
                offset,
                *translated_sform[row],
            )
    return bytes(header)


def _gzip_deterministic(payload: bytes) -> bytes:
    output = io.BytesIO()
    with gzip.GzipFile(
        filename="",
        mode="wb",
        fileobj=output,
        compresslevel=9,
        mtime=0,
    ) as handle:
        handle.write(payload)
    return output.getvalue()


def _write_file_fsynced(path: Path, payload: bytes) -> None:
    with path.open("xb") as handle:
        os.chmod(path, 0o600)
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def crop_nifti(
    source: NiftiImage,
    plan: CropPlan,
    destination: str | Path,
) -> NiftiImage:
    """Write a crop by copying encoded source voxels without interpolation.

    Parameters
    ----------
    source
        Provide the validated source T1 image.
    plan
        Provide a non-pass-through crop plan for the same source geometry.
    destination
        Provide a new ``.nii`` or ``.nii.gz`` path. Never replace an existing path.

    Returns
    -------
    NiftiImage
        Return the re-read, validated cropped image.

    Raises
    ------
    BrainFovError
        Raise when the plan is pass-through, inconsistent, or cannot be written.
    """
    if plan.pass_through:
        raise BrainFovError("Do not duplicate the raw T1 for pass-through inputs.")
    if any(
        start < 0 or stop > dimension
        for start, stop, dimension in zip(
            plan.bounds.start,
            plan.bounds.stop,
            source.shape,
            strict=True,
        )
    ):
        raise BrainFovError("Keep the crop plan inside the source image.")
    payload = _update_header_for_crop(source, plan.bounds) + _cropped_voxel_bytes(
        source,
        plan.bounds,
    )
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    encoded = _gzip_deterministic(payload) if target.name.endswith(".gz") else payload
    try:
        _write_file_fsynced(target, encoded)
    except OSError as exc:
        raise BrainFovError("Write the cropped NIfTI immutably.") from exc
    cropped = read_nifti(target)
    validate_cropped_nifti(source, cropped, plan)
    return cropped


def validate_cropped_nifti(
    source: NiftiImage,
    cropped: NiftiImage,
    plan: CropPlan,
) -> dict[str, bool]:
    """Validate the crop geometry, encoded voxels, forms, and FOV.

    Parameters
    ----------
    source
        Provide the validated source T1.

    Returns
    -------
    dict[str, bool]
        Return stable validation flags whose values are all true.

    Raises
    ------
    NiftiValidationError
        Raise when any crop invariant fails.
    """
    qform_translation = (
        source.qform_affine is None and cropped.qform_affine is None
    ) or (
        source.qform_affine is not None
        and cropped.qform_affine is not None
        and _affines_close(
            cropped.qform_affine,
            _translated_affine(source.qform_affine, plan.bounds.start),
        )
    )
    sform_translation = (
        source.sform_affine is None and cropped.sform_affine is None
    ) or (
        source.sform_affine is not None
        and cropped.sform_affine is not None
        and _affines_close(
            cropped.sform_affine,
            _translated_affine(source.sform_affine, plan.bounds.start),
        )
    )
    checks = {
        "affineTranslation": _affines_close(
            cropped.affine,
            _translated_affine(source.affine, plan.bounds.start),
        ),
        "boundaryClearance": (
            plan.face_clearance_mm is not None
            and _clearance_satisfies_crop_policy(
                plan.face_clearance_mm,
                plan.capped_axes,
                plan.minimum_margin_mm,
            )
        ),
        "datatypePreserved": (
            cropped.datatype == source.datatype and cropped.bitpix == source.bitpix
        ),
        "outputFovMatchesPlan": all(
            math.isclose(
                actual,
                expected,
                rel_tol=0.0,
                abs_tol=AFFINE_ABSOLUTE_TOLERANCE,
            )
            for actual, expected in zip(
                cropped.fov_mm,
                plan.output_fov_mm,
                strict=True,
            )
        ),
        "outputFovWithinLimit": fov_within_limit(cropped.fov_mm, plan.maximum_fov_mm),
        "qformCodePreserved": cropped.qform_code == source.qform_code,
        "qformAffineTranslation": qform_translation,
        "sformCodePreserved": cropped.sform_code == source.sform_code,
        "sformAffineTranslation": sform_translation,
        "shapeMatchesPlan": cropped.shape == plan.bounds.shape,
        "sourceVoxelEquality": (
            cropped.voxel_bytes == _cropped_voxel_bytes(source, plan.bounds)
        ),
    }
    failed = [name for name, passed in checks.items() if not passed]
    if failed:
        raise NiftiValidationError(
            "Resolve the failed cropped NIfTI validations: "
            + ", ".join(sorted(failed))
            + "."
        )
    return checks


def _validate_signature(signature: str) -> None:
    if (
        len(signature) != _SHA256_HEX_LENGTH
        or signature.lower() != signature
        or any(character not in "0123456789abcdef" for character in signature)
    ):
        raise BrainFovError(
            "Provide 64 lowercase hexadecimal brain-FOV digest characters."
        )


#: Bound the ``--subject`` argument like other bounded CLI inputs.
_MAX_CLI_SUBJECT_ID_LENGTH = 256

# Bounded I/O, duplicated from bounded_io.py on purpose: this module is also
# the staged standalone helper that runs as a plain script inside the
# SynthStrip container, where the package is not importable. Keep the two
# copies identical when either changes.
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


def _parse_raw_t1_name(
    source: Path, subject_id: str | None = None
) -> tuple[list[str], str, str | None]:
    """Return the derivative name tokens, subject, and session for one source.

    Parse a BIDS ``*_T1w.nii.gz`` name into its entities. Name any other
    NIfTI source, which the configured T1 pattern may select, after the
    discovered subject alone when ``subject_id`` is supplied, so a study that
    does not follow BIDS file naming still receives a valid derivative set.
    """
    name = source.name
    if not name.endswith("_T1w.nii.gz"):
        if subject_id is not None and (
            name.endswith(".nii.gz") or name.endswith(".nii")
        ):
            if (
                not subject_id.startswith("sub-")
                or len(subject_id) <= _BIDS_ENTITY_PREFIX_LENGTH
                or "_" in subject_id
                or "/" in subject_id
            ):
                raise BrainFovError(
                    "Add a BIDS subject entity to the brain-FOV source."
                )
            return [subject_id], subject_id, None
        raise BrainFovError("Provide a raw BIDS T1w .nii.gz brain-FOV source.")
    stem = name[: -len("_T1w.nii.gz")]
    tokens = stem.split("_")
    if (
        not tokens
        or not tokens[0].startswith("sub-")
        or len(tokens[0]) <= _BIDS_ENTITY_PREFIX_LENGTH
    ):
        raise BrainFovError("Add a BIDS subject entity to the brain-FOV source.")
    if any(token.startswith("desc-") for token in tokens):
        raise BrainFovError("Remove the desc entity from the raw brain-FOV source.")
    session_tokens = [token for token in tokens if token.startswith("ses-")]
    if len(session_tokens) > 1 or any(
        len(token) <= _BIDS_ENTITY_PREFIX_LENGTH for token in session_tokens
    ):
        raise BrainFovError(
            "Provide a valid BIDS session entity for the brain-FOV source."
        )
    return tokens, tokens[0], session_tokens[0] if session_tokens else None


def build_derivative_paths(
    derivatives_dir: str | Path,
    source_t1: str | Path,
    signature: str,
    subject_id: str | None = None,
) -> DerivativePaths:
    """Build digest-qualified BIDS derivative paths for one raw T1.

    Parameters
    ----------
    derivatives_dir
        Provide the project derivative root. Create the ``supraspina-brainfov``
        dataset beneath this directory.
    source_t1
        Provide the raw T1 path. A BIDS ``*_T1w.nii.gz`` name keeps its
        entities; any other NIfTI name is named after ``subject_id``.
    signature
        Provide the full 64-character preflight digest.
    subject_id
        Provide the discovered subject id so a non-BIDS source name can still
        be published; omit it to accept only BIDS names.

    Returns
    -------
    DerivativePaths
        Return the cropped T1, mask, QC, and provenance targets.

    Raises
    ------
    BrainFovError
        Raise when the digest or raw BIDS T1 name is invalid.
    """
    _validate_signature(signature)
    source = Path(source_t1)
    tokens, subject, session = _parse_raw_t1_name(source, subject_id)
    descriptor = f"brainfov{signature[:16]}"
    derivative_tokens = [*tokens, f"desc-{descriptor}"]
    basename = "_".join(derivative_tokens)
    root = Path(derivatives_dir) / "supraspina-brainfov" / subject
    if session is not None:
        root /= session
    root /= "anat"
    return DerivativePaths(
        signature=signature,
        descriptor=descriptor,
        t1=root / f"{basename}_T1w.nii.gz",
        mask=root / f"{basename}_mask.nii.gz",
        qc=root / f"{basename}_qc.png",
        provenance=root / f"{basename}_T1w.json",
    )


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> tuple[str, int]:
    try:
        return sha256_bounded_regular(path, _MAX_NIFTI_BYTES)
    except (OSError, ValueError) as exc:
        raise BrainFovError("Provide a hashable brain-FOV source.") from exc


def _canonical_json_bytes(value: Mapping[str, Any]) -> bytes:
    return (
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def build_preflight_signature(  # noqa: PLR0913
    source_path: str | Path,
    source: NiftiImage,
    *,
    margin_mm: int,
    provider: Mapping[str, Any],
    helper: Mapping[str, Any] | None = None,
    runtime: Mapping[str, Any] | None = None,
    maximum_fov_mm: float = MAXIMUM_FOV_MM,
    minimum_margin_mm: float = MINIMUM_MARGIN_MM,
) -> tuple[str, dict[str, Any]]:
    """Build a canonical digest over the source, geometry, policy, and tools.

    Parameters
    ----------
    source_path
        Provide the raw source path whose exact file bytes are hashed.
    provider
        Provide the pinned container, model, and helper identities.
    helper
        Provide the first-party crop and QC helper identity.
    runtime
        Provide plan-time execution choices that can affect generated artifacts.

    Returns
    -------
    tuple[str, dict[str, Any]]
        Return the full SHA-256 digest and its source payload.
    """
    source_sha256, source_size = _sha256_file(Path(source_path))
    payload: dict[str, Any] = {
        "schemaVersion": 1,
        "source": {
            "sha256": source_sha256,
            "size": source_size,
            "shape": list(source.shape),
            "affine": [list(row) for row in source.affine],
            "qformCode": source.qform_code,
            "sformCode": source.sform_code,
        },
        "policy": {
            "marginMm": margin_mm,
            "maximumFovMm": maximum_fov_mm,
            "minimumMarginMm": minimum_margin_mm,
        },
        "provider": dict(provider),
        "helper": dict(helper or {}),
        "runtime": dict(runtime or {}),
    }
    return _sha256_bytes(_canonical_json_bytes(payload)), payload


def build_brainfov_provenance(  # noqa: PLR0913
    *,
    signature: str,
    signature_payload: Mapping[str, Any],
    source: NiftiImage,
    plan: CropPlan,
    mask: MaskSummary | None,
    provider: Mapping[str, Any],
    helper: Mapping[str, Any],
    nested_command: Sequence[str],
    validation: Mapping[str, bool],
) -> dict[str, Any]:
    """Build the stable scientific provenance document before publication.

    Parameters
    ----------
    signature_payload
        Provide the canonical payload bound by the ``signature`` digest.
    source
        Provide the validated source T1.
    plan
        Provide the pass-through or crop decision.
    mask
        Provide crop-mask evidence or ``None`` for pass-through.
    provider
        Provide the SynthStrip container and model identities.
    helper
        Provide the first-party crop and QC helper identity.
    nested_command
        Provide the exact command invoked inside the managed container.
    validation
        Provide the completed validation flags.

    Returns
    -------
    dict[str, Any]
        Return JSON-compatible provenance. Add artifact hashes during immutable
        publication.
    """
    _validate_signature(signature)
    return {
        "schemaVersion": 1,
        "signature": signature,
        "preflightSignature": dict(signature_payload),
        "source": {
            "path": str(source.path),
            "shape": list(source.shape),
            "fovMm": list(source.fov_mm),
            "affine": [list(row) for row in source.affine],
            "qformCode": source.qform_code,
            "sformCode": source.sform_code,
        },
        "crop": plan.to_dict(),
        "mask": mask.to_dict() if mask is not None else None,
        "provider": dict(provider),
        "helper": dict(helper),
        "nestedCommand": [str(argument) for argument in nested_command],
        "validation": dict(validation),
    }


def _sample_intensity_window(image: NiftiImage) -> tuple[float, float]:
    voxel_count = math.prod(image.shape)
    stride = max(1, voxel_count // 100_000)
    samples = [
        value
        for index, value in enumerate(_iter_scaled_values(image))
        if index % stride == 0 and math.isfinite(value) and value != 0.0
    ]
    if not samples:
        return 0.0, 1.0
    samples.sort()
    low = samples[math.floor(0.01 * (len(samples) - 1))]
    high = samples[math.floor(0.99 * (len(samples) - 1))]
    if not high > low:
        high = low + 1.0
    return low, high


def _voxel_value_at(image: NiftiImage, coordinates: tuple[int, int, int]) -> float:
    x_index, y_index, z_index = coordinates
    flat_index = x_index + image.shape[0] * (y_index + image.shape[1] * z_index)
    value_format = _SCALAR_DATATYPES[image.datatype][0]
    (raw_value,) = struct.unpack_from(
        f"{image.endian}{value_format}",
        image.voxel_bytes,
        flat_index * image.bytes_per_voxel,
    )
    value = float(raw_value)
    if math.isfinite(image.scl_slope) and image.scl_slope != 0.0:
        value = value * image.scl_slope
        if math.isfinite(image.scl_inter):
            value += image.scl_inter
    return value


def _plane_axes(view: str) -> tuple[int, int, int]:
    if view == "sagittal":
        return 0, 1, 2
    if view == "coronal":
        return 1, 0, 2
    return 2, 0, 1


def _render_plane(  # noqa: PLR0913
    image: NiftiImage,
    bounds: VoxelBounds,
    view: str,
    slice_coordinate: int,
    panel_pixels: int,
    window: tuple[float, float],
) -> bytearray:
    fixed_axis, horizontal_axis, vertical_axis = _plane_axes(view)
    spacing = image.voxel_spacing_mm
    horizontal_count = bounds.shape[horizontal_axis]
    vertical_count = bounds.shape[vertical_axis]
    horizontal_extent = horizontal_count * spacing[horizontal_axis]
    vertical_extent = vertical_count * spacing[vertical_axis]
    scale = min(
        panel_pixels / horizontal_extent,
        panel_pixels / vertical_extent,
    )
    rendered_width = max(1, math.floor(horizontal_extent * scale))
    rendered_height = max(1, math.floor(vertical_extent * scale))
    x_offset = (panel_pixels - rendered_width) // 2
    y_offset = (panel_pixels - rendered_height) // 2
    panel = bytearray(_BACKGROUND_RGB * (panel_pixels * panel_pixels))
    low, high = window
    for output_y in range(rendered_height):
        vertical_fraction = (rendered_height - output_y - 0.5) / rendered_height
        vertical_index = min(
            bounds.stop[vertical_axis] - 1,
            bounds.start[vertical_axis]
            + math.floor(vertical_fraction * vertical_count),
        )
        for output_x in range(rendered_width):
            horizontal_fraction = (output_x + 0.5) / rendered_width
            horizontal_index = min(
                bounds.stop[horizontal_axis] - 1,
                bounds.start[horizontal_axis]
                + math.floor(horizontal_fraction * horizontal_count),
            )
            coordinates = [0, 0, 0]
            coordinates[fixed_axis] = slice_coordinate
            coordinates[horizontal_axis] = horizontal_index
            coordinates[vertical_axis] = vertical_index
            value = _voxel_value_at(image, tuple(coordinates))
            normalized = (
                0.0 if not math.isfinite(value) else (value - low) / (high - low)
            )
            gray = round(255 * min(1.0, max(0.0, normalized)))
            pixel = ((y_offset + output_y) * panel_pixels + x_offset + output_x) * 3
            panel[pixel : pixel + 3] = bytes((gray, gray, gray))
    return panel


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    checksum = binascii.crc32(kind)
    checksum = binascii.crc32(payload, checksum) & 0xFFFFFFFF
    return (
        struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)
    )


def _encode_rgb_png(width: int, height: int, pixels: bytes) -> bytes:
    stride = width * 3
    scanlines = b"".join(
        b"\x00" + pixels[row * stride : (row + 1) * stride] for row in range(height)
    )
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(scanlines, level=9))
        + _png_chunk(b"IEND", b"")
    )


def generate_qc_montage(
    source: NiftiImage,
    plan: CropPlan,
    mask: MaskSummary | None,
    *,
    panel_pixels: int = 192,
) -> QcMontage:
    """Generate a deterministic 2-by-3 grayscale crop-review PNG.

    Parameters
    ----------
    source
        Provide the validated source T1 image.
    mask
        Provide validated dominant-component evidence for slice selection. Omit it
        for pass-through inputs to use volume-center slices.
    panel_pixels
        Provide a square panel side length from 32 to 1024 pixels.

    Returns
    -------
    QcMontage
        Return PNG bytes, dimensions, stable layout metadata, and SHA-256.

    Raises
    ------
    ValueError
        Raise when ``panel_pixels`` is outside its bounded range.
    """
    if not _MINIMUM_PANEL_PIXELS <= panel_pixels <= _MAXIMUM_PANEL_PIXELS:
        raise ValueError("Set the QC panel size from 32 to 1024 pixels.")
    if mask is None and not plan.pass_through:
        raise BrainFovError("Provide validated mask evidence for a cropped QC montage.")
    views = ("sagittal", "coronal", "axial")
    width = panel_pixels * 3 + _MONTAGE_GAP_PIXELS * 2
    height = panel_pixels * 2 + _MONTAGE_GAP_PIXELS
    canvas = bytearray(_BACKGROUND_RGB * (width * height))
    window = _sample_intensity_window(source)
    full_bounds = VoxelBounds((0, 0, 0), source.shape)
    for column, view in enumerate(views):
        fixed_axis, _horizontal, _vertical = _plane_axes(view)
        slice_coordinate = (
            (mask.bounds.start[fixed_axis] + mask.bounds.stop[fixed_axis] - 1) // 2
            if mask is not None
            else (source.shape[fixed_axis] - 1) // 2
        )
        source_panel = _render_plane(
            source,
            full_bounds,
            view,
            slice_coordinate,
            panel_pixels,
            window,
        )
        prepared_panel = _render_plane(
            source,
            plan.bounds,
            view,
            slice_coordinate,
            panel_pixels,
            window,
        )
        _composite_panel(
            canvas,
            width,
            source_panel,
            panel_pixels,
            column * (panel_pixels + _MONTAGE_GAP_PIXELS),
            0,
        )
        _composite_panel(
            canvas,
            width,
            prepared_panel,
            panel_pixels,
            column * (panel_pixels + _MONTAGE_GAP_PIXELS),
            panel_pixels + _MONTAGE_GAP_PIXELS,
        )
        _overlay_plan_rectangle(
            canvas,
            width,
            panel_pixels,
            column * (panel_pixels + _MONTAGE_GAP_PIXELS),
            source,
            plan.bounds,
            view,
        )
    png = _encode_rgb_png(width, height, bytes(canvas))
    layout: dict[str, Any] = {
        "columns": list(views),
        "rows": ["sourceWithCropBoundary", "preparedCrop"],
        "panelPixels": panel_pixels,
        "gapPixels": _MONTAGE_GAP_PIXELS,
    }
    return QcMontage(
        png=png,
        width=width,
        height=height,
        layout=layout,
        sha256=_sha256_bytes(png),
    )


def _composite_panel(  # noqa: PLR0913
    canvas: bytearray,
    canvas_width: int,
    panel: bytearray,
    panel_pixels: int,
    x_offset: int,
    y_offset: int,
) -> None:
    panel_stride = panel_pixels * 3
    canvas_stride = canvas_width * 3
    for row in range(panel_pixels):
        destination = (y_offset + row) * canvas_stride + x_offset * 3
        source = row * panel_stride
        canvas[destination : destination + panel_stride] = panel[
            source : source + panel_stride
        ]


def _overlay_plan_rectangle(  # noqa: PLR0913
    canvas: bytearray,
    canvas_width: int,
    panel_pixels: int,
    x_offset: int,
    source: NiftiImage,
    bounds: VoxelBounds,
    view: str,
) -> None:
    _fixed, horizontal, vertical = _plane_axes(view)
    horizontal_extent = source.shape[horizontal] * source.voxel_spacing_mm[horizontal]
    vertical_extent = source.shape[vertical] * source.voxel_spacing_mm[vertical]
    scale = min(panel_pixels / horizontal_extent, panel_pixels / vertical_extent)
    rendered_width = max(1, math.floor(horizontal_extent * scale))
    rendered_height = max(1, math.floor(vertical_extent * scale))
    panel_x = x_offset + (panel_pixels - rendered_width) // 2
    panel_y = (panel_pixels - rendered_height) // 2
    left = panel_x + round(
        bounds.start[horizontal] / source.shape[horizontal] * rendered_width
    )
    right = (
        panel_x
        + round(bounds.stop[horizontal] / source.shape[horizontal] * rendered_width)
        - 1
    )
    top = (
        panel_y
        + rendered_height
        - round(bounds.stop[vertical] / source.shape[vertical] * rendered_height)
    )
    bottom = (
        panel_y
        + rendered_height
        - round(bounds.start[vertical] / source.shape[vertical] * rendered_height)
        - 1
    )
    color = bytes(_CROP_BOUNDARY_RGB)
    left = max(panel_x, min(left, panel_x + rendered_width - 1))
    right = max(left, min(right, panel_x + rendered_width - 1))
    top = max(panel_y, min(top, panel_y + rendered_height - 1))
    bottom = max(top, min(bottom, panel_y + rendered_height - 1))
    for thickness in range(2):
        for x_index in range(left, right + 1):
            for y_index in (top + thickness, bottom - thickness):
                pixel = (y_index * canvas_width + x_index) * 3
                canvas[pixel : pixel + 3] = color
        for y_index in range(top, bottom + 1):
            for x_index in (left + thickness, right - thickness):
                pixel = (y_index * canvas_width + x_index) * 3
                canvas[pixel : pixel + 3] = color


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _unlink_ignoring_errors(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


def _publication_transaction_path(paths: DerivativePaths) -> Path:
    return paths.provenance.parent / f".brainfov-publish-{paths.signature}.json"


def _brainfov_dataset_root(paths: DerivativePaths) -> Path:
    roots = [
        parent
        for parent in paths.provenance.parents
        if parent.name == "supraspina-brainfov"
    ]
    if len(roots) != 1:
        raise ImmutablePublicationError(
            "Keep the brain-FOV publication inside its derivative dataset."
        )
    return roots[0]


def _ensure_dataset_description(paths: DerivativePaths) -> None:
    """Publish or verify the immutable BIDS derivative dataset metadata."""
    dataset_root = _brainfov_dataset_root(paths)
    description = dataset_root / "dataset_description.json"
    expected = _canonical_json_bytes(_DATASET_DESCRIPTION)
    try:
        dataset_root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ImmutablePublicationError(
            "Publish the brain-FOV dataset description."
        ) from exc

    if os.path.lexists(description):
        _verify_dataset_description(paths)
        return
    stage = Path(
        tempfile.mkdtemp(
            prefix=".brainfov-dataset-stage-",
            dir=dataset_root,
        )
    )
    try:
        staged = stage / "dataset_description.json"
        _write_file_fsynced(staged, expected)
        _fsync_directory(stage)
        try:
            os.link(staged, description)
            _fsync_directory(dataset_root)
        except FileExistsError:
            _verify_dataset_description(paths)
        except OSError as exc:
            raise ImmutablePublicationError(
                "Publish the brain-FOV dataset description."
            ) from exc
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def _verify_dataset_description(paths: DerivativePaths) -> None:
    description = _brainfov_dataset_root(paths) / "dataset_description.json"
    expected = _canonical_json_bytes(_DATASET_DESCRIPTION)
    try:
        actual = read_bounded_regular(description, len(expected))
    except FileNotFoundError as exc:
        raise ImmutablePublicationError(
            "Provide the brain-FOV dataset description."
        ) from exc
    except OSError as exc:
        raise ImmutablePublicationError(
            "Provide an inspectable brain-FOV dataset description."
        ) from exc
    if actual != expected:
        raise ImmutablePublicationError(
            "Align the brain-FOV dataset description with Supraspina metadata."
        )


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == _SHA256_HEX_LENGTH
        and all(character in "0123456789abcdef" for character in value)
    )


def _read_publication_transaction(
    paths: DerivativePaths,
) -> dict[str, Any] | None:
    """Read and validate an interrupted-publication recovery marker."""
    marker = _publication_transaction_path(paths)
    try:
        info = marker.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ImmutablePublicationError(
            "Provide an inspectable brain-FOV publication transaction."
        ) from exc
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISREG(info.st_mode)
        or info.st_size > _MAXIMUM_PUBLICATION_TRANSACTION_BYTES
    ):
        raise ImmutablePublicationError(
            "Provide a safe brain-FOV publication transaction."
        )
    try:
        document = json.loads(
            read_bounded_regular(
                marker,
                _MAXIMUM_PUBLICATION_TRANSACTION_BYTES,
            )
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ImmutablePublicationError(
            "Provide a readable brain-FOV publication transaction."
        ) from exc
    allowed = paths.by_role()
    if (
        not isinstance(document, dict)
        or set(document) != {"schemaVersion", "signature", "artifacts", "provenance"}
        or document.get("schemaVersion") != 1
        or document.get("signature") != paths.signature
        or not isinstance(document.get("artifacts"), dict)
        or not document["artifacts"]
        or not set(document["artifacts"]).issubset(allowed)
    ):
        raise ImmutablePublicationError(
            "Provide a valid brain-FOV publication transaction."
        )
    expected_paths = {role: str(allowed[role]) for role in document["artifacts"]}
    for role, entry in document["artifacts"].items():
        if (
            not isinstance(entry, dict)
            or set(entry) != {"path", "sha256", "size"}
            or entry.get("path") != expected_paths[role]
            or not _is_sha256(entry.get("sha256"))
            or not isinstance(entry.get("size"), int)
            or isinstance(entry["size"], bool)
            or entry["size"] < 0
        ):
            raise ImmutablePublicationError(
                "Provide a valid brain-FOV publication transaction."
            )
    provenance = document.get("provenance")
    if (
        not isinstance(provenance, dict)
        or set(provenance) != {"path", "sha256", "size"}
        or provenance.get("path") != str(paths.provenance)
        or not _is_sha256(provenance.get("sha256"))
        or not isinstance(provenance.get("size"), int)
        or isinstance(provenance["size"], bool)
        or provenance["size"] < 0
    ):
        raise ImmutablePublicationError(
            "Provide a valid brain-FOV publication transaction."
        )
    return document


def _recover_interrupted_publication(
    paths: DerivativePaths,
) -> dict[str, Any] | None:
    """Roll back only exact, marker-owned bytes left before the commit marker."""
    transaction = _read_publication_transaction(paths)
    if transaction is None or os.path.lexists(paths.provenance):
        return transaction
    allowed = paths.by_role()
    recorded = transaction["artifacts"]
    if any(
        os.path.lexists(target) and role not in recorded
        for role, target in allowed.items()
    ):
        raise ImmutablePublicationError(
            "Remove unowned bytes from the interrupted brain-FOV publication."
        )
    verified: list[Path] = []
    for role, entry in sorted(recorded.items()):
        target = allowed[role]
        if not os.path.lexists(target):
            continue
        if target.is_symlink() or not target.is_file():
            raise ImmutablePublicationError(
                "Remove unsafe bytes from the interrupted brain-FOV publication."
            )
        actual, size = _sha256_file(target)
        if actual != entry["sha256"] or size != entry["size"]:
            raise ImmutablePublicationError(
                "Restore the recorded interrupted brain-FOV publication bytes."
            )
        verified.append(target)
    for target in verified:
        target.unlink()
    _publication_transaction_path(paths).unlink()
    _fsync_directory(paths.provenance.parent)
    return None


def _finalize_publication_transaction(
    paths: DerivativePaths,
    transaction: dict[str, Any] | None,
    recorded: dict[str, Any],
    provenance_sha256: str,
    provenance_size: int,
) -> None:
    """Remove a post-commit crash marker only after all bytes agree."""
    if transaction is None:
        return
    if (
        transaction["artifacts"] != recorded
        or transaction["provenance"]["sha256"] != provenance_sha256
        or transaction["provenance"]["size"] != provenance_size
    ):
        raise ImmutablePublicationError(
            "Align the brain-FOV publication transaction with the committed bytes."
        )
    _publication_transaction_path(paths).unlink()
    _fsync_directory(paths.provenance.parent)


def verify_published_derivative_set(
    paths: DerivativePaths,
    expected_roles: Sequence[str],
) -> PublicationResult | None:
    """Verify an existing immutable publication without rerunning SynthStrip.

    Parameters
    ----------
    paths
        Provide signature-qualified derivative targets.
    expected_roles
        Provide the exact artifact roles required for this pass-through or crop.

    Returns
    -------
    PublicationResult or None
        Return verified hashes with ``reused=True``, or return ``None`` when no
        publication exists.

    Raises
    ------
    ImmutablePublicationError
        Raise when the committed set is partial, colliding, symlinked, or changed.
    """
    _validate_signature(paths.signature)
    transaction = _recover_interrupted_publication(paths)
    allowed = paths.by_role()
    roles = set(expected_roles)
    if not roles or any(role not in allowed for role in roles):
        raise ImmutablePublicationError("Provide valid brain-FOV artifact roles.")
    provenance_exists = os.path.lexists(paths.provenance)
    if not provenance_exists:
        if any(os.path.lexists(path) for path in allowed.values()):
            raise ImmutablePublicationError(
                "Resolve the existing incomplete immutable brain-FOV publication."
            )
        return None
    _verify_dataset_description(paths)
    if paths.provenance.is_symlink() or not paths.provenance.is_file():
        raise ImmutablePublicationError(
            "Provide existing brain-FOV provenance as a regular file."
        )
    try:
        document = json.loads(
            read_bounded_regular(paths.provenance, _MAXIMUM_PROVENANCE_BYTES)
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ImmutablePublicationError(
            "Provide readable existing brain-FOV provenance."
        ) from exc
    if document.get("signature") != paths.signature:
        raise ImmutablePublicationError(
            "Resolve the 16-character brain-FOV descriptor digest collision."
        )
    recorded = document.get("artifacts")
    if not isinstance(recorded, dict):
        raise ImmutablePublicationError(
            "Provide the existing brain-FOV artifact manifest."
        )
    if set(recorded) != roles:
        raise ImmutablePublicationError(
            "Align existing brain-FOV artifact roles with the requested set."
        )
    if any(
        os.path.lexists(target) and role not in roles
        for role, target in allowed.items()
    ):
        raise ImmutablePublicationError(
            "Remove unrecorded paths from the existing brain-FOV artifact set."
        )
    digests: dict[str, str] = {}
    for role in sorted(roles):
        target = allowed[role]
        entry = recorded.get(role)
        if (
            target.is_symlink()
            or not target.is_file()
            or not isinstance(entry, dict)
            or entry.get("path") != str(target)
            or not isinstance(entry.get("sha256"), str)
            or not isinstance(entry.get("size"), int)
        ):
            raise ImmutablePublicationError(
                f"Restore the recorded existing brain-FOV {role} bytes."
            )
        actual, size = _sha256_file(target)
        if actual != entry["sha256"] or size != entry["size"]:
            raise ImmutablePublicationError(
                f"Restore the recorded existing brain-FOV {role} bytes."
            )
        digests[role] = actual
    provenance_sha256, provenance_size = _sha256_file(paths.provenance)
    _finalize_publication_transaction(
        paths,
        transaction,
        recorded,
        provenance_sha256,
        provenance_size,
    )
    return PublicationResult(
        reused=True,
        sha256_by_role=digests,
        provenance_sha256=provenance_sha256,
    )


def _existing_publication(
    paths: DerivativePaths,
    artifacts: Mapping[str, bytes],
) -> PublicationResult | None:
    existing = verify_published_derivative_set(paths, list(artifacts))
    if existing is None:
        return None
    for role, payload in artifacts.items():
        if existing.sha256_by_role[role] != _sha256_bytes(payload):
            raise ImmutablePublicationError(
                f"Restore the recorded existing brain-FOV {role} bytes."
            )
    return existing


def _publication_transaction_document(
    paths: DerivativePaths,
    artifacts: Mapping[str, dict[str, Any]],
    provenance_bytes: bytes,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "signature": paths.signature,
        "artifacts": {role: dict(entry) for role, entry in artifacts.items()},
        "provenance": {
            "path": str(paths.provenance),
            "sha256": _sha256_bytes(provenance_bytes),
            "size": len(provenance_bytes),
        },
    }


def publish_derivative_set(  # noqa: PLR0915 - Keep one rollback domain here.
    paths: DerivativePaths,
    artifacts: Mapping[str, bytes],
    provenance: Mapping[str, Any],
) -> PublicationResult:
    """Publish an immutable artifact set with provenance as the commit marker.

    Parameters
    ----------
    paths
        Provide signature-qualified derivative targets.
    artifacts
        Provide artifact bytes keyed by ``t1``, ``mask``, and/or ``qc``. Use only
        ``qc`` for ordinary pass-through publications.
    provenance
        Provide the provenance document whose digest must match ``paths``.

    Returns
    -------
    PublicationResult
        Return artifact hashes and whether an identical committed set was reused.

    Raises
    ------
    ImmutablePublicationError
        Raise when bytes conflict, the 16-character descriptor collides, or
        publication cannot complete without overwriting data.
    """
    _validate_signature(paths.signature)
    if provenance.get("signature") != paths.signature:
        raise ImmutablePublicationError(
            "Match the provenance digest to the derivative paths."
        )
    allowed_roles = paths.by_role()
    if not artifacts or any(role not in allowed_roles for role in artifacts):
        raise ImmutablePublicationError("Provide valid brain-FOV artifact roles.")
    _ensure_dataset_description(paths)
    existing = _existing_publication(paths, artifacts)
    if existing is not None:
        return existing
    parent = paths.provenance.parent
    parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".brainfov-stage-", dir=parent))
    created: list[Path] = []
    sha256_by_role = {
        role: _sha256_bytes(payload) for role, payload in artifacts.items()
    }
    committed_document = dict(provenance)
    committed_document["artifacts"] = {
        role: {
            "path": str(allowed_roles[role]),
            "sha256": sha256_by_role[role],
            "size": len(payload),
        }
        for role, payload in sorted(artifacts.items())
    }
    staged_paths: dict[str, Path] = {}
    provenance_bytes = _canonical_json_bytes(committed_document)
    transaction_document = _publication_transaction_document(
        paths,
        committed_document["artifacts"],
        provenance_bytes,
    )
    marker = _publication_transaction_path(paths)
    marker_created = False
    try:
        for role, payload in sorted(artifacts.items()):
            staged = stage / role
            _write_file_fsynced(staged, payload)
            staged_paths[role] = staged
        staged_provenance = stage / "provenance.json"
        _write_file_fsynced(staged_provenance, provenance_bytes)
        staged_transaction = stage / "transaction.json"
        _write_file_fsynced(
            staged_transaction,
            _canonical_json_bytes(transaction_document),
        )
        _fsync_directory(stage)
        os.link(staged_transaction, marker)
        marker_created = True
        _fsync_directory(parent)
        for role in sorted(artifacts):
            target = allowed_roles[role]
            os.link(staged_paths[role], target)
            created.append(target)
        os.link(staged_provenance, paths.provenance)
        created.append(paths.provenance)
        marker.unlink()
        marker_created = False
        _fsync_directory(parent)
    except (OSError, BrainFovError) as exc:
        for target in reversed(created):
            _unlink_ignoring_errors(target)
        if marker_created:
            _unlink_ignoring_errors(marker)
        try:
            _fsync_directory(parent)
        except OSError:
            pass
        raise ImmutablePublicationError(
            "Publish the brain-FOV derivative set atomically."
        ) from exc
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    return PublicationResult(
        reused=False,
        sha256_by_role=sha256_by_role,
        provenance_sha256=_sha256_bytes(provenance_bytes),
    )


class _BrainFovArgumentParser(argparse.ArgumentParser):
    """Report bounded machine-readable argument errors."""

    def error(self, message: str) -> None:
        raise BrainFovError(f"Provide valid brain-FOV helper arguments: {message}.")


def _bounded_json_identity(value: str, label: str) -> dict[str, Any]:
    encoded = value.encode("utf-8", errors="strict")
    if len(encoded) > _MAXIMUM_IDENTITY_JSON_BYTES:
        raise BrainFovError(f"Keep the {label} identity within the bounded JSON limit.")
    try:
        document = json.loads(value)
    except json.JSONDecodeError as exc:
        raise BrainFovError(f"Provide the {label} identity as valid JSON.") from exc
    if not isinstance(document, dict) or not document:
        raise BrainFovError(f"Provide the {label} identity as a non-empty JSON object.")
    try:
        canonical = _canonical_json_bytes(document)
    except (TypeError, ValueError) as exc:
        raise BrainFovError(
            f"Provide the {label} identity as bounded JSON-compatible data."
        ) from exc
    if len(canonical) > _MAXIMUM_IDENTITY_JSON_BYTES:
        raise BrainFovError(f"Keep the {label} identity within the bounded JSON limit.")
    return document


def _validate_provider_identity(provider: Mapping[str, Any]) -> None:
    mismatched = [
        key
        for key, expected in SYNTHSTRIP_PROVIDER_IDENTITY.items()
        if provider.get(key) != expected
    ]
    if mismatched:
        raise BrainFovError(
            "Match the SynthStrip provider identity to the reviewed 1.8 CPU pin."
        )


def _validate_helper_identity(helper: Mapping[str, Any]) -> None:
    if not isinstance(helper.get("name"), str) or not helper["name"]:
        raise BrainFovError("Add a name to the brain-FOV helper identity.")
    if not isinstance(helper.get("version"), str) or not helper["version"]:
        raise BrainFovError("Add a version to the brain-FOV helper identity.")
    helper_sha256 = helper.get("sha256")
    if not isinstance(helper_sha256, str):
        raise BrainFovError("Add a SHA-256 to the brain-FOV helper identity.")
    try:
        _validate_signature(helper_sha256)
    except BrainFovError as exc:
        raise BrainFovError(
            "Provide a valid SHA-256 for the brain-FOV helper identity."
        ) from exc
    actual_sha256, _size = _sha256_file(Path(__file__).resolve())
    if helper_sha256 != actual_sha256:
        raise BrainFovError(
            "Match the brain-FOV helper identity to the executing helper bytes."
        )


def _validate_cli_paths(source_path: Path, derivatives_root: Path) -> None:
    if not source_path.is_absolute() or not derivatives_root.is_absolute():
        raise BrainFovError("Provide absolute brain-FOV input and derivatives paths.")
    try:
        source_resolved = source_path.resolve(strict=True)
        derivatives_resolved = derivatives_root.resolve(strict=False)
    except OSError as exc:
        raise BrainFovError("Provide safely resolvable brain-FOV paths.") from exc
    if source_resolved.is_relative_to(derivatives_resolved):
        raise BrainFovError(
            "Keep the raw brain-FOV input outside the derivatives root."
        )


def _validate_synthstrip_executable(executable: str) -> None:
    if (
        not executable
        or len(executable) > _MAXIMUM_EXECUTABLE_CHARACTERS
        or any(character in executable for character in ("\x00", "\n", "\r"))
    ):
        raise BrainFovError("Provide a valid SynthStrip executable.")


def _build_cli_parser() -> argparse.ArgumentParser:
    parser = _BrainFovArgumentParser(prog="brainfov.py")
    subparsers = parser.add_subparsers(dest="operation", required=True)
    prepare = subparsers.add_parser(
        "prepare",
        help="Prepare one raw BIDS T1 for reconstruction.",
    )
    prepare.add_argument("--input", required=True, dest="input_path")
    prepare.add_argument("--derivatives-root", required=True)
    # Name a non-BIDS source after the discovered subject; see
    # build_derivative_paths.
    prepare.add_argument("--subject", default=None, dest="subject_id")
    prepare.add_argument(
        "--margin-mm",
        required=True,
        type=int,
        choices=range(
            _MINIMUM_CONFIGURED_MARGIN_MM,
            _MAXIMUM_CONFIGURED_MARGIN_MM + 1,
        ),
    )
    prepare.add_argument("--provider-json", required=True)
    prepare.add_argument("--helper-json", required=True)
    prepare.add_argument(
        "--synthstrip-executable",
        default="mri_synthstrip",
    )
    prepare.add_argument(
        "--threads",
        type=int,
        default=_DEFAULT_SYNTHSTRIP_THREADS,
        choices=range(
            _MINIMUM_SYNTHSTRIP_THREADS,
            _MAXIMUM_SYNTHSTRIP_THREADS + 1,
        ),
    )
    return parser


def _result_document(
    *,
    mode: str,
    paths: DerivativePaths,
    publication: PublicationResult,
    roles: Sequence[str],
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "ok": True,
        "mode": mode,
        "signature": paths.signature,
        "descriptor": paths.descriptor,
        "reused": publication.reused,
        "artifacts": {
            role: {
                "path": str(paths.by_role()[role]),
                "sha256": publication.sha256_by_role[role],
            }
            for role in sorted(roles)
        },
        "provenance": {
            "path": str(paths.provenance),
            "sha256": publication.provenance_sha256,
        },
    }


def _pass_through_preparation(  # noqa: PLR0913
    source_path: Path,
    source: NiftiImage,
    derivatives_root: Path,
    signature: str,
    signature_payload: Mapping[str, Any],
    provider: Mapping[str, Any],
    helper: Mapping[str, Any],
    margin_mm: int,
    subject_id: str | None = None,
) -> dict[str, Any]:
    plan = plan_brain_fov_crop(source, margin_mm=margin_mm)
    paths = build_derivative_paths(derivatives_root, source_path, signature, subject_id)
    existing = verify_published_derivative_set(paths, ["qc"])
    if existing is not None:
        return _result_document(
            mode="passThrough",
            paths=paths,
            publication=existing,
            roles=["qc"],
        )
    montage = generate_qc_montage(source, plan, None)
    validation = {
        "inputReadable": True,
        "outputFovWithinLimit": True,
        "passThroughWithoutRawDuplication": True,
        "qformOrSformValid": True,
    }
    provenance = build_brainfov_provenance(
        signature=signature,
        signature_payload=signature_payload,
        source=source,
        plan=plan,
        mask=None,
        provider=provider,
        helper=helper,
        nested_command=[],
        validation=validation,
    )
    publication = publish_derivative_set(
        paths,
        {"qc": montage.png},
        provenance,
    )
    return _result_document(
        mode="passThrough",
        paths=paths,
        publication=publication,
        roles=["qc"],
    )


def _synthstrip_environment(work_directory: Path, threads: int) -> dict[str, str]:
    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "LANG": "C",
        "LC_ALL": "C",
        "TMPDIR": str(work_directory),
        "CUDA_VISIBLE_DEVICES": "",
        "OMP_NUM_THREADS": str(threads),
        "ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS": str(threads),
    }
    # Retain the pinned image's Python and loader roots after the outer
    # Apptainer --cleanenv boundary. Allow bundled mri_synthstrip to import its
    # verified PyTorch environment without inheriting arbitrary host variables.
    for key in ("FREESURFER_HOME", "PYTHONUSERBASE", "LD_LIBRARY_PATH"):
        value = os.environ.get(key)
        if value:
            environment[key] = value
    return environment


def _run_synthstrip(
    command: Sequence[str],
    *,
    work_directory: Path,
    threads: int,
) -> None:
    try:
        completed = subprocess.run(  # noqa: S603 - Pass a fixed argv list without a shell.
            list(command),
            cwd=work_directory,
            env=_synthstrip_environment(work_directory, threads),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=_SYNTHSTRIP_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise SynthStripExecutionError(
            "Complete SynthStrip within its bounded timeout."
        ) from exc
    except OSError as exc:
        raise SynthStripExecutionError("Start SynthStrip successfully.") from exc
    if completed.returncode != 0:
        raise SynthStripExecutionError(
            f"Resolve SynthStrip exit status {completed.returncode}."
        )


def _crop_preparation(  # noqa: PLR0913
    source_path: Path,
    source: NiftiImage,
    derivatives_root: Path,
    signature: str,
    signature_payload: Mapping[str, Any],
    provider: Mapping[str, Any],
    helper: Mapping[str, Any],
    margin_mm: int,
    synthstrip_executable: str,
    threads: int,
    subject_id: str | None = None,
) -> dict[str, Any]:
    paths = build_derivative_paths(derivatives_root, source_path, signature, subject_id)
    roles = ["t1", "mask", "qc"]
    existing = verify_published_derivative_set(paths, roles)
    if existing is not None:
        return _result_document(
            mode="crop",
            paths=paths,
            publication=existing,
            roles=roles,
        )
    work_root = derivatives_root / "supraspina-brainfov" / ".work"
    work_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        with tempfile.TemporaryDirectory(
            prefix=".prepare-",
            dir=work_root,
        ) as temporary:
            work_directory = Path(temporary)
            stripped_path = work_directory / "synthstrip-stripped.nii.gz"
            mask_path = work_directory / "synthstrip-mask.nii.gz"
            crop_path = work_directory / "prepared-crop.nii.gz"
            nested_command = [
                synthstrip_executable,
                "-i",
                str(source_path),
                "-o",
                str(stripped_path),
                "-m",
                str(mask_path),
                "-t",
                str(threads),
            ]
            _run_synthstrip(
                nested_command,
                work_directory=work_directory,
                threads=threads,
            )
            if (
                stripped_path.is_symlink()
                or not stripped_path.is_file()
                or mask_path.is_symlink()
                or not mask_path.is_file()
            ):
                raise SynthStripExecutionError(
                    "Produce regular SynthStrip output and mask files."
                )
            mask_image = read_nifti(mask_path)
            mask_summary = validate_brain_mask(source, mask_image)
            plan = plan_brain_fov_crop(
                source,
                mask_summary,
                margin_mm=margin_mm,
            )
            cropped = crop_nifti(source, plan, crop_path)
            validation = validate_cropped_nifti(source, cropped, plan)
            validation.update(
                {
                    "dominantMaskComponent": True,
                    "inputReadable": True,
                    "maskSourceGeometry": True,
                    "nestedCommandExitZero": True,
                    "qformOrSformValid": True,
                }
            )
            montage = generate_qc_montage(source, plan, mask_summary)
            provenance = build_brainfov_provenance(
                signature=signature,
                signature_payload=signature_payload,
                source=source,
                plan=plan,
                mask=mask_summary,
                provider=provider,
                helper=helper,
                nested_command=nested_command,
                validation=validation,
            )
            publication = publish_derivative_set(
                paths,
                {
                    "t1": read_bounded_regular(crop_path, _MAX_NIFTI_BYTES),
                    "mask": read_bounded_regular(mask_path, _MAX_NIFTI_BYTES),
                    "qc": montage.png,
                },
                provenance,
            )
    finally:
        try:
            work_root.rmdir()
        except OSError:
            pass
    return _result_document(
        mode="crop",
        paths=paths,
        publication=publication,
        roles=roles,
    )


def _prepare_from_arguments(arguments: argparse.Namespace) -> dict[str, Any]:
    source_path = Path(str(arguments.input_path))
    derivatives_root = Path(str(arguments.derivatives_root))
    _validate_cli_paths(source_path, derivatives_root)
    provider = _bounded_json_identity(arguments.provider_json, "provider")
    helper = _bounded_json_identity(arguments.helper_json, "helper")
    _validate_provider_identity(provider)
    _validate_helper_identity(helper)
    _validate_synthstrip_executable(arguments.synthstrip_executable)
    source = read_nifti(source_path)
    pass_through = fov_within_limit(source.fov_mm)
    runtime_identity = (
        {"mode": "passThrough"}
        if pass_through
        else {
            "mode": "crop",
            "synthstripExecutable": arguments.synthstrip_executable,
            "threads": arguments.threads,
        }
    )
    signature, signature_payload = build_preflight_signature(
        source_path,
        source,
        margin_mm=arguments.margin_mm,
        provider=provider,
        helper=helper,
        runtime=runtime_identity,
    )
    if pass_through:
        return _pass_through_preparation(
            source_path,
            source,
            derivatives_root,
            signature,
            signature_payload,
            provider,
            helper,
            arguments.margin_mm,
            _cli_subject_id(arguments),
        )
    return _crop_preparation(
        source_path,
        source,
        derivatives_root,
        signature,
        signature_payload,
        provider,
        helper,
        arguments.margin_mm,
        arguments.synthstrip_executable,
        arguments.threads,
        _cli_subject_id(arguments),
    )


def _cli_subject_id(arguments: argparse.Namespace) -> str | None:
    """Return the bounded ``--subject`` value, or None when it was not given."""
    raw = getattr(arguments, "subject_id", None)
    if not isinstance(raw, str) or not raw:
        return None
    if len(raw) > _MAX_CLI_SUBJECT_ID_LENGTH:
        raise BrainFovError("Provide a shorter brain-FOV subject id.")
    return raw


def _emit_bounded_result(document: Mapping[str, Any]) -> None:
    try:
        encoded = json.dumps(
            document,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError):
        encoded = (
            b'{"error":{"code":"BRAINFOV_PREPARE_FAILED",'
            b'"message":"Provide a serializable result."},"ok":false}'
        )
    if len(encoded) > _MAXIMUM_RESULT_JSON_BYTES:
        encoded = (
            b'{"error":{"code":"BRAINFOV_PREPARE_FAILED",'
            b'"message":"Keep the result within the bounded JSON limit."},"ok":false}'
        )
    sys.stdout.write(encoded.decode("ascii") + "\n")
    sys.stdout.flush()


def cli_main(argv: Sequence[str] | None = None) -> int:
    """Run the bounded in-container brain-FOV preparation command.

    Parameters
    ----------
    argv
        Provide arguments excluding the executable name. Use ``None`` to read
        ``sys.argv``.

    Returns
    -------
    int
        Return zero for a committed or verified preparation; otherwise return one.
    """
    try:
        arguments = _build_cli_parser().parse_args(argv)
        if arguments.operation != "prepare":
            raise BrainFovError("Provide a known brain-FOV helper operation.")
        result = _prepare_from_arguments(arguments)
    except (BrainFovError, OSError, ValueError) as exc:
        message = str(exc)[:_MAXIMUM_ERROR_MESSAGE_CHARACTERS]
        result = {
            "ok": False,
            "error": {
                "code": "BRAINFOV_PREPARE_FAILED",
                "message": message,
            },
        }
        _emit_bounded_result(result)
        return 1
    except Exception:
        result = {
            "ok": False,
            "error": {
                "code": "BRAINFOV_PREPARE_FAILED",
                "message": "Inspect the unexpected brain-FOV helper failure.",
            },
        }
        _emit_bounded_result(result)
        return 1
    _emit_bounded_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(cli_main())
