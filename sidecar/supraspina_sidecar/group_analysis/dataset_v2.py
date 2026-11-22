"""Sample resolution for spec v2: the engine input and the design check's data.

A spec v2 draft resolves in one fixed order per candidate subject (the
registry records and every subject a pipeline table lists), and the first
rule that fails names the exclusion reason:

1. configuration scope (``config-excluded``) and the QC rule;
2. the within-group population (``not-in-population``);
3. the subset filters (``subset-filtered``; a missing value fails a filter);
4. the tests' groups: a subject no test's factor models is ``no-group`` (its
   level maps to no group) or ``not-compared`` (a group the tests leave
   out), and one outside every stratum is ``no-group``;
5. the shared covariates (age, sex, and the extra covariates):
   ``missing-covariate``; a non-numeric cell of a numeric covariate reads
   as missing and names the variable in the sample's issues;
6. the tests' own values (tested variable, moderator, extra covariates):
   a subject every test lacks a value for is ``missing-variable``; one some
   tests can use stays, and only the others leave it out (per-test
   availability);
7. the registration and outlier rules, as in v1;
8. ``no-measures`` when no selected measure has a value.

Variables come from the registry (``site`` included, read defensively: an
absent or empty field is unset), the metadata CSVs, imported variables
tables, derived variables (computed in listed order), and measures. Measures
come from the v1 pipeline tables, the tier A per-subject stats files
(``sources``), or, for labeled atlases, the labeling cache
(``sources.LabelReader``).
The head-size covariate is eTIV (``icv_data.csv``), sTIV (``aseg.stats``),
or the SynthSeg TIV (``synthseg.tiv.dat``).

Nothing here imports numpy, so the RPC process resolves drafts and checks
designs without it.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from ..cohort import config_subject_scope, effective_qc_verdict
from . import dataset, sources
from .dataset import (
    _FEMALE,
    _FILE_NAMES,
    _MAX_LABEL,
    _MISSING_TOKENS,
    _PRINTABLE,
    AnalysisContext,
    Tables,
    _encode,
    _is_number,
    _qc_reason,
    _registry_by_subject,
    _registry_text,
    numeric_column,
    outlier_flags,
    registration_flags,
    site_of,
)
from .engine_input import HEAD_SIZE_KEY, EngineDataV2, takes_head_size, variable_key
from .spec import (
    AnalysisTest,
    GroupAnalysisError,
    GroupAnalysisSpecV2,
    RangeKeep,
    _js_number,
    parse_measure_id,
    spec_digest,
)

#: The head-size measure of each head-size source.
HEAD_SIZE_MEASURE = {
    "etiv": "global:eTIV",
    "stiv": "global:sTIV",
    "synthseg-tiv": "global:synthsegTIV",
}
_HEAD_SIZE_NAME = {"etiv": "eTIV", "stiv": "sTIV", "synthseg-tiv": "SynthSeg TIV"}
_MAX_ISSUES = 16
_MALE = frozenset({"m", "male"})


def default_bin_labels(cuts: list[float]) -> list[str]:
    """Name the bins of increasing cut points (``defaultBinLabels``).

    Bins are left-closed: ``<c1``, ``c1 to <c2``, ..., ``>=ck``, each number
    in its ECMAScript form.

    Parameters
    ----------
    cuts
        The strictly increasing cut points.

    Returns
    -------
    list of str
        One label per bin, one more than the cuts.
    """
    text = [_js_number(float(cut)) for cut in cuts]
    if not text:
        return []
    labels = [f"<{text[0]}"]
    labels += [f"{low} to <{high}" for low, high in itertools.pairwise(text)]
    labels.append(f">={text[-1]}")
    return labels


def _bin(value: float, cuts: list[float], labels: list[str]) -> str:
    index = sum(1 for cut in cuts if value >= cut)
    return labels[index]


def ref_label(ref: Any) -> str:
    """Name a variable for sentences: its column, or a derived variable's ID."""
    return str(ref.column)


# -- Variables ------------------------------------------------------------------


