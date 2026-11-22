/**
 * The interactive group-analysis contract: the analysis specification (spec
 * v1), the measure ID grammar, and the RPC result shapes of every
 * `groupAnalysis.*` method.
 *
 * `sidecar/supraspina_sidecar/group_analysis/spec.py` mirrors the specification
 * schema, the measure ID grammar, and the canonical JSON form. Keep both in
 * step: the cross-language fixture
 * `sidecar/tests/fixtures/group_analysis/spec-v1-example.json` binds them.
 */

import { z } from 'zod'

// -- Identity ------------------------------------------------------------

/** The `schema` value of every analysis specification. */
export const GROUP_ANALYSIS_SPEC_SCHEMA = 'supraspina/group-analysis-spec'
/** The `schema` value of every stored analysis result. */
export const GROUP_ANALYSIS_RESULT_SCHEMA = 'supraspina/group-analysis-result'
/** The model and inference implementation a v1 result records. */
export const GROUP_ANALYSIS_ENGINE_ID = 'ols-freedman-lane-maxt-v1'
/**
 * The v2 engine (general linear hypotheses, t and F, Freedman-Lane). It
 * reproduces v1 results, so the currency check treats v1 results as current.
 */
export const GROUP_ANALYSIS_ENGINE_ID_V2 = 'ols-glh-freedman-lane-v2'
/** The permutation generator a result records (PCG64 through NumPy). */
export const GROUP_ANALYSIS_RNG_ID = 'numpy-pcg64'
/** The sidecar handshake capability that serves `groupAnalysis.*` (v2). */
export const GROUP_ANALYSIS_CAPABILITY = 'cohort-analysis-v2'
/** The largest `groupAnalysis.result` or `termRows` payload the sidecar returns. */
export const GROUP_ANALYSIS_MAX_RESULT_BYTES = 2 * 1024 * 1024
/** The largest stored v2 result record. */
export const GROUP_ANALYSIS_MAX_RECORD_BYTES_V2 = 32 * 1024 * 1024
/** The rows one `groupAnalysis.termRows` page returns at most. */
export const GROUP_ANALYSIS_TERM_PAGE_ROWS = 2_000
/** The IDs of result terms. */
export const GROUP_ANALYSIS_TERM_ID = /^term-[0-9]{1,4}$/

/** The operation IDs the sidecar issues for a compute. */
export const GROUP_ANALYSIS_OPERATION_ID = /^gan-[a-f0-9]{16}$/
/** The IDs of stored results. */
export const GROUP_ANALYSIS_RESULT_ID = /^gar-[a-f0-9]{16}$/
/** The IDs of saved specifications. */
export const GROUP_ANALYSIS_SPEC_ID = /^gas-[a-f0-9]{16}$/
/** The IDs of saved ROI sets. */
export const GROUP_ANALYSIS_SET_ID = /^gset-[a-f0-9]{16}$/

const SHA256 = /^[a-f0-9]{64}$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/
const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Printable ASCII without leading or trailing spaces. */
const PRINTABLE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

const MAX_MEASURES = 2_000
const MAX_SUBJECTS = 5_000
const MAX_GROUPS = 8
const MAX_LEVELS = 64
const MAX_EXTRA_COVARIATES = 8
const MAX_SAVED = 200
const MAX_RESULTS = 64
const MAX_MESSAGE = 512

// -- Measure ID grammar (v2) ------------------------------------------------

/** The FreeSurfer `aparc.stats` metrics, spelled as `dk_all_stats.csv` spells them. */
export const DK_METRICS = [
  'ThickAvg',
  'ThickStd',
  'SurfArea',
  'GrayVol',
  'NumVert',
  'MeanCurv',
  'GausCurv',
  'FoldInd',
  'CurvInd',
] as const
/** One Desikan-Killiany surface metric. */
export type DkMetric = (typeof DK_METRICS)[number]
/**
 * The size-dependent metrics that take eTIV under the default rule.
 */
export const EXTENSIVE_DK_METRICS: readonly DkMetric[] = [
  'NumVert',
  'SurfArea',
  'GrayVol',
  'FoldInd',
]
/**
 * The surface-parcellation metrics: the `aparc.stats` metrics plus the
 * gray-to-white contrast `GWC` (the `w-g.pct.stats` Mean).
 */
export const PARC_METRICS = [...DK_METRICS, 'GWC'] as const
/** One surface-parcellation metric. */
export type ParcMetric = (typeof PARC_METRICS)[number]
/**
 * The whole-brain measures: head size (eTIV, sTIV, SynthSeg TIV), the
 * `aseg.stats` Measure lines, mean thickness, and the surface-hole count.
 */
export const GLOBAL_MEASURES = [
  'eTIV',
  'sTIV',
  'synthsegTIV',
  'meanThickness',
  'BrainSegVol',
  'BrainSegVolNotVent',
  'CortexVol',
  'TotalGrayVol',
  'SubCortGrayVol',
  'CerebralWhiteMatterVol',
  'SupraTentorialVol',
  'SurfaceHoles',
] as const
/** One whole-brain measure. */
export type GlobalMeasure = (typeof GLOBAL_MEASURES)[number]
/** The whole-brain measures spec v1 accepts. */
export const GLOBAL_MEASURES_V1: readonly GlobalMeasure[] = [
  'eTIV',
  'meanThickness',
]
/** The whole-brain measures that never scale with head size. */
const INTENSIVE_GLOBALS: readonly GlobalMeasure[] = [
  'meanThickness',
  'SurfaceHoles',
]
/** The head-size measures, which are never adjusted for head size. */
export const HEAD_SIZE_MEASURES: readonly GlobalMeasure[] = [
  'eTIV',
  'sTIV',
  'synthsegTIV',
]

/** The longest measure ID (spec v2; spec v1 keeps 96). */
export const MAX_MEASURE_ID_LENGTH = 160
/** The most measures one spec v2 lists (spec v1 keeps 2000). */
export const MAX_MEASURES_V2 = 20_000
/** An atlas ID: the `parc:` and `vol:` namespaces and the atlas cache folders. */
export const ATLAS_ID = /^[a-z][a-z0-9-]{1,47}$/

/** A hemisphere, or the mean of both. */
export type MeasureHemisphere = 'lh' | 'rh' | 'bi'
/** A volume's hemisphere: `mid` for an unpaired (midline) structure. */
export type VolumeHemisphere = MeasureHemisphere | 'mid'
/** Where a measure's values come from. */
export type MeasureSource =
  | 'dk'
  | 'aseg'
  | 'global'
  | 'brainage'
  | 'parc'
  | 'vol'

/** A measure ID split into its grammar parts. */
export type ParsedMeasureId =
  | {
      source: 'dk'
      hemisphere: MeasureHemisphere
      region: string
      metric: DkMetric
    }
  | { source: 'aseg'; hemisphere: 'bi' | null; structure: string }
  | { source: 'global'; name: GlobalMeasure }
  | { source: 'brainage'; name: 'BrainPAD' }
  | {
      source: 'parc'
      atlas: string
      hemisphere: MeasureHemisphere
      region: string
      metric: ParcMetric
    }
  | {
      source: 'vol'
      atlas: string
      hemisphere: VolumeHemisphere
      structure: string
    }

