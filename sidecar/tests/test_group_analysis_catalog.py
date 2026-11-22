"""Tests for the measure and variable catalog."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from supraspina_sidecar.group_analysis import catalog, dataset
from supraspina_sidecar.registry_store import RegistryStore
from tests.group_analysis_support import make_project

_OUT = Path("outputs") / "run"


def _context(root: Path, cfg: dict[str, Any]) -> dataset.AnalysisContext:
    return dataset.AnalysisContext(
        project_root=str(root),
        cfg=cfg,
        config_revision=7,
        registry=tuple(RegistryStore(str(root)).list()),
    )


def _measures(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {row["measureId"]: row for row in payload["measures"]}


def test_measures_come_from_the_table_headers(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)

    payload = catalog.build_catalog(_context(tmp_path, cfg))

    assert payload["configRevision"] == 7
    measures = {
        key: row for key, row in _measures(payload).items() if row["stage"] != "recon"
    }
    assert list(measures) == [
        "dk:lh:precentral:ThickAvg",
        "dk:rh:precentral:ThickAvg",
        "dk:bi:precentral:ThickAvg",
        "dk:lh:precentral:SurfArea",
        "dk:rh:precentral:SurfArea",
        "dk:bi:precentral:SurfArea",
        "aseg:Brain-Stem",
        "aseg:Left-Thalamus",
        "aseg:Right-Thalamus",
        "aseg:5th-Ventricle",
        "aseg:bi:Thalamus",
        "global:eTIV",
        "global:meanThickness",
        "brainage:BrainPAD",
    ]
    assert all(row["available"] for row in measures.values())
    assert measures["dk:bi:precentral:SurfArea"] == {
        "measureId": "dk:bi:precentral:SurfArea",
        "source": "dk",
        "family": "dk:SurfArea",
        "extensive": True,
        "stage": "aggregate",
        "available": True,
        "unavailableReason": None,
    }
    assert measures["dk:lh:precentral:ThickAvg"]["extensive"] is False
    assert measures["aseg:bi:Thalamus"]["family"] == "aseg"
    assert measures["global:meanThickness"]["extensive"] is False
    assert measures["brainage:BrainPAD"]["stage"] == "pybrainage"
    assert [row["source"] for row in payload["inputs"]] == list(dataset.INPUT_SOURCES)


def test_a_missing_table_lists_its_family_as_unavailable(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    (tmp_path / _OUT / "structural" / "dk_all_stats.csv").unlink()
    (tmp_path / _OUT / "pybrainage" / "predicted_results.csv").unlink()
    (tmp_path / _OUT / "structural" / "cortical_thickness.csv").write_text(
        "subject,lh_mean_thickness\nsub-01,2.5\n", encoding="utf-8"
    )

    measures = _measures(catalog.build_catalog(_context(tmp_path, cfg)))

    dk = [row for row in measures.values() if row["source"] == "dk"]
    assert len(dk) == len(dataset.DK_REGIONS) * 9 * 3
    assert {row["unavailableReason"] for row in dk} == {
        "The aggregation stage has not written dk_all_stats.csv."
    }
    assert "aseg:bi:Cerebellum-Cortex" in measures
    assert not measures["aseg:Brain-Stem"]["available"]
    assert measures["brainage:BrainPAD"]["unavailableReason"] == (
        "The Brain-PAD stage has not written predicted_results.csv."
    )
    assert measures["global:meanThickness"]["unavailableReason"] == (
        "The table has no rh_mean_thickness column."
    )
    assert measures["global:eTIV"]["available"] is True
    assert len(measures) <= 2000


def test_an_unreadable_table_names_its_problem(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    (tmp_path / _OUT / "structural" / "icv_data.csv").write_text(
        "subject,eTIV\nsub-01,1\nsub-01,2\n", encoding="utf-8"
    )

    measures = _measures(catalog.build_catalog(_context(tmp_path, cfg)))

    assert measures["global:eTIV"]["unavailableReason"] == (
        "The table cannot be read: 1 participant ID appears more than once in "
        "icv_data.csv."
    )


def test_variables_come_from_the_registry_and_the_metadata_csvs(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    with (tmp_path / "metadata" / "metadata.csv").open("w", encoding="utf-8") as handle:
        handle.write("participant_id,Cohort,Site,Note\n")
        for number in range(1, 12):
            handle.write(f"sub-{number:02d},CTRL,Site A,note {number}\n")
        handle.write("sub-12,CTRL,Café,\n")

    variables = {
        (row["ref"]["source"], row["ref"]["column"]): row
        for row in catalog.build_catalog(_context(tmp_path, cfg))["variables"]
    }

    assert variables[("registry", "age")] == {
        "ref": {"source": "registry", "column": "age"},
        "kind": "numeric",
        "n": 11,
        "levels": [],
    }
    assert variables[("registry", "sourceCohortLabel")]["levels"] == [
        {"value": "CTRL", "n": 6},
        {"value": "SCI_P", "n": 3},
        {"value": "SCI_nNP", "n": 2},
    ]
    assert variables[("registry", "ais")]["n"] == 5
    assert variables[("age-csv", "age")]["kind"] == "numeric"
    assert variables[("clinical-csv", "Time since SCI (years)")]["kind"] == "numeric"
    assert variables[("clinical-csv", "Sex")]["levels"] == [
        {"value": "Female", "n": 5},
        {"value": "Male", "n": 6},
    ]
    assert ("metadata-csv", "participant_id") not in variables
    # The non-ASCII level cannot be named in a specification, so it is not offered.
    assert variables[("metadata-csv", "Site")]["levels"] == [
        {"value": "Site A", "n": 11}
    ]
    assert variables[("metadata-csv", "Site")]["n"] == 12
    assert len(variables[("metadata-csv", "Note")]["levels"]) == 11


def test_a_high_cardinality_text_column_is_not_offered(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    with (tmp_path / "metadata" / "metadata.csv").open("w", encoding="utf-8") as handle:
        handle.write("participant_id,Free\n")
        for number in range(300):
            handle.write(f"sub-{number:03d},text {number}\n")

    variables = catalog.build_catalog(_context(tmp_path, cfg))["variables"]

    assert all(row["ref"]["source"] != "metadata-csv" for row in variables)


def test_a_mostly_numeric_column_stays_a_numeric_covariate(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    age = tmp_path / "metadata" / "age.csv"
    age.write_text(
        age.read_text(encoding="utf-8").replace("sub-04,45", "sub-04,unknown"),
        encoding="utf-8",
    )

    variables = {
        (row["ref"]["source"], row["ref"]["column"]): row
        for row in catalog.build_catalog(_context(tmp_path, cfg))["variables"]
    }

    # One stray cell leaves that subject missing; the column is still
    # the numeric age covariate, not a grouping variable.
    assert variables[("age-csv", "age")] == {
        "ref": {"source": "age-csv", "column": "age"},
        "kind": "numeric",
        "n": 10,
        "levels": [],
    }
