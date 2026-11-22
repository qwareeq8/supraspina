"""Tests for BrainCharts provisioning with a faked network and runtime.

A synthetic model archive and lists stand in for the GitHub files (their pins
are swapped for the synthetic bytes), and a fake runner stands in for curl,
micromamba, pip, and the environment probes, so nothing reaches the network or
builds a real environment. The committed locks are checked against their real
pins.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import stat
import zipfile
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import braincharts_runtime as bc
from supraspina_sidecar.adapters import tools
from supraspina_sidecar.env import braincharts as braincharts_env

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PHENOTYPES = {
    "lh": ["lh_G&S_frontomargin_thickness"],
    "rh": ["rh_S_front_inf_thickness"],
    "sc": ["Left-Thalamus-Proper", "EstimatedTotalIntraCranialVol"],
}


def _pinned(path: str, value: bytes) -> bc.PinnedFile:
    return bc.PinnedFile(path, len(value), hashlib.sha256(value).hexdigest())


def _model_zip(names: list[str], *, extra: dict[str, bytes] | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(f"{bc.MODEL_NAME}/", b"")
        for name in [*names, "avg_thickness"]:
            archive.writestr(f"{bc.MODEL_NAME}/{name}/", b"")
            archive.writestr(f"{bc.MODEL_NAME}/{name}/Models/", b"")
            archive.writestr(
                f"{bc.MODEL_NAME}/{name}/Models/meta_data.md", b"meta " * 20
            )
            archive.writestr(
                f"{bc.MODEL_NAME}/{name}/Models/{bc.MODEL_FILE}",
                f"model {name} ".encode() * 20,
            )
        for member, value in (extra or {}).items():
            archive.writestr(member, value)
    return buffer.getvalue()


class _Network:
    """Map pinned URLs to synthetic bytes and pin the module to them."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        names = [name for group in PHENOTYPES.values() for name in group]
        self.archive = _model_zip(names)
        self.sites = b"siteA\nsiteB\n"
        self.lists = {
            key: ("\n".join(values) + "\n").encode()
            for key, values in PHENOTYPES.items()
        }
        archive = _pinned(bc.MODEL_ARCHIVE.path, self.archive)
        site_list = _pinned(bc.SITE_LIST.path, self.sites)
        phenotype_lists = tuple(
            _pinned(pinned.path, self.lists[key])
            for pinned, key in zip(bc.PHENOTYPE_LISTS, ("lh", "rh", "sc"), strict=True)
        )
        monkeypatch.setattr(bc, "MODEL_ARCHIVE", archive)
        monkeypatch.setattr(bc, "SITE_LIST", site_list)
        monkeypatch.setattr(bc, "PHENOTYPE_LISTS", phenotype_lists)
        monkeypatch.setattr(bc, "MODEL_LISTS", (site_list, *phenotype_lists))
        monkeypatch.setattr(bc, "SITE_COUNT", 2)
        monkeypatch.setattr(bc, "PHENOTYPE_COUNT", len(names))
        self.content = {archive.url: self.archive, site_list.url: self.sites}
        for pinned, key in zip(phenotype_lists, ("lh", "rh", "sc"), strict=True):
            self.content[pinned.url] = self.lists[key]


