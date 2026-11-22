"""Tests for process safety, restart projection, and bounded runtime helpers."""

from __future__ import annotations

import signal
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import workflow_manager as runtime


def test_runtime_timestamp_config_and_job_order_helpers() -> None:
    assert runtime._iso(None) is None
    assert runtime._iso(0) == "1970-01-01T00:00:00+00:00"
    assert runtime._config_sha({"b": 2, "a": 1}) == runtime._config_sha(
        {"a": 1, "b": 2}
    )
    assert runtime._job_time({"endedAt": "invalid", "startedAt": 3}) == 3
    assert runtime._job_time({"plannedAt": 0}) == 0


def test_bounded_jobs_deduplicates_and_preserves_active_and_persistence_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime, "TERMINAL_CACHE_LIMIT", 2)
    values: list[Any] = [
        None,
        {},
        {"id": "active", "status": "queued", "plannedAt": 1},
        {"id": "persist", "status": "failed", "persistenceStatus": "error"},
        {"id": "old", "status": "done", "endedAt": 2},
        {"id": "middle", "status": "done", "endedAt": 3},
        {"id": "new", "status": "done", "endedAt": 4},
        {"id": "new", "status": "done", "endedAt": 5, "copied": True},
    ]

    selected = runtime._bounded_jobs(values)  # type: ignore[arg-type]

    assert [value["id"] for value in selected] == [
        "persist",
        "active",
        "middle",
        "new",
    ]
    assert selected[-1]["copied"] is True
    values[-1]["copied"] = False
    assert selected[-1]["copied"] is True


def test_resume_intent_leaves_all_and_cohort_stage_targets_unchanged() -> None:
    acknowledgements = {"includeDeferredAndUnreviewedQc": False}
    all_intent = {"kind": "workflow", "target": {"mode": "all"}}
    cohort_stage = {
        "kind": "stage",
        "stepKey": "aggregate",
        "target": {"mode": "explicit", "subjectIds": ["sub-01"]},
    }

    assert runtime._resume_intent(all_intent, {}, acknowledgements) == (
        all_intent,
        None,
    )
    assert runtime._resume_intent(cohort_stage, {}, acknowledgements) == (
        cohort_stage,
        None,
    )


def test_resume_intent_keeps_explicit_target_when_current_cohort_cannot_resolve(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    intent = {
        "kind": "stage",
        "stepKey": "recon",
        "target": {"mode": "explicit", "subjectIds": ["sub-01", 7]},
    }

    monkeypatch.setattr(
        runtime,
        "build_cohort_snapshot",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            runtime.CohortError("Block the fixture cohort.")
        ),
    )

    effective, reconciliation = runtime._resume_intent(
        intent,
        {},
        {"includeDeferredAndUnreviewedQc": False},
    )

    assert effective == intent
    assert reconciliation is None


