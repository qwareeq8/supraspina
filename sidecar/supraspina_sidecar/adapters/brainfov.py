"""Preparation of immutable brain-FOV derivatives with managed SynthStrip."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import stat
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from .. import resources, scientific_resources
from ..brainfov import (
    BRAINFOV_HELPER_VERSION,
    DEFAULT_MARGIN_MM,
    SYNTHSTRIP_PROVIDER_IDENTITY,
    BrainFovError,
    ImmutablePublicationError,
    NiftiImage,
    build_derivative_paths,
    build_preflight_signature,
    fov_within_limit,
    read_nifti,
    verify_published_derivative_set,
)
from ..paths import flatten, interpolate
from .base import Adapter, Failure, StepStatus, register

_NO_AUTOMATIC_MOUNTS = "hostfs,cwd,home"
_MINIMUM_MARGIN_MM = 15
_MAXIMUM_MARGIN_MM = 60
_MINIMUM_THREADS = 1
_MAXIMUM_THREADS = 32
_DEFAULT_THREADS = 6
_MAXIMUM_HELPER_RESULT_BYTES = 64 * 1024
_MAXIMUM_FAILURE_MESSAGE_CHARACTERS = 512


def _runtime(cfg: dict[str, Any]) -> dict[str, Any]:
    value = cfg.get("_supraspinaRuntime", {})
    return value if isinstance(value, dict) else {}


def _resolved_path(
    value: Any,
    cfg: dict[str, Any],
    label: str,
    *,
    absolute: bool,
) -> str:
    path = interpolate(str(value or ""), flatten(cfg))
    if not path or any(character in path for character in ("\x00", "\n", "\r")):
        raise ValueError(f"Provide {label}.")
    if absolute and not os.path.isabs(path):
        raise ValueError(f"Provide {label} as an absolute path.")
    return path


def _input_path(
    cfg: dict[str, Any],
    subject_id: str | None,
) -> str:
    runtime_map = _runtime(cfg).get("t1BySubject")
    selected = (
        runtime_map.get(subject_id)
        if subject_id is not None and isinstance(runtime_map, dict)
        else None
    )
    if isinstance(selected, str) and selected:
        return _resolved_path(selected, cfg, "brain-FOV T1 input", absolute=True)
    paths = cfg.get("paths", {})
    rawdata = paths.get("rawdataDir") if isinstance(paths, dict) else ""
    root = _resolved_path(rawdata, cfg, "rawdata directory", absolute=True)
    subject = subject_id if subject_id is not None else "${subject}"
    return os.path.join(root, subject, "anat", f"{subject}_T1w.nii.gz")


def _derivatives_root(cfg: dict[str, Any]) -> str:
    paths = cfg.get("paths", {})
    derivatives = paths.get("derivativesDir") if isinstance(paths, dict) else ""
    return _resolved_path(
        derivatives,
        cfg,
        "derivatives directory",
        absolute=True,
    )


def _margin_mm(cfg: dict[str, Any]) -> int:
    steps = cfg.get("steps", {})
    configured = steps.get("brainfov", {}) if isinstance(steps, dict) else {}
    params = configured.get("params", {}) if isinstance(configured, dict) else {}
    value = (
        params.get("marginMm", DEFAULT_MARGIN_MM) if isinstance(params, dict) else 30
    )
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError("Provide the brain-FOV margin as an integer.")
    if not _MINIMUM_MARGIN_MM <= value <= _MAXIMUM_MARGIN_MM:
        raise ValueError("Keep the brain-FOV margin between 15 and 60 mm.")
    return value


def _threads(cfg: dict[str, Any]) -> int:
    runtime = cfg.get("runtime", {})
    value = (
        runtime.get("threads", _DEFAULT_THREADS)
        if isinstance(runtime, dict)
        else _DEFAULT_THREADS
    )
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError("Provide brain-FOV threads as an integer.")
    if not _MINIMUM_THREADS <= value <= _MAXIMUM_THREADS:
        raise ValueError("Keep brain-FOV threads between 1 and 32.")
    return value


def _synthstrip_executable(cfg: dict[str, Any]) -> str:
    value = _runtime(cfg).get("synthStripExecutable") or "mri_synthstrip"
    return _resolved_path(
        value,
        cfg,
        "SynthStrip executable",
        absolute=False,
    )


def _apptainer_executable(cfg: dict[str, Any]) -> str:
    value = _runtime(cfg).get("apptainerExecutable") or "apptainer"
    return _resolved_path(
        value,
        cfg,
        "Apptainer executable",
        absolute=False,
    )


def _sif_path(cfg: dict[str, Any]) -> str:
    runtime = _runtime(cfg)
    configured = runtime.get("synthStripSifPath")
    if configured:
        path = Path(
            _resolved_path(
                configured,
                cfg,
                "verified SynthStrip SIF",
                absolute=True,
            )
        )
        scientific_resources.verify_sif(
            path,
            scientific_resources.SYNTHSTRIP_RELEASE_PIN,
        )
        return str(path)
    user_data = runtime.get("userDataPath")
    if user_data:
        root = Path(
            _resolved_path(
                user_data,
                cfg,
                "Supraspina user-data directory",
                absolute=True,
            )
        )
        active = scientific_resources.active_synthstrip_sif(
            root,
            scientific_resources.SYNTHSTRIP_RELEASE_PIN,
        )
        if active is not None:
            return str(active)
    raise ValueError("Provision the verified SynthStrip 1.8 resource in Diagnostics.")


def _regular_helper_path() -> Path:
    helper = resources.brainfov_helper_path()
    try:
        metadata = os.lstat(helper)
    except OSError as exc:
        raise ValueError("Provide the brain-FOV helper.") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ValueError("Provide the brain-FOV helper as a regular file.")
    return helper.resolve()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    except OSError as exc:
        raise ValueError("Provide a readable brain-FOV helper for hashing.") from exc
    return digest.hexdigest()


def _helper_identity(helper: Path) -> dict[str, str]:
    return {
        "name": "supraspina-brainfov",
        "version": BRAINFOV_HELPER_VERSION,
        "sha256": _file_sha256(helper),
    }


def _provider_identity() -> dict[str, Any]:
    pin = scientific_resources.SYNTHSTRIP_RELEASE_PIN
    spec = scientific_resources.SYNTHSTRIP_SPEC
    identity: dict[str, Any] = {
        "name": "SynthStrip",
        "version": scientific_resources.SYNTHSTRIP_VERSION,
        "platform": spec.platform,
        "ociManifestDigest": spec.oci_manifest_digest,
        "apptainerVersion": scientific_resources.APPTAINER_VERSION,
        "sifSize": pin.size_bytes,
        "sifSha256": pin.sha256,
        "model": dict(SYNTHSTRIP_PROVIDER_IDENTITY["model"]),
    }
    if identity != SYNTHSTRIP_PROVIDER_IDENTITY:
        raise ValueError("Match the SynthStrip provider constants to the helper pin.")
    return identity


def _canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )


def _mount(source: str, destination: str, mode: str) -> str:
    if mode not in {"ro", "rw"}:
        raise ValueError("Select a valid container mount mode.")
    fields = ["type=bind", f"src={source}", f"dst={destination}"]
    # Leave Apptainer bind mounts writable by default. Pass only the accepted
    # read-only ``ro`` flag because the --mount parser rejects an ``rw`` key.
    if mode == "ro":
        fields.append("ro")
    stream = io.StringIO(newline="")
    csv.writer(stream, lineterminator="").writerow(fields)
    return stream.getvalue()


#: Retain detector summaries by input identity and stage parameters.
_MAX_CACHED_SUMMARIES = 256
_SUMMARY_CACHE: OrderedDict[tuple[str, int, int, int, int, str], tuple[str, list[str]]]
_SUMMARY_CACHE = OrderedDict()
_SUMMARY_LOCK = threading.Lock()


def _input_witness(path: Path) -> tuple[int, int, int, int] | None:
    """Return the cheap filesystem identity of one raw input, or ``None``."""
    try:
        info = path.stat()
    except OSError:
        return None
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _signature_summary(
    cfg: dict[str, Any],
    subject_id: str,
) -> tuple[Path, str, list[str]]:
    """Return only what the detector needs: the input, its digest, and its roles.

    Discard the decoded image immediately after detection. Avoid reading and
    decompressing a whole T1 for every inventory, plan, and cohort discovery by
    retaining the digest and role set against the input's filesystem identity
    and exact parameter identity. Miss the cache and decode again when either
    changes. Never retain the image itself.
    """
    source_path = Path(_input_path(cfg, subject_id))
    witness = _input_witness(source_path)
    # Hash canonical JSON locally. Avoid the provenance helper because it
    # imports the adapter registry and would create an import-order cycle.
    parameters = hashlib.sha256(
        json.dumps(
            {
                "margin": _margin_mm(cfg),
                "provider": _provider_identity(),
                "helper": _helper_identity(_regular_helper_path()),
                "synthstrip": _synthstrip_executable(cfg),
                "threads": _threads(cfg),
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("utf-8")
    ).hexdigest()
    key = (str(source_path), *witness, parameters) if witness else None
    if key is not None:
        with _SUMMARY_LOCK:
            hit = _SUMMARY_CACHE.get(key)
            if hit is not None:
                _SUMMARY_CACHE.move_to_end(key)
                return source_path, hit[0], list(hit[1])
    resolved_path, _source, _helper, signature, _payload, roles = _signature_inputs(
        cfg, subject_id
    )
    if key is not None and _input_witness(source_path) == witness:
        with _SUMMARY_LOCK:
            _SUMMARY_CACHE[key] = (signature, list(roles))
            _SUMMARY_CACHE.move_to_end(key)
            while len(_SUMMARY_CACHE) > _MAX_CACHED_SUMMARIES:
                _SUMMARY_CACHE.popitem(last=False)
    return resolved_path, signature, roles


def _signature_inputs(
    cfg: dict[str, Any],
    subject_id: str,
) -> tuple[Path, NiftiImage, Path, str, dict[str, Any], list[str]]:
    source_path = Path(_input_path(cfg, subject_id))
    source = read_nifti(source_path)
    helper = _regular_helper_path()
    pass_through = fov_within_limit(source.fov_mm)
    runtime_identity = (
        {"mode": "passThrough"}
        if pass_through
        else {
            "mode": "crop",
            "synthstripExecutable": _synthstrip_executable(cfg),
            "threads": _threads(cfg),
        }
    )
    signature, payload = build_preflight_signature(
        source_path,
        source,
        margin_mm=_margin_mm(cfg),
        provider=_provider_identity(),
        helper=_helper_identity(helper),
        runtime=runtime_identity,
    )
    roles = ["qc"] if pass_through else ["t1", "mask", "qc"]
    return source_path, source, helper, signature, payload, roles


class BrainFovAdapter(Adapter):
    """Run the first-party helper inside the verified CPU SynthStrip SIF."""

    key = "brainfov"
    name = "Brain FOV preparation"
    goal = "Prepare reconstruction inputs within the 256 mm physical FOV limit."
    advances: tuple[str, ...] = ()

    def preflight_signature(
        self,
        cfg: dict[str, Any],
        subject_id: str,
    ) -> str:
        """Return the exact immutable publication digest for current inputs.

        Reuse the detector's signature cache so a plan over a large cohort
        decodes each unchanged T1 once per process instead of once per plan.
        """
        return _signature_summary(cfg, subject_id)[1]

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the one fixed-policy crop parameter."""
        return {
            "marginMm": {
                "kind": "int",
                "default": DEFAULT_MARGIN_MM,
                "min": _MINIMUM_MARGIN_MM,
                "max": _MAXIMUM_MARGIN_MM,
                "label": "Brain FOV margin (mm)",
            }
        }

    def build_command(
        self,
        cfg: dict[str, Any],
        subject_id: str | None,
    ) -> list[str]:
        """Build the clean, contained Apptainer helper command."""
        source = _input_path(cfg, subject_id)
        derivatives = _derivatives_root(cfg)
        helper = _regular_helper_path()
        sif = _sif_path(cfg)
        argv = [
            *scientific_resources.CLEAN_HOST_ENV_PREFIX,
            _apptainer_executable(cfg),
            "exec",
            "--cleanenv",
            "--containall",
            "--no-home",
            "--no-mount",
            _NO_AUTOMATIC_MOUNTS,
            "--cwd",
            "/",
            "--net",
            "--network",
            "none",
            "--mount",
            _mount(source, source, "ro"),
            "--mount",
            _mount(derivatives, derivatives, "rw"),
            "--mount",
            _mount(str(helper), str(helper), "ro"),
            sif,
            "python3",
            str(helper),
            "prepare",
            "--input",
            source,
            "--derivatives-root",
            derivatives,
            *(["--subject", subject_id] if subject_id is not None else []),
            "--margin-mm",
            str(_margin_mm(cfg)),
            "--provider-json",
            _canonical_json(_provider_identity()),
            "--helper-json",
            _canonical_json(_helper_identity(helper)),
            "--synthstrip-executable",
            _synthstrip_executable(cfg),
            "--threads",
            str(_threads(cfg)),
        ]
        return argv

    def prepare_execution(
        self,
        cfg: dict[str, Any],
        subject_id: str | None,
    ) -> None:
        """Create and verify only the brain-FOV derivative parent."""
        del subject_id
        owned = Path(_derivatives_root(cfg)) / "supraspina-brainfov"
        try:
            owned.mkdir(parents=True, exist_ok=True, mode=0o700)
            metadata = os.lstat(owned)
        except OSError as exc:
            raise ValueError("Choose a creatable brain-FOV derivative parent.") from exc
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise ValueError("Provide the brain-FOV derivative parent as a directory.")
        if not os.access(owned, os.W_OK | os.X_OK):
            raise ValueError("Choose a writable brain-FOV derivative parent.")

    def detect(
        self,
        cfg: dict[str, Any],
        subject_id: str | None,
    ) -> StepStatus:
        """Verify the digest-selected immutable preparation artifact set."""
        if subject_id is None:
            return StepStatus("pending", "Provide a subject.")
        try:
            source_path, signature, roles = _signature_summary(cfg, subject_id)
            paths = build_derivative_paths(
                Path(_derivatives_root(cfg)),
                source_path,
                signature,
                subject_id,
            )
            publication = verify_published_derivative_set(paths, roles)
        except FileNotFoundError:
            return StepStatus("pending", "Provide the raw T1.")
        except ImmutablePublicationError:
            return StepStatus(
                "partial",
                "Inspect the failed brain-FOV derivative integrity verification.",
            )
        except (BrainFovError, OSError, ValueError) as exc:
            # Name a source or naming problem so the planner's integrity block
            # says what to fix instead of a generic currentness note.
            detail = str(exc) if isinstance(exc, BrainFovError) and str(exc) else ""
            return StepStatus("unknown", detail or "Verify brain-FOV currentness.")
        if publication is None:
            return StepStatus("pending", "Create the brain-FOV preparation.")
        artifacts = [str(paths.by_role()[role]) for role in sorted(roles)]
        artifacts.append(str(paths.provenance))
        return StepStatus(
            "done",
            "The brain-FOV preparation is current.",
            artifacts,
        )

    def parse_failure(
        self,
        rc: int,
        stdout: str,
        stderr: str,
    ) -> Failure | None:
        """Map bounded helper JSON into a redacted structured failure."""
        del stderr
        if rc == 0:
            return None
        message = "Inspect the failed brain-FOV preparation."
        if (
            len(stdout.encode("utf-8", errors="replace"))
            <= _MAXIMUM_HELPER_RESULT_BYTES
        ):
            try:
                document = json.loads(stdout)
            except (TypeError, json.JSONDecodeError):
                document = None
            if isinstance(document, dict):
                error = document.get("error")
                candidate = error.get("message") if isinstance(error, dict) else None
                if isinstance(candidate, str) and candidate.strip():
                    message = " ".join(candidate.split())[
                        :_MAXIMUM_FAILURE_MESSAGE_CHARACTERS
                    ]
        lowered = message.lower()
        if "synthstrip" in lowered:
            tag = "synthstrip_failed"
        elif "retain" in lowered or "minimum margin" in lowered:
            tag = "brain_fov_too_large"
        elif "nifti" in lowered or "mask" in lowered or "affine" in lowered:
            tag = "invalid_input"
        elif "publish" in lowered or "immutable" in lowered:
            tag = "publication_failed"
        else:
            tag = "brainfov_failed"
        return Failure(rc, tag, message)


register(BrainFovAdapter())
