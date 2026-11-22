"""Segmentation QC montages (rated by eye; the PNGs name participants and stay in the work folder).

For each participant, four native-space slices of the bias-corrected T1 with gray matter (c1 > 0.5, red) and white
matter (c2 > 0.5, blue) filled at 40% opacity: mid-sagittal, coronal, and axial through the GM + WM centroid, and an
axial slice 25 mm lower (temporal lobes, cerebellum). Eight participants per PNG, in participant_id order; a page is
drawn when all its participants are segmented and the PNG is absent (FORCE=1 redraws).
Usage: 03_seg_montage.py [participant_id ...]  draws only the given participants, as seg_selected.png.
"""

import os
import sys

import matplotlib
import nibabel as nib
import numpy as np

import dartel_common as dc

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

OUT = dc.WORK / "qc_seg"
OUT.mkdir(parents=True, exist_ok=True)
force = os.environ.get("FORCE") == "1"


def panel(ax, t1, g, w, title, vmax):
    ax.imshow(t1.T, cmap="gray", origin="lower", vmin=0, vmax=vmax, interpolation="nearest")
    ov = np.zeros(t1.T.shape + (4,))
    ov[g.T > 0.5] = (1.0, 0.15, 0.1, 0.40)
    ov[w.T > 0.5] = (0.1, 0.45, 1.0, 0.40)
    ax.imshow(ov, origin="lower", interpolation="nearest")
    ax.set_title(title, fontsize=7)
    ax.axis("off")


def done(pid):
    return (dc.seg_dir(pid) / "SEG_DONE").exists()


if sys.argv[1:]:
    jobs = [(OUT / "seg_selected.png", sys.argv[1:])]
else:
    ids = dc.processed_ids()
    jobs = []
    for b in range(0, len(ids), 8):
        chunk = ids[b:b + 8]
        fn = OUT / f"seg_{b // 8 + 1:02d}.png"
        if all(done(p) for p in chunk) and (force or not fn.exists()):
            jobs.append((fn, chunk))
for fn, chunk in jobs:
    fig, axes = plt.subplots(len(chunk), 4, figsize=(9, 2.3 * len(chunk)), squeeze=False)
    for r, pid in enumerate(chunk):
        sd = dc.seg_dir(pid)
        im = nib.load(str(sd / f"m{pid}_T1w.nii"))
        t1 = np.asarray(im.dataobj, dtype=np.float32)
        g = np.asarray(nib.load(str(sd / f"c1{pid}_T1w.nii")).dataobj, dtype=np.float32)
        w = np.asarray(nib.load(str(sd / f"c2{pid}_T1w.nii")).dataobj, dtype=np.float32)
        bw = g + w
        idx = np.indices(bw.shape).reshape(3, -1)
        x, y, z = np.round((idx * bw.reshape(-1)).sum(1) / bw.sum()).astype(int)
        # Voxel axis 0 is left-right in these crops, so slice x is the brain midline.
        zlow = max(0, z - int(round(25 / im.header.get_zooms()[2])))
        vmax = np.percentile(t1, 99.5) + 1e-6
        panel(axes[r, 0], t1[x], g[x], w[x], f"{pid} sag", vmax)
        panel(axes[r, 1], t1[:, y], g[:, y], w[:, y], "cor", vmax)
        panel(axes[r, 2], t1[:, :, z], g[:, :, z], w[:, :, z], "ax", vmax)
        panel(axes[r, 3], t1[:, :, zlow], g[:, :, zlow], w[:, :, zlow], "ax -25 mm", vmax)
    fig.tight_layout(pad=0.3)
    fig.savefig(fn, dpi=90)
    plt.close(fig)
print(f"Segmentation montages written: {len(jobs)}.")
