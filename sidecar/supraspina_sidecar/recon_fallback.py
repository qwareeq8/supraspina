"""FreeSurfer reconstruction failures Supraspina reads from recon-all output.

This module sits outside the stage adapters on purpose: every receipt binds
the adapter source files by content hash, so a change there would put every
existing Reconstruction receipt out of date. Two things live here:

* The known recon-all failures, each with the recon-all flag that avoids it
  (:data:`KNOWN_FAILURES`). ``label-cortex --fix-ga`` fills the gyrus ambiens
  in the cortex label, and on some scans it finds no voxels to fill and stops
  recon-all with "ERROR: found no voxels matching id 1"; FreeSurfer then
  advises a rerun with ``-no-fix-ga``, which skips that fill. On some scans
  ``mris_fix_topology -ga``, the genetic-algorithm topology fixer, crashes
  ("stack smashing detected", Aborted) in the same place on every seed, while
  the non-genetic fixer that ``-no-fix-with-ga`` selects completes. The
  launcher reruns the subject once per known failure with its flag appended,
  keeping the flags of earlier reruns, and records the reruns on the job and
  in the receipt record, outside the signed payload, so the receipt still
  matches the plan's bound command.
* The failure cause. recon-all ends every failure with "recon-all -s ID
  exited with ERRORS at ...", which the adapter reports when nothing more
  specific matches. :func:`failure_cause` states the failing tool and its
  ERROR line instead, for display beside the recorded reason.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Collection, Iterable, Sequence
from dataclasses import dataclass
from typing import Any

NO_FIX_GA_FLAG = "-no-fix-ga"
NO_FIX_GA_KIND = "freesurfer-no-fix-ga"
NO_FIX_WITH_GA_FLAG = "-no-fix-with-ga"
NO_FIX_WITH_GA_KIND = "freesurfer-no-fix-with-ga"

#: The recon-all log bytes read for detection, counted from the end. With the
#: launcher's last 400 output lines, this is all detection sees: a crash whose
#: step header or ``-ga`` command lies outside both windows is not recognized,
#: and the subject fails as it would without the rerun.
_LOG_TAIL_BYTES = 256 * 1024
#: The longest cause stated, well inside the renderer's message bound.
_CAUSE_CHARS = 512

# The label-cortex error itself, as its own ERROR line. FreeSurfer's hint line
# ("If the error is: found no voxels matching id 1, try rerunning with
# -no-fix-ga") quotes the same words, so the error must open its line.
_NO_ID1_VOXELS_ERROR = re.compile(
    r"^\s*ERROR:?\s*found\s+no\s+voxels\s+matching\s+id\s+1(?!\d)",
    re.IGNORECASE | re.MULTILINE,
)
_NO_FIX_GA_HINT = re.compile(
    r"try\s+rerunning\s+with\s+-no-fix-ga", re.IGNORECASE | re.MULTILINE
)
_LABEL_CORTEX = re.compile(r"\blabel-cortex\b", re.IGNORECASE)

_ERROR_LINE = re.compile(r"^\s*ERROR:?\s+(?P<text>\S.*?)\s*$")
_FSTIME = re.compile(r"^@#@FSTIME\s+\S+\s+(?P<tool>\S+)\s+N\b")
# A FreeSurfer tool invocation: a lowercase name joined by an underscore or a
# hyphen (mri_convert, mris_make_surfaces, label-cortex), then an argument.
_COMMAND_LINE = re.compile(
    r"^\s*(?:\S*/)?(?P<tool>[a-z][a-z0-9]*(?:[_-][a-z0-9.]+)+)\s+\S"
)
_STEP_HEADER = re.compile(r"^#@#\s+(?P<step>.+?)(?:\s+\w{3}\s+\w{3}\s+\d+\s.*)?$")
_NOT_A_TOOL = frozenset({"recon-all", "fs_time"})
# A tool killed by a signal leaves no ERROR line, only the shell's job status,
# for example reconbatchjobs' "line 77: 3239019 Aborted (core dumped) exec ...",
# which may name the job after the status, or a bare "Aborted (core dumped)".
# The bare form must end its line, so prose such as "Aborted by user request"
# does not read as a crash.
_SIGNAL = r"(?P<signal>Aborted|Segmentation fault|Bus error|Killed)"
_CORE = r"(?:\s+(?P<core>\(core dumped\)))?"
_JOB_STATUS_LINE = re.compile(
    r"^\S+:\s+line\s+\d+:\s+\d+\s+" + _SIGNAL + _CORE + r"(?:\s+\S.*)?$"
)
_BARE_CRASH_LINE = re.compile(r"^" + _SIGNAL + _CORE + r"$")
# glibc's own report before it aborts a process, for example
# "*** stack smashing detected ***: terminated".
_FATAL_LINE = re.compile(r"^\*\*\*\s*(?P<text>[^*]*?\S)\s*\*\*\*:?\s*terminated\b")
#: The signals that mark a topology-fix crash; Killed is usually the kernel's
#: out-of-memory handling, which another fixer does not avoid.
_TOPOLOGY_CRASH_SIGNALS = frozenset({"Aborted", "Segmentation fault"})
_FIX_TOPOLOGY_STEP = re.compile(r"^#@#\s+Fix\s+Topology\b", re.IGNORECASE)
# The lines that report mris_fix_topology finished: fs_time's line in a serial
# run, and the tool's own closing lines, which a -parallel run keeps instead.
_TOPOLOGY_FIX_DONE = re.compile(
    r"^(?:@#@FSTIME\s+\S+\s+mris_fix_topology\s+N\b"
    r"|FSRUNTIME@\s+mris_fix_topology\b"
    r"|topology\s+fixing\s+took\b)"
)


@dataclass(frozen=True)
class LogMark:
    """Where recon-all.log ended before an attempt, to read only its output."""

    path: str
    inode: int | None
    size: int


def _flag_value(argv: Sequence[str], flags: Iterable[str]) -> str | None:
    names = set(flags)
    for index, value in enumerate(argv[:-1]):
        if value in names:
            return argv[index + 1]
    return None


def is_freesurfer_recon(argv: Sequence[str]) -> bool:
    """Report whether an argv launches FreeSurfer recon-all."""
    return bool(argv) and os.path.basename(str(argv[0])) == "recon-all"


def recon_log_path(argv: Sequence[str]) -> str | None:
    """Return the subject's scripts/recon-all.log named by a recon-all argv."""
    subjects_dir = _flag_value(argv, ("-sd",))
    subject = _flag_value(argv, ("-subject", "-s", "-sid", "-subjid"))
    if not subjects_dir or not subject:
        return None
    return os.path.join(subjects_dir, subject, "scripts", "recon-all.log")


