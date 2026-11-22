#!/usr/bin/env python3
"""Generate group-level Brain-PAD statistics and figures for pipeline step 7.

A first-party, argv-driven reimplementation of the upstream SCI_Map
``brainpadstats.py`` step. Reproduce a per-cohort summary table, five Brain-PAD figures,
and six comparison tables: cohort, sex-stratified, AIS, AIS chi-square,
time-since-injury, and chronological age. Select a t-test with the implemented
Cohen's d when both normality checks exceed the threshold; select a
Mann-Whitney U test with Cliff's delta otherwise.

Read the Step 6 ``predicted_results.xlsx`` analysis workbook for the ``control``,
``SCI_nNP``, and ``SCI_P`` cohorts. A subject without a chronological age
carries an empty ``Age`` and ``BrainPAD`` pair: count it in the summary table,
report it once on standard error, and exclude it from every Brain-PAD
statistic, comparison, and figure. Write all twelve outputs to the command-line
paths in the exact order emitted by the adapter's ``_output_paths`` method.
Write the ninth positional output path verbatim so the adapter can preserve the
pinned upstream basename ``BrainPAD_acorss_AIS.csv``. Use Matplotlib's headless
``Agg`` backend, and create each output's parent directory before writing.
Reject workbooks outside the documented file, archive, row, or column bounds
before Pandas materializes the analysis table.

Usage::

    python brainpadstats.py <input_xlsx> <out1> <out2> ... <out12>
"""

# ruff: noqa: E402 - configure the headless backend and fonts before pyplot.

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import struct
import sys
import tempfile
from itertools import combinations
from pathlib import Path
from zipfile import BadZipFile, ZipFile

import matplotlib

matplotlib.use("Agg")

# Apply the shared Latin Modern figure style before pyplot or seaborn reads
# rcParams. Resolve it relative to this script for frozen and development runs.
# Avoid importing the sidecar package from the selected analysis interpreter.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "figstyle"))
import figstyle

figstyle.apply_latin_modern()

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
import statsmodels.api as sm
from cliffs_delta import cliffs_delta
from scipy import stats

#: Use this cohort order for every per-cohort table and figure.
COHORT_ORDER = ("control", "SCI_nNP", "SCI_P")

#: Use an Okabe-Ito color-vision-deficiency-safe cohort palette.
COHORT_PALETTE = {"control": "#0072B2", "SCI_nNP": "#E69F00", "SCI_P": "#009E73"}

#: Repeat the cohort distinction with marker shape in scatterplots.
COHORT_MARKERS = {"control": "o", "SCI_nNP": "s", "SCI_P": "^"}

#: Expand compatibility cohort codes in human-facing figures.
COHORT_DISPLAY = {
    "control": "Control cohort",
    "SCI_nNP": "SCI without pain",
    "SCI_P": "SCI with pain",
}

#: Compare controls before the ordered AIS impairment grades.
AIS_ORDER = ("control", "D", "C", "B", "A")

#: Require twelve positional output paths from the adapter.
N_OUTPUTS = 12
MANIFEST_BASENAME = ".brainpad-generation.json"

#: Require this minimum group size for a two-sample comparison.
_MIN_GROUP = 2

#: Bound the subject list in the excluded-subject report line.
MAX_LISTED_IDS = 20

#: Bound the workbook before OpenPyXL/Pandas materializes XML or cell objects.
MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_COHORT_ROWS = 5_000
MAX_TABLE_COLUMNS = 1_024
MAX_XLSX_MEMBERS = 1_024
MAX_XLSX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_XLSX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_XLSX_COMPRESSION_RATIO = 100

_ZIP_EOCD = struct.Struct("<4s4H2LH")
_ZIP_EOCD_SIGNATURE = b"PK\x05\x06"
_ZIP_EOCD_SEARCH = 65_535 + _ZIP_EOCD.size
_ZIP16_SENTINEL = 0xFFFF
_ZIP32_SENTINEL = 0xFFFFFFFF


def _zip_member_count(path: str) -> int:
    """Return the non-ZIP64 member count without loading the central directory."""
    size = os.path.getsize(path)
    with open(path, "rb") as handle:
        handle.seek(max(0, size - _ZIP_EOCD_SEARCH))
        tail = handle.read(_ZIP_EOCD_SEARCH)
    offset = tail.rfind(_ZIP_EOCD_SIGNATURE)
    if offset < 0 or offset + _ZIP_EOCD.size > len(tail):
        raise ValueError("Provide a valid XLSX ZIP archive.")
    (
        _signature,
        disk,
        central_disk,
        disk_entries,
        total_entries,
        central_size,
        central_offset,
        comment_size,
    ) = _ZIP_EOCD.unpack_from(tail, offset)
    if offset + _ZIP_EOCD.size + comment_size != len(tail):
        raise ValueError("Provide an XLSX archive without trailing data.")
    if disk != 0 or central_disk != 0 or disk_entries != total_entries:
        raise ValueError("Provide a single-disk XLSX archive.")
    if (
        total_entries == _ZIP16_SENTINEL
        or _ZIP32_SENTINEL in (central_size, central_offset)
    ):
        raise ValueError("Provide an XLSX archive that does not require ZIP64.")
    eocd_offset = size - len(tail) + offset
    if central_offset + central_size > eocd_offset:
        raise ValueError("Provide an XLSX archive with a valid central directory.")
    if total_entries > MAX_XLSX_MEMBERS:
        raise ValueError(f"Keep the XLSX archive within {MAX_XLSX_MEMBERS} members.")
    return total_entries


