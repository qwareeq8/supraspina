"""Sample resolution and the analysis dataset.

Membership is the configuration scope minus configuration exclusions minus
the QC rule; registration flags come from the surface-registration rows and
ENIGMA outlier flags from ``qc_review/qa_outliers/outliers.csv``. Every table
is read with the ``bounded_io`` limits and hashed, so a result can tell when
its inputs changed.

The candidate subjects are the registry records and every subject a measure
table lists. Each candidate is judged in one fixed order, and the first rule
that fails names the exclusion reason: configuration scope, QC, group,
covariates, registration flag, outlier flag, and finally whether any selected
measure has a value.

The included subjects' registry sites then go through the site check of
the spec v2 design check (``design_check.check_sites_v1``): a block stops
the compute and a warning joins the sample's issues. Without any site, the
check is None and nothing else changes.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import re
import stat
import threading
from collections import OrderedDict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from ..bounded_io import BoundedReadError, read_bounded_regular
from ..cohort import config_subject_scope, effective_qc_verdict
from ..paths import flatten, interpolate
from .spec import (
    AssociationContrast,
    GroupAnalysisError,
    GroupAnalysisSpec,
    GroupContrast,
    VariableRef,
    is_extensive,
    parse_measure_id,
    spec_digest,
)

#: The input tables, in the order every payload lists them.
INPUT_SOURCES: tuple[str, ...] = (
    "dk-all-stats",
    "cortical-thickness",
    "icv",
    "brainage",
    "metadata-csv",
    "age-csv",
    "clinical-csv",
    "outliers",
)
_FILE_NAMES = {
    "dk-all-stats": "dk_all_stats.csv",
    "cortical-thickness": "cortical_thickness.csv",
    "icv": "icv_data.csv",
    "brainage": "predicted_results.csv",
    "metadata-csv": "metadata.csv",
    "age-csv": "the age CSV",
    "clinical-csv": "the clinical CSV",
    "outliers": "outliers.csv",
}
_MISSING_FILE = {
    "dk-all-stats": "The aggregation stage has not written dk_all_stats.csv.",
    "cortical-thickness": (
        "The aggregation stage has not written cortical_thickness.csv."
    ),
    "icv": "The aggregation stage has not written icv_data.csv.",
    "brainage": "The Brain-PAD stage has not written predicted_results.csv.",
    "metadata-csv": "The metadata folder has no metadata.csv.",
    "age-csv": "The age CSV does not exist.",
    "clinical-csv": "The clinical CSV does not exist.",
    "outliers": "The outlier review has not written outliers.csv.",
}
_UNSET_PATH = {
    "metadata-csv": "The metadata folder is not set in the project settings.",
    "age-csv": "The age CSV is not set in the project settings.",
    "clinical-csv": "The clinical CSV is not set in the project settings.",
}

MAX_TABLE_BYTES = 64 * 1024 * 1024
MAX_TABLE_ROWS = 20_000
MAX_TABLE_COLUMNS = 4_096
_MAX_CELL_CHARACTERS = 4_096
_MAX_VARIABLES = 512
_MAX_LEVELS = 256
_MAX_LABEL = 128
_MAX_REASON = 512
_MIN_GROUP_VALUES = 2
_MIN_ASSOCIATION_VALUES = 3
_SUBJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_PRINTABLE = re.compile(r"^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$")
_MISSING_TOKENS = frozenset({"", "NA", "N/A", "n/a", "na", "NaN", "nan", "."})
_REGISTRY_NUMERIC = frozenset({"age", "tSinceSci"})
_FEMALE = frozenset({"f", "female"})
#: The registry field that names a subject's site (scanner and protocol).
SITE_FIELD = "site"
_REGISTRY_FIELDS = (
    "age",
    "sex",
    "cohortRole",
    "sourceCohortLabel",
    "ais",
    "tSinceSci",
    SITE_FIELD,
)

#: The DK regions in ``aparc.stats`` order, for a catalog without the table.
DK_REGIONS: tuple[str, ...] = (
    "bankssts",
    "caudalanteriorcingulate",
    "caudalmiddlefrontal",
    "cuneus",
    "entorhinal",
    "fusiform",
    "inferiorparietal",
    "inferiortemporal",
    "isthmuscingulate",
    "lateraloccipital",
    "lateralorbitofrontal",
    "lingual",
    "medialorbitofrontal",
    "middletemporal",
    "parahippocampal",
    "paracentral",
    "parsopercularis",
    "parsorbitalis",
    "parstriangularis",
    "pericalcarine",
    "postcentral",
    "posteriorcingulate",
    "precentral",
    "precuneus",
    "rostralanteriorcingulate",
    "rostralmiddlefrontal",
    "superiorfrontal",
    "superiorparietal",
    "superiortemporal",
    "supramarginal",
    "frontalpole",
    "temporalpole",
    "transversetemporal",
    "insula",
)
#: The FreeSurfer 8 ``aseg.stats`` structures ``dk_all_stats.csv`` carries.
ASEG_STRUCTURES: tuple[str, ...] = (
    "Left-Lateral-Ventricle",
    "Left-Inf-Lat-Vent",
    "Left-Cerebellum-White-Matter",
    "Left-Cerebellum-Cortex",
    "Left-Thalamus",
    "Left-Caudate",
    "Left-Putamen",
    "Left-Pallidum",
    "3rd-Ventricle",
    "4th-Ventricle",
    "Brain-Stem",
    "Left-Hippocampus",
    "Left-Amygdala",
    "CSF",
    "Left-Accumbens-area",
    "Left-VentralDC",
    "Left-vessel",
    "Left-choroid-plexus",
    "Right-Lateral-Ventricle",
    "Right-Inf-Lat-Vent",
    "Right-Cerebellum-White-Matter",
    "Right-Cerebellum-Cortex",
    "Right-Thalamus",
    "Right-Caudate",
    "Right-Putamen",
    "Right-Pallidum",
    "Right-Hippocampus",
    "Right-Amygdala",
    "Right-Accumbens-area",
    "Right-VentralDC",
    "Right-vessel",
    "Right-choroid-plexus",
    "5th-Ventricle",
    "WM-hypointensities",
    "Left-WM-hypointensities",
    "Right-WM-hypointensities",
    "non-WM-hypointensities",
    "Left-non-WM-hypointensities",
    "Right-non-WM-hypointensities",
    "Optic-Chiasm",
    "CC_Posterior",
    "CC_Mid_Posterior",
    "CC_Central",
    "CC_Mid_Anterior",
    "CC_Anterior",
)
# ENIGMA subcortical codes (outliers.csv ``structure``) to aseg names; FreeSurfer
# 6 spells the thalamus ``Thalamus-Proper``.
_ENIGMA_SUBCORTICAL: dict[str, tuple[str, ...]] = {
    "LatVent": ("Lateral-Ventricle",),
    "thal": ("Thalamus", "Thalamus-Proper"),
    "caud": ("Caudate",),
    "put": ("Putamen",),
    "pal": ("Pallidum",),
    "hippo": ("Hippocampus",),
    "amyg": ("Amygdala",),
    "accumb": ("Accumbens-area",),
}
_ENIGMA_CORTICAL = re.compile(r"^([LR])_([a-z]{2,40})_(thickavg|surfavg)$")
_OUTLIERS_MISSING = (
    "The ENIGMA outlier table is missing, so the outlier rule was not applied."
)
_OUTLIERS_UNREADABLE = (
    "The ENIGMA outlier table cannot be read, so the outlier rule was not applied."
)


@dataclass(frozen=True)
class AnalysisContext:
    """Hold the project state one catalog, sample, or compute reads.

    The manager snapshots the registry, QC records, and registration rows on
    its own thread, so a compute never reads them again while it runs.
    ``registration`` holds the ``subjects`` rows of
    ``surfaceRegistration.status``; ``registration_known`` is False when that
    status could not be read, so every hemisphere counts as unjudged.
    """

    project_root: str
    cfg: Mapping[str, Any]
    config_revision: int
    registry: tuple[Mapping[str, Any], ...] = ()
    qc: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    registration: tuple[Mapping[str, Any], ...] = ()
    registration_known: bool = True


@dataclass
class Dataset:
    """Hold one specification's resolved sample and aligned values.

    Every list is aligned with ``subject_ids``, the included subjects in a
    stable order. A value of None is a missing cell.

    ``covariates`` holds numeric, uncentered columns in model order: ``age``,
    then ``sex`` (female = 1, or the numeric
    column; any other level adds ``sex:<level>``), then each extra covariate
    as ``<source>:<column>`` (or one indicator per level after the first),
    then ``eTIV`` when a selected measure takes it. ``eTIV`` enters a measure's
    model only when :func:`takes_etiv` says so; every other column enters
    every model. No covariate cell of an included subject is None except
    ``eTIV``, and a measure that takes eTIV already has a missing cell
    wherever eTIV is missing, so each measure's non-missing cells form its
    availability block (:func:`availability_blocks`).
    """

    subject_ids: list[str]
    groups: list[str | None]
    source_labels: list[str | None]
    covariates: dict[str, list[float | None]]
    #: The tested variable of an association, else None.
    tested: list[float | None] | None
    measures: dict[str, list[float | None]]
    #: ``AnalysisSubjectInclusion`` rows for every candidate subject.
    subjects: list[dict[str, Any]]
    #: ``AnalysisSkippedMeasure`` rows.
    skipped: list[dict[str, Any]]
    #: ``AnalysisInputFile`` rows with the SHA-256 of every table read.
    inputs: list[dict[str, Any]]
    #: True when an included subject has an unjudged registration check.
    registration_provisional: bool = False
    #: Fact sentences about the sample that no subject row carries.
    issues: list[str] = field(default_factory=list)
    #: True when an outlier rule was chosen but ``outliers.csv`` is unusable.
    outliers_unapplied: bool = False
    #: ``(subjects, parameters)`` of each measure skipped for too few subjects.
    too_small: dict[str, tuple[int, int]] = field(default_factory=dict)


@dataclass(frozen=True)
class AvailabilityBlock:
    """Name the measures that share one set of subjects with a value."""

    #: Indices into ``Dataset.subject_ids``.
    rows: tuple[int, ...]
    measures: tuple[str, ...]


def takes_etiv(measure_id: str, rule: str) -> bool:
    """Say whether a measure's model adds eTIV under the covariate rule.

    Parameters
    ----------
    measure_id
        A valid measure ID.
    rule
        ``extensive``, ``all``, or ``none`` (``spec.covariates.etiv``).

    Returns
    -------
    bool
        True when eTIV is a covariate of this measure; eTIV itself never is.
    """
    if rule == "none" or measure_id == "global:eTIV":
        return False
    return rule == "all" or is_extensive(measure_id)


def availability_blocks(dataset: Dataset) -> list[AvailabilityBlock]:
    """Group the measures by the subjects that have a value.

    Returns
    -------
    list of AvailabilityBlock
        One block per distinct pattern, in the order the patterns first occur.
    """
    blocks: dict[tuple[int, ...], list[str]] = {}
    for measure_id, values in dataset.measures.items():
        rows = tuple(index for index, value in enumerate(values) if value is not None)
        blocks.setdefault(rows, []).append(measure_id)
    return [
        AvailabilityBlock(rows=rows, measures=tuple(ids))
        for rows, ids in blocks.items()
    ]


# -- Tables -------------------------------------------------------------------


@dataclass(frozen=True)
class Table:
    """Hold one input table as read: its state, digest, and parsed cells."""

    source: str
    path: str | None
    present: bool
    reason: str | None
    sha256: str | None
    size: int | None
    header: tuple[str, ...] = ()
    #: Wide tables: subject ID to the cells by column. Long tables: empty.
    rows: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    #: Long tables (outliers): every row by column.
    records: tuple[Mapping[str, str], ...] = ()

    @property
    def usable(self) -> bool:
        """Say whether the table was read and parsed."""
        return self.present and self.reason is None

    def public(self) -> dict[str, Any]:
        """Return the ``AnalysisInputFile`` row."""
        return {
            "source": self.source,
            "present": self.present,
            "reason": self.reason,
            "sha256": self.sha256,
            "bytes": self.size,
        }


_CACHE_LIMIT = 32
_CACHE: OrderedDict[tuple[Any, ...], Table] = OrderedDict()
_CACHE_LOCK = threading.Lock()


def _resolve_path(template: str, cfg: Mapping[str, Any], root: str) -> str | None:
    if not template:
        return None
    value = interpolate(template, flatten(dict(cfg))).strip()
    if not value or "${" in value:
        return None
    return value if os.path.isabs(value) else os.path.join(root, value)


def _params(cfg: Mapping[str, Any], step: str) -> Mapping[str, Any]:
    steps = cfg.get("steps")
    entry = steps.get(step) if isinstance(steps, Mapping) else None
    params = entry.get("params") if isinstance(entry, Mapping) else None
    return params if isinstance(params, Mapping) else {}


def _paths(cfg: Mapping[str, Any]) -> Mapping[str, Any]:
    paths = cfg.get("paths")
    return paths if isinstance(paths, Mapping) else {}


def input_path(context: AnalysisContext, source: str) -> str | None:
    """Return the path of one input table, or None when it is not configured.

    The aggregation folder honors ``steps.aggregate.params.outDir``; the
    metadata CSVs come from ``paths``; the outlier review writes under
    ``paths.qcOutputDir``.
    """
    cfg = context.cfg
    root = context.project_root
    if source in {"dk-all-stats", "cortical-thickness", "icv"}:
        template = str(
            _params(cfg, "aggregate").get("outDir") or "${paths.outputDir}/structural"
        )
        folder = _resolve_path(template, cfg, root)
        return None if folder is None else os.path.join(folder, _FILE_NAMES[source])
    if source == "brainage":
        return _resolve_path(
            "${paths.outputDir}/pybrainage/predicted_results.csv", cfg, root
        )
    if source == "outliers":
        return _resolve_path("${paths.qcOutputDir}/qa_outliers/outliers.csv", cfg, root)
    paths = _paths(cfg)
    if source == "metadata-csv":
        folder = _resolve_path(str(paths.get("metadataDir") or ""), cfg, root)
        return None if folder is None else os.path.join(folder, "metadata.csv")
    key = "ageMetadataFile" if source == "age-csv" else "clinicalMetadataFile"
    return _resolve_path(str(paths.get(key) or ""), cfg, root)


def id_column(cfg: Mapping[str, Any], source: str) -> str:
    """Return the subject ID column of one input table."""
    if source in {"dk-all-stats", "cortical-thickness", "icv"}:
        return "subject"
    if source == "brainage":
        return "ID"
    if source == "outliers":
        return "SubjID"
    if source == "age-csv":
        return str(_params(cfg, "age").get("subjectIdColumn") or "participant_id")
    if source == "clinical-csv":
        return str(_params(cfg, "clinical").get("joinKey") or "participant_id")
    return "participant_id"


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


def table_signature(context: AnalysisContext, source: str) -> tuple[Any, ...] | None:
    """Return one input table's path and file identity, or None when absent.

    The identity (device, inode, size, and times) changes whenever the file
    does, so equal signatures mean an unchanged table without reading it.
    """
    path = input_path(context, source)
    return None if path is None else _signature(path)


def _parse(source: str, payload: bytes, key: str) -> tuple[Any, ...]:  # noqa: PLR0912
    """Parse CSV bytes into a header and wide rows or long records.

    Raises
    ------
    ValueError
        With a fact sentence when the table cannot serve the analysis.
    """
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("The file is not UTF-8 text.") from exc
    reader = csv.reader(io.StringIO(text, newline=""))
    try:
        header = next(reader, None)
    except csv.Error as exc:
        raise ValueError("The file is not a valid CSV table.") from exc
    if not header:
        raise ValueError("The file has no header row.")
    header = [cell.strip() for cell in header]
    if len(header) > MAX_TABLE_COLUMNS:
        raise ValueError("The table has more columns than the analysis reads.")
    if len(set(header)) != len(header):
        raise ValueError("The table repeats a column name.")
    if key not in header:
        raise ValueError(f"The table has no {key} column.")
    key_index = header.index(key)
    wide: dict[str, dict[str, str]] = {}
    long: list[dict[str, str]] = []
    repeated: set[str] = set()
    try:
        for count, row in enumerate(reader, start=1):
            if count > MAX_TABLE_ROWS:
                raise ValueError("The table has more rows than the analysis reads.")
            if not row or all(not cell.strip() for cell in row):
                continue
            cells = [cell.strip()[:_MAX_CELL_CHARACTERS] for cell in row]
            cells += [""] * (len(header) - len(cells))
            record = dict(zip(header, cells, strict=False))
            subject_id = cells[key_index]
            if not _SUBJECT_ID.fullmatch(subject_id):
                continue
            if source == "outliers":
                long.append(record)
            elif subject_id in wide:
                repeated.add(subject_id)
            else:
                wide[subject_id] = record
    except csv.Error as exc:
        raise ValueError("The file is not a valid CSV table.") from exc
    if repeated:
        # A reason reaches spec.json and exports, so it counts the IDs and
        # never names one; the sample disclosure lists subjects privately.
        count = len(repeated)
        noun = "participant ID appears" if count == 1 else "participant IDs appear"
        raise ValueError(f"{count} {noun} more than once in {_FILE_NAMES[source]}.")
    return tuple(header), wide, tuple(long)


def read_table(context: AnalysisContext, source: str, *, cache: bool = True) -> Table:
    """Read, hash, and parse one input table within the bounded limits.

    Parameters
    ----------
    source
        One of :data:`INPUT_SOURCES`.
    cache
        Reuse a parse of the same unchanged file (same inode, size, and
        times). The compute worker reads without the cache, so a result's
        digests always describe the bytes it used.

    Returns
    -------
    Table
        The table, or its absence or unreadability as a fact sentence.
    """
    path = input_path(context, source)
    if path is None:
        reason = _UNSET_PATH.get(source, "The output folder is not set.")
        return Table(source, None, False, reason, None, None)
    signature = _signature(path) if cache else None
    if signature is not None:
        with _CACHE_LOCK:
            hit = _CACHE.get(signature)
            if hit is not None:
                _CACHE.move_to_end(signature)
                return hit
    try:
        payload = read_bounded_regular(path, MAX_TABLE_BYTES)
    except FileNotFoundError:
        return Table(source, path, False, _MISSING_FILE[source], None, None)
    except BoundedReadError:
        return Table(
            source,
            path,
            True,
            "The file is not a regular file within 64 MiB, or it changed while "
            "it was read.",
            None,
            None,
        )
    except OSError:
        return Table(source, path, True, "The file cannot be read.", None, None)
    digest = hashlib.sha256(payload).hexdigest()
    try:
        header, wide, long = _parse(source, payload, id_column(context.cfg, source))
    except ValueError as exc:
        table = Table(source, path, True, str(exc)[:_MAX_REASON], digest, len(payload))
    else:
        table = Table(
            source, path, True, None, digest, len(payload), header, wide, long
        )
    if signature is not None and _signature(path) == signature:
        with _CACHE_LOCK:
            _CACHE[signature] = table
            while len(_CACHE) > _CACHE_LIMIT:
                _CACHE.popitem(last=False)
    return table


class Tables:
    """Read each input table at most once for one request."""

    def __init__(self, context: AnalysisContext, *, cache: bool = True) -> None:
        """Bind the reader to one project snapshot."""
        self._context = context
        self._cache = cache
        self._tables: dict[str, Table] = {}

    def get(self, source: str) -> Table:
        """Return one table, reading it on first use."""
        table = self._tables.get(source)
        if table is None:
            table = read_table(self._context, source, cache=self._cache)
            self._tables[source] = table
        return table

    def all(self) -> list[Table]:
        """Return every input table in :data:`INPUT_SOURCES` order."""
        return [self.get(source) for source in INPUT_SOURCES]


def input_files(context: AnalysisContext) -> list[dict[str, Any]]:
    """Describe every input table: presence, reason, size, and digest.

    Returns
    -------
    list of dict
        ``AnalysisInputFile`` rows.
    """
    return [table.public() for table in Tables(context).all()]


# -- Values -------------------------------------------------------------------


def _number(text: str | None) -> float | None:
    if text is None or text in _MISSING_TOKENS:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _is_number(text: str) -> bool:
    try:
        return math.isfinite(float(text))
    except ValueError:
        return False


def numeric_column(values: Iterable[str]) -> bool:
    """Say whether a column's present cells make it a numeric variable.

    A column is numeric when most of its present cells (more than half) are
    finite numbers, so one stray cell such as ``unknown`` in an age column
    leaves that subject missing instead of turning the column into a
    grouping variable.
    """
    present = [value for value in values if value not in _MISSING_TOKENS]
    numbers = sum(1 for value in present if _is_number(value))
    return numbers > 0 and numbers * 2 > len(present)


def _mean(left: float | None, right: float | None) -> float | None:
    if left is None or right is None:
        return None
    return (left + right) / 2


def measure_source(measure_id: str) -> str:
    """Return the input table a measure's values come from."""
    parts = parse_measure_id(measure_id)
    if parts is None:
        raise GroupAnalysisError("Use valid measure IDs.")
    if parts.source in {"dk", "aseg"}:
        return "dk-all-stats"
    if parts.source == "brainage":
        return "brainage"
    return "icv" if parts.name == "eTIV" else "cortical-thickness"


