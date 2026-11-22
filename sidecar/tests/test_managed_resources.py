"""Tests for the cancellable managed-resource operation manager."""

from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from supraspina_sidecar import managed_resources, scientific_resources
from supraspina_sidecar.authorization import AuthorizationLedger
from supraspina_sidecar.managed_resources import (
    ManagedResourceManager,
    _parse_apptainer_pull_progress,
    _parse_apptainer_version,
)
from supraspina_sidecar.project import ProjectEpochs
from supraspina_sidecar.rpc import Emitter

_APPTAINER_MISSING_ERROR = (
    f"Install Apptainer {scientific_resources.APPTAINER_VERSION} to pull "
    "managed resources, following the supported-Ubuntu steps in the Supraspina "
    "installation guide, or import a verified SIF offline."
)
_APPTAINER_RELEASE_ERROR = (
    f"Install Apptainer {scientific_resources.APPTAINER_VERSION} to "
    "reproduce the pinned managed-resource SIF; this machine has Apptainer "
    "1.4.2. Import a verified SIF offline instead."
)
_READY_APPTAINER = {
    "found": True,
    "path": "/opt/apptainer/bin/apptainer",
    "version": scientific_resources.APPTAINER_VERSION,
    "expectedVersion": scientific_resources.APPTAINER_VERSION,
    "ready": True,
    "detail": None,
}
_MISSING_APPTAINER = {
    "found": False,
    "path": None,
    "version": None,
    "expectedVersion": scientific_resources.APPTAINER_VERSION,
    "ready": False,
    "detail": _APPTAINER_MISSING_ERROR,
}


def _stub_missing_apptainer(monkeypatch: pytest.MonkeyPatch) -> None:
    """Report a host with no Apptainer so a probe never reaches the machine."""
    monkeypatch.setattr(managed_resources.shutil, "which", lambda _name: None)


def _stub_pull_preflight(monkeypatch: pytest.MonkeyPatch) -> None:
    """Satisfy the Apptainer pull preflight without touching the host."""
    monkeypatch.setattr(
        managed_resources.shutil,
        "which",
        lambda name: "/opt/apptainer/bin/apptainer" if name == "apptainer" else None,
    )
    monkeypatch.setattr(
        managed_resources,
        "_apptainer_release",
        lambda _apptainer: scientific_resources.APPTAINER_VERSION,
    )


def _small_fastsurfer_pin(content: bytes) -> scientific_resources.SifReleasePin:
    """Build a real CPU release pin around small deterministic SIF bytes."""
    return scientific_resources.SifReleasePin(
        variant="cpu",
        size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
        oci_manifest_digest=(
            scientific_resources.FASTSURFER_VARIANTS["cpu"].oci_manifest_digest
        ),
        apptainer_version=scientific_resources.APPTAINER_VERSION,
    )


def _project(root: Path) -> dict[str, Any]:
    return {
        "projectId": "managed-resource-project",
        "root": str(root.resolve()),
        "configPath": str((root / "supraspina.project.json").resolve()),
        "epoch": 2,
    }


def _cfg(root: Path) -> dict[str, Any]:
    return {"paths": {"projectRoot": str(root.resolve())}}


def _request(
    root: Path,
    user_data: Path,
    *,
    resource: str = "fastsurfer",
    variant: str = "cpu",
) -> dict[str, Any]:
    return {
        "project": _project(root),
        "cfg": _cfg(root),
        "configRevision": 6,
        "resource": resource,
        "variant": variant,
        "userDataPath": str(user_data.resolve()),
    }


def _authorization(root: Path) -> dict[str, Any]:
    return {
        "token": "managed-resource-authorization-token",
        "projectId": _project(root)["projectId"],
        "configRevision": 6,
        "purpose": "provision",
    }