def _validate_xlsx_archive(path: str) -> None:
    """Reject oversized or highly compressed XLSX archives before extraction."""
    info = os.stat(path, follow_symlinks=True)
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_INPUT_BYTES:
        raise ValueError("Keep the Brain-PAD workbook within 64 MiB.")
    expected_members = _zip_member_count(path)
    try:
        with ZipFile(path) as archive:
            members = archive.infolist()
            if len(members) != expected_members:
                raise ValueError("Provide an XLSX archive with a consistent index.")
            names: set[str] = set()
            expanded = 0
            for member in members:
                if member.filename in names:
                    raise ValueError(
                        "Provide an XLSX archive without duplicate members."
                    )
                names.add(member.filename)
                if member.flag_bits & 0x1:
                    raise ValueError("Provide an unencrypted XLSX archive.")
                if member.file_size > MAX_XLSX_MEMBER_BYTES:
                    raise ValueError("Keep each expanded XLSX member within 64 MiB.")
                expanded += member.file_size
                if expanded > MAX_XLSX_EXPANDED_BYTES:
                    raise ValueError("Keep expanded XLSX content within 256 MiB.")
                if member.file_size and (
                    member.compress_size == 0
                    or member.file_size / member.compress_size
                    > MAX_XLSX_COMPRESSION_RATIO
                ):
                    raise ValueError(
                        "Keep each XLSX member compression ratio at or below 100."
                    )
    except BadZipFile as exc:
        raise ValueError("Provide a valid XLSX ZIP archive.") from exc


def _read_input_workbook(path: str) -> pd.DataFrame:
    """Read one preflighted workbook within cohort row and column limits."""
    _validate_xlsx_archive(path)
    frame = pd.read_excel(path, nrows=MAX_COHORT_ROWS + 1)
    if len(frame.columns) > MAX_TABLE_COLUMNS:
        raise ValueError("Keep the Brain-PAD workbook within 1024 columns.")
    if len(frame) > MAX_COHORT_ROWS:
        raise ValueError("Keep the Brain-PAD cohort within 5000 rows.")
    return frame


def _finite_numeric_column(df: pd.DataFrame, column: str) -> pd.Series:
    """Return one required numeric column after rejecting missing/nonfinite cells."""
    raw = df[column]
    values = pd.to_numeric(raw, errors="coerce")
    invalid = values.isna() | ~np.isfinite(values)
    if bool(invalid.any()):
        raise ValueError(
            f"Provide finite numeric {column} values; found {int(invalid.sum())} "
            "invalid or missing value(s)."
        )
    return values


def _optional_finite_numeric_column(df: pd.DataFrame, column: str) -> pd.Series:
    """Return one optional numeric column, keeping a blank cell as ``NaN``.

    A subject whose chronological age never reached the pipeline carries a
    blank ``Age`` and a blank ``BrainPAD``. Every supplied cell must still be
    a finite number.
    """
    raw = df[column]
    values = pd.to_numeric(raw, errors="coerce")
    supplied = raw.astype("string").str.strip().fillna("") != ""
    invalid = supplied & (values.isna() | ~np.isfinite(values))
    if bool(invalid.any()):
        raise ValueError(
            f"Provide finite numeric {column} values; found {int(invalid.sum())} "
            "invalid value(s)."
        )
    return values


def _subject_id_column(df: pd.DataFrame) -> str:
    """Return the single supported subject-identity column name."""
    columns = [name for name in ("Subject_ID", "participant_id", "ID") if name in df]
    if len(columns) != 1:
        raise ValueError(
            "Provide exactly one Subject_ID, participant_id, or ID column."
        )
    return columns[0]


def _bounded_ids(subject_ids: list[str]) -> str:
    """Return a bounded, comma-separated subject list closing one report line."""
    listed = ", ".join(subject_ids[:MAX_LISTED_IDS])
    return listed + (", ..." if len(subject_ids) > MAX_LISTED_IDS else ".")


def _without_brainpad(df: pd.DataFrame) -> list[str]:
    """Return the ordered subjects whose Brain-PAD stayed undefined."""
    missing = df[df["BrainPAD"].isna()]
    return [str(value) for value in missing[_subject_id_column(df)]]


