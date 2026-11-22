"""Tests for the JSON-RPC dispatcher and stdio loop."""

from __future__ import annotations

import io
import json
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from supraspina_sidecar.__main__ import build_dispatcher
from supraspina_sidecar.adapters import tools
from supraspina_sidecar.authorization import PlanStaleError
from supraspina_sidecar.input_fov_review import InputFovReviewError
from supraspina_sidecar.operator_errors import OperatorError
from supraspina_sidecar.project import ProjectIdentityError
from supraspina_sidecar.rpc import MAX_REQUEST_BYTES, Dispatcher, Emitter, serve
from tests.test_schema import default_config


def make_dispatcher() -> Dispatcher:
    return build_dispatcher(Emitter(io.StringIO()))


def test_ping_returns_pong() -> None:
    dispatcher = make_dispatcher()
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 1, "method": "ping", "params": []}
    )
    assert response == {"jsonrpc": "2.0", "id": 1, "result": "pong"}


def test_unknown_method_returns_error() -> None:
    dispatcher = make_dispatcher()
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 2, "method": "nope", "params": []}
    )
    assert response is not None
    assert response["error"]["code"] == -32601


def test_plan_stale_error_exposes_only_allowlisted_recovery_data() -> None:
    dispatcher = make_dispatcher()

    def stale(_params: list[object], _emitter: Emitter) -> None:
        raise PlanStaleError

    dispatcher.register("test.stale", stale)
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 20, "method": "test.stale", "params": []}
    )

    assert response == {
        "jsonrpc": "2.0",
        "id": 20,
        "error": {
            "code": -32603,
            "message": "PlanStaleError: operation failed",
            "data": {
                "code": "PLAN_STALE",
                "action": {"id": "reviewAgain", "label": "Review again"},
            },
        },
    }


def test_operator_error_publishes_its_authored_message() -> None:
    dispatcher = make_dispatcher()

    def refuse(_params: list[object], _emitter: Emitter) -> None:
        raise OperatorError(
            "Resume the run because Clean and retry will not delete a "
            "Reconstruction tree that the detector reports as complete."
        )

    dispatcher.register("test.refuse", refuse)
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 22, "method": "test.refuse", "params": []}
    )

    assert response is not None
    assert response["error"] == {
        "code": -32603,
        "message": (
            "Resume the run because Clean and retry will not delete a "
            "Reconstruction tree that the detector reports as complete."
        ),
        "data": {"code": "OPERATOR"},
    }


def test_operator_error_is_still_redacted_before_publication() -> None:
    dispatcher = make_dispatcher()

    def refuse(_params: list[object], _emitter: Emitter) -> None:
        raise OperatorError("Review cleanup refusal for /home/someone/projects/study.")

    dispatcher.register("test.refuse-path", refuse)
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 23, "method": "test.refuse-path", "params": []}
    )

    assert response is not None
    assert response["error"]["message"] == "Review cleanup refusal for [PATH]."


def test_value_error_publishes_its_authored_validation_sentence() -> None:
    dispatcher = make_dispatcher()

    def refuse(_params: list[object], _emitter: Emitter) -> None:
        raise ValueError(
            "Provision the verified SynthStrip 1.8 resource in Diagnostics."
        )

    dispatcher.register("test.invalid", refuse)
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 24, "method": "test.invalid", "params": []}
    )

    assert response is not None
    assert response["error"] == {
        "code": -32603,
        "message": "Provision the verified SynthStrip 1.8 resource in Diagnostics.",
        "data": {"code": "OPERATOR"},
    }


def test_project_identity_error_publishes_its_authored_sentence() -> None:
    dispatcher = make_dispatcher()

    def refuse(_params: list[object], _emitter: Emitter) -> None:
        raise ProjectIdentityError("Reopen the project because its epoch advanced.")

    dispatcher.register("test.identity", refuse)
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 25, "method": "test.identity", "params": []}
    )

    assert response is not None
    assert response["error"] == {
        "code": -32603,
        "message": "Reopen the project because its epoch advanced.",
        "data": {"code": "OPERATOR"},
    }


