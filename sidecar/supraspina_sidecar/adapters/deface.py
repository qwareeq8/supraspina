"""Adapter for the optional defaced or explicit copy-through T1w derivative.

The stage is disabled by default. ``fsl_deface``, ``mri_deface``, or
``pydeface`` processes each selected T1w volume before structural processing,
and ``skip`` copies the input unchanged. The adapter builds each selected
tool's command without reimplementing or validating its defacing method.

The supported command contracts are:

- ``fsl_deface <input> <output> [-f frac] [-B]`` for FSL.
- ``mri_deface <in> <brain_template> <face_template> <out>`` for FreeSurfer,
  whose two GCA templates resolve under ``tools.freesurferHome`` and then
  ``$FREESURFER_HOME``, matching the ``mri_deface_templates`` diagnostics check.
- ``pydeface <input> --outfile <output> [--force]`` for pydeface.
- an atomic copy action for ``skip``.

Detection looks for the non-empty T1w derivative under
``derivatives/defaced/<subject>/anat/<subject>_T1w.nii.gz``, and describes the
artifact as copy-through when ``skip`` is selected.
"""

from __future__ import annotations

import os
from typing import Any

from ..freesurfer_license import resolve_freesurfer_home
from ..paths import PreparedConfig
from . import tools
from .base import Adapter, ExecutionAction, Failure, StepStatus, Validation, register

TOOL_NOT_FOUND_EXIT_CODE = 127

INPUT_T1W_TEMPLATE = "${paths.rawdataDir}/${subject}/anat/${subject}_T1w.nii.gz"

OUTPUT_T1W_TEMPLATE = (
    "${paths.derivativesDir}/defaced/${subject}/anat/${subject}_T1w.nii.gz"
)

#: Locate both positional GCA templates under the resolved FreeSurfer home.
FS_TEMPLATE_SUBDIR = "average"

FS_BRAIN_TEMPLATE_NAME = "talairach_mixed_with_skull.gca"

FS_FACE_TEMPLATE_NAME = "face.gca"

#: Render an unresolved template path when no FreeSurfer home is available, so
#: a command preview names the field to fill instead of an empty root.
FS_TEMPLATE_PLACEHOLDER = "${tools.freesurferHome}"


