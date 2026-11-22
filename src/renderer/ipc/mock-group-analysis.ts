/**
 * The synthetic group-analysis fixture behind the mock API: 82 subjects
 * (48 CTRL, 22 SCI_P, 12 SCI_nNP), a full measure catalog, one saved
 * specification, one locked ROI set, and one completed SCI-vs-CTRL result
 * with twenty DK and aseg rows, one of them significant after correction.
 *
 * Every value comes from a seeded generator (seed 17), so previews,
 * screenshots, and tests see the same numbers. None of it is study data.
 */

import type { SaveDestination, SupraspinaApi } from '../../shared/contract'
import {
  MOCK_V2_RESULTS,
  MOCK_VARIABLE_TABLE,
  createMockLabeling,
  mockMeasureDetailV2,
  mockTermRows,
  mockV2Summary,
} from './mock-analysis-v2'
import {
  mockRailDesignCheck,
  mockRailMeasures,
  mockSite,
  mockSiteVariable,
} from './mock-analysis-rail'
import {
  ASEG_STRUCTURES,
  DK_REGIONS,
  measureUnit,
} from '../../shared/brain-atlas'
import {
  DK_METRICS,
  GROUP_ANALYSIS_ENGINE_ID,
  GROUP_ANALYSIS_RESULT_SCHEMA,
  GROUP_ANALYSIS_RNG_ID,
  GROUP_ANALYSIS_SPEC_SCHEMA,
  canonicalSpecJson,
  isExtensiveMeasure,
  measureFamily,
  parseMeasureId,
  upgradeGroupAnalysisSpecV1,
  type AnalysisExclusionReason,
  type AnalysisInputFile,
  type AnalysisMeasure,
  type AnalysisVariable,
  type AnalysisVariableTable,
  type AnyGroupAnalysisSpec,
  type DesignCheck,
  type GroupAnalysisCatalog,
  type GroupAnalysisInputs,
  type GroupAnalysisLibrary,
  type GroupAnalysisMeasureDetail,
  type GroupAnalysisOperation,
  type GroupAnalysisResult,
  type GroupAnalysisResultSummary,
  type GroupAnalysisRow,
  type GroupAnalysisSpec,
} from '../../shared/group-analysis'

/** The fixture seed. */
export const MOCK_ANALYSIS_SEED = 17
/** The fixed time every fixture record carries. */
const FIXTURE_TIME = '2026-09-23T14:05:00.000Z'

