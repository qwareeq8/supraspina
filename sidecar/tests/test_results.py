"""Tests for detector-backed result presence, provenance, bounds, and resolution."""

from __future__ import annotations

import gzip
import hashlib
import json
import struct
import zlib
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import supraspina_sidecar.adapters.base as base_module
import supraspina_sidecar.cohort as cohort_module
import supraspina_sidecar.paths as paths_module
import supraspina_sidecar.provenance as provenance_module
import supraspina_sidecar.resources as resources_module
import supraspina_sidecar.results as results_module
import supraspina_sidecar.workflow_manager as runtime_module
from supraspina_sidecar.adapters import brainfov as brainfov_adapter
from supraspina_sidecar.adapters import enigma as enigma_module
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.adapters.brainpad import MANIFEST_BASENAME, OUTPUT_BASENAMES
from supraspina_sidecar.adapters.fastsurfer import reconstruction_artifact_groups
from supraspina_sidecar.adapters.final import (
    COMPARISON_CODES,
    CSV_OUTPUTS,
    RESULT_BLOCKS,
)
from supraspina_sidecar.brainfov import (
    build_brainfov_provenance,
    build_derivative_paths,
    plan_brain_fov_crop,
    publish_derivative_set,
    verify_published_derivative_set,
)
from supraspina_sidecar.cohort import (
    CohortError,
    CohortSnapshot,
    T1Resolution,
    build_cohort_snapshot,
    load_qc_records,
)
from supraspina_sidecar.membership import enrich_evidence
from supraspina_sidecar.project import ProjectEpochs, ProjectIdentity
from supraspina_sidecar.provenance import (
    bind_projection_inputs,
    detector_evidence,
    expected_signature,
    make_receipt,
    stable_digest,
)
from supraspina_sidecar.registry import STEP_BY_KEY, STEP_SCOPES
from supraspina_sidecar.results import ResultInventory
from supraspina_sidecar.run_store import RunStore
from supraspina_sidecar.schema import validate_project_config
from supraspina_sidecar.workflow import runtime_cfg
from supraspina_sidecar.workflow_manager import WorkflowManager, _RunContext


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    """Return one PNG chunk with its correct CRC."""
    checksum = zlib.crc32(kind)
    checksum = zlib.crc32(payload, checksum) & 0xFFFFFFFF
    return (
        struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)
    )


#: Reuse one structurally complete PNG for every montage fixture image.
_PNG_FIXTURE = (
    b"\x89PNG\r\n\x1a\n"
    + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    + _png_chunk(b"IDAT", zlib.compress(bytes([0, 0, 0, 0])))
    + _png_chunk(b"IEND", b"")
)
_PNG_DIGEST = hashlib.sha256(_PNG_FIXTURE).hexdigest()


def _project(root: Path, epoch: int = 1) -> dict[str, Any]:
    return {
        "projectId": "results-project",
        "root": str(root.resolve()),
        "configPath": str((root / "supraspina.project.json").resolve()),
        "epoch": epoch,
    }


def _write_xlsx(path: Path) -> None:
    """Write a stand-in workbook that begins with the XLSX ZIP signature."""
    path.write_bytes(b"PK\x03\x04xlsx")


def _cfg(root: Path) -> dict[str, Any]:
    return {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(root / "rawdata"),
            "derivativesDir": str(root / "derivatives"),
            "outputDir": str(root / "outputs"),
            "metadataDir": str(root / "metadata"),
            "ageMetadataFile": str(root / "metadata" / "age.csv"),
            "clinicalMetadataFile": str(root / "metadata" / "clinical.csv"),
            "qcOutputDir": str(root / "outputs" / "qc"),
        },
        "tools": {
            "freesurferHome": "/opt/freesurfer",
            "pythonExecutable": "/opt/python",
            "rscriptExecutable": "/opt/Rscript",
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "runtime": {"threads": 1},
        "pybrain": {
            "modelPath": str(root / "models" / "ExtraTreesModel"),
            "scalerPath": str(root / "models" / "scaler.pkl"),
        },
        "steps": {
            "deface": {
                "enabled": False,
                "params": {"tool": "mri_deface", "forceOverwrite": False},
            },
            "recon": {
                "enabled": True,
                "params": {"directives": "-all", "parallel": True},
            },
            "enigma": {"enabled": True, "params": {"backend": "matlab"}},
            "features": {
                "enabled": True,
                "params": {"parcellation": "aparc.a2009s", "measure": "thickness"},
            },
            "age": {"enabled": True, "params": {"join": "left"}},
            "pybrainage": {"enabled": True, "params": {"rowFallback": True}},
            "clinical": {"enabled": True, "params": {}},
            "brainpad": {"enabled": True, "params": {}},
            "aggregate": {
                "enabled": True,
                "params": {"subjectGlob": "sub-*"},
            },
            "outliers": {"enabled": True, "params": {}},
            "final": {"enabled": True, "params": {"renderReport": True}},
            "braincharts": {"enabled": True, "params": {"seed": 117}},
            "zstats": {"enabled": True, "params": {"renderReport": True}},
        },
    }


def _cohort(root: Path, subject_ids: tuple[str, ...]) -> CohortSnapshot:
    resolutions = tuple(
        T1Resolution(
            subject_id,
            "resolved",
            str(root / "rawdata" / subject_id / "anat" / f"{subject_id}_T1w.nii.gz"),
            (),
            f"fingerprint-{subject_id}",
        )
        for subject_id in subject_ids
    )
    return CohortSnapshot(
        analysis_subject_ids=subject_ids,
        selected_subject_ids=subject_ids,
        analysis_digest="analysis-digest",
        selected_digest="selected-digest",
        t1=resolutions,
        qc_verdicts=tuple((subject_id, "pass") for subject_id in subject_ids),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def _state(  # noqa: PLR0913
    root: Path,
    run_id: str,
    *,
    dry_run: bool,
    node_status: str,
    receipts: list[dict[str, Any]] | None = None,
    cfg: dict[str, Any] | None = None,
    cohort: CohortSnapshot | None = None,
    scientific_evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    config = cfg or _cfg(root)
    snapshot = cohort or _cohort(root, ("sub-001",))
    return {
        "runId": run_id,
        "startedAtMs": 1,
        "status": "done",
        "dryRun": dry_run,
        "config": config,
        "configSha256": stable_digest(config),
        "scope": snapshot.to_dict(),
        "nodes": [
            {
                "nodeId": "recon:sub-001",
                "stepKey": "recon",
                "subjectId": "sub-001",
                "status": node_status,
            }
        ],
        "jobs": [
            {
                "id": "job-recon",
                "nodeId": "recon:sub-001",
                "stepKey": "recon",
                "subjectId": "sub-001",
                "status": node_status,
            }
        ],
        "receipts": receipts or [],
        "environmentEvidence": {},
        "scientificEvidence": scientific_evidence or {},
        "manifest": {"runId": run_id},
    }


def _inventory(root: Path) -> tuple[ResultInventory, dict[str, Any]]:
    projects = ProjectEpochs()
    inventory = ResultInventory(projects)
    return inventory, _project(root)


def test_receipt_signature_binds_exact_scientific_resource_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    resource_dir = tmp_path / "reviewed-features"
    resource_dir.mkdir()
    extractor = resource_dir / "extract_features.py"
    template = resource_dir / "rois_input_template.txt"
    extractor.write_text("print('first')\n", encoding="utf-8")
    template.write_text("roi\n", encoding="utf-8")
    monkeypatch.setattr(resources_module, "features_dir", lambda: resource_dir)
    cfg = _cfg(tmp_path)
    cohort = _cohort(tmp_path, ("sub-001",))
    adapter = ADAPTERS["features"]

    first_signature, first = expected_signature("features", None, cfg, cohort, adapter)
    resources = first["adapterImplementation"]["scientificResources"]
    assert (
        resources["extractor"]["sha256"]
        == hashlib.sha256(extractor.read_bytes()).hexdigest()
    )
    assert (
        resources["featureOrder"]["sha256"]
        == hashlib.sha256(template.read_bytes()).hexdigest()
    )

    extractor.write_text("print('changed')\n", encoding="utf-8")
    second_signature, _second = expected_signature(
        "features", None, cfg, cohort, adapter
    )

    assert second_signature != first_signature


def _rows_for(
    inventory: ResultInventory,
    project: dict[str, Any],
    run_id: str,
    step_key: str,
) -> list[dict[str, Any]]:
    result = inventory.list({"project": project, "runId": run_id, "limit": 500})
    return [item for item in result["items"] if item["stepKey"] == step_key]


def _signature_for_step(
    step_key: str,
    subject_id: str | None,
    effective_cfg: dict[str, Any],
    cohort: CohortSnapshot,
    cache: dict[tuple[str, str | None], tuple[str, dict[str, Any]]],
) -> tuple[str, dict[str, Any]]:
    """Build the same static-DAG digest Results expects in these fixtures."""
    key = (step_key, subject_id)
    if key in cache:
        return cache[key]
    upstream: list[str] = []
    for producer in STEP_BY_KEY[step_key]["dependencies"]:
        if producer == "recon":
            upstream.extend(
                _signature_for_step(producer, member, effective_cfg, cohort, cache)[0]
                for member in cohort.analysis_subject_ids
            )
        elif STEP_SCOPES[producer] == "subject":
            upstream.append(
                _signature_for_step(producer, subject_id, effective_cfg, cohort, cache)[
                    0
                ]
            )
        else:
            upstream.append(
                _signature_for_step(producer, None, effective_cfg, cohort, cache)[0]
            )
    adapter = ADAPTERS[step_key]
    tool_evidence = {
        check_id: {"status": "missing"}
        for check_id in adapter.required_check_ids(effective_cfg)
    }
    # Bind the run-scoped metadata projection exactly as the launcher does,
    # so clinical and final receipts verify against the inventory.
    cache[key] = bind_projection_inputs(
        step_key,
        *expected_signature(
            step_key,
            subject_id,
            effective_cfg,
            cohort,
            adapter,
            upstream_signatures=upstream,
            tool_evidence=tool_evidence,
        ),
    )
    return cache[key]


def _current_cohort_receipt(
    root: Path,
    run_id: str,
    cfg: dict[str, Any],
    cohort: CohortSnapshot,
    step_key: str,
) -> dict[str, Any]:
    """Build a current receipt for a completed cohort adapter fixture."""
    effective_cfg = runtime_cfg(cfg, cohort, run_id, str(root))
    signature, payload = _signature_for_step(step_key, None, effective_cfg, cohort, {})
    evidence = enrich_evidence(
        step_key,
        detector_evidence(ADAPTERS[step_key], effective_cfg, None),
        effective_cfg,
        cohort,
    )
    return make_receipt(
        signature,
        payload,
        evidence,
        run_id=run_id,
        job_id=f"job-{step_key}",
        committed_at_ms=2,
    )


def test_result_page_exposes_verified_inventory_config_digest(
    tmp_path: Path,
) -> None:
    inventory, project = _inventory(tmp_path)
    empty = inventory.list({"project": project})
    assert "configSha256" not in empty

    run_id = "run-10101010"
    state = _state(tmp_path, run_id, dry_run=True, node_status="done")
    state["configSha256"] = "0" * 64
    RunStore(str(tmp_path)).commit(state)

    page = inventory.list({"project": project, "runId": run_id, "limit": 1})

    assert page["items"]
    assert page["configSha256"] == stable_digest(state["config"])
    assert page["configSha256"] != state["configSha256"]


def test_a_run_under_another_configuration_answers_with_its_digest_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = "run-10101011"
    state = _state(tmp_path, run_id, dry_run=True, node_status="done")
    RunStore(str(tmp_path)).commit(state)
    inventory, project = _inventory(tmp_path)
    request = {"project": project, "runId": run_id, "stepKey": "enigma"}
    digest = stable_digest(state["config"])

    def without_ids(page: dict[str, Any]) -> dict[str, Any]:
        rows = [{**row, "artifactId": None} for row in page["items"]]
        return {**page, "items": rows}

    full = inventory.list(request)
    assert full["items"]
    same = inventory.list({**request, "currentConfigSha256": digest})
    assert without_ids(same) == without_ids(full)

    # QC review probes every older ENIGMA run for the saved
    # configuration; one recorded under another must not pay for the
    # per-row provenance of its whole cohort.
    calls: list[str] = []
    original = ResultInventory._signing_inputs

    def counted(self: ResultInventory, *args: Any, **kwargs: Any) -> Any:
        calls.append(run_id)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(ResultInventory, "_signing_inputs", counted)
    probe = inventory.list({**request, "currentConfigSha256": "f" * 64})
    assert probe == {
        "items": [],
        "nextCursor": None,
        "truncated": False,
        "runId": run_id,
        "configSha256": digest,
        "total": 0,
    }
    assert calls == []
    with pytest.raises(ValueError, match="configuration digest"):
        inventory.list({**request, "currentConfigSha256": "F" * 64})


@pytest.mark.parametrize(
    ("dry_run", "enigma_status", "outputs"),
    [
        (False, "done", True),
        (False, "done", False),
        (True, None, False),
    ],
    ids=["produced", "absent", "expected"],
)
def test_gallery_presence_of_another_configuration_matches_the_full_inventory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    dry_run: bool,
    enigma_status: str | None,
    outputs: bool,
) -> None:
    # With no run under the saved configuration, QC review names the
    # newest run that holds galleries; that needs each run's gallery
    # presence, which must not cost a full inventory (about two seconds)
    # per run.
    run_id = "run-10101012"
    state = _state(tmp_path, run_id, dry_run=dry_run, node_status="done")
    if enigma_status is not None:
        state["nodes"].append(
            {
                "nodeId": "enigma",
                "stepKey": "enigma",
                "subjectId": None,
                "status": enigma_status,
            }
        )
    if outputs:
        _make_enigma_outputs(tmp_path / "outputs" / "qc", ("sub-001",))
    RunStore(str(tmp_path)).commit(state)
    inventory, project = _inventory(tmp_path)
    request = {"project": project, "runId": run_id, "stepKey": "enigma"}
    fields = ("label", "stepKey", "subjectId", "kind", "presence", "exists")
    full = [
        {key: row[key] for key in fields}
        for row in inventory.list({**request, "limit": 500})["items"]
    ]
    assert {row["presence"] for row in full} == {
        "produced" if outputs else "absent" if not dry_run else "expected"
    }

    def refused(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("A presence probe must not sign or rebuild inputs.")

    monkeypatch.setattr(ResultInventory, "_signing_inputs", refused)
    monkeypatch.setattr(results_module, "expected_signature", refused)
    probe = inventory.list(
        {**request, "currentConfigSha256": "f" * 64, "galleryPresence": True}
    )
    assert probe["items"] == []
    assert probe["configSha256"] == stable_digest(state["config"])
    assert probe["galleryPresence"] == full


def test_gallery_presence_needs_the_enigma_stage_and_a_digest(tmp_path: Path) -> None:
    run_id = "run-10101013"
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=True, node_status="done")
    )
    inventory, project = _inventory(tmp_path)
    request = {"project": project, "runId": run_id, "galleryPresence": True}
    with pytest.raises(ValueError, match="gallery presence"):
        inventory.list({**request, "stepKey": "enigma"})
    with pytest.raises(ValueError, match="gallery presence"):
        inventory.list({**request, "stepKey": "recon", "currentConfigSha256": "f" * 64})
    with pytest.raises(ValueError, match="gallery-presence flag"):
        inventory.list({**request, "stepKey": "enigma", "galleryPresence": "yes"})
    digest = stable_digest(_cfg(tmp_path))
    matched = inventory.list(
        {**request, "stepKey": "enigma", "currentConfigSha256": digest}
    )
    # A run under the saved configuration answers with its full inventory.
    assert matched["items"]
    assert "galleryPresence" not in matched


