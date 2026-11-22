"""Reuse verified per-subject units inside a cohort stage.

A cohort stage that registers a :class:`~.adapters.base.UnitContract` declares
per-subject units: the files each unit reads and the files it writes. Before
the stage launches, the workflow engine decides for every unit whether a
verified earlier result can stay in place:

- the newest earlier receipt that recorded the unit used the same method (the
  stage's bound command, scientific asset bytes, tool evidence, and step
  parameters);
- the SHA-256 of every unit input file, read now, equals the recorded input
  digest; and
- the SHA-256 of every file the unit owns, read now, equals the recorded
  output digest.

Every other unit is computed. After a clean exit the engine re-reads the
inputs and the reused outputs, and refuses the receipt when any changed. It
also refuses it when a computed unit's files were not all written during the
run, since a wrapper can exit cleanly after a failed child. Each computed
unit's earlier output is moved aside before launch into a run-scoped holding
area in the same output tree, so the tool writes into an empty location; on
success the held copy is removed, otherwise it is moved back and verified.
The receipt's ``unitReuse`` record then names each unit's mode, reason,
digests, and the run that rendered its bytes.

A plan forecast uses only recorded byte counts, so planning reads no file
contents; the launch decision is the content proof.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, TypeVar

from .adapters.base import ADAPTERS, UnitContract, UnitSpec
from .provenance import stable_digest
from .run_store import (
    UNIT_REUSE_KEY,
    UNIT_REUSE_SCHEMA,
    RunStore,
    receipt_record_contract_valid,
    valid_unit_subject_id,
)
from .source_digests import class_source_sha256

_T = TypeVar("_T")
_R = TypeVar("_R")

#: Read files with a few threads: per-file latency, not hashing, dominates.
_MAX_THREADS = 8
#: Never trust a unit that owns more entries than this.
_MAX_UNIT_ENTRIES = 4_096
#: Name at most this many subjects in one log line or job outcome.
_NAMED_SUBJECTS = 5

REUSED = "reused"
#: The holding area for earlier output, inside the output root so moves are
#: renames on one filesystem. No detector or gallery reads it.
HOLD_DIR = ".supraspina-held"
_HOLD_MANIFEST = "manifest.json"
#: Renders whose depicted content can differ from the render before them:
#: the unit's inputs or the stage method changed. A render for any other
#: reason (no earlier record, damaged output, reuse off) redraws the same
#: inputs with the same method.
CONTENT_CHANGE_REASONS = frozenset({"inputs-changed", "method-changed"})


class UnitReuseError(RuntimeError):
    """Report that a unit input or a reused output changed during the run."""


@dataclass(frozen=True)
class UnitIdentity:
    """Summarize the content identity of a unit's inputs or outputs."""

    sha256: str
    files: int
    bytes: int


@dataclass(frozen=True)
class PriorRecord:
    """Hold one earlier receipt's unit record for reuse decisions."""

    run_id: str
    receipt_sha256: str
    committed_at_ms: int
    method_sha256: str
    units: dict[str, dict[str, dict[str, Any]]]


@dataclass
class UnitDecision:
    """Record how one unit is handled in this run."""

    subject_id: str
    spec: UnitSpec
    mode: str
    reason: str
    inputs: UnitIdentity
    source: PriorRecord | None = None
    prior: dict[str, Any] | None = None
    outputs: UnitIdentity | None = None
    #: False for a subject whose ID a unit record cannot name.
    recorded: bool = True
    #: A computed unit's files before launch, to tell a rewrite from none.
    previous: UnitIdentity | None = None


