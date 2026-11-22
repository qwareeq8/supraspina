"""Locate the acquired upstream resources that tests read.

Supraspina never commits the SCI_Map files that lack a license. A source
checkout acquires them once through the pinned, checksum-verified flow, and
tests that need the real upstream bytes read them from that generation.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from supraspina_sidecar import scientific_assets

ACQUIRE_COMMAND = (
    "uv run --project sidecar --all-extras --locked "
    "python -m supraspina_sidecar.scientific_assets --acquire"
)

# Resolve once at collection, before any test redirects the asset cache.
_ACTIVE_ROOT = scientific_assets.active_resource_root()


def acquired_resource_root() -> Path:
    """Return the verified generation's resource root, or fail with the fix."""
    if _ACTIVE_ROOT is None:
        pytest.fail(
            f"Acquire the pinned scientific assets before this test: {ACQUIRE_COMMAND}."
        )
    return _ACTIVE_ROOT


def acquired_bytes(relative: str) -> bytes:
    """Return the verified bytes of one ``resources/...`` file."""
    return (acquired_resource_root().parent / relative).read_bytes()
