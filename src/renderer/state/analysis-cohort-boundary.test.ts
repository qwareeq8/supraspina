import { describe, expect, it } from 'vitest'
import {
  analysisEligibleSubjects,
  analysisIneligibilityReason,
  emptyAnalysisCohortReason,
  isAnalysisEligible,
  normalizeAnalysisEligibility,
  normalizeAnalysisSubjects,
} from '../../shared/analysis-cohort'
import { MATRIX_STEPS } from '../../shared/steps'
import { emptyCell, type Subject } from '../../shared/types'

function subject(
  id: string,
  qc: Subject['qc'],
  analysisEligible: boolean,
  unavailableReason: string | null = null,
): Subject {
  return {
    id,
    age: 40,
    sex: 'M',
    cohort: 'UNKNOWN',
    ais: null,
    tSinceSci: null,
    cells: MATRIX_STEPS.map(() => emptyCell()),
    qc,
    notes: '',
    registered: true,
    analysisEligible,
    unavailableReason,
  }
}

describe('authoritative analysis cohort boundary', () => {
  it('retains only explicit backend eligibility while always excluding QC Fail', () => {
    const rows = [
      subject('pass', 'pass', true),
      subject('defer', 'defer', true),
      subject('unreviewed', null, true),
      subject('backend-ineligible', 'pass', false),
      {
        ...subject('missing-eligibility', 'pass', false),
        analysisEligible: undefined,
      } as unknown as Subject,
      subject('contradictory-fail', 'fail', true),
    ]

    const normalized = normalizeAnalysisSubjects(rows)
    expect(normalized.map((row) => row.analysisEligible)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ])
    expect(analysisEligibleSubjects(normalized).map((row) => row.id)).toEqual([
      'pass',
      'defer',
      'unreviewed',
    ])
    expect(isAnalysisEligible(rows[0]!)).toBe(true)
    expect(isAnalysisEligible(rows[5]!)).toBe(false)
    expect(normalizeAnalysisEligibility(rows[5]!).analysisEligible).toBe(false)
  })

  it('reports QC, backend, and fallback ineligibility reasons accessibly', () => {
    expect(analysisIneligibilityReason(subject('failed', 'fail', false))).toBe(
      'Excluded from analysis: the QC verdict is Fail.',
    )
    expect(
      analysisIneligibilityReason(
        subject('missing-t1', 'pass', false, '  Provide the T1 input.  '),
      ),
    ).toBe('Provide the T1 input.')
    expect(
      analysisIneligibilityReason(subject('fallback', 'pass', false, '   ')),
    ).toBe('Excluded from the current analysis cohort.')
    expect(
      analysisIneligibilityReason(subject('no-reason', 'pass', false)),
    ).toBe('Excluded from the current analysis cohort.')
  })

  it('distinguishes empty discovery, all-failed, and other empty cohorts', () => {
    expect(emptyAnalysisCohortReason([])).toBe(
      'Add subjects to the configured data root before running.',
    )
    expect(
      emptyAnalysisCohortReason([
        subject('failed-a', 'fail', false),
        subject('failed-b', 'fail', false),
      ]),
    ).toBe('Change at least one QC Fail verdict before running.')
    expect(
      emptyAnalysisCohortReason([
        subject('unavailable', 'pass', false, 'Provide the T1 input.'),
      ]),
    ).toBe('Resolve subject eligibility before running.')
  })
})
