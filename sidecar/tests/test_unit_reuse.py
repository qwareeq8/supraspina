"""Tests for per-subject unit reuse inside cohort stages."""

from __future__ import annotations

import copy
import shutil
import struct
import subprocess
import sys
import uuid
import zlib
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import resources, source_digests, unit_reuse
from supraspina_sidecar.adapters import enigma as enigma_module
from supraspina_sidecar.adapters import enigma_units
from supraspina_sidecar.adapters.base import (
    UNIT_CONTRACTS,
    ExecutionAction,
    UnitContract,
    UnitSpec,
)
from supraspina_sidecar.provenance import make_receipt, stable_digest
from supraspina_sidecar.run_store import (
    RECEIPT_PAYLOAD_KEYS,
    RECEIPT_VERSION,
    UNIT_REUSE_KEY,
    receipt_record_contract_valid,
    unit_reuse_valid,
)
from tests.test_enigma import enigma_config

RUN_1 = "run-11111111"
RUN_2 = "run-22222222"
METHOD = "a" * 64


class _DemoUnits(UnitContract):
    """Two units per subject: one owned directory and one exact file."""

    step_key = "demo"
    version = "demo-units:v1"

    def __init__(self, root: Path) -> None:
        self.root = root

    def applies(self, cfg: dict[str, Any]) -> bool:
        return True

    def output_root(self, cfg: dict[str, Any]) -> str:
        return str(self.root)

    def units(self, cfg: dict[str, Any], subject_id: str) -> tuple[UnitSpec, ...]:
        return (
            UnitSpec(
                "slices",
                ("mri/volume.mgz",),
                output_dir=f"slices/{subject_id}",
                required_files=(
                    f"slices/{subject_id}/axial.png",
                    f"slices/{subject_id}/coronal.png",
                ),
            ),
            UnitSpec(
                "surface",
                ("surf/lh.pial.T1", "label/lh.aparc.annot"),
                output_files=(f"surface/{subject_id}.png",),
            ),
        )

    def launch_action(
        self,
        cfg: dict[str, Any],
        action: ExecutionAction,
        skipped: dict[str, frozenset[str]],
        work_dir: str,
    ) -> ExecutionAction:
        return action


def _write(path: Path, data: bytes | str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode() if isinstance(data, str) else data)


def _subjects(tmp_path: Path, ids: tuple[str, ...]) -> dict[str, str]:
    dirs: dict[str, str] = {}
    for subject_id in ids:
        root = tmp_path / "fs" / subject_id
        _write(root / "mri" / "volume.mgz", f"volume {subject_id}")
        _write(root / "surf" / "lh.pial.T1", f"pial {subject_id}")
        _write(root / "label" / "lh.aparc.annot", f"annot {subject_id}")
        dirs[subject_id] = str(root)
    return dirs


def _render(plan: unit_reuse.UnitPlan, stamp: str) -> None:
    """Launch, then write every computed unit's output, stamped."""
    unit_reuse.begin(plan, _run_id())
    root = Path(plan.output_root)
    for decision in plan.decisions:
        if decision.mode == unit_reuse.REUSED:
            continue
        sid = decision.subject_id
        if decision.spec.part == "slices":
            for name in ("axial.png", "coronal.png"):
                _write(root / "slices" / sid / name, f"{sid} {name} {stamp}")
        else:
            _write(root / "surface" / f"{sid}.png", f"{sid} surface {stamp}")


def _run_id() -> str:
    return f"run-{uuid.uuid4().hex[:12]}"


def _prior(record: dict[str, Any], run_id: str, committed: int) -> list[Any]:
    return [
        unit_reuse.PriorRecord(
            run_id=run_id,
            receipt_sha256=stable_digest(record),
            committed_at_ms=committed,
            method_sha256=record["methodSha256"],
            units=record["units"],
        )
    ]


def _first_run(
    tmp_path: Path, ids: tuple[str, ...] = ("sub-01", "sub-02")
) -> tuple[_DemoUnits, dict[str, str], dict[str, Any]]:
    contract = _DemoUnits(tmp_path / "out")
    dirs = _subjects(tmp_path, ids)
    plan = unit_reuse.decide(
        contract, {}, dirs, [], METHOD, reuse_enabled=True, contents=True
    )
    _render(plan, "first")
    return contract, dirs, unit_reuse.finish(plan, RUN_1)


def _modes(plan: unit_reuse.UnitPlan) -> dict[tuple[str, str], str]:
    return {(d.subject_id, d.spec.part): d.reason for d in plan.decisions}


def test_first_run_computes_every_unit_without_an_earlier_record(
    tmp_path: Path,
) -> None:
    _contract, _dirs, record = _first_run(tmp_path)

    assert unit_reuse_valid(record)
    assert record["sources"] == {}
    for parts in record["units"].values():
        for unit in parts.values():
            assert unit["mode"] == "computed"
            assert unit["reason"] == "no-record"
            assert unit["renderedRunId"] == RUN_1


