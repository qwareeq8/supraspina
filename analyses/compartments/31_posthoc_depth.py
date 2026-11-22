"""Post hoc depth check: outer 2 mm rim minus core of the closed medulla.

rim_minus_core = mean of the dorsal and ventral rim log-Jacobians minus the mean of the dorsal and
ventral core log-Jacobians (depth_values.csv). A positive group effect means a smaller deficit in the
rim than in the core. Same model and Freedman-Lane scheme as 30_stats.py (5,000 permutations; the seed
is this test's position in the original sequence). Writes posthoc_depth.csv (group level).
"""

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
from stats_lib import fit, fl_maxt  # noqa: E402

SEED = 31007
N_PERM = 5000


def main():
    p = config.participants()
    v = config.read_private(config.work_dir("compartments") / "depth_values.csv")
    df = p.merge(v, on="participant_id", validate="one_to_one")
    assert len(df) == len(p), "depth_values.csv lacks participants."
    excl = set(config.ids(config.path("qc.dbm_registration_exclusions")))
    df = df[~df.participant_id.isin(excl)].reset_index(drop=True)
    df["rim_minus_core"] = (df.rim_dorsal + df.rim_ventral) / 2 - (df.core_dorsal + df.core_ventral) / 2
    _, p1, _ = fl_maxt(df, df[["rim_minus_core"]].values, "sci", n_perm=N_PERM, seed=SEED)
    out = pd.DataFrame([dict(measure="rim_minus_core", **fit(df, df.rim_minus_core.values, "sci"), p_perm=p1[0])])
    out.to_csv(config.output_dir("compartments") / "posthoc_depth.csv", index=False)
    print(out[["measure", "n_grp1", "n_grp0", "pct", "d", "d_lo", "d_hi", "p_perm"]].round(4).to_string(index=False))


if __name__ == "__main__":
    main()