/** Generate deterministic values with mulberry32. */
function makeRng(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A standard normal draw (Box-Muller). */
function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

/** A deterministic 64-hex digest stand-in for fixture identities. */
function fixtureHex(text: string): string {
  let out = ''
  for (let round = 0; out.length < 64; round += 1) {
    let h = 0x811c9dc5 ^ round
    for (let index = 0; index < text.length; index += 1) {
      h = Math.imul(h ^ text.charCodeAt(index), 0x01000193)
    }
    out += (h >>> 0).toString(16).padStart(8, '0')
  }
  return out.slice(0, 64)
}

/** The two-sided normal tail, a close stand-in for t with 77 df. */
function twoSidedP(t: number): number {
  const x = Math.abs(t) / Math.SQRT2
  // Abramowitz and Stegun 7.1.26.
  const k = 1 / (1 + 0.3275911 * x)
  const poly =
    k *
    (0.254829592 +
      k *
        (-0.284496736 +
          k * (1.421413741 + k * (-1.453152027 + k * 1.061405429))))
  return Math.min(1, Math.max(0, poly * Math.exp(-x * x)))
}

/** One synthetic participant. */
export interface MockAnalysisSubject {
  subjectId: string
  sourceLabel: 'CTRL' | 'SCI_P' | 'SCI_nNP'
  group: 'CTRL' | 'SCI'
  age: number
  sex: 'M' | 'F'
}

/** The 82 synthetic participants: 48 CTRL, 22 SCI_P, 12 SCI_nNP. */
export const MOCK_ANALYSIS_SUBJECTS: readonly MockAnalysisSubject[] = (() => {
  const rng = makeRng(MOCK_ANALYSIS_SEED)
  const labels: MockAnalysisSubject['sourceLabel'][] = [
    ...Array<'CTRL'>(48).fill('CTRL'),
    ...Array<'SCI_P'>(22).fill('SCI_P'),
    ...Array<'SCI_nNP'>(12).fill('SCI_nNP'),
  ]
  return labels.map((sourceLabel, index) => ({
    subjectId: `sub-${String(index + 1).padStart(3, '0')}`,
    sourceLabel,
    group: sourceLabel === 'CTRL' ? 'CTRL' : 'SCI',
    age: Math.round((38 + 13 * normal(rng)) * 10) / 10,
    sex: rng() < 0.7 ? 'M' : 'F',
  }))
})()

const FOCAL_N = MOCK_ANALYSIS_SUBJECTS.filter((s) => s.group === 'SCI').length
const REFERENCE_N = MOCK_ANALYSIS_SUBJECTS.length - FOCAL_N

/** The measures of the fixture result, in table order. */
const RESULT_MEASURES = [
  'dk:bi:precentral:ThickAvg',
  'dk:bi:postcentral:ThickAvg',
  'dk:bi:paracentral:ThickAvg',
  'dk:bi:insula:ThickAvg',
  'dk:bi:rostralanteriorcingulate:ThickAvg',
  'dk:bi:caudalanteriorcingulate:ThickAvg',
  'dk:bi:medialorbitofrontal:ThickAvg',
  'dk:lh:precentral:ThickAvg',
  'dk:rh:precentral:ThickAvg',
  'dk:bi:superiorfrontal:ThickAvg',
  'dk:bi:precentral:GrayVol',
  'dk:bi:postcentral:SurfArea',
  'aseg:bi:Thalamus',
  'aseg:bi:Cerebellum-Cortex',
  'aseg:Brain-Stem',
  'aseg:bi:Hippocampus',
  'aseg:bi:Putamen',
  'aseg:bi:Caudate',
  'aseg:bi:Amygdala',
  'global:meanThickness',
] as const

/** The adjusted d the fixture plants for its two effects. */
const PLANTED_D: Readonly<Record<string, number>> = {
  'aseg:Brain-Stem': -0.48,
  'dk:bi:precentral:ThickAvg': -0.68,
}

/** A plausible reference mean and SD per measure, in its unit. */
function scale(id: string): { mean: number; sd: number } {
  const unit = measureUnit(id)
  if (id === 'aseg:Brain-Stem') return { mean: 21_400, sd: 2_100 }
  if (unit === 'mm') return { mean: 2.55, sd: 0.11 }
  if (unit === 'mm2') return { mean: 4_100, sd: 520 }
  if (unit === 'mm3') {
    const parsed = parseMeasureId(id)
    const big =
      parsed?.source === 'aseg' &&
      /Cerebellum-Cortex|Thalamus/.test(parsed.structure)
    return big ? { mean: 7_600, sd: 780 } : { mean: 4_200, sd: 480 }
  }
  return { mean: 1, sd: 0.1 }
}

/** The default specification of the fixture: SCI vs CTRL, max-T FWE. */
export const MOCK_ANALYSIS_SPEC: GroupAnalysisSpec = {
  schema: GROUP_ANALYSIS_SPEC_SCHEMA,
  schemaVersion: 1,
  analysis: 'group-comparison',
  measures: [...RESULT_MEASURES],
  contrast: {
    type: 'groups',
    grouping: {
      variable: { source: 'registry', column: 'sourceCohortLabel' },
      groups: [
        { label: 'SCI', levels: ['SCI_P', 'SCI_nNP'] },
        { label: 'CTRL', levels: ['CTRL'] },
      ],
    },
    focal: 'SCI',
    reference: 'CTRL',
    model: 'all-groups',
  },
  covariates: {
    age: { source: 'registry', column: 'age' },
    sex: { source: 'registry', column: 'sex' },
    etiv: 'extensive',
    extra: [],
    centering: 'sample-mean',
  },
  inclusion: {
    qc: 'non-failed',
    registration: 'set-missing',
    outliers: 'keep',
  },
  inference: {
    sidedness: 'two-sided',
    correction: 'maxt-fwe',
    family: 'selected',
    alpha: 0.05,
    permutations: 5000,
    seed: 20260923,
  },
}

const SPEC_DIGEST = fixtureHex(canonicalSpecJson(MOCK_ANALYSIS_SPEC))
const RESULT_ID = `gar-${fixtureHex('mock-result').slice(0, 16)}`
const SPEC_ID = `gas-${fixtureHex('mock-spec').slice(0, 16)}`
const SET_ID = `gset-${fixtureHex('mock-set').slice(0, 16)}`

/** Every measure ID the synthetic tables provide. */
function catalogMeasureIds(): string[] {
  const ids: string[] = []
  for (const region of DK_REGIONS) {
    for (const hemisphere of ['lh', 'rh', 'bi']) {
      for (const metric of DK_METRICS) {
        ids.push(`dk:${hemisphere}:${region.name}:${metric}`)
      }
    }
  }
  const pairs = new Set<string>()
  for (const structure of ASEG_STRUCTURES) {
    ids.push(`aseg:${structure.name}`)
    const pair = /^Left-(.+)$/.exec(structure.name)
    if (pair && ASEG_STRUCTURES.some((s) => s.name === `Right-${pair[1]}`)) {
      pairs.add(pair[1]!)
    }
  }
  for (const pair of pairs) ids.push(`aseg:bi:${pair}`)
  ids.push('global:eTIV', 'global:meanThickness', 'brainage:BrainPAD')
  return ids
}

const INPUT_FILES: AnalysisInputFile[] = (
  [
    ['dk-all-stats', 612_480],
    ['cortical-thickness', 3_310],
    ['icv', 2_050],
    ['brainage', 4_020],
    ['metadata-csv', 5_600],
    ['age-csv', 1_240],
    ['clinical-csv', 2_900],
    ['outliers', 880],
  ] as const
).map(([source, bytes]) => ({
  source,
  present: true,
  reason: null,
  sha256: fixtureHex(`input:${source}`),
  bytes,
}))

function levelCounts(
  values: readonly string[],
): { value: string; n: number }[] {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, n]) => ({ value, n }))
}

