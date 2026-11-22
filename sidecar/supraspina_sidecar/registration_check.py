"""Advisory screen of each reconstructed hemisphere's surface registration.

``recon-all`` registers every hemisphere to FreeSurfer's folding atlas and
writes the result to ``?h.sphere.reg``. A registration can end in a wrong
optimum without any warning in ``recon-all.log``; the cortical parcels then
sit about one gyrus away from their anatomy. This module screens for that
failure. It resamples the subject's sulcal depth (``?h.sulc``) to
``fsaverage`` through the subject's own ``?h.sphere.reg`` with
``mri_surf2surf``, then correlates it with fsaverage's sulcal depth over the
whole cortex and over a dorsal frontoparietal region set. A hemisphere whose
correlation falls far below the cohort's is flagged for review. The cohort
serves as its own reference only once every hemisphere is checked; until then,
and throughout a check, the reference of the last complete check (or the
calibration reference) holds, so a flag never comes and goes mid-check.

The result is advisory: it never sets a QC verdict, never blocks work, and
never reads or writes a receipt. Results are cached in
``<projectRoot>/.supraspina/surface-registration.json`` under the SHA-256 of the
two input files, so a reopened project reads them at once and a changed
surface is checked again. A failure of the FreeSurfer setup rather than of a
hemisphere (a missing binary, a rejected license, a resample of fsaverage onto
itself that fails too) stops the check and is never cached per hemisphere.
"""

from __future__ import annotations

import contextlib
import fnmatch
import hashlib
import json
import math
import os
import queue
import re
import shutil
import stat
import statistics
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from array import array
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import IO, Any

from .adapters.fastsurfer import (
    AUTO_BACKEND,
    FASTSURFER_BACKEND,
    FREESURFER_BACKEND,
)
from .bounded_io import BoundedReadError, read_bounded_regular, sha256_bounded_regular
from .cohort import subject_in_config_scope
from .freesurfer_environment import freesurfer_runtime_environment
from .freesurfer_license import (
    is_readable_freesurfer_license,
    resolve_freesurfer_home,
    resolve_freesurfer_license_path,
)
from .paths import flatten, interpolate
from .project import ProjectEpochs, ProjectIdentity
from .workflow import validate_config_revision

#: The method identity. Change it whenever the measure changes, so every
#: cached result from an earlier method is checked again.
METHOD = "sulc-fsaverage-pearson-v1"
HEMISPHERES: tuple[str, ...] = ("lh", "rh")
#: The fsaverage aparc regions whose folds a failed registration shifts
#: most: the dorsal frontoparietal set.
DORSAL_FRONTOPARIETAL: frozenset[str] = frozenset(
    {
        "precentral",
        "postcentral",
        "paracentral",
        "superiorparietal",
        "supramarginal",
        "caudalmiddlefrontal",
        "superiorfrontal",
    }
)
#: Annotation names that are not cortex (the medial wall).
_NOT_CORTEX: frozenset[str] = frozenset({"unknown", "corpuscallosum"})

# -- Flag rule ----
# The limit of -3 sits between misregistered hemispheres, which fall at or
# below a robust z of about -3.66 on one measure, and correctly registered
# ones, which stay at or above about -2.91 on both;
# tests/fixtures/registration-calibration.tsv pins those margins. The median
# and the scaled median absolute deviation pool both hemispheres, because a
# misregistration can affect either one. A check
# walks the listing in order (controls first), so a reference built from the
# hemispheres checked so far would move and drop flags it had shown; see
# judging_reference for the reference each state uses.

#: Flag a hemisphere whose robust z on either measure falls below this.
ROBUST_Z_LIMIT = -3.0
#: Flag a hemisphere whose correlation on either measure falls below this,
#: whatever the cohort, so a cohort in which most registrations fail still
#: shows its worst ones.
ABSOLUTE_FLOOR = 0.70
#: Use the project's own cohort as the reference from this many hemispheres,
#: once every in-scope hemisphere is checked (see :func:`judging_reference`).
MIN_COHORT_HEMISPHERES = 20
#: Keep the robust scale from collapsing in a small or uniform cohort.
MIN_ROBUST_SCALE = 0.01
#: The consistency constant that turns a median absolute deviation into a
#: standard-deviation estimate for normally distributed values.
_MAD_TO_SD = 1.4826
#: The built-in medians and scaled deviations, used while a
#: project has too few checked hemispheres to be its own reference.
BUILTIN_REFERENCE: dict[str, tuple[float, float]] = {
    "cortex": (0.8342, 0.0198),
    "dfp": (0.8556, 0.0235),
}
MEASURES: tuple[str, ...] = ("dfp", "cortex")

# -- Bounds ----
MAX_CONCURRENCY = 4
_RESAMPLE_TIMEOUT_SECONDS = 600.0
_MAX_VERTICES = 2_000_000
_MAX_SURFACE_BYTES = 512 * 1024 * 1024
_MAX_CURV_BYTES = 16 + 4 * _MAX_VERTICES + 1024 * 1024
_MAX_ANNOT_BYTES = 64 * 1024 * 1024
_MAX_ANNOT_ENTRIES = 10_000
_MAX_ANNOT_NAME_BYTES = 1_024
_MAX_STORE_BYTES = 16 * 1024 * 1024
_MAX_STORE_ENTRIES = 20_000
#: Read the cache this many times before taking a file that changes under
#: every read as unusable; see :func:`_read_store`.
_STORE_READ_ATTEMPTS = 3
_MAX_SUBJECTS = 5_000
_MAX_DIRECTORY_ENTRIES = 100_000
_MAX_MESSAGE_CHARACTERS = 240
_MIN_CORRELATION_VERTICES = 3
#: Keep this much of each end of a call's output to tell why it failed; the
#: rest is read and dropped, so a call that floods its output uses no disk.
_MAX_OUTPUT_BYTES = 64 * 1024
#: Wait this long for a finished call's output to drain.
_OUTPUT_DRAIN_SECONDS = 5.0

# -- Failures that no hemisphere caused ----
_LICENSE_MISSING = (
    "The check needs the FreeSurfer license, and the license file was not "
    "found; choose it in Diagnostics."
)
_LICENSE_UNREADABLE = (
    "The check needs the FreeSurfer license, and the license file is empty or "
    "not readable; choose a readable one in Diagnostics."
)
_LICENSE_REJECTED = (
    "FreeSurfer did not accept its license file, so mri_surf2surf could not "
    "run; choose a valid license in Diagnostics."
)
_LIBRARIES_MISSING = "mri_surf2surf could not load its shared libraries."
_SETUP_PROBE_FAILED = (
    "mri_surf2surf also failed to resample fsaverage onto itself, so the "
    "FreeSurfer setup is the likely cause, and the hemispheres it failed on "
    "stay unchecked."
)
#: FreeSurfer's license errors ("FreeSurfer license file ... not found",
#: "error parsing license file", "Invalid FreeSurfer license key", and the
#: FS_LICENSE folder error).
_LICENSE_OUTPUT = re.compile(
    rb"FreeSurfer license|FS_LICENSE|license (?:file|key)", re.IGNORECASE
)
_LIBRARY_OUTPUT = re.compile(rb"error while loading shared libraries")

_CURV_MAGIC = b"\xff\xff\xff"
_CURV_HEADER = struct.Struct(">iii")
_CURV_HEADER_BYTES = len(_CURV_MAGIC) + _CURV_HEADER.size
_INT32 = struct.Struct(">i")
_ANNOT_COLOR_TABLE_TAG = 1
_ANNOT_TABLE_VERSION = 2
_STORE_NAME = "surface-registration.json"
_STORE_SCHEMA_VERSION = 1
_SUBJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_OPERATION_ID = re.compile(r"^srg-[a-f0-9]{16}$")
_REQUEST_KEYS = frozenset({"project", "cfg", "configRevision", "configSha256"})
_CHECK_KEYS = _REQUEST_KEYS | {"retryFailed"}
_CANCEL_KEYS = _REQUEST_KEYS | {"operationId"}


class RegistrationCheckError(ValueError):
    """Reject an input, a request, or a state the check cannot use."""


class RegistrationEnvironmentError(RegistrationCheckError):
    """Stop the whole check: FreeSurfer failed in a way no hemisphere caused.

    The check records nothing for the hemisphere that met it, because the same
    failure would meet every other one.
    """


class _Cancelled(Exception):
    """Stop one hemisphere because its operation was cancelled."""


# -- FreeSurfer file readers ----


