#!/usr/bin/env python3
"""Recompute every receipt's signed payload with another build's code.

A receipt is reused only while the planner recomputes its exact signature and
the build's own record and signature checks accept it, so a build whose code
changes one bound field, or rejects a stored receipt, reruns that node and,
through ``upstreamSignatures``, everything downstream of it. This tool reads a
copy of a project (``.supraspina/receipts``, ``.supraspina/runs``, and the
project file), imports a build's sidecar from source, and recomputes for every stored
receipt every key of the build's signed payload (``RECEIPT_PAYLOAD_KEYS``,
plus ``reconstruction`` and ``reconstructionSignature`` for Reconstruction),
the signature over them, and the build's verdicts on the stored record
(``receipt_record_contract_valid``) and on reuse (``receipt_signature_valid``).
The configuration is the project file as saved, and the tool evidence is the producing run's recorded environment evidence.
Images are never read; the project's metadata tables and registry are.

Pass ``--baseline-src`` (the source of the build that wrote the receipts).
Both builds then run on the same copy, so a field counts as changed whenever
the candidate's computed value differs from the baseline's, including a
field neither build reproduces from the stored receipt (an older receipt
superseded on the deployed build, or a field that needs private run inputs); such a
field is reported ``n/r`` only while both builds compute the same value.
Without a baseline, every field the candidate does not reproduce counts as
changed. A receipt written by a packaged build binds no adapter source file
(``adapterImplementation.exists`` is false), so both values are compared in
that form.

This tool is sound only together with ``scripts/plan-replica.py``: it sees
stored receipts and the code that recomputes them, not the planner's node
graph, blockers, or Results currency, which the replica compares. Checking a
build before deploying it over another takes both tools.

A ``--preload`` file runs before each build's sidecar is imported, as with
``scripts/plan-replica.py`` (the synthetic project's environment
normalization and stand-ins).

Run it with the sidecar's environment, for example::

    uv run --project sidecar --all-extras --locked python \\
        scripts/receipt-invariance.py <project copy> \\
        --baseline-src <deployed build source> --expect-changed final,aggregate

Receipts written by a packaged build bind paths the way it resolved them:
the reviewed resources from the machine-local acquisition generation (a
token plus their content) and the first-party brain-FOV helper from its
frozen subset (verbatim). To recompute them faithfully, pass ``--asset-cache``
(a copy of the machine's ``scientific-assets`` cache) and ``--frozen-root``
(the path the packaged build's runtime tree had, for example inside
``bwrap``), plus ``--baseline-runtime`` and ``--candidate-runtime`` (each
build's runtime tree with ``resources/`` and ``metadata/``); each build's
tree is copied to ``--frozen-root`` before its recompute, as an install
replaces it in place.

The tool only reads: the receipt files and the asset cache are listed with
their SHA-256 before and after, and any change is reported and fails.

The exit status is 1 when a stage outside ``--expect-changed`` changes or
reruns through its lineage, or when a file was written, and 0 otherwise.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import runpy
import shutil
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

PROJECT_FILE = "supraspina.project.json"

#: Reconstruction binds its tool contract next to the signed payload.
RECON_FIELDS = ("reconstruction", "reconstructionSignature")
#: The signature over the payload and the build's verdicts on the stored record.
CHECK_FIELDS = ("signature", "recordContract", "reuseContract")
SHORT = {
    "receiptVersion": "version",
    "stepKey": "step",
    "subjectId": "subject",
    "scope": "scope",
    "analysisCohortDigest": "cohort",
    "selectedSubsetDigest": "subset",
    "inputT1Fingerprint": "t1",
    "configurationDigest": "config",
    "stepParamsDigest": "params",
    "executionActionDigest": "action",
    "adapterIdentity": "adapter",
    "adapterImplementation": "impl",
    "toolEvidenceDigest": "tools",
    "externalInputs": "inputs",
    "defacing": "deface",
    "outputSchemaIdentity": "schema",
    "upstreamSignatures": "upstream",
    "baseline": "baseline",
    "scopeBinding": "binding",
    "reconstruction": "recon",
    "reconstructionSignature": "reconsig",
    "signature": "sig",
    "recordContract": "record",
    "reuseContract": "reuse",
}


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _packaged_form(value: Any) -> Any:
    """Return an implementation identity as a frozen build binds it.

    A PyInstaller build has no adapter source file on disk, so the source part
    of ``adapterImplementation`` is ``{"exists": false}`` there.
    """
    if not isinstance(value, dict):
        return value
    form: dict[str, Any] = {"exists": False}
    if "scientificResources" in value:
        form["scientificResources"] = value["scientificResources"]
    return form


def _is_packaged_receipt(receipt: dict[str, Any]) -> bool:
    recorded = receipt.get("adapterImplementation")
    return isinstance(recorded, dict) and recorded.get("exists") is False


def _implementation_detail(recorded: Any, computed: Any) -> list[str]:
    """Name the parts of two implementation identities that differ."""
    if not isinstance(recorded, dict) or not isinstance(computed, dict):
        return ["whole value"]
    parts: list[str] = []
    source_keys = {"exists", "kind", "size", "sha256", "path"}
    if {k: recorded.get(k) for k in source_keys} != {
        k: computed.get(k) for k in source_keys
    }:
        parts.append("adapter source")
    left = recorded.get("scientificResources") or {}
    right = computed.get("scientificResources") or {}
    for name in sorted(set(left) | set(right)):
        if _canonical(left.get(name)) != _canonical(right.get(name)):
            parts.append(f"resource {name}")
    return parts


def _worker(args: argparse.Namespace) -> int:
    """Recompute receipt fields with the build under ``--src``; print JSON."""
    src = Path(args.src).resolve()
    if args.frozen_root:
        # Resolve resources as the packaged build does.
        sys.frozen = True  # type: ignore[attr-defined]
        sys._MEIPASS = str(Path(args.frozen_root).resolve())  # type: ignore[attr-defined]  # noqa: SLF001
    sys.path.insert(0, str(src / "sidecar"))
    for path in args.preload:
        runpy.run_path(path, run_name="__supraspina_preload__")
    from supraspina_sidecar import provenance, workflow  # noqa: PLC0415
    from supraspina_sidecar.adapters.base import ADAPTERS  # noqa: PLC0415
    from supraspina_sidecar.registry import STEP_DEPENDENCIES  # noqa: PLC0415
    from supraspina_sidecar.results import _cohort  # noqa: PLC0415
    from supraspina_sidecar.run_store import (  # noqa: PLC0415
        RECEIPT_PAYLOAD_KEYS,
        RunStore,
        receipt_record_contract_valid,
    )

    root = Path(args.project).resolve()
    project_file = Path(args.project_file or root / PROJECT_FILE)
    saved = json.loads(project_file.read_text(encoding="utf-8"))
    cfg = saved if isinstance(saved, dict) else {}
    paths = cfg.get("paths", {}) if isinstance(cfg.get("paths"), dict) else {}
    # Bind run directories under the root the receipts were written at, so
    # the run-directory token in each action matches; read data from the copy.
    signing_root = str(paths.get("projectRoot") or root)
    store = RunStore(str(root))
    states: dict[str, dict[str, Any] | None] = {}
    rows: list[dict[str, Any]] = []
    receipt_root = root / ".supraspina" / "receipts"
    for path in sorted(receipt_root.glob("*/*/*.json")):
        receipt = json.loads(path.read_text(encoding="utf-8"))
        step = str(receipt.get("stepKey"))
        subject = receipt.get("subjectId")
        run_id = str(receipt.get("runId") or "")
        row: dict[str, Any] = {
            "file": str(path.relative_to(root)),
            "stepKey": step,
            "subjectId": subject,
            "runId": run_id,
            "packaged": _is_packaged_receipt(receipt),
            "fields": {},
            "errors": [],
        }
        rows.append(row)
        adapter = ADAPTERS.get(step)
        if adapter is None:
            row["errors"].append("The build registers no adapter for this stage.")
            continue
        if run_id not in states:
            try:
                states[run_id] = store.load(run_id)
            except (OSError, ValueError) as exc:
                states[run_id] = None
                row["errors"].append(f"Run state {run_id} is unreadable: {exc}")
        state = states[run_id] or {}
        cohort = _cohort(state.get("scope", {}) or {})
        effective = workflow.runtime_cfg(cfg, cohort, run_id, signing_root)
        try:
            tool_evidence = provenance.bound_tool_evidence(
                state.get("environmentEvidence", {}),
                adapter.required_check_ids(effective),
            )
            payload = provenance.expected_receipt_payload(
                step,
                subject,
                effective,
                cohort,
                adapter,
                upstream_signatures=list(receipt.get("upstreamSignatures") or []),
                tool_evidence=tool_evidence,
                provider_evidence=state.get("providerEvidence"),
            )
        except Exception as exc:  # noqa: BLE001 - report, never mask, a failure
            row["errors"].append(f"{type(exc).__name__}: {exc}")
            continue
        if row["packaged"]:
            payload["adapterImplementation"] = _packaged_form(
                payload.get("adapterImplementation")
            )
            if step == "recon":
                # The tool contract binds the signature of the packaged payload.
                payload["reconstruction"] = provenance._reconstruction_contract(  # noqa: SLF001
                    effective,
                    tool_evidence,
                    state.get("providerEvidence"),
                    provenance.stable_digest(
                        {key: payload.get(key) for key in RECEIPT_PAYLOAD_KEYS}
                    ),
                )
                payload["reconstructionSignature"] = provenance.stable_digest(
                    payload["reconstruction"]
                )
        if step in {"clinical", "final"}:
            _signature, payload = provenance.bind_projection_inputs(step, "", payload)
        names = [*RECEIPT_PAYLOAD_KEYS, *(RECON_FIELDS if step == "recon" else ())]
        computed_values: dict[str, Any] = {name: payload.get(name) for name in names}
        computed_values["signature"] = provenance.stable_digest(
            {key: payload.get(key) for key in RECEIPT_PAYLOAD_KEYS}
        )
        for name, computed in computed_values.items():
            recorded = receipt.get(name)
            item: dict[str, Any] = {
                "equal": _canonical(recorded) == _canonical(computed),
                "computed": _digest(computed),
            }
            if name == "adapterImplementation":
                item["value"] = computed
                if not item["equal"]:
                    item["detail"] = _implementation_detail(recorded, computed)
            row["fields"][name] = item
        # Reuse goes through the build's own record and signature checks, so a
        # build that rejects a stored receipt reruns it whatever it recomputes.
        verdicts = {
            "recordContract": receipt_record_contract_valid(receipt),
            "reuseContract": provenance.receipt_signature_valid(
                receipt, str(receipt.get("signature") or "")
            ),
        }
        for name, valid in verdicts.items():
            row["fields"][name] = {"equal": bool(valid), "computed": str(bool(valid))}
    json.dump(
        {
            "src": str(src),
            "dependencies": _lineage(STEP_DEPENDENCIES, receipt_root),
            "receipts": rows,
        },
        sys.stdout,
    )
    return 0


def _lineage(declared: Any, receipt_root: Path) -> dict[str, list[str]]:
    """Return each stage's producers: the declared ones and those its receipts bind.

    A configuration-dependent edge (Reconstruction after Brain FOV preparation)
    is not declared in the registry, but every receipt names its producers'
    signatures in ``upstreamSignatures``.
    """
    dependencies = {key: set(value) for key, value in declared.items()}
    receipts = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(receipt_root.glob("*/*/*.json"))
    ]
    step_by_signature = {
        str(receipt.get("signature")): str(receipt.get("stepKey"))
        for receipt in receipts
    }
    for receipt in receipts:
        for upstream in receipt.get("upstreamSignatures") or []:
            producer = step_by_signature.get(str(upstream))
            if producer is not None:
                dependencies.setdefault(str(receipt.get("stepKey")), set()).add(
                    producer
                )
    return {key: sorted(value) for key, value in dependencies.items()}


def _run_worker(src: str, args: argparse.Namespace, script: Path) -> dict[str, Any]:
    command = [
        args.python,
        str(script),
        "--worker",
        "--src",
        src,
        args.project,
    ]
    if args.project_file:
        command += ["--project-file", args.project_file]
    if args.frozen_root:
        command += ["--frozen-root", args.frozen_root]
    for path in args.preload:
        command += ["--preload", str(Path(path).resolve())]
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    env.pop("PYTHONPATH", None)
    if args.asset_cache:
        env["SUPRASPINA_SCIENTIFIC_ASSET_ROOT"] = str(Path(args.asset_cache).resolve())
    result = subprocess.run(  # noqa: S603
        command, capture_output=True, text=True, env=env, check=False
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise SystemExit(f"The recompute with {src} failed.")
    return json.loads(result.stdout)


def install_runtime(runtime: str, frozen_root: str) -> None:
    """Replace the runtime tree at ``frozen_root`` with a build's own tree."""
    target = Path(frozen_root)
    for name in ("resources", "metadata"):
        shutil.rmtree(target / name, ignore_errors=True)
        shutil.copytree(Path(runtime) / name, target / name, symlinks=True)


