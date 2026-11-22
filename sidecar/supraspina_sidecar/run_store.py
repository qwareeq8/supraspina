"""Project-scoped workflow run persistence with crash recovery.

Every generation directory is immutable. ``state.json`` is the sole commit
point and is published only after every generation file is written, synced, and
renamed. Recovery ignores temporary or orphan generations and trusts only the
last complete generation referenced by that pointer.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import threading
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any, ClassVar

RUN_STATE_VERSION = 1
MANIFEST_VERSION = 1
#: Version 4 canonicalizes the app-generated run directory inside the bound
#: execution action, so a version 3 receipt cannot be revalidated and is
#: rejected rather than silently rematched.
RECEIPT_VERSION = 4
RECONSTRUCTION_RECEIPT_VERSION = 2
_RUN_ID = re.compile(r"^run-[a-f0-9]{8,32}$")
_HEX_DIGEST = re.compile(r"^[a-f0-9]{64}$")
_MAX_POINTER_BYTES = 256 * 1024
_MAX_GENERATION_FILE_BYTES = 64 * 1024 * 1024
_MAX_GENERATION_TOTAL_BYTES = 128 * 1024 * 1024
_MAX_RECEIPT_BYTES = 16 * 1024 * 1024
_MAX_RUN_INDEX_ENTRIES = 100_000
_MAX_GENERATION_ENTRIES = 10_000
#: Retain the current generation and this many superseded ones. Every earlier
#: generation is a strictly older snapshot of the same run: the pointer names
#: the only generation `load` reads, and the retained tail keeps a readable
#: predecessor while a pointer replacement is in flight. Nothing the product
#: contract requires - run history, receipts, terminal state, or evidence -
#: lives only in a pruned generation.
_RETAINED_GENERATIONS = 8
_GENERATION_FILES = frozenset(
    {
        "config.json",
        "graph.json",
        "jobs.json",
        "evidence.json",
        "manifest.json",
        "run.json",
    }
)
RECEIPT_PAYLOAD_KEYS = (
    "receiptVersion",
    "stepKey",
    "subjectId",
    "scope",
    "analysisCohortDigest",
    "selectedSubsetDigest",
    "inputT1Fingerprint",
    "configurationDigest",
    "stepParamsDigest",
    "executionActionDigest",
    "adapterIdentity",
    "adapterImplementation",
    "toolEvidenceDigest",
    "externalInputs",
    "defacing",
    "outputSchemaIdentity",
    "upstreamSignatures",
    "baseline",
    "scopeBinding",
)
RECEIPT_RECORD_KEYS = (
    *RECEIPT_PAYLOAD_KEYS,
    "signature",
    "runId",
    "jobId",
    "committedAtMs",
    "detectorEvidence",
    "edgeEvidence",
    "launchInputProjections",
    "launchDirectScientificInputs",
)
_FREESURFER_OUTPUT_SCHEMA = "freesurfer:recon-tree:v1"
_FASTSURFER_OUTPUT_SCHEMA = "fastsurfer:recon-tree:v2"


def receipt_payload_keys(receipt_version: Any) -> tuple[str, ...] | None:
    """Return the digest-bound keys for the sole supported receipt contract."""
    if receipt_version == RECEIPT_VERSION:
        return RECEIPT_PAYLOAD_KEYS
    return None


#: The optional record of an execution fallback, such as a Reconstruction that
#: reran with ``-no-fix-ga``. It sits outside the signed payload, so the
#: receipt still matches the plan's bound command, and only a receipt that
#: carries it binds it, so every other receipt keeps its record digest. A
#: single rerun has the four summary fields; composed reruns add ``reruns``,
#: one entry per rerun in order, which the summary fields must restate.
EXECUTION_FALLBACK_KEY = "executionFallback"
_EXECUTION_FALLBACK_FIELDS = frozenset(
    {"kind", "addedArguments", "reason", "firstAttemptExitCode"}
)
_COMPOSED_FALLBACK_FIELDS = _EXECUTION_FALLBACK_FIELDS | {"reruns"}
_RERUN_FIELDS = frozenset({"kind", "addedArguments", "reason", "attemptExitCode"})


#: The optional record of per-subject unit reuse in a cohort stage. Like
#: :data:`EXECUTION_FALLBACK_KEY` it sits outside the signed payload, so the
#: receipt still matches the plan's bound command, and only a receipt that
#: carries it binds it. It names, per subject and unit, whether the unit was
#: computed in this run or reused from an earlier verified run, with the
#: digests that decided it.
UNIT_REUSE_KEY = "unitReuse"
UNIT_REUSE_SCHEMA = "unit-reuse:v1"
#: Why a unit was computed rather than reused.
UNIT_COMPUTE_REASONS = frozenset(
    {
        "new-subject",
        "no-record",
        "method-changed",
        "inputs-changed",
        "output-changed",
        "reuse-off",
    }
)
_UNIT_FIELDS = frozenset(
    {
        "mode",
        "reason",
        "inputSha256",
        "inputBytes",
        "outputSha256",
        "outputFiles",
        "outputBytes",
        "renderedRunId",
        "renderedReason",
    }
)
_MAX_UNIT_SUBJECTS = 5_000
_MAX_SUBJECT_ID_LENGTH = 128
_MAX_UNIT_PARTS = 16
_UNIT_NAME = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
#: A subject ID a unit record can name: ASCII letters, digits, dot, dash and
#: underscore, as the skip lists and output file names need. A cohort
#: subject outside it is computed every run and listed as unrecorded.
UNIT_SUBJECT_ID = re.compile(r"^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$")


def valid_unit_subject_id(value: Any) -> bool:
    """Return whether a subject ID can name units in a unit-reuse record."""
    return isinstance(value, str) and UNIT_SUBJECT_ID.fullmatch(value) is not None


def _count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _unit_valid(unit: Any, sources: dict[str, Any]) -> bool:
    if not isinstance(unit, dict):
        return False
    mode = unit.get("mode")
    expected = _UNIT_FIELDS | ({"sourceRunId"} if mode == "reused" else set())
    if set(unit) != expected:
        return False
    if mode == "reused":
        if unit.get("reason") != "reused" or unit.get("sourceRunId") not in sources:
            return False
    elif mode != "computed" or unit.get("reason") not in UNIT_COMPUTE_REASONS:
        return False
    return (
        all(
            isinstance(unit.get(key), str)
            and _HEX_DIGEST.fullmatch(unit[key]) is not None
            for key in ("inputSha256", "outputSha256")
        )
        and all(
            _count(unit.get(key))
            for key in ("inputBytes", "outputFiles", "outputBytes")
        )
        and isinstance(unit.get("renderedRunId"), str)
        and _RUN_ID.fullmatch(unit["renderedRunId"]) is not None
        and unit.get("renderedReason") in UNIT_COMPUTE_REASONS
    )


def unit_reuse_valid(value: Any) -> bool:  # noqa: PLR0911 - Fail closed per rule.
    """Validate one unit-reuse record's exact shape."""
    if not isinstance(value, dict) or set(value) != {
        "schema",
        "contract",
        "methodSha256",
        "reuseEnabled",
        "sources",
        "units",
        "unrecordedSubjectIds",
    }:
        return False
    sources = value.get("sources")
    units = value.get("units")
    unrecorded = value.get("unrecordedSubjectIds")
    if (
        not isinstance(value.get("reuseEnabled"), bool)
        or not isinstance(unrecorded, list)
        or len(unrecorded) > _MAX_UNIT_SUBJECTS
        or not all(
            isinstance(item, str)
            and 0 < len(item) <= _MAX_SUBJECT_ID_LENGTH
            and not valid_unit_subject_id(item)
            for item in unrecorded
        )
        or len(set(unrecorded)) != len(unrecorded)
    ):
        return False
    if (
        value.get("schema") != UNIT_REUSE_SCHEMA
        or not isinstance(value.get("contract"), str)
        or _UNIT_NAME.fullmatch(value["contract"]) is None
        or not isinstance(value.get("methodSha256"), str)
        or _HEX_DIGEST.fullmatch(value["methodSha256"]) is None
        or not isinstance(sources, dict)
        or not isinstance(units, dict)
        or len(units) > _MAX_UNIT_SUBJECTS
        or len(sources) > _MAX_UNIT_SUBJECTS
    ):
        return False
    if not all(
        isinstance(run_id, str)
        and _RUN_ID.fullmatch(run_id) is not None
        and isinstance(digest, str)
        and _HEX_DIGEST.fullmatch(digest) is not None
        for run_id, digest in sources.items()
    ):
        return False
    referenced: set[str] = set()
    for subject_id, parts in units.items():
        if (
            not valid_unit_subject_id(subject_id)
            or subject_id in unrecorded
            or not isinstance(parts, dict)
            or not parts
            or len(parts) > _MAX_UNIT_PARTS
        ):
            return False
        for part, unit in parts.items():
            if not isinstance(part, str) or _UNIT_NAME.fullmatch(part) is None:
                return False
            if not _unit_valid(unit, sources):
                return False
            if unit["mode"] == "reused":
                referenced.add(unit["sourceRunId"])
    # Every listed source backs at least one reused unit.
    return referenced == set(sources)


