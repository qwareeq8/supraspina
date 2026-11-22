"""Actionable refusal messages written for the operator instead of the log.

An ordinary exception message is never published to the window because it can
carry absolute paths, subject ids, and incidental interpreter detail; the
exception class alone takes its place. Deliberate, actionable refusals are
distinguished from crashes: the dispatcher publishes the message of an
:class:`OperatorError` and, by the sidecar's validation convention, of a
``ValueError`` raised while rejecting untrusted input, redacted in both cases.

:class:`OperatorError` marks that distinction. Its message is authored for the
window without interpolated host state, and it is redacted again before
publication.
"""

from __future__ import annotations


class OperatorError(Exception):
    """Represent a deliberate refusal that may be shown to the operator.

    Raise this only with a complete, self-contained sentence that says what was
    refused and what the operator can do about it. Never interpolate a path, a
    subject id, or a captured interpreter message into it.
    """
