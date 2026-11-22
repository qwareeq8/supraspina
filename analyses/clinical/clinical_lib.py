"""Data assembly and within-SCI statistics shared by the clinical analyses.

The analysis frame is the participants table joined with per-participant outcomes of other sections, read
from their work folders. Models adjust for age, sex, and eTIV (liters). Partial correlations residualize
both variables on [1, covariates]; the 95% CI is Fisher z with SE 1 / sqrt(n - 3 - k), and P is the t test
with n - 2 - k df (k covariates).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

SECTION = "clinical"
COV = ["age", "female", "eTIV_l"]

# Outcome name used here -> (section, file in its work folder, column in that file).
SOURCES = {
    "dcn": ("compartments", "outcome_values.csv", "R3_dcn_region_t50"),
    "thal_ventral": ("thalamus", "outcome_values.csv", "thal_Ventral_bi"),
    "s1_trunk_area": ("cortex", "s1_trunk.csv", "s1_trunk_area"),
    "medulla_sf": ("subfields", "outcome_values.csv", "subfield_Medulla"),
    "brainstem_sf": ("subfields", "outcome_values.csv", "subfield_Whole_brainstem"),
    # Already on the log(1 + y) scale.
    "whole_hypothalamus": ("exploratory", "outcome_values.csv", "D1_whole_hypothalamus"),
    "lobules_I_VI": ("exploratory", "outcome_values.csv", "D4_lobules_I_VI"),
    "dbm_medulla": ("dbm_wholebrain", "cluster_means.csv", "dbm_medulla"),
    "dbm_non_medullary": ("dbm_wholebrain", "cluster_means.csv", "dbm_non_medullary"),
}
# Eligibility columns (1 = usable) read with an outcome; ineligible values are set missing.
ELIGIBILITY = {"thal_ventral": "elig_thalamus"}


def _optional(key: str):
    """Value of an optional dotted configuration key, or None."""
    node = config.load()
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def additional_measures() -> tuple[pd.DataFrame | None, dict[str, list[str]]]:
    """Additional whole-brain measures of the stratification family, from sections outside this release.

    clinical.additional_measures names a private table (participant_id plus one column per measure, already
    transformed for analysis); clinical.additional_covariates gives covariates that differ from age, sex,
    and eTIV ({column: [covariates]}).
    """
    p = _optional("clinical.additional_measures")
    if not p:
        return None, {}
    d = config.read_private(config.path("clinical.additional_measures"))
    return d, dict(_optional("clinical.additional_covariates") or {})


def load(outcomes=()) -> pd.DataFrame:
    """Participants table plus the requested outcomes (missing cells stay NaN; complete cases per model)."""
    d = config.participants()
    by_file: dict[tuple[str, str], dict[str, str]] = {}
    for o in outcomes:
        sec, fname, col = SOURCES[o]
        by_file.setdefault((sec, fname), {})[col] = o
        if o in ELIGIBILITY:
            by_file[(sec, fname)][ELIGIBILITY[o]] = f"_elig_{o}"
    for (sec, fname), cols in by_file.items():
        src = config.read_private(config.work_dir(sec) / fname)
        missing = [c for c in cols if c not in src.columns]
        if missing:
            raise SystemExit(f"{sec}/{fname} lacks columns {missing}.")
        d = d.merge(src[["participant_id", *cols]].rename(columns=cols), on="participant_id", how="left")
    for o in ELIGIBILITY:
        if o in d:
            d.loc[d.pop(f"_elig_{o}") != 1, o] = np.nan
    # NPRS > 3 (moderate to severe pain) vs NPRS <= 3 (no or mild pain).
    if "nprs" in d:
        d["pain_group"] = np.where(d.nprs.notna(), (d.nprs > 3).astype(float), np.nan)
    return d


def sci_only(d: pd.DataFrame, sensitivity: bool = False) -> pd.DataFrame:
    """Participants with SCI; with sensitivity=True, without those flagged sensitivity_exclude."""
    s = d[d.sci == 1]
    return s[s.sensitivity_exclude.fillna(0) != 1] if sensitivity else s


def sensitivity_sample(d: pd.DataFrame) -> pd.DataFrame:
    """All controls plus the SCI participants of the sensitivity analyses."""
    return d[(d.sci == 0) | ((d.sci == 1) & (d.sensitivity_exclude.fillna(0) != 1))]


def partial_r(frame: pd.DataFrame, x: str, y: str, cov) -> dict:
    f = frame[[x, y, *cov]].dropna().astype(float)
    keep = [c for c in cov if np.ptp(f[c].values) > 0]
    Z = np.column_stack([np.ones(len(f))] + [f[c].values for c in keep])
    H = Z @ np.linalg.pinv(Z)
    rx, ry = f[x].values - H @ f[x].values, f[y].values - H @ f[y].values
    r = float(np.corrcoef(rx, ry)[0, 1])
    n, k = len(f), len(keep)
    dfree = n - 2 - k
    t = r * np.sqrt(dfree / (1 - r * r))
    z, se = np.arctanh(r), 1 / np.sqrt(n - 3 - k)
    return dict(n=n, k_cov=k, r=r, r_lo=float(np.tanh(z - 1.96 * se)), r_hi=float(np.tanh(z + 1.96 * se)),
                t=t, df=dfree, p=float(2 * stats.t.sf(abs(t), dfree)))


def ols(frame: pd.DataFrame, y: str, terms: list[str]):
    """OLS of y on an intercept and terms over complete cases: (frame used, design, fitted model)."""
    f = frame.dropna(subset=[y, *terms])
    X = sm.add_constant(f[terms].astype(float))
    return f, X, sm.OLS(f[y].astype(float), X).fit()


def vif(X: pd.DataFrame) -> list[float]:
    """Variance inflation factor of every non-constant column of a design with an intercept first."""
    Xv = X.values
    return [1 / (1 - sm.OLS(Xv[:, j], np.delete(Xv, j, axis=1)).fit().rsquared) for j in range(1, Xv.shape[1])]
