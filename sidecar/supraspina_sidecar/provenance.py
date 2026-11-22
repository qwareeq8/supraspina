"""Artifact evidence and receipt contracts for workflow readiness."""

from __future__ import annotations

import copy
import hashlib
import inspect
import json
import os
import re
import stat
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from . import braincharts_runtime, resources
from .adapters.base import Adapter
from .adapters.fastsurfer import (
    FASTSURFER_BACKEND,
    selected_backend,
    selected_fastsurfer_device,
)
from .bounded_io import read_bounded_regular, sha256_bounded_regular
from .cohort import CohortSnapshot
from .registry import STEP_SCOPES
from .run_store import (
    EXECUTION_FALLBACK_KEY,
    RECEIPT_PAYLOAD_KEYS,
    RECEIPT_VERSION,
    RECONSTRUCTION_RECEIPT_VERSION,
    UNIT_REUSE_KEY,
    receipt_payload_keys,
    receipt_record_contract_valid,
    receipt_record_digest,
    receipt_scope_contract_valid,
    reconstruction_receipt_contract_valid,
)
from .scientific_resources import FASTSURFER_VARIANTS, FASTSURFER_VERSION

BASELINE = {
    "upstreamCommit": "8a8c2d3586a37bb896bd8bdc3743b43e602827e3",
    "resourcesTree": "2cbef5bb3f11ce4a545140deefe2bcb745cbe65d",
    "resourcesListingSha256": (
        "5bb59e93810e8622f033f0d1aaed1de8f1c2ed953ec608ef30cb7db30802da81"
    ),
    "resourcesPathContentSha256": (
        "fc07fe555a199aa531169a35aba24d034013beac1c7a41a0cfc9f8e5c1ac4f4e"
    ),
    "adaptersTree": "f44c06d4fbe194d14e49033de1f1e6defe603a20",
    "adaptersListingSha256": (
        "340708aa85d1fbeefcd68d906af1f958b0fcc72753c337c076f584b03a9d2c6f"
    ),
    "defaceStartSha256": (
        "512068470d90a5b81a5989918f417ff20803830bc3a0958ca911bf8664a6ad61"
    ),
    "reconStartSha256": (
        "4f8a05d095f5c22730d0a32b17674dbbe9aec1ba25acce1f6fed71c4723dde17"
    ),
}

OUTPUT_SCHEMA: dict[str, str] = {
    "deface": "nii-gz:defaced-t1:v1",
    "recon": "freesurfer:recon-tree:v1",
    "enigma": "enigma:measures-galleries:v1",
    "outliers": "enigma:outlier-csv-histograms:v1",
    "features": "csv:id-plus-187-features:v1",
    "age": "csv:id-age-plus-187-features:v1",
    "pybrainage": "csv:id-age-brainage-brainpad:v1",
    "clinical": "xlsx:clinical-brainpad:v1",
    "brainpad": "brainpad:tables-figures:v1",
    # v2 adds the three cerebral white matter totals to wm_volumes.csv.
    "aggregate": "structural:four-csv:v2",
    "final": "final:twelve-comparison-tables-sites-report:v2",
    "braincharts": "braincharts:zscores-split-summary:v1",
    "zstats": "zstats:eight-zscore-tables-report:v1",
}

#: The registry fields the BrainCharts projection reads; any other registry
#: edit leaves its receipt current.
BRAINCHARTS_REGISTRY_FIELDS = ("age", "sex", "site", "cohortRole")
_MAX_REGISTRY_BYTES = 64 * 1024 * 1024

_SCIENTIFIC_CONFIGURATION_KEYS = (
    "analysis",
    "outputs",
    "paths",
    "patterns",
    "platform",
    "pybrain",
    "qa",
    "runtime",
    "tools",
)

#: Runtime keys that decide how a run is scheduled, not what it computes.
#: Binding them into a receipt would make every finished subject rerun after
#: the operator toggles Dry run or Rerun incomplete output. Cohort membership
#: (``subjects``) is bound separately through ``analysisCohortDigest`` for
#: cohort-scoped steps and never changes a per-subject result. Step
#: parameters are bound through ``stepParamsDigest`` for the step itself and
#: through ``upstreamSignatures`` for its lineage, so an option changed on an
#: unrelated downstream step leaves a finished receipt current.
_RUNTIME_POLICY_KEYS = frozenset(
    {
        "continueIndependentAfterError",
        "dryRun",
        "memoryWarningGB",
        "queueSize",
        "rerunIncomplete",
        "resumeCompleted",
        "stopOnError",
    }
)


def _scientific_configuration(cfg: dict[str, Any], step_key: str) -> dict[str, Any]:
    """Return the configuration subset that can change this step's output."""
    saved = {
        key: copy.deepcopy(cfg.get(key))
        for key in _SCIENTIFIC_CONFIGURATION_KEYS
        if key in cfg
    }
    steps = cfg.get("steps")
    if isinstance(steps, dict) and step_key in steps:
        # Bind this step's saved declaration, including an explicit backend
        # choice, but not the options of other steps.
        saved["step"] = copy.deepcopy(steps[step_key])
    runtime = saved.get("runtime")
    if isinstance(runtime, dict):
        saved["runtime"] = {
            key: value
            for key, value in runtime.items()
            if key not in _RUNTIME_POLICY_KEYS
        }
    return saved


_FASTSURFER_OUTPUT_SCHEMA = "fastsurfer:recon-tree:v2"
_FREESURFER_RELEASE = re.compile(r"\brelease\s+([^);]+)")
_MAX_RESOURCE_FILES = 4_096
_MAX_RESOURCE_FILE_BYTES = 128 * 1024 * 1024
_MAX_RESOURCE_TREE_BYTES = 1024 * 1024 * 1024


