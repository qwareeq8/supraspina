"""Tests for bounded output-cohort membership evidence behavior."""

from __future__ import annotations

import csv
import zipfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from supraspina_sidecar import membership
from supraspina_sidecar.cohort import CohortSnapshot


def _cohort(*subject_ids: str) -> CohortSnapshot:
    return CohortSnapshot(
        analysis_subject_ids=subject_ids,
        selected_subject_ids=subject_ids,
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(),
        qc_verdicts=(),
        qc_acknowledged=True,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def _write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


def _cell(reference: str, value: str, *, kind: str = "inlineStr") -> str:
    if kind == "inlineStr":
        return f'<c r="{reference}" t="inlineStr"><is><t>{value}</t></is></c>'
    return f'<c r="{reference}" t="{kind}"><v>{value}</v></c>'


def _write_xlsx(
    path: Path,
    rows: list[list[tuple[str, str]]],
    *,
    relation_target: str = "worksheets/sheet1.xml",
    shared_strings: list[str] | None = None,
    extra_members: dict[str, bytes] | None = None,
) -> None:
    sheet_rows = []
    for row_number, row in enumerate(rows, start=1):
        cells = "".join(
            _cell(f"{chr(65 + column)}{row_number}", value, kind=kind)
            for column, (value, kind) in enumerate(row)
        )
        sheet_rows.append(f'<row r="{row_number}">{cells}</row>')
    sheet_xml = (
        '<worksheet xmlns="urn:sheet"><sheetData>'
        + "".join(sheet_rows)
        + "</sheetData></worksheet>"
    ).encode()
    workbook_xml = (
        b'<workbook xmlns="urn:book" '
        b'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        b'<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>'
        b"</workbook>"
    )
    relations_xml = (
        '<Relationships xmlns="urn:rels">'
        f'<Relationship Id="rId1" Target="{relation_target}"/>'
        "</Relationships>"
    ).encode()
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xl/workbook.xml", workbook_xml)
        archive.writestr("xl/_rels/workbook.xml.rels", relations_xml)
        archive.writestr("xl/worksheets/sheet1.xml", sheet_xml)
        if shared_strings is not None:
            archive.writestr(
                "xl/sharedStrings.xml",
                (
                    '<sst xmlns="urn:strings">'
                    + "".join(f"<si><t>{value}</t></si>" for value in shared_strings)
                    + "</sst>"
                ).encode(),
            )
        for name, data in (extra_members or {}).items():
            archive.writestr(name, data)


@pytest.mark.parametrize(
    ("ids", "expected", "allow_subset", "state", "duplicates", "missing", "extras"),
    [
        (["sub-01", "sub-02"], ("sub-01", "sub-02"), False, "exact", 0, 0, 0),
        ([" sub-01 ", ""], ("sub-01", "sub-02"), True, "exact", 0, 1, 0),
        (["sub-01", "sub-01"], ("sub-01",), False, "mismatch", 1, 0, 0),
        (["sub-01", "sub-extra"], ("sub-01",), False, "mismatch", 0, 0, 1),
        (["sub-01"], ("sub-01", "sub-02"), False, "mismatch", 0, 1, 0),
    ],
)
def test_membership_classifies_exact_subset_and_mismatch(  # noqa: PLR0913
    ids: list[str],
    expected: tuple[str, ...],
    allow_subset: bool,
    state: str,
    duplicates: int,
    missing: int,
    extras: int,
) -> None:
    result = membership._membership(ids, expected, allow_subset=allow_subset)

    assert result == {
        "state": state,
        "rowCount": len([value for value in ids if value.strip()]),
        "expectedCount": len(expected),
        "duplicates": duplicates,
        "missingCount": missing,
        "extraCount": extras,
        "allowSubset": allow_subset,
        "allowDuplicates": False,
    }


def test_membership_allow_duplicates_accepts_repeats_but_not_extras() -> None:
    # Long-format tables repeat ids legitimately; unknown ids stay fatal.
    repeated = membership._membership(
        ["sub-01", "sub-01"], ("sub-01",), allow_duplicates=True
    )
    assert repeated["state"] == "exact"
    assert repeated["duplicates"] == 1
    unknown = membership._membership(
        ["sub-01", "sub-extra"], ("sub-01",), allow_duplicates=True
    )
    assert unknown["state"] == "mismatch"
    assert unknown["extraCount"] == 1


def test_csv_reader_accepts_bom_and_preserves_rows(tmp_path: Path) -> None:
    path = tmp_path / "cohort.csv"
    path.write_text("\ufeffID,Score\r\nsub-01,1\r\n", encoding="utf-8")

    header, rows = membership._csv_table(str(path))

    assert header == ["ID", "Score"]
    assert rows == [{"ID": "sub-01", "Score": "1"}]


def test_csv_reader_enforces_size_column_and_row_bounds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "cohort.csv"
    _write_csv(path, ["ID", "Score"], [["sub-01", "1"]])
    monkeypatch.setattr(membership, "_MAX_TABLE_BYTES", 1)
    with pytest.raises(ValueError, match="bounded membership"):
        membership._csv_table(str(path))

    monkeypatch.setattr(membership, "_MAX_TABLE_BYTES", 1024)
    monkeypatch.setattr(membership, "_MAX_COLUMNS", 1)
    with pytest.raises(ValueError, match="too many columns"):
        membership._csv_table(str(path))

    monkeypatch.setattr(membership, "_MAX_COLUMNS", 2)
    monkeypatch.setattr(membership, "_MAX_ROWS", 0)
    with pytest.raises(ValueError, match="too many rows"):
        membership._csv_table(str(path))


@pytest.mark.parametrize("declaration", [b"<!DOCTYPE x>", b"<!ENTITY x 'value'>"])
def test_safe_xml_rejects_active_declarations(declaration: bytes) -> None:
    with pytest.raises(ValueError, match="declarations"):
        membership._safe_xml(declaration + b"<root/>")


def test_safe_xml_parses_plain_xml() -> None:
    assert (
        membership._safe_xml(b"<root><value>ok</value></root>").findtext("value")
        == "ok"
    )


class _ArchiveStub:
    def __init__(self, info: Any, data: bytes) -> None:
        self.info = info
        self.data = data

    def getinfo(self, name: str) -> Any:
        if name == "missing":
            raise KeyError(name)
        return self.info

    def read(self, _info: Any) -> bytes:
        return self.data


def test_member_reader_rejects_missing_encrypted_large_and_inconsistent_entries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    normal = SimpleNamespace(flag_bits=0, file_size=4, compress_size=4)
    archive = _ArchiveStub(normal, b"data")
    assert membership._read_member(archive, "ok") == b"data"  # type: ignore[arg-type]
    with pytest.raises(KeyError):
        membership._read_member(archive, "missing")  # type: ignore[arg-type]

    encrypted = SimpleNamespace(flag_bits=1, file_size=4, compress_size=4)
    with pytest.raises(ValueError, match="encrypted"):
        membership._read_member(_ArchiveStub(encrypted, b"data"), "x")  # type: ignore[arg-type]

    monkeypatch.setattr(membership, "_MAX_TABLE_BYTES", 3)
    with pytest.raises(ValueError, match="size limit"):
        membership._read_member(archive, "x")  # type: ignore[arg-type]

    monkeypatch.setattr(membership, "_MAX_TABLE_BYTES", 100_000)
    ratio = SimpleNamespace(flag_bits=0, file_size=10_001, compress_size=1)
    with pytest.raises(ValueError, match="compression ratio"):
        membership._read_member(_ArchiveStub(ratio, b"x" * 10_001), "x")  # type: ignore[arg-type]

    inconsistent = SimpleNamespace(flag_bits=0, file_size=5, compress_size=5)
    with pytest.raises(ValueError, match="length mismatch"):
        membership._read_member(_ArchiveStub(inconsistent, b"data"), "x")  # type: ignore[arg-type]


def test_xlsx_reader_supports_shared_and_inline_strings(tmp_path: Path) -> None:
    path = tmp_path / "cohort.xlsx"
    _write_xlsx(
        path,
        [
            [("0", "s"), ("Score", "inlineStr")],
            [("1", "s"), ("42", "n")],
        ],
        shared_strings=["Subject_ID", "sub-01"],
    )

    header, rows = membership._xlsx_table(str(path))

    assert header == ["Subject_ID", "Score"]
    assert rows == [["sub-01", "42"]]


def test_xlsx_reader_accepts_workbook_without_rows_or_shared_strings(
    tmp_path: Path,
) -> None:
    path = tmp_path / "empty.xlsx"
    _write_xlsx(path, [])

    assert membership._xlsx_table(str(path)) == ([], [])


def test_xlsx_reader_rejects_archive_size_and_path_hazards(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "cohort.xlsx"
    _write_xlsx(
        path,
        [[("Subject_ID", "inlineStr")]],
        extra_members={"xl/large-padding.bin": b"0" * 10_000},
    )
    monkeypatch.setattr(membership, "_MAX_ARCHIVE_BYTES", 1)
    with pytest.raises(ValueError, match="bounded membership"):
        membership._xlsx_table(str(path))

    monkeypatch.setattr(membership, "_MAX_ARCHIVE_BYTES", 1024 * 1024)
    monkeypatch.setattr(membership, "_MAX_ARCHIVE_MEMBERS", 1)
    with pytest.raises(ValueError, match="too many archive members"):
        membership._xlsx_table(str(path))

    monkeypatch.setattr(membership, "_MAX_ARCHIVE_MEMBERS", 100)
    path = tmp_path / "unsafe.xlsx"
    _write_xlsx(
        path,
        [[("Subject_ID", "inlineStr")]],
        extra_members={"../escape": b"unsafe"},
    )
    with pytest.raises(ValueError, match="unsafe member path"):
        membership._xlsx_table(str(path))


def test_xlsx_reader_rejects_expanded_size_and_unsafe_relation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "cohort.xlsx"
    _write_xlsx(
        path,
        [[("Subject_ID", "inlineStr")]],
        extra_members={"xl/large-padding.bin": b"0" * 10_000},
    )
    monkeypatch.setattr(membership, "_MAX_ARCHIVE_BYTES", path.stat().st_size)
    with pytest.raises(ValueError, match="expanded size"):
        membership._xlsx_table(str(path))

    monkeypatch.setattr(membership, "_MAX_ARCHIVE_BYTES", 1024 * 1024)
    path = tmp_path / "relation.xlsx"
    _write_xlsx(
        path,
        [[("Subject_ID", "inlineStr")]],
        relation_target="../escape.xml",
    )
    with pytest.raises(ValueError, match="worksheet relation"):
        membership._xlsx_table(str(path))


def test_xlsx_reader_rejects_invalid_shared_index_column_row_and_field_bounds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "index.xlsx"
    _write_xlsx(path, [[("9", "s")]], shared_strings=["only-entry"])
    with pytest.raises(ValueError, match="shared-string index"):
        membership._xlsx_table(str(path))

    path = tmp_path / "column.xlsx"
    _write_xlsx(
        path,
        [
            [("value", "inlineStr"), ("other", "inlineStr")],
            [("second", "inlineStr")],
        ],
    )
    monkeypatch.setattr(membership, "_MAX_COLUMNS", 1)
    with pytest.raises(ValueError, match="too many columns"):
        membership._xlsx_table(str(path))

    monkeypatch.setattr(membership, "_MAX_COLUMNS", 512)
    monkeypatch.setattr(membership, "_MAX_ROWS", 0)
    with pytest.raises(ValueError, match="too many rows"):
        membership._xlsx_table(str(path))

    monkeypatch.setattr(membership, "_MAX_ROWS", 100)
    monkeypatch.setattr(membership, "_MAX_FIELD_BYTES", 2)
    with pytest.raises(ValueError, match="cell exceeds"):
        membership._xlsx_table(str(path))


def test_enrich_evidence_leaves_pending_and_non_tabular_steps_unchanged() -> None:
    pending = {"state": "pending", "artifacts": []}
    done = {"state": "done", "artifacts": []}

    assert (
        membership.enrich_evidence("features", pending, {}, _cohort("sub-01"))
        is pending
    )
    assert membership.enrich_evidence("recon", done, {}, _cohort("sub-01")) is done


@pytest.mark.parametrize(
    ("step_key", "header", "rows", "expected_state", "allow_subset"),
    [
        ("features", ["participant_id", "Value"], [["sub-01", "1"]], "done", False),
        ("age", ["ID", "Value"], [["sub-01", "1"]], "done", False),
        ("outliers", ["SubjID", "Value"], [["sub-01", "1"]], "done", True),
        # A subject flagged in two structures repeats in the long-format
        # outliers table and must stay a completed cohort.
        (
            "outliers",
            ["SubjID", "Value"],
            [["sub-01", "1"], ["sub-01", "2"]],
            "done",
            True,
        ),
        # A flagged subject outside the analysis cohort stays fatal even
        # though the outliers table allows duplicates and subsets.
        (
            "outliers",
            ["SubjID", "Value"],
            [["sub-01", "1"], ["sub-extra", "2"]],
            "partial",
            True,
        ),
        ("aggregate", ["Unexpected", "Value"], [["sub-01", "1"]], "done", False),
        ("features", ["ID", "Value"], [["sub-extra", "1"]], "partial", False),
        # One-row-per-subject tables keep duplicates fatal.
        (
            "age",
            ["ID", "Value"],
            [["sub-01", "1"], ["sub-01", "2"]],
            "partial",
            False,
        ),
    ],
)
def test_enrich_evidence_classifies_csv_cohort_membership(  # noqa: PLR0913
    tmp_path: Path,
    step_key: str,
    header: list[str],
    rows: list[list[str]],
    expected_state: str,
    allow_subset: bool,
) -> None:
    path = tmp_path / f"{step_key}.csv"
    _write_csv(path, header, rows)

    result = membership.enrich_evidence(
        step_key,
        {"state": "done", "artifacts": [{"path": str(path)}, None]},
        {},
        _cohort("sub-01"),
    )

    assert result["state"] == expected_state
    assert result["membership"][0]["allowSubset"] is allow_subset
    assert result["membership"][0]["idColumn"] == header[0]
    if expected_state == "partial":
        assert (
            result["detail"]
            == "Regenerate complete, matching output cohort and schema evidence."
        )


def test_enrich_evidence_accepts_full_aggregate_column_contract(
    tmp_path: Path,
) -> None:
    path = tmp_path / "dk_all_stats.csv"
    header = ["subject", *(f"metric_{index}" for index in range(657))]
    _write_csv(path, header, [["sub-01", *("1" for _ in range(657))]])

    result = membership.enrich_evidence(
        "aggregate",
        {"state": "done", "artifacts": [{"path": str(path)}]},
        {},
        _cohort("sub-01"),
    )

    assert len(header) == 658
    assert result["state"] == "done"
    assert result["membership"][0]["state"] == "exact"


def test_enrich_evidence_filters_enigma_subjects_manifest(tmp_path: Path) -> None:
    manifest = tmp_path / "subjects.txt"
    _write_csv(manifest, ["ID"], [["sub-extra"]])
    actual = tmp_path / "enigma.csv"
    _write_csv(actual, ["ID"], [["sub-01"]])

    result = membership.enrich_evidence(
        "enigma",
        {"state": "done", "artifacts": [str(manifest), str(actual)]},
        {},
        _cohort("sub-01"),
    )

    assert result["state"] == "done"
    assert [Path(item["path"]).name for item in result["membership"]] == ["enigma.csv"]


def test_enrich_evidence_requires_exact_pybrainage_schema(tmp_path: Path) -> None:
    path = tmp_path / "predictions.csv"
    _write_csv(path, ["ID", "BrainAge"], [["sub-01", "42"]])

    result = membership.enrich_evidence(
        "pybrainage",
        {"state": "done", "artifacts": [str(path)]},
        {},
        _cohort("sub-01"),
    )

    assert result["state"] == "partial"
    assert result["membership"] == [
        {
            "state": "schema-mismatch",
            "path": str(path),
            "header": ["ID", "BrainAge"],
        }
    ]


def test_enrich_evidence_reads_clinical_workbook(tmp_path: Path) -> None:
    path = tmp_path / "clinical.xlsx"
    _write_xlsx(
        path,
        [
            [("Subject_ID", "inlineStr"), ("Cohort", "inlineStr")],
            [("sub-01", "inlineStr"), ("control", "inlineStr")],
        ],
    )

    result = membership.enrich_evidence(
        "clinical",
        {"state": "done", "artifacts": [str(path)]},
        {},
        _cohort("sub-01"),
    )

    assert result["state"] == "done"
    assert result["membership"][0]["idColumn"] == "Subject_ID"
    assert result["membership"][0]["rowCount"] == 1


@pytest.mark.parametrize(
    "step_key",
    ["features", "clinical"],
)
def test_enrich_evidence_records_bounded_parse_failures(
    tmp_path: Path, step_key: str
) -> None:
    suffix = ".csv" if step_key == "features" else ".xlsx"
    path = tmp_path / f"bad{suffix}"
    path.write_bytes(b"\xff" if step_key == "features" else b"not a valid table")

    result = membership.enrich_evidence(
        step_key,
        {"state": "done", "artifacts": [str(path)]},
        {},
        _cohort("sub-01"),
    )

    assert result["state"] == "partial"
    assert result["membership"][0]["state"] == "unknown"
    assert result["membership"][0]["error"] in {
        "BadZipFile",
        "Error",
        "UnicodeDecodeError",
    }
