"""Adapter for the clinical metadata merge (pipeline step ``clinical``).

The stage reproduces the pinned upstream Step 6 manual merge into
``Template_Analysis.xlsx``. It joins ``predicted_results.csv`` with
subject-level clinical metadata and writes the Template_Analysis-structured
``predicted_results.xlsx`` workbook, which the downstream ``brainpadstats.py``
statistics script reads with ``pd.read_excel``. The workbook carries exactly
these columns: ``Subject_ID``,
``Age``, ``Sex`` (``Male``/``Female``), ``Cohort`` (``control``/``SCI_nNP``/
``SCI_P``), ``BrainAge``, ``BrainPAD``, ``AIS`` (``A``/``B``/``C``/``D``), and
``Time since SCI (years)``. Time-since-SCI is optional by default, and its
output column survives with empty values when the input is absent.

The merge is automated as a real ``pandas`` + ``openpyxl`` transform. The
adapter builds a ``python -c`` invocation with the shared analysis interpreter
selected by the resolver used for Steps 5 through 7, and passes the predictions
CSV, clinical metadata CSV, output workbook path, and join/column parameters
through ``argv``. All configured paths resolve before the command is built.
"""

from __future__ import annotations

import os
import stat
import struct
from collections.abc import Callable
from typing import Any
from zipfile import BadZipFile, ZipFile

from . import tools
from .analysis_python import resolve_analysis_interpreter
from .base import Adapter, Failure, StepStatus, Validation, register

# Read Step 5 PyBrainAge predictions relative to the run output directory.
PREDICTIONS_REL = "pybrainage/predicted_results.csv"
# Write this step's workbook with the Template_Analysis structure.
WORKBOOK_REL = "analysis/predicted_results.xlsx"
DEFAULT_REQUIRED_COLUMNS = "Cohort,AIS"
#: Preserve the unused positional cohort-label argument for stable argv arity.
_COHORT_LABELS_PLACEHOLDER = "control,SCI_nNP,SCI_P"

# Require these Template_Analysis columns for ``brainpadstats.py``.
TEMPLATE_COLUMNS: tuple[str, ...] = (
    "Subject_ID",
    "Age",
    "Sex",
    "Cohort",
    "BrainAge",
    "BrainPAD",
    "AIS",
    "Time since SCI (years)",
)

# Run this pandas + openpyxl transform with the shared analysis interpreter.
# Read both input CSV files, enforce required clinical columns, and LEFT-join on
# the configured key so unmatched subjects surface as NaN instead of vanishing.
# Emit pre/post-merge counts to stderr, project the Template_Analysis columns,
# and write the .xlsx workbook. Read paths and parameters from sys.argv. Reserve
# argv[5] for cohort_labels, and read comma-separated required columns from
# argv[6].
_TRANSFORM = r"""
import csv
import os
import stat
import sys
import pandas as pd

pred_csv, clin_csv, out_xlsx, join_key = sys.argv[1:5]
# Strip each configured name so this transform and the completion detector
# parse one requiredColumns value identically.
required = [
    c.strip()
    for c in (sys.argv[6].split(',') if len(sys.argv) > 6 else [])
    if c.strip()
]

MAX_BYTES = 64 * 1024 * 1024
MAX_ROWS = 5000
MAX_COLUMNS = 1024
csv.field_size_limit(1024 * 1024)

def read_bounded_csv(path):
    info = os.stat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
        raise ValueError('Keep each clinical-merge CSV within 64 MiB.')
    with open(path, newline='', encoding='utf-8-sig') as handle:
        header = next(csv.reader(handle), [])
    if len(header) > MAX_COLUMNS:
        raise ValueError('Keep each clinical-merge CSV within 1024 columns.')
    frame = pd.read_csv(path, nrows=MAX_ROWS + 1)
    if len(frame) > MAX_ROWS:
        raise ValueError('Keep the clinical merge within 5000 rows.')
    return frame

pred = read_bounded_csv(pred_csv).rename(columns={'ID': join_key})
clin = read_bounded_csv(clin_csv)
if pred[join_key].duplicated().any():
    raise ValueError('Provide unique subject ids in predicted_results.csv.')
if clin[join_key].duplicated().any():
    raise ValueError('Provide unique subject ids in the clinical metadata CSV.')

missing_required = [c for c in required if c not in clin.columns]
if missing_required:
    sys.stderr.write(
        'required clinical column missing: ' + ', '.join(missing_required) + '\n'
    )
    sys.exit(3)

merged = pred.merge(clin, on=join_key, how='left', suffixes=('', '_clin'))
if len(merged) > MAX_ROWS or len(merged.columns) > MAX_COLUMNS:
    raise ValueError('Keep the clinical merge within 5000 rows and 1024 columns.')
unmatched_mask = ~pred[join_key].isin(clin[join_key])
unmatched = pred.loc[unmatched_mask, join_key].astype(str).tolist()
sys.stderr.write(
    'clinical-merge: %d predictions, %d matched, %d unmatched: %s\n'
    % (len(pred), len(pred) - len(unmatched), len(unmatched), unmatched)
)

cols = ['Subject_ID', 'Age', 'Sex', 'Cohort', 'BrainAge', 'BrainPAD', 'AIS',
        'Time since SCI (years)']
# Name every analysis column the metadata never supplied. Reindex writes those
# columns empty, and an empty column silently empties the comparisons that read
# it: a workbook without Sex produces a sex analysis of n=0 for every group.
absent = [c for c in cols if c not in merged.columns or merged[c].isna().all()]
if absent:
    sys.stderr.write(
        'clinical-merge: no value for ' + ', '.join(absent)
        + '; every analysis that reads these columns will be empty.\n'
    )
merged['Subject_ID'] = merged.get('Subject_ID', merged[join_key])
os.makedirs(os.path.dirname(out_xlsx) or '.', exist_ok=True)
merged.reindex(columns=cols).to_excel(out_xlsx, index=False, engine='openpyxl')
"""

