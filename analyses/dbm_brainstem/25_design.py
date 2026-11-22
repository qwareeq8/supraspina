"""Voxelwise design for FSL randomise (SCI versus controls).

Design columns: SCI, CTRL, age, female, eTIV (liters), with the covariates demeaned within the analyzed
sample; contrasts C1 SCI > CTRL [1 -1 0 0 0] and C2 SCI < CTRL [-1 1 0 0 0]. The 4D input is the smoothed
total log-Jacobian stack of 22_roi.py without the participants in qc.dbm_registration_exclusions. Rows
follow participant order, on which the randomise permutations depend.
Writes stats/SCI_vs_CTRL/{logjac_s4.nii.gz,design.txt,contrasts.txt,subjects.txt} (participant level).
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402


def main():
    ST = config.work_dir("dbm_brainstem") / "stats"
    subs = config.participants()
    order = (ST / "stack_order.txt").read_text().split()
    assert order == subs.participant_id.tolist(), "The 4D stack is not in participant order; rerun 22_roi.py."
    img = nib.load(ST / "logjac_s4_all.nii.gz")
    arr = np.asarray(img.dataobj)
    assert arr.shape[-1] == len(subs)
    excl = set(config.ids(config.path("qc.dbm_registration_exclusions")))
    keep = ~subs.participant_id.isin(excl).values
    f = subs[keep]
    out = ST / "SCI_vs_CTRL"
    out.mkdir(exist_ok=True)
    nib.save(nib.Nifti1Image(arr[..., keep], img.affine, img.header), out / "logjac_s4.nii.gz")
    X = np.column_stack([f.sci.values, 1 - f.sci.values]
                        + [f[c].astype(float).values - f[c].astype(float).mean() for c in ("age", "female")]
                        + [(f.eTIV.values - f.eTIV.mean()) / 1e6])
    np.savetxt(out / "design.txt", X, fmt="%.6f")
    np.savetxt(out / "contrasts.txt", np.array([[1, -1, 0, 0, 0], [-1, 1, 0, 0, 0]]), fmt="%d")
    f.participant_id.to_csv(out / "subjects.txt", index=False, header=False)
    print(f"Design: {len(f)} participants, {int(f.sci.sum())} SCI.")


if __name__ == "__main__":
    main()
