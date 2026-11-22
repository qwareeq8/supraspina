"""The BrainCharts lifespan model and its pcntoolkit runtime, set up on request.

The model, its site and phenotype lists, and the pcntoolkit 0.35 runtime are
GPL-3.0 (the model repository's NOTICE also calls the models public domain);
Supraspina never bundles them. An operator who accepted the license notice starts
:func:`execute_provision`, which downloads the commit-pinned model archive and
lists from GitHub, checks each file's exact size and SHA-256, unpacks the
archive with fixed bounds, builds a CPython 3.12 environment from two committed
locks (a conda explicit lock for CPython and pip, then a hashed pip lock with
CPU-only torch), loads one model in that environment, and publishes everything
as one generation behind an atomic ``current`` link. ``provision-state.json``
records a digest over every part; :func:`provision_state_status` rechecks it
for Diagnostics and the ``bcenv`` and ``bcmodel`` environment checks. A stage
run holds the setup lock shared (:func:`execution_lease`); a setup holds it
exclusively and, once it has published, removes every superseded generation,
keeping the pip cache and the checked downloads.

This module lives outside ``adapters/`` so a change here never alters the
stage adapter's receipt identity; the runtime reaches receipts only through
the environment checks. The layout below ``${paths.outputDir}/.braincharts``
mirrors PyBrainAge's (``adapters/pybrainage.py``), whose shared helpers are
reused unchanged.
"""

from __future__ import annotations

import copy
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import sys
import tempfile
import time
import uuid
import zipfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .adapters import tools
from .adapters.pybrainage import (
    MICROMAMBA_SHA256,
    MICROMAMBA_VERSION,
    _atomic_write,
    _canonical_json,
    _controlled_environment,
    _fsync_directory,
    _sha256_regular,
    micromamba_binary,
    micromamba_identity,
    probe_micromamba_version,
)
from .paths import flatten, interpolate

# -- Pins (verified against the upstream repository on 2026-09-30) ------------


@dataclass(frozen=True)
class PinnedFile:
    """One commit-pinned upstream file with its exact size and SHA-256."""

    path: str
    byte_size: int
    sha256: str

    @property
    def name(self) -> str:
        """Return the file name the store keeps it under."""
        return PurePosixPath(self.path).name

    @property
    def url(self) -> str:
        """Return the commit-pinned download URL."""
        return f"{BRAINCHARTS_RAW_BASE}/{self.path}"


BRAINCHARTS_REPOSITORY = (
    "https://github.com/predictive-clinical-neuroscience/braincharts"
)
#: The repository commit that pins every download. It updated the notebooks to
#: pcntoolkit 0.35; the model archive is unchanged since 565f4ff (2022-02-26).
BRAINCHARTS_COMMIT = "5a1a7822e6f54405b0a826cf137d584240af307c"
BRAINCHARTS_RAW_BASE = (
    "https://raw.githubusercontent.com/predictive-clinical-neuroscience/"
    f"braincharts/{BRAINCHARTS_COMMIT}"
)
BRAINCHARTS_LICENSE = "GPL-3.0"
BRAINCHARTS_CITATION = (
    "Rutherford S, Fraza C, Dinga R, et al. Charting brain growth and aging at "
    "high spatial precision. eLife. 2022;11:e72904. doi:10.7554/eLife.72904"
)
#: The repository NOTICE, verbatim; the license dialog shows the same text.
BRAINCHARTS_NOTICE = (
    "braincharts\n"
    "Copyright 2021 The braincharts Developers.\n"
    "\n"
    "This product includes software developed by\n"
    "Saige Rutherford and Andre Marquand.\n"
    "\n"
    "This software redistributes pretrained normative models\n"
    "and code for applying them to new data, which is Public\n"
    "domain source code."
)

MODEL_NAME = "lifespan_57K_82sites"
#: The model archive, a plain git blob (e3a6c546a1fe689be70925a2bc71f0011fbecc7c).
MODEL_ARCHIVE = PinnedFile(
    path=f"models/{MODEL_NAME}.zip",
    byte_size=2_796_655,
    sha256="60457279debb787ea2ce4175191bd2ac16214e84bd260c7dab3d8bf2f1095cc4",
)
SITE_LIST = PinnedFile(
    path="docs/site_ids_ct_82sites.txt",
    byte_size=675,
    sha256="854132b6c44adec3cab6d371179c3a9336800fa257e615907c95c49643d6005c",
)
PHENOTYPE_LISTS: tuple[PinnedFile, ...] = (
    PinnedFile(
        path="docs/phenotypes_ct_lh.txt",
        byte_size=2_294,
        sha256="01f5aaaec1b5a0fa28f955c38e59b20e0b7495423f9f110e2b0552f413f5ba96",
    ),
    PinnedFile(
        path="docs/phenotypes_ct_rh.txt",
        byte_size=2_294,
        sha256="169718a054cbc6ef4d132fefbf4bc40413ae1f2b7c3732b0a2d9996df64c2959",
    ),
    PinnedFile(
        path="docs/phenotypes_sc.txt",
        byte_size=662,
        sha256="6859e76a49231a1b3d2b47d424e65e01f164bddc05981d18d2145240f2f155f5",
    ),
)
MODEL_LISTS: tuple[PinnedFile, ...] = (SITE_LIST, *PHENOTYPE_LISTS)
#: The site list's training sites and the phenotype lists' union (187 names,
#: equal to ``resources/features/rois_input_template.txt``).
SITE_COUNT = 82
PHENOTYPE_COUNT = 187
#: The archive holds 753 members (377 directories) expanding to 127,023,760
#: bytes; these bounds refuse anything larger even though the digest is pinned.
MODEL_MAX_MEMBERS = 753
MODEL_MAX_EXPANDED_BYTES = 128 * 1024 * 1024
MODEL_EXPANDED_BYTES = 127_023_760
MODEL_FILE = "NM_0_0_estimate.pkl"
_MODEL_MEMBER_FILES = frozenset({"meta_data.md", MODEL_FILE})
#: Archive paths are ``<model>/<phenotype>/Models/<file>``.
_PHENOTYPE_DEPTH = 1
_FILE_DEPTH = 4
_MAX_MEMBER_RATIO = 200
_PHENOTYPE_NAME = re.compile(r"^[A-Za-z0-9_&.+-]{1,128}$")

