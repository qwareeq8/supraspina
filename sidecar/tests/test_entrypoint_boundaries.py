"""Tests for entrypoint defaults, provisioning callbacks, and bounded shutdown."""

from __future__ import annotations

import io
import re
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from supraspina_sidecar import __main__ as entrypoint
from supraspina_sidecar.adapters import pybrainage
from supraspina_sidecar.adapters.base import UnresolvedTemplateError
from supraspina_sidecar.project import ProjectIdentityError
from supraspina_sidecar.rpc import Emitter
from tests.test_schema import default_config


class _Emitter:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def emit(self, method: str, params: dict[str, Any]) -> None:
        self.events.append((method, params))


class _Adapter:
    advances: tuple[str, ...] = ()

    def preview(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        return f"preview:{cfg.get('marker', '')}:{subject_id or 'cohort'}"


class _SubjectAdapter:
    advances = ("not-a-matrix-column",)

    def detect(self, _cfg: dict[str, Any], _subject_id: str | None) -> SimpleNamespace:
        return SimpleNamespace(state="done")


def _project(root: Path) -> dict[str, Any]:
    return {
        "projectId": "entrypoint-boundary",
        "root": str(root),
        "configPath": str(root / "supraspina.project.json"),
        "epoch": 1,
    }


def test_validator_reports_unavailable_schema_dependency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "supraspina_sidecar.schema", None)

    result = entrypoint._validate([{}], _Emitter())

    assert result["ok"] is False
    assert result["warnings"] == []
    assert result["errors"][0].startswith("validator unavailable:")


def test_argument_and_preview_defaults_are_explicit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = _Adapter()
    monkeypatch.setitem(entrypoint.ADAPTERS, "test-step", adapter)
    assert entrypoint._arg([], 2, "fallback") == "fallback"
    assert (
        entrypoint._preview_command(
            [{"marker": "cfg"}, "test-step", "sub-01"], _Emitter()
        )
        == "preview:cfg:sub-01"
    )
    assert (
        entrypoint._preview_command([{"marker": "cfg"}, "test-step"], _Emitter())
        == "preview:cfg:cohort"
    )


def test_subject_projection_skips_absent_adapters_and_unknown_matrix_columns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(entrypoint, "_ADAPTER_ORDER", ("absent", "synthetic"))
    monkeypatch.setitem(entrypoint.ADAPTERS, "synthetic", _SubjectAdapter())

    subject = entrypoint._subject_record({}, "sub-01")

    assert subject["stepStates"] == {"synthetic": "done"}
    assert all(
        cell["st"] == "pending" and cell["rc"] is None for cell in subject["cells"]
    )


def test_request_and_refresh_validate_malformed_inputs() -> None:
    with pytest.raises(ValueError, match="one request object"):
        entrypoint._request([])
    with pytest.raises(ValueError, match="one request object"):
        entrypoint._request([{}, {}])
    with pytest.raises(ValueError, match="Select a subject from the configured cohort"):
        entrypoint._refresh_one([{}, "sub-missing"], _Emitter())


def test_handshake_rejects_protocol_and_reports_attachment() -> None:
    workflow = SimpleNamespace(
        attach_supervisor_generation=lambda generation: setattr(
            workflow, "sidecar_generation", generation
        ),
        project_epochs=SimpleNamespace(
            attached=lambda: [{"projectId": "attached", "epoch": 1}]
        ),
        runtime_id="runtime-1",
        sidecar_generation=0,
    )
    with pytest.raises(ValueError, match="Use a supported protocol version"):
        entrypoint._handshake([{"protocolVersion": "2"}], workflow)
    with pytest.raises(ValueError, match="Use a supported product version"):
        entrypoint._handshake([{"protocolVersion": "1", "generation": 7}], workflow)
    with pytest.raises(ValueError, match="Use a supported product version"):
        entrypoint._handshake(
            [
                {
                    "productVersion": "999.0.0",
                    "protocolVersion": "1",
                    "generation": 7,
                }
            ],
            workflow,
        )

    result = entrypoint._handshake(
        [
            {
                "productVersion": entrypoint.__version__,
                "protocolVersion": "1",
                "generation": 7,
            }
        ],
        workflow,
    )

    assert result["productVersion"] == entrypoint.__version__
    assert result["sidecarGeneration"] == 7
    assert result["supervisorGeneration"] == 7
    assert result["projectAttached"] is True
    assert result["attachedProjects"] == [{"projectId": "attached", "epoch": 1}]