def file_hashes(root: Path) -> dict[str, str]:
    """Return every file under ``root`` with its SHA-256."""
    found: dict[str, str] = {}
    for path in sorted(root.rglob("*")) if root.is_dir() else []:
        if path.is_file() and not path.is_symlink():
            found[str(path.relative_to(root))] = hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
    return found


def written_files(before: dict[str, str], after: dict[str, str]) -> list[str]:
    """Return the files added, removed, or rewritten between two listings."""
    return [
        *(f"added {path}" for path in sorted(set(after) - set(before))),
        *(f"removed {path}" for path in sorted(set(before) - set(after))),
        *(
            f"changed {path}"
            for path in sorted(set(before) & set(after))
            if before[path] != after[path]
        ),
    ]


def _field_order(field_maps: list[dict[str, Any]]) -> list[str]:
    """Return field names in table order, then any a build adds."""
    names = [name for name in SHORT if any(name in m for m in field_maps)]
    extra = sorted({name for m in field_maps for name in m} - set(SHORT))
    return names + extra


def _descendants(dependencies: dict[str, list[str]], changed: set[str]) -> set[str]:
    """Return every stage that binds a changed stage through its lineage."""
    found: set[str] = set()
    pending = set(changed)
    while pending:
        current = pending.pop()
        for step, parents in dependencies.items():
            if current in parents and step not in found:
                found.add(step)
                pending.add(step)
    return found - changed


