#!/usr/bin/env python3
"""Aggregate cohort-wide FreeSurfer structural stats for the Step 8 outputs.

A first-party, argv-driven reimplementation of the four upstream SCI_Map Step 8
Bash scripts (``DKstats.sh``, ``WM_Stats.sh``, ``extract_ICV.sh``, and
``extract_cortical_thickness.sh``). Read the canonical
``<derivatives>/freesurfer/<subject>`` layout. Parse existing ``*.stats`` files
with the standard library. Avoid requiring FreeSurfer tools or external Python
packages. Write the four cohort CSVs consumed by Step 9 and QC review.

Match the ``dk_all_stats.csv`` contract expected by
``FreesurferAnalysisScript.R`` with its default ``cortical_split`` of 613. Put
the subject id in column 1. Put 612 cortical metrics in columns 2 through 613.
Order 34 Desikan-Killiany ``aparc`` regions per hemisphere, left then right.
Emit the nine ``aparc.stats`` metrics for each region. Put subcortical ``aseg``
volumes in columns 614 and later. Preserve the split defined by
``1 + (34 + 34) * 9 == 613``.

Write these verified lowercase outputs:

- Write ``dk_all_stats.csv`` with the subject, 612 cortical metrics, and aseg volumes.
- Write ``cortical_thickness.csv`` with the subject and lh/rh mean thickness.
- Write ``icv_data.csv`` with the subject and eTIV.
- Write ``wm_volumes.csv`` with the subject, the three cerebral white-matter
  totals, and each ``wmparc`` structure volume.
"""

from __future__ import annotations

import argparse
import csv
import glob
import os
import stat
import sys

#: Preserve these per-region metrics in FreeSurfer ColHeaders order. Build the
#: 612-column cortical block expected by the Step 9 default split.
APARC_METRICS = (
    "NumVert",
    "SurfArea",
    "GrayVol",
    "ThickAvg",
    "ThickStd",
    "MeanCurv",
    "GausCurv",
    "FoldInd",
    "CurvInd",
)

#: Use the Desikan-Killiany parcellation for Steps 8 and 9.
DEFAULT_PARC = "aparc"

#: Keep these lowercase output filenames for Step 9 and QC review.
DK_ALL_STATS = "dk_all_stats.csv"
CORTICAL_THICKNESS = "cortical_thickness.csv"
ICV_DATA = "icv_data.csv"
WM_VOLUMES = "wm_volumes.csv"

#: Name the upstream ``WM_Stats.sh`` totals, in its column order, with the
#: ``wmparc.stats`` ``# Measure`` key each one reads.
WM_TOTALS = (
    ("TotalCerebralWM", "CerebralWhiteMatter"),
    ("RightCerebralWM", "rhCerebralWhiteMatter"),
    ("LeftCerebralWM", "lhCerebralWhiteMatter"),
)

#: Keep these exit codes stable for the adapter's failure parser.
EXIT_NO_SUBJECTS = 2
EXIT_PARSE_FAILED = 4

MAX_SUBJECTS = 5_000
MAX_GLOB_MATCHES = MAX_SUBJECTS
MAX_STATS_BYTES = 8 * 1024 * 1024
MAX_STATS_LINES = 100_000
MAX_STATS_FIELDS = 1_024
MAX_STATS_DATA_ROWS = 1_023
MAX_TABLE_COLUMNS = 1_024
# The Step 9 merge adds the Cohort, Sex, and Age metadata columns before its
# own 1024-column bound, so dk_all_stats.csv must leave that headroom or the
# final stage can never accept a table this stage published.
FINAL_MERGE_METADATA_COLUMNS = 3


def _eprint(message: str) -> None:
    """Write a progress/diagnostic line to stderr (never the CSV channel)."""
    sys.stderr.write(f"{message}\n")


