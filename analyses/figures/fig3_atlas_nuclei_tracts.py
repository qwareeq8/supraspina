"""Figure 3 of the paper: atlas-defined medullary nuclei and brainstem tracts (post hoc).

Panel A shows the analyzed nucleus masks of the 7 T atlas on the brainstem DBM template, one color per
nucleus, shared with the forest plot of panel B; panel C pairs each tract level with its masks. Effects
come from the atlas_nuclei_tracts section's table (same model as Fig. 2: adjusted d of mean
log-Jacobians); the printed P values, max-T FWE across the seven nuclei and the single DCN region minus
DVC test, come from the converged permutation runs.

Writes fig3_atlas_nuclei_tracts.{pdf,svg,png} (white canvas; PNG at 600 dpi) to
config.output_dir("figures").
"""

import sys
from pathlib import Path

import matplotlib
import nibabel as nib
import numpy as np
import pandas as pd

matplotlib.use("pdf")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
import figlib  # noqa: E402

figlib.register_arial()
import matplotlib._mathtext  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import patheffects as pe  # noqa: E402
from matplotlib.colors import to_rgba  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402

# Inputs: the section's test table (group level) and the private template and masks.
TESTS = config.output_dir("atlas_nuclei_tracts") / "tests_fine.csv"
TEMPLATE = config.work_dir("dbm_brainstem") / "template/template_final.nii.gz"
TEMPLATE_LABELS = config.work_dir("dbm_brainstem") / "template/labels_subfields_majority.nii.gz"
# NAV_<nucleus>, DCN_region, and TR_<tract>_<level> masks on the brainstem DBM template.
ROIS = config.work_dir("atlas_nuclei_tracts") / "rois"
# Printed P values come from the converged 10,000,000-permutation runs: the nuclei family (max-T) and
# the DCN region minus DVC contrast.
CONVERGED = config.output_dir("permutations") / "fine_single_10000000.csv"
NUCLEI_CONVERGED = config.output_dir("permutations") / "nav_10000000.csv"
TRACTS_CONVERGED = config.output_dir("permutations") / "trc_10000000.csv"

# Okabe-Ito, with a darker gold for the red nuclei: the palette's yellow is too pale on white.
BLUE, SKY, GREEN, ORANGE = "#0072B2", "#56B4E9", "#009E73", "#E69F00"
VERM, PURPLE, GOLD, GREY, DARK = "#D55E00", "#CC79A7", "#B59B00", "#8C8C8C", "#222222"
CONTRAST = "#4D4D4D"
SANS, BOLD = "Arial", "Arial:bold"
plt.rcParams.update({
    "font.family": SANS, "mathtext.fontset": "custom", "mathtext.rm": SANS,
    "mathtext.it": f"{SANS}:italic", "mathtext.bf": BOLD, "mathtext.sf": SANS,
    "pdf.fonttype": 42, "ps.fonttype": 42,
    "font.size": 8, "axes.labelsize": 8, "axes.titlesize": 8.5,
    "xtick.labelsize": 7.5, "ytick.labelsize": 8, "legend.fontsize": 7.5,
    "axes.linewidth": 0.6, "xtick.major.width": 0.6, "ytick.major.width": 0.6,
    "xtick.major.size": 2.5, "ytick.major.size": 0, "axes.spines.top": False,
    "axes.spines.right": False, "legend.frameon": False,
})
matplotlib._mathtext.SHRINK_FACTOR = 0.8
DARKHALO = [pe.withStroke(linewidth=1.2, foreground="black")]
W = 7.0  # Inches; printed at 185 mm.

# Nuclei from caudal to rostral (panel B order); colors are shared by panels A and B.
NUC = [("NAV_iMRt", "iMRt", "Inferior medullary\nreticular formation (iMRt)", SKY),
       ("NAV_raphe_med", "ROb/RPa", "Raphe obscurus and\npallidus (ROb/RPa)", PURPLE),
       ("NAV_VSM", "DVC", "Dorsal vagal complex (DVC)", VERM),
       ("NAV_ION", "ION", "Inferior olivary nuclei (ION)", GREEN),
       ("NAV_sMRt", "sMRt", "Superior medullary\nreticular formation (sMRt)", BLUE),
       ("NAV_Ve", "Ve", "Vestibular nuclei (Ve)", ORANGE),
       ("NAV_RN", "RN", "Red nuclei (RN)", GOLD)]
