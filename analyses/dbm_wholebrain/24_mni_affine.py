"""Template-to-MNI affine for approximate MNI coordinates (cluster peaks and figure slice labels).

Usage: 24_mni_affine.py coords MNI152_T1_1mm_brain.nii.gz | 24_mni_affine.py fit
coords: writes MNI x, y, and z coordinate maps (RAS mm) on the MNI152 grid, which 24_mni.sh resamples into the
template with the rigid + affine registration alone.
fit: writes mni/template_to_mni_affine.txt, the 4 x 4 matrix from template RAS mm to MNI RAS mm behind those
resampled maps. The matrix stays valid below the MNI152 grid, where the resampled maps are 0.
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy.io import loadmat

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import dbmwb as wb  # noqa: E402

if sys.argv[1] == "coords":
    m = nib.load(sys.argv[2])
    ijk = np.indices(m.shape).reshape(3, -1)
    xyz = (m.affine @ np.r_[ijk, np.ones((1, ijk.shape[1]))])[:3]
    for n, v in zip("xyz", xyz):
        nib.save(nib.Nifti1Image(v.reshape(m.shape).astype(np.float32), m.affine), wb.MNI / f"mni{n}_mni.nii.gz")
    sys.exit()

# Derive the template-to-MNI map from the ANTs affine.
# ITK maps a fixed (template) point x to the moving (MNI) point A (x - c) + t + c, in LPS mm.
mat = loadmat(wb.MNI / "mni_aff_0GenericAffine.mat")
p = mat[next(k for k in mat if k.startswith("AffineTransform"))][:, 0]
A, t, c = p[:9].reshape(3, 3), p[9:12], mat["fixed"][:, 0]
L = np.diag([-1.0, -1.0, 1.0])  # RAS <-> LPS.
M = np.eye(4)
M[:3, :3] = L @ A @ L
M[:3, 3] = L @ (t + c - A @ c)

# Check against the resampled coordinate maps inside the MNI152 grid.
tpl = nib.load(wb.TPL / "template_final.nii.gz")
maps = np.stack([np.asarray(nib.load(wb.MNI / f"mni{n}_aff.nii.gz").dataobj, dtype=np.float64) for n in "xyz"])
inside = (maps != 0).all(0)
ijk = np.array(np.nonzero(inside))
pred = (M @ tpl.affine @ np.r_[ijk, np.ones((1, ijk.shape[1]))])[:3]
res = np.abs(pred - maps[:, inside])
print(f"Template to MNI affine: {inside.sum()} voxels checked, median |residual| {np.median(res):.4f} mm, "
      f"99th percentile {np.percentile(res, 99):.4f} mm.")
assert np.median(res) < 0.01, "The affine does not reproduce the resampled MNI coordinate maps."
np.savetxt(wb.MNI / "template_to_mni_affine.txt", M)
