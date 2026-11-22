"""The compute worker process.

The manager starts ``worker_command()`` in its own session, writes one job
JSON document to its stdin, and reads JSON lines from its stdout:

- ``{"event": "progress", "phase": ..., "completed": n, "total": m}``
- ``{"event": "done", "resultId": ...}`` after the result is written
- ``{"event": "failed", "message": ...}`` with one operator-safe sentence,
  plus ``"skipped"`` (the skip reasons) when no selected measure could be fit
- ``{"event": "cancelled"}`` when the engine stopped at a cancellation check

The job is ``{"schema": "supraspina/group-analysis-job", "schemaVersion": 1,
"resultId", "specId", "name", "projectRoot", "spec", "context",
"stageCurrency", "productVersion", "build"}``, where ``context`` carries the
snapshotted configuration (``cfg``, ``configRevision``), ``registry``,
``qc``, ``registration``, and ``registrationKnown``. A spec v2 job runs the
v2 engine on the v2 input (``engine_input``) and writes a v2 record with
terms (:func:`build_record_v2`). The worker lowers its
priority (``os.nice(10)``), pins numerical libraries to one thread before
importing them, reads every table once (the digests it records describe the
bytes it used), writes the result atomically, and exits. A killed worker
leaves no partial result; a worker whose parent sidecar exits stops at the
next cancellation check.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import sys
from typing import IO, Any

#: The frozen-binary flag ``pyinstaller_entry.py`` routes to :func:`main`.
WORKER_FLAG = "--supraspina-group-analysis-worker"
JOB_SCHEMA = "supraspina/group-analysis-job"
PHASES = frozenset({"preparing", "fitting", "permuting", "writing"})

_MAX_JOB_BYTES = 64 * 1024 * 1024
_RESULT_ID = re.compile(r"gar-[a-f0-9]{16}")
_SPEC_ID = re.compile(r"gas-[a-f0-9]{16}")
_THREAD_VARIABLES = (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
)
_INTERNAL_FAILURE = "The analysis stopped on an internal error. Compute again."
#: The most skip reasons a failed event carries; 64 rows of at most 512
#: characters keep the line within the manager's 64 KiB event limit.
MAX_SKIPPED = 64


def worker_command() -> list[str]:
    """Return the exact argv that starts one worker.

    Returns
    -------
    list of str
        The frozen binary with :data:`WORKER_FLAG`, or this module under the
        current interpreter in development.
    """
    if getattr(sys, "frozen", False):
        return [sys.executable, WORKER_FLAG]
    return [sys.executable, "-m", "supraspina_sidecar.group_analysis.worker"]


def single_threaded_environment(base: dict[str, str]) -> dict[str, str]:
    """Return ``base`` with every numerical thread pool pinned to one thread."""
    return {**base, **dict.fromkeys(_THREAD_VARIABLES, "1")}


def emit(stream: IO[str], event: dict[str, Any]) -> None:
    """Write one JSON-line event and flush it."""
    stream.write(json.dumps(event, separators=(",", ":"), allow_nan=False) + "\n")
    stream.flush()


class JobError(ValueError):
    """Reject a malformed job document."""


class NoFit(Exception):
    """Stop a compute in which no selected measure could be fit."""

    def __init__(
        self, skipped: list[dict[str, Any]], too_small: dict[str, tuple[int, int]]
    ) -> None:
        """Keep every skip reason and the too-few-subjects counts."""
        super().__init__("No selected measure could be fit.")
        self.skipped = skipped
        self.too_small = too_small


def _read_job(stream: IO[bytes]) -> dict[str, Any]:
    payload = stream.read(_MAX_JOB_BYTES + 1)
    if len(payload) > _MAX_JOB_BYTES:
        raise JobError("The analysis job is larger than 64 MiB.")
    try:
        job = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise JobError("The analysis job is not valid JSON.") from exc
    required = {
        "schema",
        "schemaVersion",
        "resultId",
        "specId",
        "name",
        "projectRoot",
        "spec",
        "context",
        "stageCurrency",
        "productVersion",
        "build",
    }
    if (
        not isinstance(job, dict)
        or set(job) != required
        or job["schema"] != JOB_SCHEMA
        or job["schemaVersion"] != 1
        or not isinstance(job["resultId"], str)
        or not _RESULT_ID.fullmatch(job["resultId"])
        or not (job["specId"] is None or _SPEC_ID.fullmatch(str(job["specId"])))
        or not isinstance(job["projectRoot"], str)
        or not os.path.isabs(job["projectRoot"])
        or not isinstance(job["context"], dict)
    ):
        raise JobError("The analysis job is malformed.")
    return job


def _context(job: dict[str, Any]) -> Any:
    from .dataset import AnalysisContext  # noqa: PLC0415

    context = job["context"]
    return AnalysisContext(
        project_root=job["projectRoot"],
        cfg=context["cfg"],
        config_revision=int(context["configRevision"]),
        registry=tuple(context["registry"]),
        qc=dict(context["qc"]),
        registration=tuple(context["registration"]),
        registration_known=bool(context["registrationKnown"]),
    )


def _provisional(spec: Any, currency: dict[str, str], unjudged: bool) -> bool:
    """Say whether an input stage was not current or a check was not applied."""
    from .dataset import measure_source, takes_etiv  # noqa: PLC0415

    sources = {measure_source(measure) for measure in spec.measures}
    aggregate = bool(sources - {"brainage"}) or any(
        takes_etiv(measure, spec.covariates.etiv) for measure in spec.measures
    )
    return (
        (aggregate and currency.get("aggregate") != "current")
        or ("brainage" in sources and currency.get("pybrainage") != "current")
        or unjudged
    )


def build_record(
    job: dict[str, Any], spec: Any, context: Any, data: Any, output: Any
) -> dict[str, Any]:
    """Assemble one stored result from the job, the dataset, and the engine.

    Parameters
    ----------
    job
        The validated job document.
    context
        The job's ``AnalysisContext``.
    data
        The ``Dataset`` the engine fitted.
    output
        The ``EngineOutput``.

    Returns
    -------
    dict
        The record without ``resultSha256`` and ``pinned``, which the store
        adds.
    """
    from . import dataset, store  # noqa: PLC0415
    from .identity import ENGINE_ID, RNG_ID  # noqa: PLC0415
    from .spec import RESULT_SCHEMA, spec_digest  # noqa: PLC0415

    excluded = [
        {"subjectId": row["subjectId"], "reason": row["reason"]}
        for row in data.subjects
        if not row["included"]
    ]
    subject_info: dict[str, list[Any]] = {}
    measures: dict[str, dict[str, Any]] = {}
    for measure_id, rows in output.subject_values.items():
        values = []
        for row in rows:
            subject_info[row["subjectId"]] = [row["group"], row["sourceLabel"]]
            values.append([row["subjectId"], row["value"], row["adjusted"], row["x"]])
        measures[measure_id] = {
            "groupMeans": list(output.group_means.get(measure_id, [])),
            "values": values,
        }
    for measure_id, means in output.group_means.items():
        measures.setdefault(measure_id, {"groupMeans": list(means), "values": []})
    registration = data.registration_provisional and dataset.registration_relevant(spec)
    unjudged = registration or data.outliers_unapplied
    return {
        "schema": RESULT_SCHEMA,
        "schemaVersion": 1,
        "resultId": job["resultId"],
        "specId": job["specId"],
        "name": job["name"],
        "spec": spec.model_dump(mode="json", by_alias=True),
        "specDigest": spec_digest(spec),
        "createdAt": store.timestamp(),
        "engine": {
            "id": ENGINE_ID,
            "rng": RNG_ID,
            "productVersion": job["productVersion"],
            "build": job["build"],
        },
        "provisional": _provisional(spec, job["stageCurrency"], unjudged),
        "stageCurrency": job["stageCurrency"],
        "inputs": data.inputs,
        "sample": {
            "groups": dataset.group_counts(spec, data.groups),
            "included": len(data.subject_ids),
            "excluded": excluded,
            "issues": list(data.issues),
        },
        "rows": output.rows,
        "skipped": [*data.skipped, *output.skipped],
        "subjects": data.subjects,
        "state": {
            **dataset.context_state(context, spec),
            "usedSources": dataset.used_sources(spec),
        },
        "detail": {"subjects": subject_info, "measures": measures},
    }


_MAX_ISSUES = 16
_MAX_SKIPPED_ROWS = 20_000
_AGGREGATE_GLOBALS = frozenset({"eTIV", "meanThickness"})


def _stages_v2(spec: Any) -> set[str]:
    """Name the pipeline stages a spec v2's values depend on."""
    from .engine_input import takes_head_size  # noqa: PLC0415
    from .spec import parse_measure_id  # noqa: PLC0415

    measures = list(spec.measures)
    refs = [
        spec.covariates.age,
        spec.covariates.sex,
        *spec.covariates.extra,
        *(ref for test in spec.tests for ref in test.extraCovariates),
        *(test.variable.ref for test in spec.tests if test.variable),
        *(test.moderator.ref for test in spec.tests if test.moderator),
    ]
    measures += [
        ref.column for ref in refs if ref is not None and ref.source == "measure"
    ]
    stages: set[str] = set()
    for measure_id in measures:
        parts = parse_measure_id(measure_id)
        if parts is None:
            continue
        if parts.source in {"dk", "aseg"} or (
            parts.source == "global" and parts.name in _AGGREGATE_GLOBALS
        ):
            stages.add("aggregate")
        elif parts.source == "brainage":
            stages.add("pybrainage")
        else:
            stages.add("recon")
    if any(takes_head_size(m, spec) for m in spec.measures):
        stages.add(
            "aggregate" if spec.covariates.headSize.source == "etiv" else "recon"
        )
    return stages


