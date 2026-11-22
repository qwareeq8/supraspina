"""Adapter for the z-score group comparisons (upstream Step 9, z-score track).

Upstream's Step 9 README (``eba4f59``) runs the Step 9 comparisons twice: on
the raw FreeSurfer measures (the ``final`` stage) and on the BrainCharts
z-scores. This stage is the second run, kept separate so ``final`` never
depends on BrainCharts. It runs ``FreesurferAnalysisScript.R --track
zscores`` (``final_r_contract``) on the ``braincharts`` stage's z-score table:
the same four contrasts, Welch t and Hedges g with the reference-minus-focal
sign, over the thickness (``Z_SCI``) and subcortical (``Z_SUB``) z-score
blocks, eight tables, and an optional report.

The comparisons pool sites, because adaptation removes each site's offset.
Sites BrainCharts refused have no rows; the script
reads ``braincharts_refused_sites.csv`` beside the z-score table and the
report names them. The stage runs on the R analysis interpreter and its checks.
"""

from __future__ import annotations

import os
from typing import Any

from .. import resources
from ..final_r_contract import (
    TRACK_FLAG,
    TRACK_ZSCORES,
    ZSCORE_TABLE_PREFIX,
    ZSCORES_FILE,
)
from .base import (
    OOM_EXIT_CODE,
    Adapter,
    ExecutionAction,
    Failure,
    StepStatus,
    Validation,
    register,
)
from .braincharts import OUT_DIR_TEMPLATE as BRAINCHARTS_OUT_DIR
from .final import (
    COHORT_LABELS,
    COMPARISON_CODES,
    PLAIN_SCRIPT,
    RENDER_REPORT_FLAG,
    REPORT_BASENAMES,
    RESULT_TABLE_EXTENSIONS,
    RMD_TEMPLATE,
    RSCRIPT_NOT_FOUND,
    FinalOutputContract,
    _valid_table,
    report_staging_dir,
    stage_report_template,
    staged_report_action,
)
from .tools import file_nonempty

#: The stage's own output directory, never the ``final`` one.
OUT_DIR_TEMPLATE = "${paths.outputDir}/zstats"

#: The z-score blocks: cortical thickness and subcortical volume.
RESULT_BLOCKS = ("SCI", "SUB")

#: The R failure that lists every z-score family it could not estimate,
#: verbatim from the Step 9 script, which keeps the old stage name.
UNESTIMABLE_FAILURE = "Cannot create all eight required R analysis z-score tables."

#: The report checks, required only while this stage renders its report.
REPORT_CHECKS = ("rmarkdown", "knitr", "pandoc", "final_report_assets")


def output_contracts(
    out_dir: str, *, include_report: bool
) -> tuple[FinalOutputContract, ...]:
    """Return the eight ``Z_`` table families and, when rendered, the report."""
    contracts = [
        FinalOutputContract(
            key=f"{ZSCORE_TABLE_PREFIX}{block}_{code}",
            label=f"{ZSCORE_TABLE_PREFIX}{block} {code} results",
            candidates=tuple(
                os.path.join(
                    out_dir,
                    f"{ZSCORE_TABLE_PREFIX}{block}_{code}_results.{extension}",
                )
                for extension in RESULT_TABLE_EXTENSIONS
            ),
        )
        for block in RESULT_BLOCKS
        for code in COMPARISON_CODES
    ]
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


