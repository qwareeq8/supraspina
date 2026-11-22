"""Prepare each participant's whole-brain DBM inputs from the conformed 1 mm FreeSurfer image.

T1.mgz inside (brainmask or a brainstem-cord column), reoriented to RAS, cropped to the mask bounding box + 3 mm,
uint8; aparc+aseg and the brainstem subfield labels on the same grid. The column holds the voxels within 12 mm
(axial plane) of the least-squares line x(z), y(z) through the per-slice centroids of the participant's subfield
medulla, from 25 mm below to 12 mm above the lowest medulla voxel, so the caudal medulla is not cut by the
brainmask. Writes prep/<id>_{T1,aparc,bsl,mask}.nii.gz and prep_geom.csv. Usage: 02_prep.py [id ...]
"""

import sys
from multiprocessing import Pool
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
import dbmwb as wb  # noqa: E402

FS = config.path("freesurfer.subjects_dir")
R, BELOW, ABOVE, MARGIN = 12.0, 25, 12, 3


def canon(p):
    return nib.as_closest_canonical(nib.load(p))


def one(sid):
    d = FS / sid
    t1 = canon(d / "mri/T1.mgz")
    aff = t1.affine
    assert np.allclose(np.abs(aff[:3, :3]), np.eye(3), atol=1e-5), aff
    bm = np.asarray(canon(d / "mri/brainmask.mgz").dataobj) > 0
    ap = canon(d / "mri/aparc+aseg.mgz")
    bl = canon(wb.subfield_labels(sid))
    assert np.allclose(ap.affine, aff) and np.allclose(bl.affine, aff)
    A = np.asarray(ap.dataobj)
    Bl = np.asarray(bl.dataobj)
    ii, jj, kk = np.nonzero(Bl == wb.MEDULLA)
    zs = np.unique(kk)
    cx = np.array([ii[kk == z].mean() for z in zs])
    cy = np.array([jj[kk == z].mean() for z in zs])
    px = np.polyfit(zs, cx, 1)
    py = np.polyfit(zs, cy, 1)
    zlo = int(zs.min())
    col = np.zeros(bm.shape, bool)
    I, J = np.meshgrid(np.arange(bm.shape[0]), np.arange(bm.shape[1]), indexing="ij")
    for z in range(max(zlo - BELOW, 0), min(zlo + ABOVE, bm.shape[2] - 1) + 1):
        col[:, :, z] = (I - np.polyval(px, z)) ** 2 + (J - np.polyval(py, z)) ** 2 <= R * R
    m = bm | col
    ijk = np.array(np.nonzero(m))
    lo = np.maximum(ijk.min(1) - MARGIN, 0)
    hi = np.minimum(ijk.max(1) + MARGIN, np.array(m.shape) - 1)
    sl = tuple(slice(a, b + 1) for a, b in zip(lo, hi))
    naff = aff.copy()
    naff[:3, 3] = aff[:3, :3] @ lo + aff[:3, 3]
    img_arr = np.where(m, np.asarray(t1.dataobj), 0)[sl]
    for name, arr, dt in (("T1", img_arr, np.uint8), ("aparc", A[sl], np.int16), ("bsl", Bl[sl], np.uint8),
                          ("mask", m[sl], np.uint8)):
        wb.save(arr, wb.PREP / f"{sid}_{name}.nii.gz", dt, naff)
    # No label except extracerebral CSF (24, which FreeSurfer 8 labels beyond the brainmask) may fall outside the crop.
    nz = (A > 0) & (A != 24)
    assert nz[sl].sum() == nz.sum() and (Bl[sl] > 0).sum() == (Bl > 0).sum(), sid
    csf_lost = int((A == 24).sum() - (A[sl] == 24).sum())
    return dict(participant_id=sid, nx=img_arr.shape[0], ny=img_arr.shape[1], nz=img_arr.shape[2],
                med_zlo=zlo, axis_slope_x=px[0], axis_slope_y=py[0], col_only_vox=int((col & ~bm).sum()),
                mask_vox=int(m.sum()), brainmask_vox=int(bm.sum()), csf24_outside_crop=csf_lost,
                tissue_outside_brainmask=int((nz & ~bm).sum()), tissue_outside_mask=int((nz & ~m).sum()))


if __name__ == "__main__":
    wb.PREP.mkdir(exist_ok=True)
    ids = sys.argv[1:] or config.participants().participant_id.tolist()
    with Pool(min(int(config.get("software.threads")), len(ids))) as pool:
        rows = pool.map(one, ids)
    g = pd.DataFrame(rows)
    gp = wb.W / "prep_geom.csv"
    if sys.argv[1:] and gp.exists():  # A partial rerun replaces only its own rows.
        g = pd.concat([pd.read_csv(gp)[lambda x: ~x.participant_id.isin(g.participant_id)], g])
    g.sort_values("participant_id").to_csv(gp, index=False)
    print(f"Prepared {len(rows)} participants.")
    print(g.drop(columns="participant_id").describe().T.round(2).to_string())