def _wait_status(
    manager: ManagedResourceManager,
    request: dict[str, Any],
    phase: str,
) -> dict[str, Any]:
    # Bound only a hang: hosted-runner disks can stall the worker's fsyncs.
    deadline = time.monotonic() + 30
    seen = None
    while time.monotonic() < deadline:
        status = manager.status(request)
        seen = status["phase"]
        if seen == phase:
            return status
        time.sleep(0.01)
    raise AssertionError(f"Reach managed-resource phase {phase}, not {seen}.")


@pytest.mark.parametrize(
    ("record", "expected"),
    [
        (
            b"Copying blob 0123456789ab [========] 64MiB / 256MiB",
            25.0,
        ),
        (b"Downloading image [============] 37.25 %", 37.25),
        (b"Fetching layer 500 kB / 2 MB", 25.0),
    ],
)
def test_apptainer_pull_progress_parser_accepts_only_bounded_transfer_records(
    record: bytes,
    expected: float,
) -> None:
    assert _parse_apptainer_pull_progress(record) == pytest.approx(expected)


@pytest.mark.parametrize(
    "record",
    [
        b"INFO: private-token=secret 75%",
        b"Copying blob 0123456789ab 101%",
        b"Copying blob 0123456789ab 2GiB / 1GiB",
        b"Copying blob 0123456789ab \x1b[31m75%\x1b[0m",
        b"Copying blob 0123456789ab 75%\x00private",
        b"Copying blob " + b"x" * 4_097 + b" 75%",
    ],
)
def test_apptainer_pull_progress_parser_rejects_untrusted_output(
    record: bytes,
) -> None:
    assert _parse_apptainer_pull_progress(record) is None


def test_status_uses_exact_backend_verifier_without_exposing_machine_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    pin = object()
    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": pin, "cuda": object()},
        raising=False,
    )
    monkeypatch.setattr(
        scientific_resources,
        "fastsurfer_resource_status",
        lambda received_root, received_pin: (
            {
                "state": "ready",
                "path": str(received_root / "secret" / "fastsurfer.sif"),
                "variant": "cpu",
                "version": "2.5.4",
            }
            if received_pin is pin
            else {}
        ),
    )
    _stub_pull_preflight(monkeypatch)
    manager = ManagedResourceManager(
        Emitter(io.StringIO()),
        ProjectEpochs(),
        AuthorizationLedger(),
    )

    status = manager.status(_request(root, user_data))

    assert status == {
        "resource": "fastsurfer",
        "variant": "cpu",
        "version": "2.5.4",
        "state": "ready",
        "phase": "idle",
        "operationId": None,
        "percent": None,
        "cancellable": False,
        "error": None,
        "runtime": _READY_APPTAINER,
    }
    assert "path" not in status


def test_offline_import_is_nonblocking_verified_and_streams_bounded_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    source = tmp_path / "offline.sif"
    source.write_bytes(b"verified")
    pin = object()
    ready = False
    status_calls = 0

    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": pin, "cuda": object()},
        raising=False,
    )

    def resource_status(
        _user_data: Path,
        _pin: object,
    ) -> dict[str, Any]:
        nonlocal status_calls
        status_calls += 1
        return {
            "state": "ready" if ready else "missing",
            "path": None,
            "variant": "cpu",
            "version": "2.5.4",
        }

    def import_sif(
        received_source: Path,
        received_root: Path,
        received_pin: object,
        *,
        progress: Any,
        cancelled: Any,
    ) -> Path:
        nonlocal ready
        assert received_source == source
        assert received_root == user_data
        assert received_pin is pin
        assert cancelled() is False
        for copied in range(1, 101):
            progress(copied, 100)
        ready = True
        return user_data / "fastsurfer.sif"

    monkeypatch.setattr(
        scientific_resources,
        "fastsurfer_resource_status",
        resource_status,
    )
    monkeypatch.setattr(
        scientific_resources,
        "import_fastsurfer_sif",
        import_sif,
    )
    _stub_missing_apptainer(monkeypatch)
    sink = io.StringIO()
    manager = ManagedResourceManager(
        Emitter(sink),
        ProjectEpochs(),
        AuthorizationLedger(),
    )
    request = _request(root, user_data)
    request.update(
        {
            "sourcePath": str(source),
            "authorization": _authorization(root),
        }
    )

    started = manager.import_offline(request)
    done = _wait_status(manager, _request(root, user_data), "done")

    assert started["operationId"].startswith("resource-")
    assert done["state"] == "ready"
    assert done["percent"] == 100
    # Offline import verifies an existing file and never invokes Apptainer.
    assert done["runtime"] == _MISSING_APPTAINER
    events = [
        json.loads(line)["params"]
        for line in sink.getvalue().splitlines()
        if json.loads(line).get("method") == "managedResource.progress"
    ]
    assert any(
        event["phase"] == "importing" and event["percent"] == 50 for event in events
    )
    assert events[-1]["phase"] == "done"
    assert str(source) not in sink.getvalue()
    assert status_calls <= 4


