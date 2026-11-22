"""Brainstem and cerebellum crops of the conformed FreeSurfer images, and the padded template reference.

Each participant's T1.mgz (1 mm), aseg, and brainstem subfield labels are cropped to one box set from
that participant's own labels (voxels of the RAS-reoriented conformed grid):
  superior = aseg Brain-Stem top + 10 mm; inferior = subfield medulla bottom - 28 mm;
  left and right = cerebellum (aseg 7, 8, 46, 47) extent +/- 6 mm;
  anterior = Brain-Stem anterior extent + 15 mm; posterior = cerebellum posterior extent - 6 mm.
The reference participant's crop is also written enlarged by 12 mm on every side (float32); it is the
grid and rigid pose reference of the template (10_template.sh). Writes crop/ and template/ref_pad.nii.gz.
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

CEREB = (7, 8, 46, 47)
MIN_GAP_MM = 28
REF_PAD_MM = 12


def subfield_labels(pid):
    return config.path("freesurfer.brainstem_subfields_dir") / pid / "brainstemSsLabels.FSvoxelSpace.mgz"


def ext(mask):
    ijk = np.array(np.nonzero(mask))
    return ijk.min(1), ijk.max(1)


def load_canonical(pid):
    fs = config.path("freesurfer.subjects_dir") / pid / "mri"
    t1 = nib.as_closest_canonical(nib.load(fs / "T1.mgz"))
    aseg = nib.as_closest_canonical(nib.load(fs / "aseg.mgz"))
    bsl = nib.as_closest_canonical(nib.load(subfield_labels(pid)))
    aff = t1.affine
    assert np.allclose(aseg.affine, aff) and np.allclose(bsl.affine, aff)
    # Canonical conformed space: axes R, A, S with unit spacing and no rotation.
    assert np.allclose(np.abs(aff[:3, :3]), np.eye(3), atol=1e-5), aff
    return t1, np.asarray(aseg.dataobj), np.asarray(bsl.dataobj)


def box(A, Bl, shape, pad=0):
    bs_lo, bs_hi = ext(A == 16)
    cb_lo, cb_hi = ext(np.isin(A, CEREB))
    md_lo, _ = ext(Bl == 175)
    lo = np.array([cb_lo[0] - 6, cb_lo[1] - 6, md_lo[2] - 28]) - pad
    hi = np.array([cb_hi[0] + 6, bs_hi[1] + 15, bs_hi[2] + 10]) + pad
    return np.maximum(lo, 0), np.minimum(hi, np.array(shape) - 1)


def save(arr, aff, lo, path):
    naff = aff.copy()
    naff[:3, 3] = aff[:3, :3] @ lo + aff[:3, 3]
    img = nib.Nifti1Image(arr, naff)
    img.set_qform(naff, 1)
    img.set_sform(naff, 1)
    nib.save(img, path)


def main():
    W = config.work_dir("dbm_brainstem")
    out = W / "crop"
    out.mkdir(exist_ok=True)
    fov = config.read_private(W / "fov_check.csv")
    if (fov.gap_medulla_to_data_mm < MIN_GAP_MM).any():
        raise SystemExit(f"{int((fov.gap_medulla_to_data_mm < MIN_GAP_MM).sum())} participants have less than "
                         f"{MIN_GAP_MM} mm of image below the medulla (fov_check.csv).")
    pids = config.participants().participant_id.tolist()
    for pid in pids:
        t1, A, Bl = load_canonical(pid)
        lo, hi = box(A, Bl, t1.shape)
        sl = tuple(slice(a, b + 1) for a, b in zip(lo, hi))
        assert (Bl[sl] == 175).sum() == (Bl == 175).sum() and (A[sl] == 16).sum() == (A == 16).sum()
        T = np.asarray(t1.dataobj)[sl]
        for name, arr, dt in (("T1", T, np.uint8), ("aseg", A[sl], np.int16), ("bsl", Bl[sl], np.uint8)):
            save(arr.astype(dt), t1.affine, lo, out / f"{pid}_{name}.nii.gz")
    ref = str(config.get("dbm_brainstem.reference_participant"))
    t1, A, Bl = load_canonical(ref)
    lo, hi = box(A, Bl, t1.shape, pad=REF_PAD_MM)
    sl = tuple(slice(a, b + 1) for a, b in zip(lo, hi))
    (W / "template").mkdir(exist_ok=True)
    save(np.asarray(t1.dataobj)[sl].astype(np.float32), t1.affine, lo, W / "template/ref_pad.nii.gz")
    print(f"Cropped {len(pids)} participants; padded reference written.")


if __name__ == "__main__":
    main()
