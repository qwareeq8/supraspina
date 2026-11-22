"""Registration point for the pipeline step adapters.

Each adapter wraps one real external tool as a subprocess and provides:
a command builder from the project configuration, a version-validated parameter
schema, an output-artifact detector faithful to the step's output TYPE,
exit-code parsing, and a dry-run command preview. A MATLAB or MATLAB Runtime
backend selector is shared across the three ENIGMA QC steps. Micromamba
provisioning and the checksum-pinned Zenodo model fetch stay in the PyBrainAge
adapter.

Every adapter module is imported through this package, which runs each module's
``register(...)`` call and populates
:data:`supraspina_sidecar.adapters.base.ADAPTERS` as a side effect.
"""

from __future__ import annotations

from . import (  # noqa: F401 - Register the adapters on import.
    age,
    aggregate,
    braincharts,
    brainfov,
    brainpad,
    clinical,
    deface,
    enigma,
    enigma_units,
    features,
    final,
    outliers,
    pybrainage,
    recon,
    zstats,
)
from .base import ADAPTERS, UNIT_CONTRACTS

__all__ = ["ADAPTERS", "UNIT_CONTRACTS"]