def parse_curv(data: bytes) -> array:
    """Return the per-vertex values of a FreeSurfer new-format curv file.

    Parameters
    ----------
    data
        Provide the complete file contents.

    Returns
    -------
    array
        Return one float per vertex in file order.

    Raises
    ------
    RegistrationCheckError
        Raise when the header is not the new curv format, the vertex count is
        out of bounds, the file is short, or a value is not finite.
    """
    if len(data) < _CURV_HEADER_BYTES or data[: len(_CURV_MAGIC)] != _CURV_MAGIC:
        raise RegistrationCheckError("The file is not a FreeSurfer curv file.")
    vertices, faces, per_vertex = _CURV_HEADER.unpack_from(data, len(_CURV_MAGIC))
    if not 0 < vertices <= _MAX_VERTICES or faces < 0 or per_vertex != 1:
        raise RegistrationCheckError("The curv file header is not supported.")
    end = _CURV_HEADER_BYTES + 4 * vertices
    if len(data) < end:
        raise RegistrationCheckError("The curv file is shorter than its header.")
    values = array("f")
    values.frombytes(data[_CURV_HEADER_BYTES:end])
    if sys.byteorder == "little":
        values.byteswap()
    if not all(math.isfinite(value) for value in values):
        raise RegistrationCheckError("The curv file holds a value that is not finite.")
    return values


def read_curv(path: str | os.PathLike[str]) -> array:
    """Read one bounded curv file, following symbolic links to a regular file.

    Returns
    -------
    array
        Return one float per vertex.

    Raises
    ------
    RegistrationCheckError
        Raise when the file is unreadable, oversized, or malformed.
    """
    try:
        data = read_bounded_regular(os.path.realpath(path), _MAX_CURV_BYTES)
    except (BoundedReadError, OSError) as exc:
        raise RegistrationCheckError("The curv file is not readable.") from exc
    return parse_curv(data)


class _Reader:
    """Read big-endian fields from one bounded byte string."""

    def __init__(self, data: bytes) -> None:
        self._data = data
        self._offset = 0

    def int32(self) -> int:
        if self._offset + _INT32.size > len(self._data):
            raise RegistrationCheckError("The annotation file ends early.")
        (value,) = _INT32.unpack_from(self._data, self._offset)
        self._offset += _INT32.size
        return int(value)

    def raw(self, length: int) -> bytes:
        if length < 0 or self._offset + length > len(self._data):
            raise RegistrationCheckError("The annotation file ends early.")
        value = self._data[self._offset : self._offset + length]
        self._offset += length
        return value

    def name(self) -> str:
        length = self.int32()
        if not 0 <= length <= _MAX_ANNOT_NAME_BYTES:
            raise RegistrationCheckError("The annotation holds an oversized name.")
        return self.raw(length).split(b"\x00", 1)[0].decode("ascii", "replace")

    def int32_array(self, count: int) -> array:
        values = array("i")
        values.frombytes(self.raw(4 * count))
        if sys.byteorder == "little":
            values.byteswap()
        return values


def _color_table(reader: _Reader) -> dict[int, str]:
    """Return annotation value to structure name for one color table."""
    count = reader.int32()
    table: dict[int, str] = {}
    if count > 0:
        # The original format: entries follow the table's file name.
        if count > _MAX_ANNOT_ENTRIES:
            raise RegistrationCheckError("The annotation color table is too large.")
        reader.name()
        for _index in range(count):
            name = reader.name()
            red, green, blue, alpha = (reader.int32() for _ in range(4))
            table[red + (green << 8) + (blue << 16) + (alpha << 24)] = name
        return table
    if -count != _ANNOT_TABLE_VERSION:
        raise RegistrationCheckError("The annotation color table is not supported.")
    reader.int32()  # The largest structure index; entries carry their own.
    reader.name()
    entries = reader.int32()
    if not 0 <= entries <= _MAX_ANNOT_ENTRIES:
        raise RegistrationCheckError("The annotation color table is too large.")
    for _index in range(entries):
        reader.int32()
        name = reader.name()
        red, green, blue, _alpha = (reader.int32() for _ in range(4))
        table[red + (green << 8) + (blue << 16)] = name
    return table


def parse_annot(data: bytes) -> list[str | None]:
    """Return each vertex's structure name from a FreeSurfer annotation.

    Parameters
    ----------
    data
        Provide the complete ``.annot`` file contents.

    Returns
    -------
    list of str or None
        Return one name per vertex, or ``None`` where the vertex's value has
        no color-table entry.

    Raises
    ------
    RegistrationCheckError
        Raise when the file is malformed or carries no color table.
    """
    reader = _Reader(data)
    vertices = reader.int32()
    if not 0 < vertices <= _MAX_VERTICES:
        raise RegistrationCheckError("The annotation vertex count is out of bounds.")
    pairs = reader.int32_array(2 * vertices)
    values = [0] * vertices
    assigned = bytearray(vertices)
    for index in range(0, len(pairs), 2):
        vertex = pairs[index]
        if not 0 <= vertex < vertices:
            raise RegistrationCheckError("The annotation names a vertex out of range.")
        values[vertex] = pairs[index + 1]
        assigned[vertex] = 1
    if reader.int32() != _ANNOT_COLOR_TABLE_TAG:
        raise RegistrationCheckError("The annotation carries no color table.")
    table = _color_table(reader)
    return [
        table.get(value) if assigned[vertex] else None
        for vertex, value in enumerate(values)
    ]


def region_masks(names: Sequence[str | None]) -> dict[str, array]:
    """Return the cortex and dorsal frontoparietal vertex indices.

    Parameters
    ----------
    names
        Provide one annotation structure name per vertex.

    Returns
    -------
    dict of str to array
        Return ``cortex`` (every labeled vertex outside the medial wall) and
        ``dfp`` (the dorsal frontoparietal regions) as index arrays.
    """
    cortex = array("i")
    dfp = array("i")
    for vertex, name in enumerate(names):
        if name is None or name in _NOT_CORTEX:
            continue
        cortex.append(vertex)
        if name in DORSAL_FRONTOPARIETAL:
            dfp.append(vertex)
    return {"cortex": cortex, "dfp": dfp}


def pearson(x: Sequence[float], y: Sequence[float], indices: Sequence[int]) -> float:
    """Return the Pearson correlation of two vectors over selected indices.

    Parameters
    ----------
    x, y
        Provide two equally long value vectors.
    indices
        Provide the vertex indices to correlate over.

    Returns
    -------
    float
        Return the correlation, clamped to [-1, 1].

    Raises
    ------
    RegistrationCheckError
        Raise when fewer than three indices are given or either vector is
        constant over them.
    """
    count = len(indices)
    if count < _MIN_CORRELATION_VERTICES:
        raise RegistrationCheckError("Correlate over at least three vertices.")
    mean_x = math.fsum(x[index] for index in indices) / count
    mean_y = math.fsum(y[index] for index in indices) / count
    cross = sum_x = sum_y = 0.0
    for index in indices:
        dx = x[index] - mean_x
        dy = y[index] - mean_y
        cross += dx * dy
        sum_x += dx * dx
        sum_y += dy * dy
    if sum_x <= 0.0 or sum_y <= 0.0:
        raise RegistrationCheckError("The sulcal depth is constant over the region.")
    return max(-1.0, min(1.0, cross / math.sqrt(sum_x * sum_y)))


# -- Flag rule ----


@dataclass(frozen=True)
class Reference:
    """One measure's center and robust scale."""

    median: float
    scale: float


def robust_reference(values: Iterable[float]) -> Reference | None:
    """Return the median and scaled median absolute deviation of a cohort.

    Parameters
    ----------
    values
        Provide one measure's values across the checked hemispheres.

    Returns
    -------
    Reference or None
        Return ``None`` when fewer than :data:`MIN_COHORT_HEMISPHERES` values
        are given, so the caller falls back to :data:`BUILTIN_REFERENCE`.
    """
    items = list(values)
    if len(items) < MIN_COHORT_HEMISPHERES:
        return None
    center = statistics.median(items)
    deviation = statistics.median(abs(value - center) for value in items)
    return Reference(center, max(_MAD_TO_SD * deviation, MIN_ROBUST_SCALE))


def cohort_references(
    results: Iterable[tuple[float, float]],
) -> tuple[str, dict[str, Reference]]:
    """Return the reference source and one reference per measure.

    Parameters
    ----------
    results
        Provide ``(rCortex, rDfp)`` for every checked hemisphere, both sides
        pooled.

    Returns
    -------
    tuple of (str, dict)
        Return ``"cohort"`` with the cohort's references, or ``"builtin"``
        with the built-in references while the cohort is too small.
    """
    pairs = list(results)
    cortex = robust_reference(pair[0] for pair in pairs)
    dfp = robust_reference(pair[1] for pair in pairs)
    if cortex is None or dfp is None:
        return "builtin", {
            key: Reference(*value) for key, value in BUILTIN_REFERENCE.items()
        }
    return "cohort", {"cortex": cortex, "dfp": dfp}


@dataclass(frozen=True)
class JudgingReference:
    """The reference a status judges every checked hemisphere against.

    ``hemispheres`` is the size of the complete set a cohort reference comes
    from, and ``None`` for the calibration reference.
    """

    source: str
    hemispheres: int | None
    measures: dict[str, Reference]


def _builtin_judging_reference() -> JudgingReference:
    return JudgingReference(
        "builtin",
        None,
        {key: Reference(*value) for key, value in BUILTIN_REFERENCE.items()},
    )


