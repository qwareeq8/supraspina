"""Tests for the JSON-RPC wiring of input-FOV review and managed resources."""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.__main__ import build_dispatcher
from supraspina_sidecar.rpc import Dispatcher, Emitter


@pytest.fixture
def dispatcher() -> Dispatcher:
    runtime = build_dispatcher(Emitter(io.StringIO()))
    try:
        yield runtime
    finally:
        runtime.managed_resource_manager.shutdown()
        runtime.provision_manager.shutdown()
        runtime.workflow_manager.shutdown()
        runtime.workflow_manager.project_epochs.detach_all()


def _project(root: Path) -> dict[str, Any]:
    return {
        "projectId": "rpc-scientific",
        "root": str(root.resolve()),
        "configPath": str((root / "supraspina.project.json").resolve()),
        "epoch": 1,
    }


def _request(root: Path) -> dict[str, Any]:
    return {
        "project": _project(root),
        "cfg": {
            "paths": {
                "projectRoot": str(root.resolve()),
                "derivativesDir": "${projectRoot}/derivatives",
            }
        },
        "configRevision": 3,
    }


def _call(
    dispatcher: Dispatcher,
    method: str,
    request: dict[str, Any],
) -> dict[str, Any]:
    response = dispatcher.handle(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": [request],
        }
    )
    assert response is not None
    return response


def test_dispatcher_registers_bounded_scientific_contract_methods(
    dispatcher: Dispatcher,
) -> None:
    assert {
        "inputFov.list",
        "inputFov.review",
        "managedResource.status",
        "managedResource.cancel",
        "managedResource.importOffline",
        "provision.synthstrip",
        "provision.fastsurfer",
    } <= dispatcher.methods


def test_input_fov_list_is_project_and_config_revision_bound(
    dispatcher: Dispatcher,
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()

    result = _call(dispatcher, "inputFov.list", _request(root))

    assert result["result"] == {"configRevision": 3, "items": []}
    malformed = _request(root)
    malformed["unexpected"] = True
    rejected = _call(dispatcher, "inputFov.list", malformed)
    assert rejected["error"]["code"] == -32603


def test_input_fov_review_rpc_preserves_optional_session_identity(
    dispatcher: Dispatcher,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    captured: list[dict[str, Any]] = []

    def review(request: dict[str, Any]) -> dict[str, Any]:
        captured.append(request)
        return {
            "decision": "approved",
            "revision": 1,
            "configRevision": 3,
            "reviewedAt": "2026-07-31T12:00:00.000Z",
            "decisionSignature": "d" * 64,
            "current": True,
        }

    monkeypatch.setattr(dispatcher.input_fov_review_manager, "review", review)
    request = _request(root)
    request.update(
        {
            "subjectId": "sub-0001",
            "sessionId": "ses-baseline",
            "acquisitionId": "acq-prisma",
            "preflightSignature": "a" * 64,
            "sourceSha256": "b" * 64,
            "outputSha256": "c" * 64,
            "expectedRevision": 0,
            "decision": "approved",
        }
    )

    result = _call(dispatcher, "inputFov.review", request)

    assert result["result"]["revision"] == 1
    assert captured == [request]

    historical_request = dict(request)
    del historical_request["sessionId"]
    _call(dispatcher, "inputFov.review", historical_request)
    assert "sessionId" not in captured[-1]


def test_provision_synthstrip_rejects_non_cpu_variant_before_side_effect(
    dispatcher: Dispatcher,
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    request = _request(root)
    request.update(
        {
            "resource": "synthstrip",
            "variant": "cuda",
            "userDataPath": str((tmp_path / "user-data").resolve()),
            "authorization": {
                "token": "rpc-scientific-authorization-token",
                "projectId": "rpc-scientific",
                "configRevision": 3,
                "purpose": "provision",
            },
        }
    )

    result = _call(dispatcher, "provision.synthstrip", request)

    assert result["error"]["code"] == -32603
    assert dispatcher.managed_resource_manager.active_count() == 0
