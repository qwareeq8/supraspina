"""Authoritative workflow scheduling and process ownership."""

# These intentionally branch-rich state-machine transitions are exercised by the
# durability, cancellation, recovery, and scheduler tests.
# ruff: noqa: PERF203, PLR0911, PLR0912, PLR0913, PLR0915

from __future__ import annotations

import copy
import csv
import ctypes
import fnmatch
import hashlib
import json
import math
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid
from collections import OrderedDict, deque
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from ctypes import wintypes
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from . import __version__, scientific_assets, unit_reuse
from .adapters.base import (
    ADAPTERS,
    OOM_EXIT_CODE,
    UNIT_CONTRACTS,
    ExecutionAction,
    Failure,
    UnitContract,
)
from .adapters.fastsurfer import (
    FASTSURFER_BACKEND,
    FREESURFER_BACKEND,
    reconstruction_backend_from_receipt,
    reconstruction_freesurfer_major_from_receipt,
    selected_backend,
)
from .authorization import AuthorizationLedger, PlanStaleError
from .build_identity import build_identity
from .cohort import (
    CohortError,
    CohortSnapshot,
    T1Resolution,
    build_cohort_snapshot,
    load_qc_records,
)
from .final_r_contract import SITE_COLUMN
from .freesurfer_environment import freesurfer_runtime_environment
from .input_fov_review import InputFovReviewManager
from .membership import enrich_evidence
from .operator_errors import OperatorError
from .project import ProjectEpochs, ProjectIdentity
from .provenance import (
    BASELINE,
    active_resource_root_spellings,
    bind_projection_inputs,
    bound_action,
    bound_tool_evidence,
    detector_evidence,
    edge_evidence,
    environment_check_evidence,
    evidence_identity,
    evidence_is_done,
    execution_action_digest,
    expected_signature,
    file_identity,
    make_receipt,
    receipt_signature_valid,
    registry_fields_identity,
    runtime_run_directory,
    stable_digest,
    uses_detector_edge,
)
from .recon_fallback import (
    KnownFailure,
    LogMark,
    Rerun,
    failure_cause,
    fallback_log_line,
    fallback_record,
    is_freesurfer_recon,
    known_failure,
    mark_recon_log,
    read_recon_log_since,
    rerun_argv,
)
from .redaction import redact_secrets, redact_text
from .registry import STEP_BY_KEY
from .registry_store import RegistryStore
from .run_store import (
    MANIFEST_VERSION,
    PersistenceError,
    RunStore,
)
from .workflow import (
    PlannedWorkflow,
    blocked_dependency_reason,
    build_plan,
    validate_boolean,
    validate_config_revision,
    validate_workflow_acknowledgements,
)

TERMINAL_NODE_STATES = {
    "done",
    "failed",
    "cancelled",
    "blocked",
    "withheld",
    "interrupted",
    "stale",
    "skipped",
}
ACTIVE_JOB_STATES = {"queued", "running", "cancelling", "unknown"}
#: Persisted run statuses that still claim live work after a restart. Startup
#: must settle these even when the durable jobs are all terminal, because a
#: crash between the last job commit and the run's terminal commit would
#: otherwise leave the run marked ``running`` forever. ``queued`` is committed
#: durably before the scheduler creates any job, so a crash in that window
#: would otherwise leave a phantom live run that nothing will ever execute.
UNSETTLED_RUN_STATES = {"queued", "running", "cancelling"}
TERMINAL_ERROR_JOB_STATES = {
    "failed",
    "blocked",
    "withheld",
    "interrupted",
    "stale",
    "persistence-error",
}
PRODUCT_NAME = "Supraspina"
TERMINAL_CACHE_LIMIT = 200
BOOTSTRAP_LOG_LIMIT = 2_000
_REPLAY_LOG_BYTES_PER_JOB = 256 * 1024
_REPLAY_LOG_LINES_PER_JOB = 200
_REPLAY_LOG_FILE_LIMIT = 512
_REPLAY_LOG_LINE_CHARS = 16 * 1024
_TERMINAL_ERROR_CACHE_LIMIT = 2_000
_TERMINAL_ERROR_REASON_CHARS = 2_048
#: The output lines of one recon-all attempt kept to read its failure. A known
#: failure printed before this window and before recon_fallback's log tail is
#: not recognized, and the subject fails as it would without a rerun.
_RECON_DETECTION_LINES = 400
#: The adapter failure tags whose reason does not state recon-all's cause.
_RECON_CAUSE_TAGS = frozenset(
    {
        "nonzero_exit",
        "topology_failure",
        "inflation_failure",
        "white_surface_failure",
    }
)
_CANCEL_GRACE_SECONDS = 5.0
# The desktop process accepts a claim from its event loop; a screen that is
# loading a large inventory can hold that loop for tens of seconds, and a
# missed deadline kills the scientific process that just started. Wait long
# enough for any such pause; ownership is still verified, only later.
_PROCESS_CLAIM_TIMEOUT_SECONDS = 90.0
_PROCESS_CLAIM_SLOW_SECONDS = 5.0
_PROCESS_OWNER_VERSION = 1
_MAX_START_IDENTITY_CHARS = 256
_MAX_PROCESS_OWNER_ID_CHARS = 256
_MAX_PROCESS_CLAIM_ID_CHARS = 128
_MAX_PROCESS_RUN_ID_CHARS = 128
_MAX_PUBLIC_DETECTOR_DETAIL_CHARS = 512
_RECONSTRUCTION_OUTPUT_CONFLICT_REASON = (
    "Choose a fresh derivatives namespace because detector-complete Reconstruction "
    "output has no matching current receipt; preserve the existing tree."
)
# Why a node that the plan runs was not reused. Each reason states a fact
# about the node's receipts for the plan review; it enters the plan and its
# digest, never a receipt or an expected signature.
_RUN_REASON_RETRY_SELECTED = "It is selected for retry."
#: Name at most this many dropped files in one job log line.
_NAMED_FILES = 5
_RUN_REASON_REUSE_OFF = "Reuse of completed work is off in project configuration."
_RUN_REASON_NO_RECEIPT = "No earlier run left a receipt for it."
_RUN_REASON_OUTPUT_CHANGED = "Its output on disk no longer matches its receipt."
_RUN_REASON_COHORT_CHANGED = "The analysis cohort changed after it last ran."
_RUN_REASON_INPUTS_CHANGED = "Its inputs changed after it last ran."
_RUN_REASON_UNRESOLVED = "No current receipt covers it."
# How a run summary states a run status that has no more specific outcome
# ("The run is queued.", "The run failed."): a state reads as one, an ended
# run as what happened to it. Like the reasons above, the summary enters the
# plan, its digest, and the run state, never a receipt or an expected
# signature.
_RUN_STATUS_SENTENCES = {
    "planned": "The run is planned.",
    "queued": "The run is queued.",
    "running": "The run is running.",
    "cancelling": "The run is being canceled.",
    "done": "The run finished.",
    "failed": "The run failed.",
    "cancelled": "The run was canceled.",
    "blocked": "The run is blocked.",
    "interrupted": "The run was interrupted.",
    "persistence-error": "Supraspina could not persist the run state.",
    "unknown": "The run state is unknown.",
}
# The node states a run summary counts as blocked and quotes a reason of.
_NOT_RUN_NODE_STATUSES = frozenset({"blocked", "withheld", "stale"})
# The bounds of the nodes a run snapshot lists behind its quoted reason: the
# renderer contract's identifier and message lengths, and a node count and a
# total of repeated reason text that keep a bootstrap of 50 runs well inside
# one 8 MiB protocol line.
_QUOTED_REASON_ID_CHARACTERS = 256
_QUOTED_REASON_CHARACTERS = 8_192
_QUOTED_REASON_NODE_LIMIT = 256
_QUOTED_REASON_TEXT_BUDGET = 64 * 1024
_JSON_SAFE_INTEGER_MAX = 9_007_199_254_740_991
_AUTO_FALLBACK_REASON_TAGS = {
    "topology_failure": "freesurfer_topology_failure",
    "inflation_failure": "freesurfer_inflation_failure",
    "white_surface_failure": "freesurfer_white_surface_failure",
}
_PLAN_ID_PATTERN = re.compile(r"^run-[a-f0-9]{12}$")
_DIGEST_PATTERN = re.compile(r"^[a-f0-9]{64}$")
_FREESURFER_RELEASE_PATTERN = re.compile(r"\brelease\s+([^);]+)")
_MAX_METADATA_BYTES = 64 * 1024 * 1024
_MAX_METADATA_ROWS = 1_000_000
_MAX_METADATA_COLUMNS = 512
# Source metadata columns the Final projection's registry Site column replaces.
_SOURCE_SITE_COLUMNS = ("Site", "site")
# The run-scoped projection each metadata-reading stage consumes.
_PROJECTION_PATH_KEYS = {
    "clinical": "clinicalMetadataFile",
    "final": "finalMetadataFile",
    "braincharts": "brainchartsMetadataFile",
}
_BRAINCHARTS_PROJECTION_COLUMNS = ("subject", "age", "sex", "siteLabel", "cohort")
_BRAINCHARTS_COHORTS = {
    "healthy": "control",
    "sci-no-neuropathic-pain": "SCI_nNP",
    "sci-neuropathic-pain": "SCI_P",
}
_IS_WINDOWS = os.name == "nt"
_EXEC_GATE = (
    "import os,sys; "
    "fd=int(sys.argv[1]); token=os.read(fd,1); os.close(fd); "
    "args=sys.argv[2:]; "
    "os.execvpe(args[0],args,os.environ) if token==b'1' and args else os._exit(125)"
)
_WINDOWS_EXEC_GATE = (
    "import os,sys; token=sys.stdin.buffer.read(1); args=sys.argv[1:]; "
    "os.execvpe(args[0],args,os.environ) if token==b'1' and args else os._exit(125)"
)
_FROZEN_EXEC_GATE_ARG = "--supraspina-exec-gate"
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class _InputChangedError(RuntimeError):
    """Reject scientific input bytes that no longer match the reviewed binding."""

    def __init__(self, message: str, evidence: list[dict[str, Any]]) -> None:
        super().__init__(message)
        self.evidence = evidence


class _ExecutionActionChangedError(RuntimeError):
    """Refuse execution when the bound typed action changes before launch."""


class _ReconstructionOutputConflictError(RuntimeError):
    """Refuse unsafe reuse of a complete fixed reconstruction tree."""


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _JobBasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _JobExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JobBasicLimitInformation),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class _JobBasicAccountingInformation(ctypes.Structure):
    _fields_ = [
        ("TotalUserTime", ctypes.c_int64),
        ("TotalKernelTime", ctypes.c_int64),
        ("ThisPeriodTotalUserTime", ctypes.c_int64),
        ("ThisPeriodTotalKernelTime", ctypes.c_int64),
        ("TotalPageFaultCount", wintypes.DWORD),
        ("TotalProcesses", wintypes.DWORD),
        ("ActiveProcesses", wintypes.DWORD),
        ("TotalTerminatedProcesses", wintypes.DWORD),
    ]


class _FileTime(ctypes.Structure):
    _fields_ = [
        ("dwLowDateTime", wintypes.DWORD),
        ("dwHighDateTime", wintypes.DWORD),
    ]


class _WindowsJob:
    """Own one Windows process tree with kill-on-sidecar-exit semantics."""

    def __init__(self) -> None:
        self._handle: Any | None = None
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        self._close_handle = kernel32.CloseHandle
        self._close_handle.argtypes = [wintypes.HANDLE]
        self._close_handle.restype = wintypes.BOOL
        self._assign = kernel32.AssignProcessToJobObject
        self._assign.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self._assign.restype = wintypes.BOOL
        self._terminate = kernel32.TerminateJobObject
        self._terminate.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self._terminate.restype = wintypes.BOOL
        self._query = kernel32.QueryInformationJobObject
        self._query.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        self._query.restype = wintypes.BOOL
        create = kernel32.CreateJobObjectW
        create.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        create.restype = wintypes.HANDLE
        configure = kernel32.SetInformationJobObject
        configure.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
        ]
        configure.restype = wintypes.BOOL
        self._handle = create(None, None)
        if not self._handle:
            raise ctypes.WinError(ctypes.get_last_error())  # type: ignore[attr-defined]
        limits = _JobExtendedLimitInformation()
        limits.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not configure(
            self._handle,
            _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(limits),
            ctypes.sizeof(limits),
        ):
            error = ctypes.get_last_error()
            self.close()
            raise ctypes.WinError(error)  # type: ignore[attr-defined]

    def assign(self, proc: Any) -> None:
        handle = getattr(proc, "_handle", None)
        if handle is None or not self._assign(
            self._handle, wintypes.HANDLE(int(handle))
        ):
            raise ctypes.WinError(ctypes.get_last_error())  # type: ignore[attr-defined]

    def terminate(self) -> None:
        if self._handle and not self._terminate(self._handle, 1):
            raise ctypes.WinError(ctypes.get_last_error())  # type: ignore[attr-defined]

    def active_processes(self) -> int:
        if not self._handle:
            return 0
        accounting = _JobBasicAccountingInformation()
        returned = wintypes.DWORD()
        if not self._query(
            self._handle,
            _JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
            ctypes.byref(accounting),
            ctypes.sizeof(accounting),
            ctypes.byref(returned),
        ):
            raise ctypes.WinError(ctypes.get_last_error())  # type: ignore[attr-defined]
        return int(accounting.ActiveProcesses)

    def close(self) -> None:
        if self._handle:
            self._close_handle(self._handle)
            self._handle = None

    def __del__(self) -> None:
        self.close()


def _unusable_interpreter(
    adapter: Any, cfg: dict[str, Any], subject_id: str | None
) -> str | None:
    """Return a blocking reason when a step's command cannot be executed at all.

    Reject a command whose first element is empty or still carries an unresolved
    ``${...}`` placeholder. Detect the condition during planning because ``execve``
    otherwise rejects it with "argv first element cannot be empty" only after the
    operator reviews and authorizes the plan. Turn the late, opaque runtime crash
    into a named blocker on the reviewed plan.

    Parameters
    ----------
    subject_id
        Provide the subject the node targets, or ``None`` for a cohort node.

    Returns
    -------
    str or None
        Return the blocking reason, or ``None`` when the command is executable.
    """
    try:
        command = adapter.build_command(cfg, subject_id)
    except Exception:  # Report a build failure through its own path.
        return None
    if not isinstance(command, list) or not command:
        return None
    program = str(command[0])
    if not program.strip():
        return (
            "Replace the empty configured interpreter in Pipeline, or install the "
            "required tool."
        )
    if "${" in program:
        return f"Resolve the unresolved configured interpreter: {program}."
    return None


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _iso(value: int | None) -> str | None:
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()


def _age_text(age: Any) -> str:
    """Write a registry age without the trailing ``.0`` of a whole number.

    The registry stores ages as floats, and the BrainCharts tables carry the
    projected text, so a whole age reads ``40`` rather than ``40.0``.
    """
    if age is None:
        return ""
    if isinstance(age, float) and age.is_integer():
        return str(int(age))
    return str(age)


def _final_site_fields(fields: list[str]) -> list[str]:
    """Return the Final projection header with exactly one ``Site`` column.

    A source ``Site`` or ``site`` column keeps its position under the name
    ``Site``; without one, ``Site`` is appended.
    """
    out: list[str] = []
    for name in fields:
        if name in _SOURCE_SITE_COLUMNS:
            if SITE_COLUMN not in out:
                out.append(SITE_COLUMN)
        else:
            out.append(name)
    if SITE_COLUMN not in out:
        out.append(SITE_COLUMN)
    return out


def _fsync_directory(path: str) -> None:
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _linux_process_identity(pid: int) -> tuple[str, str | None]:
    """Return Linux boot/start-tick identity without trusting PID alone."""
    try:
        with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as boot_handle:
            boot_id = boot_handle.read(128).strip()
        with open(f"/proc/{pid}/stat", encoding="utf-8") as stat_handle:
            stat_value = stat_handle.read(4096)
    except (FileNotFoundError, ProcessLookupError):
        return "dead", None
    except PermissionError:
        return "unknown", None
    except OSError:
        return "unknown", None
    try:
        # Parse the parenthesized command name even when it contains spaces or ')'.
        fields = stat_value.rsplit(")", 1)[1].strip().split()
        start_ticks = fields[19]
    except (IndexError, ValueError):
        return "unknown", None
    if not boot_id or not start_ticks.isdigit():
        return "unknown", None
    return "alive", f"linux:{boot_id}:{start_ticks}"