def test_unchanged_units_are_reused_and_left_byte_identical(tmp_path: Path) -> None:
    contract, dirs, record = _first_run(tmp_path)
    before = {p: p.read_bytes() for p in (tmp_path / "out").rglob("*.png")}

    plan = unit_reuse.decide(
        contract,
        {},
        dirs,
        _prior(record, RUN_1, 1),
        METHOD,
        reuse_enabled=True,
        contents=True,
    )
    _render(plan, "second")
    second = unit_reuse.finish(plan, RUN_2)

    assert set(_modes(plan).values()) == {"reused"}
    assert plan.skipped() == {
        "slices": frozenset({"sub-01", "sub-02"}),
        "surface": frozenset({"sub-01", "sub-02"}),
    }
    assert {p: p.read_bytes() for p in (tmp_path / "out").rglob("*.png")} == before
    assert unit_reuse_valid(second)
    assert second["sources"] == {RUN_1: stable_digest(record)}
    unit = second["units"]["sub-01"]["slices"]
    assert unit["sourceRunId"] == RUN_1
    assert unit["renderedRunId"] == RUN_1
    assert unit["renderedReason"] == "no-record"
    assert unit["outputSha256"] == record["units"]["sub-01"]["slices"]["outputSha256"]


def test_a_new_subject_is_computed_and_named_new(tmp_path: Path) -> None:
    contract, dirs, record = _first_run(tmp_path)
    dirs.update(_subjects(tmp_path, ("sub-03",)))

    plan = unit_reuse.decide(
        contract,
        {},
        dirs,
        _prior(record, RUN_1, 1),
        METHOD,
        reuse_enabled=True,
        contents=True,
    )

    assert plan.summary() == {
        "computedSubjectIds": ["sub-03"],
        "reusedSubjectIds": ["sub-01", "sub-02"],
        "sourceRunIds": [RUN_1],
    }
    assert _modes(plan)[("sub-03", "slices")] == "new-subject"


@pytest.mark.parametrize(
    ("relative", "part"),
    [("mri/volume.mgz", "slices"), ("label/lh.aparc.annot", "surface")],
)
def test_a_changed_input_recomputes_only_the_units_that_read_it(
    tmp_path: Path, relative: str, part: str
) -> None:
    contract, dirs, record = _first_run(tmp_path)
    # Same size, different bytes: only a content digest sees it.
    target = Path(dirs["sub-01"]) / relative
    target.write_bytes(target.read_bytes()[::-1])

    plan = unit_reuse.decide(
        contract,
        {},
        dirs,
        _prior(record, RUN_1, 1),
        METHOD,
        reuse_enabled=True,
        contents=True,
    )

    modes = _modes(plan)
    assert modes.pop(("sub-01", part)) == "inputs-changed"
    assert set(modes.values()) == {"reused"}


def test_a_method_change_recomputes_every_unit(tmp_path: Path) -> None:
    contract, dirs, record = _first_run(tmp_path)

    plan = unit_reuse.decide(
        contract,
        {},
        dirs,
        _prior(record, RUN_1, 1),
        "b" * 64,
        reuse_enabled=True,
        contents=True,
    )

    assert set(_modes(plan).values()) == {"method-changed"}
    assert plan.skipped() == {}


@pytest.mark.parametrize("damage", ["corrupt", "extra", "missing"])
def test_a_damaged_earlier_output_is_recomputed(tmp_path: Path, damage: str) -> None:
    contract, dirs, record = _first_run(tmp_path)
    slices = tmp_path / "out" / "slices" / "sub-02"
    if damage == "corrupt":
        (slices / "axial.png").write_bytes(b"x" + (slices / "axial.png").read_bytes())
    elif damage == "extra":
        _write(slices / "stray.png", "stray")
    else:
        (slices / "coronal.png").unlink()

    plan = unit_reuse.decide(
        contract,
        {},
        dirs,
        _prior(record, RUN_1, 1),
        METHOD,
        reuse_enabled=True,
        contents=True,
    )

    modes = _modes(plan)
    assert modes.pop(("sub-02", "slices")) == "output-changed"
    assert set(modes.values()) == {"reused"}


def test_reuse_off_computes_every_unit_and_still_records_them(
    tmp_path: Path,
) -> None:
    contract, dirs, record = _first_run(tmp_path)

    plan = unit_reuse.decide(
        contract,
        {},
        dirs,
        _prior(record, RUN_1, 1),
        METHOD,
        reuse_enabled=False,
        contents=True,
    )
    _render(plan, "forced")
    forced = unit_reuse.finish(plan, RUN_2)

    assert set(_modes(plan).values()) == {"reuse-off"}
    assert unit_reuse_valid(forced)
    assert forced["units"]["sub-01"]["slices"]["renderedRunId"] == RUN_2


def test_the_newest_record_decides_reuse(tmp_path: Path) -> None:
    contract, dirs, record = _first_run(tmp_path)
    older = _prior(record, RUN_1, 1)[0]
    newer = unit_reuse.PriorRecord(
        run_id=RUN_2,
        receipt_sha256="c" * 64,
        committed_at_ms=2,
        method_sha256="b" * 64,
        units=record["units"],
    )

    plan = unit_reuse.decide(
        contract,
        {},
        dirs,
        [newer, older],
        METHOD,
        reuse_enabled=True,
        contents=True,
    )

    assert set(_modes(plan).values()) == {"method-changed"}


def test_the_forecast_compares_byte_counts_without_reading_contents(
    tmp_path: Path,
) -> None:
    contract, dirs, record = _first_run(tmp_path)
    same_size = Path(dirs["sub-01"]) / "mri" / "volume.mgz"
    same_size.write_bytes(same_size.read_bytes()[::-1])
    grown = Path(dirs["sub-02"]) / "mri" / "volume.mgz"
    grown.write_bytes(grown.read_bytes() + b"!")

    plan = unit_reuse.decide(
        contract,
        {},
        dirs,
        _prior(record, RUN_1, 1),
        METHOD,
        reuse_enabled=True,
        contents=False,
    )

    modes = _modes(plan)
    assert modes[("sub-01", "slices")] == "reused"
    assert modes[("sub-02", "slices")] == "inputs-changed"


