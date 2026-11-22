"""Per-participant thalamic nucleus table.

Reads ThalamicNuclei.volumes.txt of every participant and sums the nuclei into the six groups per hemisphere and
bilaterally (left plus right), with VPL and the nuclei whole thalamus. aseg thalamus comes from the recon's
aseg.stats (bilateral mean). A segmentation passes the technical check when it lists all 52 labels (the 25 nuclei
and Whole_thalamus per hemisphere) and every volume is positive. The montage code (qc/qc_key.tsv) and the visual
rating (qc.thalamus_ratings; Pass, Doubtful, or Fail, keyed by participant_id or by code) are merged when present.
Output: <work_dir>/thalamus/nuclei_table.csv. Prints counts only.
"""

import pandas as pd

import thalamus_common as tc
from thalamus_common import config

FS = config.path("freesurfer.subjects_dir")


def read_volumes(f):
    return {k: float(x) for k, x in (line.split() for line in f.read_text().splitlines() if line.strip())}


def aseg_thalamus(pid):
    v = {}
    for line in (FS / pid / "stats/aseg.stats").read_text().splitlines():
        if line.startswith("#") or not line.strip():
            continue
        p = line.split()
        v[p[4]] = float(p[3])
    return v["Left-Thalamus"], v["Right-Thalamus"]


s = config.participants()
rows, missing = [], 0
for pid in s.participant_id:
    f = tc.SEG / pid / "ThalamicNuclei.volumes.txt"
    if not f.exists():
        missing += 1
        continue
    v = read_volumes(f)
    ok = len(v) == 52 and all(f"{h}-{n}" in v for h in ("Left", "Right") for n in tc.NUCLEI) \
        and all(x > 0 for x in v.values())
    r = {"participant_id": pid, "tech_ok": ok}
    r["aseg_Left-Thalamus"], r["aseg_Right-Thalamus"] = aseg_thalamus(pid)
    for h, H in (("L", "Left"), ("R", "Right")):
        for g, ns in tc.GROUPS.items():
            r[f"{g}_{h}"] = sum(v.get(f"{H}-{n}", float("nan")) for n in ns)
        r[f"VPL_{h}"] = v.get(f"{H}-VPL", float("nan"))
        r[f"whole_nuc_{h}"] = sum(v.get(f"{H}-{n}", float("nan")) for n in tc.NUCLEI)
        r[f"whole_file_{h}"] = v.get(f"{H}-Whole_thalamus", float("nan"))
    rows.append(r)
d = pd.DataFrame(rows)
d["aseg_thal_mean"] = (d["aseg_Left-Thalamus"] + d["aseg_Right-Thalamus"]) / 2
for g in tc.GROUPS:
    d[f"{g}_bi"] = d[f"{g}_L"] + d[f"{g}_R"]
d["VPL_bi"] = d.VPL_L + d.VPL_R
d["whole_nuc_bi"] = d.whole_nuc_L + d.whole_nuc_R
d["ventral_bilat"] = d.Ventral_bi
d = s[["participant_id", "sci", "age", "female", "eTIV"]].merge(d, on="participant_id")

if tc.KEY.exists():
    d = d.merge(pd.read_csv(tc.KEY, sep="\t"), on="participant_id", how="left")
rat_f = config.path("qc.thalamus_ratings")
if rat_f.exists():
    rat = config.read_private(rat_f, sep="\t")
    on = "participant_id" if "participant_id" in rat.columns else "code"
    d = d.merge(rat[[on, "rating"]], on=on, how="left")
else:
    d["rating"] = pd.NA
d = d.sort_values("participant_id").reset_index(drop=True)
d.to_csv(tc.TABLE, index=False)
print(f"Rows {len(d)} of {len(s)}; without outputs {missing}; technical failures {int((~d.tech_ok).sum())}; "
      f"ratings present {int(d.rating.notna().sum())}.")
