"""Group-blind acceptance screen of every re-registered hemisphere.

Reads no group, pain, or clinical variable. For each participant-hemisphere with a finished job under the given
registration tag (fsavg/<tag>/<id>.<h>.sulc.mgh and label/<h>.aparc.<tag>.annot):
  fit:      the participant's sulc resampled through ?h.sphere.<tag>, correlated with fsaverage sulc over the dorsal
            frontoparietal set (DFP), the whole cortex, and each of the 34 fsaverage DK regions;
  geometry: precentral and postcentral mean thickness under the new DK labels on the participant's own surface,
            their difference, border sulc and thickness step, and the sizes of the two gyri;
  change:   fraction of cortex vertices whose DK label differs from the recon's aparc.annot.
The robust z of each regional fit uses the median and MAD (x 1.4826) of the same-side b40infl fits of the screen
reference (qc.cortical_screen_reference). Criteria: A1 r_dfp >= 0.80; A2 pre - post >= 0.22 mm (rh) or 0.30 mm
(lh); C fewer than three regions with z < -4. A hemisphere passes when it meets all three.
Usage: 10_screen.py TAG [TAG ...]. Writes screen_<tag>.tsv and screen_regions_<tag>.tsv under <work_dir>/cortex.
"""

import sys

import nibabel as nib
import numpy as np
import pandas as pd
import scipy.sparse as sp
from nibabel.freesurfer import read_annot, read_geometry, read_label, read_morph_data

import cortex_common as cc
from cortex_common import config

FSA = config.path("freesurfer.home") / "subjects/fsaverage"
DFP = ["precentral", "postcentral", "paracentral", "superiorparietal", "supramarginal",
       "caudalmiddlefrontal", "superiorfrontal"]
THR_R = 0.80
THR_C = {"rh": 0.22, "lh": 0.30}
REF_TAG = "b40infl"
subs = [x for x in (cc.WORK / "subjects.txt").read_text().split() if x]
ref_ids = set(cc.reference_ids())

fsa = {}
for h in ("lh", "rh"):
    lab, _, names = read_annot(FSA / "label" / f"{h}.aparc.annot")
    names = [n.decode() for n in names]
    nm = np.array([names[i] if i >= 0 else "unknown" for i in lab])
    regions = [r for r in sorted(set(nm)) if r not in ("unknown", "corpuscallosum")]
    assert len(regions) == 34
    fsa[h] = dict(sulc=read_morph_data(FSA / "surf" / f"{h}.sulc"), nm=nm, regions=regions,
                  dfp=np.isin(nm, DFP), ctx=~np.isin(nm, ["unknown", "corpuscallosum"]))


def corr(a, b):
    return float(np.corrcoef(a, b)[0, 1])


def names_of(annot_path):
    lab, _, names = read_annot(annot_path)
    names = [x.decode() for x in names]
    return np.array([names[i] if i >= 0 else "none" for i in lab])


def geometry(s, h, nm):
    _, faces = read_geometry(cc.FS / s / "surf" / f"{h}.white")
    sulc = read_morph_data(cc.FS / s / "surf" / f"{h}.sulc")
    thk = read_morph_data(cc.FS / s / "surf" / f"{h}.thickness")
    n = len(sulc)
    ctx = np.zeros(n, bool)
    ctx[read_label(cc.FS / s / "label" / f"{h}.cortex.label")] = True
    i = np.concatenate([faces[:, 0], faces[:, 1], faces[:, 2]])
    j = np.concatenate([faces[:, 1], faces[:, 2], faces[:, 0]])
    a = sp.coo_matrix((np.ones(len(i), np.int8), (i, j)), shape=(n, n)).tocsr()
    a = ((a + a.T) > 0).astype(np.int8)
    pre = (nm == "precentral") & ctx
    post = (nm == "postcentral") & ctx
    border = (pre & (a @ post.astype(np.int8) > 0)) | (post & (a @ pre.astype(np.int8) > 0))
    near = border.copy()
    for _ in range(3):
        near = near | (a @ near.astype(np.int8) > 0)
    return ctx, {"pre_thick": thk[pre].mean(), "post_thick": thk[post].mean(),
                 "pre_minus_post_thick": thk[pre].mean() - thk[post].mean(),
                 "border_sulc": sulc[border].mean() if border.any() else np.nan,
                 "border_thick_step": thk[near & pre].mean() - thk[near & post].mean(),
                 "post_nvert": int(post.sum()), "pre_nvert": int(pre.sum())}


