"""The analysis specification (spec v1), its canonical digest, and measure IDs.

The models mirror ``groupAnalysisSpecSchema`` in
``src/shared/group-analysis.ts``; keep both in lockstep. The fixture
``tests/fixtures/group_analysis/spec-v1-example.json`` binds the two
languages to one canonical form and digest.

A short example of spec v1 (SCI vs controls over three a priori measures)::

    {
      "schema": "supraspina/group-analysis-spec",
      "schemaVersion": 1,
      "analysis": "group-comparison",
      "measures": ["aseg:Brain-Stem", "dk:bi:precentral:ThickAvg",
                   "aseg:bi:Thalamus"],
      "contrast": {
        "type": "groups",
        "grouping": {
          "variable": {"source": "registry", "column": "sourceCohortLabel"},
          "groups": [{"label": "SCI", "levels": ["SCI_nNP", "SCI_P"]},
                     {"label": "CTRL", "levels": ["CTRL"]}]
        },
        "focal": "SCI", "reference": "CTRL", "model": "all-groups"
      },
      "covariates": {
        "age": {"source": "registry", "column": "age"},
        "sex": {"source": "registry", "column": "sex"},
        "etiv": "extensive", "extra": [], "centering": "sample-mean"
      },
      "inclusion": {"qc": "non-failed", "registration": "set-missing",
                    "outliers": "keep"},
      "inference": {"sidedness": "two-sided", "correction": "maxt-fwe",
                    "family": "selected", "alpha": 0.05,
                    "permutations": 5000, "seed": 20260923}
    }

Measure IDs follow one grammar (v2): ``dk:{lh|rh|bi}:{region}:{metric}`` (a
Desikan-Killiany region and an ``aparc.stats`` metric as
``dk_all_stats.csv`` spells it), ``aseg:{Structure}``, ``aseg:bi:{Structure}``
(the mean of ``Left-`` and ``Right-{Structure}``), ``global:{name}``,
``brainage:BrainPAD``, ``parc:{atlas}:{lh|rh|bi}:{region}:{metric}``, and
``vol:{atlas}:{lh|rh|bi|mid}:{structure}``. Spec v1 accepts only the v1
sources, ``global:eTIV`` and ``global:meanThickness``, and IDs of at most 96
characters.

Spec v2 (:class:`GroupAnalysisSpecV2`, ``schemaVersion`` 2) adds the design
scope, population, subset filters, derived variables, a list of tests, and
stratification; :func:`parse_spec` accepts both versions and
:func:`upgrade_v1` expresses a v1 spec as v2. The fixtures
``tests/fixtures/group_analysis/spec-v2-*.json`` bind its canonical form and
digest to ``canonicalSpecJson``.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Discriminator,
    Field,
    StringConstraints,
    Tag,
    ValidationError,
    field_validator,
    model_validator,
)

SPEC_SCHEMA = "supraspina/group-analysis-spec"
SPEC_VERSION = 1
SPEC_VERSION_V2 = 2
RESULT_SCHEMA = "supraspina/group-analysis-result"

DK_METRICS: tuple[str, ...] = (
    "ThickAvg",
    "ThickStd",
    "SurfArea",
    "GrayVol",
    "NumVert",
    "MeanCurv",
    "GausCurv",
    "FoldInd",
    "CurvInd",
)
#: The size-dependent DK metrics that take eTIV under the default rule.
EXTENSIVE_DK_METRICS = frozenset({"NumVert", "SurfArea", "GrayVol", "FoldInd"})
#: The parcellation metrics: the ``aparc.stats`` metrics and ``GWC``.
PARC_METRICS: tuple[str, ...] = (*DK_METRICS, "GWC")
#: The whole-brain measures (v2).
GLOBAL_MEASURES: tuple[str, ...] = (
    "eTIV",
    "sTIV",
    "synthsegTIV",
    "meanThickness",
    "BrainSegVol",
    "BrainSegVolNotVent",
    "CortexVol",
    "TotalGrayVol",
    "SubCortGrayVol",
    "CerebralWhiteMatterVol",
    "SupraTentorialVol",
    "SurfaceHoles",
)
#: The whole-brain measures spec v1 accepts.
GLOBAL_MEASURES_V1: tuple[str, ...] = ("eTIV", "meanThickness")
#: The whole-brain measures that never scale with head size.
INTENSIVE_GLOBALS = frozenset({"meanThickness", "SurfaceHoles"})
#: The head-size measures, never adjusted for head size.
HEAD_SIZE_MEASURES: tuple[str, ...] = ("eTIV", "sTIV", "synthsegTIV")
#: The registry fields a variable may name. ``site`` (the scanner and
#: protocol) is optional in the registry; an unset site is a missing value.
REGISTRY_VARIABLES: tuple[str, ...] = (
    "age",
    "sex",
    "cohortRole",
    "sourceCohortLabel",
    "ais",
    "tSinceSci",
    "site",
)
PERMUTATION_COUNTS: tuple[int, ...] = (0, 1000, 5000, 10000)

_MAX_MEASURES = 2000
_MAX_GROUPS = 8
_MAX_LEVELS = 64
_MAX_EXTRA_COVARIATES = 8
_MAX_SEED = 2**32 - 1
_MAX_MEASURE_ID_V1 = 96
#: The longest measure ID (spec v2).
MAX_MEASURE_ID = 160
#: The most measures one spec v2 lists.
MAX_MEASURES_V2 = 20_000
#: An atlas ID (the ``parc:`` and ``vol:`` namespaces, the cache folders).
ATLAS_ID = re.compile(r"[a-z][a-z0-9-]{1,47}")

_ATLAS_PART = r"[a-z][a-z0-9-]{1,47}"
_REGION_PART = r"[A-Za-z0-9_.&-]{1,64}"
_DK_ID = re.compile(rf"dk:(lh|rh|bi):([a-z]{{2,40}}):({'|'.join(DK_METRICS)})")
_ASEG_ID = re.compile(r"aseg:(?:(bi):)?([A-Za-z0-9][A-Za-z0-9_-]{0,63})")
_GLOBAL_ID = re.compile(rf"global:({'|'.join(GLOBAL_MEASURES)})")
_PARC_ID = re.compile(
    rf"parc:({_ATLAS_PART}):(lh|rh|bi):({_REGION_PART}):({'|'.join(PARC_METRICS)})"
)
_VOL_ID = re.compile(rf"vol:({_ATLAS_PART}):(lh|rh|bi|mid):({_REGION_PART})")
_HEMISPHERE_TOKEN = re.compile(r"Left-|Right-|lh\.|rh\.")
_PRINTABLE = r"^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$"


class GroupAnalysisError(ValueError):
    """Reject a group-analysis request with an actionable sentence."""


@dataclass(frozen=True)
class MeasureParts:
    """Hold the grammar parts of one measure ID."""

    source: Literal["dk", "aseg", "global", "brainage", "parc", "vol"]
    hemisphere: Literal["lh", "rh", "bi", "mid"] | None = None
    region: str | None = None
    metric: str | None = None
    structure: str | None = None
    name: str | None = None
    atlas: str | None = None


def parse_measure_id(value: object) -> MeasureParts | None:  # noqa: PLR0911
    """Split a measure ID into its parts.

    Returns
    -------
    MeasureParts or None
        The parts, or None when the value breaks the grammar.
    """
    if not isinstance(value, str) or len(value) > MAX_MEASURE_ID:
        return None
    if match := _DK_ID.fullmatch(value):
        return MeasureParts(
            source="dk",
            hemisphere=match.group(1),
            region=match.group(2),
            metric=match.group(3),
        )
    if match := _ASEG_ID.fullmatch(value):
        bilateral = match.group(1) == "bi"
        structure = match.group(2)
        if structure == "bi" or (
            bilateral and structure.startswith(("Left-", "Right-"))
        ):
            return None
        return MeasureParts(
            source="aseg", hemisphere="bi" if bilateral else None, structure=structure
        )
    if match := _GLOBAL_ID.fullmatch(value):
        return MeasureParts(source="global", name=match.group(1))
    if value == "brainage:BrainPAD":
        return MeasureParts(source="brainage", name="BrainPAD")
    if match := _PARC_ID.fullmatch(value):
        if match.group(1) == "dk" or _HEMISPHERE_TOKEN.match(match.group(3)):
            return None
        return MeasureParts(
            source="parc",
            atlas=match.group(1),
            hemisphere=match.group(2),
            region=match.group(3),
            metric=match.group(4),
        )
    if match := _VOL_ID.fullmatch(value):
        if match.group(1) == "aseg" or _HEMISPHERE_TOKEN.match(match.group(3)):
            return None
        return MeasureParts(
            source="vol",
            atlas=match.group(1),
            hemisphere=match.group(2),
            structure=match.group(3),
        )
    return None


def is_measure_id_v1(value: object) -> bool:
    """Say whether a measure ID is one spec v1 accepts.

    Returns
    -------
    bool
        True for a v1 source and whole-brain measure, at most 96 characters.
    """
    if not isinstance(value, str) or len(value) > _MAX_MEASURE_ID_V1:
        return False
    parts = parse_measure_id(value)
    if parts is None or parts.source in {"parc", "vol"}:
        return False
    return parts.source != "global" or parts.name in GLOBAL_MEASURES_V1


def _parts(measure_id: str) -> MeasureParts:
    parts = parse_measure_id(measure_id)
    if parts is None:
        raise GroupAnalysisError("Use valid measure IDs.")
    return parts


def measure_family(measure_id: str) -> str:
    """Name the correction family of a measure.

    One family per DK metric, per parcellation atlas and metric, and per
    volume atlas, and one each for aseg volumes, global measures, and brain
    age (``measureFamily``).

    Parameters
    ----------
    measure_id
        A valid measure ID.

    Returns
    -------
    str
        The family key, for example ``dk:ThickAvg``, ``parc:a2009s:GrayVol``,
        ``vol:brainstem-ss``, or ``aseg``.
    """
    parts = _parts(measure_id)
    if parts.source == "dk":
        return f"dk:{parts.metric}"
    if parts.source == "parc":
        return f"parc:{parts.atlas}:{parts.metric}"
    if parts.source == "vol":
        return f"vol:{parts.atlas}"
    return parts.source


def is_extensive(measure_id: str) -> bool:
    """Say whether a measure scales with head size.

    DK and parcellation
    area, gray-matter volume, vertex count, and folding index, every aseg and
    labeled volume, and the whole-brain volumes (head size itself included,
    never adjusted for itself) are extensive; mean thickness, the surface-hole
    count, and Brain-PAD are not.

    Parameters
    ----------
    measure_id
        A valid measure ID.
    """
    parts = _parts(measure_id)
    if parts.source in {"dk", "parc"}:
        return parts.metric in EXTENSIVE_DK_METRICS
    if parts.source in {"aseg", "vol"}:
        return True
    return parts.source == "global" and parts.name not in INTENSIVE_GLOBALS


#: How atlases spell the hemisphere in label names (``HEMISPHERE_TOKEN_RULES``).
HEMISPHERE_TOKEN_RULES: tuple[str, ...] = (
    "left-right-prefix",
    "lh-rh-dot-prefix",
    "lh-rh-hyphen-infix",
    "lh-rh-underscore-infix",
    "l-r-underscore-suffix",
    "none",
)
_TOKEN_PATTERNS: dict[str, re.Pattern[str]] = {
    "left-right-prefix": re.compile(r"(Left|Right)-(.+)"),
    "lh-rh-dot-prefix": re.compile(r"(lh|rh)\.(.+)"),
    "lh-rh-hyphen-infix": re.compile(r"([^-]+)-(lh|rh)-(.+)"),
    "lh-rh-underscore-infix": re.compile(r"([^_]+)_(LH|RH)_(.+)"),
    "l-r-underscore-suffix": re.compile(r"(.+)_(L|R)"),
}


def split_hemisphere_token(rule: str, name: str) -> tuple[str | None, str]:
    """Split one label name by an atlas's hemisphere-token rule.

    Parameters
    ----------
    rule
        One of :data:`HEMISPHERE_TOKEN_RULES`.
    name
        The label name as the atlas spells it.

    Returns
    -------
    tuple of (str or None, str)
        ``lh``, ``rh``, or None for an unpaired label, and the structure
        without the token (``splitHemisphereToken``).
    """
    pattern = _TOKEN_PATTERNS.get(rule)
    match = pattern.fullmatch(name) if pattern is not None else None
    if match is None:
        return None, name
    if rule == "left-right-prefix":
        return ("lh" if match.group(1) == "Left" else "rh"), match.group(2)
    if rule == "lh-rh-dot-prefix":
        return match.group(1), match.group(2)
    if rule == "lh-rh-hyphen-infix":
        return match.group(2), f"{match.group(1)}-{match.group(3)}"
    if rule == "lh-rh-underscore-infix":
        hemisphere = "lh" if match.group(2) == "LH" else "rh"
        return hemisphere, f"{match.group(1)}_{match.group(3)}"
    return ("lh" if match.group(2) == "L" else "rh"), match.group(1)


def join_hemisphere_token(rule: str, hemisphere: str, structure: str) -> str:
    """Spell one hemisphere's label name, the inverse of the split.

    Parameters
    ----------
    rule
        One of :data:`HEMISPHERE_TOKEN_RULES`.
    hemisphere
        ``lh`` or ``rh``.
    structure
        The structure without the token.

    Returns
    -------
    str
        The label name as the atlas spells it (``joinHemisphereToken``).
    """
    left = hemisphere == "lh"
    if rule == "left-right-prefix":
        return f"{'Left' if left else 'Right'}-{structure}"
    if rule == "lh-rh-dot-prefix":
        return f"{hemisphere}.{structure}"
    if rule == "lh-rh-hyphen-infix":
        head, sep, tail = structure.partition("-")
        return f"{head}-{hemisphere}-{tail}" if sep else f"{hemisphere}-{structure}"
    if rule == "lh-rh-underscore-infix":
        token = "LH" if left else "RH"
        head, sep, tail = structure.partition("_")
        return f"{head}_{token}_{tail}" if sep else f"{token}_{structure}"
    if rule == "l-r-underscore-suffix":
        return f"{structure}_{'L' if left else 'R'}"
    return structure


Label = Annotated[
    str, StringConstraints(min_length=1, max_length=64, pattern=_PRINTABLE)
]
Column = Annotated[
    str, StringConstraints(min_length=1, max_length=128, pattern=_PRINTABLE)
]


class _Strict(BaseModel):
    """Forbid unknown keys and coercion, as the zod schema does."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class VariableRef(_Strict):
    """Name one registry field or metadata CSV column."""

    source: Literal["registry", "age-csv", "clinical-csv", "metadata-csv"]
    column: Column

    @model_validator(mode="after")
    def _registry_field(self) -> VariableRef:
        if self.source == "registry" and self.column not in REGISTRY_VARIABLES:
            raise ValueError("Choose a registry field the analysis can use.")
        return self


