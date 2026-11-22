"""Tests for project-scoped RPC environment checks and provisioning."""

from __future__ import annotations

import io
import json
import re
import time
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import env
from supraspina_sidecar.__main__ import build_dispatcher
from supraspina_sidecar.adapters import pybrainage
from supraspina_sidecar.rpc import Dispatcher, Emitter


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


def _project(root: Path) -> dict[str, Any]:
    return {
        "projectId": "rpc-project",
        "root": str(root.resolve()),
        "configPath": str((root / "supraspina.project.json").resolve()),
        "epoch": 1,
    }


def _cfg(root: Path, marker: str = "current") -> dict[str, Any]:
    python = root / marker / "bin" / "python"
    model = root / marker / "ExtraTreesModel"
    scaler = root / marker / "scaler.pkl"
    return {
        "paths": {
            "projectRoot": str(root.resolve()),
            "outputDir": str(root / "outputs"),
        },
        "tools": {"pythonExecutable": str(root / "orchestration-python")},
        "pybrain": {"modelPath": str(model), "scalerPath": str(scaler)},
        "steps": {
            "pybrainage": {
                "enabled": True,
                "params": {
                    "pythonExecutable": str(python),
                    "modelPath": str(model),
                    "scalerPath": str(scaler),
                    "rowFallback": True,
                },
            }
        },
        "marker": marker,
    }


def _request(root: Path, cfg: dict[str, Any], revision: int = 3) -> dict[str, Any]:
    return {
        "project": _project(root),
        "cfg": cfg,
        "configRevision": revision,
    }


def _authorization(
    root: Path,
    purpose: str,
    revision: int = 3,
) -> dict[str, Any]:
    return {
        "token": f"rpc-{purpose}-authorization-token",
        "projectId": _project(root)["projectId"],
        "configRevision": revision,
        "purpose": purpose,
    }


def _call(
    dispatcher: Dispatcher,
    request_id: int,
    method: str,
    request: dict[str, Any],
) -> dict[str, Any]:
    response = dispatcher.handle(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": [request],
        }
    )
    assert response is not None
    return response


def _notifications(sink: io.StringIO) -> list[dict[str, Any]]:
    return [json.loads(line) for line in sink.getvalue().splitlines() if line.strip()]


#: Match the canonical identity the install manager mints.
_OPERATION_ID = re.compile(r"install-[0-9a-f]{12}")


def _settle(dispatcher: Dispatcher, timeout: float = 5.0) -> None:
    """Wait for every started installation to reach a terminal phase."""
    dispatcher.env_install_manager.shutdown(timeout=timeout)
    assert dispatcher.env_install_manager.active_count() == 0