def test_finish_refuses_an_input_changed_during_the_run(tmp_path: Path) -> None:
    contract, dirs, record = _first_run(tmp_path)
    plan = unit_reuse.decide(
        contract,
        {},
        dirs,
        _prior(record, RUN_1, 1),
        METHOD,
        reuse_enabled=True,
        contents=True,
    )
    _write(Path(dirs["sub-01"]) / "surf" / "lh.pial.T1", "edited during the run")

    with pytest.raises(unit_reuse.UnitReuseError, match="input changed"):
        unit_reuse.finish(plan, RUN_2)


def test_finish_refuses_a_reused_output_changed_during_the_run(
    tmp_path: Path,
) -> None:
    contract, dirs, record = _first_run(tmp_path)
    plan = unit_reuse.decide(
        contract,
        {},
        dirs,
        _prior(record, RUN_1, 1),
        METHOD,
        reuse_enabled=True,
        contents=True,
    )
    _write(tmp_path / "out" / "surface" / "sub-01.png", "overwritten")

    with pytest.raises(unit_reuse.UnitReuseError, match="reused per-subject output"):
        unit_reuse.finish(plan, RUN_2)


def _payload() -> dict[str, Any]:
    return {
        "receiptVersion": RECEIPT_VERSION,
        "stepKey": "enigma",
        "subjectId": None,
        "scope": "cohort",
        "analysisCohortDigest": "d" * 64,
        "selectedSubsetDigest": None,
        "inputT1Fingerprint": None,
        "configurationDigest": "e" * 64,
        "stepParamsDigest": "f" * 64,
        "executionActionDigest": "1" * 64,
        "adapterIdentity": "supraspina_sidecar.adapters.enigma.EnigmaAdapter",
        "adapterImplementation": {"scientificResources": {"enigma": {"sha256": "2"}}},
        "toolEvidenceDigest": "3" * 64,
        "externalInputs": {},
        "defacing": {},
        "outputSchemaIdentity": "enigma:v1",
        "upstreamSignatures": [],
        "baseline": {},
        "scopeBinding": {"analysisSubjectIds": ["sub-01", "sub-02"]},
    }


def test_method_digest_binds_the_method_but_not_the_cohort() -> None:
    contract = UNIT_CONTRACTS["enigma"]
    base = unit_reuse.method_digest(contract, _payload(), {})
    for key, value in (
        ("executionActionDigest", "9" * 64),
        ("toolEvidenceDigest", "9" * 64),
        ("stepParamsDigest", "9" * 64),
        ("adapterImplementation", {"scientificResources": {"enigma": {"sha256": "9"}}}),
    ):
        changed = _payload()
        changed[key] = value
        assert unit_reuse.method_digest(contract, changed, {}) != base, key
    for key in ("analysisCohortDigest", "configurationDigest", "scopeBinding"):
        changed = _payload()
        changed[key] = "0" * 64
        assert unit_reuse.method_digest(contract, changed, {}) == base, key


def test_the_receipt_record_binds_a_valid_unit_record(tmp_path: Path) -> None:
    _contract, _dirs, record = _first_run(tmp_path)
    payload = _payload()
    assert set(payload) == set(RECEIPT_PAYLOAD_KEYS)

    receipt = make_receipt(
        "4" * 64,
        payload,
        {"state": "done", "artifacts": []},
        run_id=RUN_1,
        job_id="job-1",
        committed_at_ms=1,
        unit_reuse=record,
    )
    plain = make_receipt(
        "4" * 64,
        payload,
        {"state": "done", "artifacts": []},
        run_id=RUN_1,
        job_id="job-1",
        committed_at_ms=1,
    )

    assert receipt_record_contract_valid(receipt)
    assert UNIT_REUSE_KEY not in plain
    assert receipt_record_contract_valid(plain)
    assert receipt["recordSha256"] != plain["recordSha256"]

    tampered = copy.deepcopy(receipt)
    tampered[UNIT_REUSE_KEY]["units"]["sub-01"]["slices"]["outputSha256"] = "0" * 64
    assert not receipt_record_contract_valid(tampered)

    other_cohort = make_receipt(
        "4" * 64,
        {**payload, "scopeBinding": {"analysisSubjectIds": ["sub-01"]}},
        {"state": "done", "artifacts": []},
        run_id=RUN_1,
        job_id="job-1",
        committed_at_ms=1,
        unit_reuse=record,
    )
    assert not receipt_record_contract_valid(other_cohort)

    foreign_render = make_receipt(
        "4" * 64,
        payload,
        {"state": "done", "artifacts": []},
        run_id=RUN_2,
        job_id="job-1",
        committed_at_ms=1,
        unit_reuse=record,
    )
    assert not receipt_record_contract_valid(foreign_render)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r.pop("sources"),
        lambda r: r.update(schema="unit-reuse:v0"),
        lambda r: r["units"]["sub-01"]["slices"].update(mode="skipped"),
        lambda r: r["units"]["sub-01"]["slices"].update(reason="reused"),
        lambda r: r["units"]["sub-01"]["slices"].update(inputBytes=-1),
        lambda r: r["sources"].update({"run-33333333": "5" * 64}),
        lambda r: r["units"].update({"../escape": r["units"]["sub-01"]}),
    ],
)
def test_unit_record_validation_fails_closed(tmp_path: Path, mutate: Any) -> None:
    _contract, _dirs, record = _first_run(tmp_path)
    broken = copy.deepcopy(record)
    mutate(broken)

    assert not unit_reuse_valid(broken)


