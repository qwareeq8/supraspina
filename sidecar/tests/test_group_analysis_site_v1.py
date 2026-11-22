"""Tests for the v1 site check, and its invariance for site-free data."""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar.group_analysis import dataset, dataset_v2, store, worker
from supraspina_sidecar.group_analysis.manager import GroupAnalysisManager
from supraspina_sidecar.group_analysis.spec import (
    GroupAnalysisSpec,
    spec_digest,
    upgrade_v1,
)
from supraspina_sidecar.project import ProjectEpochs
from supraspina_sidecar.registry_store import RegistryStore
from tests.group_analysis_support import (
    SUBJECTS,
    example_spec,
    make_project,
    request,
)

_RESULT_ID = "gar-0123456789abcdef"


def _job(root: Path, cfg: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": worker.JOB_SCHEMA,
        "schemaVersion": 1,
        "resultId": _RESULT_ID,
        "specId": None,
        "name": "SCI vs CTRL",
        "projectRoot": str(root),
        "spec": spec,
        "context": {
            "cfg": cfg,
            "configRevision": 3,
            "registry": RegistryStore(str(root)).list(),
            "qc": {},
            "registration": [],
            "registrationKnown": True,
        },
        "stageCurrency": {"aggregate": "current", "pybrainage": "current"},
        # The pinned digests below cover this recorded product version.
        "productVersion": "1.3.0",
        "build": None,
    }


def _sha(value: Any) -> str:
    return hashlib.sha256(store.canonical_json(value).encode("utf-8")).hexdigest()


