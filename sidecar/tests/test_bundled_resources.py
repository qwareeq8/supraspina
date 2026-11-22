"""Tests requiring every adapter-referenced active resource to exist on disk.

The tests enumerate every resource path embedded in adapter commands and assert
that each path resolves to a real file in the active packaged-or-acquired
resource set, so a missing or renamed reviewed resource fails here instead of
during a run.
"""

from __future__ import annotations

from pathlib import Path

from supraspina_sidecar import resources

# List every active file referenced by an adapter or its build_command through a
# resource-directory accessor. Keep this list synchronized with the adapters.
_REQUIRED_RESOURCES: tuple[Path, ...] = (
    # Include Step 3 feature extraction and its ROI template.
    resources.features_dir() / "extract_features.py",
    resources.features_dir() / "rois_input_template.txt",
    # Include the Step 5 PyBrainAge predictor.
    resources.pybrainage_dir() / "predict.py",
    # Include the Step 7 Brain-PAD statistics module.
    resources.step7_dir() / "brainpadstats.py",
    # Include the Step 8 structural aggregation module.
    resources.step8_dir() / "aggregate_stats.py",
    # Include the Step 9 base-R analysis and report template.
    resources.step9_dir() / "FreesurferAnalysisScript.R",
    resources.step9_dir() / "FreesurferAnalysisScript.Rmd",
    # Include Step 2.5 outlier QC and the Step 2 ENIGMA compiled wrapper.
    resources.enigma_dir() / "outliers_qc.R",
    resources.enigma_dir() / "compiled" / "enigma_fs_wrapper_script_compiled.sh",
    # Include the SHA-256 manifest that pins acquired ENIGMA assets.
    resources.enigma_dir() / "CHECKSUMS.sha256",
    # Include both figure-style modules because brainpadstats.py imports
    # figstyle.py and outliers_qc.R sources figstyle.R. Include Latin Modern
    # faces for LaTeX-quality type while allowing a default-serif fallback.
    resources.resource_dir("figstyle") / "figstyle.py",
    resources.resource_dir("figstyle") / "figstyle.R",
    resources.resource_dir("fonts") / "lmroman10-regular.otf",
    resources.resource_dir("fonts") / "lmroman10-bold.otf",
    resources.resource_dir("fonts") / "lmroman10-italic.otf",
    resources.resource_dir("fonts") / "lmroman10-bolditalic.otf",
)


def test_every_bundled_resource_exists() -> None:
    missing = [str(path) for path in _REQUIRED_RESOURCES if not path.is_file()]
    assert not missing, f"Bundle these required resources: {missing}."


def test_resource_dirs_are_directories() -> None:
    for resource_dir in (
        resources.features_dir(),
        resources.pybrainage_dir(),
        resources.step7_dir(),
        resources.step8_dir(),
        resources.step9_dir(),
        resources.enigma_dir(),
        resources.resource_dir("figstyle"),
        resources.resource_dir("fonts"),
    ):
        assert resource_dir.is_dir(), f"Provide a directory: {resource_dir}."
