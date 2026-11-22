"""Tests for plan-time managed scientific-resource resolution."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from supraspina_sidecar import freesurfer_license, runtime_resources


def _cfg(
    *,
    brainfov: bool = False,
    backend: str = "freesurfer",
    device: str = "auto",
    features: bool = False,
    license_path: Path | None = None,
) -> dict[str, Any]:
    cfg: dict[str, Any] = {
        "steps": {
            "brainfov": {"enabled": brainfov, "params": {"marginMm": 30}},
            "recon": {
                "enabled": True,
                "params": {
                    "backend": backend,
                    "fastsurferDevice": device,
                },
            },
            "features": {"enabled": features, "params": {}},
        }
    }
    if license_path is not None:
        cfg["tools"] = {"freesurferLicense": str(license_path)}
    return cfg


def _license(tmp_path: Path, name: str = "license.txt") -> Path:
    path = tmp_path / name
    path.write_text("test-license\n", encoding="utf-8")
    return path


def _install_active_resources(
    monkeypatch: Any,
    *,
    synthstrip: bool = True,
    cpu: bool = True,
    cuda: bool = False,
    cuda_smoke: bool = False,
) -> None:
    monkeypatch.setattr(
        runtime_resources.shutil,
        "which",
        lambda name: f"/usr/bin/{name}" if name == "apptainer" else None,
    )
    monkeypatch.setattr(
        runtime_resources.scientific_resources,
        "active_synthstrip_sif",
        lambda _root, _pin: Path("/managed/synthstrip.sif") if synthstrip else None,
    )

    def active_fastsurfer(_root: Path, pin: Any) -> Path | None:
        if pin.variant == "cpu" and cpu:
            return Path("/managed/fastsurfer-cpu.sif")
        if pin.variant == "cuda" and cuda:
            return Path("/managed/fastsurfer-cuda.sif")
        return None

    monkeypatch.setattr(
        runtime_resources.scientific_resources,
        "active_fastsurfer_sif",
        active_fastsurfer,
    )
    monkeypatch.setattr(
        runtime_resources,
        "_cuda_runtime_ready",
        lambda _apptainer, _sif: (cuda_smoke, None if cuda_smoke else "smoke failed"),
    )


def test_resolves_synthstrip_and_cpu_fastsurfer_with_slow_advisory(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    _install_active_resources(monkeypatch)
    license_path = _license(tmp_path)

    result = runtime_resources.resolve_runtime_resources(
        _cfg(
            brainfov=True,
            backend="fastsurfer",
            device="auto",
            features=True,
            license_path=license_path,
        ),
        {"userDataPath": "/machine/user-data"},
    )

    assert result.runtime["userDataPath"] == "/machine/user-data"
    assert result.runtime["apptainerExecutable"] == "/usr/bin/apptainer"
    assert result.runtime["synthStripSifPath"] == "/managed/synthstrip.sif"
    assert result.runtime["fastSurferSifPath"] == "/managed/fastsurfer-cpu.sif"
    assert result.runtime["resolvedFastSurferDevice"] == "cpu"
    assert result.runtime["freesurferLicensePath"] == str(license_path)
    assert result.blockers == {}
    assert len(result.advisories) == 1
    assert result.advisories[0].startswith(
        "The verified CPU backend runs slowly because FastSurfer CUDA was "
        "unavailable at plan time ("
    )
    assert result.evidence["fastsurfer"]["variant"] == "cpu"


def test_auto_backend_authorizes_both_branches_and_starts_with_freesurfer(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    _install_active_resources(monkeypatch)
    license_path = _license(tmp_path)

    result = runtime_resources.resolve_runtime_resources(
        _cfg(backend="auto", device="cpu", license_path=license_path),
        {"userDataPath": "/machine/user-data"},
    )

    assert result.runtime["resolvedReconBackend"] == "freesurfer"
    assert result.runtime["authorizedReconBackends"] == [
        "freesurfer",
        "fastsurfer",
    ]
    assert result.runtime["resolvedFastSurferDevice"] == "cpu"
    assert result.blockers == {}


def test_device_auto_uses_cuda_only_after_host_and_container_smoke(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    _install_active_resources(
        monkeypatch,
        cpu=True,
        cuda=True,
        cuda_smoke=True,
    )
    license_path = _license(tmp_path)

    result = runtime_resources.resolve_runtime_resources(
        _cfg(
            backend="fastsurfer",
            device="auto",
            license_path=license_path,
        ),
        {"userDataPath": "/machine/user-data"},
    )

    assert result.runtime["resolvedFastSurferDevice"] == "cuda"
    assert result.runtime["fastSurferSifPath"] == "/managed/fastsurfer-cuda.sif"
    assert result.blockers == {}


def test_explicit_cuda_blocks_when_smoke_fails_without_cpu_fallback(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    _install_active_resources(
        monkeypatch,
        cpu=True,
        cuda=True,
        cuda_smoke=False,
    )
    license_path = _license(tmp_path)

    result = runtime_resources.resolve_runtime_resources(
        _cfg(
            backend="fastsurfer",
            device="cuda",
            license_path=license_path,
        ),
        {"userDataPath": "/machine/user-data"},
    )

    assert "recon" in result.blockers
    assert "CUDA" in result.blockers["recon"]
    assert "fastSurferSifPath" not in result.runtime


def test_missing_synthstrip_or_user_data_blocks_only_managed_steps(
    monkeypatch: Any,
) -> None:
    _install_active_resources(monkeypatch, synthstrip=False)

    missing = runtime_resources.resolve_runtime_resources(
        _cfg(brainfov=True),
        {"userDataPath": "/machine/user-data"},
    )
    unavailable = runtime_resources.resolve_runtime_resources(
        _cfg(brainfov=True, backend="fastsurfer"),
        {},
    )

    assert set(missing.blockers) == {"brainfov"}
    assert "provision" in missing.blockers["brainfov"].lower()
    assert set(unavailable.blockers) == {"brainfov", "recon"}


def test_fastsurfer_license_prefers_project_config_without_public_evidence(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    _install_active_resources(monkeypatch)
    configured = _license(tmp_path, "configured-license.txt")
    environment = _license(tmp_path, "environment-license.txt")
    freesurfer_home = tmp_path / "freesurfer"
    freesurfer_home.mkdir()
    home_license = _license(freesurfer_home)
    monkeypatch.setenv("FS_LICENSE", str(environment))
    monkeypatch.setenv("FREESURFER_HOME", str(freesurfer_home))
    cfg = _cfg(backend="fastsurfer", device="cpu", license_path=configured)

    result = runtime_resources.resolve_runtime_resources(
        cfg,
        {"userDataPath": "/machine/user-data"},
    )

    assert result.runtime["freesurferLicensePath"] == str(configured)
    public_payload = json.dumps(
        {
            "blockers": result.blockers,
            "advisories": result.advisories,
            "evidence": result.evidence,
        },
        sort_keys=True,
    )
    assert str(configured) not in public_payload
    assert str(environment) not in public_payload
    assert str(home_license) not in public_payload


def test_fastsurfer_license_uses_fs_license_before_freesurfer_home(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    _install_active_resources(monkeypatch)
    environment = _license(tmp_path, "environment-license.txt")
    freesurfer_home = tmp_path / "freesurfer"
    freesurfer_home.mkdir()
    _license(freesurfer_home)
    monkeypatch.setenv("FS_LICENSE", str(environment))
    monkeypatch.setenv("FREESURFER_HOME", str(freesurfer_home))

    result = runtime_resources.resolve_runtime_resources(
        _cfg(backend="fastsurfer", device="cpu"),
        {"userDataPath": "/machine/user-data"},
    )

    assert result.runtime["freesurferLicensePath"] == str(environment)
    assert result.blockers == {}


def test_fastsurfer_license_uses_freesurfer_home_default(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    _install_active_resources(monkeypatch)
    freesurfer_home = tmp_path / "freesurfer"
    freesurfer_home.mkdir()
    home_license = _license(freesurfer_home)
    monkeypatch.delenv("FS_LICENSE", raising=False)
    monkeypatch.setenv("FREESURFER_HOME", str(freesurfer_home))

    result = runtime_resources.resolve_runtime_resources(
        _cfg(backend="fastsurfer", device="cpu"),
        {"userDataPath": "/machine/user-data"},
    )

    assert result.runtime["freesurferLicensePath"] == str(home_license)
    assert result.blockers == {}


def test_fastsurfer_license_uses_interpolated_project_home_default(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    _install_active_resources(monkeypatch)
    freesurfer_home = tmp_path / "freesurfer"
    freesurfer_home.mkdir()
    home_license = _license(freesurfer_home)
    monkeypatch.delenv("FS_LICENSE", raising=False)
    monkeypatch.delenv("FREESURFER_HOME", raising=False)
    cfg = _cfg(backend="fastsurfer", device="cpu")
    cfg["paths"] = {"freesurferRoot": str(freesurfer_home)}
    cfg["tools"] = {"freesurferHome": "${paths.freesurferRoot}"}

    result = runtime_resources.resolve_runtime_resources(
        cfg,
        {"userDataPath": "/machine/user-data"},
    )

    assert result.runtime["freesurferLicensePath"] == str(home_license)
    assert result.blockers == {}


def test_unreadable_selected_fastsurfer_license_blocks_without_fallback(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    _install_active_resources(monkeypatch)
    unreadable = _license(tmp_path, "configured-license.txt")
    environment = _license(tmp_path, "environment-license.txt")
    monkeypatch.setenv("FS_LICENSE", str(environment))
    real_access = freesurfer_license.os.access
    monkeypatch.setattr(
        freesurfer_license.os,
        "access",
        lambda path, mode: (
            False if path == str(unreadable) else real_access(path, mode)
        ),
    )

    result = runtime_resources.resolve_runtime_resources(
        _cfg(
            backend="fastsurfer",
            device="cpu",
            features=True,
            license_path=unreadable,
        ),
        {"userDataPath": "/machine/user-data"},
    )

    assert set(result.blockers) == {"recon", "features"}
    assert result.blockers["recon"] == result.blockers["features"]
    assert "readable, non-empty regular FreeSurfer license" in result.blockers["recon"]
    assert len(result.blockers["recon"]) <= 240
    assert str(unreadable) not in result.blockers["recon"]
    assert "freesurferLicensePath" not in result.runtime
    assert "fastsurfer" not in result.evidence


def test_non_regular_fastsurfer_license_blocks_reconstruction(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    _install_active_resources(monkeypatch)
    directory = tmp_path / "license-directory"
    directory.mkdir()

    result = runtime_resources.resolve_runtime_resources(
        _cfg(backend="fastsurfer", device="cpu", license_path=directory),
        {"userDataPath": "/machine/user-data"},
    )

    assert set(result.blockers) == {"recon"}
    assert "freesurferLicensePath" not in result.runtime