def stable_digest(value: Any) -> str:
    """Return a canonical SHA-256 digest for a JSON-compatible value."""
    data = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


#: Stand in for the app-generated run directory inside a bound execution action.
#: The wrapper creates ``<projectRoot>/.supraspina/runs/<runId>`` fresh for every
#: run, so its literal location carries no scientific meaning and must not make
#: two semantically identical actions look different.
RUN_DIRECTORY_PLACEHOLDER = "${supraspinaRunDir}"


#: Stand in for the active scientific resource root inside a bound action.
#: An acquired resource set lives in a machine-local generation directory
#: named by a random identifier, and a revised asset inventory rebuilds it
#: under a new name with the same verified bytes. Binding that name would make
#: every cohort receipt stale after a rebuild although nothing it computes
#: has changed, so the action binds this token plus the content identity of
#: each referenced resource instead.
SCIENTIFIC_RESOURCES_PLACEHOLDER = "${supraspinaResources}"


def _replace_prefix(value: str, root: str, replacement: str) -> str | None:
    """Return ``value`` with ``root`` replaced, or ``None`` outside ``root``."""
    if not root or not value:
        return None
    normalized = root.rstrip(os.sep)
    if value == normalized:
        return replacement
    prefix = normalized + os.sep
    if value.startswith(prefix):
        return replacement + os.sep + value[len(prefix) :]
    return None


def _replace_root_in_text(text: str, root: str, replacement: str) -> str:
    """Replace every whole-path mention of ``root`` inside free text.

    Match ``root`` only where it starts a path token and ends at a separator,
    whitespace, closing punctuation, or the end of the text, so a sibling such
    as ``<root>-old`` or ``<root>.bak`` and a path that merely contains
    ``root`` stay verbatim.
    """
    normalized = root.rstrip(os.sep)
    if not normalized or not text:
        return text
    pattern = re.compile(
        r"(?<![^\s'\"(=:,\[])"
        + re.escape(normalized)
        + r"(?="
        + re.escape(os.sep)
        + r"|[\s'\",;:)\]]|\.(?:\s|$)|$)"
    )
    return pattern.sub(lambda _match: replacement, text)


def canonical_action_path(value: str, run_dir: str) -> str:
    """Replace an app-generated run-directory prefix with a stable token.

    Rewrite only a value that is the run directory itself or lies inside it.
    Leave every user-supplied path, argument, and unrelated location verbatim.
    """
    replaced = _replace_prefix(value, run_dir, RUN_DIRECTORY_PLACEHOLDER)
    return value if replaced is None else replaced


#: One spelling of a resource location and the path under the resource root
#: it stands for ("" for the root itself).
ResourcePrefix = tuple[str, str]


def _active_resource_roots() -> tuple[ResourcePrefix, ...]:
    """Return the spellings of every resource location an action can carry.

    The set depends only on where resources can resolve, never on whether
    the acquired generation is currently usable: the frozen subset's reviewed
    directories are always included, and the brain-FOV helper beside them
    never is. Tokenizing the whole frozen subset only while no generation is
    usable would re-digest every brain-FOV action when an upgrade rejects the
    generation.
    """
    try:
        locations = resources.resource_prefixes()
    except (OSError, ValueError):
        return ()
    spellings: list[ResourcePrefix] = []
    for location, relative in locations:
        for spelling in (str(location), os.path.realpath(location)):
            if (spelling, relative) not in spellings:
                spellings.append((spelling, relative))
    return tuple(spellings)


def _under(base: str, relative: str) -> str:
    """Join ``relative`` under a replacement root, keeping a bare root intact."""
    return base + os.sep + relative if relative else base


#: Env-check key that carries the frozen text a check's identity digests
#: when the displayed ``detail`` differs from it. A copy edit of the detail
#: leaves this text unchanged, so the same probe result keeps the identity
#: every existing receipt recorded.
IDENTITY_DETAIL_KEY = "identityDetail"


def active_resource_root_spellings() -> tuple[ResourcePrefix, ...]:
    """Return the spellings of the resource locations a value can carry."""
    return _active_resource_roots()


def canonical_check_detail(
    detail: str, roots: tuple[ResourcePrefix | str, ...] | None = None
) -> str:
    """Return one env check detail with the active resource root tokenized.

    Pass ``roots`` from :func:`active_resource_root_spellings` to tokenize many
    details against one resolution of the resource root; a bare string stands
    for a whole resource root.
    """
    for entry in active_resource_root_spellings() if roots is None else roots:
        location, relative = (entry, "") if isinstance(entry, str) else entry
        detail = _replace_root_in_text(
            detail, location, _under(SCIENTIFIC_RESOURCES_PLACEHOLDER, relative)
        )
    return detail


def environment_check_evidence(
    check: dict[str, Any], roots: tuple[ResourcePrefix | str, ...] | None = None
) -> dict[str, Any]:
    """Summarize one env check as a run records it for receipt binding.

    Digest the check's identity text: its frozen ``identityDetail`` when the
    displayed detail was reworded, else the detail itself. Tokenize the
    active resource root first, so the identity survives a rebuilt resource
    generation; the resource content itself is bound through
    ``adapterImplementation`` and the action's resource map.
    """
    frozen = check.get(IDENTITY_DETAIL_KEY)
    detail = frozen if isinstance(frozen, str) else str(check.get("detail", ""))
    return {
        "status": str(check.get("status")),
        "identitySha256": stable_digest(canonical_check_detail(detail, roots)),
    }


