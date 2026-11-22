"""Probe of the workspace and reviewed pipeline assets available to the application.

The probe verifies the study workspace root and every adapter-referenced asset.
First-party files resolve from the application's own resources. Upstream files
without a redistribution license resolve from an explicitly acquired,
checksum-verified resource generation in packaged builds and source checkouts
alike. ENIGMA QC assets are verified against the first-party
``enigma/CHECKSUMS.sha256`` manifest.

No tool boots and no pipeline runs during this probe. ENIGMA bytes are read
only to recompute SHA-256 digests; no asset content is decoded, printed,
copied, or repaired. Missing or corrupted assets are reported.

When the application lacks a verified generation, the probe also reports
whether the explicit acquisition would only rebuild the assets from verified
files already on this machine (an upgrade that revised the reviewed inventory)
or would download the pinned archive, and every affected check names that fix.
"""

from __future__ import annotations

import os
from typing import Any, Literal

from .. import resources, scientific_assets
from .base import Check, Installer, Probe, register_probe

_UPSTREAM_DOWNLOAD_URL = (
    "https://github.com/ortizo-117/SCI_Map/archive/"
    "8a8c2d3586a37bb896bd8bdc3743b43e602827e3.tar.gz"
)

#: Limit offender relpaths named in an integrity-failure detail string to this
#: count.
_MAX_OFFENDERS_SHOWN = 5

#: Name how the explicit acquisition would restore the reviewed assets:
#: ``rebuild`` from verified files already on this machine, ``download`` the
#: pinned archive, or ``None`` when the active generation already verifies.
Acquisition = Literal["rebuild", "download"] | None

#: Say which acquisition restores a missing step asset, keyed by
#: :data:`Acquisition`.
_RESTORE_LEAD: dict[Acquisition, str] = {
    None: "Install",
    "rebuild": "Rebuild the scientific assets to restore",
    "download": "Acquire the scientific assets to install",
}

#: Keep stage-specific resource checks separate so an unrelated missing asset
#: cannot block a stage. Interpret each tuple as ``(check id, label, files)`` and
#: resolve file entries relative to the active application resource root.
_STAGE_ASSETS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    (
        "features_assets",
        "Feature extraction assets",
        ("features/extract_features.py", "features/rois_input_template.txt"),
    ),
    (
        "pybrainage_assets",
        "PyBrainAge prediction assets",
        ("pybrainage/predict.py",),
    ),
    (
        "brainpad_assets",
        "Brain-PAD analysis assets",
        ("step7/brainpadstats.py", "figstyle/figstyle.py"),
    ),
    (
        "aggregate_assets",
        "Structural aggregation assets",
        ("step8/aggregate_stats.py",),
    ),
    (
        "final_assets",
        "R analysis assets",
        ("step9/FreesurferAnalysisScript.R",),
    ),
    (
        "final_report_assets",
        "R report assets",
        ("step9/FreesurferAnalysisScript.Rmd",),
    ),
    (
        "outliers_assets",
        "Outlier review assets",
        ("enigma/outliers_qc.R", "figstyle/figstyle.R"),
    ),
)


def _resolve_path(probe: Probe, cfg: dict[str, Any], template: str) -> str:
    """Resolve a ``${...}`` template and normalize it to an absolute path."""
    resolved = probe.resolve(template, cfg)
    return os.path.abspath(resolved) if resolved else resolved


def _acquisition() -> Acquisition:
    """Report how the explicit acquisition would restore the reviewed assets."""
    if not resources.scientific_asset_acquisition_required():
        return None
    if scientific_assets.offline_rebuild_available():
        return "rebuild"
    return "download"


