#!/usr/bin/env python3
"""Release gate for honest aggregate and explicit critical-module coverage floors."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

OVERALL_STATEMENT_FLOOR = 80.0
OVERALL_BRANCH_FLOOR = 80.0
CRITICAL_STATEMENT_FLOOR = 90.0
CRITICAL_BRANCH_FLOOR = 90.0

# Keep this scientific and safety boundary list stable. Protect modules that
# authorize, identify, plan, schedule, persist, project, and redact externally
# observable scientific work.
CRITICAL_MODULES = (
    "supraspina_sidecar/__main__.py",
    "supraspina_sidecar/authorization.py",
    "supraspina_sidecar/cohort.py",
    "supraspina_sidecar/debug_bundle.py",
    "supraspina_sidecar/membership.py",
    "supraspina_sidecar/project.py",
    "supraspina_sidecar/provisioning.py",
    "supraspina_sidecar/results.py",
    "supraspina_sidecar/run_store.py",
    "supraspina_sidecar/workflow.py",
    "supraspina_sidecar/workflow_manager.py",
)


def _percentage(covered: int, total: int) -> float:
    return 100.0 if total == 0 else covered * 100.0 / total


def _counts(summaries: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "covered_statements": sum(int(value["covered_lines"]) for value in summaries),
        "total_statements": sum(int(value["num_statements"]) for value in summaries),
        "covered_branches": sum(int(value["covered_branches"]) for value in summaries),
        "total_branches": sum(int(value["num_branches"]) for value in summaries),
        "excluded_lines": sum(
            int(value.get("excluded_lines", 0)) for value in summaries
        ),
    }


def evaluate(report: dict[str, Any]) -> tuple[list[str], dict[str, Any]]:
    """Return threshold failures and exact metrics from one coverage JSON report."""
    totals = report.get("totals")
    files = report.get("files")
    if not isinstance(totals, dict) or not isinstance(files, dict):
        raise ValueError(
            "Provide a coverage report containing totals and files objects."
        )

    missing = [name for name in CRITICAL_MODULES if name not in files]
    if missing:
        missing_names = ", ".join(missing)
        raise ValueError(
            f"Include these critical modules in the coverage report: {missing_names}."
        )

    overall = _counts([totals])
    critical_summaries = {
        name: _counts([files[name]["summary"]]) for name in CRITICAL_MODULES
    }
    critical = _counts([files[name]["summary"] for name in CRITICAL_MODULES])
    per_module = {
        name: {
            "statements": _percentage(
                counts["covered_statements"], counts["total_statements"]
            ),
            "branches": _percentage(
                counts["covered_branches"], counts["total_branches"]
            ),
            **counts,
        }
        for name, counts in critical_summaries.items()
    }
    metrics: dict[str, Any] = {
        "overall_statements": _percentage(
            overall["covered_statements"], overall["total_statements"]
        ),
        "overall_branches": _percentage(
            overall["covered_branches"], overall["total_branches"]
        ),
        "critical_statements": _percentage(
            critical["covered_statements"], critical["total_statements"]
        ),
        "critical_branches": _percentage(
            critical["covered_branches"], critical["total_branches"]
        ),
        "critical_modules": per_module,
        **{f"overall_{key}": value for key, value in overall.items()},
        **{f"critical_{key}": value for key, value in critical.items()},
    }
    failures = []
    for key, floor in (
        ("overall_statements", OVERALL_STATEMENT_FLOOR),
        ("overall_branches", OVERALL_BRANCH_FLOOR),
        ("critical_statements", CRITICAL_STATEMENT_FLOOR),
        ("critical_branches", CRITICAL_BRANCH_FLOOR),
    ):
        value = float(metrics[key])
        if value < floor:
            failures.append(f"Raise {key} from {value:.2f}% to at least {floor:.2f}%.")
    for name, module in per_module.items():
        for key, floor in (
            ("statements", CRITICAL_STATEMENT_FLOOR),
            ("branches", CRITICAL_BRANCH_FLOOR),
        ):
            value = float(module[key])
            if value < floor:
                failures.append(
                    f"Raise {name} {key} from {value:.2f}% to at least {floor:.2f}%."
                )
    if overall["excluded_lines"] or critical["excluded_lines"]:
        failures.append("Remove coverage exclusions from this release gate.")
    return failures, metrics


def main() -> int:
    """Validate a pytest-cov JSON report and return a process exit status."""
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "report",
        nargs="?",
        default="coverage.json",
        type=Path,
        help="Read the pytest-cov JSON report; default to coverage.json.",
    )
    args = parser.parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8"))
    failures, metrics = evaluate(report)
    overall_statement_count = (
        f"{metrics['overall_covered_statements']}/{metrics['overall_total_statements']}"
    )
    overall_branch_count = (
        f"{metrics['overall_covered_branches']}/{metrics['overall_total_branches']}"
    )
    critical_statement_count = (
        f"{metrics['critical_covered_statements']}/"
        f"{metrics['critical_total_statements']}"
    )
    critical_branch_count = (
        f"{metrics['critical_covered_branches']}/{metrics['critical_total_branches']}"
    )
    print(
        "Measured Python coverage: "
        f"statements {metrics['overall_statements']:.2f}% "
        f"({overall_statement_count}), "
        f"branches {metrics['overall_branches']:.2f}% "
        f"({overall_branch_count}); "
        f"critical statements {metrics['critical_statements']:.2f}% "
        f"({critical_statement_count}), "
        f"critical branches {metrics['critical_branches']:.2f}% "
        f"({critical_branch_count})."
    )
    for name, module in metrics["critical_modules"].items():
        print(
            f"Measured critical module {name} coverage: "
            f"statements {module['statements']:.2f}% "
            f"({module['covered_statements']}/{module['total_statements']}), "
            f"branches {module['branches']:.2f}% "
            f"({module['covered_branches']}/{module['total_branches']})."
        )
    if failures:
        for failure in failures:
            print(f"Fix this coverage gate failure: {failure}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
