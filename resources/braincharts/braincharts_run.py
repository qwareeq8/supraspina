#!/usr/bin/env python3
"""Adapt the BrainCharts lifespan model to each site's controls and write z-scores.

A first-party reimplementation of upstream SCI_Map Step 3 at ``eba4f59``
(``make_brainchart_outputs.sh`` with ``keys_lifespan57K_82sites.csv``,
``split_braincharts_adaptation_test.py``, and
``run_braincharts_normative_models.py``). It runs in the provisioned
BrainCharts environment (CPython 3.12, pcntoolkit 0.35.0) and reads:

- the ``features`` stage's ``concatenated_results.csv`` (``ID`` plus the 187
  regions under FreeSurfer's names, which :func:`model_region_name` maps to
  the model's names exactly as the upstream key file does);
- the run-scoped registry projection (``subject,age,sex,siteLabel,cohort``;
  sex ``F``, ``M``, or ``O``; cohort ``control``, ``SCI_nNP``, or ``SCI_P``);
- the unpacked ``lifespan_57K_82sites`` model with its site and phenotype
  lists.

Rows without an age, with sex ``O``, or without a region value get no
z-scores. A site with fewer than 2 controls is refused. A site with exactly 2
controls adapts the model with both and holds none out, because pcntoolkit
needs 2 adaptation rows per site. Every other site uses upstream's split: one
``random.Random(seed)``, sites in sorted label order, each site's controls
sorted by subject and shuffled, and ``round(n * 0.5)`` adaptation controls
(Python's half-to-even rounding) kept between 1 and ``n - 1``. Each site gets
the token ``supraspina-site-<n>``, which no training site uses, so every site is
adapted as a new site with all-zero site columns; ``n`` is the site's 1-based
position among the adapted sites and is the variance group pcntoolkit adapts.

For each region the model predicts with ``alg="blr"``, ``inputsuffix=
"estimate"``, a B-spline design over age (``xmin`` -5, ``xmax`` 110) and sex,
and forced adaptation, as upstream. The outputs are published as one
complete generation behind the output directory's link.

Exit codes: 0 success, 2 unusable input, 3 regions that differ from the
model's lists, 4 no site that can be adapted, 5 a model prediction failure,
6 an incomplete runtime. Each failure ends with one sentence on standard
error.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import random
import shutil
import sys
import tempfile
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

EXIT_INPUT = 2
EXIT_REGIONS = 3
EXIT_NO_SITE = 4
EXIT_MODEL = 5
EXIT_RUNTIME = 6

#: Upstream's default fraction of each site's controls that adapts the model.
ADAPT_FRACTION = 0.5
DEFAULT_SEED = 117
#: The B-spline age range of the lifespan model's design matrix.
XMIN = -5.0
XMAX = 110.0
Z_SUFFIX = "_zscore"
CONTROL = "control"
COHORTS = ("control", "SCI_nNP", "SCI_P")
#: The BrainCharts notebook's coding: 0 female, 1 male.
SEX_CODES = {"F": 0, "M": 1}
SITE_TOKEN_PREFIX = "supraspina-site-"
METADATA_COLUMNS = ("subject", "age", "sex", "siteLabel", "cohort")
#: ``final_r_contract.ZSCORE_ID_COLUMNS``; the z-score stage reads them.
ZSCORE_ID_COLUMNS = ("subject", "siteLabel", "cohort", "age", "sex")
UPSTREAM_REPOSITORY = "https://github.com/ortizo-117/SCI_Map"
UPSTREAM_COMMIT = "eba4f59489438a54d41825db57c6cfc983d059ad"

ZSCORES_FILE = "braincharts_zscores.csv"
TEST_FILE = "braincharts_test_with_zscores.csv"
SUMMARY_FILE = "braincharts_zscore_summary.csv"
SPLIT_REPORT_FILE = "braincharts_split_report.csv"
SPLIT_FILE = "braincharts_split.csv"
REFUSED_SITES_FILE = "braincharts_refused_sites.csv"
RUN_FILE = "braincharts_run.json"
MANIFEST_FILE = ".braincharts-generation.json"
#: Every published output in manifest order.
OUTPUT_FILES = (
    ZSCORES_FILE,
    TEST_FILE,
    SUMMARY_FILE,
    SPLIT_REPORT_FILE,
    SPLIT_FILE,
    REFUSED_SITES_FILE,
    RUN_FILE,
)
SUMMARY_COLUMNS = (
    "phenotype",
    "n",
    "mean_z",
    "sd_z",
    "min_z",
    "max_z",
    "n_abs_z_gt_7",
)
SPLIT_REPORT_COLUMNS = (
    "site",
    "controls_total",
    "controls_adaptation",
    "controls_test",
    "refused",
    "reason",
)
SPLIT_COLUMNS = ("subject", "siteLabel", "cohort", "role", "reason")
REFUSED_SITES_COLUMNS = ("site", "subjects", "subject_ids", "reason")

_MAX_TABLE_BYTES = 64 * 1024 * 1024
_MAX_TABLE_ROWS = 100_000
_MAX_TABLE_COLUMNS = 1_024
_MAX_LIST_BYTES = 64 * 1024
_LISTED_DIFFERENCES = 5


class StageError(Exception):
    """A failure that ends the run with one exit code and one sentence."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class Subject:
    """One analysis subject from the registry projection and the feature table."""

    subject: str
    site_label: str
    cohort: str
    age_text: str
    sex: str
    age: float | None = None
    values: list[float] | None = None
    value_texts: list[str] = field(default_factory=list)