def mark_recon_log(argv: Sequence[str]) -> LogMark | None:
    """Record recon-all.log's identity and size before an attempt starts.

    recon-all appends each invocation to the same log, so detection reads
    only what the attempt added after this mark.
    """
    path = recon_log_path(argv)
    if path is None:
        return None
    try:
        info = os.stat(path)
    except OSError:
        return LogMark(path=path, inode=None, size=0)
    return LogMark(path=path, inode=info.st_ino, size=info.st_size)


def read_recon_log_since(mark: LogMark | None) -> str:
    """Return the bounded recon-all.log text written since ``mark``."""
    if mark is None:
        return ""
    try:
        with open(mark.path, "rb") as handle:
            info = os.fstat(handle.fileno())
            start = (
                mark.size
                if mark.inode == info.st_ino and info.st_size >= mark.size
                else 0
            )
            start = max(start, info.st_size - _LOG_TAIL_BYTES)
            handle.seek(start)
            data = handle.read(_LOG_TAIL_BYTES)
    except OSError:
        return ""
    return data.decode("utf-8", "replace")


def needs_no_fix_ga(output: str) -> bool:
    """Report whether recon-all stopped because label-cortex found no id-1 voxels.

    Require the ERROR line itself, plus either FreeSurfer's own advice to
    rerun with ``-no-fix-ga`` or the label-cortex step that prints it. The
    hint alone does not qualify: recon-all words it as a condition on the
    error, so it can accompany a different failure.
    """
    if not _NO_ID1_VOXELS_ERROR.search(output):
        return False
    return bool(_NO_FIX_GA_HINT.search(output) or _LABEL_CORTEX.search(output))


def _crash_match(line: str) -> re.Match[str] | None:
    return _JOB_STATUS_LINE.match(line) or _BARE_CRASH_LINE.match(line)


def _crash_index(lines: Sequence[str], signals: Collection[str]) -> int | None:
    # The last line that reports a tool killed by one of ``signals``, or
    # glibc's own report before it aborts the process.
    for index in range(len(lines) - 1, -1, -1):
        line = lines[index].strip()
        if _FATAL_LINE.match(line):
            return index
        crash = _crash_match(line)
        if crash is not None and crash.group("signal") in signals:
            return index
    return None


