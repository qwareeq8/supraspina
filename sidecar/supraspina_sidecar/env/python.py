"""Probe of Python and conda dependencies for ``Python / conda`` diagnostics.

One probe covers the shared interpreter used by Age, Clinical, and Brain-PAD;
the resolver may select a configured interpreter, a step-specific PyBrainAge
interpreter, the provisioned environment, or a PATH fallback. The
version-constrained PyBrainAge stack is probed separately against reviewed
package pins and the versioned ExtraTrees model and scaler.

Provisioned-stack paths are delegated to
:mod:`supraspina_sidecar.adapters.pybrainage` so the probe and runner agree, and
URLs and dependency lists come from :mod:`supraspina_sidecar.env.constants`. The
model and scaler are checked only for presence and size; their pickled bytes
are never opened.
"""

from __future__ import annotations

import shlex
from typing import Any, NamedTuple

from ..adapters import pybrainage, tools
from ..adapters.analysis_python import resolve_analysis_interpreter
from ..adapters.base import ADAPTERS
from ..freesurfer_environment import freesurfer_runtime_environment
from .base import Check, CheckAction, Installer, Probe, register_probe
from .constants import (
    CONDA_FORGE_URL,
    MICROMAMBA_DOWNLOAD,
    PY_ANALYSIS_IMPORTS,
    PY_PIP_DISTRIBUTIONS,
    PYBRAINAGE_ZENODO_URL,
)

#: Prefix the first output line with this sentinel before the resolvable import
#: names so one interpreter start serves both version and import probes.
_VERSION_MARK = "@@SUPRASPINA_PYVERSION@@"

#: Prefix the second output line reporting PEP 668 external management with this
#: sentinel. Expect a distro interpreter that ships ``EXTERNALLY-MANAGED`` next
#: to its standard library to refuse every ``pip install`` without an explicit
#: opt-out. Report the marker only outside a virtual environment, exactly where
#: pip enforces it; ignore the marker visible from a venv that shares the base
#: interpreter's standard library because the policy does not apply there.
_MANAGED_MARK = "@@SUPRASPINA_EXTERNALLY_MANAGED@@"

#: Prefix a line reporting an installed distribution that is older than the
#: minimum another present distribution declares for it. Read only package
#: metadata, never the modules themselves.
_INCOMPATIBLE_MARK = "@@SUPRASPINA_INCOMPATIBLE@@"

#: Optional dependencies whose declared minimum the probe compares against the
#: installed version: pandas reads and writes XLSX through openpyxl and refuses
#: an older release at import time inside the analysis scripts.
_DECLARED_MINIMUMS: tuple[tuple[str, str], ...] = (("pandas", "openpyxl"),)

#: Use this inline script for one interpreter start: print the version line first
#: (tagged with :data:`_VERSION_MARK`), then the PEP 668 line (tagged with
#: :data:`_MANAGED_MARK`), then each importable name from ``argv[1:]`` whose
#: ``importlib.util.find_spec`` resolves. Print only names; import no module and
#: read back no third-party value.
_PROBE_SCRIPT = (
    "import importlib.util, os, sys, sysconfig\n"
    f"print({_VERSION_MARK!r} + sys.version.splitlines()[0])\n"
    "managed = sys.prefix == sys.base_prefix and os.path.exists(\n"
    "    os.path.join(sysconfig.get_path('stdlib') or '', 'EXTERNALLY-MANAGED')\n"
    ")\n"
    f"print({_MANAGED_MARK!r} + ('1' if managed else '0'))\n"
    "for name in sys.argv[1:]:\n"
    "    if importlib.util.find_spec(name) is not None:\n"
    "        print(name)\n"
    "import importlib.metadata as md, re\n"
    f"for owner, dep in {_DECLARED_MINIMUMS!r}:\n"
    "    if dep not in sys.argv[1:]:\n"
    "        continue\n"
    "    try:\n"
    "        installed = md.version(dep)\n"
    "        specs = [r for r in (md.requires(owner) or []) "
    "if r.lower().startswith(dep)]\n"
    "    except md.PackageNotFoundError:\n"
    "        continue\n"
    "    for spec in specs:\n"
    "        m = re.search(r'>=\\s*([0-9][0-9A-Za-z.]*)', spec)\n"
    "        if m is None:\n"
    "            continue\n"
    "        key = lambda v: [int(x) if x.isdigit() else 0 "
    "for x in re.split(r'[.]', v)]\n"
    "        if key(installed) < key(m.group(1)):\n"
    f"            print({_INCOMPATIBLE_MARK!r} + dep + ' ' + installed + "
    "' below ' + owner + ' minimum ' + m.group(1))\n"
    "            break\n"
)