def test_env_calls_use_their_explicit_cfg_without_ambient_cache(
    runtime: tuple[Dispatcher, io.StringIO],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatcher, _sink = runtime
    root = tmp_path / "project"
    root.mkdir()
    checked_cfg = _cfg(root, "checked")
    status_cfg = _cfg(root, "status")
    captured: dict[str, Any] = {}

    monkeypatch.setattr(
        env,
        "check",
        lambda cfg, ids=None: (
            captured.setdefault("check", (cfg, ids)) and {"groups": []}
        ),
    )

    def tool_status(cfg: dict[str, Any]) -> dict[str, Any]:
        captured["status"] = cfg
        return {"ok": True}

    monkeypatch.setattr(env, "tool_status", tool_status)
    check_request = _request(root, checked_cfg)
    check_request["ids"] = ["python"]
    assert _call(dispatcher, 1, "env.check", check_request)["result"] == {"groups": []}
    assert _call(
        dispatcher,
        2,
        "env.toolStatus",
        _request(root, status_cfg),
    )["result"] == {"ok": True}
    assert captured["check"] == (checked_cfg, ["python"])
    assert captured["status"] is status_cfg


def test_env_check_without_a_project_runs_host_scoped(
    runtime: tuple[Dispatcher, io.StringIO],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A request with no project runs the probes with an empty config."""
    dispatcher, _sink = runtime
    captured: dict[str, Any] = {}

    monkeypatch.setattr(
        env,
        "check",
        lambda cfg, ids=None: (
            captured.setdefault("check", (cfg, ids)) and {"groups": []}
        ),
    )

    assert _call(dispatcher, 1, "env.check", {})["result"] == {"groups": []}
    assert captured["check"] == ({}, None)


def test_env_check_with_a_project_still_validates_identity(
    runtime: tuple[Dispatcher, io.StringIO],
) -> None:
    dispatcher, _sink = runtime
    response = dispatcher.handle(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "env.check",
            "params": [{"project": {"projectId": ""}}],
        }
    )
    assert response is not None
    # The dispatcher publishes the authored validation sentence, which proves
    # the identity gate still runs whenever a project accompanies the request.
    assert response["error"]["message"] == "Provide project.projectId."
    assert response["error"]["data"] == {"code": "OPERATOR"}


def test_env_tool_status_rejects_missing_explicit_request(
    runtime: tuple[Dispatcher, io.StringIO],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatcher, _sink = runtime
    called = False

    def tool_status(_cfg: dict[str, Any]) -> dict[str, Any]:
        nonlocal called
        called = True
        return {}

    monkeypatch.setattr(env, "tool_status", tool_status)
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 3, "method": "env.toolStatus", "params": []}
    )
    assert response is not None
    assert response["error"]["code"] == -32603
    assert called is False


def test_opt_in_install_consumes_project_bound_authorization(
    runtime: tuple[Dispatcher, io.StringIO],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatcher, sink = runtime
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root)
    captured: dict[str, Any] = {}

    def install(
        check_id: str,
        received: dict[str, Any],
        *,
        on_output: Any = None,
    ) -> dict[str, Any]:
        captured.update({"checkId": check_id, "cfg": received})
        if on_output is not None:
            on_output("Collecting the requested package\n")
        return {"rc": 0, "stdout": "installed", "stderr": ""}

    monkeypatch.setattr(env, "opt_in_install", install)
    request = _request(root, cfg)
    request.update(
        {
            "checkId": "rpkgs",
            "authorization": _authorization(root, "opt-in-install"),
        }
    )
    started = _call(dispatcher, 4, "env.optInInstall", request)["result"]
    assert _OPERATION_ID.fullmatch(started["operationId"])
    _settle(dispatcher)
    assert captured == {"checkId": "rpkgs", "cfg": cfg}

    events = [
        message["params"]
        for message in _notifications(sink)
        if message.get("method") == "envInstall.progress"
    ]
    assert [event["phase"] for event in events] == ["queued", "running", "done"]
    assert events[-1]["operationId"] == started["operationId"]
    assert events[-1]["checkId"] == "rpkgs"
    assert events[-1]["rc"] == 0
    assert events[-1]["stdout"] == "installed"
    assert events[-1]["output"] == "Collecting the requested package\n"

    replay = _call(dispatcher, 5, "env.optInInstall", request)
    assert replay["error"]["code"] == -32603


def test_install_status_returns_only_the_requested_project_generation(
    runtime: tuple[Dispatcher, io.StringIO],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A remounting renderer reattaches through this query, so it must answer
    # for the exact attached generation and never for a superseded one.
    dispatcher, _sink = runtime
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root)
    monkeypatch.setattr(
        env,
        "opt_in_install",
        lambda *_args, **_kwargs: {"rc": 1, "stdout": "", "stderr": "refused"},
    )
    request = _request(root, cfg)
    request.update(
        {
            "checkId": "rpkgs",
            "authorization": _authorization(root, "opt-in-install"),
        }
    )
    _call(dispatcher, 6, "env.optInInstall", request)
    _settle(dispatcher)

    current = _call(dispatcher, 7, "env.installStatus", {"project": _project(root)})
    operations = current["result"]["operations"]
    assert [operation["checkId"] for operation in operations] == ["rpkgs"]
    assert operations[0]["phase"] == "error"
    assert operations[0]["rc"] == 1
    assert operations[0]["stderr"] == "refused"

    later = dict(_project(root), epoch=2)
    assert _call(dispatcher, 8, "env.installStatus", {"project": later})["result"] == {
        "operations": []
    }


def test_create_output_dir_consumes_project_bound_authorization(
    runtime: tuple[Dispatcher, io.StringIO],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatcher, _sink = runtime
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root)
    captured: dict[str, Any] = {}

    def create(check_id: str, received: dict[str, Any]) -> dict[str, Any]:
        captured.update({"checkId": check_id, "cfg": received})
        return {"ok": True, "detail": "Created the output directory."}

    monkeypatch.setattr(env, "create_output_dir", create)
    request = _request(root, cfg)
    request.update(
        {
            "checkId": "subjdir",
            "authorization": _authorization(root, "opt-in-install"),
        }
    )
    assert _call(dispatcher, 6, "env.createOutputDir", request)["result"] == {
        "ok": True,
        "detail": "Created the output directory.",
    }
    assert captured == {"checkId": "subjdir", "cfg": cfg}

    replay = _call(dispatcher, 7, "env.createOutputDir", request)
    assert replay["error"]["code"] == -32603


def test_create_output_dir_rejects_a_wrong_purpose_authorization(
    runtime: tuple[Dispatcher, io.StringIO],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatcher, _sink = runtime
    root = tmp_path / "project"
    root.mkdir()
    called = False

    def create(_check_id: str, _cfg: dict[str, Any]) -> dict[str, Any]:
        nonlocal called
        called = True
        return {"ok": True, "detail": "unreachable"}

    monkeypatch.setattr(env, "create_output_dir", create)
    request = _request(root, _cfg(root))
    request.update(
        {
            "checkId": "subjdir",
            "authorization": _authorization(root, "provision"),
        }
    )
    response = _call(dispatcher, 8, "env.createOutputDir", request)
    assert response["error"]["code"] == -32603
    assert called is False


def test_provision_status_rejects_unprovenanced_configured_paths(
    runtime: tuple[Dispatcher, io.StringIO],
    tmp_path: Path,
) -> None:
    dispatcher, _sink = runtime
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root)
    params = cfg["steps"]["pybrainage"]["params"]
    paths = [
        Path(params[name]) for name in ("pythonExecutable", "modelPath", "scalerPath")
    ]
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"ready")
    paths[0].chmod(0o755)

    ready = _call(dispatcher, 6, "provision.status", _request(root, cfg))["result"]
    assert ready["envReady"] is False
    assert ready["modelReady"] is False
    assert ready["pythonExecutable"] is None
    assert ready["modelPath"] is None
    assert ready["scalerPath"] is None
    assert ready["configRevision"] == 3

    paths[2].unlink()
    gated = _call(dispatcher, 7, "provision.status", _request(root, cfg))["result"]
    assert gated["envReady"] is False
    assert gated["modelReady"] is False
    assert gated["scalerPath"] is None


def _wait_for_phase(
    dispatcher: Dispatcher,
    root: Path,
    cfg: dict[str, Any],
    expected: str,
) -> dict[str, Any]:
    # The worker thread fsyncs each state change, and hosted-runner disks can
    # stall fsync for seconds, so bound only a hang and name the last phase.
    deadline = time.monotonic() + 30
    phase = None
    while time.monotonic() < deadline:
        status = _call(
            dispatcher,
            99,
            "provision.status",
            _request(root, cfg),
        )["result"]
        phase = status["phase"]
        if phase == expected:
            return status
        time.sleep(0.01)
    raise AssertionError(f"Reach provisioning phase {expected}, not {phase}.")


def test_provision_start_is_nonblocking_and_persists_done_state(
    runtime: tuple[Dispatcher, io.StringIO],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatcher, sink = runtime
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root)

    def execute(
        _cfg: dict[str, Any],
        progress: Any,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        progress("creating environment", 0.1)
        progress("verifying model", 0.8)
        return {"ok": True, "message": ""}

    monkeypatch.setattr(pybrainage, "execute_provision", execute)
    request = _request(root, cfg)
    request["authorization"] = _authorization(root, "provision")
    result = _call(dispatcher, 8, "provision.pybrainage", request)["result"]
    assert result["operationId"].startswith("provision-")
    status = _wait_for_phase(dispatcher, root, cfg, "done")
    assert status["operationId"] == result["operationId"]
    assert (root / ".supraspina" / "provision.json").is_file()
    progress = [
        item for item in _notifications(sink) if item["method"] == "provision.progress"
    ]
    deadline = time.monotonic() + 30
    while progress[-1]["params"]["phase"] != "done" and time.monotonic() < deadline:
        time.sleep(0.01)
        progress = [
            item
            for item in _notifications(sink)
            if item["method"] == "provision.progress"
        ]
    assert progress[-1]["params"]["phase"] == "done"


def test_provision_exception_is_redacted_to_a_stable_error(
    runtime: tuple[Dispatcher, io.StringIO],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dispatcher, sink = runtime
    root = tmp_path / "project"
    root.mkdir()
    cfg = _cfg(root)

    def execute(_cfg: dict[str, Any], _progress: Any, **_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError(f"Expose a secret failure at {root}/rawdata/sub-SENTINEL.")

    monkeypatch.setattr(pybrainage, "execute_provision", execute)
    request = _request(root, cfg)
    request["authorization"] = _authorization(root, "provision")
    result = _call(dispatcher, 9, "provision.pybrainage", request)["result"]
    status = _wait_for_phase(dispatcher, root, cfg, "error")
    assert status["operationId"] == result["operationId"]
    assert status["error"] == "RuntimeError: provisioning failed"
    payload = sink.getvalue()
    assert str(root) not in payload
    assert "sub-SENTINEL" not in payload
