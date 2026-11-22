"""Tests for spec v1: the measure ID grammar, validation, and the digest."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.group_analysis.spec import (
    GroupAnalysisError,
    canonical_spec_json,
    is_extensive,
    measure_family,
    parse_measure_id,
    parse_spec,
    spec_digest,
)

_FIXTURE = (
    Path(__file__).parent / "fixtures" / "group_analysis" / "spec-v1-example.json"
)


def _example() -> dict[str, Any]:
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    ("measure_id", "expected"),
    [
        ("dk:lh:precentral:ThickAvg", ("dk", "lh", "precentral", "ThickAvg")),
        ("dk:bi:insula:GrayVol", ("dk", "bi", "insula", "GrayVol")),
        ("aseg:Brain-Stem", ("aseg", None, "Brain-Stem")),
        ("aseg:bi:Thalamus", ("aseg", "bi", "Thalamus")),
        ("aseg:CC_Mid_Anterior", ("aseg", None, "CC_Mid_Anterior")),
        ("global:eTIV", ("global", "eTIV")),
        ("global:meanThickness", ("global", "meanThickness")),
        ("brainage:BrainPAD", ("brainage", "BrainPAD")),
    ],
)
def test_measure_id_grammar_accepts_every_source(
    measure_id: str, expected: tuple[str | None, ...]
) -> None:
    parts = parse_measure_id(measure_id)
    assert parts is not None
    if parts.source == "dk":
        assert (parts.source, parts.hemisphere, parts.region, parts.metric) == expected
    elif parts.source == "aseg":
        assert (parts.source, parts.hemisphere, parts.structure) == expected
    else:
        assert (parts.source, parts.name) == expected


@pytest.mark.parametrize(
    "measure_id",
    [
        "dk:xh:precentral:ThickAvg",
        "dk:lh:precentral:thickness",
        "dk:lh:Precentral:ThickAvg",
        "aseg:bi:Left-Thalamus",
        "aseg:bi",
        "aseg:",
        "global:TotalGreyVol",
        "brainage:BrainAge",
        "dk:lh:precentral:ThickAvg\n",
        "a" * 97,
        42,
    ],
)
def test_measure_id_grammar_rejects_malformed_ids(measure_id: object) -> None:
    assert parse_measure_id(measure_id) is None


def test_family_and_extensive_rules_follow_round_five() -> None:
    assert measure_family("dk:lh:precentral:ThickAvg") == "dk:ThickAvg"
    assert measure_family("aseg:bi:Thalamus") == "aseg"
    assert measure_family("global:eTIV") == "global"
    assert measure_family("brainage:BrainPAD") == "brainage"
    assert is_extensive("dk:bi:precentral:GrayVol")
    assert is_extensive("dk:lh:insula:FoldInd")
    assert not is_extensive("dk:lh:insula:ThickAvg")
    assert not is_extensive("dk:lh:insula:CurvInd")
    assert is_extensive("aseg:Brain-Stem")
    assert is_extensive("global:eTIV")
    assert not is_extensive("global:meanThickness")
    assert not is_extensive("brainage:BrainPAD")
    with pytest.raises(GroupAnalysisError, match="valid measure IDs"):
        measure_family("dk:lh")


def test_digest_is_stable_and_shared_with_typescript() -> None:
    example = _example()
    spec = parse_spec(example["spec"])

    assert spec_digest(spec) == example["specDigest"]
    canonical = canonical_spec_json(spec)
    assert canonical.startswith('{"analysis":"group-comparison"')
    assert '"levels":["SCI_P","SCI_nNP"]' in canonical
    assert " " not in canonical


def test_digest_ignores_measure_and_level_order_but_not_content() -> None:
    example = _example()["spec"]
    reordered = copy.deepcopy(example)
    reordered["measures"].reverse()
    reordered["contrast"]["grouping"]["groups"][0]["levels"].reverse()
    assert spec_digest(parse_spec(reordered)) == spec_digest(parse_spec(example))

    changed = copy.deepcopy(example)
    changed["inference"]["seed"] = 1
    assert spec_digest(parse_spec(changed)) != spec_digest(parse_spec(example))


def _mutated(path: list[str | int], value: Any) -> dict[str, Any]:
    spec = copy.deepcopy(_example()["spec"])
    target: Any = spec
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return spec


@pytest.mark.parametrize(
    ("path", "value", "message"),
    [
        (["contrast", "focal"], "CTRL", "Choose two different groups to compare."),
        (
            ["contrast", "reference"],
            "Other",
            "Choose a defined group as the reference group.",
        ),
        (
            ["measures"],
            ["aseg:Brain-Stem", "aseg:Brain-Stem"],
            "List each measure once.",
        ),
        (["measures"], ["dk:lh:nowhere"], "Use valid measure IDs."),
        (
            ["analysis"],
            "brain-age",
            "Use Brain-PAD as the only brain-age measure.",
        ),
        (
            ["inference", "permutations"],
            0,
            "Choose a permutation count for max-T correction.",
        ),
        (
            ["covariates", "extra"],
            [{"source": "registry", "column": "age"}],
            "Add each covariate once.",
        ),
        (
            ["covariates", "sex"],
            {"source": "registry", "column": "sourceCohortLabel"},
            "Do not adjust for the tested variable.",
        ),
        (
            ["covariates", "age"],
            {"source": "registry", "column": "qc"},
            "Choose a registry field the analysis can use.",
        ),
        (["inference", "alpha"], 0.5, "Correct the analysis field inference.alpha."),
        (["inference", "seed"], "7", "Correct the analysis field inference.seed."),
        (["inference", "permutations"], 2000, "Correct the analysis field"),
        (["extra"], True, "Correct the analysis field extra."),
    ],
)
def test_validation_names_the_first_problem(
    path: list[str | int], value: Any, message: str
) -> None:
    with pytest.raises(GroupAnalysisError) as caught:
        parse_spec(_mutated(path, value))
    assert str(caught.value).startswith(message)


def test_association_contrast_rules() -> None:
    spec = copy.deepcopy(_example()["spec"])
    spec["analysis"] = "association"
    spec["contrast"] = {
        "type": "association",
        "variable": {"source": "clinical-csv", "column": "pain_nrs"},
        "grouping": None,
        "includedGroups": [],
        "adjustForGroup": False,
    }
    assert parse_spec(spec).contrast.type == "association"

    spec["contrast"]["adjustForGroup"] = True
    with pytest.raises(GroupAnalysisError, match="adjust for group"):
        parse_spec(spec)

    spec["contrast"]["adjustForGroup"] = False
    spec["contrast"]["includedGroups"] = ["SCI"]
    with pytest.raises(GroupAnalysisError, match="Define the grouping"):
        parse_spec(spec)

    spec["analysis"] = "group-comparison"
    spec["contrast"]["includedGroups"] = []
    with pytest.raises(GroupAnalysisError, match="Match the contrast"):
        parse_spec(spec)
