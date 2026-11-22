"""Tests for the frozen site interfaces.

The label rule is shared with ``src/shared/sites.ts`` through one fixture. The
registry tests hold that a record without a site keeps the bytes the
build before sites wrote (goldens generated from that build's
``registry_store.py``), and a listed record reports its site as null.
"""

from __future__ import annotations

import inspect
import json
import typing
from pathlib import Path
from typing import Any

import pytest

import supraspina_sidecar.__main__ as main_module
from supraspina_sidecar import registry_store as registry_store_module
from supraspina_sidecar import sites
from supraspina_sidecar.registry_store import RegistryStore

_FIXTURES = Path(__file__).parent / "fixtures" / "sites"
_REPO = Path(__file__).resolve().parents[2]
_FIXED_TIME = "2026-09-30T00:00:00+00:00"
_IMPORT_WITHOUT_SITE = (
    "subjectId,age,sex,sourceCohortLabel,ais,tSinceSci\n"
    "sub-002,50,M,SCI_P,B,4\n"
    "sub-003,33,F,SCI_nNP,,\n"
)


def _label_cases() -> list[dict[str, Any]]:
    data = json.loads((_FIXTURES / "site-labels.json").read_text(encoding="utf-8"))
    return data["cases"]


@pytest.mark.parametrize("case", _label_cases(), ids=repr)
def test_label_rule_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    if case.get("refused"):
        with pytest.raises(ValueError, match=r"^Use a site label of 1 to 64"):
            sites.normalize_site_label(case["input"])
    else:
        assert sites.normalize_site_label(case["input"]) == case["label"]


def test_label_rule_mirrors_the_typescript_constants() -> None:
    source = (_REPO / "src" / "shared" / "sites.ts").read_text(encoding="utf-8")
    assert f"/{sites.SITE_LABEL_PATTERN.pattern}/" in source
    assert f"MAX_SITE_LABEL_LENGTH = {sites.MAX_SITE_LABEL_LENGTH}" in source
    assert "MAX_SET_SITE_SUBJECTS = 20_000" in source
    assert sites.MAX_SET_SITE_SUBJECTS == 20_000
    assert f"'{sites.SITE_LABEL_RULE}'" in source


def test_canonical_labels_and_case_conflicts() -> None:
    assert sites.is_site_label("Prisma 3T")
    assert not sites.is_site_label(" Prisma")
    assert not sites.is_site_label("x" * 65)
    assert not sites.is_site_label(None)
    assert sites.site_label_conflict("prisma", ["Prisma", "Ingenia"]) == "Prisma"
    assert sites.site_label_conflict("Prisma", ["Prisma"]) is None
    assert sites.site_label_conflict("Skyra", ["Prisma"]) is None


def test_site_state_signature_and_shape_are_frozen() -> None:
    parameters = inspect.signature(sites.site_state).parameters
    assert list(parameters) == ["records", "subject_ids"]
    assert parameters["subject_ids"].default is None
    assert set(typing.get_type_hints(sites.SiteState)) == {"mode", "unset", "sites"}
    assert set(typing.get_type_hints(sites.SiteSummary)) == {
        "site",
        "subjects",
        "roles",
    }
    assert typing.get_args(sites.SiteMode) == ("none", "complete", "mixed")


# -- Registry byte identity ----------------------------------------------------


@pytest.fixture
def fixed_time(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(registry_store_module, "_now_iso", lambda: _FIXED_TIME)


def _two_upserts(root: Path) -> RegistryStore:
    store = RegistryStore(str(root))
    store.upsert(
        {
            "subjectId": "sub-001",
            "age": 41.5,
            "sex": "F",
            "sourceCohortLabel": "CTRL",
            "ais": None,
            "tSinceSci": None,
        }
    )
    store.upsert(
        {
            "subjectId": "sub-002",
            "age": None,
            "sex": "M",
            "sourceCohortLabel": "SCI_P",
            "ais": "C",
            "tSinceSci": 3.5,
        }
    )
    return store


@pytest.mark.usefixtures("fixed_time")
def test_records_without_a_site_serialize_byte_identically(tmp_path: Path) -> None:
    store = _two_upserts(tmp_path)
    registry = Path(store.path)
    assert (
        registry.read_bytes()
        == (_FIXTURES / "registry-v1-two-upserts.json").read_bytes()
    )

    before = registry.stat()
    rows = store.list()
    assert [row["site"] for row in rows] == [None, None]
    after = registry.stat()
    assert (after.st_mtime_ns, after.st_size) == (before.st_mtime_ns, before.st_size)
    assert (
        "site"
        not in json.loads(registry.read_text(encoding="utf-8"))["records"]["sub-001"]
    )

    result = store.import_csv(_IMPORT_WITHOUT_SITE, "update")
    assert result["applied"] is True
    assert (
        registry.read_bytes()
        == (_FIXTURES / "registry-v1-after-import.json").read_bytes()
    )


@pytest.mark.usefixtures("fixed_time")
def test_stored_site_values_are_validated_on_read(tmp_path: Path) -> None:
    store = _two_upserts(tmp_path)
    registry = Path(store.path)
    data = json.loads(registry.read_text(encoding="utf-8"))

    data["records"]["sub-001"]["site"] = "Prisma"
    data["records"]["sub-002"]["site"] = None
    registry.write_text(json.dumps(data), encoding="utf-8")
    assert [row["site"] for row in store.list()] == ["Prisma", None]

    for invalid in (" Prisma", "Prisma!", 7, "x" * 65):
        data["records"]["sub-001"]["site"] = invalid
        registry.write_text(json.dumps(data), encoding="utf-8")
        with pytest.raises(ValueError, match="invalid site"):
            store.list()


def test_set_site_signature_is_frozen() -> None:
    parameters = inspect.signature(RegistryStore.set_site).parameters
    assert list(parameters) == ["self", "subject_ids", "site", "expected_revisions"]


def test_subject_rows_carry_the_registry_site(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main_module, "ADAPTERS", {})
    monkeypatch.setattr(main_module, "_ADAPTER_ORDER", ())
    record = {
        "age": 50,
        "sex": "F",
        "cohortRole": "healthy",
        "sourceCohortLabel": "CTRL",
    }
    assert main_module._subject_record({}, "sub-001", record)["site"] is None
    assert main_module._subject_record({}, "sub-002")["site"] is None
    placed = main_module._subject_record({}, "sub-003", {**record, "site": "Ingenia"})
    assert placed["site"] == "Ingenia"
    # An unregistered row shows the site held for its registration, and
    # a record's own site, even unset, wins over a held one.
    held = main_module._subject_record({}, "sub-004", held_site="Ingenia")
    assert held["site"] == "Ingenia"
    assert held["registered"] is False
    assert (
        main_module._subject_record({}, "sub-005", record, held_site="Ingenia")["site"]
        is None
    )
