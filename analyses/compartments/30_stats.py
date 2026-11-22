"""Group statistics for the medullary compartments, the JHU corticospinal tract, and the atlas-free
dorsal-minus-ventral contrast of the closed medulla (Table 2).

Model: y ~ group + age + female + eTIV (liters), OLS (stats_lib.fit); adjusted d with a noncentral-t
95% CI; percent difference = 100 (exp(beta) - 1). Freedman-Lane permutation, 5,000 permutations,
two-sided; max-|t| over the five compartments R1 to R5 for the family-wise P, at each partial-volume
threshold (0.5 is the reported one). Contrasts are within-participant differences of mean log-Jacobians,
each tested alone. Seeds follow the positions of these tests in the original test sequence. The
reported P values come from the converged permutation engine run on outcome_values.csv and
roi_values.csv. Participants in qc.dbm_registration_exclusions are left out (none in the paper).
Writes roi_main.csv (group level) and outcome_values.csv (participant level).
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
from stats_lib import fit, fl_maxt  # noqa: E402

SEED = 20260930
N_PERM = 5000
FAM = ["R1_pyramid", "R2_olive", "R3_dcn_region", "R4_tegmentum_rest", "R5_icp"]
SEED_OFFSET = {"family_t50": 0, "family_t75": 6, "JHU_CST": 12, "GEO_DV_caudal": 17}


def sample(values_file):
    p = config.participants()
    v = config.read_private(config.work_dir("compartments") / values_file)
    df = p.merge(v, on="participant_id", validate="one_to_one")
    assert len(df) == len(p), f"{values_file} lacks participants"
    excl = set(config.ids(config.path("qc.dbm_registration_exclusions")))
    return df[~df.participant_id.isin(excl)].reset_index(drop=True)


def main():
    df = sample("roi_values.csv")
    for c in [c for c in df.columns if c.endswith("_mlogj")]:
        df[c[: -len("_mlogj")]] = df[c]
    df["DV_planned_t50"] = df.R3_dcn_region_t50 - df.R1_pyramid_t50
    df["DVc_levelmatched_t50"] = df.R3_dcn_region_t50 - df.R1c_pyramid_caudal_t50
    df["GEO_DV_caudal"] = df.GEO_dorsal_caudal - df.GEO_ventral_caudal
    rows = []
    for t in ("t50", "t75"):
        Y = np.column_stack([df[f"{r}_{t}"].values for r in FAM])
        _, p1, pf = fl_maxt(df, Y, "sci", n_perm=N_PERM, seed=SEED + SEED_OFFSET[f"family_{t}"])
        rows += [dict(threshold=t, set="family R1-R5", measure=r, **fit(df, Y[:, j], "sci"), p_perm=p1[j], p_fwe=pf[j])
                 for j, r in enumerate(FAM)]
    for col, label, t in (("JHU_CST", "JHU corticospinal tract", "t50"),
                          ("GEO_DV_caudal", "atlas-free dorsal minus ventral, closed medulla", "")):
        _, p1, _ = fl_maxt(df, df[[col]].values, "sci", n_perm=N_PERM, seed=SEED + SEED_OFFSET[col])
        rows.append(dict(threshold=t, set=label, measure=col, **fit(df, df[col].values, "sci"),
                         p_perm=p1[0], p_fwe=np.nan))
    out = pd.DataFrame(rows)
    out.to_csv(config.output_dir("compartments") / "roi_main.csv", index=False)
    oc = [f"{r}_t50" for r in FAM] + ["DVc_levelmatched_t50", "DV_planned_t50", "JHU_CST"]
    df[["participant_id"] + oc].to_csv(config.work_dir("compartments") / "outcome_values.csv", index=False)
    print(f"n = {len(df)} ({int(df.sci.sum())} SCI).")
    show = ["threshold", "measure", "n_grp1", "n_grp0", "pct", "pct_lo", "pct_hi", "d", "d_lo", "d_hi", "p_perm",
            "p_fwe"]
    with pd.option_context("display.width", 200):
        print(out[show].round(4).to_string(index=False))


if __name__ == "__main__":
    main()
