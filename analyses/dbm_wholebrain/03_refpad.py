"""Pad an image by PAD voxels on every side with zeros, keeping the affine consistent.

Used for the rigid pose reference of the template's first iteration. Usage: 03_refpad.py in out pad
"""

import sys

import nibabel as nib
import numpy as np

src, dst, pad = sys.argv[1], sys.argv[2], int(sys.argv[3])
img = nib.load(src)
a = np.asarray(img.dataobj, dtype=np.float32)
out = np.pad(a, pad)
aff = img.affine.copy()
aff[:3, 3] = img.affine[:3, :3] @ np.array([-pad] * 3) + img.affine[:3, 3]
o = nib.Nifti1Image(out, aff)
o.set_qform(aff, 1)
o.set_sform(aff, 1)
nib.save(o, dst)
print(a.shape, "->", out.shape)
