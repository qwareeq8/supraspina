"""Tests for spec v2: fixtures and digests, upgrade, validation, grammar v2."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.group_analysis.spec import (
    GroupAnalysisError,
    GroupAnalysisSpec,
    GroupAnalysisSpecV2,
    _js_number,
    canonical_spec_json,
    effect_rank,
    is_extensive,
    is_measure_id_v1,
    join_hemisphere_token,
    measure_family,
    parse_measure_id,
    parse_spec,
    pools_in_all_tests,
    spec_digest,
    split_hemisphere_token,
    upgrade_v1,
)

_FIXTURES = Path(__file__).parent / "fixtures" / "group_analysis"
_NAMES = ("two-group", "omnibus", "within-battery", "interaction", "stratified")


def _fixture(name: str) -> dict[str, Any]:
    return json.loads((_FIXTURES / f"spec-v2-{name}.json").read_text(encoding="utf-8"))


def _v1() -> dict[str, Any]:
    return json.loads((_FIXTURES / "spec-v1-example.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", _NAMES)
def test_each_fixture_parses_as_v2_with_its_shared_digest(name: str) -> None:
    document = _fixture(name)
    spec = parse_spec(document["spec"])
    assert isinstance(spec, GroupAnalysisSpecV2)
    assert spec_digest(spec) == document["specDigest"]
    assert canonical_spec_json(spec).startswith('{"covariates":')


def test_upgrade_maps_the_v1_example_to_the_two_group_fixture() -> None:
    fixture = _fixture("two-group")
    v1 = _v1()
    spec = parse_spec(v1["spec"])
    assert isinstance(spec, GroupAnalysisSpec)
    upgraded = upgrade_v1(spec)
    assert upgraded.model_dump(mode="json", by_alias=True) == fixture["spec"]
    # The v1 spec keeps its v1 digest; the upgraded spec has its own.
    assert spec_digest(spec) == v1["specDigest"]
    assert spec_digest(upgraded) == fixture["specDigest"] != v1["specDigest"]


def test_upgrade_maps_an_association_to_a_subset_and_factor() -> None:
    raw = _v1()["spec"]
    raw["analysis"] = "association"
    raw["contrast"] = {
        "type": "association",
        "variable": {"source": "clinical-csv", "column": "pain_nrs"},
        "grouping": raw["contrast"]["grouping"],
        "includedGroups": ["SCI", "CTRL"],
        "adjustForGroup": True,
    }
    raw["covariates"]["etiv"] = "none"
    raw["inference"]["family"] = "per-family"
    upgraded = upgrade_v1(parse_spec(raw))  # type: ignore[arg-type]
    test = upgraded.tests[0]
    assert test.kind == "association"
    assert test.adjustForGroup is True
    assert test.factor is not None
    assert test.factor.reference == "SCI"
    assert test.factor.focal is None
    assert upgraded.design.subset[0].keep.levels == ["SCI_nNP", "SCI_P", "CTRL"]  # type: ignore[union-attr]
    assert upgraded.covariates.headSize.source == "none"
    assert upgraded.inference.family == "per-measure-family"
    assert upgraded.inclusion.minCellN == 2


def test_digest_ignores_set_order_but_not_test_order() -> None:
    document = _fixture("within-battery")
    reordered = copy.deepcopy(document["spec"])
    reordered["measures"].reverse()
    reordered["design"]["population"]["grouping"]["groups"][0]["levels"].reverse()
    assert spec_digest(parse_spec(reordered)) == document["specDigest"]
    tests = copy.deepcopy(document["spec"])
    tests["tests"].reverse()
    assert spec_digest(parse_spec(tests)) != document["specDigest"]


def _mutated(name: str, path: list[str | int], value: Any) -> dict[str, Any]:
    spec = copy.deepcopy(_fixture(name)["spec"])
    target: Any = spec
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return spec


@pytest.mark.parametrize(
    ("name", "path", "value", "message"),
    [
        (
            "within-battery",
            ["design", "population"],
            None,
            "Choose the population for a within-group design.",
        ),
        (
            "omnibus",
            ["inference", "sidedness"],
            "lower",
            "Choose a two-sided test: an F test has no direction.",
        ),
        (
            "within-battery",
            ["variables", "derived"],
            [],
            "Define every derived variable the analysis uses.",
        ),
        (
            "stratified",
            ["variables", "derived", 0, "params", "cuts"],
            [60.5, 40],
            "Give the bin cut points in increasing order.",
        ),
        (
            "interaction",
            ["covariates", "age"],
            {"source": "registry", "column": "age"},
            "Do not adjust for the tested variable.",
        ),
        (
            "interaction",
            ["design", "subset", 0, "keep"],
            {"min": 90, "max": 18},
            "Give each subset filter a minimum no larger than its maximum.",
        ),
        (
            "two-group",
            ["tests", 0, "pairwise"],
            "all-pairs",
            "Choose pairwise comparisons only for an omnibus test.",
        ),
        (
            "two-group",
            ["measures"],
            ["vol:aseg:mid:Brain-Stem"],
            "Use valid measure IDs.",
        ),
        (
            "two-group",
            ["covariates", "extra"],
            [{"source": "imported", "table": "var-x", "column": "UEMS"}],
            "Correct the analysis field",
        ),
    ],
)
def test_validation_names_the_first_problem_like_typescript(
    name: str, path: list[str | int], value: Any, message: str
) -> None:
    with pytest.raises(GroupAnalysisError) as caught:
        parse_spec(_mutated(name, path, value))
    assert str(caught.value).startswith(message)


def test_omnibus_group_count_family_rules() -> None:
    spec = _fixture("omnibus")["spec"]
    fewer = copy.deepcopy(spec)
    fewer["tests"][0]["factor"]["grouping"]["groups"].pop(0)
    with pytest.raises(GroupAnalysisError, match="three or more groups"):
        parse_spec(fewer)
    mixed = copy.deepcopy(spec)
    mixed["tests"].append({**_fixture("two-group")["spec"]["tests"][0], "id": "t2"})
    mixed["inference"]["family"] = "all-tests"
    with pytest.raises(GroupAnalysisError, match="Correct each test separately"):
        parse_spec(mixed)
    battery = copy.deepcopy(_fixture("within-battery")["spec"])
    for test in battery["tests"]:
        test["inFamily"] = False
    with pytest.raises(GroupAnalysisError, match="one or more tests in the"):
        parse_spec(battery)


def test_spec_v1_keeps_its_grammar() -> None:
    spec = _v1()["spec"]
    spec["measures"] = ["parc:a2009s:lh:G_precentral:ThickAvg"]
    with pytest.raises(GroupAnalysisError, match="Use valid measure IDs"):
        parse_spec(spec)
    spec["measures"] = ["global:TotalGrayVol"]
    with pytest.raises(GroupAnalysisError, match="Use valid measure IDs"):
        parse_spec(spec)


@pytest.mark.parametrize(
    ("measure_id", "family", "extensive"),
    [
        ("parc:a2009s:lh:G_and_S_frontomargin:ThickAvg", "parc:a2009s:ThickAvg", False),
        ("parc:gwc:bi:precentral:GWC", "parc:gwc:GWC", False),
        (
            "parc:schaefer400-7:rh:7Networks_Vis_1:SurfArea",
            "parc:schaefer400-7:SurfArea",
            True,
        ),
        ("vol:brainstem-ss:mid:Medulla", "vol:brainstem-ss", True),
        ("vol:wmparc:lh:wm-precentral", "vol:wmparc", True),
        ("global:TotalGrayVol", "global", True),
        ("global:SurfaceHoles", "global", False),
        ("global:sTIV", "global", True),
    ],
)
def test_grammar_v2_accepts_the_new_namespaces(
    measure_id: str, family: str, extensive: bool
) -> None:
    assert parse_measure_id(measure_id) is not None
    assert measure_family(measure_id) == family
    assert is_extensive(measure_id) is extensive
    assert not is_measure_id_v1(measure_id)


@pytest.mark.parametrize(
    "measure_id",
    [
        "parc:dk:lh:precentral:ThickAvg",
        "vol:aseg:mid:Brain-Stem",
        "parc:a2009s:mid:x:ThickAvg",
        "vol:brainstem-ss:bi:Left-Thalamus",
        "parc:A2009s:lh:x:ThickAvg",
        "parc:a2009s:lh:x y:ThickAvg",
        "vol:x:mid:Medulla",
        "vol:brainstem-ss:mid:" + "a" * 65,
        "vol:" + "a" * 48 + ":mid:" + "b" * 64 + "c" * 50,
    ],
)
def test_grammar_v2_rejects_malformed_ids(measure_id: str) -> None:
    assert parse_measure_id(measure_id) is None


@pytest.mark.parametrize(
    ("rule", "name", "hemisphere", "structure"),
    [
        ("left-right-prefix", "Left-Thalamus", "lh", "Thalamus"),
        ("lh-rh-dot-prefix", "rh.V1", "rh", "V1"),
        ("lh-rh-hyphen-infix", "wm-lh-precentral", "lh", "wm-precentral"),
        ("lh-rh-underscore-infix", "7Networks_RH_Vis_1", "rh", "7Networks_Vis_1"),
        ("l-r-underscore-suffix", "A8m_L", "lh", "A8m"),
    ],
)
def test_hemisphere_tokens_pair_and_round_trip(
    rule: str, name: str, hemisphere: str, structure: str
) -> None:
    assert split_hemisphere_token(rule, name) == (hemisphere, structure)
    assert join_hemisphere_token(rule, hemisphere, structure) == name


def test_unpaired_names_read_as_midline() -> None:
    assert split_hemisphere_token("left-right-prefix", "Medulla") == (None, "Medulla")
    assert split_hemisphere_token("none", "Left-Thalamus") == (None, "Left-Thalamus")
    assert join_hemisphere_token("none", "lh", "Medulla") == "Medulla"


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (0.05, "0.05"),
        (7.0, "7"),
        (-0.0, "0"),
        (1e21, "1e+21"),
        (1.5e-7, "1.5e-7"),
        (1e-6, "0.000001"),
        (123.456, "123.456"),
        (0.1 + 0.2, "0.30000000000000004"),
        (-2.5e22, "-2.5e+22"),
    ],
)
def test_numbers_serialize_as_ecmascript_does(value: float, text: str) -> None:
    assert _js_number(value) == text


def test_the_effect_rank_follows_the_engine_parametrization() -> None:
    interaction = parse_spec(_fixture("interaction")["spec"]).tests[0]
    omnibus = parse_spec(_fixture("omnibus")["spec"]).tests[0]
    # Two groups: a numeric (or unknown) moderator is one product, a
    # categorical one (k - 1)(m - 1).
    assert effect_rank(interaction) == 1
    assert effect_rank(interaction, 2) == 1
    assert effect_rank(interaction, 3) == 2
    three = interaction.model_copy(
        update={
            "factor": interaction.factor.model_copy(  # type: ignore[union-attr]
                update={"grouping": omnibus.factor.grouping}  # type: ignore[union-attr]
            )
        }
    )
    assert effect_rank(three) == 2
    assert effect_rank(three, 4) == 6
    assert effect_rank(omnibus) == 2
    assert pools_in_all_tests(omnibus)
    assert not pools_in_all_tests(interaction)


def test_max_t_over_all_tests_ignores_interactions_and_sensitivity_tests() -> None:
    # An interaction forms its own family and a test outside the family has
    # none, so neither mixes ranks with the pooled tests.
    spec = copy.deepcopy(_fixture("omnibus")["spec"])
    slope = copy.deepcopy(_fixture("interaction")["spec"]["tests"][0])
    slope["extraCovariates"] = []
    slope["moderator"]["ref"] = {"source": "registry", "column": "tSinceSci"}
    two_group = copy.deepcopy(_fixture("two-group")["spec"]["tests"][0])
    two_group["id"] = "t2"
    spec["tests"].append(slope)
    spec["inference"]["family"] = "all-tests"
    spec["inference"]["omnibusGate"] = False
    spec["tests"][0]["pairwise"] = "none"
    parse_spec(spec)
    spec["tests"].append({**two_group, "inFamily": False})
    parse_spec(spec)
    spec["tests"][-1]["inFamily"] = True
    with pytest.raises(GroupAnalysisError, match="Correct each test separately"):
        parse_spec(spec)
