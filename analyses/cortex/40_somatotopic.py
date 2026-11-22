"""Brainnetome M1 and S1 body-part parcels: SCI vs control models.

Nine parcels (bilateral means): M1 lower limb, upper limb, trunk, head and face, tongue and larynx; S1 lower limb,
upper limb with head and face, trunk, tongue and larynx. Families: lower-limb thickness in M1 and S1 (two), and the
surface area and gray matter volume of the nine (18). Thickness ~ SCI + age + sex; area and volume + eTIV; each
measure on its own complete cases (family_models). Freedman-Lane max-|t| FWE within each family (5,000 permutations,
seed 20260924). Single-hemisphere measures are fitted without permutation.
Outputs: <output_dir>/cortex/somatotopic_results.csv and somatotopic_hemi.csv.
"""

import sys
from pathlib import Path

import numpy as np

import cortex_common as cc

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from family_models import add_corrections, fit_family, master_perms  # noqa: E402

N_PERM = 5000
SEED = 20260924
df = cc.soma_frame(cc.load_tables("bn"))
inc = np.ones(len(df), bool)
perms = master_perms(SEED, N_PERM, len(df))
r, T0 = fit_family(df, inc, cc.SOMA_COLS, "SCI_vs_CTRL", cc.soma_covars, perms)
r = add_corrections(r, T0, cc.FAM)
r.to_csv(cc.OUT / "somatotopic_results.csv", index=False)
h, _ = fit_family(df, inc, cc.HEMI, "SCI_vs_CTRL", cc.soma_covars, None)
h.to_csv(cc.OUT / "somatotopic_hemi.csv", index=False)
print(r[["measure", "family", "n_focal", "n_ref", "d_adj", "d_lo", "d_hi", "p", "p_fwe_family"]].round(3).to_string(
    index=False))