TRACTS = [("ML", "Medial lemnisci", GREEN, "^"), ("STT", "Spinothalamic tracts", VERM, "o"),
          ("CST", "Corticospinal tracts", BLUE, "s"), ("ICP", "Inferior cerebellar peduncles", PURPLE, "D")]
LEVELS = ["medulla", "pons", "midbrain"]


# ---------------------------------------------------------------- Helpers, as in make_figures.py
class BigSubText(matplotlib.text.Text):
    """P_FWE labels with 7 pt subscripts."""
    SUB_PT = 7.0

    def _swap(self, fn, *a):
        old = matplotlib._mathtext.SHRINK_FACTOR
        matplotlib._mathtext.SHRINK_FACTOR = self.SUB_PT / self.get_fontsize()
        try:
            return fn(*a)
        finally:
            matplotlib._mathtext.SHRINK_FACTOR = old

    def draw(self, renderer):
        return self._swap(super().draw, renderer)

    def get_window_extent(self, renderer=None, dpi=None):
        return self._swap(super().get_window_extent, renderer, dpi)


def nii(p):
    return np.asarray(nib.load(str(p)).dataobj, dtype=float)


def fmt_p(p, label="P"):
    p = float(p)
    if p < 0.001:
        return rf"${label} < 0.001$"
    if p < 0.1:
        return rf"${label} = {p:.3f}$"
    return rf"${label} = {p:.2f}$"


def panel_letter(fig, s, x, y):
    """Letter whose right edge sits at x inches, baseline at y inches (9 pt at 185 mm)."""
    fig.text(x / W, y / H, s + ".", fontsize=9 * W * 25.4 / 185, va="bottom", ha="right", fontfamily=SANS,
             fontweight="bold")


def zero_line(ax):
    ax.axvline(0, color=GREY, lw=0.6, ls=(0, (3, 2)), zorder=0)


def ci_point(ax, y, est, lo, hi, color, marker="^", ms=3.8, line=None, mec=None, mew=0.9):
    """As Fig. 2; panel B passes a gray line and a dark marker edge."""
    ax.plot([lo, hi], [y, y], color=line or color, lw=1.0, solid_capstyle="butt", zorder=3)
    ax.plot([est], [y], marker=marker, ms=ms, mec=mec or color, mew=mew, mfc=color, zorder=4, ls="none")


def right_text(ax, y, s, big_sub=False):
    kw = dict(transform=ax.get_yaxis_transform(), ha="left", va="center", fontsize=7.2, color=DARK, clip_on=False)
    if big_sub:
        ax._add_text(BigSubText(1.02, y, s, **kw))
    else:
        ax.text(1.02, y, s, **kw)


def mm_bar(ax, x0, y, n, label):
    ax.set_autoscale_on(False)
    ax.plot([x0, x0 + n], [y, y], color="black", lw=1.1, solid_capstyle="butt", clip_on=False)
    ax.text(x0 + n + 1, y, label, ha="left", va="center", fontsize=7)


def fill(ax, masks, colors, alpha=0.9):
    """Voxel fills with black outlines, as Fig. 2A."""
    for m, col in zip(masks, colors):
        if not m.any():
            continue
        rgba = np.zeros(m.shape + (4,))
        rgba[m] = to_rgba(col)
        rgba[..., 3] = m * alpha
        ax.imshow(np.transpose(rgba, (1, 0, 2)), origin="lower", interpolation="nearest")
        ax.contour(m.T.astype(float), [0.5], colors="black", linewidths=0.4)


# ---------------------------------------------------------------- Data
G = pd.read_csv(TESTS).set_index("y")  # One row per tested ROI or contrast.
P_CONTRAST = float(pd.read_csv(CONVERGED).set_index("name").loc["DCN_region-NAV_VSM", "p_single"])
P_FWE = pd.concat([pd.read_csv(f).set_index("name").p_maxT for f in (NUCLEI_CONVERGED, TRACTS_CONVERGED)])
t = nii(TEMPLATE)
sub = nii(TEMPLATE_LABELS).astype(int)
med = sub == 175
M = {k: nii(ROIS / f"{k}.nii.gz") > 0 for k, *_ in NUC}
assert sum(m.astype(int) for m in M.values()).max() == 1  # Disjoint by construction.
DCN = nii(ROIS / "DCN_region.nii.gz") > 0
TR = {f"{tk}_{lev}": nii(ROIS / f"TR_{tk}_{lev}.nii.gz") > 0 for tk, *_ in TRACTS for lev in LEVELS
      if (ROIS / f"TR_{tk}_{lev}.nii.gz").exists()}
