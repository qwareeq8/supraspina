"""Shared paths, sample, and regions of the SPM 25 DARTEL analysis.

Participant-level files live under work_dir/dartel:
  raw/<id>_T1w.nii, raw/<id>_mask.nii   brain-cropped T1 and its brain mask (uncompressed for SPM)
  seg/<id>/                             reoriented T1, Segment outputs (c1-c3, rc1-rc2, m, seg8.mat)
  dartel/                               DARTEL templates and flow fields (u_rc1<id>_T1w_Template.nii for the
                                        template scans, u_rc1<id>_T1w.nii for scans warped to the finished template)
  lists/                                participant lists (participants, segment, template, warp)
  mni_zext/fwhm0, fwhm8, fov            modulated warped tissue and warped field-of-view images
Group-level tables and maps go to output_dir/dartel.
"""

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

SECTION = "dartel"
WORK = config.work_dir(SECTION)
OUT = config.output_dir(SECTION)
MNI = WORK / "mni_zext"

# SPM total intracranial volume is the size covariate of every DARTEL model.
COV = ("Age", "female", "TIV_l")

# The four brainstem regions (one max-T family). The medullary region is the Harvard-Oxford brainstem label below
# MNI z = -46.5 mm (on the 1.5 mm grid, z <= -46 selects z <= -46.5); the boundaries were set without group information.
REGIONS = ("brainstem", "midbrain_z", "pons_z", "medulla_z")
HO_BRAINSTEM = 8  # Brain-Stem in the Harvard-Oxford subcortical maximum-probability image.


def ids() -> list[str]:
    """The analyzed sample."""
    return config.participants().participant_id.tolist()


def template_ids() -> list[str]:
    """Scans the DARTEL template is built from: the optional private list dartel.template_participants (which may
    name scans outside the analyzed sample), else the analyzed sample."""
    key = (config.load().get("dartel") or {}).get("template_participants")
    return sorted(config.ids(config.path("dartel.template_participants"))) if key else ids()


def processed_ids() -> list[str]:
    """Every scan that is staged and segmented: the analyzed sample plus any template-only scans."""
    return sorted(set(ids()) | set(template_ids()))


def write_lists() -> None:
    """Participant lists read by run.sh and the MATLAB steps (lists/<name>.txt, one ID per line)."""
    tmpl = set(template_ids())
    lists = {"participants": ids(), "segment": processed_ids(), "template": sorted(tmpl),
             "warp": [p for p in ids() if p not in tmpl]}
    (WORK / "lists").mkdir(parents=True, exist_ok=True)
    for name, v in lists.items():
        (WORK / "lists" / f"{name}.txt").write_text("".join(f"{p}\n" for p in v), newline="\n")


def seg_dir(pid: str) -> Path:
    return WORK / "seg" / pid


def mni(kind: str, pid: str) -> Path:
    """Warped image of one participant: kind is mwc1_fwhm0, mwc2_fwhm0, smwc2_fwhm8, or fov."""
    if kind == "fov":
        return MNI / "fov" / f"wfov{pid}_T1w.nii"
    prefix, fwhm = kind.split("_")
    return MNI / fwhm / f"{prefix}{pid}_T1w.nii"


def load(path: Path) -> np.ndarray:
    """Image data as float32 with out-of-field-of-view NaN set to 0."""
    return np.nan_to_num(np.asarray(nib.load(str(path)).dataobj, np.float32))


def grid() -> tuple[np.ndarray, tuple]:
    """Affine and shape of the extended 1.5 mm MNI grid (x -90 to 90, y -126 to 90, z -84 to 108)."""
    im = nib.load(str(mni("mwc2_fwhm0", ids()[0])))
    return im.affine, im.shape


def save(data: np.ndarray, affine: np.ndarray, path: Path) -> None:
    img = nib.Nifti1Image(data, affine)
    img.header.set_sform(affine, 4)
    img.header.set_qform(affine, 4)
    path.parent.mkdir(parents=True, exist_ok=True)
    nib.save(img, str(path))


def world(affine: np.ndarray, shape: tuple) -> np.ndarray:
    """MNI millimeter coordinates of every voxel, (3, n_voxels)."""
    ijk = np.indices(shape).reshape(3, -1)
    return (affine @ np.r_[ijk, np.ones((1, ijk.shape[1]))])[:3]


def region_masks() -> tuple[dict[str, np.ndarray], np.ndarray, tuple]:
    """Brainstem regions on the DARTEL grid from the Harvard-Oxford subcortical atlas (threshold 25%, 1 mm).

    Each DARTEL voxel takes the atlas label at its MNI coordinate (nearest neighbor).
    """
    aff, shp = grid()
    xyz = world(aff, shp)
    atlas = nib.load(str(config.path("atlases.harvard_oxford_sub")))
    a = np.rint((np.linalg.inv(atlas.affine) @ np.r_[xyz, np.ones((1, xyz.shape[1]))])[:3]).astype(int)
    data = np.asarray(atlas.dataobj)
    ok = np.all((a >= 0) & (a < np.array(data.shape)[:, None]), 0)
    lab = np.zeros(xyz.shape[1], data.dtype)
    lab[ok] = data[a[0, ok], a[1, ok], a[2, ok]]
    bs = lab.reshape(shp) == HO_BRAINSTEM
    Z = xyz[2].reshape(shp)
    masks = {
        "brainstem": bs,
        "midbrain_z": bs & (Z >= -18.1),
        "pons_z": bs & (Z > -46) & (Z < -18.1),
        "medulla_z": bs & (Z <= -46),
    }
    return masks, aff, shp


def tiv() -> pd.DataFrame:
    """SPM total intracranial volume (GM + WM + CSF, liters) from the Tissue Volumes utility."""
    tv = pd.read_csv(WORK / "tissue_volumes_spm_tvol.csv")
    tv["participant_id"] = tv.File.map(lambda f: Path(f).name.removesuffix("_T1w_seg8.mat"))
    tv["TIV_l"] = tv.Volume1 + tv.Volume2 + tv.Volume3
    return tv[["participant_id", "TIV_l"]]


def design() -> pd.DataFrame:
    """The analyzed sample (sorted by participant_id) with the DARTEL model columns: sci, Age, female, TIV_l."""
    s = config.participants()[["participant_id", "sci", "age", "female"]].rename(columns={"age": "Age"})
    d = s.merge(tiv(), on="participant_id", how="left")
    assert d[["Age", "female", "TIV_l"]].notna().all().all(), "SPM TIV is missing for some participants."
    return d
