"""Bounded output-schema and exact cohort-membership evidence."""

from __future__ import annotations

import csv
import os
import re
import zipfile
from typing import Any
from xml.etree import ElementTree

from .cohort import CohortSnapshot

_ID_COLUMNS = ("ID", "SubjectID", "Subject_ID", "participant_id", "SubjID", "subject")
_MAX_TABLE_BYTES = 64 * 1024 * 1024
_MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
_MAX_ROWS = 1_000_000
# Bound tabular reads at 1,024 columns. Accommodate the reviewed 658-column
# FreeSurfer 8.2 aggregate output, and leave exact aggregate-schema validation
# to downstream consumers.
_MAX_COLUMNS = 1024
_MAX_ARCHIVE_MEMBERS = 100_000
_MAX_FIELD_BYTES = 1024 * 1024
_MAX_COMPRESSION_RATIO = 1_000
csv.field_size_limit(_MAX_FIELD_BYTES)


def _csv_table(path: str) -> tuple[list[str], list[dict[str, str]]]:
    if os.path.getsize(path) > _MAX_TABLE_BYTES:
        raise ValueError("Keep the CSV within the bounded membership limit.")
    with open(path, newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        header = list(reader.fieldnames or [])
        if len(header) > _MAX_COLUMNS:
            raise ValueError("Reduce the CSV because it has too many columns.")
        rows = []
        for index, row in enumerate(reader):
            if index >= _MAX_ROWS:
                raise ValueError("Reduce the CSV because it has too many rows.")
            rows.append(dict(row))
    return header, rows


def _safe_xml(data: bytes) -> ElementTree.Element:
    """Parse bounded OOXML only after rejecting DTD and entity declarations."""
    upper = data.upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        raise ValueError("Remove OOXML declarations.")
    return ElementTree.fromstring(data)  # noqa: S314 - Reject DTDs and entities above.


def _read_member(archive: zipfile.ZipFile, name: str) -> bytes:
    try:
        info = archive.getinfo(name)
    except KeyError:
        raise
    if info.flag_bits & 0x1:
        raise ValueError("Use an unencrypted OOXML member.")
    if info.file_size > _MAX_TABLE_BYTES:
        raise ValueError("Keep the OOXML member within the size limit.")
    if (
        info.compress_size
        and info.file_size / info.compress_size > _MAX_COMPRESSION_RATIO
    ):
        raise ValueError("Use a safe OOXML member-compression ratio.")
    data = archive.read(info)
    if len(data) != info.file_size:
        raise ValueError("Resolve the OOXML member length mismatch.")
    return data


def _xlsx_table(  # noqa: PLR0912, PLR0915
    path: str,
) -> tuple[list[str], list[list[str]]]:
    """Read the first XLSX worksheet using only the standard library."""
    if os.path.getsize(path) > _MAX_ARCHIVE_BYTES:
        raise ValueError("Keep the XLSX within the bounded membership limit.")
    with zipfile.ZipFile(path) as archive:
        total = 0
        members = archive.infolist()
        if len(members) > _MAX_ARCHIVE_MEMBERS:
            raise ValueError("Reduce the XLSX because it has too many archive members.")
        for info in members:
            normalized = info.filename.replace("\\", "/")
            if normalized.startswith("/") or ".." in normalized.split("/"):
                raise ValueError("Remove the unsafe member path from the XLSX archive.")
            total += info.file_size
            if total > _MAX_ARCHIVE_BYTES:
                raise ValueError("Keep the expanded size of the XLSX within the limit.")
        shared: list[str] = []
        try:
            root = _safe_xml(_read_member(archive, "xl/sharedStrings.xml"))
            for item in root:
                if len(shared) >= _MAX_ROWS * _MAX_COLUMNS:
                    raise ValueError(
                        "Keep the XLSX shared-string table within the limit."
                    )
                shared.append(
                    "".join(
                        node.text or ""
                        for node in item.iter()
                        if node.tag.endswith("}t")
                    )
                )
        except KeyError:
            pass
        workbook = _safe_xml(_read_member(archive, "xl/workbook.xml"))
        relations = _safe_xml(_read_member(archive, "xl/_rels/workbook.xml.rels"))
        targets = {
            relation.attrib["Id"]: relation.attrib["Target"] for relation in relations
        }
        sheet = next(node for node in workbook.iter() if node.tag.endswith("}sheet"))
        relation_id = next(
            value for key, value in sheet.attrib.items() if key.endswith("}id")
        )
        target = targets[relation_id]
        sheet_path = "xl/" + target.lstrip("/").removeprefix("xl/")
        if ".." in sheet_path.replace("\\", "/").split("/"):
            raise ValueError("Provide a safe XLSX worksheet relation.")
        data = _safe_xml(_read_member(archive, sheet_path))
        rows: list[list[str]] = []
        for row in (node for node in data.iter() if node.tag.endswith("}row")):
            if len(rows) >= _MAX_ROWS + 1:
                raise ValueError("Reduce the XLSX because it has too many rows.")
            values: dict[int, str] = {}
            for cell in (node for node in row if node.tag.endswith("}c")):
                ref = cell.attrib.get("r", "A1")
                letters = re.match(r"[A-Z]+", ref)
                column = 0
                for letter in letters.group(0) if letters else "A":
                    column = column * 26 + ord(letter) - 64
                if column < 1 or column > _MAX_COLUMNS:
                    raise ValueError("Reduce the XLSX because it has too many columns.")
                raw = next(
                    (
                        node.text or ""
                        for node in cell.iter()
                        if node.tag.endswith("}v")
                    ),
                    "",
                )
                if cell.attrib.get("t") == "s" and raw.isdigit():
                    index = int(raw)
                    if index >= len(shared):
                        raise ValueError("Provide a valid XLSX shared-string index.")
                    raw = shared[index]
                elif cell.attrib.get("t") == "inlineStr":
                    raw = "".join(
                        node.text or ""
                        for node in cell.iter()
                        if node.tag.endswith("}t")
                    )
                if len(raw.encode("utf-8", errors="replace")) > _MAX_FIELD_BYTES:
                    raise ValueError(
                        "Reduce the XLSX because the cell exceeds the field limit."
                    )
                values[column - 1] = raw
            rows.append(
                [values.get(index, "") for index in range(max(values, default=-1) + 1)]
            )
    return (rows[0] if rows else []), rows[1:]


def _membership(
    ids: list[str],
    expected: tuple[str, ...],
    *,
    allow_subset: bool = False,
    allow_duplicates: bool = False,
) -> dict[str, Any]:
    clean = [str(value).strip() for value in ids if str(value).strip()]
    duplicates = len(clean) - len(set(clean))
    extras = sorted(set(clean) - set(expected))
    missing = sorted(set(expected) - set(clean))
    # Long-format tables such as outliers.csv legitimately repeat one id
    # across rows, so duplicates are fatal only for one-row-per-subject
    # tables; unknown ids stay fatal in every table shape.
    exact = (
        (allow_duplicates or not duplicates)
        and not extras
        and (allow_subset or not missing)
    )
    return {
        "state": "exact" if exact else "mismatch",
        "rowCount": len(clean),
        "expectedCount": len(expected),
        "duplicates": duplicates,
        "missingCount": len(missing),
        "extraCount": len(extras),
        "allowSubset": allow_subset,
        "allowDuplicates": allow_duplicates,
    }


def enrich_evidence(
    step_key: str,
    evidence: dict[str, Any],
    cfg: dict[str, Any],
    cohort: CohortSnapshot,
) -> dict[str, Any]:
    """Attach exact header/membership proof for cohort tabular transforms."""
    if evidence.get("state") != "done":
        return evidence
    paths = [
        item.get("path") if isinstance(item, dict) else item
        for item in evidence.get("artifacts", [])
    ]
    paths = [str(path) for path in paths if path]
    memberships: list[dict[str, Any]] = []
    try:
        if step_key in {
            "enigma",
            "features",
            "age",
            "pybrainage",
            "aggregate",
            "outliers",
        }:
            csv_paths = [path for path in paths if path.lower().endswith(".csv")]
            if step_key == "enigma":
                csv_paths = [
                    path
                    for path in csv_paths
                    if os.path.basename(path) != "subjects.txt"
                ]
            for path in csv_paths:
                header, rows = _csv_table(path)
                id_column = next(
                    (column for column in _ID_COLUMNS if column in header),
                    header[0] if header else "",
                )
                if step_key == "pybrainage" and header != [
                    "ID",
                    "Age",
                    "BrainAge",
                    "BrainPAD",
                ]:
                    memberships.append(
                        {"state": "schema-mismatch", "path": path, "header": header[:8]}
                    )
                    continue
                # outliers.csv is a long-format table with one row per
                # flagged subject, structure, and direction, so repeated
                # SubjID values and absent unflagged subjects are the
                # expected shape rather than a cohort mismatch.
                is_long_format = step_key == "outliers"
                result = _membership(
                    [row.get(id_column, "") for row in rows],
                    cohort.analysis_subject_ids,
                    allow_subset=is_long_format,
                    allow_duplicates=is_long_format,
                )
                result["path"] = path
                result["idColumn"] = id_column
                memberships.append(result)
        elif step_key == "clinical":
            workbook = next(path for path in paths if path.lower().endswith(".xlsx"))
            header, rows = _xlsx_table(workbook)
            id_index = header.index("Subject_ID")
            result = _membership(
                [row[id_index] if id_index < len(row) else "" for row in rows],
                cohort.analysis_subject_ids,
            )
            result["path"] = workbook
            result["idColumn"] = "Subject_ID"
            memberships.append(result)
    except (
        OSError,
        ValueError,
        KeyError,
        IndexError,
        StopIteration,
        OverflowError,
        UnicodeError,
        csv.Error,
        zipfile.BadZipFile,
        ElementTree.ParseError,
    ) as exc:
        memberships.append({"state": "unknown", "error": type(exc).__name__})
    if memberships:
        evidence = dict(evidence)
        evidence["membership"] = memberships
        if any(item.get("state") != "exact" for item in memberships):
            evidence["state"] = "partial"
            evidence["detail"] = (
                "Regenerate complete, matching output cohort and schema evidence."
            )
    return evidence