def measure_columns(measure_id: str) -> tuple[str, ...]:
    """Return the table columns one measure reads (two for a bilateral mean)."""
    parts = parse_measure_id(measure_id)
    if parts is None:
        raise GroupAnalysisError("Use valid measure IDs.")
    if parts.source == "dk":
        hemispheres = ("lh", "rh") if parts.hemisphere == "bi" else (parts.hemisphere,)
        return tuple(f"{hemi}_{parts.region}_{parts.metric}" for hemi in hemispheres)
    if parts.source == "aseg":
        if parts.hemisphere == "bi":
            return (f"Left-{parts.structure}", f"Right-{parts.structure}")
        return (str(parts.structure),)
    if parts.source == "brainage":
        return ("BrainPAD",)
    if parts.name == "eTIV":
        return ("eTIV",)
    return ("lh_mean_thickness", "rh_mean_thickness")


def measure_value(table: Table, measure_id: str, subject_id: str) -> float | None:
    """Return one subject's value of one measure from its table."""
    row = table.rows.get(subject_id)
    if row is None:
        return None
    values = [_number(row.get(column)) for column in measure_columns(measure_id)]
    if len(values) == 1:
        return values[0]
    return _mean(values[0], values[1])


def is_cortical(measure_id: str) -> bool:
    """Say whether a surface-registration flag bears on a measure."""
    parts = parse_measure_id(measure_id)
    return parts is not None and (
        parts.source == "dk"
        or (parts.source == "global" and parts.name == "meanThickness")
    )


