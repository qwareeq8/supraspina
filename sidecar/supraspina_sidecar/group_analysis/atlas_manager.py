"""The atlas-labeling RPC surface and the labeling lifecycle.

``AtlasLabelingManager`` mirrors ``GroupAnalysisManager``: main attaches the
saved configuration (and, for ``atlases``, ``labelStart``, and
``importAtlas``, the machine-level tools: the ``subregionsPython``
preference and the atlas cache root) to every request; a request for
another project stops the running labeling; one labeling operation runs at
a time, independent of an analysis compute. A labeling is advisory: it is
not in the process-ownership ledger, the switch guard does not count it,
and detach and shutdown stop it (finished subjects keep their labels). It
sweeps stale ``_work`` folders at start, skips subjects whose recon is out
of date or running (an ``IsRunning`` marker), and probes tool facts on its
own thread with a 5 s limit, never through the environment check.

Methods: ``groupAnalysis.atlases``, ``labelStart``, ``labelStatus``,
``labelCancel``, ``clearLabels``, and the main-internal ``importAtlas`` and
``importAtlasLabels``. Everything it writes lives under
``.supraspina/analysis/atlases/`` (or, for an added atlas, the machine cache
main names), never under ``derivatives/``.

The subject scope is the subject registry (read only). ``reconOutdated``
counts the subjects whose recon is running or that the renderer's stage
currency marks out of date (``reconOutdatedSubjectIds``).
"""

from __future__ import annotations

import contextlib
import fnmatch
import glob
import json
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from ..bounded_io import BoundedReadError, sha256_bounded_regular
from ..freesurfer_environment import freesurfer_runtime_environment
from ..freesurfer_license import resolve_freesurfer_home
from ..project import ProjectEpochs, ProjectIdentity
from ..registry_store import RegistryStore
from ..workflow import validate_config_revision
from . import atlas_cache, atlas_recipes, atlas_sources, atlas_tools, atlas_worker
from .atlas_recipes import ATLASES, RECIPES, AtlasFacts
from .dataset import AnalysisContext
from .manager import stage_currency
from .spec import ATLAS_ID, HEMISPHERE_TOKEN_RULES, GroupAnalysisError
from .store import timestamp

_REQUEST_KEYS = frozenset({"project", "cfg", "configRevision", "configSha256"})
_KEYS: dict[str, frozenset[str]] = {
    "atlases": _REQUEST_KEYS | {"machine", "reconOutdatedSubjectIds"},
    "labelStart": _REQUEST_KEYS
    | {"atlasId", "subjects", "jobs", "stageCurrency", "machine"},
    "labelStatus": _REQUEST_KEYS | {"atlasId"},
    "labelCancel": _REQUEST_KEYS | {"operationId"},
    "clearLabels": _REQUEST_KEYS | {"atlasId", "subjects", "expectedRevision"},
    "importAtlas": _REQUEST_KEYS
    | {"paths", "recipeId", "label", "license", "externalSourceId", "machine"},
    "importAtlasLabels": _REQUEST_KEYS | {"path", "atlasId", "machine"},
}
OPERATION_ID = re.compile(r"alb-[a-f0-9]{16}")
_MACHINE_KEYS = frozenset({"subregionsPython", "atlasCacheRoot"})
_MAX_SUBJECTS = 5_000
_MAX_JOBS = 8
_MAX_ADDED = 32
_MAX_IMPORT_FILES = 4
_MAX_ATLAS_FILE_BYTES = 256 * 1024 * 1024
_MAX_EVENT_BYTES = 64 * 1024
_MAX_PATH = 4096
_MAX_LABEL = 120
_MAX_URL = 2048
_REAP_SECONDS = 10.0
#: How long a probed tool report stays fresh, in seconds.
TOOL_REPORT_SECONDS = 30.0
_PRINTABLE = re.compile(r"[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?")
_HTTPS = re.compile(r"https://[A-Za-z0-9.-]+(?::\d{1,5})?(?:/[\x21-\x7e]*)?")
_SUBREGION_FILES: dict[str, dict[str, tuple[str, ...]]] = {
    "brainstem-ss": {
        "brainstemSsLabels.volumes.txt": (
            "brainstemSsLabels.volumes.txt",
            "brainstemSsVolumes*.txt",
            "brainstemSs*olumes*.txt",
        ),
        "brainstemSsLabels.FSvoxelSpace.mgz": (
            "brainstemSsLabels.FSvoxelSpace.mgz",
            "brainstemSsLabels*.FSvoxelSpace.mgz",
        ),
    },
    "thalamic": {
        "ThalamicNuclei.volumes.txt": (
            "ThalamicNuclei.volumes.txt",
            "ThalamicNuclei*olumes*.txt",
        ),
        "ThalamicNuclei.FSvoxelSpace.mgz": (
            "ThalamicNuclei.FSvoxelSpace.mgz",
            "ThalamicNuclei*.FSvoxelSpace.mgz",
        ),
    },
    "hippo-amygdala": {
        f"{hemi}.{name}": (f"{hemi}.{name}", f"{hemi}.{pattern}")
        for hemi in ("lh", "rh")
        for name, pattern in (
            ("hippoSfVolumes.txt", "hippoSfVolumes*.txt"),
            ("amygNucVolumes.txt", "amygNucVolumes*.txt"),
            (
                "hippoAmygLabels.FSvoxelSpace.mgz",
                "hippoAmygLabels*.FSvoxelSpace.mgz",
            ),
        )
    },
}
#: The variant label maps a hippocampal import never takes.
_HIPPO_VARIANTS = (".HBT.", ".FS60.", ".CA.")
#: The recon files that show a recon already has subregion outputs.
_FOUND_SUBREGIONS: dict[str, str] = {
    "brainstem-ss": "mri/*brainstemSs*olumes*.txt",
    "hippo-amygdala": "mri/lh.hippoSfVolumes*.txt",
    "thalamic": "mri/ThalamicNuclei*olumes*.txt",
}
_TIER_A_FILES: dict[str, tuple[str, ...]] = {
    "a2009s": ("stats/lh.aparc.a2009s.stats", "stats/rh.aparc.a2009s.stats"),
    "dkt": ("stats/lh.aparc.DKTatlas.stats", "stats/rh.aparc.DKTatlas.stats"),
    "dkpial": ("stats/lh.aparc.pial.stats", "stats/rh.aparc.pial.stats"),
    "ba": ("stats/lh.BA_exvivo.stats", "stats/rh.BA_exvivo.stats"),
    "bathresh": ("stats/lh.BA_exvivo.thresh.stats", "stats/rh.BA_exvivo.thresh.stats"),
    "gwc": ("stats/lh.w-g.pct.stats", "stats/rh.w-g.pct.stats"),
    "wmparc": ("stats/wmparc.stats",),
    "entowm": ("stats/entowm.stats",),
    "synthseg": ("stats/synthseg.vol.csv",),
    "aseg-global": ("stats/aseg.stats",),
    "dk": ("stats/lh.aparc.stats", "stats/rh.aparc.stats"),
    "aseg": ("stats/aseg.stats",),
}
_ADDED_RECIPES = frozenset({"user-gcs", "user-annot", "user-volume"})
#: The recipes whose outputs Import outputs takes (``IMPORTABLE_RECIPES``).
IMPORTABLE_RECIPES = frozenset(
    {"brainstem-ss", "hippo-amygdala", "thalamic", "user-volume"}
)
#: The refusal for any other atlas, in the button's words.
IMPORT_UNAVAILABLE = (
    "Import outputs is available only for subregion atlases and added "
    "label-map atlases."
)
_WORKER_UNSTARTED = "The labeling worker could not start."
_WORKER_EXITED = "The labeling worker stopped before it finished. Label again."
_TOOLS_PENDING = "The tool check did not finish in 5 seconds."