const ATLAS_PART = '[a-z][a-z0-9-]{1,47}'
const REGION_PART = '[A-Za-z0-9_.&-]{1,64}'
const DK_ID = new RegExp(
  `^dk:(lh|rh|bi):([a-z]{2,40}):(${DK_METRICS.join('|')})$`,
)
const ASEG_ID = /^aseg:(?:(bi):)?([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/
const GLOBAL_ID = new RegExp(`^global:(${GLOBAL_MEASURES.join('|')})$`)
const BRAINAGE_ID = /^brainage:BrainPAD$/
const PARC_ID = new RegExp(
  `^parc:(${ATLAS_PART}):(lh|rh|bi):(${REGION_PART}):(${PARC_METRICS.join('|')})$`,
)
const VOL_ID = new RegExp(
  `^vol:(${ATLAS_PART}):(lh|rh|bi|mid):(${REGION_PART})$`,
)
/** A generic hemisphere token a stripped region or structure never keeps. */
const HEMISPHERE_TOKEN = /^(?:Left-|Right-|lh\.|rh\.)/

/**
 * Split a measure ID into its parts.
 *
 * The grammar: `dk:{lh|rh|bi}:{region}:{metric}`, `aseg:{Structure}`,
 * `aseg:bi:{Structure}` (the mean of `Left-` and `Right-{Structure}`),
 * `global:{name}`, `brainage:BrainPAD`,
 * `parc:{atlas}:{lh|rh|bi}:{region}:{metric}` (a surface parcellation's
 * region with the hemisphere token stripped), and
 * `vol:{atlas}:{lh|rh|bi|mid}:{structure}` (a labeled volume in mm3; `mid`
 * for an unpaired structure). The `dk` and `aseg` atlases keep their own
 * namespaces, so `parc:dk:` and `vol:aseg:` are refused. IDs are at most
 * `MAX_MEASURE_ID_LENGTH` characters.
 *
 * @returns The parts, or null when the ID breaks the grammar.
 */
export function parseMeasureId(id: string): ParsedMeasureId | null {
  if (typeof id !== 'string' || id.length > MAX_MEASURE_ID_LENGTH) return null
  const dk = DK_ID.exec(id)
  if (dk) {
    return {
      source: 'dk',
      hemisphere: dk[1] as MeasureHemisphere,
      region: dk[2]!,
      metric: dk[3] as DkMetric,
    }
  }
  const aseg = ASEG_ID.exec(id)
  if (aseg) {
    const structure = aseg[2]!
    const bilateral = aseg[1] === 'bi'
    if (structure === 'bi') return null
    if (bilateral && /^(?:Left|Right)-/.test(structure)) return null
    return { source: 'aseg', hemisphere: bilateral ? 'bi' : null, structure }
  }
  const global = GLOBAL_ID.exec(id)
  if (global) return { source: 'global', name: global[1] as GlobalMeasure }
  if (BRAINAGE_ID.test(id)) return { source: 'brainage', name: 'BrainPAD' }
  const parc = PARC_ID.exec(id)
  if (parc) {
    if (parc[1] === 'dk' || HEMISPHERE_TOKEN.test(parc[3]!)) return null
    return {
      source: 'parc',
      atlas: parc[1]!,
      hemisphere: parc[2] as MeasureHemisphere,
      region: parc[3]!,
      metric: parc[4] as ParcMetric,
    }
  }
  const vol = VOL_ID.exec(id)
  if (vol) {
    if (vol[1] === 'aseg' || HEMISPHERE_TOKEN.test(vol[3]!)) return null
    return {
      source: 'vol',
      atlas: vol[1]!,
      hemisphere: vol[2] as VolumeHemisphere,
      structure: vol[3]!,
    }
  }
  return null
}

/**
 * Say whether a measure ID is one spec v1 accepts: the v1 sources, the v1
 * whole-brain measures, and at most 96 characters.
 */
export function isMeasureIdV1(id: string): boolean {
  const parsed = id.length <= 96 ? parseMeasureId(id) : null
  if (!parsed || parsed.source === 'parc' || parsed.source === 'vol') {
    return false
  }
  return parsed.source !== 'global' || GLOBAL_MEASURES_V1.includes(parsed.name)
}

/**
 * Name the correction family of a measure: one per DK metric, one per
 * parcellation atlas and metric, one per volume atlas, and one each for
 * aseg volumes, global measures, and brain age.
 *
 * @returns The family key, for example `dk:ThickAvg`, `parc:a2009s:GrayVol`,
 *   `vol:brainstem-ss`, or `aseg`.
 * @throws TypeError when the ID breaks the grammar.
 */
export function measureFamily(id: string): string {
  const parsed = parseMeasureId(id)
  if (!parsed) throw new TypeError(`Use a valid measure ID: ${id}.`)
  switch (parsed.source) {
    case 'dk':
      return `dk:${parsed.metric}`
    case 'parc':
      return `parc:${parsed.atlas}:${parsed.metric}`
    case 'vol':
      return `vol:${parsed.atlas}`
    default:
      return parsed.source
  }
}

/**
 * Say whether a measure scales with head size, so the default rule adds the
 * head-size covariate (DK and parcellation area,
 * volume, vertex count, and folding index; every aseg and labeled volume; the
 * whole-brain volumes, head size itself included, which is never adjusted for
 * itself). Thickness, curvature, gray-to-white contrast, mean thickness, the
 * surface-hole count, and Brain-PAD are intensive.
 *
 * @returns True for an extensive measure.
 * @throws TypeError when the ID breaks the grammar.
 */
export function isExtensiveMeasure(id: string): boolean {
  const parsed = parseMeasureId(id)
  if (!parsed) throw new TypeError(`Use a valid measure ID: ${id}.`)
  switch (parsed.source) {
    case 'dk':
      return EXTENSIVE_DK_METRICS.includes(parsed.metric)
    case 'parc':
      return (EXTENSIVE_DK_METRICS as readonly string[]).includes(parsed.metric)
    case 'aseg':
    case 'vol':
      return true
    case 'global':
      return !INTENSIVE_GLOBALS.includes(parsed.name)
    case 'brainage':
      return false
  }
}

/**
 * How an atlas spells the hemisphere in its label names, so the two
 * hemispheres' labels pair into one `bi` measure:
 *
 * - `left-right-prefix`: `Left-Thalamus`, `Right-Thalamus` (aseg style).
 * - `lh-rh-dot-prefix`: `lh.V1`, `rh.V1`.
 * - `lh-rh-hyphen-infix`: `wm-lh-precentral` (wmparc and `ctx-` style).
 * - `lh-rh-underscore-infix`: `7Networks_LH_Vis_1` (Schaefer).
 * - `l-r-underscore-suffix`: `A8m_L`, `A8m_R` (Brainnetome).
 * - `none`: the atlas has no hemisphere token (every label is `mid`, or the
 *   files are per hemisphere already).
 */
export const HEMISPHERE_TOKEN_RULES = [
  'left-right-prefix',
  'lh-rh-dot-prefix',
  'lh-rh-hyphen-infix',
  'lh-rh-underscore-infix',
  'l-r-underscore-suffix',
  'none',
] as const
/** One hemisphere-token rule. */
export type HemisphereTokenRule = (typeof HEMISPHERE_TOKEN_RULES)[number]

/** A label name split into its hemisphere and hemisphere-free structure. */
export interface HemisphereSplit {
  hemisphere: 'lh' | 'rh' | null
  structure: string
}

const TOKEN_PATTERNS: Record<Exclude<HemisphereTokenRule, 'none'>, RegExp> = {
  'left-right-prefix': /^(Left|Right)-(.+)$/,
  'lh-rh-dot-prefix': /^(lh|rh)\.(.+)$/,
  'lh-rh-hyphen-infix': /^([^-]+)-(lh|rh)-(.+)$/,
  'lh-rh-underscore-infix': /^([^_]+)_(LH|RH)_(.+)$/,
  'l-r-underscore-suffix': /^(.+)_(L|R)$/,
}

/**
 * Split one label name by an atlas's hemisphere-token rule.
 *
 * @returns The hemisphere (null for an unpaired label) and the structure
 *   without the token.
 */
export function splitHemisphereToken(
  rule: HemisphereTokenRule,
  name: string,
): HemisphereSplit {
  if (rule === 'none') return { hemisphere: null, structure: name }
  const match = TOKEN_PATTERNS[rule].exec(name)
  if (!match) return { hemisphere: null, structure: name }
  switch (rule) {
    case 'left-right-prefix':
      return {
        hemisphere: match[1] === 'Left' ? 'lh' : 'rh',
        structure: match[2]!,
      }
    case 'lh-rh-dot-prefix':
      return { hemisphere: match[1] as 'lh' | 'rh', structure: match[2]! }
    case 'lh-rh-hyphen-infix':
      return {
        hemisphere: match[2] as 'lh' | 'rh',
        structure: `${match[1]!}-${match[3]!}`,
      }
    case 'lh-rh-underscore-infix':
      return {
        hemisphere: match[2] === 'LH' ? 'lh' : 'rh',
        structure: `${match[1]!}_${match[3]!}`,
      }
    case 'l-r-underscore-suffix':
      return {
        hemisphere: match[2] === 'L' ? 'lh' : 'rh',
        structure: match[1]!,
      }
  }
}

/**
 * Spell one hemisphere's label name from a structure, the inverse of
 * `splitHemisphereToken`.
 *
 * @param rule - The atlas's rule; `none` returns the structure.
 * @param structure - The structure without the token.
 */
export function joinHemisphereToken(
  rule: HemisphereTokenRule,
  hemisphere: 'lh' | 'rh',
  structure: string,
): string {
  const left = hemisphere === 'lh'
  switch (rule) {
    case 'none':
      return structure
    case 'left-right-prefix':
      return `${left ? 'Left' : 'Right'}-${structure}`
    case 'lh-rh-dot-prefix':
      return `${hemisphere}.${structure}`
    case 'lh-rh-hyphen-infix': {
      const cut = structure.indexOf('-')
      return cut < 0
        ? `${hemisphere}-${structure}`
        : `${structure.slice(0, cut)}-${hemisphere}-${structure.slice(cut + 1)}`
    }
    case 'lh-rh-underscore-infix': {
      const token = left ? 'LH' : 'RH'
      const cut = structure.indexOf('_')
      return cut < 0
        ? `${token}_${structure}`
        : `${structure.slice(0, cut)}_${token}_${structure.slice(cut + 1)}`
    }
    case 'l-r-underscore-suffix':
      return `${structure}_${left ? 'L' : 'R'}`
  }
}

// -- Specification (spec v1) --------------------------------------------------

/** The analysis families the panel offers. */
export type AnalysisKind = 'group-comparison' | 'association' | 'brain-age'
/** Where a grouping or covariate variable comes from. */
export type VariableSource =
  | 'registry'
  | 'age-csv'
  | 'clinical-csv'
  | 'metadata-csv'
/**
 * The registry fields a variable may name. `site` (the scanner and protocol)
 * is optional in the registry; an unset site is a missing value.
 */
export const REGISTRY_VARIABLES = [
  'age',
  'sex',
  'cohortRole',
  'sourceCohortLabel',
  'ais',
  'tSinceSci',
  'site',
] as const

/** One variable: a registry field or a metadata CSV column. */
export interface VariableRef {
  source: VariableSource
  column: string
}

/** One analysis group: a label and the variable levels merged into it. */
export interface GroupDefinition {
  label: string
  levels: string[]
}

/** The grouping variable and the groups built from its levels. */
export interface GroupingSpec {
  variable: VariableRef
  groups: GroupDefinition[]
}

/**
 * Which subjects enter the model: every defined group, with a pooled residual
 * variance, or only the two compared groups.
 */
export type GroupModel = 'all-groups' | 'compared-groups'

/** A focal-minus-reference group contrast. */
export interface GroupContrast {
  type: 'groups'
  grouping: GroupingSpec
  focal: string
  reference: string
  model: GroupModel
}

/** The slope of one numeric variable, in all subjects or in chosen groups. */
export interface AssociationContrast {
  type: 'association'
  variable: VariableRef
  grouping: GroupingSpec | null
  /** Group labels to include; empty when `grouping` is null (every subject). */
  includedGroups: string[]
  /** Add group indicators to the model; needs two or more included groups. */
  adjustForGroup: boolean
}

/** The tested contrast. */
export type AnalysisContrast = GroupContrast | AssociationContrast

/** Which measures take eTIV as a covariate. */
export type EtivRule = 'extensive' | 'all' | 'none'

/** The model covariates. */
export interface CovariateSpec {
  age: VariableRef | null
  sex: VariableRef | null
  etiv: EtivRule
  extra: VariableRef[]
  /** Covariates are centered on the sample mean of each availability block. */
  centering: 'sample-mean'
}

/**
 * The subject inclusion rules.
 *
 * - `qc`: `non-failed` is the analysis cohort (no QC Fail); `passed` keeps
 *   only QC Pass; `all` keeps every reconstructed subject.
 * - `registration`: what a surface-registration flag does to that
 *   hemisphere's cortical measures (a bilateral mean is missing when either
 *   hemisphere is).
 * - `outliers`: what an ENIGMA outlier flag does to that measure.
 */
export interface InclusionSpec {
  qc: 'non-failed' | 'passed' | 'all'
  registration: 'set-missing' | 'exclude-subject' | 'keep'
  outliers: 'keep' | 'set-missing' | 'exclude-subject'
}

/**
 * The sign of the tested coefficient (focal minus reference, or the slope)
 * that a one-sided test looks for.
 */
export type Sidedness = 'two-sided' | 'lower' | 'higher'
/** The multiple-comparison correction. */
export type Correction = 'maxt-fwe' | 'holm' | 'bonferroni' | 'bh-fdr' | 'none'
/** The correction family: every selected measure, or each measure family. */
export type CorrectionFamily = 'selected' | 'per-family'
/** The supported permutation counts. */
export const PERMUTATION_COUNTS = [0, 1000, 5000, 10000] as const
/** One supported permutation count. */
export type PermutationCount = (typeof PERMUTATION_COUNTS)[number]

/** The inference settings. */
export interface InferenceSpec {
  sidedness: Sidedness
  correction: Correction
  family: CorrectionFamily
  alpha: number
  permutations: PermutationCount
  /** The PCG64 seed; a new specification gets a random one. */
  seed: number
}

/** One complete, self-contained analysis specification (spec v1). */
export interface GroupAnalysisSpec {
  schema: typeof GROUP_ANALYSIS_SPEC_SCHEMA
  schemaVersion: 1
  analysis: AnalysisKind
  measures: string[]
  contrast: AnalysisContrast
  covariates: CovariateSpec
  inclusion: InclusionSpec
  inference: InferenceSpec
}

const printable = (max: number) => z.string().min(1).max(max).regex(PRINTABLE)

const variableRefSchema = z
  .strictObject({
    source: z.enum(['registry', 'age-csv', 'clinical-csv', 'metadata-csv']),
    column: printable(128),
  })
  .refine(
    (ref) =>
      ref.source !== 'registry' ||
      (REGISTRY_VARIABLES as readonly string[]).includes(ref.column),
    { message: 'Choose a registry field the analysis can use.' },
  )

const groupingSchema = z.strictObject({
  variable: variableRefSchema,
  groups: z
    .array(
      z.strictObject({
        label: printable(64),
        levels: z.array(printable(128)).min(1).max(MAX_LEVELS),
      }),
    )
    .min(1)
    .max(MAX_GROUPS),
})

const contrastSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('groups'),
    grouping: groupingSchema,
    focal: printable(64),
    reference: printable(64),
    model: z.enum(['all-groups', 'compared-groups']),
  }),
  z.strictObject({
    type: z.literal('association'),
    variable: variableRefSchema,
    grouping: groupingSchema.nullable(),
    includedGroups: z.array(printable(64)).max(MAX_GROUPS),
    adjustForGroup: z.boolean(),
  }),
])

const refKey = (ref: VariableRef): string => `${ref.source}\u0000${ref.column}`

function specIssues(spec: GroupAnalysisSpec): string[] {
  const issues: string[] = []
  const measures = spec.measures
  if (new Set(measures).size !== measures.length) {
    issues.push('List each measure once.')
  }
  const { contrast } = spec
  if ((spec.analysis === 'association') !== (contrast.type === 'association')) {
    issues.push('Match the contrast to the analysis type.')
  }
  if (
    spec.analysis === 'brain-age' &&
    (measures.length !== 1 || measures[0] !== 'brainage:BrainPAD')
  ) {
    issues.push('Use Brain-PAD as the only brain-age measure.')
  }
  const grouping = contrast.grouping
  if (grouping) {
    const labels = grouping.groups.map((group) => group.label)
    if (new Set(labels).size !== labels.length) {
      issues.push('Give each group a different label.')
    }
    const levels = grouping.groups.flatMap((group) => group.levels)
    if (new Set(levels).size !== levels.length) {
      issues.push('Assign each level to one group only.')
    }
    if (contrast.type === 'groups') {
      if (grouping.groups.length < 2) {
        issues.push('Define at least two groups to compare.')
      }
      if (!labels.includes(contrast.focal)) {
        issues.push('Choose a defined group as the focal group.')
      }
      if (!labels.includes(contrast.reference)) {
        issues.push('Choose a defined group as the reference group.')
      }
      if (contrast.focal === contrast.reference) {
        issues.push('Choose two different groups to compare.')
      }
    } else {
      const included = contrast.includedGroups
      if (new Set(included).size !== included.length) {
        issues.push('Include each group once.')
      }
      if (included.length === 0 || included.some((l) => !labels.includes(l))) {
        issues.push('Include one or more defined groups.')
      }
    }
  }
  if (contrast.type === 'association') {
    if (!grouping && contrast.includedGroups.length > 0) {
      issues.push('Define the grouping before including groups.')
    }
    if (contrast.adjustForGroup && contrast.includedGroups.length < 2) {
      issues.push('Include two or more groups to adjust for group.')
    }
  }
  const covariates = [
    ...(spec.covariates.age ? [spec.covariates.age] : []),
    ...(spec.covariates.sex ? [spec.covariates.sex] : []),
    ...spec.covariates.extra,
  ].map(refKey)
  if (new Set(covariates).size !== covariates.length) {
    issues.push('Add each covariate once.')
  }
  const tested =
    contrast.type === 'association'
      ? refKey(contrast.variable)
      : refKey(contrast.grouping.variable)
  if (covariates.includes(tested)) {
    issues.push('Do not adjust for the tested variable.')
  }
  if (
    spec.inference.correction === 'maxt-fwe' &&
    spec.inference.permutations === 0
  ) {
    issues.push('Choose a permutation count for max-T correction.')
  }
  return issues
}

/**
 * The zod schema of spec v1. Structural rules come from the schema; the
 * cross-field rules (`specIssues`) run as one refinement so each issue reads
 * as one actionable sentence.
 */
export const groupAnalysisSpecSchema: z.ZodType<GroupAnalysisSpec> = z
  .strictObject({
    schema: z.literal(GROUP_ANALYSIS_SPEC_SCHEMA),
    schemaVersion: z.literal(1),
    analysis: z.enum(['group-comparison', 'association', 'brain-age']),
    measures: z
      .array(
        z
          .string()
          .max(96)
          .refine((id) => isMeasureIdV1(id), {
            message: 'Use valid measure IDs.',
          }),
      )
      .min(1)
      .max(MAX_MEASURES),
    contrast: contrastSchema,
    covariates: z.strictObject({
      age: variableRefSchema.nullable(),
      sex: variableRefSchema.nullable(),
      etiv: z.enum(['extensive', 'all', 'none']),
      extra: z.array(variableRefSchema).max(MAX_EXTRA_COVARIATES),
      centering: z.literal('sample-mean'),
    }),
    inclusion: z.strictObject({
      qc: z.enum(['non-failed', 'passed', 'all']),
      registration: z.enum(['set-missing', 'exclude-subject', 'keep']),
      outliers: z.enum(['keep', 'set-missing', 'exclude-subject']),
    }),
    inference: z.strictObject({
      sidedness: z.enum(['two-sided', 'lower', 'higher']),
      correction: z.enum(['maxt-fwe', 'holm', 'bonferroni', 'bh-fdr', 'none']),
      family: z.enum(['selected', 'per-family']),
      alpha: z.number().min(0.001).max(0.2),
      permutations: z.union([
        z.literal(0),
        z.literal(1000),
        z.literal(5000),
        z.literal(10000),
      ]),
      seed: z.number().int().min(0).max(4_294_967_295),
    }),
  })
  .superRefine((spec, ctx) => {
    for (const message of specIssues(spec)) {
      ctx.addIssue({ code: 'custom', message })
    }
  })

