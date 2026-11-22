"""Tests for fail-closed, atomic subject-registry persistence."""

from __future__ import annotations

import errno
import json
import re
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import registry_store as registry_store_module
from supraspina_sidecar.operator_errors import OperatorError
from supraspina_sidecar.qc_store import QcStoreError
from supraspina_sidecar.registry_store import RegistryStore


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


def _cfg(root: Path) -> dict[str, Any]:
    return {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(root / "rawdata"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "subjects": {
            "include": ["sub-001", "sub-002"],
            "exclude": ["sub-002"],
        },
    }


def _all_subjects_cfg(root: Path) -> dict[str, Any]:
    cfg = _cfg(root)
    cfg["subjects"] = {"include": [], "exclude": []}
    return cfg


def _write_t1(root: Path, subject_id: str) -> None:
    path = root / "rawdata" / subject_id / "anat" / f"{subject_id}_T1w.nii.gz"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"t1")


def _review_evidence() -> dict[str, Any]:
    return {
        "evidenceVersion": 1,
        "reviewer": "registry-test-reviewer",
        "reviewedAt": "2026-07-23T12:00:00.000Z",
        "galleries": [
            {
                "tab": tab,
                "label": label,
                "displayPath": f"outputs/qc/{tab}.html",
                "runId": "run-1234abcd",
                "receiptSha256": "a" * 64,
                "openedAt": "2026-07-23T11:59:00.000Z",
            }
            for tab, label in (
                ("subcortical", "Subcortical QC gallery"),
                ("internal", "Cortical-internal QC gallery"),
                ("external", "Cortical-external QC gallery"),
            )
        ],
    }


def _qc_document(verdicts: dict[str, str], *, reviewed: bool = True) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "verdicts": {
            subject_id: {
                "verdict": verdict,
                "note": "",
                "tags": [],
                "reviewEvidence": _review_evidence() if reviewed else None,
                "revision": 1,
                "updatedAt": "2026-07-23T12:00:00.000Z",
            }
            for subject_id, verdict in verdicts.items()
        },
    }


def test_upsert_persists_typed_record_and_optimistic_revision(tmp_path: Path) -> None:
    store = RegistryStore(str(tmp_path))
    created = store.upsert(_record())
    assert created["revision"] == 1
    assert created["cohortRole"] == "healthy"
    assert created["runnable"] is False

    updated = store.upsert(_record(age=43), expected_revision=1)
    assert updated["revision"] == 2
    assert updated["age"] == 43
    # A stale save is a refusal written for the operator, so its recovery
    # sentence reaches the window instead of the generic retry sentence.
    with pytest.raises(
        OperatorError,
        match=re.escape(
            "Load saved values because another writer changed this record."
        ),
    ):
        store.upsert(_record(age=44), expected_revision=1)


def test_upsert_with_expected_revision_preserves_qc_annotations(
    tmp_path: Path,
) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record())
    path = Path(store.path)
    value = json.loads(path.read_text(encoding="utf-8"))
    value["records"]["sub-001"]["qc"] = "pass"
    value["records"]["sub-001"]["qcNote"] = "reviewed"
    value["records"]["sub-001"]["qcTags"] = ["motion"]
    path.write_text(json.dumps(value) + "\n", encoding="utf-8")

    updated = store.upsert(_record(age=43), expected_revision=1)

    assert updated["qc"] == "pass"
    assert updated["qcNote"] == "reviewed"
    assert updated["qcTags"] == ["motion"]
    assert updated["revision"] == 2


@pytest.mark.parametrize("verdict", ["unknown", "PASS", "unreviewed", "Unreviewed", ""])
def test_stored_registry_rejects_unknown_qc_verdicts(
    tmp_path: Path, verdict: str
) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record())
    path = Path(store.path)
    value = json.loads(path.read_text(encoding="utf-8"))
    value["records"]["sub-001"]["qc"] = verdict
    original = (json.dumps(value) + "\n").encode()
    path.write_bytes(original)

    with pytest.raises(ValueError, match="invalid QC verdict"):
        store.list()
    with pytest.raises(ValueError, match="invalid QC verdict"):
        store.upsert(_record(age=50))
    assert path.read_bytes() == original


