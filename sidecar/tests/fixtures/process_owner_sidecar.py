#!/usr/bin/env python3
"""Bounded JSON-RPC process-ownership fixture for the main process and sidecar."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

_CAPABILITIES = [
    "workflow-v1",
    "run-store-v1",
    "project-identity-v1",
    "runtime-events-v1",
    "artifact-resolution-v1",
    "cancellable-provision-v1",
    "input-fov-review-v1",
    "managed-scientific-resources-v1",
    "cohort-analysis-v1",
    "cohort-analysis-v2",
    "atlas-labeling-v1",
]
_SCIENTIFIC_CHILD = (
    "import json,os,pathlib,subprocess,sys,time;"
    "gate=int(sys.argv[1]);"
    "token=os.read(gate,1);os.close(gate);"
    "sys.exit(125) if token!=b'1' else None;"
    "grandchild=subprocess.Popen("
    "[sys.executable,'-c','import time;time.sleep(60)']);"
    "path=pathlib.Path(sys.argv[2]);"
    "path.write_text(json.dumps("
    "{'child':os.getpid(),'grandchild':grandchild.pid}),encoding='utf-8');"
    "fd=os.open(path,os.O_RDONLY);os.fsync(fd);os.close(fd);"
    "time.sleep(60)"
)


def _send(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _identity(pid: int) -> str:
    boot_id = (
        Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    )
    value = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    fields = value.rsplit(")", 1)[1].strip().split()
    return f"linux:{boot_id}:{fields[19]}"


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _settle(proc: subprocess.Popen[bytes] | None) -> bool:
    if proc is None:
        return True
    pgid = proc.pid
    for sig, timeout in ((signal.SIGTERM, 1.0), (signal.SIGKILL, 1.0)):
        if not _group_alive(pgid):
            break
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            break
        deadline = time.monotonic() + timeout
        while _group_alive(pgid) and time.monotonic() < deadline:
            time.sleep(0.02)
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        return False
    deadline = time.monotonic() + 1
    while _group_alive(pgid) and time.monotonic() < deadline:
        time.sleep(0.02)
    return not _group_alive(pgid)


def _persist(path: str, value: dict[str, Any]) -> None:
    target = Path(path)
    target.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
    descriptor = os.open(target, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def main() -> int:  # noqa: PLR0915
    generation = 0
    proc: subprocess.Popen[bytes] | None = None
    gate_write: int | None = None
    owner: dict[str, Any] | None = None
    pending_start_id: int | None = None
    for raw in sys.stdin:
        message = json.loads(raw)
        method = message.get("method")
        params = message.get("params")
        request = (
            params[0]
            if isinstance(params, list) and params and isinstance(params[0], dict)
            else {}
        )
        request_id = message.get("id")
        if method == "system.handshake":
            generation = int(request["generation"])
            product_version = str(request["productVersion"])
            _send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "productVersion": product_version,
                        "protocolVersion": "1",
                        "persistenceVersions": {
                            "project": 1,
                            "runState": 1,
                            "manifest": 1,
                            "receipt": 1,
                        },
                        "capabilities": _CAPABILITIES,
                        "runtimeId": f"process-owner-fixture-{os.getpid()}",
                        "projectAttached": False,
                        "supervisorGeneration": generation,
                    },
                }
            )
            continue
        if method == "test.startProvision":
            gate_read, gate_write = os.pipe()
            proc = subprocess.Popen(  # noqa: S603
                [
                    sys.executable,
                    "-I",
                    "-S",
                    "-c",
                    _SCIENTIFIC_CHILD,
                    str(gate_read),
                    str(request["treePath"]),
                ],
                pass_fds=(gate_read,),
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            os.close(gate_read)
            operation_id = str(request["operationId"])
            owner = {
                "schemaVersion": 1,
                "claimId": f"claim-{uuid.uuid4().hex}",
                "generation": generation,
                "operationKind": "provision",
                "ownerId": operation_id,
                "projectId": str(request["projectId"]),
                "projectEpoch": int(request["projectEpoch"]),
                "runId": None,
                "jobId": None,
                "operationId": operation_id,
                "pid": proc.pid,
                "pgid": proc.pid,
                "startIdentity": _identity(proc.pid),
            }
            _persist(str(request["ownerPath"]), owner)
            pending_start_id = int(request_id)
            _send(
                {
                    "jsonrpc": "2.0",
                    "method": "system.processOwnerRegistered",
                    "params": owner,
                }
            )
            _send(
                {
                    "jsonrpc": "2.0",
                    "method": "system.processStarted",
                    "params": owner,
                }
            )
            continue
        if method == "system.acceptProcessClaim":
            if (
                owner is None
                or pending_start_id is None
                or request.get("accepted") is not True
                or any(request.get(key) != value for key, value in owner.items())
            ):
                return 72
            if gate_write is None:
                return 73
            os.write(gate_write, b"1")
            os.close(gate_write)
            gate_write = None
            _send(
                {
                    "jsonrpc": "2.0",
                    "id": pending_start_id,
                    "result": {"accepted": True, "owner": owner},
                }
            )
            pending_start_id = None
            continue
        if method == "test.cancelProvision":
            proved = _settle(proc)
            if owner is not None:
                _send(
                    {
                        "jsonrpc": "2.0",
                        "method": "system.processSettled",
                        "params": {**owner, "provedStopped": proved},
                    }
                )
                if proved:
                    _send(
                        {
                            "jsonrpc": "2.0",
                            "method": "system.processOwnerReleased",
                            "params": owner,
                        }
                    )
            proc = None if proved else proc
            _send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {"terminal": proved},
                }
            )
            continue
        if method == "test.crash":
            os.kill(os.getpid(), signal.SIGKILL)
            return 91
        if method == "system.shutdown":
            active = 0 if _settle(proc) else 1
            _send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "ok": active == 0,
                        "closing": True,
                        "activeJobs": 0,
                        "activeProvisioning": active,
                    },
                }
            )
            return 0
        _send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": "unknown method"},
            }
        )
    _settle(proc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
