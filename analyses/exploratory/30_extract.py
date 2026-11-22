"""Hypothalamic subunit and CerebNet lobule volumes per participant.

measures_hypo.csv: whole_hypothalamus (left plus right Whole) and each subunit volume, from
stats/hypothalamic_subunits_volumes.v1.stats (the recon's, else the mirror SUBJECTS_DIR of 10_hypothalamus.sh).
measures_cereb.csv: hemispheric lobules (left plus right) and vermis parts from FastSurfer cerebellum.CerebNet.stats,
lobules_I_VI = hemispheric I-IV, V, and VI plus vermis VI, and the CerebNet gray matter total. A participant
without an output is left out (missing for that measure). Writes under <work_dir>/exploratory; prints counts only.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

FS = config.path("freesurfer.subjects_dir")
WORK = config.work_dir("exploratory")
FO = WORK / "fastsurfer"
LOBULES = ["I_IV", "V", "VI", "CrusI", "CrusII", "VIIb", "VIIIa", "VIIIb", "IX", "X"]
VERMIS = ["VI", "VII", "VIII", "IX", "X"]
subs = config.participants().participant_id.tolist()


def table(path, cols):
    rows = [ln.split() for ln in path.read_text().splitlines() if ln.strip() and not ln.startswith("#")]
    return {r[cols[0]]: float(r[cols[1]]) if r[cols[1]] not in ("-nan", "nan") else np.nan for r in rows}


def hypo():
    out = []
    for s in subs:
        p = FS / s / "stats/hypothalamic_subunits_volumes.v1.stats"
        if not p.exists():
            p = WORK / "hypo_sd" / s / "stats/hypothalamic_subunits_volumes.v1.stats"
        if not p.exists():
            continue
        v = table(p, (4, 3))
        v = {k.replace("Ssuperior", "Superior"): x for k, x in v.items()}  # Typo in a FreeSurfer 8.2 label name.
        r = dict(participant_id=s, whole_hypothalamus=v["Whole-Left"] + v["Whole-Right"])
        r.update({k: x for k, x in v.items() if not k.startswith("Whole")})
        out.append(r)
    return pd.DataFrame(out)


def cereb():
    out = []
    for s in subs:
        p = FO / s / "stats/cerebellum.CerebNet.stats"
        if not p.exists():
            continue
        v = table(p, (4, 3))
        r = dict(participant_id=s)
        for lb in LOBULES:
            r[f"hem_{lb}"] = v[f"Cbm_Left_{lb}"] + v[f"Cbm_Right_{lb}"]
        for lb in VERMIS:
            r[f"vermis_{lb}"] = v[f"Cbm_Vermis_{lb}"]
        r["lobules_I_VI"] = r["hem_I_IV"] + r["hem_V"] + r["hem_VI"] + r["vermis_VI"]
        r["cerebnet_gray_total"] = sum(r[f"hem_{lb}"] for lb in LOBULES) + sum(r[f"vermis_{lb}"] for lb in VERMIS)
        out.append(r)
    return pd.DataFrame(out)


for name, fn in (("hypo", hypo), ("cereb", cereb)):
    d = fn()
    d.to_csv(WORK / f"measures_{name}.csv", index=False)
    print(f"{name}: {len(d)} of {len(subs)} participants; missing cells {int(d.isna().sum().sum())}.")
