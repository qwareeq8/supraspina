"""Figure 5 of the paper: voxelwise t (SCI minus CTRL) of the whole-brain DBM on the study template.

Gray template, t inside the analysis mask (blue smaller in SCI, red larger), and a black outline at
two-direction TFCE P_FWE < 0.05 (either one-direction P doubled, from exact randomise permutation
counts). Slice positions are fixed from template anatomy, not from the results: sagittal at the x of
the subfield-brainstem centroid, coronal at its y; axial at the z of the centroids of the template
medulla, pons, midbrain and thalamus, then 4 levels evenly spaced from the thalamus centroid to 12 mm
below the top of the mask. The approximate MNI z of each axial slice comes from the affine MNI152
alignment of the template.

Writes fig5_wholebrain_dbm.{pdf,svg,png} and the slice table fig5_slices.csv to
config.output_dir("figures").
"""

import sys
from pathlib import Path

import matplotlib
import nibabel as nib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
import figlib  # noqa: E402
import stats_lib  # noqa: E402

figlib.register_arial()
import matplotlib.patheffects as pe  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.text  # noqa: E402
import matplotlib.transforms  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

# Private inputs of the whole-brain DBM section, under config.work_dir("dbm_wholebrain").
WB = config.work_dir("dbm_wholebrain")
ST = WB / "stats"  # Holds template_crop, mask, labels_aparc_crop, and labels_subfields_crop (.nii.gz).
DESIGN = ST / "SCI_vs_CTRL"  # Holds design.txt, contrasts.txt, tstat1/2, and chunk<s>_tfce_corrp_tstat<k>.
MNI_AFFINE = WB / "mni/template_to_mni_affine.txt"  # Template to MNI152, affine (4 x 4).

MM = 1 / 25.4
SANS, BOLD = "Arial", "Arial:bold"
matplotlib.rcParams.update({
    "font.family": SANS, "mathtext.fontset": "custom", "mathtext.rm": SANS,
    "mathtext.it": f"{SANS}:italic", "mathtext.bf": BOLD, "mathtext.sf": SANS,
    "pdf.fonttype": 42, "font.size": 7.5, "savefig.dpi": 300, "axes.linewidth": 0.5})
C_TEXT2 = "#4D4D4D"


def vol(p):
    return np.asarray(nib.load(p).dataobj, dtype=float)


ref = nib.load(ST / "template_crop.nii.gz")
aff = ref.affine
assert nib.aff2axcodes(aff) == ("R", "A", "S") and np.allclose(aff[:3, :3], np.eye(3), atol=1e-4)
tpl = vol(ST / "template_crop.nii.gz")
mask = vol(ST / "mask.nii.gz") > 0
lab = vol(ST / "labels_aparc_crop.nii.gz").astype(int)
sfl = vol(ST / "labels_subfields_crop.nii.gz").astype(int)
sh = mask.shape
_M2 = np.loadtxt(MNI_AFFINE) @ aff  # Approximate MNI (affine).
_ijk = np.indices(sh).reshape(3, -1)
mniz = (_M2 @ np.r_[_ijk, np.ones((1, _ijk.shape[1]))])[2].reshape(sh)
X = np.loadtxt(DESIGN / "design.txt")
C = np.loadtxt(DESIGN / "contrasts.txt")
assert np.array_equal(C[0], [1, -1, 0, 0, 0]), "tstat1 must be SCI minus CTRL."
n1, n0 = int(X[:, 0].sum()), int(X[:, 1].sum())
t = vol(DESIGN / "tstat1.nii.gz")
assert np.abs(t + vol(DESIGN / "tstat2.nii.gz"))[mask].max() < 1e-4
cnt = [stats_lib.pfwe_exact(DESIGN, k)[0] for k in (1, 2)]  # Exact counts of 8 chunks x 625 permutations.
sig = mask & ((2 * cnt[0] < 250) | (2 * cnt[1] < 250))  # Two-direction P < 0.05 of 5,000 permutations.
print(f"Design: {n1} SCI, {n0} CTRL; {int(sig.sum())} voxels at two-direction P_FWE < 0.05.")


# Fixed slice positions from anatomy.
def cen(m):
    return np.array(np.nonzero(m)).mean(1)


bsc = cen(sfl > 0)
cx, cy = int(round(bsc[0])), int(round(bsc[1]))
zc = [int(round(cen(sfl == lv)[2])) for lv in (175, 174, 173)] + [int(round(cen(np.isin(lab, (10, 49)))[2]))]
ztop = int(np.nonzero(mask)[2].max()) - 12
zc += [int(round(zc[3] + k * (ztop - zc[3]) / 5)) for k in (1, 2, 3, 4)]
names = ["medulla", "pons", "midbrain", "thalamus", "", "", "", ""]
mz = [float(np.median(mniz[:, :, z][mask[:, :, z]])) for z in zc]
print("Axial z index:", zc, "approximate MNI z:", np.round(mz, 1), "sagittal x index", cx, "coronal y index", cy)

