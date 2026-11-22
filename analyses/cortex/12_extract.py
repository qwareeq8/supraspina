"""Per-participant DK, aseg, and Brainnetome tables of the analyzed sample.

Final registration per hemisphere: the screen's selection (selection.tsv), then the group-blind review
(qc.cortical_adjudication): "keep" takes the registration the rater judged correct (b40infl, b40, or default, the
recon's own sphere.reg), "out" leaves the hemisphere without a correct registration, and "exclude_bn" keeps the
selection but sets the named Brainnetome parcels (bn_regions, ";"-separated parcel keys) missing. A hemisphere
that stays unresolved is missing in every DK and Brainnetome column. DK cells named in qc.region_exclusions are set
missing. DK values come from stats/<h>.aparc.<tag>.stats (default: the recon's stats/<h>.aparc.stats), Brainnetome
values from stats/<h>.BN_Atlas.<tag>.stats, aseg volumes from the recon's aseg.stats (Volume_mm3), and age, sex,
group, and eTIV from the participants table (eTIV checked against aseg.stats).
Outputs (<work_dir>/cortex): registration.tsv, subject_table_P.csv, bn_table_P.csv. Prints counts only.
"""

import numpy as np
import pandas as pd

import cortex_common as cc
from cortex_common import config

samp = config.participants().set_index("participant_id")
sel = pd.read_csv(cc.WORK / "selection.tsv", sep="\t")
sel = sel[sel.participant_id.isin(samp.index)]
assert len(sel) == 2 * len(samp) and sel.selected.notna().all(), "Hemispheres still waiting for the b40 fallback."
final = {(r.participant_id, r.hemi): r.selected for r in sel.itertuples()}
decision = {}
for a in cc.adjudication().itertuples():
    k = (a.participant_id, a.hemi)
    assert k in final, "An adjudicated hemisphere is not in the sample."
    decision[k] = a.decision
    reg = a.registration if isinstance(a.registration, str) and a.registration else final[k]
    if a.decision == "keep":
        assert reg in cc.TAGS, f"Unknown registration {reg!r} in the adjudication."
        final[k] = reg
    elif a.decision == "out":
        final[k] = "unresolved"
    else:
        assert final[k] != "unresolved", "A hemisphere without a registration has exclude_bn."
reg_t = sel[["participant_id", "hemi", "selected"]].copy()
reg_t["decision"] = [decision.get(k, "") for k in zip(reg_t.participant_id, reg_t.hemi)]
reg_t["final"] = [final[k] for k in zip(reg_t.participant_id, reg_t.hemi)]
reg_t.to_csv(cc.WORK / "registration.tsv", sep="\t", index=False)


def dk_stats(s, h, tag):
    return cc.read_stats(cc.FS / s / "stats" / f"{h}.aparc.stats" if tag == "default"
                         else cc.SD / s / "stats" / f"{h}.aparc.{tag}.stats")


rrows, brows = [], []
for s in samp.index:
    meas, aseg = cc.read_aseg(cc.FS / s / "stats/aseg.stats")
    assert abs(meas["eTIV"] - samp.loc[s, "eTIV"]) < 1, "eTIV differs between aseg.stats and the participants table."
    base = {"participant_id": s, **{c: samp.loc[s, c] for c in ("sci", "age", "female", "eTIV")}}
    rr, bb = {**base, **aseg}, dict(base)
    for h in ("lh", "rh"):
        tag = final[(s, h)]
        miss = tag == "unresolved"
        st = None if miss else dk_stats(s, h, tag)
        b = None if miss else cc.read_stats(cc.SD / s / "stats" / f"{h}.BN_Atlas.{tag}.stats")
        for r in cc.DK_REGIONS:
            for m in cc.METRICS:
                rr[f"{h}_{r}_{m}"] = np.nan if miss or r not in st.index else st.loc[r, m]
        suf = "L" if h == "lh" else "R"
        for key, trunc in cc.BN_ROIS.items():
            nm = f"{trunc}_{suf}"
            for m in cc.BN_MEASURES:
                bb[f"gcs_{h}_{key}_{m}"] = np.nan if miss or nm not in b.index else b.loc[nm, m]
    rrows.append(rr)
    brows.append(bb)
R = pd.DataFrame(rrows)
B = pd.DataFrame(brows)

for a in cc.adjudication().itertuples():
    if a.decision == "exclude_bn":
        cols = [c for c in B.columns for r in str(a.bn_regions).split(";") if c.startswith(f"gcs_{a.hemi}_{r}_")]
        B.loc[B.participant_id == a.participant_id, cols] = np.nan
n_ex = 0
for s, hr in cc.region_exclusions():
    hit = R.participant_id == s
    n_ex += int(hit.sum())
    R.loc[hit, [f"{hr}_{m}" for m in cc.METRICS if f"{hr}_{m}" in R.columns]] = np.nan

R.to_csv(cc.WORK / "subject_table_P.csv", index=False)
B.to_csv(cc.WORK / "bn_table_P.csv", index=False)
dk_cols = [c for c in R.columns if c.startswith(("lh_", "rh_"))]
bn_cols = [c for c in B.columns if c.startswith("gcs_")]
print(f"Rows {len(R)}; hemispheres by final registration {reg_t.final.value_counts().to_dict()}; review decisions "
      f"{pd.Series(list(decision.values())).value_counts().to_dict()}; DK cells excluded at review {n_ex}; missing "
      f"cells DK {cc.missing_cells(R, dk_cols)}, Brainnetome {cc.missing_cells(B, bn_cols)}.")