def test_the_inventory_digest_matches_the_shared_config_digest_fixture(
    tmp_path: Path,
) -> None:
    # The main process asserts the same digest for its session
    # (src/main/ipc.behavior.test.ts), so a drift on either side fails both.
    fixture = json.loads(
        (
            Path(__file__).parents[2] / "fixtures" / "config-digest" / "project.json"
        ).read_text(encoding="utf-8")
    )
    config = fixture["config"]
    assert validate_project_config(config)[0]
    run_id = "run-10101012"
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=True, node_status="done", cfg=config)
    )
    inventory, project = _inventory(tmp_path)
    page = inventory.list(
        {
            "project": project,
            "runId": run_id,
            "stepKey": "enigma",
            "currentConfigSha256": fixture["sha256"],
        }
    )
    assert page["configSha256"] == fixture["sha256"]


def test_dry_run_artifacts_are_expected_not_claimed_absent(tmp_path: Path) -> None:
    run_id = "run-11111111"
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=True, node_status="done")
    )
    inventory, project = _inventory(tmp_path)
    rows = _rows_for(inventory, project, run_id, "recon")
    assert rows
    assert {row["presence"] for row in rows} == {"expected"}
    assert all(row["exists"] is False for row in rows)
    assert all(row["openable"] is False for row in rows)
    assert all(row["runId"] is None for row in rows)


def test_attempted_missing_artifacts_are_absent(tmp_path: Path) -> None:
    run_id = "run-22222222"
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=False, node_status="failed")
    )
    inventory, project = _inventory(tmp_path)
    rows = _rows_for(inventory, project, run_id, "recon")
    assert {row["presence"] for row in rows} == {"absent"}
    assert all(row["runId"] == run_id for row in rows)


def test_final_inventory_declares_all_tables_and_fixed_csvs(tmp_path: Path) -> None:
    run_id = "run-22222223"
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=True, node_status="done")
    )
    inventory, project = _inventory(tmp_path)

    rows = _rows_for(inventory, project, run_id, "final")

    names = {row["label"] for row in rows}
    assert names == {
        "SCI PvH results",
        "SCI nNPvH results",
        "SCI nNPvP results",
        "SCI IvH results",
        "SUB PvH results",
        "SUB nNPvH results",
        "SUB nNPvP results",
        "SUB IvH results",
        "WM PvH results",
        "WM nNPvH results",
        "WM nNPvP results",
        "WM IvH results",
        "Site exclusions",
        "ICV summary",
        "Thickness summary",
        "Report",
    }
    assert {row["presence"] for row in rows} == {"expected"}


def test_brainpad_inventory_declares_all_tables_and_figures(tmp_path: Path) -> None:
    run_id = "run-22222224"
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=True, node_status="done")
    )
    inventory, project = _inventory(tmp_path)

    rows = _rows_for(inventory, project, run_id, "brainpad")

    assert {row["label"] for row in rows} == {
        "Summary statistics",
        "Brain-PAD across cohorts",
        "Brain-PAD across sex",
        "Brain-PAD across AIS",
        "Chi-square across AIS",
        "Time-since-injury comparison",
        "Chronological-age comparison",
        "Brain-PAD comparison figure",
        "Chronological age vs predicted brain age figure",
        "Brain-PAD vs chronological age figure",
        "Brain-PAD across sex figure",
        "Brain-PAD vs time-since-injury figure",
    }
    assert len(rows) == 12
    assert {row["presence"] for row in rows} == {"expected"}


def test_enigma_stage_filter_reaches_galleries_for_large_cohort(
    tmp_path: Path,
) -> None:
    run_id = "run-22222228"
    subject_ids = tuple(f"sub-{index:04d}" for index in range(88))
    cohort = _cohort(tmp_path, subject_ids)
    RunStore(str(tmp_path)).commit(
        _state(
            tmp_path,
            run_id,
            dry_run=True,
            node_status="done",
            cohort=cohort,
        )
    )
    inventory, project = _inventory(tmp_path)

    page = inventory.list(
        {
            "project": project,
            "runId": run_id,
            "stepKey": "enigma",
            "limit": 50,
        }
    )

    assert page["total"] == 6
    assert page["nextCursor"] is None
    assert {row["stepKey"] for row in page["items"]} == {"enigma"}
    assert {row["label"] for row in page["items"] if row["kind"] == "html"} == {
        "Subcortical QC gallery",
        "Cortical-internal QC gallery",
        "Cortical-external QC gallery",
    }


def test_final_inventory_rejects_csv_and_empty_xlsx_variant_ambiguity(
    tmp_path: Path,
) -> None:
    out_dir = tmp_path / "outputs" / "final"
    out_dir.mkdir(parents=True)
    for block in RESULT_BLOCKS:
        for code in COMPARISON_CODES:
            _write_xlsx(out_dir / f"{block}_{code}_results.xlsx")
    (out_dir / "SCI_PvH_results.xlsx").write_text("")
    (out_dir / "SCI_PvH_results.csv").write_text("Region,p_value\n")
    for _key, _label, basename in CSV_OUTPUTS:
        (out_dir / basename).write_text("a,b\n")
    (out_dir / "report.html").write_text("<html></html>")
    run_id = "run-22222225"
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=False, node_status="done")
    )
    inventory, project = _inventory(tmp_path)

    rows = _rows_for(inventory, project, run_id, "final")

    assert len(rows) == 17
    target = next(row for row in rows if row["label"] == "SCI PvH results")
    assert target["displayPath"].endswith("SCI_PvH_results.xlsx")
    assert target["presence"] == "partial"
    assert "Remove stale output variants" in target["detail"]
    assert all(row["exists"] for row in rows)


