"""Coverage check: does each participant's warped field of view contain every voxel of the brainstem regions?

The field-of-view image (ones on the native T1 grid, warped unmodulated with the participant's flow field) is
taken as covering a voxel where its value is at least 0.5 (NaN counts as 0). Writes the covered fraction of each
region per participant to coverage.csv in the work folder and prints the count of participants with full coverage.
Region values count out-of-view voxels as zero tissue, so any participant reported here needs review.
"""

import nibabel as nib
import numpy as np
import pandas as pd

import dartel_common as dc

masks, aff, shp = dc.region_masks()
rows = []
for pid in dc.ids():
    im = nib.load(str(dc.mni("fov", pid)))
    assert np.allclose(im.affine, aff) and im.shape == shp, "A field-of-view image is not on the DARTEL grid."
    cov = np.nan_to_num(np.asarray(im.dataobj, np.float32)) >= 0.5
    rows.append({"participant_id": pid, **{k: float(cov[m].mean()) for k, m in masks.items()}})
df = pd.DataFrame(rows)
df["covers_regions"] = (df[list(masks)] >= 1.0).all(axis=1).astype(int)
df.to_csv(dc.WORK / "coverage.csv", index=False)
n_bad = int((df.covers_regions == 0).sum())
print(f"Field of view covers every brainstem region voxel in {len(df) - n_bad} of {len(df)} participants.")
if n_bad:
    print("Some participants have region voxels outside the field of view; see coverage.csv in the work folder.")
