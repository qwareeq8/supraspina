"""Tests for the resource locator (resources.py).

A source checkout holds only first-party resources and resolves the upstream
ENIGMA QC assets from the acquired, checksum-verified generation, so these
tests fail when an acquired binary or source file is missing from it instead
of at run time.
"""

from __future__ import annotations

import hashlib
import shutil
import sys
from pathlib import Path

import pytest

from supraspina_sidecar import resources, scientific_assets
from tests.acquired_assets import acquired_resource_root

_REPOSITORY_RESOURCES = Path(__file__).resolve().parents[2] / "resources"


def test_resource_root_is_a_dir_named_resources() -> None:
    root = resources.resource_root()
    assert root.name == "resources"
    assert root.is_dir()


def test_source_checkout_resolves_acquired_and_own_files() -> None:
    generation = acquired_resource_root()

    assert resources.application_resource_root() == _REPOSITORY_RESOURCES
    assert resources.resource_root() == generation
    assert not resources.scientific_asset_acquisition_required()
    # Directories with an acquired file resolve as one tree from the generation.
    assert resources.enigma_dir() == generation / "enigma"
    assert resources.features_dir() == generation / "features"
    # Every other directory runs the checkout's own, possibly edited, files.
    assert resources.step8_dir() == _REPOSITORY_RESOURCES / "step8"
    assert resources.pybrainage_dir() == _REPOSITORY_RESOURCES / "pybrainage"
    assert (_REPOSITORY_RESOURCES / "enigma" / "outliers_qc.R").is_file()
    assert not (_REPOSITORY_RESOURCES / "enigma" / "ENIGMA_QC").exists()
    assert not (_REPOSITORY_RESOURCES / "features" / "rois_input_template.txt").exists()


def test_source_checkout_without_a_generation_requires_acquisition(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SUPRASPINA_SCIENTIFIC_ASSET_ROOT", str(tmp_path / "empty"))

    assert resources.resource_root() == _REPOSITORY_RESOURCES
    assert resources.scientific_asset_acquisition_required()
    assert not (resources.enigma_dir() / "compiled" / "FS_external_QC").exists()


def test_an_edited_first_party_file_never_runs_from_a_stale_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    acquired_resource_root()
    checkout = tmp_path / "resources"
    shutil.copytree(_REPOSITORY_RESOURCES, checkout)
    (checkout / "enigma" / "outliers_qc.R").write_text("# edited\n", encoding="utf-8")
    monkeypatch.setattr(
        scientific_assets, "application_resource_root", lambda: checkout
    )

    def _no_download(destination: Path) -> None:
        raise AssertionError(f"Refuse the acquisition before {destination}.")

    monkeypatch.setattr(scientific_assets, "_download", _no_download)

    assert not scientific_assets.application_copy_current()
    assert resources.resource_root() == checkout
    assert resources.enigma_dir() / "outliers_qc.R" == (
        checkout / "enigma" / "outliers_qc.R"
    )
    assert resources.scientific_asset_acquisition_required()
    with pytest.raises(
        scientific_assets.ScientificAssetError,
        match=r"regenerate THIRD_PARTY_PROVENANCE\.json",
    ):
        scientific_assets.acquire_scientific_assets()


def test_resource_dir_joins_under_the_root() -> None:
    assert (
        resources.resource_dir("enigma", "compiled")
        == resources.resource_root() / "enigma" / "compiled"
    )


def test_frozen_brainfov_helper_uses_packaged_root_when_acquisition_active(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frozen_root = tmp_path / "supraspina-runtime"
    packaged_helper = frozen_root / "resources" / "brainfov" / "brainfov_helper.py"
    packaged_helper.parent.mkdir(parents=True)
    packaged_helper.write_text("# reviewed first-party helper\n", encoding="utf-8")
    acquired_root = tmp_path / "scientific-assets" / "resources"
    acquired_root.mkdir(parents=True)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(frozen_root), raising=False)
    monkeypatch.setattr(
        scientific_assets,
        "active_resource_root",
        lambda: acquired_root,
    )
    monkeypatch.setattr(scientific_assets, "application_copy_current", lambda: True)

    helper = resources.brainfov_helper_path()

    assert resources.resource_root() == acquired_root
    assert helper == packaged_helper
    assert helper.is_file()
    assert not helper.is_symlink()


def test_enigma_dir_holds_the_compiled_backend() -> None:
    enigma = resources.enigma_dir()
    wrapper = enigma / "compiled" / "enigma_fs_wrapper_script_compiled.sh"
    assert wrapper.is_file()
    # Require each compiled launcher and MATLAB Runtime binary in the active set.
    assert (enigma / "compiled" / "run_FS_external_QC.sh").is_file()
    assert (enigma / "compiled" / "FS_external_QC").is_file()


def test_enigma_dir_holds_the_source_backend_and_wrapper() -> None:
    enigma = resources.enigma_dir()
    assert (enigma / "enigma_fs_wrapper_script.sh").is_file()
    assert (enigma / "ENIGMA_QC").is_dir()
    # Include the FreeSurfer external-QC entry point in ENIGMA_QC sources.
    assert (enigma / "ENIGMA_QC" / "FS_external_QC.m").is_file()
    # Resolve the first-party base-R outlier script alongside the QC assets.
    assert (enigma / "outliers_qc.R").is_file()


def test_features_dir_holds_the_extraction_module() -> None:
    features = resources.features_dir()
    assert (features / "extract_features.py").is_file()
    assert (features / "rois_input_template.txt").is_file()


def test_pybrainage_dir_holds_the_predict_script() -> None:
    assert (resources.pybrainage_dir() / "predict.py").is_file()


def test_step9_dir_holds_the_analysis_assets() -> None:
    step9 = resources.step9_dir()
    assert (step9 / "FreesurferAnalysisScript.R").is_file()
    assert (step9 / "FreesurferAnalysisScript.Rmd").is_file()


def test_verify_manifest_hashes_bounded_regular_files(tmp_path: Path) -> None:
    payload = b"reviewed"
    (tmp_path / "asset.bin").write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    (tmp_path / "CHECKSUMS.sha256").write_text(
        f"{digest}  asset.bin\n",
        encoding="utf-8",
    )

    assert resources.verify_manifest(tmp_path) == ([], [])


def test_verify_manifest_rejects_limit_plus_one_resource(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = b"oversized"
    (tmp_path / "asset.bin").write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    (tmp_path / "CHECKSUMS.sha256").write_text(
        f"{digest}  asset.bin\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(resources, "_MAX_RESOURCE_BYTES", len(payload) - 1)

    assert resources.verify_manifest(tmp_path) == (["asset.bin"], [])