@pytest.mark.parametrize(
    "updates",
    [
        {"age": True},
        {"age": float("nan")},
        {"sex": "X"},
        {"sourceCohortLabel": "control\nforged"},
        {"ais": "E"},
        {"tSinceSci": True},
        {"tSinceSci": 151},
    ],
)
def test_upsert_rejects_hostile_or_mistyped_fields(
    tmp_path: Path,
    updates: dict[str, Any],
) -> None:
    with pytest.raises(ValueError, match=r"Provide|Set"):
        RegistryStore(str(tmp_path)).upsert(_record(**updates))


def test_mutations_never_replace_malformed_registry_bytes(tmp_path: Path) -> None:
    path = tmp_path / ".supraspina" / "registry.json"
    path.parent.mkdir()
    original = b'{"schemaVersion":1,"records":'
    path.write_bytes(original)
    store = RegistryStore(str(tmp_path))

    with pytest.raises(ValueError, match="malformed"):
        store.upsert(_record())
    assert path.read_bytes() == original
    with pytest.raises(ValueError, match="malformed"):
        store.remove("sub-001")
    assert path.read_bytes() == original


def test_hostile_persisted_record_fails_closed_without_rewrite(tmp_path: Path) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record())
    path = Path(store.path)
    value = json.loads(path.read_text(encoding="utf-8"))
    value["records"]["sub-001"]["age"] = True
    original = (json.dumps(value) + "\n").encode()
    path.write_bytes(original)

    with pytest.raises(ValueError, match="invalid age"):
        store.list()
    with pytest.raises(ValueError, match="invalid age"):
        store.upsert(_record(age=50))
    assert path.read_bytes() == original


def test_oversized_registry_fails_closed_without_rewrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / ".supraspina" / "registry.json"
    path.parent.mkdir()
    original = b'{"schemaVersion":1,"records":{}}\n' + b" " * 32
    path.write_bytes(original)
    monkeypatch.setattr(registry_store_module, "_MAX_REGISTRY_BYTES", 32)
    store = RegistryStore(str(tmp_path))

    with pytest.raises(ValueError, match="bounded size limit"):
        store.list()
    with pytest.raises(ValueError, match="bounded size limit"):
        store.upsert(_record())
    assert path.read_bytes() == original


def test_registry_record_limit_fails_closed_without_rewrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record("sub-001"))
    store.upsert(_record("sub-002"))
    path = Path(store.path)
    original = path.read_bytes()
    monkeypatch.setattr(registry_store_module, "_MAX_REGISTRY_RECORDS", 1)

    with pytest.raises(ValueError, match="bounded record limit"):
        store.list()
    with pytest.raises(ValueError, match="bounded record limit"):
        store.remove("sub-001")
    assert path.read_bytes() == original


def test_registry_rejects_a_boolean_schema_version_without_rewrite(
    tmp_path: Path,
) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record())
    path = Path(store.path)
    value = json.loads(path.read_text(encoding="utf-8"))
    value["schemaVersion"] = True
    original = (json.dumps(value) + "\n").encode()
    path.write_bytes(original)

    with pytest.raises(ValueError, match="version is unsupported"):
        store.list()
    with pytest.raises(ValueError, match="version is unsupported"):
        store.remove("sub-001")
    assert path.read_bytes() == original


