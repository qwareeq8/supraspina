"""Non-blocking acquisition and import of managed scientific SIFs."""

from __future__ import annotations

import math
import os
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import scientific_resources
from .authorization import AuthorizationLedger
from .managed_resource_contract import (
    ManagedResourceContractError,
    parse_managed_resource_runtime,
    parse_managed_resource_selector,
    parse_managed_resource_status,
)
from .project import ProjectEpochs, ProjectIdentity
from .workflow import validate_config_revision

_COMMON_KEYS = {
    "project",
    "cfg",
    "configRevision",
    "resource",
    "variant",
    "userDataPath",
}
_START_KEYS = _COMMON_KEYS | {"authorization"}
_IMPORT_KEYS = _START_KEYS | {"sourcePath"}
_CANCEL_KEYS = _COMMON_KEYS | {"operationId"}
_CANCELLABLE_PHASES = {"queued", "pulling", "importing", "verifying"}
_TERMINAL_PHASES = {"done", "error", "cancelled"}
_MAX_USER_DATA_PATH = 16_384
_MAX_SOURCE_PATH = 16_384
_OPERATION_ID = re.compile(r"^resource-[a-f0-9]{12}$")
_DISK_RESERVE_BYTES = 512 * 1024 * 1024
_MAX_OPERATION_HISTORY = 256
_MAX_PULL_PROGRESS_RECORD_BYTES = 4_096
_PULL_OUTPUT_CHUNK_BYTES = 4_096
_MAX_PULL_PROGRESS_BYTES = 64 * 1024**4
_MAX_PERCENT = 100
_ASCII_TAB = 0x09
_ASCII_SPACE = 0x20
_ASCII_TILDE = 0x7E
_PULL_PROGRESS_PREFIX = re.compile(
    rb"^[ \t]*(?:copying|downloading|fetching|pulling)\b",
    re.IGNORECASE,
)
_PULL_PROGRESS_PERCENT = re.compile(
    rb"(?<![0-9A-Za-z_.])"
    rb"([0-9]{1,3}(?:\.[0-9]{1,3})?)[ \t]*%"
    rb"(?![0-9A-Za-z_])",
)
_PULL_PROGRESS_BYTES = re.compile(
    rb"(?<![0-9A-Za-z_.])"
    rb"([0-9]{1,12}(?:\.[0-9]{1,3})?)[ \t]*"
    rb"(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)[ \t]*/[ \t]*"
    rb"([0-9]{1,12}(?:\.[0-9]{1,3})?)[ \t]*"
    rb"(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)"
    rb"(?![0-9A-Za-z_])",
    re.IGNORECASE,
)
_PULL_PROGRESS_UNIT_BYTES = {
    b"b": 1,
    b"kb": 1_000,
    b"mb": 1_000**2,
    b"gb": 1_000**3,
    b"tb": 1_000**4,
    b"kib": 1_024,
    b"mib": 1_024**2,
    b"gib": 1_024**3,
    b"tib": 1_024**4,
}
# Every message published through the status error channel or an operator
# refusal must stay static apart from a parsed Apptainer release triple: no
# path, no subject id, and no captured subprocess output. The channel is
# bounded by the status contract.
_APPTAINER_MISSING_ERROR = (
    f"Install Apptainer {scientific_resources.APPTAINER_VERSION} to pull "
    "managed resources, following the supported-Ubuntu steps in the Supraspina "
    "installation guide, or import a verified SIF offline."
)
_APPTAINER_UNKNOWN_RELEASE_ERROR = (
    f"Install Apptainer {scientific_resources.APPTAINER_VERSION} to "
    "reproduce the pinned managed-resource SIF; the installed Apptainer did "
    "not report a release. Import a verified SIF offline instead."
)
_STAGING_UNWRITABLE_ERROR = (
    "Make the machine-local scientific-resource cache writable before provisioning."
)
_MAX_STATUS_ERROR_CHARACTERS = 512
_APPTAINER_VERSION_TIMEOUT_SECONDS = 15
_APPTAINER_VERSION_OUTPUT_BYTES = 4_096
# The shell reserves 126 (found but not runnable) and 127 (not found) for a
# failed command launch, and `env -i` reports them the same way.
_LAUNCH_FAILURE_STATUSES = {126, 127}
_APPTAINER_RELEASE = re.compile(
    rb"(?<![0-9A-Za-z.])([0-9]+\.[0-9]+\.[0-9]+)(?!\.?[0-9])"
)