def _with_brainpad(df: pd.DataFrame) -> pd.DataFrame:
    """Return only the rows a Brain-PAD statistic, test, or figure may use."""
    return df[df["BrainPAD"].notna()]


def _validate_scientific_input(df: pd.DataFrame) -> pd.DataFrame:
    """Validate categories, subject identity, and the Brain-PAD sign convention.

    Keep a subject whose chronological age never reached the pipeline: its
    ``Age`` and ``BrainPAD`` cells stay empty, and the Brain-PAD statistics
    exclude it.
    """
    required = {
        "Age",
        "Sex",
        "Cohort",
        "BrainAge",
        "BrainPAD",
        "AIS",
        "Time since SCI (years)",
    }
    missing = sorted(required - set(df.columns))
    if missing:
        raise ValueError(f"Add the required Brain-PAD columns: {', '.join(missing)}.")
    identities = df[_subject_id_column(df)].astype("string")
    if bool(identities.isna().any() or (identities.str.strip() == "").any()):
        raise ValueError("Provide a nonempty subject identity for every Brain-PAD row.")
    if bool(identities.duplicated().any()):
        raise ValueError("Provide unique subject identities in the Brain-PAD workbook.")

    cohorts = df["Cohort"].astype("string")
    unknown_cohorts = sorted(
        str(value) for value in cohorts.dropna().unique() if value not in COHORT_ORDER
    )
    if bool(cohorts.isna().any()) or unknown_cohorts:
        detail = ", ".join(unknown_cohorts) if unknown_cohorts else "missing values"
        raise ValueError(f"Use only the reviewed Brain-PAD cohorts; found {detail}.")

    sex = df["Sex"].astype("string")
    unknown_sex = sorted(
        str(value)
        for value in sex.dropna().unique()
        if value not in {"Female", "Male"}
    )
    if unknown_sex:
        raise ValueError(f"Use Female or Male for Sex; found {', '.join(unknown_sex)}.")

    ais = df["AIS"].astype("string")
    sci = cohorts != "control"
    invalid_ais = sci & (ais.isna() | ~ais.isin(("A", "B", "C", "D")))
    unknown_control_ais = (~sci) & ais.notna() & ~ais.isin(("A", "B", "C", "D"))
    if bool((invalid_ais | unknown_control_ais).any()):
        raise ValueError("Use AIS A, B, C, or D for every nonmissing AIS value.")

    result = df.copy()
    result["BrainAge"] = _finite_numeric_column(result, "BrainAge")
    for column in ("Age", "BrainPAD"):
        result[column] = _optional_finite_numeric_column(result, column)
    aged = result["Age"].notna()
    if bool((~aged & result["BrainPAD"].notna()).any()):
        raise ValueError("Leave BrainPAD empty for every row without an Age value.")
    expected = result.loc[aged, "BrainAge"] - result.loc[aged, "Age"]
    if not bool(
        np.allclose(result.loc[aged, "BrainPAD"], expected, rtol=0.0, atol=1e-9)
    ):
        raise ValueError("Set BrainPAD to BrainAge - Age for every row.")

    tsi_raw = result["Time since SCI (years)"]
    tsi = pd.to_numeric(tsi_raw, errors="coerce")
    supplied = tsi_raw.notna() & (tsi_raw.astype("string").str.strip() != "")
    invalid_tsi = supplied & (tsi.isna() | ~np.isfinite(tsi) | (tsi < 0))
    if bool(invalid_tsi.any()):
        raise ValueError("Use finite, nonnegative time-since-injury values.")
    result["Time since SCI (years)"] = tsi
    return result


def _normality_p(values: pd.Series) -> tuple[float, float]:
    """Return the Shapiro-Wilk and Kolmogorov-Smirnov p-values for a series."""
    clean = values.dropna()
    if len(clean) < 3:  # noqa: PLR2004 - shapiro needs >= 3 points
        return 0.0, 0.0
    shapiro_p = stats.shapiro(clean)[1]
    # Freeze the fitted normal instead of passing its parameters through
    # ``args``. SciPy 1.18 forwards those positionally into the vectorized
    # ``norm`` CDF, which raises TypeError and aborts every output; the frozen
    # distribution evaluates the identical CDF on every supported SciPy.
    fitted = stats.norm(loc=clean.mean(), scale=clean.std())
    ks_p = stats.kstest(clean, fitted.cdf)[1]
    return shapiro_p, ks_p


def _is_normal(values: pd.Series) -> bool:
    """Return whether both normality p-values select the parametric branch."""
    shapiro_p, ks_p = _normality_p(values)
    return shapiro_p > 0.05 and ks_p > 0.05  # noqa: PLR2004


