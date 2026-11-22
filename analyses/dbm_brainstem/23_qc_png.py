"""Registration QC pages for the visual review (private, participant level).

Each participant's warped T1 in template space with the template region contours (midbrain red, pons
yellow, medulla cyan) on a midsagittal, a coronal, and an axial slice through the medulla center, 12
participants per page, with the template first. Writes qc_png/ in the section's work folder.
"""

import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import nibabel as nib  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

COLS = {173: "#d62728", 174: "#ffbf00", 175: "#17becf"}
PER_PAGE = 12


def main():
    W = config.work_dir("dbm_brainstem")
    out = W / "qc_png"
    out.mkdir(exist_ok=True)
    qc = config.read_private(W / "regqc.csv").set_index("participant_id")
    lab = np.asarray(nib.load(W / "template/labels_subfields_majority.nii.gz").dataobj)
    tpl = nib.load(W / "template/template_final.nii.gz").get_fdata()
    c = np.array(np.nonzero(lab == 175)).mean(1).round().astype(int)
    cx = int(round(np.array(np.nonzero(lab > 0))[0].mean()))

    def views(img):
        return [img[cx].T, img[:, c[1]].T, img[:, :, c[2]].T]

    def draw(axs, img, title):
        for ax, v, lv in zip(axs, views(img), views(lab)):
            ax.imshow(v, origin="lower", cmap="gray", vmin=0, vmax=np.percentile(img[lab > 0], 99.5) * 1.2)
            for lval, col in COLS.items():
                if (lv == lval).any():
                    ax.contour(lv == lval, levels=[0.5], colors=col, linewidths=0.7)
            ax.set_xticks([])
            ax.set_yticks([])
        axs[0].set_title(title, fontsize=8, loc="left")

    ids = ["TEMPLATE"] + config.participants().participant_id.tolist()
    for p in range(0, len(ids), PER_PAGE):
        fig, ax = plt.subplots(6, 6, figsize=(15, 16))
        for a in ax.flat:
            a.axis("off")
        for j, s in enumerate(ids[p:p + PER_PAGE]):
            axs = ax[j // 2, (j % 2) * 3:(j % 2) * 3 + 3]
            for a in axs:
                a.axis("on")
            if s == "TEMPLATE":
                draw(axs, tpl, "Study template")
            else:
                q = qc.loc[s]
                draw(axs, nib.load(W / f"reg/{s}_Warped.nii.gz").get_fdata(),
                     f"{s}  Dice med {q.dice_medulla:.2f} pons {q.dice_pons:.2f} mid {q.dice_midbrain:.2f}  "
                     f"r {q.r_T1_mask:.3f}")
        fig.tight_layout()
        fig.savefig(out / f"qc_page{p // PER_PAGE + 1:02d}.png", dpi=55)
        plt.close(fig)
    print(f"QC pages written: {(len(ids) + PER_PAGE - 1) // PER_PAGE}")


if __name__ == "__main__":
    main()
