"""Adapter for the PyBrainAge prediction step with the pinned ExtraTrees model.

The bundled, argv-driven ``predict.py`` runs under a Python 3.7 conda
environment with ``scikit-learn=0.24.2``, ``pandas=1.3.4``, and ``numpy=1.20.3``.
It reads ``subject_features.csv`` as ``ID``, chronological ``Age``, and 187
Destrieux features, loads ``ExtraTreesModel`` and ``scaler.pkl``, applies the
scaler with an ROI-name retry when required, optionally retries prediction
row by row, and writes ``predicted_results.csv`` with exactly
``ID,Age,BrainAge,BrainPAD``, where ``BrainPAD = BrainAge - Age``.

The adapter builds ``predict.py`` argv from resolved project paths without
reimplementing the model, and detects completion from the real
``predicted_results.csv`` artifact and its ``BrainPAD`` column.

:func:`provision` plans first-run provisioning, and :func:`execute_provision`
runs that plan when the caller authorizes side effects: it creates the
micromamba environment, fetches and verifies the pinned ``PyBrainAge.zip``
Zenodo asset for DOI ``10.5281/zenodo.10406573``, extracts both pickle
artifacts, and validates a synthetic one-row prediction.
"""

from __future__ import annotations

import copy
import csv
import fcntl
import hashlib
import json
import math
import os
import platform
import shutil
import stat
import sys
import tempfile
import time
import uuid
import zipfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any

from .. import resources
from . import tools
from .analysis_python import pybrainage_env_dir, pybrainage_env_python
from .base import Adapter, Failure, StepStatus, register

# -- Provisioning constants (verified against the README + Zenodo record) -------

#: Pin the conda packages listed by the upstream README and ``environment.yaml``.
PYBRAINAGE_PYTHON: str = "3.7"
PYBRAINAGE_PYTHON_PATCH: str = "3.7.12"
PYBRAINAGE_SKLEARN: str = "0.24.2"
PYBRAINAGE_PANDAS: str = "1.3.4"
PYBRAINAGE_NUMPY: str = "1.20.3"
#: Use the reviewed conda-forge release built for Python 3.7 on each supported OS.
PYBRAINAGE_OPENPYXL: str = "3.0.10"

#: Keep the existing Step 7 runtime set while binding every selected artifact in
#: the committed Linux x86_64 explicit lock.
PYBRAINAGE_RUNTIME_VERSIONS: dict[str, str] = {
    "python": PYBRAINAGE_PYTHON_PATCH,
    "numpy": PYBRAINAGE_NUMPY,
    "pandas": PYBRAINAGE_PANDAS,
    "sklearn": PYBRAINAGE_SKLEARN,
    "scipy": "1.7.3",
    "openpyxl": PYBRAINAGE_OPENPYXL,
    "matplotlib": "3.5.3",
    "seaborn": "0.12.2",
    "statsmodels": "0.13.2",
    "pip": "24.0",
    "cliffs-delta": "1.0.0",
}

#: Run only this micromamba release for both Diagnostics and provisioning.
MICROMAMBA_VERSION: str = "2.7.0"
MICROMAMBA_SHA256: str = (
    "fb4554d61a1c567726890169e39c41aa8495dbba56f50957ee7356572b6c5726"
)

#: Bind the exact committed lock inputs copied into the app-owned provision root.
PYBRAINAGE_ENV_LOCK_SHA256: str = (
    "4151b34d5839611d046c48d29ed9c9728ee42805ac119c76442ae792dd354790"
)
PYBRAINAGE_PIP_LOCK_SHA256: str = (
    "67c9b8b69aa0d76133b881b39d7bf21e0d98b9bdc6dd3a2fd3e3787804e6466e"
)
PYBRAINAGE_ENV_LOCK_NAME = "pybrainage-linux-64.lock"
PYBRAINAGE_PIP_LOCK_NAME = "cliffs-delta-requirements.txt"

#: Use the versioned PyBrainAge v3 Zenodo DOI and its single CC-BY-4.0 asset.
PYBRAINAGE_ZENODO_DOI: str = "10.5281/zenodo.10406573"
PYBRAINAGE_ZENODO_RECORD: str = "10406573"
PYBRAINAGE_ZENODO_ASSET: str = "PyBrainAge.zip"
PYBRAINAGE_ZENODO_URL: str = f"https://zenodo.org/records/{PYBRAINAGE_ZENODO_RECORD}/files/{PYBRAINAGE_ZENODO_ASSET}"
#: Record the 108,063,062-byte archive size as informational metadata. The
#: provenance review cross-checks Zenodo's published MD5; runtime integrity uses
#: the pinned SHA-256 below.
PYBRAINAGE_ZENODO_BYTES: int = 108_063_062
#: Pin the SHA-256 of the versioned Zenodo asset whose MD5 matches Zenodo's.
#: Default both provisioning entry points to this digest and verify before unpacking.
PYBRAINAGE_ZENODO_SHA256: str = (
    "c9e2ba3899b8005fba4b9b0991292c6e76de112595473c3e9e0e5b11e0308a95"
)

#: Find these pickled artifacts inside the unpacked ``software/`` directory.
PYBRAINAGE_MODEL_FILE: str = "ExtraTreesModel"
PYBRAINAGE_SCALER_FILE: str = "scaler.pkl"

#: Enforce this exact four-column output-table contract.
PREDICTED_COLUMNS: tuple[str, ...] = ("ID", "Age", "BrainAge", "BrainPAD")

_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
_MAX_ARCHIVE_MEMBERS = 10_000
_MAX_MEMBER_BYTES = 1024 * 1024 * 1024
_MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
_MAX_COMPRESSION_RATIO = 1_000
_MAX_PREDICTION_BYTES = 64 * 1024 * 1024
_MAX_PREDICTION_ROWS = 1_000_000
#: Most subjects the unknown-age completion detail lists by ID.
_MAX_LISTED_IDS = 20
_MAX_LOCK_BYTES = 128 * 1024
_MAX_STATE_BYTES = 256 * 1024
# A conda package record lists every installed path, so the bound must clear the
# largest record the committed lock installs; qt-main-5.15.8-h5d23da1_6.json is
# about 5.6 MiB.
_MAX_CONDA_RECORD_BYTES = 16 * 1024 * 1024
_MAX_CONDA_METADATA_ENTRIES = 1_024
_PROVISION_STATE_VERSION = 2
_MIN_PROVISION_FREE_BYTES = 5 * 1024 * 1024 * 1024
_GENERATION_NAME_LENGTH = 32

_RUNTIME_PROBE_SCRIPT = (
    "import json, sys\n"
    "import cliffs_delta, matplotlib, numpy, openpyxl, pandas, pip\n"
    "import scipy, seaborn, sklearn, statsmodels\n"
    "import pkg_resources\n"
    "print(json.dumps({\n"
    "  'python': '.'.join(map(str, sys.version_info[:3])),\n"
    "  'numpy': numpy.__version__, 'pandas': pandas.__version__,\n"
    "  'sklearn': sklearn.__version__, 'scipy': scipy.__version__,\n"
    "  'openpyxl': openpyxl.__version__, 'matplotlib': matplotlib.__version__,\n"
    "  'seaborn': seaborn.__version__, 'statsmodels': statsmodels.__version__,\n"
    "  'pip': pip.__version__,\n"
    "  'cliffs-delta': pkg_resources.get_distribution('cliffs-delta').version,\n"
    "}, sort_keys=True))\n"
)