MAX_WORKBOOK_BYTES = 64 * 1024 * 1024
MAX_COHORT_ROWS = 5_000
MAX_TABLE_COLUMNS = 1_024
MAX_XLSX_MEMBERS = 1_024
MAX_XLSX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_XLSX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_XLSX_COMPRESSION_RATIO = 100

_ZIP_EOCD = struct.Struct("<4s4H2LH")
_ZIP_EOCD_SIGNATURE = b"PK\x05\x06"
_ZIP_EOCD_SEARCH = 65_535 + _ZIP_EOCD.size
_ZIP16_SENTINEL = 0xFFFF
_ZIP32_SENTINEL = 0xFFFFFFFF


class ClinicalAdapter(Adapter):
    """Merge brain-age predictions with clinical metadata into the workbook.

    Run a real ``pandas`` + ``openpyxl`` transform. Read
    ``predicted_results.csv`` and the clinical metadata CSV. Write the
    Template_Analysis workbook ``predicted_results.xlsx`` consumed by Step 7.
    Select the shared analysis interpreter from configured, step-specific,
    provisioned, and PATH candidates.
    """

    key = "clinical"
    name = "Clinical merge"
    goal = (
        "Merge BrainAge predictions with clinical metadata into the analysis workbook."
    )
    advances = ("stats",)
    required_checks = ("clinicalpython",)

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the editable parameter schema for the clinical merge.

        Expose only parameters meaningful for the pandas transform. Mirror the
        ``steps.ts`` defaults exactly.
        """
        return {
            "joinKey": {
                "kind": "text",
                "default": "participant_id",
                "label": "Join key",
            },
            "requiredColumns": {
                "kind": "text",
                "default": DEFAULT_REQUIRED_COLUMNS,
                "label": "Required clinical columns",
            },
        }

    def _predictions_csv(self, cfg: dict[str, Any]) -> str:
        """Resolve the Step 5 predictions CSV path."""
        return self.resolve(f"${{paths.outputDir}}/{PREDICTIONS_REL}", cfg)

    def _clinical_csv(self, cfg: dict[str, Any]) -> str:
        """Resolve the clinical metadata CSV path."""
        runtime = cfg.get("_supraspinaRuntime", {})
        projected = (
            runtime.get("clinicalMetadataFile") if isinstance(runtime, dict) else None
        )
        if isinstance(projected, str) and projected:
            return projected
        return self.resolve("${paths.clinicalMetadataFile}", cfg)

    def _workbook(self, cfg: dict[str, Any]) -> str:
        """Resolve the output analysis workbook path."""
        return self.resolve(f"${{paths.outputDir}}/{WORKBOOK_REL}", cfg)

    def validate(self, cfg: dict[str, Any], env: dict[str, Any]) -> Validation:
        """Block the plan when the operator's clinical CSV is not on disk.

        Check the configured source file, not the run-scoped projection, which
        exists only after launch. Otherwise a missing source would fail at
        launch with an exit code and no usable reason.
        """
        validation = super().validate(cfg, env)
        source = self.resolve("${paths.clinicalMetadataFile}", cfg)
        if not os.path.isfile(source):
            validation.blocking.append(
                f"Provide the clinical metadata CSV at {source} with the "
                "participant_id, Cohort, and AIS columns."
            )
        return validation

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the argv for the clinical merge.

        Invoke the shared analysis interpreter on the inline ``pandas`` +
        ``openpyxl`` transform. Pass the predictions CSV, clinical metadata CSV,
        output workbook, join key, reserved cohort labels, and required-columns
        list as positional arguments. Ignore ``subject_id`` because this step is
        cohort-wide.

        Parameters
        ----------
        subject_id
            Ignore the value because the merge runs once over the whole cohort.
        """
        params = self.params(cfg)
        join_key = str(params.get("joinKey", "participant_id"))
        required_columns = str(params.get("requiredColumns", DEFAULT_REQUIRED_COLUMNS))
        python = resolve_analysis_interpreter(cfg)
        return [
            python,
            "-c",
            _TRANSFORM,
            self._predictions_csv(cfg),
            self._clinical_csv(cfg),
            self._workbook(cfg),
            join_key,
            _COHORT_LABELS_PLACEHOLDER,
            required_columns,
        ]

    def members(self, cfg: dict[str, Any]) -> frozenset[str] | None:
        """Return the ``ID`` set of the prediction table the merge consumes.

        The workbook this step writes carries the prediction rows one for one,
        so the CSV input names the same cohort without opening the workbook.
        """
        out_dir = self.resolve("${paths.outputDir}", cfg)
        return tools.read_csv_member_ids(os.path.join(out_dir, PREDICTIONS_REL), "ID")

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        """Detect completion from the analysis workbook on disk.

        Report ``done`` when the Template_Analysis workbook exists, is non-empty,
        carries every required column, and contains a value in each configured
        required column. Report ``partial`` when the workbook is unreadable or
        violates that contract. Report ``failed`` when the workbook loader is
        unavailable, and report ``pending`` when the workbook is absent. Inspect
        all rows to validate required-column contents.

        Parameters
        ----------
        subject_id
            Ignore the value because the workbook is cohort-wide.

        Returns
        -------
        StepStatus
            Return the detected state with the workbook artifact path.
        """
        workbook = self._workbook(cfg)
        if not tools.file_nonempty(workbook):
            return StepStatus(state="pending", detail="Create the analysis workbook.")
        required = [
            column.strip()
            for column in str(self.params(cfg).get("requiredColumns", "")).split(",")
            if column.strip()
        ]
        inspected = inspect_workbook(workbook, required)
        inspected.artifacts = [workbook]
        return inspected

    def parse_failure(self, rc: int, stdout: str, stderr: str) -> Failure | None:
        """Map a non-zero exit into a structured clinical-merge failure.

        Recognize the real pandas signatures: a missing input file, a missing
        join key or required column, and an absent ``openpyxl`` engine. Fall
        back to the generic classification for anything else.

        Returns
        -------
        Failure or None
            Return the structured failure or ``None`` when ``rc`` is zero.
        """
        if rc == 0:
            return None
        blob = f"{stderr}\n{stdout}"
        # Match ordered (needles, tag, message) signatures, with specific cases
        # before general ones. Place ``missing_output_dir`` before
        # ``missing_engine`` because a missing-directory traceback also names
        # the openpyxl IO path. Match the exact openpyxl import error so an
        # unrelated pandas IO error is not mistagged.
        signatures: tuple[tuple[tuple[str, ...], str, str], ...] = (
            (
                ("within 64 MiB", "within 5000 rows", "within 1024 columns"),
                "input_bounds",
                "Keep each Clinical-stage table within its documented bounds.",
            ),
            (
                ("required clinical column missing",),
                "missing_required_column",
                "Add every required clinical column to the metadata.",
            ),
            (
                ("FileNotFoundError", "No such file or directory"),
                "missing_input",
                "Provide the predictions and clinical CSV files.",
            ),
            (
                ("non-existent directory",),
                "missing_output_dir",
                "Create the analysis output directory.",
            ),
            (
                ("No module named 'openpyxl'",),
                "missing_engine",
                "Install openpyxl in the analysis environment.",
            ),
            (
                ("KeyError", "not in index", "MergeError"),
                "schema_mismatch",
                "Add the join key and every required column.",
            ),
        )
        for needles, tag, message in signatures:
            if any(needle in blob for needle in needles):
                return Failure(rc, tag, message)
        return super().parse_failure(rc, stdout, stderr)