/** The fixture catalog. */
export function mockAnalysisCatalog(
  configRevision = 0,
  variableTables: AnalysisVariableTable[] = [MOCK_VARIABLE_TABLE],
  sites = false,
): GroupAnalysisCatalog {
  const measures: AnalysisMeasure[] = catalogMeasureIds().map((measureId) => {
    const source = parseMeasureId(measureId)!.source
    return {
      measureId,
      source,
      family: measureFamily(measureId),
      extensive: isExtensiveMeasure(measureId),
      stage: source === 'brainage' ? 'pybrainage' : 'aggregate',
      available: true,
      unavailableReason: null,
    }
  })
  // The v2 rail's tier A and B measures follow the v1 tables.
  measures.push(...mockRailMeasures())
  const subjects = MOCK_ANALYSIS_SUBJECTS
  const roles = subjects.map((s) =>
    s.sourceLabel === 'CTRL'
      ? 'healthy'
      : s.sourceLabel === 'SCI_P'
        ? 'sci-neuropathic-pain'
        : 'sci-no-neuropathic-pain',
  )
  const variables: AnalysisVariable[] = [
    {
      ref: { source: 'registry', column: 'cohortRole' },
      kind: 'categorical',
      n: subjects.length,
      levels: levelCounts(roles),
    },
    {
      ref: { source: 'registry', column: 'sourceCohortLabel' },
      kind: 'categorical',
      n: subjects.length,
      levels: levelCounts(subjects.map((s) => s.sourceLabel)),
    },
    {
      ref: { source: 'registry', column: 'sex' },
      kind: 'categorical',
      n: subjects.length,
      levels: levelCounts(subjects.map((s) => s.sex)),
    },
    {
      ref: { source: 'registry', column: 'age' },
      kind: 'numeric',
      n: subjects.length,
      levels: [],
    },
    {
      ref: { source: 'metadata-csv', column: 'group' },
      kind: 'categorical',
      n: subjects.length,
      levels: levelCounts(subjects.map((s) => s.sourceLabel)),
    },
    ...(sites ? [mockSiteVariable(subjects)] : []),
  ]
  return {
    configRevision,
    measures,
    variables,
    variableTables,
    inputs: INPUT_FILES,
  }
}

