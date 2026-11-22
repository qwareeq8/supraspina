"""Tests for the run preflight.

A step whose required tools are missing never launches: the default
``Adapter.validate`` gate reports the missing tools as blocking, and the
workflow planner then plans the step as blocked, so no subprocess starts. The
tests cover the ``missing_required_checks`` helper, that gate, and the
required-check contract between the adapters, the environment report, and the
renderer's ``STEP_CHECK_REQUIREMENTS`` mirror.
"""

from __future__ import annotations

import re
from pathlib import Path

from supraspina_sidecar.adapters import ADAPTERS
from supraspina_sidecar.adapters.base import (
    Adapter,
    StepStatus,
    missing_required_checks,
)
from supraspina_sidecar.env import _asset_source_applies, check
from supraspina_sidecar.env.r import _render_report_enabled


def _env(status_by_id: dict[str, str]) -> dict[str, object]:
    """Build a minimal ``EnvReport`` with one group carrying the given checks."""
    return {
        "capturedAt": "t",
        "groups": [
            {
                "name": "Tools",
                "checks": [
                    {"id": cid, "label": cid.upper(), "status": st}
                    for cid, st in status_by_id.items()
                ],
            }
        ],
    }


class _GatedAdapter(Adapter):
    """Require the ``reconall`` environment check for this test adapter."""

    key = "recon"
    required_checks = ("reconall",)

    def param_schema(self) -> dict[str, dict[str, object]]:
        return {}

    def build_command(self, cfg: dict[str, object], subject_id: str | None):
        return ["echo", subject_id or "cohort"]

    def detect(self, cfg: dict[str, object], subject_id: str | None) -> StepStatus:
        return StepStatus(state="pending")


# -- missing_required_checks ---------------------------------------------------


def test_missing_required_checks_empty_when_all_found() -> None:
    env = _env({"reconall": "found", "fshome": "found"})
    assert missing_required_checks(env, ("reconall", "fshome")) == []


def test_missing_required_checks_reports_missing_and_absent() -> None:
    env = _env({"reconall": "missing"})
    reasons = missing_required_checks(env, ("reconall", "fshome"))
    assert len(reasons) == 2
    assert any("RECONALL" in r and "missing" in r for r in reasons)
    assert any("fshome" in r and "not detected" in r for r in reasons)


def test_missing_required_checks_no_requirements() -> None:
    assert missing_required_checks(_env({}), ()) == []


# -- Default Adapter.validate --------------------------------------------------


def test_base_validate_blocks_on_missing_required_check() -> None:
    result = _GatedAdapter().validate({}, _env({"reconall": "missing"}))
    assert result.blocking
    assert not result.advisory


def test_base_validate_passes_when_required_checks_found() -> None:
    assert _GatedAdapter().validate({}, _env({"reconall": "found"})).blocking == []


# -- Required-tool contract: the renderer mirror must match the adapters -------


def test_real_adapters_declare_expected_required_checks() -> None:
    expected = {
        "age": ("agepython",),
        "aggregate": ("aggregatepython", "aggregate_assets"),
        "brainpad": ("brainpadpython", "brainpad_assets"),
        "clinical": ("clinicalpython",),
        # Exercise backend-conditional FreeSurfer requirements through
        # ``required_check_ids`` in the Features adapter tests.
        "features": ("features_assets",),
        "final": ("finalrscript", "final_assets"),
        "outliers": ("rscript", "outliers_assets"),
        "pybrainage": (
            "pyenv",
            "pybrainpython",
            "modelfile",
            "scalerfile",
            "pybrainage_assets",
        ),
        "recon": ("reconall", "fshome", "license"),
    }
    for key, checks in expected.items():
        declared = (
            ADAPTERS[key].required_check_ids({})
            if key == "recon"
            else tuple(ADAPTERS[key].required_checks)
        )
        assert declared == checks
    # Declare no hard requirement for intentionally ungated steps. Let ENIGMA
    # gate itself through custom backend validation.
    for key in ("deface", "enigma"):
        assert tuple(ADAPTERS[key].required_checks) == ()