@dataclass
class SiteReport:
    """One site's control counts and refusal, as the split report lists it."""

    site: str
    controls_total: int
    controls_adaptation: int = 0
    controls_test: int = 0
    refused: bool = False
    reason: str = ""


@dataclass
class Split:
    """The adaptation and test rows, each site's report, and each row's role."""

    adaptation: list[Subject]
    test: list[Subject]
    reports: list[SiteReport]
    sitenums: dict[str, int]
    roles: dict[str, tuple[str, str]]


# -- Names ------------------------------------------------------------------------


def model_region_name(name: str) -> str:
    """Return the model's name for one FreeSurfer region column.

    Upstream renames the joined FreeSurfer table through
    ``keys_lifespan57K_82sites.csv``; its 187 region rows reduce to two rules:
    ``_and_`` becomes ``&``, and the thalamus volumes gain ``-Proper``.
    """
    mapped = name.replace("_and_", "&")
    if mapped in {"Left-Thalamus", "Right-Thalamus"}:
        mapped += "-Proper"
    return mapped


def site_token(sitenum: int) -> str:
    """Return the site identifier the design matrix receives for one site."""
    return f"{SITE_TOKEN_PREFIX}{sitenum}"


def site_phrase(label: str) -> str:
    """Name a site at the start of a sentence; no label means the whole cohort."""
    return f"Site {label}" if label else "The cohort"


def _subjects_phrase(count: int) -> str:
    return f"its {count} subject gets" if count == 1 else f"its {count} subjects get"


# -- Inputs -----------------------------------------------------------------------


def read_table(path: str, label: str) -> tuple[list[str], list[list[str]]]:
    """Read one bounded CSV as its header and rows."""
    try:
        size = os.path.getsize(path)
    except OSError as exc:
        raise StageError(EXIT_INPUT, f"The {label} is missing: {path}.") from exc
    if size > _MAX_TABLE_BYTES:
        raise StageError(EXIT_INPUT, f"The {label} exceeds 64 MiB.")
    try:
        with open(path, newline="", encoding="utf-8-sig") as handle:
            reader = csv.reader(handle)
            header = [cell.strip() for cell in next(reader, [])]
            if len(header) > _MAX_TABLE_COLUMNS:
                raise StageError(EXIT_INPUT, f"The {label} has too many columns.")
            rows: list[list[str]] = []
            for row in reader:
                if not any(cell.strip() for cell in row):
                    continue
                if len(rows) >= _MAX_TABLE_ROWS:
                    raise StageError(EXIT_INPUT, f"The {label} has too many rows.")
                if len(row) != len(header):
                    raise StageError(
                        EXIT_INPUT,
                        f"The {label} has a row with {len(row)} cells; its header "
                        f"names {len(header)}.",
                    )
                rows.append(row)
    except (OSError, UnicodeError, csv.Error) as exc:
        raise StageError(EXIT_INPUT, f"The {label} is unreadable: {exc}.") from exc
    if not header:
        raise StageError(EXIT_INPUT, f"The {label} has no header.")
    return header, rows


