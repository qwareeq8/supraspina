"""Fake FreeSurfer tools and recon folders for the atlas-labeling tests.

Every value is synthetic; no subject's data is used.

``make_freesurfer`` writes a FreeSurfer home whose layout matches 8.2.0
(build stamp, fspython 3.8 site-packages with a samseg package whose gems
bindings are tagged CPython 3.12, fsaverage templates) and whose programs
are small Python scripts. The fake ``segment_subregions`` reads its inputs
through the shadow folder and writes the real output names; environment
variables steer it: ``FAKE_FS_FAIL`` (exit 3), ``FAKE_FS_SLOW`` (sleep),
and ``FAKE_FS_EVIL`` (a subject ID whose recon ``aseg.mgz`` it appends to
through the shadow symlink, as a misbehaving tool would).
"""

from __future__ import annotations

import os
import struct
import sys
from pathlib import Path

BUILD = "freesurfer-linux-ubuntu24_x86_64-8.2.0-20260314-d932c45"
BRAINSTEM = (
    "Medulla 4500.5\nPons 14000.25\nSCP 190.125\n"
    "Midbrain 5800.75\nWhole_brainstem 24491.625\n"
)
THALAMIC = "Left-LGN 240.5\nRight-LGN 220.25\nLeft-Whole_thalamus 6500.0\n"
RECON_FILES = (
    "mri/norm.mgz",
    "mri/aseg.mgz",
    "mri/wmparc.mgz",
    "mri/aseg.presurf.mgz",
    "surf/lh.sphere.reg",
    "surf/rh.sphere.reg",
    "surf/lh.white",
    "surf/rh.white",
    "surf/lh.pial",
    "surf/rh.pial",
    "surf/lh.thickness",
    "surf/rh.thickness",
    "surf/lh.smoothwm",
    "surf/rh.smoothwm",
    "label/lh.cortex.label",
    "label/rh.cortex.label",
    "stats/aseg.stats",
    "stats/lh.aparc.a2009s.stats",
    "stats/rh.aparc.a2009s.stats",
)

_SEGMENT_SUBREGIONS = """
import argparse, os, sys, time

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("structure")
    for flag in ("--cross", "--sd", "--out-dir", "--temp-dir", "--threads"):
        parser.add_argument(flag)
    args = parser.parse_args()
    subject = os.path.join(args.sd, args.cross)
    for name in ("norm.mgz", "aseg.mgz"):
        with open(os.path.join(subject, "mri", name), "rb") as handle:
            handle.read()
    if os.environ.get("FAKE_FS_EVIL") == args.cross:
        with open(os.path.join(subject, "mri", "aseg.mgz"), "ab") as handle:
            handle.write(b"changed")
    if os.environ.get("FAKE_FS_FAIL"):
        sys.exit(3)
    if os.environ.get("FAKE_FS_SLOW"):
        time.sleep(float(os.environ["FAKE_FS_SLOW"]))
    os.makedirs(args.temp_dir, exist_ok=True)
    out = args.out_dir
    def write(name, text):
        with open(os.path.join(out, name), "w") as handle:
            handle.write(text)
    if args.structure == "brainstem":
        write("brainstemSsLabels.volumes.txt", BRAINSTEM)
        write("brainstemSsLabels.FSvoxelSpace.mgz", "map")
        write("brainstemSsLabels.mgz", "map")
    elif args.structure == "thalamus":
        write("ThalamicNuclei.volumes.txt", THALAMIC)
        write("ThalamicNuclei.FSvoxelSpace.mgz", "map")
    else:
        for hemi in ("lh", "rh"):
            write(f"{hemi}.hippoSfVolumes.txt", "Hippocampal_tail 500.5\\nWhole_hippocampus 3500\\n")
            write(f"{hemi}.amygNucVolumes.txt", "Lateral-nucleus 600\\nWhole_amygdala 1700\\n")
            write(f"{hemi}.hippoAmygLabels.FSvoxelSpace.mgz", "map")

if __name__ == "__main__":
    main()
"""