def crashed_in_genetic_topology_fix(output: str) -> bool:
    """Report whether ``mris_fix_topology -ga`` crashed and stopped recon-all.

    Require a crash (a glibc abort report, or an Aborted or Segmentation fault
    job status) inside the ``#@# Fix Topology`` step that belongs to
    ``mris_fix_topology`` with the genetic fixer (``-ga``): the nearest tool
    command before the crash is that command, and no line between them reports
    that it finished. Nothing after the crash may name another failure: no
    ERROR line and no later step.

    In a ``-parallel`` run, recon-all echoes both hemispheres' commands, and
    reconbatchjobs reports the aborted job, then appends each job's log, which
    opens with its own command. The last crash line is then glibc's report in
    the crashed hemisphere's log, after that hemisphere's command.
    """
    lines = output.splitlines()
    crash = _crash_index(lines, _TOPOLOGY_CRASH_SIGNALS)
    if crash is None:
        return False
    for line in lines[crash + 1 :]:
        stripped = line.strip()
        if _ERROR_LINE.match(stripped):
            return False
        if stripped.startswith("#@#") and not _FIX_TOPOLOGY_STEP.match(stripped):
            return False
    step = next(
        (line.strip() for line in reversed(lines[:crash]) if line.startswith("#@#")),
        None,
    )
    if step is None or not _FIX_TOPOLOGY_STEP.match(step):
        return False
    return _genetic_fix_running_at(lines, crash)


def _genetic_fix_running_at(lines: Sequence[str], index: int) -> bool:
    # The nearest tool command before ``index`` is mris_fix_topology -ga, and
    # no line between them reports that it finished.
    for line in reversed(lines[:index]):
        if _TOPOLOGY_FIX_DONE.match(line.strip()):
            return False
        command = _COMMAND_LINE.match(line)
        if command is not None and command.group("tool") not in _NOT_A_TOOL:
            tool = command.group("tool")
            return tool == "mris_fix_topology" and "-ga" in line.split()
    return False


@dataclass(frozen=True)
class KnownFailure:
    """A recon-all failure Supraspina recognizes, and the flag that avoids it."""

    kind: str
    flag: str
    detect: Callable[[str], bool]
    #: What the attempt showed, stated before "; the reconstruction reruns".
    finding: str
    reason: str


#: The known recon-all failures, in the order detection tries them. Each one
#: reruns a subject at most once, so a job runs at most one more attempt than
#: this table has rows.
KNOWN_FAILURES: tuple[KnownFailure, ...] = (
    KnownFailure(
        kind=NO_FIX_GA_KIND,
        flag=NO_FIX_GA_FLAG,
        detect=needs_no_fix_ga,
        finding="found no gyrus ambiens voxels",
        reason=(
            "label-cortex found no voxels matching id 1 while filling the gyrus "
            "ambiens (--fix-ga), so recon-all reran with -no-fix-ga, as "
            "FreeSurfer advises."
        ),
    ),
    KnownFailure(
        kind=NO_FIX_WITH_GA_KIND,
        flag=NO_FIX_WITH_GA_FLAG,
        detect=crashed_in_genetic_topology_fix,
        finding=("stopped in the surface topology fix (mris_fix_topology crashed)"),
        reason=(
            "mris_fix_topology crashed in the genetic surface topology fix "
            "(-ga), so recon-all reran with -no-fix-with-ga, which uses the "
            "non-genetic topology fixer."
        ),
    ),
)


@dataclass(frozen=True)
class Rerun:
    """One rerun: the failure an attempt showed and that attempt's exit code."""

    failure: KnownFailure
    exit_code: int


def known_failure(output: str, applied: Collection[str] = ()) -> KnownFailure | None:
    """Return the first known failure in ``output`` whose flag is not applied."""
    for failure in KNOWN_FAILURES:
        if failure.flag not in applied and failure.detect(output):
            return failure
    return None


def rerun_argv(argv: Sequence[str], flags: Sequence[str]) -> list[str] | None:
    """Return the rerun argv with ``flags`` appended, or None when not allowed.

    Only a FreeSurfer recon-all argv qualifies, and each flag only once: an
    argv that already carries one of them does not rerun.
    """
    if not flags or not is_freesurfer_recon(argv) or any(f in argv for f in flags):
        return None
    if len(set(flags)) != len(flags):
        return None
    return [*argv, *flags]


def _flag_list(flags: Sequence[str]) -> str:
    if len(flags) <= 1:
        return "".join(flags)
    return f"{', '.join(flags[:-1])} and {flags[-1]}"


