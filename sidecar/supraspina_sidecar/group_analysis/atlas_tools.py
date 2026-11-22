"""The labeling tool facts (``AtlasToolFact``) and the tools' identity.

The manager probes the tools on its own thread with a 5 s limit, never
through the environment check. FreeSurfer 8.2.0 ships samseg's gems
bindings built for CPython 3.12 beside a Python 3.8 fspython, so its own
``segment_subregions`` cannot start; the subregion recipes then run
FreeSurfer's samseg package under the machine's ``subregionsPython`` (a
user-chosen Python 3.12 environment with numpy, scipy, nibabel, and surfa)
through a PYTHONPATH folder that links only ``samseg``. When a FreeSurfer's
own runtime can load samseg and no preference is set, fspython runs it.

The tool identity (the FreeSurfer build and the interpreter's Python
version) is recorded in every ``labels.json``; a change marks labels stale
(``tool-changed``).
"""

from __future__ import annotations

import contextlib
import glob
import json
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from ..bounded_io import BoundedReadError, read_bounded_regular

#: The longest a tool probe may run, in seconds.
PROBE_SECONDS = 5.0
#: The FreeSurfer programs each surface or volume recipe runs.
PROGRAMS: dict[str, str] = {
    "mri-surf2surf": "mri_surf2surf",
    "mris-ca-label": "mris_ca_label",
    "mris-anatomical-stats": "mris_anatomical_stats",
    "mri-segstats": "mri_segstats",
}
_STAMP = re.compile(r"(\d+\.\d+\.\d+)-(\d{8}-[0-9a-f]{4,40})")
_BINDINGS = re.compile(r"gemsbindings\.cpython-(\d)(\d+)-")
_LIB_PYTHON = re.compile(r"python(\d)\.(\d+)$")
_PROBE_CODE = (
    "import json, sys\n"
    "import numpy, scipy, nibabel, surfa\n"
    "import samseg.gems\n"
    "print(json.dumps({'python': sys.version.split()[0],"
    " 'numpy': numpy.__version__, 'scipy': scipy.__version__}))\n"
)
_MAX_DETAIL = 480

#: Run one probe command: argv, environment, timeout -> (status, stdout, stderr).
Runner = Callable[[list[str], Mapping[str, str], float], tuple[int, str, str]]


def run_probe(
    argv: list[str], environment: Mapping[str, str], timeout: float
) -> tuple[int, str, str]:
    """Run one probe command and capture its output.

    Raises
    ------
    subprocess.TimeoutExpired
        When it outlives ``timeout``.
    """
    completed = subprocess.run(  # noqa: S603 - the argv is the chosen interpreter.
        argv,
        env=dict(environment),
        capture_output=True,
        timeout=timeout,
        check=False,
        stdin=subprocess.DEVNULL,
    )
    return (
        completed.returncode,
        completed.stdout.decode("utf-8", "replace")[-4096:],
        completed.stderr.decode("utf-8", "replace")[-4096:],
    )


@dataclass(frozen=True)
class FreeSurferFacts:
    """Hold what one FreeSurfer home offers the labeling."""

    home: str | None
    build: str | None
    version: str | None
    samseg: str | None
    fspython: str | None
    #: True when FreeSurfer's own fspython can load samseg's bindings.
    own_runtime: bool
    #: The Python versions of fspython and of samseg's bindings, as "3.8".
    fspython_version: str | None
    bindings_version: str | None


def freesurfer_facts(home: str | None) -> FreeSurferFacts:
    """Read the build stamp and the samseg layout of a FreeSurfer home."""
    if not home or not os.path.isdir(home):
        return FreeSurferFacts(home or None, None, None, None, None, False, None, None)
    build: str | None = None
    with contextlib.suppress(BoundedReadError, OSError, UnicodeDecodeError):
        text = read_bounded_regular(os.path.join(home, "build-stamp.txt"), 4096)
        build = text.decode("utf-8").strip() or None
    match = _STAMP.search(build or "")
    version = match.group(1) if match else None
    samseg: str | None = None
    fspython_version: str | None = None
    bindings_version: str | None = None
    for candidate in sorted(
        glob.glob(os.path.join(home, "python", "lib", "python3.*"))
    ):
        package = os.path.join(candidate, "site-packages", "samseg")
        if os.path.isdir(package):
            samseg = package
            lib = _LIB_PYTHON.search(candidate)
            fspython_version = f"{lib.group(1)}.{lib.group(2)}" if lib else None
            for binding in glob.glob(os.path.join(package, "gems", "gemsbindings*")):
                found = _BINDINGS.search(os.path.basename(binding))
                if found:
                    bindings_version = f"{found.group(1)}.{found.group(2)}"
            break
    fspython = os.path.join(home, "bin", "fspython")
    return FreeSurferFacts(
        home=home,
        build=build,
        version=version,
        samseg=samseg,
        fspython=fspython if os.access(fspython, os.X_OK) else None,
        own_runtime=(
            samseg is not None
            and bindings_version is not None
            and bindings_version == fspython_version
        ),
        fspython_version=fspython_version,
        bindings_version=bindings_version,
    )