def test_brainpad_currentness_requires_all_twelve_nonempty_outputs(
    tmp_path: Path,
) -> None:
    analysis_dir = tmp_path / "outputs" / "analysis"
    analysis_dir.mkdir(parents=True)
    for basename in OUTPUT_BASENAMES:
        (analysis_dir / basename).write_text("data")
    files = []
    for basename in OUTPUT_BASENAMES:
        payload = (analysis_dir / basename).read_bytes()
        files.append(
            {
                "name": basename,
                "size": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        )
    (analysis_dir / MANIFEST_BASENAME).write_text(
        json.dumps({"schemaVersion": 1, "files": files}),
        encoding="utf-8",
    )
    run_id = "run-22222226"
    cfg = _cfg(tmp_path)
    cohort = _cohort(tmp_path, ("sub-001",))
    receipt = _current_cohort_receipt(tmp_path, run_id, cfg, cohort, "brainpad")
    state = _state(
        tmp_path,
        run_id,
        dry_run=False,
        node_status="done",
        receipts=[receipt],
        cfg=cfg,
        cohort=cohort,
    )
    store = RunStore(str(tmp_path))
    store.commit(state)
    inventory, project = _inventory(tmp_path)

    current = _rows_for(inventory, project, run_id, "brainpad")
    assert {row["provenance"] for row in current} == {"current"}

    (analysis_dir / "ChronologicalAge_Comparison.csv").write_text("")
    stale = _rows_for(inventory, project, run_id, "brainpad")
    assert {row["provenance"] for row in stale} == {"stale"}


def test_final_currentness_requires_all_nonempty_configured_outputs(
    tmp_path: Path,
) -> None:
    out_dir = tmp_path / "outputs" / "final"
    out_dir.mkdir(parents=True)
    for block in RESULT_BLOCKS:
        for code in COMPARISON_CODES:
            _write_xlsx(out_dir / f"{block}_{code}_results.xlsx")
    for _key, _label, basename in CSV_OUTPUTS:
        (out_dir / basename).write_text("a,b\n")
    (out_dir / "report.html").write_text("<html></html>")
    run_id = "run-22222227"
    cfg = _cfg(tmp_path)
    cohort = _cohort(tmp_path, ("sub-001",))
    receipt = _current_cohort_receipt(tmp_path, run_id, cfg, cohort, "final")
    state = _state(
        tmp_path,
        run_id,
        dry_run=False,
        node_status="done",
        receipts=[receipt],
        cfg=cfg,
        cohort=cohort,
    )
    store = RunStore(str(tmp_path))
    store.commit(state)
    inventory, project = _inventory(tmp_path)

    current = _rows_for(inventory, project, run_id, "final")
    assert {row["provenance"] for row in current} == {"current"}

    (out_dir / "SUB_nNPvP_results.xlsx").write_text("")
    stale = _rows_for(inventory, project, run_id, "final")
    assert {row["provenance"] for row in stale} == {"stale"}


def test_the_aggregate_schema_bump_moves_only_aggregate_and_final(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """structural:four-csv:v2 reaches no node beyond aggregate and final."""
    cfg = _cfg(tmp_path)
    cohort = _cohort(tmp_path, ("sub-001",))
    effective = runtime_cfg(cfg, cohort, "run-2222222b", str(tmp_path))

    def signatures() -> dict[str, str]:
        cache: dict[tuple[str, str | None], tuple[str, dict[str, Any]]] = {}
        return {
            key: _signature_for_step(
                key,
                "sub-001" if STEP_SCOPES[key] == "subject" else None,
                effective,
                cohort,
                cache,
            )[0]
            for key in STEP_BY_KEY
        }

    current = signatures()
    monkeypatch.setitem(
        provenance_module.OUTPUT_SCHEMA, "aggregate", "structural:four-csv:v1"
    )
    earlier = signatures()

    assert {key for key in current if current[key] != earlier[key]} == {
        "aggregate",
        "final",
    }


def _write_recon(root: Path) -> None:
    _write_recon_backend(root, "freesurfer")


def _write_recon_backend(
    root: Path,
    backend: str,
    *,
    subject_id: str = "sub-001",
) -> None:
    subject = root / "derivatives" / backend / subject_id
    for alternatives in reconstruction_artifact_groups(backend):
        relative = alternatives[0]
        path = subject / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"complete")


def _current_recon_receipt(  # noqa: PLR0913
    root: Path,
    run_id: str,
    cfg: dict[str, Any],
    cohort: CohortSnapshot,
    *,
    upstream_signatures: list[str] | None = None,
    backend: str | None = None,
    device: str | None = None,
) -> dict[str, Any]:
    adapter = ADAPTERS["recon"]
    effective_cfg = runtime_cfg(cfg, cohort, run_id, str(root))
    runtime = effective_cfg["_supraspinaRuntime"]
    if backend is not None:
        runtime["resolvedReconBackend"] = backend
    if device is not None:
        runtime["resolvedFastSurferDevice"] = device
    tool_evidence = {
        check_id: {"status": "missing"}
        for check_id in adapter.required_check_ids(effective_cfg)
    }
    signature, payload = expected_signature(
        "recon",
        "sub-001",
        effective_cfg,
        cohort,
        adapter,
        upstream_signatures=upstream_signatures or [],
        tool_evidence=tool_evidence,
    )
    evidence = enrich_evidence(
        "recon",
        detector_evidence(adapter, effective_cfg, "sub-001"),
        effective_cfg,
        cohort,
    )
    return make_receipt(
        signature,
        payload,
        evidence,
        run_id=run_id,
        job_id="job-recon",
        committed_at_ms=1,
    )


def test_fastsurfer_inventory_uses_receipt_selected_tree_and_is_current(
    tmp_path: Path,
) -> None:
    _write_recon_backend(tmp_path, "fastsurfer")
    run_id = "run-33333335"
    cfg = _cfg(tmp_path)
    cfg["steps"]["recon"]["params"].update(
        {"backend": "fastsurfer", "fastsurferDevice": "cpu"}
    )
    cohort = _cohort(tmp_path, ("sub-001",))
    receipt = _current_recon_receipt(
        tmp_path,
        run_id,
        cfg,
        cohort,
        backend="fastsurfer",
        device="cpu",
    )
    state = _state(
        tmp_path,
        run_id,
        dry_run=False,
        node_status="done",
        receipts=[receipt],
        cfg=cfg,
        cohort=cohort,
    )
    state["planBinding"] = {
        "digest": "plan-digest",
        "configDigest": "config-digest",
        "qcDigest": "qc-digest",
        "registryDigest": "registry-digest",
        "environmentDigest": "environment-digest",
    }
    RunStore(str(tmp_path)).commit(state)
    inventory, project = _inventory(tmp_path)

    rows = _rows_for(inventory, project, run_id, "recon")

    assert rows
    assert {row["provenance"] for row in rows} == {"current"}
    assert all("derivatives/fastsurfer/sub-001" in row["displayPath"] for row in rows)
    assert all("derivatives/freesurfer/" not in row["displayPath"] for row in rows)
    details = rows[0]["provenanceDetails"]
    assert details["receipt"]["signature"] == receipt["signature"]
    assert details["receipt"]["signatureValid"] is True
    assert details["receipt"]["jobId"] == "job-recon"
    assert details["runBinding"] == {
        "planDigest": "plan-digest",
        "configDigest": "config-digest",
        "qcDigest": "qc-digest",
        "registryDigest": "registry-digest",
        "environmentDigest": "environment-digest",
    }
    assert (
        "recon"
        in inventory.list({"project": project, "runId": run_id, "limit": 1})[
            "producedStepKeys"
        ]
    )


def test_retained_receipt_resolves_producer_node_from_its_own_run(
    tmp_path: Path,
) -> None:
    _write_recon(tmp_path)
    producer_run_id = "run-33333340"
    inventory_run_id = "run-33333341"
    cfg = _cfg(tmp_path)
    cohort = _cohort(tmp_path, ("sub-001",))
    receipt = _current_recon_receipt(
        tmp_path,
        producer_run_id,
        cfg,
        cohort,
    )
    store = RunStore(str(tmp_path))
    store.commit(
        _state(
            tmp_path,
            producer_run_id,
            dry_run=False,
            node_status="done",
            receipts=[receipt],
            cfg=cfg,
            cohort=cohort,
        )
    )
    recovery = _state(
        tmp_path,
        inventory_run_id,
        dry_run=False,
        node_status="done",
        receipts=[receipt],
        cfg=cfg,
        cohort=cohort,
    )
    recovery["config"]["displayPreferences"] = {"resultsDensity": "compact"}
    recovery["configSha256"] = stable_digest(recovery["config"])
    recovery["jobs"] = []
    store.commit(recovery)
    inventory, project = _inventory(tmp_path)

    rows = _rows_for(inventory, project, inventory_run_id, "recon")

    assert rows
    assert {row["runId"] for row in rows} == {producer_run_id}
    assert {row["producerNodeId"] for row in rows} == {"recon:sub-001"}
    assert {row["provenanceDetails"]["receipt"]["jobId"] for row in rows} == {
        "job-recon"
    }

    directory = next(row for row in rows if row["kind"] == "dir")
    artifact_id = directory["artifactId"]
    original_display_path = directory["displayPath"]
    directory.update(
        {
            "label": "forged gallery",
            "stepKey": "final",
            "subjectId": None,
            "kind": "html",
            "presence": "expected",
            "displayPath": "forged/report.html",
            "runId": inventory_run_id,
            "producerNodeId": "forged:cohort",
            "receiptSha256": "0" * 64,
            "provenance": "stale",
            "configSha256": "0" * 64,
        }
    )

    resolved = inventory.resolve(
        {
            "project": project,
            "artifactId": artifact_id,
            "metadata": directory,
        }
    )

    assert resolved["metadata"] == {
        "artifactId": artifact_id,
        "label": "FreeSurfer subject dir",
        "stepKey": "recon",
        "subjectId": "sub-001",
        "kind": "dir",
        "presence": "produced",
        "displayPath": original_display_path,
        "runId": producer_run_id,
        "producerNodeId": "recon:sub-001",
        "receiptSha256": receipt["recordSha256"],
        "provenance": "current",
        "inventoryRunId": inventory_run_id,
        "configSha256": recovery["configSha256"],
    }
    assert resolved["metadata"]["configSha256"] != stable_digest(
        store.load(producer_run_id)["config"]
    )

    resolved["metadata"]["label"] = "mutated resolution"
    assert (
        inventory.resolve({"project": project, "artifactId": artifact_id})["metadata"][
            "label"
        ]
        == "FreeSurfer subject dir"
    )


def test_auto_inventory_uses_latest_fallback_attempt_for_entire_cohort(
    tmp_path: Path,
) -> None:
    for backend in ("freesurfer", "fastsurfer"):
        _write_recon_backend(tmp_path, backend)
    run_id = "run-33333336"
    cfg = _cfg(tmp_path)
    cfg["steps"]["recon"]["params"].update(
        {"backend": "auto", "fastsurferDevice": "auto"}
    )
    cohort = _cohort(tmp_path, ("sub-001",))
    receipt = _current_recon_receipt(
        tmp_path,
        run_id,
        cfg,
        cohort,
        backend="fastsurfer",
        device="cpu",
    )
    state = _state(
        tmp_path,
        run_id,
        dry_run=False,
        node_status="done",
        receipts=[receipt],
        cfg=cfg,
        cohort=cohort,
        scientific_evidence={
            "managedResources": {
                "fastsurfer": {"resource": "fastsurfer", "variant": "cpu"}
            }
        },
    )
    state["jobs"] = [
        {
            **state["jobs"][0],
            "id": "#primary",
            "backend": "freesurfer",
            "attemptOrdinal": 1,
            "role": "superseded-primary",
        },
        {
            **state["jobs"][0],
            "id": "job-recon",
            "backend": "fastsurfer",
            "attemptOrdinal": 2,
            "role": "fallback",
            "supersedesJobId": "#primary",
        },
    ]
    state["reconstructionFallback"] = {
        "state": "active",
        "fromBackend": "freesurfer",
        "toBackend": "fastsurfer",
        "subjectIds": ["sub-001"],
    }
    RunStore(str(tmp_path)).commit(state)
    inventory, project = _inventory(tmp_path)

    rows = _rows_for(inventory, project, run_id, "recon")

    assert rows
    assert {row["provenance"] for row in rows} == {"current"}
    assert all("derivatives/fastsurfer/sub-001" in row["displayPath"] for row in rows)
    assert all("derivatives/freesurfer/" not in row["displayPath"] for row in rows)


def test_auto_inventory_uses_self_valid_fastsurfer_receipt_without_job_metadata(
    tmp_path: Path,
) -> None:
    _write_recon_backend(tmp_path, "fastsurfer")
    run_id = "run-3333333b"
    cfg = _cfg(tmp_path)
    cfg["steps"]["recon"]["params"].update(
        {"backend": "auto", "fastsurferDevice": "auto"}
    )
    cohort = _cohort(tmp_path, ("sub-001",))
    receipt = _current_recon_receipt(
        tmp_path,
        run_id,
        cfg,
        cohort,
        backend="fastsurfer",
        device="cpu",
    )
    state = _state(
        tmp_path,
        run_id,
        dry_run=False,
        node_status="done",
        receipts=[receipt],
        cfg=cfg,
        cohort=cohort,
    )
    state["jobs"] = []
    RunStore(str(tmp_path)).commit(state)
    inventory, project = _inventory(tmp_path)

    rows = _rows_for(inventory, project, run_id, "recon")

    assert rows
    assert {row["provenance"] for row in rows} == {"current"}
    assert all("derivatives/fastsurfer/sub-001" in row["displayPath"] for row in rows)


def test_auto_inventory_uses_concrete_failed_job_without_a_receipt(
    tmp_path: Path,
) -> None:
    run_id = "run-33333337"
    cfg = _cfg(tmp_path)
    cfg["steps"]["recon"]["params"].update(
        {"backend": "auto", "fastsurferDevice": "auto"}
    )
    state = _state(
        tmp_path,
        run_id,
        dry_run=False,
        node_status="failed",
        cfg=cfg,
        scientific_evidence={
            "managedResources": {
                "fastsurfer": {"resource": "fastsurfer", "variant": "cpu"}
            }
        },
    )
    state["jobs"][0].update(
        {"backend": "fastsurfer", "attemptOrdinal": 2, "role": "fallback"}
    )
    RunStore(str(tmp_path)).commit(state)
    inventory, project = _inventory(tmp_path)

    rows = _rows_for(inventory, project, run_id, "recon")

    assert rows
    assert {row["presence"] for row in rows} == {"absent"}
    assert {row["provenance"] for row in rows} == {"unknown"}
    assert all("derivatives/fastsurfer/sub-001" in row["displayPath"] for row in rows)


def test_auto_inventory_fails_closed_for_conflicting_same_attempt_backends(
    tmp_path: Path,
) -> None:
    run_id = "run-33333338"
    cfg = _cfg(tmp_path)
    cfg["steps"]["recon"]["params"].update(
        {"backend": "auto", "fastsurferDevice": "cpu"}
    )
    cohort = _cohort(tmp_path, ("sub-001", "sub-002"))
    state = _state(
        tmp_path,
        run_id,
        dry_run=False,
        node_status="failed",
        cfg=cfg,
        cohort=cohort,
    )
    state["nodes"].append(
        {
            **state["nodes"][0],
            "nodeId": "recon:sub-002",
            "subjectId": "sub-002",
        }
    )
    state["jobs"] = [
        {
            **state["jobs"][0],
            "id": "#fs",
            "subjectId": "sub-001",
            "backend": "freesurfer",
            "attemptOrdinal": 1,
        },
        {
            **state["jobs"][0],
            "id": "#fast",
            "nodeId": "recon:sub-002",
            "subjectId": "sub-002",
            "backend": "fastsurfer",
            "attemptOrdinal": 1,
        },
    ]
    RunStore(str(tmp_path)).commit(state)
    inventory, project = _inventory(tmp_path)

    rows = _rows_for(inventory, project, run_id, "recon")

    assert rows == []


def test_auto_inventory_ignores_tampered_receipt_backend(tmp_path: Path) -> None:
    _write_recon_backend(tmp_path, "fastsurfer")
    run_id = "run-3333333a"
    cfg = _cfg(tmp_path)
    cfg["steps"]["recon"]["params"].update(
        {"backend": "auto", "fastsurferDevice": "cpu"}
    )
    cohort = _cohort(tmp_path, ("sub-001",))
    receipt = _current_recon_receipt(
        tmp_path,
        run_id,
        cfg,
        cohort,
        backend="fastsurfer",
        device="cpu",
    )
    receipt["reconstruction"]["provider"]["version"] = "tampered"
    state = _state(
        tmp_path,
        run_id,
        dry_run=False,
        node_status="done",
        receipts=[receipt],
        cfg=cfg,
        cohort=cohort,
    )
    state["jobs"] = []
    RunStore(str(tmp_path)).commit(state)
    inventory, project = _inventory(tmp_path)

    rows = _rows_for(inventory, project, run_id, "recon")

    assert rows == []


def test_produced_artifacts_transition_from_current_to_stale_provenance(
    tmp_path: Path,
) -> None:
    _write_recon(tmp_path)
    run_id = "run-33333333"
    cfg = _cfg(tmp_path)
    cohort = _cohort(tmp_path, ("sub-001",))
    receipt = _current_recon_receipt(tmp_path, run_id, cfg, cohort)
    store = RunStore(str(tmp_path))
    store.commit(
        _state(
            tmp_path,
            run_id,
            dry_run=False,
            node_status="done",
            receipts=[receipt],
            cfg=cfg,
            cohort=cohort,
        )
    )
    inventory, project = _inventory(tmp_path)
    current = _rows_for(inventory, project, run_id, "recon")
    assert current
    assert all(row["presence"] == "produced" for row in current)
    assert all(row["provenance"] == "current" for row in current)

    changed_cfg = _cfg(tmp_path)
    changed_cfg["steps"]["recon"]["params"]["directives"] = "-autorecon1"
    store.commit(
        _state(
            tmp_path,
            run_id,
            dry_run=False,
            node_status="done",
            receipts=[receipt],
            cfg=changed_cfg,
            cohort=cohort,
        )
    )
    stale = _rows_for(inventory, project, run_id, "recon")
    assert all(row["presence"] == "produced" for row in stale)
    assert all(row["provenance"] == "stale" for row in stale)


def test_recon_currentness_binds_brainfov_and_crop_review_signatures(
    tmp_path: Path,
) -> None:
    _write_recon(tmp_path)
    run_id = "run-33333334"
    cfg = _cfg(tmp_path)
    cfg["steps"]["brainfov"] = {
        "enabled": True,
        "params": {"marginMm": 30},
    }
    cohort = _cohort(tmp_path, ("sub-001",))
    brainfov = ADAPTERS["brainfov"]
    brainfov_signature, _payload = expected_signature(
        "brainfov",
        "sub-001",
        cfg,
        cohort,
        brainfov,
        upstream_signatures=[],
        tool_evidence={
            check_id: {"status": "missing"}
            for check_id in brainfov.required_check_ids(cfg)
        },
    )
    decision_signature = "a" * 64
    receipt = _current_recon_receipt(
        tmp_path,
        run_id,
        cfg,
        cohort,
        upstream_signatures=[brainfov_signature, decision_signature],
    )
    store = RunStore(str(tmp_path))
    state = _state(
        tmp_path,
        run_id,
        dry_run=False,
        node_status="done",
        receipts=[receipt],
        cfg=cfg,
        cohort=cohort,
        scientific_evidence={
            "inputFov": {
                "sub-001": {"decisionSignature": decision_signature},
            }
        },
    )
    store.commit(state)
    inventory, project = _inventory(tmp_path)

    current = _rows_for(inventory, project, run_id, "recon")
    assert current
    assert {row["provenance"] for row in current} == {"current"}

    state["scientificEvidence"]["inputFov"]["sub-001"]["decisionSignature"] = "b" * 64
    store.commit(state)
    stale = _rows_for(inventory, project, run_id, "recon")
    assert {row["provenance"] for row in stale} == {"stale"}


def test_only_issued_existing_artifacts_resolve_and_epoch_is_bound(
    tmp_path: Path,
) -> None:
    _write_recon(tmp_path)
    run_id = "run-44444444"
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=False, node_status="done")
    )
    inventory, project = _inventory(tmp_path)
    rows = _rows_for(inventory, project, run_id, "recon")
    directory = next(row for row in rows if row["kind"] == "dir")
    assert "artifactId" in directory
    resolved = inventory.resolve(
        {"project": project, "artifactId": directory["artifactId"]}
    )
    assert resolved["kind"] == "directory"
    assert resolved["exists"] is True
    assert resolved["path"].startswith(str(tmp_path.resolve()))
    assert resolved["metadata"]["artifactId"] == directory["artifactId"]
    assert resolved["metadata"]["inventoryRunId"] == run_id
    assert resolved["metadata"]["configSha256"] == stable_digest(_cfg(tmp_path))

    newer = _project(tmp_path, epoch=2)
    with pytest.raises(ValueError, match="known artifact identity"):
        inventory.resolve({"project": newer, "artifactId": directory["artifactId"]})
    with pytest.raises(ValueError, match="known artifact identity"):
        inventory.resolve({"project": newer, "artifactId": "artifact-forged"})


