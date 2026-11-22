"""Tests for the exact frozen-sidecar Clinical package-smoke contract."""

from __future__ import annotations

import csv
import os
import re
import time
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import tomllib

from supraspina_sidecar import package_smoke_clinical as package_smoke_module
from supraspina_sidecar.__main__ import build_dispatcher
from supraspina_sidecar.adapters import tools as adapter_tools
from supraspina_sidecar.adapters.base import ADAPTERS, ExecutionAction
from supraspina_sidecar.adapters.features import FeaturesAdapter
from supraspina_sidecar.operator_errors import OperatorError
from supraspina_sidecar.package_smoke_clinical import ClinicalPackageSmoke


class _Emitter:
    def __init__(self) -> None:
        self.events: list[tuple[str, Any]] = []

    def emit(self, method: str, params: Any) -> None:
        self.events.append((method, params))


def _call(dispatcher: Any, method: str, params: list[Any]) -> Any:
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    )
    assert response is not None
    assert "error" not in response, response
    return response["result"]


def _clinical_state(subject: dict[str, Any]) -> str:
    return str(subject["stepStates"]["clinical"])


def test_package_smoke_uses_discovery_refresh_execution_and_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SUPRASPINA_PACKAGE_SMOKE", "1")
    emitter = _Emitter()
    dispatcher = build_dispatcher(emitter)
    root = ""
    try:
        setup = _call(dispatcher, "system.packageSmokeClinicalSetup", [])
        assert setup["openpyxlRuntime"] is True
        root = setup["project"]["root"]
        request = {
            "project": setup["project"],
            "cfg": setup["cfg"],
            "configRevision": 0,
        }
        discovered = _call(dispatcher, "subjects.discover", [request])
        assert len(discovered) == 1
        assert discovered[0]["id"] == setup["subjectId"]
        assert _clinical_state(discovered[0]) == "done"

        refreshed = _call(
            dispatcher,
            "subjects.refreshOne",
            [{**request, "subjectId": setup["subjectId"]}],
        )
        assert _clinical_state(refreshed) == "done"

        expected_states = {
            "missing-columns": "pending",
            "empty-required": "pending",
            "malformed": "pending",
        }
        for case, expected in expected_states.items():
            applied = _call(
                dispatcher,
                "system.packageSmokeClinicalCase",
                [{"token": setup["token"], "case": case}],
            )
            assert applied["caseApplied"] is True
            refreshed = _call(
                dispatcher,
                "subjects.refreshOne",
                [{**request, "subjectId": setup["subjectId"]}],
            )
            assert _clinical_state(refreshed) == expected

        dependency = _call(
            dispatcher,
            "system.packageSmokeClinicalCase",
            [{"token": setup["token"], "case": "missing-dependency"}],
        )
        assert dependency == {
            "caseApplied": True,
            "dependencyRejected": True,
        }
        _call(
            dispatcher,
            "system.packageSmokeClinicalCase",
            [{"token": setup["token"], "case": "valid"}],
        )

        started = _call(
            dispatcher,
            "system.packageSmokeClinicalExecute",
            [{"token": setup["token"]}],
        )
        assert started == {"started": True}
        deadline = time.monotonic() + 10
        while True:
            execution = _call(
                dispatcher,
                "system.packageSmokeClinicalExecutionStatus",
                [{"token": setup["token"]}],
            )
            if execution["complete"]:
                break
            assert time.monotonic() < deadline
            time.sleep(0.01)
        assert execution == {
            "complete": True,
            "liveZeroExit": True,
            "durableReceipt": True,
            "dependentEligible": True,
            "outputReopened": True,
        }
        cleanup = _call(
            dispatcher,
            "system.packageSmokeClinicalCleanup",
            [{"token": setup["token"]}],
        )
        assert cleanup == {
            "projectDetached": True,
            "temporaryDataRemoved": True,
        }
        assert not os.path.exists(root)

        boolean_report = {
            "openpyxlRuntime": setup["openpyxlRuntime"],
            "discoveryDone": _clinical_state(discovered[0]) == "done",
            "refreshDone": True,
            **{key: value for key, value in execution.items() if key != "complete"},
            **cleanup,
        }
        assert all(isinstance(value, bool) for value in boolean_report.values())
        assert root not in repr(boolean_report)
        assert setup["subjectId"] not in repr(boolean_report)
    finally:
        dispatcher.package_smoke_clinical.cleanup_all(dispatcher.workflow_manager)
        dispatcher.provision_manager.shutdown()
        dispatcher.workflow_manager.shutdown()
        if root:
            assert not os.path.exists(root)