#: Use this PEP 668 opt-out with every pip new enough to enforce the marker. Pair
#: it with ``--user`` to write only the operator's own site directory and never
#: a distribution-owned one.
_PEP_668_OPT_OUT = "--break-system-packages"

_STAGE_IMPORTS: dict[str, tuple[str, ...]] = {
    "age": ("pandas",),
    "clinical": ("pandas", "openpyxl"),
    "brainpad": (
        "pandas",
        "openpyxl",
        "numpy",
        "scipy",
        "seaborn",
        "statsmodels",
        "matplotlib",
        "cliffs_delta",
    ),
    "aggregate": (),
}

_STAGE_CHECKS: tuple[tuple[str, str, str], ...] = (
    ("age", "agepython", "Age metadata Python"),
    ("clinical", "clinicalpython", "Clinical merge Python"),
    ("brainpad", "brainpadpython", "Brain-PAD analysis Python"),
    ("aggregate", "aggregatepython", "Aggregate statistics Python"),
)


class _PythonProbe(NamedTuple):
    """Represent one interpreter start and its version, imports, and PEP 668 state.

    Set ``version`` to ``None`` when the interpreter is absent or the probe
    fails. Set ``present`` to ``None`` when the probe cannot run at all, and
    keep a probe failure distinguishable from a genuinely empty import set.
    """

    version: str | None
    present: list[str] | None
    externally_managed: bool
    incompatible: tuple[str, ...] = ()


def _stage_runtime_environment(cfg: dict[str, Any]) -> dict[str, str]:
    """Return the project-derived environment used to launch workflow stages."""
    return freesurfer_runtime_environment(cfg)