@pytest.mark.parametrize(
    ("fraction", "phase", "percent"),
    [(-1.0, "env", 0), (0.5, "download", 50), (2.0, "done", 100)],
)
def test_provision_progress_is_clamped_without_network(
    monkeypatch: pytest.MonkeyPatch,
    fraction: float,
    phase: str,
    percent: int,
) -> None:
    emitter = _Emitter()

    def execute(_cfg: dict[str, Any], progress: Any, **_kwargs: Any) -> dict[str, Any]:
        progress("phase", fraction)
        return {"ok": True, "message": "complete"}

    monkeypatch.setattr(pybrainage, "execute_provision", execute)

    result = entrypoint._provision_pybrainage([{"cfg": {}}], emitter)

    assert result["ok"] is True
    assert emitter.events == [
        (
            "provision.progress",
            {
                "jobId": result["jobId"],
                "phase": phase,
                "percent": percent,
                "message": "phase",
            },
        )
    ]


def test_provision_rejects_digest_and_reports_failure_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(
        ValueError, match="Keep the PyBrainAge archive SHA-256 unchanged"
    ):
        entrypoint._provision_pybrainage([{"sha256": "different"}], _Emitter())

    emitter = _Emitter()
    monkeypatch.setattr(
        pybrainage,
        "execute_provision",
        lambda *_args, **_kwargs: {
            "ok": False,
            "message": "Review the validation failure.",
        },
    )
    result = entrypoint._provision_pybrainage([{"cfg": {}}], emitter)
    assert result["ok"] is False
    assert emitter.events[-1][1]["phase"] == "error"
    assert emitter.events[-1][1]["message"] == "Review the validation failure."

    emitter = _Emitter()
    monkeypatch.setattr(
        pybrainage,
        "execute_provision",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("Raise the fixture failure.")
        ),
    )
    result = entrypoint._provision_pybrainage([{"cfg": {}}], emitter)
    assert result["ok"] is False
    assert emitter.events[-1][1]["phase"] == "error"
    assert emitter.events[-1][1]["message"] == "Raise the fixture failure."


def test_provision_status_reports_absent_and_partial_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert entrypoint._provision_status([], _Emitter()) == {
        "envReady": False,
        "modelReady": False,
        "pythonExecutable": None,
        "modelPath": None,
    }
    env = tmp_path / "env"
    model_root = tmp_path / "model"
    python = env / "bin" / "python"
    model = model_root / "software" / pybrainage.PYBRAINAGE_MODEL_FILE
    scaler = model_root / "software" / pybrainage.PYBRAINAGE_SCALER_FILE
    python.parent.mkdir(parents=True)
    python.write_text("python", encoding="utf-8")
    model.parent.mkdir(parents=True)
    model.write_text("model", encoding="utf-8")
    monkeypatch.setattr(pybrainage, "env_dir", lambda _cfg: str(env))
    monkeypatch.setattr(pybrainage, "model_root", lambda _cfg: str(model_root))

    partial = entrypoint._provision_status([{"cfg": {"configured": True}}], _Emitter())

    assert partial["envReady"] is True
    assert partial["modelReady"] is False
    assert partial["pythonExecutable"] == str(python)
    assert partial["modelPath"] is None
    scaler.write_text("scaler", encoding="utf-8")
    assert (
        entrypoint._provision_status([{"cfg": {"configured": True}}], _Emitter())[
            "modelReady"
        ]
        is True
    )


