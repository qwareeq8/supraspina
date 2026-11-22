"""Table 1 demographic and injury rows (group level).

Optional participants-table columns add rows when present: race and ethnicity (self-reported text),
neurological_level (most recent neurological level of injury, such as C5), and injury_cause (free text,
grouped by keyword). Age at injury is age at MRI minus years since injury. Writes
<output_dir>/clinical/table1.csv (characteristic, sci, ctrl, comparison) and prints it.
"""

import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import clinical_lib as C  # noqa: E402
import config  # noqa: E402
from permutation import paper_round  # noqa: E402

RACE = ["white", "black or african american", "asian", "more than one race"]
# Cause categories, tested in this order on the lowercase text.
CAUSE_RULES = [("assault or penetrating", r"assa?u?lt|assualt|penetrat|knife|gunshot"),
               ("sport", r"kart|snowboard|diving|ski|surf|sport"),
               ("transport", r"\bmv[ac]\b|\bmba\b|car |motorcycle|pedestrian|auto|vehicle"),
               ("fall", r"\bfall")]
CAUSES = ["transport", "fall", "sport", "assault or penetrating", "other"]


def cause(text) -> str:
    t = str(text).strip().lower()
    for k, rx in CAUSE_RULES:
        if re.search(rx, t):
            return k
    return "other"


def level_group(level) -> str | None:
    m = re.fullmatch(r"\s*([CTLS])(\d{1,2})\s*", str(level))
    if not m:
        return None
    seg, num = m.group(1), int(m.group(2))
    if seg == "C":
        return "C1 to C4" if num <= 4 else "C5 to C8"
    return {"T": "T1 to T12", "L": "L1 to L5"}.get(seg, "other")


def msd(x, f="{:.1f}") -> str:
    return f"{f.format(np.mean(x))} ({f.format(np.std(x, ddof=1))})"


def g1(x) -> str:
    """One decimal, without a trailing .0."""
    return f"{x:.1f}".removesuffix(".0")


def median_iqr(x, f=g1) -> str:
    q = x.dropna().quantile([0.25, 0.5, 0.75])
    return f"{f(q[0.5])} ({f(q[0.25])} to {f(q[0.75])})"


def cats(x: pd.Series, keys) -> str:
    x = x.astype(str).str.strip().str.lower()
    return "; ".join(str(int((x == k).sum())) for k in keys) + f"; not reported {int((~x.isin(keys)).sum())}"


def main():
    d = C.load()
    sci, ctl = d[d.sci == 1], d[d.sci == 0]
    f1, n1, f0, n0 = int(sci.female.sum()), len(sci), int(ctl.female.sum()), len(ctl)
    p_sex = stats.fisher_exact([[f1, n1 - f1], [f0, n0 - f0]])[1]
    rows = [("n", n1, n0, ""),
            ("Age, years, mean (SD)", msd(sci.age), msd(ctl.age),
             f"Welch P = {paper_round(stats.ttest_ind(sci.age, ctl.age, equal_var=False).pvalue)}"),
            ("Female, n (%)", f"{f1} ({100 * f1 / n1:.0f})", f"{f0} ({100 * f0 / n0:.0f})",
             f"Fisher P = {paper_round(p_sex)}"),
            ("eTIV, L, mean (SD)", msd(sci.eTIV_l, "{:.2f}"), msd(ctl.eTIV_l, "{:.2f}"),
             f"Welch P = {paper_round(stats.ttest_ind(sci.eTIV, ctl.eTIV, equal_var=False).pvalue)}")]
    if "race" in d:
        rows.append(("Race: White; Black or African American; Asian; more than one race, n",
                     cats(sci.race, RACE), cats(ctl.race, RACE), ""))
    if "ethnicity" in d:
        def hisp(x):
            return int((x.astype(str).str.strip().str.lower() == "hispanic or latino").sum())
        rows.append(("Hispanic or Latino, n", hisp(sci.ethnicity), hisp(ctl.ethnicity), ""))
    rows += [("NPRS > 3; NPRS <= 3, n", f"{int((sci.nprs > 3).sum())}; {int((sci.nprs <= 3).sum())}", "", ""),
             ("NPRS, median (IQR)", median_iqr(sci.nprs), "", ""),
             ("Level: cervical; thoracic or lumbar, n",
              f"{int((sci.cervical == 1).sum())}; {int((sci.cervical == 0).sum())}", "", "")]
    if "neurological_level" in d:
        g = sci.neurological_level.map(level_group)
        rows.append(("Neurological level: C1 to C4; C5 to C8; T1 to T12; L1 to L5, n",
                     "; ".join(str(int((g == k).sum())) for k in ("C1 to C4", "C5 to C8", "T1 to T12", "L1 to L5")),
                     "", ""))
    y = sci.years_since_injury
    rows += [("AIS grade: A; B to D, n", f"{int((sci.ais_a == 1).sum())}; {int((sci.ais_a == 0).sum())}", "", ""),
             ("Years since injury, median (IQR)",
              f"{median_iqr(y, '{:.1f}'.format)}; range, {y.min():.1f} to {y.max():.1f}", "", ""),
             ("Age at injury, years, mean (SD)", msd((sci.age - y).dropna()), "", "")]
    if "injury_cause" in d:
        c = sci.injury_cause.map(cause)
        rows.append(("Cause: transport; fall; sport; assault or penetrating; other, n",
                     "; ".join(str(int((c == k).sum())) for k in CAUSES), "", ""))
    for col, lab in (("motor_total", "motor"), ("lt_total", "light-touch"), ("pp_total", "pinprick")):
        rows.append((f"ISNCSCI {lab} total (n = {int(sci[col].notna().sum())}), median (IQR)",
                     median_iqr(sci[col]), "", ""))
    out = pd.DataFrame(rows, columns=["characteristic", "sci", "ctrl", "comparison"])
    out.to_csv(config.output_dir(C.SECTION) / "table1.csv", index=False)
    with pd.option_context("display.width", 200, "display.max_colwidth", 80):
        print(out.to_string(index=False))


if __name__ == "__main__":
    main()
