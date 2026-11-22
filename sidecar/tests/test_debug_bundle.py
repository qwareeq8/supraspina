"""Tests for debug-bundle redaction of persisted and configured subjects."""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import debug_bundle as debug_bundle_module
from supraspina_sidecar.debug_bundle import DebugBundleManager
from supraspina_sidecar.project import ProjectEpochs
from supraspina_sidecar.redaction import redact_secrets, redact_text
from supraspina_sidecar.results import ResultInventory
from supraspina_sidecar.run_store import RunStore


def _project(root: Path) -> dict[str, Any]:
    return {
        "projectId": "debug-project",
        "root": str(root),
        "configPath": str(root / "supraspina.project.json"),
        "epoch": 1,
    }


@pytest.mark.parametrize(
    ("source", "secret"),
    [
        ("GITHUB_TOKEN=github-token-value", "github-token-value"),
        (
            '{"AWS_SECRET_ACCESS_KEY": "aws-secret-value"}',
            "aws-secret-value",
        ),
        ("OPENAI_API_KEY: openai-key-value", "openai-key-value"),
        ("DB_PASSWORD='database-password'", "database-password"),
        ('CLIENT_SECRET = "oauth-client-secret"', "oauth-client-secret"),
        (
            "https://example.invalid/callback?github_token=query-token-value",
            "query-token-value",
        ),
    ],
)
def test_redact_text_redacts_prefixed_secret_keys(source: str, secret: str) -> None:
    rendered = redact_text(source)

    assert secret not in rendered
    assert "[REDACTED]" in rendered


def test_redact_text_does_not_redact_non_secret_identifier_near_matches() -> None:
    source = "TOKENIZER_MODEL=wordpiece SECRETARY_NAME=Alex"

    assert redact_text(source) == source


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("Authorization: Bearer TOKEN", "Authorization: [REDACTED]"),
        ("authorization: bearer TOKEN", "authorization: [REDACTED]"),
        ("Proxy-Authorization: Bearer TOKEN", "Proxy-Authorization: [REDACTED]"),
        ("X-Api-Key: Bearer TOKEN", "X-Api-Key: [REDACTED]"),
        ("Authorization=Bearer TOKEN", "Authorization=[REDACTED]"),
        (
            'curl -H "Authorization: Bearer TOKEN"',
            'curl -H "Authorization: [REDACTED]"',
        ),
        ('{"authorization": "Bearer TOKEN"}', '{"authorization": "[REDACTED]"}'),
        ("Bearer TOKEN", "Bearer [REDACTED]"),
    ],
)
def test_redact_text_removes_bearer_credentials_after_a_secret_key(
    source: str, expected: str
) -> None:
    token = "sk-live-0123456789abcdef"  # noqa: S105

    rendered = redact_text(source.replace("TOKEN", token))

    assert rendered == expected
    assert token not in rendered


def test_redact_text_keeps_a_bearer_credential_on_its_own_line() -> None:
    token = "sk-live-0123456789abcdef"  # noqa: S105
    source = f"Authorization: Bearer {token}\nSTEP=recon\n"

    rendered = redact_text(source)

    assert rendered == "Authorization: [REDACTED]\nSTEP=recon\n"


def test_redact_secrets_keeps_operator_paths_and_subject_identifiers() -> None:
    token = "sk-live-0123456789abcdef"  # noqa: S105
    source = (
        f"Authorization: Bearer {token}\n"
        "recon-all -s sub-private -sd /projects/study/derivatives\n"
    )

    rendered = redact_secrets(source)

    assert token not in rendered
    assert rendered == (
        "Authorization: [REDACTED]\n"
        "recon-all -s sub-private -sd /projects/study/derivatives\n"
    )
    assert (
        redact_text(source, project_root="/projects/study", subject_ids=["sub-private"])
        != rendered
    )


def test_log_scan_stops_at_the_directory_entry_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ("a.log", "b.log", "c.log"):
        (tmp_path / name).write_text(name, encoding="utf-8")
    monkeypatch.setattr(debug_bundle_module, "_MAX_LOG_DIRECTORY_ENTRIES", 2)

    paths, truncated = debug_bundle_module._bounded_log_paths(tmp_path)

    assert len(paths) <= 2
    assert truncated is True


def test_log_entry_reads_only_the_bounded_prefix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "job.log"
    path.write_text("abcdef", encoding="utf-8")
    monkeypatch.setattr(debug_bundle_module, "_MAX_FILE_BYTES", 5)

    entry = DebugBundleManager._file_entry("logs", "logs/job.log", path)

    assert entry.text == "abcde"
    assert entry.source_bytes == 6
    assert entry.truncated is True


