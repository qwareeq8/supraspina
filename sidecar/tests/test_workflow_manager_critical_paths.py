"""Tests for critical workflow-manager platform, input, and metadata behavior."""

from __future__ import annotations

import copy
import ctypes
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from supraspina_sidecar import __version__
from supraspina_sidecar import workflow_manager as runtime
from supraspina_sidecar.cohort import CohortSnapshot
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.run_store import (
    MANIFEST_VERSION,
    RECEIPT_VERSION,
    RECONSTRUCTION_RECEIPT_VERSION,
    RunStore,
)
from supraspina_sidecar.workflow_manager import WorkflowManager, _RunContext


class _Emitter:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def emit(self, method: str, params: dict[str, Any]) -> None:
        self.events.append((method, params))


class _WinFunction:
    def __init__(self, callback: Any) -> None:
        self.callback = callback
        self.argtypes: Any = None
        self.restype: Any = None

    def __call__(self, *args: Any) -> Any:
        return self.callback(*args)


class _Kernel32:
    def __init__(self, **outcomes: Any) -> None:
        create = int(outcomes.get("create", 101))
        configure = bool(outcomes.get("configure", True))
        assign = bool(outcomes.get("assign", True))
        terminate = bool(outcomes.get("terminate", True))
        query = bool(outcomes.get("query", True))
        active = int(outcomes.get("active", 2))
        self.closed: list[int] = []
        self.CreateJobObjectW = _WinFunction(lambda *_args: create)
        self.SetInformationJobObject = _WinFunction(lambda *_args: configure)
        self.AssignProcessToJobObject = _WinFunction(lambda *_args: assign)
        self.TerminateJobObject = _WinFunction(lambda *_args: terminate)

        def query_job(
            _handle: Any,
            _info_class: Any,
            accounting_raw: Any,
            _size: Any,
            _returned: Any,
        ) -> bool:
            accounting = ctypes.cast(
                accounting_raw,
                ctypes.POINTER(runtime._JobBasicAccountingInformation),
            ).contents
            accounting.ActiveProcesses = active
            return query

        self.QueryInformationJobObject = _WinFunction(query_job)
        self.CloseHandle = _WinFunction(
            lambda handle: self.closed.append(int(handle)) or 1
        )


def _install_kernel32(monkeypatch: pytest.MonkeyPatch, kernel: _Kernel32) -> None:
    monkeypatch.setattr(
        runtime.ctypes, "WinDLL", lambda *_args, **_kwargs: kernel, raising=False
    )
    monkeypatch.setattr(runtime.ctypes, "get_last_error", lambda: 87, raising=False)
    monkeypatch.setattr(
        runtime.ctypes,
        "WinError",
        lambda error: OSError(error, "synthetic Win32 failure"),
        raising=False,
    )


def _identity(root: Path) -> ProjectIdentity:
    return ProjectIdentity(
        "critical-workflow",
        str(root.resolve()),
        str((root / "supraspina.project.json").resolve()),
        1,
    )


