"""Whole-brain DBM regional estimates, SCI vs CTRL: medulla, pons, midbrain, and whole subfield brainstem.

Outcome: the unsmoothed mean total log-Jacobian over the template majority ROI (roi_values.csv). Model: y ~ SCI +
age + female + eTIV (liters), OLS; adjusted d with noncentral-t 95% CI, percent difference 100 (exp(beta) - 1), and
the parametric P (no multiplicity correction, as in Table 2). Participants with a failed registration are left out.
Writes roi_agreement.csv to the output folder.
"""

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
import dbmwb as wb  # noqa: E402
import stats_lib as sl  # noqa: E402

rv = pd.read_csv(wb.W / "roi_values.csv")
f = config.participants().merge(rv, on="participant_id")
f = f[~f.participant_id.isin(wb.exclusions())].reset_index(drop=True)
rows = []
for col in [c for c in rv.columns if c.endswith("_mlogj")]:
    res = sl.fit(f, f[col].values, "sci")
    rows.append(dict(roi=col[:-6], **{k: res[k] for k in ("n_grp1", "n_grp0", "beta", "t", "df", "p_param", "d",
                                                          "d_lo", "d_hi", "g", "pct", "pct_lo", "pct_hi")}))
ra = pd.DataFrame(rows)
ra.to_csv(config.output_dir("dbm_wholebrain") / "roi_agreement.csv", index=False)
print(ra[["roi", "n_grp1", "n_grp0", "pct", "d", "d_lo", "d_hi", "p_param"]].round(3).to_string(index=False))
