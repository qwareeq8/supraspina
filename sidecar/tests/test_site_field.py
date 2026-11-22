"""Tests for the registry site field.

The site is stored only when set, set in bulk by
``registry.setSite``, imported from an optional ``site`` column, summarized by
``sites.site_state``, required by the site-using stages when only some
subjects have one, and written into the Final metadata projection.
"""

from __future__ import annotations

import copy
import io
import json
import os
import re
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import registry_store as registry_store_module
from supraspina_sidecar import sites, workflow
from supraspina_sidecar import workflow_manager as runtime
from supraspina_sidecar.__main__ import build_dispatcher
from supraspina_sidecar.adapters.base import Validation
from supraspina_sidecar.cohort import CohortSnapshot
from supraspina_sidecar.final_r_contract import SITE_COLUMN
from supraspina_sidecar.operator_errors import OperatorError
from supraspina_sidecar.project import ProjectIdentity
from supraspina_sidecar.registry_store import RegistryStore
from supraspina_sidecar.rpc import Dispatcher, Emitter
from supraspina_sidecar.run_store import RunStore
from supraspina_sidecar.workflow import build_plan
from supraspina_sidecar.workflow_manager import WorkflowManager, _RunContext

_FIXED_TIME = "2026-09-30T00:00:00+00:00"
_HEADER = "subjectId,age,sex,sourceCohortLabel,ais,tSinceSci"
_CONFLICT = (
    "Use the existing site label Prisma; the two labels differ only in letter case."
)


