"""Counts of the registration screen, the selection, and the review (group level only).

<output_dir>/cortex/screen_summary.csv: per registration tag, the hemispheres of the analyzed sample scored, passing,
failing each criterion, and inverted (precentral thinner than postcentral), with fit and relabelling summaries.
<output_dir>/cortex/registration_by_group.csv: hemispheres by selected and final registration, hemisphere, and
group, with participant counts.
"""

import pandas as pd

import cortex_common as cc
from cortex_common import config

samp = config.participants().set_index("participant_id")
rows = []
for tag in ("b40infl", "b40"):
    p = cc.WORK / f"screen_{tag}.tsv"
    if not p.exists():
        continue
    g = pd.read_csv(p, sep="\t")
    g = g[g.participant_id.isin(samp.index)]
    rows.append({"registration": tag, "hemispheres": len(g), "pass": int(g["pass"].sum()),
                 "fail": int((~g["pass"]).sum()), "fail_A1_fit": int((~g.A1_fit).sum()),
                 "fail_A2_geometry": int((~g.A2_geometry).sum()), "fail_C_regional": int((~g.C_regional).sum()),
                 "inverted_pre_lt_post": int(g.inverted.sum()), "r_dfp_median": g.r_fsavg_dfp.median(),
                 "r_dfp_min": g.r_fsavg_dfp.min(), "pre_minus_post_median_mm": g.pre_minus_post_thick.median(),
                 "pre_minus_post_min_mm": g.pre_minus_post_thick.min(),
                 "max_regions_z_lt_4": int(g.n_regions_z_lt_4.max()),
                 "relabelled_frac_median": g.frac_cortex_relabelled.median()})
S = pd.DataFrame(rows)
S.to_csv(cc.OUT / "screen_summary.csv", index=False, float_format="%.4f")

reg = pd.read_csv(cc.WORK / "registration.tsv", sep="\t", keep_default_na=False)
reg["group"] = reg.participant_id.map(samp.sci).map({1: "SCI", 0: "CTRL"})
out = []
for col in ("selected", "final"):
    a = reg.groupby([col, "hemi", "group"]).size().rename("hemispheres").reset_index()
    b = reg.groupby([col, "group"]).agg(hemispheres=("hemi", "size"), participants=("participant_id", "nunique"))
    b = b.reset_index().assign(hemi="both")
    c = pd.concat([a, b], ignore_index=True).rename(columns={col: "registration"})
    c.insert(0, "stage", col)
    out.append(c)
d = reg[reg.decision != ""].groupby(["decision", "final", "group"]).size().rename("hemispheres").reset_index()
out.append(d.rename(columns={"final": "registration"}).assign(stage="review", hemi="both"))
O = pd.concat(out, ignore_index=True)
O.to_csv(cc.OUT / "registration_by_group.csv", index=False)
print(S.round(3).to_string(index=False))
print(O[O.hemi == "both"].to_string(index=False))
