"""The model and inference engine (``ols-freedman-lane-maxt-v1``).

One OLS fit per availability block with a shared design; group indicators as
in ``design()`` of the reference implementation
(``analyses/lib/family_models.py``), generalized; covariates centered per
block. Each row carries beta, SE, t, df, p by sidedness, the adjusted d with
a noncentral-t 95% CI, the raw-SD d, partial eta squared, the percentage of
the reference mean, and an HC3 sensitivity p. Corrections: BH, Holm, Bonferroni, and
Freedman-Lane max-T (Winkler 2014) with ``numpy.random.Generator(PCG64(seed))``
permutations, p = (1 + #null >= obs) / (1 + B), run in chunks that check for
cancellation.

The model
---------
The master sample is every dataset subject the contrast can use, in subject
ID order (the permutation index):

- A group comparison models every defined group (``all-groups``, a
  pooled residual variance) or only the focal and
  reference groups (``compared-groups``). The design is an intercept, one
  indicator per modeled group except the reference (in definition order),
  then the covariates; the tested coefficient is the focal indicator, so the
  estimate is focal minus reference. Brain age is this comparison on Brain-PAD.
- An association uses the included groups (every subject without a
  grouping). The design is an intercept, the tested variable (centered), an
  indicator per included group except the first when adjusting for group,
  then the covariates; the tested coefficient is the slope.

``Dataset.groups`` holds each subject's specification group label (levels
already merged), or None outside every group. ``Dataset.covariates`` holds
exactly the model covariates in design order;
the key :data:`ETIV_KEY` is the head-size covariate, which a measure takes
only under the specification's eTIV rule (``extensive``: the measures
:func:`spec.is_extensive` names; ``all``; ``none``), and never
``global:eTIV`` itself. Sex and any categorical covariate arrive numerically
coded.

A measure is fitted on its complete cases (its value and every covariate of
its design present); measures with the same rows and covariates share one
block and one design matrix. A covariate constant within a block is dropped
(it is absorbed by the intercept), as is an indicator of a non-compared
group with no subject in the block. A measure is skipped with a reason when
the focal or reference group has fewer than two subjects, the tested
variable is constant, the design is rank deficient, no residual degree of
freedom is left, or the design fits the measure exactly (a constant
measure).

Permutations
------------
Each permutation of the master index is restricted to a block's rows by
keeping the order in which those subjects appear (induced positions,
as ``induced_positions`` in the reference implementation): a uniformly
random permutation of the block, equal to the full permutation when nothing
is missing. Freedman-Lane permutes
the reduced-model residuals (Winkler et al. 2014); the permuted t is
``b_j / sqrt(RSS / df * v_jj)`` with ``b_j`` and ``RSS`` from the full
design. The statistic is ``|t|`` two-sided, ``t`` for ``higher``, and
``-t`` for ``lower``; max-T takes the family maximum of that statistic.
A row is significant when its corrected p (its p without a correction) is
at most alpha.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from . import distributions
from .dataset import Dataset, too_few_subjects
from .spec import (
    AssociationContrast,
    GroupAnalysisError,
    GroupAnalysisSpec,
    GroupContrast,
    is_extensive,
    measure_family,
)

#: The ``Dataset.covariates`` key of the head-size covariate.
ETIV_KEY = "eTIV"
#: The permutations one chunk evaluates between cancellation checks.
PERMUTATION_CHUNK = 500

_ETIV_MEASURE = "global:eTIV"
_CI_LEVEL = 0.95
_MIN_GROUP_N = 2
_RANK_TOLERANCE = 1e-10
_LEVERAGE_ONE = 1e-10
_EXACT_FIT = 1e-12

#: Report progress as (phase, completed, total).
Progress = Callable[[str, int, int], None]


class ComputeCancelled(Exception):
    """Stop a compute whose cancellation callback answered true."""


@dataclass
class EngineOutput:
    """Hold one compute's rows and the per-measure detail."""

    #: ``GroupAnalysisRow`` rows in specification order.
    rows: list[dict[str, Any]]
    #: ``AnalysisGroupMean`` rows by measure ID.
    group_means: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    #: ``AnalysisSubjectValue`` rows by measure ID.
    subject_values: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    #: ``AnalysisSkippedMeasure`` rows the fit added (for example rank loss).
    skipped: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class _Model:
    """Hold the resolved contrast: master rows, design groups, tested term."""

    #: Dataset indices of the master sample, in subject ID order.
    master: np.ndarray
    #: Group label per master row ("" when the model uses no groups).
    labels: np.ndarray
    #: Group labels that get an indicator column, in design order.
    indicator_groups: tuple[str, ...]
    #: Group labels whose adjusted means are reported, in definition order.
    mean_groups: tuple[str, ...]
    focal: str | None
    reference: str | None
    #: The tested variable per master row (association), else None.
    tested: np.ndarray | None