def read_list(path: str) -> list[str]:
    """Read one site or phenotype list as its non-empty lines."""
    try:
        if os.path.getsize(path) > _MAX_LIST_BYTES:
            raise StageError(EXIT_RUNTIME, f"{Path(path).name} exceeds its bound.")
        with open(path, encoding="utf-8") as handle:
            return [line.strip() for line in handle if line.strip()]
    except (OSError, UnicodeError) as exc:
        raise StageError(
            EXIT_RUNTIME,
            f"The BrainCharts list {Path(path).name} is unreadable; set the model "
            "up again in Scientific resources.",
        ) from exc


def phenotype_union(lists: list[list[str]]) -> list[str]:
    """Return the phenotype lists' union in list order, as upstream reads it."""
    return list(dict.fromkeys(name for names in lists for name in names))


def read_metadata(path: str) -> list[Subject]:
    """Read the registry projection, one row per analysis subject."""
    header, rows = read_table(path, "BrainCharts metadata")
    missing = [column for column in METADATA_COLUMNS if column not in header]
    if missing:
        raise StageError(
            EXIT_INPUT,
            f"The BrainCharts metadata lacks the column(s) {', '.join(missing)}.",
        )
    index = {column: header.index(column) for column in METADATA_COLUMNS}
    subjects: list[Subject] = []
    seen: set[str] = set()
    for row in rows:
        subject = Subject(
            subject=row[index["subject"]].strip(),
            site_label=row[index["siteLabel"]].strip(),
            cohort=row[index["cohort"]].strip(),
            age_text=row[index["age"]].strip(),
            sex=row[index["sex"]].strip().upper(),
        )
        if not subject.subject or subject.subject in seen:
            raise StageError(
                EXIT_INPUT, "The BrainCharts metadata repeats or omits a subject ID."
            )
        if subject.cohort not in COHORTS:
            raise StageError(
                EXIT_INPUT,
                f"{subject.subject} has the cohort {subject.cohort or 'blank'}; the "
                "stage takes control, SCI_nNP, or SCI_P.",
            )
        seen.add(subject.subject)
        subjects.append(subject)
    if not subjects:
        raise StageError(EXIT_INPUT, "The BrainCharts metadata lists no subjects.")
    return subjects


def read_features(
    path: str, phenotypes: list[str]
) -> tuple[dict[str, int], dict[str, list[str]]]:
    """Read the feature table and map its region columns to the model's names.

    Returns
    -------
    tuple
        The column position of each model region and each subject's row.

    Raises
    ------
    StageError
        With exit code 3 when the mapped regions differ from ``phenotypes``.
    """
    header, rows = read_table(path, "feature table")
    if header[0] != "ID":
        raise StageError(EXIT_INPUT, "The feature table's first column is not ID.")
    mapped = [model_region_name(name) for name in header[1:]]
    wanted = set(phenotypes)
    missing = [name for name in phenotypes if name not in mapped]
    unexpected = [name for name in mapped if name not in wanted]
    repeated = sorted({name for name in mapped if mapped.count(name) > 1})
    if missing or unexpected or repeated:
        differences = [
            *(f"missing {name}" for name in missing),
            *(f"unexpected {name}" for name in unexpected),
            *(f"repeated {name}" for name in repeated),
        ]
        shown = ", ".join(differences[:_LISTED_DIFFERENCES])
        more = len(differences) - _LISTED_DIFFERENCES
        if more > 0:
            shown += f", and {more} more"
        raise StageError(
            EXIT_REGIONS,
            "The feature table's regions do not match the model's phenotype "
            f"lists: {shown}.",
        )
    positions = {name: position + 1 for position, name in enumerate(mapped)}
    by_subject: dict[str, list[str]] = {}
    for row in rows:
        subject = row[0].strip()
        if subject in by_subject:
            raise StageError(EXIT_INPUT, f"The feature table repeats {subject}.")
        by_subject[subject] = row
    return positions, by_subject


