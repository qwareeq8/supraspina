"""The OLS, correction, and Freedman-Lane max-T engine against the reference goldens."""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from supraspina_sidecar.group_analysis import engine
from supraspina_sidecar.group_analysis.dataset import Dataset
from supraspina_sidecar.group_analysis.spec import GroupAnalysisError, parse_spec

FIXTURES = Path(__file__).parent / "fixtures" / "group_analysis"
DATA = json.loads((FIXTURES / "engine-dataset.json").read_text(encoding="utf-8"))
GOLDENS = json.loads((FIXTURES / "engine-goldens.json").read_text(encoding="utf-8"))
CASES = {case["name"]: case for case in GOLDENS["cases"]}
RTOL = 1e-9
ATOL = 1e-12
#: Row fields that are permutation counts over B + 1, compared exactly.
EXACT_FLOATS = {"pPermutation"}


def _dataset(case: dict[str, Any], data: dict[str, Any] = DATA) -> Dataset:
    spec = case["spec"]
    grouping = spec["contrast"].get("grouping")
    label_of = {}
    if grouping is not None:
        for group in grouping["groups"]:
            for level in group["levels"]:
                label_of[level] = group["label"]
    covariates = {}
    for key in case["covariates"]:
        source = key.removeprefix("extra:")
        covariates[key] = data["covariates"].get(source, data["variables"].get(source))
    return Dataset(
        subject_ids=list(data["subjects"]),
        groups=[label_of.get(c) for c in data["cohorts"]],
        source_labels=list(data["cohorts"]),
        covariates=covariates,
        tested=data["variables"][case["tested"]] if case["tested"] else None,
        measures={m: data["measures"][m] for m in spec["measures"]},
        subjects=[],
        skipped=[],
        inputs=[],
    )


def _run(case: dict[str, Any], dataset: Dataset | None = None, **kwargs: Any) -> Any:
    return engine.run(
        dataset or _dataset(case),
        parse_spec(case["spec"]),
        progress=kwargs.get("progress", lambda *_: None),
        cancelled=kwargs.get("cancelled", lambda: False),
    )


def _close(field: str, actual: Any, expected: Any) -> None:
    if expected is None or isinstance(expected, (bool, int, str)):
        assert actual == expected, field
        return
    assert isinstance(actual, float), field
    assert math.isfinite(actual), field
    assert abs(actual - expected) <= RTOL * abs(expected) + ATOL, (
        field,
        actual,
        expected,
    )


def _case(name: str, **inference: Any) -> dict[str, Any]:
    case = copy.deepcopy(CASES[name])
    case["spec"]["inference"].update(inference)
    return case


# ------------------------------------------------------------- Goldens --
@pytest.mark.parametrize("name", sorted(CASES))
def test_engine_reproduces_the_reference_goldens(name: str) -> None:
    case = CASES[name]
    expected = case["expected"]
    out = _run(case)
    assert out.skipped == []
    assert [row["measureId"] for row in out.rows] == [
        row["measureId"] for row in expected["rows"]
    ]
    exact_corrected = case["spec"]["inference"]["correction"] == "maxt-fwe"
    for row, want in zip(out.rows, expected["rows"], strict=True):
        assert set(row) == set(want)
        for field, value in want.items():
            if field in EXACT_FLOATS or (field == "pCorrected" and exact_corrected):
                assert row[field] == value, (row["measureId"], field)
            else:
                _close(f"{row['measureId']}.{field}", row[field], value)
    for measure_id, means in expected["groupMeans"].items():
        assert len(out.group_means[measure_id]) == len(means)
        for mine, want in zip(out.group_means[measure_id], means, strict=True):
            for field, value in want.items():
                _close(f"{measure_id} mean {field}", mine[field], value)
    for measure_id, subjects in expected["subjectValues"].items():
        mine = out.subject_values[measure_id]
        assert [s["subjectId"] for s in mine] == [s["subjectId"] for s in subjects]
        for got, want in zip(mine, subjects, strict=True):
            for field, value in want.items():
                _close(f"{measure_id} subject {field}", got[field], value)


