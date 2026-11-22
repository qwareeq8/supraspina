"""An upgrade that revises bundled resources keeps the acquired generation.

A packaged build resolves reviewed resources from the machine-local
acquisition generation and the first-party brain-FOV helper from its own
frozen subset. An upgrade that revises the Step 8 and Step 9 scripts and
adds the BrainCharts script leaves the generation's recorded inventory
digest stale. Rejecting the whole generation for that would block ENIGMA QC
and feature extraction and make the frozen subset the resource root, which
changes every brain-FOV action digest and re-signs every brain-FOV and
reconstruction receipt. These tests build a real generation under an earlier
inventory, upgrade the frozen subset, and check both outcomes.
"""

from __future__ import annotations

import copy
import hashlib
import json
import shutil
import sys
from pathlib import Path, PurePosixPath
from typing import Any

import pytest

from supraspina_sidecar import provenance, resources, scientific_assets
from supraspina_sidecar.adapters.base import ExecutionAction
from supraspina_sidecar.env.repo import BundledAssetsProbe
from tests.acquired_assets import acquired_bytes

_REPOSITORY = Path(__file__).resolve().parents[2]
_STEP8 = "resources/step8/aggregate_stats.py"
_BRAINCHARTS = "resources/braincharts/braincharts_run.py"
_EARLIER_STEP8 = b"# The Step 8 aggregation an earlier version shipped.\n"


def _inventory() -> dict[str, Any]:
    return scientific_assets.load_inventory(_REPOSITORY / "THIRD_PARTY_PROVENANCE.json")


def _earlier_inventory() -> dict[str, Any]:
    """Return the reviewed inventory of a version before Step 8 and BrainCharts."""
    earlier = copy.deepcopy(_inventory())
    earlier["resourceFiles"][_STEP8]["sha256"] = hashlib.sha256(
        _EARLIER_STEP8
    ).hexdigest()
    del earlier["resourceFiles"][_BRAINCHARTS]
    return earlier


def _stage_frozen(runtime: Path, inventory: dict[str, Any], step8: bytes) -> None:
    """Write a frozen runtime: the bundled subset, the helper, and the inventory."""
    if runtime.exists():
        shutil.rmtree(runtime)
    for relative, record in inventory["resourceFiles"].items():
        if record.get("delivery") != "bundled":
            continue
        target = runtime / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        source = _REPOSITORY / relative
        target.write_bytes(step8 if relative == _STEP8 else source.read_bytes())
    helper = runtime / "resources" / "brainfov" / "brainfov_helper.py"
    helper.parent.mkdir(parents=True, exist_ok=True)
    helper.write_bytes(
        (_REPOSITORY / "sidecar" / "supraspina_sidecar" / "brainfov.py").read_bytes()
    )
    metadata = runtime / "metadata"
    metadata.mkdir(parents=True)
    (metadata / "THIRD_PARTY_PROVENANCE.json").write_text(
        json.dumps(inventory), encoding="utf-8"
    )


def _acquire(cache: Path, runtime: Path, inventory: dict[str, Any]) -> Path:
    """Activate a generation the way the earlier version's acquisition did."""

    def acquired(relative: PurePosixPath, record: Any) -> bytes:
        del record
        return acquired_bytes(str(relative))

    return scientific_assets._build_generation(
        acquired,
        bundled_root=runtime / "resources",
        inventory=inventory,
        cache_base=cache,
    )


def install_earlier_version(runtime: Path, cache: Path) -> Path:
    """Stage an earlier version's frozen runtime and acquire its generation.

    Return the generation's resource root. The earlier version shipped other
    Step 8 bytes and no BrainCharts script; every other file is this
    checkout's.
    """
    _stage_frozen(runtime, _earlier_inventory(), _EARLIER_STEP8)
    return _acquire(cache, runtime, _earlier_inventory())


def upgrade_runtime(runtime: Path) -> None:
    """Replace the frozen runtime with this checkout's, as an install does."""
    step8 = (_REPOSITORY / _STEP8).read_bytes()
    _stage_frozen(runtime, _inventory(), step8)


@pytest.fixture
def upgrade(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """Install an earlier version with its acquired generation, then upgrade."""
    runtime = tmp_path / "opt" / "supraspina-runtime"
    cache = tmp_path / "scientific-assets"
    generation = install_earlier_version(runtime, cache)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(runtime), raising=False)
    monkeypatch.setenv("SUPRASPINA_SCIENTIFIC_ASSET_ROOT", str(cache))
    monkeypatch.delenv("SUPRASPINA_PROVENANCE_FILE", raising=False)
    return {"runtime": runtime, "cache": cache, "generation": generation}


def _digest(*paths: Path) -> str:
    action = ExecutionAction(
        kind="process", argv=("python3", *(str(path) for path in paths))
    )
    return provenance.execution_action_digest(action)


