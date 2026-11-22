"""Adapter for FreeSurfer feature extraction (pipeline step ``features``).

The stage drives the inventoried first-party ``extract_features.py`` module,
which runs FreeSurfer's ``aparcstats2table`` for each hemisphere and
``asegstats2table`` over the cohort, then assembles
``concatenated_results.csv``. The contract is ``ID`` plus 187 Destrieux
thickness and subcortical-volume features in PyBrainAge scaler order; the age
stage adds the 189th model-input column.

The argv-driven module reads the configured FreeSurfer subject layout and
honors the measure and parcellation parameters. The adapter builds the command,
detects the output contract, and parses failures.
"""

from __future__ import annotations

import csv
import io
import os
import posixpath
import shlex
import stat
from typing import Any

from .. import resources
from ..qc_store import valid_subject_id
from ..scientific_resources import CLEAN_HOST_ENV_PREFIX
from . import tools
from .base import Adapter, Failure, StepStatus, register
from .fastsurfer import FASTSURFER_BACKEND, selected_backend

#: Use this bundled self-contained feature-extraction module.
MODULE_NAME = "extract_features.py"

#: Use the pinned PyBrainAge feature template to validate exact column order.
TEMPLATE_NAME = "rois_input_template.txt"

#: Use this filename for the concatenated feature matrix.
CONCATENATED_NAME = "concatenated_results.csv"

#: Enforce the features-step contract: ``ID`` + 187 features (75 ``lh_*`` + 75
#: ``rh_*`` Destrieux cortical + 37 aseg volumes). Let the age step insert
#: ``Age`` as column 2 for the 189-column PyBrainAge model input. Assert this
#: contract only for the default ``aparc.a2009s`` thickness measure.
FEATURES_COLUMN_COUNT = 188

#: Use this header for the first concatenated-matrix column.
ID_COLUMN = "ID"

NOT_FOUND_EXIT_CODE = 127
_NO_SUBJECTS_EXIT_CODE = 2
_TOOL_MISSING_EXIT_CODE = 3
_TABLE_FAILED_EXIT_CODE = 4

_CONTAINER_SUBJECTS = "/supraspina/subjects"
_CONTAINER_OUTPUT = "/supraspina/output"
_CONTAINER_HELPER = "/supraspina/helper/extract_features.py"
_CONTAINER_LICENSE = "/supraspina/license/license.txt"
_NO_AUTOMATIC_MOUNTS = "hostfs,cwd,home"
_MAX_RECEIPT_VIEW_SUBJECTS = 5_000