VM = max(float(np.ceil(np.abs(t[mask]).max())), 4.0)
glim = np.percentile(tpl[mask], [0.5, 99.5])


def bbox2(m2, pad=3):
    a, b = np.nonzero(m2)
    return (slice(max(a.min() - pad, 0), min(a.max() + pad, m2.shape[0] - 1) + 1),
            slice(max(b.min() - pad, 0), min(b.max() + pad, m2.shape[1] - 1) + 1))


# Views as 2D arrays (rows vertical, columns horizontal, origin lower) in template mm, framed by the mask
# projections.
sj, sk = bbox2(mask.any(0))
ci, ck = bbox2(mask.any(1))
ai, aj = bbox2(mask.any(2))
V = {"sag": dict(get=lambda v: v[cx, sj, sk].T[:, ::-1]),  # Anterior on the left.
     "cor": dict(get=lambda v: v[ci, cy, ck].T)}
for i, z in enumerate(zc):
    V[f"ax{i}"] = dict(get=lambda v, z=z: v[ai, aj, z].T)
for v in V.values():
    ny, nx = v["get"](tpl).shape
    v["nx"], v["ny"] = nx, ny

W = 180.0
L = 4.0
GAP = 4.0
LEG = 46.0  # Legend column on the top row.
S1 = (W - L - LEG - 2 * GAP) / (V["sag"]["nx"] + V["cor"]["nx"])
S1 = min(S1, 0.62)
S2 = (W - L - 3 * 3.0) / (4 * V["ax0"]["nx"])
top_h = max(V["sag"]["ny"], V["cor"]["ny"]) * S1
ax_h = V["ax0"]["ny"] * S2
HEAD, LAB, BOT = 2.5, 5.0, 6.0  # No title line: the legend carries the title.
H = HEAD + LAB + top_h + 7 + 2 * (LAB + ax_h) + BOT
fig = plt.figure(figsize=(W * MM, H * MM))


def fx(x):
    return x / W


def fy(y):  # Measured from the bottom.
    return y / H


y_top0 = H - HEAD - LAB - top_h
letter_fx = [pe.withStroke(linewidth=1.2, foreground="black")]


def panel(key, x0, y0, S, orient):
    v = V[key]
    w, h = v["nx"] * S, v["ny"] * S
    ax = fig.add_axes([fx(x0), fy(y0), fx(w), fy(h)])
    ax.imshow(v["get"](tpl), origin="lower", cmap="gray", vmin=glim[0], vmax=glim[1], interpolation="nearest")
    im = ax.imshow(np.ma.masked_where(~v["get"](mask), v["get"](t)), origin="lower", cmap="RdBu_r", vmin=-VM, vmax=VM,
                   interpolation="nearest")
    s2 = v["get"](sig)
    if s2.any():
        ax.contour(s2.astype(float), levels=[0.5], colors="black", linewidths=0.6)
    ax.set_xlim(-0.5, v["nx"] - 0.5)
    ax.set_ylim(-0.5, v["ny"] - 0.5)
    ax.set_axis_off()
    for txt, mx, my in orient:
        ax.text(mx * v["nx"], my * v["ny"], txt, ha="center", va="center", fontsize=7.2, color="white",
                path_effects=letter_fx)
    return ax, im, w, h


def scalebar(ax, S, mm=20):
    ax.plot([0, mm], [-2.5 / S] * 2, color="black", lw=1.0, solid_capstyle="butt", clip_on=False)
    ax.text(mm + 1.5, -2.5 / S, f"{mm} mm", ha="left", va="center", fontsize=7)


xs = L
axs, im, ws, hs = panel("sag", xs, y_top0 + top_h - V["sag"]["ny"] * S1, S1, (("A", 0.04, 0.95), ("P", 0.96, 0.95)))
scalebar(axs, S1)
# Axial levels: plain numbers and ticks at the left edge, with a short white tick into the image so each
# level reads against the black background.
for i, z in enumerate(zc):
    zz = z - sk.start
    if 0 <= zz < V["sag"]["ny"]:
        axs.plot([-4.5, -0.8], [zz, zz], color="black", lw=0.6, clip_on=False)
        axs.plot([-0.5, 5.5], [zz, zz], color="white", lw=0.8, zorder=3)
        axs.text(-5.5, zz, str(i + 1), ha="right", va="center", fontsize=7)
xc = xs + ws + GAP
axc, _, wc, hc = panel("cor", xc, y_top0 + top_h - V["cor"]["ny"] * S1, S1, (("L", 0.05, 0.95), ("R", 0.95, 0.95)))
# Panel letters (9 pt at 185 mm) on the baseline of their title, which sits 1.5 mm above the image.
LETTER_PT, TGAP = 9 * W / 185, 4.2  # Letter size (pt); title offset from the letter (mm).
LAB_BASE = 1.0 + 1.17 * 25.4 / 72  # Level label baseline above the image (mm).


