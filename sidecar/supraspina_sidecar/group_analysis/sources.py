"""The v2 analysis input sources: tier A stats, labels, and imported variables.

Tier A sources read each subject's FreeSurfer stats files (``fsstats``);
the catalog lists a source's regions from the union of the first five
readable subjects and its availability as "n of N subjects have the file"
(``lstat`` only). A compute hashes every file it reads and records one
combined digest per source (input source ``stats:<sourceId>``).

A subject's recon folder is ``<derivativesDir>/<backend>/<id>`` for the
configured recon backend (``freesurfer`` by default; ``auto`` tries
FreeSurfer, then FastSurfer). Files are read with the bounded reader, which
refuses a symlinked final component, and never written.

Labeled atlases (tier B) read the project's labeling cache
(``.supraspina/analysis/atlases/<atlasId>/<subject>/labels.json``); a subregion
atlas reads a subject's recon files first and falls back to the cache when
the recon has none of that atlas's volume files. A compute records one
digest per labeled atlas (input source ``labels:<atlasId>``).

Imported variables tables arrive through the main-internal
``groupAnalysis.importVariables``: main's dialog gives the path; the sidecar
copies the CSV with bounded reads into
``.supraspina/analysis/variables/<tableId>.csv`` and lists it in
``tables.json`` (name, ID column, SHA-256, import time). The table ID is
``var-`` plus the first 16 hex digits of the file's SHA-256, so importing
the same bytes again returns the listed table. Nothing here is a project
configuration key, a receipt, or a plan input.
"""

from __future__ import annotations

import csv
import fnmatch
import hashlib
import io
import os
import re
import stat
import threading
from collections import OrderedDict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from ..bounded_io import BoundedReadError, read_bounded_regular
from . import atlas_cache, fsstats, store
from .dataset import (
    _MISSING_TOKENS,
    AnalysisContext,
    Tables,
    _candidates,
    _is_number,
    _resolve_path,
    _variable_entry,
    numeric_column,
)
from .spec import (
    PARC_METRICS,
    GroupAnalysisError,
    MeasureParts,
    is_extensive,
    measure_family,
    parse_measure_id,
    split_hemisphere_token,
)

VARIABLES_DIR = os.path.join(".supraspina", "analysis", "variables")
TABLES_SCHEMA = "supraspina/analysis-variable-tables"
TABLE_ID = re.compile(r"var-[a-f0-9]{16}")
#: The most imported tables a project keeps (``MAX_VARIABLE_TABLES``).
MAX_VARIABLE_TABLES = 16
#: The largest variables CSV an import copies.
MAX_VARIABLES_BYTES = 4 * 1024 * 1024
#: The subjects whose files name a source's regions in the catalog.
CATALOG_SAMPLE_SUBJECTS = 5


@dataclass(frozen=True)
class TierASource:
    """Describe one tier A source (``TIER_A_SOURCE_IDS``).

    ``files`` are paths under ``derivatives/freesurfer/<id>/`` with
    ``{hemi}`` for per-hemisphere files (``found-subregions`` lists
    ``fnmatch`` globs, since FreeSurfer versions name them differently);
    ``namespace`` is the measure namespace its values use.
    """

    source_id: str
    atlas_id: str
    namespace: str
    files: tuple[str, ...]
    hemisphere_rules: tuple[str, ...]


#: The tier A sources over per-subject recon files (``dk`` and ``aseg`` are
#: the v1 pipeline tables and are not listed here).
TIER_A_SOURCES: dict[str, TierASource] = {
    source.source_id: source
    for source in (
        TierASource(
            "a2009s", "a2009s", "parc", ("stats/{hemi}.aparc.a2009s.stats",), ("none",)
        ),
        TierASource(
            "dkt", "dkt", "parc", ("stats/{hemi}.aparc.DKTatlas.stats",), ("none",)
        ),
        TierASource(
            "dkpial", "dkpial", "parc", ("stats/{hemi}.aparc.pial.stats",), ("none",)
        ),
        TierASource("ba", "ba", "parc", ("stats/{hemi}.BA_exvivo.stats",), ("none",)),
        TierASource(
            "bathresh",
            "bathresh",
            "parc",
            ("stats/{hemi}.BA_exvivo.thresh.stats",),
            ("none",),
        ),
        TierASource("gwc", "gwc", "parc", ("stats/{hemi}.w-g.pct.stats",), ("none",)),
        TierASource(
            "wmparc",
            "wmparc",
            "vol",
            ("stats/wmparc.stats",),
            ("lh-rh-hyphen-infix", "left-right-prefix"),
        ),
        TierASource(
            "entowm", "entowm", "vol", ("stats/entowm.stats",), ("left-right-prefix",)
        ),
        TierASource(
            "synthseg",
            "synthseg",
            "vol",
            ("stats/synthseg.vol.csv",),
            ("left-right-prefix",),
        ),
        TierASource(
            "aseg-global",
            "aseg-global",
            "global",
            ("stats/aseg.stats", "stats/brainvol.stats", "stats/synthseg.tiv.dat"),
            ("none",),
        ),
        TierASource(
            "found-subregions",
            "brainstem-ss",
            "vol",
            (
                "mri/*brainstemSs*olumes*.txt",
                "mri/{hemi}.hippoSfVolumes*.txt",
                "mri/{hemi}.amygNucVolumes*.txt",
                "mri/ThalamicNuclei*olumes*.txt",
            ),
            ("none", "left-right-prefix"),
        ),
    )
}

