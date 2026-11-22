"""Subprocess helpers shared across adapters.

Executable lookup and subprocess execution are centralized here. :func:`which`
resolves commands, :func:`run` executes them, :func:`run_streamed` executes a
long command whose output an operator watches, and :func:`exists` and
:func:`file_nonempty` cover presence-only checks.
"""

from __future__ import annotations

import csv
import io
import os
import shutil
import subprocess
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..bounded_io import BoundedReadError, read_regular_prefix

#: Wait at most this long for one output reader to drain a closed pipe.
_READER_JOIN_SECONDS = 5.0


@dataclass
class RunResult:
    """Represent the captured outcome of a subprocess run."""

    rc: int
    stdout: str
    stderr: str


def which(name: str) -> str | None:
    """Return the absolute path to an executable on PATH, or ``None``."""
    return shutil.which(name)


def _same_executable(left: str, right: str) -> bool:
    """Return whether two executable paths identify the same file."""
    left_path = which(left) if not os.path.dirname(left) else left
    right_path = which(right) if not os.path.dirname(right) else right
    normalized_left = os.path.normcase(os.path.realpath(left_path or left))
    normalized_right = os.path.normcase(os.path.realpath(right_path or right))
    return normalized_left == normalized_right


def python_interpreter(
    configured: str | None = None,
    *,
    fallback: bool = True,
) -> str | None:
    """Resolve a general Python interpreter without selecting a frozen sidecar.

    Reject a PyInstaller sidecar executable because it does not implement
    Python's ``-c`` or script-file command line. Use a configured interpreter
    in a frozen process only when it is distinct from the sidecar, then prefer
    the host's ``python3`` over ``python``. Continue to use the active
    interpreter for source runs.

    Parameters
    ----------
    fallback
        Choose whether to search for a general interpreter when ``configured`` is
        absent or resolves to the frozen sidecar executable.

    Returns
    -------
    str or None
        Return the configured, active, or PATH-resolved interpreter, or ``None`` when
        a frozen build has no host Python available.
    """
    frozen = bool(getattr(sys, "frozen", False))
    frozen_sidecar = str(sys.executable or "") if frozen else ""
    if configured and not (
        frozen_sidecar and _same_executable(configured, frozen_sidecar)
    ):
        return configured
    if not fallback:
        return None
    if not frozen and sys.executable:
        return sys.executable
    return which("python3") or which("python")


def _not_found(argv0: str) -> RunResult:
    """Return the shared result for a command that does not exist."""
    return RunResult(rc=127, stdout="", stderr=f"not found: {argv0}")


def _timed_out(timeout: float | None) -> RunResult:
    """Return the shared result for a command stopped at its timeout."""
    return RunResult(rc=124, stdout="", stderr=f"timeout after {timeout}s")


def _not_executable(argv0: str, exc: OSError) -> RunResult:
    """Return the shared result for a present but unusable program.

    Report a present but unusable interpreter as a failed probe so one invalid
    configured path cannot collapse a whole check group.
    """
    return RunResult(rc=126, stdout="", stderr=f"not executable: {argv0}: {exc}")


def run(
    argv: list[str],
    *,
    timeout: float | None = None,
    env: dict[str, str] | None = None,
    cwd: str | None = None,
) -> RunResult:
    """Run a command and capture its output.

    Parameters
    ----------
    argv
        Provide the argument vector without a shell string or ``shell=True``.
    timeout
        Provide an optional timeout in seconds.
    env
        Provide optional overrides to merge onto the current environment.
    """
    merged = {**os.environ, **(env or {})}
    try:
        proc = subprocess.run(  # noqa: S603 - Pass a fixed argv list without a shell.
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=merged,
            cwd=cwd,
            check=False,
        )
    except FileNotFoundError:
        return _not_found(argv[0])
    except subprocess.TimeoutExpired:
        return _timed_out(timeout)
    except OSError as exc:
        return _not_executable(argv[0], exc)
    return RunResult(rc=proc.returncode, stdout=proc.stdout, stderr=proc.stderr)


def _drain(
    stream: Any,
    sink: list[str],
    on_output: Callable[[str], None] | None,
) -> None:
    """Read one text stream to end, collecting and publishing each line."""
    try:
        for line in stream:
            sink.append(line)
            if on_output is not None:
                on_output(line)
    except (OSError, ValueError):
        pass  # Treat a closed or broken pipe as end of output.
    finally:
        try:
            stream.close()
        except OSError:
            pass


