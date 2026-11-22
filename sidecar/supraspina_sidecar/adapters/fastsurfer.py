"""FastSurfer 2.5.4 command and artifact contracts.

The full FastSurfer segmentation and surface pipeline runs from a verified
machine-local Apptainer SIF. Only the selected T1,
backend-specific output parent, and user-managed FreeSurfer license are bound;
inputs and the license mount read-only, and the container and host environments
are cleaned. ``--fsaparc`` is required so downstream stages receive conventional
and Destrieux statistics.
"""

from __future__ import annotations

import csv
import io
import os
import re
from collections.abc import Mapping
from typing import Any

from ..paths import flatten, interpolate
from ..run_store import RECEIPT_VERSION
from ..scientific_resources import CLEAN_HOST_ENV_PREFIX

FREESURFER_BACKEND = "freesurfer"
FASTSURFER_BACKEND = "fastsurfer"
AUTO_BACKEND = "auto"
RECON_BACKENDS = frozenset({FREESURFER_BACKEND, FASTSURFER_BACKEND, AUTO_BACKEND})

CPU_DEVICE = "cpu"
CUDA_DEVICE = "cuda"
AUTO_DEVICE = "auto"
FASTSURFER_DEVICES = frozenset({CPU_DEVICE, CUDA_DEVICE, AUTO_DEVICE})

FASTSURFER_SUBDIR = "fastsurfer"

# FastSurfer 2.5.4 release containers are built on the FreeSurfer 7.4.1
# runtime. Bind the corresponding ENIGMA wrapper branch to the pinned
# FastSurfer version instead of asking operators to guess from filenames.
FASTSURFER_FREESURFER_COMPATIBILITY_VERSION = "7.4.1"
FASTSURFER_FREESURFER_COMPATIBILITY_MAJOR = (
    FASTSURFER_FREESURFER_COMPATIBILITY_VERSION.partition(".")[0]
)

_CONTAINER_T1 = "/supraspina/input/t1.nii.gz"
_CONTAINER_OUTPUT = "/supraspina/output"
_CONTAINER_LICENSE = "/supraspina/license/license.txt"
_NO_AUTOMATIC_MOUNTS = "hostfs,cwd,home"
_MAX_THREADS = 32
_BACKEND_RECEIPT_VERSION = 2
_FREESURFER_MAJOR_VERSION = re.compile(r"(?<!\d)([5-8])(?:\.\d+)+(?!\d)")

# Require the full downstream superset. Accept either normalized-volume name in
# the final group because FreeSurfer and FastSurfer releases differ there.
COMMON_RECON_ARTIFACT_GROUPS: tuple[tuple[str, ...], ...] = (
    ("surf/lh.pial",),
    ("surf/rh.pial",),
    ("surf/lh.white",),
    ("surf/rh.white",),
    ("stats/aseg.stats",),
    ("stats/wmparc.stats",),
    ("stats/lh.aparc.stats",),
    ("stats/rh.aparc.stats",),
    ("stats/lh.aparc.a2009s.stats",),
    ("stats/rh.aparc.a2009s.stats",),
    ("mri/aparc+aseg.mgz",),
    ("mri/nu.mgz", "mri/orig_nu.mgz"),
)
BACKEND_MARKER: Mapping[str, str] = {
    FREESURFER_BACKEND: "scripts/recon-all.done",
    FASTSURFER_BACKEND: "scripts/deep-seg.log",
}


def _runtime(cfg: dict[str, Any]) -> dict[str, Any]:
    value = cfg.get("_supraspinaRuntime", {})
    return value if isinstance(value, dict) else {}


def _raw_recon_params(cfg: dict[str, Any]) -> dict[str, Any]:
    steps = cfg.get("steps", {})
    recon = steps.get("recon", {}) if isinstance(steps, dict) else {}
    params = recon.get("params", {}) if isinstance(recon, dict) else {}
    return params if isinstance(params, dict) else {}


def selected_backend(cfg: dict[str, Any]) -> str:
    """Return the concrete reconstruction backend selected at plan time.

    Select FreeSurfer when ``backend`` is absent. Require an ``auto`` request to
    carry a valid ``_supraspinaRuntime.resolvedReconBackend`` written by the reviewed
    plan. Never probe or change the choice during execution.

    Returns
    -------
    str
        Return ``freesurfer`` or ``fastsurfer``.

    Raises
    ------
    ValueError
        Raise when a configured or resolved backend is invalid or unresolved.
    """
    requested = _raw_recon_params(cfg).get("backend", FREESURFER_BACKEND)
    if requested not in RECON_BACKENDS:
        raise ValueError("Select a valid reconstruction backend.")
    if requested != AUTO_BACKEND:
        return str(requested)
    resolved = _runtime(cfg).get("resolvedReconBackend")
    if resolved not in {FREESURFER_BACKEND, FASTSURFER_BACKEND}:
        raise ValueError(
            "Resolve backend auto through _supraspinaRuntime.resolvedReconBackend."
        )
    return str(resolved)


