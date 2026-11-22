"""Minimal JSON-RPC 2.0 request dispatch for the sidecar.

Dotted method names (for example ``pipeline.listSteps``) map to handler
callables. Each handler receives the positional ``params`` list sent by the
renderer and returns a JSON-serializable result. Optional streaming-log or
provisioning-progress notifications are emitted through the handler's
:class:`Emitter`.
"""

from __future__ import annotations

import copy
import json
import queue
import sys
import threading
from collections.abc import Callable, Iterator
from typing import Any

from .authorization import PlanStaleError
from .operator_errors import OperatorError
from .redaction import redact_text, safe_error

# Accept positional params and an emitter in each handler, and return a result.
Handler = Callable[[list[Any], "Emitter"], Any]

METHOD_NOT_FOUND = -32601
INVALID_REQUEST = -32600
INTERNAL_ERROR = -32603
PARSE_ERROR = -32700
MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_REQUEST_ID_CHARACTERS = 128
MAX_METHOD_CHARACTERS = 256
MAX_SAFE_INTEGER = (2**53) - 1
_PLAN_STALE_DATA = {
    "code": "PLAN_STALE",
    "action": {"id": "reviewAgain", "label": "Review again"},
}
_OPERATOR_DATA = {"code": "OPERATOR"}
_MAX_OPERATOR_MESSAGE_CHARACTERS = 512
# Control calls that the stdin reader runs the moment they arrive
# instead of queueing them behind the request in progress. The workflow
# scheduler kills a job that has just started when main's process-claim
# acceptance misses its deadline, and a long read-only request such as
# ``results.list`` could otherwise hold that acceptance unread in stdin past
# the deadline. Admit only handlers that are safe to run concurrently with the
# worker thread; ``accept_process_claim`` touches shared state only under the
# workflow manager's lock and signals the waiting scheduler through an Event.
# ``system.liveness`` returns a constant and touches no state. Main sends it
# after a bounded call times out, so an answer shows that the runtime is alive
# and merely busy with an earlier request rather than hung.
LIVENESS_METHOD = "system.liveness"
IMMEDIATE_METHODS = frozenset({"system.acceptProcessClaim", LIVENESS_METHOD})


class Emitter:
    """Write JSON-RPC messages as newline-delimited JSON.

    Guard every write with one lock so concurrent worker threads (job
    output streamed via :meth:`emit`) and the dispatch threads (responses
    written via :meth:`write_message`) can never interleave a half-written line
    on the shared stdout stream.
    """

    def __init__(self, stream: Any) -> None:
        """Initialize with an output text stream.

        Parameters
        ----------
        stream
            Provide the writable text stream, typically ``sys.stdout``.
        """
        self._stream = stream
        self._lock = threading.Lock()

    def emit(self, method: str, params: Any) -> None:
        """Emit a notification.

        Parameters
        ----------
        method
            Provide the notification method name, such as ``pipeline.stdout``.
        """
        message = {"jsonrpc": "2.0", "method": method, "params": params}
        self.write_message(self._stream, message)

    def write_message(self, stream: Any, message: dict[str, Any]) -> None:
        """Write one JSON-RPC message followed by a newline, under the lock.

        Parameters
        ----------
        stream
            Provide the notification stream for :meth:`emit` or response sink
            for the serve loop.
        """
        data = json.dumps(message) + "\n"
        with self._lock:
            stream.write(data)
            stream.flush()


class Dispatcher:
    """Register method handlers and dispatch requests."""

    def __init__(self, emitter: Emitter) -> None:
        """Initialize with the emitter handlers use for notifications."""
        self._handlers: dict[str, Handler] = {}
        self._emitter = emitter

    @property
    def emitter(self) -> Emitter:
        """Return the emitter used for notifications and response writes."""
        return self._emitter

    @property
    def methods(self) -> frozenset[str]:
        """Return the registered method names for contract coverage."""
        return frozenset(self._handlers)

    def register(self, method: str, handler: Handler) -> None:
        """Register a handler for a dotted method name."""
        self._handlers[method] = handler

    def handle(self, request: Any) -> dict[str, Any] | None:
        """Handle one JSON-RPC request and return a response.

        Returns
        -------
        dict or None
            Return a JSON-RPC response dict or ``None`` for notifications.
        """
        if not isinstance(request, dict):
            return _error(None, INVALID_REQUEST, "invalid JSON-RPC request")

        has_id = "id" in request
        request_id = request.get("id")
        valid_id = not has_id or _valid_request_id(request_id)
        method = request.get("method")
        params = request.get("params", [])
        if (
            request.get("jsonrpc") != "2.0"
            or not isinstance(method, str)
            or not method.strip()
            or len(method) > MAX_METHOD_CHARACTERS
            or not isinstance(params, list)
            or not valid_id
        ):
            return _error(
                request_id if valid_id else None,
                INVALID_REQUEST,
                "invalid JSON-RPC request",
            )

        if method not in self._handlers:
            return (
                _error(request_id, METHOD_NOT_FOUND, f"method not found: {method}")
                if has_id
                else None
            )

        error: tuple[str, dict[str, Any] | None] | None = None
        try:
            result = self._handlers[method](params, self._emitter)
        except PlanStaleError as exc:
            error = (safe_error(exc), _PLAN_STALE_DATA)
        except OperatorError as exc:
            # Publish errors authored for the window instead of replacing them.
            # Apply redaction to preserve the guarantee if a future call site
            # interpolates host state.
            error = (
                redact_text(str(exc))[:_MAX_OPERATOR_MESSAGE_CHARACTERS]
                or safe_error(exc),
                _OPERATOR_DATA,
            )
        except ValueError as exc:
            # A sidecar ValueError rejects untrusted input, and by convention it
            # carries a validation sentence written for the operator, so publish
            # it under the same redaction and length bound as a refusal. Every
            # other exception class reports a crash and keeps its class alone.
            error = (
                redact_text(str(exc))[:_MAX_OPERATOR_MESSAGE_CHARACTERS]
                or safe_error(exc),
                _OPERATOR_DATA,
            )
        except Exception as exc:
            error = (safe_error(exc), None)

        if not has_id:
            return None
        if error is not None:
            message, data = error
            return _error(request_id, INTERNAL_ERROR, message, data=data)
        return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _valid_request_id(value: Any) -> bool:
    """Return whether one request ID can round-trip through both runtimes."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER
    return (
        isinstance(value, str)
        and 0 < len(value) <= MAX_REQUEST_ID_CHARACTERS
        and "\x00" not in value
    )


def _reject_nonfinite_json(value: str) -> None:
    """Reject Python's nonstandard NaN and infinity JSON extensions."""
    raise ValueError(f"invalid JSON constant: {value}")