cx0 = int(round(np.nonzero(sub > 0)[0].mean()))
pmj = int(np.nonzero((sub[cx0] == 174).any(0))[0].min())  # Ventral PMJ, as Fig. 2.
assert pmj == 58, pmj
cy_med = int(round(np.nonzero(med)[1].mean()))


def crop(k, h, cy=None):
    """Square crop around the midline at axial slice k, centered on cy or the brainstem centroid there."""
    if cy is None:
        cy = int(round(np.nonzero(sub[:, :, k] > 0)[1].mean()))
    return slice(cx0 - h, cx0 + h + 1), slice(cy - h, cy + h + 1)


FY, FH = 0.80, 2.89  # Forest plots: bottom and height (Fig. 2C's 0.30 inch per row unit).
side, gap, rgap = 1.50, 0.08, 0.24
row_y = [FY + FH + 0.62 + side + rgap, FY + FH + 0.62]
H = row_y[0] + side + 0.32
fig = plt.figure(figsize=(W, H))

# ---------------------------------------------------------------- Panel A: nuclei
TILES = [19, 13, 9, 5, 2, -36]  # Millimeters below the PMJ; negative is above.
HA = 12
tx0 = 2.12
tile_crop = {mm: crop(pmj - mm, HA, cy_med if mm > 0 else None) for mm in TILES}
lo, hi = np.percentile(t[cx0 - 13:cx0 + 14, cy_med - 13:cy_med + 14, pmj - 19:pmj + 11], [1, 99.5])  # Fig. 2A window.
cols = [c for *_, c in NUC]
short = {k: s for k, s, *_ in NUC}
# Labels per level: "on" the participant's right structure (or the midline one), "right" with a leader to
# the right edge (dy shifts it), "top" or "bottom" with a leader to that edge, "below" outside the slice.
LAB = {19: [("NAV_iMRt", "right", 5)],
       13: [("NAV_ION", "right", 4), ("NAV_iMRt", "right", -4), ("NAV_VSM", "bottom", 0)],
       9: [("NAV_raphe_med", "top", 0), ("NAV_ION", "right", 4), ("NAV_VSM", "bottom", 0)],
       5: [("NAV_raphe_med", "top", 0), ("NAV_sMRt", "right", -3), ("NAV_VSM", "below", 0)],
       2: [("NAV_ION", "right", 4), ("NAV_Ve", "right", -4)],
       -36: [("NAV_RN", "on", 0)]}
box = dict(boxstyle="round,pad=0.10", fc="white", ec="none", alpha=0.85)
arrow = dict(arrowstyle="-", lw=0.4, color="black")
h = HA
LEVEL_NO = {mm: i + 1 for i, mm in enumerate(TILES)}  # Numbered from caudal, as Fig. 5 and Supplementary Fig. 2.
for n, mm in enumerate(TILES):
    r_, c_ = divmod(n, 3)
    ax = fig.add_axes([(tx0 + c_ * (side + gap)) / W, row_y[r_] / H, side / W, side / H])
    k = pmj - mm
    xs, ys = tile_crop[mm]
    ax.imshow(t[xs, ys, k].T, origin="lower", cmap="gray", vmin=lo, vmax=hi, interpolation="nearest")
    fill(ax, [M[key][xs, ys, k] for key, *_ in NUC], cols)
    if DCN[xs, ys, k].any():
        ax.contour(DCN[xs, ys, k].T.astype(float), [0.5], colors="black", linewidths=0.8,
                   linestyles=[(0, (3, 1.6))])
    for key, mode, dy in LAB[mm]:
        ii, jj = np.nonzero(M[key][xs, ys, k])
        sel = ii > h if (ii > h + 1).sum() >= 3 and (ii < h - 1).sum() >= 3 else np.ones_like(ii, bool)
        u, v = ii[sel].mean(), jj[sel].mean()
        if mode == "on":
            ax.text(u, v, short[key], ha="center", va="center", fontsize=7, bbox=box)
        elif mode == "right":
            ax.annotate(short[key], (u, v), xytext=(2 * h - 0.6, v + dy), ha="right", va="center", fontsize=7,
                        bbox=box, arrowprops=arrow)
        elif mode == "top":
            ax.annotate(short[key], (u, jj[sel].max()), xytext=(u, 2 * h - 0.6), ha="center", va="top", fontsize=7,
                        bbox=box, arrowprops=arrow)
        elif mode == "bottom":
            ax.annotate(short[key], (u, jj[sel].min()), xytext=(h + 4, 0.4), ha="center", va="bottom", fontsize=7,
                        bbox=box, arrowprops=arrow)
        else:  # Below the slice, as the DCN label of Fig. 2A.
            ax.annotate(short[key], (u, v), xytext=(h + 5, -0.8), ha="center", va="top", fontsize=7,
                        annotation_clip=False, arrowprops=arrow)
    ax.set_axis_off()
    where = f"{mm} mm below PMJ" if mm > 0 else f"{-mm} mm above PMJ"
    ax.set_title(f"{LEVEL_NO[mm]}  {where}", fontsize=7.2, pad=2, loc="left")
    if n == 0:
        for txt, (u, v, ha_, va) in {"A": (h, 2 * h - 0.6, "center", "top"), "P": (h, 0.6, "center", "bottom"),
                                     "L": (0.6, h, "left", "center"), "R": (2 * h - 0.6, h, "right", "center")}.items():
            ax.text(u, v, txt, ha=ha_, va=va, fontsize=7, color="white", path_effects=DARKHALO)
    if n == 3:
        mm_bar(ax, 0, -1.6, 5, "5 mm")