def test_online_pull_streams_allowlisted_progress_without_exposing_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    pin = SimpleNamespace(size_bytes=8)
    ready = False
    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": pin, "cuda": object()},
        raising=False,
    )

    def resource_status(
        _user_data: Path,
        _pin: object,
    ) -> dict[str, Any]:
        return {
            "state": "ready" if ready else "missing",
            "path": None,
            "variant": "cpu",
            "version": "2.5.4",
        }

    def import_sif(
        source: Path,
        received_root: Path,
        received_pin: object,
        *,
        progress: Any,
        cancelled: Any,
    ) -> Path:
        nonlocal ready
        assert source.read_bytes() == b"verified"
        assert received_root == user_data
        assert received_pin is pin
        assert cancelled() is False
        progress(8, 8)
        ready = True
        return user_data / "fastsurfer.sif"

    script = "\n".join(
        [
            "import pathlib",
            "import sys",
            "destination = pathlib.Path(sys.argv[1])",
            ("sys.stderr.write('Copying blob 0123456789ab [====] 64MiB / 256MiB\\r')"),
            "sys.stderr.flush()",
            "sys.stdout.write('Downloading image [========] 50.5 %\\n')",
            "sys.stdout.write('INFO: private-token=secret 91%\\n')",
            "sys.stdout.flush()",
            "destination.write_bytes(b'verified')",
        ]
    )
    monkeypatch.setattr(
        scientific_resources,
        "fastsurfer_resource_status",
        resource_status,
    )
    monkeypatch.setattr(
        scientific_resources,
        "import_fastsurfer_sif",
        import_sif,
    )
    _stub_pull_preflight(monkeypatch)
    sink = io.StringIO()
    manager = ManagedResourceManager(
        Emitter(sink),
        ProjectEpochs(),
        AuthorizationLedger(),
    )
    monkeypatch.setattr(
        manager,
        "_pull_command",
        lambda _operation, destination: [
            sys.executable,
            "-c",
            script,
            str(destination),
        ],
    )
    request = _request(root, user_data)
    request["authorization"] = _authorization(root)

    manager.provision(request)
    done = _wait_status(manager, _request(root, user_data), "done")

    assert done["state"] == "ready"
    events = [
        json.loads(line)["params"]
        for line in sink.getvalue().splitlines()
        if json.loads(line).get("method") == "managedResource.progress"
    ]
    pulling = [event["percent"] for event in events if event["phase"] == "pulling"]
    assert pulling == [None, 25.0, 50.5]
    assert "private-token" not in sink.getvalue()
    assert "0123456789ab" not in sink.getvalue()


