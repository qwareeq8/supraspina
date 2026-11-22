"""Normalization QC montages (rated by eye; the PNGs name participants and stay in the work folder).

For each participant: modulated gray matter (mwc1, FWHM 0) beside the sample mean at five axial levels and x = 0,
and modulated white matter (mwc2) beside its mean at brainstem levels and x = 0, since the main DARTEL measure is
the medulla. Existing PNGs are kept unless FORCE=1.
"""

import os

import matplotlib
import nibabel as nib
import numpy as np

import dartel_common as dc

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

OUT = dc.WORK / "qc_norm"
OUT.mkdir(parents=True, exist_ok=True)
force = os.environ.get("FORCE") == "1"
m1 = nib.load(str(dc.OUT / "maps/mean_mwc1_fwhm0.nii.gz"))
inv = np.linalg.inv(m1.affine)
mean1 = np.asarray(m1.dataobj, np.float32)
mean2 = np.asarray(nib.load(str(dc.OUT / "maps/mean_mwc2_fwhm0.nii.gz")).dataobj, np.float32)
v1max = np.percentile(mean1[mean1 > 0.1], 99.5) * 1.3
v2max = np.percentile(mean2[mean2 > 0.1], 99.5) * 1.3
AXIS = {"sag": 0, "cor": 1, "ax": 2}


def cut(v, plane, mm):
    p = np.zeros(4)
    p[AXIS[plane]], p[3] = mm, 1
    i = int(np.round(inv @ p)[AXIS[plane]])
    return np.take(v, i, axis=AXIS[plane]).T


n = 0
for pid in dc.ids():
    fn = OUT / f"norm_{pid}.png"
    if fn.exists() and not force:
        continue
    g = dc.load(dc.mni("mwc1_fwhm0", pid))
    w = dc.load(dc.mni("mwc2_fwhm0", pid))
    fig, ax = plt.subplots(4, 6, figsize=(12, 8.8))
    for k, z in enumerate([-30, -10, 10, 30, 50]):
        ax[0, k].imshow(cut(g, "ax", z), origin="lower", cmap="gray", vmin=0, vmax=v1max)
        ax[0, k].set_title(f"{pid} GM z={z}", fontsize=7)
        ax[1, k].imshow(cut(mean1, "ax", z), origin="lower", cmap="gray", vmin=0, vmax=v1max)
        ax[1, k].set_title(f"mean GM z={z}", fontsize=7)
    for k, z in enumerate([-66, -60, -50, -40, -25]):
        ax[2, k].imshow(cut(w, "ax", z), origin="lower", cmap="gray", vmin=0, vmax=v2max)
        ax[2, k].set_title(f"{pid} WM z={z}", fontsize=7)
        ax[3, k].imshow(cut(mean2, "ax", z), origin="lower", cmap="gray", vmin=0, vmax=v2max)
        ax[3, k].set_title(f"mean WM z={z}", fontsize=7)
    for r, (v, vm, t) in enumerate([(g, v1max, "GM"), (mean1, v1max, "mean GM"), (w, v2max, "WM"),
                                    (mean2, v2max, "mean WM")]):
        ax[r, 5].imshow(cut(v, "sag", 0), origin="lower", cmap="gray", vmin=0, vmax=vm)
        ax[r, 5].set_title(f"{t} x=0", fontsize=7)
    for a in ax.ravel():
        a.axis("off")
    fig.tight_layout(pad=0.3)
    fig.savefig(fn, dpi=80)
    plt.close(fig)
    n += 1
print(f"Normalization montages written: {n}.")
