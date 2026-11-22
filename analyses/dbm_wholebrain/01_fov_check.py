"""Group-blind check of the inferior field of view of each conformed FreeSurfer image.

Per participant: the lowest axial index (1 mm RAS grid) of brainmask.mgz, aseg Brain-Stem (16), and the subfield
medulla; how far the brainmask and aseg brainstem reach below the medulla; the brainmask cross-section (mm2) 5, 10,
15, and 20 mm below the lowest medulla voxel; and the brain bounding box. Writes fov_check.csv to the work folder.
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
import dbmwb as wb  # noqa: E402


def canon(p):
    return np.asarray(nib.as_closest_canonical(nib.load(p)).dataobj)


def zlo(m):
    return int(np.nonzero(m)[2].min())


FS = config.path("freesurfer.subjects_dir")
rows = []
ids = config.participants().participant_id
for i, sid in enumerate(ids, 1):
    B = canon(FS / sid / "mri/brainmask.mgz") > 0
    A = canon(FS / sid / "mri/aseg.mgz")
    Bl = canon(wb.subfield_labels(sid))
    md = zlo(Bl == wb.MEDULLA)
    ijk = np.array(np.nonzero(B))
    r = dict(participant_id=sid, bm_zlo=zlo(B), bs16_zlo=zlo(A == 16), med_zlo=md,
             bm_below_med_mm=md - zlo(B), bs16_below_med_mm=md - zlo(A == 16),
             bbox_x=int(np.ptp(ijk[0]) + 1), bbox_y=int(np.ptp(ijk[1]) + 1), bbox_z=int(np.ptp(ijk[2]) + 1),
             bbox_z_to_medbot_minus15=int(ijk[2].max() - (md - 15) + 1))
    for k in (5, 10, 15, 20):
        r[f"bm_area_{k}mm_below"] = int(B[:, :, md - k].sum()) if md - k >= 0 else -1
    rows.append(r)
    print(f"{i}/{len(ids)}", flush=True)
g = pd.DataFrame(rows)
g.to_csv(wb.W / "fov_check.csv", index=False)
print(g.drop(columns="participant_id").describe().T.round(1).to_string())