def _xlsx_member_count(path: str) -> int:
    """Read the EOCD member count before ZipFile allocates its index."""
    size = os.path.getsize(path)
    with open(path, "rb") as handle:
        handle.seek(max(0, size - _ZIP_EOCD_SEARCH))
        tail = handle.read(_ZIP_EOCD_SEARCH)
    offset = tail.rfind(_ZIP_EOCD_SIGNATURE)
    if offset < 0 or offset + _ZIP_EOCD.size > len(tail):
        raise ValueError("Repair the unreadable XLSX workbook.")
    fields = _ZIP_EOCD.unpack_from(tail, offset)
    (
        _,
        disk,
        central_disk,
        disk_entries,
        entries,
        central_size,
        central_offset,
        comment_size,
    ) = fields
    if offset + _ZIP_EOCD.size + comment_size != len(tail):
        raise ValueError("Remove trailing data from the XLSX workbook.")
    if disk != 0 or central_disk != 0 or disk_entries != entries:
        raise ValueError("Provide a single-disk XLSX workbook.")
    if entries == _ZIP16_SENTINEL or _ZIP32_SENTINEL in (central_size, central_offset):
        raise ValueError("Provide an XLSX workbook that does not require ZIP64.")
    eocd_offset = size - len(tail) + offset
    if central_offset + central_size > eocd_offset:
        raise ValueError("Repair the invalid XLSX central directory.")
    if entries > MAX_XLSX_MEMBERS:
        raise ValueError(f"Keep the XLSX workbook within {MAX_XLSX_MEMBERS} members.")
    return entries