def _cortical_hemispheres(measure_id: str) -> tuple[str, ...]:
    parts = parse_measure_id(measure_id)
    if parts is None or not is_cortical(measure_id):
        return ()
    if parts.source == "dk" and parts.hemisphere in {"lh", "rh"}:
        return (str(parts.hemisphere),)
    return ("lh", "rh")


def outlier_measures(structure: str) -> tuple[str, ...]:
    """Map one ENIGMA ``outliers.csv`` structure to the measure IDs it flags.

    Parameters
    ----------
    structure
        The ``structure`` cell, for example ``L_precentral_thickavg`` or
        ``Lthal``.

    Returns
    -------
    tuple of str
        The hemisphere measure and the bilateral mean it enters; empty for a
        structure no measure carries (total surface area).
    """
    if match := _ENIGMA_CORTICAL.fullmatch(structure):
        hemi = "lh" if match.group(1) == "L" else "rh"
        metric = "ThickAvg" if match.group(3) == "thickavg" else "SurfArea"
        region = match.group(2)
        return (f"dk:{hemi}:{region}:{metric}", f"dk:bi:{region}:{metric}")
    if structure in {"LThickness", "RThickness"}:
        return ("global:meanThickness",)
    if structure == "ICV":
        return ("global:eTIV",)
    if structure[:1] in {"L", "R"} and structure[1:] in _ENIGMA_SUBCORTICAL:
        side = "Left" if structure[0] == "L" else "Right"
        names = _ENIGMA_SUBCORTICAL[structure[1:]]
        return tuple(
            measure
            for name in names
            for measure in (f"aseg:{side}-{name}", f"aseg:bi:{name}")
        )
    return ()


