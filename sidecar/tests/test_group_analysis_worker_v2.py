"""The worker's v2 path: records with terms, detail, currency, and the size cap."""

from __future__ import annotations

import copy
import io
import json
import math
import os
import re
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.group_analysis import (
    engine_input,
    engine_v2,
    identity,
    result_detail,
    store,
    worker,
)
from supraspina_sidecar.group_analysis.manager import GroupAnalysisManager
from supraspina_sidecar.group_analysis.spec import GroupAnalysisError, parse_spec
from supraspina_sidecar.project import ProjectEpochs
from tests.group_analysis_support import make_project, request
from tests.test_group_analysis_engine_v2 import CASES, case_input
from tests.test_group_analysis_worker import _job

_RESULT_ID = "gar-0123456789abcdef"
_TIME = "2026-09-30T12:00:00.000Z"
EXAMPLE = (
    Path(__file__).parent / "fixtures" / "group_analysis" / "result-v2-example.json"
)


def _input(case: dict[str, Any], **changes: Any) -> engine_input.EngineDataV2:
    data = case_input(case)
    data.subjects = [
        {
            "subjectId": subject_id,
            "group": None,
            "sourceLabel": label,
            "included": True,
            "reason": None,
            "missingHemispheres": [],
        }
        for subject_id, label in zip(data.subject_ids, data.source_labels, strict=True)
    ] + [
        {
            "subjectId": "sub-900",
            "group": None,
            "sourceLabel": "CTRL",
            "included": False,
            "reason": "not-in-population",
            "missingHemispheres": [],
        }
    ]
    data.issues = ["One fact about the sample."]
    for key, value in changes.items():
        setattr(data, key, value)
    return data


def _run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    case: dict[str, Any],
    data: engine_input.EngineDataV2 | None = None,
    **job: Any,
) -> tuple[int, list[dict[str, Any]]]:
    cfg = make_project(tmp_path)
    loaded = data or _input(case)
    monkeypatch.setattr(engine_input, "load_engine_data", lambda _c, _s: loaded)
    monkeypatch.setattr(store, "timestamp", lambda: _TIME)
    out = io.StringIO()
    status = worker.run_job(
        _job(tmp_path, cfg, spec=case["spec"], name="Within SCI", **job), out
    )
    return status, [json.loads(line) for line in out.getvalue().splitlines()]


