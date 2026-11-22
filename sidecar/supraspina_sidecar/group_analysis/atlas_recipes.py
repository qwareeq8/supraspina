"""The labeling recipes of the tier B atlases (``ATLAS_RECIPES``).

Each recipe names the FreeSurfer tools it runs, the recon inputs it reads
(relative to ``derivatives/freesurfer/<id>/``), and the files it keeps in
the labeling cache ``.supraspina/analysis/atlases/<atlasId>/<subject>/``. A
recipe runs in a shadow ``SUBJECTS_DIR``
(``.supraspina/analysis/atlases/_work/<op>/<id>/``) of file-level symlinks to
its declared inputs, with every output path explicit, so no tool can write
into the recon folder; a tripwire of the recon folder's (name, size,
mtime_ns) before and after stops the labeling if anything changed there.
Bumping a recipe's ``version`` marks its labels stale (``recipe-changed``).

The subregion recipes run ``python -s -m samseg.cli.segment_subregions
<structure> --cross <id> --sd <shadow> --out-dir <tmp> --temp-dir
<tmp>/work --threads 1`` with the machine's ``subregionsPython`` on a
PYTHONPATH link folder to FreeSurfer's samseg package, since FreeSurfer
8.2.0's own fspython 3.8 cannot load samseg's CPython 3.12 bindings. The surface
recipes map an annotation with ``mri_surf2surf`` or classify with
``mris_ca_label`` and measure with ``mris_anatomical_stats -noglobal``, as
``recon-all`` 8.2 does.
"""

from __future__ import annotations

import math
import os
import re
import struct
from dataclasses import dataclass

from ..bounded_io import BoundedReadError, read_bounded_regular, read_regular_prefix
from .spec import (
    ATLAS_ID,
    PARC_METRICS,
    parse_measure_id,
    split_hemisphere_token,
)

#: The schema of a per-subject labels manifest (``labels.json``).
LABELS_SCHEMA = "supraspina/atlas-labels"
#: The labeling cache under a project root.
CACHE_DIR = (".supraspina", "analysis", "atlases")
#: The shadow working folders under the cache.
WORK_DIR = "_work"
#: The fsaverage5 template labels under the cache.
TEMPLATE_DIR = ("templates", "fsaverage5")

#: The largest text output (volumes, stats, color table) the parsers read.
MAX_TEXT_BYTES = 4 * 1024 * 1024
#: The most label rows one output file may hold.
MAX_LABEL_ROWS = 4_096
#: The fsaverage templates an annotation may live on, by vertex count.
TEMPLATE_VERTICES: dict[int, str] = {
    163_842: "fsaverage",
    40_962: "fsaverage6",
    10_242: "fsaverage5",
}
_HEMIS = ("lh", "rh")
_REGION = re.compile(r"[A-Za-z0-9_.&-]{1,64}")
_UNSAFE = re.compile(r"[^A-Za-z0-9_.&-]")
_VOLUME_LINE = re.compile(r"(\S{1,128})\s+([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)")
#: Labels that are not regions (background, the medial wall, unknown).
_NOT_REGIONS = frozenset(
    {
        "unknown",
        "???",
        "background",
        "medial_wall",
        "medialwall",
        "freesurfer_defined_medial_wall",
        "background+freesurfer_defined_medial_wall",
    }
)


@dataclass(frozen=True)
class Recipe:
    """Hold one recipe's fixed facts (``AtlasRecipe``)."""

    recipe_id: str
    version: int
    kind: str
    tools: tuple[str, ...]
    inputs: tuple[str, ...]
    outputs: tuple[str, ...]
    estimate_seconds: int


_SUBREGION_TOOLS = ("freesurfer-home", "segment-subregions", "subregions-python")
_SUBREGION_INPUTS = ("mri/norm.mgz", "mri/aseg.mgz")
_SURFACE_INPUTS = (
    "surf/{hemi}.sphere.reg",
    "surf/{hemi}.white",
    "surf/{hemi}.pial",
    "surf/{hemi}.thickness",
    "label/{hemi}.cortex.label",
)
_SURFACE_OUTPUTS = ("{hemi}.{atlas}.annot", "{hemi}.{atlas}.stats")
_MAP_TOOLS = ("freesurfer-home", "mri-surf2surf", "mris-anatomical-stats")