#: Start one labeling worker from its argv.
Spawn = Callable[[list[str]], "subprocess.Popen[bytes]"]
#: Probe the labeling tools: (FreeSurfer home, subregions Python) -> report.
Probe = Callable[[str | None, str | None], atlas_tools.ToolReport]


def _spawn_worker(argv: list[str]) -> subprocess.Popen[bytes]:
    return subprocess.Popen(  # noqa: S603 - the argv is worker_command().
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


@dataclass
class _Operation:
    """Hold one labeling operation (``AtlasLabelOperation``)."""

    operation_id: str
    project: ProjectIdentity
    atlas_id: str
    started_at: str
    total: int = 0
    completed: int = 0
    failed: int = 0
    skipped: int = 0
    state: str = "running"
    current: dict[str, str] | None = None
    finished_at: str | None = None
    remaining_seconds: int | None = None
    message: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    process: subprocess.Popen[bytes] | None = None
    thread: threading.Thread | None = None
    #: Subject -> {"state", "message", "seconds", "startedAt"}.
    subjects: dict[str, dict[str, Any]] = field(default_factory=dict)
    estimate: int = 0
    jobs: int = 1
    durations: list[float] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return {
            "operationId": self.operation_id,
            "atlasId": self.atlas_id,
            "state": self.state,
            "completed": self.completed,
            "failed": self.failed,
            "skipped": self.skipped,
            "total": self.total,
            "current": self.current,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "remainingSeconds": self.remaining_seconds,
            "message": self.message,
        }


def machine_tools(value: Any) -> dict[str, str | None]:
    """Validate the machine-level tools main attaches.

    Parameters
    ----------
    value
        ``{"subregionsPython": str | None, "atlasCacheRoot": str | None}``.

    Returns
    -------
    dict
        The validated tools.

    Raises
    ------
    GroupAnalysisError
        When a field is missing or not an absolute path.
    """
    if not isinstance(value, dict) or set(value) != _MACHINE_KEYS:
        raise GroupAnalysisError("Send the machine-level analysis tools.")
    for key in _MACHINE_KEYS:
        item = value[key]
        if item is not None and (
            not isinstance(item, str) or not os.path.isabs(item) or len(item) > 4096  # noqa: PLR2004
        ):
            raise GroupAnalysisError("Send the machine-level analysis tools.")
    return {key: value[key] for key in _MACHINE_KEYS}


@dataclass(frozen=True)
class _Atlas:
    """Hold one labelable or listed atlas with its files."""

    facts: AtlasFacts
    #: Absolute paths of an added atlas's files in the machine cache.
    files: tuple[str, ...] = ()
    external_source_id: str | None = None
    license: dict[str, Any] | None = None


# -- Added atlases in the machine cache ------------------------------------------------


def _added_atlases(cache_root: str | None) -> dict[str, _Atlas]:
    """Read the added and downloaded atlases from the machine cache."""
    if not cache_root:
        return {}
    found: dict[str, _Atlas] = {}
    for path in sorted(
        glob.glob(os.path.join(cache_root, "*", "*", atlas_sources.MANIFEST_NAME))
    ):
        manifest = atlas_cache.read_json(path, 1024 * 1024)
        for atlas in _manifest_atlases(manifest, os.path.dirname(path)):
            if len(found) < _MAX_ADDED:
                found.setdefault(atlas.facts.atlas_id, atlas)
    for atlas in _downloaded_atlases(cache_root):
        found.setdefault(atlas.facts.atlas_id, atlas)
    return found


def _downloaded_atlases(cache_root: str) -> list[_Atlas]:
    """Return the atlases of every source main downloaded into the cache.

    A source counts when its ``manifest.json`` names it, its pinned version,
    and ``downloaded``, and every file of an atlas is a regular file of the
    pinned size (the digests are checked again before labeling).
    """
    found: list[_Atlas] = []
    for source in atlas_sources.SOURCES.values():
        if not source.atlas_ids or source.recipe_id not in _ADDED_RECIPES:
            continue
        folder = atlas_sources.cache_dir(cache_root, source.source_id, source.version)
        manifest = atlas_cache.read_json(
            os.path.join(folder, atlas_sources.MANIFEST_NAME), 1024 * 1024
        )
        if (
            not isinstance(manifest, dict)
            or manifest.get("schema") != atlas_sources.CACHE_SCHEMA
            or manifest.get("sourceId") != source.source_id
            or manifest.get("version") != source.version
            or manifest.get("provenance") != "downloaded"
            or not isinstance(manifest.get("license"), dict)
        ):
            continue
        pins = {item.relpath: item for item in source.files}
        for atlas_id in source.atlas_ids:
            relpaths = atlas_sources.atlas_files(source, atlas_id)
            paths = tuple(os.path.join(folder, relpath) for relpath in relpaths)
            if not relpaths or not all(
                _pinned_size(path, pins[relpath].bytes)
                for path, relpath in zip(paths, relpaths, strict=True)
            ):
                continue
            kind = RECIPES[str(source.recipe_id)].kind
            found.append(
                _Atlas(
                    facts=AtlasFacts(
                        atlas_id=atlas_id,
                        label=atlas_sources.atlas_label(source, atlas_id),
                        kind=kind,
                        origin="added",
                        namespace="parc" if kind == "surface" else "vol",
                        source_id=None,
                        recipe_id=source.recipe_id,
                        hemisphere_rules=source.hemisphere_rules,
                        metrics=atlas_recipes.ATLASES["yeo7"].metrics
                        if kind == "surface"
                        else (),
                        citation=source.citation,
                    ),
                    files=paths,
                    external_source_id=source.source_id,
                    license=_license_note(manifest["license"]),
                )
            )
    return found


def _pinned_size(path: str, size: int) -> bool:
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and info.st_size == size


def _check_downloaded(atlas: _Atlas) -> None:
    """Refuse a downloaded atlas whose files no longer match their pins.

    Raises
    ------
    GroupAnalysisError
        When a file's SHA-256 differs from the source's pin.
    """
    source = atlas_sources.SOURCES.get(str(atlas.external_source_id))
    if source is None or atlas.facts.atlas_id not in source.atlas_ids:
        return
    pins = {item.relpath: item.sha256 for item in source.files}
    for path, relpath in zip(
        atlas.files,
        atlas_sources.atlas_files(source, atlas.facts.atlas_id),
        strict=True,
    ):
        try:
            digest, _size = sha256_bounded_regular(path, _MAX_ATLAS_FILE_BYTES)
        except (BoundedReadError, OSError) as exc:
            raise GroupAnalysisError(
                f"The downloaded {source.label} files cannot be read; download "
                "them again."
            ) from exc
        if digest != pins[relpath]:
            raise GroupAnalysisError(
                f"The downloaded {source.label} files changed; download them again."
            )


def _license_note(value: Mapping[str, Any]) -> dict[str, Any]:
    url = value.get("url")
    acknowledged = value.get("acknowledgedAt")
    name = value.get("name")
    return {
        "name": name[:_MAX_LABEL] if isinstance(name, str) and name else "Unstated",
        "url": url if isinstance(url, str) and _HTTPS.fullmatch(url) else None,
        "acknowledgedAt": acknowledged if isinstance(acknowledged, str) else None,
    }


def _manifest_atlases(manifest: Any, folder: str) -> list[_Atlas]:
    """Return the atlases one cache manifest provides (``atlases`` entries)."""
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != atlas_sources.CACHE_SCHEMA
        or not isinstance(manifest.get("atlases"), list)
        or not isinstance(manifest.get("license"), dict)
    ):
        return []
    license_note = _license_note(manifest["license"])
    atlases = []
    for entry in manifest["atlases"][:16]:
        atlas = _entry_atlas(entry, folder, license_note)
        if atlas is not None:
            atlases.append(atlas)
    return atlases