class ZStatsAdapter(Adapter):
    """Compare BrainCharts z-scores between cohorts with the Step 9 framework."""

    key = "zstats"
    name = "Z-score group comparisons"
    goal = (
        "Compares BrainCharts z-scores between cohorts with per-region Welch "
        "t-tests and Hedges g, pooling the adapted sites."
    )

    def required_check_ids(self, cfg: dict[str, Any]) -> tuple[str, ...]:
        """Require the R analysis interpreter, and the report tools when rendering."""
        required = ["finalrscript", "final_assets"]
        if self._render_report(cfg):
            required.extend(REPORT_CHECKS)
        return tuple(required)

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the report toggle, the stage's only setting (mirror ``steps.ts``)."""
        return {
            "renderReport": {
                "kind": "bool",
                "default": True,
                "label": "Render HTML report",
            },
        }

    def _render_report(self, cfg: dict[str, Any]) -> bool:
        return bool(self.params(cfg).get("renderReport", True))

    def validate(self, cfg: dict[str, Any], env: dict[str, Any]) -> Validation:
        """Name the report tools that read as skipped while R analysis has no report.

        The R Markdown, knitr, and Pandoc checks report a missing tool as
        skipped when the Final stage does not render its report, so a generic
        "status: skipped" would hide what this stage needs.
        """
        validation = super().validate(cfg, env)
        if not self._render_report(cfg):
            return validation
        statuses = {
            str(check.get("id", "")): (
                check.get("status"),
                check.get("label") or check.get("id"),
            )
            for group in env.get("groups", [])
            for check in group.get("checks", [])
        }
        skipped = [
            str(statuses[check_id][1])
            for check_id in REPORT_CHECKS
            if check_id in statuses and statuses[check_id][0] == "skipped"
        ]
        if skipped:
            validation.blocking = [
                reason
                for reason in validation.blocking
                if not any(f"the {label} check;" in reason for label in skipped)
            ]
            named = (
                " and ".join(skipped)
                if len(skipped) <= 2  # noqa: PLR2004 - "a and b" needs no comma
                else f"{', '.join(skipped[:-1])}, and {skipped[-1]}"
            )
            validation.blocking.append(
                f"Install {named} for the z-score report, or turn the z-score "
                "report off."
            )
        return validation

    def out_dir(self, cfg: dict[str, Any]) -> str:
        """Return the stage's output directory."""
        return self.resolve(OUT_DIR_TEMPLATE, cfg)

    def zscores_csv(self, cfg: dict[str, Any]) -> str:
        """Return the z-score table the BrainCharts stage publishes."""
        return os.path.join(self.resolve(BRAINCHARTS_OUT_DIR, cfg), ZSCORES_FILE)

    def _rscript(self, cfg: dict[str, Any]) -> str:
        """Resolve the Final stage's interpreter, which ``finalrscript`` probes."""
        steps = cfg.get("steps", {})
        final = steps.get("final", {}) if isinstance(steps, dict) else {}
        params = final.get("params", {}) if isinstance(final, dict) else {}
        template = (
            params.get("rscriptExecutable") if isinstance(params, dict) else None
        ) or "${tools.rscriptExecutable}"
        return self.resolve(str(template), cfg) or "Rscript"

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the frozen ``--track zscores`` argv of ``final_r_contract``."""
        del subject_id
        script_dir = resources.step9_dir()
        argv = [
            self._rscript(cfg),
            str(script_dir / PLAIN_SCRIPT),
            TRACK_FLAG,
            TRACK_ZSCORES,
        ]
        if self._render_report(cfg):
            argv.extend([RENDER_REPORT_FLAG, str(script_dir / RMD_TEMPLATE)])
        argv.extend([self.zscores_csv(cfg), self.out_dir(cfg), ",".join(COHORT_LABELS)])
        return argv

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
        """Knit the report from the run's writable copy (see ``final``)."""
        return staged_report_action(
            self.receipt_action(cfg, subject_id), report_staging_dir(cfg, self.key)
        )

    def prepare_execution(self, cfg: dict[str, Any], subject_id: str | None) -> None:
        """Copy the template pair the launched report render reads."""
        stage_report_template(
            self.receipt_action(cfg, subject_id), report_staging_dir(cfg, self.key)
        )

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        """Detect the eight ``Z_`` tables and, when rendered, the report.

        Every family must resolve to one regular, non-empty file with the
        structure its format declares, and all tables must share one format.
        """
        del subject_id
        out_dir = self.out_dir(cfg)
        render_report = self._render_report(cfg)
        contracts = output_contracts(out_dir, include_report=render_report)
        ambiguous = [
            contract.key for contract in contracts if len(contract.existing_paths()) > 1
        ]
        extensions = {
            os.path.splitext(contract.existing_paths()[0])[1]
            for contract in contracts
            if contract.kind == "table" and len(contract.existing_paths()) == 1
        }
        if ambiguous or len(extensions) > 1:
            reasons = []
            if ambiguous:
                reasons.append(
                    f"Remove stale output variants for {', '.join(ambiguous)}."
                )
            if len(extensions) > 1:
                reasons.append("Use one table format for all eight z-score families.")
            return StepStatus(
                state="failed",
                detail=" ".join(reasons),
                artifacts=[
                    path
                    for contract in contracts
                    for path in contract.existing_paths()
                    if file_nonempty(path)
                ],
            )
        resolved = [(contract, contract.valid_path()) for contract in contracts]
        artifacts = [path for _contract, path in resolved if path is not None]
        malformed = [
            contract.key
            for contract, path in resolved
            if path is not None and contract.kind != "report" and not _valid_table(path)
        ]
        if malformed:
            return StepStatus(
                state="partial",
                detail=f"Repair the malformed z-score tables: {', '.join(malformed)}.",
                artifacts=artifacts,
            )
        missing = [contract.key for contract, path in resolved if path is None]
        if not missing:
            detail = "All eight thickness and subcortical z-score comparison tables"
            detail += (
                ", and the report, are present." if render_report else " are present."
            )
            return StepStatus(state="done", detail=detail, artifacts=artifacts)
        if not artifacts:
            return StepStatus(
                state="pending",
                detail=f"Create the Z_SCI and Z_SUB comparison tables under {out_dir}.",
            )
        return StepStatus(
            state="partial",
            detail=f"Create the missing z-score outputs: {', '.join(missing)}.",
            artifacts=artifacts,
        )

    def parse_failure(self, rc: int, stdout: str, stderr: str) -> Failure | None:
        """Map an ``Rscript`` failure of the z-score track to a tagged failure."""
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
        if rc == OOM_EXIT_CODE:
            tag, message = (
                "oom_killed",
                "Reduce R memory use after the process is OOM-killed.",
            )
        elif rc == RSCRIPT_NOT_FOUND or "not found: rscript" in lower:
            tag, message = "rscript_missing", "Add Rscript to PATH."
        elif UNESTIMABLE_FAILURE in blob:
            detail = blob.split(UNESTIMABLE_FAILURE, 1)[1]
            detail = detail.split("Execution halted", 1)[0]
            tag, message = "unestimable_results", UNESTIMABLE_FAILURE
            if detail.strip():
                message += f" {' '.join(detail.split())}"
        elif "was refused by braincharts but has rows" in lower:
            tag, message = "refused_site_rows", last
        elif "within 64 mib" in lower or "within 5000 cohort rows" in lower:
            tag, message = "input_bounds", last
        elif "there is no package called" in lower or "could not find function" in (
            lower
        ):
            tag = "r_package_missing"
            message = (
                "Install the missing R package; report rendering requires "
                "rmarkdown and knitr."
            )
        elif "pandoc" in lower or "rmarkdown" in lower:
            tag = "knit_toolchain_missing"
            message = "Install rmarkdown and Pandoc for report rendering."
        elif "no such file" in lower or "cannot open file" in lower:
            tag = "missing_input"
            message = "Run BrainCharts normative modeling to publish its z-scores."
        else:
            tag, message = "nonzero_exit", last
        return Failure(code=rc, tag=tag, message=message)


register(ZStatsAdapter())
