"""Voxelwise design for randomise: SCI vs CTRL.

Design columns: SCI, CTRL, age, female, eTIV (covariates demeaned within the analyzed sample; eTIV in liters);
contrasts C1 SCI > CTRL [1 -1 0 0 0] and C2 SCI < CTRL [-1 1 0 0 0]. Participants listed in
qc.dbm_wholebrain_registration_exclusions are left out. Writes the 4D subset (participant order), design.txt,
contrasts.txt, and subjects.txt to stats/SCI_vs_CTRL/.
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
import dbmwb as wb  # noqa: E402

subs = config.participants()
img = nib.load(wb.ST / "logjac_s4_all.nii.gz")
arr = np.asarray(img.dataobj)
assert arr.shape[-1] == len(subs)
keep = ~subs.participant_id.isin(wb.exclusions())
f = subs[keep]
wb.DESIGN.mkdir(exist_ok=True)
nib.save(nib.Nifti1Image(arr[..., keep.values], img.affine, img.header), wb.DESIGN / "logjac_s4.nii.gz")
X = np.column_stack([f.sci.values, 1 - f.sci.values]
                    + [f[c].astype(float).values - f[c].astype(float).mean() for c in ("age", "female")]
                    + [(f.eTIV.values - f.eTIV.mean()) / 1e6])
np.savetxt(wb.DESIGN / "design.txt", X, fmt="%.6f")
np.savetxt(wb.DESIGN / "contrasts.txt", np.array([[1, -1, 0, 0, 0], [-1, 1, 0, 0, 0]]), fmt="%d")
f.participant_id.to_csv(wb.DESIGN / "subjects.txt", index=False, header=False)
print("SCI_vs_CTRL", len(f), "SCI", int(f.sci.sum()), "excluded", int((~keep).sum()))
