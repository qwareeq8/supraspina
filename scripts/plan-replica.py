#!/usr/bin/env python3
"""Capture and compare plan-only Run all readings of one project by two builds.

``capture`` drives one build's sidecar over its stdio JSON-RPC exactly as the
desktop app's read path does after opening a project: handshake, the
registry, subject discovery, the environment check, the tool status, the run
history, surface registration, the Results inventory (stage currency), and a
plan-only Run all with Defer and unreviewed QC acknowledged. It never sends an
``approvedPlan``, an authorization, or a save, and records every answer plus a
before/after inventory of the project's files.

The read path is not read-only by construction: ``runtime.bootstrap`` settles
every run its sidecar does not own. It commits a ``queued``, ``running``, or
``cancelling`` run with its unfinished nodes interrupted and a terminal (or
unknown) status, and marks such a run's queued jobs interrupted and its
running jobs unknown or interrupted. A second sidecar owns none of the
app's runs, so a capture against a project with a live run
would rewrite that run's state. ``capture`` therefore refuses a writable
project unless ``--copy-ok`` states that it is a copy (or a read-only bind is
used), and refuses any project whose run store holds an unsettled run, an
active job, or an unreadable run. On a settled copy no request writes; the
inventory proves that after the fact, and it cannot undo a write.

``compare`` checks two readings node by node (IDs, steps, scopes, subjects,
statuses, reasons, dependencies, commands with the plan ID normalized), the
plan digests, and stage currency, against an explicit expected difference.

This tool is sound only together with ``scripts/receipt-invariance.py``: the
plan shows which nodes a build would rerun, but not every receipt field, the
record checks reuse depends on, or receipts the plan does not reach, which
the invariance tool recomputes. Checking a build before deploying it over
another takes both tools.

Run the sidecar either packaged (``--sidecar-exe``, the frozen binary of a
build) or from source (``--sidecar-src``, a checkout or ``git archive`` of the
build, run with ``--python``). A packaged build resolves the reviewed
scientific resources from a machine-local acquisition generation and its own
frozen subset, and a source tree does neither, so a source capture that
stands for a packaged build passes ``--frozen-runtime`` (the build's runtime
tree with ``resources/`` and ``metadata/``, kept at one path for every build
being compared, as an install replaces it in place) and ``--asset-cache`` (a
copy of the machine's asset cache, ``scientific-assets`` with ``CURRENT`` and
``generations/``). The capture then inventories that cache too, and the
receipt files and the cache are compared before and after every reading.
The configuration is the saved project file, as the renderer sends it.
``--check-src`` (default: the source tree) names the source tree that reports
the build's version and whose run store performs the settled-run check. Run both builds at the project's own
paths (for example inside ``bwrap``) so every recorded path matches.

Examples::

    plan-replica.py capture --project-file <copy>/supraspina.project.json \\
        --sidecar-src <deployed build source> --copy-ok --out deployed.json
    plan-replica.py capture --project-file <copy>/supraspina.project.json \\
        --sidecar-src <candidate source> --copy-ok --out candidate.json
    plan-replica.py compare deployed.json candidate.json \\
        --expect-changed final,aggregate --expect-appended braincharts,zstats \\
        --expect-digests registryDigest,configDigest,environmentDigest

For a packaged deploy, write the project with the deployed build in packaged
emulation and a copy of the deployed asset cache
(``tests/synthetic_receipt_project.py --brainfov`` with
``SUPRASPINA_REPLICA_FROZEN_RUNTIME`` and
``SUPRASPINA_SCIENTIFIC_ASSET_ROOT``), then
capture each build with its own runtime tree copied to the same
``--frozen-runtime`` path (``node scripts/stage-sidecar-resources.mjs --output``
stages a source tree's; it equals the packaged one) and ``--asset-cache``
naming that cache copy. ``compare`` then also fails on any receipt file a
reading wrote and on any asset check the candidate no longer finds.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

#: Read-path requests the app sends after opening a project, in order.
READ_CALLS = (
    "registry.list",
    "subjects.discover",
    "env.check",
    "env.toolStatus",
    "runtime.bootstrap",
    "surfaceRegistration.status",
    "results.list",
)
NODE_FIELDS = ("stepKey", "scope", "subjectId", "status", "reason", "dependencies")
PLAN_DIGESTS = ("qcDigest", "configDigest", "registryDigest", "environmentDigest")
PLAN_FIELDS = ("analysisCohort", "selectedSubset", "blockers", "exclusions")
#: Files the sidecar may hash in full while reading; larger files are stat-only.
MAX_HASHED_BYTES = 64 * 1024 * 1024

#: Environment variable naming the runtime tree a source sidecar resolves its
#: frozen subset from, as a packaged build does from ``sys._MEIPASS``.
FROZEN_RUNTIME_ENV = "SUPRASPINA_REPLICA_FROZEN_RUNTIME"
ASSET_CACHE_ENV = "SUPRASPINA_SCIENTIFIC_ASSET_ROOT"

_BOOTSTRAP = (
    "import os, runpy, sys\n"
    f"runtime = os.environ.get({FROZEN_RUNTIME_ENV!r})\n"
    "if runtime:\n"
    "    sys.frozen = True\n"
    "    sys._MEIPASS = runtime\n"
    "for path in sys.argv[1:]:\n"
    "    runpy.run_path(path, run_name='__supraspina_preload__')\n"
    "sys.argv = ['supraspina_sidecar']\n"
    "runpy.run_module('supraspina_sidecar', run_name='__main__', alter_sys=True)\n"
)
_PROJECT = (
    "import json, sys\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "data = json.load(open(sys.argv[2], encoding='utf-8'))\n"
    "from supraspina_sidecar import __version__\n"
    "json.dump({'cfg': data, 'version': __version__}, sys.stdout)\n"
)


_RUN_STATES = (
    "import json, sys\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "from supraspina_sidecar.run_store import RunStore\n"
    "store = RunStore(sys.argv[2])\n"
    "rows = []\n"
    "for run_id in store.run_ids():\n"
    "    try:\n"
    "        state = store.load(run_id)\n"
    "    except Exception as exc:\n"
    "        rows.append({'runId': run_id, 'error': type(exc).__name__})\n"
    "        continue\n"
    "    rows.append({'runId': run_id, 'status': state.get('status'),\n"
    "                 'jobs': [job.get('status') for job in state.get('jobs', [])]})\n"
    "json.dump(rows, sys.stdout)\n"
)
#: Run and job states ``runtime.bootstrap`` settles and commits when no live
#: process of its own sidecar owns them (``workflow_manager``).
UNSETTLED_RUN_STATES = frozenset({"queued", "running", "cancelling"})
ACTIVE_JOB_STATES = frozenset({"queued", "running", "cancelling", "unknown"})


class SidecarClient:
    """Speak newline-delimited JSON-RPC to one sidecar process."""

    def __init__(self, command: list[str], cwd: str, env: dict[str, str]) -> None:
        self.process = subprocess.Popen(  # noqa: S603
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.notifications: dict[str, int] = {}
        self.stderr: list[str] = []
        self._next = 0
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    def _drain_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            self.stderr.append(line.rstrip("\n"))

    def call(self, method: str, params: list[Any], timeout: float = 600) -> Any:
        """Send one request and return its result or raise its error."""
        assert self.process.stdin is not None and self.process.stdout is not None
        self._next += 1
        request_id = f"replica-{self._next}"
        message = {"jsonrpc": "2.0", "id": request_id, "method": method}
        message["params"] = params
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError(
                    f"The sidecar exited during {method}: "
                    + " | ".join(self.stderr[-5:])
                )
            reply = json.loads(line)
            if reply.get("id") != request_id:
                name = str(reply.get("method", "reply"))
                self.notifications[name] = self.notifications.get(name, 0) + 1
                continue
            if "error" in reply:
                raise RpcError(reply["error"])
            return reply.get("result")
        raise TimeoutError(f"{method} did not answer in {timeout:.0f} s.")

    def close(self) -> None:
        """Ask the sidecar to shut down, then make sure it exits."""
        try:
            self.call("system.shutdown", [{"timeoutMs": 5000}], timeout=30)
        except (RuntimeError, RpcError, TimeoutError, OSError, ValueError):
            pass
        try:
            if self.process.stdin is not None:
                self.process.stdin.close()
            self.process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()


class RpcError(RuntimeError):
    """Carry a JSON-RPC error object."""

    def __init__(self, error: Any) -> None:
        super().__init__(json.dumps(error)[:2000])
        self.error = error


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def inventory(roots: list[str], hashed_root: str) -> dict[str, list[Any]]:
    """List every file under ``roots`` with its size, mtime, and SHA-256.

    Only files under ``hashed_root`` and within ``MAX_HASHED_BYTES`` are
    hashed. Symbolic links are listed by target text and never followed.
    """
    files: dict[str, list[Any]] = {}
    hashed_prefix = hashed_root.rstrip(os.sep) + os.sep
    for root in roots:
        if not os.path.isdir(root):
            continue
        for directory, names, filenames in os.walk(root, followlinks=False):
            names.sort()
            for name in [
                *filenames,
                *(n for n in names if os.path.islink(os.path.join(directory, n))),
            ]:
                path = os.path.join(directory, name)
                if path in files:
                    continue
                try:
                    info = os.lstat(path)
                except OSError:
                    continue
                if os.path.islink(path):
                    files[path] = ["link", os.readlink(path)]
                    continue
                entry: list[Any] = [info.st_size, info.st_mtime_ns]
                if path.startswith(hashed_prefix) and info.st_size <= MAX_HASHED_BYTES:
                    try:
                        entry.append(_sha256(path))
                    except OSError:
                        entry.append(None)
                files[path] = entry
    return files


def inventory_changes(
    before: dict[str, list[Any]], after: dict[str, list[Any]]
) -> list[str]:
    """Return added, removed, and changed paths between two inventories."""
    changes = [f"added {path}" for path in sorted(set(after) - set(before))]
    changes += [f"removed {path}" for path in sorted(set(before) - set(after))]
    changes += [
        f"changed {path}"
        for path in sorted(set(before) & set(after))
        if before[path] != after[path]
    ]
    return changes


def receipt_files(state_dir: str) -> dict[str, str]:
    """Return every receipt file under ``state_dir`` with its SHA-256."""
    root = os.path.join(state_dir, "receipts")
    found: dict[str, str] = {}
    for directory, _names, filenames in os.walk(root):
        for name in filenames:
            path = os.path.join(directory, name)
            found[os.path.relpath(path, root)] = _sha256(path)
    return dict(sorted(found.items()))


def receipt_changes(before: dict[str, str], after: dict[str, str]) -> list[str]:
    """Return the receipt files added, removed, or rewritten between two listings."""
    return inventory_changes(
        {key: [value] for key, value in before.items()},
        {key: [value] for key, value in after.items()},
    )


def asset_summary(cache: str | None) -> dict[str, Any] | None:
    """Describe the asset cache: the active generation and its metadata."""
    if not cache:
        return None
    summary: dict[str, Any] = {"cache": cache, "current": None, "metadata": None}
    try:
        current = Path(cache, "CURRENT").read_text(encoding="ascii").strip()
    except OSError:
        return summary
    summary["current"] = current
    try:
        summary["metadata"] = json.loads(
            Path(cache, "generations", current, "SCIENTIFIC_ASSETS.json").read_text(
                encoding="utf-8"
            )
        )
    except (OSError, ValueError):
        pass
    return summary


def _read_project(python: str, src: str, project_file: str) -> dict[str, Any]:
    result = subprocess.run(  # noqa: S603
        [python, "-c", _PROJECT, str(Path(src) / "sidecar"), project_file],
        capture_output=True,
        text=True,
        check=False,
        env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
    )
    if result.returncode != 0:
        raise SystemExit(f"Reading the project with {src} failed: {result.stderr}")
    return json.loads(result.stdout)


def unsettled_runs(python: str, src: str, root: str) -> list[str]:
    """Describe every run that ``runtime.bootstrap`` would settle or cannot read."""
    result = subprocess.run(  # noqa: S603
        [python, "-c", _RUN_STATES, str(Path(src) / "sidecar"), root],
        capture_output=True,
        text=True,
        check=False,
        env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
    )
    if result.returncode != 0:
        raise SystemExit(f"The run store check with {src} failed: {result.stderr}")
    found: list[str] = []
    for row in json.loads(result.stdout):
        if row.get("error"):
            found.append(f"{row['runId']} is unreadable ({row['error']})")
            continue
        active = sum(1 for status in row["jobs"] if status in ACTIVE_JOB_STATES)
        if row["status"] in UNSETTLED_RUN_STATES or active:
            found.append(f"{row['runId']} is {row['status']} with {active} active jobs")
    return found


def guard_capture(args: argparse.Namespace, source: str, root: str) -> None:
    """Refuse a capture that ``runtime.bootstrap`` could turn into a write."""
    state_dir = os.path.join(root, ".supraspina")
    runs_dir = os.path.join(state_dir, "runs")
    probe = runs_dir if os.path.isdir(runs_dir) else state_dir
    writable = os.path.isdir(probe) and os.access(probe, os.W_OK)
    if writable and not args.copy_ok:
        raise SystemExit(
            "Capture only a copy of the project: runtime.bootstrap commits every "
            "run this sidecar does not own. Pass --copy-ok for a copy, or bind "
            f"{state_dir} read-only."
        )
    unsettled = unsettled_runs(args.python, source, root)
    if unsettled:
        raise SystemExit(
            "Capture refused because runtime.bootstrap would settle these runs: "
            + "; ".join(unsettled)
            + "."
        )


def _call(
    client: SidecarClient, method: str, request: dict[str, Any]
) -> dict[str, Any]:
    started = time.monotonic()
    try:
        result = client.call(method, [request])
        outcome: dict[str, Any] = {"result": result}
    except RpcError as exc:
        outcome = {"error": exc.error}
    outcome["seconds"] = round(time.monotonic() - started, 3)
    return outcome


def capture(args: argparse.Namespace) -> int:
    """Take one read-path reading and write it to ``--out``."""
    project_file = os.path.realpath(args.project_file)
    source = args.check_src or args.sidecar_src
    if not source:
        raise SystemExit("Pass --check-src with --sidecar-exe.")
    loaded = _read_project(args.python, source, project_file)
    cfg = loaded["cfg"]
    paths = cfg.get("paths", {})
    root = os.path.realpath(str(paths.get("projectRoot") or Path(project_file).parent))
    project = {
        "projectId": "project-"
        + hashlib.sha256(project_file.encode()).hexdigest()[:24],
        "root": root,
        "configPath": project_file,
        "epoch": 1,
    }
    guard_capture(args, source, root)
    roots = sorted(
        {
            os.path.realpath(str(paths[key]))
            for key in (
                "projectRoot",
                "rawdataDir",
                "derivativesDir",
                "outputDir",
                "metadataDir",
            )
            if paths.get(key)
        }
        | {os.path.realpath(path) for path in args.watch}
    )
    state_dir = os.path.join(root, ".supraspina")
    cache = os.path.realpath(args.asset_cache) if args.asset_cache else None
    watched = [*roots, cache] if cache else roots
    before = inventory(watched, state_dir)
    if cache:
        before.update(inventory([cache], cache))
    receipts_before = receipt_files(state_dir)
    env = dict(os.environ)
    if args.frozen_runtime:
        env[FROZEN_RUNTIME_ENV] = os.path.realpath(args.frozen_runtime)
    if cache:
        env[ASSET_CACHE_ENV] = cache
    if args.sidecar_exe:
        exe = os.path.realpath(args.sidecar_exe)
        command = [exe]
        # The main process launches the frozen sidecar from the resources
        # directory.
        cwd = str(Path(exe).parent.parent)
    else:
        sidecar = str(Path(args.sidecar_src).resolve() / "sidecar")
        command = [args.python, "-c", _BOOTSTRAP, *map(os.path.realpath, args.preload)]
        cwd = sidecar
        env["PYTHONPATH"] = sidecar
        env["PYTHONDONTWRITEBYTECODE"] = "1"
    if args.strace:
        command = [
            "strace",
            "-f",
            "-qq",
            "-e",
            "trace=%file",
            "-o",
            args.strace,
            *command,
        ]
    client = SidecarClient(command, cwd, env)
    base = {"project": project, "cfg": cfg, "configRevision": 0}
    calls: dict[str, Any] = {}
    writes: dict[str, list[str]] = {}
    previous = inventory([state_dir], state_dir)
    try:
        calls["system.handshake"] = _call(
            client,
            "system.handshake",
            {
                "protocolVersion": "1",
                "productVersion": loaded["version"],
                "generation": 1,
            },
        )
        context = (
            {"userDataPath": os.path.realpath(args.user_data)}
            if args.user_data
            else None
        )
        for method in (*READ_CALLS, "pipeline.planWorkflow", "results.list#after"):
            name = method.split("#", 1)[0]
            request: dict[str, Any] = {"project": project}
            if name in {
                "registry.list",
                "subjects.discover",
                "env.check",
                "env.toolStatus",
                "surfaceRegistration.status",
            }:
                request = dict(base)
            elif name == "runtime.bootstrap":
                request = {"project": project, "runLimit": 50, "logLimit": 200}
            elif name == "results.list":
                request = {"project": project, "limit": 50}
            elif name == "pipeline.planWorkflow":
                request = {
                    **base,
                    "intent": {"kind": "workflow", "target": {"mode": "all"}},
                    "acknowledgements": {
                        "includeDeferredAndUnreviewedQc": True,
                        "acknowledgeMemoryAdvisory": False,
                    },
                }
            if context and name in {"pipeline.planWorkflow", "results.list"}:
                request["runtimeContext"] = context
            calls[method] = _call(client, name, request)
            current = inventory([state_dir], state_dir)
            changes = inventory_changes(previous, current)
            if changes:
                writes[method] = changes
            previous = current
    finally:
        client.close()
    after = inventory(watched, state_dir)
    if cache:
        after.update(inventory([cache], cache))
    receipts_after = receipt_files(state_dir)
    resource_root = _resource_root(calls) or (
        str(Path(args.sidecar_src).resolve() / "resources")
        if args.sidecar_src
        else None
    )
    reading = {
        "build": {
            "sidecarExe": args.sidecar_exe,
            "sidecarSrc": args.sidecar_src,
            "checkSrc": source,
            "version": loaded["version"],
            "resourceRoot": resource_root,
            "frozenRuntime": args.frozen_runtime,
        },
        "assets": asset_summary(cache),
        "assetChecks": _asset_checks(calls),
        "receiptFiles": {"before": receipts_before, "after": receipts_after},
        "receiptWrites": receipt_changes(receipts_before, receipts_after),
        "projectFile": project_file,
        "roots": roots,
        "calls": calls,
        "writesByCall": writes,
        "writes": inventory_changes(before, after),
        "inventoryFiles": len(before),
        "notifications": client.notifications,
        "stderrTail": client.stderr[-20:],
    }
    Path(args.out).write_text(json.dumps(reading, indent=1), encoding="utf-8")
    plan = (calls.get("pipeline.planWorkflow") or {}).get("result") or {}
    print(
        f"{args.out}: plan {plan.get('disposition')}, "
        f"{(plan.get('summary') or {}).get('message')} "
        f"Read-path writes: {len(reading['writes'])}; receipt files "
        f"{len(receipts_before)} -> {len(receipts_after)}, "
        f"{len(reading['receiptWrites'])} written."
    )
    return 0


def _asset_checks(calls: dict[str, Any]) -> dict[str, str]:
    """Return the status of every Pipeline assets check of the env reading."""
    report = (calls.get("env.check") or {}).get("result") or {}
    return {
        str(check.get("id")): str(check.get("status"))
        for group in report.get("groups", [])
        if group.get("name") == "Pipeline assets"
        for check in group.get("checks", [])
    }


_ENIGMA_ASSETS = re.compile(r"assets in (/.+?)/enigma are integrity-verified")


def _resource_root(calls: dict[str, Any]) -> str | None:
    """Return the scientific resource root the ENIGMA asset check names."""
    report = (calls.get("env.check") or {}).get("result") or {}
    for group in report.get("groups", []):
        for check in group.get("checks", []):
            if check.get("id") == "enigma_assets":
                match = _ENIGMA_ASSETS.search(str(check.get("detail", "")))
                if match:
                    return match.group(1)
    return None


def _normalize_command(command: Any, plan_id: str, resource_root: str | None) -> Any:
    """Replace the run ID and the build's resource root with stable tokens.

    A build's resources live in its own tree (an acquired generation when
    packaged), so the root differs between builds while the bytes are bound
    separately through each receipt's implementation identity.
    """
    if command is None:
        return command
    value = str(command)
    if plan_id:
        value = value.replace(plan_id, "<RUN>")
    if resource_root:
        value = value.replace(resource_root.rstrip("/") + "/", "<RESOURCES>/")
    return value


def _stage_currency(reading: dict[str, Any], method: str) -> dict[str, Any]:
    result = (reading["calls"].get(method) or {}).get("result") or {}
    return result.get("stageCurrency") or {}


def _compare_state(a: dict[str, Any], b: dict[str, Any], out: list[str]) -> list[str]:
    """Compare the receipt files and the asset state of two readings.

    No reading may write a receipt file, and an upgrade may not reject an
    asset check the earlier build found (the acquired generation it relied
    on). A reading without these fields passes.
    """
    problems: list[str] = []
    for label, reading in (("A", a), ("B", b)):
        files = reading.get("receiptFiles") or {}
        writes = reading.get("receiptWrites") or []
        out.append(
            f"{label} receipt files {len(files.get('before') or {})} -> "
            f"{len(files.get('after') or {})}"
        )
        if writes:
            problems.append(f"{label} wrote {len(writes)} receipt files")
            out += [f"{label} receipt {item}" for item in writes[:20]]
    after_a = (a.get("receiptFiles") or {}).get("after")
    before_b = (b.get("receiptFiles") or {}).get("before")
    if after_a is not None and before_b is not None and after_a != before_b:
        problems.append("the receipt files changed between the two readings")
        out += [f"between: {item}" for item in receipt_changes(after_a, before_b)[:20]]
    if a.get("assets") or b.get("assets"):
        out.append(
            "asset generation: "
            f"{(a.get('assets') or {}).get('current')} / "
            f"{(b.get('assets') or {}).get('current')}"
        )
    checks_a, checks_b = a.get("assetChecks") or {}, b.get("assetChecks") or {}
    for check_id in sorted(set(checks_a) | set(checks_b)):
        left, right = checks_a.get(check_id), checks_b.get(check_id)
        if left == right:
            continue
        line = f"asset check {check_id}: {left} -> {right}"
        out.append(line)
        if left == "found" and right is not None:
            problems.append(line)
    return problems


def compare(args: argparse.Namespace) -> int:  # noqa: PLR0912, PLR0915
    """Compare two readings against the expected difference."""
    a = json.loads(Path(args.a).read_text(encoding="utf-8"))
    b = json.loads(Path(args.b).read_text(encoding="utf-8"))
    expected_changed = {s for s in args.expect_changed.split(",") if s}
    expected_appended = {s for s in args.expect_appended.split(",") if s}
    expected_digests = {s for s in args.expect_digests.split(",") if s}
    out: list[str] = []
    problems: list[str] = []
    for label, reading in (("A", a), ("B", b)):
        for method, outcome in reading["calls"].items():
            if "error" in outcome and method != "system.handshake":
                out.append(
                    f"{label} {method} error: {json.dumps(outcome['error'])[:300]}"
                )
        if reading["writes"]:
            problems.append(f"{label} read path wrote {len(reading['writes'])} files")
            out += [f"{label} write: {item}" for item in reading["writes"][:20]]
    problems += _compare_state(a, b, out)
    result_a = a["calls"]["pipeline.planWorkflow"].get("result")
    result_b = b["calls"]["pipeline.planWorkflow"].get("result")
    if not result_a or not result_b:
        problems.append("a plan-only reading failed")
        print("\n".join(out + [f"PROBLEM {p}" for p in problems]))
        return 1
    plan_a, plan_b = result_a["plan"], result_b["plan"]
    out.append(
        f"disposition {result_a['disposition']} / {result_b['disposition']}; "
        f"nodes {len(plan_a['nodes'])} / {len(plan_b['nodes'])}"
    )
    out.append(
        "resource roots (normalized in commands): "
        f"{a['build'].get('resourceRoot')} / {b['build'].get('resourceRoot')}"
    )
    out.append(f"A summary: {result_a['summary'].get('message')}")
    out.append(f"B summary: {result_b['summary'].get('message')}")
    for key in PLAN_DIGESTS:
        equal = plan_a.get(key) == plan_b.get(key)
        out.append(
            f"{key} {'equal' if equal else 'DIFFERS'} "
            f"({str(plan_a.get(key))[:16]} / {str(plan_b.get(key))[:16]})"
        )
        if not equal and key not in expected_digests:
            problems.append(f"{key} differs")
        if equal and key in expected_digests:
            out.append(f"Note: {key} was expected to differ but is equal.")
    for key in PLAN_FIELDS:
        if json.dumps(plan_a.get(key), sort_keys=True) != json.dumps(
            plan_b.get(key), sort_keys=True
        ):
            problems.append(f"plan {key} differs")
            out.append(f"plan {key} DIFFERS")
    nodes_a = {node["nodeId"]: node for node in plan_a["nodes"]}
    nodes_b = {node["nodeId"]: node for node in plan_b["nodes"]}
    if list(nodes_a) != list(nodes_b)[: len(nodes_a)]:
        problems.append("node order or IDs differ")
    for node_id in nodes_a:
        if node_id not in nodes_b:
            problems.append(f"node {node_id} missing in B")
    for node_id in list(nodes_b)[len(nodes_a) :]:
        node = nodes_b[node_id]
        line = f"appended {node_id} {node['stepKey']} {node['status']}: {node.get('reason')}"
        out.append(line)
        if node["stepKey"] not in expected_appended or node["status"] != "skipped":
            problems.append(line)
    for node_id, left in nodes_a.items():
        right = nodes_b.get(node_id)
        if right is None:
            continue
        differences = [
            f"{field} {left.get(field)!r} -> {right.get(field)!r}"
            for field in NODE_FIELDS
            if left.get(field) != right.get(field)
        ]
        if _normalize_command(
            left.get("command"), plan_a["planId"], a["build"].get("resourceRoot")
        ) != _normalize_command(
            right.get("command"), plan_b["planId"], b["build"].get("resourceRoot")
        ):
            differences.append("command")
        extra = sorted({*left, *right} - {*NODE_FIELDS, "nodeId", "command"})
        differences += [
            f"field {key}"
            for key in extra
            if json.dumps(left.get(key), sort_keys=True)
            != json.dumps(right.get(key), sort_keys=True)
        ]
        if not differences:
            continue
        line = (
            f"{node_id} {left['stepKey']} {left.get('subjectId') or 'cohort'}: "
            + "; ".join(differences)
        )
        out.append(line)
        if left["stepKey"] not in expected_changed:
            problems.append(line)
    for label, plan in (("A", plan_a), ("B", plan_b)):
        counts: dict[str, int] = {}
        for node in plan["nodes"]:
            key = f"{node['stepKey']} {node['status']}"
            counts[key] = counts.get(key, 0) + 1
        out.append(
            f"{label} nodes: " + ", ".join(f"{k} x{v}" for k, v in counts.items())
        )
    for method in ("results.list", "results.list#after"):
        left, right = _stage_currency(a, method), _stage_currency(b, method)
        for stage in sorted(set(left) | set(right)):
            if json.dumps(left.get(stage), sort_keys=True) == json.dumps(
                right.get(stage), sort_keys=True
            ):
                continue
            line = f"{method} stageCurrency {stage}: {json.dumps(left.get(stage))[:160]} -> {json.dumps(right.get(stage))[:160]}"
            out.append(line)
            if stage not in expected_changed | expected_appended:
                problems.append(line)
    not_current = [
        f"{node['stepKey']}:{node.get('subjectId') or 'cohort'} {node['status']}"
        for node in plan_a["nodes"]
        if node["status"] != "skipped"
    ]
    if not_current:
        out.append(
            "Warning: build A plans "
            f"{len(not_current)} nodes, so the replica does not reproduce the "
            "project's current state for them: " + ", ".join(not_current[:12]) + "."
        )
    out += [f"PROBLEM {problem}" for problem in problems]
    out.append(
        "Result: "
        + (
            "only the expected difference."
            if not problems
            else f"{len(problems)} unexpected differences."
        )
    )
    print("\n".join(out))
    return 1 if problems else 0


def strace_summary(args: argparse.Namespace) -> int:
    """Summarize the files a traced sidecar opened or examined."""
    pattern = re.compile(
        r'^\d+\s+(\w+)\((?:AT_FDCWD|-?\d+), "([^"]+)"|^\d+\s+(\w+)\("([^"]+)"'
    )
    seen: dict[str, set[str]] = {}
    for line in (
        Path(args.trace).read_text(encoding="utf-8", errors="replace").splitlines()
    ):
        match = pattern.match(line)
        if not match:
            continue
        call = match.group(1) or match.group(3)
        path = match.group(2) or match.group(4)
        if not any(path.startswith(prefix) for prefix in args.prefix):
            continue
        kind = "open" if call.startswith("open") else "stat"
        seen.setdefault(path, set()).add(
            kind if "ENOENT" not in line else f"{kind}-missing"
        )
    for path in sorted(seen):
        print(f"{','.join(sorted(seen[path]))}\t{path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Dispatch the ``capture``, ``compare``, and ``strace-summary`` commands."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    take = commands.add_parser("capture", help="Take one plan-only reading.")
    take.add_argument("--project-file", required=True)
    runner = take.add_mutually_exclusive_group(required=True)
    runner.add_argument("--sidecar-exe", help="Frozen sidecar of a packaged build.")
    runner.add_argument("--sidecar-src", help="Source tree of a build.")
    take.add_argument(
        "--check-src", help="Source tree for the version and settled-run checks."
    )
    take.add_argument("--python", default=sys.executable)
    take.add_argument(
        "--preload",
        action="append",
        default=[],
        help="Python file run before a source sidecar starts (repeatable).",
    )
    take.add_argument("--user-data", help="The app's userData directory.")
    take.add_argument(
        "--frozen-runtime",
        help="Runtime tree to resolve a source sidecar's frozen subset from.",
    )
    take.add_argument(
        "--asset-cache",
        help="Scientific asset cache the sidecar resolves and the capture inventories.",
    )
    take.add_argument(
        "--watch", action="append", default=[], help="Extra root to inventory."
    )
    take.add_argument("--strace", help="Trace file accesses into this file.")
    take.add_argument(
        "--copy-ok",
        action="store_true",
        help="State that the project is a copy that runtime.bootstrap may settle.",
    )
    take.add_argument("--out", required=True)
    check = commands.add_parser("compare", help="Compare two readings.")
    check.add_argument("a")
    check.add_argument("b")
    check.add_argument("--expect-changed", default="")
    check.add_argument("--expect-appended", default="")
    check.add_argument("--expect-digests", default="")
    trace = commands.add_parser("strace-summary", help="List traced file accesses.")
    trace.add_argument("trace")
    trace.add_argument("--prefix", action="append", default=[])
    args = parser.parse_args(argv)
    if args.command == "capture":
        return capture(args)
    if args.command == "compare":
        return compare(args)
    return strace_summary(args)


if __name__ == "__main__":
    sys.exit(main())
