"""Tests for independently readable sidecar package metadata."""

from __future__ import annotations

from pathlib import Path

import tomllib

SIDECAR_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SIDECAR_ROOT.parent


def test_sidecar_package_carries_the_reviewed_first_party_license() -> None:
    metadata = tomllib.loads((SIDECAR_ROOT / "pyproject.toml").read_text("utf-8"))

    assert metadata["project"]["license"] == "MIT"
    assert metadata["project"]["license-files"] == ["LICENSE"]
    assert (SIDECAR_ROOT / "LICENSE").read_bytes() == (
        REPOSITORY_ROOT / "LICENSE"
    ).read_bytes()