def test_dispatcher_shutdown_detach_guards_and_manifest_bounds(
    tmp_path: Path,
) -> None:
    dispatcher = entrypoint.build_dispatcher(Emitter(io.StringIO()))
    workflow = dispatcher.workflow_manager
    provision = dispatcher.provision_manager
    original_workflow_shutdown = workflow.shutdown
    original_provision_shutdown = provision.shutdown
    try:
        shutdown_calls: list[float] = []
        provision_calls: list[float] = []
        provision_state = {"active": 2}
        provision.active_count = lambda: provision_state["active"]

        def shutdown_provision(timeout: float = 5.0) -> None:
            provision_calls.append(timeout)
            provision_state["active"] = 0

        provision.shutdown = shutdown_provision
        workflow.shutdown = lambda timeout=5.0: (
            shutdown_calls.append(timeout) or {"terminal": True}
        )
        response = dispatcher._handlers["system.shutdown"](
            [{"timeoutMs": 100_000}], dispatcher.emitter
        )
        assert response == {
            "terminal": True,
            "activeProvisioning": 0,
            "activeManagedResources": 0,
        }
        assert provision_calls == [5.0]
        assert len(shutdown_calls) == 1
        assert 0 < shutdown_calls[0] <= 30.0

        with pytest.raises(ValueError, match="project reference"):
            dispatcher._handlers["system.detachProject"](
                [{"project": None}], dispatcher.emitter
            )
        workflow.project_active = lambda _project_id: True
        with pytest.raises(ValueError, match="Wait for active scientific work"):
            dispatcher._handlers["system.detachProject"](
                [{"project": _project(tmp_path)}], dispatcher.emitter
            )

        workflow.manifest_list = lambda project, cursor, limit: {
            "project": project,
            "cursor": cursor,
            "limit": limit,
        }
        listed = dispatcher._handlers["manifest.list"](
            [{"project": {}, "cursor": "2", "limit": "3"}], dispatcher.emitter
        )
        assert listed == {"project": {}, "cursor": "2", "limit": 3}
    finally:
        original_provision_shutdown()
        original_workflow_shutdown()


@pytest.mark.parametrize(
    ("method", "provision_request", "message"),
    [
        (
            "provision.synthstrip",
            {"resource": "fastsurfer", "variant": "cpu"},
            "Match the managed-resource provision method identity",
        ),
        (
            "provision.fastsurfer",
            {"resource": "fastsurfer", "variant": "unsupported"},
            "Select a valid FastSurfer provisioning variant",
        ),
    ],
)
def test_managed_resource_provision_rejects_invalid_method_or_variant(
    method: str,
    provision_request: dict[str, str],
    message: str,
) -> None:
    dispatcher = entrypoint.build_dispatcher(Emitter(io.StringIO()))
    try:
        with pytest.raises(ValueError, match=message):
            dispatcher._handlers[method]([provision_request], dispatcher.emitter)
    finally:
        dispatcher.managed_resource_manager.shutdown()
        dispatcher.provision_manager.shutdown()
        dispatcher.workflow_manager.shutdown()


@pytest.mark.parametrize("owner_kind", ["workflow", "provision"])
def test_detach_reconciles_unreadable_persisted_ownership_and_fails_closed(
    tmp_path: Path,
    owner_kind: str,
) -> None:
    root = tmp_path / owner_kind
    root.mkdir()
    project = _project(root)
    if owner_kind == "workflow":
        state_path = root / ".supraspina" / "runs" / "run-deadbeef" / "state.json"
    else:
        state_path = root / ".supraspina" / "provision.json"
    state_path.parent.mkdir(parents=True)
    original = b'{"schemaVersion":1,"status":"running"'
    state_path.write_bytes(original)
    dispatcher = entrypoint.build_dispatcher(Emitter(io.StringIO()))
    workflow = dispatcher.workflow_manager
    provision = dispatcher.provision_manager
    try:
        with pytest.raises(ValueError, match="Wait for active scientific work"):
            dispatcher._handlers["system.detachProject"](
                [{"project": project}], dispatcher.emitter
            )
        assert state_path.read_bytes() == original
        assert (
            workflow.project_active(project["projectId"])
            if owner_kind == "workflow"
            else provision.project_active(project["projectId"])
        )
        assert workflow.project_epochs.attached()
    finally:
        workflow._unresolved_processes.clear()
        provision._unresolved.clear()
        provision.shutdown()
        workflow.shutdown()
        workflow.project_epochs.detach_all()


