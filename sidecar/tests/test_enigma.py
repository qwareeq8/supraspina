"""Tests for the ENIGMA QC adapter (pipeline step ``enigma``)."""

from __future__ import annotations

import copy
import hashlib
import os
import shutil
import struct
import subprocess
import zlib
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import resources
from supraspina_sidecar.adapters import enigma as enigma_module
from supraspina_sidecar.adapters import tools
from supraspina_sidecar.adapters.enigma import EnigmaAdapter
from supraspina_sidecar.provenance import detector_evidence, evidence_identity
from tests.test_schema import default_config

#: Override the ENIGMA asset directory with a deterministic resolved path.
#: Keep previews deterministic regardless of the active resource location.
ENIGMA_DIR = "/opt/supraspina/enigma_assets"


def enigma_config(out_dir: str, *, backend: str = "mcr") -> dict[str, Any]:
    """Return a config with a resolved QC output dir and an enigma override."""
    cfg = copy.deepcopy(default_config())
    # Pin concrete absolute paths so the resolved argv is deterministic.
    cfg["paths"]["derivativesDir"] = "/data/derivatives"
    cfg["paths"]["qcOutputDir"] = out_dir
    cfg["tools"]["mcrRoot"] = "/opt/MCR/v97"
    cfg["tools"]["matlabExecutable"] = "/opt/MATLAB/R2023a/bin/matlab"
    cfg["steps"]["enigma"] = {
        "enabled": True,
        "params": {
            "backend": backend,
            "mcrRoot": "/opt/MCR/v97",
            "matlabExecutable": "/opt/MATLAB/R2023a/bin/matlab",
            "enigmaScriptDir": ENIGMA_DIR,
            "outDir": out_dir,
            "fsVersion": "7",
        },
    }
    return cfg


