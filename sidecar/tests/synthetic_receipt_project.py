"""Build a small synthetic project whose receipts the importing build writes.

Run this file with ``PYTHONPATH`` pointing at one build's ``sidecar``
directory (for example a ``git archive`` of the build a host runs). The real
``WorkflowManager`` of that build plans Run all, executes it and writes every
receipt, run state and detector artifact; only the scientific processes are
replaced by writers that create small synthetic outputs each detector accepts.
No participant data is involved: every T1, stats file, table and image is
synthetic.

Environment checks run for real; every check except the bundled-asset checks
is then normalized (found, fixed detail), because the synthetic project has
no scientific tools. Load the
same normalization into a development-mode sidecar with
``scripts/plan-replica.py --preload <this file>`` so a later plan binds the
same tool evidence.

With ``--brainfov`` the project also runs Brain FOV preparation: each T1 is
a small valid NIfTI inside the field-of-view limit, so the first-party helper
publishes a pass-through preparation without SynthStrip, and the SynthStrip
image path is a stand-in (the planner never opens it).

A packaged build resolves its resources from a frozen runtime tree and a
machine-local acquisition generation. Set ``SUPRASPINA_REPLICA_FROZEN_RUNTIME``
to a build's runtime tree (``resources/`` and ``metadata/`` as PyInstaller
lays them out) and ``SUPRASPINA_SCIENTIFIC_ASSET_ROOT`` to an asset cache, and
both this generator and a preloaded sidecar resolve them as that build does.

Usage::

    PYTHONPATH=<build>/sidecar python synthetic_receipt_project.py \
        --root <project root> --rawdata <raw data root> [--brainfov]
"""

from __future__ import annotations

import argparse
import copy
import csv
import gzip
import hashlib
import json
import os
import struct
import subprocess
import sys
import threading
import time
import zlib
from contextlib import nullcontext
from pathlib import Path
from typing import Any

#: Synthetic subjects: identifier, registry cohort label, age, sex, AIS.
SUBJECTS: tuple[tuple[str, str, int, str, str | None], ...] = (
    ("sub-901", "CTRL", 31, "F", None),
    ("sub-902", "CTRL", 44, "M", None),
    ("sub-903", "CTRL", 52, "F", None),
    ("sub-904", "CTRL", 38, "M", None),
    ("sub-905", "SCI_P", 47, "M", "A"),
    ("sub-906", "SCI_P", 35, "F", "B"),
    ("sub-907", "SCI_nNP", 58, "M", "D"),
    ("sub-908", "SCI_nNP", 29, "F", "C"),
)
CLINICAL_COHORT = {"CTRL": "control", "SCI_P": "SCI_P", "SCI_nNP": "SCI_nNP"}
FINAL_COHORT = {"CTRL": "SCI_H", "SCI_P": "SCI_P", "SCI_nNP": "SCI_nNP"}
PROJECT_FILE = "supraspina.project.json"
#: The FreeSurfer release in the detail lets ENIGMA QC read a provider major.
SYNTHETIC_DETAIL = "{} synthetic environment (release 8.2.0)"


#: Environment variable naming a frozen runtime tree to emulate a packaged
#: build with; see :func:`emulate_packaged_build`.
FROZEN_RUNTIME_ENV = "SUPRASPINA_REPLICA_FROZEN_RUNTIME"
#: Stand-in path of the verified SynthStrip image; nothing opens it.
SYNTHETIC_SIF = "synthetic-synthstrip.sif"


def emulate_packaged_build() -> None:
    """Resolve resources as a packaged build does when the variable is set.

    The build's own code then resolves its frozen subset under the named
    runtime tree and the acquired generation from ``SUPRASPINA_SCIENTIFIC_ASSET_ROOT``.
    """
    runtime = os.environ.get(FROZEN_RUNTIME_ENV)
    if runtime:
        sys.frozen = True  # type: ignore[attr-defined]
        sys._MEIPASS = runtime  # type: ignore[attr-defined]


