"""Adapter for backend-aware cortical reconstruction (pipeline step ``recon``).

FreeSurfer is the canonical default. The full FastSurfer
2.5.4 segmentation and surface pipeline optionally runs from a
verified machine-local Apptainer SIF. The canonical FreeSurfer invocation is::

    recon-all -subject ID -i T1 -sd <derivatives>/freesurfer -all -parallel -openmp N

``-parallel`` runs the two hemispheres concurrently and ``-openmp N`` sets the
OpenMP thread count. The result is a full FreeSurfer reconstruction tree
under ``<derivatives>/freesurfer/<ID>/``, whose completion is marked by
``scripts/recon-all.done``, white and pial surfaces, and ``aseg`` statistics.

The backends keep separate output roots. Completion requires a backend marker
plus the full surface, segmentation, conventional aparc, Destrieux,
normalized-volume, and statistics superset consumed downstream.
"""

from __future__ import annotations

import os
import re
import shlex
import stat
import uuid
from itertools import pairwise
from typing import Any

from . import tools
from .base import (
    OOM_EXIT_CODE,
    Adapter,
    ExecutionAction,
    Failure,
    StepStatus,
    register,
)
from .fastsurfer import (
    FASTSURFER_BACKEND,
    FREESURFER_BACKEND,
    build_fastsurfer_command,
    reconstruction_artifact_groups,
    reconstruction_subdir,
    selected_backend,
    selected_fastsurfer_device,
)

FREESURFER_SUBDIR = "freesurfer"

T1_TEMPLATE = "${paths.rawdataDir}/${subject}/anat/${subject}_T1w.nii.gz"

_DEFAULT_OPENMP_THREADS = 6


_SIGNAL_KILL = re.compile(r"^\s*Command terminated by signal 9\s*$", re.MULTILINE)
_FSTIME = re.compile(r"^@#@FSTIME\s+\S+\s+(\S+)\s+N\b", re.MULTILINE)
# Lines FreeSurfer prints after every failure regardless of its cause.
_BOILERPLATE = (
    "to report a problem, see",
    "for more details, see the log file",
)


def _signal_killed_tool(output: str) -> str | None:
    """Return the tool that fs_time reports as killed by signal 9, if any."""
    kill = _SIGNAL_KILL.search(output)
    if kill is None:
        return None
    timing = _FSTIME.search(output, kill.end())
    return timing.group(1) if timing is not None else "a recon-all tool"


def _last_informative_line(output: str) -> str | None:
    """Return the last non-empty output line that is not a generic trailer."""
    for line in reversed(output.strip().splitlines()):
        text = line.strip()
        if text and not any(text.lower().startswith(b) for b in _BOILERPLATE):
            return text
    return None


def _has_imported_input(subjects_dir: str, subject: str) -> bool:
    """Report whether recon-all already imported this subject's input volume."""
    return os.path.isfile(os.path.join(subjects_dir, subject, "mri", "orig", "001.mgz"))


_IS_RUNNING_MARKER = re.compile(r"^IsRunning\.(lh|rh|lh\+rh)$")


def _recon_all_running_for(subject: str) -> bool:
    """Report whether any recon-all process on this host names ``subject``.

    FreeSurfer leaves ``scripts/IsRunning.*`` behind when recon-all is killed,
    and refuses to start again while the marker exists. The sidecar started
    every reconstruction it continues, so a marker with no live recon-all for
    the subject is stale; the process table is checked so a reconstruction
    launched outside Supraspina is never interrupted.
    """
    try:
        entries = os.listdir("/proc")
    except OSError:
        return True
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open(os.path.join("/proc", entry, "cmdline"), "rb") as handle:
                argv = handle.read().split(b"\0")
        except OSError:
            continue
        if not argv or not argv[0].decode("utf-8", "replace").endswith("recon-all"):
            continue
        for flag, value in pairwise(argv):
            if (
                flag in {b"-subject", b"-s", b"-sid", b"-subjid"}
                and value.decode("utf-8", "replace") == subject
            ):
                return True
    return False


def backend_display_name(backend: str) -> str:
    """Return the product name of a reconstruction backend id."""
    return "FastSurfer" if backend == FASTSURFER_BACKEND else "FreeSurfer"