#: The recipes, mirrored by ``ATLAS_RECIPES`` in ``src/shared/atlas-labeling.ts``.
RECIPES: dict[str, Recipe] = {
    recipe.recipe_id: recipe
    for recipe in (
        Recipe(
            "brainstem-ss",
            1,
            "volume",
            _SUBREGION_TOOLS,
            _SUBREGION_INPUTS,
            ("brainstemSsLabels.volumes.txt", "brainstemSsLabels.FSvoxelSpace.mgz"),
            720,
        ),
        Recipe(
            "hippo-amygdala",
            1,
            "volume",
            _SUBREGION_TOOLS,
            (*_SUBREGION_INPUTS, "mri/wmparc.mgz"),
            (
                "{hemi}.hippoSfVolumes.txt",
                "{hemi}.amygNucVolumes.txt",
                "{hemi}.hippoAmygLabels.FSvoxelSpace.mgz",
            ),
            1200,
        ),
        Recipe(
            "thalamic",
            1,
            "volume",
            _SUBREGION_TOOLS,
            _SUBREGION_INPUTS,
            ("ThalamicNuclei.volumes.txt", "ThalamicNuclei.FSvoxelSpace.mgz"),
            840,
        ),
        Recipe("yeo7", 1, "surface", _MAP_TOOLS, _SURFACE_INPUTS, _SURFACE_OUTPUTS, 60),
        Recipe(
            "yeo17", 1, "surface", _MAP_TOOLS, _SURFACE_INPUTS, _SURFACE_OUTPUTS, 60
        ),
        Recipe(
            "user-gcs",
            1,
            "surface",
            ("freesurfer-home", "mris-ca-label", "mris-anatomical-stats"),
            (*_SURFACE_INPUTS, "surf/{hemi}.smoothwm", "mri/aseg.presurf.mgz"),
            _SURFACE_OUTPUTS,
            90,
        ),
        Recipe(
            "user-annot",
            1,
            "surface",
            _MAP_TOOLS,
            _SURFACE_INPUTS,
            _SURFACE_OUTPUTS,
            60,
        ),
        Recipe(
            "user-volume",
            1,
            "volume",
            ("freesurfer-home", "mri-segstats"),
            ("mri/norm.mgz",),
            ("{atlas}.stats",),
            30,
        ),
        Recipe(
            "template-fsaverage5",
            1,
            "surface",
            ("freesurfer-home", "mris-ca-label"),
            (),
            ("{hemi}.{atlas}.annot",),
            60,
        ),
    )
}

#: The ``segment_subregions`` structure of each subregion recipe.
SUBREGION_STRUCTURES: dict[str, str] = {
    "brainstem-ss": "brainstem",
    "hippo-amygdala": "hippo-amygdala",
    "thalamic": "thalamus",
}
#: The FreeSurfer-shipped annotation each Yeo recipe maps, on ``fsaverage``.
YEO_ANNOTATIONS: dict[str, str] = {
    "yeo7": "Yeo2011_7Networks_N1000",
    "yeo17": "Yeo2011_17Networks_N1000",
}
#: The DKT classifier ``recon-all`` 8.2 uses, for the DKT template labels.
DKT_GCS = "{hemi}.DKTaparc.atlas.acfb40.noaparc.i12.2016-08-02.gcs"
#: The atlases whose fsaverage5 template labels come from a FreeSurfer gcs.
TEMPLATE_GCS_ATLASES: dict[str, str] = {"dkt": DKT_GCS}


@dataclass(frozen=True)
class AtlasFacts:
    """Hold one atlas's fixed facts (``AtlasDefinition``)."""

    atlas_id: str
    label: str
    kind: str
    origin: str
    namespace: str
    source_id: str | None
    recipe_id: str | None
    hemisphere_rules: tuple[str, ...]
    metrics: tuple[str, ...]
    citation: str | None = None