def _cohort(*subject_ids: str) -> CohortSnapshot:
    return CohortSnapshot(
        analysis_subject_ids=subject_ids,
        selected_subject_ids=subject_ids,
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(),
        qc_verdicts=tuple((subject_id, "pass") for subject_id in subject_ids),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def _context(
    root: Path,
    *,
    cohort: CohortSnapshot | None = None,
    cfg: dict[str, Any] | None = None,
    effective_cfg: dict[str, Any] | None = None,
) -> _RunContext:
    selected = cohort or _cohort("sub-01", "sub-02")
    identity = _identity(root)
    state = {
        "runId": "run-critical01",
        "project": identity.to_dict(),
        "config": copy.deepcopy(cfg or {}),
        "scope": selected.to_dict(),
        "intent": {"kind": "workflow"},
        "nodes": [],
        "jobs": [],
        "receipts": [],
        "warnings": [],
        "environmentEvidence": {},
        "failurePolicy": {
            "stopOnError": False,
            "continueIndependentAfterError": True,
        },
        "status": "queued",
        "dryRun": False,
        "startedAtMs": 1,
        "endedAtMs": None,
    }
    return _RunContext(
        state=state,
        cfg=copy.deepcopy(cfg or {}),
        effective_cfg=copy.deepcopy(effective_cfg or cfg or {}),
        cohort=selected,
        project=identity,
        store=RunStore(str(root)),
        queue_limit=1,
    )


def test_windows_job_owns_assigns_queries_terminates_and_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kernel = _Kernel32(active=3)
    _install_kernel32(monkeypatch, kernel)

    job = runtime._WindowsJob()
    job.assign(SimpleNamespace(_handle=202))
    assert job.active_processes() == 3
    job.terminate()
    job.close()
    job.close()

    assert kernel.closed == [101]
    assert job.active_processes() == 0
    job.__del__()


@pytest.mark.parametrize(
    ("kernel", "operation"),
    [
        (_Kernel32(create=0), "construct"),
        (_Kernel32(configure=False), "construct"),
        (_Kernel32(assign=False), "assign"),
        (_Kernel32(terminate=False), "terminate"),
        (_Kernel32(query=False), "query"),
    ],
)
def test_windows_job_surfaces_each_ownership_api_failure(
    monkeypatch: pytest.MonkeyPatch, kernel: _Kernel32, operation: str
) -> None:
    _install_kernel32(monkeypatch, kernel)
    if operation == "construct":
        with pytest.raises(OSError, match="synthetic Win32 failure"):
            runtime._WindowsJob()
        if kernel.SetInformationJobObject.callback(None, None, None, None) is False:
            assert kernel.closed == [101]
        return

    job = runtime._WindowsJob()
    action = {
        "assign": lambda: job.assign(SimpleNamespace(_handle=202)),
        "terminate": job.terminate,
        "query": job.active_processes,
    }[operation]
    with pytest.raises(OSError, match="synthetic Win32 failure"):
        action()
    job.close()


def test_windows_job_rejects_process_without_native_handle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kernel = _Kernel32()
    _install_kernel32(monkeypatch, kernel)
    job = runtime._WindowsJob()
    try:
        with pytest.raises(OSError, match="synthetic Win32 failure"):
            job.assign(SimpleNamespace())
    finally:
        job.close()


def test_fsync_directory_is_a_windows_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []
    monkeypatch.setattr(runtime.os, "name", "nt")
    monkeypatch.setattr(runtime.os, "open", lambda path, _flags: opened.append(path))

    runtime._fsync_directory("C:\\project")

    assert opened == []


def test_spawn_windows_job_failure_closes_gate_and_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Gate:
        closed = False

        def close(self) -> None:
            self.closed = True

    class _Proc:
        def __init__(self) -> None:
            self.stdin = _Gate()
            self.killed = False

        def kill(self) -> None:
            self.killed = True

    proc = _Proc()
    closed_jobs: list[bool] = []

    class _Job:
        def assign(self, _proc: _Proc) -> None:
            raise OSError("Reject the assignment.")

        def close(self) -> None:
            closed_jobs.append(True)

    monkeypatch.setattr(runtime, "_IS_WINDOWS", True)
    monkeypatch.setattr(runtime, "_WindowsJob", _Job)
    monkeypatch.setattr(runtime.subprocess, "Popen", lambda *_args, **_kwargs: proc)

    with pytest.raises(OSError, match="Reject the assignment"):
        runtime._spawn(["scientific.exe"], {})

    assert proc.killed is True
    assert proc.stdin is None
    assert closed_jobs == [True]


def test_spawn_windows_constructor_failure_tolerates_kill_and_closed_stdin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Proc:
        stdin = None

        def kill(self) -> None:
            raise OSError("Treat the process as already gone.")

    monkeypatch.setattr(runtime, "_IS_WINDOWS", True)
    monkeypatch.setattr(
        runtime,
        "_WindowsJob",
        lambda: (_ for _ in ()).throw(OSError("Treat the job as unavailable.")),
    )
    monkeypatch.setattr(runtime.subprocess, "Popen", lambda *_args, **_kwargs: _Proc())

    with pytest.raises(OSError, match="job as unavailable"):
        runtime._spawn(["scientific.exe"], {})


def test_tail_reader_truncates_by_line_count_and_handles_empty_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "job.log"
    path.write_text("one\ntwo\nthree\n", encoding="utf-8")
    monkeypatch.setattr(runtime, "_REPLAY_LOG_LINES_PER_JOB", 2)
    monkeypatch.setattr(runtime, "_REPLAY_LOG_BYTES_PER_JOB", 1024)
    lines, truncated = runtime._tail_text_file(str(path))
    assert lines == ["two", "three"]
    assert truncated is True

    empty = tmp_path / "empty.log"
    empty.write_bytes(b"")
    assert runtime._tail_text_file(str(empty)) == ([], False)


@pytest.mark.parametrize("step_key", ["enigma", "features", "aggregate"])
def test_prepare_inputs_builds_exact_run_scoped_freesurfer_view(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    step_key: str,
) -> None:
    derivatives = tmp_path / "derivatives"
    source_root = derivatives / "freesurfer"
    source_root.mkdir(parents=True)
    for subject_id in ("sub-01", "sub-02"):
        (source_root / subject_id).mkdir()
    run_inputs = tmp_path / "run-inputs"
    subject_file = run_inputs / "subjects.txt"
    view = run_inputs / "freesurfer-view"
    cfg: dict[str, Any] = {
        "paths": {"derivativesDir": str(derivatives)},
        "steps": {"aggregate": {"params": {"subjectGlob": "sub-*"}}},
    }
    effective = copy.deepcopy(cfg)
    effective["_supraspinaRuntime"] = {
        "cohortSubjectsFile": str(subject_file),
        "freesurferView": str(view),
    }
    ctx = _context(tmp_path, cfg=cfg, effective_cfg=effective)
    manager = WorkflowManager(_Emitter())
    monkeypatch.setattr(
        manager,
        "_current_receipt",
        lambda _ctx, _node: {
            "stepKey": "recon",
            "receiptVersion": RECEIPT_VERSION,
            "outputSchemaIdentity": "freesurfer:recon-tree:v1",
            "reconstruction": {
                "receiptVersion": RECONSTRUCTION_RECEIPT_VERSION,
                "backend": "freesurfer",
                "provider": {"version": "freesurfer-linux-7.4.1"},
            },
        },
    )
    adapter = SimpleNamespace(resolve=lambda _value, _cfg: str(derivatives))
    monkeypatch.setitem(runtime.ADAPTERS, step_key, adapter)
    try:
        manager._prepare_inputs(ctx, step_key)
        manager._prepare_inputs(ctx, step_key)
    finally:
        manager.shutdown()

    assert subject_file.read_text(encoding="utf-8") == "sub-01\nsub-02\n"
    assert {entry.name for entry in view.iterdir()} == {"sub-01", "sub-02"}
    assert all((view / subject_id).is_symlink() for subject_id in ("sub-01", "sub-02"))
    assert ctx.inputs_ready == {step_key}


def _freesurfer_context(
    tmp_path: Path, *, subjects: tuple[str, ...] = ("sub-01",)
) -> tuple[_RunContext, Path, Path]:
    derivatives = tmp_path / "derivatives"
    source_root = derivatives / "freesurfer"
    source_root.mkdir(parents=True)
    for subject_id in subjects:
        if "/" not in subject_id:
            (source_root / subject_id).mkdir()
    view = tmp_path / "view"
    cfg = {
        "paths": {"derivativesDir": str(derivatives)},
        "steps": {"aggregate": {"params": {"subjectGlob": "sub-*"}}},
    }
    effective = copy.deepcopy(cfg)
    effective["_supraspinaRuntime"] = {
        "cohortSubjectsFile": str(tmp_path / "subjects.txt"),
        "freesurferView": str(view),
    }
    return (
        _context(
            tmp_path,
            cohort=_cohort(*subjects),
            cfg=cfg,
            effective_cfg=effective,
        ),
        derivatives,
        view,
    )


def _accept_freesurfer_receipts(
    manager: WorkflowManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        manager,
        "_current_receipt",
        lambda _ctx, _node: {
            "stepKey": "recon",
            "receiptVersion": RECEIPT_VERSION,
            "outputSchemaIdentity": "freesurfer:recon-tree:v1",
            "reconstruction": {
                "receiptVersion": RECONSTRUCTION_RECEIPT_VERSION,
                "backend": "freesurfer",
                "provider": {"version": "freesurfer-linux-7.4.1"},
            },
        },
    )


@pytest.mark.parametrize(
    ("provider_version", "message"),
    [
        ("freesurfer-linux-8.2.0", "saved value is 7"),
        ("unknown", "detected provider release"),
    ],
)
def test_prepare_inputs_rejects_enigma_version_mismatch_or_unknown_provider(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    provider_version: str,
    message: str,
) -> None:
    manager = WorkflowManager(_Emitter())
    ctx, derivatives, _view = _freesurfer_context(tmp_path)
    monkeypatch.setitem(
        runtime.ADAPTERS,
        "enigma",
        SimpleNamespace(resolve=lambda _value, _cfg: str(derivatives)),
    )
    monkeypatch.setattr(
        manager,
        "_current_receipt",
        lambda _ctx, _node: {
            "stepKey": "recon",
            "receiptVersion": RECEIPT_VERSION,
            "outputSchemaIdentity": "freesurfer:recon-tree:v1",
            "reconstruction": {
                "receiptVersion": RECONSTRUCTION_RECEIPT_VERSION,
                "backend": "freesurfer",
                "provider": {"version": provider_version},
            },
        },
    )
    try:
        with pytest.raises(ValueError, match=message):
            manager._prepare_inputs(ctx, "enigma")
    finally:
        manager.shutdown()


def test_prepare_inputs_rejects_a_noncurrent_reconstruction_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = WorkflowManager(_Emitter())
    ctx, derivatives, _view = _freesurfer_context(tmp_path)
    monkeypatch.setattr(
        manager,
        "_current_receipt",
        lambda _ctx, _node: {
            "stepKey": "recon",
            "receiptVersion": 1,
            "outputSchemaIdentity": "freesurfer:recon-tree:v1",
        },
    )
    monkeypatch.setitem(
        runtime.ADAPTERS,
        "enigma",
        SimpleNamespace(resolve=lambda _value, _cfg: str(derivatives)),
    )
    try:
        with pytest.raises(ValueError, match="current backend-aware receipt"):
            manager._prepare_inputs(ctx, "enigma")
    finally:
        manager.shutdown()


def test_prepare_inputs_rejects_unsafe_subject_and_inconsistent_view(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = WorkflowManager(_Emitter())
    _accept_freesurfer_receipts(manager, monkeypatch)
    unsafe, derivatives, _view = _freesurfer_context(
        tmp_path / "unsafe", subjects=("../escape",)
    )
    monkeypatch.setitem(
        runtime.ADAPTERS,
        "enigma",
        SimpleNamespace(resolve=lambda _value, _cfg: str(derivatives)),
    )
    try:
        with pytest.raises(
            ValueError, match=r"Use a safe Reconstruction cohort path\."
        ):
            manager._prepare_inputs(unsafe, "enigma")

        inconsistent, derivatives, view = _freesurfer_context(tmp_path / "inconsistent")
        view.mkdir()
        (view / "sub-01").write_text("not the expected link", encoding="utf-8")
        monkeypatch.setitem(
            runtime.ADAPTERS,
            "enigma",
            SimpleNamespace(resolve=lambda _value, _cfg: str(derivatives)),
        )
        with pytest.raises(
            ValueError,
            match=r"Rebuild the inconsistent run-scoped Reconstruction view\.",
        ):
            manager._prepare_inputs(inconsistent, "enigma")
    finally:
        manager.shutdown()


def test_prepare_inputs_rejects_extra_missing_and_glob_mismatched_entries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = WorkflowManager(_Emitter())
    _accept_freesurfer_receipts(manager, monkeypatch)
    try:
        extra, derivatives, view = _freesurfer_context(tmp_path / "extra")
        view.mkdir()
        (view / "extra-a").touch()
        (view / "extra-b").touch()
        monkeypatch.setitem(
            runtime.ADAPTERS,
            "enigma",
            SimpleNamespace(resolve=lambda _value, _cfg: str(derivatives)),
        )
        with pytest.raises(ValueError, match="unintended entries"):
            manager._prepare_inputs(extra, "enigma")

        missing, derivatives, view = _freesurfer_context(tmp_path / "missing")
        view.mkdir()
        (view / "sub-01").symlink_to(derivatives / "freesurfer" / "sub-01")
        (view / "extra").touch()
        monkeypatch.setitem(
            runtime.ADAPTERS,
            "features",
            SimpleNamespace(resolve=lambda _value, _cfg: str(derivatives)),
        )
        with pytest.raises(
            ValueError,
            match=r"Rebuild the run-scoped FreeSurfer view to match the analysis cohort\.",
        ):
            manager._prepare_inputs(missing, "features")

        globbed, derivatives, _view = _freesurfer_context(
            tmp_path / "glob", subjects=("participant-01",)
        )
        monkeypatch.setitem(
            runtime.ADAPTERS,
            "aggregate",
            SimpleNamespace(resolve=lambda _value, _cfg: str(derivatives)),
        )
        with pytest.raises(ValueError, match="subjectGlob"):
            manager._prepare_inputs(globbed, "aggregate")
    finally:
        manager.shutdown()


def test_prepare_inputs_reports_windows_symlink_privilege(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx, derivatives, _view = _freesurfer_context(tmp_path)
    manager = WorkflowManager(_Emitter())
    _accept_freesurfer_receipts(manager, monkeypatch)
    monkeypatch.setitem(
        runtime.ADAPTERS,
        "enigma",
        SimpleNamespace(resolve=lambda _value, _cfg: str(derivatives)),
    )
    monkeypatch.setattr(
        runtime.os,
        "symlink",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("Deny the fixture operation.")
        ),
    )
    monkeypatch.setattr(runtime.os, "name", "nt")
    try:
        with pytest.raises(RuntimeError, match="Developer Mode"):
            manager._prepare_inputs(ctx, "enigma")
    finally:
        manager.shutdown()


def test_prepare_inputs_selects_receipt_backend_and_rejects_mixed_cohort(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    derivatives = tmp_path / "derivatives"
    for backend in ("freesurfer", "fastsurfer"):
        for subject_id in ("sub-01", "sub-02"):
            (derivatives / backend / subject_id).mkdir(parents=True)
    cfg = {
        "paths": {"derivativesDir": str(derivatives)},
        "steps": {"aggregate": {"params": {"subjectGlob": "sub-*"}}},
    }
    effective = copy.deepcopy(cfg)
    effective["_supraspinaRuntime"] = {
        "cohortSubjectsFile": str(tmp_path / "subjects.txt"),
        "freesurferView": str(tmp_path / "view"),
    }
    ctx = _context(
        tmp_path,
        cohort=_cohort("sub-01", "sub-02"),
        cfg=cfg,
        effective_cfg=effective,
    )
    manager = WorkflowManager(_Emitter())
    monkeypatch.setitem(
        runtime.ADAPTERS,
        "features",
        SimpleNamespace(resolve=lambda _value, _cfg: str(derivatives)),
    )

    def receipt(_ctx: _RunContext, node: dict[str, Any]) -> dict[str, Any]:
        backend = "fastsurfer" if node["subjectId"] == "sub-01" else "freesurfer"
        return {
            "stepKey": "recon",
            "receiptVersion": RECEIPT_VERSION,
            "outputSchemaIdentity": f"{backend}:recon-tree:v{2 if backend == 'fastsurfer' else 1}",
            "reconstruction": {
                "receiptVersion": RECONSTRUCTION_RECEIPT_VERSION,
                "backend": backend,
            },
        }

    monkeypatch.setattr(manager, "_current_receipt", receipt)
    try:
        with pytest.raises(ValueError, match="mixed current reconstruction backends"):
            manager._prepare_inputs(ctx, "features")
    finally:
        manager.shutdown()


def test_prepare_inputs_links_fastsurfer_tree_from_validated_receipt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    derivatives = tmp_path / "derivatives"
    source = derivatives / "fastsurfer" / "sub-01"
    source.mkdir(parents=True)
    cfg = {
        "paths": {"derivativesDir": str(derivatives)},
        "steps": {"aggregate": {"params": {"subjectGlob": "sub-*"}}},
    }
    effective = copy.deepcopy(cfg)
    effective["_supraspinaRuntime"] = {
        "cohortSubjectsFile": str(tmp_path / "subjects.txt"),
        "freesurferView": str(tmp_path / "view"),
    }
    ctx = _context(tmp_path, cfg=cfg, effective_cfg=effective)
    manager = WorkflowManager(_Emitter())
    monkeypatch.setitem(
        runtime.ADAPTERS,
        "features",
        SimpleNamespace(resolve=lambda _value, _cfg: str(derivatives)),
    )
    monkeypatch.setattr(
        manager,
        "_current_receipt",
        lambda _ctx, _node: {
            "stepKey": "recon",
            "receiptVersion": RECEIPT_VERSION,
            "outputSchemaIdentity": "fastsurfer:recon-tree:v2",
            "reconstruction": {
                "receiptVersion": RECONSTRUCTION_RECEIPT_VERSION,
                "backend": "fastsurfer",
            },
        },
    )
    try:
        manager._prepare_inputs(ctx, "features")
    finally:
        manager.shutdown()

    assert (tmp_path / "view" / "sub-01").resolve() == source.resolve()


def _write_metadata(
    path: Path, rows: list[str], header: str = "participant_id,Cohort,value"
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(header + "\n" + "\n".join(rows) + "\n", encoding="utf-8")


def _registry(monkeypatch: pytest.MonkeyPatch, rows: list[dict[str, Any]]) -> None:
    class _Registry:
        def __init__(self, _root: str) -> None:
            pass

        def list(self, _cfg: dict[str, Any]) -> list[dict[str, Any]]:
            return copy.deepcopy(rows)

    monkeypatch.setattr(runtime, "RegistryStore", _Registry)


def test_metadata_projection_writes_exact_cohort_and_provenance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.csv"
    destination = tmp_path / "run" / "clinical.csv"
    _write_metadata(
        source,
        [
            "sub-02,old,b",
            "not-selected,old,x",
            "sub-01,old,a",
        ],
    )
    _registry(
        monkeypatch,
        [
            {"subjectId": "sub-01", "cohortRole": "healthy"},
            {"subjectId": "sub-02", "cohortRole": "sci-neuropathic-pain"},
        ],
    )
    ctx = _context(tmp_path)
    manager = WorkflowManager(_Emitter())
    try:
        manager._metadata_projection(
            ctx,
            str(source),
            str(destination),
            healthy_label="control",
            projection_kind="clinical",
        )
    finally:
        manager.shutdown()

    assert destination.read_text(encoding="utf-8").splitlines() == [
        "participant_id,Cohort,value",
        "sub-01,control,a",
        "sub-02,SCI_P,b",
    ]
    record = ctx.state["inputProjections"][0]
    assert record["inputRows"] == 3
    assert record["outputRows"] == 2
    assert record["analysisRows"] == 2
    assert record["outputSha256"] == manager._file_sha256(str(destination))


def test_metadata_projection_publishes_its_record_under_the_manager_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Insert into the run state only while a concurrent commit cannot copy it.

    A projection appended from a job thread that holds only the input lock can
    abort a concurrent ``copy.deepcopy`` of the run state, which raises a
    RuntimeError that the persistence-failure handling never sees.
    """
    source = tmp_path / "source.csv"
    _write_metadata(source, ["sub-01,old,a", "sub-02,old,b"])
    _registry(
        monkeypatch,
        [
            {"subjectId": "sub-01", "cohortRole": "healthy"},
            {"subjectId": "sub-02", "cohortRole": "sci-neuropathic-pain"},
        ],
    )
    ctx = _context(tmp_path)
    manager = WorkflowManager(_Emitter())

    appended_under_lock: list[bool] = []

    class _LockWatchingList(list):
        """Record whether the manager lock is held for each append."""

        def append(self, item: Any) -> None:
            appended_under_lock.append(manager._lock._is_owned())
            super().append(item)

    ctx.state["inputProjections"] = _LockWatchingList()
    try:
        manager._metadata_projection(
            ctx,
            str(source),
            str(tmp_path / "run" / "clinical.csv"),
            healthy_label="control",
            projection_kind="clinical",
        )
    finally:
        manager.shutdown()

    assert appended_under_lock == [True]
    assert len(ctx.state["inputProjections"]) == 1


def test_prepare_inputs_routes_clinical_and_final_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clinical_source = tmp_path / "source" / "clinical.csv"
    metadata_dir = tmp_path / "metadata"
    final_source = metadata_dir / "metadata.csv"
    _write_metadata(clinical_source, ["sub-01,old,a", "sub-02,old,b"])
    _write_metadata(final_source, ["sub-01,old,a", "sub-02,old,b"])
    _registry(
        monkeypatch,
        [
            {"subjectId": "sub-01", "cohortRole": "healthy"},
            {"subjectId": "sub-02", "cohortRole": "sci-no-neuropathic-pain"},
        ],
    )
    cfg = {
        "paths": {
            "clinicalMetadataFile": str(clinical_source),
            "metadataDir": str(metadata_dir),
        }
    }
    effective = copy.deepcopy(cfg)
    effective["_supraspinaRuntime"] = {
        "clinicalMetadataFile": str(tmp_path / "run" / "clinical.csv"),
        "finalMetadataFile": str(tmp_path / "run" / "final.csv"),
    }
    ctx = _context(tmp_path, cfg=cfg, effective_cfg=effective)
    manager = WorkflowManager(_Emitter())
    monkeypatch.setitem(
        runtime.ADAPTERS,
        "clinical",
        SimpleNamespace(resolve=lambda value, _cfg: value),
    )
    monkeypatch.setitem(
        runtime.ADAPTERS,
        "final",
        SimpleNamespace(resolve=lambda value, _cfg: value),
    )
    try:
        manager._prepare_inputs(ctx, "clinical")
        manager._prepare_inputs(ctx, "final")
    finally:
        manager.shutdown()

    assert (tmp_path / "run" / "clinical.csv").exists()
    assert "SCI_H" in (tmp_path / "run" / "final.csv").read_text(encoding="utf-8")
    assert ctx.inputs_ready == {"clinical", "final"}


@pytest.mark.parametrize(
    ("header", "rows", "message"),
    [
        (
            "participant_id,value",
            ["sub-01,a"],
            r"Add subject and cohort columns to the metadata projection\.",
        ),
        (
            "participant_id,Cohort,value",
            ["sub-01,old,a", "sub-01,old,b"],
            r"Remove duplicate subject IDs from the metadata projection\.",
        ),
        (
            "participant_id,Cohort,value",
            ["sub-01,old,a"],
            r"Add every analysis subject to the metadata projection\.",
        ),
    ],
)
def test_metadata_projection_rejects_schema_duplicates_and_missing_subjects(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    header: str,
    rows: list[str],
    message: str,
) -> None:
    source = tmp_path / "source.csv"
    _write_metadata(source, rows, header)
    _registry(
        monkeypatch,
        [
            {"subjectId": "sub-01", "cohortRole": "healthy"},
            {"subjectId": "sub-02", "cohortRole": "healthy"},
        ],
    )
    manager = WorkflowManager(_Emitter())
    try:
        with pytest.raises(ValueError, match=message):
            manager._metadata_projection(
                _context(tmp_path),
                str(source),
                str(tmp_path / "out.csv"),
                healthy_label="control",
                projection_kind="clinical",
            )
    finally:
        manager.shutdown()


def test_metadata_projection_enforces_file_column_and_row_bounds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.csv"
    _write_metadata(source, ["sub-01,old,a", "sub-02,old,b"])
    _registry(monkeypatch, [])
    manager = WorkflowManager(_Emitter())
    try:
        monkeypatch.setattr(
            runtime.os.path,
            "getsize",
            lambda _path: (_ for _ in ()).throw(
                OSError("Treat the metadata source as gone.")
            ),
        )
        with pytest.raises(
            ValueError,
            match=re.escape(
                f"Provide the clinical metadata CSV at {source} with the "
                "participant_id, Cohort, and AIS columns."
            ),
        ):
            manager._metadata_projection(
                _context(tmp_path),
                str(source),
                str(tmp_path / "unavailable.csv"),
                healthy_label="control",
                projection_kind="clinical",
            )

        monkeypatch.undo()
        monkeypatch.setattr(runtime, "_MAX_METADATA_BYTES", 0)
        with pytest.raises(
            ValueError, match=r"Reduce the metadata projection source size\."
        ):
            manager._metadata_projection(
                _context(tmp_path),
                str(source),
                str(tmp_path / "large.csv"),
                healthy_label="control",
                projection_kind="clinical",
            )

        monkeypatch.setattr(runtime, "_MAX_METADATA_BYTES", 64 * 1024 * 1024)
        monkeypatch.setattr(runtime, "_MAX_METADATA_COLUMNS", 1)
        with pytest.raises(
            ValueError, match=r"Reduce the metadata projection column count\."
        ):
            manager._metadata_projection(
                _context(tmp_path),
                str(source),
                str(tmp_path / "wide.csv"),
                healthy_label="control",
                projection_kind="clinical",
            )

        monkeypatch.setattr(runtime, "_MAX_METADATA_COLUMNS", 512)
        monkeypatch.setattr(runtime, "_MAX_METADATA_ROWS", 0)
        with pytest.raises(
            ValueError, match=r"Reduce the metadata projection row count\."
        ):
            manager._metadata_projection(
                _context(tmp_path),
                str(source),
                str(tmp_path / "rows.csv"),
                healthy_label="control",
                projection_kind="clinical",
            )
    finally:
        manager.shutdown()


def test_final_metadata_projection_names_the_missing_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A never-created metadata.csv names its path and required columns."""
    source = tmp_path / "metadata" / "metadata.csv"
    _registry(monkeypatch, [])
    manager = WorkflowManager(_Emitter())
    try:
        message = (
            f"Provide the metadata file {source} with a subject ID column "
            "(participant_id) and a Cohort column; Sex and Age are optional."
        )
        with pytest.raises(ValueError, match=f"^{re.escape(message)}$"):
            manager._metadata_projection(
                _context(tmp_path),
                str(source),
                str(tmp_path / "final.csv"),
                healthy_label="SCI_H",
                projection_kind="final",
            )
        assert not (tmp_path / "final.csv").exists()
    finally:
        manager.shutdown()


def test_metadata_projection_rejects_registry_label_and_identity_drift(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.csv"
    _write_metadata(source, ["sub-01,old,a", "sub-02,old,b"])
    manager = WorkflowManager(_Emitter())
    try:
        _registry(
            monkeypatch,
            [
                {"subjectId": "sub-01", "cohortRole": "unknown"},
                {"subjectId": "sub-02", "cohortRole": "healthy"},
            ],
        )
        with pytest.raises(ValueError, match="ambiguous cohort label"):
            manager._metadata_projection(
                _context(tmp_path),
                str(source),
                str(tmp_path / "ambiguous.csv"),
                healthy_label="control",
                projection_kind="clinical",
            )

        monkeypatch.undo()
        _registry(
            monkeypatch,
            [
                {"subjectId": "sub-01", "cohortRole": "healthy"},
                {"subjectId": "sub-02", "cohortRole": "healthy"},
            ],
        )
        real_identity = runtime.file_identity
        registry_calls = 0

        def drifting_registry(path: str) -> dict[str, Any]:
            nonlocal registry_calls
            if path.endswith("registry.json"):
                registry_calls += 1
                return {"exists": True, "sha256": f"registry-{registry_calls}"}
            return real_identity(path)

        monkeypatch.setattr(runtime, "file_identity", drifting_registry)
        with pytest.raises(ValueError, match="registry changed"):
            manager._metadata_projection(
                _context(tmp_path),
                str(source),
                str(tmp_path / "registry-drift.csv"),
                healthy_label="control",
                projection_kind="clinical",
            )
    finally:
        manager.shutdown()


def test_metadata_projection_rejects_source_identity_drift_after_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.csv"
    _write_metadata(source, ["sub-01,old,a", "sub-02,old,b"])
    _registry(
        monkeypatch,
        [
            {"subjectId": "sub-01", "cohortRole": "healthy"},
            {"subjectId": "sub-02", "cohortRole": "healthy"},
        ],
    )
    real_identity = runtime.file_identity
    source_calls = 0

    def drifting_source(path: str) -> dict[str, Any]:
        nonlocal source_calls
        identity = real_identity(path)
        if path == str(source):
            source_calls += 1
            identity = {**identity, "sha256": f"source-{source_calls}"}
        return identity

    monkeypatch.setattr(runtime, "file_identity", drifting_source)
    manager = WorkflowManager(_Emitter())
    try:
        with pytest.raises(ValueError, match="metadata source changed"):
            manager._metadata_projection(
                _context(tmp_path),
                str(source),
                str(tmp_path / "drift.csv"),
                healthy_label="control",
                projection_kind="clinical",
            )
    finally:
        manager.shutdown()


def test_projection_snapshot_and_launch_binding_reject_identity_drift(
    tmp_path: Path,
) -> None:
    destination = tmp_path / "projection.csv"
    destination.write_text("subject,value\nsub-01,a\n", encoding="utf-8")
    source_identity = {"exists": True, "sha256": "source"}
    registry_identity = {"exists": True, "sha256": "registry"}
    identities = {
        "sourceIdentity": source_identity,
        "registryIdentity": registry_identity,
    }
    binding = {
        "kind": "metadata-projection-input-binding-v1",
        "sha256": runtime.stable_digest(identities),
        **identities,
    }
    output_sha = WorkflowManager._file_sha256(str(destination))
    record = {
        "kind": "clinical",
        "inputIdentity": source_identity,
        "inputSha256": "source",
        "outputSha256": output_sha,
        "registryIdentity": registry_identity,
    }
    effective = {"_supraspinaRuntime": {"clinicalMetadataFile": str(destination)}}
    ctx = _context(tmp_path, effective_cfg=effective)
    ctx.state["inputProjections"] = [record]
    manager = WorkflowManager(_Emitter())
    try:
        assert manager._input_projection_snapshot(ctx, "recon") == []
        projections = manager._input_projection_snapshot(ctx, "clinical")
        WorkflowManager._validate_projection_launch_binding(
            "clinical",
            {"externalInputs": {"runScopedProjectionBinding": binding}},
            projections,
        )
        WorkflowManager._validate_projection_launch_binding("recon", {}, [])

        destination.write_text("changed", encoding="utf-8")
        with pytest.raises(ValueError, match="changed before launch"):
            manager._input_projection_snapshot(ctx, "clinical")

        with pytest.raises(
            ValueError,
            match=r"Restore the run-scoped metadata projection identity\.",
        ):
            manager._input_projection_snapshot(_context(tmp_path), "clinical")
        with pytest.raises(
            ValueError,
            match=r"Restore the run-scoped metadata projection binding\.",
        ):
            WorkflowManager._validate_projection_launch_binding("clinical", {}, [])
        with pytest.raises(ValueError, match="metadata or registry changed"):
            WorkflowManager._validate_projection_launch_binding(
                "clinical",
                {
                    "externalInputs": {
                        "runScopedProjectionBinding": {**binding, "sha256": "wrong"}
                    }
                },
                [{**record, "consumedSha256": output_sha}],
            )
    finally:
        manager.shutdown()


def test_receipt_scientific_evidence_copies_only_age_reconciliation() -> None:
    evidence = {"state": "done"}
    assert (
        WorkflowManager._receipt_scientific_evidence({}, "recon", evidence) is evidence
    )
    assert WorkflowManager._receipt_scientific_evidence({}, "age", evidence) is evidence

    state = {"scientificEvidence": {"ageOuterJoin": {"missing": ["sub-02"]}}}
    enriched = WorkflowManager._receipt_scientific_evidence(state, "age", evidence)
    assert enriched == {
        "state": "done",
        "ageOuterReconciliation": {"missing": ["sub-02"]},
    }
    assert enriched is not evidence


def test_manifest_reports_a_wholly_skipped_stage_as_skipped() -> None:
    """Separate a stage that executed nothing from a completed stage."""
    manager = WorkflowManager(_Emitter())
    try:
        manifest = manager._manifest(
            {
                "nodes": [
                    {"stepKey": "deface", "subjectId": "sub-001", "status": "done"},
                    {"stepKey": "recon", "subjectId": "sub-001", "status": "skipped"},
                    {"stepKey": "recon", "subjectId": "sub-002", "status": "skipped"},
                    {"stepKey": "enigma", "subjectId": "sub-001", "status": "done"},
                    {"stepKey": "enigma", "subjectId": "sub-002", "status": "skipped"},
                ]
            }
        )
    finally:
        manager.shutdown()

    steps = {step["key"]: step for step in manifest["steps"]}
    assert steps["deface"]["status"] == "done"
    assert steps["recon"]["status"] == "skipped"
    assert steps["enigma"]["status"] == "done"
    # Keep the subject count as the number of nodes the stage covered.
    assert steps["recon"]["subjects"] == 2


def test_manifest_names_the_product_release_and_no_unproven_commit() -> None:
    """Keep the scientific baseline commit out of the run's source identity."""
    manager = WorkflowManager(_Emitter())
    try:
        manifest = manager._manifest({"nodes": []})
    finally:
        manager.shutdown()

    assert manifest["product"] == {
        "name": "Supraspina",
        "version": __version__,
        "build": "unknown",
    }
    assert manifest["git"] == {"repo": "", "sha": "", "dirty": False}


@pytest.mark.parametrize(
    ("identity", "build"),
    [
        ({"kind": "release", "commit": "a" * 40, "dirty": False}, "release"),
        ({"kind": "development", "commit": "b" * 40, "dirty": True}, "development"),
    ],
)
def test_manifest_records_the_build_identity_of_the_sidecar(
    monkeypatch: pytest.MonkeyPatch, identity: dict[str, Any], build: str
) -> None:
    """Fill the Git block and the build kind from the packaged build record."""
    monkeypatch.setattr(runtime, "build_identity", lambda: dict(identity))
    manager = WorkflowManager(_Emitter())
    try:
        manifest = manager._manifest({"nodes": []})
    finally:
        manager.shutdown()

    assert manifest["schemaVersion"] == MANIFEST_VERSION == 1
    assert manifest["product"] == {
        "name": "Supraspina",
        "version": __version__,
        "build": build,
    }
    assert manifest["git"] == {
        "repo": "",
        "sha": identity["commit"],
        "dirty": identity["dirty"],
    }
