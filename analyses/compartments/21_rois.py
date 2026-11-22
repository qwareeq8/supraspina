"""Template-space ROIs of the medullary compartment analyses, from the warped atlas labels.

Zone: the template medulla dilated by a 2 mm ball, without the template pons and midbrain, inside the
brainstem DBM mask. Obex: the lowest axial slice of the template fourth-ventricle label; voxels below it
are the closed (caudal) medulla. Dorsal and ventral halves: per axial slice, split at the midpoint of the
template medulla's anterior-posterior extent.
  Compartments, at partial-volume fraction >= 0.5 (t50) and >= 0.75 (t75), each within the zone:
    R1 pyramids (Allen MoPy), R2 inferior olives (IO), R3 DCN region (MoTg in the dorsal half caudal
    to the obex), R4 rest of the tegmentum (other MoTg), R5 inferior cerebellar peduncles (icp), and
    R1c, the pyramids caudal to the obex.
  JHU_CST: JHU corticospinal tract (t50) within the zone.
  GEO_dorsal_caudal, GEO_ventral_caudal: atlas-free dorsal and ventral halves of the closed medulla.
  DEPTH_*: core (template medulla eroded by a 2 mm ball) and its outer 2 mm rim in the closed medulla,
    each split into dorsal and ventral halves.
  SC, IC: Allen superior (12292) and inferior (12305) colliculi (t50).
Group-blind: reads template-space images only. Writes rois/ in the section's work folder.
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

THRESHOLDS = ((0.5, "t50"), (0.75, "t75"))


def main():
    T = config.work_dir("dbm_brainstem") / "template"
    C = config.work_dir("compartments")
    L, O = C / "labels", C / "rois"
    O.mkdir(exist_ok=True)
    A = nib.load(T / "template_final.nii.gz").affine
    lab = np.asarray(nib.load(T / "labels_subfields_majority.nii.gz").dataobj)
    alab = np.asarray(nib.load(T / "labels_aseg_majority.nii.gz").dataobj)
    bmask = np.asarray(nib.load(T / "brainstem_mask_dil2.nii.gz").dataobj) > 0
    med = lab == 175
    zz, yy, xx = np.indices((5, 5, 5)) - 2
    ball = (zz**2 + yy**2 + xx**2) <= 4
    zone = ndimage.binary_dilation(med, structure=ball) & ~np.isin(lab, (173, 174)) & bmask
    obex_k = int(np.nonzero((alab == 3).any((0, 1)))[0].min())

    dorsal = np.zeros_like(med)
    ventral = np.zeros_like(med)
    Y = np.indices(med.shape)[1]
    for k in range(med.shape[2]):
        m = med[:, :, k]
        if not m.any():
            continue
        ys = np.nonzero(m.any(0))[0]
        mid = (ys.min() + ys.max()) / 2
        dorsal[:, :, k] = Y[:, :, k] < mid
        ventral[:, :, k] = Y[:, :, k] >= mid
    caudal = np.zeros_like(med)
    caudal[:, :, :obex_k] = True

    def frac(name):
        return np.asarray(nib.load(L / f"{name}_tpl.nii.gz").dataobj, dtype=np.float32)

    R = {}
    for thr, tag in THRESHOLDS:
        al = {n: frac(f"allen_{n}") >= thr for n in ("MoPy", "MoTg", "IO", "icp")}
        R[f"R1_pyramid_{tag}"] = al["MoPy"] & zone
        R[f"R2_olive_{tag}"] = al["IO"] & zone
        R[f"R3_dcn_region_{tag}"] = al["MoTg"] & zone & caudal & dorsal
        R[f"R4_tegmentum_rest_{tag}"] = al["MoTg"] & zone & ~(caudal & dorsal)
        R[f"R5_icp_{tag}"] = al["icp"] & zone
        R[f"R1c_pyramid_caudal_{tag}"] = R[f"R1_pyramid_{tag}"] & caudal
    R["JHU_CST"] = (frac("jhu_CST") >= 0.5) & zone
    R["GEO_dorsal_caudal"] = med & dorsal & caudal
    R["GEO_ventral_caudal"] = med & ventral & caudal
    dors = dorsal & med
    core = ndimage.binary_erosion(med, structure=ball) & med & caudal
    rim = med & caudal & ~core
    R.update({"DEPTH_core_dorsal": core & dors, "DEPTH_core_ventral": core & ~dors,
              "DEPTH_rim_dorsal": rim & dors, "DEPTH_rim_ventral": rim & ~dors})
    R["SC"] = frac("allen_SC") >= 0.5
    R["IC"] = frac("allen_IC") >= 0.5
    for name, m in R.items():
        img = nib.Nifti1Image(m.astype(np.uint8), A)
        img.set_qform(A, 1)
        img.set_sform(A, 1)
        nib.save(img, O / f"{name}.nii.gz")
    print({k: int(v.sum()) for k, v in R.items()})


if __name__ == "__main__":
    main()
