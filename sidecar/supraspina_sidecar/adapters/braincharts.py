"""Adapter for BrainCharts normative modeling (upstream Step 3 at ``eba4f59``).

``resources/braincharts/braincharts_run.py`` runs in the provisioned
BrainCharts environment (``braincharts_runtime``). It reads the ``features``
stage's ``concatenated_results.csv``, a run-scoped registry projection
(subject, age, sex, site label, and cohort; ``workflow_manager`` writes it),
and the ``lifespan_57K_82sites`` model, adapts the model to each site's
controls, and publishes one generation under ``${paths.outputDir}/braincharts``:
the z-score table the z-score stage reads (``final_r_contract.ZSCORES_FILE``),
the full test table, the per-region summary, the split report, each subject's
role, the refused sites, the run record, and a manifest binding all of them.

A site with fewer than 2 controls is refused and its subjects get no z-scores;
exactly 2 controls both adapt the model; 3 or more use upstream's split with
the recorded seed. Adaptation controls get no z-score, as upstream.
"""

from __future__ import annotations

import csv
import io
import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from .. import braincharts_runtime, resources
from ..bounded_io import read_bounded_regular, sha256_bounded_regular
from ..final_r_contract import (
    REFUSED_SITES_FILE,
    ZSCORE_ID_COLUMNS,
    ZSCORE_SUFFIX,
    ZSCORES_FILE,
)
from .base import Adapter, Failure, StepStatus, Validation, register

#: The run script, bound into every receipt as a scientific resource.
SCRIPT_PARTS = ("braincharts", "braincharts_run.py")

#: The output directory; generations sit beside it.
OUT_DIR_TEMPLATE = "${paths.outputDir}/braincharts"

#: The default seed of upstream's split, recorded in every run.
DEFAULT_SEED = 117
MAX_SEED = 2_147_483_647

#: The published outputs in manifest order, as ``(name, label, kind)``.
OUTPUT_ARTIFACTS: tuple[tuple[str, str, str], ...] = (
    (ZSCORES_FILE, "BrainCharts z-scores", "csv"),
    (
        "braincharts_test_with_zscores.csv",
        "BrainCharts test table with z-scores",
        "csv",
    ),
    ("braincharts_zscore_summary.csv", "BrainCharts z-score summary", "csv"),
    ("braincharts_split_report.csv", "BrainCharts split report", "csv"),
    ("braincharts_split.csv", "BrainCharts subject roles", "csv"),
    (REFUSED_SITES_FILE, "BrainCharts refused sites", "csv"),
    ("braincharts_run.json", "BrainCharts run record", "txt"),
)
OUTPUT_BASENAMES = tuple(name for name, _label, _kind in OUTPUT_ARTIFACTS)
SPLIT_FILE = "braincharts_split.csv"
SPLIT_COLUMNS = ("subject", "siteLabel", "cohort", "role", "reason")
MANIFEST_BASENAME = ".braincharts-generation.json"
#: The model's region count (the three phenotype lists' union).
REGION_COUNT = 187
#: Placeholders a preview shows when no run overlays its inputs.
PREVIEW_METADATA = "<run-scoped BrainCharts metadata>"
PREVIEW_WORK_DIR = "<run-scoped BrainCharts work directory>"

EXIT_INPUT = 2
EXIT_REGIONS = 3
EXIT_NO_SITE = 4
EXIT_MODEL = 5
EXIT_RUNTIME = 6
_EXIT_TAGS = {
    EXIT_INPUT: "input_invalid",
    EXIT_REGIONS: "regions_mismatch",
    EXIT_NO_SITE: "no_adaptable_site",
    EXIT_MODEL: "model_failed",
    EXIT_RUNTIME: "runtime_incomplete",
}
_MAX_MANIFEST_BYTES = 64 * 1024
_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
_MAX_LISTED = 3


def _read_csv(path: str) -> tuple[list[str], list[list[str]]]:
    payload = read_bounded_regular(path, _MAX_OUTPUT_BYTES)
    rows = list(csv.reader(io.StringIO(payload.decode("utf-8-sig"), newline="")))
    if not rows:
        raise ValueError(f"{os.path.basename(path)} is empty.")
    return rows[0], rows[1:]


def _listed(values: list[str]) -> str:
    shown = ", ".join(values[:_MAX_LISTED])
    more = len(values) - _MAX_LISTED
    return f"{shown}, and {more} more" if more > 0 else shown


