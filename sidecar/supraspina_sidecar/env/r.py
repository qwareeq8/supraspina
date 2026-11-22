"""Probe of the R interpreter and package environment for ``R`` diagnostics.

The probe detects the Rscript interpreter used by the outlier and
final-analysis stages and reports the optional packages used by the current
first-party scripts as an advisory package check. It produces the following
checks:

``rscript``
    Locates the interpreter through ``cfg.tools.rscriptExecutable`` first and
    ``Rscript`` on PATH second, and reports its version. Reports ``missing``
    with the official r-project.org link and, on Ubuntu-family hosts, a
    copy-only ``apt`` hint. Never installs the system R package.

``rpkgs``
    Reads ``installed.packages()`` and compares it with
    :data:`~supraspina_sidecar.env.constants.R_REQUIRED_PACKAGES`. Reports
    ``found`` when all are present, ``wrong`` when some are missing, and
    ``missing`` when none are present. Offers an ``install.packages`` call only
    for missing packages through clipboard and Safe opt-in forms. Reports
    ``skipped`` without an interpreter and ``warn`` without an installer after
    a failed query.

One combined Rscript invocation is shared between the version and package
checks. No R code runs beyond that read-only query, and the subprocess is
guarded with a timeout. Report execution is gated separately on ``rmarkdown``,
``knitr``, and Pandoc: missing report packages offer per-user ``command``
installers bound to the Final stage's interpreter, and a missing Pandoc offers
a copy-only system hint plus the official installation page only while report
rendering is enabled.
"""

from __future__ import annotations

import shlex
from dataclasses import dataclass
from typing import Any

from ..adapters import tools
from ..adapters.tools import RunResult
from .base import Check, Installer, Probe, register_probe, ubuntu_host
from .constants import (
    PANDOC_INSTALL_URL,
    PANDOC_PACKAGE_HINT,
    R_CRAN_REPO,
    R_REQUIRED_PACKAGES,
    R_SYSTEM_PACKAGE_HINT,
)

#: Direct operators here when no R interpreter is found.
_R_DOWNLOAD_URL = "https://www.r-project.org"
#: Abandon the combined version and package query after this many seconds.
_QUERY_TIMEOUT = 90

#: Separate the version line from the installed-package list with this marker in
#: the single combined Rscript invocation (see :func:`_query_rscript`).
_PKG_MARK = "@@SUPRASPINA_RPKGS@@"


def _user_library_setup(*, create: bool) -> str:
    """Build R code that activates the first per-user package library.

    Use the cross-platform default provided through ``R_LIBS_USER`` even when
    the desktop process did not export it. Create and prepend the directory
    explicitly during installation because R omits nonexistent entries from
    ``.libPaths()`` at startup. Let future Rscript processes retain that
    directory through normal startup initialization.

    Parameters
    ----------
    create
        Choose whether to create and require a writable first user-library
        entry.

    Returns
    -------
    str
        Return a self-contained R expression prefix with no interpolated local
        path.
    """
    prefix = (
        'supraspina_user_libs <- strsplit(Sys.getenv("R_LIBS_USER", unset = ""), '
        ".Platform$path.sep, fixed = TRUE)[[1]]; "
        "supraspina_user_libs <- path.expand("
        "supraspina_user_libs[nzchar(supraspina_user_libs)]); "
        "supraspina_user_libs <- "
        'supraspina_user_libs[toupper(supraspina_user_libs) != "NULL"]; '
    )
    if not create:
        return (
            prefix + "supraspina_user_libs <- supraspina_user_libs[dir.exists("
            "supraspina_user_libs)]; "
            "if (length(supraspina_user_libs) > 0L) "
            ".libPaths(unique(c(supraspina_user_libs, .libPaths()))); "
        )
    return (
        prefix + "if (length(supraspina_user_libs) == 0L) "
        'stop("Set R_LIBS_USER to a nonempty path."); '
        "supraspina_user_lib <- supraspina_user_libs[[1L]]; "
        "if (!dir.exists(supraspina_user_lib) && "
        "!dir.create(supraspina_user_lib, recursive = TRUE, showWarnings = FALSE) && "
        "!dir.exists(supraspina_user_lib)) "
        'stop("Create the R user library manually; automatic creation failed."); '
        "if (file.access(supraspina_user_lib, 2L) != 0L) "
        'stop("Make the R user library writable."); '
        ".libPaths(unique(c(supraspina_user_lib, .libPaths()))); "
    )


