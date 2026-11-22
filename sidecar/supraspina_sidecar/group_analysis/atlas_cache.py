"""The project's labeling cache, ``.supraspina/analysis/atlases/``.

- ``<atlasId>/<subject>/``: one subject's kept outputs and ``labels.json``
  (schema ``supraspina/atlas-labels``: atlas, recipe and its version, the tool
  identity, argv, the recon inputs with size, mtime, and SHA-256, the recon
  state at the start, the outputs with SHA-256, the parsed measure values,
  and the duration). A subject folder is replaced whole, never edited.
- ``templates/fsaverage5/{hemi}.{atlasId}.annot``: template labels for the
  brain viewer (asset ``atlas/<atlasId>/templates-fsaverage5/<file>``).
- ``_work/<operationId>/``: shadow ``SUBJECTS_DIR`` folders and tool
  outputs of a running operation, swept when the next one starts.
- ``revision.json``: the cache revision ``clearLabels`` names; every
  labeled, imported, or cleared subject bumps it.

Label currency: ``current``; ``stale`` when the recon inputs, the tool
identity, or the recipe version changed; ``provisional`` when the labels
were made while the recon was out of date. Nothing here is under
``derivatives/``, a receipt, or a plan input.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import threading
from collections.abc import Iterable, Mapping
from typing import Any

from ..bounded_io import BoundedReadError, read_bounded_regular, sha256_bounded_regular
from ..paths import flatten, interpolate
from .atlas_recipes import CACHE_DIR, LABELS_SCHEMA, RECIPES, TEMPLATE_DIR, WORK_DIR
from .spec import ATLAS_ID, GroupAnalysisError

LABELS_NAME = "labels.json"
REVISION_NAME = "revision.json"
#: The largest ``labels.json`` a read accepts.
MAX_LABELS_BYTES = 4 * 1024 * 1024
#: The largest recon input or kept output the cache hashes or copies.
MAX_FILE_BYTES = 512 * 1024 * 1024
#: The most entries a tripwire snapshot of one recon folder records.
MAX_TRIPWIRE_ENTRIES = 200_000
SUBJECT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
_RECON_STATES = frozenset({"current", "outdated", "unknown"})
_IS_RUNNING = re.compile(r"IsRunning\.(lh|rh|lh\+rh)")
_LOCK = threading.Lock()


class CacheError(GroupAnalysisError):
    """Reject a cache operation with one operator-safe sentence."""


def cache_root(project_root: str) -> str:
    """Return the project's labeling cache folder."""
    return os.path.join(project_root, *CACHE_DIR)


def work_root(project_root: str) -> str:
    """Return the folder of the operations' shadow folders."""
    return os.path.join(cache_root(project_root), WORK_DIR)


def template_dir(project_root: str) -> str:
    """Return the fsaverage5 template labels folder."""
    return os.path.join(cache_root(project_root), *TEMPLATE_DIR)


def atlas_dir(project_root: str, atlas_id: str) -> str:
    """Return one atlas's cache folder.

    Raises
    ------
    CacheError
        When the atlas ID breaks the grammar or names a reserved folder.
    """
    if not ATLAS_ID.fullmatch(atlas_id) or atlas_id == "templates":
        raise CacheError("Send a valid atlas ID.")
    return os.path.join(cache_root(project_root), atlas_id)


def subject_dir(project_root: str, atlas_id: str, subject_id: str) -> str:
    """Return one subject's cache folder."""
    if not SUBJECT_ID.fullmatch(subject_id):
        raise CacheError("Send valid subject IDs.")
    return os.path.join(atlas_dir(project_root, atlas_id), subject_id)


def ensure_dir(path: str, project_root: str) -> None:
    """Create a cache folder, refusing a symlink anywhere below the project.

    Raises
    ------
    CacheError
        When a component under the project root is a symlink or not a folder.
    """
    root = os.path.abspath(project_root)
    target = os.path.abspath(path)
    if os.path.commonpath([root, target]) != root:
        raise CacheError("The labeling cache must stay inside the project.")
    current = root
    for part in os.path.relpath(target, root).split(os.sep):
        current = os.path.join(current, part)
        try:
            os.mkdir(current, 0o700)
        except FileExistsError:
            pass
        except OSError as exc:
            raise CacheError("The labeling cache folder could not be created.") from exc
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise CacheError("The labeling cache path is not a folder.")