def test_input_fov_review_error_publishes_its_authored_sentence() -> None:
    dispatcher = make_dispatcher()

    def refuse(_params: list[object], _emitter: Emitter) -> None:
        raise InputFovReviewError("Keep the brain-FOV artifact size within its bound.")

    dispatcher.register("test.fov", refuse)
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 26, "method": "test.fov", "params": []}
    )

    assert response is not None
    assert response["error"] == {
        "code": -32603,
        "message": "Keep the brain-FOV artifact size within its bound.",
        "data": {"code": "OPERATOR"},
    }


def test_value_error_message_is_redacted_before_publication() -> None:
    """Redact host state that a validation sentence interpolated."""
    dispatcher = make_dispatcher()

    def refuse(_params: list[object], _emitter: Emitter) -> None:
        raise ValueError("Create the missing /home/someone/projects/study directory.")

    dispatcher.register("test.invalid-path", refuse)
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 27, "method": "test.invalid-path", "params": []}
    )

    assert response is not None
    assert response["error"]["message"] == "Create the missing [PATH] directory."


def test_value_error_without_a_message_falls_back_to_its_class() -> None:
    dispatcher = make_dispatcher()

    def refuse(_params: list[object], _emitter: Emitter) -> None:
        raise ValueError

    dispatcher.register("test.invalid-empty", refuse)
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 28, "method": "test.invalid-empty", "params": []}
    )

    assert response is not None
    assert response["error"] == {
        "code": -32603,
        "message": "ValueError: operation failed",
        "data": {"code": "OPERATOR"},
    }


def test_unknown_rpc_error_has_no_structured_data() -> None:
    dispatcher = make_dispatcher()

    def fail(_params: list[object], _emitter: Emitter) -> None:
        raise RuntimeError("token=private")

    dispatcher.register("test.fail", fail)
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 21, "method": "test.fail", "params": []}
    )

    assert response is not None
    assert response["error"] == {
        "code": -32603,
        "message": "RuntimeError: operation failed",
    }


def test_list_steps_returns_all_fourteen_stages_with_stable_ids() -> None:
    dispatcher = make_dispatcher()
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 3, "method": "pipeline.listSteps"}
    )
    assert response is not None
    assert len(response["result"]) == 14
    assert response["result"][:3] == [
        {
            "id": -1,
            "key": "brainfov",
            "name": "Brain FOV preparation",
            "goal": (
                "Prepares high-FOV T1w inputs with a geometry-checked, mask-guided "
                "crop and explicit review."
            ),
            "scope": "subject",
            "dependencies": [],
        },
        {
            "id": 0,
            "key": "deface",
            "name": "Optional defacing",
            "goal": (
                "Optionally runs the selected defacing tool before structural "
                "processing."
            ),
            "scope": "subject",
            "dependencies": [],
        },
        {
            "id": 1,
            "key": "recon",
            "name": "Reconstruction",
            "goal": (
                "Runs cortical reconstruction and compatible parcellation for every "
                "subject."
            ),
            "scope": "subject",
            "dependencies": [],
        },
    ]
    # Appended after final so no node index moves; the ids list BrainCharts by
    # PyBrainAge and the z-score comparisons by R analysis.
    assert [step["key"] for step in response["result"][-3:]] == [
        "final",
        "braincharts",
        "zstats",
    ]
    assert response["result"][-2]["id"] == 5.5
    assert response["result"][-2]["dependencies"] == ["features"]
    assert response["result"][-1]["id"] == 9.5
    assert response["result"][-1]["dependencies"] == ["braincharts"]


_REPO_ROOT = Path(__file__).resolve().parents[2]