def outlier_flags(table: Table) -> dict[str, set[str]]:
    """Return each subject's flagged measure IDs from ``outliers.csv``."""
    flags: dict[str, set[str]] = {}
    for record in table.records:
        measures = outlier_measures(record.get("structure", ""))
        if measures:
            flags.setdefault(record["SubjID"], set()).update(measures)
    return flags


def registration_flags(
    context: AnalysisContext,
) -> tuple[dict[str, set[str]], set[str]]:
    """Return the flagged and the unjudged hemispheres by subject.

    A hemisphere is unjudged while its check is pending or failed.
    """
    flagged: dict[str, set[str]] = {}
    unjudged: set[str] = set()
    for subject in context.registration:
        subject_id = subject.get("subjectId")
        hemispheres = subject.get("hemispheres")
        if not isinstance(subject_id, str) or not isinstance(hemispheres, list):
            continue
        for row in hemispheres:
            if not isinstance(row, Mapping):
                continue
            hemi = row.get("hemisphere")
            if hemi not in {"lh", "rh"}:
                continue
            if row.get("flagged") is True:
                flagged.setdefault(subject_id, set()).add(str(hemi))
            if row.get("state") in {"pending", "failed"}:
                unjudged.add(subject_id)
    return flagged, unjudged


# -- Variables ----------------------------------------------------------------


def _registry_by_subject(context: AnalysisContext) -> dict[str, Mapping[str, Any]]:
    return {
        str(record["subjectId"]): record
        for record in context.registry
        if isinstance(record.get("subjectId"), str)
    }


def _registry_text(value: Any) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return repr(float(value)) if math.isfinite(value) else None
    text = str(value).strip()
    return text or None