function holm(p: readonly number[]): number[] {
  const order = p.map((value, index) => [value, index] as const)
  order.sort((a, b) => a[0] - b[0])
  const out = new Array<number>(p.length)
  let running = 0
  order.forEach(([value, index], rank) => {
    running = Math.max(running, Math.min(1, (p.length - rank) * value))
    out[index] = running
  })
  return out
}

/** The twenty fixture rows. */
function fixtureRows(): GroupAnalysisRow[] {
  const rng = makeRng(MOCK_ANALYSIS_SEED + 1)
  const vjj = 1 / FOCAL_N + 1 / REFERENCE_N
  const k = Math.sqrt(vjj)
  const df = MOCK_ANALYSIS_SUBJECTS.length - 5
  const draft = RESULT_MEASURES.map((measureId) => {
    const d = PLANTED_D[measureId] ?? 0.22 * normal(rng)
    const t = d / k
    return { measureId, d, t, p: twoSidedP(t) }
  })
  const corrected = holm(draft.map((row) => row.p))
  return draft.map((row, index) => {
    const { mean, sd } = scale(row.measureId)
    const estimate = row.d * sd
    const pCorrected = corrected[index]!
    const permutations = MOCK_ANALYSIS_SPEC.inference.permutations
    return {
      measureId: row.measureId,
      family: measureFamily(row.measureId),
      nTotal: MOCK_ANALYSIS_SUBJECTS.length,
      nFocal: FOCAL_N,
      nReference: REFERENCE_N,
      estimate,
      se: Math.abs(estimate / row.t),
      t: row.t,
      df,
      p: row.p,
      pCorrected: Math.max(pCorrected, 1 / (permutations + 1)),
      significant: pCorrected <= MOCK_ANALYSIS_SPEC.inference.alpha,
      d: row.d,
      dLow: row.d - 1.96 * k,
      dHigh: row.d + 1.96 * k,
      dRawSd: row.d * 0.97,
      partialEta2: (row.t * row.t) / (row.t * row.t + df),
      pctOfReference: (estimate / mean) * 100,
      pHc3: Math.min(1, row.p * 1.08),
      pPermutation: Math.max(
        Math.round(row.p * (permutations + 1)) / (permutations + 1),
        1 / (permutations + 1),
      ),
    }
  })
}

/** The completed fixture result. */
export const MOCK_ANALYSIS_RESULT: GroupAnalysisResult = {
  schema: GROUP_ANALYSIS_RESULT_SCHEMA,
  schemaVersion: 1,
  resultId: RESULT_ID,
  specId: SPEC_ID,
  name: 'SCI vs controls',
  spec: MOCK_ANALYSIS_SPEC,
  specDigest: SPEC_DIGEST,
  createdAt: FIXTURE_TIME,
  engine: {
    id: GROUP_ANALYSIS_ENGINE_ID,
    rng: GROUP_ANALYSIS_RNG_ID,
    productVersion: '20261121.1830.0',
    build: null,
  },
  provisional: false,
  stageCurrency: { aggregate: 'current', pybrainage: 'current' },
  inputs: INPUT_FILES,
  sample: {
    groups: [
      { label: 'SCI', n: FOCAL_N },
      { label: 'CTRL', n: REFERENCE_N },
    ],
    included: MOCK_ANALYSIS_SUBJECTS.length,
    excluded: [],
    issues: [],
  },
  rows: fixtureRows(),
  skipped: [],
  resultSha256: fixtureHex('mock-result-sha256'),
}

/** The one-line summary of the fixture result. */
function resultSummary(): GroupAnalysisResultSummary {
  const result = MOCK_ANALYSIS_RESULT
  return {
    resultId: result.resultId,
    schemaVersion: 1,
    specId: result.specId,
    name: result.name,
    analysis: result.spec.analysis,
    specDigest: result.specDigest,
    createdAt: result.createdAt,
    measureCount: result.rows.length,
    significantCount: result.rows.filter((row) => row.significant).length,
    groups: result.sample.groups,
    provisional: result.provisional,
    pinned: false,
    currency: 'current',
    staleReasons: [],
  }
}

/**
 * Synthesize one measure's per-subject values around the fixture row.
 *
 * @returns The detail, or null for a measure outside the result.
 */
