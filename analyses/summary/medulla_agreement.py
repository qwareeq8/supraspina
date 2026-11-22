"""Agreement of the medullary estimates across the subfield, DARTEL, and brainstem DBM pipelines.

Pearson r between the brainstem DBM integrated Jacobian of the template medulla (mm3), the FreeSurfer
medullary subfield volume (mm3), and the DARTEL medullary gray plus white matter volume (mL), each pair on
the participants with both values. Writes output_dir("summary")/medulla_agreement.csv.
"""

import sys
from itertools import combinations
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import pandas as pd  # noqa: E402
from scipy import stats  # noqa: E402

import config  # noqa: E402

MEASURES = {
    "brainstem DBM integrated Jacobian": ("dbm_brainstem", "roi_values.csv", "medulla_intJ_mm3"),
    "FreeSurfer brainstem subfield": ("subfields", "outcome_values.csv", "subfield_Medulla"),
    "DARTEL grey plus white matter": ("dartel", "outcome_values.csv", "medulla_z|gmwm_fwhm0"),
}

df = config.participants()[["participant_id", "sci"]]
for label, (section, name, col) in MEASURES.items():
    t = config.read_private(config.work_dir(section) / name)[["participant_id", col]].rename(columns={col: label})
    df = df.merge(t, on="participant_id", how="left")
rows = []
for a, b in combinations(MEASURES, 2):
    ok = df[[a, b]].notna().all(axis=1)
    r = stats.pearsonr(df.loc[ok, a], df.loc[ok, b])[0]
    rows.append(dict(measure_a=a, measure_b=b, n=int(ok.sum()), pearson_r=r))
out = pd.DataFrame(rows)
out.to_csv(config.output_dir("summary") / "medulla_agreement.csv", index=False)
print(out.round(3).to_string(index=False))
