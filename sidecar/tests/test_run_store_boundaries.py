"""Tests for run-store validation, pagination, and corruption defenses."""

from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import run_store
from supraspina_sidecar.run_store import PersistenceError, RunStore


def _state(run_id: str, *, started: int = 1, manifest: Any = None) -> dict[str, Any]:
    return {
        "runId": run_id,
        "startedAtMs": started,
        "status": "done",
        "config": {},
        "intent": {},
        "project": {},
        "scope": {},
        "nodes": [],
        "jobs": [],
        "receipts": [],
        "warnings": [],
        "baseline": {},
        "manifest": {"runId": run_id} if manifest is None else manifest,
    }


@pytest.mark.parametrize("root", ["", "bad\0root"])
def test_project_root_and_run_id_validation_reject_unsafe_values(root: str) -> None:
    with pytest.raises(ValueError, match=r"^Provide a project root\.$"):
        run_store.canonical_project_root(root)


@pytest.mark.parametrize("run_id", ["", "run-short", "../run-aaaaaaaa", "RUN-AAAAAAAA"])
def test_run_directory_requires_bounded_lowercase_identifier(
    tmp_path: Path, run_id: str
) -> None:
    with pytest.raises(ValueError, match=r"^Provide a valid run ID\.$"):
        RunStore(str(tmp_path)).run_dir(run_id)


def test_fault_hook_receives_commit_stages(tmp_path: Path) -> None:
    events: list[tuple[str, str, int]] = []
    store = RunStore(str(tmp_path), fault_hook=lambda *args: events.append(args))

    assert store.commit(_state("run-aaaaaaaa")) == 1

    assert events[0] == ("before_write:config.json", "run-aaaaaaaa", 1)
    assert events[-1] == ("after_pointer", "run-aaaaaaaa", 1)


def test_commit_removes_unreferenced_future_generation(tmp_path: Path) -> None:
    store = RunStore(str(tmp_path))
    run_id = "run-bbbbbbbb"
    store.commit(_state(run_id))
    orphan = Path(store.run_dir(run_id)) / "generations" / "gen-00000002"
    orphan.mkdir()
    (orphan / "uncommitted").write_text("orphan", encoding="utf-8")

    assert store.commit(_state(run_id, started=2)) == 2
    assert not (orphan / "uncommitted").exists()


def test_pointer_rejects_non_mapping_invalid_and_missing_documents(
    tmp_path: Path,
) -> None:
    store = RunStore(str(tmp_path))
    run_id = "run-cccccccc"
    state = Path(store.run_dir(run_id)) / "state.json"
    state.parent.mkdir(parents=True)
    assert store.pointer(run_id) is None
    state.write_text("not-json", encoding="utf-8")
    with pytest.raises(
        PersistenceError,
        match=r"^Reject the run commit pointer because it is malformed\.$",
    ):
        store.pointer(run_id)
    state.write_text("[]", encoding="utf-8")
    with pytest.raises(
        PersistenceError,
        match=r"^Reject the run commit pointer because it is malformed\.$",
    ):
        store.pointer(run_id)


def test_pointer_size_and_schema_fail_closed_without_rewrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RunStore(str(tmp_path))
    run_id = "run-c0ffee00"
    store.commit(_state(run_id))
    path = _pointer_path(store, run_id)

    monkeypatch.setattr(run_store, "_MAX_POINTER_BYTES", 1)
    original = path.read_bytes()
    with pytest.raises(
        PersistenceError,
        match=(
            r"^Reject the run commit pointer because it exceeds the bounded size "
            r"limit\.$"
        ),
    ):
        store.load(run_id)
    assert path.read_bytes() == original

    monkeypatch.setattr(run_store, "_MAX_POINTER_BYTES", 256 * 1024)
    _replace_pointer(store, run_id, lambda value: value.update(schemaVersion=999))
    unsupported = path.read_bytes()
    with pytest.raises(
        PersistenceError,
        match=r"^Reject the run commit pointer because its schema is unsupported\.$",
    ):
        store.load(run_id)
    with pytest.raises(
        PersistenceError,
        match=r"^Reject the run commit pointer because its schema is unsupported\.$",
    ):
        store.commit(_state(run_id, started=2))
    assert path.read_bytes() == unsupported


def test_load_rejects_a_run_directory_without_a_commit_pointer(
    tmp_path: Path,
) -> None:
    store = RunStore(str(tmp_path))
    run_id = "run-dddddddd"
    manifest = Path(store.run_dir(run_id)) / "manifest.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({"runId": run_id, "old": True}), encoding="utf-8")

    with pytest.raises(ValueError, match=r"^Select a known run: run-dddddddd\.$"):
        store.load(run_id)