class PyBrainAgeAdapter(Adapter):
    """Adapt the PyBrainAge ExtraTrees brain-age prediction step.

    Build the ``predict.py`` command inside the provisioned Python 3.7
    environment. Detect ``predicted_results.csv`` against its exact
    ``ID,Age,BrainAge,BrainPAD`` CSV contract. Parse the model, scaler, and
    feature failure signatures raised by the script.
    """

    key = "pybrainage"
    required_checks = (
        "pyenv",
        "pybrainpython",
        "modelfile",
        "scalerfile",
        "pybrainage_assets",
    )
    name = "PyBrainAge prediction"
    goal = (
        "Predict BrainAge + Brain-PAD (BrainAge - Age) for every subject using "
        "the pinned ExtraTrees model."
    )
    advances = ("pba",)

    # -- Path templates (mirror steps.ts inputs/outputs) -----------------------

    features_template = "${paths.outputDir}/features/subject_features.csv"
    #: Write this exact four-column prediction table.
    output_template = "${paths.outputDir}/pybrainage/predicted_results.csv"
    model_template = "${pybrain.modelPath}"
    scaler_template = "${pybrain.scalerPath}"

    # -- Required hooks --------------------------------------------------------

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the editable parameter schema for this step.

        Expose only parameters meaningful for the reviewed PyBrainAge stack.
        Mirror ``steps.ts`` names and defaults exactly.

        Returns
        -------
        dict
            Return each parameter name mapped to its ``kind``, ``default``,
            ``label``, and path ``must`` constraint.
        """
        return {
            "pythonExecutable": {
                "kind": "path",
                "default": "",
                "must": "any",
                "label": "PyBrainAge env python (provisioned)",
            },
            "modelPath": {
                "kind": "path",
                "default": "${pybrain.modelPath}",
                "must": "exist",
                "label": "ExtraTreesModel path",
            },
            "scalerPath": {
                "kind": "path",
                "default": "${pybrain.scalerPath}",
                "must": "exist",
                "label": "scaler.pkl path",
            },
            "rowFallback": {
                "kind": "bool",
                "default": True,
                "label": "Row-by-row predict fallback",
            },
        }

    def _python(self, cfg: dict[str, Any]) -> str:
        """Return only the published, provisioned compatibility interpreter.

        Returns
        -------
        str
            Return the canonical interpreter below the atomic current generation.
        """
        return env_python(cfg)

    @contextmanager
    def execution_lease(
        self, cfg: dict[str, Any], subject_id: str | None
    ) -> Iterator[None]:
        """Hold a shared provision lock and revalidate provenance before launch."""
        del subject_id
        with _provision_lock(cfg, exclusive=False):
            valid, detail = provision_state_status(cfg)
            if not valid:
                raise RuntimeError(detail)
            runtime, _versions = probe_runtime_versions(cfg, python=env_python(cfg))
            if runtime.rc != 0:
                message = (runtime.stderr or runtime.stdout).strip()
                raise RuntimeError(
                    "Reprovision PyBrainAge because its live runtime check failed: "
                    f"{message}"
                )
            yield

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the argv that runs ``predict.py`` on the cohort feature table.

        Predict the whole cohort at once from ``subject_features.csv``. Accept
        ``subject_id`` for signature parity without changing the command.

        Parameters
        ----------
        subject_id
            Ignore this value because the model runs cohort-wide.

        Returns
        -------
        list of str
            Return ``[python, predict.py, --features ..., --model ...,
            --scaler ..., --output ...]`` plus ``--row-fallback`` when enabled.
        """
        del subject_id
        params = self.params(cfg)
        argv = [
            self._python(cfg),
            str(resources.pybrainage_dir() / "predict.py"),
            "--features",
            self.resolve(self.features_template, cfg),
            "--template",
            str(resources.features_dir() / "rois_input_template.txt"),
            "--model",
            model_path(cfg),
            "--scaler",
            scaler_path(cfg),
            "--output",
            self.resolve(self.output_template, cfg),
        ]
        if bool(params.get("rowFallback", True)):
            argv.append("--row-fallback")
        return argv

    @staticmethod
    def _expected_subject_ids(cfg: dict[str, Any]) -> tuple[str, ...] | None:
        """Return the exact run cohort when detection is run-scoped."""
        runtime = cfg.get("_supraspinaRuntime")
        if (
            not isinstance(runtime, dict)
            or "reconstructionViewSubjectIds" not in runtime
        ):
            return None
        values = runtime.get("reconstructionViewSubjectIds")
        if not isinstance(values, list) or any(
            not isinstance(value, str) for value in values
        ):
            return ()
        return tuple(values)

    @staticmethod
    def _prediction_table(path: str) -> tuple[list[str], list[str], list[str]]:
        """Read one bounded prediction CSV header and subject-ID column.

        A subject without a chronological age carries an empty ``Age`` cell and
        an empty ``BrainPAD`` cell, because Brain-PAD is undefined without an
        age. Its ``BrainAge`` prediction stays required.

        Parameters
        ----------
        path
            Provide the candidate ``predicted_results.csv`` path.

        Returns
        -------
        tuple of list of str
            Return the exact header, the ordered IDs, and the ordered IDs left
            without a chronological age.

        Raises
        ------
        OSError
            Raise when the file cannot be inspected.
        ValueError
            Raise when its size, row count, or row shape exceeds the contract.
        """
        if os.path.getsize(path) > _MAX_PREDICTION_BYTES:
            raise ValueError("Reduce the prediction CSV below the bounded size limit.")
        with open(path, newline="", encoding="utf-8-sig") as handle:
            reader = csv.reader(handle)
            header = next(reader, [])
            if header != list(PREDICTED_COLUMNS):
                return header, [], []
            ids: list[str] = []
            unknown_age: list[str] = []
            for index, row in enumerate(reader):
                if index >= _MAX_PREDICTION_ROWS:
                    raise ValueError("Reduce the prediction CSV row count.")
                if len(row) != len(PREDICTED_COLUMNS):
                    raise ValueError(
                        "Provide exactly four columns in every prediction row."
                    )
                subject_id = row[0].strip()
                if PyBrainAgeAdapter._row_lacks_age(row, subject_id):
                    unknown_age.append(subject_id)
                ids.append(subject_id)
        return header, ids, unknown_age

    @staticmethod
    def _row_lacks_age(row: list[str], subject_id: str) -> bool:
        """Validate one prediction row and report whether its age is absent.

        Parameters
        ----------
        row
            Provide the four ``ID,Age,BrainAge,BrainPAD`` cells.
        subject_id
            Provide the stripped subject ID for the error messages.

        Returns
        -------
        bool
            Return whether the row carries neither an age nor a Brain-PAD.

        Raises
        ------
        ValueError
            Raise when a cell is non-numeric or nonfinite, when exactly one of
            ``Age`` and ``BrainPAD`` is empty, or when a populated row breaks
            the ``BrainPAD = BrainAge - Age`` identity.
        """
        age_text, brain_age_text, brain_pad_text = (value.strip() for value in row[1:])
        try:
            brain_age = float(brain_age_text)
        except ValueError as exc:
            raise ValueError(
                "Provide numeric Age, BrainAge, and BrainPAD values."
            ) from exc
        if not math.isfinite(brain_age):
            raise ValueError("Provide finite Age, BrainAge, and BrainPAD values.")
        if not age_text and not brain_pad_text:
            return True
        if not age_text or not brain_pad_text:
            raise ValueError(
                "Leave Age and BrainPAD both empty for a subject without a "
                f"chronological age: {subject_id}."
            )
        try:
            age, brain_pad = float(age_text), float(brain_pad_text)
        except ValueError as exc:
            raise ValueError(
                "Provide numeric Age, BrainAge, and BrainPAD values."
            ) from exc
        if not math.isfinite(age) or not math.isfinite(brain_pad):
            raise ValueError("Provide finite Age, BrainAge, and BrainPAD values.")
        if not math.isclose(brain_pad, brain_age - age, rel_tol=1e-9, abs_tol=1e-9):
            raise ValueError("Use BrainPAD = BrainAge - Age in every prediction row.")
        return False

    def members(self, cfg: dict[str, Any]) -> frozenset[str] | None:
        """Return the ``ID`` set of ``predicted_results.csv``."""
        return tools.read_csv_member_ids(self.resolve(self.output_template, cfg), "ID")

    def detect(  # noqa: PLR0911
        self, cfg: dict[str, Any], subject_id: str | None
    ) -> StepStatus:
        """Detect completion from the real ``predicted_results.csv`` artifact.

        Confirm the exact ``ID,Age,BrainAge,BrainPAD`` column order and require
        non-empty, unique IDs. Require those IDs to equal the exact post-QC
        analysis cohort during a run. Accept the empty ``Age`` and ``BrainPAD``
        pair of a subject without a chronological age, and name those subjects
        in the ``done`` detail.

        Parameters
        ----------
        subject_id
            Ignore this value because the artifact is cohort-wide.

        Returns
        -------
        StepStatus
            Return ``done`` with the artifact when the prediction table is
            exact, ``partial`` when its schema or run membership differs, or
            ``pending`` otherwise.
        """
        del subject_id
        output_path = self.resolve(self.output_template, cfg)
        if not tools.file_nonempty(output_path):
            if tools.exists(output_path):
                return StepStatus(
                    state="partial",
                    detail="Provide a non-empty predicted_results.csv file.",
                    artifacts=[output_path],
                )
            return StepStatus(
                state="pending",
                detail="Create predicted_results.csv before detecting completion.",
            )
        try:
            header, ids, unknown_age = self._prediction_table(output_path)
        except (OSError, UnicodeError, csv.Error, ValueError) as exc:
            return StepStatus(
                state="partial",
                detail=(
                    "Repair the invalid predicted_results.csv file: "
                    f"{str(exc).rstrip('.')}."
                ),
                artifacts=[output_path],
            )
        expected_header = list(PREDICTED_COLUMNS)
        if header != expected_header:
            return StepStatus(
                state="partial",
                detail=(
                    "Use this exact predicted_results.csv schema: "
                    + ",".join(PREDICTED_COLUMNS)
                ),
                artifacts=[output_path],
            )
        duplicates = len(ids) - len(set(ids))
        if not ids or any(not value for value in ids):
            return StepStatus(
                state="partial",
                detail="Provide one non-empty ID in every predicted_results.csv row.",
                artifacts=[output_path],
            )
        expected = self._expected_subject_ids(cfg)
        if expected == ():
            return StepStatus(
                state="partial",
                detail=(
                    "Provide the run-scoped analysis cohort for prediction validation."
                ),
                artifacts=[output_path],
            )
        missing = sorted(set(expected or ()) - set(ids))
        extras = sorted(set(ids) - set(expected or ())) if expected is not None else []
        if duplicates or (expected is not None and (missing or extras)):
            return StepStatus(
                state="partial",
                detail=(
                    "Reconcile the predicted_results.csv cohort: "
                    f"{len(missing)} missing, {len(extras)} extra, "
                    f"{duplicates} duplicate IDs."
                ),
                artifacts=[output_path],
            )
        detail = "Confirm predicted_results.csv uses the exact schema"
        if expected is not None:
            detail += f" and contains {len(expected)} expected subjects"
        detail += "."
        if unknown_age:
            listed = ", ".join(unknown_age[:_MAX_LISTED_IDS])
            tail = ", ..." if len(unknown_age) > _MAX_LISTED_IDS else "."
            detail += (
                f" Brain-PAD is empty for {len(unknown_age)} subject(s) without "
                f"a chronological age: {listed}{tail}"
            )
        return StepStatus(state="done", detail=detail, artifacts=[output_path])

    def parse_failure(self, rc: int, stdout: str, stderr: str) -> Failure | None:
        """Map a non-zero exit into a PyBrainAge-specific failure.

        Recognize the ``ValueError`` signatures raised by ``predict.py`` for
        missing data, infinite values, non-numeric features, scaler or feature
        name mismatches, row failures, and missing inputs.

        Returns
        -------
        Failure or None
            Return a tagged failure on non-zero exit or ``None`` on success.
        """
        if rc == 0:
            return None
        blob = f"{stderr}\n{stdout}".lower()
        signatures = (
            ("missing data in the dataframe", "missing_data"),
            ("infinite value", "infinite_value"),
            ("non-numeric data", "non_numeric_data"),
            ("scaler application fails", "scaler_mismatch"),
            ("failed at row", "row_predict_failed"),
            ("no such file", "missing_input"),
            ("filenotfounderror", "missing_input"),
            ("modulenotfounderror", "env_not_provisioned"),
            ("inconsistentversionwarning", "pickle_version_mismatch"),
        )
        for needle, tag in signatures:
            if needle in blob:
                message = self._last_line(stderr, stdout)
                return Failure(code=rc, tag=tag, message=message)
        return super().parse_failure(rc, stdout, stderr)

    @staticmethod
    def _last_line(stderr: str, stdout: str) -> str:
        """Return the last non-empty line of stderr (else stdout)."""
        tail = (stderr or stdout or "").strip().splitlines()
        return tail[-1] if tail else "prediction failed"


