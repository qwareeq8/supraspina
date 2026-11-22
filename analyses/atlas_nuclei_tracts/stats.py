"""Group tests of the atlas nuclei and tracts (Fig. 3), with 5,000-permutation P values as a check.

Fig. 3 prints the converged P values of permutations/brainstem_families.py (nav, trc, fine_single).

y ~ SCI + age + female + eTIV (liters) on mean total log-Jacobians; adjusted d with a noncentral-t 95% CI
and percent difference 100 (exp(beta) - 1) (stats_lib). Max-T P within the seven nuclei and within the 11
tract parts, a single test for the DCN region minus the dorsal vagal complex, and the inferior medullary
reticular formation outside the DCN region as a descriptive estimate. Writes
<output_dir>/atlas_nuclei_tracts/tests_fine.csv.
"""

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
from stats_lib import COV, fit, fl_maxt  # noqa: E402

N_PERM = 5000
NUCLEI = ["NAV_VSM", "NAV_Ve", "NAV_iMRt", "NAV_ION", "NAV_RN", "NAV_raphe_med", "NAV_sMRt"]
CONTRAST = "DCN_region-NAV_VSM"
DESCRIPTIVE = ["iMRt_outside_DCN"]
# Seeds of the nuclei family, the tract family, and the contrast.
SEEDS = {"nuclei": 20261013, "tracts": 20261014, "contrast": 20261016}


def main():
    v = config.read_private(config.work_dir("atlas_nuclei_tracts") / "values_fine.csv")
    d = config.participants().merge(v, on="participant_id", how="inner", validate="one_to_one")
    tracts = [c for c in v.columns if c.startswith("TR_")]
    assert len(d) == len(config.participants()) and d[NUCLEI + tracts + [CONTRAST]].notna().all().all()
    out = []
    for fam, cols, seed in (("nuclei", NUCLEI, SEEDS["nuclei"]), ("tract parts", tracts, SEEDS["tracts"])):
        _, p1, pf = fl_maxt(d, d[cols].to_numpy(), "sci", cov=COV, n_perm=N_PERM, seed=seed)
        for j, y in enumerate(cols):
            out.append(dict(family=f"{fam} (max-T over {len(cols)})", y=y, **fit(d, d[y].to_numpy(), "sci", cov=COV),
                            p_perm=p1[j], p_fwe=pf[j]))
    _, p1, _ = fl_maxt(d, d[[CONTRAST]].to_numpy(), "sci", cov=COV, n_perm=N_PERM, seed=SEEDS["contrast"])
    out.append(dict(family="single", y=CONTRAST, **fit(d, d[CONTRAST].to_numpy(), "sci", cov=COV), p_perm=p1[0]))
    for y in DESCRIPTIVE:
        out.append(dict(family="descriptive", y=y, **fit(d, d[y].to_numpy(), "sci", cov=COV)))
    t = pd.DataFrame(out)
    t.to_csv(config.output_dir("atlas_nuclei_tracts") / "tests_fine.csv", index=False)
    cols = ["family", "y", "n", "pct", "pct_lo", "pct_hi", "d", "d_lo", "d_hi", "p_param", "p_perm", "p_fwe"]
    with pd.option_context("display.width", 230, "display.max_columns", 20, "display.max_rows", 100):
        print(t[cols].round(4).to_string(index=False))


if __name__ == "__main__":
    main()
