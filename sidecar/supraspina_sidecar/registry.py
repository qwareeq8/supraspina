"""The authoritative pipeline step registry.

Mirror this data in ``src/shared/steps.ts``. Scope and dependency metadata are
execution contracts, and the workflow planner uses them to decide node
multiplicity and readiness.
"""

from __future__ import annotations

from typing import Literal, TypedDict

StepScope = Literal["subject", "cohort"]


class StepDescriptor(TypedDict):
    """Represent a step descriptor returned to the planner."""

    id: float
    key: str
    name: str
    goal: str
    scope: StepScope
    dependencies: list[str]


# New step keys are appended after ``final``:
# ``braincharts`` and then ``zstats``. Every descriptor gets a workflow node
# even when disabled, and a node ID carries the node's position in the plan,
# so a new step inserted before ``final`` would shift every later node ID.
# The UI may list stages in another order, which never changes this one.
STEP_DESCRIPTORS: list[StepDescriptor] = [
    {
        "id": -1,
        "key": "brainfov",
        "name": "Brain FOV preparation",
        "goal": (
            "Prepares high-FOV T1w inputs with a geometry-checked, mask-guided crop "
            "and explicit review."
        ),
        "scope": "subject",
        "dependencies": [],
    },
    {
        "id": 0,
        "key": "deface",
        "name": "Optional defacing",
        "goal": (
            "Optionally runs the selected defacing tool before structural processing."
        ),
        "scope": "subject",
        "dependencies": [],
    },
    {
        "id": 1,
        "key": "recon",
        "name": "Reconstruction",
        "goal": (
            "Runs cortical reconstruction and compatible parcellation for every "
            "subject."
        ),
        "scope": "subject",
        "dependencies": [],
    },
    {
        "id": 2,
        "key": "enigma",
        "name": "ENIGMA QC",
        "goal": (
            "Runs ENIGMA FreeSurfer QA to create cortical and subcortical measures, QC "
            "PNG montages, and static HTML galleries."
        ),
        "scope": "cohort",
        "dependencies": ["recon"],
    },
    {
        "id": 2.5,
        "key": "outliers",
        "name": "Histogram and outlier review",
        "goal": (
            "Plots per-region histograms and flags values beyond mean +/- z SD for "
            "review."
        ),
        "scope": "cohort",
        "dependencies": ["enigma"],
    },
    {
        "id": 3,
        "key": "features",
        "name": "FreeSurfer feature extraction",
        "goal": (
            "Builds the PyBrainAge feature matrix from Destrieux cortical thickness "
            "and subcortical volumes."
        ),
        "scope": "cohort",
        "dependencies": ["recon"],
    },
    {
        "id": 4,
        "key": "age",
        "name": "Age metadata integration",
        "goal": (
            "Inserts chronological age as column 2 to produce the model-ready "
            "189-column table."
        ),
        "scope": "cohort",
        "dependencies": ["features"],
    },
    {
        "id": 5,
        "key": "pybrainage",
        "name": "PyBrainAge prediction",
        "goal": (
            "Predicts BrainAge + Brain-PAD (BrainAge - Age) for every subject using "
            "the pinned ExtraTrees model."
        ),
        "scope": "cohort",
        "dependencies": ["age"],
    },
    {
        "id": 6,
        "key": "clinical",
        "name": "Clinical merge",
        "goal": (
            "Merges BrainAge predictions with clinical metadata into the analysis "
            "workbook."
        ),
        "scope": "cohort",
        "dependencies": ["pybrainage"],
    },
    {
        "id": 7,
        "key": "brainpad",
        "name": "Brain-PAD statistics",
        "goal": (
            "Compares group-level Brain-PAD by cohort, sex, and AIS, then computes "
            "effect sizes and figures."
        ),
        "scope": "cohort",
        "dependencies": ["clinical"],
    },
    {
        "id": 8,
        "key": "aggregate",
        "name": "Structural data aggregation",
        "goal": (
            "Aggregates DK stats, cortical thickness, ICV, and white-matter volumes "
            "across the cohort."
        ),
        "scope": "cohort",
        "dependencies": ["recon"],
    },
    {
        "id": 9,
        "key": "final",
        "name": "R analysis",
        "goal": (
            "Runs the final R structural analysis to create effect-size tables and an "
            "optional HTML report."
        ),
        "scope": "cohort",
        "dependencies": ["aggregate"],
    },
    # Appended after ``final``; ``id`` 5.5 places it beside
    # PyBrainAge in stage lists without moving any node.
    {
        "id": 5.5,
        "key": "braincharts",
        "name": "BrainCharts normative modeling",
        "goal": (
            "Adapts the lifespan BrainCharts model to the controls of each site "
            "and writes per-region z-scores."
        ),
        "scope": "cohort",
        "dependencies": ["features"],
    },
    # Appended after ``braincharts``; ``id`` 9.5 places it beside
    # R analysis, whose comparisons it repeats on the z-scores.
    {
        "id": 9.5,
        "key": "zstats",
        "name": "Z-score group comparisons",
        "goal": (
            "Compares BrainCharts z-scores between cohorts with per-region Welch "
            "t-tests and Hedges g, pooling the adapted sites."
        ),
        "scope": "cohort",
        "dependencies": ["braincharts"],
    },
]

STEP_BY_KEY: dict[str, StepDescriptor] = {
    step["key"]: step for step in STEP_DESCRIPTORS
}
STEP_SCOPES: dict[str, StepScope] = {
    key: descriptor["scope"] for key, descriptor in STEP_BY_KEY.items()
}
STEP_DEPENDENCIES: dict[str, tuple[str, ...]] = {
    key: tuple(descriptor["dependencies"])
    for key, descriptor in STEP_BY_KEY.items()
    if descriptor["dependencies"]
}