def attach_features(
    subjects: list[Subject],
    phenotypes: list[str],
    positions: dict[str, int],
    rows: dict[str, list[str]],
) -> dict[str, str]:
    """Attach each subject's ages and region values, refusing unusable rows.

    Returns
    -------
    dict
        The refusal sentence of each subject that gets no z-scores.
    """
    refusals: dict[str, str] = {}
    for subject in subjects:
        row = rows.get(subject.subject)
        if row is None:
            raise StageError(
                EXIT_INPUT, f"{subject.subject} has no row in the feature table."
            )
        texts = [row[positions[name]].strip() for name in phenotypes]
        subject.value_texts = texts
        if not subject.age_text:
            refusals[subject.subject] = (
                f"{subject.subject} has no age, so it gets no z-scores."
            )
            continue
        try:
            age = float(subject.age_text)
        except ValueError as exc:
            raise StageError(
                EXIT_INPUT, f"{subject.subject} has the age {subject.age_text}."
            ) from exc
        if not math.isfinite(age) or not XMIN <= age <= XMAX:
            refusals[subject.subject] = (
                f"{subject.subject} has the age {subject.age_text}, outside the "
                "model's -5 to 110 years, so it gets no z-scores."
            )
            continue
        subject.age = age
        if subject.sex not in SEX_CODES:
            sex = subject.sex or "blank"
            refusals[subject.subject] = (
                f"{subject.subject} has sex {sex}; the model takes female or male."
            )
            continue
        values: list[float] = []
        for name, text in zip(phenotypes, texts, strict=True):
            try:
                value = float(text) if text else math.nan
            except ValueError as exc:
                raise StageError(
                    EXIT_INPUT,
                    f"{subject.subject} has the non-numeric {name} value {text}.",
                ) from exc
            if not math.isfinite(value):
                refusals[subject.subject] = (
                    f"{subject.subject} has no {name} value, so it gets no z-scores."
                )
                break
            values.append(value)
        else:
            subject.values = values
    return refusals


# -- Split ------------------------------------------------------------------------


def adaptation_count(n_controls: int, fraction: float = ADAPT_FRACTION) -> int:
    """Return how many of a site's controls adapt the model.

    Upstream's rule for 3 or more controls, and both controls for exactly 2
    (pcntoolkit needs 2 adaptation rows per site). Fewer than 2 is refused.
    """
    if n_controls < 2:  # noqa: PLR2004 - the approved minimum
        raise ValueError("A site needs at least 2 controls.")
    if n_controls == 2:  # noqa: PLR2004 - the approved deviation
        return 2
    return max(1, min(n_controls - 1, round(n_controls * fraction)))


def split_sites(subjects: list[Subject], seed: int) -> Split:
    """Split each site's controls into adaptation and held-out test rows.

    ``subjects`` are the rows that passed :func:`attach_features`. Sites with
    one control are shuffled like upstream (a one-item shuffle draws nothing),
    so every later site sees upstream's random stream.
    """
    by_site: dict[str, list[Subject]] = defaultdict(list)
    controls_by_site: dict[str, list[Subject]] = defaultdict(list)
    for subject in subjects:
        by_site[subject.site_label].append(subject)
        if subject.cohort == CONTROL:
            controls_by_site[subject.site_label].append(subject)
    eligible = sorted(
        label
        for label in by_site
        if len(controls_by_site[label]) >= 2  # noqa: PLR2004
    )
    sitenums = {label: index + 1 for index, label in enumerate(eligible)}
    rng = random.Random(seed)  # noqa: S311 - a recorded, reproducible split
    adaptation: list[Subject] = []
    test: list[Subject] = []
    roles: dict[str, tuple[str, str]] = {}
    reports: dict[str, SiteReport] = {}
    for label in sorted(controls_by_site):
        controls = sorted(controls_by_site[label], key=lambda item: item.subject)
        rng.shuffle(controls)
        if label not in sitenums:
            continue
        n_adapt = adaptation_count(len(controls))
        adaptation.extend(controls[:n_adapt])
        test.extend(controls[n_adapt:])
        for subject in controls[:n_adapt]:
            roles[subject.subject] = ("adaptation", "")
        for subject in controls[n_adapt:]:
            roles[subject.subject] = ("test", "")
        reason = (
            f"{site_phrase(label)} has 2 controls; both adapt the model, so none "
            "are held out."
            if len(controls) == 2  # noqa: PLR2004
            else ""
        )
        reports[label] = SiteReport(
            site=label,
            controls_total=len(controls),
            controls_adaptation=n_adapt,
            controls_test=len(controls) - n_adapt,
            reason=reason,
        )
    for label in sorted(by_site):
        members = by_site[label]
        if label in sitenums:
            for subject in members:
                if subject.cohort != CONTROL:
                    test.append(subject)
                    roles[subject.subject] = ("test", "")
            continue
        n_controls = len(controls_by_site[label])
        if n_controls == 0:
            reason = (
                f"{site_phrase(label)} has no controls, so the model cannot be "
                f"adapted to it; {_subjects_phrase(len(members))} no z-scores."
            )
        else:
            reason = (
                f"{site_phrase(label)} has 1 control; adapting the model needs at "
                "least 2."
            )
        reports[label] = SiteReport(
            site=label, controls_total=n_controls, refused=True, reason=reason
        )
        for subject in members:
            roles[subject.subject] = ("refused", reason)
    adaptation.sort(key=lambda item: (item.site_label, item.subject))
    test.sort(key=lambda item: (item.site_label, item.cohort, item.subject))
    return Split(
        adaptation=adaptation,
        test=test,
        reports=[reports[label] for label in sorted(reports)],
        sitenums=sitenums,
        roles=roles,
    )


