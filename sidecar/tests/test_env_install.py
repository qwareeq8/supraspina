"""Tests for streamed installer execution and the install operation ledger."""

from __future__ import annotations

import io
import json
import sys
import threading
import time
from typing import Any

import pytest

from supraspina_sidecar import env, env_install
from supraspina_sidecar.adapters import tools
from supraspina_sidecar.env_install import EnvInstallManager
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.rpc import Emitter

PROJECT = ProjectIdentity(
    project_id="install-project",
    root="/projects/install",
    config_path="/projects/install/supraspina.project.json",
    epoch=1,
)


def _manager() -> tuple[EnvInstallManager, io.StringIO]:
    sink = io.StringIO()
    return EnvInstallManager(Emitter(sink)), sink


def _events(sink: io.StringIO) -> list[dict[str, Any]]:
    return [
        json.loads(line)["params"]
        for line in sink.getvalue().splitlines()
        if line.strip()
    ]


def _settle(manager: EnvInstallManager, timeout: float = 5.0) -> None:
    manager.shutdown(timeout=timeout)
    assert manager.active_count() == 0


def test_run_streamed_publishes_each_line_before_the_command_exits() -> None:
    published: list[str] = []
    first_line = threading.Event()
    release = threading.Event()

    def _publish(line: str) -> None:
        published.append(line)
        first_line.set()
        # Prove the publisher runs while the command is still alive by holding
        # the reader until the test releases it.
        release.wait(5.0)

    program = (
        "import sys, time\n"
        "print('working', flush=True)\n"
        "time.sleep(0.2)\n"
        "sys.stderr.write('warned\\n')\n"
    )
    started = threading.Event()
    result: dict[str, tools.RunResult] = {}

    def _run() -> None:
        started.set()
        result["value"] = tools.run_streamed(
            [sys.executable, "-c", program],
            timeout=30,
            on_output=_publish,
        )

    worker = threading.Thread(target=_run, daemon=True)
    worker.start()
    started.wait(5.0)
    assert first_line.wait(10.0)
    release.set()
    worker.join(20.0)

    assert result["value"].rc == 0
    assert result["value"].stdout == "working\n"
    assert result["value"].stderr == "warned\n"
    assert published == ["working\n", "warned\n"]


def test_run_streamed_matches_run_on_a_missing_program() -> None:
    result = tools.run_streamed(["/nonexistent/installer", "--version"])
    assert (result.rc, result.stdout) == (127, "")
    assert result.stderr == "not found: /nonexistent/installer"


def test_run_streamed_reports_a_timeout_after_killing_the_command() -> None:
    result = tools.run_streamed(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        timeout=0.2,
    )
    assert (result.rc, result.stdout) == (124, "")
    assert result.stderr == "timeout after 0.2s"


def test_start_returns_an_identity_and_reports_running_then_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, sink = _manager()

    def _install(
        check_id: str,
        cfg: dict[str, Any],
        *,
        on_output: Any = None,
    ) -> dict[str, Any]:
        assert (check_id, cfg) == ("rpkgs", {"marker": "saved"})
        on_output("Collecting dplyr\n")
        return {"rc": 0, "stdout": "done", "stderr": ""}

    monkeypatch.setattr(env, "opt_in_install", _install)
    started = manager.start(PROJECT, "rpkgs", {"marker": "saved"})
    _settle(manager)

    assert started["operationId"].startswith("install-")
    events = _events(sink)
    assert [event["phase"] for event in events] == ["queued", "running", "done"]
    for event in events:
        assert event["operationId"] == started["operationId"]
        assert event["checkId"] == "rpkgs"
        assert event["projectId"] == PROJECT.project_id
        assert event["projectEpoch"] == PROJECT.epoch
        assert event["startedAt"] > 0
        assert event["updatedAt"] >= event["startedAt"]
    assert events[0]["rc"] is None
    assert events[-1] == {
        **events[-1],
        "rc": 0,
        "stdout": "done",
        "stderr": "",
        "output": "Collecting dplyr\n",
    }


def test_a_failed_installation_carries_its_code_and_bounded_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, sink = _manager()
    monkeypatch.setattr(
        env,
        "opt_in_install",
        lambda *_args, **_kwargs: {
            "rc": 126,
            "stdout": "",
            "stderr": "x" * (env_install._MAX_OUTPUT_CHARS + 64),
        },
    )
    manager.start(PROJECT, "rpkgs", {})
    _settle(manager)

    terminal = _events(sink)[-1]
    assert terminal["phase"] == "error"
    assert terminal["rc"] == 126
    assert len(terminal["stderr"]) == env_install._MAX_OUTPUT_CHARS
    assert terminal["stderr"] == "x" * env_install._MAX_OUTPUT_CHARS


