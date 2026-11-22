"""Clinical stratification (exploratory; Fig. 6, Table 2 q values, Results).

(a) Each SCI stratum vs all controls: adjusted d (95% CI, noncentral t), y ~ group + age + female + eTIV, for
    the outcomes of Fig. 6. Strata: cervical vs thoracic or lumbar, AIS A vs B to D, NPRS > 3 vs <= 3, and all
    participants with SCI as the reference.
(b) Within SCI, one stratifier at a time: outcome ~ stratifier + age + female + eTIV. Binary stratifiers give
    an adjusted d within SCI; continuous ones a coefficient per unit and a partial r (Fisher z CI). A test is
    inferential when each cell has at least eight participants (continuous: n >= 8); Benjamini-Hochberg q
    covers every inferential test of the grid (8 stratifiers x 14 outcomes = 112 in the paper). The minimum
    detectable effect at 80% power is given per test.
Outcomes: DCN region, ventral thalamic group, S1 trunk area, medulla and whole brainstem (subfields),
hypothalamus and cerebellar lobules I to VI (log(1 + y)), the medullary and non-medullary whole-brain DBM
cluster means, and the additional whole-brain measures named in the configuration (clinical.additional_measures).
Writes <output_dir>/clinical/stratum_vs_ctrl.csv and within_sci.csv.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import optimize, stats

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import clinical_lib as C  # noqa: E402
import config  # noqa: E402
import stats_lib  # noqa: E402
from family_models import bh  # noqa: E402

OUTCOMES = ["dcn", "thal_ventral", "s1_trunk_area", "medulla_sf", "brainstem_sf", "whole_hypothalamus", "lobules_I_VI",
            "dbm_medulla", "dbm_non_medullary"]
FIG6 = ["dcn", "medulla_sf", "thal_ventral", "s1_trunk_area", "dbm_medulla", "dbm_non_medullary"]
STRAT = {  # Name: (kind, column).
    "cervical": ("bin", "cervical"),
    "ais_a": ("bin", "ais_a"),
    "nprs": ("cont", "nprs"),
    "pain_group": ("bin", "pain_group"),
    "years_since_injury": ("cont", "years_since_injury"),
    "motor_total": ("cont", "motor_total"),
    "lt_total": ("cont", "lt_total"),
    "pp_total": ("cont", "pp_total"),
}
STRATA = [("Level", "cervical", {1: "Cervical", 0: "Thoracic/lumbar"}),
          ("Completeness", "ais_a", {1: "AIS A", 0: "AIS B-D"}),
          ("Pain", "pain_group", {1: "NPRS > 3", 0: "NPRS <= 3"})]
MINCELL = 8


def mde_d(n1: int, n0: int, k: int, power: float = 0.8) -> float:
    """Minimum detectable adjusted d (two-sided 0.05), noncentral t, df = n - 2 - k."""
    dfree = n1 + n0 - 2 - k
    tc = stats.t.ppf(0.975, dfree)
    sc = np.sqrt(n1 * n0 / (n1 + n0))

    def pw(d):
        return stats.nct.sf(tc, dfree, d * sc) + stats.nct.cdf(-tc, dfree, d * sc) - power

    hi = 0.5
    while hi < 6 and pw(hi) < 0:
        hi += 0.5
    return optimize.brentq(pw, 0.01, hi) if hi < 6 else np.nan


def mde_r(n: int, k: int, power: float = 0.8) -> float:
    c = stats.norm.ppf(0.975)
    return optimize.brentq(lambda r: stats.norm.sf(c - np.arctanh(r) * np.sqrt(n - 3 - k)) - power, 0.01, 0.99)


def within(frame: pd.DataFrame, o: str, cov: list[str], scol: str, kind: str) -> dict:
    f = frame.dropna(subset=[o, scol, *cov])
    keep = [c for c in cov if np.ptp(f[c].astype(float).values) > 0]
    f, X, m = C.ols(f, o, [scol, *keep])
    lo, hi = m.conf_int().loc[scol]
    out = dict(n=int(m.nobs), beta=m.params[scol], beta_lo=lo, beta_hi=hi, t=m.tvalues[scol], p=m.pvalues[scol])
    if kind == "bin":
        n1 = int(f[scol].sum())
        n0 = len(f) - n1
        k = np.sqrt(np.linalg.inv(X.T.values @ X.values)[1, 1])
        dlo, dhi = stats_lib.nct_ci(float(m.tvalues[scol]), float(m.df_resid))
        out.update(n_cell1=n1, n_cell0=n0, d=m.tvalues[scol] * k, d_lo=dlo * k, d_hi=dhi * k,
                   inferential=int(min(n1, n0) >= MINCELL), mde=mde_d(n1, n0, len(keep)))
    else:
        r = C.partial_r(f, scol, o, keep)
        out.update(partial_r=r["r"], r_lo=r["r_lo"], r_hi=r["r_hi"], inferential=int(len(f) >= MINCELL),
                   mde=mde_r(len(f), len(keep)))
    return out


def main():
    d = C.load(OUTCOMES)
    covs = {o: C.COV for o in OUTCOMES}
    extra, extra_cov = C.additional_measures()
    if extra is not None:
        cols = [c for c in extra.columns if c != "participant_id"]
        d = d.merge(extra, on="participant_id", how="left")
        covs.update({c: list(extra_cov.get(c, C.COV)) for c in cols})
    ct, sci = d[d.sci == 0], d[d.sci == 1]

    rows = []
    strata = [("All SCI", "All SCI", sci)] + [(lab, name, sci[sci[col] == v])
                                             for lab, col, vals in STRATA for v, name in vals.items()]
    for grp, name, s in strata:
        for o in FIG6:
            f = pd.concat([ct, s]).dropna(subset=[o, *covs[o]])
            r = stats_lib.fit(f, f[o].astype(float).values, "sci", tuple(covs[o]), log_outcome=False)
            rows.append(dict(stratifier=grp, stratum=name, outcome=o, n_sci=r["n_grp1"], n_ctrl=r["n_grp0"], d=r["d"],
                             d_lo=r["d_lo"], d_hi=r["d_hi"], p_param=r["p_param"]))
    A = pd.DataFrame(rows)
    A.to_csv(config.output_dir(C.SECTION) / "stratum_vs_ctrl.csv", index=False)

    rows = [dict(stratifier=sname, kind=kind, outcome=o, **within(sci, o, cv, scol, kind))
            for sname, (kind, scol) in STRAT.items() for o, cv in covs.items()]
    B = pd.DataFrame(rows)
    inf = B.inferential == 1
    B["q_bh"] = np.nan
    B.loc[inf, "q_bh"] = bh(B.loc[inf, "p"].to_numpy())
    B.to_csv(config.output_dir(C.SECTION) / "within_sci.csv", index=False)

    pd.set_option("display.width", 250)
    pd.set_option("display.max_rows", 500)
    print(f"Within SCI: {int(inf.sum())} inferential tests of {len(B)}; q < 0.05: {int((B.q_bh < 0.05).sum())}; "
          f"smallest q {B.q_bh.min():.3f}.")
    print(B.round(3).to_string(index=False))
    print(A.round(3).to_string(index=False))


if __name__ == "__main__":
    main()
