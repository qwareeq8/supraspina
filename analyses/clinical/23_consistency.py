"""How consistently the DCN-region deficit appears across participants with SCI (Results).

DCN region ~ age + female + eTIV is fitted in controls and predicts each participant with SCI; residuals are
percentage differences, 100 (exp(y - prediction) - 1). Control residuals are leave-one-out, so their spread
is not shrunk by in-sample fitting. Counts participants below the prediction and below the 5th percentile
of the control residuals. Writes <output_dir>/clinical/consistency.csv (counts only).
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import clinical_lib as C  # noqa: E402
import config  # noqa: E402


def design(f: pd.DataFrame) -> np.ndarray:
    return np.column_stack([np.ones(len(f))] + [f[c].astype(float).values for c in C.COV])


def main():
    d = C.load(["dcn"]).dropna(subset=["dcn"])
    ct, sc = d[d.sci == 0], d[d.sci == 1]
    Xc, yc = design(ct), ct.dcn.astype(float).values
    loo = np.empty(len(ct))
    for i in range(len(ct)):
        m = np.ones(len(ct), bool)
        m[i] = False
        b = np.linalg.lstsq(Xc[m], yc[m], rcond=None)[0]
        loo[i] = 100 * np.expm1(yc[i] - Xc[i] @ b)
    b = np.linalg.lstsq(Xc, yc, rcond=None)[0]
    pct = 100 * np.expm1(sc.dcn.astype(float).values - design(sc) @ b)
    p5 = np.percentile(loo, 5)
    out = pd.DataFrame([dict(outcome="dcn", n_sci=len(pct), n_sci_below_prediction=int((pct < 0).sum()),
                             n_sci_below_ctrl_p5=int((pct < p5).sum()), n_ctrl=len(loo),
                             n_ctrl_below_prediction=int((loo < 0).sum()), n_ctrl_below_ctrl_p5=int((loo < p5).sum()),
                             ctrl_p5_pct=p5)])
    out.to_csv(config.output_dir(C.SECTION) / "consistency.csv", index=False)
    print(out.round(2).T.to_string(header=False))


if __name__ == "__main__":
    main()
