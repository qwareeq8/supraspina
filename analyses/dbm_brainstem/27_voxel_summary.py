"""Summary of the brainstem DBM voxelwise TFCE maps.

Two-direction P_FWE = min(1, 2 P_FWE) per direction, where P_FWE is 1 minus the chunk-averaged corrp map
of 26_randomise.sh. Clusters are 26-connected voxels at two-direction P_FWE < 0.05 inside the analysis
mask; clusters below 0.05 mL are not interpreted. Per cluster: size, peak t, minimum P, peak position in
template mm and its distance below the pontomedullary junction (PMJ), the fraction in each template
region, and the cluster-mean log-Jacobian effect, which is inflated by selection and descriptive only.
The PMJ is the caudal end of the template pons label on the midline sagittal plane (the lowest pons
voxel at the mean x of the brainstem labels), as in Fig. 2.
Writes voxel_summary.csv and voxel_clusters.csv (group level).
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
from stats_lib import fit  # noqa: E402

MIN_ML = 0.05


def world(aff, ijk):
    return aff @ np.r_[ijk, 1]


def main():
    ST = config.work_dir("dbm_brainstem") / "stats"
    TB = config.output_dir("dbm_brainstem")
    mimg = nib.load(ST / "mask.nii.gz")
    mask = np.asarray(mimg.dataobj) > 0
    aff = mimg.affine
    lab = np.asarray(nib.load(ST / "labels_crop.nii.gz").dataobj)
    mid_i = int(round(np.nonzero(lab > 0)[0].mean()))
    pmj_k = int(np.nonzero((lab[mid_i] == 174).any(0))[0].min())
    pmj_z = world(aff, [mid_i, 0, pmj_k])[2]
    d = ST / "SCI_vs_CTRL"
    ids = (d / "subjects.txt").read_text().split()
    f = config.participants().set_index("participant_id").loc[ids].reset_index()
    data = np.asarray(nib.load(d / "logjac_s4.nii.gz").dataobj)
    assert data.shape[-1] == len(f)
    rows, summ = [], []
    for k, direction in ((1, "SCI > CTRL"), (2, "SCI < CTRL")):
        t = nib.load(d / f"tstat{k}.nii.gz").get_fdata()
        pf = np.where(mask, 1 - nib.load(d / f"tfce_corrp_tstat{k}.nii.gz").get_fdata(), 1.0)
        p2 = np.minimum(1, 2 * pf)
        summ.append(dict(direction=direction, min_pfwe_two=float(p2[mask].min()),
                         n_vox_two_lt05=int((p2[mask] < 0.05).sum()), max_t=float(t[mask].max()),
                         n_vox_mask=int(mask.sum())))
        cl, n = ndimage.label((p2 < 0.05) & mask, structure=np.ones((3, 3, 3)))
        for i in range(1, n + 1):
            m = cl == i
            ijk = np.array(np.nonzero(m))
            tv = t[m]
            xyz = world(aff, ijk[:, tv.argmax()])
            res = fit(f, data[m].mean(0), "sci")
            rows.append(dict(direction=direction, cluster=i, n_vox=int(m.sum()), vol_ml=m.sum() / 1000,
                             interpreted=m.sum() / 1000 >= MIN_ML, peak_t=float(tv.max()),
                             min_pfwe_two=float(p2[m].min()), peak_x=xyz[0], peak_y=xyz[1], peak_z=xyz[2],
                             peak_mm_below_pmj=float(pmj_z - xyz[2]),
                             frac_medulla=float((lab[m] == 175).mean()), frac_pons=float((lab[m] == 174).mean()),
                             frac_midbrain=float((lab[m] == 173).mean()), frac_scp=float((lab[m] == 178).mean()),
                             frac_outside_labels=float((lab[m] == 0).mean()),
                             incluster_d_selected=res["d"], incluster_d_lo=res["d_lo"], incluster_d_hi=res["d_hi"],
                             incluster_pct_selected=res["pct"]))
    S, C = pd.DataFrame(summ), pd.DataFrame(rows)
    S.to_csv(TB / "voxel_summary.csv", index=False)
    C.to_csv(TB / "voxel_clusters.csv", index=False)
    print(S.round(4).to_string(index=False))
    print(C.round(3).to_string(index=False) if len(C) else "No clusters.")


if __name__ == "__main__":
    main()
