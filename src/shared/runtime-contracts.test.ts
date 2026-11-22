import { describe, expect, it } from 'vitest'
import { parseRuntimeJob } from './runtime-contracts'

/** One -no-fix-with-ga rerun as the sidecar records it on the job. */
function singleFallback(): Record<string, unknown> {
  return {
    kind: 'freesurfer-no-fix-with-ga',
    addedArguments: ['-no-fix-with-ga'],
    reason:
      'mris_fix_topology crashed in the genetic surface topology fix (-ga).',
    firstAttemptExitCode: 134,
  }
}

/** One failed Reconstruction job as the sidecar publishes it. */
function failedRecon(extra: Record<string, unknown> = {}): unknown {
  return {
    id: '#recon-1',
    stepKey: 'recon',
    subjectId: 'sub-101',
    startedAt: 1,
    endedAt: 2,
    exitCode: 1,
    cmd: 'recon-all -subject sub-101 -all',
    stdoutPath: '/p/.supraspina/runs/run-1/logs/recon-1.log',
    stderrPath: '/p/.supraspina/runs/run-1/logs/recon-1.log',
    envSnapshotPath: '',
    configSnapshotPath: '',
    status: 'failed',
    terminalReason:
      'recon-all -s sub-101 exited with ERRORS at Thu Jan  1 22:15:33 UTC 2026',
    ...extra,
  }
}

describe('parseRuntimeJob', () => {
  it('keeps the failure cause the sidecar read from recon-all output', () => {
    // The cause is what recon-all's closing line does not state.
    const job = parseRuntimeJob(
      failedRecon({
        failureCause: 'label-cortex failed: found no voxels matching id 1',
      }),
    )

    expect(job.failureCause).toBe(
      'label-cortex failed: found no voxels matching id 1',
    )
    expect(job.terminalReason).toMatch(/exited with ERRORS/)
  })

  it('omits an absent cause and an absent fallback record', () => {
    const job = parseRuntimeJob(failedRecon())

    expect(job).not.toHaveProperty('failureCause')
    expect(job).not.toHaveProperty('executionFallback')
  })

  it('keeps the rerun record of a Reconstruction that reran', () => {
    // The rerun must reach the renderer, not stay in the receipt JSON.
    const fallback = singleFallback()
    const job = parseRuntimeJob(
      failedRecon({ status: 'done', exitCode: 0, executionFallback: fallback }),
    )

    expect(job.executionFallback).toEqual(fallback)
  })

  it.each([
    [{ kind: 'freesurfer-no-fix-ga' }],
    [null],
    [{ ...singleFallback(), extra: true }],
  ])('rejects a malformed fallback record %#', (executionFallback) => {
    expect(() => parseRuntimeJob(failedRecon({ executionFallback }))).toThrow(
      'Provide a valid job execution fallback.',
    )
  })

  it('keeps the per-subject reuse decision of a cohort stage', () => {
    const unitReuse = {
      computedSubjectIds: ['sub-009'],
      reusedSubjectIds: ['sub-001'],
      sourceRunIds: ['run-8407b948c62b'],
    }
    expect(parseRuntimeJob(failedRecon({ unitReuse })).unitReuse).toEqual(
      unitReuse,
    )
    expect(parseRuntimeJob(failedRecon())).not.toHaveProperty('unitReuse')
    expect(() =>
      parseRuntimeJob(failedRecon({ unitReuse: { ...unitReuse, extra: 1 } })),
    ).toThrow('Provide a valid job per-subject reuse.')
  })

  it.each([[''], [42], [null], ['x'.repeat(8_193)]])(
    'rejects a malformed failure cause %#',
    (failureCause) => {
      expect(() => parseRuntimeJob(failedRecon({ failureCause }))).toThrow(
        'Provide a bounded failure cause.',
      )
    },
  )
})
