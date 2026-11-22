"""S1 areas per participant for the covariation analysis.

<work_dir>/cortex/s1_trunk.csv: participant_id, s1_trunk_area and s1_ulhf_area (bilateral mean SurfArea, mm2, of
the Brainnetome A1/2/3tru and A1/2/3ulhf parcels; missing when either hemisphere has no correct registration), and
n_unresolved_hemis. No other exclusion is applied here; the covariation models apply their own.
"""

import pandas as pd

import cortex_common as cc

bn = cc.load_tables("bn").set_index("participant_id")
reg = pd.read_csv(cc.WORK / "registration.tsv", sep="\t", keep_default_na=False)
unres = reg[reg.final == "unresolved"].groupby("participant_id").size()
o = pd.DataFrame({"participant_id": bn.index})
for key, roi in (("s1_trunk_area", "S1_trunk"), ("s1_ulhf_area", "S1_upperlimb_headface")):
    o[key] = ((bn[f"gcs_lh_{roi}_SurfArea"] + bn[f"gcs_rh_{roi}_SurfArea"]) / 2).to_numpy()
o["n_unresolved_hemis"] = o.participant_id.map(unres).fillna(0).astype(int)
assert (o.s1_trunk_area.isna() == (o.n_unresolved_hemis > 0)).all()
o.to_csv(cc.WORK / "s1_trunk.csv", index=False)
print(f"Rows {len(o)}; missing S1 trunk area (a hemisphere without a correct registration) "
      f"{int(o.s1_trunk_area.isna().sum())}.")