def test_first_page_ids_survive_scans_larger_than_the_issued_bound(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_recon(tmp_path)
    run_id = "run-66666666"
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=False, node_status="done")
    )
    inventory, project = _inventory(tmp_path)
    monkeypatch.setattr(results_module, "_MAX_ISSUED", 1)

    scan = inventory.list({"project": project, "runId": run_id, "limit": 500})
    cursor = next(index for index, row in enumerate(scan["items"]) if row["exists"])
    page = inventory.list(
        {"project": project, "runId": run_id, "limit": 1, "cursor": cursor}
    )

    assert len(page["items"]) == 1
    first = page["items"][0]
    assert first["exists"] is True
    resolved = inventory.resolve(
        {"project": project, "artifactId": first["artifactId"]}
    )
    assert resolved["exists"] is True
    assert len(inventory._issued) == 1


def test_repeated_full_listings_keep_earlier_issued_ids_resolvable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Each Results visit with the All filter must not issue fresh IDs for all
    # 1961 rows, or after about five visits the issued-ID FIFO evicts the
    # gallery IDs QC review still holds.
    total = 1961
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    paths = []
    for index in range(total):
        path = artifacts / f"artifact-{index:04d}.txt"
        path.write_bytes(b"artifact")
        paths.append(str(path))
    detector = results_module.detector_evidence

    def many_artifacts(
        adapter: Any, cfg: dict[str, Any], subject_id: str | None
    ) -> dict[str, Any]:
        if adapter is ADAPTERS["enigma"]:
            return {"state": "done", "artifacts": [{"path": path} for path in paths]}
        return detector(adapter, cfg, subject_id)

    monkeypatch.setattr(results_module, "detector_evidence", many_artifacts)
    monkeypatch.setattr(results_module, "_MAX_DETECTOR_ARTIFACTS", 4_096)
    run_id = "run-77777777"
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=False, node_status="done")
    )
    inventory, project = _inventory(tmp_path)
    # An identity issued outside the listing, as a QC gallery panel is.
    held = inventory.register_external(project["projectId"], project["epoch"], paths[0])

    def full_listing() -> dict[str, str]:
        issued: dict[str, str] = {}
        cursor: str | None = "0"
        while cursor is not None:
            page = inventory.list(
                {
                    "project": project,
                    "runId": run_id,
                    "stepKey": "enigma",
                    "limit": 500,
                    "cursor": cursor,
                }
            )
            issued.update(
                {
                    item["displayPath"]: item["artifactId"]
                    for item in page["items"]
                    if item["exists"]
                }
            )
            cursor = page["nextCursor"]
        return issued

    first = full_listing()
    assert len(first) == total
    for _visit in range(6):
        assert full_listing() == first

    assert results_module._MAX_ISSUED < 6 * total
    assert len(inventory._issued) == total + 1
    for artifact_id in (held, next(iter(first.values()))):
        resolved = inventory.resolve({"project": project, "artifactId": artifact_id})
        assert resolved["exists"] is True
    with pytest.raises(ValueError, match="known artifact identity"):
        inventory.resolve({"project": project, "artifactId": f"artifact-{'0' * 32}"})


def test_subject_expansion_and_result_page_are_bounded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(results_module, "_MAX_SUBJECTS", 2)
    run_id = "run-55555555"
    cohort = _cohort(tmp_path, ("sub-001", "sub-002", "sub-003"))
    state = _state(
        tmp_path,
        run_id,
        dry_run=True,
        node_status="done",
        cohort=cohort,
    )
    RunStore(str(tmp_path)).commit(state)
    inventory, project = _inventory(tmp_path)
    page = inventory.list(
        {"project": project, "runId": run_id, "limit": 3, "cursor": 0}
    )
    assert len(page["items"]) == 3
    assert page["nextCursor"] == "3"
    assert page["truncated"] is True
    all_rows = inventory.list({"project": project, "runId": run_id, "limit": 500})[
        "items"
    ]
    subject_ids = {row["subjectId"] for row in all_rows if row["subjectId"] is not None}
    assert subject_ids == {"sub-001", "sub-002"}


def _make_qc_gallery(out_dir: Path, subjects: tuple[str, ...]) -> None:
    """Write one complete wrapper-style subcortical gallery and its PNGs."""
    target = out_dir / "qc" / "subcortical" / "ENIGMA_Subcortical_QC.html"
    target.parent.mkdir(parents=True, exist_ok=True)
    tags: list[str] = []
    for subject in subjects:
        for panel in enigma_module.gallery_panels("subcortical", subject):
            for relative in (panel.montage_relative, panel.full_relative):
                image = target.parent / relative
                image.parent.mkdir(parents=True, exist_ok=True)
                image.write_bytes(_PNG_FIXTURE)
            tags.append(f'<img src="{panel.montage_relative}">')
            tags.append(f'<a href="{panel.full_relative}"></a>')
    target.write_text("<html><body>" + "".join(tags) + "</body></html>")


def test_qc_gallery_images_issue_one_identity_per_verified_image(
    tmp_path: Path,
) -> None:
    """Give each described panel a resolvable identity and its exact digest."""
    run_id = "run-33333333"
    subjects = ("sub-001", "sub-002")
    cohort = _cohort(tmp_path, subjects)
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=False, node_status="done", cohort=cohort)
    )
    _make_qc_gallery(tmp_path / "outputs" / "qc", subjects)
    inventory, project = _inventory(tmp_path)

    described = inventory.gallery_images(
        {
            "project": project,
            "runId": run_id,
            "tab": "subcortical",
            "subjectId": "sub-002",
        }
    )

    assert described["tab"] == "subcortical"
    assert described["subjectId"] == "sub-002"
    assert len(described["panels"]) == 12
    identities = set()
    for panel in described["panels"]:
        for role in ("montage", "full"):
            image = panel[role]
            identities.add(image["artifactId"])
            assert image["bytes"] == len(_PNG_FIXTURE)
            assert image["sha256"] == _PNG_DIGEST
            resolved = inventory.resolve(
                {"project": project, "artifactId": image["artifactId"]}
            )
            assert resolved["exists"] is True
            assert resolved["path"].endswith(Path(image["relativePath"]).name)
    assert len(identities) == 24


