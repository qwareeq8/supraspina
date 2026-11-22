"""Binary maps of the atlas labels used by the compartment ROIs, on their own atlas grids.

Allen Human Reference Atlas 3D (ICBM 2009b space): medullary pyramid (12535), medullary tegmentum
(12538), inferior olive (12600), and inferior cerebellar peduncle (12741), cropped to a brainstem box
(world mm x -35 to 35, y -75 to -5, z -72 to -5); superior (12292) and inferior (12305) colliculi on the
full grid. JHU ICBM-DTI-81 (FSL MNI152 1 mm): corticospinal tract (labels 7 and 8), same box.
Group-blind. Usage: 20_split_labels.py <out_dir>; writes <tag>_<name>_src.nii.gz (float32, 0 or 1).
"""

import os
import sys
from pathlib import Path

import nibabel as nib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

BOX = ((-35, 35), (-75, -5), (-72, -5))
ALLEN_BOX = dict(MoPy=[12535], MoTg=[12538], IO=[12600], icp=[12741])
ALLEN_FULL = dict(SC=[12292], IC=[12305])
JHU_BOX = dict(CST=[7, 8])


def split(src, labels, tag, out, box=None):
    img = nib.load(src)
    a = np.asarray(img.dataobj)
    A = img.affine
    if box is None:
        sl, aff = (slice(None),) * 3, A
    else:
        c = np.array([[x, y, z] for x in box[0] for y in box[1] for z in box[2]])
        ijk = (np.linalg.inv(A) @ np.c_[c, np.ones(len(c))].T)[:3]
        lo = np.maximum(np.floor(ijk.min(1)).astype(int), 0)
        hi = np.minimum(np.ceil(ijk.max(1)).astype(int), np.array(a.shape) - 1)
        sl = tuple(slice(p, q + 1) for p, q in zip(lo, hi))
        aff = A.copy()
        aff[:3, 3] = A[:3, :3] @ lo + A[:3, 3]
    for name, codes in labels.items():
        m = np.isin(a[sl], codes).astype(np.float32)
        print(tag, name, "voxels", int(m.sum()))
        nib.save(nib.Nifti1Image(m, aff), Path(out) / f"{tag}_{name}_src.nii.gz")


def main():
    os.environ.setdefault("FSLDIR", str(config.path("software.fsl_dir")))
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    allen = config.path("atlases.allen_hra3d")
    split(allen, ALLEN_BOX, "allen", out, BOX)
    split(allen, ALLEN_FULL, "allen", out)
    split(config.path("atlases.jhu_labels"), JHU_BOX, "jhu", out, BOX)


if __name__ == "__main__":
    main()