# -- Plan and execute provisioning through separate entry points. ---------------


def env_dir(cfg: dict[str, Any]) -> str:
    """Return the planned micromamba prefix for the PyBrainAge environment.

    Returns
    -------
    str
        Keep the environment at
        ``${paths.outputDir}/.pybrainage/current/envs/pybrainage`` so one atomic
        generation pointer publishes the environment and model together.
    """
    return pybrainage_env_dir(cfg)


def model_root(cfg: dict[str, Any]) -> str:
    """Return the published versioned model root in the current generation."""
    generation = cfg.get("_supraspinaProvisionGenerationRoot")
    root = (
        generation
        if isinstance(generation, str) and generation
        else os.path.join(provision_root(cfg), "current")
    )
    return os.path.join(root, "pybrainage", "v3")


def env_python(cfg: dict[str, Any]) -> str:
    """Return the conda-prefix Python path for the current host platform."""
    return pybrainage_env_python(cfg)


def provision_root(cfg: dict[str, Any]) -> str:
    """Return the app-owned root for every PyBrainAge environment artifact."""
    adapter = PyBrainAgeAdapter()
    output = adapter.resolve("${paths.outputDir}", cfg)
    if not output or "${" in output or not os.path.isabs(output):
        raise ValueError("Configure paths.outputDir as an absolute path.")
    return os.path.join(output, ".pybrainage")


def mamba_root_prefix(cfg: dict[str, Any]) -> str:
    """Return the app-owned micromamba root and package-cache parent."""
    return os.path.join(provision_root(cfg), "mamba-root")


def pip_cache_dir(cfg: dict[str, Any]) -> str:
    """Return the app-owned pip cache directory."""
    return os.path.join(provision_root(cfg), "pip-cache")


def environment_lock_path(cfg: dict[str, Any]) -> str:
    """Return the materialized explicit conda lock path."""
    return os.path.join(provision_root(cfg), "locks", PYBRAINAGE_ENV_LOCK_NAME)


def pip_lock_path(cfg: dict[str, Any]) -> str:
    """Return the materialized hashed pip requirements path."""
    return os.path.join(provision_root(cfg), "locks", PYBRAINAGE_PIP_LOCK_NAME)


def provision_state_path(cfg: dict[str, Any]) -> str:
    """Return the digest-bound completed-provision state path."""
    return os.path.join(provision_root(cfg), "provision-state.json")


def provision_lock_path(cfg: dict[str, Any]) -> str:
    """Return the cross-process provisioning lock path."""
    return os.path.join(provision_root(cfg), "provision.lock")


def _fsync_directory(path: Path) -> None:
    """Persist one directory update on platforms that expose directory fsync."""
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def _provision_lock(
    cfg: dict[str, Any],
    *,
    exclusive: bool,
    cancelled: Callable[[], bool] | None = None,
) -> Iterator[None]:
    """Hold the app-owned cross-process shared or exclusive provision lock."""
    root = Path(provision_root(cfg))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or not root.is_dir():
        raise OSError("Provide the PyBrainAge provision root as a directory.")
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(provision_lock_path(cfg), flags, 0o600)
    operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
    try:
        while True:
            try:
                fcntl.flock(descriptor, operation | fcntl.LOCK_NB)
                break
            except BlockingIOError as exc:
                if cancelled is not None and cancelled():
                    raise InterruptedError("cancelled") from exc
                time.sleep(0.05)
        yield
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def _current_generation(cfg: dict[str, Any]) -> Path:
    """Resolve the current single-level app-owned generation symlink safely."""
    root = Path(provision_root(cfg))
    current = root / "current"
    generations = root / "generations"
    if not current.is_symlink():
        raise OSError("Publish one current PyBrainAge generation symlink.")
    target = Path(os.readlink(current))
    if target.is_absolute() or ".." in target.parts:
        raise OSError("Keep the current PyBrainAge generation below its owned root.")
    candidate = root / target
    if candidate.is_symlink() or candidate.parent != generations:
        raise OSError("Publish one direct PyBrainAge generation directory.")
    resolved = candidate.resolve(strict=True)
    resolved_generations = generations.resolve(strict=True)
    if resolved.parent != resolved_generations or not resolved.is_dir():
        raise OSError("Publish one direct PyBrainAge generation directory.")
    return resolved


def _generation_cfg(cfg: dict[str, Any], generation: Path) -> dict[str, Any]:
    """Return an internal config bound to one unpublished generation root."""
    root = Path(provision_root(cfg)) / "generations"
    if generation.parent != root or generation.is_symlink():
        raise ValueError("Keep the PyBrainAge generation below its owned root.")
    effective = copy.deepcopy(cfg)
    effective["_supraspinaProvisionGenerationRoot"] = str(generation)
    return effective


def _publish_generation(cfg: dict[str, Any], generation: Path) -> str | None:
    """Atomically switch the single current pointer to a complete generation."""
    root = Path(provision_root(cfg))
    current = root / "current"
    previous = os.readlink(current) if current.is_symlink() else None
    temporary = root / f".current-{uuid.uuid4().hex}"
    relative = os.path.relpath(generation, root)
    os.symlink(relative, temporary, target_is_directory=True)
    try:
        os.replace(temporary, current)
        _fsync_directory(root)
    finally:
        if temporary.is_symlink():
            temporary.unlink()
    return previous