def test_include_exclude_and_qc_fail_all_block_runnable_state(tmp_path: Path) -> None:
    store = RegistryStore(str(tmp_path))
    for index, subject_id in enumerate(("sub-001", "sub-002", "sub-003")):
        _write_t1(tmp_path, subject_id)
        store.upsert(_record(subject_id, age=40 + index))
    qc = tmp_path / ".supraspina" / "qc_verdicts.json"
    qc.write_text(
        json.dumps(
            _qc_document(
                {
                    "sub-001": "fail",
                    "sub-002": "pass",
                    "sub-003": "pass",
                }
            )
        ),
        encoding="utf-8",
    )

    rows = {item["subjectId"]: item for item in store.list(_cfg(tmp_path))}
    assert all(item["t1Availability"] == "available" for item in rows.values())
    assert all(item["runnable"] is False for item in rows.values())
    assert "QC Fail" in rows["sub-001"]["unavailableReason"]
    assert "excluded by project" in rows["sub-002"]["unavailableReason"]
    assert "not in the configured include set" in rows["sub-003"]["unavailableReason"]


def test_basic_runnable_excludes_fail_but_keeps_ambiguous_role_visible(
    tmp_path: Path,
) -> None:
    store = RegistryStore(str(tmp_path))
    for subject_id, label in (
        ("sub-pass", "unmapped-source-label"),
        ("sub-fail", "control"),
    ):
        _write_t1(tmp_path, subject_id)
        store.upsert(_record(subject_id, sourceCohortLabel=label))
    qc = tmp_path / ".supraspina" / "qc_verdicts.json"
    qc.write_text(
        json.dumps(
            _qc_document(
                {
                    "sub-pass": "pass",
                    "sub-fail": "fail",
                }
            )
        ),
        encoding="utf-8",
    )

    rows = {item["subjectId"]: item for item in store.list(_all_subjects_cfg(tmp_path))}

    assert rows["sub-pass"]["cohortRole"] == "ambiguous"
    assert rows["sub-pass"]["runnable"] is True
    assert rows["sub-pass"]["unavailableReason"] is None
    assert rows["sub-fail"]["runnable"] is False
    assert "QC Fail" in rows["sub-fail"]["unavailableReason"]


def test_registry_rejects_verdicts_without_review_evidence(
    tmp_path: Path,
) -> None:
    store = RegistryStore(str(tmp_path))
    for subject_id in ("sub-pass", "sub-fail"):
        _write_t1(tmp_path, subject_id)
        store.upsert(_record(subject_id))
    qc_path = tmp_path / ".supraspina" / "qc_verdicts.json"
    qc_path.write_text(
        json.dumps(
            _qc_document({"sub-pass": "pass", "sub-fail": "fail"}, reviewed=False)
        ),
        encoding="utf-8",
    )

    with pytest.raises(
        QcStoreError,
        match="Include review evidence with each QC verdict-store verdict",
    ):
        store.list(_all_subjects_cfg(tmp_path))

    qc_path.write_text(
        json.dumps(_qc_document({"sub-pass": "pass", "sub-fail": "fail"})),
        encoding="utf-8",
    )
    reviewed = {
        item["subjectId"]: item for item in store.list(_all_subjects_cfg(tmp_path))
    }

    assert reviewed["sub-pass"]["qc"] == "pass"
    assert reviewed["sub-pass"]["runnable"] is True
    assert reviewed["sub-fail"]["qc"] == "fail"
    assert reviewed["sub-fail"]["runnable"] is False
    assert "QC Fail" in reviewed["sub-fail"]["unavailableReason"]
    assert all(item["qcReviewEvidencePresent"] for item in reviewed.values())


# -- Atomic CSV import -----------------------------------------------------------


_SHARED_IMPORT_CONSTANTS = (
    Path(__file__).resolve().parents[2] / "src" / "shared" / "registry-import.ts"
)

_IMPORT_HEADER = "subjectId,age,sex,sourceCohortLabel,ais,tSinceSci"
_AGE_RANGE_ERROR = "Enter an age from 0 to 130 years, or leave the value empty."