def install_synthstrip_stand_in() -> None:
    """Resolve Brain FOV preparation's SynthStrip image as provisioned.

    The plan records the pinned release identity, as for a provisioned
    image; the image path is a stand-in that nothing opens.
    """
    from supraspina_sidecar import (  # noqa: PLC0415
        runtime_resources,
        scientific_resources,
    )
    from supraspina_sidecar.adapters import brainfov  # noqa: PLC0415

    def sif_path(cfg: dict[str, Any]) -> str:
        root = cfg.get("paths", {}).get("projectRoot", "")
        return os.path.join(str(root), "tools", SYNTHETIC_SIF)

    def resolve(state: Any) -> None:
        state.evidence["synthstrip"] = runtime_resources._resource_identity(
            "synthstrip", "cpu", scientific_resources.SYNTHSTRIP_RELEASE_PIN
        )

    brainfov._sif_path = sif_path
    runtime_resources._resolve_synthstrip = resolve


#: The bundled-asset probe stays real: it reads only the build's own resources,
#: and the Results inventory re-runs it live instead of reading the report.
REAL_GROUPS = frozenset({"Pipeline assets"})


def normalized_environment(report: dict[str, Any]) -> dict[str, Any]:
    """Return an env report with every tool check found and a fixed detail.

    Keep the build's own check ids and groups so a build that adds checks
    still reports them, and keep the bundled-asset checks as probed; drop the
    frozen identity text and the measured memory so two runs bind identical
    tool evidence.
    """
    value = copy.deepcopy(report)
    for group in value.get("groups", []):
        if group.get("name") in REAL_GROUPS:
            continue
        for check in group.get("checks", []):
            check["status"] = "found"
            check["detail"] = SYNTHETIC_DETAIL.format(check.get("id"))
            check.pop("identityDetail", None)
            check.pop("fix", None)
    value["availableMemoryGB"] = 64.0
    value["capturedAt"] = "2026-01-01T00:00:00+00:00"
    return value


def install_environment_normalization() -> None:
    """Patch the importing build's ``env.check`` with the normalized report."""
    from supraspina_sidecar import env  # noqa: PLC0415

    real = env.check

    def check(cfg: dict[str, Any], ids: list[str] | None = None) -> dict[str, Any]:
        return normalized_environment(real(cfg, ids))

    env.check = check


def _png(marker: int) -> bytes:
    """Return a small structurally complete PNG."""

    def chunk(kind: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(payload, zlib.crc32(kind)) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", crc)

    header = struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0)
    rows = b"".join(b"\0" + bytes([marker % 256, 0, 0] * 4) for _ in range(4))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"tEXt", b"Comment\0synthetic Supraspina fixture " * 4)
        + chunk(b"IEND", b"")
    )


def _nifti(marker: int) -> bytes:
    """Return a small gzipped single-volume NIfTI-1 well inside the FOV limit."""
    header = bytearray(348)
    struct.pack_into("<i", header, 0, 348)
    struct.pack_into("<8h", header, 40, 3, 8, 8, 8, 1, 1, 1, 1)
    struct.pack_into("<hh", header, 70, 2, 8)
    struct.pack_into("<8f", header, 76, 1.0, 2.0, 2.0, 2.0, 0.0, 0.0, 0.0, 0.0)
    struct.pack_into("<3f", header, 108, 352.0, 1.0, 0.0)
    struct.pack_into("<hh", header, 252, 0, 1)
    struct.pack_into("<4f", header, 280, 2.0, 0.0, 0.0, -8.0)
    struct.pack_into("<4f", header, 296, 0.0, 2.0, 0.0, -8.0)
    struct.pack_into("<4f", header, 312, 0.0, 0.0, 2.0, -8.0)
    header[344:348] = b"n+1\x00"
    voxels = bytes((index * 7 + marker * 13) % 251 for index in range(512))
    return gzip.compress(bytes(header) + b"\0" * 4 + voxels, mtime=0)