def _provisional_v2(spec: Any, currency: dict[str, Any], data: Any) -> bool:
    """Say whether a v2 input stage was not current or a check was not applied.

    A stage the values depend on that is not current, an included subject
    whose reconstruction is out of date when per-subject files are read, an
    unjudged registration check that can change the sample, or an outlier
    rule that could not be applied.
    """
    stages = _stages_v2(spec)
    recon = currency.get("recon")
    if "recon" in stages:
        if not isinstance(recon, dict) or recon.get("state") != "current":
            return True
        if set(recon.get("outdatedSubjectIds", ())) & set(data.subject_ids):
            return True
    cortical = any(
        m.startswith(("dk:", "parc:")) or m == "global:meanThickness"
        for m in spec.measures
    )
    rule = spec.inclusion.registration
    registration = data.registration_provisional and (
        rule == "exclude-subject" or (rule == "set-missing" and cortical)
    )
    return (
        ("aggregate" in stages and currency.get("aggregate") != "current")
        or ("pybrainage" in stages and currency.get("pybrainage") != "current")
        or registration
        or data.outliers_unapplied
    )


def build_record_v2(
    job: dict[str, Any], spec: Any, data: Any, output: Any
) -> dict[str, Any]:
    """Assemble one stored v2 result from the job, the input, and the engine.

    The record keeps every term's rows and the measure detail; when it would
    exceed the store's ``MAX_RECORD_BYTES_V2``, the per-subject values are left out
    (the rows, group means, and fitted lines stay).

    Parameters
    ----------
    job
        The validated job document.
    data
        The ``EngineDataV2`` the engine fitted.
    output
        The ``EngineOutputV2``.

    Returns
    -------
    dict
        The record without ``resultSha256`` and ``pinned``, which the store
        adds.

    Raises
    ------
    GroupAnalysisError
        When even the record without per-subject values exceeds the cap.
    """
    from . import store  # noqa: PLC0415
    from .engine_input import sample_groups  # noqa: PLC0415
    from .identity import ENGINE_ID_V2, RNG_ID  # noqa: PLC0415
    from .result_detail import strip_subject_values  # noqa: PLC0415
    from .spec import GroupAnalysisError, spec_digest  # noqa: PLC0415

    record = {
        "schema": "supraspina/group-analysis-result",
        "schemaVersion": 2,
        "resultId": job["resultId"],
        "specId": job["specId"],
        "name": job["name"],
        "spec": spec.model_dump(mode="json", by_alias=True),
        "specDigest": spec_digest(spec),
        "createdAt": store.timestamp(),
        "engine": {
            "id": ENGINE_ID_V2,
            "rng": RNG_ID,
            "productVersion": job["productVersion"],
            "build": job["build"],
        },
        "provisional": _provisional_v2(spec, job["stageCurrency"], data),
        "stageCurrency": job["stageCurrency"],
        "inputs": data.inputs,
        "sample": {
            "groups": sample_groups(spec, data),
            "included": len(data.subject_ids),
            "excluded": [
                {"subjectId": row["subjectId"], "reason": row["reason"]}
                for row in data.subjects
                if not row["included"]
            ],
            "issues": list(data.issues)[:_MAX_ISSUES],
        },
        "terms": output.terms,
        "rows": output.rows,
        "skipped": [*data.skipped, *output.skipped][:_MAX_SKIPPED_ROWS],
        "subjects": data.subjects,
        "state": data.state,
        "detail": output.detail,
    }
    # Measure the sealed form the store checks, so a record within a few
    # bytes of the cap is stripped here rather than refused by the store.
    cap = store.MAX_RECORD_BYTES_V2
    if store.sealed_size(record) > cap:
        record["detail"] = strip_subject_values(output.detail)
        if store.sealed_size(record) > cap:
            raise GroupAnalysisError(store.RECORD_TOO_LARGE_V2)
    return record