def evaluate(
    candidate: dict[str, Any],
    baseline: dict[str, Any] | None,
    expected: set[str],
) -> dict[str, Any]:
    """Classify every receipt field as kept, changed, or not reproducible.

    With a baseline, a field changes when the two builds compute different
    values on the same copy, whether or not either reproduces the stored one.
    """
    base_rows = {row["file"]: row for row in (baseline or {}).get("receipts", [])}
    stages: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "receipts": 0,
            "packaged": 0,
            "changed": defaultdict(int),
            "unreproducible": defaultdict(int),
            "details": set(),
            "errors": [],
            "fields": set(),
        }
    )
    for row in candidate["receipts"]:
        stage = stages[row["stepKey"]]
        stage["receipts"] += 1
        stage["packaged"] += int(row["packaged"])
        base = base_rows.get(row["file"])
        errors = list(row["errors"])
        if base is not None and base["errors"]:
            errors += [f"baseline: {error}" for error in base["errors"]]
        if errors:
            stage["errors"].append(f"{row['file']}: {'; '.join(errors)}")
            continue
        fields = row["fields"]
        base_fields = base["fields"] if base is not None else {}
        stage["fields"].update(fields, base_fields)
        for name in _field_order([fields, base_fields]):
            item, base_item = fields.get(name), base_fields.get(name)
            if base is None:
                # Without a baseline only the stored value separates the builds.
                changed = item is None or not item["equal"]
            else:
                changed = (item or {}).get("computed") != (base_item or {}).get(
                    "computed"
                )
            if changed:
                stage["changed"][name] += 1
                if name == "adapterImplementation":
                    stage["details"].update(
                        _implementation_detail(
                            (base_item or {}).get("value"), (item or {}).get("value")
                        )
                        if base is not None
                        else (item or {}).get("detail", ["whole value"])
                    )
            elif not item["equal"]:
                stage["unreproducible"][name] += 1
    changed = {key for key, stage in stages.items() if stage["changed"]}
    erroring = {key for key, stage in stages.items() if stage["errors"]}
    lineage = _descendants(candidate["dependencies"], changed) & set(stages)
    unexpected = sorted((changed | lineage | erroring) - expected)
    return {
        "stages": stages,
        "changed": sorted(changed),
        "lineage": sorted(lineage),
        "unexpected": unexpected,
        "absentExpected": sorted(expected - changed - lineage),
    }


