"""Converged Freedman-Lane permutation engine for the reported P values (group-level output only).

Same model as stats_lib: y ~ group + covariates, two-sided |t| for the group term, nuisance =
intercept + covariates, maximum |t| across the columns of a family for the family-wise P. Columns of
one family may have different covariates or rows: one set of random keys per permutation couples
them, because the permutation of a row subset is the rank order of its keys. Draws are split across
`nproc` independent streams, so N is rounded up to a multiple of nproc (10,000,000 gives 10,000,008).
"""

from multiprocessing import Pool

import numpy as np
import pandas as pd
from scipy import stats


def paper_round(p):
    """Rounding used in the paper: < 0.001, three decimals below 0.1, two decimals from 0.1."""
    if p < 0.001:
        return "< 0.001"
    return "%.3f" % p if p < 0.1 else "%.2f" % p


class Col:
    """One tested column: y (length n_all, NaN = missing), covariate names, and the frame."""

    def __init__(self, name, y, frame, cov, gcol="sci"):
        self.name = name
        ok = np.isfinite(y)
        self.idx = np.flatnonzero(ok)
        g = frame[gcol].values[ok].astype(float)
        zc = [np.ones(ok.sum())]
        for c in cov:
            v = frame[c].values[ok].astype(float)
            if np.ptp(v) > 0:
                zc.append(v)
        Z = np.column_stack(zc)
        X = np.column_stack([Z[:, :1], g, Z[:, 1:]])
        yy = y[ok].astype(float)
        # The t statistic is affine invariant; standardizing avoids cancellation in the RSS.
        yy = (yy - yy.mean()) / yy.std()
        XtX = np.linalg.inv(X.T @ X)
        self.df = len(yy) - X.shape[1]
        self.w = (XtX @ X.T)[1]
        self.H = X @ XtX @ X.T
        self.c = XtX[1, 1]
        Hz = Z @ np.linalg.pinv(Z)
        self.fit = Hz @ yy
        self.res = yy - self.fit
        self.n = len(yy)
        self.t_obs = self.tstat(yy[None, :])[0]

    def tstat(self, Yp):
        beta = Yp @ self.w
        rss = (Yp * Yp).sum(1) - ((Yp @ self.H) * Yp).sum(1)
        return beta / np.sqrt(rss / self.df * self.c)


_G = {}


def _null_t(cols, u):
    """Return |t| of every column under the permutations encoded by the random keys u (b, n_all)."""
    cache = {}
    T = np.empty((len(u), len(cols)))
    for j, c in enumerate(cols):
        key = c.idx.tobytes()
        if key not in cache:
            cache[key] = np.argsort(u[:, c.idx], axis=1)
        T[:, j] = np.abs(c.tstat(c.fit[None, :] + c.res[cache[key]]))
    return T


def _work(args):
    ss, nb, bsz = args
    cols, n_all = _G["cols"], _G["n_all"]
    rng = np.random.default_rng(ss)
    m = len(cols)
    ex1 = np.zeros(m)
    exm = np.zeros(m)
    done = 0
    tobs = np.array([abs(c.t_obs) for c in cols]) * (1 - 1e-9)
    while done < nb:
        b = min(bsz, nb - done)
        T = _null_t(cols, rng.random((b, n_all)))
        ex1 += (T >= tobs).sum(0)
        exm += (T.max(1)[:, None] >= tobs).sum(0)
        done += b
    return ex1, exm


def run_family(cols, n_all, N, seed, nproc=12, bsz=4000):
    """Single and max-T P (with Monte Carlo SE) per column of one family."""
    _G["cols"] = cols
    _G["n_all"] = n_all
    per = int(np.ceil(N / nproc))
    tot = per * nproc
    ss = np.random.SeedSequence(seed).spawn(nproc)
    with Pool(nproc) as pool:
        out = pool.map(_work, [(s, per, bsz) for s in ss])
    ex1 = sum(o[0] for o in out)
    exm = sum(o[1] for o in out)
    p1 = (ex1 + 1) / (tot + 1)
    pm = (exm + 1) / (tot + 1)

    def se(p):
        return np.sqrt(p * (1 - p) / tot)

    return pd.DataFrame({"name": [c.name for c in cols], "n": [c.n for c in cols], "t": [c.t_obs for c in cols],
                         "N": tot, "p_single": p1, "se_single": se(p1), "p_maxT": pm, "se_maxT": se(pm)})


