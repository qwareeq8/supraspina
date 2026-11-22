"""Tests for workspace and active-pipeline-asset environment checks.

First-party packaged files and checksum-verified acquired files are verified
through the same active resource root, and ``paths.projectRoot`` separately.
The happy path uses the real active resources; a corrupted temporary ENIGMA
copy exercises manifest mismatch without touching reviewed files.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import resources, scientific_assets
from supraspina_sidecar.env.repo import BundledAssetsProbe


def _by_id(checks: list[Any]) -> dict[str, Any]:
    """Index a list of Check objects by their id."""
    return {check.id: check for check in checks}


def _cfg(workspace_root: str) -> dict[str, Any]:
    """Return a minimal config with the study workspace root set."""
    return {"paths": {"projectRoot": workspace_root}}


def test_probe_identity() -> None:
    assert BundledAssetsProbe().name == "Pipeline assets"


def test_check_ids_and_order(tmp_path: Path) -> None:
    checks = BundledAssetsProbe().checks(_cfg(str(tmp_path)))
    assert [c.id for c in checks] == [
        "workspace",
        "scientific_assets",
        "enigma_assets",
        "features_assets",
        "pybrainage_assets",
        "brainpad_assets",
        "aggregate_assets",
        "final_assets",
        "final_report_assets",
        "outliers_assets",
        "pipeline_assets",
    ]


def test_all_found_with_real_bundle(tmp_path: Path) -> None:
    checks = _by_id(BundledAssetsProbe().checks(_cfg(str(tmp_path))))
    assert checks["workspace"].status == "found"
    assert checks["workspace"].detail == str(tmp_path)
    assert checks["scientific_assets"].status == "found"
    assert checks["enigma_assets"].status == "found"
    assert "integrity-verified" in checks["enigma_assets"].detail
    for check_id in (
        "features_assets",
        "pybrainage_assets",
        "brainpad_assets",
        "aggregate_assets",
        "final_assets",
        "final_report_assets",
        "outliers_assets",
    ):
        assert checks[check_id].status == "found"
    assert checks["pipeline_assets"].status == "found"


def test_workspace_missing_when_root_absent(tmp_path: Path) -> None:
    missing_root = tmp_path / "does_not_exist"
    checks = _by_id(BundledAssetsProbe().checks(_cfg(str(missing_root))))
    assert checks["workspace"].status == "missing"
    assert checks["workspace"].detail.startswith("Set projectRoot to a directory")


def test_workspace_defers_when_no_project_supplies_a_root() -> None:
    checks = _by_id(BundledAssetsProbe().checks({}))
    assert checks["workspace"].status == "skipped"
    assert checks["workspace"].detail == (
        "Supraspina checks the study workspace after a project sets paths.projectRoot."
    )


def test_enigma_assets_warn_on_manifest_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Copy the real ENIGMA tree, corrupt one manifest-pinned file, and point the
    # probe at the copy. Leave the shipped resources unchanged.
    enigma_copy = tmp_path / "enigma"
    shutil.copytree(resources.enigma_dir(), enigma_copy)
    target = enigma_copy / "outliers_qc.R"
    target.write_bytes(target.read_bytes() + b"# tamper\n")
    monkeypatch.setattr(resources, "enigma_dir", lambda: enigma_copy)

    checks = _by_id(BundledAssetsProbe().checks(_cfg(str(tmp_path))))

    assert checks["enigma_assets"].status == "wrong"
    assert "mismatched" in checks["enigma_assets"].detail
    assert "outliers_qc.R" in checks["enigma_assets"].detail


def test_enigma_assets_warn_on_missing_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    enigma_copy = tmp_path / "enigma"
    shutil.copytree(resources.enigma_dir(), enigma_copy)
    (enigma_copy / "outliers_qc.R").unlink()
    monkeypatch.setattr(resources, "enigma_dir", lambda: enigma_copy)

    checks = _by_id(BundledAssetsProbe().checks(_cfg(str(tmp_path))))

    assert checks["enigma_assets"].status == "wrong"
    assert "missing" in checks["enigma_assets"].detail
    assert "outliers_qc.R" in checks["enigma_assets"].detail


def test_frozen_missing_acquisition_is_actionable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        resources, "scientific_asset_acquisition_required", lambda: True
    )
    monkeypatch.setattr(scientific_assets, "offline_rebuild_available", lambda: False)
    monkeypatch.setattr(
        resources,
        "scientific_asset_acquisition_command",
        lambda: ["/opt/Supraspina/supraspina-sidecar", "--acquire-scientific-assets"],
    )

    checks = _by_id(BundledAssetsProbe().checks(_cfg(str(tmp_path))))

    scientific = checks["scientific_assets"]
    assert scientific.status == "missing"
    assert scientific.installer is not None
    assert scientific.installer.kind == "command"
    assert scientific.installer.offline is False
    assert "8a8c2d3586a37bb896bd8bdc3743b43e602827e3" in scientific.download_url
    assert "offlineInstall" not in scientific.to_dict()


def test_revised_inventory_offers_an_offline_rebuild_on_every_asset_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A build that re-pins a resource invalidates the acquired generation,
    # but every file is still on disk: the checks offer the rebuild, promise
    # no download, and name that one fix wherever an asset is missing.
    command = ["/opt/Supraspina/supraspina-sidecar", "--acquire-scientific-assets"]
    monkeypatch.setattr(
        resources, "scientific_asset_acquisition_required", lambda: True
    )
    monkeypatch.setattr(scientific_assets, "offline_rebuild_available", lambda: True)
    monkeypatch.setattr(
        resources, "scientific_asset_acquisition_command", lambda: command
    )
    monkeypatch.setattr(
        resources,
        "verify_manifest",
        lambda _directory: (["compiled/run.sh"], []),
    )
    empty = tmp_path / "empty-resources"
    empty.mkdir()
    monkeypatch.setattr(resources, "resource_dir", empty.joinpath)

    checks = _by_id(BundledAssetsProbe().checks(_cfg(str(tmp_path))))

    scientific = checks["scientific_assets"]
    assert scientific.status == "missing"
    assert scientific.detail.startswith("Rebuild the scientific assets")
    assert "nothing is downloaded" in scientific.detail
    assert scientific.download_url == ""
    payload = scientific.to_dict()
    assert payload["offlineInstall"] is True
    assert payload["installable"] is True
    assert payload["recommendedCmd"] == " ".join(command)
    assert "downloadUrl" not in payload

    enigma = checks["enigma_assets"]
    assert enigma.status == "missing"
    assert enigma.detail.startswith(
        "Rebuild the scientific assets to restore the ENIGMA QC assets; 1 missing"
    )
    assert enigma.download_url == ""
    assert enigma.to_dict()["offlineInstall"] is True

    features = checks["features_assets"]
    assert features.detail == (
        "Rebuild the scientific assets to restore 2 missing asset(s): "
        "features/extract_features.py, features/rois_input_template.txt."
    )
    assert checks["pipeline_assets"].detail.startswith(
        "Rebuild the scientific assets to restore"
    )


def test_frozen_missing_enigma_assets_exposes_verified_acquisition_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    command = ["/opt/Supraspina/supraspina-sidecar", "--acquire-scientific-assets"]
    monkeypatch.setattr(
        resources, "scientific_asset_acquisition_required", lambda: True
    )
    monkeypatch.setattr(scientific_assets, "offline_rebuild_available", lambda: False)
    monkeypatch.setattr(
        resources,
        "scientific_asset_acquisition_command",
        lambda: command,
    )
    monkeypatch.setattr(
        resources,
        "verify_manifest",
        lambda _directory: (["CHECKSUMS.sha256"], []),
    )

    checks = _by_id(BundledAssetsProbe().checks(_cfg(str(tmp_path))))

    enigma = checks["enigma_assets"]
    assert enigma.status == "missing"
    assert enigma.recommended_cmd == " ".join(command)
    assert enigma.installer is not None
    assert enigma.installer.kind == "command"
    payload = enigma.to_dict()
    assert payload["recommendedCmd"] == " ".join(command)
    assert payload["installable"] is True
    assert enigma.detail.startswith(
        "Acquire the scientific assets to restore the ENIGMA QC assets"
    )
    assert "8a8c2d3586a37bb896bd8bdc3743b43e602827e3" in payload["downloadUrl"]
    assert "offlineInstall" not in payload


def test_serializes_to_envcheck_shape(tmp_path: Path) -> None:
    checks = _by_id(BundledAssetsProbe().checks(_cfg(str(tmp_path))))
    payload = checks["enigma_assets"].to_dict()
    assert payload["id"] == "enigma_assets"
    assert payload["status"] == "found"
    assert "detail" in payload
    # Keep the installer out of serialization across the IPC boundary.
    assert "installer" not in payload