def test_summary_and_log_line_state_counts_and_sources(tmp_path: Path) -> None:
    contract, dirs, record = _first_run(tmp_path)
    dirs.update(_subjects(tmp_path, ("sub-03",)))
    plan = unit_reuse.decide(
        contract,
        {},
        dirs,
        _prior(record, RUN_1, 1),
        METHOD,
        reuse_enabled=True,
        contents=True,
    )
    _render(plan, "second")
    second = unit_reuse.finish(plan, RUN_2)

    assert unit_reuse.record_summary(second) == plan.summary()
    assert unit_reuse.log_line(plan.summary()) == (
        "Per-subject reuse: computing 1 subject and reusing the verified output "
        f"of 2 subjects from {RUN_1}."
    )
    assert unit_reuse.log_line(
        {"computedSubjectIds": ["a", "b"], "reusedSubjectIds": [], "sourceRunIds": []}
    ) == (
        "Per-subject reuse: computing 2 subjects; no verified earlier output matches."
    )


# -- ENIGMA contract ---------------------------------------------------------


@pytest.fixture
def _no_display(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setattr(enigma_module.tools, "which", lambda _name: None)
    monkeypatch.setattr(enigma_module, "_host_is_wsl", lambda: False)


@pytest.mark.parametrize(
    ("fs_version", "volume"),
    [("8", "mri/nu.mgz"), ("7", "mri/orig_nu.mgz"), ("5", "mri/orig_nu.mgz")],
)
def test_enigma_units_read_the_wrapper_inputs(
    tmp_path: Path, fs_version: str, volume: str
) -> None:
    cfg = enigma_config(str(tmp_path / "qc"))
    cfg["steps"]["enigma"]["params"]["fsVersion"] = fs_version

    units = {spec.part: spec for spec in UNIT_CONTRACTS["enigma"].units(cfg, "sub-1")}

    assert units["subcortical"].inputs == (volume, "mri/aparc+aseg.mgz")
    assert units["internal"].inputs == (volume, "mri/aparc+aseg.mgz")
    assert units["subcortical"].output_dir == "qc/subcortical/sub-1"
    assert units["internal"].output_dir == "qc/cortical_internal/sub-1"
    assert units["external"].inputs == (
        "surf/lh.pial.T1",
        "surf/rh.pial.T1",
        "label/lh.aparc.annot",
        "label/rh.aparc.annot",
    )
    assert units["external"].output_files == tuple(
        f"qc/cortical_external/sub-1.{view}.png"
        for view in ("lh.lat", "lh.med", "rh.lat", "rh.med")
    )
    assert UNIT_CONTRACTS["enigma"].output_root(cfg) == str(tmp_path / "qc")


@pytest.mark.usefixtures("_no_display")
def test_enigma_units_apply_to_the_runtime_backend_only(tmp_path: Path) -> None:
    contract = UNIT_CONTRACTS["enigma"]

    assert contract.applies(enigma_config(str(tmp_path), backend="mcr"))
    assert not contract.applies(enigma_config(str(tmp_path), backend="matlab"))


@pytest.mark.usefixtures("_no_display")
def test_enigma_launch_swaps_only_the_script_directory(tmp_path: Path) -> None:
    cfg = enigma_config(str(tmp_path / "qc"))
    action = enigma_module.EnigmaAdapter().execution_action(cfg, None)
    shim = tmp_path / "shim"

    launched = UNIT_CONTRACTS["enigma"].launch_action(
        cfg, action, {"external": frozenset({"sub-2", "sub-1"})}, str(shim)
    )

    index = list(action.argv).index("--script") + 1
    expected = list(action.argv)
    expected[index] = str(shim)
    assert list(launched.argv) == expected
    assert (shim / "external.skip").read_text() == "sub-1\nsub-2\n"
    assert (shim / "subcortical.skip").read_text() == ""
    assert (shim / "run_FS_external_QC.sh").is_file()


def _png(note: str) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(payload, zlib.crc32(kind)) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", crc)

    header = struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0)
    rows = b"".join(b"\0" + b"\x10\x20\x30" * 2 for _ in range(2))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"tEXt", b"Creation Time\0" + note.encode())
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


#: A stand-in for the three compiled MATLAB renderers: it writes every panel
#: the gallery references, stamped like MATLAB stamps a creation time.
_FAKE_RENDERER = """
import os, sys, time
sys.path.insert(0, {sidecar!r})
from supraspina_sidecar.adapters.enigma import gallery_panels
from tests.test_unit_reuse import _png
part, qc_dir, subject, log = sys.argv[1:5]
silent = log + ".silent"
# A listed subject fails silently: exit 0 and write nothing, as a crashed
# MATLAB child under the wrapper does.
if os.path.exists(silent) and subject in open(silent).read().split():
    sys.exit(0)
gallery = {{"subcortical": "subcortical", "internal": "cortical_internal",
            "external": "cortical_external"}}[part]
for panel in gallery_panels(gallery, subject):
    for relative in {{panel.montage_relative, panel.full_relative}}:
        path = os.path.join(qc_dir, relative)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(_png(f"{{subject}} {{time.time_ns()}}"))
with open(log, "a") as handle:
    handle.write(f"{{part}} {{subject}}\\n")
"""


