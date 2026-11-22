"""The design check of a spec v2 draft (``DesignCheck``).

Blocking findings stop Compute; warnings are shown with their disclosure
data. The rules: the smallest cell (``minCellN``, and at
least 3 per group with a non-constant moderator for an interaction), a
warning under 10 per cell; residual df below 1 blocks and below 5 warns;
per-cell n and sex counts; collinearity on each test's complete-case sample
(R^2 >= 0.999 blocks and names the dependency, VIF >= 5 warns, >= 10 warns
strongly); confounded factors by crosstab and Cramer's V; a covariate
undefined in a modeled group blocks; invalid combinations (log1p of values
<= -1, a subset emptying a group, empty moderator cells, a one-sided test
of a term the sample makes an F test); and per-test
availability (a subject missing one test's variable leaves only that test).

The site check: a between-groups test whose sample has a site holding only
one of the compared groups blocks unless the design adjusts for site (a
covariate) or stratifies by it; the finding names the site and carries two
fixes (leave the site out; adjust for site). When site determines group for
every subject, it blocks even with the covariate. Subjects without a site
form one level for this check only, with a warning when sites are mixed.
Within a group, site versus the test's factor is a crosstab with a Cramer's
V warning worded with the site. A spec v1 sample gets the site check alone
(:func:`check_sites_v1`), so a v1 comparison confounded with site blocks as
its v2 form would.

Everything here is plain Python (small dense solves), so the RPC process
checks a draft without numpy.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

from .dataset import SITE_FIELD, AnalysisContext
from .dataset_v2 import DatasetV2, TestSample, female_male, modeled_groups
from .engine_input import HEAD_SIZE_KEY, takes_head_size
from .spec import (
    AnalysisTest,
    GroupAnalysisSpec,
    GroupAnalysisSpecV2,
    effect_rank,
    upgrade_v1,
)

#: R^2 at or above which a covariate set blocks as collinear.
COLLINEAR_R2 = 0.999
#: The VIF that warns, and the VIF that warns strongly.
VIF_WARN = 5.0
VIF_STRONG = 10.0
#: The cell size under which a cell warns.
SMALL_CELL = 10
#: The residual df under which a test warns.
LOW_RESIDUAL_DF = 5
#: The Cramer's V at or above which two categorical variables warn.
CONFOUNDED_V = 0.5
#: The interaction's smallest group with a varying numeric moderator.
MIN_MODERATOR_GROUP = 3
_UNSET_SITE = "(no site)"
_MAX_CROSSTABS = 64
_MAX_ROWS = 1024
_PIVOT = 1e-10
_SITE_REF = {"source": "registry", "column": SITE_FIELD}


def term_name(key: str) -> str:
    """Name a coded covariate column for sentences: its column and level.

    ``age`` and ``sex`` stay; ``clinical-csv:AIS:B`` reads ``AIS: B`` and
    ``imported:var-...:uems`` reads ``uems``.
    """
    if key.startswith("measure:"):
        return key[len("measure:") :]
    parts = key.split(":")
    if parts[0] == "imported" and len(parts) >= 3:  # noqa: PLR2004
        column, level = parts[2], parts[3:]
    elif parts[0] in _SOURCES and len(parts) >= 2:  # noqa: PLR2004
        column, level = parts[1], parts[2:]
    else:
        return key
    return f"{column}: {':'.join(level)}" if level else column


_SOURCES = frozenset({"registry", "age-csv", "clinical-csv", "metadata-csv", "derived"})


def _count(n: int, noun: str = "subject") -> str:
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def _issue(
    code: str,
    severity: str,
    test_id: str | None,
    message: str,
    fixes: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    issue: dict[str, Any] = {
        "code": code,
        "severity": severity,
        "testId": test_id,
        "message": message[:512],
    }
    if fixes:
        issue["fixes"] = fixes
    return issue


class _Check:
    """Collect the findings and disclosure rows of one design."""

    def __init__(self, spec: GroupAnalysisSpecV2, resolved: DatasetV2) -> None:
        self.spec = spec
        self.resolved = resolved
        self.issues: list[dict[str, Any]] = []
        self.tests: list[dict[str, Any]] = []
        self.cells: list[dict[str, Any]] = []
        self.vif: list[dict[str, Any]] = []
        self.crosstabs: list[dict[str, Any]] = []

    def add(
        self,
        code: str,
        severity: str,
        test_id: str | None,
        message: str,
        fixes: list[dict[str, Any]] | None = None,
    ) -> None:
        issue = _issue(code, severity, test_id, message, fixes)
        if issue not in self.issues:
            self.issues.append(issue)

    # -- per test ----

    def run(self) -> dict[str, Any]:
        resolved = self.resolved
        for name, count in resolved.domain.items():
            self.add(
                "log1p-domain",
                "blocking",
                None,
                f"{name} takes log(1 + x) of values at or below \u22121 for "
                f"{_count(count)}; log(1 + x) needs values above \u22121.",
            )
        self._mixed_sites()
        for test in self.spec.tests:
            self._test(resolved.tests[test.id])
        blocking = any(issue["severity"] == "blocking" for issue in self.issues)
        return {
            "ok": not blocking,
            "issues": self.issues[:256],
            "tests": self.tests,
            "cells": self.cells[:_MAX_ROWS],
            "vif": self.vif[:_MAX_ROWS],
            "crosstabs": self.crosstabs[:_MAX_CROSSTABS],
        }

    def _rows(self, sample: TestSample) -> list[int]:
        return [i for i, ok in enumerate(sample.complete) if ok]

    def _test(self, sample: TestSample) -> None:
        test = sample.test
        rows = self._rows(sample)
        self._availability(sample)
        self._subset(sample)
        self._undefined(sample)
        grouped = test.factor is not None
        labels = [sample.labels[i] for i in rows]
        present = [g for g in sample.groups if g in labels] if grouped else []
        self._cells(sample, rows)
        if grouped:
            self._min_cells(sample, rows)
        self._transforms(sample, rows)
        if test.kind == "interaction":
            self._moderator(sample, rows)
        self._direction(sample, rows)
        columns = self._design(sample, rows, present)
        parameters = 1 + len(columns) + self._product_count(sample, rows, present)
        residual = len(rows) - parameters
        self.tests.append(
            {
                "testId": test.id,
                "n": len(rows),
                "residualDf": residual if residual >= 1 else None,
                "missing": sample.missing,
            }
        )
        if residual < 1:
            self.add(
                "residual-df",
                "blocking",
                test.id,
                f"This test fits {parameters} parameters to {_count(len(rows))}, "
                "so no residual degree of freedom is left.",
            )
        elif residual < LOW_RESIDUAL_DF:
            self.add(
                "residual-df",
                "warning",
                test.id,
                f"This test leaves {residual} residual degrees of freedom.",
            )
        self._collinearity(test.id, columns)
        if grouped:
            self._crosstabs(sample, rows)
            self._site(sample, rows)

    def _availability(self, sample: TestSample) -> None:
        if sample.missing:
            self.add(
                "test-availability",
                "warning",
                sample.test.id,
                f"{_count(sample.missing)} "
                f"{'has' if sample.missing == 1 else 'have'} no value this test "
                "needs, so only this test leaves them out.",
            )

    def _subset(self, sample: TestSample) -> None:
        counts = self.resolved.subset_counts.get(sample.test.id, {})
        for group in sample.groups:
            before, after = counts.get(group, (0, 0))
            if before and not after:
                self.add(
                    "subset-empties-group",
                    "blocking",
                    sample.test.id,
                    f"The subset filters leave no {group} subjects in this test.",
                )

    def _undefined(self, sample: TestSample) -> None:
        gaps = self.resolved.covariate_gaps.get(sample.test.id, {})
        if sample.test.factor is None:
            return
        for group in sample.groups:
            total, missing = gaps.get(group, (0, {}))
            for name, count in missing.items():
                if total and count == total:
                    whom = (
                        f"the only {group} subject"
                        if total == 1
                        else f"all {total} {group} subjects"
                    )
                    self.add(
                        "covariate-undefined",
                        "blocking",
                        sample.test.id,
                        f"{name} is missing for {whom}; a model that compares "
                        "groups cannot adjust for it.",
                    )

    def _cells(self, sample: TestSample, rows: list[int]) -> None:
        resolved = self.resolved
        test = sample.test
        units: list[tuple[str | None, list[int]]] = [(None, rows)]
        if self.spec.stratify is not None:
            units += [
                (group.label, [i for i in rows if resolved.strata[i] == group.label])
                for group in self.spec.stratify.grouping.groups
            ]
        levels = self._moderator_levels(sample, rows)
        for stratum, unit_rows in units:
            for group in sample.groups:
                members = [i for i in unit_rows if sample.labels[i] == group]
                cells = [(group, members)]
                if levels is not None:
                    moderator = self.resolved.moderators[test.id]
                    cells = [
                        (
                            f"{group}, {level}",
                            [i for i in members if moderator[i] == level],
                        )
                        for level in levels
                    ]
                for label, members_ in cells:
                    female, male = female_male(resolved.sex[i] for i in members_)
                    if not self.spec.covariates.sex:
                        female = male = None
                    self.cells.append(
                        {
                            "testId": test.id,
                            "stratum": stratum,
                            "label": label[:160],
                            "n": len(members_),
                            "female": female,
                            "male": male,
                        }
                    )

    def _moderator_levels(
        self, sample: TestSample, rows: list[int]
    ) -> list[str] | None:
        values = self.resolved.moderators.get(sample.test.id)
        if values is None or not any(isinstance(values[i], str) for i in rows):
            return None
        return sorted({str(values[i]) for i in rows if values[i] is not None})

    def _min_cells(self, sample: TestSample, rows: list[int]) -> None:
        test = sample.test
        minimum = self.spec.inclusion.minCellN
        factor = test.factor
        assert factor is not None  # noqa: S101
        checked = (
            [factor.focal, factor.reference]
            if test.kind == "two-group"
            else list(sample.groups)
        )
        for group in checked:
            n = sum(1 for i in rows if sample.labels[i] == group)
            if n < minimum:
                self.add(
                    "min-cell",
                    "blocking",
                    test.id,
                    f"{group} has {_count(n)} in this test; each compared group "
                    f"needs at least {minimum}.",
                )
            elif n < SMALL_CELL:
                self.add(
                    "small-cell",
                    "warning",
                    test.id,
                    f"{group} has {_count(n)} in this test; estimates from fewer "
                    f"than {SMALL_CELL} per group are unstable.",
                )
        if self.spec.stratify is None:
            return
        for stratum in self.spec.stratify.grouping.groups:
            unit = [i for i in rows if self.resolved.strata[i] == stratum.label]
            for group in checked:
                if sum(1 for i in unit if sample.labels[i] == group) < minimum:
                    self.add(
                        "min-cell",
                        "warning",
                        test.id,
                        f"Stratum {stratum.label} has fewer than {minimum} {group} "
                        "subjects in this test, so this stratum is skipped.",
                    )
                    break

    def _transforms(self, sample: TestSample, rows: list[int]) -> None:
        test = sample.test
        resolved = self.resolved
        if test.variable is not None:
            x = [resolved.tested[test.id][i] for i in rows]
            values = [v for v in x if v is not None]
            if test.variable.transform == "log1p" and any(v <= -1 for v in values):
                self.add(
                    "log1p-domain",
                    "blocking",
                    test.id,
                    f"{test.variable.ref.column} has values at or below \u22121; "
                    "log(1 + x) needs values above \u22121.",
                )
            if len(set(values)) < 2:  # noqa: PLR2004
                self.add(
                    "invalid-combination",
                    "blocking",
                    test.id,
                    f"{test.variable.ref.column} does not vary among the subjects "
                    "of this test.",
                )
        if test.moderator is not None and test.moderator.transform == "log1p":
            values = [resolved.moderators[test.id][i] for i in rows]
            if any(isinstance(v, float) and v <= -1 for v in values):
                self.add(
                    "log1p-domain",
                    "blocking",
                    test.id,
                    f"{test.moderator.ref.column} has values at or below \u22121; "
                    "log(1 + x) needs values above \u22121.",
                )

    def _moderator(self, sample: TestSample, rows: list[int]) -> None:
        test = sample.test
        moderator = self.resolved.moderators[test.id]
        levels = self._moderator_levels(sample, rows)
        name = test.moderator.ref.column if test.moderator else "The moderator"
        if levels is not None:
            if len(levels) < 2:  # noqa: PLR2004
                self.add(
                    "moderator-cells",
                    "blocking",
                    test.id,
                    f"{name} has one level among the subjects of this test.",
                )
                return
            for group in sample.groups:
                for level in levels:
                    if not any(
                        sample.labels[i] == group and moderator[i] == level
                        for i in rows
                    ):
                        self.add(
                            "moderator-cells",
                            "blocking",
                            test.id,
                            f"No {group} subject has {name} {level}, so the slope "
                            "difference cannot be estimated.",
                        )
            return
        for group in sample.groups:
            values = [
                moderator[i]
                for i in rows
                if sample.labels[i] == group and moderator[i] is not None
            ]
            if len(values) < MIN_MODERATOR_GROUP or len(set(values)) < 2:  # noqa: PLR2004
                self.add(
                    "moderator-cells",
                    "blocking",
                    test.id,
                    f"{group} needs three or more subjects with varying {name} for "
                    "a slope difference.",
                )

    def _direction(self, sample: TestSample, rows: list[int]) -> None:
        """Block a one-sided draft whose test fits an F term in this sample.

        The spec rules cannot see a categorical moderator's levels or which
        strata hold subjects, so the ranks the engine fits are checked here:
        (k - 1)(m - 1) for a slope difference with m moderator levels, and
        the effect rank times (strata - 1) for the heterogeneity test.
        """
        if self.spec.inference.sidedness == "two-sided":
            return
        test = sample.test
        levels = (
            self._moderator_levels(sample, rows) if test.kind == "interaction" else None
        )
        rank = effect_rank(test, None if levels is None else len(levels))
        terms = [("This test", rank)]
        stratify = self.spec.stratify
        if stratify is not None and stratify.heterogeneity:
            strata = {self.resolved.strata[i] for i in rows} - {None}
            terms.append(
                ("The heterogeneity test of this test", rank * (len(strata) - 1))
            )
        for name, value in terms:
            if value > 1:
                self.add(
                    "invalid-combination",
                    "blocking",
                    test.id,
                    f"{name} is an F test ({value} df), which has no direction; "
                    "choose a two-sided test.",
                )

    # -- design columns ----

    def _design(
        self, sample: TestSample, rows: list[int], present: list[str]
    ) -> list[tuple[str, list[float]]]:
        """Return the named non-intercept columns of the test's design.

        The tested columns (group indicators, the tested variable, the
        moderator's main effect), then the shared covariates and head size,
        then the test's extra covariates; constant columns are left out, as
        the engine leaves them out.
        """
        resolved = self.resolved
        test = sample.test
        columns: list[tuple[str, list[float]]] = []
        if test.factor is not None and present:
            reference = test.factor.reference
            columns.extend(
                (group, [1.0 if sample.labels[i] == group else 0.0 for i in rows])
                for group in present
                if group != reference
            )
        if test.variable is not None:
            columns.append(
                (
                    test.variable.ref.column,
                    [float(resolved.tested[test.id][i] or 0.0) for i in rows],
                )
            )
        levels = self._moderator_levels(sample, rows)
        if test.moderator is not None:
            moderator = resolved.moderators[test.id]
            if levels is None:
                columns.append(
                    (
                        test.moderator.ref.column,
                        [float(moderator[i] or 0.0) for i in rows],  # type: ignore[arg-type]
                    )
                )
            else:
                columns.extend(
                    (
                        f"{test.moderator.ref.column}: {level}",
                        [1.0 if moderator[i] == level else 0.0 for i in rows],
                    )
                    for level in levels[1:]
                )
        for key, values in resolved.data.covariates.items():
            if key == HEAD_SIZE_KEY:
                if not any(
                    takes_head_size(m, self.spec) for m in resolved.data.measures
                ):
                    continue
                cells = [values[i] for i in rows]
                if any(v is None for v in cells):
                    continue
                columns.append(
                    (_HEAD_NAME[self.spec.covariates.headSize.source], cells)
                )  # type: ignore[arg-type]
                continue
            columns.append((term_name(key), [float(values[i] or 0.0) for i in rows]))
        columns.extend(
            (term_name(key), [float(values[i] or 0.0) for i in rows])
            for key, values in resolved.test_columns.get(test.id, {}).items()
        )
        return [(name, col) for name, col in columns if len(set(col)) > 1]

    def _product_count(
        self, sample: TestSample, rows: list[int], present: list[str]
    ) -> int:
        test = sample.test
        if test.kind != "interaction" or test.factor is None:
            return 0
        levels = self._moderator_levels(sample, rows)
        width = 1 if levels is None else max(0, len(levels) - 1)
        return max(0, len(present) - 1) * width

    def _collinearity(
        self, test_id: str, columns: list[tuple[str, list[float]]]
    ) -> None:
        if len(columns) < 2:  # noqa: PLR2004
            for name, _col in columns:
                self.vif.append({"testId": test_id, "term": name[:160], "vif": 1.0})
            return
        names = [name for name, _col in columns]
        gram, sds = _centered_gram([col for _name, col in columns])
        reported = False
        for j, name in enumerate(names):
            others = [k for k in range(len(names)) if k != j]
            r2, coefs, resid_max = _r_squared(gram, j, others, [c for _n, c in columns])
            vif = math.inf if r2 >= 1.0 else 1.0 / (1.0 - r2)
            self.vif.append(
                {
                    "testId": test_id,
                    "term": name[:160],
                    "vif": round(min(vif, 1e12), 6),
                }
            )
            if r2 >= COLLINEAR_R2 and not reported:
                reported = True
                involved = [
                    (names[k], coefs[pos])
                    for pos, k in enumerate(others)
                    if sds[j] > 0 and abs(coefs[pos]) * sds[k] / sds[j] >= 0.01  # noqa: PLR2004
                ]
                self.add(
                    "collinear",
                    "blocking",
                    test_id,
                    _dependency(name, involved, r2, resid_max),
                )
            elif vif >= VIF_STRONG:
                self.add(
                    "vif",
                    "strong-warning",
                    test_id,
                    f"{name} has a variance inflation factor of {vif:.1f}; the other "
                    "terms explain it almost entirely.",
                )
            elif vif >= VIF_WARN:
                self.add(
                    "vif",
                    "warning",
                    test_id,
                    f"{name} has a variance inflation factor of {vif:.1f}.",
                )

    # -- crosstabs and site ----

    def _others(self, sample: TestSample) -> list[tuple[str, list[str | None]]]:
        resolved = self.resolved
        others: list[tuple[str, list[str | None]]] = []
        if self.spec.covariates.sex is not None:
            others.append(("sex", resolved.sex))
        for name, values in resolved.categorical.items():
            if name != "sex":
                others.append((name, values))
        if self.spec.stratify is not None:
            others.append(("stratum", resolved.strata))
        if self.spec.design.scope == "within":
            population = self.spec.design.population
            name = population.grouping.variable.column if population else "population"
            others.append((str(name), resolved.population_levels))
        return others

    def _crosstabs(self, sample: TestSample, rows: list[int]) -> None:
        test = sample.test
        row_name = test.label
        for name, values in self._others(sample):
            table = _crosstab(
                [sample.labels[i] for i in rows], [values[i] for i in rows]
            )
            if table is None:
                continue
            groups, levels, counts, v = table
            self.crosstabs.append(
                {
                    "testId": test.id,
                    "rowVariable": row_name[:160],
                    "columnVariable": name[:160],
                    "rows": groups,
                    "columns": levels,
                    "counts": counts,
                    "cramersV": v,
                }
            )
            if v is not None and v >= CONFOUNDED_V:
                self.add(
                    "confounded",
                    "warning",
                    test.id,
                    f"The groups of this test differ in {name} (Cramer's V "
                    f"{v:.2f}): {_example(groups, levels, counts)}.",
                )

    def _mixed_sites(self) -> None:
        if (issue := mixed_site_issue(self.resolved.sites)) is not None:
            self.add(**issue)

    def _site(self, sample: TestSample, rows: list[int]) -> None:
        if not any(site is not None for site in self.resolved.sites):
            return
        issues, crosstab = site_findings(
            self.spec,
            sample.test,
            sample.groups,
            [sample.labels[i] for i in rows],
            [self.resolved.sites[i] for i in rows],
        )
        if crosstab is not None:
            self.crosstabs.append(crosstab)
        for issue in issues:
            self.add(**issue)


# -- Site check ------------------------------------------------------------------------


def _finding(
    severity: str,
    test_id: str | None,
    message: str,
    fixes: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    finding: dict[str, Any] = {
        "code": "site-confounded",
        "severity": severity,
        "test_id": test_id,
        "message": message,
    }
    if fixes:
        finding["fixes"] = fixes
    return finding


def mixed_site_issue(sites: Sequence[str | None]) -> dict[str, Any] | None:
    """Return the warning that some subjects have no site, or None.

    Parameters
    ----------
    sites
        Each aligned subject's site (None: unset).

    Returns
    -------
    dict or None
        The arguments of one finding (``code``, ``severity``, ``test_id``,
        ``message``), when some but not all subjects have a site.
    """
    unset = sum(1 for site in sites if site is None)
    if not sites or not 0 < unset < len(sites):
        return None
    return _finding(
        "warning",
        None,
        f"{_count(unset)} {'has' if unset == 1 else 'have'} no site; the "
        "site check treats them as one site.",
    )


def site_findings(
    spec: GroupAnalysisSpecV2,
    test: AnalysisTest,
    groups: Sequence[str],
    labels: Sequence[str | None],
    sites: Sequence[str | None],
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """Apply the site check to one grouped test's complete-case sample.

    Parameters
    ----------
    spec
        The spec v2 (its scope, covariates, and stratifier).
    test
        The test, which has a group factor.
    groups
        The test's modeled groups, in definition order.
    labels
        Each sample subject's group label (None: not modeled).
    sites
        Each sample subject's site (None: unset, one level for this check).

    Returns
    -------
    tuple of (list of dict, dict or None)
        The findings' arguments (``code``, ``severity``, ``test_id``,
        ``message``, and ``fixes`` when there are any), and the site crosstab
        row, or None when the sample has fewer than two groups or sites.
    """
    found: list[dict[str, Any]] = []
    named_sites = [site or _UNSET_SITE for site in sites]
    table = _crosstab(list(labels), list(named_sites))
    crosstab = None
    if table is not None:
        row_groups, levels, counts, v = table
        crosstab = {
            "testId": test.id,
            "rowVariable": test.label[:160],
            "columnVariable": "site",
            "rows": row_groups,
            "columns": levels,
            "counts": counts,
            "cramersV": v,
        }
    if spec.design.scope == "within":
        if table is not None and table[3] is not None and table[3] >= CONFOUNDED_V:
            row_groups, levels, counts, v = table
            found.append(
                _finding(
                    "warning",
                    test.id,
                    f"The groups of this test differ by site (Cramer's V {v:.2f}): "
                    f"{_example(row_groups, levels, counts, site=True)}.",
                )
            )
        return found, crosstab
    held: dict[str, set[str]] = {}
    for site, label in zip(named_sites, labels, strict=True):
        if label is not None:
            held.setdefault(site, set()).add(label)
    single = {
        site: next(iter(members)) for site, members in held.items() if len(members) == 1
    }
    if len(held) < 2 or not single:  # noqa: PLR2004
        return found, crosstab
    if len(single) == len(held):
        found.append(
            _finding(
                "blocking",
                test.id,
                "Site determines group for every subject, so the model cannot "
                "separate them.",
            )
        )
        return found, crosstab
    adjusted = _adjusts_for_site(spec, test)
    stratified = _stratified_by_site(spec)
    for site, group in sorted(single.items()):
        unset = site == _UNSET_SITE
        named = "Subjects without a site" if unset else f"Site {site}"
        if stratified:
            others = [g for g in groups if g != group]
            found.append(
                _finding(
                    "warning",
                    test.id,
                    f"{named} {'have' if unset else 'has'} no "
                    f"{' or '.join(others)} subjects, so this stratum is skipped.",
                )
            )
        elif adjusted:
            found.append(
                _finding(
                    "warning",
                    test.id,
                    f"{named} {'hold' if unset else 'holds'} only "
                    f"{group} subjects; with site as a covariate they inform the "
                    "other covariates and the residual variance, not the group "
                    "difference.",
                )
            )
        else:
            fixes: list[dict[str, Any]] = []
            if not unset:
                fixes.append(
                    {"kind": "drop-level", "variable": dict(_SITE_REF), "level": site}
                )
            fixes.append({"kind": "add-covariate", "variable": dict(_SITE_REF)})
            leave = (
                "Leave out the subjects without a site"
                if unset
                else f"Leave out site {site}"
            )
            found.append(
                _finding(
                    "blocking",
                    test.id,
                    f"{named} {'hold' if unset else 'holds'} only "
                    f"{group} subjects in this test, so its group difference cannot "
                    f"be separated from the scanner. {leave} or adjust for site.",
                    fixes,
                )
            )
    return found, crosstab


def _adjusts_for_site(spec: GroupAnalysisSpecV2, test: AnalysisTest) -> bool:
    refs = [*spec.covariates.extra, *test.extraCovariates]
    return any(ref.source == "registry" and ref.column == SITE_FIELD for ref in refs)


def _stratified_by_site(spec: GroupAnalysisSpecV2) -> bool:
    stratify = spec.stratify
    return (
        stratify is not None
        and stratify.grouping.variable.source == "registry"
        and stratify.grouping.variable.column == SITE_FIELD
    )


def check_sites_v1(
    spec: GroupAnalysisSpec,
    groups: Sequence[str | None],
    sites: Sequence[str | None],
) -> dict[str, Any] | None:
    """Run the site check on a spec v1 sample as on its spec v2 form.

    The spec v1 has one test, the upgraded spec's ``t1``
    (:func:`spec.upgrade_v1`), so a finding's test and fixes apply to the v2
    draft the panel edits. Only the site check runs: the rest of the v2 check
    would block analyses v1 computes (the smallest cell, for one).

    Parameters
    ----------
    spec
        The validated spec v1.
    groups
        Each included subject's group label (None without a grouping).
    sites
        Each included subject's site (None: unset).

    Returns
    -------
    dict or None
        A ``DesignCheck`` payload with the site findings and the site
        crosstab, or None when no included subject has a site, so a
        site-free project reports no site findings.
    """
    if not any(site is not None for site in sites):
        return None
    upgraded = upgrade_v1(spec)
    test = upgraded.tests[0]
    issues: list[dict[str, Any]] = []
    crosstabs: list[dict[str, Any]] = []
    found: list[dict[str, Any]] = []
    if (mixed := mixed_site_issue(sites)) is not None:
        found.append(mixed)
    if test.factor is not None:
        modeled = modeled_groups(test)
        rows = [i for i, group in enumerate(groups) if group in modeled]
        test_found, crosstab = site_findings(
            upgraded,
            test,
            modeled,
            [groups[i] for i in rows],
            [sites[i] for i in rows],
        )
        found.extend(test_found)
        if crosstab is not None:
            crosstabs.append(crosstab)
    for finding in found:
        issue = _issue(**finding)
        if issue not in issues:
            issues.append(issue)
    return {
        "ok": not any(issue["severity"] == "blocking" for issue in issues),
        "issues": issues,
        "tests": [],
        "cells": [],
        "vif": [],
        "crosstabs": crosstabs,
    }


_HEAD_NAME = {
    "etiv": "eTIV",
    "stiv": "sTIV",
    "synthseg-tiv": "SynthSeg TIV",
    "none": "",
}


# -- Small dense algebra -------------------------------------------------------------


def _centered_gram(
    columns: Sequence[Sequence[float]],
) -> tuple[list[list[float]], list[float]]:
    """Return the Gram matrix of the centered columns and their SDs."""
    n = len(columns[0]) if columns else 0
    centered = []
    for column in columns:
        mean = math.fsum(column) / n if n else 0.0
        centered.append([value - mean for value in column])
    p = len(centered)
    gram = [[0.0] * p for _ in range(p)]
    for a in range(p):
        for b in range(a, p):
            value = math.fsum(
                x * y for x, y in zip(centered[a], centered[b], strict=True)
            )
            gram[a][b] = gram[b][a] = value
    sds = [math.sqrt(max(gram[k][k], 0.0) / max(n - 1, 1)) for k in range(p)]
    return gram, sds


def _solve(matrix: list[list[float]], rhs: list[float]) -> list[float]:
    """Solve a symmetric system by Gaussian elimination, zeroing tiny pivots.

    A pivot below ``1e-10`` times the largest diagonal marks a column the
    others already span; its coefficient is 0 (a minimum-norm-like solution
    that keeps the fitted values exact).
    """
    size = len(rhs)
    a = [[*row, rhs[i]] for i, row in enumerate(matrix)]
    scale = max((abs(a[i][i]) for i in range(size)), default=0.0) or 1.0
    pivots: list[int | None] = [None] * size
    row = 0
    for col in range(size):
        best = max(range(row, size), key=lambda r: abs(a[r][col]), default=None)
        if best is None or abs(a[best][col]) <= _PIVOT * scale:
            continue
        a[row], a[best] = a[best], a[row]
        pivot = a[row][col]
        for r in range(size):
            if r != row and a[r][col] != 0.0:
                factor = a[r][col] / pivot
                for c in range(col, size + 1):
                    a[r][c] -= factor * a[row][c]
        pivots[col] = row
        row += 1
    solution = [0.0] * size
    for col, r in enumerate(pivots):
        if r is not None:
            solution[col] = a[r][size] / a[r][col]
    return solution


def _r_squared(
    gram: list[list[float]],
    target: int,
    others: list[int],
    columns: Sequence[Sequence[float]],
) -> tuple[float, list[float], float]:
    """Regress one centered column on others: R^2, coefficients, max residual."""
    total = gram[target][target]
    if total <= 0 or not others:
        return 0.0, [0.0] * len(others), 0.0
    sub = [[gram[a][b] for b in others] for a in others]
    rhs = [gram[a][target] for a in others]
    coefs = _solve(sub, rhs)
    explained = math.fsum(c * r for c, r in zip(coefs, rhs, strict=True))
    r2 = min(max(explained / total, 0.0), 1.0)
    n = len(columns[target])
    means = [math.fsum(columns[k]) / n for k in [target, *others]]
    residuals = []
    for i in range(n):
        fitted = means[0] + math.fsum(
            c * (columns[k][i] - means[pos + 1])
            for pos, (c, k) in enumerate(zip(coefs, others, strict=True))
        )
        residuals.append(abs(columns[target][i] - fitted))
    return r2, coefs, max(residuals, default=0.0)


def _dependency(
    name: str, involved: list[tuple[str, float]], r2: float, largest: float
) -> str:
    """Name a near-exact linear dependency among the design's columns."""
    unit = [
        (other, coef)
        for other, coef in involved
        if abs(abs(coef) - 1.0) < 1e-3  # noqa: PLR2004
    ]
    if len(involved) == 2 and len(unit) == 2:  # noqa: PLR2004
        (first, a), (second, b) = involved
        if a > 0 > b:
            relation = f"{first} minus {second}"
        elif b > 0 > a:
            relation = f"{second} minus {first}"
        elif a > 0 and b > 0:
            relation = f"{first} plus {second}"
        else:
            relation = f"minus {first} minus {second}"
        return (
            f"{name} equals {relation} for these subjects (largest difference "
            f"{largest:.2f}). Remove one of the three."
        )
    if len(involved) == 1:
        return (
            f"{name} and {involved[0][0]} carry the same information for these "
            f"subjects (R^2 {r2:.4f}). Remove one of the two."
        )
    if not involved:
        return f"{name} does not vary independently of the other terms. Remove it."
    others = ", ".join(other for other, _coef in involved)
    return (
        f"{name} is almost exactly a combination of {others} for these subjects "
        f"(R^2 {r2:.4f}). Remove one of them."
    )


