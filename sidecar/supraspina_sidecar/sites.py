"""Site labels and the project's site state.

A site is one acquisition batch: a scanner plus protocol. One physical center
with two scanners is two sites. The registry stores a ``site`` key only when a
site is set, so a record without one serializes without it and the receipts
that bind the registry bytes stay current. Unset everywhere means one site, the
behavior of a project without sites.

The module is pure and outside ``adapters/``, so no receipt hashes it. The
planner's mixed-site blocker, the BrainCharts projection, and the Analysis
design check all read :func:`site_state`. ``src/shared/sites.ts`` mirrors the
label rule, and ``tests/fixtures/sites/site-labels.json`` binds both sides.
"""

from __future__ import annotations

import re
from collections.abc import Collection, Iterable, Mapping
from typing import Any, Literal, TypedDict

MAX_SITE_LABEL_LENGTH = 64
SITE_LABEL_PATTERN = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9._-])?$"
)
SITE_LABEL_RULE = (
    "Use a site label of 1 to 64 letters, digits, spaces, periods, underscores, "
    "or hyphens, or leave the value empty."
)
# The most subjects one registry.setSite request may name (like an import).
MAX_SET_SITE_SUBJECTS = 20_000
# Trim ASCII whitespace only, as sites.ts does, so both sides agree.
_EDGE_WHITESPACE = " \t\n\r\f\v"

SiteMode = Literal["none", "complete", "mixed"]
# The registry's cohort roles (registry_store._COHORT_ROLES), in a fixed order.
COHORT_ROLES = (
    "healthy",
    "sci-no-neuropathic-pain",
    "sci-neuropathic-pain",
    "ambiguous",
)


class SiteSummary(TypedDict):
    """Represent one site's subjects, counted by cohort role."""

    site: str
    subjects: int
    # Every cohort role of registry_store._COHORT_ROLES, including zeros.
    roles: dict[str, int]


class SiteState(TypedDict):
    """Represent the sites of a set of subjects.

    ``mode`` is ``none`` when no subject has a site (one implicit site),
    ``complete`` when every subject has one,
    and ``mixed`` otherwise. ``unset`` lists the subjects without a site in
    sorted order, and ``sites`` lists each label once in sorted order.
    """

    mode: SiteMode
    unset: list[str]
    sites: list[SiteSummary]


def is_site_label(value: object) -> bool:
    """Return whether ``value`` is a canonical (trimmed, valid) site label."""
    return isinstance(value, str) and SITE_LABEL_PATTERN.fullmatch(value) is not None


def normalize_site_label(value: object) -> str | None:
    """Return the canonical site label, or None for an unset site.

    None and blank text mean unset. Raise ``ValueError`` with
    :data:`SITE_LABEL_RULE` for any other value outside the rule.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(SITE_LABEL_RULE)
    label = value.strip(_EDGE_WHITESPACE)
    if not label:
        return None
    if not is_site_label(label):
        raise ValueError(SITE_LABEL_RULE)
    return label


def site_label_conflict(label: str, existing: Iterable[str]) -> str | None:
    """Return an existing label that differs from ``label`` only in case.

    Labels are case-sensitive, but ``Prisma`` next to ``prisma`` is refused,
    because it would split one scanner into two sites.
    """
    folded = label.lower()
    for candidate in existing:
        if candidate != label and candidate.lower() == folded:
            return candidate
    return None


def site_conflict_message(conflict: str) -> str:
    """Return the refusal for a label that differs from ``conflict`` in case."""
    return (
        f"Use the existing site label {conflict}; the two labels differ only "
        "in letter case."
    )


def site_state(
    records: Iterable[Mapping[str, Any]],
    subject_ids: Collection[str] | None = None,
) -> SiteState:
    """Summarize the sites of ``subject_ids`` (every record when None).

    ``records`` are registry records (``RegistryStore.list`` rows or stored
    records); a record without a ``site`` key, or with ``None``, is unset. A
    requested subject without a record counts as unset.
    """
    by_id = {
        str(record.get("subjectId")): record
        for record in records
        if isinstance(record.get("subjectId"), str)
    }
    wanted = sorted(by_id) if subject_ids is None else sorted(set(subject_ids))
    unset: list[str] = []
    summaries: dict[str, SiteSummary] = {}
    for subject_id in wanted:
        record = by_id.get(subject_id)
        site = record.get("site") if record is not None else None
        if not isinstance(site, str):
            unset.append(subject_id)
            continue
        summary = summaries.setdefault(
            site,
            {
                "site": site,
                "subjects": 0,
                "roles": dict.fromkeys(COHORT_ROLES, 0),
            },
        )
        summary["subjects"] += 1
        role = record.get("cohortRole") if record is not None else None
        # Stored roles are validated on read; count anything else as unresolved.
        summary["roles"][role if role in COHORT_ROLES else "ambiguous"] += 1
    mode: SiteMode
    if not summaries:
        mode = "none"
    elif unset:
        mode = "mixed"
    else:
        mode = "complete"
    return {
        "mode": mode,
        "unset": unset,
        "sites": [summaries[label] for label in sorted(summaries)],
    }
