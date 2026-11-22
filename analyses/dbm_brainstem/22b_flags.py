"""Registration QC flags for the visual review of the brainstem DBM registrations.

A registration is flagged when the whole-brainstem Dice is below 0.85, the medulla Dice below 0.80, or
any rule measure (Dice of medulla, pons, midbrain, whole brainstem, cerebellar cortex and white matter,
or the warped-T1 correlation) below the sample median - 4 x the scaled MAD (1.4826 x MAD). Flags guide
the review of the overlays (23_qc_png.py); exclusions are decided at that review and listed in
qc.dbm_registration_exclusions. Group is not used. Writes reg_flags.txt (participant level) and
regqc_summary.csv (sample level). Prints counts only.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

RULE = ["dice_medulla", "dice_pons", "dice_midbrain", "dice_brainstem", "dice_cblm_ctx", "dice_cblm_wm", "r_T1_mask"]
FIXED = {"dice_brainstem": 0.85, "dice_medulla": 0.80}


def main():
    W = config.work_dir("dbm_brainstem")
    q = config.read_private(W / "regqc.csv")
    rows, flags = [], {}
    for c in RULE:
        x = q[c].values
        med = float(np.median(x))
        mad = 1.4826 * float(np.median(np.abs(x - med)))
        thr = med - 4 * mad
        rows.append(dict(measure=c, median=med, scaled_mad=mad, min=float(x.min()), robust_threshold=thr,
                         n_below_robust=int((x < thr).sum()), fixed_threshold=FIXED.get(c, np.nan),
                         n_below_fixed=int((x < FIXED[c]).sum()) if c in FIXED else np.nan))
        for s, v in zip(q.participant_id, x):
            if v < thr:
                flags.setdefault(s, []).append(f"{c}<median-4MAD")
            if c in FIXED and v < FIXED[c]:
                flags.setdefault(s, []).append(f"{c}<{FIXED[c]}")
    pd.DataFrame(rows).to_csv(config.output_dir("dbm_brainstem") / "regqc_summary.csv", index=False)
    lines = ["# Registration QC flags (22b_flags.py): participant_id reasons"]
    lines += [f"{s} {'; '.join(r)}" for s, r in sorted(flags.items())]
    (W / "reg_flags.txt").write_text("\n".join(lines) + "\n")
    print(f"Registrations checked: {len(q)}; flagged for review: {len(flags)}")


if __name__ == "__main__":
    main()
