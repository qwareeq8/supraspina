"""Converged Freedman-Lane P values of the brainstem families (group-level output only).

Usage: brainstem_families.py N SEED [family ...]

Families (default: all): comp (five medullary compartments, max-T), comp_single (JHU corticospinal tract
and the atlas-free dorsal-minus-ventral contrast), tect (colliculi and DCN-region-minus-colliculus
contrasts), dbm (brainstem DBM regions, max-T), sub (brainstem subfields, max-T), dar (DARTEL regions,
max-T), nav (seven 7 T atlas nuclei, max-T), trc (11 tract parts, max-T), and fine_single (DCN region minus
the dorsal vagal complex). The paper used N = 10000000 and SEED = 20261023; each family adds its own offset
to SEED. Writes <output_dir>/permutations/<family>_<N>.csv with the observed t, the single and max-T P, and
their Monte Carlo SE; single-test families have no max-T columns.

Models: y ~ SCI + age + female + eTIV (liters), except DARTEL, which takes age, sex, and SPM total
intracranial volume from the DARTEL table.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402
from permutation import cols_from, run_family  # noqa: E402

COV = ("age", "female", "eTIV_l")
DARTEL_COV = ("d_age", "d_female", "d_tiv")
COMPARTMENTS = ["R1_pyramid_t50", "R2_olive_t50", "R3_dcn_region_t50", "R4_tegmentum_rest_t50", "R5_icp_t50"]
GEO = ["GEO_dorsal_caudal", "GEO_ventral_caudal"]
DBM = ["medulla_mlogj", "pons_mlogj", "midbrain_mlogj"]
SUBFIELDS = ["subfield_Medulla", "subfield_Pons", "subfield_SCP", "subfield_Midbrain", "subfield_Whole_brainstem"]
DARTEL = ["brainstem|gmwm_fwhm0", "medulla_z|gmwm_fwhm0", "midbrain_z|gmwm_fwhm0", "pons_z|gmwm_fwhm0"]
NUCLEI = ["NAV_VSM", "NAV_Ve", "NAV_iMRt", "NAV_ION", "NAV_RN", "NAV_raphe_med", "NAV_sMRt"]

# Family: (seed offset, covariates, columns; None = every TR_ column of the fine-atlas table, in its order).
FAMILIES = {
    "comp": (1, COV, COMPARTMENTS),
    "comp_single": (2, COV, ["JHU_CST", "GEO_DV_caudal"]),
    "tect": (3, COV, ["SC", "IC", "DCN_minus_SC", "DCN_minus_IC"]),
    "dbm": (4, COV, DBM),
    "sub": (5, COV, SUBFIELDS),
    "dar": (6, DARTEL_COV, DARTEL),
    "nav": (9, COV, NUCLEI),
    "trc": (10, COV, None),
    "fine_single": (11, COV, ["DCN_region-NAV_VSM"]),
}
# Reported as single tests: their max-T over the listed columns is not a paper family.
SINGLE = {"comp_single", "tect", "fine_single"}


def table(section, name, cols, rename=None):
    d = config.read_private(config.work_dir(section) / name)
    if rename:
        d = d.rename(columns=rename)
    return d[["participant_id"] + cols]


def frame():
    """Analyzed sample (sorted by participant_id) with every tested column; missing cells stay NaN."""
    fine = config.read_private(config.work_dir("atlas_nuclei_tracts") / "values_fine.csv")
    tracts = [c for c in fine.columns if c.startswith("TR_")]
    parts = [
        table("compartments", "outcome_values.csv", COMPARTMENTS + ["JHU_CST"]),
        table("compartments", "tectal_values.csv", ["SC", "IC", "dcn_check"]),
        # Total (warp plus affine) mean log-Jacobians of the atlas-free dorsal and ventral closed medulla.
        table("compartments", "roi_values.csv", GEO, rename={f"{c}_mlogj": c for c in GEO}),
        table("dbm_brainstem", "outcome_values.csv", DBM),
        table("subfields", "outcome_values.csv", SUBFIELDS),
        # The DARTEL table carries its own covariates (SPM total intracranial volume in liters).
        table("dartel", "outcome_values.csv", ["d_age", "d_female", "d_tiv"] + DARTEL,
              rename={"Age": "d_age", "female": "d_female", "TIV_l": "d_tiv"}),
        fine[["participant_id"] + NUCLEI + tracts + ["DCN_region-NAV_VSM"]],
    ]
    fr = config.participants()[["participant_id", "sci", "age", "female", "eTIV_l"]]
    for d in parts:
        fr = fr.merge(d, on="participant_id", how="left", validate="one_to_one")
    fr["GEO_DV_caudal"] = fr.GEO_dorsal_caudal - fr.GEO_ventral_caudal
    # The dcn_check column is the DCN region recomputed with the collicular values, so both terms share one extraction.
    fr["DCN_minus_SC"] = fr.dcn_check - fr.SC
    fr["DCN_minus_IC"] = fr.dcn_check - fr.IC
    return fr, tracts


def main():
    n_perm, seed = int(float(sys.argv[1])), int(sys.argv[2])
    which = sys.argv[3:] or list(FAMILIES)
    unknown = sorted(set(which) - set(FAMILIES))
    if unknown:
        raise SystemExit(f"Unknown families {unknown}; choose from {list(FAMILIES)}.")
    fr, tracts = frame()
    out = config.output_dir("permutations")
    print("Frame n", len(fr), "SCI", int(fr.sci.sum()))
    for tag in which:
        off, cov, names = FAMILIES[tag]
        r = run_family(cols_from(fr, names or tracts, cov), len(fr), n_perm, seed + off)
        if tag in SINGLE:
            r = r.drop(columns=["p_maxT", "se_maxT"])
        r.to_csv(out / f"{tag}_{n_perm}.csv", index=False)
        print(f"== {tag} N {int(r.N.iloc[0])}")
        print(r.round(6).to_string(index=False))


if __name__ == "__main__":
    main()
