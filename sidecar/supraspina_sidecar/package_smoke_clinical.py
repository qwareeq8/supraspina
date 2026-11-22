"""The exact frozen-runtime Clinical packaged-smoke contract.

The module registers only when the packaged-smoke environment marker is
present. It creates no persistent user state: every synthetic project sits
behind a random token, is detached explicitly, and is removed before shutdown.
The final contract returned to the main process is boolean-only.
"""

from __future__ import annotations

import copy
import csv
import math
import os
import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import resources
from .adapters import pybrainage
from .adapters import tools as adapter_tools
from .adapters.base import ADAPTERS
from .adapters.clinical import TEMPLATE_COLUMNS, inspect_workbook
from .cohort import build_cohort_snapshot
from .operator_errors import OperatorError
from .provenance import BASELINE
from .registry_store import RegistryStore
from .run_store import RunStore
from .workflow import runtime_cfg
from .workflow_manager import WorkflowManager, _RunContext

_SUBJECT_ID = "smoke-001"
_REQUIRED_COLUMNS = ("Cohort", "AIS", "Time since SCI (years)")
_CASES = {"valid", "missing-columns", "empty-required", "malformed"}
_FEATURE_COLUMNS = 189


@dataclass(frozen=True)
class _Session:
    token: str
    root: str
    project: dict[str, Any]
    cfg: dict[str, Any]
    subject_id: str
    workbook: str
    template: str
    runner: str


@dataclass
class _Execution:
    complete: threading.Event = field(default_factory=threading.Event)
    result: dict[str, bool] | None = None