def _fake_compiled(tmp_path: Path) -> tuple[Path, Path]:
    compiled = tmp_path / "compiled"
    compiled.mkdir()
    log = tmp_path / "render.log"
    renderer = tmp_path / "fake_renderer.py"
    renderer.write_text(
        _FAKE_RENDERER.format(sidecar=str(Path(__file__).resolve().parents[1]))
    )
    calls = {
        "run_func_make_subcorticalFS_ENIGMA_QC.sh": 'subcortical "$2" "$3"',
        "run_func_make_corticalpngs_ENIGMA_QC.sh": 'internal "$2" "$3"',
        "run_FS_external_QC.sh": 'external "$3" "$4"',
    }
    for name, args in calls.items():
        (compiled / name).write_text(
            f'#!/bin/sh\nexec {sys.executable} {renderer} {args} "{log}"\n'
        )
    return compiled, log


def _wrapper_argv(tmp_path: Path, script_dir: Path) -> list[str]:
    bash = shutil.which("bash")
    if bash is None:  # pragma: no cover - bash is present on supported Linux.
        pytest.skip("Run this test only where Bash can execute the ENIGMA wrapper.")
    wrapper = (
        resources.enigma_dir() / "compiled" / "enigma_fs_wrapper_script_compiled.sh"
    )
    return [
        bash,
        str(wrapper),
        "--subjects",
        str(tmp_path / "subjects.txt"),
        "--fsdir",
        str(tmp_path / "freesurfer"),
        "--outdir",
        str(tmp_path / "qc"),
        "--script",
        str(script_dir),
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
    ]


def test_the_real_wrapper_renders_only_unskipped_subjects(tmp_path: Path) -> None:
    """Run the reviewed wrapper through the shim with stand-in renderers."""
    compiled, log = _fake_compiled(tmp_path)
    subjects = ("sub-01", "sub-02", "sub-03")
    (tmp_path / "subjects.txt").write_text("".join(f"{s}\n" for s in subjects[:2]))
    first = subprocess.run(  # noqa: S603 - Fixed wrapper, test-controlled paths.
        _wrapper_argv(tmp_path, compiled),
        capture_output=True,
        text=True,
        check=False,
    )
    assert first.returncode == 0, first.stderr
    kept = {
        path: path.read_bytes()
        for path in (tmp_path / "qc").rglob("*.png")
        if "sub-01" in path.name or "sub-01" in path.parts
    }
    assert kept
    log.write_text("")

    (tmp_path / "subjects.txt").write_text("".join(f"{s}\n" for s in subjects))
    argv = _wrapper_argv(tmp_path, compiled)
    shimmed = UNIT_CONTRACTS["enigma"].launch_action(
        {},
        ExecutionAction(kind="process", argv=tuple(argv)),
        {
            "subcortical": frozenset({"sub-01"}),
            "internal": frozenset({"sub-01", "sub-02"}),
            "external": frozenset({"sub-02"}),
        },
        str(tmp_path / "shim"),
    )
    second = subprocess.run(  # noqa: S603 - Fixed wrapper, test-controlled paths.
        list(shimmed.argv),
        capture_output=True,
        text=True,
        check=False,
    )

    assert second.returncode == 0, second.stderr
    assert sorted(log.read_text().splitlines()) == sorted(
        [
            "subcortical sub-02",
            "subcortical sub-03",
            "internal sub-03",
            "external sub-01",
            "external sub-03",
        ]
    )
    assert "Reused the verified earlier render for sub-01." in second.stdout
    for path, data in kept.items():
        if "cortical_external" not in path.parts:
            assert path.read_bytes() == data, path
    for gallery, subdir, name in enigma_module._QC_GALLERIES:
        identities, error = enigma_module._gallery_identity(
            gallery, str(tmp_path / "qc" / subdir / name), subjects
        )
        assert error is None, gallery
        assert identities


def test_enigma_units_module_is_outside_the_bound_adapter_source() -> None:
    """Keep ENIGMA receipts invariant: the contract is not in enigma.py."""
    import inspect  # noqa: PLC0415

    adapter_source = inspect.getsourcefile(enigma_module.EnigmaAdapter)
    contract_source = inspect.getsourcefile(enigma_units.EnigmaUnits)

    assert adapter_source is not None
    assert contract_source is not None
    assert Path(adapter_source).name == "enigma.py"
    assert Path(contract_source).name == "enigma_units.py"


def test_results_state_a_receipt_unit_summary_only_when_recorded(
    tmp_path: Path,
) -> None:
    from supraspina_sidecar.results import _receipt_provenance  # noqa: PLC0415

    _contract, _dirs, record = _first_run(tmp_path)
    receipt = make_receipt(
        "4" * 64,
        _payload(),
        {"state": "done", "artifacts": []},
        run_id=RUN_1,
        job_id="job-1",
        committed_at_ms=1,
        unit_reuse=record,
    )
    without = {key: value for key, value in receipt.items() if key != UNIT_REUSE_KEY}

    details = _receipt_provenance(receipt, {})["receipt"]
    plain = _receipt_provenance(without, {})["receipt"]

    assert details["unitReuse"] == {
        "computedSubjectIds": ["sub-01", "sub-02"],
        "reusedSubjectIds": [],
        "sourceRunIds": [],
    }
    assert "unitReuse" not in plain


