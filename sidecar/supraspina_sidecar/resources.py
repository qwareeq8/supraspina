"""Locator for application resources (scripts, binaries, templates).

First-party step support ships with the application: a PyInstaller build
stages it under ``sys._MEIPASS/resources``, and a source checkout keeps it in
the repository's ``resources`` directory. Reviewed upstream assets with
unresolved redistribution terms are in neither; both install them only after
an explicit, checksum-pinned operator acquisition and resolve the
machine-local acquisition generation when one is active and usable (see
:func:`scientific_assets.usable_generation`).
"""

from __future__ import annotations

import sys
from pathlib import Path

from . import scientific_assets
from .bounded_io import read_bounded_regular, sha256_bounded_regular

_MAX_MANIFEST_BYTES = 2 * 1024 * 1024
_MAX_RESOURCE_BYTES = 64 * 1024 * 1024


def application_resource_root() -> Path:
    """Return the application's own resource files, without acquired ones."""
    return scientific_assets.application_resource_root()


def resource_root() -> Path:
    """Return the authoritative root holding application resources.

    Returns
    -------
    pathlib.Path
        Return the usable machine-local acquisition generation when present
        and its copies of first-party files are current; otherwise return the
        application's own resource files (see
        :func:`scientific_assets.application_copy_current`).
    """
    acquired = scientific_assets.active_resource_root()
    if acquired is not None and scientific_assets.application_copy_current():
        return acquired
    return application_resource_root()


def resource_dir(*parts: str) -> Path:
    """Return a path under the resource root, joined from ``parts``.

    A directory of bundled files only resolves from the application's own
    copy in a source checkout, and in a frozen build when this version
    revised or added it (Step 8 and Step 9, BrainCharts) while the acquired
    generation still holds the earlier bytes; see
    :func:`scientific_assets.stale_bundled_directories`.

    Returns
    -------
    pathlib.Path
        Return the joined resource path without checking its existence.
    """
    root = resource_root()
    application = application_resource_root()
    if parts and scientific_assets.bundled_override(parts[0], root, application):
        root = application
    return root.joinpath(*parts)


def resource_prefixes() -> tuple[tuple[Path, str], ...]:
    """Return every location whose paths name an application resource.

    Each entry pairs a location with the path under the resource root it
    stands for. For the active acquisition generation and a source checkout's
    own ``resources`` directory that is the whole root. The frozen subset
    contributes one entry per reviewed resource directory, so a directory
    resolved from it binds the same way as from a generation, while the
    first-party brain-FOV helper beside them is not a reviewed resource and
    stays a verbatim path whether or not a generation is usable.
    """
    root = resource_root()
    application = application_resource_root()
    entries: list[tuple[Path, str]] = [] if root == application else [(root, "")]
    if not getattr(sys, "frozen", False):
        return (*entries, (application, ""))
    entries.extend(
        (application / name, name) for name in scientific_assets.reviewed_directories()
    )
    return tuple(entries)


def brainfov_helper_path() -> Path:
    """Return the first-party brain-FOV helper mounted into SynthStrip.

    Execute the reviewed package source directly during development. Use the
    byte-for-byte staged copy in frozen builds because the module archive is not
    a mountable regular file.
    """
    if getattr(sys, "frozen", False):
        return application_resource_root() / "brainfov" / "brainfov_helper.py"
    return Path(__file__).resolve().with_name("brainfov.py")


def scientific_asset_acquisition_required() -> bool:
    """Return whether the application lacks the verified upstream asset set."""
    return scientific_assets.acquisition_required()


def scientific_asset_acquisition_command() -> list[str]:
    """Return the explicit acquisition command that Allow live runs gates."""
    return scientific_assets.acquisition_command()


def enigma_dir() -> Path:
    """Return the active reviewed ENIGMA QC asset directory.

    Resolve ``compiled/`` MATLAB Runtime launchers, ``ENIGMA_QC/`` MATLAB
    sources, the source wrapper, and QC rating templates from the explicitly
    acquired resource generation, beside the first-party ``outliers_qc.R``
    and the ``CHECKSUMS.sha256`` manifest.
    """
    return resource_dir("enigma")


def features_dir() -> Path:
    """Return the active Step 3 feature-extraction asset directory.

    Resolve the first-party ``extract_features.py`` driver and the acquired
    byte-identical ``rois_input_template.txt`` column reference together.
    """
    return resource_dir("features")


def pybrainage_dir() -> Path:
    """Return the bundled Step-5 PyBrainAge asset directory.

    Locate ``predict.py``, the argv-driven brain-age predictor, here.
    """
    return resource_dir("pybrainage")


def step7_dir() -> Path:
    """Return the bundled Step-7 Brain-PAD-statistics asset directory.

    Locate the inventoried first-party ``brainpadstats.py`` group-statistics
    implementation here and run it inside the provisioned environment.
    """
    return resource_dir("step7")


def step8_dir() -> Path:
    """Return the bundled Step-8 structural-aggregation asset directory.

    Locate the inventoried first-party ``aggregate_stats.py`` implementation
    here. Use it to parse FreeSurfer ``*.stats`` files into four cohort CSVs.
    """
    return resource_dir("step8")


def step9_dir() -> Path:
    """Return the bundled Step-9 R-analysis asset directory.

    Locate ``FreesurferAnalysisScript.R`` and its report wrapper
    ``FreesurferAnalysisScript.Rmd`` here.
    """
    return resource_dir("step9")


def verify_manifest(
    directory: Path, manifest_name: str = "CHECKSUMS.sha256"
) -> tuple[list[str], list[str]]:
    """Verify the files in a directory against a SHA-256 manifest.

    Read a ``sha256sum``-format manifest with one ``<64hex>  <relpath>`` line per
    file. Recompute each digest from binary bytes without decoding. Skip the
    manifest file itself.

    Parameters
    ----------
    directory
        Provide the asset directory whose contents are pinned by the manifest.
    manifest_name
        Provide the manifest filename inside ``directory``. Default to
        ``CHECKSUMS.sha256``.

    Returns
    -------
    tuple of (list of str, list of str)
        Return ``(missing, mismatched)`` relative-path lists. Put absent files in
        ``missing`` and digest failures in ``mismatched``. Return
        ``([manifest_name], [])`` when the manifest is missing.
    """
    manifest_path = directory / manifest_name
    missing: list[str] = []
    mismatched: list[str] = []
    try:
        manifest_text = read_bounded_regular(manifest_path, _MAX_MANIFEST_BYTES).decode(
            "utf-8"
        )
    except (OSError, UnicodeError):
        return [manifest_name], []
    for raw_line in manifest_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        expected, _, relpath = line.partition("  ")
        relpath = relpath.strip()
        if not relpath or relpath == manifest_name:
            continue
        target = directory / relpath
        try:
            digest, _size = sha256_bounded_regular(target, _MAX_RESOURCE_BYTES)
        except (OSError, ValueError):
            missing.append(relpath)
            continue
        if digest != expected:
            mismatched.append(relpath)
    return missing, mismatched