def selected_fastsurfer_device(cfg: dict[str, Any]) -> str:
    """Return the concrete FastSurfer device selected at plan time.

    Returns
    -------
    str
        Return ``cpu`` or ``cuda``.

    Raises
    ------
    ValueError
        Raise when a configured or resolved device is invalid or unresolved.
    """
    requested = _raw_recon_params(cfg).get("fastsurferDevice", AUTO_DEVICE)
    if requested not in FASTSURFER_DEVICES:
        raise ValueError("Select a valid FastSurfer device.")
    if requested != AUTO_DEVICE:
        return str(requested)
    resolved = _runtime(cfg).get("resolvedFastSurferDevice")
    if resolved not in {CPU_DEVICE, CUDA_DEVICE}:
        raise ValueError(
            "Resolve FastSurfer device auto through "
            "_supraspinaRuntime.resolvedFastSurferDevice."
        )
    return str(resolved)


def reconstruction_subdir(cfg: dict[str, Any]) -> str:
    """Return the backend-owned derivative subdirectory."""
    return selected_backend(cfg)


def reconstruction_artifact_groups(
    backend: str,
) -> tuple[tuple[str, ...], ...]:
    """Return required artifact alternatives for one reconstruction backend.

    Parameters
    ----------
    backend
        Provide the concrete ``freesurfer`` or ``fastsurfer`` backend.

    Returns
    -------
    tuple
        Return one group per completion requirement. Require at least one path
        in each group to be a non-empty regular file.
    """
    if backend not in BACKEND_MARKER:
        raise ValueError("Select a valid reconstruction backend.")
    return ((BACKEND_MARKER[backend],), *COMMON_RECON_ARTIFACT_GROUPS)


def _resolved_path(value: Any, cfg: dict[str, Any], label: str) -> str:
    path = interpolate(str(value or ""), flatten(cfg))
    if not path or "\x00" in path or "\n" in path or "\r" in path:
        raise ValueError(f"Provide {label}.")
    return path


def _t1_path(cfg: dict[str, Any], subject_id: str) -> str:
    runtime_map = _runtime(cfg).get("reconInputBySubject")
    selected = runtime_map.get(subject_id) if isinstance(runtime_map, dict) else None
    if isinstance(selected, str) and selected:
        return _resolved_path(selected, cfg, "FastSurfer T1 input")
    paths = cfg.get("paths", {})
    rawdata = paths.get("rawdataDir") if isinstance(paths, dict) else ""
    rawdata_path = _resolved_path(rawdata, cfg, "rawdata directory")
    return os.path.join(
        rawdata_path,
        subject_id,
        "anat",
        f"{subject_id}_T1w.nii.gz",
    )


def _output_parent(cfg: dict[str, Any]) -> str:
    paths = cfg.get("paths", {})
    derivatives = paths.get("derivativesDir") if isinstance(paths, dict) else ""
    derivatives_path = _resolved_path(derivatives, cfg, "derivatives directory")
    return os.path.join(derivatives_path, FASTSURFER_SUBDIR)


def _license_path(cfg: dict[str, Any]) -> str:
    tools = cfg.get("tools", {})
    configured = tools.get("freesurferLicense") if isinstance(tools, dict) else ""
    runtime = _runtime(cfg)
    value = runtime.get("freesurferLicensePath") or configured
    return _resolved_path(value, cfg, "FreeSurfer license")


def _sif_path(cfg: dict[str, Any]) -> str:
    runtime = _runtime(cfg)
    tools = cfg.get("tools", {})
    fallback = tools.get("fastSurferSif") if isinstance(tools, dict) else ""
    return _resolved_path(
        runtime.get("fastSurferSifPath") or fallback,
        cfg,
        "verified FastSurfer SIF",
    )


def _threads(cfg: dict[str, Any]) -> int:
    runtime = cfg.get("runtime", {})
    params = _raw_recon_params(cfg)
    value = (
        runtime.get("threads")
        if isinstance(runtime, dict) and runtime.get("threads") is not None
        else params.get("threads", 6)
    )
    try:
        threads = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Provide FastSurfer threads as an integer.") from exc
    if not 1 <= threads <= _MAX_THREADS:
        raise ValueError("Keep FastSurfer threads between 1 and 32.")
    return threads


