"""Adapter for Step 4 age metadata integration (``age``).

The stage reproduces the pinned upstream Step 4 manual edit: open the Step 3
feature table (``concatenated_results.csv``), insert chronological age as the
second column immediately after ``ID``, and save the result as
``subject_features.csv`` with
the structure ``ID,Age,feature1..feature187`` (the 189-column PyBrainAge input
contract). The adapter automates that edit as a real ``pandas`` CSV transform,
joining an age metadata CSV onto the feature table by subject id and writing
``subject_features.csv``.

The transform itself is the tool; no external tool is wrapped. The adapter
builds argv that runs the selected analysis interpreter on
a self-contained ``pandas`` script (passed with ``python -c``) and injects the
two input paths, the output path, and the join parameters as positional
arguments. The real pipeline's placeholder templates resolve from the project
configuration supplied by the GUI.
"""

from __future__ import annotations

import csv
import math
import os
import stat
from collections.abc import Iterator
from typing import Any

from . import tools
from .analysis_python import resolve_analysis_interpreter
from .base import Adapter, Failure, StepStatus, Validation, register

# Run this inline pandas transform with the selected analysis interpreter.
# Mirror the manual Step 4 edit by joining the age metadata onto the Step 3
# feature table by subject id and emitting ``ID,Age,feature1..187`` with age as
# the second column. The output header must spell ``Age`` exactly because the
# bundled ``predict.py`` compares it case-sensitively against the pinned
# template. Pass features_csv, age_csv, out_csv, subject_id_column,
# age_column, join, and warn_on_missing ("1"/"0") after ``-c SCRIPT``.
_TRANSFORM = r"""
import csv
import os
import stat
import sys
import pandas as pd

features_csv, age_csv, out_csv = sys.argv[1], sys.argv[2], sys.argv[3]
id_col, age_col, how, warn = sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7]

MAX_BYTES = 64 * 1024 * 1024
MAX_ROWS = 5000
MAX_COLUMNS = 1024
csv.field_size_limit(1024 * 1024)

def read_bounded_csv(path):
    info = os.stat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
        raise ValueError('Keep each age-merge CSV within 64 MiB.')
    with open(path, newline='', encoding='utf-8-sig') as handle:
        header = next(csv.reader(handle), [])
    if len(header) > MAX_COLUMNS:
        raise ValueError('Keep each age-merge CSV within 1024 columns.')
    frame = pd.read_csv(path, nrows=MAX_ROWS + 1)
    if len(frame) > MAX_ROWS:
        raise ValueError('Keep the age merge within 5000 rows.')
    return frame

features = read_bounded_csv(features_csv)
ages = read_bounded_csv(age_csv)
key = features.columns[0]
if features[key].duplicated().any():
    raise ValueError('Provide unique subject ids in the feature CSV.')
if ages[id_col].duplicated().any():
    raise ValueError('Provide unique subject ids in the age metadata CSV.')
ages = ages.rename(columns={id_col: key, age_col: "Age"})
merged = features.merge(ages[[key, "Age"]], on=key, how=how)
if len(merged) > MAX_ROWS or len(merged.columns) > MAX_COLUMNS:
    raise ValueError('Keep the merged age table within 5000 rows and 1024 columns.')
with_age = int(merged["Age"].notna().sum())
sys.stderr.write(
    "age-merge: %d feature rows, %d merged rows, %d with age\n"
    % (len(features), len(merged), with_age)
)
if warn == "1" and merged["Age"].isna().any():
    missing = merged.loc[merged["Age"].isna(), key].astype(str).tolist()
    sys.stderr.write("WARNING: Provide age metadata for " + ", ".join(missing) + ".\n")
cols = [key, "Age"] + [c for c in features.columns if c != key]
os.makedirs(os.path.dirname(out_csv) or '.', exist_ok=True)
merged[cols].to_csv(out_csv, index=False)
"""

MAX_TABLE_BYTES = 64 * 1024 * 1024
MAX_COHORT_ROWS = 5_000
MAX_TABLE_COLUMNS = 1_024
MAX_FIELD_BYTES = 1024 * 1024
#: Most subjects the unknown-age completion detail lists by ID.
MAX_LISTED_IDS = 20


