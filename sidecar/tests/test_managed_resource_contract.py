"""Tests mirroring runtime validation for managed scientific-resource RPC shapes."""

from __future__ import annotations

import pytest

from supraspina_sidecar.managed_resource_contract import (
    ManagedResourceContractError,
    parse_managed_resource_selector,
    parse_managed_resource_status,
)


def test_selector_accepts_only_reviewed_resource_variant_pairs() -> None:
    assert parse_managed_resource_selector(
        {"resource": "synthstrip", "variant": "cpu"}
    ) == ("synthstrip", "cpu")
    assert parse_managed_resource_selector(
        {"resource": "fastsurfer", "variant": "cuda"}
    ) == ("fastsurfer", "cuda")

    with pytest.raises(ManagedResourceContractError, match="variant"):
        parse_managed_resource_selector({"resource": "synthstrip", "variant": "cuda"})
    with pytest.raises(ManagedResourceContractError, match="fields"):
        parse_managed_resource_selector(
            {"resource": "fastsurfer", "variant": "cpu", "extra": True}
        )


def test_status_rejects_inconsistent_operation_and_cancellation_state() -> None:
    status = {
        "resource": "fastsurfer",
        "variant": "cpu",
        "version": "2.5.4",
        "state": "ready",
        "phase": "idle",
        "operationId": None,
        "percent": None,
        "cancellable": False,
        "error": None,
    }
    assert parse_managed_resource_status(status) == status

    with pytest.raises(ManagedResourceContractError, match="operation"):
        parse_managed_resource_status(
            {
                **status,
                "phase": "pulling",
                "operationId": None,
            }
        )
    with pytest.raises(ManagedResourceContractError, match="cancellable"):
        parse_managed_resource_status(
            {
                **status,
                "phase": "done",
                "operationId": "resource-012345abcdef",
                "cancellable": True,
            }
        )
