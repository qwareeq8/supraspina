"""Tests for the compute worker process."""

from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.group_analysis import engine, identity, store, worker
from supraspina_sidecar.group_analysis.spec import GroupAnalysisError
from supraspina_sidecar.registry_store import RegistryStore
from tests.group_analysis_support import example_spec, fake_run, make_project

_RESULT_ID = "gar-0123456789abcdef"
_SIDECAR = Path(__file__).resolve().parents[1]


def _job(root: Path, cfg: dict[str, Any], **changes: Any) -> dict[str, Any]:
    job = {
        "schema": worker.JOB_SCHEMA,
        "schemaVersion": 1,
        "resultId": _RESULT_ID,
        "specId": None,
        "name": "SCI vs CTRL",
        "projectRoot": str(root),
        "spec": example_spec(),
        "context": {
            "cfg": cfg,
            "configRevision": 3,
            "registry": RegistryStore(str(root)).list(),
            "qc": {},
            "registration": [],
            "registrationKnown": True,
        },
        "stageCurrency": {"aggregate": "current", "pybrainage": "outdated"},
        "productVersion": "20261121.1830.0",
        "build": None,
    }
    job.update(changes)
    return job


def _events(text: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in text.splitlines()]


def test_a_job_writes_one_sealed_result_and_reports_progress(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = make_project(tmp_path)
    monkeypatch.setattr(engine, "run", fake_run)
    out = io.StringIO()

    assert worker.run_job(_job(tmp_path, cfg), out) == 0

    events = _events(out.getvalue())
    assert events[0] == {
        "event": "progress",
        "phase": "preparing",
        "completed": 0,
        "total": 0,
    }
    assert {
        "event": "progress",
        "phase": "fitting",
        "completed": 2,
        "total": 2,
    } in events
    assert events[-2]["phase"] == "writing"
    assert events[-1] == {"event": "done", "resultId": _RESULT_ID}

    record = store.read_result(str(tmp_path), _RESULT_ID)
    assert record is not None
    assert record["engine"] == {
        "id": identity.ENGINE_ID,
        "rng": identity.RNG_ID,
        "productVersion": "20261121.1830.0",
        "build": None,
    }
    assert record["provisional"] is False
    assert record["sample"]["groups"] == [
        {"label": "SCI", "n": 5},
        {"label": "CTRL", "n": 5},
    ]
    assert record["sample"]["excluded"] == [
        {"subjectId": "sub-11", "reason": "no-measures"}
    ]
    assert [row["measureId"] for row in record["rows"]] == [
        "aseg:Brain-Stem",
        "dk:bi:precentral:ThickAvg",
    ]
    assert record["skipped"][0]["measureId"] == "aseg:bi:Thalamus"
    assert record["state"]["usedSources"] == ["dk-all-stats", "icv"]
    assert {row["source"] for row in record["inputs"]} >= {"dk-all-stats", "icv"}
    values = record["detail"]["measures"]["aseg:Brain-Stem"]["values"]
    assert len(values) == 10
    assert record["detail"]["subjects"]["sub-06"] == ["SCI", "SCI_P"]
    # The worker writes nothing but the result under the store.
    analysis = tmp_path / ".supraspina" / "analysis"
    written = sorted(
        path.relative_to(analysis).as_posix() for path in analysis.rglob("*")
    )
    assert written == ["results", f"results/{_RESULT_ID}.json"]


@pytest.mark.parametrize(
    ("measures", "currency", "registration", "provisional"),
    [
        (
            ["aseg:Brain-Stem"],
            {"aggregate": "outdated", "pybrainage": "current"},
            [],
            True,
        ),
        (
            ["brainage:BrainPAD"],
            {"aggregate": "outdated", "pybrainage": "current"},
            [],
            False,
        ),
        (
            ["brainage:BrainPAD"],
            {"aggregate": "current", "pybrainage": "unknown"},
            [],
            True,
        ),
        (
            ["dk:lh:precentral:ThickAvg"],
            {"aggregate": "current", "pybrainage": "unknown"},
            [
                {
                    "subjectId": "sub-02",
                    "hemispheres": [
                        {"hemisphere": "lh", "state": "pending", "flagged": False}
                    ],
                }
            ],
            True,
        ),
    ],
)
def test_provisional_follows_the_stages_and_checks_the_spec_uses(  # noqa: PLR0913
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    measures: list[str],
    currency: dict[str, str],
    registration: list[dict[str, Any]],
    provisional: bool,
) -> None:
    cfg = make_project(tmp_path)
    monkeypatch.setattr(engine, "run", fake_run)
    analysis = "brain-age" if measures == ["brainage:BrainPAD"] else "group-comparison"
    job = _job(
        tmp_path,
        cfg,
        spec=example_spec(analysis=analysis, measures=measures),
        stageCurrency=currency,
    )
    job["context"]["registration"] = registration

    assert worker.run_job(job, io.StringIO()) == 0

    record = store.read_result(str(tmp_path), _RESULT_ID)
    assert record is not None
    assert record["provisional"] is provisional


def test_an_unapplied_outlier_rule_makes_the_result_provisional(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = make_project(tmp_path)
    monkeypatch.setattr(engine, "run", fake_run)
    (
        tmp_path / "outputs" / "run" / "qc_review" / "qa_outliers" / "outliers.csv"
    ).unlink()
    job = _job(
        tmp_path,
        cfg,
        spec=example_spec(inclusion={"outliers": "exclude-subject"}),
        stageCurrency={"aggregate": "current", "pybrainage": "current"},
    )

    assert worker.run_job(job, io.StringIO()) == 0

    record = store.read_result(str(tmp_path), _RESULT_ID)
    assert record is not None
    assert record["provisional"] is True
    assert record["sample"]["issues"] == [
        "The ENIGMA outlier table is missing, so the outlier rule was not applied."
    ]


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (GroupAnalysisError("Choose fewer measures."), "Choose fewer measures."),
        (
            RuntimeError("secret /path detail"),
            "The analysis stopped on an internal error. Compute again.",
        ),
    ],
)
def test_a_failure_reports_one_sentence_and_writes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, error: Exception, message: str
) -> None:
    cfg = make_project(tmp_path)

    def failing(*_args: Any, **_kwargs: Any) -> Any:
        raise error

    monkeypatch.setattr(engine, "run", failing)
    out = io.StringIO()

    assert worker.run_job(_job(tmp_path, cfg), out) == 1

    assert _events(out.getvalue())[-1] == {"event": "failed", "message": message}
    assert store.list_results(str(tmp_path)) == []