def _write(path: str | Path, data: bytes | str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        data = data.encode("utf-8")
    target.write_bytes(data)


def _write_rows(path: str | Path, header: list[str], rows: list[list[Any]]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def _value(subject: str, column: str, scale: float = 1.0) -> str:
    digest = hashlib.sha256(f"{subject}:{column}".encode()).digest()
    return f"{(1.0 + digest[0] / 255.0) * scale:.4f}"


def _cohort(cfg: dict[str, Any]) -> list[str]:
    runtime = cfg.get("_supraspinaRuntime", {})
    subjects = runtime.get("reconstructionViewSubjectIds")
    if isinstance(subjects, list) and subjects:
        return [str(value) for value in subjects]
    return [row[0] for row in SUBJECTS]


def _write_recon(adapter: Any, cfg: dict[str, Any], subject: str) -> None:
    from supraspina_sidecar.adapters.fastsurfer import (  # noqa: PLC0415
        reconstruction_artifact_groups,
        selected_backend,
    )

    root = adapter._subject_dir(cfg, subject)
    for alternatives in reconstruction_artifact_groups(selected_backend(cfg)):
        relative = alternatives[0]
        if relative.endswith(".stats"):
            payload = (
                "# Title synthetic FreeSurfer-style statistics\n"
                f"# subjectname {subject}\n"
                "# Measure EstimatedTotalIntraCranialVol, eTIV, Estimated Total "
                f"Intracranial Volume, {_value(subject, 'etiv', 1.5e6)}, mm^3\n"
            )
        else:
            payload = f"synthetic {relative} for {subject}\n"
        _write(os.path.join(root, relative), payload)


def _run_brainfov_helper(argv: list[str]) -> None:
    """Run the first-party helper the container would run, on this interpreter."""
    start = argv.index("python3")
    completed = subprocess.run(  # noqa: S603 - The planner's own argv.
        [sys.executable, *argv[start + 1 :]],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stdout + completed.stderr)


def _write_enigma(adapter: Any, cfg: dict[str, Any]) -> None:
    from supraspina_sidecar.adapters import enigma  # noqa: PLC0415

    out_dir = adapter._out_dir(cfg)
    subjects = _cohort(cfg)
    columns = {
        "LandRvolumes.csv": ["LLatVent", "RLatVent", "Lthal", "Rthal", "ICV"],
        "CorticalMeasuresENIGMA_ThickAvg.csv": [
            "L_bankssts_thickavg",
            "R_bankssts_thickavg",
            "LThickness",
            "RThickness",
            "ICV",
        ],
        "CorticalMeasuresENIGMA_SurfAvg.csv": [
            "L_bankssts_surfavg",
            "R_bankssts_surfavg",
            "LSurfArea",
            "RSurfArea",
            "ICV",
        ],
    }
    for name, names in columns.items():
        _write_rows(
            os.path.join(out_dir, "measures", name),
            ["SubjID", *names],
            [
                [subject, *(_value(subject, c, 10.0) for c in names)]
                for subject in subjects
            ],
        )
    marker = 0
    for gallery, subdir, filename in enigma._QC_GALLERIES:
        tags: list[str] = []
        for subject in subjects:
            for panel in enigma.gallery_panels(gallery, subject):
                for relative in {panel.montage_relative, panel.full_relative}:
                    marker += 1
                    _write(os.path.join(out_dir, subdir, relative), _png(marker))
                tags.append(f'<img src="{panel.montage_relative}">')
                tags.append(f'<a href="file:{panel.full_relative}"></a>')
        _write(
            os.path.join(out_dir, subdir, filename),
            "<html><body>" + "".join(tags) + "</body></html>",
        )


def _write_outliers(adapter: Any, cfg: dict[str, Any]) -> None:
    from supraspina_sidecar.adapters import outliers  # noqa: PLC0415

    out_dir = adapter._output_dir(cfg)
    _write_rows(
        os.path.join(out_dir, "outliers.csv"), list(outliers._OUTLIER_HEADER), []
    )
    for index, name in enumerate(sorted(adapter._expected_histograms(cfg))):
        _write(os.path.join(out_dir, "hist", name), _png(200 + index))


def _feature_header(adapter: Any) -> list[str]:
    header = adapter._expected_default_header()
    if not header:
        raise RuntimeError("The build's feature-order template is unreadable.")
    return header


def _write_features(adapter: Any, cfg: dict[str, Any]) -> None:
    from supraspina_sidecar.adapters import features  # noqa: PLC0415

    header = _feature_header(adapter)
    _write_rows(
        os.path.join(adapter._out_dir(cfg), features.CONCATENATED_NAME),
        header,
        [[s, *(_value(s, c, 2.5) for c in header[1:])] for s in _cohort(cfg)],
    )


def _write_age(adapter: Any, cfg: dict[str, Any]) -> None:
    from supraspina_sidecar.adapters.base import ADAPTERS  # noqa: PLC0415

    header = _feature_header(ADAPTERS["features"])
    ages = {row[0]: row[2] for row in SUBJECTS}
    _write_rows(
        adapter.resolve(adapter.output_template, cfg),
        [header[0], "Age", *header[1:]],
        [[s, ages[s], *(_value(s, c, 2.5) for c in header[1:])] for s in _cohort(cfg)],
    )


def _write_pybrainage(adapter: Any, cfg: dict[str, Any]) -> None:
    from supraspina_sidecar.adapters import pybrainage  # noqa: PLC0415

    ages = {row[0]: row[2] for row in SUBJECTS}
    rows = []
    for subject in _cohort(cfg):
        brain_age = ages[subject] + float(_value(subject, "pad", 3.0))
        rows.append(
            [
                subject,
                ages[subject],
                f"{brain_age:.4f}",
                f"{brain_age - ages[subject]:.4f}",
            ]
        )
    _write_rows(
        adapter.resolve(adapter.output_template, cfg),
        list(pybrainage.PREDICTED_COLUMNS),
        rows,
    )


def _write_clinical(adapter: Any, cfg: dict[str, Any]) -> None:
    from openpyxl import Workbook  # noqa: PLC0415

    records = {row[0]: row for row in SUBJECTS}
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(
        [
            "Subject_ID",
            "Age",
            "BrainAge",
            "BrainPAD",
            "Cohort",
            "AIS",
            "Sex",
            "Time since SCI (years)",
        ]
    )
    for subject in _cohort(cfg):
        _sid, label, age, sex, ais = records[subject]
        sheet.append(
            [
                subject,
                age,
                age + 1.5,
                1.5,
                CLINICAL_COHORT[label],
                ais or "control",
                sex,
                None if ais is None else 3.0,
            ]
        )
    target = Path(adapter._workbook(cfg))
    target.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(target)


def _write_brainpad(adapter: Any, cfg: dict[str, Any]) -> None:
    from supraspina_sidecar.adapters import brainpad  # noqa: PLC0415

    out_dir = adapter._outdir(cfg)
    files: list[dict[str, Any]] = []
    for name in brainpad.OUTPUT_BASENAMES:
        payload = (
            _png(len(files) + 300)
            if name.endswith(".png")
            else f"synthetic,brainpad\n{name},1\n".encode()
        )
        _write(os.path.join(out_dir, name), payload)
        files.append(
            {
                "name": name,
                "size": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        )
    _write(
        os.path.join(out_dir, brainpad.MANIFEST_BASENAME),
        json.dumps({"schemaVersion": 1, "files": files}),
    )


def _write_aggregate(adapter: Any, cfg: dict[str, Any]) -> None:
    from supraspina_sidecar.adapters import aggregate  # noqa: PLC0415

    out_dir = adapter._out_dir(cfg)
    for name in aggregate._OUTPUT_CSVS:
        required = list(aggregate._REQUIRED_CSV_HEADERS[name])
        columns = [*required, "synthetic_measure"]
        _write_rows(
            os.path.join(out_dir, name),
            columns,
            [
                [
                    s if column in {"subject", "ID"} else _value(s, column, 3.0)
                    for column in columns
                ]
                for s in _cohort(cfg)
            ],
        )


def _write_final(adapter: Any, cfg: dict[str, Any]) -> None:
    from supraspina_sidecar.adapters import final  # noqa: PLC0415

    render = bool(adapter.params(cfg).get("renderReport", True))
    for contract in final.output_contracts(
        adapter._out_dir(cfg), include_report=render
    ):
        if contract.key == "report":
            target = next(
                path for path in contract.candidates if path.endswith(".html")
            )
            _write(target, "<html><body>Synthetic report</body></html>\n")
            continue
        target = next(path for path in contract.candidates if path.endswith(".csv"))
        _write_rows(target, ["region", "effect"], [["synthetic", "0.1"]])


WRITERS = {
    "enigma": _write_enigma,
    "outliers": _write_outliers,
    "features": _write_features,
    "age": _write_age,
    "pybrainage": _write_pybrainage,
    "clinical": _write_clinical,
    "brainpad": _write_brainpad,
    "aggregate": _write_aggregate,
    "final": _write_final,
}


def project_config(
    root: Path, rawdata: Path, *, brainfov: bool = False
) -> dict[str, Any]:
    """Return a host-like project file for the synthetic project."""
    output = root / "derivatives" / "supraspina"
    return {
        "project": {"name": "Synthetic replica", "createdAt": "2026-01-01T00:00:00Z"},
        "platform": {"mode": "linux", "pathStyle": "posix"},
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(rawdata),
            "derivativesDir": str(root / "derivatives"),
            "outputDir": str(output),
            "metadataDir": str(root / "metadata"),
            "clinicalMetadataFile": str(root / "metadata" / "clinical.csv"),
            "ageMetadataFile": str(root / "metadata" / "age.csv"),
            "qcOutputDir": str(output / "qc_review"),
        },
        "tools": {
            "freesurferHome": str(root / "tools" / "freesurfer"),
            "freesurferLicense": str(root / "tools" / "license.txt"),
            "pythonExecutable": str(root / "tools" / "python3"),
            "rscriptExecutable": str(root / "tools" / "Rscript"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "runtime": {
            "threads": 2,
            "queueSize": 2,
            "memoryWarningGB": 10,
            "dryRun": False,
            "resumeCompleted": True,
            "rerunIncomplete": True,
            "stopOnError": False,
            "continueIndependentAfterError": True,
        },
        "subjects": {"include": [], "exclude": []},
        "steps": {
            "brainfov": {"enabled": brainfov, "params": {"marginMm": 30}},
            "deface": {
                "enabled": False,
                "params": {"tool": "mri_deface", "forceOverwrite": False},
            },
            "recon": {
                "enabled": True,
                "params": {
                    "backend": "freesurfer",
                    "fastsurferDevice": "auto",
                    "directives": "-all",
                    "parallel": True,
                },
            },
            "enigma": {
                "enabled": True,
                "params": {
                    "backend": "matlab",
                    "matlabExecutable": str(root / "tools" / "matlab"),
                    "mcrRoot": "",
                    "enigmaScriptDir": "",
                    "outDir": "${paths.qcOutputDir}",
                    "fsVersion": "8",
                },
            },
            "outliers": {"enabled": True, "params": {"zThreshold": 2.698}},
            "features": {
                "enabled": True,
                "params": {
                    "parcellation": "aparc.a2009s",
                    "measure": "thickness",
                    "outDir": "${paths.outputDir}/features",
                    "validateFeatureOrder": True,
                },
            },
            "age": {
                "enabled": True,
                "params": {
                    "subjectIdColumn": "participant_id",
                    "ageColumn": "age",
                    "join": "left",
                    "warnOnMissing": True,
                },
            },
            "pybrainage": {
                "enabled": True,
                "params": {
                    "pythonExecutable": "",
                    "modelPath": "${pybrain.modelPath}",
                    "scalerPath": "${pybrain.scalerPath}",
                    "rowFallback": True,
                },
            },
            "clinical": {
                "enabled": True,
                "params": {
                    "joinKey": "participant_id",
                    "requiredColumns": "Cohort,AIS",
                },
            },
            "brainpad": {
                "enabled": True,
                "params": {"outDir": "${paths.outputDir}/analysis"},
            },
            "aggregate": {
                "enabled": True,
                "params": {
                    "subjectGlob": "sub-*",
                    "outDir": "${paths.outputDir}/structural",
                },
            },
            "final": {
                "enabled": True,
                "params": {
                    "rscriptExecutable": "${tools.rscriptExecutable}",
                    "outDir": "${paths.outputDir}/final",
                    "renderReport": True,
                },
            },
        },
        "pybrain": {
            "modelPath": str(root / "models" / "ExtraTreesModel"),
            "scalerPath": str(root / "models" / "scaler.pkl"),
        },
        "outputs": {
            "rootDir": str(output),
            "runDir": str(output),
            "manifestPath": str(output / "manifest.json"),
        },
        "provenance": {"configSha256": "", "runId": ""},
    }


def write_inputs(
    root: Path, rawdata: Path, *, brainfov: bool = False
) -> dict[str, Any]:
    """Write the raw data, metadata, models, registry and project file."""
    from supraspina_sidecar.registry_store import RegistryStore  # noqa: PLC0415

    for index, (subject, *_rest) in enumerate(SUBJECTS):
        _write(
            rawdata / subject / "anat" / f"{subject}_T1w.nii.gz",
            _nifti(index) if brainfov else f"synthetic T1 placeholder for {subject}\n",
        )
    metadata = root / "metadata"
    _write_rows(
        metadata / "age.csv",
        ["participant_id", "age"],
        [[s, age] for s, _label, age, _sex, _ais in SUBJECTS],
    )
    _write_rows(
        metadata / "clinical.csv",
        ["participant_id", "Cohort", "AIS"],
        [
            [s, CLINICAL_COHORT[label], ais or "control"]
            for s, label, _age, _sex, ais in SUBJECTS
        ],
    )
    _write_rows(
        metadata / "metadata.csv",
        ["participant_id", "Cohort"],
        [[s, FINAL_COHORT[label]] for s, label, _age, _sex, _ais in SUBJECTS],
    )
    _write(root / "models" / "ExtraTreesModel", b"synthetic model bytes\n")
    _write(root / "models" / "scaler.pkl", b"synthetic scaler bytes\n")
    store = RegistryStore(str(root))
    for subject, label, age, sex, ais in SUBJECTS:
        store.upsert(
            {
                "subjectId": subject,
                "age": age,
                "sex": sex,
                "sourceCohortLabel": label,
                "ais": ais,
                "tSinceSci": None if ais is None else 3.0,
            }
        )
    cfg = project_config(root, rawdata, brainfov=brainfov)
    _write(root / PROJECT_FILE, json.dumps(cfg, indent=2) + "\n")
    return cfg


class _Emitter:
    """Collect notifications; the manager runs without a supervisor."""

    def __init__(self) -> None:
        self.events: list[tuple[str, Any]] = []

    def emit(self, method: str, params: Any) -> None:
        self.events.append((method, params))


def _request(root: Path, cfg: dict[str, Any]) -> dict[str, Any]:
    config_path = str(root / PROJECT_FILE)
    return {
        "project": {
            "projectId": "project-"
            + hashlib.sha256(config_path.encode()).hexdigest()[:24],
            "root": str(root),
            "configPath": config_path,
            "epoch": 1,
        },
        "cfg": cfg,
        "configRevision": 0,
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "acknowledgements": {
            "includeDeferredAndUnreviewedQc": True,
            "acknowledgeMemoryAdvisory": False,
        },
    }


def _manager() -> Any:
    from supraspina_sidecar.adapters.base import ADAPTERS  # noqa: PLC0415
    from supraspina_sidecar.adapters.pybrainage import (  # noqa: PLC0415
        PyBrainAgeAdapter,
    )
    from supraspina_sidecar.workflow_manager import WorkflowManager  # noqa: PLC0415

    current = threading.local()

    def spawn(argv: list[str]) -> Any:
        node, ctx = current.node, current.ctx
        step, subject = node["stepKey"], node.get("subjectId")
        adapter = ADAPTERS[step]
        if step == "brainfov":
            _run_brainfov_helper(list(argv))
        elif step == "recon":
            _write_recon(adapter, ctx.effective_cfg, str(subject))
        else:
            WRITERS[step](adapter, ctx.effective_cfg)
        return subprocess.Popen(
            ["/bin/true"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )

    # PyBrainAge revalidates its provisioned environment right before launch;
    # the synthetic run has none, and the planner never reads it.
    PyBrainAgeAdapter.execution_lease = lambda _self, _cfg, _subject: nullcontext()
    manager = WorkflowManager(_Emitter(), spawn=spawn)
    original = manager._execute_inner

    def execute(ctx: Any, node_id: str, job_id: str, cancel_event: Any) -> None:
        current.node = next(n for n in ctx.state["nodes"] if n["nodeId"] == node_id)
        current.ctx = ctx
        original(ctx, node_id, job_id, cancel_event)

    manager._execute_inner = execute
    manager.authorizations.consume = lambda *_args, **_kwargs: None
    return manager


def _run_once(root: Path, cfg: dict[str, Any]) -> dict[str, Any]:
    """Plan Run all, run it to the end, and return its final state."""
    from supraspina_sidecar.run_store import RunStore  # noqa: PLC0415

    manager = _manager()
    try:
        request = _request(root, cfg)
        planned = manager.plan(request)
        plan = planned["plan"]
        request["approvedPlan"] = {"planId": plan["planId"], "digest": plan["digest"]}
        request["liveExecutionAuthorization"] = {"planDigest": plan["digest"]}
        started = manager.run(request)
        deadline = time.monotonic() + 300
        while manager.active_counts() != (0, 0):
            if time.monotonic() > deadline:
                raise TimeoutError("The synthetic run did not finish in 300 s.")
            time.sleep(0.2)
        return RunStore(str(root)).load(str(started["runId"]))
    finally:
        manager.shutdown()


def generate(root: Path, rawdata: Path, *, brainfov: bool = False) -> dict[str, Any]:
    """Create the project, run every stage once, and replan it.

    With Brain FOV preparation on, Reconstruction plans only once a
    preparation is published, so a first run prepares every T1 and a second
    runs everything else, as on a host.
    """
    install_environment_normalization()
    install_synthstrip_stand_in()
    cfg = write_inputs(root, rawdata, brainfov=brainfov)
    states = [_run_once(root, cfg) for _pass in range(2 if brainfov else 1)]
    state = states[-1]
    failed = [
        (node["stepKey"], node.get("subjectId"), node.get("reason"))
        for node in state["nodes"]
        if node["status"] not in {"done", "skipped"}
    ]
    replan_manager = _manager()
    try:
        replanned = replan_manager.plan(_request(root, cfg))
    finally:
        replan_manager.shutdown()
    return {
        "runId": state["runId"],
        "runIds": [item["runId"] for item in states],
        "runStatus": state.get("status"),
        "receipts": sum(len(item.get("receipts", [])) for item in states),
        "notDone": failed,
        "replanDisposition": replanned["disposition"],
        "replanSummary": replanned["summary"]["message"],
    }


def main(argv: list[str] | None = None) -> int:
    """Generate the synthetic project and print a JSON summary."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--rawdata", required=True, type=Path)
    parser.add_argument(
        "--brainfov", action="store_true", help="Also run Brain FOV preparation."
    )
    args = parser.parse_args(argv)
    summary = generate(args.root, args.rawdata, brainfov=args.brainfov)
    print(json.dumps(summary, indent=2))
    return 0 if not summary["notDone"] and summary["replanDisposition"] == "noop" else 1


if __name__ == "__supraspina_preload__":
    # Loaded by scripts/plan-replica.py --preload before a source sidecar.
    emulate_packaged_build()
    install_environment_normalization()
    install_synthstrip_stand_in()
elif __name__ == "__main__":
    emulate_packaged_build()
    sys.exit(main())