PYTHON_VERSION = "3.12.14"
PCNTOOLKIT_VERSION = "0.35.0"
#: The two package indexes; the locks carry no index line, so pip's command
#: line names both (an index line in a requirements file would replace them).
PYPI_INDEX = "https://pypi.org/simple"
PYTORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu"
#: Distributions without wheels; pip builds them from their hashed sdists with
#: the locked setuptools instead of an unlocked isolated build environment.
SOURCE_BUILD_DISTRIBUTIONS: tuple[str, ...] = ("bspline",)
#: The exact runtime versions both locks install, rechecked after every setup.
RUNTIME_VERSIONS: dict[str, str] = {
    "python": PYTHON_VERSION,
    "pcntoolkit": PCNTOOLKIT_VERSION,
    "bspline": "0.1.1",
    "numba": "0.60.0",
    "numpy": "2.0.2",
    "nutpie": "0.13.4",
    "pandas": "2.3.3",
    "pymc": "5.28.5",
    "scikit-learn": "1.9.1",
    "scipy": "1.18.1",
    "setuptools": "84.0.0",
    "torch": "2.14.1+cpu",
    "pip": "26.2.1",
}

ENV_LOCK_NAME = "braincharts-linux-64.lock"
PIP_LOCK_NAME = "braincharts-requirements.txt"
ENV_LOCK_SHA256 = "79687e68c71297e5f99dd017094410fbb51a685fdd9375042830df396bb6281f"
PIP_LOCK_SHA256 = "706e6388676d5215496594659120f92774a2f0add123742a6f9021a61161e5ce"

_GENERATION_KEY = "_supraspinaBrainChartsGenerationRoot"
_GENERATION_NAME_LENGTH = 32
_STATE_VERSION = 1
_MAX_STATE_BYTES = 64 * 1024
_MAX_LOCK_BYTES = 256 * 1024
_MAX_LIST_BYTES = 64 * 1024
_MAX_METADATA_ENTRIES = 1_024
_MAX_RECORD_BYTES = 16 * 1024 * 1024
_MAX_MODEL_FILE_BYTES = 16 * 1024 * 1024
_MIN_FREE_BYTES = 4 * 1024 * 1024 * 1024
_HASH_CHUNK = 1024 * 1024
_UNSUPPORTED_PLATFORM = "The BrainCharts runtime is available on Linux x86_64 only."

_RUNTIME_PROBE_SCRIPT = (
    "import json, sys\n"
    "from importlib import metadata\n"
    "names = " + repr(sorted(set(RUNTIME_VERSIONS) - {"python"})) + "\n"
    "versions = {name: metadata.version(name) for name in names}\n"
    "versions['python'] = '.'.join(map(str, sys.version_info[:3]))\n"
    "print(json.dumps(versions, sort_keys=True))\n"
)

#: Unpickle one model with pcntoolkit to prove the runtime can read the store.
#: The 0.x pickles name the ``norm_blr`` module pcntoolkit puts on its own path,
#: so the check reads the class name and the BLR estimator it wraps.
_MODEL_PROBE_SCRIPT = (
    "import pickle, sys\n"
    "import pcntoolkit.normative\n"
    "with open(sys.argv[1], 'rb') as handle:\n"
    "    model = pickle.load(handle)\n"
    "blr = getattr(model, 'blr', None)\n"
    "kind = f'{type(blr).__module__}.{type(blr).__name__}'\n"
    "if type(model).__name__ != 'NormBLR' or kind != "
    "'pcntoolkit.model.bayesreg.BLR':\n"
    "    raise SystemExit(f'The model is a {type(model).__name__} holding {kind}.')\n"
    "print(f'Loaded a NormBLR model holding {kind}.')\n"
)


# -- Paths -----------------------------------------------------------------------


def provision_root(cfg: dict[str, Any]) -> str:
    """Return ``${paths.outputDir}/.braincharts``, the app-owned root."""
    output = interpolate("${paths.outputDir}", flatten(cfg))
    if not output or "${" in output or not os.path.isabs(output):
        raise ValueError("Configure paths.outputDir as an absolute path.")
    return os.path.join(output, ".braincharts")


def _generation_root(cfg: dict[str, Any]) -> str:
    staged = cfg.get(_GENERATION_KEY)
    if isinstance(staged, str) and staged:
        return staged
    return os.path.join(provision_root(cfg), "current")


def env_dir(cfg: dict[str, Any]) -> str:
    """Return the BrainCharts environment prefix in the current generation."""
    return os.path.join(_generation_root(cfg), "envs", "braincharts")


def env_python(cfg: dict[str, Any]) -> str:
    """Return the environment's CPython 3.12 interpreter."""
    return os.path.join(env_dir(cfg), "bin", "python")


def models_root(cfg: dict[str, Any]) -> str:
    """Return the directory that holds the archive, the tree, and the lists."""
    return os.path.join(_generation_root(cfg), "models")


def model_dir(cfg: dict[str, Any]) -> str:
    """Return the unpacked ``lifespan_57K_82sites`` model tree."""
    return os.path.join(models_root(cfg), MODEL_NAME)


def archive_path(cfg: dict[str, Any]) -> str:
    """Return the verified model archive kept beside the tree."""
    return os.path.join(models_root(cfg), MODEL_ARCHIVE.name)


def list_path(cfg: dict[str, Any], pinned: PinnedFile) -> str:
    """Return one verified site or phenotype list."""
    return os.path.join(models_root(cfg), "docs", pinned.name)


def _locks_dir(cfg: dict[str, Any]) -> str:
    return os.path.join(provision_root(cfg), "locks")


def environment_lock_path(cfg: dict[str, Any]) -> str:
    """Return the materialized conda explicit lock."""
    return os.path.join(_locks_dir(cfg), ENV_LOCK_NAME)


def pip_lock_path(cfg: dict[str, Any]) -> str:
    """Return the materialized hashed pip lock for wheels."""
    return os.path.join(_locks_dir(cfg), PIP_LOCK_NAME)


def source_lock_path(cfg: dict[str, Any]) -> str:
    """Return the materialized hashed pip lock for the sdist-only packages."""
    return os.path.join(_locks_dir(cfg), "braincharts-source-requirements.txt")


def provision_state_path(cfg: dict[str, Any]) -> str:
    """Return the digest-bound record of the published generation."""
    return os.path.join(provision_root(cfg), "provision-state.json")


def log_dir(cfg: dict[str, Any]) -> str:
    """Return the directory for provisioning operation logs."""
    return os.path.join(provision_root(cfg), "logs")


def cache_root(cfg: dict[str, Any]) -> str:
    """Return the app-owned cache root the runtime writes instead of ``~``."""
    return os.path.join(provision_root(cfg), "cache")


def runtime_environment(root: str) -> dict[str, str]:
    """Return isolated package, cache, and thread settings below ``root``.

    arviz, pytensor, matplotlib, and numba otherwise write under ``~/.cache``.
    """
    environment = _controlled_environment(root)
    caches = os.path.join(root, "cache")
    environment.update(
        {
            "MPLCONFIGDIR": os.path.join(caches, "matplotlib"),
            "NUMBA_CACHE_DIR": os.path.join(caches, "numba"),
            "PYTENSOR_FLAGS": f"base_compiledir={os.path.join(caches, 'pytensor')}",
            "OMP_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
            "OPENBLAS_NUM_THREADS": "1",
        }
    )
    return environment