def bound_tool_evidence(environment: Any, check_ids: Any) -> dict[str, Any]:
    """Return the environment evidence a receipt binds for ``check_ids``."""
    recorded = environment if isinstance(environment, dict) else {}
    return {
        check_id: recorded.get(check_id, {"status": "missing"})
        for check_id in check_ids
    }


def bound_action(adapter: Any, cfg: dict[str, Any], subject_id: str | None) -> Any:
    """Return the action form a receipt binds for one adapter invocation.

    An adapter that distinguishes a receipt form from the launched command
    (Reconstruction imports the T1 once and later continues the same subject
    without ``-i``) binds the receipt form; a minimal adapter offers only the
    launched command. The planner and the launcher both digest this form, so
    a continuation of an imported subject compares equal to its own plan.
    """
    receipt_action = getattr(adapter, "receipt_action", None)
    if callable(receipt_action):
        return receipt_action(cfg, subject_id)
    return adapter.execution_action(cfg, subject_id)


def execution_action_digest(action: Any, run_dir: str | None = None) -> str:
    """Bind the exact typed execution action to one canonical digest.

    Canonicalize the app-generated run directory so two runs that execute the
    same executable, arguments, cohort, and destinations reuse one action
    identity. Replace the active scientific resource root with a stable token
    and bind the content identity of every referenced resource instead, so a
    rebuilt resource generation with the same bytes keeps the identity while
    changed resource bytes still change it. Keep the executable, every other
    argument, user-supplied path, destination semantics, and action kind
    byte-exact.
    """
    root = run_dir or ""
    resource_roots = [
        (entry, "") if isinstance(entry, str) else entry
        for entry in _active_resource_roots()
    ]
    referenced: dict[str, dict[str, Any]] = {}

    def canonical(value: str) -> str:
        value = canonical_action_path(value, root)
        for location, relative in resource_roots:
            replaced = _replace_prefix(
                value, location, _under(SCIENTIFIC_RESOURCES_PLACEHOLDER, relative)
            )
            if replaced is not None:
                referenced[replaced] = _resource_identity(Path(value))
                return replaced
        return value

    bound: dict[str, Any] = {
        "kind": action.kind,
        "argv": [canonical(value) for value in action.argv],
        "source": None if action.source is None else canonical(action.source),
        "destination": (
            None if action.destination is None else canonical(action.destination)
        ),
        "force": action.force,
    }
    if referenced:
        bound["scientificResources"] = referenced
    return stable_digest(bound)


def runtime_run_directory(cfg: dict[str, Any]) -> str:
    """Return the app-generated run directory overlaid on one effective config."""
    runtime = cfg.get("_supraspinaRuntime")
    if not isinstance(runtime, dict):
        return ""
    value = runtime.get("runDir")
    return value if isinstance(value, str) else ""


#: Retain file identities by path and observed filesystem identity.
#: The bound keeps a large cohort from growing the cache without limit and
#: exceeds one cohort's artifact inventory: a 65-subject project lists about
#: 1400 artifacts, and a smaller bound would evict every entry before the
#: sweep ends, so each Results open would re-read every artifact's bytes. One
#: entry is a short path with a digest and a size, so the ceiling costs a few
#: MB.
_MAX_CACHED_IDENTITIES = 8192
_IDENTITY_CACHE: OrderedDict[tuple[str, bool, int, int, int, int], dict[str, Any]] = (
    OrderedDict()
)
_IDENTITY_LOCK = threading.Lock()


def _identity_witness(path: str) -> tuple[int, int, int, int] | None:
    """Return the cheap filesystem identity of one path, or ``None``."""
    try:
        info = os.stat(path)
    except OSError:
        return None
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def file_identity(
    path: str, *, include_path: bool = True, cached: bool = False
) -> dict[str, Any]:
    """Return a canonical, full-content identity for one external input file.

    Parameters
    ----------
    cached
        Reuse an earlier fingerprint of the same file while its filesystem
        identity is unchanged. Set this only from read-only inventory and evidence
        callers. Do not set this when fingerprinting one file twice to prove that
        it stayed unchanged across a live operation; preserve the second read as
        the proof.
    """
    witness = _identity_witness(path) if cached and path else None
    if witness is not None:
        key = (path, include_path, *witness)
        with _IDENTITY_LOCK:
            hit = _IDENTITY_CACHE.get(key)
            if hit is not None:
                _IDENTITY_CACHE.move_to_end(key)
                return copy.deepcopy(hit)
    canonical = os.path.realpath(path) if path else ""
    identity: dict[str, Any] = {"exists": False}
    if include_path:
        identity["path"] = canonical
    try:
        stat = os.stat(canonical)
        if not os.path.isfile(canonical):
            identity.update({"exists": True, "kind": "directory"})
            return identity
        digest = hashlib.sha256()
        with open(canonical, "rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        identity.update(
            {
                "exists": True,
                "kind": "file",
                "size": stat.st_size,
                "sha256": digest.hexdigest(),
            }
        )
    except OSError:
        return identity
    if witness is not None and _identity_witness(path) == witness:
        # Retain only a fingerprint whose file stayed unchanged for the whole read.
        key = (path, include_path, *witness)
        with _IDENTITY_LOCK:
            _IDENTITY_CACHE[key] = copy.deepcopy(identity)
            _IDENTITY_CACHE.move_to_end(key)
            while len(_IDENTITY_CACHE) > _MAX_CACHED_IDENTITIES:
                _IDENTITY_CACHE.popitem(last=False)
    return identity