def test_a_raised_installation_settles_as_an_inspectable_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("/projects/install/secret")

    manager, sink = _manager()
    monkeypatch.setattr(env, "opt_in_install", _boom)
    manager.start(PROJECT, "rpkgs", {})
    _settle(manager)

    terminal = _events(sink)[-1]
    assert terminal["phase"] == "error"
    assert terminal["rc"] == -1
    assert terminal["stderr"] == "RuntimeError: the installation failed"


def test_the_running_output_tail_stays_bounded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _install(
        _check_id: str,
        _cfg: dict[str, Any],
        *,
        on_output: Any = None,
    ) -> dict[str, Any]:
        for index in range(2_000):
            on_output(f"line {index}\n")
        return {"rc": 0, "stdout": "", "stderr": ""}

    manager, sink = _manager()
    monkeypatch.setattr(env, "opt_in_install", _install)
    manager.start(PROJECT, "rpkgs", {})
    _settle(manager)

    terminal = _events(sink)[-1]
    assert len(terminal["output"]) <= env_install._MAX_TAIL_CHARS
    assert terminal["output"].endswith("line 1999\n")
    # Debounce the running stream: a chatty installer cannot emit per line.
    assert len(_events(sink)) < 2_000


def test_a_second_start_is_refused_while_one_installation_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = threading.Event()

    def _install(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        release.wait(5.0)
        return {"rc": 0, "stdout": "", "stderr": ""}

    manager, _sink = _manager()
    monkeypatch.setattr(env, "opt_in_install", _install)
    first = manager.start(PROJECT, "rpkgs", {})
    deadline = time.monotonic() + 5.0
    while manager.active_count() == 0 and time.monotonic() < deadline:
        time.sleep(0.01)

    with pytest.raises(ValueError, match="Wait for the active installation"):
        manager.start(PROJECT, "rmarkdown", {})

    release.set()
    _settle(manager)
    # The settled operation frees the project for the next installation.
    second = manager.start(PROJECT, "rmarkdown", {})
    _settle(manager)
    assert second["operationId"] != first["operationId"]


def test_status_reports_a_running_installation_for_reattachment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = threading.Event()

    def _install(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        release.wait(5.0)
        return {"rc": 0, "stdout": "", "stderr": ""}

    manager, _sink = _manager()
    monkeypatch.setattr(env, "opt_in_install", _install)
    started = manager.start(PROJECT, "rpkgs", {})
    deadline = time.monotonic() + 5.0
    while manager.active_count() == 0 and time.monotonic() < deadline:
        time.sleep(0.01)

    running = manager.status(PROJECT)["operations"]
    assert [operation["operationId"] for operation in running] == [
        started["operationId"]
    ]
    assert running[0]["phase"] in {"queued", "running"}
    assert running[0]["rc"] is None

    release.set()
    _settle(manager)
    assert manager.status(PROJECT)["operations"][0]["phase"] == "done"


def test_shutdown_returns_within_its_deadline_without_stopping_the_installer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A package manager stopped midway is not known safe, so shutdown waits
    # for its deadline and then leaves the daemon worker alone.
    release = threading.Event()

    def _install(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        release.wait(10.0)
        return {"rc": 0, "stdout": "", "stderr": ""}

    manager, _sink = _manager()
    monkeypatch.setattr(env, "opt_in_install", _install)
    manager.start(PROJECT, "rpkgs", {})
    started = time.monotonic()
    manager.shutdown(timeout=0.2)
    elapsed = time.monotonic() - started

    assert elapsed < 3.0
    assert manager.active_count() == 1
    release.set()
    _settle(manager)


@pytest.mark.parametrize("check_id", ["", "9bad", "with space", "x" * 129])
def test_start_refuses_a_check_id_outside_the_probe_shape(check_id: str) -> None:
    manager, _sink = _manager()
    with pytest.raises(ValueError, match="valid check ID"):
        manager.start(PROJECT, check_id, {})


def test_a_broken_notification_stream_never_stops_an_installation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _BrokenEmitter:
        def emit(self, _method: str, _payload: dict[str, Any]) -> None:
            raise OSError("Reopen the closed notification stream.")

    manager = EnvInstallManager(_BrokenEmitter())
    monkeypatch.setattr(
        env,
        "opt_in_install",
        lambda *_args, **_kwargs: {"rc": 0, "stdout": "ok", "stderr": ""},
    )
    manager.start(PROJECT, "rpkgs", {})
    _settle(manager)

    assert manager.status(PROJECT)["operations"][0]["phase"] == "done"
