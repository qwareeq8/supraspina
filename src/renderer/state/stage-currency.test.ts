import { describe, expect, it } from 'vitest'
import type {
  ResultAnalysisCohortChange,
  ResultStageCurrency,
} from '../../shared/contract'
import {
  MATRIX_STEPS,
  STEP_KEYS,
  type MatrixStepKey,
  type StepKey,
} from '../../shared/steps'
import { emptyCell, type CellState, type Subject } from '../../shared/types'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import {
  analysisCohortCause,
  analysisCohortReasons,
  applyStageCurrency,
  cohortConfigKey,
  cohortCurrencyNotice,
  outdatedCohortStages,
  outdatedColumnReason,
  stageCurrencyNotice,
  type StageCurrencySnapshot,
} from './stage-currency'

const OUTDATED_BY_COHORT: ResultStageCurrency = {
  state: 'outdated',
  outdatedSubjectIds: [],
  cause: 'analysis-cohort',
}

describe('stage currency copy', () => {
  it('names the QC verdicts or the membership as the cohort cause', () => {
    expect(analysisCohortCause({ cause: 'membership' }, 'this stage')).toBe(
      'The analysis cohort changed after this stage ran.',
    )
    expect(analysisCohortCause({ cause: 'membership' }, 'this stage')).toBe(
      'The analysis cohort changed after this stage ran.',
    )
    expect(analysisCohortCause(null, 'this stage')).toBe(
      'The analysis cohort changed after this stage ran.',
    )
  })

  it('says what changed the membership after the cause', () => {
    const change = (
      reasons: NonNullable<ResultAnalysisCohortChange['reasons']>,
    ): ResultAnalysisCohortChange => ({ cause: 'membership', reasons })
    expect(
      analysisCohortCause(
        change([{ kind: 't1-changed', subjectIds: ['sub-003'], count: 1 }]),
        'this stage',
      ),
    ).toBe(
      'The analysis cohort changed after this stage ran: the T1 input of sub-003 changed.',
    )
    expect(
      analysisCohortReasons(
        change([
          { kind: 'subjects-added', subjectIds: ['sub-004'], count: 1 },
          {
            kind: 'subjects-removed',
            subjectIds: ['sub-001', 'sub-002'],
            count: 2,
          },
          { kind: 'config-exclusion', subjectIds: ['sub-005'], count: 1 },
          { kind: 'qc-exclusion', subjectIds: ['sub-006'], count: 1 },
        ]),
      ),
    ).toBe(
      'a new subject, sub-004, is in the raw data; subjects sub-001 and ' +
        'sub-002 are no longer in the raw data; the saved subject selection ' +
        'changed for sub-005; the QC Fail verdict of sub-006 changed',
    )
    const many = Array.from({ length: 20 }, (_, index) => `sub-${index + 100}`)
    expect(
      analysisCohortReasons(
        change([
          { kind: 'subjects-added', subjectIds: many, count: 25 },
          { kind: 'subjects-removed', subjectIds: many.slice(0, 4), count: 4 },
          { kind: 'config-exclusion', subjectIds: [], count: 0 },
          {
            kind: 't1-changed',
            subjectIds: ['sub-001', 'sub-002', 'sub-003'],
            count: 3,
          },
          { kind: 'qc-exclusion', subjectIds: many, count: 30 },
        ]),
      ),
    ).toBe(
      '25 new subjects are in the raw data; 4 subjects are no longer in the ' +
        'raw data; the saved subject exclusions changed; the T1 inputs of ' +
        'sub-001, sub-002, and sub-003 changed; the QC Fail verdicts of 30 ' +
        'subjects changed',
    )
    // Only a membership change names reasons.
    expect(analysisCohortReasons({ cause: 'membership' })).toBeNull()
    expect(analysisCohortReasons(change([]))).toBeNull()
    expect(analysisCohortReasons(null)).toBeNull()
  })

  it('keys only the saved settings that choose subjects and T1 files', () => {
    const saved = structuredClone(DEFAULT_PROJECT_CONFIG)
    const key = cohortConfigKey(saved)
    expect(
      cohortConfigKey({
        ...saved,
        runtime: { ...saved.runtime, threads: saved.runtime.threads + 1 },
      }),
    ).toBe(key)
    expect(
      cohortConfigKey({
        ...saved,
        subjects: { ...saved.subjects, exclude: ['sub-003'] },
      }),
    ).not.toBe(key)
    expect(
      cohortConfigKey({
        ...saved,
        patterns: { ...saved.patterns, t1Pattern: '*t1*.nii*' },
      }),
    ).not.toBe(key)
  })

  it('lists out-of-date cohort stages in pipeline order', () => {
    const currency: Partial<Record<StepKey, ResultStageCurrency>> = {
      final: OUTDATED_BY_COHORT,
      recon: { state: 'outdated', outdatedSubjectIds: ['sub-001'] },
      enigma: OUTDATED_BY_COHORT,
      age: { state: 'current', outdatedSubjectIds: [] },
      features: { state: 'unknown', outdatedSubjectIds: [] },
    }
    expect(outdatedCohortStages(currency)).toEqual(['enigma', 'final'])
    expect(outdatedCohortStages(currency, (key) => key === 'final')).toEqual([
      'final',
    ])
  })

  it('words one stage, several stages, and a stage with another cause', () => {
    expect(
      cohortCurrencyNotice(
        ['enigma'],
        { enigma: OUTDATED_BY_COHORT },
        {
          cause: 'membership',
        },
      ),
    ).toEqual({
      headline:
        'ENIGMA QC is out of date: the analysis cohort changed after it ran.',
      detail: 'Run all reruns it.',
    })
    expect(
      cohortCurrencyNotice(
        ['enigma', 'outliers', 'final'],
        {
          enigma: OUTDATED_BY_COHORT,
          outliers: OUTDATED_BY_COHORT,
          final: OUTDATED_BY_COHORT,
        },
        { cause: 'membership' },
      ),
    ).toEqual({
      headline:
        '3 cohort stages are out of date: the analysis cohort changed after they ran.',
      detail:
        'Run all reruns ENIGMA QC, Histogram and outlier review, and R analysis.',
    })
    // A stage outdated for another reason keeps the cause out of the headline.
    expect(
      cohortCurrencyNotice(
        ['enigma', 'final'],
        {
          enigma: OUTDATED_BY_COHORT,
          final: { state: 'outdated', outdatedSubjectIds: [] },
        },
        { cause: 'membership' },
      ),
    ).toEqual({
      headline: '2 cohort stages are out of date.',
      detail: 'Run all reruns ENIGMA QC and R analysis.',
    })
    expect(cohortCurrencyNotice([], {}, { cause: 'membership' })).toBeNull()
  })

  it('says what changed the membership before what Run all reruns', () => {
    const change: ResultAnalysisCohortChange = {
      cause: 'membership',
      reasons: [{ kind: 'subjects-added', subjectIds: ['sub-094'], count: 1 }],
    }
    expect(
      cohortCurrencyNotice(
        ['enigma', 'final'],
        { enigma: OUTDATED_BY_COHORT, final: OUTDATED_BY_COHORT },
        change,
        82,
      ),
    ).toEqual({
      headline:
        '2 cohort stages are out of date for 82 subjects: the analysis cohort changed after they ran.',
      detail:
        'A new subject, sub-094, is in the raw data. Run all reruns ENIGMA QC and R analysis.',
    })
    // A stage outdated for another reason keeps the reasons out as well.
    expect(
      cohortCurrencyNotice(
        ['enigma', 'final'],
        {
          enigma: OUTDATED_BY_COHORT,
          final: { state: 'outdated', outdatedSubjectIds: [] },
        },
        change,
      )?.detail,
    ).toBe('Run all reruns ENIGMA QC and R analysis.')
  })
})