def _pointer_path(store: RunStore, run_id: str) -> Path:
    return Path(store.run_dir(run_id)) / "state.json"


def _replace_pointer(store: RunStore, run_id: str, mutate: Any) -> None:
    path = _pointer_path(store, run_id)
    pointer = json.loads(path.read_text(encoding="utf-8"))
    mutate(pointer)
    path.write_text(json.dumps(pointer), encoding="utf-8")


def _replace_generation_document(
    store: RunStore, run_id: str, name: str, mutate: Any
) -> None:
    pointer = store.pointer(run_id)
    assert pointer is not None
    path = Path(store.run_dir(run_id)) / "generations" / pointer["directory"] / name
    value = json.loads(path.read_text(encoding="utf-8"))
    mutate(value)
    data = (json.dumps(value) + "\n").encode()
    path.write_bytes(data)
    _replace_pointer(
        store,
        run_id,
        lambda current: current["digests"].update(
            {name: hashlib.sha256(data).hexdigest()}
        ),
    )


def test_load_rejects_invalid_directory_and_missing_digest_map(tmp_path: Path) -> None:
    run_id = "run-eeeeeeee"
    store = RunStore(str(tmp_path))
    store.commit(_state(run_id))
    _replace_pointer(store, run_id, lambda value: value.update(directory="../escape"))
    with pytest.raises(
        PersistenceError,
        match=r"Reject run run-eeeeeeee because its commit pointer is invalid\.",
    ):
        store.load(run_id)

    store.commit(_state(run_id, started=2))
    _replace_pointer(store, run_id, lambda value: value.update(digests={}))
    with pytest.raises(
        PersistenceError,
        match=r"^Reject run run-eeeeeeee because it has no generation digests\.$",
    ):
        store.load(run_id)


def test_load_rejects_unsafe_incomplete_unreadable_and_malformed_generation(
    tmp_path: Path,
) -> None:
    run_id = "run-ffffffff"
    store = RunStore(str(tmp_path))
    store.commit(_state(run_id))
    pointer = store.pointer(run_id)
    generation = Path(store.run_dir(run_id)) / "generations" / pointer["directory"]

    _replace_pointer(
        store,
        run_id,
        lambda value: value["digests"].update({"../escape": "0" * 64}),
    )
    with pytest.raises(
        PersistenceError,
        match=r"^Reject run run-ffffffff because it declares an unsafe file\.$",
    ):
        store.load(run_id)

    store.commit(_state(run_id, started=2))
    _replace_pointer(store, run_id, lambda value: value["digests"].pop("jobs.json"))
    with pytest.raises(
        PersistenceError,
        match=r"^Reject run run-ffffffff because its generation is incomplete\.$",
    ):
        store.load(run_id)

    store.commit(_state(run_id, started=3))
    pointer = store.pointer(run_id)
    generation = Path(store.run_dir(run_id)) / "generations" / pointer["directory"]
    run_json = generation / "run.json"
    bad = b"not-json\n"
    run_json.write_bytes(bad)
    _replace_pointer(
        store,
        run_id,
        lambda value: value["digests"].update(
            {"run.json": hashlib.sha256(bad).hexdigest()}
        ),
    )
    with pytest.raises(
        PersistenceError,
        match=r"^Reject run run-ffffffff because its generation is unreadable\.$",
    ):
        store.load(run_id)

    store.commit(_state(run_id, started=4))
    pointer = store.pointer(run_id)
    generation = Path(store.run_dir(run_id)) / "generations" / pointer["directory"]
    run_json = generation / "run.json"
    malformed = b"[]\n"
    run_json.write_bytes(malformed)
    _replace_pointer(
        store,
        run_id,
        lambda value: value["digests"].update(
            {"run.json": hashlib.sha256(malformed).hexdigest()}
        ),
    )
    with pytest.raises(
        PersistenceError,
        match=r"^Reject run run-ffffffff because its generation is malformed\.$",
    ):
        store.load(run_id)