export function mockMeasureDetail(
  measureId: string,
): GroupAnalysisMeasureDetail | null {
  const index = MOCK_ANALYSIS_RESULT.rows.findIndex(
    (row) => row.measureId === measureId,
  )
  const row = MOCK_ANALYSIS_RESULT.rows[index]
  if (!row) return null
  const rng = makeRng(MOCK_ANALYSIS_SEED * 1000 + index)
  const { mean, sd } = scale(measureId)
  const subjects = MOCK_ANALYSIS_SUBJECTS.map((subject) => {
    const shift = subject.group === 'SCI' ? row.estimate : 0
    const adjusted = mean + shift + sd * normal(rng)
    return {
      subjectId: subject.subjectId,
      group: subject.group,
      sourceLabel: subject.sourceLabel,
      value: adjusted + 0.004 * sd * (subject.age - 38),
      adjusted,
      x: null,
    }
  })
  const groupMeans = (['SCI', 'CTRL'] as const).map((label) => {
    const values = subjects
      .filter((subject) => subject.group === label)
      .map((subject) => subject.adjusted)
    const groupMean = values.reduce((sum, v) => sum + v, 0) / values.length
    const half = (1.96 * sd) / Math.sqrt(values.length)
    return {
      label,
      role: label === 'SCI' ? ('focal' as const) : ('reference' as const),
      n: values.length,
      mean: groupMean,
      low: groupMean - half,
      high: groupMean + half,
    }
  })
  return {
    resultId: MOCK_ANALYSIS_RESULT.resultId,
    measureId,
    row,
    groupMeans,
    subjects,
  }
}

/** The status reads a mock compute takes before it finishes. */
export const MOCK_COMPUTE_POLLS = 4

/** One fixture subject's value of a grouping variable. */
function mockLevel(
  subject: MockAnalysisSubject,
  column: string,
): string | null {
  switch (column) {
    case 'sourceCohortLabel':
    case 'group':
      return subject.sourceLabel
    case 'cohortRole':
      return subject.sourceLabel === 'CTRL'
        ? 'healthy'
        : subject.sourceLabel === 'SCI_P'
          ? 'sci-neuropathic-pain'
          : 'sci-no-neuropathic-pain'
    case 'sex':
      return subject.sex
    case 'site':
      return mockSite(subject, MOCK_ANALYSIS_SUBJECTS.indexOf(subject))
    default:
      return null
  }
}

/**
 * Resolve the fixture sample of a draft: each subject's group from the
 * grouping variable's levels, every eleventh subject counted as unreviewed
 * under the "QC Pass only" rule, and the other groups left out when only the
 * compared groups are modeled.
 *
 * @returns One inclusion row per fixture subject.
 */
export function mockInclusion(
  spec: GroupAnalysisSpec,
): GroupAnalysisInputs['subjects'] {
  const { contrast } = spec
  const grouping = contrast.grouping
  return MOCK_ANALYSIS_SUBJECTS.map((subject, index) => {
    const level = grouping ? mockLevel(subject, grouping.variable.column) : null
    const group = grouping
      ? (grouping.groups.find((g) => level !== null && g.levels.includes(level))
          ?.label ?? null)
      : null
    let reason: AnalysisExclusionReason | null = null
    if (spec.inclusion.qc === 'passed' && index % 11 === 5) {
      reason = 'qc-not-passed'
    } else if (grouping && group === null) {
      reason = 'no-group'
    } else if (
      contrast.type === 'groups' &&
      contrast.model === 'compared-groups' &&
      group !== contrast.focal &&
      group !== contrast.reference
    ) {
      reason = 'not-compared'
    } else if (
      contrast.type === 'association' &&
      grouping &&
      !contrast.includedGroups.includes(group ?? '')
    ) {
      reason = 'not-compared'
    }
    return {
      subjectId: subject.subjectId,
      group,
      sourceLabel: subject.sourceLabel,
      included: reason === null,
      reason,
      missingHemispheres: [],
    }
  })
}

/**
 * Resolve the fixture sample of a spec v2 draft: every eleventh subject is
 * unreviewed under "QC Pass only", then the population and the level subset
 * filters on the fixture's columns apply.
 *
 * @returns One inclusion row per fixture subject.
 */
