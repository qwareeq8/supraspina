"""Cross-step data dependency enforcement during run-time preflight.

This backstops the renderer's proactive cross-step dependency gate. A step's
prerequisites are the upstream steps whose declared outputs it reads, and a
step cannot launch until every in-scope subject reports ``done`` for each
prerequisite. Each prerequisite's detector is read instead of a shared matrix
column, which matches the renderer's ``stepStates`` gate.

Keep ``STEP_DEPENDENCIES`` synchronized with the same map in
``src/shared/steps.ts``.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .registry import STEP_DEPENDENCIES

#: Mirror ``STEP_DEPENDENCIES`` in ``src/shared/steps.ts``. Read ``A -> B`` as B
#: consuming an artifact from A. Keep the forest rooted at ``recon`` and
#: ``deface`` as an optional source without dependents. Mirror actionable
#: reasons in ``STEP_PREREQ_REASON`` so both gates read alike.
STEP_PREREQ_REASON: dict[str, str] = {
    "enigma": "Finish reconstruction before ENIGMA QC.",
    "outliers": "Finish ENIGMA QC before outlier review.",
    "features": "Finish reconstruction before feature extraction.",
    "age": "Finish feature extraction before age integration.",
    "pybrainage": "Finish age integration before PyBrainAge.",
    "clinical": "Finish PyBrainAge before the clinical merge.",
    "brainpad": "Finish the clinical workbook before Brain-PAD statistics.",
    "aggregate": "Finish reconstruction before structural aggregation.",
    "final": "Finish structural aggregation before the R analysis.",
}


def _is_done(adapter: Any, cfg: dict[str, Any], subject_id: str) -> bool:
    """Report prerequisite completion for one subject; treat errors as incomplete.

    Treat a raised filesystem detector as incomplete instead of aborting
    preflight.
    """
    try:
        return adapter.detect(cfg, subject_id).state == "done"
    except Exception:
        return False


def _all_done(adapter: Any, cfg: dict[str, Any], subject_ids: list[str]) -> bool:
    """Report whether a prerequisite step is done for every in-scope subject.

    Treat an empty or undiscoverable cohort as unsatisfied so the prerequisite
    gate fails closed.

    Parameters
    ----------
    subject_ids
        Provide the concrete in-scope subject ids.

    Returns
    -------
    bool
        Return true when the prerequisite is satisfied for the scope.
    """
    if not subject_ids:
        return False
    return all(_is_done(adapter, cfg, subject_id) for subject_id in subject_ids)


def prerequisite_blockers(
    cfg: dict[str, Any],
    key: str,
    subject_ids: list[str | None],
    *,
    get_adapter: Callable[[str], Any],
    list_cohort: Callable[[dict[str, Any]], list[str]],
) -> list[str]:
    """Return one blocking reason per unmet upstream-step prerequisite of ``key``.

    Require every applicable in-scope subject to finish each prerequisite.
    Discover in-scope subjects through ``list_cohort`` for a cohort-wide submit.
    Match the renderer's ``computeDependencyBlockers`` so both gates agree.

    Parameters
    ----------
    subject_ids
        Provide concrete ids or ``[None]`` for a cohort-wide run.
    get_adapter
        Provide a resolver from a step key to its adapter or ``None``.
    list_cohort
        Provide a function that lists subject IDs for a cohort-wide submit.

    Returns
    -------
    list of str
        Return blocking reasons for unmet prerequisites or an empty list when
        all are satisfied or the step has none.
    """
    deps = STEP_DEPENDENCIES.get(key, ())
    if not deps:
        return []
    concrete = [s for s in subject_ids if s is not None]
    if not concrete:
        concrete = list_cohort(cfg)
    reasons: list[str] = []
    for dep in deps:
        adapter = get_adapter(dep)
        if adapter is None or not _all_done(adapter, cfg, concrete):
            reasons.append(
                STEP_PREREQ_REASON.get(key, f"{key} needs {dep} to finish first.")
            )
            break
    return reasons
