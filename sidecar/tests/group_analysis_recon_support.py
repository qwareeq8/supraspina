"""Write synthetic per-subject recon files for the tier A tests.

The files follow FreeSurfer 8.2.0's formats (``aparc`` tables, ``aseg.stats``
Measure lines with sTIV, ``w-g.pct``, ``wmparc``, SynthSeg, and subregion
``*.volumes.txt``); every value varies with the subject's index so tests can
recompute them.
"""

from __future__ import annotations

from pathlib import Path

APARC_HEADER = (
    "# ColHeaders StructName NumVert SurfArea GrayVol ThickAvg ThickStd MeanCurv "
    "GausCurv FoldInd CurvInd\n"
)
ASEG_HEADER = (
    "# ColHeaders  Index SegId NVoxels Volume_mm3 StructName normMean normStdDev "
    "normMin normMax normRange\n"
)


def thickness(index: int, hemi: str, region: str) -> float:
    """Return the ThickAvg the fixture writes."""
    return round(
        2.0 + 0.01 * index + (0.1 if hemi == "rh" else 0.0) + len(region) / 100, 4
    )


def medulla(index: int) -> float:
    """Return the medulla volume the fixture writes."""
    return 4500.0 + 10.0 * index


def stiv(index: int) -> float:
    """Return the sTIV the fixture writes."""
    return 1_450_000.0 + 1000.0 * index


def synthseg_tiv(index: int) -> float:
    """Return the SynthSeg TIV the fixture writes."""
    return 1_500_000.0 + 1500.0 * (index % 4)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def write_recon(
    derivatives: Path,
    subject_id: str,
    index: int,
    *,
    backend: str = "freesurfer",
    subregions: bool = True,
) -> Path:
    """Write one subject's recon stats and subregion files; return its folder."""
    folder = derivatives / backend / subject_id
    for hemi in ("lh", "rh"):
        rows = "".join(
            f"{region:<30} 1000 700 2000 {thickness(index, hemi, region)} 0.5 0.1 "
            "0.02 10 1.0\n"
            for region in ("S_central", "G_precentral")
        )
        _write(
            folder / "stats" / f"{hemi}.aparc.a2009s.stats",
            APARC_HEADER + "unknown 1 1 1 0 0 0 0 0 0\n" + rows,
        )
        _write(
            folder / "stats" / f"{hemi}.w-g.pct.stats",
            "# ColHeaders  Index SegId NVertices Area_mm2 StructName Mean StdDev "
            "Min Max Range SNR\n"
            f"  1 1024 1629 1075.7 precentral {20 + index + (1 if hemi == 'rh' else 0)} "
            "6.6 -16.9 57.2 74.1 5.0\n",
        )
    _write(
        folder / "stats" / "aseg.stats",
        "# Measure BrainSeg, BrainSegVol, Brain Segmentation Volume, "
        f"{1_200_000 + index}, mm^3\n"
        "# Measure SurfaceHoles, SurfaceHoles, Total number of defect holes, "
        f"{20 + index}, unitless\n"
        "# Measure EstimatedTotalIntraCranialVol, eTIV, Estimated Total "
        f"Intracranial Volume, {1_400_000 + index}, mm^3\n"
        "# Measure SegmentedTotalIntraCranialVol, sTIV, Segmented Total "
        f"Intracranial Volume, {stiv(index)}, mm^3\n"
        + ASEG_HEADER
        + f"  1  16 20000 {21000 + index} Brain-Stem 80 5 40 100 60\n",
    )
    _write(
        folder / "stats" / "brainvol.stats",
        "# Measure Cortex, CortexVol, Total cortical gray matter volume, "
        f"{400_000 + index}, mm^3\n",
    )
    _write(folder / "stats" / "synthseg.tiv.dat", f"{synthseg_tiv(index)}\n")
    _write(
        folder / "stats" / "wmparc.stats",
        ASEG_HEADER
        + f"  1 3024 100 {5000 + index} wm-lh-precentral 100 5 40 120 80\n"
        + f"  2 4024 100 {5100 + index} wm-rh-precentral 100 5 40 120 80\n"
        + f"  3 5001 100 {9000 + index} Left-UnsegmentedWhiteMatter 100 5 40 120 80\n",
    )
    _write(
        folder / "stats" / "synthseg.vol.csv",
        "subject,total intracranial,left thalamus,right thalamus,brain-stem\n"
        f"x,{synthseg_tiv(index)},{7000 + index},{7100 + index},{21000 + index}\n",
    )
    if subregions:
        _write(
            folder / "mri" / "brainstemSsLabels.v13.volumes.txt",
            f"Medulla {medulla(index)}\nPons {15000 + index}\n"
            f"Whole_brainstem {26000 + index}\n",
        )
        # A longer name for a second variant; the shortest name wins.
        _write(
            folder / "mri" / "brainstemSsLabels.v13.FSvoxelSpace.volumes.txt",
            "Medulla 1\n",
        )
        for hemi in ("lh", "rh"):
            _write(
                folder / "mri" / f"{hemi}.hippoSfVolumes-T1.v22.txt",
                f"CA1-body {600 + index}\nWhole_hippocampus {3500 + index}\n",
            )
        _write(
            folder / "mri" / "ThalamicNuclei.v13.T1.volumes.txt",
            f"Left-AV {150 + index}\nRight-AV {160 + index}\n"
            f"Left-Whole_thalamus {7000 + index}\n",
        )
    return folder
