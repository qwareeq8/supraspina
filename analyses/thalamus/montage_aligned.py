"""QC montage of one code after removing head rotation.

montage.py slices norm.mgz in voxel space, so a rotated head makes the coronal and axial panels cut the two thalami
at different positions. This draws the same montage after resampling norm (linear), aseg, and the nuclei (nearest
neighbor) into a 1 mm grid whose axes follow the rotation part of the participant's talairach.xfm, centered on the
aseg thalamus. Writes qc/montages/<code>_aligned.png.
Usage: montage_aligned.py CODE [ALPHA]   (overlay opacity, default 0.45 as in montage.py)
"""

import sys

import nibabel as nib
import numpy as np
import pandas as pd
from scipy.ndimage import affine_transform

import montage as m
import thalamus_common as tc

code = sys.argv[1]
ALPHA = float(sys.argv[2]) if len(sys.argv) > 2 else 0.45
sid = pd.read_csv(tc.KEY, sep="\t").set_index("code").loc[code, "participant_id"]
X = np.loadtxt([ln.rstrip(";") for ln in (m.SD / sid / "mri/transforms/talairach.xfm").read_text().splitlines()
                if ln.strip() and ln.strip()[0] in "-0123456789"][-3:])
u, _, vt = np.linalg.svd(X[:, :3])
R = u @ vt  # Nearest rotation to the affine part.
print("Rotation from scanner axes, degrees:", np.round(np.degrees(np.arccos(np.clip(np.diag(R), -1, 1))), 1))

ref = nib.as_closest_canonical(nib.load(str(m.SD / sid / "mri/aseg.mgz")))
thal = np.isin(np.asarray(ref.dataobj), [10, 49])
c = (ref.affine @ np.r_[np.argwhere(thal).mean(0), 1])[:3]
N = 128
o = R @ c - N / 2  # Grid origin in aligned space.
A = np.linalg.inv(ref.affine)
M = A[:3, :3] @ R.T
off = M @ o + A[:3, 3]


def aligned(path):
    img = nib.as_closest_canonical(nib.load(str(path)))
    assert np.allclose(img.affine, ref.affine)
    lab = "norm" not in path.name
    return affine_transform(np.asarray(img.dataobj, dtype=np.float32), M, off, output_shape=(N,) * 3,
                            order=0 if lab else 1, mode="constant").astype(np.int32 if lab else np.float32)


m.one(sid, f"{code}_aligned", reader=aligned, alpha=ALPHA)
print("Wrote", m.MONT / f"{code}_aligned.png")