def test_online_pull_without_parseable_progress_stays_indeterminate_and_cancels(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    pin = SimpleNamespace(size_bytes=8)
    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": pin, "cuda": object()},
        raising=False,
    )
    monkeypatch.setattr(
        scientific_resources,
        "fastsurfer_resource_status",
        lambda _root, _pin: {
            "state": "missing",
            "path": None,
            "variant": "cpu",
            "version": "2.5.4",
        },
    )
    monkeypatch.setattr(
        scientific_resources,
        "import_fastsurfer_sif",
        lambda *_args, **_kwargs: pytest.fail(
            "Prevent the canceled pull from reaching import."
        ),
    )
    script = "\n".join(
        [
            "import sys",
            "import time",
            "sys.stderr.write('INFO: private-token=secret 77%\\n')",
            "sys.stderr.flush()",
            "time.sleep(60)",
        ]
    )
    _stub_pull_preflight(monkeypatch)
    sink = io.StringIO()
    manager = ManagedResourceManager(
        Emitter(sink),
        ProjectEpochs(),
        AuthorizationLedger(),
    )
    monkeypatch.setattr(
        manager,
        "_pull_command",
        lambda _operation, destination: [
            sys.executable,
            "-c",
            script,
            str(destination),
        ],
    )
    request = _request(root, user_data)
    request["authorization"] = _authorization(root)

    started_at = time.monotonic()
    operation = manager.provision(request)
    elapsed = time.monotonic() - started_at
    _wait_status(manager, _request(root, user_data), "pulling")
    time.sleep(0.1)
    cancelled = manager.cancel(
        {
            **_request(root, user_data),
            "operationId": operation["operationId"],
        }
    )

    assert elapsed < 0.25
    assert cancelled["terminal"] is True
    terminal = manager.status(_request(root, user_data))
    assert terminal["phase"] == "cancelled"
    events = [
        json.loads(line)["params"]
        for line in sink.getvalue().splitlines()
        if json.loads(line).get("method") == "managedResource.progress"
    ]
    assert [event["percent"] for event in events if event["phase"] == "pulling"] == [
        None
    ]
    assert "private-token" not in sink.getvalue()


def test_cancel_cooperates_with_import_and_replayed_authorization_is_rejected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    source = tmp_path / "offline.sif"
    source.write_bytes(b"verified")
    pin = object()
    monkeypatch.setattr(
        scientific_resources,
        "SYNTHSTRIP_RELEASE_PIN",
        pin,
        raising=False,
    )
    monkeypatch.setattr(
        scientific_resources,
        "synthstrip_resource_status",
        lambda _root, _pin: {
            "state": "missing",
            "path": None,
            "variant": "cpu",
            "version": "1.8",
        },
        raising=False,
    )

    def import_sif(
        _source: Path,
        _root: Path,
        _pin: object,
        *,
        progress: Any,
        cancelled: Any,
    ) -> Path:
        progress(1, 10)
        deadline = time.monotonic() + 2
        while not cancelled() and time.monotonic() < deadline:
            time.sleep(0.005)
        raise scientific_resources.ManagedResourceCancelled(
            "Cancel the SynthStrip import."
        )

    monkeypatch.setattr(
        scientific_resources,
        "import_synthstrip_sif",
        import_sif,
        raising=False,
    )
    manager = ManagedResourceManager(
        Emitter(io.StringIO()),
        ProjectEpochs(),
        AuthorizationLedger(),
    )
    request = _request(
        root,
        user_data,
        resource="synthstrip",
        variant="cpu",
    )
    request.update(
        {
            "sourcePath": str(source),
            "authorization": _authorization(root),
        }
    )
    operation = manager.import_offline(request)
    running = _wait_status(
        manager,
        _request(
            root,
            user_data,
            resource="synthstrip",
            variant="cpu",
        ),
        "importing",
    )
    assert running["cancellable"] is True

    cancelled = manager.cancel(
        {
            **_request(
                root,
                user_data,
                resource="synthstrip",
                variant="cpu",
            ),
            "operationId": operation["operationId"],
        }
    )

    assert cancelled == {
        "operationId": operation["operationId"],
        "accepted": True,
        "terminal": True,
    }
    terminal = manager.status(
        _request(
            root,
            user_data,
            resource="synthstrip",
            variant="cpu",
        )
    )
    assert terminal["phase"] == "cancelled"
    assert terminal["cancellable"] is False
    with pytest.raises(Exception, match="authorization only once"):
        manager.import_offline(request)


