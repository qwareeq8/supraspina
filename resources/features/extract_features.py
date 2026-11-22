#!/usr/bin/env python3
"""Build the PyBrainAge feature matrix from FreeSurfer Destrieux + aseg stats.

A first-party, argv-driven reimplementation of the upstream SCI_Map
``aparc_aseg_pybrain.sh`` step. Drive FreeSurfer's ``aparcstats2table`` for
each hemisphere and ``asegstats2table`` for the cohort. Assemble
``concatenated_results.csv`` as ``ID`` plus 187 features ordered to match
``rois_input_template.txt``. Accept all paths and options through argv.
Honor the configured parcellation, measure, and subject glob. Read subjects
from the canonical ``<derivatives>/freesurfer/<subject>`` layout. Preserve the
FreeSurfer implementations of the table tools.

Use the default ``aparc.a2009s`` thickness contract verified against FreeSurfer
8.2.0. Emit ``ID``, 75 ``lh_*`` Destrieux columns, 75 ``rh_*`` Destrieux
columns, and 37 ``aseg`` volumes for 188 columns total. Preserve FreeSurfer's
names, including ``lh_G_and_S_*`` and ``Left-Thalamus``. Let the PyBrainAge
prediction step apply the scaler's ``&`` and ``-Proper`` conventions. Select
the aseg block through an explicit allow-list. Exclude the trailing
``SegmentedTotalIntracranialVol`` added by FreeSurfer 8.2.0.
"""

from __future__ import annotations

import argparse
import csv
import glob
import os
import shutil
import stat
import subprocess
import sys

#: Drop these FreeSurfer cortical summaries by name across measures.
GLOBAL_DROP = frozenset({"BrainSegVolNotVent", "eTIV"})

#: Select these 37 aseg volumes in PyBrainAge template order. Preserve the names
#: emitted by FreeSurfer 8.2.0, and exclude ``SegmentedTotalIntracranialVol``.
ASEG_COLUMNS = (
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
    "SubCortGrayVol",
    "TotalGrayVol",
    "SupraTentorialVol",
    "SupraTentorialVolNotVent",
    "EstimatedTotalIntraCranialVol",
)

#: Order these 74 Destrieux cortical ROI base names by the PyBrainAge template.
#: Rebuild both hemisphere blocks by name to remain aligned with the scaler.
DESTRIEUX_REGIONS = (
    "G_and_S_frontomargin",
    "G_and_S_occipital_inf",
    "G_and_S_paracentral",
    "G_and_S_subcentral",
    "G_and_S_transv_frontopol",
    "G_and_S_cingul-Ant",
    "G_and_S_cingul-Mid-Ant",
    "G_and_S_cingul-Mid-Post",
    "G_cingul-Post-dorsal",
    "G_cingul-Post-ventral",
    "G_cuneus",
    "G_front_inf-Opercular",
    "G_front_inf-Orbital",
    "G_front_inf-Triangul",
    "G_front_middle",
    "G_front_sup",
    "G_Ins_lg_and_S_cent_ins",
    "G_insular_short",
    "G_occipital_middle",
    "G_occipital_sup",
    "G_oc-temp_lat-fusifor",
    "G_oc-temp_med-Lingual",
    "G_oc-temp_med-Parahip",
    "G_orbital",
    "G_pariet_inf-Angular",
    "G_pariet_inf-Supramar",
    "G_parietal_sup",
    "G_postcentral",
    "G_precentral",
    "G_precuneus",
    "G_rectus",
    "G_subcallosal",
    "G_temp_sup-G_T_transv",
    "G_temp_sup-Lateral",
    "G_temp_sup-Plan_polar",
    "G_temp_sup-Plan_tempo",
    "G_temporal_inf",
    "G_temporal_middle",
    "Lat_Fis-ant-Horizont",
    "Lat_Fis-ant-Vertical",
    "Lat_Fis-post",
    "Pole_occipital",
    "Pole_temporal",
    "S_calcarine",
    "S_central",
    "S_cingul-Marginalis",
    "S_circular_insula_ant",
    "S_circular_insula_inf",
    "S_circular_insula_sup",
    "S_collat_transv_ant",
    "S_collat_transv_post",
    "S_front_inf",
    "S_front_middle",
    "S_front_sup",
    "S_interm_prim-Jensen",
    "S_intrapariet_and_P_trans",
    "S_oc_middle_and_Lunatus",
    "S_oc_sup_and_transversal",
    "S_occipital_ant",
    "S_oc-temp_lat",
    "S_oc-temp_med_and_Lingual",
    "S_orbital_lateral",
    "S_orbital_med-olfact",
    "S_orbital-H_Shaped",
    "S_parieto_occipital",
    "S_pericallosal",
    "S_postcentral",
    "S_precentral-inf-part",
    "S_precentral-sup-part",
    "S_suborbital",
    "S_subparietal",
    "S_temporal_inf",
    "S_temporal_sup",
    "S_temporal_transverse",
)