def _mount(source: str, destination: str, mode: str) -> str:
    if mode not in {"ro", "rw"}:
        raise ValueError("Select a valid container mount mode.")
    fields = ["type=bind", f"src={source}", f"dst={destination}"]
    # Leave mounts writable by default because Apptainer rejects an explicit
    # ``rw`` --mount key. Add a mode flag only for read-only mounts.
    if mode == "ro":
        fields.append("ro")
    stream = io.StringIO(newline="")
    csv.writer(stream, lineterminator="").writerow(fields)
    return stream.getvalue()


def build_fastsurfer_command(
    cfg: dict[str, Any],
    subject_id: str | None,
) -> list[str]:
    """Build a full CPU or CUDA FastSurfer Apptainer command.

    Always run segmentation and surfaces with ``--fsaparc``. Never emit
    ``--seg_only``. Expose the NVIDIA runtime for CUDA with
    ``--nv`` while view aggregation remains on CPU to bound VRAM demand.

    Parameters
    ----------
    cfg
        Provide the effective run configuration carrying a verified SIF path.
    subject_id
        Provide the subject id or ``None`` for a dry-run placeholder.

    Returns
    -------
    list of str
        Return clean-environment Apptainer run argv.
    """
    if selected_backend(cfg) != FASTSURFER_BACKEND:
        raise ValueError("Select the FastSurfer backend before building its command.")
    subject = subject_id if subject_id is not None else "${subject}"
    device = selected_fastsurfer_device(cfg)
    runtime = _runtime(cfg)
    apptainer = _resolved_path(
        runtime.get("apptainerExecutable") or "apptainer",
        cfg,
        "Apptainer executable",
    )
    argv = [
        *CLEAN_HOST_ENV_PREFIX,
        apptainer,
        "run",
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
    ]
    if device == CUDA_DEVICE:
        argv.append("--nv")
    argv.extend(
        [
            "--mount",
            _mount(_t1_path(cfg, subject), _CONTAINER_T1, "ro"),
            "--mount",
            _mount(_output_parent(cfg), _CONTAINER_OUTPUT, "rw"),
            "--mount",
            _mount(_license_path(cfg), _CONTAINER_LICENSE, "ro"),
            _sif_path(cfg),
            "--fs_license",
            _CONTAINER_LICENSE,
            "--t1",
            _CONTAINER_T1,
            "--sid",
            subject,
            "--sd",
            _CONTAINER_OUTPUT,
            "--fsaparc",
            "--qc_snap",
            "--threads",
            str(_threads(cfg)),
            "--device",
            device,
            "--viewagg_device",
            CPU_DEVICE,
        ]
    )
    return argv


def reconstruction_backend_from_receipt(receipt: dict[str, Any]) -> str | None:
    """Return the selected backend from an already validated recon receipt.

    Require current receipts to carry a separately digest-bound
    ``reconstruction.receiptVersion=2`` envelope inside the current outer
    receipt contract. Keep digest validation with the caller.

    Parameters
    ----------
    receipt
        Provide a previously digest-validated durable receipt.

    Returns
    -------
    str or None
        Return ``freesurfer``, ``fastsurfer``, or ``None`` for another or
        malformed contract.
    """
    if (
        receipt.get("stepKey") != "recon"
        or receipt.get("receiptVersion") != RECEIPT_VERSION
    ):
        return None
    reconstruction = receipt.get("reconstruction")
    if (
        isinstance(reconstruction, dict)
        and reconstruction.get("receiptVersion") == _BACKEND_RECEIPT_VERSION
    ):
        backend = (
            reconstruction.get("backend") if isinstance(reconstruction, dict) else None
        )
        return str(backend) if backend in BACKEND_MARKER else None
    return None


def reconstruction_freesurfer_major_from_receipt(
    receipt: dict[str, Any],
) -> str | None:
    """Return the ENIGMA-compatible FreeSurfer major from a recon receipt.

    FreeSurfer receipts carry the detected release string. FastSurfer receipts
    are bound to the compatibility release of the pinned container image. A
    missing or unparseable FreeSurfer release remains unknown so the caller can
    fail closed before selecting a version-dependent ENIGMA input branch.
    """
    backend = reconstruction_backend_from_receipt(receipt)
    if backend == FASTSURFER_BACKEND:
        return FASTSURFER_FREESURFER_COMPATIBILITY_MAJOR
    if backend != FREESURFER_BACKEND:
        return None
    reconstruction = receipt.get("reconstruction")
    provider = (
        reconstruction.get("provider") if isinstance(reconstruction, dict) else None
    )
    version = provider.get("version") if isinstance(provider, dict) else None
    if not isinstance(version, str):
        return None
    match = _FREESURFER_MAJOR_VERSION.search(version)
    return match.group(1) if match is not None else None