def test_main_always_stops_managers_and_detaches_projects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    dispatcher = SimpleNamespace(
        managed_resource_manager=SimpleNamespace(
            shutdown=lambda: calls.append("managed-resources")
        ),
        provision_manager=SimpleNamespace(shutdown=lambda: calls.append("provision")),
        env_install_manager=SimpleNamespace(
            shutdown=lambda: calls.append("env-installs")
        ),
        workflow_manager=SimpleNamespace(
            shutdown=lambda: calls.append("workflow"),
            project_epochs=SimpleNamespace(detach_all=lambda: calls.append("detach")),
        ),
    )
    monkeypatch.setattr(entrypoint, "build_dispatcher", lambda _emitter: dispatcher)
    monkeypatch.setattr(
        entrypoint,
        "serve",
        lambda _dispatcher: (_ for _ in ()).throw(
            RuntimeError("Stop the fixture server.")
        ),
    )

    with pytest.raises(RuntimeError, match="Stop the fixture server"):
        entrypoint.main()
    assert calls == [
        "managed-resources",
        "provision",
        "env-installs",
        "workflow",
        "detach",
    ]


def test_detach_waits_for_managed_resource_work_then_releases_the_project(
    tmp_path: Path,
) -> None:
    dispatcher = entrypoint.build_dispatcher(Emitter(io.StringIO()))
    workflow = dispatcher.workflow_manager
    managed_resources = dispatcher.managed_resource_manager
    project = _project(tmp_path)
    try:
        workflow.project_epochs.validate(project)
        managed_resources.active_count = lambda: 1

        with pytest.raises(
            ValueError,
            match=re.escape(
                "Wait for active scientific work to finish before detaching "
                "the project."
            ),
        ):
            dispatcher._handlers["system.detachProject"](
                [{"project": project}], dispatcher.emitter
            )

        assert workflow.project_epochs.attached()

        managed_resources.active_count = lambda: 0
        released = dispatcher._handlers["system.detachProject"](
            [{"project": project}], dispatcher.emitter
        )

        assert released == {"detached": True, "projectAttached": False}
    finally:
        dispatcher.managed_resource_manager.shutdown()
        dispatcher.provision_manager.shutdown()
        workflow.shutdown()
        workflow.project_epochs.detach_all()


@pytest.mark.parametrize("variant", ["cpu", "cuda"])
def test_managed_resource_provision_forwards_a_supported_fastsurfer_variant(
    variant: str,
) -> None:
    dispatcher = entrypoint.build_dispatcher(Emitter(io.StringIO()))
    requests: list[dict[str, Any]] = []

    def provision(request: dict[str, Any]) -> dict[str, str]:
        requests.append(request)
        return {"jobId": "job-fastsurfer"}

    dispatcher.managed_resource_manager.provision = provision
    try:
        request = {"resource": "fastsurfer", "variant": variant}

        started = dispatcher._handlers["provision.fastsurfer"](
            [request], dispatcher.emitter
        )

        assert started == {"jobId": "job-fastsurfer"}
        assert requests == [request]
    finally:
        dispatcher.managed_resource_manager.shutdown()
        dispatcher.provision_manager.shutdown()
        dispatcher.workflow_manager.shutdown()


def test_main_discards_package_smoke_state_before_detaching_projects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    cleaned: list[Any] = []
    workflow = SimpleNamespace(
        shutdown=lambda: calls.append("workflow"),
        project_epochs=SimpleNamespace(detach_all=lambda: calls.append("detach")),
    )

    def cleanup_all(manager: Any) -> None:
        calls.append("smoke-cleanup")
        cleaned.append(manager)

    dispatcher = SimpleNamespace(
        managed_resource_manager=SimpleNamespace(
            shutdown=lambda: calls.append("managed-resources")
        ),
        provision_manager=SimpleNamespace(shutdown=lambda: calls.append("provision")),
        env_install_manager=SimpleNamespace(
            shutdown=lambda: calls.append("env-installs")
        ),
        workflow_manager=workflow,
        package_smoke_clinical=SimpleNamespace(cleanup_all=cleanup_all),
    )
    monkeypatch.setattr(entrypoint, "build_dispatcher", lambda _emitter: dispatcher)
    monkeypatch.setattr(entrypoint, "serve", lambda _dispatcher: calls.append("serve"))

    entrypoint.main()

    assert calls == [
        "serve",
        "managed-resources",
        "provision",
        "env-installs",
        "workflow",
        "smoke-cleanup",
        "detach",
    ]
    assert cleaned == [workflow]