#: Activate any existing per-user library with this Rscript expression, print
#: the version string, then print the installed package names after the marker.
_COMBINED_EXPR = (
    _user_library_setup(create=False)
    + f'cat(R.version.string); cat("\\n{_PKG_MARK}\\n"); '
    "cat(rownames(installed.packages()))"
)


@dataclass
class _RscriptQuery:
    """Represent the parsed outcome of the combined Rscript invocation.

    Attributes
    ----------
    version
        Record the dotted R version, or the raw line when no dotted token is
        found.
    installed
        Record the set of installed package names. Leave it empty when the
        query failed.
    ok
        Record whether the query exited cleanly (rc 0). Refuse to offer a
        reinstall when ``False`` because the query itself failed.
    """

    version: str
    installed: set[str]
    ok: bool


def _final_rscript_template(cfg: dict[str, Any]) -> str:
    """Return the Final stage's saved Rscript template, or the tool default."""
    steps = cfg.get("steps", {}) if isinstance(cfg, dict) else {}
    step = steps.get("final", {}) if isinstance(steps, dict) else {}
    params = step.get("params", {}) if isinstance(step, dict) else {}
    template = params.get("rscriptExecutable") if isinstance(params, dict) else None
    if isinstance(template, str) and template:
        return template
    return "${tools.rscriptExecutable}"


def _resolve_final_rscript(self: Probe, cfg: dict[str, Any]) -> str | None:
    """Resolve the interpreter the Final stage is configured to execute.

    Mirror :meth:`~supraspina_sidecar.adapters.final.FinalAdapter._rscript` so the
    readiness gate probes the executable the stage actually spawns. Fall back to
    the shared tool configuration when the stage keeps the default template.
    """
    resolved = self.resolve(_final_rscript_template(cfg), cfg)
    if resolved and "${" not in resolved:
        return resolved
    return _resolve_rscript(self, cfg)


def _resolve_rscript(self: Probe, cfg: dict[str, Any]) -> str | None:
    """Resolve the Rscript path from config first, then PATH.

    Parameters
    ----------
    self
        Provide the probe instance used for ``${...}`` resolution.
    cfg
        Provide the full project configuration mapping (possibly empty).

    Returns
    -------
    str or None
        Return an absolute or configured Rscript path, or ``None`` when neither
        the config nor PATH yields one.
    """
    tools_cfg = cfg.get("tools", {}) if isinstance(cfg, dict) else {}
    configured = ""
    if isinstance(tools_cfg, dict):
        configured = tools_cfg.get("rscriptExecutable", "")
    if configured:
        return self.resolve(configured, cfg)
    return tools.which("Rscript")


def _parse_version(text: str) -> str:
    """Extract a dotted R version from ``Rscript --version`` output.

    Expect the first output line to resemble ``Rscript (R) version 4.3.3
    (2024-02-29)`` on R 4.x, while allowing older builds to print ``R scripting
    front-end version 3.6.3 ...``. Return the first dotted token after
    ``version``, or fall back to the whole stripped line when no such token is
    found.

    Parameters
    ----------
    text
        Provide the first line of the version output.

    Returns
    -------
    str
        Return the dotted version (for example, ``4.3.3``) or the stripped line.
    """
    line = text.strip()
    words = line.split()
    for index, word in enumerate(words):
        if word == "version" and index + 1 < len(words):
            return words[index + 1]
    return line


def _query_rscript(rscript: str | None) -> _RscriptQuery | None:
    """Run ONE combined Rscript invocation for the version + package list.

    Evaluate :data:`_COMBINED_EXPR` with a single :func:`tools.run` call. Expect
    the version string, the :data:`_PKG_MARK` separator, then the installed
    package names. Parse this one result for both checks so Rscript cold-starts
    only once per sweep.

    Parameters
    ----------
    rscript
        Provide the resolved Rscript path, or ``None`` when no interpreter was
        found.

    Returns
    -------
    _RscriptQuery or None
        Return the parsed query, or ``None`` when no interpreter was found. Set
        ``ok`` to ``False`` when the invocation exits non-zero so callers can
        refuse to offer a reinstall when the query itself fails.
    """
    if not rscript:
        return None
    result: RunResult = tools.run(
        [rscript, "-e", _COMBINED_EXPR],
        timeout=_QUERY_TIMEOUT,
    )
    version_text, _, package_text = result.stdout.partition(_PKG_MARK)
    first = version_text.strip().splitlines()
    version = _parse_version(first[0]) if first else "unknown"
    return _RscriptQuery(
        version=version,
        installed=set(package_text.split()),
        ok=result.rc == 0,
    )