/** A subject whose every matrix cell and pipeline stage finished. */
function finished(id: string, overrides: Partial<Subject> = {}): Subject {
  return {
    id,
    age: 40,
    sex: 'F',
    cohort: 'CTRL',
    ais: null,
    tSinceSci: null,
    cells: MATRIX_STEPS.map(() => ({ ...emptyCell(), st: 'done' as const })),
    stepStates: Object.fromEntries(STEP_KEYS.map((key) => [key, 'done'])),
    qc: 'pass',
    notes: '',
    registered: true,
    analysisEligible: true,
    ...overrides,
  }
}

/** Read one subject's matrix as a column-to-state map. */
function columnStates(subject: Subject): Record<MatrixStepKey, CellState> {
  return Object.fromEntries(
    MATRIX_STEPS.map((step, index) => [step.key, subject.cells[index]!.st]),
  ) as Record<MatrixStepKey, CellState>
}

/** The columns a projected subject shows out of date, in matrix order. */
function outdatedColumns(subject: Subject): MatrixStepKey[] {
  return MATRIX_STEPS.filter(
    (_step, index) => subject.cells[index]?.st === 'outdated',
  ).map((step) => step.key)
}

function snapshot(
  stageCurrency: Partial<Record<StepKey, ResultStageCurrency>>,
  change: StageCurrencySnapshot['analysisCohortChange'] = null,
): StageCurrencySnapshot {
  return {
    producedStepKeys: new Set(),
    stageCurrency,
    analysisCohortChange: change,
  }
}

