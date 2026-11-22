"""Origin check after reorientation: distance from the image origin to the anterior commissure.

The anterior commissure is estimated as the participant-space point that the Segment affine (seg8.mat Affine,
participant world to MNI) maps to MNI (0, 0, 0). The same distance is given for the scanner header. Writes
origin_check.csv to the work folder and prints the summary.
"""

import numpy as np
import pandas as pd
import scipy.io as sio

import dartel_common as dc

rows = []
for pid in dc.processed_ids():
    d = dc.seg_dir(pid)
    A = sio.loadmat(str(d / f"{pid}_T1w_seg8.mat"), variable_names=["Affine"])["Affine"]
    r = sio.loadmat(str(d / "reorient.mat"))
    ac_new = np.linalg.solve(A, [0, 0, 0, 1])[:3]           # In reoriented world mm.
    vox = np.linalg.solve(r["newmat"], np.r_[ac_new, 1])
    ac_orig = (r["orig"] @ vox)[:3]                          # In scanner world mm.
    rows.append(dict(participant_id=pid, ac_dist_reoriented_mm=np.linalg.norm(ac_new),
                     ac_dist_scanner_mm=np.linalg.norm(ac_orig)))
df = pd.DataFrame(rows)
df.to_csv(dc.WORK / "origin_check.csv", index=False)
print(df.describe().round(1).to_string())
