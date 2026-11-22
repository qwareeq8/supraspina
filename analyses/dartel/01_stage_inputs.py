"""Write the participant lists and stage each scan's brain-cropped T1 and brain mask as uncompressed NIfTI for SPM.

Scans: the analyzed sample plus any template-only scans (dartel.template_participants). T1 from
<t1_dir>/<id>.nii.gz, mask from <t1_mask_dir>/<id>.nii.gz. Writes raw/<id>_T1w.nii and raw/<id>_mask.nii, and a
working copy seg/<id>/<id>_T1w.nii whose header the segmentation step reorients (the raw copy keeps the scanner
header). Existing files are kept. Prints counts only.
"""

import gzip
import shutil

import dartel_common as dc
from dartel_common import config

T1 = config.path("t1_dir")
MASK = config.path("t1_mask_dir")
RAW = dc.WORK / "raw"
RAW.mkdir(parents=True, exist_ok=True)
dc.write_lists()


def gunzip(src, dst):
    if dst.exists():
        return
    with gzip.open(src, "rb") as f, open(dst, "wb") as g:
        shutil.copyfileobj(f, g)


missing = 0
for pid in dc.processed_ids():
    t1, mk = T1 / f"{pid}.nii.gz", MASK / f"{pid}.nii.gz"
    if not (t1.exists() and mk.exists()):
        missing += 1
        continue
    gunzip(t1, RAW / f"{pid}_T1w.nii")
    gunzip(mk, RAW / f"{pid}_mask.nii")
    sd = dc.seg_dir(pid)
    sd.mkdir(parents=True, exist_ok=True)
    if not (sd / f"{pid}_T1w.nii").exists():
        shutil.copyfile(RAW / f"{pid}_T1w.nii", sd / f"{pid}_T1w.nii")
print(f"Staged {len(dc.processed_ids()) - missing} scans; {missing} lack a T1 or a brain mask.")
if missing:
    raise SystemExit(1)
