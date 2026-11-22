"""Tests for the JSON-RPC wiring of the project-scoped subject registry."""

from __future__ import annotations

import io
import json
import re
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.__main__ import build_dispatcher
from supraspina_sidecar.project import ProjectIdentityError
from supraspina_sidecar.rpc import Dispatcher, Emitter

_CSV_HEADER = "subjectId,age,sex,sourceCohortLabel,ais,tSinceSci"


@pytest.fixture
def dispatcher() -> Dispatcher:
    runtime = build_dispatcher(Emitter(io.StringIO()))
    try:
        yield runtime
    finally:
        runtime.managed_resource_manager.shutdown()
        runtime.provision_manager.shutdown()
        runtime.workflow_manager.shutdown()
        runtime.workflow_manager.project_epochs.detach_all()


def _project(root: Path) -> dict[str, Any]:
    return {
        "projectId": "rpc-registry",
        "root": str(root.resolve()),
        "configPath": str((root / "supraspina.project.json").resolve()),
        "epoch": 1,
    }


def _request(root: Path, **updates: Any) -> dict[str, Any]:
    request: dict[str, Any] = {"project": _project(root), "configRevision": 4}
    request.update(updates)
    return request


def _cfg(root: Path) -> dict[str, Any]:
    return {
        "paths": {
            "projectRoot": str(root.resolve()),
            "rawdataDir": str(root / "rawdata"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "subjects": {"include": [], "exclude": []},
    }


def _record(subject_id: str = "sub-001", **updates: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "subjectId": subject_id,
        "age": 42,
        "sex": "F",
        "sourceCohortLabel": "control",
        "ais": None,
        "tSinceSci": None,
    }
    value.update(updates)
    return value


def _project_root(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    return root


def _call(
    dispatcher: Dispatcher,
    method: str,
    request: dict[str, Any],
) -> dict[str, Any]:
    response = dispatcher.handle(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": [request]}
    )
    assert response is not None
    return response


def _result(
    dispatcher: Dispatcher,
    method: str,
    request: dict[str, Any],
) -> Any:
    response = _call(dispatcher, method, request)
    assert "error" not in response, response
    return response["result"]


def _stored(root: Path) -> dict[str, Any]:
    path = root / ".supraspina" / "registry.json"
    if not path.exists():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    assert value["schemaVersion"] == 1
    return dict(value["records"])


def test_registry_upsert_list_and_remove_persist_one_project_registry(
    dispatcher: Dispatcher,
    tmp_path: Path,
) -> None:
    root = _project_root(tmp_path)

    created = _result(dispatcher, "registry.upsert", _request(root, record=_record()))

    assert created["subjectId"] == "sub-001"
    assert created["cohortRole"] == "healthy"
    assert created["revision"] == 1
    assert set(_stored(root)) == {"sub-001"}

    revised = _result(
        dispatcher,
        "registry.upsert",
        _request(
            root,
            record=_record(sourceCohortLabel="sci_p", ais="C", tSinceSci=3),
            expectedRevision=1,
        ),
    )

    assert revised["cohortRole"] == "sci-neuropathic-pain"
    assert revised["ais"] == "C"
    assert revised["tSinceSci"] == 3.0
    assert revised["revision"] == 2

    listed = _result(dispatcher, "registry.list", _request(root))

    assert [item["subjectId"] for item in listed] == ["sub-001"]
    assert listed[0]["revision"] == 2

    removed = _result(
        dispatcher, "registry.remove", _request(root, subjectId="sub-001")
    )

    assert removed is None
    assert _result(dispatcher, "registry.list", _request(root)) == []
    assert _stored(root) == {}


def test_registry_list_enriches_records_with_the_requested_configuration(
    dispatcher: Dispatcher,
    tmp_path: Path,
) -> None:
    """Resolve T1 availability from the cfg the caller sent with the request."""
    root = _project_root(tmp_path)
    cfg = _cfg(root)
    _result(dispatcher, "registry.upsert", _request(root, cfg=cfg, record=_record()))

    missing = _result(dispatcher, "registry.list", _request(root, cfg=cfg))

    assert missing[0]["t1Availability"] == "missing"
    assert missing[0]["runnable"] is False

    t1 = root / "rawdata" / "sub-001" / "anat" / "sub-001_T1w.nii.gz"
    t1.parent.mkdir(parents=True)
    t1.write_bytes(b"t1")

    available = _result(dispatcher, "registry.list", _request(root, cfg=cfg))

    assert available[0]["t1Availability"] == "available"
    assert available[0]["runnable"] is True
    assert available[0]["unavailableReason"] is None


def test_registry_upsert_refuses_a_superseded_expected_revision(
    dispatcher: Dispatcher,
    tmp_path: Path,
) -> None:
    """Name the recovery when another writer already revised the record."""
    root = _project_root(tmp_path)
    _result(dispatcher, "registry.upsert", _request(root, record=_record()))

    refused = _call(
        dispatcher,
        "registry.upsert",
        _request(root, record=_record(age=50), expectedRevision=0),
    )

    assert refused["error"]["message"] == (
        "Load saved values because another writer changed this record."
    )
    assert _stored(root)["sub-001"]["age"] == 42


def test_registry_import_csv_keeps_or_replaces_already_registered_subjects(
    dispatcher: Dispatcher,
    tmp_path: Path,
) -> None:
    root = _project_root(tmp_path)
    _result(dispatcher, "registry.upsert", _request(root, record=_record()))
    csv_text = f"{_CSV_HEADER}\nsub-001,60,M,sci_p,B,4\nsub-002,33,F,control,,\n"

    skipped = _result(
        dispatcher,
        "registry.importCsv",
        _request(root, csvText=csv_text, onExisting="skip"),
    )

    assert skipped["applied"] is True
    assert (skipped["imported"], skipped["updated"], skipped["skipped"]) == (1, 0, 1)
    assert skipped["errors"] == []
    assert _stored(root)["sub-001"]["age"] == 42

    updated = _result(
        dispatcher,
        "registry.importCsv",
        _request(root, csvText=csv_text, onExisting="update"),
    )

    assert (updated["imported"], updated["updated"], updated["skipped"]) == (0, 2, 0)
    records = _stored(root)
    assert records["sub-001"]["age"] == 60
    assert records["sub-001"]["cohortRole"] == "sci-neuropathic-pain"
    assert records["sub-001"]["revision"] == 2
    assert records["sub-002"]["age"] == 33


def test_registry_import_csv_requires_text_and_a_stated_existing_policy(
    dispatcher: Dispatcher,
    tmp_path: Path,
) -> None:
    """Refuse an import before touching the store when the request is partial."""
    root = _project_root(tmp_path)
    handler = dispatcher._handlers["registry.importCsv"]

    with pytest.raises(ValueError, match=re.escape("Provide the CSV text to import.")):
        handler([_request(root, onExisting="skip")], dispatcher.emitter)
    with pytest.raises(
        ValueError,
        match=re.escape("Choose skip or update for already-registered subjects."),
    ):
        handler(
            [_request(root, csvText=f"{_CSV_HEADER}\nsub-001,42,F,control,,\n")],
            dispatcher.emitter,
        )
    assert _stored(root) == {}


@pytest.mark.parametrize(
    "method",
    ["registry.list", "registry.upsert", "registry.importCsv", "registry.remove"],
)
def test_registry_methods_refuse_an_unusable_revision_or_project(
    dispatcher: Dispatcher,
    tmp_path: Path,
    method: str,
) -> None:
    root = _project_root(tmp_path)
    handler = dispatcher._handlers[method]
    request = _request(root, record=_record(), csvText="", onExisting="skip")

    with pytest.raises(
        ValueError,
        match=re.escape("Provide configRevision as a non-negative safe integer."),
    ):
        handler([{**request, "configRevision": "4"}], dispatcher.emitter)
    with pytest.raises(
        ProjectIdentityError, match=re.escape("Provide a project reference.")
    ):
        handler([{**request, "project": None}], dispatcher.emitter)
    assert dispatcher.workflow_manager.project_epochs.attached() == []


def test_registry_remove_refuses_a_superseded_expected_revision(
    dispatcher: Dispatcher,
    tmp_path: Path,
) -> None:
    """Publish the delete conflict as an operator refusal, not a crash."""
    root = _project_root(tmp_path)
    _result(dispatcher, "registry.upsert", _request(root, record=_record()))

    refused = _call(
        dispatcher,
        "registry.remove",
        _request(root, subjectId="sub-001", expectedRevision=0),
    )

    assert refused["error"]["message"] == (
        "Resolve the registry revision conflict by refreshing the record."
    )
    assert refused["error"]["data"] == {"code": "OPERATOR"}
    assert list(_stored(root)) == ["sub-001"]