def test_pull_command_uses_the_resolved_apptainer_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Pass an absolute Apptainer path through the scrubbed pull environment."""
    monkeypatch.setattr(
        managed_resources.shutil,
        "which",
        lambda name: "/opt/apptainer/bin/apptainer" if name == "apptainer" else None,
    )
    operation = SimpleNamespace(resource="synthstrip", variant=None)

    argv = managed_resources.ManagedResourceManager._pull_command(
        operation, tmp_path / "destination.sif"
    )

    assert "/opt/apptainer/bin/apptainer" in argv
    assert "apptainer" not in argv


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        (b"apptainer version 1.5.3\n", "1.5.3"),
        (b"apptainer version 1.5.3-1.el9\n", "1.5.3"),
        (b"1.5.3\n", "1.5.3"),
        (b"apptainer version 1.5.3\nignored 9.9.9\n", "1.5.3"),
        (b"", None),
        (b"apptainer version unknown\n", None),
        (b"apptainer version 1.5.3.2\n", None),
        (b"x" * 5_000 + b" 1.5.3", None),
    ],
)
def test_apptainer_version_parser_accepts_only_bounded_release_reports(
    output: bytes,
    expected: str | None,
) -> None:
    assert _parse_apptainer_version(output) == expected


def test_missing_apptainer_error_names_the_required_release() -> None:
    """Name the pinned release in the absent-Apptainer refusal, as docs state."""
    message = managed_resources._APPTAINER_MISSING_ERROR

    assert message == _APPTAINER_MISSING_ERROR
    assert f"Apptainer {scientific_resources.APPTAINER_VERSION}" in message


def test_apptainer_release_probe_reports_the_stub_version(tmp_path: Path) -> None:
    """Run the real bounded probe subprocess against a deterministic stub."""
    stub = tmp_path / "apptainer"
    stub.write_text('#!/bin/sh\necho "apptainer version 1.5.3"\n')
    stub.chmod(0o755)

    assert managed_resources._apptainer_release(str(stub)) == "1.5.3"


def test_apptainer_release_probe_returns_none_for_a_failing_binary(
    tmp_path: Path,
) -> None:
    stub = tmp_path / "apptainer"
    stub.write_text("#!/bin/sh\nexit 1\n")
    stub.chmod(0o755)

    assert managed_resources._apptainer_release(str(stub)) is None


def test_provision_without_apptainer_settles_one_terminal_error_operation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Record a missing Apptainer as an operation error, not a rejected call.

    A missing and an unreviewed Apptainer share one failure model, so the
    resource row explains both the same way instead of dropping one cause
    before an operation exists.
    """
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": SimpleNamespace(size_bytes=8), "cuda": object()},
        raising=False,
    )
    monkeypatch.setattr(
        scientific_resources,
        "fastsurfer_resource_status",
        lambda _root, _pin: {
            "state": "missing",
            "path": None,
            "variant": "cpu",
            "version": "2.5.4",
        },
    )
    _stub_missing_apptainer(monkeypatch)
    manager = ManagedResourceManager(
        Emitter(io.StringIO()),
        ProjectEpochs(),
        AuthorizationLedger(),
    )
    monkeypatch.setattr(
        manager,
        "_pull_command",
        lambda _operation, _destination: pytest.fail(
            "Keep the pull unspawned without Apptainer."
        ),
    )
    request = _request(root, user_data)
    request["authorization"] = _authorization(root)

    started = manager.provision(request)
    failed = _wait_status(manager, _request(root, user_data), "error")

    assert started["operationId"].startswith("resource-")
    assert failed["operationId"] == started["operationId"]
    assert failed["error"] == _APPTAINER_MISSING_ERROR
    assert failed["cancellable"] is False
    assert failed["runtime"] == _MISSING_APPTAINER
    assert not (user_data / "scientific-resources").exists()
    with pytest.raises(Exception, match="authorization only once"):
        manager.provision(request)


