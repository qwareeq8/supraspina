/**
 * The atlas contract of the Analysis panel (v2): the atlas catalog (tier A
 * per-subject FreeSurfer stats, tier B atlases labeled on demand), the
 * labeling recipes, per-subject label states, the labeling operation, the
 * tool facts, the external atlas sources and their machine-level download
 * cache, and the bounded parsers of every result.
 *
 * `sidecar/supraspina_sidecar/group_analysis/atlas_recipes.py`,
 * `atlas_manager.py`, and `atlas_sources.py` mirror these shapes. Nothing
 * here is bundled: FreeSurfer ships the templates and tools, and external
 * atlases are downloaded from or imported after their official sites.
 */

import { z } from 'zod'
import {
  ANALYSIS_INPUT_SOURCE_V2,
  ATLAS_ID,
  HEMISPHERE_TOKEN_RULES,
  PARC_METRICS,
  type AnalysisStageCurrency,
  type HemisphereTokenRule,
  type ParcMetric,
} from './group-analysis'

// -- Identity ------------------------------------------------------------

/** The sidecar handshake capability that serves the labeling methods. */
export const ATLAS_LABELING_CAPABILITY = 'atlas-labeling-v1'
/** The operation IDs of a labeling operation. */
export const ATLAS_LABEL_OPERATION_ID = /^alb-[a-f0-9]{16}$/
/** The operation IDs of an atlas download. */
export const ATLAS_DOWNLOAD_OPERATION_ID = /^adl-[a-f0-9]{16}$/
/** The IDs of atlases the operator added (imported files). */
export const ADDED_ATLAS_ID = /^user-[a-f0-9]{8}$/
/** The schema of a per-subject labels manifest (`labels.json`). */
export const ATLAS_LABELS_SCHEMA = 'supraspina/atlas-labels'
/** The schema of a machine-level atlas cache manifest (`manifest.json`). */
export const ATLAS_CACHE_SCHEMA = 'supraspina/atlas-source-cache'
/** The most subjects one labeling request names. */
export const MAX_LABEL_SUBJECTS = 5_000
/** The parallel labeling jobs one operation may run. */
export const MAX_LABEL_JOBS = 8

const SHA256 = /^[a-f0-9]{64}$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/
const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PRINTABLE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/
/** A cache-relative file path: `[A-Za-z0-9._-]` segments, never `..`. */
const RELPATH =
  /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]{1,128}(?:\/[A-Za-z0-9._-]{1,128}){0,4}$/
