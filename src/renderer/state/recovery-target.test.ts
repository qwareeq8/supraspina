import { describe, expect, it } from 'vitest'
import type { RunSnapshot } from '../../shared/contract'
import type { Job } from '../../shared/types'
import {
  cancelledRetryTarget,
  recoveredByLaterRun,
  recoveryTarget,
} from './recovery-target'

const FAILED_AT = Date.parse('2026-09-22T14:17:28')
const FINISHED_AT = Date.parse('2026-09-23T18:17:37')

function run(
  runId: string,
  status: RunSnapshot['status'],
  startedAt: number,
  endedAt: number | null = startedAt + 1_000,
  started = 0,
): RunSnapshot {
  return {
    runId,
    projectId: 'project',
    projectEpoch: 1,
    status,
    startedAt,
    endedAt,
    dryRun: false,
    durable: true,
    acknowledgements: {
      includeDeferredAndUnreviewedQc: false,
      acknowledgeMemoryAdvisory: false,
    },
    summary: {
      planned: 0,
      started,
      waiting: 0,
      blocked: 0,
      skipped: 0,
      message: '',
    },
  }
}

/** One job of a run, reduced to the fields recovery reads. */
function job(
  runId: string,
  stepKey: Job['stepKey'],
  subjectId: string | null,
  status: Job['status'],
): Job {
  return {
    id: `${runId}:${stepKey}:${subjectId ?? 'cohort'}`,
    runId,
    stepKey,
    subjectId,
    status,
  } as Job
}

/** The cohort stages the fixture runs planned after reconstruction. */
const COHORT_STAGES = ['enigma', 'features', 'aggregate'] as const

/** One job per fixture cohort stage, plus outliers and age when finished. */
function cohortJobs(runId: string, status: Job['status']): Job[] {
  const stages: Job['stepKey'][] =
    status === 'done'
      ? [...COHORT_STAGES, 'outliers', 'age']
      : [...COHORT_STAGES]
  return stages.map((stepKey) => job(runId, stepKey, null, status))
}

/**
 * A recorded run sequence: a finished Run all, an app crash that
 * interrupted the cohort stages, the Resume that finished them, a Cancel all
 * of the next run, and the Retry canceled that finished it. The started
 * counts are the runs' recorded summaries: the canceled run canceled outliers
 * and age before they had a job, and the crash interrupted every node, which
 * the summary does not count as started.
 */
const RECORDED_RUNS = {
  runAll: run('run-c2d4928abcfc', 'done', 1790374152041, 1790374486851, 9),
  crash: run('run-73c7e1979332', 'interrupted', 1790375242640, 1790375270667),
  resume: run('run-b22abc08d02d', 'done', 1790375936499, 1790375948769, 5),
  canceled: run(
    'run-5edb9a689625',
    'cancelled',
    1790376037856,
    1790376047033,
    5,
  ),
  retry: run('run-ecfbfb6a0c6c', 'done', 1790376120925, 1790376133068, 5),
}

/**
 * A Run all for sub-101 and sub-901, canceled while sub-901's reconstruction
 * ran: ENIGMA QC, outliers, features, age, and aggregation were waiting and
 * were canceled before they had a job, so the run's summary counts 7 started
 * nodes for 2 jobs. The Reconstruction card's Run then redid sub-901 alone.
 */
const CANCELED_BEFORE_JOBS = {
  canceled: run('run-cancelledAll', 'cancelled', FAILED_AT, null, 7),
  reconOnly: run('run-reconOnly', 'done', FINISHED_AT, null, 1),
}

const CANCELED_BEFORE_JOBS_JOBS: Job[] = [
  job('run-cancelledAll', 'recon', 'sub-101', 'done'),
  job('run-cancelledAll', 'recon', 'sub-901', 'cancelled'),
  job('run-reconOnly', 'recon', 'sub-901', 'done'),
]

const RECORDED_RUNS_JOBS: Job[] = [
  ...['sub-101', 'sub-901', 'sub-902', 'sub-906'].map((subjectId) =>
    job(RECORDED_RUNS.runAll.runId, 'recon', subjectId, 'done'),
  ),
  ...cohortJobs(RECORDED_RUNS.runAll.runId, 'done'),
  ...cohortJobs(RECORDED_RUNS.crash.runId, 'interrupted'),
  ...cohortJobs(RECORDED_RUNS.resume.runId, 'done'),
  ...cohortJobs(RECORDED_RUNS.canceled.runId, 'cancelled'),
  ...cohortJobs(RECORDED_RUNS.retry.runId, 'done'),
]

function shortTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