def test_list_steps_describes_each_stage_as_the_renderer_does() -> None:
    # pipeline.listSteps serves the Pipeline card descriptions, stated as
    # facts ("Runs ...", "Optionally runs ...") rather than orders ("Run ...").
    steps_ts = (_REPO_ROOT / "src" / "shared" / "steps.ts").read_text(encoding="utf-8")
    renderer_goals = dict(
        re.findall(
            r"\n    key: '([^']+)',\n    name: '[^']+',\n    goal: '([^']+)',",
            steps_ts,
        )
    )
    assert len(renderer_goals) == 14, "Declare a goal for every stage in steps.ts."
    response = make_dispatcher().handle(
        {"jsonrpc": "2.0", "id": 4, "method": "pipeline.listSteps"}
    )
    assert response is not None
    goals = {step["key"]: step["goal"] for step in response["result"]}
    assert goals == renderer_goals
    for key, goal in goals.items():
        assert re.match(r"(?:Optionally [a-z]|[A-Z])[a-z]*[a-rt-z]s ", goal), key


def test_notification_has_no_response() -> None:
    dispatcher = make_dispatcher()
    response = dispatcher.handle({"jsonrpc": "2.0", "method": "ping", "params": []})
    assert response is None


def test_serve_round_trip() -> None:
    dispatcher = make_dispatcher()
    stdin = io.StringIO(
        json.dumps({"jsonrpc": "2.0", "id": 7, "method": "ping", "params": []}) + "\n",
    )
    stdout = io.StringIO()
    serve(dispatcher, stdin=stdin, stdout=stdout)
    line = stdout.getvalue().strip()
    assert json.loads(line) == {"jsonrpc": "2.0", "id": 7, "result": "pong"}


@pytest.mark.parametrize("request_payload", [None, [], 1, "ping"])
def test_serve_rejects_non_object_json_and_continues(request_payload: object) -> None:
    dispatcher = make_dispatcher()
    valid = {"jsonrpc": "2.0", "id": 8, "method": "ping", "params": []}
    stdin = io.StringIO(f"{json.dumps(request_payload)}\n{json.dumps(valid)}\n")
    stdout = io.StringIO()

    serve(dispatcher, stdin=stdin, stdout=stdout)

    messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert messages[0] == {
        "jsonrpc": "2.0",
        "id": None,
        "error": {"code": -32600, "message": "invalid JSON-RPC request"},
    }
    assert messages[1] == {"jsonrpc": "2.0", "id": 8, "result": "pong"}