def receipt_record_keys(
    step_key: Any, *, execution_fallback: bool = False, unit_reuse: bool = False
) -> tuple[str, ...]:
    """Return every field covered by the durable receipt record digest."""
    if step_key == "recon":
        keys = (*RECEIPT_RECORD_KEYS, "reconstruction", "reconstructionSignature")
        return (*keys, EXECUTION_FALLBACK_KEY) if execution_fallback else keys
    if unit_reuse:
        return (*RECEIPT_RECORD_KEYS, UNIT_REUSE_KEY)
    return RECEIPT_RECORD_KEYS


def _receipt_keys(receipt: dict[str, Any]) -> tuple[str, ...]:
    return receipt_record_keys(
        receipt.get("stepKey"),
        execution_fallback=EXECUTION_FALLBACK_KEY in receipt,
        unit_reuse=UNIT_REUSE_KEY in receipt,
    )


def _unit_reuse_bound(receipt: dict[str, Any]) -> bool:
    """Bind a unit-reuse record to its cohort receipt.

    The record's units and unrecorded subjects together cover exactly the
    receipt's analysis cohort, and every unit computed in it names the
    receipt's own run as the one that rendered it.
    """
    record = receipt.get(UNIT_REUSE_KEY)
    binding = receipt.get("scopeBinding")
    if (
        not unit_reuse_valid(record)
        or receipt.get("scope") != "cohort"
        or not isinstance(binding, dict)
        or not isinstance(binding.get("analysisSubjectIds"), list)
        or set(record["units"]) | set(record["unrecordedSubjectIds"])
        != set(binding["analysisSubjectIds"])
    ):
        return False
    return all(
        unit["renderedRunId"] == receipt.get("runId")
        for parts in record["units"].values()
        for unit in parts.values()
        if unit["mode"] == "computed"
    )


