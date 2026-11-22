"""Figures 1, 2, 4 and 6 and Supplementary Figures 1 and 2 of the paper.

Panels read the group-level tables of the section scripts (TABLES and CONVERGED below), except where a
panel shows images: Figure 1 draws one control's display planes and the group statistics arrays
(pipeline_panels.npz and stats_panels.npz, from fig1_pipeline_panels.py and fig1_stats_panels.py), and
Figures 1K and 2 and Supplementary Figure 2 draw template images and voxelwise maps from the private
work folders (PRIVATE below). Figure 3 is fig3_atlas_nuclei_tracts.py and Figure 5 is
fig5_wholebrain_dbm.py.

Writes <name>.pdf (vector, fonts embedded), .svg, and .png (600 dpi) to config.output_dir("figures").
Usage: make_figures.py [1 2 4 6 S1 S2]   (no argument: all six)
"""

import csv
import math
import sys
from pathlib import Path

import matplotlib
import numpy as np

matplotlib.use("pdf")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
import figlib  # noqa: E402

figlib.register_arial()
import matplotlib._mathtext  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.textpath  # noqa: E402
from matplotlib import patheffects as _pe  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.patches import FancyBboxPatch, Patch  # noqa: E402

# Group-level inputs, {key: (section, file)} in config.output_dir(section), as the section scripts write them.
TABLES = {
    "subfields": ("subfields", "brainstem_subfield_stats.csv"),  # Row per structure; Hedges g_adj.
    "dartel": ("dartel", "roi_stats.csv"),  # Row per measure <region>|gmwm_fwhm0; adjusted d.
    "aseg": ("cortex", "region_results.csv"),  # Measure roi_Brain-Stem is the aseg brainstem volume.
    "s1": ("cortex", "somatotopic_results.csv"),  # Measures area_S1_trunk and area_S1_upperlimb_headface.
    "compartments": ("compartments", "roi_main.csv"),
    "tectal": ("compartments", "tectal_control.csv"),
    "dbm_bs_roi": ("dbm_brainstem", "roi_primary.csv"),
    "dbm_bs_clusters": ("dbm_brainstem", "voxel_clusters.csv"),
    "dbm_wb_roi": ("dbm_wholebrain", "roi_agreement.csv"),
    "thalamus": ("thalamus", "family.csv"),
    "clinical_model": ("clinical", "clinical_model.csv"),
    "covariation": ("clinical", "covariation.csv"),
    "interaction": ("clinical", "interaction.csv"),
    "strata": ("clinical", "stratum_vs_ctrl.csv"),
    "strata_within": ("clinical", "within_sci.csv"),
}
# Supplementary Fig. 2 images in config.output_dir("dartel"): the white matter mask, the t map (SCI minus
# CTRL), and the largest cluster at doubled one-direction TFCE P_FWE < 0.05 (12_wm_vbm_summary.py), and the
# sample-mean modulated gray and white matter (05_mean_images.py).
DARTEL_MAPS = {"mask": "vbm/mask_wm02.nii.gz", "t": "vbm/wm_t_sci_minus_ctrl.nii.gz",
               "cluster": "vbm/wm_cluster.nii.gz", "gm": "maps/mean_mwc1_fwhm0.nii.gz",
               "wm": "maps/mean_mwc2_fwhm0.nii.gz"}

# The printed P values of Figs 2C and 4C come from the converged runs (permutations section), as in the text:
# <stem>_<N>.csv in config.output_dir("permutations"). Brainstem families give p_maxT (family-wise) and
# p_single per name; thalamic and cortical sets give p_fwe per family and name.
N_CONVERGED = 10000000


def converged(stem, column, **row):
    return pick(read(config.output_dir("permutations") / f"{stem}_{N_CONVERGED}.csv"), **row)[column]


# Private inputs, {key: (section, path)} under config.work_dir(section).
PRIVATE = {
    "pipeline_panels": ("figures", "pipeline_panels.npz"),  # From fig1_pipeline_panels.py.
    "stats_panels": ("figures", "stats_panels.npz"),  # From fig1_stats_panels.py.
    # Brainstem DBM template (1 mm RAS) and its FreeSurfer brainstem labels (majority vote).
    "bs_template": ("dbm_brainstem", "template/template_final.nii.gz"),
    "bs_template_labels": ("dbm_brainstem", "template/labels_subfields_majority.nii.gz"),
    # Cropped statistics grid: template_crop, mask, labels_crop, and roi_{midbrain,pons,medulla}.nii.gz.
    "bs_stats": ("dbm_brainstem", "stats"),
    # FSL randomise output of the group design: tstat1 (SCI minus CTRL) and tfce_corrp_tstat{1,2}.
    "bs_design": ("dbm_brainstem", "stats/SCI_vs_CTRL"),
    "compartment_masks": ("compartments", "rois"),  # Masks <compartment>_t50.nii.gz on the brainstem template.
}

# Okabe-Ito palette.
BLUE, SKY, GREEN, ORANGE = "#0072B2", "#56B4E9", "#009E73", "#E69F00"
VERM, PURPLE, GREY, DARK = "#D55E00", "#CC79A7", "#8C8C8C", "#222222"

SANS = "Arial"  # OUP artwork guidance: Arial; bold text is Arial Bold.
BOLDKW = dict(fontfamily=SANS, fontweight="bold")
plt.rcParams.update({
    "font.family": SANS, "mathtext.fontset": "custom", "mathtext.rm": SANS,
    "mathtext.it": f"{SANS}:italic", "mathtext.bf": f"{SANS}:bold", "mathtext.sf": SANS,
})
plt.rcParams.update({
    "pdf.fonttype": 42, "ps.fonttype": 42,
    "font.size": 8, "axes.labelsize": 8, "axes.titlesize": 8.5,
    "xtick.labelsize": 7.5, "ytick.labelsize": 8, "legend.fontsize": 7.5,
    "axes.linewidth": 0.6, "xtick.major.width": 0.6, "ytick.major.width": 0.6,
    "xtick.major.size": 2.5, "ytick.major.size": 0, "axes.spines.top": False,
    "axes.spines.right": False, "legend.frameon": False,
})
# Larger sub- and superscripts (P_FWE, footnote marks) so they stay legible at print size; matplotlib's
# default is 0.7 and has no public setting.
matplotlib._mathtext.SHRINK_FACTOR = 0.8

W2 = 7.0  # Double-column width, inches; printed at 185 mm.
OUT = figlib.out_dir()
DARKHALO = [_pe.withStroke(linewidth=1.2, foreground="black")]


# ---------------------------------------------------------------- Helpers
def read(path):
    with open(path, newline="") as fh:
        return list(csv.DictReader(fh))


def table(key):
    section, name = TABLES[key]
    return read(config.output_dir(section) / name)


def private(key, name=""):
    section, rel = PRIVATE[key]
    return config.work_dir(section) / rel / name


def pick(rows, **kw):
    """Return the single row matching every key=value (exact match)."""
    hits = [r for r in rows if all(r[k] == v for k, v in kw.items())]
    if len(hits) != 1:
        raise KeyError(f"{len(hits)} rows match {kw}")
    return hits[0]


def f(x):
    return float(x)


def es3(r, est="d", lo="d_lo", hi="d_hi"):
    """Effect size and its 95% CI from one table row."""
    return f(r[est]), f(r[lo]), f(r[hi])


def fmt_p(p, label="P"):
    # The paper reports every P below 0.001 as P < 0.001.
    p = f(p)
    if p < 0.001:
        return rf"${label} < 0.001$"
    if p < 0.1:
        return rf"${label} = {p:.3f}$"
    if p > 0.995:
        return rf"${label} = 1.00$"
    return rf"${label} = {p:.2f}$"


LETTER_PT = 9 * W2 * 25.4 / 185  # Brain: 9 pt panel letters at the 185 mm print width.


def panel_letter(ax, s, x=-0.02, y=1.02, pad=None, va="bottom"):
    """Bold panel letter. With pad (points), it sits on the baseline of an ax.set_title(..., pad=pad)
    title; va="baseline" shares a title's baseline drawn at the same y."""
    s = s.upper() + "."  # Legends and text cite panels as A, B, ...
    tr = ax.transAxes
    if pad is not None:
        tr = matplotlib.transforms.offset_copy(tr, fig=ax.figure, y=pad, units="points")
        y, va = 1.0, "baseline"
    ax.text(x, y, s, transform=tr, fontsize=LETTER_PT, va=va, ha="right", **BOLDKW)


def zero_line(ax, x=0):
    ax.axvline(x, color=GREY, lw=0.6, ls=(0, (3, 2)), zorder=0)


def ci_point(ax, y, est, lo, hi, color, marker="o", hollow=False, ms=4.2, lw=1.0, z=3):
    ax.plot([lo, hi], [y, y], color=color, lw=lw, solid_capstyle="butt", zorder=z)
    ax.plot([est], [y], marker=marker, ms=ms, mec=color, mew=0.9, mfc="white" if hollow else color,
            zorder=z + 1, ls="none")


class BigSubText(matplotlib.text.Text):
    """Text whose math subscripts are drawn at SUB_PT (P_FWE, P_Holm and P_interaction labels) rather
    than at the global SHRINK_FACTOR. The factor is read when mathtext lays out a string, so it is
    swapped in for every layout of this text; these strings are drawn only through this class."""
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


def right_text(ax, y, s, x=1.01, color=DARK, size=7.2, big_sub=False):
    kw = dict(transform=ax.get_yaxis_transform(), ha="left", va="center", fontsize=size, color=color,
              clip_on=False)
    if big_sub:
        ax._add_text(BigSubText(x, y, s, **kw))
    else:
        ax.text(x, y, s, **kw)


def save(fig, name, clear_axes=True, transparent=True):
    """Save on a transparent canvas (transparent=False: white, as Supplementary Fig. 2). With
    clear_axes, white axes backgrounds are cleared too; Figure 1 keeps its white plot areas, which sit
    on tinted boxes."""
    pdf = OUT / f"{name}.pdf"
    if transparent and clear_axes:
        for ax in fig.axes:
            if matplotlib.colors.to_rgba(ax.get_facecolor()) == (1, 1, 1, 1):
                ax.set_facecolor("none")
    # The dpi sets the resolution of embedded images (vector backends resample them).
    fig.savefig(pdf, dpi=600, **({"facecolor": "none"} if transparent else {}),
                metadata={"Creator": None, "Producer": None})
    plt.close(fig)
    figlib.export(pdf, transparent)
    print("Wrote", pdf, "with its SVG and PNG.")


def nii(path):
    import nibabel as nib
    return np.asarray(nib.load(str(path)).dataobj, dtype=float)