_ANATOMICAL = (
    "ThickAvg",
    "ThickStd",
    "SurfArea",
    "GrayVol",
    "NumVert",
    "MeanCurv",
    "GausCurv",
    "FoldInd",
    "CurvInd",
)
_BRAINSTEM_CITATION = (
    "Iglesias JE, Van Leemput K, Bhatt P, et al. Bayesian segmentation of "
    "brainstem structures in MRI. NeuroImage. 2015;113:184-195."
)
_HIPPO_CITATION = (
    "Iglesias JE, Augustinack JC, Nguyen K, et al. A computational atlas of the "
    "hippocampal formation using ex vivo, ultra-high resolution MRI. "
    "NeuroImage. 2015;115:117-137. Saygin ZM, Kliemann D, Iglesias JE, et al. "
    "High-resolution magnetic resonance imaging reveals nuclei of the human "
    "amygdala. NeuroImage. 2017;155:370-382."
)
_THALAMIC_CITATION = (
    "Iglesias JE, Insausti R, Lerma-Usabiaga G, et al. A probabilistic atlas of "
    "the human thalamic nuclei combining ex vivo MRI and histology. "
    "NeuroImage. 2018;183:314-326."
)
_YEO_CITATION = (
    "Yeo BTT, Krienen FM, Sepulcre J, et al. The organization of the human "
    "cerebral cortex estimated by intrinsic functional connectivity. "
    "J Neurophysiol. 2011;106(3):1125-1165."
)

#: The built-in atlases, mirrored by ``BUILT_IN_ATLASES`` in the TS contract.
BUILT_IN_ATLASES: tuple[AtlasFacts, ...] = (
    AtlasFacts(
        "dk", "Desikan-Killiany", "surface", "pipeline", "dk", "dk", None,
        ("none",), _ANATOMICAL,
    ),
    AtlasFacts(
        "aseg", "Subcortical segmentation (aseg)", "volume", "pipeline", "aseg",
        "aseg", None, ("left-right-prefix",), (),
    ),
    AtlasFacts(
        "aseg-global", "Whole-brain measures", "volume", "recon-stats", "global",
        "aseg-global", None, ("none",), (),
    ),
    AtlasFacts(
        "a2009s", "Destrieux (aparc.a2009s)", "surface", "recon-stats", "parc",
        "a2009s", None, ("none",), _ANATOMICAL,
    ),
    AtlasFacts(
        "dkt", "DKT (aparc.DKTatlas)", "surface", "recon-stats", "parc", "dkt",
        None, ("none",), _ANATOMICAL,
    ),
    AtlasFacts(
        "dkpial", "Desikan-Killiany on the pial surface", "surface",
        "recon-stats", "parc", "dkpial", None, ("none",), _ANATOMICAL,
    ),
    AtlasFacts(
        "ba", "Brodmann areas (BA_exvivo)", "surface", "recon-stats", "parc",
        "ba", None, ("none",), _ANATOMICAL,
    ),
    AtlasFacts(
        "bathresh", "Brodmann areas, thresholded", "surface", "recon-stats",
        "parc", "bathresh", None, ("none",), _ANATOMICAL,
    ),
    AtlasFacts(
        "gwc", "Gray-to-white contrast (DK regions)", "surface", "recon-stats",
        "parc", "gwc", None, ("none",), ("GWC",),
    ),
    AtlasFacts(
        "wmparc", "White-matter parcellation (wmparc)", "volume", "recon-stats",
        "vol", "wmparc", None, ("lh-rh-hyphen-infix", "left-right-prefix"), (),
    ),
    AtlasFacts(
        "entowm", "Entorhinal white matter (entowm)", "volume", "recon-stats",
        "vol", "entowm", None, ("left-right-prefix",), (),
    ),
    AtlasFacts(
        "synthseg", "SynthSeg volumes", "volume", "recon-stats", "vol",
        "synthseg", None, ("left-right-prefix",), (),
    ),
    AtlasFacts(
        "brainstem-ss", "Brainstem subfields", "volume", "labeled", "vol",
        "found-subregions", "brainstem-ss", ("none",), (), _BRAINSTEM_CITATION,
    ),
    AtlasFacts(
        "hippo-amygdala", "Hippocampal subfields and amygdala nuclei", "volume",
        "labeled", "vol", "found-subregions", "hippo-amygdala", ("none",), (),
        _HIPPO_CITATION,
    ),
    AtlasFacts(
        "thalamic", "Thalamic nuclei", "volume", "labeled", "vol",
        "found-subregions", "thalamic", ("left-right-prefix",), (),
        _THALAMIC_CITATION,
    ),
    AtlasFacts(
        "yeo7", "Yeo 2011, 7 networks", "surface", "labeled", "parc", None,
        "yeo7", ("none",), _ANATOMICAL, _YEO_CITATION,
    ),
    AtlasFacts(
        "yeo17", "Yeo 2011, 17 networks", "surface", "labeled", "parc", None,
        "yeo17", ("none",), _ANATOMICAL, _YEO_CITATION,
    ),
)  # fmt: skip
ATLASES: dict[str, AtlasFacts] = {atlas.atlas_id: atlas for atlas in BUILT_IN_ATLASES}


