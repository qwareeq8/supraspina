"""Post hoc tectal reference for the DCN region.

The superior (visual) and inferior (auditory) colliculi share the brainstem DBM template and
registrations with the medulla but lie outside the dorsal column-medial lemniscal pathway, so DCN region
minus colliculus asks whether the DCN-region deficit exceeds a change across the whole template. Tests:
SC and IC alone, DCN minus SC, and DCN minus IC (mean total log-Jacobian, unsmoothed), each a single
Freedman-Lane test with 5,000 permutations; seeds are the tests' positions in the original sequence.
Writes tectal_control.csv (group level).
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
from stats_lib import fit, fl_maxt  # noqa: E402

SEED = 20261005
N_PERM = 5000
SEED_OFFSET = {"SC": 1, "IC": 2, "DCN_minus_SC": 5, "DCN_minus_IC": 6}


def main():
    C = config.work_dir("compartments")
    p = config.participants()
    roi = config.read_private(C / "roi_values.csv")[["participant_id", "R3_dcn_region_t50_mlogj"]]
    tec = config.read_private(C / "tectal_values.csv")
    df = p.merge(roi, on="participant_id", validate="one_to_one").merge(tec, on="participant_id", validate="one_to_one")
    assert len(df) == len(p), "roi_values.csv or tectal_values.csv lacks participants."
    assert float(np.abs(df.dcn_check - df.R3_dcn_region_t50_mlogj).max()) < 1e-6
    excl = set(config.ids(config.path("qc.dbm_registration_exclusions")))
    df = df[~df.participant_id.isin(excl)].reset_index(drop=True)
    df["DCN"] = df.R3_dcn_region_t50_mlogj
    for r in ("SC", "IC"):
        df[f"DCN_minus_{r}"] = df.DCN - df[r]
    out = []
    for col, off in SEED_OFFSET.items():
        _, p1, _ = fl_maxt(df, df[[col]].values, "sci", n_perm=N_PERM, seed=SEED + off)
        out.append(dict(measure=col, **fit(df, df[col].values, "sci"), p_perm=p1[0]))
    res = pd.DataFrame(out)
    res.to_csv(config.output_dir("compartments") / "tectal_control.csv", index=False)
    show = ["measure", "n_grp1", "n_grp0", "pct", "pct_lo", "pct_hi", "d", "d_lo", "d_hi", "p_perm"]
    print(res[show].round(4).to_string(index=False))


if __name__ == "__main__":
    main()