class _Runner:
    """Stand in for curl, micromamba, pip, and the two environment probes."""

    def __init__(self, network: _Network) -> None:
        self.network = network
        self.calls: list[list[str]] = []
        self.environments: list[dict[str, str] | None] = []
        self.fail_on: str | None = None
        self.curl_bytes: dict[str, bytes] = {}
        self.versions = dict(bc.RUNTIME_VERSIONS)
        self.after_call: Any = None

    def __call__(
        self,
        argv: list[str],
        *,
        timeout: float | None = None,
        env: dict[str, str] | None = None,
    ) -> tools.RunResult:
        del timeout
        self.calls.append(argv)
        self.environments.append(env)
        result = self._respond(argv)
        if self.after_call is not None:
            self.after_call(argv)
        return result

    def _respond(self, argv: list[str]) -> tools.RunResult:  # noqa: PLR0911
        if self.fail_on is not None and any(self.fail_on in arg for arg in argv):
            return tools.RunResult(rc=1, stdout="", stderr="Fixture failure.")
        if argv[:1] == ["curl"]:
            url = argv[-1]
            target = Path(argv[argv.index("--output") + 1])
            value = self.curl_bytes.get(url, self.network.content[url])
            existing = target.stat().st_size if target.exists() else 0
            with target.open("ab") as handle:
                handle.write(value[existing:])
            return tools.RunResult(rc=0, stdout="", stderr="")
        if argv[-1:] == ["--version"]:
            return tools.RunResult(rc=0, stdout=bc.MICROMAMBA_VERSION + "\n", stderr="")
        if "create" in argv:
            prefix = Path(argv[argv.index("-p") + 1])
            (prefix / "conda-meta").mkdir(parents=True)
            (prefix / "conda-meta" / "python-3.12.14.json").write_text("{}")
            (prefix / "bin").mkdir()
            python = prefix / "bin" / "python"
            python.write_text("#!/bin/sh\n")
            python.chmod(0o755)
            dist = prefix / "lib" / "python3.12" / "site-packages" / "pip.dist-info"
            dist.mkdir(parents=True)
            (dist / "METADATA").write_text("Name: pip\n")
            (dist / "RECORD").write_text("pip/__init__.py,,\n")
            return tools.RunResult(rc=0, stdout="created", stderr="")
        if "pip" in argv and "install" in argv:
            site = Path(argv[0]).parents[1] / "lib" / "python3.12" / "site-packages"
            marker = "wheels" if "--only-binary=:all:" in argv else "sources"
            dist = site / f"{marker}.dist-info"
            dist.mkdir()
            (dist / "METADATA").write_text(f"Name: {marker}\n")
            return tools.RunResult(rc=0, stdout="installed", stderr="")
        if "-c" in argv and "metadata.version" in argv[argv.index("-c") + 1]:
            return tools.RunResult(rc=0, stdout=json.dumps(self.versions), stderr="")
        if "-c" in argv and "pickle.load" in argv[argv.index("-c") + 1]:
            return tools.RunResult(
                rc=0, stdout="Loaded pcntoolkit.normative_model.NormBLR.", stderr=""
            )
        return tools.RunResult(rc=0, stdout="ok", stderr="")