def _cohen_d(a: pd.Series, b: pd.Series) -> float:
    """Return Cohen's d for two independent samples (pooled SD)."""
    pooled = np.sqrt(((np.std(a, ddof=1) ** 2) + (np.std(b, ddof=1) ** 2)) / 2)
    if pooled == 0:
        return float("nan")
    return float((np.mean(a) - np.mean(b)) / pooled)


def _two_group(a: pd.Series, b: pd.Series, *, normal: bool) -> tuple[str, float, float]:
    """Return (test label, p-value, effect size) for two groups.

    Use a t-test with the implemented Cohen's d in the parametric branch. Use
    Mann-Whitney U with Cliff's delta otherwise.
    """
    a = a.dropna()
    b = b.dropna()
    if len(a) < _MIN_GROUP or len(b) < _MIN_GROUP:
        return "insufficient-n", float("nan"), float("nan")
    if normal:
        stat, p_value = stats.ttest_ind(a, b)
        return f"t-test (t={stat:.2f})", float(p_value), _cohen_d(a, b)
    stat, p_value = stats.mannwhitneyu(a, b)
    effect, _ = cliffs_delta(a, b)
    return f"Mann-Whitney U (U={stat:.2f})", float(p_value), float(effect)


def _summary_table(df: pd.DataFrame) -> pd.DataFrame:
    """Build the per-cohort demographic + Brain-PAD summary table.

    Report every participant in ``Participants`` and count the subjects a
    missing chronological age keeps out of the Brain-PAD columns in
    ``N without age``.
    """
    rows: list[list[object]] = []
    for cohort in COHORT_ORDER:
        subset = df[df["Cohort"] == cohort]
        ais = (
            subset["AIS"].value_counts().to_dict()
            if "AIS" in subset.columns
            else "Not Available"
        )
        valid_tsi = (
            subset["Time since SCI (years)"].notna().sum()
            if "Time since SCI (years)" in subset.columns
            else 0
        )
        tsi_mean = (
            subset["Time since SCI (years)"].mean()
            if valid_tsi > _MIN_GROUP
            else "Not Available"
        )
        rows.append(
            [
                cohort,
                len(subset),
                subset["Age"].mean() if "Age" in subset.columns else np.nan,
                subset["Age"].std() if "Age" in subset.columns else np.nan,
                subset["BrainPAD"].mean() if "BrainPAD" in subset.columns else np.nan,
                subset["BrainPAD"].std() if "BrainPAD" in subset.columns else np.nan,
                subset["BrainAge"].mean() if "BrainAge" in subset.columns else np.nan,
                subset["BrainAge"].std() if "BrainAge" in subset.columns else np.nan,
                int((subset["Sex"] == "Male").sum())
                if "Sex" in subset.columns
                else np.nan,
                int((subset["Sex"] == "Female").sum())
                if "Sex" in subset.columns
                else np.nan,
                ais,
                tsi_mean,
                int(subset["Age"].isna().sum()) if "Age" in subset.columns else 0,
            ]
        )
    return pd.DataFrame(
        rows,
        columns=[
            "Cohort",
            "Participants",
            "Mean Age",
            "SD Age",
            "Mean BrainPAD",
            "SD BrainPAD",
            "Mean BrainAge",
            "SD BrainAge",
            "Num Male",
            "Num Female",
            "AIS Distribution",
            "Mean Time Since SCI",
            "N without age",
        ],
    )


def _save_fig(path: str) -> None:
    """Save the current matplotlib figure, creating its parent dir, then close."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    plt.savefig(path)
    plt.close("all")


def _write_csv(frame: pd.DataFrame, path: str, *, index: bool = False) -> None:
    """Write a data frame to CSV, creating the parent directory first."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    frame.to_csv(path, index=index)


def _expand_cohort_legend(legend: object | None) -> None:
    """Expand cohort compatibility codes in a Matplotlib legend."""
    if legend is None or not hasattr(legend, "get_texts"):
        return
    for text in legend.get_texts():
        text.set_text(COHORT_DISPLAY.get(text.get_text(), text.get_text()))


def _expand_cohort_ticks(ax: object, order: tuple[str, ...] = COHORT_ORDER) -> None:
    """Expand ordered cohort compatibility codes on one categorical axis."""
    ax.set_xticks(
        range(len(order)),
        labels=[COHORT_DISPLAY[cohort] for cohort in order],
    )


def _recognized_cohorts(df: pd.DataFrame) -> pd.DataFrame:
    """Return rows whose cohort code has an established figure encoding."""
    return df[df["Cohort"].isin(COHORT_ORDER)]


def _boxplot_without_legend(**kwargs: object) -> object:
    """Draw a Seaborn boxplot and remove its automatically created legend.

    Seaborn 0.12 does not accept the later ``legend`` keyword on ``boxplot``.
    Removing the legend from the returned axes works across both APIs.
    """
    ax = sns.boxplot(**kwargs)
    legend = ax.get_legend()
    if legend is not None:
        legend.remove()
    return ax