class GroupDefinition(_Strict):
    """Merge variable levels into one labeled group."""

    label: Label
    levels: list[Column] = Field(min_length=1, max_length=_MAX_LEVELS)


class GroupingSpec(_Strict):
    """Define the grouping variable and its groups."""

    variable: VariableRef
    groups: list[GroupDefinition] = Field(min_length=1, max_length=_MAX_GROUPS)


class GroupContrast(_Strict):
    """Test focal minus reference."""

    type: Literal["groups"]
    grouping: GroupingSpec
    focal: Label
    reference: Label
    model: Literal["all-groups", "compared-groups"]


class AssociationContrast(_Strict):
    """Test the slope of one numeric variable."""

    type: Literal["association"]
    variable: VariableRef
    grouping: GroupingSpec | None
    includedGroups: list[Label] = Field(max_length=_MAX_GROUPS)
    adjustForGroup: bool


class CovariateSpec(_Strict):
    """List the model covariates."""

    age: VariableRef | None
    sex: VariableRef | None
    etiv: Literal["extensive", "all", "none"]
    extra: list[VariableRef] = Field(max_length=_MAX_EXTRA_COVARIATES)
    centering: Literal["sample-mean"]


class InclusionSpec(_Strict):
    """Choose the QC, registration-flag, and outlier inclusion rules."""

    qc: Literal["non-failed", "passed", "all"]
    registration: Literal["set-missing", "exclude-subject", "keep"]
    outliers: Literal["keep", "set-missing", "exclude-subject"]


