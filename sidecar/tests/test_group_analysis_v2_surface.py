"""Tests for the frozen Analysis v2 surface: manager, store, atlas stubs."""

from __future__ import annotations

import ast
import io
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import __main__ as entrypoint
from supraspina_sidecar.group_analysis import (
    atlas_manager,
    atlas_recipes,
    atlas_sources,
    atlas_tools,
    atlas_worker,
    manager,
    store,
)
from supraspina_sidecar.group_analysis.atlas_manager import AtlasLabelingManager
from supraspina_sidecar.group_analysis.manager import GroupAnalysisManager
from supraspina_sidecar.group_analysis.spec import GroupAnalysisError
from supraspina_sidecar.project import ProjectEpochs
from tests.group_analysis_support import (
    example_spec,
    make_project,
    request,
    sample_record,
)

_ROOT = Path(__file__).resolve().parents[2]
_FIXTURES = Path(__file__).parent / "fixtures" / "group_analysis"
_MACHINE = {"subregionsPython": "/opt/py312/bin/python", "atlasCacheRoot": "/cache"}
_TIME = "2026-09-30T09:30:00.000Z"


def _v2_spec() -> dict[str, Any]:
    document = json.loads(
        (_FIXTURES / "spec-v2-omnibus.json").read_text(encoding="utf-8")
    )
    return document["spec"]


def _v2_row(term_id: str, measure_id: str) -> dict[str, Any]:
    return {"termId": term_id, "measureId": measure_id, "p": 0.5, "significant": False}


def _v2_record(result_id: str) -> dict[str, Any]:
    spec = _v2_spec()
    terms = [
        {"termId": f"term-{index}", "testId": "cohort", "rowCount": 3}
        for index in (1, 2)
    ]
    rows = [
        _v2_row(term["termId"], measure)
        for term in terms
        for measure in spec["measures"]
    ]
    return sample_record(
        result_id,
        _TIME,
        schemaVersion=2,
        spec=spec,
        terms=terms,
        rows=rows,
    )


# -- Manager ---------------------------------------------------------------------