def mm_bar(ax, x0, y, n, label, size=7):
    """Scale bar of n mm (data units are mm) below an image, at axes-data coordinates."""
    ax.set_autoscale_on(False)  # Keep the image limits; the bar sits outside them.
    ax.plot([x0, x0 + n], [y, y], color="black", lw=1.1, solid_capstyle="butt", clip_on=False)
    ax.text(x0 + n + 1, y, label, ha="left", va="center", fontsize=size)


def two_direction_sig(mask):
    """Voxels at two-direction TFCE P_FWE < 0.05 (either one-direction P doubled) of the brainstem DBM."""
    p2 = [np.where(mask, np.minimum(1, 2 * (1 - nii(private("bs_design", f"tfce_corrp_tstat{k}.nii.gz")))), 1.0)
          for k in (1, 2)]
    return mask & ((p2[0] < 0.05) | (p2[1] < 0.05))


# ------------------------------------------------- Figure 1: pipeline
def fs_lut():
    lut = {}
    for line in (config.path("freesurfer.home") / "FreeSurferColorLUT.txt").read_text().splitlines():
        p = line.split()
        if len(p) >= 5 and p[0].isdigit():
            lut[int(p[0])] = [int(v) / 255 for v in p[2:5]]
    return lut


def label_rgba(lab, colors, alpha=0.75):
    """RGBA image of a label plane; colors maps label -> RGB, others clear."""
    out = np.zeros(lab.shape + (4,), np.float32)
    for k, c in colors.items():
        m = lab == k
        out[m, :3] = matplotlib.colors.to_rgb(c)
        out[m, 3] = alpha
    return out


def surface_image(v, faces, code, sulc, colors, px=1800):
    """Lateral view of a left inflated surface as an RGBA image (Gouraud, Lambert shaded) on a
    transparent surround."""
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from scipy import ndimage

    y, z, x = v[:, 1], v[:, 2], v[:, 0]
    tri = v[faces]
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    vn = np.zeros_like(v)
    for k in range(3):
        np.add.at(vn, faces[:, k], n)
    vn /= np.linalg.norm(vn, axis=1, keepdims=True) + 1e-12
    light = np.array([-0.85, 0.25, 0.45])
    light /= np.linalg.norm(light)
    shade = 0.35 + 0.65 * np.clip(vn @ light, 0, 1)
    gray = (0.71 - 0.10 * np.tanh(sulc / 2.0)) * shade  # Sulci (sulc > 0) darker.
    facing = (n[:, 0] / (np.linalg.norm(n, axis=1) + 1e-12)) < 0.05
    keep = np.flatnonzero(facing)[np.argsort(-x[faces].mean(1)[facing])]  # Back to front.
    ys, zs = -y, z  # Anterior on the left.
    W = ys.max() - ys.min()
    Hh = zs.max() - zs.min()
    fig = plt.figure(figsize=(W / Hh * px / 200, px / 200), dpi=200)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.axis("off")
    ax.tripcolor(ys, zs, faces[keep], gray, shading="gouraud", cmap="gray", vmin=0, vmax=1)
    fc = code[faces[keep]]
    for k, c in colors.items():
        sel = keep[(fc == k).sum(1) >= 2]
        if len(sel):
            cm = matplotlib.colors.LinearSegmentedColormap.from_list("", ["black", c])
            ax.tripcolor(ys, zs, faces[sel], shade, shading="gouraud", cmap=cm, vmin=0, vmax=1)
    ax.set_xlim(ys.min(), ys.max())
    ax.set_ylim(zs.min(), zs.max())
    fig.patch.set_alpha(0)
    ax.patch.set_alpha(0)
    canvas = FigureCanvasAgg(fig)  # The pdf backend has no pixel buffer.
    canvas.draw()
    img = np.asarray(canvas.buffer_rgba()).copy()
    plt.close(fig)
    # Opaque inside the silhouette, so seams between triangles do not show through.
    inside = ndimage.binary_erosion(ndimage.binary_fill_holes(img[..., 3] > 127), iterations=2)
    img[inside, 3] = 255
    return img


