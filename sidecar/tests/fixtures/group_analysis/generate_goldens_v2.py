"""Generate the v2 engine goldens offline (not collected by pytest).

Writes ``engine-goldens-v2.json`` next to this script: extra synthetic
variables for the subjects of ``engine-dataset.json``, spec v2 cases with
their expected terms, rows, group means, and fitted-line points, and SciPy's
F survival function values. The expected values never come from the engine:
every model is an explicit design fitted with statsmodels, every hypothesis a
contrast matrix R in one fixed parametrization (``t_test`` and ``f_test``),
the HC3 statistics come from statsmodels' HC3 covariance, the d CI from the
reference implementation's ``d_with_ci``, and each permutation refits the full
design on permuted reduced-model residuals, the reduced design being ``X N``
with ``N`` the null space of R (so a pair's reduced model merges the pair).
The permutation stream is ``default_rng(seed).permutation`` restricted to
each block by ``induced_positions``. The reference implementation is
``analyses/lib/family_models.py``. See docs/science.md for the environment.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy import linalg, stats

HERE = Path(__file__).resolve().parent
VARIABLE_SEED = 20261001
ETIV = "eTIV"
EXTENSIVE_METRICS = {"NumVert", "SurfArea", "GrayVol", "FoldInd"}
HEAD_SIZE_MEASURES = {"global:eTIV", "global:sTIV", "global:synthsegTIV"}
Z_CI = float(stats.norm.ppf(0.975))
MEASURES = [
    "aseg:Brain-Stem",
    "aseg:bi:Thalamus",
    "aseg:Left-Hippocampus",
    "dk:bi:precentral:ThickAvg",
    "dk:lh:postcentral:ThickAvg",
    "dk:lh:insula:GrayVol",
    "dk:rh:precentral:SurfArea",
    "global:meanThickness",
    "global:eTIV",
    "brainage:BrainPAD",
]
DETAIL_MEASURE = "aseg:Brain-Stem"


def _is_extensive(measure_id: str) -> bool:
    parts = measure_id.split(":")
    if parts[0] == "dk":
        return parts[-1] in EXTENSIVE_METRICS
    if parts[0] == "aseg":
        return True
    return measure_id == "global:eTIV"


def _family(measure_id: str) -> str:
    parts = measure_id.split(":")
    return f"dk:{parts[-1]}" if parts[0] == "dk" else parts[0]


# ------------------------------------------------------------------ Data --
def make_variables(data: dict[str, Any]) -> dict[str, list[Any]]:
    """Draw the extra variables, aligned with the stored subject order."""
    rng = np.random.default_rng(VARIABLE_SEED)
    cohorts = np.array(data["cohorts"])
    n = len(cohorts)
    sci = cohorts != "CTRL"
    female = np.array(data["covariates"]["sex"], dtype=float)
    site = np.where(rng.uniform(size=n) < 0.5, "north", "south")
    level = np.where(rng.uniform(size=n) < 0.45, "cervical", "thoracic_lumbar").astype(
        object
    )
    ais = rng.choice(np.array(["A", "B", "C", "D"]), n, p=[0.45, 0.15, 0.15, 0.25])
    ais = ais.astype(object)
    motor = np.round(rng.uniform(10, 100, n), 1)
    sci_rows = np.flatnonzero(sci)
    level[~sci] = None
    ais[~sci] = None
    motor = motor.astype(object)
    motor[~sci] = None
    for index in rng.choice(sci_rows, 2, replace=False):
        level[index] = None
    for index in rng.choice(sci_rows, 3, replace=False):
        motor[index] = None
    return {
        "site": [str(v) for v in site],
        "level": [None if v is None else str(v) for v in level],
        "ais": [None if v is None else str(v) for v in ais],
        "motor": [None if v is None else float(v) for v in motor],
        "sexText": ["Female" if v == 1.0 else "Male" for v in female],
    }


# ------------------------------------------------------------- Specs --
REGISTRY = "registry"
COHORT = {"source": REGISTRY, "column": "sourceCohortLabel"}
THREE = [("CTRL", ["CTRL"]), ("SCI_P", ["SCI_P"]), ("SCI_nNP", ["SCI_nNP"])]
SCI_CTRL = [("SCI", ["SCI_P", "SCI_nNP"]), ("CTRL", ["CTRL"])]
#: The v2 variable key of each case variable (``engine_input.variable_key``).
KEYS = {
    "cohort": "registry:sourceCohortLabel",
    "score": "metadata-csv:score",
    "tsi": "registry:tSinceSci",
    "site": "metadata-csv:site",
    "level": "imported:var-00000000000000a1:level",
    "ais": "registry:ais",
    "motor": "derived:dv-motor",
    "sexText": "metadata-csv:SexText",
    "age": "registry:age",
}
REFS = {
    "cohort": COHORT,
    "score": {"source": "metadata-csv", "column": "score"},
    "tsi": {"source": REGISTRY, "column": "tSinceSci"},
    "site": {"source": "metadata-csv", "column": "site"},
    "level": {
        "source": "imported",
        "table": "var-00000000000000a1",
        "column": "level",
    },
    "ais": {"source": REGISTRY, "column": "ais"},
    "motor": {"source": "derived", "column": "dv-motor"},
    "sexText": {"source": "metadata-csv", "column": "SexText"},
    "age": {"source": REGISTRY, "column": "age"},
}


def _grouping(name: str, pairs: list[tuple[str, list[str]]]) -> dict[str, Any]:
    return {
        "variable": REFS[name],
        "groups": [{"label": label, "levels": levels} for label, levels in pairs],
    }


def _test(test_id: str, kind: str, **fields: Any) -> dict[str, Any]:
    return {
        "id": test_id,
        "label": fields.pop("label", test_id),
        "kind": kind,
        "factor": None,
        "pairwise": "none",
        "pairwiseFamily": "pooled",
        "variable": None,
        "moderator": None,
        "adjustForGroup": False,
        "inFamily": True,
        "extraCovariates": [],
        **fields,
    }


def _factor(
    name: str,
    pairs: list[tuple[str, list[str]]],
    reference: str,
    focal: str | None = None,
    model: str = "all-groups",
) -> dict[str, Any]:
    return {
        "grouping": _grouping(name, pairs),
        "focal": focal,
        "reference": reference,
        "model": model,
    }


def _spec(  # noqa: PLR0913
    tests: list[dict[str, Any]],
    inference: dict[str, Any],
    *,
    scope: str = "between",
    population: dict[str, Any] | None = None,
    stratify: dict[str, Any] | None = None,
    age: bool = True,
    sex: bool = True,
    head: tuple[str, str] = ("etiv", "extensive"),
    derived: list[dict[str, Any]] | None = None,
    min_cell: int = 3,
) -> dict[str, Any]:
    return {
        "schema": "supraspina/group-analysis-spec",
        "schemaVersion": 2,
        "design": {"scope": scope, "population": population, "subset": []},
        "variables": {"derived": derived or []},
        "tests": tests,
        "stratify": stratify,
        "measures": MEASURES,
        "covariates": {
            "age": REFS["age"] if age else None,
            "sex": {"source": REGISTRY, "column": "sex"} if sex else None,
            "headSize": {"source": head[0], "rule": head[1]},
            "extra": [],
            "centering": "sample-mean",
        },
        "inclusion": {
            "qc": "non-failed",
            "registration": "set-missing",
            "outliers": "keep",
            "minCellN": min_cell,
        },
        "inference": {"alpha": 0.05, "omnibusGate": False, **inference},
    }


SCI_POPULATION = {
    "grouping": _grouping(
        "cohort", [("SCI", ["SCI_P", "SCI_nNP"]), ("CTRL", ["CTRL"])]
    ),
    "groups": ["SCI"],
}
MOTOR = {
    "id": "dv-motor",
    "label": "Motor score",
    "op": "sum",
    "inputs": [
        {"source": "imported", "table": "var-00000000000000a1", "column": "uems"},
        {"source": "imported", "table": "var-00000000000000a1", "column": "lems"},
    ],
    "params": {"cuts": [], "labels": []},
}


def cases() -> list[dict[str, Any]]:
    """Return the golden cases: name, spec, population, and covariate keys."""
    return [
        {
            "name": "omnibus-pairwise-maxt-pooled",
            "population": None,
            "covariates": ["age", "sex", ETIV],
            "spec": _spec(
                [
                    _test(
                        "cohort",
                        "omnibus",
                        label="Three cohorts",
                        factor=_factor("cohort", THREE, "CTRL"),
                        pairwise="all-pairs",
                    )
                ],
                {
                    "sidedness": "two-sided",
                    "correction": "maxt-fwe",
                    "family": "per-test",
                    "omnibusGate": True,
                    "permutations": 1000,
                    "seed": 11,
                },
            ),
        },
        {
            "name": "omnibus-compared-per-pair-holm",
            "population": None,
            "covariates": ["age", "sex", ETIV],
            "spec": _spec(
                [
                    _test(
                        "cohort",
                        "omnibus",
                        factor=_factor(
                            "cohort",
                            [
                                ("SCI_P", ["SCI_P"]),
                                ("CTRL", ["CTRL"]),
                                ("SCI_nNP", ["SCI_nNP"]),
                            ],
                            "SCI_P",
                            model="compared-groups",
                        ),
                        pairwise="all-pairs",
                        pairwiseFamily="per-pair",
                    )
                ],
                {
                    "sidedness": "two-sided",
                    "correction": "holm",
                    "family": "per-test-and-measure-family",
                    "permutations": 0,
                    "seed": 1,
                },
                head=("etiv", "all"),
            ),
        },
        {
            "name": "association-log1p-standardize-maxt",
            "population": ["SCI_P", "SCI_nNP"],
            "covariates": ["age", "sex", ETIV],
            "spec": _spec(
                [
                    _test(
                        "tsi",
                        "association",
                        label="log(1 + time since injury)",
                        variable={"ref": REFS["tsi"], "transform": "log1p"},
                    ),
                    _test(
                        "score",
                        "association",
                        label="Score per SD",
                        variable={"ref": REFS["score"], "transform": "standardize"},
                        factor=_factor(
                            "cohort",
                            [("SCI_P", ["SCI_P"]), ("SCI_nNP", ["SCI_nNP"])],
                            "SCI_P",
                        ),
                        adjustForGroup=True,
                    ),
                ],
                {
                    "sidedness": "two-sided",
                    "correction": "maxt-fwe",
                    "family": "all-tests",
                    "permutations": 1000,
                    "seed": 20260923,
                },
                scope="within",
                population=SCI_POPULATION,
            ),
        },
        {
            "name": "interaction-numeric-maxt",
            "population": None,
            "covariates": ["sex", ETIV],
            "spec": {
                **_spec(
                    [
                        _test(
                            "age3",
                            "interaction",
                            label="Cohort by age",
                            factor=_factor("cohort", THREE, "CTRL"),
                            moderator={"ref": REFS["age"], "transform": "none"},
                        ),
                        _test(
                            "age2",
                            "interaction",
                            label="SCI by age",
                            factor=_factor("cohort", SCI_CTRL, "CTRL"),
                            moderator={"ref": REFS["age"], "transform": "none"},
                        ),
                    ],
                    {
                        "sidedness": "two-sided",
                        "correction": "maxt-fwe",
                        "family": "per-test",
                        "permutations": 1000,
                        "seed": 7,
                    },
                    age=False,
                ),
            },
        },
        {
            "name": "interaction-binary-bh",
            "population": None,
            "covariates": ["age", ETIV],
            "spec": _spec(
                [
                    _test(
                        "sex",
                        "interaction",
                        label="SCI by sex",
                        factor=_factor("cohort", SCI_CTRL, "CTRL"),
                        moderator={"ref": REFS["sexText"], "transform": "none"},
                    )
                ],
                {
                    "sidedness": "two-sided",
                    "correction": "bh-fdr",
                    "family": "per-measure-family",
                    "permutations": 0,
                    "seed": 1,
                },
                sex=False,
            ),
        },
        {
            "name": "stratified-heterogeneity-maxt",
            "population": None,
            "covariates": ["age", "sex", ETIV],
            "spec": _spec(
                [
                    _test(
                        "sci",
                        "two-group",
                        label="SCI vs CTRL",
                        factor=_factor("cohort", SCI_CTRL, "CTRL", focal="SCI"),
                    ),
                    _test(
                        "score",
                        "association",
                        label="Score",
                        variable={"ref": REFS["score"], "transform": "none"},
                    ),
                ],
                {
                    "sidedness": "two-sided",
                    "correction": "maxt-fwe",
                    "family": "per-test",
                    "permutations": 1000,
                    "seed": 5,
                },
                stratify={
                    "grouping": _grouping(
                        "site", [("North", ["north"]), ("South", ["south"])]
                    ),
                    "heterogeneity": True,
                },
            ),
        },
        {
            "name": "battery-missingness-bh",
            "population": ["SCI_P", "SCI_nNP"],
            "covariates": ["age", "sex", ETIV],
            "testCovariates": {"motor": ["score"]},
            "spec": _spec(
                [
                    _test(
                        "level",
                        "two-group",
                        label="Cervical vs thoracic-lumbar",
                        factor=_factor(
                            "level",
                            [("Cervical", ["cervical"]), ("T/L", ["thoracic_lumbar"])],
                            "T/L",
                            focal="Cervical",
                        ),
                    ),
                    _test(
                        "ais",
                        "two-group",
                        label="AIS A vs B-D",
                        factor=_factor(
                            "ais",
                            [("A", ["A"]), ("B-D", ["B", "C", "D"])],
                            "B-D",
                            focal="A",
                        ),
                    ),
                    _test(
                        "motor",
                        "association",
                        label="Motor score",
                        variable={"ref": REFS["motor"], "transform": "none"},
                        extraCovariates=[REFS["score"]],
                    ),
                    _test(
                        "tsi",
                        "association",
                        label="Time since injury",
                        variable={"ref": REFS["tsi"], "transform": "none"},
                        inFamily=False,
                    ),
                ],
                {
                    "sidedness": "two-sided",
                    "correction": "bh-fdr",
                    "family": "all-tests",
                    "permutations": 1000,
                    "seed": 20260924,
                },
                scope="within",
                population=SCI_POPULATION,
                derived=[MOTOR],
                head=("etiv", "all"),
            ),
        },
    ]


# ------------------------------------------------------------- Reference --
class Reference:
    """Compute one case's expected output with statsmodels and scipy."""

    def __init__(
        self, frame: pd.DataFrame, case: dict[str, Any], family_models: Any
    ) -> None:
        self.family_models = family_models
        self.case = case
        self.spec = spec = case["spec"]
        inference = spec["inference"]
        self.sidedness = inference["sidedness"]
        self.inference = inference
        frame = frame.sort_values("subject").reset_index(drop=True)
        if case["population"] is not None:
            frame = frame[frame.cohort.isin(case["population"])].reset_index(drop=True)
        self.frame = frame
        stratify = spec["stratify"]
        self.units: list[tuple[str, str | None, np.ndarray]] = []
        if stratify is None:
            self.units.append(("pooled", None, np.ones(len(frame), bool)))
            self.strata = None
        else:
            self.strata = self.labels(stratify["grouping"])
            self.units.append(("pooled", None, self.strata.notna().to_numpy()))
            for index, group in enumerate(stratify["grouping"]["groups"]):
                self.units.append(
                    (
                        f"stratum-{index + 1}",
                        group["label"],
                        (self.strata == group["label"]).to_numpy(),
                    )
                )
        self.eligible = {}
        for test in spec["tests"]:
            self.eligible[test["id"]] = self.test_mask(test)
        union = np.zeros(len(frame), bool)
        for test in spec["tests"]:
            for _key, _stratum, mask in self.units:
                union |= self.eligible[test["id"]] & mask
        self.population = np.flatnonzero(union)
        count = inference["permutations"]
        rng = np.random.default_rng(inference["seed"])
        n = len(self.population)
        self.perms = (
            np.array([rng.permutation(n) for _ in range(count)]) if count else None
        )
        self.terms: list[dict[str, Any]] = []

    # -- Columns --
    def labels(self, grouping: dict[str, Any]) -> pd.Series:
        name = next(k for k, ref in REFS.items() if ref == grouping["variable"])
        level_of = {
            level: group["label"]
            for group in grouping["groups"]
            for level in group["levels"]
        }
        return self.frame[name].map(
            lambda v: level_of.get(v) if isinstance(v, str) else None
        )

    def test_mask(self, test: dict[str, Any]) -> np.ndarray:
        ok = np.ones(len(self.frame), bool)
        factor = test["factor"]
        if factor is not None:
            labels = self.labels(factor["grouping"])
            defined = [g["label"] for g in factor["grouping"]["groups"]]
            modeled = (
                [g for g in defined if g in (factor["focal"], factor["reference"])]
                if test["kind"] == "two-group" and factor["model"] == "compared-groups"
                else defined
            )
            ok &= labels.isin(modeled).to_numpy()
        for part in ("variable", "moderator"):
            if test[part] is not None:
                name = next(k for k, ref in REFS.items() if ref == test[part]["ref"])
                ok &= self.frame[name].notna().to_numpy()
        for name in self.case.get("testCovariates", {}).get(test["id"], []):
            ok &= self.frame[name].notna().to_numpy()
        return ok

    def covariates_for(self, measure_id: str) -> list[str]:
        source, rule = (
            self.spec["covariates"]["headSize"]["source"],
            self.spec["covariates"]["headSize"]["rule"],
        )
        takes = (
            source != "none"
            and measure_id not in HEAD_SIZE_MEASURES
            and (rule == "all" or _is_extensive(measure_id))
        )
        return [k for k in self.case["covariates"] if k != ETIV or takes]

    # -- Models --
    def run(self) -> dict[str, Any]:
        spec = self.spec
        results: list[dict[str, Any]] = []
        for test in spec["tests"]:
            for unit_key, stratum, unit_mask in self.units:
                master = self.eligible[test["id"]] & unit_mask
                base = {"test": test, "unit": unit_key, "stratum": stratum}
                results.append(
                    {**base, "role": "effect", "pair": None, "master": master}
                )
                if test["kind"] == "omnibus" and test["pairwise"] != "none":
                    results.extend(
                        {**base, "role": "pairwise", "pair": pair, "master": master}
                        for pair in self.pairs(test)
                    )
            if spec["stratify"] is not None and spec["stratify"]["heterogeneity"]:
                master = self.eligible[test["id"]] & self.units[0][2]
                results.append(
                    {
                        "test": test,
                        "unit": "pooled",
                        "stratum": None,
                        "role": "heterogeneity",
                        "pair": None,
                        "master": master,
                    }
                )
        for index, term in enumerate(results):
            term["termId"] = f"term-{index + 1}"
            term["fits"] = {}
            term["nulls"] = {}
            for measure_id in spec["measures"]:
                fit = self.fit(term, measure_id)
                if fit is not None:
                    term["fits"][measure_id], term["nulls"][measure_id] = fit
        self.terms = results
        return self.assemble()

    def pairs(self, test: dict[str, Any]) -> list[tuple[str, str]]:
        groups = [g["label"] for g in test["factor"]["grouping"]["groups"]]
        reference = test["factor"]["reference"]
        others = [g for g in groups if g != reference]
        pairs = [(g, reference) for g in others]
        if test["pairwise"] == "all-pairs":
            pairs += [
                (others[b], others[a])
                for a in range(len(others))
                for b in range(a + 1, len(others))
            ]
        return pairs

    def variable(self, part: dict[str, Any], rows: np.ndarray) -> np.ndarray:
        name = next(k for k, ref in REFS.items() if ref == part["ref"])
        values = self.frame[name].to_numpy(dtype=float)[rows]
        if part["transform"] == "log1p":
            return np.log1p(values)
        if part["transform"] == "standardize":
            return (values - values.mean()) / values.std(ddof=1)
        return values

    def design(  # noqa: PLR0912, PLR0915
        self,
        term: dict[str, Any],
        rows: np.ndarray,
        master_rows: np.ndarray,
        covariates: list[str],
    ) -> tuple[pd.DataFrame, np.ndarray, list[str]]:
        """Return the design (baseline = the factor reference), R, and effect names."""
        test = term["test"]
        frame = self.frame.iloc[rows]
        columns: dict[str, np.ndarray] = {"Intercept": np.ones(len(rows))}
        for key in covariates + self.case.get("testCovariates", {}).get(test["id"], []):
            v = frame[key].to_numpy(float)
            if np.ptp(v) > 0:
                columns[f"cov:{key}"] = v - v.mean()
        effect: dict[str, np.ndarray] = {}
        hypothesis: list[np.ndarray | str] = []
        factor = test["factor"]
        groups: list[str] = []
        if factor is not None:
            labels = self.labels(factor["grouping"]).to_numpy()[rows]
            groups = [g["label"] for g in factor["grouping"]["groups"]]
            if test["kind"] == "two-group" and factor["model"] == "compared-groups":
                groups = [
                    g for g in groups if g in (factor["focal"], factor["reference"])
                ]
            if term["pair"] is not None and factor["model"] == "compared-groups":
                groups = [g for g in groups if g in term["pair"]]
            baseline = (
                factor["reference"]
                if factor["reference"] in groups
                else term["pair"][1]
            )
            for g in groups:
                if g != baseline and (labels == g).any():
                    effect[f"g:{g}"] = (labels == g).astype(float)
        if test["variable"] is not None:
            x_all = self.variable(test["variable"], master_rows)
            x = pd.Series(x_all, index=master_rows).loc[rows].to_numpy()
            effect["x"] = x - x.mean()
        if test["moderator"] is not None:
            name = next(k for k, ref in REFS.items() if ref == test["moderator"]["ref"])
            raw = self.frame[name].to_numpy()[rows]
            if isinstance(raw[0], str):
                levels = sorted(set(raw))
                for level in levels[1:]:
                    d = (raw == level).astype(float)
                    effect[f"lv:{level}"] = d - d.mean()
                for g in [k for k in list(effect) if k.startswith("g:")]:
                    for level in levels[1:]:
                        effect[f"{g}*lv:{level}"] = effect[g] * effect[f"lv:{level}"]
                        hypothesis.append(f"{g}*lv:{level}")
            else:
                m_all = self.variable(test["moderator"], master_rows)
                m = pd.Series(m_all, index=master_rows).loc[rows].to_numpy()
                effect["m"] = m - m.mean()
                for g in [k for k in list(effect) if k.startswith("g:")]:
                    effect[f"{g}*m"] = effect[g] * effect["m"]
                    hypothesis.append(f"{g}*m")
        kind = test["kind"]
        if kind == "two-group":
            hypothesis = [f"g:{factor['focal']}"]
        elif kind == "association":
            hypothesis = ["x"]
        elif kind == "omnibus":
            if term["pair"] is None:
                hypothesis = [k for k in effect if k.startswith("g:")]
            else:
                focal, reference = term["pair"]
                hypothesis = [(f"g:{focal}", f"g:{reference}")]  # type: ignore[list-item]
        if term["role"] == "heterogeneity":
            strata = self.strata.to_numpy()[rows]
            present = [
                g["label"]
                for g in self.spec["stratify"]["grouping"]["groups"]
                if (strata == g["label"]).any()
            ]
            base = dict(effect)
            hetero = []
            for label in present[1:]:
                s = (strata == label).astype(float)
                effect[f"s:{label}"] = s
                for name, column in base.items():
                    effect[f"{name}|s:{label}"] = column * s
                hetero.extend(f"{name}|s:{label}" for name in hypothesis)
            hypothesis = hetero
        columns.update(effect)
        x_frame = pd.DataFrame(columns)
        names = list(x_frame.columns)
        r_rows = []
        for item in hypothesis:
            row = np.zeros(len(names))
            if isinstance(item, tuple):
                row[names.index(item[0])] = 1.0
                if item[1] in names:
                    row[names.index(item[1])] = -1.0
            else:
                row[names.index(item)] = 1.0
            r_rows.append(row)
        return x_frame, np.array(r_rows), groups

    def fit(self, term: dict[str, Any], measure_id: str) -> Any:  # noqa: PLR0915
        test = term["test"]
        covariates = self.covariates_for(measure_id)
        master = term["master"].copy()
        factor = test["factor"]
        if term["pair"] is not None and factor["model"] == "compared-groups":
            master &= self.labels(factor["grouping"]).isin(term["pair"]).to_numpy()
        master_rows = np.flatnonzero(master)
        needed = [measure_id, *covariates]
        ok = master & self.frame[needed].notna().all(axis=1).to_numpy()
        rows = np.flatnonzero(ok)
        x_frame, r_matrix, _groups = self.design(term, rows, master_rows, covariates)
        y = self.frame[measure_id].to_numpy(float)[rows]
        result = sm.OLS(y, x_frame).fit(method="qr")
        df = float(result.df_resid)
        rank = r_matrix.shape[0]
        xm = x_frame.to_numpy()
        xtx_inv = np.linalg.inv(xm.T @ xm)
        cov_hc3 = result.cov_HC3
        b = result.params.to_numpy()
        row: dict[str, Any] = {
            "termId": term["termId"],
            "measureId": measure_id,
            "family": _family(measure_id),
            "nTotal": len(rows),
            "nFocal": None,
            "nReference": None,
            "estimate": None,
            "se": None,
            "t": None,
            "F": None,
            "df1": rank,
            "df2": int(df),
            "d": None,
            "dLow": None,
            "dHigh": None,
            "dRawSd": None,
            "partialR": None,
            "partialRLow": None,
            "partialRHigh": None,
            "slopePerSd": None,
            "pctOfReference": None,
            "inFamily": test["inFamily"],
        }
        if rank == 1:
            test_result = result.t_test(r_matrix)
            t = float(np.asarray(test_result.tvalue).ravel()[0])
            estimate = float(np.asarray(test_result.effect).ravel()[0])
            se = float(np.asarray(test_result.sd).ravel()[0])
            c = r_matrix[0]
            se3 = float(np.sqrt(c @ cov_hc3 @ c))
            r_value = t / np.sqrt(t * t + df)
            z = np.arctanh(r_value)
            row.update(
                estimate=estimate,
                se=se,
                t=t,
                p=self.p_value(t, df),
                pHc3=self.p_value(estimate / se3, df),
                partialEta2=t * t / (t * t + df),
                partialR=float(r_value),
                partialRLow=float(np.tanh(z - Z_CI / np.sqrt(df - 1))),
                partialRHigh=float(np.tanh(z + Z_CI / np.sqrt(df - 1))),
            )
            if term["role"] != "heterogeneity" and test["kind"] in (
                "two-group",
                "omnibus",
            ):
                focal, reference = term["pair"] or (
                    factor["focal"],
                    factor["reference"],
                )
                labels = self.labels(factor["grouping"]).to_numpy()[rows]
                a, b_ref = y[labels == focal], y[labels == reference]
                vjj = float(c @ xtx_inv @ c)
                d, low, high = self.family_models.d_with_ci(t, df, vjj)
                pooled = np.sqrt(
                    (
                        (len(a) - 1) * a.var(ddof=1)
                        + (len(b_ref) - 1) * b_ref.var(ddof=1)
                    )
                    / (len(a) + len(b_ref) - 2)
                )
                row.update(
                    nFocal=len(a),
                    nReference=len(b_ref),
                    d=float(d),
                    dLow=float(low),
                    dHigh=float(high),
                    dRawSd=float(estimate / pooled),
                    pctOfReference=float(100 * estimate / b_ref.mean()),
                )
            if term["role"] == "effect" and test["kind"] == "association":
                x = x_frame["x"].to_numpy()
                row["slopePerSd"] = float(estimate * x.std(ddof=1))
        else:
            f_result = result.f_test(r_matrix)
            f_value = float(np.asarray(f_result.fvalue).ravel()[0])
            assert int(f_result.df_num) == rank
            rb = r_matrix @ b
            wald = (
                float(rb @ np.linalg.solve(r_matrix @ cov_hc3 @ r_matrix.T, rb)) / rank
            )
            row.update(
                F=f_value,
                p=float(f_result.pvalue),
                pHc3=float(stats.f.sf(wald, rank, df)),
                partialEta2=rank * f_value / (rank * f_value + df),
            )
        null = None
        if self.perms is not None:
            null = self.null(xm, y, r_matrix, rows)
        return {"row": row, "detail": self.detail(term, result, x_frame, rows, y)}, null

    def null(
        self, xm: np.ndarray, y: np.ndarray, r_matrix: np.ndarray, rows: np.ndarray
    ) -> np.ndarray:
        """Refit the full design on permuted reduced residuals, one permutation at a time."""
        basis = linalg.null_space(r_matrix)
        z = xm @ basis
        e = y - z @ np.linalg.lstsq(z, y, rcond=None)[0]
        positions = self.family_models.induced_positions(
            self.perms, np.searchsorted(self.population, rows)
        )
        xtx_inv = np.linalg.inv(xm.T @ xm)
        middle = np.linalg.inv(r_matrix @ xtx_inv @ r_matrix.T)
        rank = r_matrix.shape[0]
        df = len(y) - xm.shape[1]
        out = np.empty(len(positions))
        for index, pos in enumerate(positions):
            y_star = e[pos]
            b = np.linalg.lstsq(xm, y_star, rcond=None)[0]
            residual = y_star - xm @ b
            s2 = residual @ residual / df
            rb = r_matrix @ b
            if rank == 1:
                t = rb[0] / np.sqrt(s2 * (r_matrix[0] @ xtx_inv @ r_matrix[0]))
                out[index] = self.statistic(t)
            else:
                out[index] = float(rb @ middle @ rb) / rank / s2
        return out

    def detail(  # noqa: PLR0912, PLR0915
        self,
        term: dict[str, Any],
        result: Any,
        x_frame: pd.DataFrame,
        rows: np.ndarray,
        y: np.ndarray,
    ) -> dict[str, Any] | None:
        """Group means and fitted-line points of an effect term (one measure)."""
        test = term["test"]
        if term["role"] != "effect" or (
            test["kind"] == "interaction"
            and test["moderator"]["ref"] == REFS["sexText"]
        ):
            return None
        names = list(x_frame.columns)
        factor = test["factor"]
        means = []
        if factor is not None:
            labels = self.labels(factor["grouping"]).to_numpy()[rows]
            groups = [g["label"] for g in factor["grouping"]["groups"]]
            if test["kind"] == "two-group" and factor["model"] == "compared-groups":
                groups = [
                    g for g in groups if g in (factor["focal"], factor["reference"])
                ]
            for label in groups:
                members = labels == label
                if not members.any():
                    continue
                point = np.zeros(len(names))
                point[0] = 1.0
                if f"g:{label}" in names:
                    point[names.index(f"g:{label}")] = 1.0
                frame = result.get_prediction(point[None, :]).summary_frame(alpha=0.05)
                means.append(
                    {
                        "label": label,
                        "n": int(members.sum()),
                        "mean": float(frame["mean"].iloc[0]),
                        "low": float(frame["mean_ci_lower"].iloc[0]),
                        "high": float(frame["mean_ci_upper"].iloc[0]),
                    }
                )
        lines = []
        slopes = []
        if test["kind"] == "association":
            x = x_frame["x"].to_numpy()
            center = 0.0
            raw_mean = None
            master_rows = np.flatnonzero(term["master"])
            x_raw = (
                pd.Series(
                    self.variable(test["variable"], master_rows), index=master_rows
                )
                .loc[rows]
                .to_numpy()
            )
            raw_mean = x_raw.mean()
            del center
            points = []
            for value in (
                x_raw.min(),
                raw_mean + 0.37 * (x_raw.max() - raw_mean),
                x_raw.max(),
            ):
                point = np.zeros(len(names))
                point[0] = 1.0
                point[names.index("x")] = value - raw_mean
                for index, name in enumerate(names):
                    if name.startswith("g:"):
                        point[index] = x_frame[name].mean()
                frame = result.get_prediction(point[None, :]).summary_frame(alpha=0.05)
                points.append(
                    [
                        float(value),
                        float(frame["mean"].iloc[0]),
                        float(frame["mean_ci_lower"].iloc[0]),
                        float(frame["mean_ci_upper"].iloc[0]),
                    ]
                )
            lines.append({"group": None, "points": points})
            del x
        elif test["kind"] == "interaction":
            name = next(k for k, ref in REFS.items() if ref == test["moderator"]["ref"])
            m_raw = self.frame[name].to_numpy(float)[rows]
            labels = self.labels(factor["grouping"]).to_numpy()[rows]
            for label in [g["label"] for g in factor["grouping"]["groups"]]:
                c = np.zeros(len(names))
                c[names.index("m")] = 1.0
                if f"g:{label}*m" in names:
                    c[names.index(f"g:{label}*m")] = 1.0
                t_result = result.t_test(c[None, :])
                low, high = np.asarray(t_result.conf_int(alpha=0.05)).ravel()
                slopes.append(
                    {
                        "group": label,
                        "slope": float(np.asarray(t_result.effect).ravel()[0]),
                        "low": float(low),
                        "high": float(high),
                    }
                )
                within = m_raw[labels == label]
                points = []
                for value in (within.min(), within.max()):
                    point = np.zeros(len(names))
                    point[0] = 1.0
                    point[names.index("m")] = value - m_raw.mean()
                    if f"g:{label}" in names:
                        point[names.index(f"g:{label}")] = 1.0
                        point[names.index(f"g:{label}*m")] = value - m_raw.mean()
                    frame = result.get_prediction(point[None, :]).summary_frame(
                        alpha=0.05
                    )
                    points.append(
                        [
                            float(value),
                            float(frame["mean"].iloc[0]),
                            float(frame["mean_ci_lower"].iloc[0]),
                            float(frame["mean_ci_upper"].iloc[0]),
                        ]
                    )
                lines.append({"group": label, "points": points})
        return {"groupMeans": means, "lines": lines, "simpleSlopes": slopes}

    def statistic(self, t: float) -> float:
        if self.sidedness == "two-sided":
            return abs(t)
        return t if self.sidedness == "higher" else -t

    def p_value(self, t: float, df: float) -> float:
        if self.sidedness == "two-sided":
            return float(2 * stats.t.sf(abs(t), df))
        if self.sidedness == "higher":
            return float(stats.t.sf(t, df))
        return float(stats.t.cdf(t, df))

    # -- Families --
    def family(self, term: dict[str, Any], rank: int) -> str | None:
        test = term["test"]
        if not test["inFamily"]:
            return None
        setting = self.inference["family"]
        by_test = setting in ("per-test", "per-test-and-measure-family")
        if term["role"] == "pairwise":
            if test["pairwiseFamily"] == "pooled":
                base = f"{test['id']}:pairs"
            else:
                base = f"{test['id']}:pair-{self.pairs(test).index(term['pair']) + 1}"
        elif term["role"] == "heterogeneity":
            base = f"{test['id']}:heterogeneity"
        elif test["kind"] == "interaction" or by_test:
            base = test["id"]
        else:
            base = "all-tests"
        if self.spec["stratify"] is not None:
            base = f"{term['unit']}:{base}"
        if self.inference["correction"] == "maxt-fwe":
            base = f"{base}:{'t' if rank == 1 else 'F'}{rank}"
        return base

    def assemble(self) -> dict[str, Any]:  # noqa: PLR0912, PLR0915
        inference = self.inference
        split = inference["family"] in (
            "per-measure-family",
            "per-test-and-measure-family",
        )
        count = inference["permutations"]
        terms = []
        members: dict[Any, list[tuple[dict[str, Any], str]]] = {}
        for term in self.terms:
            fits = term["fits"]
            rank = next(iter(fits.values()))["row"]["df1"] if fits else 1
            term["family"] = self.family(term, rank)
            test = term["test"]
            label = test["label"]
            if term["role"] == "pairwise":
                label = f"{term['pair'][0]} vs {term['pair'][1]}"
            elif term["role"] == "heterogeneity":
                label = f"Heterogeneity of {test['label']} across strata"
            terms.append(
                {
                    "termId": term["termId"],
                    "testId": test["id"],
                    "kind": "t" if rank == 1 else "F",
                    "rank": rank,
                    "role": term["role"],
                    "label": label,
                    "family": term["family"],
                    "stratum": term["stratum"],
                    "pair": None
                    if term["pair"] is None
                    else {"focal": term["pair"][0], "reference": term["pair"][1]},
                    "rowCount": len(fits),
                }
            )
            for measure_id, fit in fits.items():
                row = fit["row"]
                observed = self.statistic(row["t"]) if row["df1"] == 1 else row["F"]
                row["observed"] = observed
                row["pPermutation"] = (
                    float(
                        (1 + (term["nulls"][measure_id] >= observed).sum())
                        / (1 + count)
                    )
                    if count
                    else None
                )
                if term["family"] is not None:
                    key = (term["family"], _family(measure_id) if split else None)
                    members.setdefault(key, []).append((term, measure_id))
        correction = inference["correction"]
        for items in members.values():
            p = np.array([term["fits"][m]["row"]["p"] for term, m in items])
            if correction == "maxt-fwe":
                family_max = np.max(
                    np.column_stack([term["nulls"][m] for term, m in items]), axis=1
                )
                corrected = [
                    float(
                        (1 + (family_max >= term["fits"][m]["row"]["observed"]).sum())
                        / (1 + count)
                    )
                    for term, m in items
                ]
            elif correction == "bh-fdr":
                corrected = list(self.family_models.bh(p))
            elif correction == "holm":
                corrected = list(self.family_models.holm(p))
            elif correction == "bonferroni":
                corrected = list(np.minimum(p * len(p), 1.0))
            else:
                corrected = [None] * len(items)
            for (term, m), value in zip(items, corrected, strict=True):
                term["fits"][m]["row"]["pCorrected"] = (
                    None if value is None else float(value)
                )
        rows = []
        for term in self.terms:
            for measure_id in self.spec["measures"]:
                if measure_id not in term["fits"]:
                    continue
                row = term["fits"][measure_id]["row"]
                row.pop("observed")
                row.setdefault("pCorrected", None)
                if term["family"] is None and correction != "none":
                    row["significant"] = False
                else:
                    decisive = (
                        row["p"] if row["pCorrected"] is None else row["pCorrected"]
                    )
                    row["significant"] = bool(decisive <= inference["alpha"])
                row["gated"] = False
                rows.append(row)
        if inference["omnibusGate"]:
            for term in self.terms:
                if term["role"] != "pairwise":
                    continue
                effect = next(
                    t
                    for t in self.terms
                    if t["role"] == "effect"
                    and t["test"] is term["test"]
                    and t["unit"] == term["unit"]
                )
                for measure_id, fit in term["fits"].items():
                    omnibus = effect["fits"].get(measure_id)
                    fit["row"]["gated"] = not (
                        omnibus is not None and omnibus["row"]["significant"]
                    )
        detail = {
            term["termId"]: term["fits"][DETAIL_MEASURE]["detail"]
            for term in self.terms
            if DETAIL_MEASURE in term["fits"] and term["fits"][DETAIL_MEASURE]["detail"]
        }
        return {"terms": terms, "rows": rows, "detail": detail}