def _bounded_lines(stats_path: str):
    """Yield bounded lines from one regular FreeSurfer stats file."""
    info = os.stat(stats_path, follow_symlinks=True)
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_STATS_BYTES:
        raise ValueError(
            f"Keep each FreeSurfer stats file at or below {MAX_STATS_BYTES} bytes."
        )
    with open(stats_path, encoding="utf-8") as handle:
        for index, line in enumerate(handle):
            if index >= MAX_STATS_LINES:
                raise ValueError(
                    f"Keep each FreeSurfer stats file below {MAX_STATS_LINES} lines."
                )
            yield line


def _data_rows(stats_path: str) -> list[list[str]]:
    """Return the whitespace-split non-comment data rows of a ``.stats`` file."""
    rows: list[list[str]] = []
    for line in _bounded_lines(stats_path):
        if line.startswith("#") or not line.strip():
            continue
        fields = line.split()
        if len(fields) > MAX_STATS_FIELDS:
            raise ValueError(
                f"Keep each stats row at or below {MAX_STATS_FIELDS} fields."
            )
        if len(rows) >= MAX_STATS_DATA_ROWS:
            raise ValueError(
                f"Keep each stats table within {MAX_STATS_DATA_ROWS} data rows."
            )
        rows.append(fields)
    return rows


def _measure_value(stats_path: str, key: str) -> str:
    """Return the value field of a ``# Measure <key>, ...`` header line.

    Parse FreeSurfer measure headers as
    ``# Measure <key>, <short>, <long>, <value>, <unit>``; the value is the
    fourth comma-separated field. Return an empty string when absent.
    """
    for line in _bounded_lines(stats_path):
        if line.startswith("# Measure") and key in line:
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 4:  # noqa: PLR2004 - measure header has >=5 fields
                return parts[3]
    return ""


def _measures_by_key(stats_path: str) -> dict[str, str]:
    """Map each ``# Measure <key>, ...`` header key to its value field.

    Match keys exactly, unlike ``_measure_value``: ``CerebralWhiteMatter`` is a
    substring of the ``lh`` and ``rh`` keys. Keep the first line of a repeated
    key and skip lines with fewer than four fields.
    """
    measures: dict[str, str] = {}
    for line in _bounded_lines(stats_path):
        if not line.startswith("# Measure "):
            continue
        parts = [p.strip() for p in line[len("# Measure ") :].split(",")]
        if len(parts) >= 4:  # noqa: PLR2004 - measure header has >=5 fields
            measures.setdefault(parts[0], parts[3])
    return measures


def discover_subjects(subjects_dir: str, pattern: str, parc: str) -> list[str]:
    """Return sorted subject ids carrying lh/rh ``<parc>.stats`` and ``aseg.stats``."""
    matches: list[str] = []
    for index, path in enumerate(glob.iglob(os.path.join(subjects_dir, pattern))):
        if index >= MAX_GLOB_MATCHES:
            raise ValueError(
                f"Narrow the subject glob to at most {MAX_GLOB_MATCHES} matches."
            )
        matches.append(path)
    found: list[str] = []
    for path in sorted(matches):
        if not os.path.isdir(path):
            continue
        stats = os.path.join(path, "stats")
        needed = (
            os.path.join(stats, f"lh.{parc}.stats"),
            os.path.join(stats, f"rh.{parc}.stats"),
            os.path.join(stats, "aseg.stats"),
        )
        if all(os.path.isfile(p) for p in needed):
            if len(found) >= MAX_SUBJECTS:
                raise ValueError(
                    f"Limit aggregation to at most {MAX_SUBJECTS} subjects."
                )
            found.append(os.path.basename(path))
    return found


def _aparc_region_order(stats_path: str) -> list[str]:
    """Return the cortical region names in this hemisphere's file order."""
    return [row[0] for row in _data_rows(stats_path)]


