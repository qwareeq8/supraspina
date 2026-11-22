"""The v2 engine against independent statsmodels goldens and the v1 engine."""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.group_analysis import (
    distributions,
    engine,
    engine_v2,
    result_detail,
)
from supraspina_sidecar.group_analysis.engine import ComputeCancelled
from supraspina_sidecar.group_analysis.engine_input import (
    EngineDataV2,
    level_text,
    sample_groups,
)
from supraspina_sidecar.group_analysis.spec import GroupAnalysisError, parse_spec
from tests.group_analysis_v2_support import upgraded_input
from tests.test_group_analysis_engine import GOLDENS as V1_GOLDENS
from tests.test_group_analysis_engine import _dataset as v1_dataset

FIXTURES = Path(__file__).parent / "fixtures" / "group_analysis"
DATA = json.loads((FIXTURES / "engine-dataset.json").read_text(encoding="utf-8"))
GOLDENS = json.loads((FIXTURES / "engine-goldens-v2.json").read_text(encoding="utf-8"))
CASES = {case["name"]: case for case in GOLDENS["cases"]}
RTOL = 1e-9
ATOL = 1e-12
#: Fields compared exactly: permutation counts over B + 1, and the flags.
EXACT = {"pPermutation", "significant", "gated", "inFamily", "termId", "measureId"}


def case_input(case: dict[str, Any]) -> EngineDataV2:
    """Lay the synthetic cohort out as the v2 dataset layer would."""
    keep = [
        i
        for i, cohort in enumerate(DATA["cohorts"])
        if case["population"] is None or cohort in case["population"]
    ]
    columns = {
        "cohort": DATA["cohorts"],
        "score": DATA["variables"]["score"],
        "tsi": DATA["variables"]["tsi"],
        "age": DATA["covariates"]["age"],
        **GOLDENS["variables"],
    }
    variables = {
        GOLDENS["keys"][name]: [values[i] for i in keep]
        for name, values in columns.items()
    }
    return EngineDataV2(
        subject_ids=[DATA["subjects"][i] for i in keep],
        source_labels=[DATA["cohorts"][i] for i in keep],
        variables=variables,
        covariates={
            key: [DATA["covariates"][key][i] for i in keep]
            for key in case["covariates"]
        },
        measures={
            key: [values[i] for i in keep] for key, values in DATA["measures"].items()
        },
        test_covariates={
            test_id: {name: [columns[name][i] for i in keep] for name in names}
            for test_id, names in case.get("testCovariates", {}).items()
        },
    )


def run_case(case: dict[str, Any], **kwargs: Any) -> engine_v2.EngineOutputV2:
    return engine_v2.run(
        case_input(case),
        parse_spec(case["spec"]),
        progress=kwargs.get("progress", lambda *_: None),
        cancelled=kwargs.get("cancelled", lambda: False),
    )


def close(field: str, actual: Any, expected: Any) -> None:
    if expected is None or isinstance(expected, (bool, str)) or field in EXACT:
        assert actual == expected, (field, actual, expected)
        return
    if isinstance(expected, int) and not isinstance(expected, bool):
        assert actual == expected, (field, actual, expected)
        return
    assert isinstance(actual, float), field
    assert math.isfinite(actual), field
    assert abs(actual - expected) <= RTOL * abs(expected) + ATOL, (
        field,
        actual,
        expected,
    )


def _record(out: engine_v2.EngineOutputV2) -> dict[str, Any]:
    return {
        "resultId": "gar-00000000000000b2",
        "terms": out.terms,
        "rows": out.rows,
        "detail": out.detail,
    }


