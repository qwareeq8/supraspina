"""The labeling worker process of one atlas-labeling operation.

The manager starts ``worker_command()`` in its own session (OMP and ITK
threads 1, ``start_new_session``; the worker lowers its own priority by
nice 10), writes one job JSON document to its stdin, and reads JSON lines
from its stdout:

- ``{"event": "subject", "subjectId": ..., "state": "running"}`` when a
  subject starts, and ``"current"``, ``"provisional"``, ``"failed"``, or
  ``"skipped"`` (with ``message`` and ``seconds``) when it ends
- ``{"event": "template", "state": "current" | "failed", "message": ...}``
  after the fsaverage5 template labels, when the job asks for them
- ``{"event": "done"}`` after the last subject
- ``{"event": "failed", "message": ...}`` with one operator-safe sentence

The job is ``{"schema": "supraspina/atlas-labeling-job", "schemaVersion": 1,
"operationId", "projectRoot", "atlasId", "recipeId", "subjects", "jobs",
"freesurferHome", "subregionsPython", "atlasFiles", "reconStates",
"reconDirs", "environment", "tool", "hemisphereRules", "template"}``.
Each subject runs in a shadow ``SUBJECTS_DIR`` of file-level symlinks, and
a tripwire of the recon folder before and after stops the operation with
"The labeling tool changed files in the recon folder; labeling stopped."
if anything there changed. Finished subjects keep their labels when the
operation is cancelled or stopped.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import IO, Any

from . import atlas_cache, atlas_recipes
from .atlas_tools import freesurfer_facts, samseg_environment

#: The frozen-binary flag ``pyinstaller_entry.py`` routes to :func:`main`.
WORKER_FLAG = "--supraspina-atlas-labeling-worker"
JOB_SCHEMA = "supraspina/atlas-labeling-job"
#: The per-subject states a worker reports.
SUBJECT_STATES = frozenset({"running", "current", "provisional", "failed", "skipped"})
#: The message when a tool wrote into the recon folder.
TRIPWIRE_MESSAGE = (
    "The labeling tool changed files in the recon folder; labeling stopped."
)
_JOB_KEYS = frozenset(
    {
        "schema",
        "schemaVersion",
        "operationId",
        "projectRoot",
        "atlasId",
        "recipeId",
        "subjects",
        "jobs",
        "freesurferHome",
        "subregionsPython",
        "atlasFiles",
        "reconStates",
        "reconDirs",
        "environment",
        "tool",
        "hemisphereRules",
        "template",
    }
)
_THREAD_VARIABLES = (
    "OMP_NUM_THREADS",
    "ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "FS_OMP_NUM_THREADS",
)
_TEMPLATES = ("fsaverage", "fsaverage6", "fsaverage5")
_LOG_NAME = "tool.log"
_MAX_JOB_BYTES = 8 * 1024 * 1024


class JobError(ValueError):
    """Reject a malformed job document."""


class TripwireError(RuntimeError):
    """Stop the operation after a tool changed a recon folder."""


def worker_command() -> list[str]:
    """Return the exact argv that starts one labeling worker.

    Returns
    -------
    list of str
        The frozen binary with :data:`WORKER_FLAG`, or this module under the
        current interpreter in development.
    """
    if getattr(sys, "frozen", False):
        return [sys.executable, WORKER_FLAG]
    return [sys.executable, "-m", "supraspina_sidecar.group_analysis.atlas_worker"]


def emit(stream: IO[str], event: dict[str, Any]) -> None:
    """Write one JSON-line event and flush it."""
    stream.write(json.dumps(event, separators=(",", ":"), allow_nan=False) + "\n")
    stream.flush()


def validate_job(job: Any) -> dict[str, Any]:
    """Check a job document's shape.

    Raises
    ------
    JobError
        When a key is missing, unknown, or of the wrong type.
    """
    if not isinstance(job, dict) or set(job) != _JOB_KEYS:
        raise JobError("The labeling job is malformed.")
    if job["schema"] != JOB_SCHEMA or job["schemaVersion"] != 1:
        raise JobError("The labeling job is malformed.")
    subjects = job["subjects"]
    if (
        not isinstance(subjects, list)
        or not all(
            isinstance(item, str) and atlas_cache.SUBJECT_ID.fullmatch(item)
            for item in subjects
        )
        or not isinstance(job["reconDirs"], dict)
        or not all(isinstance(job["reconDirs"].get(item), str) for item in subjects)
        or not isinstance(job["reconStates"], dict)
        or job["recipeId"] not in atlas_recipes.RECIPES
        or not isinstance(job["jobs"], int)
        or not 1 <= job["jobs"] <= 8  # noqa: PLR2004 - MAX_LABEL_JOBS.
        or not isinstance(job["environment"], dict)
        or not isinstance(job["atlasFiles"], list)
        or not isinstance(job["hemisphereRules"], list)
        or not isinstance(job["template"], bool)
        or not isinstance(job["projectRoot"], str)
        or not isinstance(job["freesurferHome"], str)
    ):
        raise JobError("The labeling job is malformed.")
    return job


class _Run:
    """Hold one job's shared state across its subject threads."""

    def __init__(self, job: dict[str, Any], out: IO[str]) -> None:
        self.job = job
        self.out = out
        self.root = job["projectRoot"]
        self.atlas_id = str(job["atlasId"])
        self.recipe_id = str(job["recipeId"])
        self.recipe = atlas_recipes.RECIPES[self.recipe_id]
        self.home = str(job["freesurferHome"])
        self.rules = tuple(str(rule) for rule in job["hemisphereRules"]) or ("none",)
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.processes: set[subprocess.Popen[bytes]] = set()
        self.work = os.path.join(
            atlas_cache.work_root(self.root), str(job["operationId"])
        )
        self.tripped = False

    def emit(self, event: dict[str, Any]) -> None:
        with self.lock:
            emit(self.out, event)

    def environment(self, shadow: str) -> dict[str, str]:
        base = {
            **os.environ,
            **{str(k): str(v) for k, v in self.job["environment"].items()},
        }
        base.update(dict.fromkeys(_THREAD_VARIABLES, "1"))
        base["SUBJECTS_DIR"] = shadow
        base["FREESURFER_HOME"] = self.home
        if self.recipe_id in atlas_recipes.SUBREGION_STRUCTURES:
            link_dir = os.path.join(self.work, "pylink")
            with self.lock:
                os.makedirs(link_dir, exist_ok=True)
                return samseg_environment(base, freesurfer_facts(self.home), link_dir)
        return {
            key: value
            for key, value in base.items()
            if key not in {"PYTHONHOME", "PYTHONPATH"}
        }

    def run_steps(
        self, steps: list[list[str]], environment: dict[str, str], folder: str
    ) -> None:
        """Run each step; raise ValueError naming the first that failed."""
        with open(os.path.join(folder, _LOG_NAME), "ab") as log:
            for step in steps:
                if self.stop.is_set():
                    raise InterruptedError
                argv = list(step)
                if os.sep not in argv[0]:
                    argv[0] = os.path.join(self.home, "bin", argv[0])
                process = subprocess.Popen(  # noqa: S603 - a recipe argv.
                    argv,
                    cwd=folder,
                    env=environment,
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
                with self.lock:
                    self.processes.add(process)
                try:
                    status = process.wait()
                finally:
                    with self.lock:
                        self.processes.discard(process)
                if self.stop.is_set():
                    raise InterruptedError
                if status != 0:
                    name = os.path.basename(step[0])
                    if name.startswith("python") or step[1:3] == ["-s", "-m"]:
                        name = "segment_subregions"
                    raise ValueError(f"{name} stopped with exit status {status}.")

    def halt(self) -> None:
        """Stop every running tool of this job."""
        self.stop.set()
        with self.lock:
            processes = list(self.processes)
        for process in processes:
            with contextlib.suppress(OSError):
                process.kill()


def _link(target: str, link: str) -> None:
    os.makedirs(os.path.dirname(link), exist_ok=True)
    os.symlink(target, link)


def _shadow(
    run: _Run, subject_id: str, recon: str, folder: str
) -> tuple[str, list[str]]:
    """Build a subject's shadow ``SUBJECTS_DIR``; return it and its inputs."""
    shadow = os.path.join(folder, "sd")
    relpaths = atlas_recipes.recipe_inputs(run.recipe_id, run.atlas_id)
    for relpath in relpaths:
        _link(
            atlas_cache.confined_input(recon, relpath),
            os.path.join(shadow, subject_id, relpath),
        )
    if run.recipe.kind == "surface":
        for template in _TEMPLATES:
            source = os.path.join(run.home, "subjects", template)
            if os.path.isdir(source):
                _link(source, os.path.join(shadow, template))
    return shadow, relpaths


def _atlas_files(run: _Run, subject_id: str, out_dir: str) -> tuple[str, ...]:
    files = tuple(str(path) for path in run.job["atlasFiles"])
    if run.recipe_id != "user-volume":
        return files
    name = f"{run.atlas_id}.mgz"
    source = os.path.join(
        atlas_cache.subject_dir(run.root, run.atlas_id, subject_id), name
    )
    if not os.path.isfile(source) or os.path.islink(source):
        raise ValueError("No label map was imported for this subject.")
    copy = os.path.join(out_dir, name)
    shutil.copyfile(source, copy, follow_symlinks=False)
    ctab = next((path for path in files if not path.endswith(".mgz")), None)
    if ctab is None:
        raise ValueError("The atlas has no color table.")
    # The brain viewer names the map's labels from this copy: the atlas's
    # own table lives in the machine cache, which the viewer cannot read.
    table = os.path.join(out_dir, f"{run.atlas_id}.ctab")
    shutil.copyfile(ctab, table, follow_symlinks=False)
    return (table, copy)


def _kept(run: _Run) -> list[str]:
    names = atlas_recipes.recipe_outputs(run.recipe_id, run.atlas_id)
    if run.recipe_id == "user-volume":
        names += [f"{run.atlas_id}.mgz", f"{run.atlas_id}.ctab"]
    return names


def label_subject(run: _Run, subject_id: str) -> None:
    """Label one subject and report its end state."""
    if run.stop.is_set():
        return
    started = time.monotonic()
    started_at = _now()
    run.emit({"event": "subject", "subjectId": subject_id, "state": "running"})
    folder = os.path.join(run.work, subject_id)
    recon = str(run.job["reconDirs"][subject_id])
    state = atlas_cache.recon_state(run.job["reconStates"].get(subject_id))
    try:
        if atlas_cache.recon_running(recon):
            run.emit(
                _end(subject_id, "skipped", "The reconstruction is running.", started)
            )
            return
        os.makedirs(folder, exist_ok=False)
        out_dir = os.path.join(folder, "out")
        os.makedirs(out_dir)
        before = atlas_cache.tripwire(recon)
        try:
            shadow, relpaths = _shadow(run, subject_id, recon, folder)
            inputs = atlas_cache.input_facts(recon, relpaths)
            atlas_files = _atlas_files(run, subject_id, out_dir)
            steps = atlas_recipes.recipe_command(
                run.recipe_id,
                atlas_id=run.atlas_id,
                subject_id=subject_id,
                shadow_subjects_dir=shadow,
                out_dir=out_dir,
                freesurfer_home=run.home,
                subregions_python=run.job["subregionsPython"],
                atlas_files=atlas_files,
            )
            run.run_steps(steps, run.environment(shadow), folder)
        finally:
            after = atlas_cache.tripwire(recon)
            if before != after:
                run.tripped = True
                raise TripwireError
        kept = {}
        for name in _kept(run):
            path = os.path.join(out_dir, name)
            if not os.path.isfile(path) or os.path.islink(path):
                raise ValueError(f"The labeling tool did not write {name}.")
            kept[name] = path
        values = atlas_recipes.parse_outputs(
            run.recipe_id, run.atlas_id, out_dir, run.rules
        )
        seconds = round(time.monotonic() - started, 3)
        atlas_cache.store_subject(
            run.root,
            run.atlas_id,
            subject_id,
            files=kept,
            manifest={
                "schema": atlas_recipes.LABELS_SCHEMA,
                "schemaVersion": 1,
                "atlasId": run.atlas_id,
                "subjectId": subject_id,
                "recipeId": run.recipe_id,
                "recipeVersion": run.recipe.version,
                "provenance": "labeled",
                "tool": run.job["tool"],
                "argv": steps,
                "inputs": inputs,
                "atlasFiles": [
                    {"name": os.path.basename(path), **atlas_cache.hash_file(path)}
                    for path in atlas_files
                ],
                "reconState": state,
                "values": values,
                "startedAt": started_at,
                "finishedAt": _now(),
                "seconds": seconds,
                "source": None,
            },
        )
        final = "provisional" if state == "outdated" else "current"
        run.emit(_end(subject_id, final, None, started))
    except TripwireError:
        run.emit(_end(subject_id, "failed", TRIPWIRE_MESSAGE, started))
        run.halt()
    except InterruptedError:
        return
    except (ValueError, OSError) as exc:
        message = (
            str(exc)
            if isinstance(exc, ValueError)
            else "The labeling files could not be written."
        )
        run.emit(_end(subject_id, "failed", message[:512], started))
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def _now() -> str:
    from .store import timestamp  # noqa: PLC0415

    return timestamp()


def _end(
    subject_id: str, state: str, message: str | None, started: float
) -> dict[str, Any]:
    return {
        "event": "subject",
        "subjectId": subject_id,
        "state": state,
        "message": message,
        "seconds": round(time.monotonic() - started, 3),
    }


def label_template(run: _Run) -> None:
    """Label the fsaverage5 template for the viewer and report it."""
    folder = os.path.join(run.work, "_template")
    try:
        os.makedirs(os.path.join(folder, "out"))
        shadow = os.path.join(folder, "sd")
        for template in _TEMPLATES:
            source = os.path.join(run.home, "subjects", template)
            if os.path.isdir(source):
                _link(source, os.path.join(shadow, template))
        files = tuple(str(path) for path in run.job["atlasFiles"])
        steps = atlas_recipes.recipe_command(
            "template-fsaverage5",
            atlas_id=run.atlas_id,
            subject_id="fsaverage5",
            shadow_subjects_dir=shadow,
            out_dir=os.path.join(folder, "out"),
            freesurfer_home=run.home,
            subregions_python=None,
            atlas_files=files,
        )
        environment = {
            key: value
            for key, value in {
                **os.environ,
                **{str(k): str(v) for k, v in run.job["environment"].items()},
            }.items()
            if key not in {"PYTHONHOME", "PYTHONPATH"}
        }
        environment["SUBJECTS_DIR"] = shadow
        run.run_steps(steps, environment, folder)
        target = atlas_cache.template_dir(run.root)
        atlas_cache.ensure_dir(target, run.root)
        for name in atlas_recipes.expand("{hemi}.{atlas}.annot", run.atlas_id):
            source = os.path.join(folder, "out", name)
            if not os.path.isfile(source) or os.path.islink(source):
                raise ValueError(f"The labeling tool did not write {name}.")
            staged = os.path.join(target, f".{name}.tmp")
            shutil.copyfile(source, staged, follow_symlinks=False)
            os.replace(staged, os.path.join(target, name))
        run.emit({"event": "template", "state": "current", "message": None})
    except InterruptedError:
        return
    except (ValueError, OSError) as exc:
        message = (
            str(exc)
            if isinstance(exc, ValueError)
            else "The template labels could not be written."
        )
        run.emit({"event": "template", "state": "failed", "message": message[:512]})
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def run_job(job: dict[str, Any], out: IO[str]) -> int:
    """Label every subject of one job and report on ``out``.

    Returns
    -------
    int
        The exit status: 0 after the last subject, 1 after a failure.
    """
    try:
        validate_job(job)
    except JobError as exc:
        emit(out, {"event": "failed", "message": str(exc)})
        return 1
    run = _Run(job, out)
    try:
        atlas_cache.ensure_dir(run.work, run.root)
    except atlas_cache.CacheError as exc:
        emit(out, {"event": "failed", "message": str(exc)})
        return 1
    try:
        if job["template"]:
            label_template(run)
        with ThreadPoolExecutor(max_workers=int(job["jobs"])) as pool:
            for subject_id in job["subjects"]:
                pool.submit(label_subject, run, subject_id)
    finally:
        shutil.rmtree(run.work, ignore_errors=True)
    if run.tripped:
        run.emit({"event": "failed", "message": TRIPWIRE_MESSAGE})
        return 1
    run.emit({"event": "done"})
    return 0


def main(argv: list[str] | None = None) -> int:
    """Run one labeling job from stdin and report on stdout.

    Parameters
    ----------
    argv
        Unused; the job arrives on stdin.
    """
    del argv
    with contextlib.suppress(OSError, AttributeError):
        os.nice(10)
    try:
        job = json.loads(sys.stdin.buffer.read(_MAX_JOB_BYTES).decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        emit(
            sys.stdout, {"event": "failed", "message": "The labeling job is malformed."}
        )
        return 1
    if not isinstance(job, dict) or job.get("schema") != JOB_SCHEMA:
        emit(
            sys.stdout, {"event": "failed", "message": "The labeling job is malformed."}
        )
        return 1
    return run_job(job, sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