class InferenceSpec(_Strict):
    """Choose sidedness, correction, family, alpha, permutations, and seed."""

    sidedness: Literal["two-sided", "lower", "higher"]
    correction: Literal["maxt-fwe", "holm", "bonferroni", "bh-fdr", "none"]
    family: Literal["selected", "per-family"]
    alpha: float = Field(ge=0.001, le=0.2, allow_inf_nan=False)
    permutations: Literal[0, 1000, 5000, 10000]
    seed: int = Field(ge=0, le=_MAX_SEED)


class GroupAnalysisSpec(_Strict):
    """Hold one complete, self-contained analysis specification (spec v1)."""

    schema_id: Literal["supraspina/group-analysis-spec"] = Field(alias="schema")
    schemaVersion: Literal[1]
    analysis: Literal["group-comparison", "association", "brain-age"]
    measures: list[str] = Field(min_length=1, max_length=_MAX_MEASURES)
    contrast: GroupContrast | AssociationContrast = Field(discriminator="type")
    covariates: CovariateSpec
    inclusion: InclusionSpec
    inference: InferenceSpec

    @field_validator("measures")
    @classmethod
    def _measure_grammar(cls, value: list[str]) -> list[str]:
        if not all(is_measure_id_v1(item) for item in value):
            raise ValueError("Use valid measure IDs.")
        return value

    @model_validator(mode="after")
    def _cross_field(self) -> GroupAnalysisSpec:
        issues = spec_issues(self)
        if issues:
            raise ValueError(issues[0])
        return self


