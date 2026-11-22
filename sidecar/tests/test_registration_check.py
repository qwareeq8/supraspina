"""Tests for the advisory surface-registration check."""

from __future__ import annotations

import json
import math
import os
import statistics
import struct
import threading
from array import array
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import registration_check as rc
from supraspina_sidecar.freesurfer_environment import freesurfer_runtime_environment
from supraspina_sidecar.project import ProjectEpochs

VERTICES = 12
DFP_VERTICES = frozenset({0, 1, 2, 3, 4, 5})
MEDIAL_WALL = frozenset({11})
#: Seconds a test waits for a check before it fails instead of hanging. Each
#: wait ends on an event the test controls, so the bound decides no outcome.
HANG_GUARD = 60.0


def curv_bytes(values: list[float], *, faces: int = 0, trailer: bytes = b"") -> bytes:
    return (
        b"\xff\xff\xff"
        + struct.pack(">iii", len(values), faces, 1)
        + struct.pack(f">{len(values)}f", *values)
        + trailer
    )


def annot_bytes(
    labels: list[int | None],
    table: list[tuple[str, tuple[int, int, int]]],
    *,
    original_format: bool = False,
    with_table: bool = True,
) -> bytes:
    assigned = [
        (vertex, value) for vertex, value in enumerate(labels) if value is not None
    ]
    out = struct.pack(">i", len(labels))
    # A vertex without a pair keeps no label, as FreeSurfer writes it.
    out += struct.pack(">i", assigned[0][0]) + struct.pack(">i", assigned[0][1])
    for vertex, value in assigned[1:]:
        out += struct.pack(">ii", vertex, value)
    # Pad the pair block to vnum pairs by repeating the first assignment.
    for _ in range(len(labels) - len(assigned)):
        out += struct.pack(">ii", assigned[0][0], assigned[0][1])
    if not with_table:
        return out + struct.pack(">i", 0)
    out += struct.pack(">i", 1)
    origin = b"colortable.txt\x00"
    if original_format:
        out += struct.pack(">i", len(table)) + struct.pack(">i", len(origin)) + origin
        for name, (red, green, blue) in table:
            encoded = name.encode() + b"\x00"
            out += struct.pack(">i", len(encoded)) + encoded
            out += struct.pack(">iiii", red, green, blue, 0)
        return out
    out += struct.pack(">i", -2) + struct.pack(">i", len(table))
    out += struct.pack(">i", len(origin)) + origin + struct.pack(">i", len(table))
    for index, (name, (red, green, blue)) in enumerate(table):
        encoded = name.encode() + b"\x00"
        out += struct.pack(">i", index) + struct.pack(">i", len(encoded)) + encoded
        out += struct.pack(">iiii", red, green, blue, 0)
    return out


def color_value(red: int, green: int, blue: int) -> int:
    return red + (green << 8) + (blue << 16)


TABLE = [
    ("unknown", (25, 5, 25)),
    ("precentral", (60, 20, 220)),
    ("lateraloccipital", (20, 30, 140)),
]


def atlas_labels() -> list[int | None]:
    labels: list[int | None] = []
    for vertex in range(VERTICES):
        if vertex in MEDIAL_WALL:
            labels.append(color_value(*TABLE[0][1]))
        elif vertex in DFP_VERTICES:
            labels.append(color_value(*TABLE[1][1]))
        else:
            labels.append(color_value(*TABLE[2][1]))
    return labels


def atlas_sulc() -> list[float]:
    return [math.sin(vertex * 1.3) * 3 + vertex * 0.1 for vertex in range(VERTICES)]


# -- Readers -------------------------------------------------------------------


def test_parse_curv_reads_big_endian_values_and_ignores_a_trailer() -> None:
    values = [1.5, -2.25, 0.0, 3.0]

    parsed = rc.parse_curv(curv_bytes(values, faces=4, trailer=b"\x00\x01"))

    assert list(parsed) == values


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"\x00\x00\x00" + struct.pack(">iii", 1, 0, 1) + b"\x00" * 4, "not a Free"),
        (b"\xff\xff\xff" + struct.pack(">iii", 0, 0, 1), "header"),
        (b"\xff\xff\xff" + struct.pack(">iii", 2, 0, 3) + b"\x00" * 24, "header"),
        (b"\xff\xff\xff" + struct.pack(">iii", 4, 0, 1) + b"\x00" * 8, "shorter"),
        (curv_bytes([1.0, float("nan")]), "not finite"),
        (b"\xff\xff", "not a Free"),
    ],
)
def test_parse_curv_rejects_malformed_files(data: bytes, message: str) -> None:
    with pytest.raises(rc.RegistrationCheckError, match=message):
        rc.parse_curv(data)


def test_read_curv_follows_a_symbolic_link_and_reports_a_missing_file(
    tmp_path: Path,
) -> None:
    target = tmp_path / "lh.sulc"
    target.write_bytes(curv_bytes([0.5, 1.5, 2.5]))
    link = tmp_path / "link.sulc"
    link.symlink_to(target)

    assert list(rc.read_curv(link)) == [0.5, 1.5, 2.5]
    with pytest.raises(rc.RegistrationCheckError, match="not readable"):
        rc.read_curv(tmp_path / "missing.sulc")


@pytest.mark.parametrize("original_format", [False, True])
def test_parse_annot_maps_each_vertex_to_its_structure(original_format: bool) -> None:
    labels = atlas_labels()
    labels[7] = None
    labels[8] = color_value(1, 2, 3)

    names = rc.parse_annot(annot_bytes(labels, TABLE, original_format=original_format))

    assert names[0] == "precentral"
    assert names[6] == "lateraloccipital"
    assert names[11] == "unknown"
    # A vertex without a pair and a value without a table entry have no name.
    assert names[7] is None
    assert names[8] is None


def test_parse_annot_rejects_a_missing_table_and_an_out_of_range_vertex() -> None:
    with pytest.raises(rc.RegistrationCheckError, match="no color table"):
        rc.parse_annot(annot_bytes(atlas_labels(), TABLE, with_table=False))
    broken = bytearray(annot_bytes(atlas_labels(), TABLE))
    broken[4:8] = struct.pack(">i", VERTICES + 5)
    with pytest.raises(rc.RegistrationCheckError, match="out of range"):
        rc.parse_annot(bytes(broken))
    with pytest.raises(rc.RegistrationCheckError, match="ends early"):
        rc.parse_annot(annot_bytes(atlas_labels(), TABLE)[:40])


def test_region_masks_leave_out_the_medial_wall_and_unnamed_vertices() -> None:
    names: list[str | None] = [
        "precentral",
        "superiorfrontal",
        "lingual",
        "unknown",
        "corpuscallosum",
        None,
    ]

    masks = rc.region_masks(names)

    assert list(masks["cortex"]) == [0, 1, 2]
    assert list(masks["dfp"]) == [0, 1]


# -- Correlation and rule -------------------------------------------------------


def test_pearson_matches_the_standard_library_over_the_selected_indices() -> None:
    x = [1.0, 2.0, 4.0, 8.0, 3.0, 100.0]
    y = [2.0, 1.0, 5.0, 9.0, 1.0, -100.0]
    indices = [0, 1, 2, 3, 4]

    expected = statistics.correlation([x[i] for i in indices], [y[i] for i in indices])

    assert rc.pearson(x, y, indices) == pytest.approx(expected, abs=1e-12)
    assert rc.pearson(x, x, indices) == pytest.approx(1.0)
    assert rc.pearson(x, [-value for value in x], indices) == pytest.approx(-1.0)


def test_pearson_refuses_constant_or_tiny_regions() -> None:
    with pytest.raises(rc.RegistrationCheckError, match="constant"):
        rc.pearson([1.0, 1.0, 1.0], [1.0, 2.0, 3.0], [0, 1, 2])
    with pytest.raises(rc.RegistrationCheckError, match="three"):
        rc.pearson([1.0, 2.0], [1.0, 2.0], [0, 1])