def _windows_process_identity(
    pid: int, proc: Any | None = None
) -> tuple[str, str | None]:
    """Return the Windows creation FILETIME, opening only query access."""
    if os.name != "nt":
        return "unknown", None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL
    get_times = kernel32.GetProcessTimes
    get_times.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_FileTime),
        ctypes.POINTER(_FileTime),
        ctypes.POINTER(_FileTime),
        ctypes.POINTER(_FileTime),
    ]
    get_times.restype = wintypes.BOOL
    raw_handle = getattr(proc, "_handle", None) if proc is not None else None
    opened = False
    if raw_handle is None:
        open_process = kernel32.OpenProcess
        open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        open_process.restype = wintypes.HANDLE
        raw_handle = open_process(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not raw_handle:
            error = ctypes.get_last_error()
            return ("dead", None) if error in {87, 1168} else ("unknown", None)
        opened = True
    creation = _FileTime()
    exit_time = _FileTime()
    kernel_time = _FileTime()
    user_time = _FileTime()
    try:
        if not get_times(
            wintypes.HANDLE(int(raw_handle)),
            ctypes.byref(creation),
            ctypes.byref(exit_time),
            ctypes.byref(kernel_time),
            ctypes.byref(user_time),
        ):
            error = ctypes.get_last_error()
            return ("dead", None) if error in {87, 1168} else ("unknown", None)
        value = (int(creation.dwHighDateTime) << 32) | int(creation.dwLowDateTime)
        return "alive", f"windows:{value}"
    finally:
        if opened:
            close_handle(wintypes.HANDLE(int(raw_handle)))


def _posix_process_identity(pid: int) -> tuple[str, str | None]:
    """Return a stable process start timestamp on non-Linux POSIX hosts."""
    try:
        result = subprocess.run(  # noqa: S603
            ["ps", "-o", "lstart=", "-p", str(pid)],  # noqa: S607
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown", None
    value = " ".join(result.stdout.split())
    if result.returncode != 0 or not value:
        return "dead", None
    return "alive", f"{sys.platform}:{value}"


def _process_start_identity(
    pid: int, proc: Any | None = None
) -> tuple[str, str | None]:
    """Return ``(alive|dead|unknown, anti-PID-reuse start identity)``."""
    if not isinstance(pid, int) or pid <= 1:
        return "unknown", None
    if sys.platform.startswith("linux"):
        return _linux_process_identity(pid)
    if os.name == "nt":
        return _windows_process_identity(pid, proc)
    return _posix_process_identity(pid)


def _strict_safe_integer(value: Any, *, minimum: int = 0) -> bool:
    """Accept only JSON integers that round-trip exactly through TypeScript."""
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and minimum <= value <= _JSON_SAFE_INTEGER_MAX
    )


def _process_start_identity_syntax_valid(value: Any) -> bool:
    """Require the identity scheme produced by this platform's live probe."""
    if (
        not isinstance(value, str)
        or not value
        or len(value) > _MAX_START_IDENTITY_CHARS
        or any(char in value for char in "\0\r\n")
    ):
        return False
    if sys.platform.startswith("linux"):
        prefix, separator, ticks = value.rpartition(":")
        return (
            separator == ":"
            and prefix.startswith("linux:")
            and bool(prefix.removeprefix("linux:"))
            and ticks.isdigit()
            and int(ticks) > 0
        )
    if os.name == "nt":
        prefix, separator, created = value.partition(":")
        return (
            prefix == "windows"
            and separator == ":"
            and created.isdigit()
            and int(created) > 0
        )
    return value.startswith(f"{sys.platform}:") and len(value) > len(sys.platform) + 1


def _process_group_state(pgid: int) -> str:
    """Probe a POSIX process group without turning EPERM into proof."""
    if not isinstance(pgid, int) or pgid <= 1:
        return "unknown"
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return "dead"
    except PermissionError:
        return "unknown"
    except OSError:
        return "unknown"
    return "alive"


def _config_sha(cfg: dict[str, Any]) -> str:
    data = json.dumps(
        cfg, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode()
    return hashlib.sha256(data).hexdigest()


def _job_time(job: dict[str, Any]) -> int:
    """Return a stable chronology key for a runtime job projection."""
    for key in ("endedAt", "startedAt", "plannedAt"):
        try:
            value = int(job.get(key) or 0)
        except (TypeError, ValueError):
            value = 0
        if value:
            return value
    return 0


def _commit_pointer_absent(store: RunStore, run_id: str) -> bool:
    """Return whether the run's commit pointer is definitively absent.

    Distinguish a run directory that never published its first generation
    from one whose pointer exists but cannot be read or verified. Only the
    definitive absence is safe to settle, because the first commit precedes
    scheduler registration, so a pointer-less run provably owns no process.
    """
    try:
        return store.pointer(run_id) is None
    except (ValueError, PersistenceError):
        return False


def _settle_unowned_run(state: dict[str, Any]) -> None:
    """Close a persisted run that claims live work but owns no live process.

    Derive the outcome from the durable nodes exactly as the scheduler would,
    so a crash that lost only the terminal run commit reports the real result
    instead of an indefinite ``running`` state. Keep an unproven node
    ``unknown`` so uncertain ownership still fails closed, and neither spawn,
    adopt, nor signal any process.
    """
    for node in state.get("nodes", []):
        if node.get("status") not in TERMINAL_NODE_STATES:
            if node.get("status") == "unknown":
                continue
            node["status"] = "interrupted"
            node["reason"] = (
                "This work was marked interrupted because no process was executing it."
            )
    statuses = {node.get("status") for node in state.get("nodes", [])}
    if "unknown" in statuses:
        state["status"] = "unknown"
        state["endedAtMs"] = None
        state["terminalReason"] = "process_tree_unverified"
        state["recovery"] = {
            "state": "unknown",
            "detail": (
                "Ownership of the prior scientific process could not be verified."
            ),
        }
        return
    if "failed" in statuses:
        status = "failed"
    elif "cancelled" in statuses:
        status = "cancelled"
    elif "blocked" in statuses or "withheld" in statuses:
        status = "blocked"
    elif "interrupted" in statuses:
        status = "interrupted"
    else:
        status = "done"
    state["status"] = status
    state["endedAtMs"] = _now_ms()
    state["terminalReason"] = "stale_process_tree_settled"
    state["recovery"] = {
        "state": status,
        "detail": "After a restart, no owned live process remained for this run.",
    }


def _terminal_job_error_message(job: dict[str, Any]) -> str | None:
    """Return one human-readable marker for a terminal job error."""
    status = str(job.get("status", ""))
    if status not in TERMINAL_ERROR_JOB_STATES:
        return None
    labels = {
        "failed": "Investigate the failed job",
        "blocked": "Resolve the blocked job",
        "withheld": "Review the withheld job",
        "interrupted": "Resume the interrupted job",
        "stale": "Refresh the stale job",
        "persistence-error": "Repair job persistence",
    }
    exit_code = job.get("exitCode")
    exit_detail = (
        f" (exit code {exit_code})"
        if isinstance(exit_code, int) and not isinstance(exit_code, bool)
        else ""
    )
    raw_reason = job.get("terminalReason")
    reason = " ".join(str(raw_reason).split()) if raw_reason is not None else ""
    if not reason:
        reason = f"Review terminal status {status}."
    reason = reason[:_TERMINAL_ERROR_REASON_CHARS]
    message = f"{labels[status]}{exit_detail}: {reason}"
    return message if message.endswith((".", "!", "?")) else f"{message}."


def _bounded_jobs(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep every active job plus the newest bounded terminal history."""
    by_id: dict[str, dict[str, Any]] = {}
    for value in values:
        if not isinstance(value, dict):
            continue
        job_id = str(value.get("id", ""))
        if job_id:
            by_id[job_id] = copy.deepcopy(value)
    persistence_errors = [
        value
        for value in by_id.values()
        if value.get("status") == "persistence-error"
        or value.get("persistenceStatus") == "error"
    ]
    persistence_error_ids = {str(value.get("id")) for value in persistence_errors}
    # Exclude persistence errors from the active selection the way the terminal
    # selection does; a job may carry an active status and a failed persistence
    # status at once, and the payload must name each job exactly once.
    active = [
        value
        for value in by_id.values()
        if value.get("status") in ACTIVE_JOB_STATES
        and str(value.get("id")) not in persistence_error_ids
    ]
    terminal = [
        value
        for value in by_id.values()
        if value.get("status") not in ACTIVE_JOB_STATES
        and str(value.get("id")) not in persistence_error_ids
    ]
    terminal.sort(key=lambda value: (_job_time(value), str(value.get("id", ""))))
    selected = [
        *active,
        *persistence_errors,
        *terminal[-TERMINAL_CACHE_LIMIT:],
    ]
    selected.sort(key=lambda value: (_job_time(value), str(value.get("id", ""))))
    return selected


def _selected_retry_subject_ids(
    source_nodes: list[dict[str, Any]], request: dict[str, Any]
) -> list[str] | None:
    """Return an explicit subject-only Retry scope, or ``None`` for cohort work."""
    if "nodeIds" not in request:
        return None
    raw_node_ids = request.get("nodeIds")
    if not isinstance(raw_node_ids, list):
        raise ValueError("Provide retry nodeIds as an array.")
    if any(not isinstance(value, str) for value in raw_node_ids):
        raise ValueError("Include only strings in retry nodeIds.")
    selected_node_ids = set(raw_node_ids)
    known_node_ids = {
        node_id
        for node in source_nodes
        if isinstance((node_id := node.get("nodeId")), str)
    }
    if selected_node_ids - known_node_ids:
        raise ValueError("Select only known source nodes for retry.")
    selected_nodes = [
        node for node in source_nodes if node.get("nodeId") in selected_node_ids
    ]
    if any(not isinstance(node.get("subjectId"), str) for node in selected_nodes):
        # Preserve the source selected set so the exact full-cohort effect of a
        # cohort-scoped node remains visible.
        return None
    subject_ids: list[str] = []
    for node in selected_nodes:
        subject_id = str(node["subjectId"])
        if subject_id not in subject_ids:
            subject_ids.append(subject_id)
    return subject_ids


def _resume_intent(
    source_intent: dict[str, Any],
    cfg: dict[str, Any],
    acknowledgements: dict[str, Any],
    *,
    source_analysis_subject_ids: list[str] | None = None,
    source_selected_subject_ids: list[str] | None = None,
    recovery_decision_subject_ids: list[str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Intersect recovery scope with current eligibility without widening it."""
    validated_acknowledgements = validate_workflow_acknowledgements(acknowledgements)
    effective = copy.deepcopy(source_intent)
    target = (
        effective.get("target", {}) if isinstance(effective.get("target"), dict) else {}
    )
    source_mode = str(target.get("mode", "all"))
    source_step = str(effective.get("stepKey", ""))
    cohort_stage = (
        effective.get("kind") == "stage"
        and source_step in STEP_BY_KEY
        and STEP_BY_KEY[source_step]["scope"] == "cohort"
    )
    if source_analysis_subject_ids is None and (
        source_mode != "explicit" or cohort_stage
    ):
        return effective, None
    source_analysis = list(source_analysis_subject_ids or [])
    if source_selected_subject_ids is not None:
        source_selected = list(source_selected_subject_ids)
    elif source_mode == "explicit":
        source_selected = [
            str(value)
            for value in target.get("subjectIds", [])
            if isinstance(value, str)
        ]
    else:
        source_selected = list(source_analysis)
    try:
        current = build_cohort_snapshot(
            cfg,
            target_mode="all",
            # Classify current subjects in this snapshot. Require the operator's
            # fresh QC choice in the exact recovery snapshot below.
            acknowledge_qc_pending=True,
        )
    except CohortError:
        return effective, None
    current_verdicts = dict(current.qc_verdicts)
    current_analysis_set = set(current.analysis_subject_ids)
    current_eligible = [
        subject_id
        for subject_id in current.analysis_subject_ids
        if validated_acknowledgements["includeDeferredAndUnreviewedQc"]
        or current_verdicts.get(subject_id, "unreviewed") == "pass"
    ]
    current_set = set(current_eligible)
    source_scope = source_analysis or source_selected
    source_scope_set = set(source_scope)
    decision_scope = (
        source_scope
        if recovery_decision_subject_ids is None
        else [
            subject_id
            for subject_id in recovery_decision_subject_ids
            if subject_id in source_scope_set
        ]
    )
    retained_analysis = [
        subject_id for subject_id in source_scope if subject_id in current_set
    ]
    retained_selected = [
        subject_id for subject_id in source_selected if subject_id in current_set
    ]
    if not cohort_stage:
        target["mode"] = "explicit"
        target["subjectIds"] = retained_selected
    else:
        target["mode"] = "all"
        target.pop("subjectIds", None)
    effective["target"] = target
    return effective, {
        "sourceSubjectIds": list(source_scope),
        "currentEligibleSubjectIds": current_eligible,
        "retainedSubjectIds": retained_analysis,
        "addedSubjectIds": [
            subject_id
            for subject_id in current_eligible
            if subject_id not in set(source_scope)
        ],
        "removedSubjectIds": [
            subject_id for subject_id in source_scope if subject_id not in current_set
        ],
        "deferredAndUnreviewedSubjectIds": [
            subject_id
            for subject_id in decision_scope
            if subject_id in current_analysis_set
            and current_verdicts.get(subject_id, "unreviewed")
            in {"defer", "unreviewed"}
        ],
    }


@dataclass(frozen=True)
class _LogReplay:
    """The bootstrap log replay: the bounded tail and what it read per job."""

    tail: list[dict[str, Any]]
    #: One entry per committed job log file the replay opened, newest job
    #: first: its run and job IDs, the number of lines read, and whether the
    #: whole file was read rather than a bounded tail of it. A job whose log
    #: the replay never opened (past the file limit or the line budget, a
    #: rejected or missing path) has no entry, so the renderer never infers
    #: an empty log from its absence.
    coverage: list[dict[str, Any]]


def _tail_text_file(path: str) -> tuple[list[str], bool]:
    """Read a bounded regular-file tail without following a final symlink."""
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise OSError("Provide a regular job log file.")
        start = max(0, info.st_size - _REPLAY_LOG_BYTES_PER_JOB)
        os.lseek(fd, start, os.SEEK_SET)
        remaining = _REPLAY_LOG_BYTES_PER_JOB
        chunks: list[bytes] = []
        while remaining:
            chunk = os.read(fd, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
    finally:
        os.close(fd)
    lines = b"".join(chunks).decode("utf-8", errors="replace").splitlines()
    truncated = start > 0 or len(lines) > _REPLAY_LOG_LINES_PER_JOB
    if len(lines) > _REPLAY_LOG_LINES_PER_JOB:
        lines = lines[-_REPLAY_LOG_LINES_PER_JOB:]
    if start > 0 and lines:
        lines[0] = "[line prefix truncated] " + lines[0]
    bounded: list[str] = []
    for line in lines:
        if len(line) > _REPLAY_LOG_LINE_CHARS:
            bounded.append(line[:_REPLAY_LOG_LINE_CHARS] + " [line truncated]")
            truncated = True
        else:
            bounded.append(line)
    return bounded, truncated


def _spawn(
    argv: list[str],
    cfg: dict[str, Any],
    *,
    environment: dict[str, str] | None = None,
) -> subprocess.Popen[str]:
    env = freesurfer_runtime_environment(cfg, base_environment=os.environ)
    if environment:
        env.update(environment)
    kwargs: dict[str, Any] = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "text": True,
        "errors": "replace",
        "env": env,
    }
    frozen = bool(getattr(sys, "frozen", False))
    if _IS_WINDOWS or frozen:
        if _IS_WINDOWS:
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        else:
            kwargs["start_new_session"] = True
        kwargs["stdin"] = subprocess.PIPE
        command = (
            [sys.executable, _FROZEN_EXEC_GATE_ARG, *argv]
            if frozen
            else [sys.executable, "-I", "-S", "-c", _WINDOWS_EXEC_GATE, *argv]
        )
        proc = subprocess.Popen(command, **kwargs)  # noqa: S603
        proc._supraspina_gate_stream = proc.stdin
        if not _IS_WINDOWS:
            return proc
        job: _WindowsJob | None = None
        try:
            job = _WindowsJob()
            job.assign(proc)
        except Exception:
            try:
                proc.kill()
            except OSError:
                pass
            if proc.stdin is not None:
                proc.stdin.close()
                proc.stdin = None
            if job is not None:
                job.close()
            raise
        proc._supraspina_job = job
        return proc
    gate_read, gate_write = os.pipe()
    try:
        kwargs["start_new_session"] = True
        kwargs["pass_fds"] = (gate_read,)
        command = [
            sys.executable,
            "-I",
            "-S",
            "-c",
            _EXEC_GATE,
            str(gate_read),
            *argv,
        ]
        proc = subprocess.Popen(command, **kwargs)  # noqa: S603
    except Exception:
        os.close(gate_write)
        raise
    finally:
        os.close(gate_read)
    proc._supraspina_gate_fd = gate_write
    return proc


def _release_spawn(proc: Any) -> None:
    """Permit a gated child to exec only after ownership is durable."""
    stream = getattr(proc, "_supraspina_gate_stream", None)
    if stream is not None:
        try:
            stream.write("1")
            stream.flush()
        finally:
            stream.close()
            proc._supraspina_gate_stream = None
            proc.stdin = None
    fd = getattr(proc, "_supraspina_gate_fd", None)
    if not isinstance(fd, int):
        return
    try:
        os.write(fd, b"1")
    finally:
        os.close(fd)
        proc._supraspina_gate_fd = None


def _close_spawn_gate(proc: Any) -> None:
    stream = getattr(proc, "_supraspina_gate_stream", None)
    if stream is not None:
        try:
            stream.close()
        except OSError:
            pass
        proc._supraspina_gate_stream = None
        proc.stdin = None
    gate_fd = getattr(proc, "_supraspina_gate_fd", None)
    if isinstance(gate_fd, int):
        try:
            os.close(gate_fd)
        except OSError:
            pass
        proc._supraspina_gate_fd = None


def _terminate_tree(proc: Any, *, force: bool = False) -> None:
    _close_spawn_gate(proc)
    job = getattr(proc, "_supraspina_job", None)
    if job is not None:
        try:
            job.terminate()
        except (OSError, ValueError):
            pass
        return
    pgid = getattr(proc, "_supraspina_pgid", None)
    try:
        if _IS_WINDOWS and proc.poll() is not None:
            return
        if _IS_WINDOWS and getattr(proc, "pid", None):
            command = ["taskkill", "/PID", str(proc.pid), "/T"]
            if force:
                command.append("/F")
            subprocess.run(command, check=False, capture_output=True, timeout=10)  # noqa: S603
        elif isinstance(pgid, int) and pgid > 1:
            os.killpg(pgid, signal.SIGKILL if force else signal.SIGTERM)
        elif proc.poll() is not None:
            return
        elif getattr(proc, "pid", None):
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL if force else signal.SIGTERM)
        elif force:
            proc.kill()
        else:
            proc.terminate()
    except (OSError, ProcessLookupError, subprocess.SubprocessError, ValueError):
        try:
            proc.kill() if force else proc.terminate()
        except (OSError, ValueError):
            pass


def _process_group(proc: Any) -> int | None:
    pid = getattr(proc, "pid", None)
    if not isinstance(pid, int) or pid <= 1:
        return None
    if _IS_WINDOWS:
        return pid
    try:
        return os.getpgid(pid)
    except OSError:
        return None


def _settle_group(proc: Any, pgid: int | None) -> bool:
    """Prove the owned process group stopped, terminating lingering descendants."""
    job = getattr(proc, "_supraspina_job", None)
    if job is not None:
        _close_spawn_gate(proc)
        proved = False
        try:
            if job.active_processes() > 0:
                job.terminate()
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                if job.active_processes() == 0:
                    proved = True
                    break
                time.sleep(0.02)
            if not proved:
                job.terminate()
                proved = job.active_processes() == 0
        except (OSError, ValueError):
            proved = False
        if proved:
            job.close()
            proc._supraspina_job = None
        return proved
    if _IS_WINDOWS:
        return proc.poll() is not None
    if pgid is None:
        pgid = getattr(proc, "_supraspina_pgid", None)
    if not _strict_safe_integer(pgid, minimum=2):
        # An unknown group identity is not proof that the tree settled. Never
        # rederive a group from this PID: once the leader is reaped the kernel
        # may have reused its number for an unrelated process.
        return False
    state = _process_group_state(int(pgid))
    if state == "dead":
        proc._supraspina_pgid = None
        return True
    if state == "unknown":
        # Fail closed: the group cannot be observed, so it cannot be signalled
        # or proved stopped.
        return False
    for sig, delay in ((signal.SIGTERM, 1.0), (signal.SIGKILL, 1.0)):
        try:
            os.killpg(int(pgid), sig)
        except ProcessLookupError:
            proc._supraspina_pgid = None
            return True
        except (OSError, TypeError, ValueError):
            # Includes PermissionError: the group exists but is not ours to signal.
            return False
        deadline = time.monotonic() + delay
        while time.monotonic() < deadline:
            if _process_group_state(int(pgid)) == "dead":
                proc._supraspina_pgid = None
                return True
            time.sleep(0.02)
    proved = _process_group_state(int(pgid)) == "dead"
    if proved:
        proc._supraspina_pgid = None
    return proved


def _schedule_force_termination(proc: Any) -> None:
    """Escalate cancellation without keeping interpreter shutdown alive."""
    timer = threading.Timer(
        _CANCEL_GRACE_SECONDS, lambda: _terminate_tree(proc, force=True)
    )
    timer.daemon = True
    timer.start()


def _cohort_from_scope(scope: dict[str, Any]) -> CohortSnapshot:
    qc_acknowledged = validate_boolean(
        scope.get("qcAcknowledged", False), "scope.qcAcknowledged"
    )
    rows = tuple(
        T1Resolution(
            subject_id=str(
                row["subject_id"] if "subject_id" in row else row["subjectId"]
            ),
            state=str(row.get("state", "resolved")),  # type: ignore[arg-type]
            path=row.get("path"),
            candidates=tuple(row.get("candidates", [])),
            fingerprint=row.get("fingerprint"),
            fingerprint_strategy=str(
                row.get(
                    "fingerprint_strategy",
                    row.get("fingerprintStrategy", "sha256-full-v1"),
                )
            ),
        )
        for row in scope.get("t1", [])
    )
    return CohortSnapshot(
        analysis_subject_ids=tuple(scope.get("analysisSubjectIds", [])),
        selected_subject_ids=tuple(scope.get("selectedSubjectIds", [])),
        analysis_digest=str(scope.get("analysisDigest", "")),
        selected_digest=str(scope.get("selectedDigest", "")),
        t1=rows,
        qc_verdicts=tuple(sorted(dict(scope.get("qcVerdicts", {})).items())),
        qc_acknowledged=qc_acknowledged,
        excluded_by_config=tuple(scope.get("excludedByConfig", [])),
        excluded_by_qc=tuple(scope.get("excludedByQc", [])),
    )


@dataclass
class _RunContext:
    state: dict[str, Any]
    cfg: dict[str, Any]
    effective_cfg: dict[str, Any]
    cohort: CohortSnapshot
    project: ProjectIdentity
    store: RunStore
    queue_limit: int
    processes: dict[str, Any] = field(default_factory=dict)
    cancel_events: dict[str, threading.Event] = field(default_factory=dict)
    #: Ids of the jobs whose execution thread actually started. A cancel event
    #: exists before the thread starts and is also created by cancellation
    #: paths, so it never proves that a thread owns a job's settlement.
    execution_threads: set[str] = field(default_factory=set)
    halt_new: bool = False
    inputs_ready: set[str] = field(default_factory=set)
    input_lock: threading.RLock = field(default_factory=threading.RLock)
    persistence_failed: bool = False
    forced_retry_identities: set[tuple[Any, Any]] = field(default_factory=set)
    #: Expected receipt signatures remembered for one planning pass, keyed by
    #: step, subject, and external-input cache mode. ``None`` outside
    #: :meth:`WorkflowManager._planning_pass`, so a launch binding and a
    #: post-exit proof always digest the inputs afresh.
    expected_memo: dict[tuple[Any, ...], tuple[str, dict[str, Any]]] | None = None


class WorkflowManager:
    """Plan, persist, schedule, resume, cancel, and recover workflow runs."""

    def __init__(
        self,
        emitter: Any,
        *,
        spawn: Any | None = None,
        env_check: Any | None = None,
        authorizations: AuthorizationLedger | None = None,
    ) -> None:
        self.emitter = emitter
        self.runtime_id = str(uuid.uuid4())
        self.sidecar_generation = 0
        self.project_epochs = ProjectEpochs(
            lambda attached: self._emit(
                "system.projectAttachment", {"attached": attached}
            )
        )
        self.input_fov_reviews = InputFovReviewManager(self.project_epochs)
        self._spawn_override = spawn
        self._env_check = env_check
        self.authorizations = authorizations or AuthorizationLedger()
        self._lock = threading.RLock()
        self._wake = threading.Condition(self._lock)
        #: Serialize runtime-event numbering with the write that publishes it.
        #: Never acquire :attr:`_lock` while holding this lock.
        self._event_lock = threading.Lock()
        self._runs: dict[str, _RunContext] = {}
        self._active_jobs: dict[str, dict[str, Any]] = {}
        self._terminal_jobs: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._persistence_errors: dict[str, dict[str, Any]] = {}
        self._pending_process_claims: dict[
            str, tuple[dict[str, Any], threading.Event]
        ] = {}
        self._unresolved_processes: dict[str, dict[str, Any]] = {}
        self._log_tail: deque[dict[str, Any]] = deque(maxlen=2000)
        self._terminal_error_keys: OrderedDict[tuple[str, str, str, str, str], None] = (
            OrderedDict()
        )
        self._provision_status_provider: Any | None = None
        self._sequence = 0
        self._closing = False
        self.supervisor_generation: int | None = None
        self.project_epochs.set_switch_guard(lambda: self.active_counts() == (0, 0))
        self._scheduler = threading.Thread(
            target=self._scheduler_loop, daemon=True, name="supraspina-workflow"
        )
        self._scheduler.start()

    def set_provision_status_provider(self, provider: Any) -> None:
        """Attach the project-scoped persistent provisioning projection."""
        self._provision_status_provider = provider

    def attach_supervisor_generation(self, generation: Any) -> None:
        """Bind process-ownership notifications to the main supervisor generation."""
        if generation is None:
            self.supervisor_generation = None
            return
        if not _strict_safe_integer(generation):
            raise ValueError("Provide a safe non-negative supervisor generation.")
        self.supervisor_generation = generation
        self.sidecar_generation = generation

    def project_active(self, project_id: str) -> bool:
        """Return whether this workflow manager owns active work for a project."""
        with self._lock:
            return (
                any(
                    ctx.project.project_id == project_id
                    and any(
                        node.get("status") not in TERMINAL_NODE_STATES
                        for node in ctx.state.get("nodes", [])
                    )
                    for ctx in self._runs.values()
                )
                or any(
                    job.get("projectId") == project_id
                    for job in self._active_jobs.values()
                )
                or any(
                    owner.get("projectId") == project_id
                    for owner in self._unresolved_processes.values()
                )
            )

    @staticmethod
    def _owner_identity(record: dict[str, Any]) -> dict[str, Any]:
        """Return the fields main and sidecar must compare exactly."""
        return {
            key: record.get(key)
            for key in (
                "schemaVersion",
                "claimId",
                "generation",
                "operationKind",
                "ownerId",
                "projectId",
                "projectEpoch",
                "runId",
                "jobId",
                "operationId",
                "pid",
                "pgid",
                "startIdentity",
            )
        }

    def process_owner_record(
        self,
        *,
        operation_kind: str,
        project: ProjectIdentity,
        proc: Any,
        run_id: str | None = None,
        job_id: str | None = None,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        """Create a complete owner record while the child remains exec-gated."""
        pid = getattr(proc, "pid", None)
        pgid = _process_group(proc)
        if self.supervisor_generation is None and isinstance(pid, int):
            pgid = pid
        proc._supraspina_pgid = pgid
        if (
            operation_kind not in {"workflow", "provision"}
            or not _strict_safe_integer(pid, minimum=2)
            or not _strict_safe_integer(pgid, minimum=2)
            or pgid != pid
        ):
            raise RuntimeError("Provide a valid process ownership identity.")
        identity_state, start_identity = _process_start_identity(pid, proc)
        if identity_state != "alive" or start_identity is None:
            if self.supervisor_generation is None:
                start_identity = f"local:{pid}:{uuid.uuid4().hex}"
            else:
                raise RuntimeError("Prove the process start identity.")
        owner_id = job_id if operation_kind == "workflow" else operation_id
        if (
            not isinstance(owner_id, str)
            or not owner_id
            or len(owner_id) > _MAX_PROCESS_OWNER_ID_CHARS
            or any(char in owner_id for char in "\0\r\n")
        ):
            raise RuntimeError("Provide a process owner ID.")
        return {
            "schemaVersion": _PROCESS_OWNER_VERSION,
            "claimId": f"claim-{uuid.uuid4().hex}",
            "generation": self.supervisor_generation,
            "operationKind": operation_kind,
            "ownerId": owner_id,
            "projectId": project.project_id,
            "projectEpoch": project.epoch,
            "runId": run_id,
            "jobId": job_id,
            "operationId": operation_id,
            "pid": pid,
            "pgid": pgid,
            "startIdentity": start_identity,
            "state": "claiming",
            "accepted": False,
            "provedStopped": False,
            "createdAt": _now_ms(),
        }

    def announce_process_started(
        self, owner: str | dict[str, Any], proc: Any
    ) -> int | None:
        """Transfer a durable claim and await explicit main acceptance.

        Use the plain job-ID form for an unsupervised sidecar whose spawned
        processes have no durable claim to hand over. Pass a complete durable
        owner record from supervised workflow and provisioning callers.
        """
        if isinstance(owner, str):
            pid = getattr(proc, "pid", None)
            pgid = _process_group(proc)
            proc._supraspina_pgid = pgid
            if not isinstance(pid, int) or pid <= 1 or pgid is None:
                return pgid
            payload = {
                "generation": self.supervisor_generation,
                "jobId": owner,
                "pid": pid,
                "pgid": pgid,
            }
            if self.supervisor_generation is None:
                payload.pop("generation")
            try:
                self.emitter.emit("system.processStarted", payload)
            except (OSError, ValueError):
                _terminate_tree(proc, force=True)
                raise RuntimeError(
                    "Supraspina could not hand process ownership to the main process."
                ) from None
            return pgid

        payload = self._owner_identity(owner)
        claim_id = str(payload.get("claimId") or "")
        accepted = threading.Event()
        if self.supervisor_generation is None:
            owner["accepted"] = True
            owner["state"] = "accepted"
            owner["acceptedAt"] = _now_ms()
            return int(owner["pgid"])
        with self._lock:
            if not claim_id or claim_id in self._pending_process_claims:
                raise RuntimeError("The process ownership claim was not unique.")
            self._pending_process_claims[claim_id] = (copy.deepcopy(payload), accepted)
        try:
            self.emitter.emit("system.processOwnerRegistered", payload)
            owner["registered"] = True
            self.emitter.emit("system.processStarted", payload)
        except (OSError, ValueError):
            with self._lock:
                self._pending_process_claims.pop(claim_id, None)
            _terminate_tree(proc, force=True)
            raise RuntimeError(
                "Supraspina could not hand process ownership to the main process."
            ) from None
        claim_started = time.monotonic()
        if not accepted.wait(_PROCESS_CLAIM_TIMEOUT_SECONDS):
            with self._lock:
                self._pending_process_claims.pop(claim_id, None)
            _terminate_tree(proc, force=True)
            raise RuntimeError(
                "Process ownership was not accepted before the timeout "
                f"({int(_PROCESS_CLAIM_TIMEOUT_SECONDS)} s)."
            )
        claim_seconds = time.monotonic() - claim_started
        if claim_seconds > _PROCESS_CLAIM_SLOW_SECONDS:
            owner["acceptedAfterSeconds"] = round(claim_seconds, 1)
        owner["accepted"] = True
        owner["state"] = "accepted"
        owner["acceptedAt"] = _now_ms()
        return int(owner["pgid"])

    def accept_process_claim(self, request: dict[str, Any]) -> dict[str, bool]:
        """Accept only the exact pending claim acknowledged by main."""
        if not isinstance(request, dict) or request.get("accepted") is not True:
            raise ValueError("Provide a valid process claim acceptance.")
        claim_id = str(request.get("claimId") or "")
        with self._lock:
            pending = self._pending_process_claims.get(claim_id)
            if pending is None:
                raise ValueError("Refresh the stale process claim acceptance.")
            expected, event = pending
            if self._owner_identity(request) != expected:
                raise ValueError("Match the pending process claim exactly.")
            self._pending_process_claims.pop(claim_id, None)
            event.set()
        return {"accepted": True}

    def announce_process_settled(
        self, owner: str | dict[str, Any], proc: Any, pgid: int | None
    ) -> bool:
        """Notify main only after the subprocess tree is proved stopped."""
        proved = _settle_group(proc, pgid)
        pid = getattr(proc, "pid", None)
        registered = (
            self.supervisor_generation is None
            or not isinstance(owner, dict)
            or owner.get("registered") is True
        )
        if registered and isinstance(pid, int) and pid > 1 and pgid is not None:
            if isinstance(owner, dict):
                payload = {
                    **self._owner_identity(owner),
                    "provedStopped": proved,
                }
            else:
                payload = {
                    "generation": self.supervisor_generation,
                    "jobId": owner,
                    "pid": pid,
                    "pgid": pgid,
                    "provedStopped": proved,
                }
                if self.supervisor_generation is None:
                    payload.pop("generation")
            self._emit("system.processSettled", payload)
        return proved

    def release_process_owner(self, owner: dict[str, Any]) -> None:
        """Remove one operation registration after its last process settles."""
        if self.supervisor_generation is not None and owner.get("registered") is True:
            self._emit("system.processOwnerReleased", self._owner_identity(owner))

    def reconcile_process_owner(self, owner: Any) -> tuple[str, dict[str, Any] | None]:
        """Terminate a persisted owner iff its anti-reuse identity still matches.

        Return ``("stopped", record)`` only after proving that the old tree is
        gone or that another process reused the PID. Keep permission-denied,
        malformed, and otherwise unprovable records ``unknown``.
        """
        if not isinstance(owner, dict):
            return "unknown", None
        record = copy.deepcopy(owner)
        pid = record.get("pid")
        pgid = record.get("pgid")
        epoch = record.get("projectEpoch")
        generation = record.get("generation")
        operation_kind = record.get("operationKind")
        owner_id = record.get("ownerId")
        project_id = record.get("projectId")
        run_id = record.get("runId")
        job_id = record.get("jobId")
        operation_id = record.get("operationId")
        claim_id = record.get("claimId")
        start_identity = record.get("startIdentity")
        if (
            record.get("schemaVersion") != _PROCESS_OWNER_VERSION
            or operation_kind not in {"workflow", "provision"}
            or not isinstance(claim_id, str)
            or not claim_id.startswith("claim-")
            or len(claim_id) > _MAX_PROCESS_CLAIM_ID_CHARS
            or any(char in claim_id for char in "\0\r\n")
            or not isinstance(owner_id, str)
            or not owner_id
            or len(owner_id) > _MAX_PROCESS_OWNER_ID_CHARS
            or any(char in owner_id for char in "\0\r\n")
            or not isinstance(project_id, str)
            or not project_id
            or len(project_id) > _MAX_PROCESS_OWNER_ID_CHARS
            or any(char in project_id for char in "\0\r\n")
            or not _strict_safe_integer(generation)
            or not _strict_safe_integer(epoch)
            or not _strict_safe_integer(pid, minimum=2)
            or not _strict_safe_integer(pgid, minimum=2)
            or pgid != pid
            or not _process_start_identity_syntax_valid(start_identity)
            or (
                operation_kind == "workflow"
                and (
                    job_id != owner_id
                    or not isinstance(run_id, str)
                    or not run_id
                    or len(run_id) > _MAX_PROCESS_RUN_ID_CHARS
                    or operation_id is not None
                )
            )
            or (
                operation_kind == "provision"
                and (
                    operation_id != owner_id or run_id is not None or job_id is not None
                )
            )
        ):
            return "unknown", record
        if record.get("provedStopped") is True:
            record["state"] = "settled"
            return "stopped", record
        identity_state, current_identity = _process_start_identity(pid)
        if identity_state == "unknown":
            record["state"] = "unknown"
            record["provedStopped"] = False
            record["detail"] = "The process identity could not be verified."
            return "unknown", record
        if identity_state == "alive" and current_identity != start_identity:
            record["state"] = "settled"
            record["provedStopped"] = True
            record["settledAt"] = _now_ms()
            record["detail"] = (
                "The prior owner is gone: another process reused the recorded PID."
            )
            return "stopped", record

        if os.name == "nt":
            if identity_state == "dead":
                record["state"] = "settled"
                record["provedStopped"] = True
                record["settledAt"] = _now_ms()
                return "stopped", record
            try:
                subprocess.run(  # noqa: S603
                    ["taskkill", "/PID", str(pid), "/T", "/F"],  # noqa: S607
                    check=False,
                    capture_output=True,
                    timeout=10,
                )
            except (OSError, subprocess.SubprocessError):
                record["state"] = "unknown"
                record["provedStopped"] = False
                record["detail"] = "Process-tree termination could not be verified."
                return "unknown", record
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                state, identity = _process_start_identity(pid)
                if state == "dead" or (state == "alive" and identity != start_identity):
                    record["state"] = "settled"
                    record["provedStopped"] = True
                    record["settledAt"] = _now_ms()
                    return "stopped", record
                if state == "unknown":
                    break
                time.sleep(0.02)
            record["state"] = "unknown"
            record["provedStopped"] = False
            record["detail"] = "Process-tree termination could not be verified."
            return "unknown", record

        group_state = _process_group_state(pgid)
        if group_state == "dead":
            record["state"] = "settled"
            record["provedStopped"] = True
            record["settledAt"] = _now_ms()
            return "stopped", record
        if group_state == "unknown":
            record["state"] = "unknown"
            record["provedStopped"] = False
            record["detail"] = "Process-group ownership could not be verified."
            return "unknown", record
        for sig, delay in ((signal.SIGTERM, 1.0), (signal.SIGKILL, 1.0)):
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                record["state"] = "settled"
                record["provedStopped"] = True
                record["settledAt"] = _now_ms()
                return "stopped", record
            except PermissionError:
                record["state"] = "unknown"
                record["provedStopped"] = False
                record["detail"] = "Permission to settle the process group was denied."
                return "unknown", record
            except OSError:
                record["state"] = "unknown"
                record["provedStopped"] = False
                record["detail"] = "Process-group termination could not be verified."
                return "unknown", record
            deadline = time.monotonic() + delay
            while time.monotonic() < deadline:
                state = _process_group_state(pgid)
                if state == "dead":
                    record["state"] = "settled"
                    record["provedStopped"] = True
                    record["settledAt"] = _now_ms()
                    return "stopped", record
                if state == "unknown":
                    record["state"] = "unknown"
                    record["provedStopped"] = False
                    record["detail"] = "Process-group exit could not be verified."
                    return "unknown", record
                time.sleep(0.02)
        record["state"] = "unknown"
        record["provedStopped"] = False
        record["detail"] = (
            "The process group was still running after bounded termination."
        )
        return "unknown", record

    @property
    def closing(self) -> bool:
        """Return whether scheduler shutdown has begun."""
        with self._lock:
            return self._closing

    def _environment(self, cfg: dict[str, Any]) -> dict[str, Any]:
        if self._env_check is not None:
            return self._env_check(cfg)
        from .env import check  # noqa: PLC0415

        return check(cfg)

    def _validate_request(
        self, request: dict[str, Any], *, require_cfg: bool = True
    ) -> ProjectIdentity:
        if self.closing:
            raise RuntimeError("Wait for the sidecar to finish closing.")
        cfg = (
            request.get("cfg")
            if require_cfg and isinstance(request.get("cfg"), dict)
            else None
        )
        if require_cfg:
            validate_config_revision(request.get("configRevision", 0))
        return self.project_epochs.validate(request.get("project"), cfg)

    @staticmethod
    def _approved_plan(request: dict[str, Any]) -> tuple[str, str]:
        """Return the exact reviewed plan identity or fail closed."""
        approved = request.get("approvedPlan")
        if not isinstance(approved, dict):
            raise PlanStaleError
        plan_id = approved.get("planId")
        digest = approved.get("digest")
        if (
            not isinstance(plan_id, str)
            or _PLAN_ID_PATTERN.fullmatch(plan_id) is None
            or not isinstance(digest, str)
            or _DIGEST_PATTERN.fullmatch(digest) is None
        ):
            raise PlanStaleError
        return plan_id, digest

    @staticmethod
    def _plan_resources(cfg: dict[str, Any], report: dict[str, Any]) -> dict[str, Any]:
        runtime = cfg.get("runtime", {}) if isinstance(cfg.get("runtime"), dict) else {}
        queue_raw = runtime.get("queueSize", 2)
        queue_size = 2
        if (
            not isinstance(queue_raw, bool)
            and isinstance(queue_raw, (int, float))
            and math.isfinite(float(queue_raw))
        ):
            queue_size = int(queue_raw)
        threshold_raw = runtime.get("memoryWarningGB", 10)
        threshold = 10.0
        if (
            not isinstance(threshold_raw, bool)
            and isinstance(threshold_raw, (int, float))
            and math.isfinite(float(threshold_raw))
        ):
            threshold = float(threshold_raw)
        available_raw = report.get("availableMemoryGB")
        available = None
        if (
            not isinstance(available_raw, bool)
            and isinstance(available_raw, (int, float))
            and math.isfinite(float(available_raw))
        ):
            available = float(available_raw)
        return {
            "queueSize": max(1, queue_size),
            "availableMemoryGB": available,
            "memoryWarningGB": threshold,
            "lowMemory": available is not None and available < threshold,
        }

    @staticmethod
    def _plan_resource_binding(resources: dict[str, Any]) -> dict[str, Any]:
        """Return only resource values that can invalidate a reviewed plan."""
        return {
            "queueSize": resources["queueSize"],
            "memoryWarningGB": resources["memoryWarningGB"],
            "lowMemory": resources["lowMemory"],
        }

    def _complete_plan_binding(
        self,
        planned: PlannedWorkflow,
        request: dict[str, Any],
        project: ProjectIdentity,
        report: dict[str, Any],
        *,
        recovery_binding: dict[str, Any] | None = None,
    ) -> None:
        """Bind the reviewed projection to every material execution input."""
        cfg = request["cfg"]
        plan = planned.result["plan"]
        plan_id = str(plan.get("planId") or "")
        if _PLAN_ID_PATTERN.fullmatch(plan_id) is None:
            raise ValueError(
                "Reject the planned workflow because its plan identity is invalid."
            )
        qc_records = load_qc_records(cfg)
        registry_records = RegistryStore(project.root).list(cfg)
        resources = self._plan_resources(cfg, report)
        resource_binding = self._plan_resource_binding(resources)
        plan["configDigest"] = stable_digest(cfg)
        plan["qcDigest"] = stable_digest(qc_records)
        plan["registryDigest"] = stable_digest(registry_records)
        plan["environmentDigest"] = stable_digest(
            {
                "checks": self._environment_summary(report),
                "resources": resource_binding,
            }
        )
        plan["resources"] = resources
        if planned.cohort is not None:
            plan["exclusions"] = {
                "qcFailedSubjectIds": list(planned.cohort.excluded_by_qc),
                "configExcludedSubjectIds": list(planned.cohort.excluded_by_config),
            }
        else:
            plan.setdefault(
                "exclusions",
                {
                    "qcFailedSubjectIds": [],
                    "configExcludedSubjectIds": [],
                },
            )
        if recovery_binding is not None:
            plan["recovery"] = copy.deepcopy(recovery_binding)
        digest_plan = copy.deepcopy(plan)
        digest_plan.pop("digest", None)
        # The per-subject reuse forecast reads byte counts only; the launch
        # decides again from content digests, so it binds nothing here.
        digest_plan.pop("unitReuse", None)
        digest_plan["resources"] = resource_binding
        plan["digest"] = stable_digest(
            {
                "bindingVersion": 1,
                "projectId": project.project_id,
                "projectEpoch": project.epoch,
                "configRevision": validate_config_revision(
                    request.get("configRevision", 0)
                ),
                "intent": copy.deepcopy(request.get("intent", {})),
                "acknowledgements": validate_workflow_acknowledgements(
                    request.get("acknowledgements")
                ),
                "plan": digest_plan,
            }
        )

    @staticmethod
    def _sync_runtime_blockers(planned: PlannedWorkflow) -> None:
        """Expose runtime detector/readiness failures in the reviewed blocker list."""
        plan = planned.result["plan"]
        blockers = plan.setdefault("blockers", [])
        existing = {
            (str(blocker.get("key")), str(blocker.get("reason")))
            for blocker in blockers
            if isinstance(blocker, dict)
        }
        for node in plan.get("nodes", []):
            if node.get("status") != "blocked" or not node.get("reason"):
                continue
            identity = (str(node.get("stepKey")), str(node.get("reason")))
            if identity in existing:
                continue
            blocker = {
                "key": identity[0],
                "reason": identity[1],
                "kind": (
                    "integrity" if "integrity" in identity[1].lower() else "runtime"
                ),
            }
            if identity[0] in {"enigma", "features", "aggregate"} and (
                identity[1].startswith("Rerun recon before ")
                or "recon->" in identity[1]
                or "mixed current reconstruction backends" in identity[1]
            ):
                blocker["action"] = "normalize-reconstruction-cohort"
            blockers.append(blocker)
            existing.add(identity)

    def _prepare_plan(
        self,
        request: dict[str, Any],
        project: ProjectIdentity,
        report: dict[str, Any],
        *,
        run_id: str | None = None,
    ) -> tuple[PlannedWorkflow, dict[str, Any] | None, _RunContext | None]:
        """Build the exact schedulable projection without durable run mutation."""
        planning_request = {
            **request,
            "_inputFovReviewManager": self.input_fov_reviews,
        }
        planned = build_plan(
            planning_request,
            run_id=run_id,
            env_report=report,
        )
        state: dict[str, Any] | None = None
        ctx: _RunContext | None = None
        if planned.cohort is not None and planned.result["plan"]["nodes"]:
            actual_dry_run = bool(
                request["cfg"].get("runtime", {}).get("dryRun", False)
            )
            state = self._new_state(
                planned.result["plan"]["planId"],
                request,
                project,
                planned,
                actual_dry_run,
                report,
            )
            ctx = _RunContext(
                state=state,
                cfg=copy.deepcopy(request["cfg"]),
                effective_cfg=planned.effective_cfg,
                cohort=planned.cohort,
                project=project,
                store=RunStore(project.root),
                queue_limit=max(
                    1,
                    int(request["cfg"].get("runtime", {}).get("queueSize", 2)),
                ),
            )
            with self._planning_pass(ctx):
                self._apply_runtime_policy(ctx)
                self._apply_stage_readiness(ctx)
                unit_forecast = self._unit_forecast(ctx)
            planned.result["plan"]["nodes"] = copy.deepcopy(state["nodes"])
            if unit_forecast:
                planned.result["plan"]["unitReuse"] = unit_forecast
            planned.result["summary"] = self._state_summary(state)
            planned.result["plan"]["summary"] = planned.result["summary"]
            if not any(
                node["status"] in {"planned", "waiting"} for node in state["nodes"]
            ):
                planned.result["disposition"] = (
                    "blocked"
                    if any(node["status"] == "blocked" for node in state["nodes"])
                    else "noop"
                )
        self._sync_runtime_blockers(planned)
        self._complete_plan_binding(planned, request, project, report)
        if state is not None:
            state["planBinding"] = {
                key: copy.deepcopy(planned.result["plan"].get(key))
                for key in (
                    "planId",
                    "digest",
                    "configDigest",
                    "qcDigest",
                    "registryDigest",
                    "environmentDigest",
                    "resources",
                    "exclusions",
                )
            }
        return planned, state, ctx

    def plan(self, request: dict[str, Any]) -> dict[str, Any]:
        """Build an authoritative workflow plan without scheduling work.

        Planning writes nothing: no run state and no receipt file.
        """
        project = self._validate_request(request)
        with scientific_assets.resolution_scope():
            report = self._environment(request["cfg"])
            planned, _state, _ctx = self._prepare_plan(request, project, report)
        return planned.result

    def run(self, request: dict[str, Any]) -> dict[str, Any]:
        """Authorize, persist, and schedule one workflow request."""
        project = self._validate_request(request)
        approved_plan_id, approved_digest = self._approved_plan(request)
        config_revision = validate_config_revision(request.get("configRevision", 0))
        cfg = request["cfg"]
        dry_run = bool(cfg.get("runtime", {}).get("dryRun", False))
        if not dry_run and self.project_active(project.project_id):
            raise ValueError(
                "Wait for the active workflow to finish before starting another for "
                "this project."
            )
        if not dry_run:
            self.reconcile_project_ownership(project.to_dict())
        if not dry_run and self.project_active(project.project_id):
            raise ValueError(
                "Wait for the active workflow to finish before starting another for "
                "this project."
            )
        store = RunStore(project.root)
        if approved_plan_id in store.run_ids():
            raise PlanStaleError
        with scientific_assets.resolution_scope():
            env_report = self._environment(cfg)
            planned, state, ctx = self._prepare_plan(
                request, project, env_report, run_id=approved_plan_id
            )
        current_digest = planned.result["plan"].get("digest")
        if (
            planned.result["plan"].get("planId") != approved_plan_id
            or current_digest != approved_digest
        ):
            raise PlanStaleError
        if not dry_run:
            authorization = request.get("liveExecutionAuthorization")
            if (
                isinstance(authorization, dict)
                and authorization.get("planDigest") != approved_digest
            ):
                raise PlanStaleError
            self.authorizations.consume(
                authorization,
                project_id=project.project_id,
                config_revision=config_revision,
                purpose="live-workflow",
            )
        if planned.cohort is None or planned.result["disposition"] in {
            "noop",
            "blocked",
        }:
            planned.result["runId"] = None
            return planned.result
        if state is None or ctx is None:
            raise RuntimeError(
                "Rebuild the authoritative plan context before starting the workflow."
            )
        if dry_run:
            self._materialize_dry_run_jobs(ctx)
        self._commit(ctx)
        if dry_run:
            planned.result["runId"] = approved_plan_id
            planned.result["disposition"] = "planned"
            for job in ctx.state["jobs"]:
                self._emit_job(ctx, job)
            self._emit_run(ctx)
            # Say plainly that a dry run executes nothing; the plan-total
            # sentence alone reads as if work had started.
            count = len(ctx.state["jobs"])
            planned.result["summary"]["message"] = (
                f"Dry run only: planned {count} command"
                f"{'' if count == 1 else 's'} and executed nothing. Turn off "
                "Dry run first to execute."
            )
            return planned.result
        # Count the run's jobs before the scheduler is woken: a worker may
        # take nodes at once, and a count taken after it undercounts ("0
        # jobs queued" for a one-job run). The message is only returned; the
        # plan digest and the run record were fixed before it.
        queued = sum(
            1
            for node in ctx.state["nodes"]
            if node.get("status") in {"planned", "waiting"}
        )
        with self._wake:
            self._runs[approved_plan_id] = ctx
            self._wake.notify_all()
        planned.result["runId"] = approved_plan_id
        planned.result["disposition"] = "started"
        self._emit_run(ctx)
        # Say that work is now running and where to watch it; the plan-total
        # sentence alone does not tell the operator anything started.
        planned.result["summary"]["message"] = (
            f"Started run {approved_plan_id}: {queued} job"
            f"{'' if queued == 1 else 's'} queued. Watch In flight here and the "
            "output in Logs."
        )
        return planned.result

    @contextmanager
    def _planning_pass(self, ctx: _RunContext) -> Iterator[None]:
        """Memoize expected signatures and resource resolution for one plan.

        A plan checks every node's receipt, and each check recomputed the
        whole lineage beneath it, re-validating the resource generation for
        every bound action. Inside this pass each lineage node is digested
        once and the generation is validated once.
        Leave the pass before any launch binding: the scheduler digests its
        inputs afresh.
        """
        previous = ctx.expected_memo
        ctx.expected_memo = {} if previous is None else previous
        try:
            with scientific_assets.resolution_scope():
                yield
        finally:
            ctx.expected_memo = previous

    @staticmethod
    def _receipt_from_state(
        ctx: _RunContext,
        step_key: str,
        subject_id: str | None,
        signature: str,
    ) -> dict[str, Any] | None:
        """Return one digest-valid receipt from the in-memory run state."""
        return next(
            (
                item
                for item in reversed(ctx.state.get("receipts", []))
                if item.get("stepKey") == step_key
                and item.get("subjectId") == subject_id
                and receipt_signature_valid(item, signature)
            ),
            None,
        )

    def _matching_receipt(
        self,
        ctx: _RunContext,
        step_key: str,
        subject_id: str | None,
        signature: str,
    ) -> dict[str, Any] | None:
        """Return the current digest-valid receipt for one node."""
        receipt = self._receipt_from_state(ctx, step_key, subject_id, signature)
        if receipt is None:
            receipt = ctx.store.get_receipt(
                step_key, str(subject_id or "cohort"), signature
            )
        return receipt

    def _current_receipt(
        self, ctx: _RunContext, node: dict[str, Any]
    ) -> dict[str, Any] | None:
        step_key = str(node["stepKey"])
        subject_id = node.get("subjectId")
        signature, _payload = self._expected(ctx, step_key, subject_id)
        receipt = self._matching_receipt(ctx, step_key, subject_id, signature)
        evidence = detector_evidence(ADAPTERS[step_key], ctx.effective_cfg, subject_id)
        evidence = enrich_evidence(step_key, evidence, ctx.effective_cfg, ctx.cohort)
        if (
            receipt is not None
            and evidence_is_done(receipt.get("detectorEvidence", {}))
            and evidence_is_done(evidence)
            and evidence_identity(receipt.get("detectorEvidence", {}))
            == evidence_identity(evidence)
        ):
            return receipt
        return None

    def _apply_runtime_policy(self, ctx: _RunContext) -> None:
        """Apply canonical reuse and non-destructive incomplete-output policy."""
        runtime = (
            ctx.cfg.get("runtime", {})
            if isinstance(ctx.cfg.get("runtime"), dict)
            else {}
        )
        resume_completed = bool(runtime.get("resumeCompleted", True))
        rerun_incomplete = bool(runtime.get("rerunIncomplete", False))
        for node in ctx.state["nodes"]:
            if node["status"] not in {"planned", "waiting"}:
                continue
            identity = (node.get("stepKey"), node.get("subjectId"))
            force_retry = identity in ctx.forced_retry_identities
            current_receipt = (
                self._current_receipt(ctx, node)
                if resume_completed and not force_retry
                else None
            )
            if resume_completed and not force_retry:
                receipt = current_receipt
                if receipt is not None:
                    node["status"] = "skipped"
                    node["reason"] = "The current detector-backed receipt is reused."
                    if not any(
                        item.get("signature") == receipt.get("signature")
                        for item in ctx.state["receipts"]
                    ):
                        ctx.state["receipts"].append(receipt)
                    continue
            evidence = detector_evidence(
                ADAPTERS[node["stepKey"]], ctx.effective_cfg, node.get("subjectId")
            )
            if node["stepKey"] == "recon" and evidence.get("state") == "done":
                if current_receipt is None and not resume_completed and not force_retry:
                    current_receipt = self._current_receipt(ctx, node)
                if current_receipt is None and not force_retry:
                    node["status"] = "blocked"
                    node["reason"] = _RECONSTRUCTION_OUTPUT_CONFLICT_REASON
                    ctx.state.setdefault("warnings", []).append(node["reason"])
                    continue
            if evidence.get("state") == "unknown":
                node["status"] = "blocked"
                node["reason"] = (
                    "Resolve the integrity check failure: "
                    f"{evidence.get('detail') or 'Recheck unknown detector evidence.'}"
                )
                ctx.state.setdefault("warnings", []).append(node["reason"])
                continue
            unusable = _unusable_interpreter(
                ADAPTERS[node["stepKey"]], ctx.effective_cfg, node.get("subjectId")
            )
            if unusable is not None:
                node["status"] = "blocked"
                node["reason"] = unusable
                ctx.state.setdefault("warnings", []).append(node["reason"])
                continue
            if (
                evidence.get("state") in {"partial", "failed"}
                and not rerun_incomplete
                and not force_retry
            ):
                node["status"] = "blocked"
                node["reason"] = (
                    "Enable runtime.rerunIncomplete before rerunning incomplete "
                    "output non-destructively."
                )
                ctx.state.setdefault("warnings", []).append(node["reason"])
                continue
            node["reason"] = self._run_reason(
                ctx, node, reuse=resume_completed, force_retry=force_retry
            )
        ctx.state["manifest"] = self._manifest(ctx.state)

    def _run_reason(
        self,
        ctx: _RunContext,
        node: dict[str, Any],
        *,
        reuse: bool,
        force_retry: bool,
    ) -> str:
        """Say why a node the plan runs does not reuse a receipt.

        Call this only for a node that the runtime policy leaves runnable, so
        no current receipt matched it. Inside a planning pass the expected
        digest is already memoized. The reason is review text: it enters the
        plan and its digest, never a receipt or an expected signature.
        """
        if force_retry:
            return _RUN_REASON_RETRY_SELECTED
        if not reuse:
            return _RUN_REASON_REUSE_OFF
        step_key = str(node["stepKey"])
        subject_id = node.get("subjectId")
        subject_key = str(subject_id or "cohort")
        published = set(ctx.store.receipt_signatures(step_key, subject_key))
        state_receipts = {
            str(item.get("signature")): item
            for item in ctx.state.get("receipts", [])
            if item.get("stepKey") == step_key and item.get("subjectId") == subject_id
        }
        published.update(state_receipts)
        if not published:
            return _RUN_REASON_NO_RECEIPT
        try:
            signature, _payload = self._expected(ctx, step_key, subject_id)
            matched = self._matching_receipt(ctx, step_key, subject_id, signature)
        except (OSError, TypeError, ValueError):
            return _RUN_REASON_UNRESOLVED
        if matched is not None:
            # The inputs still match a receipt, so the detector evidence on
            # disk is what no longer matches it.
            return _RUN_REASON_OUTPUT_CHANGED
        if STEP_BY_KEY[step_key]["scope"] != "cohort":
            return _RUN_REASON_INPUTS_CHANGED
        # A cohort receipt binds the analysis-cohort digest verbatim. When no
        # readable receipt bound the current cohort, the cohort changed after
        # the stage last ran.
        readable = False
        for published_signature in sorted(published):
            receipt = state_receipts.get(published_signature)
            if receipt is None and _DIGEST_PATTERN.fullmatch(published_signature):
                receipt = ctx.store.get_receipt(
                    step_key, subject_key, published_signature
                )
            if receipt is None:
                continue
            readable = True
            if receipt.get("analysisCohortDigest") == ctx.cohort.analysis_digest:
                return _RUN_REASON_INPUTS_CHANGED
        return _RUN_REASON_COHORT_CHANGED if readable else _RUN_REASON_UNRESOLVED

    def _reconstruction_output_conflict(
        self, ctx: _RunContext, node: dict[str, Any]
    ) -> str | None:
        """Return a bounded reason when a fixed Recon tree cannot be reused."""
        if node.get("stepKey") != "recon":
            return None
        status = ADAPTERS["recon"].detect(ctx.effective_cfg, node.get("subjectId"))
        if status.state != "done":
            return None
        if self._current_receipt(ctx, node) is not None:
            return None
        return _RECONSTRUCTION_OUTPUT_CONFLICT_REASON

    def _apply_stage_readiness(self, ctx: _RunContext) -> None:
        """Apply logical producer receipts to direct-stage plans, including dry run."""
        if ctx.state.get("intent", {}).get("kind") != "stage":
            return
        by_id = {node["nodeId"]: node for node in ctx.state["nodes"]}
        for node in ctx.state["nodes"]:
            if node["status"] not in {"planned", "waiting"}:
                continue
            readiness, reason = self._readiness(ctx, node, by_id)
            if readiness == "blocked":
                node["status"] = "blocked"
                node["reason"] = reason
            elif readiness == "wait":
                node["status"] = "waiting"

    def _new_state(
        self,
        run_id: str,
        request: dict[str, Any],
        project: ProjectIdentity,
        planned: PlannedWorkflow,
        dry_run: bool,
        env_report: dict[str, Any],
    ) -> dict[str, Any]:
        now = _now_ms()
        nodes = copy.deepcopy(planned.result["plan"]["nodes"])
        if dry_run:
            for node in nodes:
                if node["status"] in {"planned", "waiting"}:
                    node["status"] = "planned"
        state = {
            "schemaVersion": 1,
            "runId": run_id,
            "project": project.to_dict(),
            "configRevision": validate_config_revision(
                request.get("configRevision", 0)
            ),
            "config": copy.deepcopy(request["cfg"]),
            "configSha256": _config_sha(request["cfg"]),
            "intent": copy.deepcopy(request.get("intent", {})),
            "acknowledgements": validate_workflow_acknowledgements(
                request.get("acknowledgements")
            ),
            "scope": planned.cohort.to_dict() if planned.cohort else {},
            "nodes": nodes,
            "jobs": [],
            "receipts": [],
            "warnings": list(planned.warnings),
            "baseline": dict(BASELINE),
            "environmentEvidence": self._environment_summary(env_report),
            "providerEvidence": self._provider_summary(env_report),
            "scientificEvidence": copy.deepcopy(
                planned.result.get("plan", {}).get("scientificEvidence", {})
            ),
            "status": "planned" if dry_run else "queued",
            "terminalReason": "dry_run" if dry_run else None,
            "startedAtMs": now,
            "endedAtMs": now if dry_run else None,
            "dryRun": dry_run,
            "durable": False,
            "failurePolicy": {
                "stopOnError": bool(
                    request["cfg"].get("runtime", {}).get("stopOnError", False)
                ),
                "continueIndependentAfterError": bool(
                    request["cfg"]
                    .get("runtime", {})
                    .get("continueIndependentAfterError", False)
                ),
            },
            "sidecarGeneration": self.sidecar_generation,
        }
        state["manifest"] = self._manifest(state)
        return state

    @staticmethod
    def _environment_summary(report: dict[str, Any]) -> dict[str, Any]:
        roots = active_resource_root_spellings()
        return {
            str(check.get("id")): environment_check_evidence(check, roots)
            for group in report.get("groups", [])
            for check in group.get("checks", [])
        }

    @staticmethod
    def _provider_summary(report: dict[str, Any]) -> dict[str, Any]:
        """Retain bounded scientific-provider versions without host paths."""
        for group in report.get("groups", []):
            for check in group.get("checks", []):
                if check.get("id") not in {"reconall", "fshome"}:
                    continue
                detail = check.get("detail")
                if not isinstance(detail, str):
                    continue
                match = _FREESURFER_RELEASE_PATTERN.search(detail)
                if match is None:
                    continue
                version = match.group(1).strip()[:256]
                if version:
                    return {"freesurfer": {"version": version}}
        return {}

    def _commit(self, ctx: _RunContext) -> None:
        ctx.state["manifest"] = self._manifest(ctx.state)
        generation = ctx.store.commit(ctx.state)
        ctx.state["generation"] = generation
        ctx.state["durable"] = True

    def _manifest(self, state: dict[str, Any]) -> dict[str, Any]:
        nodes = state.get("nodes", [])
        steps = []
        for descriptor in STEP_BY_KEY.values():
            matches = [
                node for node in nodes if node.get("stepKey") == descriptor["key"]
            ]
            if not matches:
                continue
            statuses = {node.get("status") for node in matches}
            # Report a stage whose nodes were all skipped as skipped, so a
            # stage that executed nothing never claims completion. A stage
            # mixing completed and skipped nodes remains done.
            settled = "planned"
            if statuses <= {"done", "skipped"}:
                settled = "skipped" if statuses == {"skipped"} else "done"
            status = next(
                (
                    candidate
                    for candidate in (
                        "unknown",
                        "failed",
                        "blocked",
                        "withheld",
                        "interrupted",
                        "running",
                        "queued",
                        "cancelled",
                    )
                    if candidate in statuses
                ),
                settled,
            )
            started = [
                job.get("startedAt")
                for job in state.get("jobs", [])
                if job.get("stepKey") == descriptor["key"] and job.get("startedAt")
            ]
            ended = [
                job.get("endedAt")
                for job in state.get("jobs", [])
                if job.get("stepKey") == descriptor["key"] and job.get("endedAt")
            ]
            duration = (
                max(0, (max(ended) - min(started)) // 1000) if started and ended else 0
            )
            steps.append(
                {
                    "id": descriptor["id"],
                    "key": descriptor["key"],
                    "status": status,
                    "subjects": len(matches),
                    "failed": sum(node.get("status") == "failed" for node in matches),
                    "durationSec": duration,
                }
            )
        terminal = sum(node.get("status") in TERMINAL_NODE_STATES for node in nodes)
        build = build_identity()
        return {
            "schemaVersion": MANIFEST_VERSION,
            "runId": state.get("runId"),
            "project": state.get("project"),
            "startedAt": _iso(state.get("startedAtMs")),
            "endedAt": _iso(state.get("endedAtMs")),
            "user": "[REDACTED]",
            "host": "[REDACTED]",
            # Name the product version and the build that wrote this
            # manifest: the source commit and tracked-change state its
            # package recorded, or an empty commit for a source checkout. The
            # scientific baseline commit is not this run's source.
            "product": {
                "name": PRODUCT_NAME,
                "version": __version__,
                "build": build["kind"],
            },
            "git": {"repo": "", "sha": build["commit"], "dirty": build["dirty"]},
            "configSha256": state.get("configSha256", ""),
            "intent": state.get("intent", {}).get("kind", "workflow"),
            "analysisCohort": {
                "subjectIds": state.get("scope", {}).get("analysisSubjectIds", []),
                "sha256": state.get("scope", {}).get("analysisDigest", ""),
            },
            "selectedSubset": {
                "subjectIds": state.get("scope", {}).get("selectedSubjectIds", []),
                "sha256": state.get("scope", {}).get("selectedDigest", ""),
            },
            "dryRun": bool(state.get("dryRun")),
            "graph": {
                "nodes": len(nodes),
                "edges": sum(len(node.get("dependencies", [])) for node in nodes),
                "terminal": terminal,
                "blocked": sum(
                    node.get("status") in {"blocked", "withheld"} for node in nodes
                ),
            },
            "failurePolicy": state.get("failurePolicy", {}),
            "recovery": state.get("recovery", {"state": "current"}),
            "scientificEvidence": copy.deepcopy(state.get("scientificEvidence", {})),
            "warnings": list(state.get("warnings", []))[:256],
            "steps": steps,
            "tools": {
                key: (
                    f"{value.get('status', 'unknown')}:"
                    f"{value.get('identitySha256', '')}"
                )
                for key, value in state.get("environmentEvidence", {}).items()
            },
        }

    def _scheduler_loop(self) -> None:
        while True:
            with self._wake:
                if self._closing and not self._runs:
                    return
                contexts = list(self._runs.values())
                changed = False
                for ctx in contexts:
                    try:
                        if self._tick(ctx):
                            changed = True
                    except Exception:
                        self._mark_scheduler_failure(ctx)
                        changed = True
                if not changed:
                    self._wake.wait(timeout=0.1)

    def _tick(self, ctx: _RunContext) -> bool:
        if ctx.state.get("dryRun"):
            self._finish_run_if_terminal(ctx)
            return False
        fallback = ctx.state.get("reconstructionFallback")
        if isinstance(fallback, dict) and fallback.get("state") == "settling":
            if self._auto_fallback_has_unsettled_freesurfer(ctx):
                return False
            return self._activate_auto_fallback(ctx)
        nodes = ctx.state["nodes"]
        by_id = {node["nodeId"]: node for node in nodes}
        failure = any(node["status"] == "failed" for node in nodes)
        policy = ctx.state["failurePolicy"]
        if failure and (
            policy["stopOnError"] or not policy["continueIndependentAfterError"]
        ):
            ctx.halt_new = True

        if ctx.halt_new:
            changed = False
            withheld_jobs: list[dict[str, Any]] = []
            for node in nodes:
                if node["status"] not in {"planned", "waiting", "queued"}:
                    continue
                node["status"] = "withheld"
                node["reason"] = (
                    "Withheld by the failure policy after an earlier failure."
                )
                job = next(
                    (
                        value
                        for value in reversed(ctx.state["jobs"])
                        if value["nodeId"] == node["nodeId"]
                        and value["status"] == "queued"
                    ),
                    None,
                )
                if job is not None:
                    job["status"] = "withheld"
                    job["endedAt"] = _now_ms()
                    job["terminalReason"] = "failure_policy_withheld"
                    self._active_jobs.pop(job["id"], None)
                    self._terminal_jobs[job["id"]] = copy.deepcopy(job)
                    withheld_jobs.append(job)
                changed = True
            if changed:
                self._recompute_run(ctx)
                self._commit(ctx)
                for job in withheld_jobs:
                    self._emit_job(ctx, job)
                self._emit_run(ctx)
                return True

        for node in nodes:
            if node["status"] not in {"planned", "waiting"}:
                continue
            readiness, reason = self._readiness(ctx, node, by_id)
            if readiness == "wait":
                node["status"] = "waiting"
                continue
            if readiness == "blocked":
                node["status"] = "blocked"
                node["reason"] = reason
                # Record the block as a durable terminal job so the job-driven
                # surfaces (Logs, the Runs stage counts, the Dashboard, and the
                # run manifests) carry the reason instead of dropping it.
                job = self._new_job(ctx, node)
                job.update(
                    {
                        "startedAt": None,
                        "endedAt": _now_ms(),
                        "stdoutPath": "",
                        "stderrPath": "",
                        "status": "blocked",
                        "durable": True,
                        "persistenceStatus": "durable",
                        "terminalReason": reason,
                    }
                )
                ctx.state["jobs"].append(job)
                self._recompute_run(ctx)
                self._commit(ctx)
                self._emit_job(ctx, job)
                self._emit_run(ctx)
                return True
            node["status"] = "queued"
            job = self._new_job(ctx, node)
            ctx.state["jobs"].append(job)
            self._active_jobs[job["id"]] = job
            self._commit(ctx)
            job["durable"] = True
            job["persistenceStatus"] = "durable"
            self._emit_job(ctx, job)
            return True

        running_count = sum(
            job.get("status") in {"running", "cancelling", "unknown"}
            for context in self._runs.values()
            for job in context.state.get("jobs", [])
        )
        if running_count < ctx.queue_limit:
            for node in nodes:
                if node["status"] != "queued":
                    continue
                job = self._job_for_node(ctx, node["nodeId"])
                node["status"] = "running"
                job["status"] = "running"
                job["startedAt"] = _now_ms()
                cancel_event = threading.Event()
                ctx.cancel_events[job["id"]] = cancel_event
                self._recompute_run(ctx)
                self._commit(ctx)
                job["durable"] = True
                self._emit_job(ctx, job)
                # The recompute above moved the run from its launch-time
                # "queued" to "running"; without a run event every consumer
                # keeps showing the run as queued until a later event lands.
                self._emit_run(ctx)
                thread = threading.Thread(
                    target=self._execute,
                    args=(ctx, node["nodeId"], job["id"], cancel_event),
                    daemon=True,
                    name=f"supraspina-{job['id']}",
                )
                thread.start()
                # Register the thread only once it runs. A commit or a start
                # that fails between the cancel-event registration above and
                # this line leaves no owner for the job, and the scheduler
                # failure path settles exactly the jobs missing from here.
                ctx.execution_threads.add(job["id"])
                return True
        return self._finish_run_if_terminal(ctx)

    @staticmethod
    def _requested_recon_backend(cfg: dict[str, Any]) -> str:
        """Return the persisted reconstruction backend request."""
        steps = cfg.get("steps", {}) if isinstance(cfg.get("steps"), dict) else {}
        recon = steps.get("recon", {}) if isinstance(steps.get("recon"), dict) else {}
        params = (
            recon.get("params", {}) if isinstance(recon.get("params"), dict) else {}
        )
        return str(params.get("backend", FREESURFER_BACKEND))

    @staticmethod
    def _verified_fastsurfer_fallback_is_current(ctx: _RunContext) -> bool:
        """Recheck the exact pre-authorized FastSurfer SIF before fallback."""
        runtime = ctx.effective_cfg.get("_supraspinaRuntime", {})
        if not isinstance(runtime, dict):
            return False
        authorized = runtime.get("authorizedReconBackends")
        if not isinstance(authorized, list) or set(authorized) != {
            FREESURFER_BACKEND,
            FASTSURFER_BACKEND,
        }:
            return False
        if runtime.get("resolvedReconBackend") != FREESURFER_BACKEND:
            return False
        if runtime.get("resolvedFastSurferDevice") not in {"cpu", "cuda"}:
            return False
        sif_path = runtime.get("fastSurferSifPath")
        if not isinstance(sif_path, str) or not sif_path:
            return False
        scientific = ctx.state.get("scientificEvidence", {})
        resources = (
            scientific.get("managedResources", {})
            if isinstance(scientific, dict)
            else {}
        )
        fastsurfer = (
            resources.get("fastsurfer") if isinstance(resources, dict) else None
        )
        if (
            not isinstance(fastsurfer, dict)
            or fastsurfer.get("resource") != "fastsurfer"
            or fastsurfer.get("role") != "authorized-fallback"
            or fastsurfer.get("variant") != runtime.get("resolvedFastSurferDevice")
        ):
            return False
        expected_size = fastsurfer.get("sifBytes")
        expected_sha256 = fastsurfer.get("sifSha256")
        if (
            isinstance(expected_size, bool)
            or not isinstance(expected_size, int)
            or expected_size < 1
            or not isinstance(expected_sha256, str)
            or _DIGEST_PATTERN.fullmatch(expected_sha256) is None
        ):
            return False
        identity = file_identity(sif_path, include_path=False)
        return (
            identity.get("exists") is True
            and identity.get("kind") == "file"
            and identity.get("size") == expected_size
            and identity.get("sha256") == expected_sha256
        )

    def _eligible_auto_fallback(
        self,
        ctx: _RunContext,
        node: dict[str, Any],
        job: dict[str, Any],
        failure: Failure | None,
        *,
        rc: int,
        cancelled: bool,
        reason: str | None,
        process_started: bool,
        settlement_proved: bool,
    ) -> bool:
        """Return whether one settled failure can start authorized fallback."""
        failure_tag = getattr(failure, "tag", None)
        failure_code = getattr(failure, "code", None)
        if (
            failure is None
            or failure_tag not in _AUTO_FALLBACK_REASON_TAGS
            or failure_code != rc
            or rc in {0, 127, OOM_EXIT_CODE}
            or cancelled
            or reason is not None
            or not process_started
            or not settlement_proved
            or ctx.persistence_failed
            or node.get("stepKey") != "recon"
            or job.get("backend") != FREESURFER_BACKEND
            or self._requested_recon_backend(ctx.cfg) != "auto"
            or "reconstructionFallback" in ctx.state
            or any(
                candidate.get("stepKey") == "recon"
                and candidate.get("status") == "unknown"
                for candidate in ctx.state.get("jobs", [])
            )
        ):
            return False
        try:
            if selected_backend(ctx.effective_cfg) != FREESURFER_BACKEND:
                return False
        except ValueError:
            return False
        return self._verified_fastsurfer_fallback_is_current(ctx)

    def _begin_auto_fallback(
        self,
        ctx: _RunContext,
        trigger_node: dict[str, Any],
        trigger_job: dict[str, Any],
        failure: Failure,
    ) -> tuple[list[dict[str, Any]], list[Any]]:
        """Cancel remaining FreeSurfer jobs and persist a settling fallback."""
        reason_tag = _AUTO_FALLBACK_REASON_TAGS.get(failure.tag)
        if reason_tag is None:
            raise ValueError("Start automatic fallback only after an eligible failure.")
        recon_nodes = [
            node for node in ctx.state["nodes"] if node.get("stepKey") == "recon"
        ]
        subject_ids = [
            str(node["subjectId"])
            for node in recon_nodes
            if isinstance(node.get("subjectId"), str)
        ]
        if not subject_ids or trigger_node not in recon_nodes:
            raise ValueError(
                "Include at least one Reconstruction subject before starting "
                "automatic fallback."
            )

        now = _now_ms()
        ctx.halt_new = True
        ctx.state["reconstructionFallback"] = {
            "state": "settling",
            "fromBackend": FREESURFER_BACKEND,
            "toBackend": FASTSURFER_BACKEND,
            "reasonTag": reason_tag,
            "triggerJobId": trigger_job["id"],
            "subjectIds": subject_ids,
            "requestedAtMs": now,
            "activatedAtMs": None,
        }

        changed_jobs: list[dict[str, Any]] = []
        processes: list[Any] = []
        recon_node_by_id = {node["nodeId"]: node for node in recon_nodes}
        for candidate in ctx.state.get("jobs", []):
            if (
                candidate.get("stepKey") != "recon"
                or candidate.get("backend") != FREESURFER_BACKEND
                or candidate.get("subjectId") not in subject_ids
            ):
                continue
            candidate["role"] = "superseded-primary"
            candidate["fallbackReasonTag"] = reason_tag
            if candidate["id"] == trigger_job["id"]:
                continue
            if candidate.get("status") not in ACTIVE_JOB_STATES:
                continue
            event = ctx.cancel_events.setdefault(candidate["id"], threading.Event())
            event.set()
            candidate_node = recon_node_by_id.get(candidate.get("nodeId"))
            if candidate.get("status") == "queued":
                candidate["status"] = "cancelled"
                candidate["endedAt"] = now
                candidate["terminalReason"] = "auto_fallback_superseded"
                if candidate_node is not None:
                    candidate_node["status"] = "waiting"
                    candidate_node["reason"] = (
                        "Waiting for the cohort-wide FastSurfer fallback."
                    )
                self._active_jobs.pop(candidate["id"], None)
                self._terminal_jobs[candidate["id"]] = copy.deepcopy(candidate)
            else:
                candidate["status"] = "cancelling"
                candidate["terminalReason"] = "auto_fallback_cancellation_requested"
                if candidate_node is not None:
                    candidate_node["reason"] = (
                        "FreeSurfer is being canceled so the cohort-wide fallback "
                        "can start."
                    )
                proc = ctx.processes.get(candidate["id"])
                if proc is not None:
                    processes.append(proc)
            changed_jobs.append(candidate)
        for candidate in recon_nodes:
            if candidate["status"] in {"planned", "waiting", "queued"}:
                candidate["status"] = "waiting"
                candidate["reason"] = "Waiting for the cohort-wide FastSurfer fallback."
        self._trim_terminal()
        return changed_jobs, processes

    @staticmethod
    def _auto_fallback_has_unsettled_freesurfer(ctx: _RunContext) -> bool:
        """Return whether a superseded FreeSurfer process may still be active."""
        fallback = ctx.state.get("reconstructionFallback", {})
        subject_ids = (
            set(fallback.get("subjectIds", [])) if isinstance(fallback, dict) else set()
        )
        for job in ctx.state.get("jobs", []):
            if (
                job.get("stepKey") == "recon"
                and job.get("backend") == FREESURFER_BACKEND
                and job.get("subjectId") in subject_ids
                and (
                    job.get("status") in ACTIVE_JOB_STATES
                    or job.get("id") in ctx.processes
                )
            ):
                return True
        return False

    def _activate_auto_fallback(self, ctx: _RunContext) -> bool:
        """Switch the entire authorized recon cohort to FastSurfer attempt two."""
        fallback = ctx.state.get("reconstructionFallback")
        if not isinstance(fallback, dict) or fallback.get("state") != "settling":
            return False
        runtime = ctx.effective_cfg.get("_supraspinaRuntime")
        if not isinstance(runtime, dict):
            fallback["state"] = "blocked"
            fallback["detail"] = "The authorized FastSurfer runtime is missing."
            self._recompute_run(ctx)
            self._commit(ctx)
            self._emit_run(ctx)
            return True
        if not self._verified_fastsurfer_fallback_is_current(ctx):
            fallback["state"] = "blocked"
            fallback["detail"] = (
                "The FastSurfer resource changed before fallback activation."
            )
            self._recompute_run(ctx)
            self._commit(ctx)
            self._emit_run(ctx)
            return True

        # Replace the whole subtree and rebind, so the later restore below
        # builds on the selection made here instead of the stale mapping.
        runtime = {**runtime, "resolvedReconBackend": FASTSURFER_BACKEND}
        ctx.effective_cfg["_supraspinaRuntime"] = runtime
        reason_tag = str(fallback["reasonTag"])
        subject_ids = set(fallback.get("subjectIds", []))
        conflict_subject_ids = sorted(
            str(node["subjectId"])
            for node in ctx.state["nodes"]
            if node.get("stepKey") == "recon"
            and node.get("subjectId") in subject_ids
            and self._reconstruction_output_conflict(ctx, node) is not None
        )
        if conflict_subject_ids:
            fallback["state"] = "blocked"
            fallback["detail"] = _RECONSTRUCTION_OUTPUT_CONFLICT_REASON
            fallback["conflictSubjectIds"] = conflict_subject_ids
            for node in ctx.state["nodes"]:
                if (
                    node.get("stepKey") == "recon"
                    and node.get("subjectId") in subject_ids
                ):
                    node["status"] = "blocked"
                    node["reason"] = _RECONSTRUCTION_OUTPUT_CONFLICT_REASON
            if _RECONSTRUCTION_OUTPUT_CONFLICT_REASON not in ctx.state["warnings"]:
                ctx.state["warnings"].append(_RECONSTRUCTION_OUTPUT_CONFLICT_REASON)
            self._recompute_run(ctx)
            self._commit(ctx)
            self._emit_run(ctx)
            return True
        receipts = [
            receipt
            for receipt in ctx.state.get("receipts", [])
            if receipt.get("stepKey") == "recon"
            and receipt.get("subjectId") in subject_ids
        ]
        prior_by_subject: dict[str, str] = {}
        for receipt in receipts:
            job_id = receipt.get("jobId")
            subject_id = receipt.get("subjectId")
            if isinstance(job_id, str) and isinstance(subject_id, str):
                prior_by_subject[subject_id] = job_id
        for job in ctx.state.get("jobs", []):
            if (
                job.get("stepKey") == "recon"
                and job.get("backend") == FREESURFER_BACKEND
                and isinstance(job.get("subjectId"), str)
                and job.get("subjectId") in subject_ids
            ):
                prior_by_subject[str(job["subjectId"])] = str(job["id"])

        adapter = ADAPTERS["recon"]
        try:
            commands = {
                str(node["subjectId"]): adapter.preview(
                    ctx.effective_cfg, str(node["subjectId"])
                )
                for node in ctx.state["nodes"]
                if node.get("stepKey") == "recon"
                and node.get("subjectId") in subject_ids
            }
        except Exception as exc:
            runtime = {**runtime, "resolvedReconBackend": FREESURFER_BACKEND}
            ctx.effective_cfg["_supraspinaRuntime"] = runtime
            fallback["state"] = "blocked"
            fallback["detail"] = (
                "The FastSurfer fallback command could not be resolved "
                f"({type(exc).__name__})."
            )
            self._recompute_run(ctx)
            self._commit(ctx)
            self._emit_run(ctx)
            return True

        for node in ctx.state["nodes"]:
            subject_id = node.get("subjectId")
            if node.get("stepKey") != "recon" or subject_id not in subject_ids:
                continue
            node["status"] = "planned"
            node.pop("reason", None)
            node.pop("detectorEvidence", None)
            node["backend"] = FASTSURFER_BACKEND
            node["attemptOrdinal"] = 2
            node["role"] = "fallback"
            prior_job_id = prior_by_subject.get(str(subject_id))
            if prior_job_id is not None:
                node["supersedesJobId"] = prior_job_id
            else:
                node.pop("supersedesJobId", None)
            node["fallbackReasonTag"] = reason_tag
            node["command"] = commands[str(subject_id)]

        fallback["state"] = "active"
        fallback["activatedAtMs"] = _now_ms()
        ctx.halt_new = False
        self._recompute_run(ctx)
        self._commit(ctx)
        self._emit_run(ctx)
        return True

    def _new_job(self, ctx: _RunContext, node: dict[str, Any]) -> dict[str, Any]:
        job_id = f"#{uuid.uuid4().hex[:10]}"
        log_path = os.path.join(
            ctx.store.run_dir(ctx.state["runId"]), "logs", f"{job_id[1:]}.log"
        )
        job = {
            "id": job_id,
            "runId": ctx.state["runId"],
            "nodeId": node["nodeId"],
            "projectId": ctx.project.project_id,
            "projectEpoch": ctx.project.epoch,
            "sidecarGeneration": self.sidecar_generation,
            "stepKey": node["stepKey"],
            "subjectId": node["subjectId"],
            "scope": node["scope"],
            "plannedAt": _now_ms(),
            "startedAt": None,
            "endedAt": None,
            "exitCode": None,
            "cmd": node.get("command", ""),
            "stdoutPath": log_path,
            "stderrPath": log_path,
            "envSnapshotPath": "",
            "configSnapshotPath": os.path.join(
                ctx.store.run_dir(ctx.state["runId"]), "state.json"
            ),
            "status": "queued",
            "dryRun": False,
            "durable": False,
            "persistenceStatus": "pending",
            "terminalReason": None,
        }
        metadata = {
            key: copy.deepcopy(node[key])
            for key in (
                "backend",
                "attemptOrdinal",
                "role",
                "supersedesJobId",
                "fallbackReasonTag",
            )
            if key in node and node[key] is not None
        }
        if node["stepKey"] == "recon":
            if "backend" not in metadata:
                from .adapters.fastsurfer import selected_backend  # noqa: PLC0415

                metadata["backend"] = selected_backend(ctx.effective_cfg)
            metadata.setdefault("attemptOrdinal", 1)
            metadata.setdefault("role", "primary")
        job.update(metadata)
        return job

    def _materialize_dry_run_jobs(self, ctx: _RunContext) -> None:
        """Create durable terminal plan records without scheduling execution."""
        if ctx.state["jobs"]:
            raise RuntimeError("Materialize dry-run jobs only once.")
        ended_at = _now_ms()
        for node in ctx.state["nodes"]:
            if node["status"] != "planned":
                continue
            job = self._new_job(ctx, node)
            job.update(
                {
                    "startedAt": None,
                    "endedAt": ended_at,
                    "stdoutPath": "",
                    "stderrPath": "",
                    "status": "planned",
                    "dryRun": True,
                    "durable": True,
                    "persistenceStatus": "durable",
                    "terminalReason": "dry_run",
                }
            )
            ctx.state["jobs"].append(job)
        ctx.state["status"] = "planned"
        ctx.state["terminalReason"] = "dry_run"
        ctx.state["endedAtMs"] = ended_at

    def _job_for_node(self, ctx: _RunContext, node_id: str) -> dict[str, Any]:
        return next(
            job for job in reversed(ctx.state["jobs"]) if job["nodeId"] == node_id
        )

    def _readiness(
        self, ctx: _RunContext, node: dict[str, Any], by_id: dict[str, dict[str, Any]]
    ) -> tuple[str, str | None]:
        dependency_nodes = [
            by_id[value] for value in node.get("dependencies", []) if value in by_id
        ]
        if any(dep["status"] not in TERMINAL_NODE_STATES for dep in dependency_nodes):
            return "wait", None
        bad = [
            dep for dep in dependency_nodes if dep["status"] not in {"done", "skipped"}
        ]
        if bad:
            # Only the scheduler reaches this branch: a workflow plan skips
            # stage readiness and a stage plan has no dependency edges, so the
            # reason never enters a plan or its digest.
            return (
                "blocked",
                blocked_dependency_reason(
                    str(bad[0]["stepKey"]), str(bad[0]["status"])
                ),
            )

        key = node["stepKey"]
        logical_dependencies = self._logical_dependencies(ctx.cfg, key)
        for producer in logical_dependencies:
            if producer == "recon":
                subjects: list[str | None] = list(ctx.cohort.analysis_subject_ids)
            elif STEP_BY_KEY[producer]["scope"] == "subject":
                subjects = [node.get("subjectId")]
            else:
                subjects = [None]
            for subject_id in subjects:
                ready, reason = self._producer_ready(ctx, producer, key, subject_id)
                if not ready:
                    scheduled = any(
                        candidate["stepKey"] == producer
                        and candidate.get("subjectId") == subject_id
                        and candidate["status"] not in TERMINAL_NODE_STATES
                        for candidate in ctx.state["nodes"]
                    )
                    return ("wait", None) if scheduled else ("blocked", reason)
        return "ready", None

    @staticmethod
    def _logical_dependencies(cfg: dict[str, Any], step_key: str) -> list[str]:
        """Return configured data predecessors for one pipeline step."""
        steps = cfg.get("steps", {}) if isinstance(cfg.get("steps"), dict) else {}

        def enabled(key: str) -> bool:
            value = steps.get(key, {}) if isinstance(steps.get(key), dict) else {}
            return bool(value.get("enabled", False))

        if step_key == "deface" and enabled("brainfov"):
            return ["brainfov"]
        if step_key == "recon":
            if enabled("deface"):
                return ["deface"]
            if enabled("brainfov"):
                return ["brainfov"]
        return list(STEP_BY_KEY[step_key]["dependencies"])

    def _expected(
        self,
        ctx: _RunContext,
        step_key: str,
        subject_id: str | None,
        *,
        cached_external_inputs: bool = True,
    ) -> tuple[str, dict[str, Any]]:
        """Build an expected digest using one complete receipt lineage.

        Pass ``cached_external_inputs=False`` on the post-exit proof path so the
        bound external inputs are re-read from disk. The pre-execution identity
        cache is keyed on device, inode, size, and modification time, so a
        same-size rewrite with a restored timestamp would otherwise return the
        pre-execution fingerprint and hide the mutation.

        Inside :meth:`_planning_pass`, compute each lineage node once instead
        of once per node that depends on it. Callers must not mutate the
        returned payload.
        """
        memo = ctx.expected_memo
        key = (step_key, subject_id, cached_external_inputs)
        if memo is not None and key in memo:
            return memo[key]
        upstream: list[str] = []
        for dependency in self._logical_dependencies(ctx.cfg, step_key):
            if dependency == "recon":
                upstream.extend(
                    self._expected(
                        ctx,
                        dependency,
                        sid,
                        cached_external_inputs=cached_external_inputs,
                    )[0]
                    for sid in ctx.cohort.analysis_subject_ids
                )
            elif STEP_BY_KEY[dependency]["scope"] == "subject":
                upstream.append(
                    self._expected(
                        ctx,
                        dependency,
                        subject_id,
                        cached_external_inputs=cached_external_inputs,
                    )[0]
                )
            else:
                upstream.append(
                    self._expected(
                        ctx,
                        dependency,
                        None,
                        cached_external_inputs=cached_external_inputs,
                    )[0]
                )
        if step_key in {"deface", "recon"}:
            runtime = ctx.effective_cfg.get("_supraspinaRuntime", {})
            decisions = (
                runtime.get("inputFovDecisionSignatures", {})
                if isinstance(runtime, dict)
                else {}
            )
            decision = (
                decisions.get(subject_id) if isinstance(decisions, dict) else None
            )
            if isinstance(decision, str) and decision and decision not in upstream:
                upstream.append(decision)
        adapter = ADAPTERS[step_key]
        relevant_tools = bound_tool_evidence(
            ctx.state.get("environmentEvidence", {}),
            adapter.required_check_ids(ctx.effective_cfg),
        )
        signature, payload = expected_signature(
            step_key,
            subject_id,
            ctx.effective_cfg,
            ctx.cohort,
            adapter,
            upstream_signatures=upstream,
            tool_evidence=relevant_tools,
            provider_evidence=ctx.state.get("providerEvidence"),
            cached_external_inputs=cached_external_inputs,
        )
        bound = self._bind_projection_inputs(step_key, signature, payload)
        if memo is not None:
            memo[key] = bound
        return bound

    @staticmethod
    def _bind_projection_inputs(
        step_key: str, signature: str, payload: dict[str, Any]
    ) -> tuple[str, dict[str, Any]]:
        """Bind deterministic source identities for run-scoped projections."""
        return bind_projection_inputs(step_key, signature, payload)

    def _producer_ready(
        self, ctx: _RunContext, producer: str, consumer: str, subject_id: str | None
    ) -> tuple[bool, str]:
        signature, _payload = self._expected(ctx, producer, subject_id)
        receipt = self._matching_receipt(ctx, producer, subject_id, signature)
        adapter = ADAPTERS[producer]
        current = detector_evidence(adapter, ctx.effective_cfg, subject_id)
        current = enrich_evidence(producer, current, ctx.effective_cfg, ctx.cohort)
        if current.get("state") == "unknown":
            detail = current.get("detail") or "Recheck unknown detector evidence."
            return (
                False,
                f"Resolve the integrity check failure for {producer}: {detail}",
            )
        edge = edge_evidence(producer, consumer, ctx.effective_cfg, subject_id, adapter)
        stored_edges = (
            receipt.get("edgeEvidence", {}) if isinstance(receipt, dict) else {}
        )
        stored_edge = (
            stored_edges.get(consumer, {}) if isinstance(stored_edges, dict) else {}
        )
        if (
            isinstance(stored_edges, dict)
            and consumer not in stored_edges
            and uses_detector_edge(producer, consumer, subject_id)
        ):
            # Every detector-evidence edge the receipt lacks falls back here:
            # a config-dependent consumer its run did not have, or a receipt
            # with empty edgeEvidence. Such an edge is the producer's own
            # detector evidence, so the receipt check below decides it.
            stored_edge = edge
        if (
            receipt is not None
            and evidence_is_done(receipt.get("detectorEvidence", {}))
            and evidence_is_done(current)
            and evidence_identity(receipt.get("detectorEvidence", {}))
            == evidence_identity(current)
            and evidence_is_done(stored_edge)
            and evidence_is_done(edge)
            and evidence_identity(stored_edge) == evidence_identity(edge)
        ):
            return True, ""
        if receipt is None:
            return (
                False,
                f"Rerun {producer} before {consumer} because no matching current "
                "provenance receipt exists.",
            )
        return (
            False,
            f"Restore current {producer}->{consumer} required artifacts.",
        )

    def _edge_evidence_for_receipt(
        self, ctx: _RunContext, producer: str, subject_id: str | None
    ) -> dict[str, dict[str, Any]]:
        adapter = ADAPTERS[producer]
        consumers = [
            descriptor["key"]
            for descriptor in STEP_BY_KEY.values()
            if producer in self._logical_dependencies(ctx.cfg, descriptor["key"])
        ]
        return {
            consumer: edge_evidence(
                producer, consumer, ctx.effective_cfg, subject_id, adapter
            )
            for consumer in consumers
        }

    def _prepare_inputs(self, ctx: _RunContext, step_key: str) -> None:
        """Create only the run-scoped inputs consumed by ``step_key``."""
        with ctx.input_lock:
            if step_key in ctx.inputs_ready:
                return
            runtime = ctx.effective_cfg["_supraspinaRuntime"]
            resolver = ADAPTERS[step_key]
            if step_key in {"enigma", "features", "aggregate"}:
                subject_file = runtime["cohortSubjectsFile"]
                view = runtime["freesurferView"]
                input_dir = os.path.dirname(subject_file)
                os.makedirs(input_dir, exist_ok=True)
                tmp = f"{subject_file}.tmp-{uuid.uuid4().hex}"
                with open(tmp, "x", encoding="utf-8") as handle:
                    handle.writelines(
                        subject_id + "\n"
                        for subject_id in ctx.cohort.analysis_subject_ids
                    )
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(tmp, subject_file)
                _fsync_directory(input_dir)
                os.makedirs(view, exist_ok=True)
                derivatives = resolver.resolve(
                    str(ctx.cfg.get("paths", {}).get("derivativesDir", "")),
                    ctx.cfg,
                )
                source_by_subject: dict[str, str] = {}
                backends: set[str] = set()
                freesurfer_majors: set[str] = set()
                for subject_id in ctx.cohort.analysis_subject_ids:
                    receipt = self._current_receipt(
                        ctx,
                        {"stepKey": "recon", "subjectId": subject_id},
                    )
                    backend = (
                        reconstruction_backend_from_receipt(receipt)
                        if receipt is not None
                        else None
                    )
                    if backend not in {"freesurfer", "fastsurfer"}:
                        raise ValueError(
                            "Restore a current backend-aware receipt for "
                            f"{subject_id} before creating the run-scoped "
                            "Reconstruction view."
                        )
                    backends.add(backend)
                    if step_key == "enigma":
                        major = reconstruction_freesurfer_major_from_receipt(receipt)
                        if major is None:
                            raise ValueError(
                                "Re-run Reconstruction with a detected provider "
                                "release before ENIGMA QC."
                            )
                        freesurfer_majors.add(major)
                    source_root = os.path.realpath(os.path.join(derivatives, backend))
                    source = os.path.realpath(os.path.join(source_root, subject_id))
                    if os.path.commonpath((source, source_root)) != source_root:
                        raise ValueError("Use a safe Reconstruction cohort path.")
                    source_by_subject[subject_id] = source
                if len(backends) != 1:
                    raise ValueError(
                        "Run a full-cohort normalization Reconstruction before "
                        "downstream analysis because the analysis cohort has mixed "
                        "current reconstruction backends."
                    )
                if step_key == "enigma":
                    enigma = ctx.cfg.get("steps", {}).get("enigma", {})
                    params = (
                        enigma.get("params", {}) if isinstance(enigma, dict) else {}
                    )
                    requested_major = str(
                        params.get("fsVersion", "7")
                        if isinstance(params, dict)
                        else "7"
                    )
                    if freesurfer_majors != {requested_major}:
                        observed = ", ".join(sorted(freesurfer_majors))
                        raise ValueError(
                            "Set ENIGMA fsVersion to the Reconstruction provider "
                            f"major ({observed}); the saved value is "
                            f"{requested_major}."
                        )
                runtime["reconstructionViewBackend"] = next(iter(backends))
                for subject_id, source in source_by_subject.items():
                    link = os.path.join(view, subject_id)
                    if os.path.lexists(link):
                        if os.path.realpath(link) != source:
                            raise ValueError(
                                "Rebuild the inconsistent run-scoped Reconstruction "
                                "view."
                            )
                    else:
                        try:
                            os.symlink(source, link, target_is_directory=True)
                        except OSError as exc:
                            if os.name == "nt":
                                raise RuntimeError(
                                    "Enable Windows Developer Mode or grant symlink "
                                    "privilege for the FreeSurfer cohort view."
                                ) from exc
                            raise
                expected_entries = set(ctx.cohort.analysis_subject_ids)
                entries: set[str] = set()
                with os.scandir(view) as iterator:
                    for index, entry in enumerate(iterator):
                        if index > len(expected_entries):
                            raise ValueError(
                                "Remove unintended entries from the run-scoped "
                                "FreeSurfer view."
                            )
                        entries.add(entry.name)
                if entries != expected_entries:
                    raise ValueError(
                        "Rebuild the run-scoped FreeSurfer view to match the analysis "
                        "cohort."
                    )
                if step_key == "aggregate":
                    params = (
                        ctx.cfg.get("steps", {}).get("aggregate", {}).get("params", {})
                    )
                    subject_glob = str(params.get("subjectGlob") or "sub-*")
                    matched = {
                        subject_id
                        for subject_id in entries
                        if fnmatch.fnmatchcase(subject_id, subject_glob)
                    }
                    if matched != expected_entries:
                        raise ValueError(
                            "Set aggregate subjectGlob to match the exact analysis "
                            "cohort."
                        )
                _fsync_directory(view)
            if step_key == "clinical":
                source = resolver.resolve(
                    str(ctx.cfg.get("paths", {}).get("clinicalMetadataFile") or ""),
                    ctx.cfg,
                )
                self._metadata_projection(
                    ctx,
                    source,
                    runtime["clinicalMetadataFile"],
                    healthy_label="control",
                    projection_kind="clinical",
                )
            if step_key == "final":
                metadata_dir = resolver.resolve(
                    str(ctx.cfg.get("paths", {}).get("metadataDir", "")),
                    ctx.cfg,
                )
                source = os.path.join(metadata_dir, "metadata.csv")
                self._metadata_projection(
                    ctx,
                    source,
                    runtime["finalMetadataFile"],
                    healthy_label="SCI_H",
                    projection_kind="final",
                )
            if step_key == "braincharts":
                self._braincharts_projection(ctx, runtime["brainchartsMetadataFile"])
            ctx.inputs_ready.add(step_key)

    @staticmethod
    def _unit_contract(ctx: _RunContext, step_key: str) -> UnitContract | None:
        """Return the stage's per-subject unit contract when it applies."""
        contract = UNIT_CONTRACTS.get(step_key)
        if contract is None or STEP_BY_KEY[step_key]["scope"] != "cohort":
            return None
        try:
            return contract if contract.applies(ctx.effective_cfg) else None
        except (OSError, ValueError):
            return None

    @staticmethod
    def _unit_reuse_enabled(ctx: _RunContext) -> bool:
        """Reuse units exactly when completed work is reused at all."""
        runtime = ctx.cfg.get("runtime")
        return bool(
            runtime.get("resumeCompleted", True) if isinstance(runtime, dict) else True
        )

    def _unit_forecast(self, ctx: _RunContext) -> list[dict[str, Any]]:
        """Forecast per-subject reuse for each runnable stage with units.

        Compare recorded byte counts only, so planning reads no file contents.
        The launch decides again from content digests and records the result.
        """
        forecasts: list[dict[str, Any]] = []
        for node in ctx.state["nodes"]:
            if node["status"] not in {"planned", "waiting"}:
                continue
            step_key = str(node["stepKey"])
            contract = self._unit_contract(ctx, step_key)
            if contract is None:
                continue
            try:
                _signature, payload = self._expected(ctx, step_key, None)
                derivatives = ADAPTERS[step_key].resolve(
                    str(ctx.cfg.get("paths", {}).get("derivativesDir", "")), ctx.cfg
                )
                backend = selected_backend(ctx.effective_cfg)
                plan = unit_reuse.decide(
                    contract,
                    ctx.effective_cfg,
                    {
                        subject_id: os.path.join(derivatives, backend, subject_id)
                        for subject_id in ctx.cohort.analysis_subject_ids
                    },
                    unit_reuse.prior_records(ctx.store, contract),
                    unit_reuse.method_digest(contract, payload, ctx.effective_cfg),
                    reuse_enabled=self._unit_reuse_enabled(ctx),
                    contents=False,
                )
            except Exception:  # noqa: S112 - A forecast never fails planning.
                continue
            forecasts.append(
                {"nodeId": node["nodeId"], "stepKey": step_key, **plan.summary()}
            )
        return forecasts

    def _unit_launch(
        self,
        ctx: _RunContext,
        node: dict[str, Any],
        job: dict[str, Any],
        action: ExecutionAction,
        payload: dict[str, Any],
        log: Any,
    ) -> tuple[ExecutionAction, unit_reuse.UnitPlan | None]:
        """Decide per-subject reuse from content digests and adapt the launch.

        Leave the action unchanged when no unit is reused. When the decision
        cannot be made, compute every subject and record nothing.
        """
        step_key = str(node["stepKey"])
        contract = self._unit_contract(ctx, step_key)
        if contract is None or node.get("scope") != "cohort":
            return action, None
        priors = unit_reuse.prior_records(ctx.store, contract)
        # Settle what an interrupted run held aside before anything is
        # decided; a failure here fails the job and names the held output.
        recovered = unit_reuse.recover(
            contract.output_root(ctx.effective_cfg),
            {prior.run_id for prior in priors},
        )
        for line in recovered:
            log.write(line + "\n")
            self._emit_log(ctx, job, line, "INFO")
        plan: unit_reuse.UnitPlan | None = None
        try:
            runtime = ctx.effective_cfg["_supraspinaRuntime"]
            view = str(runtime["freesurferView"])
            plan = unit_reuse.decide(
                contract,
                ctx.effective_cfg,
                {
                    subject_id: os.path.realpath(os.path.join(view, subject_id))
                    for subject_id in ctx.cohort.analysis_subject_ids
                },
                priors,
                unit_reuse.method_digest(contract, payload, ctx.effective_cfg),
                reuse_enabled=self._unit_reuse_enabled(ctx),
                contents=True,
            )
            skipped = plan.skipped()
            work_dir = os.path.join(
                runtime_run_directory(ctx.effective_cfg), "work", "unit-reuse", step_key
            )
            launched = (
                contract.launch_action(ctx.effective_cfg, action, skipped, work_dir)
                if skipped
                else action
            )
            unit_reuse.begin(plan, ctx.state["runId"])
        except Exception as exc:  # Any fault computes every unit.
            # Fail safe: put back anything already set aside, launch the
            # unchanged command and record no units; nothing is reused
            # unverified.
            if plan is not None:
                unit_reuse.restore(plan)
            line = (
                "Per-subject reuse is unavailable for this run, so every subject "
                f"is computed. {redact_text(str(exc)).strip()}"
            ).strip()
            log.write(line + "\n")
            log.flush()
            self._emit_log(ctx, job, line, "INFO")
            return action, None
        summary = plan.summary()
        lines = [unit_reuse.log_line(summary)]
        unrecorded = unit_reuse.unrecorded_line(plan.unrecorded)
        if unrecorded is not None:
            lines.append(unrecorded)
        if skipped:
            lines.append(
                "The launch helpers that skip the reused subjects are in "
                f"{work_dir}; every other subject runs the unchanged tool."
            )
        if plan.held:
            lines.append(
                f"Set aside the earlier output of {plan.held_units} computed unit"
                f"{'' if plan.held_units == 1 else 's'} in {plan.held_area}; it "
                "returns if the stage does not finish."
            )
        for line in lines:
            log.write(line + "\n")
            self._emit_log(ctx, job, line, "INFO")
        log.flush()
        with self._wake:
            job["unitReuse"] = copy.deepcopy(summary)
            self._commit(ctx)
        return launched, plan

    def _settle_held_output(
        self,
        ctx: _RunContext,
        job: dict[str, Any],
        plan: unit_reuse.UnitPlan,
        log_path: str,
        receipt: dict[str, Any] | None,
    ) -> None:
        """Remove the held earlier output after success, or put it back."""
        lines: list[str] = []
        try:
            if receipt is not None:
                dropped = unit_reuse.release(plan)
                if dropped:
                    lines.append(
                        f"Removed {len(dropped)} earlier file"
                        f"{'' if len(dropped) == 1 else 's'} that the new renders "
                        f"did not write again, with the earlier output: "
                        f"{', '.join(dropped[:_NAMED_FILES])}"
                        f"{', ...' if len(dropped) > _NAMED_FILES else ''}."
                    )
            else:
                restored = unit_reuse.restore(plan)
                if restored:
                    lines.append(
                        f"Restored {unit_reuse.held_entries(restored)}; each "
                        "matches its digest from before the launch."
                    )
        except Exception as exc:  # The area stays; the cause names the paths.
            lines.append(
                f"The earlier output in {plan.held_area} was not fully settled. "
                f"{redact_text(str(exc)).strip()}".strip()
            )
        if not lines:
            return
        try:
            with open(log_path, "a", encoding="utf-8") as log:
                log.writelines(line + "\n" for line in lines)
        except OSError:
            pass
        for line in lines:
            self._emit_log(ctx, job, line, "INFO")

    def _braincharts_projection(self, ctx: _RunContext, destination: str) -> None:
        """Write the BrainCharts registry projection for the exact analysis cohort.

        Age, sex, site, and cohort come from the registry. The record binds the
        digest of those registry fields, which the stage's receipt binds too,
        so a change between planning and launch refuses the run.
        """
        registry_path = os.path.join(ctx.project.root, ".supraspina", "registry.json")
        before = registry_fields_identity(registry_path)
        registry = {
            row["subjectId"]: row
            for row in RegistryStore(ctx.project.root).list(ctx.cfg)
        }
        if registry_fields_identity(registry_path) != before:
            raise ValueError(
                "Retry the BrainCharts projection because the subject registry changed."
            )
        rows: list[list[str]] = []
        for subject_id in ctx.cohort.analysis_subject_ids:
            record = registry.get(subject_id)
            cohort = _BRAINCHARTS_COHORTS.get(str((record or {}).get("cohortRole")))
            if record is None or cohort is None:
                raise ValueError(
                    f"Resolve the registry role of {subject_id} before BrainCharts."
                )
            age = record.get("age")
            site = record.get("site")
            rows.append(
                [
                    subject_id,
                    _age_text(age),
                    str(record.get("sex") or ""),
                    site if isinstance(site, str) else "",
                    cohort,
                ]
            )
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        tmp = f"{destination}.tmp-{uuid.uuid4().hex}"
        with open(tmp, "x", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle, lineterminator="\n")
            writer.writerow(_BRAINCHARTS_PROJECTION_COLUMNS)
            writer.writerows(rows)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, destination)
        _fsync_directory(os.path.dirname(destination))
        record = {
            "kind": "braincharts",
            "outputRows": len(rows),
            "analysisRows": len(ctx.cohort.analysis_subject_ids),
            "outputSha256": self._file_sha256(destination),
            "registryFieldsIdentity": before,
        }
        with self._wake:
            ctx.state.setdefault("inputProjections", []).append(record)

    def _metadata_projection(
        self,
        ctx: _RunContext,
        source: str,
        destination: str,
        *,
        healthy_label: str,
        projection_kind: str,
    ) -> None:
        """Write an exact-cohort run-scoped semantic label projection."""
        input_identity = file_identity(source)
        # Name the path and its required columns: the source may never have
        # existed, and a bare "restore" leaves the operator guessing which file.
        missing_source = (
            f"Provide the metadata file {source} with a subject ID column "
            "(participant_id) and a Cohort column; Sex and Age are optional."
            if projection_kind == "final"
            else (
                f"Provide the clinical metadata CSV at {source} with the "
                "participant_id, Cohort, and AIS columns."
            )
        )
        try:
            source_size = os.path.getsize(source)
        except OSError as exc:
            raise ValueError(missing_source) from exc
        if source_size > _MAX_METADATA_BYTES:
            raise ValueError("Reduce the metadata projection source size.")
        try:
            with open(source, newline="", encoding="utf-8-sig") as handle:
                reader = csv.DictReader(handle)
                fields = list(reader.fieldnames or [])
                if len(fields) > _MAX_METADATA_COLUMNS:
                    raise ValueError("Reduce the metadata projection column count.")
                rows = []
                for index, row in enumerate(reader):
                    if index >= _MAX_METADATA_ROWS:
                        raise ValueError("Reduce the metadata projection row count.")
                    rows.append(dict(row))
        except OSError as exc:
            raise ValueError(missing_source) from exc
        id_column = next(
            (
                value
                for value in (
                    "participant_id",
                    "SubjectID",
                    "Subject_ID",
                    "ID",
                    "subject",
                )
                if value in fields
            ),
            None,
        )
        cohort_column = next(
            (value for value in ("Cohort", "cohort", "Group") if value in fields),
            None,
        )
        if id_column is None or cohort_column is None:
            raise ValueError(
                "Add subject and cohort columns to the metadata projection."
            )
        by_id: dict[str, dict[str, str]] = {}
        for row in rows:
            subject_id = str(row.get(id_column, "")).strip()
            if subject_id in by_id:
                raise ValueError(
                    "Remove duplicate subject IDs from the metadata projection."
                )
            by_id[subject_id] = row
        registry_path = os.path.join(ctx.project.root, ".supraspina", "registry.json")
        registry_identity = file_identity(registry_path)
        registry = {
            row["subjectId"]: row
            for row in RegistryStore(ctx.project.root).list(ctx.cfg)
        }
        if file_identity(registry_path) != registry_identity:
            raise ValueError(
                "Retry the metadata projection because the subject registry changed."
            )
        labels = {
            "healthy": healthy_label,
            "sci-no-neuropathic-pain": "SCI_nNP",
            "sci-neuropathic-pain": "SCI_P",
        }
        output_fields = fields
        if projection_kind == "final":
            output_fields = _final_site_fields(fields)
        projected: list[dict[str, str]] = []
        for subject_id in ctx.cohort.analysis_subject_ids:
            if subject_id not in by_id:
                raise ValueError(
                    "Add every analysis subject to the metadata projection."
                )
            row = dict(by_id[subject_id])
            role = registry.get(subject_id, {}).get("cohortRole")
            if role not in labels:
                raise ValueError(
                    "Resolve the ambiguous cohort label in the metadata projection."
                )
            row[cohort_column] = labels[role]
            if projection_kind == "final":
                # The registry is the one site source; like Cohort, it replaces
                # any site the metadata file carries (final_r_contract.py).
                site = registry.get(subject_id, {}).get("site")
                for column in _SOURCE_SITE_COLUMNS:
                    row.pop(column, None)
                row[SITE_COLUMN] = site if isinstance(site, str) else ""
            projected.append(row)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        tmp = f"{destination}.tmp-{uuid.uuid4().hex}"
        with open(tmp, "x", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=output_fields)
            writer.writeheader()
            writer.writerows(projected)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, destination)
        _fsync_directory(os.path.dirname(destination))
        if file_identity(source) != input_identity:
            raise ValueError(
                "Retry the projection because the metadata source changed."
            )
        record = {
            "kind": projection_kind,
            "inputRows": len(rows),
            "outputRows": len(projected),
            "analysisRows": len(ctx.cohort.analysis_subject_ids),
            "inputIdentity": input_identity,
            "inputSha256": input_identity.get("sha256"),
            "outputSha256": self._file_sha256(destination),
            "registryIdentity": registry_identity,
            "healthyLabel": healthy_label,
        }
        # Publish the record under the manager lock. A concurrent commit
        # deep-copies the run state, and inserting into it from a job thread
        # aborts that copy with a RuntimeError instead of a PersistenceError.
        with self._wake:
            ctx.state.setdefault("inputProjections", []).append(record)

    @staticmethod
    def _file_sha256(path: str) -> str:
        """Return a streaming SHA-256 for a wrapper-owned metadata input."""
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        return digest.hexdigest()

    def _input_projection_snapshot(
        self, ctx: _RunContext, step_key: str
    ) -> list[dict[str, Any]]:
        """Return the exact run-scoped projection identities consumed by a step."""
        path_key = _PROJECTION_PATH_KEYS.get(step_key)
        if path_key is None:
            return []
        runtime = ctx.effective_cfg.get("_supraspinaRuntime", {})
        destination = str(runtime.get(path_key) or "")
        records = [
            copy.deepcopy(record)
            for record in ctx.state.get("inputProjections", [])
            if isinstance(record, dict) and record.get("kind") == step_key
        ]
        if len(records) != 1 or not destination:
            raise ValueError("Restore the run-scoped metadata projection identity.")
        records[0]["consumedSha256"] = self._file_sha256(destination)
        if records[0].get("outputSha256") != records[0]["consumedSha256"]:
            raise ValueError(
                "Rebuild the run-scoped metadata projection because it changed "
                "before launch."
            )
        return records

    @staticmethod
    def _public_direct_inputs(
        records: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Remove filesystem paths while retaining actionable hash evidence."""
        return [
            {
                key: copy.deepcopy(record.get(key))
                for key in (
                    "kind",
                    "subjectId",
                    "plannedSha256",
                    "launchSha256",
                    "observedSha256",
                    "phase",
                )
                if key in record
            }
            for record in records
        ]

    @staticmethod
    def _public_detector_failure_evidence(
        ctx: _RunContext,
        evidence: dict[str, Any],
    ) -> dict[str, str]:
        """Return bounded detector state/detail without artifact or subject paths."""
        state = evidence.get("state")
        if state not in {"pending", "partial", "failed", "unknown"}:
            state = "unknown"
        detail = evidence.get("detail")
        if not isinstance(detail, str) or not detail.strip():
            detail = f"The detector reported {state} output."
        detail = redact_text(
            detail,
            project_root=ctx.project.root,
            subject_ids=ctx.cohort.analysis_subject_ids,
        )
        detail = " ".join(detail.split())
        if not detail:
            detail = f"The detector reported {state} output."
        if len(detail) > _MAX_PUBLIC_DETECTOR_DETAIL_CHARS:
            detail = (
                detail[: _MAX_PUBLIC_DETECTOR_DETAIL_CHARS - 14].rstrip(" .!?;:")
                + " [truncated]."
            )
        return {"state": state, "detail": detail}

    def _direct_scientific_input_snapshot(
        self, ctx: _RunContext, step_key: str, subject_id: str | None
    ) -> list[dict[str, Any]]:
        """Hash the exact T1 bytes a preparation, Deface, or Recon process consumes."""
        if step_key not in {"brainfov", "deface", "recon"} or not subject_id:
            return []
        runtime = ctx.effective_cfg.get("_supraspinaRuntime")
        if not isinstance(runtime, dict):
            # Allow hand-built unit contexts that do not model runtime inputs.
            return []
        deface_enabled = bool(
            ctx.cfg.get("steps", {}).get("deface", {}).get("enabled", False)
        )
        brainfov_enabled = bool(
            ctx.cfg.get("steps", {}).get("brainfov", {}).get("enabled", False)
        )
        if step_key == "brainfov":
            path_map_key = "t1BySubject"
            evidence_kind = "raw-t1"
            expected_kind = "raw"
        elif step_key == "deface":
            path_map_key = "preparedT1BySubject"
            evidence_kind = "prepared-t1" if brainfov_enabled else "raw-t1"
            expected_kind = "prepared" if brainfov_enabled else "raw"
        elif deface_enabled:
            path_map_key = "reconInputBySubject"
            evidence_kind = "defaced-t1"
            expected_kind = "defaced"
        else:
            path_map_key = "reconInputBySubject"
            evidence_kind = "prepared-t1" if brainfov_enabled else "raw-t1"
            expected_kind = "prepared" if brainfov_enabled else "raw"
        path_map = runtime.get(path_map_key)
        if step_key == "deface" and (
            not isinstance(path_map, dict) or subject_id not in path_map
        ):
            path_map = runtime.get("t1BySubject")
        path = str(path_map.get(subject_id) or "") if isinstance(path_map, dict) else ""
        planned = next(
            (row.fingerprint for row in ctx.cohort.t1 if row.subject_id == subject_id),
            None,
        )
        prepared_evidence = runtime.get("inputFovEvidence", {})
        subject_evidence = (
            prepared_evidence.get(subject_id)
            if isinstance(prepared_evidence, dict)
            else None
        )
        prepared_hash = (
            subject_evidence.get("outputSha256")
            if isinstance(subject_evidence, dict)
            else None
        )
        expected = (
            planned
            if expected_kind == "raw"
            else prepared_hash
            if expected_kind == "prepared"
            else None
        )
        identity = file_identity(path, include_path=False)
        observed = (
            identity.get("sha256")
            if identity.get("exists") is True and identity.get("kind") == "file"
            else None
        )
        evidence = {
            "kind": evidence_kind,
            "subjectId": subject_id,
            "plannedSha256": expected,
            "launchSha256": observed,
            "observedSha256": observed,
            "phase": "pre-exec",
            "path": path,
        }
        if (
            not isinstance(observed, str)
            or _DIGEST_PATTERN.fullmatch(observed) is None
            or (
                expected_kind in {"raw", "prepared"}
                and (
                    not isinstance(expected, str)
                    or _DIGEST_PATTERN.fullmatch(expected) is None
                    or observed != expected
                )
            )
        ):
            raise _InputChangedError(
                "Scientific input changed after planning.",
                self._public_direct_inputs([evidence]),
            )
        return [evidence]

    def _verify_direct_scientific_inputs(self, records: list[dict[str, Any]]) -> None:
        """Re-hash direct inputs before allowing a success receipt."""
        failures: list[dict[str, Any]] = []
        for record in records:
            identity = file_identity(str(record.get("path") or ""), include_path=False)
            observed = (
                identity.get("sha256")
                if identity.get("exists") is True and identity.get("kind") == "file"
                else None
            )
            if observed != record.get("launchSha256"):
                failures.append(
                    {
                        **record,
                        "observedSha256": observed,
                        "phase": "post-exit",
                    }
                )
        if failures:
            raise _InputChangedError(
                "Scientific input changed during execution.",
                self._public_direct_inputs(failures),
            )

    @staticmethod
    def _validate_projection_launch_binding(
        step_key: str,
        payload: dict[str, Any],
        projections: list[dict[str, Any]],
    ) -> None:
        """Reject projection/input identity drift before releasing a process."""
        if step_key == "braincharts":
            fields = payload.get("externalInputs", {}).get("registryFields")
            if (
                len(projections) != 1
                or not isinstance(fields, dict)
                or projections[0].get("registryFieldsIdentity") != fields
            ):
                raise ValueError(
                    "Rebuild the BrainCharts projection because the subject "
                    "registry changed."
                )
            return
        if step_key not in {"clinical", "final"}:
            return
        if len(projections) != 1:
            raise ValueError("Restore the run-scoped metadata projection binding.")
        binding = payload.get("externalInputs", {}).get(
            "runScopedProjectionBinding", {}
        )
        source_identity = binding.get("sourceIdentity")
        registry_identity = binding.get("registryIdentity")
        identities = {
            "sourceIdentity": source_identity,
            "registryIdentity": registry_identity,
        }
        record = projections[0]
        if (
            binding.get("kind") != "metadata-projection-input-binding-v1"
            or binding.get("sha256") != stable_digest(identities)
            or not isinstance(source_identity, dict)
            or not isinstance(registry_identity, dict)
            or record.get("inputIdentity") != source_identity
            or record.get("inputSha256") != source_identity.get("sha256")
            or record.get("registryIdentity") != registry_identity
        ):
            raise ValueError(
                "Rebuild the projection because its metadata or registry changed."
            )

    @staticmethod
    def _receipt_scientific_evidence(
        state: dict[str, Any], step_key: str, evidence: dict[str, Any]
    ) -> dict[str, Any]:
        """Copy bounded planning reconciliation evidence into a step receipt."""
        if step_key != "age":
            return evidence
        age_reconciliation = state.get("scientificEvidence", {}).get("ageOuterJoin")
        if not isinstance(age_reconciliation, dict):
            return evidence
        enriched = dict(evidence)
        enriched["ageOuterReconciliation"] = copy.deepcopy(age_reconciliation)
        return enriched

    def _retain_unproved_process(
        self,
        ctx: _RunContext,
        node: dict[str, Any],
        job: dict[str, Any],
        proc: Any,
        pgid: int | None,
        observed_exit_code: int,
        owner: dict[str, Any] | None = None,
    ) -> None:
        """Keep execution live when descendant settlement cannot be proved."""
        detail = (
            "An external process may still be active; Supraspina could not confirm "
            "that it ended."
        )
        pid = getattr(proc, "pid", None)
        persisted_owner = (
            owner if isinstance(owner, dict) else job.get("processOwnership")
        )
        ownership = (
            copy.deepcopy(persisted_owner)
            if isinstance(persisted_owner, dict)
            else {
                "pid": pid if _strict_safe_integer(pid, minimum=2) else None,
                "pgid": pgid if _strict_safe_integer(pgid, minimum=2) else None,
            }
        )
        ownership.update(
            {
                "state": "unknown",
                "provedStopped": False,
                "settledAt": None,
                "detail": detail,
            }
        )
        with self._wake:
            ctx.halt_new = True
            node["status"] = "unknown"
            node["reason"] = detail
            job["status"] = "unknown"
            job["endedAt"] = None
            job["exitCode"] = None
            job["observedLeaderExitCode"] = observed_exit_code
            job["terminalReason"] = "external_process_may_still_be_active"
            job["processOwnership"] = copy.deepcopy(ownership)
            ctx.state["status"] = "unknown"
            ctx.state["endedAtMs"] = None
            ctx.state["terminalReason"] = "external_process_may_still_be_active"
            ctx.state["recovery"] = {
                "state": "unknown",
                "detail": detail,
                "processOwnership": copy.deepcopy(ownership),
            }
            self._active_jobs[job["id"]] = job
            job["durable"] = True
            job["persistenceStatus"] = "durable"
            try:
                self._commit(ctx)
            except PersistenceError:
                ctx.persistence_failed = True
                ctx.state["durable"] = False
                job["durable"] = False
                job["persistenceStatus"] = "error"
                self._persistence_errors[job["id"]] = copy.deepcopy(job)
            self._emit_job(ctx, job)
            self._emit_run(ctx)
            self._wake.notify_all()

    def _execute(
        self, ctx: _RunContext, node_id: str, job_id: str, cancel_event: threading.Event
    ) -> None:
        # Backstop the worker thread: no fault escaping the execution body may
        # strand the job in the active registry, or the project reports busy
        # forever with a job that can no longer be cancelled.
        try:
            self._execute_inner(ctx, node_id, job_id, cancel_event)
        except Exception:
            with self._wake:
                job = self._active_jobs.pop(job_id, None)
                if job is not None:
                    job["status"] = "persistence-error"
                    job["endedAt"] = _now_ms()
                    job["durable"] = False
                    job["persistenceStatus"] = "error"
                    job["terminalReason"] = "persistence_error"
                    self._persistence_errors[job_id] = copy.deepcopy(job)
                    for node in ctx.state["nodes"]:
                        if node["nodeId"] == node_id:
                            node["status"] = "interrupted"
                            node["reason"] = "Job settlement failed unexpectedly."
                    self._emit_job(ctx, job)
                self._wake.notify_all()
            raise

    def _execute_inner(
        self, ctx: _RunContext, node_id: str, job_id: str, cancel_event: threading.Event
    ) -> None:
        with self._lock:
            node = next(
                value for value in ctx.state["nodes"] if value["nodeId"] == node_id
            )
            job = self._job_for_node(ctx, node_id)
            adapter = ADAPTERS[node["stepKey"]]
            subject_id = node.get("subjectId")
        log_path = job["stdoutPath"]
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        rc = 127
        tail: list[str] = []
        reason: str | None = None
        owned_proc: Any | None = None
        owned_pgid: int | None = None
        owned_record: dict[str, Any] | None = None
        launch_signature: str | None = None
        launch_payload: dict[str, Any] | None = None
        launch_projections: list[dict[str, Any]] = []
        launch_direct_inputs: list[dict[str, Any]] = []
        input_change_evidence: list[dict[str, Any]] = []
        reconstruction_output_conflict = False
        settlement_proved = True
        fallback_changed_jobs: list[dict[str, Any]] = []
        fallback_processes: list[Any] = []
        execution_lease: Any | None = None
        execution_lease_entered = False
        recent: deque[str] = deque(maxlen=_RECON_DETECTION_LINES)
        recon_log_mark: LogMark | None = None
        execution_fallback: dict[str, Any] | None = None
        reruns: list[Rerun] = []
        unit_plan: unit_reuse.UnitPlan | None = None
        unit_record: dict[str, Any] | None = None
        try:
            with open(log_path, "w", encoding="utf-8") as log:
                if node["scope"] == "cohort":
                    self._prepare_inputs(ctx, node["stepKey"])
                action = adapter.execution_action(ctx.effective_cfg, subject_id)
                launch_signature, launch_payload = self._expected(
                    ctx, node["stepKey"], subject_id
                )
                # Compare the receipt form the plan bound, not the launched
                # argv: a continued Reconstruction omits -i after its import.
                if launch_payload.get("executionActionDigest") != (
                    execution_action_digest(
                        bound_action(adapter, ctx.effective_cfg, subject_id),
                        runtime_run_directory(ctx.effective_cfg),
                    )
                ):
                    raise _ExecutionActionChangedError(
                        "The bound action changed before launch, so execution was "
                        "refused."
                    )
                launch_projections = self._input_projection_snapshot(
                    ctx, node["stepKey"]
                )
                self._validate_projection_launch_binding(
                    node["stepKey"], launch_payload, launch_projections
                )
                launch_snapshot = {
                    "expectedSignature": launch_signature,
                    "externalInputs": copy.deepcopy(
                        launch_payload.get("externalInputs", {})
                    ),
                    "inputProjections": copy.deepcopy(launch_projections),
                }
                with self._wake:
                    job["launchInputSnapshot"] = launch_snapshot
                    self._commit(ctx)
                if action.kind == "copy":
                    self._copy_action(action, cancel_event, log)
                    rc = 0
                else:
                    conflict_reason = self._reconstruction_output_conflict(ctx, node)
                    if conflict_reason is not None:
                        raise _ReconstructionOutputConflictError(conflict_reason)
                    lease_factory = getattr(adapter, "execution_lease", None)
                    if callable(lease_factory):
                        execution_lease = lease_factory(ctx.effective_cfg, subject_id)
                        execution_lease.__enter__()
                        execution_lease_entered = True
                    prepare_execution = getattr(adapter, "prepare_execution", None)
                    if callable(prepare_execution):
                        prepare_execution(ctx.effective_cfg, subject_id)
                    action, unit_plan = self._unit_launch(
                        ctx, node, job, action, launch_payload, log
                    )
                    clear_markers = getattr(
                        adapter, "clear_stale_running_markers", None
                    )
                    if callable(clear_markers):
                        for marker in clear_markers(ctx.effective_cfg, subject_id):
                            log.write(
                                f"Removed the stale scripts/{marker} marker left by "
                                "an interrupted reconstruction before continuing.\n"
                            )
                            log.flush()
                    launched_argv = list(action.argv)
                    first_attempt = True
                    while True:
                        recent.clear()
                        recon_log_mark = (
                            mark_recon_log(launched_argv)
                            if node["stepKey"] == "recon"
                            and is_freesurfer_recon(launched_argv)
                            else None
                        )
                        proc = self._spawn_action(
                            list(launched_argv), ctx.effective_cfg
                        )
                        owned_proc = proc
                        with self._wake:
                            ctx.processes[job_id] = proc
                            pid = getattr(proc, "pid", None)
                            if self.supervisor_generation is None and not (
                                isinstance(pid, int) and pid > 1
                            ):
                                # Let isolated PID-free unit doubles use their
                                # test path. Require production handshakes to
                                # supply a generation and take the durable path.
                                owned_pgid = self.announce_process_started(job_id, proc)
                            else:
                                owned_record = self.process_owner_record(
                                    operation_kind="workflow",
                                    project=ctx.project,
                                    proc=proc,
                                    run_id=ctx.state["runId"],
                                    job_id=job_id,
                                )
                                job["processOwnership"] = copy.deepcopy(owned_record)
                                self._commit(ctx)
                        if owned_record is not None:
                            owned_pgid = self.announce_process_started(
                                owned_record, proc
                            )
                            with self._wake:
                                job["processOwnership"] = copy.deepcopy(owned_record)
                                self._commit(ctx)
                        # The first launch's snapshot covers the whole job,
                        # including its known-failure reruns.
                        if first_attempt:
                            launch_direct_inputs = (
                                self._direct_scientific_input_snapshot(
                                    ctx, node["stepKey"], subject_id
                                )
                            )
                        if first_attempt and launch_direct_inputs:
                            # Insert into the snapshot under the manager lock:
                            # it is already published on the job, so a
                            # concurrent commit deep-copies it with the run.
                            with self._wake:
                                launch_snapshot["directScientificInputs"] = (
                                    self._public_direct_inputs(launch_direct_inputs)
                                )
                                job["launchInputSnapshot"] = copy.deepcopy(
                                    launch_snapshot
                                )
                                self._commit(ctx)
                        with self._wake:
                            if cancel_event.is_set():
                                _terminate_tree(proc)
                            else:
                                _release_spawn(proc)
                        stream = getattr(proc, "stdout", None)
                        if stream is not None:
                            for raw in stream:
                                line = raw.rstrip("\r\n")
                                log.write(line + "\n")
                                tail.append(line)
                                tail = tail[-50:]
                                recent.append(line)
                                self._emit_log(ctx, job, line, "INFO")
                        rc = int(proc.wait())
                        retry = (
                            self._known_failure_rerun(
                                adapter,
                                ctx.effective_cfg,
                                subject_id,
                                rc,
                                recent,
                                recon_log_mark,
                                reruns,
                            )
                            if recon_log_mark is not None
                            and not cancel_event.is_set()
                            and not ctx.persistence_failed
                            else None
                        )
                        if retry is None:
                            break
                        retry_argv, failure = retry
                        # Settle the failed attempt before the rerun starts; an
                        # unproved settlement stops here, and the settlement
                        # below retains the process.
                        if not self._settle_owned_process(
                            ctx, job, job_id, owned_proc, owned_pgid, owned_record
                        ):
                            break
                        owned_proc = None
                        owned_pgid = None
                        owned_record = None
                        if cancel_event.is_set():
                            break
                        reruns.append(Rerun(failure, rc))
                        execution_fallback = fallback_record(reruns)
                        fallback_line = fallback_log_line(subject_id, reruns)
                        log.write(fallback_line + "\n")
                        log.flush()
                        self._emit_log(ctx, job, fallback_line, "INFO")
                        with self._wake:
                            job["executionFallback"] = copy.deepcopy(execution_fallback)
                            self._commit(ctx)
                        if callable(clear_markers):
                            for marker in clear_markers(ctx.effective_cfg, subject_id):
                                log.write(
                                    f"Removed the stale scripts/{marker} marker "
                                    "left by the failed attempt before the rerun.\n"
                                )
                                log.flush()
                        launched_argv = retry_argv
                        tail = []
                        first_attempt = False
                log.flush()
                os.fsync(log.fileno())
        except FileExistsError:
            rc = 1
            reason = (
                "The copy-through destination already exists. Enable "
                "forceOverwrite or choose a new output."
            )
        except _ExecutionActionChangedError as exc:
            rc = 1
            reason = str(exc)
        except _InputChangedError as exc:
            rc = 1
            reason = str(exc)
            input_change_evidence = copy.deepcopy(exc.evidence)
        except _ReconstructionOutputConflictError as exc:
            rc = 1
            reason = str(exc)
            reconstruction_output_conflict = True
        except Exception as exc:
            rc = 127
            # Carry the exception's own text: without it the operator sees
            # only the type name and cannot tell a missing metadata column
            # from a stale projection.
            detail = redact_text(str(exc)).strip()
            reason = f"An unexpected error ({type(exc).__name__}) ended the job." + (
                f" {detail}" if detail else ""
            )
            try:
                with open(log_path, "a", encoding="utf-8") as log:
                    log.write(f"{reason}\n")
            except OSError:
                pass
        finally:
            settlement_proved = self._settle_owned_process(
                ctx, job, job_id, owned_proc, owned_pgid, owned_record
            )
            if execution_lease is not None and execution_lease_entered:
                execution_lease.__exit__(None, None, None)
        if owned_proc is not None and not settlement_proved:
            self._retain_unproved_process(
                ctx,
                node,
                job,
                owned_proc,
                owned_pgid,
                rc,
                owned_record,
            )
            return
        cancelled = cancel_event.is_set()
        evidence: dict[str, Any] = {}
        detector_failure_evidence: dict[str, str] | None = None
        receipt: dict[str, Any] | None = None
        # Build the receipt for every clean exit, including one that raced an
        # operator cancellation: work that finished before the cancel landed
        # is completed work, and recording it as cancelled would strand a
        # done reconstruction tree without a matching receipt.
        if rc == 0:
            try:
                self._verify_direct_scientific_inputs(launch_direct_inputs)
                post_signature, post_payload = self._expected(
                    ctx,
                    node["stepKey"],
                    subject_id,
                    cached_external_inputs=False,
                )
                post_projections = self._input_projection_snapshot(ctx, node["stepKey"])
                self._validate_projection_launch_binding(
                    node["stepKey"], post_payload, post_projections
                )
            except _InputChangedError as exc:
                post_signature = None
                post_projections = []
                reason = str(exc)
                input_change_evidence = copy.deepcopy(exc.evidence)
            except Exception:
                post_signature = None
                post_projections = []
            if (
                launch_signature is None
                or launch_payload is None
                or post_signature != launch_signature
                or post_projections != launch_projections
            ):
                rc = 1
                if reason is None:
                    reason = "Scientific inputs changed during execution."
            else:
                evidence = detector_evidence(adapter, ctx.effective_cfg, subject_id)
                evidence = enrich_evidence(
                    node["stepKey"], evidence, ctx.effective_cfg, ctx.cohort
                )
                evidence = self._receipt_scientific_evidence(
                    ctx.state, node["stepKey"], evidence
                )
            if rc == 0 and evidence_is_done(evidence) and unit_plan is not None:
                try:
                    unit_record = unit_reuse.finish(unit_plan, ctx.state["runId"])
                except Exception as exc:  # Any fault refuses the receipt.
                    rc = 1
                    reason = (
                        str(exc)
                        if isinstance(exc, unit_reuse.UnitReuseError)
                        else "Per-subject outputs could not be verified after "
                        "execution, so no receipt was written."
                    )
            if rc == 0 and evidence_is_done(evidence):
                receipt = make_receipt(
                    launch_signature,
                    launch_payload,
                    evidence,
                    run_id=ctx.state["runId"],
                    job_id=job_id,
                    committed_at_ms=_now_ms(),
                    edge_evidence=self._edge_evidence_for_receipt(
                        ctx, node["stepKey"], subject_id
                    ),
                    launch_input_projections=copy.deepcopy(launch_projections),
                    launch_direct_scientific_inputs=self._public_direct_inputs(
                        launch_direct_inputs
                    ),
                    execution_fallback=execution_fallback,
                    unit_reuse=unit_record,
                )
            elif rc == 0:
                rc = 1
                detector_failure_evidence = self._public_detector_failure_evidence(
                    ctx, evidence
                )
                reason = (
                    "The process exited successfully but did not produce the "
                    f"expected output. {detector_failure_evidence['detail']}"
                )
        if unit_plan is not None:
            self._settle_held_output(ctx, job, unit_plan, log_path, receipt)
        with self._wake:
            now = _now_ms()
            if ctx.persistence_failed:
                # Retry one fresh commit before discarding the finished work;
                # a transient store fault then costs only the job whose own
                # commit failed instead of every later successful job.
                try:
                    self._commit(ctx)
                except PersistenceError:
                    pass
                else:
                    ctx.persistence_failed = False
            if ctx.persistence_failed:
                node["status"] = "interrupted"
                node["reason"] = (
                    "Run persistence failed before the terminal state was recorded."
                )
                job["status"] = "persistence-error"
                job["endedAt"] = now
                job["durable"] = False
                job["persistenceStatus"] = "error"
                job["terminalReason"] = "persistence_error"
                self._active_jobs.pop(job_id, None)
                self._persistence_errors[job_id] = copy.deepcopy(job)
                self._emit_job(ctx, job)
                self._wake.notify_all()
                return
            completed = rc == 0 and receipt is not None
            if completed:
                # Completion wins over a cancellation that raced a clean
                # exit; the validated receipt proves the work finished.
                node["status"] = "done"
                node.pop("detectorEvidence", None)
                job["status"] = "done"
                job.pop("detectorEvidence", None)
                job["terminalReason"] = "completed"
                ctx.state["receipts"].append(receipt)
            elif cancelled:
                fallback = ctx.state.get("reconstructionFallback")
                fallback_cancellation = (
                    isinstance(fallback, dict)
                    and fallback.get("state") == "settling"
                    and job.get("backend") == FREESURFER_BACKEND
                    and job.get("subjectId") in fallback.get("subjectIds", [])
                )
                node["status"] = "cancelled"
                job["status"] = "cancelled"
                if fallback_cancellation:
                    node["reason"] = (
                        "The cohort-wide fallback superseded the FreeSurfer attempt."
                    )
                    job["role"] = "superseded-primary"
                    job["fallbackReasonTag"] = fallback.get("reasonTag")
                    job["terminalReason"] = "auto_fallback_superseded"
                else:
                    job["terminalReason"] = "operator_cancelled"
            elif reconstruction_output_conflict:
                node["status"] = "blocked"
                node["reason"] = str(reason)
                node.pop("detectorEvidence", None)
                job["status"] = "blocked"
                job.pop("detectorEvidence", None)
                job["terminalReason"] = "reconstruction_output_conflict"
            else:
                node["status"] = "failed"
                failure = adapter.parse_failure(rc, "\n".join(tail), "")
                node["reason"] = reason or (
                    failure.message
                    if failure is not None
                    else f"The process exited with code {rc}."
                )
                job["status"] = "failed"
                job["terminalReason"] = node["reason"]
                # State recon-all's own cause beside the recorded reason, which
                # keeps the adapter's text for log replay and deduplication.
                cause = (
                    None
                    if reason is not None
                    else self._recon_failure_cause(failure, recent, recon_log_mark)
                )
                if cause is not None:
                    job["failureCause"] = redact_secrets(cause)
                if detector_failure_evidence is not None:
                    node["detectorEvidence"] = copy.deepcopy(detector_failure_evidence)
                    job["detectorEvidence"] = copy.deepcopy(detector_failure_evidence)
                else:
                    node.pop("detectorEvidence", None)
                    job.pop("detectorEvidence", None)
                if input_change_evidence:
                    job["inputChangeEvidence"] = copy.deepcopy(input_change_evidence)
                if self._eligible_auto_fallback(
                    ctx,
                    node,
                    job,
                    failure,
                    rc=rc,
                    cancelled=cancelled,
                    reason=reason,
                    process_started=owned_proc is not None,
                    settlement_proved=settlement_proved,
                ):
                    fallback_changed_jobs, fallback_processes = (
                        self._begin_auto_fallback(ctx, node, job, failure)
                    )
                else:
                    policy = ctx.state["failurePolicy"]
                    ctx.halt_new = bool(
                        policy["stopOnError"]
                        or not policy["continueIndependentAfterError"]
                    )
            job["endedAt"] = now
            job["exitCode"] = (
                None
                if (cancelled and not completed) or reconstruction_output_conflict
                else rc
            )
            self._recompute_run(ctx)
            try:
                self._commit(ctx)
            except PersistenceError:
                ctx.persistence_failed = True
                ctx.halt_new = True
                node["status"] = "failed"
                node["reason"] = "Supraspina could not persist the terminal state."
                job["status"] = "persistence-error"
                job["durable"] = False
                job["persistenceStatus"] = "error"
                job["terminalReason"] = "persistence_error"
                ctx.state["status"] = "persistence-error"
                ctx.state["durable"] = False
                ctx.state["endedAtMs"] = _now_ms()
                for other_node in ctx.state["nodes"]:
                    if (
                        other_node is node
                        or other_node["status"] in TERMINAL_NODE_STATES
                    ):
                        continue
                    other_node["status"] = (
                        "interrupted"
                        if other_node["status"] in {"running", "cancelling"}
                        else "withheld"
                    )
                    other_node["reason"] = (
                        "Run persistence failed, so this work stopped."
                    )
                for other_job in ctx.state["jobs"]:
                    if (
                        other_job["id"] == job_id
                        or other_job["status"] not in ACTIVE_JOB_STATES
                    ):
                        continue
                    event = ctx.cancel_events.setdefault(
                        other_job["id"], threading.Event()
                    )
                    event.set()
                    proc = ctx.processes.get(other_job["id"])
                    if proc is not None:
                        _terminate_tree(proc)
                    if other_job["status"] == "queued":
                        other_job["status"] = "persistence-error"
                        other_job["endedAt"] = _now_ms()
                        other_job["durable"] = False
                        other_job["persistenceStatus"] = "error"
                        other_job["terminalReason"] = "persistence_error"
                        self._active_jobs.pop(other_job["id"], None)
                        self._persistence_errors[other_job["id"]] = copy.deepcopy(
                            other_job
                        )
                self._active_jobs.pop(job_id, None)
                self._persistence_errors[job_id] = copy.deepcopy(job)
                if not ctx.processes:
                    self._runs.pop(ctx.state["runId"], None)
                self._emit_job(ctx, job)
                self._emit_run(ctx)
                self._wake.notify_all()
                return
            job["durable"] = True
            job["persistenceStatus"] = "durable"
            if receipt is not None:
                try:
                    ctx.store.put_receipt(receipt)
                except PersistenceError:
                    ctx.state["warnings"].append(
                        "The global receipt could not be published; the run "
                        "generation keeps it."
                    )
            self._active_jobs.pop(job_id, None)
            self._terminal_jobs[job_id] = copy.deepcopy(job)
            self._trim_terminal()
            for changed_job in fallback_changed_jobs:
                self._emit_job(ctx, changed_job)
            self._emit_job(ctx, job)
            self._emit_run(ctx)
            self._wake.notify_all()
        for proc in fallback_processes:
            _terminate_tree(proc)
            _schedule_force_termination(proc)

    def _settle_owned_process(
        self,
        ctx: _RunContext,
        job: dict[str, Any],
        job_id: str,
        proc: Any | None,
        pgid: int | None,
        record: dict[str, Any] | None,
    ) -> bool:
        """Stop and settle one launched process, and record its ownership.

        Return whether the process tree is proved stopped; no process proves
        trivially.
        """
        proved = True
        if proc is not None:
            if proc.poll() is None:
                _terminate_tree(proc, force=True)
                try:
                    proc.wait(timeout=2)
                except (subprocess.SubprocessError, OSError):
                    pass
            if record is not None:
                proved = self.announce_process_settled(record, proc, pgid)
            else:
                proved = _settle_group(proc, pgid)
        with self._wake:
            if record is not None:
                record["state"] = "settled" if proved else "unknown"
                record["provedStopped"] = proved
                record["settledAt"] = _now_ms() if proved else None
                job["processOwnership"] = copy.deepcopy(record)
                try:
                    self._commit(ctx)
                except PersistenceError:
                    # Halt new work like every other persistence-failure
                    # site so the scheduler stops feeding a broken store.
                    ctx.persistence_failed = True
                    ctx.halt_new = True
            if proved:
                ctx.processes.pop(job_id, None)
        return proved

    @staticmethod
    def _known_failure_rerun(
        adapter: Any,
        cfg: dict[str, Any],
        subject_id: str | None,
        rc: int,
        recent: deque[str],
        log_mark: LogMark | None,
        reruns: Sequence[Rerun],
    ) -> tuple[list[str], KnownFailure] | None:
        """Return the next rerun's argv and the failure that calls for it.

        Read the failed attempt's own output and what it appended to
        recon-all.log, since recon-all can write a hemisphere's step to the
        log alone. A failure whose flag an earlier rerun already added does
        not rerun again. Build the command again rather than reuse the first
        one, so a subject the first attempt imported continues without -i, as
        recon-all requires, and append every rerun's flag in order.
        """
        if rc == 0:
            return None
        applied = [rerun.failure.flag for rerun in reruns]
        failure = known_failure("\n".join(recent), applied) or known_failure(
            read_recon_log_since(log_mark), applied
        )
        if failure is None:
            return None
        try:
            action = adapter.execution_action(cfg, subject_id)
        except (OSError, TypeError, ValueError):
            return None
        if action.kind != "process":
            return None
        argv = rerun_argv(list(action.argv), [*applied, failure.flag])
        return None if argv is None else (argv, failure)

    @staticmethod
    def _recon_failure_cause(
        failure: Failure | None,
        recent: deque[str],
        log_mark: LogMark | None,
    ) -> str | None:
        """State recon-all's failing tool and ERROR line for a generic reason."""
        if log_mark is None or failure is None or failure.tag not in _RECON_CAUSE_TAGS:
            return None
        return failure_cause("\n".join(recent)) or failure_cause(
            read_recon_log_since(log_mark)
        )

    def _spawn_action(self, argv: list[str], cfg: dict[str, Any]) -> Any:
        if self._spawn_override is not None:
            return self._spawn_override(argv)
        return _spawn(argv, cfg)

    @staticmethod
    def _copy_action(
        action: ExecutionAction, cancel_event: threading.Event, log: Any
    ) -> None:
        source = str(action.source or "")
        destination = str(action.destination or "")
        if not os.path.isfile(source):
            raise FileNotFoundError(source)
        if os.path.exists(destination) and not action.force:
            raise FileExistsError(destination)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        tmp = os.path.join(
            os.path.dirname(destination),
            f".{os.path.basename(destination)}.tmp-{uuid.uuid4().hex}",
        )
        try:
            with open(source, "rb") as src, open(tmp, "xb") as dst:
                while True:
                    if cancel_event.is_set():
                        raise InterruptedError("The copy stopped after cancellation.")
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    dst.write(chunk)
                dst.flush()
                os.fsync(dst.fileno())
            shutil.copystat(source, tmp, follow_symlinks=True)
            if cancel_event.is_set():
                raise InterruptedError("The copy stopped after cancellation.")
            if action.force:
                os.replace(tmp, destination)
            else:
                # Publish atomically through a same-directory hard link, and refuse
                # an EEXIST race instead of overwriting a concurrent file.
                os.link(tmp, destination)
            if os.name != "nt":
                fd = os.open(
                    os.path.dirname(destination),
                    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
                )
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            log.write(
                "Supraspina completed the copy-through with metadata preserved.\n"
            )
        finally:
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except OSError:
                pass

    def _recompute_run(self, ctx: _RunContext) -> None:
        statuses = {node["status"] for node in ctx.state["nodes"]}
        if "unknown" in statuses:
            ctx.state["status"] = "unknown"
            ctx.state["endedAtMs"] = None
            return
        if any(
            status in {"running", "queued", "planned", "waiting"} for status in statuses
        ):
            ctx.state["status"] = "running"
            return
        if "failed" in statuses:
            ctx.state["status"] = "failed"
        elif "cancelled" in statuses:
            ctx.state["status"] = "cancelled"
        elif "blocked" in statuses or "withheld" in statuses:
            ctx.state["status"] = "blocked"
        elif "interrupted" in statuses:
            ctx.state["status"] = "interrupted"
        else:
            ctx.state["status"] = "done"
        ctx.state["endedAtMs"] = _now_ms()

    def _finish_run_if_terminal(self, ctx: _RunContext) -> bool:
        if ctx.processes or any(
            job.get("runId") == ctx.state["runId"]
            and job.get("status") in ACTIVE_JOB_STATES
            for job in self._active_jobs.values()
        ):
            return False
        if not all(
            node["status"] in TERMINAL_NODE_STATES or ctx.state.get("dryRun")
            for node in ctx.state["nodes"]
        ):
            return False
        self._recompute_run(ctx)
        if ctx.state.get("dryRun"):
            ctx.state["status"] = "planned"
        try:
            self._commit(ctx)
        except PersistenceError:
            ctx.state["status"] = "persistence-error"
            ctx.state["durable"] = False
        with self._lock:
            self._runs.pop(ctx.state["runId"], None)
        self._emit_run(ctx)
        return True

    def _mark_scheduler_failure(self, ctx: _RunContext) -> None:
        ctx.halt_new = True
        # Jobs whose execution thread started perform their own terminal
        # bookkeeping once the cancellation lands. A cancel event alone proves
        # nothing: the queued-to-running transition registers one before the
        # commit and the thread start that can still fail.
        threaded_job_ids = set(ctx.execution_threads)
        for job_id, proc in list(ctx.processes.items()):
            ctx.cancel_events.setdefault(job_id, threading.Event()).set()
            _terminate_tree(proc)
            _schedule_force_termination(proc)
        for node in ctx.state["nodes"]:
            if (
                node["status"] not in TERMINAL_NODE_STATES
                and node["status"] != "unknown"
            ):
                node["status"] = "interrupted"
                node["reason"] = (
                    "Scheduler reconciliation failed, so this work stopped."
                )
        # Settle jobs that never gained an execution thread, such as a job
        # registered by the failing tick itself; nothing else removes them
        # from the active registry.
        settled_jobs: list[dict[str, Any]] = []
        for job in ctx.state["jobs"]:
            if job["id"] in threaded_job_ids or job["id"] not in self._active_jobs:
                continue
            if job.get("status") not in ACTIVE_JOB_STATES:
                continue
            job["status"] = "interrupted"
            job["endedAt"] = _now_ms()
            job["terminalReason"] = "scheduler_failure"
            settled_jobs.append(job)
        if any(node["status"] == "unknown" for node in ctx.state["nodes"]):
            ctx.state["status"] = "unknown"
            ctx.state["endedAtMs"] = None
        else:
            ctx.state["status"] = "interrupted"
            ctx.state["endedAtMs"] = _now_ms()
        try:
            self._commit(ctx)
        except PersistenceError:
            ctx.state["status"] = "persistence-error"
            for job in settled_jobs:
                job["durable"] = False
                job["persistenceStatus"] = "error"
        for job in settled_jobs:
            self._active_jobs.pop(job["id"], None)
            if job.get("persistenceStatus") == "error":
                self._persistence_errors[job["id"]] = copy.deepcopy(job)
            else:
                self._terminal_jobs[job["id"]] = copy.deepcopy(job)
            self._emit_job(ctx, job)
        self._trim_terminal()
        if not ctx.processes:
            self._runs.pop(ctx.state["runId"], None)
        self._emit_run(ctx)

    def _trim_terminal(self) -> None:
        while len(self._terminal_jobs) > TERMINAL_CACHE_LIMIT:
            self._terminal_jobs.popitem(last=False)

    def _emit(self, method: str, params: dict[str, Any]) -> None:
        try:
            self.emitter.emit(method, params)
        except (OSError, ValueError):
            pass

    def _publish_runtime_event(self, base: dict[str, Any]) -> None:
        """Publish one runtime event under the lock that preserves wire order.

        Hold :attr:`_event_lock` across numbering and the write. Two producers
        that number under a lock and then write after releasing it can place
        sequence ``n+1`` on the wire ahead of sequence ``n``; the renderer drops
        every event that does not advance its cursor, so the inversion silently
        discards the earlier state transition.
        """
        with self._event_lock:
            self._sequence += 1
            self._emit(
                "runtime.event",
                {**base, "sequence": self._sequence, "at": _now_ms()},
            )

    def published_sequence(self) -> int:
        """Return the last sequence already written to the runtime stream."""
        with self._event_lock:
            return self._sequence

    def _runtime_event(
        self, ctx: _RunContext, kind: str, payload: dict[str, Any]
    ) -> None:
        with self._lock:
            base = {
                "projectId": ctx.project.project_id,
                "projectEpoch": ctx.project.epoch,
                "sidecarGeneration": self.sidecar_generation,
                "runId": ctx.state["runId"],
                "kind": kind,
                **payload,
            }
        self._publish_runtime_event(base)

    def emit_provision(
        self, project: ProjectIdentity, provision: dict[str, Any]
    ) -> None:
        """Publish provisioning on the same global runtime event stream."""
        with self._lock:
            base = {
                "projectId": project.project_id,
                "projectEpoch": project.epoch,
                "sidecarGeneration": self.sidecar_generation,
                "runId": None,
                "kind": "provision",
                "provision": copy.deepcopy(provision),
            }
        self._publish_runtime_event(base)

    def _emit_job(self, ctx: _RunContext, job: dict[str, Any]) -> None:
        self._emit("pipeline.jobUpdate", copy.deepcopy(job))
        self._runtime_event(ctx, "job", {"job": copy.deepcopy(job)})
        self._emit_terminal_job_error(ctx, job)

    def _emit_terminal_job_error(self, ctx: _RunContext, job: dict[str, Any]) -> None:
        """Emit one attributed error marker for each terminal job outcome."""
        message = _terminal_job_error_message(job)
        if message is None:
            return
        key = (
            str(job.get("runId", ctx.state.get("runId", ""))),
            str(job.get("id", "")),
            str(job.get("status", "")),
            str(job.get("terminalReason", "")),
            str(job.get("exitCode", "")),
        )
        with self._lock:
            if key in self._terminal_error_keys:
                return
            self._terminal_error_keys[key] = None
            while len(self._terminal_error_keys) > _TERMINAL_ERROR_CACHE_LIMIT:
                self._terminal_error_keys.popitem(last=False)
        self._emit_log(ctx, job, message, "ERROR")

    def _emit_run(self, ctx: _RunContext) -> None:
        self._runtime_event(ctx, "run", {"run": self._run_snapshot(ctx.state)})

    def _emit_log(
        self, ctx: _RunContext, job: dict[str, Any], line: str, level: str
    ) -> None:
        # The tail stays on the operator's own machine and names their own
        # project, so only secrets are removed: substituting paths and subject
        # IDs here left lines such as "[PROJECT][PATH]/[SUBJECT]/scripts" that
        # no longer point at the file the operator has to open. Exports still
        # run the full redaction.
        safe = redact_secrets(line)
        self._emit("pipeline.stdout", {"jobId": job["id"], "line": safe, "lev": level})
        entry = {
            "id": f"log-{uuid.uuid4().hex[:12]}",
            "runId": ctx.state["runId"],
            "jobId": job["id"],
            "at": _now_ms(),
            "level": level,
            "line": safe,
        }
        with self._lock:
            self._log_tail.append(entry)
        self._runtime_event(ctx, "log", {"log": entry})

    @staticmethod
    def _committed_log_path(store: RunStore, run_id: str, raw_path: Any) -> str | None:
        """Resolve only an absolute job log contained by this run's log root."""
        if not isinstance(raw_path, str) or not os.path.isabs(raw_path):
            return None
        logs_root = os.path.realpath(os.path.join(store.run_dir(run_id), "logs"))
        candidate = os.path.realpath(raw_path)
        try:
            if os.path.commonpath((candidate, logs_root)) != logs_root:
                return None
        except ValueError:
            return None
        if candidate == logs_root:
            return None
        return candidate

    def _replay_log_tail(
        self,
        store: RunStore,
        states: dict[str, dict[str, Any]],
        jobs: list[dict[str, Any]],
        live: list[dict[str, Any]],
        limit: int,
    ) -> _LogReplay:
        """Rehydrate a bounded secret-free tail from committed job log files.

        Report, beside the tail, how much of each job log the replay read, so
        the renderer can tell an empty log from one the replay never reached.
        """
        if limit <= 0:
            return _LogReplay(tail=[], coverage=[])
        live = [entry for entry in live if entry.get("runId") in states]
        live_job_ids = {str(entry.get("jobId", "")) for entry in live}
        candidates = [
            job
            for job in jobs
            if str(job.get("runId", "")) in states
            and str(job.get("id", "")) not in live_job_ids
        ]
        candidates.sort(
            key=lambda value: (_job_time(value), str(value.get("id", ""))),
            reverse=True,
        )
        # Spend the line budget newest job first, so the retained tail always
        # holds the latest work. The job that crosses the budget keeps only its
        # last lines, and older jobs are not read at all.
        replayed: list[dict[str, Any]] = []
        replay_extent: dict[tuple[str, str], int] = {}
        coverage: list[dict[str, Any]] = []
        inspected = 0
        for job in candidates:
            remaining = limit - len(replayed)
            if inspected >= _REPLAY_LOG_FILE_LIMIT or remaining <= 0:
                break
            run_id = str(job.get("runId", ""))
            path = self._committed_log_path(store, run_id, job.get("stdoutPath"))
            if path is None:
                continue
            inspected += 1
            try:
                lines, truncated = _tail_text_file(path)
            except OSError:
                continue
            base_time = _job_time(job)
            job_id = str(job.get("id", ""))
            coverage.append(
                {
                    "runId": run_id,
                    "jobId": job_id,
                    "lines": len(lines),
                    "complete": not truncated,
                }
            )
            projected: list[tuple[str, str]] = []
            if truncated:
                projected.append(
                    (
                        "WARN",
                        "Review only the bounded restart replay; expect earlier log "
                        "content to be omitted.",
                    )
                )
            projected.extend(("INFO", line) for line in lines)
            # Index each line within the whole job log, so its identity and time
            # do not depend on how much of the job fit in the budget.
            for index in range(max(0, len(projected) - remaining), len(projected)):
                level, line = projected[index]
                # Rehydrate the tail the way it was emitted: the operator reads
                # their own paths and subject IDs here, and only an export
                # redacts them.
                safe = redact_secrets(line)
                identity = hashlib.sha256(
                    f"{run_id}\0{job_id}\0{index}\0{level}\0{safe}".encode()
                ).hexdigest()[:16]
                replayed.append(
                    {
                        "id": f"log-replay-{identity}",
                        "runId": run_id,
                        "jobId": job_id,
                        "at": base_time + index,
                        "level": level,
                        "line": safe,
                    }
                )
            if projected:
                replay_extent[(run_id, job_id)] = len(projected)
        combined = [*replayed, *copy.deepcopy(live)]
        existing = {
            (
                str(entry.get("runId", "")),
                str(entry.get("jobId", "")),
                str(entry.get("level", "")),
                str(entry.get("line", "")),
            )
            for entry in combined
        }
        # A terminal marker keeps its own job's time, just after that job's
        # replayed lines, so an old resolved failure sorts before newer work
        # instead of ending the tail.
        for job in jobs:
            run_id = str(job.get("runId", ""))
            job_id = str(job.get("id", ""))
            message = _terminal_job_error_message(job)
            if run_id not in states or not job_id or message is None:
                continue
            safe = redact_secrets(message)
            marker = (run_id, job_id, "ERROR", safe)
            if marker in existing:
                continue
            identity = hashlib.sha256(
                f"{run_id}\0{job_id}\0terminal\0ERROR\0{safe}".encode()
            ).hexdigest()[:16]
            combined.append(
                {
                    "id": f"log-replay-{identity}",
                    "runId": run_id,
                    "jobId": job_id,
                    "at": _job_time(job) + replay_extent.get((run_id, job_id), 0),
                    "level": "ERROR",
                    "line": safe,
                }
            )
            existing.add(marker)
        combined.sort(
            key=lambda entry: (int(entry.get("at", 0)), str(entry.get("id", "")))
        )
        return _LogReplay(tail=combined[-limit:], coverage=coverage)

    def _run_snapshot(
        self, state: dict[str, Any], *, project_epoch: int | None = None
    ) -> dict[str, Any]:
        scope = state.get("scope", {}) if isinstance(state.get("scope"), dict) else {}
        analysis_subject_ids = scope.get("analysisSubjectIds", [])
        if not isinstance(analysis_subject_ids, list):
            analysis_subject_ids = []
        selected_subject_ids = scope.get("selectedSubjectIds", [])
        if not isinstance(selected_subject_ids, list):
            selected_subject_ids = []
        acknowledgements = state.get("acknowledgements", {})
        if not isinstance(acknowledgements, dict):
            acknowledgements = {}
        return {
            "runId": state["runId"],
            "projectId": state.get("project", {}).get("projectId", ""),
            "projectEpoch": (
                project_epoch
                if project_epoch is not None
                else state.get("project", {}).get("epoch", 0)
            ),
            "status": state.get("status", "unknown"),
            "startedAt": state.get("startedAtMs"),
            "endedAt": state.get("endedAtMs"),
            "dryRun": bool(state.get("dryRun")),
            "durable": bool(state.get("durable", True)),
            "analysisSubjectIds": [
                value for value in analysis_subject_ids if isinstance(value, str)
            ],
            "selectedSubjectIds": [
                value for value in selected_subject_ids if isinstance(value, str)
            ],
            "acknowledgements": {
                "includeDeferredAndUnreviewedQc": acknowledgements.get(
                    "includeDeferredAndUnreviewedQc"
                )
                is True,
                "acknowledgeMemoryAdvisory": acknowledgements.get(
                    "acknowledgeMemoryAdvisory"
                )
                is True,
            },
            "summary": self._state_summary(state),
            **self._quoted_reason_nodes(state),
        }

    @staticmethod
    def _quoted_reason_nodes(state: dict[str, Any]) -> dict[str, Any]:
        """Return the nodes behind the blocked reason the run summary quotes.

        A plan-time blocked node never becomes a job, and a reason such as the
        Reconstruction output conflict names no subject, so after a restart
        only the run's recorded nodes can say whose reason the summary
        quotes. This reads the committed graph and writes nothing; no digest,
        receipt, reuse rule, replay id or dedup text reads the result. The
        key is left out when no node qualifies, and when the nodes exceed the
        bound or a field is outside the renderer contract, since a partial
        list would name the wrong subjects.
        """
        nodes = state.get("nodes", [])
        if not isinstance(nodes, list):
            return {}
        not_run = [
            node
            for node in nodes
            if isinstance(node, dict)
            and node.get("status") in _NOT_RUN_NODE_STATUSES
            and node.get("reason")
        ]
        if not not_run:
            return {}
        # The summary quotes the first of the sorted reasons; see
        # _state_summary.
        quoted = min(str(node.get("reason")) for node in not_run)
        records = []
        for node in not_run:
            if str(node.get("reason")) != quoted:
                continue
            subject_id = node.get("subjectId")
            if (
                node.get("stepKey") not in STEP_BY_KEY
                or not (
                    subject_id is None
                    or (
                        isinstance(subject_id, str)
                        and 0 < len(subject_id) <= _QUOTED_REASON_ID_CHARACTERS
                        and "\0" not in subject_id
                    )
                )
                or len(quoted) > _QUOTED_REASON_CHARACTERS
                or "\0" in quoted
            ):
                return {}
            records.append(
                {
                    "stepKey": node["stepKey"],
                    "subjectId": subject_id,
                    "status": node["status"],
                    "reason": quoted,
                }
            )
        if (
            len(records) > _QUOTED_REASON_NODE_LIMIT
            or len(records) * len(quoted) > _QUOTED_REASON_TEXT_BUDGET
        ):
            return {}
        return {"quotedReasonNodes": records}

    @staticmethod
    def _state_summary(state: dict[str, Any]) -> dict[str, Any]:
        nodes = state.get("nodes", [])
        statuses = [node.get("status") for node in nodes]
        planned = sum(value in {"planned", "waiting", "queued"} for value in statuses)
        started = sum(
            value in {"running", "done", "failed", "cancelled", "unknown"}
            for value in statuses
        )
        waiting = sum(value in {"waiting", "queued"} for value in statuses)
        blocked = sum(value in {"blocked", "withheld", "stale"} for value in statuses)
        skipped = sum(value == "skipped" for value in statuses)
        blocked_reasons = sorted(
            {
                str(node.get("reason"))
                for node in nodes
                if node.get("status") in {"blocked", "withheld", "stale"}
                and node.get("reason")
            }
        )
        if blocked:
            # State a missing reason as a fact; the lead-in below carries the
            # one action, and only for a pass in which nothing runs.
            if blocked_reasons:
                detail = blocked_reasons[0]
            elif blocked == 1:
                detail = "The blocked node records no reason."
            else:
                detail = "The blocked nodes record no reason."
            if not detail.endswith((".", "!", "?")):
                detail += "."
            # The plan review lists every reason; the summary names the first
            # and counts the rest, so a block with no reason counts none.
            extra = max(len(blocked_reasons) - 1, 0)
            if extra == 1:
                suffix = " 1 more reason applies."
            elif extra:
                suffix = f" {extra} more reasons apply."
            else:
                suffix = ""
            # Lead with the runnable work when any exists; the resolve
            # imperative belongs only to a pass in which nothing runs.
            active = planned + started
            if active:
                waiting_part = (
                    f" ({waiting} waiting on dependencies)" if waiting else ""
                )
                message = (
                    f"This pass runs {active} node{'s' if active != 1 else ''}"
                    f"{waiting_part}; {blocked} blocked "
                    f"node{'s' if blocked != 1 else ''} will not run. "
                    f"{detail}{suffix}"
                )
            else:
                message = (
                    f"Resolve {blocked} blocked node{'s' if blocked != 1 else ''}. "
                    f"{detail}{suffix}"
                )
        elif statuses and skipped == len(statuses):
            # State the no-op as a fact: the operator has nothing to confirm.
            message = (
                "No work is scheduled: the 1 node is current."
                if skipped == 1
                else f"No work is scheduled: all {skipped} nodes are current."
            )
        elif not statuses:
            message = "No work is scheduled."
        else:
            status = str(state.get("status", "unknown"))
            message = _RUN_STATUS_SENTENCES.get(status, f"The run status is {status}.")
        return {
            "planned": planned,
            "started": started,
            "waiting": waiting,
            "blocked": blocked,
            "skipped": skipped,
            "message": message,
        }

    def _mark_cancellation_persistence_error(
        self, ctx: _RunContext, *, reason: str
    ) -> None:
        """Keep failed cancellation state honest and live processes reachable."""
        ctx.persistence_failed = True
        ctx.halt_new = True
        now = _now_ms()
        ctx.state["status"] = "persistence-error"
        ctx.state["durable"] = False
        ctx.state["endedAtMs"] = now
        ctx.state["terminalReason"] = "persistence_error"
        for node in ctx.state["nodes"]:
            if (
                node["status"] not in TERMINAL_NODE_STATES
                or node["status"] == "cancelled"
            ):
                node["status"] = "interrupted"
                node["reason"] = reason
        for job in ctx.state["jobs"]:
            if job["id"] not in self._active_jobs:
                continue
            event = ctx.cancel_events.setdefault(job["id"], threading.Event())
            event.set()
            job["status"] = "persistence-error"
            job["durable"] = False
            job["persistenceStatus"] = "error"
            job["terminalReason"] = "persistence_error"
            self._persistence_errors[job["id"]] = copy.deepcopy(job)
            if job.get("startedAt") is None and job["id"] not in ctx.processes:
                job["endedAt"] = now
                self._active_jobs.pop(job["id"], None)

    def cancel_job(self, job_id: str) -> None:
        """Request cancellation for one active or queued job."""
        proc: Any | None = None
        with self._wake:
            job = self._active_jobs.get(job_id)
            if job is None:
                return
            ctx = self._runs.get(job["runId"])
            if ctx is None:
                return
            event = ctx.cancel_events.setdefault(job_id, threading.Event())
            event.set()
            node = next(
                value
                for value in ctx.state["nodes"]
                if value["nodeId"] == job["nodeId"]
            )
            if job["status"] == "queued":
                job["status"] = "cancelled"
                job["endedAt"] = _now_ms()
                job["terminalReason"] = "operator_cancelled_before_start"
                node["status"] = "cancelled"
                self._recompute_run(ctx)
                try:
                    self._commit(ctx)
                except PersistenceError:
                    self._mark_cancellation_persistence_error(
                        ctx,
                        reason="The cancellation could not be persisted.",
                    )
                else:
                    self._active_jobs.pop(job_id, None)
                    self._terminal_jobs[job_id] = copy.deepcopy(job)
                    self._trim_terminal()
                self._emit_job(ctx, job)
            elif job["status"] == "unknown":
                job["terminalReason"] = "operator_cancellation_requested"
                try:
                    self._commit(ctx)
                except PersistenceError:
                    job["durable"] = False
                    job["persistenceStatus"] = "error"
                    self._persistence_errors[job_id] = copy.deepcopy(job)
                self._emit_job(ctx, job)
                proc = ctx.processes.get(job_id)
            else:
                job["status"] = "cancelling"
                job["terminalReason"] = "operator_cancellation_requested"
                try:
                    self._commit(ctx)
                except PersistenceError:
                    self._mark_cancellation_persistence_error(
                        ctx,
                        reason="The cancellation could not be persisted.",
                    )
                self._emit_job(ctx, job)
                proc = ctx.processes.get(job_id)
            self._wake.notify_all()
        if proc is not None:
            _terminate_tree(proc)
            _schedule_force_termination(proc)

    def cancel_run(
        self, request: dict[str, Any], timeout: float = 5.0
    ) -> dict[str, Any]:
        """Cancel every schedulable node and await active process settlement."""
        project = self._validate_request(request, require_cfg=False)
        run_id = str(request.get("runId", ""))
        cancelled_jobs: list[dict[str, Any]] = []
        processes: list[Any] = []
        persistence_failed = False
        terminal_without_processes = False
        with self._wake:
            ctx = self._runs.get(run_id)
            if (
                ctx is None
                or ctx.project.project_id != project.project_id
                or ctx.project.epoch != project.epoch
            ):
                return {
                    "runId": run_id,
                    "accepted": False,
                    "terminal": True,
                    "pendingJobIds": [],
                    "message": "No active run of this project has this run ID.",
                }
            ctx.halt_new = True
            for node in ctx.state["nodes"]:
                if node["status"] in {"planned", "waiting"}:
                    node["status"] = "cancelled"
                    node["reason"] = (
                        "This work was canceled before scheduling at the operator's "
                        "request."
                    )
            for job in ctx.state["jobs"]:
                if job["status"] not in ACTIVE_JOB_STATES:
                    continue
                event = ctx.cancel_events.setdefault(job["id"], threading.Event())
                event.set()
                node = next(
                    value
                    for value in ctx.state["nodes"]
                    if value["nodeId"] == job["nodeId"]
                )
                if job["status"] == "queued":
                    job["status"] = "cancelled"
                    job["endedAt"] = _now_ms()
                    job["terminalReason"] = "operator_cancelled_before_start"
                    node["status"] = "cancelled"
                    node["reason"] = (
                        "This work was canceled before scheduling at the operator's "
                        "request."
                    )
                    cancelled_jobs.append(job)
                elif job["status"] != "unknown":
                    job["status"] = "cancelling"
                    job["terminalReason"] = "operator_cancellation_requested"
                else:
                    job["terminalReason"] = "operator_cancellation_requested"
            processes = list(ctx.processes.values())
            self._recompute_run(ctx)
            try:
                self._commit(ctx)
            except PersistenceError:
                persistence_failed = True
                self._mark_cancellation_persistence_error(
                    ctx,
                    reason="The run cancellation could not be persisted.",
                )
            else:
                for job in cancelled_jobs:
                    self._active_jobs.pop(job["id"], None)
                    self._terminal_jobs[job["id"]] = copy.deepcopy(job)
                self._trim_terminal()
                terminal_without_processes = not processes and all(
                    node["status"] in TERMINAL_NODE_STATES
                    for node in ctx.state["nodes"]
                )
                if terminal_without_processes:
                    self._finish_run_if_terminal(ctx)
            self._wake.notify_all()
        for job in cancelled_jobs:
            self._emit_job(ctx, job)
        if not terminal_without_processes:
            self._emit_run(ctx)
        for proc in processes:
            _terminate_tree(proc)
            _schedule_force_termination(proc)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                pending = [
                    job["id"]
                    for job in ctx.state["jobs"]
                    if job["status"] in ACTIVE_JOB_STATES
                ]
                pending.extend(
                    job_id for job_id in ctx.processes if job_id not in pending
                )
            if not pending:
                break
            time.sleep(0.02)
        with self._lock:
            pending = [
                job["id"]
                for job in ctx.state["jobs"]
                if job["status"] in ACTIVE_JOB_STATES
            ]
            pending.extend(job_id for job_id in ctx.processes if job_id not in pending)
        return {
            "runId": run_id,
            "accepted": True,
            "terminal": not pending
            and all(
                node["status"] in TERMINAL_NODE_STATES for node in ctx.state["nodes"]
            ),
            "pendingJobIds": pending,
            "message": (
                "The run cancellation could not be persisted."
                if persistence_failed
                else "Cancellation settled."
                if not pending
                else "Cancellation is still settling."
            ),
        }

    def resume(self, request: dict[str, Any], *, retry: bool = False) -> dict[str, Any]:
        """Resume or retry a persisted authoritative workflow graph."""
        retry = validate_boolean(retry, "retry")
        project = self._validate_request(request)
        config_revision = validate_config_revision(request.get("configRevision", 0))
        preview_only = validate_boolean(
            request.get("previewOnly", False), "previewOnly"
        )
        approved_plan: tuple[str, str] | None = (
            None if preview_only else self._approved_plan(request)
        )
        store = RunStore(project.root)
        old = store.load(str(request.get("runId", "")))
        if not old.get("nodes"):
            raise ValueError("Select a run with a resumable authoritative graph.")
        old_project = old.get("project", {})
        if (
            old_project.get("projectId") != project.project_id
            or os.path.realpath(str(old_project.get("root", ""))) != project.root
        ):
            raise ValueError("Select a run from the current project.")

        cfg = copy.deepcopy(request["cfg"])
        runtime = cfg.get("runtime", {}) if isinstance(cfg.get("runtime"), dict) else {}
        dry_run = bool(runtime.get("dryRun", False))
        if not preview_only and not dry_run and self.project_active(project.project_id):
            raise ValueError(
                "Wait for the active workflow to finish before starting another for "
                "this project."
            )
        if not preview_only and not dry_run:
            self.reconcile_project_ownership(project.to_dict())
        if not preview_only and not dry_run and self.project_active(project.project_id):
            raise ValueError(
                "Wait for the active workflow to finish before starting another for "
                "this project."
            )
        clean = (
            validate_boolean(request.get("cleanIncomplete", False), "cleanIncomplete")
            if retry
            else False
        )
        if retry:
            validate_boolean(request.get("includeCancelled", False), "includeCancelled")
        acknowledgements = validate_workflow_acknowledgements(
            request.get("acknowledgements", {})
        )
        source_intent = copy.deepcopy(old.get("sourceIntent", old.get("intent", {})))
        source_analysis = [
            str(subject_id)
            for subject_id in old.get("scope", {}).get("analysisSubjectIds", [])
            if isinstance(subject_id, str)
        ]
        source_selected = [
            str(subject_id)
            for subject_id in old.get("scope", {}).get(
                "selectedSubjectIds", source_analysis
            )
            if isinstance(subject_id, str)
        ]
        source_nodes = [node for node in old.get("nodes", []) if isinstance(node, dict)]
        retry_selected_subject_ids = (
            _selected_retry_subject_ids(source_nodes, request) if retry else None
        )
        effective_intent, selection_reconciliation = _resume_intent(
            source_intent,
            cfg,
            acknowledgements,
            source_analysis_subject_ids=source_analysis,
            source_selected_subject_ids=(
                retry_selected_subject_ids
                if retry_selected_subject_ids is not None
                else source_selected
            ),
            recovery_decision_subject_ids=retry_selected_subject_ids,
        )
        retained_analysis = (
            list(selection_reconciliation["retainedSubjectIds"])
            if selection_reconciliation is not None
            else source_analysis
        )
        run_id = (
            approved_plan[0]
            if approved_plan is not None
            else f"run-{uuid.uuid4().hex[:12]}"
        )
        synthetic = {
            "project": project.to_dict(),
            "cfg": cfg,
            "configRevision": config_revision,
            "intent": effective_intent,
            "acknowledgements": acknowledgements,
            "_recoveryAnalysisSubjectIds": retained_analysis,
            "_inputFovReviewManager": self.input_fov_reviews,
        }
        report = self._environment(cfg)
        synthetic["runtimeContext"] = copy.deepcopy(request.get("runtimeContext"))
        planned = build_plan(synthetic, run_id=run_id, env_report=report)
        if selection_reconciliation is not None:
            planned.result["plan"]["selectionReconciliation"] = copy.deepcopy(
                selection_reconciliation
            )
        if planned.cohort is None or planned.result["disposition"] == "blocked":
            recovery_binding = {
                "action": "retry" if retry else "resume",
                "sourceRunId": old["runId"],
                "includeCancelled": bool(request.get("includeCancelled", False))
                if retry
                else False,
                "cleanIncomplete": clean,
                "nodeIds": copy.deepcopy(request.get("nodeIds"))
                if retry and "nodeIds" in request
                else None,
            }
            self._complete_plan_binding(
                planned,
                synthetic,
                project,
                report,
                recovery_binding=recovery_binding,
            )
            planned.result["runId"] = None
            if not preview_only and (
                approved_plan is None
                or planned.result["plan"].get("planId") != approved_plan[0]
                or planned.result["plan"].get("digest") != approved_plan[1]
            ):
                raise PlanStaleError
            return planned.result
        state = self._new_state(run_id, synthetic, project, planned, dry_run, report)
        state["parentRunId"] = old["runId"]
        state["sourceIntent"] = copy.deepcopy(source_intent)
        state["recoveryAction"] = "retry" if retry else "resume"
        state["receipts"] = copy.deepcopy(old.get("receipts", []))
        state["recovery"] = {
            "state": "reconciled",
            "detail": f"{'Retried' if retry else 'Resumed'} from {old['runId']}.",
        }
        if selection_reconciliation is not None:
            state["selectionReconciliation"] = copy.deepcopy(selection_reconciliation)
            state["recovery"]["selection"] = copy.deepcopy(selection_reconciliation)
        old_analysis = set(source_analysis)
        new_analysis = set(planned.cohort.analysis_subject_ids)
        cohort_reconciliation = {
            "addedCount": len(new_analysis - old_analysis),
            "removedCount": len(old_analysis - new_analysis),
            "reason": (
                "Only subjects in both the source cohort and the current eligible "
                "cohort are kept; no new subjects are added."
            ),
        }
        state["cohortReconciliation"] = cohort_reconciliation
        state["recovery"]["cohort"] = copy.deepcopy(cohort_reconciliation)
        ctx = _RunContext(
            state=state,
            cfg=cfg,
            effective_cfg=planned.effective_cfg,
            cohort=planned.cohort,
            project=project,
            store=store,
            queue_limit=max(1, int(runtime.get("queueSize", 2))),
        )
        with self._planning_pass(ctx):
            self._reconcile_recovery_nodes(ctx, old, request, retry=retry)
            self._apply_runtime_policy(ctx)
            self._apply_stage_readiness(ctx)
        planned.result["plan"]["nodes"] = copy.deepcopy(state["nodes"])
        planned.result["summary"] = self._state_summary(state)
        planned.result["plan"]["summary"] = planned.result["summary"]
        runnable = any(
            node["status"] in {"planned", "waiting"} for node in state["nodes"]
        )
        recovery_binding = {
            "action": "retry" if retry else "resume",
            "sourceRunId": old["runId"],
            "includeCancelled": (
                validate_boolean(
                    request.get("includeCancelled", False), "includeCancelled"
                )
                if retry
                else False
            ),
            "cleanIncomplete": clean,
            "nodeIds": copy.deepcopy(request.get("nodeIds"))
            if retry and "nodeIds" in request
            else None,
        }
        self._sync_runtime_blockers(planned)
        self._complete_plan_binding(
            planned,
            synthetic,
            project,
            report,
            recovery_binding=recovery_binding,
        )
        state["planBinding"] = {
            key: copy.deepcopy(planned.result["plan"].get(key))
            for key in (
                "planId",
                "digest",
                "configDigest",
                "qcDigest",
                "registryDigest",
                "environmentDigest",
                "resources",
                "exclusions",
                "selectionReconciliation",
                "recovery",
            )
        }
        if clean:
            self._validate_clean_incomplete(ctx)
        if preview_only:
            planned.result["runId"] = None
            if not runnable:
                planned.result["disposition"] = (
                    "blocked"
                    if any(node["status"] == "blocked" for node in state["nodes"])
                    else "noop"
                )
            else:
                planned.result["disposition"] = "planned"
            return planned.result
        if approved_plan is None or (
            planned.result["plan"].get("planId") != approved_plan[0]
            or planned.result["plan"].get("digest") != approved_plan[1]
        ):
            raise PlanStaleError
        if not runnable:
            planned.result["runId"] = None
            planned.result["disposition"] = (
                "blocked"
                if any(node["status"] == "blocked" for node in state["nodes"])
                else "noop"
            )
            return planned.result
        if run_id in store.run_ids():
            raise PlanStaleError
        if not dry_run:
            authorization = request.get("liveExecutionAuthorization")
            if (
                isinstance(authorization, dict)
                and authorization.get("planDigest") != approved_plan[1]
            ):
                raise PlanStaleError
            self.authorizations.consume(
                authorization,
                project_id=project.project_id,
                config_revision=config_revision,
                purpose="cleanup" if clean else "live-workflow",
            )
        if dry_run:
            self._materialize_dry_run_jobs(ctx)
        self._commit(ctx)
        if clean and not dry_run:
            try:
                self._clean_incomplete_recon(ctx)
            except (OSError, ValueError):
                for node in state["nodes"]:
                    if node["status"] in {"planned", "waiting"}:
                        node["status"] = "blocked"
                        node["reason"] = (
                            "The authorized cleanup failed, so this work did not start."
                        )
                state["status"] = "blocked"
                state["terminalReason"] = "cleanup_failed"
                state["endedAtMs"] = _now_ms()
                state["warnings"].append(
                    "The authorized cleanup failed, so no scientific process was "
                    "launched."
                )
                self._commit(ctx)
                planned.result["runId"] = None
                planned.result["disposition"] = "blocked"
                planned.result["summary"] = self._state_summary(state)
                planned.result["plan"]["nodes"] = copy.deepcopy(state["nodes"])
                planned.result["plan"]["summary"] = planned.result["summary"]
                return planned.result
            self._commit(ctx)
        elif clean:
            state["warnings"].append("The dry run does not remove incomplete outputs.")
            self._commit(ctx)
        if dry_run:
            planned.result["runId"] = run_id
            planned.result["disposition"] = "planned"
            for job in ctx.state["jobs"]:
                self._emit_job(ctx, job)
            self._emit_run(ctx)
            return planned.result
        with self._wake:
            self._runs[run_id] = ctx
            self._wake.notify_all()
        planned.result["runId"] = run_id
        planned.result["disposition"] = "started"
        self._emit_run(ctx)
        return planned.result

    def _reconcile_recovery_nodes(
        self,
        ctx: _RunContext,
        old: dict[str, Any],
        request: dict[str, Any],
        *,
        retry: bool,
    ) -> None:
        """Retain current successes and recover the invalid dependency closure."""
        old_nodes = old.get("nodes", [])
        old_by_identity = {
            (node.get("stepKey"), node.get("subjectId")): node for node in old_nodes
        }
        selection_explicit = retry and "nodeIds" in request
        raw_selected_ids = request.get("nodeIds") if selection_explicit else None
        if selection_explicit and not isinstance(raw_selected_ids, list):
            raise ValueError("Provide retry nodeIds as an array.")
        if selection_explicit and any(
            not isinstance(value, str) for value in raw_selected_ids
        ):
            raise ValueError("Include only strings in retry nodeIds.")
        selected_ids = set(raw_selected_ids or []) if retry else set()
        known_ids = {str(node.get("nodeId")) for node in old_nodes}
        unknown_ids = selected_ids - known_ids
        if unknown_ids:
            raise ValueError("Select only known source nodes for retry.")
        selected_identities = {
            (node.get("stepKey"), node.get("subjectId"))
            for node in old_nodes
            if not selection_explicit or node.get("nodeId") in selected_ids
        }
        include_cancelled = (
            validate_boolean(request.get("includeCancelled", False), "includeCancelled")
            if retry
            else False
        )
        valid: set[tuple[Any, Any]] = set()
        invalid: set[tuple[Any, Any]] = set()
        cancelled_identities = {
            (node.get("stepKey"), node.get("subjectId"))
            for node in old_nodes
            if node.get("status") == "cancelled"
        }
        recoverable = {
            "failed",
            "interrupted",
            "blocked",
            "withheld",
            "stale",
            "planned",
            "waiting",
            "queued",
            "running",
            "persistence-error",
        }
        ctx.forced_retry_identities.clear()
        for node in ctx.state["nodes"]:
            identity = (node.get("stepKey"), node.get("subjectId"))
            prior = old_by_identity.get(identity)
            if prior is None:
                continue
            prior_status = str(prior.get("status", "unknown"))
            force_retry = (
                selection_explicit
                and identity in selected_identities
                and (
                    prior_status in recoverable
                    or (prior_status == "cancelled" and include_cancelled)
                )
            )
            if force_retry:
                # Treat the source node's terminal status as authoritative for an
                # explicit Retry. Reject detector output that only looks complete
                # after a failed process, even when an older receipt still matches.
                ctx.forced_retry_identities.add(identity)
                invalid.add(identity)
                continue
            if self._current_receipt(ctx, node) is not None:
                valid.add(identity)
                continue
            eligible = prior_status == "done" or prior_status in recoverable
            if prior_status == "cancelled":
                eligible = retry and include_cancelled
            if eligible:
                invalid.add(identity)

        node_by_id = {node["nodeId"]: node for node in ctx.state["nodes"]}
        identity_by_id = {
            node["nodeId"]: (node.get("stepKey"), node.get("subjectId"))
            for node in ctx.state["nodes"]
        }
        if retry and selection_explicit:
            # Recover every invalid transitive prerequisite before running a
            # selected invalid downstream node. Retain valid prerequisites as
            # successes without repeating them.
            ancestors = {
                identity
                for identity in selected_identities
                if identity in set(identity_by_id.values())
            }
            changed = True
            while changed:
                changed = False
                for node in ctx.state["nodes"]:
                    identity = (node.get("stepKey"), node.get("subjectId"))
                    if identity not in ancestors:
                        continue
                    for dependency_id in node.get("dependencies", []):
                        dependency = identity_by_id.get(dependency_id)
                        if dependency is not None and dependency not in ancestors:
                            ancestors.add(dependency)
                            changed = True
            roots = invalid & ancestors
        else:
            roots = set(invalid)
        closure = set(roots)
        changed = True
        while changed:
            changed = False
            for node in ctx.state["nodes"]:
                identity = (node.get("stepKey"), node.get("subjectId"))
                if identity in closure:
                    continue
                if identity in cancelled_identities and not (
                    retry and include_cancelled
                ):
                    continue
                dependencies = [
                    node_by_id[value]
                    for value in node.get("dependencies", [])
                    if value in node_by_id
                ]
                if any(
                    (dependency.get("stepKey"), dependency.get("subjectId")) in closure
                    for dependency in dependencies
                ):
                    closure.add(identity)
                    changed = True

        for node in ctx.state["nodes"]:
            identity = (node.get("stepKey"), node.get("subjectId"))
            if identity in valid:
                node["status"] = "skipped"
                node["reason"] = (
                    "The current detector-backed success from the source run is kept."
                )
            elif identity in closure:
                if node["status"] in {"planned", "waiting"}:
                    node.pop("reason", None)
            else:
                node["status"] = "skipped"
                node["reason"] = (
                    "This work is outside the invalid source-node recovery "
                    "closure, so it is not scheduled."
                )
        ctx.state["recoveryRoots"] = [
            {"stepKey": step_key, "subjectId": subject_id}
            for step_key, subject_id in sorted(
                roots, key=lambda item: (str(item[0]), str(item[1]))
            )
        ]

    def _validate_clean_incomplete(self, ctx: _RunContext) -> None:
        roots = ctx.state.get("recoveryRoots", [])
        if not roots:
            raise OperatorError(
                "Use Resume because Clean and retry has no incomplete Reconstruction "
                "output to remove safely."
            )
        if any(item.get("stepKey") != "recon" for item in roots):
            raise OperatorError(
                "Resume the run or rerun the affected stage because Clean and retry "
                "can remove only incomplete Reconstruction output."
            )
        adapter = ADAPTERS["recon"]
        for item in roots:
            subject_id = str(item.get("subjectId") or "")
            if adapter.detect(ctx.effective_cfg, subject_id).state == "done":
                raise OperatorError(
                    "Resume the run because Clean and retry will not delete a "
                    "Reconstruction tree that the detector reports as complete."
                )

    def _clean_incomplete_recon(self, ctx: _RunContext) -> None:
        """Remove only explicit incomplete Recon trees before an authorized retry."""
        roots = {
            (item.get("stepKey"), item.get("subjectId"))
            for item in ctx.state.get("recoveryRoots", [])
        }
        candidates = [
            node
            for node in ctx.state["nodes"]
            if (node.get("stepKey"), node.get("subjectId")) in roots
        ]
        cleaned = []
        adapter = ADAPTERS["recon"]
        for node in candidates:
            subject_id = str(node.get("subjectId") or "")
            status = adapter.detect(ctx.effective_cfg, subject_id)
            if status.state == "done":
                raise OperatorError(
                    "Resume the run because Clean and retry will not delete a "
                    "Reconstruction tree that the detector reports as complete."
                )
            argv = adapter.build_command(ctx.effective_cfg, subject_id)
            subjects_dir = os.path.realpath(argv[argv.index("-sd") + 1])
            target = os.path.realpath(os.path.join(subjects_dir, subject_id))
            if os.path.commonpath((target, subjects_dir)) != subjects_dir:
                raise ValueError("Select a safe Recon cleanup target.")
            if os.path.lexists(target):
                if os.path.islink(target) or not os.path.isdir(target):
                    raise ValueError("Select an owned Recon cleanup directory.")
                shutil.rmtree(target)
                _fsync_directory(subjects_dir)
                cleaned.append(subject_id)
        ctx.state["cleanup"] = {
            "kind": "recon-incomplete",
            "subjectIds": cleaned,
            "atMs": _now_ms(),
        }

    def manifest_for_run(
        self, project_raw: dict[str, Any], run_id: str
    ) -> dict[str, Any]:
        """Return the durable reproducibility manifest for one run."""
        project = self.project_epochs.validate(project_raw)
        return RunStore(project.root).load(run_id)["manifest"]

    def manifest_list(
        self, project_raw: dict[str, Any], cursor: str | None, limit: int
    ) -> dict[str, Any]:
        """Return one bounded page of durable run manifests."""
        project = self.project_epochs.validate(project_raw)
        page = RunStore(project.root).list(cursor=int(cursor or 0), limit=limit)
        return {
            "items": page["items"],
            "nextCursor": str(page["nextCursor"])
            if page["nextCursor"] is not None
            else None,
        }

    def bootstrap(self, request: dict[str, Any]) -> dict[str, Any]:
        """Rehydrate bounded project run/job/log/provision state after restart."""
        project = self._validate_request(request, require_cfg=False)
        store = RunStore(project.root)
        runs: list[dict[str, Any]] = []
        jobs: list[dict[str, Any]] = []
        states: dict[str, dict[str, Any]] = {}
        index_key = f"unreadable-index:{project.project_id}"
        try:
            store.verify_index()
            page = store.list(limit=int(request.get("runLimit", 50)))
            indexed_run_ids = store.run_ids()
        except OSError as exc:
            index_error: OSError | None = exc
            page = {"items": []}
            indexed_run_ids = []
        else:
            index_error = None
        if index_error is None:
            with self._lock:
                self._unresolved_processes.pop(index_key, None)
        else:
            unresolved_index = {
                "projectId": project.project_id,
                "projectEpoch": project.epoch,
                "runId": None,
                "state": "unknown",
                "provedStopped": False,
                "detail": (
                    "Run ownership is unknown because the durable run index "
                    f"could not be verified ({type(index_error).__name__})."
                ),
            }
            with self._lock:
                self._unresolved_processes[index_key] = unresolved_index
            synthetic_run_id = (
                "run-"
                + hashlib.sha256(
                    f"{project.project_id}\0unreadable-run-index".encode()
                ).hexdigest()[:12]
            )
            unknown_state = {
                "runId": synthetic_run_id,
                "project": project.to_dict(),
                "status": "unknown",
                "startedAtMs": None,
                "endedAtMs": None,
                "dryRun": False,
                "durable": False,
                "nodes": [
                    {
                        "nodeId": "recovery:unreadable-run-index",
                        "status": "unknown",
                    }
                ],
                "jobs": [],
                "acknowledgements": {},
                "recovery": copy.deepcopy(unresolved_index),
            }
            runs.append(self._run_snapshot(unknown_state, project_epoch=project.epoch))
            states[synthetic_run_id] = unknown_state
        page_run_ids = [
            str(manifest.get("runId"))
            for manifest in page["items"]
            if isinstance(manifest, dict) and manifest.get("runId")
        ]
        page_run_id_set = set(page_run_ids)
        all_run_ids = [
            *page_run_ids,
            *(run_id for run_id in indexed_run_ids if run_id not in page_run_id_set),
        ]
        unreadable_prefix = f"unreadable:{project.project_id}:"
        with self._lock:
            for key in tuple(self._unresolved_processes):
                if key.startswith(unreadable_prefix):
                    self._unresolved_processes.pop(key, None)
        for run_id in all_run_ids:
            try:
                state = store.load(run_id)
            except (ValueError, PersistenceError) as exc:
                if isinstance(exc, ValueError) and _commit_pointer_absent(
                    store, run_id
                ):
                    # An interrupted first commit leaves a run directory with
                    # no pointer. The run never registered with the scheduler,
                    # so treating it as unknown ownership would block the
                    # project forever over debris that owns nothing.
                    if run_id in page_run_id_set:
                        settled_state = {
                            "runId": run_id,
                            "project": project.to_dict(),
                            "status": "interrupted",
                            "startedAtMs": None,
                            "endedAtMs": None,
                            "dryRun": False,
                            "durable": False,
                            "nodes": [],
                            "jobs": [],
                            "acknowledgements": {},
                            "recovery": {
                                "state": "interrupted",
                                "detail": (
                                    "This run directory never committed a "
                                    "durable generation and spawned no process."
                                ),
                            },
                        }
                        runs.append(
                            self._run_snapshot(
                                settled_state, project_epoch=project.epoch
                            )
                        )
                        states[run_id] = settled_state
                    continue
                unresolved_key = f"unreadable:{project.project_id}:{run_id}"
                unresolved = {
                    "projectId": project.project_id,
                    "projectEpoch": project.epoch,
                    "runId": run_id,
                    "state": "unknown",
                    "provedStopped": False,
                    "detail": (
                        "Run ownership is unknown because its durable state "
                        f"could not be verified ({type(exc).__name__})."
                    ),
                }
                with self._lock:
                    self._unresolved_processes[unresolved_key] = unresolved
                if run_id in page_run_id_set:
                    unknown_state = {
                        "runId": run_id,
                        "project": project.to_dict(),
                        "status": "unknown",
                        "startedAtMs": None,
                        "endedAtMs": None,
                        "dryRun": False,
                        "durable": False,
                        "nodes": [
                            {
                                "nodeId": "recovery:unreadable-run-state",
                                "status": "unknown",
                            }
                        ],
                        "jobs": [],
                        "acknowledgements": {},
                        "recovery": copy.deepcopy(unresolved),
                    }
                    runs.append(
                        self._run_snapshot(unknown_state, project_epoch=project.epoch)
                    )
                    states[run_id] = unknown_state
                continue
            with self._lock:
                self._unresolved_processes.pop(
                    f"unreadable:{project.project_id}:{run_id}", None
                )
            state_project = state.get("project", {})
            if (
                state_project.get("projectId") != project.project_id
                or os.path.realpath(str(state_project.get("root", ""))) != project.root
            ):
                continue
            with self._lock:
                owned_current = str(state.get("runId")) in self._runs
            has_active_jobs = any(
                job.get("status") in ACTIVE_JOB_STATES for job in state.get("jobs", [])
            )
            if (
                not owned_current
                and not has_active_jobs
                and str(state.get("status") or "") in UNSETTLED_RUN_STATES
            ):
                # Close a run that claims live work but owns no live process and
                # left no active job behind. Derive the outcome from the durable
                # nodes; never respawn or adopt anything.
                _settle_unowned_run(state)
                state["manifest"] = self._manifest(state)
                try:
                    store.commit(state)
                except PersistenceError:
                    state["status"] = "persistence-error"
                    state["durable"] = False
            if not owned_current and has_active_jobs:
                unresolved_job_ids: set[str] = set()
                for job in state.get("jobs", []):
                    prior_status = job.get("status")
                    if prior_status not in {
                        "queued",
                        "running",
                        "cancelling",
                        "unknown",
                    }:
                        continue
                    job_id = str(job.get("id") or "")
                    unresolved_key = (
                        str(job.get("processOwnership", {}).get("claimId") or "")
                        if isinstance(job.get("processOwnership"), dict)
                        else ""
                    ) or f"unclaimed:{state.get('runId')}:{job_id}"
                    if prior_status == "queued":
                        job["status"] = "interrupted"
                        job["endedAt"] = _now_ms()
                        job["terminalReason"] = "stale_sidecar_generation"
                        with self._lock:
                            self._unresolved_processes.pop(unresolved_key, None)
                        continue
                    owner = job.get("processOwnership")
                    valid_owner = (
                        isinstance(owner, dict)
                        and owner.get("operationKind") == "workflow"
                        and owner.get("ownerId") == job_id
                        and owner.get("jobId") == job_id
                        and owner.get("runId") == state.get("runId")
                        and owner.get("projectId") == project.project_id
                        and owner.get("projectEpoch")
                        == state_project.get("epoch", state_project.get("projectEpoch"))
                    )
                    outcome, reconciled = (
                        self.reconcile_process_owner(owner)
                        if valid_owner
                        else ("unknown", copy.deepcopy(owner))
                    )
                    if isinstance(reconciled, dict):
                        job["processOwnership"] = reconciled
                    if outcome == "stopped":
                        job["status"] = "interrupted"
                        job["endedAt"] = _now_ms()
                        job["terminalReason"] = "stale_process_tree_settled"
                        with self._lock:
                            self._unresolved_processes.pop(unresolved_key, None)
                    else:
                        job["status"] = "unknown"
                        job["endedAt"] = None
                        job["terminalReason"] = "process_tree_unverified"
                        unresolved_job_ids.add(job_id)
                        unresolved_owner = (
                            reconciled
                            if isinstance(reconciled, dict)
                            else {
                                "projectId": project.project_id,
                                "runId": state.get("runId"),
                                "jobId": job_id,
                                "state": "unknown",
                                "detail": "Active work has no durable owner record.",
                            }
                        )
                        with self._lock:
                            self._unresolved_processes[unresolved_key] = (
                                unresolved_owner
                            )
                for node in state.get("nodes", []):
                    if node.get("status") in {
                        "queued",
                        "running",
                        "waiting",
                        "planned",
                        "unknown",
                    }:
                        node_job = next(
                            (
                                candidate
                                for candidate in state.get("jobs", [])
                                if candidate.get("nodeId") == node.get("nodeId")
                            ),
                            None,
                        )
                        if (
                            isinstance(node_job, dict)
                            and str(node_job.get("id") or "") in unresolved_job_ids
                        ):
                            node["status"] = "unknown"
                            node["reason"] = (
                                "Settlement of the prior process tree could not be "
                                "proved."
                            )
                        else:
                            node["status"] = "interrupted"
                            node["reason"] = (
                                "This work was marked interrupted because no "
                                "process was executing it."
                            )
                if unresolved_job_ids:
                    state["status"] = "unknown"
                    state["endedAtMs"] = None
                    state["terminalReason"] = "process_tree_unverified"
                    state["recovery"] = {
                        "state": "unknown",
                        "detail": (
                            "Ownership of the prior scientific process could not "
                            "be verified."
                        ),
                    }
                else:
                    state["status"] = "interrupted"
                    state["endedAtMs"] = _now_ms()
                    state["terminalReason"] = "stale_process_tree_settled"
                    state["recovery"] = {
                        "state": "interrupted",
                        "detail": (
                            "Bootstrap conclusively settled stale process "
                            "ownership for this run."
                        ),
                    }
                state["manifest"] = self._manifest(state)
                # Degrade to a persistence-error snapshot exactly like the
                # no-active-jobs settlement, so a store failure here cannot
                # abort the whole bootstrap and block run() and resume().
                try:
                    store.commit(state)
                except PersistenceError:
                    state["status"] = "persistence-error"
                    state["durable"] = False
            for receipt in state.get("receipts", []):
                try:
                    signature = str(receipt.get("signature", ""))
                    subject_key = str(receipt.get("subjectId") or "cohort")
                    if (
                        store.get_receipt(
                            str(receipt.get("stepKey", "")), subject_key, signature
                        )
                        is None
                    ):
                        store.put_receipt(receipt)
                except (PersistenceError, ValueError, KeyError):
                    state.setdefault("warnings", []).append(
                        "The committed receipt could not be republished."
                    )
            if run_id in page_run_id_set:
                runs.append(self._run_snapshot(state, project_epoch=project.epoch))
                for persisted_job in state.get("jobs", []):
                    # Project durable history into the identity frame of the
                    # runtime serving this snapshot. The record on disk keeps
                    # the epoch and generation that ran the job; the snapshot
                    # contract binds every job to the snapshot's own identity.
                    projected_job = copy.deepcopy(persisted_job)
                    projected_job["projectEpoch"] = project.epoch
                    projected_job["sidecarGeneration"] = self.sidecar_generation
                    jobs.append(projected_job)
                states[str(state.get("runId", ""))] = state
        with self._lock:
            current_jobs = [
                job
                for job in (
                    list(self._active_jobs.values())
                    + list(self._terminal_jobs.values())
                    + list(self._persistence_errors.values())
                )
                if job.get("projectId") == project.project_id
                and int(job.get("projectEpoch", -1)) == project.epoch
            ]
            projected_jobs = _bounded_jobs([*jobs, *current_jobs])
            run_ids = {run["runId"] for run in runs}
            live_log_tail = [
                entry for entry in self._log_tail if entry.get("runId") in run_ids
            ]
        log_limit = max(0, min(int(request.get("logLimit", 500)), BOOTSTRAP_LOG_LIMIT))
        log_replay = self._replay_log_tail(
            store,
            states,
            projected_jobs,
            live_log_tail,
            log_limit,
        )
        provision = (
            self._provision_status_provider(request)
            if self._provision_status_provider is not None
            else None
        )
        return {
            "project": project.to_dict(),
            "sidecarGeneration": self.sidecar_generation,
            # Read the published cursor so a snapshot never claims a sequence
            # whose event has not reached the wire.
            "sequence": self.published_sequence(),
            "runs": runs,
            "jobs": projected_jobs,
            "logTail": log_replay.tail,
            # Per-job replay coverage, bounded by the replay file limit.
            "logReplay": log_replay.coverage,
            "provision": provision,
        }

    def reconcile_project_ownership(self, project_raw: dict[str, Any]) -> None:
        """Reconcile every persisted owner before a project-boundary decision."""
        self.bootstrap(
            {
                "project": project_raw,
                "runLimit": 1,
                "logLimit": 0,
            }
        )

    def active_counts(self) -> tuple[int, int]:
        """Return active run and job counts."""
        with self._lock:
            unresolved_runs = {
                str(owner.get("runId"))
                for owner in self._unresolved_processes.values()
                if owner.get("runId")
            }
            return (
                len(self._runs) + len(unresolved_runs - set(self._runs)),
                len(self._active_jobs) + len(self._unresolved_processes),
            )

    def shutdown(self, timeout: float = 10.0) -> dict[str, Any]:
        """Stop scheduling, terminate owned processes, and persist interruption."""
        with self._wake:
            if self._closing and not self._runs:
                return {"ok": True, "closing": True, "activeJobs": 0}
            self._closing = True
            job_ids = list(self._active_jobs)
        for job_id in job_ids:
            self.cancel_job(job_id)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if not self._active_jobs:
                    break
                procs = [
                    proc
                    for ctx in self._runs.values()
                    for proc in ctx.processes.values()
                ]
            for proc in procs:
                _terminate_tree(proc, force=time.monotonic() + 1 >= deadline)
            time.sleep(0.05)
        with self._wake:
            for ctx in list(self._runs.values()):
                for node in ctx.state["nodes"]:
                    if (
                        node["status"] not in TERMINAL_NODE_STATES
                        and node["status"] != "unknown"
                    ):
                        node["status"] = "interrupted"
                        node["reason"] = (
                            "The sidecar shut down before this work finished."
                        )
                if any(node["status"] == "unknown" for node in ctx.state["nodes"]):
                    ctx.state["status"] = "unknown"
                    ctx.state["endedAtMs"] = None
                else:
                    ctx.state["status"] = "interrupted"
                    ctx.state["endedAtMs"] = _now_ms()
                try:
                    self._commit(ctx)
                except PersistenceError:
                    ctx.state["status"] = "persistence-error"
                self._emit_run(ctx)
            self._runs.clear()
            self._wake.notify_all()
        return {"ok": True, "closing": True, "activeJobs": len(self._active_jobs)}
