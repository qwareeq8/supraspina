"""Tests for the pinned scientific baseline and approved deface-to-Recon exception."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

from supraspina_sidecar import resources, scientific_assets
from supraspina_sidecar.adapters import ADAPTERS
from supraspina_sidecar.adapters.deface import DefaceAdapter
from supraspina_sidecar.adapters.recon import ReconAdapter
from supraspina_sidecar.cohort import CohortSnapshot, T1Resolution
from supraspina_sidecar.provenance import BASELINE, OUTPUT_SCHEMA
from supraspina_sidecar.results import _expected
from supraspina_sidecar.workflow import runtime_cfg
from tests.acquired_assets import acquired_resource_root

_REPRESENTATIVE_ROOT = "/__SUPRASPINA_BASELINE_ROOT__"

# Pin each reviewed normalized JSON argv by SHA-256. Snapshot every element,
# byte, and ordering decision without duplicating inline programs.
BASELINE_COMMAND_SHA256 = {
    "age": "fb96bb4c9ee97b0411eb9cb34bd8ac438863a7da2e0cc18490dcb4e9c2fd5fc4",
    "aggregate": "1425187991f52842b2fc6146c4b50c5525c2d4a21d2d9e6276a0380abbae966f",
    "brainpad": "0a885d3ad1d56d4cdb643619aa14d8146c01f82e2c6abca3f53dd88b4e768abc",
    "clinical": "e0235cb3812dce6785830e0499fb188a51798e5946fb3ea4da0521cb2b916885",
    "deface": "770b4509125849b0fd9995c3c62d4acf52ad9099861cfc6bef3466552bc326f1",
    "enigma": "b708a652041f84dcf62885a7d64fc88361bec7244ba7dcf45a71fc0a40788afd",
    "features": "0474a756c066ec808f6054451af2f39c0296e66bb97b6cf8c73de75a71f57a80",
    "final": "14bac37ea24ffa7d0818c5b682133097227af63b22c0de5bf233ac87f920b77b",
    "outliers": "5ff6997ff6e453a7c90873569c44a305772f647a5d15b5a189a0b6ae5be07046",
    "pybrainage": "cf23f75202a00221e04c336d98fdcd1a5e3b63e3e1677fc2cf0384645441475a",
    "recon": "8e4ad265d72eab03e350845041813f3134f044f71a0f3211449eb3a827bce75b",
}

BASELINE_DECLARATION_SHA256 = (
    "520022ccb95cfa7ec0ac7d481209d21201001614f1da4661777f3910c34af62d"
)

UPSTREAM_RESOURCE_MANIFEST_SHA256 = (
    "31a1b5b620e1f39929731dc4c1831b763d7c25f18623a97ba015577bc58f1e61"
)

APPROVED_CURRENT_RESOURCE_PATH_CONTENT_SHA256 = (
    "7afce2e38ab3fe14d2179865e4892185273e08523f0129bd75fbea47fd0ec306"
)

# Keep the local-start tree apart from the font change: the immutable
# local-start baseline holds locally converted TTF files, while the source
# release carries the exact upstream OTF files.
LOCAL_START_FONT_BLOBS = {
    "resources/fonts/lmroman10-bold.ttf": ("5b714518b4d3773f0fee1ff4208cd4b3e4912041"),
    "resources/fonts/lmroman10-bolditalic.ttf": (
        "db613a086a07b1995ac47b8694b0c0a9cf2921e2"
    ),
    "resources/fonts/lmroman10-italic.ttf": (
        "0091158587f26523d4df08af7fea3babcbb571b3"
    ),
    "resources/fonts/lmroman10-regular.ttf": (
        "3340a85b91af1c5db1f0a9792fb5af0c1c716d62"
    ),
}

CURRENT_UPSTREAM_FONT_BLOBS = {
    "resources/fonts/lmroman10-bold.otf": ("7d6afa73e1deec7e4603cdb2bca5152f73a7b76d"),
    "resources/fonts/lmroman10-bolditalic.otf": (
        "98297be4f968a7cfd1db445ab872003c174275c4"
    ),
    "resources/fonts/lmroman10-italic.otf": (
        "b369873788610a67d52a6cf58e2e9c769f3a7ab6"
    ),
    "resources/fonts/lmroman10-regular.otf": (
        "6a96b468286d83fd759dce5c95030d1a4e2aa67d"
    ),
}

# Treat these argv snapshots as local-start baselines because upstream contains
# no runnable equivalent. Do not represent them as upstream claims.
LOCAL_START_ONLY_COMMAND_STEPS = ("deface", "age", "clinical")


def _resource_manifest() -> dict[str, Any]:
    path = Path(__file__).parent / "fixtures" / "upstream-resource-blobs.json"
    encoded = path.read_bytes()
    assert hashlib.sha256(encoded).hexdigest() == UPSTREAM_RESOURCE_MANIFEST_SHA256
    return json.loads(encoded)


def _git_blob_sha1(content: bytes) -> str:
    header = f"blob {len(content)}\0".encode()
    return hashlib.sha1(header + content, usedforsecurity=False).hexdigest()


def _representative_cfg() -> dict[str, Any]:
    root = _REPRESENTATIVE_ROOT
    return {
        "paths": {
            "projectRoot": root,
            "rawdataDir": f"{root}/rawdata",
            "derivativesDir": f"{root}/derivatives",
            "outputDir": f"{root}/outputs/run",
            "metadataDir": f"{root}/metadata",
            "ageMetadataFile": f"{root}/metadata/age.csv",
            "clinicalMetadataFile": f"{root}/metadata/clinical.csv",
            "qcOutputDir": f"{root}/outputs/run/qc",
        },
        "tools": {
            "freesurferHome": "/opt/freesurfer/8.2.0",
            "freesurferLicense": "/opt/freesurfer/license.txt",
            "pythonExecutable": "/opt/supraspina/python",
            "rscriptExecutable": "/opt/R/bin/Rscript",
            "matlabExecutable": "/opt/MATLAB/bin/matlab",
            "mcrRoot": "/opt/MATLAB/MCR",
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "runtime": {"threads": 6},
        "pybrain": {
            "modelPath": f"{root}/models/ExtraTreesModel",
            "scalerPath": f"{root}/models/scaler.pkl",
        },
        "steps": {
            "deface": {
                "enabled": False,
                "params": {"tool": "fsl_deface", "forceOverwrite": False},
            },
            "recon": {
                "enabled": True,
                "params": {"directives": "-all", "parallel": True},
            },
            "enigma": {
                "enabled": True,
                "params": {
                    "backend": "matlab",
                    "matlabExecutable": "/opt/MATLAB/bin/matlab",
                    "enigmaScriptDir": f"{root}/enigma",
                    "outDir": f"{root}/outputs/run/qc",
                    "fsVersion": "7",
                    "noDesktop": True,
                },
            },
            "outliers": {
                "enabled": True,
                "params": {"zThreshold": 2.698},
            },
            "features": {
                "enabled": True,
                "params": {
                    "parcellation": "aparc.a2009s",
                    "measure": "thickness",
                    "outDir": f"{root}/outputs/run/features",
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
                    "pythonExecutable": "/opt/pybrainage/bin/python",
                    "modelPath": f"{root}/models/ExtraTreesModel",
                    "scalerPath": f"{root}/models/scaler.pkl",
                    "rowFallback": True,
                },
            },
            "clinical": {
                "enabled": True,
                "params": {
                    "joinKey": "participant_id",
                    "requiredColumns": "Cohort,AIS,Time since SCI (years)",
                    "cohortLabels": "control,SCI_nNP,SCI_P",
                },
            },
            "brainpad": {
                "enabled": True,
                "params": {
                    "groupingVar": "Cohort",
                    "covariates": "Age,Sex",
                    "plotEngine": "matplotlib",
                    "outDir": f"{root}/outputs/run/analysis",
                },
            },
            "aggregate": {
                "enabled": True,
                "params": {
                    "subjectGlob": "sub-*",
                    "outDir": f"{root}/outputs/run/structural",
                    "metrics": "thickness,volume,area,curv",
                },
            },
            "final": {
                "enabled": True,
                "params": {
                    "rscriptExecutable": "/opt/R/bin/Rscript",
                    "outDir": f"{root}/outputs/run/final",
                    "renderReport": True,
                },
            },
        },
    }


def _normalized_argv(step_key: str, cfg: dict[str, Any]) -> list[str]:
    subject_id = "sub-001" if step_key in {"deface", "recon"} else None
    # Acquired and first-party directories resolve under different roots.
    roots = (str(resources.resource_root()), str(resources.application_resource_root()))
    normalized = []
    for value in ADAPTERS[step_key].build_command(cfg, subject_id):
        text = value
        for root in roots:
            text = text.replace(root, "<RESOURCES>")
        normalized.append(text.replace(sys.executable, "<PYTHON>"))
    return normalized


def _command_digests() -> dict[str, str]:
    cfg = _representative_cfg()
    digests: dict[str, str] = {}
    previous_display = os.environ.get("DISPLAY")
    os.environ["DISPLAY"] = ":supraspina-baseline"
    try:
        for step_key in BASELINE_COMMAND_SHA256:
            encoded = json.dumps(
                _normalized_argv(step_key, cfg),
                ensure_ascii=True,
                separators=(",", ":"),
            ).encode()
            digests[step_key] = hashlib.sha256(encoded).hexdigest()
    finally:
        if previous_display is None:
            os.environ.pop("DISPLAY", None)
        else:
            os.environ["DISPLAY"] = previous_display
    return digests


def _cfg(root: Path, *, deface: bool, tool: str = "mri_deface") -> dict[str, Any]:
    return {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(root / "rawdata"),
            "derivativesDir": str(root / "derivatives"),
        },
        "tools": {"freesurferHome": "/opt/freesurfer/8.2.0"},
        "runtime": {"threads": 6},
        "steps": {
            "deface": {
                "enabled": deface,
                "params": {"tool": tool, "forceOverwrite": False},
            },
            "recon": {
                "enabled": True,
                "params": {"directives": "-all", "parallel": True},
            },
        },
    }


def _cohort(raw_t1: Path) -> CohortSnapshot:
    return CohortSnapshot(
        analysis_subject_ids=("sub-001",),
        selected_subject_ids=("sub-001",),
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(
            T1Resolution(
                "sub-001",
                "resolved",
                str(raw_t1),
                (str(raw_t1),),
                "fingerprint",
            ),
        ),
        qc_verdicts=(("sub-001", "pass"),),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )


def test_pinned_baseline_identity_is_not_rewritten() -> None:
    assert BASELINE == {
        "upstreamCommit": "8a8c2d3586a37bb896bd8bdc3743b43e602827e3",
        "resourcesTree": "2cbef5bb3f11ce4a545140deefe2bcb745cbe65d",
        "resourcesListingSha256": "5bb59e93810e8622f033f0d1aaed1de8f1c2ed953ec608ef30cb7db30802da81",
        "resourcesPathContentSha256": (
            "fc07fe555a199aa531169a35aba24d034013beac1c7a41a0cfc9f8e5c1ac4f4e"
        ),
        "adaptersTree": "f44c06d4fbe194d14e49033de1f1e6defe603a20",
        "adaptersListingSha256": "340708aa85d1fbeefcd68d906af1f958b0fcc72753c337c076f584b03a9d2c6f",
        "defaceStartSha256": "512068470d90a5b81a5989918f417ff20803830bc3a0958ca911bf8664a6ad61",
        "reconStartSha256": "4f8a05d095f5c22730d0a32b17674dbbe9aec1ba25acce1f6fed71c4723dde17",
    }


def test_all_adapter_commands_match_reviewed_snapshots() -> None:
    """Pin exact normalized argv for all 11 reviewed adapters."""
    assert _command_digests() == BASELINE_COMMAND_SHA256


def test_no_upstream_command_steps_are_labeled_local_start_only() -> None:
    assert LOCAL_START_ONLY_COMMAND_STEPS == ("deface", "age", "clinical")
    assert set(LOCAL_START_ONLY_COMMAND_STEPS) < set(BASELINE_COMMAND_SHA256)


def test_output_schema_identities_are_explicitly_pinned() -> None:
    assert OUTPUT_SCHEMA == {
        "deface": "nii-gz:defaced-t1:v1",
        "recon": "freesurfer:recon-tree:v1",
        "enigma": "enigma:measures-galleries:v1",
        "outliers": "enigma:outlier-csv-histograms:v1",
        "features": "csv:id-plus-187-features:v1",
        "age": "csv:id-age-plus-187-features:v1",
        "pybrainage": "csv:id-age-brainage-brainpad:v1",
        "clinical": "xlsx:clinical-brainpad:v1",
        "brainpad": "brainpad:tables-figures:v1",
        "aggregate": "structural:four-csv:v2",
        "final": "final:twelve-comparison-tables-sites-report:v2",
        "braincharts": "braincharts:zscores-split-summary:v1",
        "zstats": "zstats:eight-zscore-tables-report:v1",
    }


def test_declared_result_artifacts_match_pinned_contract() -> None:
    cfg = _representative_cfg()
    declarations: dict[str, list[dict[str, str]]] = {}
    for step_key in sorted(BASELINE_COMMAND_SHA256):
        subject_id = "sub-001" if step_key in {"deface", "recon"} else None
        declarations[step_key] = [
            {
                "label": item.label,
                "path": item.path.replace(_REPRESENTATIVE_ROOT, "<ROOT>"),
                "kind": item.kind,
            }
            for item in _expected(step_key, ADAPTERS[step_key], cfg, subject_id)
        ]
    encoded = json.dumps(
        declarations,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    assert hashlib.sha256(encoded).hexdigest() == BASELINE_DECLARATION_SHA256


def test_every_detector_rejects_an_empty_output_tree(tmp_path: Path) -> None:
    def relocate(value: Any) -> Any:
        if isinstance(value, str):
            return value.replace(_REPRESENTATIVE_ROOT, str(tmp_path))
        if isinstance(value, dict):
            return {key: relocate(item) for key, item in value.items()}
        if isinstance(value, list):
            return [relocate(item) for item in value]
        return value

    cfg = relocate(_representative_cfg())
    states = {
        step_key: adapter.detect(
            cfg,
            "sub-001" if step_key in {"deface", "recon"} else None,
        ).state
        for step_key, adapter in ADAPTERS.items()
    }
    assert states == {step_key: "pending" for step_key in ADAPTERS}


def test_cohort_view_changes_only_each_cohort_adapter_input_root() -> None:
    cfg = _representative_cfg()
    view_cfg = copy.deepcopy(cfg)
    cohort_view = f"{_REPRESENTATIVE_ROOT}/.supraspina/runs/run-baseline/cohort-view"
    view_cfg["_supraspinaRuntime"] = {
        "freesurferView": f"{cohort_view}/freesurfer",
        "cohortSubjectsFile": f"{cohort_view}/subjects.txt",
    }

    expected_flags = {
        "enigma": ("--fsdir", "--subjects"),
        "features": ("--subjects-dir",),
        "aggregate": ("--subjects-dir",),
    }
    for step_key, flags in expected_flags.items():
        baseline = _normalized_argv(step_key, cfg)
        projected = _normalized_argv(step_key, view_cfg)
        differing = [
            index
            for index, (before, after) in enumerate(
                zip(baseline, projected, strict=True)
            )
            if before != after
        ]
        expected_indexes = sorted(projected.index(flag) + 1 for flag in flags)
        assert differing == expected_indexes
        assert projected[
            projected.index("--subjects-dir" if step_key != "enigma" else "--fsdir") + 1
        ] == (f"{cohort_view}/freesurfer")
    enigma = _normalized_argv("enigma", view_cfg)
    assert enigma[enigma.index("--subjects") + 1] == f"{cohort_view}/subjects.txt"


def test_vendored_upstream_resource_manifest_is_complete_and_characterized() -> None:
    manifest = _resource_manifest()
    upstream = manifest["officialUpstream"]

    assert manifest["schemaVersion"] == 1
    assert upstream == {
        "repository": "https://github.com/ortizo-117/SCI_Map",
        "commit": BASELINE["upstreamCommit"],
        "rootTree": "af978285a2f22638e262ad190ecda71368e1574a",
        "subtrees": {
            "Step_1_Preprocessing": "d6ed3922321305d9696858216b02b66e8c75a58c",
            "Step_2_QA_ENIGMA": "d272d31625b3eae614d60d65882e921a36b20f01",
            "Step_2_QA_ENIGMA/ENIGMA_QC": ("a75c25c637c59454ccd81c397c78fb4a460b1e95"),
            "Step_2_QA_ENIGMA/compiled": ("b9bb464619da38f9954a541b0ce74aafa9c56d85"),
            "Step_2_QA_ENIGMA/histogram and outlier detection": (
                "5a675205d7332a90759cb986d0ad657b44b0d3b9"
            ),
            "Step_3_to_7_PyBrainAge": ("6cbcd4d3ade00684447cef9c7ffbc1e46f1964a3"),
            "Step_3_to_7_PyBrainAge/software": (
                "13df809dd552fe3c9a99f8490b1157b2f395202a"
            ),
            "Step_8_Data_Aggregation": ("184be31ffd207485c24f74222ee2c9aa8efd84c0"),
            "Step_9_R_Analysis": ("bc212f07eee45abae53670fdcb29085409f078ab"),
        },
    }
    assert len(manifest["exactLocalToUpstreamBlobs"]) == 229
    assert len(manifest["localOnlyOrReimplemented"]) == 12
    assert len(manifest["wrapperAdaptations"]) == 2
    assert len(manifest["upstreamCommandAndMethodSources"]) == 23

    upstream_paths = [
        item["upstreamPath"] for item in manifest["exactLocalToUpstreamBlobs"].values()
    ]
    assert len(set(upstream_paths)) == len(upstream_paths)
    for item in manifest["wrapperAdaptations"].values():
        assert item["localStartBlob"] != item["upstreamBlob"]
        assert item["allowedCompatibilityDiffClassification"] == (
            "pre_existing_local_start_compatibility_adaptation"
        )
        assert item["requiresSemanticGoldenFixture"] is True
        assert item["compatibilityChanges"]


def test_all_tracked_resource_modes_kinds_and_bytes_match_review() -> None:  # noqa: PLR0915
    """Verify only reviewed files and exclude ignored host bytecode caches."""
    manifest = _resource_manifest()
    checkout_root = Path(__file__).resolve().parents[2]

    expected_blobs = {
        path: item["blob"]
        for path, item in manifest["exactLocalToUpstreamBlobs"].items()
    }
    expected_blobs.update(
        {
            path: item["localStartBlob"]
            for path, item in manifest["localOnlyOrReimplemented"].items()
        }
    )
    expected_blobs.update(
        {
            path: item["localStartBlob"]
            for path, item in manifest["wrapperAdaptations"].items()
        }
    )
    start_blobs = dict(expected_blobs)
    start_blobs.update(LOCAL_START_FONT_BLOBS)
    assert len(start_blobs) == 247
    current_blobs = dict(expected_blobs)
    current_blobs.update(CURRENT_UPSTREAM_FONT_BLOBS)
    approved_changes = {
        path: item
        for path, item in manifest["localOnlyOrReimplemented"].items()
        if "approvedCurrentBlob" in item
    }
    approved_wrapper_changes = {
        path: item
        for path, item in manifest["wrapperAdaptations"].items()
        if "approvedCurrentBlob" in item
    }
    assert set(approved_changes) == {
        "resources/enigma/CHECKSUMS.sha256",
        "resources/enigma/outliers_qc.R",
        "resources/features/extract_features.py",
        "resources/figstyle/figstyle.R",
        "resources/figstyle/figstyle.py",
        "resources/pybrainage/predict.py",
        "resources/step7/brainpadstats.py",
        "resources/step8/aggregate_stats.py",
        "resources/step9/FreesurferAnalysisScript.R",
        "resources/step9/FreesurferAnalysisScript.Rmd",
    }
    assert set(approved_wrapper_changes) == {
        "resources/enigma/enigma_fs_wrapper_script.sh"
    }
    for item in (*approved_changes.values(), *approved_wrapper_changes.values()):
        assert item["approvedChange"]
        if item["requiresSemanticGoldenFixture"]:
            assert item["semanticGoldenTest"]
        else:
            assert "semanticGoldenTest" not in item
    removed = {
        path
        for path, item in manifest["localOnlyOrReimplemented"].items()
        if "approvedRemoval" in item
    }
    assert removed == {"resources/micromamba/README.md"}
    for path in removed:
        assert manifest["localOnlyOrReimplemented"][path]["approvedRemoval"]
        del current_blobs[path]
    for path, item in approved_changes.items():
        current_blobs[path] = item["approvedCurrentBlob"]
    for path, item in approved_wrapper_changes.items():
        current_blobs[path] = item["approvedCurrentBlob"]
    # Resources added after the local start have no start blob, so they stay
    # out of the start listing and enter only the reviewed current tree.
    added = manifest["addedAfterLocalStart"]
    assert set(added) == {"resources/braincharts/braincharts_run.py"}
    for path, item in added.items():
        assert item["approvedChange"]
        assert item["classification"] == "scientific_reimplementation"
        assert item["semanticGoldenTest"]
        assert "localStartBlob" not in item
        current_blobs[path] = item["approvedCurrentBlob"]

    # Rebuild the captured regular-file tree from the vendored path/blob fixture.
    # Keep this gate functional in shallow CI checkouts without the start commit.
    listing = b"".join(
        f"100644 blob {start_blobs[path]}\t{path}\n".encode()
        for path in sorted(start_blobs)
    )
    assert hashlib.sha256(listing).hexdigest() == BASELINE["resourcesListingSha256"]

    # The checkout holds only first-party files; every upstream file comes
    # from the acquired generation, which verified it against the pin.
    acquired = {
        **manifest["exactLocalToUpstreamBlobs"],
        **manifest["wrapperAdaptations"],
    }
    resources_root = checkout_root / "resources"
    current_paths = {
        path.relative_to(checkout_root).as_posix()
        for path in resources_root.rglob("*")
        if path.is_file()
        and "__pycache__" not in path.parts
        and path.suffix not in {".pyc", ".pyo"}
        and "resources/sidecar" not in path.as_posix()
        and path.name != "micromamba"
    }
    assert current_paths == set(current_blobs) - set(acquired)

    # Carry the executable bit exactly where the review grants one. The
    # compiled ENIGMA programs are reviewed as mode 0700 because the QC
    # launchers execute them directly; every other resource stays inert data.
    inventory = scientific_assets.load_inventory()["resourceFiles"]
    executable_paths = {
        relative for relative, record in inventory.items() if record["mode"] == "0700"
    }
    assert executable_paths == {
        "resources/enigma/compiled/FS_external_QC",
        "resources/enigma/compiled/func_make_corticalpngs_ENIGMA_QC",
        "resources/enigma/compiled/func_make_subcorticalFS_ENIGMA_QC",
    }

    generation_root = acquired_resource_root().parent
    path_content_digest = hashlib.sha256()
    for relative, expected_blob in sorted(current_blobs.items()):
        path = (generation_root if relative in acquired else checkout_root) / relative
        assert not path.is_symlink()
        assert path.is_file()
        content = path.read_bytes()
        assert _git_blob_sha1(content) == expected_blob
        content_sha = hashlib.sha256(content).hexdigest()
        if relative in acquired:
            assert content_sha == acquired[relative]["sha256"]
            assert stat.S_IMODE(path.stat().st_mode) == int(
                inventory[relative]["mode"], 8
            )
        else:
            assert not path.stat().st_mode & 0o111
        path_content_digest.update(f"{content_sha}  {relative}\n".encode())
    assert (
        path_content_digest.hexdigest() == APPROVED_CURRENT_RESOURCE_PATH_CONTENT_SHA256
    )


def test_supported_defacer_argv_snapshot_is_unchanged(tmp_path: Path) -> None:
    adapter = DefaceAdapter()
    expected = {
        "mri_deface": [
            "mri_deface",
            f"{tmp_path}/rawdata/sub-001/anat/sub-001_T1w.nii.gz",
            "/opt/freesurfer/8.2.0/average/talairach_mixed_with_skull.gca",
            "/opt/freesurfer/8.2.0/average/face.gca",
            f"{tmp_path}/derivatives/defaced/sub-001/anat/sub-001_T1w.nii.gz",
        ],
        "fsl_deface": [
            "fsl_deface",
            f"{tmp_path}/rawdata/sub-001/anat/sub-001_T1w.nii.gz",
            f"{tmp_path}/derivatives/defaced/sub-001/anat/sub-001_T1w.nii.gz",
        ],
        "pydeface": [
            "pydeface",
            f"{tmp_path}/rawdata/sub-001/anat/sub-001_T1w.nii.gz",
            "--outfile",
            f"{tmp_path}/derivatives/defaced/sub-001/anat/sub-001_T1w.nii.gz",
        ],
    }
    for tool, argv in expected.items():
        assert (
            adapter.build_command(_cfg(tmp_path, deface=True, tool=tool), "sub-001")
            == argv
        )


def test_disabled_deface_preserves_raw_recon_baseline_exactly(tmp_path: Path) -> None:
    raw_t1 = tmp_path / "rawdata" / "sub-001" / "anat" / "sub-001_T1w.nii.gz"
    effective = runtime_cfg(
        _cfg(tmp_path, deface=False),
        _cohort(raw_t1),
        "run-aabbccdd",
        str(tmp_path),
    )

    assert ReconAdapter().build_command(effective, "sub-001") == [
        "recon-all",
        "-subject",
        "sub-001",
        "-i",
        str(raw_t1),
        "-sd",
        str(tmp_path / "derivatives" / "freesurfer"),
        "-all",
        "-parallel",
        "-openmp",
        "6",
    ]


def test_enabled_deface_whitelists_only_recon_input_path_delta(tmp_path: Path) -> None:
    raw_t1 = tmp_path / "rawdata" / "sub-001" / "anat" / "sub-001_T1w.nii.gz"
    cohort = _cohort(raw_t1)
    disabled = ReconAdapter().build_command(
        runtime_cfg(
            _cfg(tmp_path, deface=False), cohort, "run-disabled", str(tmp_path)
        ),
        "sub-001",
    )
    enabled_cfg = _cfg(tmp_path, deface=True)
    enabled = ReconAdapter().build_command(
        runtime_cfg(enabled_cfg, cohort, "run-enabled", str(tmp_path)),
        "sub-001",
    )
    input_index = disabled.index("-i") + 1

    assert disabled[:input_index] == enabled[:input_index]
    assert disabled[input_index + 1 :] == enabled[input_index + 1 :]
    assert disabled[input_index] == str(raw_t1)
    assert enabled[input_index] == DefaceAdapter().output_path(enabled_cfg, "sub-001")


def test_skip_is_the_only_non_argv_deface_exception(tmp_path: Path) -> None:
    cfg = _cfg(tmp_path, deface=True, tool="skip")
    action = DefaceAdapter().execution_action(cfg, "sub-001")

    assert action.kind == "copy"
    assert action.argv == ()
    assert action.source == str(
        tmp_path / "rawdata" / "sub-001" / "anat" / "sub-001_T1w.nii.gz"
    )
    assert action.destination == str(
        tmp_path / "derivatives" / "defaced" / "sub-001" / "anat" / "sub-001_T1w.nii.gz"
    )
