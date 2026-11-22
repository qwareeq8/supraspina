"""Sample-mean modulated gray and white matter (FWHM 0) on the extended MNI grid.

Writes maps/mean_mwc1_fwhm0, mean_mwc2_fwhm0, and their sum mean_gmwm_fwhm0 (the background of Supplementary
Fig. 2) to the output folder; the normalization QC montages compare each participant with these means.
"""

import numpy as np

import dartel_common as dc

aff, shp = dc.grid()
ids = dc.ids()
means = {}
for kind in ("mwc1_fwhm0", "mwc2_fwhm0"):
    acc = np.zeros(shp, np.float64)
    for pid in ids:
        acc += dc.load(dc.mni(kind, pid))
    means[kind] = (acc / len(ids)).astype(np.float32)
means["gmwm_fwhm0"] = means["mwc1_fwhm0"] + means["mwc2_fwhm0"]
for kind, m in means.items():
    dc.save(m, aff, dc.OUT / "maps" / f"mean_{kind}.nii.gz")
print(f"Mean images over {len(ids)} participants written.")
