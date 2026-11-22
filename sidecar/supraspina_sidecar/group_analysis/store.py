"""The analysis store under ``.supraspina/analysis/``.

- ``specs.json``: the saved specifications and ROI sets with one revision;
  every write names the ``expectedRevision`` it builds on.
- ``results/<resultId>.json``: one stored result: the ``GroupAnalysisResult``
  fields, the resolved inclusion rows (``subjects``), the snapshot facts the
  currency check compares (``state``), the per-measure adjusted group means
  and subject values (``detail``), and ``pinned``.

``resultSha256`` is the SHA-256 of the record's canonical JSON (sorted keys,
no whitespace) without ``resultSha256`` and ``pinned``; a record whose digest
does not match reads as absent. Writes are atomic (temporary file, fsync, and
rename). The newest 20 results are kept, plus every pinned (exported) one.
Reads are bounded; an unreadable store reads as empty. Nothing here is a
receipt: the store is advisory state the panel can always recompute.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import secrets
import stat
import tempfile
import threading
import time
from collections import OrderedDict
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from ..bounded_io import BoundedReadError, read_bounded_regular
from .spec import (
    GroupAnalysisError,
    GroupAnalysisSpec,
    parse_measure_id,
    parse_spec,
    spec_digest,
)

STORE_DIR = os.path.join(".supraspina", "analysis")
MAX_RESULTS = 20
LIBRARY_SCHEMA = "supraspina/group-analysis-library"

#: The ``GroupAnalysisResult`` fields; the rest of a record stays in the store.
PUBLIC_FIELDS: tuple[str, ...] = (
    "schema",
    "schemaVersion",
    "resultId",
    "specId",
    "name",
    "spec",
    "specDigest",
    "createdAt",
    "engine",
    "provisional",
    "stageCurrency",
    "inputs",
    "sample",
    "rows",
    "skipped",
    "resultSha256",
)
_RECORD_FIELDS = frozenset({*PUBLIC_FIELDS, "subjects", "state", "detail", "pinned"})
#: A v2 record adds its terms; its rows carry a ``termId`` each.
_RECORD_FIELDS_V2 = frozenset({*_RECORD_FIELDS, "terms"})
#: The rows one ``termRows`` page and the first term of ``result`` carry.
TERM_PAGE_ROWS = 2_000
_UNSEALED = frozenset({"resultSha256", "pinned"})

_MAX_LIBRARY_BYTES = 16 * 1024 * 1024
#: The largest stored v2 record (``GROUP_ANALYSIS_MAX_RECORD_BYTES_V2``); the
#: worker strips per-subject values to fit it and the store refuses more.
MAX_RECORD_BYTES_V2 = 32 * 1024 * 1024
#: The refusal of a v2 record over the cap, from the worker or the store.
RECORD_TOO_LARGE_V2 = (
    "The result would be larger than 32 MiB; select fewer measures, tests, or strata."
)
#: The largest v1 record, and the read bound of any record file (a v2 record
#: the store wrote never exceeds its own cap).
_MAX_RESULT_BYTES = 64 * 1024 * 1024
_MAX_SAVED = 200
_MAX_MEASURES = 20_000
_MAX_NAME = 120
_MAX_RESULT_FILES = 1_000
_STALE_TEMPORARY_SECONDS = 600.0
_SPEC_ID = re.compile(r"gas-[a-f0-9]{16}")
_SET_ID = re.compile(r"gset-[a-f0-9]{16}")
_RESULT_ID = re.compile(r"gar-[a-f0-9]{16}")
_RESULT_FILE = re.compile(r"(gar-[a-f0-9]{16})\.json")
_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z")
_PRINTABLE = re.compile(r"[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?")

_STALE_LIBRARY = (
    "Load the saved analyses again because they changed since this view loaded."
)
_LOCKS_GUARD = threading.Lock()
_LOCKS: dict[str, threading.RLock] = {}
_SUMMARY_LIMIT = 256
_SUMMARIES: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()
_SUMMARY_LOCK = threading.Lock()


def timestamp() -> str:
    """Return the current UTC time in the contract's millisecond ISO form."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    """Serialize a value canonically: sorted keys, no whitespace, no NaN."""
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def analysis_dir(project_root: str) -> str:
    """Return the project's analysis store directory."""
    return os.path.join(project_root, STORE_DIR)