@dataclass
class UnitPlan:
    """Hold every unit decision for one cohort stage launch."""

    contract: UnitContract
    method_sha256: str
    output_root: str
    subject_dirs: dict[str, str]
    reuse_enabled: bool = True
    decisions: list[UnitDecision] = field(default_factory=list)
    #: The output filesystem's clock at launch; computed files must be newer.
    launch_mtime_ns: int | None = None
    #: The run's holding area and the owned paths moved into it.
    held_area: str | None = None
    held: list[str] = field(default_factory=list)
    held_units: int = 0

    @property
    def unrecorded(self) -> list[str]:
        """Subjects computed every run because a record cannot name them."""
        seen: list[str] = []
        for decision in self.decisions:
            if not decision.recorded and decision.subject_id not in seen:
                seen.append(decision.subject_id)
        return seen

    def skipped(self) -> dict[str, frozenset[str]]:
        """Map each part to the subjects whose verified output stays in place."""
        parts: dict[str, set[str]] = {}
        for decision in self.decisions:
            if decision.mode == REUSED:
                parts.setdefault(decision.spec.part, set()).add(decision.subject_id)
        return {part: frozenset(subjects) for part, subjects in parts.items()}

    def summary(self) -> dict[str, Any]:
        """Return the subject-level counts the app states for this launch."""
        return summarize(
            (decision.subject_id, decision.mode, decision.source)
            for decision in self.decisions
        )


def summarize(
    rows: Iterable[tuple[str, str, PriorRecord | str | None]],
) -> dict[str, Any]:
    """Count subjects computed and reused; a subject is reused when all is."""
    computed: set[str] = set()
    seen: list[str] = []
    sources: set[str] = set()
    for subject_id, mode, source in rows:
        if subject_id not in seen:
            seen.append(subject_id)
        if mode != REUSED:
            computed.add(subject_id)
        elif isinstance(source, PriorRecord):
            sources.add(source.run_id)
        elif isinstance(source, str):
            sources.add(source)
    return {
        "computedSubjectIds": [value for value in seen if value in computed],
        "reusedSubjectIds": [value for value in seen if value not in computed],
        "sourceRunIds": sorted(sources),
    }


def _contract_source(contract: UnitContract) -> str:
    """Return the digest of the contract module's bytes for the method digest.

    Raise when the bytes are unreadable, so no unit is reused or recorded
    under a method that omits them.
    """
    digest = class_source_sha256(contract.__class__)
    if digest is None:
        raise RuntimeError(
            f"Supraspina could not read the {contract.step_key} unit contract source."
        )
    return digest


def method_digest(
    contract: UnitContract, payload: dict[str, Any], cfg: dict[str, Any]
) -> str:
    """Bind everything besides a unit's own inputs that determines its result.

    Take the stage's expected receipt payload: the bound command (run
    directory canonicalized, so it does not depend on the cohort), the bytes
    of the scientific assets it uses, the tool evidence, and the step
    parameters. Add the contract module's bytes, which decide the launch, and
    the tool identity the contract reports beyond the tool evidence. A frozen
    build reads the bytes' digest from the record its build wrote, so both
    builds bind the same bytes alike. Leave out the analysis cohort and
    unrelated configuration.
    """
    implementation = payload.get("adapterImplementation")
    resources = (
        implementation.get("scientificResources")
        if isinstance(implementation, dict)
        else None
    )
    return stable_digest(
        {
            "contract": contract.version,
            "executionActionDigest": payload.get("executionActionDigest"),
            "scientificResources": resources,
            "toolEvidenceDigest": payload.get("toolEvidenceDigest"),
            "stepParamsDigest": payload.get("stepParamsDigest"),
            "contractSource": _contract_source(contract),
            "tool": contract.method_identity(cfg),
        }
    )


def _map(work: Callable[[_T], _R], items: list[_T]) -> list[_R]:
    if len(items) <= 1:
        return [work(item) for item in items]
    with ThreadPoolExecutor(max_workers=min(_MAX_THREADS, len(items))) as pool:
        return list(pool.map(work, items))


