"""Tests for spec v2 resolution: population, subsets, variables, and sources."""

from __future__ import annotations

import copy
import io
import json
import math
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.cohort import load_project_qc_records
from supraspina_sidecar.group_analysis import (
    dataset,
    dataset_v2,
    engine,
    engine_input,
    engine_v2,
    manager,
    sources,
    worker,
)
from supraspina_sidecar.group_analysis.dataset import AnalysisContext
from supraspina_sidecar.group_analysis.engine_input import HEAD_SIZE_KEY, variable_key
from supraspina_sidecar.group_analysis.spec import (
    GroupAnalysisError,
    parse_spec,
    upgrade_v1,
)
from supraspina_sidecar.registry_store import RegistryStore
from tests.group_analysis_recon_support import medulla, stiv, synthseg_tiv, write_recon
from tests.group_analysis_support import IMAGED, example_spec, make_project
from tests.test_group_analysis_worker import _job

COHORT = {"source": "registry", "column": "sourceCohortLabel"}
TSI = {"source": "clinical-csv", "column": "Time since SCI (years)"}


def _context(root: Path, cfg: dict[str, Any], **changes: Any) -> AnalysisContext:
    fields = {
        "project_root": str(root),
        "cfg": cfg,
        "config_revision": 1,
        "registry": tuple(RegistryStore(str(root)).list()),
        "qc": load_project_qc_records(str(root)),
    }
    fields.update(changes)
    return AnalysisContext(**fields)


