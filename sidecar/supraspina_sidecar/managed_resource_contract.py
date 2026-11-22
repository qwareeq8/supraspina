"""Strict validation of managed scientific-resource RPC JSON shapes."""

from __future__ import annotations

import re
from typing import Any

_SELECTOR_KEYS = {"resource", "variant"}
_STATUS_KEYS = _SELECTOR_KEYS | {
    "version",
    "state",
    "phase",
    "operationId",
    "percent",
    "cancellable",
    "error",
}
_STATES = {"missing", "ready", "invalid", "unavailable"}
_PHASES = {
    "idle",
    "queued",
    "pulling",
    "importing",
    "verifying",
    "done",
    "error",
    "cancelled",
}
_CANCELLABLE_PHASES = {"queued", "pulling", "importing", "verifying"}
_RUNTIME_KEYS = {
    "found",
    "path",
    "version",
    "expectedVersion",
    "ready",
    "detail",
}
_OPERATION_ID = re.compile(r"^resource-[a-f0-9]{12}$")
#: Accept only a bounded numeric release triple so a detected Apptainer
#: version can never carry captured subprocess output across the boundary.
_RELEASE = re.compile(r"^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$")
_MAX_VERSION = 64
_MAX_ERROR = 512
_MAX_RUNTIME_PATH = 4_096
_MAX_PERCENT = 100


class ManagedResourceContractError(ValueError):
    """Reject a managed-resource value that violates the bounded contract."""


def parse_managed_resource_selector(value: Any) -> tuple[str, str]:
    """Parse an exact reviewed resource and variant pair.

    Parameters
    ----------
    value
        Provide the JSON-decoded selector object.

    Returns
    -------
    tuple[str, str]
        Return the resource and variant.

    Raises
    ------
    ManagedResourceContractError
        Raise when the shape or pair is not reviewed for this release.
    """
    if not isinstance(value, dict) or set(value) != _SELECTOR_KEYS:
        raise ManagedResourceContractError(
            "Remove invalid fields from the managed-resource selector."
        )
    resource = value.get("resource")
    variant = value.get("variant")
    if resource == "synthstrip" and variant == "cpu":
        return "synthstrip", "cpu"
    if resource == "fastsurfer" and variant in {"cpu", "cuda"}:
        return "fastsurfer", str(variant)
    raise ManagedResourceContractError("Select a valid managed-resource variant.")


def parse_managed_resource_runtime(value: Any) -> dict[str, Any]:
    """Parse one internally consistent Apptainer readiness report.

    Parameters
    ----------
    value
        Provide the JSON-decoded runtime-readiness object.

    Returns
    -------
    dict
        Return a shallow copy of the validated readiness report.

    Raises
    ------
    ManagedResourceContractError
        Raise when any field is missing, unbounded, or inconsistent.
    """
    if not isinstance(value, dict) or set(value) != _RUNTIME_KEYS:
        raise ManagedResourceContractError(
            "Remove invalid fields from the managed-resource runtime."
        )
    found = value.get("found")
    ready = value.get("ready")
    path = value.get("path")
    version = value.get("version")
    expected = value.get("expectedVersion")
    detail = value.get("detail")
    if (
        not isinstance(found, bool)
        or not isinstance(ready, bool)
        or not isinstance(expected, str)
        or _RELEASE.fullmatch(expected) is None
        or (
            version is not None
            and (not isinstance(version, str) or _RELEASE.fullmatch(version) is None)
        )
    ):
        raise ManagedResourceContractError("Provide a valid managed-resource runtime.")
    if found:
        if (
            not isinstance(path, str)
            or not path
            or len(path) > _MAX_RUNTIME_PATH
            or "\x00" in path
        ):
            raise ManagedResourceContractError(
                "Provide the resolved managed-resource runtime path."
            )
    elif path is not None or version is not None:
        raise ManagedResourceContractError(
            "Keep the managed-resource runtime evidence consistent."
        )
    # A ready runtime is exactly one that was found at the reviewed release,
    # so the readiness flag can never contradict the evidence beside it.
    if ready != (found and version == expected):
        raise ManagedResourceContractError(
            "Keep the managed-resource runtime readiness consistent."
        )
    if ready:
        if detail is not None:
            raise ManagedResourceContractError(
                "Omit the detail for a ready managed-resource runtime."
            )
    elif not isinstance(detail, str) or not detail or len(detail) > _MAX_ERROR:
        raise ManagedResourceContractError(
            "Explain why the managed-resource runtime is not ready."
        )
    return dict(value)


def parse_managed_resource_status(value: Any) -> dict[str, Any]:
    """Parse one internally consistent managed-resource lifecycle snapshot.

    Parameters
    ----------
    value
        Provide the JSON-decoded status object.

    Returns
    -------
    dict
        Return a shallow copy of the validated status.

    Raises
    ------
    ManagedResourceContractError
        Raise when any field is missing, unbounded, or inconsistent.
    """
    if not isinstance(value, dict) or set(value) != _STATUS_KEYS:
        raise ManagedResourceContractError(
            "Remove invalid fields from the managed-resource status."
        )
    parse_managed_resource_selector(
        {"resource": value.get("resource"), "variant": value.get("variant")}
    )
    version = value.get("version")
    state = value.get("state")
    phase = value.get("phase")
    error = value.get("error")
    if (
        not isinstance(version, str)
        or not version
        or len(version) > _MAX_VERSION
        or state not in _STATES
        or phase not in _PHASES
        or not isinstance(value.get("cancellable"), bool)
        or (
            error is not None
            and (not isinstance(error, str) or len(error) > _MAX_ERROR)
        )
    ):
        raise ManagedResourceContractError("Provide a valid managed-resource status.")
    operation_id = value.get("operationId")
    if operation_id is not None and (
        not isinstance(operation_id, str)
        or _OPERATION_ID.fullmatch(operation_id) is None
    ):
        raise ManagedResourceContractError(
            "Provide a valid managed-resource operation identity."
        )
    if (phase == "idle") != (operation_id is None):
        raise ManagedResourceContractError(
            "Keep the managed-resource operation identity consistent."
        )
    percent = value.get("percent")
    if percent is not None and (
        isinstance(percent, bool)
        or not isinstance(percent, (int, float))
        or not 0 <= percent <= _MAX_PERCENT
    ):
        raise ManagedResourceContractError("Provide valid managed-resource progress.")
    cancellable = phase in _CANCELLABLE_PHASES
    if value["cancellable"] != cancellable:
        raise ManagedResourceContractError(
            "Keep the managed-resource cancellable state consistent."
        )
    return dict(value)
