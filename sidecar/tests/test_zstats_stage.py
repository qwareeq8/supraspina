"""The z-score group comparisons stage.

The stage runs the R analysis script's ``--track zscores`` mode on the
BrainCharts z-score table. These tests cover the adapter's argv, checks,
detector and failure tags, the planner's blockers, the receipt bindings, and,
with Rscript, the refused-site fact in the report and a run on a z-score table
the BrainCharts script published.
"""

from __future__ import annotations

import csv
import subprocess
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import (
    final_r_contract,
    provenance,
    resources,
    results,
    workflow,
)
from supraspina_sidecar.adapters import zstats as zstats_module
from supraspina_sidecar.adapters.base import ADAPTERS, StepStatus, Validation
from supraspina_sidecar.adapters.final import (
    COMPARISON_CODES,
    PLAIN_SCRIPT,
    RMD_TEMPLATE,
)
from supraspina_sidecar.cohort import CohortSnapshot
from supraspina_sidecar.registry import STEP_BY_KEY, STEP_DESCRIPTORS
from supraspina_sidecar.registry_store import RegistryStore
from supraspina_sidecar.schema import validate_project_config
from supraspina_sidecar.workflow import build_plan
from tests.test_braincharts_stage import (
    _args,
    _FakePcntoolkit,
    _valid_project_config,
    _write_inputs,
    _write_lists,
    bc,
)
from tests.test_final import (
    _read_result_table,
    _require_rscript,
    _result_tables,
    _zscore_report,
)

_ADAPTER = ADAPTERS["zstats"]
_STEP9 = resources.step9_dir()


def _cfg(root: Path, **params: Any) -> dict[str, Any]:
    return {
        "paths": {"projectRoot": str(root), "outputDir": str(root / "out")},
        "tools": {"rscriptExecutable": "/usr/bin/Rscript"},
        "steps": {"zstats": {"enabled": True, "params": params}},
    }


# -- Descriptor and configuration ---------------------------------------------------------


def test_the_stage_is_appended_after_braincharts() -> None:
    assert [item["key"] for item in STEP_DESCRIPTORS[-3:]] == [
        "final",
        "braincharts",
        "zstats",
    ]
    assert STEP_BY_KEY["zstats"] == {
        "id": 9.5,
        "key": "zstats",
        "name": "Z-score group comparisons",
        "goal": (
            "Compares BrainCharts z-scores between cohorts with per-region Welch "
            "t-tests and Hedges g, pooling the adapted sites."
        ),
        "scope": "cohort",
        "dependencies": ["braincharts"],
    }
    assert _ADAPTER.name == STEP_BY_KEY["zstats"]["name"]
    assert _ADAPTER.goal == STEP_BY_KEY["zstats"]["goal"]


def test_projects_require_the_stage_and_validate_its_setting() -> None:
    cfg = _valid_project_config()
    del cfg["steps"]["zstats"]
    ok, errors, _warnings = validate_project_config(cfg)
    assert not ok
    assert errors == ["Add the missing pipeline steps: zstats."]
    cfg["steps"]["braincharts"] = {"enabled": False, "params": {}}
    cfg["steps"]["zstats"] = {"enabled": True, "params": {"renderReport": "yes"}}
    ok, errors, _warnings = validate_project_config(cfg)
    assert not ok
    assert errors == ["Provide steps.zstats.params.renderReport as a boolean."]


# -- Adapter -------------------------------------------------------------------------------