def _crosstab(
    rows: list[str | None], columns: list[str | None]
) -> tuple[list[str], list[str], list[list[int]], float | None] | None:
    """Return the crosstab of two categorical variables and Cramer's V."""
    pairs = [(r, c) for r, c in zip(rows, columns, strict=True) if r and c]
    if not pairs:
        return None
    row_levels = sorted({r for r, _c in pairs})[:256]
    column_levels = sorted({c for _r, c in pairs})[:256]
    counts = [[0] * len(column_levels) for _ in row_levels]
    row_index = {level: i for i, level in enumerate(row_levels)}
    column_index = {level: i for i, level in enumerate(column_levels)}
    for r, c in pairs:
        if r in row_index and c in column_index:
            counts[row_index[r]][column_index[c]] += 1
    n = sum(map(sum, counts))
    k = min(len(row_levels), len(column_levels))
    v: float | None = None
    if k >= 2 and n:  # noqa: PLR2004
        row_totals = [sum(row) for row in counts]
        column_totals = [sum(col) for col in zip(*counts, strict=True)]
        chi2 = 0.0
        for i, row in enumerate(counts):
            for j, observed in enumerate(row):
                expected = row_totals[i] * column_totals[j] / n
                if expected > 0:
                    chi2 += (observed - expected) ** 2 / expected
        v = min(1.0, math.sqrt(chi2 / (n * (k - 1))))
    return row_levels, column_levels, counts, v


