"""Tests for run-store commit points, concurrency, and receipt integrity."""

from __future__ import annotations

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import run_store as run_store_module
from supraspina_sidecar.run_store import (
    RECEIPT_PAYLOAD_KEYS,
    RECEIPT_VERSION,
    PersistenceError,
    RunStore,
    receipt_record_digest,
    receipt_scope_contract_valid,
)


def _state(run_id: str, marker: str) -> dict[str, Any]:
    return {
        "runId": run_id,
        "startedAtMs": 1,
        "status": "running",
        "marker": marker,
        "config": {"marker": marker},
        "intent": {"kind": "all"},
        "project": {"projectId": "project-a"},
        "scope": {},
        "nodes": [],
        "jobs": [],
        "receipts": [],
        "warnings": [],
        "baseline": {},
        "manifest": {"runId": run_id, "marker": marker},
    }


def test_fault_before_pointer_preserves_last_committed_generation(
    tmp_path: Path,
) -> None:
    run_id = "run-aaaaaaaa"
    store = RunStore(str(tmp_path))
    assert store.commit(_state(run_id, "first")) == 1

    def fail(stage: str, _run_id: str, generation: int) -> None:
        if stage == "before_pointer" and generation == 2:
            raise OSError("Simulate a disk fault.")

    faulted = RunStore(str(tmp_path), fault_hook=fail)
    with pytest.raises(PersistenceError):
        faulted.commit(_state(run_id, "uncommitted"))
    assert store.pointer(run_id)["generation"] == 1
    assert store.load(run_id)["marker"] == "first"

    # Let the retry own generation 2 and remove the unreferenced final directory.
    assert store.commit(_state(run_id, "retry")) == 2
    assert store.load(run_id)["marker"] == "retry"


def test_fault_after_pointer_is_reported_as_committed(tmp_path: Path) -> None:
    run_id = "run-bbbbbbbb"

    def fail(stage: str, _run_id: str, generation: int) -> None:
        if stage == "after_pointer" and generation == 1:
            raise OSError("Simulate an acknowledgment loss.")

    store = RunStore(str(tmp_path), fault_hook=fail)
    assert store.commit(_state(run_id, "committed")) == 1
    assert store.load(run_id)["marker"] == "committed"


def test_initial_commit_fsyncs_runs_root_and_retries_after_fsync_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = "run-f1f1f1f1"
    store = RunStore(str(tmp_path))
    original_fsync_dir = run_store_module._fsync_dir
    runs_root_attempts = 0

    def fail_first_runs_root_fsync(path: str) -> None:
        nonlocal runs_root_attempts
        if path == store.runs_root:
            runs_root_attempts += 1
            if runs_root_attempts == 1:
                raise OSError("Simulate a parent-directory fsync fault.")
        original_fsync_dir(path)

    monkeypatch.setattr(run_store_module, "_fsync_dir", fail_first_runs_root_fsync)

    with pytest.raises(PersistenceError):
        store.commit(_state(run_id, "first-attempt"))
    assert store.pointer(run_id) is None

    assert store.commit(_state(run_id, "retry")) == 1
    assert runs_root_attempts == 2
    assert store.load(run_id)["marker"] == "retry"


@pytest.mark.parametrize(
    "stage",
    [
        "before_write:config.json",
        "after_write:jobs.json",
        "before_generation_rename",
    ],
)
def test_initial_commit_fault_never_publishes_partial_state(
    tmp_path: Path,
    stage: str,
) -> None:
    run_id = "run-cccccccc"

    def fail(current: str, _run_id: str, _generation: int) -> None:
        if current == stage:
            raise OSError("Simulate a write fault.")

    store = RunStore(str(tmp_path), fault_hook=fail)
    with pytest.raises(PersistenceError):
        store.commit(_state(run_id, "partial"))
    assert store.pointer(run_id) is None
    with pytest.raises(ValueError, match=r"^Select a known run: run-cccccccc\.$"):
        store.load(run_id)


def test_concurrent_store_instances_publish_unique_generations(
    tmp_path: Path,
) -> None:
    run_id = "run-dddddddd"

    def commit(index: int) -> int:
        return RunStore(str(tmp_path)).commit(_state(run_id, f"marker-{index}"))

    with ThreadPoolExecutor(max_workers=8) as pool:
        generations = list(pool.map(commit, range(24)))
    assert sorted(generations) == list(range(1, 25))
    loaded = RunStore(str(tmp_path)).load(run_id)
    assert loaded["generation"] == 24
    assert loaded["marker"] in {f"marker-{index}" for index in range(24)}


