"""The one adapter contract shared across every pipeline step.

Each adapter defines one stage's execution boundary. It launches either an
external scientific tool or an inventoried first-party support implementation,
builds the command from project configuration, declares the parameter schema,
detects completion from real artifacts, parses failures, and produces a dry-run
preview.

Each adapter registers itself in :data:`ADAPTERS` at import time.
``pipeline.previewCommand``, ``pipeline.run``, and completion detection all
resolve through this registry, so a step can be added without modifying another
step.
"""

from __future__ import annotations

import re
import shlex
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from ..paths import flatten, interpolate

# Mirror the renderer's CellState union.
CellState = str

# Use the exit code produced when the OOM killer terminates a process.
OOM_EXIT_CODE = 137

# Match a surviving ``${...}`` placeholder in a built command element.
_UNRESOLVED_TOKEN = re.compile(r"\$\{[^}]+\}")


class UnresolvedTemplateError(ValueError):
    """Raise when a built command still carries ``${...}`` placeholders.

    Treat a surviving placeholder as an unresolved path or tool reference.
    Refuse the argv before launch to avoid pointing a real tool at a corrupt
    path.
    """

    def __init__(self, step: str, tokens: list[str]) -> None:
        self.step = step
        self.tokens = tokens
        joined = ", ".join(tokens)
        super().__init__(
            f"Configure step {step!r} with a concrete projectRoot and referenced "
            f"paths before running; unresolved placeholder(s): {joined}."
        )


def unresolved_tokens(argv: list[str]) -> list[str]:
    """Return the distinct ``${...}`` placeholders still present in an argv.

    Returns
    -------
    list of str
        Return each unresolved token in first-seen order without repeats.
    """
    seen: list[str] = []
    for element in argv:
        for token in _UNRESOLVED_TOKEN.findall(element):
            if token not in seen:
                seen.append(token)
    return seen


def guard_resolved(step: str, argv: list[str]) -> None:
    """Refuse a command that still carries ``${...}`` placeholders.

    Parameters
    ----------
    step
        Provide the owning step key for the error message.
    argv
        Provide the argument vector immediately before spawn.

    Raises
    ------
    UnresolvedTemplateError
        Raise when any argv element still contains an unresolved placeholder.
    """
    tokens = unresolved_tokens(argv)
    if tokens:
        raise UnresolvedTemplateError(step, tokens)


@dataclass
class StepStatus:
    """Report completion detection for one step and subject."""

    state: CellState
    detail: str = ""
    artifacts: list[str] = field(default_factory=list)
    content_identity: dict[str, Any] | None = None


@dataclass
class Failure:
    """Capture a parsed failure from an exit code and process output."""

    code: int
    tag: str
    message: str


@dataclass
class Validation:
    """Record pre-run blockers and non-blocking advisories."""

    blocking: list[str] = field(default_factory=list)
    advisory: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ExecutionAction:
    """Describe one typed action owned by the wrapper scheduler."""

    kind: str
    argv: tuple[str, ...] = ()
    source: str | None = None
    destination: str | None = None
    force: bool = False


def missing_required_checks(
    env: dict[str, Any], required: tuple[str, ...]
) -> list[str]:
    """Return one blocking reason per required env check that is not ``found``.

    Look up every required env-check id in the ``EnvReport``. Report a blocker
    when its status is not ``found``. Use the check's human label in each reason.

    Parameters
    ----------
    env
        Provide an ``EnvReport`` mapping.

    Returns
    -------
    list of str
        Return one imperative reason per unmet check in ``required`` order.
    """
    if not required:
        return []
    index: dict[str, dict[str, Any]] = {}
    for group in env.get("groups", []):
        for check in group.get("checks", []):
            index[str(check.get("id", ""))] = check
    reasons: list[str] = []
    for check_id in required:
        check = index.get(check_id)
        status = check.get("status") if check else None
        if status != "found":
            label = (check.get("label") if check else None) or check_id
            reasons.append(
                f"Resolve the {label} check; status: {status or 'not detected'}."
            )
    return reasons


