import { describe, expect, it } from 'vitest'
import { effectiveQcVerdict, subjectsInConfigScope } from './analysis-cohort'
import type { Subject } from './types'

const reviewEvidence = {
  evidenceVersion: 1,
  reviewer: 'fixture-reviewer',
  reviewedAt: '2026-09-24T12:00:00.000Z',
  galleries: [],
} as const

describe('effectiveQcVerdict', () => {
  it('reads a missing record or verdict as unreviewed', () => {
    expect(effectiveQcVerdict(null)).toBeNull()
    expect(effectiveQcVerdict(undefined)).toBeNull()
    expect(effectiveQcVerdict({})).toBeNull()
    expect(effectiveQcVerdict({ verdict: null, reviewEvidence })).toBeNull()
  })

  it('reads a verdict outside Pass, Fail, and Defer as unreviewed', () => {
    expect(
      effectiveQcVerdict({ verdict: 'unreviewed', reviewEvidence }),
    ).toBeNull()
    expect(effectiveQcVerdict({ verdict: 'PASS', reviewEvidence })).toBeNull()
  })

  it('reads Pass or Fail without review evidence as unreviewed', () => {
    for (const verdict of ['pass', 'fail']) {
      expect(effectiveQcVerdict({ verdict })).toBeNull()
      expect(effectiveQcVerdict({ verdict, reviewEvidence: null })).toBeNull()
    }
  })

  it('keeps Defer without review evidence', () => {
    expect(effectiveQcVerdict({ verdict: 'defer' })).toBe('defer')
    expect(effectiveQcVerdict({ verdict: 'defer', reviewEvidence: null })).toBe(
      'defer',
    )
  })

  it('keeps every verdict backed by review evidence', () => {
    expect(effectiveQcVerdict({ verdict: 'pass', reviewEvidence })).toBe('pass')
    expect(effectiveQcVerdict({ verdict: 'fail', reviewEvidence })).toBe('fail')
    expect(effectiveQcVerdict({ verdict: 'defer', reviewEvidence })).toBe(
      'defer',
    )
  })
})

describe('subjectsInConfigScope', () => {
  const rows = ['sub-001', 'sub-002', 'sub-003'].map(
    (id) => ({ id }) as Subject,
  )
  const ids = (subjects: Subject[]) => subjects.map((subject) => subject.id)

  it('subtracts the exclude list and limits to a nonempty include list', () => {
    expect(
      ids(subjectsInConfigScope(rows, { include: [], exclude: ['sub-002'] })),
    ).toEqual(['sub-001', 'sub-003'])
    expect(
      ids(
        subjectsInConfigScope(rows, {
          include: ['sub-001', 'sub-002'],
          exclude: ['sub-002'],
        }),
      ),
    ).toEqual(['sub-001'])
  })

  it('ignores unsafe listed IDs as discovery does', () => {
    expect(
      ids(subjectsInConfigScope(rows, { include: ['../x'], exclude: [] })),
    ).toEqual(['sub-001', 'sub-002', 'sub-003'])
  })
})