def test_qc_gallery_images_refuse_an_unverified_gallery(tmp_path: Path) -> None:
    run_id = "run-33333334"
    subjects = ("sub-001",)
    cohort = _cohort(tmp_path, subjects)
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=False, node_status="done", cohort=cohort)
    )
    out_dir = tmp_path / "outputs" / "qc"
    _make_qc_gallery(out_dir, subjects)
    broken = out_dir / "qc/subcortical/sub-001/Subcortical_set_Axial_20.png"
    broken.write_bytes(b"truncated")
    inventory, project = _inventory(tmp_path)

    with pytest.raises(ValueError, match="missing or invalid gallery image"):
        inventory.gallery_images(
            {
                "project": project,
                "runId": run_id,
                "tab": "subcortical",
                "subjectId": "sub-001",
            }
        )


def test_qc_gallery_images_reject_an_invalid_selector(tmp_path: Path) -> None:
    """Accept only the three protocol tabs and a real cohort subject."""
    run_id = "run-33333335"
    cohort = _cohort(tmp_path, ("sub-001",))
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=False, node_status="done", cohort=cohort)
    )
    _make_qc_gallery(tmp_path / "outputs" / "qc", ("sub-001",))
    inventory, project = _inventory(tmp_path)

    with pytest.raises(ValueError, match="valid QC gallery selector"):
        inventory.gallery_images(
            {
                "project": project,
                "runId": run_id,
                "tab": "coronal",
                "subjectId": "sub-001",
            }
        )
    with pytest.raises(ValueError, match="subject from this ENIGMA run cohort"):
        inventory.gallery_images(
            {
                "project": project,
                "runId": run_id,
                "tab": "subcortical",
                "subjectId": "sub-999",
            }
        )


def _listing_walk_count(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    subject_ids: tuple[str, ...],
) -> tuple[int, int, list[Any]]:
    """List one run and report flatten walks, resolve calls, and the configs."""
    run_id = "run-4444444" + str(len(subject_ids))
    RunStore(str(tmp_path)).commit(
        _state(
            tmp_path,
            run_id,
            dry_run=True,
            node_status="done",
            cohort=_cohort(tmp_path, subject_ids),
        )
    )
    inventory, project = _inventory(tmp_path)
    walked: list[int] = []
    original = paths_module._flatten_walk

    def counting(config: dict[str, Any], prefix: str) -> dict[str, str]:
        if not prefix and isinstance(config, paths_module.PreparedConfig):
            walked.append(id(config))
        return original(config, prefix)

    prepared: list[Any] = []
    original_runtime_cfg = results_module.runtime_cfg

    def recording(*args: Any, **kwargs: Any) -> Any:
        value = original_runtime_cfg(*args, **kwargs)
        prepared.append(value)
        return value

    resolves = 0
    original_resolve = base_module.Adapter.resolve

    def counting_resolve(self: Any, template: str, cfg: dict[str, Any]) -> str:
        nonlocal resolves
        resolves += 1
        return original_resolve(self, template, cfg)

    monkeypatch.setattr(paths_module, "_flatten_walk", counting)
    monkeypatch.setattr(results_module, "runtime_cfg", recording)
    monkeypatch.setattr(base_module.Adapter, "resolve", counting_resolve)
    inventory.list({"project": project, "runId": run_id, "limit": 50})
    assert len(walked) == len(set(walked))
    return len(walked), resolves, prepared


def test_listing_flattens_each_prepared_configuration_exactly_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Adapter.resolve flattens the configuration for every template it
    # resolves, and a run-scoped configuration carries one entry per subject.
    # One cached view must serve every resolution, so the walk count follows
    # the number of prepared configurations rather than the cohort size.
    small_walks, small_resolves, small_prepared = _listing_walk_count(
        tmp_path / "small", monkeypatch, ("sub-001",)
    )
    large_walks, large_resolves, large_prepared = _listing_walk_count(
        tmp_path / "large",
        monkeypatch,
        tuple(f"sub-{index:03d}" for index in range(1, 13)),
    )

    # At most one walk per prepared configuration, and the same count for a
    # twelve-subject cohort as for a single subject.
    assert small_walks <= len(small_prepared)
    assert large_walks <= len(large_prepared)
    assert small_walks == large_walks
    # The resolve count does grow with the cohort, which is exactly the
    # multiplier the cached view removes.
    assert large_resolves > small_resolves
    assert large_walks < large_resolves


def test_listing_keeps_the_flattened_view_true_after_the_backend_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The listing records the resolved reconstruction backend on the runtime
    # subtree. That write must reach the prepared configuration itself, or
    # every later resolution reads a flattened view the configuration has
    # already moved past.
    _walks, _resolves, prepared = _listing_walk_count(
        tmp_path, monkeypatch, ("sub-001",)
    )

    effective = prepared[0]
    assert paths_module.flatten(effective) == paths_module.flatten(dict(effective))
    runtime = effective["_supraspinaRuntime"]
    if "resolvedReconBackend" in runtime:
        assert (
            paths_module.flatten(effective)["_supraspinaRuntime.resolvedReconBackend"]
            == runtime["resolvedReconBackend"]
        )


def test_list_signs_with_the_resource_runtime_and_reviewed_inputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Sign receipts with the planner's private bindings when the app supplies them.

    The managed-resource runtime and each subject's reviewed Brain FOV input are
    not persisted in the run configuration, so without them every receipt that
    depends on the Brain FOV action read as stale right after its own run.
    """
    run_id = "run-55555555"
    state = _state(tmp_path, run_id, dry_run=False, node_status="done")
    state["config"]["steps"]["brainfov"] = {"enabled": True, "params": {}}
    RunStore(str(tmp_path)).commit(state)
    captured: list[Any] = []
    original = results_module.runtime_cfg

    def recording_runtime_cfg(*args: Any, **kwargs: Any) -> Any:
        captured.append(kwargs.get("inputs"))
        return original(*args, **kwargs)

    monkeypatch.setattr(results_module, "runtime_cfg", recording_runtime_cfg)
    monkeypatch.setattr(
        results_module,
        "resolve_runtime_resources",
        lambda cfg, context: SimpleNamespace(
            runtime={"synthStripSifPath": "/cache/synthstrip.sif"}
        ),
    )

    reviews = object()
    seen_reviews: list[Any] = []

    def fake_resolve(
        input_fov_reviews: Any,
        review_request: dict[str, Any],
        signature_cfg: dict[str, Any],
        t1_by_subject: dict[str, str],
    ) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
        seen_reviews.append((input_fov_reviews, review_request["configRevision"]))
        del signature_cfg
        return {
            subject_id: {"preparedT1Path": f"/prepared/{subject_id}.nii.gz"}
            for subject_id in t1_by_subject
        }, {}

    monkeypatch.setattr(results_module, "resolve_input_fov_subjects", fake_resolve)
    inventory = ResultInventory(ProjectEpochs(), input_fov_reviews=reviews)
    inventory.list(
        {
            "project": _project(tmp_path),
            "runId": run_id,
            "runtimeContext": {"userDataPath": str(tmp_path)},
        }
    )

    signing = captured[-1]
    assert signing is not None
    assert signing.resource_runtime == {"synthStripSifPath": "/cache/synthstrip.sif"}
    assert signing.prepared_bindings == {
        "sub-001": {"preparedT1Path": "/prepared/sub-001.nii.gz"}
    }
    assert seen_reviews == [(reviews, 0)]


def test_list_keeps_the_plain_signing_config_without_a_runtime_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = "run-55555556"
    RunStore(str(tmp_path)).commit(
        _state(tmp_path, run_id, dry_run=False, node_status="done")
    )
    captured: list[Any] = []
    original = results_module.runtime_cfg

    def recording_runtime_cfg(*args: Any, **kwargs: Any) -> Any:
        captured.append(kwargs.get("inputs"))
        return original(*args, **kwargs)

    monkeypatch.setattr(results_module, "runtime_cfg", recording_runtime_cfg)
    inventory, project = _inventory(tmp_path)
    inventory.list({"project": project, "runId": run_id})
    assert captured[-1] is not None
    assert captured[-1].resource_runtime is None
    assert captured[-1].prepared_bindings is None


def test_list_reports_why_a_reviewed_input_could_not_be_rebound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = "run-55555557"
    state = _state(tmp_path, run_id, dry_run=False, node_status="done")
    state["config"]["steps"]["brainfov"] = {"enabled": True, "params": {}}
    RunStore(str(tmp_path)).commit(state)
    monkeypatch.setattr(
        results_module,
        "resolve_input_fov_subjects",
        lambda *args: (
            {},
            {subject: "Review the crop for this subject first." for subject in args[3]},
        ),
    )
    inventory = ResultInventory(ProjectEpochs(), input_fov_reviews=object())
    page = inventory.list(
        {
            "project": _project(tmp_path),
            "runId": run_id,
            "runtimeContext": {"userDataPath": str(tmp_path)},
        }
    )
    assert page["signingNotes"] == {
        "sub-001": "Review the crop for this subject first."
    }


def test_list_resolves_the_reviewed_inputs_once_per_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = "run-55555558"
    state = _state(tmp_path, run_id, dry_run=False, node_status="done")
    state["config"]["steps"]["brainfov"] = {"enabled": True, "params": {}}
    RunStore(str(tmp_path)).commit(state)
    calls: list[str] = []

    def counting(*args: Any) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
        calls.extend(sorted(args[3]))
        return {
            subject: {"preparedT1Path": f"/prepared/{subject}.nii.gz"}
            for subject in args[3]
        }, {}

    monkeypatch.setattr(results_module, "resolve_input_fov_subjects", counting)
    inventory = ResultInventory(ProjectEpochs(), input_fov_reviews=object())
    request = {
        "project": _project(tmp_path),
        "runId": run_id,
        "runtimeContext": {"userDataPath": str(tmp_path)},
    }
    inventory.list(request)
    inventory.list(request)
    assert calls == ["sub-001"]


def test_inventory_signs_projection_inputs_like_the_launcher() -> None:
    """Match the launcher's clinical binding so a finished run verifies."""
    payload = {
        "stepKey": "clinical",
        "externalInputs": {
            "clinicalMetadata": {"exists": True, "sha256": "a" * 64},
            "subjectRegistry": {"exists": True, "sha256": "b" * 64},
        },
    }
    shared = bind_projection_inputs("clinical", "sig", payload)
    launcher = WorkflowManager._bind_projection_inputs("clinical", "sig", payload)
    assert shared == launcher
    assert shared[1]["externalInputs"]["runScopedProjectionBinding"]["kind"] == (
        "metadata-projection-input-binding-v1"
    )
    assert bind_projection_inputs("recon", "sig", payload) == ("sig", payload)


def _stage_currency(
    inventory: ResultInventory, project: dict[str, Any], run_id: str
) -> dict[str, Any]:
    return inventory.list({"project": project, "runId": run_id, "limit": 1})[
        "stageCurrency"
    ]


def test_stage_currency_matches_a_published_receipt_the_run_did_not_record(
    tmp_path: Path,
) -> None:
    # The planner reuses any published receipt, so a stage run that recorded
    # only its own receipt must not leave earlier stages without a verdict.
    _write_recon(tmp_path)
    cfg = _cfg(tmp_path)
    cohort = _cohort(tmp_path, ("sub-001",))
    store = RunStore(str(tmp_path))
    store.put_receipt(_current_recon_receipt(tmp_path, "run-44444440", cfg, cohort))
    run_id = "run-44444441"
    store.commit(
        _state(
            tmp_path,
            run_id,
            dry_run=False,
            node_status="done",
            cfg=cfg,
            cohort=cohort,
        )
    )
    inventory, project = _inventory(tmp_path)

    currency = _stage_currency(inventory, project, run_id)

    assert currency["recon"] == {"state": "current", "outdatedSubjectIds": []}
    # Rows keep describing the inspected run's own receipts.
    assert {
        row["provenance"] for row in _rows_for(inventory, project, run_id, "recon")
    } == {"unknown"}

    changed = _cfg(tmp_path)
    changed["steps"]["recon"]["params"]["directives"] = "-autorecon1"
    store.commit(
        _state(
            tmp_path,
            run_id,
            dry_run=False,
            node_status="done",
            cfg=changed,
            cohort=cohort,
        )
    )

    assert _stage_currency(inventory, project, run_id)["recon"] == {
        "state": "outdated",
        "outdatedSubjectIds": ["sub-001"],
    }