def site_of(record: Mapping[str, Any] | None) -> str | None:
    """Return a registry record's site, or None when it is unset.

    The field is optional (``RegistryRecord.site``): an absent key, null, or
    empty text is unset.
    """
    if record is None:
        return None
    text = _registry_text(record.get(SITE_FIELD))
    return text if text is not None and text not in _MISSING_TOKENS else None


def variable_values(
    ref: VariableRef, context: AnalysisContext, tables: Tables
) -> dict[str, str]:
    """Return one variable's present values as text, by subject ID.

    Raises
    ------
    GroupAnalysisError
        When the variable's CSV or column cannot be read.
    """
    if ref.source == "registry":
        values: dict[str, str] = {}
        for subject_id, record in _registry_by_subject(context).items():
            text = _registry_text(record.get(ref.column))
            if text is not None:
                values[subject_id] = text
        return values
    table = tables.get(ref.source)
    label = _FILE_NAMES[ref.source]
    if not table.usable:
        raise GroupAnalysisError(
            f"Make {label} readable to use {ref.column}: {table.reason}"
        )
    if ref.column not in table.header:
        raise GroupAnalysisError(f"Choose a column that {label} has: {ref.column}.")
    return {
        subject_id: row[ref.column]
        for subject_id, row in table.rows.items()
        if row.get(ref.column, "") not in _MISSING_TOKENS
    }


def _variable_entry(
    ref: dict[str, str], values: Iterable[str], numeric_hint: bool | None
) -> dict[str, Any] | None:
    present = [value for value in values if value not in _MISSING_TOKENS]
    numeric = numeric_hint if numeric_hint is not None else numeric_column(present)
    if numeric:
        # A non-numeric cell of a numeric column reads as missing.
        n = sum(1 for value in present if _is_number(value))
        return {"ref": ref, "kind": "numeric", "n": n, "levels": []}
    counts: dict[str, int] = {}
    for value in present:
        if len(value) <= _MAX_LABEL and _PRINTABLE.fullmatch(value):
            counts[value] = counts.get(value, 0) + 1
    if not counts or len(counts) > _MAX_LEVELS:
        return None
    return {
        "ref": ref,
        "kind": "categorical",
        "n": len(present),
        "levels": [{"value": value, "n": counts[value]} for value in sorted(counts)],
    }


def catalog_variables(context: AnalysisContext, tables: Tables) -> list[dict[str, Any]]:
    """List every grouping and covariate variable with its observed levels."""
    variables: list[dict[str, Any]] = []
    registry = _registry_by_subject(context)
    for column in _REGISTRY_FIELDS:
        values = [
            text
            for record in registry.values()
            if (text := _registry_text(record.get(column))) is not None
        ]
        entry = _variable_entry(
            {"source": "registry", "column": column},
            values,
            True if column in _REGISTRY_NUMERIC else False,
        )
        if entry is not None:
            variables.append(entry)
    for source in ("age-csv", "clinical-csv", "metadata-csv"):
        table = tables.get(source)
        if not table.usable:
            continue
        key = id_column(context.cfg, source)
        for column in table.header:
            if (
                column == key
                or len(column) > _MAX_LABEL
                or not _PRINTABLE.fullmatch(column)
            ):
                continue
            entry = _variable_entry(
                {"source": source, "column": column},
                (row.get(column, "") for row in table.rows.values()),
                None,
            )
            if entry is not None:
                variables.append(entry)
    return variables[:_MAX_VARIABLES]


# -- Resolution -----------------------------------------------------------------


@dataclass
class _Candidate:
    subject_id: str
    group: str | None = None
    source_label: str | None = None
    reason: str | None = None
    missing_hemispheres: tuple[str, ...] = ()

    def public(self) -> dict[str, Any]:
        return {
            "subjectId": self.subject_id,
            "group": self.group,
            "sourceLabel": self.source_label,
            "included": self.reason is None,
            "reason": self.reason,
            "missingHemispheres": list(self.missing_hemispheres),
        }


@dataclass
class _Resolution:
    candidates: list[_Candidate]
    covariates: dict[str, dict[str, float]]
    tested: dict[str, float] | None
    measures: dict[str, dict[str, float | None]]
    skipped: list[dict[str, Any]]
    registration_provisional: bool
    tables: Tables
    issues: list[str]
    outliers_unapplied: bool
    too_small: dict[str, tuple[int, int]]

    def included(self) -> list[_Candidate]:
        return [item for item in self.candidates if item.reason is None]


def _grouping(spec: GroupAnalysisSpec) -> Any:
    return spec.contrast.grouping


def _level_map(spec: GroupAnalysisSpec) -> dict[str, str]:
    grouping = _grouping(spec)
    if grouping is None:
        return {}
    return {level: group.label for group in grouping.groups for level in group.levels}


def _eligible_groups(spec: GroupAnalysisSpec) -> set[str] | None:
    contrast = spec.contrast
    if isinstance(contrast, GroupContrast):
        if contrast.model == "compared-groups":
            return {contrast.focal, contrast.reference}
        return {group.label for group in contrast.grouping.groups}
    if contrast.grouping is None:
        return None
    return set(contrast.includedGroups)


def _group_labels(spec: GroupAnalysisSpec) -> list[str]:
    contrast = spec.contrast
    if isinstance(contrast, GroupContrast):
        return [group.label for group in contrast.grouping.groups]
    if contrast.grouping is None:
        return []
    return list(contrast.includedGroups)


def _encode(
    name: str, raw: Mapping[str, str], subjects: list[str], *, numeric_only: bool
) -> dict[str, dict[str, float]]:
    """Encode one covariate over the included subjects.

    A numeric variable is one column; a categorical one becomes one indicator
    per level after the first (sorted), and a level every included subject
    shares adds nothing. For sex, a female level (``F`` or
    ``Female``, any case) is the ``sex`` column (female = 1) and the first
    other level is the reference.
    """
    values = [raw[subject_id] for subject_id in subjects]
    if all(_is_number(value) for value in values):
        return {name: {sid: float(raw[sid]) for sid in subjects}}
    if numeric_only:
        raise GroupAnalysisError(f"Choose a numeric variable for {name}.")
    levels = sorted(set(values))
    female = next((v for v in levels if v.lower() in _FEMALE), None)
    if name == "sex" and female is not None:
        others = [level for level in levels if level != female]
        columns = {name: female, **{f"{name}:{level}": level for level in others[1:]}}
        if not others:
            return {}
    else:
        columns = {f"{name}:{level}": level for level in levels[1:]}
    return {
        key: {sid: 1.0 if raw[sid] == level else 0.0 for sid in subjects}
        for key, level in columns.items()
    }


