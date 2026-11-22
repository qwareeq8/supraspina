"""Mean total log-Jacobian of each atlas ROI per participant (private output).

Total log-Jacobian = mean warp log-Jacobian over the ROI + log|det A| of the affine stage, as for the
medullary compartments. ROIs under 20 voxels are left out (the inferior cerebellar peduncle in the midbrain).
Writes <work_dir>/atlas_nuclei_tracts/values_fine.csv: participant_id, one column per ROI, and the contrast
DCN_region-NAV_VSM.

Inputs: the ROIs of rois.py and each participant's registration to the template
(<work_dir>/dbm_brainstem/reg/<participant_id>_logjac_warp.nii.gz, the SyN log-Jacobian, and
<participant_id>_0GenericAffine.mat).
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd
from scipy.io import loadmat

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

MIN_VOXELS = 20


def log_det_affine(mat):
    """Return log|det A| of the linear part of an ANTs affine transform."""
    m = loadmat(mat)
    key = next(k for k in m if k.startswith("AffineTransform"))
    return float(np.log(abs(np.linalg.det(m[key][:9, 0].reshape(3, 3)))))


def main():
    work = config.work_dir("atlas_nuclei_tracts")
    sizes = pd.read_csv(config.output_dir("atlas_nuclei_tracts") / "roi_sizes.csv")
    rois = [r for r, n in zip(sizes.roi, sizes.voxels) if n >= MIN_VOXELS]
    masks = {r: np.asarray(nib.load(work / "rois" / f"{r}.nii.gz").dataobj) > 0 for r in rois}
    ids = config.participants().participant_id
    reg = config.work_dir("dbm_brainstem") / "reg"
    rows = []
    for p in ids:
        lw = np.asarray(nib.load(reg / f"{p}_logjac_warp.nii.gz").dataobj, dtype=np.float32)
        lda = log_det_affine(reg / f"{p}_0GenericAffine.mat")
        rows.append({"participant_id": p, **{r: float(lw[m].mean() + lda) for r, m in masks.items()}})
    v = pd.DataFrame(rows)
    # The DCN region must reproduce the compartment value extracted from the same registrations.
    comp = config.read_private(config.work_dir("compartments") / "outcome_values.csv").set_index("participant_id")
    assert np.allclose(v.DCN_region, comp.loc[v.participant_id, "R3_dcn_region_t50"].to_numpy(), atol=1e-6), \
        "The DCN region does not reproduce the compartment value."
    v["DCN_region-NAV_VSM"] = v.DCN_region - v.NAV_VSM
    v.to_csv(work / "values_fine.csv", index=False)
    print(f"Wrote {len(v)} participants and {len(rois)} ROIs (left out under {MIN_VOXELS} voxels: "
          f"{sorted(set(sizes.roi) - set(rois))}).")


if __name__ == "__main__":
    main()
