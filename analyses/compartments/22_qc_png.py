"""Group-blind QC pages of the atlas transfer: ROI outlines on the brainstem DBM template and on the
warped atlas reference T1s (axial slices through the medulla, midline sagittal, and coronal).

Axial slices are labeled in mm below the top of the template medulla label. Writes qc_rois_*.png in the
section's output folder.
"""

import sys
from pathlib import Path

import matplotlib as mpl

mpl.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import nibabel as nib  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

ROIS = [("R1_pyramid_t50", "#0072B2"), ("R2_olive_t50", "#009E73"), ("R3_dcn_region_t50", "#D55E00"),
        ("R4_tegmentum_rest_t50", "#CC79A7"), ("R5_icp_t50", "#E69F00")]
JHU = [("JHU_CST", "#56B4E9"), ("R1_pyramid_t50", "#0072B2")]
LEVELS = [4, 10, 16, 20, 24, 28, 32, 35]


def main():
    T = config.work_dir("dbm_brainstem") / "template"
    C = config.work_dir("compartments")
    FG = config.output_dir("compartments")
    t = nib.load(T / "template_final.nii.gz").get_fdata()
    ref = nib.load(C / "reg_ref/icbm09bsym_Warped.nii.gz").get_fdata()
    mni = nib.load(C / "reg_ref/mni152fsl_Warped.nii.gz").get_fdata()
    med = np.asarray(nib.load(T / "labels_subfields_majority.nii.gz").dataobj) == 175
    cache = {}

    def roi(n):
        if n not in cache:
            cache[n] = np.asarray(nib.load(C / f"rois/{n}.nii.gz").dataobj) > 0
        return cache[n]

    top = int(np.nonzero(med.any((0, 1)))[0].max())
    cx, cy = np.round(np.array(np.nonzero(med)).mean(1)[:2]).astype(int)
    xs, ys = slice(cx - 22, cx + 23), slice(cy - 22, cy + 23)

    def outline(a, bg, mslice, sets, getm):
        a.imshow(bg.T, origin="lower", cmap="gray")
        a.contour(mslice.T, [0.5], colors="w", linewidths=0.6, linestyles=":")
        for n, c in sets:
            m = getm(roi(n))
            if m.any():
                a.contour(m.T.astype(float), [0.5], colors=c, linewidths=1.1)
        a.set_xticks([])
        a.set_yticks([])

    def page(bg, sets, name, title):
        fig, ax = plt.subplots(2, 6, figsize=(18, 6.6))
        for i, mm in enumerate(LEVELS):
            k = top - mm
            outline(ax.flat[i], bg[xs, ys, k], med[xs, ys, k], sets, lambda m, k=k: m[xs, ys, k])
            ax.flat[i].set_title(f"{mm} mm below medulla top")
        for n, c in sets:
            ax.flat[8].plot([], [], color=c, label=n)
        ax.flat[8].plot([], [], color="k", ls=":", label="Template medulla (white dotted)")
        ax.flat[8].legend(loc="center", fontsize=8)
        ax.flat[8].axis("off")
        outline(ax.flat[9], bg[cx], med[cx], sets, lambda m: m[cx - 1:cx + 2].any(0))
        ax.flat[9].set_title("Sagittal, midline (+/-1 mm)")
        for q, off in ((10, -3), (11, 3)):
            yk = cy + off
            outline(ax.flat[q], bg[:, yk], med[:, yk], sets, lambda m, yk=yk: m[:, yk])
            ax.flat[q].set_title(f"Coronal, {off:+d} mm from medulla centre")
        fig.suptitle(title)
        fig.tight_layout()
        fig.savefig(FG / name, dpi=80)
        plt.close(fig)

    page(t, ROIS, "qc_rois_template.png", "Allen ROIs (threshold 0.5) on the study template")
    page(ref, ROIS, "qc_rois_icbm_warped.png", "Allen ROIs on the warped ICBM 2009b T1")
    page(t, JHU, "qc_rois_jhu_template.png", "JHU corticospinal tract and Allen pyramid on the study template")
    page(mni, JHU[:1], "qc_rois_jhu_mni_warped.png", "JHU corticospinal tract on the warped FSL MNI152 T1")


if __name__ == "__main__":
    main()