class Adapter(ABC):
    """Define the base class for one pipeline-step adapter.

    Set :attr:`key`, :attr:`name`, :attr:`goal`, and advanced matrix columns in
    each subclass. Implement the command, detector, and failure-parser hooks.
    """

    #: Match the configurable pipeline-step ``StepKey``.
    key: str = ""
    #: Provide the display name.
    name: str = ""
    #: State the one-line intent.
    goal: str = ""
    #: List the advanced matrix columns, or leave the tuple empty.
    advances: tuple[str, ...] = ()
    #: Require these environment-check ids before execution. Block the run when
    #: one is missing, wrong, or absent; see :meth:`validate`. Treat an empty
    #: tuple as no hard requirement. Mirror this mapping in
    #: ``shared/steps.ts`` (``STEP_CHECK_REQUIREMENTS``) for proactive Run-button
    #: gating, and keep this attribute as the authoritative backstop.
    required_checks: tuple[str, ...] = ()

    def required_check_ids(self, cfg: dict[str, Any]) -> tuple[str, ...]:
        """Return config-dependent hard execution check IDs."""
        del cfg
        return self.required_checks

    # -- Configuration helpers -------------------------------------------------

    def resolve(self, template: str, cfg: dict[str, Any]) -> str:
        """Resolve ``${...}`` placeholders in a template against the config.

        Parameters
        ----------
        template
            Provide a string that may contain ``${a.b}`` placeholders.
        """
        return interpolate(template, flatten(cfg))

    def params(self, cfg: dict[str, Any]) -> dict[str, Any]:
        """Return the effective parameter values for this step from the config."""
        steps = cfg.get("steps", {})
        override = steps.get(self.key, {})
        return dict(override.get("params", {}))

    # -- Required hooks --------------------------------------------------------

    @abstractmethod
    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the parameter schema (kind/default/label/options/min/max).

        Expose only flags reviewed as valid and meaningful for supported tool
        versions. Keep version-sensitive requirements in environment checks.
        """

    @abstractmethod
    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the argv for one invocation.

        Parameters
        ----------
        subject_id
            Provide a subject id, or provide ``None`` for a cohort-wide step.
        """

    @abstractmethod
    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        """Detect completion from real artifacts on disk (faithful to TYPE)."""

    # -- Optional hooks (sensible defaults) ------------------------------------

    def members(self, cfg: dict[str, Any]) -> frozenset[str] | None:
        """Return the subject ids a cohort-wide output currently covers.

        Return ``None`` when the step is per-subject or when membership cannot
        be read, so the caller keeps the detector state as is. Return the exact
        id set otherwise, so a subject outside it never shows the cohort step
        as done because an earlier, smaller cohort produced the output.
        """
        del cfg
        return None

    def preview(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        """Return a shell-quoted preview of the resolved command."""
        return shlex.join(self.build_command(cfg, subject_id))

    def execution_action(
        self, cfg: dict[str, Any], subject_id: str | None
    ) -> ExecutionAction:
        """Return the wrapper action to execute for this invocation."""
        return ExecutionAction(
            kind="process", argv=tuple(self.build_command(cfg, subject_id))
        )

    def receipt_action(
        self, cfg: dict[str, Any], subject_id: str | None
    ) -> ExecutionAction:
        """Return the action identity a receipt binds for this invocation.

        Default to the exact execution action. Override when the launched
        command legitimately differs between a first run and a continuation
        of the same output, so the receipt identity stays stable across both.
        """
        return self.execution_action(cfg, subject_id)

    def prepare_execution(self, cfg: dict[str, Any], subject_id: str | None) -> None:
        """Prepare adapter-owned resources immediately before process spawn.

        Call this hook only after making the running job state durable. Allow a
        subclass to create and verify its own output parent. Prevent mutation of
        another adapter or backend's output tree.
        """
        del cfg, subject_id

    def parse_failure(self, rc: int, stdout: str, stderr: str) -> Failure | None:
        """Map a non-zero exit into a structured failure, or ``None`` on success.

        Override this hook to recognize tool-specific failure signatures.
        Classify any remaining non-zero return code generically.
        """
        if rc == 0:
            return None
        tag = "oom_killed" if rc == OOM_EXIT_CODE else "nonzero_exit"
        tail = (stderr or stdout or "").strip().splitlines()
        message = tail[-1] if tail else f"Inspect process exit code {rc}."
        return Failure(code=rc, tag=tag, message=message)

    def validate(self, cfg: dict[str, Any], env: dict[str, Any]) -> Validation:
        """Return pre-run blockers/advisories.

        Block the run when any id in :attr:`required_checks` is not ``found``.
        Override this hook for a backend choice such as ENIGMA QC. Leave
        ``required_checks`` empty to inherit a no-op.

        Parameters
        ----------
        cfg
            Provide the full project configuration for parameter-aware overrides.
        env
            Provide the latest host ``EnvReport``.

        Returns
        -------
        Validation
            Return one ``blocking`` reason per unmet required check.
        """
        return Validation(
            blocking=missing_required_checks(env, self.required_check_ids(cfg))
        )


@dataclass(frozen=True)
class UnitSpec:
    """Describe one per-subject computation inside a cohort stage.

    A unit's result depends only on its own input files and the stage method,
    so the workflow engine can reuse a verified earlier result for it. Give
    either ``output_dir``, a directory the unit owns entirely, or
    ``output_files``, the exact files it writes; both are relative to the
    contract's output root.
    """

    #: A stable part name, unique within the stage (``subcortical``).
    part: str
    #: Input files relative to the subject's reconstruction directory.
    inputs: tuple[str, ...]
    #: The directory the unit owns, relative to the output root.
    output_dir: str | None = None
    #: The exact files the unit writes, relative to the output root.
    output_files: tuple[str, ...] = ()
    #: Files a successful computation always writes, relative to the output
    #: root; a missing one fails the stage.
    required_files: tuple[str, ...] = ()


class UnitContract(ABC):
    """Declare the per-subject units of one cohort stage.

    Register a contract with :func:`register_units`. Keep it outside the
    adapter module: provenance binds the adapter's source bytes into every
    receipt, while the contract changes only how work is scheduled.
    """

    #: The cohort stage's ``StepKey``.
    step_key: str = ""
    #: Bump to make every earlier unit record unusable for reuse.
    version: str = ""
    #: Whether the tool stamps its outputs (MATLAB PNGs carry a creation
    #: time), so a computed unit whose bytes equal its pre-launch bytes was
    #: not rewritten. Leave False for a deterministic tool.
    outputs_embed_time: bool = False

    def method_identity(self, cfg: dict[str, Any]) -> dict[str, Any]:
        """Return tool identity the receipt's tool evidence does not bind.

        The result joins the method digest, so a change makes every unit
        compute. Keep it cheap: it runs for every plan and launch.
        """
        del cfg
        return {}

    @abstractmethod
    def applies(self, cfg: dict[str, Any]) -> bool:
        """Return whether units can be skipped for this configuration."""

    @abstractmethod
    def output_root(self, cfg: dict[str, Any]) -> str:
        """Return the absolute directory that holds every unit output."""

    @abstractmethod
    def units(self, cfg: dict[str, Any], subject_id: str) -> tuple[UnitSpec, ...]:
        """Return the units the stage computes for one subject."""

    @abstractmethod
    def launch_action(
        self,
        cfg: dict[str, Any],
        action: ExecutionAction,
        skipped: dict[str, frozenset[str]],
        work_dir: str,
    ) -> ExecutionAction:
        """Return the action that computes every unit except ``skipped``.

        ``skipped`` maps a part to the subjects whose verified output stays in
        place. Write any launch helpers under ``work_dir``, which the run owns.
        The returned action must leave cohort-level output as ``action``
        writes it.
        """


#: Map a cohort stage's key to its per-subject unit contract.
UNIT_CONTRACTS: dict[str, UnitContract] = {}


def register_units(contract: UnitContract) -> None:
    """Register a per-subject unit contract under its stage key."""
    UNIT_CONTRACTS[contract.step_key] = contract


# Populate this global registry while importing adapter modules.
ADAPTERS: dict[str, Adapter] = {}


def register(adapter: Adapter) -> None:
    """Register an adapter instance under its key."""
    ADAPTERS[adapter.key] = adapter


def get(key: str) -> Adapter:
    """Look up a registered adapter by key, raising ``KeyError`` if absent."""
    return ADAPTERS[key]