def test_status_reports_apptainer_readiness_from_the_pull_preflight_probe(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Publish the detected release beside the exact pin the SIFs were built with."""
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": SimpleNamespace(size_bytes=8), "cuda": object()},
        raising=False,
    )
    monkeypatch.setattr(
        scientific_resources,
        "fastsurfer_resource_status",
        lambda _root, _pin: {
            "state": "missing",
            "path": None,
            "variant": "cpu",
            "version": "2.5.4",
        },
    )
    monkeypatch.setattr(
        managed_resources.shutil,
        "which",
        lambda name: "/opt/apptainer/bin/apptainer" if name == "apptainer" else None,
    )
    monkeypatch.setattr(
        managed_resources,
        "_apptainer_release",
        lambda _apptainer: "1.4.2",
    )
    manager = ManagedResourceManager(
        Emitter(io.StringIO()),
        ProjectEpochs(),
        AuthorizationLedger(),
    )

    mismatched = manager.status(_request(root, user_data))

    assert mismatched["runtime"] == {
        "found": True,
        "path": "/opt/apptainer/bin/apptainer",
        "version": "1.4.2",
        "expectedVersion": scientific_resources.APPTAINER_VERSION,
        "ready": False,
        "detail": _APPTAINER_RELEASE_ERROR,
    }

    _stub_pull_preflight(monkeypatch)

    assert manager.status(_request(root, user_data))["runtime"] == _READY_APPTAINER


def test_status_reports_an_unreadable_apptainer_release_as_not_ready(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": SimpleNamespace(size_bytes=8), "cuda": object()},
        raising=False,
    )
    monkeypatch.setattr(
        scientific_resources,
        "fastsurfer_resource_status",
        lambda _root, _pin: {
            "state": "missing",
            "path": None,
            "variant": "cpu",
            "version": "2.5.4",
        },
    )
    monkeypatch.setattr(
        managed_resources.shutil,
        "which",
        lambda name: "/opt/apptainer/bin/apptainer" if name == "apptainer" else None,
    )
    monkeypatch.setattr(
        managed_resources,
        "_apptainer_release",
        lambda _apptainer: None,
    )
    manager = ManagedResourceManager(
        Emitter(io.StringIO()),
        ProjectEpochs(),
        AuthorizationLedger(),
    )

    runtime = manager.status(_request(root, user_data))["runtime"]

    assert runtime["found"] is True
    assert runtime["version"] is None
    assert runtime["ready"] is False
    assert "did not report a release" in str(runtime["detail"])


def test_pull_preflight_rejects_a_mismatched_apptainer_release_before_staging(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": SimpleNamespace(size_bytes=8), "cuda": object()},
        raising=False,
    )
    monkeypatch.setattr(
        scientific_resources,
        "fastsurfer_resource_status",
        lambda _root, _pin: {
            "state": "missing",
            "path": None,
            "variant": "cpu",
            "version": "2.5.4",
        },
    )
    monkeypatch.setattr(
        managed_resources.shutil,
        "which",
        lambda name: "/opt/apptainer/bin/apptainer" if name == "apptainer" else None,
    )
    probed: list[str] = []

    def release(apptainer: str) -> str:
        probed.append(apptainer)
        return "1.4.2"

    monkeypatch.setattr(managed_resources, "_apptainer_release", release)
    manager = ManagedResourceManager(
        Emitter(io.StringIO()),
        ProjectEpochs(),
        AuthorizationLedger(),
    )
    monkeypatch.setattr(
        manager,
        "_pull_command",
        lambda _operation, _destination: pytest.fail(
            "Keep the pull unspawned on an unreviewed Apptainer release."
        ),
    )
    request = _request(root, user_data)
    request["authorization"] = _authorization(root)

    manager.provision(request)
    failed = _wait_status(manager, _request(root, user_data), "error")

    assert failed["error"] == _APPTAINER_RELEASE_ERROR
    assert failed["runtime"]["version"] == "1.4.2"
    # The preflight and every readiness probe resolve Apptainer through PATH
    # rather than trusting a bare program name.
    assert probed
    assert set(probed) == {"/opt/apptainer/bin/apptainer"}
    assert not (user_data / "scientific-resources").exists()


@pytest.mark.skipif(os.geteuid() == 0, reason="Root ignores write permissions.")
def test_online_pull_into_an_unwritable_cache_reports_the_writability_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    user_data.mkdir()
    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": SimpleNamespace(size_bytes=8), "cuda": object()},
        raising=False,
    )
    monkeypatch.setattr(
        scientific_resources,
        "fastsurfer_resource_status",
        lambda _root, _pin: {
            "state": "missing",
            "path": None,
            "variant": "cpu",
            "version": "2.5.4",
        },
    )
    _stub_pull_preflight(monkeypatch)
    manager = ManagedResourceManager(
        Emitter(io.StringIO()),
        ProjectEpochs(),
        AuthorizationLedger(),
    )
    monkeypatch.setattr(
        manager,
        "_pull_command",
        lambda _operation, _destination: pytest.fail(
            "Keep the pull unspawned without a writable staging cache."
        ),
    )
    request = _request(root, user_data)
    request["authorization"] = _authorization(root)

    user_data.chmod(0o500)
    try:
        manager.provision(request)
        failed = _wait_status(manager, _request(root, user_data), "error")
    finally:
        user_data.chmod(0o700)

    assert failed["error"] == (
        "Make the machine-local scientific-resource cache writable before provisioning."
    )
    assert not (user_data / "scientific-resources").exists()


def test_failed_pull_reports_the_exit_status_without_raw_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": SimpleNamespace(size_bytes=8), "cuda": object()},
        raising=False,
    )
    monkeypatch.setattr(
        scientific_resources,
        "fastsurfer_resource_status",
        lambda _root, _pin: {
            "state": "missing",
            "path": None,
            "variant": "cpu",
            "version": "2.5.4",
        },
    )
    monkeypatch.setattr(
        scientific_resources,
        "import_fastsurfer_sif",
        lambda *_args, **_kwargs: pytest.fail(
            "Prevent the failed pull from reaching import."
        ),
    )
    _stub_pull_preflight(monkeypatch)
    script = "\n".join(
        [
            "import sys",
            "sys.stdout.write('FATAL: registry secret-detail unreachable\\n')",
            "sys.stderr.write('FATAL: registry secret-detail unreachable\\n')",
            "sys.exit(3)",
        ]
    )
    sink = io.StringIO()
    manager = ManagedResourceManager(
        Emitter(sink),
        ProjectEpochs(),
        AuthorizationLedger(),
    )
    monkeypatch.setattr(
        manager,
        "_pull_command",
        lambda _operation, destination: [
            sys.executable,
            "-c",
            script,
            str(destination),
        ],
    )
    request = _request(root, user_data)
    request["authorization"] = _authorization(root)

    manager.provision(request)
    failed = _wait_status(manager, _request(root, user_data), "error")

    assert failed["error"] == (
        "Inspect the failed managed-resource Apptainer pull (exit status 3)."
    )
    assert "secret-detail" not in sink.getvalue()
    assert "secret-detail" not in str(failed)


def test_a_pull_exit_of_127_maps_to_the_apptainer_guidance(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Report the missing runtime when the clean-environment launch fails."""
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": SimpleNamespace(size_bytes=8), "cuda": object()},
        raising=False,
    )
    monkeypatch.setattr(
        scientific_resources,
        "fastsurfer_resource_status",
        lambda _root, _pin: {
            "state": "missing",
            "path": None,
            "variant": "cpu",
            "version": "2.5.4",
        },
    )
    _stub_pull_preflight(monkeypatch)
    manager = ManagedResourceManager(
        Emitter(io.StringIO()),
        ProjectEpochs(),
        AuthorizationLedger(),
    )
    monkeypatch.setattr(
        manager,
        "_pull_command",
        lambda _operation, _destination: [
            sys.executable,
            "-c",
            "import sys; sys.exit(127)",
        ],
    )
    request = _request(root, user_data)
    request["authorization"] = _authorization(root)

    manager.provision(request)
    failed = _wait_status(manager, _request(root, user_data), "error")

    assert failed["error"] == _APPTAINER_MISSING_ERROR


