"""Fix the template grid once, without group information.

Bounding box of the voxels where the iteration-0 average exceeds 10% of its 99th percentile, + 8 mm per side
(1 mm voxels). Usage: 04_grid.py in out
"""

import sys

import nibabel as nib
import numpy as np

src, dst = sys.argv[1], sys.argv[2]
img = nib.load(src)
a = np.asarray(img.dataobj, dtype=np.float32)
m = a > 0.10 * np.percentile(a[a > 0], 99)
ijk = np.array(np.nonzero(m))
lo = np.maximum(ijk.min(1) - 8, 0)
hi = np.minimum(ijk.max(1) + 8, np.array(a.shape) - 1)
sl = tuple(slice(x, y + 1) for x, y in zip(lo, hi))
aff = img.affine.copy()
aff[:3, 3] = img.affine[:3, :3] @ lo + img.affine[:3, 3]
o = nib.Nifti1Image(a[sl], aff)
o.set_qform(aff, 1)
o.set_sform(aff, 1)
nib.save(o, dst)
print(a.shape, "->", a[sl].shape, "lo", lo, "hi", hi)
