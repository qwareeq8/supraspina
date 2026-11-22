"""Receipt currency across a rebuilt scientific resource generation."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import provenance, resources, scientific_assets
from supraspina_sidecar import workflow_manager as runtime
from supraspina_sidecar.cohort import CohortSnapshot, T1Resolution
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.provenance import make_receipt
from supraspina_sidecar.run_store import RunStore
from supraspina_sidecar.workflow_manager import WorkflowManager, _RunContext
from tests.acquired_assets import acquired_resource_root

_GENERATION_A = "a" * 32
_GENERATION_B = "b" * 32
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


class _Emitter:
    def emit(self, method: str, params: dict[str, Any]) -> None:
        del method, params


def _generation(cache: Path, name: str) -> Path:
    root = cache / "generations" / name / "resources"
    shutil.copytree(acquired_resource_root(), root)
    return root


def _config(root: Path) -> dict[str, Any]:
    steps = {key: {"enabled": True, "params": {}} for key in ("recon", *_COHORT_STEPS)}
    steps["recon"]["params"] = {"backend": "freesurfer"}
    return {
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


def _context(root: Path, subjects: tuple[str, ...] = (_SUBJECT,)) -> _RunContext:
    digest = hashlib.sha256(",".join(subjects).encode()).hexdigest()
    cohort = CohortSnapshot(
        analysis_subject_ids=subjects,
        selected_subject_ids=subjects,
        analysis_digest=digest,
        selected_digest=digest,
        t1=tuple(
            T1Resolution(
                subject_id=subject,
                state="resolved",
                path=str(root / "rawdata" / f"{subject}_T1w.nii.gz"),
                candidates=(),
                fingerprint=f"t1-fingerprint-{subject}",
            )
            for subject in subjects
        ),
        qc_verdicts=tuple((subject, "pass") for subject in subjects),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )
    identity = ProjectIdentity(
        "resource-generation",
        str(root),
        str(root / "supraspina.project.json"),
        1,
    )
    cfg = _config(root)
    nodes = [
        {
            "nodeId": f"{key}:cohort",
            "stepKey": key,
            "subjectId": None,
            "scope": "cohort",
            "status": "planned",
            "dependencies": [],
        }
        for key in _COHORT_STEPS
    ]
    state = {
        "runId": "run-12345678",
        "project": identity.to_dict(),
        "config": cfg,
        "scope": cohort.to_dict(),
        "intent": {"kind": "workflow"},
        "nodes": nodes,
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
        project=identity,
        store=RunStore(str(root)),
        queue_limit=1,
    )


def _publish_receipts(manager: WorkflowManager, ctx: _RunContext) -> None:
    for index, key in enumerate(_COHORT_STEPS):
        signature, payload = manager._expected(ctx, key, None)
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


def _receipt_files(root: Path) -> dict[str, bytes]:
    """Return every receipt file under ``root`` with its bytes."""
    receipts = root / ".supraspina" / "receipts"
    return {
        str(path.relative_to(receipts)): path.read_bytes()
        for path in sorted(receipts.rglob("*.json"))
    }


def _node(ctx: _RunContext, key: str) -> dict[str, Any]:
    return next(node for node in ctx.state["nodes"] if node["stepKey"] == key)


@pytest.fixture
def rebuilt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[WorkflowManager, _RunContext, Path, Path]]:
    """Return a project and two acquisition generations with the same bytes."""
    cache = tmp_path / "scientific-assets"
    first = _generation(cache, _GENERATION_A)
    second = _generation(cache, _GENERATION_B)
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("SUPRASPINA_SCIENTIFIC_ASSET_ROOT", str(cache))
    _activate(monkeypatch, first)
    monkeypatch.setattr(runtime, "detector_evidence", lambda *_args: dict(_DONE))
    monkeypatch.setattr(runtime, "edge_evidence", lambda *_args: dict(_DONE))
    monkeypatch.setattr(runtime, "enrich_evidence", lambda _key, value, *_a: value)
    manager = WorkflowManager(_Emitter())
    yield manager, _context(project), first, second
    manager.shutdown()


def _activate(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    # Resolve every resource directory, bundled or acquired, under ``root``.
    monkeypatch.setattr(resources, "resource_root", lambda: root)
    monkeypatch.setattr(scientific_assets, "bundled_override", lambda *_args: False)


def test_receipt_stays_current_after_an_identical_generation_rebuild(
    rebuilt: tuple[WorkflowManager, _RunContext, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, ctx, _first, second = rebuilt
    _publish_receipts(manager, ctx)
    before = {key: manager._expected(ctx, key, None)[0] for key in _COHORT_STEPS}

    _activate(monkeypatch, second)

    assert {key: manager._expected(ctx, key, None)[0] for key in _COHORT_STEPS} == (
        before
    )
    for key in _COHORT_STEPS:
        assert manager._current_receipt(ctx, _node(ctx, key)) is not None, key
    assert manager._producer_ready(ctx, "aggregate", "final", None) == (True, "")


def test_changed_resource_bytes_make_the_receipt_stale(
    rebuilt: tuple[WorkflowManager, _RunContext, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, ctx, _first, second = rebuilt
    _publish_receipts(manager, ctx)
    script = second / "step8" / "aggregate_stats.py"
    script.write_bytes(script.read_bytes() + b"\n# revised\n")

    _activate(monkeypatch, second)

    assert manager._current_receipt(ctx, _node(ctx, "aggregate")) is None
    assert manager._current_receipt(ctx, _node(ctx, "final")) is None
    ready, reason = manager._producer_ready(ctx, "aggregate", "final", None)
    assert not ready
    assert "no matching current provenance receipt" in reason
    # A stage whose resources and lineage did not change stays current.
    assert manager._current_receipt(ctx, _node(ctx, "enigma")) is not None


def test_run_all_after_an_identical_rebuild_schedules_no_done_cohort_stage(
    rebuilt: tuple[WorkflowManager, _RunContext, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, ctx, _first, second = rebuilt
    _publish_receipts(manager, ctx)

    _activate(monkeypatch, second)
    manager._apply_runtime_policy(ctx)

    assert {node["stepKey"]: node["status"] for node in ctx.state["nodes"]} == {
        key: "skipped" for key in _COHORT_STEPS
    }


def _asset_report(root: Path, *, status: str = "found") -> dict[str, Any]:
    """Return an env report whose ENIGMA asset check names ``root``."""
    return {
        "groups": [
            {
                "checks": [
                    {
                        "id": "enigma_assets",
                        "status": status,
                        "detail": (
                            "Use the integrity-verified ENIGMA QC assets in "
                            f"{root / 'enigma'}."
                        ),
                    },
                    {"id": "bash", "status": "found", "detail": "/usr/bin/bash"},
                    {
                        "id": "mcr",
                        "status": "found",
                        "detail": "Use the MATLAB Runtime in /usr/local/MATLAB/v97.",
                    },
                    {"id": "matlab", "status": "skipped", "detail": "Not needed."},
                    {"id": "rscript", "status": "found", "detail": "R 4.4.1"},
                ]
            }
        ]
    }


def _summarize(ctx: _RunContext, root: Path, *, status: str = "found") -> None:
    ctx.state["environmentEvidence"] = WorkflowManager._environment_summary(
        _asset_report(root, status=status)
    )


def test_enigma_stays_current_when_its_asset_check_names_a_rebuilt_generation(
    rebuilt: tuple[WorkflowManager, _RunContext, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, ctx, first, second = rebuilt
    _summarize(ctx, first)
    _publish_receipts(manager, ctx)
    before = {key: manager._expected(ctx, key, None)[0] for key in _COHORT_STEPS}

    _activate(monkeypatch, second)
    _summarize(ctx, second)

    evidence = ctx.state["environmentEvidence"]["enigma_assets"]
    assert evidence["identitySha256"] == provenance.stable_digest(
        "Use the integrity-verified ENIGMA QC assets in "
        f"{provenance.SCIENTIFIC_RESOURCES_PLACEHOLDER}{os.sep}enigma."
    )
    assert str(second) not in json.dumps(ctx.state["environmentEvidence"])
    assert {key: manager._expected(ctx, key, None)[0] for key in _COHORT_STEPS} == (
        before
    )
    assert manager._current_receipt(ctx, _node(ctx, "enigma")) is not None
    assert manager._current_receipt(ctx, _node(ctx, "outliers")) is not None


def test_changed_asset_check_status_makes_enigma_stale(
    rebuilt: tuple[WorkflowManager, _RunContext, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, ctx, first, second = rebuilt
    _summarize(ctx, first)
    _publish_receipts(manager, ctx)

    _activate(monkeypatch, second)
    _summarize(ctx, second, status="wrong")

    assert manager._current_receipt(ctx, _node(ctx, "enigma")) is None
    assert manager._current_receipt(ctx, _node(ctx, "outliers")) is None
    assert manager._current_receipt(ctx, _node(ctx, "aggregate")) is not None


def test_changed_enigma_bytes_make_enigma_stale_despite_a_matching_check(
    rebuilt: tuple[WorkflowManager, _RunContext, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, ctx, first, second = rebuilt
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    _summarize(ctx, first)
    _publish_receipts(manager, ctx)
    wrapper = second / "enigma" / "enigma_fs_wrapper_script.sh"
    wrapper.write_bytes(wrapper.read_bytes() + b"\n# revised\n")

    _activate(monkeypatch, second)
    _summarize(ctx, second)

    assert manager._current_receipt(ctx, _node(ctx, "enigma")) is None
    assert manager._current_receipt(ctx, _node(ctx, "outliers")) is None
    assert manager._current_receipt(ctx, _node(ctx, "features")) is not None


def test_check_detail_tokenizes_only_whole_resource_root_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = os.sep.join(("", "cache", "resources"))
    token = provenance.SCIENTIFIC_RESOURCES_PLACEHOLDER
    monkeypatch.setattr(provenance, "_active_resource_roots", lambda: (root,))

    assert provenance.canonical_check_detail(f"Use {root}{os.sep}enigma.") == (
        f"Use {token}{os.sep}enigma."
    )
    assert provenance.canonical_check_detail(f"Use {root}.") == f"Use {token}."
    for untouched in (
        f"Use {root}-old{os.sep}enigma.",
        f"Use {root}.bak.",
        f"Use {os.sep}mirror{root}{os.sep}enigma.",
    ):
        assert provenance.canonical_check_detail(untouched) == untouched


def test_bound_tool_evidence_binds_the_tokenized_identity() -> None:
    root = os.sep.join(("", "cache", "resources"))
    detail = f"Use the assets in {root}{os.sep}enigma."
    evidence = provenance.environment_check_evidence(
        {"id": "enigma_assets", "status": "found", "detail": detail}, (root,)
    )
    environment = {"enigma_assets": evidence, "bash": {"status": "found"}}
    canonical = (
        f"Use the assets in {provenance.SCIENTIFIC_RESOURCES_PLACEHOLDER}"
        f"{os.sep}enigma."
    )

    assert provenance.bound_tool_evidence(
        environment, ("enigma_assets", "bash", "awk")
    ) == {
        "enigma_assets": {
            "status": "found",
            "identitySha256": provenance.stable_digest(canonical),
        },
        "bash": {"status": "found"},
        "awk": {"status": "missing"},
    }


def _count_expected_signatures(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    calls: list[Any] = []
    original = runtime.expected_signature

    def counted(*args: Any, **kwargs: Any) -> Any:
        calls.append((args[0], args[1]))
        return original(*args, **kwargs)

    monkeypatch.setattr(runtime, "expected_signature", counted)
    return calls


def test_plan_after_a_rebuild_digests_each_lineage_node_once(
    rebuilt: tuple[WorkflowManager, _RunContext, Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, single, first, second = rebuilt
    subjects = tuple(f"sub-{index:02d}" for index in range(8))
    project = Path(single.project.root)
    ctx = _context(project, subjects)
    _summarize(ctx, first)
    _publish_receipts(manager, ctx)
    published = _receipt_files(project)
    _activate(monkeypatch, second)
    _summarize(ctx, second)
    calls = _count_expected_signatures(monkeypatch)
    lineage = len(subjects) + len(_COHORT_STEPS)

    with manager._planning_pass(ctx):
        manager._apply_runtime_policy(ctx)

    assert {node["status"] for node in ctx.state["nodes"]} == {"skipped"}
    assert len(calls) == len(set(calls)) == lineage
    assert ctx.expected_memo is None
    # A plan writes no receipt file.
    assert _receipt_files(project) == published


def test_expected_signature_is_recomputed_outside_a_planning_pass(
    rebuilt: tuple[WorkflowManager, _RunContext, Path, Path],
) -> None:
    manager, ctx, first, _second = rebuilt
    with manager._planning_pass(ctx):
        planned = manager._expected(ctx, "enigma", None)[0]
        wrapper = first / "enigma" / "enigma_fs_wrapper_script.sh"
        wrapper.write_bytes(wrapper.read_bytes() + b"\n# revised\n")
        assert manager._expected(ctx, "enigma", None)[0] == planned

    assert manager._expected(ctx, "enigma", None)[0] != planned