describe('recoveryTarget', () => {
  it.each(['failed', 'interrupted', 'persistence-error'] as const)(
    'targets the newest run while it is %s',
    (status) => {
      const newest = run('run-newest', status, FINISHED_AT)
      const target = recoveryTarget(
        [run('run-older', 'failed', FAILED_AT), newest],
        [],
      )

      expect(target).toEqual({ run: newest, reason: null })
    },
  )

  it('names the later run that superseded an older failure', () => {
    // The later run finished another stage, so the failed reconstruction
    // is still undone.
    const target = recoveryTarget(
      [
        run('run-8407b948c62b', 'failed', FAILED_AT),
        run('run-9a3301d38242', 'done', FINISHED_AT),
      ],
      [
        job('run-8407b948c62b', 'recon', 'sub-001', 'failed'),
        job('run-9a3301d38242', 'brainfov', 'sub-001', 'done'),
      ],
    )

    expect(target).toEqual({
      run: null,
      reason: `run-9a3301d38242 finished after the failed run of ${shortTime(FAILED_AT)}.`,
    })
  })

  it('cites no failure that a later run already recovered', () => {
    // The Resume that followed the crash settled it, so Resume reports
    // nothing waiting instead of naming a later run.
    const reason = 'no failed or interrupted run is waiting for recovery.'

    expect(
      recoveryTarget(Object.values(RECORDED_RUNS), RECORDED_RUNS_JOBS),
    ).toEqual({
      run: null,
      reason,
    })
    const beforeRetry = Object.values(RECORDED_RUNS).filter(
      (candidate) => candidate !== RECORDED_RUNS.retry,
    )
    expect(recoveryTarget(beforeRetry, RECORDED_RUNS_JOBS).reason).toBe(reason)
  })

  it('reads the later run by how it ended or that it is still going', () => {
    expect(
      recoveryTarget(
        [
          run('run-old', 'interrupted', FAILED_AT),
          run('run-new', 'cancelled', FINISHED_AT),
        ],
        [],
      ).reason,
    ).toBe(
      `run-new ended after the interrupted run of ${shortTime(FAILED_AT)}.`,
    )
    expect(
      recoveryTarget(
        [
          run('run-old', 'persistence-error', FAILED_AT),
          run('run-new', 'running', FINISHED_AT, null),
        ],
        [],
      ).reason,
    ).toBe(
      `run-new started after the run of ${shortTime(FAILED_AT)} that hit a persistence error.`,
    )
  })

  it('explains that nothing waits for recovery without any failed run', () => {
    const reason = 'no failed or interrupted run is waiting for recovery.'

    expect(recoveryTarget([], [])).toEqual({ run: null, reason })
    expect(recoveryTarget([run('run-done', 'done', FINISHED_AT)], [])).toEqual({
      run: null,
      reason,
    })
  })

  it('picks the newest run by start time, not by list order', () => {
    const newest = run('run-newest', 'failed', FINISHED_AT)

    expect(
      recoveryTarget([newest, run('run-older', 'done', FAILED_AT)], []).run,
    ).toBe(newest)
  })
})

