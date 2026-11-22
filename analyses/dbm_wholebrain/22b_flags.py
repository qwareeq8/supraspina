"""Registration QC flags, fixed before any group result and blind to group.

A participant is flagged for close visual review when the whole subfield brainstem Dice is below 0.85, the medulla
Dice below 0.80, or any planned Dice (cortex, cerebral WM, cerebellar cortex and WM, left and right thalamus,
whole subfield brainstem, medulla, lateral ventricles) or the warped-T1 correlation lies below the cohort median
minus 4 scaled MAD (1.4826 MAD). Writes reg_flags.csv (participant_id, reasons) to the work folder.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import dbmwb as wb  # noqa: E402

q = pd.read_csv(wb.W / "regqc.csv")
RULE = ["dice_cortex", "dice_cerebral_wm", "dice_cblm_ctx", "dice_cblm_wm", "dice_thalamus_L", "dice_thalamus_R",
        "dice_brainstem_sf", "dice_medulla", "dice_lat_vent", "r_T1_mask"]
FIXED = {"dice_brainstem_sf": 0.85, "dice_medulla": 0.80}
flags: dict[str, list[str]] = {}
for c in RULE:
    x = q[c].values
    med = float(np.median(x))
    thr = med - 4 * 1.4826 * float(np.median(np.abs(x - med)))
    for s, v in zip(q.participant_id, x):
        if v < thr:
            flags.setdefault(s, []).append(f"{c}={v:.3f}<median-4MAD({thr:.3f})")
        if c in FIXED and v < FIXED[c]:
            flags.setdefault(s, []).append(f"{c}={v:.3f}<{FIXED[c]}")
pd.DataFrame({"participant_id": list(flags), "reasons": ["; ".join(r) for r in flags.values()]}).to_csv(
    wb.W / "reg_flags.csv", index=False)
print(f"Flagged: {len(flags)} of {len(q)}; all log-Jacobians finite: {bool(q.finite.all())}.")
