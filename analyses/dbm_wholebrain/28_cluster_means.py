"""Per-participant mean smoothed total log-Jacobian in the whole-brain DBM clusters, for the clinical stratification.

Clusters are the SCI vs CTRL two-direction P_FWE < 0.05 clusters of at least 0.05 mL (27_voxel_summary.py). The
outcomes are fixed in advance as two: dbm_medulla, the SCI < CTRL cluster lying mostly (> 50%) in the template
medulla, and dbm_non_medullary, the union of every other SCI < CTRL cluster of at least 0.05 mL. Any SCI > CTRL
cluster would get its own column dbm_gt_c<i> (none in the paper). The clusters come from SCI vs CTRL, so within-SCI
tests on them do not reuse the selection contrast. Writes cluster_means.csv to the work folder.
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import dbmwb as wb  # noqa: E402

ids = pd.read_csv(wb.DESIGN / "subjects.txt", header=None)[0].tolist()
img = nib.load(wb.DESIGN / "logjac_s4.nii.gz")
assert img.shape[3] == len(ids)
data = np.asarray(img.dataobj, dtype=np.float32)
sfl = np.asarray(nib.load(wb.ST / "labels_subfields_crop.nii.gz").dataobj).astype(int)
lab = np.asarray(nib.load(wb.ST / "labels_aparc_crop.nii.gz").dataobj).astype(int)
out = pd.DataFrame({"participant_id": ids})
deep = None
for k, tag in ((2, "lt"), (1, "gt")):  # Contrast 2 is SCI < CTRL; 1 is SCI > CTRL.
    cl = np.asarray(nib.load(wb.DESIGN / f"clusters_two_dir_{k}.nii.gz").dataobj)
    for i in range(1, int(cl.max()) + 1):
        m = cl == i
        if m.sum() < 50:  # 1 mm voxels: 0.05 mL.
            continue
        fmed = float((sfl[m] == wb.MEDULLA).mean())
        fthal = float(np.isin(lab[m], (10, 49)).mean())
        print(f"Cluster SCI {'<' if k == 2 else '>'} CTRL {i}: {int(m.sum())} voxels, medulla {fmed:.2f}, "
              f"thalamus {fthal:.2f}.")
        if tag == "gt":
            out[f"dbm_gt_c{i}"] = data[m].mean(0)
        elif fmed > 0.5:
            assert "dbm_medulla" not in out
            out["dbm_medulla"] = data[m].mean(0)
        else:
            deep = m if deep is None else deep | m
if deep is not None:
    out["dbm_non_medullary"] = data[deep].mean(0)
    print(f"dbm_non_medullary: union of {int(deep.sum())} voxels.")
out.to_csv(wb.W / "cluster_means.csv", index=False)
print(f"Columns: {', '.join(c for c in out.columns if c != 'participant_id')}.")