/** The outcome of validating a draft specification. */
export type SpecValidation =
  | { ok: true; spec: GroupAnalysisSpec }
  | { ok: false; errors: string[] }

/**
 * Validate a draft specification and collect every actionable error.
 *
 * @returns The typed specification or the error sentences.
 */
export function validateGroupAnalysisSpec(value: unknown): SpecValidation {
  const parsed = groupAnalysisSpecSchema.safeParse(value)
  if (parsed.success) return { ok: true, spec: parsed.data }
  const errors = parsed.error.issues.map((issue) =>
    issue.code === 'custom'
      ? issue.message
      : `Correct the analysis field ${issue.path.join('.') || 'root'}.`,
  )
  return { ok: false, errors: [...new Set(errors)] }
}

/**
 * Validate a specification at a trust boundary.
 *
 * @throws TypeError naming the first problem.
 */
export function parseGroupAnalysisSpec(value: unknown): GroupAnalysisSpec {
  const result = validateGroupAnalysisSpec(value)
  if (!result.ok) throw new TypeError(result.errors[0])
  return result.spec
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  )
}

/**
 * Serialize a specification canonically: measures, group levels, and
 * included groups sorted; object keys sorted; no whitespace. The sidecar's
 * `spec_digest` is the SHA-256 of these UTF-8 bytes. A spec v2 follows the
 * v2 rules (`canonicalSpecV2Json`).
 */
export function canonicalSpecJson(spec: AnyGroupAnalysisSpec): string {
  if (spec.schemaVersion === 2) return canonicalSpecV2Json(spec)
  const sortGrouping = (grouping: GroupingSpec | null) =>
    grouping && {
      ...grouping,
      groups: grouping.groups.map((group) => ({
        ...group,
        levels: [...group.levels].sort(),
      })),
    }
  const contrast: AnalysisContrast =
    spec.contrast.type === 'groups'
      ? { ...spec.contrast, grouping: sortGrouping(spec.contrast.grouping)! }
      : {
          ...spec.contrast,
          grouping: sortGrouping(spec.contrast.grouping),
          includedGroups: [...spec.contrast.includedGroups].sort(),
        }
  return JSON.stringify(
    sortKeys({ ...spec, measures: [...spec.measures].sort(), contrast }),
  )
}

// -- Specification (spec v2) --------------------------------------------------

/**
 * The design scope: compare groups (`between`), or run tests inside one
 * population such as SCI (`within`).
 */
export type AnalysisScope = 'between' | 'within'

