"""Tests for consent, size bounds, and recursive redaction discovery in debug export."""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import debug_bundle
from supraspina_sidecar.debug_bundle import DebugBundleManager
from supraspina_sidecar.project import ProjectEpochs
from supraspina_sidecar.results import ResultInventory
from supraspina_sidecar.run_store import RunStore


def _project(root: Path) -> dict[str, Any]:
    return {
        "projectId": "debug-boundary",
        "root": str(root),
        "configPath": str(root / "supraspina.project.json"),
        "epoch": 1,
    }


def _state(root: Path, run_id: str = "run-12345678", config: Any = None) -> None:
    RunStore(str(root)).commit(
        {
            "runId": run_id,
            "startedAtMs": 1,
            "status": "done",
            "config": {} if config is None else config,
            "intent": {},
            "scope": {"analysisSubjectIds": ["sub-01"]},
            "nodes": [],
            "jobs": [],
            "receipts": [],
            "warnings": [],
            "baseline": {},
            "manifest": {"runId": run_id},
        }
    )


def _manager(root: Path) -> DebugBundleManager:
    projects = ProjectEpochs()
    projects.validate(_project(root))
    return DebugBundleManager(projects, ResultInventory(projects))


def test_bounded_json_limits_depth_budget_collections_strings_keys_and_objects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(debug_bundle, "_MAX_JSON_DEPTH", 1)
    value, truncated = debug_bundle._bounded_json({"outer": {"inner": {"deep": 1}}})
    assert value == {"outer": {"inner": "[TRUNCATED]"}}
    assert truncated is True

    assert debug_bundle._bounded_json([1, 2], budget=[0]) == ("[TRUNCATED]", True)

    monkeypatch.setattr(debug_bundle, "_MAX_JSON_MAPPING_ITEMS", 1)
    value, truncated = debug_bundle._bounded_json({"first": 1, "second": 2})
    assert value == {"first": 1}
    assert truncated is True

    monkeypatch.setattr(debug_bundle, "_MAX_JSON_SEQUENCE_ITEMS", 1)
    value, truncated = debug_bundle._bounded_json((1, 2))
    assert value == [1]
    assert truncated is True

    monkeypatch.setattr(debug_bundle, "_MAX_JSON_STRING_LENGTH", 3)
    monkeypatch.setattr(debug_bundle, "_MAX_JSON_KEY_LENGTH", 3)
    value, truncated = debug_bundle._bounded_json({"long-key": "long-value"})
    assert value == {"lon": "lon"}
    assert truncated is True
    assert debug_bundle._bounded_json(None) == (None, False)
    assert debug_bundle._bounded_json(True) == (True, False)
    assert debug_bundle._bounded_json(3.5) == (3.5, False)
    assert debug_bundle._bounded_json(Path("long-name")) == ("lon", True)


def test_subject_redaction_discovers_nested_normalized_keys_and_config_lists() -> None:
    state = {
        "subject_id": "sub-direct",
        "nested": [
            {"subjectIds": ["sub-list", "", 7]},
            [{"selected-subject-ids": ["sub-selected"]}],
        ],
        "config": {
            "subjects": {
                "include": ["sub-include"],
                "exclude": ["sub-exclude"],
            }
        },
    }

    assert debug_bundle._subject_ids_for_redaction(state) == [
        "sub-direct",
        "sub-exclude",
        "sub-include",
        "sub-list",
        "sub-selected",
    ]


def test_subject_redaction_respects_value_and_length_bounds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(debug_bundle, "_MAX_REDACTION_VALUES", 1)
    monkeypatch.setattr(debug_bundle, "_MAX_REDACTION_VALUE_LENGTH", 5)

    found = debug_bundle._subject_ids_for_redaction(
        {
            "subjectIds": ["too-long", "sub-2"],
            "nested": [{"subjectId": "sub-3"}],
            "config": [],
        }
    )

    assert found == []