def test_load_accepts_only_current_run_and_manifest_schemas(tmp_path: Path) -> None:
    store = RunStore(str(tmp_path))
    run_id = "run-a11ce000"
    store.commit(_state(run_id))
    loaded = store.load(run_id)
    assert loaded["schemaVersion"] == run_store.RUN_STATE_VERSION
    assert loaded["manifest"]["schemaVersion"] == run_store.MANIFEST_VERSION

    _replace_generation_document(
        store, run_id, "run.json", lambda value: value.update(schemaVersion=999)
    )
    with pytest.raises(
        PersistenceError,
        match=r"^Reject run run-a11ce000 because its run schema is unsupported\.$",
    ):
        store.load(run_id)

    run_id = "run-a11ce001"
    store.commit(_state(run_id))
    _replace_generation_document(
        store,
        run_id,
        "manifest.json",
        lambda value: value.update(schemaVersion=999),
    )
    with pytest.raises(
        PersistenceError,
        match=(
            r"^Reject run run-a11ce001 because its manifest schema is unsupported\.$"
        ),
    ):
        store.load(run_id)

    run_id = "run-a11ce002"
    store.commit(_state(run_id))
    _replace_generation_document(
        store,
        run_id,
        "run.json",
        lambda value: value["manifest"].update(schemaVersion=999),
    )
    with pytest.raises(
        PersistenceError,
        match=(
            r"^Reject run run-a11ce002 because its manifest schema is unsupported\.$"
        ),
    ):
        store.load(run_id)


def test_generation_file_and_run_index_reads_are_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RunStore(str(tmp_path))
    store.commit(_state("run-b0a0ded0"))
    # Commit both runs before tightening the bound so the reads are exercised.
    store.commit(_state("run-b0a0ded1"))
    monkeypatch.setattr(run_store, "_MAX_GENERATION_FILE_BYTES", 1)
    with pytest.raises(
        PersistenceError,
        match=(
            r"^Reject the run generation file because it exceeds the bounded size "
            r"limit\.$"
        ),
    ):
        store.load("run-b0a0ded0")

    monkeypatch.setattr(run_store, "_MAX_RUN_INDEX_ENTRIES", 1)
    with pytest.raises(
        PersistenceError,
        match=r"^Reject the run index because it exceeds the bounded entry limit\.$",
    ):
        store.list()
    with pytest.raises(
        PersistenceError,
        match=r"^Reject the run index because it exceeds the bounded entry limit\.$",
    ):
        store.run_ids()
    with pytest.raises(
        PersistenceError,
        match=r"^Reject the run index because it exceeds the bounded entry limit\.$",
    ):
        store.verify_index()


def test_generation_index_reads_are_bounded_without_pointer_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RunStore(str(tmp_path))
    run_id = "run-b0a0ded2"
    store.commit(_state(run_id))
    generations = Path(store.run_dir(run_id)) / "generations"
    (generations / ".gen-00000002.tmp-extra").mkdir()
    pointer = _pointer_path(store, run_id)
    original = pointer.read_bytes()
    monkeypatch.setattr(run_store, "_MAX_GENERATION_ENTRIES", 1)

    with pytest.raises(
        PersistenceError,
        match=(
            r"^Reject the run generation index because it exceeds the bounded entry "
            r"limit\.$"
        ),
    ):
        store.commit(_state(run_id, started=2))
    with pytest.raises(
        PersistenceError,
        match=(
            r"^Reject the run generation index because it exceeds the bounded entry "
            r"limit\.$"
        ),
    ):
        store.cleanup_orphans(run_id)
    assert pointer.read_bytes() == original


def test_list_pages_newest_first_and_surfaces_corrupt_run_without_paths(
    tmp_path: Path,
) -> None:
    store = RunStore(str(tmp_path))
    store.commit(_state("run-11111111", started=1))
    store.commit(_state("run-22222222", started=2, manifest=[]))
    corrupt = Path(store.run_dir("run-33333333"))
    corrupt.mkdir(parents=True)
    (corrupt / "state.json").write_text("{}", encoding="utf-8")
    (Path(store.runs_root) / "not-a-run").mkdir()

    first = store.list(cursor=-10, limit=1)
    second = store.list(cursor=first["nextCursor"], limit=500)

    assert first["total"] == 3
    assert len(first["items"]) == 1
    assert second["nextCursor"] is None
    assert len(second["items"]) == 2
    items = first["items"] + second["items"]
    malformed = next(item for item in items if item.get("runId") == "run-22222222")
    assert malformed["recovery"]["detail"] == (
        "Repair the corrupt run store (PersistenceError)."
    )
    recovery = next(item for item in items if item.get("runId") == "run-33333333")
    assert recovery["user"] == "[REDACTED]"
    assert recovery["host"] == "[REDACTED]"
    assert recovery["recovery"]["detail"] == (
        "Repair the corrupt run store (PersistenceError)."
    )
    assert store.run_ids() == ["run-11111111", "run-22222222", "run-33333333"]


def test_empty_store_list_and_run_ids_are_stable(tmp_path: Path) -> None:
    store = RunStore(str(tmp_path))
    assert store.list() == {"items": [], "nextCursor": None, "total": 0}
    assert store.run_ids() == []