#: The cohort label the run-scoped projection writes for healthy controls.
_CONTROL_COHORT = "control"


def _cell_populated(row: tuple[Any, ...], index: int) -> bool:
    """Report whether one row carries a non-blank value at ``index``."""
    return index < len(row) and row[index] is not None and str(row[index]).strip() != ""


def _validate_xlsx_archive(path: str) -> None:
    """Bound the XLSX archive before OpenPyXL materializes workbook XML."""
    info = os.stat(path, follow_symlinks=True)
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_WORKBOOK_BYTES:
        raise ValueError("Keep the XLSX workbook within 64 MiB.")
    expected_members = _xlsx_member_count(path)
    try:
        with ZipFile(path) as archive:
            members = archive.infolist()
            if len(members) != expected_members:
                raise ValueError("Repair the inconsistent XLSX archive index.")
            names: set[str] = set()
            expanded = 0
            for member in members:
                if member.filename in names:
                    raise ValueError("Remove duplicate XLSX archive members.")
                names.add(member.filename)
                if member.flag_bits & 0x1:
                    raise ValueError("Provide an unencrypted XLSX workbook.")
                if member.file_size > MAX_XLSX_MEMBER_BYTES:
                    raise ValueError("Keep each expanded XLSX member within 64 MiB.")
                expanded += member.file_size
                if expanded > MAX_XLSX_EXPANDED_BYTES:
                    raise ValueError("Keep expanded XLSX content within 256 MiB.")
                if member.file_size and (
                    member.compress_size == 0
                    or member.file_size / member.compress_size
                    > MAX_XLSX_COMPRESSION_RATIO
                ):
                    raise ValueError(
                        "Keep each XLSX member compression ratio at or below "
                        f"{MAX_XLSX_COMPRESSION_RATIO}."
                    )
    except BadZipFile as exc:
        raise ValueError("Repair the unreadable XLSX workbook.") from exc


