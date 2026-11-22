"""Adapter for Step 9 final structural analysis through first-party R resources.

``FreesurferAnalysisScript.R`` performs per-region Welch tests and Hedges
g for four cohort contrasts across the cortical, subcortical, and white matter
blocks and writes one XLSX or CSV table per block and contrast (twelve), the
site-balanced rule's ``site_exclusions.csv``, and the ICV and mean-thickness
summaries by cohort and site. Effects are reference minus focal (control minus
SCI; SCI_P minus SCI_nNP for nNPvP), as upstream's ``esvis::hedg_g`` computes
them (``final_r_contract``). ``FreesurferAnalysisScript.Rmd`` sources the same
implementation and adds an HTML report. The R script's fixed
``--render-report`` mode receives report parameters as argv so paths are never
interpolated into R source code.

The adapter builds the command, detects real output artifacts and their table
structure, and parses failure signatures. It knits the Rmd when ``renderReport``
is enabled, a path that requires ``rmarkdown``, ``knitr``, and Pandoc, and runs
the base-R script directly otherwise. Structural and metadata inputs, the output
directory, the start-column position, the active cortical/subcortical split,
and cohort labels are injected into the command. Detection covers the
twelve ``SCI_``, ``SUB_``, and ``WM_<code>_results`` table families, the three
fixed CSV outputs, and an optional report.

``rmarkdown::render`` writes its intermediates (``<name>.knit.md`` and the
figure folder) beside the template unless the caller passes
``intermediates_dir``; the R script that calls it is a receipt-bound resource,
and an installed application's resources are read-only. A launch therefore
knits a byte-identical copy of the template pair under the run directory; the
receipt still binds the reviewed template.
"""

from __future__ import annotations

import csv
import io
import os
import stat
import uuid
from dataclasses import dataclass, replace
from typing import Any

from .. import resources
from ..bounded_io import read_bounded_regular, read_regular_prefix
from .base import (
    OOM_EXIT_CODE,
    Adapter,
    ExecutionAction,
    Failure,
    StepStatus,
    Validation,
    register,
)
from .tools import file_nonempty

#: Knit this Rmd template for the Step 9 HTML or PDF report.
RMD_TEMPLATE = "FreesurferAnalysisScript.Rmd"

#: Write result tables with this base-R analysis script.
PLAIN_SCRIPT = "FreesurferAnalysisScript.R"

#: Pass this start-column position to the R entry point, which takes it positionally.
DEFAULT_START_COLUMN = 5

#: Use the tutorial-documented cortical/subcortical split at column 613.
DEFAULT_CORTICAL_SPLIT = 613

#: Use these R cohort codes for metadata and comparison subsetting.
COHORT_LABELS = ("SCI_H", "SCI_P", "SCI_nNP", "SCI")

#: Emit one workbook for each of these two-group comparison codes.
COMPARISON_CODES = ("PvH", "nNPvH", "nNPvP", "IvH")

#: Emit these cortical, subcortical, and white matter blocks for every comparison.
RESULT_BLOCKS = ("SCI", "SUB", "WM")

#: Write these fixed CSV outputs on every run, as ``(key, label, basename)``.
#: ``final_r_contract.SITE_EXCLUSIONS_FILE`` names the first; a test binds them.
CSV_OUTPUTS = (
    ("site_exclusions", "Site exclusions", "site_exclusions.csv"),
    ("summary_icv", "ICV summary", "summary_icv.csv"),
    ("summary_thickness", "Thickness summary", "summary_thickness.csv"),
)

#: Name the R failure that lists every result family it could not estimate,
#: verbatim from the Step 9 script, which keeps the old stage name.
UNESTIMABLE_FAILURE = "Cannot create all twelve required R analysis result tables."

#: Prefer these emitted table formats in inventory order.
RESULT_TABLE_EXTENSIONS = ("xlsx", "csv")

#: Report formats accepted by the detector, in preferred inventory order.
REPORT_BASENAMES = ("report.html", "report.pdf")

#: Recognize an XLSX workbook by the ZIP local-file header it must begin with.
_XLSX_SIGNATURE = b"PK\x03\x04"

#: Read at most this much of a result table to recognize its structure.
_MAX_TABLE_PREFIX_BYTES = 64 * 1024

RSCRIPT_NOT_FOUND = 127

#: Mark the argv position that names the report template.
RENDER_REPORT_FLAG = "--render-report"

#: Name the run's copy of the template pair, under ``<run>/work/<stage>``.
REPORT_STAGING_DIR = "report-template"