class BundledAssetsProbe(Probe):
    """Probe the study workspace root and active reviewed resource set."""

    name = "Pipeline assets"

    def checks(self, cfg: dict[str, Any]) -> list[Check]:
        """Return one Check per asset requirement, in display order.

        Parameters
        ----------
        cfg
            Provide the full project configuration mapping (possibly empty or
            partial).

        Returns
        -------
        list of Check
            ``workspace``, ``enigma_assets``, the stage-specific asset checks,
            and the diagnostic aggregate ``pipeline_assets`` check.
        """
        workspace_root = _resolve_path(
            self, cfg, cfg.get("paths", {}).get("projectRoot", "")
        )
        # Decide once per probe; every asset check names the same fix.
        acquisition = _acquisition()
        return [
            self._check_workspace(workspace_root),
            self._check_scientific_assets(acquisition),
            self._check_enigma_assets(acquisition),
            *(
                self._check_stage_assets(*descriptor, acquisition)
                for descriptor in _STAGE_ASSETS
            ),
            self._check_pipeline_assets(acquisition),
        ]

    def _check_scientific_assets(self, acquisition: Acquisition) -> Check:
        """Require the explicit pinned acquisition of the upstream assets."""
        if acquisition is None:
            return Check(
                id="scientific_assets",
                label="Reviewed scientific assets",
                status="found",
                detail="The complete reviewed asset set is present.",
                identity_detail="Use the complete reviewed asset set.",
            )
        argv = resources.scientific_asset_acquisition_command()
        if acquisition == "rebuild":
            return Check(
                id="scientific_assets",
                label="Reviewed scientific assets",
                status="missing",
                detail=(
                    "Rebuild the scientific assets from the verified files "
                    "already on this machine; nothing is downloaded. The "
                    "acquired set no longer matches this version's reviewed "
                    "inventory."
                ),
                recommended_cmd=" ".join(argv),
                installer=Installer(
                    kind="command",
                    argv=argv,
                    one_liner=" ".join(argv),
                    note=(
                        "Verify every file against the reviewed inventory and "
                        "activate a new generation without a download."
                    ),
                    offline=True,
                ),
            )
        return Check(
            id="scientific_assets",
            label="Reviewed scientific assets",
            status="missing",
            detail=(
                "Acquire the exact verified bytes after reviewing Third-party "
                "notices because the installer cannot redistribute a pinned "
                "upstream tree without an explicit license."
            ),
            recommended_cmd=" ".join(argv),
            download_url=_UPSTREAM_DOWNLOAD_URL,
            installer=Installer(
                kind="command",
                argv=argv,
                one_liner=" ".join(argv),
                note=(
                    "Download one immutable archive, verify its SHA-256, and "
                    "activate only the reviewed files."
                ),
            ),
        )

    def _check_stage_assets(
        self,
        check_id: str,
        label: str,
        relpaths: tuple[str, ...],
        acquisition: Acquisition,
    ) -> Check:
        """Verify only the active resource files required by one pipeline stage."""
        missing = [
            relpath
            for relpath in relpaths
            if not resources.resource_dir(*relpath.split("/")).is_file()
        ]
        if missing:
            return Check(
                id=check_id,
                label=label,
                status="missing",
                detail=(
                    f"{_RESTORE_LEAD[acquisition]} {len(missing)} missing "
                    f"asset(s): {', '.join(missing)}."
                ),
            )
        count = len(relpaths)
        return Check(
            id=check_id,
            label=label,
            status="found",
            detail=(
                "The required asset is present."
                if count == 1
                else f"All {count} required assets are present."
            ),
            identity_detail=f"Use all {count} required asset(s).",
        )

    def _check_workspace(self, workspace_root: str) -> Check:
        """Verify ``paths.projectRoot`` is an existing directory."""
        if not workspace_root:
            # No project supplies a workspace root; defer instead of failing.
            return Check(
                id="workspace",
                label="Study workspace root",
                status="skipped",
                detail=(
                    "Supraspina checks the study workspace after a project sets "
                    "paths.projectRoot."
                ),
            )
        if not os.path.isdir(workspace_root):
            return Check(
                id="workspace",
                label="Study workspace root",
                status="missing",
                detail=f"Set projectRoot to a directory; received {workspace_root!r}.",
            )
        return Check(
            id="workspace",
            label="Study workspace root",
            status="found",
            detail=workspace_root,
        )

    def _check_enigma_assets(self, acquisition: Acquisition) -> Check:
        """Verify active ENIGMA QC assets against their SHA-256 manifest."""
        enigma_dir = resources.enigma_dir()
        missing, mismatched = resources.verify_manifest(enigma_dir)
        if not missing and not mismatched:
            return Check(
                id="enigma_assets",
                label="ENIGMA QC assets",
                status="found",
                detail=f"The ENIGMA QC assets in {enigma_dir} are integrity-verified.",
                identity_detail=(
                    f"Use the integrity-verified ENIGMA QC assets in {enigma_dir}."
                ),
            )
        offenders = sorted({*missing, *mismatched})
        sample = ", ".join(offenders[:_MAX_OFFENDERS_SHOWN])
        if len(offenders) > _MAX_OFFENDERS_SHOWN:
            sample += f", +{len(offenders) - _MAX_OFFENDERS_SHOWN} more"
        lead = {
            None: "Repair the ENIGMA QC assets",
            "rebuild": "Rebuild the scientific assets to restore the ENIGMA QC assets",
            "download": "Acquire the scientific assets to restore the ENIGMA QC assets",
        }[acquisition]
        counts = f"{len(missing)} missing and {len(mismatched)} mismatched: {sample}."
        detail = f"{lead}; {counts}"
        acquisition_command = (
            resources.scientific_asset_acquisition_command()
            if acquisition is not None
            else []
        )
        installer = (
            Installer(
                kind="command",
                argv=acquisition_command,
                one_liner=" ".join(acquisition_command),
                note=(
                    "Rebuild from the verified files on this machine; nothing "
                    "is downloaded."
                    if acquisition == "rebuild"
                    else "Review Third-party notices before acquiring."
                ),
                offline=acquisition == "rebuild",
            )
            if acquisition is not None
            else None
        )
        return Check(
            id="enigma_assets",
            label="ENIGMA QC assets",
            status="missing" if acquisition is not None else "wrong",
            detail=detail,
            identity_detail=f"{lead}; find {counts}",
            recommended_cmd=" ".join(acquisition_command),
            download_url=_UPSTREAM_DOWNLOAD_URL if acquisition == "download" else "",
            installer=installer,
        )

    def _check_pipeline_assets(self, acquisition: Acquisition) -> Check:
        """Verify that each active pipeline-step asset is present on disk."""
        relpaths = tuple(
            dict.fromkeys(
                relpath
                for _, _, stage_relpaths in _STAGE_ASSETS
                for relpath in stage_relpaths
            )
        )
        missing = [
            relpath
            for relpath in relpaths
            if not resources.resource_dir(*relpath.split("/")).is_file()
        ]
        if missing:
            return Check(
                id="pipeline_assets",
                label="Pipeline step assets",
                status="missing",
                detail=(
                    f"{_RESTORE_LEAD[acquisition]} {len(missing)} missing step "
                    f"asset(s): {', '.join(missing)}."
                ),
            )
        return Check(
            id="pipeline_assets",
            label="Pipeline step assets",
            status="found",
            detail=f"All {len(relpaths)} step assets are present.",
            identity_detail=f"Use all {len(relpaths)} step assets.",
        )


register_probe(BundledAssetsProbe())