@pytest.fixture(autouse=True)
def _no_display(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force the no-xvfb branch so the argv is deterministic across hosts."""
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setattr(tools, "which", lambda _name: None)
    monkeypatch.setattr(enigma_module, "_host_is_wsl", lambda: False)


def test_param_schema_keys() -> None:
    schema = EnigmaAdapter().param_schema()
    assert set(schema) == {
        "backend",
        "matlabExecutable",
        "mcrRoot",
        "enigmaScriptDir",
        "outDir",
        "fsVersion",
    }
    assert schema["backend"]["default"] == "auto"
    assert schema["backend"]["options"] == ["auto", "matlab", "mcr"]
    assert schema["fsVersion"]["default"] == "7"
    assert schema["fsVersion"]["options"] == ["5", "6", "7", "8"]
    assert schema["backend"]["label"] == "Configured QC backend"
    assert schema["mcrRoot"]["label"] == (
        "MATLAB Runtime root (mcr backend, R2019b/v9.7)"
    )


def test_adapter_identity() -> None:
    adapter = EnigmaAdapter()
    assert adapter.key == "enigma"
    assert adapter.advances == ("qcsub", "qcic", "qcec")


def test_build_command_mcr_argv(tmp_path: Path) -> None:
    out_dir = str(tmp_path / "qc_review")
    cfg = enigma_config(out_dir, backend="mcr")
    step2 = ENIGMA_DIR

    argv = EnigmaAdapter().build_command(cfg, "sub-01")

    assert argv == [
        "bash",
        f"{step2}/compiled/enigma_fs_wrapper_script_compiled.sh",
        "--subjects",
        f"{out_dir}/subjects.txt",
        "--fsdir",
        "/data/derivatives/freesurfer",
        "--outdir",
        out_dir,
        "--script",
        f"{step2}/compiled",
        "--mcrdir",
        "/opt/MCR/v97",
        "--fs_version",
        "7",
        "--step_1",
        "true",
        "--step_2",
        "true",
        "--step_3",
        "true",
        "--step_4",
        "true",
        "--step_5",
        "true",
    ]


def test_build_command_matlab_backend(tmp_path: Path) -> None:
    out_dir = str(tmp_path / "qc_review")
    cfg = enigma_config(out_dir, backend="matlab")

    argv = EnigmaAdapter().build_command(cfg, None)

    assert argv[0] == "bash"
    assert argv[1] == f"{ENIGMA_DIR}/enigma_fs_wrapper_script.sh"
    assert "--matlab" in argv
    assert argv[argv.index("--matlab") + 1] == "/opt/MATLAB/R2023a/bin/matlab"
    assert "--mcrdir" not in argv
    assert argv[argv.index("--script") + 1] == f"{ENIGMA_DIR}/ENIGMA_QC"


def test_matlab_backend_falls_back_to_path_when_unset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Resolve MATLAB from PATH when matlabExecutable is not configured.
    out_dir = str(tmp_path / "qc_review")
    cfg = enigma_config(out_dir, backend="matlab")
    cfg["tools"]["matlabExecutable"] = "/global/matlab-must-not-win"
    cfg["steps"]["enigma"]["params"]["matlabExecutable"] = ""
    monkeypatch.setattr(
        tools,
        "which",
        lambda name: "/usr/local/bin/matlab" if name == "matlab" else None,
    )

    argv = EnigmaAdapter().build_command(cfg, None)

    assert argv[argv.index("--matlab") + 1] == "/usr/local/bin/matlab"
    assert "--mcrdir" not in argv


def test_auto_backend_builds_the_runtime_command_from_a_conventional_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A host with only the Runtime installed by the one-liner runs the compiled
    # route with no backend or root configured.
    out_dir = str(tmp_path / "qc_review")
    cfg = enigma_config(out_dir, backend="auto")
    cfg["steps"]["enigma"]["params"]["matlabExecutable"] = ""
    cfg["steps"]["enigma"]["params"]["mcrRoot"] = ""
    root = "/usr/local/MATLAB/v97"
    library = f"{root}/runtime/glnxa64/libmwmclmcrrt.so.9.7"
    monkeypatch.setattr(tools, "which", lambda _name: None)
    monkeypatch.setattr(
        tools,
        "exists",
        lambda path: path in {root, library} or os.path.exists(path),
    )

    adapter = EnigmaAdapter()
    assert "mcr" in adapter.required_check_ids(cfg)
    assert "matlab" not in adapter.required_check_ids(cfg)
    argv = adapter.build_command(cfg, None)

    assert argv[1].endswith("enigma_fs_wrapper_script_compiled.sh")
    assert argv[argv.index("--mcrdir") + 1] == root
    assert "--matlab" not in argv


def test_unsupported_backend_refuses_to_build_command(tmp_path: Path) -> None:
    out_dir = str(tmp_path / "qc_review")
    cfg = enigma_config(out_dir, backend="python")

    with pytest.raises(ValueError, match=r"Choose MATLAB or MCR"):
        EnigmaAdapter().build_command(cfg, None)


def test_build_command_default_uses_bundled_assets(tmp_path: Path) -> None:
    # Resolve active reviewed assets without an enigmaScriptDir override or an
    # external checkout.
    out_dir = str(tmp_path / "qc_review")
    cfg = enigma_config(out_dir, backend="mcr")
    cfg["steps"]["enigma"]["params"]["enigmaScriptDir"] = ""

    argv = EnigmaAdapter().build_command(cfg, "sub-01")

    bundled = str(resources.enigma_dir())
    assert argv[1] == f"{bundled}/compiled/enigma_fs_wrapper_script_compiled.sh"
    assert argv[argv.index("--script") + 1] == f"{bundled}/compiled"


def test_build_command_unset_mcr_does_not_crash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Hide any runtime installed on the host, which discovery would select.
    monkeypatch.delenv("MCR_ROOT", raising=False)
    monkeypatch.setattr(tools, "exists", lambda _path: False)
    out_dir = str(tmp_path / "qc_review")
    cfg = enigma_config(out_dir, backend="mcr")
    cfg["steps"]["enigma"]["params"]["mcrRoot"] = ""

    argv = EnigmaAdapter().build_command(cfg, None)

    assert "--mcrdir" in argv
    assert argv[argv.index("--mcrdir") + 1] == ""


def test_build_command_xvfb_wrap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out_dir = str(tmp_path / "qc_review")
    cfg = enigma_config(out_dir, backend="mcr")
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setattr(tools, "which", lambda name: "/usr/bin/xvfb-run")

    argv = EnigmaAdapter().build_command(cfg, None)

    assert argv[:3] == ["xvfb-run", "-a", "bash"]


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    """Return one PNG chunk with its correct CRC."""
    checksum = zlib.crc32(kind)
    checksum = zlib.crc32(payload, checksum) & 0xFFFFFFFF
    return (
        struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)
    )


def _minimal_png(marker: int = 0) -> bytes:
    """Return a tiny structurally complete PNG fixture."""

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(bytes([0, marker, 0, 0])))
        + _png_chunk(b"IEND", b"")
    )


def _gallery_references(name: str, subject: str) -> tuple[list[str], list[str]]:
    """Return the wrapper's expected image sources and links for one subject."""
    if name == "subcortical":
        sources: list[str] = []
        links: list[str] = []
        for axis in ("Axial", "Coronal", "Sagittal"):
            for percent in ("20", "40", "60", "80"):
                prefix = f"{subject}/Subcortical_set_{axis}"
                sources.append(f"{prefix}_70_{percent}.png")
                links.append(f"{prefix}_{percent}.png")
        return sources, links
    if name == "internal":
        sources = []
        links = []
        for axis in ("Axial", "Coronal"):
            for percent in ("10", "20", "40", "50", "60", "80", "85", "90"):
                prefix = f"{subject}/Cortical_set_{axis}"
                sources.append(f"{prefix}_70_{percent}.png")
                links.append(f"{prefix}_{percent}.png")
        return sources, links
    files = [
        f"{subject}.{hemisphere}.{view}.png"
        for hemisphere in ("lh", "rh")
        for view in ("lat", "med")
    ]
    return files, files


def _make_galleries(
    out_dir: Path,
    which: tuple[str, ...],
    *,
    subjects: tuple[str, ...] = ("sub-01",),
) -> None:
    """Create complete wrapper-style QC galleries and referenced PNGs."""
    galleries = {
        "subcortical": ("qc/subcortical", "ENIGMA_Subcortical_QC.html"),
        "internal": ("qc/cortical_internal", "ENIGMA_Cortical_QC.html"),
        "external": ("qc/cortical_external", "ENIGMA_External_QC.html"),
    }
    for name in which:
        subdir, filename = galleries[name]
        target = out_dir / subdir / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        tags: list[str] = []
        for subject in subjects:
            sources, links = _gallery_references(name, subject)
            for relative in sorted(set(sources + links)):
                image = target.parent / relative
                image.parent.mkdir(parents=True, exist_ok=True)
                image.write_bytes(_minimal_png())
            tags.extend(f'<img src="{relative}">' for relative in sources)
            tags.extend(f'<a href="file:{relative}"></a>' for relative in links)
        target.write_text("<html><body>" + "".join(tags) + "</body></html>")


def _write_subjects(out_dir: Path, subjects: tuple[str, ...]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "subjects.txt").write_text("".join(f"{value}\n" for value in subjects))


def _make_measures(out_dir: Path, *, subjects: tuple[str, ...] = ("sub-01",)) -> None:
    measures = out_dir / "measures"
    measures.mkdir(parents=True, exist_ok=True)
    for name in (
        "LandRvolumes.csv",
        "CorticalMeasuresENIGMA_ThickAvg.csv",
        "CorticalMeasuresENIGMA_SurfAvg.csv",
    ):
        rows = "".join(f"{subject},1\n" for subject in subjects)
        (measures / name).write_text("SubjID,value\n" + rows)
    _write_subjects(out_dir, subjects)


def test_detect_pending_when_no_artifacts(tmp_path: Path) -> None:
    cfg = enigma_config(str(tmp_path / "qc_review"))
    status = EnigmaAdapter().detect(cfg, None)
    assert status.state == "pending"
    assert status.artifacts == []


def test_detect_done_when_all_galleries_present(tmp_path: Path) -> None:
    out_dir = tmp_path / "qc_review"
    _make_galleries(out_dir, ("subcortical", "internal", "external"))
    _make_measures(out_dir)
    cfg = enigma_config(str(out_dir))

    status = EnigmaAdapter().detect(cfg, None)

    assert status.state == "done"
    assert len(status.artifacts) == 6
    assert status.content_identity is not None
    assert status.content_identity["fileCount"] == 60


def test_detect_partial_with_measures_only(tmp_path: Path) -> None:
    out_dir = tmp_path / "qc_review"
    measures = out_dir / "measures"
    measures.mkdir(parents=True)
    (measures / "LandRvolumes.csv").write_text("SubjID,ICV\nsub-01,1.0\n")
    cfg = enigma_config(str(out_dir))

    status = EnigmaAdapter().detect(cfg, None)

    assert status.state == "partial"
    assert any(a.endswith("LandRvolumes.csv") for a in status.artifacts)


def test_detect_partial_with_one_gallery(tmp_path: Path) -> None:
    out_dir = tmp_path / "qc_review"
    _make_galleries(out_dir, ("subcortical",))
    cfg = enigma_config(str(out_dir))

    status = EnigmaAdapter().detect(cfg, None)

    assert status.state == "partial"


def test_detect_partial_when_measure_subject_membership_differs(tmp_path: Path) -> None:
    out_dir = tmp_path / "qc_review"
    subjects = ("sub-01", "sub-02")
    _make_measures(out_dir, subjects=subjects)
    _make_galleries(
        out_dir,
        ("subcortical", "internal", "external"),
        subjects=subjects,
    )
    thick = out_dir / "measures" / "CorticalMeasuresENIGMA_ThickAvg.csv"
    thick.write_text("SubjID,value\nsub-01,1\nsub-extra,1\n")

    status = EnigmaAdapter().detect(enigma_config(str(out_dir)), None)

    assert status.state == "partial"
    assert "membership" in status.detail


def test_detect_partial_when_gallery_reference_is_missing(tmp_path: Path) -> None:
    out_dir = tmp_path / "qc_review"
    _make_measures(out_dir)
    _make_galleries(out_dir, ("subcortical", "internal", "external"))
    gallery = out_dir / "qc" / "cortical_external" / "ENIGMA_External_QC.html"
    gallery.write_text(gallery.read_text().replace('<img src="sub-01.lh.lat.png">', ""))

    status = EnigmaAdapter().detect(enigma_config(str(out_dir)), None)

    assert status.state == "partial"
    assert isinstance(status.detail, str)
    assert "references" in status.detail


def test_detect_partial_when_referenced_png_is_missing(tmp_path: Path) -> None:
    out_dir = tmp_path / "qc_review"
    _make_measures(out_dir)
    _make_galleries(out_dir, ("subcortical", "internal", "external"))
    missing = (
        out_dir / "qc" / "subcortical" / "sub-01" / "Subcortical_set_Axial_70_20.png"
    )
    missing.unlink()

    status = EnigmaAdapter().detect(enigma_config(str(out_dir)), None)

    assert status.state == "partial"
    assert isinstance(status.detail, str)
    assert "image" in status.detail


def test_detect_rejects_zero_exit_wrapper_galleries_without_images(
    tmp_path: Path,
) -> None:
    """Prevent a retained wrapper's zero exit from hiding failed MATLAB children."""
    bash = shutil.which("bash")
    if bash is None:  # pragma: no cover - bash is present on supported Linux.
        pytest.skip(
            "Run this test only where Bash can execute the retained ENIGMA wrapper."
        )
    out_dir = tmp_path / "qc_review"
    _make_measures(out_dir)
    empty_launchers = tmp_path / "compiled"
    empty_launchers.mkdir()
    wrapper = (
        resources.enigma_dir() / "compiled" / "enigma_fs_wrapper_script_compiled.sh"
    )
    proc = subprocess.run(  # noqa: S603 - Run the reviewed wrapper with fixed test paths.
        [
            bash,
            str(wrapper),
            "--subjects",
            str(out_dir / "subjects.txt"),
            "--fsdir",
            str(tmp_path / "freesurfer"),
            "--outdir",
            str(out_dir),
            "--script",
            str(empty_launchers),
            "--mcrdir",
            str(tmp_path / "mcr"),
            "--fs_version",
            "8",
            "--step_1",
            "false",
            "--step_2",
            "false",
            "--step_3",
            "true",
            "--step_4",
            "true",
            "--step_5",
            "true",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    status = EnigmaAdapter().detect(enigma_config(str(out_dir)), None)

    assert proc.returncode == 0
    assert status.state == "partial"
    assert isinstance(status.detail, str)
    assert "image" in status.detail


def test_detect_partial_when_referenced_png_is_corrupt(tmp_path: Path) -> None:
    out_dir = tmp_path / "qc_review"
    _make_measures(out_dir)
    _make_galleries(out_dir, ("subcortical", "internal", "external"))
    corrupt = out_dir / "qc" / "cortical_external" / "sub-01.rh.med.png"
    corrupt.write_bytes(b"not a PNG")

    status = EnigmaAdapter().detect(enigma_config(str(out_dir)), None)

    assert status.state == "partial"
    assert isinstance(status.detail, str)
    assert "image" in status.detail


@pytest.mark.parametrize("damage", ["crc", "truncated", "missing-idat"])
def test_detect_partial_when_png_container_contract_is_invalid(
    tmp_path: Path,
    damage: str,
) -> None:
    out_dir = tmp_path / "qc_review"
    _make_measures(out_dir)
    _make_galleries(out_dir, ("subcortical", "internal", "external"))
    target = out_dir / "qc" / "cortical_external" / "sub-01.rh.med.png"
    valid = _minimal_png()
    if damage == "crc":
        broken = valid[:-1] + bytes([valid[-1] ^ 0x01])
    elif damage == "truncated":
        broken = valid[:-1]
    else:
        ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
        broken = (
            b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IEND", b"")
        )
    target.write_bytes(broken)

    status = EnigmaAdapter().detect(enigma_config(str(out_dir)), None)

    assert status.state == "partial"
    assert isinstance(status.detail, str)
    assert "image" in status.detail


def test_detect_gallery_content_identity_changes_with_valid_png_bytes(
    tmp_path: Path,
) -> None:
    out_dir = tmp_path / "qc_review"
    _make_measures(out_dir)
    _make_galleries(out_dir, ("subcortical", "internal", "external"))
    cfg = enigma_config(str(out_dir))
    adapter = EnigmaAdapter()
    before = detector_evidence(adapter, cfg, None)
    changed = out_dir / "qc" / "cortical_external" / "sub-01.rh.med.png"
    changed.write_bytes(_minimal_png(marker=1))

    after = detector_evidence(adapter, cfg, None)

    assert before["state"] == after["state"] == "done"
    assert before["contentIdentity"] != after["contentIdentity"]
    assert evidence_identity(before) != evidence_identity(after)


def test_parse_failure_classifies_signatures() -> None:
    adapter = EnigmaAdapter()
    assert adapter.parse_failure(0, "", "") is None

    mcr = adapter.parse_failure(
        1, "", "error while loading shared libraries: libmwmclmcrrt.so.9.14"
    )
    assert mcr is not None
    assert mcr.tag == "mcr_missing"

    display = adapter.parse_failure(1, "", "cannot open display: :0 (OpenGL)")
    assert display is not None
    assert display.tag == "display_missing"

    missing = adapter.parse_failure(1, "", "cat: aseg.stats: No such file or directory")
    assert missing is not None
    assert missing.tag == "missing_input"

    generic = adapter.parse_failure(1, "", "something else went wrong")
    assert generic is not None
    assert generic.tag == "nonzero_exit"


def _env(*found: str) -> dict[str, Any]:
    return {
        "groups": [
            {
                "checks": [
                    {"id": check_id, "label": check_id, "status": "found"}
                    for check_id in found
                ]
            }
        ]
    }


def _base_required(backend: str) -> tuple[str, ...]:
    return (
        "bash",
        "awk",
        "grep",
        "cat",
        "mkdir",
        backend,
        "enigma_assets",
        "xvfb-run",
    )


def test_validate_passes_when_selected_backend_is_viable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = enigma_config(str(tmp_path / "qc_review"), backend="mcr")
    result = EnigmaAdapter().validate(cfg, _env(*_base_required("mcr")))
    assert result.blocking == []


def test_validate_blocks_an_fsversion_that_differs_from_the_installed_major(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = enigma_config(str(tmp_path / "qc_review"), backend="mcr")
    env = _env(*_base_required("mcr"))
    env["groups"][0]["checks"].append(
        {
            "id": "fshome",
            "label": "FreeSurfer home",
            "status": "found",
            "detail": "/usr/local/freesurfer/8.2.0 (release "
            "freesurfer-linux-ubuntu24_x86_64-8.2.0-20260314-d932c45)",
        }
    )
    result = EnigmaAdapter().validate(cfg, env)
    assert result.blocking == [
        "Set the ENIGMA QC fsVersion option to 8 to match the installed "
        "FreeSurfer 8; the saved value is 7."
    ]
    cfg["steps"]["enigma"]["params"]["fsVersion"] = "8"
    assert EnigmaAdapter().validate(cfg, env).blocking == []


def test_validate_unselected_backend_does_not_satisfy_configured_backend(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = enigma_config(str(tmp_path / "qc_review"), backend="python")
    result = EnigmaAdapter().validate(cfg, _env(*_base_required("mcr")))
    assert result.blocking == ["Choose MATLAB or MCR as the ENIGMA backend."]


def test_validate_blocks_when_no_backend_is_viable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = enigma_config(str(tmp_path / "qc_review"), backend="mcr")
    result = EnigmaAdapter().validate(
        cfg,
        _env("bash", "awk", "grep", "cat", "mkdir", "enigma_assets", "xvfb-run"),
    )
    assert len(result.blocking) == 1
    assert "mcr" in result.blocking[0]


def test_required_checks_add_wslpath_only_on_live_wsl_host(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = enigma_config(str(tmp_path / "qc_review"), backend="mcr")
    monkeypatch.setattr(enigma_module, "_host_is_wsl", lambda: True)
    assert "wslpath" in EnigmaAdapter().required_check_ids(cfg)
    monkeypatch.setattr(enigma_module, "_host_is_wsl", lambda: False)
    assert "wslpath" not in EnigmaAdapter().required_check_ids(cfg)


def test_required_checks_add_xvfb_only_without_display(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = enigma_config(str(tmp_path / "qc_review"), backend="mcr")
    monkeypatch.delenv("DISPLAY", raising=False)
    assert "xvfb-run" in EnigmaAdapter().required_check_ids(cfg)
    monkeypatch.setenv("DISPLAY", ":1")
    assert "xvfb-run" not in EnigmaAdapter().required_check_ids(cfg)


# -- ICV extraction on FreeSurfer 8 (wrapper Bash step 1) ----------------------

#: Define a minimal FreeSurfer 8 ``aseg.stats`` with the subcortical rows that
#: Step 1 reads and both intracranial-volume measures that FreeSurfer 8 emits.
#: Include ``SegmentedTotalIntraCranialVol`` (sTIV) alongside the long-standing
#: ``EstimatedTotalIntraCranialVol`` (eTIV) to expose an unanchored grep that
#: matches both measures and concatenates them into a malformed ICV.
_FS8_SUBCORT = [
    ("Left-Lateral-Ventricle", 5467.6),
    ("Right-Lateral-Ventricle", 6110.9),
    ("Left-Thalamus", 6850.4),
    ("Right-Thalamus", 6451.1),
    ("Left-Caudate", 3547.6),
    ("Right-Caudate", 3729.7),
    ("Left-Putamen", 4789.1),
    ("Right-Putamen", 4402.1),
    ("Left-Pallidum", 1565.6),
    ("Right-Pallidum", 1448.1),
    ("Left-Hippocampus", 3838.8),
    ("Right-Hippocampus", 3930.4),
    ("Left-Amygdala", 1618.2),
    ("Right-Amygdala", 1593.8),
    ("Left-Accumbens-area", 536.6),
    ("Right-Accumbens-area", 589.0),
]


def _write_fs8_aseg(stats_dir: Path) -> None:
    """Write a minimal FreeSurfer 8 ``aseg.stats`` with eTIV and sTIV measures."""
    rows = [
        f"  {i}  {i}  9000  {vol}  {name}  90.0  9.0  10  255  245"
        for i, (name, vol) in enumerate(_FS8_SUBCORT, start=1)
    ]
    aseg = (
        "# Title Segmentation Statistics\n"
        "# Measure EstimatedTotalIntraCranialVol, eTIV, "
        "Estimated Total Intracranial Volume, 1350000.000000, mm^3\n"
        "# Measure SegmentedTotalIntraCranialVol, sTIV, "
        "Segmented Total Intracranial Volume, 1180000.000000, mm^3\n"
        + "\n".join(rows)
        + "\n"
    )
    (stats_dir / "aseg.stats").write_text(aseg)


def test_step1_extracts_freesurfer8_etiv_icv_without_concatenation(
    tmp_path: Path,
) -> None:
    """Extract the FS8 eTIV ICV without concatenating the sTIV value.

    Keep the extra ``SegmentedTotalIntraCranialVol`` measure out of the ICV
    column after the FreeSurfer 8 ``aseg.stats`` change. Run the active wrapper's
    pure-Bash Step 1 without MATLAB against a synthetic FS8 ``aseg.stats``. Assert
    one well-formed ICV value.
    """
    bash = shutil.which("bash")
    if bash is None:  # pragma: no cover - bash is present on Linux CI
        pytest.skip("Run this test only where Bash can execute the ENIGMA wrapper.")

    subj = "sub-test"
    stats = tmp_path / "freesurfer" / subj / "stats"
    stats.mkdir(parents=True)
    _write_fs8_aseg(stats)

    out = tmp_path / "qc"
    out.mkdir()
    subjects = out / "subjects.txt"
    subjects.write_text(subj + "\n")

    base = resources.enigma_dir()
    wrapper = base / "enigma_fs_wrapper_script.sh"
    proc = subprocess.run(  # noqa: S603 - Run a fixed wrapper with test-controlled arguments.
        [
            bash,
            str(wrapper),
            "--subjects",
            str(subjects),
            "--fsdir",
            str(tmp_path / "freesurfer"),
            "--outdir",
            str(out),
            "--script",
            str(base / "ENIGMA_QC"),
            "--matlab",
            "true",  # Supply the mandatory unused MATLAB argument.
            "--fs_version",
            "8",
            "--step_1",
            "true",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr

    csv_lines = (out / "measures" / "LandRvolumes.csv").read_text().splitlines()
    row = next(line for line in csv_lines if line.startswith(subj + ","))
    icv = row.split(",")[-1]
    # Require one decimal point in eTIV, and reject the former eTIV+sTIV
    # concatenation with two decimal points.
    assert icv.count(".") == 1, f"Keep the FS8 ICV scalar; found {icv!r}."
    assert float(icv) == pytest.approx(1350000.0)
    # Preserve correct subcortical-volume extraction alongside the ICV fix.
    lthal = row.split(",")[3]
    assert float(lthal) == pytest.approx(6850.4)


def test_gallery_panels_match_the_exact_protocol_population() -> None:
    subcortical = enigma_module.gallery_panels("subcortical", "sub-01")
    internal = enigma_module.gallery_panels("cortical_internal", "sub-01")
    external = enigma_module.gallery_panels("cortical_external", "sub-01")

    assert (len(subcortical), len(internal), len(external)) == (12, 16, 4)
    # Expect 24 subcortical, 32 internal-cortical, and 4 external-cortical PNGs.
    for panels, files in ((subcortical, 24), (internal, 32), (external, 4)):
        bound = {panel.montage_relative for panel in panels} | {
            panel.full_relative for panel in panels
        }
        assert len(bound) == files
    assert subcortical[0].label == "Axial 20%"
    assert internal[-1].label == "Coronal 90%"
    assert external[0].label == "Left hemisphere, lateral"
    assert {panel.key for panel in subcortical} == {
        f"{axis}-{percent}"
        for axis in ("axial", "coronal", "sagittal")
        for percent in ("20", "40", "60", "80")
    }


def test_verified_subject_panels_bind_each_image_by_size_and_digest(
    tmp_path: Path,
) -> None:
    out_dir = tmp_path / "qc_review"
    _make_galleries(out_dir, ("subcortical",), subjects=("sub-01", "sub-02"))

    panels, error = enigma_module.verified_subject_panels(
        str(out_dir), "subcortical", ("sub-01", "sub-02"), "sub-02"
    )

    assert error is None
    assert len(panels) == 12
    expected = _minimal_png()
    for panel in panels:
        for role in ("montage", "full"):
            image = panel[role]
            assert image["relativePath"].startswith("sub-02/")
            assert image["bytes"] == len(expected)
            assert image["sha256"] == hashlib.sha256(expected).hexdigest()
            assert Path(image["path"]).is_file()


def test_verified_subject_panels_refuse_a_gallery_the_detector_rejects(
    tmp_path: Path,
) -> None:
    out_dir = tmp_path / "qc_review"
    _make_galleries(out_dir, ("subcortical",))
    broken = out_dir / "qc/subcortical/sub-01/Subcortical_set_Axial_70_20.png"
    broken.write_bytes(b"not a png")

    panels, error = enigma_module.verified_subject_panels(
        str(out_dir), "subcortical", ("sub-01",), "sub-01"
    )

    assert panels == []
    assert error is not None
    assert "missing or invalid gallery image" in error


def test_verified_subject_panels_refuse_a_subject_outside_the_run_cohort(
    tmp_path: Path,
) -> None:
    out_dir = tmp_path / "qc_review"
    _make_galleries(out_dir, ("subcortical",))

    panels, error = enigma_module.verified_subject_panels(
        str(out_dir), "subcortical", ("sub-01",), "sub-99"
    )

    assert panels == []
    assert error == "Choose a subject from this ENIGMA run cohort."


def test_verified_subject_panels_reject_an_unknown_gallery(tmp_path: Path) -> None:
    """Describe only the three protocol galleries."""
    panels, error = enigma_module.verified_subject_panels(
        str(tmp_path), "sagittal", ("sub-01",), "sub-01"
    )

    assert panels == []
    assert error == "Choose a valid QC gallery selector."


def test_gallery_validation_is_reused_only_while_every_file_is_unchanged(
    tmp_path: Path,
) -> None:
    out_dir = tmp_path / "qc_review"
    _make_galleries(out_dir, ("subcortical",), subjects=("sub-01", "sub-02"))
    gallery = str(out_dir / "qc/subcortical/ENIGMA_Subcortical_QC.html")
    subjects = ("sub-01", "sub-02")

    reads: list[str] = []
    original = enigma_module._png_identity

    def counting(path: str) -> tuple[int, str] | None:
        reads.append(path)
        return original(path)

    enigma_module._IDENTITY_CACHE.clear()
    try:
        enigma_module._png_identity = counting  # type: ignore[assignment]
        first, error = enigma_module._gallery_identity("subcortical", gallery, subjects)
        assert error is None
        assert len(reads) == len(first)

        reads.clear()
        second, error = enigma_module._gallery_identity(
            "subcortical", gallery, subjects
        )
        assert error is None
        assert second == first
        # Avoid hashing again when nothing changes on disk.
        assert reads == []

        # Recompute validation for a different cohort.
        reads.clear()
        _, error = enigma_module._gallery_identity("subcortical", gallery, ("sub-01",))
        assert error is not None
        assert reads == []

        # Invalidate retained validation after an image changes.
        changed = out_dir / "qc/subcortical/sub-01/Subcortical_set_Axial_70_20.png"
        changed.write_bytes(_minimal_png(marker=7))
        os.utime(changed, (0, 0))
        reads.clear()
        third, error = enigma_module._gallery_identity("subcortical", gallery, subjects)
        assert error is None
        assert len(reads) == len(first)
        assert third != first
    finally:
        enigma_module._png_identity = original  # type: ignore[assignment]
        enigma_module._IDENTITY_CACHE.clear()


def test_gallery_identity_rejects_content_appended_after_measurement(
    tmp_path: Path,
) -> None:
    # The extra-character read exists to catch bytes appended between the
    # size measurement and the read; the verdict must reject them instead
    # of parsing content the measured identity never covered.
    out_dir = tmp_path / "qc_review"
    _make_galleries(out_dir, ("subcortical",), subjects=("sub-01",))
    gallery_path = out_dir / "qc/subcortical/ENIGMA_Subcortical_QC.html"
    witness = enigma_module._file_witness(str(gallery_path))
    assert witness is not None

    original = enigma_module._file_witness

    def stale_witness(path: str) -> tuple[int, int, int, int] | None:
        if path == str(gallery_path):
            return witness
        return original(path)

    enigma_module._IDENTITY_CACHE.clear()
    try:
        enigma_module._file_witness = stale_witness  # type: ignore[assignment]
        with gallery_path.open("a", encoding="utf-8") as handle:
            handle.write("<!-- appended -->")
        identities, error = enigma_module._gallery_identity(
            "subcortical", str(gallery_path), ("sub-01",)
        )
    finally:
        enigma_module._file_witness = original  # type: ignore[assignment]
        enigma_module._IDENTITY_CACHE.clear()

    assert identities == []
    assert error == "Reject the gallery because it changed after measurement."


def test_gallery_identity_rejects_a_file_replaced_during_validation(
    tmp_path: Path,
) -> None:
    # A gallery replaced between the pre-read witness and the end of
    # parsing must not have a verdict cached under the new identity.
    out_dir = tmp_path / "qc_review"
    _make_galleries(out_dir, ("subcortical",), subjects=("sub-01",))
    gallery_path = out_dir / "qc/subcortical/ENIGMA_Subcortical_QC.html"

    original = enigma_module._file_witness
    calls: list[str] = []

    def churning_witness(path: str) -> tuple[int, int, int, int] | None:
        witness = original(path)
        if path == str(gallery_path):
            calls.append(path)
            if witness is not None and len(calls) > 1:
                return (*witness[:3], witness[3] + 1)
        return witness

    enigma_module._IDENTITY_CACHE.clear()
    try:
        enigma_module._file_witness = churning_witness  # type: ignore[assignment]
        identities, error = enigma_module._gallery_identity(
            "subcortical", str(gallery_path), ("sub-01",)
        )
    finally:
        enigma_module._file_witness = original  # type: ignore[assignment]
        enigma_module._IDENTITY_CACHE.clear()

    assert identities == []
    assert error == "Reject the gallery because it changed during validation."


def test_gallery_validation_cache_is_bounded(tmp_path: Path) -> None:
    enigma_module._IDENTITY_CACHE.clear()
    try:
        for index in range(enigma_module._MAX_CACHED_GALLERIES + 3):
            out_dir = tmp_path / f"run-{index}"
            _make_galleries(out_dir, ("subcortical",))
            enigma_module._gallery_identity(
                "subcortical",
                str(out_dir / "qc/subcortical/ENIGMA_Subcortical_QC.html"),
                ("sub-01",),
            )
        assert len(enigma_module._IDENTITY_CACHE) == enigma_module._MAX_CACHED_GALLERIES
    finally:
        enigma_module._IDENTITY_CACHE.clear()