def test_a_cancelled_engine_reports_cancelled_and_writes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = make_project(tmp_path)

    def cancelled(*_args: Any, **_kwargs: Any) -> Any:
        raise engine.ComputeCancelled

    monkeypatch.setattr(engine, "run", cancelled)
    out = io.StringIO()

    assert worker.run_job(_job(tmp_path, cfg), out) == 1

    assert _events(out.getvalue())[-1] == {"event": "cancelled"}
    assert store.list_results(str(tmp_path)) == []


def test_done_is_reported_before_the_store_is_pruned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Pruning reads every stored result; a cancel landing then must
    # find the committed result already reported.
    cfg = make_project(tmp_path)
    monkeypatch.setattr(engine, "run", fake_run)
    out = io.StringIO()
    seen: list[list[dict[str, Any]]] = []
    real_prune = store.prune

    def prune(root: str) -> list[str]:
        seen.append(_events(out.getvalue()))
        assert store.result_committed(root, _RESULT_ID)
        return real_prune(root)

    monkeypatch.setattr(store, "prune", prune)

    assert worker.run_job(_job(tmp_path, cfg), out) == 0

    assert len(seen) == 1
    assert seen[0][-1] == {"event": "done", "resultId": _RESULT_ID}
    assert _events(out.getvalue())[-1] == seen[0][-1]


def test_a_failed_prune_still_reports_the_written_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = make_project(tmp_path)
    monkeypatch.setattr(engine, "run", fake_run)

    def broken(_root: str) -> list[str]:
        raise OSError("The disk went away.")

    monkeypatch.setattr(store, "prune", broken)
    out = io.StringIO()

    assert worker.run_job(_job(tmp_path, cfg), out) == 0
    assert _events(out.getvalue())[-1] == {"event": "done", "resultId": _RESULT_ID}


