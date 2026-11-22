"""One measure's detail of a stored v2 result (numpy-free).

The worker stores, per model (a test in one unit, or one pair fitted on its
two groups), each measure's adjusted group means, the rows it used with
their adjusted values, the residual variance, and the fitted lines in a
compact form: ``y(x) = intercept + slope (x - xMean)`` with the unscaled
variances ``v00``, ``v01``, ``v11`` of the intercept and slope contrasts, so
the band is ``t * sqrt(s2 (v00 + 2 dx v01 + dx^2 v11))``. This module turns
that into ``GroupAnalysisMeasureDetailV2``: 50 points per line and, for an
interaction, each group's simple slope with its 95% CI (descriptive).
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from . import distributions
from .spec import GroupAnalysisError

#: The points of each fitted line.
LINE_POINTS = 50
_CI_LEVEL = 0.95


def _quantile(df: int) -> float:
    return distributions.t_ppf((1.0 + _CI_LEVEL) / 2.0, float(df))


def line_point(
    line: Mapping[str, Any], s2: float, df: int, x: float
) -> tuple[float, float, float]:
    """Return the fitted value and its 95% CI at ``x``.

    Parameters
    ----------
    line
        One stored compact line.
    s2
        The measure's residual variance.
    df
        The residual degrees of freedom.
    x
        The value of the tested variable or moderator.

    Returns
    -------
    tuple of float
        The fitted value, the lower bound, and the upper bound.
    """
    dx = x - line["xMean"]
    y = line["intercept"] + line["slope"] * dx
    variance = line["v00"] + 2.0 * dx * line["v01"] + dx * dx * line["v11"]
    half = _quantile(df) * math.sqrt(max(variance, 0.0) * s2)
    return y, y - half, y + half


def fit_lines(entry: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return the ``AnalysisFitLine`` rows of one measure's stored detail."""
    lines = []
    for line in entry.get("lines", []):
        low_x, high_x = line["xMin"], line["xMax"]
        step = (high_x - low_x) / (LINE_POINTS - 1)
        xs = [low_x + index * step for index in range(LINE_POINTS - 1)] + [high_x]
        points = [line_point(line, entry["s2"], entry["df"], x) for x in xs]
        lines.append(
            {
                "group": line["group"],
                "x": xs,
                "y": [point[0] for point in points],
                "low": [point[1] for point in points],
                "high": [point[2] for point in points],
            }
        )
    return lines


def simple_slopes(entry: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return each group's simple slope with its 95% CI (an interaction)."""
    slopes = []
    for line in entry.get("lines", []):
        if line["group"] is None:
            continue
        half = _quantile(entry["df"]) * math.sqrt(max(line["v11"], 0.0) * entry["s2"])
        slopes.append(
            {
                "group": line["group"],
                "slope": line["slope"],
                "low": line["slope"] - half,
                "high": line["slope"] + half,
            }
        )
    return slopes


def _term(record: Mapping[str, Any], term_id: str | None) -> dict[str, Any]:
    terms = record["terms"]
    if term_id is None:
        return terms[0]
    term = next((item for item in terms if item["termId"] == term_id), None)
    if term is None:
        raise GroupAnalysisError("Select a term this result contains.")
    return term


def measure_detail(
    record: Mapping[str, Any], term_id: str | None, measure_id: str
) -> dict[str, Any]:
    """Return ``GroupAnalysisMeasureDetailV2`` for one term and measure.

    Parameters
    ----------
    record
        A stored v2 result.
    term_id
        The term, or None for the first.

    Returns
    -------
    dict
        The term's row, the adjusted group means (roles follow a pairwise
        term's pair), the subject values (``x`` is the tested variable or the
        moderator), the fitted lines, and the simple slopes.

    Raises
    ------
    GroupAnalysisError
        For an unknown term, or a measure the term has no row for.
    """
    term = _term(record, term_id)
    row = next(
        (
            item
            for item in record["rows"]
            if item["termId"] == term["termId"] and item["measureId"] == measure_id
        ),
        None,
    )
    if row is None:
        raise GroupAnalysisError("Select a measure this result contains.")
    detail = record["detail"]
    model = detail.get("models", {}).get(
        detail.get("terms", {}).get(term["termId"]), {}
    )
    entry = model.get("measures", {}).get(measure_id)
    if entry is None:
        return {
            "resultId": record["resultId"],
            "measureId": measure_id,
            "termId": term["termId"],
            "row": row,
            "groupMeans": [],
            "subjects": [],
            "fit": [],
            "simpleSlopes": [],
        }
    means = [dict(item) for item in entry["groupMeans"]]
    pair = term.get("pair")
    if pair is not None:
        for item in means:
            item["role"] = (
                "focal"
                if item["label"] == pair["focal"]
                else "reference"
                if item["label"] == pair["reference"]
                else "other"
            )
    subjects = []
    values = detail.get("values", {}).get(measure_id)
    if detail.get("subjectValues") and values is not None and "rows" in entry:
        ids, sources = detail["subjectIds"], detail["sourceLabels"]
        labels, xs = model["labels"], model["x"]
        subjects = [
            {
                "subjectId": ids[index],
                "group": labels[index],
                "sourceLabel": sources[index],
                "value": values[index],
                "adjusted": adjusted,
                "x": None if xs is None else xs[index],
            }
            for index, adjusted in zip(entry["rows"], entry["adjusted"], strict=True)
        ]
    return {
        "resultId": record["resultId"],
        "measureId": measure_id,
        "termId": term["termId"],
        "row": row,
        "groupMeans": means,
        "subjects": subjects,
        "fit": fit_lines(entry),
        "simpleSlopes": simple_slopes(entry),
    }


def strip_subject_values(detail: dict[str, Any]) -> dict[str, Any]:
    """Return the detail without per-subject values (a record over its cap)."""
    models = {
        key: {
            **model,
            "measures": {
                measure_id: {
                    name: value
                    for name, value in entry.items()
                    if name not in {"rows", "adjusted"}
                }
                for measure_id, entry in model["measures"].items()
            },
        }
        for key, model in detail["models"].items()
    }
    return {**detail, "values": {}, "models": models, "subjectValues": False}