def letter_on(t, letter):
    """Panel letter TGAP mm left of title t, on its baseline (found at draw time)."""
    def baseline(renderer):
        bb = t.get_window_extent(renderer)
        # Matplotlib 3.11 returns the descent inside the per-line layout.
        return matplotlib.transforms.Affine2D().translate(bb.x0, bb.y0 + t._get_layout(renderer)[1][-1][1][2])
    fig.add_artist(matplotlib.text.Annotation(letter, (0, 0), xycoords=baseline, xytext=(-TGAP / 25.4 * 72, 0),
                                              textcoords="offset points", ha="left", va="baseline",
                                              fontsize=LETTER_PT, fontfamily=SANS, fontweight="bold"))


for key, x0, txt in (("sag", xs, "Sagittal, midline"), ("cor", xc, "Coronal, through the brainstem")):
    letter_on(fig.text(fx(x0 + TGAP), fy(y_top0 + top_h + 1.5), txt, ha="left", va="bottom", fontsize=7.5),
              "A." if key == "sag" else "B.")
# Legend column.
xl = xc + wc + GAP + 2
cb_y = y_top0 + top_h - 14
cax = fig.add_axes([fx(xl), fy(cb_y), fx(LEG - 6), fy(2.2)])
cb = fig.colorbar(im, cax=cax, orientation="horizontal")
step = 2 if VM <= 8 else 4
cb.set_ticks(np.arange(-np.floor(VM / step) * step, VM + 0.01, step))
cb.ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"{v:.0f}".replace("-", "−")))
cb.ax.tick_params(length=2, width=0.5, labelsize=7, pad=1.5)
cb.outline.set_linewidth(0.5)
cb.ax.set_title(r"Voxel $t$, SCI $-$ CTRL", fontsize=7.2, pad=3)
fig.text(fx(xl), fy(cb_y - 5.5), "smaller in SCI", ha="left", va="top", fontsize=7, color=C_TEXT2)
fig.text(fx(xl + LEG - 6), fy(cb_y - 5.5), "larger in SCI", ha="right", va="top", fontsize=7, color=C_TEXT2)
fig.legend(handles=[Line2D([], [], color="black", lw=0.8)], labels=["TFCE cluster,\ntwo-direction FWE $P < 0.05$"],
           loc="upper left", bbox_to_anchor=(fx(xl), fy(cb_y - 11)), frameon=False, handlelength=1.6, handletextpad=0.5,
           borderaxespad=0, borderpad=0, fontsize=7)
fig.text(fx(xl), fy(cb_y - 22), r"$t$ is shown inside the analysis" "\n" r"mask, which ends at the" "\n"
         r"inferior medulla. Axial levels" "\n" r"1 to 8 are marked in A.",
         ha="left", va="top", fontsize=7, color=C_TEXT2, linespacing=1.3)
# Axial rows.
y_r1 = y_top0 - 7 - LAB - ax_h
y_r2 = y_r1 - LAB - ax_h
letter_on(fig.text(fx(L + TGAP), fy(y_r1 + ax_h + LAB - 1.0), "Axial, levels 1 to 8 (approximate MNI z)",
                   ha="left", va="bottom", fontsize=7.5), "C.")
for i in range(8):
    r, c = divmod(i, 4)
    x0 = L + c * (V["ax0"]["nx"] * S2 + 3.0)
    y0 = y_r1 if r == 0 else y_r2
    orient = (("L", 0.07, 0.5), ("R", 0.93, 0.5)) if i == 0 else ()
    axa, _, wa, ha = panel(f"ax{i}", x0, y0, S2, orient)
    lab_txt = rf"{i + 1}  $z = {mz[i]:.0f}$ mm" + (f", {names[i]}" if names[i] else "")
    # One baseline for every level label, LAB_BASE mm above the image.
    axa.text(0.0, V[f"ax{i}"]["ny"] + LAB_BASE / S2, lab_txt, ha="left", va="baseline", fontsize=7)
    if i == 4:
        scalebar(axa, S2)

out = figlib.out_dir() / "fig5_wholebrain_dbm.pdf"
fig.savefig(out, metadata={"Creator": None, "Producer": None, "CreationDate": None})
figlib.export(out, transparent=False)
print("Wrote", out, f"({W:.0f} x {H:.0f} mm; VM {VM}; S1 {S1:.3f}, S2 {S2:.3f}) with its SVG and PNG.")
slices = pd.DataFrame(dict(
    panel=[f"axial {i + 1}" for i in range(8)] + ["sagittal", "coronal"],
    template_index=zc + [cx, cy], approx_mni_z=mz + [np.nan, np.nan],
    anatomy=names + ["x of the subfield-brainstem centroid", "y of the subfield-brainstem centroid"]))
slices.to_csv(out.with_name("fig5_slices.csv"), index=False)