_STATS = """# Title Cortical Parcellation Statistics
# ColHeaders StructName NumVert SurfArea GrayVol ThickAvg ThickStd MeanCurv GausCurv FoldInd CurvInd
FreeSurfer_Defined_Medial_Wall 9000 5000 1000 0.3 0.8 0.1 0.02 50 6.0
7Networks_1 20000 14000 28000 2.0 0.5 0.1 0.03 200 28.0
7Networks_2 18000 11000 27500 2.25 0.75 0.1 0.02 100 15.0
"""

_PROGRAMS = {
    "mri_surf2surf": """
import struct, sys
args = sys.argv[1:]
with open(args[args.index("--tval") + 1], "wb") as handle:
    handle.write(struct.pack(">i", 1000))
""",
    "mris_anatomical_stats": """
import sys
args = sys.argv[1:]
with open(args[args.index("-f") + 1], "w") as handle:
    handle.write(STATS)
""",
    "mris_ca_label": """
import struct, sys
with open(sys.argv[-1], "wb") as handle:
    handle.write(struct.pack(">i", 10242))
""",
    "mri_segstats": """
import sys
args = sys.argv[1:]
with open(args[args.index("--sum") + 1], "w") as handle:
    handle.write("# ColHeaders Index SegId NVoxels Volume_mm3 StructName\\n")
    handle.write("1 1001 10 120.5 Nucleus_L\\n2 1002 11 110.0 Nucleus_R\\n")
""",
}


def _script(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!{sys.executable}\n{body}", encoding="utf-8")
    path.chmod(0o755)


def make_freesurfer(root: Path, *, own_runtime: bool = False) -> Path:
    """Write a fake FreeSurfer home and return it."""
    home = root / "freesurfer"
    (home / "bin").mkdir(parents=True)
    (home / "build-stamp.txt").write_text(BUILD + "\n", encoding="utf-8")
    samseg = home / "python" / "lib" / "python3.8" / "site-packages" / "samseg"
    (samseg / "cli").mkdir(parents=True)
    (samseg / "gems").mkdir()
    (samseg / "__init__.py").write_text("", encoding="utf-8")
    (samseg / "cli" / "__init__.py").write_text("", encoding="utf-8")
    (samseg / "gems" / "__init__.py").write_text("", encoding="utf-8")
    tag = "38" if own_runtime else "312"
    (samseg / "gems" / f"gemsbindings.cpython-{tag}-x86_64-linux-gnu.so").write_bytes(
        b""
    )
    (samseg / "cli" / "segment_subregions.py").write_text(
        f"BRAINSTEM = {BRAINSTEM!r}\nTHALAMIC = {THALAMIC!r}\n" + _SEGMENT_SUBREGIONS,
        encoding="utf-8",
    )
    for program, body in _PROGRAMS.items():
        _script(home / "bin" / program, f"STATS = {_STATS!r}\n" + body)
    _script(home / "bin" / "fspython", "import sys\nsys.exit(0)\n")
    for template in ("fsaverage", "fsaverage5", "fsaverage6"):
        label = home / "subjects" / template / "label"
        label.mkdir(parents=True)
        for hemi in ("lh", "rh"):
            for name in ("Yeo2011_7Networks_N1000", "Yeo2011_17Networks_N1000"):
                (label / f"{hemi}.{name}.annot").write_bytes(struct.pack(">i", 10))
    (home / "average").mkdir()
    for hemi in ("lh", "rh"):
        name = f"{hemi}.DKTaparc.atlas.acfb40.noaparc.i12.2016-08-02.gcs"
        (home / "average" / name).write_bytes(b"gcs")
    return home


def make_recon(root: Path, subject_id: str) -> Path:
    """Write one subject's recon folder with every recipe input."""
    folder = root / "derivatives" / "freesurfer" / subject_id
    for relpath in RECON_FILES:
        path = folder / relpath
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"{subject_id}:{relpath}".encode())
    (folder / "scripts").mkdir(exist_ok=True)
    return folder


def snapshot(folder: Path) -> dict[str, tuple[int, int]]:
    """Return every file's (size, mtime_ns) under a folder."""
    return {
        os.path.relpath(os.path.join(base, name), folder): (
            os.lstat(os.path.join(base, name)).st_size,
            os.lstat(os.path.join(base, name)).st_mtime_ns,
        )
        for base, _dirs, names in os.walk(folder)
        for name in names
    }
