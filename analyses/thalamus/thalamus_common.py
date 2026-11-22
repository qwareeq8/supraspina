"""Shared paths and nucleus groups of the thalamic nuclei analysis.

Participant-level files live under work_dir/thalamus:
  out/<id>/ThalamicNuclei.*      segment_subregions thalamus outputs
  nuclei_table.csv               volumes per participant (build_table.py)
  qc/qc_key.tsv                  montage code of each participant (opened only after all ratings exist)
  qc/montages/<code>.png         blind QC montages; qc/second_look/<code>.png on request
  qc/qc_flags.tsv                automated flags by code
  outcome_values.csv             group volumes and the montage rule per participant
Group-level tables go to output_dir/thalamus.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

SECTION = "thalamus"
WORK = config.work_dir(SECTION)
OUT = config.output_dir(SECTION)
SEG = WORK / "out"
QC = WORK / "qc"
KEY = QC / "qc_key.tsv"
TABLE = WORK / "nuclei_table.csv"

# Six bilateral nucleus groups of the probabilistic thalamic atlas; Ventral holds VPL and the ventral motor nuclei.
GROUPS = {
    "Anterior": ["AV"],
    "Lateral": ["LD", "LP"],
    "Ventral": ["VA", "VAmc", "VLa", "VLp", "VPL", "VM"],
    "Intralaminar": ["CeM", "CL", "Pc", "CM", "Pf"],
    "Medial": ["Pt", "MV(Re)", "MDm", "MDl"],
    "Posterior": ["LGN", "MGN", "L-Sg", "PuA", "PuM", "PuL", "PuI"],
}
NUCLEI = [n for ns in GROUPS.values() for n in ns]
FAMILY = [f"{g}_bi" for g in GROUPS]
OUTSIDE = ["whole_nuc_bi", "aseg_thal_mean", "VPL_bi"]