def expand(pattern: str, atlas_id: str) -> list[str]:
    """Expand a recipe file pattern (``expandAtlasFile``).

    Parameters
    ----------
    pattern
        A pattern with ``{hemi}`` and ``{atlas}`` tokens.

    Returns
    -------
    list of str
        The file names, one per hemisphere when ``{hemi}`` occurs.
    """
    named = pattern.replace("{atlas}", atlas_id)
    if "{hemi}" not in named:
        return [named]
    return [named.replace("{hemi}", hemi) for hemi in _HEMIS]


def recipe_inputs(recipe_id: str, atlas_id: str) -> list[str]:
    """Return the recon files one subject's labeling reads, expanded."""
    return [
        name
        for pattern in RECIPES[recipe_id].inputs
        for name in expand(pattern, atlas_id)
    ]


def recipe_outputs(recipe_id: str, atlas_id: str) -> list[str]:
    """Return the files one subject's labeling keeps, expanded."""
    return [
        name
        for pattern in RECIPES[recipe_id].outputs
        for name in expand(pattern, atlas_id)
    ]


def annot_vertices(path: str) -> int:
    """Return the vertex count in a FreeSurfer ``.annot`` header.

    Raises
    ------
    ValueError
        When the file is unreadable or not an annotation.
    """
    try:
        head, _size, _truncated = read_regular_prefix(path, 4)
    except (BoundedReadError, OSError) as exc:
        raise ValueError("The annotation cannot be read.") from exc
    if len(head) != 4:  # noqa: PLR2004 - one big-endian int32.
        raise ValueError("The file is not a FreeSurfer annotation.")
    return int(struct.unpack(">i", head)[0])


def annot_template(path: str) -> str:
    """Name the fsaverage template an annotation lives on, by vertex count.

    Raises
    ------
    ValueError
        When the vertex count matches no fsaverage template.
    """
    template = TEMPLATE_VERTICES.get(annot_vertices(path))
    if template is None:
        raise ValueError(
            "The annotation is not on fsaverage, fsaverage6, or fsaverage5."
        )
    return template


def _file_for(atlas_files: tuple[str, ...], hemi: str, suffix: str) -> str:
    for path in atlas_files:
        name = os.path.basename(path)
        if name.startswith(f"{hemi}.") and name.endswith(suffix):
            return path
    raise ValueError(f"The atlas has no {hemi} {suffix} file.")


@dataclass(frozen=True)
class _Step:
    """Hold the facts every step builder reads."""

    recipe_id: str
    atlas_id: str
    subject_id: str
    shadow: str
    out_dir: str
    home: str
    python: str | None
    files: tuple[str, ...]

    def out(self, name: str) -> str:
        return os.path.join(self.out_dir, name)

    def subject(self, *parts: str) -> str:
        return os.path.join(self.shadow, self.subject_id, *parts)


def _surface_stats(step: _Step, hemi: str) -> list[str]:
    return [
        "mris_anatomical_stats",
        "-noglobal",
        "-no-th3",
        "-mgz",
        "-cortex",
        step.subject("label", f"{hemi}.cortex.label"),
        "-f",
        step.out(f"{hemi}.{step.atlas_id}.stats"),
        "-b",
        "-a",
        step.out(f"{hemi}.{step.atlas_id}.annot"),
        step.subject_id,
        hemi,
        "white",
    ]


def _subregion_steps(step: _Step) -> list[list[str]]:
    if not step.python:
        raise ValueError("Choose a Python 3.12 environment for subregions.")
    return [
        [
            step.python,
            "-s",
            "-m",
            "samseg.cli.segment_subregions",
            SUBREGION_STRUCTURES[step.recipe_id],
            "--cross",
            step.subject_id,
            "--sd",
            step.shadow,
            "--out-dir",
            step.out_dir,
            "--temp-dir",
            step.out("work"),
            "--threads",
            "1",
        ]
    ]


