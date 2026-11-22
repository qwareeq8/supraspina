"""Adapter for the statistical-QC histogram and outlier-review step.

The stage uses the inventoried first-party ``resources/enigma/outliers_qc.R``
implementation, which draws a histogram for every measure column, flags values
outside ``mean +/- z * SD`` with the ENIGMA threshold of 2.698, and writes
``outliers.csv`` and the exact per-column ``*_hist.png`` set.

The ENIGMA measures directory, QA output directory, and z threshold are
injected as positional ``commandArgs``. The step is cohort-wide: it consumes
the complete measures table, leaves ``advances`` empty, and ignores
``subject_id``.
"""

from __future__ import annotations

import csv
import io
import math
import os
from typing import Any

from .. import resources
from ..bounded_io import read_bounded_regular
from . import tools
from .base import Adapter, Failure, StepStatus, register

#: Use 2.698 as the implementation default, equivalent under normality to the
#: 1.5-IQR outer fences.
ENIGMA_Z_THRESHOLD = 2.698

_NOT_FOUND_EXIT_CODE = 127

_OUTLIERS_SCRIPT = "outliers_qc.R"
_MAX_HISTOGRAM_DIRECTORY_ENTRIES = 8_192
_MAX_MEASURES_BYTES = 64 * 1024 * 1024
_MAX_MEASURES_ROWS = 5_000
_MAX_FLAGGED_ROWS = 100_000
_OUTLIER_HEADER = [
    "SubjID",
    "structure",
    "measure",
    "direction",
    "value",
    "lower",
    "upper",
]

_INPUT_SPECS = (
    ("CorticalMeasuresENIGMA_ThickAvg.csv", "cortical_thickness"),
    ("CorticalMeasuresENIGMA_SurfAvg.csv", "cortical_area"),
    ("LandRvolumes.csv", "subcortical_volume"),
)


def _column_measure(source: str, column: str) -> str | None:
    """Mirror the R resource's bounded column-to-measure contract."""
    if source == "cortical_thickness":
        if column.endswith("_thickavg") or column in {"LThickness", "RThickness"}:
            return "thickness"
        if column in {"LSurfArea", "RSurfArea", "ICV"}:
            return None
    elif source == "cortical_area":
        if column.endswith("_surfavg") or column in {"LSurfArea", "RSurfArea"}:
            return "area"
        if column in {"LThickness", "RThickness", "ICV"}:
            return None
    elif source == "subcortical_volume":
        return "volume"
    raise ValueError(f"Classify the ENIGMA measure column {column} from {source}.")


def _histogram_name(source: str, measure: str, column: str) -> str:
    """Return one collision-free histogram basename."""
    return f"{source}__{measure}__{column}_hist.png"


def _outlier_identity(row: list[str]) -> tuple[str, str, str, str] | None:
    """Validate one detector row and return its unique scientific identity."""
    if len(row) != len(_OUTLIER_HEADER):
        return None
    subject, structure, measure, direction, *numeric = row
    if (
        not subject.strip()
        or not structure.strip()
        or measure not in {"thickness", "area", "volume"}
        or direction not in {"low", "high"}
    ):
        return None
    try:
        value, lower, upper = (float(item) for item in numeric)
    except ValueError:
        return None
    if not all(math.isfinite(item) for item in (value, lower, upper)) or lower > upper:
        return None
    if (direction == "low" and value >= lower) or (
        direction == "high" and value <= upper
    ):
        return None
    return subject, structure, measure, direction