def _example(
    groups: list[str], levels: list[str], counts: list[list[int]], *, site: bool = False
) -> str:
    """Describe the most lopsided level of a crosstab in one clause."""
    best: tuple[float, str, str, int, int] | None = None
    for j, level in enumerate(levels):
        total = sum(counts[i][j] for i in range(len(groups)))
        if total < 2:  # noqa: PLR2004
            continue
        i = max(range(len(groups)), key=lambda r: counts[r][j])
        share = counts[i][j] / total
        if best is None or share > best[0]:
            best = (share, level, groups[i], counts[i][j], total)
    if best is None:
        return "the groups differ in their mix"
    _share, level, group, count, total = best
    if site:
        name = "subjects without a site" if level == _UNSET_SITE else f"site {level}"
        return f"{count} of the {total} subjects of {name} are {group}"
    return f"{count} of the {total} {level} subjects are {group}"


def check_design(
    context: AnalysisContext, spec: GroupAnalysisSpecV2, data: DatasetV2
) -> dict[str, Any]:
    """Check a spec v2 draft against the resolved data.

    Parameters
    ----------
    spec
        The validated spec v2.

    Returns
    -------
    dict
        The ``DesignCheck`` payload.
    """
    del context
    return _Check(spec, data).run()


def blocking_message(check: dict[str, Any]) -> str | None:
    """Return the first blocking finding's sentence, or None."""
    return next(
        (
            issue["message"]
            for issue in check["issues"]
            if issue["severity"] == "blocking"
        ),
        None,
    )
