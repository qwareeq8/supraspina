"""Tests for project-identity epochs and late-result rejection."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.project import ProjectEpochs, ProjectIdentityError


def _identity(root: Path, project_id: str, epoch: int) -> dict[str, Any]:
    return {
        "projectId": project_id,
        "root": str(root.resolve()),
        "configPath": str((root / "supraspina.project.json").resolve()),
        "epoch": epoch,
    }


def _cfg(root: Path) -> dict[str, Any]:
    return {"paths": {"projectRoot": str(root.resolve())}}


def test_switch_a_to_b_rejects_late_a_request_and_detach(tmp_path: Path) -> None:
    root_a = tmp_path / "a"
    root_b = tmp_path / "b"
    root_a.mkdir()
    root_b.mkdir()
    projects = ProjectEpochs()
    a = _identity(root_a, "project-a", 1)
    b = _identity(root_b, "project-b", 1)
    projects.validate(a, _cfg(root_a))
    projects.validate(b, _cfg(root_b))

    with pytest.raises(ProjectIdentityError, match="stale detached-project epoch"):
        projects.validate(a, _cfg(root_a))
    with pytest.raises(ProjectIdentityError, match="match the project detach identity"):
        projects.detach(a)
    assert projects.attached() == [
        {"projectId": "project-b", "epoch": 1, "root": str(root_b.resolve())}
    ]


def test_newer_epoch_for_same_project_supersedes_old_generation(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    projects = ProjectEpochs()
    old = _identity(root, "project-a", 4)
    current = _identity(root, "project-a", 5)
    projects.validate(old, _cfg(root))
    projects.validate(current, _cfg(root))

    with pytest.raises(ProjectIdentityError, match="stale detached-project epoch"):
        projects.validate(old, _cfg(root))
    with pytest.raises(ProjectIdentityError, match="match the project detach identity"):
        projects.detach(old)
    assert projects.detach(current) is True
    assert projects.attached() == []

    resumed = _identity(root, "project-a", 6)
    assert projects.validate(resumed, _cfg(root)).epoch == 6


def test_switch_guard_preserves_active_identity_until_quiescent(tmp_path: Path) -> None:
    root_a = tmp_path / "a"
    root_b = tmp_path / "b"
    root_a.mkdir()
    root_b.mkdir()
    projects = ProjectEpochs()
    a = _identity(root_a, "project-a", 1)
    b = _identity(root_b, "project-b", 1)
    projects.validate(a, _cfg(root_a))
    allowed = False
    projects.set_switch_guard(lambda: allowed)

    with pytest.raises(ProjectIdentityError, match="active scientific work"):
        projects.validate(b, _cfg(root_b))
    assert projects.attached()[0]["projectId"] == "project-a"
    allowed = True
    assert projects.validate(b, _cfg(root_b)).project_id == "project-b"


def test_cfg_root_and_config_path_must_match_explicit_project(tmp_path: Path) -> None:
    root = tmp_path / "project"
    other = tmp_path / "other"
    root.mkdir()
    other.mkdir()
    projects = ProjectEpochs()

    with pytest.raises(ProjectIdentityError, match=r"Match project\.root"):
        projects.validate(_identity(root, "project-a", 1), _cfg(other))

    outside = _identity(root, "project-a", 1)
    outside["configPath"] = str(other / "supraspina.project.json")
    with pytest.raises(ProjectIdentityError, match=r"within project\.root"):
        projects.validate(outside, _cfg(root))


@pytest.mark.parametrize(
    "epoch",
    [
        True,
        False,
        1.0,
        1.5,
        "1",
        None,
        -1,
        2**53,
    ],
)
def test_project_epoch_requires_a_json_safe_non_boolean_integer(
    tmp_path: Path, epoch: object
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    raw = _identity(root, "project-a", 1)
    raw["epoch"] = epoch

    with pytest.raises(ProjectIdentityError, match="non-negative JSON-safe integer"):
        ProjectEpochs().validate(raw, _cfg(root))
