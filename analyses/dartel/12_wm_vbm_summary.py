"""Pool the randomise chunks of the white matter analysis and summarize the TFCE result (Supplementary Fig. 2).

The TFCE and t maps are the same in every chunk (same data and design). The chunks' null distributions of the
maximum TFCE are pooled (N = 5,000; the first entry of each chunk is the unpermuted statistic), and
P_FWE(v) = #(null >= TFCE(v)) / N for the tested direction (smaller in SCI), then doubled. Voxels with doubled
P < 0.05 form clusters by 26-neighbor connectivity; the largest is the caudal medullary cluster.
Writes to the output folder, vbm/: wm_t_sci_minus_ctrl.nii.gz (t, SCI minus CTRL, within the mask),
wm_p_fwe.nii.gz (doubled P_FWE), wm_cluster.nii.gz (largest cluster), and wm_vbm_summary.csv.
"""

import re

import nibabel as nib
import numpy as np
import pandas as pd
from scipy import ndimage

import dartel_common as dc

O = dc.WORK / "vbm"
R = O / "rand"
V = dc.OUT / "vbm"
order = pd.read_csv(O / "order.csv").participant_id.tolist()
assert order == dc.design().participant_id.tolist(), "The randomise design is not the current sample."
mi = nib.load(str(V / "mask_wm02.nii.gz"))
aff = mi.affine
mask = np.asarray(mi.dataobj) > 0

ks = sorted(int(re.search(r"chunk(\d+)_c1\.done", p.name).group(1)) for p in R.glob("chunk*_c1.done"))
assert len(ks) == 10, "Some randomise chunks are missing."
nulls = [np.loadtxt(R / f"chunk{k}_c1_tfce_corrp_tstat1.txt").ravel() for k in ks]
b = R / f"chunk{ks[0]}_c1"
tf = np.asarray(nib.load(f"{b}_tfce_tstat1.nii.gz").dataobj, np.float64)
tt = np.asarray(nib.load(f"{b}_tstat1.nii.gz").dataobj, np.float64)
for nv in nulls:
    assert abs(nv[0] - tf[mask].max()) <= 1e-3 * max(1, tf.max()), (
        "A chunk null does not start with the observed maximum."
    )
null = np.sort(np.concatenate(nulls))
N = len(null)
p = np.ones(mask.shape)
p[mask] = 1 - np.searchsorted(null, tf[mask], side="left") / N
p[mask & (tf <= 0)] = 1.0
pb = np.minimum(1, 2 * p)

xyz = dc.world(aff, mask.shape)
vox_ml = abs(np.linalg.det(aff[:3, :3])) / 1000
imin = np.argmin(np.where(mask, p, 2))
row = dict(n=len(order), n_perm=N, chunks=len(ks), mask_vox=int(mask.sum()),
           min_p_fwe=float(pb.ravel()[imin]), min_p_fwe_one_direction=float(p.ravel()[imin]),
           min_p_mni=[round(float(v), 1) for v in xyz[:, imin]],
           n_vox_p_fwe05=int((mask & (pb < 0.05)).sum()), ml_p_fwe05=float((mask & (pb < 0.05)).sum() * vox_ml))
lab, n = ndimage.label(mask & (pb < 0.05), structure=np.ones((3, 3, 3)))
row["n_clusters"] = int(n)
cm = np.zeros(mask.shape, bool)
if n:
    sizes = ndimage.sum(lab > 0, lab, range(1, n + 1))
    cm = lab == int(np.argmax(sizes)) + 1
    z = xyz[2][cm.ravel()]
    ipk = np.argmax(np.where(cm, tt, -np.inf))  # Largest CTRL - SCI t in the cluster.
    row.update(cluster_vox=int(cm.sum()), cluster_ml=float(cm.sum() * vox_ml), cluster_min_p_fwe=float(pb[cm].min()),
               cluster_z_range=[float(z.min()), float(z.max())],
               cluster_share_below_z_m46p5=float((z <= -46.5).mean()),
               cluster_centroid_mni=[round(float(v), 1) for v in xyz[:, cm.ravel()].mean(1)],
               cluster_peak_t_sci_minus_ctrl=float(-tt.ravel()[ipk]),
               cluster_peak_mni=[round(float(v), 1) for v in xyz[:, ipk]])
dc.save(np.where(mask, -tt, 0).astype(np.float32), aff, V / "wm_t_sci_minus_ctrl.nii.gz")
dc.save(pb.astype(np.float32), aff, V / "wm_p_fwe.nii.gz")
dc.save(cm.astype(np.uint8), aff, V / "wm_cluster.nii.gz")
pd.DataFrame([row]).to_csv(V / "wm_vbm_summary.csv", index=False, float_format="%.5g")
print(pd.Series(row).to_string())