#: The atlases whose volumes a recon may already have (``found-subregions``).
FOUND_SUBREGION_ATLASES = ("brainstem-ss", "hippo-amygdala", "thalamic")
#: The whole-brain measures of ``aseg-global``; eTIV and mean thickness stay
#: the aggregate tables' (``icv_data.csv``, ``cortical_thickness.csv``).
ASEG_GLOBALS: tuple[str, ...] = (
    "sTIV",
    "synthsegTIV",
    "BrainSegVol",
    "BrainSegVolNotVent",
    "CortexVol",
    "TotalGrayVol",
    "SubCortGrayVol",
    "CerebralWhiteMatterVol",
    "SupraTentorialVol",
    "SurfaceHoles",
)
_APARC_FAMILY = frozenset({"a2009s", "dkt", "dkpial", "ba", "bathresh"})
_ANATOMICAL = tuple(metric for metric in PARC_METRICS if metric != "GWC")
_IGNORED_REGIONS = frozenset({"unknown", "Unknown", "Medial_wall", "Medial_Wall"})
_MAX_MRI_ENTRIES = 4_096
_CACHE_LIMIT = 8_192
_CACHE: OrderedDict[tuple[Any, ...], ReconFile] = OrderedDict()
_CACHE_LOCK = threading.Lock()

#: One value's key: (atlas, hemisphere, region or structure, metric or None).
ValueKey = tuple[str, str, str, str | None]


# -- Recon files ----------------------------------------------------------------


@dataclass(frozen=True)
class ReconFile:
    """One subject's recon file as read: its digest and parsed content."""

    relpath: str
    present: bool
    sha256: str | None = None
    size: int | None = None
    parsed: Any = None
    reason: str | None = None


def recon_roots(cfg: Mapping[str, Any], project_root: str) -> list[str]:
    """Return the recon output parents in the order they are tried.

    Parameters
    ----------
    cfg
        The project configuration (``paths.derivativesDir`` and
        ``steps.recon.params.backend``).
    project_root
        The project root, for a relative derivatives folder.

    Returns
    -------
    list of str
        ``<derivativesDir>/freesurfer`` and, by backend, ``fastsurfer``;
        empty when the derivatives folder is not set.
    """
    paths = cfg.get("paths")
    raw = paths.get("derivativesDir") if isinstance(paths, Mapping) else None
    derivatives = _resolve_path(str(raw or ""), cfg, project_root)
    if derivatives is None:
        return []
    steps = cfg.get("steps")
    recon = steps.get("recon") if isinstance(steps, Mapping) else None
    params = recon.get("params") if isinstance(recon, Mapping) else None
    backend = params.get("backend") if isinstance(params, Mapping) else None
    if backend == "fastsurfer":
        names = ["fastsurfer"]
    elif backend == "auto":
        names = ["freesurfer", "fastsurfer"]
    else:
        names = ["freesurfer"]
    return [os.path.join(derivatives, name) for name in names]


def _is_dir(path: str) -> bool:
    try:
        return stat.S_ISDIR(os.stat(path).st_mode)
    except OSError:
        return False


