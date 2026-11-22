"""Second-look montage of one code: six coronal and six axial slices evenly over the extent of the nuclei.

Same overlay as montage.py. Writes qc/second_look/<code>.png.
Usage: second_look.py CODE
"""

import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import montage as m  # noqa: E402
import thalamus_common as tc  # noqa: E402

code = sys.argv[1]
sid = pd.read_csv(tc.KEY, sep="\t").set_index("code").loc[code, "participant_id"]
norm, grp, thal = m.load(sid)
xs, ys, zs = np.where(thal | (grp > 0))
x0, x1, y0, y1, z0, z1 = xs.min() - 14, xs.max() + 14, ys.min() - 14, ys.max() + 14, zs.min() - 14, zs.max() + 14
vl = np.percentile(norm[x0:x1, y0:y1, z0:z1], (5, 99.5))
gx, gy, gz = np.where(grp > 0)
fig, axes = plt.subplots(2, 6, figsize=(20, 7), dpi=90)
for i, f in enumerate(np.linspace(0.1, 0.9, 6)):
    y = int(np.quantile(gy, f))
    m.panel(axes[0, i], norm[x0:x1, y, z0:z1], grp[x0:x1, y, z0:z1], thal[x0:x1, y, z0:z1], f"coronal q{f:.2f}", vl)
    z = int(np.quantile(gz, f))
    m.panel(axes[1, i], norm[x0:x1, y0:y1, z], grp[x0:x1, y0:y1, z], thal[x0:x1, y0:y1, z], f"axial q{f:.2f}", vl)
fig.suptitle(f"{code} second look (L left; axial anterior up)")
fig.tight_layout()
out = tc.QC / "second_look"
out.mkdir(parents=True, exist_ok=True)
fig.savefig(out / f"{code}.png")