@pytest.fixture
def network(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> _Network:
    selected = tmp_path / "reviewed-micromamba"
    selected.write_bytes(b"synthetic reviewed manager")
    selected.chmod(0o700)
    monkeypatch.setattr(bc, "micromamba_binary", lambda: str(selected))
    monkeypatch.setattr(
        bc,
        "micromamba_identity",
        lambda _candidate=None: (str(selected), bc.MICROMAMBA_SHA256),
    )
    monkeypatch.setattr(bc, "platform_supported", lambda: True)
    monkeypatch.setattr(bc, "_MIN_FREE_BYTES", 0)
    bc._DIGEST_CACHE.clear()
    return _Network(monkeypatch)


def _cfg(tmp_path: Path) -> dict[str, Any]:
    return {"paths": {"outputDir": str(tmp_path / "out")}}


def _progress() -> tuple[list[tuple[str, float]], Any]:
    events: list[tuple[str, float]] = []
    return events, lambda message, fraction: events.append((message, fraction))


def _provision(
    cfg: dict[str, Any], runner: _Runner, **options: Any
) -> tuple[dict[str, Any], list[tuple[str, float]]]:
    events, progress = _progress()
    result = bc.execute_provision(cfg, progress, runner=runner, **options)
    return result, events


def _checks(cfg: dict[str, Any]) -> dict[str, Any]:
    return {check.id: check for check in braincharts_env.BrainChartsProbe().checks(cfg)}


# -- Committed locks ------------------------------------------------------------


def _lock_pins(text: str) -> dict[str, str]:
    return {
        match.group(1).lower(): match.group(2)
        for match in re.finditer(r"^([A-Za-z0-9_.-]+)==(\S+) \\$", text, re.MULTILINE)
    }


def test_committed_locks_match_their_pins_and_the_runtime_versions() -> None:
    conda_lock = bc.read_pinned_lock(bc.ENV_LOCK_NAME, bc.ENV_LOCK_SHA256)
    pip_lock = bc.read_pinned_lock(bc.PIP_LOCK_NAME, bc.PIP_LOCK_SHA256)
    assert conda_lock.startswith(b"@EXPLICIT\n")
    for line in conda_lock.decode().splitlines()[1:]:
        assert re.fullmatch(
            r"https://conda\.anaconda\.org/conda-forge/(linux-64|noarch)/\S+"
            r"\.conda#[0-9a-f]{64}",
            line,
        )
    pins = _lock_pins(pip_lock.decode())
    for name, version in bc.RUNTIME_VERSIONS.items():
        if name == "python":
            assert f"/python-{version}-" in conda_lock.decode()
        elif name == "pip":
            assert f"/pip-{version}-" in conda_lock.decode()
        else:
            assert pins[name] == version, name
    # The source build uses the conda setuptools, so it must be the pinned one.
    assert f"/setuptools-{pins['setuptools']}-" in conda_lock.decode()
    assert pins["pcntoolkit"] == bc.PCNTOOLKIT_VERSION
    assert pins["torch"].endswith("+cpu")
    assert not any(line.startswith("--") for line in pip_lock.decode().splitlines())


def test_split_pip_lock_separates_the_sdist_packages_and_keeps_every_hash() -> None:
    pip_lock = bc.read_pinned_lock(bc.PIP_LOCK_NAME, bc.PIP_LOCK_SHA256)
    wheels, sources = bc.split_pip_lock(pip_lock)
    assert set(_lock_pins(sources.decode())) == set(bc.SOURCE_BUILD_DISTRIBUTIONS)
    wheel_pins = _lock_pins(wheels.decode())
    assert not set(wheel_pins) & set(bc.SOURCE_BUILD_DISTRIBUTIONS)
    assert len(wheel_pins) + 1 == len(_lock_pins(pip_lock.decode()))
    assert wheels.count(b"--hash=sha256:") + sources.count(
        b"--hash=sha256:"
    ) == pip_lock.count(b"--hash=sha256:")


def test_split_pip_lock_refuses_unhashed_or_incomplete_locks() -> None:
    with pytest.raises(RuntimeError, match="leaves six unhashed"):
        bc.split_pip_lock(b"six==1.17.0\n")
    with pytest.raises(RuntimeError, match="lacks its source packages"):
        bc.split_pip_lock(b"six==1.17.0 \\\n    --hash=sha256:" + b"a" * 64 + b"\n")


def test_a_tampered_committed_lock_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / bc.PIP_LOCK_NAME).write_text("pcntoolkit==0.35.0\n")
    monkeypatch.setattr(bc, "lock_source_dir", lambda: tmp_path)
    with pytest.raises(RuntimeError, match="differs from its pin"):
        bc.read_pinned_lock(bc.PIP_LOCK_NAME, bc.PIP_LOCK_SHA256)
    with pytest.raises(RuntimeError, match="is missing"):
        bc.read_pinned_lock(bc.ENV_LOCK_NAME, bc.ENV_LOCK_SHA256)


def test_commands_pin_https_sizes_hashes_and_both_indexes(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path)
    fetch = bc.fetch_command(bc.MODEL_ARCHIVE, str(tmp_path / "part"))
    assert fetch[:1] == ["curl"]
    assert fetch[fetch.index("--proto") + 1] == "=https"
    assert fetch[fetch.index("--proto-redir") + 1] == "=https"
    assert fetch[fetch.index("--max-filesize") + 1] == "2796655"
    assert fetch[-1] == (
        "https://raw.githubusercontent.com/predictive-clinical-neuroscience/"
        "braincharts/5a1a7822e6f54405b0a826cf137d584240af307c/models/"
        "lifespan_57K_82sites.zip"
    )
    wheels = bc.pip_wheels_command(cfg)
    sources = bc.pip_sources_command(cfg)
    for command in (wheels, sources):
        assert "--require-hashes" in command
        assert "--no-deps" in command
        assert "--no-build-isolation" in command
        assert command[command.index("--index-url") + 1] == bc.PYPI_INDEX
        assert command[command.index("--extra-index-url") + 1] == bc.PYTORCH_CPU_INDEX
    assert "--only-binary=:all:" in wheels
    assert "--no-binary=bspline" in sources


# -- Provisioning ------------------------------------------------------------------


