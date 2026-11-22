"""Adapter for Step 7 Brain-PAD group statistics through ``brainpadstats.py``.

The argv-driven analysis script runs as a Python subprocess and takes one input
workbook and twelve concrete output paths through its command-line interface.

It consumes ``predicted_results.xlsx`` for the ``control``, ``SCI_nNP``, and
``SCI_P`` cohorts and produces seven CSV tables and five PNG figures in the
analysis output directory. The configured analysis environment supplies the
``cliffs-delta`` package independently of the isolated PyBrainAge runtime. The
pinned upstream basename ``BrainPAD_acorss_AIS.csv`` stays verbatim in the
declared and detected outputs.
"""

from __future__ import annotations

import json
import os
from typing import Any

from .. import resources
from ..bounded_io import read_bounded_regular, sha256_bounded_regular
from .analysis_python import resolve_analysis_interpreter
from .base import Adapter, Failure, StepStatus, Validation, register
from .tools import exists, file_nonempty, read_csv_member_ids

# Keep output artifacts in the exact order accepted as output_path1..12. Reuse
# these names, labels, and kinds in the inventory so completion and presentation
# cannot silently diverge. Preserve the pinned upstream AIS-table misspelling.
OUTPUT_ARTIFACTS: tuple[tuple[str, str, str], ...] = (
    ("Summary statistics", "summary_statistics.csv", "csv"),
    ("Brain-PAD comparison figure", "BrainPAD_comparison.png", "png"),
    (
        "Chronological age vs predicted brain age figure",
        "Chronological_vs_BrainAge.png",
        "png",
    ),
    ("Brain-PAD vs chronological age figure", "BrainPAD_vs_Age.png", "png"),
    ("Brain-PAD across sex figure", "BrainPAD_across_sex.png", "png"),
    (
        "Brain-PAD vs time-since-injury figure",
        "BrainPAD_vs_TimeSinceInjury.png",
        "png",
    ),
    ("Brain-PAD across cohorts", "BrainPAD_across_cohorts.csv", "csv"),
    ("Brain-PAD across sex", "BrainPAD_across_sex.csv", "csv"),
    ("Brain-PAD across AIS", "BrainPAD_acorss_AIS.csv", "csv"),
    ("Chi-square across AIS", "Chi2_AIS.csv", "csv"),
    (
        "Time-since-injury comparison",
        "TimeSinceInjury_Comparison.csv",
        "csv",
    ),
    (
        "Chronological-age comparison",
        "ChronologicalAge_Comparison.csv",
        "csv",
    ),
)

# Retain these output basenames as the script-argv contract.
OUTPUT_BASENAMES: tuple[str, ...] = tuple(
    basename for _label, basename, _kind in OUTPUT_ARTIFACTS
)

# Use this relative template for the analysis input workbook.
INPUT_TEMPLATE = "${paths.outputDir}/analysis/predicted_results.xlsx"

# Mirror the steps.ts ``outDir`` default for the analysis output directory.
DEFAULT_OUTDIR_TEMPLATE = "${paths.outputDir}/analysis"

# Use this bundled self-contained analysis module. Avoid any dependency on an
# external ``${paths.projectRoot}/brainpadstats.py`` checkout.
MODULE_NAME = "brainpadstats.py"
MANIFEST_BASENAME = ".brainpad-generation.json"
_MAX_MANIFEST_BYTES = 64 * 1024
_MAX_OUTPUT_BYTES = 64 * 1024 * 1024