#: Append the applicable FreeSurfer cortical summary for each hemisphere.
#: Treat ``volume`` as having no summary column.
CORTICAL_SUMMARY = {"thickness": "MeanThickness", "area": "WhiteSurfArea"}

#: Expect 187 features for the default thickness contract. Warn non-fatally for
#: a mismatch, and allow other measures to use their legitimate dimensions.
DEFAULT_FEATURE_COUNT = 187

#: Write the feature matrix under this age and PyBrainAge input filename.
OUTPUT_NAME = "concatenated_results.csv"

#: Keep these exit codes stable for the adapter's failure parser.
EXIT_NO_SUBJECTS = 2
EXIT_TOOL_MISSING = 3
EXIT_TOOL_FAILED = 4
EXIT_COLUMN_MISMATCH = 5

# Bound every materialized scientific input. The workflow's authoritative
# reconstruction view already limits the cohort to 5,000 subjects. Apply the
# same ceiling while enumerating candidates so a broad glob cannot allocate a
# larger path list before cohort filtering.
MAX_SUBJECTS = 5_000
MAX_GLOB_MATCHES = MAX_SUBJECTS
MAX_TABLE_BYTES = 64 * 1024 * 1024
MAX_TABLE_COLUMNS = 1_024
MAX_FIELD_BYTES = 1024 * 1024
csv.field_size_limit(MAX_FIELD_BYTES)


def _eprint(message: str) -> None:
    """Write a line to stderr (run-log channel, never the CSV)."""
    sys.stderr.write(f"{message}\n")


def discover_subjects(subjects_dir: str, pattern: str, parc: str) -> list[str]:
    """Return the sorted bare subject ids that carry the needed stats files.

    Include a subject only when both hemispheres' ``<parc>.stats`` files and
    ``aseg.stats`` exist.
    """
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
                    f"Limit feature extraction to at most {MAX_SUBJECTS} subjects."
                )
            found.append(os.path.basename(path))
    return found


def _resolve_tool(explicit: str | None, name: str) -> str:
    """Return an explicit tool path or resolve ``name`` on PATH; exit if absent."""
    if explicit:
        if not os.path.isfile(explicit):
            _eprint(f"Configure {name} at the regular file {explicit!r}.")
            raise SystemExit(EXIT_TOOL_MISSING)
        return explicit
    resolved = shutil.which(name)
    if resolved is None:
        _eprint(f"Source FreeSurfer or configure {name} on PATH.")
        raise SystemExit(EXIT_TOOL_MISSING)
    return resolved


