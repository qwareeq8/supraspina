"""Tests for the design check of spec v2 drafts, the site check included."""

from __future__ import annotations

import csv
import math
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.group_analysis import dataset_v2, design_check, engine_input
from supraspina_sidecar.group_analysis.dataset import AnalysisContext
from supraspina_sidecar.group_analysis.spec import GroupAnalysisError
from tests.group_analysis_support import make_cfg
from tests.test_group_analysis_dataset_v2 import (
    COHORT,
    SCI_CTRL,
    _factor,
    _test,
    _within,
    spec_v2,
)

SITE = {"source": "registry", "column": "site"}
TWO_GROUP = _test(
    "sci-ctrl",
    "two-group",
    label="SCI vs CTRL",
    factor=_factor(COHORT, SCI_CTRL, "SCI", "CTRL"),
)


def _write_csv(path: Path, header: list[str], rows: list[list[Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def site_context(
    root: Path,
    rows: list[tuple[str, str | None]],
    *,
    extra: dict[str, list[Any]] | None = None,
) -> AnalysisContext:
    """Write a table-only project of (cohort, site) subjects; return its context.

    Subjects are ``sub-001`` onward; ages and sexes alternate so no covariate
    is constant, and ``extra`` adds metadata.csv columns.
    """
    cfg = make_cfg(root)
    ids = [f"sub-{index + 1:03d}" for index in range(len(rows))]
    measures = []
    for index, subject_id in enumerate(ids):
        wave = math.sin(index * 1.3)
        measures.append(
            [subject_id, 2.5 + 0.05 * wave, 2.55 + 0.04 * wave, 20000 + 400 * wave]
        )
    structural = root / "outputs" / "run" / "structural"
    _write_csv(
        structural / "dk_all_stats.csv",
        ["subject", "lh_precentral_ThickAvg", "rh_precentral_ThickAvg", "Brain-Stem"],
        measures,
    )
    _write_csv(
        structural / "icv_data.csv",
        ["subject", "eTIV"],
        [[sid, 1_400_000 + 3000 * ((i * 7) % 11)] for i, sid in enumerate(ids)],
    )
    columns = extra or {}
    _write_csv(
        root / "metadata" / "metadata.csv",
        ["participant_id", *columns],
        [
            [sid, *(values[i] for values in columns.values())]
            for i, sid in enumerate(ids)
        ],
    )
    registry = tuple(
        {
            "subjectId": sid,
            "age": 25 + (i * 13) % 40,
            "sex": "F" if (i * 5) % 3 else "M",
            "sourceCohortLabel": cohort,
            "cohortRole": "control" if cohort == "CTRL" else "patient",
            **({"site": site} if site is not None else {}),
        }
        for i, (sid, (cohort, site)) in enumerate(zip(ids, rows, strict=True))
    )
    return AnalysisContext(
        project_root=str(root), cfg=cfg, config_revision=1, registry=registry
    )


#: Site B holds 40 CTRL and 20 SCI subjects, site A 4 SCI subjects only.
SITE_CONFOUNDED: list[tuple[str, str | None]] = (
    [("CTRL", "B")] * 40 + [("SCI_P", "B")] * 20 + [("SCI_nNP", "A")] * 4
)


def _check(context: AnalysisContext, spec: Any) -> dict[str, Any]:
    return dataset_v2.resolve_inputs(context, spec)["designCheck"]


def _site_issues(check: dict[str, Any]) -> list[dict[str, Any]]:
    return [issue for issue in check["issues"] if issue["code"] == "site-confounded"]


# -- Site check ------------------------------------------------------------------------


def test_a_site_with_one_group_blocks_with_two_fixes(tmp_path: Path) -> None:
    context = site_context(tmp_path, SITE_CONFOUNDED)
    spec = spec_v2([TWO_GROUP])

    check = _check(context, spec)

    assert check["ok"] is False
    assert _site_issues(check) == [
        {
            "code": "site-confounded",
            "severity": "blocking",
            "testId": "sci-ctrl",
            "message": "Site A holds only SCI subjects in this test, so its "
            "group difference cannot be separated from the scanner. Leave out "
            "site A or adjust for site.",
            "fixes": [
                {"kind": "drop-level", "variable": SITE, "level": "A"},
                {"kind": "add-covariate", "variable": SITE},
            ],
        }
    ]
    crosstab = next(c for c in check["crosstabs"] if c["columnVariable"] == "site")
    assert crosstab["rows"] == ["CTRL", "SCI"]
    assert crosstab["columns"] == ["A", "B"]
    assert crosstab["counts"] == [[0, 40], [4, 20]]
    with pytest.raises(GroupAnalysisError, match="Site A holds only SCI"):
        engine_input.load_engine_data(context, spec)


def test_leaving_out_the_site_clears_the_block(tmp_path: Path) -> None:
    context = site_context(tmp_path, SITE_CONFOUNDED)
    spec = spec_v2(
        [TWO_GROUP],
        design={"subset": [{"variable": SITE, "keep": {"levels": ["B"]}}]},
    )

    check = _check(context, spec)

    assert _site_issues(check) == []
    assert check["ok"] is True
    data = engine_input.load_engine_data(context, spec)
    assert len(data.subject_ids) == 60
    reasons = {row["subjectId"]: row["reason"] for row in data.subjects}
    assert reasons["sub-064"] == "subset-filtered"


def test_adjusting_for_site_turns_the_block_into_a_warning(tmp_path: Path) -> None:
    context = site_context(tmp_path, SITE_CONFOUNDED)
    spec = spec_v2([TWO_GROUP], covariates={"extra": [SITE]})

    check = _check(context, spec)

    assert _site_issues(check) == [
        {
            "code": "site-confounded",
            "severity": "warning",
            "testId": "sci-ctrl",
            "message": "Site A holds only SCI subjects; with site as a "
            "covariate they inform the other covariates and the residual "
            "variance, not the group difference.",
        }
    ]
    assert check["ok"] is True
    data = engine_input.load_engine_data(context, spec)
    assert "registry:site:B" in data.covariates


def test_a_test_covariate_on_site_also_adjusts(tmp_path: Path) -> None:
    context = site_context(tmp_path, SITE_CONFOUNDED)
    test = {**TWO_GROUP, "extraCovariates": [SITE]}
    check = _check(context, spec_v2([test]))
    assert [issue["severity"] for issue in _site_issues(check)] == ["warning"]


def test_stratifying_by_site_skips_the_one_group_stratum(tmp_path: Path) -> None:
    context = site_context(tmp_path, SITE_CONFOUNDED)
    spec = spec_v2(
        [TWO_GROUP],
        stratify={
            "grouping": {
                "variable": SITE,
                "groups": [
                    {"label": "B", "levels": ["B"]},
                    {"label": "A", "levels": ["A"]},
                ],
            },
            "heterogeneity": False,
        },
    )

    check = _check(context, spec)

    assert _site_issues(check) == [
        {
            "code": "site-confounded",
            "severity": "warning",
            "testId": "sci-ctrl",
            "message": "Site A has no CTRL subjects, so this stratum is skipped.",
        }
    ]
    assert check["ok"] is True
    cells = {(c["stratum"], c["label"]): c["n"] for c in check["cells"]}
    assert cells[("A", "CTRL")] == 0
    assert cells[(None, "SCI")] == 24


def test_site_determining_group_blocks_even_with_the_covariate(tmp_path: Path) -> None:
    rows: list[tuple[str, str | None]] = [("CTRL", "B")] * 20 + [("SCI_P", "A")] * 20
    context = site_context(tmp_path, rows)
    for spec in (
        spec_v2([TWO_GROUP]),
        spec_v2([TWO_GROUP], covariates={"extra": [SITE]}),
    ):
        issues = _site_issues(_check(context, spec))
        assert issues == [
            {
                "code": "site-confounded",
                "severity": "blocking",
                "testId": "sci-ctrl",
                "message": "Site determines group for every subject, so the model "
                "cannot separate them.",
            }
        ]


def test_mixed_sites_warn_and_count_as_one_level(tmp_path: Path) -> None:
    rows: list[tuple[str, str | None]] = (
        [("CTRL", "B")] * 20
        + [("SCI_P", "B")] * 10
        + [("CTRL", None)] * 3
        + [("SCI_P", None)] * 2
    )
    check = _check(site_context(tmp_path, rows), spec_v2([TWO_GROUP]))
    assert _site_issues(check) == [
        {
            "code": "site-confounded",
            "severity": "warning",
            "testId": None,
            "message": "5 subjects have no site; the site check treats them as "
            "one site.",
        }
    ]
    assert check["ok"] is True

    unset_ctrl: list[tuple[str, str | None]] = (
        [("CTRL", "B")] * 20 + [("SCI_P", "B")] * 10 + [("CTRL", None)] * 3
    )
    issues = _site_issues(
        _check(site_context(tmp_path / "b", unset_ctrl), spec_v2([TWO_GROUP]))
    )
    blocking = [issue for issue in issues if issue["severity"] == "blocking"]
    assert blocking == [
        {
            "code": "site-confounded",
            "severity": "blocking",
            "testId": "sci-ctrl",
            "message": "Subjects without a site hold only CTRL subjects in this "
            "test, so its group difference cannot be separated from the scanner. "
            "Leave out the subjects without a site or adjust for site.",
            "fixes": [{"kind": "add-covariate", "variable": SITE}],
        }
    ]


def test_no_site_anywhere_adds_no_site_finding(tmp_path: Path) -> None:
    rows: list[tuple[str, str | None]] = [("CTRL", None)] * 12 + [("SCI_P", None)] * 12
    check = _check(site_context(tmp_path, rows), spec_v2([TWO_GROUP]))
    assert _site_issues(check) == []
    assert all(c["columnVariable"] != "site" for c in check["crosstabs"])


def test_an_omnibus_test_blocks_on_a_one_group_site(tmp_path: Path) -> None:
    context = site_context(tmp_path, SITE_CONFOUNDED + [("SCI_nNP", "B")] * 5)
    omnibus = _test(
        "cohort",
        "omnibus",
        factor=_factor(
            COHORT,
            [("CTRL", ["CTRL"]), ("SCI_P", ["SCI_P"]), ("SCI_nNP", ["SCI_nNP"])],
            None,
            "CTRL",
        ),
        pairwise="all-pairs",
    )
    issues = _site_issues(_check(context, spec_v2([omnibus])))
    assert [issue["severity"] for issue in issues] == ["blocking"]
    assert issues[0]["message"].startswith("Site A holds only SCI_nNP subjects")


def test_within_a_group_site_is_a_crosstab_warning(tmp_path: Path) -> None:
    rows: list[tuple[str, str | None]] = (
        [("CTRL", "B")] * 10 + [("SCI_P", "B")] * 12 + [("SCI_nNP", "A")] * 6
    )
    context = site_context(tmp_path, rows)
    subgroup = _test(
        "p-vs-n",
        "two-group",
        factor=_factor(COHORT, [("P", ["SCI_P"]), ("N", ["SCI_nNP"])], "P", "N"),
    )
    check = _check(context, _within([subgroup]))
    assert _site_issues(check) == [
        {
            "code": "site-confounded",
            "severity": "warning",
            "testId": "p-vs-n",
            "message": "The groups of this test differ by site (Cramer's V 1.00): "
            "6 of the 6 subjects of site A are N.",
        }
    ]
    assert check["ok"] is True


# -- Cells, df, and invalid designs -------------------------------------------------


def test_cells_count_subjects_and_sexes_and_small_cells_block(tmp_path: Path) -> None:
    rows: list[tuple[str, str | None]] = [("CTRL", None)] * 12 + [("SCI_P", None)] * 2
    check = _check(site_context(tmp_path, rows), spec_v2([TWO_GROUP]))
    ctrl = next(c for c in check["cells"] if c["label"] == "CTRL")
    assert ctrl["n"] == 12
    assert ctrl["female"] + ctrl["male"] == 12
    assert check["ok"] is True  # Under minCellN 2.
    rows = [("CTRL", None)] * 12 + [("SCI_P", None)] * 4
    spec = spec_v2([TWO_GROUP], inclusion={"minCellN": 5})
    check = _check(site_context(tmp_path / "b", rows), spec)
    assert {
        "code": "min-cell",
        "severity": "blocking",
        "testId": "sci-ctrl",
        "message": "SCI has 4 subjects in this test; each compared group needs "
        "at least 5.",
    } in check["issues"]
    spec = spec_v2([TWO_GROUP], inclusion={"minCellN": 3})
    check = _check(site_context(tmp_path / "c", rows), spec)
    assert [i["code"] for i in check["issues"]] == ["small-cell"]
    assert check["tests"] == [
        {"testId": "sci-ctrl", "n": 16, "residualDf": 11, "missing": 0}
    ]


def test_too_few_subjects_leave_no_residual_df(tmp_path: Path) -> None:
    rows: list[tuple[str, str | None]] = [("CTRL", None)] * 2 + [("SCI_P", None)] * 2
    check = _check(site_context(tmp_path, rows), spec_v2([TWO_GROUP]))
    assert check["tests"][0]["residualDf"] is None
    assert {
        "code": "residual-df",
        "severity": "blocking",
        "testId": "sci-ctrl",
        "message": "This test fits 5 parameters to 4 subjects, so no residual "
        "degree of freedom is left.",
    } in check["issues"]


def test_an_exact_dependency_is_named_and_blocks(tmp_path: Path) -> None:
    rows: list[tuple[str, str | None]] = [("SCI_P", None)] * 20
    ages = [25 + (i * 13) % 40 for i in range(20)]
    tsi = [1 + (i * 7) % 9 for i in range(20)]
    context = site_context(
        tmp_path,
        rows,
        extra={
            "age_at_injury": [a - t for a, t in zip(ages, tsi, strict=True)],
            "tsi": tsi,
        },
    )
    at_injury = {"source": "metadata-csv", "column": "age_at_injury"}
    test = _test(
        "injury",
        "association",
        variable={"ref": at_injury, "transform": "none"},
        extraCovariates=[{"source": "metadata-csv", "column": "tsi"}],
    )
    check = _check(context, spec_v2([test], covariates={"sex": None}))
    assert {
        "code": "collinear",
        "severity": "blocking",
        "testId": "injury",
        "message": "age_at_injury equals age minus tsi for these subjects "
        "(largest difference 0.00). Remove one of the three.",
    } in check["issues"]
    assert check["ok"] is False


def test_a_near_duplicate_covariate_warns_by_vif(tmp_path: Path) -> None:
    rows: list[tuple[str, str | None]] = [("CTRL", None)] * 15 + [("SCI_P", None)] * 15
    ages = [25 + (i * 13) % 40 for i in range(30)]
    noisy = [
        a + (0.8 if i % 2 else -0.8) + 0.3 * math.sin(i) for i, a in enumerate(ages)
    ]
    context = site_context(tmp_path, rows, extra={"age2": noisy})
    spec = spec_v2(
        [TWO_GROUP],
        covariates={"extra": [{"source": "metadata-csv", "column": "age2"}]},
    )
    check = _check(context, spec)
    vif = {row["term"]: row["vif"] for row in check["vif"]}
    assert vif["age2"] >= design_check.VIF_STRONG
    assert any(
        i["code"] == "vif" and i["severity"] == "strong-warning"
        for i in check["issues"]
    )
    assert check["ok"] is True


def test_a_covariate_missing_for_a_whole_group_blocks(tmp_path: Path) -> None:
    rows: list[tuple[str, str | None]] = [("CTRL", None)] * 6 + [("SCI_P", None)] * 6
    context = site_context(tmp_path, rows, extra={"AIS": [""] * 6 + ["A", "B"] * 3})
    spec = spec_v2(
        [TWO_GROUP], covariates={"extra": [{"source": "metadata-csv", "column": "AIS"}]}
    )
    check = _check(context, spec)
    assert {
        "code": "covariate-undefined",
        "severity": "blocking",
        "testId": "sci-ctrl",
        "message": "AIS is missing for all 6 CTRL subjects; a model that compares "
        "groups cannot adjust for it.",
    } in check["issues"]


def test_confounded_factors_warn_with_an_example(tmp_path: Path) -> None:
    rows: list[tuple[str, str | None]] = [("CTRL", None)] * 10 + [("SCI_P", None)] * 10
    context = site_context(
        tmp_path, rows, extra={"Scanner": ["A"] * 10 + ["A"] + ["B"] * 9}
    )
    spec = spec_v2(
        [TWO_GROUP],
        covariates={"extra": [{"source": "metadata-csv", "column": "Scanner"}]},
    )
    check = _check(context, spec)
    issue = next(i for i in check["issues"] if i["code"] == "confounded")
    assert issue["severity"] == "warning"
    assert issue["message"] == (
        "The groups of this test differ in Scanner (Cramer's V 0.90): 9 of the 9 "
        "B subjects are SCI."
    )


def test_interactions_need_varying_moderators_per_group(tmp_path: Path) -> None:
    rows: list[tuple[str, str | None]] = [("CTRL", None)] * 8 + [("SCI_P", None)] * 8
    context = site_context(
        tmp_path, rows, extra={"dose": [1, 2, 3, 4, 5, 6, 7, 8] + [5] * 8}
    )
    test = _test(
        "by-dose",
        "interaction",
        factor=_factor(COHORT, SCI_CTRL, None, "CTRL"),
        moderator={
            "ref": {"source": "metadata-csv", "column": "dose"},
            "transform": "none",
        },
    )
    check = _check(context, spec_v2([test]))
    assert {
        "code": "moderator-cells",
        "severity": "blocking",
        "testId": "by-dose",
        "message": "SCI needs three or more subjects with varying dose for a "
        "slope difference.",
    } in check["issues"]


def _by_grade() -> dict[str, Any]:
    return _test(
        "by-grade",
        "interaction",
        factor=_factor(COHORT, SCI_CTRL, None, "CTRL"),
        moderator={
            "ref": {"source": "metadata-csv", "column": "grade"},
            "transform": "none",
        },
    )


def test_a_one_sided_slope_difference_over_three_levels_blocks(
    tmp_path: Path,
) -> None:
    # Two groups by a three-level moderator fit (2 - 1)(3 - 1) = 2 products,
    # an F test, which the spec rules cannot see without the levels.
    rows: list[tuple[str, str | None]] = [("CTRL", None)] * 9 + [("SCI_P", None)] * 9
    context = site_context(tmp_path, rows, extra={"grade": ["A", "B", "C"] * 6})
    test = _by_grade()
    one_sided = spec_v2([test], inference={"sidedness": "higher"})
    issue = {
        "code": "invalid-combination",
        "severity": "blocking",
        "testId": "by-grade",
        "message": "This test is an F test (2 df), which has no direction; "
        "choose a two-sided test.",
    }
    check = _check(context, one_sided)
    assert issue in check["issues"]
    assert check["ok"] is False
    assert issue not in _check(context, spec_v2([test]))["issues"]
    two_levels = site_context(tmp_path / "two", rows, extra={"grade": ["A", "B"] * 9})
    assert not [
        i
        for i in _check(two_levels, one_sided)["issues"]
        if "no direction" in i["message"]
    ]


def test_a_one_sided_heterogeneity_over_three_strata_blocks(tmp_path: Path) -> None:
    rows: list[tuple[str, str | None]] = [("CTRL", None)] * 9 + [("SCI_P", None)] * 9
    context = site_context(tmp_path, rows, extra={"Scanner": ["A", "B", "C"] * 6})
    scanner = {"source": "metadata-csv", "column": "Scanner"}
    stratify = {
        "grouping": {
            "variable": scanner,
            "groups": [{"label": v, "levels": [v]} for v in ("A", "B", "C")],
        },
        "heterogeneity": True,
    }
    spec = spec_v2([TWO_GROUP], stratify=stratify, inference={"sidedness": "higher"})
    messages = [i["message"] for i in _check(context, spec)["issues"]]
    assert (
        "The heterogeneity test of this test is an F test (2 df), which has no "
        "direction; choose a two-sided test." in messages
    )
    two = {**stratify, "grouping": {**stratify["grouping"]}}
    two["grouping"]["groups"] = stratify["grouping"]["groups"][:2]
    context_two = site_context(
        tmp_path / "two", rows, extra={"Scanner": ["A", "B"] * 9}
    )
    spec_two = spec_v2([TWO_GROUP], stratify=two, inference={"sidedness": "higher"})
    assert not [
        m
        for m in (i["message"] for i in _check(context_two, spec_two)["issues"])
        if "no direction" in m
    ]


def test_a_constant_tested_variable_blocks(tmp_path: Path) -> None:
    rows: list[tuple[str, str | None]] = [("SCI_P", None)] * 10
    context = site_context(tmp_path, rows, extra={"score": [3] * 10})
    test = _test(
        "score",
        "association",
        variable={
            "ref": {"source": "metadata-csv", "column": "score"},
            "transform": "none",
        },
    )
    check = _check(context, spec_v2([test]))
    assert {
        "code": "invalid-combination",
        "severity": "blocking",
        "testId": "score",
        "message": "score does not vary among the subjects of this test.",
    } in check["issues"]


def test_term_names_read_as_columns_and_levels() -> None:
    assert design_check.term_name("age") == "age"
    assert design_check.term_name("clinical-csv:AIS:B") == "AIS: B"
    assert design_check.term_name("registry:site:B") == "site: B"
    assert design_check.term_name("imported:var-0123456789abcdef:uems") == "uems"
    assert design_check.term_name("measure:aseg:Brain-Stem") == "aseg:Brain-Stem"
