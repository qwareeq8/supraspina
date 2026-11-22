"""Write the arrays behind the group statistics row of Figure 1 (panels I, J and L).

J rebuilds the max-|t| Freedman-Lane null of the five medullary compartments (t50 masks) with the
compartment analysis's seed and permutation count, and checks that it reproduces that analysis's
family-wise P values. L is the DCN-region mean log-Jacobian adjusted for age, sex and eTIV (fit in all
participants), as percent difference from the control mean, by injury level. I is the brainstem DBM
design matrix that randomise used (columns SCI, CTRL, age, sex, eTIV). The output holds
participant-level values and stays private: config.work_dir("figures")/stats_panels.npz.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
from stats_lib import COV, design  # noqa: E402

# Per-participant compartment values (mean log-Jacobian, <compartment>_t50_mlogj) of the compartments section.
ROI_VALUES = config.work_dir("compartments") / "roi_values.csv"
# Family-wise P values of the compartment family, for the reproduction check (group level).
ROI_TABLE = config.output_dir("compartments") / "roi_main.csv"
# Design matrix of the brainstem DBM group model (dbm_brainstem/25_design.py; randomise reads its vest copy).
BS_DESIGN = config.work_dir("dbm_brainstem") / "stats/SCI_vs_CTRL/design.txt"
OUT = config.work_dir("figures") / "stats_panels.npz"

FAM = ["R1_pyramid", "R2_olive", "R3_dcn_region", "R4_tegmentum_rest", "R5_icp"]
SEED, NPERM = 20260930, 5000  # As the compartment analysis.

part = config.participants()
vals = config.read_private(ROI_VALUES)
df = part.merge(vals, on="participant_id", validate="one_to_one")
assert len(df) == len(part), "Every analyzed participant needs compartment values."
# The compartment analysis leaves out failed registrations (none in the paper).
excl = set(config.ids(config.path("qc.dbm_registration_exclusions")))
df = df[~df.participant_id.isin(excl)].reset_index(drop=True)

# J: max-|t| null of the family (the permutations of stats_lib.fl_maxt with this seed).
Y = np.column_stack([df[f"{r}_t50_mlogj"].to_numpy(float) for r in FAM])
gv, Z, X = design(df, "sci", COV)
XtX = np.linalg.inv(X.T @ X)
dfree = len(gv) - X.shape[1]


def tstat(Yp):
    B = XtX @ X.T @ Yp
    Rr = Yp - X @ B
    return B[1] / np.sqrt((Rr * Rr).sum(0) / dfree * XtX[1, 1])


t_obs = tstat(Y)
fitted = Z @ np.linalg.pinv(Z) @ Y
resid = Y - fitted
rng = np.random.default_rng(SEED)
null = np.array([np.abs(tstat(fitted + resid[rng.permutation(len(gv))])).max() for _ in range(NPERM)])
p_fwe = ((null[:, None] >= np.abs(t_obs)).sum(0) + 1) / (NPERM + 1)
tab = pd.read_csv(ROI_TABLE)
pub = tab[(tab.threshold == "t50") & (tab.set == "family R1-R5")]
pub = pub.set_index("measure").loc[FAM, "p_fwe"].to_numpy()
assert np.allclose(p_fwe, pub), (p_fwe, pub)

# L: DCN-region mean log-Jacobian adjusted for age, sex and eTIV (fit in all), as % of the CTRL mean.
y = df["R3_dcn_region_t50_mlogj"].to_numpy(float)
C = np.column_stack([np.ones(len(df))] + [df[c].astype(float) for c in ("age", "female", "eTIV_l")])
r = y - C @ np.linalg.lstsq(C, y, rcond=None)[0]
pct = 100 * np.expm1(r - r[gv == 0].mean())
cerv = df["cervical"].astype(float)
assert cerv[gv == 1].notna().all(), "Every SCI participant needs an injury level."
level = np.where(gv == 0, 0, np.where(cerv == 1, 2, 1))  # CTRL, thoracic or lumbar, cervical.

# I: the brainstem DBM design used by randomise.
Xd = np.loadtxt(BS_DESIGN, ndmin=2)

thr = np.quantile(null, 0.95)
np.savez_compressed(OUT, null=null, t_dcn=abs(t_obs[FAM.index("R3_dcn_region")]), thr=thr, dcn_pct=pct,
                    dcn_level=level, design=Xd)
print("Wrote", OUT, "| FWE P reproduced:", np.round(p_fwe, 4), "| 5% threshold", round(float(thr), 2),
      "| level counts (CTRL, T/L, C)", [int((level == k).sum()) for k in (0, 1, 2)], "| design", Xd.shape)