def test_provisioning_publishes_a_checked_generation_and_records_it(
    tmp_path: Path, network: _Network
) -> None:
    cfg = _cfg(tmp_path)
    pins = REPOSITORY_ROOT / "SCIENTIFIC_RESOURCE_PINS.json"
    pins_before = hashlib.sha256(pins.read_bytes()).hexdigest()
    runner = _Runner(network)

    result, events = _provision(cfg, runner)

    assert result == {"ok": True, "failed_step": None, "rc": 0, "message": ""}
    messages = [message for message, _fraction in events]
    assert messages[0] == "Checking micromamba..."
    assert "Downloading the BrainCharts model from GitHub..." in messages
    assert messages[-1] == "The BrainCharts model and runtime are set up."
    fractions = [fraction for _message, fraction in events]
    assert fractions == sorted(fractions)
    root = Path(bc.provision_root(cfg))
    assert (root / "current").is_symlink()
    assert Path(bc.archive_path(cfg)).read_bytes() == network.archive
    assert (Path(bc.model_dir(cfg)) / "avg_thickness").is_dir()
    assert bc.phenotype_names(cfg) == [
        name for group in PHENOTYPES.values() for name in group
    ]
    model_file = Path(bc.model_dir(cfg)) / "Left-Thalamus-Proper" / "Models"
    assert stat.S_IMODE((model_file / bc.MODEL_FILE).stat().st_mode) == 0o444
    state = bc.provision_state_status(cfg)
    assert state.environment_ok
    assert state.model_ok
    assert state.provenance is not None
    checks = _checks(cfg)
    assert checks["bcenv"].status == "found"
    assert checks["bcmodel"].status == "found"
    assert state.provenance in (checks["bcmodel"].identity_detail or "")
    curl_calls = [call for call in runner.calls if call[:1] == ["curl"]]
    assert len(curl_calls) == 1 + len(bc.MODEL_LISTS)
    # The runtime writes its caches below the owned root, never under ~.
    environment = runner.environments[-1] or {}
    assert environment["XDG_CACHE_HOME"].startswith(str(root))
    assert environment["NUMBA_CACHE_DIR"].startswith(str(root))
    assert environment["PYTENSOR_FLAGS"].startswith("base_compiledir=" + str(root))
    assert hashlib.sha256(pins.read_bytes()).hexdigest() == pins_before


def test_a_checked_generation_is_reused_without_network(
    tmp_path: Path, network: _Network
) -> None:
    cfg = _cfg(tmp_path)
    assert _provision(cfg, _Runner(network))[0]["ok"]
    runner = _Runner(network)

    result, events = _provision(cfg, runner)

    assert result["ok"]
    assert events == [("The existing BrainCharts setup is checked.", 1.0)]
    assert len(runner.calls) == 1
    assert "metadata.version" in runner.calls[0][-1]


def test_a_wrong_size_download_is_refused_and_leaves_nothing_published(
    tmp_path: Path, network: _Network
) -> None:
    cfg = _cfg(tmp_path)
    runner = _Runner(network)
    runner.curl_bytes[bc.MODEL_ARCHIVE.url] = network.archive + b"extra"

    result, _events = _provision(cfg, runner)

    assert not result["ok"]
    assert result["failed_step"] == "fetch_model"
    assert "bytes; the pinned file is" in result["message"]
    root = Path(bc.provision_root(cfg))
    assert not (root / "current").exists()
    assert list((root / "generations").iterdir()) == []
    assert list((root / "downloads").iterdir()) == []
    assert _checks(cfg)["bcmodel"].status == "missing"


def test_a_same_size_download_with_other_bytes_is_refused(
    tmp_path: Path, network: _Network
) -> None:
    cfg = _cfg(tmp_path)
    runner = _Runner(network)
    tampered = bytearray(network.archive)
    tampered[-1] ^= 1
    runner.curl_bytes[bc.MODEL_ARCHIVE.url] = bytes(tampered)

    result, _events = _provision(cfg, runner)

    assert result["failed_step"] == "fetch_model"
    assert "does not match its pinned SHA-256" in result["message"]


def test_a_tampered_list_is_refused(tmp_path: Path, network: _Network) -> None:
    cfg = _cfg(tmp_path)
    runner = _Runner(network)
    runner.curl_bytes[bc.SITE_LIST.url] = b"siteA\nsiteC\n"

    result, _events = _provision(cfg, runner)

    assert result["failed_step"] == "fetch_lists"
    assert "site_ids_ct_82sites.txt does not match" in result["message"]