def score(tag):
    rows, rrows = [], []
    for s in subs:
        for h in ("lh", "rh"):
            sulc_p = cc.WORK / "fsavg" / tag / f"{s}.{h}.sulc.mgh"
            annot = cc.SD / s / "label" / f"{h}.aparc.{tag}.annot"
            if not (sulc_p.exists() and annot.exists()):
                continue
            f = fsa[h]
            d = np.asarray(nib.load(sulc_p).dataobj).ravel().astype(float)
            nm = names_of(annot)
            ctx, g = geometry(s, h, nm)
            r = {"participant_id": s, "hemi": h, "tag": tag, "r_fsavg_dfp": corr(d[f["dfp"]], f["sulc"][f["dfp"]]),
                 "r_fsavg_cortex": corr(d[f["ctx"]], f["sulc"][f["ctx"]])}
            r.update(g)
            orig = names_of(cc.FS / s / "label" / f"{h}.aparc.annot")
            r["frac_cortex_relabelled"] = float((nm[ctx] != orig[ctx]).mean())
            rows.append(r)
            for reg in f["regions"]:
                m = f["nm"] == reg
                rrows.append((s, h, tag, reg, corr(d[m], f["sulc"][m])))
    return pd.DataFrame(rows), pd.DataFrame(rrows, columns=["participant_id", "hemi", "tag", "region", "r"])


def robust_ref():
    x = pd.read_csv(cc.WORK / f"screen_regions_{REF_TAG}.tsv", sep="\t")
    x = x[x.participant_id.isin(ref_ids)]
    g = x.groupby(["hemi", "region"]).r
    return pd.DataFrame({"med": g.median(), "mad": g.agg(lambda v: 1.4826 * np.median(np.abs(v - np.median(v)))),
                         "n": g.size()})


for tag in sys.argv[1:]:
    assert tag in ("b40infl", "b40"), tag
    geo, reg = score(tag)
    reg.to_csv(cc.WORK / f"screen_regions_{tag}.tsv", sep="\t", index=False, float_format="%.5f")
    ref = robust_ref()  # For b40infl, the file just written.
    assert int(ref.n.min()) == int(ref.n.max()) == len(ref_ids), "Screen reference hemispheres are incomplete."
    z = reg.join(ref, on=["hemi", "region"])
    reg["z"] = (z.r - z.med) / z.mad
    reg.to_csv(cc.WORK / f"screen_regions_{tag}.tsv", sep="\t", index=False, float_format="%.5f")
    fl = reg[reg.z < -4].groupby(["participant_id", "hemi"]).agg(
        n_regions_z_lt_4=("region", "size"), flagged_regions=("region", lambda v: ",".join(sorted(v))))
    mz = reg.groupby(["participant_id", "hemi"]).z.min().rename("min_region_z")
    geo = geo.join(fl, on=["participant_id", "hemi"]).join(mz, on=["participant_id", "hemi"])
    geo["n_regions_z_lt_4"] = geo.n_regions_z_lt_4.fillna(0).astype(int)
    geo["ref_n"] = int(ref.n.min())
    geo["A1_fit"] = geo.r_fsavg_dfp >= THR_R
    geo["A2_geometry"] = geo.pre_minus_post_thick >= geo.hemi.map(THR_C)
    geo["C_regional"] = geo.n_regions_z_lt_4 < 3
    geo["pass"] = geo.A1_fit & geo.A2_geometry & geo.C_regional
    geo["inverted"] = geo.pre_minus_post_thick < 0
    geo.to_csv(cc.WORK / f"screen_{tag}.tsv", sep="\t", index=False, float_format="%.5f")
    print(f"{tag}: hemispheres scored {len(geo)}; pass {int(geo['pass'].sum())}, fail {int((~geo['pass']).sum())} "
          f"(A1 {int((~geo.A1_fit).sum())}, A2 {int((~geo.A2_geometry).sum())}, C {int((~geo.C_regional).sum())}); "
          f"inverted {int(geo.inverted.sum())}; reference hemispheres per region {int(ref.n.min())}.")
