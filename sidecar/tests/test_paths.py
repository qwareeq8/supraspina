"""Tests for path interpolation and WSL path translation."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from supraspina_sidecar import paths

FIXTURES = Path(__file__).parents[2] / "fixtures" / "template-resolution"


def _resolution_cases() -> list[dict[str, Any]]:
    """Return the shared cross-language template-resolution cases."""
    document = json.loads((FIXTURES / "cases.json").read_text(encoding="utf-8"))
    return list(document["resolution"])


class _Proc:
    """Represent a completed subprocess for isolated tests."""

    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_translation_is_identity_off_wsl():
    assert paths.to_native("/data/x", "linux") == "/data/x"
    assert paths.from_native("/data/x", "linux") == "/data/x"
    # Leave newlines untouched outside WSL because no translation occurs.
    assert paths.to_native("/data/x\n", "linux") == "/data/x\n"


def test_translation_refuses_newline_or_nul_under_wsl(monkeypatch):
    monkeypatch.setattr(paths.shutil, "which", lambda _name: "/usr/bin/wslpath")
    with pytest.raises(ValueError, match="Remove newlines and NUL bytes"):
        paths.to_native("/data/x\n/etc", "wsl")
    with pytest.raises(ValueError, match="Remove newlines and NUL bytes"):
        paths.from_native("C:\\x\x00", "wsl")


def test_to_native_invokes_wslpath_with_fixed_argv(monkeypatch):
    calls = {}
    monkeypatch.setattr(paths.shutil, "which", lambda _name: "/usr/bin/wslpath")

    def fake_run(argv, **_kwargs):
        calls["argv"] = argv
        return _Proc(returncode=0, stdout="C:\\Users\\x\n")

    monkeypatch.setattr(paths.subprocess, "run", fake_run)
    assert paths.to_native("/mnt/c/Users/x", "wsl") == "C:\\Users\\x"
    assert calls["argv"] == ["/usr/bin/wslpath", "-w", "/mnt/c/Users/x"]


def test_from_native_uses_u_flag(monkeypatch):
    calls = {}
    monkeypatch.setattr(paths.shutil, "which", lambda _name: "/usr/bin/wslpath")

    def fake_run(argv, **_kwargs):
        calls["argv"] = argv
        return _Proc(returncode=0, stdout="/mnt/c/x\n")

    monkeypatch.setattr(paths.subprocess, "run", fake_run)
    assert paths.from_native("C:\\x", "wsl") == "/mnt/c/x"
    assert calls["argv"][1] == "-u"


def test_translation_falls_back_when_wslpath_absent(monkeypatch):
    monkeypatch.setattr(paths.shutil, "which", lambda _name: None)
    assert paths.from_native("C:\\x", "wsl") == "C:\\x"


def test_translation_falls_back_on_nonzero_exit(monkeypatch):
    monkeypatch.setattr(paths.shutil, "which", lambda _name: "/usr/bin/wslpath")
    monkeypatch.setattr(
        paths.subprocess,
        "run",
        lambda *_a, **_k: _Proc(
            returncode=1,
            stderr="Report the fixture failure.",
        ),
    )
    assert paths.to_native("/mnt/c/x", "wsl") == "/mnt/c/x"


def _prepared():
    return paths.PreparedConfig(
        {
            "paths": {"projectRoot": "/data/study", "outputDir": "/data/study/out"},
            "_supraspinaRuntime": {"resolvedReconBackend": "freesurfer"},
        }
    )


def test_prepared_config_flattens_once_and_matches_the_plain_walk():
    prepared = _prepared()

    first = paths.flatten(prepared)
    second = paths.flatten(prepared)

    assert first == paths.flatten(dict(prepared))
    assert first is second


def test_prepared_config_is_indistinguishable_from_a_plain_dict():
    prepared = _prepared()
    paths.flatten(prepared)

    assert json.dumps(prepared) == json.dumps(dict(prepared))
    assert type(dict(prepared)) is dict
    assert prepared == dict(prepared)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda cfg: cfg.__setitem__(
            "_supraspinaRuntime", {"resolvedReconBackend": "fs2"}
        ),
        lambda cfg: cfg.update({"_supraspinaRuntime": {"resolvedReconBackend": "fs2"}}),
        lambda cfg: cfg.setdefault("extra", "fs2"),
        lambda cfg: cfg.pop("_supraspinaRuntime"),
        lambda cfg: cfg.__delitem__("_supraspinaRuntime"),
        lambda cfg: cfg.popitem(),
        lambda cfg: cfg.clear(),
    ],
)
def test_every_top_level_mutation_discards_the_flattened_view(mutate):
    prepared = _prepared()
    paths.flatten(prepared)

    mutate(prepared)

    assert paths.flatten(prepared) == paths.flatten(dict(prepared))


def test_replacing_the_runtime_subtree_republishes_the_flattened_view():
    # Producers replace a nested subtree rather than mutating it in place, so
    # the flattened view must follow the replacement.
    prepared = _prepared()
    assert paths.flatten(prepared)["_supraspinaRuntime.resolvedReconBackend"] == (
        "freesurfer"
    )

    runtime = prepared["_supraspinaRuntime"]
    prepared["_supraspinaRuntime"] = {**runtime, "resolvedReconBackend": "fastsurfer"}

    assert paths.flatten(prepared)["_supraspinaRuntime.resolvedReconBackend"] == (
        "fastsurfer"
    )


@pytest.mark.parametrize("clone", [copy.copy, copy.deepcopy])
def test_copies_never_inherit_a_cached_flattened_view(clone):
    prepared = _prepared()
    paths.flatten(prepared)

    duplicate = clone(prepared)
    duplicate["_supraspinaRuntime"] = {"resolvedReconBackend": "fastsurfer"}

    assert paths.flatten(duplicate) == paths.flatten(dict(duplicate))
    assert paths.flatten(duplicate)["_supraspinaRuntime.resolvedReconBackend"] == (
        "fastsurfer"
    )
    assert paths.flatten(prepared)["_supraspinaRuntime.resolvedReconBackend"] == (
        "freesurfer"
    )


def test_serialization_reconstructs_a_plain_prepared_config():
    prepared = _prepared()
    paths.flatten(prepared)

    factory, arguments = prepared.__reduce__()
    restored = factory(*arguments)
    restored["_supraspinaRuntime"] = {"resolvedReconBackend": "fastsurfer"}

    assert type(restored) is paths.PreparedConfig
    assert type(arguments[0]) is dict
    assert paths.flatten(restored) == paths.flatten(dict(restored))


def test_interpolation_matches_the_plain_dict_context():
    prepared = _prepared()
    template = "${paths.outputDir}/${resolvedReconBackend}/${missing.key}"

    assert paths.interpolate(template, paths.flatten(prepared)) == paths.interpolate(
        template, paths.flatten(dict(prepared))
    )


def _alias_parent():
    """Return a parent whose nested key ends in the segment an overlay adds."""
    return paths.PreparedConfig(
        {
            "paths": {"projectRoot": "/data/study", "subject": "/data/study/nested"},
            "tools": {"freesurferHome": "/usr/local/freesurfer"},
        }
    )


@pytest.mark.parametrize("warm", [False, True])
def test_derive_matches_the_plain_overlay_including_alias_precedence(warm):
    # A nested key ending in "subject" already owns that alias, so appending a
    # top-level "subject" must not displace it.
    parent = _alias_parent()
    if warm:
        paths.flatten(parent)

    derived = parent.derive("subject", "sub-001")
    plain = {**dict(parent), "subject": "sub-001"}

    assert paths.flatten(derived) == paths.flatten(plain)
    assert list(paths.flatten(derived)) == list(paths.flatten(plain))
    assert parent == _alias_parent()


@pytest.mark.parametrize(
    "template",
    [
        "${subject}",
        "${paths.subject}",
        # A dotted reference that misses keeps its full text, so this one
        # stays intact for both the derived and the plain overlay.
        "${a.b.subject}",
        "${paths.projectRoot}/${subject}/anat",
        "${missing.key}",
    ],
)
def test_derived_interpolation_matches_the_plain_overlay(template):
    parent = _alias_parent()
    derived = parent.derive("subject", "sub-001")
    plain = {**dict(parent), "subject": "sub-001"}

    assert paths.interpolate(template, paths.flatten(derived)) == paths.interpolate(
        template, paths.flatten(plain)
    )


def test_derive_reuses_the_parent_view_without_rewalking(monkeypatch):
    parent = _alias_parent()
    paths.flatten(parent)
    walks = []
    original = paths._flatten_walk

    def counting(config, prefix):
        walks.append(prefix)
        return original(config, prefix)

    monkeypatch.setattr(paths, "_flatten_walk", counting)
    for index in range(5):
        paths.flatten(parent.derive("subject", f"sub-{index:03d}"))

    assert walks == []


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("paths", "replaced"),
        ("subject", {"nested": "mapping"}),
        ("subject", ["not", "string"]),
        ("subject", 7),
        ("subject", True),
    ],
)
def test_derive_falls_back_when_the_overlay_is_not_an_appended_string(key, value):
    # Replacing an existing key or storing a value the flatten walk drops
    # changes the flattened view by more than one appended entry, so the view
    # must be rebuilt.
    parent = _alias_parent()
    paths.flatten(parent)

    derived = parent.derive(key, value)

    assert paths.flatten(derived) == paths.flatten({**dict(parent), key: value})


@pytest.mark.parametrize(
    "case", _resolution_cases(), ids=lambda case: str(case["name"])
)
def test_execution_resolution_matches_the_shared_table(case):
    # The renderer and the schema validator run this same table. A path this
    # resolver accepts but they leave as a token would execute somewhere
    # validation never inspected, so all three must agree case for case.
    context = paths.flatten(case["config"])

    assert paths.interpolate(case["template"], context) == case["expected"]


def test_derive_leaves_the_parent_and_its_view_untouched():
    parent = _alias_parent()
    before = paths.flatten(parent)

    derived = parent.derive("subject", "sub-001")

    assert "subject" not in before
    assert paths.flatten(parent) is before
    assert derived["subject"] == "sub-001"