def test_a_partial_model_download_resumes_and_a_checked_one_is_reused(
    tmp_path: Path, network: _Network
) -> None:
    cfg = _cfg(tmp_path)
    downloads = Path(bc.provision_root(cfg)) / "downloads"
    downloads.mkdir(parents=True)
    half = len(network.archive) // 2
    (downloads / f".{bc.MODEL_ARCHIVE.name}.part").write_bytes(network.archive[:half])
    runner = _Runner(network)

    assert _provision(cfg, runner)[0]["ok"]

    model_fetch = next(
        call for call in runner.calls if call[-1] == bc.MODEL_ARCHIVE.url
    )
    assert model_fetch[model_fetch.index("--continue-at") + 1] == "-"
    assert (downloads / bc.MODEL_ARCHIVE.name).read_bytes() == network.archive

    # A later setup (after the record is lost) reuses the checked downloads.
    Path(bc.provision_state_path(cfg)).unlink()
    rerun = _Runner(network)
    assert _provision(cfg, rerun)[0]["ok"]
    assert not [call for call in rerun.calls if call[:1] == ["curl"]]


def test_cancellation_stops_and_rolls_back(tmp_path: Path, network: _Network) -> None:
    cfg = _cfg(tmp_path)
    runner = _Runner(network)
    cancelled = {"value": False}

    def cancel_after_pip(argv: list[str]) -> None:
        if "install" in argv:
            cancelled["value"] = True

    runner.after_call = cancel_after_pip

    result, _events = _provision(cfg, runner, cancelled=lambda: cancelled["value"])

    assert result["rc"] == 130
    assert result["message"] == "cancelled"
    root = Path(bc.provision_root(cfg))
    assert not (root / "current").exists()
    assert list((root / "generations").iterdir()) == []
    assert not [call for call in runner.calls if call[:1] == ["curl"]]


@pytest.mark.parametrize(
    ("fail_on", "step", "fact"),
    [
        ("create", "create_env", "Creating the CPython 3.12 environment failed"),
        ("--only-binary=:all:", "install_wheels", "Installing the locked"),
        ("--no-binary=bspline", "install_sources", "Building the locked source"),
    ],
)
def test_a_failed_step_states_what_failed(
    tmp_path: Path, network: _Network, fail_on: str, step: str, fact: str
) -> None:
    runner = _Runner(network)
    runner.fail_on = fail_on

    result, events = _provision(_cfg(tmp_path), runner)

    assert result["failed_step"] == step
    assert result["message"].startswith(fact)
    assert result["message"].endswith(": Fixture failure.")
    assert events[-1][0] == result["message"]


def test_wrong_runtime_versions_are_refused(tmp_path: Path, network: _Network) -> None:
    runner = _Runner(network)
    runner.versions["pcntoolkit"] = "1.0.0"

    result, _events = _provision(_cfg(tmp_path), runner)

    assert result["failed_step"] == "probe_runtime"
    assert "pcntoolkit 1.0.0 (expected 0.35.0)" in result["message"]


def test_another_platform_is_refused_before_any_command(
    tmp_path: Path, network: _Network, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bc, "platform_supported", lambda: False)
    runner = _Runner(network)

    result, _events = _provision(_cfg(tmp_path), runner)

    assert result["message"] == bc.unsupported_platform_detail()
    assert runner.calls == []
    checks = _checks(_cfg(tmp_path))
    assert {check.status for check in checks.values()} == {"skipped"}
    assert checks["bcenv"].detail == (
        "The BrainCharts runtime is available on Linux x86_64 only."
    )


# -- Recheck (Diagnostics) ---------------------------------------------------------


def test_the_recheck_names_a_changed_model_file(
    tmp_path: Path, network: _Network
) -> None:
    cfg = _cfg(tmp_path)
    assert _provision(cfg, _Runner(network))[0]["ok"]
    target = Path(bc.model_dir(cfg)) / "Left-Thalamus-Proper" / "Models" / bc.MODEL_FILE
    target.chmod(0o644)
    target.write_bytes(b"changed")

    state = bc.provision_state_status(cfg)

    assert state.environment_ok
    assert not state.model_ok
    assert state.detail == "The BrainCharts model files changed after setup."
    checks = _checks(cfg)
    assert checks["bcmodel"].status == "wrong"
    assert checks["bcenv"].status == "wrong"
    assert "setup is incomplete" in checks["bcenv"].detail