def test_robust_reference_needs_enough_hemispheres_and_keeps_a_scale_floor() -> None:
    assert rc.robust_reference([0.8] * (rc.MIN_COHORT_HEMISPHERES - 1)) is None
    uniform = rc.robust_reference([0.8] * rc.MIN_COHORT_HEMISPHERES)
    assert uniform == rc.Reference(0.8, rc.MIN_ROBUST_SCALE)
    values = [0.80 + 0.01 * (index % 5) for index in range(40)]
    reference = rc.robust_reference(values)
    assert reference is not None
    assert reference.median == pytest.approx(statistics.median(values))
    deviation = statistics.median(abs(v - reference.median) for v in values)
    assert reference.scale == pytest.approx(1.4826 * deviation)


def test_cohort_references_fall_back_to_the_calibration_reference() -> None:
    source, references = rc.cohort_references([(0.8, 0.8)] * 5)

    assert source == "builtin"
    assert references["dfp"] == rc.Reference(*rc.BUILTIN_REFERENCE["dfp"])
    source, references = rc.cohort_references(
        [(0.83 + 0.001 * i, 0.85 + 0.002 * i) for i in range(30)]
    )
    assert source == "cohort"
    assert references["cortex"].median == pytest.approx(0.8445)


def test_only_a_complete_set_is_its_own_reference() -> None:
    results = [(0.80 + 0.001 * i, 0.82 + 0.001 * i) for i in range(30)]
    settled = rc.JudgingReference(
        "cohort",
        180,
        {"cortex": rc.Reference(0.8342, 0.0198), "dfp": rc.Reference(0.8556, 0.0235)},
    )

    complete = rc.judging_reference(results, True, settled)
    partial = rc.judging_reference(results, False, settled)
    first = rc.judging_reference(results, False, None)
    small = rc.judging_reference(results[:5], True, settled)

    assert (complete.source, complete.hemispheres) == ("cohort", 30)
    assert complete.measures["cortex"].median == pytest.approx(0.8145)
    assert partial == settled
    assert (first.source, first.hemispheres) == ("builtin", None)
    assert first.measures["dfp"] == rc.Reference(*rc.BUILTIN_REFERENCE["dfp"])
    assert (small.source, small.hemispheres) == ("builtin", None)


def test_assess_flags_a_low_robust_z_on_either_measure() -> None:
    references = {"cortex": rc.Reference(0.83, 0.02), "dfp": rc.Reference(0.85, 0.02)}

    normal = rc.assess(0.82, 0.84, references)
    frontal = rc.assess(0.80, 0.77, references)
    occipital = rc.assess(0.74, 0.83, references)
    edge = rc.assess(0.83, 0.85 + 0.02 * rc.ROBUST_Z_LIMIT, references)

    assert not normal.flagged
    assert (frontal.flagged, frontal.measure) == (True, "dfp")
    assert frontal.z == pytest.approx(-4.0)
    assert (occipital.flagged, occipital.measure) == (True, "cortex")
    # The limit itself is not below the limit.
    assert not edge.flagged


def test_assess_flags_a_correlation_under_the_floor_in_a_poor_cohort() -> None:
    references = {"cortex": rc.Reference(0.60, 0.10), "dfp": rc.Reference(0.62, 0.10)}

    decision = rc.assess(0.66, 0.65, references)

    assert decision.flagged
    assert decision.measure == "dfp"
    assert decision.z > rc.ROBUST_Z_LIMIT


# -- Project fixtures -------------------------------------------------------------


def write_atlas(home: Path) -> Path:
    fsaverage = home / "subjects" / "fsaverage"
    (fsaverage / "surf").mkdir(parents=True)
    (fsaverage / "label").mkdir()
    for hemi in rc.HEMISPHERES:
        (fsaverage / "surf" / f"{hemi}.sulc").write_bytes(curv_bytes(atlas_sulc()))
        (fsaverage / "surf" / f"{hemi}.sphere.reg").write_bytes(b"fsaverage sphere")
        (fsaverage / "label" / f"{hemi}.aparc.annot").write_bytes(
            annot_bytes(atlas_labels(), TABLE)
        )
    return fsaverage


def good_sulc(seed: int) -> list[float]:
    return [
        value + 0.02 * math.cos(vertex * (seed + 2))
        for vertex, value in enumerate(atlas_sulc())
    ]


def write_subject(root: Path, subject: str, sulc: dict[str, list[float]]) -> None:
    surf = root / "derivatives" / "freesurfer" / subject / "surf"
    surf.mkdir(parents=True)
    for hemi, values in sulc.items():
        (surf / f"{hemi}.sulc").write_bytes(curv_bytes(values))
        (surf / f"{hemi}.sphere.reg").write_bytes(f"{subject} {hemi} sphere".encode())


class Harness:
    """A project, a fake FreeSurfer, and a resampler that counts its calls."""

    def __init__(self, tmp_path: Path, subjects: int = 12) -> None:
        self.root = (tmp_path / "project").resolve()
        self.root.mkdir()
        (self.root / "rawdata").mkdir()
        self.home = tmp_path / "freesurfer"
        self.fsaverage = write_atlas(self.home)
        for index in range(subjects):
            write_subject(
                self.root,
                f"sub-{index + 1:02d}",
                {"lh": good_sulc(index), "rh": good_sulc(index + 50)},
            )
        self.calls: list[tuple[str, str]] = []
        # The condition each resample call is announced on, so a test waits
        # for a call rather than polling for it.
        self._called = threading.Condition()
        self.gate: threading.Event | None = None
        self.fail: set[tuple[str, str]] = set()
        self.fail_message = "mri_surf2surf ended with exit code 1."
        self.setup_fails_after: int | None = None
        # The setup probe resamples fsaverage onto itself.
        self.probe_failure: rc.RegistrationCheckError | None = None
        self.probe_gate: threading.Event | None = None
        self.available = True
        self.license = ""
        self.epochs = ProjectEpochs()
        self.manager = self.new_manager()

    def new_manager(self) -> rc.SurfaceRegistrationManager:
        return rc.SurfaceRegistrationManager(
            self.epochs,
            resampler=self.resample,
            availability=self.availability,
            max_workers=2,
        )

    def availability(self, _cfg: dict[str, Any]) -> rc.Availability:
        if not self.available:
            return rc.Availability(False, "The check needs FreeSurfer.")
        return rc.Availability(
            True, None, str(self.home), "/bin/true", str(self.fsaverage), self.license
        )

    def resample(
        self,
        job: rc.ResampleJob,
        work_dir: str,
        cancel: threading.Event,
        track: Any,
    ) -> array:
        subject = os.path.basename(job.subject_dir)
        with self._called:
            self.calls.append((subject, job.hemi))
            # Number the call where it is recorded, so exactly the calls after
            # setup_fails_after fail however the workers interleave.
            number = len(self.calls)
            self._called.notify_all()
        assert os.path.isdir(work_dir)
        track(None)
        # A gate holds its call until the test opens it; the hang guard only
        # keeps a failed test from blocking its worker forever.
        if self.gate is not None:
            self.gate.wait(HANG_GUARD)
            if cancel.is_set():
                raise rc._Cancelled
        if self.setup_fails_after is not None and number > self.setup_fails_after:
            raise rc.RegistrationEnvironmentError(rc._LICENSE_REJECTED)
        if subject == "fsaverage":
            if self.probe_gate is not None:
                self.probe_gate.wait(HANG_GUARD)
                if cancel.is_set():
                    raise rc._Cancelled
            if self.probe_failure is not None:
                raise self.probe_failure
        if (subject, job.hemi) in self.fail:
            raise rc.RegistrationCheckError(self.fail_message)
        return rc.read_curv(os.path.join(job.subject_dir, "surf", f"{job.hemi}.sulc"))

    def request(self, **extra: Any) -> dict[str, Any]:
        cfg = {
            "paths": {
                "projectRoot": str(self.root),
                "rawdataDir": str(self.root / "rawdata"),
                "derivativesDir": str(self.root / "derivatives"),
            },
            "subjects": {"exclude": ["sub-12"]},
        }
        return {
            "project": {
                "projectId": "project-a",
                "root": str(self.root),
                "configPath": "",
                "epoch": 1,
            },
            "cfg": cfg,
            "configRevision": 3,
            "configSha256": "0" * 64,
            **extra,
        }

    def run(self, **extra: Any) -> dict[str, Any]:
        started = self.manager.check(self.request(**extra))
        return self.wait(started["operation"]["operationId"])

    def wait_for_call(self, made: Callable[[list[tuple[str, str]]], bool]) -> None:
        """Return once the resample calls made so far satisfy ``made``."""
        with self._called:
            assert self._called.wait_for(lambda: made(self.calls), HANG_GUARD), (
                f"The awaited resample call never came: {self.calls}."
            )

    def wait(self, operation_id: str) -> dict[str, Any]:
        """Return the status once the check's thread has ended.

        A status read while the check runs can meet the cache file mid-replace
        and read it as empty; after the thread ends, nothing writes it.
        """
        operation = self.manager._operation
        assert operation is not None
        assert operation.operation_id == operation_id
        finish(operation)
        status = self.manager.status(self.request())
        assert status["operation"]["operationId"] == operation_id
        assert status["operation"]["state"] != "running"
        return status


