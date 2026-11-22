"""The build identity a frozen sidecar embeds, and its reach."""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

import supraspina_sidecar
from supraspina_sidecar import build_identity as identity
from supraspina_sidecar import resources
from supraspina_sidecar import workflow_manager as runtime
from supraspina_sidecar.cohort import CohortSnapshot, T1Resolution
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.provenance import make_receipt
from supraspina_sidecar.run_store import RunStore
from supraspina_sidecar.workflow_manager import WorkflowManager, _RunContext
from tests.acquired_assets import acquired_resource_root

_COMMIT = "0123456789abcdef0123456789abcdef01234567"
_UNKNOWN = {"kind": "unknown", "commit": "", "dirty": False}
_SUBJECT = "sub-01"
_COHORT_STEPS = (
    "enigma",
    "outliers",
    "features",
    "age",
    "pybrainage",
    "clinical",
    "brainpad",
    "aggregate",
    "final",
)
_DONE: dict[str, Any] = {"state": "done", "artifacts": []}


@pytest.fixture(autouse=True)
def _fresh_identity_cache() -> Iterator[None]:
    identity._load_build_identity.cache_clear()
    yield
    identity._load_build_identity.cache_clear()


def _record(**overrides: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "schemaVersion": 1,
        "version": supraspina_sidecar.__version__,
        "kind": "development",
        "commit": _COMMIT,
        "dirty": False,
    }
    record.update(overrides)
    return record


def test_parse_accepts_development_builds_and_a_clean_release() -> None:
    assert identity.parse_build_identity(_record()) == {
        "kind": "development",
        "commit": _COMMIT,
        "dirty": False,
    }
    assert identity.parse_build_identity(_record(dirty=True))["dirty"] is True
    assert identity.parse_build_identity(_record(kind="release")) == {
        "kind": "release",
        "commit": _COMMIT,
        "dirty": False,
    }
    sha256_commit = "c" * 64
    assert identity.parse_build_identity(_record(commit=sha256_commit))["commit"] == (
        sha256_commit
    )


@pytest.mark.parametrize(
    "record",
    [
        None,
        [],
        _record(kind="release", dirty=True),
        _record(kind="unknown"),
        _record(kind="nightly"),
        _record(commit=_COMMIT[:7]),
        _record(commit=_COMMIT.upper()),
        _record(commit=""),
        _record(dirty="false"),
        _record(version="20260920.1200.0"),
        _record(schemaVersion=2),
        {key: value for key, value in _record().items() if key != "dirty"},
    ],
)
def test_parse_refuses_a_malformed_or_contradictory_record(record: Any) -> None:
    assert identity.parse_build_identity(record) == _UNKNOWN


def test_a_source_checkout_reports_an_unknown_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert identity.build_identity() == _UNKNOWN


def _freeze(monkeypatch: pytest.MonkeyPatch, bundle: Path) -> Path:
    metadata = bundle / "metadata"
    metadata.mkdir(parents=True)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(bundle), raising=False)
    return metadata / identity.BUILD_IDENTITY_FILE


