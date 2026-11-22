"""Group statistics for the three brainstem DBM regions (medulla, pons, midbrain; Table 2).

Model: mean total log-Jacobian ~ group + age + female + eTIV (liters), OLS (stats_lib.fit). Adjusted d
with a noncentral-t 95% CI; percent difference = 100 (exp(beta) - 1). Freedman-Lane permutation, 5,000
permutations, two-sided, with max-|t| over the three regions for the family-wise P. The reported P values
come from the converged permutation engine run on outcome_values.csv. Participants listed in
qc.dbm_registration_exclusions are left out (none in the paper).
Writes roi_primary.csv (group level) and outcome_values.csv (participant level).
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
from stats_lib import fit, fl_maxt  # noqa: E402

FAM = ("medulla", "pons", "midbrain")
SEED = 20260924
N_PERM = 5000


def main():
    W = config.work_dir("dbm_brainstem")
    p = config.participants()
    roi = config.read_private(W / "roi_values.csv")
    df = p.merge(roi, on="participant_id", validate="one_to_one")
    assert len(df) == len(p), "roi_values.csv lacks participants."
    excl = set(config.ids(config.path("qc.dbm_registration_exclusions")))
    base = df[~df.participant_id.isin(excl)].reset_index(drop=True)
    Y = np.column_stack([base[f"{r}_mlogj"].values for r in FAM])
    _, p_single, p_fwe = fl_maxt(base, Y, "sci", n_perm=N_PERM, seed=SEED)
    rows = [dict(roi=r, outcome="mlogj", **fit(base, Y[:, j], "sci"), p_perm=p_single[j], p_fwe_family=p_fwe[j])
            for j, r in enumerate(FAM)]
    out = pd.DataFrame(rows)
    out.to_csv(config.output_dir("dbm_brainstem") / "roi_primary.csv", index=False)
    base[["participant_id"] + [f"{r}_mlogj" for r in FAM]].to_csv(W / "outcome_values.csv", index=False)
    print(f"n = {len(base)} ({int(base.sci.sum())} SCI); registration exclusions: {len(excl)}.")
    cols = ["roi", "n_grp1", "n_grp0", "pct", "pct_lo", "pct_hi", "d", "d_lo", "d_hi", "p_param", "p_perm",
            "p_fwe_family"]
    print(out[cols].round(4).to_string(index=False))


if __name__ == "__main__":
    main()