def _covariate_refs(spec: GroupAnalysisSpec) -> list[tuple[str, VariableRef, bool]]:
    refs: list[tuple[str, VariableRef, bool]] = []
    if spec.covariates.age is not None:
        refs.append(("age", spec.covariates.age, True))
    if spec.covariates.sex is not None:
        refs.append(("sex", spec.covariates.sex, False))
    refs.extend(
        (f"{ref.source}:{ref.column}", ref, False) for ref in spec.covariates.extra
    )
    return refs


def _qc_reason(rule: str, verdict: str) -> str | None:
    if rule == "all":
        return None
    if verdict == "fail":
        return "qc-failed"
    if rule == "passed" and verdict != "pass":
        return "qc-not-passed"
    return None


def _candidates(context: AnalysisContext, tables: Tables) -> list[str]:
    ids = set(_registry_by_subject(context))
    for source in ("dk-all-stats", "cortical-thickness", "icv", "brainage"):
        table = tables.get(source)
        if table.usable:
            ids.update(table.rows)
    return sorted(subject_id for subject_id in ids if _SUBJECT_ID.fullmatch(subject_id))


def _measure_problem(measure_id: str, tables: Tables) -> str | None:
    source = measure_source(measure_id)
    table = tables.get(source)
    label = _FILE_NAMES[source]
    if not table.present:
        return str(table.reason)
    if table.reason is not None:
        return f"{label} cannot be read: {table.reason}"[:_MAX_REASON]
    missing = [
        column for column in measure_columns(measure_id) if column not in table.header
    ]
    if missing:
        return f"{label} has no {missing[0]} column."
    return None


def _resolve(  # noqa: PLR0912, PLR0915
    context: AnalysisContext, spec: GroupAnalysisSpec, tables: Tables
) -> _Resolution:
    include, exclude = config_subject_scope(dict(context.cfg))
    registry = _registry_by_subject(context)
    level_map = _level_map(spec)
    eligible = _eligible_groups(spec)
    grouping = _grouping(spec)
    group_values = (
        variable_values(grouping.variable, context, tables)
        if grouping is not None
        else {}
    )
    refs = _covariate_refs(spec)
    raw_covariates = {
        name: variable_values(ref, context, tables) for name, ref, _ in refs
    }
    contrast = spec.contrast
    tested_raw = (
        variable_values(contrast.variable, context, tables)
        if isinstance(contrast, AssociationContrast)
        else None
    )
    # A non-numeric cell of a numeric variable reads as missing for that
    # subject; a variable with no numeric cell at all is the wrong choice.
    # An extra covariate whose cells are mostly numbers is numeric, as the
    # catalog lists it.
    numeric: dict[str, tuple[VariableRef, Mapping[str, str]]] = {
        name: (ref, raw_covariates[name])
        for name, ref, only in refs
        if only or (name != "sex" and numeric_column(raw_covariates[name].values()))
    }
    if isinstance(contrast, AssociationContrast) and tested_raw is not None:
        numeric["tested"] = (contrast.variable, tested_raw)
    not_numbers: dict[str, set[str]] = {}
    for name, (_ref, raw) in numeric.items():
        bad = {sid for sid, text in raw.items() if not _is_number(text)}
        if bad and len(bad) == len(raw):
            label = "the tested variable" if name == "tested" else name
            raise GroupAnalysisError(f"Choose a numeric variable for {label}.")
        not_numbers[name] = bad
    left_out: dict[str, int] = dict.fromkeys(not_numbers, 0)
    flagged, unjudged = registration_flags(context)
    registration_rule = spec.inclusion.registration
    outlier_rule = spec.inclusion.outliers
    issues: list[str] = []
    outliers: dict[str, set[str]] = {}
    outliers_unapplied = False
    if outlier_rule != "keep":
        table = tables.get("outliers")
        if table.usable:
            outliers = outlier_flags(table)
        else:
            # The rule cannot be applied; the sample says so and is provisional.
            outliers_unapplied = True
            issues.append(
                _OUTLIERS_MISSING if not table.present else _OUTLIERS_UNREADABLE
            )
    selected = set(spec.measures)

    candidates: list[_Candidate] = []
    provisional = not context.registration_known
    for subject_id in _candidates(context, tables):
        item = _Candidate(subject_id)
        candidates.append(item)
        raw_level = group_values.get(subject_id)
        item.group = level_map.get(raw_level) if raw_level is not None else None
        record = registry.get(subject_id)
        registry_label = (
            _registry_text(record.get("sourceCohortLabel")) if record else None
        )
        item.source_label = raw_level if grouping is not None else registry_label
        if item.source_label is not None and (
            len(item.source_label) > _MAX_LABEL
            or not _PRINTABLE.fullmatch(item.source_label)
        ):
            item.source_label = None
        if subject_id in exclude or (include and subject_id not in include):
            item.reason = "config-excluded"
            continue
        verdict = effective_qc_verdict(dict(context.qc.get(subject_id) or {}))
        if reason := _qc_reason(spec.inclusion.qc, verdict):
            item.reason = reason
            continue
        if grouping is not None and item.group is None:
            item.reason = "no-group"
            continue
        if eligible is not None and item.group not in eligible:
            item.reason = "not-compared"
            continue
        if any(subject_id not in values for values in raw_covariates.values()) or (
            tested_raw is not None and subject_id not in tested_raw
        ):
            item.reason = "missing-covariate"
            continue
        if bad := [name for name, ids in not_numbers.items() if subject_id in ids]:
            item.reason = "missing-covariate"
            for name in bad:
                left_out[name] += 1
            continue
        if subject_id in unjudged:
            provisional = True
        hemis = flagged.get(subject_id, set())
        if registration_rule == "exclude-subject" and hemis:
            item.reason = "registration-flagged"
            continue
        if registration_rule == "set-missing":
            item.missing_hemispheres = tuple(sorted(hemis))
        if (
            outlier_rule == "exclude-subject"
            and outliers.get(subject_id, set()) & selected
        ):
            item.reason = "outlier"
            continue

    for name, count in left_out.items():
        if count:
            issues.append(_not_numeric_issue(numeric[name][0], count))
    included_ids = [item.subject_id for item in candidates if item.reason is None]
    covariates: dict[str, dict[str, float]] = {}
    for name, _ref, numeric_only in refs:
        covariates.update(
            _encode(name, raw_covariates[name], included_ids, numeric_only=numeric_only)
        )
    tested = (
        {sid: float(tested_raw[sid]) for sid in included_ids}
        if tested_raw is not None
        else None
    )

    etiv_rule = spec.covariates.etiv
    needs_etiv = any(takes_etiv(measure, etiv_rule) for measure in spec.measures)
    icv = tables.get("icv")
    etiv: dict[str, float | None] = {}
    if needs_etiv and icv.usable and "eTIV" in icv.header:
        etiv = {sid: measure_value(icv, "global:eTIV", sid) for sid in included_ids}
        covariates["eTIV"] = {
            sid: value for sid, value in etiv.items() if value is not None
        }

    by_id = {item.subject_id: item for item in candidates}
    measures: dict[str, dict[str, float | None]] = {}
    skipped: list[dict[str, Any]] = []
    too_small: dict[str, tuple[int, int]] = {}
    for measure_id in spec.measures:
        problem = _measure_problem(measure_id, tables)
        if (
            problem is None
            and takes_etiv(measure_id, etiv_rule)
            and "eTIV" not in covariates
        ):
            problem = (
                "eTIV is a covariate of this measure, and icv_data.csv has no "
                "readable eTIV column."
            )
        if problem is not None:
            skipped.append({"measureId": measure_id, "reason": problem})
            continue
        table = tables.get(measure_source(measure_id))
        hemis = _cortical_hemispheres(measure_id)
        needs = takes_etiv(measure_id, etiv_rule)
        cells: dict[str, float | None] = {}
        for sid in included_ids:
            value = measure_value(table, measure_id, sid)
            if (
                (needs and etiv.get(sid) is None)
                or (hemis and set(hemis) & set(by_id[sid].missing_hemispheres))
                or (
                    outlier_rule == "set-missing"
                    and measure_id in outliers.get(sid, ())
                )
            ):
                value = None
            cells[sid] = value
        if problem := _sample_problem(spec, cells, by_id):
            skipped.append({"measureId": measure_id, "reason": problem})
            continue
        present = [sid for sid, value in cells.items() if value is not None]
        parameters = parameter_count(spec, measure_id, present, by_id, covariates)
        if parameters >= len(present):
            # The engine would find no residual degree of freedom.
            too_small[measure_id] = (len(present), parameters)
            skipped.append(
                {
                    "measureId": measure_id,
                    "reason": too_few_subjects(parameters, len(present)),
                }
            )
            continue
        measures[measure_id] = cells

    for sid in included_ids:
        if not any(cells[sid] is not None for cells in measures.values()):
            by_id[sid].reason = "no-measures"
    final_ids = {item.subject_id for item in candidates if item.reason is None}
    for cells in measures.values():
        for sid in list(cells):
            if sid not in final_ids:
                del cells[sid]
    for values in covariates.values():
        for sid in list(values):
            if sid not in final_ids:
                del values[sid]
    if tested is not None:
        tested = {sid: value for sid, value in tested.items() if sid in final_ids}
    return _Resolution(
        candidates=candidates,
        covariates=covariates,
        tested=tested,
        measures=measures,
        skipped=skipped,
        registration_provisional=provisional,
        tables=tables,
        issues=issues,
        outliers_unapplied=outliers_unapplied,
        too_small=too_small,
    )