def test_the_real_engine_fits_the_fixture_end_to_end(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    out = io.StringIO()
    job = _job(
        tmp_path,
        cfg,
        spec=example_spec(inference={"permutations": 1000, "seed": 20260923}),
    )

    assert worker.run_job(job, out) == 0

    events = _events(out.getvalue())
    assert {"fitting", "permuting", "writing"} <= {
        event.get("phase") for event in events
    }
    record = store.read_result(str(tmp_path), _RESULT_ID)
    assert record is not None
    rows = {row["measureId"]: row for row in record["rows"]}
    assert set(rows) == {"aseg:Brain-Stem", "dk:bi:precentral:ThickAvg"}
    brainstem = rows["aseg:Brain-Stem"]
    assert brainstem["nFocal"] == 5
    assert brainstem["nReference"] == 5
    assert brainstem["df"] == 5
    assert 0 < brainstem["pCorrected"] <= 1
    detail = record["detail"]["measures"]["aseg:Brain-Stem"]
    assert len(detail["values"]) == 10
    assert {mean["role"] for mean in detail["groupMeans"]} >= {"focal", "reference"}


def test_a_job_without_fittable_measures_fails_before_the_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = make_project(tmp_path)
    monkeypatch.setattr(engine, "run", fake_run)
    out = io.StringIO()

    job = _job(tmp_path, cfg, spec=example_spec(measures=["aseg:5th-Ventricle"]))
    assert worker.run_job(job, out) == 1

    assert _events(out.getvalue())[-1] == {
        "event": "failed",
        "message": (
            "No selected measure could be fit: the measure was skipped because "
            "the values do not vary across subjects."
        ),
        "skipped": [
            {
                "measureId": "aseg:5th-Ventricle",
                "reason": "The values do not vary across subjects.",
            }
        ],
    }
    assert store.list_results(str(tmp_path)) == []


def test_too_few_subjects_for_the_model_store_no_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = make_project(tmp_path)
    cfg["subjects"] = {
        "include": ["sub-01", "sub-02", "sub-03", "sub-06", "sub-07"],
        "exclude": [],
    }
    monkeypatch.setattr(engine, "run", fake_run)
    out = io.StringIO()
    job = _job(
        tmp_path,
        cfg,
        spec=example_spec(measures=["aseg:Brain-Stem"]),
    )

    assert worker.run_job(job, out) == 1

    event = _events(out.getvalue())[-1]
    assert event["message"] == (
        "No selected measure could be fit: the measure has fewer subjects than "
        "the model's 5 parameters plus 1 (at most 5 subjects have a value)."
    )
    assert [row["measureId"] for row in event["skipped"]] == ["aseg:Brain-Stem"]
    assert store.list_results(str(tmp_path)) == []


def test_an_engine_that_fits_nothing_stores_no_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = make_project(tmp_path)
    reason = "The model is rank deficient for the subjects with this measure."

    def nothing(data: Any, spec: Any, **_: Any) -> engine.EngineOutput:
        return engine.EngineOutput(
            rows=[],
            skipped=[{"measureId": m, "reason": reason} for m in data.measures],
        )

    monkeypatch.setattr(engine, "run", nothing)
    out = io.StringIO()

    assert worker.run_job(_job(tmp_path, cfg), out) == 1

    event = _events(out.getvalue())[-1]
    assert event["message"] == (
        "No selected measure could be fit: 2 of 3 measures were skipped because "
        "the model is rank deficient for the subjects with this measure."
    )
    # The fixture's thalamus is constant, so the dataset skipped it first.
    assert [row["reason"] for row in event["skipped"]] == [
        "The values do not vary across subjects.",
        reason,
        reason,
    ]
    assert store.list_results(str(tmp_path)) == []


@pytest.mark.parametrize(
    "payload",
    [
        b"not json",
        b"[]",
        json.dumps({"schema": "other"}).encode(),
    ],
)
def test_main_refuses_a_malformed_job(
    payload: bytes,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(worker.sys, "stdin", io.TextIOWrapper(io.BytesIO(payload)))
    monkeypatch.setattr(worker.os, "nice", lambda _increment: 0)

    assert worker.main([]) == 1

    event = json.loads(capsys.readouterr().out.strip())
    assert event["event"] == "failed"
    assert event["message"].startswith("The analysis job is")


def test_main_runs_a_valid_job_from_stdin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    cfg = make_project(tmp_path)
    monkeypatch.setattr(engine, "run", fake_run)
    payload = json.dumps(_job(tmp_path, cfg)).encode()
    monkeypatch.setattr(worker.sys, "stdin", io.TextIOWrapper(io.BytesIO(payload)))
    monkeypatch.setattr(worker.os, "nice", lambda _increment: 0)

    assert worker.main([]) == 0

    assert _events(capsys.readouterr().out)[-1]["event"] == "done"


def test_the_development_command_starts_a_single_threaded_worker() -> None:
    completed = subprocess.run(  # noqa: S603 - The argv is worker_command().
        worker.worker_command(),
        input=b"{}",
        capture_output=True,
        cwd=_SIDECAR,
        env=worker.single_threaded_environment({"PATH": "/usr/bin:/bin"}),
        timeout=60,
        check=False,
    )

    assert completed.returncode == 1
    assert json.loads(completed.stdout) == {
        "event": "failed",
        "message": "The analysis job is malformed.",
    }


def test_the_worker_flag_and_command_forms(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(worker.sys, "frozen", True, raising=False)
    assert worker.worker_command()[1:] == [worker.WORKER_FLAG]
    monkeypatch.delattr(worker.sys, "frozen")
    assert worker.worker_command() == [
        sys.executable,
        "-m",
        "supraspina_sidecar.group_analysis.worker",
    ]
    environment = worker.single_threaded_environment({"PATH": "/bin"})
    assert environment["OMP_NUM_THREADS"] == "1"
    assert environment["OPENBLAS_NUM_THREADS"] == "1"
    assert environment["PATH"] == "/bin"
