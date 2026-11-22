"""Euler number of the cortical surfaces by group (quality control, Methods).

Euler number per hemisphere = 2 - 2 x SurfaceHoles (aseg.stats header, before topology correction); per participant
the mean of the two hemispheres. Reports the median and interquartile range per group and the two-sided
Mann-Whitney P, SCI vs controls, in the analyzed sample. Output: <output_dir>/cortex/euler_by_group.csv.
"""

import pandas as pd
from scipy import stats

import cortex_common as cc
from cortex_common import config

s = config.participants()
eu = []
for pid in s.participant_id:
    meas, _ = cc.read_aseg(cc.FS / pid / "stats/aseg.stats")
    eu.append(((2 - 2 * meas["lhSurfaceHoles"]) + (2 - 2 * meas["rhSurfaceHoles"])) / 2)
s["euler_mean"] = eu
sci, ctrl = s.loc[s.sci == 1, "euler_mean"], s.loc[s.sci == 0, "euler_mean"]
rows = [dict(group=g, n=len(x), median=x.median(), q25=x.quantile(0.25), q75=x.quantile(0.75))
        for g, x in (("SCI", sci), ("CTRL", ctrl))]
out = pd.DataFrame(rows)
out["mann_whitney_p"] = stats.mannwhitneyu(sci, ctrl).pvalue
out.to_csv(cc.OUT / "euler_by_group.csv", index=False)
print(out.round(3).to_string(index=False))