class BrainChartsAdapter(Adapter):
    """Adapt the BrainCharts lifespan model per site and write z-scores."""

    key = "braincharts"
    name = "BrainCharts normative modeling"
    goal = (
        "Adapts the lifespan BrainCharts model to the controls of each site and "
        "writes per-region z-scores."
    )
    required_checks = ("bcenv", "bcmodel")

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the seed of the adaptation split, the stage's only setting."""
        return {
            "seed": {
                "kind": "int",
                "default": DEFAULT_SEED,
                "min": 0,
                "max": MAX_SEED,
                "label": "Adaptation split seed (upstream 117)",
            },
        }

    def seed(self, cfg: dict[str, Any]) -> int:
        """Return the configured split seed, or upstream's default."""
        value = self.params(cfg).get("seed", DEFAULT_SEED)
        if isinstance(value, bool) or not isinstance(value, int):
            return DEFAULT_SEED
        return value

    def out_dir(self, cfg: dict[str, Any]) -> str:
        """Return the published output directory."""
        return self.resolve(OUT_DIR_TEMPLATE, cfg)

    def features_csv(self, cfg: dict[str, Any]) -> str:
        """Return the ``features`` stage's table, honoring its output directory."""
        params = cfg.get("steps", {}).get("features", {}).get("params", {})
        template = (
            params.get("outDir") if isinstance(params, dict) else None
        ) or "${paths.outputDir}/features"
        return os.path.join(
            self.resolve(str(template), cfg), "concatenated_results.csv"
        )

    @staticmethod
    def _runtime_path(cfg: dict[str, Any], key: str, placeholder: str) -> str:
        runtime = cfg.get("_supraspinaRuntime")
        value = runtime.get(key) if isinstance(runtime, dict) else None
        return value if isinstance(value, str) and value else placeholder

    def validate(self, cfg: dict[str, Any], env: dict[str, Any]) -> Validation:
        """Name the platform limit before the two environment checks."""
        if not braincharts_runtime.platform_supported():
            return Validation(
                blocking=[braincharts_runtime.unsupported_platform_detail()]
            )
        return super().validate(cfg, env)

    @contextmanager
    def execution_lease(
        self, cfg: dict[str, Any], subject_id: str | None
    ) -> Iterator[None]:
        """Hold the setup shared for the run so no generation changes under it."""
        del subject_id
        with braincharts_runtime.execution_lease(cfg):
            yield

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the fixed argv of ``braincharts_run.py`` for the whole cohort."""
        del subject_id
        argv = [
            braincharts_runtime.env_python(cfg),
            "-I",
            "-B",
            str(resources.resource_dir(*SCRIPT_PARTS)),
            "--features",
            self.features_csv(cfg),
            "--metadata",
            self._runtime_path(cfg, "brainchartsMetadataFile", PREVIEW_METADATA),
            "--model-dir",
            braincharts_runtime.model_dir(cfg),
            "--model-archive",
            braincharts_runtime.archive_path(cfg),
            "--site-list",
            braincharts_runtime.list_path(cfg, braincharts_runtime.SITE_LIST),
        ]
        for pinned in braincharts_runtime.PHENOTYPE_LISTS:
            argv.extend(
                ["--phenotype-list", braincharts_runtime.list_path(cfg, pinned)]
            )
        argv.extend(
            [
                "--out-dir",
                self.out_dir(cfg),
                "--work-dir",
                self._runtime_path(cfg, "brainchartsWorkDir", PREVIEW_WORK_DIR),
                "--seed",
                str(self.seed(cfg)),
            ]
        )
        return argv

    @staticmethod
    def _expected_subject_ids(cfg: dict[str, Any]) -> tuple[str, ...] | None:
        runtime = cfg.get("_supraspinaRuntime")
        if not isinstance(runtime, dict):
            return None
        values = runtime.get("reconstructionViewSubjectIds")
        if not isinstance(values, list) or any(
            not isinstance(value, str) for value in values
        ):
            return None
        return tuple(values)

    def _manifest_error(self, out_dir: str) -> str | None:
        """Return why the manifest does not bind the outputs, or ``None``."""
        try:
            value = json.loads(
                read_bounded_regular(
                    os.path.join(out_dir, MANIFEST_BASENAME), _MAX_MANIFEST_BYTES
                ).decode("utf-8")
            )
        except (OSError, UnicodeError, json.JSONDecodeError):
            return "Rerun BrainCharts to publish its complete output manifest."
        files = value.get("files") if isinstance(value, dict) else None
        if (
            not isinstance(files, list)
            or value.get("schemaVersion") != 1
            or [
                record.get("name") if isinstance(record, dict) else None
                for record in files
            ]
            != list(OUTPUT_BASENAMES)
        ):
            return "Rerun BrainCharts to repair its output manifest."
        for record in files:
            try:
                digest, size = sha256_bounded_regular(
                    os.path.join(out_dir, str(record["name"])), _MAX_OUTPUT_BYTES
                )
            except OSError:
                return "Rerun BrainCharts to restore its outputs."
            if record.get("sha256") != digest or record.get("size") != size:
                return "Rerun BrainCharts because an output changed after publication."
        return None

    def roles(self, out_dir: str) -> dict[str, tuple[str, str]]:
        """Return each subject's ``(role, site)`` from the published split.

        The role is ``adaptation``, ``test``, or ``refused``. Raise
        ``OSError``, ``UnicodeError``, ``ValueError``, or ``csv.Error`` when
        the split is missing or malformed.
        """
        header, rows = _read_csv(os.path.join(out_dir, SPLIT_FILE))
        if tuple(header) != SPLIT_COLUMNS:
            raise ValueError("The subject-role table has another header.")
        roles: dict[str, tuple[str, str]] = {}
        for row in rows:
            if len(row) != len(SPLIT_COLUMNS) or row[3] not in {
                "adaptation",
                "test",
                "refused",
            }:
                raise ValueError("The subject-role table has a malformed row.")
            if row[0] in roles:
                raise ValueError(f"The subject-role table repeats {row[0]}.")
            roles[row[0]] = (row[3], row[1])
        return roles

    def members(self, cfg: dict[str, Any]) -> frozenset[str] | None:
        """Return every subject the published split covers, refused ones included."""
        try:
            return frozenset(self.roles(self.out_dir(cfg)))
        except (OSError, UnicodeError, ValueError, csv.Error):
            return None

    def detect(  # noqa: PLR0911
        self, cfg: dict[str, Any], subject_id: str | None
    ) -> StepStatus:
        """Detect the published generation and check it against the run cohort.

        ``done`` needs every output, a manifest that binds their bytes, the
        z-score table's contract header with 187 regions, one row per test
        subject, and, during a run, a split that covers exactly the analysis
        cohort.
        """
        del subject_id
        out_dir = self.out_dir(cfg)
        paths = [os.path.join(out_dir, name) for name in OUTPUT_BASENAMES]
        present = [path for path in paths if os.path.isfile(path)]
        if not present:
            return StepStatus(
                state="pending",
                detail=f"Create the BrainCharts z-scores under {out_dir}.",
            )
        if len(present) != len(paths):
            missing = [os.path.basename(path) for path in paths if path not in present]
            return StepStatus(
                state="partial",
                detail=f"Create the missing BrainCharts outputs: {', '.join(missing)}.",
                artifacts=present,
            )
        error = self._manifest_error(out_dir)
        if error is not None:
            return StepStatus(state="failed", detail=error, artifacts=present)
        try:
            roles = self.roles(out_dir)
            header, rows = _read_csv(paths[0])
        except (OSError, UnicodeError, ValueError, csv.Error) as exc:
            return StepStatus(
                state="partial",
                detail=f"Repair the BrainCharts outputs: {str(exc).rstrip('.')}.",
                artifacts=present,
            )
        id_columns = len(ZSCORE_ID_COLUMNS)
        z_columns = header[id_columns:]
        if (
            tuple(header[:id_columns]) != ZSCORE_ID_COLUMNS
            or len(z_columns) != REGION_COUNT
            or not all(column.endswith(ZSCORE_SUFFIX) for column in z_columns)
        ):
            return StepStatus(
                state="partial",
                detail=(
                    f"Use the z-score table header {', '.join(ZSCORE_ID_COLUMNS)} "
                    f"and {REGION_COUNT} region z-scores."
                ),
                artifacts=present,
            )
        scored = [row[0] for row in rows if row]
        tested = sorted(key for key, (role, _site) in roles.items() if role == "test")
        if sorted(scored) != tested:
            return StepStatus(
                state="partial",
                detail="Reconcile the z-score rows with the held-out subjects.",
                artifacts=present,
            )
        expected = self._expected_subject_ids(cfg)
        if expected is not None and set(expected) != set(roles):
            missing = sorted(set(expected) - set(roles))
            extra = sorted(set(roles) - set(expected))
            return StepStatus(
                state="partial",
                detail=(
                    "Reconcile the BrainCharts split with the analysis cohort: "
                    f"{len(missing)} missing, {len(extra)} extra subjects."
                ),
                artifacts=present,
            )
        adapted = sum(1 for role, _site in roles.values() if role == "adaptation")
        refused = sorted(
            key for key, (role, _site) in roles.items() if role == "refused"
        )
        detail = (
            f"Z-scores for {len(tested)} subjects; {adapted} controls adapt the "
            "model and get no z-score."
        )
        if refused:
            detail += f" {len(refused)} subjects get no z-scores: {_listed(refused)}."
        return StepStatus(state="done", detail=detail, artifacts=present)

    def parse_failure(self, rc: int, stdout: str, stderr: str) -> Failure | None:
        """Map the script's exit codes to tags and keep its closing sentence."""
        if rc == 0:
            return None
        tag = _EXIT_TAGS.get(rc)
        if tag is None:
            return super().parse_failure(rc, stdout, stderr)
        lines = [line.strip() for line in (stderr or stdout).splitlines()]
        message = next((line for line in reversed(lines) if line), "")
        return Failure(code=rc, tag=tag, message=message or f"Exit code {rc}.")


register(BrainChartsAdapter())