def _error(
    request_id: Any,
    code: int,
    message: str,
    *,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a JSON-RPC error response."""
    error = {"code": code, "message": message}
    if data is not None:
        error["data"] = copy.deepcopy(data)
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


def _read_frames(source: Any) -> Iterator[tuple[str, Any]]:
    """Yield each stdin frame as a parsed request or a ready error response.

    Yield ``("request", obj)`` for a line that parses as JSON and
    ``("reply", response)`` for a line rejected for its size, encoding, or
    syntax, so the rejection is written in the order its frame arrived. Stop
    when the stream reaches end of file.
    """
    while True:
        raw_line = source.readline(MAX_REQUEST_BYTES + 1)
        if raw_line in ("", b""):
            return

        is_binary = isinstance(raw_line, bytes)
        too_large = len(raw_line) > MAX_REQUEST_BYTES
        complete = raw_line.endswith(b"\n" if is_binary else "\n")
        if too_large and not complete:
            while True:
                remainder = source.readline(MAX_REQUEST_BYTES + 1)
                if remainder in ("", b"") or remainder.endswith(
                    b"\n" if isinstance(remainder, bytes) else "\n"
                ):
                    break
        if too_large:
            yield (
                "reply",
                _error(None, INVALID_REQUEST, "JSON-RPC request exceeds 8 MiB"),
            )
            continue

        if is_binary:
            try:
                raw_line = raw_line.decode("utf-8")
            except UnicodeDecodeError:
                yield "reply", _error(None, PARSE_ERROR, "invalid JSON")
                continue
        elif len(raw_line.encode("utf-8")) > MAX_REQUEST_BYTES:
            yield (
                "reply",
                _error(None, INVALID_REQUEST, "JSON-RPC request exceeds 8 MiB"),
            )
            continue

        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line, parse_constant=_reject_nonfinite_json)
        except (json.JSONDecodeError, ValueError):
            yield "reply", _error(None, PARSE_ERROR, "invalid JSON")
            continue
        yield "request", request


def _dispatches_immediately(request: Any) -> bool:
    """Return whether the stdin reader runs this request instead of queueing it."""
    return isinstance(request, dict) and request.get("method") in IMMEDIATE_METHODS


def serve(dispatcher: Dispatcher, stdin: Any = None, stdout: Any = None) -> None:
    """Run the read-dispatch-write loop until stdin closes.

    Read stdin on a dedicated thread so a control call never waits behind a
    slow request. The reader runs :data:`IMMEDIATE_METHODS` itself and queues
    every other frame, in arrival order, for the calling thread, which stays
    the only thread that runs ordinary handlers. Responses to queued requests
    therefore keep their request order.

    Parameters
    ----------
    stdin
        Provide the input text stream, defaulting to ``sys.stdin``.
    stdout
        Provide the output text stream, defaulting to ``sys.stdout``.
    """
    source = stdin if stdin is not None else getattr(sys.stdin, "buffer", sys.stdin)
    sink = stdout if stdout is not None else sys.stdout
    emitter = dispatcher.emitter
    inbox: queue.SimpleQueue[tuple[str, Any]] = queue.SimpleQueue()

    def read_stdin() -> None:
        # Forward end of file and any read failure to the calling thread, so
        # serve() returns or raises there as it did when it read stdin itself.
        try:
            for kind, payload in _read_frames(source):
                if kind == "request" and _dispatches_immediately(payload):
                    response = dispatcher.handle(payload)
                    if response is not None:
                        emitter.write_message(sink, response)
                else:
                    inbox.put((kind, payload))
        except BaseException as exc:
            inbox.put(("raise", exc))
        else:
            inbox.put(("eof", None))

    # Use a daemon thread so a stdin read still blocked after serve() raises
    # never holds the process open.
    reader = threading.Thread(target=read_stdin, name="rpc-stdin", daemon=True)
    reader.start()
    while True:
        kind, payload = inbox.get()
        if kind == "eof":
            break
        if kind == "raise":
            raise payload
        if kind == "reply":
            emitter.write_message(sink, payload)
            continue
        response = dispatcher.handle(payload)
        if response is not None:
            emitter.write_message(sink, response)
    reader.join()