def test_goldens_cover_the_model_surface() -> None:
    specs = [case["spec"] for case in GOLDENS["cases"]]
    assert {s["inference"]["sidedness"] for s in specs} == {
        "two-sided",
        "lower",
        "higher",
    }
    assert {s["inference"]["correction"] for s in specs} == {
        "maxt-fwe",
        "holm",
        "bh-fdr",
        "bonferroni",
        "none",
    }
    assert {s["analysis"] for s in specs} == {
        "group-comparison",
        "association",
        "brain-age",
    }
    assert {s["contrast"].get("model") for s in specs} >= {
        "all-groups",
        "compared-groups",
    }
    assert {s["covariates"]["etiv"] for s in specs} >= {"extensive", "all"}
    # The synthetic cohort: n 88 (50/30/8), stored unsorted, with missing cells.
    assert sorted(DATA["cohorts"].count(c) for c in set(DATA["cohorts"])) == [8, 30, 50]
    assert DATA["subjects"] != sorted(DATA["subjects"])
    missing = sum(v is None for values in DATA["measures"].values() for v in values)
    assert missing > 20


def test_row_order_follows_the_spec_and_skips_absent_measures() -> None:
    case = _case("sci-vs-ctrl-maxt-selected", correction="none", permutations=0)
    measures = list(reversed(case["spec"]["measures"]))
    case["spec"]["measures"] = measures
    dataset = _dataset(case)
    del dataset.measures[measures[0]]
    out = _run(case, dataset)
    assert [row["measureId"] for row in out.rows] == measures[1:]
    assert all(
        row["pCorrected"] is None and row["pPermutation"] is None for row in out.rows
    )
    assert all(row["significant"] == (row["p"] <= 0.05) for row in out.rows)


def test_corrections_are_invariant_to_permutation_chunking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    case = CASES["sci-vs-ctrl-maxt-selected"]
    whole = _run(case)
    monkeypatch.setattr(engine, "PERMUTATION_CHUNK", 7)
    chunked = _run(case)
    for a, b in zip(whole.rows, chunked.rows, strict=True):
        assert a["pPermutation"] == b["pPermutation"]
        assert a["pCorrected"] == b["pCorrected"]


# ------------------------------------------------------ Permutations --
def test_permutation_chunks_reproduce_the_pcg64_stream() -> None:
    reference = np.random.default_rng(20260923)
    expected = np.array([reference.permutation(88) for _ in range(23)])
    for chunk in (1, 5, 23, 500):
        got = np.concatenate(list(engine.permutation_chunks(20260923, 88, 23, chunk)))
        assert np.array_equal(got, expected)
    assert list(engine.permutation_chunks(1, 5, 0)) == []


def test_induced_positions_keep_the_permuted_order() -> None:
    perms = np.array([[4, 0, 3, 1, 2], [2, 4, 1, 0, 3]])
    rows = np.array([0, 2, 4])
    got = engine.induced_positions(perms, rows, 5)
    # Row 0 lists 4, 0, 2 (positions 2, 0, 1); row 1 lists 2, 4, 0.
    assert got.tolist() == [[2, 0, 1], [1, 2, 0]]
    assert engine.induced_positions(perms, np.arange(5), 5) is perms


def test_progress_and_cancellation() -> None:
    case = _case("sci-vs-ctrl-maxt-selected", permutations=1000)
    events: list[tuple[str, int, int]] = []
    _run(case, progress=lambda *event: events.append(event))
    measures = len(case["spec"]["measures"])
    assert events[0] == ("fitting", 0, measures)
    assert ("fitting", measures, measures) in events
    permuting = [e for e in events if e[0] == "permuting"]
    assert permuting[0] == ("permuting", 0, 1000)
    assert permuting[-1] == ("permuting", 1000, 1000)
    assert [e[1] for e in permuting] == sorted(e[1] for e in permuting)

    polls = []

    def cancel_in_permutations() -> bool:
        polls.append(1)
        return any(e[0] == "permuting" for e in events_two)

    events_two: list[tuple[str, int, int]] = []
    with pytest.raises(engine.ComputeCancelled):
        _run(
            case,
            progress=lambda *event: events_two.append(event),
            cancelled=cancel_in_permutations,
        )
    assert events_two[-1] == ("permuting", 0, 1000)
    with pytest.raises(engine.ComputeCancelled):
        _run(case, cancelled=lambda: True)


