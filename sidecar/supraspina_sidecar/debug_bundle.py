"""Consent-gated, bounded, redacted workflow debug bundle export."""

from __future__ import annotations

import json
import os
import uuid
import zipfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from .bounded_io import read_regular_prefix
from .project import ProjectEpochs
from .redaction import redact_text
from .results import ResultInventory
from .run_store import RunStore

_MAX_FILE_BYTES = 2 * 1024 * 1024
_MAX_TOTAL_BYTES = 16 * 1024 * 1024
_MAX_LOG_FILES = 256
_MAX_LOG_DIRECTORY_ENTRIES = 4_096
_MAX_JSON_DEPTH = 12
_MAX_JSON_ITEMS = 20_000
_MAX_JSON_MAPPING_ITEMS = 2_000
_MAX_JSON_SEQUENCE_ITEMS = 5_000
_MAX_JSON_STRING_LENGTH = 16_384
_MAX_JSON_KEY_LENGTH = 256
_MAX_REDACTION_VALUE_LENGTH = 256
_CATEGORY_LABELS = {
    "config": "Configuration snapshot",
    "manifest": "Reproducibility manifest",
    "graph": "Workflow graph",
    "evidence": "Bounded provenance evidence",
    "logs": "Process logs",
}
_SUBJECT_KEYS = {
    "subjectid",
    "subjectids",
    "analysissubjectids",
    "selectedsubjectids",
    "excludedbyconfig",
    "excludedbyqc",
}
_MAX_REDACTION_VALUES = 200_000


@dataclass(frozen=True)
class _Entry:
    category: str
    name: str
    text: str
    source_bytes: int
    truncated: bool


def _bounded_log_paths(logs_dir: Path) -> tuple[list[Path], bool]:
    """Return a bounded, sorted set of regular log files and truncation state."""
    paths: list[Path] = []
    try:
        with os.scandir(logs_dir) as entries:
            for index, entry in enumerate(entries):
                if index >= _MAX_LOG_DIRECTORY_ENTRIES:
                    return sorted(paths)[:_MAX_LOG_FILES], True
                try:
                    if entry.is_file(follow_symlinks=False):
                        paths.append(Path(entry.path))
                except OSError:
                    continue
    except OSError:
        return [], False
    return sorted(paths)[:_MAX_LOG_FILES], len(paths) > _MAX_LOG_FILES


