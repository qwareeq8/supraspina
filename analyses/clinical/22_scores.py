"""Neurological scores against medullary volume within SCI (Table 2; Results).

Partial correlations of the ISNCSCI light-touch, pinprick, and motor totals with the DCN region and the
medullary subfield volume, adjusted for age, sex, and eTIV, and again with injury level and AIS grade added;
the variance of each score explained by level and AIS grade together (R2); and the Pearson correlation of the
light-touch and pinprick totals. Missing scores are not imputed. The Benjamini-Hochberg q of the unadjusted
correlations comes from the stratification family (30_stratification.py). Writes
<output_dir>/clinical/score_correlations.csv and score_level_ais_r2.csv.
"""

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import clinical_lib as C  # noqa: E402
import config  # noqa: E402

SCORES = ["lt_total", "pp_total", "motor_total"]
IMAGING = ["dcn", "medulla_sf"]


def main():
    s = C.sci_only(C.load(IMAGING))
    rows = []
    for sc in SCORES:
        for im in IMAGING:
            for adj, cov in (("age+female+eTIV_l", C.COV),
                             ("age+female+eTIV_l+cervical+ais_a", [*C.COV, "cervical", "ais_a"])):
                rows.append(dict(score=sc, imaging=im, adjustment=adj, **C.partial_r(s, sc, im, cov)))
    f = s[["lt_total", "pp_total"]].dropna()
    rows.append(dict(score="lt_total", imaging="pp_total", adjustment="none (Pearson)", n=len(f),
                     r=f.lt_total.corr(f.pp_total)))
    corr = pd.DataFrame(rows)
    corr.to_csv(config.output_dir(C.SECTION) / "score_correlations.csv", index=False)

    rows = []
    for sc in SCORES:
        _, _, m = C.ols(s, sc, ["cervical", "ais_a"])
        rows.append(dict(score=sc, n=int(m.nobs), r2=m.rsquared, r2_adj=m.rsquared_adj, p_model=m.f_pvalue))
    r2 = pd.DataFrame(rows)
    r2.to_csv(config.output_dir(C.SECTION) / "score_level_ais_r2.csv", index=False)
    with pd.option_context("display.width", 200):
        print(corr.round(4).to_string(index=False))
        print(r2.round(4).to_string(index=False))


if __name__ == "__main__":
    main()
