"""Crop an atlas reference T1 (MNI-type space) to a brainstem and cerebellum box like the participant crops.

The box (RAS world mm) comes from the Harvard-Oxford brain-stem label and the FSL cerebellum atlas in
MNI152 space: superior = brainstem top + 10 mm, inferior = the image's lower edge, left and right =
cerebellum +/- 6 mm, anterior = brainstem anterior + 15 mm, posterior = cerebellum posterior - 6 mm.
The crop is reoriented to RAS. Group-blind: reads atlas files only.
Usage: 10_crop_ref.py <reference_T1> <out.nii.gz>
"""

import os
import sys
from pathlib import Path

import nibabel as nib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402


def world(img, mask):
    ijk = np.array(np.nonzero(mask))
    return (img.affine @ np.r_[ijk, np.ones((1, ijk.shape[1]))])[:3]


def main():
    os.environ.setdefault("FSLDIR", str(config.path("software.fsl_dir")))
    ref = nib.as_closest_canonical(nib.load(sys.argv[1]))
    ho = nib.load(config.path("atlases.harvard_oxford_sub"))
    cb = nib.load(config.path("atlases.fsl_cerebellum"))
    bs = world(ho, np.asarray(ho.dataobj) == 8)
    c = world(cb, np.asarray(cb.dataobj) > 0)
    lo_w = np.array([c[0].min() - 6, c[1].min() - 6, -1e3])
    hi_w = np.array([c[0].max() + 6, bs[1].max() + 15, bs[2].max() + 10])
    corners = np.array([[x, y, z] for x in (lo_w[0], hi_w[0]) for y in (lo_w[1], hi_w[1]) for z in (lo_w[2], hi_w[2])])
    ijk = (np.linalg.inv(ref.affine) @ np.c_[corners, np.ones(len(corners))].T)[:3]
    lo = np.maximum(np.floor(ijk.min(1)).astype(int), 0)
    hi = np.minimum(np.ceil(ijk.max(1)).astype(int), np.array(ref.shape) - 1)
    sl = tuple(slice(a, b + 1) for a, b in zip(lo, hi))
    aff = ref.affine.copy()
    aff[:3, 3] = ref.affine[:3, :3] @ lo + ref.affine[:3, 3]
    img = nib.Nifti1Image(np.asarray(ref.dataobj, dtype=np.float32)[sl], aff)
    img.set_qform(aff, 1)
    img.set_sform(aff, 1)
    nib.save(img, sys.argv[2])


if __name__ == "__main__":
    main()