export function mockInclusionV2(
  spec: Extract<AnyGroupAnalysisSpec, { schemaVersion: 2 }>,
): GroupAnalysisInputs['subjects'] {
  const population = spec.design.population
  return MOCK_ANALYSIS_SUBJECTS.map((subject, index) => {
    const level = population
      ? mockLevel(subject, population.grouping.variable.column)
      : null
    const group = population
      ? (population.grouping.groups.find(
          (g) => level !== null && g.levels.includes(level),
        )?.label ?? null)
      : null
    const inside =
      population === null ||
      (group !== null && population.groups.includes(group))
    // Level filters on the fixture's columns apply; others keep every row.
    const filtered = spec.design.subset.some((filter) => {
      if (!('levels' in filter.keep)) return false
      const value = mockLevel(subject, filter.variable.column)
      return value !== null && !filter.keep.levels.includes(value)
    })
    const reason =
      spec.inclusion.qc === 'passed' && index % 11 === 5
        ? 'qc-not-passed'
        : !inside
          ? 'not-in-population'
          : filtered
            ? 'subset-filtered'
            : null
    return {
      subjectId: subject.subjectId,
      group,
      sourceLabel: subject.sourceLabel,
      included: reason === null,
      reason,
      missingHemispheres: [],
    }
  })
}

/**
 * Keep only the site check of a design check, as the sidecar checks a spec
 * v1: on its upgraded test `t1`, with no cells, VIFs, or other rules.
 *
 * @param check - The design check of the spec v1's v2 form.
 * @returns Its site findings and site crosstab.
 */
export function mockSiteCheckV1(check: DesignCheck): DesignCheck {
  const issues = check.issues.filter(
    (issue) => issue.code === 'site-confounded',
  )
  return {
    ok: !issues.some((issue) => issue.severity === 'blocking'),
    issues,
    tests: [],
    cells: [],
    vif: [],
    crosstabs: check.crosstabs.filter((row) => row.columnVariable === 'site'),
  }
}

/** Options of the mock group-analysis domains. */
export interface MockGroupAnalysisOptions {
  /** List the v2 fixture results too (for the v2 results view). */
  listV2Results?: boolean
  /**
   * Give the registry a site, where site B holds only controls, so the
   * design check reports the site check with its two fixes.
   */
  sites?: boolean
  /** List the v2 results before the v1 one, as their newer stamps order them. */
  v2First?: boolean
}

/**
 * Build the stateful `groupAnalysis` and `brainViewer` mock domains.
 *
 * @param projectRoot - The open project's root, for display paths.
 */
