"""Explicit project-identity validation across project-data RPC handlers."""

from __future__ import annotations

import os
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .run_store import canonical_project_root

_MAX_PROJECT_ID_LENGTH = 256
_MAX_JSON_SAFE_INTEGER = (1 << 53) - 1


class ProjectIdentityError(ValueError):
    """Reject project data that does not identify one root."""


def _validate_epoch(value: Any) -> int:
    """Accept only a non-negative integer that round-trips through JSON safely."""
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > _MAX_JSON_SAFE_INTEGER
    ):
        raise ProjectIdentityError(
            "Provide project.epoch as a non-negative JSON-safe integer."
        )
    return value


@dataclass(frozen=True)
class ProjectIdentity:
    """Represent canonical project identity bound to one renderer epoch."""

    project_id: str
    root: str
    config_path: str
    epoch: int

    def to_dict(self) -> dict[str, Any]:
        """Serialize the identity for RPC responses."""
        return {
            "projectId": self.project_id,
            "root": self.root,
            "configPath": self.config_path,
            "epoch": self.epoch,
        }


class ProjectEpochs:
    """Reject late requests from an older renderer project generation."""

    def __init__(self, on_attachment: Callable[[bool], None] | None = None) -> None:
        self._lock = threading.Lock()
        self._active: ProjectIdentity | None = None
        self._tombstones: dict[str, int] = {}
        self._on_attachment = on_attachment
        self._switch_guard: Callable[[], bool] | None = None

    def set_switch_guard(self, guard: Callable[[], bool]) -> None:
        """Set a callback that permits project replacement only when quiescent."""
        self._switch_guard = guard

    def validate(self, raw: Any, cfg: dict[str, Any] | None = None) -> ProjectIdentity:
        """Validate and attach a current project identity."""
        if not isinstance(raw, dict):
            raise ProjectIdentityError("Provide a project reference.")
        project_id = str(raw.get("projectId", "")).strip()
        if not project_id or len(project_id) > _MAX_PROJECT_ID_LENGTH:
            raise ProjectIdentityError("Provide project.projectId.")
        root = canonical_project_root(str(raw.get("root", "")))
        config_path = str(raw.get("configPath", ""))
        epoch = _validate_epoch(raw.get("epoch"))
        if config_path:
            config_path = str(os.path.realpath(config_path))
            if os.path.commonpath((config_path, root)) != root:
                raise ProjectIdentityError(
                    "Keep project.configPath within project.root."
                )
        if cfg is not None:
            paths = cfg.get("paths", {}) if isinstance(cfg.get("paths"), dict) else {}
            cfg_root = canonical_project_root(str(paths.get("projectRoot", "")))
            if cfg_root != root:
                raise ProjectIdentityError(
                    "Match project.root to cfg.paths.projectRoot."
                )
        identity = ProjectIdentity(project_id, root, config_path, epoch)
        notify = False
        with self._lock:
            tombstone = self._tombstones.get(project_id)
            if tombstone is not None and epoch <= tombstone:
                raise ProjectIdentityError("Refresh the stale detached-project epoch.")
            previous = self._active
            if (
                previous is not None
                and previous.project_id == project_id
                and epoch < previous.epoch
            ):
                raise ProjectIdentityError("Refresh the stale project epoch.")
            if (
                previous is not None
                and previous.project_id == project_id
                and (previous.root != root or previous.config_path != config_path)
                and epoch <= previous.epoch
            ):
                raise ProjectIdentityError(
                    "Advance the epoch after changing project identity."
                )
            switching = previous is not None and identity != previous
            if (
                switching
                and self._switch_guard is not None
                and not self._switch_guard()
            ):
                raise ProjectIdentityError(
                    "Wait for active scientific work to finish before switching "
                    "projects."
                )
            if switching and previous is not None:
                self._tombstones[previous.project_id] = max(
                    previous.epoch, self._tombstones.get(previous.project_id, -1)
                )
            notify = previous is None
            self._active = identity
        if notify and self._on_attachment is not None:
            self._on_attachment(True)
        return identity

    def detach(self, raw: Any) -> bool:
        """Detach only the exact active project identity and tombstone its epoch."""
        if not isinstance(raw, dict):
            raise ProjectIdentityError("Provide a project reference.")
        project_id = str(raw.get("projectId", "")).strip()
        root = canonical_project_root(str(raw.get("root", "")))
        epoch = _validate_epoch(raw.get("epoch"))
        with self._lock:
            active = self._active
            if active is None:
                return False
            if (
                active.project_id != project_id
                or active.root != root
                or active.epoch != epoch
            ):
                raise ProjectIdentityError(
                    "Refresh and match the project detach identity."
                )
            self._tombstones[project_id] = max(
                epoch, self._tombstones.get(project_id, -1)
            )
            self._active = None
        if self._on_attachment is not None:
            self._on_attachment(False)
        return True

    def detach_all(self) -> None:
        """Forget attached identities and publish the detached lifecycle state."""
        with self._lock:
            had_projects = self._active is not None
            if self._active is not None:
                self._tombstones[self._active.project_id] = max(
                    self._active.epoch,
                    self._tombstones.get(self._active.project_id, -1),
                )
            self._active = None
        if had_projects and self._on_attachment is not None:
            self._on_attachment(False)

    def attached(self) -> list[dict[str, Any]]:
        """Return the currently attached project summary, if any."""
        with self._lock:
            active = self._active
            if active is None:
                return []
            return [
                {
                    "projectId": active.project_id,
                    "epoch": active.epoch,
                    "root": active.root,
                }
            ]