# ------------------------------------------------------------- Goldens --
@pytest.mark.parametrize("name", sorted(CASES))
def test_engine_v2_reproduces_the_statsmodels_goldens(name: str) -> None:
    case = CASES[name]
    expected = case["expected"]
    out = run_case(case)
    assert out.skipped == []
    assert out.terms == expected["terms"]
    assert [(r["termId"], r["measureId"]) for r in out.rows] == [
        (r["termId"], r["measureId"]) for r in expected["rows"]
    ]
    for row, want in zip(out.rows, expected["rows"], strict=True):
        assert set(row) == set(want)
        for field, value in want.items():
            close(f"{row['termId']} {row['measureId']} {field}", row[field], value)
    record = _record(out)
    for term_id, want in expected["detail"].items():
        detail = result_detail.measure_detail(record, term_id, "aseg:Brain-Stem")
        assert [m["label"] for m in detail["groupMeans"]] == [
            m["label"] for m in want["groupMeans"]
        ]
        for mine, theirs in zip(detail["groupMeans"], want["groupMeans"], strict=True):
            for field in ("n", "mean", "low", "high"):
                close(f"{term_id} mean {field}", mine[field], theirs[field])
        model = out.detail["models"][out.detail["terms"][term_id]]
        entry = model["measures"]["aseg:Brain-Stem"]
        lines = {line["group"]: line for line in entry["lines"]}
        assert set(lines) == {line["group"] for line in want["lines"]}
        for line in want["lines"]:
            for x, y, low, high in line["points"]:
                got = result_detail.line_point(
                    lines[line["group"]], entry["s2"], entry["df"], x
                )
                for field, mine, theirs in zip(
                    ("y", "low", "high"), got, (y, low, high), strict=True
                ):
                    close(f"{term_id} line {field}", mine, theirs)
        slopes = result_detail.simple_slopes(entry)
        assert [s["group"] for s in slopes] == [
            s["group"] for s in want["simpleSlopes"]
        ]
        for mine, theirs in zip(slopes, want["simpleSlopes"], strict=True):
            for field in ("slope", "low", "high"):
                close(f"{term_id} slope {field}", mine[field], theirs[field])
        assert len(detail["fit"]) == len(want["lines"])
        for fit in detail["fit"]:
            assert len(fit["x"]) == result_detail.LINE_POINTS


def test_goldens_v2_cover_the_design_surface() -> None:
    specs = [case["spec"] for case in GOLDENS["cases"]]
    kinds = {test["kind"] for spec in specs for test in spec["tests"]}
    assert kinds == {"two-group", "omnibus", "association", "interaction"}
    terms = [term for case in GOLDENS["cases"] for term in case["expected"]["terms"]]
    assert {term["role"] for term in terms} == {"effect", "pairwise", "heterogeneity"}
    assert {(term["kind"], term["rank"]) for term in terms} >= {("t", 1), ("F", 2)}
    rows = [row for case in GOLDENS["cases"] for row in case["expected"]["rows"]]
    assert any(row["gated"] for row in rows)
    assert any(not row["gated"] and row["termId"] != "term-1" for row in rows)
    assert any(not row["inFamily"] and row["pCorrected"] is None for row in rows)
    assert any(row["pPermutation"] is not None for row in rows)
    assert any(row["significant"] for row in rows)
    assert {s["inference"]["family"] for s in specs} == {
        "all-tests",
        "per-test",
        "per-measure-family",
        "per-test-and-measure-family",
    }
    assert {s["inference"]["correction"] for s in specs} >= {
        "maxt-fwe",
        "holm",
        "bh-fdr",
    }
    transforms = {
        test[part]["transform"]
        for spec in specs
        for test in spec["tests"]
        for part in ("variable", "moderator")
        if test[part]
    }
    assert transforms == {"none", "log1p", "standardize"}
    # Per-test missingness: the battery's tests use different samples.
    battery = CASES["battery-missingness-bh"]["expected"]["rows"]
    assert len({row["nTotal"] for row in battery}) > 1


@pytest.mark.parametrize("case", GOLDENS["fSf"])
def test_f_sf_matches_scipy(case: dict[str, float]) -> None:
    value = distributions.f_sf(case["f"], case["df1"], case["df2"])
    assert abs(value - case["sf"]) <= 1e-12 * max(abs(case["sf"]), 1e-300) + 1e-300


def test_f_sf_edges() -> None:
    assert distributions.f_sf(0.0, 2, 10) == 1.0
    assert distributions.f_sf(math.inf, 2, 10) == 0.0
    with pytest.raises(ValueError, match="F quantile"):
        distributions.f_sf(math.nan, 2, 10)
    with pytest.raises(ValueError, match="degrees of freedom"):
        distributions.f_sf(1.0, 0, 10)


# --------------------------------------------------- Bit identity with v1 --
V1_CASES = {case["name"]: case for case in V1_GOLDENS["cases"]}