def _rounded(value: Any) -> Any:
    # Engine floats to 10 significant digits, so a BLAS kernel's last bit
    # cannot move the pin while any real change in the fit does.
    if isinstance(value, float):
        return float(f"{value:.10g}")
    if isinstance(value, dict):
        return {key: _rounded(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_rounded(item) for item in value]
    return value


def _compute(root: Path, cfg: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    out = io.StringIO()
    assert worker.run_job(_job(root, cfg, spec), out) == 0, out.getvalue()
    record = store.read_result(str(root), _RESULT_ID)
    assert record is not None
    return record


def _spec() -> dict[str, Any]:
    return example_spec(inference={"permutations": 1000, "seed": 20260923})


#: Digests of the site-free fixture's v1 result, pinned before the site check reached
#: the v1 path: everything but the fit, byte for byte, and the fit
#: to 10 significant digits.
PINNED_SPEC_DIGEST = "3ad1cd515825818f1e43282d37a2caeeb4dddd822efb369064d120ed51ef53f2"
PINNED_FRAME = "80b2befd437a180eb412ec6d818fe6e978a53dd06f230a2bf0ac4dd9a05d42d7"
PINNED_FIT = "4514fc1179fb6609c5880e8ec9fcdb71311c13399e4ceebe6e05612ea83f6acb"
PINNED_INPUTS = "4af10e11b50f9a5dd4446df5f87330b26a9dd31445bd5e18907708d0bdee4b47"
PINNED_STATE = "87b7000ce101adecfb05371cc71fa2ffc91e03b5ccd0c33ed0c9a35b1be3d4b9"


def _frame(record: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in record.items()
        if key not in {"createdAt", "resultSha256", "rows", "detail", "skipped"}
    }


def _fit(record: dict[str, Any]) -> dict[str, Any]:
    return _rounded(
        {
            "rows": record["rows"],
            "detail": record["detail"],
            "skipped": record["skipped"],
        }
    )


def test_a_site_free_project_keeps_its_v1_result_and_digests(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    spec = _spec()
    record = _compute(tmp_path, cfg, spec)
    context = dataset.AnalysisContext(
        project_root=str(tmp_path),
        cfg=cfg,
        config_revision=3,
        registry=tuple(RegistryStore(str(tmp_path)).list()),
    )
    parsed = GroupAnalysisSpec.model_validate(spec)
    inputs = dataset.resolve_inputs(context, parsed)

    assert inputs["designCheck"] is None

    assert record["specDigest"] == spec_digest(parsed) == PINNED_SPEC_DIGEST
    assert _sha(_frame(record)) == PINNED_FRAME
    assert _sha(_fit(record)) == PINNED_FIT
    assert _sha(inputs) == PINNED_INPUTS
    assert _sha(dataset.context_state(context, parsed)) == PINNED_STATE
    assert record["sample"]["issues"] == []


# -- Site check on the v1 path ---------------------------------------------------------

SITE = {"source": "registry", "column": "site"}
#: Prisma holds CTRL and SCI_P; Ingenia holds only the two SCI_nNP subjects.
INGENIA_SCI = {
    **{s[0]: "Prisma" for s in SUBJECTS if s[1] != "SCI_nNP"},
    **{s[0]: "Ingenia" for s in SUBJECTS if s[1] == "SCI_nNP"},
}
_BLOCK = {
    "code": "site-confounded",
    "severity": "blocking",
    "testId": "t1",
    "message": "Site Ingenia holds only SCI subjects in this test, so its group "
    "difference cannot be separated from the scanner. Leave out site Ingenia or "
    "adjust for site.",
    "fixes": [
        {"kind": "drop-level", "variable": SITE, "level": "Ingenia"},
        {"kind": "add-covariate", "variable": SITE},
    ],
}


def _set_sites(root: Path, sites: dict[str, str | None]) -> None:
    """Give the real registry store these sites (None leaves a subject unset)."""
    registry = RegistryStore(str(root))
    for subject_id, label, age, sex in SUBJECTS:
        site = sites.get(subject_id)
        registry.upsert(
            {
                "subjectId": subject_id,
                "age": age,
                "sex": sex,
                "sourceCohortLabel": label,
                "ais": None if label == "CTRL" else "A",
                "tSinceSci": None if label == "CTRL" else 4,
                **({"site": site} if site is not None else {}),
            }
        )


def _inputs(root: Path, cfg: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    return GroupAnalysisManager(ProjectEpochs()).inputs(request(root, cfg, spec=spec))


def _site_issues(check: dict[str, Any] | None) -> list[dict[str, Any]]:
    assert check is not None
    return [i for i in check["issues"] if i["code"] == "site-confounded"]


def _failure(root: Path, cfg: dict[str, Any], spec: dict[str, Any]) -> str:
    out = io.StringIO()
    assert worker.run_job(_job(root, cfg, spec), out) == 1
    assert store.read_result(str(root), _RESULT_ID) is None
    events = [json.loads(line) for line in out.getvalue().splitlines()]
    assert events[-1]["event"] == "failed"
    return str(events[-1]["message"])


def test_a_site_with_one_group_blocks_a_v1_comparison_as_v2_does(
    tmp_path: Path,
) -> None:
    cfg = make_project(tmp_path)
    _set_sites(tmp_path, INGENIA_SCI)
    spec = _spec()

    check = _inputs(tmp_path, cfg, spec)["designCheck"]

    assert check["ok"] is False
    assert _site_issues(check) == [_BLOCK]
    assert check["crosstabs"] == [
        {
            "testId": "t1",
            "rowVariable": "SCI vs CTRL",
            "columnVariable": "site",
            "rows": ["CTRL", "SCI"],
            "columns": ["Ingenia", "Prisma"],
            "counts": [[0, 5], [2, 3]],
            "cramersV": 0.5,
        }
    ]
    # The same finding, word for word, as the draft's spec v2 form gets.
    upgraded = upgrade_v1(GroupAnalysisSpec.model_validate(spec))
    v2 = _inputs(tmp_path, cfg, upgraded.model_dump(mode="json", by_alias=True))
    assert _site_issues(v2["designCheck"]) == _site_issues(check)
    assert _failure(tmp_path, cfg, spec) == _BLOCK["message"]


def test_adjusting_for_site_turns_the_v1_block_into_a_stated_warning(
    tmp_path: Path,
) -> None:
    cfg = make_project(tmp_path)
    _set_sites(tmp_path, INGENIA_SCI)
    spec = example_spec(
        covariates={"extra": [SITE]},
        inference={"permutations": 1000, "seed": 20260923},
    )
    warning = (
        "Site Ingenia holds only SCI subjects; with site as a covariate they "
        "inform the other covariates and the residual variance, not the group "
        "difference."
    )

    check = _inputs(tmp_path, cfg, spec)["designCheck"]
    record = _compute(tmp_path, cfg, spec)

    assert check["ok"] is True
    assert [(i["severity"], i["message"]) for i in _site_issues(check)] == [
        ("warning", warning)
    ]
    assert record["sample"]["issues"] == [warning]


def test_site_determining_group_blocks_a_v1_comparison_even_adjusted(
    tmp_path: Path,
) -> None:
    cfg = make_project(tmp_path)
    _set_sites(
        tmp_path, {s[0]: "Prisma" if s[1] == "CTRL" else "Ingenia" for s in SUBJECTS}
    )
    spec = example_spec(covariates={"extra": [SITE]})
    message = (
        "Site determines group for every subject, so the model cannot separate them."
    )

    check = _inputs(tmp_path, cfg, spec)["designCheck"]

    assert check["ok"] is False
    assert [(i["severity"], i["message"]) for i in _site_issues(check)] == [
        ("blocking", message)
    ]
    assert _failure(tmp_path, cfg, spec) == message


def test_subjects_without_a_site_form_one_level_with_a_warning(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    # The SCI_nNP subjects have no site: that level holds only SCI.
    _set_sites(tmp_path, {s[0]: "Prisma" for s in SUBJECTS if s[1] != "SCI_nNP"})

    check = _inputs(tmp_path, cfg, _spec())["designCheck"]

    assert check["issues"] == [
        {
            "code": "site-confounded",
            "severity": "warning",
            "testId": None,
            "message": "2 subjects have no site; the site check treats them as "
            "one site.",
        },
        {
            "code": "site-confounded",
            "severity": "blocking",
            "testId": "t1",
            "message": "Subjects without a site hold only SCI subjects in this "
            "test, so its group difference cannot be separated from the scanner. "
            "Leave out the subjects without a site or adjust for site.",
            "fixes": [{"kind": "add-covariate", "variable": SITE}],
        },
    ]


def test_compared_groups_check_only_the_compared_subjects(tmp_path: Path) -> None:
    cfg = make_project(tmp_path)
    # Ingenia holds only SCI_nNP, a group this comparison leaves out.
    _set_sites(tmp_path, INGENIA_SCI)
    spec = example_spec(
        contrast={
            "type": "groups",
            "grouping": {
                "variable": {"source": "registry", "column": "sourceCohortLabel"},
                "groups": [
                    {"label": "SCI_P", "levels": ["SCI_P"]},
                    {"label": "SCI_nNP", "levels": ["SCI_nNP"]},
                    {"label": "CTRL", "levels": ["CTRL"]},
                ],
            },
            "focal": "SCI_P",
            "reference": "CTRL",
            "model": "compared-groups",
        }
    )

    check = _inputs(tmp_path, cfg, spec)["designCheck"]

    assert check["ok"] is True
    assert check["issues"] == []
    assert [(c["rows"], c["columns"], c["counts"]) for c in check["crosstabs"]] == [
        (["CTRL", "SCI_P"], ["Prisma"], [[5], [3]])
    ]


def _association(*, adjust: bool) -> dict[str, Any]:
    return example_spec(
        analysis="association",
        contrast={
            "type": "association",
            "variable": {"source": "registry", "column": "age"},
            "grouping": {
                "variable": {"source": "registry", "column": "sourceCohortLabel"},
                "groups": [
                    {"label": "CTRL", "levels": ["CTRL"]},
                    {"label": "SCI", "levels": ["SCI_nNP", "SCI_P"]},
                ],
            },
            "includedGroups": ["CTRL", "SCI"],
            "adjustForGroup": adjust,
        },
        covariates={"age": None},
    )


@pytest.mark.parametrize("adjust", [True, False])
def test_an_association_is_checked_only_with_its_group_factor(
    tmp_path: Path, adjust: bool
) -> None:
    cfg = make_project(tmp_path)
    _set_sites(tmp_path, INGENIA_SCI)

    check = _inputs(tmp_path, cfg, _association(adjust=adjust))["designCheck"]

    blocks = [i["message"] for i in _site_issues(check) if i["severity"] == "blocking"]
    assert blocks == ([_BLOCK["message"]] if adjust else [])


def test_balanced_sites_leave_a_site_free_spec_byte_identical(tmp_path: Path) -> None:
    """Sites that confound nothing change no byte of a site-free spec's result."""
    plain = tmp_path / "plain"
    sited = tmp_path / "sited"
    cfg_plain = make_project(plain)
    cfg_sited = make_project(sited)
    # Both sites hold both groups.
    _set_sites(
        sited, {s[0]: "Prisma" if i % 2 else "Ingenia" for i, s in enumerate(SUBJECTS)}
    )
    spec = _spec()
    parsed = GroupAnalysisSpec.model_validate(spec)

    first = _compute(plain, cfg_plain, spec)
    second = _compute(sited, cfg_sited, spec)
    check = _inputs(sited, cfg_sited, spec)["designCheck"]

    assert _sha(_frame(second)) == _sha(_frame(first)) == PINNED_FRAME
    assert store.canonical_json(
        {key: second[key] for key in ("rows", "detail", "skipped")}
    ) == store.canonical_json(
        {key: first[key] for key in ("rows", "detail", "skipped")}
    )
    assert check["ok"] is True
    assert check["issues"] == []
    assert [row["columnVariable"] for row in check["crosstabs"]] == ["site"]
    # Currency: a site-free spec does not read the site, so its state holds.
    context = dataset.AnalysisContext(
        project_root=str(sited),
        cfg=cfg_sited,
        config_revision=3,
        registry=tuple(RegistryStore(str(sited)).list()),
    )
    assert _sha(dataset.context_state(context, parsed)) == PINNED_STATE
    assert spec_digest(parsed) == PINNED_SPEC_DIGEST


def test_registry_store_sites_reach_dataset_v2_and_the_design_check(
    tmp_path: Path,
) -> None:
    """Real ``RegistryStore`` records (unset sites listed as null) through v2."""
    cfg = make_project(tmp_path)
    sites = dict(INGENIA_SCI)
    sites["sub-01"] = None
    _set_sites(tmp_path, sites)
    listed = {
        r["subjectId"]: r.get("site") for r in RegistryStore(str(tmp_path)).list()
    }
    assert listed["sub-09"] == "Ingenia"
    assert listed["sub-01"] is None
    context = dataset.AnalysisContext(
        project_root=str(tmp_path),
        cfg=cfg,
        config_revision=3,
        registry=tuple(RegistryStore(str(tmp_path)).list()),
    )
    upgraded = upgrade_v1(GroupAnalysisSpec.model_validate(_spec()))

    resolved = dataset_v2.resolve(context, upgraded)
    check = dataset_v2.resolve_inputs(context, upgraded)["designCheck"]

    by_id = dict(zip(resolved.data.subject_ids, resolved.sites, strict=True))
    assert by_id["sub-01"] is None
    assert by_id["sub-09"] == by_id["sub-10"] == "Ingenia"
    assert by_id["sub-06"] == "Prisma"
    # The unset subject is a level of its own, holding only CTRL.
    assert [(i["severity"], i["testId"]) for i in _site_issues(check)] == [
        ("warning", None),
        ("blocking", "t1"),
        ("blocking", "t1"),
    ]
    assert _site_issues(check)[0]["message"].startswith("1 subject has no site")
    assert _site_issues(check)[1]["message"].startswith(
        "Subjects without a site hold only CTRL subjects"
    )
    assert _site_issues(check)[2] == _BLOCK
    # The v1 path reads the same store and reaches the same findings.
    v1 = _inputs(tmp_path, cfg, _spec())["designCheck"]
    assert _site_issues(v1) == _site_issues(check)
