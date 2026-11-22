"""Deterministic resolution of subjects, T1 inputs, selection, and QC cohorts.

Every execution path consumes a :class:`CohortSnapshot`, so discovery and
planning apply the same include, exclude, and T1 ambiguity rules. The
analysis cohort stays distinct from the selected per-subject subset.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import stat
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

from .paths import flatten, interpolate
from .qc_store import load_document

T1State = Literal["resolved", "missing", "ambiguous", "unsafe"]
_MAX_DISCOVERED_SUBJECTS = 100_000
_MAX_T1_CANDIDATES = 10_000
#: Remember this many T1 fingerprints; the bound exceeds the largest cohort.
_MAX_REMEMBERED_FINGERPRINTS = 8192
_REMEMBERED_FINGERPRINTS: OrderedDict[tuple[str, int, int, int, int, int], str] = (
    OrderedDict()
)
_FINGERPRINT_LOCK = threading.Lock()


class CohortError(ValueError):
    """Raise when an immutable runnable cohort cannot be produced."""


@dataclass(frozen=True)
class T1Resolution:
    """Represent one subject's deterministic T1 resolution result."""

    subject_id: str
    state: T1State
    path: str | None
    candidates: tuple[str, ...]
    fingerprint: str | None
    fingerprint_strategy: str = "sha256-full-v1"

    def to_dict(self) -> dict[str, Any]:
        """Serialize the resolution for durable run state."""
        return asdict(self)


@dataclass(frozen=True)
class CohortSnapshot:
    """Represent an immutable analysis cohort and selected execution subset.

    ``analysis_digest`` binds the analysis membership, see
    :func:`membership_digest`.
    """

    analysis_subject_ids: tuple[str, ...]
    selected_subject_ids: tuple[str, ...]
    analysis_digest: str
    selected_digest: str
    t1: tuple[T1Resolution, ...]
    qc_verdicts: tuple[tuple[str, str], ...]
    qc_acknowledged: bool
    excluded_by_config: tuple[str, ...]
    excluded_by_qc: tuple[str, ...]

    @property
    def membership_digest(self) -> str:
        """Return the digest of this snapshot's analysis membership."""
        return membership_digest(
            self.analysis_subject_ids,
            self.t1,
            self.excluded_by_qc,
            self.excluded_by_config,
        )

    @property
    def t1_by_subject(self) -> dict[str, str]:
        """Return resolved subject-to-T1 paths only."""
        return {item.subject_id: item.path for item in self.t1 if item.path is not None}

    def to_dict(self) -> dict[str, Any]:
        """Serialize the immutable cohort snapshot for durable run state."""
        return {
            "analysisSubjectIds": list(self.analysis_subject_ids),
            "selectedSubjectIds": list(self.selected_subject_ids),
            "analysisDigest": self.analysis_digest,
            "selectedDigest": self.selected_digest,
            "t1": [item.to_dict() for item in self.t1],
            "qcVerdicts": dict(self.qc_verdicts),
            "qcAcknowledged": self.qc_acknowledged,
            "excludedByConfig": list(self.excluded_by_config),
            "excludedByQc": list(self.excluded_by_qc),
        }


def _digest(value: Any) -> str:
    data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def _safe_subject_id(subject_id: str) -> bool:
    return (
        bool(subject_id)
        and subject_id == os.path.basename(subject_id)
        and not any(token in subject_id for token in ("/", "\\", "\x00", ".."))
    )


def _placed_under(path: str, root: str) -> bool:
    """Test lexical containment so an operator's symlink inside the raw root counts.

    Discovery follows symlinked subject folders and T1 files whose link sits
    under the raw root; the link's target may live on another volume. Symlink
    following applies only to the link's placement, so a pattern still cannot
    escape the root lexically.
    """
    try:
        normalized_root = os.path.normpath(os.path.abspath(root))
        return (
            os.path.commonpath(
                (os.path.normpath(os.path.abspath(path)), normalized_root)
            )
            == normalized_root
        )
    except ValueError:
        return False


def _fold_case(pattern: str) -> str:
    """Return a glob that matches ``pattern`` regardless of letter case.

    Raw exports name the T1 series inconsistently (``t1_mprage`` next to a BIDS
    ``_T1w``), so one project pattern has to match both. A pattern that already
    uses a bracket expression is left as written.
    """
    if "[" in pattern:
        return pattern
    return "".join(
        f"[{character.lower()}{character.upper()}]"
        if character.isalpha() and character.lower() != character.upper()
        else character
        for character in pattern
    )