@pytest.mark.parametrize(
    "request_payload",
    [
        {"id": 1, "method": "ping", "params": []},
        {"jsonrpc": "1.0", "id": 1, "method": "ping", "params": []},
        {"jsonrpc": "2.0", "id": 1, "method": 7, "params": []},
        {"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}},
        {"jsonrpc": "2.0", "id": True, "method": "ping", "params": []},
        {"jsonrpc": "2.0", "id": None, "method": "ping", "params": []},
        {"jsonrpc": "2.0", "id": 1.5, "method": "ping", "params": []},
        {"jsonrpc": "2.0", "id": 2**53, "method": "ping", "params": []},
        {"jsonrpc": "2.0", "id": "", "method": "ping", "params": []},
        {"jsonrpc": "2.0", "id": "x" * 129, "method": "ping", "params": []},
        {"jsonrpc": "2.0", "id": 1, "method": " ", "params": []},
        {"jsonrpc": "2.0", "id": 1, "method": "x" * 257, "params": []},
    ],
)
def test_dispatcher_rejects_malformed_request_objects(request_payload: object) -> None:
    response = make_dispatcher().handle(request_payload)

    assert response is not None
    assert response["error"]["code"] == -32600


def test_serve_rejects_oversized_line_and_continues() -> None:
    dispatcher = make_dispatcher()
    oversized = b"{" + (b" " * MAX_REQUEST_BYTES) + b"}\n"
    valid = b'{"jsonrpc":"2.0","id":9,"method":"ping","params":[]}\n'
    stdout = io.StringIO()

    serve(dispatcher, stdin=io.BytesIO(oversized + valid), stdout=stdout)

    messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert messages[0]["error"] == {
        "code": -32600,
        "message": "JSON-RPC request exceeds 8 MiB",
    }
    assert messages[1] == {"jsonrpc": "2.0", "id": 9, "result": "pong"}


def test_serve_drains_oversized_partial_frame_and_continues() -> None:
    dispatcher = make_dispatcher()
    oversized = b"x" * (MAX_REQUEST_BYTES + 512) + b"\n"
    valid = b'{"jsonrpc":"2.0","id":11,"method":"ping","params":[]}\n'
    stdout = io.StringIO()

    serve(dispatcher, stdin=io.BytesIO(oversized + valid), stdout=stdout)

    messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert messages[0]["error"]["code"] == -32600
    assert messages[1] == {"jsonrpc": "2.0", "id": 11, "result": "pong"}


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_serve_rejects_nonstandard_json_numbers_and_continues(constant: str) -> None:
    dispatcher = make_dispatcher()
    invalid = f'{{"jsonrpc":"2.0","id":{constant},"method":"ping"}}\n'
    valid = '{"jsonrpc":"2.0","id":12,"method":"ping","params":[]}\n'
    stdout = io.StringIO()

    serve(dispatcher, stdin=io.StringIO(invalid + valid), stdout=stdout)

    messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert messages[0]["error"]["code"] == -32700
    assert messages[1] == {"jsonrpc": "2.0", "id": 12, "result": "pong"}


def test_serve_rejects_non_utf8_line_and_continues() -> None:
    dispatcher = make_dispatcher()
    valid = b'{"jsonrpc":"2.0","id":10,"method":"ping","params":[]}\n'
    stdout = io.StringIO()

    serve(dispatcher, stdin=io.BytesIO(b"\xff\n" + valid), stdout=stdout)

    messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert messages[0]["error"]["code"] == -32700
    assert messages[1] == {"jsonrpc": "2.0", "id": 10, "result": "pong"}


def _frame(method: str, request_id: int | None = None) -> str:
    request: dict[str, object] = {"jsonrpc": "2.0", "method": method, "params": []}
    if request_id is not None:
        request["id"] = request_id
    return json.dumps(request) + "\n"


def test_serve_accepts_process_claim_while_a_slow_request_runs() -> None:
    # The scheduler's claim deadline must not depend on an unrelated long
    # request finishing before main's acceptance is read.
    stdout = io.StringIO()
    dispatcher = Dispatcher(Emitter(stdout))
    accepted = threading.Event()

    def slow(_params: list[object], _emit: Emitter) -> bool:
        # Hold the worker until the acceptance response is on stdout, which the
        # old one-request-at-a-time loop could never produce.
        deadline = time.monotonic() + 10
        while '"id": 2' not in stdout.getvalue() and time.monotonic() < deadline:
            time.sleep(0.01)
        return accepted.is_set()

    def accept(_params: list[object], _emit: Emitter) -> dict[str, bool]:
        accepted.set()
        return {"accepted": True}

    dispatcher.register("results.list", slow)
    dispatcher.register("system.acceptProcessClaim", accept)
    stdin = io.StringIO(
        _frame("results.list", 1)
        + _frame("system.acceptProcessClaim")
        + _frame("system.acceptProcessClaim", 2)
    )

    serve(dispatcher, stdin=stdin, stdout=stdout)

    messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert messages == [
        {"jsonrpc": "2.0", "id": 2, "result": {"accepted": True}},
        {"jsonrpc": "2.0", "id": 1, "result": True},
    ]


def test_serve_answers_liveness_while_a_slow_request_runs() -> None:
    # Main probes liveness after a bounded call times out behind a long
    # request, and a busy runtime must answer instead of being recycled.
    stdout = io.StringIO()
    dispatcher = build_dispatcher(Emitter(stdout))

    def slow(_params: list[object], _emit: Emitter) -> str:
        # Hold the worker until the liveness answer is on stdout, which the
        # queued loop could never produce.
        deadline = time.monotonic() + 10
        while '"id": 2' not in stdout.getvalue() and time.monotonic() < deadline:
            time.sleep(0.01)
        return "listed"

    dispatcher.register("results.list", slow)
    stdin = io.StringIO(
        _frame("results.list", 1)
        + _frame("pipeline.previewCommand", 3)
        + _frame("system.liveness", 2)
    )

    serve(dispatcher, stdin=stdin, stdout=stdout)

    messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert messages[0] == {"jsonrpc": "2.0", "id": 2, "result": "alive"}
    assert messages[1] == {"jsonrpc": "2.0", "id": 1, "result": "listed"}
    assert [message["id"] for message in messages] == [2, 1, 3]


def test_serve_keeps_ordinary_requests_in_order_on_the_calling_thread() -> None:
    stdout = io.StringIO()
    dispatcher = Dispatcher(Emitter(stdout))
    calls: list[tuple[str, threading.Thread]] = []

    def record(name: str, delay: float) -> Callable[[list[object], Emitter], str]:
        def handler(_params: list[object], _emit: Emitter) -> str:
            time.sleep(delay)
            calls.append((name, threading.current_thread()))
            return name

        return handler

    dispatcher.register("first", record("first", 0.05))
    dispatcher.register("second", record("second", 0.0))
    dispatcher.register("third", record("third", 0.02))
    stdin = io.StringIO(
        _frame("first", 1)
        + "not json\n"
        + _frame("second")
        + _frame("third", 3)
        + _frame("second", 4)
    )

    serve(dispatcher, stdin=stdin, stdout=stdout)

    messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert [message.get("id") for message in messages] == [1, None, 3, 4]
    assert messages[1]["error"]["code"] == -32700
    assert [name for name, _thread in calls] == ["first", "second", "third", "second"]
    assert {thread for _name, thread in calls} == {threading.current_thread()}


def test_serve_returns_at_end_of_input_without_leaving_its_reader() -> None:
    serve(make_dispatcher(), stdin=io.StringIO(""), stdout=io.StringIO())

    assert not any(thread.name == "rpc-stdin" for thread in threading.enumerate())


def test_serve_raises_a_stdin_read_failure_on_the_calling_thread() -> None:
    class BrokenStdin:
        def readline(self, _limit: int) -> str:
            raise OSError("stdin closed abruptly")

    with pytest.raises(OSError, match="stdin closed abruptly"):
        serve(make_dispatcher(), stdin=BrokenStdin(), stdout=io.StringIO())


def test_project_validate_allows_a_structural_draft_with_missing_defacer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Save a structurally valid draft independently of the current host PATH.
    monkeypatch.setattr(tools, "which", lambda _name: None)
    dispatcher = make_dispatcher()
    cfg = default_config()
    cfg["steps"]["deface"] = {
        "enabled": True,
        "params": {"tool": "pydeface", "forceOverwrite": False},
    }
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 9, "method": "project.validate", "params": [cfg]}
    )
    assert response is not None
    result = response["result"]
    assert result["ok"] is True
    assert result["errors"] == []