def write_json_atomic(path: str, value: Any) -> None:
    """Replace ``path`` with a JSON document through a synced temporary file."""
    temporary = f"{path}.tmp-{secrets.token_hex(4)}"
    payload = json.dumps(value, sort_keys=True, indent=1, allow_nan=False).encode()
    try:
        with open(temporary, "xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise CacheError("The labeling cache could not be written.") from exc


def read_json(path: str, limit: int = MAX_LABELS_BYTES) -> Any:
    """Return one JSON document, or None when it is absent or unreadable."""
    try:
        return json.loads(read_bounded_regular(path, limit).decode("utf-8"))
    except (BoundedReadError, OSError, UnicodeDecodeError, ValueError):
        return None


# -- Revision ------------------------------------------------------------------------


def revision(project_root: str) -> int:
    """Return the cache revision (0 before any labels)."""
    value = read_json(os.path.join(cache_root(project_root), REVISION_NAME), 4096)
    number = value.get("revision") if isinstance(value, dict) else None
    return number if isinstance(number, int) and number >= 0 else 0


def bump_revision(project_root: str) -> int:
    """Advance the cache revision and return the new value."""
    with _LOCK:
        root = cache_root(project_root)
        ensure_dir(root, project_root)
        number = revision(project_root) + 1
        write_json_atomic(os.path.join(root, REVISION_NAME), {"revision": number})
        return number


# -- Recon folders -------------------------------------------------------------------


def recon_parents(cfg: Mapping[str, Any]) -> list[str]:
    """Return the recon output parents a project's backend writes, in order."""
    paths = cfg.get("paths")
    raw = paths.get("derivativesDir") if isinstance(paths, Mapping) else None
    if not isinstance(raw, str) or not raw:
        return []
    derivatives = interpolate(raw, flatten(dict(cfg)))
    if "${" in derivatives or not os.path.isabs(derivatives):
        return []
    steps = cfg.get("steps")
    recon = steps.get("recon") if isinstance(steps, Mapping) else None
    params = recon.get("params") if isinstance(recon, Mapping) else None
    backend = params.get("backend") if isinstance(params, Mapping) else None
    if backend == "fastsurfer":
        names = ["fastsurfer"]
    elif backend == "auto":
        names = ["freesurfer", "fastsurfer"]
    else:
        names = ["freesurfer"]
    return [os.path.join(derivatives, name) for name in names]


def recon_folder(cfg: Mapping[str, Any], subject_id: str) -> str | None:
    """Return a subject's recon folder, or None when there is none."""
    if not SUBJECT_ID.fullmatch(subject_id):
        return None
    for parent in recon_parents(cfg):
        folder = os.path.join(parent, subject_id)
        if os.path.isdir(folder):
            return folder
    return None


def recon_running(folder: str) -> bool:
    """Say whether a recon folder carries a FreeSurfer ``IsRunning`` marker."""
    try:
        names = os.listdir(os.path.join(folder, "scripts"))
    except OSError:
        return False
    return any(_IS_RUNNING.fullmatch(name) for name in names)


def confined_input(folder: str, relpath: str) -> str:
    """Return the real path of one recon input, confined to the folder.

    Raises
    ------
    CacheError
        When the input is missing, not a regular file, or resolves outside
        the recon folder.
    """
    root = os.path.realpath(folder)
    real = os.path.realpath(os.path.join(folder, relpath))
    if os.path.commonpath([root, real]) != root:
        raise CacheError(
            f"The recon input {relpath} resolves outside the recon folder."
        )
    try:
        info = os.stat(real)
    except OSError as exc:
        raise CacheError(f"The recon input {relpath} is missing.") from exc
    if not stat.S_ISREG(info.st_mode):
        raise CacheError(f"The recon input {relpath} is not a file.")
    return real


def hash_file(path: str) -> dict[str, Any]:
    """Return ``{bytes, mtimeNs, sha256}`` of one bounded regular file."""
    info = os.stat(path)
    digest, size = sha256_bounded_regular(path, MAX_FILE_BYTES)
    return {"bytes": size, "mtimeNs": info.st_mtime_ns, "sha256": digest}


def input_facts(folder: str, relpaths: Iterable[str]) -> list[dict[str, Any]]:
    """Hash the recon inputs one labeling reads.

    Raises
    ------
    CacheError
        When an input is missing or cannot be read.
    """
    rows = []
    for relpath in relpaths:
        real = confined_input(folder, relpath)
        try:
            rows.append({"relpath": relpath, **hash_file(real)})
        except (BoundedReadError, OSError) as exc:
            raise CacheError(f"The recon input {relpath} cannot be read.") from exc
    return rows


def tripwire(folder: str) -> dict[str, tuple[int, int, int]]:
    """Snapshot a recon folder's entries as (type, size, mtime_ns) by name.

    Symlinks are recorded, never followed.

    Raises
    ------
    CacheError
        When the folder cannot be walked or holds too many entries.
    """
    entries: dict[str, tuple[int, int, int]] = {}
    pending = [""]
    try:
        while pending:
            relative = pending.pop()
            with os.scandir(os.path.join(folder, relative)) as iterator:
                for entry in iterator:
                    name = os.path.join(relative, entry.name)
                    info = entry.stat(follow_symlinks=False)
                    entries[name] = (
                        stat.S_IFMT(info.st_mode),
                        info.st_size,
                        info.st_mtime_ns,
                    )
                    if len(entries) > MAX_TRIPWIRE_ENTRIES:
                        raise CacheError(
                            "The recon folder has too many files to watch."
                        )
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(name)
    except OSError as exc:
        raise CacheError("The recon folder cannot be read.") from exc
    return entries


# -- Subject manifests --------------------------------------------------------------


def _valid_manifest(value: Any, atlas_id: str, subject_id: str) -> bool:
    return (
        isinstance(value, dict)
        and value.get("schema") == LABELS_SCHEMA
        and value.get("schemaVersion") == 1
        and value.get("atlasId") == atlas_id
        and value.get("subjectId") == subject_id
        and value.get("provenance") in {"labeled", "imported"}
        and isinstance(value.get("recipeVersion"), int)
        and isinstance(value.get("values"), dict)
        and isinstance(value.get("inputs"), list)
        and all(
            isinstance(key, str)
            and isinstance(number, (int, float))
            and not isinstance(number, bool)
            for key, number in value["values"].items()
        )
    )


def read_labels(
    project_root: str, atlas_id: str, subject_id: str
) -> dict[str, Any] | None:
    """Return one subject's ``labels.json``, or None when absent or invalid."""
    folder = subject_dir(project_root, atlas_id, subject_id)
    value = read_json(os.path.join(folder, LABELS_NAME))
    return value if _valid_manifest(value, atlas_id, subject_id) else None


def labeled_subjects(project_root: str, atlas_id: str) -> list[str]:
    """Return the subjects with a cache folder for one atlas."""
    try:
        names = os.listdir(atlas_dir(project_root, atlas_id))
    except OSError:
        return []
    return sorted(name for name in names if SUBJECT_ID.fullmatch(name))


def store_subject(
    project_root: str,
    atlas_id: str,
    subject_id: str,
    *,
    files: Mapping[str, str],
    manifest: dict[str, Any],
) -> dict[str, Any]:
    """Replace one subject's cache folder with ``files`` and its manifest.

    Parameters
    ----------
    files
        Kept file name -> source path (copied, hashed, never linked).
    manifest
        The ``labels.json`` fields; ``outputs`` is filled in here.

    Returns
    -------
    dict
        The manifest written.
    """
    parent = atlas_dir(project_root, atlas_id)
    ensure_dir(parent, project_root)
    final = subject_dir(project_root, atlas_id, subject_id)
    stage = os.path.join(parent, f".stage-{secrets.token_hex(6)}")
    ensure_dir(stage, project_root)
    try:
        outputs = []
        for name, source in sorted(files.items()):
            if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", name) or name == LABELS_NAME:
                raise CacheError("A labeling output has an invalid name.")
            info = os.lstat(source)
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
                raise CacheError("A labeling output is not a bounded regular file.")
            target = os.path.join(stage, name)
            shutil.copyfile(source, target, follow_symlinks=False)
            digest, size = sha256_bounded_regular(target, MAX_FILE_BYTES)
            outputs.append({"name": name, "bytes": size, "sha256": digest})
        written = {**manifest, "outputs": outputs}
        write_json_atomic(os.path.join(stage, LABELS_NAME), written)
        old = None
        if os.path.lexists(final):
            old = os.path.join(parent, f".old-{secrets.token_hex(6)}")
            os.replace(final, old)
        os.replace(stage, final)
        stage = ""
        if old is not None:
            shutil.rmtree(old, ignore_errors=True)
        return written
    except (BoundedReadError, OSError) as exc:
        raise CacheError("The labeling cache could not be written.") from exc
    finally:
        if stage:
            shutil.rmtree(stage, ignore_errors=True)


def remove_subjects(project_root: str, atlas_id: str, subjects: Iterable[str]) -> int:
    """Remove subjects' cache folders; return how many existed."""
    removed = 0
    for subject_id in subjects:
        folder = subject_dir(project_root, atlas_id, subject_id)
        if os.path.lexists(folder):
            if os.path.islink(folder):
                os.unlink(folder)
            else:
                shutil.rmtree(folder, ignore_errors=True)
            removed += 1
    return removed


def sweep_work(project_root: str, keep: str | None = None) -> None:
    """Remove the shadow folders of finished or interrupted operations."""
    root = work_root(project_root)
    try:
        names = os.listdir(root)
    except OSError:
        names = []
    for name in names:
        if name == keep:
            continue
        path = os.path.join(root, name)
        if os.path.islink(path):
            with contextlib.suppress(OSError):
                os.unlink(path)
        else:
            shutil.rmtree(path, ignore_errors=True)


def sweep_staging(project_root: str) -> None:
    """Remove half-written subject folders left by an interrupted write."""
    root = cache_root(project_root)
    try:
        atlases = os.listdir(root)
    except OSError:
        return
    for atlas in atlases:
        folder = os.path.join(root, atlas)
        if atlas == WORK_DIR or os.path.islink(folder) or not os.path.isdir(folder):
            continue
        with contextlib.suppress(OSError):
            for name in os.listdir(folder):
                if name.startswith((".stage-", ".old-")):
                    shutil.rmtree(os.path.join(folder, name), ignore_errors=True)


# -- Currency -----------------------------------------------------------------------


def _input_changed(folder: str | None, row: Any) -> bool:
    if folder is None or not isinstance(row, dict):
        return True
    relpath = row.get("relpath")
    if not isinstance(relpath, str):
        return True
    try:
        real = confined_input(folder, relpath)
        info = os.stat(real)
    except (CacheError, OSError):
        return True
    if info.st_size == row.get("bytes") and info.st_mtime_ns == row.get("mtimeNs"):
        return False
    try:
        digest, _size = sha256_bounded_regular(real, MAX_FILE_BYTES)
    except (BoundedReadError, OSError):
        return True
    return digest != row.get("sha256")


def _tool_changed(manifest: Mapping[str, Any], tool: Mapping[str, Any] | None) -> bool:
    if manifest.get("provenance") != "labeled" or tool is None:
        return False
    recorded = manifest.get("tool")
    if not isinstance(recorded, dict):
        return True
    if tool.get("freesurferBuild") and recorded.get("freesurferBuild") != tool.get(
        "freesurferBuild"
    ):
        return True
    if manifest.get("recipeId") not in {"brainstem-ss", "hippo-amygdala", "thalamic"}:
        return False
    now = tool.get("interpreter")
    then = recorded.get("interpreter")
    if not isinstance(now, dict):
        return False
    return not isinstance(then, dict) or then.get("python") != now.get("python")


def judge(
    manifest: Mapping[str, Any],
    *,
    recon: str | None,
    tool: Mapping[str, Any] | None,
) -> tuple[str, list[str]]:
    """Judge one subject's labels against the recon, tool, and recipe now.

    Parameters
    ----------
    manifest
        A valid ``labels.json``.
    recon
        The subject's recon folder now, or None when it is gone.
    tool
        The tool identity now, or None when it is unknown (not compared).

    Returns
    -------
    tuple of (str, list of str)
        ``current``, ``provisional``, or ``stale`` and the stale reasons.
    """
    reasons: list[str] = []
    recipe = RECIPES.get(str(manifest.get("recipeId")))
    if any(_input_changed(recon, row) for row in manifest.get("inputs", [])):
        reasons.append("recon-changed")
    if _tool_changed(manifest, tool):
        reasons.append("tool-changed")
    if recipe is None or manifest.get("recipeVersion") != recipe.version:
        reasons.append("recipe-changed")
    if reasons:
        return "stale", reasons
    if manifest.get("reconState") == "outdated":
        return "provisional", []
    return "current", []


def recon_state(value: Any) -> str:
    """Return a valid recon state, ``unknown`` otherwise."""
    return value if value in _RECON_STATES else "unknown"


# -- Values for a compute -----------------------------------------------------------


def label_values(
    project_root: str, atlas_id: str, subject_ids: Iterable[str]
) -> tuple[dict[str, dict[str, float]], str]:
    """Return the cached values of one atlas and their combined digest.

    Parameters
    ----------
    subject_ids
        The included subjects, in order.

    Returns
    -------
    tuple of (dict, str)
        Subject -> measure -> value for the subjects with labels, and the
        SHA-256 recorded as input source ``labels:<atlasId>`` (over each
        subject's ID and ``labels.json`` digest, in order).
    """
    digest = hashlib.sha256()
    values: dict[str, dict[str, float]] = {}
    for subject_id in subject_ids:
        path = os.path.join(
            subject_dir(project_root, atlas_id, subject_id), LABELS_NAME
        )
        try:
            payload = read_bounded_regular(path, MAX_LABELS_BYTES)
        except (BoundedReadError, OSError):
            digest.update(f"{subject_id}\0-\n".encode())
            continue
        manifest = None
        with contextlib.suppress(UnicodeDecodeError, ValueError):
            manifest = json.loads(payload.decode("utf-8"))
        if not _valid_manifest(manifest, atlas_id, subject_id):
            digest.update(f"{subject_id}\0-\n".encode())
            continue
        digest.update(f"{subject_id}\0{hashlib.sha256(payload).hexdigest()}\n".encode())
        values[subject_id] = {
            key: float(number) for key, number in manifest["values"].items()
        }
    return values, digest.hexdigest()