def _orphaned(parent: int) -> bool:
    return os.getppid() != parent


def run_job(job: dict[str, Any], out: IO[str]) -> int:
    """Compute one job, write its result, and report on ``out``.

    Returns
    -------
    int
        0 after a written result, 1 after a failure.
    """
    from . import dataset, engine, store  # noqa: PLC0415
    from .spec import (  # noqa: PLC0415
        GroupAnalysisError,
        GroupAnalysisSpecV2,
        parse_spec,
    )

    parent = os.getppid()

    def progress(phase: str, completed: int, total: int) -> None:
        if phase in PHASES:
            emit(
                out,
                {
                    "event": "progress",
                    "phase": phase,
                    "completed": max(0, int(completed)),
                    "total": max(0, int(total)),
                },
            )

    try:
        spec = parse_spec(job["spec"])
        context = _context(job)
        progress("preparing", 0, 0)
        if isinstance(spec, GroupAnalysisSpecV2):
            from . import engine_input, engine_v2  # noqa: PLC0415

            data = engine_input.load_engine_data(context, spec)
            if not data.measures:
                raise NoFit(data.skipped, data.too_small)
            output = engine_v2.run(
                data, spec, progress=progress, cancelled=lambda: _orphaned(parent)
            )
        else:
            data = dataset.load_dataset(context, spec)
            if not data.measures:
                raise NoFit(data.skipped, data.too_small)
            output = engine.run(
                data, spec, progress=progress, cancelled=lambda: _orphaned(parent)
            )
        if _orphaned(parent):
            raise engine.ComputeCancelled
        if not output.rows:
            # Nothing fits: no result is stored, and the skips say why.
            raise NoFit([*data.skipped, *output.skipped], data.too_small)
        progress("writing", 0, 1)
        store.write_result(
            job["projectRoot"],
            build_record_v2(job, spec, data, output)
            if isinstance(spec, GroupAnalysisSpecV2)
            else build_record(job, spec, context, data, output),
            prune_after=False,
        )
    except engine.ComputeCancelled:
        emit(out, {"event": "cancelled"})
        return 1
    except NoFit as exc:
        message = dataset.no_fit_message(exc.skipped, exc.too_small)
        emit(
            out,
            {
                "event": "failed",
                "message": message[:512],
                "skipped": exc.skipped[:MAX_SKIPPED],
            },
        )
        return 1
    except GroupAnalysisError as exc:
        emit(out, {"event": "failed", "message": str(exc)[:512]})
        return 1
    except Exception:  # One operator-safe sentence, never a trace.
        emit(out, {"event": "failed", "message": _INTERNAL_FAILURE})
        return 1
    # The result is committed: report it before pruning, which reads every
    # stored result and can take long enough for a cancel to land.
    emit(out, {"event": "done", "resultId": job["resultId"]})
    with contextlib.suppress(Exception):
        store.prune(job["projectRoot"])
    return 0


def main(argv: list[str] | None = None) -> int:
    """Run one job from stdin and report on stdout.

    Parameters
    ----------
    argv
        Unused; the job arrives on stdin.

    Returns
    -------
    int
        The exit status: 0 after a written result, 1 after a failure.
    """
    del argv
    for name in _THREAD_VARIABLES:
        os.environ[name] = "1"
    try:
        os.nice(10)
    except (AttributeError, OSError):
        pass
    try:
        job = _read_job(sys.stdin.buffer)
    except JobError as exc:
        emit(sys.stdout, {"event": "failed", "message": str(exc)})
        return 1
    return run_job(job, sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
