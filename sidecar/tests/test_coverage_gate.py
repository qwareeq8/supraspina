"""Regression tests for the explicit Python coverage release gate."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest


def _gate() -> ModuleType:
    path = Path(__file__).parents[1] / "scripts" / "check_coverage.py"
    spec = importlib.util.spec_from_file_location("check_coverage", path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _summary(
    *,
    statements: int = 100,
    covered_statements: int = 100,
    branches: int = 100,
    covered_branches: int = 100,
    excluded: int = 0,
) -> dict[str, int]:
    return {
        "covered_lines": covered_statements,
        "num_statements": statements,
        "covered_branches": covered_branches,
        "num_branches": branches,
        "excluded_lines": excluded,
    }


def _report(gate: ModuleType, totals: dict[str, int]) -> dict[str, Any]:
    return {
        "totals": totals,
        "files": {name: {"summary": _summary()} for name in gate.CRITICAL_MODULES},
    }


def test_gate_accepts_exact_overall_floor_and_stronger_critical_aggregate() -> None:
    gate = _gate()
    report = _report(
        gate,
        _summary(covered_statements=80, covered_branches=80),
    )

    failures, metrics = gate.evaluate(report)

    assert failures == []
    assert metrics["overall_statements"] == 80
    assert metrics["overall_branches"] == 80
    assert metrics["critical_statements"] == 100
    assert metrics["critical_branches"] == 100


def test_gate_uses_unrounded_percentages_for_statement_and_branch_failures() -> None:
    gate = _gate()
    report = _report(
        gate,
        _summary(
            statements=10_000,
            covered_statements=7_999,
            branches=10_000,
            covered_branches=7_999,
        ),
    )

    failures, _metrics = gate.evaluate(report)

    assert failures == [
        "Raise overall_statements from 79.99% to at least 80.00%.",
        "Raise overall_branches from 79.99% to at least 80.00%.",
    ]


def test_gate_rejects_exclusions_and_missing_critical_modules() -> None:
    gate = _gate()
    excluded = _report(gate, _summary(excluded=1))
    failures, _metrics = gate.evaluate(excluded)
    assert failures == ["Remove coverage exclusions from this release gate."]

    missing = _report(gate, _summary())
    missing["files"].pop(gate.CRITICAL_MODULES[0])
    with pytest.raises(ValueError, match="Include these critical modules"):
        gate.evaluate(missing)


def test_gate_rejects_one_undercovered_critical_module_even_when_aggregate_passes() -> (
    None
):
    gate = _gate()
    report = _report(gate, _summary())
    name = gate.CRITICAL_MODULES[0]
    report["files"][name]["summary"] = _summary(
        statements=10_000,
        covered_statements=8_999,
        branches=10_000,
        covered_branches=8_999,
    )

    failures, metrics = gate.evaluate(report)

    assert failures == [
        f"Raise {name} statements from 89.99% to at least 90.00%.",
        f"Raise {name} branches from 89.99% to at least 90.00%.",
    ]
    assert metrics["critical_statements"] > 90
    assert metrics["critical_branches"] > 90
    assert metrics["critical_modules"][name]["statements"] == 89.99
    assert metrics["critical_modules"][name]["branches"] == 89.99


def test_gate_accepts_every_critical_module_at_exact_unrounded_floor() -> None:
    gate = _gate()
    report = _report(gate, _summary())
    for name in gate.CRITICAL_MODULES:
        report["files"][name]["summary"] = _summary(
            covered_statements=90,
            covered_branches=90,
        )

    failures, metrics = gate.evaluate(report)

    assert failures == []
    assert all(
        module["statements"] == 90 and module["branches"] == 90
        for module in metrics["critical_modules"].values()
    )


@pytest.mark.parametrize(
    "report",
    [
        {},
        {"files": {}},
        {"totals": []},
        {"totals": {}, "files": []},
    ],
)
def test_gate_rejects_a_report_without_totals_and_files_objects(
    report: dict[str, Any],
) -> None:
    gate = _gate()

    with pytest.raises(
        ValueError,
        match="Provide a coverage report containing totals and files objects",
    ):
        gate.evaluate(report)


def test_gate_rejects_exclusions_reported_only_by_a_critical_module() -> None:
    gate = _gate()
    report = _report(gate, _summary())
    report["files"][gate.CRITICAL_MODULES[0]]["summary"] = _summary(excluded=2)

    failures, metrics = gate.evaluate(report)

    assert failures == ["Remove coverage exclusions from this release gate."]
    assert metrics["overall_excluded_lines"] == 0
    assert metrics["critical_excluded_lines"] == 2


def test_gate_treats_an_absent_excluded_lines_field_as_no_exclusion() -> None:
    gate = _gate()
    report = _report(gate, _summary())
    report["totals"].pop("excluded_lines")
    for name in gate.CRITICAL_MODULES:
        report["files"][name]["summary"].pop("excluded_lines")

    failures, metrics = gate.evaluate(report)

    assert failures == []
    assert metrics["overall_excluded_lines"] == 0
    assert metrics["critical_excluded_lines"] == 0


def test_gate_names_the_critical_aggregate_floors_it_misses() -> None:
    gate = _gate()
    report = _report(gate, _summary())
    for name in gate.CRITICAL_MODULES:
        report["files"][name]["summary"] = _summary(
            covered_statements=89,
            covered_branches=89,
        )

    failures, metrics = gate.evaluate(report)

    assert failures[:2] == [
        "Raise critical_statements from 89.00% to at least 90.00%.",
        "Raise critical_branches from 89.00% to at least 90.00%.",
    ]
    assert metrics["critical_statements"] == 89
    assert metrics["critical_branches"] == 89


def test_main_reports_measured_coverage_for_a_named_report_and_exits_zero(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    gate = _gate()
    report = tmp_path / "named-coverage.json"
    report.write_text(json.dumps(_report(gate, _summary())), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["check_coverage.py", str(report)])

    assert gate.main() == 0

    printed = capsys.readouterr().out
    assert (
        "Measured Python coverage: statements 100.00% (100/100), "
        "branches 100.00% (100/100); "
        "critical statements 100.00% (1100/1100), "
        "critical branches 100.00% (1100/1100)." in printed
    )
    assert (
        f"Measured critical module {gate.CRITICAL_MODULES[0]} coverage: "
        "statements 100.00% (100/100), branches 100.00% (100/100)." in printed
    )
    assert "Fix this coverage gate failure" not in printed


def test_main_reads_the_default_report_and_exits_one_naming_each_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    gate = _gate()
    report = _report(
        gate,
        _summary(
            statements=10_000,
            covered_statements=7_999,
            branches=10_000,
            covered_branches=7_999,
        ),
    )
    (tmp_path / "coverage.json").write_text(json.dumps(report), encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, "argv", ["check_coverage.py"])

    assert gate.main() == 1

    printed = capsys.readouterr().out
    assert (
        "Fix this coverage gate failure: "
        "Raise overall_statements from 79.99% to at least 80.00%." in printed
    )
    assert (
        "Fix this coverage gate failure: "
        "Raise overall_branches from 79.99% to at least 80.00%." in printed
    )