/** The IDs of imported variable tables. */
export const VARIABLE_TABLE_ID = /^var-[a-f0-9]{16}$/
/** The IDs of derived variables. */
export const DERIVED_VARIABLE_ID = /^dv-[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
/** The IDs of the tests in one specification. */
export const ANALYSIS_TEST_ID = /^[a-z][a-z0-9-]{0,31}$/

const MAX_SUBSET_FILTERS = 8
const MAX_DERIVED = 16
const MAX_DERIVED_INPUTS = 8
const MAX_BIN_CUTS = 16
const MAX_TESTS = 16
const MAX_TEST_COVARIATES = 4

/**
 * One variable in spec v2: a registry field or metadata CSV column (as in
 * v1), a column of an imported variables table, a derived variable, or a
 * measure used as a covariate (for example the whole brainstem).
 */
export type VariableRefV2 =
  | VariableRef
  | { source: 'imported'; table: string; column: string }
  | { source: 'derived'; column: string }
  | { source: 'measure'; column: string }

/** The groups built from one variable's levels (spec v2 variables). */
export interface GroupingSpecV2 {
  variable: VariableRefV2
  groups: GroupDefinition[]
}

/** The population a within-group design tests inside. */
export interface PopulationSpec {
  grouping: GroupingSpecV2
  /** The group labels that make up the population. */
  groups: string[]
}

/** Keep the listed levels of a categorical variable. */
export interface LevelKeep {
  levels: string[]
}
/** Keep a numeric range; a null bound is open. */
export interface RangeKeep {
  min: number | null
  max: number | null
}
/** One subset filter: the rows it keeps. */
export interface SubsetFilter {
  variable: VariableRefV2
  keep: LevelKeep | RangeKeep
}

/** The design: its scope, population, and subset filters. */
export interface DesignSpec {
  scope: AnalysisScope
  /** Required for `within`; null for `between`. */
  population: PopulationSpec | null
  subset: SubsetFilter[]
}

/** How a derived variable is computed. */
export type DerivedOp = 'sum' | 'difference' | 'log1p' | 'bins'

/**
 * One derived variable. `sum` takes 2 to 8 inputs, `difference` two (first
 * minus second), `log1p` and `bins` one. `bins` cuts at strictly increasing
 * `cuts` (left-closed intervals) and names the bins by `labels`, one more
 * than the cuts, or by default names when `labels` is empty. A derived input
 * refers only to derived variables listed before it, so there are no cycles.
 */
export interface DerivedVariable {
  id: string
  label: string
  op: DerivedOp
  inputs: VariableRefV2[]
  /** Empty arrays unless the operation is `bins`. */
  params: { cuts: number[]; labels: string[] }
}

/**
 * The default names of `bins` (`default_bin_labels` in `dataset_v2.py`):
 * left-closed bins `<c1`, `c1 to <c2`, ..., `>=ck`, each cut in its
 * ECMAScript number form.
 *
 * @param cuts - The cut points, strictly increasing.
 * @returns One label per bin, one more than the cuts.
 * @example
 * defaultBinLabels([30, 45]) // ['<30', '30 to <45', '>=45']
 */
export function defaultBinLabels(cuts: readonly number[]): string[] {
  const text = cuts.map((cut) => String(cut))
  if (text.length === 0) return []
  return [
    `<${text[0]}`,
    ...text.slice(1).map((high, index) => `${text[index]} to <${high}`),
    `>=${text[text.length - 1]}`,
  ]
}

/** The test kinds. */
export type AnalysisTestKind =
  | 'two-group'
  | 'omnibus'
  | 'association'
  | 'interaction'
/** The pairwise comparisons after an omnibus test. */
export type PairwiseMode = 'all-pairs' | 'versus-reference' | 'none'
/**
 * How pairwise comparisons are corrected: one family over pairs x measures
 * (`pooled`, the PALM -corrcon analog) or one family per pair.
 */
export type PairwiseFamily = 'pooled' | 'per-pair'
/** A transform of a tested or moderating numeric variable. */
export type VariableTransform = 'none' | 'log1p' | 'standardize'

/** The grouping factor of a test. */
export interface TestFactor {
  grouping: GroupingSpecV2
  /** The focal group of a two-group test; null otherwise. */
  focal: string | null
  /** The reference group (the baseline of every group indicator). */
  reference: string
  model: GroupModel
}

/** A tested or moderating variable with its transform. */
export interface TestVariable {
  ref: VariableRefV2
  transform: VariableTransform
}

/**
 * One test. Every test shares the covariates and inclusion rules and adds
 * up to four `extraCovariates`.
 *
 * - `two-group`: `factor` with `focal` and `reference`.
 * - `omnibus`: `factor` with three or more groups, `focal` null, then
 *   `pairwise` comparisons.
 * - `association`: `variable`; `factor` only when `adjustForGroup`.
 * - `interaction`: `factor` x `moderator` (slope differences for a numeric
 *   moderator, a group-by-level interaction for a categorical one).
 *
 * `inFamily` false keeps the test outside the correction family (a
 * sensitivity row with no corrected p).
 */
export interface AnalysisTest {
  id: string
  label: string
  kind: AnalysisTestKind
  factor: TestFactor | null
  pairwise: PairwiseMode
  pairwiseFamily: PairwiseFamily
  variable: TestVariable | null
  moderator: TestVariable | null
  adjustForGroup: boolean
  inFamily: boolean
  extraCovariates: VariableRefV2[]
}

/** Rerun every test per stratum, optionally with a heterogeneity test. */
export interface StratifySpec {
  grouping: GroupingSpecV2
  heterogeneity: boolean
}

/** The head-size covariate. */
export type HeadSizeSource = 'etiv' | 'stiv' | 'synthseg-tiv' | 'none'

/** The model covariates (spec v2). */
export interface CovariateSpecV2 {
  age: VariableRefV2 | null
  sex: VariableRefV2 | null
  headSize: { source: HeadSizeSource; rule: 'extensive' | 'all' }
  extra: VariableRefV2[]
  centering: 'sample-mean'
}

/** The inclusion rules (spec v2): v1's rules and the smallest cell size. */
export interface InclusionSpecV2 extends InclusionSpec {
  /** The smallest group or cell a test may model, 2 to 20 (default 3). */
  minCellN: number
}

/** The correction family (spec v2). */
export type CorrectionFamilyV2 =
  | 'all-tests'
  | 'per-test'
  | 'per-measure-family'
  | 'per-test-and-measure-family'

/** The inference settings (spec v2). */
export interface InferenceSpecV2 {
  sidedness: Sidedness
  correction: Correction
  family: CorrectionFamilyV2
  /** Mark pairwise rows whose omnibus test was not significant. */
  omnibusGate: boolean
  alpha: number
  permutations: PermutationCount
  seed: number
}

/** One complete analysis specification (spec v2). */
export interface GroupAnalysisSpecV2 {
  schema: typeof GROUP_ANALYSIS_SPEC_SCHEMA
  schemaVersion: 2
  design: DesignSpec
  variables: { derived: DerivedVariable[] }
  tests: AnalysisTest[]
  stratify: StratifySpec | null
  measures: string[]
  covariates: CovariateSpecV2
  inclusion: InclusionSpecV2
  inference: InferenceSpecV2
}

/** The spec v1 name the v1 panel uses. */
export type GroupAnalysisSpecV1 = GroupAnalysisSpec
/** Any stored or accepted specification. */
export type AnyGroupAnalysisSpec = GroupAnalysisSpec | GroupAnalysisSpecV2

const variableRefV2Schema = z.union([
  variableRefSchema,
  z.strictObject({
    source: z.literal('imported'),
    table: z.string().regex(VARIABLE_TABLE_ID),
    column: printable(128),
  }),
  z.strictObject({
    source: z.literal('derived'),
    column: z.string().regex(DERIVED_VARIABLE_ID),
  }),
  z.strictObject({
    source: z.literal('measure'),
    column: z
      .string()
      .max(MAX_MEASURE_ID_LENGTH)
      .refine((id) => parseMeasureId(id) !== null, {
        message: 'Use valid measure IDs.',
      }),
  }),
])

const groupingV2Schema = z.strictObject({
  variable: variableRefV2Schema,
  groups: z
    .array(
      z.strictObject({
        label: printable(64),
        levels: z.array(printable(128)).min(1).max(MAX_LEVELS),
      }),
    )
    .min(1)
    .max(MAX_GROUPS),
})

const finiteNumber = z.number().finite()
const testVariableSchema = z.strictObject({
  ref: variableRefV2Schema,
  transform: z.enum(['none', 'log1p', 'standardize']),
})

const refKeyV2 = (ref: VariableRefV2): string =>
  ref.source === 'imported'
    ? `imported\u0000${ref.table}\u0000${ref.column}`
    : `${ref.source}\u0000${ref.column}`

function groupingIssues(grouping: GroupingSpecV2, issues: string[]): string[] {
  const labels = grouping.groups.map((group) => group.label)
  if (new Set(labels).size !== labels.length) {
    issues.push('Give each group a different label.')
  }
  const levels = grouping.groups.flatMap((group) => group.levels)
  if (new Set(levels).size !== levels.length) {
    issues.push('Assign each level to one group only.')
  }
  return labels
}

/**
 * Give the rank of a test's main term as the engine fits it: k - 1 for an
 * omnibus test over k groups, and for a slope difference (k - 1)(m - 1)
 * with a categorical moderator of m levels, else k - 1 (numeric). The spec
 * alone does not know a moderator's levels, so the spec rules pass null and
 * get the smallest rank the test can have; the panel (catalog levels) and
 * the design check (the sample's levels) pass the count.
 *
 * @param moderatorLevels - A categorical moderator's level count, or null for a
 *   numeric or unknown moderator.
 * @returns The rank; above 1 the term is an F test.
 */
export function testRank(
  test: AnalysisTest,
  moderatorLevels: number | null = null,
): number {
  const groups = test.factor?.grouping.groups.length ?? 2
  if (test.kind === 'omnibus') return Math.max(1, groups - 1)
  if (test.kind === 'interaction') {
    const width = moderatorLevels === null ? 1 : moderatorLevels - 1
    return Math.max(1, (groups - 1) * width)
  }
  return 1
}

/**
 * Say whether a test's effect term joins the pooled all-tests family: an
 * interaction forms its own family and a test outside the family has none.
 *
 * @returns True when the term pools with the other tests.
 */
export function poolsInAllTests(test: AnalysisTest): boolean {
  return test.inFamily && test.kind !== 'interaction'
}

function specIssuesV2(spec: GroupAnalysisSpecV2): string[] {
  const issues: string[] = []
  const { design, tests } = spec
  if (new Set(spec.measures).size !== spec.measures.length) {
    issues.push('List each measure once.')
  }
  if (design.scope === 'within' && design.population === null) {
    issues.push('Choose the population for a within-group design.')
  }
  if (design.scope === 'between' && design.population !== null) {
    issues.push('Leave the population empty for a between-groups design.')
  }
  if (design.population) {
    const labels = groupingIssues(design.population.grouping, issues)
    const kept = design.population.groups
    if (
      kept.length === 0 ||
      new Set(kept).size !== kept.length ||
      kept.some((label) => !labels.includes(label))
    ) {
      issues.push(
        'Keep one or more defined groups in the population, each once.',
      )
    }
  }
  const filtered = design.subset.map((filter) => refKeyV2(filter.variable))
  if (new Set(filtered).size !== filtered.length) {
    issues.push('Filter each variable once.')
  }
  for (const filter of design.subset) {
    if ('min' in filter.keep) {
      const { min, max } = filter.keep
      if (min === null && max === null) {
        issues.push('Give each numeric subset filter a minimum or a maximum.')
      } else if (min !== null && max !== null && min > max) {
        issues.push(
          'Give each subset filter a minimum no larger than its maximum.',
        )
      }
    }
  }
  const derivedIds = spec.variables.derived.map((item) => item.id)
  if (new Set(derivedIds).size !== derivedIds.length) {
    issues.push('Give each derived variable a different ID.')
  }
  const arity: Record<DerivedOp, [number, number]> = {
    sum: [2, MAX_DERIVED_INPUTS],
    difference: [2, 2],
    log1p: [1, 1],
    bins: [1, 1],
  }
  spec.variables.derived.forEach((item, index) => {
    const [low, high] = arity[item.op]
    if (item.inputs.length < low || item.inputs.length > high) {
      issues.push('Give each derived variable the inputs its operation takes.')
    }
    const earlier = new Set(derivedIds.slice(0, index))
    if (
      item.inputs.some(
        (ref) => ref.source === 'derived' && !earlier.has(ref.column),
      )
    ) {
      issues.push('Refer only to derived variables listed before this one.')
    }
    const { cuts, labels } = item.params
    if (item.op === 'bins') {
      if (
        cuts.length === 0 ||
        cuts.some((cut, i) => i > 0 && cut <= cuts[i - 1]!)
      ) {
        issues.push('Give the bin cut points in increasing order.')
      }
      if (labels.length !== 0 && labels.length !== cuts.length + 1) {
        issues.push('Label every bin or none.')
      }
    } else if (cuts.length > 0 || labels.length > 0) {
      issues.push('Set cut points and labels only for bins.')
    }
  })
  const used: VariableRefV2[] = [
    ...(design.population ? [design.population.grouping.variable] : []),
    ...design.subset.map((filter) => filter.variable),
    ...(spec.stratify ? [spec.stratify.grouping.variable] : []),
    ...[spec.covariates.age, spec.covariates.sex].filter(
      (ref): ref is VariableRefV2 => ref !== null,
    ),
    ...spec.covariates.extra,
    ...tests.flatMap((test) => [
      ...(test.factor ? [test.factor.grouping.variable] : []),
      ...(test.variable ? [test.variable.ref] : []),
      ...(test.moderator ? [test.moderator.ref] : []),
      ...test.extraCovariates,
    ]),
  ]
  if (
    used.some(
      (ref) => ref.source === 'derived' && !derivedIds.includes(ref.column),
    )
  ) {
    issues.push('Define every derived variable the analysis uses.')
  }
  const testIds = tests.map((test) => test.id)
  if (new Set(testIds).size !== testIds.length) {
    issues.push('Give each test a different ID.')
  }
  const covariates = [
    ...[spec.covariates.age, spec.covariates.sex].filter(
      (ref): ref is VariableRefV2 => ref !== null,
    ),
    ...spec.covariates.extra,
  ].map(refKeyV2)
  for (const test of tests) {
    const factor = test.factor
    const grouped = test.kind !== 'association' || test.adjustForGroup
    if (grouped && factor === null) {
      issues.push('Choose the grouping of each group test.')
    }
    if (!grouped && factor !== null) {
      issues.push(
        'Choose a grouping for an association test only to adjust for group.',
      )
    }
    if (factor) {
      const labels = groupingIssues(factor.grouping, issues)
      const groups = factor.grouping.groups.length
      if (!labels.includes(factor.reference)) {
        issues.push('Choose a defined group as the reference group.')
      }
      if (test.kind === 'two-group') {
        if (factor.focal === null) {
          issues.push('Choose a focal group for each two-group test.')
        } else if (!labels.includes(factor.focal)) {
          issues.push('Choose a defined group as the focal group.')
        } else if (factor.focal === factor.reference) {
          issues.push('Choose two different groups to compare.')
        }
      } else if (factor.focal !== null) {
        issues.push('Choose a focal group only for a two-group test.')
      }
      if (test.kind === 'omnibus' && groups < 3) {
        issues.push('Define three or more groups for an omnibus test.')
      } else if (groups < 2) {
        issues.push('Define at least two groups to compare.')
      }
    }
    if (test.kind !== 'omnibus' && test.pairwise !== 'none') {
      issues.push('Choose pairwise comparisons only for an omnibus test.')
    }
    if ((test.kind === 'association') !== (test.variable !== null)) {
      issues.push('Choose a tested variable for each association test only.')
    }
    if ((test.kind === 'interaction') !== (test.moderator !== null)) {
      issues.push('Choose a moderator for each slope-difference test only.')
    }
    if (test.adjustForGroup && test.kind !== 'association') {
      issues.push('Adjust for group only in an association test.')
    }
    const extra = test.extraCovariates.map(refKeyV2)
    if (
      new Set(extra).size !== extra.length ||
      extra.some((key) => covariates.includes(key))
    ) {
      issues.push('Add each covariate once.')
    }
    const tested = [
      ...(factor ? [factor.grouping.variable] : []),
      ...(test.variable ? [test.variable.ref] : []),
      ...(test.moderator ? [test.moderator.ref] : []),
    ].map(refKeyV2)
    if (tested.some((key) => covariates.includes(key) || extra.includes(key))) {
      issues.push('Do not adjust for the tested variable.')
    }
  }
  if (tests.length > 0 && !tests.some((test) => test.inFamily)) {
    issues.push('Keep one or more tests in the correction family.')
  }
  if (spec.stratify) {
    groupingIssues(spec.stratify.grouping, issues)
    if (spec.stratify.grouping.groups.length < 2) {
      issues.push('Define two or more strata.')
    }
  }
  if (new Set(covariates).size !== covariates.length) {
    issues.push('Add each covariate once.')
  }
  const { inference } = spec
  if (inference.correction === 'maxt-fwe' && inference.permutations === 0) {
    issues.push('Choose a permutation count for max-T correction.')
  }
  if (
    inference.sidedness !== 'two-sided' &&
    tests.some((test) => testRank(test) > 1)
  ) {
    issues.push('Choose a two-sided test: an F test has no direction.')
  }
  if (
    inference.correction === 'maxt-fwe' &&
    inference.family === 'all-tests' &&
    new Set(tests.filter(poolsInAllTests).map((test) => testRank(test))).size >
      1
  ) {
    issues.push(
      'Correct each test separately, or choose Holm, Bonferroni, or BH-FDR to correct t and F tests together.',
    )
  }
  return issues
}

/**
 * The zod schema of spec v2. As for v1, structural rules come from the
 * schema and the cross-field rules run as one refinement.
 */
export const groupAnalysisSpecV2Schema: z.ZodType<GroupAnalysisSpecV2> = z
  .strictObject({
    schema: z.literal(GROUP_ANALYSIS_SPEC_SCHEMA),
    schemaVersion: z.literal(2),
    design: z.strictObject({
      scope: z.enum(['between', 'within']),
      population: z
        .strictObject({
          grouping: groupingV2Schema,
          groups: z.array(printable(64)).max(MAX_GROUPS),
        })
        .nullable(),
      subset: z
        .array(
          z.strictObject({
            variable: variableRefV2Schema,
            keep: z.union([
              z.strictObject({
                levels: z.array(printable(128)).min(1).max(MAX_LEVELS),
              }),
              z.strictObject({
                min: finiteNumber.nullable(),
                max: finiteNumber.nullable(),
              }),
            ]),
          }),
        )
        .max(MAX_SUBSET_FILTERS),
    }),
    variables: z.strictObject({
      derived: z
        .array(
          z.strictObject({
            id: z.string().regex(DERIVED_VARIABLE_ID),
            label: printable(64),
            op: z.enum(['sum', 'difference', 'log1p', 'bins']),
            inputs: z.array(variableRefV2Schema).min(1).max(MAX_DERIVED_INPUTS),
            params: z.strictObject({
              cuts: z.array(finiteNumber).max(MAX_BIN_CUTS),
              labels: z.array(printable(64)).max(MAX_BIN_CUTS + 1),
            }),
          }),
        )
        .max(MAX_DERIVED),
    }),
    tests: z
      .array(
        z.strictObject({
          id: z.string().regex(ANALYSIS_TEST_ID),
          label: printable(64),
          kind: z.enum(['two-group', 'omnibus', 'association', 'interaction']),
          factor: z
            .strictObject({
              grouping: groupingV2Schema,
              focal: printable(64).nullable(),
              reference: printable(64),
              model: z.enum(['all-groups', 'compared-groups']),
            })
            .nullable(),
          pairwise: z.enum(['all-pairs', 'versus-reference', 'none']),
          pairwiseFamily: z.enum(['pooled', 'per-pair']),
          variable: testVariableSchema.nullable(),
          moderator: testVariableSchema.nullable(),
          adjustForGroup: z.boolean(),
          inFamily: z.boolean(),
          extraCovariates: z
            .array(variableRefV2Schema)
            .max(MAX_TEST_COVARIATES),
        }),
      )
      .min(1)
      .max(MAX_TESTS),
    stratify: z
      .strictObject({
        grouping: groupingV2Schema,
        heterogeneity: z.boolean(),
      })
      .nullable(),
    measures: z
      .array(
        z
          .string()
          .max(MAX_MEASURE_ID_LENGTH)
          .refine((id) => parseMeasureId(id) !== null, {
            message: 'Use valid measure IDs.',
          }),
      )
      .min(1)
      .max(MAX_MEASURES_V2),
    covariates: z.strictObject({
      age: variableRefV2Schema.nullable(),
      sex: variableRefV2Schema.nullable(),
      headSize: z.strictObject({
        source: z.enum(['etiv', 'stiv', 'synthseg-tiv', 'none']),
        rule: z.enum(['extensive', 'all']),
      }),
      extra: z.array(variableRefV2Schema).max(MAX_EXTRA_COVARIATES),
      centering: z.literal('sample-mean'),
    }),
    inclusion: z.strictObject({
      qc: z.enum(['non-failed', 'passed', 'all']),
      registration: z.enum(['set-missing', 'exclude-subject', 'keep']),
      outliers: z.enum(['keep', 'set-missing', 'exclude-subject']),
      minCellN: z.number().int().min(2).max(20),
    }),
    inference: z.strictObject({
      sidedness: z.enum(['two-sided', 'lower', 'higher']),
      correction: z.enum(['maxt-fwe', 'holm', 'bonferroni', 'bh-fdr', 'none']),
      family: z.enum([
        'all-tests',
        'per-test',
        'per-measure-family',
        'per-test-and-measure-family',
      ]),
      omnibusGate: z.boolean(),
      alpha: z.number().min(0.001).max(0.2),
      permutations: z.union([
        z.literal(0),
        z.literal(1000),
        z.literal(5000),
        z.literal(10000),
      ]),
      seed: z.number().int().min(0).max(4_294_967_295),
    }),
  })
  .superRefine((spec, ctx) => {
    for (const message of specIssuesV2(spec as GroupAnalysisSpecV2)) {
      ctx.addIssue({ code: 'custom', message })
    }
  }) as z.ZodType<GroupAnalysisSpecV2>

/** The outcome of validating a draft specification of either version. */
export type AnySpecValidation =
  | { ok: true; spec: AnyGroupAnalysisSpec }
  | { ok: false; errors: string[] }

function issueSentences(error: z.ZodError): string[] {
  const errors = error.issues.map((issue) =>
    issue.code === 'custom'
      ? issue.message
      : `Correct the analysis field ${issue.path.join('.') || 'root'}.`,
  )
  return [...new Set(errors)]
}

/**
 * Validate a draft spec v2 and collect every actionable error.
 *
 * @returns The typed specification or the error sentences.
 */
export function validateGroupAnalysisSpecV2(
  value: unknown,
): { ok: true; spec: GroupAnalysisSpecV2 } | { ok: false; errors: string[] } {
  const parsed = groupAnalysisSpecV2Schema.safeParse(value)
  if (parsed.success) return { ok: true, spec: parsed.data }
  return { ok: false, errors: issueSentences(parsed.error) }
}

/**
 * Validate a specification of either version, chosen by `schemaVersion`.
 *
 * @returns The typed specification or the error sentences.
 */
export function validateAnyGroupAnalysisSpec(
  value: unknown,
): AnySpecValidation {
  const version =
    value !== null && typeof value === 'object'
      ? (value as { schemaVersion?: unknown }).schemaVersion
      : undefined
  return version === 2
    ? validateGroupAnalysisSpecV2(value)
    : validateGroupAnalysisSpec(value)
}

/**
 * Validate a specification of either version at a trust boundary. Stored
 * v1 specifications and results keep their v1 form and digest.
 *
 * @throws TypeError naming the first problem.
 */
export function parseAnyGroupAnalysisSpec(
  value: unknown,
): AnyGroupAnalysisSpec {
  const result = validateAnyGroupAnalysisSpec(value)
  if (!result.ok) throw new TypeError(result.errors[0])
  return result.spec
}

/**
 * Express a spec v1 as spec v2 (`upgrade_v1` in the sidecar). The v2
 * engine reproduces a v1 result from the upgraded spec; the upgraded spec
 * has its own digest, and a stored v1 result keeps its v1 spec and digest.
 *
 * - A group comparison or brain-age analysis becomes one two-group test
 *   `t1` labeled `<focal> vs <reference>`.
 * - An association becomes one association test `t1` (transform none); its
 *   included groups become a subset filter on the grouping variable, and
 *   `adjustForGroup` keeps a factor of the included groups, the first as
 *   reference.
 * - eTIV `extensive`/`all`/`none` becomes head size `etiv` with that rule
 *   (`none` keeps `extensive`); family `selected` becomes `all-tests` and
 *   `per-family` becomes `per-measure-family`; the smallest cell is 2, so no
 *   analysis v1 computed is blocked.
 */
export function upgradeGroupAnalysisSpecV1(
  spec: GroupAnalysisSpec,
): GroupAnalysisSpecV2 {
  const base: Omit<
    AnalysisTest,
    'id' | 'label' | 'kind' | 'factor' | 'variable'
  > = {
    pairwise: 'none',
    pairwiseFamily: 'pooled',
    moderator: null,
    adjustForGroup: false,
    inFamily: true,
    extraCovariates: [],
  }
  const subset: SubsetFilter[] = []
  let test: AnalysisTest
  const { contrast } = spec
  if (contrast.type === 'groups') {
    test = {
      ...base,
      id: 't1',
      label: `${contrast.focal} vs ${contrast.reference}`.slice(0, 64).trim(),
      kind: 'two-group',
      factor: {
        grouping: structuredClone(contrast.grouping),
        focal: contrast.focal,
        reference: contrast.reference,
        model: contrast.model,
      },
      variable: null,
    }
  } else {
    const grouping = contrast.grouping
    const included = grouping
      ? grouping.groups.filter((group) =>
          contrast.includedGroups.includes(group.label),
        )
      : []
    if (grouping) {
      subset.push({
        variable: { ...grouping.variable },
        keep: { levels: included.flatMap((group) => [...group.levels]) },
      })
    }
    test = {
      ...base,
      id: 't1',
      label: `Association with ${contrast.variable.column}`.slice(0, 64).trim(),
      kind: 'association',
      factor:
        grouping && contrast.adjustForGroup
          ? {
              grouping: {
                variable: { ...grouping.variable },
                groups: structuredClone(included),
              },
              focal: null,
              reference: included[0]!.label,
              model: 'all-groups',
            }
          : null,
      variable: { ref: { ...contrast.variable }, transform: 'none' },
      adjustForGroup: contrast.adjustForGroup,
    }
  }
  return {
    schema: GROUP_ANALYSIS_SPEC_SCHEMA,
    schemaVersion: 2,
    design: { scope: 'between', population: null, subset },
    variables: { derived: [] },
    tests: [test],
    stratify: null,
    measures: [...spec.measures],
    covariates: {
      age: spec.covariates.age && { ...spec.covariates.age },
      sex: spec.covariates.sex && { ...spec.covariates.sex },
      headSize: {
        source: spec.covariates.etiv === 'none' ? 'none' : 'etiv',
        rule: spec.covariates.etiv === 'all' ? 'all' : 'extensive',
      },
      extra: spec.covariates.extra.map((ref) => ({ ...ref })),
      centering: 'sample-mean',
    },
    inclusion: { ...spec.inclusion, minCellN: 2 },
    inference: {
      sidedness: spec.inference.sidedness,
      correction: spec.inference.correction,
      family:
        spec.inference.family === 'selected'
          ? 'all-tests'
          : 'per-measure-family',
      omnibusGate: false,
      alpha: spec.inference.alpha,
      permutations: spec.inference.permutations,
      seed: spec.inference.seed,
    },
  }
}

function sortGroupingLevels<T extends { groups: GroupDefinition[] }>(
  grouping: T,
): T {
  return {
    ...grouping,
    groups: grouping.groups.map((group) => ({
      ...group,
      levels: [...group.levels].sort(),
    })),
  }
}

/**
 * Serialize a spec v2 canonically: measures, group levels, population
 * groups, and subset levels sorted; tests, derived variables, groups, and
 * covariates keep their order; object keys sorted; no whitespace.
 */
function canonicalSpecV2Json(spec: GroupAnalysisSpecV2): string {
  const population = spec.design.population && {
    grouping: sortGroupingLevels(spec.design.population.grouping),
    groups: [...spec.design.population.groups].sort(),
  }
  return JSON.stringify(
    sortKeys({
      ...spec,
      measures: [...spec.measures].sort(),
      design: {
        ...spec.design,
        population,
        subset: spec.design.subset.map((filter) =>
          'levels' in filter.keep
            ? { ...filter, keep: { levels: [...filter.keep.levels].sort() } }
            : filter,
        ),
      },
      tests: spec.tests.map((test) => ({
        ...test,
        factor: test.factor && {
          ...test.factor,
          grouping: sortGroupingLevels(test.factor.grouping),
        },
      })),
      stratify: spec.stratify && {
        ...spec.stratify,
        grouping: sortGroupingLevels(spec.stratify.grouping),
      },
    }),
  )
}

// -- RPC results -------------------------------------------------------------

/** A pipeline stage's currency as the renderer judged it at Compute. */
export type AnalysisStageState = 'current' | 'outdated' | 'unknown'

/** The reconstruction stage's currency, with its out-of-date subjects. */
export interface AnalysisReconCurrency {
  state: AnalysisStageState
  /** The subjects whose reconstruction is out of date (at most 5000). */
  outdatedSubjectIds: string[]
}

/**
 * The currency of the stages whose outputs feed the analysis (v2): the
 * aggregate tables, Brain-PAD, and the per-subject reconstructions whose
 * stats files and labels tier A and B measures read. A v1 record has no
 * `recon` and still parses.
 */
export interface AnalysisStageCurrency {
  aggregate: AnalysisStageState
  pybrainage: AnalysisStageState
  recon?: AnalysisReconCurrency
}

/** One input table the analysis reads (the v1 sources). */
export type AnalysisInputSourceV1 =
  | 'dk-all-stats'
  | 'cortical-thickness'
  | 'icv'
  | 'brainage'
  | 'metadata-csv'
  | 'age-csv'
  | 'clinical-csv'
  | 'outliers'

/**
 * One input the analysis reads: a v1 table, or (v2) one combined source
 * digest: `stats:<sourceId>` (every subject's stats file of one tier A
 * source, for example `stats:a2009s`), `labels:<atlasId>` (the labeling
 * cache of one tier B atlas), `atlas:<atlasId>` (an added atlas's files),
 * or `variables:<tableId>` (an imported variables table).
 */
export type AnalysisInputSource =
  | AnalysisInputSourceV1
  | `stats:${string}`
  | `labels:${string}`
  | `atlas:${string}`
  | `variables:${string}`

/** The v2 combined-source grammar of `AnalysisInputSource`. */
export const ANALYSIS_INPUT_SOURCE_V2 =
  /^(?:stats|labels|atlas):[a-z][a-z0-9-]{1,47}$|^variables:var-[a-f0-9]{16}$/

/** The state and digest of one input table. */
export interface AnalysisInputFile {
  source: AnalysisInputSource
  present: boolean
  /** Why the table cannot be read, when it cannot. */
  reason: string | null
  sha256: string | null
  bytes: number | null
}

/**
 * The pipeline stage a measure's values depend on: the aggregate tables,
 * Brain-PAD, each subject's reconstruction (tier A stats files), or the
 * labeling cache (tier B).
 */
export type AnalysisMeasureStage =
  | 'aggregate'
  | 'pybrainage'
  | 'recon'
  | 'labeling'

/** One analyzable measure in the catalog. */
export interface AnalysisMeasure {
  measureId: string
  source: MeasureSource
  family: string
  extensive: boolean
  stage: AnalysisMeasureStage
  available: boolean
  unavailableReason: string | null
}

/** One grouping or covariate variable with its observed values. */
export interface AnalysisVariable {
  ref: VariableRef
  kind: 'categorical' | 'numeric'
  /** Subjects with a value. */
  n: number
  /** The observed levels of a categorical variable; empty for numeric. */
  levels: { value: string; n: number }[]
}

/** One column of an imported variables table, with its observed values. */
export interface AnalysisVariableColumn {
  column: string
  kind: 'categorical' | 'numeric'
  /** Project subjects with a value. */
  n: number
  levels: { value: string; n: number }[]
}

/**
 * One imported variables table (`groupAnalysis.importVariables`), copied to
 * `.supraspina/analysis/variables/<tableId>.csv` and listed in `tables.json`.
 * Its columns are variables `{source: 'imported', table, column}`.
 */
export interface AnalysisVariableTable {
  tableId: string
  name: string
  /** The column that holds subject IDs. */
  idColumn: string
  sha256: string
  importedAt: string
  rows: number
  /** Table rows whose subject ID the project does not know. */
  unmatched: number
  columns: AnalysisVariableColumn[]
}

/** The result of `groupAnalysis.catalog`. */
export interface GroupAnalysisCatalog {
  configRevision: number
  measures: AnalysisMeasure[]
  variables: AnalysisVariable[]
  /** The imported variables tables (spec v2). */
  variableTables: AnalysisVariableTable[]
  inputs: AnalysisInputFile[]
}

/**
 * Why a subject is out of an analysis. The v2 reasons: outside the
 * within-group population, removed by a subset filter, or missing a value
 * every test needs (a value one test needs leaves only that test).
 */
export type AnalysisExclusionReason =
  | 'config-excluded'
  | 'qc-failed'
  | 'qc-not-passed'
  | 'no-group'
  | 'not-compared'
  | 'missing-covariate'
  | 'registration-flagged'
  | 'outlier'
  | 'no-measures'
  | 'not-in-population'
  | 'subset-filtered'
  | 'missing-variable'

/** One subject's place in a resolved sample. */
export interface AnalysisSubjectInclusion {
  subjectId: string
  group: string | null
  sourceLabel: string | null
  included: boolean
  reason: AnalysisExclusionReason | null
  /** Hemispheres whose cortical measures are set missing. */
  missingHemispheres: ('lh' | 'rh')[]
}

/** The subject count of one group. */
export interface AnalysisGroupCount {
  label: string
  n: number
}

/** A measure left out of an analysis, and why. */
export interface AnalysisSkippedMeasure {
  measureId: string
  reason: string
}

/** How much a design-check finding stops a compute. */
export type DesignIssueSeverity = 'blocking' | 'strong-warning' | 'warning'

/** The kinds of design-check findings (`design_check.py`). */
export type DesignIssueCode =
  | 'min-cell'
  | 'small-cell'
  | 'residual-df'
  | 'collinear'
  | 'vif'
  | 'confounded'
  | 'covariate-undefined'
  | 'invalid-combination'
  | 'log1p-domain'
  | 'subset-empties-group'
  | 'moderator-cells'
  | 'test-availability'
  | 'site-confounded'

/**
 * A change to the draft that resolves a design-check finding: leave out one
 * level of a variable (a subset filter that drops it), or add a variable
 * as a covariate. The site check offers both for a site that holds one group.
 */
export type DesignFix =
  | { kind: 'drop-level'; variable: VariableRefV2; level: string }
  | { kind: 'add-covariate'; variable: VariableRefV2 }

/** One design-check finding, as one sentence (facts, or an action). */
export interface DesignIssue {
  code: DesignIssueCode
  severity: DesignIssueSeverity
  /** The test it concerns, or null for the whole design. */
  testId: string | null
  message: string
  /** The draft changes that resolve it, when there are any. */
  fixes?: DesignFix[]
}

/** One test's complete-case sample. */
export interface DesignTestSample {
  testId: string
  n: number
  /** The residual degrees of freedom, or null when the model cannot fit. */
  residualDf: number | null
  /** Subjects left out of this test only, for a missing value. */
  missing: number
}

/** One modeled cell (group, or group x level) of one test. */
export interface DesignCell {
  testId: string
  stratum: string | null
  label: string
  n: number
  female: number | null
  male: number | null
}

/** One variance inflation factor on a test's complete-case sample. */
export interface DesignVif {
  testId: string
  term: string
  vif: number
}

/** A crosstab of two categorical variables with Cramer's V. */
export interface DesignCrosstab {
  testId: string | null
  rowVariable: string
  columnVariable: string
  rows: string[]
  columns: string[]
  /** `counts[row][column]`. */
  counts: number[][]
  cramersV: number | null
}

/**
 * The design check of a spec v2 draft: blocking findings stop Compute,
 * warnings are shown with the disclosure data (per-test samples, cells with
 * sex counts, VIFs, and crosstabs).
 */
export interface DesignCheck {
  /** True when nothing blocks the compute. */
  ok: boolean
  issues: DesignIssue[]
  tests: DesignTestSample[]
  cells: DesignCell[]
  vif: DesignVif[]
  crosstabs: DesignCrosstab[]
}

/** The result of `groupAnalysis.inputs`: a draft's resolved sample. */
export interface GroupAnalysisInputs {
  configRevision: number
  specDigest: string
  subjects: AnalysisSubjectInclusion[]
  groups: AnalysisGroupCount[]
  included: number
  /** True while the registration check has not judged every hemisphere. */
  registrationProvisional: boolean
  inputs: AnalysisInputFile[]
  skippedMeasures: AnalysisSkippedMeasure[]
  /**
   * Facts about the sample no subject row carries, for example an outlier
   * rule that cannot be applied (which makes a result provisional).
   */
  issues: string[]
  /**
   * The design check of a spec v2 draft. A spec v1 gets the site check
   * alone (on test `t1` of its v2 form), or null when no included
   * subject has a site.
   */
  designCheck: DesignCheck | null
}

/** The project's running or last compute. */
export interface GroupAnalysisOperation {
  operationId: string
  state: 'running' | 'done' | 'cancelled' | 'failed'
  phase: 'preparing' | 'fitting' | 'permuting' | 'writing' | null
  completed: number
  total: number
  startedAt: string
  finishedAt: string | null
  message: string | null
  specDigest: string
  /** The stored result, once the compute is done. */
  resultId: string | null
  /**
   * Why each measure was skipped, when a compute failed because no selected
   * measure could be fit (the first 64); absent otherwise.
   */
  skipped?: AnalysisSkippedMeasure[]
}

/** The result of `groupAnalysis.status`. */
export interface GroupAnalysisStatus {
  operation: GroupAnalysisOperation | null
}

/** The result of `groupAnalysis.start`. */
export interface GroupAnalysisStartResult {
  operation: GroupAnalysisOperation
  started: boolean
}

/** The result of `groupAnalysis.cancel`. */
export interface GroupAnalysisCancelResult {
  operationId: string
  stopped: boolean
}

/** One saved specification (spec v1 or v2). */
export interface SavedAnalysisSpec {
  specId: string
  name: string
  spec: AnyGroupAnalysisSpec
  specDigest: string
  updatedAt: string
}

/** One saved ROI set; a locked set is immutable. */
export interface RoiSet {
  setId: string
  name: string
  measures: string[]
  locked: { sha256: string; lockedAt: string } | null
  updatedAt: string
}

/** The saved specifications and ROI sets, with their store revision. */
export interface GroupAnalysisLibrary {
  revision: number
  specs: SavedAnalysisSpec[]
  sets: RoiSet[]
}

/** Why a stored result no longer matches its inputs. */
export type GroupAnalysisStaleCode =
  | 'inputs-changed'
  | 'qc-changed-sample'
  | 'registry-changed'
  | 'registration-changed'
  | 'engine-changed'
  | 'sample-too-small'
  | 'labels-changed'

/** One named stale reason, with the sample change it caused. */
export interface GroupAnalysisStaleReason {
  code: GroupAnalysisStaleCode
  added: number
  removed: number
  /** The changed tables, for `inputs-changed`. */
  sources: AnalysisInputSource[]
}

/** One stored result in the list. */
export interface GroupAnalysisResultSummary {
  resultId: string
  /** The result schema version: 1 (spec v1) or 2 (spec v2, with terms). */
  schemaVersion: 1 | 2
  specId: string | null
  name: string
  /** The v1 analysis kind; null for a v2 result. */
  analysis: AnalysisKind | null
  specDigest: string
  createdAt: string
  measureCount: number
  significantCount: number
  groups: AnalysisGroupCount[]
  provisional: boolean
  /** Exported results are kept past the newest-20 limit. */
  pinned: boolean
  currency: 'current' | 'stale' | 'unknown'
  staleReasons: GroupAnalysisStaleReason[]
}

/** The result of `groupAnalysis.list`. */
export interface GroupAnalysisList extends GroupAnalysisLibrary {
  results: GroupAnalysisResultSummary[]
}

/**
 * One measure's model result. `estimate` is the tested coefficient in the
 * measure's unit (focal minus reference, or the slope per unit of the
 * variable); `d` is the adjusted standardized difference t*sqrt(v_jj) with a
 * noncentral-t 95% CI, null for an association.
 */
export interface GroupAnalysisRow {
  measureId: string
  family: string
  nTotal: number
  nFocal: number | null
  nReference: number | null
  estimate: number
  se: number
  t: number
  df: number
  p: number
  /** The corrected p under the chosen correction; null for `none`. */
  pCorrected: number | null
  significant: boolean
  d: number | null
  dLow: number | null
  dHigh: number | null
  dRawSd: number | null
  partialEta2: number
  /** The adjusted difference as a percentage of the reference mean. */
  pctOfReference: number | null
  /** The HC3 sensitivity p. */
  pHc3: number
  /** The uncorrected permutation p, when permutations ran. */
  pPermutation: number | null
}

/** The result of `groupAnalysis.result`, without per-subject values. */
export interface GroupAnalysisResult {
  schema: typeof GROUP_ANALYSIS_RESULT_SCHEMA
  schemaVersion: 1
  resultId: string
  specId: string | null
  name: string
  spec: GroupAnalysisSpec
  specDigest: string
  createdAt: string
  engine: {
    id: typeof GROUP_ANALYSIS_ENGINE_ID
    rng: typeof GROUP_ANALYSIS_RNG_ID
    productVersion: string
    build: string | null
  }
  provisional: boolean
  stageCurrency: AnalysisStageCurrency
  inputs: AnalysisInputFile[]
  sample: {
    groups: AnalysisGroupCount[]
    included: number
    excluded: { subjectId: string; reason: AnalysisExclusionReason }[]
    /** The sample's issues (see `GroupAnalysisInputs`); older results read []. */
    issues: string[]
  }
  rows: GroupAnalysisRow[]
  skipped: AnalysisSkippedMeasure[]
  resultSha256: string
}

/** One group's model-based adjusted mean with its 95% CI. */
export interface AnalysisGroupMean {
  label: string
  role: 'focal' | 'reference' | 'other'
  n: number
  mean: number
  low: number
  high: number
}

/** One subject's value of one measure. */
export interface AnalysisSubjectValue {
  subjectId: string
  group: string | null
  sourceLabel: string | null
  value: number
  /** The value adjusted to the covariate means. */
  adjusted: number
  /** The tested variable, for an association. */
  x: number | null
}

/** The result of `groupAnalysis.measureDetail`. */
export interface GroupAnalysisMeasureDetail {
  resultId: string
  measureId: string
  row: GroupAnalysisRow
  groupMeans: AnalysisGroupMean[]
  subjects: AnalysisSubjectValue[]
}

// -- Result v2 (terms) ----------------------------------------------------------

/**
 * One term of a v2 result: a two-group or pairwise contrast, an omnibus or
 * interaction F, an association slope, a stratum's rerun, or a
 * heterogeneity test. Each term has its own rows, one per measure.
 */
export interface GroupAnalysisTerm {
  termId: string
  testId: string
  /** `t` for a rank-1 term, `F` otherwise. */
  kind: 't' | 'F'
  rank: number
  /**
   * `effect` is the test's own term, `pairwise` one pair after an omnibus
   * test, and `heterogeneity` the stratum-by-term interaction of a
   * stratified design.
   */
  role: 'effect' | 'pairwise' | 'heterogeneity'
  label: string
  /** The correction family the term's rows belong to; null outside it. */
  family: string | null
  /** The stratum label of a stratified rerun; null for the pooled term. */
  stratum: string | null
  pair: { focal: string; reference: string } | null
  /** The term's row count, for `groupAnalysis.termRows` paging. */
  rowCount: number
}

/**
 * One measure's row of one term. A `t` term fills `estimate`, `se`, and
 * `t` (with `df1` 1); an `F` term fills `F` and leaves them null. `d` is
 * the adjusted standardized difference of a two-group or pairwise term.
 * Every `t` row carries `partialR` = t / sqrt(t^2 + df2) with its Fisher-z
 * 95% CI (se 1 / sqrt(df2 - 1)); `slopePerSd` is an association's slope per
 * SD of the tested variable. `gated` marks a pairwise row whose omnibus
 * test was not significant (the omnibus gate only marks, never changes p).
 * `inFamily` false rows are sensitivity rows with no corrected p.
 */
export interface GroupAnalysisRowV2 {
  termId: string
  measureId: string
  family: string
  nTotal: number
  nFocal: number | null
  nReference: number | null
  estimate: number | null
  se: number | null
  t: number | null
  F: number | null
  df1: number
  df2: number
  p: number
  pCorrected: number | null
  significant: boolean
  d: number | null
  dLow: number | null
  dHigh: number | null
  dRawSd: number | null
  partialEta2: number
  partialR: number | null
  partialRLow: number | null
  partialRHigh: number | null
  slopePerSd: number | null
  pctOfReference: number | null
  pHc3: number | null
  pPermutation: number | null
  gated: boolean
  inFamily: boolean
}

/**
 * The result of `groupAnalysis.result` for a v2 result: the header, every
 * term, and the first term's rows; `groupAnalysis.termRows` pages the rest.
 * The stored record may reach 32 MiB; this payload keeps the 2 MiB cap.
 */
export interface GroupAnalysisResultV2 {
  schema: typeof GROUP_ANALYSIS_RESULT_SCHEMA
  schemaVersion: 2
  resultId: string
  specId: string | null
  name: string
  spec: GroupAnalysisSpecV2
  specDigest: string
  createdAt: string
  engine: {
    id: typeof GROUP_ANALYSIS_ENGINE_ID_V2
    rng: typeof GROUP_ANALYSIS_RNG_ID
    productVersion: string
    build: string | null
  }
  provisional: boolean
  stageCurrency: AnalysisStageCurrency
  inputs: AnalysisInputFile[]
  sample: {
    groups: AnalysisGroupCount[]
    included: number
    excluded: { subjectId: string; reason: AnalysisExclusionReason }[]
    /** The sample's issues (see `GroupAnalysisInputs`). */
    issues: string[]
  }
  terms: GroupAnalysisTerm[]
  /** The rows of `terms[0]`. */
  rows: GroupAnalysisRowV2[]
  skipped: AnalysisSkippedMeasure[]
  resultSha256: string
}

/** A stored result of either schema version. */
export type AnyGroupAnalysisResult = GroupAnalysisResult | GroupAnalysisResultV2

/** The result of `groupAnalysis.termRows`: one page of one term's rows. */
export interface GroupAnalysisTermRows {
  resultId: string
  termId: string
  offset: number
  /** The term's row count. */
  total: number
  rows: GroupAnalysisRowV2[]
  /** The offset of the next page, or null after the last one. */
  nextOffset: number | null
}

/** One fitted line with its 95% band, at 50 evenly spaced x values. */
export interface AnalysisFitLine {
  /** The group of an interaction's per-group line; null for one line. */
  group: string | null
  x: number[]
  y: number[]
  low: number[]
  high: number[]
}

/** One group's simple slope of an interaction, with its 95% CI. */
export interface AnalysisSimpleSlope {
  group: string
  slope: number
  low: number
  high: number
}

/**
 * The result of `groupAnalysis.measureDetail` with a `termId` (v2 results):
 * the row of that term, the adjusted group means, subject values (`x` is
 * the tested variable or the moderator), and for an association or
 * interaction the fitted lines and simple slopes (descriptive).
 */
export interface GroupAnalysisMeasureDetailV2 {
  resultId: string
  measureId: string
  termId: string
  row: GroupAnalysisRowV2
  groupMeans: AnalysisGroupMean[]
  subjects: AnalysisSubjectValue[]
  fit: AnalysisFitLine[]
  simpleSlopes: AnalysisSimpleSlope[]
}

/** The files main writes for one export (`groupAnalysis.exportData`). */
export interface GroupAnalysisExportData {
  resultId: string
  name: string
  provisional: boolean
  files: {
    name: 'results.csv' | 'subjects.csv' | 'spec.json'
    text: string
  }[]
}

/** One renderer-drawn figure for an export. */
export type AnalysisExportFigure =
  | {
      kind: 'svg'
      /** The file stem, `[a-z0-9._-]`, without extension. */
      stem: string
      svg: string
      /** Also write a PDF rendered from this SVG. */
      pdf: boolean
    }
  | { kind: 'png'; stem: string; png: Uint8Array }

/** The request of `groupAnalysis.writeExport`. */
export interface GroupAnalysisExportRequest {
  destinationId: string
  resultId: string
  /** The new folder to create, `[a-z0-9._-]`, never overwritten. */
  folderName: string
  /** Include the per-subject CSV, which contains participant IDs. */
  subjectCsv: boolean
  figures: AnalysisExportFigure[]
}

/** The result of `groupAnalysis.writeExport`. */
export interface GroupAnalysisExportResult {
  displayPath: string
  /**
   * The folder created: the requested name, or with the next free `-2`,
   * `-3`, ... suffix when that name existed.
   */
  folderName: string
  files: { name: string; bytes: number; sha256: string }[]
  provisional: boolean
}

// -- Result parsers --------------------------------------------------------

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const finite = z.number().finite()
const probability = z.number().min(0).max(1)
const message = z.string().max(MAX_MESSAGE)
const timestamp = z.string().regex(ISO_TIMESTAMP)
const sha256 = z.string().regex(SHA256)
const measureId = z
  .string()
  .max(MAX_MEASURE_ID_LENGTH)
  .refine((id) => parseMeasureId(id) !== null)
const subjectId = z.string().regex(SUBJECT_ID)
const groupLabel = printable(64)
const inputSource = z.union([
  z.enum([
    'dk-all-stats',
    'cortical-thickness',
    'icv',
    'brainage',
    'metadata-csv',
    'age-csv',
    'clinical-csv',
    'outliers',
  ]),
  z
    .string()
    .regex(ANALYSIS_INPUT_SOURCE_V2)
    .transform((value) => value as AnalysisInputSource),
])
const exclusionReason = z.enum([
  'config-excluded',
  'qc-failed',
  'qc-not-passed',
  'no-group',
  'not-compared',
  'missing-covariate',
  'registration-flagged',
  'outlier',
  'no-measures',
  'not-in-population',
  'subset-filtered',
  'missing-variable',
])
const MAX_INPUTS = 64
/** The most imported variables tables a project keeps. */
export const MAX_VARIABLE_TABLES = 16
const inputFileSchema = z.strictObject({
  source: inputSource,
  present: z.boolean(),
  reason: message.nullable(),
  sha256: sha256.nullable(),
  bytes: count.nullable(),
})
const groupCountSchema = z.strictObject({ label: groupLabel, n: count })
const skippedSchema = z.strictObject({ measureId, reason: message })
const stageState = z.enum(['current', 'outdated', 'unknown'])
const stageCurrencySchema = z
  .strictObject({
    aggregate: stageState,
    pybrainage: stageState,
    recon: z
      .strictObject({
        state: stageState,
        outdatedSubjectIds: z.array(subjectId).max(MAX_SUBJECTS),
      })
      .optional(),
  })
  .transform(
    ({ recon, ...stages }): AnalysisStageCurrency =>
      recon === undefined ? stages : { ...stages, recon },
  )
const anySpecSchema = z.custom<AnyGroupAnalysisSpec>(
  (value) => validateAnyGroupAnalysisSpec(value).ok,
)

const variableTableSchema = z.strictObject({
  tableId: z.string().regex(VARIABLE_TABLE_ID),
  name: printable(120),
  idColumn: printable(128),
  sha256,
  importedAt: timestamp,
  rows: count,
  unmatched: count,
  columns: z
    .array(
      z.strictObject({
        column: printable(128),
        kind: z.enum(['categorical', 'numeric']),
        n: count,
        levels: z
          .array(z.strictObject({ value: printable(128), n: count }))
          .max(MAX_LEVELS * 4),
      }),
    )
    .max(256),
})

const catalogSchema = z.strictObject({
  configRevision: count,
  measures: z
    .array(
      z.strictObject({
        measureId,
        source: z.enum(['dk', 'aseg', 'global', 'brainage', 'parc', 'vol']),
        family: z.string().max(128),
        extensive: z.boolean(),
        stage: z.enum(['aggregate', 'pybrainage', 'recon', 'labeling']),
        available: z.boolean(),
        unavailableReason: message.nullable(),
      }),
    )
    .max(MAX_MEASURES_V2),
  variables: z
    .array(
      z.strictObject({
        ref: variableRefSchema,
        kind: z.enum(['categorical', 'numeric']),
        n: count,
        levels: z
          .array(z.strictObject({ value: printable(128), n: count }))
          .max(MAX_LEVELS * 4),
      }),
    )
    .max(512),
  variableTables: z.array(variableTableSchema).max(MAX_VARIABLE_TABLES),
  inputs: z.array(inputFileSchema).max(MAX_INPUTS),
})

const designCheckSchema = z.strictObject({
  ok: z.boolean(),
  issues: z
    .array(
      z.strictObject({
        code: z.enum([
          'min-cell',
          'small-cell',
          'residual-df',
          'collinear',
          'vif',
          'confounded',
          'covariate-undefined',
          'invalid-combination',
          'log1p-domain',
          'subset-empties-group',
          'moderator-cells',
          'test-availability',
          'site-confounded',
        ]),
        severity: z.enum(['blocking', 'strong-warning', 'warning']),
        testId: z.string().regex(ANALYSIS_TEST_ID).nullable(),
        message,
        fixes: z
          .array(
            z.discriminatedUnion('kind', [
              z.strictObject({
                kind: z.literal('drop-level'),
                variable: variableRefV2Schema,
                level: printable(128),
              }),
              z.strictObject({
                kind: z.literal('add-covariate'),
                variable: variableRefV2Schema,
              }),
            ]),
          )
          .max(4)
          .exactOptional(),
      }),
    )
    .max(256),
  tests: z
    .array(
      z.strictObject({
        testId: z.string().regex(ANALYSIS_TEST_ID),
        n: count,
        residualDf: count.nullable(),
        missing: count,
      }),
    )
    .max(MAX_TESTS),
  cells: z
    .array(
      z.strictObject({
        testId: z.string().regex(ANALYSIS_TEST_ID),
        stratum: groupLabel.nullable(),
        label: printable(160),
        n: count,
        female: count.nullable(),
        male: count.nullable(),
      }),
    )
    .max(1024),
  vif: z
    .array(
      z.strictObject({
        testId: z.string().regex(ANALYSIS_TEST_ID),
        term: printable(160),
        vif: z.number().finite().min(1),
      }),
    )
    .max(1024),
  crosstabs: z
    .array(
      z.strictObject({
        testId: z.string().regex(ANALYSIS_TEST_ID).nullable(),
        rowVariable: printable(160),
        columnVariable: printable(160),
        rows: z.array(printable(128)).max(MAX_LEVELS),
        columns: z.array(printable(128)).max(MAX_LEVELS),
        counts: z.array(z.array(count).max(MAX_LEVELS)).max(MAX_LEVELS),
        cramersV: probability.nullable(),
      }),
    )
    .max(64),
})

const inputsSchema = z.strictObject({
  configRevision: count,
  specDigest: sha256,
  subjects: z
    .array(
      z.strictObject({
        subjectId,
        group: groupLabel.nullable(),
        sourceLabel: printable(128).nullable(),
        included: z.boolean(),
        reason: exclusionReason.nullable(),
        missingHemispheres: z.array(z.enum(['lh', 'rh'])).max(2),
      }),
    )
    .max(MAX_SUBJECTS),
  groups: z.array(groupCountSchema).max(MAX_GROUPS),
  included: count,
  registrationProvisional: z.boolean(),
  inputs: z.array(inputFileSchema).max(MAX_INPUTS),
  skippedMeasures: z.array(skippedSchema).max(MAX_MEASURES_V2),
  issues: z.array(message).max(16),
  designCheck: designCheckSchema.nullable(),
})

const operationSchema = z.strictObject({
  operationId: z.string().regex(GROUP_ANALYSIS_OPERATION_ID),
  state: z.enum(['running', 'done', 'cancelled', 'failed']),
  phase: z.enum(['preparing', 'fitting', 'permuting', 'writing']).nullable(),
  completed: count,
  total: count,
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  message: message.nullable(),
  specDigest: sha256,
  resultId: z.string().regex(GROUP_ANALYSIS_RESULT_ID).nullable(),
  skipped: z.array(skippedSchema).max(64).exactOptional(),
})

const librarySchema = {
  revision: count,
  specs: z
    .array(
      z.strictObject({
        specId: z.string().regex(GROUP_ANALYSIS_SPEC_ID),
        name: printable(120),
        spec: anySpecSchema,
        specDigest: sha256,
        updatedAt: timestamp,
      }),
    )
    .max(MAX_SAVED),
  sets: z
    .array(
      z.strictObject({
        setId: z.string().regex(GROUP_ANALYSIS_SET_ID),
        name: printable(120),
        measures: z.array(measureId).min(1).max(MAX_MEASURES_V2),
        locked: z.strictObject({ sha256, lockedAt: timestamp }).nullable(),
        updatedAt: timestamp,
      }),
    )
    .max(MAX_SAVED),
}

const listSchema = z.strictObject({
  ...librarySchema,
  results: z
    .array(
      z.strictObject({
        resultId: z.string().regex(GROUP_ANALYSIS_RESULT_ID),
        schemaVersion: z.union([z.literal(1), z.literal(2)]),
        specId: z.string().regex(GROUP_ANALYSIS_SPEC_ID).nullable(),
        name: printable(120),
        analysis: z
          .enum(['group-comparison', 'association', 'brain-age'])
          .nullable(),
        specDigest: sha256,
        createdAt: timestamp,
        measureCount: count,
        significantCount: count,
        groups: z.array(groupCountSchema).max(MAX_GROUPS),
        provisional: z.boolean(),
        pinned: z.boolean(),
        currency: z.enum(['current', 'stale', 'unknown']),
        staleReasons: z
          .array(
            z.strictObject({
              code: z.enum([
                'inputs-changed',
                'qc-changed-sample',
                'registry-changed',
                'registration-changed',
                'engine-changed',
                'sample-too-small',
                'labels-changed',
              ]),
              added: count,
              removed: count,
              sources: z.array(inputSource).max(MAX_INPUTS),
            }),
          )
          .max(8),
      }),
    )
    .max(MAX_RESULTS),
})

const rowSchema = z.strictObject({
  measureId,
  family: z.string().max(64),
  nTotal: count,
  nFocal: count.nullable(),
  nReference: count.nullable(),
  estimate: finite,
  se: finite,
  t: finite,
  df: finite,
  p: probability,
  pCorrected: probability.nullable(),
  significant: z.boolean(),
  d: finite.nullable(),
  dLow: finite.nullable(),
  dHigh: finite.nullable(),
  dRawSd: finite.nullable(),
  partialEta2: probability,
  pctOfReference: finite.nullable(),
  pHc3: probability,
  pPermutation: probability.nullable(),
})

const resultSchema = z.strictObject({
  schema: z.literal(GROUP_ANALYSIS_RESULT_SCHEMA),
  schemaVersion: z.literal(1),
  resultId: z.string().regex(GROUP_ANALYSIS_RESULT_ID),
  specId: z.string().regex(GROUP_ANALYSIS_SPEC_ID).nullable(),
  name: printable(120),
  spec: groupAnalysisSpecSchema,
  specDigest: sha256,
  createdAt: timestamp,
  engine: z.strictObject({
    id: z.literal(GROUP_ANALYSIS_ENGINE_ID),
    rng: z.literal(GROUP_ANALYSIS_RNG_ID),
    productVersion: z.string().min(1).max(64),
    build: z.string().max(128).nullable(),
  }),
  provisional: z.boolean(),
  stageCurrency: stageCurrencySchema,
  inputs: z.array(inputFileSchema).max(MAX_INPUTS),
  sample: z.strictObject({
    groups: z.array(groupCountSchema).max(MAX_GROUPS),
    included: count,
    excluded: z
      .array(z.strictObject({ subjectId, reason: exclusionReason }))
      .max(MAX_SUBJECTS),
    issues: z.array(message).max(16).default([]),
  }),
  rows: z.array(rowSchema).max(MAX_MEASURES),
  skipped: z.array(skippedSchema).max(MAX_MEASURES),
  resultSha256: sha256,
})

const measureDetailSchema = z.strictObject({
  resultId: z.string().regex(GROUP_ANALYSIS_RESULT_ID),
  measureId,
  row: rowSchema,
  groupMeans: z
    .array(
      z.strictObject({
        label: groupLabel,
        role: z.enum(['focal', 'reference', 'other']),
        n: count,
        mean: finite,
        low: finite,
        high: finite,
      }),
    )
    .max(MAX_GROUPS),
  subjects: z
    .array(
      z.strictObject({
        subjectId,
        group: groupLabel.nullable(),
        sourceLabel: printable(128).nullable(),
        value: finite,
        adjusted: finite,
        x: finite.nullable(),
      }),
    )
    .max(MAX_SUBJECTS),
})

const termIdSchema = z.string().regex(GROUP_ANALYSIS_TERM_ID)

const rowV2Schema = z.strictObject({
  termId: termIdSchema,
  measureId,
  family: z.string().max(128),
  nTotal: count,
  nFocal: count.nullable(),
  nReference: count.nullable(),
  estimate: finite.nullable(),
  se: finite.nullable(),
  t: finite.nullable(),
  F: finite.nullable(),
  df1: finite,
  df2: finite,
  p: probability,
  pCorrected: probability.nullable(),
  significant: z.boolean(),
  d: finite.nullable(),
  dLow: finite.nullable(),
  dHigh: finite.nullable(),
  dRawSd: finite.nullable(),
  partialEta2: probability,
  partialR: z.number().min(-1).max(1).nullable(),
  partialRLow: z.number().min(-1).max(1).nullable(),
  partialRHigh: z.number().min(-1).max(1).nullable(),
  slopePerSd: finite.nullable(),
  pctOfReference: finite.nullable(),
  pHc3: probability.nullable(),
  pPermutation: probability.nullable(),
  gated: z.boolean(),
  inFamily: z.boolean(),
})

const MAX_TERMS = 1_024

const termSchema = z.strictObject({
  termId: termIdSchema,
  testId: z.string().regex(ANALYSIS_TEST_ID),
  kind: z.enum(['t', 'F']),
  rank: z.number().int().min(1).max(64),
  role: z.enum(['effect', 'pairwise', 'heterogeneity']),
  label: printable(160),
  family: z.string().min(1).max(160).nullable(),
  stratum: groupLabel.nullable(),
  pair: z.strictObject({ focal: groupLabel, reference: groupLabel }).nullable(),
  rowCount: count,
})

const resultV2Schema = z
  .strictObject({
    schema: z.literal(GROUP_ANALYSIS_RESULT_SCHEMA),
    schemaVersion: z.literal(2),
    resultId: z.string().regex(GROUP_ANALYSIS_RESULT_ID),
    specId: z.string().regex(GROUP_ANALYSIS_SPEC_ID).nullable(),
    name: printable(120),
    spec: groupAnalysisSpecV2Schema,
    specDigest: sha256,
    createdAt: timestamp,
    engine: z.strictObject({
      id: z.literal(GROUP_ANALYSIS_ENGINE_ID_V2),
      rng: z.literal(GROUP_ANALYSIS_RNG_ID),
      productVersion: z.string().min(1).max(64),
      build: z.string().max(128).nullable(),
    }),
    provisional: z.boolean(),
    stageCurrency: stageCurrencySchema,
    inputs: z.array(inputFileSchema).max(MAX_INPUTS),
    sample: z.strictObject({
      groups: z.array(groupCountSchema).max(MAX_GROUPS * MAX_GROUPS),
      included: count,
      excluded: z
        .array(z.strictObject({ subjectId, reason: exclusionReason }))
        .max(MAX_SUBJECTS),
      issues: z.array(message).max(16),
    }),
    terms: z.array(termSchema).min(1).max(MAX_TERMS),
    rows: z.array(rowV2Schema).max(GROUP_ANALYSIS_TERM_PAGE_ROWS),
    skipped: z.array(skippedSchema).max(MAX_MEASURES_V2),
    resultSha256: sha256,
  })
  .refine(
    (result) =>
      new Set(result.terms.map((term) => term.termId)).size ===
        result.terms.length &&
      result.rows.every((row) => row.termId === result.terms[0]!.termId),
  )

const termRowsSchema = z
  .strictObject({
    resultId: z.string().regex(GROUP_ANALYSIS_RESULT_ID),
    termId: termIdSchema,
    offset: count,
    total: count,
    rows: z.array(rowV2Schema).max(GROUP_ANALYSIS_TERM_PAGE_ROWS),
    nextOffset: count.nullable(),
  })
  .refine(
    (page) =>
      page.rows.every((row) => row.termId === page.termId) &&
      page.offset + page.rows.length <= page.total &&
      (page.nextOffset === null
        ? page.offset + page.rows.length === page.total
        : page.nextOffset === page.offset + page.rows.length),
  )

const fitSeries = z.array(finite).max(64)

const measureDetailV2Schema = z.strictObject({
  resultId: z.string().regex(GROUP_ANALYSIS_RESULT_ID),
  measureId,
  termId: termIdSchema,
  row: rowV2Schema,
  groupMeans: measureDetailSchema.shape.groupMeans,
  subjects: measureDetailSchema.shape.subjects,
  fit: z
    .array(
      z.strictObject({
        group: groupLabel.nullable(),
        x: fitSeries,
        y: fitSeries,
        low: fitSeries,
        high: fitSeries,
      }),
    )
    .max(MAX_GROUPS),
  simpleSlopes: z
    .array(
      z.strictObject({
        group: groupLabel,
        slope: finite,
        low: finite,
        high: finite,
      }),
    )
    .max(MAX_GROUPS),
})

const exportDataSchema = z.strictObject({
  resultId: z.string().regex(GROUP_ANALYSIS_RESULT_ID),
  name: printable(120),
  provisional: z.boolean(),
  files: z
    .array(
      z.strictObject({
        name: z.enum(['results.csv', 'subjects.csv', 'spec.json']),
        text: z.string().max(16 * 1024 * 1024),
      }),
    )
    .min(1)
    .max(3),
})

function parseWith<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const path = parsed.error.issues[0]?.path.join('.') ?? ''
  throw new TypeError(
    `Provide a valid ${label}${path ? ` (field ${path})` : ''}.`,
  )
}