def _example_csv() -> str:
    """Extract the exact example CSV that the import UI shows and saves."""
    source = _SHARED_IMPORT_CONSTANTS.read_text(encoding="utf-8")
    match = re.search(r"REGISTRY_IMPORT_EXAMPLE_CSV = `([^`]*)`", source)
    assert match, (
        "Provide REGISTRY_IMPORT_EXAMPLE_CSV in src/shared/registry-import.ts."
    )
    return match.group(1)


def _registry_bytes(store: RegistryStore) -> bytes:
    path = Path(store.path)
    return path.read_bytes() if path.exists() else b""


def test_import_csv_inserts_new_records_through_one_atomic_write(
    tmp_path: Path,
) -> None:
    store = RegistryStore(str(tmp_path))
    result = store.import_csv(
        f"{_IMPORT_HEADER}\nsub-0001,54.7,F,CTRL,,\nsub-0002,48,M,SCI_nNP,B,3.5\n"
    )

    assert result["applied"] is True
    assert (result["imported"], result["updated"], result["skipped"]) == (2, 0, 0)
    assert result["errors"] == []
    assert result["errorTotal"] == 0
    persisted = json.loads(Path(store.path).read_text(encoding="utf-8"))
    assert persisted["schemaVersion"] == 1
    rows = {item["subjectId"]: item for item in store.list()}
    assert rows["sub-0001"]["cohortRole"] == "healthy"
    assert rows["sub-0001"]["ais"] is None
    assert rows["sub-0001"]["tSinceSci"] is None
    assert rows["sub-0002"]["cohortRole"] == "sci-no-neuropathic-pain"
    assert rows["sub-0002"]["tSinceSci"] == 3.5
    assert all(item["revision"] == 1 for item in rows.values())


def test_import_csv_example_from_the_import_ui_imports_cleanly(
    tmp_path: Path,
) -> None:
    store = RegistryStore(str(tmp_path))
    result = store.import_csv(_example_csv())

    assert result["applied"] is True
    assert result["imported"] == 3
    assert result["errors"] == []
    assert result["warnings"] == []
    roles = {item["subjectId"]: item["cohortRole"] for item in store.list()}
    assert roles == {
        "sub-0001": "healthy",
        "sub-0002": "sci-no-neuropathic-pain",
        "sub-0003": "sci-neuropathic-pain",
    }


def test_import_csv_rejects_role_and_qc_columns_with_clear_messages(
    tmp_path: Path,
) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record())
    before = _registry_bytes(store)

    role = store.import_csv(
        f"{_IMPORT_HEADER},cohortRole\nsub-0002,40,M,CTRL,,,healthy\n"
    )
    assert role["applied"] is False
    assert (role["imported"], role["updated"], role["skipped"]) == (0, 0, 0)
    assert any(
        "cohort role" in issue["message"] and "sourceCohortLabel" in issue["message"]
        for issue in role["errors"]
    )

    qc = store.import_csv(f"{_IMPORT_HEADER},qc\nsub-0002,40,M,CTRL,,,pass\n")
    assert qc["applied"] is False
    assert any("QC" in issue["message"] for issue in qc["errors"])
    assert _registry_bytes(store) == before


def test_import_csv_reports_row_scoped_errors_and_applies_nothing(
    tmp_path: Path,
) -> None:
    store = RegistryStore(str(tmp_path))
    result = store.import_csv(
        f"{_IMPORT_HEADER}\n"
        "sub-0001,54.7,F,CTRL,,\n"
        "subject-2,40,M,CTRL,,\n"
        "sub-0003,131,M,CTRL,,\n"
        "sub-0004,40,X,CTRL,,\n"
        "sub-0005,40,F,CTRL,E,\n"
        "sub-0006,40,F,SCI_P,,151\n"
    )

    assert result["applied"] is False
    assert (result["imported"], result["updated"], result["skipped"]) == (0, 0, 0)
    messages = {(issue["row"], issue["message"]) for issue in result["errors"]}
    assert (3, "Use a BIDS subject label such as sub-001 or sub-0004.") in messages
    assert (4, _AGE_RANGE_ERROR) in messages
    assert (5, "Set sex to M, F, or O.") in messages
    assert (6, "Set ais to A, B, C, or D, or leave it empty.") in messages
    assert (
        7,
        "Enter years since SCI from 0 to 150, or leave the value empty.",
    ) in messages
    assert _registry_bytes(store) == b""