def finish(operation: rc._Operation) -> None:
    """Wait for a check's thread to end, failing instead of hanging."""
    thread = operation.thread
    assert thread is not None
    thread.join(HANG_GUARD)
    assert not thread.is_alive(), "The check did not finish."


def hemisphere(status: dict[str, Any], subject: str, hemi: str) -> dict[str, Any]:
    row = next(item for item in status["subjects"] if item["subjectId"] == subject)
    return next(item for item in row["hemispheres"] if item["hemisphere"] == hemi)


def probe_calls(harness: Harness) -> list[tuple[str, str]]:
    return [call for call in harness.calls if call[0] == "fsaverage"]


# -- Manager -----------------------------------------------------------------------


def test_status_lists_pending_hemispheres_in_config_scope(tmp_path: Path) -> None:
    harness = Harness(tmp_path)
    (harness.root / "derivatives" / "freesurfer" / "fsaverage").mkdir()
    (harness.root / "derivatives" / "freesurfer" / "notes.txt").write_text("x")

    status = harness.manager.status(harness.request())

    assert status["available"] is True
    assert status["configRevision"] == 3
    assert status["operation"] is None
    assert [row["subjectId"] for row in status["subjects"]] == [
        f"sub-{index:02d}" for index in range(1, 12)
    ]
    assert status["counts"]["pending"] == 22
    assert status["reference"]["source"] == "builtin"
    assert harness.calls == []


def test_check_flags_the_misregistered_hemisphere_and_caches_results(
    tmp_path: Path,
) -> None:
    harness = Harness(tmp_path)
    shifted = list(reversed(atlas_sulc()))
    (
        harness.root / "derivatives" / "freesurfer" / "sub-03" / "surf" / "rh.sulc"
    ).write_bytes(curv_bytes(shifted))

    status = harness.run()

    assert status["operation"]["state"] == "done"
    assert status["operation"]["completed"] == 22
    assert status["counts"]["checked"] == 22
    assert status["counts"]["flaggedSubjects"] == 1
    assert status["counts"]["flaggedHemispheres"] == 1
    assert status["reference"]["source"] == "cohort"
    flagged = hemisphere(status, "sub-03", "rh")
    assert flagged["flagged"] is True
    assert flagged["rDfp"] < rc.ABSOLUTE_FLOOR
    assert hemisphere(status, "sub-03", "lh")["flagged"] is False
    assert next(row for row in status["subjects"] if row["subjectId"] == "sub-03")[
        "flagged"
    ]
    store = json.loads(
        (harness.root / ".supraspina" / "surface-registration.json").read_text()
    )
    assert store["method"] == rc.METHOD
    assert store["atlasSha256"] == rc.atlas_digest(str(harness.fsaverage))
    assert set(store["entries"]) == {
        f"sub-{index:02d}:{hemi}" for index in range(1, 12) for hemi in ("lh", "rh")
    }
    assert len(harness.calls) == 22


def test_a_reopened_project_reads_the_cache_without_resampling(tmp_path: Path) -> None:
    harness = Harness(tmp_path)
    harness.run()
    harness.calls.clear()
    harness.manager = harness.new_manager()

    status = harness.manager.status(harness.request())
    again = harness.run()

    assert status["counts"]["checked"] == 22
    assert status["counts"]["pending"] == 0
    assert again["operation"]["total"] == 0
    assert harness.calls == []


def test_the_cache_key_is_the_content_of_both_input_files(tmp_path: Path) -> None:
    harness = Harness(tmp_path)
    harness.run()
    harness.calls.clear()
    surf = harness.root / "derivatives" / "freesurfer" / "sub-02" / "surf"
    # A new time stamp on unchanged content reads as unchecked until hashed,
    # and the check then keeps the cached result without resampling.
    os.utime(surf / "lh.sulc", ns=(1_000_000_000, 1_000_000_000))
    assert (
        hemisphere(harness.manager.status(harness.request()), "sub-02", "lh")["state"]
        == "pending"
    )
    touched = harness.run()
    assert touched["operation"]["total"] == 1
    assert harness.calls == []
    assert hemisphere(touched, "sub-02", "lh")["state"] == "checked"
    # Changed content is checked again.
    (surf / "rh.sphere.reg").write_bytes(b"a new registration")
    changed = harness.run()
    assert harness.calls == [("sub-02", "rh")]
    assert hemisphere(changed, "sub-02", "rh")["state"] == "checked"


def test_a_changed_atlas_or_method_makes_every_result_stale(tmp_path: Path) -> None:
    harness = Harness(tmp_path)
    harness.run()
    path = harness.root / ".supraspina" / "surface-registration.json"
    document = json.loads(path.read_text())
    document["method"] = "an-earlier-method"
    path.write_text(json.dumps(document))

    assert harness.manager.status(harness.request())["counts"]["pending"] == 22
    harness.run()
    (harness.fsaverage / "surf" / "lh.sphere.reg").write_bytes(b"another atlas")

    assert harness.manager.status(harness.request())["counts"]["pending"] == 22


@pytest.mark.parametrize(
    "content",
    [
        b"not json",
        b"[]",
        json.dumps({"schemaVersion": 99, "method": rc.METHOD, "entries": {}}).encode(),
    ],
)
def test_an_unusable_cache_reads_as_empty(tmp_path: Path, content: bytes) -> None:
    (tmp_path / ".supraspina").mkdir()
    (tmp_path / ".supraspina" / "surface-registration.json").write_bytes(content)

    assert rc.load_store(str(tmp_path))["entries"] == {}


def test_load_store_drops_invalid_entries(tmp_path: Path) -> None:
    good = {
        "sphereRegSha256": "a" * 64,
        "sulcSha256": "b" * 64,
        "sphereRegStat": [1, 2, 3],
        "sulcStat": [4, 5, 6],
        "rCortex": 0.8,
        "rDfp": 0.9,
        "error": None,
        "seconds": 2.0,
        "checkedAt": "2026-09-25T00:00:00.000Z",
    }
    store = rc._empty_store("c" * 64)
    store["entries"] = {
        "sub-01:lh": good,
        "sub-01:xh": good,
        "../x:lh": good,
        "sub-02:lh": {**good, "rDfp": 1.5},
        "sub-03:lh": {**good, "error": "It failed.", "rCortex": None, "rDfp": None},
        "sub-04:lh": {**good, "error": "It failed."},
    }
    rc.write_store(str(tmp_path), store)

    loaded = rc.load_store(str(tmp_path))

    assert loaded["atlasSha256"] == "c" * 64
    assert set(loaded["entries"]) == {"sub-01:lh", "sub-03:lh"}


