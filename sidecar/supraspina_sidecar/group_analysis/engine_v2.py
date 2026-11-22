"""The v2 model and inference engine (``ols-glh-freedman-lane-v2``).

General linear hypotheses over OLS fits, with Freedman-Lane permutation
inference; numpy, loaded only by the compute worker. It reproduces the v1
engine (``engine``) byte for byte on an upgraded v1 specification: a rank-1
term runs v1's arithmetic on v1's design, blocks, and permutation stream.

Models and terms
----------------
Every test runs in each unit: the pooled sample, then each stratum of a
stratified design (its own complete cases and centering; a stratified design
leaves out subjects outside every stratum). A test's master
sample is every included subject its factor, tested variable, moderator, and
extra covariates define, in subject ID order. Its design is an intercept,
then the tested columns, then the covariates (centered per block):

- two-group: an indicator per modeled group except the reference, in
  definition order (``all-groups``: every defined group; ``compared-groups``:
  focal and reference); the term is the focal indicator (focal minus
  reference; the adjusted d with its noncentral-t CI).
- omnibus: the same indicators; the effect term is all of them (F with
  rank groups - 1). Each pair is a t term by reparametrization: the pair's
  reference becomes the baseline (the same column space), so its
  Freedman-Lane reduced model merges the pair.
  Under ``compared-groups`` a pair is fitted on its two groups alone.
- association: the tested variable (``none``, ``log1p``, or
  ``standardize`` over the master sample; centered), then group indicators
  when adjusting for group; the term is the slope (partial r with a
  Fisher-z CI, se 1/sqrt(df - 1), and the slope per SD).
- interaction: group indicators, the centered moderator (numeric) or its
  centered level indicators (categorical, levels sorted, the first the
  baseline), and every indicator x moderator product; the term is all
  products (slope differences; F when the rank exceeds 1). Simple slopes
  and fitted lines are descriptive detail.
- heterogeneity (stratified, on request): the pooled design with stratum
  indicators and every tested column x stratum product; the term is the
  products of the effect columns with the strata.

A measure is fitted on its complete cases; measures with the same rows and
covariates share a block. A block is skipped with a reason when a modeled
group (focal and reference of a two-group test) has fewer than ``minCellN``
subjects, the tested variable is constant, an interaction group has fewer
than three subjects, a constant moderator, or an empty moderator level, no
residual degree of freedom is left, or the design is rank deficient.

A hypothesis over the selected coefficients S is a t test when ``|S| = 1``
(v1's statistic, p, HC3 p) and otherwise
``F = b_S' V_SS^-1 b_S / (r s^2)`` with ``V = (X'X)^-1``, p from the F
distribution, partial eta squared ``rF / (rF + df)``, and an HC3 Wald F.

Permutations and families
-------------------------
One stream, ``permutation_chunks(seed, n_population)`` over every subject
some test uses (subject ID order), restricted to each block's rows by
induced positions (v1's rule, so a one-test analysis reproduces v1). A term
permutes its own reduced-model residuals ``e_z``; with ``W = Q' P e_z``,
``b*_S = R^-1[S] W``, ``s*^2 = (||e_z||^2 - ||W||^2) / df``, and
``F* = ||L' b*_S||^2 / (r s*^2)`` with ``L L' = V_SS^-1``. A chunk holds
v1's 500 permutations, fewer when its null statistics would pass 4 million
cells; chunking never changes the stream.

A term's correction family follows the specification: every in-family
effect term together (``all-tests``) or each test apart (``per-test``),
optionally split by measure family; interaction terms, the pairwise terms
of an omnibus test (pooled over pairs, or per pair), and heterogeneity
terms each form their test's own family; each stratum (and the pooled
sample) is its own family. Under max-T a family never mixes t and F or F
of different ranks. Rows of a test outside the family (``inFamily``
false) get no corrected p. The omnibus gate marks pairwise rows whose
omnibus row is not significant and never changes p.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field
from statistics import NormalDist
from typing import Any

import numpy as np

from . import distributions
from .dataset import too_few_subjects
from .engine import (
    PERMUTATION_CHUNK,
    ComputeCancelled,
    Progress,
    bh,
    bonferroni,
    holm,
    induced_positions,
    permutation_chunks,
    project_permuted,
)
from .engine_input import (
    HEAD_SIZE_KEY,
    EngineDataV2,
    level_text,
    takes_head_size,
    variable_key,
)
from .spec import (
    AnalysisTest,
    GroupAnalysisError,
    GroupAnalysisSpecV2,
    measure_family,
)

_CI_LEVEL = 0.95
_RANK_TOLERANCE = 1e-10
_LEVERAGE_ONE = 1e-10
_EXACT_FIT = 1e-12
_Z_CI = NormalDist().inv_cdf((1.0 + _CI_LEVEL) / 2.0)
_MIN_MODERATOR_GROUP = 3
#: The null statistics one permutation chunk holds at most (8 bytes each).
_CHUNK_CELLS = 4_000_000
_MIN_CHUNK = 50
#: The most terms one result holds (``MAX_TERMS``).
MAX_TERMS = 1_024
_COUNT_WORDS = {
    2: "two",
    3: "three",
    4: "four",
    5: "five",
    6: "six",
    7: "seven",
    8: "eight",
    9: "nine",
    10: "ten",
}
_UNESTIMABLE = "The tested term cannot be estimated for the subjects with this measure."


@dataclass
class EngineOutputV2:
    """Hold one compute's terms, rows, skips, and measure detail."""

    #: ``GroupAnalysisTerm`` rows in term order.
    terms: list[dict[str, Any]]
    #: ``GroupAnalysisRowV2`` rows, term by term in measure order.
    rows: list[dict[str, Any]]
    #: ``AnalysisSkippedMeasure`` rows the fit added.
    skipped: list[dict[str, Any]]
    #: The stored measure detail (see the worker's record).
    detail: dict[str, Any]


@dataclass(frozen=True)
class _Unit:
    key: str
    stratum: str | None


@dataclass
class _Model:
    """One test in one unit (or one pair fitted on its two groups)."""

    key: str
    test: AnalysisTest
    unit: _Unit
    #: Population indices of the master sample, ascending.
    rows: np.ndarray
    #: Group label per population row (None outside the model or unfactored).
    labels: np.ndarray
    #: Modeled groups in definition order.
    groups: tuple[str, ...]
    reference: str | None
    focal: str | None
    #: The tested variable (transformed) per population row, else None.
    x: np.ndarray | None
    #: The numeric moderator per population row, else None.
    moderator: np.ndarray | None
    #: A categorical moderator's levels (baseline first) and level per row.
    levels: tuple[str, ...] = ()
    level_of: np.ndarray | None = None
    #: Stratum label per population row (heterogeneity designs only).
    strata: np.ndarray | None = None
    #: The test's extra covariate keys.
    extra: tuple[str, ...] = ()