def test_a_v2_job_writes_a_record_with_terms(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = CASES["battery-missingness-bh"]
    status, events = _run(tmp_path, monkeypatch, case)
    assert status == 0, events
    assert events[-1] == {"event": "done", "resultId": _RESULT_ID}
    assert {"permuting", "fitting", "writing"} <= {e.get("phase") for e in events}
    record = store.read_result(str(tmp_path), _RESULT_ID)
    assert record is not None
    assert record["schemaVersion"] == 2
    assert record["engine"]["id"] == identity.ENGINE_ID_V2
    assert [t["termId"] for t in record["terms"]] == [
        "term-1",
        "term-2",
        "term-3",
        "term-4",
    ]
    assert record["terms"] == case["expected"]["terms"]
    assert len(record["rows"]) == len(case["expected"]["rows"])
    assert record["sample"]["groups"][0] == {"label": "SCI", "n": 38}
    assert record["sample"]["included"] == 38
    assert record["sample"]["excluded"] == [
        {"subjectId": "sub-900", "reason": "not-in-population"}
    ]
    assert record["sample"]["issues"] == ["One fact about the sample."]
    # The job's Brain-PAD stage is outdated and the spec reads Brain-PAD.
    assert record["provisional"] is True
    assert record["detail"]["subjectValues"] is True

    mgr = GroupAnalysisManager(ProjectEpochs())
    cfg = make_project(tmp_path)
    public = mgr.result(request(tmp_path, cfg, resultId=_RESULT_ID))
    assert {row["termId"] for row in public["rows"]} == {"term-1"}
    page = mgr.term_rows(
        request(tmp_path, cfg, resultId=_RESULT_ID, termId="term-4", offset=0)
    )
    assert page["total"] == 10
    assert all(row["pCorrected"] is None for row in page["rows"])
    detail = mgr.measure_detail(
        request(
            tmp_path,
            cfg,
            resultId=_RESULT_ID,
            termId="term-3",
            measureId="aseg:Brain-Stem",
        )
    )
    assert detail["row"]["termId"] == "term-3"
    assert len(detail["subjects"]) == detail["row"]["nTotal"]
    assert detail["fit"][0]["group"] is None
    assert detail["simpleSlopes"] == []
    first = mgr.measure_detail(
        request(tmp_path, cfg, resultId=_RESULT_ID, measureId="aseg:Brain-Stem")
    )
    assert first["termId"] == "term-1"
    with pytest.raises(GroupAnalysisError, match="measure this result"):
        mgr.measure_detail(
            request(
                tmp_path,
                cfg,
                resultId=_RESULT_ID,
                termId="term-1",
                measureId="aseg:Pons",
            )
        )


def test_a_v1_record_refuses_a_term(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tests.group_analysis_support import sample_record  # noqa: PLC0415

    cfg = make_project(tmp_path)
    store.write_result(str(tmp_path), sample_record(_RESULT_ID, _TIME))
    mgr = GroupAnalysisManager(ProjectEpochs())
    with pytest.raises(GroupAnalysisError, match="term this result"):
        mgr.measure_detail(
            request(
                tmp_path,
                cfg,
                resultId=_RESULT_ID,
                termId="term-1",
                measureId="aseg:Brain-Stem",
            )
        )
    del monkeypatch


def test_the_cap_applies_to_the_sealed_record_at_its_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = CASES["omnibus-pairwise-maxt-pooled"]
    data = _input(case)
    status, _events = _run(tmp_path, monkeypatch, case, data)
    assert status == 0
    stored = store.read_result(str(tmp_path), _RESULT_ID)
    assert stored is not None
    assert stored["detail"]["subjectValues"] is True
    sealed = len(store.canonical_json(stored).encode("utf-8"))
    unsealed = {k: v for k, v in stored.items() if k not in {"pinned", "resultSha256"}}
    assert store.sealed_size(unsealed) == sealed
    assert len(store.canonical_json(unsealed).encode("utf-8")) < sealed - 1
    for cap, kept, result_id in (
        (sealed, True, "gar-0123456789abcde1"),
        # Within the seal's bytes of the cap: stripped, never refused.
        (sealed - 1, False, "gar-0123456789abcde2"),
    ):
        monkeypatch.setattr(store, "MAX_RECORD_BYTES_V2", cap)
        status, events = _run(tmp_path, monkeypatch, case, data, resultId=result_id)
        assert status == 0, events
        record = store.read_result(str(tmp_path), result_id)
        assert record is not None
        assert record["detail"]["subjectValues"] is kept


def test_the_record_drops_subject_values_over_the_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = CASES["omnibus-pairwise-maxt-pooled"]
    data = _input(case)
    full = worker.build_record_v2(
        _job(tmp_path, {}, spec=case["spec"]),
        parse_spec(case["spec"]),
        data,
        engine_v2.run(
            data,
            parse_spec(case["spec"]),
            progress=lambda *_: None,
            cancelled=lambda: False,
        ),
    )
    size = len(store.canonical_json(full).encode("utf-8"))
    full["detail"] = result_detail.strip_subject_values(full["detail"])
    stripped = len(store.canonical_json(full).encode("utf-8"))
    assert stripped < size
    monkeypatch.setattr(store, "MAX_RECORD_BYTES_V2", (size + stripped) // 2)
    status, _events = _run(tmp_path, monkeypatch, case, data)
    assert status == 0
    record = store.read_result(str(tmp_path), _RESULT_ID)
    assert record is not None
    assert record["detail"]["subjectValues"] is False
    detail = result_detail.measure_detail(record, "term-1", "aseg:Brain-Stem")
    assert detail["subjects"] == []
    assert len(detail["groupMeans"]) == 3

    monkeypatch.setattr(store, "MAX_RECORD_BYTES_V2", 1000)
    # The store refuses what the worker would: one cap, stated once.
    with pytest.raises(GroupAnalysisError, match="larger than 32 MiB"):
        store.write_result(str(tmp_path), record)
    status, events = _run(
        tmp_path, monkeypatch, case, data, resultId="gar-0123456789abcde0"
    )
    assert status == 1
    assert events[-1] == {
        "event": "failed",
        "message": "The result would be larger than 32 MiB; select fewer "
        "measures, tests, or strata.",
    }


def test_a_v2_job_without_its_variables_table_fails_with_one_sentence(
    tmp_path: Path,
) -> None:
    cfg = make_project(tmp_path)
    out = io.StringIO()
    case = CASES["battery-missingness-bh"]
    assert worker.run_job(_job(tmp_path, cfg, spec=case["spec"]), out) == 1
    event = json.loads(out.getvalue().splitlines()[-1])
    assert event["event"] == "failed"
    assert event["message"] == (
        "Import the variables table again; this project no longer lists it."
    )


def test_a_v2_job_that_fits_nothing_reports_the_skips(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = copy.deepcopy(CASES["omnibus-pairwise-maxt-pooled"])
    case["spec"]["inclusion"]["minCellN"] = 20
    status, events = _run(tmp_path, monkeypatch, case)
    assert status == 1
    assert events[-1]["event"] == "failed"
    assert events[-1]["message"] == (
        "No selected measure could be fit: all 20 measures were skipped because "
        "fewer than 20 subjects of SCI_nNP have this measure."
    )
    assert events[-1]["skipped"][0]["measureId"] == "aseg:Brain-Stem"
    data = _input(case, measures={})
    status, events = _run(tmp_path, monkeypatch, case, data)
    assert status == 1
    assert events[-1]["message"] == "No selected measure could be fit."


@pytest.mark.parametrize(
    ("measures", "head", "currency", "provisional"),
    [
        (
            ["aseg:Brain-Stem"],
            "etiv",
            {"aggregate": "current", "pybrainage": "outdated"},
            False,
        ),
        (
            ["aseg:Brain-Stem"],
            "etiv",
            {"aggregate": "outdated", "pybrainage": "current"},
            True,
        ),
        (
            ["brainage:BrainPAD"],
            "etiv",
            {"aggregate": "outdated", "pybrainage": "current"},
            False,
        ),
        (
            ["parc:a2009s:lh:G_front_sup:ThickAvg"],
            "none",
            {"aggregate": "current", "pybrainage": "current"},
            True,
        ),
        (
            ["parc:a2009s:lh:G_front_sup:ThickAvg"],
            "none",
            {
                "aggregate": "outdated",
                "pybrainage": "current",
                "recon": {"state": "current", "outdatedSubjectIds": []},
            },
            False,
        ),
        (
            ["vol:brainstem-ss:mid:Medulla"],
            "etiv",
            {
                "aggregate": "current",
                "pybrainage": "current",
                "recon": {"state": "current", "outdatedSubjectIds": ["sub-001"]},
            },
            True,
        ),
        (
            ["aseg:Brain-Stem"],
            "stiv",
            {
                "aggregate": "current",
                "pybrainage": "current",
                "recon": {"state": "unknown", "outdatedSubjectIds": []},
            },
            True,
        ),
    ],
)
def test_provisional_follows_the_stages_the_values_read(
    measures: list[str], head: str, currency: dict[str, Any], provisional: bool
) -> None:
    spec_data = copy.deepcopy(CASES["battery-missingness-bh"]["spec"])
    spec_data["measures"] = measures
    spec_data["covariates"]["headSize"] = {"source": head, "rule": "extensive"}
    data = engine_input.EngineDataV2(
        subject_ids=["sub-001"],
        source_labels=[None],
        variables={},
        covariates={},
        measures={},
    )
    assert worker._provisional_v2(parse_spec(spec_data), currency, data) is provisional


def test_unjudged_checks_make_a_v2_result_provisional() -> None:
    spec_data = copy.deepcopy(CASES["battery-missingness-bh"]["spec"])
    spec_data["measures"] = ["dk:lh:precentral:ThickAvg"]
    current = {"aggregate": "current", "pybrainage": "current"}
    data = engine_input.EngineDataV2(
        subject_ids=[], source_labels=[], variables={}, covariates={}, measures={}
    )
    spec = parse_spec(spec_data)
    assert worker._provisional_v2(spec, current, data) is False
    data.registration_provisional = True
    assert worker._provisional_v2(spec, current, data) is True
    data.registration_provisional = False
    data.outliers_unapplied = True
    assert worker._provisional_v2(spec, current, data) is True


def test_fit_lines_have_fifty_points_ending_at_the_range() -> None:
    entry = {
        "s2": 4.0,
        "df": 20,
        "lines": [
            {
                "group": "A",
                "xMin": 1.0,
                "xMax": 3.0,
                "xMean": 2.0,
                "intercept": 5.0,
                "slope": 0.5,
                "v00": 0.1,
                "v01": 0.0,
                "v11": 0.04,
            }
        ],
    }
    (line,) = result_detail.fit_lines(entry)
    assert len(line["x"]) == result_detail.LINE_POINTS
    assert (line["x"][0], line["x"][-1]) == (1.0, 3.0)
    assert line["y"][0] == pytest.approx(4.5)
    (slope,) = result_detail.simple_slopes(entry)
    half = 2.0859634472658644 * math.sqrt(0.04 * 4.0)
    assert slope["low"] == pytest.approx(0.5 - half, rel=1e-12)


# ------------------------------------------------ Cross-language fixture --
def _example(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    case = copy.deepcopy(CASES["stratified-heterogeneity-maxt"])
    case["spec"]["measures"] = case["spec"]["measures"][:3]
    status, events = _run(tmp_path, monkeypatch, case)
    assert status == 0, events
    record = store.read_result(str(tmp_path), _RESULT_ID)
    assert record is not None
    return {
        "result": store.public_result(record),
        "termRows": store.term_rows(record, "term-3", 1),
        "measureDetail": result_detail.measure_detail(
            record, "term-5", "aseg:Brain-Stem"
        ),
    }


def _close(path: str, actual: Any, expected: Any) -> None:
    if isinstance(expected, dict):
        assert set(actual) == set(expected), path
        for key in expected:
            _close(f"{path}.{key}", actual[key], expected[key])
    elif isinstance(expected, list):
        assert len(actual) == len(expected), path
        for index, (a, b) in enumerate(zip(actual, expected, strict=True)):
            _close(f"{path}[{index}]", a, b)
    elif isinstance(expected, float) and path.rsplit(".", maxsplit=1)[-1] not in {
        "pPermutation",
        "pCorrected",
    }:
        assert abs(actual - expected) <= 1e-9 * abs(expected) + 1e-12, path
    elif path.endswith("resultSha256"):
        assert isinstance(actual, str)
        assert len(actual) == 64
    else:
        assert actual == expected, path


def test_the_cross_language_result_fixture_is_current(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    example = _example(tmp_path, monkeypatch)
    if os.environ.get("SUPRASPINA_WRITE_FIXTURES") == "1":
        EXAMPLE.write_text(json.dumps(example, indent=1) + "\n", encoding="utf-8")
    stored = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    _close("example", example, stored)


def test_a_large_v2_header_keeps_the_first_rows_that_fit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = CASES["battery-missingness-bh"]
    status, events = _run(tmp_path, monkeypatch, case)
    assert status == 0, events
    mgr = GroupAnalysisManager(ProjectEpochs())
    cfg = make_project(tmp_path)
    whole = mgr.result(request(tmp_path, cfg, resultId=_RESULT_ID))
    header = len(json.dumps({**whole, "rows": []}, separators=(",", ":")))
    row = len(json.dumps(whole["rows"][0], separators=(",", ":")))
    # Room for the header and about three rows.
    monkeypatch.setattr(
        "supraspina_sidecar.group_analysis.manager.MAX_RESULT_BYTES",
        header + 3 * (row + 1) + row // 2,
    )

    trimmed = mgr.result(request(tmp_path, cfg, resultId=_RESULT_ID))

    assert 0 < len(trimmed["rows"]) < len(whole["rows"])
    assert trimmed["rows"] == whole["rows"][: len(trimmed["rows"])]
    assert trimmed["terms"] == whole["terms"]
    assert trimmed["spec"] == whole["spec"]
    monkeypatch.setattr(
        "supraspina_sidecar.group_analysis.manager.MAX_RESULT_BYTES", 64
    )
    with pytest.raises(GroupAnalysisError, match="larger than the panel"):
        mgr.result(request(tmp_path, cfg, resultId=_RESULT_ID))


def test_the_v2_record_cap_matches_the_typescript_constant() -> None:
    source = (
        Path(__file__).resolve().parents[2] / "src" / "shared" / "group-analysis.ts"
    ).read_text(encoding="utf-8")
    match = re.search(
        r"GROUP_ANALYSIS_MAX_RECORD_BYTES_V2 = (\d+) \* 1024 \* 1024", source
    )
    assert match is not None
    assert int(match.group(1)) * 1024 * 1024 == store.MAX_RECORD_BYTES_V2