def _restore_generation(cfg: dict[str, Any], previous: str | None) -> None:
    """Restore the previous current pointer after a failed state publication."""
    root = Path(provision_root(cfg))
    current = root / "current"
    if previous is None:
        if current.is_symlink():
            current.unlink()
            _fsync_directory(root)
        return
    temporary = root / f".current-restore-{uuid.uuid4().hex}"
    os.symlink(previous, temporary, target_is_directory=True)
    try:
        os.replace(temporary, current)
        _fsync_directory(root)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


def _preflight_provision_space(cfg: dict[str, Any]) -> None:
    """Require conservative free space for environment, archive, and extraction."""
    root = Path(provision_root(cfg))
    available = shutil.disk_usage(root).free
    if available < _MIN_PROVISION_FREE_BYTES:
        required_gib = _MIN_PROVISION_FREE_BYTES / (1024**3)
        raise OSError(
            f"Free at least {required_gib:.0f} GiB below paths.outputDir before "
            "provisioning PyBrainAge."
        )


def _controlled_environment(root: str) -> dict[str, str]:
    """Return isolated micromamba, conda, pip, and XDG state below one root."""
    mamba_root = os.path.join(root, "mamba-root")
    return {
        "MAMBA_ROOT_PREFIX": mamba_root,
        "CONDA_PKGS_DIRS": os.path.join(mamba_root, "pkgs"),
        "PIP_CACHE_DIR": os.path.join(root, "pip-cache"),
        "PIP_CONFIG_FILE": os.devnull,
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PIP_NO_INPUT": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": "",
        "PYTHONHOME": "",
        "XDG_CACHE_HOME": os.path.join(root, "cache"),
        "CONDA_PREFIX": "",
        "CONDA_DEFAULT_ENV": "",
        "CONDA_PROMPT_MODIFIER": "",
        "CONDA_SHLVL": "0",
    }


def provision_environment(cfg: dict[str, Any]) -> dict[str, str]:
    """Return app-owned roots and caches for provisioning subprocesses."""
    return _controlled_environment(provision_root(cfg))


def _assert_linux_x86_64() -> None:
    """Refuse the platform-specific environment lock on any other target."""
    machine = platform.machine().lower()
    if not sys.platform.startswith("linux") or machine not in {"x86_64", "amd64"}:
        raise RuntimeError("Provision PyBrainAge only on Linux x86_64.")


def _prepare_provision_directories(cfg: dict[str, Any]) -> None:
    """Create app-owned roots and caches only after provisioning is authorized."""
    _assert_linux_x86_64()
    for path in (
        provision_root(cfg),
        mamba_root_prefix(cfg),
        os.path.join(mamba_root_prefix(cfg), "pkgs"),
        pip_cache_dir(cfg),
        os.path.join(provision_root(cfg), "cache"),
    ):
        Path(path).mkdir(parents=True, exist_ok=True, mode=0o700)


def _lock_source_dir() -> Path:
    """Return committed lock inputs in source and frozen sidecar layouts."""
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
        return base / "pybrainage-locks"
    return Path(__file__).resolve().parents[1] / "pybrainage_locks"


def _read_pinned_lock(name: str, expected_sha256: str) -> bytes:
    """Read one bounded committed lock and require its compiled-in digest."""
    path = _lock_source_dir() / name
    try:
        if (
            path.is_symlink()
            or not path.is_file()
            or path.stat().st_size > _MAX_LOCK_BYTES
        ):
            raise ValueError("Provide the lock as a bounded regular file.")
        value = path.read_bytes()
    except OSError as exc:
        raise RuntimeError(f"Restore the reviewed PyBrainAge lock: {name}.") from exc
    if hashlib.sha256(value).hexdigest() != expected_sha256:
        raise RuntimeError(f"Restore the reviewed PyBrainAge lock digest: {name}.")
    return value


