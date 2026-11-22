"""Keep the renderer's registry reason restatement in step with the store.

``RegistryStore.list`` records one sentence per cause that keeps a subject from
running, each an order. The records enter the plan's registry digest, so the
sidecar keeps the text and the Registry screen restates each exact sentence for
display (``REGISTRY_UNAVAILABLE_FACTS`` in
``src/renderer/screens/RegistryScreen.tsx``). If the store's wording changes,
the renderer would show the new text raw.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from supraspina_sidecar import cohort
from supraspina_sidecar.registry_store import RegistryStore
from tests.test_registry_store import _qc_document, _record, _write_t1

_REPO_ROOT = Path(__file__).resolve().parents[2]
_MISSING = "Resolve the T1 input state: missing."


def _renderer_registry_facts() -> dict[str, str]:
    """Return each restated sentence and its fact, or the name of its constant."""
    source = (
        _REPO_ROOT / "src" / "renderer" / "screens" / "RegistryScreen.tsx"
    ).read_text(encoding="utf-8")
    block = re.search(
        r"const REGISTRY_UNAVAILABLE_FACTS[^=]*= new Map\(\[(.*?)\n\]\)",
        source,
        re.DOTALL,
    )
    assert block, "Define REGISTRY_UNAVAILABLE_FACTS in RegistryScreen.tsx."
    pairs = re.findall(r"\[\s*'([^']+)',\s*('[^']+'|[A-Z_]+),?\s*\]", block.group(1))
    return {sentence: fact.strip("'") for sentence, fact in pairs}


def test_registry_reasons_match_the_renderer_restatement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = RegistryStore(str(tmp_path))
    subjects = (
        "sub-absent",
        "sub-nomatch",
        "sub-unreadable",
        "sub-ambiguous",
        "sub-excluded",
        "sub-outside",
        "sub-qcfail",
    )
    for subject_id in subjects:
        store.upsert(_record(subject_id))
    (tmp_path / "rawdata" / "sub-nomatch" / "anat").mkdir(parents=True)
    (
        tmp_path / "rawdata" / "sub-nomatch" / "anat" / "sub-nomatch_T2w.nii.gz"
    ).write_bytes(b"t2")
    for subject_id in ("sub-unreadable", "sub-excluded", "sub-outside", "sub-qcfail"):
        _write_t1(tmp_path, subject_id)
    _write_t1(tmp_path, "sub-ambiguous")
    (
        tmp_path / "rawdata" / "sub-ambiguous" / "sub-ambiguous_run-2_T1w.nii.gz"
    ).write_bytes(b"t1")
    qc = tmp_path / ".supraspina" / "qc_verdicts.json"
    qc.write_text(json.dumps(_qc_document({"sub-qcfail": "fail"})), encoding="utf-8")

    # A T1 that matches the pattern but cannot be read, as a file with mode 000
    # does for the sidecar's user.
    unreadable = str(
        tmp_path / "rawdata" / "sub-unreadable" / "anat" / "sub-unreadable_T1w.nii.gz"
    )
    fingerprint = cohort._fingerprint

    def unreadable_fingerprint(path: str) -> str:
        if path == unreadable:
            raise PermissionError(13, "Permission denied", path)
        return fingerprint(path)

    monkeypatch.setattr(cohort, "_fingerprint", unreadable_fingerprint)

    cfg = {
        "paths": {
            "projectRoot": str(tmp_path),
            "rawdataDir": str(tmp_path / "rawdata"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "subjects": {
            "include": [s for s in subjects if s != "sub-outside"],
            "exclude": ["sub-excluded"],
        },
    }
    rows = {item["subjectId"]: item for item in store.list(cfg)}
    assert all(item["runnable"] is False for item in rows.values())

    # "missing" covers no subject folder, no match, and a match that cannot be
    # read; all three record the same sentence.
    resolution = cohort.resolve_t1(cfg, "sub-unreadable")
    assert resolution.state == "missing"
    assert resolution.candidates == (unreadable,)
    for subject_id in ("sub-absent", "sub-nomatch", "sub-unreadable"):
        assert rows[subject_id]["t1Availability"] == "missing"
        assert rows[subject_id]["unavailableReason"] == _MISSING
    assert rows["sub-ambiguous"]["t1Availability"] == "ambiguous"

    written = set()
    for item in rows.values():
        written.update(re.split(r"(?<=\.) ", item["unavailableReason"]))

    facts = _renderer_registry_facts()
    assert set(facts) == written
    # A match that cannot be read still matches, so the fact cannot say that
    # no input matches.
    assert "readable" in facts[_MISSING]
