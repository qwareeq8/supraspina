"""Revision-bound review storage for immutable brain-FOV derivatives."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .bounded_io import (
    BoundedReadError,
    read_bounded_regular,
    sha256_bounded_regular,
)
from .cohort import subject_in_config_scope
from .paths import flatten, interpolate
from .project import ProjectEpochs, ProjectIdentity
from .workflow import validate_config_revision

_SCHEMA_VERSION = 2
_MAX_PROVENANCE_BYTES = 256 * 1024
_MAX_STORE_BYTES = 2 * 1024 * 1024
_MAX_PUBLICATIONS = 5_000
_MAX_DIRECTORY_ENTRIES = 100_000
_MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
_MAX_QC_BYTES = 64 * 1024 * 1024
_MAX_SUBJECT_ID = 128
_MAX_DISPLAY_PATH = 1_024
_MAX_ABSOLUTE_PATH = 16_384
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_SUBJECT = re.compile(r"^sub-[A-Za-z0-9][A-Za-z0-9._-]*$")
_SESSION = re.compile(r"^ses-[A-Za-z0-9][A-Za-z0-9._-]*$")
_ACQUISITION = re.compile(r"^acq-[A-Za-z0-9][A-Za-z0-9._-]*$")
_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_PROVENANCE = re.compile(
    r"^(?P<stem>.+)_desc-brainfov(?P<prefix>[a-f0-9]{16})_T1w\.json$"
)
_LIST_KEYS = {"project", "cfg", "configRevision"}
_REVIEW_KEYS = _LIST_KEYS | {
    "subjectId",
    "preflightSignature",
    "sourceSha256",
    "outputSha256",
    "expectedRevision",
    "decision",
    "sessionId",
    "acquisitionId",
}
_STORE_RECORD_KEYS = {
    "decision",
    "revision",
    "configRevision",
    "reviewedAt",
    "preflightSignature",
    "sourceSha256",
    "outputSha256",
    "decisionSignature",
    "subjectId",
    "sessionId",
    "acquisitionId",
}
_STORE_KEYS = {"schemaVersion", "decisions"}
_REVIEW_RECORD_PREFIX = "input-fov-review:"


class InputFovReviewError(ValueError):
    """Reject untrusted brain-FOV provenance or review evidence."""


def _digest_file(path: Path, *, expected_size: int | None = None) -> str:
    if expected_size is None or expected_size > _MAX_ARTIFACT_BYTES:
        raise InputFovReviewError("Keep the brain-FOV artifact size within its bound.")
    try:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise InputFovReviewError("Provide a safe brain-FOV artifact.")
        if info.st_size != expected_size:
            return ""
        digest, actual_size = sha256_bounded_regular(path, expected_size)
        if actual_size != expected_size:
            return ""
    except InputFovReviewError:
        raise
    except BoundedReadError as exc:
        raise InputFovReviewError(
            "Provide an unchanged, safe brain-FOV artifact."
        ) from exc
    except (OSError, ValueError) as exc:
        raise InputFovReviewError("Provide a readable brain-FOV artifact.") from exc
    return digest


def _safe_integer(value: Any, label: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > (2**53 - 1)
    ):
        raise InputFovReviewError(f"Provide a valid {label}.")
    return value


def _digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise InputFovReviewError(f"Provide a valid {label}.")
    return value


def _subject_id(value: Any) -> str:
    if (
        not isinstance(value, str)
        or len(value) > _MAX_SUBJECT_ID
        or _SUBJECT.fullmatch(value) is None
        or ".." in value
    ):
        raise InputFovReviewError("Provide a valid brain-FOV subject ID.")
    return value


def _optional_entity_id(
    value: Any,
    *,
    pattern: re.Pattern[str],
    label: str,
) -> str | None:
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) > _MAX_SUBJECT_ID
        or pattern.fullmatch(value) is None
        or ".." in value
    ):
        raise InputFovReviewError(f"Provide a valid brain-FOV {label} ID.")
    return value


def _session_id(value: Any) -> str | None:
    return _optional_entity_id(value, pattern=_SESSION, label="session")


def _acquisition_id(value: Any) -> str | None:
    return _optional_entity_id(value, pattern=_ACQUISITION, label="acquisition")


def _inside(root: Path, candidate: Path) -> bool:
    try:
        return os.path.commonpath((root, candidate)) == str(root)
    except ValueError:
        return False


def _resolved_path(cfg: dict[str, Any], key: str) -> Path:
    paths = cfg.get("paths") if isinstance(cfg.get("paths"), dict) else {}
    raw = paths.get(key) if isinstance(paths, dict) else None
    if not isinstance(raw, str) or not raw:
        raise InputFovReviewError(f"Provide cfg.paths.{key}.")
    resolved = interpolate(raw, flatten(cfg))
    if "${" in resolved or not os.path.isabs(resolved):
        raise InputFovReviewError(f"Resolve cfg.paths.{key}.")
    return Path(os.path.realpath(resolved))


def _read_json(path: Path, maximum_bytes: int, label: str) -> dict[str, Any]:
    try:
        info = path.lstat()
        if (
            stat.S_ISLNK(info.st_mode)
            or not stat.S_ISREG(info.st_mode)
            or info.st_size > maximum_bytes
        ):
            raise InputFovReviewError(f"Provide a safe {label}.")
        value = json.loads(read_bounded_regular(path, maximum_bytes))
    except InputFovReviewError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InputFovReviewError(f"Provide a readable {label}.") from exc
    if not isinstance(value, dict):
        raise InputFovReviewError(f"Provide a well-formed {label}.")
    return value


def _artifact(
    value: Any,
    role: str,
    dataset_root: Path,
) -> tuple[Path, str]:
    if (
        not isinstance(value, dict)
        or set(value) != {"path", "sha256", "size"}
        or not isinstance(value.get("path"), str)
        or not value["path"]
        or len(value["path"]) > _MAX_ABSOLUTE_PATH
        or "\x00" in value["path"]
    ):
        raise InputFovReviewError(f"Provide a valid brain-FOV {role} artifact record.")
    digest = _digest(value.get("sha256"), f"brain-FOV {role} hash")
    size = _safe_integer(value.get("size"), f"brain-FOV {role} size")
    path = Path(value["path"])
    canonical = Path(os.path.realpath(path))
    if not path.is_absolute() or not _inside(dataset_root, canonical):
        raise InputFovReviewError(
            f"Keep the brain-FOV {role} artifact inside derivatives."
        )
    maximum = _MAX_QC_BYTES if role == "qc" else _MAX_ARTIFACT_BYTES
    if size > maximum:
        raise InputFovReviewError(
            f"Keep the brain-FOV {role} artifact within its size bound."
        )
    actual = _digest_file(path, expected_size=size)
    if actual != digest:
        raise InputFovReviewError(
            f"Restore the recorded brain-FOV {role} artifact bytes."
        )
    return canonical, digest


def _publication_paths(dataset_root: Path) -> list[Path]:
    try:
        root_info = dataset_root.lstat()
    except FileNotFoundError:
        return []
    except OSError as exc:
        raise InputFovReviewError(
            "Provide a readable brain-FOV derivative root."
        ) from exc
    if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
        raise InputFovReviewError(
            "Provide a directory as the brain-FOV derivative root."
        )
    paths: list[Path] = []
    pending = [dataset_root]
    scanned = 0
    try:
        while pending:
            directory = pending.pop()
            with os.scandir(directory) as entries:
                for entry in entries:
                    scanned += 1
                    if scanned > _MAX_DIRECTORY_ENTRIES:
                        raise InputFovReviewError(
                            "Reduce the brain-FOV derivative tree size."
                        )
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(Path(entry.path))
                    elif entry.is_file(follow_symlinks=False) and _PROVENANCE.fullmatch(
                        entry.name
                    ):
                        paths.append(Path(entry.path))
                        if len(paths) > _MAX_PUBLICATIONS:
                            raise InputFovReviewError(
                                "Reduce the number of brain-FOV publications."
                            )
    except InputFovReviewError:
        raise
    except OSError as exc:
        raise InputFovReviewError(
            "Provide a readable brain-FOV derivative tree."
        ) from exc
    return sorted(paths)


def _parse_entities(
    path: Path,
    dataset_root: Path,
) -> tuple[str, str | None, str | None]:
    try:
        relative = path.relative_to(dataset_root)
    except ValueError as exc:
        raise InputFovReviewError(
            "Keep brain-FOV provenance inside derivatives."
        ) from exc
    subject = next((part for part in relative.parts if _SUBJECT.fullmatch(part)), None)
    sessions = [part for part in relative.parts if _SESSION.fullmatch(part)]
    if (
        subject is None
        or len(subject) > _MAX_SUBJECT_ID
        or ".." in subject
        or len(sessions) > 1
        or (
            len(sessions) == 1
            and (len(sessions[0]) > _MAX_SUBJECT_ID or ".." in sessions[0])
        )
    ):
        raise InputFovReviewError(
            "Provide valid BIDS entities in brain-FOV provenance."
        )
    session = _session_id(sessions[0] if sessions else None)
    prefix = f"{subject}_{session}_" if session else f"{subject}_"
    if not path.name.startswith(prefix):
        raise InputFovReviewError(
            "Align the brain-FOV provenance filename with its BIDS entities."
        )
    match = _PROVENANCE.fullmatch(path.name)
    if match is None:
        raise InputFovReviewError("Provide a valid brain-FOV provenance filename.")
    acquisition_tokens = [
        token for token in match.group("stem").split("_") if token.startswith("acq-")
    ]
    if len(acquisition_tokens) > 1:
        raise InputFovReviewError(
            "Provide at most one acquisition entity in brain-FOV provenance."
        )
    acquisition = _acquisition_id(acquisition_tokens[0] if acquisition_tokens else None)
    return subject, session, acquisition


def _source_identity(document: dict[str, Any]) -> tuple[Path, str]:
    preflight = document.get("preflightSignature")
    source_signature = (
        preflight.get("source")
        if isinstance(preflight, dict) and isinstance(preflight.get("source"), dict)
        else {}
    )
    source = document.get("source")
    if (
        not isinstance(source, dict)
        or not isinstance(source.get("path"), str)
        or not source["path"]
        or len(source["path"]) > _MAX_ABSOLUTE_PATH
        or "\x00" in source["path"]
    ):
        raise InputFovReviewError("Provide valid brain-FOV source provenance.")
    expected = _digest(
        source_signature.get("sha256"), "brain-FOV source provenance hash"
    )
    expected_size = _safe_integer(
        source_signature.get("size"), "brain-FOV source provenance size"
    )
    source_path = Path(source["path"])
    if not source_path.is_absolute():
        raise InputFovReviewError("Provide a valid brain-FOV source path.")
    actual = _digest_file(source_path, expected_size=expected_size)
    if actual != expected:
        raise InputFovReviewError("Restore the recorded brain-FOV source bytes.")
    return Path(os.path.realpath(source_path)), expected


def _canonical_digest(value: Any) -> str:
    payload = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _review_record_key(identity: dict[str, Any]) -> str:
    return _REVIEW_RECORD_PREFIX + _canonical_digest(
        {
            "schemaVersion": _SCHEMA_VERSION,
            "subjectId": identity["subjectId"],
            "sessionId": identity["sessionId"],
            "acquisitionId": identity["acquisitionId"],
            "preflightSignature": identity["preflightSignature"],
            "sourceSha256": identity["sourceSha256"],
            "outputSha256": identity["outputSha256"],
        }
    )


def _timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _store_path(project: ProjectIdentity) -> Path:
    return Path(project.root) / ".supraspina" / "input-fov-qc.json"


def _empty_store() -> dict[str, Any]:
    return {
        "schemaVersion": _SCHEMA_VERSION,
        "decisions": {},
    }


def _validated_store_record(raw_record: Any) -> dict[str, Any]:
    if not isinstance(raw_record, dict) or set(raw_record) != _STORE_RECORD_KEYS:
        raise InputFovReviewError("Provide a valid input-FOV review store record.")
    record = dict(raw_record)
    if record.get("decision") not in {"approved", "rejected"}:
        raise InputFovReviewError("Provide a valid input-FOV review store decision.")
    _safe_integer(record.get("revision"), "input-FOV review revision")
    _safe_integer(record.get("configRevision"), "input-FOV review config revision")
    for key in (
        "preflightSignature",
        "sourceSha256",
        "outputSha256",
        "decisionSignature",
    ):
        _digest(record.get(key), f"input-FOV review {key}")
    reviewed_at = record.get("reviewedAt")
    if not isinstance(reviewed_at, str) or _TIMESTAMP.fullmatch(reviewed_at) is None:
        raise InputFovReviewError("Provide a valid input-FOV review timestamp.")
    try:
        datetime.strptime(reviewed_at, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as exc:
        raise InputFovReviewError(
            "Provide a valid input-FOV review timestamp."
        ) from exc
    record["subjectId"] = _subject_id(record.get("subjectId"))
    record["sessionId"] = _session_id(record.get("sessionId"))
    record["acquisitionId"] = _acquisition_id(record.get("acquisitionId"))
    return record


def _load_store(project: ProjectIdentity) -> dict[str, Any]:
    path = _store_path(project)
    try:
        path.lstat()
    except FileNotFoundError:
        return _empty_store()
    except OSError as exc:
        raise InputFovReviewError(
            "Provide readable input-FOV review store metadata."
        ) from exc
    value = _read_json(path, _MAX_STORE_BYTES, "input-FOV review store")
    if (
        set(value) != _STORE_KEYS
        or value.get("schemaVersion") != _SCHEMA_VERSION
        or not isinstance(value.get("decisions"), dict)
    ):
        raise InputFovReviewError("Use a supported input-FOV review store schema.")
    decisions: dict[str, dict[str, Any]] = {}
    for raw_key, raw_record in value["decisions"].items():
        record = _validated_store_record(raw_record)
        if (
            not isinstance(raw_key, str)
            or not raw_key.startswith(_REVIEW_RECORD_PREFIX)
            or len(raw_key) != len(_REVIEW_RECORD_PREFIX) + 64
            or raw_key != _review_record_key(record)
        ):
            raise InputFovReviewError(
                "Provide a valid input-FOV review store identity."
            )
        decisions[raw_key] = record
    if len(decisions) > _MAX_PUBLICATIONS:
        raise InputFovReviewError(
            "Reduce the number of input-FOV review store decisions."
        )
    return {
        "schemaVersion": _SCHEMA_VERSION,
        "decisions": decisions,
    }


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_store(project: ProjectIdentity, store: dict[str, Any]) -> None:
    payload = (
        json.dumps(
            store,
            sort_keys=True,
            indent=2,
            ensure_ascii=True,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")
    if len(payload) > _MAX_STORE_BYTES:
        raise InputFovReviewError(
            "Keep the input-FOV review store within its size bound."
        )
    path = _store_path(project)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        parent_info = path.parent.lstat()
    except OSError as exc:
        raise InputFovReviewError(
            "Provide a readable input-FOV review directory."
        ) from exc
    if stat.S_ISLNK(parent_info.st_mode) or not stat.S_ISDIR(parent_info.st_mode):
        raise InputFovReviewError("Provide a safe input-FOV review directory.")
    descriptor = -1
    temporary = ""
    try:
        descriptor, temporary = tempfile.mkstemp(
            prefix=".input-fov-qc.tmp-",
            dir=path.parent,
        )
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = -1
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = ""
        _fsync_directory(path.parent)
    except OSError as exc:
        raise InputFovReviewError(
            "Commit the input-FOV review store atomically."
        ) from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def _public_review(
    record: dict[str, Any],
    *,
    current_identity: dict[str, Any],
) -> dict[str, Any]:
    current = (
        record["preflightSignature"] == current_identity["preflightSignature"]
        and record["sourceSha256"] == current_identity["sourceSha256"]
        and record["outputSha256"] == current_identity["outputSha256"]
        and (
            "subjectId" not in record
            or (
                record["subjectId"] == current_identity["subjectId"]
                and record["sessionId"] == current_identity["sessionId"]
                and record["acquisitionId"] == current_identity["acquisitionId"]
            )
        )
    )
    return {
        "decision": record["decision"],
        "revision": record["revision"],
        "configRevision": record["configRevision"],
        "reviewedAt": record["reviewedAt"],
        "decisionSignature": record["decisionSignature"],
        "current": current,
    }


def _publication_item(
    provenance_path: Path,
    dataset_root: Path,
) -> dict[str, Any]:
    match = _PROVENANCE.fullmatch(provenance_path.name)
    if match is None:
        raise InputFovReviewError("Provide a valid brain-FOV provenance filename.")
    document = _read_json(
        provenance_path,
        _MAX_PROVENANCE_BYTES,
        "brain-FOV provenance",
    )
    if document.get("schemaVersion") != 1:
        raise InputFovReviewError("Use a supported brain-FOV provenance schema.")
    signature = _digest(document.get("signature"), "brain-FOV preflight digest")
    if match.group("prefix") != signature[:16]:
        raise InputFovReviewError(
            "Resolve the brain-FOV derivative descriptor digest collision."
        )
    subject, session, acquisition = _parse_entities(
        provenance_path,
        dataset_root,
    )
    source_path, source_sha256 = _source_identity(document)
    crop = document.get("crop")
    if not isinstance(crop, dict) or not isinstance(crop.get("passThrough"), bool):
        raise InputFovReviewError("Provide valid brain-FOV crop provenance.")
    pass_through = crop["passThrough"]
    artifacts = document.get("artifacts")
    if not isinstance(artifacts, dict):
        raise InputFovReviewError("Provide valid brain-FOV artifact provenance.")
    qc_path, _qc_hash = _artifact(artifacts.get("qc"), "qc", dataset_root)
    if pass_through:
        if "t1" in artifacts:
            raise InputFovReviewError(
                "Remove the duplicated source T1 from brain-FOV pass-through."
            )
        output_sha256 = source_sha256
        prepared_path = source_path
    else:
        prepared_path, output_sha256 = _artifact(
            artifacts.get("t1"), "t1", dataset_root
        )
    identity = {
        "subjectId": subject,
        "sessionId": session,
        "acquisitionId": acquisition,
        "preflightSignature": signature,
        "sourceSha256": source_sha256,
        "outputSha256": output_sha256,
    }
    display_path = str(qc_path.relative_to(dataset_root))
    if len(display_path) > _MAX_DISPLAY_PATH:
        raise InputFovReviewError(
            "Keep the brain-FOV montage display path within its bound."
        )
    return {
        **identity,
        "passThrough": pass_through,
        "requiresReview": not pass_through,
        "qcArtifactId": (
            "input-fov-qc:"
            + _canonical_digest(
                {
                    "schemaVersion": _SCHEMA_VERSION,
                    "role": "qc",
                    "subjectId": subject,
                    "sessionId": session,
                    "acquisitionId": acquisition,
                    "preflightSignature": signature,
                }
            )
        ),
        "qcDisplayPath": f"supraspina-brainfov/{display_path}",
        "qcPath": str(qc_path),
        "rawT1Path": str(source_path),
        "preparedT1Path": str(prepared_path),
        "review": None,
    }


class InputFovReviewManager:
    """List immutable crop evidence and commit project-scoped review decisions."""

    def __init__(self, projects: ProjectEpochs) -> None:
        """Initialize against the process-wide explicit project identity ledger."""
        self.projects = projects
        self._lock = threading.RLock()

    def _context(
        self,
        request: dict[str, Any],
        *,
        review: bool,
    ) -> tuple[ProjectIdentity, dict[str, Any], int, Path]:
        expected = _REVIEW_KEYS if review else _LIST_KEYS
        if not isinstance(request, dict) or set(request) != expected:
            raise InputFovReviewError("Provide valid input-FOV request fields.")
        cfg = request.get("cfg")
        if not isinstance(cfg, dict):
            raise InputFovReviewError("Provide the input-FOV cfg.")
        revision = validate_config_revision(request.get("configRevision"))
        project = self.projects.validate(request.get("project"), cfg)
        derivatives = _resolved_path(cfg, "derivativesDir")
        return project, cfg, revision, derivatives / "supraspina-brainfov"

    def _list(
        self,
        project: ProjectIdentity,
        dataset_root: Path,
    ) -> list[dict[str, Any]]:
        store = _load_store(project)
        decisions = store["decisions"]
        items = [
            _publication_item(provenance_path, dataset_root)
            for provenance_path in _publication_paths(dataset_root)
        ]
        for item in items:
            record = decisions.get(_review_record_key(item))
            if isinstance(record, dict):
                item["review"] = _public_review(
                    record,
                    current_identity=item,
                )
        items.sort(
            key=lambda item: (
                item["subjectId"],
                item["sessionId"] or "",
                item["acquisitionId"] or "",
                item["preflightSignature"],
            )
        )
        return items

    def list(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return current prepared-input evidence plus matching review state.

        Scope the listing to the project's configured include/exclude selection
        because Input QC gates the reconstruction cohort. Exclude publications
        left by subjects that the operator has since excluded.
        """
        project, cfg, revision, dataset_root = self._context(
            request,
            review=False,
        )
        return {
            "configRevision": revision,
            "items": [
                {
                    key: value
                    for key, value in item.items()
                    if key not in {"rawT1Path", "preparedT1Path"}
                }
                for item in self._list(project, dataset_root)
                if subject_in_config_scope(cfg, str(item["subjectId"]))
            ],
        }

    def resolve_for_cohort(
        self,
        request: dict[str, Any],
        t1_by_subject: dict[str, str],
        *,
        expected_preflight_by_subject: dict[str, str] | None = None,
    ) -> dict[str, dict[str, Any]]:
        """Resolve trusted prepared inputs for one authoritative raw-T1 cohort.

        Parameters
        ----------
        request
            Provide the exact project, configuration, and saved config-revision
            envelope.
        t1_by_subject
            Provide the authoritative raw BIDS T1 path for each selected subject.
        expected_preflight_by_subject
            Bind any supplied subject to its expected brain-FOV preflight
            signature. Accept no subject outside ``t1_by_subject``.

        Returns
        -------
        dict
            Return per-subject raw and prepared paths plus immutable identity
            evidence.

        Raises
        ------
        InputFovReviewError
            Raise when a publication is missing, ambiguous, stale, rejected,
            unreviewed, or does not match the authoritative raw source.
        """
        project, dataset_root, expected_signatures = self._resolution_context(
            request, t1_by_subject, expected_preflight_by_subject
        )
        publications = self._list(project, dataset_root)
        resolved: dict[str, dict[str, Any]] = {}
        for raw_subject, raw_path in sorted(t1_by_subject.items()):
            subject, binding = _resolve_subject(
                raw_subject, raw_path, publications, expected_signatures
            )
            resolved[subject] = binding
        return resolved

    def resolve_each_for_cohort(
        self,
        request: dict[str, Any],
        t1_by_subject: dict[str, str],
        *,
        expected_preflight_by_subject: dict[str, str] | None = None,
    ) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
        """Resolve every subject against one publication listing.

        Planning and result signing gate each subject on its own crop review,
        so they need a binding or a blocker per subject. Resolving one subject
        at a time re-hashed every publication for every subject; this lists
        and hashes the publications once per call, so each call still proves
        the bytes it binds.

        Returns
        -------
        tuple
            Return the trusted bindings by subject and the blocker sentence
            of every subject that could not be bound.
        """
        project, dataset_root, expected_signatures = self._resolution_context(
            request, t1_by_subject, expected_preflight_by_subject
        )
        try:
            publications = self._list(project, dataset_root)
        except InputFovReviewError as exc:
            return {}, {subject: str(exc) for subject in sorted(t1_by_subject)}
        resolved: dict[str, dict[str, Any]] = {}
        blockers: dict[str, str] = {}
        for raw_subject, raw_path in sorted(t1_by_subject.items()):
            try:
                subject, binding = _resolve_subject(
                    raw_subject, raw_path, publications, expected_signatures
                )
            except InputFovReviewError as exc:
                blockers[raw_subject] = str(exc)
                continue
            resolved[subject] = binding
        return resolved, blockers

    def _resolution_context(
        self,
        request: dict[str, Any],
        t1_by_subject: dict[str, str],
        expected_preflight_by_subject: dict[str, str] | None,
    ) -> tuple[ProjectIdentity, Path, dict[str, str]]:
        project, _cfg, _revision, dataset_root = self._context(
            request,
            review=False,
        )
        if (
            not isinstance(t1_by_subject, dict)
            or len(t1_by_subject) > _MAX_PUBLICATIONS
            or any(
                not isinstance(subject, str)
                or not isinstance(path, str)
                or not os.path.isabs(path)
                for subject, path in t1_by_subject.items()
            )
        ):
            raise InputFovReviewError(
                "Provide a valid authoritative brain-FOV T1 mapping."
            )
        expected_signatures = (
            {}
            if expected_preflight_by_subject is None
            else expected_preflight_by_subject
        )
        if (
            not isinstance(expected_signatures, dict)
            or set(expected_signatures) - set(t1_by_subject)
            or any(
                not isinstance(subject, str)
                or not isinstance(signature, str)
                or _SHA256.fullmatch(signature) is None
                for subject, signature in expected_signatures.items()
            )
        ):
            raise InputFovReviewError(
                "Provide a valid expected brain-FOV preflight mapping."
            )
        return project, dataset_root, expected_signatures

    def review(self, request: dict[str, Any]) -> dict[str, Any]:
        """Commit an approved or rejected crop decision by exact identity."""
        project, _cfg, revision, dataset_root = self._context(
            request,
            review=True,
        )
        subject = _subject_id(request.get("subjectId"))
        session = _session_id(request.get("sessionId"))
        acquisition = _acquisition_id(request.get("acquisitionId"))
        signature = _digest(
            request.get("preflightSignature"), "input-FOV preflight digest"
        )
        source_sha256 = _digest(request.get("sourceSha256"), "input-FOV source SHA-256")
        output_sha256 = _digest(request.get("outputSha256"), "input-FOV output SHA-256")
        expected_revision = _safe_integer(
            request.get("expectedRevision"), "input-FOV expected revision"
        )
        decision = request.get("decision")
        if decision not in {"approved", "rejected"}:
            raise InputFovReviewError("Provide a valid input-FOV decision.")
        matching = [
            item
            for item in self._list(project, dataset_root)
            if item["subjectId"] == subject
            and item["sessionId"] == session
            and item["acquisitionId"] == acquisition
            and item["preflightSignature"] == signature
        ]
        if len(matching) != 1:
            raise InputFovReviewError(
                "Provide a current, unambiguous input-FOV review identity."
            )
        item = matching[0]
        if item["passThrough"]:
            raise InputFovReviewError("Skip review for brain-FOV pass-through inputs.")
        if (
            item["sourceSha256"] != source_sha256
            or item["outputSha256"] != output_sha256
        ):
            raise InputFovReviewError("Provide current input-FOV review hashes.")
        with self._lock:
            store = _load_store(project)
            record_key = _review_record_key(item)
            current = store["decisions"].get(record_key)
            current_revision = (
                int(current["revision"]) if isinstance(current, dict) else 0
            )
            if expected_revision != current_revision:
                raise InputFovReviewError(
                    "Resolve the input-FOV review revision conflict."
                )
            record: dict[str, Any] = {
                "decision": decision,
                "revision": current_revision + 1,
                "configRevision": revision,
                "reviewedAt": _timestamp(),
                "subjectId": subject,
                "sessionId": item["sessionId"],
                "acquisitionId": acquisition,
                "preflightSignature": signature,
                "sourceSha256": source_sha256,
                "outputSha256": output_sha256,
            }
            record["decisionSignature"] = _canonical_digest(
                {
                    "schemaVersion": _SCHEMA_VERSION,
                    "subjectId": subject,
                    "sessionId": item["sessionId"],
                    "acquisitionId": acquisition,
                    "decision": decision,
                    "preflightSignature": signature,
                    "sourceSha256": source_sha256,
                    "outputSha256": output_sha256,
                }
            )
            store["decisions"][record_key] = record
            _write_store(project, store)
        return _public_review(
            record,
            current_identity={
                "subjectId": subject,
                "sessionId": item["sessionId"],
                "acquisitionId": acquisition,
                "preflightSignature": signature,
                "sourceSha256": source_sha256,
                "outputSha256": output_sha256,
            },
        )


