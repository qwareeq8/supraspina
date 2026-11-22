import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import { MATRIX_STEPS } from '../../shared/steps'
import type { StepKey } from '../../shared/steps'
import { emptyCell } from '../../shared/types'
import type { CellState, StageBlocker, Subject } from '../../shared/types'
import {
  computeDependencyBlockers,
  mergeBlockedByStep,
} from './dependency-blockers'

/** Build a subject whose listed pipeline steps are `done` (per-step signal). */
function subject(id: string, doneSteps: readonly StepKey[] = []): Subject {
  const stepStates: Partial<Record<StepKey, CellState>> = {}
  for (const step of doneSteps) stepStates[step] = 'done'
  return {
    id,
    age: 40,
    sex: 'M',
    cohort: 'CTRL',
    ais: null,
    tSinceSci: null,
    cells: MATRIX_STEPS.map(() => emptyCell()),
    stepStates,
    qc: null,
    notes: '',
    registered: true,
    analysisEligible: true,
  }
}

const blockedKeys = (
  subjects: readonly Subject[],
  ids?: readonly string[],
): string[] =>
  computeDependencyBlockers(
    subjects,
    ids ? { mode: 'explicit', subjectIds: [...ids] } : undefined,
  )
    .map((b) => b.key)
    .sort()

describe('computeDependencyBlockers', () => {
  it('returns no blockers for an empty cohort', () => {
    expect(computeDependencyBlockers([])).toEqual([])
  })

  it('blocks every dependent stage when reconstruction has produced nothing', () => {
    // Start with no completed steps. Block reconstruction dependents and every
    // transitive descendant.
    const cohort = [subject('sub-001'), subject('sub-002')]
    expect(blockedKeys(cohort)).toEqual([
      'age',
      'aggregate',
      'braincharts',
      'brainpad',
      'clinical',
      'enigma',
      'features',
      'final',
      'outliers',
      'pybrainage',
      'zstats',
    ])
  })

  it('never blocks reconstruction or defacing root nodes', () => {
    const blocked = new Set(blockedKeys([subject('sub-001')]))
    expect(blocked.has('recon')).toBe(false)
    expect(blocked.has('deface')).toBe(false)
  })

  it('keeps cohort consumers blocked until every analysis subject finishes recon', () => {
    const cohort = [subject('sub-001', ['recon']), subject('sub-002')]
    const blocked = new Set(blockedKeys(cohort))
    expect(blocked.has('features')).toBe(true)
    expect(blocked.has('enigma')).toBe(true)
    expect(blocked.has('aggregate')).toBe(true)

    const complete = new Set(
      blockedKeys([
        subject('sub-001', ['recon']),
        subject('sub-002', ['recon']),
      ]),
    )
    expect(complete.has('features')).toBe(false)
    expect(complete.has('enigma')).toBe(false)
    expect(complete.has('aggregate')).toBe(false)
    // Keep descendants blocked until their own prerequisite produces output.
    expect(blocked.has('age')).toBe(true)
    expect(blocked.has('outliers')).toBe(true)
    expect(blocked.has('final')).toBe(true)
  })

  it('distinguishes features from age on the shared feature column', () => {
    // Keep features and age distinct through per-step state despite their shared
    // `feat` matrix column. Leave PyBrainAge blocked until age finishes.
    const blocked = new Set(
      blockedKeys([subject('sub-001', ['recon', 'features'])]),
    )
    expect(blocked.has('age')).toBe(false)
    expect(blocked.has('pybrainage')).toBe(true)
    // Unblock PyBrainAge after age finishes.
    const next = new Set(
      blockedKeys([subject('sub-001', ['recon', 'features', 'age'])]),
    )
    expect(next.has('pybrainage')).toBe(false)
    expect(next.has('clinical')).toBe(true)
  })

  it('does not narrow cohort-stage prerequisites to the selected subset', () => {
    const cohort = [subject('sub-001', ['recon']), subject('sub-002')]
    expect(new Set(blockedKeys(cohort)).has('features')).toBe(true)
    expect(new Set(blockedKeys(cohort, ['sub-002'])).has('features')).toBe(true)
    expect(new Set(blockedKeys(cohort, ['sub-001'])).has('features')).toBe(true)
  })

  it('treats a missing explicit subject as an empty per-subject scope', () => {
    const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
    cfg.steps.deface.enabled = true
    const blockers = computeDependencyBlockers(
      [subject('sub-001')],
      { mode: 'explicit', subjectIds: ['sub-does-not-exist'] },
      cfg,
    )
    expect(blockers.find((blocker) => blocker.key === 'recon')).toBeUndefined()
    expect(blockers.find((blocker) => blocker.key === 'features')).toBeDefined()
  })

  it('carries an actionable reason naming the missing prerequisite', () => {
    const blockers = computeDependencyBlockers([subject('sub-001')])
    expect(blockers.find((b) => b.key === 'features')?.reason).toMatch(
      /reconstruction/,
    )
    expect(blockers.find((b) => b.key === 'final')?.reason).toMatch(
      /aggregation/,
    )
  })
})

describe('mergeBlockedByStep', () => {
  it('prefers the tool reason when a step has both blockers', () => {
    const tool: StageBlocker[] = [
      { key: 'features', reason: 'tool: FreeSurfer missing' },
    ]
    const dep: StageBlocker[] = [
      { key: 'features', reason: 'dep: needs recon' },
    ]
    expect(mergeBlockedByStep(tool, dep).get('features')).toBe(
      'tool: FreeSurfer missing',
    )
  })

  it('includes steps blocked only by a dependency', () => {
    const dep: StageBlocker[] = [{ key: 'age', reason: 'dep: needs features' }]
    const map = mergeBlockedByStep([], dep)
    expect(map.get('age')).toBe('dep: needs features')
    expect(map.has('features')).toBe(false)
  })
})