def test_json_entry_records_truncation_and_file_entry_rejects_a_stat_race(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(debug_bundle, "_MAX_FILE_BYTES", 5)
    json_entry = DebugBundleManager._json_entry(
        "config", "config.json", {"value": "long-value"}
    )
    assert json_entry.source_bytes > 5
    assert json_entry.truncated is True
    assert len(json_entry.text.encode()) == 5

    path = tmp_path / "process.log"
    path.write_text("abcdefgh", encoding="utf-8")
    original_stat = Path.stat
    monkeypatch.setattr(
        Path,
        "stat",
        lambda self, *args, **kwargs: (
            (_ for _ in ()).throw(OSError("Remove the source."))
            if self == path
            else original_stat(self, *args, **kwargs)
        ),
    )
    with pytest.raises(OSError, match="Remove the source"):
        DebugBundleManager._file_entry("logs", "logs/process.log", path)


def test_entries_ignore_symlink_logs_and_bound_file_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _state(tmp_path)
    logs = Path(RunStore(str(tmp_path)).run_dir("run-12345678")) / "logs"
    logs.mkdir()
    (logs / "a.log").write_text("first", encoding="utf-8")
    (logs / "b.log").write_text("second", encoding="utf-8")
    outside = tmp_path / "outside.log"
    outside.write_text("outside", encoding="utf-8")
    try:
        (logs / "escape.log").symlink_to(outside)
    except OSError:
        pytest.skip("Run this test only where symlinks are available.")
    monkeypatch.setattr(debug_bundle, "_MAX_LOG_FILES", 1)

    entries = _manager(tmp_path)._entries(str(tmp_path), "run-12345678")

    log_entries = [entry for entry in entries if entry.category == "logs"]
    assert [entry.name for entry in log_entries] == ["logs/a.log"]
    assert "outside" not in "".join(entry.text for entry in entries)


def test_preview_marks_total_truncation_and_reports_every_category(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _state(tmp_path)
    monkeypatch.setattr(debug_bundle, "_MAX_TOTAL_BYTES", 1)
    manager = _manager(tmp_path)

    preview = manager.preview({"project": _project(tmp_path), "runId": "run-12345678"})

    assert {item["id"] for item in preview["categories"]} == set(
        debug_bundle._CATEGORY_LABELS
    )
    assert preview["estimatedBytes"] == 1
    assert preview["truncated"] is True
    assert preview["totalFiles"] == 4


def test_preview_states_the_redaction_policy_as_a_fact(tmp_path: Path) -> None:
    _state(tmp_path)

    preview = _manager(tmp_path).preview(
        {"project": _project(tmp_path), "runId": "run-12345678"}
    )

    # Logs shows this as "Redaction policy: ..." in the bundle confirmation.
    assert preview["redactionPolicy"] == (
        "Secrets, credentials, configured roots, absolute paths, and analysis "
        "subject identifiers are redacted."
    )


def test_truncated_log_scan_exports_a_factual_omission_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _state(tmp_path)
    logs = Path(RunStore(str(tmp_path)).run_dir("run-12345678")) / "logs"
    logs.mkdir()
    (logs / "a.log").write_text("first", encoding="utf-8")
    monkeypatch.setattr(debug_bundle, "_MAX_LOG_DIRECTORY_ENTRIES", 0)

    entries = _manager(tmp_path)._entries(str(tmp_path), "run-12345678")

    log_entries = [entry for entry in entries if entry.category == "logs"]
    assert [(entry.name, entry.text, entry.truncated) for entry in log_entries] == [
        (
            "logs/TRUNCATED.txt",
            "Log entries beyond the safety limit were omitted.\n",
            True,
        )
    ]


@pytest.mark.parametrize(
    ("overrides", "error", "message"),
    [
        ({"consent": False}, PermissionError, "explicit consent"),
        ({"redaction": "none"}, PermissionError, "explicit consent"),
        ({"categoryIds": []}, ValueError, "at least one debug category"),
        ({"categoryIds": "config"}, ValueError, "at least one debug category"),
        ({"categoryIds": ["unknown"]}, ValueError, "known debug category"),
        ({"destinationPath": "relative.zip"}, ValueError, "trusted destinationPath"),
        ({"destinationPath": "/absolute/not-zip"}, ValueError, "Use a .zip file"),
    ],
)
def test_bundle_rejects_missing_consent_categories_and_destination(
    tmp_path: Path,
    overrides: dict[str, Any],
    error: type[Exception],
    message: str,
) -> None:
    _state(tmp_path)
    request: dict[str, Any] = {
        "project": _project(tmp_path),
        "runId": "run-12345678",
        "consent": True,
        "redaction": "required",
        "categoryIds": ["config"],
        "destinationPath": str(tmp_path / "bundle.zip"),
    }
    request.update(overrides)

    with pytest.raises(error, match=message):
        _manager(tmp_path).bundle(request)


def test_bundle_honors_total_byte_bound_and_non_mapping_config_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _state(tmp_path, config={"paths": []})
    destination = tmp_path / "bundle.zip"
    monkeypatch.setattr(debug_bundle, "_MAX_TOTAL_BYTES", 10)
    manager = _manager(tmp_path)

    result = manager.bundle(
        {
            "project": _project(tmp_path),
            "runId": "run-12345678",
            "consent": True,
            "redaction": "required",
            "categoryIds": ["config", "manifest", "graph", "evidence"],
            "destinationPath": str(destination),
        }
    )

    assert result["displayPath"] == "bundle.zip"
    with zipfile.ZipFile(destination) as archive:
        assert sum(info.file_size for info in archive.infolist()) == 10
        assert len(archive.infolist()) == 1


def test_bundle_wraps_write_failure_and_removes_temporary_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _state(tmp_path)
    destination = tmp_path / "bundle.zip"
    manager = _manager(tmp_path)
    monkeypatch.setattr(
        debug_bundle.zipfile,
        "ZipFile",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("Simulate a full disk.")
        ),
    )

    with pytest.raises(RuntimeError, match="writable debug-bundle destination"):
        manager.bundle(
            {
                "project": _project(tmp_path),
                "runId": "run-12345678",
                "consent": True,
                "redaction": "required",
                "categoryIds": ["config"],
                "destinationPath": str(destination),
            }
        )
    assert not destination.exists()
    assert list(tmp_path.glob(".debug-bundle.tmp-*")) == []