class PythonProbe(Probe):
    """Detect the analysis Python plus the provisioned PyBrainAge stack.

    Emit base checks for the analysis interpreter, conda manager, imports,
    provisioned environment, and model artifacts, plus stage-specific
    interpreter checks for each Python-backed workflow stage.
    """

    name = "Python / conda"

    def checks(self, cfg: dict[str, Any]) -> list[Check]:
        """Run every Python / conda check against the project configuration.

        Parameters
        ----------
        cfg
            Provide the full project configuration mapping (possibly empty or
            partial).

        Returns
        -------
        list of Check
            Return the checks in display order.
        """
        analysis_python = self._analysis_python(cfg)
        probe = self._probe_python(analysis_python, PY_ANALYSIS_IMPORTS)
        return [
            self._check_python(analysis_python, probe),
            self._check_micromamba(cfg),
            self._check_pypkgs(analysis_python, probe),
            self._check_pyenv(cfg),
            self._check_modelfile(cfg),
            self._check_scalerfile(cfg),
            *(self._stage_check(cfg, *descriptor) for descriptor in _STAGE_CHECKS),
            self._check_pybrainpython(cfg),
        ]

    def _stage_check(
        self,
        cfg: dict[str, Any],
        step_key: str,
        check_id: str,
        label: str,
    ) -> Check:
        """Probe the exact interpreter and imports launched by one adapter."""
        try:
            python = ADAPTERS[step_key].build_command(cfg, None)[0]
        except (KeyError, TypeError, ValueError, IndexError):
            python = ""
        if not python:
            return Check(
                id=check_id,
                label=label,
                status="missing",
                detail=f"Configure a resolved interpreter for the {step_key} command.",
            )
        required = _STAGE_IMPORTS[step_key]
        version, present, _, incompatible = self._probe_python(
            python,
            required,
            env=_stage_runtime_environment(cfg),
        )
        if version is None or present is None:
            return Check(
                id=check_id,
                label=label,
                status="missing" if not tools.exists(python) else "wrong",
                detail=(
                    f"Inspect {python} because the {step_key} dependency probe failed."
                ),
            )
        missing = [name for name in required if name not in present]
        if missing:
            return Check(
                id=check_id,
                label=label,
                status="wrong",
                detail=(
                    f"Install these missing {step_key} dependencies for {python} "
                    f"({version}): {', '.join(missing)}."
                ),
            )
        if incompatible:
            return Check(
                id=check_id,
                label=label,
                status="wrong",
                detail=(
                    f"Upgrade these {step_key} dependencies for {python} "
                    f"({version}): {'; '.join(incompatible)}."
                ),
            )
        imports = (
            f" with imports {', '.join(required)}" if required else " with stdlib only"
        )
        uses = (
            f"can import {', '.join(required)}"
            if required
            else "needs only the standard library"
        )
        return Check(
            id=check_id,
            label=label,
            status="found",
            detail=f"{python} ({version}) {uses}.",
            identity_detail=f"Use {python} ({version}){imports}.",
        )

    def _check_pybrainpython(self, cfg: dict[str, Any]) -> Check:
        """Verify the exact PyBrainAge command interpreter and pinned versions."""
        try:
            python = ADAPTERS["pybrainage"].build_command(cfg, None)[0]
        except (KeyError, TypeError, ValueError, IndexError):
            python = ""
        label = "PyBrainAge command environment"
        if not python:
            return Check(
                id="pybrainpython",
                label=label,
                status="missing",
                detail="Configure a resolved interpreter for the PyBrainAge command.",
            )
        result, versions = pybrainage.probe_runtime_versions(
            cfg,
            python=python,
        )
        wrong = pybrainage.runtime_version_mismatches(versions)
        if result.rc != 0 or not versions:
            status = "missing" if not tools.exists(python) else "wrong"
            mismatch_detail = "; ".join(wrong)
            detail = (
                f"Install the reviewed PyBrainAge runtime versions for {python}; "
                f"{mismatch_detail}."
                if mismatch_detail
                else (
                    f"Inspect {python}; importing the reviewed PyBrainAge runtime "
                    "failed."
                )
            )
        elif wrong:
            status = "wrong"
            detail = (
                f"Install the reviewed PyBrainAge runtime versions for {python}; "
                + "; ".join(wrong)
                + "."
            )
        else:
            pins = (
                f"python={versions['python']}; "
                f"numpy={versions['numpy']}; pandas={versions['pandas']}; "
                f"sklearn={versions['sklearn']}; scipy={versions['scipy']}; "
                f"openpyxl={versions['openpyxl']}; "
                f"matplotlib={versions['matplotlib']}; "
                f"seaborn={versions['seaborn']}; "
                f"statsmodels={versions['statsmodels']}; "
                f"pip={versions['pip']}; cliffs-delta={versions['cliffs-delta']}."
            )
            return Check(
                id="pybrainpython",
                label=label,
                status="found",
                detail=f"{python} has {pins}",
                identity_detail=f"Use {python} with {pins}",
            )
        return Check(id="pybrainpython", label=label, status=status, detail=detail)

    # -- analysis interpreter --------------------------------------------------

    def _analysis_python(self, cfg: dict[str, Any]) -> str | None:
        """Resolve the shared analysis Python in reviewed preference order.

        Returns
        -------
        str or None
            Prefer configured ``tools.pythonExecutable``, then a ``python3`` or
            ``python`` PATH candidate. Never share the isolated PyBrainAge
            compatibility interpreter. Return ``None`` when no safe candidate
            resolves.
        """
        return resolve_analysis_interpreter(cfg) or None

    def _probe_python(
        self,
        python: str | None,
        imports: tuple[str, ...],
        *,
        env: dict[str, str] | None = None,
    ) -> _PythonProbe:
        """Run ONE interpreter start yielding version, PEP 668, and imports.

        Print the version line (tagged with :data:`_VERSION_MARK`), the PEP 668
        line (tagged with :data:`_MANAGED_MARK`), and each resolvable import name
        through one :func:`tools.run` invocation. Share one cold start between
        :meth:`_check_python` and :meth:`_check_pypkgs`.

        Parameters
        ----------
        python
            Provide the analysis interpreter path, or ``None`` when absent.
        imports
            Import names to resolve without importing their modules.

        Returns
        -------
        _PythonProbe
            Return the version label, resolvable import names, and externally
            managed state. Set the version to ``None`` when the interpreter is
            absent or the probe fails. Set the import list to ``None`` when the
            probe cannot run, and distinguish probe failure from a genuinely
            empty import set.
        """
        if not python:
            return _PythonProbe(None, None, False)
        result = tools.run(
            [python, "-c", _PROBE_SCRIPT, *imports],
            timeout=60,
            env=env,
        )
        if result.rc != 0:
            return _PythonProbe(None, None, False)
        version: str | None = None
        externally_managed = False
        present: list[str] = []
        incompatible: list[str] = []
        for raw in result.stdout.splitlines():
            line = raw.strip()
            if not line:
                continue
            if line.startswith(_VERSION_MARK):
                version = line[len(_VERSION_MARK) :].strip() or None
            elif line.startswith(_MANAGED_MARK):
                externally_managed = line[len(_MANAGED_MARK) :].strip() == "1"
            elif line.startswith(_INCOMPATIBLE_MARK):
                incompatible.append(line[len(_INCOMPATIBLE_MARK) :].strip())
            else:
                present.append(line)
        if version is None:
            # Treat a probe without the marker line as unparseable.
            return _PythonProbe(None, None, False)
        return _PythonProbe(version, present, externally_managed, tuple(incompatible))

    def _check_python(self, python: str | None, probe: _PythonProbe) -> Check:
        """Build the ``python`` check for the analysis interpreter."""
        if not python:
            return Check(
                id="python",
                label="Analysis Python interpreter",
                status="missing",
                detail="Configure Python or add python3 or python to PATH.",
                download_url=CONDA_FORGE_URL,
            )
        if probe.version is None:
            # The probe sets the version only when the marker line parsed, so
            # a missing version means the interpreter could not run. Name the
            # configured path instead of reporting it found, matching the
            # paired package check on the same interpreter.
            detail = (
                f"Configure an existing analysis Python interpreter; the saved "
                f"path was not found: {python}."
                if not tools.exists(python)
                else f"Inspect {python}; it failed to run as a Python interpreter."
            )
            return Check(
                id="python",
                label="Analysis Python interpreter",
                status="missing",
                detail=detail,
                download_url=CONDA_FORGE_URL,
            )
        managed = (
            " under PEP 668 external management" if probe.externally_managed else ""
        )
        managed_fact = (
            " is under PEP 668 external management" if probe.externally_managed else ""
        )
        return Check(
            id="python",
            label="Analysis Python interpreter",
            status="found",
            detail=f"{python} ({probe.version}){managed_fact}.",
            identity_detail=f"Use {python} ({probe.version}){managed}.",
        )

    # -- conda manager ---------------------------------------------------------

    def _check_micromamba(self, cfg: dict[str, Any]) -> Check:
        """Execute the exact provisioning micromamba and require version 2.7.0."""
        selected = pybrainage.micromamba_binary()
        try:
            pybrainage.provision_root(cfg)
        except ValueError:
            # The probe refuses to run without a resolved provisioning root;
            # defer the check instead of failing it.
            return Check(
                id="micromamba",
                label=f"micromamba {pybrainage.MICROMAMBA_VERSION}",
                status="skipped",
                detail=(
                    "Supraspina verifies the provisioning micromamba after a "
                    "project resolves paths.outputDir."
                ),
            )
        result = pybrainage.probe_micromamba_version(cfg, micromamba=selected)
        if result.rc == 0:
            return Check(
                id="micromamba",
                label=f"micromamba {pybrainage.MICROMAMBA_VERSION}",
                status="found",
                detail=f"{selected} ({pybrainage.MICROMAMBA_VERSION}).",
                identity_detail=f"Use {selected} ({pybrainage.MICROMAMBA_VERSION}).",
            )
        download = MICROMAMBA_DOWNLOAD
        output = "micromamba"
        one_liner = (
            f"curl --fail --location --output {output} {download['url']} && "
            f"printf '%s  %s\\n' {download['sha256']} {output} | "
            f"{download['verify']} && chmod 0755 {output}"
        )
        return Check(
            id="micromamba",
            label=f"micromamba {pybrainage.MICROMAMBA_VERSION}",
            status=("missing" if not tools.exists(selected) else "wrong"),
            detail=(
                result.stderr
                or f"Install micromamba {pybrainage.MICROMAMBA_VERSION} at {selected}."
            ),
            download_url=download["url"],
            recommended_cmd=one_liner,
            installer=Installer(
                kind="manual",
                one_liner=one_liner,
                note=(
                    "Use the same immutable version and SHA-256 as Supraspina "
                    "release CI, and fetch micromamba manually."
                ),
            ),
        )

    # -- analysis import set ---------------------------------------------------

    def _check_pypkgs(self, python: str | None, probe: _PythonProbe) -> Check:
        """Build the ``pypkgs`` check against the analysis import set.

        Parameters
        ----------
        python
            Provide the analysis interpreter path, or ``None`` when absent.
        probe
            Accept the single-start probe result from :meth:`_probe_python`.
            Treat its ``present`` list as ``None`` when the interpreter is
            present but the probe could not run.

        Returns
        -------
        Check
            ``skipped`` (no interpreter), ``warn`` (probe failed, no installer),
            ``found`` (all present), or ``wrong``/``missing`` with a pip
            installer for the missing imports.
        """
        label = "Analysis Python packages"
        present = probe.present
        if not python:
            return Check(
                id="pypkgs",
                label=label,
                status="skipped",
                detail="Configure analysis Python before probing imports.",
            )
        if present is None:
            return Check(
                id="pypkgs",
                label=label,
                status="warn",
                detail=(
                    f"Inspect {python}; probing required packages failed with "
                    "an interpreter error."
                ),
            )
        missing = [name for name in PY_ANALYSIS_IMPORTS if name not in present]
        if not missing:
            return Check(
                id="pypkgs",
                label=label,
                status="found",
                detail=(
                    "All analysis Python packages are present: "
                    f"{', '.join(PY_ANALYSIS_IMPORTS)}."
                ),
                identity_detail=(
                    "Use all present analysis Python packages: "
                    f"{', '.join(PY_ANALYSIS_IMPORTS)}."
                ),
            )
        status = "wrong" if present else "missing"
        pip_names = [self._pip_name(name) for name in missing]
        argv = self._pip_argv(python, pip_names, probe.externally_managed)
        managed = (
            " under PEP 668 external management" if probe.externally_managed else ""
        )
        note = (
            "Install into your --user site rather than a distribution-owned "
            "directory, and require Allow live runs."
        )
        if probe.externally_managed:
            note = (
                f"Pass {_PEP_668_OPT_OUT} so pip can write your --user site "
                f"with the externally managed {python} interpreter (PEP 668). "
                "Avoid distribution-owned directories, and remember that a "
                "--user package can shadow the same system package for your "
                "account. Point the analysis Python setting at a virtual "
                "environment to keep the system interpreter untouched."
            )
        return Check(
            id="pypkgs",
            label=label,
            status=status,  # type: ignore[arg-type]
            detail=f"Install these missing packages{managed}: {', '.join(missing)}.",
            recommended_cmd=shlex.join(argv),
            installer=Installer(
                kind="command",
                argv=argv,
                one_liner=shlex.join(argv),
                note=note,
            ),
        )

    @staticmethod
    def _pip_argv(
        python: str,
        pip_names: list[str],
        externally_managed: bool,
    ) -> list[str]:
        """Build the exact pip argv for the resolved analysis interpreter."""
        opt_out = [_PEP_668_OPT_OUT] if externally_managed else []
        return [python, "-m", "pip", "install", "--user", *opt_out, *pip_names]

    @staticmethod
    def _pip_name(import_name: str) -> str:
        """Map an import name onto its PyPI distribution name."""
        return PY_PIP_DISTRIBUTIONS.get(import_name, import_name)

    # -- provisioned PyBrainAge environment ------------------------------------

    def _check_pyenv(self, cfg: dict[str, Any]) -> Check:
        """Build the ``pyenv`` check for the provisioned PyBrainAge env."""
        try:
            env_python = pybrainage.env_python(cfg)
        except (OSError, TypeError, ValueError):
            env_python = ""
        if tools.exists(env_python):
            state_ok, state_detail = pybrainage.provision_state_status(cfg)
            if state_ok:
                return Check(
                    id="pyenv",
                    label="PyBrainAge environment",
                    status="found",
                    detail=f"{env_python} (provenance {state_detail}).",
                    identity_detail=f"Use {env_python}; provenance {state_detail}.",
                )
            status = "wrong"
            detail = state_detail
        else:
            status = "missing"
            detail = (
                "Set up PyBrainAge to create the locked environment and record "
                "its provenance."
            )
        return Check(
            id="pyenv",
            label="PyBrainAge environment",
            status=status,  # type: ignore[arg-type]
            detail=detail,
            action=CheckAction("setup-pybrainage", "Set up PyBrainAge"),
        )

    def _check_modelfile(self, cfg: dict[str, Any]) -> Check:
        """Build the ``modelfile`` check for the pickled ExtraTrees model."""
        try:
            argv = ADAPTERS["pybrainage"].build_command(cfg, None)
            model_path = argv[argv.index("--model") + 1]
            state_ok, state_detail = pybrainage.provision_state_status(cfg)
        except (OSError, TypeError, ValueError, IndexError):
            model_path = ""
            state_ok, state_detail = False, "provisioning has not been configured"
        if tools.file_nonempty(model_path) and state_ok:
            return Check(
                id="modelfile",
                label="PyBrainAge ExtraTrees model",
                status="found",
                detail=f"{model_path} (provenance {state_detail}).",
                identity_detail=f"Use {model_path}; provenance {state_detail}.",
            )
        return Check(
            id="modelfile",
            label="PyBrainAge ExtraTrees model",
            status="missing",
            detail=(
                "Set up PyBrainAge to fetch and verify the ExtraTrees model "
                "(108 MB). Get it opens the pinned Zenodo record for "
                "provenance review."
            ),
            download_url=PYBRAINAGE_ZENODO_URL,
            action=CheckAction("setup-pybrainage", "Set up PyBrainAge"),
        )

    def _check_scalerfile(self, cfg: dict[str, Any]) -> Check:
        """Build the ``scalerfile`` check for the pickled StandardScaler."""
        try:
            argv = ADAPTERS["pybrainage"].build_command(cfg, None)
            scaler_path = argv[argv.index("--scaler") + 1]
            state_ok, state_detail = pybrainage.provision_state_status(cfg)
        except (OSError, TypeError, ValueError, IndexError):
            scaler_path = ""
            state_ok, state_detail = False, "provisioning has not been configured"
        if tools.file_nonempty(scaler_path) and state_ok:
            return Check(
                id="scalerfile",
                label="PyBrainAge scaler",
                status="found",
                detail=f"{scaler_path} (provenance {state_detail}).",
                identity_detail=f"Use {scaler_path}; provenance {state_detail}.",
            )
        return Check(
            id="scalerfile",
            label="PyBrainAge scaler",
            status="missing",
            detail=(
                "Set up PyBrainAge to fetch and verify scaler.pkl. Get it "
                "opens the pinned Zenodo record for provenance review."
            ),
            download_url=PYBRAINAGE_ZENODO_URL,
            action=CheckAction("setup-pybrainage", "Set up PyBrainAge"),
        )


def _dig(cfg: dict[str, Any], *keys: str) -> Any:
    """Defensively walk nested mapping keys, returning ``None`` if any miss.

    Parameters
    ----------
    cfg
        Provide the configuration mapping (possibly empty or partial).

    Returns
    -------
    Any
        Return the nested value, or ``None`` when any key is absent or a level
        is not a mapping.
    """
    current: Any = cfg
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


register_probe(PythonProbe())