def _atomic_write(path: Path, value: bytes) -> None:
    """Atomically replace one app-owned lock or state file."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except OSError:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def prepare_provision_storage(cfg: dict[str, Any]) -> None:
    """Materialize verified locks after preparing app-owned roots and caches."""
    environment_lock = _read_pinned_lock(
        PYBRAINAGE_ENV_LOCK_NAME, PYBRAINAGE_ENV_LOCK_SHA256
    )
    pip_lock = _read_pinned_lock(PYBRAINAGE_PIP_LOCK_NAME, PYBRAINAGE_PIP_LOCK_SHA256)
    if not environment_lock.startswith(b"@EXPLICIT\n"):
        raise RuntimeError("Restore the explicit Linux x86_64 PyBrainAge lock.")
    if b"cliffs-delta==1.0.0" not in pip_lock or b"--hash=sha256:" not in pip_lock:
        raise RuntimeError("Restore the hashed cliffs-delta==1.0.0 lock.")
    _prepare_provision_directories(cfg)
    for target, value in (
        (Path(environment_lock_path(cfg)), environment_lock),
        (Path(pip_lock_path(cfg)), pip_lock),
    ):
        try:
            if (
                target.is_file()
                and not target.is_symlink()
                and target.read_bytes() == value
            ):
                continue
        except OSError:
            pass
        _atomic_write(target, value)


def _artifact_path(cfg: dict[str, Any], param: str, filename: str) -> str:
    """Return only a model artifact from the atomically published generation."""
    del param
    return os.path.join(model_root(cfg), "software", filename)


def model_path(cfg: dict[str, Any]) -> str:
    """Return the exact ExtraTrees model path consumed by the adapter."""
    return _artifact_path(cfg, "modelPath", PYBRAINAGE_MODEL_FILE)


def scaler_path(cfg: dict[str, Any]) -> str:
    """Return the exact scaler path consumed by the adapter."""
    return _artifact_path(cfg, "scalerPath", PYBRAINAGE_SCALER_FILE)


def micromamba_binary() -> str:
    """Return the sole reviewed micromamba location for this runtime layout.

    Returns
    -------
    str
        Return the packaged sibling for a frozen sidecar or the explicitly
        staged repository resource during development. Never search ``PATH``.
    """
    name = "micromamba.exe" if sys.platform == "win32" else "micromamba"
    if getattr(sys, "frozen", False):
        sidecar_dir = Path(sys.executable).resolve().parent
        return str(sidecar_dir.parent / "micromamba" / name)
    return str(Path(__file__).resolve().parents[3] / "resources" / "micromamba" / name)


def micromamba_identity(micromamba: str | None = None) -> tuple[str, str]:
    """Resolve and hash the exact regular executable selected for provisioning."""
    selected = micromamba or micromamba_binary()
    candidate = Path(selected)
    if not candidate.is_absolute():
        located = tools.which(selected)
        if not located:
            raise OSError(f"Install the reviewed micromamba executable: {selected}.")
        candidate = Path(located)
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        message = f"Restore the selected micromamba executable: {candidate}."
        raise OSError(message) from exc
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise OSError(f"Provide an executable regular file: {resolved}.")
    return str(resolved), _sha256_regular(resolved, 64 * 1024 * 1024)


def micromamba_version_command(micromamba: str | None = None) -> list[str]:
    """Build the version probe for the exact executable provisioning selects."""
    return [micromamba or micromamba_binary(), "--version"]


def probe_micromamba_version(
    cfg: dict[str, Any],
    *,
    micromamba: str | None = None,
    selected_identity: tuple[str, str] | None = None,
    environment: dict[str, str] | None = None,
    runner: Callable[..., tools.RunResult] | None = None,
) -> tools.RunResult:
    """Require the reviewed manager bytes and version without writing outputDir."""
    try:
        _assert_linux_x86_64()
        provision_root(cfg)  # Validate the draft path without creating it.
        selected, digest = selected_identity or micromamba_identity(micromamba)
    except (OSError, RuntimeError, ValueError) as exc:
        return tools.RunResult(rc=1, stdout="", stderr=str(exc))
    if digest != MICROMAMBA_SHA256:
        return tools.RunResult(
            rc=1,
            stdout="",
            stderr=(
                f"Use micromamba {MICROMAMBA_VERSION} with the reviewed SHA-256; "
                f"the selected executable has {digest}."
            ),
        )
    run = runner or tools.run
    if environment is not None:
        result = run(
            micromamba_version_command(selected),
            timeout=60,
            env=environment,
        )
    else:
        with tempfile.TemporaryDirectory(
            prefix="supraspina-pybrainage-probe-"
        ) as temporary:
            probe_root = os.path.join(temporary, ".pybrainage")
            probe_environment = _controlled_environment(probe_root)
            Path(probe_environment["MAMBA_ROOT_PREFIX"]).mkdir(parents=True, mode=0o700)
            Path(probe_environment["CONDA_PKGS_DIRS"]).mkdir(parents=True, mode=0o700)
            result = run(
                micromamba_version_command(selected),
                timeout=60,
                env=probe_environment,
            )
    version = result.stdout.strip() if result.rc == 0 else ""
    if result.rc == 0 and version != MICROMAMBA_VERSION:
        return tools.RunResult(
            rc=1,
            stdout=result.stdout,
            stderr=(
                f"Use micromamba {MICROMAMBA_VERSION}; selected executable reported "
                f"{version or 'no version'}."
            ),
        )
    return result


def create_env_command(cfg: dict[str, Any], micromamba: str | None = None) -> list[str]:
    """Build the explicit-lock micromamba environment-create command.

    Returns
    -------
    list of str
            Return the exact ``micromamba create`` argv with the committed
            Linux x86_64 explicit lock. Do not execute it here.
    """
    return [
        micromamba or micromamba_binary(),
        "create",
        "-y",
        "--root-prefix",
        mamba_root_prefix(cfg),
        "-p",
        env_dir(cfg),
        "--file",
        environment_lock_path(cfg),
    ]


def pip_deps_command(cfg: dict[str, Any]) -> list[str]:
    """Build the pip-install command for the env's pip-only dependencies.

        Run the provisioned environment's own ``python -m pip install`` so the
        pip-only ``cliffs-delta`` package lands in the same prefix as the conda
        packages. Do not execute it here.

    Returns
    -------
    list of str
        Return an isolated, noninteractive, hash-required install from the
        app-owned requirements file and cache.
    """
    return [
        env_python(cfg),
        "-I",
        "-m",
        "pip",
        "--isolated",
        "--disable-pip-version-check",
        "--no-input",
        "install",
        "--require-hashes",
        "--only-binary=:all:",
        "--no-deps",
        "--cache-dir",
        pip_cache_dir(cfg),
        "--requirement",
        pip_lock_path(cfg),
    ]


def runtime_version_probe_command(
    cfg: dict[str, Any], python: str | None = None
) -> list[str]:
    """Build the expanded exact-version probe for the provisioned runtime."""
    return [python or env_python(cfg), "-I", "-B", "-c", _RUNTIME_PROBE_SCRIPT]


def parse_runtime_versions(result: tools.RunResult) -> dict[str, str]:
    """Parse and validate one runtime version-probe result."""
    if result.rc != 0:
        return {}
    try:
        value = json.loads(result.stdout.strip())
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(value, dict) or any(
        not isinstance(key, str) or not isinstance(item, str)
        for key, item in value.items()
    ):
        return {}
    return value


def runtime_version_mismatches(versions: dict[str, str]) -> list[str]:
    """Return every missing or wrong reviewed runtime version."""
    return [
        f"{name}={versions.get(name, 'missing')} (expected {expected})"
        for name, expected in PYBRAINAGE_RUNTIME_VERSIONS.items()
        if versions.get(name) != expected
    ]


def probe_runtime_versions(
    cfg: dict[str, Any],
    *,
    python: str | None = None,
    runner: Callable[..., tools.RunResult] | None = None,
) -> tuple[tools.RunResult, dict[str, str]]:
    """Run the exact-version probe with temporary, auto-cleaned caches."""
    try:
        _assert_linux_x86_64()
        provision_root(cfg)  # Validate the draft path without creating it.
    except (OSError, RuntimeError, ValueError) as exc:
        return (
            tools.RunResult(rc=1, stdout="", stderr=str(exc)),
            {},
        )
    run = runner or tools.run
    with tempfile.TemporaryDirectory(
        prefix="supraspina-pybrainage-probe-"
    ) as temporary:
        environment = _controlled_environment(os.path.join(temporary, ".pybrainage"))
        result = run(
            runtime_version_probe_command(cfg, python),
            timeout=60,
            env=environment,
        )
    versions = parse_runtime_versions(result)
    mismatches = runtime_version_mismatches(versions)
    if result.rc == 0 and mismatches:
        return (
            tools.RunResult(rc=1, stdout=result.stdout, stderr="; ".join(mismatches)),
            versions,
        )
    if result.rc == 0 and not versions:
        return (
            tools.RunResult(
                rc=1, stdout=result.stdout, stderr="Parse runtime versions."
            ),
            {},
        )
    return result, versions


def fetch_model_command(cfg: dict[str, Any], *, target: str | None = None) -> list[str]:
    """Build the pinned Zenodo fetch command for ``PyBrainAge.zip``.

    Returns
    -------
    list of str
            Return a ``curl`` argv that downloads the versioned-DOI asset to the
            model cache root. Gate the download with the separate SHA-256
            verification step. Do not execute it here.
    """
    destination = target or os.path.join(
        model_root(cfg), f".{PYBRAINAGE_ZENODO_ASSET}.part"
    )
    return [
        "curl",
        "-fSL",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--max-filesize",
        str(_MAX_ARCHIVE_BYTES),
        "--output",
        destination,
        PYBRAINAGE_ZENODO_URL,
    ]


def verify_model_command(cfg: dict[str, Any], expected_sha256: str) -> list[str]:
    """Build the SHA-256 verification command for the fetched archive.

    Parameters
    ----------
    expected_sha256
            Provide the pinned hex digest for the versioned Zenodo asset. Pin it
            against the DOI so the hash cannot drift.

    Returns
    -------
    list of str
        Use the current Python interpreter and :mod:`hashlib` to compare the
        downloaded archive against the pinned digest. Never execute it here.
    """
    archive = os.path.join(model_root(cfg), f".{PYBRAINAGE_ZENODO_ASSET}.part")
    script = (
        "import hashlib,sys;"
        "h=hashlib.sha256();"
        "f=open(sys.argv[1],'rb');"
        "[h.update(chunk) for chunk in iter(lambda:f.read(1048576),b'')];"
        "f.close();"
        "sys.exit(0 if h.hexdigest()==sys.argv[2] else 1)"
    )
    return [sys.executable, "-c", script, archive, expected_sha256]


def verify_model(
    cfg: dict[str, Any],
    expected_sha256: str = PYBRAINAGE_ZENODO_SHA256,
    cancelled: Callable[[], bool] | None = None,
    *,
    archive_path: str | None = None,
) -> tools.RunResult:
    """Verify the pinned archive with bounded, cancellation-aware streaming."""
    if expected_sha256 != PYBRAINAGE_ZENODO_SHA256:
        return tools.RunResult(
            rc=2,
            stdout="",
            stderr="Use the immutable published archive digest.",
        )
    archive = archive_path or os.path.join(model_root(cfg), PYBRAINAGE_ZENODO_ASSET)
    try:
        size = os.path.getsize(archive)
        if size > _MAX_ARCHIVE_BYTES:
            return tools.RunResult(
                rc=1, stdout="", stderr="Reduce the archive below the size limit."
            )
        digest = hashlib.sha256()
        with open(archive, "rb") as handle:
            while chunk := handle.read(1024 * 1024):
                if cancelled is not None and cancelled():
                    return tools.RunResult(rc=130, stdout="", stderr="cancelled")
                digest.update(chunk)
    except OSError as exc:
        return tools.RunResult(
            rc=1,
            stdout="",
            stderr=(
                f"Verify the archive after fixing this error: {str(exc).rstrip('.')}."
            ),
        )
    if digest.hexdigest() != expected_sha256:
        return tools.RunResult(
            rc=1,
            stdout="",
            stderr="Fetch an archive that matches the pinned SHA-256.",
        )
    return tools.RunResult(
        rc=0, stdout="The archive matches the pinned SHA-256.", stderr=""
    )


def validate_pickle_command(cfg: dict[str, Any]) -> list[str]:
    """Build the synthetic one-row prediction that validates the pickle load.

        Run inside the provisioned environment. Load ``scaler.pkl`` and the
        ``ExtraTreesModel``, transform one synthetic feature row, and predict.
        Fail when loading raises or escalates an ``InconsistentVersionWarning``
        to guard against scikit-learn pickle drift at install time.

    Returns
    -------
    list of str
        ``[<env python>, -W error::..., -c, <inline validation script>]``.
        Never executed here.
    """
    root = model_root(cfg)
    model_path = os.path.join(root, "software", PYBRAINAGE_MODEL_FILE)
    scaler_path = os.path.join(root, "software", PYBRAINAGE_SCALER_FILE)
    script = (
        "import pickle, numpy as np;"
        f"sc = pickle.load(open({scaler_path!r}, 'rb'));"
        f"m = pickle.load(open({model_path!r}, 'rb'));"
        "x = np.zeros((1, sc.n_features_in_));"
        "m.predict(sc.transform(x));"
        "print('pybrainage pickle load ok')"
    )
    return [
        env_python(cfg),
        "-I",
        "-W",
        "error::sklearn.exceptions.InconsistentVersionWarning",
        "-c",
        script,
    ]


def _sha256_regular(path: Path, maximum_bytes: int) -> str:
    """Hash one bounded regular file without following a final symlink."""
    if path.is_symlink() or not path.is_file():
        raise OSError(f"Provide a regular file: {path.name}.")
    if path.stat().st_size > maximum_bytes:
        raise OSError(f"Keep {path.name} within its size bound.")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _conda_metadata_digest(cfg: dict[str, Any]) -> str:
    """Bind every installed conda record by filename and file digest."""
    metadata = Path(env_dir(cfg)) / "conda-meta"
    if metadata.is_symlink() or not metadata.is_dir():
        raise OSError("Provide the provisioned conda metadata directory.")
    records: list[Path] = []
    with os.scandir(metadata) as entries:
        for index, entry in enumerate(entries):
            if index >= _MAX_CONDA_METADATA_ENTRIES:
                raise OSError("Keep conda metadata within its entry limit.")
            if not entry.name.endswith(".json"):
                continue
            if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                raise OSError("Provide regular conda package records.")
            records.append(Path(entry.path))
    records.sort(key=lambda item: item.name)
    if not records:
        raise OSError("Provide installed conda package records.")
    digest = hashlib.sha256()
    for record in records:
        digest.update(record.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(_sha256_regular(record, _MAX_CONDA_RECORD_BYTES).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def _canonical_json(value: dict[str, Any]) -> bytes:
    """Serialize one state value for stable digesting and persistence."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")