@pytest.mark.parametrize("name", sorted(V1_CASES))
def test_engine_v2_reproduces_v1_byte_for_byte(name: str) -> None:
    case = V1_CASES[name]
    dataset = v1_dataset(case)
    spec = parse_spec(case["spec"])
    v1 = engine.run(dataset, spec, progress=lambda *_: None, cancelled=lambda: False)
    data, upgraded = upgraded_input(dataset, spec)
    out = engine_v2.run(
        data, upgraded, progress=lambda *_: None, cancelled=lambda: False
    )
    assert out.skipped == v1.skipped
    assert [term["kind"] for term in out.terms] == ["t"]
    assert len(out.rows) == len(v1.rows)
    for mine, theirs in zip(out.rows, v1.rows, strict=True):
        for field, value in theirs.items():
            got = mine["df2" if field == "df" else field]
            # Identical values, and identical JSON bytes.
            assert got == value, (field, got, value)
            assert type(got) is type(value), (field, got, value)
            assert json.dumps(got) == json.dumps(value)
        assert mine["termId"] == "term-1"
        assert mine["df1"] == 1
    record = _record(out)
    adjusted_groups = (
        case["spec"]["contrast"]["type"] == "groups"
        or (case["spec"]["contrast"]["adjustForGroup"])
    )
    for measure_id, means in v1.group_means.items():
        detail = result_detail.measure_detail(record, None, measure_id)
        assert detail["groupMeans"] == means
        subjects = v1.subject_values[measure_id]
        assert len(detail["subjects"]) == len(subjects)
        for got, want in zip(detail["subjects"], subjects, strict=True):
            fields = set(want) - (set() if adjusted_groups else {"group"})
            assert {k: got[k] for k in fields} == {k: want[k] for k in fields}


# -------------------------------------------------------------- Behavior --
def _small_case(**inference: Any) -> dict[str, Any]:
    case = copy.deepcopy(CASES["omnibus-pairwise-maxt-pooled"])
    case["spec"]["inference"].update(inference)
    return case


def test_progress_reports_fitting_and_permuting() -> None:
    events: list[tuple[str, int, int]] = []
    run_case(_small_case(), progress=lambda *event: events.append(event))
    phases = [event[0] for event in events]
    assert phases[0] == "fitting"
    assert "permuting" in phases
    assert events[-1] == ("permuting", 1000, 1000)


def test_cancellation_stops_the_permutations() -> None:
    seen: list[tuple[str, int, int]] = []

    def cancelled() -> bool:
        # Stop after the first chunk of permutations.
        return any(phase == "permuting" and done > 0 for phase, done, _ in seen)

    with pytest.raises(ComputeCancelled):
        run_case(
            _small_case(),
            progress=lambda *event: seen.append(event),
            cancelled=cancelled,
        )
    assert seen[-1] == ("permuting", 500, 1000)


def test_cancellation_stops_the_fit() -> None:
    with pytest.raises(ComputeCancelled):
        run_case(_small_case(), cancelled=lambda: True)