def _fig_brainpad_box(df: pd.DataFrame, path: str) -> None:
    """Plot Brain-PAD across cohorts with points and means."""
    plot_df = _recognized_cohorts(df)
    plt.figure(figsize=(10, 6))
    ax = _boxplot_without_legend(
        x="Cohort",
        y="BrainPAD",
        hue="Cohort",
        data=plot_df,
        order=list(COHORT_ORDER),
        hue_order=list(COHORT_ORDER),
        palette=COHORT_PALETTE,
        dodge=False,
        showfliers=False,
        width=0.6,
        boxprops={"alpha": 0.5},
    )
    sns.stripplot(
        x="Cohort",
        y="BrainPAD",
        data=plot_df,
        order=list(COHORT_ORDER),
        color="black",
        jitter=True,
        size=6,
        alpha=0.7,
        ax=ax,
    )
    means = plot_df.groupby("Cohort")["BrainPAD"].mean()
    mean_handle = None
    for i, cohort in enumerate(COHORT_ORDER):
        if cohort in means.index:
            handle = ax.scatter(
                i,
                means[cohort],
                color="black",
                marker="^",
                s=100,
                label="_nolegend_",
            )
            if mean_handle is None:
                mean_handle = handle
    n = len(plot_df.dropna(subset=["Cohort", "BrainPAD"]))
    _expand_cohort_ticks(ax)
    if mean_handle is not None:
        ax.legend(
            handles=[mean_handle],
            labels=["Mean"],
            title="Summary",
            frameon=False,
        )
    ax.set_title(f"Brain-PAD by cohort (n={n})", fontsize=16, fontweight="bold")
    ax.set_xlabel("Cohort", fontsize=14, fontweight="bold")
    ax.set_ylabel("Brain-PAD (years)", fontsize=14, fontweight="bold")
    ax.grid(alpha=0.3)
    plt.tight_layout()
    _save_fig(path)


def _fig_chrono_vs_brainage(df: pd.DataFrame, path: str) -> None:
    """Plot chronological age against predicted brain age with a y=x line."""
    plot_df = _recognized_cohorts(df)
    plt.figure(figsize=(10, 6))
    ax = sns.scatterplot(
        x="Age",
        y="BrainAge",
        hue="Cohort",
        hue_order=COHORT_ORDER,
        style="Cohort",
        style_order=COHORT_ORDER,
        markers=COHORT_MARKERS,
        data=plot_df,
        palette=COHORT_PALETTE,
        alpha=0.7,
        s=70,
        edgecolor="black",
    )
    lo, hi = plot_df["Age"].min(), plot_df["Age"].max()
    ax.plot(
        [lo, hi],
        [lo, hi],
        "k--",
        alpha=0.8,
        label="Identity (predicted = chronological)",
    )
    n = len(plot_df.dropna(subset=["Age", "BrainAge", "Cohort"]))
    ax.set_title(
        f"Chronological age and predicted brain age (n={n})",
        fontsize=16,
        fontweight="bold",
    )
    ax.set_xlabel("Chronological age (years)", fontsize=14, fontweight="bold")
    ax.set_ylabel("Predicted brain age (years)", fontsize=14, fontweight="bold")
    ax.legend(frameon=False)
    _expand_cohort_legend(ax.get_legend())
    plt.tight_layout()
    _save_fig(path)


def _fig_brainpad_vs_age(df: pd.DataFrame, path: str) -> None:
    """Plot per-cohort Brain-PAD against age with trend lines."""
    plot_df = _recognized_cohorts(df)
    grid = sns.lmplot(
        data=plot_df,
        x="Age",
        y="BrainPAD",
        hue="Cohort",
        hue_order=COHORT_ORDER,
        palette=COHORT_PALETTE,
        markers=[COHORT_MARKERS[cohort] for cohort in COHORT_ORDER],
        ci=None,
        height=6,
        aspect=1.5,
    )
    grid.set_axis_labels("Chronological age (years)", "Brain-PAD (years)")
    n = len(plot_df.dropna(subset=["Age", "BrainPAD", "Cohort"]))
    grid.figure.suptitle(
        f"Brain-PAD and chronological age by cohort (n={n})", fontweight="bold"
    )
    _expand_cohort_legend(grid._legend)
    grid.figure.tight_layout()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    grid.savefig(path)
    plt.close("all")


