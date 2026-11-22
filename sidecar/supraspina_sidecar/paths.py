"""Resolution of ``${...}`` placeholders and cross-platform path translation.

Concrete values from the project configuration are injected into adapter path
templates, and ``${a.b}`` references resolve against a flattened context. Paths
are translated for WSL hosts through ``wslpath`` and preserved on native Linux
hosts.

This is the execution-side resolver. It must accept exactly the templates the
validators accept, because a path this module resolves but
``schema._resolve_template`` and the renderer's ``resolveTemplate`` leave
unresolved would escape the raw-data overlap gate those validators enforce.
``fixtures/template-resolution/cases.json`` locks the three implementations to
one resolution table.
"""

from __future__ import annotations

import copy
import re
import shutil
import subprocess
from typing import Any

_PLACEHOLDER = re.compile(r"\$\{([^}]+)\}")

# Reject path arguments containing newlines or NULs before they reach
# ``wslpath`` to prevent argument injection or truncation.
_UNSAFE_PATH = re.compile(r"[\n\r\x00]")


class _FlatContext(dict):
    """A flattened configuration view that caches its last-segment index.

    Hold exactly the keys and values :func:`flatten` produces, so equality,
    iteration, ``dict()``, and JSON serialization are indistinguishable from a
    plain dict. Carry the :func:`interpolate` suffix index as an attribute
    rather than a key, because rebuilding it per resolution costs as much as
    the flatten walk it accompanies.
    """

    __slots__ = ("_suffix_index",)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        """Build the flattened view with no index computed yet."""
        super().__init__(*args, **kwargs)
        self._suffix_index: dict[str, str] | None = None

    def suffix_index(self) -> dict[str, str]:
        """Return the bare last-segment alias index, computing it at most once."""
        if self._suffix_index is None:
            index: dict[str, str] = {}
            for key, value in self.items():
                index.setdefault(key.split(".")[-1], value)
            self._suffix_index = index
        return self._suffix_index

    def extend(self, key: str, text: str) -> _FlatContext:
        """Return this view plus one appended key, reusing the alias index.

        Append ``key`` last, exactly where flattening a mapping that gained
        that key last would place it, and carry the alias index forward under
        the same first-wins rule. A nested key whose last segment already
        matches therefore keeps its precedence.
        """
        child = _FlatContext(self)
        child[key] = text
        index = dict(self.suffix_index())
        index.setdefault(key.rsplit(".", maxsplit=1)[-1], text)
        child._suffix_index = index
        return child


class PreparedConfig(dict):
    """A configuration mapping that flattens itself at most once.

    ``Adapter.resolve`` flattens the whole configuration on every template it
    resolves. A run-scoped configuration carries one entry per subject, so that
    walk grows with the cohort and repeating it per resolution costs quadratic
    time over a listing. Cache the flattened view here instead, and discard it
    whenever the mapping changes.

    Every write must reach this mapping for the cache to stay honest, so
    producers replace a nested subtree rather than mutating it in place. Copies
    never inherit a cached view, because a copy is free to diverge from the
    mapping it came from.
    """

    __slots__ = ("_flat_view",)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        """Build the configuration with no flattened view computed yet."""
        super().__init__(*args, **kwargs)
        self._flat_view: _FlatContext | None = None

    def flat_view(self) -> _FlatContext:
        """Return the flattened view, computing it at most once per revision."""
        if self._flat_view is None:
            self._flat_view = _FlatContext(_flatten_walk(self, ""))
        return self._flat_view

    def derive(self, key: str, value: Any) -> PreparedConfig:
        """Return this configuration plus one overlaid top-level entry.

        Adapters overlay a placeholder such as ``subject`` before resolving a
        template. Rebuilding that overlay as a plain mapping would repeat the
        whole flatten walk once per subject, so extend the cached view instead
        whenever the overlay only appends one string. Fall back to an ordinary
        copy when ``key`` already exists or ``value`` is not a string, because
        then the flattened view is not simply this one plus a key.

        Returns
        -------
        PreparedConfig
            Return a new configuration; this one is left unchanged.
        """
        appends = key not in self and isinstance(value, str)
        parent_view = self.flat_view() if appends else None
        child = PreparedConfig(self)
        child[key] = value
        if parent_view is not None:
            child._flat_view = parent_view.extend(key, value)
        return child

    def _invalidate(self) -> None:
        self._flat_view = None

    def __setitem__(self, key: Any, value: Any) -> None:
        """Store one entry and discard the flattened view."""
        self._invalidate()
        super().__setitem__(key, value)

    def __delitem__(self, key: Any) -> None:
        """Remove one entry and discard the flattened view."""
        self._invalidate()
        super().__delitem__(key)

    def update(self, *args: Any, **kwargs: Any) -> None:
        """Merge entries and discard the flattened view."""
        self._invalidate()
        super().update(*args, **kwargs)

    def setdefault(self, *args: Any, **kwargs: Any) -> Any:
        """Insert a default when absent and discard the flattened view."""
        self._invalidate()
        return super().setdefault(*args, **kwargs)

    def pop(self, *args: Any, **kwargs: Any) -> Any:
        """Remove one entry and discard the flattened view."""
        self._invalidate()
        return super().pop(*args, **kwargs)

    def popitem(self) -> Any:
        """Remove one arbitrary entry and discard the flattened view."""
        self._invalidate()
        return super().popitem()

    def clear(self) -> None:
        """Remove every entry and discard the flattened view."""
        self._invalidate()
        super().clear()

    def __copy__(self) -> PreparedConfig:
        """Return a shallow copy that starts without a flattened view."""
        return PreparedConfig(dict(self))

    def __deepcopy__(self, memo: dict[int, Any]) -> PreparedConfig:
        """Return a deep copy that starts without a flattened view."""
        return PreparedConfig(copy.deepcopy(dict(self), memo))

    def __reduce__(self) -> tuple[Any, ...]:
        """Pickle as the plain mapping so no cached view is ever restored."""
        return (PreparedConfig, (dict(self),))


