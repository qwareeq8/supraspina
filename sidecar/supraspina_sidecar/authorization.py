"""One-use project-, revision-, and purpose-bound authorization checks."""

from __future__ import annotations

import hashlib
import threading
from typing import Any

_MIN_TOKEN_LENGTH = 16
_MAX_TOKEN_LENGTH = 4096


class AuthorizationError(PermissionError):
    """Reject absent, mismatched, or already consumed authorization."""


class PlanStaleError(ValueError):
    """Reject a reviewed plan that no longer matches current execution inputs."""

    def __init__(self) -> None:
        super().__init__("Review the stale plan again.")


class AuthorizationLedger:
    """Consume opaque main-issued tokens exactly once within a sidecar lifetime."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._consumed: set[str] = set()

    def consume(
        self,
        authorization: Any,
        *,
        project_id: str,
        config_revision: int,
        purpose: str,
    ) -> None:
        """Validate the non-secret envelope and consume its opaque token digest."""
        if not isinstance(authorization, dict):
            raise AuthorizationError(f"Provide {purpose} authorization.")
        token = str(authorization.get("token", ""))
        if len(token) < _MIN_TOKEN_LENGTH or len(token) > _MAX_TOKEN_LENGTH:
            raise AuthorizationError("Provide a valid execution authorization token.")
        if str(authorization.get("projectId", "")) != project_id:
            raise AuthorizationError("Match the execution authorization project.")
        revision = authorization.get("configRevision")
        if isinstance(revision, bool) or not isinstance(revision, int):
            raise AuthorizationError(
                "Provide a valid execution authorization revision."
            )
        if revision != int(config_revision):
            raise AuthorizationError("Match the execution authorization revision.")
        if str(authorization.get("purpose", "")) != purpose:
            raise AuthorizationError("Match the execution authorization purpose.")
        digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with self._lock:
            if digest in self._consumed:
                raise AuthorizationError("Use each execution authorization only once.")
            self._consumed.add(digest)