def _run_table(argv: list[str], subjects_dir: str, label: str) -> None:
    """Run a FreeSurfer ``*stats2table`` command with ``SUBJECTS_DIR`` set."""
    env = dict(os.environ)
    env["SUBJECTS_DIR"] = subjects_dir
    proc = subprocess.run(  # noqa: S603 - argv is a fixed list, no shell
        argv,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()
        detail = tail[-1] if tail else f"exit {proc.returncode}"
        _eprint(f"Review the failed {label} call: {detail}.")
        raise SystemExit(EXIT_TOOL_FAILED)


def _read_table(path: str) -> tuple[list[str], dict[str, list[str]]]:
    """Read a tab-separated ``*stats2table`` file into ``(header, rows)``.

    Keep the subject-id label in the first header cell, and map each subject id
    to its ordered values without the id cell.
    """
    info = os.stat(path, follow_symlinks=True)
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_TABLE_BYTES:
        raise ValueError(
            f"Keep the generated table at or below {MAX_TABLE_BYTES} bytes."
        )
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle, delimiter="\t")
        header = next(reader, [])
        if len(header) > MAX_TABLE_COLUMNS:
            raise ValueError(
                f"Keep the generated table at or below {MAX_TABLE_COLUMNS} columns."
            )
        rows: dict[str, list[str]] = {}
        for index, record in enumerate(reader):
            if index >= MAX_SUBJECTS:
                raise ValueError(
                    f"Keep the generated table at or below {MAX_SUBJECTS} rows."
                )
            if len(record) > MAX_TABLE_COLUMNS:
                raise ValueError(
                    f"Keep the generated table at or below {MAX_TABLE_COLUMNS} columns."
                )
            if record:
                rows[record[0]] = record[1:]
    return header, rows


def _canonical_cortical_names(hemi: str, measure: str) -> list[str]:
    """Return the Destrieux cortical column names for a hemisphere, in order.

    Return 74 regional names plus the applicable summary, each prefixed by the
    hemisphere.
    """
    names = [f"{hemi}_{base}_{measure}" for base in DESTRIEUX_REGIONS]
    summary = CORTICAL_SUMMARY.get(measure)
    if summary is not None:
        names.append(f"{hemi}_{summary}_{measure}")
    return names


def _select_by_names(
    names: list[str], header: list[str], rows: dict[str, list[str]]
) -> dict[str, list[str]]:
    """Select ``names`` from a table by column name, preserving ``names`` order.

    Preserve each subject when a required name is absent. Emit a missing-column
    warning, and place an empty cell in the canonical output position so the
    downstream completeness check can fail safely.
    """
    index_of = {name: i for i, name in enumerate(header[1:])}
    missing = [name for name in names if name not in index_of]
    if missing:
        _eprint(f"Provide all required feature columns; missing: {', '.join(missing)}.")
    selected = [index_of.get(name) for name in names]
    return {
        subject: [
            cells[i] if i is not None and i < len(cells) else "" for i in selected
        ]
        for subject, cells in rows.items()
    }


def _fs_order_cortical(
    header: list[str], rows: dict[str, list[str]]
) -> tuple[list[str], dict[str, list[str]]]:
    """Select cortical columns in FreeSurfer output order (non-Destrieux atlases).

    Drop the id column and global summaries. Preserve FreeSurfer's output order
    when the Destrieux canonical order does not apply.
    """
    roi_cols = [
        index for index, name in enumerate(header[1:]) if name not in GLOBAL_DROP
    ]
    names = [header[1:][index] for index in roi_cols]
    return names, _select_by_names(names, header, rows)


def _cortical_block(
    hemi: str, measure: str, parc: str, header: list[str], rows: dict[str, list[str]]
) -> tuple[list[str], dict[str, list[str]]]:
    """Return ``(names, values_by_id)`` for one hemisphere's cortical ROIs.

    Rebuild the Destrieux block in canonical PyBrainAge order by name. Preserve
    FreeSurfer's output order for every other parcellation.
    """
    if parc == "aparc.a2009s":
        names = _canonical_cortical_names(hemi, measure)
        return names, _select_by_names(names, header, rows)
    return _fs_order_cortical(header, rows)


def _aseg_block(header: list[str], rows: dict[str, list[str]]) -> dict[str, list[str]]:
    """Select the 37 allow-listed aseg columns, in template order, by name.

    Expect ``Measure:volume`` in header cell zero and rows without the id cell.
    Map each subject id to 37 values in :data:`ASEG_COLUMNS` order, with an
    empty cell for a missing column instead of dropping the subject.
    """
    body = header[1:]
    index_of = {name: i for i, name in enumerate(body)}
    selected = [index_of.get(name) for name in ASEG_COLUMNS]
    out: dict[str, list[str]] = {}
    for subject, cells in rows.items():
        out[subject] = [
            cells[i] if i is not None and i < len(cells) else "" for i in selected
        ]
    return out


