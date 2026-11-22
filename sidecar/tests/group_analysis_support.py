"""Shared fixtures for the group-analysis tests.

``make_project`` writes a small synthetic project in the pipeline's real
layout (the aggregation tables, the Brain-PAD table, the metadata CSVs, the
ENIGMA outlier table, and the subject registry). ``fake_run`` stands in for
``engine.run`` (WP1): it returns well-formed rows from plain group means, so
these tests exercise the dataset, store, worker, and manager, never the
statistics.
"""

from __future__ import annotations

import copy
import csv
import json
import math
from pathlib import Path
from typing import Any

from supraspina_sidecar.group_analysis import engine, identity
from supraspina_sidecar.group_analysis.spec import measure_family
from supraspina_sidecar.registry_store import RegistryStore

FIXTURE = Path(__file__).parent / "fixtures" / "group_analysis" / "spec-v1-example.json"

#: Subject ID, registry label, age, sex; the last two are registry-only.
SUBJECTS: tuple[tuple[str, str, int, str], ...] = (
    ("sub-01", "CTRL", 30, "F"),
    ("sub-02", "CTRL", 34, "M"),
    ("sub-03", "CTRL", 41, "F"),
    ("sub-04", "CTRL", 45, "M"),
    ("sub-05", "CTRL", 52, "F"),
    ("sub-06", "SCI_P", 33, "M"),
    ("sub-07", "SCI_P", 39, "F"),
    ("sub-08", "SCI_P", 47, "M"),
    ("sub-09", "SCI_nNP", 50, "M"),
    ("sub-10", "SCI_nNP", 55, "F"),
    ("sub-11", "CTRL", 60, "M"),
)
IMAGED = tuple(subject for subject in SUBJECTS if subject[0] != "sub-11")
DK_COLUMNS = (
    "lh_precentral_ThickAvg",
    "rh_precentral_ThickAvg",
    "lh_precentral_SurfArea",
    "rh_precentral_SurfArea",
)
ASEG_COLUMNS = ("Brain-Stem", "Left-Thalamus", "Right-Thalamus", "5th-Ventricle")