def _fig_brainpad_by_sex(df: pd.DataFrame, path: str) -> None:
    """Plot side-by-side Brain-PAD boxes for female and male participants."""
    plot_df = _recognized_cohorts(df)
    df_female = plot_df[plot_df["Sex"] == "Female"]
    df_male = plot_df[plot_df["Sex"] == "Male"]
    _fig, axes = plt.subplots(nrows=1, ncols=2, figsize=(14, 6), sharey=True)
    for ax, data, label in ((axes[0], df_female, "Female"), (axes[1], df_male, "Male")):
        _boxplot_without_legend(
            x="Cohort",
            y="BrainPAD",
            hue="Cohort",
            data=data,
            order=list(COHORT_ORDER),
            hue_order=list(COHORT_ORDER),
            palette=COHORT_PALETTE,
            dodge=False,
            showfliers=False,
            width=0.6,
            ax=ax,
        )
        sns.stripplot(
            x="Cohort",
            y="BrainPAD",
            data=data,
            order=list(COHORT_ORDER),
            jitter=True,
            size=8,
            alpha=0.7,
            color="black",
            ax=ax,
        )
        ax.set_title(
            f"Brain-PAD - {label.lower()} participants "
            f"(n={len(data.dropna(subset=['Cohort', 'BrainPAD']))})",
            fontsize=14,
            fontweight="bold",
        )
        ax.set_xlabel("Cohort", fontsize=12, fontweight="bold")
        _expand_cohort_ticks(ax)
    axes[0].set_ylabel("Brain-PAD (years)", fontsize=12, fontweight="bold")
    plt.suptitle(
        "Brain-PAD by cohort and sex",
        fontsize=16,
        fontweight="bold",
    )
    plt.tight_layout()
    _save_fig(path)


def _fig_brainpad_vs_tsi(df: pd.DataFrame, path: str) -> None:
    """Plot Brain-PAD against time since injury and annotate the OLS result."""
    # Select the exact validated column name; renaming a trailing-space
    # variant here would duplicate the column and break the numeric cast.
    df_sci = df[df["Cohort"].isin(["SCI_nNP", "SCI_P"])].copy()
    df_sci = df_sci[["Time since SCI (years)", "BrainPAD", "Cohort"]].dropna()
    df_sci["Time since SCI (years)"] = pd.to_numeric(
        df_sci["Time since SCI (years)"], errors="coerce"
    )
    df_sci = df_sci.dropna(subset=["Time since SCI (years)"])

    annotation = f"n = {len(df_sci)}"
    if len(df_sci) >= _MIN_GROUP:
        x = sm.add_constant(df_sci["Time since SCI (years)"])
        model = sm.OLS(df_sci["BrainPAD"], x, missing="drop").fit()
        annotation += (
            f"; pooled OLS: R^2 = {model.rsquared:.3f}, "
            f"p = {model.pvalues['Time since SCI (years)']:.3f}"
        )

    plt.figure(figsize=(10, 6))
    ax = sns.scatterplot(
        x="Time since SCI (years)",
        y="BrainPAD",
        hue="Cohort",
        hue_order=("SCI_nNP", "SCI_P"),
        style="Cohort",
        style_order=("SCI_nNP", "SCI_P"),
        markers={key: COHORT_MARKERS[key] for key in ("SCI_nNP", "SCI_P")},
        data=df_sci,
        palette=COHORT_PALETTE,
        s=70,
        alpha=0.8,
        edgecolor="black",
    )
    ax.set_xlabel("Time since injury (years)", fontsize=14, fontweight="bold")
    ax.set_ylabel("Brain-PAD (years)", fontsize=14, fontweight="bold")
    ax.set_title(
        "Brain-PAD and time since injury in SCI cohorts",
        fontsize=16,
        fontweight="bold",
    )
    ax.annotate(
        annotation,
        xy=(0.025, 0.9),
        xycoords="axes fraction",
        fontsize=12,
        fontweight="bold",
    )
    _expand_cohort_legend(ax.get_legend())
    ax.grid(alpha=0.3)
    plt.tight_layout()
    _save_fig(path)


def _cohort_comparisons(df: pd.DataFrame, *, normal: bool) -> pd.DataFrame:
    """Compare Brain-PAD pairwise across cohorts."""
    rows: list[list[object]] = []
    for group1, group2 in combinations(COHORT_ORDER, 2):
        a = df[df["Cohort"] == group1]["BrainPAD"]
        b = df[df["Cohort"] == group2]["BrainPAD"]
        test, p_value, effect = _two_group(a, b, normal=normal)
        rows.append(
            [
                group1,
                group2,
                test,
                p_value,
                effect,
                f"n1={a.dropna().size}, n2={b.dropna().size}",
            ]
        )
    return pd.DataFrame(
        rows,
        columns=[
            "Group1",
            "Group2",
            "Test Used",
            "p-value",
            "Effect Size",
            "Sample Size",
        ],
    )