def fig1():
    from scipy.ndimage import gaussian_filter, zoom
    d = np.load(private("pipeline_panels"))
    H = 5.54
    fig = plt.figure(figsize=(W2, H))
    bg = fig.add_axes([0, 0, 1, 1], zorder=-5)
    bg.axis("off")
    bg.set_xlim(0, W2)
    bg.set_ylim(0, H)
    INK, MUTE = DARK, "#666666"

    def header(x, ytop, letter, title, sub, rows=1):
        """Letter, bold title and gray subtitle stacked above ytop (inches).

        rows is the subtitle height reserved in this row of panels, so titles align when some
        subtitles wrap to two lines and others do not.
        """
        line = 0.12  # One subtitle line, inches.
        yl = ytop + 0.205 + (rows - 1) * line + 0.025  # Title baseline.
        bg.text(x, yl, f"{letter}.", fontsize=LETTER_PT, **BOLDKW, ha="left", va="baseline", color=INK)
        lw = matplotlib.textpath.TextPath((0, 0), f"{letter}.", size=LETTER_PT, prop=matplotlib.font_manager
                                          .FontProperties(family=SANS, weight="bold")).get_extents().x1 / 72
        bg.text(x + lw + 0.06, yl, title, fontsize=8, **BOLDKW, ha="left", va="baseline", color=INK)
        bg.text(x, ytop + 0.06 + (rows - 1 - sub.count("\n")) * line, sub, fontsize=7.2,
                ha="left", va="bottom", color=MUTE, linespacing=1.2)

    def panel(x, y, w, h, letter, title, sub):
        """Header above an image axes at (x, y, w, h) inches."""
        header(x, y + h, letter, title, sub)
        ax = fig.add_axes([x / W2, y / H, w / W2, h / H])
        ax.axis("off")
        return ax

    def arrow(x0, y0, x1, y1, color=INK, ls="-"):
        bg.annotate("", xy=(x1, y1), xytext=(x0, y0),
                    arrowprops=dict(arrowstyle="-|>", lw=0.8, color=color, ls=ls,
                                    mutation_scale=8, shrinkA=0, shrinkB=0))

    def show(ax, a, **kw):
        # Smooth interpolation only for gap-free gray images; NaN-masked overlays ring.
        smooth = a.ndim == 2 and not np.isnan(a).any()
        return ax.imshow(a, interpolation="lanczos" if smooth else "nearest", **kw)

    def labels(ax, lab, colors, alpha):
        """Translucent label fill with a solid outline, so the anatomy stays visible."""
        show(ax, label_rgba(lab, colors, alpha))
        for k, c in colors.items():
            if (lab == k).any():
                ax.contour(lab == k, levels=[0.5], colors=[c], linewidths=0.6)

    def cbar(x, y, h, cmap, lim, fmt="{:.2f}", title=None, tpad=3):
        """Vertical color bar at (x, y) inches with ticks at -lim, 0 and +lim."""
        cax = fig.add_axes([x / W2, y / H, 0.05 / W2, h / H])
        sm = matplotlib.cm.ScalarMappable(norm=matplotlib.colors.Normalize(-lim, lim), cmap=cmap)
        cb = fig.colorbar(sm, cax=cax, ticks=[-lim, 0, lim])
        cb.ax.set_yticklabels([f"${fmt.format(-lim)}$", "$0$", f"${fmt.format(lim)}$"])
        cb.ax.tick_params(labelsize=7, length=1.5, width=0.4, pad=1)
        cb.outline.set_linewidth(0.4)
        if title:
            cb.ax.set_title(title, fontsize=7, pad=tpad, color=INK)  # Clear of the top tick label.

    # Geometry (inches): statistics band, then two image rows. Each pipeline has its own box (0.06
    # below its image row, 0.34 above it for the headers) with a numbered tab on top, in its Fig. 2B color.
    sy, sh = 0.04, 1.56
    tab_h = 0.15
    r1h = r2h = 1.18
    r2y = sy + sh + tab_h + 0.11 + 0.06
    r2top = r2y + r2h + 0.34  # Top edge of the row 2 boxes.
    bus_y = r2top + tab_h + 0.10
    r1y = bus_y + 0.08 + 0.06
    r1top = r1y + r1h + 0.34
    assert r1top + tab_h <= H, r1top + tab_h

    def pipe_box(x, y, w, h, color, label):
        """Pipeline box with a tab sitting on its top edge."""
        tint = matplotlib.colors.to_rgb(color)
        fc = [1 - 0.06 * (1 - c) for c in tint]
        tc = [1 - 0.22 * (1 - c) for c in tint]
        bg.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=0.06",
                                    fc=fc, ec=color, lw=0.8, zorder=-4))
        bg.text(x + 0.16, y + h + tab_h / 2, label, fontsize=7.5, **BOLDKW,
                ha="left", va="center", color=INK, zorder=-2)
        tp = matplotlib.textpath.TextPath((0, 0), label, size=7.5,
                                          prop=matplotlib.font_manager.FontProperties(family=SANS, weight="bold"))
        tw = tp.get_extents().width / 72 + 0.12
        bg.add_patch(FancyBboxPatch((x + 0.10, y + h), tw, tab_h,
                                    boxstyle="round,pad=0,rounding_size=0.04",
                                    fc=tc, ec=color, lw=0.8, zorder=-3))
        return x + 0.10 + tw / 2  # Tab center, for the input arrow.

    # A: T1.
    ax = panel(0.05, r1y, 1.12, r1h, "A", "T1-weighted MRI", r"1.3 mm MPRAGE, Prisma 3 T")
    # The T1 keeps its aspect ratio from the top of row 1 down.
    ah_ = 1.12 * d["A_t1"].shape[0] / d["A_t1"].shape[1]
    ax.set_position([0.05 / W2, (r1y + r1h - ah_) / H, 1.12 / W2, ah_ / H])
    show(ax, d["A_t1"], cmap="gray", vmin=0, vmax=1)
    a_bottom, a_mid = r1y + r1h - ah_, 0.05 + 1.12 / 2
    # Boxes end at xr; the lane right of them carries pipeline 1 to the statistics.
    xr, lane = 6.80, 6.90
    # Pipeline 1: FreeSurfer (B), with the brainstem subfields (C) and the other FreeSurfer-derived
    # measures (D, E).
    pipe_box(1.70, r1y - 0.06, xr - 1.70, r1h + 0.40, BLUE, "Pipeline 1: FreeSurfer 8.2.0")
    ax = panel(1.80, r1y, 1.05, r1h, "B", "recon-all", r"aseg, cortical surfaces")
    show(ax, d["B_t1"], cmap="gray", vmin=0, vmax=1)
    lut = fs_lut()
    keep = [k for k in np.unique(d["B_aseg"]) if k and k in lut and k not in (2, 41, 24)]
    show(ax, label_rgba(d["B_aseg"], {k: lut[k] for k in keep}, alpha=0.6))
    ax = panel(3.10, r1y, 0.95, r1h, "C", "Brainstem subfields", "medulla, pons, midbrain")
    show(ax, d["C_t1"], cmap="gray", vmin=0, vmax=1)
    labels(ax, d["C_lab"], {175: VERM, 174: ORANGE, 173: SKY, 178: GREEN}, 0.45)
    ax = panel(4.56, r1y, 1.12, r1h, "D", "Thalamic nuclei", "six nucleus groups")
    show(ax, d["D_t1"], cmap="gray", vmin=0, vmax=1)
    labels(ax, d["D_lab"], {1: ORANGE, 2: GREEN, 3: BLUE, 4: PURPLE, 5: SKY, 6: VERM}, 0.55)
    ax = panel(5.74, r1y, 0.98, r1h, "E", "S1 parcels", "Brainnetome atlas")
    img = surface_image(d["E_v"], d["E_f"], d["E_code"], d["E_sulc"], {1: VERM, 2: BLUE, 3: ORANGE, 4: GREEN})
    show(ax, img)
    # Pipelines 2 to 4: registration-based morphometry, one box each.
    bh = r2h + 0.40
    # Row 2 spans from the left margin to x2r with even gaps, clear of the lane.
    x2r, gap = 6.62, 0.13
    bw = (x2r - 0.05 - 2 * gap) / 3
    boxes = [(0.05 + k * (bw + gap), bw) for k in range(3)]
    tabs = [pipe_box(x, r2y - 0.06, w, bh, c, s) for (x, w), c, s in zip(
        boxes, (ORANGE, GREEN, PURPLE),
        ("Pipeline 2: SPM25 DARTEL", "Pipeline 3: Brainstem DBM", "Pipeline 4: Whole-brain DBM"))]
    ax = panel(boxes[0][0] + 0.10, r2y, bw - 0.20, r2h, "F", "Modulated tissue", "grey plus white matter, MNI space")
    gm = gaussian_filter(d["F_gm"], 0.6)  # Display only: FWHM 2.1 mm hides modulation aliasing.
    show(ax, gm, cmap="gray", vmin=0, vmax=np.percentile(gm, 99.5))
    div = plt.get_cmap("RdBu_r")
    ax = panel(boxes[1][0] + 0.10, r2y, bw - 0.62, r2h, "G", "Log-Jacobian", "DCN region outlined")
    # Display only: smooth inside the brainstem (normalized convolution, FWHM 2.4 mm), then upsample value
    # and mask together so the overlay ends cleanly at the brainstem.
    bs = d["G_bs"].astype(float)
    lj = np.nan_to_num(d["G_lj"]) * bs
    sm = gaussian_filter(lj, 1.0) / np.maximum(gaussian_filter(bs, 1.0), 1e-6)
    Z, (nr, nc) = 6, bs.shape
    ext = (-0.5, nc - 0.5, nr - 0.5, -0.5)
    tz = zoom(d["G_tpl"], Z, order=3)
    ax.imshow(tz, cmap="gray", vmin=0, vmax=1, extent=ext, interpolation="antialiased")
    inside = zoom(gaussian_filter(bs, 0.7), Z, order=1) > 0.5
    lim = float(f"{np.percentile(np.abs(sm[bs > 0]), 98):.2f}")
    ax.imshow(np.ma.masked_where(~inside, zoom(sm, Z, order=1)), cmap=div, vmin=-lim, vmax=lim, alpha=0.75,
              extent=ext, interpolation="antialiased")
    ax.set_xlim(-0.5, nc - 0.5)
    ax.set_ylim(nr - 0.5, -0.5)
    cbar(boxes[1][0] + bw - 0.44, r2y + 0.17, 0.80, div, lim, title="log-Jacobian", tpad=6)
    ax.contour(d["G_comp"] == 3, levels=[0.5], colors=[INK], linewidths=0.9)
    ax.contour(d["G_comp"] == 1, levels=[0.5], colors=[INK], linewidths=0.7, linestyles="dashed")
    ax = panel(boxes[2][0] + 0.10, r2y, bw - 0.62, r2h, "H", "Log-Jacobian", "study template, 4 mm FWHM")
    show(ax, d["H_tpl"], cmap="gray", vmin=0, vmax=1)
    lim = float(f'{np.nanpercentile(np.abs(d["H_lj"]), 98):.2f}')
    show(ax, d["H_lj"], cmap=div, vmin=-lim, vmax=lim, alpha=0.6)
    cbar(boxes[2][0] + bw - 0.44, r2y + 0.17, 0.80, div, lim, title="log-Jacobian", tpad=6)
    # Flow: the T1 feeds pipeline 1 directly and pipelines 2 to 4 through a bus.
    arrow(1.30, r1y + r1h / 2, 1.68, r1y + r1h / 2)
    arrow(2.88, r1y + r1h / 2, 3.04, r1y + r1h / 2)  # FreeSurfer to its derived measures.
    bg.plot([a_mid, a_mid, tabs[-1]], [a_bottom, bus_y, bus_y], color=INK, lw=0.8, solid_joinstyle="miter")
    tabs[0] = a_mid  # Pipeline 2 sits under A, so the trunk drops straight onto its tab.
    for xt in tabs:
        arrow(xt, bus_y, xt, r2top + tab_h + 0.01)
    # Statistics: one panel per step, drawn from the analysis itself (stats_panels.npz; brainstem DBM
    # voxel maps as in Fig. 2D).
    pipe_box(0.05, sy, 6.91, sh, GREY, "Group statistics")
    # All four pipelines join on the way down: 2 to 4 from below, 1 by the right lane.
    yc = sy + sh + tab_h + 0.05
    xs = [x + w / 2 for x, w in boxes]
    for xb in xs:
        bg.plot([xb, xb], [r2y - 0.06, yc], color=INK, lw=0.8)
    bg.plot([xr, lane, lane, xs[0]], [r1y + r1h / 2, r1y + r1h / 2, yc, yc], color=INK, lw=0.8,
            solid_joinstyle="miter")
    arrow(xs[1], yc, xs[1], sy + sh + 0.01)
    q = np.load(private("stats_panels"))
    ay, ah = sy + 0.33, 0.70  # Plot area (inches); headers sit above it.
    # Panels I to L with equal gaps between 0.10 inside each end of the box (widths in inches, header or
    # plot, whichever is wider).
    widths = [1.50, 1.27, 0.93, 1.28]
    sgap = (6.86 - 0.15 - sum(widths)) / 3
    slot = [0.15 + sum(widths[:i]) + i * sgap for i in range(4)]

    def plot_ax(x, w):
        a = fig.add_axes([x / W2, ay / H, w / W2, ah / H])
        a.tick_params(labelsize=7, length=2, width=0.5, pad=1.5)
        for sp in ("left", "bottom"):
            a.spines[sp].set_linewidth(0.5)
        return a

    # I: design matrix (columns scaled 0 to 1 for display).
    header(slot[0], ay + ah, "I", "Group model", "$y$ ~ group + age + sex + eTIV", rows=2)
    Xd = q["design"]
    Xs = (Xd - Xd.min(0)) / np.ptp(Xd, 0)
    a = fig.add_axes([(slot[0] + 0.02) / W2, ay / H, 1.35 / W2, ah / H])
    a.imshow(Xs, cmap="gray", aspect="auto", interpolation="nearest")
    a.set_xticks(range(5))
    a.set_xticklabels(["SCI", "CTRL", "Age", "Sex", "eTIV"], fontsize=7)
    a.set_yticks([])
    a.tick_params(length=0, pad=1.5)
    for sp in a.spines.values():
        sp.set_linewidth(0.5)
    a.text(1.04, 0.5, f"{Xd.shape[0]} participants", transform=a.transAxes, rotation=90, ha="left",
           va="center", fontsize=7, color=MUTE)
    # J: max-|t| permutation null of the medullary compartment family.
    header(slot[1], ay + ah, "J", "Permutation inference", "≥10,000,000 Freedman–Lane\npermutations, max-$|t|$ null",
           rows=2)
    a = plot_ax(slot[1] + 0.22, 1.02)
    a.hist(q["null"], bins=np.arange(0, 6.01, 0.2), color="#BFC7D0", lw=0)
    thr, tob = float(q["thr"]), float(q["t_dcn"])
    a.axvline(thr, color=DARK, lw=0.7, ls=(0, (3, 2)))
    a.axvline(tob, color=VERM, lw=1.0)
    a.text(thr + 0.12, a.get_ylim()[1] * 0.92, r"FWE 5%", fontsize=7, color=DARK, va="top")
    a.text(tob - 0.12, a.get_ylim()[1] * 0.62, "DCN", fontsize=7, color=VERM, va="top", ha="right")
    a.set_xlim(0, 6)
    a.set_yticks([])
    a.set_xlabel(r"max $|t|$, 5 compartments", fontsize=7, labelpad=1)
    # K: voxelwise TFCE on the brainstem DBM (midline sagittal, anterior left).
    header(slot[2], ay + ah, "K", "Voxelwise TFCE", "brainstem DBM $t$,\nFWE clusters", rows=2)
    tpl, mask = nii(private("bs_stats", "template_crop.nii.gz")), nii(private("bs_stats", "mask.nii.gz")) > 0
    tt = nii(private("bs_design", "tstat1.nii.gz"))
    sig = two_direction_sig(mask)
    cx = int(round(np.nonzero(nii(private("bs_stats", "labels_crop.nii.gz")) > 0)[0].mean()))
    jj, kk = np.nonzero(mask[cx])
    sj, sk = slice(jj.min() - 3, jj.max() + 4), slice(kk.min() - 3, kk.max() + 4)

    def sag(v):
        return v[cx, sj, sk].T[:, ::-1]  # Anterior on the left.
    rows_, cols_ = sag(tpl).shape
    kh = ah
    kw = kh * cols_ / rows_
    a = fig.add_axes([(slot[2] + 0.30) / W2, ay / H, kw / W2, kh / H])
    glo, ghi = np.percentile(tpl, [1, 99.5])
    a.imshow(sag(tpl), origin="lower", cmap="gray", vmin=glo, vmax=ghi, interpolation="nearest")
    vm = float(np.ceil(np.abs(tt[mask]).max()))
    a.imshow(np.ma.masked_where(~sag(mask), sag(tt)), origin="lower", cmap="RdBu_r", vmin=-vm, vmax=vm,
             interpolation="nearest")
    a.contour(sag(sig).astype(float), [0.5], colors="black", linewidths=0.6)
    a.axis("off")
    cbar(slot[2] + 0.30 + kw + 0.10, ay + 0.02, ah - 0.04, plt.get_cmap("RdBu_r"), vm, "{:.0f}", title="$t$")
    # L: DCN region by injury level (adjusted for age, sex and eTIV; % of the CTRL mean).
    header(slot[3], ay + ah, "L", "Injury level", "DCN region by\ninjury level", rows=2)
    a = plot_ax(slot[3] + 0.30, 0.98)
    jit = np.random.default_rng(1)
    for k, (_lab, col) in enumerate((("CTRL", GREY), ("T/L", BLUE), ("C", VERM))):
        v = q["dcn_pct"][q["dcn_level"] == k]
        a.scatter(k + jit.uniform(-0.18, 0.18, len(v)), v, s=3, color=col, lw=0, alpha=0.8)
        a.plot([k - 0.28, k + 0.28], [v.mean()] * 2, color=DARK, lw=1.0)
    a.axhline(0, color=GREY, lw=0.5, ls=(0, (3, 2)), zorder=0)
    a.set_xticks(range(3))
    a.set_xticklabels(["CTRL", "T/L", "C"], fontsize=7)
    a.set_xlim(-0.55, 2.55)
    a.set_ylabel("Difference from\nCTRL mean (%)", fontsize=7, labelpad=1, linespacing=1.0)
    a.spines[["top", "right"]].set_visible(False)
    print("Fig. 1L group sizes (CTRL, T/L, C):", [int((q["dcn_level"] == k).sum()) for k in range(3)])
    save(fig, "fig1_pipeline", clear_axes=False)