/** Validate the result of `groupAnalysis.catalog`. */
export function parseGroupAnalysisCatalog(
  value: unknown,
): GroupAnalysisCatalog {
  return parseWith(catalogSchema, value, 'group-analysis catalog')
}

/**
 * Validate one imported variables table (the result of the native
 * `groupAnalysis.chooseVariablesCsv` and the main-internal
 * `groupAnalysis.importVariables`).
 */
export function parseAnalysisVariableTable(
  value: unknown,
): AnalysisVariableTable {
  return parseWith(variableTableSchema, value, 'imported variables table')
}

/** Validate the result of `groupAnalysis.inputs`. */
export function parseGroupAnalysisInputs(value: unknown): GroupAnalysisInputs {
  return parseWith(inputsSchema, value, 'group-analysis sample')
}

/** Validate the result of `groupAnalysis.status`. */
export function parseGroupAnalysisStatus(value: unknown): GroupAnalysisStatus {
  return parseWith(
    z.strictObject({ operation: operationSchema.nullable() }),
    value,
    'group-analysis status',
  )
}

/** Validate the result of `groupAnalysis.start`. */
export function parseGroupAnalysisStartResult(
  value: unknown,
): GroupAnalysisStartResult {
  return parseWith(
    z.strictObject({ operation: operationSchema, started: z.boolean() }),
    value,
    'group-analysis start result',
  )
}

