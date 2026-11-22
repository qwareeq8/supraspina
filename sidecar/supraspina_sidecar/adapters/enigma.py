"""Adapter for ENIGMA FreeSurfer QC after reconstruction.

Redistributable packaged support and operator-approved, checksum-verified
upstream assets resolve through :mod:`supraspina_sidecar.resources`, so nothing
depends on an external SCI_Map checkout. The backend-specific source wrapper
``enigma_fs_wrapper_script.sh`` serves licensed MATLAB, and
``compiled/enigma_fs_wrapper_script_compiled.sh`` serves the R2019b MATLAB
Runtime; the wrappers are distinct implementations that share portions of the
Bash measure-extraction logic. Steps 1 and 2 run Bash measure extraction, and
Steps 3 through 5 run the MATLAB or MCR montage renderers. All paths pass
through the wrappers' command-line interfaces.

The adapter reimplements no ENIGMA QC logic. It prefers the configured
``matlab`` backend and falls back to its PATH executable when needed, and it
supports the compiled ``mcr`` backend for hosts without licensed MATLAB.
Off-screen OpenGL Step 5 is wrapped in ``xvfb-run`` when ``DISPLAY`` is unset,
and an empty ``--mcrdir`` argument survives non-authoritative previews when no
Runtime root is configured.
"""

from __future__ import annotations

import csv
import hashlib
import os
import re
import struct
import threading
import zlib
from collections import Counter, OrderedDict
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import PurePosixPath
from typing import Any, TypeVar

from .. import resources
from . import tools
from .base import Adapter, Failure, StepStatus, Validation, register

_T = TypeVar("_T")

#: Map measures from Bash plus the three QC matrix columns owned by this step.
_QC_SUBSTEPS = ("qcsub", "qcic", "qcec")

#: List each QC output subdirectory and static HTML gallery filename in order
#: (subcortical -> qcsub, cortical-internal -> qcic, cortical-external -> qcec).
_QC_GALLERIES = (
    ("subcortical", "qc/subcortical", "ENIGMA_Subcortical_QC.html"),
    ("cortical_internal", "qc/cortical_internal", "ENIGMA_Cortical_QC.html"),
    ("cortical_external", "qc/cortical_external", "ENIGMA_External_QC.html"),
)

#: Map each renderer-facing protocol tab to the wrapper's gallery key.
GALLERY_KEY_BY_TAB = {
    "subcortical": "subcortical",
    "internal": "cortical_internal",
    "external": "cortical_external",
}

#: Render these slice positions as percentages of the axis extent.
_SUBCORTICAL_SLICES = ("20", "40", "60", "80")
_CORTICAL_SLICES = ("10", "20", "40", "50", "60", "80", "85", "90")

#: Use these plain-language names for external-surface hemisphere and view codes.
_HEMISPHERE_NAMES = {"lh": "Left hemisphere", "rh": "Right hemisphere"}
_VIEW_NAMES = {"lat": "lateral", "med": "medial"}

#: Retain at most this many galleries in the validation cache below. Allow three
#: galleries per run and several runs with different output directories.
_MAX_CACHED_GALLERIES = 12
#: Limit concurrent read-only file probes to prevent a cohort-scaled gallery from
#: flooding the host with I/O. Keep transient memory for one read per worker
#: small relative to the sizes written by the wrapper.
_MAX_VALIDATION_THREADS = 8
_IDENTITY_CACHE: OrderedDict[
    tuple[str, str, tuple[str, ...]],
    tuple[list[tuple[str, int, str]], list[tuple[str, tuple[int, int, int, int]]]],
] = OrderedDict()
_IDENTITY_LOCK = threading.Lock()

#: List the pure-Bash measure CSVs written by step_1 and step_2, faithfully to
#: the CSV TYPE.
_MEASURE_CSVS = (
    "measures/LandRvolumes.csv",
    "measures/CorticalMeasuresENIGMA_ThickAvg.csv",
    "measures/CorticalMeasuresENIGMA_SurfAvg.csv",
)

_SUPPORTED_BACKENDS = frozenset({"matlab", "mcr"})
#: Accept this saved choice too; it resolves to a supported backend at use time.
_AUTO_BACKEND = "auto"


def _resolved_backend(cfg: dict[str, Any]) -> str:
    """Resolve the saved backend choice, including ``auto``, to a backend id.

    Import lazily: the env package registers every probe on import and the
    adapters package is imported first, so a module-level import would be
    circular.
    """
    from ..env.matlab import effective_enigma_backend  # noqa: PLC0415

    return effective_enigma_backend(cfg)


