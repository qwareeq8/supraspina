/** Tests for the shared run-scope labels. */

import { describe, it, expect } from 'vitest'
import {
  COHORT_LOADING_VALUE,
  cohortCutTitle,
  knownCohortSize,
  scopePillLabel,
  runButtonLabel,
  targetRunButtonLabel,
  targetScopePillLabel,
} from './run-scope'

describe('scopePillLabel', () => {
  it('reads "No subjects" for an empty cohort', () => {
    expect(scopePillLabel(0, 0)).toBe('No subjects')
  })

  it('reads "All N subjects" with no selection', () => {
    expect(scopePillLabel(0, 42)).toBe('All 42 subjects')
    expect(scopePillLabel(0, 1)).toBe('All 1 subject')
  })

  it('reads "K of N selected" for a partial selection', () => {
    expect(scopePillLabel(3, 42)).toBe('3 of 42 selected')
    expect(scopePillLabel(1, 5)).toBe('1 of 5 selected')
  })
})

describe('runButtonLabel', () => {
  it('names the whole-cohort scope when nothing is selected', () => {
    expect(runButtonLabel(0, 42)).toBe('Run all 42')
  })

  it('falls back to "Run all" when the cohort is empty', () => {
    expect(runButtonLabel(0, 0)).toBe('Run all')
  })

  it('names the selected subset so the label cannot contradict the scope', () => {
    expect(runButtonLabel(3, 42)).toBe('Run 3 selected')
    expect(runButtonLabel(1, 5)).toBe('Run 1 selected')
  })
})

describe('authoritative workflow-target labels', () => {
  it('keeps all-mode distinct from an explicit empty selection', () => {
    expect(targetScopePillLabel({ mode: 'all' }, 3)).toBe('All 3 subjects')
    expect(targetScopePillLabel({ mode: 'all' }, 1)).toBe('All 1 subject')
    expect(targetScopePillLabel({ mode: 'explicit', subjectIds: [] }, 3)).toBe(
      'No subjects selected',
    )
    expect(targetRunButtonLabel({ mode: 'all' }, 3)).toBe('Run all 3')
    expect(targetRunButtonLabel({ mode: 'explicit', subjectIds: [] }, 3)).toBe(
      'Run selection',
    )
  })

  it('names an explicit eligible subset consistently on both controls', () => {
    const target = {
      mode: 'explicit' as const,
      subjectIds: ['sub-001', 'sub-003'],
    }
    expect(targetScopePillLabel(target, 4)).toBe('2 of 4 selected')
    expect(targetRunButtonLabel(target, 4)).toBe('Run 2 selected')
  })

  it('reports an empty analysis cohort independently of target mode', () => {
    expect(targetScopePillLabel({ mode: 'all' }, 0)).toBe(
      'No analysis-cohort subjects',
    )
    expect(targetRunButtonLabel({ mode: 'all' }, 0)).toBe('Run all')
  })
})

describe('cohort labels before and after discovery answers', () => {
  // A large project's cohort can take tens of seconds to load, and the dock
  // must not call it empty meanwhile.
  it('keeps the size unknown until discovery answers, and zero once it answers empty', () => {
    expect(knownCohortSize(false, 0)).toBeNull()
    expect(knownCohortSize(false, 82)).toBeNull()
    expect(knownCohortSize(true, 0)).toBe(0)
    expect(knownCohortSize(true, 82)).toBe(82)
  })

  it('holds the loading placeholder and no count while the cohort loads', () => {
    const loading = knownCohortSize(false, 0)
    expect(COHORT_LOADING_VALUE).toBe('--')
    expect(targetScopePillLabel({ mode: 'all' }, loading)).toBe('--')
    expect(
      targetScopePillLabel({ mode: 'explicit', subjectIds: [] }, loading),
    ).toBe('--')
    expect(targetRunButtonLabel({ mode: 'all' }, loading)).toBe('Run all')
  })

  it('states an empty cohort only once discovery answers with none', () => {
    const empty = knownCohortSize(true, 0)
    expect(targetScopePillLabel({ mode: 'all' }, empty)).toBe(
      'No analysis-cohort subjects',
    )
    expect(targetRunButtonLabel({ mode: 'all' }, empty)).toBe('Run all')
  })

  it('counts the answered cohort on the chip and Run all', () => {
    const answered = knownCohortSize(true, 82)
    expect(targetScopePillLabel({ mode: 'all' }, answered)).toBe(
      'All 82 subjects',
    )
    expect(targetRunButtonLabel({ mode: 'all' }, answered)).toBe('Run all 82')
  })
})

describe('cohortCutTitle', () => {
  it('names the QC cut between discovered subjects and the cohort', () => {
    expect(cohortCutTitle(20, 24, 4)).toBe(
      '20 of 24 subjects are in the analysis cohort; 4 failed QC.',
    )
  })

  it('names exclusions other than QC Fail', () => {
    expect(cohortCutTitle(20, 24, 3)).toBe(
      '20 of 24 subjects are in the analysis cohort; 3 failed QC and 1 is otherwise excluded.',
    )
    expect(cohortCutTitle(0, 1, 0)).toBe(
      '0 of 1 subject is in the analysis cohort; 1 is otherwise excluded.',
    )
  })

  it('returns null when the counts agree or the cohort is loading', () => {
    expect(cohortCutTitle(24, 24, 0)).toBeNull()
    expect(cohortCutTitle(null, 24, 4)).toBeNull()
  })
})