def test_stage_currency_leaves_out_stages_the_configuration_disables(
    tmp_path: Path,
) -> None:
    # The planner skips a disabled stage rather than running it again. Judged
    # anyway, a stage that never ran has no receipt and read out of date for
    # every subject, which no screen may count.
    _write_recon(tmp_path)
    cfg = _cfg(tmp_path)
    cfg["steps"]["final"]["enabled"] = False
    cohort = _cohort(tmp_path, ("sub-001",))
    store = RunStore(str(tmp_path))
    store.put_receipt(_current_recon_receipt(tmp_path, "run-44444450", cfg, cohort))
    run_id = "run-44444451"
    store.commit(
        _state(
            tmp_path,
            run_id,
            dry_run=False,
            node_status="done",
            cfg=cfg,
            cohort=cohort,
        )
    )
    inventory, project = _inventory(tmp_path)

    currency = _stage_currency(inventory, project, run_id)

    # Optional defacing is off in the lab configuration; Brain FOV preparation
    # is off by omission; Final report is a disabled cohort stage.
    assert not {"brainfov", "deface", "final"} & currency.keys()
    assert currency["recon"] == {"state": "current", "outdatedSubjectIds": []}
    # An enabled stage without a receipt still reads out of date.
    assert currency["enigma"] == {"state": "outdated", "outdatedSubjectIds": []}
    # The disabled stages keep their expected-artifact rows.
    assert {
        row["presence"] for row in _rows_for(inventory, project, run_id, "deface")
    } == {"expected"}

    enabled = _cfg(tmp_path)
    enabled["steps"]["deface"]["enabled"] = True
    store.commit(
        _state(
            tmp_path,
            run_id,
            dry_run=False,
            node_status="done",
            cfg=enabled,
            cohort=cohort,
        )
    )

    # Enabled, defacing never ran, so the planner would run it.
    assert _stage_currency(inventory, project, run_id)["deface"] == {
        "state": "outdated",
        "outdatedSubjectIds": ["sub-001"],
    }


def test_stage_currency_marks_a_cohort_stage_with_changed_outputs_outdated(
    tmp_path: Path,
) -> None:
    analysis_dir = tmp_path / "outputs" / "analysis"
    analysis_dir.mkdir(parents=True)
    for basename in OUTPUT_BASENAMES:
        (analysis_dir / basename).write_text("data")
    files = [
        {
            "name": basename,
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        for basename in OUTPUT_BASENAMES
        for payload in [(analysis_dir / basename).read_bytes()]
    ]
    (analysis_dir / MANIFEST_BASENAME).write_text(
        json.dumps({"schemaVersion": 1, "files": files}), encoding="utf-8"
    )
    cfg = _cfg(tmp_path)
    cohort = _cohort(tmp_path, ("sub-001",))
    store = RunStore(str(tmp_path))
    store.put_receipt(
        _current_cohort_receipt(tmp_path, "run-44444442", cfg, cohort, "brainpad")
    )
    run_id = "run-44444443"
    store.commit(
        _state(
            tmp_path,
            run_id,
            dry_run=False,
            node_status="done",
            cfg=cfg,
            cohort=cohort,
        )
    )
    inventory, project = _inventory(tmp_path)

    assert _stage_currency(inventory, project, run_id)["brainpad"] == {
        "state": "current",
        "outdatedSubjectIds": [],
    }

    (analysis_dir / "ChronologicalAge_Comparison.csv").write_text("")

    currency = _stage_currency(inventory, project, run_id)
    assert currency["brainpad"] == {"state": "outdated", "outdatedSubjectIds": []}
    # A stage with no receipt anywhere would run again as well.
    assert currency["final"]["state"] == "outdated"


def test_inventory_judges_recorded_asset_checks_live(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from supraspina_sidecar import provenance  # noqa: PLC0415
    from supraspina_sidecar.env.base import Check  # noqa: PLC0415
    from supraspina_sidecar.env.repo import BundledAssetsProbe  # noqa: PLC0415

    root = tmp_path / "generations" / "b" / "resources"
    detail = f"Use the integrity-verified ENIGMA QC assets in {root / 'enigma'}."
    monkeypatch.setattr(provenance, "_active_resource_roots", lambda: (str(root),))
    monkeypatch.setattr(
        BundledAssetsProbe,
        "checks",
        lambda _self, _cfg: [
            Check(id="enigma_assets", label="ENIGMA", status="found", detail=detail),
            Check(id="final_assets", label="Final", status="found", detail="Use 1."),
        ],
    )
    recorded = {
        # Recorded against another generation.
        "enigma_assets": {"status": "found", "identitySha256": "a" * 64},
        "mcr": {"status": "found", "identitySha256": "b" * 64},
    }

    environment = results_module._inventory_environment(recorded, _cfg(tmp_path))

    assert environment["enigma_assets"] == provenance.environment_check_evidence(
        {"status": "found", "detail": detail}, (str(root),)
    )
    assert environment["mcr"] == recorded["mcr"]
    assert "final_assets" not in environment
    assert results_module._inventory_environment({}, _cfg(tmp_path)) == {}


#: Every cohort-scope stage, in registry order.
_COHORT_STEPS = tuple(key for key, scope in STEP_SCOPES.items() if scope == "cohort")


def _gallery_review_evidence() -> dict[str, Any]:
    """Return canonical gallery-review evidence for one recorded QC verdict."""
    return {
        "evidenceVersion": 1,
        "reviewer": "os-user:reviewer",
        "reviewedAt": "2026-09-24T12:00:00.000Z",
        "galleries": [
            {
                "tab": tab,
                "label": label,
                "displayPath": f"outputs/qc/{tab}/report.html",
                "runId": "run-8407b948c62b",
                "receiptSha256": "a" * 64,
                "openedAt": "2026-09-24T12:00:00.000Z",
            }
            for tab, label in (
                ("subcortical", "Subcortical QC gallery"),
                ("internal", "Cortical-internal QC gallery"),
                ("external", "Cortical-external QC gallery"),
            )
        ],
    }


def _write_qc_verdicts(root: Path, verdicts: dict[str, str], *, note: str = "") -> None:
    """Record QC verdicts in the project store the planner reads."""
    path = root / ".supraspina" / "qc_verdicts.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "verdicts": {
                    subject_id: {
                        "verdict": verdict,
                        "note": note,
                        "tags": [],
                        "reviewEvidence": _gallery_review_evidence(),
                        "revision": 1,
                        "updatedAt": "2026-09-24T12:00:00.000Z",
                    }
                    for subject_id, verdict in verdicts.items()
                },
            }
        ),
        encoding="utf-8",
    )


def _write_t1s(root: Path, subjects: tuple[str, ...]) -> None:
    for subject in subjects:
        path = root / "rawdata" / subject / "anat" / f"{subject}_T1w.nii.gz"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(subject.encode())


def _planned_cohort(cfg: dict[str, Any]) -> CohortSnapshot:
    """Plan the cohort as Run all does: acknowledge pending QC only when asked."""
    try:
        return build_cohort_snapshot(cfg)
    except CohortError:
        return build_cohort_snapshot(cfg, acknowledge_qc_pending=True)


def _commit_planned_run(
    root: Path,
    run_id: str,
    cfg: dict[str, Any],
    cohort: CohortSnapshot,
    receipts: list[dict[str, Any]],
) -> None:
    state = _state(
        root,
        run_id,
        dry_run=False,
        node_status="done",
        cfg=cfg,
        cohort=cohort,
        receipts=receipts,
    )
    # The planner binds the digest of the QC store it planned with.
    state["planBinding"] = {"qcDigest": stable_digest(load_qc_records(cfg))}
    RunStore(str(root)).commit(state)


def _done_evidence(
    _adapter: Any, _cfg: dict[str, Any], _subject_id: str | None
) -> dict[str, Any]:
    return {"state": "done", "detail": "Verified.", "artifacts": []}


def _cohort_stage_run(  # noqa: PLR0913
    root: Path,
    monkeypatch: pytest.MonkeyPatch,
    subjects: tuple[str, ...],
    *,
    run_verdicts: dict[str, str] | None = None,
    run_id: str = "run-66666660",
    publish: bool = False,
) -> str:
    """Commit a run whose recon and cohort stages are current as planned.

    Stand in for every detector with verified evidence, so the fixture
    isolates what the analysis cohort binds. With ``publish``, also publish
    its receipts to the project store, as a finished run does.
    """
    monkeypatch.setattr(results_module, "detector_evidence", _done_evidence)
    monkeypatch.setattr(
        results_module,
        "enrich_evidence",
        lambda _step_key, evidence, _cfg, _cohort: evidence,
    )
    _write_t1s(root, subjects)
    if run_verdicts is not None:
        _write_qc_verdicts(root, run_verdicts)
    cfg = _cfg(root)
    cohort = _planned_cohort(cfg)
    effective_cfg = runtime_cfg(cfg, cohort, run_id, str(root))
    cache: dict[tuple[str, str | None], tuple[str, dict[str, Any]]] = {}
    receipts = []
    for step_key in ("recon", *_COHORT_STEPS):
        subject_ids: tuple[str | None, ...] = (
            cohort.analysis_subject_ids if step_key == "recon" else (None,)
        )
        for subject_id in subject_ids:
            signature, payload = _signature_for_step(
                step_key, subject_id, effective_cfg, cohort, cache
            )
            receipts.append(
                make_receipt(
                    signature,
                    payload,
                    _done_evidence(None, effective_cfg, subject_id),
                    run_id=run_id,
                    job_id=f"job-{step_key}-{subject_id or 'cohort'}",
                    committed_at_ms=2,
                )
            )
    _commit_planned_run(root, run_id, cfg, cohort, receipts)
    if publish:
        store = RunStore(str(root))
        for receipt in receipts:
            store.put_receipt(receipt)
    return run_id


def _subject_stages(currency: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value for key, value in currency.items() if STEP_SCOPES[key] == "subject"
    }


def test_stage_currency_keeps_cohort_stages_current_while_qc_is_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Like the lab runs planned with an empty store: every row unreviewed and
    # the acknowledgement given. Right after such a run nothing is stale.
    run_id = _cohort_stage_run(tmp_path, monkeypatch, ("sub-001", "sub-002"))
    assert RunStore(str(tmp_path)).load(run_id)["scope"]["qcAcknowledged"] is True
    inventory, project = _inventory(tmp_path)

    def assert_current() -> None:
        page = inventory.list({"project": project, "runId": run_id, "limit": 1})
        currency = page["stageCurrency"]
        for step_key in _COHORT_STEPS:
            assert currency[step_key] == {
                "state": "current",
                "outdatedSubjectIds": [],
            }, step_key
        assert currency["recon"]["state"] == "current"
        assert page["analysisCohortChange"] is None

    assert_current()
    # A verdict outside the run's cohort changes the store, not this cohort.
    _write_qc_verdicts(tmp_path, {"sub-999": "pass"})
    assert_current()


def test_stage_currency_keeps_cohort_stages_current_after_pass_and_defer_verdicts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = _cohort_stage_run(tmp_path, monkeypatch, ("sub-001", "sub-002"))
    inventory, project = _inventory(tmp_path)
    before = _stage_currency(inventory, project, run_id)

    # Pass and Defer keep the analysis subjects, and no cohort stage reads
    # verdicts, so Run all reuses every cohort stage.
    _write_qc_verdicts(tmp_path, {"sub-001": "pass", "sub-002": "defer"})
    page = inventory.list({"project": project, "runId": run_id, "limit": 1})

    currency = page["stageCurrency"]
    for step_key in _COHORT_STEPS:
        assert currency[step_key] == {
            "state": "current",
            "outdatedSubjectIds": [],
        }, step_key
    assert page["analysisCohortChange"] is None
    assert currency == before
    assert currency["recon"] == {"state": "current", "outdatedSubjectIds": []}
    enigma_rows = _rows_for(inventory, project, run_id, "enigma")
    assert any(row["kind"] == "html" for row in enigma_rows)
    assert {row["provenance"] for row in enigma_rows} == {"current"}


