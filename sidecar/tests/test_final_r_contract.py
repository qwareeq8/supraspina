"""Tests for the frozen R analysis site and z-score track contract.

``final_r_contract`` names what the registry projection, the Step 9 script,
and the BrainCharts and z-score stages share; these tests tie it to the
current Final adapter and the BrainCharts regions.
"""

from __future__ import annotations

import pytest

from supraspina_sidecar import final_r_contract, resources
from supraspina_sidecar.adapters.final import (
    COHORT_LABELS,
    COMPARISON_CODES,
    FinalAdapter,
)
from supraspina_sidecar.registry import STEP_DESCRIPTORS


def test_new_step_keys_are_appended_after_final() -> None:
    keys = [descriptor["key"] for descriptor in STEP_DESCRIPTORS]
    assert keys[keys.index("final") :] == ["final", "braincharts", "zstats"]


def test_final_r_contract_names_the_current_comparisons() -> None:
    contract = final_r_contract
    assert tuple(contract.COMPARISON_GROUPS) == COMPARISON_CODES
    positions = ("control", "pain", "nopain", "pooled")
    labels = dict(zip(positions, COHORT_LABELS, strict=True))
    assert {
        code: (labels[ref], labels[foc])
        for code, (ref, foc) in contract.COMPARISON_GROUPS.items()
    } == {
        "PvH": ("SCI_H", "SCI_P"),
        "nNPvH": ("SCI_H", "SCI_nNP"),
        "nNPvP": ("SCI_P", "SCI_nNP"),
        "IvH": ("SCI_H", "SCI"),
    }
    assert contract.RESULT_COLUMNS[0] == "Region"
    assert "Mean_Group_ref" not in contract.RESULT_COLUMNS
    assert len(set(contract.RESULT_COLUMNS)) == len(contract.RESULT_COLUMNS)
    assert contract.SITE_EXCLUSIONS_COLUMNS == (
        "comparison",
        "site",
        "n_ref",
        "n_focal",
        "excluded_subjects",
        "reason",
    )


@pytest.mark.parametrize("render_report", [True, False])
def test_raw_track_argv_carries_no_track_flag(render_report: bool) -> None:
    cfg = {
        "paths": {
            "projectRoot": "/repo",
            "outputDir": "/work/outputs",
            "metadataDir": "/work/metadata",
        },
        "tools": {"rscriptExecutable": "/usr/bin/Rscript"},
        "steps": {
            "final": {
                "enabled": True,
                "params": {
                    "rscriptExecutable": "/usr/bin/Rscript",
                    "outDir": "/work/outputs/final",
                    "renderReport": render_report,
                },
            }
        },
    }
    argv = FinalAdapter().build_command(cfg, None)
    assert final_r_contract.TRACK_FLAG not in argv


def test_zscore_blocks_match_the_braincharts_regions() -> None:
    template = resources.features_dir() / "rois_input_template.txt"
    header = template.read_text(encoding="utf-8").splitlines()[0].split("\t")
    regions = [name for name in header if name not in {"ID", "Age"}]
    assert len(regions) == 187
    columns = [f"{name}{final_r_contract.ZSCORE_SUFFIX}" for name in regions]
    cortical = [
        name
        for name in columns
        if name.endswith(final_r_contract.ZSCORE_THICKNESS_SUFFIX)
    ]
    assert (len(cortical), len(columns) - len(cortical)) == (150, 37)
    assert final_r_contract.ZSCORES_FILE == "braincharts_zscores.csv"
