"""Whole hypothalamus and cerebellar lobules I to VI: SCI vs control, each tested alone (exploratory).

Model (stats_lib): log(1 + volume) ~ SCI + age + sex + eTIV (liters), OLS; adjusted d with a noncentral-t CI,
percentage difference 100 (exp(beta) - 1), parametric P, and a single Freedman-Lane permutation P (5,000, seed
20260924); no multiplicity correction. The cervical subgroup against all controls is descriptive.
Writes <output_dir>/exploratory/exploratory_sci_vs_ctrl.csv and the participant-level
<work_dir>/exploratory/outcome_values.csv (analysis scale, log(1 + y)).
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
from stats_lib import fit, fl_maxt  # noqa: E402

WORK = config.work_dir("exploratory")
OUT = config.output_dir("exploratory")
COV = ("age", "female", "eTIV_l")
# Each entry: (outcome-values column, measure file, measure).
MEASURES = [("D1_whole_hypothalamus", "hypo", "whole_hypothalamus"), ("D4_lobules_I_VI", "cereb", "lobules_I_VI")]
KEEP = ["contrast", "measure", "n_grp1", "n_grp0", "grp0_mean", "pct", "pct_lo", "pct_hi", "d", "d_lo", "d_hi",
        "g", "g_lo", "g_hi", "t", "df", "p_param", "p_perm"]


def test(frame, col, gcol, contrast):
    f = frame[frame[col].notna()].reset_index(drop=True)
    y = np.log1p(f[col].astype(float).values)
    r = fit(f, y, gcol=gcol, cov=COV, log_outcome=True)
    _, pp, _ = fl_maxt(f, y[:, None], gcol=gcol, cov=COV, n_perm=5000)
    r.update(measure=col, contrast=contrast, p_perm=pp[0])
    return r


s = config.participants()
vals = s[["participant_id"]].copy()
rows = []
for vcol, mfile, col in MEASURES:
    m = pd.read_csv(WORK / f"measures_{mfile}.csv")[["participant_id", col]]
    d = s.merge(m, on="participant_id", how="inner")
    rows.append(test(d, col, "sci", "SCI vs CTRL"))
    sub = pd.concat([d[d.sci == 0], d[(d.sci == 1) & (d.cervical == 1)]]).assign(grp=lambda x: x.sci.astype(int))
    rows.append(test(sub, col, "grp", "cervical vs CTRL (descriptive)"))
    vals = vals.merge(m.assign(**{vcol: np.log1p(m[col].astype(float))})[["participant_id", vcol]],
                      on="participant_id", how="left")
out = pd.DataFrame(rows)[KEEP]
out.to_csv(OUT / "exploratory_sci_vs_ctrl.csv", index=False, float_format="%.6g")
vals.to_csv(WORK / "outcome_values.csv", index=False)
pd.set_option("display.width", 200)
print(out[["contrast", "measure", "n_grp1", "n_grp0", "d", "d_lo", "d_hi", "p_param", "p_perm"]].round(3).to_string(
    index=False))
