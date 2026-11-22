"""Cut the display planes of Figure 1A to 1H from one healthy control.

Every image panel is a pipeline output of the one analyzed control named by figures.example_participant
in the private configuration; the identifier is never drawn or printed. Only windowed 2D display planes
and label planes are written, to config.work_dir("figures")/pipeline_panels.npz, which make_figures.py
reads; no volume, header field, or metadata is copied.
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
from nibabel.freesurfer import read_annot, read_geometry, read_morph_data
from scipy import ndimage
from scipy.io import loadmat

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

SID = str(config.get("figures.example_participant"))
FS = config.path("freesurfer.subjects_dir") / SID
LUT = config.path("freesurfer.home") / "FreeSurferColorLUT.txt"
OUT = config.work_dir("figures") / "pipeline_panels.npz"
# Participant-level outputs of the section scripts, {key: (section, path under config.work_dir(section))}.
INPUTS = {
    "subfields": ("subfields", f"subregions/{SID}/brainstemSsLabels.FSvoxelSpace.mgz"),  # From subfields/segment.sh.
    "thalamus": ("thalamus", f"out/{SID}/ThalamicNuclei.FSvoxelSpace.mgz"),  # From thalamus/segment.sh.
    # Brainnetome labels of the left hemisphere through the b40infl registration (cortex/02_hemi.sh).
    "s1_annot": ("cortex", f"subjects/{SID}/label/lh.BN_Atlas.b40infl.annot"),
    "dartel_gm": ("dartel", f"mni_zext/fwhm0/mwc1{SID}_T1w.nii"),
    "dartel_wm": ("dartel", f"mni_zext/fwhm0/mwc2{SID}_T1w.nii"),
    "bs_template": ("dbm_brainstem", "template/template_final.nii.gz"),
    "bs_template_labels": ("dbm_brainstem", "template/labels_subfields_majority.nii.gz"),
    "bs_template_mask": ("dbm_brainstem", "template/brainstem_mask_dil2.nii.gz"),
    "bs_logjac": ("dbm_brainstem", f"reg/{SID}_logjac_warp.nii.gz"),  # Log-Jacobian of the nonlinear warp.
    "bs_affine": ("dbm_brainstem", f"reg/{SID}_0GenericAffine.mat"),
    "compartment_masks": ("compartments", "rois"),  # Masks <compartment>_t50.nii.gz on the brainstem template.
    # Smoothed (FWHM 4 mm) log-Jacobians, one frame per participant in config.participants() order (22_roi.py).
    "wb_logjac": ("dbm_wholebrain", "stats/logjac_s4_all.nii.gz"),
    "wb_template": ("dbm_wholebrain", "stats/template_crop.nii.gz"),
    "wb_mask": ("dbm_wholebrain", "stats/mask.nii.gz"),
    "wb_labels": ("dbm_wholebrain", "stats/labels_aparc_crop.nii.gz"),
}


def src(key, name=""):
    section, rel = INPUTS[key]
    return config.work_dir(section) / rel / name


def ras(path):
    """Load a volume reoriented to RAS (axes x right, y anterior, z superior)."""
    img = nib.as_closest_canonical(nib.load(str(path)))
    return np.asarray(img.dataobj), img.affine


def window(a, mask=None, lo=1, hi=99.5):
    v = a[mask] if mask is not None else a[a > 0]
    p0, p1 = np.percentile(v, [lo, hi])
    return np.clip((a - p0) / (p1 - p0), 0, 1).astype(np.float32)


def sag(v, x):  # Sagittal plane, rows superior to inferior, anterior on the left.
    return np.flipud(v[x].T)[:, ::-1]


def cor(v, y):  # Coronal plane, rows superior to inferior, participant's left on the left.
    return np.flipud(v[:, y].T)


def axi(v, z):  # Axial plane, rows anterior to posterior, participant's left on the left.
    return np.flipud(v[:, :, z].T)


def bbox(m, pad):
    r = np.where(m.any(1))[0]
    c = np.where(m.any(0))[0]
    return slice(max(r[0] - pad, 0), r[-1] + pad + 1), slice(max(c[0] - pad, 0), c[-1] + pad + 1)


def lut_names():
    names = {}
    for line in LUT.read_text().splitlines():
        p = line.split()
        if len(p) >= 2 and p[0].isdigit():
            names[int(p[0])] = p[1]
    return names


panels = {}

# A: T1-weighted MPRAGE, whole head, parasagittal 3 mm left of the brain's center (the midline plane cuts
# the falx and blurs the medial cortex).
bm, aff = ras(FS / "mri/brainmask.mgz")
t1, _ = ras(FS / "mri/nu.mgz")  # Bias corrected; T1.mgz is clipped at white matter.
brain = bm > 0
# One gray window from all brain voxels, so slices do not saturate white matter.
g0, g1 = np.percentile(t1[brain], [0.5, 99.8])


def gwin(a):
    return np.clip((a - g0) / (g1 - g0), 0, 1).astype(np.float32)


cx = int(round(ndimage.center_of_mass(brain)[0])) - 3
# Crop to the whole brain's sagittal extent (one slice's mask clips the poles).
rs, cs = bbox(np.flipud(brain.any(axis=0).T)[:, ::-1], 6)
rs = slice(rs.start, rs.stop + 8)  # Down to the lower medulla.
panels["A_t1"] = gwin(sag(t1, cx))[rs, cs]

# B: FreeSurfer aseg over the T1, coronal through the thalamus.
aseg, _ = ras(FS / "mri/aseg.mgz")
thal = np.isin(aseg, (10, 49))
cy = int(round(ndimage.center_of_mass(thal)[1]))
tb = gwin(cor(np.where(brain, t1, 0), cy))
rs, cs = bbox(cor(brain, cy), 4)
panels["B_t1"] = tb[rs, cs]
panels["B_aseg"] = cor(aseg, cy)[rs, cs].astype(np.int16)

# C: brainstem subfields, parasagittal through the brainstem.
bs, _ = ras(src("subfields"))
bsm = np.isin(bs, (173, 174, 175, 178))
# Parasagittal plane near the midline that shows the SCP without losing the medulla.
x0 = int(round(ndimage.center_of_mass(bsm)[0]))
xs = np.arange(x0 - 8, x0 + 9)
med = np.array([(bs[x] == 175).sum() for x in xs])
scp = np.array([(bs[x] == 178).sum() for x in xs])
bx = int(xs[np.argmax(np.where(med >= 0.8 * med.max(), scp, -1))])
lab = sag(bs, bx).astype(np.int16)
rs, cs = bbox(sag(bsm, bx), 10)
panels["C_t1"] = gwin(sag(t1, bx))[rs, cs]
panels["C_lab"] = np.where(np.isin(lab, (173, 174, 175, 178)), lab, 0)[rs, cs]

# D: thalamic nuclei grouped as in the analysis, axial through the thalami.
th, _ = ras(src("thalamus"))
names = lut_names()
groups = {"Anterior": ["AV"], "Lateral": ["LD", "LP"],
          "Ventral": ["VA", "VAmc", "VLa", "VLp", "VPL", "VM"],
          "Intralaminar": ["CeM", "CL", "Pc", "CM", "Pf"],
          "Medial": ["Pt", "MV(Re)", "MDm", "MDl"],
          "Posterior": ["LGN", "MGN", "L-Sg", "PuA", "PuM", "PuL", "PuI"]}
gid = np.zeros(th.max() + 1, np.int8)
for code in np.unique(th[th > 0]):
    nm = names.get(int(code), "")
    nuc = nm.split("-", 1)[1] if "-" in nm else nm
    for g, ns in enumerate(groups.values(), start=1):
        if nuc in ns:
            gid[code] = g
tg = gid[th]
# Plane showing the most groups (at least 10 voxels each), then the largest area.
shown = np.stack([((tg == g).sum(axis=(0, 1)) >= 10) for g in range(1, 7)]).sum(0)
counts = (tg > 0).sum(axis=(0, 1))
tz = int(np.lexsort((counts, shown))[-1])
lab = axi(tg, tz)
rs, cs = bbox(lab > 0, 12)
panels["D_t1"] = gwin(axi(np.where(brain, t1, 0), tz))[rs, cs]
panels["D_lab"] = lab[rs, cs]
panels["D_groups"] = np.array(list(groups))

# E: Brainnetome S1 parcels on the left inflated surface (lateral view).
v, faces = read_geometry(str(FS / "surf/lh.inflated"))
sulc = read_morph_data(str(FS / "surf/lh.sulc"))
lab, ctab, nm = read_annot(str(src("s1_annot")))
nm = [n.decode() for n in nm]
roi = {"A1/2/3tru": 1, "A1/2/3ulhf": 2, "A1/2/3ll": 3, "A1/2/3tonIa": 4}
code = np.zeros(len(v), np.int8)
for i, n in enumerate(nm):
    for key, k in roi.items():
        if n.startswith(key):
            code[lab == i] = k
panels["E_v"] = v.astype(np.float32)
panels["E_f"] = faces.astype(np.int32)
panels["E_sulc"] = sulc.astype(np.float32)
panels["E_code"] = code

# F: DARTEL modulated gray plus white matter (the brainstem outcome) in MNI space, sagittal at x = -3 mm
# (x = 0 lies in the interhemispheric fissure).
img = nib.as_closest_canonical(nib.load(str(src("dartel_gm"))))
gm = np.asarray(img.dataobj, dtype=np.float32)
gm = gm + np.asarray(nib.as_closest_canonical(nib.load(str(src("dartel_wm")))).dataobj, dtype=np.float32)
i0 = int(round(np.linalg.solve(img.affine, [-3, -20, 0, 1])[0]))
g = sag(gm, i0)
rs, cs = bbox(np.flipud(gm.max(axis=0).T)[:, ::-1] > 0.05, 4)
panels["F_gm"] = g[rs, cs]

# G: brainstem DBM, total log-Jacobian (nonlinear plus affine) on the brainstem template, with the five
# medullary compartments (t50), sagittal through the DCN region.
tpl, _ = ras(src("bs_template"))
lj, _ = ras(src("bs_logjac"))
m = loadmat(str(src("bs_affine")))
key = [k for k in m if k.startswith("AffineTransform")][0]
lj = lj + float(np.log(abs(np.linalg.det(m[key][:9, 0].reshape(3, 3)))))
comp = np.zeros(tpl.shape, np.int8)
for k, n in enumerate(("R1_pyramid", "R2_olive", "R3_dcn_region", "R4_tegmentum_rest", "R5_icp"), start=1):
    mk, _ = ras(src("compartment_masks", f"{n}_t50.nii.gz"))
    comp[(mk > 0) & (comp == 0)] = k
gx = int(np.argmax((comp == 3).sum(axis=(1, 2))))
bsmask, _ = ras(src("bs_template_mask"))
rs, cs = bbox(sag(bsmask > 0, gx), 8)
panels["G_tpl"] = window(sag(tpl, gx), sag(bsmask > 0, gx))[rs, cs]
panels["G_lj"] = np.where(sag(bsmask > 0, gx), sag(lj, gx), np.nan)[rs, cs].astype(np.float32)
panels["G_comp"] = sag(comp, gx)[rs, cs]
# Undilated brainstem (midbrain, pons, medulla labels): the overlay is clipped to it.
bsl, _ = ras(src("bs_template_labels"))
panels["G_bs"] = sag(np.isin(bsl, (173, 174, 175)), gx)[rs, cs]

# H: whole-brain DBM, smoothed log-Jacobian (the analysis input) on the study template, axial through
# the thalami.
order = list(config.participants().participant_id)
img4 = nib.as_closest_canonical(nib.load(str(src("wb_logjac"))))
assert img4.shape[3] == len(order), "The 4D log-Jacobian stack must hold one frame per participant."
fr = np.asarray(img4.dataobj[..., order.index(SID)], dtype=np.float32)
tw, _ = ras(src("wb_template"))
mw, _ = ras(src("wb_mask"))
lw, _ = ras(src("wb_labels"))
hz = int(round(ndimage.center_of_mass(np.isin(lw, (10, 49)))[2]))
rs, cs = bbox(axi(tw > np.percentile(tw[tw > 0], 5), hz), 3)
panels["H_tpl"] = window(axi(tw, hz))[rs, cs]
panels["H_lj"] = np.where(axi(mw > 0, hz), axi(fr, hz), np.nan)[rs, cs]

np.savez_compressed(OUT, **panels)
print("Wrote", OUT, "with", ", ".join(sorted(panels)))