class DefaceAdapter(Adapter):
    """Build and detect the optional T1w defacing step.

    Wrap one of ``fsl_deface``, ``mri_deface``, or ``pydeface`` as a subprocess.
    Mirror the renderer's ``deface`` parameter schema exactly. Expose only flags
    accepted by the chosen tool.
    """

    key = "deface"
    name = "Optional defacing"
    goal = "Invoke the selected defacing tool or publish an explicit copy-through."
    advances: tuple[str, ...] = ()

    def required_check_ids(self, cfg: dict[str, Any]) -> tuple[str, ...]:
        """Require exactly the selected defacer, or nothing for copy-through."""
        tool = str(self.params(cfg).get("tool", "mri_deface"))
        if tool == "skip":
            return ()
        if tool == "mri_deface":
            return ("mri_deface", "mri_deface_templates")
        return (tool,)

    def validate(self, cfg: dict[str, Any], env: dict[str, Any]) -> Validation:
        """Apply the selected-tool gate only when optional defacing is enabled."""
        steps = cfg.get("steps", {}) if isinstance(cfg.get("steps"), dict) else {}
        configured = steps.get(self.key, {})
        if not isinstance(configured, dict) or not configured.get("enabled", False):
            return Validation()
        return super().validate(cfg, env)

    def param_schema(self) -> dict[str, dict[str, Any]]:
        """Return the parameter schema, mirroring ``steps.ts`` defaults.

        Returns
        -------
        dict
            Return the defacing ``tool`` choice and
            the ``forceOverwrite`` toggle. Expose only flags accepted by the
            selected tool.
        """
        return {
            "tool": {
                "kind": "choice",
                "default": "mri_deface",
                "options": ["mri_deface", "fsl_deface", "pydeface", "skip"],
                "label": "Defacing tool",
            },
            "forceOverwrite": {
                "kind": "bool",
                "default": False,
                "label": "Overwrite existing defaced volumes",
            },
        }

    def _context(self, cfg: dict[str, Any], subject_id: str | None) -> dict[str, Any]:
        """Return ``cfg`` overlaid with the ``subject`` placeholder.

        Parameters
        ----------
        subject_id
            Provide the subject id or ``None`` for a ``${subject}`` placeholder.

        Returns
        -------
        dict
            Return a shallow ``cfg`` copy carrying a top-level ``subject`` key so
            that :meth:`resolve` can substitute ``${subject}`` in templates.
        """
        subject = subject_id if subject_id is not None else "${subject}"
        if isinstance(cfg, PreparedConfig):
            # Extend the prepared view rather than rebuilding it, because this
            # overlay is created once per subject and the run-scoped
            # configuration it copies grows with the cohort.
            return cfg.derive("subject", subject)
        overlay = dict(cfg)
        overlay["subject"] = subject
        return overlay

    def input_path(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        """Return the resolved BIDS rawdata T1w path for ``subject_id``."""
        runtime = cfg.get("_supraspinaRuntime", {})
        by_subject = (
            runtime.get("preparedT1BySubject", {}) if isinstance(runtime, dict) else {}
        )
        if subject_id is not None and isinstance(by_subject, dict):
            selected = by_subject.get(subject_id)
            if isinstance(selected, str) and selected:
                return selected
        raw_by_subject = (
            runtime.get("t1BySubject", {}) if isinstance(runtime, dict) else {}
        )
        if subject_id is not None and isinstance(raw_by_subject, dict):
            selected = raw_by_subject.get(subject_id)
            if isinstance(selected, str) and selected:
                return selected
        return self.resolve(INPUT_T1W_TEMPLATE, self._context(cfg, subject_id))

    def output_path(self, cfg: dict[str, Any], subject_id: str | None) -> str:
        """Return the resolved defaced T1w output path for ``subject_id``."""
        return self.resolve(OUTPUT_T1W_TEMPLATE, self._context(cfg, subject_id))

    def build_command(self, cfg: dict[str, Any], subject_id: str | None) -> list[str]:
        """Build the argv for the selected defacing tool.

        Parameters
        ----------
        subject_id
            Provide the subject id or ``None`` for a templated preview.

        Returns
        -------
        list of str
            Return the argument vector for the chosen tool. Let ``fsl_deface``
            take ``<input> <output>``, ``mri_deface`` take the input followed by
            the FreeSurfer brain/face templates and the output, and ``pydeface``
            take the input with ``--outfile``. Add ``--force`` only for
            ``pydeface`` when ``forceOverwrite`` is enabled.
        """
        params = self.params(cfg)
        tool = str(params.get("tool", "mri_deface"))
        force = bool(params.get("forceOverwrite", False))

        in_path = self.input_path(cfg, subject_id)
        out_path = self.output_path(cfg, subject_id)

        if tool == "mri_deface":
            brain = self._gca_template(cfg, FS_BRAIN_TEMPLATE_NAME)
            face = self._gca_template(cfg, FS_FACE_TEMPLATE_NAME)
            return ["mri_deface", in_path, brain, face, out_path]

        if tool == "fsl_deface":
            return ["fsl_deface", in_path, out_path]

        if tool == "skip":
            return ["supraspina-copy-through", in_path, out_path]

        # Retain the explicit upstream pydeface argv exactly.
        argv = ["pydeface", in_path, "--outfile", out_path]
        if force:
            argv.append("--force")
        return argv

    @staticmethod
    def _gca_template(cfg: dict[str, Any], name: str) -> str:
        """Return one positional GCA template under the FreeSurfer home.

        Resolve the install root the way diagnostics does, ``tools.freesurferHome``
        first and then ``$FREESURFER_HOME``, so the command matches the
        ``mri_deface_templates`` check that admits this stage to a run. Render the
        unresolved placeholder when neither source names a home, because an empty
        root would otherwise read as a plausible absolute path.

        Parameters
        ----------
        name
            Provide the template file name under the ``average`` subdirectory.

        Returns
        -------
        str
            Return the template path, or its unresolved placeholder rendering.
        """
        home = resolve_freesurfer_home(cfg if isinstance(cfg, dict) else {})
        if not home:
            return f"{FS_TEMPLATE_PLACEHOLDER}/{FS_TEMPLATE_SUBDIR}/{name}"
        return os.path.join(home, FS_TEMPLATE_SUBDIR, name)

    def execution_action(
        self, cfg: dict[str, Any], subject_id: str | None
    ) -> ExecutionAction:
        """Return an atomic copy action for ``skip`` and a process otherwise."""
        params = self.params(cfg)
        if str(params.get("tool", "mri_deface")) == "skip":
            return ExecutionAction(
                kind="copy",
                source=self.input_path(cfg, subject_id),
                destination=self.output_path(cfg, subject_id),
                force=bool(params.get("forceOverwrite", False)),
            )
        return super().execution_action(cfg, subject_id)

    def detect(self, cfg: dict[str, Any], subject_id: str | None) -> StepStatus:
        """Detect completion from the prepared T1w derivative on disk.

        Returns
        -------
        StepStatus
            Report ``done`` with the prepared volume when a non-empty T1w exists
            under ``derivatives/defaced/<subject>/anat``. Report ``pending``
            otherwise. Distinguish an explicit copy-through artifact from a
            defaced artifact in the detail.
        """
        out_path = self.output_path(cfg, subject_id)
        copy_through = str(self.params(cfg).get("tool", "mri_deface")) == "skip"
        if tools.file_nonempty(out_path):
            return StepStatus(
                state="done",
                detail=(
                    "The copy-through T1w derivative is prepared."
                    if copy_through
                    else "The defaced T1w derivative is prepared."
                ),
                artifacts=[out_path],
            )
        detail = (
            "Create the copy-through T1w derivative."
            if copy_through
            else "Create the defaced T1w derivative."
        )
        return StepStatus(state="pending", detail=detail)

    def parse_failure(self, rc: int, stdout: str, stderr: str) -> Failure | None:
        """Map a non-zero exit into a structured failure for the defacers.

        Returns
        -------
        Failure or None
            Return ``None`` on success or a tagged failure otherwise. Recognize a
            missing input volume, a missing executable, and the OOM kill that
            ``mri_deface``'s GCA registration can trigger on large volumes.
        """
        if rc == 0:
            return None

        blob = f"{stdout}\n{stderr}".lower()

        if (
            rc == TOOL_NOT_FOUND_EXIT_CODE
            or "not found:" in blob
            or "command not found" in blob
        ):
            return Failure(
                code=rc,
                tag="tool_missing",
                message="Add the defacing tool to PATH.",
            )
        if "no input image" in blob or "no such file" in blob or "cannot find" in blob:
            return Failure(
                code=rc,
                tag="missing_input",
                message="Provide the input T1w volume.",
            )
        return super().parse_failure(rc, stdout, stderr)


register(DefaceAdapter())
