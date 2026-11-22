/**
 * The synthetic Analysis v2 fixture behind the mock API: a within-SCI
 * battery result (five tests over four outcomes, one outside the family),
 * an omnibus result (three groups with pairwise terms), one imported
 * variables table, the atlas catalog with tier A and tier B states, and a
 * labeling operation that progresses over status reads.
 *
 * Every value comes from a seeded generator, so previews and tests see the
 * same numbers. None of it is study data.
 */

import type { SupraspinaApi } from '../../shared/contract'
import {
  ATLAS_SOURCES,
  type AtlasCatalog,
  type AtlasDownloadOperation,
  type AtlasEntry,
  type AtlasLabelOperation,
  type SubjectLabelStatus,
} from '../../shared/atlas-labeling'
import {
  GROUP_ANALYSIS_ENGINE_ID_V2,
  GROUP_ANALYSIS_RESULT_SCHEMA,
  GROUP_ANALYSIS_RNG_ID,
  GROUP_ANALYSIS_SPEC_SCHEMA,
  GROUP_ANALYSIS_TERM_PAGE_ROWS,
  measureFamily,
  type AnalysisTest,
  type AnalysisVariableTable,
  type GroupAnalysisMeasureDetailV2,
  type GroupAnalysisResultSummary,
  type GroupAnalysisResultV2,
  type GroupAnalysisRowV2,
  type GroupAnalysisSpecV2,
  type GroupAnalysisTerm,
  type GroupAnalysisTermRows,
} from '../../shared/group-analysis'

const FIXTURE_TIME = '2026-09-30T09:30:00.000Z'
const SEED = 29