_MAX_SUBJECTS = 5_000
_MAX_SUBJECT_ID_CHARS = 128
_MAX_MEASURE_BYTES = 64 * 1024 * 1024
_MAX_GALLERY_BYTES = 64 * 1024 * 1024
_MAX_PNG_BYTES = 64 * 1024 * 1024
_MIN_MEASURE_COLUMNS = 2
_MIN_PNG_BYTES = 57
_PNG_CHUNK_OVERHEAD = 12
_PNG_IHDR_BYTES = 13
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class _GalleryReferenceParser(HTMLParser):
    """Collect local image sources and links from one bounded QC gallery."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.sources: list[str] = []
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        """Collect the attributes that the upstream gallery wrapper writes."""
        values = {name.lower(): value for name, value in attrs}
        if tag.lower() == "img" and values.get("src") is not None:
            self.sources.append(str(values["src"]))
        elif tag.lower() == "a" and values.get("href") is not None:
            self.links.append(str(values["href"]))


def _safe_subject_id(value: str) -> bool:
    """Return whether a subject id is safe for the wrapper's relative paths."""
    return (
        bool(value)
        and len(value) <= _MAX_SUBJECT_ID_CHARS
        and value not in {".", ".."}
        and all(char.isalnum() or char in "._-" for char in value)
    )


def _read_subject_list(path: str) -> tuple[str, ...] | None:
    """Read one bounded, unique wrapper subject list, if it exists."""
    if not tools.file_nonempty(path) or os.path.getsize(path) > _MAX_MEASURE_BYTES:
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            subjects = tuple(line.strip() for line in handle if line.strip())
    except (OSError, UnicodeError):
        return None
    if (
        not subjects
        or len(subjects) > _MAX_SUBJECTS
        or len(set(subjects)) != len(subjects)
        or any(not _safe_subject_id(value) for value in subjects)
    ):
        return None
    return subjects


def _read_measure_subjects(  # noqa: PLR0911 - Fail closed for each malformed CSV condition.
    path: str,
) -> tuple[str, ...] | None:
    """Return exact ordered ``SubjID`` membership from one bounded measure CSV."""
    if not tools.file_nonempty(path) or os.path.getsize(path) > _MAX_MEASURE_BYTES:
        return None
    try:
        with open(path, newline="", encoding="utf-8-sig") as handle:
            reader = csv.reader(handle)
            header = next(reader)
            if (
                not header
                or header[0] != "SubjID"
                or len(header) < _MIN_MEASURE_COLUMNS
            ):
                return None
            subjects: list[str] = []
            for row in reader:
                if len(subjects) >= _MAX_SUBJECTS or len(row) != len(header):
                    return None
                value = row[0].strip()
                if not _safe_subject_id(value):
                    return None
                subjects.append(value)
    except (OSError, UnicodeError, csv.Error, StopIteration):
        return None
    if not subjects or len(subjects) != len(set(subjects)):
        return None
    return tuple(subjects)


@dataclass(frozen=True)
class GalleryPanel:
    """Represent one QC gallery montage panel and its two bound PNGs.

    Set ``montage_relative`` to the scaled panel displayed in the gallery grid,
    and set ``full_relative`` to the linked full-size render. Use the same file
    for both fields in the external-surface gallery, which the wrapper writes at
    only one size.
    """

    #: Set a stable per-panel key that is unique within one gallery.
    key: str
    #: Set the grouping label to the slice axis or external-surface hemisphere.
    group: str
    #: Set the position within the group to the slice percentage or surface view.
    detail: str
    #: Set the complete human-readable panel name.
    label: str
    #: Set the wrapper-relative path of the displayed montage panel.
    montage_relative: str
    #: Set the wrapper-relative path of the full-size render for the same panel.
    full_relative: str


def gallery_panels(gallery: str, subject: str) -> tuple[GalleryPanel, ...]:
    """Return the exact ordered montage panels the wrapper writes for a subject.

    Parameters
    ----------
    gallery
        Provide the wrapper gallery key (``subcortical``,
        ``cortical_internal``, or ``cortical_external``).

    Returns
    -------
    tuple of GalleryPanel
        Return the panels in protocol order.
    """
    panels: list[GalleryPanel] = []
    if gallery == "subcortical":
        for axis in ("Axial", "Coronal", "Sagittal"):
            for percent in _SUBCORTICAL_SLICES:
                prefix = f"{subject}/Subcortical_set_{axis}"
                panels.append(
                    GalleryPanel(
                        key=f"{axis.lower()}-{percent}",
                        group=axis,
                        detail=f"{percent}%",
                        label=f"{axis} {percent}%",
                        montage_relative=f"{prefix}_70_{percent}.png",
                        full_relative=f"{prefix}_{percent}.png",
                    )
                )
    elif gallery == "cortical_internal":
        for axis in ("Axial", "Coronal"):
            for percent in _CORTICAL_SLICES:
                prefix = f"{subject}/Cortical_set_{axis}"
                panels.append(
                    GalleryPanel(
                        key=f"{axis.lower()}-{percent}",
                        group=axis,
                        detail=f"{percent}%",
                        label=f"{axis} {percent}%",
                        montage_relative=f"{prefix}_70_{percent}.png",
                        full_relative=f"{prefix}_{percent}.png",
                    )
                )
    else:
        for hemisphere in ("lh", "rh"):
            for view in ("lat", "med"):
                relative = f"{subject}.{hemisphere}.{view}.png"
                group = _HEMISPHERE_NAMES[hemisphere]
                detail = _VIEW_NAMES[view]
                panels.append(
                    GalleryPanel(
                        key=f"{hemisphere}-{view}",
                        group=group,
                        detail=detail,
                        label=f"{group}, {detail}",
                        montage_relative=relative,
                        full_relative=relative,
                    )
                )
    return tuple(panels)