def test_required_check_ids_exist_in_env_report(tmp_path) -> None:
    report = check({"paths": {"projectRoot": str(tmp_path)}, "tools": {}})
    known = {c["id"] for g in report["groups"] for c in g["checks"]}
    for adapter in ADAPTERS.values():
        for check_id in adapter.required_check_ids({}):
            assert check_id in known, (
                f"Provide a probe for environment check {check_id!r} required by "
                f"{adapter.key}."
            )


def test_step_required_checks_ts_mirror_matches_adapters() -> None:
    """Mirror each static adapter requirement in the renderer's all-of requirements."""
    steps_ts = (
        Path(__file__).resolve().parents[2] / "src" / "shared" / "steps.ts"
    ).read_text()
    block = re.search(
        r"STEP_CHECK_REQUIREMENTS[^=]*=\s*\{(.*?)\n\}",
        steps_ts,
        re.DOTALL,
    )
    assert block, "Define STEP_CHECK_REQUIREMENTS in steps.ts."
    ts_map: dict[str, tuple[str, ...]] = {}
    py_map = {
        key: tuple(adapter.required_checks)
        for key, adapter in ADAPTERS.items()
        if adapter.required_checks
    }
    for key in py_map:
        section = re.search(
            rf"\n  {key}:\s*\[(.*?)(?=\n  \w+:\s*\[|\Z)",
            block.group(1),
            re.DOTALL,
        )
        assert section, f"Include {key} in STEP_CHECK_REQUIREMENTS."
        all_of = re.search(
            r"kind:\s*'all'.*?ids:\s*\[([^\]]*)\]",
            section.group(1),
            re.DOTALL,
        )
        assert all_of, f"Give {key} an all-of requirement."
        ts_map[key] = tuple(re.findall(r"'([^']+)'", all_of.group(1)))
    assert ts_map == py_map


def test_final_report_requirement_ts_mirror_reads_the_same_default() -> None:
    """Read an absent ``renderReport`` as the declared default on both sides.

    This gate reads an absent value as ``True``, so the renderer's declaration
    must not read it as "only an explicit true".
    """
    steps_ts = (
        Path(__file__).resolve().parents[2] / "src" / "shared" / "steps.ts"
    ).read_text()
    section = re.search(r"\n  final:\s*\[(.*?)\n  \],", steps_ts, re.DOTALL)
    assert section, "Include final in STEP_CHECK_REQUIREMENTS."
    conditional = re.search(
        r"kind:\s*'conditional',\s*when:\s*'([^']+)',\s*ids:\s*\[([^\]]*)\]",
        section.group(1),
        re.DOTALL,
    )
    assert conditional, "Give final a conditional report requirement."
    assert conditional.group(1) == "steps.final.params.renderReport !== false"
    report_ids = tuple(re.findall(r"'([^']+)'", conditional.group(2)))
    declared = re.search(
        r"renderReport:\s*\{\s*kind:\s*'bool',\s*default:\s*(true|false),",
        steps_ts,
    )
    assert declared, "Declare the Final renderReport parameter in steps.ts."
    adapter = ADAPTERS["final"]
    assert declared.group(1) == "true"
    assert adapter.param_schema()["renderReport"]["default"] is True

    def final_cfg(params: dict[str, object] | None) -> dict[str, object]:
        if params is None:
            return {}
        return {"steps": {"final": {"enabled": True, "params": params}}}

    tables_only = adapter.required_check_ids(final_cfg({"renderReport": False}))
    assert tables_only == ("finalrscript", "final_assets")
    for params in (None, {}, {"renderReport": True}):
        cfg = final_cfg(params)
        assert adapter.required_check_ids(cfg) == tables_only + report_ids
        assert _render_report_enabled(cfg) is True
        assert _asset_source_applies(cfg, "final_report_assets") is True
    disabled = final_cfg({"renderReport": False})
    assert _render_report_enabled(disabled) is False
    assert _asset_source_applies(disabled, "final_report_assets") is False