# ------------------------------------------------------ Model details --
def _synthetic(n: int = 30, seed: int = 4) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return a tiny two-group case and its data for edge-case tests."""
    rng = np.random.default_rng(seed)
    groups = ["A"] * (n // 2) + ["B"] * (n - n // 2)
    data = {
        "subjects": [f"s{i:02d}" for i in range(n)],
        "cohorts": groups,
        "covariates": {
            "age": [float(v) for v in rng.uniform(20, 60, n)],
            "sex": [float(v) for v in rng.integers(0, 2, n)],
            "eTIV": [float(v) for v in rng.normal(1.5e6, 1e5, n)],
        },
        "variables": {"x": [float(v) for v in rng.normal(size=n)]},
        "measures": {
            "dk:lh:precentral:ThickAvg": [float(v) for v in rng.normal(2.5, 0.1, n)],
            "aseg:Brain-Stem": [float(v) for v in rng.normal(21000, 900, n)],
            "global:eTIV": [float(v) for v in rng.normal(1.5e6, 1e5, n)],
        },
    }
    case = {
        "covariates": ["age", "sex", "eTIV"],
        "tested": None,
        "spec": {
            "schema": "supraspina/group-analysis-spec",
            "schemaVersion": 1,
            "analysis": "group-comparison",
            "measures": list(data["measures"]),
            "contrast": {
                "type": "groups",
                "grouping": {
                    "variable": {"source": "registry", "column": "sourceCohortLabel"},
                    "groups": [
                        {"label": "A", "levels": ["A"]},
                        {"label": "B", "levels": ["B"]},
                    ],
                },
                "focal": "B",
                "reference": "A",
                "model": "all-groups",
            },
            "covariates": {
                "age": {"source": "registry", "column": "age"},
                "sex": {"source": "registry", "column": "sex"},
                "etiv": "extensive",
                "extra": [],
                "centering": "sample-mean",
            },
            "inclusion": {"qc": "all", "registration": "keep", "outliers": "keep"},
            "inference": {
                "sidedness": "two-sided",
                "correction": "none",
                "family": "selected",
                "alpha": 0.05,
                "permutations": 0,
                "seed": 1,
            },
        },
    }
    return case, data


def _ols(y: np.ndarray, x: np.ndarray, j: int) -> tuple[float, float, int]:
    beta, *_ = np.linalg.lstsq(x, y, rcond=None)
    residual = y - x @ beta
    df = len(y) - x.shape[1]
    s2 = residual @ residual / df
    vjj = np.linalg.inv(x.T @ x)[j, j]
    return float(beta[j]), float(beta[j] / math.sqrt(s2 * vjj)), df


def test_etiv_rule_and_constant_covariates_follow_the_design() -> None:
    case, data = _synthetic()
    data["covariates"]["sex"] = [0.0] * 30  # Constant: dropped, not rank loss.
    out = engine.run(
        _dataset(case, data),
        parse_spec(case["spec"]),
        progress=lambda *_: None,
        cancelled=lambda: False,
    )
    rows = {row["measureId"]: row for row in out.rows}
    group = np.array([1.0 if g == "B" else 0.0 for g in data["cohorts"]])
    age = np.array(data["covariates"]["age"])
    etiv = np.array(data["covariates"]["eTIV"])
    base = [np.ones(30), group, age - age.mean()]
    thickness = np.array(data["measures"]["dk:lh:precentral:ThickAvg"])
    stem = np.array(data["measures"]["aseg:Brain-Stem"])
    own_etiv = np.array(data["measures"]["global:eTIV"])
    for measure_id, y, columns in (
        ("dk:lh:precentral:ThickAvg", thickness, base),
        ("aseg:Brain-Stem", stem, [*base, etiv - etiv.mean()]),
        ("global:eTIV", own_etiv, base),  # Never adjusted for itself.
    ):
        beta, t, df = _ols(y, np.column_stack(columns), 1)
        assert rows[measure_id]["estimate"] == pytest.approx(beta, rel=1e-10)
        assert rows[measure_id]["t"] == pytest.approx(t, rel=1e-10)
        assert rows[measure_id]["df"] == df


def test_etiv_is_required_only_when_a_measure_takes_it() -> None:
    case, data = _synthetic()
    del data["covariates"]["eTIV"]
    case["covariates"] = ["age", "sex"]
    spec = parse_spec(case["spec"])
    with pytest.raises(GroupAnalysisError, match="eTIV"):
        engine.run(
            _dataset(case, data),
            spec,
            progress=lambda *_: None,
            cancelled=lambda: False,
        )
    case["spec"]["measures"] = ["dk:lh:precentral:ThickAvg", "global:eTIV"]
    out = engine.run(
        _dataset(case, data),
        parse_spec(case["spec"]),
        progress=lambda *_: None,
        cancelled=lambda: False,
    )
    assert len(out.rows) == 2
    case["spec"]["measures"] = ["aseg:Brain-Stem"]
    case["spec"]["covariates"]["etiv"] = "none"
    out = engine.run(
        _dataset(case, data),
        parse_spec(case["spec"]),
        progress=lambda *_: None,
        cancelled=lambda: False,
    )
    assert out.rows[0]["df"] == 30 - 4


def test_measures_are_skipped_with_reasons() -> None:
    case, data = _synthetic()
    # Leave one B subject with a thickness value.
    b_rows = [i for i, g in enumerate(data["cohorts"]) if g == "B"]
    for i in b_rows[1:]:
        data["measures"]["dk:lh:precentral:ThickAvg"][i] = None
    # Make eTIV a copy of age for the extensive measure: rank deficient.
    data["covariates"]["eTIV"] = list(data["covariates"]["age"])
    out = engine.run(
        _dataset(case, data),
        parse_spec(case["spec"]),
        progress=lambda *_: None,
        cancelled=lambda: False,
    )
    reasons = {row["measureId"]: row["reason"] for row in out.skipped}
    assert reasons == {
        "dk:lh:precentral:ThickAvg": "Fewer than two subjects of B have this measure.",
        "aseg:Brain-Stem": "The model is rank deficient for the subjects with this measure.",
    }
    assert [row["measureId"] for row in out.rows] == ["global:eTIV"]


def test_constant_measures_are_skipped() -> None:
    case, data = _synthetic()
    data["measures"]["aseg:Brain-Stem"] = [0.0] * 30
    case["spec"]["inference"].update(correction="maxt-fwe", permutations=1000)
    out = engine.run(
        _dataset(case, data),
        parse_spec(case["spec"]),
        progress=lambda *_: None,
        cancelled=lambda: False,
    )
    assert out.skipped == [
        {
            "measureId": "aseg:Brain-Stem",
            "reason": "The measure is constant or fitted exactly by the model.",
        }
    ]
    assert [row["measureId"] for row in out.rows] == [
        "dk:lh:precentral:ThickAvg",
        "global:eTIV",
    ]
    assert all(row["pCorrected"] is not None for row in out.rows)


def test_too_few_subjects_leave_no_degrees_of_freedom() -> None:
    case, data = _synthetic(n=4)
    case["spec"]["measures"] = ["dk:lh:precentral:ThickAvg"]
    out = engine.run(
        _dataset(case, data),
        parse_spec(case["spec"]),
        progress=lambda *_: None,
        cancelled=lambda: False,
    )
    assert out.rows == []
    assert out.skipped == [
        {
            "measureId": "dk:lh:precentral:ThickAvg",
            "reason": (
                "The model has 4 parameters, so a fit needs 5 subjects with this "
                "measure; 4 have it."
            ),
        }
    ]


def test_association_without_grouping_and_constant_tested_variable() -> None:
    case, data = _synthetic()
    case["tested"] = "x"
    case["spec"]["analysis"] = "association"
    case["spec"]["contrast"] = {
        "type": "association",
        "variable": {"source": "metadata-csv", "column": "x"},
        "grouping": None,
        "includedGroups": [],
        "adjustForGroup": False,
    }
    case["spec"]["covariates"]["etiv"] = "none"
    data["variables"]["x"][3] = None
    out = engine.run(
        _dataset(case, data),
        parse_spec(case["spec"]),
        progress=lambda *_: None,
        cancelled=lambda: False,
    )
    keep = [i for i in range(30) if i != 3]
    x = np.array([data["variables"]["x"][i] for i in keep])
    age = np.array([data["covariates"]["age"][i] for i in keep])
    sex = np.array([data["covariates"]["sex"][i] for i in keep])
    y = np.array([data["measures"]["aseg:Brain-Stem"][i] for i in keep])
    design = np.column_stack(
        [np.ones(29), x - x.mean(), age - age.mean(), sex - sex.mean()]
    )
    beta, t, df = _ols(y, design, 1)
    row = next(r for r in out.rows if r["measureId"] == "aseg:Brain-Stem")
    assert row["estimate"] == pytest.approx(beta, rel=1e-10)
    assert row["t"] == pytest.approx(t, rel=1e-10)
    assert (row["nTotal"], row["df"]) == (29, df)
    assert (
        row["nFocal"] is row["nReference"] is row["d"] is row["pctOfReference"] is None
    )
    assert out.group_means["aseg:Brain-Stem"] == []
    subjects = out.subject_values["aseg:Brain-Stem"]
    assert [s["x"] for s in subjects] == pytest.approx(list(x))
    data["variables"]["x"] = [1.0] * 30
    out = engine.run(
        _dataset(case, data),
        parse_spec(case["spec"]),
        progress=lambda *_: None,
        cancelled=lambda: False,
    )
    assert out.rows == []
    assert {row["reason"] for row in out.skipped} == {
        "The tested variable is constant among the subjects with this measure."
    }


def test_association_needs_its_tested_variable() -> None:
    case = copy.deepcopy(CASES["association-tsi-sci-extra-covariate"])
    dataset = _dataset(case)
    dataset.tested = None
    with pytest.raises(GroupAnalysisError, match="tested variable"):
        _run(case, dataset)


def test_infinite_values_are_rejected() -> None:
    case, data = _synthetic()
    data["measures"]["aseg:Brain-Stem"][0] = math.inf
    with pytest.raises(GroupAnalysisError, match="infinite"):
        engine.run(
            _dataset(case, data),
            parse_spec(case["spec"]),
            progress=lambda *_: None,
            cancelled=lambda: False,
        )


def test_single_subject_group_keeps_hc3_finite() -> None:
    case, data = _synthetic()
    data["cohorts"][0] = "C"  # A third group of one subject: leverage 1.
    groups = case["spec"]["contrast"]["grouping"]["groups"]
    groups.append({"label": "C", "levels": ["C"]})
    out = engine.run(
        _dataset(case, data),
        parse_spec(case["spec"]),
        progress=lambda *_: None,
        cancelled=lambda: False,
    )
    for row in out.rows:
        assert 0.0 <= row["pHc3"] <= 1.0
    roles = [m["role"] for m in out.group_means["aseg:Brain-Stem"]]
    assert roles == ["reference", "focal", "other"]


def test_empty_other_group_is_dropped_from_the_design() -> None:
    case, data = _synthetic()
    groups = case["spec"]["contrast"]["grouping"]["groups"]
    groups.append({"label": "C", "levels": ["C"]})
    out = engine.run(
        _dataset(case, data),
        parse_spec(case["spec"]),
        progress=lambda *_: None,
        cancelled=lambda: False,
    )
    assert out.skipped == []
    assert [m["label"] for m in out.group_means["aseg:Brain-Stem"]] == ["A", "B"]


def test_adjusted_means_and_values_agree() -> None:
    case = CASES["sci-vs-ctrl-maxt-selected"]
    out = _run(_case(case["name"], correction="none", permutations=0))
    for measure_id, subjects in out.subject_values.items():
        means = {m["label"]: m for m in out.group_means[measure_id]}
        for label, mean in means.items():
            adjusted = [s["adjusted"] for s in subjects if s["group"] == label]
            # With group indicators, the adjusted values average to the model mean.
            assert np.mean(adjusted) == pytest.approx(mean["mean"], rel=1e-10)
            assert mean["low"] < mean["mean"] < mean["high"]
        row = next(r for r in out.rows if r["measureId"] == measure_id)
        assert means["SCI"]["mean"] - means["CTRL"]["mean"] == pytest.approx(
            row["estimate"], rel=1e-9, abs=1e-12
        )


# --------------------------------------------------------- Corrections --
def test_corrections_match_r_p_adjust() -> None:
    p = [0.01, 0.04, 0.03, 0.005, 0.2]
    # R: p.adjust(p, "BH"), "holm", "bonferroni".
    assert engine.bh(p) == pytest.approx([0.025, 0.05, 0.05, 0.025, 0.2])
    assert engine.holm(p) == pytest.approx([0.04, 0.09, 0.09, 0.025, 0.2])
    assert engine.bonferroni(p) == pytest.approx([0.05, 0.2, 0.15, 0.025, 1.0])
    assert engine.bh([0.9, 0.95]) == pytest.approx([0.95, 0.95])
    assert engine.holm([0.6, 0.7]) == [1.0, 1.0]
    assert engine.bh([]) == engine.holm([]) == engine.bonferroni([]) == []