def _install_one_liner(missing: tuple[str, ...], interpreter: str = "Rscript") -> str:
    """Build the per-user ``Rscript -e`` clipboard fix.

    Parameters
    ----------
    interpreter
        Provide the Rscript path the clipboard line should invoke. Keep the
        default PATH name for the advisory ``rpkgs`` fix, and pass the
        resolved stage interpreter for the report-package fixes so the
        install lands in the library that stage actually reads.

    Returns
    -------
    str
        Return a single shell line, quoted as valid standalone bash, that
        installs only the missing packages from :data:`R_CRAN_REPO`.
    """
    expr = _install_expr(missing)
    return f"{shlex.quote(interpreter)} -e '{expr}'"


def _install_expr(missing: tuple[str, ...]) -> str:
    """Build the noninteractive per-user package-install expression.

    Returns
    -------
    str
        Pass the R expression as one ``Rscript -e`` argv element. Get the
        cross-platform per-user path from ``R_LIBS_USER``, create and activate
        it, then install only the missing packages into that exact library.
    """
    quoted = ", ".join(f'"{name}"' for name in missing)
    return (
        _user_library_setup(create=True)
        + f"install.packages(c({quoted}), lib = supraspina_user_lib, "
        f'repos = "{R_CRAN_REPO}")'
    )


def _system_r_hint() -> str:
    """Return the reviewed copy-only apt hint on Ubuntu-family hosts.

    Scope the Ubuntu 22.04/24.04 ``r-base`` command through
    :func:`~supraspina_sidecar.env.base.ubuntu_host` instead of emitting it
    unconditionally; other hosts keep only the r-project.org link.
    """
    return R_SYSTEM_PACKAGE_HINT if ubuntu_host() else ""


def _system_package_installer(hint: str) -> Installer | None:
    """Build the copy-only manual installer for a system package hint.

    Parameters
    ----------
    hint
        Provide the reviewed apt one-liner, or an empty string outside
        Ubuntu-family hosts.

    Returns
    -------
    Installer or None
        Return a ``manual`` installer that is never executed, or ``None``
        when no reviewed command applies to this host.
    """
    if not hint:
        return None
    return Installer(
        kind="manual",
        one_liner=hint,
        note=(
            "Copy and run the system install yourself because it changes "
            "system packages and needs sudo."
        ),
    )


def _report_package_installer(package: str, rscript: str) -> Installer:
    """Build the per-user ``command`` installer for one report package.

    Bind the argv to the exact interpreter the Final stage spawns so the
    install lands in the library that stage reads.

    Parameters
    ----------
    package
        Provide the missing report package (``rmarkdown`` or ``knitr``).
    rscript
        Provide the resolved Final stage interpreter.

    Returns
    -------
    Installer
        Return the opt-in ``command`` installer for the package.
    """
    return Installer(
        kind="command",
        argv=[rscript, "-e", _install_expr((package,))],
        one_liner=_install_one_liner((package,), interpreter=rscript),
        note=(
            "Create and use your R_LIBS_USER library, and install any "
            "required system build libraries."
        ),
    )


#: Explain why a report-only dependency is skipped. Name the dependency so the
#: row reads on its own in the requirements list.
_REPORT_DISABLED_DETAIL = (
    "{name} is not needed because the Final stage does not render an HTML report."
)
#: The identity text of that detail, which the check identity digests.
_REPORT_DISABLED_IDENTITY = (
    "Skip {name} because the Final stage does not render an HTML report."
)


def _render_report_enabled(cfg: dict[str, Any]) -> bool:
    """Report whether the Final stage will render the optional HTML report.

    Mirror ``FinalAdapter.required_check_ids``: default to ``True`` when the
    parameter is absent so the Pandoc remediation matches the stage gate
    exactly.
    """
    steps = cfg.get("steps", {}) if isinstance(cfg, dict) else {}
    step = steps.get("final", {}) if isinstance(steps, dict) else {}
    params = step.get("params", {}) if isinstance(step, dict) else {}
    if not isinstance(params, dict):
        return True
    return bool(params.get("renderReport", True))


