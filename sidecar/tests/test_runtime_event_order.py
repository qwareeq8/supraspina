"""Tests for strictly ordered runtime-event delivery under concurrency."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.workflow_manager import WorkflowManager, _RunContext


class _RecordingEmitter:
    """Record every notification in wire order under a gate hook."""

    def __init__(self, gate: Any = None) -> None:
        self.messages: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._gate = gate

    def emit(self, method: str, params: dict[str, Any]) -> None:
        if self._gate is not None:
            self._gate(params)
        with self._lock:
            self.messages.append({"method": method, **params})

    def sequences(self) -> list[int]:
        with self._lock:
            return [
                message["sequence"]
                for message in self.messages
                if message["method"] == "runtime.event"
            ]


def _project(root: Path) -> ProjectIdentity:
    return ProjectIdentity(
        project_id="project-order",
        root=str(root),
        config_path=str(root / "supraspina.project.json"),
        epoch=1,
    )


def _context(manager: WorkflowManager, root: Path, run_id: str) -> _RunContext:
    project = _project(root)
    return _RunContext(
        state={"runId": run_id, "nodes": [], "jobs": [], "receipts": []},
        cfg={},
        effective_cfg={},
        cohort=None,
        project=project,
        store=None,
        queue_limit=1,
    )


def test_concurrent_producers_cannot_invert_the_runtime_wire_order(
    tmp_path: Path,
) -> None:
    """Prove the numbering and the write stay atomic against a second producer.

    Block the first writer inside the emitter and release it only once a second
    producer has written. Under a manager that numbers under one lock and writes
    after releasing it, the second producer overtakes the first and the recorded
    order inverts. Under the repaired manager the second producer cannot reach
    the emitter at all, so the bounded wait expires and the order holds.
    """
    entered_first = threading.Event()
    second_emitted = threading.Event()
    first_thread: list[int] = []

    def gate(_params: dict[str, Any]) -> None:
        if not entered_first.is_set() and threading.get_ident() in first_thread:
            entered_first.set()
            # Bounded: the repaired manager never lets the second writer in.
            second_emitted.wait(0.5)
            return
        second_emitted.set()

    emitter = _RecordingEmitter(gate)
    manager = WorkflowManager(emitter)
    try:
        ctx = _context(manager, tmp_path, "run-aaaaaaaa")

        def produce_first() -> None:
            first_thread.append(threading.get_ident())
            manager._runtime_event(ctx, "log", {"log": {"line": "first"}})

        def produce_second() -> None:
            entered_first.wait(2.0)
            manager._runtime_event(ctx, "log", {"log": {"line": "second"}})

        one = threading.Thread(target=produce_first)
        two = threading.Thread(target=produce_second)
        one.start()
        entered_first.wait(2.0)
        two.start()
        one.join(5.0)
        two.join(5.0)

        assert not one.is_alive()
        assert not two.is_alive()
        assert emitter.sequences() == [1, 2]
    finally:
        manager.shutdown(timeout=1.0)


def test_many_producers_publish_a_gapless_increasing_sequence(
    tmp_path: Path,
) -> None:
    emitter = _RecordingEmitter()
    manager = WorkflowManager(emitter)
    try:
        contexts = [
            _context(manager, tmp_path, f"run-{index:08x}") for index in range(8)
        ]

        def produce(ctx: _RunContext) -> None:
            for _ in range(50):
                manager._runtime_event(
                    ctx, "log", {"log": {"line": ctx.state["runId"]}}
                )

        threads = [threading.Thread(target=produce, args=(ctx,)) for ctx in contexts]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30.0)

        sequences = emitter.sequences()
        assert sequences == list(range(1, 401))
        assert manager.published_sequence() == 400
    finally:
        manager.shutdown(timeout=1.0)


def test_provisioning_shares_the_ordered_runtime_stream(tmp_path: Path) -> None:
    emitter = _RecordingEmitter()
    manager = WorkflowManager(emitter)
    try:
        project = _project(tmp_path)
        ctx = _context(manager, tmp_path, "run-aaaaaaaa")

        def produce_runs() -> None:
            for _ in range(40):
                manager._runtime_event(ctx, "log", {"log": {"line": "run"}})

        def produce_provision() -> None:
            for index in range(40):
                manager.emit_provision(project, {"step": index})

        threads = [
            threading.Thread(target=produce_runs),
            threading.Thread(target=produce_provision),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30.0)

        assert emitter.sequences() == list(range(1, 81))
    finally:
        manager.shutdown(timeout=1.0)


def test_shutdown_terminates_the_sequence_without_reordering(tmp_path: Path) -> None:
    emitter = _RecordingEmitter()
    manager = WorkflowManager(emitter)
    ctx = _context(manager, tmp_path, "run-aaaaaaaa")
    manager._runtime_event(ctx, "log", {"log": {"line": "before"}})

    result = manager.shutdown(timeout=1.0)
    published = manager.published_sequence()
    sequences = emitter.sequences()

    assert result["closing"] is True
    assert sequences == sorted(sequences)
    assert sequences == list(range(1, len(sequences) + 1))
    assert published == len(sequences)


def test_bootstrap_snapshot_never_claims_an_unwritten_sequence(
    tmp_path: Path,
) -> None:
    """Prove the snapshot cursor only advances past events already on the wire."""
    observed: list[int] = []
    release = threading.Event()
    reached_emitter = threading.Event()

    def gate(_params: dict[str, Any]) -> None:
        reached_emitter.set()
        release.wait(0.5)

    emitter = _RecordingEmitter(gate)
    manager = WorkflowManager(emitter)
    try:
        ctx = _context(manager, tmp_path, "run-aaaaaaaa")
        producer = threading.Thread(
            target=lambda: manager._runtime_event(ctx, "log", {"log": {"line": "x"}})
        )
        producer.start()
        reached_emitter.wait(2.0)
        reader = threading.Thread(
            target=lambda: observed.append(manager.published_sequence())
        )
        reader.start()
        reader.join(0.2)
        assert reader.is_alive()
        release.set()
        producer.join(5.0)
        reader.join(5.0)

        assert observed == [1]
        assert emitter.sequences() == [1]
    finally:
        manager.shutdown(timeout=1.0)