def test_the_recheck_names_a_changed_environment(
    tmp_path: Path, network: _Network
) -> None:
    cfg = _cfg(tmp_path)
    assert _provision(cfg, _Runner(network))[0]["ok"]
    record = Path(bc.env_dir(cfg)) / "conda-meta" / "python-3.12.14.json"
    record.write_text('{"changed": true}')

    state = bc.provision_state_status(cfg)

    assert not state.environment_ok
    assert state.model_ok
    assert state.detail == "The BrainCharts runtime changed after setup."


def test_the_recheck_refuses_a_damaged_record(
    tmp_path: Path, network: _Network
) -> None:
    cfg = _cfg(tmp_path)
    assert _provision(cfg, _Runner(network))[0]["ok"]
    path = Path(bc.provision_state_path(cfg))
    state = json.loads(path.read_text())
    state["model"]["treeSha256"] = "0" * 64
    path.write_text(json.dumps(state))

    assert bc.provision_state_status(cfg).detail == (
        "The BrainCharts setup state is damaged; set it up again."
    )
    path.write_text("not json")
    assert "unreadable" in bc.provision_state_status(cfg).detail


def test_checks_without_setup_or_output_dir(tmp_path: Path, network: _Network) -> None:
    del network
    checks = _checks(_cfg(tmp_path))
    assert checks["bcenv"].status == "missing"
    assert checks["bcenv"].detail.startswith("BrainCharts is not set up.")
    assert checks["bcmodel"].download_url == bc.BRAINCHARTS_REPOSITORY
    relative = _checks({"paths": {"outputDir": "relative/out"}})
    assert relative["bcmodel"].detail == (
        "Configure paths.outputDir as an absolute path."
    )


# -- Archive bounds --------------------------------------------------------------


def _extract(tmp_path: Path, value: bytes) -> tools.RunResult:
    archive = tmp_path / "model.zip"
    archive.write_bytes(value)
    return bc.extract_model(archive, tmp_path / "models")


@pytest.mark.parametrize(
    ("member", "reason"),
    [
        ("../escape.pkl", "unsafe path"),
        ("/absolute.pkl", "unsafe path"),
        ("other/Models/x.pkl", "outside lifespan_57K_82sites"),
        (f"{bc.MODEL_NAME}/Left-Thalamus-Proper/Other/x.pkl", "unexpected directory"),
        (
            f"{bc.MODEL_NAME}/Left-Thalamus-Proper/Models/run.sh",
            "unexpected file",
        ),
        (f"{bc.MODEL_NAME}/bad name/Models/{bc.MODEL_FILE}", "unexpected model name"),
        (f"{bc.MODEL_NAME}/stray.txt", "stray file"),
    ],
)
def test_extraction_refuses_members_outside_the_layout(
    tmp_path: Path, member: str, reason: str
) -> None:
    result = _extract(
        tmp_path, _model_zip(["Left-Thalamus-Proper"], extra={member: b"x"})
    )
    assert result.rc == 1
    assert reason in result.stderr
    assert not (tmp_path / "models" / bc.MODEL_NAME).exists()


def test_extraction_refuses_links_and_bounds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        info = zipfile.ZipInfo(f"{bc.MODEL_NAME}/x/Models/{bc.MODEL_FILE}")
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(info, "/etc/passwd")
    assert "symbolic link" in _extract(tmp_path, buffer.getvalue()).stderr

    monkeypatch.setattr(bc, "MODEL_MAX_MEMBERS", 3)
    assert "at most 3 are allowed" in _extract(tmp_path, _model_zip(["a"])).stderr
    monkeypatch.setattr(bc, "MODEL_MAX_MEMBERS", 753)
    monkeypatch.setattr(bc, "MODEL_MAX_EXPANDED_BYTES", 10)
    assert "expands beyond 128 MiB" in _extract(tmp_path, _model_zip(["a"])).stderr


def test_model_tree_check_requires_every_listed_region(
    tmp_path: Path, network: _Network
) -> None:
    cfg = _cfg(tmp_path)
    assert _provision(cfg, _Runner(network))[0]["ok"]
    target = Path(bc.model_dir(cfg)) / "Left-Thalamus-Proper" / "Models" / bc.MODEL_FILE
    target.unlink()

    result = bc.check_model_tree(cfg)

    assert result.rc == 1
    assert "no model for 1 regions: Left-Thalamus-Proper" in result.stderr


