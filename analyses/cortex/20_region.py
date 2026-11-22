"""Regional FreeSurfer measures: SCI vs control models (exploratory).

Families: the 10 prespecified measures (bilateral mean thickness of seven DK regions; aseg thalamus and cerebellar
cortex, bilateral means; aseg brainstem), the 14 additional measures (bilateral gray matter volume and surface area
of the same seven regions), and the 238 regional morphometric measures (thickness, surface area, and gray matter
volume of the 68 DK regions and the 34 varying aseg volumes). Each measure is fitted on its own complete cases:
thickness ~ SCI + age + sex; area, volume, and aseg + eTIV (family_models). Adjusted d with a noncentral-t CI; BH,
Holm, and Freedman-Lane max-|t| FWE within the 10 and the 14, BH and max-T across the 238, and the permutation null
of the number of the 238 at P < 0.05. One permutation set for every measure (5,000, seed 20260923).
Outputs: <output_dir>/cortex/region_results.csv and region_family_summary.csv.
"""

import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

import cortex_common as cc

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from family_models import add_corrections, fit_family, master_perms, null_count  # noqa: E402

N_PERM = 5000
SEED = 20260923
df = cc.add_rois(cc.load_tables("subject"))
_, PRIM238, _ = cc.region_sets(df)
cols = cc.PRIM10 + cc.SEC14 + PRIM238
fams = {"apriori_primary10": cc.PRIM10, "apriori_secondary14": cc.SEC14}
perms = master_perms(SEED, N_PERM, len(df))
t0 = time.time()
r, T0 = fit_family(df, np.ones(len(df), bool), cols, "SCI_vs_CTRL", cc.region_covars, perms)
r = add_corrections(r, T0, fams, {"primary238": PRIM238})
nulls = null_count(T0, r, PRIM238)
g238 = r.set_index("measure").loc[PRIM238]
obs = int((g238.p < 0.05).sum())
fam_rows = []
for fam, fcols in list(fams.items()) + [("PRIMARY238", PRIM238)]:
    g = r.set_index("measure").loc[fcols]
    qcol, fcol = ("q_bh_primary238", "p_fwe_primary238") if fam == "PRIMARY238" else ("q_bh_family", "p_fwe_family")
    is238 = fam == "PRIMARY238"
    fam_rows.append({
        "family": fam, "m": len(fcols), "n_min": int(g.n_total.min()), "n_max": int(g.n_total.max()),
        "n_p_lt_05": int((g.p < 0.05).sum()), "min_q": g[qcol].min(), "n_q_lt_05": int((g[qcol] < 0.05).sum()),
        "min_fwe": g[fcol].min(), "n_fwe_lt_05": int((g[fcol] < 0.05).sum()), "top_measure": g.p.idxmin(),
        "top_d": g.loc[g.p.idxmin(), "d_adj"], "top_p": g.p.min(),
        "null_mean_count_238": nulls.mean() if is238 else np.nan,
        "null_95pct_count_238": np.percentile(nulls, 95) if is238 else np.nan,
        "perm_p_count_238": (1 + (nulls >= obs).sum()) / (1 + N_PERM) if is238 else np.nan,
    })
r["label"] = r.measure.map(cc.LABEL)
r.to_csv(cc.OUT / "region_results.csv", index=False)
fs = pd.DataFrame(fam_rows)
fs.to_csv(cc.OUT / "region_family_summary.csv", index=False)
pd.set_option("display.width", 220)
print(fs.round(3).to_string(index=False))
print(f"Total {time.time() - t0:.0f} s.")