def _map_steps(step: _Step) -> list[list[str]]:
    steps: list[list[str]] = []
    for hemi in _HEMIS:
        if step.recipe_id == "user-annot":
            source = _file_for(step.files, hemi, ".annot")
            template = annot_template(source)
        else:
            template = "fsaverage"
            name = f"{hemi}.{YEO_ANNOTATIONS[step.recipe_id]}.annot"
            source = os.path.join(step.home, "subjects", "fsaverage", "label", name)
        steps.append(
            [
                "mri_surf2surf",
                "--srcsubject",
                template,
                "--trgsubject",
                step.subject_id,
                "--hemi",
                hemi,
                "--sval-annot",
                source,
                "--tval",
                step.out(f"{hemi}.{step.atlas_id}.annot"),
                "--sd",
                step.shadow,
            ]
        )
        steps.append(_surface_stats(step, hemi))
    return steps


def _gcs_steps(step: _Step) -> list[list[str]]:
    steps: list[list[str]] = []
    for hemi in _HEMIS:
        steps.append(
            [
                "mris_ca_label",
                "-l",
                step.subject("label", f"{hemi}.cortex.label"),
                "-aseg",
                step.subject("mri", "aseg.presurf.mgz"),
                "-seed",
                "1234",
                "-sdir",
                step.shadow,
                step.subject_id,
                hemi,
                step.subject("surf", f"{hemi}.sphere.reg"),
                _file_for(step.files, hemi, ".gcs"),
                step.out(f"{hemi}.{step.atlas_id}.annot"),
            ]
        )
        steps.append(_surface_stats(step, hemi))
    return steps


def _template_steps(step: _Step) -> list[list[str]]:
    steps: list[list[str]] = []
    if step.atlas_id not in TEMPLATE_GCS_ATLASES and any(
        path.endswith(".annot") for path in step.files
    ):
        # An annotation atlas maps from its own template to fsaverage5.
        for hemi in _HEMIS:
            source = _file_for(step.files, hemi, ".annot")
            steps.append(
                [
                    "mri_surf2surf",
                    "--srcsubject",
                    annot_template(source),
                    "--trgsubject",
                    "fsaverage5",
                    "--hemi",
                    hemi,
                    "--sval-annot",
                    source,
                    "--tval",
                    step.out(f"{hemi}.{step.atlas_id}.annot"),
                    "--sd",
                    step.shadow,
                ]
            )
        return steps
    for hemi in _HEMIS:
        if step.atlas_id in TEMPLATE_GCS_ATLASES:
            name = TEMPLATE_GCS_ATLASES[step.atlas_id].replace("{hemi}", hemi)
            gcs = os.path.join(step.home, "average", name)
        else:
            gcs = _file_for(step.files, hemi, ".gcs")
        steps.append(
            [
                "mris_ca_label",
                "-seed",
                "1234",
                "-sdir",
                step.shadow,
                "fsaverage5",
                hemi,
                "sphere.reg",
                gcs,
                step.out(f"{hemi}.{step.atlas_id}.annot"),
            ]
        )
    return steps


def _segstats_steps(step: _Step) -> list[list[str]]:
    if len(step.files) != 2:  # noqa: PLR2004 - color table and label map.
        raise ValueError("The atlas needs a color table and a label map.")
    ctab, label_map = step.files
    return [
        [
            "mri_segstats",
            "--seg",
            label_map,
            "--ctab",
            ctab,
            "--i",
            step.subject("mri", "norm.mgz"),
            "--excludeid",
            "0",
            "--sum",
            step.out(f"{step.atlas_id}.stats"),
        ]
    ]