def run_streamed(
    argv: list[str],
    *,
    timeout: float | None = None,
    env: dict[str, str] | None = None,
    cwd: str | None = None,
    on_output: Callable[[str], None] | None = None,
) -> RunResult:
    """Run a command, publishing each output line while it still runs.

    Match :func:`run` in argv handling, environment merging, timeout meaning,
    and the return codes reported for a missing program (127), a timeout
    (124), and an unusable program (126). Prefer this variant only for a long
    command whose progress an operator watches, because it costs one reader
    thread per output stream. Never let a publisher failure stop the read:
    ``on_output`` must not raise.

    Parameters
    ----------
    argv
        Provide the argument vector without a shell string or ``shell=True``.
    timeout
        Provide an optional timeout in seconds, after which the process tree
        entry point is killed.
    env
        Provide optional overrides to merge onto the current environment.
    on_output
        Provide an optional publisher called with each stdout and stderr line
        in arrival order.

    Returns
    -------
    RunResult
        Return the exit code and the complete captured stdout and stderr.
    """
    merged = {**os.environ, **(env or {})}
    try:
        proc = subprocess.Popen(  # noqa: S603 - Pass a fixed argv list without a shell.
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=merged,
            cwd=cwd,
        )
    except FileNotFoundError:
        return _not_found(argv[0])
    except OSError as exc:
        return _not_executable(argv[0], exc)
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []
    readers = [
        threading.Thread(
            target=_drain,
            args=(stream, sink, on_output),
            daemon=True,
            name=f"run-streamed-{name}",
        )
        for name, stream, sink in (
            ("stdout", proc.stdout, stdout_lines),
            ("stderr", proc.stderr, stderr_lines),
        )
        if stream is not None
    ]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.kill()
        proc.wait()
    for reader in readers:
        reader.join(_READER_JOIN_SECONDS)
    if timed_out:
        return _timed_out(timeout)
    return RunResult(
        rc=int(proc.returncode or 0),
        stdout="".join(stdout_lines),
        stderr="".join(stderr_lines),
    )


def exists(path: str) -> bool:
    """Return whether a path exists."""
    return os.path.exists(path)


#: Read at most this many bytes of a cohort table when recovering its members.
MEMBER_TABLE_MAX_BYTES = 8 * 1024 * 1024
#: Accept at most this many member rows in one cohort table.
MEMBER_TABLE_MAX_ROWS = 5000


def read_csv_member_ids(
    path: str,
    id_column: str,
    *,
    max_bytes: int = MEMBER_TABLE_MAX_BYTES,
    max_rows: int = MEMBER_TABLE_MAX_ROWS,
) -> frozenset[str] | None:
    """Return the subject ids one cohort table lists under ``id_column``.

    Read a bounded prefix of the CSV, locate ``id_column`` in the header, and
    collect the non-blank values of that column. Return ``None`` when the file
    is absent, unreadable, larger than ``max_bytes``, lacks the column, or
    holds more than ``max_rows`` rows, so a caller treats membership as unknown
    rather than empty.
    """
    if not file_nonempty(path):
        return None
    try:
        payload, _size, truncated = read_regular_prefix(path, max_bytes)
        text = payload.decode("utf-8-sig")
    except (OSError, BoundedReadError, ValueError, UnicodeError):
        return None
    if truncated:
        return None
    return _member_column(
        csv.reader(io.StringIO(text, newline="")), id_column, max_rows
    )


def _member_column(reader: Any, id_column: str, max_rows: int) -> frozenset[str] | None:
    """Collect the non-blank values of ``id_column`` from a parsed CSV."""
    try:
        header = next(reader)
        if id_column not in header:
            return None
        column = header.index(id_column)
        members: set[str] = set()
        for rows, row in enumerate(reader, start=1):
            if rows > max_rows:
                return None
            if column < len(row) and row[column].strip():
                members.add(row[column].strip())
    except (StopIteration, csv.Error):
        return None
    return frozenset(members)


def file_nonempty(path: str) -> bool:
    """Return whether a path is a regular, non-empty, readable file.

    Use this for presence-only checks such as the FreeSurfer license. Never open,
    read, hash, or copy the file.
    """
    return (
        os.path.isfile(path) and os.access(path, os.R_OK) and os.path.getsize(path) > 0
    )