def test_reject_receipt_bytes_beyond_the_read_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RunStore(str(tmp_path))
    signature = "a" * 64
    path = Path(store.receipt_path("recon", "sub-01", signature))
    path.parent.mkdir(parents=True)
    path.write_bytes(b"{" + b"x" * 16)
    monkeypatch.setattr(run_store, "_MAX_RECEIPT_BYTES", 16)

    assert store.get_receipt("recon", "sub-01", signature) is None


def test_receipt_path_sanitizes_keys_and_rejects_invalid_digest(
    tmp_path: Path,
) -> None:
    store = RunStore(str(tmp_path))
    with pytest.raises(ValueError, match=r"Provide a valid receipt digest\."):
        store.receipt_path("recon", "sub-01", "bad")
    path = store.receipt_path("Recon/Unsafe", "sub/01", "a" * 64)
    assert path.endswith("recon_unsafe/sub_01/" + "a" * 64 + ".json")


def test_put_and_get_receipt_reject_malformed_or_mismatched_bindings(
    tmp_path: Path,
) -> None:
    store = RunStore(str(tmp_path))
    with pytest.raises(PersistenceError, match=r"Provide a valid provenance receipt\."):
        store.put_receipt({"signature": "a" * 64})

    signature = "a" * 64
    path = Path(store.receipt_path("recon", "sub-01", signature))
    path.parent.mkdir(parents=True)
    assert store.get_receipt("recon", "sub-01", signature) is None
    path.write_text("[]", encoding="utf-8")
    assert store.get_receipt("recon", "sub-01", signature) is None

    monkeypatch_value = {
        "signature": signature,
        "stepKey": "other",
        "subjectId": "sub-01",
    }
    path.write_text(json.dumps(monkeypatch_value), encoding="utf-8")
    store._valid_receipt = lambda _value, _signature: True  # type: ignore[method-assign]
    assert store.get_receipt("recon", "sub-01", signature) is None
    monkeypatch_value["stepKey"] = "recon"
    monkeypatch_value["subjectId"] = "sub-02"
    path.write_text(json.dumps(monkeypatch_value), encoding="utf-8")
    assert store.get_receipt("recon", "sub-01", signature) is None


