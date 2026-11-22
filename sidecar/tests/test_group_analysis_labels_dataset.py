"""Tests for labeled atlases in measure resolution, catalog, and currency."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from supraspina_sidecar.group_analysis import (
    atlas_cache,
    atlas_recipes,
    dataset,
    engine_input,
    manager,
    sources,
)
from supraspina_sidecar.group_analysis.dataset import Tables
from tests.group_analysis_recon_support import medulla, write_recon
from tests.group_analysis_support import IMAGED, make_project
from tests.test_group_analysis_dataset_v2 import (
    COHORT,
    SCI_CTRL,
    _compute,
    _context,
    _factor,
    _test,
    spec_v2,
)

_TESTS = [_test("two", "two-group", factor=_factor(COHORT, SCI_CTRL, "SCI", "CTRL"))]


def _label(
    root: Path, atlas_id: str, subject_id: str, values: dict[str, float]
) -> None:
    recipe = atlas_id if atlas_id in atlas_recipes.RECIPES else "user-annot"
    atlas_cache.store_subject(
        str(root),
        atlas_id,
        subject_id,
        files={},
        manifest={
            "schema": atlas_recipes.LABELS_SCHEMA,
            "schemaVersion": 1,
            "atlasId": atlas_id,
            "subjectId": subject_id,
            "recipeId": recipe,
            "recipeVersion": 1,
            "provenance": "labeled",
            "inputs": [],
            "reconState": "current",
            "values": values,
        },
    )


def _yeo(index: int) -> dict[str, float]:
    return {
        "parc:yeo7:lh:7Networks_1:ThickAvg": 2.0 + 0.01 * index,
        "parc:yeo7:rh:7Networks_1:ThickAvg": 2.2 + 0.01 * index,
    }


def test_labeled_atlases_resolve_from_the_cache(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    measures = ["parc:yeo7:bi:7Networks_1:ThickAvg", "aseg:Brain-Stem"]
    spec = spec_v2(_TESTS, measures=measures)
    data = engine_input.load_engine_data(_context(tmp_path, cfg), spec)
    assert data.skipped == [
        {
            "measureId": "parc:yeo7:bi:7Networks_1:ThickAvg",
            "reason": "No subject has labels of the yeo7 atlas yet.",
        }
    ]
    for index, (subject_id, *_rest) in enumerate(IMAGED):
        _label(tmp_path, "yeo7", subject_id, _yeo(index))
    data = engine_input.load_engine_data(_context(tmp_path, cfg), spec)
    ids = data.subject_ids
    values = data.measures["parc:yeo7:bi:7Networks_1:ThickAvg"]
    assert values[ids.index("sub-03")] == (2.02 + 2.22) / 2
    assert "labels:yeo7" in data.state["usedSources"]
    row = next(row for row in data.inputs if row["source"] == "labels:yeo7")
    assert row["present"] is True
    assert row["sha256"] == sources.labels_input(str(tmp_path), "yeo7", ids)["sha256"]


def test_subregions_fall_back_to_labels_when_a_recon_has_none(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    for index, (subject_id, *_rest) in enumerate(IMAGED):
        with_files = subject_id not in {"sub-02", "sub-07"}
        write_recon(tmp_path / "derivatives", subject_id, index, subregions=with_files)
        if not with_files:
            _label(
                tmp_path,
                "brainstem-ss",
                subject_id,
                {"vol:brainstem-ss:mid:Medulla": 9000.0 + index},
            )
    # A label of a subject whose recon has the file is never read.
    _label(tmp_path, "brainstem-ss", "sub-01", {"vol:brainstem-ss:mid:Medulla": 1.0})
    spec = spec_v2(_TESTS, measures=["vol:brainstem-ss:mid:Medulla"])
    data = engine_input.load_engine_data(_context(tmp_path, cfg), spec)
    ids = data.subject_ids
    values = data.measures["vol:brainstem-ss:mid:Medulla"]
    assert values[ids.index("sub-02")] == 9001.0
    assert values[ids.index("sub-07")] == 9006.0
    assert values[ids.index("sub-01")] == medulla(0)
    used = data.state["usedSources"]
    assert "stats:found-subregions" in used
    assert "labels:brainstem-ss" in used


def test_a_result_is_stale_when_its_labels_change(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    for index, (subject_id, *_rest) in enumerate(IMAGED):
        _label(tmp_path, "yeo7", subject_id, _yeo(index))
    spec = spec_v2(
        _TESTS, measures=["parc:yeo7:lh:7Networks_1:ThickAvg", "aseg:Brain-Stem"]
    )
    record = _compute(tmp_path, cfg, spec)
    context = _context(tmp_path, cfg)
    assert manager.judge_currency(record, context) == ("current", [])
    records = [record]
    before = manager._fingerprint(context, records)
    _label(tmp_path, "yeo7", "sub-04", {"parc:yeo7:lh:7Networks_1:ThickAvg": 9.0})
    assert manager._fingerprint(context, records) != before
    currency, reasons = manager.judge_currency(record, context)
    assert currency == "stale"
    assert reasons == [
        {"code": "labels-changed", "added": 0, "removed": 0, "sources": ["labels:yeo7"]}
    ]


def test_the_catalog_lists_labeled_measures_once(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    write_recon(tmp_path / "derivatives", "sub-01", 0)
    _label(tmp_path, "yeo7", "sub-02", _yeo(1))
    _label(
        tmp_path,
        "brainstem-ss",
        "sub-02",
        {"vol:brainstem-ss:mid:Medulla": 1.0, "vol:brainstem-ss:mid:SCP": 2.0},
    )
    _label(tmp_path, "yeo17", "sub-99", {"parc:yeo17:lh:17Networks_1:ThickAvg": 1.0})
    (Path(atlas_cache.template_dir(str(tmp_path)))).mkdir(parents=True)
    context = _context(tmp_path, cfg)
    entries = sources.catalog_measures(context, Tables(context))
    labeled = {e["measureId"]: e for e in entries if e["stage"] == "labeling"}
    assert set(labeled) == {
        "parc:yeo7:lh:7Networks_1:ThickAvg",
        "parc:yeo7:rh:7Networks_1:ThickAvg",
        "parc:yeo7:bi:7Networks_1:ThickAvg",
        "vol:brainstem-ss:mid:SCP",
    }
    assert labeled["vol:brainstem-ss:mid:SCP"]["family"] == "vol:brainstem-ss"
    recon = [e["measureId"] for e in entries if e["stage"] == "recon"]
    assert recon.count("vol:brainstem-ss:mid:Medulla") == 1
    assert sources.labels_atlas("parc:a2009s:lh:S_central:ThickAvg") is None
    assert sources.labels_atlas("aseg:Brain-Stem") is None
    assert sources.labels_atlas("vol:thalamic:lh:AV") == "thalamic"
    assert (
        sources.label_value(
            sources.LabelReader(str(tmp_path)), "aseg:Brain-Stem", "sub-02"
        )
        is None
    )
    assert dataset.measure_source("aseg:Brain-Stem")


def test_label_inputs_report_absence(tmp_path: Path) -> None:
    row: dict[str, Any] = sources.labels_input(str(tmp_path), "yeo7", ["sub-01"])
    assert row["present"] is False
    assert row["reason"] == "No included subject has labels of the yeo7 atlas."
    reader = sources.LabelReader(str(tmp_path))
    assert reader.values("yeo7", "../x") == {}
    assert reader.any("yeo7") is False
