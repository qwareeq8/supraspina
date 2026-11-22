import { describe, expect, it } from 'vitest'
import {
  upgradeGroupAnalysisSpecV1,
  validateGroupAnalysisSpecV2,
  type GroupAnalysisSpecV2,
} from '../../../shared/group-analysis'
import {
  MOCK_BATTERY_SPEC,
  MOCK_LABELING_PROGRESS,
  MOCK_OMNIBUS_SPEC,
  MOCK_VARIABLE_TABLE,
  mockAtlasCatalog,
} from '../../ipc/mock-analysis-v2'
import {
  MOCK_ANALYSIS_SPEC,
  mockAnalysisCatalog,
} from '../../ipc/mock-group-analysis'
import { designText, draftStages, modelFormulaV2 } from './describe'
import {
  addDerived,
  addSubsetFilter,
  addTest,
  applyDesignFix,
  assignLevel,
  autoTestLabel,
  derivedId,
  draftUses,
  firstCharacterHelps,
  fitFactor,
  groupByFirstCharacter,
  mixedRanks,
  newTest,
  nextGroupLabel,
  normalizeDraft,
  removeDerived,
  removeTest,
  renameInGrouping,
  setSubsetFilter,
  sidednessLock,
  testRank,
  updateTest,
  withPopulationVariable,
  withScope,
  withStratify,
  withTestKind,
} from './draft-v2'
import {
  durationText,
  measureHemi,
  measureSourceId,
  measureSources,
  sourceFactsText,
  sourceOptionText,
} from './measure-sources'
import {
  atlasName,
  bytesText,
  derivedText,
  designCheckSummary,
  designFixLabel,
  factFixes,
  labelingOutcomeText,
  labelingProgressText,
  parseCuts,
  smallestCellHint,
  unavailableHeadSizes,
} from './rail-text'
import {
  findChoice,
  measureChoices,
  refKey,
  refLabel,
  refTerm,
  sameRef,
  variableChoices,
  type VariableChoice,
} from './variables'

const catalog = mockAnalysisCatalog()
const TABLE = MOCK_VARIABLE_TABLE.tableId
const choices = variableChoices(catalog, MOCK_BATTERY_SPEC.variables.derived)
const base = upgradeGroupAnalysisSpecV1(MOCK_ANALYSIS_SPEC)
const valid = (spec: GroupAnalysisSpecV2): string[] => {
  const result = validateGroupAnalysisSpecV2(spec)
  return result.ok ? [] : result.errors
}

describe('variables', () => {
  it('lists catalog, imported, and derived variables with keys and names', () => {
    const uems = findChoice(choices, {
      source: 'imported',
      table: TABLE,
      column: 'UEMS',
    })!
    expect(uems).toMatchObject({
      key: `imported:${TABLE}:UEMS`,
      label: 'clinical-variables.csv: UEMS',
      kind: 'numeric',
      n: 33,
    })
    const motor = findChoice(choices, {
      source: 'derived',
      column: 'dv-motor',
    })!
    expect(motor).toMatchObject({
      label: 'Derived: ISNCSCI motor score',
      kind: 'numeric',
    })
    const bins = variableChoices(catalog, [
      {
        id: 'dv-band',
        label: 'Band',
        op: 'bins',
        inputs: [{ source: 'registry', column: 'age' }],
        params: { cuts: [30], labels: [] },
      },
    ]).at(-1)!
    expect(bins).toMatchObject({
      kind: 'categorical',
      levels: [
        { value: '<30', n: null },
        { value: '>=30', n: null },
      ],
    })
    expect(refKey(null)).toBe('')
    expect(sameRef(uems.ref, { ...uems.ref })).toBe(true)
    expect(sameRef(uems.ref, null)).toBe(false)
    expect(refTerm(motor.ref, choices)).toBe('ISNCSCI motor score')
    expect(refTerm({ source: 'derived', column: 'dv-gone' }, choices)).toBe(
      'dv-gone',
    )
    expect(refTerm({ source: 'registry', column: 'age' }, choices)).toBe('age')
    expect(refTerm({ source: 'measure', column: 'aseg:Brain-Stem' }, [])).toBe(
      'Brainstem volume',
    )
    expect(refLabel({ source: 'measure', column: 'aseg:Brain-Stem' }, [])).toBe(
      'Brainstem volume',
    )
    expect(
      refLabel({ source: 'imported', table: TABLE, column: 'gone' }, []),
    ).toBe('gone')
    expect(refLabel({ source: 'registry', column: 'site' }, [])).toBe(
      'Registry: Site',
    )
    const measures = measureChoices(catalog)
    expect(measures.some((m) => m.key === 'measure:aseg:Brain-Stem')).toBe(true)
    expect(measures.some((m) => m.key.startsWith('measure:dk:'))).toBe(false)
    // An unavailable measure is not offered as a covariate.
    expect(measures.some((m) => m.key === 'measure:global:synthsegTIV')).toBe(
      false,
    )
  })
})