def test_upgrade_keeps_the_acquired_generation_for_unchanged_directories(
    upgrade: dict[str, Path],
) -> None:
    generation, runtime = upgrade["generation"], upgrade["runtime"]
    frozen = runtime / "resources"
    before = {
        "enigma": resources.enigma_dir(),
        "features": resources.features_dir(),
        "pybrainage": resources.pybrainage_dir(),
    }
    assert set(before.values()) == {
        generation / name for name in ("enigma", "features", "pybrainage")
    }

    upgrade_runtime(runtime)

    assert scientific_assets.validate_generation(generation.parent) is None
    assert not resources.scientific_asset_acquisition_required()
    assert resources.resource_root() == generation
    assert {
        "enigma": resources.enigma_dir(),
        "features": resources.features_dir(),
        "pybrainage": resources.pybrainage_dir(),
    } == before
    # The revised and the added bundled directory resolve from the app.
    assert resources.step8_dir() == frozen / "step8"
    assert resources.resource_dir("braincharts", "x.py") == (
        frozen / "braincharts" / "x.py"
    )
    checks = {
        check.id: check
        for check in BundledAssetsProbe().checks({"paths": {"projectRoot": "/"}})
    }
    assert {
        check_id: check.detail
        for check_id, check in checks.items()
        if check.status != "found"
    } == {}
    assert str(generation / "enigma") in checks["enigma_assets"].detail


def test_upgrade_changes_no_action_digest_of_an_unchanged_command(
    upgrade: dict[str, Path],
) -> None:
    generation, runtime = upgrade["generation"], upgrade["runtime"]
    helper = runtime / "resources" / "brainfov" / "brainfov_helper.py"
    template = resources.features_dir() / "rois_input_template.txt"
    brainfov = _digest(helper)
    features = _digest(template)
    step8 = _digest(resources.step8_dir() / "aggregate_stats.py")
    # The helper is not a reviewed resource; its path stays verbatim.
    assert brainfov == _digest_verbatim(helper)

    upgrade_runtime(runtime)

    assert _digest(helper) == brainfov
    assert _digest(resources.features_dir() / "rois_input_template.txt") == features
    # The revised Step 8 script binds new bytes under the same token.
    assert _digest(resources.step8_dir() / "aggregate_stats.py") != step8

    # Nor does the digest depend on whether the generation is usable.
    (generation / "enigma" / "CHECKSUMS.sha256").chmod(0o600)
    (generation / "enigma" / "CHECKSUMS.sha256").write_bytes(b"tampered\n")
    assert resources.scientific_asset_acquisition_required()
    assert resources.resource_root() == runtime / "resources"
    assert _digest(helper) == brainfov
    (upgrade["cache"] / "CURRENT").unlink()
    assert _digest(helper) == brainfov


def test_a_rebuilt_generation_keeps_every_digest_of_the_upgraded_build(
    upgrade: dict[str, Path],
) -> None:
    runtime = upgrade["runtime"]
    upgrade_runtime(runtime)
    helper = runtime / "resources" / "brainfov" / "brainfov_helper.py"
    paths = (
        helper,
        resources.enigma_dir() / "CHECKSUMS.sha256",
        resources.step8_dir() / "aggregate_stats.py",
        resources.resource_dir("braincharts", "braincharts_run.py"),
    )
    upgraded = [_digest(path) for path in paths]

    rebuilt = scientific_assets.acquire_scientific_assets(
        bundled_root=runtime / "resources", cache_base=upgrade["cache"]
    )
    # The usable earlier generation needs no rebuild.
    assert rebuilt == upgrade["generation"]
    fresh = _acquire(upgrade["cache"], runtime, _inventory())
    assert fresh != upgrade["generation"]
    assert resources.resource_root() == fresh
    assert resources.step8_dir() == fresh / "step8"
    moved = (
        helper,
        resources.enigma_dir() / "CHECKSUMS.sha256",
        resources.step8_dir() / "aggregate_stats.py",
        resources.resource_dir("braincharts", "braincharts_run.py"),
    )
    assert [_digest(path) for path in moved] == upgraded


def _digest_verbatim(path: Path) -> str:
    return provenance.stable_digest(
        {
            "kind": "process",
            "argv": ["python3", str(path)],
            "source": None,
            "destination": None,
            "force": False,
        }
    )


def test_a_bundled_directory_neither_copy_verifies_rejects_the_generation(
    upgrade: dict[str, Path],
) -> None:
    generation, runtime = upgrade["generation"], upgrade["runtime"]
    upgrade_runtime(runtime)
    assert resources.resource_root() == generation
    # The app's own copy no longer holds the reviewed Step 8 bytes either.
    frozen_step8 = runtime / _STEP8
    frozen_step8.write_bytes(b"# tampered\n")

    assert resources.scientific_asset_acquisition_required()
    assert resources.resource_root() == runtime / "resources"