@dataclass
class _Prepared:
    """One test's columns in dataset order, before the units split them."""

    test: AnalysisTest
    #: The subjects the test can use.
    ok: np.ndarray
    labels: list[str | None] = field(default_factory=list)
    groups: tuple[str, ...] = ()
    x: np.ndarray | None = None
    moderator: np.ndarray | None = None
    #: A categorical moderator's level per subject.
    levels: list[str | None] | None = None
    extra: dict[str, list[float | None]] = field(default_factory=dict)


@dataclass
class _Block:
    rows: np.ndarray
    covariates: tuple[str, ...]
    measures: list[int]
    covariate_columns: list[int] = field(default_factory=list)
    x: np.ndarray | None = None
    names: list[str] = field(default_factory=list)
    df: int = 0
    q: np.ndarray | None = None
    r_inv: np.ndarray | None = None
    #: The measures each term fits in this block, by term index.
    fitted: dict[int, list[int]] = field(default_factory=dict)
    #: Each term's hypothesis columns, by term index.
    columns: dict[int, list[int]] = field(default_factory=dict)
    #: Each term's reduced residuals and their squared norms, by term index.
    reduced: dict[int, tuple[np.ndarray, np.ndarray]] = field(default_factory=dict)
    #: Each F term's ``L`` with ``L L' = V_SS^-1``, by term index.
    chol: dict[int, np.ndarray] = field(default_factory=dict)


@dataclass
class _Design:
    model: _Model
    #: The indicator baseline.
    reference: str | None
    heterogeneity: bool = False
    terms: list[int] = field(default_factory=list)
    blocks: list[_Block] = field(default_factory=list)
    #: True for the design whose fit feeds the model's measure detail.
    detail: bool = False


@dataclass
class _Term:
    index: int
    design: _Design
    role: str
    pair: tuple[str, str] | None
    label: str
    kind: str
    rank: int
    #: The hypothesis column names.
    hypothesis: tuple[str, ...]
    family: str | None
    #: Fits by measure index.
    fits: dict[int, dict[str, Any]] = field(default_factory=dict)

    @property
    def test(self) -> AnalysisTest:
        return self.design.model.test


def _numeric(values: list[Any], name: str) -> np.ndarray:
    out = np.full(len(values), math.nan)
    for index, value in enumerate(values):
        if value is None:
            continue
        if isinstance(value, str) or isinstance(value, bool):
            raise GroupAnalysisError(f"Use a numeric variable for {name}.")
        out[index] = float(value)
    if np.isinf(out).any():
        raise GroupAnalysisError(f"Remove the infinite entries in {name}.")
    return out


def _p_value(t: np.ndarray, df: float, sidedness: str) -> np.ndarray:
    if sidedness == "two-sided":
        return np.array([min(1.0, 2.0 * distributions.t_sf(abs(v), df)) for v in t])
    if sidedness == "higher":
        return np.array([distributions.t_sf(v, df) for v in t])
    return np.array([distributions.t_cdf(v, df) for v in t])


def _statistic(t: np.ndarray, sidedness: str) -> np.ndarray:
    if sidedness == "two-sided":
        return np.abs(t)
    return t if sidedness == "higher" else -t


def _count(n: int) -> str:
    return _COUNT_WORDS.get(n, str(n))


def _fisher_interval(r: float, df: int) -> tuple[float | None, float | None]:
    """Return the Fisher-z 95% CI of a partial r (se 1/sqrt(df - 1))."""
    if df <= 1 or abs(r) >= 1.0:
        return None, None
    z = math.atanh(r)
    half = _Z_CI / math.sqrt(df - 1)
    return math.tanh(z - half), math.tanh(z + half)