def _entry_atlas(
    entry: Any, folder: str, license_note: dict[str, Any]
) -> _Atlas | None:
    if not isinstance(entry, dict):
        return None
    atlas_id = entry.get("atlasId")
    recipe_id = entry.get("recipeId")
    label = entry.get("label")
    rules = entry.get("hemisphereRules")
    names = entry.get("files")
    if (
        not isinstance(atlas_id, str)
        or not ATLAS_ID.fullmatch(atlas_id)
        or atlas_id in ATLASES
        or recipe_id not in _ADDED_RECIPES
        or not isinstance(label, str)
        or not _PRINTABLE.fullmatch(label)
        or not isinstance(rules, list)
        or not all(rule in HEMISPHERE_TOKEN_RULES for rule in rules)
        or not isinstance(names, list)
        or not all(
            isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9._-]{1,128}", name)
            for name in names
        )
    ):
        return None
    files = tuple(os.path.join(folder, name) for name in names)
    if not all(os.path.isfile(path) and not os.path.islink(path) for path in files):
        return None
    kind = RECIPES[recipe_id].kind
    named = entry.get("externalSourceId")
    external = named if named in atlas_sources.SOURCES else None
    return _Atlas(
        facts=AtlasFacts(
            atlas_id=atlas_id,
            label=label[:_MAX_LABEL],
            kind=kind,
            origin="added",
            namespace="parc" if kind == "surface" else "vol",
            source_id=None,
            recipe_id=recipe_id,
            hemisphere_rules=tuple(rules) or ("none",),
            metrics=atlas_recipes.ATLASES["yeo7"].metrics if kind == "surface" else (),
            citation=atlas_sources.SOURCES[external].citation if external else None,
        ),
        files=files,
        external_source_id=external,
        license=license_note,
    )


def _validate_import_files(recipe_id: str, paths: list[str]) -> list[tuple[str, str]]:
    """Check an added atlas's files; return (source path, cache name) pairs.

    Raises
    ------
    GroupAnalysisError
        When the files do not fit the recipe.
    """
    for path in paths:
        try:
            info = os.lstat(path)
        except OSError as exc:
            raise GroupAnalysisError("Choose files that exist.") from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise GroupAnalysisError("Choose regular files, not links or folders.")
        if info.st_size > _MAX_ATLAS_FILE_BYTES:
            raise GroupAnalysisError("Choose atlas files of at most 256 MB.")
    names = [os.path.basename(path) for path in paths]
    if recipe_id in {"user-gcs", "user-annot"}:
        suffix = ".gcs" if recipe_id == "user-gcs" else ".annot"
        hemis = sorted(name[:3] for name in names)
        if (
            len(paths) != 2  # noqa: PLR2004 - one file per hemisphere.
            or hemis != ["lh.", "rh."]
            or not all(name.endswith(suffix) for name in names)
        ):
            raise GroupAnalysisError(
                f"Choose one lh and one rh {suffix} file (for example "
                f"lh.atlas{suffix} and rh.atlas{suffix})."
            )
        if recipe_id == "user-annot":
            try:
                templates = {atlas_recipes.annot_template(path) for path in paths}
            except ValueError as exc:
                raise GroupAnalysisError(str(exc)) from exc
            if len(templates) != 1:
                raise GroupAnalysisError(
                    "Choose lh and rh annotations on one template."
                )
        return [
            (path, re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.basename(path))[:128])
            for path in paths
        ]
    if len(paths) != 1:
        raise GroupAnalysisError(
            "Choose the atlas's color table; each subject's label map comes in "
            "with Import outputs."
        )
    try:
        atlas_recipes.read_color_table(paths[0])
    except ValueError as exc:
        raise GroupAnalysisError(str(exc)) from exc
    return [(paths[0], "colortable.txt")]


def _recognized(folder: str, patterns: tuple[str, ...], atlas_id: str) -> str | None:
    """Return the first file in ``folder`` or ``folder/mri`` a pattern names."""
    for base in (folder, os.path.join(folder, "mri")):
        try:
            names = sorted(os.listdir(base))
        except OSError:
            continue
        for pattern in patterns:
            for name in names:
                if not fnmatch.fnmatchcase(name, pattern):
                    continue
                if atlas_id == "hippo-amygdala" and any(
                    tag in name for tag in _HIPPO_VARIANTS
                ):
                    continue
                path = os.path.join(base, name)
                if os.path.isfile(path) and not os.path.islink(path):
                    return path
    return None