describe('draft edits', () => {
  it('accepts every measure the catalog offers, head sizes included', () => {
    // Spec v1 refuses sTIV, SynthSeg TIV, and surface holes, which the rail
    // offers; the rail drafts spec v2, which accepts them all.
    const offered = catalog.measures.map((measure) => measure.measureId)
    for (const id of [
      'global:sTIV',
      'global:synthsegTIV',
      'global:SurfaceHoles',
    ]) {
      expect(offered).toContain(id)
    }
    expect(valid({ ...base, measures: offered })).toEqual([])
  })

  it('keeps every scope switch and new test valid', () => {
    const within = withScope(base, 'within', choices)
    expect(valid(within)).toEqual([])
    expect(within.design.population?.groups).toEqual(['SCI'])
    expect(within.tests).toHaveLength(1)
    expect(withScope(within, 'within', choices)).toBe(within)
    const between = withScope(within, 'between', choices)
    expect(valid(between)).toEqual([])
    expect(between.tests[0]).toMatchObject({
      kind: 'two-group',
      label: 'SCI vs CTRL',
      factor: { focal: 'SCI', reference: 'CTRL' },
    })
    let draft = within
    for (const kind of [
      'two-group',
      'omnibus',
      'association',
      'interaction',
    ] as const) {
      draft = addTest(draft, kind, choices)
    }
    expect(draft.tests.map((test) => test.kind)).toEqual([
      'association',
      'two-group',
      'omnibus',
      'association',
      'interaction',
    ])
    expect(draft.tests.map((test) => test.id)).toEqual([
      't1',
      't2',
      't3',
      't4',
      't5',
    ])
    // A within-group omnibus groups each level of a clinical column.
    expect(draft.tests[2]!.factor!.grouping.variable).toEqual({
      source: 'imported',
      table: TABLE,
      column: 'injury_level',
    })
    expect(removeTest(draft, 't2', choices).tests).toHaveLength(4)
    const single = { ...draft, tests: [draft.tests[0]!] }
    expect(removeTest(single, 't1', choices)).toBe(single)
    let full = draft
    while (full.tests.length < 16) full = addTest(full, 'association', choices)
    expect(addTest(full, 'association', choices)).toBe(full)
  })

  it('changes a test kind and keeps its grouping where it can', () => {
    const test = base.tests[0]!
    const omnibus = withTestKind(base, test, 'omnibus', choices)
    expect(omnibus.factor!.grouping.groups.map((g) => g.label)).toEqual([
      'CTRL',
      'SCI_nNP',
      'SCI_P',
    ])
    expect(omnibus.factor!.focal).toBeNull()
    expect(omnibus.label).toBe('CTRL, SCI_nNP, and SCI_P')
    expect(withTestKind(base, test, 'two-group', choices)).toBe(test)
    const back = withTestKind(base, omnibus, 'two-group', choices)
    expect(back.factor).toMatchObject({ reference: 'CTRL', focal: 'SCI_nNP' })
    const slope = withTestKind(base, test, 'interaction', choices)
    expect(slope.factor!.focal).toBeNull()
    expect(slope.moderator!.ref).toEqual({
      source: 'imported',
      table: TABLE,
      column: 'UEMS',
    })
    const association = withTestKind(base, slope, 'association', choices)
    expect(association.factor).toBeNull()
    expect(association.variable).toEqual(slope.moderator)
    expect(testRank(omnibus, choices)).toBe(2)
    expect(testRank(slope, choices)).toBe(1)
    expect(autoTestLabel({ ...test, factor: null }, choices)).toBe('Test')
    expect(
      autoTestLabel(
        {
          ...association,
          variable: { ...association.variable!, transform: 'standardize' },
        },
        choices,
      ),
    ).toBe('UEMS, per SD')
    const twoLevel = {
      ...omnibus,
      factor: {
        ...omnibus.factor!,
        grouping: {
          ...omnibus.factor!.grouping,
          groups: omnibus.factor!.grouping.groups.slice(0, 2),
        },
      },
    }
    expect(autoTestLabel(twoLevel, choices)).toBe('CTRL and SCI_nNP')
  })

  it('relabels an automatically labeled test and keeps an edited label', () => {
    const test = base.tests[0]!
    const flipped = {
      ...test,
      factor: { ...test.factor!, focal: 'CTRL', reference: 'SCI' },
    }
    expect(updateTest(base, test, flipped, choices).tests[0]!.label).toBe(
      'CTRL vs SCI',
    )
    const named = { ...test, label: 'Main contrast' }
    const spec = { ...base, tests: [named] }
    expect(
      updateTest(spec, named, { ...named, factor: flipped.factor }, choices)
        .tests[0]!.label,
    ).toBe('Main contrast')
  })

  it('follows the design in the inference rules', () => {
    const omnibus = withTestKind(base, base.tests[0]!, 'omnibus', choices)
    const ranked = { ...base, tests: [omnibus] }
    expect(sidednessLock(base, choices)).toBeNull()
    expect(sidednessLock(ranked, choices)).toMatch(
      /is an F test, which has no direction/,
    )
    const normalized = normalizeDraft(
      {
        ...ranked,
        inference: {
          ...ranked.inference,
          sidedness: 'lower',
          omnibusGate: true,
        },
      },
      choices,
    )
    expect(normalized.inference.sidedness).toBe('two-sided')
    expect(normalized.inference.omnibusGate).toBe(true)
    const mixed = addTest(ranked, 'association', choices)
    expect(mixedRanks(mixed)).toBe(true)
    expect(
      normalizeDraft(
        { ...mixed, inference: { ...mixed.inference, family: 'all-tests' } },
        choices,
      ).inference.family,
    ).toBe('per-test')
    // A gate without pairwise comparisons marks nothing.
    expect(
      normalizeDraft(
        { ...base, inference: { ...base.inference, omnibusGate: true } },
        choices,
      ).inference.omnibusGate,
    ).toBe(false)
    // Pairwise comparisons belong to an omnibus test only.
    const two = { ...base.tests[0]!, pairwise: 'all-pairs' as const }
    expect(
      normalizeDraft({ ...base, tests: [two] }, choices).tests[0]!.pairwise,
    ).toBe('none')
    // One test always stays in the family.
    const out = { ...base.tests[0]!, inFamily: false }
    expect(
      normalizeDraft({ ...base, tests: [out] }, choices).tests[0]!.inFamily,
    ).toBe(true)
    const same = normalizeDraft(base, choices)
    expect(same.inference).toBe(base.inference)
  })

  it('ranks a slope difference by its categorical moderator levels', () => {
    const slope = withTestKind(base, base.tests[0]!, 'interaction', choices)
    const band = (cuts: number[]): VariableChoice[] =>
      variableChoices(catalog, [
        {
          id: 'dv-band',
          label: 'Band',
          op: 'bins',
          inputs: [{ source: 'registry', column: 'age' }],
          params: { cuts, labels: [] },
        },
      ])
    const byBand = {
      ...slope,
      moderator: {
        ref: { source: 'derived' as const, column: 'dv-band' },
        transform: 'none' as const,
      },
    }
    // Two groups by two levels is one product; by three levels, two.
    expect(testRank(byBand, band([30]))).toBe(1)
    expect(testRank(byBand, band([30, 50]))).toBe(2)
    const draft = {
      ...base,
      tests: [byBand],
      inference: { ...base.inference, sidedness: 'higher' as const },
    }
    expect(sidednessLock(draft, band([30]))).toBeNull()
    expect(sidednessLock(draft, band([30, 50]))).toMatch(/is an F test/)
    expect(normalizeDraft(draft, band([30, 50])).inference.sidedness).toBe(
      'two-sided',
    )
    // An interaction forms its own family, so it never mixes ranks.
    const both = { ...draft, tests: [base.tests[0]!, { ...byBand, id: 't2' }] }
    expect(mixedRanks(both)).toBe(false)
  })

  it('locks the sidedness for heterogeneity over three or more strata', () => {
    const grouping = base.tests[0]!.factor!.grouping
    const strata = (count: number): GroupAnalysisSpecV2 => ({
      ...base,
      stratify: {
        grouping: {
          variable: { source: 'registry', column: 'sex' },
          groups: ['A', 'B', 'C']
            .slice(0, count)
            .map((label) => ({ label, levels: [label] })),
        },
        heterogeneity: true,
      },
    })
    expect(grouping.groups).toHaveLength(2)
    expect(sidednessLock(strata(2), choices)).toBeNull()
    expect(sidednessLock(strata(3), choices)).toMatch(
      /^The heterogeneity test across three or more strata is an F test/,
    )
    const off = strata(3)
    off.stratify = { ...off.stratify!, heterogeneity: false }
    expect(sidednessLock(off, choices)).toBeNull()
  })

  it('edits groupings: merges, renames, groups by first character', () => {
    const grouping = base.tests[0]!.factor!.grouping
    const moved = assignLevel(grouping, 'SCI_nNP', 'CTRL')
    expect(moved.groups.map((g) => g.levels)).toEqual([
      ['SCI_P'],
      ['CTRL', 'SCI_nNP'],
    ])
    expect(assignLevel(moved, 'SCI_nNP', null).groups[1]!.levels).toEqual([
      'CTRL',
    ])
    expect(
      renameInGrouping(grouping, 'SCI', 'Injured').groups.map((g) => g.label),
    ).toEqual(['Injured', 'CTRL'])
    expect(nextGroupLabel(grouping)).toBe('Group 3')
    const levels = ['C4', 'C5', 'T4', 'T10', 'L1']
    expect(firstCharacterHelps(levels)).toBe(true)
    expect(firstCharacterHelps(['CTRL', 'SCI_P', 'SCI_nNP'])).toBe(false)
    expect(firstCharacterHelps(['A', 'B', 'C', 'D'])).toBe(false)
    expect(groupByFirstCharacter(grouping, levels).groups).toEqual([
      { label: 'C', levels: ['C4', 'C5'] },
      { label: 'T', levels: ['T4', 'T10'] },
      { label: 'L', levels: ['L1'] },
    ])
    const factor = base.tests[0]!.factor!
    expect(
      fitFactor({
        ...factor,
        grouping: groupByFirstCharacter(grouping, levels),
      }),
    ).toMatchObject({ focal: 'C', reference: 'L' })
    expect(
      fitFactor({ ...factor, grouping: { ...grouping, groups: [] } }),
    ).toEqual({ ...factor, grouping: { ...grouping, groups: [] } })
  })

  it('edits the population, subset filters, strata, and derived variables', () => {
    const cohort = findChoice(choices, {
      source: 'registry',
      column: 'cohortRole',
    })!
    expect(
      withPopulationVariable(base, cohort).design.population,
    ).toMatchObject({
      groups: ['SCI'],
    })
    const sex = findChoice(choices, { source: 'registry', column: 'sex' })!
    const age = findChoice(choices, { source: 'registry', column: 'age' })!
    let spec = addSubsetFilter(base, sex)
    expect(spec.design.subset[0]!.keep).toEqual({ levels: ['F', 'M'] })
    expect(addSubsetFilter(spec, sex)).toBe(spec)
    spec = addSubsetFilter(spec, age)
    expect(spec.design.subset[1]!.keep).toEqual({ min: null, max: null })
    expect(valid(spec)).toContain(
      'Give each numeric subset filter a minimum or a maximum.',
    )
    spec = setSubsetFilter(spec, 1, { min: 18, max: null })
    expect(valid(spec)).toEqual([])
    expect(setSubsetFilter(spec, 0, null).design.subset).toHaveLength(1)
    let full = base
    for (const choice of choices.slice(0, 9))
      full = addSubsetFilter(full, choice)
    expect(full.design.subset).toHaveLength(8)

    const strata = withStratify(base, sex)
    expect(strata.stratify).toMatchObject({
      heterogeneity: true,
      grouping: { groups: [{ label: 'F' }, { label: 'M' }] },
    })
    expect(withStratify(strata, null).stratify).toBeNull()

    expect(derivedId('Motor score', [])).toBe('dv-motor-score')
    expect(
      derivedId('Motor score', [
        {
          id: 'dv-motor-score',
          label: 'x',
          op: 'log1p',
          inputs: [],
          params: { cuts: [], labels: [] },
        },
      ]),
    ).toBe('dv-motor-score-2')
    expect(derivedId('!!!', [])).toBe('dv-variable')
    const uems = { source: 'imported', table: TABLE, column: 'UEMS' } as const
    const derived = addDerived(base, {
      id: 'dv-log-uems',
      label: 'log UEMS',
      op: 'log1p',
      inputs: [uems],
      params: { cuts: [], labels: [] },
    })
    expect(draftUses(derived, (ref) => sameRef(ref, uems))).toBe(true)
    expect(removeDerived(derived, 'dv-log-uems').variables.derived).toEqual([])
    const used = {
      ...derived,
      covariates: {
        ...derived.covariates,
        extra: [{ source: 'derived' as const, column: 'dv-log-uems' }],
      },
    }
    expect(removeDerived(used, 'dv-log-uems')).toBe(used)
    expect(derivedText(derived.variables.derived[0]!, choices)).toBe(
      'log(1 + UEMS)',
    )
    expect(
      derivedText(
        {
          id: 'dv-d',
          label: 'd',
          op: 'difference',
          inputs: [uems, { ...uems, column: 'LEMS' }],
          params: { cuts: [], labels: [] },
        },
        choices,
      ),
    ).toBe('UEMS - LEMS')
    expect(parseCuts('30, 45;60')).toEqual([30, 45, 60])
    expect(parseCuts('30, x')).toBeNull()
  })

  it('applies the design-check fixes as draft edits', () => {
    const site = { source: 'registry', column: 'site' } as const
    const withSite = [
      ...choices,
      {
        ref: site,
        key: 'registry:site',
        label: 'Registry: Site',
        kind: 'categorical' as const,
        n: 82,
        levels: [
          { value: 'A', n: 71 },
          { value: 'B', n: 11 },
        ],
      },
    ]
    const adjusted = applyDesignFix(
      base,
      { kind: 'add-covariate', variable: site },
      withSite,
    )
    expect(adjusted.covariates.extra).toEqual([site])
    expect(
      applyDesignFix(adjusted, { kind: 'add-covariate', variable: site }, []),
    ).toBe(adjusted)
    const dropped = applyDesignFix(
      base,
      { kind: 'drop-level', variable: site, level: 'B' },
      withSite,
    )
    expect(dropped.design.subset).toEqual([
      { variable: site, keep: { levels: ['A'] } },
    ])
    // A second drop of the only kept level keeps the filter.
    expect(
      applyDesignFix(
        dropped,
        { kind: 'drop-level', variable: site, level: 'A' },
        withSite,
      ),
    ).toBe(dropped)
    expect(
      applyDesignFix(
        base,
        { kind: 'drop-level', variable: site, level: 'B' },
        choices,
      ),
    ).toBe(base)
    expect(
      designFixLabel(
        { kind: 'drop-level', variable: site, level: 'B' },
        withSite,
      ),
    ).toBe('Leave out site B')
    expect(
      designFixLabel({ kind: 'add-covariate', variable: site }, withSite),
    ).toBe('Adjust for site')
  })

  it('builds new tests from the draft defaults', () => {
    const within = withScope(base, 'within', choices)
    const two = newTest(within, 'two-group', choices)
    expect(two.factor!.grouping.variable).toEqual({
      source: 'imported',
      table: TABLE,
      column: 'injury_level',
    })
    // Every numeric variable tested: the next association reuses one.
    let spec = within
    for (let i = 0; i < 8; i += 1) spec = addTest(spec, 'association', choices)
    expect(spec.tests.at(-1)!.variable).not.toBeNull()
  })
})

