"""Tests that the sidecar honors the contracts it mirrors.

``src/shared/ipc-surface.json`` is the single source of truth shared with the
TypeScript coverage tests, and :func:`build_dispatcher` must register every
method listed under ``"sidecar"``. The tests fail loudly if the dispatcher
drifts from the contract, because an unregistered method would reject with
``-32601`` (method not found) at runtime. Each adapter's ``param_schema`` is
the same kind of mirror for step parameters, so it is held to the validator's
canonical kinds and choices.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

from supraspina_sidecar.__main__ import build_dispatcher
from supraspina_sidecar.adapters import ADAPTERS
from supraspina_sidecar.rpc import Emitter
from supraspina_sidecar.schema import _STEP_PARAM_SPECS

_SURFACE = Path(__file__).resolve().parents[2] / "src" / "shared" / "ipc-surface.json"


def _surface():
    return json.loads(_SURFACE.read_text(encoding="utf-8"))


def test_surface_map_present():
    assert _SURFACE.exists(), f"Provide the IPC surface map: {_SURFACE}."


def test_every_sidecar_method_is_registered():
    surface = _surface()
    dispatcher = build_dispatcher(Emitter(io.StringIO()))
    registered = dispatcher.methods
    missing = [m for m in surface["sidecar"] if m not in registered]
    assert not missing, f"Add handlers for these sidecar contract methods: {missing}."


def test_surface_partitions_are_disjoint():
    surface = _surface()
    native = set(surface["native"])
    sidecar = set(surface["sidecar"])
    event = set(surface["event"])
    assert native.isdisjoint(sidecar)
    assert native.isdisjoint(event)
    assert sidecar.isdisjoint(event)


def test_every_adapter_param_schema_mirrors_the_validator_specs():
    for step, spec in _STEP_PARAM_SPECS.items():
        schema = ADAPTERS[step].param_schema()
        assert {name: item["kind"] for name, item in schema.items()} == {
            name: item[0] for name, item in spec.items()
        }, f"Mirror the {step} parameter kinds declared by the validator."
        for name, item in spec.items():
            if item[0] != "choice":
                continue
            assert schema[name]["options"] == list(item[1]), (
                f"Mirror the {step}.{name} choices declared by the validator."
            )
