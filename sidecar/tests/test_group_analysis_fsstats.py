"""Tests for the bounded FreeSurfer stats parsers (tier A)."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

from supraspina_sidecar.group_analysis import fsstats
from supraspina_sidecar.group_analysis.spec import GroupAnalysisError

#: An FS 8.2.0-shaped aseg.stats: Measure lines (sTIV included) and a table.
ASEG = """\
# Title Segmentation Statistics
# Measure BrainSeg, BrainSegVol, Brain Segmentation Volume, 1393782.000000, mm^3
# Measure Cortex, CortexVol, Total cortical gray matter volume, 384091.757661, mm^3
# Measure SurfaceHoles, SurfaceHoles, Total number of defect holes in surfaces prior to fixing, 26, unitless
# Measure EstimatedTotalIntraCranialVol, eTIV, Estimated Total Intracranial Volume, 1475770.382023, mm^3
# Measure SegmentedTotalIntraCranialVol, sTIV, Segmented Total Intracranial Volume, 1456243.800000, mm^3
# ColHeaders  Index SegId NVoxels Volume_mm3 StructName normMean normStdDev normMin normMax normRange
  1   4      7016     7403.5  Left-Lateral-Ventricle            38.4679    14.6384    10.0000    89.0000    79.0000
  2  16     20000    21000.0  Brain-Stem                        80.0000     5.0000    40.0000   100.0000    60.0000
"""

APARC = """\
# Measure Cortex, MeanThickness, Mean Thickness, 2.45, mm
# ColHeaders StructName NumVert SurfArea GrayVol ThickAvg ThickStd MeanCurv GausCurv FoldInd CurvInd
G_and_S_frontomargin                     1403    979   2356  2.294 0.599     0.140     0.035       20     2.0
S_central                                 912    634   1334  2.503 0.483     0.110     0.022        5     1.0
"""

WGPCT = """\
# ColHeaders  Index SegId NVertices Area_mm2 StructName Mean StdDev Min Max Range SNR
  1 1000      8949     5581.2  unknown                            0.0000     0.0000     0.0000     0.0000     0.0000       -nan
  2 1002      1629     1075.7  caudalanteriorcingulate           33.5715     6.6967   -16.9260    57.2227    74.1487     5.0131
"""


def _write(path: Path, text: str | bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(text, str):
        path.write_text(text, encoding="utf-8")
    else:
        path.write_bytes(text)
    return path


def test_aseg_stats_carry_measures_and_rows(tmp_path: Path) -> None:
    path = _write(tmp_path / "aseg.stats", ASEG)

    parsed = fsstats.read_stats(str(path))

    assert parsed.sha256 == hashlib.sha256(ASEG.encode()).hexdigest()
    assert parsed.measures["eTIV"] == pytest.approx(1475770.382023)
    assert parsed.measures["sTIV"] == pytest.approx(1456243.8)
    assert parsed.measures["SurfaceHoles"] == 26
    assert parsed.columns[4] == "StructName"
    assert parsed.rows["Brain-Stem"]["Volume_mm3"] == 21000.0
    assert "StructName" not in parsed.rows["Brain-Stem"]


def test_aparc_and_gwc_tables_read_their_metrics(tmp_path: Path) -> None:
    aparc = fsstats.read_stats(str(_write(tmp_path / "lh.a.stats", APARC)))
    wgpct = fsstats.read_stats(str(_write(tmp_path / "lh.w-g.pct.stats", WGPCT)))

    assert aparc.measures == {"MeanThickness": 2.45}
    assert aparc.rows["S_central"]["ThickAvg"] == 2.503
    assert aparc.rows["G_and_S_frontomargin"]["GrayVol"] == 2356
    # FreeSurfer's "-nan" reads as missing.
    assert "SNR" not in wgpct.rows["unknown"]
    assert wgpct.rows["caudalanteriorcingulate"]["Mean"] == pytest.approx(33.5715)


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("  1 2 3 Brain-Stem\n", "rows before its header"),
        ("# ColHeaders Index Volume_mm3\n1 2\n", "no StructName"),
        ("# ColHeaders StructName Volume_mm3\nBrain-Stem\n", "wrong column count"),
    ],
)
def test_a_malformed_table_is_refused(tmp_path: Path, text: str, message: str) -> None:
    with pytest.raises(GroupAnalysisError, match=message):
        fsstats.read_stats(str(_write(tmp_path / "x.stats", text)))


def test_reads_are_bounded_and_never_follow_a_symlink(tmp_path: Path) -> None:
    target = _write(tmp_path / "real.stats", ASEG)
    link = tmp_path / "link.stats"
    os.symlink(target, link)
    with pytest.raises(GroupAnalysisError, match="regular file"):
        fsstats.read_stats(str(link))
    with pytest.raises(GroupAnalysisError, match="does not exist"):
        fsstats.read_stats(str(tmp_path / "absent.stats"))
    big = _write(tmp_path / "big.stats", b"#" * (fsstats.MAX_STATS_BYTES + 1))
    with pytest.raises(GroupAnalysisError, match="within 4 MiB"):
        fsstats.read_stats(str(big))


def test_subregion_volumes_are_name_value_lines(tmp_path: Path) -> None:
    path = _write(
        tmp_path / "brainstemSsLabels.v13.volumes.txt",
        "Medulla 4553.5\nPons\t15432.25\nSCP 250\nMidbrain 6000\nWhole_brainstem 26235.75\n",
    )
    assert fsstats.read_volumes_txt(str(path)) == {
        "Medulla": 4553.5,
        "Pons": 15432.25,
        "SCP": 250.0,
        "Midbrain": 6000.0,
        "Whole_brainstem": 26235.75,
    }
    bad = _write(tmp_path / "bad.txt", "Medulla four\n")
    with pytest.raises(GroupAnalysisError, match="name and a number"):
        fsstats.read_volumes_txt(str(bad))


def test_synthseg_volumes_normalize_names_and_skip_the_tiv(tmp_path: Path) -> None:
    path = _write(
        tmp_path / "synthseg.vol.csv",
        "subject,total intracranial,left cerebral white matter,brain-stem,"
        "3rd ventricle,right thalamus\n"
        "/x/norm.mgz,1500000,250000.5,21000,1200,7000\n",
    )
    assert fsstats.read_synthseg_volumes(str(path)) == {
        "Left-cerebral-white-matter": 250000.5,
        "brain-stem": 21000.0,
        "3rd-ventricle": 1200.0,
        "Right-thalamus": 7000.0,
    }
    header_only = _write(tmp_path / "empty.csv", "subject,total intracranial\n")
    with pytest.raises(GroupAnalysisError, match="no data row"):
        fsstats.read_synthseg_volumes(str(header_only))


def test_the_synthseg_tiv_is_one_number(tmp_path: Path) -> None:
    assert fsstats.read_tiv_dat(str(_write(tmp_path / "t.dat", "1502345.5\n"))) == (
        1502345.5
    )
    with pytest.raises(GroupAnalysisError, match="one number"):
        fsstats.read_tiv_dat(str(_write(tmp_path / "two.dat", "1 2\n")))