def test_tail_text_file_bounds_bytes_lines_and_line_length(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "runtime.log"
    path.write_text("discard\nsecond\n" + "x" * 20 + "\n", encoding="utf-8")
    monkeypatch.setattr(runtime, "_REPLAY_LOG_BYTES_PER_JOB", 28)
    monkeypatch.setattr(runtime, "_REPLAY_LOG_LINES_PER_JOB", 2)
    monkeypatch.setattr(runtime, "_REPLAY_LOG_LINE_CHARS", 8)

    lines, truncated = runtime._tail_text_file(str(path))

    assert truncated is True
    assert len(lines) == 2
    assert lines[0].startswith("[line pr")
    assert lines[1] == "xxxxxxxx [line truncated]"


def test_tail_text_file_rejects_non_regular_file(tmp_path: Path) -> None:
    with pytest.raises(OSError, match=r"^Provide a regular job log file\.$"):
        runtime._tail_text_file(str(tmp_path))


class _Gate:
    def __init__(self, *, fail_close: bool = False) -> None:
        self.writes: list[str] = []
        self.flushed = False
        self.closed = False
        self.fail_close = fail_close

    def write(self, value: str) -> None:
        self.writes.append(value)

    def flush(self) -> None:
        self.flushed = True

    def close(self) -> None:
        self.closed = True
        if self.fail_close:
            raise OSError("Treat the stream as already closed.")


class _Process:
    def __init__(
        self,
        *,
        pid: int | None = None,
        returncode: int | None = None,
        stream: _Gate | None = None,
    ) -> None:
        self.pid = pid
        self.returncode = returncode
        self.stdin = stream
        self._supraspina_gate_stream = stream
        self.terminated = 0
        self.killed = 0

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated += 1

    def kill(self) -> None:
        self.killed += 1


def test_release_and_close_spawn_gate_cover_stream_and_fd_ownership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stream = _Gate()
    proc = _Process(stream=stream)
    written: list[tuple[int, bytes]] = []
    closed: list[int] = []
    proc._supraspina_gate_fd = 41
    monkeypatch.setattr(
        runtime.os, "write", lambda fd, value: written.append((fd, value))
    )
    monkeypatch.setattr(runtime.os, "close", closed.append)

    runtime._release_spawn(proc)

    assert stream.writes == ["1"]
    assert stream.flushed is True
    assert stream.closed is True
    assert proc.stdin is None
    assert written == [(41, b"1")]
    assert closed == [41]
    assert proc._supraspina_gate_fd is None

    proc = _Process(stream=_Gate(fail_close=True))
    proc._supraspina_gate_fd = 42
    monkeypatch.setattr(
        runtime.os,
        "close",
        lambda _fd: (_ for _ in ()).throw(
            OSError("Treat the file descriptor as closed.")
        ),
    )
    runtime._close_spawn_gate(proc)
    assert proc.stdin is None
    assert proc._supraspina_gate_fd is None


def test_release_spawn_without_gate_is_a_noop() -> None:
    proc = _Process()
    runtime._release_spawn(proc)
    assert proc.stdin is None


def test_spawn_uses_posix_gate_and_propagates_scientific_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    proc = _Process(pid=42)

    def popen(command: list[str], **kwargs: Any) -> _Process:
        captured["command"] = command
        captured["kwargs"] = kwargs
        return proc

    monkeypatch.setattr(runtime, "_IS_WINDOWS", False)
    monkeypatch.setattr(runtime.sys, "frozen", False, raising=False)
    monkeypatch.setattr(runtime.os, "pipe", lambda: (31, 32))
    monkeypatch.setattr(runtime.os, "close", lambda _fd: None)
    monkeypatch.setattr(runtime.subprocess, "Popen", popen)

    spawned = runtime._spawn(
        ["scientific", "--safe"],
        {
            "paths": {
                "projectRoot": "/study",
                "derivativesDir": "${projectRoot}/derivatives",
            },
            "tools": {
                "freesurferHome": "/opt/fs-test",
                "freesurferLicense": "/opt/fs-test/license.txt",
            },
        },
    )

    assert spawned is proc
    assert proc._supraspina_gate_fd == 32
    assert captured["command"][-2:] == ["scientific", "--safe"]
    assert captured["kwargs"]["pass_fds"] == (31,)
    assert captured["kwargs"]["start_new_session"] is True
    assert captured["kwargs"]["env"]["FREESURFER_HOME"] == "/opt/fs-test"
    assert captured["kwargs"]["env"]["FREESURFER_HOME_FSPYTHON"] == "/opt/fs-test"
    assert captured["kwargs"]["env"]["FREESURFER"] == "/opt/fs-test"
    assert captured["kwargs"]["env"]["SUBJECTS_DIR"] == "/study/derivatives/freesurfer"
    assert captured["kwargs"]["env"]["FS_LICENSE"] == "/opt/fs-test/license.txt"


def test_spawn_closes_write_gate_when_process_creation_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    closed: list[int] = []
    monkeypatch.setattr(runtime, "_IS_WINDOWS", False)
    monkeypatch.setattr(runtime.sys, "frozen", False, raising=False)
    monkeypatch.setattr(runtime.os, "pipe", lambda: (31, 32))
    monkeypatch.setattr(runtime.os, "close", closed.append)
    monkeypatch.setattr(
        runtime.subprocess,
        "Popen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("Fail the fixture spawn.")
        ),
    )

    with pytest.raises(OSError, match="Fail the fixture spawn"):
        runtime._spawn(["scientific"], {"tools": "invalid"})
    assert closed == [32, 31]


