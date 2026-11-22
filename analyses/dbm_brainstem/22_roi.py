"""Template regions, regional log-Jacobians, registration QC, and the 4D input of the voxelwise test.

1. Template labels by majority vote over the template participants' warped labels: subfields
   (0, 173 midbrain, 174 pons, 175 medulla, 178 superior cerebellar peduncle) and aseg labels reduced
   to cerebellar cortex (1), cerebellar white matter (2), fourth ventricle (3), and Brain-Stem (4).
2. Analysis mask: the union of the subfield labels dilated by a 2 mm ball.
3. Per participant: total log-Jacobian = SyN warp log-Jacobian + log|det A| of the affine, and its
   unsmoothed mean over the medulla, pons, and midbrain; also the integrated Jacobian of the medulla
   (participant-space volume of the template medulla, mm3).
4. QC: Dice of the warped labels with the template labels, and the Pearson r of the warped T1 with the
   template inside the mask.
5. The total log-Jacobian smoothed at 4 mm FWHM, inside the mask's bounding box (+4 voxels), stacked in
   participant order (stats/stack_order.txt) for randomise.
Writes template/labels_*, template/brainstem_mask_dil2.nii.gz, stats/, roi_values.csv, and regqc.csv.
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd
from scipy import ndimage
from scipy.io import loadmat

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

ASEG_MAP = {8: 1, 47: 1, 7: 2, 46: 2, 15: 3, 16: 4}
SFL = (0, 173, 174, 175, 178)


def load(p, dt=np.float32):
    return np.asarray(nib.load(p).dataobj).astype(dt)


def save(arr, aff, path, dt):
    img = nib.Nifti1Image(arr.astype(dt), aff)
    img.set_qform(aff, 1)
    img.set_sform(aff, 1)
    nib.save(img, path)


def reduce_aseg(a):
    out = np.zeros(a.shape, np.uint8)
    for k, v in ASEG_MAP.items():
        out[a == k] = v
    return out


def log_det_affine(mat):
    m = loadmat(mat)
    key = [k for k in m if k.startswith("AffineTransform")][0]
    return float(np.log(abs(np.linalg.det(m[key][:9, 0].reshape(3, 3)))))


def dice(x, y):
    return float(2 * (x & y).sum() / (x.sum() + y.sum()))


def main():
    W = config.work_dir("dbm_brainstem")
    R, TD, ST = W / "reg", W / "template", W / "stats"
    ST.mkdir(exist_ok=True)
    subs = config.participants()
    tpl_img = nib.load(TD / "template_final.nii.gz")
    aff, shape = tpl_img.affine, tpl_img.shape
    tpl = tpl_img.get_fdata(dtype=np.float32)
    assert np.allclose(np.abs(np.linalg.det(aff[:3, :3])), 1.0, atol=1e-4)

    # 1. Majority vote over the template participants.
    tids = subs.participant_id[subs.dbm_template == 1].tolist()
    assert len(tids) == 32, f"Expected 32 template participants, found {len(tids)}."
    votes = np.zeros((len(SFL),) + shape, np.uint16)
    avotes = np.zeros((5,) + shape, np.uint16)
    for s in tids:
        b = load(R / f"{s}_bsl_w.nii.gz", np.int16)
        for i, lv in enumerate(SFL):
            votes[i] += b == lv
        a = reduce_aseg(load(R / f"{s}_aseg_w.nii.gz", np.int16))
        for i in range(5):
            avotes[i] += a == i
    lab = np.array(SFL, np.uint8)[votes.argmax(0)]
    alab = avotes.argmax(0).astype(np.uint8)
    del votes, avotes
    save(lab, aff, TD / "labels_subfields_majority.nii.gz", np.uint8)
    save(alab, aff, TD / "labels_aseg_majority.nii.gz", np.uint8)

    # 2. Analysis mask: Euclidean ball of radius 2 voxels (1 mm voxels).
    bs = lab > 0
    zz, yy, xx = np.indices((5, 5, 5)) - 2
    ball = (zz**2 + yy**2 + xx**2) <= 4
    mask = ndimage.binary_dilation(bs, structure=ball)
    save(mask, aff, TD / "brainstem_mask_dil2.nii.gz", np.uint8)
    rois = {"medulla": lab == 175, "pons": lab == 174, "midbrain": lab == 173}
    print({k: int(v.sum()) for k, v in rois.items()}, "mask", int(mask.sum()))

    ijk = np.array(np.nonzero(mask))
    lo, hi = np.maximum(ijk.min(1) - 4, 0), np.minimum(ijk.max(1) + 5, shape)
    sl = tuple(slice(a, b) for a, b in zip(lo, hi))
    caff = aff.copy()
    caff[:3, 3] = aff[:3, :3] @ lo + aff[:3, 3]
    save(mask[sl], caff, ST / "mask.nii.gz", np.uint8)
    for k, r in rois.items():
        save(r[sl], caff, ST / f"roi_{k}.nii.gz", np.uint8)
    save(tpl[sl], caff, ST / "template_crop.nii.gz", np.float32)
    save(lab[sl], caff, ST / "labels_crop.nii.gz", np.uint8)

    # 3 to 5. Per-participant values, QC, and the smoothed stack.
    sigma = 4.0 / np.sqrt(8 * np.log(2))  # FWHM 4 mm at 1 mm voxels.
    tvals = tpl[mask]
    rows, qrows, stack = [], [], []
    for s in subs.participant_id:
        ldA = log_det_affine(R / f"{s}_0GenericAffine.mat")
        lt = load(R / f"{s}_logjac_warp.nii.gz") + ldA
        row = dict(participant_id=s, logdetA=ldA)
        for k, r in rois.items():
            row[f"{k}_mlogj"] = float(lt[r].mean())
        row["medulla_intJ_mm3"] = float(np.exp(lt[rois["medulla"]]).sum())
        rows.append(row)
        b = load(R / f"{s}_bsl_w.nii.gz", np.int16)
        a = reduce_aseg(load(R / f"{s}_aseg_w.nii.gz", np.int16))
        q = dict(participant_id=s,
                 dice_medulla=dice(b == 175, lab == 175), dice_pons=dice(b == 174, lab == 174),
                 dice_midbrain=dice(b == 173, lab == 173), dice_brainstem=dice(b > 0, bs),
                 dice_cblm_ctx=dice(a == 1, alab == 1), dice_cblm_wm=dice(a == 2, alab == 2),
                 dice_4thvent=dice(a == 3, alab == 3))
        q["r_T1_mask"] = float(np.corrcoef(load(R / f"{s}_Warped.nii.gz")[mask], tvals)[0, 1])
        q["logjac_min"], q["logjac_max"] = float(lt[mask].min()), float(lt[mask].max())
        qrows.append(q)
        stack.append(ndimage.gaussian_filter(lt, sigma)[sl].astype(np.float32))
    pd.DataFrame(rows).to_csv(W / "roi_values.csv", index=False)
    pd.DataFrame(qrows).to_csv(W / "regqc.csv", index=False)
    save(np.stack(stack, axis=-1), caff, ST / "logjac_s4_all.nii.gz", np.float32)
    (ST / "stack_order.txt").write_text("\n".join(subs.participant_id) + "\n")
    print(f"Regional values and QC for {len(rows)} participants; 4D stack {len(stack)} volumes.")


if __name__ == "__main__":
    main()
