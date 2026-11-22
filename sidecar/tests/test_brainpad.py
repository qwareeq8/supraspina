"""Tests for the Brain-PAD statistics adapter (Step 7)."""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any

from supraspina_sidecar import resources
from supraspina_sidecar.adapters.base import ADAPTERS
from supraspina_sidecar.adapters.brainpad import (
    MANIFEST_BASENAME,
    MODULE_NAME,
    OUTPUT_BASENAMES,
    BrainpadAdapter,
)


def _write_complete_generation(directory: Any) -> None:
    """Write synthetic outputs and the digest-bound completion manifest."""
    files: list[dict[str, object]] = []
    for name in OUTPUT_BASENAMES:
        payload = f"data:{name}".encode()
        (directory / name).write_bytes(payload)
        files.append(
            {
                "name": name,
                "size": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        )
    (directory / MANIFEST_BASENAME).write_text(
        json.dumps({"schemaVersion": 1, "files": files}),
        encoding="utf-8",
    )


def make_cfg(outdir: str, *, repo_root: str = "/repo") -> dict[str, Any]:
    """Return a minimal config whose analysis outDir is an explicit path."""
    return {
        "paths": {
            "projectRoot": repo_root,
            "outputDir": f"{repo_root}/outputs/run",
        },
        "tools": {"pythonExecutable": "/usr/bin/python3"},
        "steps": {"brainpad": {"enabled": True, "params": {"outDir": outdir}}},
    }


def test_param_schema_keys() -> None:
    schema = BrainpadAdapter().param_schema()
    assert set(schema) == {"outDir"}


def test_registered_under_key() -> None:
    assert "brainpad" in ADAPTERS
    assert isinstance(ADAPTERS["brainpad"], BrainpadAdapter)
    assert ADAPTERS["brainpad"].advances == ("stats",)


def test_build_command_resolved_argv() -> None:
    outdir = "/work/analysis"
    cfg = make_cfg(outdir)
    argv = BrainpadAdapter().build_command(cfg, subject_id=None)

    assert argv[0] == "/usr/bin/python3"
    # Use the bundled analysis resource instead of an external path.
    assert argv[1] == str(resources.step7_dir() / MODULE_NAME)
    assert argv[1].endswith("step7/brainpadstats.py")
    assert argv[2] == "/repo/outputs/run/analysis/predicted_results.xlsx"

    # Preserve output_path1 through output_path12 order.
    expected_outputs = [os.path.join(outdir, name) for name in OUTPUT_BASENAMES]
    assert argv[3:] == expected_outputs
    assert len(argv) == 3 + 12


def test_build_command_uses_default_outdir() -> None:
    # Fall back to the steps.ts template when outDir has no override.
    cfg = make_cfg(outdir="", repo_root="/repo")
    cfg["steps"]["brainpad"]["params"].pop("outDir")
    argv = BrainpadAdapter().build_command(cfg, subject_id=None)
    assert argv[3] == "/repo/outputs/run/analysis/summary_statistics.csv"


def test_misspelled_ais_filename_preserved() -> None:
    assert "BrainPAD_acorss_AIS.csv" in OUTPUT_BASENAMES


def test_detect_pending_when_empty(tmp_path: Any) -> None:
    cfg = make_cfg(outdir=str(tmp_path))
    status = BrainpadAdapter().detect(cfg, subject_id=None)
    assert status.state == "pending"
    assert status.artifacts == []


def test_detect_done_when_all_artifacts_present(tmp_path: Any) -> None:
    cfg = make_cfg(outdir=str(tmp_path))
    _write_complete_generation(tmp_path)
    status = BrainpadAdapter().detect(cfg, subject_id=None)
    assert status.state == "done"
    assert len(status.artifacts) == 12


def test_detect_rejects_output_replaced_after_manifest_publication(
    tmp_path: Any,
) -> None:
    cfg = make_cfg(outdir=str(tmp_path))
    _write_complete_generation(tmp_path)
    (tmp_path / OUTPUT_BASENAMES[4]).write_text("substituted", encoding="utf-8")

    status = BrainpadAdapter().detect(cfg, subject_id=None)

    assert status.state == "failed"
    assert "changed after publication" in status.detail


def test_detect_partial_when_summary_only(tmp_path: Any) -> None:
    cfg = make_cfg(outdir=str(tmp_path))
    (tmp_path / "summary_statistics.csv").write_text("data")
    status = BrainpadAdapter().detect(cfg, subject_id=None)
    # Report partial when the summary exists but figures are missing.
    assert status.state == "partial"


def test_detect_partial_when_one_declared_table_is_missing(tmp_path: Any) -> None:
    cfg = make_cfg(outdir=str(tmp_path))
    missing = "BrainPAD_across_cohorts.csv"
    for name in OUTPUT_BASENAMES:
        if name != missing:
            (tmp_path / name).write_text("data")

    status = BrainpadAdapter().detect(cfg, subject_id=None)

    assert status.state == "partial"
    assert status.detail == "Create the remaining Brain-PAD artifacts; found 11/12."
    assert not any(path.endswith(missing) for path in status.artifacts)


def test_detect_partial_when_one_declared_table_is_empty(tmp_path: Any) -> None:
    cfg = make_cfg(outdir=str(tmp_path))
    empty = "ChronologicalAge_Comparison.csv"
    for name in OUTPUT_BASENAMES:
        (tmp_path / name).write_text("" if name == empty else "data")

    status = BrainpadAdapter().detect(cfg, subject_id=None)

    assert status.state == "partial"
    assert status.detail == "Create the remaining Brain-PAD artifacts; found 11/12."
    assert not any(path.endswith(empty) for path in status.artifacts)


def test_parse_failure_missing_dependency() -> None:
    fail = BrainpadAdapter().parse_failure(
        1, "", "ModuleNotFoundError: No module named 'cliffs_delta'"
    )
    assert fail is not None
    assert fail.tag == "missing_dependency"
    assert fail.message == (
        "Install cliffs-delta 1.0.0 in the configured analysis Python; "
        "do not reuse the isolated PyBrainAge interpreter."
    )


def test_parse_failure_missing_input() -> None:
    fail = BrainpadAdapter().parse_failure(
        1, "", "FileNotFoundError: [Errno 2] No such file or directory: 'x.xlsx'"
    )
    assert fail is not None
    assert fail.tag == "missing_input"


def test_parse_failure_bad_template_keyerror() -> None:
    fail = BrainpadAdapter().parse_failure(1, "", "KeyError: 'Cohort'")
    assert fail is not None
    assert fail.tag == "bad_template"


def test_parse_failure_bad_template_not_in_index() -> None:
    fail = BrainpadAdapter().parse_failure(1, "", "KeyError: \"['Age'] not in index\"")
    assert fail is not None
    assert fail.tag == "bad_template"


def test_parse_failure_input_bounds() -> None:
    fail = BrainpadAdapter().parse_failure(
        1, "", "ValueError: Keep expanded XLSX content within 256 MiB."
    )
    assert fail is not None
    assert fail.tag == "input_bounds"


def test_parse_failure_zero_is_none() -> None:
    assert BrainpadAdapter().parse_failure(0, "", "") is None
