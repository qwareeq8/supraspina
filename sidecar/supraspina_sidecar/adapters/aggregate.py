"""Adapter for structural data aggregation (pipeline step ``aggregate``).

The stage drives the inventoried first-party
``resources/step8/aggregate_stats.py`` implementation, which parses FreeSurfer
``*.stats`` files and writes four cohort CSVs in one pass. The adapter supplies
the configured input and output directories and surfaces missing resources and
parse failures.

The default FreeSurfer 8.2 input produces ``dk_all_stats.csv`` with a
subject key, 612 cortical metrics, and available aseg volumes. The exact
columns derive from the parsed stats files while preserving the Step 9
``cortical_split`` 613 contract. The other outputs are
``cortical_thickness.csv``, ``icv_data.csv``, and ``wm_volumes.csv``. The step
reports ``done`` only when all four exist, are non-empty, and carry the header
columns the module writes.
"""

from __future__ import annotations

import csv
import io
import os
from typing import Any

from .. import resources
from ..bounded_io import read_regular_prefix
from . import tools
from .base import Adapter, Failure, StepStatus, register

#: Use this bundled first-party aggregation module.
MODULE_NAME = "aggregate_stats.py"

#: Detect completion from these four cohort CSVs.
_OUTPUT_CSVS: tuple[str, ...] = (
    "dk_all_stats.csv",
    "cortical_thickness.csv",
    "icv_data.csv",
    "wm_volumes.csv",
)

#: Require these leading header columns, in order, from each cohort CSV.
#: ``dk_all_stats.csv`` and ``wm_volumes.csv`` continue with the parsed
#: structure names, so only their subject key is fixed.
_REQUIRED_CSV_HEADERS: dict[str, tuple[str, ...]] = {
    "dk_all_stats.csv": ("subject",),
    "cortical_thickness.csv": ("subject", "lh_mean_thickness", "rh_mean_thickness"),
    "icv_data.csv": ("subject", "eTIV"),
    "wm_volumes.csv": ("subject",),
}

#: Read at most this much of a cohort CSV to recover its header row.
_MAX_HEADER_BYTES = 1024 * 1024

_NO_SUBJECTS_EXIT_CODE = 2
_AGGREGATION_FAILED_EXIT_CODE = 4


def _valid_cohort_csv(path: str, required_header: tuple[str, ...]) -> bool:
    """Report whether a cohort CSV starts with the header columns it must carry.

    Parameters
    ----------
    required_header
        Provide the leading header columns the aggregation module writes.

    Returns
    -------
    bool
        Return ``True`` only for a readable regular file whose first row starts
        with ``required_header`` and names at least one data column.
    """
    try:
        payload, _size, _truncated = read_regular_prefix(path, _MAX_HEADER_BYTES)
        text = payload.decode("utf-8-sig")
    except (OSError, UnicodeError):
        return False
    lines = text.splitlines()
    if not lines:
        return False
    try:
        header = next(csv.reader(io.StringIO(lines[0], newline="")), [])
    except csv.Error:
        return False
    return len(header) > 1 and tuple(header[: len(required_header)]) == required_header