class ClinicalPackageSmoke:
    """Own temporary Clinical package-smoke projects for one sidecar process."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: dict[str, _Session] = {}
        self._executions: dict[str, _Execution] = {}

    def setup(self) -> dict[str, Any]:
        """Create one deterministic synthetic project and valid workbook."""
        root = tempfile.mkdtemp(prefix="supraspina-clinical-smoke-")
        try:
            token = uuid.uuid4().hex
            rawdata = os.path.join(root, "rawdata")
            subject_dir = os.path.join(rawdata, _SUBJECT_ID)
            output = os.path.join(root, "output")
            metadata = os.path.join(root, "metadata")
            os.makedirs(subject_dir)
            os.makedirs(os.path.join(output, "analysis"))
            os.makedirs(os.path.join(output, "features"))
            os.makedirs(os.path.join(output, "pybrainage"))
            os.makedirs(metadata)

            Path(os.path.join(subject_dir, f"{_SUBJECT_ID}_T1w.nii.gz")).write_bytes(
                b"Supraspina packaged smoke synthetic T1\n"
            )
            clinical_csv = os.path.join(metadata, "clinical.csv")
            with open(clinical_csv, "x", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(
                    handle,
                    fieldnames=[
                        "participant_id",
                        "Age",
                        "Sex",
                        "Cohort",
                        "AIS",
                        "Time since SCI (years)",
                    ],
                )
                writer.writeheader()
                writer.writerow(
                    {
                        "participant_id": _SUBJECT_ID,
                        "Age": "45",
                        "Sex": "Male",
                        "Cohort": "control",
                        "AIS": "A",
                        "Time since SCI (years)": "3.5",
                    }
                )
            Path(
                os.path.join(output, "pybrainage", "predicted_results.csv")
            ).write_text(
                f"ID,Age,BrainAge,BrainPAD\n{_SUBJECT_ID},45,47.2,2.2\n",
                encoding="utf-8",
            )
            feature_template = resources.features_dir() / "rois_input_template.txt"
            try:
                template_text = feature_template.read_text(encoding="utf-8")
            except FileNotFoundError as exc:
                raise OperatorError(
                    "Acquire the pinned scientific assets with the sidecar's "
                    "--acquire-scientific-assets flag before running the "
                    "packaged smoke."
                ) from exc
            template_header = template_text.splitlines()[0].split("\t")
            if len(template_header) != _FEATURE_COLUMNS or template_header[:2] != [
                "ID",
                "Age",
            ]:
                raise ValueError("Keep the packaged-smoke feature order exact.")
            feature_header = [
                "ID",
                "Age",
                *[
                    name.replace("&", "_and_")
                    .replace("Left-Thalamus-Proper", "Left-Thalamus")
                    .replace("Right-Thalamus-Proper", "Right-Thalamus")
                    for name in template_header[2:]
                ],
            ]
            with open(
                os.path.join(output, "features", "subject_features.csv"),
                "x",
                newline="",
                encoding="utf-8",
            ) as handle:
                writer = csv.DictWriter(handle, fieldnames=feature_header)
                writer.writeheader()
                writer.writerow(
                    {"ID": _SUBJECT_ID, "Age": 45}
                    | {name: 1.0 for name in feature_header[2:]}
                )

            workbook = os.path.join(output, "analysis", "predicted_results.xlsx")
            template = os.path.join(root, "valid-template.xlsx")
            runner = os.path.join(root, "clinical-zero-exit")
            cfg: dict[str, Any] = {
                "paths": {
                    "projectRoot": root,
                    "rawdataDir": rawdata,
                    "derivativesDir": os.path.join(root, "derivatives"),
                    "outputDir": output,
                    "metadataDir": metadata,
                    "clinicalMetadataFile": clinical_csv,
                },
                "patterns": {
                    "subjectGlob": "smoke-*",
                    "t1Pattern": "*_T1w.nii.gz",
                },
                "subjects": {"include": [], "exclude": []},
                "tools": {"pythonExecutable": runner},
                "steps": {
                    "clinical": {
                        "enabled": True,
                        "params": {
                            "joinKey": "participant_id",
                            "requiredColumns": ",".join(_REQUIRED_COLUMNS),
                            "cohortLabels": "control,SCI_nNP,SCI_P",
                        },
                    }
                },
                "runtime": {
                    "stopOnError": False,
                    "continueIndependentAfterError": True,
                },
            }
            project = {
                "projectId": f"package-smoke-{token}",
                "root": root,
                "configPath": os.path.join(root, "supraspina.project.json"),
                "epoch": 1,
            }
            session = _Session(
                token,
                root,
                project,
                cfg,
                _SUBJECT_ID,
                workbook,
                template,
                runner,
            )
            self._write_workbook(session, "valid")
            shutil.copyfile(workbook, template)
            self._write_runner(session)
            RegistryStore(root).upsert(
                {
                    "subjectId": _SUBJECT_ID,
                    "age": 45,
                    "sex": "M",
                    "sourceCohortLabel": "control",
                    "ais": "A",
                    "tSinceSci": 3.5,
                }
            )
            with self._lock:
                self._sessions[token] = session
            return {
                "token": token,
                "project": copy.deepcopy(project),
                "cfg": copy.deepcopy(cfg),
                "subjectId": _SUBJECT_ID,
                "openpyxlRuntime": self._is_valid(session),
            }
        except Exception:
            shutil.rmtree(root, ignore_errors=True)
            raise

    def apply_case(self, request: dict[str, Any]) -> dict[str, bool]:
        """Install one workbook case or simulate an unavailable dependency."""
        session = self._session(request)
        case = str(request.get("case", ""))
        if case == "missing-dependency":

            def unavailable() -> Any:
                raise ModuleNotFoundError(
                    "Treat openpyxl as intentionally unavailable."
                )

            status = inspect_workbook(
                session.workbook,
                list(_REQUIRED_COLUMNS),
                loader_factory=unavailable,
            )
            return {
                "caseApplied": True,
                "dependencyRejected": status.state == "failed",
            }
        if case not in _CASES:
            raise ValueError("Select a known Clinical package-smoke case.")
        self._write_workbook(session, case)
        return {"caseApplied": True, "dependencyRejected": False}

    def execute(
        self, request: dict[str, Any], workflow: WorkflowManager
    ) -> dict[str, bool]:
        """Start the live contract without blocking process-claim acceptance."""
        session = self._session(request)
        with self._lock:
            if session.token in self._executions:
                raise ValueError(
                    "Start each Clinical package-smoke execution only once."
                )
            execution = _Execution()
            self._executions[session.token] = execution

        def run() -> None:
            try:
                execution.result = self._execute_contract(session, workflow)
            except Exception:
                execution.result = {
                    "liveZeroExit": False,
                    "durableReceipt": False,
                    "dependentEligible": False,
                    "outputReopened": False,
                }
            finally:
                execution.complete.set()

        threading.Thread(
            target=run,
            daemon=True,
            name="supraspina-package-smoke-clinical",
        ).start()
        return {"started": True}

    def execution_status(self, request: dict[str, Any]) -> dict[str, bool]:
        """Return a path-free nonblocking projection of the live contract."""
        session = self._session(request)
        with self._lock:
            execution = self._executions.get(session.token)
        if execution is None:
            raise ValueError("Start the Clinical package-smoke execution.")
        if not execution.complete.is_set() or execution.result is None:
            return {
                "complete": False,
                "liveZeroExit": False,
                "durableReceipt": False,
                "dependentEligible": False,
                "outputReopened": False,
            }
        return {"complete": True, **execution.result}

    def _execute_contract(
        self, session: _Session, workflow: WorkflowManager
    ) -> dict[str, bool]:
        """Run one real zero-exit Clinical node through WorkflowManager."""
        project = workflow.project_epochs.validate(session.project, session.cfg)
        self._write_workbook(session, "valid")
        shutil.copyfile(session.workbook, session.template)
        os.unlink(session.workbook)

        cohort = build_cohort_snapshot(
            session.cfg,
            acknowledge_qc_pending=True,
        )
        run_id = f"run-{uuid.uuid4().hex[:12]}"
        effective = runtime_cfg(session.cfg, cohort, run_id, session.root)
        node = {
            "nodeId": "node-clinical-package-smoke",
            "stepKey": "clinical",
            "subjectId": None,
            "scope": "cohort",
            "dependencies": [],
            "status": "running",
        }
        now = int(time.time() * 1000)
        state: dict[str, Any] = {
            "schemaVersion": 1,
            "runId": run_id,
            "project": project.to_dict(),
            "configRevision": 0,
            "config": copy.deepcopy(session.cfg),
            "configSha256": "package-smoke",
            "intent": {"kind": "workflow", "target": {"mode": "all"}},
            "acknowledgements": {
                "includeDeferredAndUnreviewedQc": True,
                "acknowledgeMemoryAdvisory": True,
            },
            "scope": cohort.to_dict(),
            "nodes": [node],
            "jobs": [],
            "receipts": [],
            "warnings": [],
            "baseline": dict(BASELINE),
            "environmentEvidence": {
                "clinicalpython": {
                    "status": "ok",
                    "identitySha256": "package-smoke",
                }
            },
            "scientificEvidence": {},
            "status": "running",
            "terminalReason": None,
            "startedAtMs": now,
            "endedAtMs": None,
            "dryRun": False,
            "durable": False,
            "failurePolicy": {
                "stopOnError": False,
                "continueIndependentAfterError": True,
            },
            "sidecarGeneration": workflow.sidecar_generation,
        }
        ctx = _RunContext(
            state=state,
            cfg=copy.deepcopy(session.cfg),
            effective_cfg=effective,
            cohort=cohort,
            project=project,
            store=RunStore(session.root),
            queue_limit=1,
        )
        job = workflow._new_job(ctx, node)
        job["status"] = "running"
        job["startedAt"] = now
        state["jobs"].append(job)
        cancel_event = threading.Event()
        ctx.cancel_events[job["id"]] = cancel_event
        with workflow._wake:
            workflow._runs[run_id] = ctx
            workflow._active_jobs[job["id"]] = job
            workflow._commit(ctx)
            workflow._emit_job(ctx, job)
        try:
            workflow._execute(ctx, node["nodeId"], job["id"], cancel_event)
            loaded = ctx.store.load(run_id)
            receipt = next(
                (
                    value
                    for value in loaded.get("receipts", [])
                    if value.get("stepKey") == "clinical"
                ),
                None,
            )
            durable_receipt = False
            if isinstance(receipt, dict):
                durable_receipt = (
                    ctx.store.get_receipt(
                        "clinical", "cohort", str(receipt.get("signature", ""))
                    )
                    is not None
                )
            brainpad = {
                "nodeId": "node-brainpad-package-smoke",
                "stepKey": "brainpad",
                "subjectId": None,
                "scope": "cohort",
                "dependencies": [node["nodeId"]],
                "status": "waiting",
            }
            readiness, _reason = workflow._readiness(
                ctx,
                brainpad,
                {node["nodeId"]: node, brainpad["nodeId"]: brainpad},
            )
            reopened = inspect_workbook(
                session.workbook,
                list(_REQUIRED_COLUMNS),
            )
            return {
                "liveZeroExit": job.get("exitCode") == 0
                and job.get("status") == "done",
                "durableReceipt": durable_receipt,
                "dependentEligible": readiness == "ready",
                "outputReopened": reopened.state == "done",
            }
        finally:
            with workflow._wake:
                workflow._active_jobs.pop(job["id"], None)
                workflow._terminal_jobs.pop(job["id"], None)
                workflow._runs.pop(run_id, None)
                workflow._wake.notify_all()

    def execute_pybrainage(self, request: dict[str, Any]) -> dict[str, bool]:
        """Run and reopen one pinned-model prediction in the provisioned runtime."""
        session = self._session(request)
        output = Path(
            session.cfg["paths"]["outputDir"],
            "pybrainage",
            "predicted_results.csv",
        )
        output.unlink(missing_ok=True)
        adapter = ADAPTERS["pybrainage"]
        with adapter.execution_lease(session.cfg, None):
            action = adapter.execution_action(session.cfg, None)
            result = adapter_tools.run(
                list(action.argv),
                timeout=600,
                env=pybrainage.provision_environment(session.cfg),
            )
        reopened = False
        try:
            with output.open(newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            row = rows[0] if len(rows) == 1 else {}
            age = float(row.get("Age", "nan"))
            brain_age = float(row.get("BrainAge", "nan"))
            brain_pad = float(row.get("BrainPAD", "nan"))
            reopened = (
                list(row) == list(pybrainage.PREDICTED_COLUMNS)
                and row.get("ID") == _SUBJECT_ID
                and all(math.isfinite(value) for value in (age, brain_age, brain_pad))
                and math.isclose(brain_pad, brain_age - age, abs_tol=1e-9)
            )
        except (OSError, TypeError, ValueError):
            reopened = False
        return {
            "zeroExit": result.rc == 0,
            "outputReopened": reopened,
        }

    def cleanup(
        self, request: dict[str, Any], workflow: WorkflowManager
    ) -> dict[str, bool]:
        """Detach the exact project and remove every temporary byte."""
        token = str(request.get("token", ""))
        with self._lock:
            session = self._sessions.pop(token, None)
        if session is None:
            raise ValueError("Select a known Clinical package-smoke session.")
        with self._lock:
            execution = self._executions.get(token)
            if execution is not None and not execution.complete.is_set():
                self._sessions[token] = session
                return {
                    "projectDetached": False,
                    "temporaryDataRemoved": False,
                }
            self._executions.pop(token, None)
        detached = False
        try:
            attached = workflow.project_epochs.attached()
            if (
                attached
                and attached[0].get("projectId") == session.project["projectId"]
            ):
                detached = workflow.project_epochs.detach(session.project)
            else:
                detached = not attached
        finally:
            shutil.rmtree(session.root, ignore_errors=True)
        return {
            "projectDetached": detached and not workflow.project_epochs.attached(),
            "temporaryDataRemoved": not os.path.exists(session.root),
        }

    def cleanup_all(self, workflow: WorkflowManager) -> None:
        """Clean up interrupted smoke coordinators during shutdown."""
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
            executions = list(self._executions.values())
            self._executions.clear()
        for execution in executions:
            execution.complete.wait(timeout=1)
        for session in sessions:
            try:
                attached = workflow.project_epochs.attached()
                if (
                    attached
                    and attached[0].get("projectId") == session.project["projectId"]
                ):
                    workflow.project_epochs.detach(session.project)
            except Exception:
                shutil.rmtree(session.root, ignore_errors=True)
                continue
            shutil.rmtree(session.root, ignore_errors=True)

    def _session(self, request: dict[str, Any]) -> _Session:
        token = str(request.get("token", ""))
        with self._lock:
            session = self._sessions.get(token)
        if session is None:
            raise ValueError("Select a known Clinical package-smoke session.")
        return session

    @staticmethod
    def _write_runner(session: _Session) -> None:
        Path(session.runner).write_text(
            "#!/bin/sh\n"
            "set -eu\n"
            "runner_dir=${0%/*}\n"
            'cp "${runner_dir}/valid-template.xlsx" "$5"\n',
            encoding="utf-8",
        )
        os.chmod(session.runner, 0o700)

    @staticmethod
    def _write_workbook(session: _Session, case: str) -> None:
        path = Path(session.workbook)
        path.unlink(missing_ok=True)
        if case == "malformed":
            path.write_bytes(b"not an xlsx workbook\n")
            return

        from openpyxl import Workbook  # noqa: PLC0415

        book = Workbook()
        fixed = datetime(2000, 1, 1, tzinfo=timezone.utc)
        book.properties.created = fixed
        book.properties.modified = fixed
        if case == "missing-columns":
            book.active.append(["Subject_ID", "Age", "BrainAge"])
            book.active.append([_SUBJECT_ID, 45, 47.2])
        else:
            book.active.append(list(TEMPLATE_COLUMNS))
            if case == "empty-required":
                book.active.append(
                    [_SUBJECT_ID, 45, "Male", None, 47.2, 2.2, None, None]
                )
            else:
                book.active.append(
                    [
                        _SUBJECT_ID,
                        45,
                        "Male",
                        "control",
                        47.2,
                        2.2,
                        "A",
                        3.5,
                    ]
                )
        book.save(path)
        book.close()

    @staticmethod
    def _is_valid(session: _Session) -> bool:
        status = inspect_workbook(session.workbook, list(_REQUIRED_COLUMNS))
        return status.state == "done"