# Sagittal view, near midline, with the levels marked as in Fig. 5 and Supplementary Fig. 2.
zs = slice(pmj - 23, pmj + 42)
ii, _ = np.nonzero(sub[cx0, :, zs] > 0)
ys_s = slice(ii.min() - 3, ii.max() + 4)
sw = 1.30
sh = sw * (zs.stop - zs.start) / (ys_s.stop - ys_s.start)
sx0 = 0.45
ax = fig.add_axes([sx0 / W, (row_y[0] + side - sh) / H, sw / W, sh / H])  # Top-aligned, as Fig. 2A.
ax.imshow(t[cx0, ys_s, zs].T, origin="lower", cmap="gray", vmin=lo, vmax=hi, interpolation="nearest")
fill(ax, [M[key][cx0 - 2:cx0 + 3].any(0)[ys_s, zs] for key, *_ in NUC], cols, alpha=0.85)
ax.contour(med[cx0, ys_s, zs].T.astype(float), [0.5], colors="0.55", linewidths=0.5, linestyles=":")
ax.set_autoscale_on(False)
ax.invert_xaxis()  # Anterior on the left, as in Fig. 2.
nys = ys_s.stop - ys_s.start
edge = nys - 0.5  # Anterior image edge (x is inverted): outside ticks with numbers, short white tick inside.
for mm in TILES:
    zk = (pmj - mm) - zs.start
    ax.plot([edge + 2.3, edge + 0.25], [zk, zk], color="black", lw=0.6, clip_on=False)
    ax.plot([edge - 0.15, edge - 2.6], [zk, zk], color="white", lw=0.8, zorder=3)
    ax.text(edge + 2.8, zk, str(LEVEL_NO[mm]), ha="right", va="center", fontsize=7)
ax.text(1, 2, "P", color="white", fontsize=7, ha="right", path_effects=DARKHALO)
ax.text(nys - 2, 2, "A", color="white", fontsize=7, ha="left", path_effects=DARKHALO)
ax.set_axis_off()
ax.set_title("Sagittal", fontsize=7.2, pad=2)
panel_letter(fig, "A", 0.26, row_y[0] + side + 0.12)
fig.legend(handles=[Line2D([], [], color="black", lw=0.8, ls=(0, (3, 1.6)))],
           labels=["DCN region (Fig. 2)"], loc="center left",
           bbox_to_anchor=((tx0 + side + gap) / W, (row_y[1] - 0.16) / H), handlelength=1.8,
           fontsize=7, borderaxespad=0)

# ---------------------------------------------------------------- Panel B: nuclei forest
bx = fig.add_axes([1.62 / W, FY / H, 1.40 / W, FH / H])
rows = [(k, lab, True, c) for k, _, lab, c in NUC]
rows += [("DCN_region-NAV_VSM", "DCN minus DVC", False, "white")]
n = len(rows)
yv = [n - 1 - i - (0.5 if i >= n - 1 else 0) for i in range(n)]
for y, (k, _lab, fwe, c) in zip(yv, rows):
    r = G.loc[k]
    ci_point(bx, y, r.d, r.d_lo, r.d_hi, c, ms=4.6, line=CONTRAST, mec=DARK, mew=0.6)
    # Nuclei: max-T FWE across the seven; the DCN minus DVC contrast: its single Freedman-Lane P.
    p = P_FWE[k] if fwe else P_CONTRAST
    right_text(bx, y, fmt_p(p, r"P_{\mathrm{FWE}}") if fwe else fmt_p(p), big_sub=fwe)
    print(f"Fig. 3B {k}: d {r.d:.2f} ({r.d_lo:.2f}, {r.d_hi:.2f}), {r.pct:.1f}%; {'P_FWE' if fwe else 'P'} {p:.4f}")