def test_import_csv_rejects_in_file_duplicates_on_every_occurrence(
    tmp_path: Path,
) -> None:
    result = RegistryStore(str(tmp_path)).import_csv(
        f"{_IMPORT_HEADER}\n"
        "sub-0001,40,F,CTRL,,\n"
        "sub-0002,41,M,CTRL,,\n"
        "sub-0001,42,F,CTRL,,\n"
    )

    assert result["applied"] is False
    assert [issue["row"] for issue in result["errors"]] == [2, 4]
    assert all("rows 2, 4" in issue["message"] for issue in result["errors"])


def test_import_csv_collision_policies_are_deterministic(tmp_path: Path) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record("sub-0001", age=30))
    csv_text = f"{_IMPORT_HEADER}\nsub-0001,44,F,SCI_P,B,2\nsub-0002,50,M,CTRL,,\n"

    skipped = store.import_csv(csv_text, "skip")
    assert skipped["applied"] is True
    assert (skipped["imported"], skipped["updated"], skipped["skipped"]) == (1, 0, 1)
    assert any(
        issue["row"] == 2 and "skipped" in issue["message"]
        for issue in skipped["warnings"]
    )
    rows = {item["subjectId"]: item for item in store.list()}
    assert rows["sub-0001"]["age"] == 30
    assert rows["sub-0001"]["revision"] == 1

    updated = store.import_csv(csv_text, "update")
    assert updated["applied"] is True
    assert (updated["imported"], updated["updated"], updated["skipped"]) == (0, 2, 0)
    assert any("Replaced" in issue["message"] for issue in updated["warnings"])
    rows = {item["subjectId"]: item for item in store.list()}
    assert rows["sub-0001"]["age"] == 44
    assert rows["sub-0001"]["revision"] == 2
    assert rows["sub-0002"]["revision"] == 2


def test_import_csv_all_skips_write_nothing(tmp_path: Path) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record("sub-0001"))
    before = _registry_bytes(store)

    result = store.import_csv(f"{_IMPORT_HEADER}\nsub-0001,44,F,CTRL,,\n", "skip")

    assert result["applied"] is True
    assert (result["imported"], result["updated"], result["skipped"]) == (0, 0, 1)
    assert _registry_bytes(store) == before


def test_import_csv_update_preserves_stored_qc_annotations(tmp_path: Path) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record("sub-0001"))
    path = Path(store.path)
    value = json.loads(path.read_text(encoding="utf-8"))
    value["records"]["sub-0001"]["qc"] = "pass"
    value["records"]["sub-0001"]["qcNote"] = "reviewed"
    path.write_text(json.dumps(value) + "\n", encoding="utf-8")

    result = store.import_csv(f"{_IMPORT_HEADER}\nsub-0001,41,F,CTRL,,\n", "update")

    assert result["applied"] is True
    stored = json.loads(path.read_text(encoding="utf-8"))["records"]["sub-0001"]
    assert stored["qc"] == "pass"
    assert stored["qcNote"] == "reviewed"
    assert stored["revision"] == 2
    assert stored["age"] == 41.0


