"""Nucleus and tract ROIs on the brainstem DBM template from the warped atlas labels (group-blind).

A label is kept where its warped probability is at least 0.25, and a voxel claimed by several labels of one
atlas goes to the most probable one; left and right labels are combined by their voxelwise maximum. Tracts
are split into medulla, pons, and midbrain by the template subfield labels. Dorsal vagal complex (VSM)
voxels inside the DCN region are left to the DCN region. Writes <work_dir>/atlas_nuclei_tracts/rois/
<roi>.nii.gz and <output_dir>/atlas_nuclei_tracts/roi_sizes.csv (voxels and overlap with the DCN region).

Inputs: the warped labels of warp_labels.py, the template subfield labels
(<work_dir>/dbm_brainstem/template/labels_subfields_majority.nii.gz), and the DCN region of the medullary
compartments (<work_dir>/compartments/rois/R3_dcn_region_t50.nii.gz).
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

THR = 0.25
NUCLEI = {"VSM": ["VSM_l", "VSM_r"], "Ve": ["Ve_l", "Ve_r"], "iMRt": ["iMRt_l", "iMRt_r"], "ION": ["ION_l", "ION_r"],
          "RN": ["RN_l", "RN_r"], "raphe_med": ["ROb", "RPa"], "sMRt": ["sMRt_l", "sMRt_r"]}
TRACTS = {"ML": ["MLL", "MLR"], "STT": ["STTL", "STTR"], "CST": ["CSTL", "CSTR"],
          "ICP": ["ICPVCL", "ICPVCR", "ICPMCL", "ICPMCR"]}
LEVELS = {"medulla": 175, "pons": 174, "midbrain": 173}  # FreeSurfer brainstem subfield codes.


def load(p):
    return np.asarray(nib.load(p).dataobj, dtype=np.float32)


def winner(groups, tag, tpl_dir):
    """Masks by the maximum-probability rule: name -> voxels with P >= THR where that label is the most probable."""
    names = list(groups)
    P = np.stack([np.max([load(tpl_dir / f"{tag}_{x}_tpl.nii.gz") for x in groups[n]], axis=0) for n in names])
    best = P.argmax(0)
    return {n: (P[i] >= THR) & (best == i) for i, n in enumerate(names)}


def main():
    work = config.work_dir("atlas_nuclei_tracts")
    tpl = nib.load(config.work_dir("dbm_brainstem") / "template" / "template_final.nii.gz")
    sub = load(config.work_dir("dbm_brainstem") / "template" / "labels_subfields_majority.nii.gz").astype(int)
    dcn = load(config.work_dir("compartments") / "rois" / "R3_dcn_region_t50.nii.gz") > 0
    nav = winner(NUCLEI, "nav", work / "tpl")
    tang = winner(TRACTS, "tang", work / "tpl")

    R = {"NAV_VSM": nav["VSM"] & ~dcn}
    for n in ("Ve", "iMRt", "ION", "RN", "raphe_med", "sMRt"):
        R[f"NAV_{n}"] = nav[n]
    for n, m in tang.items():
        for lev, code in LEVELS.items():
            R[f"TR_{n}_{lev}"] = m & (sub == code)
    R["DCN_region"] = dcn
    # The inferior medullary reticular formation outside the DCN region (descriptive).
    R["iMRt_outside_DCN"] = nav["iMRt"] & ~dcn

    out = work / "rois"
    out.mkdir(exist_ok=True)
    rows = []
    for n, m in R.items():
        nib.save(nib.Nifti1Image(m.astype(np.uint8), tpl.affine), out / f"{n}.nii.gz")
        rows.append(dict(roi=n, voxels=int(m.sum()), overlap_dcn=int((m & dcn).sum())))
    sizes = pd.DataFrame(rows)
    sizes.to_csv(config.output_dir("atlas_nuclei_tracts") / "roi_sizes.csv", index=False)
    print(sizes.to_string(index=False))


if __name__ == "__main__":
    main()
