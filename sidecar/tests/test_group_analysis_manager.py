"""Tests for the ``groupAnalysis.*`` RPC surface and the compute lifecycle.

Workers here are real processes in their own session: a fake-engine worker
(``fake_run`` patched into the real worker entry), a slow worker that never
finishes, and workers that fail. Handlers must return in milliseconds while a
worker runs, cancel and a foreign project's request must kill the worker's
process group, and detach and shutdown must stop it.
"""

from __future__ import annotations

import ast
import io
import json
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import __main__ as entrypoint
from supraspina_sidecar.group_analysis import dataset, manager, store, worker
from supraspina_sidecar.group_analysis.manager import GroupAnalysisManager
from supraspina_sidecar.group_analysis.spec import GroupAnalysisError
from supraspina_sidecar.project import ProjectEpochs
from supraspina_sidecar.registry_store import RegistryStore
from supraspina_sidecar.rpc import Emitter
from tests.group_analysis_support import (
    example_spec,
    make_project,
    request,
    write_qc,
)

_SIDECAR = Path(__file__).resolve().parents[1]
_CURRENCY = {"aggregate": "current", "pybrainage": "unknown"}
_FAKE_WORKER = (
    "from tests.group_analysis_support import fake_run\n"
    "from supraspina_sidecar.group_analysis import engine, worker\n"
    "engine.run = fake_run\n"
    "raise SystemExit(worker.main([]))\n"
)
_SLOW_WORKER = (
    "import sys, time\n"
    "sys.stdin.buffer.read()\n"
    'print(\'{"event":"progress","phase":"fitting","completed":1,"total":4}\', flush=True)\n'
    "time.sleep(120)\n"
)


def _spawner(code: str, *, delay: float = 0.0) -> tuple[Callable[..., Any], list[Any]]:
    processes: list[subprocess.Popen[bytes]] = []

    def spawn(argv: list[str]) -> subprocess.Popen[bytes]:
        assert argv == worker.worker_command()
        time.sleep(delay)
        process = subprocess.Popen(  # noqa: S603 - A test worker.
            [sys.executable, "-c", code],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            cwd=_SIDECAR,
        )
        processes.append(process)
        return process

    return spawn, processes


def _wait(condition: Callable[[], bool], timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.02)
    raise AssertionError("The condition did not hold in time.")


def _alive(pid: int) -> bool:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    except OSError:
        return False
    return fields[0] != "Z"


def _operation(
    mgr: GroupAnalysisManager, root: Path, cfg: dict[str, Any]
) -> dict[str, Any]:
    return mgr.status(request(root, cfg))["operation"]


def _start(
    mgr: GroupAnalysisManager, root: Path, cfg: dict[str, Any], **spec: Any
) -> dict[str, Any]:
    return mgr.start(
        request(root, cfg, spec=example_spec(**spec), stageCurrency=_CURRENCY)
    )


def _finished(
    mgr: GroupAnalysisManager, root: Path, cfg: dict[str, Any]
) -> dict[str, Any]:
    _wait(lambda: _operation(mgr, root, cfg)["state"] != "running")
    return _operation(mgr, root, cfg)


def _compute(
    mgr: GroupAnalysisManager, root: Path, cfg: dict[str, Any], **spec: Any
) -> str:
    _start(mgr, root, cfg, **spec)
    operation = _finished(mgr, root, cfg)
    assert operation["state"] == "done", operation
    return str(operation["resultId"])


def _listed(
    mgr: GroupAnalysisManager, root: Path, cfg: dict[str, Any]
) -> list[dict[str, Any]]:
    return mgr.list(request(root, cfg))["results"]


# -- Requests ---------------------------------------------------------------


@pytest.mark.parametrize("extra", [{"unexpected": True}, {"spec": {}}])
def test_manager_requires_the_exact_request_fields(
    tmp_path: Path, extra: dict[str, Any]
) -> None:
    mgr = GroupAnalysisManager(ProjectEpochs())
    cfg = make_project(tmp_path)
    with pytest.raises(GroupAnalysisError, match="valid group-analysis request"):
        mgr.catalog(request(tmp_path, cfg, **extra))
    with pytest.raises(GroupAnalysisError, match="saved project configuration"):
        mgr.status({**request(tmp_path, cfg), "cfg": None})


