"""Detailed segmentation QC montage of one participant (run by hand when a 03_seg_montage.py page is unclear).

The standard montage shows one sagittal slice at the GM + WM centroid, which in some heads falls in the
interhemispheric fissure, where medial cortex is thin and mostly CSF. This draws, from the same bias-corrected T1 and
classes (c1 > 0.5 red, c2 > 0.5 blue), sagittal slices 8 and 16 mm either side of the centroid, three coronal slices
through the upper brain, and three axial slices near the vertex. Writes qc_seg/seg_detail_<participant_id>.png.
Usage: 03b_seg_montage_detail.py PARTICIPANT_ID
"""

import sys

import matplotlib
import nibabel as nib
import numpy as np

import dartel_common as dc

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

pid = sys.argv[1]
sd = dc.seg_dir(pid)
img = nib.load(str(sd / f"m{pid}_T1w.nii"))
t1 = np.asarray(img.dataobj, dtype=np.float32)
g = np.asarray(nib.load(str(sd / f"c1{pid}_T1w.nii")).dataobj, dtype=np.float32)
w = np.asarray(nib.load(str(sd / f"c2{pid}_T1w.nii")).dataobj, dtype=np.float32)
vx = img.header.get_zooms()[:3]
bw = g + w
ci = np.round(np.argwhere(bw > 0.5).mean(0)).astype(int)
ztop = np.where((bw > 0.5).any((0, 1)))[0].max()
vmax = np.percentile(t1, 99.5)


def panel(ax, a, b, c, title):
    ax.imshow(a.T, cmap="gray", origin="lower", vmin=0, vmax=vmax, interpolation="nearest")
    ov = np.zeros(a.T.shape + (4,))
    ov[b.T > 0.5] = (1.0, 0.15, 0.1, 0.40)
    ov[c.T > 0.5] = (0.1, 0.45, 1.0, 0.40)
    ax.imshow(ov, origin="lower", interpolation="nearest")
    ax.set_title(title, fontsize=8)
    ax.axis("off")


fig, axes = plt.subplots(3, 4, figsize=(12, 9.5))
for i, mm in enumerate((-16, -8, 8, 16)):
    x = ci[0] + int(round(mm / vx[0]))
    panel(axes[0, i], t1[x], g[x], w[x], f"sagittal {abs(mm)} mm {'left' if mm < 0 else 'right'} of center")
for i, mm in enumerate((-30, 0, 30)):
    y = ci[1] + int(round(mm / vx[1]))
    panel(axes[1, i], t1[:, y], g[:, y], w[:, y], f"coronal {mm:+d} mm (anterior +)")
for i, mm in enumerate((10, 20, 30)):
    z = ztop - int(round(mm / vx[2]))
    panel(axes[2, i], t1[:, :, z], g[:, :, z], w[:, :, z], f"axial {mm} mm below the brain top")
x = ci[0]
panel(axes[1, 3], t1[x], g[x], w[x], "sagittal at center (as in the standard montage)")
axes[2, 3].axis("off")
fig.suptitle(f"{pid}: grey matter (red) and white matter (blue)", fontsize=11)
fig.tight_layout()
out = dc.WORK / "qc_seg" / f"seg_detail_{pid}.png"
out.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(out, dpi=80)
print("Wrote", out)