WorkbookLoader = Callable[..., Any]


def _openpyxl_loader() -> WorkbookLoader:
    """Resolve the shipped workbook loader or fail with a distinct condition."""
    from openpyxl import load_workbook  # noqa: PLC0415

    return load_workbook


def inspect_workbook(  # noqa: PLR0911, PLR0912 - report each workbook remedy
    workbook: str,
    required: list[str],
    *,
    loader: WorkbookLoader | None = None,
    loader_factory: Callable[[], WorkbookLoader] | None = None,
) -> StepStatus:
    """Validate one Clinical workbook without conflating dependency failures.

    Use the optional loader as a test seam for the exact packaged runtime
    contract. Prove fail-closed behavior when the bundled dependency is absent.
    Resolve :mod:`openpyxl` from the frozen sidecar in production.
    """
    if loader is not None and loader_factory is not None:
        raise ValueError("Provide either loader or loader_factory.")
    if loader is None:
        try:
            loader = (loader_factory or _openpyxl_loader)()
        except ModuleNotFoundError:
            return StepStatus(
                state="failed",
                detail="Install the openpyxl runtime dependency.",
            )
    try:
        _validate_xlsx_archive(workbook)
    except (OSError, ValueError) as exc:
        return StepStatus(
            state="partial",
            detail=str(exc),
        )
    try:
        book = loader(workbook, read_only=True)
    except Exception:
        return StepStatus(
            state="partial",
            detail="Repair the unreadable XLSX workbook.",
        )
    try:
        sheet = book.active
        if sheet.max_row > MAX_COHORT_ROWS + 1 or sheet.max_column > MAX_TABLE_COLUMNS:
            return StepStatus(
                state="partial",
                detail="Keep the workbook within 5000 rows and 1024 columns.",
            )
        rows = sheet.iter_rows(min_row=1, values_only=True)
        header_row = next(rows, ())
        header = [str(cell) if cell is not None else "" for cell in header_row]
        missing = [column for column in TEMPLATE_COLUMNS if column not in header]
        if missing:
            return StepStatus(
                state="partial",
                detail=f"Add the missing workbook columns: {', '.join(missing)}.",
            )
        populated = {column: False for column in required if column in header}
        indices = {column: header.index(column) for column in populated}
        cohort_index = header.index("Cohort") if "Cohort" in header else None
        # An AIS grade belongs to SCI rows only; a control row may leave it
        # blank. Count AIS as populated when every row that needs a grade
        # carries one, including the case where no row needs one.
        ais_needed = False
        ais_missing = False
        for row_index, row in enumerate(rows):
            if row_index >= MAX_COHORT_ROWS:
                return StepStatus(
                    state="partial",
                    detail="Keep the workbook within 5000 rows and 1024 columns.",
                )
            for column, index in indices.items():
                if _cell_populated(row, index):
                    populated[column] = True
            if "AIS" in indices and cohort_index is not None:
                cohort = (
                    str(row[cohort_index]).strip().lower()
                    if _cell_populated(row, cohort_index)
                    else ""
                )
                if cohort and cohort != _CONTROL_COHORT:
                    ais_needed = True
                    if not _cell_populated(row, indices["AIS"]):
                        ais_missing = True
        if "AIS" in populated and cohort_index is not None:
            populated["AIS"] = not ais_missing and (populated["AIS"] or not ais_needed)
    except Exception:
        return StepStatus(
            state="partial",
            detail="Repair the unreadable XLSX workbook.",
        )
    finally:
        book.close()
    empty = [column for column, has_value in populated.items() if not has_value]
    if empty:
        return StepStatus(
            state="partial",
            detail=f"Populate the required workbook columns: {', '.join(empty)}.",
        )
    return StepStatus(state="done", detail="The workbook is complete.")


register(ClinicalAdapter())
