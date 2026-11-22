"""Generate the group-analysis engine goldens offline (not collected by pytest).

Writes ``engine-dataset.json`` (a synthetic three-group cohort),
``engine-goldens.json`` (specifications with their expected rows), and
``distribution-goldens.json`` (SciPy's t and noncentral-t values) next to
this script. The expected values come from the reference implementation in
``analyses/lib/family_models.py`` (``d_with_ci``, ``nct_ci``, ``bh``, ``holm``,
``induced_positions``, ``fit_family``, and ``add_corrections``) and
statsmodels, never from the engine. The HC3 standard errors come from
statsmodels' HC3 covariance; the reference implementation has no HC3
estimator. See docs/science.md for the environment and command.
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
from scipy import stats

HERE = Path(__file__).resolve().parent
N_SUBJECTS = 88
COHORTS = ["CTRL"] * 50 + ["SCI_P"] * 30 + ["SCI_nNP"] * 8
DATA_SEED = 20260930
ETIV = "eTIV"
EXTENSIVE_METRICS = {"NumVert", "SurfArea", "GrayVol", "FoldInd"}
SUBJECT_VALUE_MEASURES = 1

THICKNESS_REGIONS = ("precentral", "postcentral", "insula", "superiorfrontal")


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
def make_dataset() -> dict[str, Any]:
    """Draw the synthetic cohort: correlated measures with missing cells."""
    rng = np.random.default_rng(DATA_SEED)
    n = N_SUBJECTS
    ids = [f"sub-{index:03d}" for index in range(1, n + 1)]
    cohort = np.array(COHORTS)[rng.permutation(n)]
    sci = cohort != "CTRL"
    age = np.round(rng.uniform(19, 72, n), 2)
    female = (rng.uniform(size=n) < 0.36).astype(float)
    etiv = 1.52e6 - 1.3e5 * female + rng.normal(0, 1.1e5, n)
    latent = rng.normal(0, 1, n)
    tsi = np.where(sci, np.round(rng.uniform(0.5, 30, n), 2), np.nan)
    score = np.round(50 + 6 * latent + 4 * sci + rng.normal(0, 8, n), 3)
    score[rng.choice(n, 2, replace=False)] = np.nan
    head = (etiv - 1.45e6) / 1.45e6

    def measure(
        base: float, *, size: float, age_slope: float, effect: float, noise: float
    ):
        return base * (
            1
            + size * head
            + age_slope * (age - 45)
            + effect * sci
            + 0.03 * latent
            + noise * rng.normal(0, 1, n)
        )

    values: dict[str, np.ndarray] = {}
    for region, base in zip(THICKNESS_REGIONS, (2.55, 2.1, 2.9, 2.7), strict=True):
        for hemi in ("lh", "rh"):
            values[f"dk:{hemi}:{region}:ThickAvg"] = measure(
                base, size=0.0, age_slope=-0.003, effect=-0.02, noise=0.04
            )
    for hemi in ("lh", "rh"):
        values[f"dk:{hemi}:precentral:SurfArea"] = measure(
            4200.0, size=0.9, age_slope=-0.001, effect=-0.015, noise=0.06
        )
        values[f"dk:{hemi}:insula:GrayVol"] = measure(
            7400.0, size=1.0, age_slope=-0.002, effect=0.0, noise=0.07
        )
    values["aseg:Brain-Stem"] = measure(
        21500.0, size=0.8, age_slope=-0.0005, effect=-0.05, noise=0.06
    )
    for side in ("Left", "Right"):
        values[f"aseg:{side}-Thalamus"] = measure(
            7600.0, size=0.9, age_slope=-0.003, effect=-0.02, noise=0.05
        )
    values["aseg:Left-Hippocampus"] = measure(
        4100.0, size=0.7, age_slope=-0.002, effect=0.01, noise=0.07
    )
    # Missing cells, never among SCI_nNP (n 5) so every group keeps two.
    candidates = np.flatnonzero(cohort != "SCI_nNP")
    for measure_id in sorted(values):
        if measure_id in ("dk:lh:insula:ThickAvg", "aseg:Brain-Stem"):
            continue  # Complete measures share the full-sample block.
        k = int(rng.integers(1, 6))
        values[measure_id][rng.choice(candidates, k, replace=False)] = np.nan
    for region in ("precentral", "insula"):
        lh = values[f"dk:lh:{region}:ThickAvg"]
        rh = values[f"dk:rh:{region}:ThickAvg"]
        values[f"dk:bi:{region}:ThickAvg"] = (lh + rh) / 2
    values["aseg:bi:Thalamus"] = (
        values["aseg:Left-Thalamus"] + values["aseg:Right-Thalamus"]
    ) / 2
    values["global:eTIV"] = etiv.copy()
    values["global:meanThickness"] = measure(
        2.45, size=0.0, age_slope=-0.0025, effect=-0.01, noise=0.03
    )
    values["brainage:BrainPAD"] = 1.5 * sci + 0.8 * latent + rng.normal(0, 4.5, n)

    order = rng.permutation(n)  # Stored shuffled: the engine must sort.

    def listed(array: np.ndarray) -> list[float | None]:
        return [None if np.isnan(array[i]) else float(array[i]) for i in order]

    return {
        "subjects": [ids[i] for i in order],
        "cohorts": [str(cohort[i]) for i in order],
        "covariates": {
            "age": listed(age),
            "sex": listed(female),
            ETIV: listed(etiv),
        },
        "variables": {"score": listed(score), "tsi": listed(tsi)},
        "measures": {key: listed(array) for key, array in sorted(values.items())},
    }


# ------------------------------------------------------------- Scenarios --
def _groups(pairs: list[tuple[str, list[str]]]) -> list[dict[str, Any]]:
    return [{"label": label, "levels": levels} for label, levels in pairs]


def _spec(  # noqa: PLR0913
    measures: list[str],
    contrast: dict[str, Any],
    *,
    analysis: str = "group-comparison",
    age: bool = True,
    sex: bool = True,
    etiv: str = "extensive",
    extra: list[dict[str, str]] | None = None,
    inference: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schema": "supraspina/group-analysis-spec",
        "schemaVersion": 1,
        "analysis": analysis,
        "measures": measures,
        "contrast": contrast,
        "covariates": {
            "age": {"source": "registry", "column": "age"} if age else None,
            "sex": {"source": "registry", "column": "sex"} if sex else None,
            "etiv": etiv,
            "extra": extra or [],
            "centering": "sample-mean",
        },
        "inclusion": {
            "qc": "non-failed",
            "registration": "set-missing",
            "outliers": "keep",
        },
        "inference": {"alpha": 0.05, **inference},
    }


def _cohort_grouping(pairs: list[tuple[str, list[str]]]) -> dict[str, Any]:
    return {
        "variable": {"source": "registry", "column": "sourceCohortLabel"},
        "groups": _groups(pairs),
    }


SCI_CTRL = [("SCI", ["SCI_P", "SCI_nNP"]), ("CTRL", ["CTRL"])]
THREE = [("CTRL", ["CTRL"]), ("SCI_P", ["SCI_P"]), ("SCI_nNP", ["SCI_nNP"])]


def scenarios(measures: list[str]) -> list[dict[str, Any]]:
    """Return the golden scenarios: name, spec, and dataset options."""
    brain = [m for m in measures if not m.startswith("brainage:")]
    return [
        {
            "name": "sci-vs-ctrl-maxt-selected",
            "covariates": ["age", "sex", ETIV],
            "tested": None,
            "reference_contrast": "SCI_vs_CTRL",
            "spec": _spec(
                brain,
                {
                    "type": "groups",
                    "grouping": _cohort_grouping(SCI_CTRL),
                    "focal": "SCI",
                    "reference": "CTRL",
                    "model": "all-groups",
                },
                inference={
                    "sidedness": "two-sided",
                    "correction": "maxt-fwe",
                    "family": "selected",
                    "permutations": 5000,
                    "seed": 20260923,
                },
            ),
        },
        {
            "name": "scip-vs-ctrl-lower-holm-per-family",
            "covariates": ["age", "sex", ETIV],
            "tested": None,
            "reference_contrast": None,
            "spec": _spec(
                brain,
                {
                    "type": "groups",
                    "grouping": _cohort_grouping(THREE),
                    "focal": "SCI_P",
                    "reference": "CTRL",
                    "model": "all-groups",
                },
                etiv="all",
                inference={
                    "sidedness": "lower",
                    "correction": "holm",
                    "family": "per-family",
                    "permutations": 1000,
                    "seed": 11,
                },
            ),
        },
        {
            "name": "nnp-vs-p-compared-higher-bh",
            "covariates": ["sex", ETIV],
            "tested": None,
            "reference_contrast": None,
            "spec": _spec(
                brain,
                {
                    "type": "groups",
                    "grouping": _cohort_grouping(THREE),
                    "focal": "SCI_nNP",
                    "reference": "SCI_P",
                    "model": "compared-groups",
                },
                age=False,
                inference={
                    "sidedness": "higher",
                    "correction": "bh-fdr",
                    "family": "per-family",
                    "permutations": 1000,
                    "seed": 5,
                },
            ),
        },
        {
            "name": "association-score-group-adjusted-bonferroni",
            "covariates": ["age", "sex", ETIV],
            "tested": "score",
            "reference_contrast": None,
            "spec": _spec(
                brain,
                {
                    "type": "association",
                    "variable": {"source": "metadata-csv", "column": "score"},
                    "grouping": _cohort_grouping(SCI_CTRL),
                    "includedGroups": ["SCI", "CTRL"],
                    "adjustForGroup": True,
                },
                analysis="association",
                inference={
                    "sidedness": "two-sided",
                    "correction": "bonferroni",
                    "family": "selected",
                    "permutations": 1000,
                    "seed": 3,
                },
            ),
        },
        {
            "name": "association-tsi-sci-extra-covariate",
            "covariates": ["age", "sex", "extra:score", ETIV],
            "tested": "tsi",
            "reference_contrast": None,
            "spec": _spec(
                brain,
                {
                    "type": "association",
                    "variable": {"source": "registry", "column": "tSinceSci"},
                    "grouping": _cohort_grouping(
                        [
                            ("SCI_P", ["SCI_P"]),
                            ("SCI_nNP", ["SCI_nNP"]),
                            ("CTRL", ["CTRL"]),
                        ]
                    ),
                    "includedGroups": ["SCI_P", "SCI_nNP"],
                    "adjustForGroup": False,
                },
                analysis="association",
                extra=[{"source": "metadata-csv", "column": "score"}],
                inference={
                    "sidedness": "two-sided",
                    "correction": "none",
                    "family": "selected",
                    "permutations": 0,
                    "seed": 1,
                },
            ),
        },
        {
            "name": "brain-age-sci-vs-ctrl",
            "covariates": ["age", "sex", ETIV],
            "tested": None,
            "reference_contrast": "SCI_vs_CTRL",
            "spec": _spec(
                ["brainage:BrainPAD"],
                {
                    "type": "groups",
                    "grouping": _cohort_grouping(SCI_CTRL),
                    "focal": "SCI",
                    "reference": "CTRL",
                    "model": "all-groups",
                },
                analysis="brain-age",
                inference={
                    "sidedness": "two-sided",
                    "correction": "maxt-fwe",
                    "family": "selected",
                    "permutations": 5000,
                    "seed": 20260923,
                },
            ),
        },
    ]


# ------------------------------------------------------------- Reference --
class Reference:
    """Compute one scenario's expected output with the reference
    implementation and statsmodels.
    """

    def __init__(
        self, data: dict[str, Any], scenario: dict[str, Any], family_models: Any
    ) -> None:
        self.family_models = family_models
        self.scenario = scenario
        spec = scenario["spec"]
        self.spec = spec
        contrast = spec["contrast"]
        label_of: dict[str, str] = {}
        grouping = contrast.get("grouping")
        if grouping is not None:
            for group in grouping["groups"]:
                for level in group["levels"]:
                    label_of[level] = group["label"]
        frame = pd.DataFrame(
            {
                "subject": data["subjects"],
                "cohort": data["cohorts"],
                "group": [label_of.get(c) for c in data["cohorts"]],
            }
        )
        for key in scenario["covariates"]:
            source = key.removeprefix("extra:")
            column = data["covariates"].get(source, data["variables"].get(source))
            frame[key] = pd.array(column, dtype="Float64").astype(float)
        if scenario["tested"]:
            frame["tested"] = pd.array(
                data["variables"][scenario["tested"]], dtype="Float64"
            ).astype(float)
        for measure_id in spec["measures"]:
            frame[measure_id] = pd.array(
                data["measures"][measure_id], dtype="Float64"
            ).astype(float)
        frame = frame.sort_values("subject").reset_index(drop=True)
        defined = [g["label"] for g in grouping["groups"]] if grouping else []
        if contrast["type"] == "groups":
            modeled = (
                defined
                if contrast["model"] == "all-groups"
                else [
                    g
                    for g in defined
                    if g in (contrast["focal"], contrast["reference"])
                ]
            )
            frame = frame[frame.group.isin(modeled)]
            self.indicators = [g for g in modeled if g != contrast["reference"]]
            self.mean_groups = modeled
            self.focal, self.reference = contrast["focal"], contrast["reference"]
            self.tested_name = f"group:{self.focal}"
        else:
            frame = frame[frame.tested.notna()]
            if grouping is not None:
                included = [g for g in defined if g in contrast["includedGroups"]]
                frame = frame[frame.group.isin(included)]
                adjust = contrast["adjustForGroup"]
                self.indicators = included[1:] if adjust else []
                self.mean_groups = included if adjust else []
                self.reference = included[0] if adjust else None
            else:
                self.indicators, self.mean_groups, self.reference = [], [], None
            self.focal = None
            self.tested_name = "tested"
        self.master = frame.reset_index(drop=True)
        self.n_master = len(self.master)
        inference = spec["inference"]
        self.sidedness = inference["sidedness"]
        count = inference["permutations"]
        rng = np.random.default_rng(inference["seed"])
        self.perms = (
            np.array([rng.permutation(self.n_master) for _ in range(count)])
            if count
            else None
        )

    def covariates_for(self, measure_id: str) -> list[str]:
        rule = self.spec["covariates"]["etiv"]
        takes = (
            measure_id != "global:eTIV"
            and rule != "none"
            and (rule == "all" or _is_extensive(measure_id))
        )
        return [k for k in self.scenario["covariates"] if k != ETIV or takes]

    def design(self, rows: pd.DataFrame, covariates: list[str]) -> pd.DataFrame:
        columns: dict[str, np.ndarray] = {"Intercept": np.ones(len(rows))}
        if self.tested_name == "tested":
            x = rows["tested"].to_numpy()
            columns["tested"] = x - x.mean()
        for label in self.indicators:
            indicator = (rows["group"] == label).to_numpy(float)
            if indicator.any():
                columns[f"group:{label}"] = indicator
        for key in covariates:
            v = rows[key].to_numpy(float)
            columns[key] = v - v.mean()
        return pd.DataFrame(columns)

    def statistic(self, t: np.ndarray) -> np.ndarray:
        if self.sidedness == "two-sided":
            return np.abs(t)
        return t if self.sidedness == "higher" else -t

    def p_value(self, t: float, df: float) -> float:
        if self.sidedness == "two-sided":
            return float(2 * stats.t.sf(abs(t), df))
        if self.sidedness == "higher":
            return float(stats.t.sf(t, df))
        return float(stats.t.cdf(t, df))

    def fit(self, measure_id: str) -> tuple[dict[str, Any], np.ndarray | None]:
        covariates = self.covariates_for(measure_id)
        needed = [measure_id, *covariates] + (
            ["tested"] if self.tested_name == "tested" else []
        )
        ok = self.master[needed].notna().all(axis=1).to_numpy()
        rows_index = np.flatnonzero(ok)
        rows = self.master.iloc[rows_index].reset_index(drop=True)
        x = self.design(rows, covariates)
        y = rows[measure_id].to_numpy(float)
        names = list(x.columns)
        j = names.index(self.tested_name)
        result = sm.OLS(y, x).fit()
        df = float(result.df_resid)
        beta = float(result.params.iloc[j])
        se = float(result.bse.iloc[j])
        t = float(result.tvalues.iloc[j])
        hc3 = result.get_robustcov_results(cov_type="HC3")
        se3 = float(np.sqrt(hc3.cov_params()[j, j]))
        xtx_inv = np.linalg.inv(x.to_numpy().T @ x.to_numpy())
        vjj = float(xtx_inv[j, j])
        row: dict[str, Any] = {
            "measureId": measure_id,
            "family": _family(measure_id),
            "nTotal": len(rows),
            "nFocal": None,
            "nReference": None,
            "estimate": beta,
            "se": se,
            "t": t,
            "df": int(df),
            "p": self.p_value(t, df),
            "d": None,
            "dLow": None,
            "dHigh": None,
            "dRawSd": None,
            "partialEta2": t**2 / (t**2 + df),
            "pctOfReference": None,
            "pHc3": self.p_value(beta / se3, df),
        }
        if self.focal is not None:
            focal = y[(rows.group == self.focal).to_numpy()]
            reference = y[(rows.group == self.reference).to_numpy()]
            d, low, high = self.family_models.d_with_ci(t, df, vjj)
            pooled = np.sqrt(
                (
                    (len(focal) - 1) * focal.var(ddof=1)
                    + (len(reference) - 1) * reference.var(ddof=1)
                )
                / (len(focal) + len(reference) - 2)
            )
            row.update(
                nFocal=len(focal),
                nReference=len(reference),
                d=float(d),
                dLow=float(low),
                dHigh=float(high),
                dRawSd=float(beta / pooled),
                pctOfReference=float(100 * beta / reference.mean()),
            )
        means = []
        for label in self.mean_groups:
            members = (rows.group == label).to_numpy()
            if not members.any():
                continue
            point = np.zeros(len(names))
            point[0] = 1.0
            if f"group:{label}" in names:
                point[names.index(f"group:{label}")] = 1.0
            frame = result.get_prediction(point[None, :]).summary_frame(alpha=0.05)
            means.append(
                {
                    "label": label,
                    "role": "focal"
                    if label == self.focal
                    else "reference"
                    if label == self.reference
                    else "other",
                    "n": int(members.sum()),
                    "mean": float(frame["mean"].iloc[0]),
                    "low": float(frame["mean_ci_lower"].iloc[0]),
                    "high": float(frame["mean_ci_upper"].iloc[0]),
                }
            )
        adjusted = y - x[covariates].to_numpy() @ result.params[covariates].to_numpy()
        subjects = [
            {
                "subjectId": rows.subject.iloc[i],
                "group": rows.group.iloc[i],
                "sourceLabel": rows.cohort.iloc[i],
                "value": float(y[i]),
                "adjusted": float(adjusted[i]),
                "x": float(rows.tested.iloc[i])
                if self.tested_name == "tested"
                else None,
            }
            for i in range(len(rows))
        ]
        null = None
        if self.perms is not None:
            # Freedman-Lane on the reference implementation's induced
            # positions, so every measure shares one permutation stream.
            xm = x.to_numpy()
            z = np.delete(xm, j, axis=1)
            e = y - z @ np.linalg.lstsq(z, y, rcond=None)[0]
            a = xtx_inv @ xm.T
            rx = np.eye(len(rows)) - xm @ a
            positions = self.family_models.induced_positions(self.perms, rows_index)
            es = e[positions]  # Shape (b, n).
            bj = es @ a[j]
            residual = es @ rx.T
            s2 = (residual**2).sum(1) / df
            null = self.statistic(bj / np.sqrt(s2 * vjj))
        return {"row": row, "groupMeans": means, "subjects": subjects}, null


def expected(
    data: dict[str, Any], scenario: dict[str, Any], family_models: Any
) -> dict[str, Any]:
    """Compute the expected rows, group means, and subject values."""
    reference = Reference(data, scenario, family_models)
    spec = scenario["spec"]
    inference = spec["inference"]
    fits = {}
    nulls = {}
    for measure_id in spec["measures"]:
        fits[measure_id], nulls[measure_id] = reference.fit(measure_id)
    ids = spec["measures"]
    families: dict[str, list[str]] = {}
    for measure_id in ids:
        key = "selected" if inference["family"] == "selected" else _family(measure_id)
        families.setdefault(key, []).append(measure_id)
    count = inference["permutations"]
    observed = {
        m: float(reference.statistic(np.array([fits[m]["row"]["t"]]))[0]) for m in ids
    }
    for measure_id in ids:
        row = fits[measure_id]["row"]
        row["pPermutation"] = (
            float((1 + (nulls[measure_id] >= observed[measure_id]).sum()) / (1 + count))
            if count
            else None
        )
    correction = inference["correction"]
    for members in families.values():
        p = np.array([fits[m]["row"]["p"] for m in members])
        if correction == "maxt-fwe":
            family_max = np.max(np.column_stack([nulls[m] for m in members]), axis=1)
            corrected = [
                float((1 + (family_max >= observed[m]).sum()) / (1 + count))
                for m in members
            ]
        elif correction == "bh-fdr":
            corrected = list(family_models.bh(p))
        elif correction == "holm":
            corrected = list(family_models.holm(p))
        elif correction == "bonferroni":
            corrected = list(np.minimum(p * len(p), 1.0))
        else:
            corrected = [None] * len(members)
        for measure_id, value in zip(members, corrected, strict=True):
            row = fits[measure_id]["row"]
            row["pCorrected"] = None if value is None else float(value)
            decisive = row["p"] if value is None else value
            row["significant"] = bool(decisive <= inference["alpha"])
    if scenario["reference_contrast"]:
        cross_check_reference(data, scenario, fits, family_models)
    return {
        "rows": [fits[m]["row"] for m in ids],
        "groupMeans": {m: fits[m]["groupMeans"] for m in ids},
        "subjectValues": {m: fits[m]["subjects"] for m in ids[:SUBJECT_VALUE_MEASURES]},
    }


def cross_check_reference(
    data: dict[str, Any],
    scenario: dict[str, Any],
    fits: dict[str, Any],
    family_models: Any,
) -> None:
    """Assert that ``fit_family`` and ``add_corrections`` give the same numbers."""
    spec = scenario["spec"]
    reference = Reference(data, scenario, family_models)
    master = reference.master.copy()
    master["sci"] = (master["cohort"] != "CTRL").astype(float)
    master = master.rename(columns={"sex": "female"})
    renamed = {m: f"m{i}" for i, m in enumerate(spec["measures"])}
    master = master.rename(columns=renamed)
    include = np.ones(len(master), bool)

    def covars_for(column: str) -> list[str]:
        measure_id = next(m for m, c in renamed.items() if c == column)
        return [
            "female" if k == "sex" else k for k in reference.covariates_for(measure_id)
        ]

    cols = list(renamed.values())
    res, t0 = family_models.fit_family(
        master,
        include,
        cols,
        scenario["reference_contrast"],
        covars_for,
        reference.perms,
    )
    res = family_models.add_corrections(res, t0, {"all": cols}).set_index("measure")
    for measure_id, column in renamed.items():
        row = fits[measure_id]["row"]
        mine = res.loc[column]
        for key, theirs in (
            ("t", "t"),
            ("p", "p"),
            ("d", "d_adj"),
            ("dLow", "d_lo"),
            ("dHigh", "d_hi"),
            ("pctOfReference", "pct_of_ref_mean"),
        ):
            assert abs(row[key] - mine[theirs]) <= 1e-9 * max(1.0, abs(mine[theirs])), (
                key
            )
        assert row["pPermutation"] == mine["p_perm"]
        if spec["inference"]["correction"] == "maxt-fwe":
            assert row["pCorrected"] == mine["p_fwe_family"]


def distribution_goldens(family_models: Any) -> dict[str, Any]:
    """Tabulate SciPy's t and noncentral-t values and the reference ``nct_ci``."""
    from scipy import special  # noqa: PLC0415

    dfs = [1.0, 2.0, 3.0, 5.0, 10.0, 29.0, 88.0, 89.0, 200.0, 1000.0]
    ts = [-12.0, -5.0, -2.5, -1.0, -0.3, 0.2, 0.9, 1.7, 3.2, 6.0, 15.0]
    ps = [1e-8, 0.001, 0.025, 0.3, 0.5, 0.8, 0.975, 0.9999]
    rng = np.random.default_rng(7)
    shapes = [
        (float(a), float(b), float(x))
        for a, b, x in zip(
            rng.uniform(0.3, 60, 40),
            rng.uniform(0.3, 60, 40),
            rng.uniform(0, 1, 40),
            strict=True,
        )
    ]
    return {
        "t": [
            {
                "t": t,
                "df": df,
                "cdf": float(stats.t.cdf(t, df)),
                "sf": float(stats.t.sf(t, df)),
            }
            for df in dfs
            for t in ts
        ],
        "tPpf": [
            {"p": p, "df": df, "t": float(stats.t.ppf(p, df))} for df in dfs for p in ps
        ],
        "betainc": [
            {"a": a, "b": b, "x": x, "value": float(special.betainc(a, b, x))}
            for a, b, x in shapes
        ],
        "nct": [
            {"t": t, "df": df, "ncp": ncp, "cdf": float(stats.nct.cdf(t, df, ncp))}
            for df in (3.0, 10.0, 88.0, 1000.0)
            for t in (-4.0, -1.2, 0.0, 0.7, 3.5)
            for ncp in (-6.0, -2.0, -0.5, 0.0, 0.5, 2.0, 6.0)
        ],
        "nctInterval": [
            {
                "t": t,
                "df": df,
                "interval": [float(v) for v in family_models.nct_ci(t, df)],
            }
            for df in (5.0, 30.0, 88.0, 89.0, 400.0)
            for t in (-3.2, -1.0, 0.0, 0.4, 2.5, 5.0)
        ],
    }