def _format(result: dict[str, Any], candidate: dict[str, Any]) -> str:
    lines: list[str] = []
    columns = _field_order(
        [
            {name: None for name in stage["changed"]}
            for stage in result["stages"].values()
        ]
        + [
            {name: None for name in stage["unreproducible"]}
            for stage in result["stages"].values()
        ]
        + [row["fields"] for row in candidate["receipts"]]
    )
    header = ["stage", "receipts", *(SHORT.get(name, name) for name in columns)]
    table = [header]
    order = list(candidate["dependencies"])
    for key in sorted(
        result["stages"], key=lambda k: (order.index(k) if k in order else 99, k)
    ):
        stage = result["stages"][key]
        cells = [key, f"{stage['receipts']}" + ("p" if stage["packaged"] else "")]
        for name in columns:
            if stage["changed"].get(name):
                cells.append(f"CHANGED {stage['changed'][name]}")
            elif stage["unreproducible"].get(name):
                cells.append(f"n/r {stage['unreproducible'][name]}")
            elif name not in stage["fields"]:
                cells.append("-")
            else:
                cells.append("=")
        table.append(cells)
    widths = [max(len(row[i]) for row in table) for i in range(len(header))]
    lines += [
        "  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)) for row in table
    ]
    lines.append(
        "Legend: = recomputed equal; - = not bound by this stage; CHANGED n = the candidate computes n "
        "receipts differently from the baseline (or, without one, from the "
        "stored receipt); n/r n = both builds compute the same value but do not "
        "reproduce n stored receipts; record and reuse = the build's record and "
        "reuse checks accept the stored receipt; a trailing p = receipts "
        "written by a packaged build."
    )
    for key, stage in sorted(result["stages"].items()):
        if stage["details"]:
            lines.append(f"{key}: changed {', '.join(sorted(stage['details']))}.")
        for error in stage["errors"][:5]:
            lines.append(f"{key}: error {error}")
    lines.append("Changed stages: " + (", ".join(result["changed"]) or "none") + ".")
    lines.append(
        "Stages that rerun through their lineage: "
        + (", ".join(result["lineage"]) or "none")
        + "."
    )
    if result["absentExpected"]:
        lines.append(
            "Expected to change but unchanged: "
            + ", ".join(result["absentExpected"])
            + "."
        )
    lines.append("Unexpected: " + (", ".join(result["unexpected"]) or "none") + ".")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """Run the comparison, or one recompute with ``--worker``."""
    parser = argparse.ArgumentParser(
        description="Recompute receipt identities with another build's code."
    )
    parser.add_argument("project", help="Project copy holding .supraspina/receipts.")
    parser.add_argument(
        "--project-file",
        help=f"Project file to read (default: <project>/{PROJECT_FILE}).",
    )
    parser.add_argument(
        "--candidate-src",
        default=str(Path(__file__).resolve().parents[1]),
        help="Source tree of the candidate build (default: this repository).",
    )
    parser.add_argument(
        "--baseline-src",
        help="Source tree of the build that wrote the receipts.",
    )
    parser.add_argument(
        "--expect-changed",
        default="",
        help="Comma-separated stages allowed to change.",
    )
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="Interpreter with the sidecar's dependencies.",
    )
    parser.add_argument("--json", help="Write the full result to this file.")
    parser.add_argument(
        "--asset-cache", help="Scientific asset cache a packaged build resolved."
    )
    parser.add_argument(
        "--frozen-root", help="Path of the packaged build's runtime tree."
    )
    parser.add_argument(
        "--preload",
        action="append",
        default=[],
        help="Python file run before each build's sidecar is imported (repeatable).",
    )
    parser.add_argument("--baseline-runtime", help="Runtime tree of the baseline.")
    parser.add_argument("--candidate-runtime", help="Runtime tree of the candidate.")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--src", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.worker:
        return _worker(args)
    if bool(args.frozen_root) != bool(args.candidate_runtime) or (
        args.baseline_src and bool(args.frozen_root) != bool(args.baseline_runtime)
    ):
        parser.error("Pass --frozen-root together with each build's runtime tree.")
    script = Path(__file__).resolve()
    watched = [Path(args.project) / ".supraspina" / "receipts"]
    if args.asset_cache:
        watched.append(Path(args.asset_cache))
    before = {str(root): file_hashes(root) for root in watched}
    if args.frozen_root:
        install_runtime(args.candidate_runtime, args.frozen_root)
    candidate = _run_worker(args.candidate_src, args, script)
    baseline = None
    if args.baseline_src:
        if args.frozen_root:
            install_runtime(args.baseline_runtime, args.frozen_root)
        baseline = _run_worker(args.baseline_src, args, script)
    writes = [
        f"{root}: {item}"
        for root in map(str, watched)
        for item in written_files(before[root], file_hashes(Path(root)))
    ]
    expected = {item.strip() for item in args.expect_changed.split(",") if item.strip()}
    result = evaluate(candidate, baseline, expected)
    result["writes"] = writes
    print(_format(result, candidate))
    print(
        f"Files written: {len(writes)}"
        + ("." if not writes else ": " + "; ".join(writes[:10]) + ".")
    )
    if args.json:
        serializable = {
            **{k: v for k, v in result.items() if k != "stages"},
            "stages": {
                key: {
                    **{
                        k: v for k, v in stage.items() if k not in {"details", "fields"}
                    },
                    "details": sorted(stage["details"]),
                    "fields": sorted(stage["fields"]),
                }
                for key, stage in result["stages"].items()
            },
            "candidate": candidate,
            "baseline": baseline,
        }
        Path(args.json).write_text(json.dumps(serializable, indent=1), encoding="utf-8")
    return 1 if result["unexpected"] or writes else 0


if __name__ == "__main__":
    sys.exit(main())
