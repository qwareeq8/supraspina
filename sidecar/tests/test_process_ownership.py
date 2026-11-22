"""Tests for the scientific process-ownership gate."""

from __future__ import annotations

import ast
import io
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar
from unittest.mock import Mock

import pytest

import supraspina_sidecar.workflow_manager as workflow_module
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.workflow_manager import (
    WorkflowManager,
    _linux_process_identity,
    _posix_process_identity,
    _process_group_state,
    _process_start_identity,
    _release_spawn,
    _settle_group,
    _spawn,
    _terminate_tree,
)


@pytest.mark.skipif(
    os.name == "nt",
    reason="Run this test only with the POSIX inherited-pipe exec gate.",
)
def test_scientific_argv_cannot_exec_before_ownership_release(tmp_path: Path) -> None:
    marker = tmp_path / "started.txt"
    proc = _spawn(
        [
            sys.executable,
            "-c",
            "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.argv[2])",
            str(marker),
            "exact scientific argv",
        ],
        {},
    )
    assert proc.args[:5] == [
        sys.executable,
        "-I",
        "-S",
        "-c",
        workflow_module._EXEC_GATE,
    ]
    assert marker.exists() is False

    _release_spawn(proc)
    stdout, _ = proc.communicate(timeout=5)

    assert proc.returncode == 0
    assert stdout == ""
    assert marker.read_text(encoding="utf-8") == "exact scientific argv"


@pytest.mark.skipif(
    os.name == "nt",
    reason="Run this test only with the POSIX inherited-pipe exec gate.",
)
def test_gate_eof_exits_without_launching_scientific_argv(tmp_path: Path) -> None:
    marker = tmp_path / "must-not-exist.txt"
    proc = _spawn(
        [
            sys.executable,
            "-c",
            "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('launched')",
            str(marker),
        ],
        {},
    )
    gate_fd = proc._supraspina_gate_fd
    os.close(gate_fd)
    proc._supraspina_gate_fd = None

    assert proc.wait(timeout=5) == 125
    assert marker.exists() is False


@pytest.mark.skipif(
    os.name == "nt",
    reason="Run this test only with the POSIX inherited-pipe exec gate.",
)
def test_complete_owner_claim_is_acknowledged_before_exec_release(
    tmp_path: Path,
) -> None:
    marker = tmp_path / "accepted.txt"

    class _AckEmitter:
        def __init__(self) -> None:
            self.manager: WorkflowManager | None = None
            self.events: list[str] = []

        def emit(self, method: str, params: dict[str, object]) -> None:
            self.events.append(method)
            if method == "system.processStarted":
                assert self.manager is not None
                self.manager.accept_process_claim({**params, "accepted": True})

    emitter = _AckEmitter()
    manager = WorkflowManager(emitter)
    emitter.manager = manager
    manager.attach_supervisor_generation(7)
    project = ProjectIdentity(
        "claim-project",
        str(tmp_path.resolve()),
        str((tmp_path / "supraspina.project.json").resolve()),
        1,
    )
    proc = _spawn(
        [
            sys.executable,
            "-c",
            "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('released')",
            str(marker),
        ],
        {},
    )
    try:
        owner = manager.process_owner_record(
            operation_kind="workflow",
            project=project,
            proc=proc,
            run_id="run-deadbeef",
            job_id="#claim-job",
        )
        assert marker.exists() is False

        assert manager.announce_process_started(owner, proc) == proc.pid

        assert owner["accepted"] is True
        assert owner["state"] == "accepted"
        assert marker.exists() is False
        assert emitter.events[:2] == [
            "system.processOwnerRegistered",
            "system.processStarted",
        ]

        _release_spawn(proc)
        proc.communicate(timeout=5)
        assert marker.read_text(encoding="utf-8") == "released"
        assert manager.announce_process_settled(owner, proc, proc.pid) is True
    finally:
        if proc.poll() is None:
            _terminate_tree(proc, force=True)
            proc.wait(timeout=5)
        manager.shutdown()