def test_package_smoke_handlers_are_inert_without_explicit_marker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SUPRASPINA_PACKAGE_SMOKE", raising=False)
    dispatcher = build_dispatcher(_Emitter())
    try:
        assert not any(
            method.startswith("system.packageSmokeClinical")
            for method in dispatcher.methods
        )
    finally:
        dispatcher.provision_manager.shutdown()
        dispatcher.workflow_manager.shutdown()


def test_shutdown_discards_an_interrupted_package_smoke_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SUPRASPINA_PACKAGE_SMOKE", "1")
    dispatcher = build_dispatcher(_Emitter())
    setup = _call(dispatcher, "system.packageSmokeClinicalSetup", [])
    root = setup["project"]["root"]
    try:
        _call(
            dispatcher,
            "subjects.discover",
            [
                {
                    "project": setup["project"],
                    "cfg": setup["cfg"],
                    "configRevision": 0,
                }
            ],
        )
        assert dispatcher.workflow_manager.project_epochs.attached()

        result = _call(dispatcher, "system.shutdown", [{"timeoutMs": 5_000}])

        assert result["activeProvisioning"] == 0
        assert result["activeManagedResources"] == 0
        assert dispatcher.workflow_manager.project_epochs.attached() == []
        assert not os.path.exists(root)
    finally:
        dispatcher.package_smoke_clinical.cleanup_all(dispatcher.workflow_manager)
        dispatcher.provision_manager.shutdown()
        dispatcher.workflow_manager.shutdown()
        assert not os.path.exists(root)


def test_setup_names_the_asset_acquisition_prerequisite(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Name the missing acquisition instead of raising an opaque IO error."""
    monkeypatch.setattr(
        package_smoke_module.resources, "features_dir", lambda: tmp_path
    )

    with pytest.raises(
        OperatorError,
        match=re.escape(
            "Acquire the pinned scientific assets with the sidecar's "
            "--acquire-scientific-assets flag before running the packaged smoke."
        ),
    ):
        ClinicalPackageSmoke().setup()


def test_package_smoke_features_match_the_extractor_header() -> None:
    smoke = ClinicalPackageSmoke()
    setup = smoke.setup()
    features = (
        Path(setup["cfg"]["paths"]["outputDir"]) / "features" / "subject_features.csv"
    )
    expected = [
        "ID",
        "Age",
        *FeaturesAdapter()._expected_default_header()[1:],
    ]

    try:
        with features.open(newline="", encoding="utf-8") as handle:
            assert next(csv.reader(handle)) == expected
    finally:
        smoke.cleanup_all(
            SimpleNamespace(project_epochs=SimpleNamespace(attached=list))
        )
        assert not Path(setup["project"]["root"]).exists()


def test_package_smoke_reopens_real_pybrainage_output_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    smoke = ClinicalPackageSmoke()
    setup = smoke.setup()
    output = (
        Path(setup["cfg"]["paths"]["outputDir"])
        / "pybrainage"
        / "predicted_results.csv"
    )
    adapter = SimpleNamespace(
        execution_lease=lambda _cfg, _subject: nullcontext(),
        execution_action=lambda _cfg, _subject: ExecutionAction(
            kind="process", argv=("pinned-python", "predict.py")
        ),
    )

    def run(_argv: list[str], **_options: Any) -> adapter_tools.RunResult:
        output.write_text(
            "ID,Age,BrainAge,BrainPAD\nsmoke-001,45,47.25,2.25\n",
            encoding="utf-8",
        )
        return adapter_tools.RunResult(rc=0, stdout="", stderr="")

    monkeypatch.setitem(ADAPTERS, "pybrainage", adapter)
    monkeypatch.setattr(adapter_tools, "run", run)
    monkeypatch.setattr(
        "supraspina_sidecar.package_smoke_clinical.pybrainage.provision_environment",
        lambda _cfg: {"SUPRASPINA_TEST": "1"},
    )
    try:
        assert smoke.execute_pybrainage({"token": setup["token"]}) == {
            "zeroExit": True,
            "outputReopened": True,
        }
    finally:
        smoke.cleanup_all(
            SimpleNamespace(project_epochs=SimpleNamespace(attached=list))
        )
        assert not Path(setup["project"]["root"]).exists()


def test_frozen_build_explicitly_collects_declared_openpyxl_runtime() -> None:
    project_root = Path(__file__).resolve().parents[2]
    pyproject = tomllib.loads(
        (project_root / "sidecar" / "pyproject.toml").read_text(encoding="utf-8")
    )
    spec = (project_root / "sidecar" / "supraspina-sidecar.spec").read_text(
        encoding="utf-8"
    )

    runtime_dependencies = pyproject["project"]["dependencies"]
    assert "openpyxl==3.1.5" in runtime_dependencies
    assert '("numpy", "openpyxl", "pydantic")' in spec
    assert "collect_all(package_name)" in spec