# -- Prediction -------------------------------------------------------------------


def isolate_runtime(work_dir: Path) -> None:
    """Keep the runtime's caches and threads inside the run's work directory.

    arviz, pytensor, matplotlib, and numba otherwise write under ``~/.cache``.
    Call this before importing NumPy or pcntoolkit.
    """
    caches = work_dir / "cache"
    for name in ("xdg", "matplotlib", "numba", "pytensor"):
        (caches / name).mkdir(parents=True, exist_ok=True)
    os.environ.update(
        {
            "XDG_CACHE_HOME": str(caches / "xdg"),
            "MPLCONFIGDIR": str(caches / "matplotlib"),
            "MPLBACKEND": "Agg",
            "NUMBA_CACHE_DIR": str(caches / "numba"),
            "PYTENSOR_FLAGS": f"base_compiledir={caches / 'pytensor'}",
            "OMP_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
            "OPENBLAS_NUM_THREADS": "1",
        }
    )


def load_runtime() -> tuple[Any, Any, Any]:
    """Import NumPy and the two pcntoolkit calls upstream uses."""
    try:
        import numpy as np  # noqa: PLC0415
        from pcntoolkit.normative import predict  # noqa: PLC0415
        from pcntoolkit.util.utils import create_design_matrix  # noqa: PLC0415
    except ImportError as exc:
        raise StageError(
            EXIT_RUNTIME,
            "The BrainCharts runtime cannot import pcntoolkit; set it up again in "
            f"Scientific resources ({exc}).",
        ) from exc
    return np, predict, create_design_matrix


def _design(
    create_design_matrix: Any,
    np: Any,
    rows: list[Subject],
    sitenums: dict[str, int],
    training_sites: list[str],
) -> Any:
    covariates = np.array(
        [[subject.age, SEX_CODES[subject.sex]] for subject in rows], dtype=float
    )
    return create_design_matrix(
        covariates,
        site_ids=[site_token(sitenums[subject.site_label]) for subject in rows],
        all_sites=training_sites,
        basis="bspline",
        xmin=XMIN,
        xmax=XMAX,
    )


