"""The v2 engine's input: one resolved spec v2 sample (numpy-free).

The dataset layer (WP2: population, subset filters, imported and derived
variables, tier A sources, inclusion) resolves a spec v2 into one
:class:`EngineDataV2`; the v2 engine (``engine_v2``, worker only) fits it.
Everything here is plain Python so the RPC process can build and check the
input without importing numpy.

The engine applies the test-level parts itself: each test's grouping of
levels into groups, the tested and moderating variable transforms
(``log1p``, ``standardize``), strata, complete cases per test and measure,
and which measures take the head-size covariate.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .dataset import AnalysisContext
from .spec import (
    HEAD_SIZE_MEASURES,
    GroupAnalysisError,
    GroupAnalysisSpecV2,
    is_extensive,
    parse_measure_id,
)

#: The ``EngineDataV2.covariates`` key of the head-size covariate (eTIV,
#: sTIV, or the SynthSeg TIV, whichever the spec chose); the v1 key.
HEAD_SIZE_KEY = "eTIV"


def variable_key(ref: Any) -> str:
    """Return the ``EngineDataV2.variables`` key of one spec v2 variable.

    Parameters
    ----------
    ref
        A ``VariableRefV2``: a registry field or CSV column, an imported
        column, a derived variable, or a measure.

    Returns
    -------
    str
        ``<source>:<column>``, or ``imported:<table>:<column>``.
    """
    if ref.source == "imported":
        return f"imported:{ref.table}:{ref.column}"
    return f"{ref.source}:{ref.column}"


def level_text(value: Any) -> str | None:
    """Return a grouping variable's level as text (a number without ``.0``)."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    number = float(value)
    if math.isnan(number):
        return None
    return str(int(number)) if number.is_integer() else repr(number)


def takes_head_size(measure_id: str, spec: GroupAnalysisSpecV2) -> bool:
    """Say whether a measure's model adds the head-size covariate.

    Parameters
    ----------
    measure_id
        A valid measure ID.
    spec
        The spec v2 (``covariates.headSize``).

    Returns
    -------
    bool
        True under the ``all`` rule, or for an extensive measure under
        ``extensive``; never for a head-size measure itself or without a
        head-size source.
    """
    head = spec.covariates.headSize
    parts = parse_measure_id(measure_id)
    if head.source == "none" or parts is None:
        return False
    if parts.source == "global" and parts.name in HEAD_SIZE_MEASURES:
        return False
    return head.rule == "all" or is_extensive(measure_id)