def _reference_implementation() -> Any:
    """Import ``analyses/lib/family_models.py``, the reference implementation."""
    sys.path.insert(0, str(HERE.parents[3] / "analyses" / "lib"))
    import family_models  # noqa: PLC0415

    return family_models


def frame_of(data: dict[str, Any], variables: dict[str, list[Any]]) -> pd.DataFrame:
    """Lay the stored dataset and the extra variables out as one frame."""
    frame = pd.DataFrame({"subject": data["subjects"], "cohort": data["cohorts"]})
    for key, values in data["covariates"].items():
        frame[key] = pd.array(values, dtype="Float64").astype(float)
    frame["score"] = pd.array(data["variables"]["score"], dtype="Float64").astype(float)
    frame["tsi"] = pd.array(data["variables"]["tsi"], dtype="Float64").astype(float)
    for key in ("site", "level", "ais", "sexText"):
        frame[key] = pd.Series(variables[key], dtype=object)
    frame["motor"] = pd.array(variables["motor"], dtype="Float64").astype(float)
    for measure_id in MEASURES:
        frame[measure_id] = pd.array(
            data["measures"][measure_id], dtype="Float64"
        ).astype(float)
    return frame


def f_goldens() -> list[dict[str, float]]:
    """Tabulate SciPy's F survival function."""
    return [
        {"f": f, "df1": d1, "df2": d2, "sf": float(stats.f.sf(f, d1, d2))}
        for d1 in (1.0, 2.0, 3.0, 7.0)
        for d2 in (1.0, 4.0, 27.0, 88.0, 1000.0)
        for f in (0.01, 0.4, 1.0, 2.7, 9.5, 60.0)
    ]


def main() -> int:
    """Write the v2 goldens next to this script."""
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args()
    family_models = _reference_implementation()
    data = json.loads((HERE / "engine-dataset.json").read_text(encoding="utf-8"))
    variables = make_variables(data)
    frame = frame_of(data, variables)
    out = []
    for case in cases():
        expected = Reference(frame, case, family_models).run()
        out.append({**case, "expected": expected})
    versions = {
        "numpy": np.__version__,
        "pandas": pd.__version__,
        "statsmodels": sm.__version__,
        "scipy": __import__("scipy").__version__,
    }
    (HERE / "engine-goldens-v2.json").write_text(
        json.dumps(
            {
                "generator": "generate_goldens_v2.py",
                "versions": versions,
                "variables": variables,
                "keys": KEYS,
                "fSf": f_goldens(),
                "cases": out,
            },
            indent=1,
        )
        + "\n"
    )
    print(f"Wrote {len(out)} v2 golden cases.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