function makeRng(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

function hex(text: string, length = 64): string {
  let out = ''
  for (let round = 0; out.length < length; round += 1) {
    let h = 0x811c9dc5 ^ round
    for (let index = 0; index < text.length; index += 1) {
      h = Math.imul(h ^ text.charCodeAt(index), 0x01000193)
    }
    out += (h >>> 0).toString(16).padStart(8, '0')
  }
  return out.slice(0, length)
}

/** The two-sided normal tail (Abramowitz and Stegun 7.1.26). */
function twoSidedP(z: number): number {
  const x = Math.abs(z) / Math.SQRT2
  const k = 1 / (1 + 0.3275911 * x)
  const poly =
    k *
    (0.254829592 +
      k *
        (-0.284496736 +
          k * (1.421413741 + k * (-1.453152027 + k * 1.061405429))))
  return Math.min(1, Math.max(0, poly * Math.exp(-x * x)))
}

function benjaminiHochberg(p: readonly number[]): number[] {
  const order = p.map((value, index) => [value, index] as const)
  order.sort((a, b) => b[0] - a[0])
  const out = new Array<number>(p.length)
  let running = 1
  order.forEach(([value, index], rank) => {
    running = Math.min(running, (value * p.length) / (p.length - rank))
    out[index] = running
  })
  return out
}

/** The imported clinical-variables table of the fixture. */
export const MOCK_VARIABLE_TABLE: AnalysisVariableTable = {
  tableId: `var-${hex('mock-variables', 16)}`,
  name: 'clinical-variables.csv',
  idColumn: 'subject_id',
  sha256: hex('mock-variables-sha256'),
  importedAt: FIXTURE_TIME,
  rows: 34,
  unmatched: 0,
  columns: [
    {
      column: 'injury_level',
      kind: 'categorical',
      n: 33,
      levels: [
        { value: 'cervical', n: 21 },
        { value: 'thoracic-lumbar', n: 12 },
      ],
    },
    {
      column: 'neurological_level',
      kind: 'categorical',
      n: 33,
      levels: [
        { value: 'C4', n: 4 },
        { value: 'C5', n: 7 },
        { value: 'C6', n: 4 },
        { value: 'C7', n: 6 },
        { value: 'T4', n: 4 },
        { value: 'T10', n: 6 },
        { value: 'L1', n: 2 },
      ],
    },
    { column: 'UEMS', kind: 'numeric', n: 33, levels: [] },
    { column: 'LEMS', kind: 'numeric', n: 33, levels: [] },
    { column: 'light_touch', kind: 'numeric', n: 31, levels: [] },
    { column: 'pinprick', kind: 'numeric', n: 31, levels: [] },
    { column: 'age_at_injury', kind: 'numeric', n: 34, levels: [] },
  ],
}

const TABLE = MOCK_VARIABLE_TABLE.tableId
const COHORT = { source: 'registry', column: 'sourceCohortLabel' } as const
const TSI = {
  source: 'clinical-csv',
  column: 'Time since SCI (years)',
} as const

function test(
  fields: Partial<AnalysisTest> & Pick<AnalysisTest, 'id' | 'label' | 'kind'>,
): AnalysisTest {
  return {
    factor: null,
    pairwise: 'none',
    pairwiseFamily: 'pooled',
    variable: null,
    moderator: null,
    adjustForGroup: false,
    inFamily: true,
    extraCovariates: [],
    ...fields,
  }
}

/** The within-SCI battery: five tests, four outcomes. */
export const MOCK_BATTERY_SPEC: GroupAnalysisSpecV2 = {
  schema: GROUP_ANALYSIS_SPEC_SCHEMA,
  schemaVersion: 2,
  design: {
    scope: 'within',
    population: {
      grouping: {
        variable: COHORT,
        groups: [
          { label: 'SCI', levels: ['SCI_P', 'SCI_nNP'] },
          { label: 'CTRL', levels: ['CTRL'] },
        ],
      },
      groups: ['SCI'],
    },
    subset: [],
  },
  variables: {
    derived: [
      {
        id: 'dv-motor',
        label: 'ISNCSCI motor score',
        op: 'sum',
        inputs: [
          { source: 'imported', table: TABLE, column: 'UEMS' },
          { source: 'imported', table: TABLE, column: 'LEMS' },
        ],
        params: { cuts: [], labels: [] },
      },
    ],
  },
  tests: [
    test({
      id: 'tsi',
      label: 'Time since injury',
      kind: 'association',
      variable: { ref: TSI, transform: 'none' },
      inFamily: false,
    }),
    test({
      id: 'log-tsi',
      label: 'Time since injury, log(1 + x)',
      kind: 'association',
      variable: { ref: TSI, transform: 'log1p' },
    }),
    test({
      id: 'ais',
      label: 'AIS A vs B-D',
      kind: 'two-group',
      factor: {
        grouping: {
          variable: { source: 'clinical-csv', column: 'AIS' },
          groups: [
            { label: 'AIS A', levels: ['A'] },
            { label: 'AIS B-D', levels: ['B', 'C', 'D'] },
          ],
        },
        focal: 'AIS A',
        reference: 'AIS B-D',
        model: 'all-groups',
      },
    }),
    test({
      id: 'level',
      label: 'Cervical vs thoracic-lumbar',
      kind: 'two-group',
      factor: {
        grouping: {
          variable: {
            source: 'imported',
            table: TABLE,
            column: 'injury_level',
          },
          groups: [
            { label: 'Cervical', levels: ['cervical'] },
            { label: 'Thoracic-lumbar', levels: ['thoracic-lumbar'] },
          ],
        },
        focal: 'Cervical',
        reference: 'Thoracic-lumbar',
        model: 'all-groups',
      },
    }),
    test({
      id: 'motor',
      label: 'ISNCSCI motor score',
      kind: 'association',
      variable: {
        ref: { source: 'derived', column: 'dv-motor' },
        transform: 'standardize',
      },
    }),
  ],
  stratify: null,
  measures: [
    'vol:brainstem-ss:mid:Medulla',
    'aseg:Brain-Stem',
    'aseg:bi:Thalamus',
    'dk:rh:postcentral:GrayVol',
  ],
  covariates: {
    age: { source: 'registry', column: 'age' },
    sex: { source: 'registry', column: 'sex' },
    headSize: { source: 'etiv', rule: 'all' },
    extra: [],
    centering: 'sample-mean',
  },
  inclusion: {
    qc: 'non-failed',
    registration: 'set-missing',
    outliers: 'keep',
    minCellN: 3,
  },
  inference: {
    sidedness: 'two-sided',
    correction: 'bh-fdr',
    family: 'all-tests',
    omnibusGate: false,
    alpha: 0.05,
    permutations: 0,
    seed: 20260923,
  },
}

/** The omnibus design: SCI_P, SCI_nNP, and CTRL with all pairs. */
export const MOCK_OMNIBUS_SPEC: GroupAnalysisSpecV2 = {
  ...MOCK_BATTERY_SPEC,
  design: { scope: 'between', population: null, subset: [] },
  variables: { derived: [] },
  tests: [
    test({
      id: 'cohort',
      label: 'SCI_P, SCI_nNP, and CTRL',
      kind: 'omnibus',
      factor: {
        grouping: {
          variable: COHORT,
          groups: [
            { label: 'SCI_P', levels: ['SCI_P'] },
            { label: 'SCI_nNP', levels: ['SCI_nNP'] },
            { label: 'CTRL', levels: ['CTRL'] },
          ],
        },
        focal: null,
        reference: 'CTRL',
        model: 'all-groups',
      },
      pairwise: 'all-pairs',
    }),
  ],
  measures: [
    'aseg:Brain-Stem',
    'dk:bi:precentral:ThickAvg',
    'aseg:bi:Thalamus',
  ],
  covariates: {
    ...MOCK_BATTERY_SPEC.covariates,
    headSize: { source: 'etiv', rule: 'extensive' },
  },
  inference: {
    ...MOCK_BATTERY_SPEC.inference,
    correction: 'maxt-fwe',
    family: 'per-test',
    omnibusGate: true,
    permutations: 5000,
  },
}

/**
 * The stratified design: SCI vs CTRL and the age slope difference, rerun
 * per sex with heterogeneity tests, over twelve measures.
 */
export const MOCK_STRATIFIED_SPEC: GroupAnalysisSpecV2 = {
  ...MOCK_OMNIBUS_SPEC,
  tests: [
    test({
      id: 'sci',
      label: 'SCI vs CTRL',
      kind: 'two-group',
      factor: {
        grouping: {
          variable: COHORT,
          groups: [
            { label: 'SCI', levels: ['SCI_P', 'SCI_nNP'] },
            { label: 'CTRL', levels: ['CTRL'] },
          ],
        },
        focal: 'SCI',
        reference: 'CTRL',
        model: 'all-groups',
      },
    }),
    test({
      id: 'age-slope',
      label: 'Age slope, SCI vs CTRL',
      kind: 'interaction',
      factor: {
        grouping: {
          variable: COHORT,
          groups: [
            { label: 'SCI', levels: ['SCI_P', 'SCI_nNP'] },
            { label: 'CTRL', levels: ['CTRL'] },
          ],
        },
        focal: null,
        reference: 'CTRL',
        model: 'all-groups',
      },
      moderator: {
        ref: { source: 'registry', column: 'age' },
        transform: 'none',
      },
    }),
  ],
  stratify: {
    grouping: {
      variable: { source: 'registry', column: 'sex' },
      groups: [
        { label: 'Female', levels: ['F'] },
        { label: 'Male', levels: ['M'] },
      ],
    },
    heterogeneity: true,
  },
  // Age is the moderator, which models its main effect.
  covariates: { ...MOCK_OMNIBUS_SPEC.covariates, age: null },
  measures: [
    'aseg:Brain-Stem',
    'aseg:bi:Thalamus',
    'aseg:bi:Cerebellum-Cortex',
    'dk:bi:precentral:ThickAvg',
    'dk:bi:postcentral:ThickAvg',
    'dk:bi:paracentral:ThickAvg',
    'dk:bi:superiorfrontal:ThickAvg',
    'dk:bi:insula:ThickAvg',
    'dk:bi:lingual:ThickAvg',
    'dk:bi:cuneus:ThickAvg',
    'dk:bi:fusiform:ThickAvg',
    'global:meanThickness',
  ],
  inference: {
    ...MOCK_OMNIBUS_SPEC.inference,
    family: 'per-test',
    omnibusGate: false,
  },
}

interface RowDraft {
  measureId: string
  n: number
  stat: number
  df2: number
  kind: 't' | 'F'
  df1: number
  nFocal: number | null
  nReference: number | null
  association: boolean
  inFamily: boolean
}

function makeRow(termId: string, draft: RowDraft): GroupAnalysisRowV2 {
  const { stat, df1, df2 } = draft
  const t = draft.kind === 't' ? stat : null
  const F = draft.kind === 'F' ? stat : null
  const z = draft.kind === 't' ? stat : Math.sqrt(Math.max(stat, 0) * df1)
  const p = twoSidedP(z)
  const partialEta2 =
    draft.kind === 't'
      ? (stat * stat) / (stat * stat + df2)
      : (df1 * stat) / (df1 * stat + df2)
  // Every t row carries its partial r; only an association a slope per SD.
  const r = t === null ? null : t / Math.sqrt(t * t + df2)
  const zSe = 1 / Math.sqrt(Math.max(df2 - 1, 1))
  const two = t !== null && !draft.association && draft.nFocal !== null
  const k = two
    ? Math.sqrt(1 / draft.nFocal! + 1 / Math.max(draft.nReference ?? 1, 1))
    : 0
  const estimate = t === null ? null : t * 0.04
  return {
    termId,
    measureId: draft.measureId,
    family: measureFamily(draft.measureId),
    nTotal: draft.n,
    nFocal: draft.nFocal,
    nReference: draft.nReference,
    estimate,
    se: estimate === null || t === null ? null : Math.abs(estimate / t),
    t,
    F,
    df1,
    df2,
    p,
    pCorrected: null,
    significant: false,
    d: two ? t! * k : null,
    dLow: two ? t! * k - 1.96 * k : null,
    dHigh: two ? t! * k + 1.96 * k : null,
    dRawSd: two ? t! * k * 0.97 : null,
    partialEta2,
    partialR: r,
    partialRLow: r === null ? null : Math.tanh(Math.atanh(r) - 1.96 * zSe),
    partialRHigh: r === null ? null : Math.tanh(Math.atanh(r) + 1.96 * zSe),
    slopePerSd: r === null || !draft.association ? null : r * 1.1,
    pctOfReference: two ? t! * 0.9 : null,
    pHc3: Math.min(1, p * 1.06),
    pPermutation: null,
    gated: false,
    inFamily: draft.inFamily,
  }
}

/** Every term's rows, keyed by result and term, for `termRows`. */
const TERM_ROWS = new Map<string, Map<string, GroupAnalysisRowV2[]>>()

function resultOf(
  name: string,
  spec: GroupAnalysisSpecV2,
  terms: Omit<GroupAnalysisTerm, 'rowCount'>[],
  rows: Map<string, GroupAnalysisRowV2[]>,
  groups: { label: string; n: number }[],
): GroupAnalysisResultV2 {
  const first = terms[0]!.termId
  const resultId = `gar-${hex(`mock-v2:${name}`, 16)}`
  TERM_ROWS.set(resultId, rows)
  return {
    schema: GROUP_ANALYSIS_RESULT_SCHEMA,
    schemaVersion: 2,
    resultId,
    specId: null,
    name,
    spec,
    specDigest: hex(`mock-v2-digest:${name}`),
    createdAt: FIXTURE_TIME,
    engine: {
      id: GROUP_ANALYSIS_ENGINE_ID_V2,
      rng: GROUP_ANALYSIS_RNG_ID,
      productVersion: '20261121.1830.0',
      build: null,
    },
    provisional: false,
    stageCurrency: {
      aggregate: 'current',
      pybrainage: 'current',
      recon: { state: 'current', outdatedSubjectIds: [] },
    },
    inputs: [
      {
        source: 'dk-all-stats',
        present: true,
        reason: null,
        sha256: hex('v2-input:dk'),
        bytes: 612_480,
      },
      {
        source: 'labels:brainstem-ss',
        present: true,
        reason: null,
        sha256: hex('v2-input:labels'),
        bytes: 48_200,
      },
    ],
    sample: {
      groups,
      included: groups.reduce((sum, group) => sum + group.n, 0),
      excluded: [],
      issues: [],
    },
    terms: terms.map((term) => ({
      ...term,
      rowCount: rows.get(term.termId)?.length ?? 0,
    })),
    rows: rows.get(first) ?? [],
    skipped: [],
    resultSha256: hex(`mock-v2-sha:${name}`),
  }
}

function batteryResult(): GroupAnalysisResultV2 {
  const rng = makeRng(SEED)
  const spec = MOCK_BATTERY_SPEC
  const sizes: Record<string, [number, number | null, number | null]> = {
    tsi: [34, null, null],
    'log-tsi': [34, null, null],
    ais: [31, 19, 12],
    level: [33, 21, 12],
    motor: [33, null, null],
  }
  const planted: Record<string, number> = {
    'log-tsi|vol:brainstem-ss:mid:Medulla': -3.1,
    'tsi|vol:brainstem-ss:mid:Medulla': -2.7,
    'motor|aseg:Brain-Stem': 2.9,
  }
  const rows = new Map<string, GroupAnalysisRowV2[]>()
  const terms: Omit<GroupAnalysisTerm, 'rowCount'>[] = spec.tests.map(
    (item, index) => ({
      termId: `term-${index + 1}`,
      testId: item.id,
      kind: 't',
      rank: 1,
      role: 'effect',
      label: item.label,
      family: item.inFamily ? 'all-tests' : null,
      stratum: null,
      pair: null,
    }),
  )
  spec.tests.forEach((item, index) => {
    const [n, nFocal, nReference] = sizes[item.id]!
    rows.set(
      `term-${index + 1}`,
      spec.measures.map((measureId) =>
        makeRow(`term-${index + 1}`, {
          measureId,
          n,
          stat: planted[`${item.id}|${measureId}`] ?? 1.1 * normal(rng),
          df1: 1,
          df2: n - 6,
          kind: 't',
          nFocal,
          nReference,
          association: item.kind === 'association',
          inFamily: item.inFamily,
        }),
      ),
    )
  })
  // One BH family over the in-family tests x outcomes.
  const family = [...rows.values()].flat().filter((row) => row.inFamily)
  const q = benjaminiHochberg(family.map((row) => row.p))
  family.forEach((row, index) => {
    row.pCorrected = q[index]!
    row.significant = q[index]! <= spec.inference.alpha
  })
  return resultOf('Within SCI, clinical battery', spec, terms, rows, [
    { label: 'SCI', n: 34 },
  ])
}

function omnibusResult(): GroupAnalysisResultV2 {
  const rng = makeRng(SEED + 1)
  const spec = MOCK_OMNIBUS_SPEC
  const pairs = [
    ['SCI_P', 'CTRL'],
    ['SCI_nNP', 'CTRL'],
    ['SCI_nNP', 'SCI_P'],
  ] as const
  const counts: Record<string, number> = { SCI_P: 22, SCI_nNP: 12, CTRL: 48 }
  const terms: Omit<GroupAnalysisTerm, 'rowCount'>[] = [
    {
      termId: 'term-1',
      testId: 'cohort',
      kind: 'F',
      rank: 2,
      role: 'effect',
      label: 'Omnibus, 3 groups',
      family: 'cohort:F2',
      stratum: null,
      pair: null,
    },
    ...pairs.map(([focal, reference], index) => ({
      termId: `term-${index + 2}`,
      testId: 'cohort',
      kind: 't' as const,
      rank: 1,
      role: 'pairwise' as const,
      label: `${focal} vs ${reference}`,
      family: 'cohort:pairs',
      stratum: null,
      pair: { focal, reference },
    })),
  ]
  const rows = new Map<string, GroupAnalysisRowV2[]>()
  const planted: Record<string, number> = { 'aseg:Brain-Stem': 7.4 }
  rows.set(
    'term-1',
    spec.measures.map((measureId) =>
      makeRow('term-1', {
        measureId,
        n: 82,
        stat: planted[measureId] ?? Math.abs(1.2 * normal(rng)),
        df1: 2,
        df2: 76,
        kind: 'F',
        nFocal: null,
        nReference: null,
        association: false,
        inFamily: true,
      }),
    ),
  )
  pairs.forEach(([focal, reference], index) => {
    const termId = `term-${index + 2}`
    rows.set(
      termId,
      spec.measures.map((measureId) =>
        makeRow(termId, {
          measureId,
          n: counts[focal]! + counts[reference]!,
          stat:
            measureId === 'aseg:Brain-Stem' && reference === 'CTRL'
              ? -3.4
              : 1.1 * normal(rng),
          df1: 1,
          df2: 76,
          kind: 't',
          nFocal: counts[focal]!,
          nReference: counts[reference]!,
          association: false,
          inFamily: true,
        }),
      ),
    )
  })
  const floor = 1 / (spec.inference.permutations + 1)
  for (const termRows of rows.values()) {
    for (const row of termRows) {
      row.pPermutation = Math.max(row.p, floor)
      row.pCorrected = Math.min(1, Math.max(row.p * 3, floor))
      row.significant = row.pCorrected <= spec.inference.alpha
    }
  }
  const omnibus = rows.get('term-1')!
  for (const [termId, termRows] of rows) {
    if (termId === 'term-1') continue
    termRows.forEach((row, index) => {
      row.gated = !omnibus[index]!.significant
    })
  }
  return resultOf('SCI_P, SCI_nNP, and CTRL', spec, terms, rows, [
    { label: 'SCI_P', n: 22 },
    { label: 'SCI_nNP', n: 12 },
    { label: 'CTRL', n: 48 },
  ])
}

function stratifiedResult(): GroupAnalysisResultV2 {
  const rng = makeRng(SEED + 2)
  const spec = MOCK_STRATIFIED_SPEC
  const units = [
    { stratum: null, n: 82, sci: 34, ctrl: 48 },
    { stratum: 'Female', n: 30, sci: 10, ctrl: 20 },
    { stratum: 'Male', n: 52, sci: 24, ctrl: 28 },
  ] as const
  const terms: Omit<GroupAnalysisTerm, 'rowCount'>[] = []
  const rows = new Map<string, GroupAnalysisRowV2[]>()
  const add = (
    testId: string,
    label: string,
    role: GroupAnalysisTerm['role'],
    stratum: string | null,
    draft: (measureId: string, index: number) => Omit<RowDraft, 'measureId'>,
  ): void => {
    const termId = `term-${terms.length + 1}`
    terms.push({
      termId,
      testId,
      kind: 't',
      rank: 1,
      role,
      label,
      family: `${stratum === null ? 'pooled' : stratum === 'Female' ? 'stratum-1' : 'stratum-2'}:${role === 'heterogeneity' ? `${testId}:heterogeneity` : testId}:t1`,
      stratum,
      pair: null,
    })
    rows.set(
      termId,
      spec.measures.map((measureId, index) =>
        makeRow(termId, { measureId, ...draft(measureId, index) }),
      ),
    )
  }
  const effect = (index: number): number =>
    index === 0 ? -3.6 : index === 1 ? -2.4 : index === 3 ? -2.9 : 0
  for (const unit of units) {
    add('sci', 'SCI vs CTRL', 'effect', unit.stratum, (_m, index) => ({
      n: unit.n,
      stat:
        effect(index) *
          Math.sqrt(unit.n / 82) *
          (unit.stratum === 'Female' ? 0.6 : 1) +
        0.9 * normal(rng),
      df2: unit.n - 6,
      kind: 't',
      df1: 1,
      nFocal: unit.sci,
      nReference: unit.ctrl,
      association: false,
      inFamily: true,
    }))
  }
  add(
    'sci',
    'Heterogeneity of SCI vs CTRL across strata',
    'heterogeneity',
    null,
    (_m, index) => ({
      n: 82,
      stat: index === 3 ? 2.6 : 0.8 * normal(rng),
      df2: 74,
      kind: 't',
      df1: 1,
      nFocal: null,
      nReference: null,
      association: true,
      inFamily: true,
    }),
  )
  for (const unit of units) {
    add(
      'age-slope',
      'Age slope, SCI vs CTRL',
      'effect',
      unit.stratum,
      (_m, index) => ({
        n: unit.n,
        stat: (index === 1 ? -2.8 : 0) + 0.9 * normal(rng),
        df2: unit.n - 7,
        kind: 't',
        df1: 1,
        nFocal: null,
        nReference: null,
        association: true,
        inFamily: true,
      }),
    )
  }
  add(
    'age-slope',
    'Heterogeneity of Age slope, SCI vs CTRL across strata',
    'heterogeneity',
    null,
    () => ({
      n: 82,
      stat: 0.8 * normal(rng),
      df2: 72,
      kind: 't',
      df1: 1,
      nFocal: null,
      nReference: null,
      association: true,
      inFamily: true,
    }),
  )
  const floor = 1 / (spec.inference.permutations + 1)
  for (const termRows of rows.values()) {
    for (const row of termRows) {
      row.pPermutation = Math.max(row.p, floor)
      row.pCorrected = Math.min(1, Math.max(row.p * 4, floor))
      row.significant = row.pCorrected <= spec.inference.alpha
    }
  }
  return resultOf('SCI vs CTRL by sex, with the age slope', spec, terms, rows, [
    { label: 'SCI', n: 34 },
    { label: 'CTRL', n: 48 },
  ])
}

/** The within-SCI battery result. */
export const MOCK_BATTERY_RESULT: GroupAnalysisResultV2 = batteryResult()
/** The omnibus result with its pairwise terms. */
export const MOCK_OMNIBUS_RESULT: GroupAnalysisResultV2 = omnibusResult()
/** The stratified result with its heterogeneity and slope-difference terms. */
export const MOCK_STRATIFIED_RESULT: GroupAnalysisResultV2 = stratifiedResult()
/** The v2 results the mock serves. */
export const MOCK_V2_RESULTS: readonly GroupAnalysisResultV2[] = [
  MOCK_BATTERY_RESULT,
  MOCK_OMNIBUS_RESULT,
  MOCK_STRATIFIED_RESULT,
]

/**
 * Page one term's rows of a fixture result.
 *
 * @throws Error for an unknown result, term, or offset.
 */
export function mockTermRows(
  resultId: string,
  termId: string,
  offset: number,
): GroupAnalysisTermRows {
  const rows = TERM_ROWS.get(resultId)?.get(termId)
  if (!rows || offset > rows.length) {
    throw new Error('Select a term this result contains.')
  }
  const page = rows.slice(offset, offset + GROUP_ANALYSIS_TERM_PAGE_ROWS)
  const next = offset + page.length
  return {
    resultId,
    termId,
    offset,
    total: rows.length,
    rows: page,
    nextOffset: next < rows.length ? next : null,
  }
}

/**
 * Synthesize one measure of one term: subject values in the term's model
 * with the adjusted group means of a group test, and for an association or
 * slope difference the fitted lines with their bands and simple slopes.
 *
 * @returns The detail, or null outside the fixture.
 */
export function mockMeasureDetailV2(
  resultId: string,
  measureId: string,
  termId: string,
): GroupAnalysisMeasureDetailV2 | null {
  const result = MOCK_V2_RESULTS.find((item) => item.resultId === resultId)
  const row = TERM_ROWS.get(resultId)
    ?.get(termId)
    ?.find((item) => item.measureId === measureId)
  const term = result?.terms.find((item) => item.termId === termId)
  if (!result || !row || !term) return null
  const testSpec = result.spec.tests.find((item) => item.id === term.testId)!
  const rng = makeRng(SEED * 100 + measureId.length + Number(termId.slice(5)))
  const base = measureId.startsWith('dk:') ? 2.5 : 21_000
  const spread = measureId.startsWith('dk:') ? 0.12 : 1500
  const slope = ((row.estimate ?? 0) * spread) / 0.08
  const subjectId = (index: number): string =>
    `sub-${String(index + 1).padStart(3, '0')}`
  // A tested variable: the values against it and one line with its band.
  if (testSpec.kind === 'association') {
    const subjects = Array.from({ length: row.nTotal }, (_, index) => {
      const x = 0.5 + 12 * rng()
      const adjusted = base + (slope / 6) * (x - 6.5) + spread * normal(rng)
      return {
        subjectId: subjectId(index + 48),
        group: null,
        sourceLabel: index < 22 ? 'SCI_P' : 'SCI_nNP',
        value: adjusted + spread * 0.03 * normal(rng),
        adjusted,
        x,
      }
    })
    const xs = Array.from({ length: 50 }, (_, index) => 0.5 + (12 * index) / 49)
    const half = (x: number): number =>
      spread * (0.35 + 0.05 * Math.abs(x - 6.5))
    return {
      resultId,
      measureId,
      termId,
      row,
      groupMeans: [],
      subjects,
      fit: [
        {
          group: null,
          x: xs,
          y: xs.map((x) => base + (slope / 6) * (x - 6.5)),
          low: xs.map((x) => base + (slope / 6) * (x - 6.5) - half(x)),
          high: xs.map((x) => base + (slope / 6) * (x - 6.5) + half(x)),
        },
      ],
      simpleSlopes: [],
    }
  }
  const factor = testSpec.factor!
  const labels = term.pair
    ? factor.grouping.groups
        .map((group) => group.label)
        .filter((label) =>
          factor.model === 'compared-groups'
            ? label === term.pair!.focal || label === term.pair!.reference
            : true,
        )
    : factor.grouping.groups.map((group) => group.label)
  const sized = new Map(result.sample.groups.map((g) => [g.label, g.n]))
  const counts = labels.map((label) =>
    label === (term.pair?.focal ?? factor.focal) && row.nFocal !== null
      ? row.nFocal
      : label === (term.pair?.reference ?? factor.reference) &&
          row.nReference !== null
        ? row.nReference
        : Math.max(3, Math.round((sized.get(label) ?? 20) * (row.nTotal / 82))),
  )
  const focal = term.pair?.focal ?? factor.focal
  const reference = term.pair?.reference ?? factor.reference
  const shift = (label: string, index: number): number =>
    label === reference
      ? 0
      : ((row.d ?? row.t ?? 0) * spread * 0.25 * (index + 1)) / labels.length
  const interaction = testSpec.kind === 'interaction'
  const subjects: GroupAnalysisMeasureDetailV2['subjects'] = []
  let next = 0
  labels.forEach((label, g) => {
    for (let k = 0; k < counts[g]!; k += 1) {
      const x = interaction ? 18 + 55 * rng() : null
      const groupSlope = interaction
        ? label === reference
          ? -8
          : -8 + (row.t ?? 0) * 6
        : 0
      const adjusted =
        base +
        shift(label, g) +
        (x === null ? 0 : (groupSlope * spread * (x - 45)) / 1500) +
        spread * normal(rng)
      subjects.push({
        subjectId: subjectId(next++),
        group: label,
        sourceLabel:
          label === 'SCI' ? (k % 4 === 0 ? 'SCI_nNP' : 'SCI_P') : label,
        value: adjusted + spread * 0.03 * normal(rng),
        adjusted,
        x,
      })
    }
  })
  const groupMeans = labels.map((label, g) => {
    const mean = base + shift(label, g)
    const half = (spread * 2) / Math.sqrt(counts[g]!)
    return {
      label,
      role:
        label === focal
          ? ('focal' as const)
          : label === reference
            ? ('reference' as const)
            : ('other' as const),
      n: counts[g]!,
      mean,
      low: mean - half,
      high: mean + half,
    }
  })
  if (!interaction) {
    return {
      resultId,
      measureId,
      termId,
      row,
      groupMeans,
      subjects,
      fit: [],
      simpleSlopes: [],
    }
  }
  const xs = Array.from({ length: 50 }, (_, index) => 18 + (55 * index) / 49)
  const lines = labels.map((label, g) => {
    const groupSlope = label === reference ? -8 : -8 + (row.t ?? 0) * 6
    const at = (x: number): number =>
      base + shift(label, g) + (groupSlope * spread * (x - 45)) / 1500
    const half = (x: number): number =>
      (spread * (0.5 + 0.02 * Math.abs(x - 45))) / Math.sqrt(counts[g]! / 10)
    return {
      group: label,
      slope: (groupSlope * spread) / 1500,
      x: xs,
      y: xs.map(at),
      low: xs.map((x) => at(x) - half(x)),
      high: xs.map((x) => at(x) + half(x)),
    }
  })
  return {
    resultId,
    measureId,
    termId,
    row,
    groupMeans,
    subjects,
    fit: lines.map(({ group, x, y, low, high }) => ({
      group,
      x,
      y,
      low,
      high,
    })),
    simpleSlopes: lines.map((line) => ({
      group: line.group,
      slope: line.slope,
      low: line.slope - Math.abs(line.slope) * 0.6 - spread * 0.002,
      high: line.slope + Math.abs(line.slope) * 0.6 + spread * 0.002,
    })),
  }
}

/** The list summary of one v2 fixture result. */
export function mockV2Summary(
  result: GroupAnalysisResultV2,
): GroupAnalysisResultSummary {
  const rows = [...(TERM_ROWS.get(result.resultId)?.values() ?? [])].flat()
  return {
    resultId: result.resultId,
    schemaVersion: 2,
    specId: result.specId,
    name: result.name,
    analysis: null,
    specDigest: result.specDigest,
    createdAt: result.createdAt,
    measureCount: result.spec.measures.length,
    significantCount: rows.filter((row) => row.significant).length,
    groups: result.sample.groups,
    provisional: result.provisional,
    pinned: false,
    currency: 'current',
    staleReasons: [],
  }
}

const SUBJECTS = 82

function entry(
  fields: Partial<AtlasEntry> &
    Pick<
      AtlasEntry,
      'atlasId' | 'label' | 'tier' | 'kind' | 'origin' | 'namespace'
    >,
): AtlasEntry {
  return {
    recipeId: null,
    externalSourceId: null,
    available: true,
    unavailableReason: null,
    counts: {
      total: SUBJECTS,
      withFiles: SUBJECTS,
      labeled: 0,
      stale: 0,
      failed: 0,
      reconOutdated: 0,
    },
    estimateSeconds: null,
    license: null,
    citation: null,
    ...fields,
  }
}

/**
 * The machine-level state the labeling and atlas-source mocks share: the
 * subregions interpreter, downloaded sources, and added atlases.
 */
export interface MockAtlasMachine {
  subregionsPython: string | null
  downloaded: Set<string>
  added: AtlasEntry[]
}

/** A new machine state with nothing chosen, downloaded, or added. */
export function mockAtlasMachine(): MockAtlasMachine {
  return { subregionsPython: null, downloaded: new Set(), added: [] }
}

/** The interpreter the mock's chooser picks. */
export const MOCK_SUBREGIONS_PYTHON = '/opt/py312/bin/python'

function downloadedEntries(machine: MockAtlasMachine): AtlasEntry[] {
  const schaefer = ATLAS_SOURCES.find((s) => s.sourceId === 'schaefer2018')!
  if (!machine.downloaded.has('schaefer2018')) return []
  return schaefer.atlasIds.map((atlasId) => {
    const [, parcels, networks] = /^schaefer(\d+)-(\d+)$/.exec(atlasId)!
    return entry({
      atlasId,
      label: `Schaefer 2018, ${parcels} parcels, ${networks} networks`,
      tier: 'B',
      kind: 'surface',
      origin: 'added',
      namespace: 'parc',
      recipeId: 'user-annot',
      externalSourceId: 'schaefer2018',
      counts: {
        total: SUBJECTS,
        withFiles: 0,
        labeled: 0,
        stale: 0,
        failed: 0,
        reconOutdated: 1,
      },
      estimateSeconds: SUBJECTS * 60,
      license: {
        name: schaefer.license.name,
        url: schaefer.license.url,
        acknowledgedAt: FIXTURE_TIME,
      },
      citation: schaefer.citation,
    })
  })
}

/** The atlas catalog of the fixture: tier A sources, tier B states. */
export function mockAtlasCatalog(
  labeling: AtlasLabelOperation | null = null,
  machine: MockAtlasMachine = mockAtlasMachine(),
  outdatedRecons = 0,
): AtlasCatalog {
  const counts = (withFiles: number, labeled = 0, stale = 0, failed = 0) => ({
    total: SUBJECTS,
    withFiles,
    labeled,
    stale,
    failed,
    // One recon is running; the renderer names the out-of-date ones.
    reconOutdated: 1 + outdatedRecons,
  })
  const python = machine.subregionsPython
  return {
    configRevision: 0,
    revision: 3,
    atlases: [
      entry({
        atlasId: 'dk',
        label: 'Desikan-Killiany',
        tier: 'A',
        kind: 'surface',
        origin: 'pipeline',
        namespace: 'dk',
      }),
      entry({
        atlasId: 'aseg',
        label: 'Subcortical segmentation (aseg)',
        tier: 'A',
        kind: 'volume',
        origin: 'pipeline',
        namespace: 'aseg',
      }),
      entry({
        atlasId: 'a2009s',
        label: 'Destrieux (aparc.a2009s)',
        tier: 'A',
        kind: 'surface',
        origin: 'recon-stats',
        namespace: 'parc',
        counts: counts(SUBJECTS),
      }),
      entry({
        atlasId: 'wmparc',
        label: 'White-matter parcellation (wmparc)',
        tier: 'A',
        kind: 'volume',
        origin: 'recon-stats',
        namespace: 'vol',
        counts: counts(SUBJECTS - 4),
      }),
      entry({
        atlasId: 'synthseg',
        label: 'SynthSeg volumes',
        tier: 'A',
        kind: 'volume',
        origin: 'recon-stats',
        namespace: 'vol',
        available: false,
        unavailableReason: 'No subject has synthseg.vol.csv.',
        counts: counts(0),
      }),
      entry({
        atlasId: 'dkt',
        label: 'DKT (aparc.DKTatlas)',
        tier: 'A',
        kind: 'surface',
        origin: 'recon-stats',
        namespace: 'parc',
        available: false,
        unavailableReason: 'No subject has these FreeSurfer stats files yet.',
        counts: counts(0),
      }),
      entry({
        atlasId: 'brainstem-ss',
        label: 'Brainstem subfields',
        tier: 'B',
        kind: 'volume',
        origin: 'labeled',
        namespace: 'vol',
        recipeId: 'brainstem-ss',
        counts: counts(3, 20, 2, 1),
        estimateSeconds: (SUBJECTS - 23) * 720,
        citation:
          'Iglesias JE, et al. Bayesian segmentation of brainstem structures in MRI. NeuroImage. 2015;113:184-195.',
      }),
      entry({
        atlasId: 'thalamic',
        label: 'Thalamic nuclei',
        tier: 'B',
        kind: 'volume',
        origin: 'labeled',
        namespace: 'vol',
        recipeId: 'thalamic',
        counts: counts(0),
        estimateSeconds: SUBJECTS * 840,
      }),
      entry({
        atlasId: 'yeo7',
        label: 'Yeo 2011, 7 networks',
        tier: 'B',
        kind: 'surface',
        origin: 'labeled',
        namespace: 'parc',
        recipeId: 'yeo7',
        counts: counts(0, SUBJECTS),
        estimateSeconds: 0,
      }),
      entry({
        atlasId: 'user-0a1b2c3d',
        label: 'Schaefer 2018, 400 parcels, 7 networks',
        tier: 'B',
        kind: 'surface',
        origin: 'added',
        namespace: 'parc',
        recipeId: 'user-gcs',
        externalSourceId: 'schaefer2018',
        counts: counts(0, 0),
        estimateSeconds: SUBJECTS * 90,
        license: {
          name: 'MIT',
          url: 'https://github.com/ThomasYeoLab/CBIG/blob/master/LICENSE.md',
          acknowledgedAt: FIXTURE_TIME,
        },
      }),
      ...downloadedEntries(machine),
      ...machine.added,
    ],
    tools: [
      {
        toolId: 'freesurfer-home',
        state: 'ok',
        detail: 'FreeSurfer 8.2.0 is set as the FreeSurfer home.',
        fix: null,
      },
      python
        ? {
            toolId: 'segment-subregions',
            state: 'ok',
            detail:
              'FreeSurfer 8.2.0 segment_subregions runs with the chosen Python 3.12.',
            fix: null,
          }
        : {
            toolId: 'segment-subregions',
            state: 'broken',
            detail:
              'FreeSurfer 8.2.0 segment_subregions cannot start: fspython 3.8 cannot load samseg.',
            fix: 'choose-subregions-python',
          },
      python
        ? {
            toolId: 'subregions-python',
            state: 'ok',
            detail: 'Python 3.12.10 imports samseg.',
            fix: null,
          }
        : {
            toolId: 'subregions-python',
            state: 'missing',
            detail: 'No Python 3.12 environment is chosen for subregions.',
            fix: 'choose-subregions-python',
          },
      {
        toolId: 'mris-ca-label',
        state: 'ok',
        detail: 'mris_ca_label is available.',
        fix: null,
      },
    ],
    subregionsPython: python,
    labeling,
  }
}

/** A labeling operation partway through, for previews and tests. */
export const MOCK_LABELING_PROGRESS: AtlasLabelOperation = {
  operationId: `alb-${hex('mock-labeling', 16)}`,
  atlasId: 'brainstem-ss',
  state: 'running',
  completed: 7,
  failed: 1,
  skipped: 1,
  total: 20,
  current: { subjectId: 'sub-071', startedAt: FIXTURE_TIME },
  startedAt: FIXTURE_TIME,
  finishedAt: null,
  remainingSeconds: 11 * 720,
  message: null,
}

/** One subject's brainstem label state in the fixture. */
function subjectLabel(index: number): SubjectLabelStatus {
  const subjectId = `sub-${String(index + 1).padStart(3, '0')}`
  if (index < 20) {
    return {
      subjectId,
      state: 'current',
      staleReasons: [],
      provenance: index < 4 ? 'imported' : 'labeled',
      updatedAt: FIXTURE_TIME,
      seconds: index < 4 ? null : 610 + index * 7,
      message: null,
    }
  }
  if (index < 22) {
    return {
      subjectId,
      state: 'stale',
      staleReasons: ['recon-changed'],
      provenance: 'labeled',
      updatedAt: FIXTURE_TIME,
      seconds: 655,
      message: null,
    }
  }
  if (index === 22) {
    return {
      subjectId,
      state: 'failed',
      staleReasons: [],
      provenance: null,
      updatedAt: FIXTURE_TIME,
      seconds: 48,
      message: 'segment_subregions stopped with exit code 1.',
    }
  }
  return {
    subjectId,
    state: 'missing',
    staleReasons: [],
    provenance: null,
    updatedAt: null,
    seconds: null,
    message: null,
  }
}

/** The status reads a mock labeling takes before it finishes. */
export const MOCK_LABEL_POLLS = 3

type LabelingDomain = Pick<
  SupraspinaApi['groupAnalysis'],
  | 'atlases'
  | 'labelStart'
  | 'labelStatus'
  | 'labelCancel'
  | 'clearLabels'
  | 'chooseAtlasFiles'
  | 'chooseLabelsFolder'
>

/**
 * Build the stateful labeling part of the `groupAnalysis` mock: a start
 * runs for `MOCK_LABEL_POLLS` status reads, then finishes.
 */
export function createMockLabeling(
  machine: MockAtlasMachine = mockAtlasMachine(),
): LabelingDomain {
  latestMachine = machine
  let operation: AtlasLabelOperation | null = null
  let polls = 0
  let revision = 3
  let counter = 0
  return {
    atlases: async (request) => ({
      ...mockAtlasCatalog(
        operation,
        machine,
        request?.reconOutdatedSubjectIds?.length ?? 0,
      ),
      revision,
    }),
    labelStart: async ({ atlasId, subjects }) => {
      if (operation?.state === 'running') {
        return { operation, started: false }
      }
      counter += 1
      polls = 0
      const total = Array.isArray(subjects)
        ? subjects.length
        : subjects === 'stale'
          ? 2
          : SUBJECTS - 23
      operation = {
        operationId: `alb-${hex(`mock-labeling:${counter}`, 16)}`,
        atlasId,
        state: 'running',
        completed: 0,
        failed: 0,
        skipped: 0,
        total,
        current: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        remainingSeconds: total * 720,
        message: null,
      }
      return { operation, started: true }
    },
    labelStatus: async ({ atlasId }) => {
      if (operation?.state === 'running') {
        polls += 1
        const done = polls >= MOCK_LABEL_POLLS
        const completed = done
          ? operation.total
          : Math.round((operation.total * polls) / MOCK_LABEL_POLLS)
        operation = {
          ...operation,
          state: done ? 'done' : 'running',
          completed,
          current: done
            ? null
            : { subjectId: 'sub-071', startedAt: operation.startedAt },
          finishedAt: done ? new Date().toISOString() : null,
          remainingSeconds: done ? null : (operation.total - completed) * 720,
        }
      }
      const shown = atlasId ?? operation?.atlasId ?? null
      return {
        operation,
        atlasId: shown,
        subjects:
          shown === 'brainstem-ss'
            ? Array.from({ length: SUBJECTS }, (_, index) =>
                subjectLabel(index),
              )
            : [],
      }
    },
    labelCancel: async ({ operationId }) => {
      const stopped =
        operation?.operationId === operationId && operation.state === 'running'
      if (operation && stopped) {
        operation = {
          ...operation,
          state: 'cancelled',
          current: null,
          finishedAt: new Date().toISOString(),
          remainingSeconds: null,
        }
      }
      return { operationId, stopped }
    },
    clearLabels: async ({ subjects, expectedRevision }) => {
      if (expectedRevision !== revision) {
        throw new Error('Load the atlases again; the labels changed.')
      }
      revision += 1
      return {
        revision,
        cleared: subjects === 'all' ? 23 : subjects.length,
      }
    },
    chooseAtlasFiles: async ({
      recipeId,
      label,
      license,
      externalSourceId,
    }) => {
      counter += 1
      const atlas = entry({
        atlasId: `user-${hex(`mock-added:${counter}:${label}`, 8)}`,
        label,
        tier: 'B',
        kind: recipeId === 'user-volume' ? 'volume' : 'surface',
        origin: 'added',
        namespace: recipeId === 'user-volume' ? 'vol' : 'parc',
        recipeId,
        externalSourceId,
        counts: {
          total: SUBJECTS,
          withFiles: 0,
          labeled: 0,
          stale: 0,
          failed: 0,
          reconOutdated: 1,
        },
        estimateSeconds: SUBJECTS * (recipeId === 'user-volume' ? 30 : 90),
        license: { ...license, acknowledgedAt: new Date().toISOString() },
      })
      machine.added.push(atlas)
      return { atlas }
    },
    chooseLabelsFolder: async ({ atlasId }) => ({
      atlasId,
      imported: 4,
      unrecognized: ['sub-090'],
    }),
  }
}

/** The machine state of the most recent mock, shared with its sources. */
let latestMachine: MockAtlasMachine | null = null

/** The download status reads a mock download takes before it finishes. */
export const MOCK_DOWNLOAD_POLLS = 3

/**
 * Build the `atlasSources` mock domain: every source is listed, Schaefer
 * 2018 (pinned files) downloads over `MOCK_DOWNLOAD_POLLS` status reads,
 * and the others offer only their page. It shares the machine state of
 * the labeling mock built just before it (as `createMockApi` builds them),
 * so a chosen interpreter or a download shows in the atlas catalog.
 *
 * @param machine - The shared machine state; the latest one when omitted.
 */
export function createMockAtlasSources(
  machine: MockAtlasMachine = latestMachine ?? mockAtlasMachine(),
): SupraspinaApi['atlasSources'] {
  let operation: AtlasDownloadOperation | null = null
  let polls = 0
  let counter = 0
  const listing = () =>
    ATLAS_SOURCES.map((source) => {
      const downloadable = source.files.length > 0 && !source.requiresLogin
      const present = machine.downloaded.has(source.sourceId)
      return {
        source,
        state: present ? ('present' as const) : ('absent' as const),
        cached: present
          ? {
              version: source.version,
              retrievedAt: FIXTURE_TIME,
              bytes: source.files.reduce((sum, file) => sum + file.bytes, 0),
            }
          : null,
        downloadable,
      }
    })
  return {
    list: async () => ({
      cacheDisplayPath: '~/.config/Supraspina/atlases',
      sources: listing(),
    }),
    download: async ({ sourceId }) => {
      const source = ATLAS_SOURCES.find((item) => item.sourceId === sourceId)
      if (!source || source.files.length === 0 || source.requiresLogin) {
        throw new Error('This source has no verified download; open its page.')
      }
      if (operation?.state === 'running') return { operation, started: false }
      counter += 1
      polls = 0
      operation = {
        operationId: `adl-${hex(`mock-download:${counter}`, 16)}`,
        sourceId,
        state: 'running',
        receivedBytes: 0,
        totalBytes: source.files.reduce((sum, file) => sum + file.bytes, 0),
        file: source.files[0]!.relpath,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message: null,
      }
      return { operation, started: true }
    },
    status: async () => {
      if (operation?.state === 'running') {
        polls += 1
        const done = polls >= MOCK_DOWNLOAD_POLLS
        const source = ATLAS_SOURCES.find(
          (item) => item.sourceId === operation!.sourceId,
        )!
        const index = Math.min(
          source.files.length - 1,
          Math.floor((source.files.length * polls) / MOCK_DOWNLOAD_POLLS),
        )
        operation = {
          ...operation,
          state: done ? 'done' : 'running',
          receivedBytes: done
            ? operation.totalBytes
            : Math.round((operation.totalBytes * polls) / MOCK_DOWNLOAD_POLLS),
          file: done ? null : source.files[index]!.relpath,
          finishedAt: done ? new Date().toISOString() : null,
        }
        if (done) machine.downloaded.add(operation.sourceId)
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
          file: null,
          finishedAt: new Date().toISOString(),
        }
      }
      return { operationId, stopped }
    },
    openPage: async () => undefined,
    chooseSubregionsPython: async () => {
      machine.subregionsPython = MOCK_SUBREGIONS_PYTHON
      return MOCK_SUBREGIONS_PYTHON
    },
    clearSubregionsPython: async () => {
      machine.subregionsPython = null
    },
  }
}
