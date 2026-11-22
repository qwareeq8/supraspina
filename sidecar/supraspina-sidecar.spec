# -*- mode: python ; coding: utf-8 -*-
"""Build the frozen Supraspina sidecar from reviewed, target-local inputs."""

import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

staging_value = os.environ.get("SUPRASPINA_PYINSTALLER_STAGING", "")
if not staging_value:
    raise SystemExit("Set SUPRASPINA_PYINSTALLER_STAGING before building the sidecar.")

staging_dir = Path(staging_value).resolve(strict=True)
resources_dir = staging_dir / "resources"
metadata_dir = staging_dir / "metadata"
locks_dir = (
    Path(SPECPATH).resolve(strict=True) / "supraspina_sidecar" / "pybrainage_locks"
)
braincharts_locks_dir = (
    Path(SPECPATH).resolve(strict=True) / "supraspina_sidecar" / "braincharts_locks"
)
if not resources_dir.is_dir() or not metadata_dir.is_dir():
    raise SystemExit(
        "Stage the reviewed sidecar resources and metadata before building."
    )
if not locks_dir.is_dir():
    raise SystemExit("Restore the reviewed PyBrainAge lock directory before building.")
if not braincharts_locks_dir.is_dir():
    raise SystemExit("Restore the reviewed BrainCharts lock directory before building.")

sidecar_dir = Path(SPECPATH).resolve(strict=True)

# The frozen sidecar carries bytecode only; record each module source's digest
# for code that binds its own bytes, such as the unit-reuse method digest.
sys.path.insert(0, str(sidecar_dir))
from supraspina_sidecar.source_digests import (  # noqa: E402
    SOURCE_DIGESTS_FILE,
    write_source_digests,
)

write_source_digests(
    sidecar_dir / "supraspina_sidecar", metadata_dir / SOURCE_DIGESTS_FILE
)

datas = [
    (str(resources_dir), "resources"),
    (str(metadata_dir), "metadata"),
    (str(locks_dir), "pybrainage-locks"),
    (str(braincharts_locks_dir), "braincharts-locks"),
]
binaries = []
hiddenimports = collect_submodules("supraspina_sidecar")
for package_name in ("numpy", "openpyxl", "pydantic"):
    package_datas, package_binaries, package_imports = collect_all(package_name)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_imports

analysis = Analysis(
    [str(sidecar_dir / "pyinstaller_entry.py")],
    pathex=[str(sidecar_dir)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(analysis.pure)

executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="supraspina-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    contents_directory="supraspina-runtime",
)
bundle = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="supraspina-sidecar",
)
