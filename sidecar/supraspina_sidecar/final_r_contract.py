"""The R analysis (upstream Step 9) command-line and table contract for sites.

The registry projection, ``adapters/final.py``, ``resources/step9/``, and the
BrainCharts and z-score stages share this contract. This module only documents
and names it; nothing here is a receipt input.

Raw track (the ``final`` stage). The raw track takes no ``--track`` flag, so
the stage's execution action stays stable::

    FreesurferAnalysisScript.R <structural_dir> <metadata_csv> <out_dir>
        <start_column> <cortical_split> <control,pain,nopain,pooled>
    FreesurferAnalysisScript.R --render-report <template.Rmd>
        <structural_dir> <metadata_csv> <out_dir>
        <start_column> <cortical_split> <control,pain,nopain,pooled>

The ``metadata_csv`` projection carries a ``Site`` column: the registry
label, or an empty string when unset. It replaces a source ``Site`` or
``site`` column, as the projection replaces ``Cohort``. The script reads it
when present:

- No ``Site`` column, every value empty, or one distinct label: no site
  rule, so a single-site project produces the tables of a run without sites.
- Some values empty and some set: refused. The planner already blocks
  ``final`` in that state (``sites.site_state`` mode ``mixed``).
- Otherwise, per comparison and after pooling (IvH pools pain and no-pain),
  keep only the sites with at least one subject in each compared group,
  counted on the merged metadata and ``dk_all_stats.csv`` rows. The rule
  applies to all four comparisons, nNPvP included.

Every raw-track run writes :data:`SITE_EXCLUSIONS_FILE` with
:data:`SITE_EXCLUSIONS_COLUMNS`, header only when nothing is excluded: one
row per excluded site and comparison, the subject IDs joined by ``;`` in
sorted order.

Z-score track (the ``zstats`` stage). The flag comes first and the input is
the BrainCharts z-score table::

    FreesurferAnalysisScript.R --track zscores <zscores_csv> <out_dir>
        <control,pain,nopain,pooled>
    FreesurferAnalysisScript.R --track zscores --render-report
        <template.Rmd> <zscores_csv> <out_dir> <control,pain,nopain,pooled>

``zscores_csv`` holds :data:`ZSCORE_ID_COLUMNS` and one
``<idp>`` + :data:`ZSCORE_SUFFIX` column per BrainCharts region. Its
``cohort`` values are ``control``, ``SCI_nNP``, and ``SCI_P``, and ``sex``
keeps the BrainCharts coding (0 female, 1 male). The cortical
block (``SCI``) is the columns ending in :data:`ZSCORE_THICKNESS_SUFFIX`
(150); the subcortical block (``SUB``) is the other z-score columns (37).
No site rule applies, because adaptation removes each site's offset, and
refused sites have no rows. ``out_dir`` is the ``zstats`` stage's own
directory, never the ``final`` one. Tables use :data:`ZSCORE_TABLE_PREFIX`,
the same extensions and columns, and the same all-eight-tables rule.

The BrainCharts stage also writes :data:`REFUSED_SITES_FILE` beside the
z-score table, one row per refused site with
:data:`REFUSED_SITES_COLUMNS`: the site label, how many subjects it holds,
their IDs joined by ``;`` in sorted order, and the stated reason (for
example "Site B has no controls, so the model cannot be adapted to it;
its 4 subjects get no z-scores."). It is header only when no site is
refused, so the z-score report can state "Site B was refused by
BrainCharts and has no rows." without reading the split.

Result tables (both tracks). The comparison codes name the focal
group first and the reference group second, and every effect is reference
minus focal, as upstream's ``esvis::hedg_g`` computes it: control minus SCI
for PvH, nNPvH, and IvH, and SCI_P minus SCI_nNP for nNPvP. The Welch
``t_statistic`` has the same sign. Each table names its groups in
``Group_ref`` and ``Group_foc`` and states the difference in ``Direction``
(``"<ref> minus <foc>"``). The Analysis panel keeps SCI minus
control; only R analysis tables follow upstream's sign.
"""

from __future__ import annotations

from typing import Final

# The R flag that selects a track; absent means the raw track.
TRACK_FLAG: Final = "--track"
TRACK_RAW: Final = "raw"
TRACK_ZSCORES: Final = "zscores"

# The Final metadata projection's site column.
SITE_COLUMN: Final = "Site"

# The per-comparison (reference, focal) positions in the cohorts argument
# (control, pain, nopain, pooled).
COMPARISON_GROUPS: Final[dict[str, tuple[str, str]]] = {
    "PvH": ("control", "pain"),
    "nNPvH": ("control", "nopain"),
    "nNPvP": ("pain", "nopain"),
    "IvH": ("control", "pooled"),
}

RESULT_COLUMNS: Final = (
    "Region",
    "p_value",
    "Group_ref",
    "Mean_ref",
    "SD_ref",
    "N_ref",
    "Group_foc",
    "Mean_foc",
    "SD_foc",
    "N_foc",
    "t_statistic",
    "Hedges_g",
    "SE_Hedges_g",
    "CI_lower",
    "CI_upper",
    "Direction",
)

SITE_EXCLUSIONS_FILE: Final = "site_exclusions.csv"
SITE_EXCLUSIONS_COLUMNS: Final = (
    "comparison",
    "site",
    "n_ref",
    "n_focal",
    "excluded_subjects",
    "reason",
)

# The BrainCharts z-score table, which the ``zstats`` stage reads.
ZSCORES_FILE: Final = "braincharts_zscores.csv"
ZSCORE_ID_COLUMNS: Final = ("subject", "siteLabel", "cohort", "age", "sex")
ZSCORE_SUFFIX: Final = "_zscore"
ZSCORE_THICKNESS_SUFFIX: Final = "_thickness_zscore"
ZSCORE_COHORTS: Final = ("control", "SCI_nNP", "SCI_P")
ZSCORE_TABLE_PREFIX: Final = "Z_"
REFUSED_SITES_FILE: Final = "braincharts_refused_sites.csv"
REFUSED_SITES_COLUMNS: Final = ("site", "subjects", "subject_ids", "reason")