@dataclass
class _Block:
    """Hold one availability block's design and fitted quantities."""

    rows: np.ndarray
    covariates: tuple[str, ...]
    measures: list[int]
    #: Design columns of the covariates the block kept.
    covariate_columns: list[int] = field(default_factory=list)
    x: np.ndarray | None = None
    names: list[str] = field(default_factory=list)
    j: int = 0
    df: int = 0
    q: np.ndarray | None = None
    r_inv: np.ndarray | None = None
    residual_reduced: np.ndarray | None = None
    reduced_ss: np.ndarray | None = None


def permutation_chunks(
    seed: int, n: int, count: int, chunk: int = PERMUTATION_CHUNK
) -> Iterator[np.ndarray]:
    """Yield the permutations of ``range(n)`` in chunks of at most ``chunk``.

    The stream is ``Generator(PCG64(seed)).permutation(n)`` drawn ``count``
    times; chunking does not change it.

    Parameters
    ----------
    seed
        The PCG64 seed.
    n
        The master sample size.
    chunk
        The largest chunk.

    Yields
    ------
    numpy.ndarray
        An integer array of shape ``(size, n)``.
    """
    rng = np.random.Generator(np.random.PCG64(seed))
    done = 0
    while done < count:
        size = min(chunk, count - done)
        yield np.stack([rng.permutation(n) for _ in range(size)])
        done += size


def induced_positions(perms: np.ndarray, rows: np.ndarray, n_master: int) -> np.ndarray:
    """Restrict master permutations to the sorted master ``rows``.

    Parameters
    ----------
    perms
        Permutations of the master index, shape ``(b, n_master)``.
    rows
        The block's master rows, ascending.
    n_master
        The master sample size.

    Returns
    -------
    numpy.ndarray
        Positions into ``rows``, shape ``(b, len(rows))``: row ``k`` lists the
        block rows in the order they appear in permutation ``k``.
    """
    if len(rows) == n_master:
        return perms
    lookup = np.full(n_master, -1, dtype=np.int64)
    lookup[rows] = np.arange(len(rows))
    mapped = lookup[perms]
    return mapped[mapped >= 0].reshape(len(perms), len(rows))


def project_permuted(q: np.ndarray, e: np.ndarray, positions: np.ndarray) -> np.ndarray:
    """Return ``W_b = Q' E[pos_b]`` for every permutation ``b``.

    Parameters
    ----------
    q
        The full design's orthonormal basis, shape ``(n, p)``.
    e
        The reduced-model residuals, shape ``(n, m)``.
    positions
        Permuted row positions, shape ``(b, n)``.

    Returns
    -------
    numpy.ndarray
        Shape ``(b, p, m)``.
    """
    size, n = positions.shape
    p = q.shape[1]
    m = e.shape[1]
    if m <= p:
        # W_b = Q' E[pos_b]: gather the residual rows.
        return np.matmul(q.T, e[positions])
    # Q' E[pos] = Q[inv]' E with inv the inverse permutation.
    inverse = np.empty_like(positions)
    np.put_along_axis(
        inverse,
        positions,
        np.broadcast_to(np.arange(n), positions.shape),
        axis=1,
    )
    gathered = q[inverse]  # (b, n, p)
    return (gathered.transpose(0, 2, 1).reshape(size * p, n) @ e).reshape(size, p, m)


