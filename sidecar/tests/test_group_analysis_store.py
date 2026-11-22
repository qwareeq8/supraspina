"""Tests for the analysis store under ``.supraspina/analysis/``."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path

import pytest

from supraspina_sidecar.group_analysis import store
from supraspina_sidecar.group_analysis.spec import GroupAnalysisError, parse_spec
from tests.group_analysis_support import example_spec, sample_record

_MEASURES = ["aseg:Brain-Stem", "dk:bi:precentral:ThickAvg"]


def _stamp(index: int) -> str:
    return f"2026-09-30T12:{index // 60:02d}:{index % 60:02d}.000Z"


def _id(index: int) -> str:
    return f"gar-{index:016x}"


def test_an_absent_library_reads_as_empty(tmp_path: Path) -> None:
    assert store.load_library(str(tmp_path)) == {"revision": 0, "specs": [], "sets": []}
    assert not (tmp_path / ".supraspina").exists()


def test_specs_are_saved_replaced_and_deleted_under_revisions(tmp_path: Path) -> None:
    root = str(tmp_path)
    spec = parse_spec(example_spec())

    created = store.save_spec(
        root, spec_id=None, name="SCI vs CTRL", spec=spec, expected_revision=0
    )
    assert created["revision"] == 1
    saved = created["specs"][0]
    assert re.fullmatch(r"gas-[a-f0-9]{16}", saved["specId"])
    assert saved["spec"]["measures"] == example_spec()["measures"]
    assert re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", saved["updatedAt"]
    )

    with pytest.raises(GroupAnalysisError, match="changed since this view loaded"):
        store.save_spec(
            root, spec_id=None, name="Again", spec=spec, expected_revision=0
        )

    other = parse_spec(example_spec(measures=["aseg:Brain-Stem"]))
    replaced = store.save_spec(
        root, spec_id=saved["specId"], name="Brainstem", spec=other, expected_revision=1
    )
    assert replaced["revision"] == 2
    assert replaced["specs"][0]["name"] == "Brainstem"
    assert replaced["specs"][0]["specDigest"] != saved["specDigest"]
    assert store.load_library(root) == replaced

    with pytest.raises(GroupAnalysisError, match="still exists"):
        store.delete_spec(root, spec_id="gas-0000000000000000", expected_revision=2)
    with pytest.raises(GroupAnalysisError, match="printable"):
        store.save_spec(
            root, spec_id=None, name=" padded", spec=spec, expected_revision=2
        )
    with pytest.raises(GroupAnalysisError, match="library revision"):
        store.save_spec(root, spec_id=None, name="x", spec=spec, expected_revision=True)
    assert (
        store.delete_spec(root, spec_id=saved["specId"], expected_revision=2)["specs"]
        == []
    )


def test_sets_lock_with_a_digest_and_never_change_after(tmp_path: Path) -> None:
    root = str(tmp_path)
    created = store.save_set(
        root, set_id=None, name="A priori", measures=_MEASURES, expected_revision=0
    )
    set_id = created["sets"][0]["setId"]
    assert re.fullmatch(r"gset-[a-f0-9]{16}", set_id)
    assert created["sets"][0]["locked"] is None

    edited = store.save_set(
        root,
        set_id=set_id,
        name="A priori",
        measures=_MEASURES[:1],
        expected_revision=1,
    )
    assert edited["sets"][0]["measures"] == _MEASURES[:1]

    locked = store.lock_set(root, set_id=set_id, expected_revision=2)
    lock = locked["sets"][0]["locked"]
    assert (
        lock["sha256"]
        == hashlib.sha256(
            json.dumps(["aseg:Brain-Stem"], separators=(",", ":")).encode()
        ).hexdigest()
    )
    assert (
        store.lock_set(root, set_id=set_id, expected_revision=3)["sets"][0]["locked"]
        == lock
    )

    with pytest.raises(GroupAnalysisError, match="Save a copy"):
        store.save_set(
            root, set_id=set_id, name="x", measures=_MEASURES, expected_revision=4
        )
    with pytest.raises(GroupAnalysisError, match="valid measure IDs"):
        store.save_set(
            root, set_id=None, name="x", measures=["bad"], expected_revision=4
        )
    with pytest.raises(GroupAnalysisError, match="valid measure IDs"):
        store.save_set(
            root, set_id=None, name="x", measures=_MEASURES * 2, expected_revision=4
        )
    assert store.delete_set(root, set_id=set_id, expected_revision=4)["sets"] == []


@pytest.mark.parametrize(
    "content",
    [
        b"{not json",
        b"[]",
        json.dumps({"schema": "other", "schemaVersion": 1, "revision": 3}).encode(),
        json.dumps(
            {"schema": store.LIBRARY_SCHEMA, "schemaVersion": 1, "revision": -1}
        ).encode(),
        b"\xff",
    ],
)
def test_a_corrupt_library_reads_as_empty(tmp_path: Path, content: bytes) -> None:
    path = tmp_path / ".supraspina" / "analysis" / "specs.json"
    path.parent.mkdir(parents=True)
    path.write_bytes(content)

    assert store.load_library(str(tmp_path)) == {"revision": 0, "specs": [], "sets": []}


def test_invalid_entries_and_tampered_locks_are_dropped(tmp_path: Path) -> None:
    root = str(tmp_path)
    store.save_set(
        root, set_id=None, name="Kept", measures=_MEASURES, expected_revision=0
    )
    library = store.save_set(
        root, set_id=None, name="Locked", measures=_MEASURES, expected_revision=1
    )
    locked_id = library["sets"][1]["setId"]
    store.lock_set(root, set_id=locked_id, expected_revision=2)
    path = tmp_path / ".supraspina" / "analysis" / "specs.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    document["sets"][1]["measures"] = ["aseg:Brain-Stem"]
    document["specs"].append({"specId": "gas-zz", "name": "Bad"})
    path.write_text(json.dumps(document), encoding="utf-8")

    loaded = store.load_library(root)

    assert loaded["revision"] == 3
    assert [item["name"] for item in loaded["sets"]] == ["Kept"]
    assert loaded["specs"] == []


def test_a_result_round_trips_with_its_digest(tmp_path: Path) -> None:
    root = str(tmp_path)
    record = sample_record(_id(1), _stamp(1))

    store.write_result(root, record)

    path = tmp_path / ".supraspina" / "analysis" / "results" / f"{_id(1)}.json"
    stat = path.parent.parent.stat()
    assert stat.st_mode & 0o777 == 0o700
    read = store.read_result(root, _id(1))
    assert read is not None
    assert read["pinned"] is False
    assert read["resultSha256"] == store.result_digest(read)
    assert {key: read[key] for key in record} == record
    public = store.public_result(read)
    assert list(public) == list(store.PUBLIC_FIELDS)
    assert not [name for name in os.listdir(path.parent) if name.startswith(".tmp-")]

    document = json.loads(path.read_text(encoding="utf-8"))
    document["rows"][0]["p"] = 0.5
    path.write_text(json.dumps(document), encoding="utf-8")
    assert store.read_result(root, _id(1)) is None
    assert store.list_results(root) == []


def test_an_incomplete_record_is_refused(tmp_path: Path) -> None:
    record = sample_record(_id(1), _stamp(1))
    del record["detail"]
    with pytest.raises(GroupAnalysisError, match="incomplete"):
        store.write_result(str(tmp_path), record)
    with pytest.raises(GroupAnalysisError, match="valid analysis result ID"):
        store.read_result(str(tmp_path), "../escape")


def test_results_are_listed_newest_first_without_detail(tmp_path: Path) -> None:
    root = str(tmp_path)
    for index in (2, 1, 3):
        store.write_result(root, sample_record(_id(index), _stamp(index)))
    (tmp_path / ".supraspina" / "analysis" / "results" / f"{_id(9)}.json").write_text(
        "{"
    )

    listed = store.list_results(root)

    assert [item["resultId"] for item in listed] == [_id(3), _id(2), _id(1)]
    assert all("detail" not in item for item in listed)
    assert store.list_results(root) == listed


def test_pruning_keeps_the_newest_twenty_and_every_pinned_result(
    tmp_path: Path,
) -> None:
    root = str(tmp_path)
    for index in range(1, 22):
        store.write_result(root, sample_record(_id(index), _stamp(index)))
        if index == 1:
            store.pin_result(root, _id(1))

    kept = [item["resultId"] for item in store.list_results(root)]
    assert len(kept) == 21
    assert _id(1) in kept

    store.write_result(root, sample_record(_id(22), _stamp(22)))
    kept = [item["resultId"] for item in store.list_results(root)]
    assert _id(2) not in kept
    assert _id(1) in kept
    assert len(kept) == 21
    pinned = store.read_result(root, _id(1))
    assert pinned is not None
    assert pinned["pinned"] is True
    assert pinned["resultSha256"] == store.result_digest(pinned)


def test_pruning_removes_only_stale_temporary_files(tmp_path: Path) -> None:
    root = str(tmp_path)
    store.write_result(root, sample_record(_id(1), _stamp(1)))
    folder = tmp_path / ".supraspina" / "analysis" / "results"
    old = folder / ".tmp-old"
    fresh = folder / ".tmp-fresh"
    old.write_text("partial")
    fresh.write_text("partial")
    past = time.time() - 3600
    os.utime(old, (past, past))

    store.prune(root)

    assert not old.exists()
    assert fresh.exists()


def test_pinning_an_absent_result_is_refused(tmp_path: Path) -> None:
    with pytest.raises(GroupAnalysisError, match="Select a stored analysis result"):
        store.pin_result(str(tmp_path), _id(4))


def test_a_symlinked_store_folder_is_refused(tmp_path: Path) -> None:
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (tmp_path / ".supraspina").mkdir()
    os.symlink(elsewhere, tmp_path / ".supraspina" / "analysis")

    with pytest.raises(GroupAnalysisError, match="not a folder"):
        store.write_result(str(tmp_path), sample_record(_id(1), _stamp(1)))
    with pytest.raises(GroupAnalysisError, match="not a folder"):
        store.save_set(
            str(tmp_path),
            set_id=None,
            name="x",
            measures=_MEASURES,
            expected_revision=0,
        )
    assert os.listdir(elsewhere) == []
