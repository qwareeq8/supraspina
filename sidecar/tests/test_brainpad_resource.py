"""Semantic regression tests for the bundled Brain-PAD analysis resource."""

from __future__ import annotations

import ast
import csv
import importlib.util
import os
import struct
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from supraspina_sidecar import resources
from supraspina_sidecar.adapters.brainpad import MANIFEST_BASENAME, OUTPUT_BASENAMES

#: Import every third-party module ``brainpadstats.py`` imports at module scope.
#: A probe that passes must prove the interpreter can execute the script, which
#: every subprocess test does through ``spec.loader.exec_module``.
_RESOURCE_IMPORTS = (
    "cliffs_delta",
    "matplotlib",
    "numpy",
    "pandas",
    "scipy",
    "seaborn",
    "statsmodels",
)

#: Resolve this first-party sibling from the script's own directory, not the
#: interpreter's environment, so no probe can require it.
_RESOURCE_SIBLING = "figstyle"


def _resource_interpreter(*extra_modules: str) -> str:
    """Return an interpreter that can run the resource, or skip the test.

    Parameters
    ----------
    *extra_modules
        Provide modules a single test needs beyond the script's own imports.

    Returns
    -------
    str
        Return the configured analysis interpreter.
    """
    python = os.environ.get("SUPRASPINA_BRAINPAD_TEST_PYTHON", sys.executable)
    modules = ", ".join(sorted({*_RESOURCE_IMPORTS, *extra_modules}))
    probe = subprocess.run(  # noqa: S603 - Exercise the configured interpreter.
        [python, "-c", f"import {modules}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        pytest.skip(
            "Set SUPRASPINA_BRAINPAD_TEST_PYTHON to an interpreter with the "
            "Brain-PAD runtime dependencies."
        )
    return python


def _stub_module(name: str, **attributes: Any) -> ModuleType:
    module = ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    return module


def _load_resource(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    """Load the resource with import-only scientific dependency stubs."""
    pyplot = _stub_module("matplotlib.pyplot")
    matplotlib = _stub_module("matplotlib", use=lambda _backend: None)
    matplotlib.__path__ = []  # type: ignore[attr-defined]
    numpy = _stub_module("numpy", inf=float("inf"), nan=float("nan"))
    pandas = _stub_module("pandas")
    seaborn = _stub_module("seaborn")
    stats_api = _stub_module("statsmodels.api")
    statsmodels = _stub_module("statsmodels", api=stats_api)
    statsmodels.__path__ = []  # type: ignore[attr-defined]
    cliffs = _stub_module("cliffs_delta", cliffs_delta=lambda _a, _b: (0.0, ""))
    scipy_stats = _stub_module("scipy.stats")
    scipy = _stub_module("scipy", stats=scipy_stats)
    scipy.__path__ = []  # type: ignore[attr-defined]
    figstyle = _stub_module("figstyle", apply_latin_modern=lambda: None)
    for name, module in {
        "matplotlib": matplotlib,
        "matplotlib.pyplot": pyplot,
        "numpy": numpy,
        "pandas": pandas,
        "seaborn": seaborn,
        "statsmodels": statsmodels,
        "statsmodels.api": stats_api,
        "cliffs_delta": cliffs,
        "scipy": scipy,
        "scipy.stats": scipy_stats,
        "figstyle": figstyle,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)

    path = resources.step7_dir() / "brainpadstats.py"
    spec = importlib.util.spec_from_file_location("brainpadstats_resource_test", path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_ais_eligibility_retains_controls_without_ais(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_resource(monkeypatch)

    eligible = module._ais_row_is_eligible

    assert eligible("control", ais_missing=True)
    assert eligible("control", ais_missing=False)
    assert eligible("SCI_P", ais_missing=False)
    assert not eligible("SCI_P", ais_missing=True)


def test_boxplot_removes_legend_without_passing_new_seaborn_keyword(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_resource(monkeypatch)
    removed: list[bool] = []

    class Legend:
        def remove(self) -> None:
            removed.append(True)

    class Axes:
        def get_legend(self) -> Legend:
            return Legend()

    def boxplot(**kwargs: object) -> Axes:
        assert "legend" not in kwargs
        return Axes()

    module.sns.boxplot = boxplot
    axes = module._boxplot_without_legend(x="Cohort", y="BrainPAD")

    assert isinstance(axes, Axes)
    assert removed == [True]


def test_xlsx_preflight_bounds_member_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_resource(monkeypatch)
    workbook = tmp_path / "many-members.xlsx"
    with ZipFile(workbook, "w") as archive:
        archive.writestr("[Content_Types].xml", "types")
        archive.writestr("xl/workbook.xml", "workbook")
    monkeypatch.setattr(module, "MAX_XLSX_MEMBERS", 1)

    with pytest.raises(ValueError, match="within 1 members"):
        module._validate_xlsx_archive(str(workbook))


def test_xlsx_preflight_bounds_compression_ratio(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_resource(monkeypatch)
    workbook = tmp_path / "compressed.xlsx"
    with ZipFile(workbook, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("xl/worksheets/sheet1.xml", b"0" * 16_384)
    monkeypatch.setattr(module, "MAX_XLSX_COMPRESSION_RATIO", 2)

    with pytest.raises(ValueError, match="compression ratio"):
        module._validate_xlsx_archive(str(workbook))


def test_xlsx_preflight_rejects_zip64_directory_sentinel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_resource(monkeypatch)
    workbook = tmp_path / "zip64-sentinel.xlsx"
    with ZipFile(workbook, "w") as archive:
        archive.writestr("[Content_Types].xml", "types")
    value = bytearray(workbook.read_bytes())
    eocd = value.rfind(b"PK\x05\x06")
    assert eocd >= 0
    struct.pack_into("<L", value, eocd + 12, 0xFFFFFFFF)
    workbook.write_bytes(value)

    with pytest.raises(ValueError, match="does not require ZIP64"):
        module._validate_xlsx_archive(str(workbook))


def test_ais_comparisons_count_controls_once_and_keep_grades_sci_only() -> None:
    # A control carrying an AIS grade must contribute only to the control
    # group; counting it inside the grade group would place the same
    # observation in both samples of one two-sample test.
    python = _resource_interpreter()
    script = """
import importlib.util
import sys

import numpy as np
import pandas as pd

spec = importlib.util.spec_from_file_location("brainpadstats", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules["brainpadstats"] = module
spec.loader.exec_module(module)

rows = []
for index in range(6):
    rows.append({
        "Cohort": "control",
        "AIS": "D" if index < 3 else np.nan,
        "BrainPAD": float(index),
    })
for index in range(6):
    rows.append({
        "Cohort": "SCI_P",
        "AIS": "D" if index < 3 else "C",
        "BrainPAD": 10.0 + index,
    })
table = module._ais_comparisons(pd.DataFrame(rows))
by_pair = {
    (row["Group 1"], row["Group 2"]): row["Sample Sizes"]
    for _, row in table.iterrows()
}
print(by_pair[("control", "D")])
print(by_pair[("D", "C")])
"""
    completed = subprocess.run(  # noqa: S603 - Exercise the configured interpreter.
        [python, "-c", script, str(resources.step7_dir() / "brainpadstats.py")],
        check=True,
        capture_output=True,
        text=True,
    )
    control_vs_d, d_vs_c = completed.stdout.strip().splitlines()
    assert control_vs_d == "n1=6, n2=3"
    assert d_vs_c == "n1=3, n2=3"


def test_tsi_figure_tolerates_a_trailing_space_column_variant(
    tmp_path: Path,
) -> None:
    # An operator-edited workbook can carry both time-since-injury column
    # spellings; the figure must plot the exact validated column instead
    # of crashing on a duplicated name.
    python = _resource_interpreter()
    script = """
import importlib.util
import sys

import pandas as pd

spec = importlib.util.spec_from_file_location("brainpadstats", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules["brainpadstats"] = module
spec.loader.exec_module(module)

frame = pd.DataFrame({
    "Cohort": ["SCI_P", "SCI_nNP", "SCI_P", "SCI_nNP"],
    "BrainPAD": [1.0, 2.0, 3.0, 4.0],
    "Time since SCI (years)": [1.0, 2.0, 3.0, 4.0],
    "Time since SCI (years) ": [9.0, 9.0, 9.0, 9.0],
})
module._fig_brainpad_vs_tsi(frame, sys.argv[2])
"""
    figure = tmp_path / "tsi.png"
    subprocess.run(  # noqa: S603 - Exercise the configured interpreter.
        [
            python,
            "-c",
            script,
            str(resources.step7_dir() / "brainpadstats.py"),
            str(figure),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert figure.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_full_cli_preserves_representative_outputs(tmp_path: Path) -> None:
    """Run all twelve outputs with a complete pinned-stack-compatible cohort."""
    python = _resource_interpreter("openpyxl")

    input_xlsx = tmp_path / "predicted_results.xlsx"
    create_fixture = """
import sys
from openpyxl import Workbook

workbook = Workbook()
sheet = workbook.active
sheet.append(["participant_id", "Age", "Sex", "Cohort", "BrainAge", "BrainPAD", "AIS", "Time since SCI (years)"])
for cohort_index, cohort in enumerate(("control", "SCI_nNP", "SCI_P")):
    for index in range(12):
        age = 30 + 4 * cohort_index + index
        pad = -2 + 3 * cohort_index + 0.7 * (index % 5)
        sheet.append([
            f"{cohort}-{index:02d}", age, "Female" if index % 2 == 0 else "Male",
            cohort, age + pad, pad, None if cohort == "control" else "ABCD"[index % 4],
            None if cohort == "control" else 2 + cohort_index + 0.75 * index,
        ])
workbook.save(sys.argv[1])
"""
    subprocess.run(  # noqa: S603 - Exercise the configured interpreter.
        [python, "-c", create_fixture, str(input_xlsx)],
        check=True,
        capture_output=True,
        text=True,
    )

    outputs = [tmp_path / basename for basename in OUTPUT_BASENAMES]
    subprocess.run(  # noqa: S603 - Exercise the configured interpreter.
        [
            python,
            str(resources.step7_dir() / "brainpadstats.py"),
            str(input_xlsx),
            *(str(path) for path in outputs),
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    assert all(path.stat().st_size > 0 for path in outputs)
    manifest = tmp_path / MANIFEST_BASENAME
    assert manifest.stat().st_size > 0
    for path in outputs:
        if path.suffix == ".png":
            assert path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"

    with outputs[0].open(newline="", encoding="utf-8") as handle:
        summary = {row["Cohort"]: row for row in csv.DictReader(handle)}
    assert summary["control"]["Participants"] == "12"
    assert float(summary["control"]["Mean BrainPAD"]) == pytest.approx(-0.775)
    assert float(summary["SCI_nNP"]["Mean BrainPAD"]) == pytest.approx(2.225)
    assert float(summary["SCI_P"]["Mean BrainPAD"]) == pytest.approx(5.225)

    with outputs[6].open(newline="", encoding="utf-8") as handle:
        cohort_rows = list(csv.DictReader(handle))
    assert [row["Sample Size"] for row in cohort_rows] == [
        "n1=12, n2=12",
        "n1=12, n2=12",
        "n1=12, n2=12",
    ]
    assert float(cohort_rows[0]["Effect Size"]) == pytest.approx(-2.8864476532066705)
    assert float(cohort_rows[1]["Effect Size"]) == pytest.approx(-5.772895306413342)

    with outputs[9].open(newline="", encoding="utf-8") as handle:
        chi2 = next(csv.DictReader(handle))
    assert float(chi2["Chi-Square Statistic"]) == pytest.approx(0.0)
    assert int(chi2["Degrees of Freedom"]) == 3
    assert float(chi2["p-value"]) == pytest.approx(1.0)

    first_bytes = {path.name: path.read_bytes() for path in outputs}
    second_dir = tmp_path / "second"
    second_outputs = [second_dir / basename for basename in OUTPUT_BASENAMES]
    subprocess.run(  # noqa: S603 - Exercise deterministic resource output.
        [
            python,
            str(resources.step7_dir() / "brainpadstats.py"),
            str(input_xlsx),
            *(str(path) for path in second_outputs),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert {path.name: path.read_bytes() for path in second_outputs} == first_bytes

    previous_manifest = manifest.read_bytes()
    mutate_fixture = """
import sys
from openpyxl import load_workbook
book = load_workbook(sys.argv[1])
sheet = book.active
headers = {cell.value: cell.column for cell in sheet[1]}
sheet.cell(row=2, column=headers[sys.argv[2]], value=sys.argv[3])
book.save(sys.argv[1])
"""
    for column, value, message in (
        ("Cohort", "unknown", "reviewed Brain-PAD cohorts"),
        ("AIS", "E", "Use AIS A, B, C, or D"),
        ("Age", "not-a-number", "finite numeric Age"),
        ("BrainPAD", "1000", "BrainAge - Age"),
    ):
        invalid = tmp_path / f"invalid-{column}.xlsx"
        invalid.write_bytes(input_xlsx.read_bytes())
        subprocess.run(  # noqa: S603 - Mutate one synthetic fixture with fixed argv.
            [python, "-c", mutate_fixture, str(invalid), column, value],
            check=True,
            capture_output=True,
            text=True,
        )
        completed = subprocess.run(  # noqa: S603 - Exercise reviewed fixed argv.
            [
                python,
                str(resources.step7_dir() / "brainpadstats.py"),
                str(invalid),
                *(str(path) for path in outputs),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        assert completed.returncode != 0
        assert message in completed.stderr
        assert {path.name: path.read_bytes() for path in outputs} == first_bytes
        assert manifest.read_bytes() == previous_manifest


#: Script that builds a small valid cohort whose first control row carries no age.
_CREATE_UNKNOWN_AGE_FIXTURE = """
import sys
from openpyxl import Workbook

workbook = Workbook()
sheet = workbook.active
sheet.append(["participant_id", "Age", "Sex", "Cohort", "BrainAge", "BrainPAD", "AIS", "Time since SCI (years)"])
for cohort_index, cohort in enumerate(("control", "SCI_nNP", "SCI_P")):
    for index in range(4):
        age = 30 + 4 * cohort_index + index
        pad = -2 + 3 * cohort_index + 0.5 * index
        unknown = cohort == "control" and index == 0
        sheet.append([
            f"{cohort}-{index:02d}", None if unknown else age,
            "Female" if index % 2 == 0 else "Male", cohort, age + pad,
            None if unknown else pad,
            None if cohort == "control" else "ABCD"[index % 4],
            None if cohort == "control" else 2 + cohort_index + 0.75 * index,
        ])
if len(sys.argv) > 2:
    sheet.cell(row=2, column=6, value=-2.0)
workbook.save(sys.argv[1])
"""


def test_full_cli_excludes_a_subject_without_a_chronological_age(
    tmp_path: Path,
) -> None:
    """Keep the brain-age prediction and drop the row from Brain-PAD outputs."""
    python = _resource_interpreter("openpyxl")
    input_xlsx = tmp_path / "predicted_results.xlsx"
    subprocess.run(  # noqa: S603 - Exercise the configured interpreter.
        [python, "-c", _CREATE_UNKNOWN_AGE_FIXTURE, str(input_xlsx)],
        check=True,
        capture_output=True,
        text=True,
    )

    outputs = [tmp_path / basename for basename in OUTPUT_BASENAMES]
    completed = subprocess.run(  # noqa: S603 - Exercise reviewed fixed argv.
        [
            python,
            str(resources.step7_dir() / "brainpadstats.py"),
            str(input_xlsx),
            *(str(path) for path in outputs),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert (
        "Excluded 1 subject(s) without a chronological age from Brain-PAD "
        "statistics: control-00." in completed.stderr
    )
    assert all(path.stat().st_size > 0 for path in outputs)

    with outputs[0].open(newline="", encoding="utf-8") as handle:
        summary = {row["Cohort"]: row for row in csv.DictReader(handle)}
    assert summary["control"]["Participants"] == "4"
    assert summary["control"]["N without age"] == "1"
    assert summary["SCI_P"]["N without age"] == "0"
    # Average the -1.5, -1.0, and -0.5 Brain-PAD values the three aged controls
    # carry; the excluded control would have contributed -2.0.
    assert float(summary["control"]["Mean BrainPAD"]) == pytest.approx(-1.0)
    assert float(summary["control"]["Mean Age"]) == pytest.approx(32.0)

    with outputs[6].open(newline="", encoding="utf-8") as handle:
        cohort_rows = list(csv.DictReader(handle))
    assert [row["Sample Size"] for row in cohort_rows] == [
        "n1=3, n2=4",
        "n1=3, n2=4",
        "n1=4, n2=4",
    ]


def test_full_cli_rejects_a_brain_pad_without_a_chronological_age(
    tmp_path: Path,
) -> None:
    python = _resource_interpreter("openpyxl")
    input_xlsx = tmp_path / "predicted_results.xlsx"
    subprocess.run(  # noqa: S603 - Exercise the configured interpreter.
        [python, "-c", _CREATE_UNKNOWN_AGE_FIXTURE, str(input_xlsx), "keep-pad"],
        check=True,
        capture_output=True,
        text=True,
    )

    completed = subprocess.run(  # noqa: S603 - Exercise reviewed fixed argv.
        [
            python,
            str(resources.step7_dir() / "brainpadstats.py"),
            str(input_xlsx),
            *(str(tmp_path / basename) for basename in OUTPUT_BASENAMES),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode != 0
    assert "Leave BrainPAD empty for every row without an Age value." in (
        completed.stderr
    )


def test_runtime_probe_covers_every_third_party_import_of_the_resource() -> None:
    """Keep the skip guard's module list equal to the script's own imports."""
    source = (resources.step7_dir() / "brainpadstats.py").read_text(encoding="utf-8")
    imported: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            imported.add(node.module.split(".")[0])

    third_party = {
        name
        for name in imported
        if name not in sys.stdlib_module_names and name != _RESOURCE_SIBLING
    }

    assert third_party == set(_RESOURCE_IMPORTS)