def test_schema_validate_skips_adapter_checks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Keep schema.validate schema-only, and do not run the deface adapter check.
    monkeypatch.setattr(tools, "which", lambda _name: None)
    dispatcher = make_dispatcher()
    cfg = {"steps": {"deface": {"enabled": True, "params": {"tool": "nope_xyz"}}}}
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 10, "method": "schema.validate", "params": [cfg]}
    )
    assert response is not None
    assert not any("nope_xyz" in err for err in response["result"]["errors"])


def test_emitter_writes_notification() -> None:
    sink = io.StringIO()
    Emitter(sink).emit("pipeline.stdout", {"jobId": "#1", "line": "hi", "lev": "INFO"})
    message = json.loads(sink.getvalue().strip())
    assert message["method"] == "pipeline.stdout"
    assert message["params"]["jobId"] == "#1"


def test_emitter_serializes_concurrent_writes() -> None:
    # Keep every JSON line complete while worker threads stream output and the
    # dispatcher writes responses.
    sink = io.StringIO()
    emitter = Emitter(sink)

    def worker(worker_id: int) -> None:
        for i in range(25):
            emitter.emit("pipeline.stdout", {"jobId": f"#{worker_id}", "i": i})

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(16)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    lines = [line for line in sink.getvalue().splitlines() if line.strip()]
    assert len(lines) == 16 * 25
    for line in lines:
        json.loads(line)  # Require a complete, uncorrupted JSON message.