class DebugBundleManager:
    """Preview and write only explicitly selected redacted debug categories."""

    def __init__(self, projects: ProjectEpochs, results: ResultInventory) -> None:
        self.projects = projects
        self.results = results

    def _entries(self, project_root: str, run_id: str) -> list[_Entry]:
        state = RunStore(project_root).load(run_id)
        entries = [
            self._json_entry("config", "config.json", state.get("config", {})),
            self._json_entry("manifest", "manifest.json", state.get("manifest", {})),
            self._json_entry(
                "graph",
                "graph.json",
                {
                    "runId": run_id,
                    "intent": state.get("intent", {}),
                    "scope": state.get("scope", {}),
                    "nodes": state.get("nodes", []),
                },
            ),
            self._json_entry(
                "evidence",
                "evidence.json",
                {
                    "receipts": state.get("receipts", []),
                    "warnings": state.get("warnings", []),
                    "baseline": state.get("baseline", {}),
                },
            ),
        ]
        logs_dir = Path(RunStore(project_root).run_dir(run_id)) / "logs"
        log_paths, logs_truncated = _bounded_log_paths(logs_dir)
        log_entries: list[_Entry] = []
        for path in log_paths:
            try:
                log_entries.append(self._file_entry("logs", f"logs/{path.name}", path))
            except OSError:  # noqa: PERF203 - Tolerate log files that change while scanning.
                logs_truncated = True
        if logs_truncated and log_entries:
            log_entries[0] = replace(log_entries[0], truncated=True)
        elif logs_truncated:
            marker = "Log entries beyond the safety limit were omitted.\n"
            log_entries.append(
                _Entry(
                    category="logs",
                    name="logs/TRUNCATED.txt",
                    text=marker,
                    source_bytes=len(marker.encode("utf-8")),
                    truncated=True,
                )
            )
        entries.extend(log_entries)
        return entries

    @staticmethod
    def _json_entry(category: str, name: str, value: Any) -> _Entry:
        bounded, bounded_truncated = _bounded_json(value)
        raw = (
            json.dumps(bounded, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
        ).encode()
        clipped = raw[:_MAX_FILE_BYTES]
        return _Entry(
            category=category,
            name=name,
            text=clipped.decode("utf-8", errors="replace"),
            source_bytes=len(raw),
            truncated=bounded_truncated or len(raw) > len(clipped),
        )

    @staticmethod
    def _file_entry(category: str, name: str, path: Path) -> _Entry:
        clipped, source_bytes, truncated = read_regular_prefix(path, _MAX_FILE_BYTES)
        return _Entry(
            category=category,
            name=name,
            text=clipped.decode("utf-8", errors="replace"),
            source_bytes=source_bytes,
            truncated=truncated,
        )

    def preview(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return bounded category and redaction metadata before export."""
        project = self.projects.validate(request.get("project"))
        run_id = str(request.get("runId", ""))
        entries = self._entries(project.root, run_id)
        categories = []
        for category, label in _CATEGORY_LABELS.items():
            selected = [entry for entry in entries if entry.category == category]
            categories.append(
                {
                    "id": category,
                    "label": label,
                    "fileCount": len(selected),
                    "estimatedBytes": sum(
                        min(entry.source_bytes, _MAX_FILE_BYTES) for entry in selected
                    ),
                    "redactions": [
                        "secrets and bearer credentials",
                        "absolute paths and configured roots",
                        "analysis subject identifiers",
                    ],
                    "truncated": any(entry.truncated for entry in selected),
                }
            )
        total = sum(item["estimatedBytes"] for item in categories)
        return {
            "runId": run_id,
            "categories": categories,
            "totalFiles": sum(item["fileCount"] for item in categories),
            "estimatedBytes": min(total, _MAX_TOTAL_BYTES),
            "redactionPolicy": (
                "Secrets, credentials, configured roots, absolute paths, and "
                "analysis subject identifiers are redacted."
            ),
            "truncated": total > _MAX_TOTAL_BYTES
            or any(item["truncated"] for item in categories),
        }

    def bundle(  # noqa: PLR0915
        self, request: dict[str, Any]
    ) -> dict[str, str]:
        """Write a consent-gated redacted bundle to a trusted destination."""
        project = self.projects.validate(request.get("project"))
        if request.get("consent") is not True or request.get("redaction") != "required":
            raise PermissionError(
                "Provide explicit consent for a redacted debug bundle."
            )
        selected = request.get("categoryIds")
        if not isinstance(selected, list) or not selected:
            raise ValueError("Select at least one debug category.")
        category_ids = {str(value) for value in selected}
        if not category_ids <= set(_CATEGORY_LABELS):
            raise ValueError("Select a known debug category.")
        destination = str(request.get("destinationPath") or "")
        if not destination or not os.path.isabs(destination):
            raise ValueError("Provide a trusted destinationPath.")
        if not destination.lower().endswith(".zip"):
            raise ValueError("Use a .zip file as the debug destination.")
        run_id = str(request.get("runId", ""))
        state = RunStore(project.root).load(run_id)
        subject_ids = _subject_ids_for_redaction(state)
        cfg = state.get("config", {})
        roots = [
            str(value)
            for value in (
                cfg.get("paths", {}) if isinstance(cfg.get("paths"), dict) else {}
            ).values()
            if isinstance(value, str) and value
        ]
        entries = [
            entry
            for entry in self._entries(project.root, run_id)
            if entry.category in category_ids
        ]
        directory = os.path.dirname(destination)
        tmp = os.path.join(directory, f".debug-bundle.tmp-{uuid.uuid4().hex}")
        try:
            os.makedirs(directory, exist_ok=True)
            written = 0
            with zipfile.ZipFile(tmp, "x", compression=zipfile.ZIP_DEFLATED) as archive:
                for entry in entries:
                    safe = redact_text(
                        entry.text,
                        project_root=project.root,
                        sensitive_roots=roots,
                        subject_ids=subject_ids,
                    )
                    encoded = safe.encode("utf-8")
                    remaining = _MAX_TOTAL_BYTES - written
                    if remaining <= 0:
                        break
                    encoded = encoded[:remaining]
                    archive.writestr(entry.name, encoded)
                    written += len(encoded)
            with open(tmp, "rb") as handle:
                os.fsync(handle.fileno())
            os.replace(tmp, destination)
            if os.name != "nt":
                fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        except (OSError, zipfile.BadZipFile) as exc:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise RuntimeError("Choose a writable debug-bundle destination.") from exc
        artifact_id = self.results.register_external(
            project.project_id,
            project.epoch,
            destination,
        )
        return {"artifactId": artifact_id, "displayPath": os.path.basename(destination)}


def _bounded_json(
    value: Any,
    *,
    depth: int = 0,
    budget: list[int] | None = None,
) -> tuple[Any, bool]:
    """Project arbitrary state into a bounded JSON-compatible structure."""
    remaining = budget if budget is not None else [_MAX_JSON_ITEMS]
    if remaining[0] <= 0 or depth > _MAX_JSON_DEPTH:
        return "[TRUNCATED]", True
    remaining[0] -= 1
    if isinstance(value, dict):
        output: dict[str, Any] = {}
        truncated = False
        for index, (key, item) in enumerate(value.items()):
            if index >= _MAX_JSON_MAPPING_ITEMS or remaining[0] <= 0:
                truncated = True
                break
            projected, child_truncated = _bounded_json(
                item, depth=depth + 1, budget=remaining
            )
            output[str(key)[:_MAX_JSON_KEY_LENGTH]] = projected
            truncated = truncated or child_truncated
        return output, truncated
    if isinstance(value, (list, tuple)):
        output = []
        truncated = False
        for index, item in enumerate(value):
            if index >= _MAX_JSON_SEQUENCE_ITEMS or remaining[0] <= 0:
                truncated = True
                break
            projected, child_truncated = _bounded_json(
                item, depth=depth + 1, budget=remaining
            )
            output.append(projected)
            truncated = truncated or child_truncated
        return output, truncated
    if isinstance(value, str):
        return (
            value[:_MAX_JSON_STRING_LENGTH],
            len(value) > _MAX_JSON_STRING_LENGTH,
        )
    if value is None or isinstance(value, (bool, int, float)):
        return value, False
    rendered = str(value)
    return (
        rendered[:_MAX_JSON_STRING_LENGTH],
        len(rendered) > _MAX_JSON_STRING_LENGTH,
    )


def _subject_ids_for_redaction(state: dict[str, Any]) -> list[str]:
    """Collect bounded subject-bearing values from all persisted run scopes."""
    found: set[str] = set()
    inspected = 0

    def add(value: Any) -> None:
        nonlocal inspected
        values = value if isinstance(value, list) else [value]
        for item in values:
            if inspected >= _MAX_REDACTION_VALUES:
                return
            inspected += 1
            if isinstance(item, str) and 0 < len(item) <= _MAX_REDACTION_VALUE_LENGTH:
                found.add(item)

    def walk(value: Any) -> None:
        nonlocal inspected
        if inspected >= _MAX_REDACTION_VALUES:
            return
        if isinstance(value, dict):
            for key, child in value.items():
                normalized = "".join(
                    character for character in str(key).lower() if character.isalpha()
                )
                if normalized in _SUBJECT_KEYS:
                    add(child)
                if isinstance(child, (dict, list)):
                    walk(child)
        elif isinstance(value, list):
            for child in value:
                if inspected >= _MAX_REDACTION_VALUES:
                    break
                if isinstance(child, (dict, list)):
                    walk(child)

    walk(state)
    config = state.get("config", {})
    subjects = config.get("subjects", {}) if isinstance(config, dict) else {}
    if isinstance(subjects, dict):
        add(subjects.get("include", []))
        add(subjects.get("exclude", []))
    return sorted(found)