class RProbe(Probe):
    """Probe the Rscript interpreter and advisory optional packages."""

    name = "R"

    def checks(self, cfg: dict[str, Any]) -> list[Check]:
        """Probe Rscript and the required R packages.

        Run one combined Rscript invocation for the version and installed
        packages so ``rscript`` and ``rpkgs`` share a single cold start per
        sweep, then emit their separate checks.

        Parameters
        ----------
        cfg
            Provide the full project configuration mapping (possibly empty).

        Returns
        -------
        list of Check
            Return the ``rscript`` and ``rpkgs`` results in display order.
        """
        rscript = _resolve_rscript(self, cfg)
        query = _query_rscript(rscript)
        final_rscript = _resolve_final_rscript(self, cfg)
        final_query = (
            query if final_rscript == rscript else _query_rscript(final_rscript)
        )
        return [
            self._rscript_check(rscript, query),
            self._rpkgs_check(rscript, query),
            self._final_rscript_check(final_rscript, final_query),
            self._rmarkdown_check(cfg, final_rscript, final_query),
            self._knitr_check(cfg, final_rscript, final_query),
            self._pandoc_check(cfg, final_rscript, final_query),
        ]

    def _final_rscript_check(
        self, rscript: str | None, query: _RscriptQuery | None
    ) -> Check:
        """Build the ``finalrscript`` check for the Final stage's interpreter."""
        base = self._rscript_check(rscript, query)
        detail = base.detail
        if base.status == "missing" and not rscript:
            detail = (
                "Configure the Final stage Rscript executable or add it to "
                "PATH. Get it opens the official R project site."
            )
        return Check(
            id="finalrscript",
            label="R analysis Rscript",
            status=base.status,
            detail=detail,
            recommended_cmd=base.recommended_cmd,
            download_url=base.download_url,
            installer=base.installer,
            identity_detail=base.identity_detail if detail == base.detail else None,
        )

    def _knitr_check(
        self,
        cfg: dict[str, Any],
        rscript: str | None,
        query: _RscriptQuery | None,
    ) -> Check:
        """Report whether the configured R library contains knitr.

        Report an absent package as ``skipped`` while report rendering is off,
        because only the rendered report needs it. Keep the opt-in installer so
        the row still offers its remediation ahead of enabling the report.
        """
        if not rscript or query is None:
            return Check(
                id="knitr",
                label="knitr",
                status="skipped",
                detail="Configure Rscript before querying knitr.",
            )
        if not query.ok:
            return Check(
                id="knitr",
                label="knitr",
                status="warn",
                detail="Inspect the configured R package library; its query failed.",
            )
        if "knitr" in query.installed:
            return Check(
                id="knitr",
                label="knitr",
                status="found",
                detail=f"knitr is installed for {rscript}.",
                identity_detail=f"Use the knitr installation available to {rscript}.",
            )
        rendering = _render_report_enabled(cfg)
        return Check(
            id="knitr",
            label="knitr",
            status="missing" if rendering else "skipped",
            detail=(
                f"Install knitr for {rscript}."
                if rendering
                else _REPORT_DISABLED_DETAIL.format(name="knitr")
            ),
            identity_detail=(
                None if rendering else _REPORT_DISABLED_IDENTITY.format(name="knitr")
            ),
            recommended_cmd=_install_one_liner(("knitr",), interpreter=rscript),
            installer=_report_package_installer("knitr", rscript),
        )

    def _rmarkdown_check(
        self,
        cfg: dict[str, Any],
        rscript: str | None,
        query: _RscriptQuery | None,
    ) -> Check:
        """Report whether the configured R library contains rmarkdown.

        Report an absent package as ``skipped`` while report rendering is off,
        because only the rendered report needs it. Keep the opt-in installer so
        the row still offers its remediation ahead of enabling the report.
        """
        if not rscript or query is None:
            return Check(
                id="rmarkdown",
                label="R Markdown",
                status="skipped",
                detail="Configure Rscript before querying rmarkdown.",
            )
        if not query.ok:
            return Check(
                id="rmarkdown",
                label="R Markdown",
                status="warn",
                detail="Inspect the configured R package library; its query failed.",
            )
        if "rmarkdown" in query.installed:
            return Check(
                id="rmarkdown",
                label="R Markdown",
                status="found",
                detail=f"rmarkdown is installed for {rscript}.",
                identity_detail=(
                    f"Use the rmarkdown installation available to {rscript}."
                ),
            )
        rendering = _render_report_enabled(cfg)
        return Check(
            id="rmarkdown",
            label="R Markdown",
            status="missing" if rendering else "skipped",
            detail=(
                f"Install rmarkdown for {rscript}."
                if rendering
                else _REPORT_DISABLED_DETAIL.format(name="rmarkdown")
            ),
            identity_detail=(
                None
                if rendering
                else _REPORT_DISABLED_IDENTITY.format(name="rmarkdown")
            ),
            recommended_cmd=_install_one_liner(("rmarkdown",), interpreter=rscript),
            installer=_report_package_installer("rmarkdown", rscript),
        )

    def _pandoc_check(
        self,
        cfg: dict[str, Any],
        rscript: str | None,
        query: _RscriptQuery | None,
    ) -> Check:
        """Report the Pandoc binary required by the R Markdown command.

        Report an absent binary as ``skipped``, and offer no remediation, while
        report rendering is off, because nothing requires Pandoc otherwise. Keep
        the probe on the sidecar's PATH; rmarkdown locates Pandoc from the
        spawned Rscript process the same way unless ``RSTUDIO_PANDOC``
        overrides it.
        """
        if not rscript or query is None:
            return Check(
                id="pandoc",
                label="Pandoc",
                status="skipped",
                detail="Configure Rscript before rendering reports.",
            )
        pandoc = tools.which("pandoc")
        if pandoc:
            return Check(
                id="pandoc",
                label="Pandoc",
                status="found",
                detail=pandoc,
            )
        if not _render_report_enabled(cfg):
            return Check(
                id="pandoc",
                label="Pandoc",
                status="skipped",
                detail=_REPORT_DISABLED_DETAIL.format(name="Pandoc"),
                identity_detail=_REPORT_DISABLED_IDENTITY.format(name="Pandoc"),
            )
        hint = PANDOC_PACKAGE_HINT if ubuntu_host() else ""
        return Check(
            id="pandoc",
            label="Pandoc",
            status="missing",
            detail=(
                "Install Pandoc or add it to PATH. Get it opens the official "
                "Pandoc installation instructions."
            ),
            recommended_cmd=hint,
            download_url=PANDOC_INSTALL_URL,
            installer=_system_package_installer(hint),
        )

    def _rscript_check(self, rscript: str | None, query: _RscriptQuery | None) -> Check:
        """Build the ``rscript`` interpreter-location check."""
        hint = _system_r_hint()
        if not rscript or query is None:
            return Check(
                id="rscript",
                label="Rscript",
                status="missing",
                detail=(
                    "Configure Rscript or add it to PATH. Get it opens the "
                    "official R project site."
                ),
                recommended_cmd=hint,
                download_url=_R_DOWNLOAD_URL,
                installer=_system_package_installer(hint),
            )
        if not query.ok:
            # A probe that could not run must never satisfy the rscript
            # execution gate; report the configured path so the operator can
            # correct it before a mid-run failure.
            detail = (
                f"Configure an existing Rscript; the saved path was not "
                f"found: {rscript}."
                if not tools.exists(rscript)
                else f"Reinstall R because {rscript} failed to run."
            )
            return Check(
                id="rscript",
                label="Rscript",
                status="missing",
                detail=detail,
                recommended_cmd=hint,
                download_url=_R_DOWNLOAD_URL,
                installer=_system_package_installer(hint),
            )
        return Check(
            id="rscript",
            label="Rscript",
            status="found",
            detail=f"{rscript} runs R {query.version}.",
            identity_detail=f"Use R {query.version} from {rscript}.",
        )

    def _rpkgs_check(self, rscript: str | None, query: _RscriptQuery | None) -> Check:
        """Build the advisory ``rpkgs`` package check.

        Return ``skipped`` when no interpreter was found. Return ``warn``
        without an installer when the installed-packages query exits non-zero,
        because offering a reinstall would be wrong when the query itself
        failed. Compute the present and missing sets after a successful query.
        """
        if not rscript or query is None:
            return Check(
                id="rpkgs",
                label="Optional R packages",
                status="skipped",
                detail="Configure Rscript before querying installed packages.",
            )
        if not query.ok:
            return Check(
                id="rpkgs",
                label="Optional R packages",
                status="warn",
                detail="Inspect the Rscript error; querying installed packages failed.",
            )
        installed = query.installed
        missing = tuple(p for p in R_REQUIRED_PACKAGES if p not in installed)
        if not missing:
            return Check(
                id="rpkgs",
                label="Optional R packages",
                status="found",
                detail=(
                    f"All {len(R_REQUIRED_PACKAGES)} advisory packages are present."
                ),
            )
        status = "missing" if len(missing) == len(R_REQUIRED_PACKAGES) else "wrong"
        one_liner = _install_one_liner(missing)
        return Check(
            id="rpkgs",
            label="Optional R packages",
            status=status,
            detail="Install these missing R packages: " + ", ".join(missing) + ".",
            recommended_cmd=one_liner,
            installer=Installer(
                kind="command",
                argv=[rscript, "-e", _install_expr(missing)],
                one_liner=one_liner,
                note=(
                    "Create and use your R_LIBS_USER library, and install any "
                    "required system build libraries."
                ),
            ),
        )


register_probe(RProbe())