def _signature(path: str) -> tuple[Any, ...] | None:
    try:
        info = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return None
    return (
        path,
        info.st_dev,
        info.st_ino,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def _parse(relpath: str, payload: bytes) -> Any:
    name = os.path.basename(relpath)
    if name.endswith(".stats"):
        return fsstats.parse_stats(payload, relpath)
    if name == "synthseg.vol.csv":
        return fsstats.parse_synthseg_volumes(payload)
    if name == "synthseg.tiv.dat":
        return fsstats.parse_tiv_dat(payload)
    return fsstats.parse_volumes_txt(payload)


def _pick(names: list[str]) -> str | None:
    """Pick one of several matching subregion files: the shortest name.

    FreeSurfer writes a T1-only file with the shortest name; among equal
    lengths the lexically last (the newest version) wins.
    """
    if not names:
        return None
    shortest = min(len(name) for name in names)
    return max(name for name in names if len(name) == shortest)


class ReconReader:
    """Read, hash, and parse per-subject recon files for one request."""

    def __init__(self, context: AnalysisContext, *, cache: bool = True) -> None:
        """Bind the reader to one project snapshot.

        Parameters
        ----------
        cache
            Reuse the parse of an unchanged file (same inode, size, and
            times). The compute worker reads without it, so a result's
            digests describe the bytes it used.
        """
        self._roots = recon_roots(context.cfg, context.project_root)
        self._cache = cache
        self._dirs: dict[str, str | None] = {}
        self._files: dict[tuple[str, str], ReconFile] = {}
        self._listing: dict[str, list[str]] = {}
        self._values: dict[tuple[str, str], dict[ValueKey, float]] = {}

    @property
    def configured(self) -> bool:
        """Say whether the derivatives folder is set."""
        return bool(self._roots)

    def subject_dir(self, subject_id: str) -> str | None:
        """Return the subject's recon folder, or None when there is none."""
        if subject_id not in self._dirs:
            self._dirs[subject_id] = next(
                (
                    path
                    for root in self._roots
                    if _is_dir(path := os.path.join(root, subject_id))
                ),
                None,
            )
        return self._dirs[subject_id]

    def _mri_names(self, subject_id: str) -> list[str]:
        if subject_id not in self._listing:
            folder = self.subject_dir(subject_id)
            names: list[str] = []
            if folder is not None:
                try:
                    with os.scandir(os.path.join(folder, "mri")) as entries:
                        for count, entry in enumerate(entries):
                            if count >= _MAX_MRI_ENTRIES:
                                break
                            if entry.name.endswith(".txt"):
                                names.append(entry.name)
                except OSError:
                    names = []
            self._listing[subject_id] = sorted(names)
        return self._listing[subject_id]

    def relpaths(self, source_id: str, subject_id: str) -> list[str]:
        """Return the files of one source a subject may have, globs expanded.

        A glob expands to the one matching file :func:`_pick` chooses; a
        per-hemisphere pattern expands to its ``lh`` and ``rh`` files.
        """
        paths: list[str] = []
        for pattern in TIER_A_SOURCES[source_id].files:
            hemis = ("lh", "rh") if "{hemi}" in pattern else ("",)
            for hemi in hemis:
                path = pattern.replace("{hemi}", hemi)
                if "*" in path:
                    folder, glob = path.split("/", 1)
                    del folder
                    chosen = _pick(
                        [
                            name
                            for name in self._mri_names(subject_id)
                            if fnmatch.fnmatchcase(name, glob)
                        ]
                    )
                    if chosen is not None:
                        paths.append(f"mri/{chosen}")
                else:
                    paths.append(path)
        return paths

    def exists(self, subject_id: str, relpath: str) -> bool:
        """Say whether one file is present as a regular file (``lstat``)."""
        folder = self.subject_dir(subject_id)
        return (
            folder is not None and _signature(os.path.join(folder, relpath)) is not None
        )

    def read(self, subject_id: str, relpath: str) -> ReconFile:
        """Read, hash, and parse one file once per request."""
        key = (subject_id, relpath)
        if key in self._files:
            return self._files[key]
        folder = self.subject_dir(subject_id)
        if folder is None:
            item = ReconFile(relpath, False, reason="The subject has no recon folder.")
        else:
            item = self._read_file(os.path.join(folder, relpath), relpath)
        self._files[key] = item
        return item

    def _read_file(self, path: str, relpath: str) -> ReconFile:
        signature = _signature(path) if self._cache else None
        if signature is not None:
            with _CACHE_LOCK:
                hit = _CACHE.get(signature)
                if hit is not None:
                    _CACHE.move_to_end(signature)
                    return hit
        try:
            payload = read_bounded_regular(path, fsstats.MAX_STATS_BYTES)
        except FileNotFoundError:
            return ReconFile(relpath, False, reason="The file does not exist.")
        except (BoundedReadError, OSError):
            return ReconFile(
                relpath,
                True,
                reason="The file is not a regular file within 4 MiB, or it "
                "changed while it was read.",
            )
        digest = hashlib.sha256(payload).hexdigest()
        try:
            parsed = _parse(relpath, payload)
        except GroupAnalysisError as exc:
            item = ReconFile(relpath, True, digest, len(payload), None, str(exc))
        else:
            item = ReconFile(relpath, True, digest, len(payload), parsed, None)
        if signature is not None and _signature(path) == signature:
            with _CACHE_LOCK:
                _CACHE[signature] = item
                while len(_CACHE) > _CACHE_LIMIT:
                    _CACHE.popitem(last=False)
        return item

    def values(self, source_id: str, subject_id: str) -> dict[ValueKey, float]:
        """Return one subject's values of one source, by value key."""
        key = (source_id, subject_id)
        if key not in self._values:
            files = [
                self.read(subject_id, path)
                for path in self.relpaths(source_id, subject_id)
            ]
            self._values[key] = _source_values(source_id, files)
        return self._values[key]

    def has_files(self, source_id: str, subject_id: str) -> bool:
        """Say whether a subject has the source's primary files (``lstat``).

        Both hemispheres of a per-hemisphere source, ``aseg.stats`` of
        ``aseg-global``, and any subregion volume file.
        """
        paths = self.relpaths(source_id, subject_id)
        if source_id == "found-subregions":
            return bool(paths) and any(self.exists(subject_id, p) for p in paths)
        if source_id == "aseg-global":
            paths = paths[:1]
        return bool(paths) and all(self.exists(subject_id, p) for p in paths)


def _hemisphere_of(relpath: str) -> str | None:
    name = os.path.basename(relpath)
    if name.startswith(("lh.", "rh.")):
        return name[:2]
    return None


def _split(rules: Iterable[str], name: str) -> tuple[str, str]:
    """Return a label's hemisphere (``mid`` when unpaired) and structure."""
    for rule in rules:
        hemisphere, structure = split_hemisphere_token(rule, name)
        if hemisphere is not None:
            return hemisphere, structure
    return "mid", name


def _source_values(  # noqa: PLR0912
    source_id: str, files: list[ReconFile]
) -> dict[ValueKey, float]:
    """Lay one subject's parsed files of one source out by value key."""
    source = TIER_A_SOURCES[source_id]
    values: dict[ValueKey, float] = {}
    usable = [item for item in files if item.parsed is not None]
    if source_id in _APARC_FAMILY or source_id == "gwc":
        for item in usable:
            hemisphere = _hemisphere_of(item.relpath)
            if hemisphere is None:
                continue
            for region, row in item.parsed.rows.items():
                if region in _IGNORED_REGIONS:
                    continue
                if source_id == "gwc":
                    if "Mean" in row:
                        values[(source_id, hemisphere, region, "GWC")] = row["Mean"]
                    continue
                for metric in _ANATOMICAL:
                    if metric in row:
                        values[(source_id, hemisphere, region, metric)] = row[metric]
    elif source_id in {"wmparc", "entowm"}:
        for item in usable:
            for name, row in item.parsed.rows.items():
                if "Volume_mm3" in row:
                    hemisphere, structure = _split(source.hemisphere_rules, name)
                    values[(source_id, hemisphere, structure, None)] = row["Volume_mm3"]
    elif source_id == "synthseg":
        for item in usable:
            for name, volume in item.parsed.items():
                hemisphere, structure = _split(source.hemisphere_rules, name)
                values[(source_id, hemisphere, structure, None)] = volume
    elif source_id == "aseg-global":
        for item in usable:
            name = os.path.basename(item.relpath)
            if name == "synthseg.tiv.dat":
                values[("global", "mid", "synthsegTIV", None)] = item.parsed
                continue
            for short, value in item.parsed.measures.items():
                if short in ASEG_GLOBALS:
                    values.setdefault(("global", "mid", short, None), value)
    else:
        for item in usable:
            name = os.path.basename(item.relpath)
            hemisphere = _hemisphere_of(item.relpath)
            if "brainstemSs" in name:
                atlas, rules = "brainstem-ss", ("none",)
            elif "ThalamicNuclei" in name:
                atlas, rules = "thalamic", ("left-right-prefix",)
            else:
                atlas, rules = "hippo-amygdala", ("none",)
            for label, volume in item.parsed.items():
                if hemisphere is not None:
                    values[(atlas, hemisphere, label, None)] = volume
                else:
                    side, structure = _split(rules, label)
                    values[(atlas, side, structure, None)] = volume
    return values


def measure_source_id(measure_id: str) -> str | None:
    """Return the tier A source of a measure, or None for any other source.

    Parameters
    ----------
    measure_id
        A valid measure ID.

    Returns
    -------
    str or None
        The source ID; None for the aggregate tables, Brain-PAD, and
        atlases only the labeling cache holds.
    """
    parts = parse_measure_id(measure_id)
    if parts is None:
        return None
    if parts.source == "parc" and parts.atlas in TIER_A_SOURCES:
        return parts.atlas
    if parts.source == "vol":
        if parts.atlas in {"wmparc", "entowm", "synthseg"}:
            return parts.atlas
        if parts.atlas in FOUND_SUBREGION_ATLASES:
            return "found-subregions"
    if parts.source == "global" and parts.name in ASEG_GLOBALS:
        return "aseg-global"
    return None


def _value_key(parts: MeasureParts, hemisphere: str) -> ValueKey:
    if parts.source == "parc":
        return (str(parts.atlas), hemisphere, str(parts.region), parts.metric)
    if parts.source == "vol":
        return (str(parts.atlas), hemisphere, str(parts.structure), None)
    return ("global", "mid", str(parts.name), None)


def measure_value(
    reader: ReconReader, measure_id: str, subject_id: str
) -> float | None:
    """Return one subject's value of one tier A measure (bilateral: the mean).

    Parameters
    ----------
    measure_id
        A measure whose :func:`measure_source_id` is not None.

    Returns
    -------
    float or None
        The value, or None when the file or the label is missing.
    """
    parts = parse_measure_id(measure_id)
    source_id = measure_source_id(measure_id)
    if parts is None or source_id is None:
        return None
    values = reader.values(source_id, subject_id)
    if parts.hemisphere == "bi":
        left = values.get(_value_key(parts, "lh"))
        right = values.get(_value_key(parts, "rh"))
        return None if left is None or right is None else (left + right) / 2
    return values.get(_value_key(parts, parts.hemisphere or "mid"))


def _measure_ids(keys: Iterable[ValueKey], source_id: str) -> list[str]:
    """Return the measure IDs of a set of value keys, bilateral means added."""
    seen = set(keys)
    ids: list[str] = []
    for atlas, hemisphere, name, metric in sorted(
        seen, key=lambda k: (k[0], k[3] or "", k[2], k[1])
    ):
        hemis = [hemisphere]
        if hemisphere == "lh" and (atlas, "rh", name, metric) in seen:
            hemis.append("bi")
        for hemi in hemis:
            if source_id == "aseg-global":
                measure_id = f"global:{name}"
            elif metric is not None:
                measure_id = f"parc:{atlas}:{hemi}:{name}:{metric}"
            else:
                measure_id = f"vol:{atlas}:{hemi}:{name}"
            if parse_measure_id(measure_id) is not None and measure_id not in ids:
                ids.append(measure_id)
    return ids


# -- Labeled atlases (tier B) ----------------------------------------------------


def labels_atlas(measure_id: str) -> str | None:
    """Return the atlas whose labeling cache can hold a measure, or None.

    Every ``parc`` and ``vol`` atlas that no tier A stats file fully serves:
    the subregion atlases (cache fallback), Yeo, and added atlases.
    """
    parts = parse_measure_id(measure_id)
    if parts is None or parts.source not in {"parc", "vol"} or parts.atlas is None:
        return None
    source_id = measure_source_id(measure_id)
    if source_id is not None and source_id != "found-subregions":
        return None
    return parts.atlas


class LabelReader:
    """Read the labeling cache's values for one request (``labels.json``)."""

    def __init__(self, project_root: str) -> None:
        """Bind the reader to one project root."""
        self.root = project_root
        self._values: dict[tuple[str, str], dict[str, float]] = {}
        self._any: dict[str, bool] = {}

    def values(self, atlas_id: str, subject_id: str) -> dict[str, float]:
        """Return one subject's cached values of one atlas (empty when none)."""
        key = (atlas_id, subject_id)
        if key not in self._values:
            manifest = None
            if atlas_cache.SUBJECT_ID.fullmatch(subject_id):
                try:
                    manifest = atlas_cache.read_labels(self.root, atlas_id, subject_id)
                except GroupAnalysisError:
                    manifest = None
            values = manifest["values"] if manifest else {}
            self._values[key] = {k: float(v) for k, v in values.items()}
        return self._values[key]

    def any(self, atlas_id: str) -> bool:
        """Say whether any subject has cached values of one atlas."""
        if atlas_id not in self._any:
            try:
                subjects = atlas_cache.labeled_subjects(self.root, atlas_id)
            except GroupAnalysisError:
                subjects = []
            self._any[atlas_id] = any(self.values(atlas_id, s) for s in subjects)
        return self._any[atlas_id]


def label_value(labels: LabelReader, measure_id: str, subject_id: str) -> float | None:
    """Return one subject's cached value of a measure (bilateral: the mean)."""
    parts = parse_measure_id(measure_id)
    atlas = labels_atlas(measure_id)
    if parts is None or atlas is None:
        return None
    values = labels.values(atlas, subject_id)
    if parts.hemisphere != "bi":
        return values.get(measure_id)
    left = values.get(_hemisphere_id(parts, "lh"))
    right = values.get(_hemisphere_id(parts, "rh"))
    return None if left is None or right is None else (left + right) / 2


def _hemisphere_id(parts: MeasureParts, hemisphere: str) -> str:
    if parts.source == "parc":
        return f"parc:{parts.atlas}:{hemisphere}:{parts.region}:{parts.metric}"
    return f"vol:{parts.atlas}:{hemisphere}:{parts.structure}"


def recon_has_atlas(reader: ReconReader, atlas_id: str, subject_id: str) -> bool:
    """Say whether a subject's recon holds volume files of a subregion atlas."""
    return any(
        key[0] == atlas_id for key in reader.values("found-subregions", subject_id)
    )


def labels_input(
    project_root: str, atlas_id: str, subject_ids: Iterable[str]
) -> dict[str, Any]:
    """Return one labeled atlas's ``AnalysisInputFile`` row (``labels:<id>``).

    The digest covers each subject's ``labels.json`` bytes, so labels that
    appear, change, or are cleared change it.
    """
    ordered = sorted(set(subject_ids))
    values, digest = atlas_cache.label_values(project_root, atlas_id, ordered)
    return {
        "source": f"labels:{atlas_id}",
        "present": bool(values),
        "reason": None
        if values
        else f"No included subject has labels of the {atlas_id} atlas.",
        "sha256": digest,
        "bytes": 0,
    }


def _labeled_atlases(project_root: str) -> list[str]:
    try:
        names = sorted(os.listdir(atlas_cache.cache_root(project_root)))
    except OSError:
        return []
    return [
        name
        for name in names
        if name != "templates"
        and not name.startswith("_")
        and os.path.isdir(os.path.join(atlas_cache.cache_root(project_root), name))
    ]


def label_catalog(
    context: AnalysisContext, subjects: list[str], listed: set[str]
) -> list[dict[str, Any]]:
    """Return the catalog entries of labeled atlases (stage ``labeling``).

    Measures come from the union of the first five labeled subjects in
    scope; a measure a tier A source already lists is skipped.
    """
    labels = LabelReader(context.project_root)
    scope = set(subjects)
    entries: list[dict[str, Any]] = []
    for atlas_id in _labeled_atlases(context.project_root):
        try:
            labeled = atlas_cache.labeled_subjects(context.project_root, atlas_id)
        except GroupAnalysisError:
            continue
        keys: set[ValueKey] = set()
        sampled = 0
        for subject_id in labeled:
            if subject_id not in scope or not labels.values(atlas_id, subject_id):
                continue
            for measure_id in labels.values(atlas_id, subject_id):
                parts = parse_measure_id(measure_id)
                if parts is not None and parts.hemisphere is not None:
                    keys.add(_value_key(parts, parts.hemisphere))
            sampled += 1
            if sampled >= CATALOG_SAMPLE_SUBJECTS:
                break
        entries.extend(
            {
                "measureId": measure_id,
                "source": measure_id.split(":", 1)[0],
                "family": measure_family(measure_id),
                "extensive": is_extensive(measure_id),
                "stage": "labeling",
                "available": True,
                "unavailableReason": None,
            }
            for measure_id in _measure_ids(keys, "labels")
            if measure_id not in listed
        )
    return entries


def file_label(source_id: str) -> str:
    """Name a source's primary file for fact sentences."""
    if source_id == "found-subregions":
        return "subregion volume files"
    return TIER_A_SOURCES[source_id].files[0].replace("{hemi}", "lh")


def project_subjects(context: AnalysisContext) -> set[str]:
    """Return every subject the project knows: registry and pipeline tables."""
    return set(_candidates(context, Tables(context)))


def inputs_signature(context: AnalysisContext, used: list[str]) -> list[Any]:
    """Return the file identities (not bytes) behind v2 input sources.

    Parameters
    ----------
    used
        Input sources such as ``stats:a2009s`` and ``variables:<tableId>``.

    Returns
    -------
    list
        One ``lstat`` signature per recon file of each tier A source (over
        every known subject) and per imported table and its listing, so a
        cached currency judgment is dropped when any of them changes.
    """
    reader = ReconReader(context, cache=False)
    subjects = sorted(project_subjects(context))
    out: list[Any] = []
    root = context.project_root
    if any(source.startswith("variables:") for source in used):
        out.append(_signature(_tables_path(root)))
    for source in used:
        kind, _sep, name = source.partition(":")
        if kind == "variables" and TABLE_ID.fullmatch(name):
            out.append(_signature(_table_path(root, name)))
        elif kind == "labels":
            with_labels = []
            try:
                folder = atlas_cache.atlas_dir(root, name)
                with_labels = atlas_cache.labeled_subjects(root, name)
            except GroupAnalysisError:
                folder = ""
            out.extend(
                (
                    source,
                    subject_id,
                    _signature(os.path.join(folder, subject_id, "labels.json")),
                )
                for subject_id in with_labels
            )
        elif kind == "stats" and name in TIER_A_SOURCES:
            for subject_id in subjects:
                folder = reader.subject_dir(subject_id)
                for relpath in reader.relpaths(name, subject_id):
                    path = os.path.join(folder, relpath) if folder else relpath
                    out.append((subject_id, relpath, _signature(path)))
    return out


def scope_subjects(context: AnalysisContext, tables: Tables | None = None) -> list[str]:
    """Return the candidate subjects in the configuration scope, sorted."""
    from ..cohort import config_subject_scope  # noqa: PLC0415

    include, exclude = config_subject_scope(dict(context.cfg))
    candidates = _candidates(context, tables or Tables(context))
    return [
        subject_id
        for subject_id in candidates
        if subject_id not in exclude and (not include or subject_id in include)
    ]


def _availability(
    reader: ReconReader, source_id: str, subjects: list[str]
) -> dict[str, Any]:
    with_files = [s for s in subjects if reader.has_files(source_id, s)]
    keys: set[ValueKey] = set()
    sampled = 0
    for subject_id in with_files:
        values = reader.values(source_id, subject_id)
        if values:
            keys.update(values)
            sampled += 1
        if sampled >= CATALOG_SAMPLE_SUBJECTS:
            break
    return {
        "total": len(subjects),
        "withFiles": len(with_files),
        "keys": keys,
    }


def source_availability(context: AnalysisContext, source_id: str) -> dict[str, Any]:
    """Count the subjects whose files of one source are present (``lstat``).

    Parameters
    ----------
    source_id
        One tier A source.

    Returns
    -------
    dict
        ``{"total": N, "withFiles": n, "regions": [...]}``: the subjects in
        the configuration scope, those with the source's primary files, and
        the region or structure names (hemisphere tokens removed) the first
        five readable subjects carry.
    """
    if source_id not in TIER_A_SOURCES:
        raise GroupAnalysisError("Choose a tier A source.")
    found = _availability(ReconReader(context), source_id, scope_subjects(context))
    return {
        "total": found["total"],
        "withFiles": found["withFiles"],
        "regions": sorted({key[2] for key in found["keys"]}),
    }


def catalog_measures(context: AnalysisContext, tables: Tables) -> list[dict[str, Any]]:
    """Return the tier A catalog entries (stage ``recon``).

    Parameters
    ----------
    tables
        The request's v1 tables (for the candidate subjects).

    Returns
    -------
    list of dict
        ``AnalysisMeasure`` rows. A source no subject has lists its fixed
        whole-brain measures as unavailable and nothing else, since its
        region names are unknown.
    """
    reader = ReconReader(context)
    subjects = scope_subjects(context, tables)
    entries: list[dict[str, Any]] = []
    for source_id in TIER_A_SOURCES:
        found = _availability(reader, source_id, subjects)
        ids = _measure_ids(found["keys"], source_id)
        reason = None
        if not found["withFiles"]:
            reason = f"No subject's reconstruction has {file_label(source_id)}."
            if source_id == "aseg-global":
                ids = [f"global:{name}" for name in ASEG_GLOBALS]
        entries.extend(
            {
                "measureId": measure_id,
                "source": measure_id.split(":", 1)[0],
                "family": measure_family(measure_id),
                "extensive": is_extensive(measure_id),
                "stage": "recon",
                "available": reason is None,
                "unavailableReason": reason,
            }
            for measure_id in ids
        )
    listed = {entry["measureId"] for entry in entries}
    entries.extend(label_catalog(context, subjects, listed))
    return entries


def combined_digest(
    reader: ReconReader, source_id: str, subject_ids: Iterable[str]
) -> dict[str, Any]:
    """Return one source's ``AnalysisInputFile`` row over the subjects' files.

    The digest is the SHA-256 of one line per subject and file (``subject
    relpath sha256``, or ``absent``), so a file that appears, changes, or
    disappears changes it.

    Parameters
    ----------
    reader
        The reader that read the values (its cache holds the bytes used).
    source_id
        One tier A source.
    subject_ids
        The subjects, in order.

    Returns
    -------
    dict
        ``{"source": "stats:<id>", "present", "reason", "sha256", "bytes"}``.
    """
    digest = hashlib.sha256()
    present = 0
    size = 0
    for subject_id in sorted(set(subject_ids)):
        paths = reader.relpaths(source_id, subject_id) or [file_label(source_id)]
        for relpath in paths:
            item = reader.read(subject_id, relpath)
            line = f"{subject_id}\t{relpath}\t{item.sha256 or 'absent'}\n"
            digest.update(line.encode("utf-8"))
            if item.sha256 is not None:
                present += 1
                size += item.size or 0
    return {
        "source": f"stats:{source_id}",
        "present": present > 0,
        "reason": None
        if present
        else f"No included subject's reconstruction has {file_label(source_id)}.",
        "sha256": digest.hexdigest(),
        "bytes": size,
    }


def source_digest(
    context: AnalysisContext, source_id: str, subject_ids: list[str]
) -> str:
    """Return the combined SHA-256 of one source's files for the subjects.

    Parameters
    ----------
    source_id
        One tier A source.
    subject_ids
        The included subjects, in order.

    Returns
    -------
    str
        The digest recorded as input source ``stats:<sourceId>``.
    """
    if source_id not in TIER_A_SOURCES:
        raise GroupAnalysisError("Choose a tier A source.")
    reader = ReconReader(context, cache=False)
    return str(combined_digest(reader, source_id, subject_ids)["sha256"])


# -- Imported variables -----------------------------------------------------------

_ID_HEADERS = ("subject_id", "participant_id", "subject", "id")
_MAX_TABLE_ROWS = 20_000
_MAX_TABLE_COLUMNS = 256
_MAX_CELL = 4_096
_MAX_NAME = 120
_MAX_COLUMN_NAME = 128
_MAX_TABLES_BYTES = 1024 * 1024
_SUBJECT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
_PRINTABLE = re.compile(r"[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?")
_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z")
_SHA256 = re.compile(r"[a-f0-9]{64}")


@dataclass(frozen=True)
class VariableTable:
    """One imported table as parsed: its ID column, columns, and rows."""

    table_id: str
    sha256: str
    size: int
    id_column: str
    columns: tuple[str, ...]
    rows: dict[str, dict[str, str]]


def _variables_dir(project_root: str) -> str:
    return os.path.join(project_root, VARIABLES_DIR)


def _tables_path(project_root: str) -> str:
    return os.path.join(_variables_dir(project_root), "tables.json")


def _table_path(project_root: str, table_id: str) -> str:
    return os.path.join(_variables_dir(project_root), f"{table_id}.csv")


def parse_variables(  # noqa: PLR0912
    payload: bytes, name: str
) -> tuple[str, tuple[str, ...], dict[str, dict[str, str]]]:
    """Parse a variables CSV into its ID column, columns, and rows.

    Parameters
    ----------
    payload
        The CSV bytes (UTF-8, optionally with a byte-order mark).
    name
        The file name, for the messages.

    Returns
    -------
    tuple
        The ID column, the other columns in order, and each subject's cells
        by column.

    Raises
    ------
    GroupAnalysisError
        With an actionable sentence when the table cannot be used.
    """
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise GroupAnalysisError(f"Save {name} as UTF-8 text.") from exc
    reader = csv.reader(io.StringIO(text, newline=""))
    try:
        header = [cell.strip() for cell in next(reader, [])]
    except csv.Error as exc:
        raise GroupAnalysisError(
            f"Choose a valid CSV table instead of {name}."
        ) from exc
    if not header or not any(header):
        raise GroupAnalysisError(f"Give {name} a header row.")
    if len(header) > _MAX_TABLE_COLUMNS + 1:
        raise GroupAnalysisError(
            f"Keep {name} to {_MAX_TABLE_COLUMNS} variable columns or fewer."
        )
    if len(set(header)) != len(header):
        raise GroupAnalysisError(f"Give each column of {name} a different name.")
    id_column = next(
        (column for column in header if column.lower() in _ID_HEADERS), None
    )
    if id_column is None:
        raise GroupAnalysisError(
            f"Name the subject ID column of {name} subject_id, participant_id, "
            "subject, or id."
        )
    bad = [
        c for c in header if len(c) > _MAX_COLUMN_NAME or not _PRINTABLE.fullmatch(c)
    ]
    if bad:
        raise GroupAnalysisError(
            f"Use printable ASCII column names of at most 128 characters in {name}."
        )
    key = header.index(id_column)
    rows: dict[str, dict[str, str]] = {}
    repeated: set[str] = set()
    try:
        for count, row in enumerate(reader, start=1):
            if count > _MAX_TABLE_ROWS:
                raise GroupAnalysisError(
                    f"Keep {name} to {_MAX_TABLE_ROWS} rows or fewer."
                )
            if not row or all(not cell.strip() for cell in row):
                continue
            cells = [cell.strip()[:_MAX_CELL] for cell in row]
            cells += [""] * (len(header) - len(cells))
            subject_id = cells[key]
            if not _SUBJECT_ID.fullmatch(subject_id):
                continue
            if subject_id in rows:
                repeated.add(subject_id)
                continue
            rows[subject_id] = dict(zip(header, cells, strict=False))
    except csv.Error as exc:
        raise GroupAnalysisError(
            f"Choose a valid CSV table instead of {name}."
        ) from exc
    if repeated:
        count = len(repeated)
        noun = "subject ID appears" if count == 1 else "subject IDs appear"
        raise GroupAnalysisError(
            f"List each subject once in {name}: {count} {noun} more than once."
        )
    if not rows:
        raise GroupAnalysisError(f"Add subject rows to {name}.")
    columns = tuple(column for column in header if column != id_column)
    return id_column, columns, rows


def _valid_entry(item: Any) -> bool:
    return bool(
        isinstance(item, dict)
        and isinstance(item.get("tableId"), str)
        and TABLE_ID.fullmatch(item["tableId"])
        and isinstance(item.get("name"), str)
        and 0 < len(item["name"]) <= _MAX_NAME
        and _PRINTABLE.fullmatch(item["name"])
        and isinstance(item.get("idColumn"), str)
        and isinstance(item.get("sha256"), str)
        and _SHA256.fullmatch(item["sha256"])
        and isinstance(item.get("importedAt"), str)
        and _TIMESTAMP.fullmatch(item["importedAt"])
    )


def _load_listing(project_root: str) -> list[dict[str, Any]]:
    data = store._read_json(_tables_path(project_root), _MAX_TABLES_BYTES)
    if not isinstance(data, dict) or data.get("schema") != TABLES_SCHEMA:
        return []
    tables = data.get("tables")
    if not isinstance(tables, list):
        return []
    keys = ("tableId", "name", "idColumn", "sha256", "importedAt")
    return [
        {key: item[key] for key in keys}
        for item in tables[:MAX_VARIABLE_TABLES]
        if _valid_entry(item)
    ]


def _write_listing(project_root: str, tables: list[dict[str, Any]]) -> None:
    store._ensure_dir(store.analysis_dir(project_root))
    store._ensure_dir(_variables_dir(project_root))
    payload = store.canonical_json(
        {"schema": TABLES_SCHEMA, "schemaVersion": 1, "tables": tables}
    )
    store._write_atomic(_tables_path(project_root), payload.encode("utf-8"))


def read_variable_table(project_root: str, table_id: str) -> VariableTable:
    """Read one imported table and check it against its listed digest.

    Parameters
    ----------
    table_id
        The ``var-<hex16>`` table ID.

    Raises
    ------
    GroupAnalysisError
        When the table is not listed, is missing, or changed on disk.
    """
    entry = next(
        (item for item in _load_listing(project_root) if item["tableId"] == table_id),
        None,
    )
    if entry is None:
        raise GroupAnalysisError(
            "Import the variables table again; this project no longer lists it."
        )
    try:
        payload = read_bounded_regular(
            _table_path(project_root, table_id), MAX_VARIABLES_BYTES
        )
    except (BoundedReadError, OSError) as exc:
        raise GroupAnalysisError(
            f"Import {entry['name']} again; its copy in the project cannot be read."
        ) from exc
    digest = hashlib.sha256(payload).hexdigest()
    if digest != entry["sha256"]:
        raise GroupAnalysisError(
            f"Import {entry['name']} again; its copy in the project changed."
        )
    id_column, columns, rows = parse_variables(payload, entry["name"])
    return VariableTable(table_id, digest, len(payload), id_column, columns, rows)


def table_input(project_root: str, table_id: str) -> dict[str, Any]:
    """Return the ``AnalysisInputFile`` row of one imported table."""
    path = _table_path(project_root, table_id)
    source = f"variables:{table_id}"
    try:
        payload = read_bounded_regular(path, MAX_VARIABLES_BYTES)
    except FileNotFoundError:
        return {
            "source": source,
            "present": False,
            "reason": "The imported variables table is not in the project.",
            "sha256": None,
            "bytes": None,
        }
    except (BoundedReadError, OSError):
        return {
            "source": source,
            "present": True,
            "reason": "The imported variables table cannot be read.",
            "sha256": None,
            "bytes": None,
        }
    return {
        "source": source,
        "present": True,
        "reason": None,
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload),
    }