class _Measures:
    """Read measure values from the pipeline tables, recon files, and labels.

    A subregion atlas reads each subject's recon files first and falls back
    to the labeling cache when that recon has none of the atlas's volume
    files; Yeo and added atlases read the cache only.
    """

    def __init__(
        self,
        context: AnalysisContext,
        tables: Tables,
        reader: sources.ReconReader,
    ) -> None:
        self.context = context
        self.tables = tables
        self.reader = reader
        self.labels = sources.LabelReader(context.project_root)
        self.tier_a: set[str] = set()
        self.labeled: set[str] = set()

    def problem(self, measure_id: str) -> str | None:
        """Return why a measure cannot be read at all, or None."""
        source_id = sources.measure_source_id(measure_id)
        atlas = sources.labels_atlas(measure_id)
        parts = parse_measure_id(measure_id)
        if parts is None:
            return "The measure ID is not valid."
        if atlas is not None and self.labels.any(atlas):
            return None
        if source_id is not None:
            if not self.reader.configured:
                return "The derivatives folder is not set in the project settings."
            return None
        if parts.source in {"parc", "vol"}:
            return f"No subject has labels of the {parts.atlas} atlas yet."
        return dataset._measure_problem(measure_id, self.tables)

    def values(
        self, measure_id: str, subject_ids: Iterable[str]
    ) -> dict[str, float | None]:
        """Return each subject's value (None when missing)."""
        source_id = sources.measure_source_id(measure_id)
        atlas = sources.labels_atlas(measure_id)
        if source_id is not None:
            self.tier_a.add(source_id)
            out: dict[str, float | None] = {}
            for sid in subject_ids:
                if atlas is not None and not sources.recon_has_atlas(
                    self.reader, atlas, sid
                ):
                    out[sid] = sources.label_value(self.labels, measure_id, sid)
                    self.labeled.add(atlas)
                else:
                    out[sid] = sources.measure_value(self.reader, measure_id, sid)
            return out
        if atlas is not None:
            self.labeled.add(atlas)
            return {
                sid: sources.label_value(self.labels, measure_id, sid)
                for sid in subject_ids
            }
        table = self.tables.get(dataset.measure_source(measure_id))
        return {
            sid: dataset.measure_value(table, measure_id, sid) for sid in subject_ids
        }

    def empty_reason(self, measure_id: str) -> str:
        """Say why no subject has a value of a readable measure."""
        source_id = sources.measure_source_id(measure_id)
        atlas = sources.labels_atlas(measure_id)
        if source_id is not None and atlas is not None:
            return (
                "No included subject's reconstruction or labels have this "
                "subregion volume."
            )
        if source_id is not None:
            return (
                f"No included subject's reconstruction has "
                f"{sources.file_label(source_id)} with this measure."
            )
        if atlas is not None:
            return f"No included subject has labels of the {atlas} atlas."
        return "No included subject has a value of this measure."


class _Variables:
    """Resolve spec v2 variables to per-subject values, each once."""

    def __init__(
        self,
        context: AnalysisContext,
        spec: GroupAnalysisSpecV2,
        tables: Tables,
        measures: _Measures,
        subjects: list[str],
    ) -> None:
        self.context = context
        self.spec = spec
        self.tables = tables
        self.measures = measures
        self.subjects = subjects
        self.derived = {item.id: item for item in spec.variables.derived}
        self.imported: dict[str, sources.VariableTable] = {}
        self.used_measures: set[str] = set()
        self._raw: dict[str, dict[str, str | float]] = {}
        #: Derived log(1 + x) inputs at or below -1, by derived label.
        self.domain: dict[str, int] = {}

    def table(self, table_id: str) -> sources.VariableTable:
        if table_id not in self.imported:
            self.imported[table_id] = sources.read_variable_table(
                self.context.project_root, table_id
            )
        return self.imported[table_id]

    def raw(self, ref: Any) -> dict[str, str | float]:
        """Return a variable's present values: text, or numbers for computed ones."""
        key = variable_key(ref)
        if key not in self._raw:
            self._raw[key] = self._resolve(ref)
        return self._raw[key]

    def _resolve(self, ref: Any) -> dict[str, str | float]:
        if ref.source == "registry":
            values: dict[str, str | float] = {}
            for sid, record in _registry_by_subject(self.context).items():
                text = _registry_text(record.get(ref.column))
                if text is not None and text not in _MISSING_TOKENS:
                    values[sid] = text
            return values
        if ref.source in {"age-csv", "clinical-csv", "metadata-csv"}:
            return dict(dataset.variable_values(ref, self.context, self.tables))
        if ref.source == "imported":
            table = self.table(ref.table)
            if ref.column not in table.columns:
                raise GroupAnalysisError(
                    f"Choose a column the imported variables table has: {ref.column}."
                )
            return {
                sid: row[ref.column]
                for sid, row in table.rows.items()
                if row.get(ref.column, "") not in _MISSING_TOKENS
            }
        if ref.source == "measure":
            self.used_measures.add(ref.column)
            problem = self.measures.problem(ref.column)
            if problem is not None:
                raise GroupAnalysisError(
                    f"Choose a measure the analysis can read for {ref.column}: "
                    f"{problem}"
                )
            return {
                sid: value
                for sid, value in self.measures.values(
                    ref.column, self.subjects
                ).items()
                if value is not None
            }
        return self._derive(self.derived[ref.column])

    def numbers(self, ref: Any) -> tuple[dict[str, float], set[str]]:
        """Return the numeric values and the subjects whose cell is not a number."""
        out: dict[str, float] = {}
        bad: set[str] = set()
        for sid, value in self.raw(ref).items():
            if isinstance(value, float):
                out[sid] = value
            elif _is_number(value):
                out[sid] = float(value)
            else:
                bad.add(sid)
        return out, bad

    def is_numeric(self, ref: Any) -> bool:
        """Say whether a variable is numeric (computed, or mostly numbers)."""
        values = self.raw(ref)
        if any(isinstance(value, float) for value in values.values()):
            return True
        return numeric_column(str(value) for value in values.values())

    def _derive(self, item: Any) -> dict[str, str | float]:
        inputs = []
        for ref in item.inputs:
            numbers, bad = self.numbers(ref)
            if not numbers and bad:
                raise GroupAnalysisError(
                    f"Choose numeric inputs for {item.label}: {ref_label(ref)} "
                    "is not numeric."
                )
            inputs.append(numbers)
        common = set(inputs[0]).intersection(*inputs[1:])
        out: dict[str, str | float] = {}
        if item.op == "sum":
            for sid in common:
                out[sid] = math.fsum(values[sid] for values in inputs)
        elif item.op == "difference":
            for sid in common:
                out[sid] = inputs[0][sid] - inputs[1][sid]
        elif item.op == "log1p":
            below = 0
            for sid in common:
                value = inputs[0][sid]
                if value <= -1:
                    below += 1
                    continue
                out[sid] = math.log1p(value)
            if below:
                self.domain[item.label] = below
        else:
            cuts = list(item.params.cuts)
            labels = list(item.params.labels) or default_bin_labels(cuts)
            for sid in common:
                out[sid] = _bin(inputs[0][sid], cuts, labels)
        return out


