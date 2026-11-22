"""Brainstem region volumes from the unsmoothed modulated tissue maps.

Volume (mL) = sum of the modulated gray (mwc1) or white (mwc2) matter values in the region times the voxel volume;
out-of-view voxels count as 0. gmwm_fwhm0 is gray plus white matter, the reported DARTEL measure.
Writes roi_values.csv (participant_id and <region>|<map> columns) to the work folder. Prints counts only.
"""

import nibabel as nib
import numpy as np
import pandas as pd

import dartel_common as dc

masks, aff, shp = dc.region_masks()
vox_ml = abs(np.linalg.det(aff[:3, :3])) / 1000
idx = {k: np.flatnonzero(m.ravel()) for k, m in masks.items()}
rows = []
for pid in dc.ids():
    row = {"participant_id": pid}
    for kind in ("mwc1_fwhm0", "mwc2_fwhm0"):
        im = nib.load(str(dc.mni(kind, pid)))
        assert np.allclose(im.affine, aff) and im.shape == shp, "A tissue map is not on the DARTEL grid."
        v = np.nan_to_num(np.asarray(im.dataobj, np.float32).ravel())
        for k, ix in idx.items():
            row[f"{k}|{kind}"] = v[ix].sum() * vox_ml
    for k in idx:
        row[f"{k}|gmwm_fwhm0"] = row[f"{k}|mwc1_fwhm0"] + row[f"{k}|mwc2_fwhm0"]
    rows.append(row)
out = pd.DataFrame(rows)
out.to_csv(dc.WORK / "roi_values.csv", index=False)
print(f"Region values for {len(out)} participants; region sizes (voxels):",
      {k: int(m.sum()) for k, m in masks.items()})