bx.axhline(0.25, color=GREY, lw=0.5)
bx.set_yticks(yv)
bx.set_yticklabels([r[1] for r in rows])
bx.set_ylim(-1.0, n - 0.5)
bx.set_xlim(-2.0, 0.4)
zero_line(bx)
bx.set_xlabel(r"Adjusted $d$, SCI $-$ CTRL (95% CI)")
panel_letter(fig, "B", 0.26, FY + FH + 0.12)

# ---------------------------------------------------------------- Panel C: tracts, as Fig. 2B
# One display slice per level: the slice where all present tracts have the most voxels in common.
show = {}
for lev in LEVELS:
    keys = [f"{tk}_{lev}" for tk, *_ in TRACTS if f"{tk}_{lev}" in TR and TR[f"{tk}_{lev}"].any()]
    counts = np.array([TR[q].sum((0, 1)) for q in keys])
    show[lev] = int(np.argmax(counts.min(0)))
    print(f"Fig. 3C {lev}: slice k {show[lev]} ({pmj - show[lev]} mm below PMJ), "
          f"voxels {counts[:, show[lev]].tolist()}")
HT = {"medulla": 14, "pons": 17, "midbrain": 20}  # Crop half-widths that keep every tract whole.
cxl = 5.50
cx = fig.add_axes([cxl / W, FY / H, 1.40 / W, FH / H])
offs = [0.30, 0.10, -0.10, -0.30]
band = FH / len(LEVELS)
tcols = [c for _, _, c, _ in TRACTS]
for i, lev in enumerate(LEVELS):
    y0 = len(LEVELS) - 1 - i
    if i % 2 == 0:
        cx.axhspan(y0 - 0.45, y0 + 0.45, color="#F4F4F4", zorder=0, lw=0)
    for (tk, _, col, mk), o in zip(TRACTS, offs):
        key = f"TR_{tk}_{lev}"
        if key in G.index:
            r = G.loc[key]
            ci_point(cx, y0 + o, r.d, r.d_lo, r.d_hi, col, marker=mk, ms=3.6)
            print(f"Fig. 3C {key}: d {r.d:.2f} ({r.d_lo:.2f}, {r.d_hi:.2f}), {r.pct:.1f}%; P_FWE {P_FWE[key]:.4f}")
    k = show[lev]
    xs, ys = crop(k, HT[lev])
    th = band - 0.08
    tax = fig.add_axes([4.02 / W, (FY + (len(LEVELS) - 1 - i) * band + 0.04) / H, th / W, th / H])
    tax.imshow(t[xs, ys, k].T, origin="lower", cmap="gray", vmin=lo, vmax=hi, interpolation="nearest")
    fill(tax, [TR.get(f"{tk}_{lev}", np.zeros_like(med))[xs, ys, k] for tk, *_ in TRACTS], tcols)
    tax.set_axis_off()
cx.set_yticks(range(len(LEVELS)))
cx.set_yticklabels([s.capitalize() for s in LEVELS[::-1]])
cx.set_ylim(-0.55, len(LEVELS) - 0.45)
cx.set_xlim(-2.0, 0.4)
zero_line(cx)
cx.set_xlabel(r"Adjusted $d$, SCI $-$ CTRL (95% CI)", loc="right")
panel_letter(fig, "C", 4.00, FY + FH + 0.12)
handles = [Line2D([], [], color=col, marker=mk, ms=3.6, mfc=col, mew=0.9, lw=1.0, label=lab)
           for _, lab, col, mk in TRACTS]
fig.legend(handles=handles, loc="lower left", bbox_to_anchor=(3.95 / W, 0.0), ncol=2, handlelength=1.6,
           columnspacing=1.0, borderaxespad=0.2, fontsize=7.5)

pdf = figlib.out_dir() / "fig3_atlas_nuclei_tracts.pdf"
fig.savefig(pdf, dpi=600, metadata={"Creator": None, "Producer": None})
figlib.export(pdf, transparent=False)
print("Wrote", pdf, "with its SVG and PNG.")
