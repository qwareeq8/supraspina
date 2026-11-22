"""Summary and clusters of the voxelwise TFCE maps, SCI vs CTRL.

Two-direction P_FWE = min(1, 2 P_FWE) per direction, from exact permutation counts (stats_lib.pfwe_exact), so
P < 0.05 is count < 125 of 5,000. Clusters are 26-connected voxels at two-direction P_FWE < 0.05, numbered by size;
clusters below 0.05 mL are listed but not interpreted. Per cluster: size, peak t and its position in template and
approximate MNI mm (affine), the majority label at the peak and the label composition, anatomical class fractions,
the distance of its lowest voxel above the mask floor (the lowest template-medulla slice; 0 means it reaches the
inferior mask boundary), and the cluster-mean effect of the smoothed total log-Jacobian (selected in the same
participants, so inflated; sel_ columns). Writes voxel_summary.csv and voxel_clusters.csv to the output folder and
stats/SCI_vs_CTRL/clusters_two_dir_<k>.nii.gz (k = 1 SCI > CTRL, 2 SCI < CTRL).
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
import dbmwb as wb  # noqa: E402
import stats_lib as sl  # noqa: E402

OUT = config.output_dir("dbm_wholebrain")
LUT = {}
for line in open(config.path("freesurfer.home") / "FreeSurferColorLUT.txt"):
    p = line.split()
    if len(p) >= 2 and p[0].isdigit():
        LUT[int(p[0])] = p[1]
LUT.update({173: "Midbrain(sf)", 174: "Pons(sf)", 175: "Medulla(sf)", 178: "SCP(sf)"})
mimg = nib.load(wb.ST / "mask.nii.gz")
aff = mimg.affine
mask = np.asarray(mimg.dataobj) > 0
lab = np.asarray(nib.load(wb.ST / "labels_aparc_crop.nii.gz").dataobj).astype(int)
sfl = np.asarray(nib.load(wb.ST / "labels_subfields_crop.nii.gz").dataobj).astype(int)
lab2 = np.where(sfl > 0, sfl, lab)  # Subfield brainstem parts where present.
sh = mask.shape
# Approximate MNI from the affine alignment alone, valid also below the MNI152 grid.
M2 = np.loadtxt(wb.MNI / "template_to_mni_affine.txt") @ aff
_ijk = np.indices(sh).reshape(3, -1)
mni = list((M2 @ np.r_[_ijk, np.ones((1, _ijk.shape[1]))])[:3].reshape((3,) + sh))
# Every label but the cerebellum ends at the lowest template-medulla slice (22_roi.py).
z_floor = int(np.nonzero(mask & ~np.isin(lab, wb.CBLM))[2].min())
CLASSES = {"cortex": lambda lb, s: wb.ctx(lb) | np.isin(lb, (3, 42)),
           "cerebral_wm": lambda lb, s: np.isin(lb, wb.CWM) & (s == 0),
           "deep_gm": lambda lb, s: np.isin(lb, wb.DEEP) & (s == 0),
           "cerebellum": lambda lb, s: np.isin(lb, wb.CBLM) & (s == 0),
           "brainstem": lambda lb, s: (lb == 16) | (s > 0)}

ids = pd.read_csv(wb.DESIGN / "subjects.txt", header=None)[0].tolist()
f = config.participants().set_index("participant_id").loc[ids].reset_index()
data = np.asarray(nib.load(wb.DESIGN / "logjac_s4.nii.gz").dataobj)
assert data.shape[-1] == len(f)


def fitrow(frame, y, prefix):
    r = sl.fit(frame, y, "sci")
    return {f"{prefix}{k}": r[v] for k, v in (("n1", "n_grp1"), ("n0", "n_grp0"), ("d", "d"), ("d_lo", "d_lo"),
                                               ("d_hi", "d_hi"), ("pct", "pct"), ("t", "t"), ("p_param", "p_param"))}


rows, summ = [], []
for k, direction in ((1, "SCI > CTRL"), (2, "SCI < CTRL")):
    t = nib.load(wb.DESIGN / f"tstat{k}.nii.gz").get_fdata()
    cnt, pf = sl.pfwe_exact(wb.DESIGN, k)
    pf = np.where(mask, pf, 1.0)
    cnt = np.where(mask, cnt, 5000)
    p2 = np.minimum(1, 2 * pf)
    assert np.allclose(pf[mask], 1 - nib.load(wb.DESIGN / f"tfce_corrp_tstat{k}.nii.gz").get_fdata()[mask], atol=1e-5)
    # The n_vox_two_eq05 column counts ties at exactly P = 0.05 (count 125), which are not significant.
    summ.append(dict(direction=direction, n=len(f), n_sci=int(f.sci.sum()), min_pfwe_one=float(pf[mask].min()),
                     min_pfwe_two=float(p2[mask].min()), n_vox_two_lt05=int((2 * cnt[mask] < 250).sum()),
                     n_vox_two_eq05=int((2 * cnt[mask] == 250).sum()), n_vox_one_lt05=int((cnt[mask] < 250).sum()),
                     max_t=float(t[mask].max()), n_vox_mask=int(mask.sum())))
    sig = mask & (2 * cnt < 250)
    cl, n = ndimage.label(sig, structure=np.ones((3, 3, 3)))
    if n:
        order = np.argsort(-ndimage.sum(sig, cl, range(1, n + 1)))
        relab = np.zeros(n + 1, np.int16)
        relab[order + 1] = np.arange(1, n + 1)
        cl = relab[cl]
    wb.save(cl, wb.DESIGN / f"clusters_two_dir_{k}.nii.gz", np.int16, aff)
    for i in range(1, n + 1):
        m = cl == i
        ijk = np.array(np.nonzero(m))
        tv = t[m]
        pk = tuple(ijk[:, tv.argmax()])
        xyz = aff @ np.r_[pk, 1]
        labs, lcnt = np.unique(lab2[m], return_counts=True)
        o = np.argsort(-lcnt)[:4]
        comp = "; ".join(f"{LUT.get(int(labs[j]), labs[j])} {100 * lcnt[j] / m.sum():.0f}%" for j in o)
        row = dict(direction=direction, cluster=i, n_vox=int(m.sum()), vol_ml=m.sum() / 1000, peak_t=float(tv.max()),
                   min_pfwe_two=float(p2[m].min()), min_pfwe_one=float(pf[m].min()),
                   peak_x=xyz[0], peak_y=xyz[1], peak_z=xyz[2],
                   mni_x=float(mni[0][pk]), mni_y=float(mni[1][pk]), mni_z=float(mni[2][pk]),
                   peak_label=LUT.get(int(lab2[pk]), int(lab2[pk])), composition=comp,
                   mni_z_top=float(mni[2][m].max()), mni_z_bottom=float(mni[2][m].min()),
                   mm_above_mask_floor=int(ijk[2].min() - z_floor))
        for nm, fn in CLASSES.items():
            row[f"frac_{nm}"] = float(fn(lab[m], sfl[m]).mean())
        row["frac_medulla"] = float((sfl[m] == wb.MEDULLA).mean())
        row.update(fitrow(f, data[m].mean(0), "sel_"))
        rows.append(row)
pd.DataFrame(summ).to_csv(OUT / "voxel_summary.csv", index=False)
out = pd.DataFrame(rows)
out.to_csv(OUT / "voxel_clusters.csv", index=False)
print(pd.DataFrame(summ).round(4).to_string(index=False))
pd.set_option("display.width", 250)
pd.set_option("display.max_columns", 30)
if len(out):
    print(out[out.vol_ml >= 0.05][["direction", "cluster", "vol_ml", "peak_t", "min_pfwe_two", "mni_x", "mni_y",
                                   "mni_z", "frac_medulla", "mm_above_mask_floor", "sel_d", "sel_pct",
                                   "composition"]].round(3).to_string(index=False))
    print(f"Clusters under 0.05 mL (listed in the table only): {int((out.vol_ml < 0.05).sum())}.")
else:
    print("No clusters.")
