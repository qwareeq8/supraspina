"""Inputs of the voxelwise white matter analysis (FSL randomise).

Design: cell-means coding (EV1 SCI, EV2 CTRL) with demeaned age, sex, and SPM TIV; contrast 1 = CTRL - SCI, so
positive t means smaller white matter in SCI (the one tested direction). Rows in participant_id order.
Data: modulated white matter smoothed at 8 mm FWHM (smwc2), stacked in the same order (work folder).
Mask: mean smwc2 over all participants > 0.2 (output folder, vbm/mask_wm02.nii.gz).
"""

import shutil

import numpy as np

import dartel_common as dc

O = dc.WORK / "vbm"
O.mkdir(parents=True, exist_ok=True)
des = dc.design()
sci = des.sci.to_numpy(float)
X = np.column_stack([sci, 1 - sci] + [des[c].to_numpy(float) - des[c].to_numpy(float).mean() for c in dc.COV])
mat = (f"/NumWaves {X.shape[1]}\n/NumPoints {X.shape[0]}\n/PPheights {' '.join('%g' % v for v in np.ptp(X, 0))}\n"
       "/Matrix\n" + "".join(" ".join("%.8f" % v for v in r) + "\n" for r in X))
if (O / "design.mat").exists() and (O / "design.mat").read_text() != mat:
    shutil.rmtree(O / "rand", ignore_errors=True)  # Randomise chunks of an earlier design are stale.
(O / "design.mat").write_text(mat, newline="\n")
con = "-1 1" + " 0" * (X.shape[1] - 2)
(O / "c1.con").write_text(f"/ContrastName1 SCI<CTRL\n/NumWaves {X.shape[1]}\n/NumContrasts 1\n/PPheights 1\n"
                          f"/RequiredEffect 1\n/Matrix\n{con}\n", newline="\n")
des[["participant_id"]].to_csv(O / "order.csv", index=False)

aff, shp = dc.grid()
V = np.stack([dc.load(dc.mni("smwc2_fwhm8", pid)) for pid in des.participant_id], -1)
assert V.shape[:3] == shp
dc.save(V, aff, O / "smwc2_fwhm8_all.nii")
mask = (V.mean(-1) > 0.2).astype(np.uint8)
dc.save(mask, aff, dc.OUT / "vbm" / "mask_wm02.nii.gz")
print(f"n = {len(des)} ({int(sci.sum())} SCI, {int((1 - sci).sum())} CTRL); "
      f"white matter mask {int(mask.sum())} voxels.")