def _sex_comparisons(df: pd.DataFrame, *, normal: bool) -> pd.DataFrame:
    """Compare Brain-PAD pairwise across cohorts within each sex."""
    rows: list[list[object]] = []
    for sex in ("Female", "Male"):
        sub = df[df["Sex"] == sex]
        for group1, group2 in combinations(COHORT_ORDER, 2):
            a = sub[sub["Cohort"] == group1]["BrainPAD"]
            b = sub[sub["Cohort"] == group2]["BrainPAD"]
            test, p_value, effect = _two_group(a, b, normal=normal)
            rows.append(
                [
                    sex,
                    group1,
                    group2,
                    test,
                    p_value,
                    effect,
                    f"n1={a.dropna().size}, n2={b.dropna().size}",
                ]
            )
    return pd.DataFrame(
        rows,
        columns=[
            "Sex",
            "Group1",
            "Group2",
            "Test Used",
            "p-value",
            "Effect Size",
            "Sample Size",
        ],
    )


def _ais_row_is_eligible(cohort: str, *, ais_missing: bool) -> bool:
    """Return whether one row belongs in the AIS-grade analysis."""
    return cohort == "control" or not ais_missing


def _ais_comparisons(df: pd.DataFrame) -> pd.DataFrame:
    """Compare Brain-PAD pairwise across AIS grades and controls."""
    frame = df[df["Cohort"].isin(COHORT_ORDER)].copy()
    frame = frame[["AIS", "Cohort", "BrainPAD"]].replace([np.inf, -np.inf], np.nan)
    frame = frame.dropna(subset=["Cohort", "BrainPAD"])
    eligible = [
        _ais_row_is_eligible(str(cohort), ais_missing=bool(pd.isna(ais)))
        for ais, cohort in frame[["AIS", "Cohort"]].itertuples(index=False, name=None)
    ]
    frame = frame.loc[eligible]
    frame["AIS"] = frame["AIS"].astype(str)
    normal = _is_normal(frame["BrainPAD"])
    # Restrict every AIS grade group to SCI rows so a control that carries a
    # grade contributes only to the control group; otherwise the same
    # observation would sit in both samples of one two-sample test.
    sci = frame["Cohort"] != "control"
    rows: list[list[object]] = []
    for group1, group2 in combinations(AIS_ORDER, 2):
        a = (
            frame[frame["Cohort"] == "control"]["BrainPAD"]
            if group1 == "control"
            else frame[sci & (frame["AIS"] == group1)]["BrainPAD"]
        )
        b = (
            frame[frame["Cohort"] == "control"]["BrainPAD"]
            if group2 == "control"
            else frame[sci & (frame["AIS"] == group2)]["BrainPAD"]
        )
        test, p_value, effect = _two_group(a, b, normal=normal)
        rows.append(
            [
                group1,
                group2,
                test,
                p_value,
                effect,
                f"n1={a.dropna().size}, n2={b.dropna().size}",
            ]
        )
    return pd.DataFrame(
        rows,
        columns=[
            "Group 1",
            "Group 2",
            "Test Used",
            "p-value",
            "Effect Size",
            "Sample Sizes",
        ],
    )


def _chi2_ais(df: pd.DataFrame) -> pd.DataFrame:
    """Test the AIS distribution across SCI cohorts with chi-square."""
    sci = df[df["Cohort"].isin(["SCI_P", "SCI_nNP"])]
    table = pd.crosstab(sci["Cohort"], sci["AIS"])
    if table.empty or table.shape[0] < _MIN_GROUP or table.shape[1] < _MIN_GROUP:
        return pd.DataFrame(
            {
                "Chi-Square Statistic": [float("nan")],
                "Degrees of Freedom": [0],
                "p-value": [float("nan")],
            }
        )
    chi2_stat, p_value, dof, _expected = stats.chi2_contingency(table)
    return pd.DataFrame(
        {
            "Chi-Square Statistic": [chi2_stat],
            "Degrees of Freedom": [dof],
            "p-value": [p_value],
        }
    )


def _tsi_comparison(df: pd.DataFrame) -> pd.DataFrame:
    """Compare time-since-injury between the two SCI cohorts."""
    sci = df[df["Cohort"].isin(["SCI_P", "SCI_nNP"])].copy()
    sci["Time since SCI (years)"] = pd.to_numeric(
        sci["Time since SCI (years)"], errors="coerce"
    )
    sci = sci.dropna(subset=["Time since SCI (years)"])
    a = sci[sci["Cohort"] == "SCI_P"]["Time since SCI (years)"]
    b = sci[sci["Cohort"] == "SCI_nNP"]["Time since SCI (years)"]
    normal = _is_normal(sci["Time since SCI (years)"])
    test, p_value, effect = _two_group(a, b, normal=normal)
    return pd.DataFrame(
        {
            "Test": [test],
            "p-Value": [p_value],
            "Effect Size": [effect],
            "n_SCI_P": [a.size],
            "n_SCI_nNP": [b.size],
        }
    )


