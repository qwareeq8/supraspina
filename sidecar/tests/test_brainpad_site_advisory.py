"""Tests for the plan advisory about Brain-PAD statistics pooling sites."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import sites, workflow
from supraspina_sidecar.adapters.base import Validation
from supraspina_sidecar.workflow import _brainpad_site_advisory, build_plan

_ROLES = ("healthy", "sci-no-neuropathic-pain", "sci-neuropathic-pain", "ambiguous")


def _fake_site_state(records: Any, subject_ids: Any = None) -> sites.SiteState:
    """Stand in for ``sites.site_state`` over records that all carry a site."""
    wanted = None if subject_ids is None else set(subject_ids)
    summaries: dict[str, sites.SiteSummary] = {}
    for record in records:
        if wanted is not None and record["subjectId"] not in wanted:
            continue
        label = record["site"]
        summary = summaries.setdefault(
            label,
            {"site": label, "subjects": 0, "roles": dict.fromkeys(_ROLES, 0)},
        )
        summary["subjects"] += 1
        summary["roles"][record["cohortRole"]] += 1
    return {
        "mode": "complete",
        "unset": [],
        "sites": [summaries[label] for label in sorted(summaries)],
    }


def _registry(rows: list[tuple[str, str, str | None]]) -> dict[str, dict[str, Any]]:
    registry: dict[str, dict[str, Any]] = {}
    for subject_id, role, site in rows:
        record: dict[str, Any] = {"subjectId": subject_id, "cohortRole": role}
        if site is not None:
            record["site"] = site
        registry[subject_id] = record
    return registry


def test_no_site_skips_site_state_entirely(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("A project without sites must not reach site_state.")

    monkeypatch.setattr(workflow, "site_state", fail)
    registry = _registry(
        [("sub-1", "healthy", None), ("sub-2", "sci-neuropathic-pain", None)]
    )
    assert _brainpad_site_advisory(("sub-1", "sub-2"), registry) is None


def test_names_one_site_without_controls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workflow, "site_state", _fake_site_state)
    registry = _registry(
        [
            ("sub-1", "healthy", "Prisma"),
            ("sub-2", "sci-neuropathic-pain", "Prisma"),
            ("sub-3", "sci-neuropathic-pain", "Ingenia"),
        ]
    )
    assert _brainpad_site_advisory(("sub-1", "sub-2", "sub-3"), registry) == (
        "Brain-PAD statistics pool all sites; site Ingenia has no controls."
    )


def test_every_site_with_controls_needs_no_advisory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(workflow, "site_state", _fake_site_state)
    registry = _registry(
        [
            ("sub-1", "healthy", "Prisma"),
            ("sub-2", "healthy", "Ingenia"),
            ("sub-3", "sci-neuropathic-pain", "Ingenia"),
        ]
    )
    assert _brainpad_site_advisory(("sub-1", "sub-2", "sub-3"), registry) is None


def test_counts_only_the_analysis_cohort(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workflow, "site_state", _fake_site_state)
    registry = _registry(
        [
            ("sub-1", "healthy", "Prisma"),
            ("sub-2", "healthy", "Ingenia"),
            ("sub-3", "sci-neuropathic-pain", "Ingenia"),
        ]
    )
    # sub-2 is outside the analysis cohort, so Ingenia has no controls in it.
    assert _brainpad_site_advisory(("sub-1", "sub-3"), registry) == (
        "Brain-PAD statistics pool all sites; site Ingenia has no controls."
    )


@pytest.mark.parametrize(
    ("labels", "named"),
    [
        (("Achieva", "Ingenia"), "sites Achieva and Ingenia have"),
        (("Achieva", "Ingenia", "Skyra"), "sites Achieva, Ingenia, and Skyra have"),
    ],
)
def test_names_several_sites_without_controls(
    monkeypatch: pytest.MonkeyPatch, labels: tuple[str, ...], named: str
) -> None:
    monkeypatch.setattr(workflow, "site_state", _fake_site_state)
    rows = [("sub-0", "healthy", "Prisma")] + [
        (f"sub-{index}", "sci-no-neuropathic-pain", label)
        for index, label in enumerate(labels, start=1)
    ]
    registry = _registry(rows)
    assert _brainpad_site_advisory(tuple(registry), registry) == (
        f"Brain-PAD statistics pool all sites; {named} no controls."
    )


class _Adapter:
    def __init__(self, key: str) -> None:
        self.key = key

    def validate(self, _cfg: dict[str, Any], _env: dict[str, Any]) -> Validation:
        return Validation()

    def build_command(self, _cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        return [self.key, subject_id or "cohort"]

    def preview(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        return " ".join(self.build_command(cfg, subject_id))


def _plan_brainpad(
    root: Path, monkeypatch: pytest.MonkeyPatch, rows: list[tuple[str, str, str | None]]
) -> tuple[str, ...]:
    """Plan the Brain-PAD stage over a registry listing ``rows``."""
    raw = root / "rawdata"
    for subject_id, _role, _site in rows:
        path = raw / subject_id / "anat" / f"{subject_id}_T1w.nii.gz"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(subject_id.encode())
    cfg = {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(raw),
            "derivativesDir": str(root / "derivatives"),
            "outputDir": str(root / "output"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "subjects": {"include": [], "exclude": []},
        "runtime": {"dryRun": True},
        "steps": {"brainpad": {"enabled": True, "params": {}}},
    }
    listed = list(_registry(rows).values())

    class _Store:
        def __init__(self, _root: str) -> None:
            pass

        def list(self, _cfg: dict[str, Any]) -> list[dict[str, Any]]:
            return listed

    monkeypatch.setattr(workflow, "RegistryStore", _Store)
    monkeypatch.setattr(workflow, "ADAPTERS", {"brainpad": _Adapter("brainpad")})
    planned = build_plan(
        {
            "project": {
                "projectId": "advisory-project",
                "root": str(root),
                "configPath": str(root / "supraspina.project.json"),
                "epoch": 1,
            },
            "cfg": cfg,
            "configRevision": 1,
            "intent": {
                "kind": "stage",
                "stepKey": "brainpad",
                "target": {"mode": "all"},
            },
            "acknowledgements": {"includeDeferredAndUnreviewedQc": True},
        }
    )
    assert planned.result["plan"]["nodes"][0]["status"] == "planned"
    return planned.warnings


def test_plan_carries_the_advisory_and_keeps_the_node_planned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(workflow, "site_state", _fake_site_state)
    warnings = _plan_brainpad(
        tmp_path,
        monkeypatch,
        [
            ("sub-001", "healthy", "Prisma"),
            ("sub-002", "sci-neuropathic-pain", "Prisma"),
            ("sub-003", "sci-neuropathic-pain", "Ingenia"),
        ],
    )
    assert warnings[-1] == (
        "Brain-PAD statistics pool all sites; site Ingenia has no controls."
    )


def test_plan_without_sites_adds_no_advisory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    warnings = _plan_brainpad(
        tmp_path,
        monkeypatch,
        [("sub-001", "healthy", None), ("sub-002", "sci-neuropathic-pain", None)],
    )
    assert not any("Brain-PAD" in warning for warning in warnings)


def test_real_site_state_drives_the_advisory() -> None:
    registry = _registry(
        [
            ("sub-1", "healthy", "Prisma"),
            ("sub-2", "sci-neuropathic-pain", "Prisma"),
            ("sub-3", "sci-neuropathic-pain", "Ingenia"),
        ]
    )
    assert _brainpad_site_advisory(("sub-1", "sub-2", "sub-3"), registry) == (
        "Brain-PAD statistics pool all sites; site Ingenia has no controls."
    )
