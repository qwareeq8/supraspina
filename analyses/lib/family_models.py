"""OLS group models over families of FreeSurfer measures with per-measure missing cells.

Used by the thalamic, S1 and M1 parcel, and regional FreeSurfer analyses. Each measure is fitted on
its own complete cases: thickness and other intensive measures ~ group + age + sex; area, volume,
NumVert, FoldInd, and aseg volumes also + eTIV. Covariates are mean-centered. Adjusted d = t sqrt(v_jj)
with a noncentral-t 95% CI. Corrections: Benjamini-Hochberg, Holm, and Freedman-Lane max-|t| FWE
within each family (Winkler et al. 2014).

To keep one permutation per iteration for every measure (needed for max-T across measures with
different complete cases), each permutation of the full participant index is restricted to a
measure's complete cases by keeping the order in which those participants appear in it. That
restriction is itself a uniformly random permutation of the complete cases, and for a measure with
no missing cells it equals the full permutation.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import optimize, stats

# Contrast name -> (design key, focal term, reference label). The paper reports SCI vs controls only.
CONTRASTS = {"SCI_vs_CTRL": ("sci", "SCI", "CTRL")}


def design(df: pd.DataFrame, key: str, covars: list[str]) -> tuple[np.ndarray, list[str]]:
    """Return (X, column names): intercept + SCI indicator + mean-centered covariates."""
    if key != "sci":
        raise ValueError(key)
    cols: list[np.ndarray] = [np.ones(len(df)), df["sci"].to_numpy(float)]
    names = ["Intercept", "SCI"]
    for c in covars:
        v = df[c].to_numpy(dtype=float)
        cols.append(v - v.mean())
        names.append(c)
    return np.column_stack(cols), names


def nct_ci(t_obs: float, df: float, level: float = 0.95) -> tuple[float, float]:
    """Confidence interval for the noncentrality parameter by inverting the noncentral t."""
    a = (1 - level) / 2

    def root(target):
        return optimize.brentq(lambda ncp: stats.nct.sf(t_obs, df, ncp) - target, t_obs - 20, t_obs + 20)

    return root(a), root(1 - a)


def d_with_ci(t: float, df: float, vjj: float) -> tuple[float, float, float]:
    """Adjusted d = beta / residual SD = t sqrt(v_jj), CI by noncentral-t inversion."""
    k = np.sqrt(vjj)
    lo, hi = nct_ci(float(t), float(df))
    return t * k, lo * k, hi * k


def bh(p: np.ndarray) -> np.ndarray:
    p = np.asarray(p, float)
    n = len(p)
    order = np.argsort(p)
    q = p[order] * n / np.arange(1, n + 1)
    q = np.minimum.accumulate(q[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.minimum(q, 1)
    return out


def holm(p: np.ndarray) -> np.ndarray:
    p = np.asarray(p, float)
    n = len(p)
    order = np.argsort(p)
    adj = np.maximum.accumulate((n - np.arange(n)) * p[order])
    out = np.empty(n)
    out[order] = np.minimum(adj, 1)
    return out


def ncp_for_power(df: float, alpha: float = 0.05, power: float = 0.8) -> float:
    """Noncentrality giving the requested two-sided power for a t test with df."""
    tc = stats.t.ppf(1 - alpha / 2, df)

    def f(d):
        return stats.nct.sf(tc, df, d) + np.nan_to_num(stats.nct.sf(tc, df, -d)) - power

    return optimize.brentq(f, 0.01, 10.0)


def master_perms(seed: int, n_perm: int, n: int) -> np.ndarray:
    """Permutation matrix of the full participant index (n_perm, n)."""
    rng = np.random.default_rng(seed)
    return np.array([rng.permutation(n) for _ in range(n_perm)])


def induced_positions(perms: np.ndarray, rows: np.ndarray) -> np.ndarray:
    """Restrict full-index permutations to the sorted master rows `rows`; return positions in rows."""
    n_master = perms.shape[1]
    pos = np.full(n_master, -1)
    pos[rows] = np.arange(len(rows))
    keep = np.isin(perms, rows)
    sub = perms[keep].reshape(len(perms), len(rows))
    return pos[sub]


def fit_family(master: pd.DataFrame, include: np.ndarray, cols: list[str], contrast: str,
               covars_for, perms: np.ndarray | None, chunk: int = 250) -> tuple[pd.DataFrame, np.ndarray | None]:
    """Fit every column on its complete cases among the `include` rows of `master`.

    Row order of `master` is the permutation index. covars_for(col) -> covariate names. Returns the
    results and the null |t| matrix (n_perm, n_cols).
    """
    key, focal, _ = CONTRASTS[contrast]
    Yall = master[cols].to_numpy(float)
    blocks: dict[tuple, list[int]] = {}
    for i, c in enumerate(cols):
        rows = np.flatnonzero(include & ~np.isnan(Yall[:, i]))
        blocks.setdefault((rows.tobytes(), tuple(covars_for(c))), []).append(i)
    out: dict[int, dict] = {}
    T0 = np.empty((len(perms), len(cols))) if perms is not None else None
    for (rb, cv), idx in blocks.items():
        rows = np.frombuffer(rb, dtype=np.int64)
        frame = master.iloc[rows].reset_index(drop=True)
        X, names = design(frame, key, list(cv))
        j = names.index(focal)
        Y = Yall[np.ix_(rows, idx)]
        XtX_inv = np.linalg.inv(X.T @ X)
        A = XtX_inv @ X.T
        B = A @ Y
        R = Y - X @ B
        dfree = X.shape[0] - X.shape[1]
        s2 = (R ** 2).sum(0) / dfree
        vjj = XtX_inv[j, j]
        se = np.sqrt(s2 * vjj)
        t = B[j] / se
        p = 2 * stats.t.sf(np.abs(t), dfree)
        fm = frame["sci"].to_numpy() == 1
        rm = ~fm
        for k, i in enumerate(idx):
            yf, yr = Y[fm, k], Y[rm, k]
            d, lo, hi = d_with_ci(t[k], dfree, vjj)
            out[i] = {"measure": cols[i], "contrast": contrast, "covariates": "+".join(cv),
                      "n_total": len(rows), "n_focal": int(fm.sum()), "n_ref": int(rm.sum()),
                      "mean_focal": yf.mean(), "mean_ref": yr.mean(), "beta": B[j, k],
                      "pct_of_ref_mean": 100 * B[j, k] / yr.mean(), "t": t[k], "df": dfree, "p": p[k],
                      "d_adj": d, "d_lo": lo, "d_hi": hi, "vjj": vjj}
        if perms is not None:
            Z = np.delete(X, j, axis=1)
            E = Y - Z @ np.linalg.lstsq(Z, Y, rcond=None)[0]
            RX = np.eye(len(rows)) - X @ A
            P = induced_positions(perms, rows)
            for b0 in range(0, len(P), chunk):
                Es = E[P[b0:b0 + chunk]]
                bj = np.einsum("i,bim->bm", A[j], Es)
                Rp = np.einsum("ki,bim->bkm", RX, Es)
                s2p = (Rp ** 2).sum(1) / dfree
                T0[b0:b0 + chunk, idx] = np.abs(bj / np.sqrt(s2p * vjj))
    res = pd.DataFrame([out[i] for i in range(len(cols))])
    return res, T0


def add_corrections(res: pd.DataFrame, T0: np.ndarray | None, fam_cols: dict[str, list[str]],
                    across: dict[str, list[str]] | None = None) -> pd.DataFrame:
    """BH, Holm, and max-T FWE within each family; optional BH and max-T across sets of families."""
    res = res.set_index("measure")
    pos = {c: i for i, c in enumerate(res.index)}
    tobs = np.abs(res["t"].to_numpy())
    n_perm = len(T0) if T0 is not None else 0
    if T0 is not None:
        res["p_perm"] = (1 + (T0 >= tobs[None, :]).sum(0)) / (1 + n_perm)
    for fam, cols in fam_cols.items():
        res.loc[cols, "family"] = fam
        res.loc[cols, "q_bh_family"] = bh(res.loc[cols, "p"].to_numpy())
        res.loc[cols, "p_holm_family"] = holm(res.loc[cols, "p"].to_numpy())
        if T0 is not None:
            ii = [pos[c] for c in cols]
            mx = T0[:, ii].max(1)
            res.loc[cols, "p_fwe_family"] = (1 + (mx[:, None] >= tobs[ii][None, :]).sum(0)) / (1 + n_perm)
    for name, cols in (across or {}).items():
        res.loc[cols, f"q_bh_{name}"] = bh(res.loc[cols, "p"].to_numpy())
        if T0 is not None:
            ii = [pos[c] for c in cols]
            mx = T0[:, ii].max(1)
            res.loc[cols, f"p_fwe_{name}"] = (1 + (mx[:, None] >= tobs[ii][None, :]).sum(0)) / (1 + n_perm)
    return res.reset_index()


def null_count(T0: np.ndarray, res: pd.DataFrame, cols: list[str]) -> np.ndarray:
    """Permutation null distribution of the number of measures at P < 0.05 (per-measure df)."""
    r = res.set_index("measure")
    ii = [list(res.measure).index(c) for c in cols]
    dfs = r.loc[cols, "df"].to_numpy()
    p0 = 2 * stats.t.sf(T0[:, ii], dfs[None, :])
    return (p0 < 0.05).sum(1)