def _fallback_fields_valid(value: dict[str, Any], exit_code_key: str) -> bool:
    arguments = value.get("addedArguments")
    exit_code = value.get(exit_code_key)
    return (
        isinstance(value.get("kind"), str)
        and bool(value["kind"])
        and isinstance(arguments, list)
        and bool(arguments)
        and all(isinstance(item, str) and item for item in arguments)
        and isinstance(value.get("reason"), str)
        and bool(value["reason"])
        and isinstance(exit_code, int)
        and not isinstance(exit_code, bool)
    )


def execution_fallback_valid(value: Any) -> bool:
    """Validate one execution-fallback record's exact shape."""
    if not isinstance(value, dict):
        return False
    if set(value) == _EXECUTION_FALLBACK_FIELDS:
        return _fallback_fields_valid(value, "firstAttemptExitCode")
    if set(value) != _COMPOSED_FALLBACK_FIELDS or not _fallback_fields_valid(
        value, "firstAttemptExitCode"
    ):
        return False
    reruns = value["reruns"]
    # A single rerun keeps the four-field shape.
    if not isinstance(reruns, list) or len(reruns) <= 1:
        return False
    for rerun in reruns:
        if not (
            isinstance(rerun, dict)
            and set(rerun) == _RERUN_FIELDS
            and _fallback_fields_valid(rerun, "attemptExitCode")
            and len(rerun["addedArguments"]) == 1
        ):
            return False
    arguments = [rerun["addedArguments"][0] for rerun in reruns]
    return (
        len(set(arguments)) == len(arguments)
        and value["addedArguments"] == arguments
        and value["kind"] == "+".join(rerun["kind"] for rerun in reruns)
        and value["reason"] == " ".join(rerun["reason"] for rerun in reruns)
        and value["firstAttemptExitCode"] == reruns[0]["attemptExitCode"]
    )


