"""Registration QC overlays for visual review of every participant.

Each participant's warped T1 in template space with template majority-label contours (mask outline yellow,
lateral ventricles red, subfield brainstem cyan, thalamus magenta) on the sagittal and coronal planes through the
brainstem centroid and the axial plane through the thalamus centroid; 12 panels per page, the template first.
Writes qc_png/ in the work folder (participant-level; not for publication).
"""

import sys
from pathlib import Path

import matplotlib
import nibabel as nib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
import dbmwb as wb  # noqa: E402

OUT = wb.W / "qc_png"
OUT.mkdir(exist_ok=True)
qc = pd.read_csv(wb.W / "regqc.csv").set_index("participant_id")
lab = np.asarray(nib.load(wb.TPL / "labels_aparc_majority.nii.gz").dataobj)
sfl = np.asarray(nib.load(wb.TPL / "labels_subfields_majority.nii.gz").dataobj)
mask = np.asarray(nib.load(wb.TPL / "mask_wholebrain.nii.gz").dataobj) > 0
tpl = nib.load(wb.TPL / "template_final.nii.gz").get_fdata()
bc = np.array(np.nonzero(sfl > 0)).mean(1).round().astype(int)
tc = np.array(np.nonzero(np.isin(lab, (10, 49)))).mean(1).round().astype(int)
C = {"mask": (mask, "#ffd400"), "vent": (np.isin(lab, wb.LATVENT), "#ff3030"), "bs": (sfl > 0, "#00e5ff"),
     "thal": (np.isin(lab, (10, 49)), "#ff40ff")}


def views(img):
    return [img[bc[0]].T, img[:, bc[1]].T, img[:, :, tc[2]].T]


def draw(axs, img, title):
    vmax = np.percentile(img[mask], 99.5) * 1.1
    for j, ax in enumerate(axs):
        ax.imshow(views(img)[j], origin="lower", cmap="gray", vmin=0, vmax=vmax)
        for m, col in C.values():
            v = views(m)[j]
            if v.any():
                ax.contour(v, levels=[0.5], colors=col, linewidths=0.5)
        ax.set_xticks([])
        ax.set_yticks([])
    axs[0].set_title(title, fontsize=8, loc="left")


ids = [None] + config.participants().participant_id.tolist()  # None is the template panel.
per = 12
for p in range(0, len(ids), per):
    fig, ax = plt.subplots(6, 6, figsize=(18, 17))
    for k in range(36):
        ax.flat[k].axis("off")
    for j, s in enumerate(ids[p:p + per]):
        axs = ax[j // 2, (j % 2) * 3:(j % 2) * 3 + 3]
        for a in axs:
            a.axis("on")
        if s is None:
            draw(axs, tpl, "study template")
        else:
            q = qc.loc[s]
            draw(axs, nib.load(wb.REG / f"{s}_Warped.nii.gz").get_fdata(),
                 f"{s}  ctx {q.dice_cortex:.2f} bs {q.dice_brainstem_sf:.2f} med {q.dice_medulla:.2f} "
                 f"r {q.r_T1_mask:.3f}")
    fig.tight_layout()
    fig.savefig(OUT / f"qc_page{p // per + 1:02d}.png", dpi=60)
    plt.close(fig)
    print(f"Page {p // per + 1}.", flush=True)
