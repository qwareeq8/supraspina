"""Self-test of scripts/receipt-invariance.py on a synthetic receipt project.

This checkout writes the receipts and then recomputes them, so every bound
field must reproduce and no stage may change. Copies of this checkout with
one bound field, one adapter or the record check edited must fail.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

REPO = Path(__file__).resolve().parents[2]
GENERATOR = Path(__file__).with_name("synthetic_receipt_project.py")
TOOL = REPO / "scripts" / "receipt-invariance.py"


def _run(
    argv: list[str], env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        argv, capture_output=True, text=True, timeout=600, check=False, env=env
    )


def _load_tool() -> Any:
    spec = importlib.util.spec_from_file_location("receipt_invariance", TOOL)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def project(tmp_path_factory: pytest.TempPathFactory) -> Path:
    base = tmp_path_factory.mktemp("invariance")
    root = base / "project"
    env = {**os.environ, "PYTHONPATH": str(REPO / "sidecar")}
    made = _run(
        [
            sys.executable,
            str(GENERATOR),
            "--root",
            str(root),
            "--rawdata",
            str(base / "raw"),
        ],
        env=env,
    )
    assert made.returncode == 0, made.stdout + made.stderr
    summary = json.loads(made.stdout)
    assert summary["receipts"] > 0
    assert summary["replanDisposition"] == "noop"
    return root


def _check(
    root: Path, candidate: Path, result_file: Path
) -> tuple[subprocess.CompletedProcess[str], dict[str, Any]]:
    checked = _run(
        [
            sys.executable,
            str(TOOL),
            str(root),
            "--candidate-src",
            str(candidate),
            "--baseline-src",
            str(REPO),
            "--python",
            sys.executable,
            "--json",
            str(result_file),
        ]
    )
    return checked, json.loads(result_file.read_text(encoding="utf-8"))


def _candidate_copy(target: Path) -> Path:
    """Copy the parts of this checkout a sidecar imported from source reads."""
    ignore = shutil.ignore_patterns("__pycache__")
    shutil.copytree(
        REPO / "sidecar" / "supraspina_sidecar",
        target / "sidecar" / "supraspina_sidecar",
        ignore=ignore,
    )
    shutil.copytree(REPO / "resources", target / "resources", ignore=ignore)
    shutil.copy2(REPO / "THIRD_PARTY_PROVENANCE.json", target)
    return target


def test_this_build_reproduces_its_own_receipts(project: Path, tmp_path: Path) -> None:
    checked, result = _check(project, REPO, tmp_path / "invariance.json")
    assert checked.returncode == 0, checked.stdout + checked.stderr
    assert "Changed stages: none." in checked.stdout
    assert "Unexpected: none." in checked.stdout
    # Every bound field reproduces, so the gate never rests on an n/r cell.
    assert result["stages"]
    for key, stage in result["stages"].items():
        assert stage["unreproducible"] == {}, key
        assert stage["changed"] == {}, key
        assert stage["errors"] == [], key
        assert {
            "signature",
            "recordContract",
            "reuseContract",
            "externalInputs",
            "analysisCohortDigest",
            "scopeBinding",
            "inputT1Fingerprint",
            "selectedSubsetDigest",
            "defacing",
            "scope",
        } <= set(stage["fields"]), key
    assert {"reconstruction", "reconstructionSignature"} <= set(
        result["stages"]["recon"]["fields"]
    )


def _edit(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    assert old in text
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


@pytest.mark.parametrize(
    ("edit", "stage", "column"),
    [
        pytest.param("adapter", "brainpad", "adapterImplementation", id="adapter"),
        pytest.param("defacing", "enigma", "defacing", id="bound-field"),
        pytest.param("record", "enigma", "recordContract", id="record-check"),
    ],
)
def test_a_changed_candidate_fails(
    project: Path, tmp_path: Path, edit: str, stage: str, column: str
) -> None:
    candidate = _candidate_copy(tmp_path / "candidate")
    package = candidate / "sidecar" / "supraspina_sidecar"
    if edit == "adapter":
        adapter = package / "adapters" / "brainpad.py"
        adapter.write_text(
            adapter.read_text(encoding="utf-8") + "\n# Probe edit.\n",
            encoding="utf-8",
        )
    elif edit == "defacing":
        _edit(
            package / "provenance.py",
            '"defacing": _deface_posture(cfg),',
            '"defacing": {"probe": _deface_posture(cfg)},',
        )
    else:
        store = package / "run_store.py"
        store.write_text(
            store.read_text(encoding="utf-8")
            + "\n\ndef receipt_record_contract_valid(receipt):\n    return False\n",
            encoding="utf-8",
        )
    checked, result = _check(project, candidate, tmp_path / "invariance.json")
    assert checked.returncode == 1, checked.stdout + checked.stderr
    assert "CHANGED" in checked.stdout
    assert stage in result["unexpected"]
    assert result["stages"][stage]["changed"].get(column), result["stages"][stage]


def test_an_unreproduced_field_fails_when_the_builds_disagree() -> None:
    tool = _load_tool()

    def row(computed: str) -> dict[str, Any]:
        return {
            "file": "receipts/enigma/cohort/a.json",
            "stepKey": "enigma",
            "packaged": False,
            "errors": [],
            "fields": {"externalInputs": {"equal": False, "computed": computed}},
        }

    dependencies = {"enigma": [], "outliers": ["enigma"]}
    baseline = {"receipts": [row("same")], "dependencies": dependencies}
    kept = tool.evaluate(
        {"receipts": [row("same")], "dependencies": dependencies}, baseline, set()
    )
    assert kept["unexpected"] == []
    assert kept["stages"]["enigma"]["unreproducible"] == {"externalInputs": 1}
    moved = tool.evaluate(
        {"receipts": [row("other")], "dependencies": dependencies}, baseline, set()
    )
    assert moved["unexpected"] == ["enigma"]
    assert moved["stages"]["enigma"]["changed"] == {"externalInputs": 1}
