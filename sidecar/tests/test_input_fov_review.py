"""Tests for the revision-bound brain-FOV review store and provenance inventory."""

from __future__ import annotations

import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import input_fov_review
from supraspina_sidecar.input_fov_review import (
    InputFovReviewError,
    InputFovReviewManager,
)
from supraspina_sidecar.project import ProjectEpochs


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _qc_artifact_id(
    subject_id: str,
    session_id: str | None,
    acquisition_id: str | None,
    signature: str,
) -> str:
    identity = {
        "schemaVersion": 2,
        "role": "qc",
        "subjectId": subject_id,
        "sessionId": session_id,
        "acquisitionId": acquisition_id,
        "preflightSignature": signature,
    }
    payload = json.dumps(
        identity,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode()
    return f"input-fov-qc:{_sha256(payload)}"


def _project(root: Path) -> dict[str, Any]:
    return {
        "projectId": "input-fov-project",
        "root": str(root.resolve()),
        "configPath": str((root / "supraspina.project.json").resolve()),
        "epoch": 1,
    }


def _cfg(root: Path) -> dict[str, Any]:
    return {
        "paths": {
            "projectRoot": str(root.resolve()),
            "derivativesDir": "${projectRoot}/derivatives",
        }
    }


def _request(root: Path, revision: int = 4) -> dict[str, Any]:
    return {
        "project": _project(root),
        "cfg": _cfg(root),
        "configRevision": revision,
    }


def _publication(  # noqa: PLR0913
    root: Path,
    *,
    subject_id: str = "sub-0001",
    session_id: str | None = "ses-01",
    acquisition_id: str | None = None,
    pass_through: bool = False,
    signature: str | None = None,
) -> dict[str, str]:
    entities = [
        subject_id,
        *([session_id] if session_id else []),
        *([acquisition_id] if acquisition_id else []),
    ]
    raw_stem = "_".join(entities)
    source = (
        root
        / "rawdata"
        / subject_id
        / (session_id or "")
        / "anat"
        / f"{raw_stem}_T1w.nii.gz"
    )
    source.parent.mkdir(parents=True, exist_ok=True)
    source_bytes = b"source-t1"
    source.write_bytes(source_bytes)
    signature = (
        signature or hashlib.sha256(f"{subject_id}-signature".encode()).hexdigest()
    )
    descriptor = f"brainfov{signature[:16]}"
    derivative = root / "derivatives" / "supraspina-brainfov" / subject_id
    if session_id:
        derivative /= session_id
    derivative /= "anat"
    derivative.mkdir(parents=True, exist_ok=True)
    stem = f"{raw_stem}_desc-{descriptor}"
    qc = derivative / f"{stem}_qc.png"
    qc_bytes = b"\x89PNG\r\n\x1a\nqc"
    qc.write_bytes(qc_bytes)
    output_bytes = source_bytes if pass_through else b"cropped-t1"
    artifacts: dict[str, dict[str, Any]] = {
        "qc": {
            "path": str(qc),
            "sha256": _sha256(qc_bytes),
            "size": len(qc_bytes),
        }
    }
    if not pass_through:
        output = derivative / f"{stem}_T1w.nii.gz"
        output.write_bytes(output_bytes)
        artifacts["t1"] = {
            "path": str(output),
            "sha256": _sha256(output_bytes),
            "size": len(output_bytes),
        }
    provenance = derivative / f"{stem}_T1w.json"
    provenance.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "signature": signature,
                "preflightSignature": {
                    "source": {
                        "sha256": _sha256(source_bytes),
                        "size": len(source_bytes),
                    }
                },
                "source": {"path": str(source)},
                "crop": {"passThrough": pass_through},
                "artifacts": artifacts,
            }
        ),
        encoding="utf-8",
    )
    return {
        "subjectId": subject_id,
        "sessionId": session_id or "",
        "acquisitionId": acquisition_id or "",
        "signature": signature,
        "sourceSha256": _sha256(source_bytes),
        "outputSha256": _sha256(output_bytes),
        "qcPath": str(qc),
        "sourcePath": str(source),
        "qcArtifactId": _qc_artifact_id(
            subject_id,
            session_id,
            acquisition_id,
            signature,
        ),
    }