# ------------------------------------- Supplementary figure 1: flow
def figS1():
    # One dot per scanned participant (inches): SCI filled with NPRS > 3 and open with NPRS <= 3, the
    # control excluded at QC as a cross, and the analyzed n per outcome as a table on the right.
    W, H = 5.60, 1.50
    fig = plt.figure(figsize=(W, H))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(0, H)
    ax.axis("off")

    def b(t):
        return r"$\mathbf{" + t.replace(" ", r"\ ") + "}$"

    a_rows = table("strata")
    n_pain = int(float(pick(a_rows, stratifier="Pain", stratum="NPRS > 3", outcome="dcn")["n_sci"]))
    n_low = int(float(pick(a_rows, stratifier="Pain", stratum="NPRS <= 3", outcome="dcn")["n_sci"]))
    assert n_pain + n_low == 33
    pain_labels = (f"{n_pain} with NPRS > 3", f"{n_low} with NPRS ≤ 3")
    pain_note = "NPRS, numeric pain rating scale (0 to 10)."
    print(f"Supplementary Fig. 1 pain split: {n_pain} NPRS > 3, {n_low} NPRS <= 3.")
    MUTE = "#555555"
    pitch, ms = 0.092, 4.4  # Dot spacing (in) and marker diameter (pt).
    x0 = 1.00               # Left edge of the dot grids.

    def grid(n, cols, ytop):
        # Row-major positions, top row first, so a short last row ends at the right.
        return [(x0 + (k % cols) * pitch, ytop - (k // cols) * pitch) for k in range(n)]

    rows = [  # Y of top dot row, group, color, scanned, analyzed, and columns.
        (1.17, "Chronic SCI", VERM, 33, 33, 11),
        (0.66, "Healthy controls", GREY, 63, 62, 21),
    ]
    ax.text(x0 - 0.04, 1.36, "One dot per participant, all scanned on one Siemens Prisma 3 T",
            fontsize=6.2, ha="left", va="baseline", color=MUTE)
    for ytop, grp, col, n, an, cols in rows:
        ym = ytop - pitch
        ax.text(0.06, ym + 0.045, b(grp), fontsize=7.0, ha="left", va="baseline", color=DARK)
        ax.text(0.06, ym - 0.045, f"{an} of {n} analyzed", fontsize=6.4, ha="left", va="top", color=MUTE)
        pts = grid(n, cols, ytop)
        xs, ys = zip(*pts)
        if grp == "Chronic SCI":
            ax.plot(xs[:n_pain], ys[:n_pain], "o", ms=ms, mfc=col, mec=col, mew=0.6, ls="none")
            ax.plot(xs[n_pain:], ys[n_pain:], "o", ms=ms, mfc="white", mec=col, mew=0.8, ls="none")
            xl = x0 + cols * pitch + 0.06
            ax.plot([xl + 0.03], [ym + 0.045], "o", ms=ms, mfc=col, mec=col, mew=0.6)
            ax.text(xl + 0.10, ym + 0.045, pain_labels[0], fontsize=6.4, ha="left", va="center", color=DARK)
            ax.plot([xl + 0.03], [ym - 0.045], "o", ms=ms, mfc="white", mec=col, mew=0.8)
            ax.text(xl + 0.10, ym - 0.045, pain_labels[1], fontsize=6.4, ha="left", va="center", color=DARK)
        else:
            ax.plot(xs[:an], ys[:an], "o", ms=ms, mfc=col, mec=col, mew=0.6, ls="none")
            ax.plot(xs[an:], ys[an:], "x", ms=ms * 0.9, mec=GREY, mew=1.0, ls="none")
            xe, ye = xs[-1], ys[-1]
            ax.annotate("1 excluded:\nfailed ENIGMA QC", xy=(xe + 0.05, ye),
                        xytext=(xe + 0.20, ye + 0.02), fontsize=6.0, ha="left", va="center",
                        color=MUTE, linespacing=1.2,
                        arrowprops=dict(arrowstyle="-", lw=0.5, color=MUTE, shrinkA=1, shrinkB=0))
    # Per-outcome table: rules level with the top and bottom dot rows.
    top, bot = rows[0][0] + 0.07, rows[1][0] - 2 * pitch - 0.07
    t0, t1 = 4.30, W - 0.05
    cx = [4.93, 5.30]
    ax.text(t0, 1.36, b("Included per outcome"), fontsize=7.0, ha="left", va="baseline", color=DARK)
    ax.plot([t0, t1], [top, top], color=DARK, lw=0.6)
    yc = top - 0.075
    for c, h in zip(cx, ["SCI", "CTRL"]):
        ax.text(c, yc, h, fontsize=6.6, ha="center", va="center", color=DARK)
    ax.plot([t0, t1], [yc - 0.075, yc - 0.075], color=DARK, lw=0.4)
    outcomes = [("Main$^{a}$", "33", "62"), ("Thalamus", "33", "61"), ("S1", "33", "58"),
                ("Clinical$^{b}$", "33", "–"), ("Pain$^{c}$", "33", "–")]
    dy = (yc - 0.075 - bot) / len(outcomes)
    for k, (lab, a, c) in enumerate(outcomes):
        y = yc - 0.075 - (k + 0.5) * dy
        ax.text(t0, y, lab, fontsize=6.6, ha="left", va="center", color=DARK)
        ax.text(cx[0], y, a, fontsize=7.0, ha="center", va="center", color=DARK)
        ax.text(cx[1], y, c, fontsize=7.0, ha="center", va="center", color=DARK)
    ax.plot([t0, t1], [bot, bot], color=DARK, lw=0.6)
    ax.text(0.06, 0.17, "$^{a}$ Brainstem, medullary compartments, DARTEL, DBM, aseg, hypothalamus "
            "and cerebellar lobules I to VI.\n$^{b}$ Within-SCI clinical model. $^{c}$ Pain-score "
            f"analyses. {pain_note}",
            fontsize=5.8, ha="left", va="center", color=MUTE, linespacing=1.4)
    save(fig, "figS1_sample_flow")


# ---------------------------------------------------- Figure 2: brainstem
def pmj_k():
    """Midline i and PMJ k of the brainstem DBM template: the ventral pontomedullary junction, the lowest
    pons (174) voxel on the midline sagittal plane. The top of the medulla label (k 69) is set by a stray
    off-midline strand and is not used."""
    lab = nii(private("bs_template_labels"))
    mid_i = int(round(np.nonzero(lab > 0)[0].mean()))
    k = int(np.nonzero((lab[mid_i] == 174).any(0))[0].min())
    assert (mid_i, k) == (67, 58), (mid_i, k)
    return mid_i, k


def draw_atlas(fig, H, y0):
    """Panel A: Allen medullary compartments on the brainstem DBM template, each filled with its adjusted
    d (t50 masks); five axial levels below the PMJ and a near-midline sagittal view with the levels
    marked."""
    from matplotlib.colors import TwoSlopeNorm
    tab = table("compartments")
    rois = [("R1_pyramid", "Pyr"), ("R2_olive", "IO"), ("R3_dcn_region", "DCN"),
            ("R4_tegmentum_rest", "Teg"), ("R5_icp", "ICP")]
    dval = {k: f(pick(tab, threshold="t50", set="family R1-R5", measure=k)["d"]) for k, _ in rois}
    t = nii(private("bs_template"))
    med = nii(private("bs_template_labels")) == 175
    M = {k: nii(private("compartment_masks", f"{k}_t50.nii.gz")) > 0 for k, _ in rois}
    c = np.array(np.nonzero(med)).mean(1).round().astype(int)
    mid_i, top = pmj_k()
    h = 13
    xs, ys = slice(c[0] - h, c[0] + h + 1), slice(c[1] - h, c[1] + h + 1)
    cmap = plt.get_cmap("RdBu_r")
    norm = TwoSlopeNorm(vmin=-1.6, vcenter=0, vmax=1.6)
    lo, hi = np.percentile(t[xs, ys, top - 19:top + 11], [1, 99.5])
    levels = [-1, 5, 10, 15, 19]  # Millimeters below the ventral PMJ (k 59, 53, 48, 43, 39).
    side, gap, x0 = 0.95, 0.08, 0.30
    yb = y0 + 0.24
    box = dict(boxstyle="round,pad=0.10", fc="white", ec="none", alpha=0.85)
    ALPHA = {"R1_pyramid": 1.0}  # Fill opacity; others 0.9 (axial), 0.85 (sagittal).
    for i, mm in enumerate(levels):
        ax = fig.add_axes([(x0 + i * (side + gap)) / W2, yb / H, side / W2, side / H])
        k = top - mm
        ax.imshow(t[xs, ys, k].T, origin="lower", cmap="gray", vmin=lo, vmax=hi, interpolation="nearest")
        for key, short in rois:
            m = M[key][xs, ys, k]
            if not m.any():
                continue
            rgba = np.zeros(m.shape + (4,))
            rgba[m] = cmap(norm(dval[key]))
            # The small, pale pyramid gets an opaque fill and a heavier outline. The DCN label sits below
            # the slice so the central canal (a hole in its mask) shows.
            rgba[..., 3] = m * ALPHA.get(key, 0.9)
            ax.imshow(np.transpose(rgba, (1, 0, 2)), origin="lower", interpolation="nearest")
            ax.contour(m.T.astype(float), [0.5], colors="black", linewidths=1.0 if key == "R1_pyramid" else 0.4)
            if m.sum() >= 6 and key == "R4_tegmentum_rest":
                ii, jj = np.nonzero(m)
                ax.text(ii.mean(), jj.mean(), short, ha="center", va="center", fontsize=7, bbox=box)
            elif m.sum() >= 6 and key == "R3_dcn_region":
                ii, jj = np.nonzero(m)
                sel = ii > h + 2  # Label below the slice, off the canal, with a leader to the right lobe.
                ax.annotate(short, (ii[sel].mean(), jj[sel].mean()), xytext=(h + 5, -0.8), ha="center",
                            va="top", fontsize=7, annotation_clip=False,
                            arrowprops=dict(arrowstyle="-", lw=0.4, color="black"))
            elif m.sum() >= 6 and key == "R1_pyramid":
                ii, jj = np.nonzero(m)
                ax.annotate(short, (ii.mean(), jj.max()), xytext=(ii.mean(), 2 * h - 1), ha="center",
                            va="top", fontsize=7, bbox=box,
                            arrowprops=dict(arrowstyle="-", lw=0.4, color="black"))
            elif m.sum() >= 6 and key in ("R2_olive", "R5_icp"):
                ii, jj = np.nonzero(m)
                sel = ii > h  # Label the participant's right side only.
                if sel.sum() >= 3:
                    dy = 3 if key == "R2_olive" else -5
                    ax.annotate(short, (ii[sel].mean(), jj[sel].mean()), xytext=(2 * h - 1, jj[sel].mean() + dy),
                                ha="right", va="center", fontsize=7, bbox=box,
                                arrowprops=dict(arrowstyle="-", lw=0.4, color="black"))
        ax.contour(med[xs, ys, k].T.astype(float), [0.5], colors="0.55", linewidths=0.5, linestyles=":")
        ax.set_axis_off()
        ax.set_title(f"{mm} mm below PMJ" if mm >= 0 else f"{-mm} mm above PMJ", fontsize=7.2, pad=2)
        if i == 0:
            for txt, (u, v, ha, va) in {"A": (h, 2 * h - 0.6, "center", "top"), "P": (h, 0.6, "center", "bottom"),
                                        "L": (0.6, h, "left", "center"),
                                        "R": (2 * h - 0.6, h, "right", "center")}.items():
                ax.text(u, v, txt, ha=ha, va=va, fontsize=7, color="white", path_effects=DARKHALO)
            mm_bar(ax, 0, -2.2, 5, "5 mm")
            panel_letter(ax, "a", x=-0.04, y=1.13)
    # Sagittal, near midline, with the axial levels.
    zs = slice(top - 31, top + 19)
    sw = 0.60
    sh = sw * 50 / 27
    xs0 = x0 + 5 * (side + gap) + 0.05
    ax = fig.add_axes([xs0 / W2, (yb + side - sh) / H, sw / W2, sh / H])
    ax.imshow(t[c[0], ys, zs].T, origin="lower", cmap="gray", vmin=lo, vmax=hi, interpolation="nearest")
    for key, _ in rois:
        m = M[key][c[0] - 2:c[0] + 3].any(0)[ys, zs]
        if m.any():
            rgba = np.zeros(m.shape + (4,))
            rgba[m] = cmap(norm(dval[key]))
            rgba[..., 3] = m * ALPHA.get(key, 0.85)
            ax.imshow(np.transpose(rgba, (1, 0, 2)), origin="lower", interpolation="nearest")
    ax.contour(med[c[0], ys, zs].T.astype(float), [0.5], colors="0.55", linewidths=0.5, linestyles=":")
    ax.set_autoscale_on(False)
    ax.invert_xaxis()  # Anterior on the left, as in panel D and Fig. 1.
    for mm in levels:
        zk = (top - mm) - zs.start
        ax.plot([-0.5, 2 * h + 0.5], [zk, zk], color="black", lw=0.4, ls=(0, (2, 1.5)), clip_on=False)
        ax.text(-1.5, zk, f"{mm}" if mm >= 0 else f"−{-mm}", fontsize=7, va="center", ha="left")
    ax.text(1, 2, "P", color="white", fontsize=7, ha="right", path_effects=DARKHALO)
    ax.text(2 * h - 1, 2, "A", color="white", fontsize=7, ha="left", path_effects=DARKHALO)
    ax.set_axis_off()
    ax.set_title("Sagittal", fontsize=7.2, pad=2)
    # Color bar.
    cx0 = xs0 + sw + 0.32
    cax = fig.add_axes([cx0 / W2, (yb + 0.05) / H, 0.06 / W2, (side + 0.30) / H])
    cb = fig.colorbar(matplotlib.cm.ScalarMappable(norm=norm, cmap=cmap), cax=cax,
                      ticks=[-1.5, -1, -0.5, 0, 0.5, 1, 1.5])
    cb.ax.tick_params(labelsize=7, length=1.5, width=0.4, pad=1)
    cb.outline.set_linewidth(0.4)
    cb.set_label(r"Adjusted $d$, SCI $-$ CTRL", fontsize=7.2, labelpad=2)


def draw_voxel(fig, H, y0, y1):
    """Panel D: voxelwise t (SCI minus CTRL) of the brainstem DBM on its template: sagittal at the x
    centroid of the template brainstem labels, and axial planes through the peaks of the medullary and
    the pontine cluster (two-direction TFCE FWE P < 0.05)."""
    import nibabel as nib
    from matplotlib import patheffects as pe
    aff = nib.load(str(private("bs_stats", "template_crop.nii.gz"))).affine
    tpl = nii(private("bs_stats", "template_crop.nii.gz"))
    # The cropped and the full template must share world coordinates for the PMJ shift.
    fin = nib.load(str(private("bs_template")))
    fdat = np.asarray(fin.dataobj, dtype=float)
    ci = np.argwhere(tpl != 0)[::997]
    fi = np.rint(np.linalg.solve(fin.affine, aff @ np.c_[ci, np.ones(len(ci))].T)[:3]).astype(int).T
    assert np.array_equal(fdat[tuple(fi.T)], tpl[tuple(ci.T)]), "The crop and the final image differ in world space."

    def zfin(k):
        return (fin.affine @ [0, 0, k, 1])[2]

    mask = nii(private("bs_stats", "mask.nii.gz")) > 0
    labels = nii(private("bs_stats", "labels_crop.nii.gz"))
    parts = {k: nii(private("bs_stats", f"roi_{k}.nii.gz")) > 0 for k in ("midbrain", "pons", "medulla")}
    t = nii(private("bs_design", "tstat1.nii.gz"))  # Contrast [1 -1 0 0 0]: SCI minus CTRL.
    sig = two_direction_sig(mask)
    cl = table("dbm_bs_clusters")  # Clusters at two-direction P_FWE < 0.05, both directions.
    med = max(cl, key=lambda r: f(r["frac_medulla"]))
    pon = max(cl, key=lambda r: f(r["frac_pons"]))

    def kz_of(r):
        v = np.linalg.solve(aff, [f(r["peak_x"]), f(r["peak_y"]), f(r["peak_z"]), 1])
        k = tuple(int(round(x)) for x in v[:3])
        # The peak_t value is the largest t of the cluster's own contrast; tstat2 = -tstat1.
        sgn = -1.0 if r["direction"] == "SCI < CTRL" else 1.0
        assert abs(t[k] - sgn * f(r["peak_t"])) < 1e-4, "A peak differs from voxel_clusters.csv."
        return k[2]

    levels = [(kz_of(med), med), (kz_of(pon), pon)]
    if pon is med:  # No pontine cluster: the second axial view goes through mid-pons instead.
        kp = int(round(np.nonzero(parts["pons"])[2].mean()))
        levels[1] = (kp, {"mid_pons": True})
    cx = int(round(np.nonzero(labels > 0)[0].mean()))
    vm = float(np.ceil(np.abs(t[mask]).max()))
    glo, ghi = np.percentile(tpl, [1, 99.5])

    def crop(m2, pad):
        a, b = np.nonzero(m2)
        return (slice(max(a.min() - pad, 0), a.max() + pad + 1), slice(max(b.min() - pad, 0), b.max() + pad + 1))

    sj, sk = crop(mask[cx], 4)
    views = [("sag", lambda v: v[cx, sj, sk].T[:, ::-1], None)]  # Anterior on the left, as in Fig. 1.
    for kz, r in levels:
        ai, aj = crop(mask[:, :, kz], 6)
        views.append(("ax", lambda v, ai=ai, aj=aj, kz=kz: v[ai, aj, kz].T, r))
    ny, nx = views[0][1](tpl).shape
    S = min(0.032, (y1 - y0 - 0.55) / ny)  # Inches per template mm, sagittal; fits below y1.
    yb = y0 + 0.30
    ytop = yb + ny * S
    # The axial views share one larger scale that fills the width beside the sagittal view.
    axw = sum(g(tpl).shape[1] for _, g, _ in views[1:])
    axh = max(g(tpl).shape[0] for _, g, _ in views[1:])
    SA = min((W2 - 0.30 - nx * S - 0.80 - 0.30 - 0.85) / axw, (ny * S - 0.45) / axh)
    halo = [pe.Stroke(linewidth=1.3, foreground="white"), pe.Normal()]
    x = 0.30
    axes = []
    for key, g, r in views:
        rows, cols = g(tpl).shape
        sc = S if key == "sag" else SA
        ax = fig.add_axes([x / W2, (ytop - rows * sc) / H, cols * sc / W2, rows * sc / H])
        axes.append((ax, cols * sc))
        x += cols * sc + (0.80 if key == "sag" else 0.30)
        ax.imshow(g(tpl), origin="lower", cmap="gray", vmin=glo, vmax=ghi, interpolation="nearest")
        im = ax.imshow(np.ma.masked_where(~g(mask), g(t)), origin="lower", cmap="RdBu_r", vmin=-vm, vmax=vm,
                       interpolation="nearest")
        for rr in parts.values():
            if g(rr).any():
                cs = ax.contour(g(rr).astype(float), [0.5], colors="#777777", linewidths=0.45)
                cs.set_path_effects(halo)
        if g(sig).any():
            ax.contour(g(sig).astype(float), [0.5], colors="black", linewidths=0.9)
        ax.set_axis_off()
        mm_bar(ax, 0, -2.5, 10, "10 mm")
        if key == "sag":
            ax.text(1.5, rows - 2.5, "A", color="white", fontsize=7, va="center", path_effects=DARKHALO)
            ax.text(cols - 1.5, rows - 2.5, "P", color="white", fontsize=7, va="center", ha="right",
                    path_effects=DARKHALO)
            for name, rr in parts.items():  # Leader labels to the right of the sagittal view.
                rr2 = g(rr)
                ii, jj = np.nonzero(rr2)
                row = int(round(ii.mean()))
                edge = jj[ii == row].max() + 0.5
                ax.plot([edge, cols + 1.0], [row, row], color="#555555", lw=0.45, clip_on=False)
                ax.text(cols + 1.6, row, name.capitalize(), ha="left", va="center", fontsize=7)
            for kz, _ in levels:  # Ticks at the axial levels.
                ax.plot([-2.2, -0.6], [kz - sk.start] * 2, color="black", lw=0.8, clip_on=False)
                ax.plot([cols - 0.4, cols + 0.4], [kz - sk.start] * 2, color="black", lw=0.8, clip_on=False)
            panel_letter(ax, "d", x=-0.04, pad=2)
            ax.set_title("Sagittal, midline", fontsize=7.2, pad=2, loc="left")
        else:
            for txt, (u, v, ha, va) in {"A": (cols / 2, rows - 1.5, "center", "top"),
                                        "P": (cols / 2, 1.0, "center", "bottom"),
                                        "L": (1.0, rows / 2, "left", "center"),
                                        "R": (cols - 1.0, rows / 2, "right", "center")}.items():
                ax.text(u, v, txt, ha=ha, va=va, fontsize=7, color="white", path_effects=DARKHALO)
            if r.get("mid_pons"):
                where = "Axial, mid-pons"
            else:
                # Distance from the ventral PMJ in world z, as in voxel_clusters.csv.
                dmm = zfin(pmj_k()[1]) - f(r["peak_z"])
                assert abs(dmm - f(r["peak_mm_below_pmj"])) < 1e-6, "The table's PMJ differs from the template's."
                if r is med:
                    assert abs(dmm - 17) < 1e-6, dmm
                where = ("Axial, " if r is med else "") + (
                    f"{dmm:.0f} mm below PMJ" if dmm > 0 else f"{-dmm:.0f} mm above PMJ")
                print(f"Fig. 2D axial view through a cluster peak: {where}.")
            ax.set_title(where, fontsize=7.2, pad=2, loc="left")
    # Vertical color bar at the right edge; key under the medullary axial view.
    kx = 0.30 + axes[0][1] + 0.80
    y_med = axes[1][0].get_position().y0 * H  # Key fills the space under the smaller medullary view.
    cax = fig.add_axes([(W2 - 0.55) / W2, (ytop - 1.45) / H, 0.07 / W2, 1.3 / H])
    cb = fig.colorbar(im, cax=cax, ticks=np.arange(-2 * (vm // 2), vm + 0.1, 2))
    cb.ax.tick_params(labelsize=7, length=1.5, width=0.4, pad=1)
    cb.outline.set_linewidth(0.4)
    cb.set_label(r"Voxel $t$, SCI $-$ CTRL", fontsize=7.2, labelpad=2)
    fig.legend(handles=[Line2D([], [], color="black", lw=0.9),
                        Line2D([], [], color="#777777", lw=0.45, path_effects=halo)],
               labels=["TFCE cluster,\ntwo-direction\nFWE $P < 0.05$", "Template midbrain,\npons and medulla"],
               loc="upper left", bbox_to_anchor=(kx / W2, (y_med - 0.36) / H), frameon=False,
               handlelength=1.8, fontsize=7, labelspacing=0.6, borderaxespad=0, ncol=1)


def fig2():
    sf, dar, dbm, wb = table("subfields"), table("dartel"), table("dbm_bs_roi"), table("dbm_wb_roi")

    def sub(m):  # Hedges g of the subfield volume.
        return es3(pick(sf, structure=m), "g_adj", "g_ci95_lo", "g_ci95_hi")

    def dt(region):  # Adjusted d of the DARTEL gray plus white matter region (unsmoothed).
        return es3(pick(dar, measure=f"{region}|gmwm_fwhm0"))

    def bs(roi):
        return es3(pick(dbm, roi=roi))

    def wbr(roi):
        return es3(pick(wb, roi=roi))

    methods = [
        ("FreeSurfer subfields ($g$)", BLUE, "o", False),
        ("FreeSurfer aseg", SKY, "s", False),
        ("SPM DARTEL grey + white matter", ORANGE, "D", False),
        ("Brainstem DBM", GREEN, "^", False),
        ("Whole-brain DBM region", PURPLE, "v", True),
    ]
    data = {
        "Medulla": [sub("Medulla"), None, dt("medulla_z"), bs("medulla"), wbr("medulla")],
        "Pons": [sub("Pons"), None, dt("pons_z"), bs("pons"), wbr("pons")],
        "Midbrain": [sub("Midbrain"), None, dt("midbrain_z"), bs("midbrain"), wbr("midbrain")],
        "Whole brainstem": [sub("Whole_brainstem"),
                            es3(pick(table("aseg"), measure="roi_Brain-Stem"), "d_adj"),
                            dt("brainstem"),
                            None,  # No brainstem DBM marker on this row.
                            wbr("brainstem_sf")],
    }

    # Inches: compartment maps on top, forest plots in the middle, voxelwise t below.
    TOP, LOW, MAPS = 3.35, 2.85, 1.62
    H = MAPS + TOP + LOW
    fig = plt.figure(figsize=(W2, H))

    def top_rect(x, y, w, h):  # Rect given as fractions of the 3.35 in forest block.
        return [x, (LOW + y * TOP) / H, w, h * TOP / H]

    ax = fig.add_axes(top_rect(0.13, 0.25, 0.33, 0.68))
    bx = fig.add_axes(top_rect(0.665, 0.25, 0.20, 0.68))

    structs = list(data)
    offs = [0.30, 0.15, 0.0, -0.15, -0.30]
    for i, s in enumerate(structs):
        y0 = len(structs) - 1 - i
        if i % 2 == 0:
            ax.axhspan(y0 - 0.45, y0 + 0.45, color="#F4F4F4", zorder=0, lw=0)
        for (_name, col, mk, hol), o, v in zip(methods, offs, data[s]):
            if v is None:
                continue
            ci_point(ax, y0 + o, *v, color=col, marker=mk, hollow=hol, ms=3.6)
    ax.set_yticks(range(len(structs)))
    ax.set_yticklabels(structs[::-1])
    ax.set_ylim(-0.55, len(structs) - 0.45)
    ax.set_xlim(-2.0, 0.4)
    zero_line(ax)
    ax.set_xlabel(r"Adjusted effect size, SCI $-$ CTRL (95% CI)")
    panel_letter(ax, "b", x=-0.26)
    handles = [Line2D([], [], color=c, marker=m, ms=3.6, mfc="white" if h else c, mew=0.9, lw=1.0, label=n)
               for n, c, m, h in methods]
    # Left-aligned below panel B (centered, the longer keys would run off the page).
    fig.legend(handles=handles, loc="lower left", bbox_to_anchor=(0.0, LOW / H),
               ncol=3, handlelength=1.6, columnspacing=1.0, borderaxespad=0.2)

    # Panel C: medullary compartments (brainstem DBM template, t50).
    comp = [
        ("R3_dcn_region", "Dorsal column nuclei\nregion (DCN)", True),
        ("R4_tegmentum_rest", "Rest of tegmentum (Teg)", True),
        ("R1_pyramid", "Pyramids (Pyr)", True),
        ("R2_olive", "Inferior olives (IO)", True),
        ("R5_icp", "Inferior cerebellar\npeduncles (ICP)", True),
        ("DCN_minus_SC", "DCN minus superior\ncolliculus (visual)", False),
        ("DCN_minus_IC", "DCN minus inferior\ncolliculus (auditory)", False),
    ]
    comp_d, tect = table("compartments"), table("tectal")  # Tectal rows: post hoc single Freedman-Lane tests.
    n = len(comp)
    ys = [n - 1 - i - (0.5 if i >= n - 2 else 0) for i in range(n)]
    for y, (m, _lab, fwe) in zip(ys, comp):
        if fwe:
            r = pick(comp_d, threshold="t50", set="family R1-R5", measure=m)
            p = converged("comp", "p_maxT", name=f"{m}_t50")  # Max-T FWE across the five compartments.
            ci_point(bx, y, *es3(r), GREEN, marker="^", ms=3.8)
            right_text(bx, y, fmt_p(p, r"P_{\mathrm{FWE}}"), x=1.02, big_sub=True)
        else:
            r = pick(tect, measure=m)
            p = converged("tect", "p_single", name=m)
            ci_point(bx, y, *es3(r), GREEN, marker="^", ms=3.8)
            right_text(bx, y, fmt_p(p, "P"), x=1.02)
        print(f"Fig. 2C {m}: d {f(r['d']):.2f} ({f(r['d_lo']):.2f}, {f(r['d_hi']):.2f}); "
              f"{'P_FWE' if fwe else 'P'} {f(p):.4f}")
    bx.axhline(1.25, color=GREY, lw=0.5)
    bx.set_yticks(ys)
    bx.set_yticklabels([c[1] for c in comp])
    bx.set_ylim(-1.0, n - 0.5)
    bx.set_xlim(-2.0, 0.4)
    zero_line(bx)
    bx.set_xlabel(r"Adjusted $d$, SCI $-$ CTRL (95% CI)")
    panel_letter(bx, "c", x=-0.80)
    draw_atlas(fig, H, LOW + TOP)
    draw_voxel(fig, H, 0.02, 2.88)
    save(fig, "fig2_brainstem_medulla")


# ------------------------------- Figure 4: clinical model, covariation, and pathway
def fig4():
    th = table("thalamus")
    a1 = [r for r in table("covariation") if r["sample"] == "all"]
    a2 = table("interaction")
    a3 = [r for r in table("clinical_model") if r["sample"] == "all"]

    # A and B share the left column; C fills the right column (inches).
    H = 3.6
    fig = plt.figure(figsize=(W2, H))

    def rect(x, y, w, h):
        return [x / W2, y / H, w / W2, h / H]

    ax = fig.add_axes(rect(4.62, 0.62, 1.50, 2.66))
    bx = fig.add_axes(rect(1.20, 2.32, 1.15, 0.96))
    cx = fig.add_axes(rect(1.20, 0.86, 1.15, 0.86))

    def title(a, x, letter, s):
        """Panel letter and title on one baseline (title bottom at 2% of the axes height above it, plus
        the 8 pt descent)."""
        d8 = -matplotlib.textpath.TextPath(
            (0, 0), "lp", size=8, prop=matplotlib.font_manager.FontProperties(family=SANS)).get_extents().y0
        pad = 0.02 * a.get_position().height * H * 72 + d8
        panel_letter(a, letter, x=x, pad=pad)
        a.text(x + 0.03, 1.0, s, transform=matplotlib.transforms.offset_copy(
            a.transAxes, fig=fig, y=pad, units="points"), ha="left", va="baseline", fontsize=8)

    # C: relay-station effects. Max-T FWE from the converged runs: five compartments, six thalamic groups, and
    # the 18 M1 and S1 parcel areas and volumes.
    r = pick(table("compartments"), threshold="t50", set="family R1-R5", measure="R3_dcn_region")
    rel = [("DCN region", es3(r), converged("comp", "p_maxT", name="R3_dcn_region_t50"))]
    for o, lab in (("Ventral_bi", "Ventral thalamic group"), ("Posterior_bi", "Posterior thalamic group")):
        r = pick(th, measure=o)
        rel.append((lab, es3(r, "d_adj"), converged("thal", "p_fwe", family="thal6", name=o)))
    s1 = table("s1")
    for m, lab in (("area_S1_trunk", "S1 trunk area"),
                   ("area_S1_upperlimb_headface", "S1 upper limb, head\nand face area")):
        p = converged("soma", "p_fwe", family="secondary_size", name=m)
        rel.append((lab, es3(pick(s1, measure=m), "d_adj"), p))
    n = len(rel)
    for i, (lab, p, pf) in enumerate(rel):
        y = n - 1 - i
        if i == 0:  # DCN region: brainstem DBM, green triangle as in Fig. 2C and panel A.
            ci_point(ax, y, *p, GREEN, marker="^", ms=4.4)
        else:
            ci_point(ax, y, *p, BLUE)
        right_text(ax, y, fmt_p(pf, r"P_{\mathrm{FWE}}"), x=1.02, size=7.2, big_sub=True)
        print(f"Fig. 4C {lab!r}: d {p[0]:.2f} ({p[1]:.2f}, {p[2]:.2f}); {fmt_p(pf, 'P_FWE')}")
    ax.set_yticks(range(n))
    ax.set_yticklabels([x[0] for x in rel][::-1], fontsize=7.5)
    ax.set_ylim(-0.6, n - 0.4)
    ax.set_xlim(-2.0, 0.4)
    zero_line(ax)
    ax.set_xlabel(r"Adjusted $d$, SCI $-$ CTRL (95% CI)")
    title(ax, -0.66, "c", "Somatosensory pathway, SCI vs CTRL")

    # A: clinical model of the DCN region (% difference, 95% CI).
    terms = []
    for t, lab in (("cervical", "Cervical vs\nthoracic or lumbar"),
                   ("ais_a", "AIS A vs B to D"),
                   ("years_since_injury", "Per 10 years\nsince injury")):
        r = pick(a3, term=t)
        if t == "years_since_injury":  # Rescale log-ratio per year to per 10 years.
            vals = [100 * (math.exp(10 * f(r[k])) - 1) for k in ("beta", "beta_lo", "beta_hi")]
        else:
            vals = [f(r[k]) for k in ("pct", "pct_lo", "pct_hi")]
        terms.append((lab, vals, r["p"]))
    n = len(terms)
    for i, (lab, v, p) in enumerate(terms):
        y = n - 1 - i
        ci_point(bx, y, *v, GREEN, marker="^", ms=4.4)
        right_text(bx, y, fmt_p(p), x=1.02, size=7.2)
        print(f"Fig. 4A {lab!r}: {v[0]:.1f}% ({v[1]:.1f}%, {v[2]:.1f}%); {fmt_p(p)}")
    bx.set_yticks(range(n))
    bx.set_yticklabels([t[0] for t in terms][::-1], fontsize=7.5)
    bx.set_ylim(-0.6, n - 0.4)
    bx.set_xlim(-22, 3)
    zero_line(bx)
    bx.set_xlabel(r"DCN region volume (%, 95% CI)")
    title(bx, -0.80, "a", rf"Clinical model within SCI ($n = {a3[0]['n']}$)")

    # B: partial correlations along the pathway.
    pr = [("DCN–ventral\nthalamic group", ("dcn", "thal_ventral")),
          ("Ventral thalamic group–\nS1 trunk", ("thal_ventral", "s1_trunk_area")),
          ("DCN–S1 trunk", ("dcn", "s1_trunk_area"))]
    rows = []
    for lab, (x, y_) in pr:
        r = pick(a1, x=x, y=y_)
        rows.append((lab, [f(r[k]) for k in ("r", "r_lo", "r_hi")], fmt_p(r["p_holm"], r"P_{\mathrm{Holm}}")))
        print(f"Fig. 4B {x} - {y_}: r {f(r['r']):.2f} ({f(r['r_lo']):.2f}, {f(r['r_hi']):.2f}); "
              f"P_Holm {f(r['p_holm']):.4f}")
    cr = pick(a2)  # One row: the group-by-DCN-region interaction in all participants.
    ctrl = [f(cr[k]) for k in ("partial_r_ctrl", "partial_r_ctrl_lo", "partial_r_ctrl_hi")]
    print(f"Fig. 4B controls: r {ctrl[0]:.2f} ({ctrl[1]:.2f}, {ctrl[2]:.2f}); {fmt_p(cr['p'], 'P_interaction')}")
    n = len(rows)
    cx.axvspan(-0.49, 0.49, color="#EFEFEF", lw=0, zorder=0)
    for i, (_lab, v, p) in enumerate(rows):
        y = n - 1 - i
        ci_point(cx, y + (0.13 if i == 0 else 0), *v, VERM)
        right_text(cx, y + (0.2 if i == 0 else 0), p, x=1.02, size=7.2, big_sub=True)
    ci_point(cx, n - 1 - 0.17, *ctrl, GREY, marker="s", ms=3.6)
    right_text(cx, n - 1 - 0.24, fmt_p(cr["p"], r"P_{\mathrm{interaction}}"), x=1.02, size=7.2, color=GREY,
               big_sub=True)
    cx.set_yticks(range(n))
    cx.set_yticklabels([r[0] for r in rows][::-1], fontsize=7.5)
    cx.set_ylim(-0.6, n - 0.4)
    cx.set_xlim(-0.6, 1.0)
    cx.set_xticks([-0.5, 0, 0.5, 1.0])
    zero_line(cx)
    cx.set_xlabel(r"Partial $r$ (95% CI)")
    title(cx, -0.80, "b", "Partial correlations")
    h = [Line2D([], [], color=VERM, marker="o", ms=4, lw=1, label=r"SCI ($n = 33$)"),
         Line2D([], [], color=GREY, marker="s", ms=3.6, lw=1, label=r"CTRL ($n = 61$)"),
         Patch(color="#EFEFEF", label=r"$|r| < 0.49$ (power < 80%)")]
    fig.legend(handles=h, loc="upper left", bbox_to_anchor=((1.20 - 0.92) / W2, 0.36 / H),
               ncol=3, handlelength=1.4, columnspacing=1.0, handletextpad=0.5, borderaxespad=0)
    save(fig, "fig4_clinical_pathway")


# ------------------------------------------ Figure 6: stratification
def fig6():
    a = table("strata")
    b = table("strata_within")
    outs = [("dcn", "DCN region"), ("medulla_sf", "Medulla"),
            ("thal_ventral", "Ventral thalamic group"),
            ("s1_trunk_area", "S1 trunk area"),
            ("dbm_medulla", "DBM medullary cluster*"),
            ("dbm_non_medullary", "DBM non-medullary\ncluster*")]
    panels = [("Level", [("Level", "Cervical", VERM, False), ("Level", "Thoracic/lumbar", BLUE, False)],
               ["Cervical", "Thoracic or lumbar"]),
              ("Completeness", [("Completeness", "AIS A", VERM, False), ("Completeness", "AIS B-D", BLUE, False)],
               ["AIS A", "AIS B to D"]),
              ("Pain", [("Pain", "NPRS > 3", VERM, False), ("Pain", "NPRS <= 3", BLUE, False)],
               ["NPRS > 3 ({n})", "NPRS ≤ 3 ({n})"])]
    # Inches: 0.258 per row, with fixed margins for the titles above and the legends below.
    n = len(outs)
    top_in, bot_in, row_in = 0.2925, 0.845, 0.2576
    ax_in = row_in * (n + 0.2)
    Hf = top_in + ax_in + bot_in
    fig, axes = plt.subplots(1, 3, figsize=(W2, Hf), sharey=True)
    fig.subplots_adjust(left=0.22, right=0.99, top=1 - top_in / Hf, bottom=bot_in / Hf, wspace=0.10)
    for k, (ax, (title, strata, labels)) in enumerate(zip(axes, panels)):
        for i, (o, _lab) in enumerate(outs):
            y = n - 1 - i
            if i % 2 == 0:
                ax.axhspan(y - 0.45, y + 0.45, color="#F4F4F4", lw=0, zorder=0)
            al = pick(a, stratifier="All SCI", stratum="All SCI", outcome=o)
            ax.plot([f(al["d"])] * 2, [y - 0.32, y + 0.32], color=DARK, lw=0.9, zorder=2)
            for j, (st, sm, col, hol) in enumerate(strata):
                r = pick(a, stratifier=st, stratum=sm, outcome=o)
                ci_point(ax, y + (0.16 if j == 0 else -0.16), f(r["d"]), f(r["d_lo"]), f(r["d_hi"]), col,
                         hollow=hol, ms=3.8, lw=0.9)
        ax.axhline(1.5, color=GREY, lw=0.5)  # Selected DBM clusters below.
        ax.set_xlim(-3.3, 3.3)
        ax.set_xticks([-3, -2, -1, 0, 1, 2, 3])
        zero_line(ax)
        ns = []
        for st, sm, _, _ in strata:
            r = pick(a, stratifier=st, stratum=sm, outcome="dcn")
            ns.append(int(float(r["n_sci"])))
        print(f"Fig. 6 {title}: SCI n per stratum {ns}.")
        ax.set_title(title, fontsize=8.5, pad=3)
        h = [Line2D([], [], color=c, marker="o", ms=3.8, lw=0.9, mfc="white" if hol else c,
                    label=lab.format(n=nn) if "{n}" in lab else f"{lab} ({nn})")
             for (_, _, c, hol), lab, nn in zip(strata, labels, ns)]
        ax.legend(handles=h, loc="upper center", bbox_to_anchor=(0.5, -0.359 / ax_in), ncol=1,
                  handlelength=1.4, labelspacing=0.3)
        panel_letter(ax, "abc"[k], x=0.0 if k else -0.03, pad=3)  # On the title baseline.
    # Mark the single within-SCI BH survivor (cervical vs T/L on DCN).
    s = pick(b, stratifier="cervical", outcome="dcn")
    axes[0].text(3.15, n - 1, rf"$q = {f(s['q_bh']):.3f}$", ha="right", va="center", fontsize=7.2, color=DARK)
    print(f"Fig. 6A q (cervical vs thoracic or lumbar, DCN region): {f(s['q_bh']):.3f}")
    axes[0].set_yticks(range(n))
    axes[0].set_yticklabels([o[1] for o in outs][::-1])
    axes[0].set_ylim(-0.6, n - 0.4)
    axes[1].set_xlabel(r"Adjusted $d$, stratum vs CTRL (95% CI)")
    fig.legend(handles=[Line2D([], [], color=DARK, marker="|", ms=8, lw=0, mew=0.9, label="All SCI (33)")],
               loc="upper left", bbox_to_anchor=(0.05, 0.484 / Hf), borderaxespad=0,
               handlelength=0.6, handletextpad=0.6)
    save(fig, "fig6_stratification")


# --------------------------- Supplementary figure 2: DARTEL white matter
def figS2():
    """Voxelwise DARTEL white matter result (SPM25 DARTEL, MNI 1.5 mm, FWHM 8 mm, randomise TFCE,
    SCI < CTRL, 5,000 permutations): t (SCI minus CTRL) inside the analysis mask, the cluster at doubled
    one-direction P_FWE < 0.05, on the mean GM + WM image of the analyzed participants. Slices pass
    through the cluster's peak t; four axial levels span the cluster."""
    import nibabel as nib

    def can(key):  # RAS: left on the left below.
        return nib.as_closest_canonical(nib.load(str(config.output_dir("dartel") / DARTEL_MAPS[key])))

    timg = can("t")
    aff = timg.affine
    assert nib.aff2axcodes(aff) == ("R", "A", "S")
    t = np.asarray(timg.dataobj, float)  # SCI minus CTRL.
    mask = np.asarray(can("mask").dataobj) > 0
    clus = np.asarray(can("cluster").dataobj) > 0  # Largest 26-connected cluster at doubled P_FWE < 0.05.
    pk = np.unravel_index(np.argmin(np.where(clus, t, np.inf)), t.shape)

    def mni(ijk):
        return aff @ np.r_[ijk, 1]

    ml = clus.sum() * 1.5 ** 3 / 1000
    print(f"Supplementary Fig. 2 cluster: {clus.sum()} voxels, {ml:.2f} mL; peak t {t[pk]:.2f} at MNI {mni(pk)[:3]}")
    # Underlay: mean T1-like composite (0.5 GM + WM, modulated, unsmoothed) of the analyzed participants.
    tpl = 0.5 * np.asarray(can("gm").dataobj, np.float32) + np.asarray(can("wm").dataobj, np.float32)
    head = tpl > 0.05
    glo, ghi = np.percentile(tpl[head], [1, 99.5])
    vm = float(np.ceil(np.abs(t[mask]).max()))
    ci, cj, ck = pk

    def win(axis, lo, hi):  # Index slice of an MNI window (mm) along one axis.
        a, b = ((np.array([lo, hi]) - aff[axis, 3]) / aff[axis, axis]).round().astype(int)
        return slice(max(a, 0), min(b, tpl.shape[axis] - 1) + 1)

    # Fixed MNI windows on the brainstem and posterior fossa (the only cluster is caudal medullary).
    si, sj, sk = win(0, -60, 60), win(1, -100, 8), win(2, -84, 6)
    sk2, ai, aj = sk, win(0, -57, 57), win(1, -96, 6)
    # Axial levels: 4 planes evenly spanning the cluster.
    zz = np.nonzero(clus.any((0, 1)))[0]
    lev = np.linspace(zz.min() + 1, zz.max() - 1, 4).round().astype(int)
    views = {"sag": lambda v: v[ci, sj, sk].T[:, ::-1],  # Anterior on the left.
             "cor": lambda v: v[si, cj, sk2].T}          # Participant's left on the left.
    for k, z in enumerate(lev):
        views[f"ax{k}"] = lambda v, z=z: v[ai, aj, z].T

    LEG = 1.75
    ns = views["sag"](tpl).shape
    nc = views["cor"](tpl).shape
    na = views["ax0"](tpl).shape
    X0 = 0.24  # Room for the level numbers left of A.
    S1 = (W2 - X0 - LEG - 0.30 - 0.15) / (ns[1] + nc[1])
    SA = (W2 - 0.10 - 3 * 0.15) / (4 * na[1])
    ya = 0.30
    H = ya + na[0] * SA + 0.62 + max(ns[0], nc[0]) * S1 + 0.30
    fig = plt.figure(figsize=(W2, H))

    def draw(key, x, y, s):
        g = views[key]
        rows, cols = g(tpl).shape
        ax = fig.add_axes([x / W2, y / H, cols * s / W2, rows * s / H])
        ax.imshow(np.ma.masked_where(~g(head), g(tpl)), origin="lower", cmap="gray", vmin=glo, vmax=ghi,
                  interpolation="nearest")
        ax.set_facecolor("black")
        im = ax.imshow(np.ma.masked_where(~g(mask), g(t)), origin="lower", cmap="RdBu_r", vmin=-vm, vmax=vm,
                       interpolation="nearest")
        if g(clus).any():
            ax.contour(g(clus).astype(float), [0.5], colors="black", linewidths=0.8)
        ax.set_xlim(-0.5, cols - 0.5)
        ax.set_ylim(-0.5, rows - 0.5)
        ax.set_xticks([])
        ax.set_yticks([])
        for sp in ax.spines.values():
            sp.set_visible(False)
        return ax, im, rows, cols

    def orient(ax, rows, cols, pairs):
        for txt, u, v in pairs:
            ax.text(u * cols, v * rows, txt, ha="center", va="center", fontsize=7, color="white",
                    path_effects=DARKHALO)

    def mark(ax, u, v):  # Peak t voxel.
        ax.plot([u], [v], marker="+", ms=6, mew=1.0, color="white", zorder=5,
                path_effects=[_pe.withStroke(linewidth=2.0, foreground="black")])

    def bar(ax, s, mm=20):
        ax.plot([0, mm / 1.5], [-0.12 / s] * 2, color="black", lw=1.0, solid_capstyle="butt", clip_on=False)
        ax.text(mm / 1.5 + 0.06 / s, -0.12 / s, f"{mm} mm", ha="left", va="center", fontsize=7)

    def head_text(x, y, letter, s):
        """Title at (x, y); the panel letter sits on the title's baseline, found at draw time (math in a
        title deepens its descent)."""
        t = fig.text((x + 0.17) / W2, y / H, s, ha="left", va="bottom", fontsize=7.5)

        def baseline(renderer):
            bb = t.get_window_extent(renderer)
            # Matplotlib 3.11 returns the descent inside the per-line layout.
            return matplotlib.transforms.Affine2D().translate(bb.x0, bb.y0 + t._get_layout(renderer)[1][-1][1][2])
        fig.add_artist(matplotlib.text.Annotation(
            f"{letter}.", (0, 0), xycoords=baseline, xytext=(-0.17 * 72, 0), textcoords="offset points",
            ha="left", va="baseline", fontsize=LETTER_PT, **BOLDKW))

    ytop = H - 0.30
    ax, im, rows, cols = draw("sag", X0, ytop - ns[0] * S1, S1)
    orient(ax, rows, cols, (("A", 0.05, 0.94), ("P", 0.95, 0.94)))
    mark(ax, cols - 1 - (cj - sj.start), ck - sk.start)
    # Axial levels as in Fig. 5: plain numbers and outside ticks, with a short white tick into the image
    # (Fig. 5 lengths in 1 mm voxels, divided by 1.5 for these 1.5 mm voxels).
    for k, z in enumerate(lev):
        zr = z - sk.start
        ax.plot([-3.0, -0.55], [zr, zr], color="black", lw=0.6, clip_on=False)
        ax.plot([-0.35, 3.7], [zr, zr], color="white", lw=0.8, zorder=3)
        ax.text(-3.7, zr, str(k + 1), ha="right", va="center", fontsize=7)
    bar(ax, S1)
    head_text(X0 - 0.18, ytop + 0.05, "A", rf"Sagittal, $x = {mni(pk)[0]:.1f}$ mm, through the peak")
    xc = X0 + ns[1] * S1 + 0.15
    ax, _, rows, cols = draw("cor", xc, ytop - nc[0] * S1, S1)
    orient(ax, rows, cols, (("L", 0.06, 0.94), ("R", 0.94, 0.94)))
    mark(ax, ci - si.start, ck - sk2.start)
    head_text(xc, ytop + 0.05, "B", rf"Coronal, $y = {mni(pk)[1]:.1f}$ mm, through the peak")
    # Legend column.
    xl = xc + nc[1] * S1 + 0.30
    cax = fig.add_axes([xl / W2, (ytop - 0.35) / H, (LEG - 0.15) / W2, 0.085 / H])
    cb = fig.colorbar(im, cax=cax, orientation="horizontal", ticks=np.arange(-2 * (vm // 2), vm + 0.1, 2))
    cb.ax.xaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _p: f"${v:.0f}$"))
    cb.ax.tick_params(length=2, width=0.5, labelsize=7, pad=1.5)
    cb.outline.set_linewidth(0.5)
    cb.ax.set_title(r"Voxel $t$, SCI $-$ CTRL", fontsize=7.2, pad=3)
    fig.text(xl / W2, (ytop - 0.58) / H, "smaller in SCI", ha="left", va="top", fontsize=7, color="#4D4D4D")
    fig.text((xl + LEG - 0.15) / W2, (ytop - 0.58) / H, "larger in SCI", ha="right", va="top", fontsize=7,
             color="#4D4D4D")
    fig.legend(handles=[Line2D([], [], color="black", lw=0.8),
                        Line2D([], [], ls="none", marker="+", ms=6, mew=1.0, color="black")],
               labels=["TFCE cluster,\nFWE $P < 0.05$", "Peak $t$"],
               loc="upper left", bbox_to_anchor=(xl / W2, (ytop - 0.82) / H), frameon=False, handlelength=1.6,
               handletextpad=0.5, borderaxespad=0, borderpad=0, fontsize=7, labelspacing=0.6)
    pkx, pky, pkz = mni(pk)[:3]
    fig.text(xl / W2, (ytop - 1.38) / H,
             f"Cluster: {clus.sum():,} voxels, {ml:.1f} mL\n" rf"Peak $t = {t[pk]:.2f}$ at MNI" "\n"
             rf"${pkx:.1f}$, ${pky:.1f}$, ${pkz:.1f}$ mm" "\n" "Axial levels 1 to 4 are marked in A.",
             ha="left", va="top", fontsize=7, color="#4D4D4D", linespacing=1.3)
    # Axial row.
    head_text(0.10, ya + na[0] * SA + 0.20, "C", "Axial, levels 1 to 4 (MNI $z$)")
    zlev = []
    for k, z in enumerate(lev):
        x = 0.10 + k * (na[1] * SA + 0.15)
        ax, _, rows, cols = draw(f"ax{k}", x, ya, SA)
        zlev.append(mni((0, 0, z))[2])
        fig.text(x / W2, (ya + rows * SA + 0.03) / H, rf"{k + 1}  $z = {zlev[-1]:.1f}$ mm", ha="left",
                 va="bottom", fontsize=7)
        if z == pk[2]:
            mark(ax, ci - ai.start, cj - aj.start)
        if k == 0:
            orient(ax, rows, cols, (("L", 0.08, 0.5), ("R", 0.92, 0.5), ("A", 0.5, 0.92), ("P", 0.5, 0.08)))
            bar(ax, SA)
    print("Supplementary Fig. 2 axial levels, MNI z (mm):", ", ".join(f"{z:.1f}" for z in zlev))
    save(fig, "figS2_dartel_wm", transparent=False)


if __name__ == "__main__":
    figs = {"1": fig1, "2": fig2, "4": fig4, "6": fig6, "S1": figS1, "S2": figS2}
    for key in sys.argv[1:] or list(figs):
        figs[key]()