def _aparc_metrics_by_region(stats_path: str) -> dict[str, list[str]]:
    """Map each region to its nine metric values from one ``aparc.stats`` file."""
    out: dict[str, list[str]] = {}
    for row in _data_rows(stats_path):
        # Read StructName plus nine metrics, and ignore trailing fields.
        out[row[0]] = row[1 : 1 + len(APARC_METRICS)]
    return out


def _seg_volumes(stats_path: str) -> tuple[list[str], dict[str, str]]:
    """Return (ordered struct names, {struct: Volume_mm3}) from an aseg/wmparc file.

    Interpret ColHeaders as ``Index SegId NVoxels Volume_mm3 StructName ...``.
    Read volume from field 3 and the structure name from field 4.
    """
    names: list[str] = []
    volumes: dict[str, str] = {}
    for row in _data_rows(stats_path):
        if len(row) < 5:  # noqa: PLR2004 - need through StructName
            continue
        name = row[4]
        names.append(name)
        volumes[name] = row[3]
    return names, volumes


def _stats(subjects_dir: str, subject: str, name: str) -> str:
    """Return the path to a subject's ``stats/<name>`` file."""
    return os.path.join(subjects_dir, subject, "stats", name)


def _build_dk_all_stats(subjects_dir: str, subjects: list[str], parc: str) -> None:
    """Write ``dk_all_stats.csv`` for the cohort (the Step 9 input contract)."""
    first = subjects[0]
    lh_order = _aparc_region_order(_stats(subjects_dir, first, f"lh.{parc}.stats"))
    rh_order = _aparc_region_order(_stats(subjects_dir, first, f"rh.{parc}.stats"))
    aseg_order, _ = _seg_volumes(_stats(subjects_dir, first, "aseg.stats"))

    header = ["subject"]
    for hemi, regions in (("lh", lh_order), ("rh", rh_order)):
        for region in regions:
            header.extend(f"{hemi}_{region}_{metric}" for metric in APARC_METRICS)
    header.extend(aseg_order)
    limit = MAX_TABLE_COLUMNS - FINAL_MERGE_METADATA_COLUMNS
    if len(header) > limit:
        raise ValueError(
            f"Keep {DK_ALL_STATS} within {limit} columns so the final merge "
            f"stays within {MAX_TABLE_COLUMNS}."
        )

    out_path = os.path.join(_OUT_DIR, DK_ALL_STATS)
    with open(out_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        for subject in subjects:
            lh = _aparc_metrics_by_region(
                _stats(subjects_dir, subject, f"lh.{parc}.stats")
            )
            rh = _aparc_metrics_by_region(
                _stats(subjects_dir, subject, f"rh.{parc}.stats")
            )
            _, aseg = _seg_volumes(_stats(subjects_dir, subject, "aseg.stats"))
            row: list[str] = [subject]
            for region in lh_order:
                row.extend(_pad(lh.get(region), len(APARC_METRICS)))
            for region in rh_order:
                row.extend(_pad(rh.get(region), len(APARC_METRICS)))
            row.extend(aseg.get(name, "") for name in aseg_order)
            writer.writerow(row)
    _eprint(f"Review {out_path} with {len(subjects)} rows and {len(header)} columns.")


def _pad(values: list[str] | None, width: int) -> list[str]:
    """Return ``values`` padded/truncated to ``width`` (missing region -> blanks)."""
    if not values:
        return [""] * width
    return (values + [""] * width)[:width]


def _build_cortical_thickness(
    subjects_dir: str, subjects: list[str], parc: str
) -> None:
    """Write ``cortical_thickness.csv`` (subject + lh/rh mean cortical thickness)."""
    out_path = os.path.join(_OUT_DIR, CORTICAL_THICKNESS)
    with open(out_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["subject", "lh_mean_thickness", "rh_mean_thickness"])
        for subject in subjects:
            lh = _measure_value(
                _stats(subjects_dir, subject, f"lh.{parc}.stats"), "MeanThickness"
            )
            rh = _measure_value(
                _stats(subjects_dir, subject, f"rh.{parc}.stats"), "MeanThickness"
            )
            writer.writerow([subject, lh, rh])
    _eprint(f"Review {out_path} with {len(subjects)} rows.")


def _build_icv(subjects_dir: str, subjects: list[str]) -> None:
    """Write ``icv_data.csv`` (subject + estimated total intracranial volume)."""
    out_path = os.path.join(_OUT_DIR, ICV_DATA)
    with open(out_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["subject", "eTIV"])
        for subject in subjects:
            etiv = _measure_value(
                _stats(subjects_dir, subject, "aseg.stats"),
                "EstimatedTotalIntraCranialVol",
            )
            writer.writerow([subject, etiv])
    _eprint(f"Review {out_path} with {len(subjects)} rows.")


def _build_wm_volumes(subjects_dir: str, subjects: list[str]) -> None:
    """Write ``wm_volumes.csv`` (subject, WM totals, one column per structure).

    Follow upstream ``WM_Stats.sh``: the three ``WM_TOTALS`` from the
    ``# Measure`` header lines, then each ``wmparc`` structure volume. Leave a
    missing total or volume blank where upstream writes 0, since 0 would be a
    fabricated volume. Skip subjects without ``wmparc.stats``. Derive the
    structure header from the first subject that provides one. Always write the
    file, even with only its header, so the detector can report ``done``.
    """
    out_path = os.path.join(_OUT_DIR, WM_VOLUMES)
    structures: list[str] = []
    for subject in subjects:
        wmparc = _stats(subjects_dir, subject, "wmparc.stats")
        if os.path.isfile(wmparc):
            structures, _ = _seg_volumes(wmparc)
            break

    header = ["subject", *(column for column, _ in WM_TOTALS), *structures]
    if len(header) > MAX_TABLE_COLUMNS:
        raise ValueError(f"Keep {WM_VOLUMES} within {MAX_TABLE_COLUMNS} columns.")
    written = 0
    with open(out_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        for subject in subjects:
            wmparc = _stats(subjects_dir, subject, "wmparc.stats")
            if not os.path.isfile(wmparc):
                continue
            measures = _measures_by_key(wmparc)
            _, volumes = _seg_volumes(wmparc)
            writer.writerow(
                [
                    subject,
                    *(measures.get(key, "") for _, key in WM_TOTALS),
                    *(volumes.get(name, "") for name in structures),
                ]
            )
            written += 1
    _eprint(f"Review {out_path} with {written} rows and {len(structures)} structures.")


# Set the module-level output directory in ``main`` to keep builders focused.
_OUT_DIR = ""


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """Parse the command-line arguments."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--subjects-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--parc", default=DEFAULT_PARC)
    parser.add_argument("--subject-glob", default="sub-*")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Aggregate the cohort structural stats into the four Step 8 CSVs."""
    global _OUT_DIR  # noqa: PLW0603 - module-level output dir set once per run
    args = parse_args(argv)
    subjects = discover_subjects(args.subjects_dir, args.subject_glob, args.parc)
    if not subjects:
        _eprint(
            f"Provide subjects matching {args.subject_glob!r} with lh/rh "
            f"{args.parc}.stats and aseg.stats in {args.subjects_dir!r}."
        )
        return EXIT_NO_SUBJECTS
    _eprint(f"Process {len(subjects)} discovered subjects.")

    os.makedirs(args.out_dir, exist_ok=True)
    _OUT_DIR = args.out_dir
    try:
        _build_dk_all_stats(args.subjects_dir, subjects, args.parc)
        _build_cortical_thickness(args.subjects_dir, subjects, args.parc)
        _build_icv(args.subjects_dir, subjects)
        _build_wm_volumes(args.subjects_dir, subjects)
    except (OSError, ValueError, IndexError) as exc:
        _eprint(f"Review the aggregation failure: {exc}.")
        return EXIT_PARSE_FAILED
    return 0


if __name__ == "__main__":
    sys.exit(main())