def build_matrix(args: argparse.Namespace) -> None:
    """Run the FreeSurfer tables and write ``concatenated_results.csv``."""
    subjects = discover_subjects(args.subjects_dir, args.subject_glob, args.parc)
    if not subjects:
        _eprint(
            f"Provide subjects matching {args.subject_glob!r} with "
            f"{args.parc} and aseg stats in {args.subjects_dir!r}."
        )
        raise SystemExit(EXIT_NO_SUBJECTS)
    _eprint(f"Process {len(subjects)} discovered subjects.")

    aparc_tool = _resolve_tool(args.aparcstats2table, "aparcstats2table")
    aseg_tool = _resolve_tool(args.asegstats2table, "asegstats2table")
    os.makedirs(args.out_dir, exist_ok=True)

    cortical_names: list[str] = []
    cortical_values: dict[str, list[str]] = {s: [] for s in subjects}
    for hemi in ("lh", "rh"):
        table = os.path.join(args.out_dir, f"{hemi}_{args.measure}.txt")
        argv = [
            aparc_tool,
            "--subjects",
            *subjects,
            "--hemi",
            hemi,
            "--parc",
            args.parc,
            "--measure",
            args.measure,
            "--tablefile",
            table,
            "--delimiter",
            "tab",
        ]
        if args.skip_missing:
            argv.append("--skip")
        _run_table(argv, args.subjects_dir, f"aparcstats2table {hemi}")
        header, rows = _read_table(table)
        names, values = _cortical_block(hemi, args.measure, args.parc, header, rows)
        cortical_names.extend(names)
        for subject in subjects:
            cortical_values[subject].extend(values.get(subject, [""] * len(names)))

    aseg_table = os.path.join(args.out_dir, "aseg_stats.txt")
    aseg_argv = [
        aseg_tool,
        "--subjects",
        *subjects,
        "--tablefile",
        aseg_table,
        "--delimiter",
        "tab",
    ]
    if args.skip_missing:
        aseg_argv.append("--skip")
    _run_table(aseg_argv, args.subjects_dir, "asegstats2table")
    aseg_header, aseg_rows = _read_table(aseg_table)
    aseg_values = _aseg_block(aseg_header, aseg_rows)

    feature_names = [*cortical_names, *ASEG_COLUMNS]
    _validate_count(args, len(feature_names))

    out_path = os.path.join(args.out_dir, OUTPUT_NAME)
    with open(out_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["ID", *feature_names])
        for subject in subjects:
            row = [
                subject,
                *cortical_values[subject],
                *aseg_values.get(subject, [""] * len(ASEG_COLUMNS)),
            ]
            writer.writerow(row)
    _eprint(
        f"Review {out_path} with {len(subjects)} rows and "
        f"{len(feature_names)} features."
    )


def _validate_count(args: argparse.Namespace, count: int) -> None:
    """Warn (non-fatally) when the default contract's feature count is off."""
    is_default = args.measure == "thickness" and args.parc == "aparc.a2009s"
    if is_default and count != DEFAULT_FEATURE_COUNT:
        _eprint(
            f"Provide {DEFAULT_FEATURE_COUNT} feature columns for the "
            f"aparc.a2009s thickness contract; found {count}."
        )


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """Parse the command-line arguments."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--subjects-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--parc", default="aparc.a2009s")
    parser.add_argument("--measure", default="thickness")
    parser.add_argument("--subject-glob", default="sub-*")
    parser.add_argument("--aparcstats2table", default=None)
    parser.add_argument("--asegstats2table", default=None)
    parser.add_argument("--skip-missing", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Build the feature matrix and return a process exit code."""
    args = parse_args(argv)
    build_matrix(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
