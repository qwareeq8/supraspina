"""Tests for result inventory bounds, path presentation, and identity lifecycles."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import results
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.project import ProjectEpochs
from supraspina_sidecar.recon_fallback import KNOWN_FAILURES, Rerun, fallback_record
from supraspina_sidecar.results import ResultInventory, _ExpectedArtifact
from supraspina_sidecar.run_store import RunStore


def _project(root: Path, *, epoch: int = 1) -> dict[str, Any]:
    return {
        "projectId": "results-boundary",
        "root": str(root),
        "configPath": str(root / "supraspina.project.json"),
        "epoch": epoch,
    }


def _commit(  # noqa: PLR0913
    root: Path,
    run_id: str,
    *,
    config: Any = None,
    nodes: list[dict[str, Any]] | None = None,
    jobs: list[dict[str, Any]] | None = None,
    dry_run: bool = False,
) -> None:
    RunStore(str(root)).commit(
        {
            "runId": run_id,
            "startedAtMs": 1,
            "status": "done",
            "dryRun": dry_run,
            "config": {} if config is None else config,
            "scope": {
                "analysisSubjectIds": ["sub-01"],
                "selectedSubjectIds": ["sub-01"],
                "analysisDigest": "analysis",
                "selectedDigest": "selected",
                "t1": [None, {"subjectId": "sub-01", "fingerprint": "abc"}],
                "qcVerdicts": {"sub-01": "pass"},
            },
            "nodes": nodes or [],
            "jobs": jobs or [],
            "receipts": ["invalid"],
            "environmentEvidence": {},
            "manifest": {"runId": run_id},
        }
    )


def test_artifact_kind_and_display_are_bounded_and_platform_neutral(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    directory = tmp_path / "folder"
    directory.mkdir()
    assert results._kind(str(directory)) == "dir"
    assert results._kind(str(tmp_path / "scan.nii.gz")) == "nii"
    assert results._kind(str(tmp_path / "table.csv")) == "csv"
    assert results._kind(str(tmp_path / "binary.dat")) == "txt"
    assert results._display(str(directory), str(tmp_path)) == "folder"
    assert (
        results._display(str(tmp_path / "outside.txt"), str(directory)) == "outside.txt"
    )

    monkeypatch.setattr(
        results.os.path,
        "relpath",
        lambda *_args: (_ for _ in ()).throw(
            ValueError("Use different fixture drives.")
        ),
    )
    assert (
        results._display(str(tmp_path / "outside.txt"), str(directory)) == "outside.txt"
    )


def test_scope_cohort_ignores_non_mapping_t1_rows_and_supports_camel_case() -> None:
    snapshot = results._cohort(
        {
            "analysisSubjectIds": ["sub-01"],
            "selectedSubjectIds": ["sub-01"],
            "analysisDigest": "analysis",
            "selectedDigest": "selected",
            "t1": [
                None,
                {
                    "subjectId": "sub-01",
                    "path": "/synthetic/input.nii.gz",
                    "fingerprint": "abc",
                    "fingerprintStrategy": "full-v1",
                },
            ],
            "qcVerdicts": {"sub-01": "pass"},
            "qcAcknowledged": True,
        }
    )

    assert len(snapshot.t1) == 1
    assert snapshot.t1[0].subject_id == "sub-01"
    assert snapshot.t1[0].fingerprint_strategy == "full-v1"
    assert snapshot.qc_acknowledged is True


def test_logical_dependencies_prioritize_enabled_input_preprocessors() -> None:
    cfg = {
        "steps": {
            "brainfov": {"enabled": True},
            "deface": {"enabled": True},
        }
    }

    assert results._logical_dependencies(cfg, "deface") == ["brainfov"]
    assert results._logical_dependencies(cfg, "recon") == ["deface"]


def test_provenance_disclosure_bounds_receipt_and_reviewed_plan_identities(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(results, "receipt_signature_valid", lambda *_args: True)
    receipt = {
        "receiptVersion": 1,
        "signature": "s" * 64,
        "committedAtMs": 123,
        "jobId": "job-1",
        "analysisCohortDigest": "analysis",
        "selectedSubsetDigest": "selected",
        "inputT1Fingerprint": {"sha256": "input"},
        "stepParamsDigest": "params",
        "adapterIdentity": "module.Adapter",
        "adapterImplementation": {"sha256": "implementation"},
        "toolEvidenceDigest": "tools",
        "externalInputs": {"metadata": {"path": "/private", "sha256": "file"}},
        "outputSchemaIdentity": "schema:v1",
        "upstreamSignatures": ["upstream", None, ""],
        "baseline": {"commit": "abc"},
    }
    plan_binding = {
        "digest": "plan",
        "configDigest": "config",
        "qcDigest": "qc",
        "registryDigest": "registry",
        "environmentDigest": "environment",
    }

    disclosed = results._receipt_provenance(receipt, {"planBinding": plan_binding})

    assert disclosed["receipt"]["signatureValid"] is True
    assert disclosed["receipt"]["inputT1Fingerprint"] == results.stable_digest(
        {"sha256": "input"}
    )
    assert disclosed["receipt"]["externalInputsDigest"] == results.stable_digest(
        receipt["externalInputs"]
    )
    assert "/private" not in str(disclosed)
    assert disclosed["receipt"]["upstreamSignatures"] == ["upstream"]
    assert disclosed["runBinding"] == {
        "planDigest": "plan",
        "configDigest": "config",
        "qcDigest": "qc",
        "registryDigest": "registry",
        "environmentDigest": "environment",
    }


def test_provenance_disclosure_fails_closed_for_malformed_persisted_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def reject_signature(*_args: Any) -> bool:
        raise ValueError("Reject the malformed receipt.")

    monkeypatch.setattr(results, "receipt_signature_valid", reject_signature)
    monkeypatch.setattr(
        results,
        "stable_digest",
        lambda value: (
            (_ for _ in ()).throw(TypeError("Provide JSON-compatible data."))
            if value == {"invalid": True}
            else "digest"
        ),
    )
    disclosed = results._receipt_provenance(
        {
            "receiptVersion": True,
            "signature": "claimed",
            "committedAtMs": -1,
            "adapterImplementation": "not a mapping",
            "inputT1Fingerprint": {"invalid": True},
            "externalInputs": None,
            "upstreamSignatures": "not a list",
            "baseline": "baseline-id",
        },
        {"planBinding": {}},
    )

    assert disclosed["receipt"]["signatureValid"] is False
    assert disclosed["receipt"]["receiptVersion"] is None
    assert disclosed["receipt"]["committedAtMs"] is None
    assert disclosed["receipt"]["adapterImplementationSha256"] is None
    assert disclosed["receipt"]["inputT1Fingerprint"] is None
    assert disclosed["receipt"]["externalInputsDigest"] is None
    assert disclosed["receipt"]["upstreamSignatures"] == []
    assert disclosed["receipt"]["baselineDigest"] == "baseline-id"
    assert disclosed["runBinding"] is None
    assert results._receipt_provenance(None, {"planBinding": "invalid"}) == {
        "receipt": None,
        "runBinding": None,
    }
    assert results._bounded_text(None) is None
    assert results._bounded_text("") is None
    assert results._identity(None) is None


def test_artifact_query_matches_all_terms_across_stage_and_attribution() -> None:
    row = {
        "label": "Cortical internal QC gallery",
        "stepKey": "enigma",
        "subjectId": "sub-0049",
        "displayPath": "qc/cortical_internal/report.html",
        "kind": "html",
        "presence": "produced",
        "runId": "run-12345678",
        "producerNodeId": "enigma:cohort",
    }

    assert results._matches_query(row, "") is True
    assert results._matches_query(row, "ENIGMA sub-0049 cortical") is True
    assert results._matches_query(row, "sub-0049 missing") is False
    assert results._matches_query({"stepKey": "unknown"}, "unknown") is True


def test_the_inventory_states_a_reconstruction_rerun_and_finds_it_by_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(results, "receipt_signature_valid", lambda *_args: True)
    fallback = fallback_record([Rerun(KNOWN_FAILURES[1], 134)])
    receipt = {"signature": "s" * 64, "stepKey": "recon", "executionFallback": fallback}

    disclosed = results._receipt_provenance(receipt, {})

    assert disclosed["receipt"]["executionFallback"] == fallback
    # The disclosure is a copy: the stored receipt record stays as it was.
    disclosed["receipt"]["executionFallback"]["reason"] = "changed"
    assert receipt["executionFallback"] == fallback_record(
        [Rerun(KNOWN_FAILURES[1], 134)]
    )
    # A receipt without a rerun, or with a malformed record, discloses none.
    assert (
        results._receipt_provenance({"signature": "s"}, {})["receipt"][
            "executionFallback"
        ]
        is None
    )
    assert (
        results._receipt_provenance(
            {"signature": "s", "executionFallback": {"kind": "x"}}, {}
        )["receipt"]["executionFallback"]
        is None
    )

    row = {
        "label": "FreeSurfer subject directory",
        "stepKey": "recon",
        "subjectId": "sub-102",
        "provenanceDetails": results._receipt_provenance(receipt, {}),
    }
    assert results._matches_query(row, "-no-fix-with-ga") is True
    assert results._matches_query(row, "-no-fix-ga") is False
    assert results._matches_query({**row, "provenanceDetails": None}, "-no-fix") is (
        False
    )


def test_final_expected_artifacts_use_existing_csv_and_optional_pdf(
    tmp_path: Path,
) -> None:
    adapter = ADAPTERS["final"]
    cfg = {
        "paths": {"outputDir": str(tmp_path)},
        "steps": {"final": {"enabled": True, "params": {"renderReport": True}}},
    }
    root = tmp_path / "final"
    root.mkdir()
    (root / "SCI_PvH_results.csv").write_text("result", encoding="utf-8")
    (root / "report.pdf").write_text("report", encoding="utf-8")

    expected = results._expected("final", adapter, cfg, None)

    assert next(
        item for item in expected if item.label == "SCI PvH results"
    ).path.endswith("SCI_PvH_results.csv")
    assert next(item for item in expected if item.label == "Report").path.endswith(
        "report.pdf"
    )

    cfg["steps"]["final"]["params"]["renderReport"] = False
    assert all(
        item.label != "Report"
        for item in results._expected("final", adapter, cfg, None)
    )
    assert results._expected("unknown", adapter, cfg, None) == []


def test_inventory_without_run_returns_safe_empty_page(tmp_path: Path) -> None:
    inventory = ResultInventory(ProjectEpochs())

    page = inventory.list({"project": _project(tmp_path)})

    assert page == {"items": [], "nextCursor": None, "truncated": False}


class _Adapter:
    def required_check_ids(self, _cfg: dict[str, Any]) -> tuple[str, ...]:
        return ()


def test_inventory_uses_latest_run_filters_malformed_state_and_bounds_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = "run-12345678"
    artifact = tmp_path / "unexpected.txt"
    artifact.write_text("artifact", encoding="utf-8")
    _commit(
        tmp_path,
        run_id,
        config=[],
        nodes=[
            {
                "stepKey": "recon",
                "subjectId": "sub-01",
                "status": "failed",
            }
        ],
        jobs=[
            {
                "id": "job-1",
                "nodeId": "recon:sub-01",
                "stepKey": "recon",
                "subjectId": "sub-01",
                "status": "failed",
            }
        ],
    )
    monkeypatch.setattr(
        results,
        "STEP_DESCRIPTORS",
        [
            {"id": 1, "key": "recon", "scope": "subject"},
            {"id": 9, "key": "final", "scope": "cohort"},
        ],
    )
    monkeypatch.setitem(results.ADAPTERS, "recon", _Adapter())
    monkeypatch.setitem(results.ADAPTERS, "final", _Adapter())
    monkeypatch.setattr(
        results,
        "detector_evidence",
        lambda *_args: {
            "state": "partial",
            "detail": "incomplete",
            "artifacts": [None, {}, {"path": str(artifact)}],
        },
    )
    monkeypatch.setattr(
        results, "enrich_evidence", lambda _key, evidence, *_args: evidence
    )
    monkeypatch.setattr(
        results,
        "_expected",
        lambda *_args: [
            _ExpectedArtifact("Missing", str(tmp_path / "missing.txt"), "txt")
        ],
    )
    monkeypatch.setattr(results, "_MAX_ROWS", 2)
    inventory = ResultInventory(ProjectEpochs())

    page = inventory.list(
        {
            "project": _project(tmp_path),
            "cursor": "invalid",
            "limit": "invalid",
        }
    )

    assert [item["presence"] for item in page["items"]] == ["absent", "partial"]
    assert page["truncated"] is True
    assert page["nextCursor"] is None
    produced = page["items"][1]
    assert produced["label"] == artifact.name
    assert produced["exists"] is True
    assert produced["runId"] == run_id
    assert produced["producerNodeId"] == "recon:sub-01"

    filtered = inventory.list(
        {
            "project": _project(tmp_path),
            "stepKey": "recon",
            "query": "SUB-01 missing",
            "limit": 1,
        }
    )
    assert [item["label"] for item in filtered["items"]] == ["Missing"]
    assert filtered["runId"] == run_id
    assert filtered["total"] == 1

    focused = inventory.list(
        {
            "project": _project(tmp_path),
            "stepKey": "final",
            "query": "missing",
            "limit": 1,
        }
    )
    assert [item["stepKey"] for item in focused["items"]] == ["final"]

    with pytest.raises(ValueError, match="stage filter"):
        inventory.list({"project": _project(tmp_path), "stepKey": 1})
    with pytest.raises(ValueError, match="stage filter"):
        inventory.list({"project": _project(tmp_path), "stepKey": "invalid"})
    with pytest.raises(ValueError, match="valid result-search query"):
        inventory.list({"project": _project(tmp_path), "query": []})
    with pytest.raises(ValueError, match="Shorten the result-search query"):
        inventory.list(
            {
                "project": _project(tmp_path),
                "query": "x" * (results._MAX_QUERY_CHARACTERS + 1),
            }
        )


def test_row_issuance_is_bounded_and_resolution_reflects_deletion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "artifact.txt"
    path.write_text("artifact", encoding="utf-8")
    projects = ProjectEpochs()
    project = projects.validate(_project(tmp_path))
    inventory = ResultInventory(projects)
    monkeypatch.setattr(results, "_MAX_ISSUED", 1)

    first = inventory._row(
        project,
        "first",
        "recon",
        "sub-01",
        "txt",
        "produced",
        str(path),
        "run-12345678",
        "recon:sub-01",
        None,
        "unknown",
        {},
        "",
    )
    second_id = inventory.register_external(
        project.project_id, project.epoch, str(path), kind="file"
    )
    assert len(inventory._issued) == 1
    with pytest.raises(ValueError, match="known artifact identity"):
        inventory.resolve(
            {"project": _project(tmp_path), "artifactId": first["artifactId"]}
        )

    path.unlink()
    resolved = inventory.resolve(
        {"project": _project(tmp_path), "artifactId": second_id}
    )
    assert resolved == {"path": str(path), "kind": "file", "exists": False}


def test_missing_row_is_never_issued_or_openable(tmp_path: Path) -> None:
    projects = ProjectEpochs()
    project = projects.validate(_project(tmp_path))
    inventory = ResultInventory(projects)

    row = inventory._row(
        project,
        "missing",
        "recon",
        "sub-01",
        "txt",
        "expected",
        str(tmp_path / "missing.txt"),
        None,
        None,
        None,
        "unknown",
        {},
        "",
    )

    assert row["exists"] is False
    assert row["openable"] is False
    assert row["revealable"] is False
    assert row["displayPath"] == "missing.txt"
    assert inventory._issued == {}


def test_row_issuance_evicts_oldest_identity_at_exact_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    artifact = tmp_path / "artifact.txt"
    artifact.write_text("artifact", encoding="utf-8")
    projects = ProjectEpochs()
    project = projects.validate(_project(tmp_path))
    inventory = ResultInventory(projects)
    monkeypatch.setattr(results, "_MAX_ISSUED", 1)

    first = inventory._row(
        project,
        "first",
        "recon",
        "sub-01",
        "txt",
        "produced",
        str(artifact),
        "run-12345678",
        "recon:sub-01",
        None,
        "current",
        {},
        "",
    )
    second = inventory._row(
        project,
        "second",
        "recon",
        "sub-01",
        "txt",
        "produced",
        str(artifact),
        "run-12345678",
        "recon:sub-01",
        None,
        "current",
        {},
        "",
    )

    assert len(inventory._issued) == 1
    assert (project.project_id, first["artifactId"]) not in inventory._issued
    assert (project.project_id, second["artifactId"]) in inventory._issued


def _produced_row(
    inventory: ResultInventory, project: Any, label: str, path: Path
) -> dict[str, Any]:
    return inventory._row(
        project,
        label,
        "recon",
        "sub-01",
        "txt",
        "produced",
        str(path),
        "run-12345678",
        "recon:sub-01",
        None,
        "current",
        {},
        "",
    )


def test_resolving_an_issued_id_keeps_it_held_longest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    artifact = tmp_path / "artifact.txt"
    artifact.write_text("artifact", encoding="utf-8")
    projects = ProjectEpochs()
    project = projects.validate(_project(tmp_path))
    inventory = ResultInventory(projects)
    monkeypatch.setattr(results, "_MAX_ISSUED", 2)

    first = _produced_row(inventory, project, "first", artifact)
    second = _produced_row(inventory, project, "second", artifact)
    inventory.resolve(
        {"project": _project(tmp_path), "artifactId": first["artifactId"]}
    )
    third = _produced_row(inventory, project, "third", artifact)

    assert (project.project_id, first["artifactId"]) in inventory._issued
    assert (project.project_id, second["artifactId"]) not in inventory._issued
    assert (project.project_id, third["artifactId"]) in inventory._issued


def test_relisting_reuses_an_unchanged_artifact_id_and_reissues_a_changed_one(
    tmp_path: Path,
) -> None:
    artifact = tmp_path / "artifact.txt"
    artifact.write_text("artifact", encoding="utf-8")
    projects = ProjectEpochs()
    project = projects.validate(_project(tmp_path))
    inventory = ResultInventory(projects)

    first = _produced_row(inventory, project, "artifact", artifact)
    again = _produced_row(inventory, project, "artifact", artifact)
    assert again["artifactId"] == first["artifactId"]
    assert len(inventory._issued) == 1

    # Other trusted attribution is another identity.
    relabeled = _produced_row(inventory, project, "renamed", artifact)
    assert relabeled["artifactId"] != first["artifactId"]

    # New content is another identity; the earlier ID keeps its own record.
    artifact.write_text("rewritten artifact", encoding="utf-8")
    rewritten = _produced_row(inventory, project, "artifact", artifact)
    assert rewritten["artifactId"] not in {
        first["artifactId"],
        relabeled["artifactId"],
    }
    earlier = inventory.resolve(
        {"project": _project(tmp_path), "artifactId": first["artifactId"]}
    )
    assert earlier["metadata"]["artifactId"] == first["artifactId"]

    # One listing never returns two rows with the same ID.
    pending: dict[str, dict[str, Any]] = {}
    listed = [
        inventory._row(
            project,
            "artifact",
            "recon",
            "sub-01",
            "txt",
            "produced",
            str(artifact),
            "run-12345678",
            "recon:sub-01",
            None,
            "current",
            {},
            "",
            pending=pending,
        )
        for _ in range(2)
    ]
    assert listed[0]["artifactId"] == rewritten["artifactId"]
    assert listed[1]["artifactId"] != listed[0]["artifactId"]


def test_truncated_subject_scan_does_not_claim_cohort_receipt_is_current(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = "run-12345678"
    _commit(tmp_path, run_id)
    store = RunStore(str(tmp_path))
    state = store.load(run_id)
    state["receipts"] = [{"stepKey": "features", "subjectId": None}]
    store.commit(state)
    monkeypatch.setattr(results, "_MAX_SUBJECTS", 0)
    monkeypatch.setattr(
        results,
        "STEP_DESCRIPTORS",
        [{"id": 3, "key": "features", "scope": "cohort"}],
    )
    monkeypatch.setitem(results.ADAPTERS, "features", _Adapter())
    monkeypatch.setattr(
        results,
        "detector_evidence",
        lambda *_args: {"state": "pending", "detail": "", "artifacts": []},
    )
    monkeypatch.setattr(
        results, "enrich_evidence", lambda _key, evidence, *_args: evidence
    )
    monkeypatch.setattr(results, "_expected", lambda *_args: [])

    page = ResultInventory(ProjectEpochs()).list({"project": _project(tmp_path)})

    assert page["items"] == []
    assert page["truncated"] is True


def test_inventory_lists_stages_in_display_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _commit(tmp_path, "run-12345678", config=[])
    # Node order appends BrainCharts after R analysis; the listing places each
    # stage by its display id, as the stage lists do.
    monkeypatch.setattr(
        results,
        "STEP_DESCRIPTORS",
        [
            {"id": 5, "key": "pybrainage", "scope": "cohort"},
            {"id": 6, "key": "clinical", "scope": "cohort"},
            {"id": 9, "key": "final", "scope": "cohort"},
            {"id": 5.5, "key": "braincharts", "scope": "cohort"},
            {"id": 9.5, "key": "zstats", "scope": "cohort"},
        ],
    )
    for key in ("pybrainage", "clinical", "final", "braincharts", "zstats"):
        monkeypatch.setitem(results.ADAPTERS, key, _Adapter())
    monkeypatch.setattr(
        results,
        "detector_evidence",
        lambda *_args: {"state": "pending", "detail": "", "artifacts": []},
    )
    monkeypatch.setattr(
        results, "enrich_evidence", lambda _key, evidence, *_args: evidence
    )
    monkeypatch.setattr(
        results,
        "_expected",
        lambda step_key, *_args: [
            _ExpectedArtifact(step_key, str(tmp_path / f"{step_key}.csv"), "csv")
        ],
    )

    page = ResultInventory(ProjectEpochs()).list({"project": _project(tmp_path)})

    assert [item["stepKey"] for item in page["items"]] == [
        "pybrainage",
        "braincharts",
        "clinical",
        "final",
        "zstats",
    ]