@dataclass
class EngineDataV2:
    """Hold one spec v2's resolved sample and aligned values.

    Every list is aligned with ``subject_ids``, the included subjects (after
    the population and subset filters). None is a missing cell.

    ``variables`` holds, by :func:`variable_key`, every variable the tests,
    their factors and moderators, and the strata read: level text (``str``)
    for a categorical variable, ``float`` for a numeric one. Derived
    variables arrive computed. ``covariates`` holds the shared numeric
    covariate columns in model order (age, sex, then each extra covariate,
    categorical ones already coded as indicators), then
    :data:`HEAD_SIZE_KEY` when a measure takes head size; a measure's model
    adds it only when :func:`takes_head_size` says so. ``test_covariates``
    holds each test's coded extra covariates by test ID; a subject missing
    one of them leaves only that test.
    """

    subject_ids: list[str]
    source_labels: list[str | None]
    variables: dict[str, list[str | float | None]]
    covariates: dict[str, list[float | None]]
    measures: dict[str, list[float | None]]
    test_covariates: dict[str, dict[str, list[float | None]]] = field(
        default_factory=dict
    )
    #: ``AnalysisSubjectInclusion`` rows for every candidate subject.
    subjects: list[dict[str, Any]] = field(default_factory=list)
    #: ``AnalysisSkippedMeasure`` rows the resolution added.
    skipped: list[dict[str, Any]] = field(default_factory=list)
    #: ``AnalysisInputFile`` rows with the SHA-256 of every source read.
    inputs: list[dict[str, Any]] = field(default_factory=list)
    #: True when an included subject has an unjudged registration check.
    registration_provisional: bool = False
    #: Fact sentences about the sample that no subject row carries.
    issues: list[str] = field(default_factory=list)
    #: True when an outlier rule was chosen but ``outliers.csv`` is unusable.
    outliers_unapplied: bool = False
    #: ``(subjects, parameters)`` of each measure skipped for too few subjects.
    too_small: dict[str, tuple[int, int]] = field(default_factory=dict)
    #: The snapshot facts a stored result's currency compares (``state``).
    state: dict[str, Any] = field(default_factory=dict)

    def check(self) -> None:
        """Refuse misaligned columns and infinite numbers.

        Raises
        ------
        GroupAnalysisError
            When a column's length differs from ``subject_ids`` or a number
            is infinite (NaN reads as missing, as in v1).
        """
        n = len(self.subject_ids)
        columns: list[tuple[str, list[Any]]] = [
            ("source labels", self.source_labels),
            *self.variables.items(),
            *self.covariates.items(),
            *self.measures.items(),
            *(
                item
                for values in self.test_covariates.values()
                for item in values.items()
            ),
        ]
        for name, values in columns:
            if len(values) != n:
                raise GroupAnalysisError(f"Align {name} with the included subjects.")
            for value in values:
                if isinstance(value, float) and math.isinf(value):
                    raise GroupAnalysisError(f"Remove the infinite entries in {name}.")


def sample_groups(
    spec: GroupAnalysisSpecV2, data: EngineDataV2
) -> list[dict[str, Any]]:
    """Count the included subjects of every group the spec v2 names.

    The population's kept groups, then each test's factor groups, then the
    strata, each label once (its first grouping counts it).

    Returns
    -------
    list of dict
        ``AnalysisGroupCount`` rows.
    """
    groupings: list[tuple[Any, list[str] | None]] = []
    if spec.design.population is not None:
        groupings.append(
            (spec.design.population.grouping, list(spec.design.population.groups))
        )
    groupings += [(test.factor.grouping, None) for test in spec.tests if test.factor]
    if spec.stratify is not None:
        groupings.append((spec.stratify.grouping, None))
    counts: list[dict[str, Any]] = []
    seen: set[str] = set()
    for grouping, kept in groupings:
        values = data.variables.get(variable_key(grouping.variable))
        if values is None:
            continue
        label_of = {
            level: group.label for group in grouping.groups for level in group.levels
        }
        labels = [label_of.get(level_text(value) or "") for value in values]
        for group in grouping.groups:
            if group.label in seen or (kept is not None and group.label not in kept):
                continue
            seen.add(group.label)
            counts.append(
                {"label": group.label, "n": sum(1 for x in labels if x == group.label)}
            )
    return counts


def load_engine_data(context: AnalysisContext, spec: GroupAnalysisSpecV2) -> Any:
    """Resolve a spec v2 into the engine input, refusing a blocked design.

    Reads every table and recon file without the parse cache, so the
    recorded digests describe the bytes used (``dataset_v2.resolve``), then
    runs the design check: a blocking finding stops the compute with its
    sentence, as the panel's disabled Compute does.

    Parameters
    ----------
    spec
        The validated spec v2.

    Returns
    -------
    EngineDataV2
        The aligned sample.

    Raises
    ------
    GroupAnalysisError
        When a variable cannot be read or the design check blocks.
    """
    from .dataset_v2 import resolve  # noqa: PLC0415
    from .design_check import blocking_message, check_design  # noqa: PLC0415

    resolved = resolve(context, spec, cache=False)
    message = blocking_message(check_design(context, spec, resolved))
    if message is not None:
        raise GroupAnalysisError(message)
    return resolved.data