def test_cleanup_orphans_removes_only_temporary_generation_directories(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RunStore(str(tmp_path))
    run_id = "run-44444444"
    generations = Path(store.run_dir(run_id)) / "generations"
    temporary = generations / ".gen-00000001.tmp-a"
    committed = generations / "gen-00000001"
    unrelated = generations / ".unrelated.tmp-a"
    for path in (temporary, committed, unrelated):
        path.mkdir(parents=True)

    assert store.cleanup_orphans(run_id) == 1
    assert not temporary.exists()
    assert committed.exists()
    assert unrelated.exists()

    monkeypatch.setattr(
        run_store.shutil,
        "rmtree",
        lambda _path: (_ for _ in ()).throw(OSError("Treat storage as busy.")),
    )
    another = generations / ".gen-00000002.tmp-a"
    another.mkdir()
    assert store.cleanup_orphans(run_id) == 0


def _generation_names(store: RunStore, run_id: str) -> list[str]:
    generations = Path(store.run_dir(run_id)) / "generations"
    return sorted(entry.name for entry in generations.iterdir() if entry.is_dir())


def test_commit_rejects_a_generation_file_over_the_load_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Refuse to publish a generation that could never be loaded back."""
    store = RunStore(str(tmp_path))
    run_id = "run-b0dedc01"
    store.commit(_state(run_id))
    monkeypatch.setattr(run_store, "_MAX_GENERATION_FILE_BYTES", 512)
    oversized = _state(run_id)
    oversized["config"] = {"blob": "x" * 4096}

    with pytest.raises(PersistenceError, match=r"generation file size limit"):
        store.commit(oversized)

    # The previously committed generation is still the readable current state.
    assert store.load(run_id)["config"] == {}
    assert [
        name for name in _generation_names(store, run_id) if name.startswith(".gen-")
    ] == []


def test_commit_reports_a_state_that_changed_during_its_copy_as_persistence(
    tmp_path: Path,
) -> None:
    """Rewrap the copy abort so callers settle it under the persistence contract.

    A run state mutated while the commit copies it aborts the copy with a
    RuntimeError, which no caller's PersistenceError handling would catch.
    """

    class _MutatingState(dict):  # type: ignore[type-arg]
        def __deepcopy__(self, _memo: dict[int, Any]) -> Any:
            raise RuntimeError("dictionary changed size during iteration")

    store = RunStore(str(tmp_path))
    run_id = "run-b0dedc03"
    store.commit(_state(run_id))
    changing = _MutatingState(_state(run_id))
    changing["config"] = {"index": 1}

    with pytest.raises(PersistenceError, match=r"changed while its state was copied"):
        store.commit(changing)

    # The previously committed generation is still the readable current state.
    assert store.load(run_id)["config"] == {}
    assert [
        name for name in _generation_names(store, run_id) if name.startswith(".gen-")
    ] == []


def test_commit_rejects_a_generation_over_the_total_load_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RunStore(str(tmp_path))
    run_id = "run-b0dedc02"
    store.commit(_state(run_id))
    monkeypatch.setattr(run_store, "_MAX_GENERATION_FILE_BYTES", 4096)
    monkeypatch.setattr(run_store, "_MAX_GENERATION_TOTAL_BYTES", 4096)
    oversized = _state(run_id)
    # Keep every file inside the per-file bound so only the total bound trips.
    oversized["config"] = {"blob": "x" * 1024}
    oversized["scope"] = {"blob": "y" * 1024}
    oversized["nodes"] = [{"blob": "z" * 1024}]
    oversized["jobs"] = [{"blob": "w" * 1024}]

    with pytest.raises(PersistenceError, match=r"total size limit"):
        store.commit(oversized)

    assert store.load(run_id)["jobs"] == []


def test_commit_retains_a_bounded_generation_window(tmp_path: Path) -> None:
    store = RunStore(str(tmp_path))
    run_id = "run-7e7a1e01"
    for index in range(run_store._RETAINED_GENERATIONS + 5):
        state = _state(run_id, started=index + 1)
        state["config"] = {"index": index}
        store.commit(state)

    names = [name for name in _generation_names(store, run_id) if name != "generations"]
    latest = run_store._RETAINED_GENERATIONS + 5

    assert len(names) == run_store._RETAINED_GENERATIONS
    assert names[-1] == f"gen-{latest:08d}"
    assert names[0] == f"gen-{latest - run_store._RETAINED_GENERATIONS + 1:08d}"
    # The retained window always keeps the readable predecessor of the pointer.
    assert f"gen-{latest - 1:08d}" in names
    assert store.load(run_id)["config"] == {"index": latest - 1}


def test_terminal_history_survives_generation_pruning(tmp_path: Path) -> None:
    store = RunStore(str(tmp_path))
    run_id = "run-7e7a1e02"
    receipt = {"signature": "a" * 64, "stepKey": "recon", "subjectId": "sub-01"}
    for index in range(run_store._RETAINED_GENERATIONS + 4):
        state = _state(run_id, started=index + 1)
        state["receipts"] = [receipt]
        state["status"] = "done" if index else "running"
        store.commit(state)

    loaded = store.load(run_id)

    assert loaded["receipts"] == [receipt]
    assert loaded["status"] == "done"


def test_pruning_interruption_leaves_a_recoverable_store(tmp_path: Path) -> None:
    run_id = "run-7e7a1e03"
    interrupted = {"count": 0}

    def fault(stage: str, _run_id: str, _generation: int) -> None:
        if stage == "before_prune":
            interrupted["count"] += 1
            raise OSError("Interrupt the fixture prune.")

    store = RunStore(str(tmp_path), fault_hook=fault)
    for index in range(run_store._RETAINED_GENERATIONS + 3):
        state = _state(run_id, started=index + 1)
        state["config"] = {"index": index}
        store.commit(state)

    assert interrupted["count"] > 0
    # A failed prune never invalidates the pointer or the committed generation.
    assert store.load(run_id)["config"] == {
        "index": run_store._RETAINED_GENERATIONS + 2
    }

    plain = RunStore(str(tmp_path))
    plain.commit(_state(run_id, started=99))

    assert len(_generation_names(plain, run_id)) == run_store._RETAINED_GENERATIONS


def test_concurrent_commits_serialize_into_one_generation_chain(
    tmp_path: Path,
) -> None:
    run_id = "run-c0ffee01"
    store = RunStore(str(tmp_path))
    store.commit(_state(run_id))
    errors: list[BaseException] = []

    def commit(index: int) -> None:
        try:
            state = _state(run_id, started=index + 2)
            state["config"] = {"index": index}
            RunStore(str(tmp_path)).commit(state)
        except BaseException as error:
            errors.append(error)

    threads = [threading.Thread(target=commit, args=(index,)) for index in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30.0)

    assert errors == []
    pointer = store.pointer(run_id)
    assert pointer is not None
    assert int(pointer["generation"]) == 9
    assert store.load(run_id)["generation"] == 9