class BrainpadAdapter(Adapter):
    """Wrap ``brainpadstats.py`` for group-level Brain-PAD statistics.

    Ignore ``subject_id`` because the script ingests the whole analysis
    workbook. Build the Python command with injected input and output paths,
    detect completion from all twelve declared output artifacts, and recognize
    the script's real failure signatures
    (missing ``cliffs-delta`` dependency, missing input workbook, missing
    expected columns).
    """

    key = "brainpad"
    name = "Brain-PAD statistics"
    goal = (
        "Calculate group-level Brain-PAD cohort, sex, and AIS comparisons, "
        "effect sizes, and figures."
    )
    advances = ("stats",)
    required_checks = ("brainpadpython", "brainpad_assets")

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the parameter schema mirroring the steps.ts defaults.

        Returns
        -------
        dict
            Return the configurable analysis ``outDir`` parameter.
        """
        return {
            "outDir": {
                "kind": "path",
                "default": DEFAULT_OUTDIR_TEMPLATE,
                "must": "writable",
                "label": "Analysis output directory",
            },
        }

    def _outdir(self, cfg: dict[str, Any]) -> str:
        """Resolve the analysis output directory from params or the default."""
        params = self.params(cfg)
        template = params.get("outDir") or DEFAULT_OUTDIR_TEMPLATE
        return self.resolve(template, cfg)

    def _output_paths(self, cfg: dict[str, Any]) -> list[str]:
        """Return the twelve resolved output paths in output_path1..12 order."""
        outdir = self._outdir(cfg)
        return [os.path.join(outdir, name) for name in OUTPUT_BASENAMES]

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the argv that runs ``brainpadstats.py`` with injected paths.

        Pass the input workbook and twelve output paths as positional arguments
        through the script's command-line interface.

        Parameters
        ----------
        subject_id
            Ignore the value because the step is cohort-wide.

        Returns
        -------
        list of str
            ``[python, brainpadstats.py, input_xlsx, out1, ..., out12]``.
        """
        python = resolve_analysis_interpreter(cfg)
        script = str(resources.step7_dir() / MODULE_NAME)
        input_xlsx = self.resolve(INPUT_TEMPLATE, cfg)
        return [python, script, input_xlsx, *self._output_paths(cfg)]

    def members(self, cfg: dict[str, Any]) -> frozenset[str] | None:
        """Return the ``ID`` set of the prediction table the statistics use.

        The statistics summarize the merged workbook, which carries the
        prediction rows one for one, so the CSV names the cohort they cover.
        """
        out_dir = self.resolve("${paths.outputDir}", cfg)
        return read_csv_member_ids(
            os.path.join(out_dir, "pybrainage", "predicted_results.csv"), "ID"
        )

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        """Detect completion from all twelve declared Brain-PAD artifacts.

        Require all seven CSV tables and all five figures to be readable,
        regular, non-empty files for ``done``. Report ``partial`` when only some
        artifacts are present and ``pending`` when none are present.

        Parameters
        ----------
        subject_id
            Ignore the value because the step is cohort-wide.

        Returns
        -------
        StepStatus
            Return the detected state with the present output files.
        """
        outdir = self._outdir(cfg)
        all_paths = [os.path.join(outdir, name) for name in OUTPUT_BASENAMES]
        present = [path for path in all_paths if file_nonempty(path)]

        if len(present) == len(all_paths):
            valid, detail = self._generation_manifest(outdir, all_paths)
            if not valid:
                return StepStatus(
                    state="failed",
                    detail=detail,
                    artifacts=present,
                )
            return StepStatus(
                state="done",
                detail=(
                    f"All {len(present)}/{len(all_paths)} Brain-PAD artifacts "
                    "are present."
                ),
                artifacts=present,
            )
        if present:
            return StepStatus(
                state="partial",
                detail=(
                    f"Create the remaining Brain-PAD artifacts; found "
                    f"{len(present)}/{len(all_paths)}."
                ),
                artifacts=present,
            )
        return StepStatus(
            state="pending",
            detail="Create the Brain-PAD artifacts.",
            artifacts=[],
        )

    @staticmethod
    def _generation_manifest(outdir: str, paths: list[str]) -> tuple[bool, str]:
        """Require one bounded manifest that digest-binds all twelve outputs."""
        manifest = os.path.join(outdir, MANIFEST_BASENAME)
        try:
            payload = read_bounded_regular(manifest, _MAX_MANIFEST_BYTES)
            value = json.loads(payload.decode("utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return False, "Rerun Brain-PAD to publish its complete output manifest."
        files = value.get("files") if isinstance(value, dict) else None
        if (
            not isinstance(value, dict)
            or set(value) != {"schemaVersion", "files"}
            or value.get("schemaVersion") != 1
            or not isinstance(files, list)
        ):
            return False, "Rerun Brain-PAD to repair its output manifest schema."
        if len(files) != len(paths):
            return False, "Rerun Brain-PAD to bind all twelve outputs."
        for record, path in zip(files, paths, strict=True):
            if error := BrainpadAdapter._manifest_record_error(record, path):
                return False, error
        return True, ""

    @staticmethod
    def _manifest_record_error(record: Any, path: str) -> str | None:
        """Return the exact repair diagnostic for one manifest-bound output."""
        if not isinstance(record, dict) or set(record) != {
            "name",
            "size",
            "sha256",
        }:
            return "Rerun Brain-PAD to repair its output manifest entries."
        try:
            digest, size = sha256_bounded_regular(path, _MAX_OUTPUT_BYTES)
        except OSError:
            return "Rerun Brain-PAD to restore bounded regular outputs."
        if (
            record.get("name") != os.path.basename(path)
            or record.get("size") != size
            or record.get("sha256") != digest
        ):
            return "Rerun Brain-PAD because an output changed after publication."
        return None

    def parse_failure(self, rc: int, stdout: str, stderr: str) -> Failure | None:
        """Map a non-zero exit into a structured Brain-PAD failure.

        Recognize the missing ``cliffs-delta`` dependency, a missing or
        unreadable input workbook, and missing expected columns, then falls back
        to the base classifier.

        Returns
        -------
        Failure or None
            Return the structured failure or ``None`` when ``rc`` is zero.
        """
        if rc == 0:
            return None
        blob = f"{stderr}\n{stdout}"
        if "cliffs_delta" in blob or "cliffs-delta" in blob:
            return Failure(
                code=rc,
                tag="missing_dependency",
                message=(
                    "Install cliffs-delta 1.0.0 in the configured analysis Python; "
                    "do not reuse the isolated PyBrainAge interpreter."
                ),
            )
        if "No such file" in blob or "FileNotFoundError" in blob:
            return Failure(
                code=rc,
                tag="missing_input",
                message="Provide a readable predicted_results.xlsx workbook.",
            )
        if any(
            needle in blob
            for needle in (
                "within 64 MiB",
                "within 256 MiB",
                "within 5000 rows",
                "within 1024 columns",
                "XLSX archive",
                "compression ratio",
            )
        ):
            return Failure(
                code=rc,
                tag="input_bounds",
                message="Reduce or repair the bounded Brain-PAD workbook input.",
            )
        if "KeyError" in blob or "not in index" in blob:
            return Failure(
                code=rc,
                tag="bad_template",
                message="Add every expected column to the analysis workbook.",
            )
        return super().parse_failure(rc, stdout, stderr)

    def validate(self, cfg: dict[str, Any], env: dict[str, Any]) -> Validation:
        """Return pre-run advisories for the analysis input workbook.

        Parameters
        ----------
        env
            Ignore the probed tool environment.

        Returns
        -------
        Validation
            Return an advisory when the input workbook is absent.
        """
        result = Validation()
        input_xlsx = self.resolve(INPUT_TEMPLATE, cfg)
        if not exists(input_xlsx):
            result.advisory.append(
                f"Provide the analysis workbook before running: {input_xlsx}."
            )
        return result


register(BrainpadAdapter())