def test_the_notice_shown_before_download_is_the_pinned_upstream_notice() -> None:
    """The dialog, the notices file, and the module carry the NOTICE verbatim."""
    notice_sha256 = "f6e61c8e51e96c7841ea7008b888cfb96dbf22980d7d31107da6ed7ee82cb78e"
    assert hashlib.sha256(bc.BRAINCHARTS_NOTICE.encode()).hexdigest() == notice_sha256
    source = (
        REPOSITORY_ROOT / "src/renderer/screens/env/braincharts-setup.ts"
    ).read_text(encoding="utf-8")
    block = source.split("export const BRAINCHARTS_NOTICE = [", 1)[1].split("]", 1)[0]
    lines = re.findall(r"'([^']*)'", block)
    assert "\n".join(lines) == bc.BRAINCHARTS_NOTICE
    assert f"  {bc.BRAINCHARTS_CITATION}" not in source  # The citation is one line.
    assert bc.BRAINCHARTS_CITATION in source
    notices = (REPOSITORY_ROOT / "THIRD_PARTY_NOTICES").read_text(encoding="utf-8")
    indented = "\n".join(
        f"  {line}" if line else "" for line in bc.BRAINCHARTS_NOTICE.splitlines()
    )
    assert indented in notices
    license_text = (REPOSITORY_ROOT / "licenses" / "GPL-3.0.txt").read_bytes()
    assert (
        hashlib.sha256(license_text).hexdigest()
        == "6323e4f7949aece19b6ae14e62f0e42a1de8d66e6ace79133e1dfa06ccf9994f"
    )


# -- Generations after a stage run ----------------------------------------------


def _generations(tmp_path: Path) -> tuple[dict[str, Any], Path]:
    cfg = {"paths": {"outputDir": str(tmp_path)}}
    root = Path(bc.provision_root(cfg))
    for name in ("a" * 32, "b" * 32, "c" * 32):
        (root / "generations" / name / "envs").mkdir(parents=True)
    os.symlink(os.path.join("generations", "b" * 32), root / "current")
    return cfg, root


def test_pruning_keeps_only_the_published_generation_and_the_caches(
    tmp_path: Path,
) -> None:
    cfg, root = _generations(tmp_path)
    (root / "pip-cache").mkdir()
    (root / "downloads").mkdir()
    assert bc.prune_superseded_generations(cfg) == ["a" * 32, "c" * 32]
    assert sorted(path.name for path in (root / "generations").iterdir()) == ["b" * 32]
    assert (root / "pip-cache").is_dir()
    assert (root / "downloads").is_dir()


def test_pruning_without_a_published_generation_removes_nothing(tmp_path: Path) -> None:
    cfg, root = _generations(tmp_path)
    (root / "current").unlink()
    assert bc.prune_superseded_generations(cfg) == []
    assert len(list((root / "generations").iterdir())) == 3


def test_the_execution_lease_holds_the_lock_shared_and_rechecks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import fcntl  # noqa: PLC0415

    cfg = {"paths": {"outputDir": str(tmp_path)}}
    state = bc.ProvisionState(True, True, "sha", "sha")
    monkeypatch.setattr(bc, "provision_state_status", lambda _cfg: state)
    lock = Path(bc.provision_root(cfg)) / "provision.lock"
    with bc.execution_lease(cfg):
        descriptor = os.open(lock, os.O_RDWR)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            other = os.open(lock, os.O_RDWR)
            try:
                with pytest.raises(BlockingIOError):
                    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(other)
        finally:
            os.close(descriptor)
    broken = bc.ProvisionState(True, False, "The model files changed.")
    monkeypatch.setattr(bc, "provision_state_status", lambda _cfg: broken)
    with pytest.raises(RuntimeError, match="The model files changed"):
        with bc.execution_lease(cfg):
            pass


def test_a_new_setup_prunes_the_generation_it_replaces(
    tmp_path: Path, network: _Network
) -> None:
    cfg = _cfg(tmp_path)
    assert _provision(cfg, _Runner(network))[0]["ok"]
    root = Path(bc.provision_root(cfg))
    first = (root / "current").resolve().name
    (root / "pip-cache").mkdir(exist_ok=True)
    Path(bc.provision_state_path(cfg)).unlink()

    assert _provision(cfg, _Runner(network))[0]["ok"]

    second = (root / "current").resolve().name
    assert second != first
    assert [path.name for path in (root / "generations").iterdir()] == [second]
    assert (root / "pip-cache").is_dir()
    assert (root / "downloads").is_dir()