def receipt_record_digest(receipt: dict[str, Any]) -> str:
    """Return the digest that binds provenance and produced-artifact evidence."""
    record = {key: receipt.get(key) for key in _receipt_keys(receipt)}
    encoded = json.dumps(
        record,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def receipt_record_contract_valid(receipt: dict[str, Any]) -> bool:
    """Validate the exact current durable receipt envelope and its digest."""
    record_keys = _receipt_keys(receipt)
    if set(receipt) != {*record_keys, "recordSha256"}:
        return False
    if EXECUTION_FALLBACK_KEY in record_keys and not execution_fallback_valid(
        receipt.get(EXECUTION_FALLBACK_KEY)
    ):
        return False
    if UNIT_REUSE_KEY in record_keys and not _unit_reuse_bound(receipt):
        return False
    record_sha256 = receipt.get("recordSha256")
    return (
        isinstance(record_sha256, str)
        and _HEX_DIGEST.fullmatch(record_sha256) is not None
        and isinstance(receipt.get("runId"), str)
        and bool(receipt["runId"])
        and isinstance(receipt.get("jobId"), str)
        and bool(receipt["jobId"])
        and isinstance(receipt.get("committedAtMs"), int)
        and not isinstance(receipt.get("committedAtMs"), bool)
        and receipt["committedAtMs"] >= 0
        and isinstance(receipt.get("detectorEvidence"), dict)
        and isinstance(receipt.get("edgeEvidence"), dict)
        and isinstance(receipt.get("launchInputProjections"), list)
        and isinstance(receipt.get("launchDirectScientificInputs"), list)
        and receipt_record_digest(receipt) == record_sha256
    )


def receipt_scope_contract_valid(receipt: dict[str, Any]) -> bool:
    """Validate the subject or cohort scope binding."""
    if receipt.get("receiptVersion") != RECEIPT_VERSION:
        return False
    binding = receipt.get("scopeBinding")
    if not isinstance(binding, dict) or binding.get("bindingVersion") != 1:
        return False
    scope = receipt.get("scope")
    if scope == "subject":
        return (
            isinstance(receipt.get("subjectId"), str)
            and bool(receipt["subjectId"])
            and receipt.get("analysisCohortDigest") is None
            and receipt.get("selectedSubsetDigest") is None
            and isinstance(receipt.get("inputT1Fingerprint"), str)
            and bool(receipt["inputT1Fingerprint"])
            and isinstance(binding.get("inputT1FingerprintStrategy"), str)
            and binding
            == {
                "bindingVersion": 1,
                "kind": "subject-input",
                "subjectId": receipt.get("subjectId"),
                "inputT1Fingerprint": receipt.get("inputT1Fingerprint"),
                "inputT1FingerprintStrategy": binding.get("inputT1FingerprintStrategy"),
            }
        )
    if scope != "cohort":
        return False
    return (
        set(binding)
        == {
            "bindingVersion",
            "kind",
            "analysisCohortDigest",
            "analysisSubjectIds",
            "qcVerdicts",
            "qcAcknowledged",
            "excludedByConfig",
            "excludedByQc",
        }
        and receipt.get("subjectId") is None
        and receipt.get("selectedSubsetDigest") is None
        and isinstance(receipt.get("analysisCohortDigest"), str)
        and binding.get("kind") == "analysis-cohort"
        and binding.get("analysisCohortDigest") == receipt.get("analysisCohortDigest")
        and isinstance(binding.get("analysisSubjectIds"), list)
        and all(isinstance(value, str) for value in binding["analysisSubjectIds"])
        and isinstance(binding.get("qcVerdicts"), dict)
        and all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in binding["qcVerdicts"].items()
        )
        and isinstance(binding.get("qcAcknowledged"), bool)
        and isinstance(binding.get("excludedByConfig"), list)
        and all(isinstance(value, str) for value in binding["excludedByConfig"])
        and isinstance(binding.get("excludedByQc"), list)
        and all(isinstance(value, str) for value in binding["excludedByQc"])
    )


def reconstruction_receipt_contract_valid(
    receipt: dict[str, Any], payload_signature: str
) -> bool:
    """Validate a digest-bound backend-aware reconstruction envelope.

    Bind every reconstruction receipt to the outer payload digest through a
    separate envelope digest. Always require the envelope.

    Parameters
    ----------
    payload_signature
        Provide the validated digest of the receipt payload.

    Returns
    -------
    bool
        Report whether the reconstruction backend metadata is valid.
    """
    reconstruction = receipt.get("reconstruction")
    envelope_signature = receipt.get("reconstructionSignature")
    if (
        not isinstance(reconstruction, dict)
        or not isinstance(envelope_signature, str)
        or _HEX_DIGEST.fullmatch(envelope_signature) is None
        or reconstruction.get("receiptVersion") != RECONSTRUCTION_RECEIPT_VERSION
        or reconstruction.get("payloadSignature") != payload_signature
        or receipt.get("receiptVersion") != RECEIPT_VERSION
    ):
        return False
    backend = reconstruction.get("backend")
    device = reconstruction.get("device")
    output_subdir = reconstruction.get("outputSubdir")
    provider = reconstruction.get("provider")
    if (
        backend not in {"freesurfer", "fastsurfer"}
        or output_subdir != backend
        or not isinstance(provider, dict)
        or not isinstance(provider.get("name"), str)
        or not isinstance(provider.get("version"), str)
    ):
        return False
    if backend == "freesurfer":
        if device is not None or receipt.get("outputSchemaIdentity") != (
            _FREESURFER_OUTPUT_SCHEMA
        ):
            return False
    elif device not in {"cpu", "cuda"} or receipt.get("outputSchemaIdentity") != (
        _FASTSURFER_OUTPUT_SCHEMA
    ):
        return False
    encoded = json.dumps(
        reconstruction,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest() == envelope_signature


class PersistenceError(OSError):
    """Represent a run generation that could not reach its commit point."""


FaultHook = Callable[[str, str, int], None]


def canonical_project_root(root: str) -> str:
    """Return a canonical absolute project root."""
    if not root or "\x00" in root:
        raise ValueError("Provide a project root.")
    return str(Path(root).resolve())


def _fsync_dir(path: str) -> None:
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
    ).encode("utf-8")


def _read_bounded(path: str, maximum_bytes: int, label: str) -> bytes:
    with open(path, "rb") as handle:
        data = handle.read(maximum_bytes + 1)
    if len(data) > maximum_bytes:
        raise PersistenceError(
            f"Reject {label} because it exceeds the bounded size limit."
        )
    return data


def _bounded_directory_names(path: str, maximum_entries: int, label: str) -> list[str]:
    names: list[str] = []
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                if len(names) >= maximum_entries:
                    raise PersistenceError(
                        f"Reject {label} because it exceeds the bounded entry limit."
                    )
                names.append(entry.name)
    except FileNotFoundError:
        raise
    except PersistenceError:
        raise
    except OSError as exc:
        raise PersistenceError(f"Reject {label} because it cannot be read.") from exc
    return names