describe('applyStageCurrency', () => {
  it.each([
    ['enigma', ['qcsub', 'qcic', 'qcec']],
    ['outliers', []],
    ['features', ['feat']],
    ['age', ['feat']],
    ['pybrainage', ['pba']],
    ['clinical', ['stats']],
    ['brainpad', ['stats']],
    ['aggregate', ['agg']],
    ['final', ['rep']],
    ['recon', ['recon']],
    ['brainfov', []],
    ['deface', []],
  ] as const)('marks the columns %s advances', (stepKey, columns) => {
    const [projected] = applyStageCurrency(
      [finished('sub-001')],
      snapshot({
        [stepKey]: {
          state: 'outdated',
          outdatedSubjectIds: ['sub-001'],
        },
      }),
    )
    expect(outdatedColumns(projected!)).toEqual(columns)
  })

  it('marks the shared Feat and Stats columns when either producer is out of date', () => {
    const [projected] = applyStageCurrency(
      [finished('sub-001')],
      snapshot({
        age: OUTDATED_BY_COHORT,
        features: { state: 'current', outdatedSubjectIds: [] },
        clinical: { state: 'current', outdatedSubjectIds: [] },
        brainpad: OUTDATED_BY_COHORT,
      }),
    )
    expect(outdatedColumns(projected!)).toEqual(['feat', 'stats'])
  })

  it('leaves subjects outside the analysis cohort untouched', () => {
    const rows = [
      finished('sub-fail', { qc: 'fail', analysisEligible: false }),
      finished('sub-no-t1', { analysisEligible: false }),
      finished('sub-eligible'),
    ]
    const projected = applyStageCurrency(
      rows,
      snapshot({ enigma: OUTDATED_BY_COHORT }),
    )
    expect(projected.map(outdatedColumns)).toEqual([
      [],
      [],
      ['qcsub', 'qcic', 'qcec'],
    ])
  })

  it('marks only done cells of subjects whose stage finished', () => {
    const busy = finished('sub-001')
    busy.cells[1] = { ...busy.cells[1]!, st: 'running' }
    busy.cells[2] = { ...busy.cells[2]!, st: 'failed' }
    const unfinished = finished('sub-002', {
      stepStates: { enigma: 'failed' },
    })
    const [first, second] = applyStageCurrency(
      [busy, unfinished],
      snapshot({ enigma: OUTDATED_BY_COHORT }),
    )
    expect(columnStates(first!)).toMatchObject({
      qcsub: 'running',
      qcic: 'failed',
      qcec: 'outdated',
    })
    expect(outdatedColumns(second!)).toEqual([])
  })

  it('marks reconstruction only for the subjects the stage lists', () => {
    const projected = applyStageCurrency(
      [finished('sub-001'), finished('sub-002')],
      snapshot({
        recon: { state: 'outdated', outdatedSubjectIds: ['sub-002'] },
      }),
    )
    expect(projected.map(outdatedColumns)).toEqual([[], ['recon']])
  })

  it('never changes its input or the per-stage states', () => {
    const rows = [finished('sub-001'), finished('sub-002')]
    const before = structuredClone(rows)
    const projected = applyStageCurrency(
      rows,
      snapshot({
        enigma: OUTDATED_BY_COHORT,
        recon: { state: 'outdated', outdatedSubjectIds: ['sub-001'] },
      }),
    )
    expect(rows).toEqual(before)
    expect(projected).not.toBe(rows)
    expect(projected[0]).not.toBe(rows[0])
    expect(projected[0]!.stepStates).toEqual(rows[0]!.stepStates)
  })

  it('changes nothing for current, unknown, absent, or empty currency', () => {
    const rows = [finished('sub-001')]
    for (const read of [
      snapshot({}),
      snapshot({
        enigma: { state: 'current', outdatedSubjectIds: [] },
        final: { state: 'unknown', outdatedSubjectIds: [] },
        recon: { state: 'current', outdatedSubjectIds: ['sub-001'] },
      }),
    ]) {
      const projected = applyStageCurrency(rows, read)
      expect(projected).toEqual(rows)
      expect(projected.map(outdatedColumns)).toEqual([[]])
    }
  })
})