def _file_entry(path: str, *, contents: bool) -> dict[str, Any]:
    """Describe one file by size and, when asked, its full SHA-256."""
    try:
        size = os.stat(path).st_size
        if not os.path.isfile(path):
            return {"exists": True, "kind": "other"}
        if not contents:
            return {"exists": True, "size": size}
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    except OSError:
        return {"exists": False}
    return {"exists": True, "size": size, "sha256": digest.hexdigest()}


def _identity(entries: list[tuple[str, dict[str, Any]]]) -> UnitIdentity:
    listed = [{"path": path, **entry} for path, entry in sorted(entries)]
    return UnitIdentity(
        sha256=stable_digest(listed),
        files=sum(1 for _path, entry in entries if entry.get("exists")),
        bytes=sum(int(entry.get("size") or 0) for _path, entry in entries),
    )


def _input_paths(subject_dir: str, spec: UnitSpec) -> list[tuple[str, str]]:
    return [
        (relative, os.path.join(subject_dir, *relative.split("/")))
        for relative in spec.inputs
    ]


def _output_paths(root: str, spec: UnitSpec) -> list[tuple[str, str]]:
    """List the files a unit owns now, relative to the output root."""
    if spec.output_dir is None:
        return [
            (relative, os.path.join(root, *relative.split("/")))
            for relative in spec.output_files
            if os.path.lexists(os.path.join(root, *relative.split("/")))
        ]
    directory = os.path.join(root, *spec.output_dir.split("/"))
    try:
        with os.scandir(directory) as iterator:
            names = []
            for index, entry in enumerate(iterator):
                if index >= _MAX_UNIT_ENTRIES:
                    raise UnitReuseError(
                        "A unit output directory holds too many entries to verify."
                    )
                names.append(entry.name)
    except FileNotFoundError:
        return []
    except NotADirectoryError:
        return [(spec.output_dir, directory)]
    return [
        (f"{spec.output_dir}/{name}", os.path.join(directory, name))
        for name in sorted(names)
    ]


def _identities(
    groups: list[list[tuple[str, str]]], *, contents: bool
) -> list[UnitIdentity]:
    """Read many groups of files in one bounded pool, keeping group order."""
    flat = [path for group in groups for _relative, path in group]
    entries = _map(lambda path: _file_entry(path, contents=contents), flat)
    identities: list[UnitIdentity] = []
    offset = 0
    for group in groups:
        described = [
            (relative, entries[offset + index])
            for index, (relative, _path) in enumerate(group)
        ]
        offset += len(group)
        identities.append(_identity(described))
    return identities


def prior_records(store: RunStore, contract: UnitContract) -> list[PriorRecord]:
    """Return the valid earlier unit records of one stage, newest first."""
    records: list[PriorRecord] = []
    for signature in sorted(store.receipt_signatures(contract.step_key, "cohort")):
        receipt = store.get_receipt(contract.step_key, "cohort", signature)
        record = receipt.get(UNIT_REUSE_KEY) if isinstance(receipt, dict) else None
        if (
            receipt is None
            or not isinstance(record, dict)
            or record.get("contract") != contract.version
        ):
            continue
        records.append(
            PriorRecord(
                run_id=str(receipt["runId"]),
                receipt_sha256=str(receipt["recordSha256"]),
                committed_at_ms=int(receipt["committedAtMs"]),
                method_sha256=str(record["methodSha256"]),
                units=record["units"],
            )
        )
    records.sort(key=lambda item: (item.committed_at_ms, item.run_id), reverse=True)
    return records


