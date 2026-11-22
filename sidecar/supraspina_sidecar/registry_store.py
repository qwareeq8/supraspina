"""Atomic storage for the project-scoped subject registry."""

from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import threading
import uuid
from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, ClassVar

from .bounded_io import BoundedReadError, read_regular_prefix
from .cohort import effective_qc_verdict, load_qc_records, resolve_t1
from .operator_errors import OperatorError
from .sites import (
    MAX_SET_SITE_SUBJECTS,
    SITE_LABEL_RULE,
    is_site_label,
    normalize_site_label,
    site_conflict_message,
    site_label_conflict,
)

# The refusal an editor sees when the stored record moved on beneath the draft.
# Retrying the same write cannot succeed, so name the recovery instead.
_STALE_UPSERT = "Load saved values because another writer changed this record."
_SUBJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_COHORT_ROLES = {
    "healthy",
    "sci-no-neuropathic-pain",
    "sci-neuropathic-pain",
    "ambiguous",
}
_T1_AVAILABILITY = {"available", "resolved", "missing", "ambiguous"}
# Verdicts a stored record may carry. The registry's ``qc`` field holds the
# effective verdict, and null names an unreviewed subject.
_QC_VERDICTS = {None, "pass", "fail", "defer"}
_MAX_COHORT_LABEL_LENGTH = 128
_MAX_QC_TAGS = 32
_MAX_QC_TAG_LENGTH = 64
_MAX_AGE_YEARS = 130
_MAX_TIME_SINCE_SCI_YEARS = 150
_MAX_REGISTRY_BYTES = 64 * 1024 * 1024
_MAX_REGISTRY_RECORDS = 100_000
# Sites set before registration (see RegistryStore.set_site) live apart from
# registry.json, so holding one changes no byte a receipt binds.
_MAX_PENDING_SITE_BYTES = 8 * 1024 * 1024
_PENDING_SITES_REPAIR = (
    "Repair the held site list (.supraspina/pending-sites.json) because it is "
    "malformed."
)

