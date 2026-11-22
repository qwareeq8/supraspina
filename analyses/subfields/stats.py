"""Brainstem subfield volumes (FreeSurfer 8.2.0 segment_subregions brainstem): SCI vs control models.

Model per structure (medulla, pons, superior cerebellar peduncle, midbrain, whole brainstem): volume ~ SCI + age +
sex + eTIV, OLS with centered covariates. Reported per structure: the adjusted difference in mm3 and as a percentage
of the control mean, Hedges g = J b / s with the normal-approximation 95% CI J (b -/+ t_0.975 se) / s, the
parametric P, Benjamini-Hochberg q over the five structures, and the Freedman-Lane max-|t| family-wise P over the
five (5,000 permutations, seed 20260923).

Writes <work_dir>/subfields/brainstem_subfields.csv and outcome_values.csv (participant level) and
<output_dir>/subfields/brainstem_subfield_stats.csv.
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import config  # noqa: E402

NPERM = 5000
SEED = 20260923
S = ["Medulla", "Pons", "SCP", "Midbrain", "Whole_brainstem"]
WORK = config.work_dir("subfields")
OUT = config.output_dir("subfields")


def read_volumes(pid):
    f = WORK / "subregions" / pid / "brainstemSsLabels.volumes.txt"
    if not f.exists():
        return None
    v = dict(line.split() for line in f.read_text().splitlines() if line.strip())
    return {k: float(v[k]) for k in S}


def fit(Y, X):
    b, *_ = np.linalg.lstsq(X, Y, rcond=None)
    res = Y - X @ b
    dof = X.shape[0] - X.shape[1]
    mse = (res ** 2).sum(0) / dof
    se = np.sqrt(np.outer(np.diag(np.linalg.inv(X.T @ X)), mse))
    return b, se, mse, dof


subs = config.participants()
rows, miss = [], 0
for pid in subs.participant_id:
    v = read_volumes(pid)
    if v is None:
        miss += 1
        continue
    rows.append({"participant_id": pid, **v})
vol = pd.DataFrame(rows, columns=["participant_id", *S])
vol.to_csv(WORK / "brainstem_subfields.csv", index=False)
print(f"Brainstem subfields: {len(vol)} of {len(subs)} participants; {miss} missing.")
ov = subs[["participant_id"]].merge(vol, on="participant_id", how="left")
ov = ov.rename(columns={k: f"subfield_{k}" for k in S})
ov["elig_subfields"] = 1
ov.to_csv(WORK / "outcome_values.csv", index=False)

d = subs.merge(vol, on="participant_id")
g = d.sci.astype(float).values
Z = np.c_[np.ones(len(d)), d.age - d.age.mean(), d.female - d.female.mean(), (d.eTIV - d.eTIV.mean()) / 1e5]
X = np.c_[g, Z]
Y = d[S].values
b, se, mse, dof = fit(Y, X)
t = b[0] / se[0]
bz, *_ = np.linalg.lstsq(Z, Y, rcond=None)
fz = Z @ bz
ez = Y - fz
rng = np.random.default_rng(SEED)
maxt = np.empty(NPERM)
for i in range(NPERM):
    bb, ss, _, _ = fit(fz + ez[rng.permutation(len(d))], X)
    maxt[i] = np.abs(bb[0] / ss[0]).max()
p = 2 * stats.t.sf(np.abs(t), dof)
o = np.argsort(p)
m = len(S)
q = np.empty(m)
q[o] = np.minimum.accumulate((p[o] * m / np.arange(1, m + 1))[::-1])[::-1]
J = 1 - 3 / (4 * dof - 1)
tc = stats.t.ppf(0.975, dof)
out = []
for j, s in enumerate(S):
    sd = np.sqrt(mse[j])
    cm = Y[g == 0, j].mean()
    out.append(dict(structure=s, n_sci=int(g.sum()), n_ctrl=int((g == 0).sum()), ctrl_mean_mm3=cm,
                    adj_diff_mm3=b[0, j], adj_diff_pct=100 * b[0, j] / cm, g_adj=J * b[0, j] / sd,
                    g_ci95_lo=J * (b[0, j] - tc * se[0, j]) / sd, g_ci95_hi=J * (b[0, j] + tc * se[0, j]) / sd,
                    t=t[j], df=dof, p=p[j], q_fdr=q[j], p_fwe_maxT=(1 + (maxt >= abs(t[j])).sum()) / (NPERM + 1)))
res = pd.DataFrame(out)
res.round(5).to_csv(OUT / "brainstem_subfield_stats.csv", index=False)
pd.set_option("display.width", 200)
print(res[["structure", "n_sci", "n_ctrl", "adj_diff_pct", "g_adj", "g_ci95_lo", "g_ci95_hi", "p", "q_fdr",
           "p_fwe_maxT"]].round(3).to_string(index=False))
