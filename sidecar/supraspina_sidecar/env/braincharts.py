"""Probe of the BrainCharts runtime and model that Scientific resources sets up.

``bcenv`` reports the pcntoolkit environment and ``bcmodel`` the model tree
with its site and phenotype lists. Both recheck ``provision-state.json``
against the published files (no interpreter runs) and carry the recorded
provenance digest in their identity text, as ``pyenv`` and ``modelfile`` do,
so a stage that requires them binds the exact setup it ran with.

Adding these checks changes only the plan-level ``environmentDigest``; a
receipt binds just the checks its own step requires, so no existing node plans
again. No stage requires them until the BrainCharts stage does.
"""

from __future__ import annotations

from typing import Any

from .. import braincharts_runtime as runtime
from .base import Check, Probe, register_probe

_NOT_SET_UP = (
    "BrainCharts is not set up. Scientific resources downloads the model and "
    "builds its runtime after the license notice is accepted."
)


class BrainChartsProbe(Probe):
    """Report the provisioned BrainCharts runtime and model."""

    name = "BrainCharts"

    def checks(self, cfg: dict[str, Any]) -> list[Check]:
        """Return the ``bcenv`` and ``bcmodel`` checks for one configuration."""
        if not runtime.platform_supported():
            detail = runtime.unsupported_platform_detail()
            return [
                Check(id="bcenv", label=_ENV_LABEL, status="skipped", detail=detail),
                Check(
                    id="bcmodel", label=_MODEL_LABEL, status="skipped", detail=detail
                ),
            ]
        try:
            python = runtime.env_python(cfg)
            model = runtime.model_dir(cfg)
        except (TypeError, ValueError):
            detail = "Configure paths.outputDir as an absolute path."
            return [
                Check(id="bcenv", label=_ENV_LABEL, status="missing", detail=detail),
                Check(
                    id="bcmodel", label=_MODEL_LABEL, status="missing", detail=detail
                ),
            ]
        state = runtime.provision_state_status(cfg)
        return [
            _check("bcenv", _ENV_LABEL, python, state.environment_ok, state),
            _check("bcmodel", _MODEL_LABEL, model, state.model_ok, state),
        ]


_ENV_LABEL = "BrainCharts runtime"
_MODEL_LABEL = "BrainCharts lifespan model"


def _check(
    check_id: str,
    label: str,
    path: str,
    ok: bool,
    state: runtime.ProvisionState,
) -> Check:
    """Build one check from the shared provision-state recheck."""
    if ok and state.provenance is not None:
        return Check(
            id=check_id,
            label=label,
            status="found",
            detail=f"{path} (provenance {state.provenance}).",
            identity_detail=f"Use {path}; provenance {state.provenance}.",
        )
    if ok:
        # This half holds, but the other half fails, so no provenance is bound.
        return Check(
            id=check_id,
            label=label,
            status="wrong",
            detail=f"{path} is present, but the setup is incomplete: {state.detail}",
        )
    missing = state.missing
    return Check(
        id=check_id,
        label=label,
        status="missing" if missing else "wrong",
        detail=_NOT_SET_UP if missing else state.detail,
        download_url=runtime.BRAINCHARTS_REPOSITORY if check_id == "bcmodel" else "",
    )


register_probe(BrainChartsProbe())