describe('wording', () => {
  it('names designs, formulas, stages, and the design check', () => {
    expect(designText(MOCK_OMNIBUS_SPEC)).toBe('SCI_P, SCI_nNP, and CTRL')
    expect(
      designText({
        ...MOCK_BATTERY_SPEC,
        design: { ...MOCK_BATTERY_SPEC.design, population: null },
        tests: [MOCK_BATTERY_SPEC.tests[0]!],
        stratify: {
          grouping: {
            variable: { source: 'registry', column: 'sex' },
            groups: [
              { label: 'F', levels: ['F'] },
              { label: 'M', levels: ['M'] },
            ],
          },
          heterogeneity: true,
        },
      }),
    ).toBe('Within a group, Time since injury, by 2 strata')
    const slope = withTestKind(base, base.tests[0]!, 'interaction', choices)
    expect(
      modelFormulaV2(
        {
          ...base,
          tests: [slope],
          covariates: {
            ...base.covariates,
            headSize: { source: 'none', rule: 'extensive' },
          },
        },
        choices,
      ),
    ).toBe('y ~ group x UEMS + age + sex')
    expect(draftStages({ measures: ['brainage:BrainPAD'] })).toEqual([
      'pybrainage',
    ])
    expect(draftStages({ measures: ['vol:brainstem-ss:mid:Medulla'] })).toEqual(
      [],
    )
    expect(
      designCheckSummary({
        ok: true,
        issues: [],
        tests: [],
        cells: [],
        vif: [],
        crosstabs: [],
      }),
    ).toBe('Design check: no findings.')
    expect(
      designCheckSummary({
        ok: false,
        issues: [
          { code: 'min-cell', severity: 'blocking', testId: null, message: '' },
          { code: 'min-cell', severity: 'blocking', testId: null, message: '' },
          {
            code: 'vif',
            severity: 'strong-warning',
            testId: null,
            message: '',
          },
          { code: 'vif', severity: 'warning', testId: null, message: '' },
        ],
        tests: [],
        cells: [],
        vif: [],
        crosstabs: [],
      }),
    ).toBe('Design check: 2 findings block Compute, 2 warnings.')
    expect(smallestCellHint(null, 3)).toBe(
      'A test whose smallest group or cell has fewer than 3 subjects cannot compute.',
    )
    expect(unavailableHeadSizes(catalog)).toEqual({
      'synthseg-tiv': 'No subject has synthseg.tiv.dat.',
    })
    expect(
      unavailableHeadSizes({
        ...catalog,
        measures: catalog.measures.filter((m) => m.measureId !== 'global:sTIV'),
      }).stiv,
    ).toBe("No subject's FreeSurfer stats give sTIV.")
    expect(bytesText(1084)).toBe('1 KB')
    expect(bytesText(15_800_000)).toBe('15.1 MB')
  })

  it('names atlas sources, reach, labeling progress, and durations', () => {
    const atlases = mockAtlasCatalog(MOCK_LABELING_PROGRESS)
    const sources = measureSources(catalog, atlases)
    expect(sources.slice(0, 4).map((s) => s.id)).toEqual([
      'dk',
      'aseg',
      'global',
      'brainage',
    ])
    expect(sources.map((s) => s.tier)).toEqual(
      [...sources.map((s) => s.tier)].sort(
        (a, b) =>
          ['pipeline', 'stats', 'labeled', 'added'].indexOf(a) -
          ['pipeline', 'stats', 'labeled', 'added'].indexOf(b),
      ),
    )
    const a2009s = sources.find((s) => s.id === 'a2009s')!
    expect(a2009s.metrics).toEqual([
      'ThickAvg',
      'SurfArea',
      'GrayVol',
      'MeanCurv',
    ])
    expect(a2009s.hemis).toEqual(['bi', 'lh', 'rh'])
    expect(sources.find((s) => s.id === 'brainstem-ss')!.hemis).toEqual(['mid'])
    expect(sourceOptionText(a2009s)).toBe('Destrieux (aparc.a2009s) (82 of 82)')
    expect(sourceOptionText(sources[0]!)).toBe('Desikan-Killiany (cortical)')
    // Without the atlas catalog, atlases come from the measures.
    const fallback = measureSources(catalog, null)
    expect(fallback.find((s) => s.id === 'wmparc')).toMatchObject({
      tier: 'stats',
      namespace: 'vol',
      entry: null,
    })
    expect(
      sourceFactsText(atlases.atlases.find((a) => a.atlasId === 'thalamic')!),
    ).toBe('0 of 82 subjects labeled; 1 recon out of date.')
    expect(measureHemi('aseg:Brain-Stem')).toBe('mid')
    expect(measureHemi('aseg:Left-Thalamus')).toBe('lh')
    expect(measureHemi('aseg:Right-Thalamus')).toBe('rh')
    expect(measureHemi('global:eTIV')).toBeNull()
    expect(measureHemi('nonsense')).toBeNull()
    expect(measureSourceId('parc:a2009s:lh:G_precentral:ThickAvg')).toBe(
      'a2009s',
    )
    expect(measureSourceId('nonsense')).toBeNull()
    expect(labelingProgressText(MOCK_LABELING_PROGRESS)).toBe(
      '7 of 20 subjects; 1 failed; 1 skipped; labeling sub-071; about 2.2 h left.',
    )
    expect(
      labelingOutcomeText(
        { ...MOCK_LABELING_PROGRESS, state: 'done', completed: 20 },
        'brainstem subfields',
      ),
    ).toBe(
      'The brainstem subfields labeling finished: 18 labeled, 1 failed, 1 skipped.',
    )
    expect(
      labelingOutcomeText(
        { ...MOCK_LABELING_PROGRESS, state: 'failed', message: null },
        'x',
      ),
    ).toBe('The x labeling failed: 5 labeled, 1 failed, 1 skipped.')
    expect(durationText(30)).toBe('about 1 min')
    expect(durationText(600)).toBe('about 10 min')
    expect(durationText(50_400)).toBe('about 14 h')
    expect(atlasName('Brainstem subfields')).toBe('brainstem subfields')
    expect(atlasName('DKT (aparc.DKTatlas)')).toBe('DKT (aparc.DKTatlas)')
    const fixes = factFixes(atlases.tools)
    expect(
      fixes.filter((item) => item.fix === 'choose-subregions-python'),
    ).toHaveLength(1)
  })
})
