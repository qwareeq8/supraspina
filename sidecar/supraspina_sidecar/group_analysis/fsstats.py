"""Bounded, read-only parsers of FreeSurfer per-subject stats files (tier A).

The v2 catalog reads each subject's ``derivatives/freesurfer/<id>/stats/``
directly: the ``aparc`` family (``aparc.a2009s``, ``aparc.DKTatlas``,
``aparc.pial``, ``BA_exvivo``, ``BA_exvivo.thresh``), ``w-g.pct``,
``wmparc``, ``entowm``, ``aseg`` (its ``# Measure`` lines, eTIV and sTIV
included), ``synthseg.vol.csv`` and ``synthseg.tiv.dat``, and subregion
``*.volumes.txt`` files a recon already has. Every read is bounded and never
follows a symlinked final component; nothing here imports ``adapters`` or
writes anything.

Each ``read_*`` function reads one file; the ``parse_*`` functions take the
bytes, so a caller that hashes what it read parses the same bytes. A value
FreeSurfer writes as ``nan`` or ``-nan`` reads as missing.
"""

from __future__ import annotations

import csv
import hashlib
import io
import math
import re
from dataclasses import dataclass, field

from ..bounded_io import BoundedReadError, read_bounded_regular
from .spec import GroupAnalysisError

#: The largest stats file the parsers read.
MAX_STATS_BYTES = 4 * 1024 * 1024
#: The stats-table columns the ``aparc`` family names, by metric.
APARC_COLUMNS: dict[str, str] = {
    "NumVert": "NumVert",
    "SurfArea": "SurfArea",
    "GrayVol": "GrayVol",
    "ThickAvg": "ThickAvg",
    "ThickStd": "ThickStd",
    "MeanCurv": "MeanCurv",
    "GausCurv": "GausCurv",
    "FoldInd": "FoldInd",
    "CurvInd": "CurvInd",
}
#: The most table rows or structures one file may carry.
MAX_ROWS = 4_096
_MAX_COLUMNS = 64
_STRUCTURE_CHARACTERS = re.compile(r"[^A-Za-z0-9_.&-]+")
_SYNTHSEG_TIV = "total intracranial"


@dataclass(frozen=True)
class StatsFile:
    """Hold one parsed stats file.

    ``measures`` maps each ``# Measure`` line's short name (for example
    ``eTIV``) to its value; ``columns`` names the table columns in
    ``ColHeaders`` order; ``rows`` maps each ``StructName`` to its numeric
    values by column. ``sha256`` is the digest of the bytes parsed.
    """

    path: str
    sha256: str
    measures: dict[str, float] = field(default_factory=dict)
    columns: tuple[str, ...] = ()
    rows: dict[str, dict[str, float]] = field(default_factory=dict)


def read_bytes(path: str) -> bytes:
    """Read one stats file within :data:`MAX_STATS_BYTES`.

    Parameters
    ----------
    path
        The confined path.

    Raises
    ------
    GroupAnalysisError
        When the file is missing, too large, a symlink, or changes while read.
    """
    try:
        return read_bounded_regular(path, MAX_STATS_BYTES)
    except FileNotFoundError as exc:
        raise GroupAnalysisError("The stats file does not exist.") from exc
    except BoundedReadError as exc:
        raise GroupAnalysisError(
            "The stats file is not a regular file within 4 MiB, or it changed "
            "while it was read."
        ) from exc
    except OSError as exc:
        raise GroupAnalysisError("The stats file cannot be read.") from exc


def _text(payload: bytes) -> str:
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError:
        return payload.decode("latin-1")


def _number(text: str) -> float | None:
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _is_number(text: str) -> bool:
    try:
        float(text)
    except ValueError:
        return False
    return True


def parse_stats(payload: bytes, path: str = "") -> StatsFile:  # noqa: PLR0912
    """Parse the bytes of one FreeSurfer ``.stats`` file.

    Parameters
    ----------
    path
        The path, kept on the result.

    Returns
    -------
    StatsFile
        The measures, columns, and rows.

    Raises
    ------
    GroupAnalysisError
        When the table has no ``ColHeaders`` line with ``StructName``, or
        too many rows or columns.
    """
    measures: dict[str, float] = {}
    columns: tuple[str, ...] = ()
    rows: dict[str, dict[str, float]] = {}
    for line in _text(payload).splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            body = stripped[1:].strip()
            if body.startswith("Measure "):
                parts = [part.strip() for part in body[8:].split(",")]
                if len(parts) >= 4:  # noqa: PLR2004
                    value = _number(parts[3])
                    if parts[1] and value is not None:
                        measures.setdefault(parts[1], value)
            elif body.startswith("ColHeaders"):
                columns = tuple(body.split()[1:])
                if len(columns) > _MAX_COLUMNS or "StructName" not in columns:
                    raise GroupAnalysisError(
                        "The stats table has no StructName column."
                    )
            continue
        if not columns:
            raise GroupAnalysisError("The stats table has rows before its header.")
        cells = stripped.split()
        if len(cells) != len(columns):
            raise GroupAnalysisError("A stats table row has the wrong column count.")
        name = cells[columns.index("StructName")]
        if name in rows:
            continue
        if len(rows) >= MAX_ROWS:
            raise GroupAnalysisError("The stats table has too many rows.")
        rows[name] = {
            column: value
            for column, cell in zip(columns, cells, strict=True)
            if column != "StructName" and (value := _number(cell)) is not None
        }
    if rows and not columns:
        raise GroupAnalysisError("The stats table has no StructName column.")
    return StatsFile(
        path=path,
        sha256=hashlib.sha256(payload).hexdigest(),
        measures=measures,
        columns=columns,
        rows=rows,
    )


