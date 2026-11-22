/** Tests for spec v2: fixtures, digests, upgrade, grammar v2, results v2. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalSpecJson,
  defaultBinLabels,
  GROUP_ANALYSIS_REQUEST_FIELDS,
  isExtensiveMeasure,
  isMeasureIdV1,
  joinHemisphereToken,
  measureFamily,
  parseAnyGroupAnalysisSpec,
  parseGroupAnalysisInputs,
  parseGroupAnalysisMeasureDetail,
  parseGroupAnalysisResult,
  parseGroupAnalysisSpec,
  parseGroupAnalysisTermRows,
  parseMeasureId,
  poolsInAllTests,
  REGISTRY_VARIABLES,
  splitHemisphereToken,
  testRank,
  upgradeGroupAnalysisSpecV1,
  validateAnalysisStageCurrency,
  validateAnyGroupAnalysisSpec,
  validateGroupAnalysisRequest,
  type GroupAnalysisSpec,
  type GroupAnalysisSpecV2,
  type HemisphereTokenRule,
} from './group-analysis'

const FIXTURES = resolve(
  __dirname,
  '../../sidecar/tests/fixtures/group_analysis',
)
const NAMES = [
  'two-group',
  'omnibus',
  'within-battery',
  'interaction',
  'stratified',
] as const

function fixture(name: string): {
  spec: GroupAnalysisSpecV2
  specDigest: string
  upgradedFrom?: string
} {
  return JSON.parse(
    readFileSync(resolve(FIXTURES, `spec-v2-${name}.json`), 'utf8'),
  ) as { spec: GroupAnalysisSpecV2; specDigest: string; upgradedFrom?: string }
}

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

const PROJECT = {
  projectId: 'analysis-project',
  root: '/data/study',
  configPath: '/data/study/supraspina.project.json',
  epoch: 1,
}

describe('spec v2 fixtures', () => {
  it.each(NAMES)('%s parses and matches the sidecar digest', (name) => {
    const { spec, specDigest } = fixture(name)
    const parsed = parseAnyGroupAnalysisSpec(spec)
    expect(parsed.schemaVersion).toBe(2)
    expect(sha256(canonicalSpecJson(parsed))).toBe(specDigest)
  })

  it('upgrades the v1 example to the two-group fixture', () => {
    const { spec, upgradedFrom } = fixture('two-group')
    const v1 = JSON.parse(
      readFileSync(resolve(FIXTURES, upgradedFrom!), 'utf8'),
    ) as { spec: GroupAnalysisSpec; specDigest: string }
    const upgraded = upgradeGroupAnalysisSpecV1(parseGroupAnalysisSpec(v1.spec))
    expect(upgraded).toEqual(spec)
    // The v1 spec keeps its own digest.
    expect(sha256(canonicalSpecJson(v1.spec))).toBe(v1.specDigest)
    expect(sha256(canonicalSpecJson(upgraded))).not.toBe(v1.specDigest)
  })

  it('upgrades an association with included groups to a subset and factor', () => {
    const example = JSON.parse(
      readFileSync(resolve(FIXTURES, 'spec-v1-example.json'), 'utf8'),
    ) as { spec: GroupAnalysisSpec }
    const v1: GroupAnalysisSpec = {
      ...example.spec,
      analysis: 'association',
      contrast: {
        type: 'association',
        variable: { source: 'clinical-csv', column: 'pain_nrs' },
        grouping: {
          variable: { source: 'registry', column: 'sourceCohortLabel' },
          groups: [
            { label: 'SCI', levels: ['SCI_nNP', 'SCI_P'] },
            { label: 'CTRL', levels: ['CTRL'] },
          ],
        },
        includedGroups: ['SCI'],
        adjustForGroup: false,
      },
      covariates: {
        age: { source: 'registry', column: 'age' },
        sex: { source: 'registry', column: 'sex' },
        etiv: 'all',
        extra: [],
        centering: 'sample-mean',
      },
      inference: {
        sidedness: 'higher',
        correction: 'bh-fdr',
        family: 'per-family',
        alpha: 0.05,
        permutations: 0,
        seed: 1,
      },
    }
    const upgraded = upgradeGroupAnalysisSpecV1(parseGroupAnalysisSpec(v1))
    expect(upgraded.tests[0]).toMatchObject({
      kind: 'association',
      factor: null,
      variable: {
        ref: { source: 'clinical-csv', column: 'pain_nrs' },
        transform: 'none',
      },
    })
    expect(upgraded.design.subset).toEqual([
      {
        variable: { source: 'registry', column: 'sourceCohortLabel' },
        keep: { levels: ['SCI_nNP', 'SCI_P'] },
      },
    ])
    expect(upgraded.covariates.headSize).toEqual({
      source: 'etiv',
      rule: 'all',
    })
    expect(upgraded.inference.family).toBe('per-measure-family')
    expect(validateAnyGroupAnalysisSpec(upgraded).ok).toBe(true)
  })

  it('ignores the order of set-like arrays but not of tests', () => {
    const { spec, specDigest } = fixture('within-battery')
    const reordered = structuredClone(spec)
    reordered.measures.reverse()
    reordered.design.population!.grouping.groups[0]!.levels.reverse()
    expect(sha256(canonicalSpecJson(reordered))).toBe(specDigest)
    const tests = structuredClone(spec)
    tests.tests.reverse()
    expect(sha256(canonicalSpecJson(tests))).not.toBe(specDigest)
  })
})

function mutated(
  name: string,
  change: (spec: GroupAnalysisSpecV2) => void,
): unknown {
  const spec = structuredClone(fixture(name).spec)
  change(spec)
  return spec
}

describe('spec v2 validation', () => {
  it.each([
    [
      'within-battery',
      (s: GroupAnalysisSpecV2) => {
        s.design.population = null
      },
      'Choose the population for a within-group design.',
    ],
    [
      'omnibus',
      (s: GroupAnalysisSpecV2) => {
        s.tests[0]!.factor!.grouping.groups.shift()
      },
      'Define three or more groups for an omnibus test.',
    ],
    [
      'omnibus',
      (s: GroupAnalysisSpecV2) => {
        s.inference.sidedness = 'lower'
      },
      'Choose a two-sided test: an F test has no direction.',
    ],
    [
      'within-battery',
      (s: GroupAnalysisSpecV2) => {
        s.tests.forEach((t) => (t.inFamily = false))
      },
      'Keep one or more tests in the correction family.',
    ],
    [
      'within-battery',
      (s: GroupAnalysisSpecV2) => {
        s.variables.derived = []
      },
      'Define every derived variable the analysis uses.',
    ],
    [
      'stratified',
      (s: GroupAnalysisSpecV2) => {
        s.variables.derived[0]!.params.cuts = [60.5, 40]
      },
      'Give the bin cut points in increasing order.',
    ],
    [
      'interaction',
      (s: GroupAnalysisSpecV2) => {
        s.covariates.age = { source: 'registry', column: 'age' }
      },
      'Do not adjust for the tested variable.',
    ],
    [
      'interaction',
      (s: GroupAnalysisSpecV2) => {
        s.design.subset[0]!.keep = { min: 90, max: 18 }
      },
      'Give each subset filter a minimum no larger than its maximum.',
    ],
    [
      'two-group',
      (s: GroupAnalysisSpecV2) => {
        s.tests[0]!.pairwise = 'all-pairs'
      },
      'Choose pairwise comparisons only for an omnibus test.',
    ],
    [
      'two-group',
      (s: GroupAnalysisSpecV2) => {
        s.tests.push({ ...structuredClone(s.tests[0]!) })
      },
      'Give each test a different ID.',
    ],
    [
      'omnibus',
      (s: GroupAnalysisSpecV2) => {
        s.tests.push({
          ...structuredClone(fixture('two-group').spec.tests[0]!),
          id: 't2',
        })
        s.inference.family = 'all-tests'
      },
      'Correct each test separately, or choose Holm, Bonferroni, or BH-FDR to correct t and F tests together.',
    ],
  ])('%s: %s', (name, change, message) => {
    const result = validateAnyGroupAnalysisSpec(mutated(name, change))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toBe(message)
  })

  it('ranks a test as the engine fits it', () => {
    const slope = fixture('interaction').spec.tests[0]!
    const omnibus = fixture('omnibus').spec.tests[0]!
    // Two groups: a numeric (or unknown) moderator is one product, a
    // categorical one (k - 1)(m - 1).
    expect(testRank(slope)).toBe(1)
    expect(testRank(slope, 2)).toBe(1)
    expect(testRank(slope, 3)).toBe(2)
    const three = { ...slope, factor: omnibus.factor }
    expect(testRank(three)).toBe(2)
    expect(testRank(three, 4)).toBe(6)
    expect(testRank(omnibus)).toBe(2)
    expect(poolsInAllTests(omnibus)).toBe(true)
    expect(poolsInAllTests(slope)).toBe(false)
  })

  it('lets max-T over all tests ignore interactions and sensitivity tests', () => {
    const spec = structuredClone(fixture('omnibus').spec)
    const slope = structuredClone(fixture('interaction').spec.tests[0]!)
    slope.extraCovariates = []
    slope.moderator!.ref = { source: 'registry', column: 'tSinceSci' }
    spec.tests.push(slope)
    spec.tests[0]!.pairwise = 'none'
    spec.inference.family = 'all-tests'
    spec.inference.omnibusGate = false
    expect(validateAnyGroupAnalysisSpec(spec).ok).toBe(true)
    const twoGroup = {
      ...structuredClone(fixture('two-group').spec.tests[0]!),
      id: 't2',
    }
    spec.tests.push({ ...twoGroup, inFamily: false })
    expect(validateAnyGroupAnalysisSpec(spec).ok).toBe(true)
    spec.tests[2]!.inFamily = true
    const result = validateAnyGroupAnalysisSpec(spec)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/^Correct each test separately/)
    }
  })

  it('refuses unknown keys and v2 measures in spec v1', () => {
    expect(
      validateAnyGroupAnalysisSpec(
        mutated('two-group', (s) => {
          ;(s as unknown as Record<string, unknown>).analysis = 'x'
        }),
      ).ok,
    ).toBe(false)
    const v1 = JSON.parse(
      readFileSync(resolve(FIXTURES, 'spec-v1-example.json'), 'utf8'),
    ) as { spec: GroupAnalysisSpec }
    const withParc = structuredClone(v1.spec)
    withParc.measures = ['parc:a2009s:lh:G_precentral:ThickAvg']
    expect(validateAnyGroupAnalysisSpec(withParc).ok).toBe(false)
  })
})

describe('measure ID grammar v2', () => {
  it.each([
    [
      'parc:a2009s:lh:G_and_S_frontomargin:ThickAvg',
      'parc:a2009s:ThickAvg',
      false,
    ],
    ['parc:gwc:bi:precentral:GWC', 'parc:gwc:GWC', false],
    [
      'parc:schaefer400-7:rh:7Networks_Vis_1:SurfArea',
      'parc:schaefer400-7:SurfArea',
      true,
    ],
    ['vol:brainstem-ss:mid:Medulla', 'vol:brainstem-ss', true],
    ['vol:wmparc:lh:wm-precentral', 'vol:wmparc', true],
    ['global:TotalGrayVol', 'global', true],
    ['global:SurfaceHoles', 'global', false],
    ['global:sTIV', 'global', true],
  ])('accepts %s', (id, family, extensive) => {
    expect(parseMeasureId(id)).not.toBeNull()
    expect(measureFamily(id)).toBe(family)
    expect(isExtensiveMeasure(id)).toBe(extensive)
    expect(isMeasureIdV1(id)).toBe(false)
  })

  it.each([
    'parc:dk:lh:precentral:ThickAvg',
    'vol:aseg:mid:Brain-Stem',
    'parc:a2009s:mid:x:ThickAvg',
    'vol:brainstem-ss:bi:Left-Thalamus',
    'parc:A2009s:lh:x:ThickAvg',
    'parc:a2009s:lh:x y:ThickAvg',
    'vol:x:mid:Medulla',
    `vol:brainstem-ss:mid:${'a'.repeat(65)}`,
    `parc:a2009s:lh:${'b'.repeat(200)}:ThickAvg`,
  ])('rejects %j', (id) => {
    expect(parseMeasureId(id)).toBeNull()
  })

  it('keeps the v1 subset for spec v1', () => {
    expect(isMeasureIdV1('global:eTIV')).toBe(true)
    expect(isMeasureIdV1('aseg:bi:Thalamus')).toBe(true)
    expect(isMeasureIdV1('global:TotalGrayVol')).toBe(false)
  })

  it.each([
    ['left-right-prefix', 'Left-Thalamus', 'lh', 'Thalamus'],
    ['lh-rh-dot-prefix', 'rh.V1', 'rh', 'V1'],
    ['lh-rh-hyphen-infix', 'wm-lh-precentral', 'lh', 'wm-precentral'],
    ['lh-rh-underscore-infix', '7Networks_RH_Vis_1', 'rh', '7Networks_Vis_1'],
    ['l-r-underscore-suffix', 'A8m_L', 'lh', 'A8m'],
  ] as const)('%s pairs %s', (rule, name, hemisphere, structure) => {
    expect(splitHemisphereToken(rule, name)).toEqual({ hemisphere, structure })
    expect(joinHemisphereToken(rule, hemisphere, structure)).toBe(name)
  })

  it('reads unpaired names as midline', () => {
    const rules: HemisphereTokenRule[] = ['left-right-prefix', 'none']
    for (const rule of rules) {
      expect(splitHemisphereToken(rule, 'Medulla')).toEqual({
        hemisphere: null,
        structure: 'Medulla',
      })
    }
  })
})

describe('v2 requests', () => {
  it('validates termRows and the optional measure-detail term', () => {
    expect(GROUP_ANALYSIS_REQUEST_FIELDS['groupAnalysis.termRows']).toEqual([
      'project',
      'resultId',
      'termId',
      'offset',
    ])
    const request = {
      project: PROJECT,
      resultId: 'gar-0123456789abcdef',
      termId: 'term-1',
      offset: 0,
    }
    expect(() =>
      validateGroupAnalysisRequest('groupAnalysis.termRows', request),
    ).not.toThrow()
    expect(() =>
      validateGroupAnalysisRequest('groupAnalysis.termRows', {
        ...request,
        offset: -1,
      }),
    ).toThrow('Provide a valid row offset.')
    expect(() =>
      validateGroupAnalysisRequest('groupAnalysis.termRows', {
        ...request,
        termId: 'x',
      }),
    ).toThrow('Provide a valid result term ID.')
    const detail = {
      project: PROJECT,
      resultId: 'gar-0123456789abcdef',
      measureId: 'aseg:Brain-Stem',
    }
    expect(() =>
      validateGroupAnalysisRequest('groupAnalysis.measureDetail', detail),
    ).not.toThrow()
    expect(() =>
      validateGroupAnalysisRequest('groupAnalysis.measureDetail', {
        ...detail,
        termId: 'term-2',
      }),
    ).not.toThrow()
    expect(() =>
      validateGroupAnalysisRequest('groupAnalysis.measureDetail', {
        ...detail,
        extra: 1,
      }),
    ).toThrow('Correct the invalid fields')
  })

  it('accepts a spec v2 in start and inputs', () => {
    const { spec } = fixture('within-battery')
    expect(() =>
      validateGroupAnalysisRequest('groupAnalysis.inputs', {
        project: PROJECT,
        spec,
      }),
    ).not.toThrow()
  })

  it('checks stage currency v1 and v2', () => {
    expect(() =>
      validateAnalysisStageCurrency({
        aggregate: 'current',
        pybrainage: 'unknown',
      }),
    ).not.toThrow()
    expect(() =>
      validateAnalysisStageCurrency({
        aggregate: 'current',
        pybrainage: 'unknown',
        recon: { state: 'outdated', outdatedSubjectIds: ['sub-101'] },
      }),
    ).not.toThrow()
    expect(() =>
      validateAnalysisStageCurrency({
        aggregate: 'current',
        pybrainage: 'unknown',
        recon: { state: 'outdated', outdatedSubjectIds: ['../x'] },
      }),
    ).toThrow('Send the reconstruction currency with valid subject IDs.')
    expect(() =>
      validateAnalysisStageCurrency({
        aggregate: 'current',
        pybrainage: 'unknown',
        recon: { state: 'fresh', outdatedSubjectIds: [] },
      }),
    ).toThrow()
    expect(() =>
      validateAnalysisStageCurrency({ aggregate: 'current' }),
    ).toThrow('Send the aggregate and Brain-PAD stage currency.')
  })
})

describe('v2 results from the sidecar engine', () => {
  const example = JSON.parse(
    readFileSync(resolve(FIXTURES, 'result-v2-example.json'), 'utf8'),
  ) as { result: unknown; termRows: unknown; measureDetail: unknown }

  it('parses a stored result, a term page, and a measure detail', () => {
    const result = parseGroupAnalysisResult(example.result)
    expect(result.schemaVersion).toBe(2)
    if (result.schemaVersion !== 2) return
    expect(result.terms.map((term) => term.role)).toContain('heterogeneity')
    expect(result.terms.some((term) => term.stratum !== null)).toBe(true)
    expect(result.sample.issues).toEqual(['One fact about the sample.'])
    const page = parseGroupAnalysisTermRows(example.termRows)
    expect(page.offset).toBe(1)
    expect(page.nextOffset).toBeNull()
    const detail = parseGroupAnalysisMeasureDetail(example.measureDetail)
    expect('termId' in detail && detail.fit.length).toBe(1)
  })
})

describe('dataset v2 interfaces', () => {
  it('names bins as the sidecar does', () => {
    // Pinned in test_group_analysis_dataset_v2.py as well.
    expect(defaultBinLabels([30, 45.5, 1e21])).toEqual([
      '<30',
      '30 to <45.5',
      '45.5 to <1e+21',
      '>=1e+21',
    ])
    expect(defaultBinLabels([])).toEqual([])
  })

  it('offers the registry site as a variable', () => {
    expect(REGISTRY_VARIABLES).toContain('site')
  })

  it('parses a site finding with its two fixes', () => {
    const site = { source: 'registry', column: 'site' }
    const issue = {
      code: 'site-confounded',
      severity: 'blocking',
      testId: 't1',
      message:
        'Site Ingenia holds only SCI subjects in this test, so its group difference cannot be separated from the scanner. Leave out site Ingenia or adjust for site.',
      fixes: [
        { kind: 'drop-level', variable: site, level: 'Ingenia' },
        { kind: 'add-covariate', variable: site },
      ],
    }
    const warning = {
      code: 'site-confounded',
      severity: 'warning',
      testId: null,
      message:
        '3 subjects have no site; the site check treats them as one site.',
    }
    const inputs = {
      configRevision: 1,
      specDigest: 'a'.repeat(64),
      subjects: [],
      groups: [],
      included: 0,
      registrationProvisional: false,
      inputs: [],
      skippedMeasures: [],
      issues: [],
      designCheck: {
        ok: false,
        issues: [issue, warning],
        tests: [],
        cells: [],
        vif: [],
        crosstabs: [],
      },
    }
    const parsed = parseGroupAnalysisInputs(inputs)
    expect(parsed.designCheck?.issues[0]?.fixes).toEqual(issue.fixes)
    expect(parsed.designCheck?.issues[1]).not.toHaveProperty('fixes')
    expect(() =>
      parseGroupAnalysisInputs({
        ...inputs,
        designCheck: {
          ...inputs.designCheck,
          issues: [{ ...issue, fixes: [{ kind: 'rename', variable: site }] }],
        },
      }),
    ).toThrow()
  })
})
