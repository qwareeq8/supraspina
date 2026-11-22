"""Unadjusted group means and sample SDs in native units (Supplementary Table 2).

Thalamic nucleus groups are left plus right sums and exclude the participant failing thalamic QC; aseg
thalamus is the mean of the hemispheres; S1 trunk area is the bilateral mean and is missing where a
hemisphere was misregistered. Writes output_dir("summary")/unadjusted_volumes.csv.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import config  # noqa: E402

# Measure label -> (section, file, column), all from the per-participant tables of the sections.
MEASURES = {
    "Medulla, brainstem subfields, mm3": ("subfields", "outcome_values.csv", "subfield_Medulla"),
    "Pons, brainstem subfields, mm3": ("subfields", "outcome_values.csv", "subfield_Pons"),
    "Midbrain, brainstem subfields, mm3": ("subfields", "outcome_values.csv", "subfield_Midbrain"),
    "Whole brainstem, brainstem subfields, mm3": ("subfields", "outcome_values.csv", "subfield_Whole_brainstem"),
    "Brainstem, aseg, mm3": ("cortex", "outcome_values.csv", "roi_Brain-Stem"),
    "Thalamus, aseg, mean of hemispheres, mm3": ("cortex", "outcome_values.csv", "roi_Thalamus"),
    "Ventral thalamic group, left plus right, mm3": ("thalamus", "outcome_values.csv", "thal_Ventral_bi"),
    "Posterior thalamic group, left plus right, mm3": ("thalamus", "outcome_values.csv", "thal_Posterior_bi"),
    "S1 trunk surface area, mean of hemispheres, mm2": ("cortex", "s1_trunk.csv", "s1_trunk_area"),
}

df = config.participants()[["participant_id", "sci", "eTIV"]]
rows = []
for label, (section, name, col) in {**MEASURES, "eTIV, mm3": (None, None, "eTIV")}.items():
    if section is None:
        y = df[["participant_id", "sci", col]]
    else:
        t = config.read_private(config.work_dir(section) / name)
        if section == "thalamus":
            t.loc[t.elig_thalamus != 1, col] = np.nan
        y = df[["participant_id", "sci"]].merge(t[["participant_id", col]], on="participant_id", how="left")
    row = {"measure": label}
    for g, tag in ((1, "sci"), (0, "ctrl")):
        v = y.loc[y.sci == g, col].dropna()
        row.update({f"{tag}_mean": v.mean(), f"{tag}_sd": v.std(ddof=1), f"n_{tag}": len(v)})
    rows.append(row)
out = pd.DataFrame(rows)
out.to_csv(config.output_dir("summary") / "unadjusted_volumes.csv", index=False)
print(out.round(1).to_string(index=False))