def test_list_projects_bounded_provenance_and_opaque_montage_identity(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    identity = _publication(root)
    manager = InputFovReviewManager(ProjectEpochs())

    result = manager.list(_request(root))

    assert result["configRevision"] == 4
    assert result["items"] == [
        {
            "subjectId": "sub-0001",
            "sessionId": "ses-01",
            "acquisitionId": None,
            "preflightSignature": identity["signature"],
            "sourceSha256": identity["sourceSha256"],
            "outputSha256": identity["outputSha256"],
            "passThrough": False,
            "requiresReview": True,
            "qcArtifactId": identity["qcArtifactId"],
            "qcDisplayPath": (
                "supraspina-brainfov/sub-0001/ses-01/anat/"
                f"sub-0001_ses-01_desc-brainfov{identity['signature'][:16]}_qc.png"
            ),
            "qcPath": identity["qcPath"],
            "review": None,
        }
    ]


def test_publication_scan_counts_empty_directories_toward_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dataset_root = tmp_path / "supraspina-brainfov"
    dataset_root.mkdir()
    for index in range(3):
        (dataset_root / f"empty-{index}").mkdir()
    monkeypatch.setattr(input_fov_review, "_MAX_DIRECTORY_ENTRIES", 2)

    with pytest.raises(
        InputFovReviewError, match="Reduce the brain-FOV derivative tree size"
    ):
        input_fov_review._publication_paths(dataset_root)


def test_review_is_revision_bound_atomic_and_current_only_for_exact_hashes(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    identity = _publication(root)
    manager = InputFovReviewManager(ProjectEpochs())
    request = _request(root)
    request.update(
        {
            "subjectId": identity["subjectId"],
            "sessionId": identity["sessionId"] or None,
            "acquisitionId": identity["acquisitionId"] or None,
            "preflightSignature": identity["signature"],
            "sourceSha256": identity["sourceSha256"],
            "outputSha256": identity["outputSha256"],
            "expectedRevision": 0,
            "decision": "approved",
        }
    )

    decision = manager.review(request)
    listed = manager.list(_request(root))["items"][0]["review"]

    assert decision["revision"] == 1
    assert decision["configRevision"] == 4
    assert decision["decision"] == "approved"
    assert len(decision["decisionSignature"]) == 64
    assert decision["current"] is True
    assert listed == decision
    stored = json.loads(
        (root / ".supraspina" / "input-fov-qc.json").read_text(encoding="utf-8")
    )
    assert stored["schemaVersion"] == 2
    assert len(stored["decisions"]) == 1
    assert (
        next(iter(stored["decisions"].values()))["preflightSignature"]
        == identity["signature"]
    )
    assert not list((root / ".supraspina").glob(".input-fov-qc.tmp-*"))

    with pytest.raises(InputFovReviewError, match="revision conflict"):
        manager.review(request)


def test_concurrent_reviews_cannot_commit_the_same_expected_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    identity = _publication(root)
    manager = InputFovReviewManager(ProjectEpochs())
    manager.list(_request(root))
    request = _request(root)
    request.update(
        {
            "subjectId": identity["subjectId"],
            "sessionId": identity["sessionId"] or None,
            "acquisitionId": identity["acquisitionId"] or None,
            "preflightSignature": identity["signature"],
            "sourceSha256": identity["sourceSha256"],
            "outputSha256": identity["outputSha256"],
            "expectedRevision": 0,
            "decision": "approved",
        }
    )
    original_write = input_fov_review._write_store
    first_write_started = threading.Event()
    second_write_started = threading.Event()
    write_count = 0
    write_count_lock = threading.Lock()

    def staged_write(*args: Any, **kwargs: Any) -> None:
        nonlocal write_count
        with write_count_lock:
            write_count += 1
            ordinal = write_count
        if ordinal == 1:
            first_write_started.set()
            second_write_started.wait(timeout=0.25)
        else:
            second_write_started.set()
        original_write(*args, **kwargs)

    monkeypatch.setattr(input_fov_review, "_write_store", staged_write)

    def commit() -> dict[str, Any] | str:
        try:
            return manager.review(dict(request))
        except InputFovReviewError as exc:
            return str(exc)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(commit)
        assert first_write_started.wait(timeout=2)
        second = executor.submit(commit)
        outcomes = [first.result(timeout=2), second.result(timeout=2)]

    assert len([outcome for outcome in outcomes if isinstance(outcome, dict)]) == 1
    assert outcomes.count("Resolve the input-FOV review revision conflict.") == 1
    assert write_count == 1


def test_review_currentness_and_signature_depend_only_on_crop_identity(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    identity = _publication(root)
    manager = InputFovReviewManager(ProjectEpochs())
    request = _request(root)
    request.update(
        {
            "subjectId": identity["subjectId"],
            "sessionId": identity["sessionId"] or None,
            "acquisitionId": identity["acquisitionId"] or None,
            "preflightSignature": identity["signature"],
            "sourceSha256": identity["sourceSha256"],
            "outputSha256": identity["outputSha256"],
            "expectedRevision": 0,
            "decision": "approved",
        }
    )

    first = manager.review(request)
    after_unrelated_revision = manager.list(_request(root, revision=5))["items"][0]
    repeated = manager.review(
        {
            **request,
            "configRevision": 5,
            "expectedRevision": 1,
        }
    )

    assert after_unrelated_revision["review"]["current"] is True
    assert repeated["decisionSignature"] == first["decisionSignature"]


def test_montage_artifact_ids_remain_unique_for_identical_input_signatures(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    shared_signature = "d" * 64
    _publication(
        root,
        subject_id="sub-0001",
        session_id=None,
        signature=shared_signature,
    )
    _publication(
        root,
        subject_id="sub-0002",
        session_id=None,
        signature=shared_signature,
    )
    manager = InputFovReviewManager(ProjectEpochs())

    items = manager.list(_request(root))["items"]

    assert len({item["qcArtifactId"] for item in items}) == 2


def test_acquisitions_have_distinct_artifact_ids_and_review_records(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    shared_signature = "e" * 64
    prisma = _publication(
        root,
        acquisition_id="acq-prisma",
        signature=shared_signature,
    )
    ingenia = _publication(
        root,
        acquisition_id="acq-ingenia",
        signature=shared_signature,
    )
    manager = InputFovReviewManager(ProjectEpochs())

    items = manager.list(_request(root))["items"]
    assert {item["acquisitionId"] for item in items} == {
        "acq-prisma",
        "acq-ingenia",
    }
    assert len({item["qcArtifactId"] for item in items}) == 2

    decisions = {}
    for identity, decision in ((prisma, "approved"), (ingenia, "rejected")):
        request = _request(root)
        request.update(
            {
                "subjectId": identity["subjectId"],
                "sessionId": identity["sessionId"] or None,
                "acquisitionId": identity["acquisitionId"],
                "preflightSignature": identity["signature"],
                "sourceSha256": identity["sourceSha256"],
                "outputSha256": identity["outputSha256"],
                "expectedRevision": 0,
                "decision": decision,
            }
        )
        decisions[identity["acquisitionId"]] = manager.review(request)

    assert (
        decisions["acq-prisma"]["decisionSignature"]
        != decisions["acq-ingenia"]["decisionSignature"]
    )
    listed = {
        item["acquisitionId"]: item["review"]
        for item in manager.list(_request(root))["items"]
    }
    assert listed["acq-prisma"]["decision"] == "approved"
    assert listed["acq-ingenia"]["decision"] == "rejected"
    stored = json.loads(
        (root / ".supraspina" / "input-fov-qc.json").read_text(encoding="utf-8")
    )
    assert len(stored["decisions"]) == 2
    assert {record["acquisitionId"] for record in stored["decisions"].values()} == {
        "acq-prisma",
        "acq-ingenia",
    }

    invalid = _request(root)
    invalid.update(
        {
            "subjectId": prisma["subjectId"],
            "sessionId": prisma["sessionId"] or None,
            "acquisitionId": f"acq-{'a' * 125}",
            "preflightSignature": prisma["signature"],
            "sourceSha256": prisma["sourceSha256"],
            "outputSha256": prisma["outputSha256"],
            "expectedRevision": 1,
            "decision": "approved",
        }
    )
    with pytest.raises(InputFovReviewError, match="acquisition ID"):
        manager.review(invalid)


def test_sessions_have_distinct_artifact_ids_and_review_records(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    shared_signature = "a" * 64
    baseline = _publication(
        root,
        session_id="ses-baseline",
        acquisition_id="acq-prisma",
        signature=shared_signature,
    )
    followup = _publication(
        root,
        session_id="ses-followup",
        acquisition_id="acq-prisma",
        signature=shared_signature,
    )
    manager = InputFovReviewManager(ProjectEpochs())

    items = manager.list(_request(root))["items"]
    assert {item["sessionId"] for item in items} == {
        "ses-baseline",
        "ses-followup",
    }
    assert len({item["qcArtifactId"] for item in items}) == 2

    decisions = {}
    for identity, decision in ((baseline, "approved"), (followup, "rejected")):
        request = _request(root)
        request.update(
            {
                "subjectId": identity["subjectId"],
                "sessionId": identity["sessionId"],
                "acquisitionId": identity["acquisitionId"],
                "preflightSignature": identity["signature"],
                "sourceSha256": identity["sourceSha256"],
                "outputSha256": identity["outputSha256"],
                "expectedRevision": 0,
                "decision": decision,
            }
        )
        decisions[identity["sessionId"]] = manager.review(request)

    assert (
        decisions["ses-baseline"]["decisionSignature"]
        != decisions["ses-followup"]["decisionSignature"]
    )
    listed = {
        item["sessionId"]: item["review"]
        for item in manager.list(_request(root))["items"]
    }
    assert listed["ses-baseline"]["decision"] == "approved"
    assert listed["ses-followup"]["decision"] == "rejected"
    stored = json.loads(
        (root / ".supraspina" / "input-fov-qc.json").read_text(encoding="utf-8")
    )
    assert len(stored["decisions"]) == 2
    assert {record["sessionId"] for record in stored["decisions"].values()} == {
        "ses-baseline",
        "ses-followup",
    }

    incomplete = _request(root)
    incomplete.update(
        {
            "subjectId": baseline["subjectId"],
            "acquisitionId": baseline["acquisitionId"],
            "preflightSignature": baseline["signature"],
            "sourceSha256": baseline["sourceSha256"],
            "outputSha256": baseline["outputSha256"],
            "expectedRevision": 1,
            "decision": "approved",
        }
    )
    with pytest.raises(
        InputFovReviewError, match="Provide valid input-FOV request fields"
    ):
        manager.review(incomplete)


def test_list_is_scoped_to_the_configured_cohort(tmp_path: Path) -> None:
    # Exclude an omitted subject's stale publication from the Reconstruction
    # gate and the approved-crop count.
    root = tmp_path / "project"
    root.mkdir()
    _publication(root, subject_id="sub-0001")
    _publication(root, subject_id="sub-0049")
    manager = InputFovReviewManager(ProjectEpochs())

    everything = manager.list(_request(root))
    assert {item["subjectId"] for item in everything["items"]} == {
        "sub-0001",
        "sub-0049",
    }

    request = _request(root)
    request["cfg"] = {
        **_cfg(root),
        "subjects": {"include": ["sub-0001"], "exclude": ["sub-0049"]},
    }

    scoped = manager.list(request)

    assert [item["subjectId"] for item in scoped["items"]] == ["sub-0001"]


def test_store_record_missing_a_field_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    identity = _publication(root, session_id=None, acquisition_id="acq-prisma")
    manager = InputFovReviewManager(ProjectEpochs())
    request = _request(root)
    request.update(
        {
            "subjectId": identity["subjectId"],
            "sessionId": identity["sessionId"] or None,
            "acquisitionId": identity["acquisitionId"],
            "preflightSignature": identity["signature"],
            "sourceSha256": identity["sourceSha256"],
            "outputSha256": identity["outputSha256"],
            "expectedRevision": 0,
            "decision": "approved",
        }
    )
    manager.review(request)
    store_path = root / ".supraspina" / "input-fov-qc.json"
    invalid_store = json.loads(store_path.read_text(encoding="utf-8"))
    next(iter(invalid_store["decisions"].values())).pop("sessionId")
    store_path.write_text(json.dumps(invalid_store), encoding="utf-8")

    with pytest.raises(
        InputFovReviewError,
        match="Provide a valid input-FOV review store record",
    ):
        manager.list(_request(root))


def test_schema_version_one_store_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    identity = _publication(root, acquisition_id="acq-prisma")
    store_path = root / ".supraspina" / "input-fov-qc.json"
    store_path.parent.mkdir()
    store_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "decisions": {
                    "sub-0001": {
                        "decision": "approved",
                        "revision": 3,
                        "configRevision": 4,
                        "reviewedAt": "2026-07-30T12:00:00.000Z",
                        "preflightSignature": identity["signature"],
                        "sourceSha256": identity["sourceSha256"],
                        "outputSha256": identity["outputSha256"],
                        "decisionSignature": "f" * 64,
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    manager = InputFovReviewManager(ProjectEpochs())

    with pytest.raises(
        InputFovReviewError,
        match="Use a supported input-FOV review store schema",
    ):
        manager.list(_request(root))


def test_review_rejects_pass_through_and_changed_source_or_output(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    pass_through = _publication(root, subject_id="sub-pass", pass_through=True)
    manager = InputFovReviewManager(ProjectEpochs())
    request = _request(root)
    request.update(
        {
            "subjectId": pass_through["subjectId"],
            "sessionId": pass_through["sessionId"] or None,
            "acquisitionId": pass_through["acquisitionId"] or None,
            "preflightSignature": pass_through["signature"],
            "sourceSha256": pass_through["sourceSha256"],
            "outputSha256": pass_through["outputSha256"],
            "expectedRevision": 0,
            "decision": "approved",
        }
    )
    with pytest.raises(InputFovReviewError, match="pass-through"):
        manager.review(request)

    cropped = _publication(root, subject_id="sub-crop", session_id=None)
    Path(cropped["sourcePath"]).write_bytes(b"source-changed")
    with pytest.raises(
        InputFovReviewError, match="Restore the recorded brain-FOV source bytes"
    ):
        manager.list(_request(root))


def test_review_rejects_unexpected_fields_and_stale_identity(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    identity = _publication(root)
    manager = InputFovReviewManager(ProjectEpochs())
    request = _request(root)
    request.update(
        {
            "subjectId": identity["subjectId"],
            "sessionId": identity["sessionId"] or None,
            "acquisitionId": identity["acquisitionId"] or None,
            "preflightSignature": identity["signature"],
            "sourceSha256": identity["sourceSha256"],
            "outputSha256": "0" * 64,
            "expectedRevision": 0,
            "decision": "approved",
            "unexpected": True,
        }
    )

    with pytest.raises(InputFovReviewError, match="fields"):
        manager.review(request)


def test_resolve_for_cohort_returns_only_trusted_pass_through_or_approved_crop(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    crop = _publication(root, subject_id="sub-crop", session_id=None)
    passed = _publication(
        root,
        subject_id="sub-pass",
        session_id=None,
        pass_through=True,
    )
    manager = InputFovReviewManager(ProjectEpochs())
    review = _request(root)
    review.update(
        {
            "subjectId": crop["subjectId"],
            "sessionId": crop["sessionId"] or None,
            "acquisitionId": crop["acquisitionId"] or None,
            "preflightSignature": crop["signature"],
            "sourceSha256": crop["sourceSha256"],
            "outputSha256": crop["outputSha256"],
            "expectedRevision": 0,
            "decision": "approved",
        }
    )
    approved = manager.review(review)

    resolved = manager.resolve_for_cohort(
        _request(root),
        {
            "sub-crop": crop["sourcePath"],
            "sub-pass": passed["sourcePath"],
        },
    )

    assert resolved["sub-crop"]["passThrough"] is False
    assert resolved["sub-crop"]["preparedT1Path"].endswith("_T1w.nii.gz")
    assert resolved["sub-crop"]["decisionSignature"] == approved["decisionSignature"]
    assert resolved["sub-pass"] == {
        "rawT1Path": passed["sourcePath"],
        "preparedT1Path": passed["sourcePath"],
        "passThrough": True,
        "preflightSignature": passed["signature"],
        "sourceSha256": passed["sourceSha256"],
        "outputSha256": passed["outputSha256"],
        "decisionSignature": None,
    }


def test_resolve_for_cohort_fails_closed_for_unreviewed_or_wrong_raw_source(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    crop = _publication(root, subject_id="sub-crop", session_id=None)
    manager = InputFovReviewManager(ProjectEpochs())

    with pytest.raises(
        InputFovReviewError, match="Review and approve the Brain FOV crop"
    ):
        manager.resolve_for_cohort(
            _request(root),
            {"sub-crop": crop["sourcePath"]},
        )
    different = root / "rawdata" / "different.nii.gz"
    different.parent.mkdir(parents=True, exist_ok=True)
    different.write_bytes(Path(crop["sourcePath"]).read_bytes())
    with pytest.raises(InputFovReviewError, match="Run Brain FOV for sub-crop"):
        manager.resolve_for_cohort(
            _request(root),
            {"sub-crop": str(different)},
        )


def test_resolve_for_cohort_requires_the_current_preflight_signature(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    passed = _publication(
        root,
        subject_id="sub-pass",
        session_id=None,
        pass_through=True,
    )
    manager = InputFovReviewManager(ProjectEpochs())

    with pytest.raises(
        InputFovReviewError, match="Run Brain FOV for sub-pass, then approve"
    ):
        manager.resolve_for_cohort(
            _request(root),
            {"sub-pass": passed["sourcePath"]},
            expected_preflight_by_subject={"sub-pass": "0" * 64},
        )

    resolved = manager.resolve_for_cohort(
        _request(root),
        {"sub-pass": passed["sourcePath"]},
        expected_preflight_by_subject={"sub-pass": passed["signature"]},
    )
    assert resolved["sub-pass"]["preflightSignature"] == passed["signature"]


def test_resolve_each_for_cohort_hashes_once_and_blocks_per_subject(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    subjects = [f"sub-{index:03d}" for index in range(1, 6)]
    publications = {
        subject: _publication(
            root, subject_id=subject, session_id=None, pass_through=True
        )
        for subject in subjects
    }
    crop = _publication(root, subject_id="sub-crop", session_id=None)
    manager = InputFovReviewManager(ProjectEpochs())
    digests: list[str] = []
    original = input_fov_review._digest_file

    def counting(path: Path, *, expected_size: int | None = None) -> str:
        digests.append(str(path))
        return original(path, expected_size=expected_size)

    monkeypatch.setattr(input_fov_review, "_digest_file", counting)
    mapping = {subject: item["sourcePath"] for subject, item in publications.items()}
    mapping["sub-crop"] = crop["sourcePath"]

    resolved, blockers = manager.resolve_each_for_cohort(_request(root), mapping)

    # One listing pass hashes each publication's files once, however many
    # subjects are resolved; per-subject resolution hashed all of them for
    # every subject.
    assert len(digests) == len(set(digests))
    assert set(resolved) == set(subjects)
    # The unreviewed crop blocks only its own subject.
    assert set(blockers) == {"sub-crop"}
    assert "Review and approve the Brain FOV crop" in blockers["sub-crop"]