def _age_comparisons(df: pd.DataFrame, *, normal: bool) -> pd.DataFrame:
    """Compare chronological age pairwise across cohorts."""
    rows: list[list[object]] = []
    for group1, group2 in combinations(COHORT_ORDER, 2):
        a = df[df["Cohort"] == group1]["Age"]
        b = df[df["Cohort"] == group2]["Age"]
        test, p_value, effect = _two_group(a, b, normal=normal)
        rows.append([group1, group2, test, p_value, effect])
    return pd.DataFrame(
        rows,
        columns=["Group1", "Group2", "Test Used", "p-value", "Effect Size"],
    )


def _render_outputs(df: pd.DataFrame, outputs: list[str]) -> None:
    """Render the twelve Brain-PAD outputs into one unpublished directory.

    Draw every Brain-PAD statistic, test, and figure from the subjects that
    carry a Brain-PAD. The summary table, the AIS distribution, the
    time-since-injury comparison, and the chronological-age comparison keep
    the whole validated cohort.
    """
    paired = _with_brainpad(df)
    normal = _is_normal(paired["BrainPAD"])
    np.random.seed(0)
    _write_csv(_summary_table(df), outputs[0])
    _fig_brainpad_box(paired, outputs[1])
    _fig_chrono_vs_brainage(paired, outputs[2])
    _fig_brainpad_vs_age(paired, outputs[3])
    _fig_brainpad_by_sex(paired, outputs[4])
    _fig_brainpad_vs_tsi(paired, outputs[5])
    _write_csv(_cohort_comparisons(paired, normal=normal), outputs[6])
    _write_csv(_sex_comparisons(paired, normal=normal), outputs[7])
    _write_csv(_ais_comparisons(paired), outputs[8])
    _write_csv(_chi2_ais(df), outputs[9])
    _write_csv(_tsi_comparison(df), outputs[10])
    _write_csv(_age_comparisons(df, normal=normal), outputs[11])


def _sha256_file(path: Path) -> str:
    """Hash one generated regular file before publication."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        chunk = handle.read(1024 * 1024)
        while chunk:
            digest.update(chunk)
            chunk = handle.read(1024 * 1024)
    return digest.hexdigest()


def _publish_outputs(staged: list[Path], outputs: list[str]) -> None:
    """Publish files, then atomically bind the complete set with one manifest."""
    parent = Path(outputs[0]).parent
    entries: list[dict[str, object]] = []
    for source, destination in zip(staged, outputs):
        size = source.stat().st_size
        if size <= 0 or not source.is_file() or source.is_symlink():
            raise ValueError(f"Create a nonempty regular Brain-PAD output: {source.name}.")
        entries.append(
            {"name": Path(destination).name, "size": size, "sha256": _sha256_file(source)}
        )
    for source, destination in zip(staged, outputs):
        os.replace(source, destination)
    if hasattr(os, "O_DIRECTORY"):
        descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    payload = (
        json.dumps(
            {"schemaVersion": 1, "files": entries},
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        + b"\n"
    )
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{MANIFEST_BASENAME}-", dir=parent
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, parent / MANIFEST_BASENAME)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run(input_xlsx: str, outputs: list[str]) -> None:
    """Validate input and publish one complete twelve-artifact generation.

    Read the Step 6 ``predicted_results.xlsx`` workbook. Take ``outputs`` in
    adapter order: the summary CSV and five figures, then the cohort, sex, AIS,
    chi-square, time-since-injury, and chronological-age tables.
    """
    if len(outputs) != N_OUTPUTS or len(set(outputs)) != N_OUTPUTS:
        raise ValueError("Provide twelve unique Brain-PAD output paths.")
    parents = {os.path.abspath(os.path.dirname(path) or ".") for path in outputs}
    if len(parents) != 1:
        raise ValueError("Keep all Brain-PAD outputs in one directory.")
    parent = Path(next(iter(parents)))
    parent.mkdir(parents=True, exist_ok=True)
    df = _validate_scientific_input(_read_input_workbook(input_xlsx))
    excluded = _without_brainpad(df)
    if excluded:
        sys.stderr.write(
            f"Excluded {len(excluded)} subject(s) without a chronological age "
            f"from Brain-PAD statistics: {_bounded_ids(excluded)}\n"
        )
    stage_dir = Path(tempfile.mkdtemp(prefix=".brainpad-generation-", dir=parent))
    staged = [stage_dir / Path(path).name for path in outputs]
    try:
        _render_outputs(df, [str(path) for path in staged])
        _publish_outputs(staged, outputs)
    finally:
        shutil.rmtree(stage_dir, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    """Run ``brainpadstats.py <input_xlsx> <out1> ... <out12>``."""
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 + N_OUTPUTS:
        sys.stderr.write(
            f"Run: brainpadstats.py <input_xlsx> "
            f"<out1> ... <out{N_OUTPUTS}> (got {len(args)} args).\n"
        )
        return 2
    run(args[0], args[1:])
    return 0


if __name__ == "__main__":
    sys.exit(main())