def test_the_adapter_builds_the_frozen_zscore_argv(tmp_path: Path) -> None:
    out = tmp_path / "out"
    zscores = str(out / "braincharts" / final_r_contract.ZSCORES_FILE)
    assert _ADAPTER.build_command(_cfg(tmp_path), None) == [
        "/usr/bin/Rscript",
        str(_STEP9 / "FreesurferAnalysisScript.R"),
        final_r_contract.TRACK_FLAG,
        final_r_contract.TRACK_ZSCORES,
        "--render-report",
        str(_STEP9 / "FreesurferAnalysisScript.Rmd"),
        zscores,
        str(out / "zstats"),
        "SCI_H,SCI_P,SCI_nNP,SCI",
    ]
    assert _ADAPTER.build_command(_cfg(tmp_path, renderReport=False), None) == [
        "/usr/bin/Rscript",
        str(_STEP9 / "FreesurferAnalysisScript.R"),
        "--track",
        "zscores",
        zscores,
        str(out / "zstats"),
        "SCI_H,SCI_P,SCI_nNP,SCI",
    ]


def test_the_report_knits_from_the_runs_copy_of_the_template(tmp_path: Path) -> None:
    # The rmarkdown package writes beside the template, which an install
    # keeps read-only.
    cfg = _cfg(tmp_path)
    cfg["_supraspinaRuntime"] = {"runDir": str(tmp_path / "run")}
    staging = tmp_path / "run" / "work" / "zstats" / "report-template"
    command = _ADAPTER.build_command(cfg, None)

    assert list(provenance.bound_action(_ADAPTER, cfg, None).argv) == command
    launched = list(_ADAPTER.execution_action(cfg, None).argv)
    assert launched == [*command[:5], str(staging / RMD_TEMPLATE), *command[6:]]

    _ADAPTER.prepare_execution(cfg, None)
    for name in (PLAIN_SCRIPT, RMD_TEMPLATE):
        assert (staging / name).read_bytes() == (_STEP9 / name).read_bytes()