def record_provision_state(
    cfg: dict[str, Any],
    versions: dict[str, str],
    *,
    micromamba: str | None = None,
) -> tools.RunResult:
    """Persist digest-bound provenance after every validation succeeds."""
    mismatches = runtime_version_mismatches(versions)
    if mismatches:
        return tools.RunResult(rc=1, stdout="", stderr="; ".join(mismatches))
    root = Path(model_root(cfg))
    try:
        generation_root = cfg.get("_supraspinaProvisionGenerationRoot")
        if not isinstance(generation_root, str) or not generation_root:
            generation = _current_generation(cfg)
        else:
            generation = Path(generation_root)
        generations = Path(provision_root(cfg)) / "generations"
        if generation.parent != generations or generation.is_symlink():
            raise ValueError("Record one app-owned PyBrainAge generation.")
        _selected_micromamba, micromamba_sha256 = micromamba_identity(micromamba)
        if micromamba_sha256 != MICROMAMBA_SHA256:
            raise ValueError("Use the reviewed micromamba SHA-256.")
        state: dict[str, Any] = {
            "schemaVersion": _PROVISION_STATE_VERSION,
            "platform": "linux-64",
            "generation": generation.name,
            "micromamba": {
                "version": MICROMAMBA_VERSION,
                "sha256": micromamba_sha256,
            },
            "environment": {
                "lockSha256": PYBRAINAGE_ENV_LOCK_SHA256,
                "condaMetadataSha256": _conda_metadata_digest(cfg),
                "runtimeVersions": dict(sorted(versions.items())),
                "runtimeVersionsSha256": hashlib.sha256(
                    _canonical_json(dict(sorted(versions.items())))
                ).hexdigest(),
            },
            "pip": {
                "lockSha256": PYBRAINAGE_PIP_LOCK_SHA256,
                "cliffsDeltaVersion": versions["cliffs-delta"],
            },
            "model": {
                "archiveSha256": _sha256_regular(
                    root / PYBRAINAGE_ZENODO_ASSET, _MAX_ARCHIVE_BYTES
                ),
                "extraTreesSha256": _sha256_regular(
                    root / "software" / PYBRAINAGE_MODEL_FILE, _MAX_MEMBER_BYTES
                ),
                "scalerSha256": _sha256_regular(
                    root / "software" / PYBRAINAGE_SCALER_FILE, _MAX_MEMBER_BYTES
                ),
            },
        }
    except (KeyError, OSError, ValueError) as exc:
        return tools.RunResult(
            rc=1,
            stdout="",
            stderr=f"Record PyBrainAge provenance after fixing this error: {exc}",
        )
    state["provenanceSha256"] = hashlib.sha256(_canonical_json(state)).hexdigest()
    payload = _canonical_json(state) + b"\n"
    if len(payload) > _MAX_STATE_BYTES:
        return tools.RunResult(
            rc=1, stdout="", stderr="Keep PyBrainAge provenance within its size bound."
        )
    try:
        _atomic_write(Path(provision_state_path(cfg)), payload)
    except OSError as exc:
        return tools.RunResult(
            rc=1,
            stdout="",
            stderr=f"Persist PyBrainAge provenance after fixing this error: {exc}",
        )
    return tools.RunResult(
        rc=0,
        stdout=f"Recorded PyBrainAge provenance {state['provenanceSha256']}.",
        stderr="",
    )


def provision_state_status(  # noqa: PLR0911, PLR0912
    cfg: dict[str, Any],
) -> tuple[bool, str]:
    """Validate provision state against every current digest-bound artifact."""
    path = Path(provision_state_path(cfg))
    try:
        if (
            path.is_symlink()
            or not path.is_file()
            or path.stat().st_size > _MAX_STATE_BYTES
        ):
            return False, "Provision PyBrainAge to create bounded provenance state."
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False, "Provision PyBrainAge to repair its provenance state."
    if (
        not isinstance(state, dict)
        or state.get("schemaVersion") != _PROVISION_STATE_VERSION
        or state.get("platform") != "linux-64"
    ):
        return False, "Provision PyBrainAge to refresh its provenance schema."
    generation_name = state.get("generation")
    if (
        not isinstance(generation_name, str)
        or len(generation_name) != _GENERATION_NAME_LENGTH
        or any(character not in "0123456789abcdef" for character in generation_name)
    ):
        return False, "Provision PyBrainAge to restore its generation identity."
    recorded = state.get("provenanceSha256")
    body = dict(state)
    body.pop("provenanceSha256", None)
    if (
        not isinstance(recorded, str)
        or recorded != hashlib.sha256(_canonical_json(body)).hexdigest()
    ):
        return False, "Provision PyBrainAge to repair its provenance digest."
    environment = state.get("environment")
    pip_state = state.get("pip")
    micromamba_state = state.get("micromamba")
    model_state = state.get("model")
    if (
        not isinstance(environment, dict)
        or not isinstance(pip_state, dict)
        or not isinstance(micromamba_state, dict)
        or not isinstance(model_state, dict)
    ):
        return False, "Provision PyBrainAge to restore environment provenance."
    if (
        environment.get("lockSha256") != PYBRAINAGE_ENV_LOCK_SHA256
        or pip_state.get("lockSha256") != PYBRAINAGE_PIP_LOCK_SHA256
    ):
        return False, "Provision PyBrainAge from the current reviewed locks."
    versions = environment.get("runtimeVersions")
    if not isinstance(versions, dict) or any(
        not isinstance(key, str) or not isinstance(item, str)
        for key, item in versions.items()
    ):
        return False, "Provision PyBrainAge to restore runtime version provenance."
    if runtime_version_mismatches(versions):
        return False, "Provision PyBrainAge with the reviewed runtime versions."
    if (
        environment.get("runtimeVersionsSha256")
        != hashlib.sha256(_canonical_json(versions)).hexdigest()
    ):
        return False, "Provision PyBrainAge to repair runtime version provenance."
    if (
        pip_state.get("cliffsDeltaVersion") != "1.0.0"
        or micromamba_state.get("version") != MICROMAMBA_VERSION
        or micromamba_state.get("sha256") != MICROMAMBA_SHA256
        or model_state.get("archiveSha256") != PYBRAINAGE_ZENODO_SHA256
    ):
        return False, "Provision PyBrainAge with the reviewed dependency identities."
    try:
        current_generation = _current_generation(cfg)
        if current_generation.name != generation_name:
            return False, "Provision PyBrainAge to repair its current generation."
        _selected_micromamba, current_micromamba = micromamba_identity()
        current_metadata = _conda_metadata_digest(cfg)
        root = Path(model_root(cfg))
        current_model = {
            "archiveSha256": _sha256_regular(
                root / PYBRAINAGE_ZENODO_ASSET, _MAX_ARCHIVE_BYTES
            ),
            "extraTreesSha256": _sha256_regular(
                root / "software" / PYBRAINAGE_MODEL_FILE, _MAX_MEMBER_BYTES
            ),
            "scalerSha256": _sha256_regular(
                root / "software" / PYBRAINAGE_SCALER_FILE, _MAX_MEMBER_BYTES
            ),
        }
    except OSError:
        return False, "Provision PyBrainAge to restore its digest-bound artifacts."
    if (
        current_micromamba != MICROMAMBA_SHA256
        or current_micromamba != micromamba_state.get("sha256")
    ):
        return False, "Provision PyBrainAge with the reviewed micromamba bytes."
    if environment.get("condaMetadataSha256") != current_metadata:
        return False, "Provision PyBrainAge to repair changed conda package metadata."
    if any(model_state.get(key) != value for key, value in current_model.items()):
        return False, "Provision PyBrainAge to repair changed model artifacts."
    return True, str(recorded)


