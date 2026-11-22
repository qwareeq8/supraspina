"""Tests for the PyBrainAge provisioning executor with isolated dependencies.

An injected runner, extractor, and verifier cover step order,
stop-on-first-failure behavior, progress streaming, immutable SHA enforcement,
and bundled-preferred micromamba resolution without touching the network or a
real environment. A synthetic zip covers stdlib extraction directly.
"""

from __future__ import annotations

import json
import os
import zipfile
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.adapters import pybrainage, tools


def _cfg(tmp_path: Path) -> dict[str, Any]:
    """Return a config whose outputDir is a concrete tmp directory."""
    return {"paths": {"outputDir": str(tmp_path)}}


@pytest.fixture(autouse=True)
def _reviewed_micromamba(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Select reviewed manager identity without relying on ignored host bytes."""
    selected = tmp_path / "reviewed-micromamba"
    selected.write_bytes(b"synthetic reviewed manager")
    selected.chmod(0o700)
    monkeypatch.setattr(pybrainage, "micromamba_binary", lambda: str(selected))
    monkeypatch.setattr(
        pybrainage,
        "micromamba_identity",
        lambda _candidate=None: (str(selected), pybrainage.MICROMAMBA_SHA256),
    )


class _Runner:
    """Record every argv and return rc 0 unless an argv matches ``fail_on``."""

    def __init__(self, fail_on: str | None = None) -> None:
        self.calls: list[list[str]] = []
        self.options: list[dict[str, Any]] = []
        self._fail_on = fail_on

    def __call__(self, argv: list[str], **options: Any) -> tools.RunResult:
        self.calls.append(argv)
        self.options.append(options)
        if self._fail_on is not None and any(self._fail_on in arg for arg in argv):
            return tools.RunResult(
                rc=1,
                stdout="",
                stderr="Report the fixture failure.",
            )
        if argv[:1] == ["curl"]:
            target = Path(argv[argv.index("--output") + 1])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"synthetic archive")
        if argv[-1:] == ["--version"]:
            return tools.RunResult(
                rc=0, stdout=f"{pybrainage.MICROMAMBA_VERSION}\n", stderr=""
            )
        if any("cliffs_delta" in arg for arg in argv):
            return tools.RunResult(
                rc=0,
                stdout=json.dumps(pybrainage.PYBRAINAGE_RUNTIME_VERSIONS),
                stderr="",
            )
        return tools.RunResult(rc=0, stdout="ok", stderr="")


def _ok_extractor(_cfg: dict[str, Any]) -> tools.RunResult:
    """Return a successful stand-in extraction result."""
    return tools.RunResult(rc=0, stdout="extracted", stderr="")


def _ok_verifier(
    _cfg: dict[str, Any], _sha256: str, **_options: Any
) -> tools.RunResult:
    """Return a successful stand-in verification result."""
    return tools.RunResult(rc=0, stdout="verified", stderr="")


def _ok_state_writer(
    _cfg: dict[str, Any],
    _versions: dict[str, str],
    **_options: Any,
) -> tools.RunResult:
    """Return a successful stand-in provenance write."""
    return tools.RunResult(rc=0, stdout="recorded", stderr="")


def _recorder() -> tuple[list[tuple[str, float]], Any]:
    """Return an event list and a progress callback that appends to it."""
    events: list[tuple[str, float]] = []

    def cb(message: str, fraction: float) -> None:
        events.append((message, fraction))

    return events, cb


def test_execute_rejects_an_explicitly_empty_sha(tmp_path: Path) -> None:
    # Prevent RPC or config overrides from disabling integrity verification.
    runner = _Runner()
    _events, cb = _recorder()
    result = pybrainage.execute_provision(
        _cfg(tmp_path), cb, expected_sha256="", runner=runner, extractor=_ok_extractor
    )
    assert result == {
        "ok": False,
        "steps": [],
        "failed_step": "verify_model",
        "rc": 2,
        "message": "Use the immutable published archive digest.",
    }
    assert runner.calls == []


def test_execute_verifies_by_default_with_pinned_sha(tmp_path: Path) -> None:
    # Use the pinned digest when expected_sha256 is absent. Run verification
    # before extraction without emitting a skip warning.
    runner = _Runner()
    events, cb = _recorder()
    result = pybrainage.execute_provision(
        _cfg(tmp_path),
        cb,
        runner=runner,
        extractor=_ok_extractor,
        verifier=_ok_verifier,
        state_writer=_ok_state_writer,
    )
    assert result["ok"] is True
    steps = result["steps"]
    assert "verify_model" in steps
    assert steps.index("verify_model") < steps.index("extract_model")
    assert steps[-1] == "record_state"
    assert not any("no pinned SHA-256" in message for message, _ in events)
    expected_environment = pybrainage.provision_environment(_cfg(tmp_path))
    assert runner.options
    assert all(options["env"] == expected_environment for options in runner.options)


def test_execute_binds_one_selected_micromamba_through_state(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    candidate = "/candidate/micromamba"
    selected = "/resolved/micromamba"
    monkeypatch.setattr(pybrainage, "micromamba_binary", lambda: candidate)
    monkeypatch.setattr(
        pybrainage,
        "micromamba_identity",
        lambda _candidate=None: (
            selected,
            pybrainage.MICROMAMBA_SHA256,
        ),
    )
    state_options: dict[str, Any] = {}

    def state_writer(
        _cfg: dict[str, Any],
        _versions: dict[str, str],
        **options: Any,
    ) -> tools.RunResult:
        state_options.update(options)
        return tools.RunResult(rc=0, stdout="recorded", stderr="")

    runner = _Runner()
    _events, cb = _recorder()
    result = pybrainage.execute_provision(
        _cfg(tmp_path),
        cb,
        runner=runner,
        extractor=_ok_extractor,
        verifier=_ok_verifier,
        state_writer=state_writer,
    )

    assert result["ok"] is True
    manager = next(argv for argv in runner.calls if argv[-1:] == ["--version"])
    create = next(argv for argv in runner.calls if argv[1:2] == ["create"])
    assert manager[0] == selected
    assert create[0] == selected
    assert state_options["micromamba"] == selected


def test_execute_rejects_noncanonical_sha_before_any_side_effect(
    tmp_path: Path,
) -> None:
    # Prevent callers from replacing the published archive pin.
    runner = _Runner()
    _events, cb = _recorder()
    result = pybrainage.execute_provision(
        _cfg(tmp_path),
        cb,
        expected_sha256="deadbeef",
        runner=runner,
        extractor=_ok_extractor,
    )
    assert result["ok"] is False
    assert result["failed_step"] == "verify_model"
    assert result["steps"] == []
    assert runner.calls == []


def test_execute_stops_at_first_failed_step(tmp_path: Path) -> None:
    # Stop after a failed fetch, skip extraction and validation, and report the
    # failed step and message.
    runner = _Runner(fail_on="curl")
    _events, cb = _recorder()
    extract_calls = {"n": 0}

    def extractor(_cfg: dict[str, Any]) -> tools.RunResult:
        extract_calls["n"] += 1
        return tools.RunResult(rc=0, stdout="", stderr="")

    result = pybrainage.execute_provision(
        _cfg(tmp_path), cb, runner=runner, extractor=extractor
    )
    assert result["ok"] is False
    assert result["failed_step"] == "fetch_model"
    assert result["steps"] == [
        "check_micromamba",
        "create_env",
        "install_pip_deps",
        "probe_runtime",
        "fetch_model",
    ]
    assert extract_calls["n"] == 0
    assert result["message"] == "Report the fixture failure."


def test_execute_creates_model_cache_parent_before_download(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    fetch_seen = False

    def runner(argv: list[str], **_options: Any) -> tools.RunResult:
        nonlocal fetch_seen
        if argv[-1:] == ["--version"]:
            return tools.RunResult(
                rc=0, stdout=f"{pybrainage.MICROMAMBA_VERSION}\n", stderr=""
            )
        if any("cliffs_delta" in arg for arg in argv):
            return tools.RunResult(
                rc=0,
                stdout=json.dumps(pybrainage.PYBRAINAGE_RUNTIME_VERSIONS),
                stderr="",
            )
        if argv[0] == "curl":
            fetch_seen = True
            target = Path(argv[argv.index("--output") + 1])
            assert target.name == f".{pybrainage.PYBRAINAGE_ZENODO_ASSET}.part"
            assert target.parent.is_dir()
            assert (tmp_path / ".pybrainage" / "generations") in target.parents
            target.write_bytes(b"synthetic archive")
        return tools.RunResult(rc=0, stdout="ok", stderr="")

    _events, cb = _recorder()
    result = pybrainage.execute_provision(
        cfg,
        cb,
        runner=runner,
        extractor=_ok_extractor,
        verifier=_ok_verifier,
        state_writer=_ok_state_writer,
    )

    assert result["ok"] is True
    assert fetch_seen is True


def test_execute_reports_extraction_failure(tmp_path: Path) -> None:
    # Treat a non-zero extractor result as a failed step.
    runner = _Runner()
    _events, cb = _recorder()

    def bad_extractor(_cfg: dict[str, Any]) -> tools.RunResult:
        return tools.RunResult(rc=1, stdout="", stderr="bad zip")

    result = pybrainage.execute_provision(
        _cfg(tmp_path),
        cb,
        runner=runner,
        extractor=bad_extractor,
        verifier=_ok_verifier,
    )
    assert result["ok"] is False
    assert result["failed_step"] == "extract_model"
    assert result["message"] == "bad zip"


def test_extract_model_unpacks_software_tree(tmp_path: Path) -> None:
    # Extract the archive's software tree into model_root with the standard library.
    cfg = _cfg(tmp_path)
    root = pybrainage.model_root(cfg)
    os.makedirs(root, exist_ok=True)
    archive = os.path.join(root, pybrainage.PYBRAINAGE_ZENODO_ASSET)
    with zipfile.ZipFile(archive, "w") as handle:
        handle.writestr(f"software/{pybrainage.PYBRAINAGE_MODEL_FILE}", "model")
        handle.writestr(f"software/{pybrainage.PYBRAINAGE_SCALER_FILE}", "scaler")
    result = pybrainage.extract_model(cfg)
    assert result.rc == 0
    software = os.path.join(root, "software")
    assert os.path.exists(os.path.join(software, pybrainage.PYBRAINAGE_MODEL_FILE))
    assert os.path.exists(os.path.join(software, pybrainage.PYBRAINAGE_SCALER_FILE))


def test_extract_model_reports_missing_archive(tmp_path: Path) -> None:
    # Return rc=1 and stderr for a missing archive without raising.
    result = pybrainage.extract_model(_cfg(tmp_path))
    assert result.rc == 1
    assert "Extract the model archive" in result.stderr