def test_the_chunk_size_never_changes_the_permutation_p(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    baseline = run_case(_small_case())
    monkeypatch.setattr(engine_v2, "_CHUNK_CELLS", 1)
    small = run_case(_small_case())
    assert [r["pPermutation"] for r in small.rows] == [
        r["pPermutation"] for r in baseline.rows
    ]
    assert [r["pCorrected"] for r in small.rows] == [
        r["pCorrected"] for r in baseline.rows
    ]


def test_the_omnibus_gate_marks_pairs_but_never_changes_p() -> None:
    gated = run_case(_small_case())
    open_gate = run_case(_small_case(omnibusGate=False))
    assert any(row["gated"] for row in gated.rows)
    assert not any(row["gated"] for row in open_gate.rows)
    assert [(r["p"], r["pCorrected"]) for r in gated.rows] == [
        (r["p"], r["pCorrected"]) for r in open_gate.rows
    ]


def test_pairwise_detail_roles_follow_the_pair() -> None:
    out = run_case(_small_case(permutations=0, correction="holm"))
    pair = next(
        t for t in out.terms if t["pair"] == {"focal": "SCI_nNP", "reference": "SCI_P"}
    )
    detail = result_detail.measure_detail(
        _record(out), pair["termId"], "aseg:Brain-Stem"
    )
    roles = {m["label"]: m["role"] for m in detail["groupMeans"]}
    assert roles == {"CTRL": "other", "SCI_P": "reference", "SCI_nNP": "focal"}
    assert detail["row"]["nFocal"] == 8
    assert len(detail["subjects"]) == detail["row"]["nTotal"]


def _one_test(test: dict[str, Any], **changes: Any) -> dict[str, Any]:
    case = copy.deepcopy(CASES["omnibus-pairwise-maxt-pooled"])
    case["spec"]["tests"] = [test]
    case["spec"]["inference"].update(
        {"correction": "holm", "permutations": 0, "omnibusGate": False}
    )
    for key, value in changes.items():
        case["spec"][key] = value
    return case


def _cohort_factor(
    groups: list[tuple[str, list[str]]], reference: str, focal: str | None = None
) -> dict[str, Any]:
    return {
        "grouping": {
            "variable": {"source": "registry", "column": "sourceCohortLabel"},
            "groups": [{"label": g, "levels": levels} for g, levels in groups],
        },
        "focal": focal,
        "reference": reference,
        "model": "all-groups",
    }


def _test(test_id: str, kind: str, **fields: Any) -> dict[str, Any]:
    return {
        "id": test_id,
        "label": test_id,
        "kind": kind,
        "factor": None,
        "pairwise": "none",
        "pairwiseFamily": "pooled",
        "variable": None,
        "moderator": None,
        "adjustForGroup": False,
        "inFamily": True,
        "extraCovariates": [],
        **fields,
    }


THREE = [("CTRL", ["CTRL"]), ("SCI_P", ["SCI_P"]), ("SCI_nNP", ["SCI_nNP"])]


def test_a_small_cell_skips_the_measure_with_its_reason() -> None:
    case = _one_test(
        _test("cohort", "omnibus", factor=_cohort_factor(THREE, "CTRL")),
        inclusion={
            **CASES["omnibus-pairwise-maxt-pooled"]["spec"]["inclusion"],
            "minCellN": 9,
        },
    )
    with_small = run_case(case)
    assert with_small.rows == []
    assert {row["reason"] for row in with_small.skipped} == {
        "Fewer than nine subjects of SCI_nNP have this measure."
    }


def test_skips_name_the_test_in_a_battery() -> None:
    case = copy.deepcopy(CASES["battery-missingness-bh"])
    case["spec"]["inclusion"]["minCellN"] = 20
    out = run_case(case)
    reasons = {row["reason"] for row in out.skipped}
    assert any(
        reason.startswith("Cervical vs thoracic-lumbar: Fewer than 20")
        for reason in reasons
    )
    assert all(row["termId"] in {"term-3", "term-4"} for row in out.rows)


def test_a_categorical_moderator_with_three_levels_is_an_f_test() -> None:
    case = copy.deepcopy(CASES["interaction-binary-bh"])
    ais = [v if v is not None else "none" for v in GOLDENS["variables"]["ais"]]
    case["spec"]["tests"][0]["moderator"]["ref"] = {
        "source": "registry",
        "column": "ais",
    }
    data = case_input(case)
    data.variables["registry:ais"] = [
        {"A": "A", "B": "B", "C": "B", "D": "D", "none": "D"}[
            ais[DATA["subjects"].index(sid)]
        ]
        for sid in data.subject_ids
    ]
    out = engine_v2.run(
        data,
        parse_spec(case["spec"]),
        progress=lambda *_: None,
        cancelled=lambda: False,
    )
    assert [(t["kind"], t["rank"]) for t in out.terms] == [("F", 2)]
    assert all(row["F"] is not None and row["t"] is None for row in out.rows)
    one_sided = copy.deepcopy(case["spec"])
    one_sided["inference"]["sidedness"] = "higher"
    with pytest.raises(GroupAnalysisError, match="two-sided"):
        engine_v2.run(
            data,
            parse_spec(one_sided),
            progress=lambda *_: None,
            cancelled=lambda: False,
        )


def test_log1p_refuses_values_at_or_below_minus_one() -> None:
    case = copy.deepcopy(CASES["association-log1p-standardize-maxt"])
    data = case_input(case)
    tsi = data.variables["registry:tSinceSci"]
    tsi[next(i for i, v in enumerate(tsi) if v is not None)] = -1.0
    with pytest.raises(GroupAnalysisError, match=r"log\(1 \+ x\)"):
        engine_v2.run(
            data,
            parse_spec(case["spec"]),
            progress=lambda *_: None,
            cancelled=lambda: False,
        )


def test_the_input_is_checked() -> None:
    case = CASES["omnibus-pairwise-maxt-pooled"]
    spec = parse_spec(case["spec"])
    data = case_input(case)
    data.variables.pop("registry:sourceCohortLabel")
    with pytest.raises(
        GroupAnalysisError, match="Provide the values of sourceCohortLabel"
    ):
        engine_v2.run(data, spec, progress=lambda *_: None, cancelled=lambda: False)
    data = case_input(case)
    data.covariates.pop("eTIV")
    with pytest.raises(GroupAnalysisError, match="head size"):
        engine_v2.run(data, spec, progress=lambda *_: None, cancelled=lambda: False)
    data = case_input(case)
    data.measures["aseg:Brain-Stem"] = data.measures["aseg:Brain-Stem"][:-1]
    with pytest.raises(GroupAnalysisError, match="Align aseg:Brain-Stem"):
        engine_v2.run(data, spec, progress=lambda *_: None, cancelled=lambda: False)
    data = case_input(case)
    data.measures["aseg:Brain-Stem"][0] = math.inf
    with pytest.raises(GroupAnalysisError, match="infinite"):
        engine_v2.run(data, spec, progress=lambda *_: None, cancelled=lambda: False)
    data = case_input(case)
    data.variables["registry:sourceCohortLabel"] = [1.0] * len(data.subject_ids)
    out = engine_v2.run(data, spec, progress=lambda *_: None, cancelled=lambda: False)
    assert out.rows == []


def test_a_text_tested_variable_is_refused() -> None:
    case = CASES["association-log1p-standardize-maxt"]
    data = case_input(case)
    data.variables["registry:tSinceSci"] = ["x"] * len(data.subject_ids)
    with pytest.raises(GroupAnalysisError, match="numeric variable for tSinceSci"):
        engine_v2.run(
            data,
            parse_spec(case["spec"]),
            progress=lambda *_: None,
            cancelled=lambda: False,
        )


def test_too_many_terms_are_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(engine_v2, "MAX_TERMS", 3)
    with pytest.raises(GroupAnalysisError, match="more than 3 result terms"):
        run_case(CASES["omnibus-pairwise-maxt-pooled"])


def test_a_constant_measure_is_skipped() -> None:
    case = CASES["interaction-binary-bh"]
    data = case_input(case)
    data.measures["global:meanThickness"] = [2.5] * len(data.subject_ids)
    out = engine_v2.run(
        data,
        parse_spec(case["spec"]),
        progress=lambda *_: None,
        cancelled=lambda: False,
    )
    assert {
        "measureId": "global:meanThickness",
        "reason": "The measure is constant or fitted exactly by the model.",
    } in out.skipped


def test_level_text_and_sample_groups() -> None:
    assert level_text(None) is None
    assert level_text(2.0) == "2"
    assert level_text(2.5) == "2.5"
    assert level_text(math.nan) is None
    case = CASES["battery-missingness-bh"]
    counts = sample_groups(parse_spec(case["spec"]), case_input(case))
    labels = [row["label"] for row in counts]
    assert labels == ["SCI", "Cervical", "T/L", "A", "B-D"]
    assert counts[0]["n"] == 38


def _run_data(case: dict[str, Any], data: EngineDataV2) -> engine_v2.EngineOutputV2:
    return engine_v2.run(
        data,
        parse_spec(case["spec"]),
        progress=lambda *_: None,
        cancelled=lambda: False,
    )


def test_moderator_guards_skip_with_their_reasons() -> None:
    numeric = copy.deepcopy(CASES["interaction-numeric-maxt"])
    numeric["spec"]["tests"] = numeric["spec"]["tests"][1:]
    data = case_input(numeric)
    cohorts = data.source_labels
    data.variables["registry:age"] = [
        40.0 if cohort == "CTRL" else value
        for cohort, value in zip(cohorts, data.variables["registry:age"], strict=True)
    ]
    out = _run_data(numeric, data)
    assert out.rows == []
    assert out.skipped[0]["reason"] == (
        "The moderator needs three or more varying values in CTRL among the "
        "subjects with this measure."
    )
    binary = CASES["interaction-binary-bh"]
    data = case_input(binary)
    data.variables["metadata-csv:SexText"] = [
        "Female" if cohort == "CTRL" else "Male" for cohort in data.source_labels
    ]
    out = _run_data(binary, data)
    assert out.skipped[0]["reason"] == (
        "No subject of SCI at moderator level Female has this measure."
    )
    data.variables["metadata-csv:SexText"] = ["Male"] * len(data.subject_ids)
    out = _run_data(binary, data)
    assert out.skipped[0]["reason"] == (
        "The moderator has one level among the subjects with this measure."
    )
    transformed = copy.deepcopy(binary)
    transformed["spec"]["tests"][0]["moderator"]["transform"] = "log1p"
    with pytest.raises(GroupAnalysisError, match="Transform only a numeric moderator"):
        run_case(transformed)


def test_heterogeneity_needs_two_strata_with_the_measure() -> None:
    case = CASES["stratified-heterogeneity-maxt"]
    data = case_input(case)
    site = data.variables["metadata-csv:site"]
    data.measures["aseg:Brain-Stem"] = [
        value if where == "north" else None
        for where, value in zip(site, data.measures["aseg:Brain-Stem"], strict=True)
    ]
    out = _run_data(case, data)
    reasons = {
        row["reason"] for row in out.skipped if row["measureId"] == "aseg:Brain-Stem"
    }
    assert "SCI vs CTRL: Fewer than two strata have this measure." in reasons
    assert any(reason.startswith("SCI vs CTRL (South): ") for reason in reasons)


def test_rank_deficient_and_tiny_blocks_are_skipped() -> None:
    case = copy.deepcopy(CASES["interaction-binary-bh"])
    data = case_input(case)
    data.covariates = {
        "age": data.covariates["age"],
        "age2": data.covariates["age"],
        "eTIV": data.covariates["eTIV"],
    }
    out = _run_data(case, data)
    assert out.rows == []
    assert out.skipped[0]["reason"] == (
        "The model is rank deficient for the subjects with this measure."
    )
    small = copy.deepcopy(CASES["battery-missingness-bh"])
    small["spec"]["tests"] = [small["spec"]["tests"][3]]
    small["spec"]["tests"][0]["inFamily"] = True
    data = case_input(small)
    keep = [
        i for i, v in enumerate(data.variables["registry:tSinceSci"]) if v is not None
    ][:5]
    data = EngineDataV2(
        subject_ids=[data.subject_ids[i] for i in keep],
        source_labels=[data.source_labels[i] for i in keep],
        variables={k: [v[i] for i in keep] for k, v in data.variables.items()},
        covariates={k: [v[i] for i in keep] for k, v in data.covariates.items()},
        measures={k: [v[i] for i in keep] for k, v in data.measures.items()},
    )
    out = _run_data(small, data)
    # eTIV itself takes no head size: 4 parameters, one residual df, no CI.
    (row,) = out.rows
    assert row["measureId"] == "global:eTIV"
    assert row["df2"] == 1
    assert row["partialRLow"] is None
    assert out.skipped[0]["reason"] == (
        "The model has 5 parameters, so a fit needs 6 subjects with this "
        "measure; 5 have it."
    )


def test_a_fisher_interval_needs_two_residual_df() -> None:
    assert engine_v2._fisher_interval(0.5, 1) == (None, None)
    assert engine_v2._fisher_interval(1.0, 30) == (None, None)
    low, high = engine_v2._fisher_interval(0.0, 30)
    assert low == pytest.approx(-high)


def test_an_unknown_term_is_refused() -> None:
    out = run_case(_small_case(permutations=0, correction="holm"))
    with pytest.raises(GroupAnalysisError, match="term this result"):
        result_detail.measure_detail(_record(out), "term-99", "aseg:Brain-Stem")