def test_method_digest_binds_the_contract_bytes_and_tool_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract = UNIT_CONTRACTS["enigma"]
    base = unit_reuse.method_digest(contract, _payload(), {})

    monkeypatch.setattr(
        type(contract), "method_identity", lambda _self, _cfg: {"VersionInfo": "x"}
    )
    assert unit_reuse.method_digest(contract, _payload(), {}) != base
    monkeypatch.undo()
    monkeypatch.setattr(unit_reuse, "_contract_source", lambda _contract: "edited")
    assert unit_reuse.method_digest(contract, _payload(), {}) != base


def test_other_contract_bytes_bind_their_digest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract = UNIT_CONTRACTS["enigma"]
    base = unit_reuse.method_digest(contract, _payload(), {})
    edited = "b" * 64
    monkeypatch.setattr(unit_reuse, "class_source_sha256", lambda _cls: edited)

    assert unit_reuse._contract_source(contract) == edited
    assert unit_reuse.method_digest(contract, _payload(), {}) != base
    monkeypatch.setattr(unit_reuse, "class_source_sha256", lambda _cls: None)
    with pytest.raises(RuntimeError, match="unit contract source"):
        unit_reuse.method_digest(contract, _payload(), {})


def test_a_frozen_build_binds_the_contract_bytes_as_the_source_does(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    contract = UNIT_CONTRACTS["enigma"]
    package = Path(unit_reuse.__file__).parent
    source_digest = source_digests.class_source_sha256(type(contract))
    source_method = unit_reuse.method_digest(contract, _payload(), {})
    assert unit_reuse._contract_source(contract) == source_digest

    (tmp_path / "metadata").mkdir()
    source_digests.write_source_digests(
        package, tmp_path / "metadata" / source_digests.SOURCE_DIGESTS_FILE
    )
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    source_digests._frozen_source_digests.cache_clear()
    try:
        assert source_digests.class_source_sha256(type(contract)) == source_digest
        assert unit_reuse.method_digest(contract, _payload(), {}) == source_method

        # A frozen build without the record binds nothing in its place.
        (tmp_path / "metadata" / source_digests.SOURCE_DIGESTS_FILE).unlink()
        source_digests._frozen_source_digests.cache_clear()
        with pytest.raises(RuntimeError, match="unit contract source"):
            unit_reuse.method_digest(contract, _payload(), {})
    finally:
        source_digests._frozen_source_digests.cache_clear()


def test_the_sidecar_spec_records_the_module_source_digests() -> None:
    spec = (Path(__file__).parents[1] / "supraspina-sidecar.spec").read_text("utf-8")
    digests = source_digests.package_source_digests(Path(unit_reuse.__file__).parent)

    assert "write_source_digests(" in spec
    assert "metadata_dir / SOURCE_DIGESTS_FILE" in spec
    assert digests["supraspina_sidecar.adapters.enigma_units"] == (
        source_digests.class_source_sha256(enigma_units.EnigmaUnits)
    )
    assert "supraspina_sidecar" in digests


def test_the_enigma_tool_identity_reads_the_runtime_version_files(
    tmp_path: Path,
) -> None:
    root = tmp_path / "v97"
    _write(root / "VersionInfo.xml", "<version>9.7.0.1737446 Update 9</version>")
    _write(root / "runtime" / "glnxa64" / "libmwmclmcrrt.so.9.7", b"library")
    cfg = enigma_config(str(tmp_path / "qc"))
    cfg["steps"]["enigma"]["params"]["mcrRoot"] = str(root)

    first = UNIT_CONTRACTS["enigma"].method_identity(cfg)
    _write(root / "VersionInfo.xml", "<version>9.7.0.1 Update 10</version>")

    assert all(first.values())
    assert UNIT_CONTRACTS["enigma"].method_identity(cfg) != first


def test_reuse_off_records_the_real_reason_and_the_switch(tmp_path: Path) -> None:
    contract, dirs, record = _first_run(tmp_path)
    target = Path(dirs["sub-01"]) / "mri" / "volume.mgz"
    target.write_bytes(target.read_bytes()[::-1])

    plan = unit_reuse.decide(
        contract,
        {},
        dirs,
        _prior(record, RUN_1, 1),
        METHOD,
        reuse_enabled=False,
        contents=True,
    )
    _render(plan, "forced")
    forced = unit_reuse.finish(plan, RUN_2)

    modes = _modes(plan)
    assert modes.pop(("sub-01", "slices")) == "inputs-changed"
    assert set(modes.values()) == {"reuse-off"}
    assert forced["reuseEnabled"] is False
    assert record["reuseEnabled"] is True
    assert unit_reuse_valid(forced)


def _relaunch(
    tmp_path: Path, contract: Any, dirs: dict[str, str], run_id: str = RUN_2
) -> unit_reuse.UnitPlan:
    """Plan every unit as computed (no record) and launch it."""
    plan = unit_reuse.decide(
        contract, {}, dirs, [], METHOD, reuse_enabled=True, contents=True
    )
    unit_reuse.begin(plan, run_id)
    return plan


def _snapshot(root: Path) -> dict[str, bytes]:
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file() and unit_reuse.HOLD_DIR not in path.parts
    }


