"""Within-SCI clinical association model of the DCN region (Table 2; Fig. 4A).

One OLS model: DCN-region mean log-Jacobian ~ cervical + AIS A + years since injury + age + female + eTIV,
fitted in all participants with SCI and in the sensitivity sample. Each term has a 95% CI, the percentage
difference 100 (exp(beta) - 1), an unadjusted t-test P, and its variance inflation factor. Writes
<output_dir>/clinical/clinical_model.csv.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import clinical_lib as C  # noqa: E402
import config  # noqa: E402

TERMS = ["cervical", "ais_a", "years_since_injury", *C.COV]


def main():
    d = C.load(["dcn"])
    rows = []
    for sample, frame in (("all", C.sci_only(d)), ("sensitivity", C.sci_only(d, sensitivity=True))):
        f, X, m = C.ols(frame, "dcn", TERMS)
        ci = m.conf_int()
        for term, v in zip(TERMS, C.vif(X), strict=True):
            lo, hi = ci.loc[term]
            rows.append(dict(sample=sample, n=int(m.nobs), n_cervical=int(f.cervical.sum()), n_ais_a=int(f.ais_a.sum()),
                             term=term, beta=m.params[term], beta_lo=lo, beta_hi=hi, pct=100 * np.expm1(m.params[term]),
                             pct_lo=100 * np.expm1(lo), pct_hi=100 * np.expm1(hi), t=m.tvalues[term], p=m.pvalues[term],
                             vif=v, r2=m.rsquared))
    out = pd.DataFrame(rows)
    out.to_csv(config.output_dir(C.SECTION) / "clinical_model.csv", index=False)
    with pd.option_context("display.width", 200):
        print(out.round(4).to_string(index=False))


if __name__ == "__main__":
    main()
