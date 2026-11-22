"""Resolution of verified scientific containers into one reviewed workflow plan."""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import scientific_resources
from .freesurfer_license import (
    is_readable_freesurfer_license,
    resolve_freesurfer_license_path,
)

_MANAGED_STEPS = ("brainfov", "recon", "features")
_CUDA_SMOKE_TIMEOUT_SECONDS = 60
_FASTSURFER_LICENSE_BLOCKER = (
    "Provide a readable, non-empty regular FreeSurfer license through "
    "tools.freesurferLicense, FS_LICENSE, or FREESURFER_HOME/license.txt."
)


@dataclass(frozen=True)
class RuntimeResourceResolution:
    """Represent private runtime values, blockers, and public evidence."""

    runtime: dict[str, Any]
    blockers: dict[str, str]
    advisories: tuple[str, ...]
    evidence: dict[str, Any]


@dataclass
class _ResolutionState:
    runtime: dict[str, Any]
    blockers: dict[str, str]
    advisories: list[str]
    evidence: dict[str, Any]
    user_data: Path | None
    apptainer: str | None


def _enabled(cfg: dict[str, Any], step_key: str) -> bool:
    steps = cfg.get("steps", {}) if isinstance(cfg.get("steps"), dict) else {}
    value = steps.get(step_key, {}) if isinstance(steps.get(step_key), dict) else {}
    return bool(value.get("enabled", False))


def _recon_params(cfg: dict[str, Any]) -> dict[str, Any]:
    steps = cfg.get("steps", {}) if isinstance(cfg.get("steps"), dict) else {}
    recon = steps.get("recon", {}) if isinstance(steps.get("recon"), dict) else {}
    params = recon.get("params", {}) if isinstance(recon.get("params"), dict) else {}
    return params if isinstance(params, dict) else {}


def _resource_identity(resource: str, variant: str, pin: Any) -> dict[str, Any]:
    return {
        "resource": resource,
        "variant": variant,
        "version": (
            scientific_resources.SYNTHSTRIP_VERSION
            if resource == "synthstrip"
            else scientific_resources.FASTSURFER_VERSION
        ),
        "sifBytes": pin.size_bytes,
        "sifSha256": pin.sha256,
        "ociManifestDigest": pin.oci_manifest_digest,
        "apptainerVersion": pin.apptainer_version,
    }


def _cuda_runtime_ready(apptainer: str, sif: Path) -> tuple[bool, str | None]:
    """Require both host NVML and in-container PyTorch CUDA availability."""
    clean_env = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG": "C",
    }
    nvidia_smi = shutil.which("nvidia-smi")
    if nvidia_smi is None:
        return False, "nvidia-smi is unavailable"
    try:
        host = subprocess.run(  # noqa: S603
            [nvidia_smi, "-L"],
            check=False,
            capture_output=True,
            timeout=10,
            env=clean_env,
        )
    except (OSError, subprocess.SubprocessError):
        return False, "nvidia-smi is unavailable"
    if host.returncode != 0:
        return False, "nvidia-smi did not complete successfully"
    command = [
        apptainer,
        "exec",
        "--cleanenv",
        "--containall",
        "--no-home",
        "--no-mount",
        "hostfs,cwd,home",
        "--cwd",
        "/",
        "--net",
        "--network",
        "none",
        "--nv",
        str(sif),
        "/venv/bin/python3",
        "-c",
        ("import sys,torch;sys.exit(0 if bool(torch.cuda.is_available()) else 1)"),
    ]
    try:
        smoke = subprocess.run(  # noqa: S603
            command,
            check=False,
            capture_output=True,
            timeout=_CUDA_SMOKE_TIMEOUT_SECONDS,
            env=clean_env,
        )
    except (OSError, subprocess.SubprocessError):
        return False, "the in-container CUDA smoke could not run"
    if smoke.returncode != 0:
        return False, "the in-container PyTorch CUDA smoke failed"
    return True, None


def _block(
    blockers: dict[str, str],
    reason: str,
    *steps: str,
) -> None:
    for step in steps:
        blockers[step] = reason


def _resolve_synthstrip(
    state: _ResolutionState,
) -> None:
    if state.user_data is None or state.apptainer is None:
        _block(
            state.blockers,
            "Provide Linux/WSL Apptainer and the managed SynthStrip 1.8 "
            "resource for Brain FOV preparation.",
            "brainfov",
        )
        return
    pin = scientific_resources.SYNTHSTRIP_RELEASE_PIN
    sif = scientific_resources.active_synthstrip_sif(state.user_data, pin)
    if sif is None:
        _block(
            state.blockers,
            "Provision and exactly verify SynthStrip 1.8 in Diagnostics.",
            "brainfov",
        )
        return
    state.runtime["synthStripSifPath"] = str(sif)
    state.evidence["synthstrip"] = _resource_identity("synthstrip", "cpu", pin)


def _select_fastsurfer_variant(
    *,
    device: Any,
    apptainer: str,
    cpu_sif: Path | None,
    cuda_sif: Path | None,
) -> tuple[str | None, Path | None, str | None]:
    selected_variant: str | None = None
    selected_sif: Path | None = None
    cuda_reason: str | None = None
    if device in {"auto", "cuda"}:
        if cuda_sif is None:
            cuda_reason = "the CUDA SIF is not provisioned"
        else:
            cuda_ready, cuda_reason = _cuda_runtime_ready(apptainer, cuda_sif)
            if cuda_ready:
                selected_variant = "cuda"
                selected_sif = cuda_sif
    if device == "cpu":
        selected_variant = "cpu" if cpu_sif is not None else None
        selected_sif = cpu_sif
    elif device == "auto" and selected_sif is None and cpu_sif is not None:
        selected_variant = "cpu"
        selected_sif = cpu_sif
    return selected_variant, selected_sif, cuda_reason