def test_launch_sets_computed_output_aside_and_success_removes_it(
    tmp_path: Path,
) -> None:
    contract, dirs, _record = _first_run(tmp_path, ("sub-01",))
    root = tmp_path / "out"
    _write(root / "slices" / "sub-01" / "notes.txt~", "an editor backup")

    plan = _relaunch(tmp_path, contract, dirs)

    assert not (root / "slices" / "sub-01").exists()
    assert not (root / "surface" / "sub-01.png").exists()
    assert sorted(plan.held) == ["slices/sub-01", "surface/sub-01.png"]
    _render_files(root, "sub-01", "new")
    assert unit_reuse_valid(unit_reuse.finish(plan, RUN_2))
    assert unit_reuse.release(plan) == ["slices/sub-01/notes.txt~"]
    assert not (root / unit_reuse.HOLD_DIR).exists() or not any(
        (root / unit_reuse.HOLD_DIR).iterdir()
    )
    assert sorted(p.name for p in (root / "slices" / "sub-01").iterdir()) == [
        "axial.png",
        "coronal.png",
    ]


def _render_files(
    root: Path, subject: str, stamp: str, names: tuple[str, ...] = ()
) -> None:
    for name in names or ("axial.png", "coronal.png"):
        _write(root / "slices" / subject / name, f"{subject} {name} {stamp}")
    _write(root / "surface" / f"{subject}.png", f"{subject} surface {stamp}")


def test_a_silently_failed_render_is_refused_and_restored(tmp_path: Path) -> None:
    """A clean exit that wrote nothing must not adopt the earlier files."""
    contract, dirs, _record = _first_run(tmp_path)
    root = tmp_path / "out"
    before = _snapshot(root)
    plan = _relaunch(tmp_path, contract, dirs)
    # Only sub-01 is rendered again; sub-02's render fails silently.
    _render_files(root, "sub-01", "new")

    with pytest.raises(unit_reuse.UnitReuseError) as caught:
        unit_reuse.finish(plan, RUN_2)
    restored = unit_reuse.restore(plan)

    assert str(caught.value) == (
        "demo did not write all the files expected for 1 subject (sub-02), so "
        "no receipt was written and their earlier output is put back. Check "
        "the job log for the tool's error on these subjects, then run the "
        "stage again."
    )
    assert restored == 4
    assert _snapshot(root) == before
    assert (
        not any((root / unit_reuse.HOLD_DIR).iterdir())
        if (root / unit_reuse.HOLD_DIR).exists()
        else True
    )


def test_a_render_that_writes_a_subset_is_refused(tmp_path: Path) -> None:
    """A fallback branch that writes only some required files fails."""
    contract, dirs, _record = _first_run(tmp_path, ("sub-01",))
    root = tmp_path / "out"
    before = _snapshot(root)
    plan = _relaunch(tmp_path, contract, dirs)
    _render_files(root, "sub-01", "new", names=("axial.png",))

    with pytest.raises(unit_reuse.UnitReuseError, match=r"1 subject \(sub-01\)"):
        unit_reuse.finish(plan, RUN_2)
    unit_reuse.restore(plan)

    assert _snapshot(root) == before


def test_a_missing_listed_output_is_refused(tmp_path: Path) -> None:
    contract, dirs, _record = _first_run(tmp_path, ("sub-01",))
    plan = _relaunch(tmp_path, contract, dirs)
    root = tmp_path / "out"
    _render_files(root, "sub-01", "new")
    (root / "surface" / "sub-01.png").unlink()

    with pytest.raises(unit_reuse.UnitReuseError, match="did not write all"):
        unit_reuse.finish(plan, RUN_2)


@pytest.mark.parametrize("stamped", [True, False])
def test_unchanged_bytes_count_as_unwritten_only_for_a_stamping_tool(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stamped: bool
) -> None:
    contract, dirs, _record = _first_run(tmp_path, ("sub-01",))
    monkeypatch.setattr(contract, "outputs_embed_time", stamped, raising=False)
    root = tmp_path / "out"
    before = _snapshot(root)
    plan = _relaunch(tmp_path, contract, dirs)
    # The tool writes exactly its earlier bytes again: fresh mtimes.
    for relative, data in before.items():
        _write(root / relative, data)

    if stamped:
        with pytest.raises(unit_reuse.UnitReuseError):
            unit_reuse.finish(plan, RUN_2)
    else:
        assert unit_reuse_valid(unit_reuse.finish(plan, RUN_2))


def test_recovery_restores_what_an_interrupted_run_held(tmp_path: Path) -> None:
    contract, dirs, _record = _first_run(tmp_path)
    root = tmp_path / "out"
    before = _snapshot(root)
    plan = _relaunch(tmp_path, contract, dirs, run_id="run-0000aaaa")
    _render_files(root, "sub-01", "partial", names=("axial.png",))
    # The sidecar stops here: no finish, restore or release.
    del plan

    lines = unit_reuse.recover(str(root), set())

    assert lines == [
        "Restored 4 earlier output folders or files that the interrupted "
        "run run-0000aaaa held aside."
    ]
    assert _snapshot(root) == before
    assert not (root / unit_reuse.HOLD_DIR).exists()


def test_recovery_keeps_the_output_of_a_run_that_recorded_it(tmp_path: Path) -> None:
    contract, dirs, _record = _first_run(tmp_path, ("sub-01",))
    root = tmp_path / "out"
    plan = _relaunch(tmp_path, contract, dirs, run_id="run-0000bbbb")
    _render_files(root, "sub-01", "new")
    unit_reuse.finish(plan, "run-0000bbbb")
    after = _snapshot(root)

    lines = unit_reuse.recover(str(root), {"run-0000bbbb"})

    assert lines == [
        "Removed the earlier output that run-0000bbbb held aside; its receipt "
        "records the new output."
    ]
    assert _snapshot(root) == after
    assert not (root / unit_reuse.HOLD_DIR).exists()


