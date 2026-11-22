"""Guards of scripts/plan-replica.py capture on a synthetic receipt project.

``runtime.bootstrap`` settles every run its sidecar does not own, so a
capture must run only on a copy whose runs are all settled. A packaged-build
reading of an upgrade must keep the acquired generation and write no receipt.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.run_store import RunStore
from tests.test_asset_generation_upgrade import install_earlier_version, upgrade_runtime

REPO = Path(__file__).resolve().parents[2]
GENERATOR = Path(__file__).with_name("synthetic_receipt_project.py")
TOOL = REPO / "scripts" / "plan-replica.py"


def _run(
    argv: list[str], env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        argv, capture_output=True, text=True, timeout=600, check=False, env=env
    )


def _make_project(base: Path) -> Path:
    root = base / "project"
    made = _run(
        [
            sys.executable,
            str(GENERATOR),
            "--root",
            str(root),
            "--rawdata",
            str(base / "raw"),
        ],
        env={**os.environ, "PYTHONPATH": str(REPO / "sidecar")},
    )
    assert made.returncode == 0, made.stdout + made.stderr
    return root


def _state_snapshot(root: Path) -> dict[str, tuple[int, int, str]]:
    snapshot: dict[str, tuple[int, int, str]] = {}
    for path in sorted((root / ".supraspina").rglob("*")):
        if path.is_file():
            info = path.stat()
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            snapshot[str(path)] = (info.st_size, info.st_mtime_ns, digest)
    return snapshot


def _capture(root: Path, out: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return _run(
        [
            sys.executable,
            str(TOOL),
            "capture",
            "--project-file",
            str(root / "supraspina.project.json"),
            "--sidecar-src",
            str(REPO),
            "--python",
            sys.executable,
            "--preload",
            str(GENERATOR),
            "--out",
            str(out),
            *extra,
        ]
    )


@pytest.fixture(scope="module")
def project(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return _make_project(tmp_path_factory.mktemp("replica"))


def test_capture_refuses_a_writable_project_without_copy_ok(
    project: Path, tmp_path: Path
) -> None:
    before = _state_snapshot(project)
    out = tmp_path / "reading.json"
    result = _capture(project, out)
    assert result.returncode != 0
    assert "--copy-ok" in result.stderr
    assert not out.exists()
    assert _state_snapshot(project) == before


def test_capture_reads_a_settled_copy_without_writing(
    project: Path, tmp_path: Path
) -> None:
    before = _state_snapshot(project)
    out = tmp_path / "reading.json"
    result = _capture(project, out, "--copy-ok")
    assert result.returncode == 0, result.stdout + result.stderr
    reading = json.loads(out.read_text(encoding="utf-8"))
    assert reading["writes"] == []
    plan = reading["calls"]["pipeline.planWorkflow"]["result"]
    assert plan["disposition"] == "noop"
    assert _state_snapshot(project) == before


def test_capture_refuses_a_copy_with_an_unsettled_run(tmp_path: Path) -> None:
    root = _make_project(tmp_path)
    store = RunStore(str(root))
    (run_id,) = store.run_ids()
    state = store.load(run_id)
    state["status"] = "running"
    store.commit(state)
    before = _state_snapshot(root)
    out = tmp_path / "reading.json"
    result = _capture(root, out, "--copy-ok")
    assert result.returncode != 0
    assert f"{run_id} is running" in result.stderr
    assert not out.exists()
    assert _state_snapshot(root) == before


def _load_tool() -> Any:
    spec = importlib.util.spec_from_file_location("plan_replica", TOOL)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def upgraded(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    """Return a packaged-build project written before an upgrade, then upgrade it.

    An earlier version (other Step 8 bytes, no BrainCharts script) runs Brain
    FOV preparation and every stage against its acquired generation; then the
    frozen runtime is replaced with this checkout's, as an install does, and
    the generation is left as acquired.
    """
    base = tmp_path_factory.mktemp("upgrade")
    runtime = base / "opt" / "supraspina-runtime"
    cache = base / "scientific-assets"
    install_earlier_version(runtime, cache)
    root = base / "project"
    made = _run(
        [
            sys.executable,
            str(GENERATOR),
            "--root",
            str(root),
            "--rawdata",
            str(base / "raw"),
            "--brainfov",
        ],
        env={
            **os.environ,
            "PYTHONPATH": str(REPO / "sidecar"),
            "SUPRASPINA_REPLICA_FROZEN_RUNTIME": str(runtime),
            "SUPRASPINA_SCIENTIFIC_ASSET_ROOT": str(cache),
        },
    )
    assert made.returncode == 0, made.stdout + made.stderr
    upgrade_runtime(runtime)
    return {"root": root, "runtime": runtime, "cache": cache}


def test_upgrade_keeps_the_generation_and_writes_no_receipt(
    upgraded: dict[str, Path], tmp_path: Path
) -> None:
    # A plan-only reading must not reject the acquired generation, block
    # ENIGMA QC and feature extraction, or re-sign any brain-FOV or
    # reconstruction receipt.
    root, cache = upgraded["root"], upgraded["cache"]
    assets_before = _tree_snapshot(cache)
    out = tmp_path / "reading.json"
    result = _capture(
        root,
        out,
        "--copy-ok",
        "--frozen-runtime",
        str(upgraded["runtime"]),
        "--asset-cache",
        str(cache),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    reading = json.loads(out.read_text(encoding="utf-8"))

    assert reading["receiptWrites"] == []
    assert reading["writes"] == []
    assert _tree_snapshot(cache) == assets_before
    assert set(reading["assetChecks"].values()) == {"found"}
    nodes = reading["calls"]["pipeline.planWorkflow"]["result"]["plan"]["nodes"]
    replanned = {node["stepKey"] for node in nodes if node["status"] != "skipped"}
    assert replanned == {"aggregate", "final"}
    assert {node["stepKey"] for node in nodes} >= {"brainfov", "recon"}


def _tree_snapshot(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _reading(receipts: dict[str, str], checks: dict[str, str]) -> dict[str, Any]:
    return {
        "receiptFiles": {"before": receipts, "after": receipts},
        "receiptWrites": [],
        "assetChecks": checks,
        "assets": {"current": "a" * 32},
    }


def test_compare_fails_on_receipt_writes_and_rejected_asset_checks() -> None:
    tool = _load_tool()
    found = {"scientific_assets": "found", "enigma_assets": "found"}
    a = _reading({"brainfov/sub-01/1.json": "x"}, found)
    b = _reading({"brainfov/sub-01/1.json": "x"}, found)
    out: list[str] = []
    assert tool._compare_state(a, b, out) == []

    b["receiptFiles"]["after"] = {**b["receiptFiles"]["before"], "x/y.json": "z"}
    b["receiptWrites"] = ["added x/y.json"]
    b["assetChecks"] = {**found, "enigma_assets": "missing"}
    problems = tool._compare_state(a, b, out)

    assert "B wrote 1 receipt files" in problems
    assert "asset check enigma_assets: found -> missing" in problems
    a["receiptFiles"]["after"] = {}
    assert "the receipt files changed between the two readings" in (
        tool._compare_state(a, b, [])
    )