class ReplaceDuringRead:
    """Run ``replace`` right after a read of ``path`` has taken its lstat.

    The bounded reader compares the file it lstat-ed with the one it opened.
    A replace in between is what a status poll meets when a running check
    writes the cache: the path names another file by the time it opens.
    """

    def __init__(
        self,
        monkeypatch: pytest.MonkeyPatch,
        path: str,
        replace: Callable[[], None],
        times: int,
    ) -> None:
        self.reads = 0
        self._left = times
        real_lstat = Path.lstat

        def lstat(candidate: Path) -> os.stat_result:
            info = real_lstat(candidate)
            if str(candidate) == path:
                self.reads += 1
                if self._left > 0:
                    self._left -= 1
                    replace()
            return info

        monkeypatch.setattr(Path, "lstat", lstat)


def checked_store(*keys: str) -> dict[str, Any]:
    store = rc._empty_store("c" * 64)
    for key in keys:
        store["entries"][key] = {
            "sphereRegSha256": "a" * 64,
            "sulcSha256": "b" * 64,
            "sphereRegStat": [1, 2, 3],
            "sulcStat": [4, 5, 6],
            "rCortex": 0.8,
            "rDfp": 0.9,
            "error": None,
            "seconds": 2.0,
            "checkedAt": "2026-09-25T00:00:00.000Z",
        }
    return store


@pytest.mark.parametrize("replaces", [1, 2])
def test_a_read_that_meets_a_cache_replace_reads_the_new_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, replaces: int
) -> None:
    root = str(tmp_path)
    rc.write_store(root, checked_store("sub-01:lh"))
    race = ReplaceDuringRead(
        monkeypatch,
        rc.store_path(root),
        lambda: rc.write_store(root, checked_store("sub-01:lh", "sub-01:rh")),
        replaces,
    )

    loaded = rc.load_store(root)

    assert set(loaded["entries"]) == {"sub-01:lh", "sub-01:rh"}
    assert race.reads == replaces + 1


def test_a_cache_that_changes_under_every_read_reads_as_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = str(tmp_path)
    rc.write_store(root, checked_store("sub-01:lh"))
    race = ReplaceDuringRead(
        monkeypatch,
        rc.store_path(root),
        lambda: rc.write_store(root, checked_store("sub-01:lh")),
        rc._STORE_READ_ATTEMPTS,
    )

    assert rc.load_store(root)["entries"] == {}
    assert race.reads == rc._STORE_READ_ATTEMPTS


def test_a_failed_hemisphere_is_cached_and_retried_only_on_request(
    tmp_path: Path,
) -> None:
    harness = Harness(tmp_path)
    harness.fail = {("sub-05", "lh")}

    status = harness.run()

    assert status["operation"]["failed"] == 1
    row = hemisphere(status, "sub-05", "lh")
    assert row["state"] == "failed"
    assert row["message"] == "mri_surf2surf ended with exit code 1."
    assert status["counts"]["failed"] == 1
    # Earlier resamples succeeded, so the setup needed no probe.
    assert probe_calls(harness) == []
    harness.calls.clear()
    assert harness.run()["operation"]["total"] == 0
    harness.fail = set()
    retried = harness.run(retryFailed=True)
    assert harness.calls == [("sub-05", "lh")]
    assert hemisphere(retried, "sub-05", "lh")["state"] == "checked"


def test_cancel_stops_the_check_and_keeps_finished_results(tmp_path: Path) -> None:
    harness = Harness(tmp_path)
    harness.gate = threading.Event()
    started = harness.manager.check(harness.request())
    operation_id = started["operation"]["operationId"]
    again = harness.manager.check(harness.request())
    assert again == {"operation": again["operation"], "started": False}
    assert again["operation"]["operationId"] == operation_id

    stopped = harness.manager.cancel(harness.request(operationId=operation_id))
    harness.gate.set()
    status = harness.wait(operation_id)

    assert stopped == {"operationId": operation_id, "stopped": True}
    assert status["operation"]["state"] == "cancelled"
    assert status["operation"]["completed"] < 22
    assert harness.manager.cancel(harness.request(operationId=operation_id)) == {
        "operationId": operation_id,
        "stopped": False,
    }