def test_import_csv_write_failure_leaves_bytes_identical(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record("sub-0001"))
    before = _registry_bytes(store)

    def fail_replace(src: str, dst: str) -> None:
        raise OSError("simulated replace failure")

    monkeypatch.setattr(registry_store_module.os, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated replace failure"):
        store.import_csv(f"{_IMPORT_HEADER}\nsub-0002,40,M,CTRL,,\n")
    assert _registry_bytes(store) == before


def test_import_csv_bounds_fail_closed_without_rewrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record("sub-0001"))
    before = _registry_bytes(store)

    monkeypatch.setattr(registry_store_module, "_MAX_REGISTRY_RECORDS", 1)
    records = store.import_csv(f"{_IMPORT_HEADER}\nsub-0002,40,M,CTRL,,\n")
    assert records["applied"] is False
    assert any(
        issue["row"] is None and "bounded record limit" in issue["message"]
        for issue in records["errors"]
    )
    assert _registry_bytes(store) == before

    monkeypatch.setattr(registry_store_module, "_MAX_REGISTRY_RECORDS", 100_000)
    monkeypatch.setattr(registry_store_module, "_MAX_REGISTRY_BYTES", len(before) + 8)
    size = store.import_csv(f"{_IMPORT_HEADER}\nsub-0002,40,M,CTRL,,\n")
    assert size["applied"] is False
    assert any(
        issue["row"] is None and "bounded size limit" in issue["message"]
        for issue in size["errors"]
    )
    assert _registry_bytes(store) == before

    monkeypatch.setattr(registry_store_module, "_MAX_IMPORT_CSV_BYTES", 16)
    oversized = store.import_csv(f"{_IMPORT_HEADER}\nsub-0002,40,M,CTRL,,\n")
    assert oversized["applied"] is False
    assert any("Reduce the CSV" in issue["message"] for issue in oversized["errors"])
    assert _registry_bytes(store) == before


def test_import_csv_tolerates_bom_crlf_blank_lines_and_case(tmp_path: Path) -> None:
    store = RegistryStore(str(tmp_path))
    result = store.import_csv(
        "\ufeff subjectId,age,sex,sourceCohortLabel,ais,tSinceSci\r\n"
        "sub-0001,40,f,ctrl,,\r\n"
        "\r\n"
    )

    assert result["applied"] is True
    assert result["imported"] == 1
    rows = {item["subjectId"]: item for item in store.list()}
    assert rows["sub-0001"]["sex"] == "F"
    assert rows["sub-0001"]["cohortRole"] == "healthy"


def test_import_csv_warns_on_ambiguous_labels_only_for_written_rows(
    tmp_path: Path,
) -> None:
    store = RegistryStore(str(tmp_path))
    csv_text = f"{_IMPORT_HEADER}\nsub-0001,40,F,mystery-cohort,,\n"

    first = store.import_csv(csv_text)
    assert first["applied"] is True
    assert any(
        issue["row"] == 2 and "ambiguous" in issue["message"]
        for issue in first["warnings"]
    )

    again = store.import_csv(csv_text, "skip")
    assert again["applied"] is True
    assert not any("ambiguous" in issue["message"] for issue in again["warnings"])


@pytest.mark.parametrize(
    ("label", "role"),
    [
        ("SCI_no_pain", "sci-no-neuropathic-pain"),
        ("sci-pain", "sci-neuropathic-pain"),
        ("No pain", "ambiguous"),
        ("Pain", "ambiguous"),
        ("SCI, no pain", "ambiguous"),
        ("SCI, pain", "ambiguous"),
    ],
)
def test_cohort_role_accepts_pain_aliases_but_not_display_labels(
    label: str, role: str
) -> None:
    assert registry_store_module.cohort_role(label) == role


def test_import_csv_header_contract_is_strict(tmp_path: Path) -> None:
    store = RegistryStore(str(tmp_path))

    missing = store.import_csv("subjectId,age,sex\nsub-0001,40,F\n")
    assert any(
        issue["message"] == "Add the required sourceCohortLabel column."
        for issue in missing["errors"]
    )

    unknown = store.import_csv(
        f"{_IMPORT_HEADER},favoriteColor\nsub-0001,40,F,CTRL,,,blue\n"
    )
    assert any("unrecognized" in issue["message"] for issue in unknown["errors"])

    repeated = store.import_csv(f"{_IMPORT_HEADER},age\nsub-0001,40,F,CTRL,,,41\n")
    assert any("repeated" in issue["message"] for issue in repeated["errors"])

    empty = store.import_csv("")
    assert any("header row" in issue["message"] for issue in empty["errors"])

    header_only = store.import_csv(f"{_IMPORT_HEADER}\n")
    assert any(
        "at least one data row" in issue["message"] for issue in header_only["errors"]
    )