def samseg_environment(
    base: Mapping[str, str], facts: FreeSurferFacts, link_dir: str
) -> dict[str, str]:
    """Return ``base`` with FreeSurfer's samseg (only) on the Python path.

    ``link_dir`` receives one symlink, ``samseg``, to the package, so the
    interpreter sees no other fspython package.
    """
    environment = {
        key: value
        for key, value in base.items()
        if key not in {"PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP"}
    }
    if facts.samseg is not None:
        link = os.path.join(link_dir, "samseg")
        if not os.path.lexists(link):
            os.symlink(facts.samseg, link)
        environment["PYTHONPATH"] = link_dir
    if facts.home:
        environment["FREESURFER_HOME"] = facts.home
    environment["PYTHONNOUSERSITE"] = "1"
    return environment


def _detail(text: str) -> str:
    line = next(
        (item.strip() for item in reversed(text.splitlines()) if item.strip()), ""
    )
    return line[:200]


@dataclass(frozen=True)
class ToolReport:
    """Hold the tool facts and the identity the labeling records."""

    facts: list[dict[str, Any]]
    #: The FreeSurfer build, or None.
    build: str | None
    #: The interpreter that runs samseg and its versions, or None.
    interpreter: dict[str, str] | None
    freesurfer: FreeSurferFacts

    def state(self, tool_id: str) -> str:
        """Return one tool's state, ``unknown`` when it was not probed."""
        for fact in self.facts:
            if fact["toolId"] == tool_id:
                return str(fact["state"])
        return "unknown"

    def identity(self) -> dict[str, Any]:
        """Return the tool identity ``labels.json`` records."""
        return {"freesurferBuild": self.build, "interpreter": self.interpreter}


def _fact(tool_id: str, state: str, detail: str, fix: str | None) -> dict[str, Any]:
    return {
        "toolId": tool_id,
        "state": state,
        "detail": detail[:_MAX_DETAIL],
        "fix": fix,
    }


def _probe_python(
    python: str,
    facts: FreeSurferFacts,
    runner: Runner,
    timeout: float,
) -> tuple[dict[str, Any], dict[str, str] | None]:
    if not os.path.isfile(python) or not os.access(python, os.X_OK):
        return (
            _fact(
                "subregions-python",
                "missing",
                f"The chosen Python was not found: {python}.",
                "choose-subregions-python",
            ),
            None,
        )
    if facts.samseg is None:
        return (
            _fact(
                "subregions-python",
                "unknown",
                "The chosen Python was not checked, because FreeSurfer's samseg "
                "package is missing.",
                None,
            ),
            None,
        )
    link_dir = tempfile.mkdtemp(prefix="supraspina-samseg-")
    try:
        environment = samseg_environment(os.environ, facts, link_dir)
        try:
            status, out, err = runner(
                [python, "-s", "-c", _PROBE_CODE], environment, timeout
            )
        except subprocess.TimeoutExpired:
            return (
                _fact(
                    "subregions-python",
                    "unknown",
                    f"The Python check did not finish in {timeout:g} seconds.",
                    None,
                ),
                None,
            )
        except OSError:
            status, out, err = 1, "", "The chosen Python could not start."
    finally:
        shutil.rmtree(link_dir, ignore_errors=True)
    versions: Any = None
    with contextlib.suppress(ValueError):
        versions = json.loads(out.strip().splitlines()[-1]) if out.strip() else None
    if (
        status != 0
        or not isinstance(versions, dict)
        or not all(isinstance(versions.get(key), str) for key in ("python", "numpy"))
    ):
        reason = _detail(err) or "it exited with an error"
        return (
            _fact(
                "subregions-python",
                "broken",
                f"The chosen Python cannot load FreeSurfer's samseg: {reason}.",
                "choose-subregions-python",
            ),
            None,
        )
    interpreter = {
        "path": os.path.realpath(python),
        "python": str(versions["python"]),
        "numpy": str(versions["numpy"]),
        "scipy": str(versions.get("scipy", "")),
    }
    return (
        _fact(
            "subregions-python",
            "ok",
            f"Python {interpreter['python']} loads FreeSurfer's samseg "
            f"(numpy {interpreter['numpy']}).",
            None,
        ),
        interpreter,
    )


