"""The external atlas sources and their machine-level cache (``ATLAS_SOURCES``).

Nothing is bundled. Each source names its official page, license, and
citation; a source that serves stable files without a login may list exact
download URLs with pinned SHA-256 digests and sizes, which main fetches into
``<userData>/atlases/<sourceId>/<version>/`` with a ``manifest.json``
(schema ``supraspina/atlas-source-cache``: files with URL, SHA-256, and size;
the license and when the operator acknowledged it; when the files arrived;
``downloaded`` or ``imported``). The cache is shared by projects; an
analysis records the atlas ID, version, and file digests. None of this
touches the managed scientific resources, their pins, the environment
check, or receipts.

Schaefer 2018 pins CBIG's MIT license and its fsaverage annotations (100,
200, and 400 parcels in 7 and 17 networks) at commit 35b5664, labeled with
``user-annot`` since the gcs files are served only from a Dropbox archive.
The other sources were verified on 2026-09-30 and pin nothing: Brainnetome
(NITRC) and Brainstem Navigator grant no redistribution; the Harvard AAN v2
(CC0 on Dryad) and JHU (with FSL) atlases are in MNI space, which waits for
v3. A downloaded source's atlases are labeled from the files main verified
into the machine cache; the labeling manager checks their digests again
before it labels.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

#: The schema of a cache manifest.
CACHE_SCHEMA = "supraspina/atlas-source-cache"
#: The manifest file name inside a source version folder.
MANIFEST_NAME = "manifest.json"
_SOURCE_ID = re.compile(r"[a-z][a-z0-9-]{1,63}")
_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


@dataclass(frozen=True)
class SourceFile:
    """Hold one pinned download."""

    url: str
    sha256: str
    bytes: int
    relpath: str


@dataclass(frozen=True)
class AtlasSource:
    """Hold one external atlas source (``AtlasSource``)."""

    source_id: str
    label: str
    kind: str
    site: str
    page_url: str
    license_name: str
    license_url: str
    citation: str
    version: str
    files: tuple[SourceFile, ...]
    requires_login: bool
    #: The atlases the pinned files provide once downloaded (``atlasIds``).
    atlas_ids: tuple[str, ...]
    hemisphere_rules: tuple[str, ...]
    recipe_id: str | None


_CBIG = "https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6"
_SCHAEFER_LABELS = (
    f"{_CBIG}/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/"
    "Parcellations/FreeSurfer5.3/fsaverage/label"
)
#: The pinned Schaefer 2018 files (CBIG at commit 35b5664, 2026-08-31).
_SCHAEFER_FILES = (
    SourceFile(
        f"{_CBIG}/LICENSE.md",
        "0e38f0e8b304f13de2ce2911320faaa08ced178e031d3bbebc3e4769762e5f50",
        1084,
        "LICENSE.md",
    ),
    SourceFile(
        f"{_SCHAEFER_LABELS}/lh.Schaefer2018_100Parcels_7Networks_order.annot",
        "4c648453ee3de1041be3bc28d39621a6edc13a2ec046e493a765821ed3ab5052",
        1313376,
        "fsaverage/label/lh.Schaefer2018_100Parcels_7Networks_order.annot",
    ),
    SourceFile(
        f"{_SCHAEFER_LABELS}/rh.Schaefer2018_100Parcels_7Networks_order.annot",
        "0cedc865047580df56e46186dc6416d8cf431cae104a1666ec8dc3efa761fb3c",
        1313371,
        "fsaverage/label/rh.Schaefer2018_100Parcels_7Networks_order.annot",
    ),
    SourceFile(
        f"{_SCHAEFER_LABELS}/lh.Schaefer2018_100Parcels_17Networks_order.annot",
        "cc92db8dee0091ea3d19c265ca0e4387982f4d78e82ec9a1b227ee829d4c8fcc",
        1313574,
        "fsaverage/label/lh.Schaefer2018_100Parcels_17Networks_order.annot",
    ),
    SourceFile(
        f"{_SCHAEFER_LABELS}/rh.Schaefer2018_100Parcels_17Networks_order.annot",
        "dfb63fc3244ba56b9609d4854a41e8cdd165c168b93b69ac2a60a0e7c4890f82",
        1313537,
        "fsaverage/label/rh.Schaefer2018_100Parcels_17Networks_order.annot",
    ),
    SourceFile(
        f"{_SCHAEFER_LABELS}/lh.Schaefer2018_200Parcels_7Networks_order.annot",
        "c225937c31584c74d3e7c8fba7c17916ce4e730faa542ee61659041db136ac87",
        1315895,
        "fsaverage/label/lh.Schaefer2018_200Parcels_7Networks_order.annot",
    ),
    SourceFile(
        f"{_SCHAEFER_LABELS}/rh.Schaefer2018_200Parcels_7Networks_order.annot",
        "5439cd1fb913cbb76366f9590b5733efcb7adf9cde25413f6e0b681ff0abdcf8",
        1315902,
        "fsaverage/label/rh.Schaefer2018_200Parcels_7Networks_order.annot",
    ),
    SourceFile(
        f"{_SCHAEFER_LABELS}/lh.Schaefer2018_200Parcels_17Networks_order.annot",
        "7b83bd37b30ced55bacf21aa837404bca453fa6f1b2fa4b2d1d3cf185c4950db",
        1316234,
        "fsaverage/label/lh.Schaefer2018_200Parcels_17Networks_order.annot",
    ),
    SourceFile(
        f"{_SCHAEFER_LABELS}/rh.Schaefer2018_200Parcels_17Networks_order.annot",
        "70a78d74b1be6110e0d272b8c82c08f284633f0f003148c743b480a7bf13f7f5",
        1316210,
        "fsaverage/label/rh.Schaefer2018_200Parcels_17Networks_order.annot",
    ),
    SourceFile(
        f"{_SCHAEFER_LABELS}/lh.Schaefer2018_400Parcels_7Networks_order.annot",
        "351848da486c2b178ef825640c076fcbcf054095bed0c91d5854d2c593e5c1ee",
        1320939,
        "fsaverage/label/lh.Schaefer2018_400Parcels_7Networks_order.annot",
    ),
    SourceFile(
        f"{_SCHAEFER_LABELS}/rh.Schaefer2018_400Parcels_7Networks_order.annot",
        "595444aecc3b59a8a6838b2e5c7f2052e88e25b1c5f833c5a6bdb984e3fa978f",
        1321004,
        "fsaverage/label/rh.Schaefer2018_400Parcels_7Networks_order.annot",
    ),
    SourceFile(
        f"{_SCHAEFER_LABELS}/lh.Schaefer2018_400Parcels_17Networks_order.annot",
        "4121084967a6fb51bafe4ee1dd0e79aabfad90b20424866a6b46069efc1f2d51",
        1321612,
        "fsaverage/label/lh.Schaefer2018_400Parcels_17Networks_order.annot",
    ),
    SourceFile(
        f"{_SCHAEFER_LABELS}/rh.Schaefer2018_400Parcels_17Networks_order.annot",
        "515c9de716435fcedf7062c8116fb4e039e74b21a37191fa715d6c7712b62dad",
        1321589,
        "fsaverage/label/rh.Schaefer2018_400Parcels_17Networks_order.annot",
    ),
)

#: The sources, mirrored by ``ATLAS_SOURCES`` in ``src/shared/atlas-labeling.ts``.
SOURCES: dict[str, AtlasSource] = {
    source.source_id: source
    for source in (
        AtlasSource(
            "schaefer2018",
            "Schaefer 2018 cortical parcellations",
            "surface",
            "GitHub (CBIG)",
            "https://github.com/ThomasYeoLab/CBIG/tree/master/stable_projects/"
            "brain_parcellation/Schaefer2018_LocalGlobal",
            "MIT",
            "https://github.com/ThomasYeoLab/CBIG/blob/master/LICENSE.md",
            "Schaefer A, et al. Local-global parcellation of the human cerebral "
            "cortex from intrinsic functional connectivity MRI. Cereb Cortex. "
            "2018;28(9):3095-3114.",
            "cbig-35b5664",
            _SCHAEFER_FILES,
            False,
            tuple(
                f"schaefer{parcels}-{networks}"
                for parcels in (100, 200, 400)
                for networks in (7, 17)
            ),
            ("lh-rh-underscore-infix",),
            "user-annot",
        ),
        AtlasSource(
            "brainnetome",
            "Brainnetome atlas",
            "surface",
            "NITRC",
            "https://www.nitrc.org/projects/bn_atlas/",
            "Brainnetome terms: non-commercial, attribution, share alike",
            "https://www.nitrc.org/projects/bn_atlas/",
            "Fan L, Li H, Zhuo J, et al. The human Brainnetome atlas: a new brain "
            "atlas based on connectional architecture. Cereb Cortex. "
            "2016;26(8):3508-3526.",
            "nitrc",
            (),
            True,
            (),
            ("l-r-underscore-suffix",),
            "user-gcs",
        ),
        AtlasSource(
            "brainstem-navigator",
            "Brainstem Navigator",
            "volume",
            "NITRC",
            "https://www.nitrc.org/projects/brainstemnavig/",
            "Not stated on the project page",
            "https://www.nitrc.org/projects/brainstemnavig/",
            "Bianciardi M, et al. Brainstem Navigator v1.0. NITRC. "
            "doi:10.25790/bml0cm.96. See the project page for the atlas papers "
            "to cite.",
            "1.0",
            (),
            True,
            (),
            ("l-r-underscore-suffix",),
            "user-volume",
        ),
        AtlasSource(
            "harvard-aan",
            "Harvard Ascending Arousal Network atlas v2",
            "volume",
            "Dryad",
            "https://datadryad.org/dataset/doi:10.5061/dryad.zw3r228d2",
            "CC0 1.0 (Dryad terms)",
            "https://creativecommons.org/publicdomain/zero/1.0/",
            "Edlow BL, et al. Sustaining wakefulness: brainstem connectivity in "
            "human consciousness. bioRxiv. 2023. doi:10.1101/2023.07.13.548265.",
            "2.0",
            (),
            False,
            (),
            ("left-right-prefix",),
            "user-volume",
        ),
        AtlasSource(
            "jhu",
            "JHU white-matter atlases (with FSL)",
            "volume",
            "FSL",
            "https://fsl.fmrib.ox.ac.uk/fsl/docs/other/datasets.html",
            "FSL license (non-commercial)",
            "https://fsl.fmrib.ox.ac.uk/fsl/docs/license.html",
            "Mori S, et al. MRI Atlas of Human White Matter. Elsevier; 2005. "
            "Wakana S, et al. NeuroImage. 2007;36:630-644. Hua K, et al. "
            "NeuroImage. 2008;39(1):336-347.",
            "fsl",
            (),
            False,
            (),
            ("left-right-prefix",),
            "user-volume",
        ),
    )
}


_SCHAEFER_ID = re.compile(r"schaefer(\d+)-(\d+)")


def atlas_files(source: AtlasSource, atlas_id: str) -> tuple[str, ...]:
    """Return the cache relpaths of one atlas a source provides (lh, rh).

    Parameters
    ----------
    atlas_id
        One of the source's ``atlas_ids``.

    Returns
    -------
    tuple of str
        The ``lh`` and ``rh`` files, or empty for an unknown atlas.
    """
    match = _SCHAEFER_ID.fullmatch(atlas_id)
    if atlas_id not in source.atlas_ids or match is None:
        return ()
    token = f"_{match.group(1)}Parcels_{match.group(2)}Networks_"
    return tuple(sorted(item.relpath for item in source.files if token in item.relpath))


def atlas_label(source: AtlasSource, atlas_id: str) -> str:
    """Name one atlas a source provides (``Schaefer 2018, 400 parcels, 7 networks``)."""
    match = _SCHAEFER_ID.fullmatch(atlas_id)
    if match is None:
        return f"{source.label} ({atlas_id})"
    return f"Schaefer 2018, {match.group(1)} parcels, {match.group(2)} networks"


def cache_dir(cache_root: str, source_id: str, version: str) -> str:
    """Return one source version's cache folder.

    Parameters
    ----------
    cache_root
        The machine-level cache root main sends (``<userData>/atlases``).

    Returns
    -------
    str
        ``<cache_root>/<sourceId>/<version>``.

    Raises
    ------
    ValueError
        When the source ID or version breaks the folder-name grammar.
    """
    if not _SOURCE_ID.fullmatch(source_id) or not _VERSION.fullmatch(version):
        raise ValueError("Use a valid atlas source ID and version.")
    return os.path.join(cache_root, source_id, version)