def judging_reference(
    results: Sequence[tuple[float, float]],
    complete: bool,
    settled: JudgingReference | None,
) -> JudgingReference:
    """Choose the reference the checked hemispheres are judged against.

    A reference computed from part of a cohort moves as the rest is checked,
    and the listing order (controls first) makes the part unrepresentative,
    so flags would come and go. Only a complete set therefore serves as its
    own reference; a partial one keeps the reference of the last complete
    check, or the calibration reference before the first one.

    Parameters
    ----------
    results
        Provide ``(rCortex, rDfp)`` for every checked hemisphere.
    complete
        Provide whether every in-scope hemisphere has a current result. A
        running check never asks: it keeps the reference shown at its start.
    settled
        Provide the reference the last complete check stored, if any.

    Returns
    -------
    JudgingReference
        Return the cohort's own reference for a complete set, else the
        settled or calibration reference.
    """
    if complete:
        source, measures = cohort_references(results)
        return JudgingReference(
            source, len(results) if source == "cohort" else None, measures
        )
    return settled or _builtin_judging_reference()


@dataclass(frozen=True)
class Assessment:
    """The flag decision for one checked hemisphere."""

    flagged: bool
    measure: str
    z: float


def assess(
    r_cortex: float, r_dfp: float, references: dict[str, Reference]
) -> Assessment:
    """Decide whether one hemisphere's registration fits the atlas poorly.

    Parameters
    ----------
    r_cortex, r_dfp
        Provide the whole-cortex and dorsal frontoparietal correlations.
    references
        Provide the per-measure references from :func:`cohort_references`.

    Returns
    -------
    Assessment
        Return the decision and the measure that deviates most, with its
        robust z. The hemisphere is flagged when that z falls below
        :data:`ROBUST_Z_LIMIT` or either correlation falls below
        :data:`ABSOLUTE_FLOOR`.
    """
    values = {"cortex": r_cortex, "dfp": r_dfp}
    scores = {
        measure: (values[measure] - references[measure].median)
        / references[measure].scale
        for measure in MEASURES
    }
    measure = min(MEASURES, key=lambda item: scores[item])
    flagged = scores[measure] < ROBUST_Z_LIMIT or any(
        value < ABSOLUTE_FLOOR for value in values.values()
    )
    if flagged and scores[measure] >= ROBUST_Z_LIMIT:
        # Only the floor flagged it; name the measure below the floor.
        measure = min(MEASURES, key=lambda item: values[item])
    return Assessment(flagged, measure, scores[measure])


# -- Atlas ----


@dataclass(frozen=True)
class HemisphereAtlas:
    """fsaverage's sulcal depth and region masks for one hemisphere."""

    sulc: array
    masks: dict[str, array]


@dataclass(frozen=True)
class Atlas:
    """The fsaverage reference both hemispheres are compared with."""

    directory: str
    digest: str
    hemispheres: dict[str, HemisphereAtlas]


def _atlas_files(fsaverage: str) -> dict[str, str]:
    files: dict[str, str] = {}
    for hemi in HEMISPHERES:
        files[f"{hemi}.sulc"] = os.path.join(fsaverage, "surf", f"{hemi}.sulc")
        files[f"{hemi}.sphere.reg"] = os.path.join(
            fsaverage, "surf", f"{hemi}.sphere.reg"
        )
        files[f"{hemi}.aparc.annot"] = os.path.join(
            fsaverage, "label", f"{hemi}.aparc.annot"
        )
    return files


def _file_signature(path: str) -> list[int] | None:
    """Return size, modification time, and inode of the file a path names."""
    try:
        info = os.stat(path)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_SURFACE_BYTES:
        return None
    return [int(info.st_size), int(info.st_mtime_ns), int(info.st_ino)]


def _sha256(path: str) -> str:
    try:
        digest, _size = sha256_bounded_regular(
            os.path.realpath(path), _MAX_SURFACE_BYTES
        )
    except (BoundedReadError, OSError) as exc:
        raise RegistrationCheckError("An input surface file is not readable.") from exc
    return digest


def atlas_digest(fsaverage: str) -> str:
    """Return one digest of the method and every fsaverage file it reads.

    Returns
    -------
    str
        Return a SHA-256 over the method identity and each file's SHA-256.

    Raises
    ------
    RegistrationCheckError
        Raise when a file is missing or unreadable.
    """
    files = _atlas_files(fsaverage)
    digest = hashlib.sha256(METHOD.encode("ascii"))
    for name in sorted(files):
        digest.update(f"{name}:{_sha256(files[name])}\n".encode("ascii"))
    return digest.hexdigest()


def load_atlas(fsaverage: str) -> Atlas:
    """Read fsaverage's sulcal depth and aparc masks for both hemispheres.

    Returns
    -------
    Atlas
        Return the reference data and a digest of every file it depends on.

    Raises
    ------
    RegistrationCheckError
        Raise when a file is missing, unreadable, or inconsistent.
    """
    files = _atlas_files(fsaverage)
    digest = atlas_digest(fsaverage)
    hemispheres: dict[str, HemisphereAtlas] = {}
    for hemi in HEMISPHERES:
        sulc = read_curv(files[f"{hemi}.sulc"])
        try:
            annot = read_bounded_regular(
                os.path.realpath(files[f"{hemi}.aparc.annot"]), _MAX_ANNOT_BYTES
            )
        except (BoundedReadError, OSError) as exc:
            raise RegistrationCheckError(
                "The fsaverage parcellation is not readable."
            ) from exc
        names = parse_annot(annot)
        if len(names) != len(sulc):
            raise RegistrationCheckError(
                "The fsaverage parcellation and sulcal depth disagree in size."
            )
        masks = region_masks(names)
        if len(masks["dfp"]) < _MIN_CORRELATION_VERTICES:
            raise RegistrationCheckError(
                "The fsaverage parcellation lacks the dorsal frontoparietal regions."
            )
        hemispheres[hemi] = HemisphereAtlas(sulc, masks)
    return Atlas(fsaverage, digest, hemispheres)


def measure_hemisphere(resampled: array, atlas: HemisphereAtlas) -> tuple[float, float]:
    """Return the whole-cortex and dorsal frontoparietal correlations.

    Parameters
    ----------
    resampled
        Provide the subject's sulcal depth resampled onto fsaverage.
    atlas
        Provide the same hemisphere's fsaverage reference.

    Returns
    -------
    tuple of (float, float)
        Return ``(rCortex, rDfp)``.

    Raises
    ------
    RegistrationCheckError
        Raise when the resampled map does not match fsaverage's vertex count.
    """
    if len(resampled) != len(atlas.sulc):
        raise RegistrationCheckError(
            "The resampled sulcal depth does not match fsaverage's vertex count."
        )
    return (
        pearson(resampled, atlas.sulc, atlas.masks["cortex"]),
        pearson(resampled, atlas.sulc, atlas.masks["dfp"]),
    )


# -- FreeSurfer resampling ----


@dataclass(frozen=True)
class ResampleJob:
    """Everything one ``mri_surf2surf`` resample needs."""

    binary: str
    environment: dict[str, str]
    subject_dir: str
    hemi: str
    fsaverage: str


#: ``(job, work_dir, cancel_event, track_process) -> resampled values``.
Resampler = Callable[
    [
        ResampleJob,
        str,
        threading.Event,
        Callable[[subprocess.Popen[bytes] | None], None],
    ],
    array,
]