def test_reads_serve_the_catalog_sample_and_an_empty_store(tmp_path: Path) -> None:
    rows = [
        {
            "subjectId": "sub-02",
            "flagged": True,
            "hemispheres": [{"hemisphere": "lh", "state": "checked", "flagged": True}],
        }
    ]
    seen: list[set[str]] = []

    def registration(req: dict[str, Any]) -> dict[str, Any]:
        seen.append(set(req))
        return {"subjects": rows}

    mgr = GroupAnalysisManager(ProjectEpochs(), registration_status=registration)
    cfg = make_project(tmp_path)

    catalog = mgr.catalog(request(tmp_path, cfg))
    assert catalog["configRevision"] == 3
    assert len([m for m in catalog["measures"] if m["stage"] != "recon"]) == 14

    sample = mgr.inputs(request(tmp_path, cfg, spec=example_spec()))
    assert sample["included"] == 10
    subjects = {row["subjectId"]: row for row in sample["subjects"]}
    assert subjects["sub-02"]["missingHemispheres"] == ["lh"]
    assert seen[-1] == {"project", "cfg", "configRevision", "configSha256"}

    assert mgr.status(request(tmp_path, cfg)) == {"operation": None}
    assert mgr.list(request(tmp_path, cfg)) == {
        "revision": 0,
        "specs": [],
        "sets": [],
        "results": [],
    }
    assert mgr.cancel(request(tmp_path, cfg, operationId="gan-0123456789abcdef")) == {
        "operationId": "gan-0123456789abcdef",
        "stopped": False,
    }
    with pytest.raises(GroupAnalysisError, match="valid analysis operation ID"):
        mgr.cancel(request(tmp_path, cfg, operationId="gan-x"))


def test_an_unreadable_registration_status_reads_as_unjudged(tmp_path: Path) -> None:
    def broken(_req: dict[str, Any]) -> dict[str, Any]:
        raise OSError("gone")

    cfg = make_project(tmp_path)
    for mgr in (
        GroupAnalysisManager(ProjectEpochs(), registration_status=broken),
        GroupAnalysisManager(ProjectEpochs()),
    ):
        sample = mgr.inputs(request(tmp_path, cfg, spec=example_spec()))
        assert sample["registrationProvisional"] is True