class _Emitter:
    def emit(self, method: str, params: dict[str, Any]) -> None:
        del method, params


def _planner_reuse(
    root: Path,
    monkeypatch: pytest.MonkeyPatch,
    cfg: dict[str, Any] | None = None,
    *,
    subject_steps: tuple[str, ...] = (),
    detector: Callable[[Any, dict[str, Any], str | None], dict[str, Any]] = (
        _done_evidence
    ),
) -> dict[str, Any]:
    """Return the run whose receipt Run all would reuse for each cohort stage.

    Plan with ``cfg``, the saved configuration, when given. Also name the run
    reused for each analysis subject's node of every stage in
    ``subject_steps``, keyed ``<stage>:<subject>``. Detect with ``detector``.
    """
    monkeypatch.setattr(runtime_module, "detector_evidence", detector)
    monkeypatch.setattr(
        runtime_module, "edge_evidence", lambda *_args: _done_evidence(None, {}, None)
    )
    monkeypatch.setattr(
        runtime_module, "enrich_evidence", lambda _key, value, *_args: value
    )
    cfg = cfg or _cfg(root)
    cohort = _planned_cohort(cfg)
    identity = ProjectIdentity(
        "results", str(root), str(root / "supraspina.project.json"), 1
    )
    run_id = "run-77777777"
    ctx = _RunContext(
        state={
            "runId": run_id,
            "project": identity.to_dict(),
            "config": cfg,
            "scope": cohort.to_dict(),
            "intent": {"kind": "workflow"},
            "nodes": [],
            "jobs": [],
            "receipts": [],
            "warnings": [],
            "environmentEvidence": {},
            "status": "queued",
            "dryRun": False,
        },
        cfg=cfg,
        effective_cfg=runtime_cfg(cfg, cohort, run_id, str(root)),
        cohort=cohort,
        project=identity,
        store=RunStore(str(root)),
        queue_limit=1,
    )
    manager = WorkflowManager(_Emitter())
    try:
        with manager._planning_pass(ctx):
            receipts = {
                key: manager._current_receipt(ctx, {"stepKey": key, "subjectId": None})
                for key in _COHORT_STEPS
            }
            receipts |= {
                f"{step_key}:{subject_id}": manager._current_receipt(
                    ctx, {"stepKey": step_key, "subjectId": subject_id}
                )
                for step_key in subject_steps
                for subject_id in cohort.analysis_subject_ids
            }
    finally:
        manager.shutdown()
    return {key: (item or {}).get("runId") for key, item in receipts.items()}


def _receipt_files(root: Path) -> dict[str, bytes]:
    receipts = root / ".supraspina" / "receipts"
    return {
        str(path.relative_to(receipts)): path.read_bytes()
        for path in sorted(receipts.rglob("*"))
        if path.is_file()
    }


def test_stage_currency_names_a_membership_change_after_a_qc_fail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = _cohort_stage_run(tmp_path, monkeypatch, ("sub-001", "sub-002"))
    inventory, project = _inventory(tmp_path)

    _write_qc_verdicts(tmp_path, {"sub-001": "pass", "sub-002": "fail"})
    page = inventory.list({"project": project, "runId": run_id, "limit": 1})

    assert page["analysisCohortChange"] == {
        "cause": "membership",
        "reasons": [{"kind": "qc-exclusion", "subjectIds": ["sub-002"], "count": 1}],
    }
    for step_key in _COHORT_STEPS:
        assert page["stageCurrency"][step_key] == {
            "state": "outdated",
            "outdatedSubjectIds": [],
            "cause": "analysis-cohort",
        }, step_key
    assert page["stageCurrency"]["recon"]["state"] == "current"


def test_stage_currency_judges_a_reverted_qc_fail_by_its_rediscovered_t1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = _cohort_stage_run(
        tmp_path,
        monkeypatch,
        ("sub-001", "sub-002"),
        run_verdicts={"sub-001": "pass", "sub-002": "fail"},
        publish=True,
    )
    inventory, project = _inventory(tmp_path)
    assert _stage_currency(inventory, project, run_id)["enigma"]["state"] == ("current")

    # The run recorded no T1 row for the QC Fail subject; rediscovery finds
    # it, so the rejoined cohort is judged like any other.
    _write_qc_verdicts(tmp_path, {"sub-001": "pass", "sub-002": "pass"})
    page = inventory.list({"project": project, "runId": run_id, "limit": 1})
    assert page["analysisCohortChange"] == {
        "cause": "membership",
        "reasons": [{"kind": "qc-exclusion", "subjectIds": ["sub-002"], "count": 1}],
    }
    for step_key in _COHORT_STEPS:
        assert page["stageCurrency"][step_key] == {
            "state": "outdated",
            "outdatedSubjectIds": [],
            "cause": "analysis-cohort",
        }, step_key
    assert page["stageCurrency"]["recon"]["state"] == "current"
    assert set(_planner_reuse(tmp_path, monkeypatch).values()) == {None}