# -- The resolved dataset --------------------------------------------------------


@dataclass
class TestSample:
    """One test's view of the aligned sample (for the design check)."""

    test: AnalysisTest
    #: The factor group label of each aligned subject (None: not modeled).
    labels: list[str | None]
    #: The modeled groups, in definition order.
    groups: list[str]
    #: Whether each aligned subject has every value the test needs.
    complete: list[bool]
    #: Aligned subjects in the test's groups but missing one of its values.
    missing: int = 0


@dataclass
class DatasetV2:
    """Hold one spec v2's resolution: the engine input and the check's data."""

    data: EngineDataV2
    #: Each aligned subject's registry site (None: unset).
    sites: list[str | None]
    #: Each aligned subject's sex text from the sex covariate (None: unset).
    sex: list[str | None]
    #: The stratum label of each aligned subject (None without strata).
    strata: list[str | None]
    tests: dict[str, TestSample]
    #: Per test and modeled group: subjects before the covariate rule, and
    #: how many of them miss each shared or test covariate (by name).
    covariate_gaps: dict[str, dict[str, tuple[int, dict[str, int]]]]
    #: Per test and modeled group: subjects in the population before and
    #: after the subset filters.
    subset_counts: dict[str, dict[str, tuple[int, int]]]
    #: Derived log(1 + x) inputs at or below -1, by derived label.
    domain: dict[str, int]
    #: The raw population level of each aligned subject (within scope).
    population_levels: list[str | None]
    #: Categorical shared covariates as text, by label (for crosstabs).
    categorical: dict[str, list[str | None]] = field(default_factory=dict)
    #: The numeric design columns shared by every test, by label.
    numeric: dict[str, list[float | None]] = field(default_factory=dict)
    #: Numeric values of each test's tested variable and moderator.
    tested: dict[str, list[float | None]] = field(default_factory=dict)
    moderators: dict[str, list[str | float | None]] = field(default_factory=dict)
    #: Each test's extra covariate columns (coded), by label.
    test_columns: dict[str, dict[str, list[float | None]]] = field(default_factory=dict)


@dataclass
class _Candidate:
    subject_id: str
    group: str | None = None
    source_label: str | None = None
    reason: str | None = None
    missing_hemispheres: tuple[str, ...] = ()

    def public(self) -> dict[str, Any]:
        return {
            "subjectId": self.subject_id,
            "group": self.group,
            "sourceLabel": self.source_label,
            "included": self.reason is None,
            "reason": self.reason,
            "missingHemispheres": list(self.missing_hemispheres),
        }


def _grouping_map(grouping: Any) -> dict[str, str]:
    return {level: group.label for group in grouping.groups for level in group.levels}


