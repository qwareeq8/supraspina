"""Tests for the export tables of a stored result."""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.group_analysis import export, store
from supraspina_sidecar.group_analysis.result_detail import strip_subject_values
from tests.group_analysis_support import sample_record
from tests.test_group_analysis_engine_v2 import CASES
from tests.test_group_analysis_worker_v2 import _RESULT_ID, _run


def _record() -> dict:
    record = sample_record("gar-00000000000000aa", "2026-09-30T12:00:00.000Z")
    record["pinned"] = False
    record["resultSha256"] = store.result_digest(record)
    return record


def test_the_results_csv_has_one_row_per_measure_with_exact_numbers() -> None:
    rows = list(csv.reader(io.StringIO(export.results_csv(_record()))))

    assert rows[0] == [column for column, _field in export.RESULT_COLUMNS]
    assert len(rows) == 2
    values = dict(zip(rows[0], rows[1], strict=True))
    assert values["measure_id"] == "aseg:Brain-Stem"
    assert values["estimate"] == "-800.5"
    assert float(values["p"]) == 0.0123
    assert values["significant"] == "true"
    assert values["p_permutation"] == ""
    assert values["n_total"] == "10"


def test_the_subjects_csv_escapes_formula_text() -> None:
    rows = list(csv.reader(io.StringIO(export.subjects_csv(_record()))))

    assert rows[0] == list(export.SUBJECT_COLUMNS)
    assert rows[1] == [
        "aseg:Brain-Stem",
        "sub-01",
        "CTRL",
        "'=CTRL",
        "20000.5",
        "20001.0",
        "",
    ]
    assert rows[2][1] == "sub-06"


def test_the_spec_json_carries_identity_and_no_participant_ids() -> None:
    record = _record()
    text = export.spec_json(record)
    document = json.loads(text)

    assert document["schema"] == export.EXPORT_SCHEMA
    assert document["resultSha256"] == record["resultSha256"]
    assert document["spec"] == record["spec"]
    assert document["sample"] == {
        "groups": record["sample"]["groups"],
        "included": 10,
        "excludedByReason": {"no-measures": 2, "qc-failed": 1},
        "issues": [],
    }
    assert "sub-" not in text

    issue = "The ENIGMA outlier table is missing, so the outlier rule was not applied."
    record["sample"]["issues"] = [issue]
    assert json.loads(export.spec_json(record))["sample"]["issues"] == [issue]


def test_the_payload_includes_the_subject_csv_only_when_asked() -> None:
    record = _record()

    plain = export.export_payload(record, subject_csv=False)
    full = export.export_payload(record, subject_csv=True)

    assert [item["name"] for item in plain["files"]] == ["results.csv", "spec.json"]
    assert [item["name"] for item in full["files"]] == [
        "results.csv",
        "subjects.csv",
        "spec.json",
    ]
    assert plain["resultId"] == record["resultId"]
    assert plain["provisional"] is False
    assert export.subject_rows(record, "aseg:Optic-Chiasm") == []


def _v2_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str
) -> dict[str, Any]:
    status, events = _run(tmp_path, monkeypatch, CASES[name])
    assert status == 0, events
    record = store.read_result(str(tmp_path), _RESULT_ID)
    assert record is not None
    return record


def test_a_v2_results_csv_has_one_row_per_term_and_measure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    record = _v2_record(tmp_path, monkeypatch, "omnibus-pairwise-maxt-pooled")
    rows = list(csv.DictReader(io.StringIO(export.results_csv(record))))

    assert list(rows[0]) == [column for column, _f in export.RESULT_COLUMNS_V2]
    assert len(rows) == len(record["rows"])
    assert [row["term_id"] for row in rows] == sorted(
        (row["term_id"] for row in rows), key=lambda term: int(term[5:])
    )
    first = rows[0]
    stored = next(
        row
        for row in record["rows"]
        if row["termId"] == first["term_id"] and row["measureId"] == first["measure_id"]
    )
    # The omnibus F row leaves the t columns empty and keeps exact numbers.
    assert first["t"] == ""
    assert float(first["F"]) == stored["F"]
    assert first["df1"] == "2"
    assert first["in_family"] == "true"
    assert {row["gated"] for row in rows} <= {"true", "false"}


def test_a_v2_subjects_csv_follows_the_detail_layout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    record = _v2_record(tmp_path, monkeypatch, "omnibus-pairwise-maxt-pooled")
    rows = list(csv.DictReader(io.StringIO(export.subjects_csv(record))))

    assert list(rows[0]) == list(export.SUBJECT_COLUMNS_V2)
    detail = record["detail"]
    # Every model with values gives one row per measure and subject.
    expected = sum(
        len(entry["rows"])
        for model in detail["models"].values()
        for entry in model["measures"].values()
    )
    assert len(rows) == expected
    # The omnibus model serves the F term and the pairs that share it.
    served = {row["term_ids"] for row in rows}
    assert any("term-1" in item.split(";") for item in served)
    first = rows[0]
    assert first["test_id"] == record["spec"]["tests"][0]["id"]
    assert first["stratum"] == ""
    assert first["subject_id"].startswith("sub-")
    measured = detail["values"][first["measure_id"]]
    assert float(first["value"]) in measured


def test_a_v2_record_without_subject_values_has_an_empty_subjects_csv(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    record = _v2_record(tmp_path, monkeypatch, "battery-missingness-bh")
    record["detail"] = strip_subject_values(record["detail"])

    text = export.subjects_csv(record)

    assert text == ",".join(export.SUBJECT_COLUMNS_V2) + "\n"
    payload = export.export_payload(record, subject_csv=True)
    assert [item["name"] for item in payload["files"]] == [
        "results.csv",
        "subjects.csv",
        "spec.json",
    ]
    assert json.loads(payload["files"][2]["text"])["spec"] == record["spec"]