def _results_dir(project_root: str) -> str:
    return os.path.join(analysis_dir(project_root), "results")


def _library_path(project_root: str) -> str:
    return os.path.join(analysis_dir(project_root), "specs.json")


def _lock(project_root: str) -> threading.RLock:
    key = os.path.realpath(project_root)
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.RLock())


def _ensure_dir(path: str) -> None:
    """Create one store directory (owner-only) and refuse a symlink in its place."""
    try:
        os.makedirs(path, mode=0o700, exist_ok=True)
        info = os.lstat(path)
    except OSError as exc:
        raise GroupAnalysisError(
            "The analysis store folder could not be created."
        ) from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise GroupAnalysisError("The analysis store path is not a folder.")


def _write_atomic(path: str, payload: bytes) -> None:
    """Replace ``path`` with ``payload`` through a synced temporary file.

    The caller has created the parent folder with :func:`_ensure_dir`.
    """
    parent = os.path.dirname(path)
    try:
        descriptor, temporary = tempfile.mkstemp(prefix=".tmp-", dir=parent)
    except OSError as exc:
        raise GroupAnalysisError("The analysis store could not be written.") from exc
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = ""
    except OSError as exc:
        raise GroupAnalysisError("The analysis store could not be written.") from exc
    finally:
        if temporary:
            with contextlib.suppress(OSError):
                os.unlink(temporary)


def _read_json(path: str, limit: int) -> Any:
    """Return one JSON document, or None when it is absent or unreadable."""
    try:
        return json.loads(read_bounded_regular(path, limit).decode("utf-8"))
    except (BoundedReadError, OSError, UnicodeDecodeError, ValueError):
        return None


# -- Library ------------------------------------------------------------------


def _valid_name(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= _MAX_NAME
        and _PRINTABLE.fullmatch(value) is not None
    )


def _valid_timestamp(value: Any) -> bool:
    return isinstance(value, str) and _TIMESTAMP.fullmatch(value) is not None


def _measure_list(value: Any) -> list[str] | None:
    if (
        not isinstance(value, list)
        or not 0 < len(value) <= _MAX_MEASURES
        or any(parse_measure_id(item) is None for item in value)
        or len(set(value)) != len(value)
    ):
        return None
    return list(value)


def _set_digest(measures: list[str]) -> str:
    return hashlib.sha256(canonical_json(sorted(measures)).encode("utf-8")).hexdigest()