def _ref_key(ref: VariableRef) -> tuple[str, str]:
    return (ref.source, ref.column)


def spec_issues(spec: GroupAnalysisSpec) -> list[str]:  # noqa: PLR0912
    """List the cross-field problems in the order the zod schema reports them.

    Parameters
    ----------
    spec
        A structurally valid specification.

    Returns
    -------
    list of str
        One actionable sentence per problem.
    """
    issues: list[str] = []
    measures = spec.measures
    if len(set(measures)) != len(measures):
        issues.append("List each measure once.")
    contrast = spec.contrast
    if (spec.analysis == "association") != (contrast.type == "association"):
        issues.append("Match the contrast to the analysis type.")
    if spec.analysis == "brain-age" and measures != ["brainage:BrainPAD"]:
        issues.append("Use Brain-PAD as the only brain-age measure.")
    grouping = contrast.grouping
    if grouping is not None:
        labels = [group.label for group in grouping.groups]
        if len(set(labels)) != len(labels):
            issues.append("Give each group a different label.")
        levels = [level for group in grouping.groups for level in group.levels]
        if len(set(levels)) != len(levels):
            issues.append("Assign each level to one group only.")
        if isinstance(contrast, GroupContrast):
            if len(grouping.groups) < 2:  # noqa: PLR2004
                issues.append("Define at least two groups to compare.")
            if contrast.focal not in labels:
                issues.append("Choose a defined group as the focal group.")
            if contrast.reference not in labels:
                issues.append("Choose a defined group as the reference group.")
            if contrast.focal == contrast.reference:
                issues.append("Choose two different groups to compare.")
        else:
            included = contrast.includedGroups
            if len(set(included)) != len(included):
                issues.append("Include each group once.")
            if not included or any(label not in labels for label in included):
                issues.append("Include one or more defined groups.")
    if isinstance(contrast, AssociationContrast):
        if grouping is None and contrast.includedGroups:
            issues.append("Define the grouping before including groups.")
        if contrast.adjustForGroup and len(contrast.includedGroups) < 2:  # noqa: PLR2004
            issues.append("Include two or more groups to adjust for group.")
    covariates = [
        _ref_key(ref)
        for ref in (spec.covariates.age, spec.covariates.sex, *spec.covariates.extra)
        if ref is not None
    ]
    if len(set(covariates)) != len(covariates):
        issues.append("Add each covariate once.")
    tested = (
        contrast.variable
        if isinstance(contrast, AssociationContrast)
        else contrast.grouping.variable
    )
    if _ref_key(tested) in covariates:
        issues.append("Do not adjust for the tested variable.")
    if spec.inference.correction == "maxt-fwe" and spec.inference.permutations == 0:
        issues.append("Choose a permutation count for max-T correction.")
    return issues


def parse_spec(value: Any) -> GroupAnalysisSpec | GroupAnalysisSpecV2:
    """Validate a specification of either version at a trust boundary.

    ``schemaVersion`` 2 selects spec v2; anything else is validated as v1.

    Parameters
    ----------
    value
        The untrusted JSON value.

    Raises
    ------
    GroupAnalysisError
        With the first problem as one actionable sentence.
    """
    model: type[GroupAnalysisSpec] | type[GroupAnalysisSpecV2] = (
        GroupAnalysisSpecV2
        if isinstance(value, dict) and value.get("schemaVersion") == SPEC_VERSION_V2
        else GroupAnalysisSpec
    )
    try:
        return model.model_validate(value)
    except ValidationError as exc:
        first = exc.errors(include_url=False)[0]
        error = (first.get("ctx") or {}).get("error")
        if first["type"] == "value_error" and error is not None:
            raise GroupAnalysisError(str(error)) from None
        location = ".".join(str(part) for part in first["loc"]) or "root"
        raise GroupAnalysisError(f"Correct the analysis field {location}.") from None


