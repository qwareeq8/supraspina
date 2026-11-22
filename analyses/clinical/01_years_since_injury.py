"""Years since injury at the study MRI, the years_since_injury column of the participants table.

Years run from the injury date to the MRI date, in years of 365.25 days, unrounded. A participant without
an injury date keeps the value recorded in the study file (years_since_injury_recorded), if given.

Input: clinical.injury_dates, a private table with participant_id, injury_date, mri_date (ISO dates or
YYYYMMDD), and optionally years_since_injury_recorded. Dates are read only here and are never printed or
written. Writes <work_dir>/clinical/years_since_injury.csv (participant_id, years_since_injury, basis),
to be copied into the participants table. Prints counts only.
"""

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402


def parse_dates(s: pd.Series) -> pd.Series:
    s = s.astype("string").str.strip()
    compact = s.str.fullmatch(r"\d{8}").fillna(False)
    out = pd.to_datetime(s.where(~compact), errors="coerce", format="mixed")
    out[compact] = pd.to_datetime(s[compact], format="%Y%m%d")
    return out


def years_since_injury(t: pd.DataFrame) -> pd.DataFrame:
    """Columns participant_id, years_since_injury, and basis from a frame of participant_id and the two dates."""
    out = pd.DataFrame({"participant_id": t.participant_id})
    out["years_since_injury"] = (parse_dates(t.mri_date) - parse_dates(t.injury_date)).dt.days / 365.25
    out["basis"] = "injury date to MRI date"
    if "years_since_injury_recorded" in t:
        miss = out.years_since_injury.isna()
        out.loc[miss, "years_since_injury"] = pd.to_numeric(t.years_since_injury_recorded, errors="coerce")[miss]
        out.loc[miss, "basis"] = "recorded"
    return out[out.years_since_injury.notna()]


def main():
    p = config.path("clinical.injury_dates")
    # Read with the date columns kept (config.read_private drops them) and nothing else.
    cols = ["participant_id", "injury_date", "mri_date", "years_since_injury_recorded"]
    t = pd.read_csv(p, dtype=str, usecols=lambda c: c in cols)
    assert t.participant_id.is_unique, "participant_id must be unique."
    out = years_since_injury(t)
    out.to_csv(config.work_dir("clinical") / "years_since_injury.csv", index=False)
    print(f"Years since injury for {len(out)} of {len(t)} participants; "
          f"basis counts: {out.basis.value_counts().to_dict()}.")


if __name__ == "__main__":
    main()