def test_generation_byte_tamper_is_detected(tmp_path: Path) -> None:
    run_id = "run-eeeeeeee"
    store = RunStore(str(tmp_path))
    store.commit(_state(run_id, "durable"))
    pointer = store.pointer(run_id)
    run_json = (
        Path(store.run_dir(run_id)) / "generations" / pointer["directory"] / "run.json"
    )
    run_json.write_bytes(run_json.read_bytes() + b" ")
    with pytest.raises(
        PersistenceError,
        match=(
            r"^Reject run run-eeeeeeee because generation file run\.json has a "
            r"digest mismatch\.$"
        ),
    ):
        store.load(run_id)


def _receipt() -> dict[str, Any]:
    payload = {key: None for key in RECEIPT_PAYLOAD_KEYS}
    payload.update(
        {
            "receiptVersion": RECEIPT_VERSION,
            "stepKey": "deface",
            "subjectId": "sub-001",
            "scope": "subject",
            "analysisCohortDigest": None,
            "selectedSubsetDigest": None,
            "inputT1Fingerprint": "input-t1",
            "outputSchemaIdentity": "nii-gz:defaced-t1:v1",
            "baseline": {},
            "upstreamSignatures": [],
            "scopeBinding": {
                "bindingVersion": 1,
                "kind": "subject-input",
                "subjectId": "sub-001",
                "inputT1Fingerprint": "input-t1",
                "inputT1FingerprintStrategy": "sha256-full-v1",
            },
        }
    )
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode()
    signature = hashlib.sha256(encoded).hexdigest()
    receipt = {
        **payload,
        "signature": signature,
        "runId": "run-aaaaaaaa",
        "jobId": "job-deface",
        "committedAtMs": 1,
        "detectorEvidence": {"state": "done", "artifacts": []},
        "edgeEvidence": {},
        "launchInputProjections": [],
        "launchDirectScientificInputs": [],
    }
    receipt["recordSha256"] = receipt_record_digest(receipt)
    return receipt


def test_commit_wraps_staging_oserror_as_persistence_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RunStore(str(tmp_path))

    def fail_makedirs(_path: str, exist_ok: bool = False) -> None:
        del exist_ok
        raise OSError("Simulate a full disk.")

    monkeypatch.setattr(run_store_module.os, "makedirs", fail_makedirs)
    with pytest.raises(PersistenceError):
        store.commit(_state("run-aaaaaaaa", "first"))


def test_put_receipt_wraps_oserror_as_persistence_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RunStore(str(tmp_path))
    receipt = _receipt()

    def fail_write(_path: str, _data: bytes) -> str:
        raise OSError("Simulate a full disk.")

    monkeypatch.setattr(run_store_module, "_write_fsynced", fail_write)
    with pytest.raises(PersistenceError):
        store.put_receipt(receipt)
    receipts_root = tmp_path / ".supraspina" / "receipts"
    assert list(receipts_root.rglob("*.tmp-*")) == []


def test_receipt_tamper_never_becomes_fresh_evidence(tmp_path: Path) -> None:
    store = RunStore(str(tmp_path))
    receipt = _receipt()
    path = Path(store.put_receipt(receipt))
    assert store.get_receipt("deface", "sub-001", receipt["signature"]) == receipt

    tampered = json.loads(path.read_text(encoding="utf-8"))
    tampered["outputSchemaIdentity"] = "forged"
    path.write_text(json.dumps(tampered), encoding="utf-8")
    assert store.get_receipt("deface", "sub-001", receipt["signature"]) is None


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("detectorEvidence", {"state": "done", "artifacts": ["forged"]}),
        ("edgeEvidence", {"recon": {"state": "done"}}),
        ("runId", "run-bbbbbbbb"),
        ("jobId", "job-forged"),
    ],
)
def test_receipt_record_digest_rejects_provenance_tamper(
    field: str,
    replacement: Any,
) -> None:
    receipt = _receipt()
    receipt[field] = replacement

    assert not RunStore._valid_receipt(receipt, receipt["signature"])


def test_receipt_scope_contract_rejects_unknown_version_binding_and_scope() -> None:
    assert not receipt_scope_contract_valid({"receiptVersion": 999})
    assert not receipt_scope_contract_valid(
        {"receiptVersion": RECEIPT_VERSION, "scopeBinding": {}}
    )
    assert not receipt_scope_contract_valid(
        {
            "receiptVersion": RECEIPT_VERSION,
            "scope": "unknown",
            "scopeBinding": {"bindingVersion": 1},
        }
    )
