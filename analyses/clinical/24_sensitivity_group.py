"""DCN region, SCI vs controls, in the sensitivity sample (Table 2).

Same model as the primary comparison (y ~ group + age + female + eTIV): adjusted d with a noncentral-t CI,
percentage difference 100 (exp(beta) - 1), and a single Freedman-Lane permutation P from 10,000,000
permutations of the converged engine. Writes <output_dir>/clinical/sensitivity_group.csv.
"""

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import clinical_lib as C  # noqa: E402
import config  # noqa: E402
import permutation  # noqa: E402
import stats_lib  # noqa: E402

N_PERM, SEED = 10_000_000, 20261110


def main():
    f = C.sensitivity_sample(C.load(["dcn"])).dropna(subset=["dcn", *C.COV]).reset_index(drop=True)
    r = stats_lib.fit(f, f.dcn.values.astype(float), "sci", cov=tuple(C.COV), log_outcome=True)
    perm = permutation.run_family([permutation.Col("dcn", f.dcn.values.astype(float), f, C.COV)], len(f), N_PERM, SEED)
    out = pd.DataFrame([dict(outcome="dcn", sample="sensitivity", **r, p_perm=perm.p_single[0],
                             se_perm=perm.se_single[0], n_perm=int(perm.N[0]))])
    out.to_csv(config.output_dir(C.SECTION) / "sensitivity_group.csv", index=False)
    print(out.round(4).T.to_string(header=False))


if __name__ == "__main__":
    main()
