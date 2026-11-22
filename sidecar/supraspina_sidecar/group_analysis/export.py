"""The tables of one export (``groupAnalysis.exportData``).

Main writes the files; the sidecar only renders their text: the results CSV,
the optional per-subject CSV (it contains participant IDs), and the
specification JSON with the result's identity and input digests. The results
CSV and the specification JSON carry no participant IDs: the JSON lists the
sample as counts by group and by exclusion reason.

A v2 result's results CSV has one row per term and measure, keyed by
``term_id``, read from the whole stored record (main adds ``terms.csv`` and
``grid.csv`` beside it, not a second copy of these rows); its per-subject CSV
follows the stored detail layout: one row per model, measure, and subject,
naming the test, the stratum, and the terms that model serves.

Numbers are written with Python's shortest round-trip form, so a re-read
value equals the stored one; a missing value is an empty cell. A text cell
that a spreadsheet would run as a formula is prefixed with an apostrophe.
"""

from __future__ import annotations

import csv
import io
import json
from collections.abc import Iterable, Mapping
from typing import Any

EXPORT_SCHEMA = "supraspina/group-analysis-export"

#: The results CSV columns and the row field each one reads.
RESULT_COLUMNS: tuple[tuple[str, str], ...] = (
    ("measure_id", "measureId"),
    ("family", "family"),
    ("n_total", "nTotal"),
    ("n_focal", "nFocal"),
    ("n_reference", "nReference"),
    ("estimate", "estimate"),
    ("se", "se"),
    ("t", "t"),
    ("df", "df"),
    ("p", "p"),
    ("p_corrected", "pCorrected"),
    ("significant", "significant"),
    ("d", "d"),
    ("d_low", "dLow"),
    ("d_high", "dHigh"),
    ("d_raw_sd", "dRawSd"),
    ("partial_eta2", "partialEta2"),
    ("pct_of_reference", "pctOfReference"),
    ("p_hc3", "pHc3"),
    ("p_permutation", "pPermutation"),
)
#: The v2 results CSV columns: one row per term and measure.
RESULT_COLUMNS_V2: tuple[tuple[str, str], ...] = (
    ("term_id", "termId"),
    ("measure_id", "measureId"),
    ("family", "family"),
    ("in_family", "inFamily"),
    ("n_total", "nTotal"),
    ("n_focal", "nFocal"),
    ("n_reference", "nReference"),
    ("estimate", "estimate"),
    ("se", "se"),
    ("t", "t"),
    ("F", "F"),
    ("df1", "df1"),
    ("df2", "df2"),
    ("p", "p"),
    ("p_corrected", "pCorrected"),
    ("significant", "significant"),
    ("gated", "gated"),
    ("d", "d"),
    ("d_low", "dLow"),
    ("d_high", "dHigh"),
    ("d_raw_sd", "dRawSd"),
    ("partial_eta2", "partialEta2"),
    ("partial_r", "partialR"),
    ("partial_r_low", "partialRLow"),
    ("partial_r_high", "partialRHigh"),
    ("slope_per_sd", "slopePerSd"),
    ("pct_of_reference", "pctOfReference"),
    ("p_hc3", "pHc3"),
    ("p_permutation", "pPermutation"),
)
#: The v2 per-subject CSV columns: one row per model, measure, and subject.
SUBJECT_COLUMNS_V2: tuple[str, ...] = (
    "test_id",
    "stratum",
    "term_ids",
    "measure_id",
    "subject_id",
    "group",
    "source_label",
    "value",
    "adjusted",
    "x",
)
SUBJECT_COLUMNS: tuple[str, ...] = (
    "measure_id",
    "subject_id",
    "group",
    "source_label",
    "value",
    "adjusted",
    "x",
)
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return repr(value)
    text = str(value)
    return f"'{text}" if text.startswith(_FORMULA_PREFIXES) else text


