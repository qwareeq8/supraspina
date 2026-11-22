"""The Python sidecar that orchestrates Supraspina.

The sidecar owns every heterogeneous external interaction driven by the desktop
app: spawning FreeSurfer, the ENIGMA QC backend (MATLAB / MATLAB Runtime), the
provisioned PyBrainAge conda environment, and Rscript; streaming their logs;
detecting the environment; and provisioning the PyBrainAge model. It speaks
newline-delimited JSON-RPC 2.0 over stdio with the Electron main process.
"""

__version__ = "20261122.2152.0"