class FeaturesAdapter(Adapter):
    """Adapt FreeSurfer Destrieux and subcortical feature extraction.

    Build the bundled ``extract_features.py`` command. Expose parameters valid
    for FreeSurfer 8.2.0. Detect completion from
    ``concatenated_results.csv`` against the 188-column feature-order contract.
    """

    key = "features"
    required_checks = ("features_assets",)
    name = "FreeSurfer feature extraction"
    goal = "Build the PyBrainAge feature matrix from Destrieux measures."
    advances = ("feat",)

    def required_check_ids(self, cfg: dict[str, Any]) -> tuple[str, ...]:
        """Require host FreeSurfer only for FreeSurfer-backed extraction."""
        if selected_backend(cfg) == FASTSURFER_BACKEND:
            return ("license", "features_assets")
        return (
            "fshome",
            "license",
            "featurepython",
            "aparcstats",
            "asegstats",
            *self.required_checks,
        )

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the editable parameter schema for this step.

        Mirror ``PIPELINE_STEPS['features'].params`` in ``steps.ts``. Expose only
        flags accepted by the installed tools: map ``parcellation`` to
        ``aparcstats2table --parc`` (``aparc.a2009s`` is required by the
        PyBrainAge feature contract, so changing it is flagged downstream),
        ``measure`` maps to
        ``--measure``; use ``outDir`` as the wrapper's ``-o`` target; and use
        ``validateFeatureOrder`` to toggle the 188-column feature-order check.

        Returns
        -------
        dict
            Return each parameter name mapped to its kind, default, label, and
            choice options.
        """
        return {
            "parcellation": {
                "kind": "choice",
                "default": "aparc.a2009s",
                "options": ["aparc.a2009s", "aparc.DKTatlas", "aparc"],
                "label": "Atlas (a2009s required by PyBrainAge; changing is flagged)",
            },
            "measure": {
                "kind": "choice",
                "default": "thickness",
                "options": ["thickness", "area", "volume"],
                "label": "aparcstats2table measure",
            },
            "outDir": {
                "kind": "path",
                "default": "${paths.outputDir}/features",
                "must": "writable",
                "label": "Feature output directory",
            },
            "validateFeatureOrder": {
                "kind": "bool",
                "default": True,
                "label": "Validate 188-column feature order (ID + 187)",
            },
        }

    def _out_dir(self, cfg: dict[str, Any]) -> str:
        """Resolve the concrete feature output directory from the config."""
        params = self.params(cfg)
        template = params.get("outDir") or "${paths.outputDir}/features"
        return self.resolve(str(template), cfg)

    def _module_path(self) -> str:
        """Resolve the absolute path to the bundled ``extract_features.py``."""
        return str(resources.features_dir() / MODULE_NAME)

    def _subjects_dir(self, cfg: dict[str, Any]) -> str:
        """Resolve the FreeSurfer ``SUBJECTS_DIR`` (``derivatives/freesurfer``).

        Use the canonical layout written by reconstruction and read by
        aggregation.
        """
        runtime = cfg.get("_supraspinaRuntime", {})
        view = runtime.get("freesurferView") if isinstance(runtime, dict) else None
        if isinstance(view, str) and view:
            return view
        return self.resolve("${paths.derivativesDir}/freesurfer", cfg)

    def _python(self, cfg: dict[str, Any]) -> str:
        """Resolve a Python interpreter for the stdlib extraction module.

        Prefer FreeSurfer's bundled ``fspython`` when present. Fall back to a
        general Python interpreter. Never use a frozen sidecar executable as
        Python.
        """
        fs_home = self.resolve("${tools.freesurferHome}", cfg)
        if fs_home and "${" not in fs_home:
            fspython = os.path.join(fs_home, "bin", "fspython")
            if os.path.isfile(fspython):
                return fspython
        return tools.python_interpreter() or "python3"

    def _subject_glob(self, cfg: dict[str, Any]) -> str:
        """Resolve the subject glob (default ``sub-*``)."""
        patterns = cfg.get("patterns", {})
        glob = patterns.get("subjectGlob") if isinstance(patterns, dict) else None
        return str(glob or "sub-*")

    @staticmethod
    def _mount(source: str, destination: str, mode: str) -> str:
        """Encode one Apptainer bind mount without shell interpolation."""
        if mode not in {"ro", "rw"}:
            raise ValueError("Select a valid container mount mode.")
        fields = ["type=bind", f"src={source}", f"dst={destination}"]
        if mode == "ro":
            fields.append("ro")
        stream = io.StringIO(newline="")
        csv.writer(stream, lineterminator="").writerow(fields)
        return stream.getvalue()

    @staticmethod
    def _runtime(cfg: dict[str, Any]) -> dict[str, Any]:
        value = cfg.get("_supraspinaRuntime", {})
        return value if isinstance(value, dict) else {}

    def _fastsurfer_subject_mount_args(self, cfg: dict[str, Any]) -> list[str]:
        """Bind each receipt-selected subject so host symlinks resolve safely.

        Bind each symlink entry so Apptainer resolves it on the host while
        retaining the exact receipt-selected view as the source boundary. Avoid
        mounting the whole view directory because its absolute targets are
        unavailable inside the SIF.

        Allow a missing view only for the non-authoritative Pipeline-tab
        preview. Require authoritative planning to create and validate a
        non-empty symlink view before command building.
        """
        view = self._subjects_dir(cfg)
        declared = self._runtime(cfg).get("reconstructionViewSubjectIds")
        if declared is not None:
            if (
                not isinstance(declared, list)
                or not declared
                or len(declared) > _MAX_RECEIPT_VIEW_SUBJECTS
                or len(set(declared)) != len(declared)
                or any(
                    not isinstance(subject_id, str)
                    or not subject_id.startswith("sub-")
                    or not valid_subject_id(subject_id)
                    for subject_id in declared
                )
            ):
                raise ValueError(
                    "Provide a valid receipt-selected reconstruction cohort."
                )
            return self._subject_mount_args(view, sorted(declared))

        try:
            with os.scandir(view) as iterator:
                entries = []
                for entry in iterator:
                    if len(entries) >= _MAX_RECEIPT_VIEW_SUBJECTS:
                        raise ValueError(
                            "Keep the receipt-selected reconstruction view within "
                            "its size bound."
                        )
                    entries.append(entry)
                entries.sort(key=lambda entry: entry.name)
        except FileNotFoundError:
            return ["--mount", self._mount(view, _CONTAINER_SUBJECTS, "ro")]
        except OSError as exc:
            raise ValueError(
                "Provide a readable receipt-selected reconstruction view."
            ) from exc
        if not entries:
            raise ValueError("Provide a valid receipt-selected reconstruction view.")

        for entry in entries:
            if (
                not entry.name.startswith("sub-")
                or not valid_subject_id(entry.name)
                or not entry.is_symlink()
                or not entry.is_dir(follow_symlinks=True)
            ):
                raise ValueError(
                    "Provide receipt-selected symlinks for FastSurfer Features."
                )
        return self._subject_mount_args(view, [entry.name for entry in entries])

    def _subject_mount_args(self, view: str, subject_ids: list[str]) -> list[str]:
        """Return one read-only container mount for each exact cohort entry."""
        mounts: list[str] = []
        for subject_id in subject_ids:
            mounts.extend(
                [
                    "--mount",
                    self._mount(
                        os.path.join(view, subject_id),
                        posixpath.join(_CONTAINER_SUBJECTS, subject_id),
                        "ro",
                    ),
                ]
            )
        return mounts

    def _license_path(self, cfg: dict[str, Any]) -> str:
        runtime = self._runtime(cfg)
        tool_cfg = cfg.get("tools", {})
        configured = (
            tool_cfg.get("freesurferLicense") if isinstance(tool_cfg, dict) else ""
        )
        path = self.resolve(
            str(runtime.get("freesurferLicensePath") or configured or ""),
            cfg,
        )
        if not path or "${" in path:
            raise ValueError("Provide the FreeSurfer license path.")
        return path

    def _fastsurfer_command(self, cfg: dict[str, Any]) -> list[str]:
        """Run the existing feature helper and FreeSurfer tools inside the SIF."""
        runtime = self._runtime(cfg)
        apptainer = self.resolve(
            str(runtime.get("apptainerExecutable") or "apptainer"),
            cfg,
        )
        sif = self.resolve(str(runtime.get("fastSurferSifPath") or ""), cfg)
        if not sif or "${" in sif:
            raise ValueError("Provide the verified FastSurfer SIF path.")
        license_path = self._license_path(cfg)
        params = self.params(cfg)
        argv = [
            *CLEAN_HOST_ENV_PREFIX,
            apptainer,
            "exec",
            "--cleanenv",
            "--containall",
            "--no-home",
            "--no-mount",
            _NO_AUTOMATIC_MOUNTS,
            "--cwd",
            "/",
            "--net",
            "--network",
            "none",
            "--env",
            f"FS_LICENSE={_CONTAINER_LICENSE}",
            *self._fastsurfer_subject_mount_args(cfg),
            "--mount",
            self._mount(self._out_dir(cfg), _CONTAINER_OUTPUT, "rw"),
            "--mount",
            self._mount(self._module_path(), _CONTAINER_HELPER, "ro"),
            "--mount",
            self._mount(license_path, _CONTAINER_LICENSE, "ro"),
            sif,
            "/venv/bin/python3",
            _CONTAINER_HELPER,
            "--subjects-dir",
            _CONTAINER_SUBJECTS,
            "--out-dir",
            _CONTAINER_OUTPUT,
            "--parc",
            str(params.get("parcellation", "aparc.a2009s")),
            "--measure",
            str(params.get("measure", "thickness")),
            "--subject-glob",
            self._subject_glob(cfg),
            "--aparcstats2table",
            "/opt/freesurfer/bin/aparcstats2table",
            "--asegstats2table",
            "/opt/freesurfer/bin/asegstats2table",
        ]
        return argv

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the argv for the Step 3 feature-extraction module.

        Pass ``--subjects-dir``, ``--out-dir``, ``--parc``,
        ``--measure``, and ``--subject-glob``; when ``freesurferHome`` is set it
        is also handed the absolute ``aparcstats2table`` / ``asegstats2table``
        paths so a frozen build never depends on PATH. Ignore ``subject_id``
        because the module discovers the cohort.

        Parameters
        ----------
        subject_id
            Ignore this value because extraction runs over the whole cohort.
        """
        del subject_id
        if selected_backend(cfg) == FASTSURFER_BACKEND:
            return self._fastsurfer_command(cfg)
        params = self.params(cfg)
        argv = [
            self._python(cfg),
            self._module_path(),
            "--subjects-dir",
            self._subjects_dir(cfg),
            "--out-dir",
            self._out_dir(cfg),
            "--parc",
            str(params.get("parcellation", "aparc.a2009s")),
            "--measure",
            str(params.get("measure", "thickness")),
            "--subject-glob",
            self._subject_glob(cfg),
        ]
        fs_home = self.resolve("${tools.freesurferHome}", cfg)
        if fs_home and "${" not in fs_home:
            argv += [
                "--aparcstats2table",
                os.path.join(fs_home, "bin", "aparcstats2table"),
                "--asegstats2table",
                os.path.join(fs_home, "bin", "asegstats2table"),
            ]
        return argv

    def preview(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        """Return the exact plan while redacting the user-managed license path."""
        argv = self.build_command(cfg, subject_id)
        if selected_backend(cfg) == FASTSURFER_BACKEND:
            license_path = self._license_path(cfg)
            argv = [value.replace(license_path, "[FS_LICENSE]") for value in argv]
        return shlex.join(argv)

    def prepare_execution(self, cfg: dict[str, Any], subject_id: str | None) -> None:
        """Create only the Features output directory needed for a bind mount."""
        del subject_id
        if selected_backend(cfg) != FASTSURFER_BACKEND:
            return
        output = self._out_dir(cfg)
        try:
            os.makedirs(output, exist_ok=True)
            info = os.lstat(output)
        except OSError as exc:
            raise OSError("Create the Features output directory.") from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise NotADirectoryError("Use a directory for the Features output path.")

    def members(self, cfg: dict[str, Any]) -> frozenset[str] | None:
        """Return the ``ID`` set of the concatenated feature table."""
        return tools.read_csv_member_ids(
            os.path.join(self._out_dir(cfg), CONCATENATED_NAME), ID_COLUMN
        )

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        """Detect completion from the concatenated feature CSV on disk.

        Treat the output as one ``concatenated_results.csv`` file.
        Require the file to exist, be non-empty, and carry the exact 188-column
        header (``ID`` + 187 features) in pinned PyBrainAge order. Let the Age
        stage add the separate age column later. Report a present file with an
        invalid default-contract header as ``partial``. Report an absent file
        as ``pending``.

        Parameters
        ----------
        subject_id
            Ignore this value because the detector is cohort-wide.

        Returns
        -------
        StepStatus
            Return ``done``, ``partial``, or ``pending`` with the real artifact
            path.
        """
        del subject_id
        out_dir = self._out_dir(cfg)
        csv_path = os.path.join(out_dir, CONCATENATED_NAME)
        if not tools.file_nonempty(csv_path):
            return StepStatus(
                state="pending",
                detail=f"Create {CONCATENATED_NAME} in {out_dir}.",
                artifacts=[],
            )
        header = self._read_header(csv_path)
        column_count = len(header)
        params = self.params(cfg)
        is_default = (
            str(params.get("measure", "thickness")) == "thickness"
            and str(params.get("parcellation", "aparc.a2009s")) == "aparc.a2009s"
        )
        if is_default:
            if column_count != FEATURES_COLUMN_COUNT:
                return StepStatus(
                    state="partial",
                    detail=(
                        f"Restore the aparc.a2009s thickness contract: "
                        f"{CONCATENATED_NAME} has {column_count} columns; expect "
                        f"{FEATURES_COLUMN_COUNT} (ID + 187 features)."
                    ),
                    artifacts=[csv_path],
                )
            expected = self._expected_default_header()
            if len(expected) != FEATURES_COLUMN_COUNT:
                return StepStatus(
                    state="partial",
                    detail="Restore the valid PyBrainAge feature-order template.",
                    artifacts=[csv_path],
                )
            if header != expected:
                mismatch = next(
                    index
                    for index, (actual, wanted) in enumerate(
                        zip(header, expected, strict=True)
                    )
                    if actual != wanted
                )
                return StepStatus(
                    state="partial",
                    detail=(
                        "Restore the pinned PyBrainAge feature order: "
                        f"{CONCATENATED_NAME} column {mismatch + 1} is "
                        f"{header[mismatch]!r}; expect {expected[mismatch]!r}."
                    ),
                    artifacts=[csv_path],
                )
        if not header or header[0] != ID_COLUMN:
            found = header[0] if header else None
            return StepStatus(
                state="partial",
                detail=(
                    f"Use {ID_COLUMN!r} as the first {CONCATENATED_NAME} "
                    f"column instead of {found!r}."
                ),
                artifacts=[csv_path],
            )
        return StepStatus(
            state="done",
            detail=f"{CONCATENATED_NAME} has {column_count} columns.",
            artifacts=[csv_path],
        )

    @staticmethod
    def _read_header(csv_path: str) -> list[str]:
        """Return the header row of a comma- or tab-separated table.

        Accept the comma-separated feature matrix and the tab-separated pinned
        feature template. Choose the delimiter from the first row.

        Parameters
        ----------
        csv_path
            Provide the path to the concatenated feature table.

        Returns
        -------
        list of str
            Return the header fields or an empty list when reading fails.
        """
        try:
            with open(csv_path, newline="", encoding="utf-8") as handle:
                first = handle.readline()
        except OSError:
            return []
        if not first:
            return []
        delimiter = "\t" if first.count("\t") > first.count(",") else ","
        return next(csv.reader([first], delimiter=delimiter), [])

    def _expected_default_header(self) -> list[str]:
        """Build the exact FreeSurfer-style header from the pinned ROI template.

        Remove the Age field that Step 4 inserts. Convert the scaler's ``&`` and
        ``-Proper`` spellings back to the FreeSurfer names emitted by Step 3.
        """
        template = str(resources.features_dir() / TEMPLATE_NAME)
        header = self._read_header(template)
        if len(header) != FEATURES_COLUMN_COUNT + 1 or header[:2] != ["ID", "Age"]:
            return []
        features = [
            name.replace("&", "_and_")
            .replace("Left-Thalamus-Proper", "Left-Thalamus")
            .replace("Right-Thalamus-Proper", "Right-Thalamus")
            for name in header[2:]
        ]
        return [ID_COLUMN, *features]

    def parse_failure(self, rc: int, stdout: str, stderr: str) -> Failure | None:
        """Map a non-zero exit into a structured failure.

        Recognize the extraction module's stable stderr signatures: no subjects
        matching the glob with the required stats (exit 2), a FreeSurfer
        ``*stats2table`` binary not found (exit 3, or the not-found exit code when
        the binary is off ``PATH``), and a ``*stats2table`` call that itself
        failed (exit 4).

        Returns
        -------
        Failure or None
            Return a structured failure or ``None`` when ``rc`` is zero.
        """
        if rc == 0:
            return None
        blob = f"{stderr}\n{stdout}".lower()
        if rc == _NO_SUBJECTS_EXIT_CODE or "no subjects matching" in blob:
            return Failure(
                code=rc,
                tag="no_subjects",
                message=(
                    "Add subjects with lh/rh and aseg stats under "
                    "derivatives/freesurfer that match the configured glob."
                ),
            )
        if (
            "not found on path" in blob
            or "not found at" in blob
            or "command not found" in blob
            or rc in {_TOOL_MISSING_EXIT_CODE, NOT_FOUND_EXIT_CODE}
        ):
            return Failure(
                code=rc,
                tag="freesurfer_not_sourced",
                message=(
                    "Set tools.freesurferHome or source FreeSurfer so "
                    "aparcstats2table and asegstats2table are available."
                ),
            )
        if rc == _TABLE_FAILED_EXIT_CODE or "failed:" in blob:
            return Failure(
                code=rc,
                tag="stats_table_failed",
                message="Inspect the failed FreeSurfer stats2table call.",
            )
        return super().parse_failure(rc, stdout, stderr)


register(FeaturesAdapter())