def fallback_log_line(subject_id: str | None, reruns: Sequence[Rerun]) -> str:
    """Return the factual log line written when the latest rerun starts."""
    subject = subject_id or "the cohort"
    flags = [rerun.failure.flag for rerun in reruns]
    return (
        f"recon-all for {subject} {reruns[-1].failure.finding}; the "
        f"reconstruction reruns with {_flag_list(flags)}."
    )


def fallback_record(reruns: Sequence[Rerun]) -> dict[str, Any]:
    """Return the fallback record kept on the job and in the receipt record.

    A single rerun keeps the original four-field shape. Composed reruns add
    ``reruns``, one entry per rerun in order, and the top-level fields
    summarize them: the joined kinds, every added argument, the reasons in
    order, and the first attempt's exit code.
    """
    if not reruns:
        raise ValueError("A fallback record needs at least one rerun.")
    if len(reruns) == 1:
        (rerun,) = reruns
        return {
            "kind": rerun.failure.kind,
            "addedArguments": [rerun.failure.flag],
            "reason": rerun.failure.reason,
            "firstAttemptExitCode": rerun.exit_code,
        }
    return {
        "kind": "+".join(rerun.failure.kind for rerun in reruns),
        "addedArguments": [rerun.failure.flag for rerun in reruns],
        "reason": " ".join(rerun.failure.reason for rerun in reruns),
        "firstAttemptExitCode": reruns[0].exit_code,
        "reruns": [
            {
                "kind": rerun.failure.kind,
                "addedArguments": [rerun.failure.flag],
                "reason": rerun.failure.reason,
                "attemptExitCode": rerun.exit_code,
            }
            for rerun in reruns
        ],
    }


def _tool_for_error(lines: Sequence[str], error_index: int) -> str | None:
    # fs_time reports the tool that just ended after its output.
    for line in lines[error_index + 1 :]:
        timing = _FSTIME.match(line)
        if timing is not None and timing.group("tool") not in _NOT_A_TOOL:
            return timing.group("tool")
    return _tool_before(lines, error_index)


def _tool_before(lines: Sequence[str], index: int) -> str | None:
    # A crashed tool reports no fs_time line, so only earlier lines name it.
    for line in reversed(lines[:index]):
        command = _COMMAND_LINE.match(line)
        if command is not None and command.group("tool") not in _NOT_A_TOOL:
            return command.group("tool")
    for line in reversed(lines[:index]):
        header = _STEP_HEADER.match(line.strip())
        if header is not None:
            return header.group("step")
    return None


def _bounded(cause: str) -> str:
    return cause if len(cause) <= _CAUSE_CHARS else cause[: _CAUSE_CHARS - 3] + "..."


def failure_cause(output: str) -> str | None:
    """State recon-all's failing tool and its last ERROR line.

    Return, for example, "label-cortex failed: found no voxels matching id
    1". Without an ERROR line, a tool killed by a signal reads, for example,
    "mris_fix_topology failed: Aborted (core dumped)", or with glibc's report
    "mris_fix_topology failed: stack smashing detected (Aborted, core
    dumped)". Return None when the output has neither.
    """
    lines = output.splitlines()
    for index in range(len(lines) - 1, -1, -1):
        match = _ERROR_LINE.match(lines[index])
        if match is None:
            continue
        text = match.group("text").replace("\0", "").rstrip(".")
        if not text:
            continue
        tool = _tool_for_error(lines, index) or "recon-all"
        return _bounded(f"{tool} failed: {text}")
    status_index = fatal_index = None
    for index in range(len(lines) - 1, -1, -1):
        line = lines[index].strip()
        if status_index is None and _crash_match(line):
            status_index = index
        if fatal_index is None and _FATAL_LINE.match(line):
            fatal_index = index
    if status_index is None and fatal_index is None:
        return None
    # recon-all.log can carry glibc's report before or after the job status,
    # and the job status follows the command it ended.
    crash = None if status_index is None else _crash_match(lines[status_index].strip())
    fatal = (
        None if fatal_index is None else _FATAL_LINE.match(lines[fatal_index].strip())
    )
    status = None if crash is None else crash.group("signal")
    core = crash is not None and crash.group("core") is not None
    detail = None if fatal is None else fatal.group("text")
    if detail is None:
        text = f"{status} (core dumped)" if core else str(status)
    elif status is None:
        text = detail
    else:
        text = f"{detail} ({status}, core dumped)" if core else f"{detail} ({status})"
    anchor = status_index if status_index is not None else fatal_index
    tool = _tool_before(lines, anchor) or "recon-all"
    return _bounded(f"{tool} failed: {text}")
