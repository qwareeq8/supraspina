"""Tests for the adapter ``${...}`` resolution guard (adapters/base.py).

The guard is the last line of defense before a real run: it refuses any built
argv that still carries an unresolved placeholder so that a misconfigured path,
such as an unset ``projectRoot``, cannot reach a real tool as a corrupt argument.
These tests pin both the detector and the raising behavior.
"""

from __future__ import annotations

import pytest

from supraspina_sidecar.adapters.base import (
    UnresolvedTemplateError,
    guard_resolved,
    unresolved_tokens,
)


def test_unresolved_tokens_empty_for_fully_resolved_argv() -> None:
    argv = ["recon-all", "-s", "sub-001", "-i", "/data/sub-001_T1w.nii.gz"]
    assert unresolved_tokens(argv) == []


def test_unresolved_tokens_collects_distinct_placeholders_in_order() -> None:
    argv = [
        "recon-all",
        "-sd",
        "${projectRoot}/derivatives",
        "-i",
        "${projectRoot}/${subject}/anat.nii.gz",
    ]
    assert unresolved_tokens(argv) == ["${projectRoot}", "${subject}"]


def test_guard_resolved_passes_a_clean_argv() -> None:
    # Raise no exception when nothing remains unresolved.
    guard_resolved("recon", ["recon-all", "-s", "sub-001"])


def test_guard_resolved_raises_with_step_and_tokens() -> None:
    with pytest.raises(UnresolvedTemplateError) as excinfo:
        guard_resolved("recon", ["recon-all", "-sd", "${projectRoot}/derivatives"])
    error = excinfo.value
    assert error.step == "recon"
    assert error.tokens == ["${projectRoot}"]
    assert "recon" in str(error)
    assert "${projectRoot}" in str(error)


def test_unresolved_template_error_is_a_value_error() -> None:
    # Subclass ValueError so the dispatcher converts the guard into JSON-RPC.
    assert issubclass(UnresolvedTemplateError, ValueError)