def _reference_implementation() -> Any:
    """Import ``analyses/lib/family_models.py``, the reference implementation."""
    sys.path.insert(0, str(HERE.parents[3] / "analyses" / "lib"))
    import family_models  # noqa: PLC0415

    return family_models


def main() -> int:
    """Write the dataset and goldens next to this script."""
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args()
    family_models = _reference_implementation()
    data = make_dataset()
    cases = [
        {
            "name": scenario["name"],
            "covariates": scenario["covariates"],
            "tested": scenario["tested"],
            "spec": scenario["spec"],
            "expected": expected(data, scenario, family_models),
        }
        for scenario in scenarios(list(data["measures"]))
    ]
    versions = {
        "numpy": np.__version__,
        "pandas": pd.__version__,
        "statsmodels": sm.__version__,
        "scipy": __import__("scipy").__version__,
    }
    (HERE / "distribution-goldens.json").write_text(
        json.dumps(
            {"versions": versions, **distribution_goldens(family_models)}, indent=1
        )
        + "\n"
    )
    (HERE / "engine-dataset.json").write_text(json.dumps(data, indent=1) + "\n")
    (HERE / "engine-goldens.json").write_text(
        json.dumps(
            {"generator": "generate_goldens.py", "versions": versions, "cases": cases},
            indent=1,
        )
        + "\n"
    )
    print(f"Wrote {len(cases)} golden cases for {len(data['subjects'])} subjects.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