def test_a_frozen_build_reads_its_embedded_record(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = _freeze(monkeypatch, tmp_path)
    path.write_text(json.dumps(_record(kind="release")), encoding="utf-8")

    assert identity.build_identity() == {
        "kind": "release",
        "commit": _COMMIT,
        "dirty": False,
    }
    # Hand out copies so a caller never edits the cached identity.
    identity.build_identity()["kind"] = "development"
    assert identity.build_identity()["kind"] == "release"


@pytest.mark.parametrize(
    "payload",
    [
        None,
        b"{",
        b" " * 5000,
        json.dumps(_record(version="0.0.1")).encode(),
    ],
)
def test_a_frozen_build_without_a_valid_record_reports_unknown(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, payload: bytes | None
) -> None:
    path = _freeze(monkeypatch, tmp_path)
    if payload is not None:
        path.write_bytes(payload)
    assert identity.build_identity() == _UNKNOWN


def test_a_frozen_build_refuses_a_symlinked_record(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = _freeze(monkeypatch, tmp_path / "bundle")
    target = tmp_path / "elsewhere.json"
    target.write_text(json.dumps(_record()), encoding="utf-8")
    path.symlink_to(target)
    assert identity.build_identity() == _UNKNOWN


class _Emitter:
    def emit(self, method: str, params: dict[str, Any]) -> None:
        del method, params


def _context(root: Path) -> _RunContext:
    digest = hashlib.sha256(_SUBJECT.encode()).hexdigest()
    cohort = CohortSnapshot(
        analysis_subject_ids=(_SUBJECT,),
        selected_subject_ids=(_SUBJECT,),
        analysis_digest=digest,
        selected_digest=digest,
        t1=(
            T1Resolution(
                subject_id=_SUBJECT,
                state="resolved",
                path=str(root / "rawdata" / f"{_SUBJECT}_T1w.nii.gz"),
                candidates=(),
                fingerprint=f"t1-fingerprint-{_SUBJECT}",
            ),
        ),
        qc_verdicts=((_SUBJECT, "pass"),),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )
    project = ProjectIdentity(
        "build-identity",
        str(root),
        str(root / "supraspina.project.json"),
        1,
    )
    steps = {key: {"enabled": True, "params": {}} for key in ("recon", *_COHORT_STEPS)}
    steps["recon"]["params"] = {"backend": "freesurfer"}
    cfg = {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(root / "rawdata"),
            "derivativesDir": str(root / "derivatives"),
            "outputDir": str(root / "output"),
        },
        "runtime": {"resumeCompleted": True, "rerunIncomplete": False},
        "steps": steps,
        "_supraspinaRuntime": {},
    }
    state = {
        "runId": "run-12345678",
        "project": project.to_dict(),
        "config": cfg,
        "scope": cohort.to_dict(),
        "intent": {"kind": "workflow"},
        "nodes": [
            {
                "nodeId": f"{key}:cohort",
                "stepKey": key,
                "subjectId": None,
                "scope": "cohort",
                "status": "planned",
                "dependencies": [],
            }
            for key in _COHORT_STEPS
        ],
        "jobs": [],
        "receipts": [],
        "warnings": [],
        "environmentEvidence": {},
        "status": "queued",
        "dryRun": False,
    }
    return _RunContext(
        state=state,
        cfg=cfg,
        effective_cfg=cfg,
        cohort=cohort,
        project=project,
        store=RunStore(str(root)),
        queue_limit=1,
    )


def _run_as_build(
    patch: pytest.MonkeyPatch, version: str, kind: str, commit: str, dirty: bool
) -> None:
    """Make every loaded sidecar module report another version and build."""
    current = supraspina_sidecar.__version__
    for name, module in list(sys.modules.items()):
        if name.split(".")[0] == "supraspina_sidecar" and (
            getattr(module, "__version__", None) == current
        ):
            patch.setattr(module, "__version__", version)
    patch.setattr(identity, "_load_build_identity", lambda: (kind, commit, dirty))


def test_receipts_from_another_product_version_and_build_stay_current(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Upgrading the app never makes a stage with unchanged inputs rerun."""
    resource_root = tmp_path / "resources"
    shutil.copytree(acquired_resource_root(), resource_root)
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("SUPRASPINA_SCIENTIFIC_ASSET_ROOT", str(tmp_path / "assets"))
    monkeypatch.setattr(resources, "resource_root", lambda: resource_root)
    monkeypatch.setattr(runtime, "detector_evidence", lambda *_args: dict(_DONE))
    monkeypatch.setattr(runtime, "edge_evidence", lambda *_args: dict(_DONE))
    monkeypatch.setattr(runtime, "enrich_evidence", lambda _key, value, *_a: value)
    manager = WorkflowManager(_Emitter())
    try:
        ctx = _context(project)
        with monkeypatch.context() as earlier:
            _run_as_build(earlier, "20260920.1200.0", "development", "1" * 40, True)
            assert manager._manifest(ctx.state)["product"] == {
                "name": "Supraspina",
                "version": "20260920.1200.0",
                "build": "development",
            }
            recorded = {}
            for index, key in enumerate(_COHORT_STEPS):
                signature, payload = manager._expected(ctx, key, None)
                recorded[key] = signature
                ctx.store.put_receipt(
                    make_receipt(
                        signature,
                        payload,
                        _DONE,
                        run_id="run-aaaaaaaa",
                        job_id=f"#{index + 1}",
                        committed_at_ms=index + 1,
                        edge_evidence={consumer: _DONE for consumer in _COHORT_STEPS},
                    )
                )

        monkeypatch.setattr(
            identity, "_load_build_identity", lambda: ("release", "2" * 40, False)
        )
        manifest = manager._manifest(ctx.state)
        assert manifest["product"]["version"] == supraspina_sidecar.__version__
        assert manifest["product"]["version"] != "20260920.1200.0"
        assert manifest["git"]["sha"] == "2" * 40

        assert {
            key: manager._expected(ctx, key, None)[0] for key in _COHORT_STEPS
        } == recorded
        for node in ctx.state["nodes"]:
            assert manager._current_receipt(ctx, node) is not None, node["stepKey"]
        manager._apply_runtime_policy(ctx)
        assert {node["stepKey"]: node["status"] for node in ctx.state["nodes"]} == {
            key: "skipped" for key in _COHORT_STEPS
        }
    finally:
        manager.shutdown()
