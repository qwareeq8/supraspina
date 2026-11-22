"""Reported cortical and regional rows, and the participant-level values of those measures.

<output_dir>/cortex/summary.csv: one row per reported measure (the 10 prespecified measures, S1 trunk area, S1
upper limb with head and face area, M1 and S1 lower-limb thickness, and DK postcentral area) with n, covariates,
adjusted d and CI, percentage of the control mean, parametric P, and the 5,000-permutation family-wise P of its
family. <work_dir>/cortex/outcome_values.csv: those measures (plus S1 trunk gray matter volume and right DK
postcentral area) per participant, after the review exclusions.
"""

import pandas as pd

import cortex_common as cc

reg = pd.read_csv(cc.OUT / "region_results.csv").set_index("measure")
som = pd.read_csv(cc.OUT / "somatotopic_results.csv").set_index("measure")

SPEC = [(cc.LABEL[c], c, "region", "max-T over the 10 prespecified measures") for c in cc.PRIM10]
SPEC += [
    ("S1 trunk area", "area_S1_trunk", "soma", "max-T over the 18 M1 and S1 areas and volumes"),
    ("S1 upper limb, head and face area", "area_S1_upperlimb_headface", "soma",
     "max-T over the 18 M1 and S1 areas and volumes"),
    ("M1 lower-limb thickness", "th_M1_lowerlimb", "soma", "max-T over the two lower-limb thickness measures"),
    ("S1 lower-limb thickness", "th_S1_lowerlimb", "soma", "max-T over the two lower-limb thickness measures"),
    ("Postcentral area, DK", "roi2_postcentral_SurfArea", "region", "max-T over the 14 additional measures"),
]
rows = []
for label, col, src, kind in SPEC:
    r = (reg if src == "region" else som).loc[col]
    rows.append(dict(outcome=label, measure=col, n_sci=int(r.n_focal), n_ctrl=int(r.n_ref), covariates=r.covariates,
                     beta=r.beta, d=r.d_adj, d_lo=r.d_lo, d_hi=r.d_hi, pct=r.pct_of_ref_mean, p=r.p,
                     p_fwe=r.p_fwe_family, p_fwe_kind=kind))
out = pd.DataFrame(rows)
out.to_csv(cc.OUT / "summary.csv", index=False)
pd.set_option("display.width", 200)
print(out[["outcome", "n_sci", "n_ctrl", "d", "d_lo", "d_hi", "pct", "p", "p_fwe"]].round(3).to_string(index=False))

cols_r = sorted({c for _, c, s, _ in SPEC if s == "region"} | {"rh_postcentral_SurfArea"})
cols_s = sorted({c for _, c, s, _ in SPEC if s == "soma"} | {"vol_S1_trunk"})
a = cc.add_rois(cc.load_tables("subject"))[["participant_id"] + cols_r]
b = cc.soma_frame(cc.load_tables("bn"))[["participant_id"] + cols_s]
v = a.merge(b, on="participant_id")
assert len(v) == len(a)
v.to_csv(cc.WORK / "outcome_values.csv", index=False)
print(f"Outcome values: rows {len(v)}, columns {len(v.columns) - 1}.")