/** An https URL without credentials, spaces, or fragments. */
const HTTPS_URL =
  /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?(?:\?[A-Za-z0-9._~%!$&'()*+,;=:@/?-]*)?$/
const MAX_MESSAGE = 512
const MAX_ATLASES = 64

// -- Tier A sources and tier B recipes --------------------------------------------

/**
 * The tier A sources: read-only per-subject files (`fsstats.py`). `dk` and
 * `aseg` are the v1 pipeline tables; the rest read each subject's
 * `derivatives/freesurfer/<id>/stats/` (and `found-subregions` any
 * subregion volumes a recon already has).
 */
export const TIER_A_SOURCE_IDS = [
  'dk',
  'aseg',
  'a2009s',
  'dkt',
  'dkpial',
  'ba',
  'bathresh',
  'gwc',
  'wmparc',
  'entowm',
  'synthseg',
  'aseg-global',
  'found-subregions',
] as const
/** One tier A source. */
export type TierASourceId = (typeof TIER_A_SOURCE_IDS)[number]

/** The labeling recipes (`atlas_recipes.py`), each with its own version. */
export const ATLAS_RECIPE_IDS = [
  'brainstem-ss',
  'hippo-amygdala',
  'thalamic',
  'yeo7',
  'yeo17',
  'user-gcs',
  'user-annot',
  'user-volume',
  'template-fsaverage5',
] as const
/** One labeling recipe. */
export type AtlasRecipeId = (typeof ATLAS_RECIPE_IDS)[number]

/**
 * The recipes whose outputs Import outputs takes (`IMPORTABLE_RECIPES` in
 * `atlas_manager.py`): the subregion atlases and added label-map atlases.
 */
export const IMPORTABLE_RECIPES: ReadonlySet<AtlasRecipeId> = new Set([
  'brainstem-ss',
  'hippo-amygdala',
  'thalamic',
  'user-volume',
])

/** The FreeSurfer (and interpreter) tools the labeling uses. */
export const ATLAS_TOOL_IDS = [
  'freesurfer-home',
  'segment-subregions',
  'subregions-python',
  'mri-surf2surf',
  'mris-ca-label',
  'mris-anatomical-stats',
  'mri-segstats',
] as const
/** One labeling tool. */
export type AtlasToolId = (typeof ATLAS_TOOL_IDS)[number]

/** A surface atlas (per-vertex labels) or a volume atlas (label maps). */
export type AtlasKind = 'surface' | 'volume'
/** Where an atlas's values come from. */
export type AtlasOrigin = 'pipeline' | 'recon-stats' | 'labeled' | 'added'
/** The measure namespace an atlas's measures use. */
export type AtlasNamespace = 'dk' | 'aseg' | 'global' | 'parc' | 'vol'

/** One labeling recipe's fixed facts. */
export interface AtlasRecipe {
  recipeId: AtlasRecipeId
  /** Bumped when the recipe's argv or parsing changes (stale `recipe-changed`). */
  version: number
  kind: AtlasKind
  tools: AtlasToolId[]
  /** The recon files it reads, relative to `derivatives/freesurfer/<id>/`. */
  inputs: string[]
  /** The files it keeps in the labeling cache folder of one subject. */
  outputs: string[]
  /** The measured duration per subject, in seconds (for estimates). */
  estimateSeconds: number
}

/** The recon files every surface recipe reads (`mris_anatomical_stats`). */
const SURFACE_INPUTS = [
  'surf/{hemi}.sphere.reg',
  'surf/{hemi}.white',
  'surf/{hemi}.pial',
  'surf/{hemi}.thickness',
  'label/{hemi}.cortex.label',
]

/**
 * The recipes. Outputs are cache file names under
 * `.supraspina/analysis/atlases/<atlasId>/<subject>/`; `{hemi}` expands to `lh`
 * and `rh`, and `{atlas}` to the atlas ID. Estimates are the measured
 * durations (brainstem 5 to 12 min, thalamic about 14 min).
 */
export const ATLAS_RECIPES: readonly AtlasRecipe[] = [
  {
    recipeId: 'brainstem-ss',
    version: 1,
    kind: 'volume',
    tools: ['freesurfer-home', 'segment-subregions', 'subregions-python'],
    inputs: ['mri/norm.mgz', 'mri/aseg.mgz'],
    outputs: [
      'brainstemSsLabels.volumes.txt',
      'brainstemSsLabels.FSvoxelSpace.mgz',
    ],
    estimateSeconds: 720,
  },
  {
    recipeId: 'hippo-amygdala',
    version: 1,
    kind: 'volume',
    tools: ['freesurfer-home', 'segment-subregions', 'subregions-python'],
    inputs: ['mri/norm.mgz', 'mri/aseg.mgz', 'mri/wmparc.mgz'],
    outputs: [
      '{hemi}.hippoSfVolumes.txt',
      '{hemi}.amygNucVolumes.txt',
      '{hemi}.hippoAmygLabels.FSvoxelSpace.mgz',
    ],
    estimateSeconds: 1200,
  },
  {
    recipeId: 'thalamic',
    version: 1,
    kind: 'volume',
    tools: ['freesurfer-home', 'segment-subregions', 'subregions-python'],
    inputs: ['mri/norm.mgz', 'mri/aseg.mgz'],
    outputs: ['ThalamicNuclei.volumes.txt', 'ThalamicNuclei.FSvoxelSpace.mgz'],
    estimateSeconds: 840,
  },
  {
    recipeId: 'yeo7',
    version: 1,
    kind: 'surface',
    tools: ['freesurfer-home', 'mri-surf2surf', 'mris-anatomical-stats'],
    inputs: SURFACE_INPUTS,
    outputs: ['{hemi}.{atlas}.annot', '{hemi}.{atlas}.stats'],
    estimateSeconds: 60,
  },
  {
    recipeId: 'yeo17',
    version: 1,
    kind: 'surface',
    tools: ['freesurfer-home', 'mri-surf2surf', 'mris-anatomical-stats'],
    inputs: SURFACE_INPUTS,
    outputs: ['{hemi}.{atlas}.annot', '{hemi}.{atlas}.stats'],
    estimateSeconds: 60,
  },
  {
    recipeId: 'user-gcs',
    version: 1,
    kind: 'surface',
    tools: ['freesurfer-home', 'mris-ca-label', 'mris-anatomical-stats'],
    inputs: [...SURFACE_INPUTS, 'surf/{hemi}.smoothwm', 'mri/aseg.presurf.mgz'],
    outputs: ['{hemi}.{atlas}.annot', '{hemi}.{atlas}.stats'],
    estimateSeconds: 90,
  },
  {
    recipeId: 'user-annot',
    version: 1,
    kind: 'surface',
    tools: ['freesurfer-home', 'mri-surf2surf', 'mris-anatomical-stats'],
    inputs: SURFACE_INPUTS,
    outputs: ['{hemi}.{atlas}.annot', '{hemi}.{atlas}.stats'],
    estimateSeconds: 60,
  },
  {
    recipeId: 'user-volume',
    version: 1,
    kind: 'volume',
    tools: ['freesurfer-home', 'mri-segstats'],
    inputs: ['mri/norm.mgz'],
    outputs: ['{atlas}.stats'],
    estimateSeconds: 30,
  },
  {
    recipeId: 'template-fsaverage5',
    version: 1,
    kind: 'surface',
    tools: ['freesurfer-home', 'mris-ca-label'],
    inputs: [],
    outputs: ['{hemi}.{atlas}.annot'],
    estimateSeconds: 60,
  },
]

/** One atlas the panel knows (built in, or added by the operator). */
export interface AtlasDefinition {
  atlasId: string
  label: string
  kind: AtlasKind
  origin: AtlasOrigin
  namespace: AtlasNamespace
  /** The tier A source that reads it, or null for a labeled atlas. */
  sourceId: TierASourceId | null
  /** The recipe that labels it, or null for a tier A atlas. */
  recipeId: AtlasRecipeId | null
  /** The external atlas source (download or import), or null. */
  externalSourceId: string | null
  /** The hemisphere-token rules tried in order to pair label names. */
  hemisphereRules: HemisphereTokenRule[]
  /** The parcellation metrics of a `parc` atlas; empty otherwise. */
  metrics: ParcMetric[]
}

const ANATOMICAL: ParcMetric[] = [
  'ThickAvg',
  'ThickStd',
  'SurfArea',
  'GrayVol',
  'NumVert',
  'MeanCurv',
  'GausCurv',
  'FoldInd',
  'CurvInd',
]

/**
 * The built-in atlases. `dk`, `aseg`, and `aseg-global` keep their v1
 * namespaces; the Yeo annotations ship with FreeSurfer (fsaverage5
 * `label/`). The brainstem, hippocampus-amygdala, and thalamic atlases are
 * read from a recon when present (`found-subregions`) and otherwise labeled.
 */
export const BUILT_IN_ATLASES: readonly AtlasDefinition[] = [
  atlas(
    'dk',
    'Desikan-Killiany',
    'surface',
    'pipeline',
    'dk',
    'dk',
    null,
    ['none'],
    ANATOMICAL,
  ),
  atlas(
    'aseg',
    'Subcortical segmentation (aseg)',
    'volume',
    'pipeline',
    'aseg',
    'aseg',
    null,
    ['left-right-prefix'],
    [],
  ),
  atlas(
    'aseg-global',
    'Whole-brain measures',
    'volume',
    'recon-stats',
    'global',
    'aseg-global',
    null,
    ['none'],
    [],
  ),
  atlas(
    'a2009s',
    'Destrieux (aparc.a2009s)',
    'surface',
    'recon-stats',
    'parc',
    'a2009s',
    null,
    ['none'],
    ANATOMICAL,
  ),
  atlas(
    'dkt',
    'DKT (aparc.DKTatlas)',
    'surface',
    'recon-stats',
    'parc',
    'dkt',
    null,
    ['none'],
    ANATOMICAL,
  ),
  atlas(
    'dkpial',
    'Desikan-Killiany on the pial surface',
    'surface',
    'recon-stats',
    'parc',
    'dkpial',
    null,
    ['none'],
    ANATOMICAL,
  ),
  atlas(
    'ba',
    'Brodmann areas (BA_exvivo)',
    'surface',
    'recon-stats',
    'parc',
    'ba',
    null,
    ['none'],
    ANATOMICAL,
  ),
  atlas(
    'bathresh',
    'Brodmann areas, thresholded',
    'surface',
    'recon-stats',
    'parc',
    'bathresh',
    null,
    ['none'],
    ANATOMICAL,
  ),
  atlas(
    'gwc',
    'Gray-to-white contrast (DK regions)',
    'surface',
    'recon-stats',
    'parc',
    'gwc',
    null,
    ['none'],
    ['GWC'],
  ),
  atlas(
    'wmparc',
    'White-matter parcellation (wmparc)',
    'volume',
    'recon-stats',
    'vol',
    'wmparc',
    null,
    ['lh-rh-hyphen-infix', 'left-right-prefix'],
    [],
  ),
  atlas(
    'entowm',
    'Entorhinal white matter (entowm)',
    'volume',
    'recon-stats',
    'vol',
    'entowm',
    null,
    ['left-right-prefix'],
    [],
  ),
  atlas(
    'synthseg',
    'SynthSeg volumes',
    'volume',
    'recon-stats',
    'vol',
    'synthseg',
    null,
    ['left-right-prefix'],
    [],
  ),
  atlas(
    'brainstem-ss',
    'Brainstem subfields',
    'volume',
    'labeled',
    'vol',
    'found-subregions',
    'brainstem-ss',
    ['none'],
    [],
  ),
  atlas(
    'hippo-amygdala',
    'Hippocampal subfields and amygdala nuclei',
    'volume',
    'labeled',
    'vol',
    'found-subregions',
    'hippo-amygdala',
    ['none'],
    [],
  ),
  atlas(
    'thalamic',
    'Thalamic nuclei',
    'volume',
    'labeled',
    'vol',
    'found-subregions',
    'thalamic',
    ['left-right-prefix'],
    [],
  ),
  atlas(
    'yeo7',
    'Yeo 2011, 7 networks',
    'surface',
    'labeled',
    'parc',
    null,
    'yeo7',
    ['none'],
    ANATOMICAL,
  ),
  atlas(
    'yeo17',
    'Yeo 2011, 17 networks',
    'surface',
    'labeled',
    'parc',
    null,
    'yeo17',
    ['none'],
    ANATOMICAL,
  ),
]

function atlas(
  atlasId: string,
  label: string,
  kind: AtlasKind,
  origin: AtlasOrigin,
  namespace: AtlasNamespace,
  sourceId: TierASourceId | null,
  recipeId: AtlasRecipeId | null,
  hemisphereRules: HemisphereTokenRule[],
  metrics: ParcMetric[],
): AtlasDefinition {
  return {
    atlasId,
    label,
    kind,
    origin,
    namespace,
    sourceId,
    recipeId,
    externalSourceId: null,
    hemisphereRules,
    metrics,
  }
}

/**
 * The files the brain viewer may read from the labeling cache, per recipe:
 * one subject's label map (`subject`) and the fsaverage5 template labels
 * (`template`). `{hemi}` and `{atlas}` expand as in `ATLAS_RECIPES`.
 */
export const ATLAS_CACHE_VIEWER_FILES: Readonly<
  Record<AtlasRecipeId, { subject: string[]; template: string[] }>
> = {
  'brainstem-ss': {
    subject: ['brainstemSsLabels.FSvoxelSpace.mgz'],
    template: [],
  },
  'hippo-amygdala': {
    subject: ['{hemi}.hippoAmygLabels.FSvoxelSpace.mgz'],
    template: [],
  },
  thalamic: { subject: ['ThalamicNuclei.FSvoxelSpace.mgz'], template: [] },
  yeo7: { subject: [], template: [] },
  yeo17: { subject: [], template: [] },
  'user-gcs': { subject: [], template: ['{hemi}.{atlas}.annot'] },
  'user-annot': { subject: [], template: ['{hemi}.{atlas}.annot'] },
  // The atlas's color table names the map's labels (FreeSurfer's does not).
  'user-volume': { subject: ['{atlas}.mgz', '{atlas}.ctab'], template: [] },
  'template-fsaverage5': { subject: [], template: ['{hemi}.{atlas}.annot'] },
}

/**
 * Expand a recipe file pattern for one atlas.
 *
 * @param pattern - A pattern with `{hemi}` and `{atlas}` tokens.
 * @returns The file names, one per hemisphere when `{hemi}` occurs.
 */
export function expandAtlasFile(pattern: string, atlasId: string): string[] {
  const named = pattern.replaceAll('{atlas}', atlasId)
  return named.includes('{hemi}')
    ? ['lh', 'rh'].map((hemi) => named.replaceAll('{hemi}', hemi))
    : [named]
}

// -- Per-subject label states and the labeling operation ----------------------

/**
 * One subject's label state for one atlas:
 *
 * - `missing`: no labels yet; `queued` and `running` during an operation.
 * - `current`: labels match the recon, tool, and recipe.
 * - `stale`: something changed since (see `staleReasons`).
 * - `provisional`: labeled while the recon was out of date.
 * - `failed`: the last labeling failed (see `message`).
 * - `skipped`: the recon is out of date or running, so it was not labeled.
 */
export type SubjectLabelState =
  | 'missing'
  | 'queued'
  | 'running'
  | 'current'
  | 'stale'
  | 'provisional'
  | 'failed'
  | 'skipped'

/** Why labels are stale. */
export type LabelStaleReason =
  | 'recon-changed'
  | 'tool-changed'
  | 'recipe-changed'

/** One subject's labels of one atlas. */
export interface SubjectLabelStatus {
  subjectId: string
  state: SubjectLabelState
  staleReasons: LabelStaleReason[]
  /** How the labels arrived: labeled here, or imported with provenance. */
  provenance: 'labeled' | 'imported' | null
  updatedAt: string | null
  /** The duration of the last labeling, in seconds. */
  seconds: number | null
  message: string | null
}

/** The running or last labeling operation (one at a time per sidecar). */
export interface AtlasLabelOperation {
  operationId: string
  atlasId: string
  state: 'running' | 'done' | 'cancelled' | 'failed'
  completed: number
  failed: number
  skipped: number
  total: number
  /** The subject being labeled now. */
  current: { subjectId: string; startedAt: string } | null
  startedAt: string
  finishedAt: string | null
  /** The estimated seconds left, from measured durations. */
  remainingSeconds: number | null
  message: string | null
}

/** The per-subject label counts of one atlas. */
export interface AtlasSubjectCounts {
  /** Subjects in the analysis scope. */
  total: number
  /** Tier A: subjects whose stats file is present (lstat only). */
  withFiles: number
  /** Tier B: subjects with current or provisional labels. */
  labeled: number
  stale: number
  failed: number
  /** Subjects whose recon is out of date. */
  reconOutdated: number
}

/** The license an operator confirmed for an added or downloaded atlas. */
export interface AtlasLicenseNote {
  name: string
  url: string | null
  acknowledgedAt: string | null
}

/** One atlas's state in a project (`groupAnalysis.atlases`). */
export interface AtlasEntry {
  atlasId: string
  label: string
  tier: 'A' | 'B'
  kind: AtlasKind
  origin: AtlasOrigin
  namespace: AtlasNamespace
  recipeId: AtlasRecipeId | null
  externalSourceId: string | null
  available: boolean
  /** Why it cannot be used now, as a fact. */
  unavailableReason: string | null
  counts: AtlasSubjectCounts
  /** The estimated seconds to label every subject still missing. */
  estimateSeconds: number | null
  license: AtlasLicenseNote | null
  citation: string | null
}

/** A tool's state, probed on its own thread with a 5 s timeout. */
export type AtlasToolState = 'ok' | 'missing' | 'broken' | 'unknown'

/** The action that fixes a tool fact, when there is one. */
export type AtlasToolFix =
  | 'choose-subregions-python'
  | 'set-freesurfer-home'
  | 'import-outputs'
  | null

/**
 * One tool fact, as a sentence of fact, for example "FreeSurfer 8.2.0
 * segment_subregions cannot start: fspython 3.8 cannot load samseg."
 */
export interface AtlasToolFact {
  toolId: AtlasToolId
  state: AtlasToolState
  detail: string
  fix: AtlasToolFix
}

/** The result of `groupAnalysis.atlases`. */
export interface AtlasCatalog {
  configRevision: number
  /** The labeling cache revision that `clearLabels` names. */
  revision: number
  atlases: AtlasEntry[]
  tools: AtlasToolFact[]
  /** The machine preference, echoed so the panel can show it. */
  subregionsPython: string | null
  labeling: AtlasLabelOperation | null
}

/** Which subjects a labeling request covers. */
export type AtlasLabelSubjects = 'missing' | 'stale' | string[]

/** The request of `groupAnalysis.labelStart`. */
export interface AtlasLabelStartRequest {
  atlasId: string
  subjects: AtlasLabelSubjects
  /** Parallel subjects, 1 to 8. */
  jobs: number
  /** The recon currency the renderer shows, recorded per subject. */
  stageCurrency: AnalysisStageCurrency
}

/** The result of `groupAnalysis.labelStart`. */
export interface AtlasLabelStartResult {
  operation: AtlasLabelOperation
  /** False when an operation for this project was already running. */
  started: boolean
}

/** The result of `groupAnalysis.labelStatus`. */
export interface AtlasLabelStatus {
  operation: AtlasLabelOperation | null
  /** The atlas the subject rows describe (the request's, else the operation's). */
  atlasId: string | null
  subjects: SubjectLabelStatus[]
}

/** The result of `groupAnalysis.labelCancel`. */
export interface AtlasLabelCancelResult {
  operationId: string
  stopped: boolean
}

/** Which subjects' labels `groupAnalysis.clearLabels` removes. */
export type AtlasClearSubjects = 'all' | string[]

/** The request of `groupAnalysis.clearLabels`. */
export interface AtlasClearLabelsRequest {
  atlasId: string
  subjects: AtlasClearSubjects
  expectedRevision: number
}

/** The result of `groupAnalysis.clearLabels`. */
export interface AtlasLabelsCleared {
  revision: number
  cleared: number
}

/** The result of the main-internal `groupAnalysis.importAtlas`. */
export interface AtlasImportResult {
  atlas: AtlasEntry
}

/** The result of the main-internal `groupAnalysis.importAtlasLabels`. */
export interface AtlasLabelsImportResult {
  atlasId: string
  imported: number
  /** Subjects whose folder held no recognized files. */
  unrecognized: string[]
}

// -- External atlas sources (download or import) ---------------------------------

/** One file a source serves, with the pinned digest and size. */
export interface AtlasSourceFile {
  url: string
  sha256: string
  bytes: number
  /** The path inside the cache folder. */
  relpath: string
}

/**
 * One external atlas source. `files` lists direct downloads only when the
 * source serves stable files without a login and each URL, digest, and
 * size was verified from the source; otherwise it is empty and the panel
 * offers "Open <site>" and "Import downloaded files...".
 */
export interface AtlasSource {
  sourceId: string
  label: string
  kind: AtlasKind
  /** The site name the buttons show, for example "GitHub (CBIG)". */
  site: string
  /** The official page, opened only through the allowlist. */
  pageUrl: string
  license: { name: string; url: string }
  citation: string
  /** The version the cache folder is named after. */
  version: string
  files: AtlasSourceFile[]
  requiresLogin: boolean
  /** The atlas IDs the source provides once present. */
  atlasIds: string[]
  hemisphereRules: HemisphereTokenRule[]
  /** The recipe that labels subjects with it. */
  recipeId: AtlasRecipeId | null
}

/**
 * The external sources. Nothing is bundled. Schaefer 2018 pins the CBIG
 * repository at commit 35b5664 (2026-08-31): its MIT license and the
 * fsaverage annotations of 100, 200, and 400 parcels in 7 and 17 networks
 * (`{hemi}.Schaefer2018_{N}Parcels_{K}Networks_order.annot`, atlas
 * `schaefer{N}-{K}`), each URL, size, and SHA-256 checked against the
 * repository's blob listing. The subjects are labeled from these annots
 * (`user-annot`), since CBIG serves its gcs files only from a Dropbox
 * archive. The other sources were verified on 2026-09-30 but pin nothing:
 * Brainnetome (NITRC) and Brainstem Navigator grant no redistribution, and
 * the Harvard AAN v2 (CC0 on Dryad) and JHU (with FSL) atlases are in MNI
 * space, which this version does not support; they offer "Open <site>"
 * and "Import downloaded files...".
 */
export const ATLAS_SOURCES: readonly AtlasSource[] = [
  {
    sourceId: 'schaefer2018',
    label: 'Schaefer 2018 cortical parcellations',
    kind: 'surface',
    site: 'GitHub (CBIG)',
    pageUrl:
      'https://github.com/ThomasYeoLab/CBIG/tree/master/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal',
    license: {
      name: 'MIT',
      url: 'https://github.com/ThomasYeoLab/CBIG/blob/master/LICENSE.md',
    },
    citation:
      'Schaefer A, et al. Local-global parcellation of the human cerebral cortex from intrinsic functional connectivity MRI. Cereb Cortex. 2018;28(9):3095-3114.',
    version: 'cbig-35b5664',
    files: [
      {
        url: 'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6/LICENSE.md',
        sha256:
          '0e38f0e8b304f13de2ce2911320faaa08ced178e031d3bbebc3e4769762e5f50',
        bytes: 1084,
        relpath: 'LICENSE.md',
      },
      {
        url: 'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3/fsaverage/label/lh.Schaefer2018_100Parcels_7Networks_order.annot',
        sha256:
          '4c648453ee3de1041be3bc28d39621a6edc13a2ec046e493a765821ed3ab5052',
        bytes: 1313376,
        relpath:
          'fsaverage/label/lh.Schaefer2018_100Parcels_7Networks_order.annot',
      },
      {
        url: 'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3/fsaverage/label/rh.Schaefer2018_100Parcels_7Networks_order.annot',
        sha256:
          '0cedc865047580df56e46186dc6416d8cf431cae104a1666ec8dc3efa761fb3c',
        bytes: 1313371,
        relpath:
          'fsaverage/label/rh.Schaefer2018_100Parcels_7Networks_order.annot',
      },
      {
        url: 'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3/fsaverage/label/lh.Schaefer2018_100Parcels_17Networks_order.annot',
        sha256:
          'cc92db8dee0091ea3d19c265ca0e4387982f4d78e82ec9a1b227ee829d4c8fcc',
        bytes: 1313574,
        relpath:
          'fsaverage/label/lh.Schaefer2018_100Parcels_17Networks_order.annot',
      },
      {
        url: 'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3/fsaverage/label/rh.Schaefer2018_100Parcels_17Networks_order.annot',
        sha256:
          'dfb63fc3244ba56b9609d4854a41e8cdd165c168b93b69ac2a60a0e7c4890f82',
        bytes: 1313537,
        relpath:
          'fsaverage/label/rh.Schaefer2018_100Parcels_17Networks_order.annot',
      },
      {
        url: 'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3/fsaverage/label/lh.Schaefer2018_200Parcels_7Networks_order.annot',
        sha256:
          'c225937c31584c74d3e7c8fba7c17916ce4e730faa542ee61659041db136ac87',
        bytes: 1315895,
        relpath:
          'fsaverage/label/lh.Schaefer2018_200Parcels_7Networks_order.annot',
      },
      {
        url: 'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3/fsaverage/label/rh.Schaefer2018_200Parcels_7Networks_order.annot',
        sha256:
          '5439cd1fb913cbb76366f9590b5733efcb7adf9cde25413f6e0b681ff0abdcf8',
        bytes: 1315902,
        relpath:
          'fsaverage/label/rh.Schaefer2018_200Parcels_7Networks_order.annot',
      },
      {
        url: 'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3/fsaverage/label/lh.Schaefer2018_200Parcels_17Networks_order.annot',
        sha256:
          '7b83bd37b30ced55bacf21aa837404bca453fa6f1b2fa4b2d1d3cf185c4950db',
        bytes: 1316234,
        relpath:
          'fsaverage/label/lh.Schaefer2018_200Parcels_17Networks_order.annot',
      },
      {
        url: 'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3/fsaverage/label/rh.Schaefer2018_200Parcels_17Networks_order.annot',
        sha256:
          '70a78d74b1be6110e0d272b8c82c08f284633f0f003148c743b480a7bf13f7f5',
        bytes: 1316210,
        relpath:
          'fsaverage/label/rh.Schaefer2018_200Parcels_17Networks_order.annot',
      },
      {
        url: 'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3/fsaverage/label/lh.Schaefer2018_400Parcels_7Networks_order.annot',
        sha256:
          '351848da486c2b178ef825640c076fcbcf054095bed0c91d5854d2c593e5c1ee',
        bytes: 1320939,
        relpath:
          'fsaverage/label/lh.Schaefer2018_400Parcels_7Networks_order.annot',
      },
      {
        url: 'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3/fsaverage/label/rh.Schaefer2018_400Parcels_7Networks_order.annot',
        sha256:
          '595444aecc3b59a8a6838b2e5c7f2052e88e25b1c5f833c5a6bdb984e3fa978f',
        bytes: 1321004,
        relpath:
          'fsaverage/label/rh.Schaefer2018_400Parcels_7Networks_order.annot',
      },
      {
        url: 'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3/fsaverage/label/lh.Schaefer2018_400Parcels_17Networks_order.annot',
        sha256:
          '4121084967a6fb51bafe4ee1dd0e79aabfad90b20424866a6b46069efc1f2d51',
        bytes: 1321612,
        relpath:
          'fsaverage/label/lh.Schaefer2018_400Parcels_17Networks_order.annot',
      },
      {
        url: 'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/35b5664bec8822e2f77da5e090e96f91d0095be6/stable_projects/brain_parcellation/Schaefer2018_LocalGlobal/Parcellations/FreeSurfer5.3/fsaverage/label/rh.Schaefer2018_400Parcels_17Networks_order.annot',
        sha256:
          '515c9de716435fcedf7062c8116fb4e039e74b21a37191fa715d6c7712b62dad',
        bytes: 1321589,
        relpath:
          'fsaverage/label/rh.Schaefer2018_400Parcels_17Networks_order.annot',
      },
    ],
    requiresLogin: false,
    atlasIds: [
      'schaefer100-7',
      'schaefer100-17',
      'schaefer200-7',
      'schaefer200-17',
      'schaefer400-7',
      'schaefer400-17',
    ],
    hemisphereRules: ['lh-rh-underscore-infix'],
    recipeId: 'user-annot',
  },
  {
    sourceId: 'brainnetome',
    label: 'Brainnetome atlas',
    kind: 'surface',
    site: 'NITRC',
    pageUrl: 'https://www.nitrc.org/projects/bn_atlas/',
    license: {
      name: 'Brainnetome terms: non-commercial, attribution, share alike',
      url: 'https://www.nitrc.org/projects/bn_atlas/',
    },
    citation:
      'Fan L, Li H, Zhuo J, et al. The human Brainnetome atlas: a new brain atlas based on connectional architecture. Cereb Cortex. 2016;26(8):3508-3526.',
    version: 'nitrc',
    files: [],
    requiresLogin: true,
    atlasIds: [],
    hemisphereRules: ['l-r-underscore-suffix'],
    recipeId: 'user-gcs',
  },
  {
    sourceId: 'brainstem-navigator',
    label: 'Brainstem Navigator',
    kind: 'volume',
    site: 'NITRC',
    pageUrl: 'https://www.nitrc.org/projects/brainstemnavig/',
    license: {
      name: 'Not stated on the project page',
      url: 'https://www.nitrc.org/projects/brainstemnavig/',
    },
    citation:
      'Bianciardi M, et al. Brainstem Navigator v1.0. NITRC. doi:10.25790/bml0cm.96. See the project page for the atlas papers to cite.',
    version: '1.0',
    files: [],
    requiresLogin: true,
    atlasIds: [],
    hemisphereRules: ['l-r-underscore-suffix'],
    recipeId: 'user-volume',
  },
  {
    sourceId: 'harvard-aan',
    label: 'Harvard Ascending Arousal Network atlas v2',
    kind: 'volume',
    site: 'Dryad',
    pageUrl: 'https://datadryad.org/dataset/doi:10.5061/dryad.zw3r228d2',
    license: {
      name: 'CC0 1.0 (Dryad terms)',
      url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    },
    citation:
      'Edlow BL, et al. Sustaining wakefulness: brainstem connectivity in human consciousness. bioRxiv. 2023. doi:10.1101/2023.07.13.548265.',
    version: '2.0',
    files: [],
    requiresLogin: false,
    atlasIds: [],
    hemisphereRules: ['left-right-prefix'],
    recipeId: 'user-volume',
  },
  {
    sourceId: 'jhu',
    label: 'JHU white-matter atlases (with FSL)',
    kind: 'volume',
    site: 'FSL',
    pageUrl: 'https://fsl.fmrib.ox.ac.uk/fsl/docs/other/datasets.html',
    license: {
      name: 'FSL license (non-commercial)',
      url: 'https://fsl.fmrib.ox.ac.uk/fsl/docs/license.html',
    },
    citation:
      'Mori S, et al. MRI Atlas of Human White Matter. Elsevier; 2005. Wakana S, et al. NeuroImage. 2007;36:630-644. Hua K, et al. NeuroImage. 2008;39(1):336-347.',
    version: 'fsl',
    files: [],
    requiresLogin: false,
    atlasIds: [],
    hemisphereRules: ['left-right-prefix'],
    recipeId: 'user-volume',
  },
]

/** A source's cache state on this machine. */
export type AtlasSourceCacheState = 'absent' | 'present' | 'corrupt'

/**
 * The machine-level cache manifest of one source version,
 * `<userData>/atlases/<sourceId>/<version>/manifest.json`.
 */
export interface AtlasCacheManifest {
  schema: typeof ATLAS_CACHE_SCHEMA
  schemaVersion: 1
  sourceId: string
  version: string
  provenance: 'downloaded' | 'imported'
  files: {
    relpath: string
    url: string | null
    sha256: string
    bytes: number
  }[]
  license: { name: string; url: string | null; acknowledgedAt: string }
  retrievedAt: string
  /**
   * The atlases the cached files provide (an import writes one, with the
   * atlas ID `user-<hex8>` as its `sourceId`); the catalog lists each.
   */
  atlases?: AtlasCacheAtlas[]
}

/** One atlas a machine-level cache folder provides. */
export interface AtlasCacheAtlas {
  atlasId: string
  label: string
  kind: AtlasKind
  recipeId: 'user-gcs' | 'user-annot' | 'user-volume'
  /** The listed source the files came from, or null. */
  externalSourceId: string | null
  hemisphereRules: HemisphereTokenRule[]
  /** The file names in the cache folder, in recipe order. */
  files: string[]
}

/** One source with its cache state (`atlasSources.list`). */
export interface AtlasSourceListing {
  source: AtlasSource
  state: AtlasSourceCacheState
  /** The cached version and when it arrived, when present. */
  cached: { version: string; retrievedAt: string; bytes: number } | null
  /** True when the panel may offer "Download from <site>". */
  downloadable: boolean
}

/** The result of `atlasSources.list`. */
export interface AtlasSourcesList {
  /** The machine-level cache folder, for display. */
  cacheDisplayPath: string
  sources: AtlasSourceListing[]
}

/** One atlas download (one at a time per app). */
export interface AtlasDownloadOperation {
  operationId: string
  sourceId: string
  state: 'running' | 'done' | 'cancelled' | 'failed'
  receivedBytes: number
  totalBytes: number
  /** The file being fetched, as `relpath`. */
  file: string | null
  startedAt: string
  finishedAt: string | null
  message: string | null
}

/** The result of `atlasSources.download`. */
export interface AtlasDownloadStartResult {
  operation: AtlasDownloadOperation
  started: boolean
}

/** The result of `atlasSources.status`. */
export interface AtlasDownloadStatus {
  operation: AtlasDownloadOperation | null
}

/** The result of `atlasSources.cancel`. */
export interface AtlasDownloadCancelResult {
  operationId: string
  stopped: boolean
}

/** Which of a source's catalog URLs to open: its page or its license. */
export type AtlasSourceUrlKind = 'page' | 'license'

/** The URL kinds `atlasSources.openPage` accepts. */
export const ATLAS_SOURCE_URL_KINDS: readonly AtlasSourceUrlKind[] = [
  'page',
  'license',
]

/**
 * Give the URL that may be opened for a source: exactly its catalog
 * `pageUrl` or its license URL, when https.
 *
 * @returns The URL, or null for an unknown source or kind.
 */
export function atlasSourceUrl(
  sourceId: unknown,
  kind: unknown,
): string | null {
  const source = ATLAS_SOURCES.find((item) => item.sourceId === sourceId)
  const url =
    kind === 'page'
      ? source?.pageUrl
      : kind === 'license'
        ? source?.license.url
        : undefined
  return url !== undefined && HTTPS_URL.test(url) ? url : null
}

/**
 * Give a source's official page URL (`atlasSourceUrl` with `page`).
 *
 * @returns The page URL, or null for an unknown source.
 */
export function atlasSourcePage(sourceId: unknown): string | null {
  return atlasSourceUrl(sourceId, 'page')
}

// -- Parsers -------------------------------------------------------------------

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const message = z.string().max(MAX_MESSAGE)
const timestamp = z.string().regex(ISO_TIMESTAMP)
const subjectId = z.string().regex(SUBJECT_ID)
const printable = (max: number) => z.string().min(1).max(max).regex(PRINTABLE)
const atlasId = z.string().regex(ATLAS_ID)
const httpsUrl = z.string().max(2048).regex(HTTPS_URL)
const recipeId = z.enum(ATLAS_RECIPE_IDS)
const kind = z.enum(['surface', 'volume'])
const origin = z.enum(['pipeline', 'recon-stats', 'labeled', 'added'])
const namespace = z.enum(['dk', 'aseg', 'global', 'parc', 'vol'])

const labelOperationSchema = z.strictObject({
  operationId: z.string().regex(ATLAS_LABEL_OPERATION_ID),
  atlasId,
  state: z.enum(['running', 'done', 'cancelled', 'failed']),
  completed: count,
  failed: count,
  skipped: count,
  total: count,
  current: z.strictObject({ subjectId, startedAt: timestamp }).nullable(),
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  remainingSeconds: count.nullable(),
  message: message.nullable(),
})

const licenseNoteSchema = z.strictObject({
  name: printable(120),
  url: httpsUrl.nullable(),
  acknowledgedAt: timestamp.nullable(),
})

const atlasEntrySchema = z.strictObject({
  atlasId,
  label: printable(120),
  tier: z.enum(['A', 'B']),
  kind,
  origin,
  namespace,
  recipeId: recipeId.nullable(),
  externalSourceId: printable(64).nullable(),
  available: z.boolean(),
  unavailableReason: message.nullable(),
  counts: z.strictObject({
    total: count,
    withFiles: count,
    labeled: count,
    stale: count,
    failed: count,
    reconOutdated: count,
  }),
  estimateSeconds: count.nullable(),
  license: licenseNoteSchema.nullable(),
  citation: z.string().max(1024).nullable(),
})

const catalogSchema = z.strictObject({
  configRevision: count,
  revision: count,
  atlases: z.array(atlasEntrySchema).max(MAX_ATLASES),
  tools: z
    .array(
      z.strictObject({
        toolId: z.enum(ATLAS_TOOL_IDS),
        state: z.enum(['ok', 'missing', 'broken', 'unknown']),
        detail: message,
        fix: z
          .enum([
            'choose-subregions-python',
            'set-freesurfer-home',
            'import-outputs',
          ])
          .nullable(),
      }),
    )
    .max(ATLAS_TOOL_IDS.length),
  subregionsPython: z.string().min(1).max(4096).nullable(),
  labeling: labelOperationSchema.nullable(),
})

const subjectStatusSchema = z.strictObject({
  subjectId,
  state: z.enum([
    'missing',
    'queued',
    'running',
    'current',
    'stale',
    'provisional',
    'failed',
    'skipped',
  ]),
  staleReasons: z
    .array(z.enum(['recon-changed', 'tool-changed', 'recipe-changed']))
    .max(3),
  provenance: z.enum(['labeled', 'imported']).nullable(),
  updatedAt: timestamp.nullable(),
  seconds: count.nullable(),
  message: message.nullable(),
})

const sourceSchema = z.strictObject({
  sourceId: printable(64),
  label: printable(120),
  kind,
  site: printable(64),
  pageUrl: httpsUrl,
  license: z.strictObject({ name: printable(120), url: httpsUrl }),
  citation: z.string().min(1).max(1024),
  version: printable(64),
  files: z
    .array(
      z.strictObject({
        url: httpsUrl,
        sha256: z.string().regex(SHA256),
        bytes: count,
        relpath: z.string().regex(RELPATH),
      }),
    )
    .max(64),
  requiresLogin: z.boolean(),
  atlasIds: z.array(atlasId).max(16),
  hemisphereRules: z.array(z.enum(HEMISPHERE_TOKEN_RULES)).max(6),
  recipeId: recipeId.nullable(),
})

const downloadOperationSchema = z.strictObject({
  operationId: z.string().regex(ATLAS_DOWNLOAD_OPERATION_ID),
  sourceId: printable(64),
  state: z.enum(['running', 'done', 'cancelled', 'failed']),
  receivedBytes: count,
  totalBytes: count,
  file: z.string().regex(RELPATH).nullable(),
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  message: message.nullable(),
})

function parseWith<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const path = parsed.error.issues[0]?.path.join('.') ?? ''
  throw new TypeError(
    `Provide a valid ${label}${path ? ` (field ${path})` : ''}.`,
  )
}

/** Validate the result of `groupAnalysis.atlases`. */
export function parseAtlasCatalog(value: unknown): AtlasCatalog {
  return parseWith(catalogSchema, value, 'atlas catalog')
}

/** Validate the result of `groupAnalysis.labelStart`. */
export function parseAtlasLabelStartResult(
  value: unknown,
): AtlasLabelStartResult {
  return parseWith(
    z.strictObject({ operation: labelOperationSchema, started: z.boolean() }),
    value,
    'labeling start result',
  )
}

/** Validate the result of `groupAnalysis.labelStatus`. */
export function parseAtlasLabelStatus(value: unknown): AtlasLabelStatus {
  return parseWith(
    z.strictObject({
      operation: labelOperationSchema.nullable(),
      atlasId: atlasId.nullable(),
      subjects: z.array(subjectStatusSchema).max(MAX_LABEL_SUBJECTS),
    }),
    value,
    'labeling status',
  )
}

/** Validate the result of `groupAnalysis.labelCancel`. */
export function parseAtlasLabelCancelResult(
  value: unknown,
): AtlasLabelCancelResult {
  return parseWith(
    z.strictObject({
      operationId: z.string().regex(ATLAS_LABEL_OPERATION_ID),
      stopped: z.boolean(),
    }),
    value,
    'labeling cancel result',
  )
}

/** Validate the result of `groupAnalysis.clearLabels`. */
export function parseAtlasLabelsCleared(value: unknown): AtlasLabelsCleared {
  return parseWith(
    z.strictObject({ revision: count, cleared: count }),
    value,
    'labels clear result',
  )
}

/** Validate the result of the main-internal `groupAnalysis.importAtlas`. */
export function parseAtlasImportResult(value: unknown): AtlasImportResult {
  return parseWith(
    z.strictObject({ atlas: atlasEntrySchema }),
    value,
    'atlas import result',
  )
}

/** Validate the result of the main-internal `groupAnalysis.importAtlasLabels`. */
export function parseAtlasLabelsImportResult(
  value: unknown,
): AtlasLabelsImportResult {
  return parseWith(
    z.strictObject({
      atlasId,
      imported: count,
      unrecognized: z.array(subjectId).max(MAX_LABEL_SUBJECTS),
    }),
    value,
    'labels import result',
  )
}

/** Validate the result of `atlasSources.list`. */
export function parseAtlasSourcesList(value: unknown): AtlasSourcesList {
  return parseWith(
    z.strictObject({
      cacheDisplayPath: z.string().min(1).max(16_384),
      sources: z
        .array(
          z.strictObject({
            source: sourceSchema,
            state: z.enum(['absent', 'present', 'corrupt']),
            cached: z
              .strictObject({
                version: printable(64),
                retrievedAt: timestamp,
                bytes: count,
              })
              .nullable(),
            downloadable: z.boolean(),
          }),
        )
        .max(MAX_ATLASES),
    }),
    value,
    'atlas source list',
  )
}

/** Validate the result of `atlasSources.download`. */
export function parseAtlasDownloadStartResult(
  value: unknown,
): AtlasDownloadStartResult {
  return parseWith(
    z.strictObject({
      operation: downloadOperationSchema,
      started: z.boolean(),
    }),
    value,
    'atlas download start result',
  )
}

/** Validate the result of `atlasSources.status`. */
export function parseAtlasDownloadStatus(value: unknown): AtlasDownloadStatus {
  return parseWith(
    z.strictObject({ operation: downloadOperationSchema.nullable() }),
    value,
    'atlas download status',
  )
}

/** Validate the result of `atlasSources.cancel`. */
export function parseAtlasDownloadCancelResult(
  value: unknown,
): AtlasDownloadCancelResult {
  return parseWith(
    z.strictObject({
      operationId: z.string().regex(ATLAS_DOWNLOAD_OPERATION_ID),
      stopped: z.boolean(),
    }),
    value,
    'atlas download cancel result',
  )
}

// -- Request validation --------------------------------------------------------

/** The exact fields of every renderer-visible labeling request. */
export const ATLAS_LABELING_REQUEST_FIELDS: Readonly<
  Record<string, readonly string[]>
> = {
  'groupAnalysis.atlases': ['project', 'reconOutdatedSubjectIds'],
  'groupAnalysis.labelStart': [
    'project',
    'atlasId',
    'subjects',
    'jobs',
    'stageCurrency',
  ],
  'groupAnalysis.labelStatus': ['project', 'atlasId'],
  'groupAnalysis.labelCancel': ['project', 'operationId'],
  'groupAnalysis.clearLabels': [
    'project',
    'atlasId',
    'subjects',
    'expectedRevision',
  ],
}

/**
 * Check one labeling request before it leaves main: the exact fields, then
 * each value. The caller checks the project reference and the stage
 * currency (`validateAnalysisStageCurrency`).
 *
 * @throws Error naming the first problem.
 */
export function validateAtlasLabelingRequest(
  method: string,
  request: Record<string, unknown>,
): void {
  const fields = ATLAS_LABELING_REQUEST_FIELDS[method]
  if (!fields) throw new Error('Call an allowlisted labeling method.')
  const actual = Object.keys(request).sort()
  const wanted = [...fields].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`Correct the invalid fields in the ${method} request.`)
  }
  if ('atlasId' in request) {
    const nullable = method === 'groupAnalysis.labelStatus'
    if (
      !(
        (nullable && request.atlasId === null) ||
        (typeof request.atlasId === 'string' && ATLAS_ID.test(request.atlasId))
      )
    ) {
      throw new Error('Provide a valid atlas ID.')
    }
  }
  if ('subjects' in request) {
    const subjects = request.subjects
    const clearing = method === 'groupAnalysis.clearLabels'
    const valid =
      (!clearing && (subjects === 'missing' || subjects === 'stale')) ||
      (clearing && subjects === 'all') ||
      (Array.isArray(subjects) &&
        subjects.length > 0 &&
        subjects.length <= MAX_LABEL_SUBJECTS &&
        subjects.every((id) => typeof id === 'string' && SUBJECT_ID.test(id)) &&
        new Set(subjects).size === subjects.length)
    if (!valid) throw new Error('Name the subjects to label, each once.')
  }
  if ('reconOutdatedSubjectIds' in request) {
    const ids = request.reconOutdatedSubjectIds
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_LABEL_SUBJECTS ||
      ids.some((id) => typeof id !== 'string' || !SUBJECT_ID.test(id))
    ) {
      throw new Error('Send the out-of-date subjects as subject IDs.')
    }
  }
  if (
    'jobs' in request &&
    !(
      Number.isSafeInteger(request.jobs) &&
      (request.jobs as number) >= 1 &&
      (request.jobs as number) <= MAX_LABEL_JOBS
    )
  ) {
    throw new Error('Choose 1 to 8 parallel labeling jobs.')
  }
  if (
    'operationId' in request &&
    !(
      typeof request.operationId === 'string' &&
      ATLAS_LABEL_OPERATION_ID.test(request.operationId)
    )
  ) {
    throw new Error('Provide a valid labeling operation ID.')
  }
  if (
    'expectedRevision' in request &&
    !(
      Number.isSafeInteger(request.expectedRevision) &&
      (request.expectedRevision as number) >= 0
    )
  ) {
    throw new Error('Provide the labeling cache revision.')
  }
}

/** The input-source key of an atlas's labels (`labels:<atlasId>`). */
export function labelsInputSource(atlasIdValue: string): `labels:${string}` {
  const source = `labels:${atlasIdValue}` as const
  if (!ANALYSIS_INPUT_SOURCE_V2.test(source)) {
    throw new TypeError(`Use a valid atlas ID: ${atlasIdValue}.`)
  }
  return source
}

/** The parcellation metrics, re-exported for atlas pickers. */
export { PARC_METRICS }