def test_an_unreadable_registry_is_an_actionable_error(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    (tmp_path / ".supraspina" / "registry.json").write_text("{", encoding="utf-8")
    mgr = GroupAnalysisManager(ProjectEpochs())

    with pytest.raises(
        GroupAnalysisError, match="Repair the malformed subject registry"
    ):
        mgr.catalog(request(tmp_path, cfg))


def test_library_writes_go_through_the_manager(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    mgr = GroupAnalysisManager(ProjectEpochs())

    saved = mgr.save_spec(
        request(
            tmp_path,
            cfg,
            specId=None,
            name="Primary",
            spec=example_spec(),
            expectedRevision=0,
        )
    )
    spec_id = saved["specs"][0]["specId"]
    sets = mgr.save_set(
        request(
            tmp_path,
            cfg,
            setId=None,
            name="A priori",
            measures=["aseg:Brain-Stem"],
            expectedRevision=1,
        )
    )
    set_id = sets["sets"][0]["setId"]
    locked = mgr.lock_set(request(tmp_path, cfg, setId=set_id, expectedRevision=2))
    assert locked["sets"][0]["locked"] is not None
    assert (
        mgr.delete_set(request(tmp_path, cfg, setId=set_id, expectedRevision=3))["sets"]
        == []
    )
    assert (
        mgr.delete_spec(request(tmp_path, cfg, specId=spec_id, expectedRevision=4))[
            "specs"
        ]
        == []
    )


# -- Lifecycle --------------------------------------------------------------


def test_handlers_return_at_once_while_a_slow_worker_runs(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    spawn, processes = _spawner(_SLOW_WORKER, delay=0.5)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    try:
        began = time.monotonic()
        started = _start(mgr, tmp_path, cfg)
        assert time.monotonic() - began < 0.3
        assert started["started"] is True
        operation = started["operation"]
        assert operation["state"] == "running"
        assert operation["phase"] == "preparing"
        assert manager.OPERATION_ID.fullmatch(operation["operationId"])

        _wait(lambda: _operation(mgr, tmp_path, cfg)["phase"] == "fitting")
        for call in (
            lambda: mgr.status(request(tmp_path, cfg)),
            lambda: mgr.list(request(tmp_path, cfg)),
            lambda: mgr.inputs(request(tmp_path, cfg, spec=example_spec())),
        ):
            began = time.monotonic()
            call()
            assert time.monotonic() - began < 0.3
        assert _operation(mgr, tmp_path, cfg)["completed"] == 1
        assert _operation(mgr, tmp_path, cfg)["total"] == 4

        again = _start(mgr, tmp_path, cfg)
        assert again["started"] is False
        assert again["operation"]["operationId"] == operation["operationId"]
    finally:
        mgr.stop_all(timeout=5)
    assert all(process.poll() is not None for process in processes)


def test_cancel_kills_the_worker_process_group(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    pids = tmp_path / "pids"
    code = (
        "import os, subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
        f"open({str(pids)!r}, 'w').write(f'{{os.getpid()}} {{child.pid}}')\n"
        "sys.stdin.buffer.read()\n"
        "time.sleep(120)\n"
    )
    spawn, _processes = _spawner(code)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    operation = _start(mgr, tmp_path, cfg)["operation"]
    _wait(lambda: pids.exists() and len(pids.read_text().split()) == 2)
    worker_pid, child_pid = map(int, pids.read_text().split())

    stopped = mgr.cancel(request(tmp_path, cfg, operationId=operation["operationId"]))

    assert stopped == {"operationId": operation["operationId"], "stopped": True}
    _wait(lambda: not _alive(worker_pid) and not _alive(child_pid), timeout=10)
    final = _finished(mgr, tmp_path, cfg)
    assert final["state"] == "cancelled"
    assert final["message"] is None
    assert final["resultId"] is None
    assert (
        mgr.cancel(request(tmp_path, cfg, operationId=operation["operationId"]))[
            "stopped"
        ]
        is False
    )
    assert store.list_results(str(tmp_path)) == []


def test_a_cancel_after_the_result_was_written_reports_it(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    written = tmp_path / "written"
    # The worker has reported its result and not yet exited when the cancel
    # arrives.
    code = (
        "import json, sys, time\n"
        "job = json.loads(sys.stdin.buffer.read())\n"
        "print(json.dumps({'event': 'done', 'resultId': job['resultId']}),"
        " flush=True)\n"
        f"open({str(written)!r}, 'w').write('1')\n"
        "time.sleep(120)\n"
    )
    spawn, processes = _spawner(code)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    operation = _start(mgr, tmp_path, cfg)["operation"]
    _wait(written.exists)

    stopped = mgr.cancel(request(tmp_path, cfg, operationId=operation["operationId"]))

    assert stopped == {"operationId": operation["operationId"], "stopped": False}
    final = _operation(mgr, tmp_path, cfg)
    assert final["state"] == "done"
    assert final["resultId"] is not None
    assert final["message"] is None
    _wait(lambda: processes[0].returncode is not None, timeout=15)


def test_a_cancel_after_the_result_file_was_committed_keeps_it(
    tmp_path: Path,
) -> None:
    # The worker committed its result file and was still busy (as
    # while pruning) when the cancel killed it, before it reported done.
    cfg = make_project(tmp_path)
    results = tmp_path / ".supraspina" / "analysis" / "results"
    code = (
        "import json, os, sys, time\n"
        "job = json.loads(sys.stdin.buffer.read())\n"
        f"folder = {str(results)!r}\n"
        "os.makedirs(folder, exist_ok=True)\n"
        "open(os.path.join(folder, job['resultId'] + '.json'), 'w').write('{}')\n"
        "time.sleep(120)\n"
    )
    spawn, processes = _spawner(code)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    operation = _start(mgr, tmp_path, cfg)["operation"]
    _wait(lambda: results.is_dir() and any(results.glob("gar-*.json")))
    result_id = next(results.glob("gar-*.json")).stem

    stopped = mgr.cancel(request(tmp_path, cfg, operationId=operation["operationId"]))

    assert stopped == {"operationId": operation["operationId"], "stopped": False}
    final = _operation(mgr, tmp_path, cfg)
    assert final["state"] == "done"
    assert final["resultId"] == result_id
    _wait(lambda: processes[0].poll() is not None, timeout=15)


def test_a_cancel_before_the_result_file_is_committed_stops(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    results = tmp_path / ".supraspina" / "analysis" / "results"
    # Only an uncommitted temporary file exists when the cancel lands.
    code = (
        "import os, sys, time\n"
        "sys.stdin.buffer.read()\n"
        f"folder = {str(results)!r}\n"
        "os.makedirs(folder, exist_ok=True)\n"
        "open(os.path.join(folder, '.tmp-partial'), 'w').write('{')\n"
        "time.sleep(120)\n"
    )
    spawn, _processes = _spawner(code)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    operation = _start(mgr, tmp_path, cfg)["operation"]
    _wait((results / ".tmp-partial").exists)

    stopped = mgr.cancel(request(tmp_path, cfg, operationId=operation["operationId"]))

    assert stopped["stopped"] is True
    final = _finished(mgr, tmp_path, cfg)
    assert final["state"] == "cancelled"
    assert final["resultId"] is None


def test_another_projects_request_stops_the_running_compute(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    cfg = make_project(first)
    other = make_project(second)
    spawn, processes = _spawner(_SLOW_WORKER)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    _start(mgr, first, cfg)
    _wait(lambda: bool(processes) and _operation(mgr, first, cfg)["phase"] == "fitting")

    assert mgr.status(request(second, other, project_id="other-project")) == {
        "operation": None
    }

    _wait(lambda: processes[0].poll() is not None, timeout=10)
    operation = mgr._operation
    assert operation is not None
    assert operation.state == "cancelled"
    assert operation.message == "The project changed."


def test_stop_all_stops_and_joins_the_compute(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    spawn, processes = _spawner(_SLOW_WORKER)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    _start(mgr, tmp_path, cfg)
    _wait(lambda: bool(processes))

    mgr.stop_all(timeout=5)

    assert _operation(mgr, tmp_path, cfg)["state"] == "cancelled"
    _wait(lambda: processes[0].poll() is not None, timeout=10)
    thread = mgr._operation.thread if mgr._operation else None
    assert thread is not None
    assert not thread.is_alive()


@pytest.mark.parametrize(
    ("code", "message"),
    [
        (
            "import sys\nsys.stdin.buffer.read()\n"
            'print(\'{"event":"failed","message":"Choose fewer measures."}\')\n',
            "Choose fewer measures.",
        ),
        (
            'import sys\nsys.stdin.buffer.read()\nprint(\'{"event":"cancelled"}\')\n',
            None,
        ),
        (
            "import sys\nsys.stdin.buffer.read()\nprint('noise')\nraise SystemExit(3)\n",
            "The analysis worker stopped before it finished. Compute again.",
        ),
    ],
)
def test_a_failed_worker_is_reported(
    tmp_path: Path, code: str, message: str | None
) -> None:
    cfg = make_project(tmp_path)
    spawn, _processes = _spawner(code)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)

    _start(mgr, tmp_path, cfg)
    operation = _finished(mgr, tmp_path, cfg)

    assert operation["state"] == ("cancelled" if message is None else "failed")
    assert operation["message"] == message
    assert operation["finishedAt"] is not None


def test_a_compute_that_fits_nothing_reports_the_skip_reasons(
    tmp_path: Path,
) -> None:
    cfg = make_project(tmp_path)
    spawn, _processes = _spawner(_FAKE_WORKER)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)

    _start(mgr, tmp_path, cfg, measures=["aseg:5th-Ventricle"])
    operation = _finished(mgr, tmp_path, cfg)

    assert operation["state"] == "failed"
    assert operation["resultId"] is None
    assert operation["message"].startswith("No selected measure could be fit:")
    assert operation["skipped"] == [
        {
            "measureId": "aseg:5th-Ventricle",
            "reason": "The values do not vary across subjects.",
        }
    ]
    assert _listed(mgr, tmp_path, cfg) == []
    # A later compute clears the reasons.
    _compute(mgr, tmp_path, cfg)
    assert "skipped" not in _operation(mgr, tmp_path, cfg)


def test_malformed_skip_reasons_are_dropped() -> None:
    rows = [
        {"measureId": "aseg:Brain-Stem", "reason": "x" * 600},
        {"measureId": 3, "reason": "y"},
        {"measureId": "aseg:CSF", "reason": ""},
        "nonsense",
    ]
    assert manager._skipped_rows(rows) == [
        {"measureId": "aseg:Brain-Stem", "reason": "x" * 512}
    ]
    assert manager._skipped_rows("nonsense") is None
    assert len(manager._skipped_rows([rows[0]] * 100) or []) == worker.MAX_SKIPPED


def test_a_worker_that_cannot_start_is_reported(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)

    def spawn(_argv: list[str]) -> subprocess.Popen[bytes]:
        raise OSError("no binary")

    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    _start(mgr, tmp_path, cfg)

    assert (
        _finished(mgr, tmp_path, cfg)["message"]
        == "The analysis worker could not start."
    )


def test_a_failure_after_the_start_is_named_and_the_worker_reaped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = make_project(tmp_path)
    spawn, processes = _spawner(_SLOW_WORKER)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)

    def broken(*_args: Any) -> None:
        raise RuntimeError("secret /path detail")

    monkeypatch.setattr(mgr, "_follow", broken)
    _start(mgr, tmp_path, cfg)
    operation = _finished(mgr, tmp_path, cfg)

    assert operation["state"] == "failed"
    assert operation["message"] == (
        "The analysis stopped on an internal error. Compute again."
    )
    # The worker was killed and waited for: no process and no zombie remain.
    _wait(lambda: processes[0].returncode is not None, timeout=15)
    assert processes[0].returncode == -signal.SIGKILL
    assert not Path(f"/proc/{processes[0].pid}").exists()


def test_start_refuses_a_malformed_stage_currency(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    mgr = GroupAnalysisManager(ProjectEpochs())
    with pytest.raises(GroupAnalysisError, match="stage currency"):
        mgr.start(
            request(
                tmp_path,
                cfg,
                spec=example_spec(),
                stageCurrency={"aggregate": "current"},
            )
        )


# -- Results and currency ---------------------------------------------------


def test_a_compute_is_stored_listed_read_and_exported(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    spawn, _processes = _spawner(_FAKE_WORKER)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    saved = mgr.save_spec(
        request(
            tmp_path,
            cfg,
            specId=None,
            name="Primary",
            spec=example_spec(),
            expectedRevision=0,
        )
    )

    result_id = _compute(mgr, tmp_path, cfg)

    listed = _listed(mgr, tmp_path, cfg)
    assert [item["resultId"] for item in listed] == [result_id]
    summary = listed[0]
    assert summary["currency"] == "current"
    assert summary["staleReasons"] == []
    assert summary["specId"] == saved["specs"][0]["specId"]
    assert summary["name"] == "Primary"
    assert summary["measureCount"] == 2
    assert summary["significantCount"] == 1
    assert summary["pinned"] is False
    assert summary["analysis"] == "group-comparison"

    result = mgr.result(request(tmp_path, cfg, resultId=result_id))
    assert list(result) == list(store.PUBLIC_FIELDS)
    assert result["specDigest"] == saved["specs"][0]["specDigest"]

    detail = mgr.measure_detail(
        request(tmp_path, cfg, resultId=result_id, measureId="aseg:Brain-Stem")
    )
    assert detail["row"]["measureId"] == "aseg:Brain-Stem"
    assert len(detail["subjects"]) == 10
    assert detail["groupMeans"][0]["role"] == "focal"
    with pytest.raises(
        GroupAnalysisError, match="Select a measure this result contains"
    ):
        mgr.measure_detail(
            request(tmp_path, cfg, resultId=result_id, measureId="aseg:Optic-Chiasm")
        )

    exported = mgr.export_data(
        request(tmp_path, cfg, resultId=result_id, subjectCsv=True)
    )
    assert [item["name"] for item in exported["files"]] == [
        "results.csv",
        "subjects.csv",
        "spec.json",
    ]
    # Main pins the result only after the export is written.
    assert _listed(mgr, tmp_path, cfg)[0]["pinned"] is False
    assert mgr.pin_result(request(tmp_path, cfg, resultId=result_id)) == {
        "resultId": result_id,
        "pinned": True,
    }
    assert _listed(mgr, tmp_path, cfg)[0]["pinned"] is True
    with pytest.raises(GroupAnalysisError, match="Select a stored analysis result"):
        mgr.pin_result(request(tmp_path, cfg, resultId="gar-0000000000000000"))
    with pytest.raises(GroupAnalysisError, match="subjectCsv"):
        mgr.export_data(request(tmp_path, cfg, resultId=result_id, subjectCsv="yes"))
    with pytest.raises(GroupAnalysisError, match="Select a stored analysis result"):
        mgr.result(request(tmp_path, cfg, resultId="gar-0000000000000000"))


def test_an_unsaved_result_is_named_after_its_contrast(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    spawn, _processes = _spawner(_FAKE_WORKER)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)

    result_id = _compute(mgr, tmp_path, cfg)

    record = store.read_result(str(tmp_path), result_id)
    assert record is not None
    assert record["specId"] is None
    assert record["name"] == "SCI vs CTRL"


def test_an_oversized_result_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = make_project(tmp_path)
    spawn, _processes = _spawner(_FAKE_WORKER)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    result_id = _compute(mgr, tmp_path, cfg)
    monkeypatch.setattr(manager, "MAX_RESULT_BYTES", 100)

    with pytest.raises(GroupAnalysisError, match="export it instead"):
        mgr.result(request(tmp_path, cfg, resultId=result_id))


def test_stale_reasons_name_what_changed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = make_project(tmp_path)
    flags: list[dict[str, Any]] = []
    spawn, _processes = _spawner(_FAKE_WORKER)
    mgr = GroupAnalysisManager(
        ProjectEpochs(),
        spawn=spawn,
        registration_status=lambda _req: {"subjects": flags},
    )
    _compute(mgr, tmp_path, cfg)

    def reasons() -> list[dict[str, Any]]:
        summary = _listed(mgr, tmp_path, cfg)[0]
        assert summary["currency"] == (
            "stale" if summary["staleReasons"] else "current"
        )
        return summary["staleReasons"]

    assert reasons() == []

    icv = tmp_path / "outputs" / "run" / "structural" / "icv_data.csv"
    original = icv.read_bytes()
    icv.write_bytes(original + b"sub-99,1\n")
    assert reasons() == [
        {"code": "inputs-changed", "added": 0, "removed": 0, "sources": ["icv"]}
    ]
    icv.write_bytes(original)
    assert reasons() == []

    # An unused table never makes the result stale.
    (tmp_path / "metadata" / "metadata.csv").write_text(
        "participant_id\n", encoding="utf-8"
    )
    assert reasons() == []

    write_qc(tmp_path, {"sub-02": "fail"})
    assert reasons() == [
        {"code": "qc-changed-sample", "added": 0, "removed": 1, "sources": []}
    ]
    write_qc(tmp_path, {})
    assert reasons() == []

    registry = RegistryStore(str(tmp_path))
    record = {
        "subjectId": "sub-03",
        "age": 41,
        "sex": "F",
        "sourceCohortLabel": "SCI_P",
        "ais": None,
        "tSinceSci": None,
    }
    registry.upsert(record, expected_revision=1)
    assert reasons() == [
        {"code": "registry-changed", "added": 0, "removed": 0, "sources": []}
    ]
    registry.upsert({**record, "sourceCohortLabel": "CTRL"}, expected_revision=2)
    assert reasons() == []

    flags.append(
        {
            "subjectId": "sub-02",
            "flagged": True,
            "hemispheres": [
                {"hemisphere": "lh", "state": "checked", "flagged": True},
                {"hemisphere": "rh", "state": "checked", "flagged": False},
            ],
        }
    )
    assert reasons() == [
        {"code": "registration-changed", "added": 0, "removed": 0, "sources": []}
    ]
    flags.clear()

    monkeypatch.setattr(manager, "ENGINE_ID", "ols-freedman-lane-maxt-v2")
    assert reasons() == [
        {"code": "engine-changed", "added": 0, "removed": 0, "sources": []}
    ]


def test_a_sample_change_from_a_table_counts_the_subjects(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    spawn, _processes = _spawner(_FAKE_WORKER)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    _compute(mgr, tmp_path, cfg, measures=["aseg:Brain-Stem"])

    dk = tmp_path / "outputs" / "run" / "structural" / "dk_all_stats.csv"
    lines = dk.read_text(encoding="utf-8").splitlines()
    dk.write_text(
        "\n".join(line for line in lines if not line.startswith("sub-04")) + "\n"
    )

    assert _listed(mgr, tmp_path, cfg)[0]["staleReasons"] == [
        {
            "code": "inputs-changed",
            "added": 0,
            "removed": 1,
            "sources": ["dk-all-stats"],
        }
    ]


def test_subjects_left_without_a_fittable_measure_are_sample_too_small(
    tmp_path: Path,
) -> None:
    cfg = make_project(tmp_path)
    spawn, _processes = _spawner(_FAKE_WORKER)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    _compute(mgr, tmp_path, cfg, measures=["aseg:Brain-Stem"])

    # Four of five SCI subjects fail QC: SCI keeps one value, the measure
    # is skipped, and the other six subjects have no measure left. No input
    # table changed, so this is not inputs-changed.
    write_qc(
        tmp_path, {sid: "fail" for sid in ("sub-06", "sub-07", "sub-08", "sub-09")}
    )

    assert _listed(mgr, tmp_path, cfg)[0]["staleReasons"] == [
        {"code": "qc-changed-sample", "added": 0, "removed": 4, "sources": []},
        {"code": "sample-too-small", "added": 0, "removed": 6, "sources": []},
    ]


def _counting_judge(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    judged: list[str] = []
    real = manager.judge_currency

    def judge(record: Any, *args: Any) -> Any:
        judged.append(record["resultId"])
        return real(record, *args)

    monkeypatch.setattr(manager, "judge_currency", judge)
    return judged


def test_an_unchanged_project_lists_from_memory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = make_project(tmp_path)
    spawn, _processes = _spawner(_FAKE_WORKER)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    first = _compute(mgr, tmp_path, cfg)
    second = _compute(mgr, tmp_path, cfg, measures=["aseg:Brain-Stem"])
    judged = _counting_judge(monkeypatch)

    assert {r["currency"] for r in _listed(mgr, tmp_path, cfg)} == {"current"}
    assert sorted(judged) == sorted([first, second])
    judged.clear()
    assert {r["currency"] for r in _listed(mgr, tmp_path, cfg)} == {"current"}
    assert judged == []

    # Any change to what a judgement reads judges again.
    icv = tmp_path / "outputs" / "run" / "structural" / "icv_data.csv"
    icv.write_bytes(icv.read_bytes() + b"sub-99,1\n")
    assert {r["currency"] for r in _listed(mgr, tmp_path, cfg)} == {"stale"}
    assert sorted(judged) == sorted([first, second])


def test_results_past_the_budget_are_judged_in_the_background(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = make_project(tmp_path)
    spawn, _processes = _spawner(_FAKE_WORKER)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    for _ in range(3):
        _compute(mgr, tmp_path, cfg)
    judged = _counting_judge(monkeypatch)
    monkeypatch.setattr(manager, "JUDGE_BUDGET_SECONDS", 0.0)

    started = time.monotonic()
    listed = _listed(mgr, tmp_path, cfg)
    # Nothing is judged on the RPC thread once the budget is spent.
    assert time.monotonic() - started < 1.0
    assert {r["currency"] for r in listed} == {"unknown"}
    assert mgr._judging is not None
    mgr._judging[0].join(30)
    assert len(judged) == 3

    judged.clear()
    assert {r["currency"] for r in _listed(mgr, tmp_path, cfg)} == {"current"}
    assert judged == []


def test_a_superseded_background_judge_stops(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = make_project(tmp_path)
    spawn, _processes = _spawner(_FAKE_WORKER)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    _compute(mgr, tmp_path, cfg)
    judged = _counting_judge(monkeypatch)
    context = dataset.AnalysisContext(
        project_root=str(tmp_path), cfg=cfg, config_revision=3
    )

    mgr._latest = "newer"
    mgr._judge_later(context, "older", store.list_results(str(tmp_path)))
    assert mgr._judging is not None
    mgr._judging[0].join(30)

    assert judged == []


def test_currency_is_unknown_when_the_project_cannot_be_judged(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    spawn, _processes = _spawner(_FAKE_WORKER)
    mgr = GroupAnalysisManager(ProjectEpochs(), spawn=spawn)
    _compute(mgr, tmp_path, cfg)
    (tmp_path / ".supraspina" / "registry.json").write_text("{", encoding="utf-8")

    summary = _listed(mgr, tmp_path, cfg)[0]

    assert summary["currency"] == "unknown"
    assert summary["staleReasons"] == []


def test_a_corrupt_store_reads_as_empty(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    folder = tmp_path / ".supraspina" / "analysis" / "results"
    folder.mkdir(parents=True)
    (folder.parent / "specs.json").write_text("[1, 2", encoding="utf-8")
    (folder / "gar-0000000000000001.json").write_text("{}", encoding="utf-8")
    (folder / "gar-0000000000000002.json").write_bytes(b"\x00\xff")
    mgr = GroupAnalysisManager(ProjectEpochs())

    assert mgr.list(request(tmp_path, cfg)) == {
        "revision": 0,
        "specs": [],
        "sets": [],
        "results": [],
    }
    with pytest.raises(GroupAnalysisError, match="Select a stored analysis result"):
        mgr.result(request(tmp_path, cfg, resultId="gar-0000000000000001"))


# -- Wiring -----------------------------------------------------------------


def test_dispatcher_registers_the_surface_and_advertises_the_capability(
    tmp_path: Path,
) -> None:
    dispatcher = entrypoint.build_dispatcher(Emitter(io.StringIO()))
    try:
        surface = json.loads(
            (_SIDECAR.parent / "src" / "shared" / "ipc-surface.json").read_text(
                encoding="utf-8"
            )
        )
        analysis = [m for m in surface["sidecar"] if m.startswith("groupAnalysis.")]
        assert len(analysis) == 19
        internal = {
            "groupAnalysis.exportData",
            "groupAnalysis.pinResult",
            "groupAnalysis.importVariables",
            "groupAnalysis.deleteVariables",
            "groupAnalysis.importAtlas",
            "groupAnalysis.importAtlasLabels",
        }
        assert set(analysis) | internal <= set(dispatcher.methods)
        assert internal.isdisjoint(surface["sidecar"])

        cfg = make_project(tmp_path)
        listed = dispatcher._handlers["groupAnalysis.list"](
            [request(tmp_path, cfg)], dispatcher.emitter
        )
        assert listed["results"] == []

        workflow = dispatcher.workflow_manager
        handshake = entrypoint._handshake(
            [
                {
                    "productVersion": entrypoint.__version__,
                    "protocolVersion": "1",
                    "generation": 1,
                }
            ],
            workflow,
        )
        assert {
            "cohort-analysis-v1",
            "cohort-analysis-v2",
            "atlas-labeling-v1",
        } <= set(handshake["capabilities"])
    finally:
        dispatcher.managed_resource_manager.shutdown()
        dispatcher.provision_manager.shutdown()
        dispatcher.workflow_manager.shutdown()
        dispatcher.workflow_manager.project_epochs.detach_all()


def test_shutdown_and_detach_stop_the_analysis(tmp_path: Path) -> None:
    dispatcher = entrypoint.build_dispatcher(Emitter(io.StringIO()))
    calls: list[float] = []
    dispatcher.group_analysis_manager.stop_all = lambda timeout=0.0: calls.append(
        timeout
    )
    try:
        project = request(tmp_path, {})["project"]
        dispatcher.workflow_manager.project_epochs.validate(project)
        dispatcher._handlers["system.detachProject"](
            [{"project": project}], dispatcher.emitter
        )
        dispatcher._handlers["system.shutdown"](
            [{"timeoutMs": 500}], dispatcher.emitter
        )
        assert calls[0] == 0.0
        assert 0 < calls[1] <= 2.0
    finally:
        dispatcher.managed_resource_manager.shutdown()
        dispatcher.provision_manager.shutdown()
        dispatcher.workflow_manager.shutdown()
        dispatcher.workflow_manager.project_epochs.detach_all()


def test_the_rpc_process_never_imports_numpy(tmp_path: Path) -> None:
    # The manager and the whole entry point serve RPCs; only the worker
    # process loads the engine and numpy. The Clinical detector reads the
    # workbook with openpyxl in the RPC process, and openpyxl's optional
    # numpy probe would map numpy's OpenBLAS there.
    from openpyxl import Workbook  # noqa: PLC0415

    from supraspina_sidecar.adapters.clinical import TEMPLATE_COLUMNS  # noqa: PLC0415

    workbook = tmp_path / "Template_Analysis.xlsx"
    book = Workbook()
    book.active.append(list(TEMPLATE_COLUMNS))
    book.active.append(["sub-101", 30, "M", "control", 31.0, 1.0, None, None])
    book.save(workbook)
    code = (
        "import io, sys\n"
        "sys.stdin = io.TextIOWrapper(io.BytesIO())\n"
        "import supraspina_sidecar.group_analysis.manager\n"
        "import supraspina_sidecar.__main__ as entry\n"
        "entry.main()\n"
        "import supraspina_sidecar.adapters\n"
        "from supraspina_sidecar.adapters.clinical import inspect_workbook\n"
        f"status = inspect_workbook({str(workbook)!r}, ['Cohort', 'AIS'])\n"
        "print(status.state)\n"
        "print(sorted(m for m in sys.modules if m.split('.')[0] == 'numpy'"
        " or m.endswith('group_analysis.engine')))\n"
    )
    completed = subprocess.run(  # noqa: S603 - A fixed interpreter and code.
        [sys.executable, "-c", code],
        check=True,
        capture_output=True,
        text=True,
        cwd=_SIDECAR,
    )
    assert completed.stdout.strip().splitlines()[-2:] == ["done", "[]"]


def test_the_analysis_worker_still_imports_numpy() -> None:
    # The RPC process refuses numpy to openpyxl only; the worker process
    # computes with it.
    code = (
        "import sys\n"
        "from supraspina_sidecar.group_analysis import engine\n"
        "print('numpy' in sys.modules)\n"
    )
    completed = subprocess.run(  # noqa: S603 - A fixed interpreter and code.
        [sys.executable, "-c", code],
        check=True,
        capture_output=True,
        text=True,
        cwd=_SIDECAR,
    )
    assert completed.stdout.strip() == "True"


def test_frozen_entry_routes_the_worker_flag_before_the_package_import() -> None:
    entry = Path(entrypoint.__file__).parents[1] / "pyinstaller_entry.py"
    source = entry.read_text(encoding="utf-8")
    tree = ast.parse(source)
    package_import = next(
        index
        for index, statement in enumerate(tree.body)
        if isinstance(statement, ast.ImportFrom)
        and statement.module == "supraspina_sidecar.__main__"
    )
    routed = [
        statement
        for statement in tree.body[:package_import]
        if isinstance(statement, ast.If)
        and "_GROUP_ANALYSIS_WORKER_ARG" in ast.unparse(statement.test)
    ]
    assert len(routed) == 1
    assert f'"{worker.WORKER_FLAG}"' in source


def test_the_default_spawn_starts_a_single_threaded_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, Any] = {}

    class _Popen:
        def __init__(self, argv: list[str], **kwargs: Any) -> None:
            seen["argv"] = argv
            seen.update(kwargs)

    monkeypatch.setattr(manager.subprocess, "Popen", _Popen)
    manager._spawn_worker(["worker"])

    assert seen["argv"] == ["worker"]
    assert seen["start_new_session"] is True
    assert seen["env"]["OMP_NUM_THREADS"] == "1"
    assert seen["stderr"] == subprocess.DEVNULL