def provision(
    cfg: dict[str, Any],
    progress_cb: Callable[[str, float], None],
    expected_sha256: str = PYBRAINAGE_ZENODO_SHA256,
) -> dict[str, Any]:
    """Plan PyBrainAge first-run provisioning, emitting progress only.

    Build the manager check, explicit-lock environment creation, hashed pip
    install, exact runtime probe, pinned model fetch and verification, and
    synthetic pickle validation. Create, fetch, and execute nothing.

    Parameters
    ----------
    progress_cb
        Provide a callback invoked as ``progress_cb(message, fraction)`` with
        ``fraction`` from 0.0 to 1.0.
    expected_sha256
        Provide the pinned SHA-256 of the versioned Zenodo asset. Default to
        :data:`PYBRAINAGE_ZENODO_SHA256` and embed it in ``verify_model``.

    Returns
    -------
    dict
        Return the provisioning plan with ``env_dir``, ``model_root``, and an
        ordered list of ``steps``.
    """
    if expected_sha256 != PYBRAINAGE_ZENODO_SHA256:
        raise ValueError("Use the immutable PyBrainAge archive SHA-256.")
    progress_cb("Plan the exact micromamba 2.7.0 check.", 0.0)
    selected_micromamba = micromamba_binary()
    manager = micromamba_version_command(selected_micromamba)

    progress_cb("Plan the locked PyBrainAge environment with micromamba.", 0.1)
    create = create_env_command(cfg, selected_micromamba)

    progress_cb("Plan the hashed cliffs-delta dependency installation.", 0.25)
    pip_deps = pip_deps_command(cfg)
    runtime_probe = runtime_version_probe_command(cfg)

    progress_cb("Plan the pinned PyBrainAge.zip fetch from Zenodo.", 0.45)
    fetch = fetch_model_command(cfg)
    verify = verify_model_command(cfg, expected_sha256)

    progress_cb("Plan the synthetic pickle-load validation.", 0.75)
    validate = validate_pickle_command(cfg)

    progress_cb("Review the completed PyBrainAge provisioning plan.", 1.0)
    return {
        "env_dir": env_dir(cfg),
        "model_root": model_root(cfg),
        "mamba_root_prefix": mamba_root_prefix(cfg),
        "pip_cache_dir": pip_cache_dir(cfg),
        "locks": {
            "environment": {
                "path": environment_lock_path(cfg),
                "sha256": PYBRAINAGE_ENV_LOCK_SHA256,
            },
            "pip": {
                "path": pip_lock_path(cfg),
                "sha256": PYBRAINAGE_PIP_LOCK_SHA256,
            },
        },
        "zenodo": {
            "doi": PYBRAINAGE_ZENODO_DOI,
            "url": PYBRAINAGE_ZENODO_URL,
            "bytes": PYBRAINAGE_ZENODO_BYTES,
            "sha256": expected_sha256,
        },
        "steps": [
            {"name": "check_micromamba", "command": manager},
            {"name": "create_env", "command": create},
            {"name": "install_pip_deps", "command": pip_deps},
            {"name": "probe_runtime", "command": runtime_probe},
            {"name": "fetch_model", "command": fetch},
            {"name": "verify_model", "command": verify},
            {"name": "validate_pickle", "command": validate},
        ],
    }


