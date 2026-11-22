"""Folders, label sets, and small helpers shared by the whole-brain DBM scripts.

Participant-level files live under config.work_dir("dbm_wholebrain"): prep/ (prepared images), template/
(template and majority labels), reg/ (registrations), stats/ (cropped mask, labels, 4D input, and the randomise
design), mni/ (template-to-MNI affine), qc_png/ (registration overlays), and the per-participant tables.
Group-level tables go to config.output_dir("dbm_wholebrain").
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy.io import loadmat

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

W = config.work_dir("dbm_wholebrain")
PREP, TPL, REG, ST, MNI = (W / d for d in ("prep", "template", "reg", "stats", "mni"))
DESIGN = ST / "SCI_vs_CTRL"

# FreeSurfer aparc+aseg label sets. The analysis mask holds tissue only (no ventricles or CSF).
CWM = (2, 41, 77, 251, 252, 253, 254, 255)
CBLM = (7, 8, 46, 47)
DEEP = (10, 11, 12, 13, 17, 18, 26, 28, 49, 50, 51, 52, 53, 54, 58, 60)
TISSUE_EXTRA = (3, 42, 16) + CWM + CBLM + DEEP
LATVENT = (4, 43)
# Brainstem subfield labels: 173 midbrain, 174 pons, 175 medulla, 178 superior cerebellar peduncle.
SUBFIELDS = (0, 173, 174, 175, 178)
MEDULLA = 175


def ctx(a):
    """Cortical aparc labels."""
    return (a >= 1000) & (a < 3000)


def subfield_labels(sid: str) -> Path:
    """Brainstem subfield labels of one participant on the conformed FreeSurfer grid."""
    return config.path("freesurfer.brainstem_subfields_dir") / sid / "brainstemSsLabels.FSvoxelSpace.mgz"


def load(p, dt=np.float32):
    return np.asarray(nib.load(p).dataobj).astype(dt)


def save(arr, p, dt, aff):
    img = nib.Nifti1Image(arr.astype(dt), aff)
    img.set_qform(aff, 1)
    img.set_sform(aff, 1)
    nib.save(img, p)


def log_det_affine(mat) -> float:
    """Return log|det| of the linear part of an ANTs affine (.mat), the affine share of the total log-Jacobian."""
    m = loadmat(mat)
    key = next(k for k in m if k.startswith("AffineTransform"))
    return float(np.log(abs(np.linalg.det(m[key][:9, 0].reshape(3, 3)))))


def exclusions() -> list[str]:
    """Participants whose registration failed visual review (none in the paper)."""
    return config.ids(config.path("qc.dbm_wholebrain_registration_exclusions"))


def template_ids(subs) -> list[str]:
    return subs.participant_id[subs.dbm_template.fillna(0).astype(int) == 1].tolist()
