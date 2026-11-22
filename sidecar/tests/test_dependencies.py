"""Tests for the cross-step prerequisite preflight rule.

``prerequisite_blockers`` mirrors the renderer's ``computeDependencyBlockers``:
a step stays blocked until every in-scope subject has finished each upstream
prerequisite, as reported by the upstream adapter's ``detect`` method. In-scope
subjects for a cohort-wide submission come from ``list_cohort``. These tests
pin the rule and the dependency forest in sync with ``src/shared/steps.ts`` and
``src/renderer/state/dependency-blockers.ts``.
"""

from __future__ import annotations

from typing import Any

from supraspina_sidecar.adapters.base import StepStatus
from supraspina_sidecar.dependencies import STEP_DEPENDENCIES, prerequisite_blockers


class _Adapter:
    """Report ``done`` for the named subjects as a prerequisite adapter."""

    def __init__(self, done_ids: set[str]) -> None:
        self._done = done_ids

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        return StepStatus(state="done" if subject_id in self._done else "pending")


def _get(**adapters: _Adapter):
    """Return a ``get_adapter`` resolving the given prerequisite stubs."""
    return adapters.get


def _never_cohort(_cfg: dict[str, Any]) -> list[str]:
    return []


def test_a_step_with_no_dependencies_is_never_blocked() -> None:
    assert (
        prerequisite_blockers(
            {}, "recon", ["s1"], get_adapter=_get(), list_cohort=_never_cohort
        )
        == []
    )


def test_blocks_when_no_in_scope_subject_finished_the_prerequisite() -> None:
    reasons = prerequisite_blockers(
        {},
        "features",
        ["s1", "s2"],
        get_adapter=_get(recon=_Adapter(set())),
        list_cohort=lambda c: ["s1", "s2"],
    )
    assert len(reasons) == 1
    assert "reconstruction" in reasons[0]


def test_blocks_when_only_one_in_scope_subject_finished_the_prerequisite() -> None:
    assert prerequisite_blockers(
        {},
        "features",
        ["s1", "s2"],
        get_adapter=_get(recon=_Adapter({"s1"})),
        list_cohort=_never_cohort,
    )


def test_cohort_wide_submit_discovers_the_cohort() -> None:
    allowed = prerequisite_blockers(
        {},
        "features",
        [None],
        get_adapter=_get(recon=_Adapter({"s1", "s2", "s3"})),
        list_cohort=lambda c: ["s1", "s2", "s3"],
    )
    assert allowed == []

    blocked = prerequisite_blockers(
        {},
        "features",
        [None],
        get_adapter=_get(recon=_Adapter(set())),
        list_cohort=lambda c: ["s1", "s2"],
    )
    assert len(blocked) == 1


def test_per_subject_scope_is_respected() -> None:
    get = _get(recon=_Adapter({"s1"}))
    assert (
        prerequisite_blockers(
            {}, "features", ["s2"], get_adapter=get, list_cohort=_never_cohort
        )
        != []
    )
    assert (
        prerequisite_blockers(
            {}, "features", ["s1"], get_adapter=get, list_cohort=_never_cohort
        )
        == []
    )


def test_empty_cohort_is_blocked() -> None:
    reasons = prerequisite_blockers(
        {},
        "features",
        [None],
        get_adapter=_get(recon=_Adapter(set())),
        list_cohort=_never_cohort,
    )
    assert len(reasons) == 1


def test_step_dependencies_mirror_the_renderer_forest() -> None:
    assert STEP_DEPENDENCIES == {
        "enigma": ("recon",),
        "outliers": ("enigma",),
        "features": ("recon",),
        "age": ("features",),
        "pybrainage": ("age",),
        "clinical": ("pybrainage",),
        "brainpad": ("clinical",),
        "aggregate": ("recon",),
        "final": ("aggregate",),
        "braincharts": ("features",),
        "zstats": ("braincharts",),
    }