def _saved_spec(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or set(value) != {
        "specId",
        "name",
        "spec",
        "specDigest",
        "updatedAt",
    }:
        return None
    if (
        not isinstance(value["specId"], str)
        or not _SPEC_ID.fullmatch(value["specId"])
        or not _valid_name(value["name"])
        or not _valid_timestamp(value["updatedAt"])
    ):
        return None
    try:
        spec = parse_spec(value["spec"])
    except GroupAnalysisError:
        return None
    return {**value, "specDigest": spec_digest(spec)}


def _saved_set(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or set(value) != {
        "setId",
        "name",
        "measures",
        "locked",
        "updatedAt",
    }:
        return None
    measures = _measure_list(value["measures"])
    locked = value["locked"]
    if (
        not isinstance(value["setId"], str)
        or not _SET_ID.fullmatch(value["setId"])
        or not _valid_name(value["name"])
        or not _valid_timestamp(value["updatedAt"])
        or measures is None
    ):
        return None
    if locked is not None and (
        not isinstance(locked, dict)
        or set(locked) != {"sha256", "lockedAt"}
        or locked["sha256"] != _set_digest(measures)
        or not _valid_timestamp(locked["lockedAt"])
    ):
        return None
    return value


def load_library(project_root: str) -> dict[str, Any]:
    """Return the ``GroupAnalysisLibrary`` payload: revision, specs, and sets.

    An absent or unreadable ``specs.json`` reads as revision 0 with nothing
    saved; an invalid entry is dropped, and a locked set whose measures no
    longer match its digest is dropped with it.
    """
    document = _read_json(_library_path(project_root), _MAX_LIBRARY_BYTES)
    empty = {"revision": 0, "specs": [], "sets": []}
    if (
        not isinstance(document, dict)
        or document.get("schema") != LIBRARY_SCHEMA
        or document.get("schemaVersion") != 1
    ):
        return empty
    revision = document.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        return empty
    specs = document.get("specs") if isinstance(document.get("specs"), list) else []
    sets = document.get("sets") if isinstance(document.get("sets"), list) else []
    return {
        "revision": revision,
        "specs": [s for s in map(_saved_spec, specs[:_MAX_SAVED]) if s is not None],
        "sets": [s for s in map(_saved_set, sets[:_MAX_SAVED]) if s is not None],
    }


def _write_library(project_root: str, library: dict[str, Any]) -> dict[str, Any]:
    _ensure_dir(analysis_dir(project_root))
    document = {"schema": LIBRARY_SCHEMA, "schemaVersion": 1, **library}
    payload = (json.dumps(document, sort_keys=True, indent=1) + "\n").encode("utf-8")
    _write_atomic(_library_path(project_root), payload)
    return library


def _revision(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise GroupAnalysisError("Send the analysis library revision.")
    return value


def _edit(project_root: str, expected_revision: Any, change: Any) -> dict[str, Any]:
    """Apply one change to the library under its revision check."""
    expected = _revision(expected_revision)
    with _lock(project_root):
        library = load_library(project_root)
        if library["revision"] != expected:
            raise GroupAnalysisError(_STALE_LIBRARY)
        change(library)
        library["revision"] = expected + 1
        return _write_library(project_root, library)


def _name(value: Any) -> str:
    if not _valid_name(value):
        raise GroupAnalysisError("Name it with 1 to 120 printable characters.")
    return str(value)


def _index(items: list[dict[str, Any]], key: str, value: Any, noun: str) -> int:
    for index, item in enumerate(items):
        if item[key] == value:
            return index
    raise GroupAnalysisError(f"Select a saved {noun} that still exists.")


def save_spec(
    project_root: str,
    *,
    spec_id: str | None,
    name: str,
    spec: GroupAnalysisSpec,
    expected_revision: int,
) -> dict[str, Any]:
    """Create (``spec_id`` None) or replace a saved specification."""
    name = _name(name)
    entry = {
        "name": name,
        "spec": spec.model_dump(mode="json", by_alias=True),
        "specDigest": spec_digest(spec),
        "updatedAt": timestamp(),
    }

    def change(library: dict[str, Any]) -> None:
        specs = library["specs"]
        if spec_id is None:
            if len(specs) >= _MAX_SAVED:
                raise GroupAnalysisError("Delete a saved analysis before saving more.")
            specs.append({"specId": f"gas-{secrets.token_hex(8)}", **entry})
            return
        if not isinstance(spec_id, str) or not _SPEC_ID.fullmatch(spec_id):
            raise GroupAnalysisError("Send a valid saved-analysis ID.")
        index = _index(specs, "specId", spec_id, "analysis")
        specs[index] = {"specId": spec_id, **entry}

    return _edit(project_root, expected_revision, change)


def delete_spec(
    project_root: str, *, spec_id: str, expected_revision: int
) -> dict[str, Any]:
    """Delete a saved specification."""

    def change(library: dict[str, Any]) -> None:
        del library["specs"][_index(library["specs"], "specId", spec_id, "analysis")]

    return _edit(project_root, expected_revision, change)


def save_set(
    project_root: str,
    *,
    set_id: str | None,
    name: str,
    measures: list[str],
    expected_revision: int,
) -> dict[str, Any]:
    """Create (``set_id`` None) or replace an unlocked ROI set.

    A locked set never changes; the panel saves an edited copy as a new set.
    """
    name = _name(name)
    checked = _measure_list(measures)
    if checked is None:
        raise GroupAnalysisError("List one or more valid measure IDs, each once.")

    def change(library: dict[str, Any]) -> None:
        sets = library["sets"]
        entry = {"name": name, "measures": checked, "locked": None}
        if set_id is None:
            if len(sets) >= _MAX_SAVED:
                raise GroupAnalysisError("Delete a ROI set before saving more.")
            sets.append(
                {
                    "setId": f"gset-{secrets.token_hex(8)}",
                    **entry,
                    "updatedAt": timestamp(),
                }
            )
            return
        if not isinstance(set_id, str) or not _SET_ID.fullmatch(set_id):
            raise GroupAnalysisError("Send a valid ROI set ID.")
        index = _index(sets, "setId", set_id, "ROI set")
        if sets[index]["locked"] is not None:
            raise GroupAnalysisError("Save a copy to change a locked ROI set.")
        sets[index] = {"setId": set_id, **entry, "updatedAt": timestamp()}

    return _edit(project_root, expected_revision, change)


def lock_set(
    project_root: str, *, set_id: str, expected_revision: int
) -> dict[str, Any]:
    """Lock a set: record the SHA-256 of its sorted measures and the time."""

    def change(library: dict[str, Any]) -> None:
        sets = library["sets"]
        index = _index(sets, "setId", set_id, "ROI set")
        if sets[index]["locked"] is None:
            sets[index]["locked"] = {
                "sha256": _set_digest(sets[index]["measures"]),
                "lockedAt": timestamp(),
            }

    return _edit(project_root, expected_revision, change)


def delete_set(
    project_root: str, *, set_id: str, expected_revision: int
) -> dict[str, Any]:
    """Delete a saved ROI set; stored results keep their own measure lists."""

    def change(library: dict[str, Any]) -> None:
        del library["sets"][_index(library["sets"], "setId", set_id, "ROI set")]

    return _edit(project_root, expected_revision, change)


# -- Results ------------------------------------------------------------------


def result_digest(record: Mapping[str, Any]) -> str:
    """Return the ``resultSha256`` of a record (see the module notes)."""
    sealed = {key: value for key, value in record.items() if key not in _UNSEALED}
    return hashlib.sha256(canonical_json(sealed).encode("utf-8")).hexdigest()


def _result_path(project_root: str, result_id: str) -> str:
    if not isinstance(result_id, str) or not _RESULT_ID.fullmatch(result_id):
        raise GroupAnalysisError("Send a valid analysis result ID.")
    return os.path.join(_results_dir(project_root), f"{result_id}.json")


def _valid_record(value: Any, result_id: str) -> bool:
    version = value.get("schemaVersion") if isinstance(value, dict) else None
    return (
        isinstance(value, dict)
        and set(value) == (_RECORD_FIELDS if version == 1 else _RECORD_FIELDS_V2)
        and value.get("schema") == "supraspina/group-analysis-result"
        and version in {1, 2}
        and value.get("resultId") == result_id
        and isinstance(value.get("pinned"), bool)
        and _valid_timestamp(value.get("createdAt"))
        and isinstance(value.get("rows"), list)
        and isinstance(value.get("subjects"), list)
        and isinstance(value.get("state"), dict)
        and isinstance(value.get("detail"), dict)
        and isinstance(value.get("resultSha256"), str)
        and value["resultSha256"] == result_digest(value)
    )


def seal_result(record: Mapping[str, Any]) -> dict[str, Any]:
    """Return the record as stored: ``pinned`` defaulted, ``resultSha256`` set."""
    sealed = dict(record)
    sealed.setdefault("pinned", False)
    sealed["resultSha256"] = result_digest(sealed)
    return sealed


def sealed_size(record: Mapping[str, Any]) -> int:
    """Return the stored size in bytes, which the record caps apply to."""
    return len(canonical_json(seal_result(record)).encode("utf-8"))


def write_result(
    project_root: str, record: Mapping[str, Any], *, prune_after: bool = True
) -> None:
    """Write one stored result atomically, then prune past the newest 20.

    The record's ``resultSha256`` is (re)computed here, so callers pass the
    other fields. The compute worker passes ``prune_after`` false and prunes
    after it reports the result, so a cancel during the prune cannot hide a
    committed result.
    """
    sealed = seal_result(record)
    v1 = sealed.get("schemaVersion") == 1
    fields = _RECORD_FIELDS if v1 else _RECORD_FIELDS_V2
    if set(sealed) != fields:
        raise GroupAnalysisError("The analysis result is incomplete.")
    path = _result_path(project_root, str(sealed["resultId"]))
    payload = canonical_json(sealed).encode("utf-8")
    if v1 and len(payload) > _MAX_RESULT_BYTES:
        raise GroupAnalysisError(
            "The analysis result is larger than 64 MiB; select fewer measures."
        )
    if not v1 and len(payload) > MAX_RECORD_BYTES_V2:
        raise GroupAnalysisError(RECORD_TOO_LARGE_V2)
    with _lock(project_root):
        _ensure_dir(analysis_dir(project_root))
        _ensure_dir(_results_dir(project_root))
        _write_atomic(path, payload)
        if prune_after:
            prune(project_root)


def result_committed(project_root: str, result_id: str) -> bool:
    """Say whether a result file was committed (atomically replaced into place).

    A temporary file an interrupted write left behind does not count.
    """
    try:
        info = os.lstat(_result_path(project_root, result_id))
    except (OSError, GroupAnalysisError):
        return False
    return stat.S_ISREG(info.st_mode)


def read_result(project_root: str, result_id: str) -> dict[str, Any] | None:
    """Read one stored result, or None when it is absent or unreadable."""
    value = _read_json(_result_path(project_root, result_id), _MAX_RESULT_BYTES)
    return value if _valid_record(value, result_id) else None


def _file_signature(path: str) -> tuple[Any, ...] | None:
    try:
        info = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return None
    return (path, info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _summary(path: str, result_id: str) -> dict[str, Any] | None:
    """Return a record without its per-subject detail, cached by file identity."""
    signature = _file_signature(path)
    if signature is None:
        return None
    with _SUMMARY_LOCK:
        hit = _SUMMARIES.get(signature)
        if hit is not None:
            _SUMMARIES.move_to_end(signature)
            return hit
    value = _read_json(path, _MAX_RESULT_BYTES)
    if not _valid_record(value, result_id):
        return None
    summary = {key: item for key, item in value.items() if key != "detail"}
    if _file_signature(path) == signature:
        with _SUMMARY_LOCK:
            _SUMMARIES[signature] = summary
            while len(_SUMMARIES) > _SUMMARY_LIMIT:
                _SUMMARIES.popitem(last=False)
    return summary


def _result_ids(project_root: str) -> list[str]:
    try:
        names = os.listdir(_results_dir(project_root))
    except OSError:
        return []
    return sorted(
        match.group(1)
        for name in names[: _MAX_RESULT_FILES * 4]
        if (match := _RESULT_FILE.fullmatch(name))
    )[:_MAX_RESULT_FILES]


def list_results(project_root: str) -> list[dict[str, Any]]:
    """Read every stored result, newest first; unreadable ones are skipped.

    Each entry omits ``detail`` (the per-subject values), which only
    ``measureDetail`` and exports read.
    """
    folder = _results_dir(project_root)
    summaries = [
        summary
        for result_id in _result_ids(project_root)
        if (summary := _summary(os.path.join(folder, f"{result_id}.json"), result_id))
        is not None
    ]
    summaries.sort(key=lambda item: (item["createdAt"], item["resultId"]), reverse=True)
    return summaries


def prune(project_root: str) -> list[str]:
    """Delete stored results past the newest 20 that are not pinned.

    Temporary files an interrupted write left behind are removed once they
    are ten minutes old. Unreadable result files are left alone.

    Returns
    -------
    list of str
        The deleted result IDs.
    """
    folder = _results_dir(project_root)
    deleted: list[str] = []
    with _lock(project_root):
        for index, summary in enumerate(list_results(project_root)):
            if index < MAX_RESULTS or summary["pinned"]:
                continue
            with contextlib.suppress(OSError):
                os.unlink(os.path.join(folder, f"{summary['resultId']}.json"))
                deleted.append(summary["resultId"])
        try:
            names = os.listdir(folder)
        except OSError:
            names = []
        now = time.time()
        for name in names:
            if not name.startswith(".tmp-"):
                continue
            path = os.path.join(folder, name)
            with contextlib.suppress(OSError):
                info = os.lstat(path)
                if (
                    stat.S_ISREG(info.st_mode)
                    and now - info.st_mtime > _STALE_TEMPORARY_SECONDS
                ):
                    os.unlink(path)
    return deleted


def pin_result(project_root: str, result_id: str) -> None:
    """Mark a result as exported so pruning keeps it."""
    with _lock(project_root):
        record = read_result(project_root, result_id)
        if record is None:
            raise GroupAnalysisError("Select a stored analysis result.")
        if record["pinned"]:
            return
        record["pinned"] = True
        _ensure_dir(_results_dir(project_root))
        _write_atomic(
            _result_path(project_root, result_id),
            canonical_json(record).encode("utf-8"),
        )


def public_result(record: Mapping[str, Any]) -> dict[str, Any]:
    """Project a stored record onto the ``GroupAnalysisResult`` fields.

    A v2 record returns its header, every term, and the first term's rows
    (at most :data:`TERM_PAGE_ROWS`); ``termRows`` pages the rest.
    """
    public = {key: record[key] for key in PUBLIC_FIELDS}
    if record["schemaVersion"] != 1:
        first = record["terms"][0]["termId"] if record["terms"] else None
        public["terms"] = record["terms"]
        public["rows"] = [row for row in record["rows"] if row["termId"] == first][
            :TERM_PAGE_ROWS
        ]
    return public


def term_rows(record: Mapping[str, Any], term_id: str, offset: int) -> dict[str, Any]:
    """Return one page of one term's rows (``GroupAnalysisTermRows``).

    Parameters
    ----------
    record
        A stored v2 record.
    term_id
        One of its terms.
    offset
        The first row of the page.

    Returns
    -------
    dict
        The page, with the next offset or None after the last page.

    Raises
    ------
    GroupAnalysisError
        For a v1 record, an unknown term, or an offset past the rows.
    """
    terms = record.get("terms") if record.get("schemaVersion") == 2 else None  # noqa: PLR2004
    if not terms or all(term["termId"] != term_id for term in terms):
        raise GroupAnalysisError("Select a term this result contains.")
    rows = [row for row in record["rows"] if row["termId"] == term_id]
    if offset > len(rows):
        raise GroupAnalysisError("Send a row offset within the term.")
    page = rows[offset : offset + TERM_PAGE_ROWS]
    end = offset + len(page)
    return {
        "resultId": record["resultId"],
        "termId": term_id,
        "offset": offset,
        "total": len(rows),
        "rows": page,
        "nextOffset": end if end < len(rows) else None,
    }