def test_stage_currency_is_unknown_when_run_all_cannot_plan_the_cohort(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = _cohort_stage_run(tmp_path, monkeypatch, ("sub-001", "sub-002"))
    inventory, project = _inventory(tmp_path)

    # A second T1 makes the subject ambiguous, and Run all refuses to plan.
    extra = tmp_path / "rawdata" / "sub-002" / "anat" / "sub-002_run-2_T1w.nii.gz"
    extra.write_bytes(b"second T1")
    with pytest.raises(CohortError):
        build_cohort_snapshot(_cfg(tmp_path), acknowledge_qc_pending=True)
    page = inventory.list({"project": project, "runId": run_id, "limit": 1})
    assert page["analysisCohortChange"] is None
    assert {page["stageCurrency"][key]["state"] for key in _COHORT_STEPS} == {"unknown"}
    extra.rename(extra.with_name("ignored.txt"))

    # An unreadable store leaves the planner nothing to plan with either.
    (tmp_path / ".supraspina" / "qc_verdicts.json").write_text("{", encoding="utf-8")
    page = inventory.list({"project": project, "runId": run_id, "limit": 1})
    assert page["analysisCohortChange"] is None
    assert {page["stageCurrency"][key]["state"] for key in _COHORT_STEPS} == {"unknown"}


def test_live_analysis_cohort_matches_the_cohort_run_all_would_plan(
    tmp_path: Path,
) -> None:
    subjects = ("sub-001", "sub-002", "sub-003")
    _write_t1s(tmp_path, subjects)
    cfg = _cfg(tmp_path)
    recorded = _planned_cohort(cfg)
    state = {
        "config": cfg,
        "planBinding": {"qcDigest": stable_digest(load_qc_records(cfg))},
    }

    for verdicts in (
        {"sub-001": "pass", "sub-002": "defer"},
        {"sub-001": "pass", "sub-002": "pass", "sub-003": "pass"},
    ):
        # The membership is unchanged, so the run's cohort stands.
        _write_qc_verdicts(tmp_path, verdicts)
        live = results_module._live_analysis_cohort(state, recorded, str(tmp_path))
        assert live.snapshot is None, verdicts
        assert live.change is None, verdicts
        assert not live.unknown

    _write_qc_verdicts(
        tmp_path, {"sub-001": "pass", "sub-002": "fail", "sub-003": "defer"}
    )
    live = results_module._live_analysis_cohort(state, recorded, str(tmp_path))
    assert live.snapshot == _planned_cohort(cfg)
    assert live.change == "membership"


_MEMBERS = ("sub-001", "sub-002", "sub-003")


def _save_project(root: Path, cfg: dict[str, Any]) -> None:
    """Save the configuration where the main process keeps the project file."""
    (root / "supraspina.project.json").write_text(json.dumps(cfg), encoding="utf-8")


def _exclude_in_saved_configuration(root: Path) -> dict[str, Any]:
    cfg = _cfg(root)
    cfg["subjects"] = {"include": [], "exclude": ["sub-003"]}
    _save_project(root, cfg)
    return cfg


def _replace_a_t1(root: Path) -> dict[str, Any]:
    path = root / "rawdata" / "sub-003" / "anat" / "sub-003_T1w.nii.gz"
    path.write_bytes(b"replaced T1 bytes")
    return _cfg(root)


def _add_a_subject(root: Path) -> dict[str, Any]:
    _write_t1s(root, ("sub-004",))
    return _cfg(root)


def _remove_a_subject(root: Path) -> dict[str, Any]:
    subject = root / "rawdata" / "sub-002"
    subject.rename(subject.with_name("withdrawn-sub-002"))
    return _cfg(root)


#: Each membership change, the subjects its reason names, and the subject
#: whose reconstruction Run all no longer reuses, if any.
_MEMBERSHIP_CHANGES = {
    "config-exclusion": (_exclude_in_saved_configuration, ["sub-003"], None),
    "t1-changed": (_replace_a_t1, ["sub-003"], "sub-003"),
    "subjects-added": (_add_a_subject, ["sub-004"], "sub-004"),
    "subjects-removed": (_remove_a_subject, ["sub-002"], None),
}


@pytest.mark.parametrize("kind", list(_MEMBERSHIP_CHANGES))
def test_stage_currency_reads_a_cohort_change_the_planner_reruns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    run_id = _cohort_stage_run(tmp_path, monkeypatch, _MEMBERS, publish=True)
    _save_project(tmp_path, _cfg(tmp_path))
    inventory, project = _inventory(tmp_path)
    before = inventory.list({"project": project, "limit": 1})
    assert before["analysisCohortChange"] is None
    assert {before["stageCurrency"][key]["state"] for key in _COHORT_STEPS} == {
        "current"
    }
    assert _planner_reuse(tmp_path, monkeypatch) == dict.fromkeys(_COHORT_STEPS, run_id)

    change, subject_ids, rerun_recon = _MEMBERSHIP_CHANGES[kind]
    saved = change(tmp_path)
    # Read the newest run, as the Runs cards, Dashboard, and Subjects do.
    page = inventory.list({"project": project, "limit": 1})

    assert page["runId"] == run_id
    assert page["analysisCohortChange"] == {
        "cause": "membership",
        "reasons": [
            {"kind": kind, "subjectIds": subject_ids, "count": len(subject_ids)}
        ],
    }
    for step_key in _COHORT_STEPS:
        assert page["stageCurrency"][step_key] == {
            "state": "outdated",
            "outdatedSubjectIds": [],
            "cause": "analysis-cohort",
        }, step_key
    # Run all plans the saved configuration and reruns every cohort stage.
    reuse = _planner_reuse(tmp_path, monkeypatch, saved, subject_steps=("recon",))
    assert {reuse[key] for key in _COHORT_STEPS} == {None}
    reconstructions = {
        key.removeprefix("recon:"): value
        for key, value in reuse.items()
        if key.startswith("recon:")
    }
    assert {
        subject_id for subject_id, value in reconstructions.items() if value is None
    } == ({rerun_recon} if rerun_recon else set())
    # A replaced T1 also reruns that subject's reconstruction, and the card
    # says so; an added subject has no reconstruction in the run to judge.
    recon = page["stageCurrency"]["recon"]
    if kind == "t1-changed":
        assert recon == {"state": "outdated", "outdatedSubjectIds": ["sub-003"]}
    else:
        assert recon == {"state": "current", "outdatedSubjectIds": []}


def test_stage_currency_names_every_change_of_one_cohort(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _cohort_stage_run(tmp_path, monkeypatch, _MEMBERS, publish=True)
    inventory, project = _inventory(tmp_path)

    _replace_a_t1(tmp_path)
    _add_a_subject(tmp_path)
    _write_qc_verdicts(tmp_path, {"sub-001": "fail"})
    page = inventory.list({"project": project, "limit": 1})

    assert page["analysisCohortChange"] == {
        "cause": "membership",
        "reasons": [
            {"kind": "subjects-added", "subjectIds": ["sub-004"], "count": 1},
            {"kind": "t1-changed", "subjectIds": ["sub-003"], "count": 1},
            {"kind": "qc-exclusion", "subjectIds": ["sub-001"], "count": 1},
        ],
    }


def test_stage_currency_reads_an_unchanged_cohort_current_without_hashing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = _cohort_stage_run(tmp_path, monkeypatch, _MEMBERS, publish=True)
    _save_project(tmp_path, _cfg(tmp_path))
    _write_qc_verdicts(tmp_path, {"sub-001": "pass", "sub-002": "defer"})
    hashed: list[str] = []
    real_hash = cohort_module._hash_file

    def counting_hash(path: str) -> str:
        hashed.append(Path(path).name)
        return real_hash(path)

    monkeypatch.setattr(cohort_module, "_hash_file", counting_hash)
    inventory, project = _inventory(tmp_path)

    # Planning the run hashed every T1, so no read hashes one again.
    for _ in range(2):
        page = inventory.list({"project": project, "limit": 1})
        assert page["analysisCohortChange"] is None
        for step_key in (*_COHORT_STEPS, "recon"):
            assert page["stageCurrency"][step_key] == {
                "state": "current",
                "outdatedSubjectIds": [],
            }, step_key
    assert hashed == []
    # Planning always reads every T1, and it reuses every cohort stage too.
    assert _planner_reuse(tmp_path, monkeypatch) == dict.fromkeys(_COHORT_STEPS, run_id)
    assert set(hashed) == {f"{subject}_T1w.nii.gz" for subject in _MEMBERS}

    # Without a remembered digest, a read hashes each T1 once and then none.
    monkeypatch.setattr(cohort_module, "_REMEMBERED_FINGERPRINTS", OrderedDict())
    hashed.clear()
    inventory.list({"project": project, "limit": 1})
    assert sorted(hashed) == [f"{subject}_T1w.nii.gz" for subject in _MEMBERS]
    hashed.clear()
    inventory.list({"project": project, "limit": 1})
    assert hashed == []

    # A replaced T1 is the only file read again.
    _replace_a_t1(tmp_path)
    inventory.list({"project": project, "limit": 1})
    assert hashed == ["sub-003_T1w.nii.gz"]


def test_stage_currency_follows_the_run_configuration_without_a_saved_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = _cohort_stage_run(tmp_path, monkeypatch, _MEMBERS)
    inventory, project = _inventory(tmp_path)
    (tmp_path / "supraspina.project.json").write_text("{", encoding="utf-8")

    page = inventory.list({"project": project, "runId": run_id, "limit": 1})

    assert page["analysisCohortChange"] is None
    assert {page["stageCurrency"][key]["state"] for key in _COHORT_STEPS} == {"current"}


def _write_pass_through_t1(path: Path, fill: int) -> None:
    """Write an 8 mm NIfTI-1 T1 that Brain FOV passes through uncropped."""
    header = bytearray(352)
    struct.pack_into("<i", header, 0, 348)
    struct.pack_into("<8h", header, 40, 3, 8, 8, 8, 1, 1, 1, 1)
    struct.pack_into("<h", header, 70, 2)
    struct.pack_into("<h", header, 72, 8)
    struct.pack_into("<8f", header, 76, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0)
    struct.pack_into("<f", header, 108, 352.0)
    struct.pack_into("<h", header, 254, 1)
    struct.pack_into("<4f", header, 280, 1.0, 0.0, 0.0, -4.0)
    struct.pack_into("<4f", header, 296, 0.0, 1.0, 0.0, -4.0)
    struct.pack_into("<4f", header, 312, 0.0, 0.0, 1.0, -4.0)
    header[344:348] = b"n+1\x00"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(bytes(header) + bytes([fill]) * 512, mtime=0))


def _brainfov_evidence(
    adapter: Any, cfg: dict[str, Any], subject_id: str | None
) -> dict[str, Any]:
    """Detect Brain FOV for real and stand in for every other detector."""
    if adapter.key == "brainfov":
        return detector_evidence(adapter, cfg, subject_id)
    return _done_evidence(adapter, cfg, subject_id)


def _publish_brainfov(effective_cfg: dict[str, Any], subject_id: str) -> None:
    """Publish the pass-through derivative set the Brain FOV detector verifies."""
    source_path, source, helper, signature, payload, roles = (
        brainfov_adapter._signature_inputs(effective_cfg, subject_id)
    )
    paths = build_derivative_paths(
        Path(effective_cfg["paths"]["derivativesDir"]),
        source_path,
        signature,
        subject_id,
    )
    if verify_published_derivative_set(paths, roles) is not None:
        return
    provenance = build_brainfov_provenance(
        signature=signature,
        signature_payload=payload,
        source=source,
        plan=plan_brain_fov_crop(source),
        mask=None,
        provider=brainfov_adapter._provider_identity(),
        helper=brainfov_adapter._helper_identity(helper),
        nested_command=[],
        validation={"fixture": True},
    )
    publish_derivative_set(paths, {"qc": b"qc"}, provenance)


def _brainfov_run(
    root: Path, run_id: str, cfg: dict[str, Any], started_at_ms: int
) -> None:
    """Commit and publish a run whose Brain FOV nodes ran on the current T1s."""
    cohort = _planned_cohort(cfg)
    effective_cfg = runtime_cfg(cfg, cohort, run_id, str(root))
    cache: dict[tuple[str, str | None], tuple[str, dict[str, Any]]] = {}
    receipts = []
    for subject_id in cohort.analysis_subject_ids:
        _publish_brainfov(effective_cfg, subject_id)
        signature, payload = _signature_for_step(
            "brainfov", subject_id, effective_cfg, cohort, cache
        )
        receipts.append(
            make_receipt(
                signature,
                payload,
                _brainfov_evidence(ADAPTERS["brainfov"], effective_cfg, subject_id),
                run_id=run_id,
                job_id=f"job-brainfov-{subject_id}",
                committed_at_ms=started_at_ms + 1,
            )
        )
    state = _state(
        root,
        run_id,
        dry_run=False,
        node_status="done",
        cfg=cfg,
        cohort=cohort,
        receipts=receipts,
    )
    state["startedAtMs"] = started_at_ms
    state["planBinding"] = {"qcDigest": stable_digest(load_qc_records(cfg))}
    store = RunStore(str(root))
    store.commit(state)
    for receipt in receipts:
        store.put_receipt(receipt)


def test_stage_currency_reads_a_rebound_t1_through_the_row_run_all_binds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Brain FOV reads its input at the T1 path the judged view binds. A T1
    # moved and moved back leaves the newest run bound to the other path,
    # while Run all binds the rediscovered one and reuses the earlier run's
    # receipt for it, so the card reads that subject through the same row.
    monkeypatch.setattr(
        brainfov_adapter, "_sif_path", lambda _cfg: "/opt/supraspina/synthstrip.sif"
    )
    monkeypatch.setattr(results_module, "detector_evidence", _brainfov_evidence)
    monkeypatch.setattr(
        results_module, "enrich_evidence", lambda _key, value, *_args: value
    )
    for fill, subject_id in enumerate(_MEMBERS, start=1):
        _write_pass_through_t1(
            tmp_path / "rawdata" / subject_id / "anat" / f"{subject_id}_T1w.nii.gz",
            fill,
        )
    cfg = _cfg(tmp_path)
    cfg["steps"]["brainfov"] = {"enabled": True, "params": {"marginMm": 30}}
    _save_project(tmp_path, cfg)
    first = tmp_path / "rawdata" / "sub-003" / "anat" / "sub-003_T1w.nii.gz"
    second = first.with_name("sub-003_acq-b_T1w.nii.gz")
    _brainfov_run(tmp_path, "run-00000000000a", cfg, 1000)
    first.rename(second)
    _brainfov_run(tmp_path, "run-00000000000b", cfg, 2000)
    second.rename(first)
    inventory, project = _inventory(tmp_path)

    page = inventory.list({"project": project, "limit": 1})

    assert page["runId"] == "run-00000000000b"
    assert page["analysisCohortChange"] == {
        "cause": "membership",
        "reasons": [{"kind": "t1-changed", "subjectIds": ["sub-003"], "count": 1}],
    }
    assert page["stageCurrency"]["brainfov"] == {
        "state": "current",
        "outdatedSubjectIds": [],
    }
    reuse = _planner_reuse(
        tmp_path,
        monkeypatch,
        cfg,
        subject_steps=("brainfov",),
        detector=_brainfov_evidence,
    )
    assert {key: value for key, value in reuse.items() if ":" in key} == {
        "brainfov:sub-001": "run-00000000000b",
        "brainfov:sub-002": "run-00000000000b",
        "brainfov:sub-003": "run-00000000000a",
    }

    # A path no run bound reruns that subject's Brain FOV, and the card says so.
    first.rename(first.with_name("sub-003_acq-c_T1w.nii.gz"))
    page = inventory.list({"project": project, "limit": 1})

    assert page["stageCurrency"]["brainfov"] == {
        "state": "outdated",
        "outdatedSubjectIds": ["sub-003"],
    }
    reuse = _planner_reuse(
        tmp_path,
        monkeypatch,
        cfg,
        subject_steps=("brainfov",),
        detector=_brainfov_evidence,
    )
    assert reuse["brainfov:sub-003"] is None
    assert reuse["brainfov:sub-001"] == "run-00000000000b"


def _make_enigma_outputs(out_dir: Path, subjects: tuple[str, ...]) -> None:
    """Write the three ENIGMA galleries and measure tables the detector verifies."""
    for gallery, name in (
        ("subcortical", "ENIGMA_Subcortical_QC.html"),
        ("cortical_internal", "ENIGMA_Cortical_QC.html"),
        ("cortical_external", "ENIGMA_External_QC.html"),
    ):
        target = out_dir / "qc" / gallery / name
        target.parent.mkdir(parents=True, exist_ok=True)
        tags: list[str] = []
        for subject in subjects:
            for panel in enigma_module.gallery_panels(gallery, subject):
                for relative in {panel.montage_relative, panel.full_relative}:
                    image = target.parent / relative
                    image.parent.mkdir(parents=True, exist_ok=True)
                    image.write_bytes(_PNG_FIXTURE)
                tags.append(f'<img src="{panel.montage_relative}">')
                tags.append(f'<a href="{panel.full_relative}"></a>')
        target.write_text("<html><body>" + "".join(tags) + "</body></html>")
    measures = out_dir / "measures"
    measures.mkdir(parents=True, exist_ok=True)
    for name in (
        "LandRvolumes.csv",
        "CorticalMeasuresENIGMA_ThickAvg.csv",
        "CorticalMeasuresENIGMA_SurfAvg.csv",
    ):
        rows = "".join(f"{subject},1\n" for subject in subjects)
        (measures / name).write_text("SubjID,value\n" + rows)


def test_enigma_galleries_stay_current_for_review_after_qc_verdicts_change(
    tmp_path: Path,
) -> None:
    # QC review records a verdict only from a gallery whose provenance is
    # current; judging rows against the new verdicts would disable review
    # after the first verdict. A verdict leaves the stage current too,
    # so the galleries the verdicts attest to are never rerun for it.
    subjects = ("sub-001", "sub-002")
    _write_t1s(tmp_path, subjects)
    _make_enigma_outputs(tmp_path / "outputs" / "qc", subjects)
    cfg = _cfg(tmp_path)
    cohort = _planned_cohort(cfg)
    run_id = "run-66666661"
    _commit_planned_run(
        tmp_path,
        run_id,
        cfg,
        cohort,
        [_current_cohort_receipt(tmp_path, run_id, cfg, cohort, "enigma")],
    )
    inventory, project = _inventory(tmp_path)
    assert _stage_currency(inventory, project, run_id)["enigma"] == {
        "state": "current",
        "outdatedSubjectIds": [],
    }

    _write_qc_verdicts(tmp_path, {"sub-001": "pass"})

    assert _stage_currency(inventory, project, run_id)["enigma"] == {
        "state": "current",
        "outdatedSubjectIds": [],
    }
    galleries = [
        row
        for row in _rows_for(inventory, project, run_id, "enigma")
        if row["kind"] == "html"
    ]
    assert len(galleries) == 3
    assert {(row["presence"], row["provenance"]) for row in galleries} == {
        ("produced", "current")
    }
