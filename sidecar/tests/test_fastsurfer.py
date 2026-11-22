"""Tests for FastSurfer reconstruction commands and completion contracts."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.adapters.fastsurfer import (
    FASTSURFER_SUBDIR,
    build_fastsurfer_command,
    reconstruction_backend_from_receipt,
    selected_backend,
    selected_fastsurfer_device,
)
from supraspina_sidecar.adapters.recon import ReconAdapter
from supraspina_sidecar.run_store import RECEIPT_VERSION, RECONSTRUCTION_RECEIPT_VERSION


def _cfg(
    *,
    backend: str = "fastsurfer",
    device: str = "cpu",
    derivatives_dir: str = "/project/derivatives",
) -> dict[str, Any]:
    return {
        "paths": {
            "rawdataDir": "/project/rawdata",
            "derivativesDir": derivatives_dir,
        },
        "tools": {
            "freesurferHome": "/opt/freesurfer",
            "freesurferLicense": "/licenses/license.txt",
        },
        "runtime": {"threads": 6},
        "steps": {
            "recon": {
                "enabled": True,
                "params": {
                    "backend": backend,
                    "fastsurferDevice": device,
                    "directives": "-all",
                    "parallel": True,
                },
            }
        },
        "_supraspinaRuntime": {
            "reconInputBySubject": {
                "sub-001": "/prepared/sub-001_desc-brainfov_T1w.nii.gz"
            },
            "fastSurferSifPath": "/resources/fastsurfer-cpu.sif",
        },
    }


def _write_artifact_tree(root: Path, backend: str, subject_id: str) -> None:
    subject = root / backend / subject_id
    required = [
        "surf/lh.pial",
        "surf/rh.pial",
        "surf/lh.white",
        "surf/rh.white",
        "stats/aseg.stats",
        "stats/wmparc.stats",
        "stats/lh.aparc.stats",
        "stats/rh.aparc.stats",
        "stats/lh.aparc.a2009s.stats",
        "stats/rh.aparc.a2009s.stats",
        "mri/aparc+aseg.mgz",
        "mri/orig_nu.mgz",
        (
            "scripts/deep-seg.log"
            if backend == FASTSURFER_SUBDIR
            else "scripts/recon-all.done"
        ),
    ]
    for relative in required:
        target = subject / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"artifact\n")


def test_selected_backend_defaults_to_freesurfer() -> None:
    cfg = _cfg()
    cfg["steps"]["recon"]["params"].pop("backend")

    assert selected_backend(cfg) == "freesurfer"


@pytest.mark.parametrize("backend", ["freesurfer", "fastsurfer"])
def test_selected_backend_accepts_explicit_backend(backend: str) -> None:
    assert selected_backend(_cfg(backend=backend)) == backend


def test_selected_backend_requires_plan_time_auto_resolution() -> None:
    cfg = _cfg(backend="auto")

    with pytest.raises(ValueError, match="resolvedReconBackend"):
        selected_backend(cfg)

    cfg["_supraspinaRuntime"]["resolvedReconBackend"] = "fastsurfer"
    assert selected_backend(cfg) == "fastsurfer"


def test_selected_device_requires_plan_time_auto_resolution() -> None:
    cfg = _cfg(device="auto")

    with pytest.raises(ValueError, match="resolvedFastSurferDevice"):
        selected_fastsurfer_device(cfg)

    cfg["_supraspinaRuntime"]["resolvedFastSurferDevice"] = "cuda"
    assert selected_fastsurfer_device(cfg) == "cuda"


def test_cpu_command_is_full_clean_and_explicitly_mounted() -> None:
    cfg = _cfg()

    argv = build_fastsurfer_command(cfg, "sub-001")

    assert argv[:4] == [
        "env",
        "-i",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C",
    ]
    assert "apptainer" in argv
    assert "run" in argv
    assert "--cleanenv" in argv
    assert "--containall" in argv
    assert "--no-home" in argv
    assert argv[argv.index("--no-mount") + 1] == "hostfs,cwd,home"
    assert argv[argv.index("--cwd") + 1] == "/"
    assert argv[argv.index("--network") + 1] == "none"
    assert "--net" in argv
    assert "--nv" not in argv
    assert "--seg_only" not in argv
    assert "--fsaparc" in argv
    assert "--qc_snap" in argv
    assert argv[argv.index("--threads") + 1] == "6"
    assert argv[argv.index("--device") + 1] == "cpu"
    assert argv[argv.index("--viewagg_device") + 1] == "cpu"
    assert argv[argv.index("--sid") + 1] == "sub-001"
    assert argv[argv.index("--sd") + 1] == "/supraspina/output"
    assert argv[argv.index("--t1") + 1] == "/supraspina/input/t1.nii.gz"
    assert argv[argv.index("--fs_license") + 1] == "/supraspina/license/license.txt"

    mounts = [argv[index + 1] for index, value in enumerate(argv) if value == "--mount"]
    assert any(
        "src=/prepared/sub-001_desc-brainfov_T1w.nii.gz" in mount
        and "dst=/supraspina/input/t1.nii.gz" in mount
        and mount.endswith(",ro")
        for mount in mounts
    )
    assert any(
        "src=/project/derivatives/fastsurfer" in mount
        and "dst=/supraspina/output" in mount
        and not mount.endswith(",rw")
        for mount in mounts
    )
    assert all(",rw" not in mount for mount in mounts)
    assert any(
        "src=/licenses/license.txt" in mount
        and "dst=/supraspina/license/license.txt" in mount
        and mount.endswith(",ro")
        for mount in mounts
    )


def test_cuda_command_enables_apptainer_nv_but_keeps_view_aggregation_on_cpu() -> None:
    argv = build_fastsurfer_command(_cfg(device="cuda"), "sub-001")

    assert "--nv" in argv
    assert argv[argv.index("--device") + 1] == "cuda"
    assert argv[argv.index("--viewagg_device") + 1] == "cpu"


def test_recon_adapter_uses_fastsurfer_command_and_redacts_license_preview() -> None:
    cfg = _cfg()

    argv = ReconAdapter().build_command(cfg, "sub-001")
    preview = ReconAdapter().preview(cfg, "sub-001")

    assert argv == build_fastsurfer_command(cfg, "sub-001")
    assert "/licenses/license.txt" not in preview
    assert "[FS_LICENSE]" in preview


def test_absent_recon_backend_params_still_select_freesurfer() -> None:
    absent = _cfg(backend="freesurfer")
    explicit = _cfg(backend="freesurfer")
    absent["steps"]["recon"]["params"].pop("backend", None)
    absent["steps"]["recon"]["params"].pop("fastsurferDevice", None)

    assert selected_backend(absent) == selected_backend(explicit)
    assert ReconAdapter().build_command(absent, "sub-001") == (
        ReconAdapter().build_command(explicit, "sub-001")
    )


@pytest.mark.parametrize(
    ("backend", "product"),
    [("freesurfer", "FreeSurfer"), ("fastsurfer", "FastSurfer")],
)
def test_recon_detector_requires_full_downstream_artifact_superset(
    tmp_path: Path, backend: str, product: str
) -> None:
    cfg = _cfg(backend=backend, derivatives_dir=str(tmp_path))
    _write_artifact_tree(tmp_path, backend, "sub-001")

    status = ReconAdapter().detect(cfg, "sub-001")

    assert status.state == "done"
    assert status.detail == f"The {product} reconstruction is complete."
    assert len(status.artifacts) == 13
    assert any(path.endswith("lh.white") for path in status.artifacts)
    assert any(path.endswith("lh.aparc.a2009s.stats") for path in status.artifacts)
    assert any(path.endswith("aparc+aseg.mgz") for path in status.artifacts)
    assert any(path.endswith("orig_nu.mgz") for path in status.artifacts)


def test_recon_detector_accepts_nu_mgz_alternative(tmp_path: Path) -> None:
    cfg = _cfg(derivatives_dir=str(tmp_path))
    _write_artifact_tree(tmp_path, FASTSURFER_SUBDIR, "sub-001")
    subject = tmp_path / FASTSURFER_SUBDIR / "sub-001"
    (subject / "mri/orig_nu.mgz").unlink()
    (subject / "mri/nu.mgz").write_bytes(b"artifact\n")

    status = ReconAdapter().detect(cfg, "sub-001")

    assert status.state == "done"
    assert any(path.endswith("/mri/nu.mgz") for path in status.artifacts)


def test_recon_detector_never_uses_other_backend_tree(tmp_path: Path) -> None:
    cfg = _cfg(backend="fastsurfer", derivatives_dir=str(tmp_path))
    _write_artifact_tree(tmp_path, "freesurfer", "sub-001")

    status = ReconAdapter().detect(cfg, "sub-001")

    assert status.state == "pending"
    assert status.artifacts == []


def test_recon_detector_reports_empty_required_file_as_partial(tmp_path: Path) -> None:
    cfg = _cfg(derivatives_dir=str(tmp_path))
    _write_artifact_tree(tmp_path, FASTSURFER_SUBDIR, "sub-001")
    (tmp_path / FASTSURFER_SUBDIR / "sub-001/stats/wmparc.stats").write_bytes(b"")

    status = ReconAdapter().detect(cfg, "sub-001")

    assert status.state == "partial"
    assert "wmparc.stats" in status.detail


@pytest.mark.parametrize("backend", ["freesurfer", "fastsurfer"])
def test_prepare_execution_creates_only_selected_backend_parent(
    tmp_path: Path, backend: str
) -> None:
    cfg = _cfg(backend=backend, derivatives_dir=str(tmp_path / "derivatives"))

    ReconAdapter().prepare_execution(cfg, "sub-001")

    selected = tmp_path / "derivatives" / backend
    other = (
        tmp_path
        / "derivatives"
        / ("freesurfer" if backend == "fastsurfer" else "fastsurfer")
    )
    assert selected.is_dir()
    assert not other.exists()
    assert not (selected / "sub-001").exists()


def test_prepare_execution_rejects_non_directory_backend_parent(
    tmp_path: Path,
) -> None:
    derivatives = tmp_path / "derivatives"
    derivatives.mkdir()
    (derivatives / FASTSURFER_SUBDIR).write_bytes(b"not a directory")
    cfg = _cfg(derivatives_dir=str(derivatives))

    with pytest.raises(NotADirectoryError, match="FastSurfer output parent"):
        ReconAdapter().prepare_execution(cfg, "sub-001")


def test_backend_receipt_helper_accepts_only_current_reconstruction_receipts() -> None:
    assert (
        reconstruction_backend_from_receipt(
            {
                "stepKey": "recon",
                "receiptVersion": RECEIPT_VERSION,
                "reconstruction": {
                    "receiptVersion": RECONSTRUCTION_RECEIPT_VERSION,
                    "backend": "fastsurfer",
                },
            }
        )
        == "fastsurfer"
    )
    assert (
        reconstruction_backend_from_receipt(
            {
                "stepKey": "recon",
                "receiptVersion": 1,
                "outputSchemaIdentity": "freesurfer:recon-tree:v1",
            }
        )
        is None
    )
    assert reconstruction_backend_from_receipt({"stepKey": "features"}) is None


def test_mount_builder_quotes_comma_without_shell_interpolation() -> None:
    cfg = _cfg()
    cfg["_supraspinaRuntime"]["reconInputBySubject"]["sub-001"] = (
        "/prepared/with,comma/sub-001_T1w.nii.gz"
    )

    argv = build_fastsurfer_command(cfg, "sub-001")
    mounts = [argv[index + 1] for index, value in enumerate(argv) if value == "--mount"]

    assert any(
        '"src=/prepared/with,comma/sub-001_T1w.nii.gz"' in item for item in mounts
    )
    assert all(os.linesep not in item for item in mounts)
