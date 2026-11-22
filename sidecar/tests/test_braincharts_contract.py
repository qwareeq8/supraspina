"""Tests for the ``provision.braincharts`` RPC and its ProvisionManager kind.

The request shape is frozen; the executor is faked here, and
``test_braincharts_runtime.py`` covers what it does.
"""

from __future__ import annotations

import io
import json
import time
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import braincharts_runtime, env
from supraspina_sidecar.__main__ import build_dispatcher
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.env import braincharts as braincharts_env
from supraspina_sidecar.env.base import PROBES
from supraspina_sidecar.provenance import bound_tool_evidence
from supraspina_sidecar.rpc import Dispatcher, Emitter
from supraspina_sidecar.workflow_manager import WorkflowManager


@pytest.fixture
def runtime() -> Any:
    sink = io.StringIO()
    dispatcher = build_dispatcher(Emitter(sink))
    try:
        yield dispatcher, sink
    finally:
        dispatcher.provision_manager.shutdown()
        dispatcher.env_install_manager.shutdown()
        dispatcher.workflow_manager.shutdown()
        dispatcher.workflow_manager.project_epochs.detach_all()


def _request(root: Path, **extra: Any) -> dict[str, Any]:
    return {
        "project": {
            "projectId": "braincharts-project",
            "root": str(root.resolve()),
            "configPath": str((root / "supraspina.project.json").resolve()),
            "epoch": 1,
        },
        "cfg": {
            "paths": {
                "projectRoot": str(root.resolve()),
                "outputDir": str(root / "outputs"),
            }
        },
        "configRevision": 2,
        "authorization": {
            "token": "rpc-braincharts-provision-authorization-token",
            "projectId": "braincharts-project",
            "configRevision": 2,
            "purpose": "provision",
        },
        **extra,
    }


def _call(dispatcher: Dispatcher, method: str, request: dict[str, Any]) -> Any:
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": [request]}
    )
    assert response is not None
    return response


def _notifications(sink: io.StringIO, method: str) -> list[dict[str, Any]]:
    return [
        item["params"]
        for item in (json.loads(line) for line in sink.getvalue().splitlines())
        if item.get("method") == method
    ]


def _wait_for_terminal(sink: io.StringIO) -> dict[str, Any]:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        progress = _notifications(sink, "provision.progress")
        if progress and progress[-1]["phase"] in {"done", "error"}:
            return progress[-1]
        time.sleep(0.01)
    raise AssertionError("BrainCharts provisioning did not finish.")


@pytest.mark.parametrize("accepted", [None, False, "true"])
def test_a_request_without_the_license_acceptance_is_refused_before_the_grant(
    runtime: tuple[Dispatcher, io.StringIO], tmp_path: Path, accepted: Any
) -> None:
    dispatcher, _sink = runtime
    extra = {} if accepted is None else {"licenseAccepted": accepted}

    response = _call(dispatcher, "provision.braincharts", _request(tmp_path, **extra))

    assert "Accept the BrainCharts license notice" in response["error"]["message"]
    # The one-use grant was not consumed, so an accepted request can still use it.
    assert not (tmp_path / ".supraspina" / "provision.json").exists()