def _not_numeric_issue(ref: VariableRef, count: int) -> str:
    where = "the registry" if ref.source == "registry" else _FILE_NAMES[ref.source]
    subjects = "1 subject, so it is" if count == 1 else f"{count} subjects, so they are"
    return (
        f"{ref.column} in {where} is not a number for {subjects} left out as "
        "missing that variable."
    )


def _sample_problem(
    spec: GroupAnalysisSpec,
    cells: Mapping[str, float | None],
    by_id: Mapping[str, _Candidate],
) -> str | None:
    present = {sid: value for sid, value in cells.items() if value is not None}
    contrast = spec.contrast
    if isinstance(contrast, GroupContrast):
        for label in (contrast.focal, contrast.reference):
            count = sum(1 for sid in present if by_id[sid].group == label)
            if count < _MIN_GROUP_VALUES:
                return f"Fewer than two subjects in {label} have a value."
    elif len(present) < _MIN_ASSOCIATION_VALUES:
        return "Fewer than three subjects have a value."
    if len(set(present.values())) < 2:  # noqa: PLR2004
        return "The values do not vary across subjects."
    return None


def parameter_count(
    spec: GroupAnalysisSpec,
    measure_id: str,
    present: Iterable[str],
    by_id: Mapping[str, _Candidate],
    covariates: Mapping[str, Mapping[str, float]],
) -> int:
    """Count the model parameters the engine fits for one measure.

    As the engine builds the design: the intercept, the tested term (the
    focal indicator or the slope), an indicator for every other modeled group
    with a subject, and each covariate column that varies among the subjects
    with a value (eTIV only where the measure takes it).

    Parameters
    ----------
    present
        The subjects with a value of the measure.
    by_id
        Every candidate by subject ID.
    covariates
        The encoded covariate columns of the included subjects.

    Returns
    -------
    int
        The number of design columns.
    """
    ids = list(present)
    contrast = spec.contrast
    groups = {by_id[sid].group for sid in ids}
    count = 1
    if isinstance(contrast, GroupContrast):
        count += len(groups - {contrast.reference, None})
    else:
        count += 1
        if contrast.grouping is not None and contrast.adjustForGroup:
            count += len(groups & set(contrast.includedGroups[1:]))
    for name, values in covariates.items():
        if name == "eTIV" and not takes_etiv(measure_id, spec.covariates.etiv):
            continue
        if len({values.get(sid) for sid in ids}) > 1:
            count += 1
    return count


def too_few_subjects(parameters: int, subjects: int) -> str:
    """Say that a measure has too few subjects for the model's parameters."""
    return (
        f"The model has {parameters} parameters, so a fit needs "
        f"{parameters + 1} subjects with this measure; {subjects} have it."
    )


def no_fit_message(
    skipped: list[dict[str, Any]], too_small: Mapping[str, tuple[int, int]]
) -> str:
    """Say in one sentence why no selected measure could be fit.

    Parameters
    ----------
    skipped
        Every skipped measure with its reason.
    too_small
        ``(subjects, parameters)`` of each measure skipped for having too few
        subjects for the model.

    Returns
    -------
    str
        The sentence, with the counts that explain it.
    """
    total = len(skipped)
    if total and all(row["measureId"] in too_small for row in skipped):
        counts = [too_small[row["measureId"]] for row in skipped]
        low = min(p for _n, p in counts)
        high = max(p for _n, p in counts)
        parameters = str(low) if low == high else f"{low} to {high}"
        most = max(n for n, _p in counts)
        head = "the measure has" if total == 1 else "every measure has"
        return (
            f"No selected measure could be fit: {head} fewer subjects than the "
            f"model's {parameters} parameters plus 1 (at most {most} "
            f"{'subject has' if most == 1 else 'subjects have'} a value)."
        )
    if not total:
        return "No selected measure could be fit."
    tally: dict[str, int] = {}
    for row in skipped:
        tally[row["reason"]] = tally.get(row["reason"], 0) + 1
    reason, count = max(tally.items(), key=lambda item: item[1])
    because = reason[:1].lower() + reason[1:]
    because = because.removesuffix(".")
    if count == total:
        head = (
            "the measure was skipped"
            if total == 1
            else f"all {total} measures were skipped"
        )
    else:
        head = f"{count} of {total} measures were skipped"
    return f"No selected measure could be fit: {head} because {because}."


