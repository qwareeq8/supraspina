"""Thalamic nucleus groups: SCI vs control models.

Sample: every participant except a montage rated Fail or a failed technical check (rule fixed before any group
result). Model per measure: volume ~ SCI + age + sex + eTIV (OLS, centered covariates), adjusted d = t sqrt(v_jj)
with a noncentral-t 95% CI. The six bilateral groups form one family: Benjamini-Hochberg q and Freedman-Lane
max-|t| family-wise P (5,000 permutations, seed 20260924). VPL (bilateral) is tested outside the family with the
same permutations. Refuses to run until every participant has a montage rating.

Writes <output_dir>/thalamus/family.csv, outside_family.csv, and qc_visual_summary.csv, and the participant-level
<work_dir>/thalamus/outcome_values.csv (bilateral volumes, elig_thalamus = 1 for participants in the models).
"""

import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd

import thalamus_common as tc

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import family_models as fm  # noqa: E402

NPERM = 5000
SEED = 20260924
COV = ["age", "female", "eTIV"]

subprocess.run([sys.executable, str(Path(__file__).with_name("build_table.py"))], check=True)
df = pd.read_csv(tc.TABLE)
smp = tc.config.participants()
assert set(df.participant_id) == set(smp.participant_id), "Participants without a nuclei row."
assert df.rating.isin(["Pass", "Doubtful", "Fail"]).all(), "Montage ratings are incomplete."
df = df.sort_values("participant_id").reset_index(drop=True)
keep = (df.rating != "Fail") & df.tech_ok.astype(bool)
max_file_diff = float(np.nanmax(np.r_[np.abs(df.whole_nuc_L - df.whole_file_L),
                                      np.abs(df.whole_nuc_R - df.whole_file_R)]))
print(f"Participants {len(df)}; in the models {int(keep.sum())}; montage Fail {int((df.rating == 'Fail').sum())}; "
      f"technical failures {int((~df.tech_ok.astype(bool)).sum())}; max |sum of nuclei - Whole_thalamus| "
      f"{max_file_diff:.4f} mm3.")

d = df[keep].reset_index(drop=True)
perms = fm.master_perms(SEED, NPERM, len(d))
inc = np.ones(len(d), bool)
pd.set_option("display.width", 220)
show = ["measure", "n_focal", "n_ref", "pct_of_ref_mean", "d_adj", "d_lo", "d_hi", "p"]
fam, T0 = fm.fit_family(d, inc, tc.FAMILY, "SCI_vs_CTRL", lambda c: COV, perms)
fam = fm.add_corrections(fam, T0, {"thalamic_groups": tc.FAMILY})
fam.round(5).to_csv(tc.OUT / "family.csv", index=False)
print(fam[show + ["q_bh_family", "p_fwe_family"]].round(3).to_string(index=False))
vpl, T1 = fm.fit_family(d, inc, ["VPL_bi"], "SCI_vs_CTRL", lambda c: COV, perms)
vpl["p_perm"] = (1 + (T1[:, 0] >= abs(vpl.t.iloc[0])).sum()) / (NPERM + 1)
vpl.round(5).to_csv(tc.OUT / "outside_family.csv", index=False)
print(vpl[show + ["p_perm"]].round(3).to_string(index=False))

qcs = df.assign(group=np.where(df.sci == 1, "SCI", "CTRL")).groupby(["group", "rating"]).size().rename("n")
qcs.reset_index().to_csv(tc.OUT / "qc_visual_summary.csv", index=False)
print(qcs.to_string())

ycols = tc.FAMILY + tc.OUTSIDE
ov = df[["participant_id"] + ycols].rename(columns={c: f"thal_{c}" for c in ycols})
ov["elig_thalamus"] = keep.astype(int).to_numpy()
ov.to_csv(tc.WORK / "outcome_values.csv", index=False)