def test_import_csv_bounds_reported_issues(tmp_path: Path) -> None:
    bad_rows = "".join(f"subject-{index},40,F,CTRL,,\n" for index in range(250))
    result = RegistryStore(str(tmp_path)).import_csv(f"{_IMPORT_HEADER}\n{bad_rows}")

    assert result["applied"] is False
    assert len(result["errors"]) == 200
    assert result["errorTotal"] == 250


def test_import_gate_stays_stricter_than_the_unchanged_store_rule(
    tmp_path: Path,
) -> None:
    store = RegistryStore(str(tmp_path))
    created = store.upsert(_record("participant-X9"))
    assert created["revision"] == 1

    result = store.import_csv(f"{_IMPORT_HEADER}\nparticipant-X9,40,F,CTRL,,\n")
    assert result["applied"] is False
    assert any("BIDS subject label" in issue["message"] for issue in result["errors"])


def test_import_csv_rejects_invalid_policies_and_payloads(tmp_path: Path) -> None:
    store = RegistryStore(str(tmp_path))
    with pytest.raises(ValueError, match="skip or update"):
        store.import_csv(f"{_IMPORT_HEADER}\nsub-0001,40,F,CTRL,,\n", "merge")
    with pytest.raises(ValueError, match="CSV text"):
        store.import_csv(None)  # type: ignore[arg-type]


def test_import_csv_rejects_nonliteral_numeric_forms(tmp_path: Path) -> None:
    result = RegistryStore(str(tmp_path)).import_csv(
        f"{_IMPORT_HEADER}\n"
        "sub-0001,1_0,F,CTRL,,\n"
        "sub-0002,\uff14\uff10,F,CTRL,,\n"  # Fullwidth digits.
        "sub-0003,4e1,F,CTRL,,\n"
        "sub-0004,40,F,SCI_P,,1_0\n"
    )

    assert result["applied"] is False
    messages = {(issue["row"], issue["message"]) for issue in result["errors"]}
    assert (2, _AGE_RANGE_ERROR) in messages
    assert (3, _AGE_RANGE_ERROR) in messages
    assert (4, _AGE_RANGE_ERROR) in messages
    assert (
        5,
        "Enter years since SCI from 0 to 150, or leave the value empty.",
    ) in messages


def test_import_csv_persists_exactly_the_upsert_record_shape(
    tmp_path: Path,
) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record("sub-0001"))
    store.import_csv(f"{_IMPORT_HEADER}\nsub-0002,40,F,CTRL,,\n")

    persisted = json.loads(Path(store.path).read_text(encoding="utf-8"))["records"]
    assert set(persisted["sub-0002"]) == set(persisted["sub-0001"])


def test_symlinked_registry_is_refused_without_following_the_link(
    tmp_path: Path,
) -> None:
    """Refuse a linked store instead of reading another project's records."""
    other = tmp_path / "other"
    linked = RegistryStore(str(other))
    linked.upsert(_record("sub-999"))
    project = tmp_path / "project"
    (project / ".supraspina").mkdir(parents=True)
    path = project / ".supraspina" / "registry.json"
    path.symlink_to(linked.path)
    store = RegistryStore(str(project))

    with pytest.raises(ValueError, match="bounded regular file"):
        store.list()
    with pytest.raises(ValueError, match="bounded regular file"):
        store.upsert(_record("sub-001"))
    assert path.is_symlink()
    stored = json.loads(Path(linked.path).read_text(encoding="utf-8"))
    assert list(stored["records"]) == ["sub-999"]