def _resolve_fastsurfer(
    state: _ResolutionState,
    cfg: dict[str, Any],
    backend: Any,
    device: Any,
) -> None:
    affected = ("recon", "features") if _enabled(cfg, "features") else ("recon",)
    license_path = resolve_freesurfer_license_path(cfg)
    if not is_readable_freesurfer_license(license_path):
        _block(state.blockers, _FASTSURFER_LICENSE_BLOCKER, *affected)
        return
    state.runtime["freesurferLicensePath"] = license_path
    if state.user_data is None or state.apptainer is None:
        _block(
            state.blockers,
            "Provide Linux/WSL Apptainer and a verified managed FastSurfer "
            "2.5.4 resource.",
            *affected,
        )
        return
    if device not in {"auto", "cpu", "cuda"}:
        _block(
            state.blockers,
            "Select a valid FastSurfer device.",
            *affected,
        )
        return
    cpu_pin = scientific_resources.FASTSURFER_RELEASE_PINS["cpu"]
    cuda_pin = scientific_resources.FASTSURFER_RELEASE_PINS["cuda"]
    cpu_sif = scientific_resources.active_fastsurfer_sif(state.user_data, cpu_pin)
    cuda_sif = scientific_resources.active_fastsurfer_sif(state.user_data, cuda_pin)
    selected_variant, selected_sif, cuda_reason = _select_fastsurfer_variant(
        device=device,
        apptainer=state.apptainer,
        cpu_sif=cpu_sif,
        cuda_sif=cuda_sif,
    )
    if device == "auto" and selected_variant == "cpu":
        state.advisories.append(
            "The verified CPU backend runs slowly because FastSurfer CUDA was "
            f"unavailable at plan time ({cuda_reason or 'runtime checks failed'})."
        )
    if selected_sif is None or selected_variant is None:
        reason = (
            "Resolve FastSurfer CUDA before running it: "
            f"{cuda_reason or 'CUDA verification failed'}."
            if device == "cuda"
            else "Provision and exactly verify the requested FastSurfer 2.5.4 SIF."
        )
        _block(state.blockers, reason, *affected)
        return
    selected_pin = scientific_resources.FASTSURFER_RELEASE_PINS[selected_variant]
    state.runtime["resolvedFastSurferDevice"] = selected_variant
    state.runtime["fastSurferSifPath"] = str(selected_sif)
    state.evidence["fastsurfer"] = _resource_identity(
        "fastsurfer", selected_variant, selected_pin
    )
    if backend == "auto":
        state.evidence["fastsurfer"]["role"] = "authorized-fallback"


def resolve_runtime_resources(
    cfg: dict[str, Any],
    runtime_context: Any,
) -> RuntimeResourceResolution:
    """Resolve active exact SIFs and the concrete FastSurfer device.

    Keep returned runtime paths private to execution. Record only immutable
    release identities and resolution outcomes in public plan evidence.
    """
    runtime: dict[str, Any] = {}
    blockers: dict[str, str] = {}
    advisories: list[str] = []
    evidence: dict[str, Any] = {}
    context = runtime_context if isinstance(runtime_context, dict) else {}
    raw_user_data = context.get("userDataPath")
    user_data = (
        Path(os.path.realpath(raw_user_data))
        if isinstance(raw_user_data, str)
        and raw_user_data
        and os.path.isabs(raw_user_data)
        and "\x00" not in raw_user_data
        else None
    )
    apptainer = shutil.which("apptainer")
    brainfov_enabled = _enabled(cfg, "brainfov")
    params = _recon_params(cfg)
    backend = params.get("backend", "freesurfer")
    device = params.get("fastsurferDevice", "auto")
    fastsurfer_needed = backend in {"fastsurfer", "auto"} or (
        _enabled(cfg, "features") and backend == "fastsurfer"
    )

    if user_data is not None:
        runtime["userDataPath"] = str(user_data)
    if apptainer is not None:
        runtime["apptainerExecutable"] = apptainer
    state = _ResolutionState(
        runtime=runtime,
        blockers=blockers,
        advisories=advisories,
        evidence=evidence,
        user_data=user_data,
        apptainer=apptainer,
    )

    if brainfov_enabled:
        _resolve_synthstrip(state)

    if backend == "auto":
        runtime["resolvedReconBackend"] = "freesurfer"
        runtime["authorizedReconBackends"] = ["freesurfer", "fastsurfer"]
    elif backend in {"freesurfer", "fastsurfer"}:
        runtime["resolvedReconBackend"] = backend

    if fastsurfer_needed:
        _resolve_fastsurfer(
            state,
            cfg=cfg,
            backend=backend,
            device=device,
        )

    return RuntimeResourceResolution(
        runtime=runtime,
        blockers={
            key: value for key, value in blockers.items() if key in _MANAGED_STEPS
        },
        advisories=tuple(advisories),
        evidence=evidence,
    )