/** Validate the result of `groupAnalysis.cancel`. */
export function parseGroupAnalysisCancelResult(
  value: unknown,
): GroupAnalysisCancelResult {
  return parseWith(
    z.strictObject({
      operationId: z.string().regex(GROUP_ANALYSIS_OPERATION_ID),
      stopped: z.boolean(),
    }),
    value,
    'group-analysis cancel result',
  )
}

/** Validate the result of `groupAnalysis.list`. */
export function parseGroupAnalysisList(value: unknown): GroupAnalysisList {
  return parseWith(listSchema, value, 'group-analysis list')
}

/** Validate the result of every library write (`saveSpec` and the rest). */
export function parseGroupAnalysisLibrary(
  value: unknown,
): GroupAnalysisLibrary {
  return parseWith(
    z.strictObject(librarySchema),
    value,
    'group-analysis library',
  )
}

/** Validate the result of `groupAnalysis.result`, of either schema version. */
export function parseGroupAnalysisResult(
  value: unknown,
): AnyGroupAnalysisResult {
  const version =
    value !== null && typeof value === 'object'
      ? (value as { schemaVersion?: unknown }).schemaVersion
      : undefined
  return version === 2
    ? parseWith(resultV2Schema, value, 'group-analysis result')
    : parseWith(resultSchema, value, 'group-analysis result')
}