def _columns(table: VariableTable, known: set[str] | None) -> list[dict[str, Any]]:
    subjects = [sid for sid in table.rows if known is None or sid in known]
    columns: list[dict[str, Any]] = []
    for column in table.columns:
        values = [table.rows[sid].get(column, "") for sid in subjects]
        entry = _variable_entry({"source": "imported", "column": column}, values, None)
        if entry is None:
            present = [v for v in values if v not in _MISSING_TOKENS]
            entry = {
                "kind": "numeric" if numeric_column(present) else "categorical",
                "n": sum(1 for v in present if _is_number(v))
                if numeric_column(present)
                else len(present),
                "levels": [],
            }
        columns.append(
            {
                "column": column,
                "kind": entry["kind"],
                "n": entry["n"],
                "levels": entry["levels"],
            }
        )
    return columns


def _public(
    entry: dict[str, Any], table: VariableTable, known: set[str] | None
) -> dict[str, Any]:
    return {
        **entry,
        "rows": len(table.rows),
        "unmatched": 0
        if known is None
        else sum(1 for sid in table.rows if sid not in known),
        "columns": _columns(table, known),
    }


def list_variable_tables(
    project_root: str, known: set[str] | None = None
) -> list[dict[str, Any]]:
    """Return the imported tables as ``AnalysisVariableTable`` rows.

    Parameters
    ----------
    known
        The project's subject IDs; ``unmatched`` counts the table rows
        outside them, and column counts cover only them. None counts every
        row and reports no unmatched rows.

    Returns
    -------
    list of dict
        One row per readable table, in import order.
    """
    rows: list[dict[str, Any]] = []
    for entry in _load_listing(project_root):
        try:
            table = read_variable_table(project_root, entry["tableId"])
        except GroupAnalysisError:
            continue
        rows.append(_public(entry, table, known))
    return rows


