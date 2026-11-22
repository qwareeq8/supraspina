"""Build v2 engine inputs for tests from the v1 fixtures.

The dataset layer (WP2) resolves a spec v2 into ``EngineDataV2``; until it
lands, these helpers stand in for it on the synthetic fixtures: they apply
an upgraded v1 specification's subset filter and lay the v1 columns out
under the v2 variable keys.
"""

from __future__ import annotations

from typing import Any

from supraspina_sidecar.group_analysis.dataset import Dataset
from supraspina_sidecar.group_analysis.engine_input import EngineDataV2, variable_key
from supraspina_sidecar.group_analysis.spec import (
    GroupAnalysisSpec,
    GroupAnalysisSpecV2,
    upgrade_v1,
)


def upgraded_input(
    dataset: Dataset, spec: GroupAnalysisSpec
) -> tuple[EngineDataV2, GroupAnalysisSpecV2]:
    """Return the v2 input and spec equivalent to a v1 dataset and spec.

    ``Dataset.source_labels`` holds each subject's grouping level and
    ``Dataset.tested`` the association's variable; the upgraded spec's
    subset filter (the included groups of an association) is applied here,
    as the v2 dataset layer would.
    """
    upgraded = upgrade_v1(spec)
    keep = list(range(len(dataset.subject_ids)))
    for item in upgraded.design.subset:
        levels = set(item.keep.levels)  # type: ignore[union-attr]
        keep = [i for i in keep if dataset.source_labels[i] in levels]
    variables: dict[str, list[Any]] = {}
    contrast = spec.contrast
    if contrast.grouping is not None:
        variables[variable_key(contrast.grouping.variable)] = [
            dataset.source_labels[i] for i in keep
        ]
    if dataset.tested is not None:
        variables[variable_key(contrast.variable)] = [  # type: ignore[union-attr]
            dataset.tested[i] for i in keep
        ]
    data = EngineDataV2(
        subject_ids=[dataset.subject_ids[i] for i in keep],
        source_labels=[dataset.source_labels[i] for i in keep],
        variables=variables,
        covariates={
            key: [values[i] for i in keep] for key, values in dataset.covariates.items()
        },
        measures={
            key: [values[i] for i in keep] for key, values in dataset.measures.items()
        },
    )
    return data, upgraded