describe('recoveredByLaterRun', () => {
  const failed = run('run-failed', 'failed', FAILED_AT)
  const failedJobs = [
    job('run-failed', 'recon', 'sub-001', 'done'),
    job('run-failed', 'recon', 'sub-002', 'failed'),
  ]

  it('needs every unfinished job finished for its stage and subject later', () => {
    const later = run('run-later', 'done', FINISHED_AT)

    expect(
      recoveredByLaterRun(
        failed,
        [failed, later],
        [...failedJobs, job('run-later', 'recon', 'sub-002', 'done')],
      ),
    ).toBe(true)
    // A later job for another subject, or one that failed again, leaves the
    // work undone.
    expect(
      recoveredByLaterRun(
        failed,
        [failed, later],
        [
          ...failedJobs,
          job('run-later', 'recon', 'sub-001', 'done'),
          job('run-later', 'recon', 'sub-002', 'failed'),
        ],
      ),
    ).toBe(false)
  })

  it('ignores earlier runs and later dry runs', () => {
    const earlier = run('run-earlier', 'done', FAILED_AT - 60_000)
    const dry = { ...run('run-dry', 'done', FINISHED_AT), dryRun: true }

    expect(
      recoveredByLaterRun(
        failed,
        [earlier, failed, dry],
        [
          ...failedJobs,
          job('run-earlier', 'recon', 'sub-002', 'done'),
          job('run-dry', 'recon', 'sub-002', 'done'),
        ],
      ),
    ).toBe(false)
  })

  it('needs later runs to redo the nodes a canceled run left without a job', () => {
    const { canceled, reconOnly } = CANCELED_BEFORE_JOBS

    // The later run redid the canceled reconstruction only; the five stages
    // canceled before they had a job were never run again.
    expect(
      recoveredByLaterRun(
        canceled,
        [canceled, reconOnly],
        CANCELED_BEFORE_JOBS_JOBS,
      ),
    ).toBe(false)
    const rerun = run('run-rerun', 'done', FINISHED_AT + 60_000, null, 5)
    const stages = ['enigma', 'outliers', 'features', 'age', 'aggregate']
    const rerunJobs = stages.map((stepKey) =>
      job('run-rerun', stepKey as Job['stepKey'], null, 'done'),
    )
    expect(
      recoveredByLaterRun(
        canceled,
        [canceled, reconOnly, rerun],
        [...CANCELED_BEFORE_JOBS_JOBS, ...rerunJobs],
      ),
    ).toBe(true)
    // Four of the five stages leave one still undone.
    expect(
      recoveredByLaterRun(
        canceled,
        [canceled, reconOnly, rerun],
        [...CANCELED_BEFORE_JOBS_JOBS, ...rerunJobs.slice(1)],
      ),
    ).toBe(false)
  })

  it('counts no later work for subjects outside the run toward its jobless nodes', () => {
    const canceled = {
      ...run('run-canceled', 'cancelled', FAILED_AT, null, 3),
      analysisSubjectIds: ['sub-001'],
      selectedSubjectIds: ['sub-001'],
    }
    const later = run('run-later', 'done', FINISHED_AT, null, 3)
    const jobs = [
      job('run-canceled', 'recon', 'sub-001', 'cancelled'),
      job('run-later', 'recon', 'sub-001', 'done'),
      // Two subjects added after the canceled run.
      job('run-later', 'recon', 'sub-908', 'done'),
      job('run-later', 'recon', 'sub-910', 'done'),
    ]

    expect(recoveredByLaterRun(canceled, [canceled, later], jobs)).toBe(false)
    expect(
      recoveredByLaterRun(
        canceled,
        [canceled, later],
        [
          ...jobs,
          job('run-later', 'enigma', null, 'done'),
          job('run-later', 'features', null, 'done'),
        ],
      ),
    ).toBe(true)
  })

  it('counts a run with no retained unfinished job recovered once a later run finished', () => {
    const canceled = run('run-canceled', 'cancelled', FAILED_AT)

    expect(
      recoveredByLaterRun(
        canceled,
        [canceled, run('run-later', 'failed', FINISHED_AT)],
        [],
      ),
    ).toBe(false)
    expect(
      recoveredByLaterRun(
        canceled,
        [canceled, run('run-later', 'done', FINISHED_AT)],
        [],
      ),
    ).toBe(true)
  })
})

describe('cancelledRetryTarget', () => {
  it('offers the canceled run until a later run finished its work', () => {
    // Retry canceled is withdrawn once run-ecfbfb6a0c6c has retried
    // run-5edb9a689625 to completion.
    const beforeRetry = Object.values(RECORDED_RUNS).filter(
      (candidate) => candidate !== RECORDED_RUNS.retry,
    )

    expect(cancelledRetryTarget(beforeRetry, RECORDED_RUNS_JOBS)).toEqual({
      run: RECORDED_RUNS.canceled,
      reason: null,
    })
    expect(
      cancelledRetryTarget(Object.values(RECORDED_RUNS), RECORDED_RUNS_JOBS),
    ).toEqual({
      run: null,
      reason: 'no canceled run is waiting for a retry.',
    })
  })

  it('still offers a canceled run whose stages canceled before they had a job were not redone', () => {
    // A later Reconstruction-only run redoes the canceled reconstruction,
    // but ENIGMA QC and every later stage still wait for Retry canceled.
    const runs = Object.values(CANCELED_BEFORE_JOBS)

    expect(cancelledRetryTarget(runs, CANCELED_BEFORE_JOBS_JOBS)).toEqual({
      run: CANCELED_BEFORE_JOBS.canceled,
      reason: null,
    })
  })

  it('picks the newest canceled run that is still undone', () => {
    const older = run('run-older', 'cancelled', FAILED_AT)
    const newer = run('run-newer', 'cancelled', FAILED_AT + 60_000)
    const retry = run('run-retry', 'done', FINISHED_AT)
    const jobs = [
      job('run-older', 'recon', 'sub-001', 'cancelled'),
      job('run-newer', 'enigma', null, 'cancelled'),
    ]

    expect(cancelledRetryTarget([older, newer], jobs).run).toBe(newer)
    // The retry finished the newer run's work; the older run's stays undone.
    expect(
      cancelledRetryTarget(
        [newer, retry, older],
        [...jobs, job('run-retry', 'enigma', null, 'done')],
      ).run,
    ).toBe(older)
  })
})
