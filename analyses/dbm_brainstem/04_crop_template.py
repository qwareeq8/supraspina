"""Crop a template by a number of voxels on every side, keeping its world coordinates.

Usage: 04_crop_template.py <in.nii.gz> <out.nii.gz> <voxels>
"""

import sys

import nibabel as nib
import numpy as np


def main():
    src, dst, cut = sys.argv[1], sys.argv[2], int(sys.argv[3])
    img = nib.load(src)
    a = np.asarray(img.dataobj, dtype=np.float32)
    sl = tuple(slice(cut, n - cut) for n in a.shape)
    aff = img.affine.copy()
    aff[:3, 3] = img.affine[:3, :3] @ np.array([cut] * 3) + img.affine[:3, 3]
    out = nib.Nifti1Image(a[sl], aff)
    out.set_qform(aff, 1)
    out.set_sform(aff, 1)
    nib.save(out, dst)


if __name__ == "__main__":
    main()