def predict_zscores(  # noqa: PLR0913
    split: Split,
    phenotypes: list[str],
    model_dir: Path,
    training_sites: list[str],
    work_dir: Path,
    runtime: tuple[Any, Any, Any],
) -> dict[str, list[float]]:
    """Predict every test row's z-score for each region with forced adaptation.

    Mirrors upstream's per-region loop: one work directory per region, the
    design matrices and responses saved as text, and pcntoolkit's ``predict``
    run inside that directory, which it writes its outputs to.
    """
    np, predict, create_design_matrix = runtime
    if not split.test:
        return {name: [] for name in phenotypes}
    x_te = _design(create_design_matrix, np, split.test, split.sitenums, training_sites)
    x_ad = _design(
        create_design_matrix, np, split.adaptation, split.sitenums, training_sites
    )
    sitenum_te = np.array(
        [split.sitenums[subject.site_label] for subject in split.test], dtype=int
    )
    sitenum_ad = np.array(
        [split.sitenums[subject.site_label] for subject in split.adaptation],
        dtype=int,
    )
    z_scores: dict[str, list[float]] = {}
    for position, name in enumerate(phenotypes):
        print(f"Running IDP {position + 1}/{len(phenotypes)}: {name}", flush=True)
        source = model_dir / name / "Models"
        if not source.is_dir():
            raise StageError(EXIT_RUNTIME, f"The model has no {name} directory.")
        idp_dir = work_dir / "model_work" / name
        idp_dir.mkdir(parents=True, exist_ok=True)
        files = {
            key: str(idp_dir / f"{key}.txt")
            for key in (
                "resp_te",
                "cov_bspline_te",
                "resp_ad",
                "cov_bspline_ad",
                "sitenum_ad",
                "sitenum_te",
            )
        }
        np.savetxt(
            files["resp_te"],
            np.array([subject.values[position] for subject in split.test]),  # type: ignore[index]
        )
        np.savetxt(files["cov_bspline_te"], x_te)
        np.savetxt(
            files["resp_ad"],
            np.array([subject.values[position] for subject in split.adaptation]),  # type: ignore[index]
        )
        np.savetxt(files["cov_bspline_ad"], x_ad)
        np.savetxt(files["sitenum_ad"], sitenum_ad)
        np.savetxt(files["sitenum_te"], sitenum_te)
        previous = Path.cwd()
        os.chdir(idp_dir)
        try:
            result = predict(
                files["cov_bspline_te"],
                alg="blr",
                respfile=files["resp_te"],
                model_path=str(source),
                inputsuffix="estimate",
                adaptrespfile=files["resp_ad"],
                adaptcovfile=files["cov_bspline_ad"],
                adaptvargroupfile=files["sitenum_ad"],
                testvargroupfile=files["sitenum_te"],
            )
        except Exception as exc:
            detail = " ".join(str(exc).split()) or type(exc).__name__
            raise StageError(
                EXIT_MODEL, f"The model could not be applied to {name}: {detail}."
            ) from exc
        finally:
            os.chdir(previous)
        if not isinstance(result, tuple) or len(result) < 3:  # noqa: PLR2004
            raise StageError(EXIT_MODEL, f"The model returned no z-scores for {name}.")
        values = np.asarray(result[2], dtype=float).reshape(-1)
        if values.shape[0] != len(split.test):
            fallback = idp_dir / "Z_predict.txt"
            if fallback.is_file():
                values = np.loadtxt(fallback).reshape(-1)
        if values.shape[0] != len(split.test):
            raise StageError(
                EXIT_MODEL,
                f"The model returned {values.shape[0]} z-scores for {name}; "
                f"{len(split.test)} expected.",
            )
        z_scores[name] = [float(value) for value in values]
    return z_scores


def summarize(name: str, values: list[float], np: Any) -> list[str]:
    """Return one summary row: upstream's count, moments, range, and |z| > 7.

    NumPy's NaN-ignoring reductions, as upstream, so the values match it bit
    for bit.
    """
    array = np.asarray(values, dtype=float)
    finite = array[np.isfinite(array)]
    if finite.size == 0:
        return [name, str(array.size), "", "", "", "", "0"]
    sd = float(np.nanstd(array, ddof=1)) if finite.size > 1 else math.nan
    return [
        name,
        str(array.size),
        _number(float(np.nanmean(array))),
        _number(sd),
        _number(float(np.nanmin(array))),
        _number(float(np.nanmax(array))),
        str(int(np.sum(np.abs(array) > 7))),  # noqa: PLR2004
    ]


def _number(value: float) -> str:
    return repr(float(value)) if math.isfinite(value) else ""


# -- Outputs ----------------------------------------------------------------------