def resolve_inputs(context: AnalysisContext, spec: GroupAnalysisSpec) -> dict[str, Any]:
    """Resolve a draft's sample without computing (``groupAnalysis.inputs``).

    Parameters
    ----------
    spec
        The validated draft specification.

    Returns
    -------
    dict
        The ``GroupAnalysisInputs`` payload; its ``designCheck`` holds the
        site check (:func:`site_check`).
    """
    tables = Tables(context)
    resolution = _resolve(context, spec, tables)
    return {
        "configRevision": context.config_revision,
        "specDigest": spec_digest(spec),
        "subjects": [item.public() for item in resolution.candidates],
        "groups": group_counts(spec, (item.group for item in resolution.included())),
        "included": len(resolution.included()),
        "registrationProvisional": resolution.registration_provisional,
        "inputs": [table.public() for table in tables.all()],
        "skippedMeasures": resolution.skipped,
        "issues": resolution.issues,
        "designCheck": site_check(context, spec, resolution),
    }


def load_dataset(context: AnalysisContext, spec: GroupAnalysisSpec) -> Dataset:
    """Read and align every value one compute needs.

    Parameters
    ----------
    spec
        The validated specification.

    Returns
    -------
    Dataset
        The aligned sample; its issues end with the site check's warnings.

    Raises
    ------
    GroupAnalysisError
        When a variable cannot be read or the site check blocks.
    """
    from .design_check import blocking_message  # noqa: PLC0415

    tables = Tables(context, cache=False)
    resolution = _resolve(context, spec, tables)
    issues = list(resolution.issues)
    if (check := site_check(context, spec, resolution)) is not None:
        if (message := blocking_message(check)) is not None:
            raise GroupAnalysisError(message)
        issues.extend(issue["message"] for issue in check["issues"])
    included = resolution.included()
    ids = [item.subject_id for item in included]
    return Dataset(
        subject_ids=ids,
        groups=[item.group for item in included],
        source_labels=[item.source_label for item in included],
        covariates={
            name: [values.get(sid) for sid in ids]
            for name, values in resolution.covariates.items()
        },
        tested=(
            [resolution.tested[sid] for sid in ids]
            if resolution.tested is not None
            else None
        ),
        measures={
            measure_id: [cells[sid] for sid in ids]
            for measure_id, cells in resolution.measures.items()
        },
        subjects=[item.public() for item in resolution.candidates],
        skipped=resolution.skipped,
        inputs=[table.public() for table in tables.all()],
        registration_provisional=resolution.registration_provisional,
        issues=issues,
        outliers_unapplied=resolution.outliers_unapplied,
        too_small=resolution.too_small,
    )


def site_check(
    context: AnalysisContext, spec: GroupAnalysisSpec, resolution: _Resolution
) -> dict[str, Any] | None:
    """Check the included subjects' sites with the site check spec v2 uses.

    Returns
    -------
    dict or None
        The ``DesignCheck`` payload of :func:`design_check.check_sites_v1`, or
        None when no included subject has a site.
    """
    from .design_check import check_sites_v1  # noqa: PLC0415

    registry = _registry_by_subject(context)
    included = resolution.included()
    return check_sites_v1(
        spec,
        [item.group for item in included],
        [site_of(registry.get(item.subject_id)) for item in included],
    )


def group_counts(
    spec: GroupAnalysisSpec, groups: Iterable[str | None]
) -> list[dict[str, Any]]:
    """Count the included subjects of each group the specification names."""
    labels = list(groups)
    return [
        {"label": label, "n": sum(1 for group in labels if group == label)}
        for label in _group_labels(spec)
    ]


def registration_relevant(spec: GroupAnalysisSpec) -> bool:
    """Say whether registration flags can change this specification's result."""
    rule = spec.inclusion.registration
    return rule == "exclude-subject" or (
        rule == "set-missing" and any(is_cortical(m) for m in spec.measures)
    )


def used_sources(spec: GroupAnalysisSpec) -> list[str]:
    """List the input tables whose bytes can change this specification's result."""
    used = {measure_source(measure) for measure in spec.measures}
    if any(takes_etiv(m, spec.covariates.etiv) for m in spec.measures):
        used.add("icv")
    if spec.inclusion.outliers != "keep":
        used.add("outliers")
    contrast = spec.contrast
    refs = [
        ref
        for ref in (spec.covariates.age, spec.covariates.sex, *spec.covariates.extra)
        if ref is not None
    ]
    if contrast.grouping is not None:
        refs.append(contrast.grouping.variable)
    if isinstance(contrast, AssociationContrast):
        refs.append(contrast.variable)
    used.update(ref.source for ref in refs if ref.source != "registry")
    return [source for source in INPUT_SOURCES if source in used]


def _digest(value: Any) -> str:
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _registry_refs(spec: GroupAnalysisSpec) -> list[str]:
    contrast = spec.contrast
    refs = [
        ref
        for ref in (spec.covariates.age, spec.covariates.sex, *spec.covariates.extra)
        if ref is not None
    ]
    if contrast.grouping is not None:
        refs.append(contrast.grouping.variable)
    if isinstance(contrast, AssociationContrast):
        refs.append(contrast.variable)
    return sorted({ref.column for ref in refs if ref.source == "registry"})


def context_state(context: AnalysisContext, spec: GroupAnalysisSpec) -> dict[str, Any]:
    """Return the snapshot facts a stored result's currency compares.

    Returns
    -------
    dict
        ``registrySha256`` over the registry fields the specification reads
        (every record), and ``registrationSha256`` over the flagged
        hemispheres by subject (a constant when flags cannot change the
        result).
    """
    fields = _registry_refs(spec)
    registry = sorted(
        (
            {"subjectId": sid, **{key: record.get(key) for key in fields}}
            for sid, record in _registry_by_subject(context).items()
        ),
        key=lambda item: item["subjectId"],
    )
    flagged, _unjudged = registration_flags(context)
    flags = (
        {sid: sorted(hemis) for sid, hemis in sorted(flagged.items())}
        if registration_relevant(spec)
        else {}
    )
    return {
        "registrySha256": _digest(registry if fields else []),
        "registrationSha256": _digest(flags),
    }