def test_another_platform_is_refused_before_the_grant(
    runtime: tuple[Dispatcher, io.StringIO],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatcher, _sink = runtime
    monkeypatch.setattr(braincharts_runtime, "platform_supported", lambda: False)

    response = _call(
        dispatcher, "provision.braincharts", _request(tmp_path, licenseAccepted=True)
    )

    assert response["error"]["message"] == (
        "The BrainCharts runtime is available on Linux x86_64 only."
    )


def test_an_accepted_request_runs_the_braincharts_executor(
    runtime: tuple[Dispatcher, io.StringIO],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatcher, sink = runtime
    monkeypatch.setattr(braincharts_runtime, "platform_supported", lambda: True)
    seen: dict[str, Any] = {}

    def execute(cfg: dict[str, Any], progress: Any, **options: Any) -> dict[str, Any]:
        seen.update(cfg=cfg, options=options)
        progress("Downloading the BrainCharts model from GitHub...", 0.4)
        return {"ok": True, "message": ""}

    monkeypatch.setattr(braincharts_runtime, "execute_provision", execute)

    response = _call(
        dispatcher, "provision.braincharts", _request(tmp_path, licenseAccepted=True)
    )

    operation_id = response["result"]["operationId"]
    assert operation_id.startswith("provision-")
    terminal = _wait_for_terminal(sink)
    assert terminal == {
        "phase": "done",
        "percent": 100,
        "message": "BrainCharts setup is complete.",
        "projectId": "braincharts-project",
        "projectEpoch": 1,
        "operationId": operation_id,
    }
    assert callable(seen["options"]["runner"])
    assert callable(seen["options"]["cancelled"])
    record = json.loads((tmp_path / ".supraspina" / "provision.json").read_text())
    assert record["kind"] == "braincharts"
    log = tmp_path / "outputs" / ".braincharts" / "logs" / f"{operation_id}.log"
    assert "Downloading the BrainCharts model" in log.read_text()
    # The same grant cannot start a second operation.
    again = _call(
        dispatcher, "provision.braincharts", _request(tmp_path, licenseAccepted=True)
    )
    assert "error" in again


def test_a_failed_setup_publishes_its_stated_failure(
    runtime: tuple[Dispatcher, io.StringIO],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatcher, sink = runtime
    monkeypatch.setattr(braincharts_runtime, "platform_supported", lambda: True)
    message = "Checking the model size and SHA-256 failed: the file differs."
    monkeypatch.setattr(
        braincharts_runtime,
        "execute_provision",
        lambda _cfg, _progress, **_options: {"ok": False, "message": message},
    )

    _call(dispatcher, "provision.braincharts", _request(tmp_path, licenseAccepted=True))

    assert _wait_for_terminal(sink)["message"] == message


def test_cancel_stops_a_running_braincharts_setup(
    runtime: tuple[Dispatcher, io.StringIO],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatcher, sink = runtime
    monkeypatch.setattr(braincharts_runtime, "platform_supported", lambda: True)

    def execute(_cfg: dict[str, Any], progress: Any, **options: Any) -> dict[str, Any]:
        progress("Installing the locked pcntoolkit runtime (about 2 GB)...", 0.2)
        deadline = time.monotonic() + 5
        while not options["cancelled"]() and time.monotonic() < deadline:
            time.sleep(0.01)
        return {"ok": False, "message": "cancelled"}

    monkeypatch.setattr(braincharts_runtime, "execute_provision", execute)
    request = _request(tmp_path, licenseAccepted=True)
    operation_id = _call(dispatcher, "provision.braincharts", request)["result"][
        "operationId"
    ]

    cancel = _call(
        dispatcher,
        "provision.cancel",
        {"project": request["project"], "operationId": operation_id},
    )["result"]

    assert cancel["accepted"] is True
    assert _wait_for_terminal(sink)["message"] == "BrainCharts setup was canceled."


def test_the_braincharts_checks_leave_existing_receipt_evidence_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Adding bcenv and bcmodel changes only the plan-level environment digest.

    A receipt binds ``bound_tool_evidence`` over its own step's required
    checks, so every existing step binds the same evidence with or without
    the BrainCharts probe; the plan-level digest (never a receipt input)
    differs.
    """
    cfg = {
        "paths": {"projectRoot": str(tmp_path), "outputDir": str(tmp_path / "out")},
        "tools": {},
    }
    with_probe = env.check(cfg)
    without = list(PROBES)
    monkeypatch.setattr(
        env,
        "PROBES",
        [
            probe
            for probe in without
            if probe.name != braincharts_env.BrainChartsProbe.name
        ],
    )
    without_probe = env.check(cfg)
    summary_with = WorkflowManager._environment_summary(with_probe)
    summary_without = WorkflowManager._environment_summary(without_probe)
    assert set(summary_with) - set(summary_without) == {"bcenv", "bcmodel"}
    for adapter in ADAPTERS.values():
        ids = adapter.required_check_ids(cfg)
        if adapter.key == "braincharts":
            # Only the BrainCharts stage, appended after final, binds them.
            assert set(ids) == {"bcenv", "bcmodel"}
            continue
        assert "bcenv" not in ids
        assert "bcmodel" not in ids
        assert bound_tool_evidence(summary_with, ids) == bound_tool_evidence(
            summary_without, ids
        ), adapter.key