def _csv(header: Iterable[str], rows: Iterable[Iterable[Any]]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(list(header))
    for row in rows:
        writer.writerow([_cell(value) for value in row])
    return buffer.getvalue()


def _v2(record: Mapping[str, Any]) -> bool:
    return record.get("schemaVersion") == 2  # noqa: PLR2004


def results_csv(record: Mapping[str, Any]) -> str:
    """Render the results table of a stored result.

    A v1 result has one row per measure; a v2 result one row per term and
    measure, in term order.
    """
    columns = RESULT_COLUMNS_V2 if _v2(record) else RESULT_COLUMNS
    rows = record["rows"]
    if _v2(record):
        order = {term["termId"]: index for index, term in enumerate(record["terms"])}
        rows = sorted(rows, key=lambda row: order.get(row["termId"], len(order)))
    return _csv(
        (column for column, _field in columns),
        ([row.get(field) for _column, field in columns] for row in rows),
    )


def subject_rows(record: Mapping[str, Any], measure_id: str) -> list[dict[str, Any]]:
    """Return one measure's ``AnalysisSubjectValue`` rows from a stored record."""
    detail = record["detail"]
    info = detail.get("subjects", {})
    entry = detail.get("measures", {}).get(measure_id)
    if entry is None:
        return []
    rows = []
    for subject_id, value, adjusted, x in entry["values"]:
        group, source_label = info.get(subject_id, (None, None))
        rows.append(
            {
                "subjectId": subject_id,
                "group": group,
                "sourceLabel": source_label,
                "value": value,
                "adjusted": adjusted,
                "x": x,
            }
        )
    return rows


def subject_rows_v2(record: Mapping[str, Any]) -> list[list[Any]]:
    """Return a v2 record's per-subject rows in the stored detail layout.

    One row per model (a test in one stratum, or one pair fitted on its two
    groups), measure, and subject, in model then measure order; a record
    stored without per-subject values has none.
    """
    detail = record["detail"]
    if not detail.get("subjectValues"):
        return []
    ids, sources = detail["subjectIds"], detail["sourceLabels"]
    values = detail.get("values", {})
    served: dict[str, list[str]] = {}
    for term_id, key in detail.get("terms", {}).items():
        served.setdefault(key, []).append(term_id)
    order = {term["termId"]: index for index, term in enumerate(record["terms"])}
    measure_order = {measure_id: index for index, measure_id in enumerate(values)}
    rows: list[list[Any]] = []
    for key, model in detail.get("models", {}).items():
        terms = sorted(served.get(key, []), key=lambda term: order.get(term, 0))
        labels, xs = model["labels"], model["x"]
        measures = sorted(
            model.get("measures", {}).items(),
            key=lambda item: measure_order.get(item[0], len(measure_order)),
        )
        for measure_id, entry in measures:
            measured = values.get(measure_id)
            if measured is None or "rows" not in entry:
                continue
            for index, adjusted in zip(entry["rows"], entry["adjusted"], strict=True):
                rows.append(
                    [
                        model["testId"],
                        model["stratum"],
                        ";".join(terms),
                        measure_id,
                        ids[index],
                        labels[index],
                        sources[index],
                        measured[index],
                        adjusted,
                        None if xs is None else xs[index],
                    ]
                )
    return rows


def subjects_csv(record: Mapping[str, Any]) -> str:
    """Render the per-subject values of a stored result, measure by measure."""
    if _v2(record):
        return _csv(SUBJECT_COLUMNS_V2, subject_rows_v2(record))
    rows = (
        [
            row["measureId"],
            item["subjectId"],
            item["group"],
            item["sourceLabel"],
            item["value"],
            item["adjusted"],
            item["x"],
        ]
        for row in record["rows"]
        for item in subject_rows(record, row["measureId"])
    )
    return _csv(SUBJECT_COLUMNS, rows)


def spec_json(record: Mapping[str, Any]) -> str:
    """Render the specification with the result identity and input digests."""
    sample = record["sample"]
    reasons: dict[str, int] = {}
    for item in sample["excluded"]:
        reasons[item["reason"]] = reasons.get(item["reason"], 0) + 1
    document = {
        "schema": EXPORT_SCHEMA,
        "schemaVersion": 1,
        "resultId": record["resultId"],
        "resultSha256": record["resultSha256"],
        "name": record["name"],
        "specId": record["specId"],
        "specDigest": record["specDigest"],
        "createdAt": record["createdAt"],
        "provisional": record["provisional"],
        "engine": record["engine"],
        "stageCurrency": record["stageCurrency"],
        "inputs": record["inputs"],
        "sample": {
            "groups": sample["groups"],
            "included": sample["included"],
            "excludedByReason": dict(sorted(reasons.items())),
            "issues": list(sample.get("issues", [])),
        },
        "skipped": record["skipped"],
        "spec": record["spec"],
    }
    return json.dumps(document, indent=2, sort_keys=True, allow_nan=False) + "\n"


def export_payload(record: Mapping[str, Any], *, subject_csv: bool) -> dict[str, Any]:
    """Return the ``GroupAnalysisExportData`` payload of a stored result.

    Returns
    -------
    dict
        The result identity, provisionality, and the file texts.
    """
    files = [{"name": "results.csv", "text": results_csv(record)}]
    if subject_csv:
        files.append({"name": "subjects.csv", "text": subjects_csv(record)})
    files.append({"name": "spec.json", "text": spec_json(record)})
    return {
        "resultId": record["resultId"],
        "name": record["name"],
        "provisional": bool(record["provisional"]),
        "files": files,
    }