class AgeAdapter(Adapter):
    """Insert chronological age as column 2 to form the model-ready table.

    Join an age metadata CSV onto the Step 3 feature table
    (``concatenated_results.csv``) on the subject id column. Write
    ``subject_features.csv`` with age as the second column to satisfy the
    189-column PyBrainAge input contract (``ID,Age,feature1..187``).
    """

    key = "age"
    name = "Age metadata integration"
    goal = "Insert chronological age as column 2 to produce the model-ready table."
    advances = ("feat",)
    required_checks = ("agepython",)

    features_template = "${paths.outputDir}/features/concatenated_results.csv"
    age_metadata_template = "${paths.ageMetadataFile}"
    output_template = "${paths.outputDir}/features/subject_features.csv"

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the editable parameter schema for the age step.

        Mirror the ``steps.age.params`` contract in ``steps.ts``. Expose the
        metadata column names, join strategy, and missing-age warning toggle.
        Keep every parameter because the pure ``pandas`` transform supports it
        without tool-version gating.
        """
        return {
            "subjectIdColumn": {
                "kind": "text",
                "default": "participant_id",
                "label": "Subject id column",
            },
            "ageColumn": {
                "kind": "text",
                "default": "age",
                "label": "Age column",
            },
            "join": {
                "kind": "choice",
                "default": "left",
                "options": ["inner", "left", "outer"],
                "label": "Join strategy (left keeps unmatched subjects as NaN age)",
            },
            "warnOnMissing": {
                "kind": "bool",
                "default": True,
                "label": "Warn on missing age",
            },
        }

    def validate(self, cfg: dict[str, Any], env: dict[str, Any]) -> Validation:
        """Block the plan when the operator's age CSV is not on disk."""
        validation = super().validate(cfg, env)
        source = self.resolve(self.age_metadata_template, cfg)
        if not os.path.isfile(source):
            validation.blocking.append(
                f"Provide the age metadata CSV at {source} with the configured "
                "subject-ID and age columns."
            )
        return validation

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the argv that runs the ``pandas`` age-join transform.

        Parameters
        ----------
        subject_id
            Ignore this value because Step 4 transforms the whole cohort table.

        Returns
        -------
        list of str
            Return the argument vector that spawns the selected interpreter on
            the inline transform with the resolved paths and join parameters.
        """
        params = self.params(cfg)
        schema = self.param_schema()
        python = resolve_analysis_interpreter(cfg)
        features_csv = self.resolve(self.features_template, cfg)
        age_csv = self.resolve(self.age_metadata_template, cfg)
        out_csv = self.resolve(self.output_template, cfg)
        subject_id_column = str(
            params.get("subjectIdColumn", schema["subjectIdColumn"]["default"]),
        )
        age_column = str(params.get("ageColumn", schema["ageColumn"]["default"]))
        join = str(params.get("join", schema["join"]["default"]))
        warn = bool(params.get("warnOnMissing", schema["warnOnMissing"]["default"]))
        return [
            python,
            "-c",
            _TRANSFORM,
            features_csv,
            age_csv,
            out_csv,
            subject_id_column,
            age_column,
            join,
            "1" if warn else "0",
        ]

    def members(self, cfg: dict[str, Any]) -> frozenset[str] | None:
        """Return the ``ID`` set of ``subject_features.csv``."""
        return tools.read_csv_member_ids(self.resolve(self.output_template, cfg), "ID")

    @staticmethod
    def _scan_age_rows(
        reader: Iterator[list[str]],
    ) -> tuple[str | None, int, list[str]]:
        """Scan the data rows for bounds, age cells, and unknown ages.

        Parameters
        ----------
        reader
            Provide the CSV reader positioned after the header row.

        Returns
        -------
        tuple
            Return the first invalid-row remedy or ``None``, the scanned row
            count, and the ordered subjects whose age cell is empty.
        """
        rows = 0
        unknown_age: list[str] = []
        for row_index, row in enumerate(reader):
            if row_index >= MAX_COHORT_ROWS:
                return "Keep subject_features.csv within 5000 rows.", rows, unknown_age
            if len(row) > MAX_TABLE_COLUMNS:
                return (
                    "Keep subject_features.csv within 1024 columns.",
                    rows,
                    unknown_age,
                )
            if len(row) < 2:  # noqa: PLR2004
                return "Provide an age value in every row.", rows, unknown_age
            rows += 1
            if not row[1].strip():
                unknown_age.append(row[0].strip())
                continue
            try:
                age = float(row[1])
            except ValueError:
                age = math.nan
            if not math.isfinite(age):
                return (
                    "Provide one finite chronological age in years per row.",
                    rows,
                    unknown_age,
                )
        return None, rows, unknown_age

    def detect(  # noqa: PLR0911 - each invalid artifact contract returns its remedy
        self, cfg: dict[str, Any], subject_id: str | None
    ) -> StepStatus:
        """Detect completion from the real ``subject_features.csv`` artifact.

        Report ``done`` when ``subject_features.csv`` exists with a header
        whose second column is ``Age`` compared case-insensitively, so tables
        written before the exact-case contract stay valid, and at least one
        data row carries an age. A row whose age cell is empty keeps its
        brain-age prediction downstream, so name those subjects in the detail
        instead of blocking the cohort. Report ``partial`` for a present file
        whose ages are all empty or whose supplied age is not a finite number
        of years, and report ``pending`` for an absent or empty file.

        Parameters
        ----------
        subject_id
            Ignore this value because the output is one cohort-wide table.

        Returns
        -------
        StepStatus
            Return the detected state with the real artifact path when present.
        """
        out_csv = self.resolve(self.output_template, cfg)
        if not tools.file_nonempty(out_csv):
            return StepStatus(state="pending", detail="Create subject_features.csv.")
        try:
            info = os.stat(out_csv, follow_symlinks=True)
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_TABLE_BYTES:
                return StepStatus(
                    state="partial",
                    detail="Keep subject_features.csv within 64 MiB.",
                    artifacts=[out_csv],
                )
            csv.field_size_limit(MAX_FIELD_BYTES)
            with open(out_csv, newline="", encoding="utf-8") as handle:
                reader = csv.reader(handle)
                header = next(reader, None)
                age_is_second = (
                    header is not None
                    and len(header) >= 2  # noqa: PLR2004
                    and header[1].strip().lower() == "age"
                )
                if not age_is_second:
                    return StepStatus(
                        state="partial",
                        detail="Place age in the second column.",
                        artifacts=[out_csv],
                    )
                if len(header) > MAX_TABLE_COLUMNS:
                    return StepStatus(
                        state="partial",
                        detail="Keep subject_features.csv within 1024 columns.",
                        artifacts=[out_csv],
                    )
                problem, rows, unknown_age = self._scan_age_rows(reader)
                if problem is not None:
                    return StepStatus(
                        state="partial", detail=problem, artifacts=[out_csv]
                    )
        except OSError as exc:
            return StepStatus(state="failed", detail=str(exc), artifacts=[out_csv])
        if rows == 0:
            return StepStatus(
                state="partial",
                detail="Add at least one subject row.",
                artifacts=[out_csv],
            )
        populated = rows - len(unknown_age)
        if populated == 0:
            return StepStatus(
                state="partial",
                detail="Provide an age value for at least one subject.",
                artifacts=[out_csv],
            )
        detail = (
            "1 subject has a populated age."
            if populated == 1
            else f"{populated} subjects have a populated age."
        )
        if unknown_age:
            listed = ", ".join(unknown_age[:MAX_LISTED_IDS])
            tail = ", ..." if len(unknown_age) > MAX_LISTED_IDS else "."
            detail += f" Age is empty for {len(unknown_age)} subject(s): {listed}{tail}"
        return StepStatus(state="done", detail=detail, artifacts=[out_csv])

    def parse_failure(self, rc: int, stdout: str, stderr: str) -> Failure | None:
        """Map a non-zero exit into a structured failure for the transform.

        Recognize the ``pandas`` failure signatures this step can hit: a
        missing input CSV, a join key or age column absent from the metadata,
        and an empty merge result. Fall back to the generic classifier for any
        other non-zero return code.

        Returns
        -------
        Failure or None
            Return the structured failure or ``None`` when ``rc`` is zero.
        """
        if rc == 0:
            return None
        text = f"{stderr}\n{stdout}"
        lowered = text.lower()
        if any(
            needle in lowered
            for needle in ("within 64 mib", "within 5000 rows", "within 1024 columns")
        ):
            return Failure(
                code=rc,
                tag="input_bounds",
                message="Keep each age-stage table within its documented bounds.",
            )
        if "no such file" in lowered or "filenotfounderror" in lowered:
            return Failure(
                code=rc, tag="missing_input", message="Provide the input CSV."
            )
        if "keyerror" in lowered or "not in index" in lowered:
            return Failure(
                code=rc,
                tag="missing_column",
                message="Add the subject id and age columns to the metadata.",
            )
        if "emptydataerror" in lowered or "no columns to parse" in lowered:
            return Failure(
                code=rc, tag="empty_input", message="Add rows to the input CSV."
            )
        return super().parse_failure(rc, stdout, stderr)


register(AgeAdapter())


__all__ = ["AgeAdapter"]
