"""Keep the renderer's zero-node plan restatement in step with the planner.

A plan with no nodes carries a summary the planner writes as an order. The
summary enters the plan digest, so the sidecar keeps the text and the renderer
restates it for display (``ZERO_NODE_PLAN_FACTS`` in
``src/renderer/state/execution-feedback.ts``), matching only the exact text.
If the planner's wording changes, the renderer would show the new text raw.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from supraspina_sidecar import workflow
from tests.test_workflow_policy_edges import _Adapter, _cfg, _request

_REPO_ROOT = Path(__file__).resolve().parents[2]


def _renderer_zero_node_facts() -> dict[str, str]:
    source = (
        _REPO_ROOT / "src" / "renderer" / "state" / "execution-feedback.ts"
    ).read_text(encoding="utf-8")
    block = re.search(
        r"const ZERO_NODE_PLAN_FACTS[^=]*= new Map\(\[(.*?)\n\]\)",
        source,
        re.DOTALL,
    )
    assert block, "Define ZERO_NODE_PLAN_FACTS in execution-feedback.ts."
    return dict(re.findall(r"\[\s*'([^']+)',\s*'([^']+)',?\s*\]", block.group(1)))


def test_zero_node_plan_summaries_match_the_renderer_restatement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = _cfg(tmp_path)
    monkeypatch.setitem(workflow.ADAPTERS, "recon", _Adapter())
    empty = {"mode": "explicit", "subjectIds": []}
    empty_workflow = workflow.build_plan(
        _request(tmp_path, cfg, {"kind": "workflow", "target": empty})
    )
    empty_stage = workflow.build_plan(
        _request(tmp_path, cfg, {"kind": "stage", "stepKey": "recon", "target": empty})
    )

    written = []
    for planned in (empty_workflow, empty_stage):
        assert planned.result["disposition"] == "noop"
        assert planned.result["plan"]["nodes"] == []
        message = planned.result["summary"]["message"]
        # The plan carries the same summary, which its digest covers.
        assert planned.result["plan"]["summary"]["message"] == message
        written.append(message)

    facts = _renderer_zero_node_facts()
    assert set(facts) == set(written)
    for fact in facts.values():
        assert fact.startswith("No work is scheduled: ")