class AtlasLabelingManager:
    """Serve the atlas catalog, labeling operations, and label imports."""

    def __init__(
        self,
        projects: ProjectEpochs,
        *,
        spawn: Spawn | None = None,
        probe: Probe | None = None,
    ) -> None:
        """Bind the manager to the project ledger and its collaborators.

        Parameters
        ----------
        projects
            The process-wide project identity ledger.
        spawn
            Start a labeling worker; tests replace it.
        probe
            Probe the tool facts; tests replace it.
        """
        self._projects = projects
        self._spawn = spawn or _spawn_worker
        self._probe = probe or atlas_tools.probe_tools
        self._lock = threading.RLock()
        self._operation: _Operation | None = None
        self._reports: dict[
            tuple[str | None, str | None], tuple[float, atlas_tools.ToolReport]
        ] = {}
        self._probing: dict[tuple[str | None, str | None], threading.Thread] = {}

    # -- Requests ----

    def _context(
        self, request: Any, method: str
    ) -> tuple[ProjectIdentity, AnalysisContext]:
        allowed = _KEYS[method]
        if not isinstance(request, dict) or set(request) != allowed:
            raise GroupAnalysisError("Send a valid atlas labeling request.")
        cfg = request.get("cfg")
        if not isinstance(cfg, dict):
            raise GroupAnalysisError("Send the saved project configuration.")
        revision = validate_config_revision(request.get("configRevision", 0))
        project = self._projects.validate(request.get("project"), cfg)
        self._cancel_foreign(project)
        return project, AnalysisContext(
            project_root=project.root, cfg=cfg, config_revision=revision
        )

    @staticmethod
    def _atlas_id(value: Any, *, nullable: bool = False) -> str | None:
        if nullable and value is None:
            return None
        if not isinstance(value, str) or not ATLAS_ID.fullmatch(value):
            raise GroupAnalysisError("Send a valid atlas ID.")
        return value

    @staticmethod
    def _scope(context: AnalysisContext) -> list[str]:
        try:
            records = RegistryStore(context.project_root).list()
        except (ValueError, OSError) as exc:
            raise GroupAnalysisError("The subject registry cannot be read.") from exc
        return sorted(
            str(record["subjectId"])
            for record in records
            if isinstance(record.get("subjectId"), str)
            and atlas_cache.SUBJECT_ID.fullmatch(record["subjectId"])
        )

    # -- Tools ----

    def tool_report(
        self,
        home: str | None,
        python: str | None,
        *,
        wait: float = atlas_tools.PROBE_SECONDS + 0.5,
    ) -> atlas_tools.ToolReport:
        """Return a fresh tool report, probing on its own thread.

        A probe that does not finish within ``wait`` seconds keeps running;
        until it does, the report says the check did not finish.
        """
        key = (home, python)
        with self._lock:
            cached = self._reports.get(key)
            if (
                cached is not None
                and time.monotonic() - cached[0] < TOOL_REPORT_SECONDS
            ):
                return cached[1]
            thread = self._probing.get(key)
            if thread is None or not thread.is_alive():

                def probe() -> None:
                    try:
                        report = self._probe(home, python)
                    except Exception:  # A failed probe reads as unknown tools.
                        report = _unknown_report("The tool check stopped on an error.")
                    with self._lock:
                        self._reports[key] = (time.monotonic(), report)
                        self._probing.pop(key, None)

                thread = threading.Thread(target=probe, name="atlas-tools", daemon=True)
                self._probing[key] = thread
                thread.start()
        thread.join(wait)
        with self._lock:
            cached = self._reports.get(key)
        return cached[1] if cached is not None else _unknown_report(_TOOLS_PENDING)

    # -- Atlases ----

    def _atlas(self, atlas_id: str, machine: Mapping[str, Any] | None) -> _Atlas:
        facts = ATLASES.get(atlas_id)
        if facts is not None:
            return _Atlas(facts=facts)
        added = _added_atlases(machine["atlasCacheRoot"] if machine else None)
        if atlas_id in added:
            return added[atlas_id]
        raise GroupAnalysisError("Choose an atlas this project lists.")

    def _subject_state(
        self,
        context: AnalysisContext,
        atlas: _Atlas,
        subject_id: str,
        tool: Mapping[str, Any] | None,
        recons: dict[str, str | None],
    ) -> dict[str, Any]:
        """Return one subject's ``SubjectLabelStatus`` from the cache."""
        atlas_id = atlas.facts.atlas_id
        row: dict[str, Any] = {
            "subjectId": subject_id,
            "state": "missing",
            "staleReasons": [],
            "provenance": None,
            "updatedAt": None,
            "seconds": None,
            "message": None,
        }
        manifest = atlas_cache.read_labels(context.project_root, atlas_id, subject_id)
        if manifest is not None and not manifest.get("mapOnly"):
            if subject_id not in recons:
                recons[subject_id] = atlas_cache.recon_folder(context.cfg, subject_id)
            state, reasons = atlas_cache.judge(
                manifest, recon=recons[subject_id], tool=tool
            )
            seconds = manifest.get("seconds")
            row.update(
                state=state,
                staleReasons=reasons,
                provenance=manifest["provenance"],
                updatedAt=manifest.get("finishedAt")
                if isinstance(manifest.get("finishedAt"), str)
                else None,
                seconds=round(seconds)
                if isinstance(seconds, (int, float))
                and not isinstance(seconds, bool)
                and seconds >= 0
                else None,
            )
        with self._lock:
            operation = self._operation
            live = (
                operation.subjects.get(subject_id)
                if operation is not None
                and operation.atlas_id == atlas_id
                and operation.project.root == context.project_root
                else None
            )
            if live is not None:
                live = dict(live)
        if live is not None:
            if (
                live["state"] in {"queued", "running"}
                and operation is not None
                and operation.state == "running"
            ):
                row.update(state=live["state"], message=None)
            elif live["state"] in {"failed", "skipped"}:
                row.update(state=live["state"], message=live.get("message"))
                if live.get("seconds") is not None:
                    row["seconds"] = round(live["seconds"])
        return row

    def _rows(
        self,
        context: AnalysisContext,
        atlas: _Atlas,
        scope: list[str],
        tool: Mapping[str, Any] | None,
    ) -> list[dict[str, Any]]:
        recons: dict[str, str | None] = {}
        return [
            self._subject_state(context, atlas, subject, tool, recons)
            for subject in scope
        ]

    def _entry(
        self,
        context: AnalysisContext,
        atlas: _Atlas,
        scope: list[str],
        report: atlas_tools.ToolReport,
        running: int,
    ) -> dict[str, Any]:
        facts = atlas.facts
        tier = "A" if facts.recipe_id is None else "B"
        counts = {
            "total": len(scope),
            "withFiles": 0,
            "labeled": 0,
            "stale": 0,
            "failed": 0,
            "reconOutdated": running,
        }
        recons = {
            subject: atlas_cache.recon_folder(context.cfg, subject) for subject in scope
        }
        pattern = _FOUND_SUBREGIONS.get(facts.atlas_id)
        files = _TIER_A_FILES.get(facts.atlas_id, ())
        for subject, recon in recons.items():
            if recon is None:
                continue
            if pattern is not None and glob.glob(
                os.path.join(glob.escape(recon), pattern)
            ):
                counts["withFiles"] += 1
            elif files and all(
                os.path.isfile(os.path.join(recon, name)) for name in files
            ):
                counts["withFiles"] += 1
            del subject
        estimate: int | None = None
        available = True
        reason: str | None = None
        if tier == "B":
            tool = report.identity() if report.build is not None else None
            rows = self._rows(context, atlas, scope, tool)
            for row in rows:
                if row["state"] in {"current", "provisional"}:
                    counts["labeled"] += 1
                elif row["state"] == "stale":
                    counts["stale"] += 1
                elif row["state"] == "failed":
                    counts["failed"] += 1
            recipe = RECIPES[str(facts.recipe_id)]
            blocked = atlas_tools.recipe_ready(report, recipe.tools)
            missing = sum(1 for row in rows if row["state"] in {"missing", "failed"})
            if blocked is None:
                estimate = missing * recipe.estimate_seconds
            elif counts["labeled"] + counts["stale"] + counts["withFiles"] == 0:
                available, reason = False, blocked
        elif counts["withFiles"] == 0:
            available = False
            reason = "No subject has these FreeSurfer stats files yet."
        return {
            "atlasId": facts.atlas_id,
            "label": facts.label,
            "tier": tier,
            "kind": facts.kind,
            "origin": facts.origin,
            "namespace": facts.namespace,
            "recipeId": facts.recipe_id,
            "externalSourceId": atlas.external_source_id,
            "available": available,
            "unavailableReason": reason,
            "counts": counts,
            "estimateSeconds": estimate,
            "license": atlas.license,
            "citation": facts.citation,
        }

    def atlases(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return the project's atlas catalog (``groupAnalysis.atlases``)."""
        project, context = self._context(request, "atlases")
        machine = machine_tools(request["machine"])
        report = self.tool_report(
            resolve_freesurfer_home(dict(context.cfg)) or None,
            machine["subregionsPython"],
        )
        outdated = self._subject_ids(request["reconOutdatedSubjectIds"])
        scope = self._scope(context)
        running = sum(
            1
            for subject in scope
            if subject in outdated
            or (
                (folder := atlas_cache.recon_folder(context.cfg, subject)) is not None
                and atlas_cache.recon_running(folder)
            )
        )
        listed = [_Atlas(facts=facts) for facts in atlas_recipes.BUILT_IN_ATLASES]
        listed.extend(_added_atlases(machine["atlasCacheRoot"]).values())
        entries = [
            self._entry(context, atlas, scope, report, running) for atlas in listed
        ]
        with self._lock:
            operation = self._operation
            labeling = (
                operation.public()
                if operation is not None and self._owns(operation, project)
                else None
            )
        return {
            "configRevision": context.config_revision,
            "revision": atlas_cache.revision(context.project_root),
            "atlases": entries,
            "tools": report.facts,
            "subregionsPython": machine["subregionsPython"],
            "labeling": labeling,
        }

    # -- Labeling ----

    @staticmethod
    def _subject_ids(value: Any) -> set[str]:
        if (
            isinstance(value, list)
            and len(value) <= _MAX_SUBJECTS
            and all(
                isinstance(item, str) and atlas_cache.SUBJECT_ID.fullmatch(item)
                for item in value
            )
        ):
            return set(value)
        raise GroupAnalysisError("Send the out-of-date subjects as subject IDs.")

    @staticmethod
    def _subjects_request(value: Any, *, clearing: bool) -> str | list[str]:
        keywords = {"all"} if clearing else {"missing", "stale"}
        if isinstance(value, str) and value in keywords:
            return value
        if (
            isinstance(value, list)
            and 0 < len(value) <= _MAX_SUBJECTS
            and all(
                isinstance(item, str) and atlas_cache.SUBJECT_ID.fullmatch(item)
                for item in value
            )
            and len(set(value)) == len(value)
        ):
            return list(value)
        raise GroupAnalysisError("Name the subjects to label, each once.")

    def label_start(self, request: dict[str, Any]) -> dict[str, Any]:  # noqa: PLR0912, PLR0915
        """Start labeling one atlas and return at once (``labelStart``).

        ``dkt`` labels only its fsaverage5 template for the viewer; an added
        gcs atlas labels its template first, then the subjects.
        """
        project, context = self._context(request, "labelStart")
        atlas_id = str(self._atlas_id(request["atlasId"]))
        machine = machine_tools(request["machine"])
        currency = stage_currency(request["stageCurrency"])
        jobs = request["jobs"]
        if (
            isinstance(jobs, bool)
            or not isinstance(jobs, int)
            or not 1 <= jobs <= _MAX_JOBS
        ):
            raise GroupAnalysisError("Choose 1 to 8 parallel labeling jobs.")
        wanted = self._subjects_request(request["subjects"], clearing=False)
        template_only = atlas_id in atlas_recipes.TEMPLATE_GCS_ATLASES
        atlas = (
            _Atlas(facts=ATLASES[atlas_id])
            if template_only
            else self._atlas(atlas_id, machine)
        )
        _check_downloaded(atlas)
        recipe_id = "template-fsaverage5" if template_only else atlas.facts.recipe_id
        if recipe_id is None:
            raise GroupAnalysisError(
                "This atlas is read from each subject's FreeSurfer stats; "
                "it needs no labeling."
            )
        home = resolve_freesurfer_home(dict(context.cfg)) or None
        report = self.tool_report(home, machine["subregionsPython"])
        blocked = atlas_tools.recipe_ready(report, RECIPES[recipe_id].tools)
        if blocked is not None:
            raise GroupAnalysisError(blocked)
        interpreter = atlas_tools.subregions_interpreter(
            report, machine["subregionsPython"]
        )
        scope = self._scope(context)
        subjects: list[str] = []
        if not template_only:
            tool = report.identity()
            if isinstance(wanted, list):
                unknown = [subject for subject in wanted if subject not in scope]
                if unknown:
                    raise GroupAnalysisError(
                        "Label only subjects in this project's registry."
                    )
                subjects = wanted
            else:
                states = (
                    {"missing", "failed", "skipped"}
                    if wanted == "missing"
                    else {"stale"}
                )
                subjects = [
                    row["subjectId"]
                    for row in self._rows(context, atlas, scope, tool)
                    if row["state"] in states
                ]
            if not subjects:
                raise GroupAnalysisError(
                    "No subject needs labeling."
                    if wanted == "missing"
                    else "No subject has out-of-date labels."
                    if wanted == "stale"
                    else "Name the subjects to label, each once."
                )
        recon = currency.get("recon")
        outdated = (
            set(recon["outdatedSubjectIds"]) if isinstance(recon, dict) else set()
        )
        pre_skipped: dict[str, str] = {}
        recon_dirs: dict[str, str] = {}
        for subject in subjects:
            folder = atlas_cache.recon_folder(context.cfg, subject)
            if folder is None:
                pre_skipped[subject] = "No reconstruction was found for this subject."
            elif subject in outdated:
                pre_skipped[subject] = "The reconstruction is out of date."
            elif atlas_cache.recon_running(folder):
                pre_skipped[subject] = "The reconstruction is running."
            elif recipe_id == "user-volume" and not os.path.isfile(
                os.path.join(
                    atlas_cache.subject_dir(context.project_root, atlas_id, subject),
                    f"{atlas_id}.mgz",
                )
            ):
                pre_skipped[subject] = "No label map was imported for this subject."
            else:
                recon_dirs[subject] = folder
        recon_state = recon["state"] if isinstance(recon, dict) else "unknown"
        template = template_only or recipe_id in {"user-gcs", "user-annot"}
        job = {
            "schema": atlas_worker.JOB_SCHEMA,
            "schemaVersion": 1,
            "operationId": "",
            "projectRoot": context.project_root,
            "atlasId": atlas_id,
            "recipeId": recipe_id,
            "subjects": [subject for subject in subjects if subject in recon_dirs],
            "jobs": jobs,
            "freesurferHome": home or "",
            "subregionsPython": interpreter,
            "atlasFiles": list(atlas.files),
            "reconStates": {
                subject: ("current" if recon_state == "current" else "unknown")
                for subject in recon_dirs
            },
            "reconDirs": recon_dirs,
            "environment": freesurfer_runtime_environment(dict(context.cfg)),
            "tool": report.identity(),
            "hemisphereRules": list(atlas.facts.hemisphere_rules),
            "template": template,
        }
        with self._lock:
            running = self._operation
            if running is not None and running.state == "running":
                if self._owns(running, project):
                    return {"operation": running.public(), "started": False}
                self._stop(running, "The project changed.")
            operation = _Operation(
                operation_id=f"alb-{secrets.token_hex(8)}",
                project=project,
                atlas_id=atlas_id,
                started_at=timestamp(),
                total=len(subjects) + (1 if template else 0),
                estimate=RECIPES[recipe_id].estimate_seconds,
                jobs=jobs,
            )
            job["operationId"] = operation.operation_id
            for subject in subjects:
                if subject in pre_skipped:
                    operation.subjects[subject] = {
                        "state": "skipped",
                        "message": pre_skipped[subject],
                        "seconds": None,
                    }
                    operation.skipped += 1
                else:
                    operation.subjects[subject] = {
                        "state": "queued",
                        "message": None,
                        "seconds": None,
                    }
            self._estimate(operation)
            self._operation = operation
            thread = threading.Thread(
                target=self._run,
                args=(operation, job),
                name="atlas-labeling",
                daemon=True,
            )
            operation.thread = thread
            thread.start()
        return {"operation": operation.public(), "started": True}

    def label_status(self, request: dict[str, Any]) -> dict[str, Any]:
        """Report the operation and one atlas's subject states (``labelStatus``)."""
        project, context = self._context(request, "labelStatus")
        atlas_id = self._atlas_id(request["atlasId"], nullable=True)
        with self._lock:
            operation = self._operation
            owned = operation is not None and self._owns(operation, project)
            public = operation.public() if owned and operation is not None else None
        shown = atlas_id if atlas_id is not None else (public or {}).get("atlasId")
        if shown is None:
            return {"operation": public, "atlasId": None, "subjects": []}
        if shown in ATLASES and ATLASES[shown].recipe_id is not None:
            atlas = _Atlas(facts=ATLASES[shown])
        elif shown not in ATLASES and (
            os.path.isdir(atlas_cache.atlas_dir(context.project_root, shown))
            or (public or {}).get("atlasId") == shown
        ):
            # An added atlas: rows need only its ID; each manifest names its
            # recipe (the request carries no machine cache to read).
            atlas = _Atlas(
                facts=AtlasFacts(
                    shown,
                    shown,
                    "volume",
                    "added",
                    "vol",
                    None,
                    "user-volume",
                    ("none",),
                    (),
                )
            )
        else:
            return {"operation": public, "atlasId": shown, "subjects": []}
        cached = self._cached_identity(context)
        rows = self._rows(context, atlas, self._scope(context), cached)
        return {"operation": public, "atlasId": shown, "subjects": rows}

    def _cached_identity(self, context: AnalysisContext) -> dict[str, Any] | None:
        """Return the newest probed tool identity for this FreeSurfer, if any."""
        home = resolve_freesurfer_home(dict(context.cfg)) or None
        with self._lock:
            reports = [value for key, value in self._reports.items() if key[0] == home]
        if not reports:
            return None
        report = max(reports, key=lambda item: item[0])[1]
        return report.identity() if report.build is not None else None

    def label_cancel(self, request: dict[str, Any]) -> dict[str, Any]:
        """Stop the project's labeling; finished subjects keep their labels."""
        project, _context = self._context(request, "labelCancel")
        operation_id = request["operationId"]
        if not isinstance(operation_id, str) or not OPERATION_ID.fullmatch(
            operation_id
        ):
            raise GroupAnalysisError("Send a valid labeling operation ID.")
        with self._lock:
            operation = self._operation
            if (
                operation is None
                or operation.operation_id != operation_id
                or not self._owns(operation, project)
                or operation.state != "running"
            ):
                return {"operationId": operation_id, "stopped": False}
            self._stop(operation, None)
        return {"operationId": operation_id, "stopped": True}

    def clear_labels(self, request: dict[str, Any]) -> dict[str, Any]:
        """Remove cached labels of one atlas (``clearLabels``)."""
        project, context = self._context(request, "clearLabels")
        atlas_id = str(self._atlas_id(request["atlasId"]))
        subjects = self._subjects_request(request["subjects"], clearing=True)
        expected = request["expectedRevision"]
        if isinstance(expected, bool) or not isinstance(expected, int) or expected < 0:
            raise GroupAnalysisError("Send the labeling cache revision.")
        with self._lock:
            operation = self._operation
            if (
                operation is not None
                and operation.state == "running"
                and self._owns(operation, project)
                and operation.atlas_id == atlas_id
            ):
                raise GroupAnalysisError(
                    "Stop the labeling of this atlas before clearing it."
                )
            if atlas_cache.revision(context.project_root) != expected:
                raise GroupAnalysisError(
                    "The labels changed since they were shown. "
                    "Review them and clear again."
                )
            names = (
                atlas_cache.labeled_subjects(context.project_root, atlas_id)
                if subjects == "all"
                else subjects
            )
            cleared = atlas_cache.remove_subjects(context.project_root, atlas_id, names)
            if subjects == "all":
                for name in atlas_recipes.expand("{hemi}.{atlas}.annot", atlas_id):
                    with contextlib.suppress(OSError):
                        os.unlink(
                            os.path.join(
                                atlas_cache.template_dir(context.project_root), name
                            )
                        )
            revision = (
                atlas_cache.bump_revision(context.project_root)
                if cleared
                else atlas_cache.revision(context.project_root)
            )
        return {"revision": revision, "cleared": cleared}

    # -- Imports ----

    def import_atlas(self, request: dict[str, Any]) -> dict[str, Any]:
        """Add an atlas from operator-chosen files (main-internal ``importAtlas``).

        The files are copied into ``<atlasCacheRoot>/user-<hex8>/imported/``
        with a ``manifest.json`` that records each file's SHA-256, the
        license the operator confirmed, and the atlas facts.
        """
        _project, context = self._context(request, "importAtlas")
        machine = machine_tools(request["machine"])
        cache_root = machine["atlasCacheRoot"]
        if not cache_root:
            raise GroupAnalysisError("The machine's atlas folder is not set.")
        paths = request["paths"]
        if (
            not isinstance(paths, list)
            or not 1 <= len(paths) <= _MAX_IMPORT_FILES
            or not all(
                isinstance(path, str) and os.path.isabs(path) and len(path) <= _MAX_PATH
                for path in paths
            )
            or len(set(paths)) != len(paths)
        ):
            raise GroupAnalysisError("Choose the atlas files to add.")
        recipe_id = request["recipeId"]
        if recipe_id not in _ADDED_RECIPES:
            raise GroupAnalysisError("Choose how the atlas labels subjects.")
        label = request["label"]
        if (
            not isinstance(label, str)
            or not _PRINTABLE.fullmatch(label)
            or len(label) > _MAX_LABEL
        ):
            raise GroupAnalysisError("Name the atlas in at most 120 characters.")
        license_value = request["license"]
        if (
            not isinstance(license_value, dict)
            or set(license_value) != {"name", "url"}
            or not isinstance(license_value["name"], str)
            or not _PRINTABLE.fullmatch(license_value["name"])
            or len(license_value["name"]) > _MAX_LABEL
            or not (
                license_value["url"] is None
                or (
                    isinstance(license_value["url"], str)
                    and _HTTPS.fullmatch(license_value["url"])
                    and len(license_value["url"]) <= _MAX_URL
                )
            )
        ):
            raise GroupAnalysisError(
                "Confirm the atlas license by name (and https link)."
            )
        external = request["externalSourceId"]
        if external is not None and external not in atlas_sources.SOURCES:
            raise GroupAnalysisError("Choose a listed atlas source, or none.")
        files = _validate_import_files(recipe_id, paths)
        if len(_added_atlases(cache_root)) >= _MAX_ADDED:
            raise GroupAnalysisError("Remove an added atlas before adding another.")
        atlas_id = f"user-{secrets.token_hex(4)}"
        folder = atlas_sources.cache_dir(cache_root, atlas_id, "imported")
        rules = (
            list(atlas_sources.SOURCES[external].hemisphere_rules)
            if external is not None
            else [
                "lh-rh-underscore-infix",
                "l-r-underscore-suffix",
                "lh-rh-dot-prefix",
                "left-right-prefix",
                "none",
            ]
        )
        now = timestamp()
        try:
            os.makedirs(folder, mode=0o700)
            rows = []
            for source, name in files:
                target = os.path.join(folder, name)
                shutil.copyfile(source, target, follow_symlinks=False)
                digest, size = sha256_bounded_regular(target, _MAX_ATLAS_FILE_BYTES)
                rows.append(
                    {"relpath": name, "url": None, "sha256": digest, "bytes": size}
                )
            manifest = {
                "schema": atlas_sources.CACHE_SCHEMA,
                "schemaVersion": 1,
                "sourceId": atlas_id,
                "version": "imported",
                "provenance": "imported",
                "files": rows,
                "license": {
                    "name": license_value["name"],
                    "url": license_value["url"],
                    "acknowledgedAt": now,
                },
                "retrievedAt": now,
                "atlases": [
                    {
                        "atlasId": atlas_id,
                        "label": label,
                        "kind": RECIPES[recipe_id].kind,
                        "recipeId": recipe_id,
                        "externalSourceId": external,
                        "hemisphereRules": rules,
                        "files": [name for _source, name in files],
                    }
                ],
            }
            atlas_cache.write_json_atomic(
                os.path.join(folder, atlas_sources.MANIFEST_NAME), manifest
            )
        except (OSError, BoundedReadError, GroupAnalysisError) as exc:
            shutil.rmtree(os.path.dirname(folder), ignore_errors=True)
            raise GroupAnalysisError("The atlas files could not be copied.") from exc
        atlas = next(iter(_manifest_atlases(manifest, folder)), None)
        # A copied file can vanish before the manifest is read back.
        if atlas is None:
            raise GroupAnalysisError("The atlas files could not be copied.")
        report = self.tool_report(
            resolve_freesurfer_home(dict(context.cfg)) or None,
            machine["subregionsPython"],
        )
        return {"atlas": self._entry(context, atlas, self._scope(context), report, 0)}

    def import_atlas_labels(self, request: dict[str, Any]) -> dict[str, Any]:
        """Import existing labeling outputs (main-internal ``importAtlasLabels``).

        ``path`` holds one folder per subject (named by subject ID), with the
        outputs in it or in its ``mri/`` folder: FreeSurfer 7 and 8
        subregion names, or one ``.mgz`` label map for an added volume atlas.
        Recognized files are copied under the recipe's names with provenance
        ``imported``; the recon inputs are hashed so later recon changes
        mark the labels stale.
        """
        project, context = self._context(request, "importAtlasLabels")
        atlas_id = str(self._atlas_id(request["atlasId"]))
        machine = machine_tools(request["machine"])
        path = request["path"]
        if not isinstance(path, str) or not os.path.isabs(path) or len(path) > 4096:  # noqa: PLR2004
            raise GroupAnalysisError("Choose the folder of labeling outputs.")
        # An added atlas's recipe comes from the machine cache: only its
        # label maps import, never a surface classifier or annotation.
        recipe_id = self._atlas(atlas_id, machine).facts.recipe_id
        if recipe_id not in IMPORTABLE_RECIPES:
            raise GroupAnalysisError(IMPORT_UNAVAILABLE)
        if not os.path.isdir(path):
            raise GroupAnalysisError("Choose a folder of labeling outputs.")
        with self._lock:
            operation = self._operation
            if (
                operation is not None
                and operation.state == "running"
                and self._owns(operation, project)
                and operation.atlas_id == atlas_id
            ):
                raise GroupAnalysisError(
                    "Stop the labeling of this atlas before importing."
                )
        scope = set(self._scope(context))
        rules = ATLASES[atlas_id].hemisphere_rules if atlas_id in ATLASES else ("none",)
        imported = 0
        unrecognized: list[str] = []
        try:
            children = sorted(os.listdir(path))
        except OSError as exc:
            raise GroupAnalysisError("The folder cannot be read.") from exc
        for subject in children[: _MAX_SUBJECTS * 4]:
            folder = os.path.join(path, subject)
            if (
                subject not in scope
                or os.path.islink(folder)
                or not os.path.isdir(folder)
            ):
                continue
            files = self._import_files(str(recipe_id), atlas_id, folder)
            if files is None:
                unrecognized.append(subject)
                continue
            try:
                self._store_import(
                    context,
                    atlas_id,
                    str(recipe_id),
                    subject,
                    files,
                    rules,
                    os.path.basename(path),
                )
            except (ValueError, OSError):
                unrecognized.append(subject)
                continue
            imported += 1
        if imported:
            atlas_cache.bump_revision(context.project_root)
        return {
            "atlasId": atlas_id,
            "imported": imported,
            "unrecognized": unrecognized[:_MAX_SUBJECTS],
        }

    @staticmethod
    def _import_files(
        recipe_id: str, atlas_id: str, folder: str
    ) -> dict[str, str] | None:
        if recipe_id == "user-volume":
            maps = [
                name
                for name in sorted(os.listdir(folder))
                if name.endswith(".mgz")
                and os.path.isfile(os.path.join(folder, name))
                and not os.path.islink(os.path.join(folder, name))
            ]
            return (
                {f"{atlas_id}.mgz": os.path.join(folder, maps[0])}
                if len(maps) == 1
                else None
            )
        files: dict[str, str] = {}
        for name, patterns in _SUBREGION_FILES[recipe_id].items():
            found = _recognized(folder, patterns, atlas_id)
            if found is not None:
                files[name] = found
            elif name.endswith(".txt"):
                return None
        return files

    @staticmethod
    def _store_import(  # noqa: PLR0913 - keyword facts of one subject.
        context: AnalysisContext,
        atlas_id: str,
        recipe_id: str,
        subject: str,
        files: dict[str, str],
        rules: tuple[str, ...],
        source: str,
    ) -> None:
        recon = atlas_cache.recon_folder(context.cfg, subject)
        inputs: list[dict[str, Any]] = []
        if recon is not None:
            with contextlib.suppress(GroupAnalysisError):
                inputs = atlas_cache.input_facts(
                    recon, atlas_recipes.recipe_inputs(recipe_id, atlas_id)
                )
        map_only = recipe_id == "user-volume"
        values: dict[str, float] = {}
        if not map_only:
            stage = os.path.join(
                atlas_cache.work_root(context.project_root),
                f"import-{secrets.token_hex(6)}",
            )
            atlas_cache.ensure_dir(stage, context.project_root)
            try:
                for name, found in files.items():
                    if name.endswith(".txt"):
                        shutil.copyfile(
                            found, os.path.join(stage, name), follow_symlinks=False
                        )
                values = atlas_recipes.parse_outputs(recipe_id, atlas_id, stage, rules)
            finally:
                shutil.rmtree(stage, ignore_errors=True)
        now = timestamp()
        atlas_cache.store_subject(
            context.project_root,
            atlas_id,
            subject,
            files=files,
            manifest={
                "schema": atlas_recipes.LABELS_SCHEMA,
                "schemaVersion": 1,
                "atlasId": atlas_id,
                "subjectId": subject,
                "recipeId": recipe_id,
                "recipeVersion": RECIPES[recipe_id].version,
                "provenance": "imported",
                "tool": {"freesurferBuild": None, "interpreter": None},
                "argv": [],
                "inputs": inputs,
                "atlasFiles": [],
                "reconState": "unknown",
                "values": values,
                "mapOnly": map_only,
                "startedAt": now,
                "finishedAt": now,
                "seconds": None,
                "source": source[:255],
            },
        )

    def stop_all(self, timeout: float = 0.0) -> None:
        """Stop any labeling, for a project detach or sidecar shutdown."""
        with self._lock:
            operation = self._operation
            if operation is not None and operation.state == "running":
                self._stop(operation, None)
        thread = operation.thread if operation is not None else None
        if thread is not None and timeout > 0:
            thread.join(timeout)

    # -- Operation ----

    @staticmethod
    def _owns(operation: _Operation, project: ProjectIdentity) -> bool:
        return (
            operation.project.project_id == project.project_id
            and operation.project.root == project.root
        )

    def _cancel_foreign(self, project: ProjectIdentity) -> None:
        with self._lock:
            operation = self._operation
            if (
                operation is not None
                and operation.state == "running"
                and not self._owns(operation, project)
            ):
                self._stop(operation, "The project changed.")

    def _stop(self, operation: _Operation, message: str | None) -> None:
        operation.cancel.set()
        operation.state = "cancelled"
        operation.current = None
        operation.message = message
        operation.finished_at = timestamp()
        operation.remaining_seconds = None
        for row in operation.subjects.values():
            if row["state"] in {"queued", "running"}:
                row["state"] = "missing"
        process = operation.process
        if process is not None and process.poll() is None:
            with contextlib.suppress(OSError):
                os.killpg(process.pid, signal.SIGKILL)

    @staticmethod
    def _estimate(operation: _Operation) -> None:
        left = sum(
            1
            for row in operation.subjects.values()
            if row["state"] in {"queued", "running"}
        )
        each = (
            sum(operation.durations) / len(operation.durations)
            if operation.durations
            else operation.estimate
        )
        operation.remaining_seconds = round(left * each / max(1, operation.jobs))

    def _finish(self, operation: _Operation, state: str, message: str | None) -> None:
        with self._lock:
            if operation.state != "running":
                return
            operation.state = state
            operation.message = message
            operation.current = None
            operation.remaining_seconds = None if state != "done" else 0
            operation.finished_at = timestamp()
            for row in operation.subjects.values():
                if row["state"] in {"queued", "running"}:
                    row["state"] = "missing"

    def _run(self, operation: _Operation, job: dict[str, Any]) -> None:  # noqa: PLR0912
        """Run one worker and track it to the end; always reap it."""
        root = operation.project.root
        process: subprocess.Popen[bytes] | None = None
        try:
            with contextlib.suppress(OSError, GroupAnalysisError):
                atlas_cache.sweep_work(root)
                atlas_cache.sweep_staging(root)
            if not job["subjects"] and not job["template"]:
                self._finish(operation, "done", None)
                return
            try:
                process = self._spawn(atlas_worker.worker_command())
            except OSError:
                self._finish(operation, "failed", _WORKER_UNSTARTED)
                return
            with self._lock:
                operation.process = process
                if operation.state != "running":
                    with contextlib.suppress(OSError):
                        os.killpg(process.pid, signal.SIGKILL)
            payload = json.dumps(job, allow_nan=False).encode("utf-8")
            stdin = process.stdin
            if stdin is not None:
                with contextlib.suppress(OSError):
                    stdin.write(payload)
                with contextlib.suppress(OSError):
                    stdin.close()
            outcome = self._follow(operation, process)
            process.wait()
            if outcome is None:
                self._finish(operation, "failed", _WORKER_EXITED)
            elif outcome[0] == "done":
                self._finish(operation, "done", None)
            else:
                self._finish(operation, "failed", outcome[1])
        except Exception:  # One operator-safe sentence, never a trace.
            self._finish(
                operation,
                "failed",
                _WORKER_UNSTARTED if process is None else _WORKER_EXITED,
            )
        finally:
            if process is not None:
                with contextlib.suppress(OSError):
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGKILL)
                with contextlib.suppress(subprocess.TimeoutExpired, OSError):
                    process.wait(_REAP_SECONDS)
                for stream in (process.stdin, process.stdout):
                    if stream is not None:
                        with contextlib.suppress(OSError):
                            stream.close()
            with contextlib.suppress(OSError):
                shutil.rmtree(
                    os.path.join(atlas_cache.work_root(root), operation.operation_id),
                    ignore_errors=True,
                )

    def _follow(
        self, operation: _Operation, process: subprocess.Popen[bytes]
    ) -> tuple[str, str | None] | None:
        stdout = process.stdout
        if stdout is None:
            return None
        while True:
            line = stdout.readline(_MAX_EVENT_BYTES)
            if not line:
                return None
            try:
                event = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                continue
            if not isinstance(event, dict):
                continue
            kind = event.get("event")
            if kind == "subject":
                self._subject_event(operation, event)
            elif kind == "template":
                self._template_event(operation, event)
            elif kind == "done":
                return ("done", None)
            elif kind == "failed":
                text = event.get("message")
                return (
                    "failed",
                    text[:512] if isinstance(text, str) and text else _WORKER_EXITED,
                )

    def _template_event(self, operation: _Operation, event: Mapping[str, Any]) -> None:
        with self._lock:
            if operation.state != "running":
                return
            if event.get("state") == "current":
                operation.completed += 1
            else:
                operation.failed += 1
                text = event.get("message")
                operation.message = text[:512] if isinstance(text, str) else None
        if event.get("state") == "current":
            with contextlib.suppress(OSError, GroupAnalysisError):
                atlas_cache.bump_revision(operation.project.root)

    def _subject_event(self, operation: _Operation, event: Mapping[str, Any]) -> None:
        subject = event.get("subjectId")
        state = event.get("state")
        if state not in atlas_worker.SUBJECT_STATES or not isinstance(subject, str):
            return
        labeled = False
        with self._lock:
            row = operation.subjects.get(subject)
            if row is None or operation.state != "running":
                return
            seconds = event.get("seconds")
            text = event.get("message")
            if state == "running":
                started = timestamp()
                row.update(state="running", startedAt=started)
                operation.current = {"subjectId": subject, "startedAt": started}
            else:
                row.update(
                    state=state,
                    message=text[:512] if isinstance(text, str) else None,
                    seconds=float(seconds)
                    if isinstance(seconds, (int, float))
                    and not isinstance(seconds, bool)
                    else None,
                )
                if state in {"current", "provisional"}:
                    operation.completed += 1
                    labeled = True
                    if row["seconds"] is not None:
                        operation.durations.append(row["seconds"])
                elif state == "failed":
                    operation.failed += 1
                else:
                    operation.skipped += 1
                if (
                    operation.current is not None
                    and operation.current["subjectId"] == subject
                ):
                    running = [
                        (name, item)
                        for name, item in operation.subjects.items()
                        if item["state"] == "running"
                    ]
                    operation.current = (
                        {
                            "subjectId": running[-1][0],
                            "startedAt": running[-1][1]["startedAt"],
                        }
                        if running
                        else None
                    )
            self._estimate(operation)
        if labeled:
            with contextlib.suppress(OSError, GroupAnalysisError):
                atlas_cache.bump_revision(operation.project.root)


def _unknown_report(detail: str) -> atlas_tools.ToolReport:
    """Return a report whose every tool is unknown."""
    facts = [
        {"toolId": tool_id, "state": "unknown", "detail": detail, "fix": None}
        for tool_id in (
            "freesurfer-home",
            "segment-subregions",
            "subregions-python",
            *atlas_tools.PROGRAMS,
        )
    ]
    return atlas_tools.ToolReport(
        facts=facts,
        build=None,
        interpreter=None,
        freesurfer=atlas_tools.freesurfer_facts(None),
    )
