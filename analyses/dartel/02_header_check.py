"""Header and orientation check of the staged T1 crops.

Per participant: shape, voxel size, axis codes, sform and qform codes, sign of the affine determinant, data type,
and the brain-mask centroid in world mm (the mask may be on the uncropped source grid, so the centroid is taken in
world coordinates). Writes header_check.csv to the work folder and prints the value counts.
"""

import nibabel as nib
import numpy as np
import pandas as pd

import dartel_common as dc

RAW = dc.WORK / "raw"
rows = []
for pid in dc.processed_ids():
    im = nib.load(str(RAW / f"{pid}_T1w.nii"))
    mk = nib.load(str(RAW / f"{pid}_mask.nii"))
    A = im.affine
    ijk = np.argwhere(np.asarray(mk.dataobj) > 0).mean(0)
    c = mk.affine @ np.r_[ijk, 1]
    rows.append(dict(participant_id=pid, shape="x".join(map(str, im.shape)),
                     zooms="x".join(f"{z:.3f}" for z in im.header.get_zooms()),
                     axcodes="".join(nib.aff2axcodes(A)), det=np.sign(np.linalg.det(A[:3, :3])),
                     sform=int(im.header["sform_code"]), qform=int(im.header["qform_code"]),
                     dtype=str(im.get_data_dtype()), cx=c[0], cy=c[1], cz=c[2],
                     mask_shape="x".join(map(str, mk.shape))))
df = pd.DataFrame(rows)
df.to_csv(dc.WORK / "header_check.csv", index=False)
for k in ["zooms", "axcodes", "det", "sform", "qform", "dtype"]:
    print(k, df[k].value_counts().to_dict())
print("Distinct shapes:", df["shape"].nunique(), "; mask shapes:", df["mask_shape"].value_counts().to_dict())
print(df[["cx", "cy", "cz"]].describe().round(1))