def recipe_command(  # noqa: PLR0913 - keyword-only facts of one step.
    recipe_id: str,
    *,
    atlas_id: str,
    subject_id: str,
    shadow_subjects_dir: str,
    out_dir: str,
    freesurfer_home: str,
    subregions_python: str | None,
    atlas_files: tuple[str, ...] = (),
) -> list[list[str]]:
    """Return the argv of every step of one subject's labeling.

    Tool names are bare; the worker resolves them under
    ``<freesurfer_home>/bin`` and runs every step with ``SUBJECTS_DIR`` set
    to the shadow folder.

    Parameters
    ----------
    recipe_id
        One of :data:`RECIPES`.
    subject_id
        The subject, as its shadow folder name (``fsaverage5`` for the
        template recipe).
    shadow_subjects_dir
        The shadow ``SUBJECTS_DIR`` of file-level symlinks.
    out_dir
        The temporary output folder (never the recon folder).
    subregions_python
        The machine's subregions interpreter, for the subregion recipes.
    atlas_files
        The atlas's files: ``lh``/``rh`` gcs or annot files of an added
        surface atlas, or a color table and the subject's label map for an
        added volume atlas.

    Returns
    -------
    list of list of str
        One argv per step, run in order.

    Raises
    ------
    ValueError
        When the recipe is unknown or a required file or tool is missing.
    """
    step = _Step(
        recipe_id=recipe_id,
        atlas_id=atlas_id,
        subject_id=subject_id,
        shadow=shadow_subjects_dir,
        out_dir=out_dir,
        home=freesurfer_home,
        python=subregions_python,
        files=atlas_files,
    )
    if recipe_id in SUBREGION_STRUCTURES:
        return _subregion_steps(step)
    if recipe_id in YEO_ANNOTATIONS or recipe_id == "user-annot":
        return _map_steps(step)
    if recipe_id == "user-gcs":
        return _gcs_steps(step)
    if recipe_id == "template-fsaverage5":
        return _template_steps(step)
    if recipe_id == "user-volume":
        return _segstats_steps(step)
    raise ValueError("Use a known labeling recipe.")


# -- Parsing -----------------------------------------------------------------------


def region_name(name: str) -> str | None:
    """Return a label name in the measure grammar's region characters.

    Characters outside ``[A-Za-z0-9_.&-]`` become ``_`` and the name is cut
    to 64 characters; background, unknown, and medial-wall labels read as
    None.
    """
    if name.strip().lower() in _NOT_REGIONS:
        return None
    cleaned = _UNSAFE.sub("_", name.strip())[:64]
    return cleaned if _REGION.fullmatch(cleaned) else None


def _read_text(path: str) -> str:
    try:
        payload = read_bounded_regular(path, MAX_TEXT_BYTES)
    except (BoundedReadError, OSError) as exc:
        raise ValueError("A labeling output cannot be read.") from exc
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("A labeling output is not text.") from exc