def test_remove_refuses_a_stale_revision_as_an_operator_refusal(
    tmp_path: Path,
) -> None:
    """Name the recovery for a stale delete instead of reporting a crash."""
    store = RegistryStore(str(tmp_path))
    store.upsert(_record())

    with pytest.raises(
        OperatorError,
        match=re.escape(
            "Resolve the registry revision conflict by refreshing the record."
        ),
    ):
        store.remove("sub-001", expected_revision=0)
    assert [item["subjectId"] for item in store.list()] == ["sub-001"]


@pytest.mark.parametrize("age", ["43", "43.5", True])
def test_upsert_refuses_a_non_numeric_age(tmp_path: Path, age: Any) -> None:
    """Refuse a wrong-typed age instead of coercing it into the record."""
    store = RegistryStore(str(tmp_path))

    with pytest.raises(ValueError, match=re.escape("Provide a numeric age or null.")):
        store.upsert(_record(age=age))
    assert store.list() == []


def test_upsert_accepts_an_unknown_age_as_null(tmp_path: Path) -> None:
    """Register a subject whose age at scan was never recorded."""
    store = RegistryStore(str(tmp_path))

    assert store.upsert(_record(age=None))["age"] is None

    without_age = _record("sub-002")
    del without_age["age"]
    assert store.upsert(without_age)["age"] is None

    assert [item["age"] for item in store.list()] == [None, None]


def test_stored_null_age_loads_without_rewriting_the_registry(
    tmp_path: Path,
) -> None:
    """Read a persisted unknown age back instead of failing the whole store."""
    store = RegistryStore(str(tmp_path))
    store.upsert(_record(age=None))
    stored = Path(store.path).read_bytes()

    assert store.list()[0]["age"] is None
    assert Path(store.path).read_bytes() == stored


def test_import_csv_accepts_a_blank_age_cell(tmp_path: Path) -> None:
    """Import an unrecorded age as unknown and still reject an unusable one."""
    store = RegistryStore(str(tmp_path))

    imported = store.import_csv(f"{_IMPORT_HEADER}\nsub-0001,,F,CTRL,,\n")

    assert imported["applied"] is True
    assert imported["errors"] == []
    assert store.list()[0]["age"] is None

    rejected = store.import_csv(f"{_IMPORT_HEADER}\nsub-0002,unknown,F,CTRL,,\n")

    assert rejected["applied"] is False
    assert any(issue["message"] == _AGE_RANGE_ERROR for issue in rejected["errors"])


def _temp_files(store: RegistryStore) -> list[Path]:
    return sorted(Path(store.path).parent.glob(".registry.tmp-*"))


def test_denied_rename_removes_the_registry_temp_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record("sub-0001"))
    before = _registry_bytes(store)

    def denied_replace(src: str, dst: str) -> None:
        raise PermissionError(errno.EACCES, "simulated denied rename")

    monkeypatch.setattr(registry_store_module.os, "replace", denied_replace)
    with pytest.raises(PermissionError, match="simulated denied rename"):
        store.upsert(_record("sub-0002"))
    monkeypatch.undo()

    assert _registry_bytes(store) == before
    assert _temp_files(store) == []
    store.upsert(_record("sub-0002"))
    assert [item["subjectId"] for item in store.list()] == ["sub-0001", "sub-0002"]


def test_full_disk_write_removes_the_registry_temp_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RegistryStore(str(tmp_path))
    store.upsert(_record("sub-0001"))
    before = _registry_bytes(store)

    def full_disk_fsync(fileno: int) -> None:
        raise OSError(errno.ENOSPC, "simulated full disk")

    monkeypatch.setattr(registry_store_module.os, "fsync", full_disk_fsync)
    with pytest.raises(OSError, match="simulated full disk"):
        store.upsert(_record("sub-0002"))
    monkeypatch.undo()

    assert _registry_bytes(store) == before
    assert _temp_files(store) == []
    store.upsert(_record("sub-0002"))
    assert [item["subjectId"] for item in store.list()] == ["sub-0001", "sub-0002"]