describe('outdatedColumnReason', () => {
  it('names QC verdicts, a membership change, or no cohort cause', () => {
    const cohortCaused = { enigma: OUTDATED_BY_COHORT }
    expect(
      outdatedColumnReason(
        'qcsub',
        snapshot(cohortCaused, { cause: 'membership' }),
      ),
    ).toBe(
      'The analysis cohort changed after this step ran. Run all reruns it.',
    )
    expect(
      outdatedColumnReason(
        'qcsub',
        snapshot(cohortCaused, { cause: 'membership' }),
      ),
    ).toBe(
      'The analysis cohort changed after this step ran. Run all reruns it.',
    )
    expect(
      outdatedColumnReason(
        'qcsub',
        snapshot(cohortCaused, {
          cause: 'membership',
          reasons: [
            { kind: 'config-exclusion', subjectIds: ['sub-003'], count: 1 },
          ],
        }),
      ),
    ).toBe(
      'The analysis cohort changed after this step ran: the saved subject selection changed for sub-003. Run all reruns it.',
    )
    expect(
      outdatedColumnReason(
        'recon',
        snapshot({ recon: { state: 'outdated', outdatedSubjectIds: [] } }),
      ),
    ).toBe(
      'Its output no longer matches the current inputs. Run all reruns it.',
    )
  })

  it('keeps the cohort cause out when another producer of the column lacks it', () => {
    expect(
      outdatedColumnReason(
        'feat',
        snapshot(
          {
            features: OUTDATED_BY_COHORT,
            age: { state: 'outdated', outdatedSubjectIds: [] },
          },
          { cause: 'membership' },
        ),
      ),
    ).toBe(
      'Its output no longer matches the current inputs. Run all reruns it.',
    )
  })
})