def _finite(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("A labeling output holds a value that is not finite.")
    return value


def read_volumes_txt(path: str) -> dict[str, float]:
    """Parse a subregion ``*.volumes.txt`` file (``name value`` lines, mm3).

    Raises
    ------
    ValueError
        When the file is unreadable, malformed, or empty.
    """
    volumes: dict[str, float] = {}
    for raw in _read_text(path).splitlines():
        line = raw.strip()
        if not line:
            continue
        match = _VOLUME_LINE.fullmatch(line)
        if match is None or len(volumes) >= MAX_LABEL_ROWS:
            raise ValueError("A subregion volume file is malformed.")
        volumes.setdefault(match.group(1), _finite(match.group(2)))
    if not volumes:
        raise ValueError("A subregion volume file is empty.")
    return volumes


def read_stats_table(path: str) -> dict[str, dict[str, float]]:
    """Parse the table of a FreeSurfer ``.stats`` file by ``StructName``.

    Raises
    ------
    ValueError
        When the file is unreadable or its table is malformed.
    """
    columns: list[str] | None = None
    rows: dict[str, dict[str, float]] = {}
    for raw in _read_text(path).splitlines():
        line = raw.strip()
        if line.startswith("# ColHeaders"):
            columns = line.split()[2:]
            continue
        if not line or line.startswith("#"):
            continue
        if columns is None or "StructName" not in columns:
            raise ValueError("A stats file has no column headers.")
        cells = line.split()
        if len(cells) != len(columns) or len(rows) >= MAX_LABEL_ROWS:
            raise ValueError("A stats file row is malformed.")
        named = dict(zip(columns, cells, strict=True))
        values: dict[str, float] = {}
        for column, cell in named.items():
            if column == "StructName":
                continue
            try:
                values[column] = _finite(cell)
            except ValueError:
                continue
        rows.setdefault(named["StructName"], values)
    if columns is None:
        raise ValueError("A stats file has no column headers.")
    return rows


def read_color_table(path: str) -> dict[int, str]:
    """Parse a FreeSurfer color table (``index name r g b a`` lines).

    Raises
    ------
    ValueError
        When the table is unreadable, malformed, or empty.
    """
    table: dict[int, str] = {}
    for raw in _read_text(path).splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        cells = line.split()
        if len(cells) < 2 or not cells[0].isdigit() or len(table) >= MAX_LABEL_ROWS:  # noqa: PLR2004
            raise ValueError("The color table is malformed.")
        table.setdefault(int(cells[0]), cells[1])
    if not table:
        raise ValueError("The color table is empty.")
    return table


def _split(
    name: str, rules: tuple[str, ...], hemi: str | None
) -> tuple[str | None, str | None]:
    """Return the hemisphere and region of one label name."""
    for rule in rules:
        side, structure = split_hemisphere_token(rule, name)
        if side is not None and (hemi is None or side == hemi):
            return side, region_name(structure)
    return hemi, region_name(name)


def _volume_id(atlas_id: str, hemi: str | None, structure: str | None) -> str | None:
    if structure is None:
        return None
    measure = f"vol:{atlas_id}:{hemi or 'mid'}:{structure}"
    return measure if parse_measure_id(measure) is not None else None


def _parc_ids(
    atlas_id: str, hemi: str, region: str | None, row: dict[str, float]
) -> dict[str, float]:
    if region is None:
        return {}
    values: dict[str, float] = {}
    for metric in PARC_METRICS:
        if metric in row:
            measure = f"parc:{atlas_id}:{hemi}:{region}:{metric}"
            if parse_measure_id(measure) is not None:
                values[measure] = row[metric]
    return values


def _subregion_values(
    recipe_id: str, atlas_id: str, folder: str, rules: tuple[str, ...]
) -> dict[str, float]:
    values: dict[str, float] = {}
    for name in recipe_outputs(recipe_id, atlas_id):
        if not name.endswith(".txt"):
            continue
        hemi = name[:2] if name[:3] in {"lh.", "rh."} else None
        for label, volume in read_volumes_txt(os.path.join(folder, name)).items():
            side, structure = _split(label, rules, hemi)
            measure = _volume_id(atlas_id, side, structure)
            if measure is not None:
                values.setdefault(measure, volume)
    return values


def _segstats_values(
    atlas_id: str, folder: str, rules: tuple[str, ...]
) -> dict[str, float]:
    values: dict[str, float] = {}
    rows = read_stats_table(os.path.join(folder, f"{atlas_id}.stats"))
    for label, row in rows.items():
        volume = row.get("Volume_mm3")
        side, structure = _split(label, rules, None)
        measure = _volume_id(atlas_id, side, structure)
        if measure is not None and volume is not None:
            values.setdefault(measure, volume)
    return values


def _surface_values(
    atlas_id: str, folder: str, rules: tuple[str, ...]
) -> dict[str, float]:
    values: dict[str, float] = {}
    for hemi in _HEMIS:
        rows = read_stats_table(os.path.join(folder, f"{hemi}.{atlas_id}.stats"))
        for label, row in rows.items():
            _side, region = _split(label, rules, hemi)
            for measure, value in _parc_ids(atlas_id, hemi, region, row).items():
                values.setdefault(measure, value)
    return values


def parse_outputs(
    recipe_id: str, atlas_id: str, folder: str, rules: tuple[str, ...]
) -> dict[str, float]:
    """Read one subject's kept outputs into measure values.

    Subregion volumes become ``vol:<atlas>:<lh|rh|mid>:<structure>``;
    surface stats become ``parc:<atlas>:<lh|rh>:<region>:<metric>``; a
    volume atlas's ``mri_segstats`` table becomes ``vol:`` measures by the
    atlas's hemisphere-token rules.

    Parameters
    ----------
    rules
        The atlas's hemisphere-token rules, tried in order.

    Raises
    ------
    ValueError
        When an output is missing or malformed, or no value was read.
    """
    if not ATLAS_ID.fullmatch(atlas_id):
        raise ValueError("Use a valid atlas ID.")
    if recipe_id in SUBREGION_STRUCTURES:
        values = _subregion_values(recipe_id, atlas_id, folder, rules)
    elif recipe_id == "user-volume":
        values = _segstats_values(atlas_id, folder, rules)
    elif recipe_id == "template-fsaverage5":
        return {}
    elif recipe_id in RECIPES and RECIPES[recipe_id].kind == "surface":
        values = _surface_values(atlas_id, folder, rules)
    else:
        raise ValueError("Use a known labeling recipe.")
    if not values:
        raise ValueError("The labeling outputs hold no usable values.")
    return values
