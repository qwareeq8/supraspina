"""Tests for boundary behavior of one-use authorization and project epoch identity."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.authorization import AuthorizationError, AuthorizationLedger
from supraspina_sidecar.project import ProjectEpochs, ProjectIdentityError


def _authorization(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "token": "opaque-token-0001",
        "projectId": "project-a",
        "configRevision": 7,
        "purpose": "workflow-start",
    }
    value.update(overrides)
    return value


def _consume(ledger: AuthorizationLedger, value: Any) -> None:
    ledger.consume(
        value,
        project_id="project-a",
        config_revision=7,
        purpose="workflow-start",
    )


@pytest.mark.parametrize(
    ("authorization", "message"),
    [
        (None, "Provide workflow-start authorization"),
        (
            _authorization(token="".join(("sho", "rt"))),
            "valid execution authorization token",
        ),
        (_authorization(token="x" * 4097), "valid execution authorization token"),
        (_authorization(projectId="project-b"), "authorization project"),
        (_authorization(configRevision=None), "valid execution authorization revision"),
        (
            _authorization(configRevision="not-an-int"),
            "valid execution authorization revision",
        ),
        (_authorization(configRevision=8), "authorization revision"),
        # A revision the ledger would have coerced to the bound one still
        # names a wrong type, so it is refused instead of accepted.
        (_authorization(configRevision="7"), "valid execution authorization revision"),
        (_authorization(configRevision=7.0), "valid execution authorization revision"),
        (_authorization(configRevision=7.9), "valid execution authorization revision"),
        (_authorization(configRevision=True), "valid execution authorization revision"),
        (_authorization(purpose="provision"), "authorization purpose"),
    ],
)
def test_authorization_envelope_rejects_every_mismatched_binding(
    authorization: Any, message: str
) -> None:
    with pytest.raises(AuthorizationError, match=message):
        _consume(AuthorizationLedger(), authorization)


def test_authorization_token_is_consumed_exactly_once() -> None:
    ledger = AuthorizationLedger()
    envelope = _authorization()

    _consume(ledger, envelope)
    with pytest.raises(AuthorizationError, match="authorization only once"):
        _consume(ledger, envelope)


def _identity(root: Path, **overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "projectId": "project-a",
        "root": str(root),
        "configPath": str(root / "supraspina.project.json"),
        "epoch": 1,
    }
    value.update(overrides)
    return value


@pytest.mark.parametrize(
    ("identity", "message"),
    [
        (None, "Provide a project reference"),
        ({"projectId": ""}, "Provide project.projectId"),
        ({"projectId": "x" * 257}, "Provide project.projectId"),
    ],
)
def test_project_identity_rejects_missing_or_oversized_reference(
    tmp_path: Path, identity: Any, message: str
) -> None:
    if isinstance(identity, dict):
        identity = {**_identity(tmp_path), **identity}
    with pytest.raises(ProjectIdentityError, match=message):
        ProjectEpochs().validate(identity)


@pytest.mark.parametrize("epoch", [None, "not-an-int"])
def test_project_identity_requires_integer_epoch(tmp_path: Path, epoch: Any) -> None:
    with pytest.raises(ProjectIdentityError, match="JSON-safe integer"):
        ProjectEpochs().validate(_identity(tmp_path, epoch=epoch))


def test_project_identity_requires_nonnegative_epoch(tmp_path: Path) -> None:
    with pytest.raises(ProjectIdentityError, match="non-negative"):
        ProjectEpochs().validate(_identity(tmp_path, epoch=-1))


def test_project_identity_accepts_no_config_path_and_rejects_invalid_cfg_paths(
    tmp_path: Path,
) -> None:
    projects = ProjectEpochs()
    identity = _identity(tmp_path, configPath="")

    attached = projects.validate(identity)

    assert attached.config_path == ""
    assert attached.root == str(tmp_path.resolve())
    with pytest.raises(ValueError, match=r"Provide a project root\."):
        ProjectEpochs().validate(identity, {"paths": "invalid"})


def test_same_project_cannot_change_root_without_newer_epoch(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    projects = ProjectEpochs()
    projects.validate(_identity(first, epoch=3))

    with pytest.raises(ProjectIdentityError, match="Advance the epoch"):
        projects.validate(_identity(second, epoch=3))


def test_same_project_rejects_older_epoch_before_identity_change_check(
    tmp_path: Path,
) -> None:
    projects = ProjectEpochs()
    projects.validate(_identity(tmp_path, epoch=3))

    with pytest.raises(ProjectIdentityError, match="stale project epoch"):
        projects.validate(_identity(tmp_path, epoch=2))


def test_detach_validates_shape_epoch_and_absent_state(tmp_path: Path) -> None:
    projects = ProjectEpochs()
    with pytest.raises(ProjectIdentityError, match="Provide a project reference"):
        projects.detach(None)
    with pytest.raises(ProjectIdentityError, match="JSON-safe integer"):
        projects.detach(_identity(tmp_path, epoch="invalid"))
    assert projects.detach(_identity(tmp_path)) is False


def test_attachment_callbacks_and_detach_all_publish_only_state_changes(
    tmp_path: Path,
) -> None:
    events: list[bool] = []
    projects = ProjectEpochs(events.append)

    projects.detach_all()
    projects.validate(_identity(tmp_path))
    projects.validate(_identity(tmp_path))
    assert projects.attached() == [
        {"projectId": "project-a", "epoch": 1, "root": str(tmp_path.resolve())}
    ]
    projects.detach_all()
    projects.detach_all()

    assert events == [True, False]


def test_exact_detach_notifies_and_tombstones_generation(tmp_path: Path) -> None:
    events: list[bool] = []
    projects = ProjectEpochs(events.append)
    identity = _identity(tmp_path, epoch=5)
    projects.validate(identity)

    assert projects.detach(identity) is True
    with pytest.raises(ProjectIdentityError, match="stale detached-project epoch"):
        projects.validate(identity)
    assert events == [True, False]
