"""Group model shared by the brainstem, compartment, DARTEL, and whole-brain analyses.

Model: y ~ group + age + female + eTIV (liters), OLS. Adjusted d = t sqrt(v_jj), the group
coefficient over the residual SD, with a 95% CI from the noncentral t; Hedges g = d (1 - 3 / (4 df - 1)).
Percent difference = 100 (exp(beta) - 1) for log-Jacobian outcomes and 100 beta / control mean
otherwise. Permutation: Freedman-Lane (nuisance = intercept + covariates), two-sided, with the
maximum |t| over the columns of Y for the family-wise P.
"""

import numpy as np
from scipy import optimize, stats

COV = ("age", "female", "eTIV_l")


def nct_ci(t_obs, dfree, level=0.95):
    a = (1 - level) / 2

    def root(target):
        return optimize.brentq(lambda ncp: stats.nct.sf(t_obs, dfree, ncp) - target, t_obs - 30, t_obs + 30)

    return root(a), root(1 - a)


def design(frame, gcol, cov=COV):
    """Group indicator, nuisance matrix Z, and full design X; constant covariates are dropped."""
    g = frame[gcol].astype(float).values
    Z = [np.ones(len(frame))] + [
        frame[c].astype(float).values for c in cov if np.ptp(frame[c].astype(float).values) > 0
    ]
    Z = np.column_stack(Z)
    X = np.column_stack([Z[:, :1], g, Z[:, 1:]])
    return g, Z, X


def fit(frame, y, gcol="sci", cov=COV, log_outcome=True):
    g, Z, X = design(frame, gcol, cov)
    XtX = np.linalg.inv(X.T @ X)
    b = XtX @ X.T @ y
    r = y - X @ b
    dfree = len(y) - X.shape[1]
    s2 = r @ r / dfree
    se = np.sqrt(s2 * XtX[1, 1])
    t = b[1] / se
    p = 2 * stats.t.sf(abs(t), dfree)
    k = np.sqrt(XtX[1, 1])
    lo, hi = nct_ci(float(t), float(dfree))
    tc = stats.t.ppf(0.975, dfree)
    d = t * k
    J = 1 - 3 / (4 * dfree - 1)
    res = dict(
        n=len(y), n_grp1=int(g.sum()), n_grp0=int((g == 0).sum()), grp0_mean=float(y[g == 0].mean()),
        beta=b[1], beta_lo=b[1] - tc * se, beta_hi=b[1] + tc * se, t=t, df=dfree, p_param=p,
        d=d, d_lo=lo * k, d_hi=hi * k, g=d * J, g_lo=lo * k * J, g_hi=hi * k * J,
    )
    if log_outcome:
        res.update(pct=100 * np.expm1(b[1]), pct_lo=100 * np.expm1(b[1] - tc * se),
                   pct_hi=100 * np.expm1(b[1] + tc * se))
    else:
        res.update(pct=100 * b[1] / y[g == 0].mean(), pct_lo=np.nan, pct_hi=np.nan)
    return res


def fl_maxt(frame, Y, gcol="sci", cov=COV, n_perm=5000, seed=20260924):
    """Freedman-Lane: per-column two-sided P and max-|t| family-wise P."""
    g, Z, X = design(frame, gcol, cov)
    XtX = np.linalg.inv(X.T @ X)
    dfree = len(g) - X.shape[1]

    def tstat(Yp):
        B = XtX @ X.T @ Yp
        Rr = Yp - X @ B
        return B[1] / np.sqrt((Rr * Rr).sum(0) / dfree * XtX[1, 1])

    t_obs = tstat(Y)
    Hz = Z @ np.linalg.pinv(Z)
    fitted = Hz @ Y
    resid = Y - fitted
    rng = np.random.default_rng(seed)
    ex_max = np.zeros(Y.shape[1])
    ex_single = np.zeros(Y.shape[1])
    for _ in range(n_perm):
        tp = tstat(fitted + resid[rng.permutation(len(g))])
        ex_max += np.abs(tp).max() >= np.abs(t_obs)
        ex_single += np.abs(tp) >= np.abs(t_obs)
    return t_obs, (ex_single + 1) / (n_perm + 1), (ex_max + 1) / (n_perm + 1)


def pfwe_exact(design_dir, k, n_chunks=8, n_perm=625):
    """One-direction TFCE P_FWE from exact permutation counts of chunked randomise runs.

    Each chunk stores corrp = 1 - n_k / n_perm in float32, so the mean over chunks can put P = 0.05 a
    rounding error below 0.05. Here n_k is recovered as an integer per chunk and P = sum(n_k) /
    (n_chunks n_perm), so thresholds compare exact fractions.
    """
    from pathlib import Path

    import nibabel as nib

    n = 0
    for s in range(1, n_chunks + 1):
        c = np.asarray(nib.load(Path(design_dir) / f"chunk{s}_tfce_corrp_tstat{k}.nii.gz").dataobj, dtype=np.float64)
        x = (1 - c) * n_perm
        r = np.rint(x)
        assert np.abs(x - r).max() < 1e-2, "corrp is not a multiple of 1 / n_perm."
        n = n + r.astype(np.int64)
    return n, n / (n_chunks * n_perm)
