"""Blind QC montages of the thalamic nuclei, one PNG per participant under a random code.

For each participant with outputs: norm.mgz with the nuclei colored by the six groups (alpha 0.45) and the aseg
thalamus outline (white), in RAS orientation, neurological convention (left on the left). Panels: three coronal,
three axial, and two sagittal (one through each thalamus). Codes come from a seeded random permutation and are
written to qc/qc_key.tsv, which is opened only after every montage has been rated. Participants added later get
the next codes in random order. Existing montages are kept.
Usage: montage.py
"""

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import nibabel as nib  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib.colors import ListedColormap  # noqa: E402

import thalamus_common as tc  # noqa: E402
from thalamus_common import config  # noqa: E402

SD = config.path("freesurfer.subjects_dir")
MONT = tc.QC / "montages"
LUT = config.path("freesurfer.home") / "FreeSurferColorLUT.txt"
SEED = 16707
# Okabe-Ito colors, one per group.
COLORS = ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#CC79A7"]
NUC2G = {n: i + 1 for i, (g, ns) in enumerate(tc.GROUPS.items()) for n in ns}


def lut_ids():
    ids = {}
    for line in LUT.read_text().splitlines():
        p = line.split()
        if len(p) >= 2 and p[0].isdigit() and 8100 <= int(p[0]) < 8300:
            nuc = p[1].split("-", 1)[1]
            if nuc in NUC2G:
                ids[int(p[0])] = NUC2G[nuc]
    return ids


ID2G = lut_ids()


def key_table(subjects):
    if tc.KEY.exists():
        k = pd.read_csv(tc.KEY, sep="\t")
        add = [s for s in subjects if s not in set(k.participant_id)]
        if add:
            rng = np.random.default_rng(SEED + len(k))
            nums = len(k) + 1 + rng.permutation(len(add))
            k = pd.concat([k, pd.DataFrame({"participant_id": add, "code": [f"P{i:02d}" for i in nums]})],
                          ignore_index=True)
            k.to_csv(tc.KEY, sep="\t", index=False)
        return k
    tc.QC.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(SEED)
    codes = [f"P{i:02d}" for i in rng.permutation(np.arange(1, len(subjects) + 1))]
    k = pd.DataFrame({"participant_id": subjects, "code": codes})
    k.to_csv(tc.KEY, sep="\t", index=False)
    return k


def canon(path):
    img = nib.as_closest_canonical(nib.load(str(path)))
    return np.asarray(img.dataobj)


def panel(ax, bg, grp, thal, title, vlim, alpha=0.45):
    ax.imshow(bg.T, origin="lower", cmap="gray", vmin=vlim[0], vmax=vlim[1], interpolation="nearest")
    ov = np.ma.masked_where(grp.T == 0, grp.T)
    ax.imshow(ov, origin="lower", cmap=ListedColormap(COLORS), vmin=0.5, vmax=6.5, alpha=alpha,
              interpolation="nearest")
    ax.contour(thal.T.astype(float), levels=[0.5], colors="white", linewidths=0.7)
    ax.set_title(title, fontsize=8)
    ax.set_xticks([])
    ax.set_yticks([])


def load(sid, reader=canon):
    """Load norm, nucleus-group labels, and the aseg thalamus mask of one participant."""
    mri = SD / sid / "mri"
    norm = reader(mri / "norm.mgz").astype(float)
    aseg = reader(mri / "aseg.mgz")
    nuc = reader(tc.SEG / sid / "ThalamicNuclei.FSvoxelSpace.mgz").astype(int)
    assert norm.shape == nuc.shape == aseg.shape
    grp = np.zeros_like(nuc, dtype=np.int16)
    for lab, g in ID2G.items():
        grp[nuc == lab] = g
    return norm, grp, np.isin(aseg, [10, 49])


def one(sid, code, reader=canon, alpha=0.45):
    norm, grp, thal = load(sid, reader)
    xs, ys, zs = np.where(thal | (grp > 0))
    m = 14
    x0, x1 = xs.min() - m, xs.max() + m
    y0, y1 = ys.min() - m, ys.max() + m
    z0, z1 = zs.min() - m, zs.max() + m
    vlim = np.percentile(norm[x0:x1, y0:y1, z0:z1], (5, 99.5))
    fig, axes = plt.subplots(2, 4, figsize=(13, 7.0), dpi=90)
    # Coronal (x horizontal, z vertical) at 20, 50, and 80% of the anterior-posterior extent of the nuclei.
    gy = np.where(grp > 0)[1]
    for i, (f, pos) in enumerate(((0.2, "posterior"), (0.5, "middle"), (0.8, "anterior"))):
        y = int(np.round(np.quantile(gy, f)))
        panel(axes[0, i], norm[x0:x1, y, z0:z1], grp[x0:x1, y, z0:z1], thal[x0:x1, y, z0:z1],
              f"coronal {pos} (L left)", vlim, alpha)
    gz = np.where(grp > 0)[2]
    for i, (f, pos) in enumerate(((0.25, "inferior"), (0.55, "middle"), (0.85, "superior"))):
        z = int(np.round(np.quantile(gz, f)))
        panel(axes[1, i], norm[x0:x1, y0:y1, z], grp[x0:x1, y0:y1, z], thal[x0:x1, y0:y1, z],
              f"axial {pos} (L left, anterior up)", vlim, alpha)
    # Sagittal through each thalamus (y horizontal, anterior right).
    gx = np.where(grp > 0)[0]
    mid = np.median(gx)
    for i, (name, sel) in enumerate((("left", gx < mid), ("right", gx >= mid))):
        x = int(np.round(np.median(gx[sel])))
        panel(axes[i, 3], norm[x, y0:y1, z0:z1], grp[x, y0:y1, z0:z1], thal[x, y0:y1, z0:z1],
              f"sagittal {name} thalamus (anterior right)", vlim, alpha)
    handles = [plt.Rectangle((0, 0), 1, 1, color=c, alpha=0.6) for c in COLORS]
    fig.legend(handles, list(tc.GROUPS), loc="lower center", ncol=6, fontsize=8, frameon=False)
    fig.suptitle(f"{code}  thalamic nuclei (groups) on norm.mgz; white = aseg thalamus", fontsize=10)
    fig.tight_layout(rect=(0, 0.04, 1, 0.96))
    MONT.mkdir(parents=True, exist_ok=True)
    fig.savefig(MONT / f"{code}.png")
    plt.close(fig)


def main():
    subjects = sorted(config.participants().participant_id)
    key = key_table(subjects).set_index("participant_id")
    done = 0
    for sid in subjects:
        code = key.loc[sid, "code"]
        if not (tc.SEG / sid / "ThalamicNuclei.volumes.txt").exists() or (MONT / f"{code}.png").exists():
            continue
        one(sid, code)
        done += 1
    total = len([p for p in MONT.glob("P*.png") if "_" not in p.stem])
    print(f"Montages written: {done}; total {total}.")


if __name__ == "__main__":
    main()
