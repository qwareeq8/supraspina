"""Tests for the release metadata generator."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[1] / "scripts" / "generate_release_metadata.py"
)
SPEC = importlib.util.spec_from_file_location("generate_release_metadata", SCRIPT)
assert SPEC
assert SPEC.loader
release_metadata = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release_metadata)


def test_release_lock_parser_requires_exact_hashes(tmp_path: Path) -> None:
    valid = tmp_path / "valid.txt"
    valid.write_text(
        f"Example_Name==1.2.3 \\\n    --hash=sha256:{'a' * 64}\n",
        encoding="utf-8",
    )
    assert release_metadata.parse_lock(valid) == {
        "example-name": {
            "name": "Example_Name",
            "version": "1.2.3",
            "lockHashes": ["a" * 64],
        }
    }

    ranged = tmp_path / "ranged.txt"
    ranged.write_text("example>=1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Use an exact requirement"):
        release_metadata.parse_lock(ranged)

    unhashed = tmp_path / "unhashed.txt"
    unhashed.write_text("example==1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="Use an exact requirement"):
        release_metadata.parse_lock(unhashed)


def test_generated_sbom_is_path_sanitized_and_complete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    requirements = Path(__file__).resolve().parents[1] / "requirements"
    lock = release_metadata.parse_lock(requirements / "release-linux-x86_64.txt")
    assert len(lock) == 13
    records = [
        {
            **pinned,
            "normalizedName": normalized,
            "declaredLicense": "MIT",
            "author": "Synthetic metadata fixture",
            "projectUrl": "https://example.invalid/project",
            "licenseFiles": [],
        }
        for normalized, pinned in sorted(lock.items())
    ]
    monkeypatch.setattr(release_metadata, "installed_records", lambda _lock: records)
    sbom_path, notices_path = release_metadata.generate(
        "linux-x86_64", tmp_path, requirements
    )

    sbom_text = sbom_path.read_text(encoding="utf-8")
    sbom = json.loads(sbom_text)
    assert sbom["bomFormat"] == "CycloneDX"
    with (requirements.parent / "pyproject.toml").open("rb") as handle:
        expected_version = release_metadata.tomllib.load(handle)["project"]["version"]
    assert sbom["metadata"]["component"]["version"] == expected_version
    properties = {
        item["name"]: item["value"] for item in sbom["metadata"]["properties"]
    }
    assert properties["supraspina:python"] == release_metadata._EXPECTED_PYTHON
    assert properties["supraspina:target"] == "linux-x86_64"
    assert len(sbom["components"]) == 13
    assert {item["name"].lower() for item in sbom["components"]} >= {
        "openpyxl",
        "pydantic",
        "pyinstaller",
    }
    assert str(Path.home()) not in sbom_text
    notices = notices_path.read_text(encoding="utf-8")
    assert "openpyxl 3.1.5" in notices
    assert "pydantic 2.13.4" in notices
    assert "pyinstaller 6.21.0" in notices
    assert str(Path.home()) not in notices
    assert {entry.name for entry in tmp_path.iterdir()} == {
        "python-release-linux-x86_64.cyclonedx.json",
        "python-release-linux-x86_64-notices.txt",
    }


def test_metadata_output_accepts_only_the_exact_node_predecessor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    requirements = Path(__file__).resolve().parents[1] / "requirements"
    lock = release_metadata.parse_lock(requirements / "release-linux-x86_64.txt")
    records = [
        {
            **pinned,
            "normalizedName": normalized,
            "declaredLicense": "MIT",
            "author": None,
            "projectUrl": None,
            "licenseFiles": [],
        }
        for normalized, pinned in sorted(lock.items())
    ]
    monkeypatch.setattr(release_metadata, "installed_records", lambda _lock: records)
    for name in release_metadata._NODE_METADATA_NAMES:
        (tmp_path / name).write_text("fixture\n", encoding="utf-8")

    release_metadata.generate("linux-x86_64", tmp_path, requirements)

    assert {entry.name for entry in tmp_path.iterdir()} == set(
        release_metadata._NODE_METADATA_NAMES
    ) | {
        "python-release-linux-x86_64.cyclonedx.json",
        "python-release-linux-x86_64-notices.txt",
    }


def test_metadata_output_rejects_stale_ignored_staging(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    requirements = Path(__file__).resolve().parents[1] / "requirements"
    monkeypatch.setattr(release_metadata, "installed_records", lambda _lock: [])
    (tmp_path / "stale.json").write_text("{}\n", encoding="utf-8")

    with pytest.raises(ValueError, match="exact Node predecessor files"):
        release_metadata.generate("linux-x86_64", tmp_path, requirements)
