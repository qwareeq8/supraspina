"""The measure and variable catalog of one project.

Measures come in two tiers. The pipeline tables: the headers of the
aggregation tables (``dk_all_stats.csv``, ``cortical_thickness.csv``,
``icv_data.csv``) and the Brain-PAD table (stages ``aggregate`` and
``pybrainage``). Each subject's FreeSurfer stats files (tier A, stage
``recon``): the regions the first five readable subjects carry, available
when any subject has the file (``sources.catalog_measures``). Grouping and
covariate variables come from the subject registry (``site`` included) and
the age, clinical, and metadata CSVs; imported tables are listed apart. When
a table is missing, its measures are still listed (the standard
Desikan-Killiany regions and FreeSurfer 8 aseg structures) as unavailable
with the reason, so the panel can disable the family and say which stage
writes it.
"""

from __future__ import annotations

from typing import Any

from .dataset import (
    ASEG_STRUCTURES,
    DK_REGIONS,
    AnalysisContext,
    Table,
    Tables,
    catalog_variables,
    measure_columns,
)
from .sources import catalog_measures
from .spec import (
    DK_METRICS,
    MAX_MEASURES_V2,
    is_extensive,
    measure_family,
    parse_measure_id,
)

_MAX_MEASURES = MAX_MEASURES_V2
_DK_COLUMN_PARTS = 3


def _dk_ids(table: Table) -> list[str]:
    """Return the DK measure IDs the header carries, bilateral means included."""
    regions: list[str] = []
    columns: set[tuple[str, str, str]] = set()
    if not table.usable:
        regions = list(DK_REGIONS)
        columns = {
            (hemi, region, metric)
            for hemi in ("lh", "rh")
            for region in regions
            for metric in DK_METRICS
        }
    for column in table.header if table.usable else ():
        parts = column.split("_")
        if (
            len(parts) == _DK_COLUMN_PARTS
            and parts[0] in {"lh", "rh"}
            and parts[2] in DK_METRICS
        ):
            columns.add((parts[0], parts[1], parts[2]))
            if parts[1] not in regions:
                regions.append(parts[1])
    ids: list[str] = []
    for metric in DK_METRICS:
        for region in regions:
            present = [h for h in ("lh", "rh") if (h, region, metric) in columns]
            hemis = [*present, "bi"] if len(present) == 2 else present  # noqa: PLR2004
            for hemi in hemis:
                measure_id = f"dk:{hemi}:{region}:{metric}"
                if parse_measure_id(measure_id) is not None:
                    ids.append(measure_id)
    return ids


def _aseg_ids(table: Table) -> list[str]:
    """Return the aseg measure IDs the header carries, bilateral means included."""
    if table.usable:
        structures = [
            column
            for column in table.header
            if not column.startswith(("lh_", "rh_"))
            and column != "subject"
            and parse_measure_id(f"aseg:{column}") is not None
        ]
    else:
        structures = list(ASEG_STRUCTURES)
    ids = [f"aseg:{name}" for name in structures]
    names = set(structures)
    for name in structures:
        if name.startswith("Left-") and f"Right-{name[5:]}" in names:
            measure_id = f"aseg:bi:{name[5:]}"
            if parse_measure_id(measure_id) is not None:
                ids.append(measure_id)
    return ids


def _entry(measure_id: str, table: Table, stage: str) -> dict[str, Any]:
    parts = parse_measure_id(measure_id)
    assert parts is not None  # noqa: S101 - every ID here is built to the grammar.
    reason: str | None
    if not table.present:
        reason = table.reason
    elif table.reason is not None:
        reason = f"The table cannot be read: {table.reason}"[:512]
    else:
        missing = [c for c in measure_columns(measure_id) if c not in table.header]
        reason = f"The table has no {missing[0]} column." if missing else None
    return {
        "measureId": measure_id,
        "source": parts.source,
        "family": measure_family(measure_id),
        "extensive": is_extensive(measure_id),
        "stage": stage,
        "available": reason is None,
        "unavailableReason": reason,
    }


def build_catalog(context: AnalysisContext) -> dict[str, Any]:
    """Return the ``groupAnalysis.catalog`` payload.

    Returns
    -------
    dict
        The ``GroupAnalysisCatalog`` payload.
    """
    tables = Tables(context)
    dk = tables.get("dk-all-stats")
    measures = [_entry(m, dk, "aggregate") for m in _dk_ids(dk)]
    measures += [_entry(m, dk, "aggregate") for m in _aseg_ids(dk)]
    measures.append(_entry("global:eTIV", tables.get("icv"), "aggregate"))
    measures.append(
        _entry("global:meanThickness", tables.get("cortical-thickness"), "aggregate")
    )
    measures.append(_entry("brainage:BrainPAD", tables.get("brainage"), "pybrainage"))
    measures += catalog_measures(context, tables)
    return {
        "configRevision": context.config_revision,
        "measures": measures[:_MAX_MEASURES],
        "variables": catalog_variables(context, tables),
        "inputs": [table.public() for table in tables.all()],
    }