def test_catalog_lists_the_variable_tables(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    catalog = GroupAnalysisManager(ProjectEpochs()).catalog(request(tmp_path, cfg))
    assert catalog["variableTables"] == []


def test_inputs_check_the_design_of_v2_only_and_start_v2(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    spawned: list[list[str]] = []

    def spawn(argv: list[str]) -> Any:
        spawned.append(argv)
        raise OSError("no worker in this test")

    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    inputs = mgr.inputs(request(tmp_path, cfg, spec=example_spec()))
    assert inputs["designCheck"] is None
    v2 = mgr.inputs(request(tmp_path, cfg, spec=_v2_spec()))
    assert set(v2["designCheck"]) == {
        "ok",
        "issues",
        "tests",
        "cells",
        "vif",
        "crosstabs",
    }
    assert v2["included"] > 0
    started = mgr.start(
        request(
            tmp_path,
            cfg,
            spec=_v2_spec(),
            stageCurrency={"aggregate": "current", "pybrainage": "current"},
        )
    )
    assert started["started"] is True


@pytest.mark.parametrize(
    "currency",
    [
        {"aggregate": "current", "pybrainage": "unknown"},
        {
            "aggregate": "current",
            "pybrainage": "unknown",
            "recon": {"state": "outdated", "outdatedSubjectIds": ["sub-101"]},
        },
    ],
)
def test_stage_currency_accepts_v1_and_v2(currency: dict[str, Any]) -> None:
    assert manager.stage_currency(currency) is currency


@pytest.mark.parametrize(
    "currency",
    [
        {"aggregate": "current"},
        {"aggregate": "fresh", "pybrainage": "unknown"},
        {
            "aggregate": "current",
            "pybrainage": "unknown",
            "recon": {"state": "outdated", "outdatedSubjectIds": ["../x"]},
        },
        {
            "aggregate": "current",
            "pybrainage": "unknown",
            "recon": {"state": "outdated"},
        },
    ],
)
def test_stage_currency_refuses_malformed_records(currency: dict[str, Any]) -> None:
    with pytest.raises(GroupAnalysisError):
        manager.stage_currency(currency)


def test_v2_results_page_their_terms(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    mgr = GroupAnalysisManager(ProjectEpochs())
    result_id = "gar-00000000000000a2"
    store.write_result(str(tmp_path), _v2_record(result_id))

    result = mgr.result(request(tmp_path, cfg, resultId=result_id))
    assert [term["termId"] for term in result["terms"]] == ["term-1", "term-2"]
    assert {row["termId"] for row in result["rows"]} == {"term-1"}

    page = mgr.term_rows(
        request(tmp_path, cfg, resultId=result_id, termId="term-2", offset=1)
    )
    assert page["total"] == 3
    assert page["offset"] == 1
    assert len(page["rows"]) == 2
    assert page["nextOffset"] is None

    with pytest.raises(GroupAnalysisError, match="term this result"):
        mgr.term_rows(
            request(tmp_path, cfg, resultId=result_id, termId="term-9", offset=0)
        )
    with pytest.raises(GroupAnalysisError, match="row offset"):
        mgr.term_rows(
            request(tmp_path, cfg, resultId=result_id, termId="term-1", offset=-1)
        )
    with pytest.raises(GroupAnalysisError, match="term ID"):
        mgr.term_rows(request(tmp_path, cfg, resultId=result_id, termId="x", offset=0))
    # A record without stored detail still returns the term's row.
    detail = mgr.measure_detail(
        request(
            tmp_path,
            cfg,
            resultId=result_id,
            measureId="aseg:Brain-Stem",
            termId="term-2",
        )
    )
    assert detail["termId"] == "term-2"
    assert detail["row"]["termId"] == "term-2"
    assert (detail["groupMeans"], detail["subjects"], detail["fit"]) == ([], [], [])
    with pytest.raises(GroupAnalysisError, match="term ID"):
        mgr.measure_detail(
            request(
                tmp_path,
                cfg,
                resultId=result_id,
                measureId="aseg:Brain-Stem",
                termId="t2",
            )
        )

    listed = mgr.list(request(tmp_path, cfg))["results"]
    summary = next(item for item in listed if item["resultId"] == result_id)
    assert summary["schemaVersion"] == 2
    assert summary["analysis"] is None
    # The stub record names the v1 engine and no registry facts: stale.
    assert summary["currency"] == "stale"
    assert "engine-changed" in {row["code"] for row in summary["staleReasons"]}
    assert summary["measureCount"] == 3


def test_v1_results_have_no_terms(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    mgr = GroupAnalysisManager(ProjectEpochs())
    result_id = "gar-00000000000000a1"
    store.write_result(str(tmp_path), sample_record(result_id, _TIME))
    with pytest.raises(GroupAnalysisError, match="term this result"):
        mgr.term_rows(
            request(tmp_path, cfg, resultId=result_id, termId="term-1", offset=0)
        )
    summary = mgr.list(request(tmp_path, cfg))["results"][0]
    assert summary["schemaVersion"] == 1
    assert summary["analysis"] == "group-comparison"


def test_variables_imports_are_main_internal(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    mgr = GroupAnalysisManager(ProjectEpochs())
    with pytest.raises(GroupAnalysisError, match="absolute path"):
        mgr.import_variables(request(tmp_path, cfg, path="relative.csv"))
    with pytest.raises(GroupAnalysisError, match="that exists"):
        mgr.import_variables(request(tmp_path, cfg, path=str(tmp_path / "v.csv")))
    with pytest.raises(GroupAnalysisError, match="valid variables table"):
        mgr.delete_variables(request(tmp_path, cfg, tableId="table"))
    with pytest.raises(GroupAnalysisError, match="Select an imported"):
        mgr.delete_variables(request(tmp_path, cfg, tableId="var-0123456789abcdef"))


def test_measure_detail_accepts_only_the_optional_term(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    mgr = GroupAnalysisManager(ProjectEpochs())
    with pytest.raises(GroupAnalysisError, match="valid group-analysis request"):
        mgr.measure_detail(
            request(
                tmp_path,
                cfg,
                resultId="gar-00000000000000a1",
                measureId="aseg:Brain-Stem",
                other=1,
            )
        )


# -- Atlas labeling manager --------------------------------------------------------


def test_atlases_returns_a_contract_payload(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    mgr = AtlasLabelingManager(
        ProjectEpochs(), probe=lambda home, python: atlas_tools.probe_tools(None, None)
    )
    catalog = mgr.atlases(
        request(tmp_path, cfg, machine=_MACHINE, reconOutdatedSubjectIds=[])
    )
    assert set(catalog) == {
        "configRevision",
        "revision",
        "atlases",
        "tools",
        "subregionsPython",
        "labeling",
    }
    assert catalog["configRevision"] == 3
    assert catalog["subregionsPython"] == "/opt/py312/bin/python"
    assert catalog["labeling"] is None
    assert len(catalog["atlases"]) == len(atlas_recipes.BUILT_IN_ATLASES)


@pytest.mark.parametrize(
    "machine",
    [
        None,
        {"subregionsPython": None},
        {"subregionsPython": "python3", "atlasCacheRoot": None},
        {"subregionsPython": None, "atlasCacheRoot": 7},
    ],
)
def test_machine_tools_must_be_absolute_or_null(tmp_path: Path, machine: Any) -> None:
    cfg = make_project(tmp_path)
    with pytest.raises(GroupAnalysisError, match="machine-level"):
        AtlasLabelingManager(ProjectEpochs()).atlases(
            request(tmp_path, cfg, machine=machine, reconOutdatedSubjectIds=[])
        )


def test_labeling_requests_are_exact(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    mgr = AtlasLabelingManager(ProjectEpochs())
    with pytest.raises(GroupAnalysisError, match="valid atlas labeling request"):
        mgr.atlases(request(tmp_path, cfg))
    status = mgr.label_status(request(tmp_path, cfg, atlasId=None))
    assert status == {"operation": None, "atlasId": None, "subjects": []}
    assert mgr.label_status(request(tmp_path, cfg, atlasId="brainstem-ss"))[
        "atlasId"
    ] == ("brainstem-ss")
    with pytest.raises(GroupAnalysisError, match="valid atlas ID"):
        mgr.label_status(request(tmp_path, cfg, atlasId="../x"))
    assert mgr.label_cancel(
        request(tmp_path, cfg, operationId="alb-0123456789abcdef")
    ) == {"operationId": "alb-0123456789abcdef", "stopped": False}
    with pytest.raises(GroupAnalysisError, match="labeling operation ID"):
        mgr.label_cancel(request(tmp_path, cfg, operationId="gan-0123456789abcdef"))


def test_stop_all_and_foreign_projects_cancel_a_running_labeling(
    tmp_path: Path,
) -> None:
    cfg = make_project(tmp_path)
    projects = ProjectEpochs()
    mgr = AtlasLabelingManager(projects)
    project = projects.validate(request(tmp_path, cfg)["project"], cfg)
    operation = atlas_manager._Operation(
        operation_id="alb-0123456789abcdef",
        project=project,
        atlas_id="brainstem-ss",
        started_at=_TIME,
        total=4,
    )
    mgr._operation = operation
    assert mgr.atlases(
        request(tmp_path, cfg, machine=_MACHINE, reconOutdatedSubjectIds=[])
    )["labeling"]["state"] == ("running")
    assert mgr.label_cancel(
        request(tmp_path, cfg, operationId="alb-0123456789abcdef")
    ) == {"operationId": "alb-0123456789abcdef", "stopped": True}
    assert operation.state == "cancelled"

    operation.state = "running"
    other = tmp_path / "other"
    other.mkdir()
    other_cfg = make_project(other)
    mgr.label_status(
        request(other, other_cfg, project_id="other-project", atlasId=None)
    )
    assert operation.message == "The project changed."

    operation.state = "running"
    mgr.stop_all(timeout=0.1)
    assert operation.state == "cancelled"


def test_dispatcher_stops_the_labeling_on_detach_and_shutdown(tmp_path: Path) -> None:
    dispatcher = entrypoint.build_dispatcher(entrypoint.Emitter(io.StringIO()))
    calls: list[float] = []
    dispatcher.atlas_labeling_manager.stop_all = lambda timeout=0.0: calls.append(
        timeout
    )
    try:
        project = request(tmp_path, {})["project"]
        dispatcher.workflow_manager.project_epochs.validate(project)
        dispatcher._handlers["system.detachProject"](
            [{"project": project}], dispatcher.emitter
        )
        dispatcher._handlers["system.shutdown"](
            [{"timeoutMs": 500}], dispatcher.emitter
        )
    finally:
        dispatcher.managed_resource_manager.shutdown()
        dispatcher.provision_manager.shutdown()
        dispatcher.workflow_manager.shutdown()
        dispatcher.workflow_manager.project_epochs.detach_all()
    assert calls == [0.0, 0.5]


# -- Recipes, sources, worker ----------------------------------------------------


def _ts_list(name: str, text: str) -> list[str]:
    match = re.search(rf"export const {name} = \[(.*?)\] as const", text, re.DOTALL)
    assert match is not None
    return re.findall(r"'([^']+)'", match.group(1))


def test_recipes_and_sources_mirror_the_typescript_contract() -> None:
    text = (_ROOT / "src" / "shared" / "atlas-labeling.ts").read_text(encoding="utf-8")
    assert list(atlas_recipes.RECIPES) == _ts_list("ATLAS_RECIPE_IDS", text)
    for recipe in atlas_recipes.RECIPES.values():
        block = re.search(rf"recipeId: '{recipe.recipe_id}',\s+version: (\d+),", text)
        assert block is not None
        assert int(block.group(1)) == recipe.version
    ts_sources = re.findall(r"sourceId: '([a-z0-9-]+)'", text)
    assert list(atlas_sources.SOURCES) == ts_sources
    for source in atlas_sources.SOURCES.values():
        assert source.page_url.startswith("https://")
        assert f"version: '{source.version}'" in text
        assert f"recipeId: '{source.recipe_id}'" in text
    pinned = atlas_sources.SOURCES["schaefer2018"].files
    assert [(item.sha256, item.bytes) for item in pinned] == [
        (sha, int(size))
        for sha, size in re.findall(
            r"sha256:\s+'([a-f0-9]{64})',\s+bytes: (\d+),", text
        )
    ]
    for item in pinned:
        assert f"url: '{item.url}'" in text
        assert item.relpath in text
    assert all(
        source.files == ()
        for source_id, source in atlas_sources.SOURCES.items()
        if source_id != "schaefer2018"
    )
    assert atlas_recipes.expand("{hemi}.{atlas}.annot", "yeo7") == [
        "lh.yeo7.annot",
        "rh.yeo7.annot",
    ]
    assert atlas_recipes.expand("{atlas}.stats", "user-0a1b2c3d") == [
        "user-0a1b2c3d.stats"
    ]


def test_source_cache_folders_follow_the_grammar() -> None:
    assert atlas_sources.cache_dir("/c", "schaefer2018", "v1.0") == (
        "/c/schaefer2018/v1.0"
    )
    for source_id, version in (("../x", "v1"), ("schaefer2018", "../v")):
        with pytest.raises(ValueError, match="valid atlas source"):
            atlas_sources.cache_dir("/c", source_id, version)


def test_the_labeling_worker_forms_and_refuses_malformed_jobs(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(atlas_worker.sys, "frozen", True, raising=False)
    assert atlas_worker.worker_command()[1:] == [atlas_worker.WORKER_FLAG]
    monkeypatch.delattr(atlas_worker.sys, "frozen")
    assert atlas_worker.worker_command() == [
        sys.executable,
        "-m",
        "supraspina_sidecar.group_analysis.atlas_worker",
    ]
    for payload in (b"{", b"{}"):
        monkeypatch.setattr(
            atlas_worker.sys, "stdin", io.TextIOWrapper(io.BytesIO(payload))
        )
        assert atlas_worker.main([]) == 1
    job = json.dumps({"schema": atlas_worker.JOB_SCHEMA}).encode()
    monkeypatch.setattr(atlas_worker.sys, "stdin", io.TextIOWrapper(io.BytesIO(job)))
    assert atlas_worker.main([]) == 1
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events[-1] == {
        "event": "failed",
        "message": "The labeling job is malformed.",
    }


def test_the_development_labeling_worker_starts() -> None:
    completed = subprocess.run(  # noqa: S603 - The argv is worker_command().
        atlas_worker.worker_command(),
        input=b"{}",
        capture_output=True,
        cwd=_ROOT / "sidecar",
        env={"PATH": "/usr/bin:/bin"},
        timeout=60,
        check=False,
    )
    assert completed.returncode == 1
    assert json.loads(completed.stdout)["event"] == "failed"


def test_frozen_entry_routes_the_labeling_flag_before_the_package_import() -> None:
    entry = _ROOT / "sidecar" / "pyinstaller_entry.py"
    source = entry.read_text(encoding="utf-8")
    tree = ast.parse(source)
    package_import = next(
        index
        for index, statement in enumerate(tree.body)
        if isinstance(statement, ast.ImportFrom)
        and statement.module == "supraspina_sidecar.__main__"
    )
    routed = [
        statement
        for statement in tree.body[:package_import]
        if isinstance(statement, ast.If)
        and "_ATLAS_LABELING_WORKER_ARG" in ast.unparse(statement.test)
    ]
    assert len(routed) == 1
    assert f'"{atlas_worker.WORKER_FLAG}"' in source