def decide(  # noqa: PLR0913 - Every argument is one decision input.
    contract: UnitContract,
    cfg: dict[str, Any],
    subject_dirs: dict[str, str],
    priors: list[PriorRecord],
    method_sha256: str,
    *,
    reuse_enabled: bool,
    contents: bool,
) -> UnitPlan:
    """Decide, for every unit of the cohort, whether to compute or reuse it.

    Pass ``contents=True`` at launch: inputs and candidate outputs are read
    in full and compared by SHA-256. Pass ``contents=False`` for a plan
    forecast, which compares recorded byte counts only.
    """
    root = contract.output_root(cfg)
    plan = UnitPlan(contract, method_sha256, root, dict(subject_dirs), reuse_enabled)
    specs = [
        (subject_id, spec)
        for subject_id in subject_dirs
        for spec in contract.units(cfg, subject_id)
    ]
    inputs = _identities(
        [_input_paths(subject_dirs[subject_id], spec) for subject_id, spec in specs],
        contents=contents,
    )
    pending: list[UnitDecision] = []
    for (subject_id, spec), identity in zip(specs, inputs, strict=True):
        decision = UnitDecision(subject_id, spec, "computed", "", identity)
        decision.recorded = valid_unit_subject_id(subject_id)
        plan.decisions.append(decision)
        newest = next(
            (prior for prior in priors if spec.part in prior.units.get(subject_id, {})),
            None,
        )
        if not decision.recorded:
            decision.reason = "no-record"
        elif newest is None:
            known = any(subject_id in prior.units for prior in priors)
            decision.reason = "no-record" if not priors or known else "new-subject"
        elif newest.method_sha256 != method_sha256:
            decision.reason = "method-changed"
        else:
            unit = newest.units[subject_id][spec.part]
            same_inputs = (
                identity.sha256 == unit.get("inputSha256")
                if contents
                else identity.bytes == unit.get("inputBytes")
            )
            if not same_inputs:
                decision.reason = "inputs-changed"
            else:
                decision.source = newest
                decision.prior = unit
                pending.append(decision)
    outputs = _identities(
        [_output_paths(root, decision.spec) for decision in pending],
        contents=contents,
    )
    for decision, identity in zip(pending, outputs, strict=True):
        unit = decision.prior or {}
        same_outputs = (
            identity.sha256 == unit.get("outputSha256")
            if contents
            else (
                identity.files == unit.get("outputFiles")
                and identity.bytes == unit.get("outputBytes")
            )
        )
        if same_outputs and identity.files > 0 and not reuse_enabled:
            # Reuse would apply; record that the operator turned it off.
            decision.reason = "reuse-off"
            decision.source = None
            decision.prior = None
        elif same_outputs and identity.files > 0:
            decision.mode = REUSED
            decision.reason = REUSED
            decision.outputs = identity
        else:
            decision.reason = "output-changed"
            decision.source = None
            decision.prior = None
    return plan


def begin(plan: UnitPlan, run_id: str) -> None:
    """Set aside the computed units' earlier output and note the launch clock.

    The clock comes from a marker file created and removed in the output
    root, so it is the filesystem's own time, comparable with the mtimes the
    tool writes there. The earlier output then moves into the run's holding
    area (see :func:`hold`), so the tool writes into an empty location.
    """
    computed = [d for d in plan.decisions if d.mode != REUSED]
    previous = _identities(
        [_output_paths(plan.output_root, decision.spec) for decision in computed],
        contents=True,
    )
    for decision, identity in zip(computed, previous, strict=True):
        decision.previous = identity
    os.makedirs(plan.output_root, exist_ok=True)
    marker = os.path.join(plan.output_root, f".supraspina-launch-{uuid.uuid4().hex}")
    with open(marker, "x", encoding="utf-8"):
        pass
    try:
        plan.launch_mtime_ns = os.stat(marker).st_mtime_ns
    finally:
        os.unlink(marker)
    hold(plan, run_id)


def _owned_entries(root: str, spec: UnitSpec) -> list[str]:
    """Return the owned paths that exist now: the unit folder or its files."""
    if spec.output_dir is not None:
        path = os.path.join(root, *spec.output_dir.split("/"))
        return [spec.output_dir] if os.path.lexists(path) else []
    return [
        relative
        for relative in spec.output_files
        if os.path.lexists(os.path.join(root, *relative.split("/")))
    ]