def _write_csv(path: Path, header: list[str], rows: list[list[Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def _value(index: int, column: int, sci: bool) -> float:
    base = 2.5 + 0.1 * column
    return round(
        base + 0.03 * math.sin(index * 1.7 + column) - (0.1 if sci else 0.0), 6
    )


def make_cfg(root: Path) -> dict[str, Any]:
    """Return the project configuration the fixture layout matches."""
    return {
        "project": {"name": "analysis-fixture", "createdAt": ""},
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(root / "rawdata"),
            "derivativesDir": str(root / "derivatives"),
            "outputDir": str(root / "outputs" / "run"),
            "metadataDir": str(root / "metadata"),
            "clinicalMetadataFile": str(root / "metadata" / "clinical.csv"),
            "ageMetadataFile": str(root / "metadata" / "age.csv"),
            "qcOutputDir": str(root / "outputs" / "run" / "qc_review"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "subjects": {"include": [], "exclude": []},
        "steps": {
            "aggregate": {
                "enabled": True,
                "params": {"outDir": "${paths.outputDir}/structural"},
            }
        },
    }


def make_project(root: Path, *, registry: bool = True) -> dict[str, Any]:
    """Write the synthetic project and return its configuration."""
    cfg = make_cfg(root)
    out = root / "outputs" / "run"
    dk_rows = []
    for index, (subject_id, label, _age, _sex) in enumerate(IMAGED):
        sci = label != "CTRL"
        dk = [_value(index, column, sci) for column in range(len(DK_COLUMNS))]
        dk[2] *= 1000
        dk[3] *= 1000
        aseg = [20000 + 500 * math.cos(index) - (800 if sci else 0), 7000.5, 7100.25, 0]
        dk_rows.append([subject_id, *dk, *aseg])
    _write_csv(
        out / "structural" / "dk_all_stats.csv",
        ["subject", *DK_COLUMNS, *ASEG_COLUMNS],
        dk_rows,
    )
    _write_csv(
        out / "structural" / "cortical_thickness.csv",
        ["subject", "lh_mean_thickness", "rh_mean_thickness"],
        [[row[0], row[1], row[2]] for row in dk_rows],
    )
    _write_csv(
        out / "structural" / "icv_data.csv",
        ["subject", "eTIV"],
        [[s[0], 1_400_000 + 20_000 * i] for i, s in enumerate(IMAGED)],
    )
    _write_csv(
        out / "pybrainage" / "predicted_results.csv",
        ["ID", "Age", "BrainAge", "BrainPAD"],
        [[s[0], s[2], s[2] + 3 + i % 4, 3 + i % 4] for i, s in enumerate(IMAGED)],
    )
    _write_csv(
        out / "qc_review" / "qa_outliers" / "outliers.csv",
        ["SubjID", "structure", "measure", "direction", "value", "lower", "upper"],
        [
            ["sub-02", "L_precentral_thickavg", "thickness", "high", 3, 2, 2.9],
            ["sub-07", "Lthal", "volume", "low", 1, 2, 3],
        ],
    )
    metadata = root / "metadata"
    _write_csv(
        metadata / "age.csv",
        ["participant_id", "age"],
        [[s[0], s[2]] for s in SUBJECTS],
    )
    _write_csv(
        metadata / "clinical.csv",
        ["participant_id", "Cohort", "AIS", "Sex", "Time since SCI (years)"],
        [
            [
                s[0],
                s[1],
                "" if s[1] == "CTRL" else "A",
                "Female" if s[3] == "F" else "Male",
                "" if s[1] == "CTRL" else 4,
            ]
            for s in SUBJECTS
        ],
    )
    _write_csv(
        metadata / "metadata.csv",
        ["participant_id", "Cohort", "Sex", "Age"],
        [[s[0], s[1], "Female" if s[3] == "F" else "Male", s[2]] for s in SUBJECTS],
    )
    if registry:
        registry_store = RegistryStore(str(root))
        for subject_id, label, age, sex in SUBJECTS:
            registry_store.upsert(
                {
                    "subjectId": subject_id,
                    "age": age,
                    "sex": sex,
                    "sourceCohortLabel": label,
                    "ais": None if label == "CTRL" else "A",
                    "tSinceSci": None if label == "CTRL" else 4,
                }
            )
    return cfg


def review_evidence() -> dict[str, Any]:
    """Return gallery-review evidence the QC store accepts."""
    return {
        "evidenceVersion": 1,
        "reviewer": "analysis-test-reviewer",
        "reviewedAt": "2026-07-23T12:00:00.000Z",
        "galleries": [
            {
                "tab": tab,
                "label": label,
                "displayPath": f"outputs/qc/{tab}.html",
                "runId": "run-1234abcd",
                "receiptSha256": "a" * 64,
                "openedAt": "2026-07-23T11:59:00.000Z",
            }
            for tab, label in (
                ("subcortical", "Subcortical QC gallery"),
                ("internal", "Cortical-internal QC gallery"),
                ("external", "Cortical-external QC gallery"),
            )
        ],
    }


def write_qc(root: Path, verdicts: dict[str, str]) -> None:
    """Write the canonical QC store with reviewed verdicts."""
    path = root / ".supraspina" / "qc_verdicts.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "verdicts": {
                    subject_id: {
                        "verdict": verdict,
                        "note": "",
                        "tags": [],
                        "reviewEvidence": review_evidence(),
                        "revision": 1,
                        "updatedAt": "2026-07-23T12:00:00.000Z",
                    }
                    for subject_id, verdict in verdicts.items()
                },
            }
        ),
        encoding="utf-8",
    )


def example_spec(**changes: Any) -> dict[str, Any]:
    """Return the fixture's spec v1 with sections changed.

    ``covariates``, ``inclusion``, and ``inference`` merge into the fixture's
    section; every other key replaces it.
    """
    spec = copy.deepcopy(json.loads(FIXTURE.read_text(encoding="utf-8"))["spec"])
    for key, value in changes.items():
        if key in {"covariates", "inclusion", "inference"}:
            spec[key] = {**spec[key], **value}
        else:
            spec[key] = value
    return spec


def request(
    root: Path,
    cfg: dict[str, Any],
    *,
    project_id: str = "analysis-project",
    **extra: Any,
) -> dict[str, Any]:
    """Return one ``groupAnalysis.*`` request as main sends it."""
    return {
        "project": {
            "projectId": project_id,
            "root": str(root),
            "configPath": str(root / "supraspina.project.json"),
            "epoch": 1,
        },
        "cfg": cfg,
        "configRevision": 3,
        "configSha256": "a" * 64,
        **extra,
    }