def _write_csv(path: Path, header: tuple[str, ...] | list[str], rows: Any) -> None:
    with open(path, "x", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)
        handle.flush()
        os.fsync(handle.fileno())


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_outputs(  # noqa: PLR0913
    stage: Path,
    subjects: list[Subject],
    refusals: dict[str, str],
    split: Split,
    phenotypes: list[str],
    z_scores: dict[str, list[float]],
    run_record: dict[str, Any],
    np: Any,
) -> None:
    """Write every output and the manifest that binds them into ``stage``."""
    z_columns = [f"{name}{Z_SUFFIX}" for name in phenotypes]
    z_rows: list[list[str]] = []
    test_rows: list[list[str]] = []
    for index, subject in enumerate(split.test):
        z_texts = [_number(z_scores[name][index]) for name in phenotypes]
        sex = str(SEX_CODES[subject.sex])
        z_rows.append(
            [subject.subject, subject.site_label, subject.cohort, subject.age_text, sex]
            + z_texts
        )
        sitenum = split.sitenums[subject.site_label]
        test_rows.append(
            [
                subject.subject,
                subject.site_label,
                site_token(sitenum),
                str(sitenum),
                subject.cohort,
                subject.age_text,
                sex,
                *subject.value_texts,
                *z_texts,
            ]
        )
    _write_csv(stage / ZSCORES_FILE, [*ZSCORE_ID_COLUMNS, *z_columns], z_rows)
    _write_csv(
        stage / TEST_FILE,
        [
            "subject",
            "siteLabel",
            "site",
            "sitenum",
            "cohort",
            "age",
            "sex",
            *phenotypes,
            *z_columns,
        ],
        test_rows,
    )
    _write_csv(
        stage / SUMMARY_FILE,
        SUMMARY_COLUMNS,
        [summarize(name, z_scores[name], np) for name in phenotypes],
    )
    _write_csv(
        stage / SPLIT_REPORT_FILE,
        SPLIT_REPORT_COLUMNS,
        [
            [
                report.site,
                str(report.controls_total),
                str(report.controls_adaptation),
                str(report.controls_test),
                "true" if report.refused else "false",
                report.reason,
            ]
            for report in split.reports
        ],
    )
    split_rows = []
    for subject in sorted(subjects, key=lambda item: (item.site_label, item.subject)):
        if subject.subject in refusals:
            role, reason = "refused", refusals[subject.subject]
        else:
            role, reason = split.roles[subject.subject]
        split_rows.append(
            [subject.subject, subject.site_label, subject.cohort, role, reason]
        )
    _write_csv(stage / SPLIT_FILE, SPLIT_COLUMNS, split_rows)
    refused_rows = []
    for report in split.reports:
        if not report.refused:
            continue
        members = sorted(
            subject.subject
            for subject in subjects
            if subject.site_label == report.site and subject.subject not in refusals
        )
        refused_rows.append(
            [report.site, str(len(members)), ";".join(members), report.reason]
        )
    _write_csv(stage / REFUSED_SITES_FILE, REFUSED_SITES_COLUMNS, refused_rows)
    with open(stage / RUN_FILE, "x", encoding="utf-8") as handle:
        handle.write(json.dumps(run_record, indent=2, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    manifest = {
        "schemaVersion": 1,
        "files": [
            {
                "name": name,
                "size": (stage / name).stat().st_size,
                "sha256": _sha256(stage / name),
            }
            for name in OUTPUT_FILES
        ],
    }
    with open(stage / MANIFEST_FILE, "x", encoding="utf-8") as handle:
        handle.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    _fsync_directory(stage)


def generations_root(out_dir: Path) -> Path:
    """Return the directory that holds the output directory's generations."""
    return out_dir.parent / f".{out_dir.name}-generations"


def create_generation(out_dir: Path) -> Path:
    """Create an unpublished generation on the output directory's filesystem."""
    root = generations_root(out_dir)
    root.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="generation-", dir=root))
    stage.chmod(0o755)
    return stage