def platform_supported() -> bool:
    """Report whether this host can run the Linux x86_64 locks."""
    machine = platform.machine().lower()
    return sys.platform.startswith("linux") and machine in {"x86_64", "amd64"}


def unsupported_platform_detail() -> str:
    """Return the sentence shown where the runtime cannot run."""
    return _UNSUPPORTED_PLATFORM


# -- Locks ---------------------------------------------------------------------


def lock_source_dir() -> Path:
    """Return the committed locks in the source and frozen sidecar layouts."""
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
        return base / "braincharts-locks"
    return Path(__file__).resolve().parent / "braincharts_locks"


def read_pinned_lock(name: str, expected_sha256: str) -> bytes:
    """Read one bounded committed lock and require its compiled-in digest."""
    path = lock_source_dir() / name
    try:
        if (
            path.is_symlink()
            or not path.is_file()
            or path.stat().st_size > _MAX_LOCK_BYTES
        ):
            raise ValueError("Provide the lock as a bounded regular file.")
        value = path.read_bytes()
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"The reviewed BrainCharts lock {name} is missing.") from exc
    if hashlib.sha256(value).hexdigest() != expected_sha256:
        raise RuntimeError(f"The BrainCharts lock {name} differs from its pin.")
    return value


def split_pip_lock(value: bytes) -> tuple[bytes, bytes]:
    """Split the pip lock into its wheel requirements and its sdist ones.

    The wheels install first; the sdists then build with the setuptools the
    first pass left in place, so no build step fetches an unlocked package.
    """
    text = value.decode("utf-8")
    options: list[str] = []
    blocks: list[list[str]] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("--") and not line.startswith(" "):
            options.append(stripped)
            continue
        if not line.startswith((" ", "\t")):
            blocks.append([line])
        elif blocks:
            blocks[-1].append(line)
    wheels: list[str] = list(options)
    sources: list[str] = list(options)
    found: set[str] = set()
    for block in blocks:
        name = re.split(r"[=<>!~ ;\\]", block[0].strip(), maxsplit=1)[0].lower()
        if not any("--hash=sha256:" in line for line in block):
            raise RuntimeError(f"The BrainCharts pip lock leaves {name} unhashed.")
        if name in SOURCE_BUILD_DISTRIBUTIONS:
            sources.extend(block)
            found.add(name)
        else:
            wheels.extend(block)
    if found != set(SOURCE_BUILD_DISTRIBUTIONS):
        raise RuntimeError("The BrainCharts pip lock lacks its source packages.")
    return (
        ("\n".join(wheels) + "\n").encode("utf-8"),
        ("\n".join(sources) + "\n").encode("utf-8"),
    )


def prepare_provision_storage(cfg: dict[str, Any]) -> None:
    """Create the app-owned roots and materialize the verified locks."""
    if not platform_supported():
        raise RuntimeError(_UNSUPPORTED_PLATFORM)
    environment_lock = read_pinned_lock(ENV_LOCK_NAME, ENV_LOCK_SHA256)
    pip_lock = read_pinned_lock(PIP_LOCK_NAME, PIP_LOCK_SHA256)
    if not environment_lock.startswith(b"@EXPLICIT\n"):
        raise RuntimeError("The BrainCharts conda lock is not an explicit lock.")
    if f"pcntoolkit=={PCNTOOLKIT_VERSION}".encode() not in pip_lock:
        raise RuntimeError(
            f"The BrainCharts pip lock lacks pcntoolkit {PCNTOOLKIT_VERSION}."
        )
    wheels, sources = split_pip_lock(pip_lock)
    root = provision_root(cfg)
    for path in (
        root,
        os.path.join(root, "mamba-root"),
        os.path.join(root, "mamba-root", "pkgs"),
        os.path.join(root, "pip-cache"),
        cache_root(cfg),
        os.path.join(root, "downloads"),
        _locks_dir(cfg),
    ):
        Path(path).mkdir(parents=True, exist_ok=True, mode=0o700)
    for target, value in (
        (Path(environment_lock_path(cfg)), environment_lock),
        (Path(pip_lock_path(cfg)), wheels),
        (Path(source_lock_path(cfg)), sources),
    ):
        try:
            if (
                target.is_file()
                and not target.is_symlink()
                and target.read_bytes() == value
            ):
                continue
        except OSError:
            pass
        _atomic_write(target, value)


# -- Commands --------------------------------------------------------------------


def create_env_command(cfg: dict[str, Any], micromamba: str) -> list[str]:
    """Build the explicit-lock environment creation (CPython 3.12 and pip)."""
    return [
        micromamba,
        "create",
        "-y",
        "--root-prefix",
        os.path.join(provision_root(cfg), "mamba-root"),
        "-p",
        env_dir(cfg),
        "--file",
        environment_lock_path(cfg),
    ]


def _pip_install_base(cfg: dict[str, Any]) -> list[str]:
    return [
        env_python(cfg),
        "-I",
        "-m",
        "pip",
        "--isolated",
        "--disable-pip-version-check",
        "--no-input",
        "install",
        "--require-hashes",
        "--no-deps",
        "--no-build-isolation",
        "--index-url",
        PYPI_INDEX,
        "--extra-index-url",
        PYTORCH_CPU_INDEX,
        "--cache-dir",
        os.path.join(provision_root(cfg), "pip-cache"),
    ]


def pip_wheels_command(cfg: dict[str, Any]) -> list[str]:
    """Build the hash-required, wheel-only install of the pip lock."""
    return [
        *_pip_install_base(cfg),
        "--only-binary=:all:",
        "--requirement",
        pip_lock_path(cfg),
    ]


def pip_sources_command(cfg: dict[str, Any]) -> list[str]:
    """Build the hash-required build of the sdist-only packages."""
    return [
        *_pip_install_base(cfg),
        "--no-binary=" + ",".join(SOURCE_BUILD_DISTRIBUTIONS),
        "--requirement",
        source_lock_path(cfg),
    ]


def runtime_probe_command(cfg: dict[str, Any]) -> list[str]:
    """Build the exact-version probe run in the environment."""
    return [env_python(cfg), "-I", "-B", "-c", _RUNTIME_PROBE_SCRIPT]


def model_probe_command(cfg: dict[str, Any], model_file: str) -> list[str]:
    """Build the probe that unpickles one model with pcntoolkit."""
    return [env_python(cfg), "-I", "-B", "-c", _MODEL_PROBE_SCRIPT, model_file]


def fetch_command(pinned: PinnedFile, target: str) -> list[str]:
    """Build the HTTPS-only, size-capped, resumable download of one pinned file."""
    return [
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--tlsv1.2",
        "--retry",
        "2",
        "--max-filesize",
        str(pinned.byte_size),
        "--continue-at",
        "-",
        "--output",
        target,
        pinned.url,
    ]