def test_bundle_redacts_subjects_outside_current_analysis_scope(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    run_id = "run-deadbeef"
    log_dir = root / ".supraspina" / "runs" / run_id / "logs"
    log_dir.mkdir(parents=True)
    subject_ids = ["sub-analysis", "sub-include", "sub-exclude", "sub-old-job"]
    (log_dir / "job.log").write_text(" ".join(subject_ids) + "\n", encoding="utf-8")
    RunStore(str(root)).commit(
        {
            "runId": run_id,
            "project": _project(root),
            "config": {
                "paths": {"projectRoot": str(root)},
                "subjects": {
                    "include": ["sub-include"],
                    "exclude": ["sub-exclude"],
                },
            },
            "scope": {
                "analysisSubjectIds": ["sub-analysis"],
                "selectedSubjectIds": ["sub-analysis"],
            },
            "nodes": [
                {
                    "nodeId": "old",
                    "stepKey": "recon",
                    "subjectId": "sub-old-job",
                    "status": "done",
                }
            ],
            "jobs": [{"id": "#old", "subjectId": "sub-old-job"}],
            "receipts": [],
            "manifest": {"schemaVersion": 1, "runId": run_id},
            "startedAtMs": 1,
            "endedAtMs": 2,
            "status": "done",
            "dryRun": False,
        }
    )
    projects = ProjectEpochs()
    projects.validate(_project(root))
    manager = DebugBundleManager(projects, ResultInventory(projects))
    destination = tmp_path / "bundle.zip"

    manager.bundle(
        {
            "project": _project(root),
            "runId": run_id,
            "consent": True,
            "redaction": "required",
            "categoryIds": ["config", "graph", "logs"],
            "destinationPath": str(destination),
        }
    )

    with zipfile.ZipFile(destination) as archive:
        rendered = "\n".join(
            archive.read(name).decode("utf-8") for name in archive.namelist()
        )
    assert "[SUBJECT]" in rendered
    for subject_id in subject_ids:
        assert subject_id not in rendered


def test_bundle_redacts_environment_prefixed_secrets(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    run_id = "run-cafefeed"
    log_dir = root / ".supraspina" / "runs" / run_id / "logs"
    log_dir.mkdir(parents=True)
    secrets = {
        "GITHUB_TOKEN": "github-bundle-secret",
        "AWS_SECRET_ACCESS_KEY": "aws-bundle-secret",
        "OPENAI_API_KEY": "openai-bundle-secret",
        "DB_PASSWORD": "database-bundle-secret",
        "CLIENT_SECRET": "client-bundle-secret",
    }
    (log_dir / "job.log").write_text(
        "\n".join(f"{key}={value}" for key, value in secrets.items()) + "\n",
        encoding="utf-8",
    )
    RunStore(str(root)).commit(
        {
            "runId": run_id,
            "project": _project(root),
            "config": {
                "paths": {"projectRoot": str(root)},
                "environment": secrets,
            },
            "scope": {},
            "nodes": [],
            "jobs": [],
            "receipts": [],
            "manifest": {"schemaVersion": 1, "runId": run_id},
            "startedAtMs": 1,
            "endedAtMs": 2,
            "status": "done",
            "dryRun": False,
        }
    )
    projects = ProjectEpochs()
    projects.validate(_project(root))
    manager = DebugBundleManager(projects, ResultInventory(projects))
    destination = tmp_path / "bundle.zip"

    manager.bundle(
        {
            "project": _project(root),
            "runId": run_id,
            "consent": True,
            "redaction": "required",
            "categoryIds": ["config", "logs"],
            "destinationPath": str(destination),
        }
    )

    with zipfile.ZipFile(destination) as archive:
        rendered = "\n".join(
            archive.read(name).decode("utf-8") for name in archive.namelist()
        )
    assert "[REDACTED]" in rendered
    for key, secret in secrets.items():
        assert key in rendered
        assert secret not in rendered


def test_bundle_redacts_bearer_credentials_in_job_logs(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    run_id = "run-beefcafe"
    log_dir = root / ".supraspina" / "runs" / run_id / "logs"
    log_dir.mkdir(parents=True)
    token = "sk-live-0123456789abcdef"  # noqa: S105
    (log_dir / "job.log").write_text(
        f'curl -H "Authorization: Bearer {token}" https://example.invalid/v1\n',
        encoding="utf-8",
    )
    RunStore(str(root)).commit(
        {
            "runId": run_id,
            "project": _project(root),
            "config": {"paths": {"projectRoot": str(root)}},
            "scope": {},
            "nodes": [],
            "jobs": [],
            "receipts": [],
            "manifest": {"schemaVersion": 1, "runId": run_id},
            "startedAtMs": 1,
            "endedAtMs": 2,
            "status": "done",
            "dryRun": False,
        }
    )
    projects = ProjectEpochs()
    projects.validate(_project(root))
    manager = DebugBundleManager(projects, ResultInventory(projects))
    destination = tmp_path / "bundle.zip"

    manager.bundle(
        {
            "project": _project(root),
            "runId": run_id,
            "consent": True,
            "redaction": "required",
            "categoryIds": ["logs"],
            "destinationPath": str(destination),
        }
    )

    with zipfile.ZipFile(destination) as archive:
        rendered = archive.read("logs/job.log").decode("utf-8")

    assert 'Authorization: [REDACTED]"' in rendered
    assert token not in rendered
