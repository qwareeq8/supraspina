"""Deterministic redaction of private RPC, event, and debug-export data."""

from __future__ import annotations

import os
import re
from collections.abc import Iterable

_SECRET_MARKER = r"(?:token|secret|password|passwd|api[_-]?key|authorization)"  # noqa: S105
_SECRET_KEY = rf"(?:[A-Za-z0-9]+[_-])*{_SECRET_MARKER}(?:[_-][A-Za-z0-9]+)*"
_JSON_SECRET = re.compile(rf"(?i)([\"']{_SECRET_KEY}[\"']\s*:\s*)([\"'])[^\r\n]*?\2")
# The value alternation matches a full "bearer <credential>" first because
# ``_SECRET`` runs before ``_BEARER``: without it the unquoted alternative would
# consume only the scheme word, and the credential after an Authorization-style
# key would survive into an exported bundle. Keep the credential on one line so
# a redacted value never swallows the following log line.
_SECRET = re.compile(
    rf"(?i)(\b{_SECRET_KEY}\b\s*[:=]\s*)"
    r"(?:bearer[ \t]+[A-Za-z0-9._~+/=-]+|\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;]+)"
)
# Redact a bearer credential that appears without a preceding secret key.
_BEARER = re.compile(r"(?i)(\bbearer\s+)[A-Za-z0-9._~+/=-]+")
_URL_CREDENTIALS = re.compile(r"(?i)(://)[^/@\s:]+:[^/@\s]+@")
_URL_QUERY_SECRET = re.compile(rf"(?i)([?&]{_SECRET_KEY}=)[^&#\s]+")
_ABSOLUTE = re.compile(r"(?<![A-Za-z0-9])(?:/[A-Za-z0-9._~@%+\-]+){2,}(?<!\.)")
_QUOTED_ABSOLUTE = re.compile(r"([\"'])(/(?!/)[^\"'\r\n]+)\1")
_WINDOWS = re.compile(r"(?i)(?:\b[A-Z]:\\|\\\\)[^\r\n,;\"']+")


def redact_secrets(text: str) -> str:
    """Remove only secret values, keeping paths and subject IDs readable.

    Text the operator reads about their own project, such as the live log
    tail, stays legible because the path and subject substitutions of
    :func:`redact_text` would replace the identifiers that make a line
    actionable. Only exports leaving the machine need those.
    """
    value = _JSON_SECRET.sub(lambda match: f'{match.group(1)}"[REDACTED]"', str(text))
    value = _SECRET.sub(lambda match: f"{match.group(1)}[REDACTED]", value)
    value = _BEARER.sub(lambda match: f"{match.group(1)}[REDACTED]", value)
    value = _URL_CREDENTIALS.sub(r"\1[REDACTED]@", value)
    return _URL_QUERY_SECRET.sub(lambda match: f"{match.group(1)}[REDACTED]", value)


def redact_text(
    text: str,
    *,
    project_root: str | None = None,
    sensitive_roots: Iterable[str] = (),
    subject_ids: Iterable[str] = (),
) -> str:
    """Remove common secret values, project paths, and exact subject IDs."""
    value = redact_secrets(text)
    roots = set(str(item) for item in sensitive_roots if item)
    if project_root:
        roots.add(project_root)
    variants: set[str] = set()
    for root in roots:
        variants.update({root, os.path.realpath(root), os.path.expanduser(root)})
    for variant in sorted((item for item in variants if item), key=len, reverse=True):
        value = value.replace(
            variant,
            "[PROJECT]"
            if project_root
            and variant
            in {
                project_root,
                os.path.realpath(project_root),
                os.path.expanduser(project_root),
            }
            else "[PATH]",
        )
    for subject_id in sorted(
        {str(item) for item in subject_ids if item}, key=len, reverse=True
    ):
        value = value.replace(subject_id, "[SUBJECT]")
    value = _WINDOWS.sub("[PATH]", value)
    value = _QUOTED_ABSOLUTE.sub(
        lambda match: f"{match.group(1)}[PATH]{match.group(1)}", value
    )
    value = _ABSOLUTE.sub("[PATH]", value)
    return value


def safe_error(exc: BaseException) -> str:
    """Return only a stable exception class, never its sensitive message."""
    return f"{type(exc).__name__}: operation failed"