/** Validate the result of `groupAnalysis.termRows`. */
export function parseGroupAnalysisTermRows(
  value: unknown,
): GroupAnalysisTermRows {
  return parseWith(termRowsSchema, value, 'group-analysis term rows')
}

/**
 * Validate the result of `groupAnalysis.measureDetail`: the v2 form when it
 * carries a `termId`, else the v1 form.
 */
export function parseGroupAnalysisMeasureDetail(
  value: unknown,
): GroupAnalysisMeasureDetail | GroupAnalysisMeasureDetailV2 {
  return value !== null && typeof value === 'object' && 'termId' in value
    ? parseWith(measureDetailV2Schema, value, 'group-analysis measure detail')
    : parseWith(measureDetailSchema, value, 'group-analysis measure detail')
}

/** Validate the main-internal result of `groupAnalysis.exportData`. */
export function parseGroupAnalysisExportData(
  value: unknown,
): GroupAnalysisExportData {
  return parseWith(exportDataSchema, value, 'group-analysis export data')
}

/**
 * Validate the result of `groupAnalysis.writeExport`: distinct
 * `[a-z0-9._-]` names with the fixed export extensions.
 */
export function parseGroupAnalysisExportResult(
  value: unknown,
): GroupAnalysisExportResult {
  return parseWith(
    z.strictObject({
      displayPath: z.string().min(1).max(16_384),
      folderName: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
      files: z
        .array(
          z.strictObject({
            name: z
              .string()
              .regex(/^[a-z0-9][a-z0-9._-]{0,127}\.(?:csv|json|svg|png|pdf)$/),
            bytes: count,
            sha256,
          }),
        )
        .max(64)
        .refine(
          (files) => new Set(files.map((f) => f.name)).size === files.length,
        ),
      provisional: z.boolean(),
    }),
    value,
    'group-analysis export result',
  )
}