def test_recovery_leaves_an_area_without_a_manifest_and_says_so(
    tmp_path: Path,
) -> None:
    root = tmp_path / "out"
    area = root / unit_reuse.HOLD_DIR / "run-0000cccc"
    _write(area / "held" / "slices" / "sub-01" / "axial.png", "earlier")

    lines = unit_reuse.recover(str(root), set())

    assert len(lines) == 1
    assert "has no readable manifest" in lines[0]
    assert (area / "held" / "slices" / "sub-01" / "axial.png").exists()


def _tamper_held(tmp_path: Path, run_id: str) -> tuple[Path, Path, Path]:
    """Hold sub-01, render new output, then alter the held surface file."""
    contract, dirs, _record = _first_run(tmp_path, ("sub-01",))
    root = tmp_path / "out"
    plan = _relaunch(tmp_path, contract, dirs, run_id=run_id)
    _render_files(root, "sub-01", "new")
    assert plan.held_area is not None
    area = Path(plan.held_area)
    held = area / "held" / "surface" / "sub-01.png"
    held.write_bytes(b"altered while held")
    return root, area, held


def test_a_held_copy_that_does_not_verify_stays_held_on_restore(
    tmp_path: Path,
) -> None:
    contract, dirs, _record = _first_run(tmp_path, ("sub-01",))
    root = tmp_path / "out"
    earlier_slices = (root / "slices" / "sub-01" / "axial.png").read_bytes()
    plan = _relaunch(tmp_path, contract, dirs)
    _render_files(root, "sub-01", "new")
    assert plan.held_area is not None
    area = Path(plan.held_area)
    held = area / "held" / "surface" / "sub-01.png"
    held.write_bytes(b"altered while held")

    with pytest.raises(unit_reuse.UnitReuseError) as caught:
        unit_reuse.restore(plan)

    message = str(caught.value)
    assert str(held) in message
    assert str(root / "surface" / "sub-01.png") in message
    # The verified folder is back; the unverified copy never became current.
    assert (root / "slices" / "sub-01" / "axial.png").read_bytes() == earlier_slices
    assert (root / "surface" / "sub-01.png").read_text() == "sub-01 surface new"
    assert held.read_bytes() == b"altered while held"
    assert area.exists()


def test_recovery_keeps_an_area_whose_held_copy_does_not_verify(
    tmp_path: Path,
) -> None:
    root, area, held = _tamper_held(tmp_path, "run-0000dddd")
    current = root / "surface" / "sub-01.png"

    for _attempt in range(2):
        lines = unit_reuse.recover(str(root), set())

        assert any(str(held) in line and str(current) in line for line in lines)
        assert area.exists()
        assert held.read_bytes() == b"altered while held"
        assert current.read_text() == "sub-01 surface new"


def test_settling_the_last_area_removes_the_holding_folder(tmp_path: Path) -> None:
    contract, dirs, _record = _first_run(tmp_path, ("sub-01",))
    root = tmp_path / "out"
    plan = _relaunch(tmp_path, contract, dirs)
    assert (root / unit_reuse.HOLD_DIR).is_dir()

    unit_reuse.restore(plan)

    assert not (root / unit_reuse.HOLD_DIR).exists()


def test_a_subject_a_record_cannot_name_is_computed_and_listed(
    tmp_path: Path,
) -> None:
    contract, dirs, record = _first_run(tmp_path)
    dirs.update(_subjects(tmp_path, ("sub-\u00e91",)))

    plan = unit_reuse.decide(
        contract,
        {},
        dirs,
        _prior(record, RUN_1, 1),
        METHOD,
        reuse_enabled=True,
        contents=True,
    )
    _render(plan, "second")
    second = unit_reuse.finish(plan, RUN_2)

    assert plan.skipped()["slices"] == frozenset({"sub-01", "sub-02"})
    assert second["unrecordedSubjectIds"] == ["sub-\u00e91"]
    assert "sub-\u00e91" not in second["units"]
    assert unit_reuse_valid(second)
    assert unit_reuse.record_summary(second)["computedSubjectIds"] == ["sub-\u00e91"]
    assert unit_reuse.unrecorded_line(plan.unrecorded) is not None
    receipt = make_receipt(
        "4" * 64,
        {
            **_payload(),
            "scopeBinding": {"analysisSubjectIds": ["sub-01", "sub-02", "sub-\u00e91"]},
        },
        {"state": "done", "artifacts": []},
        run_id=RUN_2,
        job_id="job-2",
        committed_at_ms=2,
        unit_reuse=second,
    )
    assert receipt_record_contract_valid(receipt)
    nameable = copy.deepcopy(second)
    nameable["unrecordedSubjectIds"] = ["sub-03"]
    assert not unit_reuse_valid(nameable)


def test_the_runtime_digests_are_cached_while_the_files_are_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "VersionInfo.xml"
    _write(path, "<version>9.7</version>")
    first = enigma_units._file_sha256(str(path))
    reads: list[str] = []
    real_open = open

    def counting_open(file: Any, *args: Any, **kwargs: Any) -> Any:
        reads.append(str(file))
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr("builtins.open", counting_open)
    assert enigma_units._file_sha256(str(path)) == first
    assert reads == []
    monkeypatch.undo()
    _write(path, "<version>9.7 Update 10</version>")
    assert enigma_units._file_sha256(str(path)) != first