def test_the_adapter_runs_on_the_final_r_interpreter(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    cfg["steps"]["final"] = {"params": {"rscriptExecutable": "/opt/R/bin/Rscript"}}
    assert _ADAPTER.build_command(cfg, None)[0] == "/opt/R/bin/Rscript"
    cfg["tools"] = {"rscriptExecutable": ""}
    cfg["steps"]["final"] = {"params": {}}
    assert _ADAPTER.build_command(cfg, None)[0] == "Rscript"


def test_the_adapter_requires_the_final_r_checks(tmp_path: Path) -> None:
    assert _ADAPTER.required_check_ids(_cfg(tmp_path)) == (
        "finalrscript",
        "final_assets",
        "rmarkdown",
        "knitr",
        "pandoc",
        "final_report_assets",
    )
    assert _ADAPTER.required_check_ids(_cfg(tmp_path, renderReport=False)) == (
        "finalrscript",
        "final_assets",
    )
    assert set(_ADAPTER.param_schema()) == {"renderReport"}


def _env(**statuses: str) -> dict[str, Any]:
    ids = ("finalrscript", "final_assets", *zstats_module.REPORT_CHECKS)
    labels = {"rmarkdown": "R Markdown", "pandoc": "Pandoc", "knitr": "knitr"}
    return {
        "groups": [
            {
                "name": "Tools",
                "checks": [
                    {
                        "id": check_id,
                        "label": labels.get(check_id, check_id),
                        "status": statuses.get(check_id, "found"),
                    }
                    for check_id in ids
                ],
            }
        ]
    }


def test_validate_names_report_tools_that_read_as_skipped(tmp_path: Path) -> None:
    assert _ADAPTER.validate(_cfg(tmp_path), _env()) == Validation()
    validation = _ADAPTER.validate(
        _cfg(tmp_path), _env(rmarkdown="skipped", pandoc="skipped")
    )
    assert validation.blocking == [
        "Install R Markdown and Pandoc for the z-score report, or turn the "
        "z-score report off."
    ]
    missing = _ADAPTER.validate(_cfg(tmp_path), _env(knitr="missing"))
    assert missing.blocking == ["Resolve the knitr check; status: missing."]
    off = _ADAPTER.validate(
        _cfg(tmp_path, renderReport=False), _env(rmarkdown="skipped")
    )
    assert off.blocking == []


def _write_tables(out_dir: Path, extension: str = "csv") -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for block in zstats_module.RESULT_BLOCKS:
        for code in COMPARISON_CODES:
            path = out_dir / f"Z_{block}_{code}_results.{extension}"
            if extension == "csv":
                path.write_text("Region,p_value\nx,0.5\n", encoding="utf-8")
            else:
                path.write_bytes(b"PK\x03\x04xlsx")


def test_detect_reads_the_eight_zscore_tables_and_the_report(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    out_dir = tmp_path / "out" / "zstats"
    assert _ADAPTER.detect(cfg, None).state == "pending"
    _write_tables(out_dir)
    partial = _ADAPTER.detect(cfg, None)
    assert (partial.state, partial.detail) == (
        "partial",
        "Create the missing z-score outputs: report.",
    )
    (out_dir / "report.html").write_text("<html></html>", encoding="utf-8")
    done = _ADAPTER.detect(cfg, None)
    assert done.state == "done"
    assert len(done.artifacts) == 9
    assert done.detail == (
        "All eight thickness and subcortical z-score comparison tables, and the "
        "report, are present."
    )
    assert _ADAPTER.detect(_cfg(tmp_path, renderReport=False), None).detail == (
        "All eight thickness and subcortical z-score comparison tables are present."
    )


def test_detect_refuses_malformed_mixed_and_missing_tables(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path, renderReport=False)
    out_dir = tmp_path / "out" / "zstats"
    _write_tables(out_dir)
    (out_dir / "Z_SUB_IvH_results.csv").write_text("Region\n", encoding="utf-8")
    malformed = _ADAPTER.detect(cfg, None)
    assert (malformed.state, malformed.detail) == (
        "partial",
        "Repair the malformed z-score tables: Z_SUB_IvH.",
    )
    (out_dir / "Z_SUB_IvH_results.csv").unlink()
    missing = _ADAPTER.detect(cfg, None)
    assert missing.detail == "Create the missing z-score outputs: Z_SUB_IvH."
    (out_dir / "Z_SUB_IvH_results.xlsx").write_bytes(b"PK\x03\x04xlsx")
    mixed = _ADAPTER.detect(cfg, None)
    assert (mixed.state, mixed.detail) == (
        "failed",
        "Use one table format for all eight z-score families.",
    )
    (out_dir / "Z_SUB_IvH_results.csv").write_text("a,b\n", encoding="utf-8")
    stale = _ADAPTER.detect(cfg, None)
    assert stale.state == "failed"
    assert stale.detail.startswith("Remove stale output variants for Z_SUB_IvH.")


@pytest.mark.parametrize(
    ("rc", "stderr", "tag", "message"),
    [
        (137, "", "oom_killed", "Reduce R memory use after the process is OOM-killed."),
        (127, "", "rscript_missing", "Add Rscript to PATH."),
        (
            1,
            "Error: Cannot create all eight required R analysis z-score tables. "
            "Z_SCI_PvH: no region has two observations per group\nExecution halted",
            "unestimable_results",
            "Cannot create all eight required R analysis z-score tables. Z_SCI_PvH: "
            "no region has two observations per group",
        ),
        (
            1,
            "Error: Site Ingenia was refused by BrainCharts but has rows in the "
            "z-score CSV.\nExecution halted",
            "refused_site_rows",
            "Error: Site Ingenia was refused by BrainCharts but has rows in the "
            "z-score CSV.",
        ),
        (
            1,
            "Error: Provide BrainCharts z-score CSV; no such file exists at /x.",
            "missing_input",
            "Run BrainCharts normative modeling to publish its z-scores.",
        ),
        (1, "Error: something else", "nonzero_exit", "Error: something else"),
    ],
)
def test_parse_failure_tags_the_zscore_track(
    rc: int, stderr: str, tag: str, message: str
) -> None:
    failure = _ADAPTER.parse_failure(rc, "", stderr)
    assert failure is not None
    assert (failure.code, failure.tag, failure.message) == (rc, tag, message)
    assert _ADAPTER.parse_failure(0, "", "") is None


def test_the_unestimable_text_matches_the_r_script() -> None:
    source = (_STEP9 / "FreesurferAnalysisScript.R").read_text(encoding="utf-8")
    assert f'ZSCORE_FAILURE <- "{zstats_module.UNESTIMABLE_FAILURE}"' in source


def test_results_lists_the_zscore_tables_and_report(tmp_path: Path) -> None:
    rows = results._expected("zstats", _ADAPTER, _cfg(tmp_path), None)
    out_dir = tmp_path / "out" / "zstats"
    assert [(row.label, row.path, row.kind) for row in rows] == [
        *(
            (
                f"Z_{block} {code} results",
                str(out_dir / f"Z_{block}_{code}_results.xlsx"),
                "xlsx",
            )
            for block in ("SCI", "SUB")
            for code in COMPARISON_CODES
        ),
        ("Report", str(out_dir / "report.html"), "html"),
    ]


# -- Receipt bindings ----------------------------------------------------------------------


def _cohort() -> CohortSnapshot:
    return CohortSnapshot(
        analysis_subject_ids=("sub-01",),
        selected_subject_ids=("sub-01",),
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(),
        qc_verdicts=(("sub-01", "pass"),),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def test_the_receipt_binds_the_step9_resources_and_its_schema(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    _signature, payload = provenance.expected_signature(
        "zstats", None, cfg, _cohort(), _ADAPTER, upstream_signatures=["bc"]
    )
    assert payload["outputSchemaIdentity"] == "zstats:eight-zscore-tables-report:v1"
    resources_bound = payload["adapterImplementation"]["scientificResources"]
    assert sorted(resources_bound) == ["analysis", "report"]
    assert resources_bound == provenance._scientific_resources(
        "final", cfg, ADAPTERS["final"]
    )
    # The z-score table arrives through the BrainCharts upstream signature.
    assert payload["externalInputs"] == {}
    assert payload["upstreamSignatures"] == ["bc"]


# -- Planner -------------------------------------------------------------------------------


class _PlanAdapter:
    def __init__(self, key: str, state: str = "pending") -> None:
        self.key = key
        self.state = state

    def validate(self, _cfg: dict[str, Any], _env: dict[str, Any]) -> Validation:
        return Validation()

    def build_command(self, _cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        return [self.key, subject_id or "cohort"]

    def preview(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        return " ".join(self.build_command(cfg, subject_id))

    def detect(self, _cfg: dict[str, Any], _subject_id: str | None) -> StepStatus:
        return StepStatus(state=self.state)  # type: ignore[arg-type]


_ROLES = {
    "healthy": "CTRL",
    "sci-neuropathic-pain": "SCI_P",
    "sci-no-neuropathic-pain": "SCI_nNP",
}


def _rows(controls: int, pain: int, no_pain: int, site: str | None = None) -> list:
    rows = [(f"sub-c{index}", "healthy", site) for index in range(controls)]
    rows += [(f"sub-p{index}", "sci-neuropathic-pain", site) for index in range(pain)]
    rows += [
        (f"sub-n{index}", "sci-no-neuropathic-pain", site) for index in range(no_pain)
    ]
    return rows


def _plan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    rows: list[tuple[str, str, str | None]],
    *,
    braincharts: bool = True,
    braincharts_state: str = "pending",
) -> Any:
    root = tmp_path / "project"
    raw = root / "rawdata"
    for subject_id, role, site in rows:
        path = raw / subject_id / "anat" / f"{subject_id}_T1w.nii.gz"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(subject_id.encode())
        record: dict[str, Any] = {
            "subjectId": subject_id,
            "age": 40,
            "sex": "M",
            "sourceCohortLabel": _ROLES[role],
            "ais": None,
            "tSinceSci": None,
        }
        if site is not None:
            record["site"] = site
        RegistryStore(str(root)).upsert(record)
    monkeypatch.setattr(
        workflow,
        "ADAPTERS",
        {
            "features": _PlanAdapter("features"),
            "braincharts": _PlanAdapter("braincharts", braincharts_state),
            "zstats": _PlanAdapter("zstats"),
        },
    )
    cfg = {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(raw),
            "derivativesDir": str(root / "derivatives"),
            "outputDir": str(root / "output"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "subjects": {"include": [], "exclude": []},
        "runtime": {"dryRun": True},
        "steps": {
            "features": {"enabled": True, "params": {}},
            "braincharts": {"enabled": braincharts, "params": {}},
            "zstats": {"enabled": True, "params": {}},
        },
    }
    return build_plan(
        {
            "project": {
                "projectId": "zstats-plan",
                "root": str(root),
                "configPath": str(root / "supraspina.project.json"),
                "epoch": 1,
            },
            "cfg": cfg,
            "configRevision": 1,
            "intent": {"kind": "workflow", "target": {"mode": "all"}},
            "acknowledgements": {"includeDeferredAndUnreviewedQc": True},
        },
        run_id="run-00000000000c",
    )


def _node(planned: Any, key: str = "zstats") -> dict[str, Any]:
    return next(
        node for node in planned.result["plan"]["nodes"] if node["stepKey"] == key
    )


def test_zstats_waits_for_braincharts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    planned = _plan(tmp_path, monkeypatch, _rows(4, 2, 2))
    node = _node(planned)
    assert node["status"] == "waiting"
    assert node["dependencies"] == [_node(planned, "braincharts")["nodeId"]]
    assert planned.result["plan"]["nodes"][-1] is node


def test_zstats_needs_braincharts_on_or_done(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    planned = _plan(tmp_path, monkeypatch, _rows(4, 2, 2), braincharts=False)
    node = _node(planned)
    assert node["status"] == "blocked"
    assert node["reason"] == (
        "Enable BrainCharts normative modeling; the z-score comparisons read its "
        "z-scores."
    )
    assert {"key": "zstats", "reason": node["reason"], "kind": "config"} in (
        planned.result["plan"]["blockers"]
    )


def test_a_done_braincharts_turned_off_still_feeds_zstats(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    planned = _plan(
        tmp_path,
        monkeypatch,
        _rows(4, 2, 2),
        braincharts=False,
        braincharts_state="done",
    )
    assert _node(planned, "braincharts")["status"] == "skipped"
    assert _node(planned)["status"] == "waiting"


def test_too_few_zscores_in_a_group_block_zstats(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Three controls adapt with 2 and hold out 1, so 1 control gets a z-score.
    planned = _plan(tmp_path, monkeypatch, _rows(3, 2, 2))
    assert _node(planned, "braincharts")["status"] == "waiting"
    node = _node(planned)
    assert node["status"] == "blocked"
    assert node["reason"] == (
        "Add subjects so each group has at least 2 subjects with z-scores "
        "(z-score counts: control=1, SCI_P=2, SCI_nNP=2); adaptation controls and "
        "refused sites get no z-scores. Then review the plan again."
    )
    blocker = next(
        item for item in planned.result["plan"]["blockers"] if item["key"] == "zstats"
    )
    assert blocker["kind"] == "cohort"
    assert blocker["subjects"] == ["sub-c0", "sub-c1", "sub-c2"]


def test_a_refused_site_contributes_no_zscores(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rows = [
        *_rows(4, 1, 2, "Prisma"),
        ("sub-i1", "sci-neuropathic-pain", "Ingenia"),
        ("sub-i2", "sci-neuropathic-pain", "Ingenia"),
    ]
    node = _node(_plan(tmp_path, monkeypatch, rows))
    assert node["status"] == "blocked"
    assert "(z-score counts: control=2, SCI_P=1, SCI_nNP=2)" in node["reason"]


def test_a_blocked_braincharts_explains_the_zstats_block(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    planned = _plan(tmp_path, monkeypatch, _rows(1, 2, 2))
    assert _node(planned, "braincharts")["status"] == "blocked"
    assert _node(planned)["reason"] == (
        "Wait for BrainCharts normative modeling, which is blocked: No site has at "
        "least 2 controls, so the model cannot be adapted."
    )


def test_mixed_sites_block_zstats(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rows = [*_rows(4, 2, 2, "Prisma"), ("sub-x", "healthy", None)]
    planned = _plan(tmp_path, monkeypatch, rows, braincharts=False)
    assert _node(planned)["reason"] == (
        "Set a site for sub-x; some subjects have a site and this subject does not."
    )


@pytest.mark.parametrize("controls", range(13))
def test_held_out_controls_follow_the_braincharts_split(controls: int) -> None:
    expected = 0 if controls < 2 else controls - bc.adaptation_count(controls)
    assert workflow._braincharts_held_out_controls(controls) == expected


# Six Prisma controls (3 adapt, 3 held out), three SCI of each kind, and an
# Ingenia site with SCI only, which BrainCharts refuses.
_PUBLISHED_ROWS = [
    *(
        (f"sub-c{index}", str(30 + index), "FM"[index % 2], "Prisma", "control")
        for index in range(6)
    ),
    *(
        (f"sub-p{index}", str(40 + index), "FM"[index % 2], "Prisma", "SCI_P")
        for index in range(3)
    ),
    *(
        (f"sub-n{index}", str(50 + index), "FM"[index % 2], "Prisma", "SCI_nNP")
        for index in range(3)
    ),
    ("sub-i1", "44", "F", "Ingenia", "SCI_P"),
    ("sub-i2", "45", "M", "Ingenia", "SCI_nNP"),
]


def test_the_stage_runs_on_a_published_braincharts_generation(tmp_path: Path) -> None:
    rscript = _require_rscript()
    model = _write_lists(tmp_path / "model")
    metadata, features = _write_inputs(tmp_path, _PUBLISHED_ROWS)
    args = _args(tmp_path, model, metadata, features)
    assert bc.run(bc.parse_args(args), _FakePcntoolkit().runtime()) == 0
    braincharts_out = tmp_path / "out" / "braincharts"
    with open(
        braincharts_out / final_r_contract.REFUSED_SITES_FILE,
        newline="",
        encoding="utf-8",
    ) as handle:
        assert [row["site"] for row in csv.DictReader(handle)] == ["Ingenia"]

    cfg = _cfg(tmp_path, renderReport=False)
    cfg["tools"] = {"rscriptExecutable": rscript}
    argv = _ADAPTER.build_command(cfg, None)
    assert argv[4] == str(braincharts_out / final_r_contract.ZSCORES_FILE)
    completed = subprocess.run(  # noqa: S603 - Execute the adapter's fixed argv.
        argv, check=False, capture_output=True, text=True
    )
    assert completed.returncode == 0, completed.stderr
    status = _ADAPTER.detect(cfg, None)
    assert status.state == "done", status.detail
    tables = {
        path.stem: _read_result_table(path)
        for path in _result_tables(tmp_path / "out" / "zstats")
    }
    assert len(tables) == 8
    row = tables["Z_SUB_IvH_results"][0]
    # Held-out controls against every Prisma SCI subject; Ingenia has no rows.
    assert (row["Group_ref"], row["N_ref"], row["Group_foc"], row["N_foc"]) == (
        "SCI_H",
        3,
        "SCI",
        6,
    )
    assert row["Direction"] == "SCI_H minus SCI"

    report = _zscore_report(
        rscript, tmp_path, braincharts_out / final_r_contract.ZSCORES_FILE
    )
    assert (
        "Z-scores are adapted per site, so the comparisons pool sites: Prisma "
        "(9 subjects). Site Ingenia was refused by BrainCharts and has no rows."
    ) in report