def cols_from(frame, names, cov, y=None, fam_cov=None, gcol="sci"):
    return [Col(nm, (frame[nm].values if y is None else y[nm]).astype(float), frame,
                (fam_cov or {}).get(nm, cov), gcol=gcol) for nm in names]


def _work_multi(args):
    """Run _work with one maximum per named family and, optionally, the null count of P < 0.05."""
    ss, nb, bsz = args
    cols, n_all, fams, cnt = _G["cols"], _G["n_all"], _G["fams"], _G["cnt"]
    rng = np.random.default_rng(ss)
    m = len(cols)
    ex1 = np.zeros(m)
    exf = {f: np.zeros(len(ix)) for f, ix in fams.items()}
    hist = {k: np.zeros(len(ix) + 1, np.int64) for k, (ix, tc) in cnt.items()}
    tobs = np.array([abs(c.t_obs) for c in cols]) * (1 - 1e-9)
    done = 0
    while done < nb:
        b = min(bsz, nb - done)
        T = _null_t(cols, rng.random((b, n_all)))
        ex1 += (T >= tobs).sum(0)
        for f, ix in fams.items():
            mx = T[:, ix].max(1)
            exf[f] += (mx[:, None] >= tobs[ix][None, :]).sum(0)
        for k, (ix, tc) in cnt.items():
            hist[k] += np.bincount((T[:, ix] > tc[None, :]).sum(1), minlength=len(ix) + 1)
        done += b
    return ex1, exf, hist


def run_multi(cols, n_all, N, seed, fams, counts=None, nproc=12, bsz=4000):
    """Several families from one permutation set.

    fams: {name: [column names]}; counts: {name: [column names]} for the null of the number of
    columns at parametric P < 0.05. A run whose only family is every column equals run_family.
    Returns (long DataFrame: family, name, n, t, N, p_single, se_single, p_fwe, se_fwe;
    dict of count summaries: observed, null mean and SD, null 95th percentile, P).
    """
    pos = {c.name: i for i, c in enumerate(cols)}
    fidx = {f: np.array([pos[c] for c in v]) for f, v in fams.items()}
    cidx = {}
    for k, v in (counts or {}).items():
        ix = np.array([pos[c] for c in v])
        cidx[k] = (ix, np.array([stats.t.ppf(0.975, cols[i].df) for i in ix]))
    _G.update(cols=cols, n_all=n_all, fams=fidx, cnt=cidx)
    per = int(np.ceil(N / nproc))
    tot = per * nproc
    ss = np.random.SeedSequence(seed).spawn(nproc)
    with Pool(nproc) as pool:
        out = pool.map(_work_multi, [(s, per, bsz) for s in ss])
    ex1 = sum(o[0] for o in out)
    p1 = (ex1 + 1) / (tot + 1)

    def se(p):
        return np.sqrt(p * (1 - p) / tot)

    rows = []
    for f, ix in fidx.items():
        exf = sum(o[1][f] for o in out)
        pf = (exf + 1) / (tot + 1)
        for k, i in enumerate(ix):
            c = cols[i]
            rows.append(dict(family=f, name=c.name, n=c.n, t=c.t_obs, N=tot, p_single=p1[i], se_single=se(p1[i]),
                             p_fwe=pf[k], se_fwe=se(pf[k])))
    csum = {}
    for k, (ix, _tc) in cidx.items():
        h = sum(o[2][k] for o in out)
        obs = int(sum(2 * stats.t.sf(abs(cols[i].t_obs), cols[i].df) < 0.05 for i in ix))
        kk = np.arange(len(h))
        mean = float((kk * h).sum() / tot)
        cdf = np.cumsum(h) / tot
        p = (h[obs:].sum() + 1) / (tot + 1)
        csum[k] = dict(observed=obs, null_mean=mean, null_sd=float(np.sqrt((kk ** 2 * h).sum() / tot - mean ** 2)),
                       null_p95=int(np.searchsorted(cdf, 0.95)), N=tot, p=float(p),
                       se_p=float(np.sqrt(p * (1 - p) / tot)),
                       se_mean=float(np.sqrt(((kk ** 2 * h).sum() / tot - mean ** 2) / tot)))
    return pd.DataFrame(rows), csum