def test_offline_import_surfaces_the_first_party_checksum_message(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep the real verifier's checksum refusal instead of flattening it."""
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    pin = _small_fastsurfer_pin(b"verified")
    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": pin, "cuda": object()},
        raising=False,
    )
    source = tmp_path / "offline.sif"
    source.write_bytes(b"tampered")
    manager = ManagedResourceManager(
        Emitter(io.StringIO()),
        ProjectEpochs(),
        AuthorizationLedger(),
    )
    request = _request(root, user_data)
    request.update(
        {
            "sourcePath": str(source),
            "authorization": _authorization(root),
        }
    )

    manager.import_offline(request)
    failed = _wait_status(manager, _request(root, user_data), "error")

    assert failed["error"] == "Match the SIF SHA-256 to the release pin."
    assert failed["state"] == "missing"
    assert not (user_data / "scientific-resources").exists()


@pytest.mark.skipif(os.geteuid() == 0, reason="Root ignores write permissions.")
def test_offline_import_into_an_unwritable_destination_reports_writability(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    user_data.mkdir()
    pin = _small_fastsurfer_pin(b"verified")
    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": pin, "cuda": object()},
        raising=False,
    )
    source = tmp_path / "offline.sif"
    source.write_bytes(b"verified")
    manager = ManagedResourceManager(
        Emitter(io.StringIO()),
        ProjectEpochs(),
        AuthorizationLedger(),
    )
    request = _request(root, user_data)
    request.update(
        {
            "sourcePath": str(source),
            "authorization": _authorization(root),
        }
    )

    user_data.chmod(0o500)
    try:
        manager.import_offline(request)
        failed = _wait_status(manager, _request(root, user_data), "error")
    finally:
        user_data.chmod(0o700)

    assert failed["error"] == (
        "Make the machine-local scientific-resource destination writable."
    )