def import_variables(context: AnalysisContext, path: str) -> dict[str, Any]:
    """Copy one variables CSV into the project and list it.

    The ID column is the first column whose header is ``subject_id``,
    ``participant_id``, ``subject``, or ``id`` (case-insensitive).

    Parameters
    ----------
    context
        The project snapshot (for the known subject IDs).
    path
        The absolute path main's dialog returned.

    Returns
    -------
    dict
        The ``AnalysisVariableTable`` of the new table.

    Raises
    ------
    GroupAnalysisError
        When the file cannot be imported.
    """
    name = os.path.basename(path)[:_MAX_NAME].strip() or "variables.csv"
    if not _PRINTABLE.fullmatch(name):
        name = "variables.csv"
    try:
        payload = read_bounded_regular(path, MAX_VARIABLES_BYTES)
    except FileNotFoundError as exc:
        raise GroupAnalysisError("Choose a variables CSV that exists.") from exc
    except (BoundedReadError, OSError) as exc:
        raise GroupAnalysisError(
            "Choose a regular CSV file of at most 4 MiB (not a link)."
        ) from exc
    id_column, columns, rows = parse_variables(payload, name)
    digest = hashlib.sha256(payload).hexdigest()
    table_id = f"var-{digest[:16]}"
    table = VariableTable(table_id, digest, len(payload), id_column, columns, rows)
    root = context.project_root
    known = project_subjects(context)
    with store._lock(root):
        listing = _load_listing(root)
        existing = next((i for i in listing if i["tableId"] == table_id), None)
        if existing is not None and _signature(_table_path(root, table_id)):
            return _public(existing, table, known)
        listing = [item for item in listing if item["tableId"] != table_id]
        if len(listing) >= MAX_VARIABLE_TABLES:
            raise GroupAnalysisError(
                f"Remove an imported table first; a project keeps at most "
                f"{MAX_VARIABLE_TABLES}."
            )
        store._ensure_dir(store.analysis_dir(root))
        store._ensure_dir(_variables_dir(root))
        store._write_atomic(_table_path(root, table_id), payload)
        entry = {
            "tableId": table_id,
            "name": name,
            "idColumn": id_column,
            "sha256": digest,
            "importedAt": store.timestamp(),
        }
        _write_listing(root, [*listing, entry])
    return _public(entry, table, known)


def delete_variables(project_root: str, table_id: str) -> None:
    """Remove one imported table and its listing.

    Parameters
    ----------
    table_id
        The ``var-<hex16>`` table ID.

    Raises
    ------
    GroupAnalysisError
        When the table ID is invalid or unknown.
    """
    if not isinstance(table_id, str) or not TABLE_ID.fullmatch(table_id):
        raise GroupAnalysisError("Send a valid variables table ID.")
    with store._lock(project_root):
        listing = _load_listing(project_root)
        if not any(item["tableId"] == table_id for item in listing):
            raise GroupAnalysisError("Select an imported variables table.")
        _write_listing(
            project_root, [item for item in listing if item["tableId"] != table_id]
        )
        path = _table_path(project_root, table_id)
        if _signature(path) is not None:
            try:
                os.unlink(path)
            except OSError as exc:
                raise GroupAnalysisError(
                    "The variables table could not be removed."
                ) from exc
