"""Tests for cross-language fixtures and persistence safety in the QC store."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from supraspina_sidecar import qc_store
from supraspina_sidecar.qc_store import QcStoreError, load_document, parse_document

FIXTURES = Path(__file__).parents[2] / "fixtures" / "qc-store"


def _copy_fixture(tmp_path: Path, name: str) -> Path:
    target = tmp_path / "qc_verdicts.json"
    shutil.copyfile(FIXTURES / name, target)
    return target


def test_load_document_reads_canonical_fixture_without_rewriting(
    tmp_path: Path,
) -> None:
    target = _copy_fixture(tmp_path, "canonical.json")
    original = target.read_bytes()

    document = load_document(str(target))

    assert document["schemaVersion"] == 2
    assert document["verdicts"]["sub-01"]["verdict"] == "fail"
    assert target.read_bytes() == original


@pytest.mark.parametrize(
    "name",
    [
        "malformed.json",
        "unversioned.json",
        "invalid-revision.json",
        "wrong-shape.json",
    ],
)
def test_load_document_rejects_invalid_store_without_touching_bytes(
    tmp_path: Path, name: str
) -> None:
    target = _copy_fixture(tmp_path, name)
    original = target.read_bytes()

    with pytest.raises(QcStoreError):
        load_document(str(target))

    assert target.read_bytes() == original


@pytest.mark.parametrize(
    "value",
    [
        {"schemaVersion": 3, "verdicts": {}},
        {
            "schemaVersion": 2,
            "verdicts": {
                "sub-01": {
                    "verdict": "fail",
                    "note": "",
                    "tags": [],
                    "reviewEvidence": None,
                    "revision": True,
                    "updatedAt": "2026-07-23T12:00:00.000Z",
                }
            },
        },
        {
            "schemaVersion": 2,
            "verdicts": {
                "sub-01": {
                    "verdict": "fail",
                    "note": "",
                    "tags": [],
                    "reviewEvidence": None,
                    "revision": 2**53,
                    "updatedAt": "2026-07-23T12:00:00.000Z",
                }
            },
        },
    ],
)
def test_parse_document_rejects_unsupported_and_unsafe_revisions(
    value: object,
) -> None:
    with pytest.raises(QcStoreError):
        parse_document(value)


def test_parse_document_normalizes_an_integral_float_revision() -> None:
    """Read the revision the renderer reads from the same bytes."""
    document = json.loads(
        """
        {
          "schemaVersion": 2,
          "verdicts": {
            "sub-01": {
              "verdict": null,
              "note": "",
              "tags": [],
              "reviewEvidence": null,
              "revision": 1.0,
              "updatedAt": "2026-07-23T12:00:00.000Z"
            }
          }
        }
        """
    )
    assert isinstance(document["verdicts"]["sub-01"]["revision"], float)

    parsed = parse_document(document)

    revision = parsed["verdicts"]["sub-01"]["revision"]
    assert revision == 1
    assert isinstance(revision, int)
    assert not isinstance(revision, float)


@pytest.mark.parametrize("revision", [1.5, float("nan"), float("inf"), 2.0**53])
def test_parse_document_rejects_a_non_integral_or_unsafe_float_revision(
    revision: float,
) -> None:
    document = {
        "schemaVersion": 2,
        "verdicts": {
            "sub-01": {
                "verdict": None,
                "note": "",
                "tags": [],
                "reviewEvidence": None,
                "revision": revision,
                "updatedAt": "2026-07-23T12:00:00.000Z",
            }
        },
    }

    with pytest.raises(QcStoreError):
        parse_document(document)


def test_parse_document_applies_text_limits_by_unicode_code_point() -> None:
    multibyte = "\U0001f600"
    document = {
        "schemaVersion": 2,
        "verdicts": {
            multibyte * 128: {
                "verdict": None,
                "note": multibyte * 4_096,
                "tags": [multibyte * 64],
                "reviewEvidence": None,
                "revision": 1,
                "updatedAt": "2026-07-23T12:00:00.000Z",
            }
        },
    }

    parsed = parse_document(document)

    assert parsed == document

    too_long = json.loads(json.dumps(document))
    too_long["verdicts"][multibyte * 128]["note"] = multibyte * 4_097
    with pytest.raises(QcStoreError):
        parse_document(too_long)


def test_parse_document_rejects_iso_shaped_year_zero_timestamp() -> None:
    document = {
        "schemaVersion": 2,
        "verdicts": {
            "sub-01": {
                "verdict": None,
                "note": "",
                "tags": [],
                "reviewEvidence": None,
                "revision": 1,
                "updatedAt": "0000-01-01T00:00:00.000Z",
            }
        },
    }

    with pytest.raises(QcStoreError):
        parse_document(document)


def test_load_document_treats_only_missing_file_as_empty(tmp_path: Path) -> None:
    target = tmp_path / "missing.json"

    assert load_document(str(target)) == {"schemaVersion": 2, "verdicts": {}}

    target.mkdir()
    with pytest.raises(QcStoreError, match="regular file"):
        load_document(str(target))


def test_load_document_rejects_limit_plus_one_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "qc_verdicts.json"
    target.write_bytes(b"x" * 9)
    monkeypatch.setattr(qc_store, "MAX_STORE_BYTES", 8)

    with pytest.raises(QcStoreError, match="bounded regular file"):
        load_document(str(target))


@pytest.mark.skipif(
    os.name == "nt",
    reason="Run POSIX mode enforcement only on release Linux.",
)
def test_load_document_rejects_unreadable_file_without_replacing_it(
    tmp_path: Path,
) -> None:
    target = _copy_fixture(tmp_path, "canonical.json")
    original = target.read_bytes()
    target.chmod(0)
    try:
        if os.access(target, os.R_OK):
            pytest.skip(
                "Skip this test when the account bypasses mode-based read denial."
            )
        with pytest.raises(QcStoreError, match="readable QC verdict store"):
            load_document(str(target))
    finally:
        target.chmod(0o600)

    assert target.read_bytes() == original