#: Bound each staged template file; the shipped pair is about 45 KiB.
_MAX_TEMPLATE_BYTES = 4 * 1024 * 1024


def report_staging_dir(cfg: dict[str, Any], stage_key: str) -> str | None:
    """Return the run's writable template directory, or ``None`` outside a run."""
    runtime = cfg.get("_supraspinaRuntime")
    run_dir = runtime.get("runDir") if isinstance(runtime, dict) else None
    if not isinstance(run_dir, str) or not run_dir:
        return None
    return os.path.join(run_dir, "work", stage_key, REPORT_STAGING_DIR)


def _template_index(argv: tuple[str, ...]) -> int | None:
    """Return the argv index of the report template, or ``None`` without one."""
    if RENDER_REPORT_FLAG not in argv:
        return None
    index = argv.index(RENDER_REPORT_FLAG) + 1
    return index if index < len(argv) else None


def staged_report_action(
    action: ExecutionAction, staging: str | None
) -> ExecutionAction:
    """Point a report render at the run's copy of its template.

    Leave every other argument, including the analysis script, unchanged, and
    leave a table-only command or an action outside a run as it is.
    """
    index = _template_index(action.argv)
    if staging is None or index is None:
        return action
    argv = list(action.argv)
    argv[index] = os.path.join(staging, os.path.basename(argv[index]))
    return replace(action, argv=tuple(argv))