def _level(value: str | float | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    return value


def modeled_groups(test: AnalysisTest) -> list[str]:
    """Return a test's modeled groups in definition order (none without a factor)."""
    factor = test.factor
    if factor is None:
        return []
    defined = [group.label for group in factor.grouping.groups]
    if test.kind == "two-group" and factor.model == "compared-groups":
        return [g for g in defined if g in (factor.focal, factor.reference)]
    return defined


def _shared_refs(spec: GroupAnalysisSpecV2) -> list[tuple[str, Any, bool]]:
    """Return the shared covariates as (name, ref, age) in model order."""
    refs: list[tuple[str, Any, bool]] = []
    if spec.covariates.age is not None:
        refs.append(("age", spec.covariates.age, True))
    if spec.covariates.sex is not None:
        refs.append(("sex", spec.covariates.sex, False))
    refs.extend((variable_key(ref), ref, False) for ref in spec.covariates.extra)
    return refs


def _where(ref: Any) -> str:
    if ref.source == "registry":
        return "the registry"
    if ref.source in _FILE_NAMES:
        return _FILE_NAMES[ref.source]
    if ref.source == "imported":
        return "the imported variables table"
    if ref.source == "measure":
        return "the measures"
    return "the derived variables"


def _not_numeric_issue(ref: Any, count: int) -> str:
    subjects = "1 subject, so it is" if count == 1 else f"{count} subjects, so they are"
    return (
        f"{ref_label(ref)} in {_where(ref)} is not a number for {subjects} left out "
        "as missing that variable."
    )


def _cortical_hemispheres(measure_id: str) -> tuple[str, ...]:
    parts = parse_measure_id(measure_id)
    if parts is None:
        return ()
    if parts.source in {"dk", "parc"}:
        return ("lh", "rh") if parts.hemisphere == "bi" else (str(parts.hemisphere),)
    if parts.source == "global" and parts.name == "meanThickness":
        return ("lh", "rh")
    return ()


def _all_refs(spec: GroupAnalysisSpecV2) -> list[Any]:
    design = spec.design
    refs: list[Any] = []
    if design.population is not None:
        refs.append(design.population.grouping.variable)
    refs += [item.variable for item in design.subset]
    if spec.stratify is not None:
        refs.append(spec.stratify.grouping.variable)
    refs += [
        ref for ref in (spec.covariates.age, spec.covariates.sex) if ref is not None
    ]
    refs += list(spec.covariates.extra)
    for test in spec.tests:
        if test.factor is not None:
            refs.append(test.factor.grouping.variable)
        if test.variable is not None:
            refs.append(test.variable.ref)
        if test.moderator is not None:
            refs.append(test.moderator.ref)
        refs += list(test.extraCovariates)
    for item in spec.variables.derived:
        refs += list(item.inputs)
    return refs


def registration_relevant(spec: GroupAnalysisSpecV2) -> bool:
    """Say whether registration flags can change this spec's result."""
    rule = spec.inclusion.registration
    return rule == "exclude-subject" or (
        rule == "set-missing" and any(_cortical_hemispheres(m) for m in spec.measures)
    )


def _digest(value: Any) -> str:
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def context_state(
    context: AnalysisContext, spec: GroupAnalysisSpecV2
) -> dict[str, Any]:
    """Return the registry and registration digests a result's currency compares.

    The registry digest covers only the registry fields the spec reads (so
    setting a site changes it only for a spec that reads ``site``).
    """
    fields = sorted({ref.column for ref in _all_refs(spec) if ref.source == "registry"})
    registry = sorted(
        (
            {"subjectId": sid, **{key: record.get(key) for key in fields}}
            for sid, record in _registry_by_subject(context).items()
        ),
        key=lambda item: item["subjectId"],
    )
    flagged, _unjudged = registration_flags(context)
    flags = (
        {sid: sorted(hemis) for sid, hemis in sorted(flagged.items())}
        if registration_relevant(spec)
        else {}
    )
    return {
        "registrySha256": _digest(registry if fields else []),
        "registrationSha256": _digest(flags),
    }


class _Resolver:
    """Resolve one spec v2 against one project snapshot."""

    def __init__(
        self, context: AnalysisContext, spec: GroupAnalysisSpecV2, *, cache: bool
    ) -> None:
        self.context = context
        self.spec = spec
        self.tables = Tables(context, cache=cache)
        self.reader = sources.ReconReader(context, cache=cache)
        self.measures = _Measures(context, self.tables, self.reader)
        self.registry = _registry_by_subject(context)
        self.subjects = dataset._candidates(context, self.tables)
        self.vars = _Variables(context, spec, self.tables, self.measures, self.subjects)
        self.issues: list[str] = []

    # -- Helpers --

    def _labels(self, grouping: Any) -> dict[str, str | None]:
        mapping = _grouping_map(grouping)
        raw = self.vars.raw(grouping.variable)
        return {sid: mapping.get(_level(value) or "") for sid, value in raw.items()}

    def _passes(self, item: Any, sid: str) -> bool:
        raw = self.vars.raw(item.variable)
        if sid not in raw:
            return False
        if isinstance(item.keep, RangeKeep):
            numbers, _bad = self.vars.numbers(item.variable)
            value = numbers.get(sid)
            if value is None:
                return False
            low, high = item.keep.min, item.keep.max
            return (low is None or value >= low) and (high is None or value <= high)
        return _level(raw[sid]) in set(item.keep.levels)

    def resolve(self) -> DatasetV2:  # noqa: PLR0912, PLR0915
        spec, context = self.spec, self.context
        include, exclude = config_subject_scope(dict(context.cfg))
        population = spec.design.population
        pop_labels = self._labels(population.grouping) if population else {}
        pop_raw = self.vars.raw(population.grouping.variable) if population else {}
        strata = self._labels(spec.stratify.grouping) if spec.stratify else None
        factor_labels = {
            test.id: self._labels(test.factor.grouping)
            for test in spec.tests
            if test.factor is not None
        }
        modeled = {test.id: modeled_groups(test) for test in spec.tests}

        shared = _shared_refs(spec)
        shared_numeric = {
            name: age or (name != "sex" and self.vars.is_numeric(ref))
            for name, ref, age in shared
        }
        shared_values: dict[str, dict[str, str]] = {}
        shared_bad: dict[str, set[str]] = {}
        for name, ref, _age in shared:
            if shared_numeric[name]:
                numbers, bad = self.vars.numbers(ref)
                if bad and not numbers:
                    raise GroupAnalysisError(f"Choose a numeric variable for {name}.")
                shared_values[name] = {sid: repr(v) for sid, v in numbers.items()}
                shared_bad[name] = bad
            else:
                shared_values[name] = {
                    sid: str(v) for sid, v in self.vars.raw(ref).items()
                }
                shared_bad[name] = set()
        left_out = dict.fromkeys(shared_bad, 0)

        # The values each test needs beyond the shared covariates.
        test_needs: dict[str, list[tuple[str, dict[str, Any]]]] = {}
        test_extras: dict[str, list[tuple[str, dict[str, Any]]]] = {}
        tested_numbers: dict[str, dict[str, float]] = {}
        tested_bad: dict[str, set[str]] = {}
        for test in spec.tests:
            needs: list[tuple[str, dict[str, Any]]] = []
            if test.variable is not None:
                numbers, bad = self.vars.numbers(test.variable.ref)
                if bad and not numbers:
                    raise GroupAnalysisError(
                        f"Choose a numeric variable to test in {test.label}."
                    )
                tested_numbers[test.id] = numbers
                tested_bad[test.id] = bad
                needs.append((ref_label(test.variable.ref), numbers))
            if test.moderator is not None:
                if self.vars.is_numeric(test.moderator.ref):
                    numbers, _bad = self.vars.numbers(test.moderator.ref)
                    needs.append((ref_label(test.moderator.ref), numbers))
                else:
                    needs.append(
                        (
                            ref_label(test.moderator.ref),
                            self.vars.raw(test.moderator.ref),
                        )
                    )
            extras: list[tuple[str, dict[str, Any]]] = []
            for ref in test.extraCovariates:
                if self.vars.is_numeric(ref):
                    numbers, _bad = self.vars.numbers(ref)
                    extras.append((ref_label(ref), numbers))
                else:
                    extras.append((ref_label(ref), self.vars.raw(ref)))
            test_needs[test.id] = needs + extras
            test_extras[test.id] = extras

        flagged, unjudged = registration_flags(context)
        outlier_rule = spec.inclusion.outliers
        outliers: dict[str, set[str]] = {}
        outliers_unapplied = False
        if outlier_rule != "keep":
            table = self.tables.get("outliers")
            if table.usable:
                outliers = outlier_flags(table)
            else:
                outliers_unapplied = True
                self.issues.append(
                    dataset._OUTLIERS_MISSING
                    if not table.present
                    else dataset._OUTLIERS_UNREADABLE
                )
        selected = set(spec.measures)

        first_factor = next((t for t in spec.tests if t.factor is not None), None)
        label_ref = self._label_ref()
        label_raw = self.vars.raw(label_ref) if label_ref is not None else {}

        covariate_gaps: dict[str, dict[str, tuple[int, dict[str, int]]]] = {
            test.id: {} for test in spec.tests
        }
        subset_counts: dict[str, dict[str, tuple[int, int]]] = {
            test.id: {g: (0, 0) for g in modeled[test.id]} for test in spec.tests
        }
        candidates: list[_Candidate] = []
        provisional = not context.registration_known
        for sid in self.subjects:
            item = _Candidate(sid)
            candidates.append(item)
            if first_factor is not None:
                item.group = factor_labels[first_factor.id].get(sid)
            elif population is not None:
                item.group = pop_labels.get(sid)
            if label_ref is not None:
                item.source_label = _level(label_raw.get(sid))
            else:
                record = self.registry.get(sid)
                item.source_label = (
                    _registry_text(record.get("sourceCohortLabel")) if record else None
                )
            if item.source_label is not None and (
                len(item.source_label) > _MAX_LABEL
                or not _PRINTABLE.fullmatch(item.source_label)
            ):
                item.source_label = None
            if sid in exclude or (include and sid not in include):
                item.reason = "config-excluded"
                continue
            verdict = effective_qc_verdict(dict(context.qc.get(sid) or {}))
            if reason := _qc_reason(spec.inclusion.qc, verdict):
                item.reason = reason
                continue
            if population is not None and pop_labels.get(sid) not in set(
                population.groups
            ):
                item.reason = "not-in-population"
                continue
            in_subset = all(self._passes(f, sid) for f in spec.design.subset)
            for test in spec.tests:
                label = factor_labels.get(test.id, {}).get(sid)
                if label in subset_counts[test.id]:
                    before, after = subset_counts[test.id][label]
                    subset_counts[test.id][label] = (before + 1, after + in_subset)
            if not in_subset:
                item.reason = "subset-filtered"
                continue
            grouped = [
                test
                for test in spec.tests
                if test.factor is None
                or factor_labels[test.id].get(sid) in modeled[test.id]
            ]
            if not grouped:
                mapped = any(
                    factor_labels[t.id].get(sid) is not None
                    for t in spec.tests
                    if t.factor is not None
                )
                item.reason = "not-compared" if mapped else "no-group"
                continue
            if strata is not None and strata.get(sid) is None:
                item.reason = "no-group"
                continue
            for test in grouped:
                label = (
                    factor_labels[test.id].get(sid)
                    if test.factor is not None
                    else "all"
                )
                total, gaps = covariate_gaps[test.id].get(str(label), (0, {}))
                gaps = dict(gaps)
                for name, ref, _age in shared:
                    if sid not in shared_values[name]:
                        key = ref_label(ref) if name not in {"age", "sex"} else name
                        gaps[key] = gaps.get(key, 0) + 1
                for key, values in test_extras[test.id]:
                    if sid not in values:
                        gaps[key] = gaps.get(key, 0) + 1
                covariate_gaps[test.id][str(label)] = (total + 1, gaps)
            if any(sid not in values for values in shared_values.values()):
                item.reason = "missing-covariate"
                for name, bad in shared_bad.items():
                    if sid in bad:
                        left_out[name] += 1
                continue
            usable = [
                test
                for test in grouped
                if all(sid in values for _key, values in test_needs[test.id])
            ]
            if not usable:
                item.reason = "missing-variable"
                continue
            if sid in unjudged:
                provisional = True
            hemis = flagged.get(sid, set())
            if spec.inclusion.registration == "exclude-subject" and hemis:
                item.reason = "registration-flagged"
                continue
            if spec.inclusion.registration == "set-missing":
                item.missing_hemispheres = tuple(sorted(hemis))
            if (
                outlier_rule == "exclude-subject"
                and outliers.get(sid, set()) & selected
            ):
                item.reason = "outlier"
                continue

        for (name, ref, _age), count in zip(shared, left_out.values(), strict=True):
            del name
            if count:
                self.issues.append(_not_numeric_issue(ref, count))
        for test in spec.tests:
            bad = tested_bad.get(test.id, set())
            count = sum(
                1 for c in candidates if c.reason is None and c.subject_id in bad
            )
            if count and test.variable is not None:
                issue = _not_numeric_issue(test.variable.ref, count)
                if issue not in self.issues:
                    self.issues.append(issue)

        included = [c.subject_id for c in candidates if c.reason is None]
        by_id = {c.subject_id: c for c in candidates}
        measures, skipped, head = self._measures(included, by_id, outliers)
        for sid in included:
            if not any(cells[sid] is not None for cells in measures.values()):
                by_id[sid].reason = "no-measures"
        ids = [c.subject_id for c in candidates if c.reason is None]

        covariates: dict[str, list[float | None]] = {}
        for name, _ref, age in shared:
            encoded = _encode(name, shared_values[name], included, numeric_only=age)
            for key, values in encoded.items():
                covariates[key] = [values.get(sid) for sid in ids]
        if head is not None and any(takes_head_size(m, spec) for m in measures):
            covariates[HEAD_SIZE_KEY] = [head.get(sid) for sid in ids]
        test_covariates: dict[str, dict[str, list[float | None]]] = {}
        for test in spec.tests:
            columns: dict[str, list[float | None]] = {}
            for ref in test.extraCovariates:
                if self.vars.is_numeric(ref):
                    numbers, _bad = self.vars.numbers(ref)
                    raw = {sid: repr(v) for sid, v in numbers.items() if sid in ids}
                else:
                    raw = {
                        sid: str(v)
                        for sid, v in self.vars.raw(ref).items()
                        if sid in ids
                    }
                present = [sid for sid in ids if sid in raw]
                if not present:
                    columns[variable_key(ref)] = [None] * len(ids)
                    continue
                encoded = _encode(variable_key(ref), raw, present, numeric_only=False)
                for key, values in encoded.items():
                    columns[key] = [values.get(sid) for sid in ids]
            if columns:
                test_covariates[test.id] = columns

        variables = self._engine_variables(ids)
        engine = EngineDataV2(
            subject_ids=ids,
            source_labels=[by_id[sid].source_label for sid in ids],
            variables=variables,
            covariates=covariates,
            measures={m: [cells[sid] for sid in ids] for m, cells in measures.items()},
            test_covariates=test_covariates,
            subjects=[c.public() for c in candidates],
            skipped=skipped,
            inputs=self._inputs(ids),
            registration_provisional=provisional,
            issues=self.issues[:_MAX_ISSUES],
            outliers_unapplied=outliers_unapplied,
            state={
                **context_state(context, spec),
                "usedSources": self._used_sources(),
            },
        )
        engine.check()
        return self._dataset(
            engine,
            factor_labels,
            modeled,
            strata,
            pop_raw,
            shared,
            shared_values,
            test_needs,
            tested_numbers,
            covariate_gaps,
            subset_counts,
        )

    def _label_ref(self) -> Any:
        """Return the variable whose raw level labels each subject, if any."""
        for test in self.spec.tests:
            if test.factor is not None:
                return test.factor.grouping.variable
        if self.spec.design.population is not None:
            return self.spec.design.population.grouping.variable
        for item in self.spec.design.subset:
            if not isinstance(item.keep, RangeKeep):
                return item.variable
        return None

    def _head_size(self, ids: list[str]) -> tuple[dict[str, float | None], str | None]:
        source = self.spec.covariates.headSize.source
        measure_id = HEAD_SIZE_MEASURE[source]
        name = _HEAD_SIZE_NAME[source]
        if source == "etiv":
            icv = self.tables.get("icv")
            if not (icv.usable and "eTIV" in icv.header):
                return {}, (
                    "eTIV is a covariate of this measure, and icv_data.csv has no "
                    "readable eTIV column."
                )
        elif not self.reader.configured:
            return {}, (
                f"{name} is a covariate of this measure, and the derivatives folder "
                "is not set in the project settings."
            )
        values = self.measures.values(measure_id, ids)
        if ids and all(value is None for value in values.values()):
            where = (
                "icv_data.csv"
                if source == "etiv"
                else ("aseg.stats" if source == "stiv" else "synthseg.tiv.dat")
            )
            return values, (
                f"{name} is a covariate of this measure, and no included subject's "
                f"{where} has it."
            )
        return values, None

    def _measures(
        self,
        ids: list[str],
        by_id: Mapping[str, _Candidate],
        outliers: Mapping[str, set[str]],
    ) -> tuple[
        dict[str, dict[str, float | None]],
        list[dict[str, Any]],
        dict[str, float | None] | None,
    ]:
        spec = self.spec
        needs_head = any(takes_head_size(m, spec) for m in spec.measures)
        head: dict[str, float | None] | None = None
        head_problem = None
        if needs_head:
            head, head_problem = self._head_size(ids)
        measures: dict[str, dict[str, float | None]] = {}
        skipped: list[dict[str, Any]] = []
        set_missing = spec.inclusion.outliers == "set-missing"
        for measure_id in spec.measures:
            problem = self.measures.problem(measure_id)
            if problem is None and head_problem and takes_head_size(measure_id, spec):
                problem = head_problem
            if problem is not None:
                skipped.append({"measureId": measure_id, "reason": problem[:512]})
                continue
            values = self.measures.values(measure_id, ids)
            hemis = set(_cortical_hemispheres(measure_id))
            cells: dict[str, float | None] = {}
            for sid in ids:
                value = values.get(sid)
                if (hemis and hemis & set(by_id[sid].missing_hemispheres)) or (
                    set_missing and measure_id in outliers.get(sid, ())
                ):
                    value = None
                cells[sid] = value
            if ids and all(value is None for value in cells.values()):
                reason = self.measures.empty_reason(measure_id)
                skipped.append({"measureId": measure_id, "reason": reason[:512]})
                continue
            measures[measure_id] = cells
        return measures, skipped, head

    def _engine_variables(self, ids: list[str]) -> dict[str, list[Any]]:
        """Lay out every variable the tests, population, and strata read."""
        spec = self.spec
        numeric_refs: dict[str, Any] = {}
        text_refs: dict[str, Any] = {}
        for test in spec.tests:
            if test.variable is not None:
                numeric_refs[variable_key(test.variable.ref)] = test.variable.ref
            if test.moderator is not None:
                ref = test.moderator.ref
                target = numeric_refs if self.vars.is_numeric(ref) else text_refs
                target[variable_key(ref)] = ref
            if test.factor is not None:
                text_refs[variable_key(test.factor.grouping.variable)] = (
                    test.factor.grouping.variable
                )
        if spec.design.population is not None:
            ref = spec.design.population.grouping.variable
            text_refs[variable_key(ref)] = ref
        if spec.stratify is not None:
            ref = spec.stratify.grouping.variable
            text_refs[variable_key(ref)] = ref
        variables: dict[str, list[Any]] = {}
        for key, ref in numeric_refs.items():
            numbers, _bad = self.vars.numbers(ref)
            variables[key] = [numbers.get(sid) for sid in ids]
        for key, ref in text_refs.items():
            if key in variables:
                continue
            raw = self.vars.raw(ref)
            variables[key] = [_level(raw.get(sid)) for sid in ids]
        return variables

    def _used_tables(self) -> list[str]:
        return sorted(
            {ref.table for ref in _all_refs(self.spec) if ref.source == "imported"}
        )

    def _tier_a_sources(self) -> list[str]:
        used = set(self.measures.tier_a)
        for measure_id in [*self.spec.measures, *self.vars.used_measures]:
            if (source_id := sources.measure_source_id(measure_id)) is not None:
                used.add(source_id)
        if any(takes_head_size(m, self.spec) for m in self.spec.measures):
            source = self.spec.covariates.headSize.source
            if source in {"stiv", "synthseg-tiv"}:
                used.add("aseg-global")
        return [s for s in sources.TIER_A_SOURCES if s in used]

    def _label_atlases(self) -> list[str]:
        used = set(self.measures.labeled)
        for measure_id in [*self.spec.measures, *self.vars.used_measures]:
            if (atlas := sources.labels_atlas(measure_id)) is not None:
                used.add(atlas)
        return sorted(used)

    def _inputs(self, ids: list[str]) -> list[dict[str, Any]]:
        rows = [table.public() for table in self.tables.all()]
        rows += [
            sources.combined_digest(self.reader, source_id, ids)
            for source_id in self._tier_a_sources()
        ]
        rows += [
            sources.labels_input(self.context.project_root, atlas_id, ids)
            for atlas_id in self._label_atlases()
        ]
        rows += [
            sources.table_input(self.context.project_root, table_id)
            for table_id in self._used_tables()
        ]
        return rows

    def _used_sources(self) -> list[str]:
        spec = self.spec
        used: set[str] = set()
        for measure_id in [*spec.measures, *self.vars.used_measures]:
            if sources.measure_source_id(measure_id) is None:
                parts = parse_measure_id(measure_id)
                if parts is not None and parts.source not in {"parc", "vol"}:
                    used.add(dataset.measure_source(measure_id))
        if (
            any(takes_head_size(m, spec) for m in spec.measures)
            and spec.covariates.headSize.source == "etiv"
        ):
            used.add("icv")
        if spec.inclusion.outliers != "keep":
            used.add("outliers")
        used.update(
            ref.source
            for ref in _all_refs(spec)
            if ref.source in {"age-csv", "clinical-csv", "metadata-csv"}
        )
        v1 = [source for source in dataset.INPUT_SOURCES if source in used]
        return [
            *v1,
            *(f"stats:{source_id}" for source_id in self._tier_a_sources()),
            *(f"labels:{atlas_id}" for atlas_id in self._label_atlases()),
            *(f"variables:{table_id}" for table_id in self._used_tables()),
        ]

    def _dataset(  # noqa: PLR0913
        self,
        engine: EngineDataV2,
        factor_labels: dict[str, dict[str, str | None]],
        modeled: dict[str, list[str]],
        strata: dict[str, str | None] | None,
        pop_raw: Mapping[str, Any],
        shared: list[tuple[str, Any, bool]],
        shared_values: dict[str, dict[str, str]],
        test_needs: dict[str, list[tuple[str, dict[str, Any]]]],
        tested_numbers: dict[str, dict[str, float]],
        covariate_gaps: dict[str, dict[str, tuple[int, dict[str, int]]]],
        subset_counts: dict[str, dict[str, tuple[int, int]]],
    ) -> DatasetV2:
        spec = self.spec
        ids = engine.subject_ids
        tests: dict[str, TestSample] = {}
        for test in spec.tests:
            labels = (
                [factor_labels[test.id].get(sid) for sid in ids]
                if test.factor is not None
                else ["all" for _sid in ids]
            )
            groups = modeled[test.id] if test.factor is not None else ["all"]
            complete = [
                label in groups
                and all(sid in values for _key, values in test_needs[test.id])
                and (strata is None or strata.get(sid) is not None)
                for sid, label in zip(ids, labels, strict=True)
            ]
            missing = sum(
                1
                for sid, label in zip(ids, labels, strict=True)
                if label in groups
                and not all(sid in values for _key, values in test_needs[test.id])
            )
            tests[test.id] = TestSample(
                test=test,
                labels=[label if label in groups else None for label in labels],
                groups=groups,
                complete=complete,
                missing=missing,
            )
        sex_text: list[str | None] = [None] * len(ids)
        categorical: dict[str, list[str | None]] = {}
        numeric: dict[str, list[float | None]] = {}
        for name, ref, age in shared:
            values = shared_values[name]
            label = name if name in {"age", "sex"} else ref_label(ref)
            if name == "sex":
                sex_text = [values.get(sid) for sid in ids]
            is_number = age or (name != "sex" and self.vars.is_numeric(ref))
            if is_number:
                numeric[label] = [
                    float(values[sid]) if sid in values else None for sid in ids
                ]
            else:
                categorical[label] = [values.get(sid) for sid in ids]
        moderators: dict[str, list[str | float | None]] = {}
        tested: dict[str, list[float | None]] = {}
        test_columns: dict[str, dict[str, list[float | None]]] = {}
        for test in spec.tests:
            if test.variable is not None:
                numbers = tested_numbers.get(test.id, {})
                tested[test.id] = [numbers.get(sid) for sid in ids]
            if test.moderator is not None:
                key = variable_key(test.moderator.ref)
                moderators[test.id] = list(engine.variables.get(key, []))
            columns = engine.test_covariates.get(test.id, {})
            if columns:
                test_columns[test.id] = columns
        sites = [site_of(self.registry.get(sid)) for sid in ids]
        return DatasetV2(
            data=engine,
            sites=sites,
            sex=sex_text,
            strata=[strata.get(sid) for sid in ids]
            if strata is not None
            else [None] * len(ids),
            tests=tests,
            covariate_gaps=covariate_gaps,
            subset_counts=subset_counts,
            domain=dict(self.vars.domain),
            population_levels=[_level(pop_raw.get(sid)) for sid in ids],
            categorical=categorical,
            numeric=numeric,
            tested=tested,
            moderators=moderators,
            test_columns=test_columns,
        )


def resolve(
    context: AnalysisContext, spec: GroupAnalysisSpecV2, *, cache: bool = True
) -> DatasetV2:
    """Resolve a spec v2 into its dataset.

    Parameters
    ----------
    spec
        The validated spec v2.
    cache
        Reuse parses of unchanged files (the RPC process); the compute worker
        reads without the cache, so its digests describe the bytes it used.

    Returns
    -------
    DatasetV2
        The engine input and the design check's data.

    Raises
    ------
    GroupAnalysisError
        When a variable cannot be read or has the wrong kind.
    """
    return _Resolver(context, spec, cache=cache).resolve()


def female_male(values: Iterable[str | None]) -> tuple[int | None, int | None]:
    """Count female and male subjects from sex texts (None without any sex)."""
    items = list(values)
    if not items or all(value is None for value in items):
        return None, None
    female = sum(1 for v in items if v is not None and v.lower() in _FEMALE)
    male = sum(1 for v in items if v is not None and v.lower() in _MALE)
    return female, male


def resolve_inputs(
    context: AnalysisContext, spec: GroupAnalysisSpecV2
) -> dict[str, Any]:
    """Resolve a spec v2 draft without computing (``groupAnalysis.inputs``).

    Parameters
    ----------
    spec
        The validated draft.

    Returns
    -------
    dict
        The ``GroupAnalysisInputs`` payload with its ``designCheck``.
    """
    from .design_check import check_design  # noqa: PLC0415
    from .engine_input import sample_groups  # noqa: PLC0415

    resolved = resolve(context, spec)
    data = resolved.data
    return {
        "configRevision": context.config_revision,
        "specDigest": spec_digest(spec),
        "subjects": data.subjects,
        "groups": sample_groups(spec, data),
        "included": len(data.subject_ids),
        "registrationProvisional": data.registration_provisional,
        "inputs": data.inputs,
        "skippedMeasures": data.skipped,
        "issues": data.issues[:_MAX_ISSUES],
        "designCheck": check_design(context, spec, resolved),
    }
