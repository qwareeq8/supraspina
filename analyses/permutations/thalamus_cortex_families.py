"""Converged Freedman-Lane P values of the thalamic, S1 and M1 parcel, and regional FreeSurfer families.

Usage: thalamus_cortex_families.py N SEED [thal] [soma] [region]

The paper used N = 10000000 and SEED = 20261023 with family offsets 21 (thal), 22 (soma), and 23 (region).
Writes <output_dir>/permutations/<set>_<N>.csv (long: family, name, n, t, N, p_single, p_fwe, and Monte
Carlo SE) and, for the region set, region_count238_<N>.json (number of the 238 measures at parametric
P < 0.05: observed, null mean and SD, null 95th percentile, and permutation P).

Inputs and definitions are those of the thalamic (thalamus_common) and cortical (cortex_common) sections.
Models: thalamic nucleus groups (left plus right) ~ SCI + age + female + eTIV in the thalamic sample;
Brainnetome parcels, Desikan-Killiany measures, and aseg volumes ~ SCI + age + female, + eTIV for area,
gray matter volume, and aseg volumes; every measure on its own complete cases. Families: thal6; primary
(M1 and S1 lower-limb thickness) and secondary_size (area and volume of nine M1 and S1 parcels);
apriori_primary10, apriori_secondary14, and PRIMARY238 (thickness, area, and gray matter volume of 68
regions and 34 aseg volumes), the last with the null count of measures at P < 0.05.
"""

import json
import sys
from pathlib import Path

import pandas as pd

ANALYSES = Path(__file__).resolve().parents[1]
for sub in ("lib", "thalamus", "cortex"):
    sys.path.insert(0, str(ANALYSES / sub))
import config  # noqa: E402
import cortex_common as cc  # noqa: E402
import thalamus_common as tc  # noqa: E402
from permutation import Col, run_multi  # noqa: E402


# Reconstructed: the thalamic frame of the permutation run, the montage and technical rule of the thalamic
# statistics applied to the nuclei table (n 94).
def thalamus():
    d = pd.read_csv(tc.TABLE)
    assert set(d.participant_id) == set(config.participants().participant_id), "Participants without a nuclei row."
    d = d.sort_values("participant_id").reset_index(drop=True)
    return d[(d.rating != "Fail") & d.tech_ok.astype(bool)].reset_index(drop=True)


def cols_for(df, names, covf):
    return [Col(c, df[c].to_numpy(float), df, covf(c)) for c in names]


def go(tag, cols, n_all, fams, n_perm, seed, out, counts=None):
    r, cs = run_multi(cols, n_all, n_perm, seed, fams, counts)
    r.to_csv(out / f"{tag}_{n_perm}.csv", index=False)
    print(f"== {tag} N {int(r.N.iloc[0])}")
    print(r.round(6).to_string(index=False))
    if cs:
        (out / f"{tag}_count238_{n_perm}.json").write_text(json.dumps(cs, indent=1))
        print(json.dumps(cs))


def main():
    n_perm, seed = int(float(sys.argv[1])), int(sys.argv[2])
    which = sys.argv[3:] or ["thal", "soma", "region"]
    out = config.output_dir("permutations")
    if "thal" in which:
        d = thalamus()
        print("Thalamic frame n", len(d), "SCI", int(d.sci.sum()))
        go("thal", cols_for(d, tc.FAMILY, lambda c: ["age", "female", "eTIV"]), len(d), {"thal6": tc.FAMILY},
           n_perm, seed + 21, out)
    if "soma" in which:
        d = cc.soma_frame(cc.load_tables("bn"))
        go("soma", cols_for(d, cc.SOMA_COLS, cc.soma_covars), len(d), cc.FAM, n_perm, seed + 22, out)
    if "region" in which:
        d = cc.add_rois(cc.load_tables("subject"))
        _, prim238, _ = cc.region_sets(d)
        names = list(dict.fromkeys(cc.PRIM10 + cc.SEC14 + prim238))
        fams = {"apriori_primary10": cc.PRIM10, "apriori_secondary14": cc.SEC14, "PRIMARY238": prim238}
        go("region", cols_for(d, names, cc.region_covars), len(d), fams, n_perm, seed + 23, out,
           counts={"PRIMARY238": prim238})


if __name__ == "__main__":
    main()