// -- Request validation --------------------------------------------------------

/** The exact fields of every renderer-visible sidecar request. */
export const GROUP_ANALYSIS_REQUEST_FIELDS: Readonly<
  Record<string, readonly string[]>
> = {
  'groupAnalysis.catalog': ['project'],
  'groupAnalysis.inputs': ['project', 'spec'],
  'groupAnalysis.start': ['project', 'spec', 'stageCurrency'],
  'groupAnalysis.status': ['project'],
  'groupAnalysis.cancel': ['project', 'operationId'],
  'groupAnalysis.list': ['project'],
  'groupAnalysis.result': ['project', 'resultId'],
  'groupAnalysis.measureDetail': ['project', 'resultId', 'measureId'],
  'groupAnalysis.saveSpec': [
    'project',
    'specId',
    'name',
    'spec',
    'expectedRevision',
  ],
  'groupAnalysis.deleteSpec': ['project', 'specId', 'expectedRevision'],
  'groupAnalysis.saveSet': [
    'project',
    'setId',
    'name',
    'measures',
    'expectedRevision',
  ],
  'groupAnalysis.lockSet': ['project', 'setId', 'expectedRevision'],
  'groupAnalysis.deleteSet': ['project', 'setId', 'expectedRevision'],
  'groupAnalysis.termRows': ['project', 'resultId', 'termId', 'offset'],
}

/** The optional fields a request may add to its exact fields. */
export const GROUP_ANALYSIS_OPTIONAL_REQUEST_FIELDS: Readonly<
  Record<string, readonly string[]>
> = {
  'groupAnalysis.measureDetail': ['termId'],
}

const STAGE_STATES = new Set(['current', 'outdated', 'unknown'])

/**
 * Check a renderer-supplied stage currency: `aggregate` and `pybrainage`,
 * and (v2) `recon` with its out-of-date subjects.
 *
 * @throws Error naming the problem.
 */
export function validateAnalysisStageCurrency(value: unknown): void {
  const record =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  const keys = record ? Object.keys(record).sort().join(',') : ''
  if (
    !record ||
    (keys !== 'aggregate,pybrainage' &&
      keys !== 'aggregate,pybrainage,recon') ||
    !STAGE_STATES.has(record.aggregate as string) ||
    !STAGE_STATES.has(record.pybrainage as string)
  ) {
    throw new Error('Send the aggregate and Brain-PAD stage currency.')
  }
  if (!('recon' in record)) return
  const recon = record.recon
  const reconRecord =
    recon !== null && typeof recon === 'object' && !Array.isArray(recon)
      ? (recon as Record<string, unknown>)
      : null
  const ids = reconRecord?.outdatedSubjectIds
  if (
    !reconRecord ||
    Object.keys(reconRecord).sort().join(',') !== 'outdatedSubjectIds,state' ||
    !STAGE_STATES.has(reconRecord.state as string) ||
    !Array.isArray(ids) ||
    ids.length > MAX_SUBJECTS ||
    ids.some((id) => typeof id !== 'string' || !SUBJECT_ID.test(id))
  ) {
    throw new Error('Send the reconstruction currency with valid subject IDs.')
  }
}

function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === 'string' && pattern.test(value)
}

/**
 * Check one `groupAnalysis.*` request before it leaves main: the exact
 * fields, then each value. The caller checks the project reference.
 *
 * @throws Error naming the first problem.
 */
export function validateGroupAnalysisRequest(
  method: string,
  request: Record<string, unknown>,
): void {
  const fields = GROUP_ANALYSIS_REQUEST_FIELDS[method]
  if (!fields) throw new Error('Call an allowlisted group-analysis method.')
  const optional = (
    GROUP_ANALYSIS_OPTIONAL_REQUEST_FIELDS[method] ?? []
  ).filter((field) => field in request)
  const actual = Object.keys(request).sort()
  const wanted = [...fields, ...optional].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`Correct the invalid fields in the ${method} request.`)
  }
  if ('spec' in request) parseAnyGroupAnalysisSpec(request.spec)
  if ('stageCurrency' in request) {
    validateAnalysisStageCurrency(request.stageCurrency)
  }
  if ('termId' in request && !matches(request.termId, GROUP_ANALYSIS_TERM_ID)) {
    throw new Error('Provide a valid result term ID.')
  }
  if (
    'offset' in request &&
    !(
      Number.isSafeInteger(request.offset) &&
      (request.offset as number) >= 0 &&
      (request.offset as number) < MAX_MEASURES_V2
    )
  ) {
    throw new Error('Provide a valid row offset.')
  }
  if (
    'operationId' in request &&
    !matches(request.operationId, GROUP_ANALYSIS_OPERATION_ID)
  ) {
    throw new Error('Provide a valid analysis operation ID.')
  }
  if (
    'resultId' in request &&
    !matches(request.resultId, GROUP_ANALYSIS_RESULT_ID)
  ) {
    throw new Error('Provide a valid analysis result ID.')
  }
  if (
    'measureId' in request &&
    (typeof request.measureId !== 'string' ||
      parseMeasureId(request.measureId) === null)
  ) {
    throw new Error('Provide a valid measure ID.')
  }
  if (
    'specId' in request &&
    !(
      (method === 'groupAnalysis.saveSpec' && request.specId === null) ||
      matches(request.specId, GROUP_ANALYSIS_SPEC_ID)
    )
  ) {
    throw new Error('Provide a valid saved-analysis ID.')
  }
  if (
    'setId' in request &&
    !(
      (method === 'groupAnalysis.saveSet' && request.setId === null) ||
      matches(request.setId, GROUP_ANALYSIS_SET_ID)
    )
  ) {
    throw new Error('Provide a valid ROI set ID.')
  }
  if (
    'name' in request &&
    !(
      typeof request.name === 'string' &&
      request.name.length <= 120 &&
      PRINTABLE.test(request.name)
    )
  ) {
    throw new Error('Name it with 1 to 120 printable characters.')
  }
  if ('measures' in request) {
    const measures = request.measures
    if (
      !Array.isArray(measures) ||
      measures.length === 0 ||
      measures.length > MAX_MEASURES_V2 ||
      measures.some(
        (id) => typeof id !== 'string' || parseMeasureId(id) === null,
      ) ||
      new Set(measures).size !== measures.length
    ) {
      throw new Error('List one or more valid measure IDs, each once.')
    }
  }
  if (
    'expectedRevision' in request &&
    !(
      Number.isSafeInteger(request.expectedRevision) &&
      (request.expectedRevision as number) >= 0
    )
  ) {
    throw new Error('Provide the analysis library revision.')
  }
}