def _as_float(values: Sequence[float | None], name: str) -> np.ndarray:
    out = np.array([math.nan if v is None else float(v) for v in values], dtype=float)
    if np.isinf(out).any():
        raise GroupAnalysisError(f"Remove the infinite entries in {name}.")
    return out


def _resolve_model(dataset: Dataset, spec: GroupAnalysisSpec) -> _Model:
    ids = dataset.subject_ids
    order = sorted(range(len(ids)), key=lambda index: ids[index])
    groups = dataset.groups
    contrast = spec.contrast
    if isinstance(contrast, GroupContrast):
        defined = [group.label for group in contrast.grouping.groups]
        modeled = (
            defined
            if contrast.model == "all-groups"
            else [g for g in defined if g in (contrast.focal, contrast.reference)]
        )
        master = [i for i in order if groups[i] in modeled]
        return _Model(
            master=np.array(master, dtype=np.int64),
            labels=np.array([groups[i] for i in master], dtype=object),
            indicator_groups=tuple(g for g in modeled if g != contrast.reference),
            mean_groups=tuple(modeled),
            focal=contrast.focal,
            reference=contrast.reference,
            tested=None,
        )
    assert isinstance(contrast, AssociationContrast)  # noqa: S101 - the union
    if dataset.tested is None:
        raise GroupAnalysisError("Provide the tested variable of the association.")
    tested = _as_float(dataset.tested, "the tested variable")
    if contrast.grouping is None:
        master = [i for i in order if not math.isnan(tested[i])]
        labels = np.array([""] * len(master), dtype=object)
        return _Model(
            master=np.array(master, dtype=np.int64),
            labels=labels,
            indicator_groups=(),
            mean_groups=(),
            focal=None,
            reference=None,
            tested=tested[master],
        )
    defined = [group.label for group in contrast.grouping.groups]
    included = [g for g in defined if g in contrast.includedGroups]
    master = [i for i in order if groups[i] in included and not math.isnan(tested[i])]
    adjust = contrast.adjustForGroup
    return _Model(
        master=np.array(master, dtype=np.int64),
        labels=np.array([groups[i] for i in master], dtype=object),
        indicator_groups=tuple(included[1:]) if adjust else (),
        mean_groups=tuple(included) if adjust else (),
        focal=None,
        reference=included[0] if adjust else None,
        tested=tested[master],
    )


def _covariates_for(
    measure_id: str, keys: Sequence[str], etiv_rule: str
) -> tuple[str, ...]:
    takes_etiv = (
        measure_id != _ETIV_MEASURE
        and etiv_rule != "none"
        and (etiv_rule == "all" or is_extensive(measure_id))
    )
    if takes_etiv and ETIV_KEY not in keys:
        raise GroupAnalysisError("Provide eTIV for the eTIV adjustment.")
    return tuple(key for key in keys if key != ETIV_KEY or takes_etiv)


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