def _resolve_subject(
    raw_subject: str,
    raw_path: str,
    publications: list[dict[str, Any]],
    expected_signatures: dict[str, str],
) -> tuple[str, dict[str, Any]]:
    """Bind one subject's raw T1 to its trusted publication or raise."""
    subject = _subject_id(raw_subject)
    canonical_raw = os.path.realpath(raw_path)
    matching = [
        item
        for item in publications
        if item["subjectId"] == subject
        and os.path.realpath(item["rawT1Path"]) == canonical_raw
        and (
            subject not in expected_signatures
            or item["preflightSignature"] == expected_signatures[subject]
        )
    ]
    if not matching:
        raise InputFovReviewError(
            f"Run Brain FOV for {subject}, then approve its crop in Input QC."
        )
    if len(matching) > 1:
        raise InputFovReviewError(
            f"Rerun Brain FOV for {subject}; more than one publication "
            "matches its current T1."
        )
    item = matching[0]
    review = item.get("review")
    decision_signature: str | None = None
    if not item["passThrough"]:
        if not isinstance(review, dict):
            raise InputFovReviewError(
                f"Review and approve the Brain FOV crop for {subject} in Input QC."
            )
        if review.get("current") is not True:
            raise InputFovReviewError(
                f"Review the current Brain FOV crop for {subject} in "
                "Input QC; the earlier decision is stale."
            )
        if review.get("decision") != "approved":
            raise InputFovReviewError(
                f"Approve the Brain FOV crop for {subject} in Input QC."
            )
        decision_signature = _digest(
            review.get("decisionSignature"),
            "input-FOV decision digest",
        )
    return subject, {
        "rawT1Path": canonical_raw,
        "preparedT1Path": str(item["preparedT1Path"]),
        "passThrough": bool(item["passThrough"]),
        "preflightSignature": str(item["preflightSignature"]),
        "sourceSha256": str(item["sourceSha256"]),
        "outputSha256": str(item["outputSha256"]),
        "decisionSignature": decision_signature,
    }