def test_status_never_reports_a_finish_newer_than_its_results(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = Harness(tmp_path, subjects=1)
    harness.gate = threading.Event()
    started = harness.manager.check(harness.request())
    operation = harness.manager._operation
    assert operation is not None
    gate = harness.gate
    assert gate is not None
    # Both hemispheres wait at the gate, so neither result is cached yet.
    harness.wait_for_call(lambda calls: len(calls) == 2)
    real_load_store = rc.load_store

    def load_then_finish(project_root: str) -> dict[str, Any]:
        # The check finishes right after status reads the results.
        store = real_load_store(project_root)
        gate.set()
        finish(operation)
        return store

    monkeypatch.setattr(rc, "load_store", load_then_finish)
    racing = harness.manager.status(harness.request())
    monkeypatch.setattr(rc, "load_store", real_load_store)
    settled = harness.manager.status(harness.request())

    assert operation.state == "done"
    assert racing["operation"]["operationId"] == started["operation"]["operationId"]
    assert racing["operation"]["state"] == "running"
    assert racing["counts"]["pending"] == 2
    assert settled["operation"]["state"] == "done"
    assert settled["counts"]["checked"] == 2


# -- Flags while a check runs --------------------------------------------------------

CALIBRATION = Path(__file__).parent / "fixtures" / "registration-calibration.tsv"


def calibration_rows() -> list[tuple[str, str, float, float, bool]]:
    """Return the synthetic calibration rows in listing order."""
    lines = [
        line.rstrip("\n")
        for line in CALIBRATION.read_text(encoding="ascii").splitlines()
        if not line.startswith("#")
    ]
    assert lines[0].split("\t") == [
        "subject",
        "hemi",
        "r_cortex",
        "r_dfp",
        "misregistered",
    ]
    rows: list[tuple[str, str, float, float, bool]] = []
    for line in lines[1:]:
        subject, hemi, r_cortex, r_dfp, misregistered = line.split("\t")
        rows.append(
            (subject, hemi, float(r_cortex), float(r_dfp), misregistered == "yes")
        )
    return rows


class Replay:
    """Replay the synthetic calibration correlations, one hemisphere per step.

    The check walks the listing in order with one worker, so it meets the
    hemispheres in fixture order: every control first, then every SCI
    subject. While pacing is on, each resample announces its start and waits
    until :meth:`advance` lets it finish, so the test reads status only at
    points it controls, never while the check writes its cache.
    """

    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.harness = Harness(tmp_path, subjects=0)
        rows = calibration_rows()
        self.keys = [(subject, hemi) for subject, hemi, *_rest in rows]
        self.values = {(row[0], row[1]): (row[2], row[3]) for row in rows}
        self.misregistered = {(row[0], row[1]) for row in rows if row[4]}
        for subject in dict.fromkeys(key[0] for key in self.keys):
            write_subject(
                self.harness.root, subject, {"lh": good_sulc(0), "rh": good_sulc(1)}
            )
        self.paced = True
        # Resamples started, and resamples let finish, in the paced check.
        self._turn = threading.Condition()
        self._started = 0
        self._released = 0
        self.harness.manager = rc.SurfaceRegistrationManager(
            self.harness.epochs,
            resampler=self.resample,
            availability=self.harness.availability,
            max_workers=1,
        )
        monkeypatch.setattr(rc, "measure_hemisphere", self.measure)

    @property
    def manager(self) -> rc.SurfaceRegistrationManager:
        return self.harness.manager

    def request(self, **extra: Any) -> dict[str, Any]:
        return self.harness.request(**extra)

    def start(self) -> dict[str, Any]:
        """Start a paced check; each hemisphere then waits for :meth:`advance`."""
        with self._turn:
            self._started = 0
            self._released = 0
        self.paced = True
        return self.manager.check(self.request())

    def cancel(self, operation_id: str) -> dict[str, Any]:
        """Stop the check and wake the resample that waits for its step."""
        stopped = self.manager.cancel(self.request(operationId=operation_id))
        with self._turn:
            self._turn.notify_all()
        return stopped

    def resample(
        self,
        job: rc.ResampleJob,
        _work_dir: str,
        cancel: threading.Event,
        track: Any,
    ) -> array:
        track(None)
        if self.paced:
            with self._turn:
                self._started += 1
                turn = self._started
                self._turn.notify_all()
                assert self._turn.wait_for(
                    lambda: self._released >= turn or cancel.is_set(), HANG_GUARD
                ), f"Hemisphere {turn} was never let finish."
                if self._released < turn:
                    raise rc._Cancelled
        key = (os.path.basename(job.subject_dir), job.hemi)
        return array("f", [float(self.keys.index(key))])

    def measure(
        self, resampled: array, _atlas: rc.HemisphereAtlas
    ) -> tuple[float, float]:
        return self.values[self.keys[int(resampled[0])]]

    def let_finish(self, completed: int) -> None:
        """Let hemispheres up to ``completed`` finish without waiting for them."""
        with self._turn:
            self._released = completed
            self._turn.notify_all()

    def advance(self, completed: int) -> dict[str, Any]:
        """Let hemisphere ``completed`` finish and return the status once it has.

        The one worker starts the next resample only after it has recorded
        and counted this hemisphere, and after the last one the check's thread
        ends; the status is read at that point, when nothing writes the cache.
        """
        operation = self.manager._operation
        assert operation is not None
        last = completed >= operation.total
        with self._turn:
            self._released = completed
            self._turn.notify_all()
            if not last:
                assert self._turn.wait_for(
                    lambda: self._started > completed, HANG_GUARD
                ), f"Hemisphere {completed} did not finish."
        if last:
            finish(operation)
        return self.manager.status(self.request())

    def replace_registration(self, subject: str, hemi: str) -> None:
        surf = self.harness.root / "derivatives" / "freesurfer" / subject / "surf"
        (surf / f"{hemi}.sphere.reg").write_bytes(f"{subject} {hemi} again".encode())


def flagged_hemispheres(status: dict[str, Any]) -> set[tuple[str, str]]:
    return {
        (row["subjectId"], item["hemisphere"])
        for row in status["subjects"]
        for item in row["hemispheres"]
        if item["flagged"]
    }


def builtin_reference(status: dict[str, Any]) -> bool:
    reference = status["reference"]
    return reference["source"] == "builtin" and all(
        (reference[measure]["median"], reference[measure]["scale"])
        == rc.BUILTIN_REFERENCE[measure]
        for measure in rc.MEASURES
    )


def test_flags_only_accumulate_while_a_check_walks_the_calibration_set(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    replay = Replay(tmp_path, monkeypatch)
    total = len(replay.keys)
    started = replay.start()
    operation_id = started["operation"]["operationId"]
    assert started["operation"]["total"] == total == 180

    shown: set[tuple[str, str]] = set()
    subject_counts: list[int] = []
    for completed in range(1, total + 1):
        status = replay.advance(completed)
        now = flagged_hemispheres(status)
        # A flag, once shown, stays until the check ends.
        assert shown <= now, f"a flag disappeared at {completed} of {total}"
        if status["operation"]["state"] == "running":
            # A partial, control-only set never becomes the reference.
            assert builtin_reference(status), f"reference moved at {completed}"
        shown = now
        subject_counts.append(status["counts"]["flaggedSubjects"])
    final = replay.harness.wait(operation_id)

    assert final["operation"]["state"] == "done"
    assert subject_counts == sorted(subject_counts)
    assert shown <= flagged_hemispheres(final)
    assert flagged_hemispheres(final) == replay.misregistered
    assert final["counts"]["flaggedHemispheres"] == 12
    assert final["counts"]["flaggedSubjects"] == 11
    assert final["reference"] == {
        "source": "cohort",
        "hemispheres": 180,
        "cortex": {"median": 0.8342, "scale": 0.0198},
        "dfp": {"median": 0.8556, "scale": 0.0235},
    }


def test_a_recheck_of_a_few_hemispheres_keeps_every_flag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    replay = Replay(tmp_path, monkeypatch)
    replay.paced = False
    first = replay.harness.run()
    assert flagged_hemispheres(first) == replay.misregistered
    stored = json.loads(
        (replay.harness.root / ".supraspina" / "surface-registration.json").read_text()
    )
    assert stored["reference"] == {
        "hemispheres": 180,
        "cortex": [
            pytest.approx(first["reference"]["cortex"]["median"], abs=5e-5),
            pytest.approx(first["reference"]["cortex"]["scale"], abs=5e-5),
        ],
        "dfp": [
            pytest.approx(first["reference"]["dfp"]["median"], abs=5e-5),
            pytest.approx(first["reference"]["dfp"]["scale"], abs=5e-5),
        ],
    }
    # Three unflagged hemispheres get new registrations with lower values.
    changed = [("sub-c01", "lh"), ("sub-c02", "rh"), ("sub-p01", "lh")]
    for subject, hemi in changed:
        replay.replace_registration(subject, hemi)
        replay.values[(subject, hemi)] = (0.80, 0.82)

    waiting = replay.manager.status(replay.request())
    assert waiting["counts"]["pending"] == 3
    assert flagged_hemispheres(waiting) == replay.misregistered
    assert waiting["reference"] == first["reference"]

    started = replay.start()
    assert started["operation"]["total"] == 3
    for completed in range(1, 4):
        status = replay.advance(completed)
        assert replay.misregistered <= flagged_hemispheres(status)
        if completed < 3:
            # The check judges against the reference shown when it started.
            assert status["operation"]["state"] == "running"
            assert status["operation"]["completed"] == completed
            assert status["reference"] == first["reference"]
    final = replay.harness.wait(started["operation"]["operationId"])

    assert flagged_hemispheres(final) == replay.misregistered
    assert final["reference"]["source"] == "cohort"
    assert final["reference"]["hemispheres"] == 180


def test_a_status_read_that_meets_a_cache_write_keeps_every_flag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    replay = Replay(tmp_path, monkeypatch)
    replay.paced = False
    first = replay.harness.run()
    assert flagged_hemispheres(first) == replay.misregistered
    for subject, hemi in [("sub-c01", "lh"), ("sub-c02", "rh")]:
        replay.replace_registration(subject, hemi)
    started = replay.start()
    assert started["operation"]["total"] == 2
    # No hemisphere may finish yet: the check has read the cache and waits in
    # its first resample.
    replay.advance(0)
    written = threading.Condition()
    writes: list[str] = []
    real_write_store = rc.write_store

    def counted_write_store(project_root: str, store: dict[str, Any]) -> None:
        real_write_store(project_root, store)
        with written:
            writes.append(project_root)
            written.notify_all()

    def record_the_first_hemisphere() -> None:
        # The check replaces the cache with its first result while the status
        # read is between its lstat and its open.
        replay.let_finish(1)
        with written:
            assert written.wait_for(lambda: len(writes) == 1, HANG_GUARD)

    monkeypatch.setattr(rc, "write_store", counted_write_store)
    race = ReplaceDuringRead(
        monkeypatch,
        rc.store_path(str(replay.harness.root)),
        record_the_first_hemisphere,
        1,
    )
    racing = replay.manager.status(replay.request())

    assert racing["operation"]["state"] == "running"
    assert flagged_hemispheres(racing) == replay.misregistered
    assert racing["counts"]["pending"] == 1
    assert racing["reference"] == first["reference"]
    assert writes == [str(replay.harness.root)]
    assert race.reads == 2
    final = replay.advance(2)
    assert final["operation"]["state"] == "done"
    assert flagged_hemispheres(final) == replay.misregistered


def test_a_stopped_check_judges_its_partial_set_against_the_calibration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    replay = Replay(tmp_path, monkeypatch)
    started = replay.start()
    operation_id = started["operation"]["operationId"]
    for completed in range(1, 61):
        status = replay.advance(completed)
    shown = flagged_hemispheres(status)

    replay.cancel(operation_id)
    stopped = replay.harness.wait(operation_id)

    assert stopped["operation"]["state"] == "cancelled"
    assert stopped["counts"]["checked"] == 60
    # 60 control hemispheres are not the cohort: the calibration stays the
    # reference, and every flag shown during the check stays.
    assert builtin_reference(stopped)
    assert flagged_hemispheres(stopped) == shown
    assert shown <= replay.misregistered
    assert "reference" not in json.loads(
        (replay.harness.root / ".supraspina" / "surface-registration.json").read_text()
    )


def test_load_store_keeps_a_valid_settled_reference_only(tmp_path: Path) -> None:
    store = rc._empty_store("c" * 64)
    store["reference"] = {
        "hemispheres": 180,
        "cortex": [0.8342, 0.0198],
        "dfp": [0.8556, 0.0235],
    }
    rc.write_store(str(tmp_path), store)

    assert rc.load_store(str(tmp_path))["reference"] == store["reference"]

    for invalid in (
        {**store["reference"], "hemispheres": rc.MIN_COHORT_HEMISPHERES - 1},
        {**store["reference"], "dfp": [1.5, 0.02]},
        {**store["reference"], "cortex": [0.83, 0.0]},
        {**store["reference"], "extra": True},
        [0.83, 0.02],
    ):
        store["reference"] = invalid
        rc.write_store(str(tmp_path), store)
        assert "reference" not in rc.load_store(str(tmp_path))


def test_a_project_change_cancels_the_running_check(tmp_path: Path) -> None:
    harness = Harness(tmp_path)
    harness.gate = threading.Event()
    started = harness.manager.check(harness.request())
    other = (tmp_path / "other").resolve()
    other.mkdir()
    request = harness.request()
    request["project"] = {
        "projectId": "project-b",
        "root": str(other),
        "configPath": "",
        "epoch": 1,
    }
    request["cfg"] = {"paths": {"projectRoot": str(other)}}

    status = harness.manager.status(request)
    harness.gate.set()

    assert status["operation"] is None
    assert status["subjects"] == []
    operation = harness.manager._operation
    assert operation is not None
    assert operation.operation_id == started["operation"]["operationId"]
    assert operation.state == "cancelled"
    assert operation.message == "The project changed."


def test_a_detached_project_stops_the_workers(tmp_path: Path) -> None:
    harness = Harness(tmp_path, subjects=3)
    harness.gate = threading.Event()
    started = harness.manager.check(harness.request())
    harness.epochs.detach(harness.request()["project"])
    harness.gate.set()
    harness.manager.stop_all(timeout=5)

    operation = harness.manager._operation
    assert operation is not None
    assert operation.operation_id == started["operation"]["operationId"]
    assert operation.state == "cancelled"
    assert operation.completed < 6


def test_check_needs_freesurfer_and_status_says_why(tmp_path: Path) -> None:
    harness = Harness(tmp_path)
    harness.available = False

    status = harness.manager.status(harness.request())

    assert status["available"] is False
    assert status["unavailableReason"] == "The check needs FreeSurfer."
    with pytest.raises(rc.RegistrationCheckError, match="needs FreeSurfer"):
        harness.manager.check(harness.request())


@pytest.mark.parametrize(
    ("extra", "message"),
    [
        ({"unexpected": 1}, "valid surface-registration request"),
        ({"retryFailed": "yes"}, "true or false"),
    ],
)
def test_check_rejects_invalid_requests(
    tmp_path: Path, extra: dict[str, Any], message: str
) -> None:
    harness = Harness(tmp_path, subjects=1)

    with pytest.raises(rc.RegistrationCheckError, match=message):
        harness.manager.check(harness.request(**extra))


def test_cancel_rejects_an_invalid_operation_id(tmp_path: Path) -> None:
    harness = Harness(tmp_path, subjects=1)

    with pytest.raises(rc.RegistrationCheckError, match="operation ID"):
        harness.manager.cancel(harness.request(operationId="../x"))


def test_freesurfer_availability_names_the_missing_piece(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("FREESURFER_HOME", raising=False)
    monkeypatch.delenv("FS_LICENSE", raising=False)
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    home = tmp_path / "freesurfer"
    cfg = {"tools": {"freesurferHome": str(home)}}

    unset = rc.freesurfer_availability({})
    home.mkdir()
    no_binary = rc.freesurfer_availability(cfg)
    binary = home / "bin" / "mri_surf2surf"
    binary.parent.mkdir()
    binary.write_text("#!/bin/sh\n")
    binary.chmod(0o755)
    no_atlas = rc.freesurfer_availability(cfg)
    write_atlas(home)
    no_license = rc.freesurfer_availability(cfg)
    license_file = home / "license.txt"
    license_file.touch()
    empty_license = rc.freesurfer_availability(cfg)
    license_file.write_text("user@example.org\n12345\n *key\n key2\n")
    ready = rc.freesurfer_availability(cfg)

    assert "no FreeSurfer install root" in (unset.reason or "")
    assert "mri_surf2surf" in (no_binary.reason or "")
    assert "fsaverage" in (no_atlas.reason or "")
    assert no_license == rc.Availability(
        False,
        "The check needs the FreeSurfer license, and the license file was not "
        "found; choose it in Diagnostics.",
    )
    assert empty_license == rc.Availability(
        False,
        "The check needs the FreeSurfer license, and the license file is empty "
        "or not readable; choose a readable one in Diagnostics.",
    )
    assert ready == rc.Availability(
        True,
        None,
        str(home),
        str(binary),
        str(home / "subjects" / "fsaverage"),
        str(license_file),
    )


@pytest.mark.parametrize("source", ["project", "environment"])
def test_freesurfer_availability_resolves_the_license_as_recon_all_does(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str
) -> None:
    monkeypatch.delenv("FREESURFER_HOME", raising=False)
    monkeypatch.delenv("FS_LICENSE", raising=False)
    home = tmp_path / "freesurfer"
    write_atlas(home)
    binary = home / "bin" / "mri_surf2surf"
    binary.parent.mkdir()
    binary.write_text("#!/bin/sh\n")
    binary.chmod(0o755)
    (home / "license.txt").write_text("a readable license\n")
    missing = tmp_path / "moved" / "license.txt"
    cfg: dict[str, Any] = {"tools": {"freesurferHome": str(home)}}
    if source == "project":
        cfg["tools"]["freesurferLicense"] = str(missing)
    else:
        monkeypatch.setenv("FS_LICENSE", str(missing))

    availability = rc.freesurfer_availability(cfg)
    runtime = freesurfer_runtime_environment(cfg, base_environment=os.environ)

    # The selected license wins over FREESURFER_HOME/license.txt, exactly as
    # in the FS_LICENSE every mri_surf2surf call receives.
    assert runtime["FS_LICENSE"] == str(missing)
    assert availability.available is False
    assert "license file was not found" in (availability.reason or "")
    missing.parent.mkdir()
    missing.write_text("a readable license\n")
    assert rc.freesurfer_availability(cfg).license == runtime["FS_LICENSE"]


def test_a_missing_license_makes_the_check_unavailable_and_writes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness = Harness(tmp_path, subjects=2)
    monkeypatch.delenv("FS_LICENSE", raising=False)
    binary = harness.home / "bin" / "mri_surf2surf"
    binary.parent.mkdir()
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)
    manager = rc.SurfaceRegistrationManager(harness.epochs, resampler=harness.resample)
    request = harness.request()
    request["cfg"]["tools"] = {"freesurferHome": str(harness.home)}

    status = manager.status(request)

    assert status["available"] is False
    assert status["unavailableReason"] == (
        "The check needs the FreeSurfer license, and the license file was not "
        "found; choose it in Diagnostics."
    )
    assert status["counts"]["pending"] == 4
    with pytest.raises(rc.RegistrationCheckError, match="license file was not found"):
        manager.check(request)
    assert harness.calls == []
    assert not os.path.exists(rc.store_path(str(harness.root)))


def test_a_rejected_license_stops_the_check_without_caching_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # FreeSurfer 8.2 exits with 255 when it rejects the license; that exit
    # must not cache every hemisphere as failed.
    harness = Harness(tmp_path, subjects=3)
    license_file = harness.home / "license.txt"
    license_file.write_text("not a FreeSurfer license\n")
    monkeypatch.setenv("FS_LICENSE", str(license_file))
    binary = harness.home / "bin" / "mri_surf2surf"
    binary.parent.mkdir()
    binary.write_text(
        "#!/bin/sh\n"
        "echo '----------------------------------------------------------------'\n"
        f"echo 'ERROR: Invalid FreeSurfer license key found in license file "
        f"{license_file}'\n"
        "exit 255\n"
    )
    binary.chmod(0o755)
    manager = rc.SurfaceRegistrationManager(harness.epochs, max_workers=2)
    request = harness.request()
    request["cfg"]["tools"] = {"freesurferHome": str(harness.home)}

    started = manager.check(request)
    operation = manager._operation
    assert operation is not None
    finish(operation)
    status = manager.status(request)

    assert status["operation"]["operationId"] == started["operation"]["operationId"]
    assert status["operation"]["state"] == "failed"
    assert status["operation"]["message"] == (
        "FreeSurfer did not accept its license file, so mri_surf2surf could not "
        "run; choose a valid license in Diagnostics."
    )
    assert status["counts"]["failed"] == 0
    assert status["counts"]["pending"] == 6
    assert rc.load_store(str(harness.root))["entries"] == {}


def test_a_setup_failure_mid_run_caches_nothing_for_the_hemispheres_it_met(
    tmp_path: Path,
) -> None:
    harness = Harness(tmp_path)
    harness.setup_fails_after = 4

    status = harness.run()

    assert status["operation"]["state"] == "failed"
    assert status["operation"]["message"] == rc._LICENSE_REJECTED
    entries = rc.load_store(str(harness.root))["entries"]
    # The first four resamples succeed and every later one meets the setup
    # failure; the other worker's success may land after the stop, uncached.
    succeeded = {f"{subject}:{hemi}" for subject, hemi in harness.calls[:4]}
    assert len(harness.calls) > 4
    assert entries
    assert set(entries) <= succeeded
    assert all(entry["error"] is None for entry in entries.values())
    assert status["counts"]["failed"] == 0
    assert status["counts"]["checked"] == len(entries)
    assert status["counts"]["pending"] == 22 - len(entries)
    harness.setup_fails_after = None
    harness.calls.clear()
    repaired = harness.run()
    assert len(harness.calls) == 22 - len(entries)
    assert repaired["counts"]["checked"] == 22


@pytest.mark.parametrize(
    ("failure", "message"),
    [
        (
            rc.RegistrationCheckError("mri_surf2surf ended with exit code 1."),
            "mri_surf2surf also failed to resample fsaverage onto itself, so the "
            "FreeSurfer setup is the likely cause, and the hemispheres it failed "
            "on stay unchecked. mri_surf2surf ended with exit code 1.",
        ),
        (
            rc.RegistrationEnvironmentError(rc._LIBRARIES_MISSING),
            "mri_surf2surf could not load its shared libraries.",
        ),
    ],
)
def test_a_failed_setup_probe_stops_the_check_and_caches_nothing(
    tmp_path: Path, failure: rc.RegistrationCheckError, message: str
) -> None:
    harness = Harness(tmp_path)
    harness.fail = {
        (f"sub-{index:02d}", hemi) for index in range(1, 12) for hemi in rc.HEMISPHERES
    }
    harness.probe_failure = failure

    status = harness.run()

    assert status["operation"]["state"] == "failed"
    assert status["operation"]["message"] == message
    # A hemisphere counts only once its result is recorded.
    assert status["operation"]["completed"] == 0
    assert status["operation"]["failed"] == 0
    assert len(probe_calls(harness)) == 1
    assert rc.load_store(str(harness.root))["entries"] == {}
    assert status["counts"]["pending"] == 22


def test_a_failure_before_any_success_is_cached_once_the_setup_probe_succeeds(
    tmp_path: Path,
) -> None:
    harness = Harness(tmp_path, subjects=1)
    harness.fail = {("sub-01", "lh"), ("sub-01", "rh")}

    status = harness.run()

    assert status["operation"]["state"] == "done"
    assert status["operation"]["failed"] == 2
    assert status["counts"]["failed"] == 2
    assert len(probe_calls(harness)) == 1
    setup = rc.environment_digest(harness.availability({}))
    entries = rc.load_store(str(harness.root))["entries"]
    assert {entry["environmentSha256"] for entry in entries.values()} == {setup}


def test_alike_failures_ahead_of_a_slow_success_are_cached_and_the_rest_checked(
    tmp_path: Path,
) -> None:
    # A sulcal depth that does not match its sphere makes
    # mri_surf2surf exit with 1 in well under a second, while a sound resample
    # takes about 2.4 seconds. Four broken hemispheres sorted ahead of the
    # first sound one all failed before any success, and the check blamed the
    # setup, cached nothing, and never checked the sound hemispheres.
    harness = Harness(tmp_path, subjects=6)
    for subject in ("sub-01", "sub-03"):
        surf = harness.root / "derivatives" / "freesurfer" / subject / "surf"
        (surf / "broken").touch()
    binary = tmp_path / "mri_surf2surf"
    binary.write_text(
        "#!/bin/sh\n"
        'while [ "$#" -gt 0 ]; do\n'
        '  case "$1" in --sval) sval="$2" ;; --tval) tval="$2" ;; esac\n'
        "  shift\n"
        "done\n"
        'if [ -e "$(dirname "$sval")/broken" ]; then\n'
        "  echo 'ERROR: vertex count mismatch' >&2\n"
        "  exit 1\n"
        "fi\n"
        "sleep 0.3\n"
        'cp "$sval" "$tval"\n'
    )
    binary.chmod(0o755)
    availability = rc.Availability(
        True, None, str(harness.home), str(binary), str(harness.fsaverage), ""
    )
    harness.manager = rc.SurfaceRegistrationManager(
        harness.epochs, availability=lambda _cfg: availability, max_workers=4
    )

    status = harness.run()
    retried = harness.run(retryFailed=True)

    broken = {
        f"{subject}:{hemi}"
        for subject in ("sub-01", "sub-03")
        for hemi in rc.HEMISPHERES
    }
    for result in (status, retried):
        assert result["operation"]["state"] == "done"
        assert result["operation"]["failed"] == 4
        assert result["counts"]["checked"] == 8
        assert result["counts"]["failed"] == 4
    assert status["operation"]["completed"] == 12
    # Only the four failures are work for the explicit retry.
    assert retried["operation"]["total"] == 4
    entries = rc.load_store(str(harness.root))["entries"]
    setup = rc.environment_digest(availability)
    assert {key for key, entry in entries.items() if entry["error"]} == broken
    assert all(
        entries[key]["error"] == "mri_surf2surf ended with exit code 1."
        and entries[key]["environmentSha256"] == setup
        for key in broken
    )


def test_a_cancel_during_the_setup_probe_caches_nothing(tmp_path: Path) -> None:
    harness = Harness(tmp_path, subjects=2)
    harness.fail = {("sub-01", "lh"), ("sub-01", "rh")}
    harness.probe_gate = threading.Event()
    started = harness.manager.check(harness.request())
    operation_id = started["operation"]["operationId"]
    # The probe waits at its gate until the cancel below.
    harness.wait_for_call(lambda calls: any(call[0] == "fsaverage" for call in calls))

    harness.manager.cancel(harness.request(operationId=operation_id))
    harness.probe_gate.set()
    status = harness.wait(operation_id)

    assert status["operation"]["state"] == "cancelled"
    assert status["operation"]["failed"] == 0
    entries = rc.load_store(str(harness.root))["entries"]
    assert all(entry["error"] is None for entry in entries.values())


def test_an_unreadable_sulcal_depth_is_cached_and_shown_as_failed(
    tmp_path: Path,
) -> None:
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("File modes do not stop the superuser from reading.")
    harness = Harness(tmp_path)
    sulc = harness.root / "derivatives" / "freesurfer" / "sub-02" / "surf" / "lh.sulc"
    sulc.chmod(0)
    try:
        status = harness.run()
        harness.calls.clear()
        again = harness.run()
    finally:
        sulc.chmod(0o644)

    row = hemisphere(status, "sub-02", "lh")
    assert row["state"] == "failed"
    assert row["message"] == "An input surface file is not readable."
    assert status["operation"]["state"] == "done"
    assert status["counts"]["checked"] == 21
    assert again["operation"]["total"] == 0
    assert hemisphere(again, "sub-02", "lh")["state"] == "failed"
    assert ("sub-02", "lh") not in harness.calls


def test_a_failure_from_an_earlier_setup_is_checked_again_without_a_request(
    tmp_path: Path,
) -> None:
    # A failure recorded without a setup digest may come from the setup.
    harness = Harness(tmp_path, subjects=2)
    harness.fail = {("sub-01", "lh")}
    harness.fail_message = "mri_surf2surf ended with exit code 255."
    harness.run()
    path = rc.store_path(str(harness.root))
    document = json.loads(Path(path).read_text())
    del document["entries"]["sub-01:lh"]["environmentSha256"]
    Path(path).write_text(json.dumps(document))
    harness.fail = set()
    harness.calls.clear()

    legacy = harness.manager.status(harness.request())
    retried = harness.run()

    assert hemisphere(legacy, "sub-01", "lh")["state"] == "pending"
    assert harness.calls == [("sub-01", "lh")]
    assert hemisphere(retried, "sub-01", "lh")["state"] == "checked"


def test_a_changed_setup_checks_its_failures_again(tmp_path: Path) -> None:
    harness = Harness(tmp_path, subjects=3)
    harness.fail = {("sub-02", "rh")}
    first = harness.run()
    harness.calls.clear()
    same = harness.run()

    harness.license = str(tmp_path / "new-license.txt")
    Path(harness.license).write_text("a readable license\n")
    changed = harness.manager.status(harness.request())
    harness.fail = set()
    retried = harness.run()

    assert hemisphere(first, "sub-02", "rh")["state"] == "failed"
    assert same["operation"]["total"] == 0
    assert hemisphere(changed, "sub-02", "rh")["state"] == "pending"
    assert changed["counts"]["checked"] == 5
    assert harness.calls == [("sub-02", "rh")]
    assert hemisphere(retried, "sub-02", "rh")["state"] == "checked"


def test_load_atlas_reads_masks_and_measures_a_hemisphere(tmp_path: Path) -> None:
    fsaverage = write_atlas(tmp_path / "freesurfer")

    atlas = rc.load_atlas(str(fsaverage))
    same = rc.measure_hemisphere(array("f", atlas_sulc()), atlas.hemispheres["lh"])

    assert atlas.digest == rc.atlas_digest(str(fsaverage))
    assert list(atlas.hemispheres["lh"].masks["dfp"]) == sorted(DFP_VERTICES)
    assert len(atlas.hemispheres["rh"].masks["cortex"]) == VERTICES - 1
    assert same == pytest.approx((1.0, 1.0))
    with pytest.raises(rc.RegistrationCheckError, match="vertex count"):
        rc.measure_hemisphere(array("f", [1.0, 2.0]), atlas.hemispheres["lh"])


def test_resample_with_mri_surf2surf_runs_in_a_private_subjects_dir(
    tmp_path: Path,
) -> None:
    fsaverage = write_atlas(tmp_path / "freesurfer")
    subject = tmp_path / "sub-01"
    (subject / "surf").mkdir(parents=True)
    fake = tmp_path / "mri_surf2surf"
    fake.write_text(
        "#!/bin/sh\n"
        'echo "$SUBJECTS_DIR $*" > "$SUBJECTS_DIR/../argv.txt"\n'
        'while [ "$1" != "--tval" ]; do shift; done\n'
        f'cp {fsaverage}/surf/lh.sulc "$2"\n'
    )
    fake.chmod(0o755)
    work = tmp_path / "work"
    work.mkdir()
    tracked: list[Any] = []
    job = rc.ResampleJob(
        str(fake), dict(os.environ), str(subject), "lh", str(fsaverage)
    )

    values = rc.resample_with_mri_surf2surf(
        job, str(work), threading.Event(), tracked.append
    )

    assert list(values) == pytest.approx(atlas_sulc())
    argv = (work / "argv.txt").read_text()
    assert argv.startswith(f"{work}/subjects --srcsubject src --trgsubject fsaverage")
    assert "--sfmt curv" in argv
    assert "--tfmt curv" in argv
    assert os.readlink(work / "subjects" / "src") == str(subject)
    assert tracked[-1] is None
    assert list(subject.joinpath("surf").iterdir()) == []


def test_resample_with_mri_surf2surf_reports_a_failed_call(tmp_path: Path) -> None:
    fsaverage = write_atlas(tmp_path / "freesurfer")
    fake = tmp_path / "mri_surf2surf"
    # A truncated ?h.sphere.reg made FreeSurfer 8.2 write 21 MB before failing.
    fake.write_text("#!/bin/sh\nhead -c 3000000 /dev/zero | tr '\\0' x\nexit 3\n")
    fake.chmod(0o755)
    work = tmp_path / "work"
    work.mkdir()
    job = rc.ResampleJob(str(fake), {}, str(tmp_path), "rh", str(fsaverage))

    with pytest.raises(rc.RegistrationCheckError, match="exit code 3") as caught:
        rc.resample_with_mri_surf2surf(
            job, str(work), threading.Event(), lambda _p: None
        )
    assert not isinstance(caught.value, rc.RegistrationEnvironmentError)
    # The output is read through a pipe, never kept on disk.
    assert sorted(os.listdir(work)) == ["subjects"]


@pytest.mark.parametrize(
    ("script", "message"),
    [
        (
            "echo 'ERROR: FreeSurfer license file /opt/fs/license.txt not found.'\n"
            "echo '  specified with the FS_LICENSE environmental variable.'\n"
            "exit 255\n",
            "FreeSurfer did not accept its license file",
        ),
        (
            "echo 'error parsing license file, at least 4 values expected' >&2\n"
            "exit 255\n",
            "FreeSurfer did not accept its license file",
        ),
        (
            "echo 'mri_surf2surf: error while loading shared libraries: "
            "libGLU.so.1: cannot open shared object file' >&2\nexit 127\n",
            "could not load its shared libraries",
        ),
        (
            "head -c 200000 /dev/zero | tr '\\0' x\n"
            "echo\necho 'ERROR: FreeSurfer license file /opt/fs/.license not found.'\n"
            "exit 255\n",
            "FreeSurfer did not accept its license file",
        ),
        (
            "echo 'ERROR: FreeSurfer license file /opt/fs/.license not found.'\n"
            "head -c 200000 /dev/zero | tr '\\0' x\n"
            "exit 255\n",
            "FreeSurfer did not accept its license file",
        ),
    ],
)
def test_resample_with_mri_surf2surf_names_a_setup_failure(
    tmp_path: Path, script: str, message: str
) -> None:
    fsaverage = write_atlas(tmp_path / "freesurfer")
    fake = tmp_path / "mri_surf2surf"
    fake.write_text("#!/bin/sh\n" + script)
    fake.chmod(0o755)
    work = tmp_path / "work"
    work.mkdir()
    job = rc.ResampleJob(str(fake), {}, str(tmp_path), "lh", str(fsaverage))

    with pytest.raises(rc.RegistrationEnvironmentError, match=message):
        rc.resample_with_mri_surf2surf(
            job, str(work), threading.Event(), lambda _p: None
        )


def test_resample_with_mri_surf2surf_reports_a_binary_that_cannot_start(
    tmp_path: Path,
) -> None:
    fsaverage = write_atlas(tmp_path / "freesurfer")
    work = tmp_path / "work"
    work.mkdir()
    job = rc.ResampleJob(
        str(tmp_path / "gone" / "mri_surf2surf"),
        {},
        str(tmp_path),
        "lh",
        str(fsaverage),
    )

    with pytest.raises(
        rc.RegistrationEnvironmentError,
        match=r"^mri_surf2surf could not start \(No such file or directory\)\.$",
    ):
        rc.resample_with_mri_surf2surf(
            job, str(work), threading.Event(), lambda _p: None
        )