def _entry_digest(path: str) -> str:
    """Digest one held folder (every file in it) or one held file."""
    if os.path.isdir(path) and not os.path.islink(path):
        names = sorted(os.listdir(path))
        group = [(name, os.path.join(path, name)) for name in names]
    else:
        group = [("", path)]
    return _identities([group], contents=True)[0].sha256


def _write_json(path: str, value: Any) -> None:
    tmp = f"{path}.tmp-{uuid.uuid4().hex}"
    with open(tmp, "x", encoding="utf-8") as handle:
        json.dump(value, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def hold(plan: UnitPlan, run_id: str) -> None:
    """Move each computed unit's existing output into the run's holding area.

    The manifest, with a digest of every entry, is written before the first
    move, so an interrupted run leaves enough to restore it exactly.
    """
    root = plan.output_root
    entries: list[str] = []
    for decision in plan.decisions:
        if decision.mode != REUSED:
            owned = _owned_entries(root, decision.spec)
            entries.extend(owned)
            plan.held_units += bool(owned)
    if not entries:
        return
    area = os.path.join(root, HOLD_DIR, run_id)
    os.makedirs(os.path.join(area, "held"), exist_ok=False)
    digests = {
        relative: _entry_digest(os.path.join(root, *relative.split("/")))
        for relative in entries
    }
    _write_json(
        os.path.join(area, _HOLD_MANIFEST),
        {"runId": run_id, "entries": entries, "digests": digests},
    )
    plan.held_area = area
    for relative in entries:
        target = os.path.join(area, "held", *relative.split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        os.rename(os.path.join(root, *relative.split("/")), target)
        plan.held.append(relative)


def _remove_path(path: str) -> None:
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    elif os.path.lexists(path):
        os.unlink(path)


def _holds_files(path: str) -> bool:
    """Return whether a directory tree holds anything but empty folders."""
    if not os.path.isdir(path):
        return os.path.lexists(path)
    return any(files for _dir, _dirs, files in os.walk(path))


def _remove_area(area: str) -> None:
    """Remove a settled holding area, and the base folder once it is empty."""
    shutil.rmtree(area)
    base = os.path.dirname(area)
    if os.path.isdir(base) and not os.listdir(base):
        os.rmdir(base)


def _restore_area(
    root: str, area: str, entries: list[str], digests: Any
) -> tuple[int, list[str]]:
    """Move verified held entries back; leave and describe any that fail.

    Each held entry is checked against its manifest digest before it moves.
    One that does not match stays held, the current output stays live, and
    the area is kept, so nothing unverified becomes current and nothing is
    deleted that a person may need. Return the restored count and the
    problems, each naming the exact paths.
    """
    failed = os.path.join(area, "failed")
    restored = 0
    problems: list[str] = []
    for relative in entries:
        held = os.path.join(area, "held", *relative.split("/"))
        if not os.path.lexists(held):
            continue
        target = os.path.join(root, *relative.split("/"))
        expected = digests.get(relative) if isinstance(digests, dict) else None
        if expected is None or _entry_digest(held) != expected:
            problems.append(
                f"The held earlier output {held} does not match its digest from "
                f"before the launch, so it stays held and {target} stays as it "
                "is; compare them and keep the right one by hand. The unit is "
                "computed again on the next run."
            )
            continue
        aside = os.path.join(failed, *relative.split("/"))
        if os.path.lexists(aside):
            # New output an interrupted restore already set aside.
            _remove_path(aside)
        if os.path.lexists(target):
            os.makedirs(os.path.dirname(aside), exist_ok=True)
            os.rename(target, aside)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        os.rename(held, target)
        if os.path.lexists(aside):
            # The run's unrecorded new output; the earlier output is back.
            _remove_path(aside)
        restored += 1
    if not problems and not _holds_files(os.path.join(area, "held")):
        if _holds_files(failed):
            problems.append(
                f"{failed} still holds output that no held entry accounts for; "
                "check it by hand."
            )
        else:
            _remove_area(area)
    return restored, problems


def restore(plan: UnitPlan) -> int:
    """Put every verified held entry back; return how many were restored.

    Raise :class:`UnitReuseError` naming the paths when an entry does not
    verify; the verified ones are back and the area is kept.
    """
    if plan.held_area is None:
        return 0
    with open(os.path.join(plan.held_area, _HOLD_MANIFEST), encoding="utf-8") as h:
        manifest = json.load(h)
    count, problems = _restore_area(
        plan.output_root, plan.held_area, plan.held, manifest.get("digests")
    )
    if problems:
        raise UnitReuseError(" ".join(problems))
    plan.held_area = None
    return count


def release(plan: UnitPlan) -> list[str]:
    """Remove the held copy after success; return files the render dropped.

    A file in a held unit folder that the new render did not write again (an
    older tool version's file, an editor backup) leaves with the earlier
    output; the caller states it in the job log.
    """
    if plan.held_area is None:
        return []
    dropped: list[str] = []
    for relative in plan.held:
        held = os.path.join(plan.held_area, "held", *relative.split("/"))
        current = os.path.join(plan.output_root, *relative.split("/"))
        if os.path.isdir(held) and not os.path.islink(held):
            now = set(os.listdir(current)) if os.path.isdir(current) else set()
            dropped.extend(
                f"{relative}/{name}" for name in sorted(set(os.listdir(held)) - now)
            )
    _remove_area(plan.held_area)
    plan.held_area = None
    return dropped


def recover(root: str, recorded_runs: set[str]) -> list[str]:
    """Settle holding areas an interrupted run left; return log lines.

    A run whose receipt recorded its units finished: its new output is
    current, so the held copy is removed. Any other run did not: its earlier
    output is moved back over whatever it wrote and verified. An area without
    a readable manifest is left in place and stated, never guessed at.
    """
    base = os.path.join(root, HOLD_DIR)
    try:
        names = sorted(os.listdir(base))
    except FileNotFoundError:
        return []
    lines: list[str] = []
    for name in names:
        area = os.path.join(base, name)
        try:
            with open(os.path.join(area, _HOLD_MANIFEST), encoding="utf-8") as h:
                manifest = json.load(h)
            entries = [str(item) for item in manifest["entries"]]
        except (OSError, ValueError, KeyError, TypeError):
            if not _holds_files(area):
                _remove_area(area)
                continue
            lines.append(
                f"Earlier output held by {name} has no readable manifest and was "
                f"left in {area}; restore it by hand."
            )
            continue
        if name in recorded_runs:
            _remove_area(area)
            lines.append(
                f"Removed the earlier output that {name} held aside; its receipt "
                "records the new output."
            )
            continue
        count, problems = _restore_area(root, area, entries, manifest.get("digests"))
        if count:
            lines.append(
                f"Restored {held_entries(count)} that the interrupted run {name} "
                "held aside."
            )
        lines.extend(problems)
    return lines


def _mtime_ns(path: str) -> int:
    """Return a file's modification time, or -1 when it cannot be read."""
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return -1


def _stale_outputs(plan: UnitPlan, decision: UnitDecision, now: UnitIdentity) -> bool:
    """Return whether a computed unit's files were not all written this run."""
    spec = decision.spec
    owned = _output_paths(plan.output_root, spec)
    if not owned or (spec.output_dir is None and len(owned) != len(spec.output_files)):
        return True
    if any(
        not os.path.isfile(os.path.join(plan.output_root, *relative.split("/")))
        for relative in spec.required_files
    ):
        return True
    reference = plan.launch_mtime_ns
    if reference is None or any(
        _mtime_ns(path) < reference for _relative, path in owned
    ):
        return True
    previous = decision.previous
    # A stamped output never repeats its bytes, so equal bytes mean no write.
    return bool(
        plan.contract.outputs_embed_time
        and previous is not None
        and previous.files > 0
        and previous.sha256 == now.sha256
    )


def _stale_message(plan: UnitPlan, subjects: list[str]) -> str:
    adapter = ADAPTERS.get(plan.contract.step_key)
    stage = adapter.name if adapter is not None else plan.contract.step_key
    count = _subjects(len(subjects))
    shown = ", ".join(subjects[:_NAMED_SUBJECTS]) + (
        f", and {len(subjects) - _NAMED_SUBJECTS} more"
        if len(subjects) > _NAMED_SUBJECTS
        else ""
    )
    return (
        f"{stage} did not write all the files expected for {count} ({shown}), "
        "so no receipt was written and their earlier output is put back. "
        "Check the job log for the tool's error on these subjects, then run "
        "the stage again."
    )


def finish(plan: UnitPlan, run_id: str) -> dict[str, Any]:
    """Prove inputs, reused outputs and fresh computed outputs, then record.

    Raise :class:`UnitReuseError` when an input changed during the run, a
    reused output no longer matches its earlier receipt, or a computed unit's
    files were not all written during this run.
    """
    decisions = plan.decisions
    inputs = _identities(
        [
            _input_paths(plan.subject_dirs[decision.subject_id], decision.spec)
            for decision in decisions
        ],
        contents=True,
    )
    for decision, identity in zip(decisions, inputs, strict=True):
        if identity != decision.inputs:
            raise UnitReuseError(
                "A per-subject input changed during execution, so the receipt "
                "was refused."
            )
    outputs = _identities(
        [_output_paths(plan.output_root, decision.spec) for decision in decisions],
        contents=True,
    )
    stale = [
        decision.subject_id
        for decision, identity in zip(decisions, outputs, strict=True)
        if decision.mode != REUSED and _stale_outputs(plan, decision, identity)
    ]
    if stale:
        raise UnitReuseError(_stale_message(plan, list(dict.fromkeys(stale))))
    units: dict[str, dict[str, dict[str, Any]]] = {}
    sources: dict[str, str] = {}
    for decision, identity in zip(decisions, outputs, strict=True):
        if not decision.recorded:
            continue
        record: dict[str, Any] = {
            "mode": decision.mode,
            "reason": decision.reason,
            "inputSha256": decision.inputs.sha256,
            "inputBytes": decision.inputs.bytes,
            "outputSha256": identity.sha256,
            "outputFiles": identity.files,
            "outputBytes": identity.bytes,
        }
        if decision.mode == REUSED:
            if decision.outputs != identity or decision.source is None:
                raise UnitReuseError(
                    "A reused per-subject output changed during execution, so "
                    "the receipt was refused."
                )
            prior = decision.prior or {}
            record["renderedRunId"] = prior.get("renderedRunId")
            record["renderedReason"] = prior.get("renderedReason")
            record["sourceRunId"] = decision.source.run_id
            sources[decision.source.run_id] = decision.source.receipt_sha256
        else:
            record["renderedRunId"] = run_id
            record["renderedReason"] = decision.reason
        units.setdefault(decision.subject_id, {})[decision.spec.part] = record
    return {
        "schema": UNIT_REUSE_SCHEMA,
        "contract": plan.contract.version,
        "methodSha256": plan.method_sha256,
        "reuseEnabled": plan.reuse_enabled,
        "sources": dict(sorted(sources.items())),
        "units": units,
        "unrecordedSubjectIds": plan.unrecorded,
    }


def record_summary(record: Any) -> dict[str, Any] | None:
    """Return the subject-level summary of one receipt's unit record."""
    if not isinstance(record, dict) or not isinstance(record.get("units"), dict):
        return None
    unrecorded = record.get("unrecordedSubjectIds")
    rows: list[tuple[str, str, PriorRecord | str | None]] = [
        (subject_id, str(unit.get("mode")), unit.get("sourceRunId"))
        for subject_id, parts in record["units"].items()
        if isinstance(parts, dict)
        for unit in parts.values()
        if isinstance(unit, dict)
    ]
    rows.extend(
        (str(subject_id), "computed", None)
        for subject_id in (unrecorded if isinstance(unrecorded, list) else [])
    )
    return summarize(rows)


def held_entries(count: int) -> str:
    """Count held output entries: unit folders or single files."""
    noun = "folder or file" if count == 1 else "folders or files"
    return f"{count} earlier output {noun}"


def _subjects(count: int) -> str:
    return f"{count} subject{'' if count == 1 else 's'}"


def unrecorded_line(subjects: list[str]) -> str | None:
    """State the subjects computed every run because a record cannot name them."""
    if not subjects:
        return None
    named = ", ".join(subjects[:_NAMED_SUBJECTS])
    more = ", ..." if len(subjects) > _NAMED_SUBJECTS else ""
    return (
        f"{_subjects(len(subjects))} ({named}{more}) have IDs outside letters, "
        "digits, dot, dash and underscore, so no unit record names them and "
        "they are computed every run."
    )


def log_line(summary: dict[str, Any]) -> str:
    """State one launch's per-subject reuse decision for the job log."""
    computed = len(summary["computedSubjectIds"])
    reused = len(summary["reusedSubjectIds"])
    if reused == 0:
        return (
            f"Per-subject reuse: computing {_subjects(computed)}; no verified "
            "earlier output matches."
        )
    sources = ", ".join(summary["sourceRunIds"])
    computing = _subjects(computed) if computed else "no subjects"
    return (
        f"Per-subject reuse: computing {computing} and reusing the "
        f"verified output of {_subjects(reused)} from {sources}."
    )


def stage_record(state: Any, step_key: str) -> dict[str, Any] | None:
    """Return the unit record of a run's valid receipt for one stage."""
    receipts = state.get("receipts") if isinstance(state, dict) else None
    for receipt in reversed(receipts if isinstance(receipts, list) else []):
        if (
            isinstance(receipt, dict)
            and receipt.get("stepKey") == step_key
            and UNIT_REUSE_KEY in receipt
            and receipt_record_contract_valid(receipt)
        ):
            return receipt[UNIT_REUSE_KEY]
    return None


def superseded_review(  # noqa: PLR0913 - Each argument names one identity.
    store: RunStore,
    state: dict[str, Any],
    step_key: str,
    subject_id: str,
    part: str,
    reviewed_run_id: str | None,
) -> dict[str, str] | None:
    """Say whether a verdict predates a content-changing render of a unit.

    ``state`` is the run whose output is shown and ``reviewed_run_id`` the
    run whose galleries backed the recorded verdict. The verdict still
    describes the shown bytes when both runs carry the render of the same
    run; reused units do. Report only a render made because the unit's
    inputs or the stage method changed, so a redraw of the same inputs, or a
    unit without a record, keeps the verdict as it was.
    """
    record = stage_record(state, step_key)
    unit = (record or {}).get("units", {}).get(subject_id, {}).get(part)
    if (
        not isinstance(unit, dict)
        or not reviewed_run_id
        or reviewed_run_id == unit.get("renderedRunId")
        or unit.get("renderedReason") not in CONTENT_CHANGE_REASONS
    ):
        return None
    try:
        reviewed_state: dict[str, Any] | None = store.load(reviewed_run_id)
    except (OSError, ValueError, KeyError):
        reviewed_state = None
    reviewed = (stage_record(reviewed_state, step_key) or {}).get("units", {})
    reviewed_unit = reviewed.get(subject_id, {}).get(part)
    if isinstance(reviewed_unit, dict) and (
        reviewed_unit.get("renderedRunId") == unit.get("renderedRunId")
    ):
        return None
    return {
        "renderedRunId": str(unit["renderedRunId"]),
        "reason": str(unit["renderedReason"]),
    }