def test_offline_import_end_to_end_activates_a_verified_sif(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify, promote, and activate real small SIF bytes through one import."""
    root = tmp_path / "project"
    root.mkdir()
    user_data = tmp_path / "user-data"
    pin = _small_fastsurfer_pin(b"verified")
    monkeypatch.setattr(
        scientific_resources,
        "FASTSURFER_RELEASE_PINS",
        {"cpu": pin, "cuda": object()},
        raising=False,
    )
    source = tmp_path / "offline.sif"
    source.write_bytes(b"verified")
    manager = ManagedResourceManager(
        Emitter(io.StringIO()),
        ProjectEpochs(),
        AuthorizationLedger(),
    )
    request = _request(root, user_data)
    request.update(
        {
            "sourcePath": str(source),
            "authorization": _authorization(root),
        }
    )

    manager.import_offline(request)
    done = _wait_status(manager, _request(root, user_data), "done")

    assert done["state"] == "ready"
    assert done["error"] is None
    resource_root = (
        user_data
        / "scientific-resources"
        / "fastsurfer"
        / f"v{scientific_resources.FASTSURFER_VERSION}"
        / "cpu"
    )
    assert (resource_root / "CURRENT").read_text().strip() == pin.sha256
    generation = resource_root / "generations" / pin.sha256
    assert (generation / "fastsurfer.sif").read_bytes() == b"verified"