def read_stats(path: str) -> StatsFile:
    """Parse one FreeSurfer ``.stats`` file.

    Parameters
    ----------
    path
        The confined path of the stats file.

    Returns
    -------
    StatsFile
        The measures, columns, and rows.

    Raises
    ------
    GroupAnalysisError
        When the file is missing, too large, a symlink, or malformed.
    """
    return parse_stats(read_bytes(path), path)


def parse_volumes_txt(payload: bytes) -> dict[str, float]:
    """Parse the bytes of a subregion ``*.volumes.txt`` file.

    Parameters
    ----------
    payload
        The file's bytes: one ``name value`` pair per line (spaces or tabs).

    Returns
    -------
    dict of str to float
        The volume of each structure in mm3.

    Raises
    ------
    GroupAnalysisError
        When a line is not a name and a number.
    """
    volumes: dict[str, float] = {}
    for line in _text(payload).splitlines():
        cells = line.split()
        if not cells or cells[0].startswith("#"):
            continue
        if len(cells) != 2 or not _is_number(cells[1]):  # noqa: PLR2004
            raise GroupAnalysisError(
                "A subregion volume line is not a name and a number."
            )
        if len(volumes) >= MAX_ROWS:
            raise GroupAnalysisError("The subregion volume file has too many lines.")
        value = _number(cells[1])
        if value is not None:
            volumes.setdefault(cells[0], value)
    return volumes


def read_volumes_txt(path: str) -> dict[str, float]:
    """Parse a subregion ``*.volumes.txt`` file (``name value`` lines).

    Parameters
    ----------
    path
        The confined path, for example ``brainstemSsLabels.volumes.txt``.

    Returns
    -------
    dict of str to float
        The volume of each structure in mm3.
    """
    return parse_volumes_txt(read_bytes(path))


def synthseg_structure(name: str) -> str:
    """Normalize one SynthSeg column name to the measure grammar.

    Runs of characters outside ``[A-Za-z0-9_.&-]`` (spaces included) become
    one hyphen, and a leading ``left``/``right`` word becomes ``Left-`` or
    ``Right-``, for example ``left cerebral cortex`` ->
    ``Left-cerebral-cortex``.
    """
    words = name.strip().split(None, 1)
    if len(words) == 2 and words[0].lower() in {"left", "right"}:  # noqa: PLR2004
        head = "Left" if words[0].lower() == "left" else "Right"
        return f"{head}-{_STRUCTURE_CHARACTERS.sub('-', words[1]).strip('-')}"
    return _STRUCTURE_CHARACTERS.sub("-", name.strip()).strip("-")


def parse_synthseg_volumes(payload: bytes) -> dict[str, float]:
    """Parse the bytes of ``synthseg.vol.csv`` into structure volumes in mm3.

    The first row names the structures and the first data row holds the
    volumes; the first column (the image) and the total intracranial volume
    (the ``synthsegTIV`` measure) are left out.

    Returns
    -------
    dict of str to float
        The volume of each structure, by normalized name.

    Raises
    ------
    GroupAnalysisError
        When the file has no data row.
    """
    rows = list(csv.reader(io.StringIO(_text(payload))))
    rows = [row for row in rows if any(cell.strip() for cell in row)]
    if len(rows) < 2:  # noqa: PLR2004
        raise GroupAnalysisError("The SynthSeg volume table has no data row.")
    header, values = rows[0], rows[1]
    volumes: dict[str, float] = {}
    for name, cell in list(zip(header, values, strict=False))[1:][:MAX_ROWS]:
        if name.strip().lower() == _SYNTHSEG_TIV:
            continue
        structure = synthseg_structure(name)
        value = _number(cell.strip())
        if structure and value is not None:
            volumes.setdefault(structure, value)
    return volumes


def read_synthseg_volumes(path: str) -> dict[str, float]:
    """Parse ``synthseg.vol.csv`` into structure volumes in mm3.

    Names are normalized to the measure grammar's structure characters
    (spaces become hyphens; ``left``/``right`` become ``Left-``/``Right-``).

    Parameters
    ----------
    path
        The confined path of the CSV.

    Returns
    -------
    dict of str to float
        The volume of each structure.
    """
    return parse_synthseg_volumes(read_bytes(path))


def parse_tiv_dat(payload: bytes) -> float:
    """Parse the bytes of ``synthseg.tiv.dat`` (one number, in mm3).

    Raises
    ------
    GroupAnalysisError
        When the file does not hold exactly one finite number.
    """
    numbers = [_number(cell) for cell in _text(payload).split()]
    if len(numbers) != 1 or numbers[0] is None:
        raise GroupAnalysisError("The SynthSeg TIV file does not hold one number.")
    return numbers[0]


def read_tiv_dat(path: str) -> float:
    """Parse ``synthseg.tiv.dat`` (one number, the SynthSeg TIV in mm3).

    Parameters
    ----------
    path
        The confined path of the file.

    Returns
    -------
    float
        The total intracranial volume.
    """
    return parse_tiv_dat(read_bytes(path))