def _external_inputs(
    step_key: str, cfg: dict[str, Any], adapter: Adapter, *, cached: bool = True
) -> dict[str, Any]:
    """Fingerprint non-upstream files whose bytes affect one stage's output.

    Set ``cached`` to ``False`` on the post-exit proof path so a mutation that
    preserved the file's size, inode, and timestamp cannot be hidden by an
    identity recorded before execution started.
    """
    paths = cfg.get("paths", {}) if isinstance(cfg.get("paths"), dict) else {}
    values: dict[str, str] = {}
    if step_key == "age":
        values["ageMetadata"] = adapter.resolve(
            str(paths.get("ageMetadataFile") or ""), cfg
        )
    elif step_key == "clinical":
        values["clinicalMetadata"] = adapter.resolve(
            str(paths.get("clinicalMetadataFile") or ""), cfg
        )
    elif step_key == "final":
        metadata_dir = adapter.resolve(str(paths.get("metadataDir") or ""), cfg)
        values["finalMetadata"] = os.path.join(metadata_dir, "metadata.csv")
    elif step_key == "pybrainage":
        try:
            argv = adapter.build_command(cfg, None)
            values["model"] = argv[argv.index("--model") + 1]
            values["scaler"] = argv[argv.index("--scaler") + 1]
        except (ValueError, IndexError):
            values["model"] = ""
            values["scaler"] = ""
    if step_key in {"clinical", "final"}:
        project_root = adapter.resolve(str(paths.get("projectRoot") or ""), cfg)
        values["subjectRegistry"] = os.path.join(
            project_root, ".supraspina", "registry.json"
        )
    identities = {
        name: file_identity(path, cached=cached)
        for name, path in sorted(values.items())
    }
    if step_key == "braincharts":
        project_root = adapter.resolve(str(paths.get("projectRoot") or ""), cfg)
        identities["registryFields"] = registry_fields_identity(
            os.path.join(project_root, ".supraspina", "registry.json")
        )
    return identities


def registry_fields_identity(path: str) -> dict[str, Any]:
    """Digest the subject ID and the BrainCharts fields of every registry record.

    The digest covers :data:`BRAINCHARTS_REGISTRY_FIELDS` of all records, not
    only the analysis cohort, because the cohort is bound separately. It is
    read afresh on every call, so a post-exit proof sees any change.
    """
    try:
        payload = read_bounded_regular(path, _MAX_REGISTRY_BYTES)
    except FileNotFoundError:
        return {"exists": False}
    except OSError as exc:
        return {"exists": False, "error": type(exc).__name__}
    try:
        value = json.loads(payload.decode("utf-8"))
        records = value["records"]
        if not isinstance(records, dict):
            raise TypeError("records")
        rows = [
            [subject_id]
            + [
                item.get(field) if isinstance(item, dict) else None
                for field in BRAINCHARTS_REGISTRY_FIELDS
            ]
            for subject_id, item in sorted(records.items())
        ]
    except (UnicodeError, ValueError, KeyError, TypeError):
        return {"exists": False, "error": "unreadable"}
    return {
        "exists": True,
        "kind": "registry-fields-v1",
        "fields": ["subjectId", *BRAINCHARTS_REGISTRY_FIELDS],
        "sha256": stable_digest(rows),
    }


_RESOURCE_IDENTITY_CACHE: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()
_MAX_CACHED_RESOURCE_IDENTITIES = 64


