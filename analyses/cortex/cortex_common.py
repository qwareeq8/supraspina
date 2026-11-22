"""Shared paths, measure sets, and model definitions of the cortical and regional FreeSurfer analyses.

Each hemisphere is re-registered to the buckner40 folding atlas (sphere.b40infl, from the inflated surface; fallback
sphere.b40) and labeled with the Desikan-Killiany (DK) and Brainnetome atlases (02_hemi.sh). An automated,
group-blind screen (10_screen.py) and a fixed rule (11_select.py) pick one registration per hemisphere; a group-blind
visual review of the flagged hemispheres (qc.cortical_adjudication) can keep a hemisphere with another registration,
drop it, or drop named Brainnetome parcels (12_extract.py).

Participant-level files under work_dir/cortex:
  subjects/<id>/          scratch SUBJECTS_DIR (per-file links into freesurfer.subjects_dir; new outputs only)
  fsavg/<tag>/            sulc resampled to fsaverage through each registration (screen input)
  screen_<tag>.tsv, screen_regions_<tag>.tsv, selection.tsv, registration.tsv
  subject_table_P.csv     DK (9 metrics x 34 regions x 2 hemispheres) and aseg volumes, final registration
  bn_table_P.csv          Brainnetome M1 and S1 body-part parcels (ThickAvg, SurfArea, GrayVol, NumVert)
  outcome_values.csv, s1_trunk.csv
Both P tables hold participant_id, sci, age, female, and eTIV (mm3); a cell is missing where its hemisphere has
no correct registration, where the review excluded a Brainnetome parcel, or where qc.region_exclusions names a
DK region. Group-level tables go to output_dir/cortex.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

SECTION = "cortex"
WORK = config.work_dir(SECTION)
OUT = config.output_dir(SECTION)
SD = WORK / "subjects"
FS = config.path("freesurfer.subjects_dir")
TAGS = ("b40infl", "b40", "default")  # The default tag is the recon's own sphere.reg.

METRICS = ("NumVert", "SurfArea", "GrayVol", "ThickAvg", "ThickStd", "MeanCurv", "GausCurv", "FoldInd", "CurvInd")
# Brainnetome body-part parcels: key -> name in the stats files (mris_anatomical_stats keeps the text after "/").
BN_ROIS = {"M1_lowerlimb": "A4ll", "S1_lowerlimb": "3ll", "M1_upperlimb": "A4ul", "S1_upperlimb_headface": "3ulhf",
           "M1_trunk": "A4t", "S1_trunk": "3tru", "M1_headface": "A4hf", "M1_tonguelarynx": "A4tl",
           "S1_tonguelarynx": "3tonIa"}
BN_MEASURES = ("ThickAvg", "SurfArea", "GrayVol", "NumVert")
DK_REGIONS = sorted(
    "bankssts caudalanteriorcingulate caudalmiddlefrontal cuneus entorhinal frontalpole fusiform inferiorparietal "
    "inferiortemporal insula isthmuscingulate lateraloccipital lateralorbitofrontal lingual medialorbitofrontal "
    "middletemporal paracentral parahippocampal parsopercularis parsorbitalis parstriangularis pericalcarine "
    "postcentral posteriorcingulate precentral precuneus rostralanteriorcingulate rostralmiddlefrontal "
    "superiorfrontal superiorparietal superiortemporal supramarginal temporalpole transversetemporal".split())
assert len(DK_REGIONS) == 34


def sample_ids() -> list[str]:
    return config.participants().participant_id.tolist()


def reference_ids() -> list[str]:
    """Participants whose b40infl regional fits define the robust z of screen criterion C."""
    try:
        ref = config.ids(config.path("qc.cortical_screen_reference"))
    except SystemExit:
        ref = []
    return ref or sample_ids()


def adjudication() -> pd.DataFrame:
    """Rater decisions on flagged hemispheres: participant_id, hemi, decision, bn_regions, registration."""
    cols = ["participant_id", "hemi", "decision", "bn_regions", "registration"]
    p = config.path("qc.cortical_adjudication")
    if not p.exists():
        return pd.DataFrame(columns=cols)
    a = config.read_private(p, sep="\t")
    assert a.decision.isin(["keep", "out", "exclude_bn"]).all(), "Unknown adjudication decision."
    return a.reindex(columns=cols)


def region_exclusions() -> set[tuple[str, str]]:
    """Cells (participant_id, "<hemi>_<DK region>") set missing at review for the buckner40 labels."""
    p = config.path("qc.region_exclusions")
    if not p.exists():
        return set()
    t = config.read_private(p, sep="\t")
    if "registration" in t.columns:  # Cells named for the original registration belong to other analyses.
        t = t[t.registration.isin(["b40infl", "any"])]
    return {(s, f"{h}_{r}") for s, h, r in zip(t.participant_id, t.hemisphere, t.structure)}


def read_stats(path) -> pd.DataFrame:
    rows = [ln.split() for ln in open(path) if ln.strip() and not ln.startswith("#")]
    df = pd.DataFrame(rows, columns=["StructName", *METRICS])
    for c in METRICS:
        df[c] = df[c].astype(float)
    return df.set_index("StructName")


def read_aseg(path) -> tuple[dict, dict]:
    """Return (header measures, {aseg_<structure>: Volume_mm3}) of an aseg.stats file."""
    meas, header, rows = {}, None, []
    for line in open(path):
        if line.startswith("# Measure"):
            parts = [p.strip() for p in line[len("# Measure"):].split(",")]
            meas[parts[1]] = float(parts[3])
        elif line.startswith("# ColHeaders"):
            header = line.split()[2:]
        elif not line.startswith("#") and line.strip():
            rows.append(line.split())
    t = pd.DataFrame(rows, columns=header)
    return meas, {f"aseg_{r['StructName']}": float(r["Volume_mm3"]) for _, r in t.iterrows()}


def load_tables(kind: str) -> pd.DataFrame:
    """Read subject_table_P (kind "subject") or bn_table_P (kind "bn"), sorted by participant_id."""
    t = pd.read_csv(WORK / f"{kind}_table_P.csv")
    assert set(t.participant_id) == set(sample_ids()), "Participants missing from the cortical tables."
    return t.sort_values("participant_id").reset_index(drop=True)


# ---------------------------------------------------------------- Regional measures (20_region.py)

APRIORI = [
    ("precentral", "thick", "Precentral thickness"), ("postcentral", "thick", "Postcentral thickness"),
    ("paracentral", "thick", "Paracentral thickness"), ("insula", "thick", "Insula thickness"),
    ("rostralanteriorcingulate", "thick", "Rostral ACC thickness"),
    ("caudalanteriorcingulate", "thick", "Caudal ACC thickness"),
    ("medialorbitofrontal", "thick", "Medial OFC thickness"), ("Thalamus", "aseg_bi", "Thalamus volume"),
    ("Cerebellum-Cortex", "aseg_bi", "Cerebellar cortex volume"), ("Brain-Stem", "aseg_single", "Brainstem volume"),
]
PRIM10 = [f"roi_{r}" for r, _, _ in APRIORI]
SEC14 = [f"roi2_{r}_{m}" for r, k, _ in APRIORI if k == "thick" for m in ("GrayVol", "SurfArea")]
LABEL = {f"roi_{r}": lab for r, _, lab in APRIORI}
for _r, _k, _lab in APRIORI:
    if _k == "thick":
        LABEL[f"roi2_{_r}_GrayVol"] = _lab.replace("thickness", "volume")
        LABEL[f"roi2_{_r}_SurfArea"] = _lab.replace("thickness", "area")


def region_sets(master: pd.DataFrame):
    """Families of DK metrics and aseg volumes, the 238 regional morphometric measures, and all 646."""
    regions = sorted({c.split("_")[1] for c in master.columns if c.startswith("lh_") and c.endswith("_ThickAvg")})
    # Keep the aseg structures that vary across participants (labels FreeSurfer always reports as zero drop out).
    aseg_cols = [c for c in master.columns if c.startswith("aseg_") and master[c].nunique() > 1]
    assert len(regions) == 34 and len(aseg_cols) == 34, (len(regions), len(aseg_cols))
    fams = {f"aparc_{m}": [f"{h}_{r}_{m}" for h in ("lh", "rh") for r in regions] for m in METRICS}
    fams["aseg"] = aseg_cols
    prim238 = fams["aparc_ThickAvg"] + fams["aparc_SurfArea"] + fams["aparc_GrayVol"] + fams["aseg"]
    all646 = sum(fams.values(), [])
    assert len(prim238) == 238 and len(all646) == 646
    return fams, prim238, all646


def add_rois(df: pd.DataFrame) -> pd.DataFrame:
    """Bilateral means of the 10 prespecified (roi_) and 14 additional (roi2_) measures."""
    df = df.copy()
    for r, kind, _ in APRIORI:
        if kind == "thick":
            df[f"roi_{r}"] = (df[f"lh_{r}_ThickAvg"] + df[f"rh_{r}_ThickAvg"]) / 2
            for m in ("GrayVol", "SurfArea"):
                df[f"roi2_{r}_{m}"] = (df[f"lh_{r}_{m}"] + df[f"rh_{r}_{m}"]) / 2
        elif kind == "aseg_bi":
            df[f"roi_{r}"] = (df[f"aseg_Left-{r}"] + df[f"aseg_Right-{r}"]) / 2
        else:
            df[f"roi_{r}"] = df[f"aseg_{r}"]
    return df


def is_extensive(col: str) -> bool:
    if col.startswith(("aseg_", "roi2_")):
        return True
    if col.startswith("roi_"):
        return not any(col == f"roi_{r}" for r, k, _ in APRIORI if k == "thick")
    return col.split("_")[-1] in {"NumVert", "SurfArea", "GrayVol", "FoldInd"}


def region_covars(col: str) -> list[str]:
    """Thickness and other intensive measures: age and sex; area, volume, NumVert, FoldInd, aseg: also eTIV."""
    return ["age", "female"] + (["eTIV"] if is_extensive(col) else [])


# ---------------------------------------------------------------- Brainnetome M1 and S1 parcels (40_somatotopic.py)

ROIS = list(BN_ROIS)
MEAS = {"th": "ThickAvg", "area": "SurfArea", "vol": "GrayVol"}
FAM = {"primary": [f"th_{r}" for r in ROIS[:2]],  # M1 and S1 lower-limb thickness.
       "secondary_size": [f"area_{r}" for r in ROIS] + [f"vol_{r}" for r in ROIS]}
SOMA_COLS = FAM["primary"] + FAM["secondary_size"]
HEMI = [f"{c}_{h}" for c in SOMA_COLS for h in ("lh", "rh")]


def soma_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Bilateral means (th_, area_, vol_<parcel>) and single hemispheres (..._lh, ..._rh) of the parcels."""
    df = df.copy()
    for r in ROIS:
        for m, col in MEAS.items():
            df[f"{m}_{r}"] = (df[f"gcs_lh_{r}_{col}"] + df[f"gcs_rh_{r}_{col}"]) / 2
            df[f"{m}_{r}_lh"] = df[f"gcs_lh_{r}_{col}"]
            df[f"{m}_{r}_rh"] = df[f"gcs_rh_{r}_{col}"]
    return df


def soma_covars(col: str) -> list[str]:
    return ["age", "female"] + (["eTIV"] if col.split("_")[0] in ("area", "vol") else [])


def missing_cells(t: pd.DataFrame, cols: list[str]) -> int:
    return int(np.isnan(t[cols].to_numpy(float)).sum())