def canonical_spec_json(spec: GroupAnalysisSpec | GroupAnalysisSpecV2) -> str:
    """Serialize a specification canonically.

    Measures, group levels, and included groups are sorted, object keys are
    sorted, and no whitespace is written, matching ``canonicalSpecJson``. A
    spec v2 follows :func:`canonical_spec_v2_json`.

    Parameters
    ----------
    spec
        A validated specification of either version.
    """
    if isinstance(spec, GroupAnalysisSpecV2):
        return canonical_spec_v2_json(spec)
    data = spec.model_dump(mode="json", by_alias=True)
    data["measures"] = sorted(data["measures"])
    contrast = data["contrast"]
    grouping = contrast.get("grouping")
    if grouping is not None:
        for group in grouping["groups"]:
            group["levels"] = sorted(group["levels"])
    if contrast["type"] == "association":
        contrast["includedGroups"] = sorted(contrast["includedGroups"])
    return json.dumps(
        data,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def spec_digest(spec: GroupAnalysisSpec | GroupAnalysisSpecV2) -> str:
    """Return the SHA-256 of the canonical JSON, the specification's identity.

    Parameters
    ----------
    spec
        A validated specification.

    Returns
    -------
    str
        The lowercase hexadecimal digest.
    """
    return hashlib.sha256(canonical_spec_json(spec).encode("utf-8")).hexdigest()


# -- Spec v2 -------------------------------------------------------------------

#: The IDs of imported variable tables.
VARIABLE_TABLE_ID = r"^var-[a-f0-9]{16}$"
#: The IDs of derived variables.
DERIVED_VARIABLE_ID = r"^dv-[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$"
#: The IDs of the tests in one specification.
ANALYSIS_TEST_ID = r"^[a-z][a-z0-9-]{0,31}$"

_MAX_SUBSET_FILTERS = 8
_MAX_DERIVED = 16
_MAX_DERIVED_INPUTS = 8
_MAX_BIN_CUTS = 16
_MAX_TESTS = 16
_MAX_TEST_COVARIATES = 4
_DERIVED_ARITY = {
    "sum": (2, _MAX_DERIVED_INPUTS),
    "difference": (2, 2),
    "log1p": (1, 1),
    "bins": (1, 1),
}


class ImportedRef(_Strict):
    """Name one column of an imported variables table."""

    source: Literal["imported"]
    table: Annotated[str, StringConstraints(pattern=VARIABLE_TABLE_ID)]
    column: Column


class DerivedRef(_Strict):
    """Name one derived variable."""

    source: Literal["derived"]
    column: Annotated[str, StringConstraints(pattern=DERIVED_VARIABLE_ID)]


class MeasureRef(_Strict):
    """Use one measure as a variable, for example as a covariate."""

    source: Literal["measure"]
    column: Annotated[str, StringConstraints(max_length=MAX_MEASURE_ID)]

    @field_validator("column")
    @classmethod
    def _measure_grammar(cls, value: str) -> str:
        if parse_measure_id(value) is None:
            raise ValueError("Use valid measure IDs.")
        return value


def _ref_tag(value: Any) -> str:
    source = (
        value.get("source")
        if isinstance(value, dict)
        else getattr(value, "source", None)
    )
    return source if source in {"imported", "derived", "measure"} else "column"


#: One variable in spec v2 (``VariableRefV2``).
VariableRefV2 = Annotated[
    Annotated[VariableRef, Tag("column")]
    | Annotated[ImportedRef, Tag("imported")]
    | Annotated[DerivedRef, Tag("derived")]
    | Annotated[MeasureRef, Tag("measure")],
    Discriminator(_ref_tag),
]


class GroupingSpecV2(_Strict):
    """Define groups from one spec v2 variable's levels."""

    variable: VariableRefV2
    groups: list[GroupDefinition] = Field(min_length=1, max_length=_MAX_GROUPS)


class PopulationSpec(_Strict):
    """Name the population a within-group design tests inside."""

    grouping: GroupingSpecV2
    groups: list[Label] = Field(max_length=_MAX_GROUPS)


class LevelKeep(_Strict):
    """Keep the listed levels of a categorical variable."""

    levels: list[Column] = Field(min_length=1, max_length=_MAX_LEVELS)


class RangeKeep(_Strict):
    """Keep a numeric range; a null bound is open."""

    min: Annotated[float, Field(allow_inf_nan=False)] | None
    max: Annotated[float, Field(allow_inf_nan=False)] | None


class SubsetFilter(_Strict):
    """Keep the rows one filter selects."""

    variable: VariableRefV2
    keep: LevelKeep | RangeKeep


class DesignSpec(_Strict):
    """Hold the design scope, population, and subset filters."""

    scope: Literal["between", "within"]
    population: PopulationSpec | None
    subset: list[SubsetFilter] = Field(max_length=_MAX_SUBSET_FILTERS)


class DerivedParams(_Strict):
    """Hold the bin cut points and labels (empty unless the op is bins)."""

    cuts: list[Annotated[float, Field(allow_inf_nan=False)]] = Field(
        max_length=_MAX_BIN_CUTS
    )
    labels: list[Label] = Field(max_length=_MAX_BIN_CUTS + 1)


class DerivedVariable(_Strict):
    """Compute one variable from others (``DerivedVariable``)."""

    id: Annotated[str, StringConstraints(pattern=DERIVED_VARIABLE_ID)]
    label: Label
    op: Literal["sum", "difference", "log1p", "bins"]
    inputs: list[VariableRefV2] = Field(min_length=1, max_length=_MAX_DERIVED_INPUTS)
    params: DerivedParams


class VariablesSpec(_Strict):
    """List the derived variables."""

    derived: list[DerivedVariable] = Field(max_length=_MAX_DERIVED)


class TestFactor(_Strict):
    """Hold a test's grouping factor."""

    grouping: GroupingSpecV2
    focal: Label | None
    reference: Label
    model: Literal["all-groups", "compared-groups"]


class TestVariable(_Strict):
    """Hold a tested or moderating variable with its transform."""

    ref: VariableRefV2
    transform: Literal["none", "log1p", "standardize"]


class AnalysisTest(_Strict):
    """Hold one test (``AnalysisTest``)."""

    id: Annotated[str, StringConstraints(pattern=ANALYSIS_TEST_ID)]
    label: Label
    kind: Literal["two-group", "omnibus", "association", "interaction"]
    factor: TestFactor | None
    pairwise: Literal["all-pairs", "versus-reference", "none"]
    pairwiseFamily: Literal["pooled", "per-pair"]
    variable: TestVariable | None
    moderator: TestVariable | None
    adjustForGroup: bool
    inFamily: bool
    extraCovariates: list[VariableRefV2] = Field(max_length=_MAX_TEST_COVARIATES)


class StratifySpec(_Strict):
    """Rerun every test per stratum."""

    grouping: GroupingSpecV2
    heterogeneity: bool


class HeadSizeSpec(_Strict):
    """Choose the head-size covariate and the measures that take it."""

    source: Literal["etiv", "stiv", "synthseg-tiv", "none"]
    rule: Literal["extensive", "all"]


class CovariateSpecV2(_Strict):
    """List the model covariates (spec v2)."""

    age: VariableRefV2 | None
    sex: VariableRefV2 | None
    headSize: HeadSizeSpec
    extra: list[VariableRefV2] = Field(max_length=_MAX_EXTRA_COVARIATES)
    centering: Literal["sample-mean"]


class InclusionSpecV2(_Strict):
    """Choose the inclusion rules and the smallest cell (spec v2)."""

    qc: Literal["non-failed", "passed", "all"]
    registration: Literal["set-missing", "exclude-subject", "keep"]
    outliers: Literal["keep", "set-missing", "exclude-subject"]
    minCellN: int = Field(ge=2, le=20)


class InferenceSpecV2(_Strict):
    """Choose the inference settings (spec v2)."""

    sidedness: Literal["two-sided", "lower", "higher"]
    correction: Literal["maxt-fwe", "holm", "bonferroni", "bh-fdr", "none"]
    family: Literal[
        "all-tests", "per-test", "per-measure-family", "per-test-and-measure-family"
    ]
    omnibusGate: bool
    alpha: float = Field(ge=0.001, le=0.2, allow_inf_nan=False)
    permutations: Literal[0, 1000, 5000, 10000]
    seed: int = Field(ge=0, le=_MAX_SEED)


class GroupAnalysisSpecV2(_Strict):
    """Hold one complete analysis specification (spec v2)."""

    schema_id: Literal["supraspina/group-analysis-spec"] = Field(alias="schema")
    schemaVersion: Literal[2]
    design: DesignSpec
    variables: VariablesSpec
    tests: list[AnalysisTest] = Field(min_length=1, max_length=_MAX_TESTS)
    stratify: StratifySpec | None
    measures: list[str] = Field(min_length=1, max_length=MAX_MEASURES_V2)
    covariates: CovariateSpecV2
    inclusion: InclusionSpecV2
    inference: InferenceSpecV2

    @field_validator("measures")
    @classmethod
    def _measure_grammar(cls, value: list[str]) -> list[str]:
        if any(parse_measure_id(item) is None for item in value):
            raise ValueError("Use valid measure IDs.")
        return value

    @model_validator(mode="after")
    def _cross_field(self) -> GroupAnalysisSpecV2:
        issues = spec_issues_v2(self)
        if issues:
            raise ValueError(issues[0])
        return self


#: Any stored or accepted specification.
AnySpec = GroupAnalysisSpec | GroupAnalysisSpecV2


def _ref_key_v2(ref: Any) -> tuple[str, ...]:
    if ref.source == "imported":
        return ("imported", ref.table, ref.column)
    return (ref.source, ref.column)


def _grouping_issues(grouping: GroupingSpecV2, issues: list[str]) -> list[str]:
    labels = [group.label for group in grouping.groups]
    if len(set(labels)) != len(labels):
        issues.append("Give each group a different label.")
    levels = [level for group in grouping.groups for level in group.levels]
    if len(set(levels)) != len(levels):
        issues.append("Assign each level to one group only.")
    return labels


def effect_rank(test: AnalysisTest, moderator_levels: int | None = None) -> int:
    """Give the rank of a test's main term as the engine fits it (``testRank``).

    k - 1 for an omnibus test over k groups; for a slope difference
    (k - 1)(m - 1) with a categorical moderator of m levels, else k - 1. The
    spec alone does not know a moderator's levels, so the spec rules pass
    None and get the smallest rank the test can have; the design check
    passes the sample's level count.

    Parameters
    ----------
    moderator_levels
        A categorical moderator's level count, or None for a numeric or
        unknown moderator.

    Returns
    -------
    int
        The rank; above 1 the term is an F test.
    """
    groups = len(test.factor.grouping.groups) if test.factor is not None else 2
    if test.kind == "omnibus":
        return max(1, groups - 1)
    if test.kind == "interaction":
        width = 1 if moderator_levels is None else moderator_levels - 1
        return max(1, (groups - 1) * width)
    return 1


def pools_in_all_tests(test: AnalysisTest) -> bool:
    """Say whether a test's effect term joins the pooled all-tests family.

    An interaction forms its own family and a test outside the family has
    none (``poolsInAllTests``).
    """
    return test.inFamily and test.kind != "interaction"


def spec_issues_v2(spec: GroupAnalysisSpecV2) -> list[str]:  # noqa: PLR0912, PLR0915
    """List the cross-field problems in the order ``specIssuesV2`` reports them.

    Parameters
    ----------
    spec
        A structurally valid spec v2.

    Returns
    -------
    list of str
        One actionable sentence per problem.
    """
    issues: list[str] = []
    design, tests = spec.design, spec.tests
    if len(set(spec.measures)) != len(spec.measures):
        issues.append("List each measure once.")
    if design.scope == "within" and design.population is None:
        issues.append("Choose the population for a within-group design.")
    if design.scope == "between" and design.population is not None:
        issues.append("Leave the population empty for a between-groups design.")
    if design.population is not None:
        labels = _grouping_issues(design.population.grouping, issues)
        kept = design.population.groups
        if (
            not kept
            or len(set(kept)) != len(kept)
            or any(label not in labels for label in kept)
        ):
            issues.append(
                "Keep one or more defined groups in the population, each once."
            )
    filtered = [_ref_key_v2(item.variable) for item in design.subset]
    if len(set(filtered)) != len(filtered):
        issues.append("Filter each variable once.")
    for item in design.subset:
        if isinstance(item.keep, RangeKeep):
            low, high = item.keep.min, item.keep.max
            if low is None and high is None:
                issues.append("Give each numeric subset filter a minimum or a maximum.")
            elif low is not None and high is not None and low > high:
                issues.append(
                    "Give each subset filter a minimum no larger than its maximum."
                )
    derived_ids = [item.id for item in spec.variables.derived]
    if len(set(derived_ids)) != len(derived_ids):
        issues.append("Give each derived variable a different ID.")
    for index, item in enumerate(spec.variables.derived):
        low, high = _DERIVED_ARITY[item.op]
        if not low <= len(item.inputs) <= high:
            issues.append("Give each derived variable the inputs its operation takes.")
        earlier = set(derived_ids[:index])
        if any(
            ref.source == "derived" and ref.column not in earlier for ref in item.inputs
        ):
            issues.append("Refer only to derived variables listed before this one.")
        cuts, bin_labels = item.params.cuts, item.params.labels
        if item.op == "bins":
            if not cuts or any(
                cut <= cuts[position - 1]
                for position, cut in enumerate(cuts)
                if position > 0
            ):
                issues.append("Give the bin cut points in increasing order.")
            if bin_labels and len(bin_labels) != len(cuts) + 1:
                issues.append("Label every bin or none.")
        elif cuts or bin_labels:
            issues.append("Set cut points and labels only for bins.")
    used: list[Any] = [
        *([design.population.grouping.variable] if design.population else []),
        *(item.variable for item in design.subset),
        *([spec.stratify.grouping.variable] if spec.stratify else []),
        *(ref for ref in (spec.covariates.age, spec.covariates.sex) if ref is not None),
        *spec.covariates.extra,
    ]
    for test in tests:
        used += [
            *([test.factor.grouping.variable] if test.factor else []),
            *([test.variable.ref] if test.variable else []),
            *([test.moderator.ref] if test.moderator else []),
            *test.extraCovariates,
        ]
    if any(ref.source == "derived" and ref.column not in derived_ids for ref in used):
        issues.append("Define every derived variable the analysis uses.")
    test_ids = [test.id for test in tests]
    if len(set(test_ids)) != len(test_ids):
        issues.append("Give each test a different ID.")
    covariates = [
        _ref_key_v2(ref)
        for ref in (spec.covariates.age, spec.covariates.sex, *spec.covariates.extra)
        if ref is not None
    ]
    for test in tests:
        factor = test.factor
        grouped = test.kind != "association" or test.adjustForGroup
        if grouped and factor is None:
            issues.append("Choose the grouping of each group test.")
        if not grouped and factor is not None:
            issues.append(
                "Choose a grouping for an association test only to adjust for group."
            )
        if factor is not None:
            labels = _grouping_issues(factor.grouping, issues)
            groups = len(factor.grouping.groups)
            if factor.reference not in labels:
                issues.append("Choose a defined group as the reference group.")
            if test.kind == "two-group":
                if factor.focal is None:
                    issues.append("Choose a focal group for each two-group test.")
                elif factor.focal not in labels:
                    issues.append("Choose a defined group as the focal group.")
                elif factor.focal == factor.reference:
                    issues.append("Choose two different groups to compare.")
            elif factor.focal is not None:
                issues.append("Choose a focal group only for a two-group test.")
            if test.kind == "omnibus" and groups < 3:  # noqa: PLR2004
                issues.append("Define three or more groups for an omnibus test.")
            elif groups < 2:  # noqa: PLR2004
                issues.append("Define at least two groups to compare.")
        if test.kind != "omnibus" and test.pairwise != "none":
            issues.append("Choose pairwise comparisons only for an omnibus test.")
        if (test.kind == "association") != (test.variable is not None):
            issues.append("Choose a tested variable for each association test only.")
        if (test.kind == "interaction") != (test.moderator is not None):
            issues.append("Choose a moderator for each slope-difference test only.")
        if test.adjustForGroup and test.kind != "association":
            issues.append("Adjust for group only in an association test.")
        extra = [_ref_key_v2(ref) for ref in test.extraCovariates]
        if len(set(extra)) != len(extra) or any(key in covariates for key in extra):
            issues.append("Add each covariate once.")
        tested = [
            _ref_key_v2(ref)
            for ref in (
                factor.grouping.variable if factor else None,
                test.variable.ref if test.variable else None,
                test.moderator.ref if test.moderator else None,
            )
            if ref is not None
        ]
        if any(key in covariates or key in extra for key in tested):
            issues.append("Do not adjust for the tested variable.")
    if tests and not any(test.inFamily for test in tests):
        issues.append("Keep one or more tests in the correction family.")
    if spec.stratify is not None:
        _grouping_issues(spec.stratify.grouping, issues)
        if len(spec.stratify.grouping.groups) < 2:  # noqa: PLR2004
            issues.append("Define two or more strata.")
    if len(set(covariates)) != len(covariates):
        issues.append("Add each covariate once.")
    inference = spec.inference
    if inference.correction == "maxt-fwe" and inference.permutations == 0:
        issues.append("Choose a permutation count for max-T correction.")
    if inference.sidedness != "two-sided" and any(
        effect_rank(test) > 1 for test in tests
    ):
        issues.append("Choose a two-sided test: an F test has no direction.")
    pooled = {effect_rank(test) for test in tests if pools_in_all_tests(test)}
    if (
        inference.correction == "maxt-fwe"
        and inference.family == "all-tests"
        and len(pooled) > 1
    ):
        issues.append(
            "Correct each test separately, or choose Holm, Bonferroni, or BH-FDR "
            "to correct t and F tests together."
        )
    return issues


def upgrade_v1(spec: GroupAnalysisSpec) -> GroupAnalysisSpecV2:
    """Express a spec v1 as spec v2 (``upgradeGroupAnalysisSpecV1``).

    A group comparison or brain-age analysis becomes one two-group test
    ``t1``; an association becomes one association test ``t1`` whose included
    groups become a subset filter (and, with ``adjustForGroup``, a factor of
    the included groups with the first as reference). eTIV becomes head size
    ``etiv`` with the same rule (``none`` keeps ``extensive``), family
    ``selected`` becomes ``all-tests`` and ``per-family`` becomes
    ``per-measure-family``, and the smallest cell is 2, so no analysis v1
    computed is blocked. The upgraded spec has its own digest; a stored v1
    result keeps its v1 spec and digest.

    Parameters
    ----------
    spec
        A valid spec v1.

    Returns
    -------
    GroupAnalysisSpecV2
        The equivalent spec v2.
    """
    data = spec.model_dump(mode="json", by_alias=True)
    contrast = data["contrast"]
    base = {
        "pairwise": "none",
        "pairwiseFamily": "pooled",
        "moderator": None,
        "adjustForGroup": False,
        "inFamily": True,
        "extraCovariates": [],
    }
    subset: list[dict[str, Any]] = []
    if contrast["type"] == "groups":
        test = {
            **base,
            "id": "t1",
            "label": f"{contrast['focal']} vs {contrast['reference']}"[:64].strip(),
            "kind": "two-group",
            "factor": {
                "grouping": contrast["grouping"],
                "focal": contrast["focal"],
                "reference": contrast["reference"],
                "model": contrast["model"],
            },
            "variable": None,
        }
    else:
        grouping = contrast["grouping"]
        included = (
            [
                group
                for group in grouping["groups"]
                if group["label"] in contrast["includedGroups"]
            ]
            if grouping is not None
            else []
        )
        if grouping is not None:
            subset.append(
                {
                    "variable": grouping["variable"],
                    "keep": {
                        "levels": [
                            level for group in included for level in group["levels"]
                        ]
                    },
                }
            )
        factor = (
            {
                "grouping": {"variable": grouping["variable"], "groups": included},
                "focal": None,
                "reference": included[0]["label"],
                "model": "all-groups",
            }
            if grouping is not None and contrast["adjustForGroup"]
            else None
        )
        test = {
            **base,
            "id": "t1",
            "label": f"Association with {contrast['variable']['column']}"[:64].strip(),
            "kind": "association",
            "factor": factor,
            "variable": {"ref": contrast["variable"], "transform": "none"},
            "adjustForGroup": contrast["adjustForGroup"],
        }
    covariates = data["covariates"]
    inference = data["inference"]
    upgraded = {
        "schema": SPEC_SCHEMA,
        "schemaVersion": SPEC_VERSION_V2,
        "design": {"scope": "between", "population": None, "subset": subset},
        "variables": {"derived": []},
        "tests": [test],
        "stratify": None,
        "measures": data["measures"],
        "covariates": {
            "age": covariates["age"],
            "sex": covariates["sex"],
            "headSize": {
                "source": "none" if covariates["etiv"] == "none" else "etiv",
                "rule": "all" if covariates["etiv"] == "all" else "extensive",
            },
            "extra": covariates["extra"],
            "centering": "sample-mean",
        },
        "inclusion": {**data["inclusion"], "minCellN": 2},
        "inference": {
            "sidedness": inference["sidedness"],
            "correction": inference["correction"],
            "family": (
                "all-tests"
                if inference["family"] == "selected"
                else "per-measure-family"
            ),
            "omnibusGate": False,
            "alpha": inference["alpha"],
            "permutations": inference["permutations"],
            "seed": inference["seed"],
        },
    }
    return GroupAnalysisSpecV2.model_validate(upgraded)


def _js_number(value: float) -> str:
    """Format a float as ECMAScript ``Number.prototype.toString`` does."""
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < 1e21:  # noqa: PLR2004
        return str(int(value))
    sign = "-" if value < 0 else ""
    digits_tuple = Decimal(repr(abs(value))).as_tuple()
    digits = "".join(str(digit) for digit in digits_tuple.digits).rstrip("0") or "0"
    exponent = int(digits_tuple.exponent) + (len(digits_tuple.digits) - len(digits))
    k = len(digits)
    n = exponent + k
    if k <= n <= 21:  # noqa: PLR2004
        text = digits + "0" * (n - k)
    elif 0 < n <= 21:  # noqa: PLR2004
        text = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:  # noqa: PLR2004
        text = "0." + "0" * (-n) + digits
    else:
        mantissa = digits[0] + (f".{digits[1:]}" if k > 1 else "")
        power = n - 1
        text = f"{mantissa}e{'+' if power >= 0 else '-'}{abs(power)}"
    return sign + text


def _canonical_text(value: Any) -> str:  # noqa: PLR0911
    """Serialize a JSON value as ``JSON.stringify`` of key-sorted data would."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(_canonical_text(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(
                f"{json.dumps(key, ensure_ascii=False)}:{_canonical_text(value[key])}"
                for key in sorted(value)
            )
            + "}"
        )
    raise TypeError(f"Unsupported canonical JSON value: {type(value).__name__}")


def _sort_grouping(grouping: dict[str, Any]) -> None:
    for group in grouping["groups"]:
        group["levels"] = sorted(group["levels"])


def canonical_spec_v2_json(spec: GroupAnalysisSpecV2) -> str:
    """Serialize a spec v2 canonically (``canonicalSpecV2Json``).

    Measures, group levels, population groups, and subset levels are sorted;
    tests, derived variables, groups, and covariates keep their order; object
    keys are sorted; numbers follow the ECMAScript form; no whitespace.

    Parameters
    ----------
    spec
        A validated spec v2.
    """
    data = spec.model_dump(mode="json", by_alias=True)
    data["measures"] = sorted(data["measures"])
    population = data["design"]["population"]
    if population is not None:
        _sort_grouping(population["grouping"])
        population["groups"] = sorted(population["groups"])
    for item in data["design"]["subset"]:
        if "levels" in item["keep"]:
            item["keep"]["levels"] = sorted(item["keep"]["levels"])
    for test in data["tests"]:
        if test["factor"] is not None:
            _sort_grouping(test["factor"]["grouping"])
    if data["stratify"] is not None:
        _sort_grouping(data["stratify"]["grouping"])
    return _canonical_text(data)
