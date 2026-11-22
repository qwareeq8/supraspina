"""Warp the 7 T atlas nuclei and the brainstem tracts to the brainstem DBM template (group-blind).

Brainstem Navigator v1.0 nuclei and the tracts of Tang et al. (2018) are probabilistic labels on the FSL
MNI152 1 mm template. Each label is cropped to a brainstem box and warped with linear interpolation through
the MNI152-to-template registration used for the JHU labels. Writes
<work_dir>/atlas_nuclei_tracts/tpl/<atlas>_<label>_tpl.nii.gz.

Inputs: the template (<work_dir>/dbm_brainstem/template/template_final.nii.gz) and the registration
(<work_dir>/compartments/reg_ref/mni152fsl_1Warp.nii.gz and mni152fsl_0GenericAffine.mat).
"""

import os
import subprocess
import sys
from pathlib import Path

import nibabel as nib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

# Label files relative to atlases.brainstem_navigator and atlases.brainstem_tracts.
NAV = ["VSM_l", "VSM_r", "Ve_l", "Ve_r", "iMRt_l", "iMRt_r", "ION_l", "ION_r", "RN_l", "RN_r", "ROb", "RPa",
       "sMRt_l", "sMRt_r"]
TRACTS = ["MLL", "MLR", "STTL", "STTR", "CSTL", "CSTR", "ICPVCL", "ICPVCR", "ICPMCL", "ICPMCR"]
LABELS = {"nav": {n: config.path("atlases.brainstem_navigator") / "2a.BrainstemNucleiAtlas_MNI"
                  / "labels_probabilistic" / f"{n}.nii.gz" for n in NAV},
          "tang": {n: config.path("atlases.brainstem_tracts") / f"{n}_Atlas.nii.gz" for n in TRACTS}}
BOX = ((-35, 35), (-75, -5), (-72, -5))  # RAS mm around the brainstem in MNI space.


def crop(img, a):
    """Crop array a (on img's grid) to BOX; returns the crop and its affine."""
    A = img.affine
    inv = np.linalg.inv(A)
    c = np.array([[x, y, z] for x in BOX[0] for y in BOX[1] for z in BOX[2]])
    ijk = (inv @ np.c_[c, np.ones(len(c))].T)[:3]
    lo = np.maximum(np.floor(ijk.min(1)).astype(int), 0)
    hi = np.minimum(np.ceil(ijk.max(1)).astype(int), np.array(a.shape[:3]) - 1)
    sl = tuple(slice(p, q + 1) for p, q in zip(lo, hi))
    aff = A.copy()
    aff[:3, 3] = A[:3, :3] @ lo + A[:3, 3]
    return a[sl], aff


def main():
    template = config.work_dir("dbm_brainstem") / "template" / "template_final.nii.gz"
    reg = config.work_dir("compartments") / "reg_ref"
    xf = ["-t", str(reg / "mni152fsl_1Warp.nii.gz"), "-t", str(reg / "mni152fsl_0GenericAffine.mat")]
    ants = config.path("software.ants_bin") / "antsApplyTransforms"
    env = {**os.environ, "ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS": str(config.get("software.threads", 4))}
    out = config.work_dir("atlas_nuclei_tracts") / "tpl"
    out.mkdir(exist_ok=True)
    for tag, labels in LABELS.items():
        for name, f in labels.items():
            img = nib.load(f)
            a = np.asanyarray(img.dataobj).astype(np.float32)
            if a.max() > 1.0 + 1e-3:  # Probabilities stored as percent.
                a = a / 100.0
            m, aff = crop(img, a)
            src = out / f"{tag}_{name}_src.nii.gz"
            nib.save(nib.Nifti1Image(m, aff), src)
            dst = out / f"{tag}_{name}_tpl.nii.gz"
            subprocess.run([str(ants), "-d", "3", "-i", str(src), "-r", str(template), "-o", str(dst),
                            "-n", "Linear", *xf], check=True, env=env)
            w = np.asarray(nib.load(dst).dataobj)
            print(f"{tag} {name}: source mass {m.sum():.1f} voxels; template voxels >= 0.25: {(w >= 0.25).sum()}")


if __name__ == "__main__":
    main()
