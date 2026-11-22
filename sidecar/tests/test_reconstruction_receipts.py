"""Tests for backend-aware reconstruction receipt contracts."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import provenance
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.adapters.fastsurfer import (
    FASTSURFER_BACKEND,
    reconstruction_backend_from_receipt,
    reconstruction_freesurfer_major_from_receipt,
)
from supraspina_sidecar.cohort import CohortSnapshot, T1Resolution
from supraspina_sidecar.provenance import (
    RECEIPT_PAYLOAD_KEYS,
    bound_action,
    edge_evidence,
    execution_action_digest,
    expected_signature,
    make_receipt,
    receipt_signature_valid,
    runtime_run_directory,
    stable_digest,
)
from supraspina_sidecar.run_store import RECEIPT_VERSION, RunStore
from supraspina_sidecar.scientific_resources import FASTSURFER_VARIANTS


def _cohort() -> CohortSnapshot:
    return CohortSnapshot(
        analysis_subject_ids=("sub-001",),
        selected_subject_ids=("sub-001",),
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(
            T1Resolution(
                subject_id="sub-001",
                state="resolved",
                path="/raw/sub-001/anat/sub-001_T1w.nii.gz",
                candidates=(),
                fingerprint="source-sha256",
            ),
        ),
        qc_verdicts=(("sub-001", "pass"),),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def _cfg(
    root: Path,
    *,
    backend: str | None = None,
    device: str = "cpu",
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "directives": "-all",
        "parallel": True,
        "fastsurferDevice": device,
    }
    if backend is not None:
        params["backend"] = backend
    return {
        "paths": {
            "rawdataDir": "/raw",
            "derivativesDir": str(root / "derivatives"),
        },
        "steps": {
            "recon": {
                "enabled": True,
                "params": params,
            },
            "features": {
                "enabled": True,
                "params": {"parcellation": "aparc.a2009s"},
            },
            "enigma": {"enabled": True, "params": {"fsVersion": "8"}},
        },
        "_supraspinaRuntime": {},
    }


@pytest.mark.parametrize(
    ("backend", "provider", "expected"),
    [
        ("freesurfer", {"version": "freesurfer-linux-8.2.0"}, "8"),
        ("freesurfer", {"version": "unknown"}, None),
        ("fastsurfer", {"version": "2.5.4"}, "7"),
    ],
)
def test_reconstruction_receipt_reports_enigma_compatibility_major(
    backend: str, provider: dict[str, str], expected: str | None
) -> None:
    receipt = {
        "stepKey": "recon",
        "receiptVersion": RECEIPT_VERSION,
        "reconstruction": {
            "receiptVersion": 2,
            "backend": backend,
            "provider": provider,
        },
    }

    assert reconstruction_freesurfer_major_from_receipt(receipt) == expected


def _receipt(
    root: Path,
    *,
    backend: str | None = None,
    device: str = "cpu",
) -> tuple[str, dict[str, Any]]:
    cfg = _cfg(root, backend=backend, device=device)
    return expected_signature(
        "recon",
        "sub-001",
        cfg,
        _cohort(),
        ADAPTERS["recon"],
        upstream_signatures=[],
        tool_evidence={
            "reconall": {
                "status": "found",
                "detail": (
                    "/opt/freesurfer/bin/recon-all (release freesurfer-linux-8.2.0)"
                ),
            }
        },
    )


def test_freesurfer_v2_envelope_binds_current_payload_signature(
    tmp_path: Path,
) -> None:
    signature, payload = _receipt(tmp_path)
    signed_payload = {key: payload.get(key) for key in RECEIPT_PAYLOAD_KEYS}

    assert signature == stable_digest(signed_payload)
    assert payload["receiptVersion"] == RECEIPT_VERSION
    assert payload["outputSchemaIdentity"] == "freesurfer:recon-tree:v1"
    assert payload["reconstruction"]["receiptVersion"] == 2
    assert payload["reconstruction"]["backend"] == "freesurfer"
    assert payload["reconstruction"]["provider"]["name"] == "FreeSurfer"
    assert payload["reconstruction"]["provider"]["version"] == (
        "freesurfer-linux-8.2.0"
    )
    assert payload["reconstruction"]["payloadSignature"] == signature
    assert payload["reconstructionSignature"] == stable_digest(
        payload["reconstruction"]
    )
    receipt = make_receipt(
        signature,
        payload,
        {"state": "done", "artifacts": []},
        run_id="run-aaaaaaaa",
        job_id="job-recon",
        committed_at_ms=1,
    )
    assert receipt_signature_valid(receipt, signature)


def test_freesurfer_provider_evidence_does_not_change_payload_signature(
    tmp_path: Path,
) -> None:
    cfg = _cfg(tmp_path)
    kwargs = {
        "step_key": "recon",
        "subject_id": "sub-001",
        "cfg": cfg,
        "cohort": _cohort(),
        "adapter": ADAPTERS["recon"],
        "upstream_signatures": [],
        "tool_evidence": {
            "reconall": {
                "status": "found",
                "identitySha256": "a" * 64,
            }
        },
    }

    unknown_signature, unknown = expected_signature(**kwargs)
    identified_signature, identified = expected_signature(
        **kwargs,
        provider_evidence={
            "freesurfer": {
                "version": "freesurfer-linux-ubuntu24_x86_64-8.2.0-20260314-d932c45"
            }
        },
    )

    assert identified_signature == unknown_signature
    assert unknown["reconstruction"]["provider"]["version"] == "unknown"
    assert identified["reconstruction"]["provider"]["version"] == (
        "freesurfer-linux-ubuntu24_x86_64-8.2.0-20260314-d932c45"
    )
    assert identified["reconstructionSignature"] != unknown["reconstructionSignature"]
    receipt = make_receipt(
        identified_signature,
        identified,
        {"state": "done", "artifacts": []},
        run_id="run-aaaaaaaa",
        job_id="job-recon",
        committed_at_ms=1,
    )
    assert receipt_signature_valid(receipt, identified_signature)


def test_saved_backend_declaration_is_digest_bound(
    tmp_path: Path,
) -> None:
    absent_signature, absent = _receipt(tmp_path, backend=None)
    explicit_signature, explicit = _receipt(tmp_path, backend="freesurfer")

    assert explicit_signature != absent_signature
    assert absent["reconstruction"]["backend"] == "freesurfer"
    assert explicit["reconstruction"]["backend"] == "freesurfer"


def _expected_kwargs() -> dict[str, Any]:
    return {
        "step_key": "recon",
        "subject_id": "sub-001",
        "cohort": _cohort(),
        "adapter": ADAPTERS["recon"],
        "upstream_signatures": [],
        "tool_evidence": {},
    }


def test_run_policy_toggles_and_include_list_leave_the_receipt_identity(
    tmp_path: Path,
) -> None:
    first = _cfg(tmp_path, backend="freesurfer")
    second = _cfg(tmp_path, backend="freesurfer")
    first["runtime"] = {"threads": 4, "dryRun": False, "rerunIncomplete": False}
    second["runtime"] = {"threads": 4, "dryRun": True, "rerunIncomplete": True}
    first["subjects"] = {"include": [], "exclude": []}
    second["subjects"] = {"include": ["sub-001"], "exclude": []}

    first_signature, _ = expected_signature(cfg=first, **_expected_kwargs())
    second_signature, _ = expected_signature(cfg=second, **_expected_kwargs())

    assert first_signature == second_signature


def test_an_unrelated_step_option_leaves_the_receipt_identity(
    tmp_path: Path,
) -> None:
    first = _cfg(tmp_path, backend="freesurfer")
    second = _cfg(tmp_path, backend="freesurfer")
    second["steps"]["enigma"]["params"]["fsVersion"] = "7"

    first_signature, _ = expected_signature(cfg=first, **_expected_kwargs())
    second_signature, _ = expected_signature(cfg=second, **_expected_kwargs())

    assert first_signature == second_signature


def test_a_continued_subject_keeps_the_receipt_identity_of_its_import(
    tmp_path: Path,
) -> None:
    cfg = _cfg(tmp_path, backend="freesurfer")
    before_signature, before = expected_signature(cfg=cfg, **_expected_kwargs())
    imported = tmp_path / "derivatives" / "freesurfer" / "sub-001" / "mri" / "orig"
    imported.mkdir(parents=True)
    (imported / "001.mgz").write_bytes(b"imported")

    after_signature, after = expected_signature(cfg=cfg, **_expected_kwargs())

    assert "-i" not in ADAPTERS["recon"].build_command(cfg, "sub-001")
    assert before["executionActionDigest"] == after["executionActionDigest"]
    assert before_signature == after_signature


def test_the_launcher_compares_the_same_action_form_the_plan_bound(
    tmp_path: Path,
) -> None:
    # A run that continues an imported subject launched recon-all without -i,
    # while the plan had bound the import form; comparing the launched argv
    # refused every such continuation ("the bound action changed before
    # launch"). Both sides must digest the receipt form.
    cfg = _cfg(tmp_path, backend="freesurfer")
    adapter = ADAPTERS["recon"]
    imported = tmp_path / "derivatives" / "freesurfer" / "sub-001" / "mri" / "orig"
    imported.mkdir(parents=True)
    (imported / "001.mgz").write_bytes(b"imported")

    _signature, payload = expected_signature(cfg=cfg, **_expected_kwargs())
    run_dir = runtime_run_directory(cfg)
    launched = adapter.execution_action(cfg, "sub-001")

    assert "-i" not in launched.argv
    assert (
        execution_action_digest(launched, run_dir) != payload["executionActionDigest"]
    )
    assert (
        execution_action_digest(bound_action(adapter, cfg, "sub-001"), run_dir)
        == payload["executionActionDigest"]
    )


def test_resource_identity_reuses_an_unchanged_tree_and_sees_a_change(
    tmp_path: Path,
) -> None:
    # The Results inventory asks for the same resource trees once per receipt.
    # Without a cache, a large cohort re-hashes hundreds of megabytes once per
    # receipt, which makes Results and QC review unusable during a run.
    tree = tmp_path / "resources"
    (tree / "nested").mkdir(parents=True)
    (tree / "a.bin").write_bytes(b"a" * 4096)
    (tree / "nested" / "b.bin").write_bytes(b"b" * 4096)

    reads = {"count": 0}
    original = provenance.sha256_bounded_regular

    def counted(path: Any, maximum: int, **kwargs: Any) -> tuple[str, int]:
        reads["count"] += 1
        return original(path, maximum, **kwargs)

    provenance.sha256_bounded_regular = counted  # type: ignore[assignment]
    try:
        first = provenance._resource_identity(tree)
        after_first = reads["count"]
        second = provenance._resource_identity(tree)
        assert second == first
        assert reads["count"] == after_first, "Reuse the unchanged tree aggregate."

        (tree / "a.bin").write_bytes(b"c" * 4096)
        changed = provenance._resource_identity(tree)
        assert changed["sha256"] != first["sha256"]
    finally:
        provenance.sha256_bounded_regular = original  # type: ignore[assignment]


def test_runtime_threads_change_the_bound_execution_action(tmp_path: Path) -> None:
    first = _cfg(tmp_path, backend="freesurfer")
    second = _cfg(tmp_path, backend="freesurfer")
    first["runtime"] = {"threads": 2}
    second["runtime"] = {"threads": 8}
    kwargs = {
        "step_key": "recon",
        "subject_id": "sub-001",
        "cohort": _cohort(),
        "adapter": ADAPTERS["recon"],
        "upstream_signatures": [],
        "tool_evidence": {},
    }

    first_signature, first_payload = expected_signature(cfg=first, **kwargs)
    second_signature, second_payload = expected_signature(cfg=second, **kwargs)

    assert first_signature != second_signature
    assert first_payload["configurationDigest"] != second_payload["configurationDigest"]
    assert (
        first_payload["executionActionDigest"]
        != second_payload["executionActionDigest"]
    )


def test_fastsurfer_v2_envelope_selects_provider_device_and_output_schema(
    tmp_path: Path,
) -> None:
    signature, payload = _receipt(
        tmp_path,
        backend=FASTSURFER_BACKEND,
        device="cuda",
    )
    reconstruction = payload["reconstruction"]

    assert payload["outputSchemaIdentity"] == "fastsurfer:recon-tree:v2"
    assert reconstruction["backend"] == FASTSURFER_BACKEND
    assert reconstruction["device"] == "cuda"
    assert reconstruction["outputSubdir"] == "fastsurfer"
    assert reconstruction["provider"] == {
        "name": "FastSurfer",
        "version": "2.5.4",
        "variant": "cuda",
        "ociManifestDigest": FASTSURFER_VARIANTS["cuda"].oci_manifest_digest,
    }
    assert (
        reconstruction_backend_from_receipt({**payload, "signature": signature})
        == FASTSURFER_BACKEND
    )


def test_reconstruction_envelope_tamper_is_rejected(tmp_path: Path) -> None:
    signature, payload = _receipt(
        tmp_path,
        backend=FASTSURFER_BACKEND,
    )
    receipt = {**payload, "signature": signature}
    receipt["reconstruction"] = {
        **receipt["reconstruction"],
        "backend": "freesurfer",
    }

    assert not receipt_signature_valid(receipt, signature)


def test_run_store_round_trips_a_signed_freesurfer_receipt(
    tmp_path: Path,
) -> None:
    signature, payload = _receipt(tmp_path)
    receipt = make_receipt(
        signature,
        payload,
        {"state": "done", "artifacts": []},
        run_id="run-aaaaaaaa",
        job_id="job-recon",
        committed_at_ms=1,
    )
    store = RunStore(str(tmp_path))

    path = store.put_receipt(receipt)

    assert store.get_receipt("recon", "sub-001", signature) == receipt
    assert Path(path).is_file()

    unsigned = {key: payload.get(key) for key in RECEIPT_PAYLOAD_KEYS}
    unsigned["signature"] = signature
    unsigned["reconstruction"] = None
    unsigned["reconstructionSignature"] = None

    assert not RunStore._valid_receipt(unsigned, signature)


def test_run_store_rejects_fastsurfer_schema_without_v2_envelope(
    tmp_path: Path,
) -> None:
    signature, payload = _receipt(
        tmp_path,
        backend=FASTSURFER_BACKEND,
    )
    malformed = {key: payload.get(key) for key in RECEIPT_PAYLOAD_KEYS}
    malformed["signature"] = signature

    assert not RunStore._valid_receipt(malformed, signature)


def test_edge_evidence_uses_selected_backend_root(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path, backend=FASTSURFER_BACKEND)
    stats = tmp_path / "derivatives/fastsurfer/sub-001/stats"
    stats.mkdir(parents=True)
    for name in ("lh.aparc.a2009s.stats", "rh.aparc.a2009s.stats", "aseg.stats"):
        (stats / name).write_bytes(b"artifact\n")

    evidence = edge_evidence(
        "recon",
        "features",
        cfg,
        "sub-001",
        ADAPTERS["recon"],
    )

    assert evidence["state"] == "done"
    assert evidence["detail"] == (
        "Confirm that 3/3 recon->features inputs are present."
    )
    assert all("/fastsurfer/" in path for path in evidence["required"])
    assert all("/freesurfer/" not in path for path in evidence["required"])


def test_enigma_edge_accepts_either_normalized_volume_name(
    tmp_path: Path,
) -> None:
    cfg = _cfg(tmp_path, backend=FASTSURFER_BACKEND)
    subject = tmp_path / "derivatives/fastsurfer/sub-001"
    for relative in (
        "stats/aseg.stats",
        "stats/lh.aparc.stats",
        "stats/rh.aparc.stats",
        "mri/aparc+aseg.mgz",
        "mri/orig_nu.mgz",
    ):
        path = subject / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"artifact\n")

    evidence = edge_evidence(
        "recon",
        "enigma",
        cfg,
        "sub-001",
        ADAPTERS["recon"],
    )

    assert evidence["state"] == "done"
    assert evidence["detail"] == "Confirm that 5/5 recon->enigma inputs are present."
    assert evidence["required"][-1].endswith("orig_nu.mgz")