def _expected_gallery_references(
    gallery: str, subjects: tuple[str, ...]
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Return exact image-source and link sets written by the upstream wrapper."""
    sources: list[str] = []
    links: list[str] = []
    for subject in subjects:
        for panel in gallery_panels(gallery, subject):
            sources.append(panel.montage_relative)
            links.append(panel.full_relative)
    return tuple(sources), tuple(links)


def _normalize_gallery_reference(value: str) -> str | None:
    """Normalize one wrapper-local PNG reference and reject navigation syntax."""
    normalized = value.strip().removeprefix("file:")
    if (
        not normalized
        or "\\" in normalized
        or "?" in normalized
        or "#" in normalized
        or ":" in normalized
        or not normalized.lower().endswith(".png")
    ):
        return None
    path = PurePosixPath(normalized)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        return None
    return path.as_posix()


def _png_identity(  # noqa: PLR0911, PLR0912 - Fail closed under each PNG chunk rule.
    path: str,
) -> tuple[int, str] | None:
    """Validate one bounded PNG container and return its size and SHA-256."""
    try:
        size = os.path.getsize(path)
        if size < _MIN_PNG_BYTES or size > _MAX_PNG_BYTES or not os.path.isfile(path):
            return None
        with open(path, "rb") as handle:
            # Bound the read by the measured size instead of the ceiling. Avoid
            # reserving 64 MB for every image in a cohort-scaled gallery.
            data = handle.read(size + 1)
    except (OSError, struct.error):
        return None
    if len(data) != size or data[:8] != _PNG_SIGNATURE:
        return None

    offset = len(_PNG_SIGNATURE)
    chunk_index = 0
    saw_idat = False
    saw_iend = False
    while offset < len(data):
        if len(data) - offset < _PNG_CHUNK_OVERHEAD:
            return None
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_type = data[offset + 4 : offset + 8]
        data_start = offset + 8
        data_end = data_start + length
        chunk_end = data_end + 4
        if chunk_end > len(data) or not chunk_type.isalpha():
            return None
        expected_crc = struct.unpack(">I", data[data_end:chunk_end])[0]
        actual_crc = zlib.crc32(chunk_type)
        actual_crc = zlib.crc32(data[data_start:data_end], actual_crc) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            return None

        if chunk_index == 0:
            if chunk_type != b"IHDR" or length != _PNG_IHDR_BYTES:
                return None
            width, height, bit_depth, color_type, compression, filtering, interlace = (
                struct.unpack(">IIBBBBB", data[data_start:data_end])
            )
            valid_depths = {
                0: {1, 2, 4, 8, 16},
                2: {8, 16},
                3: {1, 2, 4, 8},
                4: {8, 16},
                6: {8, 16},
            }
            if (
                width == 0
                or height == 0
                or bit_depth not in valid_depths.get(color_type, set())
                or compression != 0
                or filtering != 0
                or interlace not in {0, 1}
            ):
                return None
        elif chunk_type == b"IHDR":
            return None
        elif chunk_type == b"IDAT":
            if saw_iend or length == 0:
                return None
            saw_idat = True
        elif chunk_type == b"IEND":
            if length != 0 or not saw_idat or chunk_end != len(data):
                return None
            saw_iend = True
        elif saw_iend:
            return None

        offset = chunk_end
        chunk_index += 1

    if not saw_iend:
        return None
    return size, hashlib.sha256(data).hexdigest()


def _probe_image(
    path: str,
) -> tuple[tuple[int, str] | None, tuple[int, int, int, int] | None]:
    """Validate one PNG and capture its filesystem identity in a single visit."""
    return _png_identity(path), _file_witness(path)


def _file_witness(path: str) -> tuple[int, int, int, int] | None:
    """Return the cheap filesystem identity of one file, or ``None``."""
    try:
        info = os.stat(path)
    except OSError:
        return None
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _map_bounded(work: Callable[[str], _T], paths: list[str]) -> list[_T]:
    """Apply one read-only probe to each path, in order, with bounded threads.

    Treat gallery validation as dominated by per-file latency rather than
    hashing: on the acceptance host, allow about 23 ms to open and read each of
    360 bound images while using almost no CPU. Overlap reads that release the
    interpreter lock to remove the wait. Keep results in caller order so
    validation remains deterministic.
    """
    if len(paths) <= 1:
        return [work(path) for path in paths]
    workers = min(_MAX_VALIDATION_THREADS, len(paths))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(work, paths))


def _cached_gallery_identity(
    key: tuple[str, str, tuple[str, ...]],
) -> list[tuple[str, int, str]] | None:
    """Return a previously validated gallery whose files are all unchanged.

    Restat every witnessed file in milliseconds instead of rehashing each
    gallery for every durable run that points at the same output directory.
    Reuse earlier validation on a hit because the witness uses the same
    filesystem identity already used by the application to prove that an
    artifact did not change under it.
    """
    with _IDENTITY_LOCK:
        entry = _IDENTITY_CACHE.get(key)
        if entry is None:
            return None
        identities, witnesses = entry
    observed = _map_bounded(_file_witness, [path for path, _ in witnesses])
    if any(observed[index] != witness for index, (_, witness) in enumerate(witnesses)):
        with _IDENTITY_LOCK:
            _IDENTITY_CACHE.pop(key, None)
        return None
    with _IDENTITY_LOCK:
        if key in _IDENTITY_CACHE:
            _IDENTITY_CACHE.move_to_end(key)
    return identities


def _remember_gallery_identity(
    key: tuple[str, str, tuple[str, ...]],
    identities: list[tuple[str, int, str]],
    witnesses: list[tuple[str, tuple[int, int, int, int]]],
) -> None:
    """Retain one validated gallery, bounded, for reuse while it is unchanged."""
    with _IDENTITY_LOCK:
        _IDENTITY_CACHE[key] = (identities, witnesses)
        _IDENTITY_CACHE.move_to_end(key)
        while len(_IDENTITY_CACHE) > _MAX_CACHED_GALLERIES:
            _IDENTITY_CACHE.popitem(last=False)


def _gallery_identity(  # noqa: PLR0911 - Fail closed for every invalid gallery condition.
    gallery: str,
    gallery_path: str,
    subjects: tuple[str, ...],
) -> tuple[list[tuple[str, int, str]], str | None]:
    """Validate exact gallery references and every referenced image."""
    cache_key = (gallery, gallery_path, subjects)
    cached = _cached_gallery_identity(cache_key)
    if cached is not None:
        return list(cached), None
    # Capture the witness before reading so the cached verdict binds to the
    # identity of exactly the bytes that were parsed.
    gallery_witness = _file_witness(gallery_path)
    if gallery_witness is None:
        return [], "Inspect the gallery; reading it failed."
    size = gallery_witness[2]
    if size <= 0 or size > _MAX_GALLERY_BYTES:
        return [], "Reject the gallery because its size is invalid."
    try:
        with open(gallery_path, encoding="utf-8") as handle:
            # Read the whole document using its measured byte size because
            # decoded characters never outnumber on-disk bytes. Read one extra
            # character to detect content appended after measurement.
            document = handle.read(size + 1)
    except (OSError, UnicodeError):
        return [], "Inspect the gallery; reading it failed."
    if len(document) > size:
        return [], "Reject the gallery because it changed after measurement."
    parser = _GalleryReferenceParser()
    try:
        parser.feed(document)
        parser.close()
    except ValueError:
        return [], "Repair the invalid gallery markup."
    sources = [_normalize_gallery_reference(value) for value in parser.sources]
    links = [_normalize_gallery_reference(value) for value in parser.links]
    if any(value is None for value in sources + links):
        return [], "Remove the unsafe image reference from the gallery."
    expected_sources, expected_links = _expected_gallery_references(gallery, subjects)
    if Counter(sources) != Counter(expected_sources) or Counter(links) != Counter(
        expected_links
    ):
        return [], "Restore gallery references to the exact cohort contract."

    root = os.path.dirname(gallery_path)
    # Reject a gallery replaced between the pre-read witness and the end of
    # parsing, so the cached verdict never binds to bytes it never parsed.
    if _file_witness(gallery_path) != gallery_witness:
        return [], "Reject the gallery because it changed during validation."
    relatives = sorted(set(expected_sources + expected_links))
    image_paths = [
        os.path.join(root, *PurePosixPath(relative).parts) for relative in relatives
    ]
    probed = _map_bounded(_probe_image, image_paths)
    identities: list[tuple[str, int, str]] = []
    witnesses: list[tuple[str, tuple[int, int, int, int]]] = [
        (gallery_path, gallery_witness)
    ]
    for relative, image_path, probe in zip(relatives, image_paths, probed, strict=True):
        identity, witness = probe
        if identity is None or witness is None:
            return [], "Restore the missing or invalid gallery image."
        identities.append((relative, identity[0], identity[1]))
        witnesses.append((image_path, witness))
    _remember_gallery_identity(cache_key, list(identities), witnesses)
    return identities, None


def verified_subject_panels(
    out_dir: str,
    tab: str,
    subjects: tuple[str, ...],
    subject_id: str,
) -> tuple[list[dict[str, Any]], str | None]:
    """Return one subject's verified montage panels for a detector-valid gallery.

    Revalidate the whole gallery exactly as :meth:`EnigmaAdapter.detect` does:
    require exact cohort references and a structurally valid, nonempty PNG
    behind every reference before describing any panel. Yield no panels when a
    gallery fails validation so the app displays only images accepted by the
    detector.

    Parameters
    ----------
    out_dir
        Provide the resolved ENIGMA output directory for the inspected run.
    tab
        Provide the renderer protocol tab (``subcortical``, ``internal``, or
        ``external``).
    subjects
        Provide exact ordered cohort membership for the inspected run.

    Returns
    -------
    tuple
        Return the panel records and ``None``, or return an empty list and the
        exact reason the gallery could not be described.
    """
    gallery = GALLERY_KEY_BY_TAB.get(tab)
    if gallery is None:
        return [], "Choose a valid QC gallery selector."
    if subject_id not in subjects:
        return [], "Choose a subject from this ENIGMA run cohort."
    subdir, name = next(
        (subdir, name) for key, subdir, name in _QC_GALLERIES if key == gallery
    )
    gallery_path = os.path.join(out_dir, subdir, name)
    identities, error = _gallery_identity(gallery, gallery_path, subjects)
    if error is not None:
        return [], f"ENIGMA {gallery.replace('_', ' ')}: {error}"
    by_relative = {relative: (size, sha) for relative, size, sha in identities}
    root = os.path.dirname(gallery_path)

    def image(relative: str) -> dict[str, Any]:
        size, sha = by_relative[relative]
        return {
            "relativePath": relative,
            "path": os.path.join(root, *PurePosixPath(relative).parts),
            "bytes": size,
            "sha256": sha,
        }

    panels: list[dict[str, Any]] = []
    for panel in gallery_panels(gallery, subject_id):
        if (
            panel.montage_relative not in by_relative
            or panel.full_relative not in by_relative
        ):
            return [], "Restore the missing or invalid ENIGMA gallery image."
        panels.append(
            {
                "key": panel.key,
                "group": panel.group,
                "detail": panel.detail,
                "label": panel.label,
                "montage": image(panel.montage_relative),
                "full": image(panel.full_relative),
            }
        )
    return panels, None


def _host_is_wsl() -> bool:
    """Detect the live WSL host without trusting a saved platform label."""
    try:
        with open("/proc/version", encoding="utf-8") as handle:
            return "microsoft" in handle.read().lower()
    except OSError:
        return False


_RELEASE_MAJOR = re.compile(r"release \S*?(\d+)\.\d+(?:\.\d+)?")


def _installed_freesurfer_major(env: dict[str, Any]) -> str | None:
    """Return the major version the FreeSurfer probe reported, if any."""
    for group in env.get("groups", []):
        for check in group.get("checks", []):
            if check.get("id") != "fshome" or check.get("status") != "found":
                continue
            match = _RELEASE_MAJOR.search(str(check.get("detail") or ""))
            return match.group(1) if match else None
    return None


class EnigmaAdapter(Adapter):
    """Adapt the ENIGMA FreeSurfer QC wrapper.

    Build one cohort-wide invocation of the ENIGMA wrapper that runs the
    measure-extraction Bash steps (1-2) and the MATLAB/MCR QC steps (3-5),
    and advance the three QC matrix columns.
    """

    key = "enigma"
    name = "ENIGMA QC"
    goal = (
        "Run ENIGMA FreeSurfer QA for subcortical and cortical measures, QC PNG "
        "montages, and static HTML galleries."
    )
    advances = _QC_SUBSTEPS

    def required_check_ids(self, cfg: dict[str, Any]) -> tuple[str, ...]:
        """Require the exact wrapper launcher, backend, and headless support.

        Under automatic selection the required backend is the first installed
        one, so a host with only the MATLAB Runtime is never asked for MATLAB.
        """
        backend = _resolved_backend(cfg)
        required = [
            "bash",
            "awk",
            "grep",
            "cat",
            "mkdir",
            backend,
            "enigma_assets",
        ]
        if _host_is_wsl():
            required.append("wslpath")
        if not os.environ.get("DISPLAY"):
            required.append("xvfb-run")
        return tuple(required)

    def validate(self, cfg: dict[str, Any], env: dict[str, Any]) -> Validation:
        """Block unsupported backends before command construction."""
        backend = str(self.params(cfg).get("backend") or _AUTO_BACKEND)
        if backend != _AUTO_BACKEND and backend not in _SUPPORTED_BACKENDS:
            return Validation(blocking=["Choose MATLAB or MCR as the ENIGMA backend."])
        validation = super().validate(cfg, env)
        # Launch refuses an fsVersion that differs from the FreeSurfer major
        # that produced the reconstructions. Say so while planning, when the
        # operator can still change the step option.
        installed = _installed_freesurfer_major(env)
        requested = str(self.params(cfg).get("fsVersion") or "7")
        if installed is not None and installed != requested:
            validation.blocking.append(
                f"Set the ENIGMA QC fsVersion option to {installed} to match the "
                f"installed FreeSurfer {installed}; the saved value is {requested}."
            )
        return validation

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the editable parameter schema for the ENIGMA QC step.

        Mirror the ``steps.ts`` ``enigma`` entry. Expose only reviewed wrapper
        arguments: the backend selector, backend executable or root, ENIGMA
        script directory, output directory, and ``--fs_version`` selector. Use
        the selector to choose FS7+ thalamus labels and the FS8 ``nu.mgz`` input
        volume. Apply the headless-MATLAB behavior only to the source backend.

        Returns
        -------
        dict
            Map each parameter name to its kind, default, label, and applicable
            options.
        """
        return {
            "backend": {
                "kind": "choice",
                "default": "auto",
                "options": ["auto", "matlab", "mcr"],
                "label": "Configured QC backend",
            },
            "matlabExecutable": {
                "kind": "path",
                "default": "",
                "must": "any",
                "label": "MATLAB executable (matlab backend)",
            },
            "mcrRoot": {
                "kind": "path",
                "default": "",
                "must": "any",
                "label": "MATLAB Runtime root (mcr backend, R2019b/v9.7)",
            },
            "enigmaScriptDir": {
                "kind": "path",
                "default": "",
                "must": "any",
                "label": "ENIGMA script directory (blank = active reviewed assets)",
            },
            "outDir": {
                "kind": "path",
                "default": "${paths.qcOutputDir}",
                "must": "writable",
                "label": "QC output directory",
            },
            "fsVersion": {
                "kind": "choice",
                "default": "7",
                "options": ["5", "6", "7", "8"],
                "label": "FreeSurfer version (--fs_version)",
            },
        }

    # -- Path helpers ----------------------------------------------------------

    def _out_dir(self, cfg: dict[str, Any]) -> str:
        """Resolve the QC output directory from params or the config default."""
        params = self.params(cfg)
        template = str(params.get("outDir") or "${paths.qcOutputDir}")
        return self.resolve(template, cfg)

    def _fs_dir(self, cfg: dict[str, Any]) -> str:
        """Resolve the FreeSurfer ``SUBJECTS_DIR`` (derivatives/freesurfer)."""
        runtime = cfg.get("_supraspinaRuntime", {})
        view = runtime.get("freesurferView") if isinstance(runtime, dict) else None
        if isinstance(view, str) and view:
            return view
        return self.resolve("${paths.derivativesDir}/freesurfer", cfg)

    def _base_dir(self, cfg: dict[str, Any]) -> str:
        """Resolve the ENIGMA asset base directory.

        Prefer an explicit ``enigmaScriptDir`` override resolved against the
        config. Use the active packaged-or-acquired resource root otherwise.
        Avoid any dependency on an external SCI_Map checkout.
        """
        configured = self.resolve(
            str(self.params(cfg).get("enigmaScriptDir") or ""), cfg
        )
        return configured or str(resources.enigma_dir())

    def _script_dir(self, cfg: dict[str, Any], backend: str) -> str:
        """Resolve the ENIGMA dependency directory for the chosen backend.

        Invoke the ``run_*.sh`` launchers and binaries under ``compiled`` for
        the compiled (``mcr``) backend. Add the ``ENIGMA_QC`` MATLAB sources to
        the path via ``addpath(genpath(...))`` for the source (``matlab``)
        backend. Resolve both under the bundled asset base.
        """
        leaf = "compiled" if backend == "mcr" else "ENIGMA_QC"
        return os.path.join(self._base_dir(cfg), leaf)

    def _wrapper(self, cfg: dict[str, Any], backend: str) -> str:
        """Resolve the wrapper script path for the chosen backend."""
        base = self._base_dir(cfg)
        if backend == "mcr":
            return os.path.join(
                base, "compiled", "enigma_fs_wrapper_script_compiled.sh"
            )
        return os.path.join(base, "enigma_fs_wrapper_script.sh")

    def _subject_list(self, cfg: dict[str, Any]) -> str:
        """Resolve the subjects list file the wrapper iterates with ``cat``.

        Read one FreeSurfer subject id per line from this wrapper input. Let the
        GUI write the file, and use the run-owned placeholder path here.
        """
        runtime = cfg.get("_supraspinaRuntime", {})
        subject_list = (
            runtime.get("cohortSubjectsFile") if isinstance(runtime, dict) else None
        )
        if isinstance(subject_list, str) and subject_list:
            return subject_list
        return os.path.join(self._out_dir(cfg), "subjects.txt")

    # -- Command --------------------------------------------------------------

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the argv for one cohort-wide ENIGMA wrapper invocation.

        Treat the wrapper as cohort-wide because it iterates a subjects file.
        Accept ``subject_id`` for the dispatcher contract without embedding it
        in argv. Use the backend selector to choose the wrapper form and backend
        flag (``--matlab`` / ``--mcrdir``). Wrap the off-screen OpenGL step 5 in
        ``xvfb-run`` when ``DISPLAY`` is unset.

        Parameters
        ----------
        subject_id
            Provide a subject id for the dispatcher contract; expect this step
            to run the whole cohort at once without using it.
        """
        params = self.params(cfg)
        saved = str(params.get("backend") or _AUTO_BACKEND)
        if saved != _AUTO_BACKEND and saved not in _SUPPORTED_BACKENDS:
            raise ValueError("Choose MATLAB or MCR as the configured ENIGMA backend.")
        backend = _resolved_backend(cfg)

        out_dir = self._out_dir(cfg)
        fs_dir = self._fs_dir(cfg)
        script_dir = self._script_dir(cfg, backend)
        subjects = self._subject_list(cfg)
        fs_version = str(params.get("fsVersion") or "7")

        argv: list[str] = [
            "bash",
            self._wrapper(cfg, backend),
            "--subjects",
            subjects,
            "--fsdir",
            fs_dir,
            "--outdir",
            out_dir,
            "--script",
            script_dir,
        ]

        # Pass --mcrdir <MCR_ROOT> to the compiled wrapper and onward as $1 to
        # each run_*.sh launcher. Pass --matlab to the source wrapper.
        if backend == "mcr":
            mcr_root = self.resolve(str(params.get("mcrRoot") or ""), cfg)
            # Fall back to the conventional install roots when no root is
            # configured, matching the source backend's PATH fallback and the
            # Diagnostics detection rule.
            if not mcr_root:
                from ..env.matlab import ambient_mcr_root  # noqa: PLC0415

                mcr_root = ambient_mcr_root()
            argv += ["--mcrdir", mcr_root]
        else:
            matlab = self.resolve(str(params.get("matlabExecutable") or ""), cfg)
            # Fall back to MATLAB on PATH when no executable is configured, so the
            # source backend works out of the box on a host with MATLAB installed.
            if not matlab:
                matlab = tools.which("matlab") or "matlab"
            argv += ["--matlab", matlab]

        argv += [
            "--fs_version",
            fs_version,
            "--step_1",
            "true",
            "--step_2",
            "true",
            "--step_3",
            "true",
            "--step_4",
            "true",
            "--step_5",
            "true",
        ]

        # Wrap Step 5 in xvfb-run when DISPLAY is absent and the launcher exists.
        # Provide the virtual framebuffer required for off-screen OpenGL.
        if not os.environ.get("DISPLAY") and tools.which("xvfb-run"):
            return ["xvfb-run", "-a", *argv]
        return argv

    # -- Detector -------------------------------------------------------------

    def members(self, cfg: dict[str, Any]) -> frozenset[str] | None:
        """Return the ``SubjID`` set of the subcortical measure table."""
        return tools.read_csv_member_ids(
            os.path.join(self._out_dir(cfg), _MEASURE_CSVS[0]), "SubjID"
        )

    def detect(  # noqa: PLR0911 - Preserve distinct evidence for each postcondition.
        self, cfg: dict[str, Any], subject_id: str | None
    ) -> StepStatus:
        """Detect completion from the ENIGMA QC artifacts on disk.

        Honor the complete output type: require exact, unique cohort membership
        in all three measure CSVs; require each static HTML gallery to contain
        the wrapper's exact source and link references for that cohort; and
        require every referenced PNG to be structurally valid and nonempty.
        Never accept top-level HTML presence alone because the wrapper can
        return zero after a failed MATLAB child. Bind every gallery image to the
        detector receipt with a compact digest without expanding hundreds of
        paths into run state.

        Parameters
        ----------
        subject_id
            Provide a subject id for the dispatcher contract; expect the
            wrapper to write cohort-wide outputs without using it.

        Returns
        -------
        StepStatus
            Return the detected state with the real artifact paths.
        """
        out_dir = self._out_dir(cfg)

        measures = [
            os.path.join(out_dir, rel)
            for rel in _MEASURE_CSVS
            if tools.file_nonempty(os.path.join(out_dir, rel))
        ]
        galleries = [
            os.path.join(out_dir, subdir, name)
            for _gallery, subdir, name in _QC_GALLERIES
            if tools.file_nonempty(os.path.join(out_dir, subdir, name))
        ]
        artifacts = measures + galleries

        if len(galleries) != len(_QC_GALLERIES) or len(measures) != len(_MEASURE_CSVS):
            if not (galleries or measures):
                return StepStatus(
                    state="pending",
                    detail="Generate ENIGMA measures and QC galleries.",
                    artifacts=[],
                )
            return StepStatus(
                state="partial",
                detail=(
                    "Complete the ENIGMA outputs; currently find "
                    f"{len(galleries)}/{len(_QC_GALLERIES)} QC galleries and "
                    f"{len(measures)}/{len(_MEASURE_CSVS)} measure tables."
                ),
                artifacts=artifacts,
            )

        table_subjects = tuple(_read_measure_subjects(path) for path in measures)
        if any(subjects is None for subjects in table_subjects):
            return StepStatus(
                state="partial",
                detail="Repair the invalid ENIGMA measure schema or membership.",
                artifacts=artifacts,
            )
        canonical_subjects = table_subjects[0]
        if canonical_subjects is None or any(
            subjects != canonical_subjects for subjects in table_subjects[1:]
        ):
            return StepStatus(
                state="partial",
                detail="Make ENIGMA measure-table cohort membership consistent.",
                artifacts=artifacts,
            )

        subject_file = self._subject_list(cfg)
        expected_subjects = _read_subject_list(subject_file)
        if tools.file_nonempty(subject_file) and expected_subjects is None:
            return StepStatus(
                state="partial",
                detail="Repair the invalid ENIGMA run cohort membership.",
                artifacts=artifacts,
            )
        expected_subjects = expected_subjects or canonical_subjects
        if canonical_subjects != expected_subjects:
            return StepStatus(
                state="partial",
                detail="Match ENIGMA outputs to the exact run cohort membership.",
                artifacts=artifacts,
            )

        digest = hashlib.sha256()
        file_count = 0
        for gallery, subdir, name in _QC_GALLERIES:
            identities, error = _gallery_identity(
                gallery,
                os.path.join(out_dir, subdir, name),
                expected_subjects,
            )
            if error is not None:
                return StepStatus(
                    state="partial",
                    detail=(
                        "Review ENIGMA "
                        f"{gallery.replace('_', ' ')}: {error.rstrip('.')}."
                    ),
                    artifacts=artifacts,
                )
            for relative, size, sha256 in identities:
                digest.update(gallery.encode("utf-8"))
                digest.update(b"\0")
                digest.update(relative.encode("utf-8"))
                digest.update(b"\0")
                digest.update(str(size).encode("ascii"))
                digest.update(b"\0")
                digest.update(sha256.encode("ascii"))
                digest.update(b"\n")
                file_count += 1

        return StepStatus(
            state="done",
            detail=(
                "The three ENIGMA measure tables and galleries are verified for "
                f"{len(expected_subjects)} subjects ({file_count} PNGs)."
            ),
            artifacts=artifacts,
            content_identity={
                "schema": "enigma-gallery-images:v1",
                "subjectCount": len(expected_subjects),
                "fileCount": file_count,
                "sha256": digest.hexdigest(),
            },
        )

    # -- Failure parsing ------------------------------------------------------

    def parse_failure(self, rc: int, stdout: str, stderr: str) -> Failure | None:
        """Map a non-zero exit into a structured ENIGMA failure.

        Recognize the real signatures of this step: a missing MATLAB Runtime
        (shared-library load failures from the compiled binaries), off-screen
        OpenGL failures from step 5 (no virtual framebuffer), and a missing
        ``aseg.stats``/``aparc.stats`` input that recon-all should have written.

        Returns
        -------
        Failure or None
            Return ``None`` when ``rc`` is zero; otherwise, return a tagged
            failure.
        """
        if rc == 0:
            return None

        blob = f"{stderr}\n{stdout}".lower()

        if any(
            sig in blob
            for sig in (
                "error while loading shared libraries",
                "libmwmclmcrrt",
                "mcrroot",
                "matlab runtime",
                "could not find version",
            )
        ):
            return Failure(
                code=rc,
                tag="mcr_missing",
                message=(
                    "Install the required MATLAB Runtime or repair its loader path."
                ),
            )

        if any(
            sig in blob
            for sig in ("opengl", "glx", "xvfb", "cannot open display", "display")
        ):
            return Failure(
                code=rc,
                tag="display_missing",
                message=(
                    "Run the off-screen OpenGL render through a virtual framebuffer."
                ),
            )

        if any(
            sig in blob
            for sig in ("aseg.stats", "aparc.stats", "orig_nu.mgz", "no such file")
        ):
            return Failure(
                code=rc,
                tag="missing_input",
                message=(
                    "Run recon-all first to generate the missing FreeSurfer output."
                ),
            )

        return super().parse_failure(rc, stdout, stderr)


register(EnigmaAdapter())
