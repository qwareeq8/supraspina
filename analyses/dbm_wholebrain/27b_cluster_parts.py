"""Anatomical parts of each SCI < CTRL two-direction cluster, SCI vs CTRL.

Each cluster whole and split by template majority labels into brainstem (subfield labels or aseg 16), cerebellum
(7, 8, 46, 47), and the supratentorial rest left and right of the subfield-brainstem centroid. Per part: voxels,
minimum two-direction P_FWE (exact counts), peak t, approximate MNI of the peak, and the part-mean effect (model as
in 27_voxel_summary.py; selected in the same participants, so inflated). Writes cluster_parts.csv to the output
folder.
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
import dbmwb as wb  # noqa: E402
import stats_lib as sl  # noqa: E402

mimg = nib.load(wb.ST / "mask.nii.gz")
aff = mimg.affine
sh = mimg.shape
lab = np.asarray(nib.load(wb.ST / "labels_aparc_crop.nii.gz").dataobj).astype(int)
sfl = np.asarray(nib.load(wb.ST / "labels_subfields_crop.nii.gz").dataobj).astype(int)
M2 = np.loadtxt(wb.MNI / "template_to_mni_affine.txt") @ aff
cx = np.array(np.nonzero(sfl > 0)).mean(1)[0]
X = np.indices(sh)[0]  # RAS grid: lower x index is the participant's left.
bs = (sfl > 0) | (lab == 16)
cb = np.isin(lab, wb.CBLM) & ~bs
PARTS = {"whole": np.ones(sh, bool), "brainstem": bs, "cerebellum": cb,
         "supratentorial left": ~bs & ~cb & (X < cx), "supratentorial right": ~bs & ~cb & (X >= cx)}

ids = pd.read_csv(wb.DESIGN / "subjects.txt", header=None)[0].tolist()
f = config.participants().set_index("participant_id").loc[ids].reset_index()
data = np.asarray(nib.load(wb.DESIGN / "logjac_s4.nii.gz").dataobj)
t = nib.load(wb.DESIGN / "tstat2.nii.gz").get_fdata()  # SCI < CTRL.
_, pf = sl.pfwe_exact(wb.DESIGN, 2)
cl = np.asarray(nib.load(wb.DESIGN / "clusters_two_dir_2.nii.gz").dataobj)
rows = []
for k in range(1, int(cl.max()) + 1):
    for pn, pm in PARTS.items():
        m = (cl == k) & pm
        if not m.any():
            continue
        pk = tuple(np.array(np.nonzero(m))[:, t[m].argmax()])
        mni = M2 @ np.r_[pk, 1]
        r = sl.fit(f, data[m].mean(0), "sci")
        rows.append(dict(region=f"cluster {k}, {pn}", n_vox=int(m.sum()), min_pfwe_two=float(min(1, 2 * pf[m].min())),
                         peak_t=float(t[m].max()), mni_x=mni[0], mni_y=mni[1], mni_z=mni[2],
                         d=r["d"], d_lo=r["d_lo"], d_hi=r["d_hi"], pct=r["pct"], n1=r["n_grp1"], n0=r["n_grp0"]))
o = pd.DataFrame(rows)
o.to_csv(config.output_dir("dbm_wholebrain") / "cluster_parts.csv", index=False)
print(o.round(3).to_string(index=False))