class OutliersAdapter(Adapter):
    """Generate histograms and review outliers through the ENIGMA R script.

    Build an ``Rscript`` command for the first-party outlier-detection script.
    Inject the ENIGMA measures directory, QA output directory, and active z
    threshold. Detect the output contract as one CSV table of flagged outliers
    plus per-region histogram PNGs.
    """

    key = "outliers"
    required_checks = ("rscript", "outliers_assets")
    name = "Histogram and outlier review"
    goal = "Review per-region distributions and values beyond mean +/- 2.698*SD."
    advances: tuple[str, ...] = ()

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the parameter schema for the statistical-QC step.

        Returns
        -------
        dict
            Map the z-threshold parameter to its kind, default, and label. Match
            the ``steps.ts`` ``outliers`` entry exactly. Expose no tool flags.
        """
        return {
            "zThreshold": {
                "kind": "float",
                "default": ENIGMA_Z_THRESHOLD,
                "min": 0,
                "label": "Outlier z threshold (default 2.698)",
            },
        }

    def _measures_dir(self, cfg: dict[str, Any]) -> str:
        """Resolve the ENIGMA measures input directory from the config.

        Honor ``steps.enigma.params.outDir`` exactly as the enigma adapter
        and the enigma-to-outliers edge gate do, so this stage reads the
        measure tables the producer wrote and the gate validated.
        """
        params = cfg.get("steps", {}).get("enigma", {}).get("params", {})
        template = (
            params.get("outDir") if isinstance(params, dict) else None
        ) or "${paths.qcOutputDir}"
        return os.path.join(self.resolve(str(template), cfg), "measures")

    def _output_dir(self, cfg: dict[str, Any]) -> str:
        """Resolve the QA-outliers output directory from the config."""
        return self.resolve("${paths.qcOutputDir}/qa_outliers", cfg)

    def _script_path(self) -> str:
        """Resolve the absolute path to the bundled outlier-detection script."""
        return str(resources.enigma_dir() / _OUTLIERS_SCRIPT)

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the ``Rscript`` argv for the cohort-wide outlier review.

        Parameters
        ----------
        subject_id
            Ignore this value because the step consumes the whole cohort.

        Returns
        -------
        list of str
            ``[Rscript, <outliers_qc.R>, <measuresDir>, <outDir>,
            <zThreshold>]``. Inject the measures directory and output directory
            as the script's input/output paths.
        """
        params = self.params(cfg)
        schema = self.param_schema()
        z_threshold = params.get("zThreshold", schema["zThreshold"]["default"])
        # Fall back to the PATH name accepted by the environment probe when the
        # interpreter is unset, matching Step 9. Avoid passing an empty argv[0],
        # which execve rejects only after plan approval.
        rscript = self.resolve("${tools.rscriptExecutable}", cfg) or "Rscript"
        return [
            rscript,
            self._script_path(),
            self._measures_dir(cfg),
            self._output_dir(cfg),
            str(z_threshold),
        ]

    @staticmethod
    def _histogram_paths(directory: str) -> list[str]:
        """Return a bounded, sorted set of regular histogram files."""
        paths: list[str] = []
        try:
            with os.scandir(directory) as entries:
                for index, entry in enumerate(entries):
                    if index >= _MAX_HISTOGRAM_DIRECTORY_ENTRIES:
                        raise ValueError(
                            "Reduce the histogram directory below the entry limit."
                        )
                    if entry.name.endswith("_hist.png") and entry.is_file(
                        follow_symlinks=False
                    ):
                        paths.append(entry.path)
        except FileNotFoundError:
            return []
        return sorted(paths)

    def members(self, cfg: dict[str, Any]) -> frozenset[str] | None:
        """Return the ``SubjID`` union of the measure tables the review read.

        The review flags outliers across the whole ENIGMA output, so its
        coverage is the subject set of those measure tables rather than the
        flagged rows in ``outliers.csv``. A subject added after the review
        (a new reconstruction, say) is absent from every table and therefore
        not covered.
        """
        covered: set[str] = set()
        readable = False
        for name, _source in _INPUT_SPECS:
            ids = tools.read_csv_member_ids(
                os.path.join(self._measures_dir(cfg), name), "SubjID"
            )
            if ids is None:
                continue
            readable = True
            covered.update(ids)
        return frozenset(covered) if readable else None

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        """Detect completion from the real statistical-QC artifacts on disk.

        Parameters
        ----------
        subject_id
            Ignore this value because the step is cohort-wide.

        Returns
        -------
        StepStatus
            Return ``done`` for a valid CSV and exact histogram set. Return
            ``partial`` when only part of the contract is valid. Return
            ``pending`` when neither artifact exists.
        """
        out_dir = self._output_dir(cfg)
        outliers_csv = os.path.join(out_dir, "outliers.csv")
        hist_dir = os.path.join(out_dir, "hist")
        try:
            hist_pngs = self._histogram_paths(hist_dir)
            if not hist_pngs:
                hist_pngs = self._histogram_paths(out_dir)
        except (OSError, ValueError) as exc:
            return StepStatus(state="failed", detail=str(exc), artifacts=[])

        has_csv = tools.file_nonempty(outliers_csv)
        artifacts: list[str] = []
        if has_csv:
            artifacts.append(outliers_csv)
        artifacts.extend(hist_pngs)
        try:
            expected_hist = self._expected_histograms(cfg)
        except (OSError, ValueError, csv.Error, UnicodeError) as exc:
            return StepStatus(state="failed", detail=str(exc), artifacts=artifacts)
        actual_hist = {os.path.basename(path) for path in hist_pngs}
        hist_exact = actual_hist == expected_hist
        csv_schema = self._outliers_schema(outliers_csv) if has_csv else False

        if has_csv and csv_schema and hist_exact:
            return StepStatus(
                state="done",
                detail=(
                    f"Review outliers.csv and the exact {len(hist_pngs)}-histogram "
                    "PNG set."
                ),
                artifacts=artifacts,
            )
        if has_csv or hist_pngs:
            missing = (
                "valid outliers.csv schema"
                if not csv_schema
                else "exact deterministic histogram set"
            )
            return StepStatus(
                state="partial",
                detail=f"Restore the {missing}.",
                artifacts=artifacts,
            )
        return StepStatus(
            state="pending",
            detail="Run statistical QC to create the required artifacts.",
            artifacts=[],
        )

    def _expected_histograms(self, cfg: dict[str, Any]) -> set[str]:
        expected: set[str] = set()
        for name, source in _INPUT_SPECS:
            path = os.path.join(self._measures_dir(cfg), name)
            try:
                payload = read_bounded_regular(path, _MAX_MEASURES_BYTES)
                handle = io.StringIO(payload.decode("utf-8-sig"), newline="")
                reader = csv.reader(handle)
                header = next(reader, [])
                # Classify each column first, exactly as the R resource
                # does, so cells in excluded columns the analysis never
                # reads cannot fail a completed run.
                measures = [_column_measure(source, column) for column in header[1:]]
                numeric = [False] * max(0, len(header) - 1)
                for row_index, row in enumerate(reader):
                    if row_index >= _MAX_MEASURES_ROWS:
                        raise ValueError(
                            "Keep each ENIGMA measure table within 5000 rows."
                        )
                    for index in range(1, min(len(row), len(header))):
                        if measures[index - 1] is None:
                            continue
                        raw = row[index].strip()
                        if not raw or raw.lower() in {"na", "x"}:
                            continue
                        try:
                            value = float(raw)
                        except ValueError as exc:
                            raise ValueError(
                                "Provide numeric values in "
                                f"{name} column {header[index]}."
                            ) from exc
                        if not math.isfinite(value):
                            raise ValueError(
                                "Provide finite values in "
                                f"{name} column {header[index]}."
                            )
                        numeric[index - 1] = True
                for index, present in enumerate(numeric):
                    if not present:
                        continue
                    column = header[index + 1]
                    measure = measures[index]
                    if measure is not None:
                        expected.add(_histogram_name(source, measure, column))
            except FileNotFoundError:
                continue
        return expected

    @staticmethod
    def _outliers_schema(path: str) -> bool:
        try:
            payload = read_bounded_regular(path, _MAX_MEASURES_BYTES)
            handle = io.StringIO(payload.decode("utf-8-sig"), newline="")
            reader = csv.reader(handle)
            header = next(reader, [])
            if header != _OUTLIER_HEADER:
                return False
            seen: set[tuple[str, str, str, str]] = set()
            for row_index, row in enumerate(reader):
                if row_index >= _MAX_FLAGGED_ROWS:
                    return False
                identity = _outlier_identity(row)
                if identity is None or identity in seen:
                    return False
                seen.add(identity)
        except (OSError, csv.Error, UnicodeError):
            return False
        return True

    def parse_failure(self, rc: int, stdout: str, stderr: str) -> Failure | None:
        """Map a non-zero ``Rscript`` exit into a structured failure.

        Recognize the real failure signatures: a missing ``Rscript`` executable,
        missing input measures CSVs, and the duplicate-``SubjID`` or
        negative-volume ``stop()`` guards in the script.

        Returns
        -------
        Failure or None
            Return a tagged failure, or return ``None`` when ``rc`` is zero.
        """
        if rc == 0:
            return None
        blob = f"{stderr}\n{stdout}".lower()
        if rc == _NOT_FOUND_EXIT_CODE:
            return Failure(
                code=rc,
                tag="rscript_missing",
                message="Install or configure Rscript on PATH.",
            )
        signatures: tuple[tuple[tuple[str, ...], str, str], ...] = (
            (
                ("within 64 mib", "within 5000 cohort rows", "within 1024 columns"),
                "input_bounds",
                "Keep each outlier-review table within its documented bounds.",
            ),
            (
                ("flagged rows",),
                "output_bounds",
                "Narrow the outlier inputs or threshold to bound flagged rows.",
            ),
            (
                ("cannot open", "no such file"),
                "missing_input",
                "Provide an input measures CSV in the measures directory.",
            ),
            (
                ("duplicate subjids", "duplicated"),
                "duplicate_subjects",
                "Remove duplicate SubjID values from the measures CSV.",
            ),
            (
                ("negative",),
                "negative_volume",
                "Replace invalid negative volumes with 'x'.",
            ),
        )
        for needles, tag, message in signatures:
            if any(needle in blob for needle in needles):
                return Failure(code=rc, tag=tag, message=message)
        return super().parse_failure(rc, stdout, stderr)


register(OutliersAdapter())
