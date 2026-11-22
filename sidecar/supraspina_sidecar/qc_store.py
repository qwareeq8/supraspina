"""Parser for the strict, versioned QC verdict store."""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from .bounded_io import BoundedReadError, read_bounded_regular

SCHEMA_VERSION = 2
MAX_NOTE_LENGTH = 4_096
MAX_TAGS = 32
MAX_TAG_LENGTH = 64
MAX_SUBJECT_ID_LENGTH = 128
MAX_REVIEWER_LENGTH = 128
MAX_GALLERY_LABEL_LENGTH = 128
MAX_GALLERY_PATH_LENGTH = 16_384
MAX_STORE_BYTES = 16 * 1024 * 1024

_VERDICTS = {"pass", "fail", "defer"}
_CANONICAL_TOP_LEVEL_KEYS = {"schemaVersion", "verdicts"}
_CANONICAL_RECORD_KEYS = {
    "verdict",
    "note",
    "tags",
    "reviewEvidence",
    "revision",
    "updatedAt",
}
_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_HEX_DIGEST = re.compile(r"^[a-f0-9]{64}$")
_RUN_ID = re.compile(r"^run-[a-f0-9]{8,32}$")
_GALLERY_TABS = {"subcortical", "internal", "external"}


class QcStoreError(ValueError):
    """Raise when persisted QC evidence cannot be trusted."""


def valid_subject_id(value: str) -> bool:
    """Return whether a subject ID is a bounded, traversal-safe segment."""
    return (
        bool(value)
        and len(value) <= MAX_SUBJECT_ID_LENGTH
        and value not in {".", ".."}
        and not any(token in value for token in ("/", "\\", "\x00", ".."))
    )


def empty_document() -> dict[str, Any]:
    """Return an empty canonical QC store document."""
    return {"schemaVersion": SCHEMA_VERSION, "verdicts": {}}


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or _TIMESTAMP.fullmatch(value) is None:
        return False
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return False
    return True


def _parse_verdict(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str) and value in _VERDICTS:
        return value
    raise QcStoreError("Provide a valid QC verdict-store verdict.")


