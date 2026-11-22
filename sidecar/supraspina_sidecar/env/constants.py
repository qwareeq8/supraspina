"""Reviewed dependency links and package lists shared by the environment probes.

Probe modules import these constants so one edit updates every recommended
command and download link. The strings surface as clipboard fixes and source
links only; any opt-in install needs a separate, explicit call that Allow live
runs gates, described in :mod:`supraspina_sidecar.env.base`.
"""

from __future__ import annotations

from ..adapters.pybrainage import (
    MICROMAMBA_SHA256,
    MICROMAMBA_VERSION,
    PYBRAINAGE_ZENODO_RECORD,
)
from ..adapters.pybrainage import (
    PYBRAINAGE_ZENODO_DOI as PYBRAINAGE_ZENODO_DOI,  # noqa: PLC0414 - Re-export this name deliberately.
)

# -- FreeSurfer ----------------------------------------------------------------

#: Use this page to register for the FreeSurfer license required by recon.
FREESURFER_REGISTER_URL = "https://surfer.nmr.mgh.harvard.edu/registration.html"
#: Use the FreeSurfer 8.x download page for supported 8.x installations.
FREESURFER_DOWNLOAD_URL = "https://surfer.nmr.mgh.harvard.edu/fswiki/rel8downloads"
#: Record the authored release, and avoid mixing versions within one cohort
#: because 8.x numerical drift remains possible.
FREESURFER_AUTHORED_RELEASE = "7.4.1"

# -- MATLAB / MATLAB Runtime ---------------------------------------------------

#: Use the MathWorks product page to acquire licensed MATLAB for the source
#: backend. Licensing and installation stay with the operator; Supraspina never
#: automates either.
MATLAB_PRODUCT_URL = "https://www.mathworks.com/products/matlab.html"
#: Target MATLAB Runtime R2019b v9.7 for the reviewed compiled ENIGMA binaries.
#: Load `libmwmclmcrrt.so.9.7` by exact name, and reject other runtime releases.
#: Use compiled+MCR as the fallback when licensed MATLAB is unavailable. Prefer
#: installed MATLAB with the Image Processing Toolbox for the source backend.
MCR_RELEASE = "R2019b"
MCR_DOTTED_VERSION = "9.7"
#: Load this runtime library relative to the runtime root. Check it directly
#: instead of trusting the install directory name.
MCR_RUNTIME_LIBRARY = f"runtime/glnxa64/libmwmclmcrrt.so.{MCR_DOTTED_VERSION}"
#: Use the MathWorks landing page to list each MATLAB Runtime release.
MCR_LANDING_URL = "https://www.mathworks.com/products/compiler/matlab-runtime.html"
#: Use the exact Linux installer zip for R2019b 9.7 Update 9.
MCR_LINUX_ZIP_URL = (
    "https://ssd.mathworks.com/supportfiles/downloads/R2019b/Release/9/"
    "deployment_files/installer/complete/glnxa64/"
    "MATLAB_Runtime_R2019b_Update_9_glnxa64.zip"
)
#: Probe these conventional MATLAB Runtime install roots in order when no
#: ``mcrRoot`` is configured. Each root is tried as the runtime root itself and
#: with the release directory the MathWorks installer appends (``v97``), so the
#: silent install one-liner's ``/usr/local/MATLAB`` destination is found.
MCR_INSTALL_ROOTS = (
    "/usr/local/MATLAB/MATLAB_Runtime",
    "/usr/local/MATLAB",
    "/opt/MATLAB/MATLAB_Runtime",
    "/opt/mcr",
)
#: Release -> dotted runtime version ladder (the compiled binaries need 9.7).
MCR_VERSION_LADDER = {
    "R2019b": "9.7",
    "R2020a": "9.8",
    "R2020b": "9.9",
    "R2021a": "9.10",
    "R2021b": "9.11",
    "R2022a": "9.12",
    "R2022b": "9.13",
    "R2023a": "9.14",
    "R2023b": "23.2",
    "R2024a": "24.1",
    "R2024b": "24.2",
}
# -- R -------------------------------------------------------------------------

#: Use this CRAN mirror for the recommended ``install.packages`` command.
R_CRAN_REPO = "https://cloud.r-project.org"
#: Probe optional packages used by the current first-party analysis scripts.
#: Gate report rendering separately on ``rmarkdown`` and ``knitr``.
R_REQUIRED_PACKAGES = (
    "writexl",
    "showtext",
    "sysfonts",
)
#: Offer this reviewed Ubuntu 22.04/24.04 hint when no R interpreter is found.
#: Render it copy-only; Supraspina never runs sudo or a system package manager.
R_SYSTEM_PACKAGE_HINT = "sudo apt-get install r-base"
#: Direct operators to the official Pandoc installation instructions.
PANDOC_INSTALL_URL = "https://pandoc.org/installing.html"
#: Offer this reviewed Ubuntu 22.04/24.04 hint when Pandoc is absent while
#: report rendering needs it. Render it copy-only for the same sudo reason.
PANDOC_PACKAGE_HINT = "sudo apt-get install pandoc"

# -- Python analysis stack -----------------------------------------------------

#: Probe these imports on the shared Age, Clinical, and Brain-PAD interpreter.
#: Keep this runtime separate from the provisioned Python 3.7 compatibility env.
PY_ANALYSIS_IMPORTS = (
    "pandas",
    "openpyxl",
    "numpy",
    "scipy",
    "seaborn",
    "statsmodels",
    "matplotlib",
    "cliffs_delta",
)
#: Import name -> PyPI distribution name where the two differ.
PY_PIP_DISTRIBUTIONS = {
    "cliffs_delta": "cliffs-delta==1.0.0",
    "openpyxl": "openpyxl==3.1.5",
}
# -- PyBrainAge model (single source of truth: adapters.pybrainage) ------------

#: Re-export ``PYBRAINAGE_ZENODO_DOI`` above from the adapter that owns it so
#: a bump there propagates to the env probes with no second hardcode.
#: Use the record landing page for "where to get it" (distinct from the adapter's
#: asset-file URL). Derive it from the shared record so the DOI and record live in
#: one place.
PYBRAINAGE_ZENODO_URL = f"https://zenodo.org/records/{PYBRAINAGE_ZENODO_RECORD}"
#: Use conda-forge for the pinned Python 3.7 and scikit-learn 0.24.2 stack.
CONDA_FORGE_URL = "https://conda-forge.org"
#: Bundle this exact micromamba release. Let source and development operators
#: download the same immutable binary when no manager is on PATH.
MICROMAMBA_RELEASE = f"{MICROMAMBA_VERSION}-0"
#: Fetch the sole supported Linux x86_64 build; Supraspina ships no other target.
MICROMAMBA_DOWNLOAD = {
    "url": (
        "https://github.com/mamba-org/micromamba-releases/releases/download/"
        f"{MICROMAMBA_RELEASE}/micromamba-linux-64"
    ),
    "sha256": MICROMAMBA_SHA256,
    "verify": "sha256sum --check -",
}

# -- Shell utilities -----------------------------------------------------------

#: Offer this copy-only package hint on Ubuntu-family hosts when the optional
#: CRLF converter is absent.
DOS2UNIX_PACKAGE_HINT = "sudo apt-get install dos2unix"