# CSV import gate: mirror the renderer BIDS rule (SUBJECT_ID_RE in
# RegistryScreen.tsx) so imports never create records the manual form or the
# default discovery glob (sub-*) cannot handle. The looser stored-record rule
# above stays unchanged.
_IMPORT_SUBJECT_ID = re.compile(r"^sub-[A-Za-z0-9]{1,124}$")
# Accept exactly the manual form's decimal shape (RegistryScreen.tsx): ASCII
# digits with an optional fraction. Reject signs, exponents, underscores, and
# non-ASCII digits that ``float()`` would silently reinterpret.
_IMPORT_NUMBER = re.compile(r"^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$")
# Mirror MAX_REGISTRY_IMPORT_BYTES in src/shared/registry-import.ts.
_MAX_IMPORT_CSV_BYTES = 512 * 1024
_MAX_IMPORT_ROWS = 20_000
_MAX_IMPORT_ISSUES = 200
_IMPORT_REQUIRED_COLUMNS = ("subjectId", "age", "sex", "sourceCohortLabel")
_IMPORT_COLUMNS = (*_IMPORT_REQUIRED_COLUMNS, "ais", "tSinceSci", "site")
_IMPORT_CANONICAL_BY_LOWER = {column.lower(): column for column in _IMPORT_COLUMNS}
_IMPORT_COLUMNS_HINT = ", ".join(_IMPORT_COLUMNS)
# Reject columns that would smuggle server-derived or reviewed values into the
# registry. Roles resolve from sourceCohortLabel; QC verdicts are recorded only
# through gallery review.
_IMPORT_ROLE_COLUMNS = frozenset({"cohortrole", "role", "cohort"})
_IMPORT_QC_COLUMNS = frozenset({"qc", "qcverdict", "verdict", "qcnote", "qctags"})
_IMPORT_DERIVED_COLUMNS = frozenset(
    {"t1availability", "runnable", "unavailablereason", "revision", "updatedat"}
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def cohort_role(label: str) -> str:
    """Resolve approved D3 semantic roles without guessing ambiguous aliases."""
    normalized = label.strip().lower().replace("-", "_")
    if normalized in {"ctrl", "control", "healthy", "sci_h"}:
        return "healthy"
    if normalized in {"sci_nnp", "nnp", "sci_no_neuropathic_pain", "sci_no_pain"}:
        return "sci-no-neuropathic-pain"
    if normalized in {"sci_p", "p", "sci_neuropathic_pain", "sci_pain"}:
        return "sci-neuropathic-pain"
    return "ambiguous"


def _issue(row: int | None, message: str) -> dict[str, Any]:
    """Build one import issue; ``row`` is None for file-level issues."""
    return {"row": row, "message": message}


def _issue_order(issue: dict[str, Any]) -> tuple[bool, int]:
    return (issue["row"] is not None, issue["row"] or 0)


def _validate_import_header(
    header: list[str],
) -> tuple[dict[str, int], list[str]]:
    """Map canonical columns to positions and reject the rest of the header."""
    errors: list[str] = []
    positions: dict[str, int] = {}
    for position, raw in enumerate(header):
        name = (raw.lstrip("\ufeff") if position == 0 else raw).strip()
        lowered = name.lower()
        canonical = _IMPORT_CANONICAL_BY_LOWER.get(lowered)
        if not name:
            errors.append("Remove the empty header column.")
        elif lowered in _IMPORT_ROLE_COLUMNS:
            errors.append(
                f'Remove the "{name}" column; Supraspina derives the cohort role '
                "from sourceCohortLabel."
            )
        elif lowered in _IMPORT_QC_COLUMNS:
            errors.append(
                f'Remove the "{name}" column; QC verdicts are recorded through '
                "gallery review and are never imported."
            )
        elif lowered in _IMPORT_DERIVED_COLUMNS:
            errors.append(
                f'Remove the "{name}" column; Supraspina derives this field from '
                "project state."
            )
        elif canonical is None:
            errors.append(
                f'Remove the unrecognized "{name}" column; the accepted columns '
                f"are {_IMPORT_COLUMNS_HINT}."
            )
        elif canonical in positions:
            errors.append(f'Remove the repeated "{name}" column.')
        else:
            positions[canonical] = position
    errors.extend(
        f"Add the required {required} column."
        for required in _IMPORT_REQUIRED_COLUMNS
        if required not in positions
    )
    return positions, errors


def _parse_import_row(  # noqa: PLR0912
    values: dict[str, str], *, site_column: bool = False
) -> tuple[dict[str, Any], list[str], list[str]]:
    """Validate one data row against the registry input rules.

    The record carries a ``site`` key only when the file has a site column, so
    an update from a file without one keeps each stored site.
    """
    errors: list[str] = []
    warnings: list[str] = []
    subject_id = values["subjectId"].strip()
    if not subject_id:
        errors.append("Provide a subjectId.")
    elif not _IMPORT_SUBJECT_ID.fullmatch(subject_id):
        errors.append("Use a BIDS subject label such as sub-001 or sub-0004.")
    # An empty age cell records an unknown age at scan, which keeps a subject
    # whose age was never captured registrable; any other unusable value is
    # still a rejection.
    age_raw = values["age"].strip()
    age: float | None = None
    if age_raw:
        if _IMPORT_NUMBER.fullmatch(age_raw):
            age = float(age_raw)
        if age is None or not math.isfinite(age) or not 0 <= age <= _MAX_AGE_YEARS:
            age = None
            errors.append("Enter an age from 0 to 130 years, or leave the value empty.")
    sex = values["sex"].strip().upper()
    if sex not in {"M", "F", "O"}:
        errors.append("Set sex to M, F, or O.")
    source_label = values["sourceCohortLabel"].strip()
    if (
        not source_label
        or len(source_label) > _MAX_COHORT_LABEL_LENGTH
        or any(character in source_label for character in "\x00\r\n")
    ):
        errors.append(
            "Provide a sourceCohortLabel of 1 to 128 characters on a single line."
        )
    elif cohort_role(source_label) == "ambiguous":
        warnings.append(
            f'The cohort label "{source_label}" resolves to the ambiguous role; '
            "the clinical merge and R analysis stages block until the label "
            "maps to a known cohort."
        )
    ais = values["ais"].strip().upper() or None
    if ais is not None and ais not in {"A", "B", "C", "D"}:
        ais = None
        errors.append("Set ais to A, B, C, or D, or leave it empty.")
    t_since_raw = values["tSinceSci"].strip()
    t_since: float | None = None
    if t_since_raw:
        if _IMPORT_NUMBER.fullmatch(t_since_raw):
            t_since = float(t_since_raw)
        if (
            t_since is None
            or not math.isfinite(t_since)
            or not 0 <= t_since <= _MAX_TIME_SINCE_SCI_YEARS
        ):
            t_since = None
            errors.append(
                "Enter years since SCI from 0 to 150, or leave the value empty."
            )
    record: dict[str, Any] = {
        "subjectId": subject_id,
        "age": age,
        "sex": sex,
        "sourceCohortLabel": source_label,
        "ais": ais,
        "tSinceSci": t_since,
    }
    if site_column:
        try:
            record["site"] = normalize_site_label(values["site"])
        except ValueError:
            errors.append(SITE_LABEL_RULE)
    return record, errors, warnings


def _parse_import_csv(  # noqa: PLR0912
    csv_text: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Parse and validate registry CSV text without touching any store.

    Return ``(rows, errors)`` where each row carries its 1-based CSV record
    number (the header is record 1), the validated candidate record, and any
    row-scoped warnings. Any returned error rejects the whole import.
    """
    if len(csv_text.encode("utf-8", "surrogatepass")) > _MAX_IMPORT_CSV_BYTES:
        return [], [
            _issue(
                None,
                f"Reduce the CSV to at most {_MAX_IMPORT_CSV_BYTES // 1024} KiB "
                "or split the import.",
            )
        ]
    try:
        parsed = list(csv.reader(io.StringIO(csv_text, newline="")))
    except csv.Error as exc:
        return [], [_issue(None, f"Repair the CSV structure: {exc}.")]
    if not parsed:
        return [], [
            _issue(
                None,
                "Add a header row naming the accepted columns: "
                f"{_IMPORT_COLUMNS_HINT}.",
            )
        ]
    positions, header_errors = _validate_import_header(parsed[0])
    if header_errors:
        return [], [_issue(1, message) for message in header_errors]
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    data_rows = 0
    for record_number, cells in enumerate(parsed[1:], start=2):
        if all(not cell.strip() for cell in cells):
            continue
        data_rows += 1
        if data_rows > _MAX_IMPORT_ROWS:
            errors.append(
                _issue(
                    None,
                    "Split the import into files of at most "
                    f"{_MAX_IMPORT_ROWS:,} data rows.",
                )
            )
            break
        if len(cells) > len(parsed[0]):
            errors.append(
                _issue(
                    record_number,
                    "Remove the extra values; the row has more cells than the header.",
                )
            )
            continue
        values = {
            canonical: (
                cells[positions[canonical]] if positions[canonical] < len(cells) else ""
            )
            if canonical in positions
            else ""
            for canonical in _IMPORT_COLUMNS
        }
        record, row_errors, row_warnings = _parse_import_row(
            values, site_column="site" in positions
        )
        if row_errors:
            errors.extend(_issue(record_number, message) for message in row_errors)
        else:
            rows.append(
                {"row": record_number, "record": record, "warnings": row_warnings}
            )
    if data_rows == 0:
        errors.append(_issue(None, "Add at least one data row below the header."))
    occurrences: dict[str, list[int]] = {}
    for row in rows:
        occurrences.setdefault(row["record"]["subjectId"], []).append(row["row"])
    duplicated = {
        subject_id: numbers
        for subject_id, numbers in occurrences.items()
        if len(numbers) > 1
    }
    for subject_id in sorted(duplicated):
        numbers = duplicated[subject_id]
        joined = ", ".join(str(number) for number in numbers)
        errors.extend(
            _issue(
                number,
                f"Remove the duplicated subject ID {subject_id}; "
                f"rows {joined} all use it.",
            )
            for number in numbers
        )
    rows = [row for row in rows if row["record"]["subjectId"] not in duplicated]
    return rows, errors


def _valid_number(value: Any, minimum: float, maximum: float) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(float(value))
        and minimum <= float(value) <= maximum
    )


def _upsert_age(age_raw: Any) -> float | None:
    """Return the validated age at scan, where a missing value is unknown.

    A missing key and an explicit null both record an age that was never
    captured, which keeps such a subject registrable; any other unusable value
    is a refusal rather than a coerced number.
    """
    if age_raw is None:
        return None
    if isinstance(age_raw, bool) or not isinstance(age_raw, (int, float)):
        raise ValueError("Provide a numeric age or null.")
    age = float(age_raw)
    if not math.isfinite(age) or age < 0 or age > _MAX_AGE_YEARS:
        raise ValueError("Provide an age from 0 to 130.")
    return age


def _site_conflicts(
    records: Mapping[str, Mapping[str, Any]], written: Iterable[str]
) -> list[tuple[str, str]]:
    """Return ``(subject, existing label)`` for each case-only site collision.

    ``written`` names the records a write sets, in order; each written label is
    checked against the sites of every record the write leaves alone and of
    the written records before it, so ``Prisma`` and ``prisma`` never coexist.
    """
    order = list(written)
    pending = set(order)
    seen = {
        site
        for subject_id, record in records.items()
        if subject_id not in pending and isinstance(site := record.get("site"), str)
    }
    conflicts: list[tuple[str, str]] = []
    for subject_id in order:
        site = records[subject_id].get("site")
        if not isinstance(site, str):
            continue
        conflict = site_label_conflict(site, seen)
        if conflict is None:
            seen.add(site)
        else:
            conflicts.append((subject_id, conflict))
    return conflicts


def _with_held(
    records: Mapping[str, Mapping[str, Any]], held: Mapping[str, str]
) -> dict[str, Mapping[str, Any]]:
    """Return the records plus each held site, for one case-conflict check."""
    return {
        **{subject_id: {"site": site} for subject_id, site in held.items()},
        **records,
    }


def _with_site(item: dict[str, Any], site: str | None) -> dict[str, Any]:
    """Store ``site`` only when set, so a record without a site has no key."""
    if site is None:
        item.pop("site", None)
    else:
        item["site"] = site
    return item


def _validate_stored_record(  # noqa: PLR0912
    subject_id: str, item: dict[str, Any]
) -> None:
    """Fail closed when persisted scientific registry fields are malformed."""
    if (
        not _SUBJECT_ID.fullmatch(subject_id)
        or ".." in subject_id
        or item.get("subjectId") != subject_id
    ):
        raise ValueError(
            "Repair the subject registry because it contains an invalid subjectId."
        )
    source_label = item.get("sourceCohortLabel")
    if (
        not isinstance(source_label, str)
        or not source_label
        or len(source_label) > _MAX_COHORT_LABEL_LENGTH
        or any(character in source_label for character in "\x00\r\n")
    ):
        raise ValueError(
            "Repair the subject registry because it contains an invalid cohort label."
        )
    role = item.get("cohortRole")
    if role not in _COHORT_ROLES or role != cohort_role(source_label):
        raise ValueError(
            "Repair the subject registry because it contains an invalid cohort role."
        )
    age = item.get("age")
    if age is not None and not _valid_number(age, 0, _MAX_AGE_YEARS):
        raise ValueError(
            "Repair the subject registry because it contains an invalid age."
        )
    if item.get("sex") not in {"M", "F", "O"}:
        raise ValueError(
            "Repair the subject registry because it contains an invalid sex."
        )
    if item.get("ais") not in {None, "A", "B", "C", "D"}:
        raise ValueError(
            "Repair the subject registry because it contains an invalid AIS grade."
        )
    t_since_sci = item.get("tSinceSci")
    if t_since_sci is not None and not _valid_number(
        t_since_sci, 0, _MAX_TIME_SINCE_SCI_YEARS
    ):
        raise ValueError(
            "Repair the subject registry because it contains invalid time-since-SCI."
        )
    revision = item.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise ValueError(
            "Repair the subject registry because it contains an invalid revision."
        )
    if not isinstance(item.get("updatedAt"), str):
        raise ValueError(
            "Repair the subject registry because it contains an invalid timestamp."
        )
    if item.get("t1Availability") not in _T1_AVAILABILITY:
        raise ValueError(
            "Repair the subject registry because it contains invalid T1 availability."
        )
    if not isinstance(item.get("runnable"), bool):
        raise ValueError(
            "Repair the subject registry because it contains an invalid runnable flag."
        )
    if not isinstance(item.get("unavailableReason"), (str, type(None))):
        raise ValueError(
            "Repair the subject registry because it contains an invalid unavailable "
            "reason."
        )
    if item.get("qc") not in _QC_VERDICTS:
        raise ValueError(
            "Repair the subject registry because it contains an invalid QC verdict."
        )
    if not isinstance(item.get("qcNote", ""), str):
        raise ValueError(
            "Repair the subject registry because it contains an invalid QC note."
        )
    # A record without a site has no key, so its bytes stay as they were;
    # null also means unset.
    site = item.get("site")
    if site is not None and not is_site_label(site):
        raise ValueError(
            "Repair the subject registry because it contains an invalid site."
        )
    tags = item.get("qcTags", [])
    if (
        not isinstance(tags, list)
        or len(tags) > _MAX_QC_TAGS
        or any(
            not isinstance(tag, str) or len(tag) > _MAX_QC_TAG_LENGTH for tag in tags
        )
    ):
        raise ValueError(
            "Repair the subject registry because it contains invalid QC tags."
        )


def _set_site_targets(subject_ids: Any, expected_revisions: Any) -> dict[str, int]:
    """Validate a ``registry.setSite`` selection and its expected revisions.

    Mirror ``parseRegistrySetSiteFields`` in ``src/shared/sites.ts``: 1 to
    20,000 distinct stored-record subject IDs, each with a non-negative
    integer revision and no other revision entry. Return them in request order.
    """
    if (
        not isinstance(subject_ids, (list, tuple))
        or not subject_ids
        or len(subject_ids) > MAX_SET_SITE_SUBJECTS
    ):
        raise ValueError("Select 1 to 20,000 subjects to set a site for.")
    if any(
        not isinstance(subject_id, str)
        or not _SUBJECT_ID.fullmatch(subject_id)
        or ".." in subject_id
        for subject_id in subject_ids
    ):
        raise ValueError("Select subjects with valid IDs to set a site for.")
    if len(set(subject_ids)) != len(subject_ids):
        raise ValueError("Name each subject once in a site request.")
    if (
        not isinstance(expected_revisions, Mapping)
        or set(expected_revisions) != set(subject_ids)
        or any(
            isinstance(revision, bool) or not isinstance(revision, int) or revision < 0
            for revision in expected_revisions.values()
        )
    ):
        raise ValueError("Provide the saved revision of every subject.")
    return {subject_id: expected_revisions[subject_id] for subject_id in subject_ids}


def _write_json(path: str, payload: dict[str, Any], name: str) -> None:
    """Atomically replace ``path`` with sorted, indented JSON and fsync it."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    tmp = os.path.join(directory, f".{name}.tmp-{uuid.uuid4().hex}")
    data = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    try:
        with open(tmp, "x", encoding="utf-8") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        if os.name != "nt":
            fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    except OSError:
        # Leave the prior file intact and remove the partial temp file so a
        # full disk or a denied rename cannot accumulate one temp file per
        # failed write.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class RegistryStore:
    """Serialize registry mutations and enforce optimistic revisions."""

    _locks_guard = threading.Lock()
    _locks: ClassVar[dict[str, threading.Lock]] = {}

    def __init__(self, project_root: str) -> None:
        self.project_root = str(Path(project_root).resolve())
        self.path = os.path.join(self.project_root, ".supraspina", "registry.json")
        self.pending_path = os.path.join(
            self.project_root, ".supraspina", "pending-sites.json"
        )
        with self._locks_guard:
            self._lock = self._locks.setdefault(self.path, threading.Lock())

    def _read(self) -> dict[str, dict[str, Any]]:
        try:
            data, _size, oversized = read_regular_prefix(self.path, _MAX_REGISTRY_BYTES)
        except FileNotFoundError:
            return {}
        except BoundedReadError as exc:
            raise ValueError(
                "Provide the subject registry as a bounded regular file."
            ) from exc
        except OSError as exc:
            raise ValueError("Provide a readable subject registry.") from exc
        if oversized:
            raise ValueError(
                "Reject the subject registry because it exceeds the bounded size limit."
            )
        try:
            value = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError("Repair the malformed subject registry.") from exc
        schema_version = value.get("schemaVersion") if isinstance(value, dict) else None
        if type(schema_version) is not int or schema_version != 1:
            raise ValueError(
                "Resolve the subject registry because its version is unsupported; "
                "use schema version 1."
            )
        records = value.get("records")
        if not isinstance(records, dict) or any(
            not isinstance(subject_id, str) or not isinstance(item, dict)
            for subject_id, item in records.items()
        ):
            raise ValueError("Repair the malformed subject registry records.")
        if len(records) > _MAX_REGISTRY_RECORDS:
            raise ValueError(
                "Reject the subject registry because it exceeds the bounded record "
                "limit."
            )
        for subject_id, item in records.items():
            _validate_stored_record(subject_id, item)
        return records

    def _write(self, records: dict[str, dict[str, Any]]) -> None:
        _write_json(self.path, {"schemaVersion": 1, "records": records}, "registry")

    def _read_pending(self) -> dict[str, str]:
        """Return the held sites by subject, or none when the file is absent."""
        try:
            data, _size, oversized = read_regular_prefix(
                self.pending_path, _MAX_PENDING_SITE_BYTES
            )
        except FileNotFoundError:
            return {}
        except (BoundedReadError, OSError) as exc:
            raise ValueError(_PENDING_SITES_REPAIR) from exc
        if oversized:
            raise ValueError(_PENDING_SITES_REPAIR)
        try:
            value = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError(_PENDING_SITES_REPAIR) from exc
        sites = value.get("sites") if isinstance(value, dict) else None
        if (
            not isinstance(value, dict)
            or type(value.get("schemaVersion")) is not int
            or value.get("schemaVersion") != 1
            or not isinstance(sites, dict)
            or len(sites) > _MAX_REGISTRY_RECORDS
            or any(
                not isinstance(subject_id, str)
                or not _SUBJECT_ID.fullmatch(subject_id)
                or ".." in subject_id
                or not is_site_label(site)
                for subject_id, site in sites.items()
            )
        ):
            raise ValueError(_PENDING_SITES_REPAIR)
        return dict(sites)

    def _write_pending(self, pending: dict[str, str]) -> None:
        if not pending:
            # No held site leaves no file.
            try:
                os.unlink(self.pending_path)
            except FileNotFoundError:
                pass
            return
        _write_json(
            self.pending_path, {"schemaVersion": 1, "sites": pending}, "pending-sites"
        )

    def _held_sites(
        self, records: Mapping[str, Any]
    ) -> tuple[dict[str, str], dict[str, str]]:
        """Return every held site, and those of subjects still without a record.

        A held site applies only while its subject has no record; one left by
        an interrupted registration is ignored and pruned by the next write.
        """
        pending = self._read_pending()
        return pending, {
            subject_id: site
            for subject_id, site in pending.items()
            if subject_id not in records
        }

    def pending_sites(self) -> dict[str, str]:
        """Return the site held for each subject that has no registry record."""
        with self._lock:
            return self._held_sites(self._read())[1]

    def list(self, cfg: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """Return persisted records enriched with current T1/QC availability."""
        with self._lock:
            records = self._read()
        qc = load_qc_records(cfg) if cfg else {}
        subjects_cfg = (
            cfg.get("subjects", {})
            if cfg and isinstance(cfg.get("subjects"), dict)
            else {}
        )
        include = {str(value) for value in subjects_cfg.get("include", [])}
        exclude = {str(value) for value in subjects_cfg.get("exclude", [])}
        out = []
        for subject_id in sorted(records):
            item = dict(records[subject_id])
            # Report an unset site as null without storing the key.
            item.setdefault("site", None)
            if cfg:
                t1 = resolve_t1(cfg, subject_id)
                availability = "available" if t1.state == "resolved" else t1.state
                item["t1Availability"] = availability
                included = (
                    not include or subject_id in include
                ) and subject_id not in exclude
                qc_record = qc.get(subject_id, {})
                recorded_verdict = qc_record.get("verdict")
                if recorded_verdict not in {"pass", "fail", "defer"}:
                    recorded_verdict = None
                verdict = effective_qc_verdict(qc_record)
                item["runnable"] = (
                    availability == "available" and included and verdict != "fail"
                )
                reasons = []
                if availability != "available":
                    reasons.append(f"Resolve the T1 input state: {availability}.")
                if subject_id in exclude:
                    reasons.append(
                        "Remove the subject because it is excluded by project "
                        "configuration."
                    )
                elif include and subject_id not in include:
                    reasons.append(
                        "Add the subject because it is not in the configured include "
                        "set."
                    )
                if verdict == "fail":
                    reasons.append(
                        "Resolve QC Fail before including the subject in analysis."
                    )
                item["unavailableReason"] = " ".join(reasons) or None
                item["qc"] = None if verdict == "unreviewed" else verdict
                item["recordedQcVerdict"] = recorded_verdict
                item["qcReviewEvidencePresent"] = (
                    qc_record.get("reviewEvidence") is not None
                )
                item["qcNote"] = str(qc_record.get("note", ""))
                item["qcTags"] = list(qc_record.get("tags", []))
                item["qcRevision"] = int(qc_record.get("revision", 0))
            out.append(item)
        return out

    def upsert(
        self, record: dict[str, Any], expected_revision: int | None = None
    ) -> dict[str, Any]:
        """Validate and atomically insert or revise one subject record."""
        required = {"subjectId", "sex", "sourceCohortLabel"}
        if not required.issubset(record):
            raise ValueError("Provide all required registry record fields.")
        subject_id = str(record.get("subjectId", ""))
        if not _SUBJECT_ID.fullmatch(subject_id) or ".." in subject_id:
            raise ValueError("Provide a valid subjectId.")
        source_label = str(record.get("sourceCohortLabel", ""))
        if (
            not source_label
            or len(source_label) > _MAX_COHORT_LABEL_LENGTH
            or any(character in source_label for character in "\x00\r\n")
        ):
            raise ValueError("Provide a valid sourceCohortLabel.")
        role = cohort_role(source_label)
        age = _upsert_age(record.get("age"))
        sex = str(record.get("sex", "O"))
        if sex not in {"M", "F", "O"}:
            raise ValueError("Set sex to M, F, or O.")
        ais = record.get("ais")
        if ais not in {None, "A", "B", "C", "D"}:
            raise ValueError("Set ais to A, B, C, D, or null.")
        t_since_raw = record.get("tSinceSci")
        if t_since_raw is None:
            t_since_sci = None
        elif isinstance(t_since_raw, bool) or not isinstance(t_since_raw, (int, float)):
            raise ValueError("Provide numeric tSinceSci or null.")
        else:
            t_since_sci = float(t_since_raw)
            if (
                not math.isfinite(t_since_sci)
                or not 0 <= t_since_sci <= _MAX_TIME_SINCE_SCI_YEARS
            ):
                raise ValueError("Provide tSinceSci from 0 to 150.")
        # A request without the key keeps the stored site, so a caller that
        # predates the field never drops it; null or blank text clears it.
        site_given = "site" in record
        requested_site = normalize_site_label(record["site"]) if site_given else None
        with self._lock:
            records = self._read()
            pending, held = self._held_sites(records)
            previous = records.get(subject_id, {})
            revision = int(previous.get("revision", 0))
            if expected_revision is not None and int(expected_revision) != revision:
                raise OperatorError(_STALE_UPSERT)
            # A new record without the key takes the site set before it was
            # registered.
            stored_site = previous.get("site", held.get(subject_id))
            site = requested_site if site_given else stored_site
            item = {
                "subjectId": subject_id,
                "age": age,
                "sex": sex,
                "sourceCohortLabel": source_label,
                "cohortRole": role,
                "ais": ais,
                "tSinceSci": t_since_sci,
                "t1Availability": "missing",
                "runnable": False,
                "unavailableReason": "Refresh discovery for this registry record.",
                "qc": previous.get("qc"),
                "qcNote": previous.get("qcNote", ""),
                "qcTags": list(previous.get("qcTags", [])),
                "revision": revision + 1,
                "updatedAt": _now_iso(),
            }
            _with_site(item, site)
            records[subject_id] = item
            conflicts = _site_conflicts(_with_held(records, held), [subject_id])
            if conflicts:
                raise ValueError(site_conflict_message(conflicts[0][1]))
            self._write(records)
            self._prune_pending(pending, records)
            return {**item, "site": site}

    def import_csv(  # noqa: PLR0912, PLR0915
        self, csv_text: str, on_existing: str = "skip"
    ) -> dict[str, Any]:
        """Validate CSV text and atomically import every row, or apply nothing.

        Perform at most one atomic write under the per-path lock. Any error
        rejects the whole file, so a fatal failure leaves the persisted
        registry byte-identical. ``on_existing`` is the deterministic policy
        for subject IDs that are already registered: ``"skip"`` keeps the
        stored record and ``"update"`` revises it like a manual edit,
        preserving the stored QC annotations and raising the record revision
        by one.
        """
        if on_existing not in {"skip", "update"}:
            raise ValueError("Choose skip or update for already-registered subjects.")
        if not isinstance(csv_text, str):
            raise ValueError("Provide the CSV text to import.")
        rows, errors = _parse_import_csv(csv_text)
        imported = updated = skipped = 0
        applied = False
        warnings: list[dict[str, Any]] = []
        if not errors:
            with self._lock:
                records = self._read()
                pending, held = self._held_sites(records)
                now = _now_iso()
                changed = False
                written: list[str] = []
                row_of: dict[str, int] = {}
                for row in rows:
                    candidate = row["record"]
                    subject_id = candidate["subjectId"]
                    row_of[subject_id] = row["row"]
                    previous = records.get(subject_id)
                    if previous is not None and on_existing == "skip":
                        skipped += 1
                        warnings.append(
                            _issue(
                                row["row"],
                                f"Kept the existing record for {subject_id} "
                                "and skipped the row.",
                            )
                        )
                        continue
                    stored = previous or {}
                    written.append(subject_id)
                    records[subject_id] = {
                        "subjectId": subject_id,
                        "age": candidate["age"],
                        "sex": candidate["sex"],
                        "sourceCohortLabel": candidate["sourceCohortLabel"],
                        "cohortRole": cohort_role(candidate["sourceCohortLabel"]),
                        "ais": candidate["ais"],
                        "tSinceSci": candidate["tSinceSci"],
                        "t1Availability": "missing",
                        "runnable": False,
                        "unavailableReason": (
                            "Refresh discovery for this registry record."
                        ),
                        "qc": stored.get("qc"),
                        "qcNote": stored.get("qcNote", ""),
                        "qcTags": list(stored.get("qcTags", [])),
                        "revision": int(stored.get("revision", 0)) + 1,
                        "updatedAt": now,
                    }
                    # A file without a site column keeps each stored site, and
                    # a new record takes the site set before registration.
                    _with_site(
                        records[subject_id],
                        candidate["site"]
                        if "site" in candidate
                        else stored.get("site", held.get(subject_id)),
                    )
                    changed = True
                    if previous is None:
                        imported += 1
                    else:
                        updated += 1
                        warnings.append(
                            _issue(
                                row["row"],
                                f"Replaced the existing record for {subject_id}.",
                            )
                        )
                    warnings.extend(
                        _issue(row["row"], message) for message in row["warnings"]
                    )
                site_conflicts = _site_conflicts(_with_held(records, held), written)
                if site_conflicts:
                    errors.extend(
                        _issue(row_of[subject_id], site_conflict_message(conflict))
                        for subject_id, conflict in site_conflicts
                    )
                elif len(records) > _MAX_REGISTRY_RECORDS:
                    errors.append(
                        _issue(
                            None,
                            "Reject the import because the registry would "
                            "exceed the bounded record limit.",
                        )
                    )
                else:
                    serialized = (
                        json.dumps(
                            {"schemaVersion": 1, "records": records},
                            indent=2,
                            sort_keys=True,
                        )
                        + "\n"
                    )
                    if len(serialized.encode("utf-8")) > _MAX_REGISTRY_BYTES:
                        errors.append(
                            _issue(
                                None,
                                "Reject the import because the registry would "
                                "exceed the bounded size limit.",
                            )
                        )
                    else:
                        if changed:
                            self._write(records)
                            self._prune_pending(pending, records)
                        applied = True
        if not applied:
            imported = updated = skipped = 0
            # Keep row-scoped parse warnings visible so the operator can fix
            # them in the same editing pass as the errors.
            warnings = [
                _issue(row["row"], message)
                for row in rows
                for message in row["warnings"]
            ]
        errors.sort(key=_issue_order)
        warnings.sort(key=_issue_order)
        return {
            "applied": applied,
            "imported": imported,
            "updated": updated,
            "skipped": skipped,
            "errors": errors[:_MAX_IMPORT_ISSUES],
            "warnings": warnings[:_MAX_IMPORT_ISSUES],
            "errorTotal": len(errors),
            "warningTotal": len(warnings),
        }

    def set_site(
        self,
        subject_ids: Sequence[str],
        site: str | None,
        expected_revisions: Mapping[str, int],
    ) -> dict[str, Any]:
        """Set or clear the site of every named subject in one request.

        A registered subject's record takes the site; its stored revision must
        match ``expected_revisions`` (``_STALE_UPSERT``) and rises by one. A
        subject without a record, named with revision 0, has the site held in
        ``pending-sites.json`` until registration adopts it: a record requires
        sex and a cohort label, which a site must not invent. Return
        ``{"site": label | None, "updated": count}``. Clearing removes the key,
        so the record's bytes match a record that never had a site. A subject
        that already holds the requested site is not written and not counted.
        """
        targets = _set_site_targets(subject_ids, expected_revisions)
        label = normalize_site_label(site)
        with self._lock:
            records = self._read()
            pending, held = self._held_sites(records)
            if any(
                int(records[subject_id].get("revision", 0)) != revision
                if subject_id in records
                else revision != 0
                for subject_id, revision in targets.items()
            ):
                raise OperatorError(_STALE_UPSERT)
            # A subject that already holds the label is left alone, so a repeat
            # request writes nothing and the registry bytes (bound by the
            # clinical and final receipts) stay the same.
            changed = [
                subject_id
                for subject_id in targets
                if subject_id in records and records[subject_id].get("site") != label
            ]
            held_changed = [
                subject_id
                for subject_id in targets
                if subject_id not in records and held.get(subject_id) != label
            ]
            now = _now_iso()
            for subject_id in changed:
                item = dict(records[subject_id])
                item["revision"] = int(item.get("revision", 0)) + 1
                item["updatedAt"] = now
                records[subject_id] = _with_site(item, label)
            for subject_id in held_changed:
                if label is None:
                    held.pop(subject_id, None)
                else:
                    held[subject_id] = label
            conflicts = _site_conflicts(
                _with_held(records, held),
                [*changed, *(subject_id for subject_id in held_changed if label)],
            )
            if conflicts:
                raise ValueError(site_conflict_message(conflicts[0][1]))
            if len(held) > _MAX_REGISTRY_RECORDS:
                raise ValueError(
                    "Register some subjects before holding more sites; the held "
                    "site list is full."
                )
            if changed:
                self._write(records)
            if held_changed or len(held) != len(pending):
                self._write_pending(held)
            return {"site": label, "updated": len(changed) + len(held_changed)}

    def _prune_pending(
        self, pending: Mapping[str, str], records: Mapping[str, Any]
    ) -> None:
        """Drop held sites whose subjects now have a record."""
        if any(subject_id in records for subject_id in pending):
            self._write_pending(
                {
                    subject_id: site
                    for subject_id, site in pending.items()
                    if subject_id not in records
                }
            )

    def remove(self, subject_id: str, expected_revision: int | None = None) -> None:
        """Atomically remove one record when its revision still matches."""
        with self._lock:
            records = self._read()
            previous = records.get(subject_id)
            if previous is None:
                return
            if expected_revision is not None and int(expected_revision) != int(
                previous.get("revision", 0)
            ):
                raise OperatorError(
                    "Resolve the registry revision conflict by refreshing the record."
                )
            del records[subject_id]
            self._write(records)