class AggregateAdapter(Adapter):
    """Adapt cohort-wide Step 8 structural aggregation.

    Expose only the subject glob and output directory because the module takes
    no per-subject input. Build one Python command against the configured
    derivatives directory.
    """

    key = "aggregate"
    name = "Structural data aggregation"
    goal = (
        "Aggregate DK stats, cortical thickness, ICV, and white-matter volumes "
        "across the cohort."
    )
    advances = ("agg",)
    required_checks = ("aggregatepython", "aggregate_assets")

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the parameter schema mirroring ``steps.ts`` for this step.

        Expose only the GUI-wired path and glob parameters accepted by the
        aggregation module. Match the ``PIPELINE_STEPS['aggregate'].params``
        defaults exactly.
        """
        return {
            "subjectGlob": {
                "kind": "text",
                "default": "sub-*",
                "label": "Subject glob",
            },
            "outDir": {
                "kind": "path",
                "default": "${paths.outputDir}/structural",
                "must": "writable",
                "label": "Structural output directory",
            },
        }

    def _derivatives_dir(self, cfg: dict[str, Any]) -> str:
        """Resolve the FreeSurfer derivatives directory the module scans."""
        runtime = cfg.get("_supraspinaRuntime", {})
        view = runtime.get("freesurferView") if isinstance(runtime, dict) else None
        if isinstance(view, str) and view:
            return view
        return self.resolve("${paths.derivativesDir}/freesurfer", cfg)

    def _out_dir(self, cfg: dict[str, Any]) -> str:
        """Resolve the structural output directory for the four CSVs."""
        params = self.params(cfg)
        template = params.get("outDir", "${paths.outputDir}/structural")
        return self.resolve(str(template), cfg)

    def _module_path(self) -> str:
        """Resolve the absolute path to the bundled ``aggregate_stats.py``."""
        return str(resources.step8_dir() / MODULE_NAME)

    def _subject_glob(self, cfg: dict[str, Any]) -> str:
        """Resolve the subject glob from params, falling back to ``sub-*``."""
        params = self.params(cfg)
        return str(params.get("subjectGlob") or "sub-*")

    def _python(self, cfg: dict[str, Any]) -> str:
        """Resolve a Python interpreter for the stdlib aggregation module.

        Use any interpreter because the module depends only on the standard
        library. Prefer FreeSurfer's bundled ``fspython`` when it
        is present, then ``tools.pythonExecutable``, then a general Python
        interpreter. Never use a frozen sidecar executable as Python.
        """
        fs_home = self.resolve("${tools.freesurferHome}", cfg)
        if fs_home and "${" not in fs_home:
            fspython = os.path.join(fs_home, "bin", "fspython")
            if os.path.isfile(fspython):
                return fspython
        tool_python = self.resolve("${tools.pythonExecutable}", cfg)
        if tool_python and "${" not in tool_python:
            return tools.python_interpreter(tool_python) or "python3"
        return tools.python_interpreter() or "python3"

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the cohort-wide command for the bundled aggregation module.

        Read ``<derivativesDir>/freesurfer`` and write the four cohort CSVs into
        the configured structural output directory. Ignore ``subject_id``
        because the module discovers the cohort from the glob.

        Parameters
        ----------
        subject_id
            Ignore this value because aggregation runs over matching subjects.
        """
        del subject_id
        return [
            self._python(cfg),
            self._module_path(),
            "--subjects-dir",
            self._derivatives_dir(cfg),
            "--out-dir",
            self._out_dir(cfg),
            "--subject-glob",
            self._subject_glob(cfg),
        ]

    def members(self, cfg: dict[str, Any]) -> frozenset[str] | None:
        """Return the ``subject`` set of the intracranial-volume table."""
        return tools.read_csv_member_ids(
            os.path.join(self._out_dir(cfg), "icv_data.csv"), "subject"
        )

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        """Detect completion from the four cohort CSVs (output TYPE: CSV).

        Parameters
        ----------
        subject_id
            Ignore this value because the step produces one cohort-wide CSV set.

        Returns
        -------
        StepStatus
            Return ``done`` when all four CSVs exist, are non-empty, and start
            with the header columns the module writes, ``partial`` when some are
            missing or malformed, or ``pending`` when none exist.
        """
        out_dir = self._out_dir(cfg)
        present: list[str] = []
        missing: list[str] = []
        malformed: list[str] = []
        for name in _OUTPUT_CSVS:
            path = os.path.join(out_dir, name)
            if not tools.file_nonempty(path):
                missing.append(name)
            elif _valid_cohort_csv(path, _REQUIRED_CSV_HEADERS[name]):
                present.append(path)
            else:
                malformed.append(name)

        if not present and not malformed:
            return StepStatus(
                state="pending",
                detail="Create the structural CSVs.",
                artifacts=[],
            )
        if malformed:
            return StepStatus(
                state="partial",
                detail=(
                    f"Repair the malformed structural CSVs: {', '.join(malformed)}."
                ),
                artifacts=present,
            )
        if missing:
            return StepStatus(
                state="partial",
                detail=f"Create the missing structural CSVs: {', '.join(missing)}.",
                artifacts=present,
            )
        return StepStatus(
            state="done",
            detail="All four structural CSVs are present.",
            artifacts=present,
        )

    def parse_failure(self, rc: int, stdout: str, stderr: str) -> Failure | None:
        """Map a non-zero exit into a structured failure for Step 8.

        Recognize the bundled module's stable signatures: no subjects matching
        the glob with the required ``aparc``/``aseg`` stats (exit 2 / "no subjects
        matching"), and a parse/IO failure or a wrong derivatives path (exit 4 /
        "No such file or directory" / "aggregation failed"). Fall back to the
        base OOM/nonzero classification otherwise.

        Returns
        -------
        Failure or None
            Return a structured failure or ``None`` when ``rc`` is zero.
        """
        base = super().parse_failure(rc, stdout, stderr)
        if base is None:
            return None
        blob = f"{stdout}\n{stderr}"
        if rc == _NO_SUBJECTS_EXIT_CODE or "no subjects matching" in blob:
            return Failure(
                code=rc,
                tag="no_subjects",
                message=(
                    "Add subjects with lh/rh aparc and aseg stats under "
                    "derivatives/freesurfer that match the configured glob."
                ),
            )
        if (
            rc == _AGGREGATION_FAILED_EXIT_CODE
            or "No such file or directory" in blob
            or "aggregation failed" in blob
        ):
            return Failure(
                code=rc,
                tag="missing_input",
                message=(
                    "Provide the derivatives path and every required subject stats "
                    "file."
                ),
            )
        return base


register(AggregateAdapter())
