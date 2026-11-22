"""Per-participant mean total log-Jacobian (SyN warp log-Jacobian + log|det A| of the affine, unsmoothed,
float64) over each template ROI of 21_rois.py, from the brainstem DBM registrations. Reads no group
variable. Writes roi_values.csv (compartments, JHU, and atlas-free ROIs), depth_values.csv (core and rim),
and tectal_values.csv (colliculi, with the DCN region recomputed as dcn_check), all participant level.
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd
from scipy.io import loadmat

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

COMPARTMENTS = ("R1_pyramid", "R2_olive", "R3_dcn_region", "R4_tegmentum_rest", "R5_icp", "R1c_pyramid_caudal")
OTHER = ("JHU_CST", "GEO_dorsal_caudal", "GEO_ventral_caudal")
DEPTH = ("core_dorsal", "core_ventral", "rim_dorsal", "rim_ventral")


def main():
    REG = config.work_dir("dbm_brainstem") / "reg"
    C = config.work_dir("compartments")

    def roi(name):
        return np.asarray(nib.load(C / f"rois/{name}.nii.gz").dataobj) > 0

    M = {f"{n}_{t}": roi(f"{n}_{t}") for t in ("t50", "t75") for n in COMPARTMENTS}
    M.update({n: roi(n) for n in OTHER})
    DEP = {k: roi(f"DEPTH_{k}") for k in DEPTH}
    TEC = {"SC": roi("SC"), "IC": roi("IC")}
    TEC["tectum"] = TEC["SC"] | TEC["IC"]
    TEC["dcn_check"] = M["R3_dcn_region_t50"]
    rows, drows, trows = [], [], []
    for s in config.participants().participant_id:
        m = loadmat(REG / f"{s}_0GenericAffine.mat")
        key = [k for k in m if k.startswith("AffineTransform")][0]
        ldA = float(np.log(abs(np.linalg.det(m[key][:9, 0].reshape(3, 3)))))
        lt = np.asarray(nib.load(REG / f"{s}_logjac_warp.nii.gz").dataobj, dtype=np.float64) + ldA
        rows.append(dict(participant_id=s, logdetA=ldA, **{f"{k}_mlogj": float(lt[v].mean()) for k, v in M.items()}))
        drows.append(dict(participant_id=s, **{k: float(lt[v].mean()) for k, v in DEP.items()}))
        trows.append(dict(participant_id=s, **{k: float(lt[v].mean()) for k, v in TEC.items()}))
    pd.DataFrame(rows).to_csv(C / "roi_values.csv", index=False)
    pd.DataFrame(drows).to_csv(C / "depth_values.csv", index=False)
    pd.DataFrame(trows).to_csv(C / "tectal_values.csv", index=False)
    print(f"ROI values for {len(rows)} participants.")


if __name__ == "__main__":
    main()
