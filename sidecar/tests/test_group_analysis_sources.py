"""Tests for the tier A sources and the imported variables tables."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.group_analysis import catalog, sources, store
from supraspina_sidecar.group_analysis.dataset import AnalysisContext
from supraspina_sidecar.group_analysis.spec import GroupAnalysisError
from supraspina_sidecar.registry_store import RegistryStore
from tests.group_analysis_recon_support import (
    medulla,
    stiv,
    synthseg_tiv,
    thickness,
    write_recon,
)
from tests.group_analysis_support import IMAGED, make_project


def _context(root: Path, cfg: dict[str, Any]) -> AnalysisContext:
    return AnalysisContext(
        project_root=str(root),
        cfg=cfg,
        config_revision=1,
        registry=tuple(RegistryStore(str(root)).list()),
    )


def _recon_project(root: Path, *, skip: tuple[str, ...] = ()) -> dict[str, Any]:
    cfg = make_project(root)
    for index, (subject_id, *_rest) in enumerate(IMAGED):
        if subject_id not in skip:
            write_recon(root / "derivatives", subject_id, index)
    return cfg


def test_tier_a_values_follow_the_measure_grammar(tmp_path: Path) -> None:
    cfg = _recon_project(tmp_path)
    reader = sources.ReconReader(_context(tmp_path, cfg))

    def value(measure_id: str, subject: str = "sub-03") -> float | None:
        return sources.measure_value(reader, measure_id, subject)

    lh = thickness(2, "lh", "S_central")
    rh = thickness(2, "rh", "S_central")
    assert value("parc:a2009s:lh:S_central:ThickAvg") == lh
    assert value("parc:a2009s:bi:S_central:ThickAvg") == pytest.approx((lh + rh) / 2)
    assert value("parc:gwc:rh:precentral:GWC") == 23.0
    assert value("vol:wmparc:lh:wm-precentral") == 5002.0
    assert value("vol:wmparc:mid:UnsegmentedWhiteMatter") is None
    assert value("vol:wmparc:lh:UnsegmentedWhiteMatter") == 9002.0
    assert value("vol:synthseg:bi:thalamus") == pytest.approx(7052.0)
    assert value("vol:synthseg:mid:brain-stem") == 21002.0
    assert value("vol:brainstem-ss:mid:Medulla") == medulla(2)
    assert value("vol:hippo-amygdala:bi:CA1-body") == 602.0
    assert value("vol:thalamic:rh:AV") == 162.0
    assert value("global:sTIV") == stiv(2)
    assert value("global:synthsegTIV") == synthseg_tiv(2)
    assert value("global:CortexVol") == 400_002.0
    assert value("global:SurfaceHoles") == 22.0
    # A missing file, subject, or label is a missing value.
    assert value("vol:brainstem-ss:mid:Medulla", "sub-11") is None
    assert value("parc:a2009s:lh:unknown:ThickAvg") is None
    assert sources.measure_source_id("global:eTIV") is None
    assert sources.measure_source_id("parc:yeo7:lh:Net1:ThickAvg") is None


def test_the_recon_backend_chooses_the_folder(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    write_recon(tmp_path / "derivatives", "sub-01", 0, backend="fastsurfer")
    context = _context(tmp_path, cfg)
    reader = sources.ReconReader(context)
    assert reader.subject_dir("sub-01") is None
    for backend in ("fastsurfer", "auto"):
        cfg["steps"]["recon"] = {"params": {"backend": backend}}
        reader = sources.ReconReader(_context(tmp_path, cfg))
        assert sources.measure_value(reader, "global:sTIV", "sub-01") == stiv(0)
    cfg["paths"]["derivativesDir"] = ""
    assert not sources.ReconReader(_context(tmp_path, cfg)).configured


def test_availability_counts_files_and_names_regions(tmp_path: Path) -> None:
    cfg = _recon_project(tmp_path, skip=("sub-09", "sub-10"))
    context = _context(tmp_path, cfg)

    found = sources.source_availability(context, "a2009s")
    assert found == {
        "total": 11,
        "withFiles": 8,
        "regions": ["G_precentral", "S_central"],
    }
    assert sources.source_availability(context, "found-subregions")["regions"] == [
        "AV",
        "CA1-body",
        "Medulla",
        "Pons",
        "Whole_brainstem",
        "Whole_hippocampus",
        "Whole_thalamus",
    ]
    with pytest.raises(GroupAnalysisError, match="tier A source"):
        sources.source_availability(context, "dk")


def test_the_catalog_lists_tier_a_measures_by_stage(tmp_path: Path) -> None:
    cfg = _recon_project(tmp_path)
    measures = {
        row["measureId"]: row
        for row in catalog.build_catalog(_context(tmp_path, cfg))["measures"]
    }
    for measure_id in (
        "parc:a2009s:lh:S_central:ThickAvg",
        "parc:a2009s:bi:S_central:GrayVol",
        "parc:gwc:bi:precentral:GWC",
        "vol:wmparc:bi:wm-precentral",
        "vol:brainstem-ss:mid:Medulla",
        "vol:thalamic:bi:AV",
        "vol:thalamic:lh:Whole_thalamus",
        "global:sTIV",
        "global:synthsegTIV",
    ):
        assert measures[measure_id]["stage"] == "recon", measure_id
        assert measures[measure_id]["available"] is True
    assert measures["parc:a2009s:bi:S_central:GrayVol"]["family"] == (
        "parc:a2009s:GrayVol"
    )
    assert measures["vol:brainstem-ss:mid:Medulla"]["extensive"] is True
    assert "parc:a2009s:lh:unknown:ThickAvg" not in measures
    # The v1 pipeline measures keep their stage.
    assert measures["global:eTIV"]["stage"] == "aggregate"


def test_a_project_without_recons_lists_only_the_fixed_globals(
    tmp_path: Path,
) -> None:
    cfg = make_project(tmp_path)
    recon = [
        row
        for row in catalog.build_catalog(_context(tmp_path, cfg))["measures"]
        if row["stage"] == "recon"
    ]
    assert [row["measureId"] for row in recon] == [
        f"global:{name}" for name in sources.ASEG_GLOBALS
    ]
    assert {row["unavailableReason"] for row in recon} == {
        "No subject's reconstruction has stats/aseg.stats."
    }


def test_the_combined_digest_follows_every_file(tmp_path: Path) -> None:
    cfg = _recon_project(tmp_path)
    context = _context(tmp_path, cfg)
    subjects = ["sub-01", "sub-02"]
    before = sources.source_digest(context, "found-subregions", subjects)
    assert before == sources.source_digest(context, "found-subregions", subjects[::-1])
    path = (
        tmp_path
        / "derivatives"
        / "freesurfer"
        / "sub-02"
        / "mri"
        / "brainstemSsLabels.v13.volumes.txt"
    )
    path.write_text("Medulla 1\n", encoding="utf-8")
    changed = sources.source_digest(context, "found-subregions", subjects)
    assert changed != before
    path.unlink()
    assert sources.source_digest(context, "found-subregions", subjects) not in {
        before,
        changed,
    }
    row = sources.combined_digest(sources.ReconReader(context), "a2009s", ["sub-11"])
    assert row["present"] is False
    assert row["reason"] == (
        "No included subject's reconstruction has stats/lh.aparc.a2009s.stats."
    )


def test_a_symlinked_stats_file_is_not_read(tmp_path: Path) -> None:
    cfg = _recon_project(tmp_path)
    stats = tmp_path / "derivatives" / "freesurfer" / "sub-01" / "stats"
    real = tmp_path / "elsewhere.stats"
    (stats / "aseg.stats").rename(real)
    os.symlink(real, stats / "aseg.stats")
    reader = sources.ReconReader(_context(tmp_path, cfg))
    assert sources.measure_value(reader, "global:sTIV", "sub-01") is None
    assert reader.read("sub-01", "stats/aseg.stats").reason is not None


# -- Imported variables -------------------------------------------------------------


def _csv(tmp_path: Path, text: str, name: str = "sci-variables.csv") -> str:
    path = tmp_path / "incoming" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return str(path)


VARIABLES = (
    "Participant_ID,injury_level_group,uems,lems\n"
    "sub-06,cervical,40,45\n"
    "sub-07,thoracic_lumbar,50,2\n"
    "sub-08,cervical,,30\n"
    "sub-99,cervical,1,1\n"
)


def test_an_imported_table_is_copied_listed_and_described(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    context = _context(tmp_path, cfg)
    table = sources.import_variables(context, _csv(tmp_path, VARIABLES))

    table_id = table["tableId"]
    assert sources.TABLE_ID.fullmatch(table_id)
    assert table["name"] == "sci-variables.csv"
    assert table["idColumn"] == "Participant_ID"
    assert (table["rows"], table["unmatched"]) == (4, 1)
    columns = {column["column"]: column for column in table["columns"]}
    assert columns["uems"] == {
        "column": "uems",
        "kind": "numeric",
        "n": 2,
        "levels": [],
    }
    assert columns["injury_level_group"]["levels"] == [
        {"value": "cervical", "n": 2},
        {"value": "thoracic_lumbar", "n": 1},
    ]
    copy = tmp_path / sources.VARIABLES_DIR / f"{table_id}.csv"
    assert copy.read_text(encoding="utf-8") == VARIABLES
    listing = json.loads(
        (tmp_path / sources.VARIABLES_DIR / "tables.json").read_text(encoding="utf-8")
    )
    assert listing["schema"] == sources.TABLES_SCHEMA
    assert [item["tableId"] for item in listing["tables"]] == [table_id]
    # The same bytes again return the listed table; the listing is unchanged.
    again = sources.import_variables(context, _csv(tmp_path, VARIABLES, "copy.csv"))
    assert again["tableId"] == table_id
    assert again["name"] == "sci-variables.csv"
    assert [
        row["tableId"]
        for row in sources.list_variable_tables(
            str(tmp_path), sources.project_subjects(context)
        )
    ] == [table_id]
    # Nothing outside the analysis folder was written.
    assert not (tmp_path / ".supraspina" / "analysis" / "results").exists()


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("name,uems\nsub-01,1\n", "subject ID column"),
        ("subject,uems\nsub-01,1\nsub-01,2\n", "1 subject ID appears more"),
        ("subject,uems,uems\nsub-01,1,2\n", "different name"),
        ("subject,uems\n", "Add subject rows"),
        ("", "header row"),
    ],
)
def test_an_unusable_table_is_refused(tmp_path: Path, text: str, message: str) -> None:
    cfg = make_project(tmp_path)
    with pytest.raises(GroupAnalysisError, match=message):
        sources.import_variables(_context(tmp_path, cfg), _csv(tmp_path, text))
    assert not (tmp_path / sources.VARIABLES_DIR).exists()


def test_imports_refuse_links_and_stop_at_the_table_cap(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    context = _context(tmp_path, cfg)
    path = _csv(tmp_path, VARIABLES)
    link = tmp_path / "link.csv"
    os.symlink(path, link)
    with pytest.raises(GroupAnalysisError, match="not a link"):
        sources.import_variables(context, str(link))
    for index in range(sources.MAX_VARIABLE_TABLES):
        sources.import_variables(
            context, _csv(tmp_path, f"subject,v\nsub-01,{index}\n", f"t{index}.csv")
        )
    with pytest.raises(GroupAnalysisError, match="at most 16"):
        sources.import_variables(context, path)


def test_a_changed_copy_is_refused_and_a_table_can_be_deleted(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    context = _context(tmp_path, cfg)
    table_id = sources.import_variables(context, _csv(tmp_path, VARIABLES))["tableId"]
    copy = tmp_path / sources.VARIABLES_DIR / f"{table_id}.csv"
    copy.write_text(VARIABLES + "sub-01,cervical,1,1\n", encoding="utf-8")
    with pytest.raises(GroupAnalysisError, match="changed"):
        sources.read_variable_table(str(tmp_path), table_id)
    assert sources.list_variable_tables(str(tmp_path)) == []
    sources.delete_variables(str(tmp_path), table_id)
    assert not copy.exists()
    with pytest.raises(GroupAnalysisError, match="Select an imported"):
        sources.delete_variables(str(tmp_path), table_id)
    with pytest.raises(GroupAnalysisError, match="no longer lists"):
        sources.read_variable_table(str(tmp_path), table_id)
    # The store's own listing survives an unreadable variables listing.
    assert store.load_library(str(tmp_path))["specs"] == []