def _parse_review_evidence(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if (
        not isinstance(value, dict)
        or set(value) != {"evidenceVersion", "reviewer", "reviewedAt", "galleries"}
        or value.get("evidenceVersion") != 1
        or isinstance(value.get("evidenceVersion"), bool)
        or not isinstance(value.get("reviewer"), str)
        or not 0 < len(value["reviewer"]) <= MAX_REVIEWER_LENGTH
        or not _valid_timestamp(value.get("reviewedAt"))
        or not isinstance(value.get("galleries"), list)
        or len(value["galleries"]) != len(_GALLERY_TABS)
    ):
        raise QcStoreError("Provide valid QC verdict-store review evidence.")
    galleries: list[dict[str, Any]] = []
    for gallery in value["galleries"]:
        if (
            not isinstance(gallery, dict)
            or set(gallery)
            != {
                "tab",
                "label",
                "displayPath",
                "runId",
                "receiptSha256",
                "openedAt",
            }
            or gallery.get("tab") not in _GALLERY_TABS
            or not isinstance(gallery.get("label"), str)
            or not 0 < len(gallery["label"]) <= MAX_GALLERY_LABEL_LENGTH
            or not isinstance(gallery.get("displayPath"), str)
            or not 0 < len(gallery["displayPath"]) <= MAX_GALLERY_PATH_LENGTH
            or not isinstance(gallery.get("runId"), str)
            or _RUN_ID.fullmatch(gallery["runId"]) is None
            or not isinstance(gallery.get("receiptSha256"), str)
            or _HEX_DIGEST.fullmatch(gallery["receiptSha256"]) is None
            or not _valid_timestamp(gallery.get("openedAt"))
        ):
            raise QcStoreError("Provide valid QC verdict-store gallery evidence.")
        galleries.append(dict(gallery))
    if (
        {gallery["tab"] for gallery in galleries} != _GALLERY_TABS
        or len({gallery["runId"] for gallery in galleries}) != 1
        or len({gallery["receiptSha256"] for gallery in galleries}) != 1
    ):
        raise QcStoreError("Keep the QC verdict-store gallery evidence consistent.")
    return {
        "evidenceVersion": 1,
        "reviewer": value["reviewer"],
        "reviewedAt": value["reviewedAt"],
        "galleries": galleries,
    }


def _integral_revision(value: Any) -> int | None:
    """Read one record revision as an integer.

    The renderer parses this store with ``JSON.parse``, which turns the JSON
    literal ``1.0`` into the integer ``1``, so a document written with a float
    revision reads identically there. Accept the same documents here by taking
    an integral float as its integer value, and reject every other shape.

    Parameters
    ----------
    value : Any
        The parsed ``revision`` member of one record.

    Returns
    -------
    int or None
        The revision as an integer, or None when it is not an integral number.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _parse_record_fields(value: dict[str, Any], updated_at: Any) -> dict[str, Any]:
    note = value.get("note")
    tags = value.get("tags")
    revision = _integral_revision(value.get("revision"))
    if (
        not isinstance(note, str)
        or len(note) > MAX_NOTE_LENGTH
        or not isinstance(tags, list)
        or len(tags) > MAX_TAGS
        or any(not isinstance(tag, str) or len(tag) > MAX_TAG_LENGTH for tag in tags)
        or revision is None
        or revision < 0
        or revision > (2**53 - 1)
        or not _valid_timestamp(updated_at)
    ):
        raise QcStoreError("Provide a valid QC verdict-store record.")
    verdict = _parse_verdict(value.get("verdict"))
    review_evidence = _parse_review_evidence(value.get("reviewEvidence"))
    if verdict is not None and review_evidence is None:
        raise QcStoreError(
            "Include review evidence with each QC verdict-store verdict."
        )
    return {
        "verdict": verdict,
        "note": note,
        "tags": list(tags),
        "reviewEvidence": review_evidence,
        "revision": revision,
        "updatedAt": updated_at,
    }


def _parse_canonical_record(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != _CANONICAL_RECORD_KEYS:
        raise QcStoreError("Provide a valid canonical QC verdict-store record.")
    return _parse_record_fields(value, value.get("updatedAt"))


def _parse_verdicts(value: Any, record_parser: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict):
        raise QcStoreError("Provide QC verdict-store verdicts as an object.")
    records: dict[str, dict[str, Any]] = {}
    for subject_id, raw_record in value.items():
        if not isinstance(subject_id, str) or not valid_subject_id(subject_id):
            raise QcStoreError("Provide a valid QC verdict-store subject ID.")
        records[subject_id] = record_parser(raw_record)
    return records


def parse_document(value: Any) -> dict[str, Any]:
    """Parse one canonical QC verdict-store document.

    Returns
    -------
    dict
        Return the canonical document.

    Raises
    ------
    QcStoreError
        Raise when the top-level shape or any record is invalid.
    """
    if not isinstance(value, dict):
        raise QcStoreError("Provide the QC verdict store as an object.")
    if (
        set(value) != _CANONICAL_TOP_LEVEL_KEYS
        or isinstance(value["schemaVersion"], bool)
        or value["schemaVersion"] != SCHEMA_VERSION
    ):
        raise QcStoreError("Use a supported QC verdict-store schema.")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "verdicts": _parse_verdicts(value["verdicts"], _parse_canonical_record),
    }


def load_document(path: str) -> dict[str, Any]:
    """Load one trusted canonical QC document.

    Treat only a missing path as an empty QC store. Raise :class:`QcStoreError`
    for unreadable, nonregular, malformed, unsupported, or semantically invalid
    stores. Never replace them.

    Parameters
    ----------
    path
        Provide the canonical project QC-store path.

    Returns
    -------
    dict
        Return the canonical QC store.
    """
    try:
        payload = read_bounded_regular(path, MAX_STORE_BYTES)
        value = json.loads(payload)
    except FileNotFoundError:
        return empty_document()
    except BoundedReadError as exc:
        raise QcStoreError(
            "Provide the QC verdict store as a bounded regular file."
        ) from exc
    except json.JSONDecodeError as exc:
        raise QcStoreError("Provide valid JSON in the QC verdict store.") from exc
    except (OSError, UnicodeError) as exc:
        raise QcStoreError("Provide a readable QC verdict store.") from exc

    return parse_document(value)
