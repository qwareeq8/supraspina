"""Template labels, analysis mask, per-participant ROI values and registration QC, and the 4D voxelwise input.

Uses no group variable.
1. Majority labels in template space over the dbm_template participants: aparc+aseg (every label value,
   including 0) and the brainstem subfields (0, 173, 174, 175, 178).
2. Mask: cortical, white matter, deep gray, cerebellar, and brainstem labels (ventricles and CSF excluded); every
   label but the cerebellum ends at the lowest template-medulla slice; largest 26-connected component.
3. Per participant: total log-Jacobian = SyN warp log-Jacobian + log|det A| of the affine, and its unsmoothed
   mean over the template medulla, pons, midbrain, and whole subfield brainstem (roi_values.csv).
4. QC: Dice of the warped labels with the majority labels and the Pearson r of the warped T1 with the template
   inside the mask (regqc.csv).
5. Total log-Jacobian smoothed at FWHM 4 mm by normalized convolution inside the mask, cropped to the mask
   bounding box + 3 voxels, stacked in participant order (stats/logjac_s4_all.nii.gz).
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

load, save = wb.load, wb.save
wb.ST.mkdir(exist_ok=True)
subs = config.participants()
tpl_img = nib.load(wb.TPL / "template_final.nii.gz")
aff, shp = tpl_img.affine, tpl_img.shape
tpl = tpl_img.get_fdata(dtype=np.float32)
assert np.allclose(aff[:3, :3], np.eye(3), atol=1e-4), aff  # 1 mm RAS, so the z index runs superior.

# 1. Majority vote over the template participants.
tids = wb.template_ids(subs)
stack = np.stack([load(wb.REG / f"{s}_aparc_w.nii.gz", np.int16) for s in tids])
best_n = np.zeros(shp, np.uint8)
best_l = np.zeros(shp, np.int16)
for lv in np.unique(stack):
    n = (stack == lv).sum(0, dtype=np.uint8)
    upd = n > best_n
    best_n[upd] = n[upd]
    best_l[upd] = lv
lab = best_l
del stack
sst = np.stack([load(wb.REG / f"{s}_bsl_w.nii.gz", np.int16) for s in tids])
SFL = np.array(wb.SUBFIELDS)
sfl = SFL[np.stack([(sst == lv).sum(0) for lv in SFL]).argmax(0)].astype(np.uint8)
del sst
save(lab, wb.TPL / "labels_aparc_majority.nii.gz", np.int16, aff)
save(sfl, wb.TPL / "labels_subfields_majority.nii.gz", np.uint8, aff)
print(f"Majority labels from {len(tids)} template participants: {len(np.unique(lab))} aparc labels, mean winning "
      f"fraction in brain {float((best_n[lab > 0] / len(tids)).mean()):.3f}.")

# 2. Analysis mask.
tissue = wb.ctx(lab) | np.isin(lab, wb.TISSUE_EXTRA) | (sfl > 0)
zmed = int(np.nonzero(sfl == wb.MEDULLA)[2].min())
below = np.zeros(shp, bool)
below[:, :, :zmed] = True
cblm = np.isin(lab, wb.CBLM)
n_cut = int((tissue & below & ~cblm).sum())
tissue &= ~(below & ~cblm)
cc, ncc = ndimage.label(tissue, structure=np.ones((3, 3, 3)))
sizes = ndimage.sum(tissue, cc, range(1, ncc + 1))
mask = cc == (1 + int(np.argmax(sizes)))
print(f"Mask voxels {int(mask.sum())}; removed below the medulla bottom (z index {zmed}) {n_cut}; "
      f"components {ncc}, dropped {int(tissue.sum() - mask.sum())} voxels in the others.")
save(mask, wb.TPL / "mask_wholebrain.nii.gz", np.uint8, aff)

ROIS = {"medulla": sfl == wb.MEDULLA, "pons": sfl == 174, "midbrain": sfl == 173, "brainstem_sf": sfl > 0}
ROIS = {k: v & mask for k, v in ROIS.items()}
print("ROI voxels", {k: int(v.sum()) for k, v in ROIS.items()})

# Cropped grid of the voxelwise analysis: the mask bounding box + 3 voxels.
ijk = np.array(np.nonzero(mask))
lo = np.maximum(ijk.min(1) - 3, 0)
hi = np.minimum(ijk.max(1) + 4, shp)
sl = tuple(slice(a, b) for a, b in zip(lo, hi))
caff = aff.copy()
caff[:3, 3] = aff[:3, :3] @ lo + aff[:3, 3]
save(mask[sl], wb.ST / "mask.nii.gz", np.uint8, caff)
save(tpl[sl], wb.ST / "template_crop.nii.gz", np.float32, caff)
save(lab[sl], wb.ST / "labels_aparc_crop.nii.gz", np.int16, caff)
save(sfl[sl], wb.ST / "labels_subfields_crop.nii.gz", np.uint8, caff)
(wb.ST / "crop_offset.txt").write_text(" ".join(map(str, lo)) + "\n")

sigma = 4.0 / np.sqrt(8 * np.log(2))  # FWHM 4 mm at 1 mm voxels.
mf = mask.astype(np.float32)
den = ndimage.gaussian_filter(mf, sigma)
tvals = tpl[mask]
DSETS = {"cortex": lambda a, b: wb.ctx(a), "cerebral_wm": lambda a, b: np.isin(a, wb.CWM),
         "cblm_ctx": lambda a, b: np.isin(a, (8, 47)), "cblm_wm": lambda a, b: np.isin(a, (7, 46)),
         "thalamus_L": lambda a, b: a == 10, "thalamus_R": lambda a, b: a == 49,
         "brainstem_sf": lambda a, b: b > 0, "medulla": lambda a, b: b == wb.MEDULLA,
         "lat_vent": lambda a, b: np.isin(a, wb.LATVENT)}
tref = {k: f(lab, sfl) for k, f in DSETS.items()}
rows, qrows = [], []
arr = np.zeros(tuple(hi - lo) + (len(subs),), np.float32)
for i, s in enumerate(subs.participant_id):
    ldA = wb.log_det_affine(wb.REG / f"{s}_0GenericAffine.mat")
    lt = load(wb.REG / f"{s}_logjac_warp.nii.gz") + ldA
    row = dict(participant_id=s, logdetA=ldA)
    for k, r in ROIS.items():
        row[f"{k}_mlogj"] = float(lt[r].mean())
    rows.append(row)
    a = load(wb.REG / f"{s}_aparc_w.nii.gz", np.int16)
    b = load(wb.REG / f"{s}_bsl_w.nii.gz", np.int16)
    q = dict(participant_id=s)
    for k, f in DSETS.items():
        x, y = f(a, b), tref[k]
        q[f"dice_{k}"] = float(2 * (x & y).sum() / (x.sum() + y.sum()))
    q["r_T1_mask"] = float(np.corrcoef(load(wb.REG / f"{s}_Warped.nii.gz")[mask], tvals)[0, 1])
    q["logjac_min"] = float(lt[mask].min())
    q["logjac_max"] = float(lt[mask].max())
    q["finite"] = bool(np.isfinite(lt).all())
    qrows.append(q)
    sm = np.where(mask, ndimage.gaussian_filter(lt * mf, sigma) / np.maximum(den, 1e-6), 0).astype(np.float32)
    arr[..., i] = sm[sl]
    print(f"{i + 1}/{len(subs)}", flush=True)
pd.DataFrame(rows).to_csv(wb.W / "roi_values.csv", index=False)
pd.DataFrame(qrows).to_csv(wb.W / "regqc.csv", index=False)
save(arr, wb.ST / "logjac_s4_all.nii.gz", np.float32, caff)
print("4D", arr.shape, "mask voxels", int(mask[sl].sum()))