def resample_with_mri_surf2surf(
    job: ResampleJob,
    work_dir: str,
    cancel: threading.Event,
    track: Callable[[subprocess.Popen[bytes] | None], None],
) -> array:
    """Resample one hemisphere's sulcal depth to fsaverage with FreeSurfer.

    Run ``mri_surf2surf`` in a private ``SUBJECTS_DIR`` of two symbolic links,
    one to the subject and one to fsaverage, so the call reads the subject's
    own ``?h.sphere.reg`` and writes only into ``work_dir``.

    Parameters
    ----------
    job
        Provide the binary, environment, subject, hemisphere, and fsaverage.
    work_dir
        Provide an empty private directory for the call.
    track
        Receive the started process, then ``None`` once it has ended.

    Returns
    -------
    array
        Return the resampled values, one per fsaverage vertex.

    Raises
    ------
    RegistrationEnvironmentError
        Raise when the binary cannot start, or its output shows a failure no
        hemisphere caused: a rejected FreeSurfer license or missing shared
        libraries.
    RegistrationCheckError
        Raise when the call fails, times out, or writes an unreadable result.
    """
    subjects = os.path.join(work_dir, "subjects")
    os.mkdir(subjects, 0o700)
    os.symlink(job.subject_dir, os.path.join(subjects, "src"), target_is_directory=True)
    os.symlink(
        job.fsaverage, os.path.join(subjects, "fsaverage"), target_is_directory=True
    )
    output = os.path.join(work_dir, f"{job.hemi}.sulc.fsaverage")
    argv = [
        job.binary,
        "--srcsubject",
        "src",
        "--trgsubject",
        "fsaverage",
        "--hemi",
        job.hemi,
        "--sval",
        os.path.join(subjects, "src", "surf", f"{job.hemi}.sulc"),
        "--sfmt",
        "curv",
        "--tval",
        output,
        "--tfmt",
        "curv",
    ]
    environment = dict(job.environment)
    environment["SUBJECTS_DIR"] = subjects
    environment["OMP_NUM_THREADS"] = "1"
    if cancel.is_set():
        raise _Cancelled
    try:
        process = subprocess.Popen(  # noqa: S603 - Pass a fixed argv without a shell.
            argv,
            cwd=work_dir,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as exc:
        reason = exc.strerror or type(exc).__name__
        raise RegistrationEnvironmentError(
            f"mri_surf2surf could not start ({reason})."
        ) from exc
    captured = _BoundedOutput(process.stdout)
    track(process)
    try:
        code = process.wait(timeout=_RESAMPLE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.wait()
        raise RegistrationCheckError(
            "mri_surf2surf did not finish within 10 minutes."
        ) from exc
    finally:
        track(None)
    if cancel.is_set():
        raise _Cancelled
    if code != 0:
        _raise_environment_failure(captured.read(_OUTPUT_DRAIN_SECONDS))
        raise RegistrationCheckError(f"mri_surf2surf ended with exit code {code}.")
    return read_curv(output)


class _BoundedOutput:
    """Drain one call's combined output, keeping only its first and last bytes.

    A background thread reads the pipe to its end, so the call never blocks
    on a full pipe, and keeps the first and last :data:`_MAX_OUTPUT_BYTES`.
    """

    def __init__(self, stream: IO[bytes] | None) -> None:
        self._stream = stream
        self._head = bytearray()
        self._tail = bytearray()
        self._thread = threading.Thread(
            target=self._drain, name="mri-surf2surf-output", daemon=True
        )
        self._thread.start()

    def _drain(self) -> None:
        if self._stream is None:
            return
        with contextlib.suppress(OSError, ValueError):
            descriptor = self._stream.fileno()
            while chunk := os.read(descriptor, _MAX_OUTPUT_BYTES):
                room = _MAX_OUTPUT_BYTES - len(self._head)
                if room > 0:
                    self._head += chunk[:room]
                    chunk = chunk[room:]
                self._tail += chunk
                if len(self._tail) > 2 * _MAX_OUTPUT_BYTES:
                    del self._tail[:-_MAX_OUTPUT_BYTES]
        with contextlib.suppress(OSError):
            self._stream.close()

    def read(self, timeout: float) -> bytes:
        """Return the kept output once the pipe ends or ``timeout`` passes."""
        self._thread.join(timeout)
        return bytes(self._head) + b"\n" + bytes(self._tail[-_MAX_OUTPUT_BYTES:])


def _raise_environment_failure(output: bytes) -> None:
    """Raise when a failed call's output names a failure no hemisphere caused.

    FreeSurfer checks its license when it first reads a file and exits with
    status 255 when the license is missing or invalid; the dynamic loader
    exits with status 127 when a shared library is missing. Neither says
    anything about the hemisphere, so neither may be recorded as its result.
    ``output`` holds the first and last :data:`_MAX_OUTPUT_BYTES` of the call's
    output.
    """
    if _LICENSE_OUTPUT.search(output):
        raise RegistrationEnvironmentError(_LICENSE_REJECTED)
    if _LIBRARY_OUTPUT.search(output):
        raise RegistrationEnvironmentError(_LIBRARIES_MISSING)


# -- Project resolution ----


def _reconstruction_dirs(cfg: dict[str, Any]) -> list[str]:
    """Return the backend output parents that may hold surfaces, in order."""
    paths = cfg.get("paths") if isinstance(cfg.get("paths"), dict) else {}
    raw = paths.get("derivativesDir") if isinstance(paths, dict) else None
    if not isinstance(raw, str) or not raw:
        return []
    derivatives = interpolate(raw, flatten(cfg))
    if "${" in derivatives or not os.path.isabs(derivatives):
        return []
    steps = cfg.get("steps") if isinstance(cfg.get("steps"), dict) else {}
    recon = steps.get("recon") if isinstance(steps, dict) else None
    params = recon.get("params") if isinstance(recon, dict) else None
    backend = (
        params.get("backend", FREESURFER_BACKEND)
        if isinstance(params, dict)
        else FREESURFER_BACKEND
    )
    if backend == FASTSURFER_BACKEND:
        backends = [FASTSURFER_BACKEND]
    elif backend == AUTO_BACKEND:
        backends = [FREESURFER_BACKEND, FASTSURFER_BACKEND]
    else:
        backends = [FREESURFER_BACKEND]
    return [os.path.join(derivatives, name) for name in backends]


def _subject_pattern(cfg: dict[str, Any]) -> str:
    patterns = cfg.get("patterns") if isinstance(cfg.get("patterns"), dict) else {}
    pattern = patterns.get("subjectGlob") if isinstance(patterns, dict) else None
    return pattern if isinstance(pattern, str) and pattern else "sub-*"


@dataclass(frozen=True)
class HemisphereInput:
    """The two input files of one subject hemisphere."""

    subject_id: str
    hemi: str
    subject_dir: str
    sphere_reg: str
    sulc: str

    @property
    def key(self) -> str:
        """Return the cache key of this subject hemisphere."""
        return f"{self.subject_id}:{self.hemi}"


def reconstructed_hemispheres(
    cfg: dict[str, Any],
) -> dict[str, list[HemisphereInput | None]]:
    """List each in-scope subject whose reconstruction has surfaces.

    Parameters
    ----------
    cfg
        Provide the saved project configuration.

    Returns
    -------
    dict
        Return subject ID to ``[lh, rh]``, each the hemisphere's inputs or
        ``None`` when one of its two files is missing. A subject with neither
        hemisphere is left out.
    """
    pattern = _subject_pattern(cfg)
    found: dict[str, list[HemisphereInput | None]] = {}
    for parent in _reconstruction_dirs(cfg):
        try:
            entries = sorted(os.listdir(parent))
        except OSError:
            continue
        if len(entries) > _MAX_DIRECTORY_ENTRIES:
            raise RegistrationCheckError(
                "The reconstruction folder holds too many entries to check."
            )
        for name in entries:
            if (
                name in found
                or not _SUBJECT_ID.fullmatch(name)
                or name.startswith("fsaverage")
                or not fnmatch.fnmatchcase(name, pattern)
                or not subject_in_config_scope(cfg, name)
            ):
                continue
            subject_dir = os.path.join(parent, name)
            if not os.path.isdir(subject_dir):
                continue
            hemispheres: list[HemisphereInput | None] = []
            for hemi in HEMISPHERES:
                sphere_reg = os.path.join(subject_dir, "surf", f"{hemi}.sphere.reg")
                sulc = os.path.join(subject_dir, "surf", f"{hemi}.sulc")
                present = _file_signature(sphere_reg) and _file_signature(sulc)
                hemispheres.append(
                    HemisphereInput(name, hemi, subject_dir, sphere_reg, sulc)
                    if present
                    else None
                )
            if any(hemispheres):
                found[name] = hemispheres
            if len(found) > _MAX_SUBJECTS:
                raise RegistrationCheckError(
                    "The project holds too many subjects to check."
                )
    return dict(sorted(found.items()))


@dataclass(frozen=True)
class Availability:
    """Whether FreeSurfer can run the check, and what it would use."""

    available: bool
    reason: str | None
    freesurfer_home: str = ""
    binary: str = ""
    fsaverage: str = ""
    license: str = ""


def _license_problem(path: str) -> str | None:
    """Return why the resolved license cannot serve FreeSurfer, or ``None``.

    Inspect metadata only; never open or read the license.
    """
    if is_readable_freesurfer_license(path):
        return None
    if not path or not os.path.exists(path):
        return _LICENSE_MISSING
    return _LICENSE_UNREADABLE


def freesurfer_availability(cfg: dict[str, Any]) -> Availability:
    """Return whether the configured FreeSurfer can run the check.

    The license is resolved exactly as the recon-all environment resolves it
    (project setting, then ``FS_LICENSE``, then ``license.txt`` and then
    ``.license`` under the FreeSurfer home), because that path is the
    ``FS_LICENSE`` every ``mri_surf2surf`` call receives.

    Parameters
    ----------
    cfg
        Provide the saved project configuration.

    Returns
    -------
    Availability
        Return the binary, fsaverage, and license to use, or the missing
        piece as a sentence.
    """
    home = resolve_freesurfer_home(cfg)
    if not home or not os.path.isdir(home):
        return Availability(
            False,
            "The check needs FreeSurfer, and no FreeSurfer install root is set.",
        )
    candidate = os.path.join(home, "bin", "mri_surf2surf")
    binary = (
        candidate
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK)
        else shutil.which("mri_surf2surf") or ""
    )
    if not binary:
        return Availability(
            False, "The check needs mri_surf2surf, which FreeSurfer did not provide."
        )
    fsaverage = os.path.join(home, "subjects", "fsaverage")
    if not all(_file_signature(path) for path in _atlas_files(fsaverage).values()):
        return Availability(
            False, "The check needs fsaverage, which the FreeSurfer install lacks."
        )
    license_path = resolve_freesurfer_license_path(cfg, freesurfer_home=home)
    problem = _license_problem(license_path)
    if problem is not None:
        return Availability(False, problem)
    return Availability(True, None, home, binary, fsaverage, license_path)


def environment_digest(availability: Availability) -> str | None:
    """Return a digest of the FreeSurfer setup a resample depends on.

    The digest covers the install root, the binary's path and file
    signature, and the license's path and file signature (metadata only).
    A failure recorded under one digest is checked again once the digest
    changes, so a repaired setup retries it without a request.

    Returns
    -------
    str or None
        Return the SHA-256, or ``None`` while FreeSurfer cannot run the check.
    """
    if not availability.available:
        return None
    binary = os.path.realpath(availability.binary) if availability.binary else ""
    parts = [
        availability.freesurfer_home,
        binary,
        _file_signature(binary) if binary else None,
        availability.license,
        _file_signature(availability.license) if availability.license else None,
    ]
    return hashlib.sha256(
        json.dumps(parts, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


# -- Cache ----


def store_path(project_root: str) -> str:
    """Return the project's registration-check cache path."""
    return os.path.join(project_root, ".supraspina", _STORE_NAME)


def _empty_store(atlas: str | None) -> dict[str, Any]:
    return {
        "schemaVersion": _STORE_SCHEMA_VERSION,
        "method": METHOD,
        "atlasSha256": atlas,
        "entries": {},
    }


def _valid_signature(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == len(("size", "mtime", "inode"))
        and all(
            isinstance(item, int) and not isinstance(item, bool) and item >= 0
            for item in value
        )
    )


def _valid_ratio(value: Any) -> bool:
    return (
        isinstance(value, float | int)
        and not isinstance(value, bool)
        and math.isfinite(value)
        and -1.0 <= value <= 1.0
    )


def _valid_entry(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    digests_ok = all(
        isinstance(value.get(key), str) and _SHA256.fullmatch(value[key])
        for key in ("sphereRegSha256", "sulcSha256")
    )
    signatures_ok = all(
        _valid_signature(value.get(key)) for key in ("sphereRegStat", "sulcStat")
    )
    error = value.get("error")
    if error is None:
        results_ok = _valid_ratio(value.get("rCortex")) and _valid_ratio(
            value.get("rDfp")
        )
    else:
        results_ok = (
            isinstance(error, str)
            and 0 < len(error) <= _MAX_MESSAGE_CHARACTERS
            and value.get("rCortex") is None
            and value.get("rDfp") is None
        )
    environment = value.get("environmentSha256")
    environment_ok = environment is None or (
        isinstance(environment, str) and _SHA256.fullmatch(environment) is not None
    )
    seconds = value.get("seconds")
    return (
        digests_ok
        and signatures_ok
        and results_ok
        and environment_ok
        and isinstance(seconds, float | int)
        and not isinstance(seconds, bool)
        and math.isfinite(seconds)
        and seconds >= 0
        and isinstance(value.get("checkedAt"), str)
    )


def _valid_settled_reference(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) != {"hemispheres", *MEASURES}:
        return False
    hemispheres = value["hemispheres"]
    return (
        isinstance(hemispheres, int)
        and not isinstance(hemispheres, bool)
        and MIN_COHORT_HEMISPHERES <= hemispheres <= 2 * _MAX_SUBJECTS
        and all(
            isinstance(value[measure], list)
            and len(value[measure]) == len(("median", "scale"))
            and _valid_ratio(value[measure][0])
            and _valid_ratio(value[measure][1])
            and value[measure][1] > 0
            for measure in MEASURES
        )
    )


def settled_reference(store: dict[str, Any]) -> JudgingReference | None:
    """Return the reference the last complete check stored, if any.

    Parameters
    ----------
    store
        Provide a cache document from :func:`load_store`.

    Returns
    -------
    JudgingReference or None
        Return the stored cohort reference, or ``None`` when none is stored.
    """
    value = store.get("reference")
    if not _valid_settled_reference(value):
        return None
    return JudgingReference(
        "cohort",
        value["hemispheres"],
        {measure: Reference(*value[measure]) for measure in MEASURES},
    )


def _stored_reference(reference: JudgingReference) -> dict[str, Any]:
    return {
        "hemispheres": reference.hemispheres,
        **{
            measure: [
                round(reference.measures[measure].median, 6),
                round(reference.measures[measure].scale, 6),
            ]
            for measure in MEASURES
        },
    }


def _read_store(path: str) -> bytes:
    """Return the cache file's bytes, reading again when a replace met the read.

    A running check replaces the file after each hemisphere. The bounded
    reader refuses a read whose lstat and open straddle that replace, since
    the path then names another file; both files are complete, so reading
    again returns the new one. A file that changes under every read, or that
    is not a bounded regular file, is refused after
    :data:`_STORE_READ_ATTEMPTS` reads.

    Raises
    ------
    BoundedReadError
        Raise when every read was refused.
    OSError
        Raise when the file cannot be read at all.
    """
    for _attempt in range(_STORE_READ_ATTEMPTS - 1):
        with contextlib.suppress(BoundedReadError):
            return read_bounded_regular(path, _MAX_STORE_BYTES)
    return read_bounded_regular(path, _MAX_STORE_BYTES)


def load_store(project_root: str) -> dict[str, Any]:
    """Return the cached results, or an empty cache when none is usable.

    The file is a cache: a missing, unreadable, or foreign-schema file reads
    as empty and is replaced by the next write. Besides the entries it may
    hold the cohort reference of the last complete check; an invalid one is
    dropped. A read that meets a running check's replace of the file reads
    it again rather than taking the cache as empty.

    Parameters
    ----------
    project_root
        Provide the canonical project root.

    Returns
    -------
    dict
        Return the cache document with only valid entries.
    """
    path = store_path(project_root)
    try:
        payload = _read_store(path)
        document = json.loads(payload.decode("utf-8"))
    except (BoundedReadError, OSError, UnicodeDecodeError, ValueError):
        return _empty_store(None)
    if (
        not isinstance(document, dict)
        or document.get("schemaVersion") != _STORE_SCHEMA_VERSION
        or document.get("method") != METHOD
        or not isinstance(document.get("entries"), dict)
    ):
        return _empty_store(None)
    atlas = document.get("atlasSha256")
    store = _empty_store(
        atlas if isinstance(atlas, str) and _SHA256.fullmatch(atlas) else None
    )
    for key, entry in list(document["entries"].items())[:_MAX_STORE_ENTRIES]:
        subject, _sep, hemi = key.rpartition(":")
        if (
            _SUBJECT_ID.fullmatch(subject)
            and hemi in HEMISPHERES
            and _valid_entry(entry)
        ):
            store["entries"][key] = entry
    if _valid_settled_reference(document.get("reference")):
        store["reference"] = document["reference"]
    return store


def write_store(project_root: str, store: dict[str, Any]) -> None:
    """Replace the project's cache file atomically.

    Parameters
    ----------
    project_root
        Provide the canonical project root.
    store
        Provide the complete cache document.

    Raises
    ------
    RegistrationCheckError
        Raise when the file cannot be written safely.
    """
    payload = (
        json.dumps(store, sort_keys=True, indent=1, ensure_ascii=True, allow_nan=False)
        + "\n"
    ).encode("ascii")
    if len(payload) > _MAX_STORE_BYTES:
        raise RegistrationCheckError("The registration-check cache grew too large.")
    path = store_path(project_root)
    parent = os.path.dirname(path)
    try:
        os.makedirs(parent, mode=0o700, exist_ok=True)
        info = os.lstat(parent)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise RegistrationCheckError("The project state folder is not a folder.")
        descriptor, temporary = tempfile.mkstemp(
            prefix=".surface-registration.tmp-", dir=parent
        )
    except OSError as exc:
        raise RegistrationCheckError(
            "The registration-check cache could not be written."
        ) from exc
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = ""
    except OSError as exc:
        raise RegistrationCheckError(
            "The registration-check cache could not be written."
        ) from exc
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def entry_matches(
    entry: dict[str, Any] | None, item: HemisphereInput, *, hashed: bool = False
) -> bool:
    """Return whether a cached entry still describes the hemisphere's files.

    Parameters
    ----------
    item
        Provide the hemisphere's current input paths.
    hashed
        Compare SHA-256 digests instead of the fast size, time, and inode
        signature. The digests are the cache key; the signature only spares a
        status read from hashing unchanged files.

    Returns
    -------
    bool
        Return ``True`` when the entry applies to the current files.
    """
    if entry is None:
        return False
    if hashed:
        return entry["sphereRegSha256"] == _sha256(item.sphere_reg) and entry[
            "sulcSha256"
        ] == _sha256(item.sulc)
    return entry["sphereRegStat"] == _file_signature(item.sphere_reg) and entry[
        "sulcStat"
    ] == _file_signature(item.sulc)


def failure_stale(entry: dict[str, Any] | None, environment: str | None) -> bool:
    """Return whether a cached failure predates the current FreeSurfer setup.

    A failure recorded without a setup digest, or under another one, may have
    come from the setup rather than the hemisphere, so it is checked again.

    Parameters
    ----------
    environment
        Provide :func:`environment_digest` of the current setup, or ``None``
        while FreeSurfer cannot run the check.

    Returns
    -------
    bool
        Return ``True`` for a failed entry to check again without a request.
    """
    return (
        entry is not None
        and bool(entry.get("error"))
        and environment is not None
        and entry.get("environmentSha256") != environment
    )


# -- Background operation ----


def _timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _bounded_message(exc: BaseException) -> str:
    if isinstance(exc, RegistrationCheckError):
        text = str(exc)
    else:
        text = f"The check stopped with {type(exc).__name__}."
    return text[:_MAX_MESSAGE_CHARACTERS] or "The check could not run."


@dataclass
class _Operation:
    operation_id: str
    project: ProjectIdentity
    total: int
    started_at: str
    completed: int = 0
    failed: int = 0
    state: str = "running"
    message: str | None = None
    finished_at: str | None = None
    #: The reference status showed when the check started; it judges every
    #: hemisphere while the check runs, so a flag never comes and goes.
    reference: JudgingReference | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    processes: set[subprocess.Popen[bytes]] = field(default_factory=set)
    thread: threading.Thread | None = None

    def public(self) -> dict[str, Any]:
        return {
            "operationId": self.operation_id,
            "state": self.state,
            "total": self.total,
            "completed": self.completed,
            "failed": self.failed,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "message": self.message,
        }


class _Recorder:
    """Cache one operation's finished hemispheres.

    A resample failure met before any resample has succeeded may come from
    the FreeSurfer setup or from its hemisphere, and counting alike failures
    cannot tell which: a sulcal depth that does not match its sphere fails
    within half a second, with the same exit code, on every broken subject,
    so all of a cohort's broken hemispheres can fail before the first sound
    one finishes. The first such failure therefore runs the operation's setup
    probe once, and any failure met meanwhile waits for it. A probe that
    succeeds shows that FreeSurfer runs, and each failure is cached as its
    hemisphere's; a probe that fails stops the operation with its reason, and
    none of those failures is cached.
    """

    def __init__(
        self,
        operation: _Operation,
        store: dict[str, Any],
        probe: Callable[[str], None],
    ) -> None:
        self._operation = operation
        self._store = store
        self._probe = probe
        self._proven = False
        self._probe_error: RegistrationEnvironmentError | None = None
        self._lock = threading.Lock()
        self._probe_lock = threading.Lock()

    def cached(self, key: str) -> dict[str, Any] | None:
        """Return the cached entry of one subject hemisphere, if any."""
        with self._lock:
            entry = self._store["entries"].get(key)
        return entry if isinstance(entry, dict) else None

    def record(
        self, item: HemisphereInput, entry: dict[str, Any], resampled: bool
    ) -> None:
        """Cache one entry once the setup has been shown to run.

        Raises
        ------
        RegistrationEnvironmentError
            Raise when the setup probe fails; the entry is not cached.
        _Cancelled
            Raise when the operation is cancelled during the probe.
        """
        if resampled and entry.get("error"):
            self._prove_setup(item.hemi)
        with self._lock:
            self._store["entries"][item.key] = entry
            if resampled and not entry.get("error"):
                self._proven = True
            self._write()

    def _prove_setup(self, hemi: str) -> None:
        """Run the setup probe unless a resample or an earlier probe succeeded."""
        with self._probe_lock:
            with self._lock:
                if self._proven:
                    return
            if self._probe_error is not None:
                raise self._probe_error
            try:
                self._probe(hemi)
            except RegistrationEnvironmentError as exc:
                self._probe_error = exc
                raise
            with self._lock:
                self._proven = True

    def _write(self) -> None:
        if not self._operation.cancel.is_set():
            write_store(self._operation.project.root, self._store)


class SurfaceRegistrationManager:
    """Run, cache, and report the advisory surface-registration check."""

    def __init__(
        self,
        projects: ProjectEpochs,
        *,
        resampler: Resampler | None = None,
        availability: Callable[[dict[str, Any]], Availability] | None = None,
        atlas_loader: Callable[[str], Atlas] | None = None,
        max_workers: int = MAX_CONCURRENCY,
    ) -> None:
        """Bind the manager to the process-wide project identity ledger."""
        self._projects = projects
        self._resampler = resampler or resample_with_mri_surf2surf
        self._availability = availability or freesurfer_availability
        self._atlas_loader = atlas_loader or load_atlas
        self._max_workers = max(1, max_workers)
        self._lock = threading.RLock()
        self._operation: _Operation | None = None
        self._atlases: dict[str, tuple[tuple[Any, ...], Atlas]] = {}
        self._digests: dict[str, tuple[tuple[Any, ...], str]] = {}

    # -- Requests ----

    def _context(
        self, request: Any, allowed: frozenset[str]
    ) -> tuple[ProjectIdentity, dict[str, Any], int]:
        if not isinstance(request, dict) or not set(request) <= allowed:
            raise RegistrationCheckError("Send a valid surface-registration request.")
        cfg = request.get("cfg")
        if not isinstance(cfg, dict):
            raise RegistrationCheckError("Send the saved project configuration.")
        revision = validate_config_revision(request.get("configRevision", 0))
        project = self._projects.validate(request.get("project"), cfg)
        return project, cfg, revision

    def status(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return every in-scope subject's check result and the running check.

        Parameters
        ----------
        request
            Provide ``project``, ``cfg``, and ``configRevision``.

        Returns
        -------
        dict
            Return availability, the reference, the operation, per-subject
            results, and counts. While a check runs, every checked hemisphere
            is judged against the reference shown when it started.
        """
        project, cfg, revision = self._context(request, _REQUEST_KEYS)
        self._cancel_foreign(project)
        # Read the operation before the results: a check that finishes in
        # between then still reads as running, so the reader asks again and
        # never takes a finished check's partial results as final.
        with self._lock:
            operation = self._operation
            owned = operation is not None and self._owns(operation, project)
            public = operation.public() if operation is not None and owned else None
            pinned = (
                operation.reference
                if operation is not None and owned and operation.state == "running"
                else None
            )
        availability = self._availability(cfg)
        listing = reconstructed_hemispheres(cfg)
        store = load_store(project.root)
        atlas = self._atlas_digest(availability)
        rows = self._rows(
            listing, store, atlas, environment_digest(availability), pinned
        )
        return {
            **rows,
            "configRevision": revision,
            "available": availability.available,
            "unavailableReason": availability.reason,
            "operation": public,
        }

    def check(self, request: dict[str, Any]) -> dict[str, Any]:
        """Start checking every hemisphere without a current result.

        Parameters
        ----------
        request
            Provide ``project``, ``cfg``, ``configRevision`` and, to check
            hemispheres whose last check failed again, ``retryFailed``.

        Returns
        -------
        dict
            Return the operation and whether this call started it.

        Raises
        ------
        RegistrationCheckError
            Raise when FreeSurfer cannot run the check.
        """
        project, cfg, _revision = self._context(request, _CHECK_KEYS)
        retry_failed = request.get("retryFailed", False)
        if not isinstance(retry_failed, bool):
            raise RegistrationCheckError("Send retryFailed as true or false.")
        self._cancel_foreign(project)
        with self._lock:
            running = self._operation
            if (
                running is not None
                and running.state == "running"
                and self._owns(running, project)
            ):
                return {"operation": running.public(), "started": False}
        availability = self._availability(cfg)
        if not availability.available:
            raise RegistrationCheckError(
                availability.reason or "The check needs FreeSurfer."
            )
        listing = reconstructed_hemispheres(cfg)
        store = load_store(project.root)
        atlas = self._atlas_digest(availability)
        setup = environment_digest(availability)
        work: list[HemisphereInput] = []
        for hemispheres in listing.values():
            for item in hemispheres:
                if item is None:
                    continue
                entry = (
                    store["entries"].get(item.key)
                    if store["atlasSha256"] == atlas
                    else None
                )
                if (
                    not entry_matches(entry, item)
                    or (retry_failed and entry is not None and entry.get("error"))
                    or failure_stale(entry, setup)
                ):
                    work.append(item)
        environment = freesurfer_runtime_environment(cfg, base_environment=os.environ)
        operation = _Operation(
            operation_id=f"srg-{uuid.uuid4().hex[:16]}",
            project=project,
            total=len(work),
            started_at=_timestamp(),
            reference=self._idle_reference(
                self._states(listing, store, atlas, setup), store, atlas
            ),
        )
        with self._lock:
            running = self._operation
            if running is not None and running.state == "running":
                if self._owns(running, project):
                    return {"operation": running.public(), "started": False}
                self._stop(running, "The project changed.")
            self._operation = operation
            thread = threading.Thread(
                target=self._run,
                args=(
                    operation,
                    work,
                    availability,
                    environment,
                    retry_failed,
                    setup,
                    listing,
                ),
                name="surface-registration-check",
                daemon=True,
            )
            operation.thread = thread
            thread.start()
        return {"operation": operation.public(), "started": True}

    def cancel(self, request: dict[str, Any]) -> dict[str, Any]:
        """Stop the project's running check; finished results stay cached.

        Parameters
        ----------
        request
            Provide ``project``, ``cfg``, ``configRevision``, and
            ``operationId``.

        Returns
        -------
        dict
            Return the operation ID and whether a running check was stopped.
        """
        project, _cfg, _revision = self._context(request, _CANCEL_KEYS)
        operation_id = request.get("operationId")
        if not isinstance(operation_id, str) or not _OPERATION_ID.fullmatch(
            operation_id
        ):
            raise RegistrationCheckError("Send a valid check operation ID.")
        with self._lock:
            operation = self._operation
            if (
                operation is None
                or operation.operation_id != operation_id
                or not self._owns(operation, project)
                or operation.state != "running"
            ):
                return {"operationId": operation_id, "stopped": False}
            self._stop(operation, None)
        return {"operationId": operation_id, "stopped": True}

    def stop_all(self, timeout: float = 0.0) -> None:
        """Stop any running check, for a project detach or sidecar shutdown."""
        with self._lock:
            operation = self._operation
            if operation is not None and operation.state == "running":
                self._stop(operation, None)
        thread = operation.thread if operation is not None else None
        if thread is not None and timeout > 0:
            thread.join(timeout)

    # -- Operation ----

    @staticmethod
    def _owns(operation: _Operation, project: ProjectIdentity) -> bool:
        return (
            operation.project.project_id == project.project_id
            and operation.project.root == project.root
        )

    def _cancel_foreign(self, project: ProjectIdentity) -> None:
        with self._lock:
            operation = self._operation
            if (
                operation is not None
                and operation.state == "running"
                and not self._owns(operation, project)
            ):
                self._stop(operation, "The project changed.")

    def _stop(
        self, operation: _Operation, message: str | None, state: str = "cancelled"
    ) -> None:
        operation.cancel.set()
        operation.state = state
        operation.message = message
        operation.finished_at = _timestamp()
        for process in list(operation.processes):
            with contextlib.suppress(OSError):
                process.kill()

    def _project_current(self, operation: _Operation) -> bool:
        return any(
            item.get("projectId") == operation.project.project_id
            and item.get("root") == operation.project.root
            for item in self._projects.attached()
        )

    @staticmethod
    def _atlas_signature(fsaverage: str) -> tuple[Any, ...]:
        return tuple(
            tuple(_file_signature(path) or ())
            for path in _atlas_files(fsaverage).values()
        )

    def _atlas_digest(self, availability: Availability) -> str | None:
        """Return the fsaverage digest without parsing, or ``None``."""
        if not availability.available:
            return None
        fsaverage = availability.fsaverage
        signature = self._atlas_signature(fsaverage)
        with self._lock:
            cached = self._digests.get(fsaverage)
            if cached is not None and cached[0] == signature:
                return cached[1]
        try:
            digest = atlas_digest(fsaverage)
        except RegistrationCheckError:
            return None
        with self._lock:
            self._digests[fsaverage] = (signature, digest)
        return digest

    def _atlas(self, fsaverage: str) -> Atlas:
        signature = self._atlas_signature(fsaverage)
        with self._lock:
            cached = self._atlases.get(fsaverage)
            if cached is not None and cached[0] == signature:
                return cached[1]
        atlas = self._atlas_loader(fsaverage)
        with self._lock:
            self._atlases[fsaverage] = (signature, atlas)
            self._digests[fsaverage] = (signature, atlas.digest)
        return atlas

    def _halt(self, operation: _Operation, exc: RegistrationCheckError) -> None:
        """End the operation as failed, killing its calls; nothing more is cached."""
        with self._lock:
            if operation.state == "running":
                self._stop(operation, _bounded_message(exc), state="failed")

    def _settle(
        self,
        operation: _Operation,
        listing: dict[str, list[HemisphereInput | None]],
        store: dict[str, Any],
        atlas: str,
        setup: str | None,
    ) -> None:
        """Store the cohort reference once every listed hemisphere is current.

        A later check of part of the cohort judges against this reference, as
        a status does while hemispheres are unchecked. The cache is written
        only when the stored reference changes.
        """
        states = self._states(listing, store, atlas, setup)
        if any(state == "pending" for state, _entry in states.values()):
            return
        reference = judging_reference(self._checked_results(states), True, None)
        previous = store.get("reference")
        if reference.source == "cohort":
            store["reference"] = _stored_reference(reference)
        else:
            store.pop("reference", None)
        if (
            store.get("reference") != previous
            and not operation.cancel.is_set()
            and self._project_current(operation)
        ):
            write_store(operation.project.root, store)

    def _run(  # noqa: PLR0913
        self,
        operation: _Operation,
        work: list[HemisphereInput],
        availability: Availability,
        environment: dict[str, str],
        retry_failed: bool,
        setup: str | None,
        listing: dict[str, list[HemisphereInput | None]],
    ) -> None:
        try:
            atlas = self._atlas(availability.fsaverage)
            store = load_store(operation.project.root)
            if store["atlasSha256"] != atlas.digest:
                store = _empty_store(atlas.digest)
            pending: queue.SimpleQueue[HemisphereInput] = queue.SimpleQueue()
            for item in work:
                pending.put(item)

            def probe(hemi: str) -> None:
                self._probe_setup(operation, atlas, availability, environment, hemi)

            recorder = _Recorder(operation, store, probe)

            def worker() -> None:
                while not operation.cancel.is_set():
                    if not self._project_current(operation):
                        with self._lock:
                            if operation.state == "running":
                                self._stop(operation, "The project changed.")
                        return
                    try:
                        item = pending.get_nowait()
                    except queue.Empty:
                        return
                    try:
                        outcome = self._check_one(
                            operation,
                            item,
                            atlas,
                            availability,
                            environment,
                            recorder,
                            retry_failed,
                            setup,
                        )
                        if outcome is None:
                            return
                        entry, resampled = outcome
                        recorder.record(item, entry, resampled)
                    except _Cancelled:
                        return
                    except RegistrationEnvironmentError as exc:
                        self._halt(operation, exc)
                        return
                    # Count a hemisphere only once its result is recorded.
                    with self._lock:
                        operation.completed += 1
                        if entry.get("error"):
                            operation.failed += 1

            threads = [
                threading.Thread(target=worker, name=f"surface-registration-{index}")
                for index in range(min(self._max_workers, max(1, len(work))))
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            # Settle before the operation reads as done, so a new check never
            # loads the cache without the reference this one stores.
            with self._lock:
                finishing = operation.state == "running"
            if finishing:
                self._settle(operation, listing, store, atlas.digest, setup)
            with self._lock:
                if operation.state == "running":
                    operation.state = "done"
                    operation.finished_at = _timestamp()
        except Exception as exc:  # Report every failure as operation state.
            with self._lock:
                if operation.state == "running":
                    operation.state = "failed"
                    operation.message = _bounded_message(exc)
                    operation.finished_at = _timestamp()

    def _check_one(  # noqa: PLR0913
        self,
        operation: _Operation,
        item: HemisphereInput,
        atlas: Atlas,
        availability: Availability,
        environment: dict[str, str],
        recorder: _Recorder,
        retry_failed: bool,
        setup: str | None,
    ) -> tuple[dict[str, Any], bool] | None:
        """Return one hemisphere's new cache entry, or ``None`` when cancelled.

        The flag is ``True`` when the entry comes from a resample attempt
        rather than from reading the inputs or the cache.

        Raises
        ------
        RegistrationEnvironmentError
            Raise when FreeSurfer failed in a way the hemisphere did not cause.
        """
        started = time.monotonic()
        base: dict[str, Any] = {
            "sphereRegStat": _file_signature(item.sphere_reg) or [0, 0, 0],
            "sulcStat": _file_signature(item.sulc) or [0, 0, 0],
        }
        try:
            base["sphereRegSha256"] = _sha256(item.sphere_reg)
            base["sulcSha256"] = _sha256(item.sulc)
        except RegistrationCheckError as exc:
            return self._failed_entry(base, exc, started, setup), False
        cached = recorder.cached(item.key)
        if (
            cached is not None
            and cached["sphereRegSha256"] == base["sphereRegSha256"]
            and cached["sulcSha256"] == base["sulcSha256"]
            and not (retry_failed and cached.get("error"))
            and not failure_stale(cached, setup)
        ):
            # Same content under a new time stamp: keep the result.
            return {**cached, **base}, False
        entry = self._resample_one(
            operation, item, atlas, availability, environment, base, started, setup
        )
        return None if entry is None else (entry, True)

    def _resample_one(  # noqa: PLR0913
        self,
        operation: _Operation,
        item: HemisphereInput,
        atlas: Atlas,
        availability: Availability,
        environment: dict[str, str],
        base: dict[str, Any],
        started: float,
        setup: str | None,
    ) -> dict[str, Any] | None:
        """Resample and measure one hemisphere; ``None`` when cancelled."""
        job = ResampleJob(
            binary=availability.binary,
            environment=environment,
            subject_dir=item.subject_dir,
            hemi=item.hemi,
            fsaverage=atlas.directory,
        )
        try:
            with tempfile.TemporaryDirectory(prefix="supraspina-srg-") as work_dir:
                resampled = self._resampler(
                    job, work_dir, operation.cancel, self._tracker(operation)
                )
            r_cortex, r_dfp = measure_hemisphere(
                resampled, atlas.hemispheres[item.hemi]
            )
        except _Cancelled:
            return None
        except RegistrationEnvironmentError:
            if operation.cancel.is_set():
                return None
            raise
        except (RegistrationCheckError, OSError) as exc:
            if operation.cancel.is_set():
                return None
            return self._failed_entry(base, exc, started, setup)
        return {
            **base,
            "rCortex": round(r_cortex, 6),
            "rDfp": round(r_dfp, 6),
            "error": None,
            "seconds": round(time.monotonic() - started, 3),
            "checkedAt": _timestamp(),
        }

    def _probe_setup(
        self,
        operation: _Operation,
        atlas: Atlas,
        availability: Availability,
        environment: dict[str, str],
        hemi: str,
    ) -> None:
        """Resample fsaverage's sulcal depth onto fsaverage itself.

        The probe runs the same binary with the same environment and license
        as every hemisphere, on inputs known to be sound, so it fails only
        when the FreeSurfer setup does. One call takes about 2 seconds.

        Raises
        ------
        RegistrationEnvironmentError
            Raise with the probe's reason when it fails.
        _Cancelled
            Raise when the operation is cancelled meanwhile.
        """
        if operation.cancel.is_set():
            raise _Cancelled
        job = ResampleJob(
            binary=availability.binary,
            environment=environment,
            subject_dir=atlas.directory,
            hemi=hemi,
            fsaverage=atlas.directory,
        )
        try:
            with tempfile.TemporaryDirectory(prefix="supraspina-srg-") as work_dir:
                resampled = self._resampler(
                    job, work_dir, operation.cancel, self._tracker(operation)
                )
            measure_hemisphere(resampled, atlas.hemispheres[hemi])
        except RegistrationEnvironmentError:
            if operation.cancel.is_set():
                raise _Cancelled from None
            raise
        except (RegistrationCheckError, OSError) as exc:
            if operation.cancel.is_set():
                raise _Cancelled from None
            reason = (
                str(exc)
                if isinstance(exc, RegistrationCheckError)
                else f"The probe could not run ({exc.strerror or type(exc).__name__})."
            )
            raise RegistrationEnvironmentError(
                f"{_SETUP_PROBE_FAILED} {reason}"
            ) from exc

    def _tracker(
        self, operation: _Operation
    ) -> Callable[[subprocess.Popen[bytes] | None], None]:
        """Return the callback that lets a stop kill one call's process."""
        mine: list[subprocess.Popen[bytes]] = []

        def track(process: subprocess.Popen[bytes] | None) -> None:
            with self._lock:
                if process is None:
                    operation.processes.difference_update(mine)
                    mine.clear()
                    return
                mine.append(process)
                operation.processes.add(process)
                if operation.cancel.is_set():
                    process.kill()

        return track

    @staticmethod
    def _failed_entry(
        base: dict[str, Any], exc: BaseException, started: float, setup: str | None
    ) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "sphereRegSha256": base.get("sphereRegSha256", "0" * 64),
            "sulcSha256": base.get("sulcSha256", "0" * 64),
            "sphereRegStat": base["sphereRegStat"],
            "sulcStat": base["sulcStat"],
            "rCortex": None,
            "rDfp": None,
            "error": _bounded_message(exc)
            if isinstance(exc, RegistrationCheckError)
            else "An input surface file is not readable.",
            "seconds": round(time.monotonic() - started, 3),
            "checkedAt": _timestamp(),
        }
        if setup is not None:
            entry["environmentSha256"] = setup
        return entry

    # -- Report ----

    @staticmethod
    def _states(
        listing: dict[str, list[HemisphereInput | None]],
        store: dict[str, Any],
        atlas: str | None,
        setup: str | None,
    ) -> dict[tuple[str, str], tuple[str, dict[str, Any] | None]]:
        """Return each listed hemisphere's state and its current entry."""
        atlas_current = atlas is None or store["atlasSha256"] == atlas
        states: dict[tuple[str, str], tuple[str, dict[str, Any] | None]] = {}
        for subject_id, hemispheres in listing.items():
            for hemi, item in zip(HEMISPHERES, hemispheres, strict=True):
                if item is None:
                    states[(subject_id, hemi)] = ("missing", None)
                    continue
                entry = store["entries"].get(item.key) if atlas_current else None
                if not entry_matches(entry, item) or failure_stale(entry, setup):
                    states[(subject_id, hemi)] = ("pending", None)
                elif entry is not None and entry.get("error"):
                    states[(subject_id, hemi)] = ("failed", entry)
                else:
                    states[(subject_id, hemi)] = ("checked", entry)
        return states

    @staticmethod
    def _checked_results(
        states: dict[tuple[str, str], tuple[str, dict[str, Any] | None]],
    ) -> list[tuple[float, float]]:
        return [
            (entry["rCortex"], entry["rDfp"])
            for state, entry in states.values()
            if state == "checked" and entry is not None
        ]

    @classmethod
    def _idle_reference(
        cls,
        states: dict[tuple[str, str], tuple[str, dict[str, Any] | None]],
        store: dict[str, Any],
        atlas: str | None,
    ) -> JudgingReference:
        """Return the reference while no check runs: the cohort's once complete."""
        atlas_current = atlas is None or store["atlasSha256"] == atlas
        return judging_reference(
            cls._checked_results(states),
            all(state != "pending" for state, _entry in states.values()),
            settled_reference(store) if atlas_current else None,
        )

    @classmethod
    def _rows(
        cls,
        listing: dict[str, list[HemisphereInput | None]],
        store: dict[str, Any],
        atlas: str | None,
        setup: str | None,
        pinned: JudgingReference | None = None,
    ) -> dict[str, Any]:
        states = cls._states(listing, store, atlas, setup)
        judged = pinned or cls._idle_reference(states, store, atlas)
        references = judged.measures
        counts = {"checked": 0, "pending": 0, "failed": 0, "missing": 0}
        flagged_subjects = 0
        flagged_hemispheres = 0
        subjects: list[dict[str, Any]] = []
        for subject_id in listing:
            rows: list[dict[str, Any]] = []
            subject_flagged = False
            for hemi in HEMISPHERES:
                state, entry = states[(subject_id, hemi)]
                counts[state] += 1
                row: dict[str, Any] = {
                    "hemisphere": hemi,
                    "state": state,
                    "rCortex": None,
                    "rDfp": None,
                    "flagged": False,
                    "measure": None,
                    "z": None,
                    "message": None,
                }
                if state == "checked" and entry is not None:
                    decision = assess(entry["rCortex"], entry["rDfp"], references)
                    row.update(
                        {
                            "rCortex": entry["rCortex"],
                            "rDfp": entry["rDfp"],
                            "flagged": decision.flagged,
                            "measure": decision.measure,
                            "z": round(decision.z, 3),
                        }
                    )
                    if decision.flagged:
                        subject_flagged = True
                        flagged_hemispheres += 1
                elif state == "failed" and entry is not None:
                    row["message"] = entry["error"]
                rows.append(row)
            flagged_subjects += int(subject_flagged)
            subjects.append(
                {
                    "subjectId": subject_id,
                    "flagged": subject_flagged,
                    "hemispheres": rows,
                }
            )
        return {
            "method": METHOD,
            "rule": {
                "zLimit": ROBUST_Z_LIMIT,
                "floor": ABSOLUTE_FLOOR,
                "minCohortHemispheres": MIN_COHORT_HEMISPHERES,
            },
            "reference": {
                "source": judged.source,
                # A cohort reference names the complete set it comes from; the
                # calibration reference, how many hemispheres are checked.
                "hemispheres": judged.hemispheres
                if judged.hemispheres is not None
                else counts["checked"],
                "cortex": {
                    "median": round(references["cortex"].median, 4),
                    "scale": round(references["cortex"].scale, 4),
                },
                "dfp": {
                    "median": round(references["dfp"].median, 4),
                    "scale": round(references["dfp"].scale, 4),
                },
            },
            "subjects": subjects,
            "counts": {
                "subjects": len(subjects),
                **counts,
                "flaggedSubjects": flagged_subjects,
                "flaggedHemispheres": flagged_hemispheres,
            },
        }