def _bounded_generation_payloads(
    payloads: dict[str, Any], run_id: str
) -> dict[str, bytes]:
    """Serialize one generation and enforce the same bounds as loading.

    Reject an oversized state before any bytes reach the store. Committing past
    the load bounds would publish a generation that can never be read back,
    which strands the run instead of surfacing a retryable persistence failure.
    """
    encoded: dict[str, bytes] = {}
    total_bytes = 0
    for name, payload in payloads.items():
        try:
            data = _json_bytes(payload)
        except (TypeError, ValueError) as exc:
            raise PersistenceError(
                f"Reject run {run_id} because {name} is not serializable."
            ) from exc
        if len(data) > _MAX_GENERATION_FILE_BYTES:
            raise PersistenceError(
                f"Reject run {run_id} because {name} exceeds the bounded run "
                "generation file size limit."
            )
        total_bytes += len(data)
        if total_bytes > _MAX_GENERATION_TOTAL_BYTES:
            raise PersistenceError(
                f"Reject run {run_id} because its generation exceeds the bounded "
                "total size limit."
            )
        encoded[name] = data
    return encoded


def _verified_generation_payloads(
    generation_dir: str, digests: dict[str, Any], run_id: str
) -> dict[str, bytes]:
    payloads: dict[str, bytes] = {}
    seen_names: set[str] = set()
    total_bytes = 0
    try:
        for name, expected in digests.items():
            if not re.fullmatch(r"[a-z]+\.json", str(name)):
                raise PersistenceError(
                    f"Reject run {run_id} because it declares an unsafe file."
                )
            data = _read_bounded(
                os.path.join(generation_dir, str(name)),
                _MAX_GENERATION_FILE_BYTES,
                "the run generation file",
            )
            total_bytes += len(data)
            if total_bytes > _MAX_GENERATION_TOTAL_BYTES:
                raise PersistenceError(
                    "Reject the run generation because it exceeds the bounded total "
                    "size limit."
                )
            if hashlib.sha256(data).hexdigest() != expected:
                raise PersistenceError(
                    f"Reject run {run_id} because generation file {name} has a "
                    "digest mismatch."
                )
            normalized_name = str(name)
            seen_names.add(normalized_name)
            if normalized_name in {"manifest.json", "run.json"}:
                payloads[normalized_name] = data
    except PersistenceError:
        raise
    except OSError as exc:
        raise PersistenceError(
            f"Reject run {run_id} because its generation is unreadable."
        ) from exc
    if seen_names != _GENERATION_FILES:
        raise PersistenceError(
            f"Reject run {run_id} because its generation is incomplete."
        )
    return payloads


def _decode_generation_json(data: bytes, run_id: str) -> Any:
    try:
        return json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise PersistenceError(
            f"Reject run {run_id} because its generation is unreadable."
        ) from exc