def _test(test_id: str, kind: str, **fields: Any) -> dict[str, Any]:
    return {
        "id": test_id,
        "label": fields.pop("label", test_id),
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


def _factor(
    variable: dict[str, Any],
    groups: list[tuple[str, list[str]]],
    focal: str | None,
    reference: str,
    model: str = "all-groups",
) -> dict[str, Any]:
    return {
        "grouping": {
            "variable": variable,
            "groups": [{"label": g, "levels": levels} for g, levels in groups],
        },
        "focal": focal,
        "reference": reference,
        "model": model,
    }


SCI_CTRL = [("SCI", ["SCI_P", "SCI_nNP"]), ("CTRL", ["CTRL"])]


def spec_v2(tests: list[dict[str, Any]], **changes: Any) -> Any:
    """Return a parsed spec v2 with the given tests and sections changed."""
    spec: dict[str, Any] = {
        "schema": "supraspina/group-analysis-spec",
        "schemaVersion": 2,
        "design": {"scope": "between", "population": None, "subset": []},
        "variables": {"derived": []},
        "tests": tests,
        "stratify": None,
        "measures": ["aseg:Brain-Stem", "dk:bi:precentral:ThickAvg"],
        "covariates": {
            "age": {"source": "registry", "column": "age"},
            "sex": {"source": "registry", "column": "sex"},
            "headSize": {"source": "etiv", "rule": "extensive"},
            "extra": [],
            "centering": "sample-mean",
        },
        "inclusion": {
            "qc": "all",
            "registration": "keep",
            "outliers": "keep",
            "minCellN": 2,
        },
        "inference": {
            "sidedness": "two-sided",
            "correction": "bh-fdr",
            "family": "all-tests",
            "omnibusGate": False,
            "alpha": 0.05,
            "permutations": 0,
            "seed": 7,
        },
    }
    for key, value in changes.items():
        if key in {"covariates", "inclusion", "inference", "design"}:
            spec[key] = {**spec[key], **value}
        else:
            spec[key] = value
    return parse_spec(spec)


def _within(tests: list[dict[str, Any]], **changes: Any) -> Any:
    return spec_v2(
        tests,
        design={
            "scope": "within",
            "population": {
                "grouping": {
                    "variable": COHORT,
                    "groups": [
                        {"label": "SCI", "levels": ["SCI_P", "SCI_nNP"]},
                        {"label": "CTRL", "levels": ["CTRL"]},
                    ],
                },
                "groups": ["SCI"],
            },
            "subset": changes.pop("subset", []),
        },
        **changes,
    )


def _reasons(data: Any) -> dict[str, str | None]:
    return {row["subjectId"]: row["reason"] for row in data.subjects}


def _rows(output: Any) -> dict[str, dict[str, Any]]:
    return {row["measureId"]: row for row in output.rows}


# -- Equivalence with v1 ---------------------------------------------------------


@pytest.mark.parametrize(
    "changes",
    [
        {},
        {"covariates": {"sex": {"source": "clinical-csv", "column": "Sex"}}},
        {
            "analysis": "association",
            "measures": ["aseg:Brain-Stem", "dk:bi:precentral:ThickAvg"],
            "covariates": {"etiv": "all"},
            "contrast": {
                "type": "association",
                "variable": {"source": "registry", "column": "age"},
                "grouping": {
                    "variable": COHORT,
                    "groups": [
                        {"label": "SCI", "levels": ["SCI_P", "SCI_nNP"]},
                        {"label": "CTRL", "levels": ["CTRL"]},
                    ],
                },
                "includedGroups": ["SCI", "CTRL"],
                "adjustForGroup": True,
            },
        },
    ],
)
def test_an_upgraded_v1_spec_resolves_to_the_v1_result(
    tmp_path: Path, changes: dict[str, Any]
) -> None:
    cfg = make_project(tmp_path)
    context = _context(tmp_path, cfg)
    raw = example_spec(**changes)
    if raw["analysis"] == "association":
        raw["covariates"]["age"] = None
    spec = parse_spec(raw)
    upgraded = upgrade_v1(spec)

    v1 = engine.run(
        dataset.load_dataset(context, spec),
        spec,
        progress=lambda *_: None,
        cancelled=lambda: False,
    )
    data = engine_input.load_engine_data(context, upgraded)
    v2 = engine_v2.run(
        data, upgraded, progress=lambda *_: None, cancelled=lambda: False
    )

    old, new = _rows(v1), _rows(v2)
    assert set(old) == set(new)
    for measure_id, row in old.items():
        for key in ("estimate", "t", "p", "pCorrected", "nTotal", "d"):
            assert new[measure_id][key] == row[key], (measure_id, key)
    assert dataset_v2.resolve(context, upgraded).data.issues == []


# -- Inclusion order ---------------------------------------------------------------


def test_population_subset_and_group_reasons_come_in_order(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    cfg["subjects"]["exclude"] = ["sub-10"]
    spec = _within(
        [
            _test(
                "p-vs-n",
                "two-group",
                factor=_factor(
                    COHORT,
                    [("P", ["SCI_P"]), ("N", ["SCI_nNP"]), ("C", ["CTRL"])],
                    "P",
                    "N",
                    "compared-groups",
                ),
            )
        ],
        subset=[
            {
                "variable": {"source": "registry", "column": "age"},
                "keep": {"min": None, "max": 48},
            }
        ],
    )

    resolved = dataset_v2.resolve(_context(tmp_path, cfg), spec)
    data = resolved.data

    reasons = _reasons(data)
    assert reasons["sub-01"] == "not-in-population"
    assert reasons["sub-10"] == "config-excluded"
    assert reasons["sub-09"] == "subset-filtered"  # Its age is 50.
    assert reasons["sub-06"] is None
    assert data.subject_ids == ["sub-06", "sub-07", "sub-08"]
    assert data.variables["registry:sourceCohortLabel"] == ["SCI_P"] * 3
    # The subset filters emptied SCI_nNP, which blocks the compute.
    assert resolved.subset_counts["p-vs-n"]["N"] == (1, 0)  # Without sub-10.
    with pytest.raises(GroupAnalysisError, match="leave no N subjects"):
        engine_input.load_engine_data(_context(tmp_path, cfg), spec)
    rows = {row["subjectId"]: row for row in data.subjects}
    assert rows["sub-06"]["group"] == "P"
    assert rows["sub-06"]["sourceLabel"] == "SCI_P"

    between = spec_v2(
        [
            _test(
                "two",
                "two-group",
                factor=_factor(COHORT, [("P", ["SCI_P"]), ("C", ["CTRL"])], "P", "C"),
            )
        ]
    )
    reasons = _reasons(dataset_v2.resolve(_context(tmp_path, cfg), between).data)
    assert reasons["sub-09"] == "no-group"  # SCI_nNP maps to no group.
    compared = spec_v2(
        [
            _test(
                "two",
                "two-group",
                factor=_factor(
                    COHORT,
                    [("P", ["SCI_P"]), ("N", ["SCI_nNP"]), ("C", ["CTRL"])],
                    "P",
                    "C",
                    "compared-groups",
                ),
            )
        ]
    )
    reasons = _reasons(dataset_v2.resolve(_context(tmp_path, cfg), compared).data)
    assert reasons["sub-09"] == "not-compared"


def test_a_subject_missing_one_tests_value_stays_for_the_others(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    clinical = tmp_path / "metadata" / "clinical.csv"
    clinical.write_text(
        clinical.read_text(encoding="utf-8")
        .replace("sub-06,SCI_P,A,Male,4", "sub-06,SCI_P,A,Male,")
        .replace("sub-07,SCI_P,A,Female,4", "sub-07,SCI_P,,Female,")
        .replace("sub-08,SCI_P,A,Male,4", "sub-08,SCI_P,B,Male,9"),
        encoding="utf-8",
    )
    ais = {"source": "clinical-csv", "column": "AIS"}
    spec = _within(
        [
            _test("tsi", "association", variable={"ref": TSI, "transform": "none"}),
            _test(
                "ais",
                "two-group",
                factor=_factor(
                    ais, [("A", ["A"]), ("B-D", ["B", "C", "D"])], "A", "B-D"
                ),
            ),
        ]
    )
    context = _context(tmp_path, cfg)

    resolved = dataset_v2.resolve(context, spec)

    reasons = _reasons(resolved.data)
    assert reasons["sub-06"] is None  # Has AIS but no time since injury.
    assert reasons["sub-07"] == "missing-variable"  # Has neither.
    tested = resolved.data.variables[variable_key(spec.tests[0].variable.ref)]
    assert tested[resolved.data.subject_ids.index("sub-06")] is None
    assert tested[resolved.data.subject_ids.index("sub-08")] == 9.0
    assert resolved.tests["tsi"].missing == 1
    assert resolved.tests["ais"].missing == 0
    check = dataset_v2.resolve_inputs(context, spec)["designCheck"]
    assert {
        "code": "test-availability",
        "severity": "warning",
        "testId": "tsi",
        "message": "1 subject has no value this test needs, so only this test "
        "leaves them out.",
    } in check["issues"]


# -- Variables -----------------------------------------------------------------------


def test_default_bin_labels_match_the_renderer() -> None:
    # Pinned in group-analysis-v2.test.ts as well.
    assert dataset_v2.default_bin_labels([30, 45.5, 1e21]) == [
        "<30",
        "30 to <45.5",
        "45.5 to <1e+21",
        ">=1e+21",
    ]


def _import(tmp_path: Path, context: AnalysisContext) -> str:
    path = tmp_path / "incoming.csv"
    path.write_text(
        "participant_id,level,uems,lems,score\n"
        "sub-06,cervical,40,45,-2\n"
        "sub-07,thoracic,50,2,0.5\n"
        "sub-08,cervical,30,30,3\n"
        "sub-09,thoracic,44,44,7\n"
        "sub-10,cervical,20,,1\n",
        encoding="utf-8",
    )
    return str(sources.import_variables(context, str(path))["tableId"])


def test_imported_and_derived_variables_resolve(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    context = _context(tmp_path, cfg)
    table = _import(tmp_path, context)

    def imported(column: str) -> dict[str, str]:
        return {"source": "imported", "table": table, "column": column}

    derived = [
        {
            "id": "dv-motor",
            "label": "Motor",
            "op": "sum",
            "inputs": [imported("uems"), imported("lems")],
            "params": {"cuts": [], "labels": []},
        },
        {
            "id": "dv-gap",
            "label": "Gap",
            "op": "difference",
            "inputs": [imported("uems"), imported("lems")],
            "params": {"cuts": [], "labels": []},
        },
        {
            "id": "dv-log-motor",
            "label": "Log motor",
            "op": "log1p",
            "inputs": [{"source": "derived", "column": "dv-motor"}],
            "params": {"cuts": [], "labels": []},
        },
        {
            "id": "dv-band",
            "label": "Motor band",
            "op": "bins",
            "inputs": [{"source": "derived", "column": "dv-motor"}],
            "params": {"cuts": [60, 85], "labels": []},
        },
    ]
    spec = _within(
        [
            _test(
                "motor",
                "association",
                variable={
                    "ref": {"source": "derived", "column": "dv-motor"},
                    "transform": "none",
                },
            ),
            _test(
                "log",
                "association",
                variable={
                    "ref": {"source": "derived", "column": "dv-log-motor"},
                    "transform": "none",
                },
                extraCovariates=[{"source": "derived", "column": "dv-gap"}],
            ),
            _test(
                "band",
                "two-group",
                factor=_factor(
                    {"source": "derived", "column": "dv-band"},
                    [("High", [">=85"]), ("Low", ["<60", "60 to <85"])],
                    "High",
                    "Low",
                ),
            ),
            _test(
                "level",
                "two-group",
                factor=_factor(
                    imported("level"),
                    [("Cervical", ["cervical"]), ("Thoracic", ["thoracic"])],
                    "Cervical",
                    "Thoracic",
                ),
            ),
        ],
        variables={"derived": derived},
    )

    data = dataset_v2.resolve(context, spec).data

    ids = data.subject_ids
    assert ids == ["sub-06", "sub-07", "sub-08", "sub-09", "sub-10"]
    motor = data.variables["derived:dv-motor"]
    assert motor == [85.0, 52.0, 60.0, 88.0, None]
    assert data.variables["derived:dv-log-motor"][0] == pytest.approx(math.log1p(85))
    assert data.variables["derived:dv-band"] == [
        ">=85",
        "<60",
        "60 to <85",
        ">=85",
        None,
    ]
    assert data.variables[f"imported:{table}:level"][0] == "cervical"
    assert data.test_covariates["log"]["derived:dv-gap"] == [-5.0, 48.0, 0.0, 0.0, None]
    assert f"variables:{table}" in data.state["usedSources"]
    row = next(r for r in data.inputs if r["source"] == f"variables:{table}")
    assert row["present"] is True
    assert len(row["sha256"]) == 64
    # sub-10 has no motor score but has the level: only some tests leave it out.
    assert _reasons(data)["sub-10"] is None


def test_log1p_of_values_at_or_below_minus_one_blocks(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    context = _context(tmp_path, cfg)
    table = _import(tmp_path, context)
    score = {"source": "imported", "table": table, "column": "score"}
    derived = {
        "id": "dv-log-score",
        "label": "Log score",
        "op": "log1p",
        "inputs": [score],
        "params": {"cuts": [], "labels": []},
    }
    spec = _within(
        [
            _test(
                "score",
                "association",
                variable={
                    "ref": {"source": "derived", "column": "dv-log-score"},
                    "transform": "none",
                },
            ),
            _test("raw", "association", variable={"ref": score, "transform": "log1p"}),
        ],
        variables={"derived": [derived]},
    )
    check = dataset_v2.resolve_inputs(context, spec)["designCheck"]
    messages = [i["message"] for i in check["issues"] if i["code"] == "log1p-domain"]
    assert messages == [
        "Log score takes log(1 + x) of values at or below \u22121 for 1 subject; "
        "log(1 + x) needs values above \u22121.",
        "score has values at or below \u22121; log(1 + x) needs values above \u22121.",
    ]
    assert check["ok"] is False
    with pytest.raises(GroupAnalysisError, match="log\\(1 \\+ x\\)"):
        engine_input.load_engine_data(context, spec)


def test_a_missing_variable_or_table_is_an_actionable_error(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    context = _context(tmp_path, cfg)
    table = _import(tmp_path, context)
    for ref, message in (
        (
            {"source": "imported", "table": table, "column": "nope"},
            "column the imported",
        ),
        (
            {"source": "imported", "table": "var-0000000000000000", "column": "x"},
            "Import the variables table again",
        ),
        (
            {"source": "measure", "column": "parc:yeo7:lh:Net1:ThickAvg"},
            "labels of the yeo7",
        ),
    ):
        spec = _within(
            [_test("t", "association", variable={"ref": ref, "transform": "none"})]
        )
        with pytest.raises(GroupAnalysisError, match=message):
            dataset_v2.resolve(context, spec)


# -- Measures and head size --------------------------------------------------------


def test_tier_a_measures_and_head_sizes_come_from_the_recons(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    for index, (subject_id, *_rest) in enumerate(IMAGED):
        if subject_id != "sub-05":
            write_recon(tmp_path / "derivatives", subject_id, index)
    context = _context(tmp_path, cfg)
    measures = [
        "vol:brainstem-ss:mid:Medulla",
        "parc:a2009s:bi:S_central:ThickAvg",
        "vol:thalamic:lh:AV",
        "parc:a2009s:lh:Nowhere:ThickAvg",
    ]
    tests = [_test("two", "two-group", factor=_factor(COHORT, SCI_CTRL, "SCI", "CTRL"))]
    for source, expected in (("stiv", stiv), ("synthseg-tiv", synthseg_tiv)):
        spec = spec_v2(
            tests,
            measures=measures,
            covariates={"headSize": {"source": source, "rule": "extensive"}},
        )
        data = engine_input.load_engine_data(context, spec)
        ids = data.subject_ids
        head = data.covariates[HEAD_SIZE_KEY]
        assert head[ids.index("sub-03")] == expected(2)
        # sub-05 has no recon, so no selected measure: it is left out.
        assert _reasons(data)["sub-05"] == "no-measures"
        assert data.measures["vol:brainstem-ss:mid:Medulla"][ids.index("sub-02")] == (
            medulla(1)
        )
        assert data.skipped == [
            {
                "measureId": "parc:a2009s:lh:Nowhere:ThickAvg",
                "reason": "No included subject's reconstruction has "
                "stats/lh.aparc.a2009s.stats with this measure.",
            }
        ]
        used = data.state["usedSources"]
        assert "stats:found-subregions" in used
        assert "stats:aseg-global" in used
        assert "icv" not in used
        inputs = {row["source"]: row for row in data.inputs}
        assert inputs["stats:a2009s"]["present"] is True
        assert inputs["stats:a2009s"]["sha256"] == sources.source_digest(
            context, "a2009s", ids
        )


def test_a_head_size_nobody_has_skips_the_measures_that_take_it(
    tmp_path: Path,
) -> None:
    cfg = make_project(tmp_path)
    spec = spec_v2(
        [_test("two", "two-group", factor=_factor(COHORT, SCI_CTRL, "SCI", "CTRL"))],
        covariates={"headSize": {"source": "stiv", "rule": "extensive"}},
    )
    data = engine_input.load_engine_data(_context(tmp_path, cfg), spec)
    assert data.skipped == [
        {
            "measureId": "aseg:Brain-Stem",
            "reason": "sTIV is a covariate of this measure, and no included "
            "subject's aseg.stats has it.",
        }
    ]
    assert HEAD_SIZE_KEY not in data.covariates
    assert list(data.measures) == ["dk:bi:precentral:ThickAvg"]


# -- Currency ------------------------------------------------------------------------


def test_the_registry_digest_reads_site_only_when_the_spec_does(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    registry = [dict(record) for record in RegistryStore(str(tmp_path)).list()]
    with_site = [{**record, "site": "Prisma"} for record in registry]
    spec = spec_v2(
        [_test("two", "two-group", factor=_factor(COHORT, SCI_CTRL, "SCI", "CTRL"))]
    )
    site_spec = spec_v2(
        [_test("two", "two-group", factor=_factor(COHORT, SCI_CTRL, "SCI", "CTRL"))],
        covariates={"extra": [{"source": "registry", "column": "site"}]},
    )

    def state(records: list[dict[str, Any]], which: Any) -> str:
        context = _context(tmp_path, cfg, registry=tuple(records))
        return str(dataset_v2.context_state(context, which)["registrySha256"])

    assert state(registry, spec) == state(with_site, spec)
    assert state(registry, site_spec) != state(with_site, site_spec)
    assert dataset_v2.site_of({"site": " "}) is None
    assert dataset_v2.site_of({"site": None}) is None
    assert dataset_v2.site_of({}) is None
    assert dataset_v2.site_of({"site": "Ingenia"}) == "Ingenia"


def _compute(tmp_path: Path, cfg: dict[str, Any], spec: Any) -> dict[str, Any]:
    out = io.StringIO()
    job = _job(
        tmp_path,
        cfg,
        spec=spec.model_dump(mode="json", by_alias=True),
        stageCurrency={
            "aggregate": "current",
            "pybrainage": "current",
            "recon": {"state": "current", "outdatedSubjectIds": []},
        },
    )
    assert worker.run_job(job, out) == 0, out.getvalue()
    from supraspina_sidecar.group_analysis import store  # noqa: PLC0415

    record = store.read_result(str(tmp_path), job["resultId"])
    assert record is not None
    return record


def test_a_v2_result_is_current_until_its_recon_files_change(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    for index, (subject_id, *_rest) in enumerate(IMAGED):
        write_recon(tmp_path / "derivatives", subject_id, index)
    spec = spec_v2(
        [_test("two", "two-group", factor=_factor(COHORT, SCI_CTRL, "SCI", "CTRL"))],
        measures=["vol:brainstem-ss:mid:Medulla", "aseg:Brain-Stem"],
    )
    record = _compute(tmp_path, cfg, spec)
    assert record["schemaVersion"] == 2
    assert record["provisional"] is False
    context = _context(tmp_path, cfg)
    assert manager.judge_currency(record, context) == ("current", [])

    path = (
        tmp_path
        / "derivatives"
        / "freesurfer"
        / "sub-04"
        / "mri"
        / "brainstemSsLabels.v13.volumes.txt"
    )
    path.write_text("Medulla 1\nPons 2\n", encoding="utf-8")
    currency, reasons = manager.judge_currency(record, context)
    assert currency == "stale"
    assert reasons == [
        {
            "code": "inputs-changed",
            "added": 0,
            "removed": 0,
            "sources": ["stats:found-subregions"],
        }
    ]
    # A site set in the registry does not touch a spec that never reads it.
    registry = tuple({**dict(r), "site": "Prisma"} for r in context.registry)
    path.write_text(
        "Medulla 4530.0\nPons 15003\nWhole_brainstem 26003\n", encoding="utf-8"
    )
    assert manager.judge_currency(
        record, _context(tmp_path, cfg, registry=registry)
    ) == ("current", [])


def test_the_fingerprint_follows_v2_input_files(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    write_recon(tmp_path / "derivatives", "sub-01", 0)
    context = _context(tmp_path, cfg)
    records = [{"schemaVersion": 2, "state": {"usedSources": ["stats:aseg-global"]}}]
    before = manager._fingerprint(context, records)
    assert before == manager._fingerprint(context, records)
    stats = tmp_path / "derivatives" / "freesurfer" / "sub-01" / "stats" / "aseg.stats"
    stats.write_text(stats.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    assert manager._fingerprint(context, records) != before
    assert manager._fingerprint(context, []) == manager._fingerprint(context)


def test_default_names_describe_the_tests() -> None:
    one = spec_v2(
        [
            _test(
                "a",
                "two-group",
                label="SCI vs CTRL",
                factor=_factor(COHORT, SCI_CTRL, "SCI", "CTRL"),
            )
        ]
    )
    assert manager.default_name(one) == "SCI vs CTRL"
    battery = copy.deepcopy(one.model_dump(mode="json", by_alias=True))
    battery["tests"].append({**battery["tests"][0], "id": "b", "label": "Other"})
    assert manager.default_name(parse_spec(battery)) == "SCI vs CTRL and 1 more"
    assert json.dumps(manager.default_name(one))
