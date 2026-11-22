"""The pure-Python t and noncentral-t functions against SciPy and closed forms."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from supraspina_sidecar.group_analysis import distributions as dist

GOLDENS = json.loads(
    (
        Path(__file__).parent
        / "fixtures"
        / "group_analysis"
        / "distribution-goldens.json"
    ).read_text(encoding="utf-8")
)


def _relative(actual: float, expected: float) -> float:
    return abs(actual - expected) / max(abs(expected), 1e-300)


@pytest.mark.parametrize("case", GOLDENS["betainc"])
def test_betainc_matches_scipy(case: dict[str, float]) -> None:
    value = dist.betainc(case["a"], case["b"], case["x"])
    assert _relative(value, case["value"]) <= 1e-12


@pytest.mark.parametrize("case", GOLDENS["t"])
def test_t_cdf_and_sf_match_scipy(case: dict[str, float]) -> None:
    assert _relative(dist.t_cdf(case["t"], case["df"]), case["cdf"]) <= 1e-12
    assert _relative(dist.t_sf(case["t"], case["df"]), case["sf"]) <= 1e-12


@pytest.mark.parametrize("case", GOLDENS["tPpf"])
def test_t_ppf_matches_scipy(case: dict[str, float]) -> None:
    assert _relative(dist.t_ppf(case["p"], case["df"]), case["t"]) <= 1e-12


@pytest.mark.parametrize("case", GOLDENS["nct"])
def test_nct_cdf_matches_scipy(case: dict[str, float]) -> None:
    value = dist.nct_cdf(case["t"], case["df"], case["ncp"])
    assert abs(value - case["cdf"]) <= 1e-12
    assert dist.nct_sf(case["t"], case["df"], case["ncp"]) == pytest.approx(
        1.0 - case["cdf"], abs=1e-12
    )


@pytest.mark.parametrize("case", GOLDENS["nctInterval"])
def test_nct_interval_matches_the_validation_analysis(case: dict[str, object]) -> None:
    low, high = dist.nct_interval(case["t"], case["df"])  # type: ignore[arg-type]
    expected_low, expected_high = case["interval"]  # type: ignore[misc]
    assert low == pytest.approx(expected_low, abs=1e-9)
    assert high == pytest.approx(expected_high, abs=1e-9)


@pytest.mark.parametrize("t", [-40.0, -3.0, -0.5, 1e-9, 0.25, 2.0, 1e6])
def test_t_cdf_closed_forms(t: float) -> None:
    # Cauchy (df 1) and df 2 have closed forms.
    assert dist.t_cdf(t, 1.0) == pytest.approx(0.5 + math.atan(t) / math.pi, rel=1e-14)
    assert dist.t_cdf(t, 2.0) == pytest.approx(
        0.5 + t / (2.0 * math.sqrt(2.0 + t * t)), rel=1e-14
    )


def test_t_edges_and_symmetry() -> None:
    assert dist.t_cdf(0.0, 7.0) == 0.5
    assert dist.t_cdf(math.inf, 7.0) == 1.0
    assert dist.t_cdf(-math.inf, 7.0) == 0.0
    assert dist.t_sf(1.3, 7.0) == dist.t_cdf(-1.3, 7.0)
    assert dist.t_ppf(0.5, 7.0) == 0.0
    assert dist.t_ppf(0.9, 7.0) == pytest.approx(-dist.t_ppf(0.1, 7.0), rel=1e-14)
    assert dist.t_cdf(dist.t_ppf(0.123, 11.0), 11.0) == pytest.approx(0.123, rel=1e-14)
    assert dist.betainc(2.0, 3.0, 0.0) == 0.0
    assert dist.betainc(2.0, 3.0, 1.0) == 1.0
    # I_x(1, 1) = x and I_x(a, 1) = x^a.
    assert dist.betainc(1.0, 1.0, 0.37) == pytest.approx(0.37, rel=1e-15)
    assert dist.betainc(2.5, 1.0, 0.6) == pytest.approx(0.6**2.5, rel=1e-14)


def test_large_df_log_beta_is_accurate() -> None:
    # Far past 20 the Stirling branch carries log B(1/2, df / 2).
    df = 20000.0
    expected = math.lgamma(0.5) + math.lgamma(df / 2) - math.lgamma(df / 2 + 0.5)
    assert dist._log_beta(0.5, df / 2) == pytest.approx(expected, abs=1e-10)
    assert dist._log_beta(df / 2, 0.5) == dist._log_beta(0.5, df / 2)
    # SciPy 1.18 values.
    assert dist.t_cdf(1.96, 1e5) == pytest.approx(0.9750007184028492, rel=1e-12)
    assert dist.t_sf(4.5, 20000.0) == pytest.approx(3.4168198188243576e-06, rel=1e-11)


def test_nct_reduces_to_t_and_handles_edges() -> None:
    for t in (-2.0, -0.4, 0.0, 1.1, 3.0):
        assert dist.nct_cdf(t, 12.0, 0.0) == pytest.approx(
            dist.t_cdf(t, 12.0), abs=1e-14
        )
    # At t = 0 the CDF is Phi(-ncp).
    assert dist.nct_cdf(0.0, 9.0, 1.5) == pytest.approx(
        0.5 * math.erfc(1.5 / math.sqrt(2.0)), abs=1e-15
    )
    assert dist.nct_cdf(math.inf, 9.0, 1.0) == 1.0
    assert dist.nct_cdf(-math.inf, 9.0, 1.0) == 0.0


def test_brentq_finds_roots_and_rejects_bad_brackets() -> None:
    assert dist.brentq(lambda x: x * x - 2.0, 0.0, 2.0) == pytest.approx(
        math.sqrt(2.0), abs=1e-12
    )
    assert dist.brentq(lambda x: math.cos(x) - x, 0.0, 1.0) == pytest.approx(
        0.7390851332151607, abs=1e-12
    )
    assert dist.brentq(lambda x: x - 1.0, 1.0, 3.0) == 1.0
    assert dist.brentq(lambda x: x - 3.0, 1.0, 3.0) == 3.0
    with pytest.raises(ValueError, match="not bracketed"):
        dist.brentq(lambda x: x * x + 1.0, -1.0, 1.0)
    with pytest.raises(ArithmeticError, match="did not converge"):
        dist.brentq(lambda x: x**3 - 0.3, 0.0, 1.0, xtol=0.0, rtol=0.0, maxiter=3)


def test_invalid_arguments_are_rejected() -> None:
    with pytest.raises(ValueError, match="degrees of freedom"):
        dist.t_cdf(1.0, 0.0)
    with pytest.raises(ValueError, match="degrees of freedom"):
        dist.t_cdf(1.0, math.inf)
    with pytest.raises(ValueError, match="t quantile"):
        dist.t_cdf(math.nan, 3.0)
    with pytest.raises(ValueError, match="quantile probability"):
        dist.t_ppf(1.0, 3.0)
    with pytest.raises(ValueError, match="shape parameters"):
        dist.betainc(0.0, 1.0, 0.5)
    with pytest.raises(ValueError, match="lie in"):
        dist.betainc(1.0, 1.0, 1.5)
    with pytest.raises(ValueError, match="finite numbers"):
        dist.nct_cdf(1.0, 3.0, math.inf)


def test_nct_interval_steps_out_from_a_poor_normal_approximation() -> None:
    # SciPy 1.18 roots; with t 10 and df 1 the lower bound lies two steps out.
    low, high = dist.nct_interval(10.0, 1.0)
    assert low == pytest.approx(-0.18263860261221476, abs=1e-9)
    assert high == pytest.approx(22.525818629271217, abs=1e-9)
    low, high = dist.nct_interval(40.0, 3.0)
    assert low == pytest.approx(10.644880616855815, abs=1e-9)
    assert high == pytest.approx(70.66230951665524, abs=1e-9)


def test_a_nonconvergent_incomplete_beta_fraction_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(dist, "_CF_MAX_ITERATIONS", 1)
    with pytest.raises(ArithmeticError) as raised:
        dist.betainc(50.0, 50.0, 0.45)
    assert type(raised.value) is ArithmeticError
    assert str(raised.value) == "The incomplete beta function did not converge."


def test_a_t_quantile_past_the_lowest_bound_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The first doubling from -1 to -2 passes this bound.
    monkeypatch.setattr(dist, "_LOWEST_QUANTILE", -1.5)
    dist.t_ppf.cache_clear()
    try:
        with pytest.raises(ArithmeticError) as raised:
            dist.t_ppf(1e-3, 3.0)
    finally:
        dist.t_ppf.cache_clear()
    assert type(raised.value) is ArithmeticError
    assert str(raised.value) == "The t quantile is out of range."


def test_an_unbracketed_noncentral_t_interval_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A flat survival function never changes sign, so the steps reach the cap.
    monkeypatch.setattr(dist, "nct_sf", lambda t, df, ncp: 0.0)
    with pytest.raises(ArithmeticError) as raised:
        dist.nct_interval(2.0, 10.0)
    assert type(raised.value) is ArithmeticError
    assert str(raised.value) == "The noncentral-t interval did not bracket."