def test_repeated_detach_answers_idempotently_and_keeps_epoch_validation(
    tmp_path: Path,
) -> None:
    dispatcher = entrypoint.build_dispatcher(Emitter(io.StringIO()))
    workflow = dispatcher.workflow_manager
    project = _project(tmp_path)
    try:
        workflow.project_epochs.validate(project)

        released = dispatcher._handlers["system.detachProject"](
            [{"project": project}], dispatcher.emitter
        )
        assert released == {"detached": True, "projectAttached": False}

        repeated = dispatcher._handlers["system.detachProject"](
            [{"project": project}], dispatcher.emitter
        )
        assert repeated == {"detached": False, "projectAttached": False}

        workflow.project_epochs.validate({**project, "epoch": 2})
        with pytest.raises(ProjectIdentityError, match="Refresh and match"):
            dispatcher._handlers["system.detachProject"](
                [{"project": project}], dispatcher.emitter
            )
        assert workflow.project_epochs.attached()
    finally:
        dispatcher.managed_resource_manager.shutdown()
        dispatcher.provision_manager.shutdown()
        workflow.shutdown()
        workflow.project_epochs.detach_all()


@pytest.mark.parametrize("step", ["enigma", "outliers"])
def test_preview_refuses_a_command_with_an_unresolved_placeholder(step: str) -> None:
    """Refuse a preview that plan building would block for the same reason."""
    cfg = default_config()
    assert "qcOutputDir" not in cfg["paths"]

    with pytest.raises(
        UnresolvedTemplateError, match=re.escape("${paths.qcOutputDir}")
    ):
        entrypoint._preview_command([cfg, step, None], _Emitter())

    cfg["paths"]["qcOutputDir"] = "${projectRoot}/outputs/qc"
    assert "${" not in entrypoint._preview_command([cfg, step, None], _Emitter())


@pytest.mark.parametrize("step", ["recon", "deface"])
def test_preview_keeps_the_subject_placeholder_without_a_subject(step: str) -> None:
    """Show a subject-scoped stage as a template when no subject is named."""
    cfg = default_config()
    cfg["paths"]["qcOutputDir"] = "${projectRoot}/outputs/qc"
    cfg["steps"]["deface"]["enabled"] = True

    generic = entrypoint._preview_command([cfg, step, None], _Emitter())
    assert "${subject}" in generic
    assert "${paths." not in generic
    assert "${tools." not in generic

    concrete = entrypoint._preview_command([cfg, step, "sub-01"], _Emitter())
    assert "${" not in concrete
    assert "sub-01" in concrete


def test_subject_free_recon_preview_names_the_input_by_role() -> None:
    """Never show a fixed BIDS T1 path that a real plan does not bind."""
    cfg = default_config()
    cfg["paths"]["qcOutputDir"] = "${projectRoot}/outputs/qc"
    cfg["patterns"]["t1Pattern"] = "*t1*.nii*"

    command = entrypoint._preview_command([cfg, "recon", None], _Emitter())

    assert f"-i '{entrypoint.PREVIEW_T1_INPUT}'" in command
    assert "_T1w.nii.gz" not in command
    assert "/anat/" not in command


@pytest.mark.parametrize("step", ["recon", "features"])
def test_preview_resolves_the_auto_backend_like_the_planner(step: str) -> None:
    """Preview an auto reconstruction backend as the FreeSurfer command it starts with."""
    cfg = default_config()
    cfg["paths"]["qcOutputDir"] = "${projectRoot}/outputs/qc"
    cfg["steps"]["recon"]["params"]["backend"] = "auto"

    command = entrypoint._preview_command([cfg, step, None], _Emitter())

    assert "${" not in command.replace("${subject}", "")
    assert (
        ("recon-all" in command) if step == "recon" else ("extract_features" in command)
    )