def test_spawn_uses_frozen_gate_without_developer_python_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    proc = _Process(stream=_Gate())

    def popen(command: list[str], **kwargs: Any) -> _Process:
        captured["command"] = command
        captured["kwargs"] = kwargs
        return proc

    monkeypatch.setattr(runtime, "_IS_WINDOWS", False)
    monkeypatch.setattr(runtime.sys, "frozen", True, raising=False)
    monkeypatch.setattr(runtime.subprocess, "Popen", popen)

    assert runtime._spawn(["scientific"], {}) is proc
    assert captured["command"] == [
        runtime.sys.executable,
        runtime._FROZEN_EXEC_GATE_ARG,
        "scientific",
    ]
    assert captured["kwargs"]["stdin"] is runtime.subprocess.PIPE
    assert captured["kwargs"]["start_new_session"] is True
    assert proc._supraspina_gate_stream is proc.stdin


class _Job:
    def __init__(
        self, *, raises: bool = False, active: list[int] | None = None
    ) -> None:
        self.raises = raises
        self.active = list(active or [])
        self.terminated = 0
        self.closed = 0

    def terminate(self) -> None:
        self.terminated += 1
        if self.raises:
            raise OSError("Treat the process as already stopped.")

    def active_processes(self) -> int:
        if self.raises:
            raise OSError("Fail the process query.")
        return self.active.pop(0) if self.active else 0

    def close(self) -> None:
        self.closed += 1


def test_terminate_tree_prefers_owned_job_and_tolerates_finished_job() -> None:
    job = _Job(raises=True)
    proc = _Process()
    proc._supraspina_job = job

    runtime._terminate_tree(proc)

    assert job.terminated == 1
    assert proc.terminated == 0