def _parse_apptainer_version(output: bytes) -> str | None:
    """Parse one bounded ``apptainer --version`` report into its release."""
    if not output or len(output) > _APPTAINER_VERSION_OUTPUT_BYTES:
        return None
    match = _APPTAINER_RELEASE.search(output.splitlines()[0])
    return match.group(1).decode("ascii") if match else None


def _apptainer_release(apptainer: str) -> str | None:
    """Return the release reported by one resolved Apptainer executable."""
    try:
        completed = subprocess.run(  # noqa: S603
            [*scientific_resources.CLEAN_HOST_ENV_PREFIX, apptainer, "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=_APPTAINER_VERSION_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    return _parse_apptainer_version(completed.stdout)


def _apptainer_release_error(detected: str) -> str:
    """Name the reviewed Apptainer release beside the one this machine has."""
    return (
        f"Install Apptainer {scientific_resources.APPTAINER_VERSION} to "
        "reproduce the pinned managed-resource SIF; this machine has "
        f"Apptainer {detected}. Import a verified SIF offline instead."
    )


def detect_apptainer_runtime() -> dict[str, Any]:
    """Report whether Apptainer can reproduce the pinned managed-resource SIFs.

    Resolve the executable and parse its release exactly as the pull preflight
    does, so the readiness ``managedResource.status`` publishes and the outcome
    of an authorized pull cannot disagree. The reviewed release is an exact
    pin, not a floor: only :data:`scientific_resources.APPTAINER_VERSION`
    reproduces the recorded SIF bytes.

    Returns
    -------
    dict
        Return the readiness report validated by the managed-resource
        contract. Carry ``detail`` only when the runtime is not ready, and
        keep it free of any resolved path or captured Apptainer output.
    """
    expected = scientific_resources.APPTAINER_VERSION
    path = shutil.which("apptainer")
    if path is None:
        return {
            "found": False,
            "path": None,
            "version": None,
            "expectedVersion": expected,
            "ready": False,
            "detail": _APPTAINER_MISSING_ERROR,
        }
    version = _apptainer_release(path)
    if version is None:
        detail: str | None = _APPTAINER_UNKNOWN_RELEASE_ERROR
    elif version != expected:
        detail = _apptainer_release_error(version)
    else:
        detail = None
    return {
        "found": True,
        "path": path,
        "version": version,
        "expectedVersion": expected,
        "ready": detail is None,
        "detail": detail,
    }


def _pull_failure_error(returncode: int) -> str:
    """Choose the static message for one failed pull exit status."""
    if returncode in _LAUNCH_FAILURE_STATUSES:
        return _APPTAINER_MISSING_ERROR
    if returncode < 0:
        return (
            "Inspect the failed managed-resource Apptainer pull "
            f"(terminated by signal {-returncode})."
        )
    return (
        "Inspect the failed managed-resource Apptainer pull "
        f"(exit status {returncode})."
    )


def _parse_apptainer_pull_progress(record: bytes) -> float | None:
    """Parse one bounded allowlisted Apptainer transfer progress record."""
    if (
        not record
        or len(record) > _MAX_PULL_PROGRESS_RECORD_BYTES
        or _PULL_PROGRESS_PREFIX.match(record) is None
        or any(
            byte > _ASCII_TILDE or (byte < _ASCII_SPACE and byte != _ASCII_TAB)
            for byte in record
        )
    ):
        return None
    percent_match = _PULL_PROGRESS_PERCENT.search(record)
    if percent_match is not None:
        percent = float(percent_match.group(1))
        return percent if math.isfinite(percent) and percent <= _MAX_PERCENT else None
    bytes_match = _PULL_PROGRESS_BYTES.search(record)
    if bytes_match is None:
        return None
    copied = (
        float(bytes_match.group(1))
        * _PULL_PROGRESS_UNIT_BYTES[bytes_match.group(2).lower()]
    )
    total = (
        float(bytes_match.group(3))
        * _PULL_PROGRESS_UNIT_BYTES[bytes_match.group(4).lower()]
    )
    if (
        not math.isfinite(copied)
        or not math.isfinite(total)
        or copied < 0
        or total <= 0
        or copied > total
        or total > _MAX_PULL_PROGRESS_BYTES
    ):
        return None
    return copied * 100 / total


@dataclass
class _Operation:
    operation_id: str
    project: ProjectIdentity
    resource: str
    variant: str
    user_data: Path
    source: Path | None
    state: str
    version: str
    phase: str = "queued"
    percent: float | None = 0
    error: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    completed: threading.Event = field(default_factory=threading.Event)
    process: subprocess.Popen[bytes] | None = None
    last_emitted_phase: str | None = None
    last_emitted_percent_bucket: int | None = None


class ManagedResourceManager:
    """Own machine-local resource pulls/imports and cooperative cancellation."""

    def __init__(
        self,
        emitter: Any,
        projects: ProjectEpochs,
        authorizations: AuthorizationLedger,
    ) -> None:
        """Initialize the process-local operation ledger."""
        self.emitter = emitter
        self.projects = projects
        self.authorizations = authorizations
        self._lock = threading.RLock()
        self._operations: dict[str, _Operation] = {}
        self._latest: dict[tuple[str, str], str] = {}

    @staticmethod
    def _version(resource: str) -> str:
        if resource == "synthstrip":
            return str(getattr(scientific_resources, "SYNTHSTRIP_VERSION", "1.8"))
        return str(scientific_resources.FASTSURFER_VERSION)

    @staticmethod
    def _pin(resource: str, variant: str) -> Any:
        if resource == "synthstrip":
            pin = getattr(
                scientific_resources,
                "SYNTHSTRIP_RELEASE_PIN",
                None,
            )
        else:
            pins = getattr(
                scientific_resources,
                "FASTSURFER_RELEASE_PINS",
                {},
            )
            pin = pins.get(variant) if isinstance(pins, Mapping) else None
        if pin is None:
            raise scientific_resources.ManagedResourceError(
                "Provide the exact managed-resource SIF release pin."
            )
        return pin

    @staticmethod
    def _request_context(
        projects: ProjectEpochs,
        request: dict[str, Any],
        expected_keys: set[str],
    ) -> tuple[ProjectIdentity, int, str, str, Path]:
        if not isinstance(request, dict) or set(request) != expected_keys:
            raise ManagedResourceContractError(
                "Remove invalid fields from the managed-resource request."
            )
        cfg = request.get("cfg")
        if not isinstance(cfg, dict):
            raise ManagedResourceContractError("Provide managed-resource cfg.")
        revision = validate_config_revision(request.get("configRevision"))
        project = projects.validate(request.get("project"), cfg)
        resource, variant = parse_managed_resource_selector(
            {
                "resource": request.get("resource"),
                "variant": request.get("variant"),
            }
        )
        raw_user_data = request.get("userDataPath")
        if (
            not isinstance(raw_user_data, str)
            or not raw_user_data
            or len(raw_user_data) > _MAX_USER_DATA_PATH
            or "\x00" in raw_user_data
            or not os.path.isabs(raw_user_data)
        ):
            raise ManagedResourceContractError(
                "Provide a valid managed-resource user-data path."
            )
        return (
            project,
            revision,
            resource,
            variant,
            Path(os.path.realpath(raw_user_data)),
        )

    @staticmethod
    def _backend_status(
        resource: str,
        variant: str,
        user_data: Path,
    ) -> tuple[str, str]:
        try:
            pin = ManagedResourceManager._pin(resource, variant)
            if resource == "synthstrip":
                raw = scientific_resources.synthstrip_resource_status(
                    user_data,
                    pin,
                )
            else:
                raw = scientific_resources.fastsurfer_resource_status(
                    user_data,
                    pin,
                )
        except (scientific_resources.ManagedResourceError, ValueError):
            return "unavailable", ManagedResourceManager._version(resource)
        if not isinstance(raw, dict) or raw.get("state") not in {
            "missing",
            "ready",
            "invalid",
        }:
            return "invalid", ManagedResourceManager._version(resource)
        return str(raw["state"]), ManagedResourceManager._version(resource)

    @staticmethod
    def _status_for(
        resource: str,
        variant: str,
        operation: _Operation | None,
        state: str,
        version: str,
    ) -> dict[str, Any]:
        if operation is None:
            phase = "idle"
            operation_id = None
            percent = None
            error = None
        else:
            phase = operation.phase
            operation_id = operation.operation_id
            percent = operation.percent
            error = operation.error
        return parse_managed_resource_status(
            {
                "resource": resource,
                "variant": variant,
                "version": version,
                "state": state,
                "phase": phase,
                "operationId": operation_id,
                "percent": percent,
                "cancellable": phase in _CANCELLABLE_PHASES,
                "error": error,
            }
        )

    def _latest_operation(self, resource: str, variant: str) -> _Operation | None:
        with self._lock:
            operation_id = self._latest.get((resource, variant))
            return self._operations.get(operation_id or "")

    def status(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return verified readiness, Apptainer readiness, and the latest operation.

        Probe Apptainer on every call rather than caching it, so the readiness
        the resources panel shows always describes the runtime an authorized
        pull would use. Publish it only here; the progress channel carries the
        lifecycle snapshot alone and must not spawn a probe per event.
        """
        _project, _revision, resource, variant, user_data = self._request_context(
            self.projects,
            request,
            _COMMON_KEYS,
        )
        state, version = self._backend_status(resource, variant, user_data)
        operation = self._latest_operation(resource, variant)
        if operation is not None:
            with self._lock:
                operation.state = state
                operation.version = version
        return {
            **self._status_for(resource, variant, operation, state, version),
            "runtime": parse_managed_resource_runtime(detect_apptainer_runtime()),
        }

    def _emit(self, operation: _Operation) -> None:
        with self._lock:
            percent_bucket = (
                int(operation.percent) if operation.percent is not None else None
            )
            if (
                operation.phase in {"pulling", "importing"}
                and operation.last_emitted_phase == operation.phase
                and operation.last_emitted_percent_bucket == percent_bucket
            ):
                return
            operation.last_emitted_phase = operation.phase
            operation.last_emitted_percent_bucket = percent_bucket
            status = self._status_for(
                operation.resource,
                operation.variant,
                operation,
                operation.state,
                operation.version,
            )
        payload = {
            **status,
            "projectId": operation.project.project_id,
            "projectEpoch": operation.project.epoch,
        }
        try:
            self.emitter.emit("managedResource.progress", payload)
        except (OSError, ValueError):
            pass

    def _set_phase(
        self,
        operation: _Operation,
        phase: str,
        percent: float | None,
        *,
        error: str | None = None,
        refresh_state: bool = False,
    ) -> None:
        refreshed: tuple[str, str] | None = None
        if refresh_state:
            refreshed = self._backend_status(
                operation.resource,
                operation.variant,
                operation.user_data,
            )
        with self._lock:
            operation.phase = phase
            operation.percent = percent
            operation.error = error
            if refreshed is not None:
                operation.state, operation.version = refreshed
        self._emit(operation)

    @staticmethod
    def _import(
        operation: _Operation,
        source: Path,
        pin: Any,
        progress: Any,
    ) -> Path:
        kwargs = {
            "progress": progress,
            "cancelled": operation.cancel.is_set,
        }
        if operation.resource == "synthstrip":
            return scientific_resources.import_synthstrip_sif(
                source,
                operation.user_data,
                pin,
                **kwargs,
            )
        return scientific_resources.import_fastsurfer_sif(
            source,
            operation.user_data,
            pin,
            **kwargs,
        )

    @staticmethod
    def _pull_command(
        operation: _Operation,
        destination: Path,
    ) -> list[str]:
        # Resolve Apptainer the same way detection does; the pull runs under a
        # clean PATH that need not contain a module or user-local install.
        apptainer = shutil.which("apptainer") or "apptainer"
        if operation.resource == "synthstrip":
            return scientific_resources.build_synthstrip_pull_command(
                destination,
                apptainer_executable=apptainer,
            )
        variant = scientific_resources.FASTSURFER_VARIANTS[operation.variant]
        return scientific_resources.build_fastsurfer_pull_command(
            variant,
            destination,
            apptainer_executable=apptainer,
        )

    @staticmethod
    def _terminate(operation: _Operation, *, force: bool = False) -> None:
        process = operation.process
        if process is None or process.poll() is not None:
            return
        try:
            if os.name == "nt":
                process.kill() if force else process.terminate()
            else:
                os.killpg(
                    os.getpgid(process.pid),
                    signal.SIGKILL if force else signal.SIGTERM,
                )
        except (OSError, ProcessLookupError):
            pass

    def _consume_pull_output(
        self,
        operation: _Operation,
        stream: Any,
    ) -> None:
        """Drain a pull pipe with bounded records and emit numeric progress."""
        record = bytearray()
        discarding = False

        def publish() -> None:
            nonlocal discarding
            if not discarding and record:
                percent = _parse_apptainer_pull_progress(bytes(record))
                if percent is not None:
                    with self._lock:
                        active = (
                            operation.phase == "pulling"
                            and not operation.cancel.is_set()
                        )
                    if active:
                        self._set_phase(operation, "pulling", percent)
            record.clear()
            discarding = False

        try:
            while True:
                chunk = stream.read(_PULL_OUTPUT_CHUNK_BYTES)
                if not chunk:
                    break
                for byte in chunk:
                    if byte in {0x0A, 0x0D}:
                        publish()
                    elif not discarding:
                        if len(record) < _MAX_PULL_PROGRESS_RECORD_BYTES:
                            record.append(byte)
                        else:
                            record.clear()
                            discarding = True
            publish()
        except (OSError, ValueError):
            return

    def _pull(self, operation: _Operation, destination: Path) -> None:
        command = self._pull_command(operation, destination)
        process = subprocess.Popen(  # noqa: S603
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
            start_new_session=os.name != "nt",
        )
        stream = process.stdout
        if stream is None:
            process.kill()
            process.wait(timeout=2)
            raise scientific_resources.ManagedResourceError(
                "Provide Apptainer pull output for the managed resource."
            )
        reader = threading.Thread(
            target=self._consume_pull_output,
            args=(operation, stream),
            daemon=True,
            name=f"{operation.operation_id}-pull-progress",
        )
        with self._lock:
            operation.process = process
        reader.start()
        try:
            while process.poll() is None:
                if operation.cancel.wait(0.05):
                    self._terminate(operation)
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        self._terminate(operation, force=True)
                        process.wait(timeout=2)
                    raise scientific_resources.ManagedResourceCancelled(
                        "Retry the managed-resource pull after cancellation."
                    )
            if operation.cancel.is_set():
                raise scientific_resources.ManagedResourceCancelled(
                    "Retry the managed-resource pull after cancellation."
                )
            if process.returncode != 0:
                raise scientific_resources.ManagedResourceError(
                    _pull_failure_error(process.returncode)
                )
        finally:
            reader.join(timeout=1)
            if reader.is_alive():
                try:
                    stream.close()
                except OSError:
                    pass
                reader.join(timeout=0.25)
            else:
                stream.close()
            with self._lock:
                operation.process = None

    @staticmethod
    def _preflight_pull_runtime() -> None:
        """Reject an authorized pull when Apptainer cannot reproduce the pins.

        Settle a missing and an unreviewed Apptainer through the same operation
        record so the operator reads one failure model in the resource row
        rather than a rejected request for one cause and a terminal error for
        the other.
        """
        runtime = detect_apptainer_runtime()
        if not runtime["ready"]:
            raise scientific_resources.ManagedResourceError(str(runtime["detail"]))

    def _prepare_staging(self, operation: _Operation, pin: Any) -> Path:
        """Verify the runtime, then claim one safe writable staging directory."""
        self._preflight_pull_runtime()
        staging_parent = operation.user_data / "scientific-resources"
        try:
            staging_parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        except FileExistsError:
            pass  # The safety check below rejects a non-directory.
        except OSError as exc:
            raise scientific_resources.ManagedResourceError(
                _STAGING_UNWRITABLE_ERROR
            ) from exc
        try:
            info = staging_parent.lstat()
        except OSError as exc:
            raise scientific_resources.ManagedResourceError(
                _STAGING_UNWRITABLE_ERROR
            ) from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise scientific_resources.ManagedResourceError(
                "Provide a safe managed-resource staging root."
            )
        required_bytes = int(pin.size_bytes) * 2 + _DISK_RESERVE_BYTES
        if shutil.disk_usage(staging_parent).free < required_bytes:
            raise scientific_resources.ManagedResourceError(
                "Free enough disk space for the managed-resource pull."
            )
        try:
            return Path(
                tempfile.mkdtemp(
                    prefix=".pull-",
                    dir=staging_parent,
                )
            )
        except OSError as exc:
            raise scientific_resources.ManagedResourceError(
                _STAGING_UNWRITABLE_ERROR
            ) from exc

    def _run(self, operation: _Operation, *, online: bool) -> None:
        staging: Path | None = None
        try:
            pin = self._pin(operation.resource, operation.variant)
            source = operation.source
            if online:
                staging = self._prepare_staging(operation, pin)
                source = staging / f"{operation.resource}-{operation.variant}.sif"
                self._set_phase(operation, "pulling", None)
                self._pull(operation, source)
            if source is None:
                raise scientific_resources.ManagedResourceError(
                    "Provide the managed-resource import source."
                )

            def progress(copied: int, total: int) -> None:
                if total <= 0:
                    percent: float | None = None
                else:
                    percent = max(0, min(100, copied * 100 / total))
                self._set_phase(operation, "importing", percent)

            self._set_phase(operation, "verifying", None)
            self._import(operation, source, pin, progress)
            if operation.cancel.is_set():
                raise scientific_resources.ManagedResourceCancelled(
                    "Restart the managed-resource operation after cancellation."
                )
            self._set_phase(operation, "done", 100, refresh_state=True)
        except scientific_resources.ManagedResourceCancelled:
            self._set_phase(
                operation,
                "cancelled",
                None,
                refresh_state=True,
            )
        except scientific_resources.ManagedResourceError as exc:
            # First-party managed-resource refusals are authored static
            # sentences; publish them instead of flattening. Raw subprocess
            # output never rides this exception type.
            self._set_phase(
                operation,
                "error",
                None,
                error=str(exc)[:_MAX_STATUS_ERROR_CHARACTERS],
                refresh_state=True,
            )
        except Exception:
            self._set_phase(
                operation,
                "error",
                None,
                error="Inspect the failed managed-resource operation.",
                refresh_state=True,
            )
        finally:
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)
            operation.completed.set()

    def _start(
        self,
        request: dict[str, Any],
        *,
        online: bool,
    ) -> dict[str, str]:
        expected = _START_KEYS if online else _IMPORT_KEYS
        project, revision, resource, variant, user_data = self._request_context(
            self.projects,
            request,
            expected,
        )
        self.authorizations.consume(
            request.get("authorization"),
            project_id=project.project_id,
            config_revision=revision,
            purpose="provision",
        )
        source: Path | None = None
        if not online:
            raw_source = request.get("sourcePath")
            if (
                not isinstance(raw_source, str)
                or not raw_source
                or len(raw_source) > _MAX_SOURCE_PATH
                or "\x00" in raw_source
                or not os.path.isabs(raw_source)
            ):
                raise ManagedResourceContractError(
                    "Provide a valid managed-resource offline source path."
                )
            source = Path(raw_source)
        state, version = self._backend_status(resource, variant, user_data)
        with self._lock:
            prior = self._latest_operation(resource, variant)
            if prior is not None and prior.phase not in _TERMINAL_PHASES:
                raise ManagedResourceContractError(
                    "Wait for the active managed-resource operation to finish."
                )
            operation_id = f"resource-{uuid.uuid4().hex[:12]}"
            operation = _Operation(
                operation_id=operation_id,
                project=project,
                resource=resource,
                variant=variant,
                user_data=user_data,
                source=source,
                state=state,
                version=version,
            )
            self._operations[operation_id] = operation
            self._latest[(resource, variant)] = operation_id
            latest_ids = set(self._latest.values())
            for stale_id, stale in list(self._operations.items()):
                if len(self._operations) <= _MAX_OPERATION_HISTORY:
                    break
                if stale_id not in latest_ids and stale.phase in _TERMINAL_PHASES:
                    self._operations.pop(stale_id, None)
        self._emit(operation)
        thread = threading.Thread(
            target=self._run,
            args=(operation,),
            kwargs={"online": online},
            daemon=True,
            name=operation_id,
        )
        thread.start()
        return {"operationId": operation_id}

    def provision(self, request: dict[str, Any]) -> dict[str, str]:
        """Start one immutable OCI pull and verified SIF activation."""
        return self._start(request, online=True)

    def import_offline(self, request: dict[str, Any]) -> dict[str, str]:
        """Start one offline SIF import through the identical verifier."""
        return self._start(request, online=False)

    def cancel(
        self,
        request: dict[str, Any],
        *,
        timeout: float = 5.0,
    ) -> dict[str, Any]:
        """Cancel one exact resource operation and wait for bounded settlement."""
        project, _revision, resource, variant, _user_data = self._request_context(
            self.projects,
            request,
            _CANCEL_KEYS,
        )
        operation_id = request.get("operationId")
        if (
            not isinstance(operation_id, str)
            or _OPERATION_ID.fullmatch(operation_id) is None
        ):
            raise ManagedResourceContractError(
                "Provide a valid managed-resource operation identity."
            )
        with self._lock:
            operation = self._operations.get(operation_id)
            if (
                operation is None
                or operation.project != project
                or operation.resource != resource
                or operation.variant != variant
            ):
                return {
                    "operationId": operation_id,
                    "accepted": False,
                    "terminal": True,
                }
            if operation.phase in _TERMINAL_PHASES:
                return {
                    "operationId": operation_id,
                    "accepted": True,
                    "terminal": True,
                }
            operation.cancel.set()
        self._terminate(operation)
        operation.completed.wait(max(0, min(timeout, 30)))
        with self._lock:
            terminal = operation.phase in _TERMINAL_PHASES
        return {
            "operationId": operation_id,
            "accepted": True,
            "terminal": terminal,
        }

    def active_count(self) -> int:
        """Return the number of unsettled machine-resource operations."""
        with self._lock:
            return sum(
                operation.phase not in _TERMINAL_PHASES
                for operation in self._operations.values()
            )

    def shutdown(self, timeout: float = 5.0) -> None:
        """Cancel every active resource operation within one shared deadline."""
        with self._lock:
            operations = [
                operation
                for operation in self._operations.values()
                if operation.phase not in _TERMINAL_PHASES
            ]
        for operation in operations:
            operation.cancel.set()
            self._terminate(operation)
        deadline = time.monotonic() + max(0, min(timeout, 30))
        for operation in operations:
            operation.completed.wait(max(0, deadline - time.monotonic()))