def extract_model(  # noqa: PLR0912, PLR0915
    cfg: dict[str, Any], cancelled: Callable[[], bool] | None = None
) -> tools.RunResult:
    """Unpack the fetched PyBrainAge archive into the model cache root.

    Extract the pinned Zenodo ``PyBrainAge.zip`` into :func:`model_root`, where
    validation and environment probes expect ``software/ExtraTreesModel``. Use
    the standard library so no ``unzip`` binary is required. Allowlist and
    validate the published in-archive layout before extraction.

    Returns
    -------
    tools.RunResult
        Return ``rc=0`` on success or ``rc=1`` with the error on stderr.
    """
    root = Path(model_root(cfg))
    archive = root / PYBRAINAGE_ZENODO_ASSET
    try:
        if archive.stat().st_size > _MAX_ARCHIVE_BYTES:
            raise ValueError("Reduce the archive below the size limit.")
        with zipfile.ZipFile(archive) as handle:
            members = handle.infolist()
            if len(members) > _MAX_ARCHIVE_MEMBERS:
                raise ValueError("Reduce the number of archive members.")
            expanded = 0
            by_name: dict[str, zipfile.ZipInfo] = {}
            for member in members:
                name = member.filename
                path = PurePosixPath(name)
                mode = member.external_attr >> 16
                if (
                    not name
                    or "\\" in name
                    or "\x00" in name
                    or path.is_absolute()
                    or ".." in path.parts
                    or (path.parts and ":" in path.parts[0])
                ):
                    raise ValueError("Remove the unsafe archive member path.")
                if member.flag_bits & 0x1:
                    raise ValueError("Remove encrypted archive members.")
                if stat.S_ISLNK(mode):
                    raise ValueError("Remove symlinks from the archive.")
                if member.file_size > _MAX_MEMBER_BYTES:
                    raise ValueError("Reduce the archive member below the size limit.")
                expanded += member.file_size
                if expanded > _MAX_EXPANDED_BYTES:
                    raise ValueError("Reduce the expanded archive below the limit.")
                if (member.file_size and member.compress_size == 0) or (
                    member.compress_size
                    and member.file_size / member.compress_size > _MAX_COMPRESSION_RATIO
                ):
                    raise ValueError("Use a safe archive-member compression ratio.")
                normalized = path.as_posix().rstrip("/")
                if normalized in by_name:
                    raise ValueError("Remove duplicate archive member paths.")
                by_name[normalized] = member

            required = {
                f"software/{PYBRAINAGE_MODEL_FILE}": PYBRAINAGE_MODEL_FILE,
                f"software/{PYBRAINAGE_SCALER_FILE}": PYBRAINAGE_SCALER_FILE,
            }
            missing = sorted(set(required) - set(by_name))
            if missing:
                raise ValueError(
                    f"Add the required archive artifacts: {', '.join(missing)}."
                )
            root.mkdir(parents=True, exist_ok=True)
            software = root / "software"
            software.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix=".extract-", dir=root) as tmp:
                staged: dict[str, Path] = {}
                for member_name, filename in required.items():
                    if cancelled is not None and cancelled():
                        return tools.RunResult(rc=130, stdout="", stderr="cancelled")
                    target = Path(tmp) / filename
                    with (
                        handle.open(by_name[member_name]) as source,
                        open(target, "xb") as destination,
                    ):
                        while chunk := source.read(1024 * 1024):
                            if cancelled is not None and cancelled():
                                return tools.RunResult(
                                    rc=130, stdout="", stderr="cancelled"
                                )
                            destination.write(chunk)
                        destination.flush()
                        os.fsync(destination.fileno())
                    staged[filename] = target
                for filename, target in staged.items():
                    os.replace(target, software / filename)
                if os.name != "nt":
                    fd = os.open(software, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as exc:
        return tools.RunResult(
            rc=1,
            stdout="",
            stderr=(
                "Extract the model archive after fixing this error: "
                f"{str(exc).rstrip('.')}."
            ),
        )
    return tools.RunResult(
        rc=0, stdout=f"Use the extracted model archive at {archive}.", stderr=""
    )


def execute_provision(  # noqa: PLR0911, PLR0912, PLR0913, PLR0915
    cfg: dict[str, Any],
    progress_cb: Callable[[str, float], None],
    *,
    expected_sha256: str = PYBRAINAGE_ZENODO_SHA256,
    runner: Callable[..., tools.RunResult] = tools.run,
    extractor: Callable[[dict[str, Any]], tools.RunResult] = extract_model,
    verifier: Callable[..., tools.RunResult] = verify_model,
    state_writer: Callable[..., tools.RunResult] = record_provision_state,
    cancelled: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Build and atomically publish one verified PyBrainAge generation.

    Hold a filesystem lock across the operation so independent sidecars cannot
    provision the same output root concurrently. Reuse a fully valid generation
    without network access. Otherwise build the environment and model under an
    unpublished final-prefix generation, download to a bounded partial file,
    validate every dependency, atomically switch one ``current`` symlink, and
    write provenance last. Roll back the pointer and remove the new generation
    after any ordinary failure.
    """

    def outcome(
        *,
        ok: bool,
        steps: list[str],
        failed_step: str | None,
        rc: int,
        message: str,
    ) -> dict[str, Any]:
        return {
            "ok": ok,
            "steps": steps,
            "failed_step": failed_step,
            "rc": rc,
            "message": message,
        }

    if expected_sha256 != PYBRAINAGE_ZENODO_SHA256:
        return outcome(
            ok=False,
            steps=[],
            failed_step="verify_model",
            rc=2,
            message="Use the immutable published archive digest.",
        )

    generation: Path | None = None
    published = False
    previous_current: str | None = None
    success = False
    try:
        with _provision_lock(cfg, exclusive=True, cancelled=cancelled):
            valid, _detail = provision_state_status(cfg)
            if valid:
                runtime, _versions = probe_runtime_versions(
                    cfg, python=env_python(cfg), runner=runner
                )
                if runtime.rc == 0:
                    progress_cb(
                        "The existing PyBrainAge generation is verified.",
                        1.0,
                    )
                    success = True
                    return outcome(
                        ok=True,
                        steps=["validate_existing"],
                        failed_step=None,
                        rc=0,
                        message="",
                    )

            try:
                prepare_provision_storage(cfg)
                _preflight_provision_space(cfg)
            except (OSError, RuntimeError, ValueError) as exc:
                return outcome(
                    ok=False,
                    steps=[],
                    failed_step="prepare_storage",
                    rc=1,
                    message=str(exc),
                )

            generations = Path(provision_root(cfg)) / "generations"
            generations.mkdir(parents=True, exist_ok=True, mode=0o700)
            generation = generations / uuid.uuid4().hex
            generation.mkdir(mode=0o700)
            staged_cfg = _generation_cfg(cfg, generation)
            controlled_environment = provision_environment(cfg)

            micromamba_candidate = micromamba_binary()
            micromamba_error = ""
            try:
                selected_identity = micromamba_identity(micromamba_candidate)
                selected_micromamba = selected_identity[0]
            except OSError as exc:
                selected_identity = None
                selected_micromamba = micromamba_candidate
                micromamba_error = str(exc)

            def run_command(
                argv: list[str], *, timeout: float | None = None
            ) -> tools.RunResult:
                return runner(argv, timeout=timeout, env=controlled_environment)

            def check_micromamba() -> tools.RunResult:
                if selected_identity is None:
                    return tools.RunResult(rc=1, stdout="", stderr=micromamba_error)
                return probe_micromamba_version(
                    staged_cfg,
                    micromamba=selected_micromamba,
                    selected_identity=selected_identity,
                    environment=controlled_environment,
                    runner=runner,
                )

            runtime_versions: dict[str, str] = {}

            def probe_runtime() -> tools.RunResult:
                nonlocal runtime_versions
                result = run_command(
                    runtime_version_probe_command(staged_cfg), timeout=60
                )
                runtime_versions = parse_runtime_versions(result)
                mismatches = runtime_version_mismatches(runtime_versions)
                if result.rc == 0 and mismatches:
                    return tools.RunResult(
                        rc=1, stdout=result.stdout, stderr="; ".join(mismatches)
                    )
                if result.rc == 0 and not runtime_versions:
                    return tools.RunResult(
                        rc=1, stdout=result.stdout, stderr="Parse runtime versions."
                    )
                return result

            staged_model_root = Path(model_root(staged_cfg))
            staged_archive = staged_model_root / PYBRAINAGE_ZENODO_ASSET
            pending_archive = staged_model_root / f".{PYBRAINAGE_ZENODO_ASSET}.part"

            def valid_archive(path: Path) -> bool:
                try:
                    return (
                        _sha256_regular(path, _MAX_ARCHIVE_BYTES)
                        == PYBRAINAGE_ZENODO_SHA256
                    )
                except OSError:
                    return False

            def fetch_model() -> tools.RunResult:
                try:
                    staged_model_root.mkdir(parents=True, exist_ok=True, mode=0o700)
                    downloads = Path(provision_root(cfg)) / "downloads"
                    downloads.mkdir(parents=True, exist_ok=True, mode=0o700)
                    candidates = [downloads / PYBRAINAGE_ZENODO_ASSET]
                    try:
                        candidates.insert(
                            0,
                            _current_generation(cfg)
                            / "pybrainage"
                            / "v3"
                            / PYBRAINAGE_ZENODO_ASSET,
                        )
                    except OSError:
                        pass
                    cached = next(
                        (path for path in candidates if valid_archive(path)), None
                    )
                    if cached is not None:
                        try:
                            os.link(cached, staged_archive)
                        except OSError:
                            shutil.copyfile(cached, staged_archive)
                        return tools.RunResult(
                            rc=0,
                            stdout="Reuse the verified cached PyBrainAge archive.",
                            stderr="",
                        )
                    return run_command(
                        fetch_model_command(staged_cfg, target=str(pending_archive))
                    )
                except OSError as exc:
                    return tools.RunResult(
                        rc=1,
                        stdout="",
                        stderr=(
                            f"Prepare the model cache after fixing this error: {exc}"
                        ),
                    )

            def verify_download() -> tools.RunResult:
                target = staged_archive if staged_archive.is_file() else pending_archive
                result = verifier(
                    staged_cfg,
                    expected_sha256,
                    archive_path=str(target),
                )
                if result.rc != 0:
                    return result
                try:
                    if target == pending_archive:
                        os.replace(pending_archive, staged_archive)
                    downloads = Path(provision_root(cfg)) / "downloads"
                    cached = downloads / PYBRAINAGE_ZENODO_ASSET
                    temporary = (
                        downloads / f".{PYBRAINAGE_ZENODO_ASSET}-{uuid.uuid4().hex}"
                    )
                    try:
                        os.link(staged_archive, temporary)
                    except OSError:
                        shutil.copyfile(staged_archive, temporary)
                    os.replace(temporary, cached)
                    _fsync_directory(downloads)
                except OSError as exc:
                    return tools.RunResult(
                        rc=1,
                        stdout="",
                        stderr=(
                            "Publish the verified archive after fixing this error: "
                            f"{exc}"
                        ),
                    )
                return result

            def publish_generation() -> tools.RunResult:
                nonlocal previous_current, published
                try:
                    previous_current = _publish_generation(cfg, generation)  # type: ignore[arg-type]
                    published = True
                except OSError as exc:
                    return tools.RunResult(
                        rc=1,
                        stdout="",
                        stderr=(
                            "Publish the PyBrainAge generation after fixing "
                            "this error: "
                            f"{exc}"
                        ),
                    )
                return tools.RunResult(
                    rc=0,
                    stdout="Published the verified PyBrainAge generation.",
                    stderr="",
                )

            steps: list[tuple[str, Callable[[], tools.RunResult]]] = [
                ("check_micromamba", check_micromamba),
                (
                    "create_env",
                    lambda: run_command(
                        create_env_command(staged_cfg, selected_micromamba)
                    ),
                ),
                (
                    "install_pip_deps",
                    lambda: run_command(pip_deps_command(staged_cfg)),
                ),
                ("probe_runtime", probe_runtime),
                ("fetch_model", fetch_model),
                ("verify_model", verify_download),
                ("extract_model", lambda: extractor(staged_cfg)),
                (
                    "validate_pickle",
                    lambda: run_command(
                        validate_pickle_command(staged_cfg), timeout=60
                    ),
                ),
                ("publish_generation", publish_generation),
                (
                    "record_state",
                    lambda: state_writer(
                        staged_cfg,
                        runtime_versions,
                        micromamba=selected_micromamba,
                    ),
                ),
            ]

            total = len(steps)
            run_names: list[str] = []
            for index, (name, action) in enumerate(steps):
                if cancelled is not None and cancelled():
                    return outcome(
                        ok=False,
                        steps=run_names,
                        failed_step=name,
                        rc=130,
                        message="cancelled",
                    )
                progress_cb(f"Run {name}.", index / total)
                result = action()
                run_names.append(name)
                if result.rc != 0:
                    message = (result.stderr or result.stdout or "").strip()
                    progress_cb(
                        f"Fix {name} after this failure: {message}", index / total
                    )
                    return outcome(
                        ok=False,
                        steps=run_names,
                        failed_step=name,
                        rc=result.rc,
                        message=message,
                    )
            progress_cb("The PyBrainAge environment is provisioned.", 1.0)
            success = True
            return outcome(
                ok=True,
                steps=run_names,
                failed_step=None,
                rc=0,
                message="",
            )
    except InterruptedError:
        return outcome(
            ok=False,
            steps=[],
            failed_step="acquire_lock",
            rc=130,
            message="cancelled",
        )
    finally:
        if not success and generation is not None:
            if published:
                try:
                    _restore_generation(cfg, previous_current)
                except OSError:
                    pass
            shutil.rmtree(generation, ignore_errors=True)


register(PyBrainAgeAdapter())