class _EngineV2:
    """Run one spec v2 over one engine input."""

    def __init__(
        self,
        data: EngineDataV2,
        spec: GroupAnalysisSpecV2,
        progress: Progress,
        cancelled: Callable[[], bool],
    ) -> None:
        data.check()
        self.data = data
        self.spec = spec
        self.progress = progress
        self.cancelled = cancelled
        self.sidedness = spec.inference.sidedness
        self.min_cell = spec.inclusion.minCellN
        self.skipped: list[dict[str, Any]] = []
        self.models: list[_Model] = []
        self.designs: list[_Design] = []
        self.terms: list[_Term] = []
        self._resolve()

    # ------------------------------------------------------------ sample --
    def _variable(self, ref: Any) -> list[Any]:
        key = variable_key(ref)
        if key not in self.data.variables:
            raise GroupAnalysisError(f"Provide the values of {ref.column}.")
        return self.data.variables[key]

    def _grouping_labels(self, grouping: Any) -> list[str | None]:
        label_of = {
            level: group.label for group in grouping.groups for level in group.levels
        }
        return [
            label_of.get(text) if text is not None else None
            for text in (level_text(v) for v in self._variable(grouping.variable))
        ]

    def _transform(
        self, values: np.ndarray, rows: np.ndarray, transform: str, name: str
    ) -> np.ndarray:
        out = values.copy()
        if transform == "log1p":
            used = out[rows]
            if (used <= -1.0).any():
                raise GroupAnalysisError(
                    f"Use log(1 + x) only when every value of {name} is above \u22121."
                )
            out[rows] = np.log1p(used)
        elif transform == "standardize":
            used = out[rows]
            sd = float(used.std(ddof=1)) if len(used) > 1 else 0.0
            out[rows] = (used - used.mean()) / sd if sd > 0 else used - used.mean()
        return out

    def _units(self) -> tuple[list[tuple[_Unit, np.ndarray]], list[str | None]]:
        """Return the units (pooled, then each stratum) and the stratum labels."""
        n_data = len(self.data.subject_ids)
        stratify = self.spec.stratify
        if stratify is None:
            return [(_Unit("pooled", None), np.ones(n_data, dtype=bool))], [
                None
            ] * n_data
        strata = self._grouping_labels(stratify.grouping)
        units = [(_Unit("pooled", None), np.array([s is not None for s in strata]))]
        for index, group in enumerate(stratify.grouping.groups):
            units.append(
                (
                    _Unit(f"stratum-{index + 1}", group.label),
                    np.array([label == group.label for label in strata]),
                )
            )
        return units, strata

    def _prepare(self, test: AnalysisTest) -> _Prepared:
        """Read one test's columns and the subjects it can use (dataset order)."""
        n_data = len(self.data.subject_ids)
        prepared = _Prepared(
            test=test, ok=np.ones(n_data, dtype=bool), labels=[None] * n_data
        )
        factor = test.factor
        if factor is not None:
            prepared.labels = self._grouping_labels(factor.grouping)
            defined = [group.label for group in factor.grouping.groups]
            prepared.groups = tuple(
                defined
                if factor.model == "all-groups" or test.kind != "two-group"
                else [g for g in defined if g in (factor.focal, factor.reference)]
            )
            prepared.ok &= np.array(
                [label in prepared.groups for label in prepared.labels]
            )
        if test.variable is not None:
            prepared.x = _numeric(
                self._variable(test.variable.ref), test.variable.ref.column
            )
            prepared.ok &= ~np.isnan(prepared.x)
        if test.moderator is not None:
            raw = self._variable(test.moderator.ref)
            if any(isinstance(v, str) for v in raw):
                if test.moderator.transform != "none":
                    raise GroupAnalysisError("Transform only a numeric moderator.")
                prepared.levels = [level_text(v) for v in raw]
                prepared.ok &= np.array([v is not None for v in prepared.levels])
            else:
                prepared.moderator = _numeric(raw, test.moderator.ref.column)
                prepared.ok &= ~np.isnan(prepared.moderator)
        prepared.extra = self.data.test_covariates.get(test.id, {})
        for key, values in prepared.extra.items():
            prepared.ok &= ~np.isnan(_numeric(values, key))
        return prepared

    def _resolve(self) -> None:
        data, spec = self.data, self.spec
        ids = data.subject_ids
        order = sorted(range(len(ids)), key=lambda index: ids[index])
        units, strata = self._units()
        prepared = [self._prepare(test) for test in spec.tests]
        eligible = np.zeros(len(ids), dtype=bool)
        for item in prepared:
            for _unit, unit_mask in units:
                eligible |= item.ok & unit_mask
        pop = np.array([index for index in order if eligible[index]], dtype=np.int64)
        self.population = pop
        self.n_population = n = len(pop)
        self.measure_ids = [m for m in spec.measures if m in data.measures]
        self.values = (
            np.column_stack(
                [_numeric(data.measures[m], m)[pop] for m in self.measure_ids]
            )
            if self.measure_ids and n
            else np.empty((n, len(self.measure_ids)))
        )
        self.covariate_values = {
            key: _numeric(values, f"covariate {key}")[pop]
            for key, values in data.covariates.items()
        }
        self.takes_head = [takes_head_size(m, spec) for m in self.measure_ids]
        if any(self.takes_head) and HEAD_SIZE_KEY not in data.covariates:
            raise GroupAnalysisError("Provide head size for the head-size adjustment.")
        strata_pop = np.array([strata[i] for i in pop], dtype=object)
        self.source_labels = [data.source_labels[i] for i in pop]
        for item in prepared:
            test = item.test
            for key, values in item.extra.items():
                self.covariate_values[f"test:{test.id}:{key}"] = _numeric(values, key)[
                    pop
                ]
            extra_keys = tuple(f"test:{test.id}:{key}" for key in item.extra)
            labels_pop = np.array([item.labels[i] for i in pop], dtype=object)
            ok_pop = item.ok[pop]
            pooled: tuple[_Model, tuple[str, ...]] | None = None
            for unit, unit_mask in units:
                member = ok_pop & unit_mask[pop]
                added = self._add_test(
                    item,
                    unit,
                    np.flatnonzero(member),
                    np.where(member, labels_pop, None),
                    extra_keys,
                )
                pooled = pooled or added
            if spec.stratify is not None and spec.stratify.heterogeneity:
                assert pooled is not None  # noqa: S101
                self._add_heterogeneity(*pooled, strata_pop)
        if len(self.terms) > MAX_TERMS:
            raise GroupAnalysisError(
                f"The design has more than {MAX_TERMS} result terms; remove tests, "
                "strata, or pairwise comparisons."
            )

    # ----------------------------------------------------- terms, designs --
    def _model(  # noqa: PLR0913
        self,
        item: _Prepared,
        unit: _Unit,
        rows: np.ndarray,
        labels: np.ndarray,
        groups: tuple[str, ...],
        extra: tuple[str, ...],
        *,
        reference: str | None,
        focal: str | None,
    ) -> _Model:
        """Build one model's population-aligned columns over its rows."""
        test = item.test
        pop = self.population
        n = self.n_population
        x = None
        if item.x is not None and test.variable is not None:
            x = np.full(n, math.nan)
            x[rows] = item.x[pop][rows]
            x = self._transform(
                x, rows, test.variable.transform, test.variable.ref.column
            )
        moderator = None
        levels: tuple[str, ...] = ()
        level_of = None
        if item.moderator is not None and test.moderator is not None:
            moderator = np.full(n, math.nan)
            moderator[rows] = item.moderator[pop][rows]
            moderator = self._transform(
                moderator, rows, test.moderator.transform, test.moderator.ref.column
            )
        elif item.levels is not None:
            level_of = np.array([None] * n, dtype=object)
            texts = [item.levels[i] for i in pop]
            for row in rows:
                level_of[row] = texts[row]
            levels = tuple(sorted({str(level_of[row]) for row in rows}))
        model = _Model(
            key=f"m{len(self.models) + 1}",
            test=test,
            unit=unit,
            rows=rows,
            labels=labels,
            groups=groups,
            reference=reference,
            focal=focal,
            x=x,
            moderator=moderator,
            levels=levels,
            level_of=level_of,
            extra=extra,
        )
        self.models.append(model)
        return model

    def _add_term(  # noqa: PLR0913
        self,
        design: _Design,
        role: str,
        label: str,
        hypothesis: tuple[str, ...],
        rank: int,
        pair: tuple[str, str] | None = None,
    ) -> _Term:
        term = _Term(
            index=len(self.terms),
            design=design,
            role=role,
            pair=pair,
            label=label[:160].strip() or design.model.test.id,
            kind="t" if rank == 1 else "F",
            rank=rank,
            hypothesis=hypothesis,
            family=None,
        )
        term.family = self._family(term)
        self.terms.append(term)
        design.terms.append(term.index)
        return term

    def _design(
        self, model: _Model, reference: str | None, *, heterogeneity: bool = False
    ) -> _Design:
        design = _Design(model=model, reference=reference, heterogeneity=heterogeneity)
        self.designs.append(design)
        return design

    def _pairs(
        self, test: AnalysisTest, groups: tuple[str, ...]
    ) -> list[tuple[str, str]]:
        assert test.factor is not None  # noqa: S101 - omnibus tests have one
        reference = test.factor.reference
        pairs = [(g, reference) for g in groups if g != reference]
        if test.pairwise == "all-pairs":
            others = [g for g in groups if g != reference]
            pairs += [
                (later, earlier)
                for position, earlier in enumerate(others)
                for later in others[position + 1 :]
            ]
        return pairs

    def _effect_hypothesis(self, model: _Model) -> tuple[tuple[str, ...], int]:
        test = model.test
        reference = model.reference
        if test.kind == "two-group":
            return (f"group:{model.focal}",), 1
        if test.kind == "association":
            return ("tested",), 1
        indicators = tuple(f"group:{g}" for g in model.groups if g != reference)
        if test.kind == "omnibus":
            return indicators, len(indicators)
        if model.moderator is not None:
            products = tuple(f"product:{g[6:]}" for g in indicators)
            return products, len(products)
        levels = model.levels[1:]
        products = tuple(
            f"product:{g[6:]}:{level}" for g in indicators for level in levels
        )
        return products, max(1, len(products))

    def _add_test(
        self,
        item: _Prepared,
        unit: _Unit,
        rows: np.ndarray,
        labels: np.ndarray,
        extra: tuple[str, ...],
    ) -> tuple[_Model, tuple[str, ...]]:
        """Add one test's model, effect term, and pairwise terms in one unit."""
        test = item.test
        factor = test.factor
        reference = factor.reference if factor is not None else None
        model = self._model(
            item,
            unit,
            rows,
            labels,
            item.groups,
            extra,
            reference=reference,
            focal=factor.focal if factor is not None else None,
        )
        effect = self._design(model, reference)
        effect.detail = True
        hypothesis, rank = self._effect_hypothesis(model)
        self._add_term(effect, "effect", test.label, hypothesis, rank)
        if test.kind == "omnibus" and test.pairwise != "none":
            for pair in self._pairs(test, item.groups):
                self._add_term(
                    self._pair_design(item, model, effect, pair, extra),
                    "pairwise",
                    f"{pair[0]} vs {pair[1]}",
                    (f"group:{pair[0]}",),
                    1,
                    pair=pair,
                )
        return model, hypothesis

    def _pair_design(
        self,
        item: _Prepared,
        model: _Model,
        effect: _Design,
        pair: tuple[str, str],
        extra: tuple[str, ...],
    ) -> _Design:
        """Return a pair's design: reparametrized, or on its two groups alone."""
        factor = item.test.factor
        assert factor is not None  # noqa: S101 - omnibus tests have one
        if factor.model == "compared-groups":
            in_pair = np.isin(model.labels, list(pair))
            pair_model = self._model(
                item,
                model.unit,
                model.rows[in_pair[model.rows]],
                np.where(in_pair, model.labels, None),
                tuple(g for g in item.groups if g in pair),
                extra,
                reference=pair[1],
                focal=pair[0],
            )
            design = self._design(pair_model, pair[1])
            design.detail = True
            return design
        if pair[1] == factor.reference:
            return effect
        existing = next(
            (
                d
                for d in self.designs
                if d.model is model and d.reference == pair[1] and not d.heterogeneity
            ),
            None,
        )
        return existing or self._design(model, pair[1])

    def _add_heterogeneity(
        self, model: _Model, hypothesis: tuple[str, ...], strata: np.ndarray
    ) -> None:
        """Add the pooled test x stratum interaction of one test."""
        stratify = self.spec.stratify
        assert stratify is not None  # noqa: S101
        model.strata = strata
        present = [
            g.label
            for g in stratify.grouping.groups
            if (strata[model.rows] == g.label).any()
        ]
        design = self._design(model, model.reference, heterogeneity=True)
        hetero = tuple(
            f"{name}|stratum:{label}" for name in hypothesis for label in present[1:]
        )
        self._add_term(
            design,
            "heterogeneity",
            f"Heterogeneity of {model.test.label} across strata",
            hetero,
            max(1, len(hetero)),
        )

    def _family(self, term: _Term) -> str | None:
        test = term.test
        if not test.inFamily:
            return None
        setting = self.spec.inference.family
        by_test = setting in {"per-test", "per-test-and-measure-family"}
        if term.role == "pairwise":
            if test.pairwiseFamily == "pooled":
                base = f"{test.id}:pairs"
            else:
                pairs = self._pairs(
                    test, tuple(g.label for g in test.factor.grouping.groups)
                )  # type: ignore[union-attr]
                base = f"{test.id}:pair-{pairs.index(term.pair) + 1}"  # type: ignore[arg-type]
        elif term.role == "heterogeneity":
            base = f"{test.id}:heterogeneity"
        elif test.kind == "interaction" or by_test:
            base = test.id
        else:
            base = "all-tests"
        if self.spec.stratify is not None:
            base = f"{term.design.model.unit.key}:{base}"
        if self.spec.inference.correction == "maxt-fwe":
            base = f"{base}:{term.kind}{term.rank}"
        return base

    # ------------------------------------------------------------- fit --
    def _make_blocks(self, design: _Design) -> None:
        model = design.model
        rows_mask = np.zeros(self.n_population, dtype=bool)
        rows_mask[model.rows] = True
        by_key: dict[tuple[bytes, tuple[str, ...]], _Block] = {}
        for k in range(len(self.measure_ids)):
            covariates = (
                tuple(
                    key
                    for key in self.data.covariates
                    if key != HEAD_SIZE_KEY or self.takes_head[k]
                )
                + model.extra
            )
            ok = rows_mask & ~np.isnan(self.values[:, k])
            for key in covariates:
                ok &= ~np.isnan(self.covariate_values[key])
            rows = np.flatnonzero(ok)
            block_key = (rows.tobytes(), covariates)
            block = by_key.get(block_key)
            if block is None:
                block = _Block(rows=rows, covariates=covariates, measures=[])
                by_key[block_key] = block
                design.blocks.append(block)
            block.measures.append(k)

    def _skip(
        self, measures: list[int], reason: str, design: _Design, term: _Term | None
    ) -> None:
        """Record skipped measures; name the test when the design has several."""
        if len(self.spec.tests) > 1 or self.spec.stratify is not None:
            where = design.model.test.label
            if design.model.unit.stratum is not None:
                where = f"{where} ({design.model.unit.stratum})"
            if term is not None and term.role != "effect":
                where = f"{where}, {term.label}"
            reason = f"{where}: {reason}"[:512]
        self.skipped.extend(
            {"measureId": self.measure_ids[k], "reason": reason} for k in measures
        )

    def _guard(self, design: _Design, block: _Block) -> str | None:  # noqa: PLR0911, PLR0912
        model = design.model
        test = model.test
        labels = model.labels[block.rows]
        minimum = self.min_cell
        word = _count(minimum)
        if test.kind == "two-group":
            for label in (model.focal, model.reference):
                if int((labels == label).sum()) < minimum:
                    return f"Fewer than {word} subjects of {label} have this measure."
        elif test.kind in {"omnibus", "interaction"}:
            for label in model.groups:
                if int((labels == label).sum()) < minimum:
                    return f"Fewer than {word} subjects of {label} have this measure."
        if model.x is not None:
            x = model.x[block.rows]
            if len(x) == 0 or np.ptp(x) == 0:
                return (
                    "The tested variable is constant among the subjects with "
                    "this measure."
                )
        if test.kind == "interaction":
            if model.moderator is not None:
                m = model.moderator[block.rows]
                for label in model.groups:
                    within = m[labels == label]
                    if len(within) < _MIN_MODERATOR_GROUP or np.ptp(within) == 0:
                        return (
                            f"The moderator needs three or more varying values in "
                            f"{label} among the subjects with this measure."
                        )
            else:
                assert model.level_of is not None  # noqa: S101
                levels = model.level_of[block.rows]
                if len(set(levels.tolist())) < 2:  # noqa: PLR2004
                    return (
                        "The moderator has one level among the subjects with this "
                        "measure."
                    )
                for label in model.groups:
                    for level in model.levels:
                        if not ((labels == label) & (levels == level)).any():
                            return (
                                f"No subject of {label} at moderator level {level} "
                                "has this measure."
                            )
        if design.heterogeneity:
            assert model.strata is not None  # noqa: S101
            if len(set(model.strata[block.rows].tolist())) < 2:  # noqa: PLR2004
                return "Fewer than two strata have this measure."
        return None

    def _build(self, design: _Design, block: _Block) -> str | None:
        """Build the block's design; return a skip reason instead when unusable."""
        reason = self._guard(design, block)
        if reason is not None:
            return reason
        model = design.model
        rows = block.rows
        labels = model.labels[rows]
        columns: list[np.ndarray] = [np.ones(len(rows))]
        names = ["Intercept"]
        if model.x is not None:
            x = model.x[rows]
            columns.append(x - x.mean())
            names.append("tested")
        indicators: list[tuple[str, np.ndarray]] = []
        for label in model.groups:
            if label == design.reference:
                continue
            indicator = (labels == label).astype(float)
            if indicator.any():
                indicators.append((label, indicator))
                columns.append(indicator)
                names.append(f"group:{label}")
        if model.test.kind == "interaction":
            self._moderator_columns(model, rows, indicators, columns, names)
        if design.heterogeneity:
            self._stratum_columns(model, rows, columns, names)
        for key in block.covariates:
            values = self.covariate_values[key][rows]
            if len(values) and np.ptp(values) > 0:
                block.covariate_columns.append(len(columns))
                columns.append(values - values.mean())
                names.append(f"covariate:{key}")
        x_matrix = np.column_stack(columns)
        n, p = x_matrix.shape
        if n - p < 1:
            return too_few_subjects(p, n)
        q, r = np.linalg.qr(x_matrix)
        # Every column is nonzero here, so compare R's diagonal to its norm.
        diagonal = np.abs(np.diag(r))
        if (diagonal <= _RANK_TOLERANCE * np.linalg.norm(x_matrix, axis=0)).any():
            return "The model is rank deficient for the subjects with this measure."
        block.x = x_matrix
        block.names = names
        block.df = n - p
        block.q = q
        block.r_inv = np.linalg.solve(r, np.eye(p))
        return None

    @staticmethod
    def _moderator_columns(
        model: _Model,
        rows: np.ndarray,
        indicators: list[tuple[str, np.ndarray]],
        columns: list[np.ndarray],
        names: list[str],
    ) -> None:
        """Append the centered moderator (or level indicators) and products."""
        if model.moderator is not None:
            m = model.moderator[rows]
            m_c = m - m.mean()
            columns.append(m_c)
            names.append("moderator")
            for label, indicator in indicators:
                columns.append(indicator * m_c)
                names.append(f"product:{label}")
            return
        assert model.level_of is not None  # noqa: S101
        level_of = model.level_of[rows]
        dummies = []
        for level in model.levels[1:]:
            dummy = (level_of == level).astype(float)
            dummy = dummy - dummy.mean()
            dummies.append((level, dummy))
            columns.append(dummy)
            names.append(f"level:{level}")
        for label, indicator in indicators:
            for level, dummy in dummies:
                columns.append(indicator * dummy)
                names.append(f"product:{label}:{level}")

    def _stratum_columns(
        self,
        model: _Model,
        rows: np.ndarray,
        columns: list[np.ndarray],
        names: list[str],
    ) -> None:
        """Append the stratum indicators and every tested column x stratum."""
        assert model.strata is not None  # noqa: S101
        assert self.spec.stratify is not None  # noqa: S101
        strata = model.strata[rows]
        present = [
            g.label
            for g in self.spec.stratify.grouping.groups
            if (strata == g.label).any()
        ]
        tested = list(zip(names[1:], columns[1:], strict=True))
        for label in present[1:]:
            indicator = (strata == label).astype(float)
            columns.append(indicator)
            names.append(f"stratum:{label}")
            for name, column in tested:
                columns.append(column * indicator)
                names.append(f"{name}|stratum:{label}")

    def _drop_exact_fits(self, block: _Block) -> None:
        """Skip measures the design fits exactly (a constant measure, say)."""
        assert block.q is not None  # noqa: S101
        y = self.values[np.ix_(block.rows, block.measures)]
        residual = y - block.q @ (block.q.T @ y)
        exact = np.sqrt((residual**2).sum(axis=0)) <= _EXACT_FIT * np.sqrt(
            (y**2).sum(axis=0)
        )
        for k in [k for k, flag in zip(block.measures, exact, strict=True) if flag]:
            self.skipped.append(
                {
                    "measureId": self.measure_ids[k],
                    "reason": "The measure is constant or fitted exactly by the model.",
                }
            )
            block.measures.remove(k)

    def _fit_block(self, design: _Design, block: _Block) -> None:
        assert block.x is not None  # noqa: S101
        assert block.q is not None  # noqa: S101
        assert block.r_inv is not None  # noqa: S101
        q, r_inv, df = block.q, block.r_inv, block.df
        y = self.values[np.ix_(block.rows, block.measures)]
        qty = q.T @ y
        beta = r_inv @ qty
        residual = y - q @ qty
        s2 = (residual**2).sum(axis=0) / df
        xtx_inv = r_inv @ r_inv.T
        leverage = (q**2).sum(axis=1)
        free = leverage < 1.0 - _LEVERAGE_ONE
        weights = np.zeros_like(residual)
        weights[free] = (residual[free] / (1.0 - leverage[free])[:, None]) ** 2
        a_matrix = r_inv @ q.T
        model = design.model
        labels = model.labels[block.rows]
        if design.detail:
            self._detail(design, block, y, beta, s2, xtx_inv, labels)
        for index in design.terms:
            term = self.terms[index]
            missing = [name for name in term.hypothesis if name not in block.names]
            if missing or not term.hypothesis:
                self._skip(block.measures, _UNESTIMABLE, design, term)
                continue
            columns = [block.names.index(name) for name in term.hypothesis]
            block.columns[index] = columns
            block.fitted[index] = list(block.measures)
            if term.rank == 1:
                self._fit_t(
                    term,
                    block,
                    columns[0],
                    y,
                    beta,
                    s2,
                    xtx_inv,
                    weights,
                    a_matrix,
                    labels,
                )
            else:
                self._fit_f(term, block, columns, beta, s2, xtx_inv, weights, a_matrix)

    def _fit_t(  # noqa: PLR0913
        self,
        term: _Term,
        block: _Block,
        j: int,
        y: np.ndarray,
        beta: np.ndarray,
        s2: np.ndarray,
        xtx_inv: np.ndarray,
        weights: np.ndarray,
        a_matrix: np.ndarray,
        labels: np.ndarray,
    ) -> None:
        df = block.df
        vjj = float(xtx_inv[j, j])
        t = beta[j] / np.sqrt(s2 * vjj)
        p = _p_value(t, df, self.sidedness)
        # HC3: rows with leverage 1 have residual 0 and weight 0 in beta_j.
        a_j = a_matrix[j]
        p_hc3 = _p_value(beta[j] / np.sqrt((a_j**2) @ weights), df, self.sidedness)
        model = term.design.model
        test = model.test
        group_test = term.role != "heterogeneity" and test.kind in {
            "two-group",
            "omnibus",
        }
        focal, reference = term.pair or (model.focal, model.reference)
        x_sd = None
        if term.role == "effect" and test.kind == "association":
            assert model.x is not None  # noqa: S101
            used = model.x[block.rows]
            x_sd = float(used.std(ddof=1)) if len(used) > 1 else None
        for column, k in enumerate(block.measures):
            t_value = float(t[column])
            partial_r = t_value / math.sqrt(t_value**2 + df)
            low_r, high_r = _fisher_interval(partial_r, df)
            fit: dict[str, Any] = {
                "rows": block.rows,
                "estimate": float(beta[j, column]),
                "se": float(math.sqrt(s2[column] * vjj)),
                "t": t_value,
                "F": None,
                "df": df,
                "p": float(p[column]),
                "pHc3": float(p_hc3[column]),
                "partialEta2": float(t[column] ** 2 / (t[column] ** 2 + df)),
                "partialR": partial_r,
                "partialRLow": low_r,
                "partialRHigh": high_r,
                "slopePerSd": (
                    float(beta[j, column]) * x_sd if x_sd is not None else None
                ),
            }
            if group_test:
                fit.update(
                    self._group_effect(fit, y[:, column], labels, vjj, focal, reference)
                )
            term.fits[k] = fit

    def _fit_f(  # noqa: PLR0913
        self,
        term: _Term,
        block: _Block,
        columns: list[int],
        beta: np.ndarray,
        s2: np.ndarray,
        xtx_inv: np.ndarray,
        weights: np.ndarray,
        a_matrix: np.ndarray,
    ) -> None:
        df = block.df
        rank = len(columns)
        v_ss = xtx_inv[np.ix_(columns, columns)]
        chol = np.linalg.cholesky(np.linalg.inv(v_ss))
        block.chol[term.index] = chol
        b_s = beta[columns]
        u = chol.T @ b_s
        f_values = (u**2).sum(axis=0) / rank / s2
        a_s = a_matrix[columns]
        hc3 = np.einsum("in,nk,jn->kij", a_s, weights, a_s)
        for column, k in enumerate(block.measures):
            f_value = float(f_values[column])
            p_hc3: float | None
            try:
                wald = (
                    float(b_s[:, column] @ np.linalg.solve(hc3[column], b_s[:, column]))
                    / rank
                )
                p_hc3 = (
                    distributions.f_sf(wald, rank, df) if math.isfinite(wald) else None
                )
            except np.linalg.LinAlgError:
                p_hc3 = None
            term.fits[k] = {
                "rows": block.rows,
                "estimate": None,
                "se": None,
                "t": None,
                "F": f_value,
                "df": df,
                "p": distributions.f_sf(f_value, rank, df),
                "pHc3": p_hc3,
                "partialEta2": rank * f_value / (rank * f_value + df),
                "partialR": None,
                "partialRLow": None,
                "partialRHigh": None,
                "slopePerSd": None,
            }

    def _group_effect(  # noqa: PLR0913
        self,
        fit: dict[str, Any],
        values: np.ndarray,
        labels: np.ndarray,
        vjj: float,
        focal: str | None,
        reference: str | None,
    ) -> dict[str, Any]:
        """Return the group counts, adjusted and raw-SD d, and percentage."""
        focal_values = values[labels == focal]
        reference_values = values[labels == reference]
        pooled = math.sqrt(
            (
                (len(focal_values) - 1) * focal_values.var(ddof=1)
                + (len(reference_values) - 1) * reference_values.var(ddof=1)
            )
            / (len(focal_values) + len(reference_values) - 2)
        )
        scale = math.sqrt(vjj)
        low, high = distributions.nct_interval(fit["t"], float(fit["df"]))
        reference_mean = float(reference_values.mean())
        return {
            "nFocal": len(focal_values),
            "nReference": len(reference_values),
            "d": fit["t"] * scale,
            "dLow": low * scale,
            "dHigh": high * scale,
            "dRawSd": fit["estimate"] / pooled if pooled > 0 else None,
            "pctOfReference": (
                100.0 * fit["estimate"] / reference_mean
                if reference_mean != 0
                else None
            ),
        }

    # ---------------------------------------------------------- detail --
    def _detail(  # noqa: PLR0913
        self,
        design: _Design,
        block: _Block,
        y: np.ndarray,
        beta: np.ndarray,
        s2: np.ndarray,
        xtx_inv: np.ndarray,
        labels: np.ndarray,
    ) -> None:
        """Keep the adjusted means, adjusted values, and line coefficients."""
        model = design.model
        entries = self.detail_models.setdefault(model.key, {})
        covariate_columns = block.covariate_columns
        assert block.x is not None  # noqa: S101
        adjustment = block.x[:, covariate_columns] @ beta[covariate_columns]
        t_quantile = distributions.t_ppf((1.0 + _CI_LEVEL) / 2.0, float(block.df))
        names = block.names
        for column, k in enumerate(block.measures):
            entries[self.measure_ids[k]] = {
                "groupMeans": self._group_means(
                    model,
                    names,
                    labels,
                    beta[:, column],
                    float(s2[column]),
                    xtx_inv,
                    t_quantile,
                ),
                "rows": block.rows.tolist(),
                "adjusted": (y[:, column] - adjustment[:, column]).tolist(),
                "s2": float(s2[column]),
                "df": block.df,
                "lines": self._lines(model, block, beta[:, column], xtx_inv, labels),
            }

    def _group_means(  # noqa: PLR0913
        self,
        model: _Model,
        names: list[str],
        labels: np.ndarray,
        beta: np.ndarray,
        s2: float,
        xtx_inv: np.ndarray,
        t_quantile: float,
    ) -> list[dict[str, Any]]:
        """Return the model-based group means at the covariate means."""
        means = []
        if model.test.factor is None:
            return means
        for label in model.groups:
            members = labels == label
            if not members.any():
                continue
            point = np.zeros(len(names))
            point[0] = 1.0
            name = f"group:{label}"
            if name in names:
                point[names.index(name)] = 1.0
            mean = float(point @ beta)
            half = t_quantile * math.sqrt(float(point @ xtx_inv @ point) * s2)
            role = (
                "focal"
                if label == model.focal
                else "reference"
                if label == model.reference
                else "other"
            )
            means.append(
                {
                    "label": label,
                    "role": role,
                    "n": int(members.sum()),
                    "mean": mean,
                    "low": mean - half,
                    "high": mean + half,
                }
            )
        return means

    def _lines(
        self,
        model: _Model,
        block: _Block,
        beta: np.ndarray,
        xtx_inv: np.ndarray,
        labels: np.ndarray,
    ) -> list[dict[str, Any]]:
        """Return the compact fitted lines (association, numeric interaction)."""
        names = block.names
        lines: list[dict[str, Any]] = []

        def line(
            group: str | None,
            base: np.ndarray,
            slope: np.ndarray,
            x: np.ndarray,
            center: float,
        ) -> None:
            lines.append(
                {
                    "group": group,
                    "xMin": float(x.min()),
                    "xMax": float(x.max()),
                    "xMean": center,
                    "intercept": float(base @ beta),
                    "slope": float(slope @ beta),
                    "v00": float(base @ xtx_inv @ base),
                    "v01": float(base @ xtx_inv @ slope),
                    "v11": float(slope @ xtx_inv @ slope),
                }
            )

        if model.test.kind == "association" and model.x is not None:
            x = model.x[block.rows]
            center = float(x.mean())
            base = np.zeros(len(names))
            base[0] = 1.0
            for index, name in enumerate(names):
                if name.startswith("group:"):
                    base[index] = float((labels == name[6:]).mean())
            slope = np.zeros(len(names))
            slope[names.index("tested")] = 1.0
            line(None, base, slope, x, center)
        elif model.test.kind == "interaction" and model.moderator is not None:
            m = model.moderator[block.rows]
            center = float(m.mean())
            for label in model.groups:
                base = np.zeros(len(names))
                base[0] = 1.0
                slope = np.zeros(len(names))
                slope[names.index("moderator")] = 1.0
                if f"group:{label}" in names:
                    base[names.index(f"group:{label}")] = 1.0
                    slope[names.index(f"product:{label}")] = 1.0
                line(label, base, slope, m[labels == label], center)
        return lines

    # ----------------------------------------------------- permutations --
    def _prepare_null(self, block: _Block, index: int) -> None:
        assert block.x is not None  # noqa: S101
        y = self.values[np.ix_(block.rows, block.fitted[index])]
        z = np.delete(block.x, block.columns[index], axis=1)
        qz, _ = np.linalg.qr(z)
        residual = y - qz @ (qz.T @ y)
        block.reduced[index] = (residual, (residual**2).sum(axis=0))

    def _null(self, term: _Term, block: _Block, perms: np.ndarray) -> np.ndarray:
        """Return the permuted statistic of the term's block measures, (b, m)."""
        assert block.q is not None  # noqa: S101
        assert block.r_inv is not None  # noqa: S101
        residual, reduced_ss = block.reduced[term.index]
        positions = induced_positions(perms, block.rows, self.n_population)
        w = project_permuted(block.q, residual, positions)
        rss = np.maximum(reduced_ss[None, :] - (w**2).sum(axis=1), 0.0)
        columns = block.columns[term.index]
        if term.rank == 1:
            j = columns[0]
            b_j = np.matmul(block.r_inv[j], w)
            vjj = float(block.r_inv[j] @ block.r_inv[j])
            with np.errstate(divide="ignore", invalid="ignore"):
                return _statistic(b_j / np.sqrt(rss / block.df * vjj), self.sidedness)
        chol = block.chol[term.index]
        b_s = np.matmul(block.r_inv[columns], w)
        u = np.matmul(chol.T, b_s)
        with np.errstate(divide="ignore", invalid="ignore"):
            return (u**2).sum(axis=1) / term.rank / (rss / block.df)

    def _permute(
        self, columns: list[tuple[int, int]], families: dict[Any, list[int]]
    ) -> tuple[np.ndarray, dict[Any, np.ndarray]]:
        """Return the uncorrected and family max-T permutation p values."""
        inference = self.spec.inference
        total = inference.permutations
        position = {key: i for i, key in enumerate(columns)}
        observed = np.array(
            [self._observed(self.terms[index], k) for index, k in columns]
        )
        work: list[tuple[_Term, _Block, np.ndarray]] = []
        for term in self.terms:
            for block in term.design.blocks:
                fitted = block.fitted.get(term.index, [])
                if not fitted:
                    continue
                self._prepare_null(block, term.index)
                work.append(
                    (
                        term,
                        block,
                        np.array(
                            [position[(term.index, k)] for k in fitted], dtype=np.int64
                        ),
                    )
                )
        exceed = np.zeros(len(columns), dtype=np.int64)
        family_columns = {
            name: np.array(members, dtype=np.int64)
            for name, members in families.items()
        }
        exceed_max = {
            name: np.zeros(len(members), dtype=np.int64)
            for name, members in family_columns.items()
        }
        chunk = min(
            PERMUTATION_CHUNK, max(_MIN_CHUNK, _CHUNK_CELLS // max(1, len(columns)))
        )
        done = 0
        self.progress("permuting", 0, total)
        for perms in permutation_chunks(
            inference.seed, self.n_population, total, chunk
        ):
            if self.cancelled():
                raise ComputeCancelled
            null = np.empty((len(perms), len(columns)))
            for term, block, targets in work:
                null[:, targets] = self._null(term, block, perms)
            exceed += (null >= observed[None, :]).sum(axis=0)
            for name, members in family_columns.items():
                family_max = null[:, members].max(axis=1)
                exceed_max[name] += (
                    family_max[:, None] >= observed[members][None, :]
                ).sum(axis=0)
            done += len(perms)
            self.progress("permuting", done, total)
        p_perm = (1.0 + exceed) / (1.0 + total)
        p_fwe = {
            name: (1.0 + count) / (1.0 + total) for name, count in exceed_max.items()
        }
        return p_perm, p_fwe

    def _observed(self, term: _Term, k: int) -> float:
        fit = term.fits[k]
        if term.rank == 1:
            return float(_statistic(np.array([fit["t"]]), self.sidedness)[0])
        return float(fit["F"])

    # --------------------------------------------------------------- run --
    def run(self) -> EngineOutputV2:
        self.detail_models: dict[str, dict[str, Any]] = {}
        for design in self.designs:
            self._make_blocks(design)
        if any(term.rank > 1 for term in self.terms) and self.sidedness != "two-sided":
            raise GroupAnalysisError(
                "Choose a two-sided test: an F test has no direction."
            )
        total = sum(len(block.measures) for d in self.designs for block in d.blocks)
        self.progress("fitting", 0, total)
        done = 0
        for design in self.designs:
            for block in design.blocks:
                if self.cancelled():
                    raise ComputeCancelled
                count = len(block.measures)
                reason = self._build(design, block)
                if reason is not None:
                    self._skip(block.measures, reason, design, None)
                    block.measures = []
                else:
                    self._drop_exact_fits(block)
                    if block.measures:
                        self._fit_block(design, block)
                done += count
                self.progress("fitting", done, total)
        columns = [
            (term.index, k)
            for term in self.terms
            for k in range(len(self.measure_ids))
            if k in term.fits
        ]
        families = self._families(columns)
        p_perm: np.ndarray | None = None
        p_fwe: dict[Any, np.ndarray] = {}
        if self.spec.inference.permutations > 0 and columns:
            p_perm, p_fwe = self._permute(columns, families)
        corrected = self._corrections(columns, families, p_fwe)
        return self._output(columns, corrected, p_perm)

    def _families(self, columns: list[tuple[int, int]]) -> dict[Any, list[int]]:
        split = self.spec.inference.family in {
            "per-measure-family",
            "per-test-and-measure-family",
        }
        families: dict[Any, list[int]] = {}
        for position, (index, k) in enumerate(columns):
            term = self.terms[index]
            if term.family is None:
                continue
            key = (term.family, measure_family(self.measure_ids[k]) if split else None)
            families.setdefault(key, []).append(position)
        return families

    def _corrections(
        self,
        columns: list[tuple[int, int]],
        families: dict[Any, list[int]],
        p_fwe: dict[Any, np.ndarray],
    ) -> list[float | None]:
        correction = self.spec.inference.correction
        corrected: list[float | None] = [None] * len(columns)
        if correction == "none":
            return corrected
        adjust = {"holm": holm, "bonferroni": bonferroni, "bh-fdr": bh}
        for name, members in families.items():
            if correction == "maxt-fwe":
                values = list(p_fwe[name])
            else:
                values = adjust[correction](
                    [
                        self.terms[columns[i][0]].fits[columns[i][1]]["p"]
                        for i in members
                    ]
                )
            for position, value in zip(members, values, strict=True):
                corrected[position] = float(value)
        return corrected

    def _output(
        self,
        columns: list[tuple[int, int]],
        corrected: list[float | None],
        p_perm: np.ndarray | None,
    ) -> EngineOutputV2:
        alpha = self.spec.inference.alpha
        correction = self.spec.inference.correction
        rows: list[dict[str, Any]] = []
        significant: dict[tuple[int, int], bool] = {}
        for position, (index, k) in enumerate(columns):
            term = self.terms[index]
            fit = term.fits[k]
            p_corrected = corrected[position]
            if term.family is None and correction != "none":
                decisive_ok = False
            else:
                decisive = fit["p"] if p_corrected is None else p_corrected
                decisive_ok = bool(decisive <= alpha)
            significant[(index, k)] = decisive_ok
            measure_id = self.measure_ids[k]
            rows.append(
                {
                    "termId": f"term-{index + 1}",
                    "measureId": measure_id,
                    "family": measure_family(measure_id),
                    "nTotal": len(fit["rows"]),
                    "nFocal": fit.get("nFocal"),
                    "nReference": fit.get("nReference"),
                    "estimate": fit["estimate"],
                    "se": fit["se"],
                    "t": fit["t"],
                    "F": fit["F"],
                    "df1": term.rank,
                    "df2": fit["df"],
                    "p": fit["p"],
                    "pCorrected": p_corrected,
                    "significant": decisive_ok,
                    "d": fit.get("d"),
                    "dLow": fit.get("dLow"),
                    "dHigh": fit.get("dHigh"),
                    "dRawSd": fit.get("dRawSd"),
                    "partialEta2": fit["partialEta2"],
                    "partialR": fit["partialR"],
                    "partialRLow": fit["partialRLow"],
                    "partialRHigh": fit["partialRHigh"],
                    "slopePerSd": fit["slopePerSd"],
                    "pctOfReference": fit.get("pctOfReference"),
                    "pHc3": fit["pHc3"],
                    "pPermutation": (
                        None if p_perm is None else float(p_perm[position])
                    ),
                    "gated": False,
                    "inFamily": term.test.inFamily,
                }
            )
        if self.spec.inference.omnibusGate:
            by_key = {(row["termId"], row["measureId"]): row for row in rows}
            for term in self.terms:
                if term.role != "pairwise":
                    continue
                effect = next(
                    other
                    for other in self.terms
                    if other.role == "effect"
                    and other.design.model.test is term.test
                    and other.design.model.unit == term.design.model.unit
                )
                for k in term.fits:
                    row = by_key[(f"term-{term.index + 1}", self.measure_ids[k])]
                    row["gated"] = not significant.get((effect.index, k), False)
        counts: dict[int, int] = {}
        for index, _k in columns:
            counts[index] = counts.get(index, 0) + 1
        terms = [
            {
                "termId": f"term-{term.index + 1}",
                "testId": term.test.id,
                "kind": term.kind,
                "rank": term.rank,
                "role": term.role,
                "label": term.label,
                "family": term.family,
                "stratum": term.design.model.unit.stratum,
                "pair": (
                    None
                    if term.pair is None
                    else {"focal": term.pair[0], "reference": term.pair[1]}
                ),
                "rowCount": counts.get(term.index, 0),
            }
            for term in self.terms
        ]
        return EngineOutputV2(
            terms=terms,
            rows=rows,
            skipped=self.skipped,
            detail=self._detail_record(),
        )

    def _detail_record(self) -> dict[str, Any]:
        pop = self.population
        ids = [self.data.subject_ids[i] for i in pop]
        used = {
            measure for entries in self.detail_models.values() for measure in entries
        }
        values = {
            measure_id: [None if math.isnan(v) else float(v) for v in self.values[:, k]]
            for k, measure_id in enumerate(self.measure_ids)
            if measure_id in used
        }
        models = {}
        for model in self.models:
            x = model.x if model.x is not None else model.moderator
            models[model.key] = {
                "testId": model.test.id,
                "stratum": model.unit.stratum,
                "focal": model.focal,
                "reference": model.reference,
                "labels": [
                    None if v is None else str(v) for v in model.labels.tolist()
                ],
                "x": (
                    None
                    if x is None
                    else [None if math.isnan(v) else float(v) for v in x.tolist()]
                ),
                "measures": self.detail_models.get(model.key, {}),
            }
        detail_of = {
            f"term-{term.index + 1}": term.design.model.key for term in self.terms
        }
        return {
            "subjectIds": ids,
            "sourceLabels": list(self.source_labels),
            "values": values,
            "models": models,
            "terms": detail_of,
            "subjectValues": True,
        }


def run(
    data: EngineDataV2,
    spec: GroupAnalysisSpecV2,
    *,
    progress: Progress,
    cancelled: Callable[[], bool],
) -> EngineOutputV2:
    """Fit every test and measure and apply the chosen correction.

    Parameters
    ----------
    spec
        The validated spec v2.
    progress
        Called with the phase (``fitting``, ``permuting``) and counts.
    cancelled
        Polled between blocks and permutation chunks; a true answer stops the
        compute.

    Returns
    -------
    EngineOutputV2
        The terms, rows, skips, and measure detail.

    Raises
    ------
    ComputeCancelled
        When ``cancelled`` answers true.
    GroupAnalysisError
        When the input lacks a value the specification needs.
    """
    return _EngineV2(data, spec, progress, cancelled).run()
