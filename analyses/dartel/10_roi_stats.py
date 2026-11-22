"""Group comparison of the four DARTEL brainstem regions (gray plus white matter, unsmoothed).

Model: y ~ SCI + age + sex + SPM TIV (liters), OLS. Adjusted d = t sqrt(v_jj) with a noncentral-t 95% CI; percent
difference = 100 beta / control mean. Family-wise P: Freedman-Lane max-|t| over the four regions, 5,000
permutations, seed 20260924 (the reported P values come from the converged engine, which reads outcome_values.csv).
Writes roi_stats.csv (group level) and outcome_values.csv (participant level, work folder).
"""

import numpy as np
import pandas as pd

import dartel_common as dc
import stats_lib

SEED, NPERM = 20260924, 5000
FAMILY = [f"{r}|gmwm_fwhm0" for r in dc.REGIONS]
# Participant-level columns read by the converged permutation engine.
OUTCOMES = sorted(FAMILY + ["medulla_z|mwc1_fwhm0", "medulla_z|mwc2_fwhm0"])

d = dc.design()
vals = pd.read_csv(dc.WORK / "roi_values.csv")
f = d.merge(vals, on="participant_id", how="left")
assert f[FAMILY].notna().all().all(), "Region values are missing for some participants."

_, _, p_fwe = stats_lib.fl_maxt(f, f[FAMILY].to_numpy(float), gcol="sci", cov=dc.COV, n_perm=NPERM, seed=SEED)
rows = []
for j, c in enumerate(FAMILY):
    r = stats_lib.fit(f, f[c].to_numpy(float), gcol="sci", cov=dc.COV, log_outcome=False)
    rows.append(dict(family="brainstem_GMWM", measure=c, n=r["n"], n_sci=r["n_grp1"], n_ctrl=r["n_grp0"],
                     ctrl_mean=r["grp0_mean"], beta=r["beta"], beta_lo=r["beta_lo"], beta_hi=r["beta_hi"],
                     pct=r["pct"], d=r["d"], d_lo=r["d_lo"], d_hi=r["d_hi"], t=r["t"], df=r["df"], p=r["p_param"],
                     p_fwe_family_5000=p_fwe[j]))
res = pd.DataFrame(rows)
res.to_csv(dc.OUT / "roi_stats.csv", index=False, float_format="%.5g")
f[["participant_id", "sci", *dc.COV, *OUTCOMES]].to_csv(dc.WORK / "outcome_values.csv", index=False)
for _, r in res.iterrows():
    print(f"{r.measure}: n {r.n_sci} vs {r.n_ctrl}; {r.pct:+.1f}%; d {r.d:+.2f} ({r.d_lo:+.2f} to {r.d_hi:+.2f}); "
          f"p {r.p:.3g}; p_FWE (5,000) {r.p_fwe_family_5000:.3g}")
print("Outcome values:", len(f), "participants,", int(np.sum(f.sci == 1)), "SCI.")