def _require_current_schema(
    value: Any,
    current_version: int,
    malformed_message: str,
    unsupported_message: str,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PersistenceError(malformed_message)
    schema_version = value.get("schemaVersion")
    if type(schema_version) is not int or schema_version != current_version:
        raise PersistenceError(unsupported_message)
    return value


def _write_fsynced(path: str, data: bytes) -> str:
    with open(path, "xb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    return hashlib.sha256(data).hexdigest()


class RunStore:
    """Persist and rehydrate workflow runs for one explicit project root."""

    _locks_guard = threading.Lock()
    _locks: ClassVar[dict[str, Any]] = {}

    def __init__(
        self, project_root: str, *, fault_hook: FaultHook | None = None
    ) -> None:
        self.project_root = canonical_project_root(project_root)
        self.runs_root = os.path.join(self.project_root, ".supraspina", "runs")
        self.receipts_root = os.path.join(self.project_root, ".supraspina", "receipts")
        self._fault_hook = fault_hook
        with self._locks_guard:
            self._lock = self._locks.setdefault(self.runs_root, threading.RLock())

    def _fault(self, stage: str, run_id: str, generation: int) -> None:
        if self._fault_hook is not None:
            self._fault_hook(stage, run_id, generation)

    def run_dir(self, run_id: str) -> str:
        """Return the validated durable directory for one run ID."""
        if not _RUN_ID.fullmatch(run_id):
            raise ValueError("Provide a valid run ID.")
        return os.path.join(self.runs_root, run_id)

    def commit(self, state: dict[str, Any]) -> int:
        """Publish one complete immutable generation and return its number."""
        with self._lock:
            return self._commit(state)

    def _stage_generation(
        self, run_id: str, generations: str
    ) -> tuple[int, str, str, dict[str, Any] | None]:
        """Stage the next generation directory under the PersistenceError contract."""
        try:
            os.makedirs(generations, exist_ok=True)
            previous = self.pointer(run_id)
            generation = int(previous.get("generation", 0) if previous else 0) + 1
            # Treat a generation without the pointer as uncommitted.
            for name in _bounded_directory_names(
                generations, _MAX_GENERATION_ENTRIES, "the run generation index"
            ):
                match = re.fullmatch(r"gen-(\d{8})", name)
                if match and int(match.group(1)) >= generation:
                    shutil.rmtree(os.path.join(generations, name))
            tmp_name = f".gen-{generation:08d}.tmp-{uuid.uuid4().hex}"
            tmp_dir = os.path.join(generations, tmp_name)
            final_dir = os.path.join(generations, f"gen-{generation:08d}")
            os.mkdir(tmp_dir)
        except PersistenceError:
            raise
        except OSError as exc:
            raise PersistenceError(
                f"Retry because run {run_id} could not stage a new generation."
            ) from exc
        return generation, tmp_dir, final_dir, previous

    @staticmethod
    def _snapshot_state(
        state: dict[str, Any], run_id: str, tmp_dir: str
    ) -> dict[str, Any]:
        """Copy the live run state under the PersistenceError contract.

        A container mutated by another thread while the copy walks it aborts the
        copy with a RuntimeError. Report that as a persistence failure, because
        every caller settles a failed commit through PersistenceError alone.
        """
        try:
            return copy.deepcopy(state)
        except RuntimeError as exc:
            try:
                shutil.rmtree(tmp_dir)
            except OSError:
                pass
            raise PersistenceError(
                f"Retry because run {run_id} changed while its state was copied."
            ) from exc

    def _commit(self, state: dict[str, Any]) -> int:
        """Commit the implementation while holding the project run-store lock."""
        run_id = str(state.get("runId", ""))
        run_dir = self.run_dir(run_id)
        generations = os.path.join(run_dir, "generations")
        generation, tmp_dir, final_dir, previous = self._stage_generation(
            run_id, generations
        )
        digests: dict[str, str] = {}
        snapshot = self._snapshot_state(state, run_id, tmp_dir)
        snapshot["schemaVersion"] = RUN_STATE_VERSION
        snapshot["generation"] = generation
        snapshot["durable"] = True
        manifest = snapshot.get("manifest")
        if isinstance(manifest, dict):
            manifest["schemaVersion"] = MANIFEST_VERSION
        payloads = {
            "config.json": snapshot.get("config", {}),
            "graph.json": {
                "runId": run_id,
                "intent": snapshot.get("intent", {}),
                "project": snapshot.get("project", {}),
                "scope": snapshot.get("scope", {}),
                "nodes": snapshot.get("nodes", []),
                "status": snapshot.get("status"),
                "terminalReason": snapshot.get("terminalReason"),
                "parentRunId": snapshot.get("parentRunId"),
            },
            "jobs.json": snapshot.get("jobs", []),
            "evidence.json": {
                "receipts": snapshot.get("receipts", []),
                "warnings": snapshot.get("warnings", []),
                "baseline": snapshot.get("baseline", {}),
            },
            "manifest.json": snapshot.get("manifest", {}),
            "run.json": snapshot,
        }
        try:
            encoded = _bounded_generation_payloads(payloads, run_id)
        except PersistenceError:
            try:
                shutil.rmtree(tmp_dir)
            except OSError:
                pass
            raise
        try:
            for name, data in encoded.items():
                self._fault(f"before_write:{name}", run_id, generation)
                digests[name] = _write_fsynced(os.path.join(tmp_dir, name), data)
                self._fault(f"after_write:{name}", run_id, generation)
            _fsync_dir(tmp_dir)
            self._fault("before_generation_rename", run_id, generation)
            os.replace(tmp_dir, final_dir)
            _fsync_dir(generations)
            if previous is None:
                _fsync_dir(self.runs_root)
            self._fault("before_pointer", run_id, generation)
            pointer = {
                "schemaVersion": RUN_STATE_VERSION,
                "generation": generation,
                "directory": os.path.basename(final_dir),
                "digests": digests,
            }
            pointer_tmp = os.path.join(run_dir, f".state.tmp-{uuid.uuid4().hex}")
            _write_fsynced(pointer_tmp, _json_bytes(pointer))
            os.replace(pointer_tmp, os.path.join(run_dir, "state.json"))
            _fsync_dir(run_dir)
            self._fault("after_pointer", run_id, generation)
            self._prune_generations(run_id, generations, generation)
            return generation
        except Exception as exc:
            committed = self.pointer(run_id)
            if (
                committed is not None
                and int(committed.get("generation", 0)) == generation
            ):
                return generation
            try:
                shutil.rmtree(tmp_dir)
            except OSError:
                pass
            raise PersistenceError(
                f"Retry because run {run_id} generation {generation} was not committed."
            ) from exc

    def _prune_generations(
        self, run_id: str, generations: str, generation: int
    ) -> None:
        """Remove superseded generations below the retained window.

        Run only after the pointer names ``generation``, so the current and the
        retained predecessors always remain readable. Leave every entry that is
        not an exactly named committed generation alone, and treat a failed
        removal as recoverable: the next commit prunes what remains.
        """
        oldest_retained = generation - _RETAINED_GENERATIONS + 1
        if oldest_retained <= 1:
            return
        self._fault("before_prune", run_id, generation)
        try:
            names = _bounded_directory_names(
                generations, _MAX_GENERATION_ENTRIES, "the run generation index"
            )
        except (OSError, PersistenceError):
            return
        for name in names:
            match = re.fullmatch(r"gen-(\d{8})", name)
            if match is None or int(match.group(1)) >= oldest_retained:
                continue
            try:
                shutil.rmtree(os.path.join(generations, name))
            except OSError:
                return
        try:
            _fsync_dir(generations)
        except OSError:
            pass

    def pointer(self, run_id: str) -> dict[str, Any] | None:
        """Read the current generation pointer, and reject invalid data."""
        path = os.path.join(self.run_dir(run_id), "state.json")
        try:
            data = _read_bounded(path, _MAX_POINTER_BYTES, "the run commit pointer")
        except FileNotFoundError:
            return None
        except PersistenceError:
            raise
        except OSError as exc:
            raise PersistenceError(
                "Reject the run commit pointer because it cannot be read."
            ) from exc
        try:
            value = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise PersistenceError(
                "Reject the run commit pointer because it is malformed."
            ) from exc
        if not isinstance(value, dict):
            raise PersistenceError(
                "Reject the run commit pointer because it is malformed."
            )
        schema_version = value.get("schemaVersion")
        if type(schema_version) is not int or schema_version != RUN_STATE_VERSION:
            raise PersistenceError(
                "Reject the run commit pointer because its schema is unsupported."
            )
        return value

    def load(self, run_id: str) -> dict[str, Any]:
        """Load and digest-verify the last committed generation."""
        pointer = self.pointer(run_id)
        if pointer is None:
            raise ValueError(f"Select a known run: {run_id}.")
        directory = str(pointer.get("directory", ""))
        if not re.fullmatch(r"gen-\d{8}", directory):
            raise PersistenceError(
                f"Reject run {run_id} because its commit pointer is invalid."
            )
        generation_dir = os.path.join(self.run_dir(run_id), "generations", directory)
        digests = pointer.get("digests", {})
        if not isinstance(digests, dict) or not digests:
            raise PersistenceError(
                f"Reject run {run_id} because it has no generation digests."
            )
        payloads = _verified_generation_payloads(generation_dir, digests, run_id)
        value = _require_current_schema(
            _decode_generation_json(payloads["run.json"], run_id),
            RUN_STATE_VERSION,
            f"Reject run {run_id} because its generation is malformed.",
            f"Reject run {run_id} because its run schema is unsupported.",
        )
        manifest = _require_current_schema(
            _decode_generation_json(payloads["manifest.json"], run_id),
            MANIFEST_VERSION,
            f"Reject run {run_id} because its manifest is malformed.",
            f"Reject run {run_id} because its manifest schema is unsupported.",
        )
        nested_manifest = _require_current_schema(
            value.get("manifest"),
            MANIFEST_VERSION,
            f"Reject run {run_id} because its manifest is malformed.",
            f"Reject run {run_id} because its manifest schema is unsupported.",
        )
        if nested_manifest != manifest:
            raise PersistenceError(
                f"Reject run {run_id} because its manifest is inconsistent."
            )
        value["generation"] = int(pointer.get("generation", 0))
        return value

    def list(self, *, cursor: int = 0, limit: int = 50) -> dict[str, Any]:
        """Return a bounded newest-first page of disk-backed manifests."""
        limit = max(1, min(int(limit), 200))
        cursor = max(0, int(cursor))
        try:
            ids = [
                name
                for name in _bounded_directory_names(
                    self.runs_root, _MAX_RUN_INDEX_ENTRIES, "the run index"
                )
                if _RUN_ID.fullmatch(name)
            ]
        except FileNotFoundError:
            ids = []
        rows: list[tuple[int, dict[str, Any]]] = []
        for run_id in ids:
            try:
                state = self.load(run_id)
            except (ValueError, PersistenceError) as exc:
                rows.append(
                    (
                        0,
                        {
                            "schemaVersion": RUN_STATE_VERSION,
                            "runId": run_id,
                            "startedAt": "1970-01-01T00:00:00+00:00",
                            "endedAt": None,
                            "user": "[REDACTED]",
                            "host": "[REDACTED]",
                            "git": {"repo": "", "sha": "", "dirty": False},
                            "configSha256": "",
                            "steps": [],
                            "tools": {},
                            "recovery": {
                                "state": "interrupted",
                                "detail": (
                                    "Repair the corrupt run store "
                                    f"({type(exc).__name__})."
                                ),
                            },
                        },
                    )
                )
                continue
            manifest = state.get("manifest", {})
            started = int(state.get("startedAtMs", 0) or 0)
            rows.append((started, manifest if isinstance(manifest, dict) else {}))
        rows.sort(
            key=lambda item: (item[0], str(item[1].get("runId", ""))), reverse=True
        )
        items = [row for _, row in rows[cursor : cursor + limit]]
        next_cursor = cursor + len(items)
        return {
            "items": items,
            "nextCursor": next_cursor if next_cursor < len(rows) else None,
            "total": len(rows),
        }

    def run_ids(self) -> list[str]:
        """Return every syntactically valid committed-run directory ID."""
        try:
            return sorted(
                name
                for name in _bounded_directory_names(
                    self.runs_root, _MAX_RUN_INDEX_ENTRIES, "the run index"
                )
                if _RUN_ID.fullmatch(name)
            )
        except FileNotFoundError:
            return []

    def verify_index(self) -> None:
        """Verify the bounded run index before recovering durable state."""
        try:
            _bounded_directory_names(
                self.runs_root, _MAX_RUN_INDEX_ENTRIES, "the run index"
            )
        except FileNotFoundError:
            return

    def receipt_path(self, step_key: str, subject_key: str, signature: str) -> str:
        """Return the bounded project receipt path for one receipt digest."""
        safe_step = re.sub(r"[^a-z0-9_-]", "_", step_key.lower())
        safe_subject = re.sub(r"[^A-Za-z0-9._-]", "_", subject_key)
        if not re.fullmatch(r"[a-f0-9]{64}", signature):
            raise ValueError("Provide a valid receipt digest.")
        return os.path.join(
            self.receipts_root, safe_step, safe_subject, f"{signature}.json"
        )

    def put_receipt(self, receipt: dict[str, Any]) -> str:
        """Atomically publish a wrapper receipt after its run generation commits."""
        if not self._valid_receipt(receipt, str(receipt.get("signature", ""))):
            raise PersistenceError("Provide a valid provenance receipt.")
        path = self.receipt_path(
            str(receipt["stepKey"]),
            str(receipt.get("subjectId") or "cohort"),
            str(receipt["signature"]),
        )
        tmp = f"{path}.tmp-{uuid.uuid4().hex}"
        # Wrap the filesystem work so every failure honors the
        # PersistenceError contract callers rely on.
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            _write_fsynced(tmp, _json_bytes(receipt))
            os.replace(tmp, path)
            _fsync_dir(os.path.dirname(path))
        except OSError as exc:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise PersistenceError(
                "Retry because the provenance receipt was not published."
            ) from exc
        return path

    def receipt_signatures(self, step_key: str, subject_key: str) -> frozenset[str]:
        """Return the digests of the receipts published for one node.

        List names only; :meth:`get_receipt` still validates any receipt a
        caller then reads.
        """
        directory = os.path.dirname(self.receipt_path(step_key, subject_key, "0" * 64))
        try:
            names = os.listdir(directory)
        except OSError:
            return frozenset()
        return frozenset(
            name[: -len(".json")]
            for name in names
            if re.fullmatch(r"[a-f0-9]{64}\.json", name)
        )

    def get_receipt(
        self, step_key: str, subject_key: str, signature: str
    ) -> dict[str, Any] | None:
        """Read and validate one published provenance receipt."""
        path = self.receipt_path(step_key, subject_key, signature)
        try:
            value = json.loads(
                _read_bounded(path, _MAX_RECEIPT_BYTES, "the provenance receipt")
            )
        except (OSError, json.JSONDecodeError, ValueError):
            return None
        if not isinstance(value, dict) or not self._valid_receipt(value, signature):
            return None
        if value.get("stepKey") != step_key:
            return None
        if str(value.get("subjectId") or "cohort") != subject_key:
            return None
        return value

    @staticmethod
    def _valid_receipt(value: dict[str, Any], expected_signature: str) -> bool:
        if value.get("signature") != expected_signature:
            return False
        payload_keys = receipt_payload_keys(value.get("receiptVersion"))
        if (
            payload_keys is None
            or not receipt_scope_contract_valid(value)
            or not receipt_record_contract_valid(value)
        ):
            return False
        payload = {key: value.get(key) for key in payload_keys}
        encoded = json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ).encode("utf-8")
        if hashlib.sha256(encoded).hexdigest() != expected_signature:
            return False
        if value.get("stepKey") == "recon":
            return reconstruction_receipt_contract_valid(value, expected_signature)
        return (
            value.get("reconstruction") is None
            and value.get("reconstructionSignature") is None
        )

    def cleanup_orphans(self, run_id: str) -> int:
        """Remove only uncommitted temporary siblings for one run."""
        generations = os.path.join(self.run_dir(run_id), "generations")
        removed = 0
        try:
            entries = _bounded_directory_names(
                generations, _MAX_GENERATION_ENTRIES, "the run generation index"
            )
        except FileNotFoundError:
            return 0
        for name in entries:
            if not name.startswith(".gen-") or ".tmp-" not in name:
                continue
            try:
                shutil.rmtree(os.path.join(generations, name))
                removed += 1
            except OSError:
                pass
        return removed