class _Engine:
    """Run one specification over one dataset."""

    def __init__(
        self,
        dataset: Dataset,
        spec: GroupAnalysisSpec,
        progress: Progress,
        cancelled: Callable[[], bool],
    ) -> None:
        self.dataset = dataset
        self.spec = spec
        self.progress = progress
        self.cancelled = cancelled
        self.model = _resolve_model(dataset, spec)
        self.n_master = len(self.model.master)
        keys = list(dataset.covariates)
        self.covariate_values = {
            key: _as_float(dataset.covariates[key], f"covariate {key}")[
                self.model.master
            ]
            for key in keys
        }
        self.measure_ids = [m for m in spec.measures if m in dataset.measures]
        self.values = (
            np.column_stack(
                [
                    _as_float(dataset.measures[m], m)[self.model.master]
                    for m in self.measure_ids
                ]
            )
            if self.measure_ids
            else np.empty((self.n_master, 0))
        )
        self.covariate_sets = [
            _covariates_for(m, keys, spec.covariates.etiv) for m in self.measure_ids
        ]
        self.skipped: list[dict[str, Any]] = []
        self.fits: dict[int, dict[str, Any]] = {}
        self.blocks: list[_Block] = []

    # ----------------------------------------------------------- blocks --
    def _make_blocks(self) -> None:
        tested_ok = (
            np.ones(self.n_master, dtype=bool)
            if self.model.tested is None
            else ~np.isnan(self.model.tested)
        )
        by_key: dict[tuple[bytes, tuple[str, ...]], _Block] = {}
        for k, covariates in enumerate(self.covariate_sets):
            ok = tested_ok & ~np.isnan(self.values[:, k])
            for key in covariates:
                ok &= ~np.isnan(self.covariate_values[key])
            rows = np.flatnonzero(ok)
            block_key = (rows.tobytes(), covariates)
            block = by_key.get(block_key)
            if block is None:
                block = _Block(rows=rows, covariates=covariates, measures=[])
                by_key[block_key] = block
                self.blocks.append(block)
            block.measures.append(k)

    def _skip(self, block: _Block, reason: str) -> None:
        self.skipped.extend(
            {"measureId": self.measure_ids[k], "reason": reason} for k in block.measures
        )
        block.measures = []

    def _design(self, block: _Block) -> str | None:
        """Build the block's design; return a skip reason instead when unusable."""
        rows = block.rows
        model = self.model
        labels = model.labels[rows]
        columns: list[np.ndarray] = [np.ones(len(rows))]
        names = ["Intercept"]
        if model.focal is not None:
            for label in (model.focal, model.reference):
                if int((labels == label).sum()) < _MIN_GROUP_N:
                    return f"Fewer than two subjects of {label} have this measure."
        if model.tested is not None:
            x = model.tested[rows]
            if len(x) == 0 or np.ptp(x) == 0:
                return (
                    "The tested variable is constant among the subjects with "
                    "this measure."
                )
            columns.append(x - x.mean())
            names.append("tested")
        for label in model.indicator_groups:
            indicator = (labels == label).astype(float)
            if indicator.any():
                columns.append(indicator)
                names.append(f"group:{label}")
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
        tested_name = f"group:{model.focal}" if model.tested is None else "tested"
        block.x = x_matrix
        block.names = names
        block.j = names.index(tested_name)
        block.df = n - p
        block.q = q
        block.r_inv = np.linalg.solve(r, np.eye(p))
        return None

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

    # -------------------------------------------------------------- fit --
    def _fit_block(self, block: _Block) -> None:
        assert block.x is not None  # noqa: S101
        assert block.q is not None  # noqa: S101
        assert block.r_inv is not None  # noqa: S101
        sidedness = self.spec.inference.sidedness
        q, r_inv, j, df = block.q, block.r_inv, block.j, block.df
        y = self.values[np.ix_(block.rows, block.measures)]
        qty = q.T @ y
        beta = r_inv @ qty
        residual = y - q @ qty
        s2 = (residual**2).sum(axis=0) / df
        xtx_inv = r_inv @ r_inv.T
        vjj = float(xtx_inv[j, j])
        t = beta[j] / np.sqrt(s2 * vjj)
        p = _p_value(t, df, sidedness)
        # HC3: rows with leverage 1 have residual 0 and weight 0 in beta_j.
        a_j = (r_inv @ q.T)[j]
        leverage = (q**2).sum(axis=1)
        free = leverage < 1.0 - _LEVERAGE_ONE
        weights = np.zeros_like(residual)
        weights[free] = (residual[free] / (1.0 - leverage[free])[:, None]) ** 2
        p_hc3 = _p_value(beta[j] / np.sqrt((a_j**2) @ weights), df, sidedness)
        labels = self.model.labels[block.rows]
        covariate_columns = block.covariate_columns
        adjustment = block.x[:, covariate_columns] @ beta[covariate_columns]
        for column, k in enumerate(block.measures):
            values = y[:, column]
            fit: dict[str, Any] = {
                "rows": block.rows,
                "estimate": float(beta[j, column]),
                "se": float(math.sqrt(s2[column] * vjj)),
                "t": float(t[column]),
                "df": df,
                "p": float(p[column]),
                "pHc3": float(p_hc3[column]),
                "partialEta2": float(t[column] ** 2 / (t[column] ** 2 + df)),
                "groupMeans": self._group_means(
                    block, labels, beta[:, column], float(s2[column]), xtx_inv
                ),
                "adjusted": values - adjustment[:, column],
            }
            if self.model.tested is None:
                fit.update(self._group_effect(fit, values, labels, vjj))
            self.fits[k] = fit

    def _group_effect(
        self, fit: dict[str, Any], values: np.ndarray, labels: np.ndarray, vjj: float
    ) -> dict[str, Any]:
        """Return the group counts, adjusted and raw-SD d, and percentage."""
        focal = values[labels == self.model.focal]
        reference = values[labels == self.model.reference]
        pooled = math.sqrt(
            (
                (len(focal) - 1) * focal.var(ddof=1)
                + (len(reference) - 1) * reference.var(ddof=1)
            )
            / (len(focal) + len(reference) - 2)
        )
        scale = math.sqrt(vjj)
        low, high = distributions.nct_interval(fit["t"], float(fit["df"]))
        reference_mean = float(reference.mean())
        return {
            "nFocal": len(focal),
            "nReference": len(reference),
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

    def _group_means(
        self,
        block: _Block,
        labels: np.ndarray,
        beta: np.ndarray,
        s2: float,
        xtx_inv: np.ndarray,
    ) -> list[dict[str, Any]]:
        """Return the model-based group means at the covariate means."""
        model = self.model
        t_quantile = distributions.t_ppf((1.0 + _CI_LEVEL) / 2.0, float(block.df))
        means = []
        for label in model.mean_groups:
            members = labels == label
            if not members.any():
                continue
            point = np.zeros(len(block.names))
            point[0] = 1.0
            name = f"group:{label}"
            if name in block.names:
                point[block.names.index(name)] = 1.0
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

    # ----------------------------------------------------- permutations --
    def _prepare_null(self, block: _Block) -> None:
        assert block.x is not None  # noqa: S101
        y = self.values[np.ix_(block.rows, block.measures)]
        z = np.delete(block.x, block.j, axis=1)
        qz, _ = np.linalg.qr(z)
        residual = y - qz @ (qz.T @ y)
        block.residual_reduced = residual
        block.reduced_ss = (residual**2).sum(axis=0)

    def _null_block(self, block: _Block, perms: np.ndarray) -> np.ndarray:
        """Return the permuted t of every block measure, shape (b, m)."""
        assert block.q is not None  # noqa: S101
        assert block.r_inv is not None  # noqa: S101
        assert block.residual_reduced is not None  # noqa: S101
        assert block.reduced_ss is not None  # noqa: S101
        positions = induced_positions(perms, block.rows, self.n_master)
        w = project_permuted(block.q, block.residual_reduced, positions)
        b_j = np.matmul(block.r_inv[block.j], w)
        rss = np.maximum(block.reduced_ss[None, :] - (w**2).sum(axis=1), 0.0)
        vjj = float(block.r_inv[block.j] @ block.r_inv[block.j])
        with np.errstate(divide="ignore", invalid="ignore"):
            return b_j / np.sqrt(rss / block.df * vjj)

    def _permute(
        self, fitted: list[int], families: dict[str, list[int]]
    ) -> tuple[np.ndarray, dict[str, np.ndarray]]:
        """Return the uncorrected and family max-T permutation p values."""
        inference = self.spec.inference
        total = inference.permutations
        sidedness = inference.sidedness
        position = {k: i for i, k in enumerate(fitted)}
        observed = _statistic(np.array([self.fits[k]["t"] for k in fitted]), sidedness)
        blocks = [b for b in self.blocks if b.measures]
        for block in blocks:
            self._prepare_null(block)
        exceed = np.zeros(len(fitted), dtype=np.int64)
        exceed_max = {
            name: np.zeros(len(members), dtype=np.int64)
            for name, members in families.items()
        }
        family_columns = {
            name: np.array([position[k] for k in members], dtype=np.int64)
            for name, members in families.items()
        }
        done = 0
        self.progress("permuting", 0, total)
        for perms in permutation_chunks(inference.seed, self.n_master, total):
            if self.cancelled():
                raise ComputeCancelled
            null = np.empty((len(perms), len(fitted)))
            for block in blocks:
                columns = [position[k] for k in block.measures]
                null[:, columns] = _statistic(self._null_block(block, perms), sidedness)
            exceed += (null >= observed[None, :]).sum(axis=0)
            for name, columns in family_columns.items():
                family_max = null[:, columns].max(axis=1)
                exceed_max[name] += (
                    family_max[:, None] >= observed[columns][None, :]
                ).sum(axis=0)
            done += len(perms)
            self.progress("permuting", done, total)
        p_perm = (1.0 + exceed) / (1.0 + total)
        p_fwe = {
            name: (1.0 + count) / (1.0 + total) for name, count in exceed_max.items()
        }
        return p_perm, p_fwe

    # --------------------------------------------------------------- run --
    def run(self) -> EngineOutput:
        self._make_blocks()
        total_measures = len(self.measure_ids)
        self.progress("fitting", 0, total_measures)
        done = 0
        for block in self.blocks:
            if self.cancelled():
                raise ComputeCancelled
            reason = self._design(block)
            count = len(block.measures)
            if reason is not None:
                self._skip(block, reason)
            else:
                self._drop_exact_fits(block)
                if block.measures:
                    self._fit_block(block)
            done += count
            self.progress("fitting", done, total_measures)
        fitted = [k for k in range(total_measures) if k in self.fits]
        inference = self.spec.inference
        families: dict[str, list[int]] = {}
        for k in fitted:
            name = (
                "selected"
                if inference.family == "selected"
                else measure_family(self.measure_ids[k])
            )
            families.setdefault(name, []).append(k)
        p_perm: np.ndarray | None = None
        p_fwe: dict[str, np.ndarray] = {}
        if inference.permutations > 0 and fitted:
            p_perm, p_fwe = self._permute(fitted, families)
        corrected = self._corrections(fitted, families, p_fwe)
        return self._output(fitted, corrected, p_perm)

    def _corrections(
        self,
        fitted: list[int],
        families: dict[str, list[int]],
        p_fwe: dict[str, np.ndarray],
    ) -> dict[int, float | None]:
        correction = self.spec.inference.correction
        corrected: dict[int, float | None] = dict.fromkeys(fitted)
        if correction == "none":
            return corrected
        adjust = {"holm": holm, "bonferroni": bonferroni, "bh-fdr": bh}
        for name, members in families.items():
            if correction == "maxt-fwe":
                values = list(p_fwe[name])
            else:
                values = adjust[correction]([self.fits[k]["p"] for k in members])
            for k, value in zip(members, values, strict=True):
                corrected[k] = float(value)
        return corrected

    def _output(
        self,
        fitted: list[int],
        corrected: dict[int, float | None],
        p_perm: np.ndarray | None,
    ) -> EngineOutput:
        alpha = self.spec.inference.alpha
        rows: list[dict[str, Any]] = []
        group_means: dict[str, list[dict[str, Any]]] = {}
        subject_values: dict[str, list[dict[str, Any]]] = {}
        dataset = self.dataset
        master = self.model.master
        for position, k in enumerate(fitted):
            fit = self.fits[k]
            measure_id = self.measure_ids[k]
            p_corrected = corrected[k]
            decisive = fit["p"] if p_corrected is None else p_corrected
            rows.append(
                {
                    "measureId": measure_id,
                    "family": measure_family(measure_id),
                    "nTotal": len(fit["rows"]),
                    "nFocal": fit.get("nFocal"),
                    "nReference": fit.get("nReference"),
                    "estimate": fit["estimate"],
                    "se": fit["se"],
                    "t": fit["t"],
                    "df": fit["df"],
                    "p": fit["p"],
                    "pCorrected": p_corrected,
                    "significant": bool(decisive <= alpha),
                    "d": fit.get("d"),
                    "dLow": fit.get("dLow"),
                    "dHigh": fit.get("dHigh"),
                    "dRawSd": fit.get("dRawSd"),
                    "partialEta2": fit["partialEta2"],
                    "pctOfReference": fit.get("pctOfReference"),
                    "pHc3": fit["pHc3"],
                    "pPermutation": None if p_perm is None else float(p_perm[position]),
                }
            )
            group_means[measure_id] = fit["groupMeans"]
            values = self.values[fit["rows"], k]
            tested = self.model.tested
            subject_values[measure_id] = [
                {
                    "subjectId": dataset.subject_ids[index],
                    "group": dataset.groups[index],
                    "sourceLabel": dataset.source_labels[index],
                    "value": float(values[i]),
                    "adjusted": float(fit["adjusted"][i]),
                    "x": None if tested is None else float(tested[row]),
                }
                for i, row in enumerate(fit["rows"])
                for index in (int(master[row]),)
            ]
        return EngineOutput(
            rows=rows,
            group_means=group_means,
            subject_values=subject_values,
            skipped=self.skipped,
        )


def run(
    dataset: Dataset,
    spec: GroupAnalysisSpec,
    *,
    progress: Progress,
    cancelled: Callable[[], bool],
) -> EngineOutput:
    """Fit every measure and apply the chosen correction.

    Parameters
    ----------
    spec
        The validated specification.
    progress
        Called with the phase (``fitting``, ``permuting``) and counts as the
        compute advances.
    cancelled
        Polled between blocks and permutation chunks; a true answer stops the
        compute.

    Returns
    -------
    EngineOutput
        The rows and the per-measure detail.

    Raises
    ------
    ComputeCancelled
        When ``cancelled`` answers true.
    GroupAnalysisError
        When the dataset lacks a value the specification needs.
    """
    return _Engine(dataset, spec, progress, cancelled).run()


def _ordered(p: Sequence[float]) -> tuple[np.ndarray, np.ndarray]:
    values = np.asarray(p, dtype=float)
    return values, np.argsort(values, kind="mergesort")


def bh(p: Sequence[float]) -> list[float]:
    """Return Benjamini-Hochberg adjusted p values in input order.

    Parameters
    ----------
    p
        The unadjusted p values of one family.

    Returns
    -------
    list of float
        The adjusted values (q), capped at 1.
    """
    values, order = _ordered(p)
    n = len(values)
    if n == 0:
        return []
    q = values[order] * n / np.arange(1, n + 1)
    q = np.minimum.accumulate(q[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.minimum(q, 1.0)
    return out.tolist()


def holm(p: Sequence[float]) -> list[float]:
    """Return Holm adjusted p values in input order.

    Parameters
    ----------
    p
        The unadjusted p values of one family.

    Returns
    -------
    list of float
        The step-down adjusted values, capped at 1.
    """
    values, order = _ordered(p)
    n = len(values)
    if n == 0:
        return []
    adjusted = np.maximum.accumulate((n - np.arange(n)) * values[order])
    out = np.empty(n)
    out[order] = np.minimum(adjusted, 1.0)
    return out.tolist()


def bonferroni(p: Sequence[float]) -> list[float]:
    """Return Bonferroni adjusted p values in input order.

    Parameters
    ----------
    p
        The unadjusted p values of one family.

    Returns
    -------
    list of float
        ``min(1, m * p)`` for each value.
    """
    values = np.asarray(p, dtype=float)
    return np.minimum(values * len(values), 1.0).tolist()
