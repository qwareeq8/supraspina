import { describe, expect, it } from 'vitest'
import { MATRIX_STEPS } from '../../shared/steps'
import { emptyCell, type CellState, type Subject } from '../../shared/types'
import {
  CURRENCY_BUCKETS,
  describeSubjectBuckets,
  SUBJECT_BUCKET_LABEL,
  shownSubjectBuckets,
  SUBJECT_BUCKETS,
  tallySubjectBuckets,
} from './subject-buckets'

/** Build a subject whose every matrix cell is in one state. */
function subject(id: string, state: CellState): Subject {
  return {
    id,
    age: 40,
    sex: 'F',
    cohort: 'SCI_P',
    ais: 'D',
    tSinceSci: 2,
    cells: MATRIX_STEPS.map(() => ({ ...emptyCell(), st: state })),
    qc: 'pass',
    notes: '',
    registered: true,
    analysisEligible: true,
  }
}

/** Build a subject whose own step is done and whose later steps are not. */
function finishedOwnStep(id: string, rest: CellState): Subject {
  const row = subject(id, rest)
  row.cells[0] = { ...row.cells[0]!, st: 'done' }
  return row
}

describe('subject buckets', () => {
  it('lists every bucket once, in one order, with one name', () => {
    expect(SUBJECT_BUCKETS).toEqual([
      'done',
      'outdated',
      'partial',
      'running',
      'failed',
      'interrupted',
      'cancelled',
      'pending',
      'excluded',
    ])
    expect(
      SUBJECT_BUCKETS.map((bucket) => SUBJECT_BUCKET_LABEL[bucket]),
    ).toEqual([
      'Done',
      'Out of date',
      'Partly done',
      'Running',
      'Failed',
      'Interrupted',
      'Canceled',
      'Pending',
      'Excluded',
    ])
  })

  it('counts each subject in exactly one bucket', () => {
    const rows = [
      subject('sub-001', 'done'),
      finishedOwnStep('sub-002', 'outdated'),
      finishedOwnStep('sub-003', 'outdated'),
      finishedOwnStep('sub-004', 'pending'),
      subject('sub-005', 'running'),
      subject('sub-006', 'blocked'),
      subject('sub-007', 'pending'),
      subject('sub-008', 'interrupted'),
      subject('sub-009', 'cancelled'),
    ]
    const counts = tallySubjectBuckets(rows)

    expect(counts).toEqual({
      done: 1,
      outdated: 2,
      partial: 1,
      running: 1,
      failed: 1,
      interrupted: 1,
      cancelled: 1,
      pending: 1,
      excluded: 0,
    })
    expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(
      rows.length,
    )
  })

  it('words every count in the shared order', () => {
    expect(
      describeSubjectBuckets({
        done: 0,
        outdated: 82,
        partial: 0,
        running: 0,
        failed: 0,
        interrupted: 0,
        cancelled: 0,
        pending: 0,
        excluded: 0,
      }),
    ).toBe(
      '0 done, 82 out of date, 0 partly done, 0 running, 0 failed, and 0 pending',
    )
  })

  it('names interrupted and canceled subjects only when there are some', () => {
    expect(
      describeSubjectBuckets({
        done: 1,
        outdated: 0,
        partial: 1,
        running: 0,
        failed: 0,
        interrupted: 2,
        cancelled: 1,
        pending: 1,
        excluded: 0,
      }),
    ).toBe(
      '1 done, 0 out of date, 1 partly done, 0 running, 0 failed, 2 interrupted, 1 canceled, and 1 pending',
    )
  })

  it('counts and names excluded subjects only when there are some', () => {
    const failed = subject('sub-010', 'pending')
    failed.qc = 'fail'
    failed.cells[0] = { ...failed.cells[0]!, st: 'done' }
    const counts = tallySubjectBuckets([failed, subject('sub-011', 'pending')])

    expect(counts.excluded).toBe(1)
    expect(counts.partial).toBe(0)
    expect(shownSubjectBuckets(counts)).toContain('excluded')
    expect(describeSubjectBuckets(counts)).toContain('1 excluded')
    const none = tallySubjectBuckets([subject('sub-012', 'pending')])
    expect(shownSubjectBuckets(none)).not.toContain('excluded')
    expect(shownSubjectBuckets(none, 'excluded')).toContain('excluded')
    expect(describeSubjectBuckets(none)).not.toContain('excluded')
  })

  it('joins Done and Out of date until the stage currency read lands', () => {
    // The read only moves subjects between these two buckets, so their sum
    // is known before it lands and their split is not.
    expect(
      describeSubjectBuckets(
        {
          done: 90,
          outdated: 0,
          partial: 1,
          running: 0,
          failed: 2,
          interrupted: 0,
          cancelled: 0,
          pending: 0,
          excluded: 0,
        },
        false,
      ),
    ).toBe(
      '90 done or out of date, 1 partly done, 0 running, 2 failed, and 0 pending',
    )
    expect([...CURRENCY_BUCKETS]).toEqual(['done', 'outdated'])
  })
})
