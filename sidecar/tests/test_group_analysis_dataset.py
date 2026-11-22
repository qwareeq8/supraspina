"""Tests for sample resolution and the aligned analysis dataset."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.cohort import load_project_qc_records
from supraspina_sidecar.group_analysis import dataset
from supraspina_sidecar.group_analysis.spec import GroupAnalysisError, parse_spec
from supraspina_sidecar.registry_store import RegistryStore
from tests.group_analysis_support import example_spec, make_project, write_qc

_STRUCTURAL = Path("outputs") / "run" / "structural"


def _context(
    root: Path,
    cfg: dict[str, Any],
    *,
    registration: tuple[dict[str, Any], ...] = (),
    known: bool = True,
) -> dataset.AnalysisContext:
    return dataset.AnalysisContext(
        project_root=str(root),
        cfg=cfg,
        config_revision=1,
        registry=tuple(RegistryStore(str(root)).list()),
        qc=load_project_qc_records(str(root)),
        registration=registration,
        registration_known=known,
    )


def _reasons(payload: dict[str, Any]) -> dict[str, str | None]:
    return {row["subjectId"]: row["reason"] for row in payload["subjects"]}


def _hemisphere(
    hemi: str, *, state: str = "checked", flagged: bool = False
) -> dict[str, Any]:
    return {"hemisphere": hemi, "state": state, "flagged": flagged}


def _registration(**flags: str) -> tuple[dict[str, Any], ...]:
    """Build status rows: every imaged subject checked, the named ones flagged."""
    rows = []
    for number in range(1, 11):
        subject_id = f"sub-{number:02d}"
        flagged = flags.get(subject_id.replace("-", "_"), "")
        rows.append(
            {
                "subjectId": subject_id,
                "flagged": bool(flagged),
                "hemispheres": [
                    _hemisphere(
                        hemi,
                        state="pending" if flagged == "pending" else "checked",
                        flagged=hemi in flagged.split(","),
                    )
                    for hemi in ("lh", "rh")
                ],
            }
        )
    return tuple(rows)


def test_inputs_are_located_hashed_and_described(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    (tmp_path / "metadata" / "metadata.csv").unlink()
    cfg["paths"]["ageMetadataFile"] = ""

    rows = {row["source"]: row for row in dataset.input_files(_context(tmp_path, cfg))}

    assert list(rows) == list(dataset.INPUT_SOURCES)
    dk = tmp_path / _STRUCTURAL / "dk_all_stats.csv"
    assert rows["dk-all-stats"] == {
        "source": "dk-all-stats",
        "present": True,
        "reason": None,
        "sha256": hashlib.sha256(dk.read_bytes()).hexdigest(),
        "bytes": dk.stat().st_size,
    }
    assert rows["metadata-csv"]["present"] is False
    assert rows["metadata-csv"]["reason"] == "The metadata folder has no metadata.csv."
    assert (
        rows["age-csv"]["reason"] == "The age CSV is not set in the project settings."
    )
    assert rows["outliers"]["present"] is True


def test_the_aggregation_folder_follows_the_configured_out_dir(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    moved = tmp_path / "elsewhere"
    (tmp_path / _STRUCTURAL).rename(moved)
    cfg["steps"]["aggregate"]["params"]["outDir"] = str(moved)

    context = _context(tmp_path, cfg)
    assert dataset.input_path(context, "icv") == str(moved / "icv_data.csv")
    assert dataset.read_table(context, "icv").usable


@pytest.mark.parametrize(
    ("content", "reason"),
    [
        (
            b"subject,eTIV\nsub-01,1\nsub-01,2\n",
            "1 participant ID appears more than once in icv_data.csv.",
        ),
        (
            b"subject,eTIV\nsub-01,1\nsub-02,2\nsub-01,3\nsub-02,4\nsub-02,5\n",
            "2 participant IDs appear more than once in icv_data.csv.",
        ),
        (b"id,eTIV\nsub-01,1\n", "The table has no subject column."),
        (b"subject,eTIV\n\xff\xfe\n", "The file is not UTF-8 text."),
        (b"", "The file has no header row."),
        (b"subject,eTIV,eTIV\nsub-01,1,2\n", "The table repeats a column name."),
    ],
)
def test_an_unusable_table_is_present_with_a_reason(
    tmp_path: Path, content: bytes, reason: str
) -> None:
    cfg = make_project(tmp_path)
    (tmp_path / _STRUCTURAL / "icv_data.csv").write_bytes(content)

    table = dataset.read_table(_context(tmp_path, cfg), "icv", cache=False)

    assert table.present is True
    assert table.reason == reason
    assert table.usable is False


def test_a_repeated_participant_is_counted_never_named(tmp_path: Path) -> None:
    # Input reasons reach spec.json and exports; participant IDs must not.
    cfg = make_project(tmp_path)
    clinical = tmp_path / "metadata" / "clinical.csv"
    rows = clinical.read_text(encoding="utf-8").splitlines()
    clinical.write_text("\n".join([*rows, rows[1], rows[1]]) + "\n", encoding="utf-8")
    repeated = rows[1].split(",")[0]

    inputs = dataset.input_files(_context(tmp_path, cfg))

    row = next(item for item in inputs if item["source"] == "clinical-csv")
    assert (
        row["reason"] == "1 participant ID appears more than once in the clinical CSV."
    )
    assert repeated not in json.dumps(inputs)


def test_a_symlinked_table_is_refused(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    icv = tmp_path / _STRUCTURAL / "icv_data.csv"
    target = tmp_path / "real.csv"
    icv.rename(target)
    os.symlink(target, icv)

    table = dataset.read_table(_context(tmp_path, cfg), "icv")

    assert table.present is True
    assert table.sha256 is None
    assert "regular file" in str(table.reason)


def test_the_parse_cache_follows_file_changes(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    context = _context(tmp_path, cfg)
    first = dataset.read_table(context, "icv")
    assert dataset.read_table(context, "icv") is first

    path = tmp_path / _STRUCTURAL / "icv_data.csv"
    path.write_text("subject,eTIV\nsub-01,5\n", encoding="utf-8")

    second = dataset.read_table(context, "icv")
    assert second.sha256 != first.sha256
    assert list(second.rows) == ["sub-01"]


def test_the_default_sample_matches_the_registry_groups(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    spec = parse_spec(example_spec())

    payload = dataset.resolve_inputs(_context(tmp_path, cfg), spec)

    assert payload["groups"] == [{"label": "SCI", "n": 5}, {"label": "CTRL", "n": 5}]
    assert payload["included"] == 10
    reasons = _reasons(payload)
    assert reasons["sub-11"] == "no-measures"
    assert sum(reason is None for reason in reasons.values()) == 10
    assert payload["skippedMeasures"] == [
        {
            "measureId": "aseg:bi:Thalamus",
            "reason": "The values do not vary across subjects.",
        }
    ]
    assert payload["registrationProvisional"] is False
    rows = {row["subjectId"]: row for row in payload["subjects"]}
    assert rows["sub-06"]["group"] == "SCI"
    assert rows["sub-06"]["sourceLabel"] == "SCI_P"


def test_configuration_scope_and_qc_rules_exclude_in_order(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    cfg["subjects"] = {"include": [], "exclude": ["sub-01"]}
    passes = ("sub-03", "sub-05", "sub-06", "sub-07")
    write_qc(
        tmp_path,
        {"sub-01": "fail", "sub-02": "fail", **dict.fromkeys(passes, "pass")},
    )

    def reasons(qc: str) -> dict[str, str | None]:
        # Without covariates, so four subjects still fit the model.
        spec = parse_spec(
            example_spec(
                inclusion={"qc": qc},
                covariates={"age": None, "sex": None, "etiv": "none"},
            )
        )
        return _reasons(dataset.resolve_inputs(_context(tmp_path, cfg), spec))

    default = reasons("non-failed")
    assert default["sub-01"] == "config-excluded"
    assert default["sub-02"] == "qc-failed"
    assert default["sub-03"] is None
    assert default["sub-04"] is None

    passed = reasons("passed")
    assert passed["sub-03"] is None
    assert passed["sub-04"] == "qc-not-passed"

    assert reasons("all")["sub-02"] is None

    cfg["subjects"] = {"include": ["sub-03", "sub-04"], "exclude": []}
    assert reasons("all")["sub-05"] == "config-excluded"


def test_groups_levels_and_the_compared_model(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    grouping = {
        "variable": {"source": "registry", "column": "sourceCohortLabel"},
        "groups": [
            {"label": "P", "levels": ["SCI_P"]},
            {"label": "CTRL", "levels": ["CTRL"]},
        ],
    }
    contrast = {
        "type": "groups",
        "grouping": grouping,
        "focal": "P",
        "reference": "CTRL",
        "model": "all-groups",
    }
    spec = parse_spec(example_spec(contrast=contrast))
    reasons = _reasons(dataset.resolve_inputs(_context(tmp_path, cfg), spec))
    assert reasons["sub-09"] == "no-group"

    grouping["groups"].append({"label": "NNP", "levels": ["SCI_nNP"]})
    compared = parse_spec(
        example_spec(contrast={**contrast, "model": "compared-groups"})
    )
    payload = dataset.resolve_inputs(_context(tmp_path, cfg), compared)
    assert _reasons(payload)["sub-09"] == "not-compared"
    assert payload["groups"] == [
        {"label": "P", "n": 3},
        {"label": "CTRL", "n": 5},
        {"label": "NNP", "n": 0},
    ]


def test_a_missing_covariate_excludes_the_subject(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    store = RegistryStore(str(tmp_path))
    store.upsert(
        {
            "subjectId": "sub-04",
            "age": None,
            "sex": "M",
            "sourceCohortLabel": "CTRL",
            "ais": None,
            "tSinceSci": None,
        },
        expected_revision=1,
    )
    spec = parse_spec(example_spec())

    payload = dataset.resolve_inputs(_context(tmp_path, cfg), spec)

    assert _reasons(payload)["sub-04"] == "missing-covariate"
    assert payload["groups"][1] == {"label": "CTRL", "n": 4}


def test_a_non_numeric_cell_leaves_that_subject_out_with_an_issue(
    tmp_path: Path,
) -> None:
    cfg = make_project(tmp_path)
    age = tmp_path / "metadata" / "age.csv"
    age.write_text(
        age.read_text(encoding="utf-8")
        .replace("sub-04,45", "sub-04,unknown")
        .replace("sub-08,47", "sub-08,47 years"),
        encoding="utf-8",
    )
    spec = parse_spec(
        example_spec(covariates={"age": {"source": "age-csv", "column": "age"}})
    )
    context = _context(tmp_path, cfg)

    payload = dataset.resolve_inputs(context, spec)

    reasons = _reasons(payload)
    assert reasons["sub-04"] == reasons["sub-08"] == "missing-covariate"
    assert reasons["sub-05"] is None
    assert payload["issues"] == [
        "age in the age CSV is not a number for 2 subjects, so they are left out "
        "as missing that variable."
    ]
    # The compute goes ahead without them instead of stopping.
    data = dataset.load_dataset(context, spec)
    assert "sub-04" not in data.subject_ids
    assert data.issues == payload["issues"]

    # The tested variable of an association follows the same rule.
    clinical = tmp_path / "metadata" / "clinical.csv"
    clinical.write_text(
        clinical.read_text(encoding="utf-8").replace(
            "sub-06,SCI_P,A,Male,4", "sub-06,SCI_P,A,Male,n.d."
        ),
        encoding="utf-8",
    )
    association = parse_spec(
        example_spec(
            analysis="association",
            measures=["aseg:Brain-Stem"],
            covariates={"age": None, "sex": None, "etiv": "none"},
            contrast={
                "type": "association",
                "variable": {
                    "source": "clinical-csv",
                    "column": "Time since SCI (years)",
                },
                "grouping": None,
                "includedGroups": [],
                "adjustForGroup": False,
            },
        )
    )
    tested = dataset.resolve_inputs(context, association)
    assert _reasons(tested)["sub-06"] == "missing-covariate"
    assert tested["issues"] == [
        "Time since SCI (years) in the clinical CSV is not a number for 1 "
        "subject, so it is left out as missing that variable."
    ]


def test_a_mostly_numeric_extra_covariate_stays_numeric(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    metadata = tmp_path / "metadata" / "metadata.csv"
    metadata.write_text(
        metadata.read_text(encoding="utf-8").replace(
            "sub-03,CTRL,Female,41", "sub-03,CTRL,Female,unknown"
        ),
        encoding="utf-8",
    )
    spec = parse_spec(
        example_spec(
            covariates={"extra": [{"source": "metadata-csv", "column": "Age"}]}
        )
    )
    context = _context(tmp_path, cfg)

    payload = dataset.resolve_inputs(context, spec)
    data = dataset.load_dataset(context, spec)

    # One column, not one indicator per level, and only sub-03 is out.
    assert _reasons(payload)["sub-03"] == "missing-covariate"
    assert payload["issues"] == [
        "Age in metadata.csv is not a number for 1 subject, so it is left out as "
        "missing that variable."
    ]
    assert [key for key in data.covariates if key.startswith("metadata-csv")] == [
        "metadata-csv:Age"
    ]
    assert data.covariates["metadata-csv:Age"][data.subject_ids.index("sub-02")] == 34.0


def test_covariates_are_encoded_in_model_order(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    spec = parse_spec(
        example_spec(
            covariates={
                "sex": {"source": "clinical-csv", "column": "Sex"},
                "extra": [{"source": "metadata-csv", "column": "Age"}],
            }
        )
    )

    data = dataset.load_dataset(_context(tmp_path, cfg), spec)

    assert list(data.covariates) == ["age", "sex", "metadata-csv:Age", "eTIV"]
    first = data.subject_ids.index("sub-02")
    assert data.covariates["sex"][first] == 0.0
    assert data.covariates["sex"][data.subject_ids.index("sub-01")] == 1.0
    assert data.covariates["age"][first] == 34.0
    assert data.covariates["metadata-csv:Age"][first] == 34.0
    assert data.tested is None
    assert list(data.measures) == ["aseg:Brain-Stem", "dk:bi:precentral:ThickAvg"]

    categorical_age = parse_spec(
        example_spec(covariates={"age": {"source": "clinical-csv", "column": "Sex"}})
    )
    with pytest.raises(GroupAnalysisError, match="numeric variable for age"):
        dataset.load_dataset(_context(tmp_path, cfg), categorical_age)


def test_a_missing_column_or_csv_is_an_actionable_error(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    unknown = parse_spec(
        example_spec(
            covariates={"extra": [{"source": "metadata-csv", "column": "BMI"}]}
        )
    )
    with pytest.raises(GroupAnalysisError, match=r"Choose a column that metadata\.csv"):
        dataset.resolve_inputs(_context(tmp_path, cfg), unknown)

    (tmp_path / "metadata" / "metadata.csv").unlink()
    absent = parse_spec(
        example_spec(
            covariates={"extra": [{"source": "metadata-csv", "column": "Age"}]}
        )
    )
    with pytest.raises(GroupAnalysisError, match=r"Make metadata\.csv readable"):
        dataset.resolve_inputs(_context(tmp_path, cfg), absent)


def test_registration_flags_follow_the_rule(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    rows = _registration(sub_02="lh", sub_07="pending")
    measures = [
        "dk:lh:precentral:ThickAvg",
        "dk:bi:precentral:ThickAvg",
        "aseg:Brain-Stem",
    ]

    spec = parse_spec(example_spec(measures=measures))
    context = _context(tmp_path, cfg, registration=rows)
    payload = dataset.resolve_inputs(context, spec)
    subjects = {row["subjectId"]: row for row in payload["subjects"]}
    assert subjects["sub-02"]["included"] is True
    assert subjects["sub-02"]["missingHemispheres"] == ["lh"]
    assert payload["registrationProvisional"] is True

    data = dataset.load_dataset(context, spec)
    index = data.subject_ids.index("sub-02")
    assert data.measures["dk:lh:precentral:ThickAvg"][index] is None
    assert data.measures["dk:bi:precentral:ThickAvg"][index] is None
    assert data.measures["aseg:Brain-Stem"][index] is not None
    assert data.registration_provisional is True

    excluded = parse_spec(
        example_spec(measures=measures, inclusion={"registration": "exclude-subject"})
    )
    assert _reasons(dataset.resolve_inputs(context, excluded))["sub-02"] == (
        "registration-flagged"
    )

    kept = parse_spec(
        example_spec(measures=measures, inclusion={"registration": "keep"})
    )
    kept_data = dataset.load_dataset(context, kept)
    assert kept_data.measures["dk:lh:precentral:ThickAvg"][index] is not None

    settled = _context(tmp_path, cfg, registration=_registration(sub_02="lh"))
    assert dataset.resolve_inputs(settled, spec)["registrationProvisional"] is False
    unknown = _context(tmp_path, cfg, known=False)
    assert dataset.resolve_inputs(unknown, spec)["registrationProvisional"] is True


def test_outlier_flags_follow_the_rule(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    measures = [
        "dk:lh:precentral:ThickAvg",
        "dk:bi:precentral:ThickAvg",
        "aseg:Brain-Stem",
    ]
    context = _context(tmp_path, cfg)

    masked = parse_spec(
        example_spec(measures=measures, inclusion={"outliers": "set-missing"})
    )
    data = dataset.load_dataset(context, masked)
    index = data.subject_ids.index("sub-02")
    assert data.measures["dk:lh:precentral:ThickAvg"][index] is None
    assert data.measures["dk:bi:precentral:ThickAvg"][index] is None
    assert data.measures["aseg:Brain-Stem"][index] is not None

    excluded = parse_spec(
        example_spec(measures=measures, inclusion={"outliers": "exclude-subject"})
    )
    reasons = _reasons(dataset.resolve_inputs(context, excluded))
    assert reasons["sub-02"] == "outlier"
    # sub-07's thalamus flag bears on no selected measure.
    assert reasons["sub-07"] is None


@pytest.mark.parametrize("rule", ["set-missing", "exclude-subject"])
def test_an_outlier_rule_without_its_table_is_a_named_issue(
    tmp_path: Path, rule: str
) -> None:
    cfg = make_project(tmp_path)
    context = _context(tmp_path, cfg)
    outliers = (
        tmp_path / "outputs" / "run" / "qc_review" / "qa_outliers" / "outliers.csv"
    )
    spec = parse_spec(example_spec(inclusion={"outliers": rule}))
    assert dataset.resolve_inputs(context, spec)["issues"] == []
    assert dataset.load_dataset(context, spec).outliers_unapplied is False

    outliers.unlink()
    payload = dataset.resolve_inputs(context, spec)
    assert payload["issues"] == [
        "The ENIGMA outlier table is missing, so the outlier rule was not applied."
    ]
    # Nobody is excluded or masked by a rule that could not be applied.
    assert "outlier" not in _reasons(payload).values()
    data = dataset.load_dataset(context, spec)
    assert data.outliers_unapplied is True
    assert data.issues == payload["issues"]
    kept = parse_spec(example_spec(inclusion={"outliers": "keep"}))
    assert dataset.resolve_inputs(context, kept)["issues"] == []

    outliers.write_bytes(b"\xff\xfe")
    assert dataset.resolve_inputs(context, spec)["issues"] == [
        "The ENIGMA outlier table cannot be read, so the outlier rule was not applied."
    ]


@pytest.mark.parametrize(
    ("structure", "measures"),
    [
        (
            "L_precentral_thickavg",
            ("dk:lh:precentral:ThickAvg", "dk:bi:precentral:ThickAvg"),
        ),
        ("R_insula_surfavg", ("dk:rh:insula:SurfArea", "dk:bi:insula:SurfArea")),
        (
            "Rthal",
            (
                "aseg:Right-Thalamus",
                "aseg:bi:Thalamus",
                "aseg:Right-Thalamus-Proper",
                "aseg:bi:Thalamus-Proper",
            ),
        ),
        ("LLatVent", ("aseg:Left-Lateral-Ventricle", "aseg:bi:Lateral-Ventricle")),
        ("RThickness", ("global:meanThickness",)),
        ("ICV", ("global:eTIV",)),
        ("LSurfArea", ()),
        ("unknown", ()),
    ],
)
def test_enigma_structures_map_to_measure_ids(
    structure: str, measures: tuple[str, ...]
) -> None:
    assert dataset.outlier_measures(structure) == measures


def test_measures_without_enough_values_are_skipped_with_reasons(
    tmp_path: Path,
) -> None:
    cfg = make_project(tmp_path)
    (tmp_path / "outputs" / "run" / "pybrainage" / "predicted_results.csv").unlink()
    measures = [
        "aseg:Brain-Stem",
        "aseg:Optic-Chiasm",
        "aseg:5th-Ventricle",
        "brainage:BrainPAD",
    ]
    spec = parse_spec(example_spec(measures=measures))

    payload = dataset.resolve_inputs(_context(tmp_path, cfg), spec)

    assert payload["skippedMeasures"] == [
        {
            "measureId": "aseg:Optic-Chiasm",
            "reason": "dk_all_stats.csv has no Optic-Chiasm column.",
        },
        {
            "measureId": "aseg:5th-Ventricle",
            "reason": "The values do not vary across subjects.",
        },
        {
            "measureId": "brainage:BrainPAD",
            "reason": "The Brain-PAD stage has not written predicted_results.csv.",
        },
    ]

    write_qc(tmp_path, {f"sub-{n:02d}": "fail" for n in range(6, 10)})
    sparse = dataset.resolve_inputs(_context(tmp_path, cfg), spec)
    assert {
        "measureId": "aseg:Brain-Stem",
        "reason": "Fewer than two subjects in SCI have a value.",
    } in sparse["skippedMeasures"]


def test_a_measure_with_too_few_subjects_for_the_model_is_skipped(
    tmp_path: Path,
) -> None:
    cfg = make_project(tmp_path)
    # Five subjects; the model has an intercept, the SCI indicator, age, sex,
    # and eTIV for the extensive volume: five parameters, no residual left.
    cfg["subjects"] = {
        "include": ["sub-01", "sub-02", "sub-03", "sub-06", "sub-07"],
        "exclude": [],
    }
    measures = ["aseg:Brain-Stem", "dk:bi:precentral:ThickAvg"]
    spec = parse_spec(example_spec(measures=measures))
    context = _context(tmp_path, cfg)

    payload = dataset.resolve_inputs(context, spec)

    assert payload["skippedMeasures"] == [
        {
            "measureId": "aseg:Brain-Stem",
            "reason": (
                "The model has 5 parameters, so a fit needs 6 subjects with this "
                "measure; 5 have it."
            ),
        }
    ]
    data = dataset.load_dataset(context, spec)
    assert list(data.measures) == ["dk:bi:precentral:ThickAvg"]
    assert data.too_small == {"aseg:Brain-Stem": (5, 5)}

    # Thickness takes no eTIV: four parameters fit five subjects.
    thin = parse_spec(example_spec(measures=["dk:bi:precentral:ThickAvg"]))
    assert dataset.resolve_inputs(context, thin)["skippedMeasures"] == []


def test_the_parameter_count_follows_the_design(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    context = _context(tmp_path, cfg)
    spec = parse_spec(example_spec(measures=["aseg:Brain-Stem"]))
    resolution = dataset._resolve(context, spec, dataset.Tables(context))
    by_id = {item.subject_id: item for item in resolution.candidates}
    present = [item.subject_id for item in resolution.included()]
    count = dataset.parameter_count(
        spec, "aseg:Brain-Stem", present, by_id, resolution.covariates
    )
    assert count == 5
    # A covariate constant among the subjects with a value adds nothing.
    women = [sid for sid in present if resolution.covariates["sex"][sid] == 1.0]
    assert (
        dataset.parameter_count(
            spec, "aseg:Brain-Stem", women, by_id, resolution.covariates
        )
        == 4
    )
    # eTIV enters only the measures that take it.
    assert (
        dataset.parameter_count(
            spec, "dk:bi:precentral:ThickAvg", present, by_id, resolution.covariates
        )
        == 4
    )


@pytest.mark.parametrize(
    ("skipped", "too_small", "message"),
    [
        (
            [{"measureId": "a", "reason": "x"}, {"measureId": "b", "reason": "x"}],
            {"a": (4, 5), "b": (3, 5)},
            "No selected measure could be fit: every measure has fewer subjects "
            "than the model's 5 parameters plus 1 (at most 4 subjects have a "
            "value).",
        ),
        (
            [{"measureId": "a", "reason": "x"}],
            {"a": (1, 4)},
            "No selected measure could be fit: the measure has fewer subjects "
            "than the model's 4 parameters plus 1 (at most 1 subject has a "
            "value).",
        ),
        (
            [{"measureId": "a", "reason": "x"}, {"measureId": "b", "reason": "x"}],
            {"a": (4, 5), "b": (4, 6)},
            "No selected measure could be fit: every measure has fewer subjects "
            "than the model's 5 to 6 parameters plus 1 (at most 4 subjects have "
            "a value).",
        ),
        (
            [
                {"measureId": "a", "reason": "The values do not vary across subjects."},
                {"measureId": "b", "reason": "The values do not vary across subjects."},
            ],
            {},
            "No selected measure could be fit: all 2 measures were skipped because "
            "the values do not vary across subjects.",
        ),
        (
            [
                {
                    "measureId": "a",
                    "reason": "Fewer than two subjects in SCI have a value.",
                },
                {
                    "measureId": "b",
                    "reason": "Fewer than two subjects in SCI have a value.",
                },
                {"measureId": "c", "reason": "dk_all_stats.csv has no x column."},
            ],
            {},
            "No selected measure could be fit: 2 of 3 measures were skipped because "
            "fewer than two subjects in SCI have a value.",
        ),
        (
            [{"measureId": "a", "reason": "The values do not vary across subjects."}],
            {},
            "No selected measure could be fit: the measure was skipped because the "
            "values do not vary across subjects.",
        ),
    ],
)
def test_the_no_fit_message_names_why(
    skipped: list[dict[str, Any]],
    too_small: dict[str, tuple[int, int]],
    message: str,
) -> None:
    assert dataset.no_fit_message(skipped, too_small) == message


def test_a_missing_etiv_masks_only_the_measures_that_take_it(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    icv = tmp_path / _STRUCTURAL / "icv_data.csv"
    lines = icv.read_text(encoding="utf-8").splitlines()
    icv.write_text(
        "\n".join(line for line in lines if not line.startswith("sub-03")) + "\n"
    )
    spec = parse_spec(
        example_spec(measures=["aseg:Brain-Stem", "dk:lh:precentral:ThickAvg"])
    )

    data = dataset.load_dataset(_context(tmp_path, cfg), spec)

    index = data.subject_ids.index("sub-03")
    assert data.measures["aseg:Brain-Stem"][index] is None
    assert data.measures["dk:lh:precentral:ThickAvg"][index] is not None
    assert data.covariates["eTIV"][index] is None
    blocks = dataset.availability_blocks(data)
    assert [block.measures for block in blocks] == [
        ("aseg:Brain-Stem",),
        ("dk:lh:precentral:ThickAvg",),
    ]
    assert index not in blocks[0].rows
    assert index in blocks[1].rows

    icv.unlink()
    payload = dataset.resolve_inputs(_context(tmp_path, cfg), spec)
    assert payload["skippedMeasures"][0]["measureId"] == "aseg:Brain-Stem"
    assert "eTIV" in payload["skippedMeasures"][0]["reason"]


def test_no_measure_values_exclude_every_subject(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    (tmp_path / "outputs" / "run" / "pybrainage" / "predicted_results.csv").unlink()
    spec = parse_spec(
        example_spec(analysis="brain-age", measures=["brainage:BrainPAD"])
    )

    data = dataset.load_dataset(_context(tmp_path, cfg), spec)

    assert data.subject_ids == []
    assert data.measures == {}
    assert {row["reason"] for row in data.subjects} == {"no-measures"}


def test_an_association_tests_a_numeric_variable_in_chosen_groups(
    tmp_path: Path,
) -> None:
    cfg = make_project(tmp_path)
    contrast = {
        "type": "association",
        "variable": {"source": "clinical-csv", "column": "Time since SCI (years)"},
        "grouping": {
            "variable": {"source": "registry", "column": "sourceCohortLabel"},
            "groups": [
                {"label": "SCI", "levels": ["SCI_P", "SCI_nNP"]},
                {"label": "CTRL", "levels": ["CTRL"]},
            ],
        },
        "includedGroups": ["SCI"],
        "adjustForGroup": False,
    }
    spec = parse_spec(
        example_spec(
            analysis="association",
            contrast=contrast,
            measures=["aseg:Brain-Stem"],
            # Five subjects fit the slope without the covariates.
            covariates={"age": None, "sex": None, "etiv": "none"},
        )
    )

    context = _context(tmp_path, cfg)
    payload = dataset.resolve_inputs(context, spec)
    assert payload["groups"] == [{"label": "SCI", "n": 5}]
    assert _reasons(payload)["sub-01"] == "not-compared"
    data = dataset.load_dataset(context, spec)
    assert data.tested == [4.0] * 5

    ungrouped = parse_spec(
        example_spec(
            analysis="association",
            contrast={**contrast, "grouping": None, "includedGroups": []},
            measures=["aseg:Brain-Stem"],
            covariates={"age": None, "sex": None, "etiv": "none"},
        )
    )
    everyone = dataset.resolve_inputs(context, ungrouped)
    assert everyone["groups"] == []
    assert _reasons(everyone)["sub-01"] == "missing-covariate"
    assert everyone["included"] == 5


def test_takes_etiv_and_used_sources(tmp_path: Path) -> None:
    del tmp_path
    assert dataset.takes_etiv("aseg:Brain-Stem", "extensive") is True
    assert dataset.takes_etiv("dk:lh:precentral:ThickAvg", "extensive") is False
    assert dataset.takes_etiv("dk:lh:precentral:ThickAvg", "all") is True
    assert dataset.takes_etiv("global:eTIV", "all") is False
    assert dataset.takes_etiv("aseg:Brain-Stem", "none") is False

    spec = parse_spec(
        example_spec(
            inclusion={"outliers": "set-missing"},
            covariates={"sex": {"source": "clinical-csv", "column": "Sex"}},
        )
    )
    assert dataset.used_sources(spec) == [
        "dk-all-stats",
        "icv",
        "clinical-csv",
        "outliers",
    ]
    assert dataset.registration_relevant(spec) is True
    aseg_only = parse_spec(example_spec(measures=["aseg:Brain-Stem"]))
    assert dataset.registration_relevant(aseg_only) is False


def test_context_state_follows_only_the_fields_the_spec_reads(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    spec = parse_spec(example_spec())
    before = dataset.context_state(_context(tmp_path, cfg), spec)

    store = RegistryStore(str(tmp_path))
    record = {
        "subjectId": "sub-02",
        "age": 34,
        "sex": "M",
        "sourceCohortLabel": "CTRL",
        "ais": None,
        "tSinceSci": 1,
    }
    store.upsert(record, expected_revision=1)
    assert dataset.context_state(_context(tmp_path, cfg), spec) == before

    store.upsert({**record, "age": 35}, expected_revision=2)
    after = dataset.context_state(_context(tmp_path, cfg), spec)
    assert after["registrySha256"] != before["registrySha256"]

    flagged = dataset.context_state(
        _context(tmp_path, cfg, registration=_registration(sub_02="rh")), spec
    )
    assert flagged["registrationSha256"] != before["registrationSha256"]


def test_categorical_covariates_become_indicators() -> None:
    subjects = ["a", "b", "c", "d"]
    sexes = {"a": "F", "b": "M", "c": "O", "d": "F"}
    assert dataset._encode("sex", sexes, subjects, numeric_only=False) == {
        "sex": {"a": 1.0, "b": 0.0, "c": 0.0, "d": 1.0},
        "sex:O": {"a": 0.0, "b": 0.0, "c": 1.0, "d": 0.0},
    }
    assert (
        dataset._encode("sex", {"a": "F", "b": "F"}, ["a", "b"], numeric_only=False)
        == {}
    )
    sites = {"a": "north", "b": "south", "c": "west", "d": "north"}
    assert dataset._encode(
        "metadata-csv:Site", sites, subjects, numeric_only=False
    ) == {
        "metadata-csv:Site:south": {"a": 0.0, "b": 1.0, "c": 0.0, "d": 0.0},
        "metadata-csv:Site:west": {"a": 0.0, "b": 0.0, "c": 1.0, "d": 0.0},
    }
    numeric = {"a": "0", "b": "1", "c": "1", "d": "0"}
    assert dataset._encode("sex", numeric, subjects, numeric_only=False) == {
        "sex": {"a": 0.0, "b": 1.0, "c": 1.0, "d": 0.0}
    }
