"""Field-of-view check for the brainstem DBM.

In FreeSurfer conformed space (1 mm), the lowest voxel of the subfield medulla label (175) is compared
with the lowest voxel that holds image data within 25 mm of the brainstem axis (the x, y centroid of
the lowest 20 mm of the aseg Brain-Stem label). The conformed image is resampled from the Brain FOV
crop, so its data bottom is the crop's bottom. The brainstem crop of 02_crop.py reaches 28 mm below the
medulla, so every participant needs a gap of at least 28 mm. Writes fov_check.csv (participant level).
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

MIN_GAP_MM = 28


def subfield_labels(pid):
    return config.path("freesurfer.brainstem_subfields_dir") / pid / "brainstemSsLabels.FSvoxelSpace.mgz"


def ras(aff, mask):
    """World (RAS) coordinates of the voxels of a mask."""
    return aff[:3, :3] @ np.array(np.nonzero(mask)) + aff[:3, 3:4]


def main():
    fs = config.path("freesurfer.subjects_dir")
    rows = []
    for pid in config.participants().participant_id:
        t1 = nib.load(fs / pid / "mri/T1.mgz")
        aff = t1.affine
        T = np.asarray(t1.dataobj)
        aseg = np.asarray(nib.load(fs / pid / "mri/aseg.mgz").dataobj)
        bsl = nib.load(subfield_labels(pid))
        assert np.allclose(bsl.affine, aff)
        B = np.asarray(bsl.dataobj)

        r_bs, r_med, r_nz = (ras(aff, m) for m in (aseg == 16, B == 175, T > 0))
        bs_bot, med_bot = r_bs[2].min(), r_med[2].min()
        low = r_bs[:, r_bs[2] < bs_bot + 20]
        cx, cy = low[0].mean(), low[1].mean()
        cyl = (r_nz[0] - cx) ** 2 + (r_nz[1] - cy) ** 2 <= 25**2
        data_bot = r_nz[2, cyl].min()
        rows.append(dict(participant_id=pid, aseg_bs_bottom_S=bs_bot, medulla_bottom_S=med_bot,
                         data_bottom_S=data_bot, gap_medulla_to_data_mm=med_bot - data_bot))
    df = pd.DataFrame(rows)
    df.to_csv(config.work_dir("dbm_brainstem") / "fov_check.csv", index=False)
    print(f"FOV checked: {len(df)}; minimum gap {df.gap_medulla_to_data_mm.min():.1f} mm; "
          f"below {MIN_GAP_MM} mm: {int((df.gap_medulla_to_data_mm < MIN_GAP_MM).sum())}")


if __name__ == "__main__":
    main()