def publish_generation(stage: Path, out_dir: Path) -> None:
    """Point the output directory at one complete generation, then prune the rest.

    A real directory left by an earlier layout moves into the generation store
    first, so the switch itself is one atomic link replacement.
    """
    root = stage.parent
    if out_dir.exists() and not out_dir.is_symlink():
        legacy = Path(tempfile.mkdtemp(prefix="legacy-", dir=root))
        legacy.rmdir()
        out_dir.rename(legacy)
    link = out_dir.parent / f".{out_dir.name}-current-{os.getpid()}"
    if link.is_symlink() or link.exists():
        link.unlink()
    os.symlink(os.path.relpath(stage, out_dir.parent), link, target_is_directory=True)
    try:
        os.replace(link, out_dir)
    finally:
        if link.is_symlink():
            link.unlink()
    _fsync_directory(out_dir.parent)
    for entry in root.iterdir():
        if entry != stage and not entry.is_symlink() and entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)


def runtime_versions() -> dict[str, str]:
    """Return the Python and package versions the run used, where installed."""
    from importlib import metadata  # noqa: PLC0415

    versions = {"python": ".".join(map(str, sys.version_info[:3]))}
    for name in ("numpy", "pcntoolkit"):
        try:
            versions[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            versions[name] = "unknown"
    return versions


# -- Entry point ------------------------------------------------------------------


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """Parse the adapter's fixed argv."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--features", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--model-archive", required=True)
    parser.add_argument("--site-list", required=True)
    parser.add_argument("--phenotype-list", action="append", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    return parser.parse_args(argv)


def run(args: argparse.Namespace, runtime: tuple[Any, Any, Any] | None = None) -> int:
    """Run the stage; ``runtime`` replaces the pcntoolkit import in tests."""
    work_dir = Path(args.work_dir)
    if work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True)
    isolate_runtime(work_dir)
    training_sites = read_list(args.site_list)
    phenotypes = phenotype_union([read_list(path) for path in args.phenotype_list])
    subjects = read_metadata(args.metadata)
    positions, rows = read_features(args.features, phenotypes)
    refusals = attach_features(subjects, phenotypes, positions, rows)
    for subject in subjects:
        if subject.subject in refusals:
            print(refusals[subject.subject], flush=True)
    usable = [subject for subject in subjects if subject.subject not in refusals]
    split = split_sites(usable, args.seed)
    for report in split.reports:
        if report.reason:
            print(report.reason, flush=True)
    if not split.sitenums:
        raise StageError(
            EXIT_NO_SITE,
            "No site has at least 2 controls, so the model cannot be adapted.",
        )
    runtime = runtime or load_runtime()
    z_scores = predict_zscores(
        split, phenotypes, Path(args.model_dir), training_sites, work_dir, runtime
    )
    run_record = {
        "schemaVersion": 1,
        "seed": args.seed,
        "adaptFraction": ADAPT_FRACTION,
        "designMatrix": {"basis": "bspline", "xmin": XMIN, "xmax": XMAX},
        "sitenums": split.sitenums,
        "siteTokens": {
            label: site_token(number) for label, number in split.sitenums.items()
        },
        "model": {
            "name": Path(args.model_dir).name,
            "archiveSha256": _sha256(Path(args.model_archive)),
        },
        "runtime": runtime_versions(),
        "counts": {
            "subjects": len(subjects),
            "zscores": len(split.test),
            "adaptation": len(split.adaptation),
            "refused": len(subjects) - len(split.test) - len(split.adaptation),
        },
        "upstream": {"repository": UPSTREAM_REPOSITORY, "commit": UPSTREAM_COMMIT},
    }
    out_dir = Path(args.out_dir)
    stage = create_generation(out_dir)
    try:
        write_outputs(
            stage,
            subjects,
            refusals,
            split,
            phenotypes,
            z_scores,
            run_record,
            runtime[0],
        )
        publish_generation(stage, out_dir)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    shutil.rmtree(work_dir, ignore_errors=True)
    print(
        f"Wrote z-scores for {len(split.test)} subjects in "
        f"{len(split.sitenums)} adapted site(s) to {out_dir}.",
        flush=True,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    """Run the stage and turn a stated failure into its exit code."""
    args = parse_args(argv)
    try:
        return run(args)
    except StageError as exc:
        print(str(exc), file=sys.stderr, flush=True)
        return exc.code


if __name__ == "__main__":
    raise SystemExit(main())