def _safe_glob_pattern(pattern: str) -> bool:
    """Accept a relative single-segment glob that cannot traverse a parent."""
    return (
        bool(pattern)
        and not os.path.isabs(pattern)
        and not any(token in pattern for token in ("/", "\\", "\x00", ".."))
    )


def _t1_witness(path: str) -> tuple[str, int, int, int, int, int] | None:
    """Return the filesystem identity a remembered fingerprint is keyed by.

    The change time moves on every content write, rename, and restored
    modification time, so a replaced file never matches an earlier witness.
    """
    try:
        info = os.stat(path)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return None
    return (
        path,
        info.st_dev,
        info.st_ino,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def _hash_file(path: str) -> str:
    """Return the full streaming SHA-256 of one file's bytes."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _fingerprint(path: str) -> str:
    """Return a full streaming SHA-256 for scientific input currentness.

    Always read the bytes. Remember the digest for
    :func:`remembered_fingerprint` only when the file's identity held for the
    whole read.
    """
    witness = _t1_witness(path)
    fingerprint = _hash_file(path)
    if witness is not None and _t1_witness(path) == witness:
        with _FINGERPRINT_LOCK:
            _REMEMBERED_FINGERPRINTS[witness] = fingerprint
            _REMEMBERED_FINGERPRINTS.move_to_end(witness)
            while len(_REMEMBERED_FINGERPRINTS) > _MAX_REMEMBERED_FINGERPRINTS:
                _REMEMBERED_FINGERPRINTS.popitem(last=False)
    return fingerprint


def remembered_fingerprint(path: str) -> str:
    """Return a T1 fingerprint, hashing only a file whose identity changed.

    Reuse the digest that planning or an earlier read took while the file's
    device, inode, size, modification time, and change time are unchanged.
    Use it only for read-only currency checks; planning always reads the
    bytes through :func:`_fingerprint`.
    """
    witness = _t1_witness(path)
    if witness is not None:
        with _FINGERPRINT_LOCK:
            remembered = _REMEMBERED_FINGERPRINTS.get(witness)
            if remembered is not None:
                _REMEMBERED_FINGERPRINTS.move_to_end(witness)
                return remembered
    return _fingerprint(path)


def _raw_root(cfg: dict[str, Any]) -> str:
    return interpolate("${paths.rawdataDir}", flatten(cfg))


def resolve_t1(  # noqa: PLR0911
    cfg: dict[str, Any],
    subject_id: str,
    *,
    fingerprint: Callable[[str], str] | None = None,
) -> T1Resolution:
    """Resolve exactly one canonical T1 for ``subject_id`` under raw data.

    ``fingerprint`` replaces the full hash, for example with
    :func:`remembered_fingerprint` in a read-only currency check.
    """
    if not _safe_subject_id(subject_id):
        return T1Resolution(subject_id, "unsafe", None, (), None)
    raw_root = _raw_root(cfg)
    subject_dir = os.path.join(raw_root, subject_id)
    if (
        not raw_root
        or not os.path.isdir(subject_dir)
        or not _placed_under(subject_dir, raw_root)
    ):
        return T1Resolution(subject_id, "missing", None, (), None)
    patterns = cfg.get("patterns", {}) if isinstance(cfg.get("patterns"), dict) else {}
    pattern = str(patterns.get("t1Pattern", "*_T1w.nii.gz"))
    if not _safe_glob_pattern(pattern):
        return T1Resolution(subject_id, "unsafe", None, (), None)
    matches: set[str] = set()
    scanned = 0
    folded = _fold_case(pattern)
    for candidate_pattern in (
        os.path.join(subject_dir, folded),
        os.path.join(subject_dir, "anat", folded),
        os.path.join(subject_dir, "**", folded),
    ):
        for candidate in glob.iglob(
            candidate_pattern, recursive="**" in candidate_pattern
        ):
            scanned += 1
            if scanned > _MAX_T1_CANDIDATES:
                return T1Resolution(subject_id, "unsafe", None, (), None)
            canonical = os.path.realpath(candidate)
            if os.path.isfile(canonical) and _placed_under(candidate, subject_dir):
                matches.add(canonical)
    candidates = tuple(sorted(matches))
    if not candidates:
        return T1Resolution(subject_id, "missing", None, (), None)
    if len(candidates) != 1:
        return T1Resolution(subject_id, "ambiguous", None, candidates, None)
    try:
        digest = (fingerprint or _fingerprint)(candidates[0])
    except OSError:
        return T1Resolution(subject_id, "missing", None, candidates, None)
    return T1Resolution(subject_id, "resolved", candidates[0], candidates, digest)


def config_subject_scope(cfg: dict[str, Any]) -> tuple[set[str], set[str]]:
    """Return the configured ``(include, exclude)`` subject-ID sets.

    Treat an empty include set as every discovered subject. Always subtract the
    exclude set. Drop unsafe IDs instead of trusting them.

    Returns
    -------
    tuple of (set of str, set of str)
        Return the include and exclude sets after safety filtering.
    """
    subjects_cfg = (
        cfg.get("subjects", {})
        if isinstance(cfg, dict) and isinstance(cfg.get("subjects"), dict)
        else {}
    )
    include = {
        str(item)
        for item in subjects_cfg.get("include", [])
        if _safe_subject_id(str(item))
    }
    exclude = {
        str(item)
        for item in subjects_cfg.get("exclude", [])
        if _safe_subject_id(str(item))
    }
    return include, exclude


def config_excluded_subject_ids(cfg: dict[str, Any]) -> tuple[str, ...]:
    """Return the sorted configuration exclusions the analysis cohort binds.

    Keep every listed ID, discovered or not, as planning always has, so the
    analysis-cohort digest of a plan and of a currency check agree.
    """
    config_subjects = (
        cfg.get("subjects", {})
        if isinstance(cfg, dict) and isinstance(cfg.get("subjects"), dict)
        else {}
    )
    return tuple(sorted({str(v) for v in config_subjects.get("exclude", [])}))


def subject_in_config_scope(cfg: dict[str, Any], subject_id: str) -> bool:
    """Return whether one subject ID survives the configured include/exclude."""
    include, exclude = config_subject_scope(cfg)
    if subject_id in exclude:
        return False
    return not include or subject_id in include


def discover_t1_resolutions(
    cfg: dict[str, Any], *, fingerprint: Callable[[str], str] | None = None
) -> list[T1Resolution]:
    """Return ordered T1 resolution rows after config include/exclude policy.

    ``fingerprint`` replaces the full hash of each T1; see :func:`resolve_t1`.
    """
    if not isinstance(cfg, dict):
        return []
    raw_root = _raw_root(cfg)
    if not raw_root or not os.path.isdir(raw_root):
        return []
    patterns = cfg.get("patterns", {}) if isinstance(cfg.get("patterns"), dict) else {}
    subject_glob = str(patterns.get("subjectGlob", "sub-*"))
    if not _safe_glob_pattern(subject_glob):
        raise CohortError("Provide a safe relative segment for patterns.subjectGlob.")
    include, exclude = config_subject_scope(cfg)
    ids: set[str] = set()
    for index, entry in enumerate(glob.iglob(os.path.join(raw_root, subject_glob))):
        if index >= _MAX_DISCOVERED_SUBJECTS:
            raise CohortError("Keep subject discovery within the bounded entry limit.")
        if os.path.isdir(entry) and _placed_under(entry, raw_root):
            subject_id = os.path.basename(os.path.normpath(entry))
            if _safe_subject_id(subject_id):
                ids.add(subject_id)
    if include:
        ids &= include
    ids -= exclude
    return [
        resolve_t1(cfg, subject_id, fingerprint=fingerprint)
        for subject_id in sorted(ids)
    ]


def list_subject_ids(cfg: dict[str, Any]) -> list[str]:
    """List runnable subjects with one unambiguous T1 after include/exclude."""
    return [
        row.subject_id
        for row in discover_t1_resolutions(cfg)
        if row.state == "resolved"
    ]


def _qc_path(cfg: dict[str, Any]) -> str:
    project_root = interpolate("${paths.projectRoot}", flatten(cfg))
    return os.path.join(project_root, ".supraspina", "qc_verdicts.json")


def load_qc_records(cfg: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Load the canonical project QC records or fail on ambiguous evidence."""
    return load_document(_qc_path(cfg))["verdicts"]


def load_project_qc_records(project_root: str) -> dict[str, dict[str, Any]]:
    """Load the QC records of the project at ``project_root``.

    Read the same store as :func:`load_qc_records`, for callers that hold a
    validated project root instead of a configuration.
    """
    path = os.path.join(project_root, ".supraspina", "qc_verdicts.json")
    return load_document(path)["verdicts"]


def effective_qc_verdict(record: dict[str, Any] | None) -> str:
    """Project one stored QC record into its evidence-backed verdict.

    Reject a verdict without gallery-review attestation. Keep direct callers
    fail-closed even though canonical stores already reject that state.
    """
    if not record:
        return "unreviewed"
    verdict = record.get("verdict")
    if verdict not in {"pass", "fail", "defer"}:
        return "unreviewed"
    if verdict in {"pass", "fail"} and record.get("reviewEvidence") is None:
        return "unreviewed"
    return str(verdict)


@dataclass(frozen=True)
class AnalysisCohort:
    """Represent the analysis cohort that resolved T1 rows yield under QC records.

    The planner and the result inventory derive the analysis-cohort digest
    from this one value, so a membership change, not a QC verdict change,
    reads the same in both.
    """

    subject_ids: tuple[str, ...]
    t1: tuple[T1Resolution, ...]
    qc_verdicts: tuple[tuple[str, str], ...]
    excluded_by_qc: tuple[str, ...]
    excluded_by_config: tuple[str, ...]

    @property
    def pending_qc_subject_ids(self) -> tuple[str, ...]:
        """Return the analysis subjects whose verdict is Defer or unreviewed."""
        verdicts = dict(self.qc_verdicts)
        return tuple(
            subject_id
            for subject_id in self.subject_ids
            if verdicts.get(subject_id, "unreviewed") in {"defer", "unreviewed"}
        )

    def membership_digest(self) -> str:
        """Return the digest of this cohort's analysis membership."""
        return membership_digest(
            self.subject_ids, self.t1, self.excluded_by_qc, self.excluded_by_config
        )

    def snapshot(
        self,
        *,
        acknowledged: bool,
        selected_subject_ids: tuple[str, ...] | None = None,
    ) -> CohortSnapshot:
        """Return the immutable snapshot; select every analysis subject by default.

        The snapshot binds the membership digest and keeps the real verdicts
        and acknowledgement, which the run state records.
        """
        analysis_digest = self.membership_digest()
        selected = (
            self.subject_ids if selected_subject_ids is None else selected_subject_ids
        )
        selected_digest = _digest({"subjects": selected, "analysis": analysis_digest})
        return CohortSnapshot(
            analysis_subject_ids=self.subject_ids,
            selected_subject_ids=selected,
            analysis_digest=analysis_digest,
            selected_digest=selected_digest,
            t1=self.t1,
            qc_verdicts=self.qc_verdicts,
            qc_acknowledged=acknowledged,
            excluded_by_config=self.excluded_by_config,
            excluded_by_qc=self.excluded_by_qc,
        )


def membership_digest(
    subject_ids: tuple[str, ...] | list[str],
    t1: tuple[T1Resolution, ...] | list[T1Resolution],
    excluded_by_qc: tuple[str, ...] | list[str],
    excluded_by_config: tuple[str, ...] | list[str],
) -> str:
    """Return the analysis-cohort digest of one membership under QC policy v1.

    Bind the analysis subjects, their T1 fingerprints, and the QC Fail and
    configuration exclusions under the canonical QC state: every analysis
    subject unreviewed, the Defer acknowledgement given, and no review
    evidence. No cohort stage reads verdicts, so they stay out of this digest;
    the QC Fail exclusions still bind through ``excluded_by_qc``.
    """
    subjects = tuple(subject_ids)
    return _digest(
        {
            "subjects": subjects,
            "t1": [(row.subject_id, row.fingerprint) for row in t1],
            "qcPolicy": "fail-excluded-defer-unreviewed-ack-v1",
            "qc": {subject_id: "unreviewed" for subject_id in sorted(subjects)},
            "acknowledged": True,
            "excludedByQc": tuple(excluded_by_qc),
            "excludedByConfig": tuple(excluded_by_config),
            "excludedByQcCount": len(excluded_by_qc),
            "excludedByConfigCount": len(excluded_by_config),
            # Bind any recovery restriction through the resolved subject and
            # T1 lists. Keep the recovery mechanism itself out of the
            # scientific digest so an equivalent fresh plan recognizes outputs
            # completed by Resume or Retry.
            "recoveryRestriction": None,
        }
    )


def resolve_analysis_cohort(
    rows: list[T1Resolution] | tuple[T1Resolution, ...],
    records: dict[str, dict[str, Any]],
    excluded_by_config: tuple[str, ...],
) -> AnalysisCohort:
    """Apply QC records to resolved T1 rows without reading any file.

    Parameters
    ----------
    rows
        Provide the resolved T1 rows in discovery order, QC Fail rows included.
    records
        Provide the canonical QC records keyed by subject ID.
    excluded_by_config
        Provide the sorted subject IDs the configuration excludes.

    Returns
    -------
    AnalysisCohort
        Return the analysis subjects, their T1 rows and verdicts, and the QC
        and configuration exclusions.
    """
    verdicts = {
        subject_id: effective_qc_verdict(record)
        for subject_id, record in records.items()
    }
    excluded_qc = tuple(
        row.subject_id for row in rows if verdicts.get(row.subject_id) == "fail"
    )
    analysis = tuple(
        row.subject_id for row in rows if row.subject_id not in excluded_qc
    )
    return AnalysisCohort(
        subject_ids=analysis,
        t1=tuple(row for row in rows if row.subject_id in analysis),
        qc_verdicts=tuple(
            sorted(
                (subject_id, verdicts.get(subject_id, "unreviewed"))
                for subject_id in analysis
            )
        ),
        excluded_by_qc=excluded_qc,
        excluded_by_config=excluded_by_config,
    )


def build_cohort_snapshot(
    cfg: dict[str, Any],
    *,
    target_mode: str = "all",
    subject_ids: list[str] | None = None,
    acknowledge_qc_pending: bool = False,
    restrict_analysis_subject_ids: list[str] | tuple[str, ...] | None = None,
) -> CohortSnapshot:
    """Resolve and validate immutable analysis and selected cohort sets."""
    rows = discover_t1_resolutions(cfg)
    restricted: set[str] | None = None
    if restrict_analysis_subject_ids is not None:
        if any(
            not isinstance(subject_id, str) or not _safe_subject_id(subject_id)
            for subject_id in restrict_analysis_subject_ids
        ):
            raise CohortError("Provide only safe subject IDs in the recovery cohort.")
        restricted = set(restrict_analysis_subject_ids)
    scoped_rows = (
        rows
        if restricted is None
        else [row for row in rows if row.subject_id in restricted]
    )
    bad = [row for row in scoped_rows if row.state != "resolved"]
    if bad:
        reasons = []
        for row in bad:
            if row.state == "ambiguous":
                reasons.append(
                    f"Choose one T1 input for {row.subject_id} from "
                    f"{len(row.candidates)} candidates."
                )
            else:
                reasons.append(
                    f"Provide a resolved T1 input for {row.subject_id} "
                    f"(current state: {row.state})."
                )
        raise CohortError(" ".join(reasons))

    records = load_qc_records(cfg)
    excluded_cfg = config_excluded_subject_ids(cfg)
    analysis_cohort = resolve_analysis_cohort(scoped_rows, records, excluded_cfg)
    analysis = analysis_cohort.subject_ids
    pending_qc = analysis_cohort.pending_qc_subject_ids
    if pending_qc and not acknowledge_qc_pending:
        raise CohortError(
            f"Review {len(pending_qc)} deferred or unreviewed analysis subject(s); "
            "provide explicit acknowledgment."
        )

    requested = [] if subject_ids is None else [str(value) for value in subject_ids]
    if target_mode == "all":
        selected = analysis
    elif target_mode == "explicit":
        if any(not _safe_subject_id(value) for value in requested):
            raise CohortError("Provide only safe subject IDs in the selection.")
        unknown = sorted(set(requested) - set(analysis))
        if unknown:
            raise CohortError(
                f"Remove {len(unknown)} subject(s) outside the analysis cohort."
            )
        selected = tuple(value for value in analysis if value in set(requested))
    else:
        raise CohortError(
            f"Select a known workflow target mode instead of {target_mode}."
        )

    return analysis_cohort.snapshot(
        acknowledged=acknowledge_qc_pending, selected_subject_ids=selected
    )


def project_root(cfg: dict[str, Any]) -> str:
    """Return a canonical project root or raise when it is unresolved."""
    root = interpolate("${paths.projectRoot}", flatten(cfg))
    if not root or "${" in root:
        raise CohortError("Resolve paths.projectRoot.")
    return str(Path(root).resolve())