def stage_report_template(action: ExecutionAction, staging: str | None) -> None:
    """Copy the report template and the script it sources into ``staging``.

    Copy from the directory the bound command names, so the knit reads the
    bytes its receipt binds. Replace each copy atomically, so a retry in the
    same run starts from the reviewed bytes.
    """
    index = _template_index(action.argv)
    if staging is None or index is None:
        return
    template = action.argv[index]
    try:
        os.makedirs(staging, exist_ok=True)
        info = os.lstat(staging)
    except OSError as exc:
        raise OSError("Create the run's report template directory.") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise NotADirectoryError("Use a directory for the run's report template.")
    for name in (os.path.basename(template), PLAIN_SCRIPT):
        payload = read_bounded_regular(
            os.path.join(os.path.dirname(template), name), _MAX_TEMPLATE_BYTES
        )
        target = os.path.join(staging, name)
        partial = f"{target}.tmp-{uuid.uuid4().hex}"
        try:
            with open(partial, "xb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(partial, target)
        finally:
            if os.path.lexists(partial):
                os.unlink(partial)


def _valid_table(path: str) -> bool:
    """Report whether a result table carries the structure its format requires.

    Returns
    -------
    bool
        Return ``True`` for an XLSX file that begins with the ZIP local-file
        signature, or a CSV file whose first row names more than one column.
    """
    try:
        payload, _size, _truncated = read_regular_prefix(path, _MAX_TABLE_PREFIX_BYTES)
    except OSError:
        return False
    if os.path.splitext(path)[1].lower() == ".xlsx":
        return payload.startswith(_XLSX_SIGNATURE)
    try:
        lines = payload.decode("utf-8-sig").splitlines()
    except UnicodeError:
        return False
    if not lines:
        return False
    try:
        header = next(csv.reader(io.StringIO(lines[0], newline="")), [])
    except csv.Error:
        return False
    return len(header) > 1


@dataclass(frozen=True)
class FinalOutputContract:
    """Represent one required R analysis artifact family and its variants."""

    key: str
    label: str
    candidates: tuple[str, ...]
    # "table" (XLSX or CSV, one format across families), "csv", or "report".
    kind: str = "table"

    def existing_paths(self) -> tuple[str, ...]:
        """Return every regular candidate, including empty stale variants."""
        return tuple(path for path in self.candidates if os.path.isfile(path))

    def valid_path(self) -> str | None:
        """Return the sole regular, non-empty candidate or fail closed."""
        existing = self.existing_paths()
        if len(existing) != 1:
            return None
        return existing[0] if file_nonempty(existing[0]) else None

    def inventory_path(self) -> str:
        """Return the valid or existing candidate Results should inventory."""
        valid = self.valid_path()
        if valid is not None:
            return valid
        existing = self.existing_paths()
        return existing[0] if existing else self.candidates[0]


def output_contracts(
    out_dir: str, *, include_report: bool
) -> tuple[FinalOutputContract, ...]:
    """Return every required R analysis output family for one configuration.

    Returns
    -------
    tuple of FinalOutputContract
        Return twelve table families, the three fixed CSV outputs, and the
        report family when requested.
    """
    contracts = [
        FinalOutputContract(
            key=f"{block}_{code}",
            label=f"{block} {code} results",
            candidates=tuple(
                os.path.join(out_dir, f"{block}_{code}_results.{extension}")
                for extension in RESULT_TABLE_EXTENSIONS
            ),
        )
        for block in RESULT_BLOCKS
        for code in COMPARISON_CODES
    ]
    contracts.extend(
        FinalOutputContract(
            key=key,
            label=label,
            candidates=(os.path.join(out_dir, basename),),
            kind="csv",
        )
        for key, label, basename in CSV_OUTPUTS
    )
    if include_report:
        contracts.append(
            FinalOutputContract(
                key="report",
                label="Report",
                candidates=tuple(
                    os.path.join(out_dir, basename) for basename in REPORT_BASENAMES
                ),
                kind="report",
            )
        )
    return tuple(contracts)


class FinalAdapter(Adapter):
    """Produce Step 9 result tables and an optional rendered report.

    Launch the bundled script's fixed ``--render-report`` argv mode to knit the
    shipped ``FreesurferAnalysisScript.Rmd`` with injected paths and
    column-split indices, then detect the ``SCI_``, ``SUB_``, and
    ``WM_<code>_results`` tables, the fixed CSV outputs, and the knit report on
    disk. Do not compute statistics in Python.
    """

    key = "final"
    # Gate on ``finalrscript`` rather than ``rscript`` because this stage may
    # override the interpreter it spawns; the outlier stage keeps ``rscript``.
    required_checks = ("finalrscript", "final_assets")
    name = "R analysis"
    goal = "Run final R structural analysis and produce workbooks and the report."
    advances = ("rep",)

    def required_check_ids(self, cfg: dict[str, Any]) -> tuple[str, ...]:
        """Require report-only tooling only when report rendering is enabled."""
        required = ["finalrscript", "final_assets"]
        if bool(self.params(cfg).get("renderReport", True)):
            required.extend(("rmarkdown", "knitr", "pandoc", "final_report_assets"))
        return tuple(required)

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the editable parameter schema for the R analysis.

        Mirror ``steps.ts`` exactly. Expose only the Rscript executable, output
        directory, and report-rendering toggle accepted by the real
        ``Rscript`` or ``rmarkdown::render`` flow.

        Returns
        -------
        dict
            Return each parameter name mapped to its kind, default, label, and
            path constraints.
        """
        return {
            "rscriptExecutable": {
                "kind": "path",
                "default": "${tools.rscriptExecutable}",
                "must": "any",
                "label": "Rscript executable",
            },
            "outDir": {
                "kind": "path",
                "default": "${paths.outputDir}/final",
                "must": "writable",
                "label": "R analysis output directory",
            },
            "renderReport": {
                "kind": "bool",
                "default": True,
                "label": "Render HTML report (rmarkdown+pandoc; off = tables)",
            },
        }

    def validate(self, cfg: dict[str, Any], env: dict[str, Any]) -> Validation:
        """Block the plan when the operator's metadata CSV is missing or unreadable.

        Check the configured source file, not the run-scoped projection, which
        exists only after launch. Otherwise a missing source would surface only
        when R analysis launches, after every upstream stage has run.
        """
        validation = super().validate(cfg, env)
        source = self.resolve("${paths.metadataDir}/metadata.csv", cfg)
        if not os.path.isfile(source) or not os.access(source, os.R_OK):
            validation.blocking.append(
                f"Provide the metadata file {source} with a subject ID column "
                "(participant_id) and a Cohort column; Sex and Age are optional."
            )
        return validation

    def _out_dir(self, cfg: dict[str, Any]) -> str:
        """Resolve the configured final output directory."""
        params = self.params(cfg)
        template = params.get("outDir") or "${paths.outputDir}/final"
        return self.resolve(str(template), cfg)

    def _structural_dir(self, cfg: dict[str, Any]) -> str:
        """Resolve the structural-CSV directory the aggregate stage wrote.

        Honor ``steps.aggregate.params.outDir`` with the aggregate stage's
        default template as the fallback, so the consumer always reads the
        directory the producer published instead of a fixed location.
        """
        params = cfg.get("steps", {}).get("aggregate", {}).get("params", {})
        template = (
            params.get("outDir") if isinstance(params, dict) else None
        ) or "${paths.outputDir}/structural"
        return self.resolve(str(template), cfg)

    def _rscript(self, cfg: dict[str, Any]) -> str:
        """Resolve the Rscript executable, defaulting to the tool config."""
        params = self.params(cfg)
        template = params.get("rscriptExecutable") or "${tools.rscriptExecutable}"
        resolved = self.resolve(str(template), cfg)
        return resolved or "Rscript"

    def receipt_action(
        self, cfg: dict[str, Any], subject_id: str | None
    ) -> ExecutionAction:
        """Bind the reviewed template, whose bytes the launched copy repeats."""
        return ExecutionAction(
            kind="process", argv=tuple(self.build_command(cfg, subject_id))
        )

    def execution_action(
        self, cfg: dict[str, Any], subject_id: str | None
    ) -> ExecutionAction:
        """Knit the report from the run's writable copy of the template."""
        return staged_report_action(
            self.receipt_action(cfg, subject_id), report_staging_dir(cfg, self.key)
        )

    def prepare_execution(self, cfg: dict[str, Any], subject_id: str | None) -> None:
        """Copy the template pair the launched report render reads."""
        stage_report_template(
            self.receipt_action(cfg, subject_id), report_staging_dir(cfg, self.key)
        )

    def _report_path(self, cfg: dict[str, Any]) -> str:
        """Resolve the knit HTML report path."""
        return os.path.join(self._out_dir(cfg), "report.html")

    def _script_dir(self, cfg: dict[str, Any]) -> str:
        """Return the bundled Step 9 asset directory.

        Always use the runnable ``FreesurferAnalysisScript.R`` and ``.Rmd`` files
        shipped under ``resources/step9`` to keep the app self-contained. Accept
        ``cfg`` for signature parity without changing the path.
        """
        del cfg
        return str(resources.step9_dir())

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the ``Rscript`` argv for the Step 9 analysis.

        Knit the bundled ``FreesurferAnalysisScript.Rmd`` through the analysis
        script's fixed argv wrapper when ``renderReport`` is enabled. Pass the
        structural-CSV directory, metadata CSV, output directory, legacy
        start-column value, cortical/subcortical split, and R cohort labels
        through ``params``. Run the base-R ``FreesurferAnalysisScript.R`` with
        the same positional values when report rendering is disabled. Require no
        ``rmarkdown`` or Pandoc for the base-R path. Write ``.xlsx`` when
        ``writexl`` is present and ``.csv`` otherwise. Ignore ``subject_id`` for
        this cohort-wide step.

        Parameters
        ----------
        subject_id
            Ignore the value because the analysis pools the whole cohort.
        """
        del subject_id

        rscript = self._rscript(cfg)
        script_dir = self._script_dir(cfg)
        structural_dir = self._structural_dir(cfg)
        runtime = cfg.get("_supraspinaRuntime", {})
        projected = (
            runtime.get("finalMetadataFile") if isinstance(runtime, dict) else None
        )
        metadata_csv = (
            projected
            if isinstance(projected, str) and projected
            else self.resolve("${paths.metadataDir}/metadata.csv", cfg)
        )
        out_dir = self._out_dir(cfg)

        if not bool(self.params(cfg).get("renderReport", True)):
            return [
                rscript,
                os.path.join(script_dir, PLAIN_SCRIPT),
                structural_dir,
                metadata_csv,
                out_dir,
                str(DEFAULT_START_COLUMN),
                str(DEFAULT_CORTICAL_SPLIT),
                ",".join(COHORT_LABELS),
            ]

        return [
            rscript,
            os.path.join(script_dir, PLAIN_SCRIPT),
            RENDER_REPORT_FLAG,
            os.path.join(script_dir, RMD_TEMPLATE),
            structural_dir,
            metadata_csv,
            out_dir,
            str(DEFAULT_START_COLUMN),
            str(DEFAULT_CORTICAL_SPLIT),
            ",".join(COHORT_LABELS),
        ]

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        """Detect completion from the real Step 9 artifacts on disk.

        Match the bundled script's output contract: require every comparison to
        emit a cortical ``SCI_``, subcortical ``SUB_``, and white matter
        ``WM_<code>_results`` table, as XLSX when ``writexl`` is available or
        CSV otherwise, the ``site_exclusions.csv``, ``summary_icv.csv``, and
        ``summary_thickness.csv`` outputs, plus an optional knit report (HTML or
        PDF). Require every family to resolve to a readable, regular, non-empty
        file, and every table to carry the structure its format declares.

        Parameters
        ----------
        subject_id
            Ignore the value because the analysis is cohort-wide.

        Returns
        -------
        StepStatus
            Return ``done`` with the discovered artifacts, ``partial`` when a
            table is missing or structurally malformed, or ``pending``.
        """
        del subject_id

        render_report = bool(self.params(cfg).get("renderReport", True))
        contracts = output_contracts(self._out_dir(cfg), include_report=render_report)
        ambiguous = [
            contract for contract in contracts if len(contract.existing_paths()) > 1
        ]
        table_extensions = {
            os.path.splitext(contract.existing_paths()[0])[1]
            for contract in contracts
            if contract.kind == "table" and len(contract.existing_paths()) == 1
        }
        if ambiguous or len(table_extensions) > 1:
            artifacts = [
                path
                for contract in contracts
                for path in contract.existing_paths()
                if file_nonempty(path)
            ]
            reasons: list[str] = []
            if ambiguous:
                reasons.append(
                    "remove stale output variants for "
                    + ", ".join(contract.key for contract in ambiguous)
                )
            if len(table_extensions) > 1:
                reasons.append("use one table format for all twelve result families")
            detail = "; ".join(reasons)
            return StepStatus(
                state="failed",
                detail=detail[:1].upper() + detail[1:] + ".",
                artifacts=artifacts,
            )
        resolved = [(contract, contract.valid_path()) for contract in contracts]
        artifacts = [path for _contract, path in resolved if path is not None]
        missing = [contract for contract, path in resolved if path is None]
        malformed = [
            contract
            for contract, path in resolved
            if path is not None and contract.kind != "report" and not _valid_table(path)
        ]

        if malformed:
            return StepStatus(
                state="partial",
                detail=(
                    "Repair the malformed R analysis tables: "
                    f"{', '.join(contract.key for contract in malformed)}."
                ),
                artifacts=artifacts,
            )
        if not missing:
            detail = (
                "All twelve cortical, subcortical, and white matter comparison "
                "tables, the site exclusions, the ICV and thickness summaries"
            )
            if render_report:
                detail += ", and the report"
            detail += " are present."
            return StepStatus(state="done", detail=detail, artifacts=artifacts)
        if not artifacts:
            out_dir = self._out_dir(cfg)
            return StepStatus(
                state="pending",
                detail=(
                    "Create the SCI/SUB/WM comparison tables and report under "
                    f"{out_dir}."
                ),
            )
        missing_tables = [
            contract.key for contract in missing if contract.kind != "report"
        ]
        detail = (
            f"Create the missing R analysis outputs: {', '.join(missing_tables)}."
            if missing_tables
            else "Create the report."
        )
        return StepStatus(state="partial", detail=detail, artifacts=artifacts)

    def parse_failure(self, rc: int, stdout: str, stderr: str) -> Failure | None:
        """Map an ``Rscript`` failure into a structured failure.

        Recognize the failure signatures this step actually produces: a missing
        ``Rscript`` (rc 127), a missing R function or package, a broken
        ``rmarkdown`` or Pandoc report toolchain, missing inputs, and OOM kills.

        Returns
        -------
        Failure or None
            Return the classified failure or ``None`` when ``rc`` is zero.
        """
        if rc == 0:
            return None

        blob = f"{stderr}\n{stdout}"
        lower = blob.lower()
        tail = [
            line.strip()
            for line in blob.strip().splitlines()
            if line.strip() and line.strip() != "Execution halted"
        ]
        last = tail[-1] if tail else f"Inspect process exit code {rc}."

        package_missing = (
            "there is no package called" in lower or "could not find function" in lower
        )
        if rc == OOM_EXIT_CODE:
            tag, message = (
                "oom_killed",
                "Reduce R memory use after the process is OOM-killed.",
            )
        elif rc == RSCRIPT_NOT_FOUND or "not found: rscript" in lower:
            tag, message = "rscript_missing", "Add Rscript to PATH."
        elif UNESTIMABLE_FAILURE in blob:
            tag = "unestimable_results"
            detail = blob.split(UNESTIMABLE_FAILURE, 1)[1]
            detail = detail.split("Execution halted", 1)[0]
            message = UNESTIMABLE_FAILURE
            if detail.strip():
                message += f" {' '.join(detail.split())}"
        elif any(
            needle in lower
            for needle in (
                "within 64 mib",
                "within 5000 cohort rows",
                "within 1024 columns",
            )
        ):
            tag, message = "input_bounds", last
        elif package_missing:
            tag = "r_package_missing"
            message = (
                "Install the missing R package; report rendering requires "
                "rmarkdown and knitr."
            )
        elif "pandoc" in lower or "rmarkdown" in lower:
            tag = "knit_toolchain_missing"
            message = "Install rmarkdown and Pandoc for report rendering."
        elif "cannot open file" in lower or "no such file" in lower:
            tag = "missing_input"
            message = "Provide every structural CSV and metadata.csv input."
        else:
            tag, message = "nonzero_exit", last
        return Failure(code=rc, tag=tag, message=message)


register(FinalAdapter())