def probe_tools(
    freesurfer_home: str | None,
    subregions_python: str | None,
    *,
    runner: Runner = run_probe,
    timeout: float = PROBE_SECONDS,
) -> ToolReport:
    """Probe every labeling tool once.

    Parameters
    ----------
    runner
        Run one probe command; tests replace it.
    timeout
        The interpreter probe's limit in seconds.

    Returns
    -------
    ToolReport
        One fact per tool and the identity the labeling records.
    """
    fs = freesurfer_facts(freesurfer_home)
    facts: list[dict[str, Any]] = []
    if fs.home is None:
        facts.append(
            _fact(
                "freesurfer-home",
                "missing",
                "FreeSurfer is not set for this project.",
                "set-freesurfer-home",
            )
        )
    elif fs.build is None:
        facts.append(
            _fact(
                "freesurfer-home",
                "broken",
                f"FreeSurfer at {fs.home} has no readable build stamp.",
                "set-freesurfer-home",
            )
        )
    else:
        facts.append(
            _fact(
                "freesurfer-home",
                "ok",
                f"FreeSurfer {fs.version or 'build'} ({fs.build}).",
                None,
            )
        )
    name = f"FreeSurfer {fs.version}" if fs.version else "This FreeSurfer"
    if fs.samseg is None:
        facts.append(
            _fact(
                "segment-subregions",
                "missing",
                f"{name} has no samseg package, so it cannot label subregions.",
                "import-outputs",
            )
        )
    elif fs.own_runtime:
        facts.append(
            _fact(
                "segment-subregions",
                "ok",
                f"{name} segment_subregions can run with its own Python.",
                None,
            )
        )
    else:
        facts.append(
            _fact(
                "segment-subregions",
                "broken",
                f"{name} segment_subregions cannot start: fspython "
                f"{fs.fspython_version or '(unknown)'} cannot load samseg's Python "
                f"{fs.bindings_version or '(unknown)'} bindings.",
                "choose-subregions-python",
            )
        )
    interpreter: dict[str, str] | None = None
    if subregions_python:
        fact, interpreter = _probe_python(subregions_python, fs, runner, timeout)
        facts.append(fact)
    elif fs.own_runtime and fs.fspython is not None:
        fact, interpreter = _probe_python(fs.fspython, fs, runner, timeout)
        facts.append(fact)
    else:
        facts.append(
            _fact(
                "subregions-python",
                "missing",
                "No Python 3.12 environment is chosen for FreeSurfer subregions.",
                "choose-subregions-python",
            )
        )
    bin_dir = os.path.join(fs.home, "bin") if fs.home else None
    for tool_id, program in PROGRAMS.items():
        path = os.path.join(bin_dir, program) if bin_dir else None
        if path is not None and os.path.isfile(path) and os.access(path, os.X_OK):
            facts.append(_fact(tool_id, "ok", f"{program} is available.", None))
        else:
            facts.append(
                _fact(
                    tool_id,
                    "missing",
                    f"{program} was not found in FreeSurfer's bin folder.",
                    "set-freesurfer-home",
                )
            )
    return ToolReport(
        facts=facts, build=fs.build, interpreter=interpreter, freesurfer=fs
    )


def subregions_interpreter(report: ToolReport, preference: str | None) -> str | None:
    """Return the interpreter that runs samseg, or None when none can."""
    if report.state("subregions-python") != "ok":
        return None
    if preference:
        return preference
    return report.freesurfer.fspython


def recipe_ready(report: ToolReport, tools: tuple[str, ...]) -> str | None:
    """Return why a recipe's tools cannot run now, or None when they can.

    A broken FreeSurfer ``segment_subregions`` does not block a recipe
    whose interpreter can load samseg.
    """
    for tool_id in tools:
        state = report.state(tool_id)
        if tool_id == "segment-subregions" and state == "broken":
            continue
        if state != "ok":
            detail = next(
                (fact["detail"] for fact in report.facts if fact["toolId"] == tool_id),
                "A labeling tool is not available.",
            )
            return str(detail)
    return None