class _Gate:
    def __init__(self) -> None:
        self.writes: list[str] = []
        self.closed = False

    def write(self, value: str) -> None:
        self.writes.append(value)

    def flush(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True


class _FakeWindowsProc:
    def __init__(self, command: list[str], **kwargs: object) -> None:
        self.command = command
        self.kwargs = kwargs
        self.stdin = _Gate()
        self.stdout = []
        self.pid = 4242
        self._handle = 99
        self.killed = False

    def poll(self) -> None:
        return None

    def kill(self) -> None:
        self.killed = True


class _FakeWindowsJob:
    instances: ClassVar[list[_FakeWindowsJob]] = []

    def __init__(self) -> None:
        self.assigned: _FakeWindowsProc | None = None
        self.terminations = 0
        self.closed = False
        self.active = [1, 0]
        self.instances.append(self)

    def assign(self, proc: _FakeWindowsProc) -> None:
        self.assigned = proc

    def terminate(self) -> None:
        self.terminations += 1

    def active_processes(self) -> int:
        return self.active.pop(0) if self.active else 0

    def close(self) -> None:
        self.closed = True


def test_windows_gate_is_job_owned_before_scientific_release(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeWindowsJob.instances.clear()
    monkeypatch.setattr(workflow_module, "_IS_WINDOWS", True)
    monkeypatch.setattr(workflow_module, "_WindowsJob", _FakeWindowsJob)
    monkeypatch.setattr(workflow_module.subprocess, "Popen", _FakeWindowsProc)

    proc = _spawn(["scientific.exe", "--exact-arg"], {})

    job = _FakeWindowsJob.instances[-1]
    gate = proc.stdin
    assert proc.command[:5] == [
        sys.executable,
        "-I",
        "-S",
        "-c",
        workflow_module._WINDOWS_EXEC_GATE,
    ]
    assert proc.command[5:] == ["scientific.exe", "--exact-arg"]
    assert job.assigned is proc
    assert gate.writes == []

    _release_spawn(proc)

    assert gate.writes == ["1"]
    assert gate.closed is True
    assert proc.stdin is None


def test_frozen_windows_uses_packaged_exec_gate_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _FakeWindowsJob.instances.clear()
    monkeypatch.setattr(workflow_module, "_IS_WINDOWS", True)
    monkeypatch.setattr(workflow_module.sys, "frozen", True, raising=False)
    monkeypatch.setattr(workflow_module, "_WindowsJob", _FakeWindowsJob)
    monkeypatch.setattr(workflow_module.subprocess, "Popen", _FakeWindowsProc)

    proc = _spawn(["scientific.exe", "--exact-arg"], {})

    assert proc.command == [
        sys.executable,
        workflow_module._FROZEN_EXEC_GATE_ARG,
        "scientific.exe",
        "--exact-arg",
    ]
    assert _FakeWindowsJob.instances[-1].assigned is proc
    assert proc.stdin.writes == []


def test_frozen_entry_dispatch_precedes_sidecar_package_import() -> None:
    entry = Path(workflow_module.__file__).parents[1] / "pyinstaller_entry.py"
    tree = ast.parse(entry.read_text(encoding="utf-8"))
    package_import_index = next(
        index
        for index, statement in enumerate(tree.body)
        if isinstance(statement, ast.ImportFrom)
        and statement.module == "supraspina_sidecar.__main__"
    )
    imports_before_dispatch = [
        alias.name
        for statement in tree.body[:package_import_index]
        if isinstance(statement, ast.Import)
        for alias in statement.names
    ]

    assert imports_before_dispatch == ["os", "sys"]
    assert any(
        isinstance(statement, ast.If)
        and "_EXEC_GATE_ARG" in ast.unparse(statement.test)
        for statement in tree.body[:package_import_index]
    )


def test_frozen_build_avoids_onefile_bootloader_ownership_race() -> None:
    project_root = Path(workflow_module.__file__).parents[2]
    spec = (project_root / "sidecar" / "supraspina-sidecar.spec").read_text(
        encoding="utf-8"
    )

    assert "bundle = COLLECT(" in spec
    assert 'contents_directory="supraspina-runtime"' in spec
    assert "EXE(" in spec


def test_packaged_entry_gate_blocks_then_executes_exact_child(tmp_path: Path) -> None:
    entry = Path(workflow_module.__file__).parents[1] / "pyinstaller_entry.py"
    marker = tmp_path / "packaged-gate-child.txt"
    expected = "exact child argument\n--not-json-rpc"
    child = [
        sys.executable,
        "-I",
        "-S",
        "-c",
        (
            "import pathlib,sys; "
            "pathlib.Path(sys.argv[1]).write_text("
            "'\\n'.join(sys.argv[2:]),encoding='utf-8')"
        ),
        str(marker),
        "exact child argument",
        "--not-json-rpc",
    ]
    proc = subprocess.Popen(  # noqa: S603
        [
            sys.executable,
            str(entry),
            workflow_module._FROZEN_EXEC_GATE_ARG,
            *child,
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        with pytest.raises(subprocess.TimeoutExpired):
            proc.wait(timeout=0.25)
        assert marker.exists() is False
        assert proc.stdin is not None

        proc.stdin.write(b"1")
        proc.stdin.close()
        proc.stdin = None
        stdout, stderr = proc.communicate(timeout=5)

        assert proc.returncode == 0
        assert marker.read_text(encoding="utf-8") == expected
        assert stdout == b""
        assert stderr == b""
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)


def test_windows_job_termination_and_settlement_cover_descendants() -> None:
    proc = _FakeWindowsProc(["gate"])
    job = _FakeWindowsJob()
    proc._supraspina_job = job
    proc._supraspina_gate_stream = proc.stdin

    _terminate_tree(proc)
    proved = _settle_group(proc, proc.pid)

    assert job.terminations >= 2
    assert job.closed is True
    assert proc._supraspina_job is None
    assert proved is True


def test_failed_windows_settlement_retains_job_ownership() -> None:
    proc = _FakeWindowsProc(["gate"])
    job = _FakeWindowsJob()
    proc._supraspina_job = job
    proc._supraspina_gate_stream = proc.stdin

    def fail_accounting() -> int:
        raise OSError("Treat job accounting as unavailable.")

    job.active_processes = fail_accounting  # type: ignore[method-assign]

    proved = _settle_group(proc, proc.pid)

    assert proved is False
    assert job.closed is False
    assert proc._supraspina_job is job


def test_process_identity_helpers_fail_closed_and_dispatch_by_platform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stat_fields = " ".join(["0"] * 20)

    def identity_open(path: str, **_kwargs: Any) -> io.StringIO:
        if path.endswith("boot_id"):
            return io.StringIO("")
        return io.StringIO(f"123 (scientific worker) S {stat_fields}")

    monkeypatch.setattr(workflow_module, "open", identity_open, raising=False)
    assert _linux_process_identity(123) == ("unknown", None)

    results = iter(
        [
            SimpleNamespace(returncode=1, stdout=""),
            SimpleNamespace(returncode=0, stdout=""),
            SimpleNamespace(returncode=0, stdout="Thu Jul 23 12:00:00 2026\n"),
        ]
    )
    monkeypatch.setattr(
        workflow_module.subprocess,
        "run",
        lambda *_args, **_kwargs: next(results),
    )
    assert _posix_process_identity(123) == ("dead", None)
    assert _posix_process_identity(123) == ("dead", None)
    assert _posix_process_identity(123) == (
        "alive",
        f"{workflow_module.sys.platform}:Thu Jul 23 12:00:00 2026",
    )

    assert _process_start_identity(1) == ("unknown", None)
    monkeypatch.setattr(workflow_module.sys, "platform", "darwin")
    monkeypatch.setattr(workflow_module.os, "name", "nt")
    monkeypatch.setattr(
        workflow_module,
        "_windows_process_identity",
        lambda pid, proc=None: ("alive", f"windows:{pid}:{proc}"),
    )
    assert _process_start_identity(22, "proc") == ("alive", "windows:22:proc")
    monkeypatch.setattr(workflow_module.os, "name", "posix")
    monkeypatch.setattr(
        workflow_module,
        "_posix_process_identity",
        lambda pid: ("alive", f"darwin:{pid}"),
    )
    assert _process_start_identity(23) == ("alive", "darwin:23")
    assert _process_group_state(1) == "unknown"


def test_process_identity_syntax_accepts_only_the_active_platform_scheme(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert workflow_module._process_start_identity_syntax_valid(None) is False
    assert workflow_module._process_start_identity_syntax_valid("linux:boot:1") is True

    monkeypatch.setattr(workflow_module.sys, "platform", "darwin")
    monkeypatch.setattr(workflow_module.os, "name", "nt")
    assert workflow_module._process_start_identity_syntax_valid("windows:1") is True

    monkeypatch.setattr(workflow_module.os, "name", "posix")
    assert (
        workflow_module._process_start_identity_syntax_valid(
            "darwin:Thu Jul 23 12:00:00 2026"
        )
        is True
    )


def test_windows_process_identity_reads_an_existing_query_handle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert workflow_module._windows_process_identity(22) == ("unknown", None)

    def record_creation_time(
        _handle: object,
        creation: object,
        _exit_time: object,
        _kernel_time: object,
        _user_time: object,
    ) -> int:
        creation._obj.dwLowDateTime = 7  # type: ignore[attr-defined]
        creation._obj.dwHighDateTime = 2  # type: ignore[attr-defined]
        return 1

    kernel32 = SimpleNamespace(
        CloseHandle=Mock(return_value=1),
        GetProcessTimes=Mock(side_effect=record_creation_time),
    )
    monkeypatch.setattr(workflow_module.os, "name", "nt")
    monkeypatch.setattr(
        workflow_module.ctypes,
        "WinDLL",
        lambda *_args, **_kwargs: kernel32,
        raising=False,
    )

    assert workflow_module._windows_process_identity(
        22, SimpleNamespace(_handle=99)
    ) == ("alive", f"windows:{(2 << 32) | 7}")
    kernel32.CloseHandle.assert_not_called()


def test_windows_job_settlement_covers_idle_and_lingering_accounting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    idle_proc = _FakeWindowsProc(["gate"])
    idle_job = _FakeWindowsJob()
    idle_job.active = [0]
    idle_proc._supraspina_job = idle_job
    assert _settle_group(idle_proc, idle_proc.pid) is True
    assert idle_job.terminations == 0
    assert idle_job.closed is True

    lingering_proc = _FakeWindowsProc(["gate"])
    lingering_job = _FakeWindowsJob()
    lingering_job.active = [1, 1, 1]
    lingering_proc._supraspina_job = lingering_job
    clock = iter([0.0, 0.1, 3.0])
    monkeypatch.setattr(
        workflow_module.time,
        "monotonic",
        lambda: next(clock),
    )
    monkeypatch.setattr(workflow_module.time, "sleep", lambda _delay: None)

    assert _settle_group(lingering_proc, lingering_proc.pid) is False
    assert lingering_job.terminations == 2
    assert lingering_job.closed is False
    assert lingering_proc._supraspina_job is lingering_job


def test_settlement_fails_closed_when_the_group_refuses_the_signal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if os.name == "nt":  # pragma: no cover - POSIX-only ownership contract
        pytest.skip("Exercise the POSIX process-group path.")
    proc = SimpleNamespace(pid=4242, _supraspina_pgid=4242, poll=lambda: None)

    def refuse(_pgid: int, _sig: int) -> None:
        raise PermissionError("Refuse to signal a foreign process group.")

    monkeypatch.setattr(workflow_module.os, "killpg", refuse)

    assert _settle_group(proc, 4242) is False


def test_unknown_process_group_is_never_proof_of_settlement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if os.name == "nt":  # pragma: no cover - POSIX-only ownership contract
        pytest.skip("Exercise the POSIX process-group path.")
    signalled: list[tuple[int, int]] = []
    monkeypatch.setattr(
        workflow_module.os, "killpg", lambda pgid, sig: signalled.append((pgid, sig))
    )
    absent = SimpleNamespace(pid=4242, _supraspina_pgid=None, poll=lambda: 0)
    never_grouped = SimpleNamespace(pid=None, poll=lambda: 0)
    leader_group = SimpleNamespace(pid=1, _supraspina_pgid=1, poll=lambda: 0)

    assert _settle_group(absent, None) is False
    assert _settle_group(never_grouped, None) is False
    assert _settle_group(leader_group, 1) is False
    assert signalled == []


def test_unreadable_group_evidence_stays_unknown_without_signalling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if os.name == "nt":  # pragma: no cover - POSIX-only ownership contract
        pytest.skip("Exercise the POSIX process-group path.")
    signalled: list[tuple[int, int]] = []

    def probe(pgid: int, sig: int) -> None:
        if sig == 0:
            raise PermissionError("Deny the group probe.")
        signalled.append((pgid, sig))

    monkeypatch.setattr(workflow_module.os, "killpg", probe)
    proc = SimpleNamespace(pid=4242, _supraspina_pgid=4242, poll=lambda: None)

    assert _process_group_state(4242) == "unknown"
    assert _settle_group(proc, 4242) is False
    assert signalled == []


def test_exited_leader_with_live_descendants_is_not_settled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep a group with surviving descendants unsettled when it cannot be killed."""
    if os.name == "nt":  # pragma: no cover - POSIX-only ownership contract
        pytest.skip("Exercise the POSIX process-group path.")
    monkeypatch.setattr(workflow_module, "_process_group_state", lambda _pgid: "alive")

    def refuse(_pgid: int, _sig: int) -> None:
        raise PermissionError("Refuse to signal the surviving descendants.")

    monkeypatch.setattr(workflow_module.os, "killpg", refuse)
    exited_leader = SimpleNamespace(pid=4242, _supraspina_pgid=4242, poll=lambda: 0)

    assert _settle_group(exited_leader, 4242) is False


def test_settled_group_reports_proved_and_clears_the_recorded_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if os.name == "nt":  # pragma: no cover - POSIX-only ownership contract
        pytest.skip("Exercise the POSIX process-group path.")
    signalled: list[tuple[int, int]] = []
    monkeypatch.setattr(
        workflow_module.os,
        "killpg",
        lambda pgid, sig: (
            signalled.append((pgid, sig))
            if sig != 0
            else (_ for _ in ()).throw(ProcessLookupError())
        ),
    )
    proc = SimpleNamespace(pid=4242, _supraspina_pgid=4242, poll=lambda: 0)

    assert _settle_group(proc, 4242) is True
    assert proc._supraspina_pgid is None
    assert signalled == []


def test_settlement_never_rederives_a_group_from_a_reaped_pid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Refuse to look a group up from a PID the kernel may have reused."""
    if os.name == "nt":  # pragma: no cover - POSIX-only ownership contract
        pytest.skip("Exercise the POSIX process-group path.")
    lookups: list[int] = []
    monkeypatch.setattr(
        workflow_module.os,
        "getpgid",
        lambda pid: lookups.append(pid) or 4242,  # type: ignore[func-returns-value]
    )
    monkeypatch.setattr(workflow_module, "_process_group_state", lambda _pgid: "dead")
    reaped = SimpleNamespace(pid=4242, _supraspina_pgid=None, poll=lambda: 0)

    assert _settle_group(reaped, None) is False
    assert lookups == []
