"""Covariation along the somatosensory pathway (Table 2; Fig. 4B).

Within SCI: partial correlations of the DCN region, the ventral thalamic group, and S1 trunk area, adjusted
for age, sex, and eTIV, with Holm correction across the three pairs, in all participants with SCI and in the
sensitivity sample. The minimum detectable partial r at 80% power (two-sided 0.05, Fisher z) is given at
the within-SCI n. In all participants: ventral thalamic volume ~ DCN region + group + DCN region x group +
covariates (DCN region and covariates mean-centered), one t test of the interaction, with the partial
correlation in each group. Writes <output_dir>/clinical/covariation.csv and interaction.csv.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import optimize, stats

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import clinical_lib as C  # noqa: E402
import config  # noqa: E402
from family_models import holm  # noqa: E402

PAIRS = [("dcn", "thal_ventral"), ("thal_ventral", "s1_trunk_area"), ("dcn", "s1_trunk_area")]


def min_detectable_r(n: int, k: int = 3, power: float = 0.8) -> float:
    c = stats.norm.ppf(0.975)

    def pw(r):
        z = np.arctanh(r) * np.sqrt(n - 3 - k)
        return stats.norm.sf(c - z) + stats.norm.cdf(-c - z) - power

    return optimize.brentq(pw, 0.01, 0.99)


def main():
    d = C.load(["dcn", "thal_ventral", "s1_trunk_area"])
    rows = []
    for sample, frame in (("all", C.sci_only(d)), ("sensitivity", C.sci_only(d, sensitivity=True))):
        part = [dict(sample=sample, x=x, y=y, **C.partial_r(frame, x, y, C.COV)) for x, y in PAIRS]
        for r, ph in zip(part, holm([r["p"] for r in part]), strict=True):
            r["p_holm"] = ph
            r["min_detectable_r"] = min_detectable_r(r["n"], r["k_cov"])
        rows += part
    cov = pd.DataFrame(rows)
    cov.to_csv(config.output_dir(C.SECTION) / "covariation.csv", index=False)

    f = d.dropna(subset=["dcn", "thal_ventral", *C.COV]).copy()
    cv = [c for c in C.COV if np.ptp(f[c].astype(float).values) > 0]
    f["dcn_c"] = f.dcn - f.dcn.mean()
    f["dcn_x_sci"] = f.dcn_c * f.sci
    for c in cv:
        f[c] = f[c] - f[c].mean()
    _, _, m = C.ols(f, "thal_ventral", ["dcn_c", "sci", "dcn_x_sci", *cv])
    lo, hi = m.conf_int().loc["dcn_x_sci"]
    pr = {g: C.partial_r(f[f.sci == g], "dcn", "thal_ventral", cv) for g in (0, 1)}
    inter = pd.DataFrame([dict(n=int(m.nobs), n_sci=int(f.sci.sum()), n_ctrl=int((f.sci == 0).sum()),
                               beta_interaction=m.params["dcn_x_sci"], ci_lo=lo, ci_hi=hi, t=m.tvalues["dcn_x_sci"],
                               p=m.pvalues["dcn_x_sci"], partial_r_ctrl=pr[0]["r"], partial_r_ctrl_lo=pr[0]["r_lo"],
                               partial_r_ctrl_hi=pr[0]["r_hi"], n_partial_ctrl=pr[0]["n"], partial_r_sci=pr[1]["r"],
                               partial_r_sci_lo=pr[1]["r_lo"], partial_r_sci_hi=pr[1]["r_hi"],
                               units="ventral thalamus mm3 per unit mean log-Jacobian")])
    inter.to_csv(config.output_dir(C.SECTION) / "interaction.csv", index=False)
    with pd.option_context("display.width", 200):
        print(cov.round(4).to_string(index=False))
        print(inter.round(4).T.to_string(header=False))


if __name__ == "__main__":
    main()
