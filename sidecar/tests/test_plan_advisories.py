"""Tests for the plan advisories plan review shows beside the blockers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import workflow
from supraspina_sidecar.adapters.base import Validation
from supraspina_sidecar.workflow import _metadata_site_advisory, build_plan

_MEMORY_LINE = (
    "runtime.memoryWarningGB is an advisory threshold; it never changes "
    "scientific execution."
)


def _registry(rows: list[tuple[str, str, str | None]]) -> dict[str, dict[str, Any]]:
    registry: dict[str, dict[str, Any]] = {}
    for subject_id, role, site in rows:
        record: dict[str, Any] = {"subjectId": subject_id, "cohortRole": role}
        if site is not None:
            record["site"] = site
        registry[subject_id] = record
    return registry


def _metadata(root: Path, text: str) -> dict[str, Any]:
    metadata = root / "metadata"
    metadata.mkdir(parents=True, exist_ok=True)
    (metadata / "metadata.csv").write_text(text, encoding="utf-8")
    return {"paths": {"metadataDir": str(metadata)}}


def test_metadata_site_advisory_names_subjects_whose_site_differs(
    tmp_path: Path,
) -> None:
    cfg = _metadata(
        tmp_path,
        "participant_id,Cohort,Site\n"
        "sub-1,SCI_H,Prisma\n"
        "sub-2,SCI_P,Ingenia\n"
        "sub-3,SCI_P,Skyra\n",
    )
    registry = _registry(
        [
            ("sub-1", "healthy", "Prisma"),
            ("sub-2", "sci-neuropathic-pain", "Prisma"),
            ("sub-3", "sci-neuropathic-pain", None),
        ]
    )
    assert _metadata_site_advisory(cfg, ("sub-1", "sub-2", "sub-3"), registry) == (
        "The metadata file gives sub-2 and sub-3 a different site from the "
        "registry; R analysis uses the registry site."
    )


def test_metadata_site_advisory_counts_beyond_the_sample(tmp_path: Path) -> None:
    ids = [f"sub-{index}" for index in range(1, 6)]
    cfg = _metadata(
        tmp_path,
        "subject,Group,site\n" + "".join(f"{i},SCI_P,Ingenia\n" for i in ids),
    )
    registry = _registry([(i, "sci-neuropathic-pain", "Prisma") for i in ids])
    assert _metadata_site_advisory(cfg, tuple(ids), registry) == (
        "The metadata file gives sub-1, sub-2, and 3 more subjects a different "
        "site from the registry; R analysis uses the registry site."
    )


@pytest.mark.parametrize(
    "text",
    [
        # Every stated site matches the registry.
        "participant_id,Cohort,Site\nsub-1,SCI_H,Prisma\nsub-2,SCI_P,Prisma\n",
        # Empty cells state no site, so the registry fills them silently.
        "participant_id,Cohort,Site\nsub-1,SCI_H,\nsub-2,SCI_P, \n",
        # No site column at all.
        "participant_id,Cohort\nsub-1,SCI_H\nsub-2,SCI_P\n",
        # A differing row outside the analysis cohort.
        "participant_id,Cohort,Site\nsub-1,SCI_H,Prisma\nsub-9,SCI_P,Ingenia\n",
    ],
)
def test_metadata_site_advisory_stays_quiet(tmp_path: Path, text: str) -> None:
    cfg = _metadata(tmp_path, text)
    registry = _registry(
        [("sub-1", "healthy", "Prisma"), ("sub-2", "sci-neuropathic-pain", "Prisma")]
    )
    assert _metadata_site_advisory(cfg, ("sub-1", "sub-2"), registry) is None


@pytest.mark.parametrize("metadata_dir", ["absent", "", "relative", "${paths.x}"])
def test_metadata_site_advisory_leaves_an_unusable_location_to_the_run(
    tmp_path: Path, metadata_dir: str
) -> None:
    path = str(tmp_path / metadata_dir) if metadata_dir == "absent" else metadata_dir
    cfg = {"paths": {"metadataDir": path}}
    registry = _registry([("sub-1", "healthy", "Prisma")])
    assert _metadata_site_advisory(cfg, ("sub-1",), registry) is None


class _Adapter:
    def __init__(self, key: str) -> None:
        self.key = key

    def validate(self, _cfg: dict[str, Any], _env: dict[str, Any]) -> Validation:
        return Validation()

    def build_command(self, _cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        return [self.key, subject_id or "cohort"]

    def preview(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        return " ".join(self.build_command(cfg, subject_id))


_COHORT = [
    ("sub-001", "healthy", None),
    ("sub-002", "healthy", None),
    ("sub-003", "sci-neuropathic-pain", None),
    ("sub-004", "sci-neuropathic-pain", None),
    ("sub-005", "sci-no-neuropathic-pain", None),
    ("sub-006", "sci-no-neuropathic-pain", None),
]


def _plan(
    root: Path,
    monkeypatch: pytest.MonkeyPatch,
    step_key: str,
    rows: list[tuple[str, str, str | None]],
) -> dict[str, Any]:
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
            "metadataDir": str(root / "metadata"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "subjects": {"include": [], "exclude": []},
        "runtime": {"dryRun": True},
        "steps": {step_key: {"enabled": True, "params": {}}},
    }
    listed = list(_registry(rows).values())

    class _Store:
        def __init__(self, _root: str) -> None:
            pass

        def list(self, _cfg: dict[str, Any]) -> list[dict[str, Any]]:
            return listed

    monkeypatch.setattr(workflow, "RegistryStore", _Store)
    monkeypatch.setattr(
        workflow,
        "ADAPTERS",
        {"final": _Adapter("final"), step_key: _Adapter(step_key)},
    )
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
            "intent": {"kind": "stage", "stepKey": step_key, "target": {"mode": "all"}},
            "acknowledgements": {"includeDeferredAndUnreviewedQc": True},
        }
    )
    plan = planned.result["plan"]
    assert plan["nodes"][0]["status"] == "planned"
    assert _MEMORY_LINE in planned.warnings
    return plan


def test_plan_lists_the_brainpad_site_advisory_for_review(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plan = _plan(
        tmp_path,
        monkeypatch,
        "brainpad",
        [
            ("sub-001", "healthy", "Prisma"),
            ("sub-002", "sci-neuropathic-pain", "Prisma"),
            ("sub-003", "sci-neuropathic-pain", "Ingenia"),
        ],
    )
    # The constant memory note stays in the run record, not in plan review.
    assert plan["advisories"] == [
        "Brain-PAD statistics pool all sites; site Ingenia has no controls."
    ]


def test_plan_lists_the_metadata_site_advisory_while_final_r_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _metadata(
        tmp_path,
        "participant_id,Cohort,Site\n"
        + "".join(f"{subject_id},x,Prisma\n" for subject_id, _r, _s in _COHORT),
    )
    plan = _plan(tmp_path, monkeypatch, "final", _COHORT)
    assert plan["advisories"] == [
        "The metadata file gives sub-001, sub-002, and 4 more subjects a "
        "different site from the registry; R analysis uses the registry site."
    ]


def test_plan_without_advisories_lists_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _metadata(
        tmp_path,
        "participant_id,Cohort\n"
        + "".join(f"{subject_id},x\n" for subject_id, _r, _s in _COHORT),
    )
    plan = _plan(tmp_path, monkeypatch, "final", _COHORT)
    assert plan["advisories"] == []