@pytest.fixture(autouse=True)
def fixed_time(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(registry_store_module, "_now_iso", lambda: _FIXED_TIME)


def _record(subject_id: str, label: str = "CTRL", **extra: Any) -> dict[str, Any]:
    return {
        "subjectId": subject_id,
        "age": 40,
        "sex": "F",
        "sourceCohortLabel": label,
        "ais": None,
        "tSinceSci": None,
        **extra,
    }


def _stored(store: RegistryStore) -> dict[str, dict[str, Any]]:
    return json.loads(Path(store.path).read_text(encoding="utf-8"))["records"]


def _store(tmp_path: Path, *records: dict[str, Any]) -> RegistryStore:
    store = RegistryStore(str(tmp_path))
    for record in records:
        store.upsert(record)
    return store


def _revisions(store: RegistryStore, *subject_ids: str) -> dict[str, int]:
    stored = _stored(store)
    return {subject_id: stored[subject_id]["revision"] for subject_id in subject_ids}


# -- upsert ---------------------------------------------------------------------


def test_upsert_sets_keeps_and_clears_the_site(tmp_path: Path) -> None:
    store = _store(tmp_path, _record("sub-001", site="  Prisma "))
    assert _stored(store)["sub-001"]["site"] == "Prisma"

    # A caller that predates the field (no key) keeps the stored site.
    returned = store.upsert(_record("sub-001", "SCI_P"))
    assert returned["site"] == "Prisma"
    assert _stored(store)["sub-001"]["site"] == "Prisma"
    assert store.list()[0]["site"] == "Prisma"

    for cleared in (None, "", "   "):
        store.upsert(_record("sub-001", site="Prisma"))
        returned = store.upsert(_record("sub-001", site=cleared))
        assert returned["site"] is None
        assert "site" not in _stored(store)["sub-001"]
    assert store.list()[0]["site"] is None


def test_upsert_without_a_site_writes_the_same_bytes_as_before(
    tmp_path: Path,
) -> None:
    """Clearing a site leaves the bytes of a record that never had one."""
    plain = _store(tmp_path / "plain", _record("sub-001"), _record("sub-001"))
    cleared = _store(
        tmp_path / "cleared",
        _record("sub-001", site="Prisma"),
        _record("sub-001", site=None),
    )
    assert Path(plain.path).read_bytes() == Path(cleared.path).read_bytes()


@pytest.mark.parametrize("label", ["Prisma!", " -x", "x" * 65, 7, ["Prisma"]])
def test_upsert_refuses_a_label_outside_the_rule(tmp_path: Path, label: Any) -> None:
    store = _store(tmp_path, _record("sub-001"))
    before = Path(store.path).read_bytes()
    with pytest.raises(ValueError, match=r"^Use a site label of 1 to 64"):
        store.upsert(_record("sub-002", site=label))
    assert Path(store.path).read_bytes() == before


def test_the_renderer_states_the_case_collision_as_the_sidecar_does() -> None:
    """The form check and the mock refuse with the sidecar's exact sentence."""
    root = Path(__file__).resolve().parents[2] / "src" / "renderer"
    template = f"`{sites.site_conflict_message('${conflict}')}`"
    for relative in ("state/site-facts.ts", "ipc/mock.ts"):
        assert template in (root / relative).read_text(encoding="utf-8"), relative
    assert sites.site_conflict_message("Prisma") == _CONFLICT


def test_upsert_refuses_a_case_only_collision(tmp_path: Path) -> None:
    store = _store(tmp_path, _record("sub-001", site="Prisma"))
    before = Path(store.path).read_bytes()
    with pytest.raises(ValueError, match=f"^{re.escape(_CONFLICT)}$"):
        store.upsert(_record("sub-002", site="prisma"))
    assert Path(store.path).read_bytes() == before

    # The only record with the label may change its spelling.
    store.upsert(_record("sub-001", site="PRISMA"))
    assert _stored(store)["sub-001"]["site"] == "PRISMA"


# -- set_site -------------------------------------------------------------------


def test_set_site_writes_every_record_in_one_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = _store(tmp_path, _record("sub-001"), _record("sub-002"), _record("sub-003"))
    writes: list[int] = []
    original = RegistryStore._write

    def counting(self: RegistryStore, records: dict[str, Any]) -> None:
        writes.append(len(records))
        original(self, records)

    monkeypatch.setattr(RegistryStore, "_write", counting)
    result = store.set_site(
        ["sub-002", "sub-001"], " Ingenia ", _revisions(store, "sub-001", "sub-002")
    )

    assert result == {"site": "Ingenia", "updated": 2}
    assert writes == [3]
    stored = _stored(store)
    assert stored["sub-001"]["site"] == stored["sub-002"]["site"] == "Ingenia"
    assert stored["sub-001"]["revision"] == stored["sub-002"]["revision"] == 2
    assert "site" not in stored["sub-003"]
    assert stored["sub-003"]["revision"] == 1


def test_set_site_skips_records_that_already_hold_the_site(tmp_path: Path) -> None:
    store = _store(tmp_path, _record("sub-001", site="Prisma"), _record("sub-002"))
    before = Path(store.path).read_bytes()

    assert store.set_site(["sub-001"], "Prisma", {"sub-001": 1}) == {
        "site": "Prisma",
        "updated": 0,
    }
    assert store.set_site(["sub-002"], None, {"sub-002": 1}) == {
        "site": None,
        "updated": 0,
    }
    assert Path(store.path).read_bytes() == before

    result = store.set_site(
        ["sub-001", "sub-002"], "Prisma", {"sub-001": 1, "sub-002": 1}
    )
    assert result == {"site": "Prisma", "updated": 1}
    assert _revisions(store, "sub-001", "sub-002") == {"sub-001": 1, "sub-002": 2}


def test_set_site_clear_restores_the_bytes_of_a_record_without_a_site(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path, _record("sub-001"))
    store.set_site(["sub-001"], "Prisma", {"sub-001": 1})
    assert store.set_site(["sub-001"], None, {"sub-001": 2})["updated"] == 1

    plain = _store(tmp_path / "plain", _record("sub-001"))
    stored = _stored(store)["sub-001"]
    assert "site" not in stored
    assert {**stored, "revision": 1} == _stored(plain)["sub-001"]


def test_set_site_refuses_a_stale_record_atomically(
    tmp_path: Path,
) -> None:
    store = _store(tmp_path, _record("sub-001"), _record("sub-002"))
    before = Path(store.path).read_bytes()

    with pytest.raises(OperatorError, match="another writer changed this record"):
        store.set_site(["sub-001", "sub-002"], "Prisma", {"sub-001": 1, "sub-002": 0})
    # A subject without a record has revision 0; any other is stale.
    with pytest.raises(OperatorError, match="another writer changed this record"):
        store.set_site(["sub-001", "sub-404"], "Prisma", {"sub-001": 1, "sub-404": 1})
    assert Path(store.path).read_bytes() == before
    assert not Path(store.pending_path).exists()


# -- Sites held before registration --------------------------------------------


def test_set_site_holds_the_site_of_an_unregistered_subject_apart(
    tmp_path: Path,
) -> None:
    # A record needs sex and a cohort label, which a site must not invent, so
    # the site waits outside registry.json and its bytes stay as they were.
    store = _store(tmp_path, _record("sub-001"))
    before = Path(store.path).read_bytes()

    result = store.set_site(
        ["sub-001", "sub-new"], "Ingenia", {"sub-001": 1, "sub-new": 0}
    )
    assert result == {"site": "Ingenia", "updated": 2}
    assert _stored(store)["sub-001"]["site"] == "Ingenia"
    assert "sub-new" not in _stored(store)
    assert store.pending_sites() == {"sub-new": "Ingenia"}
    assert [row["subjectId"] for row in store.list()] == ["sub-001"]

    # A repeat writes nothing, and clearing the held site removes the file.
    assert store.set_site(["sub-new"], "Ingenia", {"sub-new": 0})["updated"] == 0
    assert store.set_site(["sub-new"], None, {"sub-new": 0})["updated"] == 1
    assert store.pending_sites() == {}
    assert not Path(store.pending_path).exists()

    plain = _store(tmp_path / "plain", _record("sub-001"))
    plain.set_site(["sub-001"], "Ingenia", {"sub-001": 1})
    assert Path(store.path).read_bytes() == Path(plain.path).read_bytes()
    assert before != Path(store.path).read_bytes()


def test_registration_adopts_a_held_site_unless_it_states_one(
    tmp_path: Path,
) -> None:
    store = RegistryStore(str(tmp_path))
    store.set_site(
        ["sub-001", "sub-002", "sub-003"],
        "Ingenia",
        {"sub-001": 0, "sub-002": 0, "sub-003": 0},
    )

    assert store.upsert(_record("sub-001"))["site"] == "Ingenia"
    assert store.upsert(_record("sub-002", site=None))["site"] is None
    assert store.pending_sites() == {"sub-003": "Ingenia"}

    result = store.import_csv(f"{_HEADER}\nsub-003,50,M,CTRL,,\n")
    assert result["applied"] is True
    assert _stored(store)["sub-003"]["site"] == "Ingenia"
    assert "site" not in _stored(store)["sub-002"]
    assert store.pending_sites() == {}
    assert not Path(store.pending_path).exists()


def test_held_sites_join_the_case_collision_check(tmp_path: Path) -> None:
    store = _store(tmp_path, _record("sub-001", site="Prisma"))
    with pytest.raises(ValueError, match=f"^{re.escape(_CONFLICT)}$"):
        store.set_site(["sub-new"], "PRISMA", {"sub-new": 0})
    assert store.pending_sites() == {}

    store.set_site(["sub-new"], "Ingenia", {"sub-new": 0})
    with pytest.raises(ValueError, match="existing site label Ingenia"):
        store.upsert(_record("sub-002", site="ingenia"))


def test_a_malformed_held_site_list_fails_closed(tmp_path: Path) -> None:
    store = _store(tmp_path, _record("sub-001"))
    Path(store.pending_path).write_text(
        json.dumps({"schemaVersion": 1, "sites": {"sub-new": " bad"}}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="Repair the held site list"):
        store.pending_sites()
    with pytest.raises(ValueError, match="Repair the held site list"):
        store.set_site(["sub-001"], "Prisma", {"sub-001": 1})


def test_set_site_refuses_case_collisions_but_renames_a_whole_site(
    tmp_path: Path,
) -> None:
    store = _store(
        tmp_path,
        _record("sub-001", site="Prisma"),
        _record("sub-002", site="Prisma"),
        _record("sub-003"),
    )
    with pytest.raises(ValueError, match=f"^{re.escape(_CONFLICT)}$"):
        store.set_site(["sub-003"], "PRISMA", {"sub-003": 1})

    result = store.set_site(
        ["sub-001", "sub-002", "sub-003"],
        "PRISMA",
        _revisions(store, "sub-001", "sub-002", "sub-003"),
    )
    assert result["updated"] == 3
    assert {record["site"] for record in _stored(store).values()} == {"PRISMA"}


@pytest.mark.parametrize(
    ("subject_ids", "revisions", "message"),
    [
        ([], {}, "Select 1 to 20,000 subjects"),
        ("sub-001", {"sub-001": 1}, "Select 1 to 20,000 subjects"),
        (["sub-001"] * 2, {"sub-001": 1}, "Name each subject once"),
        (["../x"], {"../x": 1}, "Select subjects with valid IDs"),
        ([7], {7: 1}, "Select subjects with valid IDs"),
        (["sub-001"], {}, "Provide the saved revision"),
        (["sub-001"], {"sub-001": True}, "Provide the saved revision"),
        (["sub-001"], {"sub-001": -1}, "Provide the saved revision"),
        (["sub-001"], {"sub-001": 1, "sub-002": 1}, "Provide the saved revision"),
        (["sub-001"], None, "Provide the saved revision"),
    ],
)
def test_set_site_validates_the_request_before_reading(
    tmp_path: Path, subject_ids: Any, revisions: Any, message: str
) -> None:
    store = _store(tmp_path, _record("sub-001"))
    with pytest.raises(ValueError, match=message):
        store.set_site(subject_ids, "Prisma", revisions)


def test_set_site_bounds_the_selection(tmp_path: Path) -> None:
    store = RegistryStore(str(tmp_path))
    ids = [f"sub-{index}" for index in range(sites.MAX_SET_SITE_SUBJECTS + 1)]
    with pytest.raises(ValueError, match="Select 1 to 20,000 subjects"):
        store.set_site(ids, "Prisma", dict.fromkeys(ids, 1))


def test_set_site_refuses_a_label_outside_the_rule(tmp_path: Path) -> None:
    store = _store(tmp_path, _record("sub-001"))
    with pytest.raises(ValueError, match=r"^Use a site label of 1 to 64"):
        store.set_site(["sub-001"], "Prisma/3T", {"sub-001": 1})


# -- import_csv -----------------------------------------------------------------


def test_import_sets_sites_and_keeps_them_without_a_site_column(
    tmp_path: Path,
) -> None:
    store = RegistryStore(str(tmp_path))
    result = store.import_csv(
        f"{_HEADER},site\nsub-001,40,F,CTRL,,,Prisma\nsub-002,50,M,SCI_P,B,2,\n"
    )
    assert result["applied"] is True
    stored = _stored(store)
    assert stored["sub-001"]["site"] == "Prisma"
    assert "site" not in stored["sub-002"]

    # Without the column, an update keeps every stored site.
    result = store.import_csv(
        f"{_HEADER}\nsub-001,41,F,CTRL,,\nsub-002,51,M,SCI_P,B,2\n", "update"
    )
    assert result["updated"] == 2
    stored = _stored(store)
    assert stored["sub-001"]["site"] == "Prisma"
    assert stored["sub-001"]["age"] == 41
    assert "site" not in stored["sub-002"]

    # A present empty cell clears the site; a set cell sets it.
    result = store.import_csv(
        "site,subjectId,age,sex,sourceCohortLabel\n"
        ",sub-001,41,F,CTRL\nIngenia,sub-002,51,M,SCI_P\n",
        "update",
    )
    assert result["applied"] is True
    stored = _stored(store)
    assert "site" not in stored["sub-001"]
    assert stored["sub-002"]["site"] == "Ingenia"


def test_import_skip_keeps_the_stored_site(tmp_path: Path) -> None:
    store = _store(tmp_path, _record("sub-001", site="Prisma"))
    result = store.import_csv(f"{_HEADER},site\nsub-001,40,F,CTRL,,,Ingenia\n")
    assert result["skipped"] == 1
    assert _stored(store)["sub-001"]["site"] == "Prisma"


def test_import_refuses_invalid_labels_and_case_collisions(tmp_path: Path) -> None:
    store = _store(tmp_path, _record("sub-001", site="Prisma"))
    before = Path(store.path).read_bytes()

    invalid = store.import_csv(f"{_HEADER},site\nsub-002,40,F,CTRL,,,Prisma!\n")
    assert invalid["applied"] is False
    assert invalid["errors"] == [{"row": 2, "message": sites.SITE_LABEL_RULE}]

    collision = store.import_csv(
        f"{_HEADER},site\nsub-002,40,F,CTRL,,,prisma\nsub-003,40,F,CTRL,,,Skyra\n"
    )
    assert collision["applied"] is False
    assert collision["errors"] == [{"row": 2, "message": _CONFLICT}]

    within = store.import_csv(
        f"{_HEADER},site\nsub-002,40,F,CTRL,,,Skyra\nsub-003,40,F,CTRL,,,SKYRA\n"
    )
    assert within["errors"] == [
        {
            "row": 3,
            "message": (
                "Use the existing site label Skyra; the two labels differ only "
                "in letter case."
            ),
        }
    ]
    assert Path(store.path).read_bytes() == before


def test_import_header_names_the_site_column(tmp_path: Path) -> None:
    result = RegistryStore(str(tmp_path)).import_csv(f"{_HEADER},scanner\n")
    assert result["errors"] == [
        {
            "row": 1,
            "message": (
                'Remove the unrecognized "scanner" column; the accepted columns '
                "are subjectId, age, sex, sourceCohortLabel, ais, tSinceSci, site."
            ),
        }
    ]


def test_import_example_sets_its_site(tmp_path: Path) -> None:
    source = (
        Path(__file__).resolve().parents[2] / "src" / "shared" / "registry-import.ts"
    ).read_text(encoding="utf-8")
    example = source.split("REGISTRY_IMPORT_EXAMPLE_CSV = `", 1)[1].split("`", 1)[0]
    store = RegistryStore(str(tmp_path))
    assert store.import_csv(example)["applied"] is True
    assert {row["site"] for row in store.list()} == {"Prisma"}


# -- site_state -----------------------------------------------------------------


def _row(subject_id: str, role: str, site: str | None = None) -> dict[str, Any]:
    row: dict[str, Any] = {"subjectId": subject_id, "cohortRole": role}
    if site is not None:
        row["site"] = site
    return row


def test_site_state_modes_and_counts() -> None:
    rows = [
        _row("sub-3", "healthy", "Prisma"),
        _row("sub-1", "sci-neuropathic-pain", "Ingenia"),
        _row("sub-2", "healthy", "Prisma"),
        {**_row("sub-4", "sci-no-neuropathic-pain"), "site": None},
    ]
    assert sites.site_state([]) == {"mode": "none", "unset": [], "sites": []}
    assert sites.site_state(rows[3:])["mode"] == "none"
    assert sites.site_state(rows[:3])["mode"] == "complete"

    state = sites.site_state(rows)
    assert state["mode"] == "mixed"
    assert state["unset"] == ["sub-4"]
    assert state["sites"] == [
        {
            "site": "Ingenia",
            "subjects": 1,
            "roles": {
                "healthy": 0,
                "sci-no-neuropathic-pain": 0,
                "sci-neuropathic-pain": 1,
                "ambiguous": 0,
            },
        },
        {
            "site": "Prisma",
            "subjects": 2,
            "roles": {
                "healthy": 2,
                "sci-no-neuropathic-pain": 0,
                "sci-neuropathic-pain": 0,
                "ambiguous": 0,
            },
        },
    ]


def test_site_state_restricts_to_the_requested_subjects() -> None:
    rows = [_row("sub-1", "healthy", "Prisma"), _row("sub-2", "healthy")]
    assert sites.site_state(rows, ["sub-1"])["mode"] == "complete"
    # A requested subject without a record counts as unset.
    state = sites.site_state(rows, ["sub-1", "sub-9", "sub-9"])
    assert (state["mode"], state["unset"]) == ("mixed", ["sub-9"])
    assert sites.site_state(rows, [])["mode"] == "none"


def test_site_state_roles_match_the_registry() -> None:
    assert set(sites.COHORT_ROLES) == registry_store_module._COHORT_ROLES


# -- planner --------------------------------------------------------------------


class _Adapter:
    def __init__(self, key: str) -> None:
        self.key = key

    def validate(self, _cfg: dict[str, Any], _env: dict[str, Any]) -> Validation:
        return Validation()

    def build_command(self, _cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        return [self.key, subject_id or "cohort"]

    def preview(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        return " ".join(self.build_command(cfg, subject_id))


_GROUPS = [
    ("sub-h1", "CTRL"),
    ("sub-h2", "CTRL"),
    ("sub-p1", "SCI_P"),
    ("sub-p2", "SCI_P"),
    ("sub-n1", "SCI_nNP"),
    ("sub-n2", "SCI_nNP"),
]


def _plan_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, sites_by_subject: dict[str, str]
) -> dict[str, Any]:
    root = tmp_path / "project"
    raw = root / "rawdata"
    for subject_id, label in _GROUPS:
        path = raw / subject_id / "anat" / f"{subject_id}_T1w.nii.gz"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(subject_id.encode())
        record = _record(subject_id, label)
        if subject_id in sites_by_subject:
            record["site"] = sites_by_subject[subject_id]
        RegistryStore(str(root)).upsert(record)
    monkeypatch.setattr(
        "supraspina_sidecar.workflow.ADAPTERS",
        {key: _Adapter(key) for key in ("clinical", "final")},
    )
    cfg = {
        "paths": {
            "projectRoot": str(root),
            "rawdataDir": str(raw),
            "derivativesDir": str(root / "derivatives"),
            "outputDir": str(root / "output"),
        },
        "patterns": {"subjectGlob": "sub-*", "t1Pattern": "*_T1w.nii.gz"},
        "subjects": {"include": [], "exclude": []},
        "runtime": {"dryRun": True},
        "steps": {
            "clinical": {"enabled": True, "params": {}},
            "final": {"enabled": True, "params": {}},
        },
    }
    return {
        "project": {
            "projectId": "site-project",
            "root": str(root),
            "configPath": str(root / "supraspina.project.json"),
            "epoch": 1,
        },
        "cfg": cfg,
        "configRevision": 1,
        "intent": {"kind": "workflow", "target": {"mode": "all"}},
        "acknowledgements": {"includeDeferredAndUnreviewedQc": True},
    }


def _nodes(request: dict[str, Any]) -> dict[str, dict[str, Any]]:
    planned = build_plan(request, run_id="run-00000000000a")
    return {node["stepKey"]: node for node in planned.result["plan"]["nodes"]}


def test_no_sites_plan_is_the_plan_without_the_site_rule(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = _plan_project(tmp_path, monkeypatch, {})
    with_rule = build_plan(copy.deepcopy(request), run_id="run-00000000000a")
    monkeypatch.setattr(workflow, "_SITE_STEPS", frozenset())
    without_rule = build_plan(copy.deepcopy(request), run_id="run-00000000000a")

    assert with_rule.result == without_rule.result
    assert with_rule.result["plan"]["blockers"] == []


def test_complete_sites_plan_final(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sites_by_subject = {subject_id: "Prisma" for subject_id, _ in _GROUPS}
    sites_by_subject["sub-p1"] = "Ingenia"
    nodes = _nodes(_plan_project(tmp_path, monkeypatch, sites_by_subject))
    assert nodes["final"]["status"] in {"planned", "waiting"}


def test_mixed_sites_block_final_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = _plan_project(tmp_path, monkeypatch, {"sub-p1": "Ingenia"})
    planned = build_plan(request, run_id="run-00000000000a")
    nodes = {node["stepKey"]: node for node in planned.result["plan"]["nodes"]}
    unset = ["sub-h1", "sub-h2", "sub-n1", "sub-n2", "sub-p2"]

    assert nodes["clinical"]["status"] in {"planned", "waiting"}
    assert nodes["final"]["status"] == "blocked"
    assert nodes["final"]["reason"] == (
        "Set a site for sub-h1, sub-h2, and 3 more subjects; some subjects have "
        "a site and these do not."
    )
    assert planned.result["plan"]["blockers"] == [
        {
            "key": "final",
            "reason": nodes["final"]["reason"],
            "kind": "cohort",
            "subjects": unset,
            "subjectCount": 5,
            "action": "open-registry",
        }
    ]


def test_site_steps_are_final_and_the_braincharts_stages() -> None:
    assert frozenset({"final", "braincharts", "zstats"}) == workflow._SITE_STEPS


@pytest.mark.parametrize(
    ("unset", "reason"),
    [
        (
            ["sub-1"],
            "Set a site for sub-1; some subjects have a site and this subject "
            "does not.",
        ),
        (
            ["sub-1", "sub-2"],
            "Set a site for sub-1 and sub-2; some subjects have a site and these "
            "do not.",
        ),
        (
            ["sub-1", "sub-2", "sub-3"],
            "Set a site for sub-1, sub-2, and sub-3; some subjects have a site and "
            "these do not.",
        ),
        (
            [f"sub-{index}" for index in range(1, 94)],
            "Set a site for sub-1, sub-10, and 91 more subjects; some subjects "
            "have a site and these do not.",
        ),
    ],
)
def test_mixed_site_blocker_names_the_unset_subjects(
    unset: list[str], reason: str
) -> None:
    registry = {subject_id: _row(subject_id, "healthy") for subject_id in unset}
    registry["sub-x"] = _row("sub-x", "healthy", "Ingenia")
    blocker = workflow._mixed_site_blocker((*unset, "sub-x"), registry)
    assert blocker is not None
    assert blocker.reason == reason
    assert list(blocker.subjects) == sorted(unset)


def test_mixed_site_blocker_ignores_none_and_complete() -> None:
    registry = {"sub-1": _row("sub-1", "healthy")}
    assert workflow._mixed_site_blocker(("sub-1",), registry) is None
    registry["sub-1"]["site"] = "Prisma"
    assert workflow._mixed_site_blocker(("sub-1",), registry) is None


# -- Final metadata projection --------------------------------------------------


class _Emitter:
    def emit(self, _method: str, _params: dict[str, Any]) -> None:
        return None


def _context(root: Path) -> _RunContext:
    subject_ids = ("sub-01", "sub-02")
    cohort = CohortSnapshot(
        analysis_subject_ids=subject_ids,
        selected_subject_ids=subject_ids,
        analysis_digest="analysis",
        selected_digest="selected",
        t1=(),
        qc_verdicts=tuple((subject_id, "pass") for subject_id in subject_ids),
        qc_acknowledged=False,
        excluded_by_config=(),
        excluded_by_qc=(),
    )
    identity = ProjectIdentity(
        "site-project",
        str(root.resolve()),
        str((root / "supraspina.project.json").resolve()),
        1,
    )
    return _RunContext(
        state={"runId": "run-site0000001", "inputProjections": []},
        cfg={},
        effective_cfg={},
        cohort=cohort,
        project=identity,
        store=RunStore(str(root)),
        queue_limit=1,
    )


def _project_final(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    header: str,
    rows: list[str],
    registry_sites: dict[str, str | None],
) -> list[str]:
    source = tmp_path / "metadata.csv"
    source.write_text(header + "\n" + "\n".join(rows) + "\n", encoding="utf-8")
    listed = [
        {
            "subjectId": "sub-01",
            "cohortRole": "healthy",
            "site": registry_sites["sub-01"],
        },
        {
            "subjectId": "sub-02",
            "cohortRole": "sci-neuropathic-pain",
            "site": registry_sites["sub-02"],
        },
    ]

    class _Registry:
        def __init__(self, _root: str) -> None:
            pass

        def list(self, _cfg: dict[str, Any]) -> list[dict[str, Any]]:
            return copy.deepcopy(listed)

    monkeypatch.setattr(runtime, "RegistryStore", _Registry)
    destination = tmp_path / "run" / "final.csv"
    manager = WorkflowManager(_Emitter())
    try:
        manager._metadata_projection(
            _context(tmp_path),
            str(source),
            str(destination),
            healthy_label="SCI_H",
            projection_kind="final",
        )
    finally:
        manager.shutdown()
    return destination.read_text(encoding="utf-8").splitlines()


def test_final_projection_appends_the_registry_site(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lines = _project_final(
        tmp_path,
        monkeypatch,
        "participant_id,Cohort,Age",
        ["sub-02,old,50", "sub-01,old,40"],
        {"sub-01": "Prisma", "sub-02": None},
    )
    assert lines == [
        f"participant_id,Cohort,Age,{SITE_COLUMN}",
        "sub-01,SCI_H,40,Prisma",
        "sub-02,SCI_P,50,",
    ]


@pytest.mark.parametrize(
    ("header", "expected_header"),
    [
        ("participant_id,site,Cohort", "participant_id,Site,Cohort"),
        ("participant_id,Site,Cohort", "participant_id,Site,Cohort"),
        ("participant_id,Site,Cohort,site", "participant_id,Site,Cohort"),
    ],
)
def test_final_projection_replaces_a_source_site_column(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    header: str,
    expected_header: str,
) -> None:
    extra = ",Other" if header.endswith(",site") else ""
    lines = _project_final(
        tmp_path,
        monkeypatch,
        header,
        [f"sub-01,Skyra,old{extra}", f"sub-02,Skyra,old{extra}"],
        {"sub-01": "Prisma", "sub-02": "Ingenia"},
    )
    assert lines == [
        expected_header,
        "sub-01,Prisma,SCI_H",
        "sub-02,Ingenia,SCI_P",
    ]


def test_clinical_projection_has_no_site_column(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "clinical.csv"
    source.write_text(
        "participant_id,Cohort,AIS\nsub-01,old,\nsub-02,old,B\n", encoding="utf-8"
    )
    listed = [
        {"subjectId": "sub-01", "cohortRole": "healthy", "site": "Prisma"},
        {"subjectId": "sub-02", "cohortRole": "sci-neuropathic-pain", "site": None},
    ]

    class _Registry:
        def __init__(self, _root: str) -> None:
            pass

        def list(self, _cfg: dict[str, Any]) -> list[dict[str, Any]]:
            return copy.deepcopy(listed)

    monkeypatch.setattr(runtime, "RegistryStore", _Registry)
    destination = tmp_path / "run" / "clinical.csv"
    manager = WorkflowManager(_Emitter())
    try:
        manager._metadata_projection(
            _context(tmp_path),
            str(source),
            str(destination),
            healthy_label="control",
            projection_kind="clinical",
        )
    finally:
        manager.shutdown()
    assert destination.read_text(encoding="utf-8").splitlines() == [
        "participant_id,Cohort,AIS",
        "sub-01,control,",
        "sub-02,SCI_P,B",
    ]


# -- registry.setSite RPC -------------------------------------------------------


@pytest.fixture
def dispatcher() -> Dispatcher:
    rpc = build_dispatcher(Emitter(io.StringIO()))
    try:
        yield rpc
    finally:
        rpc.managed_resource_manager.shutdown()
        rpc.provision_manager.shutdown()
        rpc.workflow_manager.shutdown()
        rpc.workflow_manager.project_epochs.detach_all()


def _call(dispatcher: Dispatcher, method: str, root: Path, **fields: Any) -> Any:
    request = {
        "project": {
            "projectId": "rpc-sites",
            "root": str(root.resolve()),
            "configPath": str((root / "supraspina.project.json").resolve()),
            "epoch": 1,
        },
        "configRevision": 1,
        **fields,
    }
    return dispatcher.handle(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": [request]}
    )


def test_set_site_rpc_writes_and_lists_the_site(
    dispatcher: Dispatcher, tmp_path: Path
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    for subject_id in ("sub-001", "sub-002"):
        response = _call(
            dispatcher, "registry.upsert", root, record=_record(subject_id)
        )
        assert "error" not in response, response

    response = _call(
        dispatcher,
        "registry.setSite",
        root,
        subjectIds=["sub-001"],
        site="Prisma",
        expectedRevisions={"sub-001": 1},
    )
    assert response["result"] == {"site": "Prisma", "updated": 1}
    listed = _call(dispatcher, "registry.list", root)["result"]
    assert [row["site"] for row in listed] == ["Prisma", None]

    missing = _call(
        dispatcher,
        "registry.setSite",
        root,
        subjectIds=["sub-002"],
        expectedRevisions={"sub-002": 1},
    )
    assert sites.SITE_LABEL_RULE in json.dumps(missing["error"])
    stale = _call(
        dispatcher,
        "registry.setSite",
        root,
        subjectIds=["sub-001"],
        site=None,
        expectedRevisions={"sub-001": 1},
    )
    assert "another writer changed this record" in json.dumps(stale["error"])
    assert os.path.exists(root / ".supraspina" / "registry.json")