@pytest.mark.parametrize(
    ("force", "expected_signal"),
    [(False, signal.SIGTERM), (True, signal.SIGKILL)],
)
def test_terminate_tree_signals_known_process_group(
    force: bool,
    expected_signal: signal.Signals,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    proc = _Process(pid=51)
    proc._supraspina_pgid = 52
    signals: list[tuple[int, signal.Signals]] = []
    monkeypatch.setattr(runtime, "_IS_WINDOWS", False)
    monkeypatch.setattr(
        runtime.os, "killpg", lambda pgid, sig: signals.append((pgid, sig))
    )

    runtime._terminate_tree(proc, force=force)

    assert signals == [(52, expected_signal)]


def test_terminate_tree_falls_back_to_process_method_after_signal_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    proc = _Process(pid=51)
    monkeypatch.setattr(runtime, "_IS_WINDOWS", False)
    monkeypatch.setattr(runtime.os, "getpgid", lambda _pid: 52)
    monkeypatch.setattr(
        runtime.os,
        "killpg",
        lambda *_args: (_ for _ in ()).throw(ProcessLookupError),
    )

    runtime._terminate_tree(proc, force=True)

    assert proc.killed == 1


def test_terminate_tree_uses_process_methods_when_pid_is_absent() -> None:
    graceful = _Process()
    forced = _Process()

    runtime._terminate_tree(graceful)
    runtime._terminate_tree(forced, force=True)

    assert graceful.terminated == 1
    assert forced.killed == 1


def test_process_group_and_liveness_handle_invalid_missing_and_permission(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert runtime._process_group(_Process(pid=None)) is None
    monkeypatch.setattr(runtime, "_IS_WINDOWS", True)
    assert runtime._process_group(_Process(pid=9)) == 9

    monkeypatch.setattr(runtime, "_IS_WINDOWS", False)
    monkeypatch.setattr(
        runtime.os, "getpgid", lambda _pid: (_ for _ in ()).throw(OSError)
    )
    assert runtime._process_group(_Process(pid=9)) is None
    assert runtime._process_group_state(0) == "unknown"
    monkeypatch.setattr(
        runtime.os,
        "killpg",
        lambda *_args: (_ for _ in ()).throw(PermissionError),
    )
    assert runtime._process_group_state(10) == "unknown"
    monkeypatch.setattr(
        runtime.os,
        "killpg",
        lambda *_args: (_ for _ in ()).throw(ProcessLookupError),
    )
    assert runtime._process_group_state(10) == "dead"
    monkeypatch.setattr(runtime.os, "killpg", lambda *_args: None)
    assert runtime._process_group_state(10) == "alive"


def test_settle_group_closes_proved_job_and_retains_unproved_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    proved_job = _Job(active=[1, 0])
    proved_proc = _Process()
    proved_proc._supraspina_job = proved_job
    monkeypatch.setattr(runtime.time, "sleep", lambda _delay: None)

    assert runtime._settle_group(proved_proc, None) is True
    assert proved_job.terminated == 1
    assert proved_job.closed == 1
    assert proved_proc._supraspina_job is None

    failed_job = _Job(raises=True)
    failed_proc = _Process()
    failed_proc._supraspina_job = failed_job
    assert runtime._settle_group(failed_proc, None) is False
    assert failed_proc._supraspina_job is failed_job


def test_settle_group_handles_absent_and_disappearing_posix_groups(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    proc = _Process(returncode=0)
    proc._supraspina_pgid = 70
    monkeypatch.setattr(runtime, "_IS_WINDOWS", False)
    monkeypatch.setattr(runtime, "_process_group_state", lambda _pgid: "dead")
    assert runtime._settle_group(proc, 70) is True
    assert proc._supraspina_pgid is None

    proc._supraspina_pgid = 71
    monkeypatch.setattr(runtime, "_process_group_state", lambda _pgid: "alive")
    monkeypatch.setattr(
        runtime.os,
        "killpg",
        lambda *_args: (_ for _ in ()).throw(ProcessLookupError),
    )
    assert runtime._settle_group(proc, 71) is True

    # An unknown group identity is never proof that the tree settled.
    unknown = _Process(returncode=0)
    unknown._supraspina_pgid = None
    assert runtime._settle_group(unknown, None) is False
    monkeypatch.setattr(runtime, "_process_group_state", lambda _pgid: "unknown")
    assert runtime._settle_group(proc, 72) is False


def test_cohort_scope_rehydrates_snake_and_camel_case_t1_fields() -> None:
    cohort = runtime._cohort_from_scope(
        {
            "analysisSubjectIds": ["sub-01", "sub-02"],
            "selectedSubjectIds": ["sub-01"],
            "analysisDigest": "analysis",
            "selectedDigest": "selected",
            "qcVerdicts": {"sub-02": "defer", "sub-01": "pass"},
            "qcAcknowledged": True,
            "excludedByConfig": ["sub-03"],
            "excludedByQc": ["sub-04"],
            "t1": [
                {
                    "subject_id": "sub-01",
                    "state": "resolved",
                    "path": "/synthetic/t1-a",
                    "candidates": ["/synthetic/t1-a"],
                    "fingerprint": "aaa",
                    "fingerprint_strategy": "full",
                },
                {
                    "subjectId": "sub-02",
                    "path": "/synthetic/t1-b",
                    "fingerprint": "bbb",
                    "fingerprintStrategy": "camel",
                },
            ],
        }
    )

    assert cohort.analysis_subject_ids == ("sub-01", "sub-02")
    assert cohort.selected_subject_ids == ("sub-01",)
    assert cohort.qc_verdicts == (("sub-01", "pass"), ("sub-02", "defer"))
    assert cohort.qc_acknowledged is True
    assert [row.fingerprint_strategy for row in cohort.t1] == ["full", "camel"]


def test_cohort_scope_rejects_truthy_string_acknowledgement() -> None:
    with pytest.raises(
        ValueError,
        match=r"Provide scope\.qcAcknowledged as a boolean",
    ):
        runtime._cohort_from_scope({"qcAcknowledged": "true"})
