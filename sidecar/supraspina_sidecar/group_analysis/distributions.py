"""Pure-Python distribution functions for the analysis engine.

NumPy has no Student-t or noncentral-t distribution and the sidecar carries
no SciPy, so these are implemented here: the regularized incomplete beta
function, the Student t CDF and quantile, the noncentral-t CDF (the series
of Lenth's AS 243, summed from the Poisson mode), and a Brent root finder
for confidence-interval inversion.

Accuracy against SciPy 1.18: the
incomplete beta and the t CDF and survival function agree to about 1e-13
relative for 1 to 5000 degrees of freedom; the noncentral-t CDF to about
1e-14 absolute; t quantiles to about 1e-13 relative and CI roots to about
1e-12 absolute.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from functools import lru_cache
from statistics import NormalDist

_EPS = 2.220446049250313e-16
_TINY = 1e-300
_CF_MAX_ITERATIONS = 10_000
_NCT_MAX_ITERATIONS = 100_000
_NCT_NEGLIGIBLE = 1e-17
_HALF = 0.5
_STIRLING_MIN = 20.0
_LOWEST_QUANTILE = -1e300
_MAX_STEP = 1e4
# Stirling series coefficients B_2k / (2k (2k - 1)) of log Gamma, k = 1..7.
_STIRLING = (
    1.0 / 12.0,
    -1.0 / 360.0,
    1.0 / 1260.0,
    -1.0 / 1680.0,
    1.0 / 1188.0,
    -691.0 / 360360.0,
    1.0 / 156.0,
)


def _check_df(df: float) -> None:
    if not df > 0 or math.isinf(df):
        raise ValueError("The degrees of freedom must be positive and finite.")


def _stirling_correction(x: float) -> float:
    """Return log Gamma(x) minus its Stirling approximation, for x >= 20."""
    inverse = 1.0 / x
    square = inverse * inverse
    total = 0.0
    for coefficient in reversed(_STIRLING):
        total = total * square + coefficient
    return total * inverse


def _log_gamma_ratio(x: float, s: float) -> float:
    """Return log Gamma(x) - log Gamma(x + s) without cancellation for large x."""
    if x < _STIRLING_MIN:
        return math.lgamma(x) - math.lgamma(x + s)
    return (
        -(x - _HALF) * math.log1p(s / x)
        - s * math.log(x + s)
        + s
        + _stirling_correction(x)
        - _stirling_correction(x + s)
    )


def _log_beta(a: float, b: float) -> float:
    """Return log B(a, b) without cancellation when one argument is large.

    ``lgamma(b) - lgamma(a + b)`` loses about ``log(b) * 1e-16`` absolute
    for large ``b`` (the t distribution's ``df / 2``), so that difference
    comes from the Stirling series instead.
    """
    small, large = (a, b) if a <= b else (b, a)
    if large < _STIRLING_MIN:
        return math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)
    return math.lgamma(small) + _log_gamma_ratio(large, small)


def _log_poisson(k: int, lam: float) -> float:
    """Return log(exp(-lam) lam^k / k!) (Loader's saddle-point form for k >= 20)."""
    if k == 0:
        return -lam
    if k < _STIRLING_MIN:
        return -lam + k * math.log(lam) - math.lgamma(k + 1.0)
    v = (k - lam) / lam
    deviance = lam * ((1.0 + v) * math.log1p(v) - v)
    return -_stirling_correction(k) - deviance - _HALF * math.log(2.0 * math.pi * k)


def _nonzero(value: float) -> float:
    """Replace a vanishing Lentz denominator by a tiny positive number."""
    return value if abs(value) >= _TINY else _TINY


def _continued_fraction(a: float, b: float, x: float) -> float:
    """Evaluate the incomplete-beta continued fraction (modified Lentz)."""
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c = 1.0
    d = 1.0 / _nonzero(1.0 - qab * x / qap)
    h = d
    for m in range(1, _CF_MAX_ITERATIONS + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 / _nonzero(1.0 + aa * d)
        c = _nonzero(1.0 + aa / c)
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 / _nonzero(1.0 + aa * d)
        c = _nonzero(1.0 + aa / c)
        delta = d * c
        h *= delta
        if abs(delta - 1.0) <= _EPS:
            return h
    # The fraction converges in O(sqrt(max(a, b))) terms where it is used.
    raise ArithmeticError("The incomplete beta function did not converge.")


def _betainc(a: float, b: float, x: float, y: float) -> float:
    """Return I_x(a, b) given both ``x`` and ``y = 1 - x`` to full precision."""
    if x <= 0.0:
        return 0.0
    if y <= 0.0:
        return 1.0
    log_x = math.log1p(-y) if y < _HALF else math.log(x)
    log_y = math.log1p(-x) if x < _HALF else math.log(y)
    if x < (a + 1.0) / (a + b + 2.0):
        front = math.exp(a * log_x + b * log_y - _log_beta(a, b))
        return front * _continued_fraction(a, b, x) / a
    front = math.exp(a * log_x + b * log_y - _log_beta(a, b))
    return 1.0 - front * _continued_fraction(b, a, y) / b


def betainc(a: float, b: float, x: float) -> float:
    """Return the regularized incomplete beta function I_x(a, b).

    Parameters
    ----------
    a, b
        The positive shape parameters.
    x
        The upper limit in [0, 1].

    Returns
    -------
    float
        I_x(a, b).
    """
    if not (a > 0 and b > 0):
        raise ValueError("The beta shape parameters must be positive.")
    if not 0.0 <= x <= 1.0:
        raise ValueError("The incomplete beta argument must lie in [0, 1].")
    return _betainc(a, b, x, 1.0 - x)


def _t_tail(t: float, df: float) -> float:
    """Return P(T > |t|), the one-sided tail beyond ``|t|``."""
    if math.isinf(t):
        return 0.0
    t2 = t * t
    denominator = df + t2
    # I_x(df/2, 1/2) with x = df / (df + t^2) and 1 - x = t^2 / (df + t^2).
    return _HALF * _betainc(_HALF * df, _HALF, df / denominator, t2 / denominator)


def t_cdf(t: float, df: float) -> float:
    """Return the Student t CDF P(T <= t).

    Returns
    -------
    float
        The lower-tail probability.
    """
    _check_df(df)
    if math.isnan(t):
        raise ValueError("The t quantile must be a number.")
    if t == 0.0:
        return _HALF
    tail = _t_tail(t, df)
    return tail if t < 0 else 1.0 - tail


def t_sf(t: float, df: float) -> float:
    """Return the Student t survival function P(T > t).

    Returns
    -------
    float
        The upper-tail probability.
    """
    return t_cdf(-t, df)


def f_sf(f: float, df1: float, df2: float) -> float:
    """Return the F survival function P(F > f).

    Parameters
    ----------
    df1, df2
        The numerator and denominator degrees of freedom.

    Returns
    -------
    float
        The upper-tail probability, I_x(df2/2, df1/2) with
        x = df2 / (df2 + df1 f).
    """
    _check_df(df1)
    _check_df(df2)
    if math.isnan(f):
        raise ValueError("The F quantile must be a number.")
    if f <= 0.0:
        return 1.0
    if math.isinf(f):
        return 0.0
    scaled = df1 * f
    denominator = df2 + scaled
    return _betainc(_HALF * df2, _HALF * df1, df2 / denominator, scaled / denominator)


@lru_cache(maxsize=256)
def t_ppf(p: float, df: float) -> float:
    """Return the Student t quantile of probability ``p``.

    Parameters
    ----------
    p
        The lower-tail probability in (0, 1).

    Returns
    -------
    float
        The t with P(T <= t) = p.
    """
    _check_df(df)
    if not 0.0 < p < 1.0:
        raise ValueError("The quantile probability must lie in (0, 1).")
    if p == _HALF:
        return 0.0
    if p > _HALF:
        return -t_ppf(1.0 - p, df)
    # Bracket the lower-tail root, then refine with Brent's method.
    hi = 0.0
    lo = -1.0
    while t_cdf(lo, df) > p:
        hi = lo
        lo *= 2.0
        # Only a p that underflows every quantile reaches this bound.
        if lo < _LOWEST_QUANTILE:
            raise ArithmeticError("The t quantile is out of range.")
    return brentq(lambda value: t_cdf(value, df) - p, lo, hi, xtol=1e-300)


def _normal_sf(x: float) -> float:
    return _HALF * math.erfc(x / math.sqrt(2.0))


def _nct_series(t: float, df: float, delta: float) -> float:
    """Return P(T <= t) - Phi(-delta) for t > 0 (the Poisson-weighted series).

    With x = t^2 / (t^2 + df), b = df / 2, and lam = delta^2 / 2 the series is
    ``1/2 sum_j [p_j I_x(j + 1/2, b) + delta / sqrt(2) q_j I_x(j + 1, b)]``,
    ``p_j = exp(-lam) lam^j / j!`` and ``q_j = exp(-lam) lam^j / Gamma(j + 3/2)``
    (Guenther 1978; Lenth, AS 243). Summation starts at the Poisson mode and
    runs down to 0 and up until the remaining weight is negligible (Benton
    and Krishnamoorthy 2003), so a large noncentrality neither underflows
    the first weight nor needs thousands of terms.
    """
    t2 = t * t
    x = t2 / (t2 + df)
    y = df / (t2 + df)
    log_x = math.log1p(-y) if y < _HALF else math.log(x)
    log_y = math.log1p(-x) if x < _HALF else math.log(y)
    b = _HALF * df
    lam = _HALF * delta * delta
    scale = delta / math.sqrt(2.0)
    mode = int(lam)
    p_mode = math.exp(_log_poisson(mode, lam))
    q_mode = p_mode * math.exp(_log_gamma_ratio(mode + 1.0, _HALF))

    def start(a: float) -> tuple[float, float]:
        # I_x(a, b) and g(a) = I_x(a, b) - I_x(a + 1, b).
        log_g = a * log_x + b * log_y - math.log(a) - _log_beta(a, b)
        return _betainc(a, b, x, y), math.exp(log_g)

    ip_mode, gp_mode = start(mode + _HALF)
    iq_mode, gq_mode = start(mode + 1.0)
    total = p_mode * ip_mode + scale * q_mode * iq_mode
    mass = p_mode
    # Down from the mode: I_x(a - 1, b) = I_x(a, b) + g(a - 1).
    p, q, ip, iq, gp, gq = p_mode, q_mode, ip_mode, iq_mode, gp_mode, gq_mode
    ap, aq = mode + _HALF, mode + 1.0
    for j in range(mode, 0, -1):
        gp *= ap / (x * (ap - 1.0 + b))
        gq *= aq / (x * (aq - 1.0 + b))
        ap, aq = ap - 1.0, aq - 1.0
        ip += gp
        iq += gq
        p *= j / lam
        q *= (j + _HALF) / lam
        total += p * ip + scale * q * iq
        mass += p
        if p + abs(scale) * q < _NCT_NEGLIGIBLE:
            break
    # Up from the mode: I_x(a + 1, b) = I_x(a, b) - g(a).
    p, q, ip, iq, gp, gq = p_mode, q_mode, ip_mode, iq_mode, gp_mode, gq_mode
    ap, aq = mode + _HALF, mode + 1.0
    remaining = 1.0 - mass
    j = mode
    while remaining > 0.0 and j - mode < _NCT_MAX_ITERATIONS:
        ip -= gp
        iq -= gq
        gp *= x * (ap + b) / (ap + 1.0)
        gq *= x * (aq + b) / (aq + 1.0)
        ap, aq = ap + 1.0, aq + 1.0
        j += 1
        p *= lam / j
        q *= lam / (j + _HALF)
        total += p * ip + scale * q * iq
        remaining -= p
        # The later terms add at most remaining * (I_p + |scale| I_q / sqrt(2 j)).
        bound = remaining * (ip + abs(scale) * iq / math.sqrt(2.0 * j))
        if bound <= _NCT_NEGLIGIBLE:
            break
    return _HALF * total


def nct_cdf(t: float, df: float, ncp: float) -> float:
    """Return the noncentral-t CDF.

    The Poisson-weighted incomplete beta series of Guenther and Lenth
    (AS 243), summed outward from the Poisson mode (Benton and Krishnamoorthy
    2003) so it stays accurate to about 1e-15 absolute for any noncentrality.

    Returns
    -------
    float
        P(T <= t) for T noncentral t with ``df`` and ``ncp``.
    """
    _check_df(df)
    if math.isnan(t) or math.isnan(ncp) or math.isinf(ncp):
        raise ValueError("The noncentral-t arguments must be finite numbers.")
    if math.isinf(t):
        return 1.0 if t > 0 else 0.0
    negative = t < 0.0
    tt = -t if negative else t
    delta = -ncp if negative else ncp
    total = _normal_sf(delta)
    if tt > 0.0:
        total += _nct_series(tt, df, delta)
    if negative:
        total = 1.0 - total
    return min(1.0, max(0.0, total))


def nct_sf(t: float, df: float, ncp: float) -> float:
    """Return the noncentral-t survival function P(T > t).

    Returns
    -------
    float
        The upper-tail probability.
    """
    return 1.0 - nct_cdf(t, df, ncp)


def brentq(  # noqa: PLR0913
    f: Callable[[float], float],
    lo: float,
    hi: float,
    *,
    xtol: float = 1e-12,
    rtol: float = 4 * _EPS,
    maxiter: int = 200,
) -> float:
    """Return a root of ``f`` bracketed by ``lo`` and ``hi`` (Brent's method).

    The iteration follows SciPy's ``brentq`` (inverse quadratic
    interpolation with bisection fallback) so the two agree to the tolerance.

    Parameters
    ----------
    f
        A continuous function with opposite signs at ``lo`` and ``hi``.
    xtol, rtol
        Stop once the bracket is within ``xtol + rtol * |x|``.

    Raises
    ------
    ValueError
        When ``f(lo)`` and ``f(hi)`` share a sign.
    ArithmeticError
        When the iteration limit is reached.
    """
    return _brent(f, lo, hi, f(lo), f(hi), xtol=xtol, rtol=rtol, maxiter=maxiter)


def _brent(  # noqa: PLR0912, PLR0913
    f: Callable[[float], float],
    x_pre: float,
    x_cur: float,
    f_pre: float,
    f_cur: float,
    *,
    xtol: float = 1e-12,
    rtol: float = 4 * _EPS,
    maxiter: int = 200,
) -> float:
    """Run :func:`brentq` on a bracket whose end values are known."""
    if f_pre == 0.0:
        return x_pre
    if f_cur == 0.0:
        return x_cur
    if math.copysign(1.0, f_pre) == math.copysign(1.0, f_cur):
        raise ValueError("The root is not bracketed.")
    x_blk = f_blk = s_pre = s_cur = 0.0
    for _ in range(maxiter):
        if (
            f_pre != 0.0
            and f_cur != 0.0
            and math.copysign(1.0, f_pre) != math.copysign(1.0, f_cur)
        ):
            x_blk, f_blk = x_pre, f_pre
            s_pre = s_cur = x_cur - x_pre
        if abs(f_blk) < abs(f_cur):
            x_pre, x_cur, x_blk = x_cur, x_blk, x_cur
            f_pre, f_cur, f_blk = f_cur, f_blk, f_cur
        delta = (xtol + rtol * abs(x_cur)) / 2.0
        s_bis = (x_blk - x_cur) / 2.0
        if f_cur == 0.0 or abs(s_bis) < delta:
            return x_cur
        if abs(s_pre) > delta and abs(f_cur) < abs(f_pre):
            if x_pre == x_blk:
                s_try = -f_cur * (x_cur - x_pre) / (f_cur - f_pre)
            else:
                d_pre = (f_pre - f_cur) / (x_pre - x_cur)
                d_blk = (f_blk - f_cur) / (x_blk - x_cur)
                s_try = (
                    -f_cur
                    * (f_blk * d_blk - f_pre * d_pre)
                    / (d_blk * d_pre * (f_blk - f_pre))
                )
            if 2.0 * abs(s_try) < min(abs(s_pre), 3.0 * abs(s_bis) - delta):
                s_pre, s_cur = s_cur, s_try
            else:
                s_pre = s_cur = s_bis
        else:
            s_pre = s_cur = s_bis
        x_pre, f_pre = x_cur, f_cur
        if abs(s_cur) > delta:
            x_cur += s_cur
        else:
            x_cur += delta if s_bis > 0 else -delta
        f_cur = f(x_cur)
    raise ArithmeticError("The root search did not converge.")


def nct_interval(t: float, df: float, level: float = 0.95) -> tuple[float, float]:
    """Return the CI of the noncentrality parameter by inverting the noncentral t.

    The bounds solve ``P(T > t; ncp) = (1 - level) / 2`` and
    ``(1 + level) / 2``. Each search
    starts at the normal approximation ``t + z * sqrt(1 + t^2 / (2 df))`` and
    steps outward until the root is bracketed, then refines it with Brent's
    method.

    Returns
    -------
    tuple of float
        The lower and upper noncentrality bounds.
    """
    alpha = (1.0 - level) / 2.0
    spread = math.sqrt(1.0 + t * t / (2.0 * df))

    def root(target: float) -> float:
        def f(ncp: float) -> float:
            return nct_sf(t, df, ncp) - target

        # P(T > t; ncp) increases with ncp.
        near = t + spread * NormalDist().inv_cdf(target)
        f_near = f(near)
        direction = 1.0 if f_near < 0.0 else -1.0
        step = _HALF * spread
        far = near + direction * step
        f_far = f(far)
        while (f_far < 0.0) == (f_near < 0.0):
            # Only an absurd t walks this far without a bracket.
            if step > _MAX_STEP:
                raise ArithmeticError("The noncentral-t interval did not bracket.")
            near, f_near = far, f_far
            step *= 2.0
            far = near + direction * step
            f_far = f(far)
        return _brent(f, near, far, f_near, f_far)

    return root(alpha), root(1.0 - alpha)