class ReconAdapter(Adapter):
    """Adapt FreeSurfer or FastSurfer cortical reconstruction.

    Select FreeSurfer when the backend parameter is absent. Resolve automatic
    backend and device choices in the reviewed run-time plan.
    """

    key = "recon"
    # Return backend-dependent reconstruction requirements from
    # required_check_ids(); avoid a static all-of set across both backends.
    required_checks: tuple[str, ...] = ()
    name = "Cortical reconstruction"
    goal = (
        "Complete cortical reconstruction and Desikan/Destrieux parcellation "
        "for every subject."
    )
    advances = ("recon",)

    # -- Schema ---------------------------------------------------------------

    def params(self, cfg: dict[str, Any]) -> dict[str, Any]:
        """Return receipt-canonical reconstruction parameters.

        Record the concrete reconstruction backend in the receipt. Drop
        FreeSurfer-only flags for FastSurfer and record the concrete plan-time device
        instead of ``auto``.
        """
        values = super().params(cfg)
        backend = selected_backend(cfg)
        if backend == FREESURFER_BACKEND:
            values["backend"] = FREESURFER_BACKEND
            values.pop("fastsurferDevice", None)
            return values
        values["backend"] = FASTSURFER_BACKEND
        values["fastsurferDevice"] = selected_fastsurfer_device(cfg)
        values.pop("directives", None)
        values.pop("parallel", None)
        return values

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the parameter schema for both reconstruction backends.

        Keep FreeSurfer-only controls declared for conditional renderer display.
        Resolve automatic backend and device choices during planning.

        Returns
        -------
        dict
            Return each parameter name mapped to its kind, default, label, and
            integer bounds.
        """
        return {
            "backend": {
                "kind": "choice",
                "default": FREESURFER_BACKEND,
                "label": "Reconstruction backend",
                "options": ["freesurfer", "fastsurfer", "auto"],
            },
            "fastsurferDevice": {
                "kind": "choice",
                "default": "auto",
                "label": "FastSurfer device",
                "options": ["auto", "cpu", "cuda"],
            },
            "directives": {
                "kind": "text",
                "default": "-all",
                "label": "recon-all directives",
            },
            "parallel": {
                "kind": "bool",
                "default": True,
                "label": "Reconstruct hemispheres in parallel (-parallel)",
            },
        }

    def required_check_ids(self, cfg: dict[str, Any]) -> tuple[str, ...]:
        """Return backend-specific host checks.

        Delegate SIF and Apptainer checks to the managed-resource verifier.
        Require the user-managed FreeSurfer license for FastSurfer without a
        host FreeSurfer installation.
        """
        if selected_backend(cfg) == FASTSURFER_BACKEND:
            return ("license",)
        return ("reconall", "fshome", "license")

    # -- Command --------------------------------------------------------------

    def _subjects_dir(self, cfg: dict[str, Any]) -> str:
        """Return the selected backend's resolved output parent."""
        derivatives = self.resolve("${paths.derivativesDir}", cfg)
        return os.path.join(derivatives, reconstruction_subdir(cfg))

    def _t1_path(self, cfg: dict[str, Any], subject_id: str) -> str:
        """Return the resolved BIDS T1w NIfTI path for one subject."""
        runtime = cfg.get("_supraspinaRuntime", {})
        by_subject = (
            runtime.get("reconInputBySubject", {}) if isinstance(runtime, dict) else {}
        )
        selected = by_subject.get(subject_id) if isinstance(by_subject, dict) else None
        if isinstance(selected, str) and selected:
            return selected
        resolved = self.resolve(T1_TEMPLATE, cfg)
        return resolved.replace("${subject}", subject_id)

    def receipt_action(
        self, cfg: dict[str, Any], subject_id: str | None
    ) -> ExecutionAction:
        """Bind the canonical import form so a continuation matches its receipt.

        The launched command omits -i once the subject is imported, but the
        output it completes is the same reconstruction of the same T1, whose
        identity the receipt already carries as ``inputT1Fingerprint``.
        """
        if selected_backend(cfg) == FASTSURFER_BACKEND:
            return self.execution_action(cfg, subject_id)
        return ExecutionAction(
            kind="process",
            argv=tuple(self._recon_all_argv(cfg, subject_id, import_input=True)),
        )

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the selected backend's per-subject argument vector.

        Parameters
        ----------
        subject_id
            Provide the subject id. Use the literal ``${subject}`` dry-run
            placeholder when it is absent.

        Returns
        -------
        list of str
            Return FreeSurfer ``recon-all`` or full FastSurfer Apptainer argv.
        """
        if selected_backend(cfg) == FASTSURFER_BACKEND:
            return build_fastsurfer_command(cfg, subject_id)

        subject = subject_id if subject_id is not None else "${subject}"
        subjects_dir = self._subjects_dir(cfg)
        # recon-all refuses -i for a subject that already has mri/orig/001.mgz
        # and asks the caller to omit every -i flag. A rerun of incomplete
        # output continues that existing subject, so import the T1 only when
        # the subject directory has not been created yet.
        import_input = subject_id is None or not _has_imported_input(
            subjects_dir, subject
        )
        return self._recon_all_argv(cfg, subject_id, import_input=import_input)

    def _recon_all_argv(
        self, cfg: dict[str, Any], subject_id: str | None, *, import_input: bool
    ) -> list[str]:
        """Return the recon-all argv, importing the T1 only when asked."""
        subject = subject_id if subject_id is not None else "${subject}"
        params = self.params(cfg)
        schema = self.param_schema()

        runtime = cfg.get("runtime", {}) if isinstance(cfg.get("runtime"), dict) else {}
        threads = int(runtime.get("threads", _DEFAULT_OPENMP_THREADS))
        directives = str(
            params.get("directives", schema["directives"]["default"])
        ).strip()
        parallel = bool(params.get("parallel", schema["parallel"]["default"]))

        subjects_dir = self._subjects_dir(cfg)
        argv = ["recon-all", "-subject", subject]
        if import_input:
            argv.extend(["-i", self._t1_path(cfg, subject)])
        argv.extend(["-sd", subjects_dir])
        if directives:
            argv.extend(directives.split())
        if parallel:
            argv.append("-parallel")
        argv.extend(["-openmp", str(threads)])
        return argv

    def preview(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        """Return a shell preview without displaying the license host path."""
        argv = self.build_command(cfg, subject_id)
        if selected_backend(cfg) == FASTSURFER_BACKEND:
            tools_cfg = cfg.get("tools", {})
            configured = (
                tools_cfg.get("freesurferLicense")
                if isinstance(tools_cfg, dict)
                else ""
            )
            runtime = cfg.get("_supraspinaRuntime", {})
            runtime_license = (
                runtime.get("freesurferLicensePath")
                if isinstance(runtime, dict)
                else ""
            )
            license_path = str(runtime_license or configured or "")
            if license_path:
                argv = [value.replace(license_path, "[FS_LICENSE]") for value in argv]
        return shlex.join(argv)

    def clear_stale_running_markers(
        self, cfg: dict[str, Any], subject_id: str | None
    ) -> list[str]:
        """Remove FreeSurfer's IsRunning markers left by an interrupted run.

        Only a subject Supraspina is about to continue is touched, and only when
        no recon-all for that subject is running on the host. Return the
        removed marker names so the launcher can log them.
        """
        if subject_id is None or selected_backend(cfg) == FASTSURFER_BACKEND:
            return []
        scripts_dir = os.path.join(self._subjects_dir(cfg), subject_id, "scripts")
        try:
            names = sorted(
                name
                for name in os.listdir(scripts_dir)
                if _IS_RUNNING_MARKER.match(name)
            )
        except OSError:
            return []
        if not names or _recon_all_running_for(subject_id):
            return []
        removed: list[str] = []
        for name in names:
            path = os.path.join(scripts_dir, name)
            try:
                if os.path.islink(path) or not os.path.isfile(path):
                    continue
                os.unlink(path)
                removed.append(name)
            except OSError:
                continue
        return removed

    def prepare_execution(self, cfg: dict[str, Any], subject_id: str | None) -> None:
        """Create and verify only the selected backend's output parent.

        Call this after committing durable running state and immediately before
        spawn. Never create, delete, or reuse a per-subject tree in this hook.
        """
        del subject_id
        label = backend_display_name(selected_backend(cfg))
        output_parent = self._subjects_dir(cfg)
        try:
            os.makedirs(output_parent, exist_ok=True)
        except FileExistsError:
            # Classify an existing non-directory below with a precise error.
            pass
        except OSError as exc:
            raise OSError(f"Choose a creatable {label} output parent.") from exc
        try:
            info = os.lstat(output_parent)
        except OSError as exc:
            raise OSError(f"Choose a creatable {label} output parent.") from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise NotADirectoryError(
                f"Provide the {label} output parent as a directory: {output_parent}."
            )
        probe = os.path.join(
            output_parent, f".supraspina-write-probe-{uuid.uuid4().hex}"
        )
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
        try:
            fd = os.open(probe, flags, 0o600)
            try:
                os.write(fd, b"ready\n")
                os.fsync(fd)
            finally:
                os.close(fd)
            os.unlink(probe)
            if os.name != "nt":
                directory_fd = os.open(
                    output_parent,
                    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
                )
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        except OSError as exc:
            try:
                os.unlink(probe)
            except OSError:
                pass
            raise PermissionError(f"Choose a writable {label} output parent.") from exc

    # -- Detector -------------------------------------------------------------

    def _subject_dir(self, cfg: dict[str, Any], subject_id: str) -> str:
        """Return the per-subject recon-tree root for ``subject_id``."""
        return os.path.join(self._subjects_dir(cfg), subject_id)

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        """Detect the full selected-backend reconstruction artifact superset.

        Returns
        -------
        StepStatus
            Return ``done`` when every required group has a non-empty artifact,
            ``partial`` for an incomplete tree, or ``pending`` before output.
        """
        if subject_id is None:
            return StepStatus(state="pending", detail="Provide a subject id.")

        backend = selected_backend(cfg)
        subject_dir = self._subject_dir(cfg, subject_id)
        groups = reconstruction_artifact_groups(backend)
        present: list[str] = []
        missing: list[str] = []
        for alternatives in groups:
            selected = next(
                (
                    os.path.join(subject_dir, relative)
                    for relative in alternatives
                    if tools.file_nonempty(os.path.join(subject_dir, relative))
                ),
                None,
            )
            if selected is None:
                missing.append(" or ".join(alternatives))
            else:
                present.append(selected)

        if not missing:
            return StepStatus(
                state="done",
                detail=(
                    f"The {backend_display_name(backend)} reconstruction is complete."
                ),
                artifacts=present,
            )
        if not tools.exists(subject_dir) and not present:
            return StepStatus(
                state="pending",
                detail="Create the reconstruction tree.",
            )
        return StepStatus(
            state="partial",
            detail=(
                f"Create the missing reconstruction artifacts: {', '.join(missing)}."
            ),
            artifacts=present,
        )

    # -- Failure parsing ------------------------------------------------------

    def parse_failure(  # noqa: PLR0911
        self, rc: int, stdout: str, stderr: str
    ) -> Failure | None:
        """Map a ``recon-all`` exit code and output into a structured failure.

        Recognize the OOM kill (``rc=137``), FreeSurfer license errors, and the
        white-surface / inflation failures that abort the stream, before falling
        back to a generic non-zero classification.

        Returns
        -------
        Failure or None
            Return the parsed failure or ``None`` when ``rc`` is zero.
        """
        if rc == 0:
            return None

        blob = f"{stdout}\n{stderr}".lower()

        if rc == OOM_EXIT_CODE:
            return Failure(
                code=rc,
                tag="oom_killed",
                message=(
                    "Increase available memory for recon-all after rc=137; allow at "
                    "least 32 GB and up to about 80 GB peak."
                ),
            )
        # recon-all exits 1 when one of its tools is killed; the kernel's
        # out-of-memory killer sends SIGKILL, which fs_time reports as
        # "Command terminated by signal 9". Name the tool so the operator
        # knows which stage needs the memory.
        killed_tool = _signal_killed_tool(f"{stdout}\n{stderr}")
        if killed_tool is not None:
            return Failure(
                code=rc,
                tag="oom_killed",
                message=(
                    f"Increase available memory for recon-all; {killed_tool} was "
                    "killed by signal 9, which is how the kernel ends a process "
                    "that ran out of memory. mri_synthseg alone needs about "
                    "24 GB free."
                ),
            )
        if "recon-all is already running" in blob:
            return Failure(
                code=rc,
                tag="stale_running_marker",
                message=(
                    "Retry the reconstruction; recon-all refused to start because "
                    "an interrupted run left scripts/IsRunning behind. Supraspina "
                    "removes that marker before continuing a subject when no "
                    "recon-all is running for it."
                ),
            )
        if "license" in blob and (
            "valid" in blob or "register" in blob or "freesurfer" in blob
        ):
            return Failure(
                code=rc,
                tag="license_error",
                message=(
                    "Provide a valid FreeSurfer license.txt in $FREESURFER_HOME or "
                    "set FS_LICENSE."
                ),
            )
        surface_failure: Failure | None = None
        if any(
            marker in blob
            for marker in (
                "mris_fix_topology",
                "topology correction failed",
                "topology fixing failed",
                "could not fix topology",
            )
        ):
            surface_failure = Failure(
                code=rc,
                tag="topology_failure",
                message="Inspect the failed surface topology correction.",
            )
        elif any(
            marker in blob
            for marker in (
                "mris_inflate",
                "inflation failed",
                "could not inflate",
            )
        ):
            surface_failure = Failure(
                code=rc,
                tag="inflation_failure",
                message="Inspect the failed surface inflation.",
            )
        elif (
            "white surface" in blob
            or "mris_make_surfaces" in blob
            or ("white" in blob and "surface" in blob)
        ):
            surface_failure = Failure(
                code=rc,
                tag="white_surface_failure",
                message="Inspect the failed white-surface generation.",
            )
        if surface_failure is not None:
            return surface_failure

        message = _last_informative_line(stderr or stdout or "") or (
            f"Inspect process exit code {rc}."
        )
        return Failure(code=rc, tag="nonzero_exit", message=message)


register(ReconAdapter())