def fake_run(
    dataset: Any, spec: Any, *, progress: Any, cancelled: Any
) -> engine.EngineOutput:
    """Stand in for ``engine.run``: well-formed rows from plain group means."""
    contrast = spec.contrast
    focal = getattr(contrast, "focal", None)
    reference = getattr(contrast, "reference", None)
    rows = []
    means: dict[str, list[dict[str, Any]]] = {}
    values: dict[str, list[dict[str, Any]]] = {}
    total = len(dataset.measures)
    for done, (measure_id, cells) in enumerate(dataset.measures.items()):
        if cancelled():
            raise RuntimeError("cancelled")
        progress("fitting", done, total)
        pairs = [
            (group, value)
            for group, value in zip(dataset.groups, cells, strict=True)
            if value is not None
        ]
        focal_values = [v for g, v in pairs if g == focal] or [0.0]
        reference_values = [v for g, v in pairs if g == reference] or [0.0]
        estimate = sum(focal_values) / len(focal_values) - sum(reference_values) / len(
            reference_values
        )
        rows.append(
            {
                "measureId": measure_id,
                "family": measure_family(measure_id),
                "nTotal": len(pairs),
                "nFocal": len(focal_values),
                "nReference": len(reference_values),
                "estimate": estimate,
                "se": 1.0,
                "t": estimate,
                "df": float(len(pairs) - 2),
                "p": 0.04,
                "pCorrected": 0.04,
                "significant": measure_id.startswith("aseg:"),
                "d": estimate,
                "dLow": estimate - 1,
                "dHigh": estimate + 1,
                "dRawSd": estimate,
                "partialEta2": 0.1,
                "pctOfReference": -1.5,
                "pHc3": 0.05,
                "pPermutation": None,
            }
        )
        means[measure_id] = [
            {"label": label, "role": role, "n": 1, "mean": 1.0, "low": 0.5, "high": 1.5}
            for label, role in ((focal, "focal"), (reference, "reference"))
            if label is not None
        ]
        values[measure_id] = [
            {
                "subjectId": subject_id,
                "group": group,
                "sourceLabel": label,
                "value": value,
                "adjusted": value,
                "x": None,
            }
            for subject_id, group, label, value in zip(
                dataset.subject_ids,
                dataset.groups,
                dataset.source_labels,
                cells,
                strict=True,
            )
            if value is not None
        ]
    progress("fitting", total, total)
    return engine.EngineOutput(rows=rows, group_means=means, subject_values=values)


def sample_record(result_id: str, created_at: str, **changes: Any) -> dict[str, Any]:
    """Return a complete stored record (without its digest) for store tests."""
    row = {
        "measureId": "aseg:Brain-Stem",
        "family": "aseg",
        "nTotal": 10,
        "nFocal": 5,
        "nReference": 5,
        "estimate": -800.5,
        "se": 120.25,
        "t": -3.5,
        "df": 6.0,
        "p": 0.0123,
        "pCorrected": 0.04,
        "significant": True,
        "d": -0.48,
        "dLow": -0.91,
        "dHigh": -0.05,
        "dRawSd": -0.8,
        "partialEta2": 0.2,
        "pctOfReference": -5.7,
        "pHc3": 0.02,
        "pPermutation": None,
    }
    record: dict[str, Any] = {
        "schema": "supraspina/group-analysis-result",
        "schemaVersion": 1,
        "resultId": result_id,
        "specId": None,
        "name": "SCI vs CTRL",
        "spec": example_spec(),
        "specDigest": "b" * 64,
        "createdAt": created_at,
        "engine": {
            "id": identity.ENGINE_ID,
            "rng": identity.RNG_ID,
            "productVersion": "20261121.1830.0",
            "build": None,
        },
        "provisional": False,
        "stageCurrency": {"aggregate": "current", "pybrainage": "unknown"},
        "inputs": [],
        "sample": {
            "groups": [{"label": "SCI", "n": 5}, {"label": "CTRL", "n": 5}],
            "included": 10,
            "excluded": [
                {"subjectId": "sub-11", "reason": "no-measures"},
                {"subjectId": "sub-12", "reason": "no-measures"},
                {"subjectId": "sub-13", "reason": "qc-failed"},
            ],
        },
        "rows": [row],
        "skipped": [],
        "subjects": [],
        "state": {
            "registrySha256": "c" * 64,
            "registrationSha256": "d" * 64,
            "usedSources": [],
        },
        "detail": {
            "subjects": {"sub-01": ["CTRL", "=CTRL"], "sub-06": ["SCI", "SCI_P"]},
            "measures": {
                "aseg:Brain-Stem": {
                    "groupMeans": [
                        {
                            "label": "SCI",
                            "role": "focal",
                            "n": 5,
                            "mean": 19000.0,
                            "low": 18500.0,
                            "high": 19500.0,
                        }
                    ],
                    "values": [
                        ["sub-01", 20000.5, 20001.0, None],
                        ["sub-06", 19000.25, 18999.0, None],
                    ],
                }
            },
        },
    }
    record.update(changes)
    return record
