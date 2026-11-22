"""The configured FreeSurfer environment used by probes and workflow jobs."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

from .freesurfer_license import (
    resolve_freesurfer_home,
    resolve_freesurfer_license_path,
)
from .paths import flatten, interpolate


def _resolved_subjects_dir(cfg: dict[str, Any], freesurfer_home: str) -> str:
    """Return the project FreeSurfer output parent or the install default."""
    paths = cfg.get("paths", {})
    configured = paths.get("derivativesDir") if isinstance(paths, dict) else ""
    if isinstance(configured, str) and configured:
        derivatives = interpolate(configured, flatten(cfg))
        if "${" not in derivatives:
            return os.path.join(derivatives, "freesurfer")
    return os.path.join(freesurfer_home, "subjects")


def _prepend_path(directories: list[str], current: str) -> str:
    """Prepend distinct directories while preserving the inherited path."""
    values: list[str] = []
    for value in [*directories, *current.split(os.pathsep)]:
        if value and value not in values:
            values.append(value)
    return os.pathsep.join(values)


def freesurfer_runtime_environment(
    cfg: dict[str, Any],
    *,
    base_environment: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Return a FreeSurfer-ready environment derived from project settings.

    Assume FreeSurfer's Linux scripts expect ``SetUpFreeSurfer.sh`` to have been
    sourced. Supply its essential aliases, project ``SUBJECTS_DIR``, and bundled
    MNI paths for desktop launches without executing a configurable shell script.

    Parameters
    ----------
    cfg
        Provide project configuration whose paths may contain placeholders.
    base_environment
        Provide an optional inherited environment to copy before applying
        FreeSurfer settings. Return only workflow-specific overrides when it is
        omitted.

    Returns
    -------
    dict of str to str
        Return a copied base environment plus deterministic FreeSurfer settings
        or an empty copied environment when no FreeSurfer home is configured.
    """
    environment = dict(base_environment or {})
    freesurfer_home = resolve_freesurfer_home(cfg)
    if not freesurfer_home:
        return environment

    subjects_dir = _resolved_subjects_dir(cfg, freesurfer_home)
    fsfast_home = os.path.join(freesurfer_home, "fsfast")
    mni_dir = os.path.join(freesurfer_home, "mni")
    mni_bin = os.path.join(mni_dir, "bin")
    mni_lib = os.path.join(mni_dir, "lib")
    mni_data = os.path.join(mni_dir, "data")
    mni_perl = os.path.join(mni_dir, "share", "perl5")

    environment.update(
        {
            "FREESURFER_HOME": freesurfer_home,
            "FREESURFER_HOME_FSPYTHON": freesurfer_home,
            # Set this legacy alias before recon-all 8.2 parses its argv.
            "FREESURFER": freesurfer_home,
            # Set SUBJECTS_DIR before recon-all parses its -sd option.
            "SUBJECTS_DIR": subjects_dir,
            "FSFAST_HOME": fsfast_home,
            "FUNCTIONALS_DIR": os.path.join(freesurfer_home, "sessions"),
            "LOCAL_DIR": os.path.join(freesurfer_home, "local"),
            "FMRI_ANALYSIS_DIR": fsfast_home,
            "FSF_OUTPUT_FORMAT": "nii.gz",
            "FIX_VERTEX_AREA": "",
        }
    )

    inherited_path = environment.get("PATH", os.environ.get("PATH", ""))
    path_directories = [os.path.join(freesurfer_home, "bin")]
    path_directories.extend(
        candidate
        for candidate in (
            os.path.join(fsfast_home, "bin"),
            os.path.join(freesurfer_home, "tktools"),
            mni_bin,
        )
        if os.path.isdir(candidate)
    )
    environment["PATH"] = _prepend_path(path_directories, inherited_path)

    if os.path.isdir(mni_bin):
        environment["MNI_DIR"] = mni_dir
        environment["MINC_BIN_DIR"] = mni_bin
    if os.path.isdir(mni_lib):
        environment["MINC_LIB_DIR"] = mni_lib
    if os.path.isdir(mni_data):
        environment["MNI_DATAPATH"] = mni_data
    if os.path.isdir(mni_perl):
        environment["MNI_PERL5LIB"] = mni_perl
        inherited_perl = environment.get("PERL5LIB", os.environ.get("PERL5LIB", ""))
        environment["PERL5LIB"] = _prepend_path([mni_perl], inherited_perl)

    license_path = resolve_freesurfer_license_path(
        cfg,
        freesurfer_home=freesurfer_home,
    )
    if license_path:
        environment["FS_LICENSE"] = license_path
    return environment