def _resource_witness(path: Path) -> tuple[Any, ...] | None:  # noqa: PLR0911
    """Return the cheap filesystem identity of one resource file or tree.

    Stat every regular file the aggregate would hash. A witness that matches
    before and after a cached read shows that the tree's names, sizes, and
    timestamps are unchanged, so the cached aggregate stands without reading
    the bytes again.
    """
    try:
        if path.is_symlink():
            return None
        if path.is_file():
            info = path.stat()
            return ("file", info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
        if not path.is_dir():
            return ("missing",)
        entries: list[tuple[str, int, int]] = []
        for root, directories, names in os.walk(path, followlinks=False):
            directories[:] = sorted(
                name for name in directories if name != "__pycache__"
            )
            for name in sorted(names):
                if name.endswith((".pyc", ".pyo")):
                    continue
                candidate = Path(root) / name
                try:
                    info = candidate.lstat()
                except OSError:
                    return None
                if stat.S_ISLNK(info.st_mode):
                    return None
                entries.append(
                    (
                        candidate.relative_to(path).as_posix(),
                        info.st_size,
                        info.st_mtime_ns,
                    )
                )
                if len(entries) > _MAX_RESOURCE_FILES:
                    return None
        return ("tree", tuple(entries))
    except OSError:
        return None


def _resource_identity(path: Path) -> dict[str, Any]:
    """Aggregate one bounded regular resource file or directory tree.

    Reuse an earlier aggregate while the tree's names, sizes, and timestamps
    are unchanged. One Results inventory asks for the same few resource trees
    once per receipt, and the pinned container images and script trees they
    cover run to hundreds of megabytes each.
    """
    witness = _resource_witness(path)
    if witness is not None:
        key = (str(path), witness)
        with _IDENTITY_LOCK:
            hit = _RESOURCE_IDENTITY_CACHE.get(key)
            if hit is not None:
                _RESOURCE_IDENTITY_CACHE.move_to_end(key)
                return copy.deepcopy(hit)
    identity = _resource_identity_uncached(path)
    if witness is not None and _resource_witness(path) == witness:
        key = (str(path), witness)
        with _IDENTITY_LOCK:
            _RESOURCE_IDENTITY_CACHE[key] = copy.deepcopy(identity)
            _RESOURCE_IDENTITY_CACHE.move_to_end(key)
            while len(_RESOURCE_IDENTITY_CACHE) > _MAX_CACHED_RESOURCE_IDENTITIES:
                _RESOURCE_IDENTITY_CACHE.popitem(last=False)
    return identity


def _resource_identity_uncached(path: Path) -> dict[str, Any]:
    """Aggregate one bounded regular resource file or directory tree."""
    try:
        if path.is_symlink():
            raise OSError("Reject symbolic-link scientific resources.")
        if path.is_file():
            digest, size = sha256_bounded_regular(path, _MAX_RESOURCE_FILE_BYTES)
            return {"exists": True, "kind": "file", "size": size, "sha256": digest}
        if not path.is_dir():
            return {"exists": False}
        files: list[Path] = []
        for root, directories, names in os.walk(path, followlinks=False):
            if any((Path(root) / name).is_symlink() for name in directories):
                raise OSError("Reject symbolic-link scientific resources.")
            directories[:] = sorted(
                name for name in directories if name != "__pycache__"
            )
            for name in sorted(names):
                if name.endswith((".pyc", ".pyo")):
                    continue
                candidate = Path(root) / name
                if candidate.is_symlink():
                    raise OSError("Reject symbolic-link scientific resources.")
                files.append(candidate)
                if len(files) > _MAX_RESOURCE_FILES:
                    raise OSError("Keep scientific resources within the file limit.")
        digest = hashlib.sha256()
        total = 0
        for candidate in files:
            file_digest, size = sha256_bounded_regular(
                candidate, _MAX_RESOURCE_FILE_BYTES
            )
            total += size
            if total > _MAX_RESOURCE_TREE_BYTES:
                raise OSError("Keep scientific resources within the byte limit.")
            relative = candidate.relative_to(path).as_posix()
            digest.update(relative.encode("utf-8"))
            digest.update(b"\0")
            digest.update(str(size).encode("ascii"))
            digest.update(b"\0")
            digest.update(file_digest.encode("ascii"))
            digest.update(b"\n")
        return {
            "exists": True,
            "kind": "tree",
            "fileCount": len(files),
            "size": total,
            "sha256": digest.hexdigest(),
        }
    except OSError as exc:
        return {"exists": False, "error": str(exc)}


def _scientific_resources(
    step_key: str, cfg: dict[str, Any], adapter: Adapter
) -> dict[str, Any]:
    """Bind every maintained resource whose bytes affect this stage."""
    paths: dict[str, Path] = {}
    try:
        action = adapter.execution_action(cfg, None)
        argv = list(action.argv)
    except (OSError, TypeError, ValueError):
        argv = []
    script_keys = {
        "outliers": "analysis",
        "features": "extractor",
        "pybrainage": "predictor",
        "brainpad": "analysis",
        "aggregate": "analysis",
    }
    script_identity = script_keys.get(step_key)
    if script_identity is not None and len(argv) > 1:
        paths[script_identity] = Path(argv[1])
    if step_key == "brainfov":
        paths["helper"] = resources.brainfov_helper_path()
    if step_key == "enigma":
        base_dir = getattr(adapter, "_base_dir", None)
        if callable(base_dir):
            paths["enigma"] = Path(base_dir(cfg))
    if step_key == "outliers":
        paths["figureStyle"] = resources.resource_dir("figstyle", "figstyle.R")
        paths["figureFonts"] = resources.resource_dir("fonts")
    if step_key in {"features", "pybrainage"}:
        paths["featureOrder"] = resources.features_dir() / "rois_input_template.txt"
    if step_key == "brainpad":
        paths["figureStyle"] = resources.resource_dir("figstyle", "figstyle.py")
        paths["figureFonts"] = resources.resource_dir("fonts")
    if step_key in {"final", "zstats"}:
        # The z-score track runs the same Step 9 script and report template.
        paths["analysis"] = resources.step9_dir() / "FreesurferAnalysisScript.R"
        paths["report"] = resources.step9_dir() / "FreesurferAnalysisScript.Rmd"
    unresolved: dict[str, dict[str, Any]] = {}
    if step_key == "braincharts":
        paths["analysis"] = resources.resource_dir("braincharts", "braincharts_run.py")
        # The downloaded model tree and its lists (outside the app's resources).
        try:
            paths["model"] = Path(braincharts_runtime.model_dir(cfg))
            paths["modelLists"] = Path(
                braincharts_runtime.list_path(cfg, braincharts_runtime.SITE_LIST)
            ).parent
        except ValueError:
            unresolved = {"model": {"exists": False}, "modelLists": {"exists": False}}
    identities = {name: _resource_identity(path) for name, path in paths.items()}
    identities.update(unresolved)
    return dict(sorted(identities.items()))


def _adapter_implementation(
    step_key: str, cfg: dict[str, Any], adapter: Adapter
) -> dict[str, Any]:
    source = inspect.getsourcefile(adapter.__class__)
    if not source:
        identity: dict[str, Any] = {"exists": False}
    else:
        identity = file_identity(str(Path(source).resolve()), include_path=False)
    identity["scientificResources"] = _scientific_resources(step_key, cfg, adapter)
    return identity


def _deface_posture(cfg: dict[str, Any]) -> dict[str, Any]:
    steps = cfg.get("steps", {}) if isinstance(cfg.get("steps"), dict) else {}
    override = steps.get("deface", {}) if isinstance(steps.get("deface"), dict) else {}
    params = (
        override.get("params", {}) if isinstance(override.get("params"), dict) else {}
    )
    return {
        "enabled": bool(override.get("enabled", False)),
        "tool": params.get("tool", "mri_deface"),
    }


def _freesurfer_provider(
    tool_evidence: dict[str, Any] | None,
    provider_evidence: dict[str, Any] | None,
) -> dict[str, str]:
    """Return bounded FreeSurfer provider identity from environment evidence."""
    version = "unknown"
    providers = provider_evidence if isinstance(provider_evidence, dict) else {}
    freesurfer = providers.get("freesurfer")
    recorded = freesurfer.get("version") if isinstance(freesurfer, dict) else None
    if isinstance(recorded, str) and recorded.strip():
        version = recorded.strip()[:256]
    evidence = tool_evidence if isinstance(tool_evidence, dict) else {}
    if version == "unknown":
        for check_id in ("reconall", "fshome"):
            check = evidence.get(check_id)
            detail = check.get("detail") if isinstance(check, dict) else None
            if not isinstance(detail, str):
                continue
            match = _FREESURFER_RELEASE.search(detail)
            if match is not None:
                version = match.group(1).strip()[:256] or "unknown"
                break
    return {"name": "FreeSurfer", "version": version}


def _reconstruction_contract(
    cfg: dict[str, Any],
    tool_evidence: dict[str, Any] | None,
    provider_evidence: dict[str, Any] | None,
    payload_signature: str,
) -> dict[str, Any]:
    """Build the separately digest-bound reconstruction receipt envelope."""
    backend = selected_backend(cfg)
    if backend == FASTSURFER_BACKEND:
        device = selected_fastsurfer_device(cfg)
        variant = FASTSURFER_VARIANTS[device]
        provider: dict[str, Any] = {
            "name": "FastSurfer",
            "version": FASTSURFER_VERSION,
            "variant": device,
            "ociManifestDigest": variant.oci_manifest_digest,
        }
    else:
        device = None
        provider = _freesurfer_provider(tool_evidence, provider_evidence)
    return {
        "receiptVersion": RECONSTRUCTION_RECEIPT_VERSION,
        "backend": backend,
        "device": device,
        "outputSubdir": backend,
        "provider": provider,
        "payloadSignature": payload_signature,
    }


def _scope_binding(
    scope: str,
    subject_id: str | None,
    cohort: CohortSnapshot,
    t1: Any,
) -> dict[str, Any]:
    """Return the explicit scientific scope consumed by one current receipt.

    For a cohort, ``qcVerdicts`` and ``qcAcknowledged`` record the canonical
    membership state (every analysis subject unreviewed, the acknowledgement
    given), not the verdicts, because no cohort stage reads verdicts; the
    verdicts a run planned with stay in its run state.
    """
    if scope == "subject":
        return {
            "bindingVersion": 1,
            "kind": "subject-input",
            "subjectId": subject_id,
            "inputT1Fingerprint": t1.fingerprint if t1 else None,
            "inputT1FingerprintStrategy": (
                t1.fingerprint_strategy if t1 else "sha256-full-v1"
            ),
        }
    return {
        "bindingVersion": 1,
        "kind": "analysis-cohort",
        "analysisCohortDigest": cohort.analysis_digest,
        "analysisSubjectIds": list(cohort.analysis_subject_ids),
        "qcVerdicts": {
            analysis_subject_id: "unreviewed"
            for analysis_subject_id in cohort.analysis_subject_ids
        },
        "qcAcknowledged": True,
        "excludedByConfig": list(cohort.excluded_by_config),
        "excludedByQc": list(cohort.excluded_by_qc),
    }


def expected_receipt_payload(  # noqa: PLR0913
    step_key: str,
    subject_id: str | None,
    cfg: dict[str, Any],
    cohort: CohortSnapshot,
    adapter: Adapter,
    *,
    upstream_signatures: list[str] | None = None,
    tool_evidence: dict[str, Any] | None = None,
    provider_evidence: dict[str, Any] | None = None,
    cached_external_inputs: bool = True,
) -> dict[str, Any]:
    """Build the deterministic portion of a receipt for freshness matching.

    Set ``cached_external_inputs`` to ``False`` when the payload proves that an
    execution ran against unchanged bytes; the pre-execution identity cache must
    never answer that question.
    """
    scope = STEP_SCOPES.get(step_key, "cohort")
    params = adapter.params(cfg)
    saved_configuration = _scientific_configuration(cfg, step_key)
    try:
        action_digest = execution_action_digest(
            bound_action(adapter, cfg, subject_id), runtime_run_directory(cfg)
        )
    except (OSError, ValueError) as error:
        # Bind a blocked command specification deterministically during planning.
        action_digest = stable_digest(
            {
                "kind": "unresolved",
                "errorType": type(error).__name__,
                "reason": str(error),
            }
        )
    t1 = next((row for row in cohort.t1 if row.subject_id == subject_id), None)
    output_schema = OUTPUT_SCHEMA.get(step_key, f"{step_key}:v1")
    if step_key == "recon" and selected_backend(cfg) == FASTSURFER_BACKEND:
        output_schema = _FASTSURFER_OUTPUT_SCHEMA
    payload = {
        "receiptVersion": RECEIPT_VERSION,
        "stepKey": step_key,
        "subjectId": subject_id,
        "scope": scope,
        "analysisCohortDigest": (cohort.analysis_digest if scope == "cohort" else None),
        "selectedSubsetDigest": None,
        "inputT1Fingerprint": t1.fingerprint if t1 else None,
        "configurationDigest": stable_digest(saved_configuration),
        "stepParamsDigest": stable_digest(params),
        "executionActionDigest": action_digest,
        "adapterIdentity": (
            f"{adapter.__class__.__module__}.{adapter.__class__.__name__}"
        ),
        "adapterImplementation": _adapter_implementation(step_key, cfg, adapter),
        "toolEvidenceDigest": stable_digest(tool_evidence or {}),
        "externalInputs": _external_inputs(
            step_key, cfg, adapter, cached=cached_external_inputs
        ),
        "defacing": _deface_posture(cfg),
        "outputSchemaIdentity": output_schema,
        "upstreamSignatures": sorted(upstream_signatures or []),
        "baseline": BASELINE,
    }
    payload["scopeBinding"] = _scope_binding(scope, subject_id, cohort, t1)
    if step_key == "recon":
        payload_signature = stable_digest(
            {key: payload.get(key) for key in RECEIPT_PAYLOAD_KEYS}
        )
        reconstruction = _reconstruction_contract(
            cfg,
            tool_evidence,
            provider_evidence,
            payload_signature,
        )
        payload["reconstruction"] = reconstruction
        payload["reconstructionSignature"] = stable_digest(reconstruction)
    return payload


def expected_signature(*args: Any, **kwargs: Any) -> tuple[str, dict[str, Any]]:
    """Return the canonical receipt digest and its bound payload."""
    payload = expected_receipt_payload(*args, **kwargs)
    payload_keys = receipt_payload_keys(payload.get("receiptVersion"))
    if payload_keys is None:
        raise ValueError("Use a supported receipt version.")
    bound_payload = {key: payload.get(key) for key in payload_keys}
    return stable_digest(bound_payload), payload


def bind_projection_inputs(
    step_key: str, signature: str, payload: dict[str, Any]
) -> tuple[str, dict[str, Any]]:
    """Bind deterministic source identities for run-scoped metadata projections.

    The clinical and final steps read a projection the run writes from the
    clinical metadata and the registry. The launcher binds the identities of
    those two sources into the receipt; the inventory applies the same
    binding so a finished run's clinical and statistics results verify.
    """
    source_key = {
        "clinical": "clinicalMetadata",
        "final": "finalMetadata",
    }.get(step_key)
    if source_key is None:
        return signature, payload
    bound = copy.deepcopy(payload)
    external = bound.setdefault("externalInputs", {})
    identities = {
        "sourceIdentity": copy.deepcopy(external.get(source_key, {"exists": False})),
        "registryIdentity": copy.deepcopy(
            external.get("subjectRegistry", {"exists": False})
        ),
    }
    external["runScopedProjectionBinding"] = {
        "exists": True,
        "kind": "metadata-projection-input-binding-v1",
        "sha256": stable_digest(identities),
        **identities,
    }
    return stable_digest(bound), bound


def receipt_signature_valid(receipt: dict[str, Any], signature: str) -> bool:
    """Verify a receipt's deterministic payload against its claimed digest."""
    payload_keys = receipt_payload_keys(receipt.get("receiptVersion"))
    if (
        payload_keys is None
        or not receipt_scope_contract_valid(receipt)
        or not receipt_record_contract_valid(receipt)
    ):
        return False
    payload = {key: receipt.get(key) for key in payload_keys}
    if receipt.get("signature") != signature or stable_digest(payload) != signature:
        return False
    if receipt.get("stepKey") == "recon":
        return reconstruction_receipt_contract_valid(receipt, signature)
    return (
        receipt.get("reconstruction") is None
        and receipt.get("reconstructionSignature") is None
    )


def detector_evidence(
    adapter: Adapter, cfg: dict[str, Any], subject_id: str | None
) -> dict[str, Any]:
    """Run an adapter detector and normalize bounded filesystem evidence."""
    try:
        status = adapter.detect(cfg, subject_id)
    except Exception as exc:
        return {
            "state": "unknown",
            "detail": f"Run the detector again after {type(exc).__name__}.",
            "artifacts": [],
        }
    artifacts: list[dict[str, Any]] = []
    for path in status.artifacts[:256]:
        identity = file_identity(path, cached=True)
        if identity.get("exists"):
            try:
                identity["mtimeNs"] = os.stat(path).st_mtime_ns
            except OSError:
                identity["exists"] = False
        if not identity.get("exists"):
            identity["missing"] = True
        artifacts.append(identity)
    evidence = {
        "state": status.state,
        "detail": status.detail,
        "artifacts": artifacts,
    }
    if status.content_identity is not None:
        evidence["contentIdentity"] = copy.deepcopy(status.content_identity)
    return evidence


def evidence_identity(evidence: dict[str, Any]) -> str:
    """Digest the scientific artifact and membership identities in evidence."""
    artifacts = [
        {
            key: item.get(key)
            for key in (
                "path",
                "exists",
                "missing",
                "kind",
                "size",
                "mtimeNs",
                "sha256",
            )
        }
        for item in evidence.get("artifacts", [])
        if isinstance(item, dict)
    ]
    return stable_digest(
        {
            "state": evidence.get("state"),
            "artifacts": sorted(artifacts, key=lambda item: str(item.get("path", ""))),
            "membership": evidence.get("membership", []),
            "contentIdentity": evidence.get("contentIdentity"),
        }
    )


def uses_detector_edge(producer: str, consumer: str, subject_id: str | None) -> bool:
    """Return whether an edge's evidence is the producer's own detector evidence.

    Mirrors the fallback of :func:`edge_evidence`: every edge except the
    reconstruction inputs and ENIGMA's measures for the outlier review.
    """
    if producer == "recon" and subject_id:
        return False
    return not (producer == "enigma" and consumer == "outliers")


def edge_evidence(
    producer: str,
    consumer: str,
    cfg: dict[str, Any],
    subject_id: str | None,
    adapter: Adapter,
) -> dict[str, Any]:
    """Return consumer-edge-specific evidence instead of generic completion."""
    if producer == "recon" and subject_id:
        derivatives = adapter.resolve(
            str(cfg.get("paths", {}).get("derivativesDir", "")), cfg
        )
        backend = selected_backend(cfg)
        fs_root = os.path.join(derivatives, backend, subject_id)
        if consumer == "features":
            params = cfg.get("steps", {}).get("features", {}).get("params", {})
            parc = str(params.get("parcellation", "aparc.a2009s"))
            required = [
                os.path.join(fs_root, "stats", f"lh.{parc}.stats"),
                os.path.join(fs_root, "stats", f"rh.{parc}.stats"),
                os.path.join(fs_root, "stats", "aseg.stats"),
            ]
        elif consumer == "aggregate":
            required = [
                os.path.join(fs_root, "stats", "lh.aparc.stats"),
                os.path.join(fs_root, "stats", "rh.aparc.stats"),
                os.path.join(fs_root, "stats", "aseg.stats"),
                os.path.join(fs_root, "stats", "wmparc.stats"),
            ]
        else:
            normalized = [
                os.path.join(fs_root, "mri", "nu.mgz"),
                os.path.join(fs_root, "mri", "orig_nu.mgz"),
            ]
            normalized_path = next(
                (
                    path
                    for path in normalized
                    if os.path.isfile(path) and os.path.getsize(path) > 0
                ),
                normalized[0],
            )
            required = [
                os.path.join(fs_root, "stats", "aseg.stats"),
                os.path.join(fs_root, "stats", "lh.aparc.stats"),
                os.path.join(fs_root, "stats", "rh.aparc.stats"),
                os.path.join(fs_root, "mri", "aparc+aseg.mgz"),
                normalized_path,
            ]
        present = [
            path
            for path in required
            if os.path.isfile(path) and os.path.getsize(path) > 0
        ]
        return {
            "state": "done" if len(present) == len(required) else "pending",
            "detail": (
                f"Confirm that {len(present)}/{len(required)} {producer}->{consumer} "
                "inputs are present."
            ),
            "artifacts": [file_identity(path, cached=True) for path in present],
            "required": required,
        }
    if producer == "enigma" and consumer == "outliers":
        params = cfg.get("steps", {}).get("enigma", {}).get("params", {})
        out_dir = adapter.resolve(
            str(params.get("outDir") or cfg.get("paths", {}).get("qcOutputDir", "")),
            cfg,
        )
        required = [
            os.path.join(out_dir, "measures", "LandRvolumes.csv"),
            os.path.join(out_dir, "measures", "CorticalMeasuresENIGMA_ThickAvg.csv"),
            os.path.join(out_dir, "measures", "CorticalMeasuresENIGMA_SurfAvg.csv"),
        ]
        present = [
            path
            for path in required
            if os.path.isfile(path) and os.path.getsize(path) > 0
        ]
        return {
            "state": "done" if len(present) == len(required) else "pending",
            "detail": (
                f"Confirm that {len(present)}/{len(required)} ENIGMA measure tables "
                "are present."
            ),
            "artifacts": [file_identity(path, cached=True) for path in present],
            "required": required,
        }
    return detector_evidence(adapter, cfg, subject_id)


def make_receipt(  # noqa: PLR0913
    signature: str,
    payload: dict[str, Any],
    evidence: dict[str, Any],
    *,
    run_id: str,
    job_id: str,
    committed_at_ms: int,
    edge_evidence: dict[str, Any] | None = None,
    launch_input_projections: list[dict[str, Any]] | None = None,
    launch_direct_scientific_inputs: list[dict[str, Any]] | None = None,
    execution_fallback: dict[str, Any] | None = None,
    unit_reuse: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build one durable, digest-bound workflow artifact receipt.

    Pass ``execution_fallback`` only for work that completed through a
    fallback, and ``unit_reuse`` only for a cohort stage with per-subject
    units; the record digest binds each, and the signed payload does not.
    """
    receipt = {
        **payload,
        "signature": signature,
        "runId": run_id,
        "jobId": job_id,
        "committedAtMs": committed_at_ms,
        "detectorEvidence": evidence,
        "edgeEvidence": edge_evidence or {},
        "launchInputProjections": launch_input_projections or [],
        "launchDirectScientificInputs": launch_direct_scientific_inputs or [],
    }
    if execution_fallback is not None:
        receipt[EXECUTION_FALLBACK_KEY] = copy.deepcopy(execution_fallback)
    if unit_reuse is not None:
        receipt[UNIT_REUSE_KEY] = copy.deepcopy(unit_reuse)
    receipt["recordSha256"] = receipt_record_digest(receipt)
    return receipt


def evidence_is_done(evidence: dict[str, Any]) -> bool:
    """Return whether detector and membership evidence prove completion."""
    memberships = evidence.get("membership", [])
    return (
        evidence.get("state") == "done"
        and all(
            not item.get("missing", False)
            for item in evidence.get("artifacts", [])
            if isinstance(item, dict)
        )
        and all(item.get("state") == "exact" for item in memberships)
    )