def _flatten_walk(config: dict[str, Any], prefix: str) -> dict[str, str]:
    """Walk a nested config mapping into dotted-key string values.

    Carry string leaves only. A number or a boolean stringified here would let
    a path template reference a value the validators never expose, so such a
    reference must stay unresolved on both sides.
    """
    out: dict[str, str] = {}
    for key, value in config.items():
        dotted = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out.update(_flatten_walk(value, dotted))
        elif isinstance(value, str):
            out[dotted] = value
    return out


def flatten(config: dict[str, Any], prefix: str = "") -> dict[str, str]:
    """Flatten a nested config dict into dotted-key string values.

    Return the cached view when a :class:`PreparedConfig` is flattened whole,
    and walk the mapping otherwise. The keys and values are identical either
    way.

    Parameters
    ----------
    prefix
        Provide the dotted-key prefix used during recursion.

    Returns
    -------
    dict
        Return a mapping of dotted keys to scalar string values.
    """
    if not prefix and isinstance(config, PreparedConfig):
        return config.flat_view()
    return _flatten_walk(config, prefix)


def interpolate(template: str, context: dict[str, str], max_passes: int = 6) -> str:
    """Resolve ``${...}`` placeholders in a template against a context.

    Resolve iteratively so nested references settle. Trim the reference, then
    match it by exact dotted key. Fall back to the bare last-segment alias only
    for a reference that carries no dot, because a dotted reference that misses
    names a key the configuration does not hold and the validators leave it
    unresolved.

    Parameters
    ----------
    template
        Provide the string that may contain ``${...}`` placeholders.
    context
        Provide the flattened key/value context.
    max_passes
        Provide the maximum substitution passes before giving up on cycles.
        Keep the default equal to the validators' limit so a template that
        settles for one resolver settles for all three.

    Returns
    -------
    str
        Return the interpolated string with unresolved placeholders intact.
    """
    if isinstance(context, _FlatContext):
        suffix_index = context.suffix_index()
    else:
        suffix_index = {}
        for key, value in context.items():
            suffix_index.setdefault(key.split(".")[-1], value)

    def resolve(match: re.Match[str]) -> str:
        name = match.group(1).strip()
        if name in context:
            return context[name]
        if "." in name:
            return match.group(0)
        return suffix_index.get(name, match.group(0))

    result = template
    for _ in range(max_passes):
        new_result = _PLACEHOLDER.sub(resolve, result)
        if new_result == result:
            break
        result = new_result
    return result


def _wslpath(path: str, flag: str) -> str:
    """Translate ``path`` with ``wslpath <flag>``, falling back to the input.

    Resolve ``wslpath`` to an absolute path via :func:`shutil.which`. Use a fixed
    argument vector without a shell, and refuse paths carrying a newline or NUL.
    Return the input unchanged when ``wslpath`` is absent or fails.

    Parameters
    ----------
    flag
        ``-w`` (posix to Windows) or ``-u`` (Windows to posix).

    Returns
    -------
    str
        Return the translated path or ``path`` unchanged after any failure.

    Raises
    ------
    ValueError
        Raise when ``path`` contains a newline or NUL byte.
    """
    if _UNSAFE_PATH.search(path):
        msg = "Remove newlines and NUL bytes from the path before translating it."
        raise ValueError(msg)
    binary = shutil.which("wslpath")
    if binary is None:
        return path
    try:
        proc = subprocess.run(  # noqa: S603 - Run an absolute binary with fixed argv.
            [binary, flag, path],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return path
    out = proc.stdout.strip("\n")
    return out if proc.returncode == 0 and out else path


def to_native(path: str, mode: str) -> str:
    """Translate a posix path to the host-native form.

    Parameters
    ----------
    mode
        Provide the platform mode: ``linux`` or ``wsl``.

    Returns
    -------
    str
        Return the path unchanged for ``linux``. Translate the posix path
        through ``wslpath -w`` under ``wsl``.
    """
    if mode != "wsl":
        return path
    return _wslpath(path, "-w")


def from_native(path: str, mode: str) -> str:
    """Translate a host-native path to posix form (inverse of :func:`to_native`).

    Return the path unchanged for ``linux``. Translate a Windows path through
    ``wslpath -u`` under ``wsl``.
    """
    if mode != "wsl":
        return path
    return _wslpath(path, "-u")
