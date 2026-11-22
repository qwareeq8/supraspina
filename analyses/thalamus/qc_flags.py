"""Automated flags for a second visual look at the thalamic montages, keyed by code (group-blind).

(a) Nuclei whole thalamus over aseg thalamus, per hemisphere, outside the 3-IQR Tukey fences; (b) residual
|z| > 3.5 for the six bilateral groups, VPL, and the nuclei whole thalamus after age, sex, and eTIV, pooled over
all participants with no group term; (c) a failed technical check. Reads nuclei_table.csv; writes qc/qc_flags.tsv
(code, flags). Prints counts only.
"""

import numpy as np
import pandas as pd

import thalamus_common as tc

d = pd.read_csv(tc.TABLE)
assert d.code.notna().all(), "Montage codes are missing; run montage.py and build_table.py first."
flags = {c: [] for c in d.code}
for h, H in (("L", "Left"), ("R", "Right")):
    ratio = d[f"whole_nuc_{h}"] / d[f"aseg_{H}-Thalamus"]
    q1, q3 = ratio.quantile([0.25, 0.75])
    lo, hi = q1 - 3 * (q3 - q1), q3 + 3 * (q3 - q1)
    for cde, rr in zip(d.code, ratio):
        if rr < lo or rr > hi:
            flags[cde].append(f"ratio_{h}={rr:.3f} (fences {lo:.3f}-{hi:.3f})")
Z = np.column_stack([np.ones(len(d)), d.age, d.female, d.eTIV / 1e5])
for col in tc.FAMILY + ["VPL_bi", "whole_nuc_bi"]:
    y = d[col].to_numpy(float)
    b = np.linalg.lstsq(Z, y, rcond=None)[0]
    res = y - Z @ b
    z = res / np.sqrt(res @ res / (len(y) - Z.shape[1]))
    for cde, zz in zip(d.code, z):
        if abs(zz) > 3.5:
            flags[cde].append(f"{col} z={zz:+.2f}")
for cde, ok in zip(d.code, d.tech_ok):
    if not ok:
        flags[cde].append("technical check failed")
out = pd.DataFrame({"code": list(flags), "flags": ["; ".join(v) for v in flags.values()]}).sort_values("code")
out.to_csv(tc.QC / "qc_flags.tsv", sep="\t", index=False)
ratio_all = pd.concat([d.whole_nuc_L / d["aseg_Left-Thalamus"], d.whole_nuc_R / d["aseg_Right-Thalamus"]])
print(f"Participants {len(d)}; technical failures {int((~d.tech_ok.astype(bool)).sum())}; flagged codes "
      f"{int((out['flags'] != '').sum())}; nuclei/aseg ratio median {ratio_all.median():.3f}.")