def parse_runtime_versions(result: tools.RunResult) -> dict[str, str]:
    """Parse one runtime version probe, or return an empty mapping."""
    if result.rc != 0:
        return {}
    for line in reversed(result.stdout.strip().splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and all(
            isinstance(key, str) and isinstance(item, str)
            for key, item in value.items()
        ):
            return value
        return {}
    return {}


def runtime_version_mismatches(versions: dict[str, str]) -> list[str]:
    """Return every missing or wrong runtime version."""
    return [
        f"{name} {versions.get(name, 'missing')} (expected {expected})"
        for name, expected in RUNTIME_VERSIONS.items()
        if versions.get(name) != expected
    ]


# -- Verification --------------------------------------------------------------


def verify_pinned_file(
    path: str | Path,
    pinned: PinnedFile,
    cancelled: Callable[[], bool] | None = None,
) -> tools.RunResult:
    """Check one downloaded file's exact size and SHA-256."""
    candidate = Path(path)
    try:
        if candidate.is_symlink() or not candidate.is_file():
            return tools.RunResult(
                rc=1, stdout="", stderr=f"The download of {pinned.name} is missing."
            )
        size = candidate.stat().st_size
        if size != pinned.byte_size:
            return tools.RunResult(
                rc=1,
                stdout="",
                stderr=(
                    f"{pinned.name} is {size:,} bytes; the pinned file is "
                    f"{pinned.byte_size:,} bytes."
                ),
            )
        digest = hashlib.sha256()
        with candidate.open("rb") as handle:
            while chunk := handle.read(_HASH_CHUNK):
                if cancelled is not None and cancelled():
                    return tools.RunResult(rc=130, stdout="", stderr="cancelled")
                digest.update(chunk)
    except OSError as exc:
        return tools.RunResult(
            rc=1, stdout="", stderr=f"{pinned.name} could not be read: {exc}"
        )
    if digest.hexdigest() != pinned.sha256:
        return tools.RunResult(
            rc=1,
            stdout="",
            stderr=f"{pinned.name} does not match its pinned SHA-256.",
        )
    return tools.RunResult(
        rc=0, stdout=f"{pinned.name} matches its pinned size and SHA-256.", stderr=""
    )


def _safe_member_parts(name: str) -> tuple[str, ...]:
    """Return the path parts of an allowed archive member, or raise."""
    path = PurePosixPath(name)
    if (
        not name
        or "\\" in name
        or "\x00" in name
        or path.is_absolute()
        or ".." in path.parts
        or "." in path.parts
    ):
        raise ValueError(f"The archive holds an unsafe path: {name!r}.")
    parts = path.parts
    if not parts or parts[0] != MODEL_NAME:
        raise ValueError(f"The archive holds a path outside {MODEL_NAME}: {name!r}.")
    depth = len(parts)
    if depth > _PHENOTYPE_DEPTH and _PHENOTYPE_NAME.fullmatch(parts[1]) is None:
        raise ValueError(f"The archive holds an unexpected model name: {name!r}.")
    if depth > _PHENOTYPE_DEPTH + 1 and parts[2] != "Models":
        raise ValueError(f"The archive holds an unexpected directory: {name!r}.")
    if depth == _FILE_DEPTH and parts[3] not in _MODEL_MEMBER_FILES:
        raise ValueError(f"The archive holds an unexpected file: {name!r}.")
    if depth > _FILE_DEPTH:
        raise ValueError(f"The archive nests too deeply: {name!r}.")
    return parts


def extract_model(  # noqa: PLR0912, PLR0915
    archive: str | Path,
    destination_root: str | Path,
    cancelled: Callable[[], bool] | None = None,
) -> tools.RunResult:
    """Unpack the verified archive into ``destination_root/lifespan_57K_82sites``.

    Refuse links, encrypted members, absolute or ``..`` paths, anything outside
    the ``<model>/<phenotype>/Models/{meta_data.md,NM_0_0_estimate.pkl}``
    layout, more than 753 members, and more than 128 MiB expanded.
    """
    root = Path(destination_root)
    target = root / MODEL_NAME
    try:
        with zipfile.ZipFile(archive) as handle:
            members = handle.infolist()
            if len(members) > MODEL_MAX_MEMBERS:
                raise ValueError(
                    f"The archive holds {len(members)} members; at most "
                    f"{MODEL_MAX_MEMBERS} are allowed."
                )
            expanded = 0
            files: list[tuple[zipfile.ZipInfo, tuple[str, ...]]] = []
            seen: set[str] = set()
            for member in members:
                parts = _safe_member_parts(member.filename)
                mode = member.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise ValueError("The archive holds a symbolic link.")
                if member.flag_bits & 0x1:
                    raise ValueError("The archive holds an encrypted member.")
                normalized = "/".join(parts)
                if normalized in seen:
                    raise ValueError(f"The archive repeats {normalized}.")
                seen.add(normalized)
                if member.is_dir():
                    continue
                if len(parts) != _FILE_DEPTH:
                    raise ValueError(f"The archive holds a stray file: {normalized}.")
                expanded += member.file_size
                if (
                    member.file_size > _MAX_MODEL_FILE_BYTES
                    or expanded > MODEL_MAX_EXPANDED_BYTES
                ):
                    raise ValueError("The archive expands beyond 128 MiB.")
                if (member.file_size and member.compress_size == 0) or (
                    member.compress_size
                    and member.file_size / member.compress_size > _MAX_MEMBER_RATIO
                ):
                    raise ValueError("The archive holds an over-compressed member.")
                files.append((member, parts))
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            staging = Path(tempfile.mkdtemp(prefix=".extract-", dir=root))
            try:
                for member, parts in files:
                    if cancelled is not None and cancelled():
                        return tools.RunResult(rc=130, stdout="", stderr="cancelled")
                    output = staging.joinpath(*parts)
                    output.parent.mkdir(parents=True, exist_ok=True)
                    written = 0
                    with handle.open(member) as source, open(output, "xb") as sink:
                        while chunk := source.read(_HASH_CHUNK):
                            written += len(chunk)
                            if written > member.file_size:
                                raise ValueError(
                                    "An archive member expands past its size."
                                )
                            sink.write(chunk)
                        sink.flush()
                        os.fsync(sink.fileno())
                    output.chmod(0o444)
                if target.exists() or target.is_symlink():
                    raise ValueError(f"{target} already exists.")
                os.replace(staging / MODEL_NAME, target)
                _fsync_directory(root)
            finally:
                shutil.rmtree(staging, ignore_errors=True)
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as exc:
        return tools.RunResult(
            rc=1,
            stdout="",
            stderr=f"The model archive could not be unpacked: {str(exc).rstrip('.')}.",
        )
    return tools.RunResult(
        rc=0, stdout=f"Unpacked {len(files)} model files into {target}.", stderr=""
    )


def read_list(path: str | Path) -> list[str]:
    """Read one site or phenotype list as its non-empty lines."""
    candidate = Path(path)
    if candidate.is_symlink() or not candidate.is_file():
        raise OSError(f"{candidate.name} is missing.")
    if candidate.stat().st_size > _MAX_LIST_BYTES:
        raise OSError(f"{candidate.name} exceeds its size bound.")
    return [
        line.strip()
        for line in candidate.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def phenotype_names(cfg: dict[str, Any]) -> list[str]:
    """Return the union of the three phenotype lists, in list order."""
    names: list[str] = []
    for pinned in PHENOTYPE_LISTS:
        for name in read_list(list_path(cfg, pinned)):
            if name not in names:
                names.append(name)
    return names


def check_model_tree(cfg: dict[str, Any]) -> tools.RunResult:
    """Require 82 sites and one model file for each of the 187 phenotypes."""
    try:
        sites = read_list(list_path(cfg, SITE_LIST))
        names = phenotype_names(cfg)
    except (OSError, UnicodeError) as exc:
        return tools.RunResult(
            rc=1, stdout="", stderr=f"The model lists could not be read: {exc}"
        )
    if len(sites) != SITE_COUNT or len(set(sites)) != SITE_COUNT:
        return tools.RunResult(
            rc=1,
            stdout="",
            stderr=f"The site list names {len(sites)} sites; {SITE_COUNT} expected.",
        )
    if len(names) != PHENOTYPE_COUNT:
        return tools.RunResult(
            rc=1,
            stdout="",
            stderr=(
                f"The phenotype lists name {len(names)} regions; "
                f"{PHENOTYPE_COUNT} expected."
            ),
        )
    root = Path(model_dir(cfg))
    missing = [
        name
        for name in names
        if _PHENOTYPE_NAME.fullmatch(name) is None
        or not (root / name / "Models" / MODEL_FILE).is_file()
    ]
    if missing:
        shown = ", ".join(missing[:5])
        return tools.RunResult(
            rc=1,
            stdout="",
            stderr=f"The model tree has no model for {len(missing)} regions: {shown}.",
        )
    return tools.RunResult(
        rc=0,
        stdout=(
            f"The model covers all {PHENOTYPE_COUNT} regions and {SITE_COUNT} sites."
        ),
        stderr="",
    )


# -- Digests and provision state --------------------------------------------------

#: Per-process digest cache keyed by each file's stat identity (inode, size,
#: and change time), so repeated environment checks rehash only what changed.
_DIGEST_CACHE: dict[tuple[str, int, int, int], str] = {}


def _cached_file_digest(path: Path, maximum_bytes: int) -> str:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise OSError(f"Provide a regular file: {path.name}.")
    key = (str(path), info.st_ino, info.st_size, info.st_ctime_ns)
    cached = _DIGEST_CACHE.get(key)
    if cached is not None:
        return cached
    digest = _sha256_regular(path, maximum_bytes)
    if len(_DIGEST_CACHE) > 8_192:  # noqa: PLR2004
        _DIGEST_CACHE.clear()
    _DIGEST_CACHE[key] = digest
    return digest


def tree_digest(root: str | Path) -> str:
    """Digest every file below one model tree by relative path and SHA-256."""
    base = Path(root)
    if base.is_symlink() or not base.is_dir():
        raise OSError(f"{base.name} is not a directory.")
    entries: list[tuple[str, Path]] = []
    for directory, subdirectories, filenames in os.walk(base):
        subdirectories.sort()
        for filename in filenames:
            path = Path(directory) / filename
            if path.is_symlink():
                raise OSError(f"{filename} is a symbolic link.")
            entries.append((path.relative_to(base).as_posix(), path))
            if len(entries) > MODEL_MAX_MEMBERS:
                raise OSError("The model tree holds more files than the archive.")
    digest = hashlib.sha256()
    for relative, path in sorted(entries):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(_cached_file_digest(path, _MAX_MODEL_FILE_BYTES).encode())
        digest.update(b"\n")
    return digest.hexdigest()


def _metadata_digest(directory: Path, *, suffix: str, files: tuple[str, ...]) -> str:
    """Digest the ``*suffix`` entries of one package-metadata directory.

    With ``files`` empty each entry is a file digested whole; otherwise each
    entry is a directory whose named files are digested when present.
    """
    if directory.is_symlink() or not directory.is_dir():
        raise OSError(f"{directory.name} is missing.")
    entries: list[Path] = []
    with os.scandir(directory) as scan:
        for index, entry in enumerate(scan):
            if index >= _MAX_METADATA_ENTRIES:
                raise OSError(f"{directory.name} exceeds its entry limit.")
            if entry.name.endswith(suffix):
                entries.append(Path(entry.path))
    if not entries:
        raise OSError(f"{directory.name} lists no installed packages.")
    digest = hashlib.sha256()
    for entry in sorted(entries, key=lambda item: item.name):
        digest.update(entry.name.encode("utf-8"))
        members = [entry] if not files else [entry / name for name in files]
        for member in members:
            if files and not member.exists():
                continue
            digest.update(b"\0" + member.name.encode("utf-8") + b"\0")
            digest.update(_cached_file_digest(member, _MAX_RECORD_BYTES).encode())
        digest.update(b"\n")
    return digest.hexdigest()


def conda_metadata_digest(cfg: dict[str, Any]) -> str:
    """Bind every installed conda record by name and content."""
    return _metadata_digest(Path(env_dir(cfg)) / "conda-meta", suffix=".json", files=())


def site_packages_digest(cfg: dict[str, Any]) -> str:
    """Bind every installed distribution's METADATA and RECORD."""
    site_packages = Path(env_dir(cfg)) / "lib" / "python3.12" / "site-packages"
    return _metadata_digest(
        site_packages, suffix=".dist-info", files=("METADATA", "RECORD")
    )


def _model_state(cfg: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": MODEL_NAME,
        "commit": BRAINCHARTS_COMMIT,
        "archiveSha256": _cached_file_digest(
            Path(archive_path(cfg)), MODEL_ARCHIVE.byte_size
        ),
        "treeSha256": tree_digest(model_dir(cfg)),
        "lists": {
            pinned.name: _cached_file_digest(
                Path(list_path(cfg, pinned)), pinned.byte_size
            )
            for pinned in MODEL_LISTS
        },
    }


def _environment_state(cfg: dict[str, Any], versions: dict[str, str]) -> dict[str, Any]:
    ordered = dict(sorted(versions.items()))
    return {
        "condaLockSha256": ENV_LOCK_SHA256,
        "pipLockSha256": PIP_LOCK_SHA256,
        "condaMetadataSha256": conda_metadata_digest(cfg),
        "sitePackagesSha256": site_packages_digest(cfg),
        "runtimeVersions": ordered,
    }


def _current_generation(cfg: dict[str, Any]) -> Path:
    """Resolve the single-level ``current`` link below the owned root."""
    root = Path(provision_root(cfg))
    current = root / "current"
    generations = root / "generations"
    if not current.is_symlink():
        raise OSError("No BrainCharts generation is published.")
    target = Path(os.readlink(current))
    if target.is_absolute() or ".." in target.parts:
        raise OSError("The current BrainCharts link leaves its root.")
    candidate = root / target
    if candidate.is_symlink() or candidate.parent != generations:
        raise OSError("The current BrainCharts link is not a generation.")
    resolved = candidate.resolve(strict=True)
    if resolved.parent != generations.resolve(strict=True) or not resolved.is_dir():
        raise OSError("The current BrainCharts link is not a generation.")
    return resolved


def record_provision_state(
    cfg: dict[str, Any], versions: dict[str, str], *, micromamba: str
) -> tools.RunResult:
    """Persist the digest-bound record of the generation ``cfg`` names."""
    mismatches = runtime_version_mismatches(versions)
    if mismatches:
        return tools.RunResult(rc=1, stdout="", stderr="; ".join(mismatches))
    try:
        generation = Path(_generation_root(cfg))
        if generation.name == "current":
            generation = _current_generation(cfg)
        if (
            generation.parent != Path(provision_root(cfg)) / "generations"
            or generation.is_symlink()
        ):
            raise ValueError("The generation is not below the BrainCharts root.")
        _selected, micromamba_sha256 = micromamba_identity(micromamba)
        if micromamba_sha256 != MICROMAMBA_SHA256:
            raise ValueError("micromamba does not match its reviewed SHA-256.")
        state: dict[str, Any] = {
            "schemaVersion": _STATE_VERSION,
            "platform": "linux-64",
            "generation": generation.name,
            "micromamba": {"version": MICROMAMBA_VERSION, "sha256": micromamba_sha256},
            "environment": _environment_state(cfg, versions),
            "model": _model_state(cfg),
        }
    except (KeyError, OSError, ValueError) as exc:
        return tools.RunResult(
            rc=1, stdout="", stderr=f"The setup state could not be recorded: {exc}"
        )
    state["provenanceSha256"] = hashlib.sha256(_canonical_json(state)).hexdigest()
    payload = _canonical_json(state) + b"\n"
    if len(payload) > _MAX_STATE_BYTES:
        return tools.RunResult(
            rc=1, stdout="", stderr="The setup state exceeds its size bound."
        )
    try:
        _atomic_write(Path(provision_state_path(cfg)), payload)
    except OSError as exc:
        return tools.RunResult(
            rc=1, stdout="", stderr=f"The setup state could not be written: {exc}"
        )
    return tools.RunResult(
        rc=0,
        stdout=f"Recorded BrainCharts provenance {state['provenanceSha256']}.",
        stderr="",
    )


@dataclass(frozen=True)
class ProvisionState:
    """The recheck of ``provision-state.json`` against the published files.

    ``environment_ok`` and ``model_ok`` report the two halves separately so
    ``bcenv`` and ``bcmodel`` can each name what is wrong; ``detail`` states
    the first problem, or carries the provenance digest when both hold.
    """

    environment_ok: bool
    model_ok: bool
    detail: str
    provenance: str | None = None
    #: True when no setup was ever recorded, as opposed to a damaged one.
    missing: bool = False


def _read_state(cfg: dict[str, Any]) -> dict[str, Any] | None:
    path = Path(provision_state_path(cfg))
    if path.is_symlink() or not path.is_file():
        return None
    if path.stat().st_size > _MAX_STATE_BYTES:
        raise ValueError("The setup state exceeds its size bound.")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("The setup state is not an object.")
    return value


def provision_state_status(  # noqa: PLR0911, PLR0912
    cfg: dict[str, Any],
) -> ProvisionState:
    """Recheck the recorded state against every published artifact."""
    if not platform_supported():
        return ProvisionState(False, False, _UNSUPPORTED_PLATFORM)
    try:
        state = _read_state(cfg)
    except (OSError, UnicodeError, ValueError):
        return ProvisionState(
            False, False, "The BrainCharts setup state is unreadable; set it up again."
        )
    if state is None:
        return ProvisionState(False, False, "BrainCharts is not set up.", missing=True)
    recorded = state.get("provenanceSha256")
    body = {key: value for key, value in state.items() if key != "provenanceSha256"}
    if (
        state.get("schemaVersion") != _STATE_VERSION
        or state.get("platform") != "linux-64"
        or not isinstance(recorded, str)
        or recorded != hashlib.sha256(_canonical_json(body)).hexdigest()
    ):
        return ProvisionState(
            False, False, "The BrainCharts setup state is damaged; set it up again."
        )
    environment = state.get("environment")
    model = state.get("model")
    micromamba_state = state.get("micromamba")
    generation = state.get("generation")
    if (
        not isinstance(environment, dict)
        or not isinstance(model, dict)
        or not isinstance(micromamba_state, dict)
        or not isinstance(generation, str)
        or len(generation) != _GENERATION_NAME_LENGTH
    ):
        return ProvisionState(
            False, False, "The BrainCharts setup state is damaged; set it up again."
        )
    try:
        if _current_generation(cfg).name != generation:
            return ProvisionState(
                False,
                False,
                "The published BrainCharts generation differs from its record.",
            )
    except OSError as exc:
        return ProvisionState(False, False, str(exc))

    environment_problem: str | None = None
    versions = environment.get("runtimeVersions")
    if (
        environment.get("condaLockSha256") != ENV_LOCK_SHA256
        or environment.get("pipLockSha256") != PIP_LOCK_SHA256
    ):
        environment_problem = "The BrainCharts runtime was built from other locks."
    elif not isinstance(versions, dict) or runtime_version_mismatches(versions):
        environment_problem = "The BrainCharts runtime versions differ from the locks."
    elif (
        micromamba_state.get("version") != MICROMAMBA_VERSION
        or micromamba_state.get("sha256") != MICROMAMBA_SHA256
    ):
        environment_problem = "The BrainCharts runtime was built by another micromamba."
    else:
        try:
            current = _environment_state(cfg, versions)
        except OSError:
            environment_problem = "The BrainCharts runtime files are missing."
        else:
            if current != environment:
                environment_problem = "The BrainCharts runtime changed after setup."
    if environment_problem is None and not os.access(env_python(cfg), os.X_OK):
        environment_problem = "The BrainCharts interpreter is missing."

    model_problem: str | None = None
    if model.get("archiveSha256") != MODEL_ARCHIVE.sha256 or model.get("lists") != {
        pinned.name: pinned.sha256 for pinned in MODEL_LISTS
    }:
        model_problem = "The BrainCharts model record differs from its pins."
    else:
        try:
            current_model = _model_state(cfg)
        except OSError:
            model_problem = "The BrainCharts model files are missing."
        else:
            if current_model != model:
                model_problem = "The BrainCharts model files changed after setup."

    detail = environment_problem or model_problem or recorded
    return ProvisionState(
        environment_problem is None,
        model_problem is None,
        detail,
        recorded if environment_problem is None and model_problem is None else None,
    )


# -- Execution -------------------------------------------------------------------


@contextmanager
def _provision_lock(
    cfg: dict[str, Any],
    cancelled: Callable[[], bool] | None,
    *,
    exclusive: bool = True,
) -> Iterator[None]:
    """Hold the cross-process BrainCharts lock.

    Provisioning holds it exclusively; a stage run holds it shared (see
    :func:`execution_lease`), so no generation is replaced or pruned while a
    run reads it.
    """
    root = Path(provision_root(cfg))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or not root.is_dir():
        raise OSError("The BrainCharts root is not a directory.")
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(root / "provision.lock", flags, 0o600)
    operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
    try:
        while True:
            try:
                fcntl.flock(descriptor, operation | fcntl.LOCK_NB)
                break
            except BlockingIOError as exc:
                if cancelled is not None and cancelled():
                    raise InterruptedError("cancelled") from exc
                time.sleep(0.05)
        yield
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


@contextmanager
def execution_lease(cfg: dict[str, Any]) -> Iterator[None]:
    """Hold the BrainCharts lock shared for one stage run and recheck the setup.

    A run reads the environment and the model through ``current``; while it
    holds this lease, provisioning cannot switch or prune a generation.
    """
    with _provision_lock(cfg, None, exclusive=False):
        state = provision_state_status(cfg)
        if not (state.environment_ok and state.model_ok):
            raise RuntimeError(
                f"Set BrainCharts up again in Scientific resources: {state.detail}"
            )
        yield


def prune_superseded_generations(cfg: dict[str, Any]) -> list[str]:
    """Remove every generation except the published one; keep the caches.

    Call this only under the exclusive lock: runs hold it shared for their
    whole lifetime, so no run still reads a superseded generation. The pip
    cache and downloads live outside ``generations`` and stay.
    """
    try:
        current = _current_generation(cfg)
    except OSError:
        return []
    generations = current.parent
    removed: list[str] = []
    for entry in sorted(generations.iterdir()):
        if entry == current or entry.is_symlink() or not entry.is_dir():
            continue
        _remove_generation(entry)
        removed.append(entry.name)
    return removed


def _publish_generation(cfg: dict[str, Any], generation: Path) -> str | None:
    root = Path(provision_root(cfg))
    current = root / "current"
    previous = os.readlink(current) if current.is_symlink() else None
    temporary = root / f".current-{uuid.uuid4().hex}"
    os.symlink(os.path.relpath(generation, root), temporary, target_is_directory=True)
    try:
        os.replace(temporary, current)
        _fsync_directory(root)
    finally:
        if temporary.is_symlink():
            temporary.unlink()
    return previous


def _restore_generation(cfg: dict[str, Any], previous: str | None) -> None:
    root = Path(provision_root(cfg))
    current = root / "current"
    if previous is None:
        if current.is_symlink():
            current.unlink()
            _fsync_directory(root)
        return
    temporary = root / f".current-restore-{uuid.uuid4().hex}"
    os.symlink(previous, temporary, target_is_directory=True)
    try:
        os.replace(temporary, current)
        _fsync_directory(root)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


def _preflight_space(cfg: dict[str, Any]) -> None:
    available = shutil.disk_usage(provision_root(cfg)).free
    if available < _MIN_FREE_BYTES:
        raise OSError(
            f"BrainCharts needs {_MIN_FREE_BYTES / 1024**3:.0f} GiB free below "
            f"paths.outputDir; {available / 1024**3:.1f} GiB are free."
        )


#: What each step does, as the progress line states it.
STEP_FACTS: dict[str, str] = {
    "check_micromamba": "Checking micromamba",
    "create_env": "Creating the CPython 3.12 environment",
    "install_wheels": "Installing the locked pcntoolkit runtime (about 2 GB)",
    "install_sources": "Building the locked source packages",
    "probe_runtime": "Checking the runtime versions",
    "fetch_model": "Downloading the BrainCharts model from GitHub",
    "verify_model": "Checking the model size and SHA-256",
    "fetch_lists": "Downloading and checking the site and phenotype lists",
    "extract_model": "Unpacking the model",
    "check_model": "Checking the model regions and sites",
    "probe_model": "Loading one model with pcntoolkit",
    "publish_generation": "Publishing the checked setup",
    "record_state": "Recording the setup state",
}


def execute_provision(  # noqa: PLR0911, PLR0912, PLR0913, PLR0915
    cfg: dict[str, Any],
    progress_cb: Callable[[str, float], None],
    *,
    runner: Callable[..., tools.RunResult] = tools.run,
    cancelled: Callable[[], bool] | None = None,
    micromamba: str | None = None,
    state_writer: Callable[..., tools.RunResult] = record_provision_state,
) -> dict[str, Any]:
    """Build and atomically publish one checked BrainCharts generation.

    Reuse a generation whose recorded state still holds without any network
    access. Otherwise build under a new unpublished generation: the
    environment from the committed locks, then the model and lists, each
    downloaded to ``downloads/`` (a partial model download resumes; a file
    already downloaded and matching its pin is reused), checked for exact size
    and SHA-256, and copied into the generation. Switch ``current`` last and
    write the provenance record after it; roll both back on any failure.
    """

    def outcome(*, ok: bool, failed_step: str | None, rc: int, message: str) -> dict:
        return {"ok": ok, "failed_step": failed_step, "rc": rc, "message": message}

    if not platform_supported():
        return outcome(
            ok=False, failed_step="prepare_storage", rc=1, message=_UNSUPPORTED_PLATFORM
        )
    generation: Path | None = None
    published = False
    previous_current: str | None = None
    success = False
    try:
        with _provision_lock(cfg, cancelled):
            state = provision_state_status(cfg)
            if state.environment_ok and state.model_ok:
                probe = runner(
                    runtime_probe_command(cfg),
                    timeout=600,
                    env=runtime_environment(provision_root(cfg)),
                )
                versions = parse_runtime_versions(probe)
                if versions and not runtime_version_mismatches(versions):
                    prune_superseded_generations(cfg)
                    progress_cb("The existing BrainCharts setup is checked.", 1.0)
                    success = True
                    return outcome(ok=True, failed_step=None, rc=0, message="")
            try:
                prepare_provision_storage(cfg)
                _preflight_space(cfg)
            except (OSError, RuntimeError, ValueError) as exc:
                return outcome(
                    ok=False, failed_step="prepare_storage", rc=1, message=str(exc)
                )

            generations = Path(provision_root(cfg)) / "generations"
            generations.mkdir(parents=True, exist_ok=True, mode=0o700)
            generation = generations / uuid.uuid4().hex
            generation.mkdir(mode=0o700)
            staged = copy.deepcopy(cfg)
            staged[_GENERATION_KEY] = str(generation)
            environment = runtime_environment(provision_root(cfg))
            downloads = Path(provision_root(cfg)) / "downloads"
            staged_models = Path(models_root(staged))

            selected = micromamba or micromamba_binary()
            identity_error = ""
            try:
                identity: tuple[str, str] | None = micromamba_identity(selected)
                selected = identity[0]
            except OSError as exc:
                identity = None
                identity_error = str(exc)

            def run(argv: list[str], timeout: float | None = None) -> tools.RunResult:
                return runner(argv, timeout=timeout, env=environment)

            def check_micromamba() -> tools.RunResult:
                if identity is None:
                    return tools.RunResult(rc=1, stdout="", stderr=identity_error)
                return probe_micromamba_version(
                    staged,
                    micromamba=selected,
                    selected_identity=identity,
                    environment=environment,
                    runner=runner,
                )

            versions: dict[str, str] = {}

            def probe_runtime() -> tools.RunResult:
                nonlocal versions
                result = run(runtime_probe_command(staged), timeout=600)
                versions = parse_runtime_versions(result)
                mismatches = runtime_version_mismatches(versions)
                if result.rc == 0 and (not versions or mismatches):
                    return tools.RunResult(
                        rc=1,
                        stdout=result.stdout,
                        stderr="; ".join(mismatches) or "The versions are unreadable.",
                    )
                return result

            def fetch(pinned: PinnedFile, *, resume: bool) -> tools.RunResult:
                cached = downloads / pinned.name
                if verify_pinned_file(cached, pinned, cancelled).rc == 0:
                    return tools.RunResult(
                        rc=0, stdout=f"Reusing the checked {pinned.name}.", stderr=""
                    )
                cached.unlink(missing_ok=True)
                partial = downloads / f".{pinned.name}.part"
                if partial.is_symlink():
                    partial.unlink()
                size = partial.stat().st_size if partial.is_file() else 0
                if not resume or size > pinned.byte_size:
                    partial.unlink(missing_ok=True)
                    size = 0
                if size < pinned.byte_size:
                    result = run(fetch_command(pinned, str(partial)))
                    if result.rc != 0:
                        return result
                checked = verify_pinned_file(partial, pinned, cancelled)
                if checked.rc != 0:
                    if checked.rc != 130:  # noqa: PLR2004
                        partial.unlink(missing_ok=True)
                    return checked
                os.replace(partial, cached)
                _fsync_directory(downloads)
                return checked

            def place(pinned: PinnedFile, destination: Path) -> tools.RunResult:
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copyfile(downloads / pinned.name, destination)
                destination.chmod(0o444)
                return verify_pinned_file(destination, pinned, cancelled)

            def fetch_model() -> tools.RunResult:
                return fetch(MODEL_ARCHIVE, resume=True)

            def verify_model() -> tools.RunResult:
                return place(MODEL_ARCHIVE, Path(archive_path(staged)))

            def fetch_lists() -> tools.RunResult:
                for pinned in MODEL_LISTS:
                    result = fetch(pinned, resume=False)
                    if result.rc != 0:
                        return result
                    result = place(pinned, Path(list_path(staged, pinned)))
                    if result.rc != 0:
                        return result
                return tools.RunResult(
                    rc=0, stdout="The site and phenotype lists match.", stderr=""
                )

            def probe_model() -> tools.RunResult:
                first = read_list(list_path(staged, PHENOTYPE_LISTS[-1]))[0]
                model_file = str(
                    Path(model_dir(staged)) / first / "Models" / MODEL_FILE
                )
                return run(model_probe_command(staged, model_file), timeout=600)

            def publish() -> tools.RunResult:
                nonlocal previous_current, published
                previous_current = _publish_generation(cfg, generation)  # type: ignore[arg-type]
                published = True
                return tools.RunResult(rc=0, stdout="Published.", stderr="")

            steps: list[tuple[str, Callable[[], tools.RunResult]]] = [
                ("check_micromamba", check_micromamba),
                ("create_env", lambda: run(create_env_command(staged, selected))),
                ("install_wheels", lambda: run(pip_wheels_command(staged))),
                ("install_sources", lambda: run(pip_sources_command(staged))),
                ("probe_runtime", probe_runtime),
                ("fetch_model", fetch_model),
                ("verify_model", verify_model),
                ("fetch_lists", fetch_lists),
                (
                    "extract_model",
                    lambda: extract_model(
                        archive_path(staged), staged_models, cancelled
                    ),
                ),
                ("check_model", lambda: check_model_tree(staged)),
                ("probe_model", probe_model),
                ("publish_generation", publish),
                (
                    "record_state",
                    lambda: state_writer(staged, versions, micromamba=selected),
                ),
            ]
            total = len(steps)
            for index, (name, action) in enumerate(steps):
                if cancelled is not None and cancelled():
                    return outcome(
                        ok=False, failed_step=name, rc=130, message="cancelled"
                    )
                progress_cb(f"{STEP_FACTS[name]}...", index / total)
                try:
                    result = action()
                except (OSError, ValueError, UnicodeError, IndexError) as exc:
                    result = tools.RunResult(rc=1, stdout="", stderr=str(exc))
                if result.rc != 0:
                    if cancelled is not None and cancelled():
                        return outcome(
                            ok=False, failed_step=name, rc=130, message="cancelled"
                        )
                    detail = (result.stderr or result.stdout or "").strip()
                    tail = detail.splitlines()[-1] if detail else ""
                    message = f"{STEP_FACTS[name]} failed" + (
                        f": {tail}" if tail else "."
                    )
                    progress_cb(message, index / total)
                    return outcome(
                        ok=False, failed_step=name, rc=result.rc, message=message
                    )
            prune_superseded_generations(cfg)
            progress_cb("The BrainCharts model and runtime are set up.", 1.0)
            success = True
            return outcome(ok=True, failed_step=None, rc=0, message="")
    except InterruptedError:
        return outcome(
            ok=False, failed_step="acquire_lock", rc=130, message="cancelled"
        )
    finally:
        if not success and generation is not None:
            if published:
                try:
                    _restore_generation(cfg, previous_current)
                except OSError:
                    pass
            _remove_generation(generation)


def _remove_generation(generation: Path) -> None:
    """Remove one generation; its read-only files sit in writable directories."""
    shutil.rmtree(generation, ignore_errors=True)