export function createMockGroupAnalysis(
  projectRoot: () => string,
  options: MockGroupAnalysisOptions = {},
): {
  groupAnalysis: SupraspinaApi['groupAnalysis']
  brainViewer: SupraspinaApi['brainViewer']
} {
  let variableTables: AnalysisVariableTable[] = [MOCK_VARIABLE_TABLE]
  const labeling = createMockLabeling()
  let library: GroupAnalysisLibrary = {
    revision: 1,
    specs: [
      {
        specId: SPEC_ID,
        name: 'SCI vs controls',
        spec: MOCK_ANALYSIS_SPEC,
        specDigest: SPEC_DIGEST,
        updatedAt: FIXTURE_TIME,
      },
    ],
    sets: [
      {
        setId: SET_ID,
        name: 'A priori regions',
        measures: RESULT_MEASURES.slice(0, 7).concat([
          'aseg:bi:Thalamus',
          'aseg:bi:Cerebellum-Cortex',
          'aseg:Brain-Stem',
        ]),
        locked: {
          sha256: fixtureHex('mock-set-lock'),
          lockedAt: FIXTURE_TIME,
        },
        updatedAt: FIXTURE_TIME,
      },
    ],
  }
  let operation: GroupAnalysisOperation | null = null
  let polls = 0
  let counter = 0
  // Export folders already written, so a repeated name gets a suffix as
  // main gives it.
  const exported = new Set<string>()

  const commit = (
    expectedRevision: number,
    change: (current: GroupAnalysisLibrary) => GroupAnalysisLibrary,
  ): GroupAnalysisLibrary => {
    if (expectedRevision !== library.revision) {
      throw new Error('Reload the analysis library; it changed.')
    }
    library = { ...change(library), revision: library.revision + 1 }
    return library
  }
  const nextId = (prefix: string, length: number): string => {
    counter += 1
    return `${prefix}-${fixtureHex(`${prefix}:${counter}`).slice(0, length)}`
  }
  const notFound = (): Error => new Error('Select a stored analysis result.')

  const siteOf = (subjectId: string): string => {
    const index = MOCK_ANALYSIS_SUBJECTS.findIndex(
      (subject) => subject.subjectId === subjectId,
    )
    return index < 0 || !options.sites
      ? 'A'
      : mockSite(MOCK_ANALYSIS_SUBJECTS[index]!, index)
  }

  const groupAnalysis: SupraspinaApi['groupAnalysis'] = {
    catalog: async () =>
      mockAnalysisCatalog(0, variableTables, options.sites ?? false),
    inputs: async ({ spec }) => {
      const subjects =
        spec.schemaVersion === 2 ? mockInclusionV2(spec) : mockInclusion(spec)
      const groups = new Map<string, number>()
      for (const subject of subjects) {
        if (subject.included && subject.group) {
          groups.set(subject.group, (groups.get(subject.group) ?? 0) + 1)
        }
      }
      return {
        configRevision: 0,
        specDigest: fixtureHex(canonicalSpecJson(spec)),
        subjects,
        groups: [...groups.entries()].map(([label, n]) => ({ label, n })),
        included: subjects.filter((subject) => subject.included).length,
        registrationProvisional: false,
        inputs: INPUT_FILES,
        skippedMeasures: [],
        issues: [],
        designCheck:
          spec.schemaVersion === 2
            ? mockRailDesignCheck(spec, subjects, siteOf)
            : options.sites
              ? mockSiteCheckV1(
                  mockRailDesignCheck(
                    upgradeGroupAnalysisSpecV1(spec),
                    subjects,
                    siteOf,
                  ),
                )
              : null,
      }
    },
    // A compute runs for MOCK_COMPUTE_POLLS status reads, then returns the
    // fixture result, so the panel shows its progress in the preview.
    start: async ({ spec }) => {
      polls = 0
      operation = {
        operationId: nextId('gan', 16),
        state: 'running',
        phase: 'preparing',
        completed: 0,
        total: Math.max(1, spec.inference.permutations),
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message: null,
        specDigest: fixtureHex(canonicalSpecJson(spec)),
        resultId: null,
      }
      return { operation, started: true }
    },
    status: async () => {
      if (operation?.state === 'running') {
        polls += 1
        const done = polls >= MOCK_COMPUTE_POLLS
        operation = {
          ...operation,
          state: done ? 'done' : 'running',
          phase: done ? null : polls === 1 ? 'fitting' : 'permuting',
          completed: done
            ? operation.total
            : Math.round((operation.total * (polls - 1)) / MOCK_COMPUTE_POLLS),
          finishedAt: done ? new Date().toISOString() : null,
          resultId: done ? MOCK_ANALYSIS_RESULT.resultId : null,
        }
      }
      return { operation }
    },
    cancel: async ({ operationId }) => {
      const stopped =
        operation?.operationId === operationId && operation.state === 'running'
      if (operation && stopped) {
        operation = {
          ...operation,
          state: 'cancelled',
          phase: null,
          finishedAt: new Date().toISOString(),
        }
      }
      return { operationId, stopped }
    },
    list: async () => {
      const v2 = options.listV2Results ? MOCK_V2_RESULTS.map(mockV2Summary) : []
      return {
        ...library,
        results: options.v2First
          ? [...v2, resultSummary()]
          : [resultSummary(), ...v2],
      }
    },
    result: async ({ resultId }) => {
      if (resultId === MOCK_ANALYSIS_RESULT.resultId)
        return MOCK_ANALYSIS_RESULT
      const v2 = MOCK_V2_RESULTS.find((item) => item.resultId === resultId)
      if (!v2) throw notFound()
      return v2
    },
    termRows: async ({ resultId, termId, offset }) =>
      mockTermRows(resultId, termId, offset),
    measureDetail: (async (request: {
      resultId: string
      measureId: string
      termId?: string
    }) => {
      const detail =
        request.termId !== undefined
          ? mockMeasureDetailV2(
              request.resultId,
              request.measureId,
              request.termId,
            )
          : request.resultId === MOCK_ANALYSIS_RESULT.resultId
            ? mockMeasureDetail(request.measureId)
            : null
      if (!detail) throw notFound()
      return detail
    }) as SupraspinaApi['groupAnalysis']['measureDetail'],
    saveSpec: async ({ specId, name, spec, expectedRevision }) =>
      commit(expectedRevision, (current) => {
        const id = specId ?? nextId('gas', 16)
        const saved = {
          specId: id,
          name,
          spec,
          specDigest: fixtureHex(canonicalSpecJson(spec)),
          updatedAt: FIXTURE_TIME,
        }
        return {
          ...current,
          specs: [saved, ...current.specs.filter((s) => s.specId !== id)],
        }
      }),
    deleteSpec: async ({ specId, expectedRevision }) =>
      commit(expectedRevision, (current) => ({
        ...current,
        specs: current.specs.filter((s) => s.specId !== specId),
      })),
    saveSet: async ({ setId, name, measures, expectedRevision }) =>
      commit(expectedRevision, (current) => {
        if (current.sets.some((s) => s.setId === setId && s.locked)) {
          throw new Error('Copy the locked set to change it.')
        }
        const id = setId ?? nextId('gset', 16)
        const saved = {
          setId: id,
          name,
          measures,
          locked: null,
          updatedAt: FIXTURE_TIME,
        }
        return {
          ...current,
          sets: [saved, ...current.sets.filter((s) => s.setId !== id)],
        }
      }),
    lockSet: async ({ setId, expectedRevision }) =>
      commit(expectedRevision, (current) => ({
        ...current,
        sets: current.sets.map((s) =>
          s.setId === setId && !s.locked
            ? {
                ...s,
                locked: {
                  sha256: fixtureHex(s.measures.join(',')),
                  lockedAt: FIXTURE_TIME,
                },
              }
            : s,
        ),
      })),
    deleteSet: async ({ setId, expectedRevision }) =>
      commit(expectedRevision, (current) => ({
        ...current,
        sets: current.sets.filter((s) => s.setId !== setId),
      })),
    chooseSetCsv: async () => null,
    chooseVariablesCsv: async () => {
      variableTables = [MOCK_VARIABLE_TABLE]
      return MOCK_VARIABLE_TABLE
    },
    removeVariables: async ({ tableId }) => {
      const before = variableTables.length
      variableTables = variableTables.filter((t) => t.tableId !== tableId)
      return variableTables.length !== before
    },
    ...labeling,
    chooseExportFolder: async ({ defaultName }) => {
      const destination: SaveDestination = {
        destinationId: 'mock-analysis-export',
        displayPath: `${projectRoot() || '/project'}/exports/analysis`,
      }
      void defaultName
      return destination
    },
    writeExport: async ({ folderName: requested, subjectCsv, figures }) => {
      let folderName = requested
      for (let n = 2; exported.has(folderName); n += 1) {
        folderName = `${requested}-${n}`
      }
      exported.add(folderName)
      return {
        displayPath: `${projectRoot() || '/project'}/exports/analysis/${folderName}`,
        folderName,
        files: [
          'results.csv',
          ...(subjectCsv ? ['subjects.csv'] : []),
          'spec.json',
          ...figures.flatMap((figure) =>
            figure.kind === 'png'
              ? [`${figure.stem}.png`]
              : [
                  `${figure.stem}.svg`,
                  ...(figure.pdf ? [`${figure.stem}.pdf`] : []),
                ],
          ),
        ].map((name) => ({ name, bytes: 1024, sha256: fixtureHex(name) })),
        provisional: false,
      }
    },
  }

  const brainViewer: SupraspinaApi['brainViewer'] = {
    assets: async (request) => ({
      available: false,
      unavailableReason: 'FreeSurfer home is not set.',
      subjectId: request.subjectId ?? null,
      assets: [],
    }),
    readAsset: async () => {
      throw new Error('FreeSurfer home is not set.')
    },
  }
  return { groupAnalysis, brainViewer }
}