describe('stageCurrencyNotice', () => {
  it('lists only out-of-date cohort stages that some subject finished', () => {
    const rows = [finished('sub-001', { stepStates: { enigma: 'done' } })]
    expect(
      stageCurrencyNotice(
        rows,
        snapshot(
          { enigma: OUTDATED_BY_COHORT, final: OUTDATED_BY_COHORT },
          { cause: 'membership' },
        ),
      ),
    ).toEqual({
      headline:
        'ENIGMA QC is out of date for 1 subject: the analysis cohort changed after it ran.',
      detail: 'Run all reruns it.',
    })
    expect(stageCurrencyNotice(rows, snapshot({}))).toBeNull()
  })

  describe('after a run that did not finish its cohort stages', () => {
    const OUTDATED: ResultStageCurrency = {
      state: 'outdated',
      outdatedSubjectIds: [],
    }
    /** Every cohort stage a Run all reruns in the entry, out of date. */
    const currency = snapshot({
      enigma: OUTDATED,
      outliers: OUTDATED,
      features: OUTDATED,
      age: OUTDATED,
      aggregate: OUTDATED,
    })
    /** A subject whose newest ENIGMA QC, feature, and aggregation job ended. */
    function ended(id: string, state: CellState): Subject {
      return finished(id, {
        stepStates: {
          ...Object.fromEntries(STEP_KEYS.map((key) => [key, 'done'])),
          enigma: state,
          features: state,
          aggregate: state,
        },
      })
    }

    it.each([
      // A Cancel all during a Run all.
      ['cancelled', 'were canceled'],
      // A Run all that an app crash interrupted.
      ['interrupted', 'were interrupted'],
    ] as const)(
      'names the stages whose %s jobs Run all reruns',
      (state, outcome) => {
        const rows = ['sub-101', 'sub-901', 'sub-902'].map((id) =>
          ended(id, state),
        )
        expect(stageCurrencyNotice(rows, currency)).toEqual({
          headline: '2 cohort stages are out of date for 3 subjects.',
          detail: `Run all reruns Histogram and outlier review and Age metadata integration. ENIGMA QC, FreeSurfer feature extraction, and Structural data aggregation ${outcome}; Run all reruns them too.`,
        })
      },
    )

    it('names canceled stages over a cohort that grew', () => {
      // A canceled Run all in which the fourth subject is new and has no
      // finished cohort output.
      const rows = ['sub-101', 'sub-901', 'sub-902'].map((id) =>
        ended(id, 'cancelled'),
      )
      rows.push(
        finished('sub-908', {
          stepStates: {
            recon: 'done',
            enigma: 'cancelled',
            features: 'cancelled',
            aggregate: 'cancelled',
          },
        }),
      )
      expect(stageCurrencyNotice(rows, currency)?.detail).toBe(
        'Run all reruns Histogram and outlier review and Age metadata integration. ENIGMA QC, FreeSurfer feature extraction, and Structural data aggregation were canceled; Run all reruns them too.',
      )
    })

    it('words one stage, and stages that ended in different ways', () => {
      const one = finished('sub-001', {
        stepStates: { enigma: 'cancelled', outliers: 'done' },
      })
      expect(
        stageCurrencyNotice(
          [one],
          snapshot({ enigma: OUTDATED, outliers: OUTDATED }),
        ),
      ).toEqual({
        headline: 'Histogram and outlier review is out of date for 1 subject.',
        detail:
          'Run all reruns it. ENIGMA QC was canceled; Run all reruns it too.',
      })
      const mixed = finished('sub-001', {
        stepStates: {
          enigma: 'failed',
          outliers: 'done',
          features: 'interrupted',
          age: 'cancelled',
          aggregate: 'cancelled',
        },
      })
      expect(stageCurrencyNotice([mixed], currency)?.detail).toBe(
        'Run all reruns it. ENIGMA QC failed, FreeSurfer feature extraction was interrupted, and Age metadata integration and Structural data aggregation were canceled; Run all reruns them too.',
      )
    })

    it('leaves out a stage Run all would not rerun, and states nothing without finished output', () => {
      const rows = ['sub-101', 'sub-901'].map((id) => ended(id, 'cancelled'))
      // A canceled stage whose receipt is still current is not rerun.
      expect(
        stageCurrencyNotice(
          rows,
          snapshot({
            outliers: OUTDATED,
            enigma: { state: 'current', outdatedSubjectIds: [] },
            features: { state: 'unknown', outdatedSubjectIds: [] },
          }),
        ),
      ).toEqual({
        headline: 'Histogram and outlier review is out of date for 2 subjects.',
        detail: 'Run all reruns it.',
      })
      // Without finished out-of-date output the notice does not show; the
      // Canceled count and the Subjects banner state the canceled work.
      expect(
        stageCurrencyNotice(
          rows,
          snapshot({ enigma: OUTDATED, features: OUTDATED }),
        ),
      ).toBeNull()
    })
  })

  it('names the analysis subjects whose finished results the stages hold', () => {
    const rows = [
      finished('sub-001'),
      finished('sub-002'),
      // Excluded from analysis: the cohort stages do not hold its results.
      finished('sub-003', { qc: 'fail', analysisEligible: false }),
      // Its cohort stages never finished.
      finished('sub-004', { stepStates: { recon: 'done' } }),
    ]
    expect(
      stageCurrencyNotice(
        rows,
        snapshot(
          { enigma: OUTDATED_BY_COHORT, final: OUTDATED_BY_COHORT },
          { cause: 'membership' },
        ),
      )?.headline,
    ).toBe(
      '2 cohort stages are out of date for 2 subjects: the analysis cohort changed after they ran.',
    )
  })
})
