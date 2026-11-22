import { describe, expect, it } from 'vitest'
import type { RunSnapshot } from '../../shared/contract'
import {
  DEFAULT_PROJECT_CONFIG,
  type ProjectConfig,
} from '../../shared/project-schema'
import { MATRIX_STEPS, type StepKey } from '../../shared/steps'
import {
  emptyCell,
  type CellState,
  type Job,
  type JobStatus,
  type ManifestStepStatus,
  type RunManifest,
  type Subject,
} from '../../shared/types'
import {
  blockedRunSummaryReason,
  cohortStageWait,
  nameBlockedStage,
  projectSubjectRuntimeStatus,
  skipDisabledStages,
  stageEnabled,
  subjectAttention,
  subjectAuxiliaryDisplayStatus,
  subjectDisplayBucket,
} from './subject-runtime-status'

/** Build one detector-derived subject with a uniform matrix state. */
function subject(id: string, state: CellState = 'pending'): Subject {
  return {
    id,
    age: 40,
    sex: 'F',
    cohort: 'SCI_P',
    ais: 'D',
    tSinceSci: 2,
    cells: MATRIX_STEPS.map(() => ({ ...emptyCell(), st: state })),
    stepStates: { recon: 'done' },
    qc: 'pass',
    notes: '',
    registered: true,
    analysisEligible: true,
  }
}

/** Build one durable non-dry runtime snapshot. */
function run(
  runId: string,
  startedAt: number | null,
  selectedSubjectIds?: string[],
  dryRun = false,
  analysisSubjectIds = selectedSubjectIds,
): RunSnapshot {
  return {
    runId,
    projectId: 'project',
    projectEpoch: 1,
    status: dryRun ? 'done' : 'running',
    startedAt,
    endedAt: dryRun && startedAt !== null ? startedAt + 1 : null,
    dryRun,
    durable: true,
    ...(analysisSubjectIds ? { analysisSubjectIds } : {}),
    ...(selectedSubjectIds ? { selectedSubjectIds } : {}),
    acknowledgements: {
      includeDeferredAndUnreviewedQc: false,
      acknowledgeMemoryAdvisory: false,
    },
    summary: {
      planned: 1,
      started: dryRun ? 0 : 1,
      waiting: 0,
      blocked: 0,
      skipped: 0,
      message: 'fixture',
    },
  }
}

/** Build one job with only projection-relevant fields varied by the caller. */
function job(
  id: string,
  runId: string,
  stepKey: StepKey,
  subjectId: string | null,
  status: JobStatus,
  startedAt: number | null,
  endedAt: number | null = null,
  overrides: Partial<Job> = {},
): Job {
  return {
    id,
    runId,
    stepKey,
    subjectId,
    startedAt,
    endedAt,
    exitCode: status === 'done' ? 0 : status === 'failed' ? 1 : null,
    cmd: 'fixture',
    stdoutPath: 'stdout.log',
    stderrPath: 'stderr.log',
    envSnapshotPath: 'env.json',
    configSnapshotPath: 'config.json',
    status,
    ...overrides,
  }
}

describe('projectSubjectRuntimeStatus', () => {
  it('overlays a subject job without mutating detector state', () => {
    const source = subject('sub-001')
    const sourceSnapshot = structuredClone(source)
    const stepStates = source.stepStates

    const result = projectSubjectRuntimeStatus(
      [source],
      [run('run-current', 100, [source.id])],
      [job('job-1', 'run-current', 'recon', source.id, 'running', 110)],
    )

    expect(result[0]?.cells[0]).toMatchObject({
      st: 'running',
      startedAt: 110,
      finishedAt: null,
    })
    expect(result[0]).not.toBe(source)
    expect(result[0]?.cells[0]).not.toBe(source.cells[0])
    expect(result[0]?.stepStates).not.toBe(stepStates)
    expect(result[0]?.stepStates).toMatchObject({ recon: 'running' })
    expect(source).toEqual(sourceSnapshot)
  })

  it("states a failed Reconstruction's cause instead of recon-all's closing line", () => {
    // The closing line "recon-all -s ... exited with ERRORS at ..." hides
    // the failing step.
    const source = subject('sub-130')
    const closing =
      'recon-all -s sub-130 exited with ERRORS at Thu Jan  1 22:15:33 UTC 2026'

    const [withCause] = projectSubjectRuntimeStatus(
      [source],
      [run('run-current', 100, [source.id])],
      [
        job('job-1', 'run-current', 'recon', source.id, 'failed', 110, 120, {
          terminalReason: closing,
          failureCause: 'label-cortex failed: found no voxels matching id 1',
        }),
      ],
    )
    const [withoutCause] = projectSubjectRuntimeStatus(
      [source],
      [run('run-current', 100, [source.id])],
      [
        job('job-1', 'run-current', 'recon', source.id, 'failed', 110, 120, {
          terminalReason: closing,
        }),
      ],
    )

    expect(withCause?.cells[0]?.err).toBe(
      'label-cortex failed: found no voxels matching id 1',
    )
    expect(withoutCause?.cells[0]?.err).toBe(closing)
  })

  it('states a Reconstruction rerun on its cell, and only for that job', () => {
    // Without this, the rerun is visible only in the receipt JSON.
    const source = subject('sub-149')
    const fallback = {
      kind: 'freesurfer-no-fix-with-ga',
      addedArguments: ['-no-fix-with-ga'],
      reason:
        'mris_fix_topology crashed in the genetic surface topology fix (-ga).',
      firstAttemptExitCode: 134,
    }
    const [reran] = projectSubjectRuntimeStatus(
      [source],
      [run('run-current', 100, [source.id])],
      [
        job('job-1', 'run-current', 'recon', source.id, 'done', 110, 120, {
          executionFallback: fallback,
        }),
      ],
    )
    expect(reran?.cells[0]?.st).toBe('done')
    expect(reran?.cells[0]?.rerun).toEqual({
      fact: 'Reran with -no-fix-with-ga',
      detail:
        'mris_fix_topology crashed in the genetic surface topology fix (-ga). ' +
        'The first attempt exited with code 134.',
    })

    // A later job without a rerun does not inherit the earlier one's.
    const [later] = projectSubjectRuntimeStatus(
      [reran!],
      [run('run-later', 200, [source.id])],
      [job('job-2', 'run-later', 'recon', source.id, 'done', 210, 220)],
    )
    expect(later?.cells[0]).not.toHaveProperty('rerun')
  })

  it('lets the newest retry replace an earlier failed attempt', () => {
    const source = subject('sub-001')
    const result = projectSubjectRuntimeStatus(
      [source],
      [run('run-current', 100, [source.id])],
      [
        job('job-retry', 'run-current', 'recon', source.id, 'done', 130, 160, {
          attemptOrdinal: 2,
        }),
        job(
          'job-primary',
          'run-current',
          'recon',
          source.id,
          'failed',
          110,
          120,
          {
            attemptOrdinal: 1,
            terminalReason: 'primary failed',
          },
        ),
      ],
    )

    expect(result[0]?.cells[0]).toMatchObject({
      st: 'done',
      startedAt: 130,
      finishedAt: 160,
      rc: 0,
      err: null,
    })
  })

  it('keeps the outcome of an earlier run for subjects a newer run left alone', () => {
    // A failing-run sequence: six reconstructions fail; a canceled run
    // then finishes sub-101 and cancels sub-901; a run on sub-101 alone ends
    // blocked with only never-started cohort jobs. The matrix was discovered
    // before any of it, so every cell reads pending there.
    const ids = ['sub-101', 'sub-102', 'sub-901', 'sub-902', 'sub-903']
    const failedRun: RunSnapshot = {
      ...run('run-failed', 1_000, ids, false, ids),
      status: 'failed',
      endedAt: 2_000,
    }
    const canceledRun: RunSnapshot = {
      ...run('run-canceled', 3_000, ['sub-101', 'sub-901']),
      status: 'cancelled',
      endedAt: 4_000,
    }
    const blockedRun: RunSnapshot = {
      ...run('run-blocked', 5_000, ['sub-101'], false, ['sub-101']),
      status: 'blocked',
      endedAt: 5_500,
    }
    const jobs = [
      ...ids.map((id, index) =>
        job(
          `f-${id}`,
          'run-failed',
          'recon',
          id,
          'failed',
          1_100,
          1_200 + index,
          {
            terminalReason: 'Surface topology correction failed.',
          },
        ),
      ),
      job('c-101', 'run-canceled', 'recon', 'sub-101', 'done', 3_100, 3_500),
      job(
        'c-116',
        'run-canceled',
        'recon',
        'sub-901',
        'cancelled',
        3_100,
        3_600,
      ),
      job('b-enigma', 'run-blocked', 'enigma', null, 'blocked', null, 5_400),
    ]
    const discovered = ids.map((id) => subject(id, 'pending'))
    const recon = (rows: Subject[]): (string | undefined)[] =>
      rows.map((row) => row.cells[0]?.st)

    // After the canceled run: the four subjects it did not touch keep the
    // failure of the run before it.
    const afterCancel = projectSubjectRuntimeStatus(
      discovered,
      [failedRun, canceledRun],
      jobs.filter((item) => item.runId !== 'run-blocked'),
    )
    expect(recon(afterCancel)).toEqual([
      'done',
      'failed',
      'cancelled',
      'failed',
      'failed',
    ])
    expect(afterCancel[1]?.cells[0]?.err).toBe(
      'Surface topology correction failed.',
    )

    // After the blocked run on sub-101: sub-101 keeps the reconstruction its
    // plan reused, and the earlier failures stay.
    const afterBlocked = projectSubjectRuntimeStatus(
      discovered,
      [blockedRun, failedRun, canceledRun],
      jobs,
    )
    expect(recon(afterBlocked)).toEqual([
      'done',
      'failed',
      'cancelled',
      'failed',
      'failed',
    ])
    expect(afterBlocked.map((row) => row.stepStates?.recon)).toEqual([
      'done',
      'failed',
      'cancelled',
      'failed',
      'failed',
    ])
    expect(afterBlocked[0]?.stepStates?.enigma).toBeUndefined()
    expect(afterBlocked.map(subjectDisplayBucket)).toEqual([
      'partial',
      'failed',
      'cancelled',
      'failed',
      'failed',
    ])
  })

  it('decides a cohort stage by its newest job, on that run cohort only', () => {
    // An older ENIGMA QC run failed for three subjects; a newer one finished
    // for two. The cohort table now holds the newer run's two subjects, so
    // the older failure no longer describes anyone, and the subject outside
    // the newer cohort keeps what discovery read.
    const rows = ['sub-001', 'sub-002', 'sub-003'].map((id) => subject(id))
    const older: RunSnapshot = {
      ...run('run-older', 100, undefined, false, [
        'sub-001',
        'sub-002',
        'sub-003',
      ]),
      status: 'failed',
      endedAt: 200,
    }
    const newer: RunSnapshot = {
      ...run('run-newer', 300, undefined, false, ['sub-001', 'sub-002']),
      status: 'done',
      endedAt: 400,
    }
    const result = projectSubjectRuntimeStatus(
      rows,
      [newer, older],
      [
        job('old-enigma', older.runId, 'enigma', null, 'failed', 110, 150),
        job('new-enigma', newer.runId, 'enigma', null, 'done', 310, 350),
      ],
    )

    expect(result.map((row) => row.stepStates?.enigma)).toEqual([
      'done',
      'done',
      undefined,
    ])
    expect(result.map((row) => row.cells[1]?.st)).toEqual([
      'done',
      'done',
      'pending',
    ])
  })

  it('skips jobs still scheduled when their run ended', () => {
    const source = subject('sub-001')
    const earlier: RunSnapshot = {
      ...run('run-earlier', 100, [source.id]),
      status: 'done',
      endedAt: 200,
    }
    const stopped: RunSnapshot = {
      ...run('run-stopped', 300, [source.id]),
      status: 'blocked',
      endedAt: 400,
    }
    const result = projectSubjectRuntimeStatus(
      [source],
      [stopped, earlier],
      [
        job('done', earlier.runId, 'recon', source.id, 'done', 110, 150),
        job('queued', stopped.runId, 'recon', source.id, 'queued', null, null, {
          plannedAt: 310,
        }),
      ],
    )

    expect(result[0]?.cells[0]?.st).toBe('done')
  })

  it('lets the active run decide ahead of finished runs and ignores dry runs', () => {
    const source = subject('sub-001')
    // The finished run's job carries later times than the active run's
    // queued job, as when a clock or a restart reorders them.
    const finished: RunSnapshot = {
      ...run('run-old', 100, [source.id]),
      status: 'failed',
      endedAt: 500,
    }
    const result = projectSubjectRuntimeStatus(
      [source],
      [
        run('run-dry', 300, [source.id], true),
        run('run-current', 200, [source.id]),
        finished,
      ],
      [
        job('job-dry', 'run-dry', 'recon', source.id, 'failed', 310, 320),
        job('job-old', 'run-old', 'recon', source.id, 'failed', 400, 450),
        job(
          'job-current',
          'run-current',
          'recon',
          source.id,
          'queued',
          null,
          null,
          {
            plannedAt: 210,
          },
        ),
      ],
    )

    expect(result[0]?.cells[0]?.st).toBe('queued')
  })

  it('prefers the current durable active run over terminal history', () => {
    const source = subject('sub-001')
    const historical = {
      ...run('run-history', 300, [source.id]),
      status: 'done' as const,
      endedAt: 400,
    }
    const current = {
      ...run('run-current', null, [source.id]),
      status: 'queued' as const,
    }

    const result = projectSubjectRuntimeStatus(
      [source],
      [historical, current],
      [
        job('job-history', historical.runId, 'recon', source.id, 'done', 310),
        job(
          'job-current',
          current.runId,
          'brainfov',
          source.id,
          'running',
          410,
        ),
      ],
    )

    expect(result[0]?.stepStates?.brainfov).toBe('running')
    expect(subjectDisplayBucket(result[0]!)).toBe('running')
  })

  it('exposes auxiliary-stage jobs with exact scope and state', () => {
    const subjects = [
      subject('sub-queued'),
      subject('sub-running'),
      subject('sub-failed'),
      subject('sub-outside'),
    ]
    const current = run(
      'run-current',
      100,
      subjects.slice(0, 3).map((item) => item.id),
    )
    const result = projectSubjectRuntimeStatus(
      subjects,
      [current],
      [
        job(
          'job-queued',
          current.runId,
          'brainfov',
          subjects[0]!.id,
          'queued',
          null,
          null,
          { plannedAt: 110 },
        ),
        job(
          'job-running',
          current.runId,
          'brainfov',
          subjects[1]!.id,
          'running',
          120,
        ),
        job(
          'job-failed',
          current.runId,
          'brainfov',
          subjects[2]!.id,
          'failed',
          130,
          140,
          { terminalReason: 'fixture failure' },
        ),
      ],
    )

    expect(result.map((item) => item.stepStates?.brainfov)).toEqual([
      'queued',
      'running',
      'failed',
      undefined,
    ])
    expect(result.map(subjectDisplayBucket)).toEqual([
      'pending',
      'running',
      'failed',
      'pending',
    ])
    expect(result.map(subjectAuxiliaryDisplayStatus)).toEqual([
      { stepKey: 'brainfov', state: 'queued' },
      { stepKey: 'brainfov', state: 'running' },
      { stepKey: 'brainfov', state: 'failed' },
      null,
    ])
  })

  it('leaves detector state alone for jobs an ended run never started', () => {
    // A run whose two reconstructions failed blocks every cohort stage; once
    // it has ended those blocked nodes must not hide the finished ENIGMA and
    // outlier outputs of the other subjects, and a subject whose own jobs did
    // not fail must not read as failed.
    const finished = subject('sub-001', 'done')
    const ended: RunSnapshot = {
      ...run('run-1', 100, ['sub-001', 'sub-002'], false, [
        'sub-001',
        'sub-002',
      ]),
      status: 'failed',
      endedAt: 200,
    }
    const projected = projectSubjectRuntimeStatus(
      [finished, subject('sub-002', 'pending')],
      [ended],
      [
        job('j1', 'run-1', 'recon', 'sub-002', 'failed', 100, 150),
        job('j2', 'run-1', 'enigma', null, 'blocked', null, 150),
        job('j3', 'run-1', 'outliers', null, 'blocked', null, 150),
      ],
    )
    const enigmaIndex = MATRIX_STEPS.findIndex((step) => step.key === 'qcsub')
    expect(projected[0]?.cells[enigmaIndex]?.st).toBe('done')
    expect(projected[0]?.stepStates?.enigma).toBeUndefined()
    expect(projected[1]?.stepStates?.recon).toBe('failed')
    expect(subjectDisplayBucket(projected[0]!)).toBe('done')

    // While the same run is still active the blocked node is real news.
    const active = projectSubjectRuntimeStatus(
      [subject('sub-001', 'done')],
      [run('run-1', 100, ['sub-001'], false, ['sub-001'])],
      [job('j2', 'run-1', 'enigma', null, 'blocked', null, null)],
    )
    expect(active[0]?.stepStates?.enigma).toBe('blocked')
  })

  it('projects cohort jobs onto the full analysis cohort', () => {
    const first = subject('sub-001')
    const second = subject('sub-002')
    const result = projectSubjectRuntimeStatus(
      [first, second],
      [run('run-current', 100, [second.id], false, [first.id, second.id])],
      [job('job-enigma', 'run-current', 'enigma', null, 'running', 110)],
    )

    expect(result[0]?.cells.slice(1, 4).map((cell) => cell.st)).toEqual([
      'running',
      'running',
      'running',
    ])
    expect(result[1]?.cells.slice(1, 4).map((cell) => cell.st)).toEqual([
      'running',
      'running',
      'running',
    ])
    expect(result.map((item) => item.stepStates?.enigma)).toEqual([
      'running',
      'running',
    ])
  })

  it('fails closed when a cohort job lacks its analysis scope', () => {
    const source = subject('sub-001')
    const result = projectSubjectRuntimeStatus(
      [source],
      [run('run-current', 100)],
      [job('job-enigma', 'run-current', 'enigma', null, 'running', 110)],
    )

    expect(result[0]?.cells).toEqual(source.cells)
    expect(result[0]?.stepStates).toEqual(source.stepStates)
  })

  it('exposes runtime state for a stage without matrix columns', () => {
    const source = subject('sub-001')
    const result = projectSubjectRuntimeStatus(
      [source],
      [run('run-current', 100, [], false, [source.id])],
      [
        job(
          'job-outliers',
          'run-current',
          'outliers',
          null,
          'failed',
          110,
          120,
        ),
      ],
    )

    expect(result[0]?.cells).toEqual(source.cells)
    expect(result[0]?.stepStates?.outliers).toBe('failed')
  })

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['blocked', 'failed'],
    ['withheld', 'failed'],
    ['interrupted', 'interrupted'],
    ['stale', 'failed'],
    ['running', 'running'],
    ['cancelling', 'running'],
    ['queued', 'pending'],
    ['planned', 'pending'],
    ['waiting', 'pending'],
    ['pending', 'pending'],
    ['done', 'done'],
  ] as const)('classifies %s cells as %s', (state, expected) => {
    expect(subjectDisplayBucket(subject('sub-001', state))).toBe(expected)
  })

  it('counts a subject whose only unfinished cells are out of date as Out of date', () => {
    const mixed = subject('sub-001', 'done')
    mixed.cells[1] = { ...mixed.cells[1]!, st: 'outdated' }

    // Every output exists and only Run all's rerun is left: neither Done nor
    // Partly done, and never a failure or active work.
    expect(subjectDisplayBucket(mixed)).toBe('outdated')
    expect(subjectDisplayBucket(subject('sub-002', 'outdated'))).toBe(
      'outdated',
    )
  })

  it('keeps a subject with out-of-date cells Partly done while a step is still to run', () => {
    const outdatedAndPending = subject('sub-001', 'pending')
    outdatedAndPending.cells[1] = {
      ...outdatedAndPending.cells[1]!,
      st: 'outdated',
    }
    const outdatedAndQueued = subject('sub-002', 'done')
    outdatedAndQueued.cells[1] = {
      ...outdatedAndQueued.cells[1]!,
      st: 'outdated',
    }
    outdatedAndQueued.cells[2] = {
      ...outdatedAndQueued.cells[2]!,
      st: 'queued',
    }
    const outdatedAndFailed = subject('sub-003', 'outdated')
    outdatedAndFailed.cells[0] = {
      ...outdatedAndFailed.cells[0]!,
      st: 'failed',
    }
    const outdatedAndRunning = subject('sub-004', 'outdated')
    outdatedAndRunning.cells[0] = {
      ...outdatedAndRunning.cells[0]!,
      st: 'running',
    }

    expect(subjectDisplayBucket(outdatedAndPending)).toBe('partial')
    expect(subjectDisplayBucket(outdatedAndQueued)).toBe('partial')
    expect(subjectDisplayBucket(outdatedAndFailed)).toBe('failed')
    expect(subjectDisplayBucket(outdatedAndRunning)).toBe('running')
  })

  it('keeps terminal attention ahead of concurrent running work', () => {
    const source = subject('sub-001', 'pending')
    source.cells[0] = { ...source.cells[0]!, st: 'cancelled' }
    source.cells[1] = { ...source.cells[1]!, st: 'running' }

    expect(subjectDisplayBucket(source)).toBe('cancelled')
  })

  it('counts a QC Fail subject as Excluded even while it runs or failed', () => {
    const unfinished = subject('sub-001', 'pending')
    unfinished.qc = 'fail'
    unfinished.cells[0] = { ...unfinished.cells[0]!, st: 'done' }
    expect(subjectDisplayBucket(unfinished)).toBe('excluded')

    const allDone = subject('sub-002', 'done')
    allDone.qc = 'fail'
    expect(subjectDisplayBucket(allDone)).toBe('excluded')

    const running = subject('sub-003', 'pending')
    running.qc = 'fail'
    running.cells[1] = { ...running.cells[1]!, st: 'running' }
    expect(subjectDisplayBucket(running)).toBe('excluded')

    const failed = subject('sub-004', 'pending')
    failed.qc = 'fail'
    failed.cells[0] = { ...failed.cells[0]!, st: 'failed' }
    expect(subjectDisplayBucket(failed)).toBe('excluded')

    // A failed precise stage state does not outrank the exclusion either.
    const stageFailed = subject('sub-005', 'pending')
    stageFailed.qc = 'fail'
    stageFailed.stepStates = { brainfov: 'failed' }
    expect(subjectDisplayBucket(stageFailed)).toBe('excluded')

    // Needs attention and the failure counts read the same rule.
    expect(subjectAttention(failed)).toBeNull()
    expect(subjectAttention(stageFailed)).toBeNull()
  })

  it('counts interrupted and canceled steps apart from failures', () => {
    // An app crash interrupted reconstructions, and a Cancel all
    // canceled one; neither failed.
    const interrupted = subject('sub-101', 'pending')
    interrupted.cells[0] = { ...interrupted.cells[0]!, st: 'interrupted' }
    const canceled = subject('sub-901', 'pending')
    canceled.cells[0] = { ...canceled.cells[0]!, st: 'cancelled' }
    const both = subject('sub-902', 'pending')
    both.cells[0] = { ...both.cells[0]!, st: 'cancelled' }
    both.stepStates = { brainfov: 'interrupted' }
    const failedToo = subject('sub-903', 'pending')
    failedToo.cells[0] = { ...failedToo.cells[0]!, st: 'interrupted' }
    failedToo.stepStates = { deface: 'failed' }

    expect(
      [interrupted, canceled, both, failedToo].map(subjectDisplayBucket),
    ).toEqual(['interrupted', 'cancelled', 'interrupted', 'failed'])
    expect(subjectAttention(interrupted)).toMatchObject({
      bucket: 'interrupted',
      state: 'interrupted',
      column: 'recon',
      stepKey: null,
    })
    expect(subjectAttention(failedToo)).toMatchObject({
      bucket: 'failed',
      column: null,
      stepKey: 'deface',
    })
    expect(subjectAttention(subject('sub-904', 'done'))).toBeNull()
  })

  it('keeps a cohort stage that ended unfinished out of the subject attention buckets', () => {
    // A failed R analysis is not a failure of any subject's own work,
    // so each unfinished cohort state leaves the subject Partly done.
    const cohortEnded = (id: string, state: CellState): Subject => {
      const source = subject(id, 'done')
      source.cells[MATRIX_STEPS.length - 1] = {
        ...source.cells[MATRIX_STEPS.length - 1]!,
        st: state,
      }
      source.stepStates = { recon: 'done', final: state }
      return source
    }
    const rows = (
      [
        'failed',
        'blocked',
        'withheld',
        'stale',
        'interrupted',
        'cancelled',
      ] as const
    ).map((state, index) => cohortEnded(`sub-${index}`, state))
    // After the analysis cohort changed, the finished cohort cells read out
    // of date beside the failed Report cell.
    const outdated = cohortEnded('sub-outdated', 'failed')
    outdated.cells = outdated.cells.map((cell, index) =>
      index > 0 && cell.st === 'done' ? { ...cell, st: 'outdated' } : cell,
    )

    for (const row of [...rows, outdated]) {
      expect(subjectAttention(row)).toBeNull()
      expect(subjectDisplayBucket(row)).toBe('partial')
    }
    // A subject-scope step that ended unfinished still decides its bucket.
    const reconFailed = cohortEnded('sub-recon', 'failed')
    reconFailed.cells[0] = { ...reconFailed.cells[0]!, st: 'failed' }
    expect(subjectAttention(reconFailed)).toMatchObject({
      bucket: 'failed',
      column: 'recon',
    })
  })

  it('projects a failed cohort job onto its cells without failing each subject', () => {
    const first = subject('sub-001', 'done')
    const second = subject('sub-002', 'done')
    const ended = {
      ...run('run-ended', 100, [first.id, second.id]),
      status: 'failed' as const,
      endedAt: 900,
    }
    const jobs = [
      job('job-final', ended.runId, 'final', null, 'failed', 110, 800, {
        terminalReason: 'R analysis exited with code 1.',
      }),
    ]
    const result = projectSubjectRuntimeStatus([first, second], [ended], jobs)

    // The Report cell still shows the failure; the subjects read Partly done.
    expect(result.map((row) => row.cells.at(-1)?.st)).toEqual([
      'failed',
      'failed',
    ])
    expect(result.map((row) => row.stepStates?.final)).toEqual([
      'failed',
      'failed',
    ])
    expect(result.map(subjectDisplayBucket)).toEqual(['partial', 'partial'])
    // The cohort fact is stated once, by the notice of the stage they wait on.
    expect(cohortStageWait(result, [ended], jobs)).toEqual({
      subjectCount: 2,
      stepKey: 'final',
      state: 'failed',
      reason: 'R analysis exited with code 1.',
    })
  })

  it('names a stage without a matrix column that did not finish', () => {
    const source = subject('sub-001', 'done')
    source.stepStates = { recon: 'done', brainfov: 'interrupted' }

    expect(subjectDisplayBucket(source)).toBe('interrupted')
    expect(subjectAttention(source)).toEqual({
      bucket: 'interrupted',
      state: 'interrupted',
      column: null,
      cell: null,
      stepKey: 'brainfov',
    })
  })

  it.each([
    ['persistence-error', 'failed'],
    ['unknown', 'stale'],
  ] as const)('makes %s jobs visible as %s', (status, expected) => {
    const source = subject('sub-001')
    const result = projectSubjectRuntimeStatus(
      [source],
      [run('run-current', 100, [source.id])],
      [job('job-1', 'run-current', 'recon', source.id, status, 110)],
    )

    expect(result[0]?.cells[0]?.st).toBe(expected)
    expect(subjectDisplayBucket(result[0]!)).toBe('failed')
  })
})

/** Build a subject whose every matrix cell is done except the Report cell. */
function finishedExceptReport(id: string): Subject {
  const source = subject(id, 'done')
  source.cells[MATRIX_STEPS.length - 1] = { ...emptyCell(), st: 'pending' }
  return source
}

/** Build an ended run that blocked `blocked` nodes and names one reason. */
function endedRun(
  runId: string,
  startedAt: number,
  analysisSubjectIds: string[],
  blocked: number,
  message: string,
): RunSnapshot {
  return {
    ...run(runId, startedAt, analysisSubjectIds),
    status: blocked > 0 ? 'blocked' : 'done',
    endedAt: startedAt + 1000,
    summary: {
      planned: 0,
      started: 10,
      waiting: 0,
      blocked,
      skipped: 0,
      message,
    },
  }
}

/** Build a run manifest listing each stage's settled status. */
function manifest(
  runId: string,
  startedAt: number,
  steps: [StepKey, ManifestStepStatus][],
): RunManifest {
  return {
    runId,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(startedAt + 1000).toISOString(),
    user: 'operator',
    host: 'fixture-host',
    git: { repo: 'supraspina', sha: '', dirty: false },
    configSha256: '0'.repeat(64),
    steps: steps.map(([key, status], index) => ({
      id: index + 1,
      key,
      status,
      subjects: 2,
      failed: 0,
      durationSec: 1,
    })),
    tools: {},
  }
}

const METADATA_REASON =
  'Provide the metadata file /project/metadata/metadata.csv with a subject ID ' +
  'column (participant_id) and a Cohort column; Sex and Age are optional.'

describe('cohortStageWait', () => {
  it('names an R analysis stage blocked at planning with the reason its run recorded', () => {
    // A node blocked at planning never becomes a job; only the manifest and
    // the run summary record it.
    const ids = ['sub-001', 'sub-002']
    const runs = [
      endedRun(
        'run-final',
        100,
        ids,
        1,
        `This pass runs 10 nodes; 1 blocked node will not run. ${METADATA_REASON}`,
      ),
    ]
    const jobs = [
      job('job-agg', 'run-final', 'aggregate', null, 'done', 110, 120),
    ]
    const projected = projectSubjectRuntimeStatus(
      ids.map(finishedExceptReport),
      runs,
      jobs,
    )

    // The counting definition stays: Done still needs the Report cell.
    expect(projected.map(subjectDisplayBucket)).toEqual(['partial', 'partial'])
    expect(
      cohortStageWait(projected, runs, jobs, [
        manifest('run-final', 100, [
          ['aggregate', 'done'],
          ['final', 'blocked'],
        ]),
      ]),
    ).toEqual({
      subjectCount: 2,
      stepKey: 'final',
      state: 'blocked',
      reason: METADATA_REASON,
    })
  })

  it('prefers the terminal reason of a cohort job blocked while running', () => {
    const ids = ['sub-001', 'sub-002']
    const reason =
      'Rerun aggregate before final because no matching current provenance receipt exists.'
    const runs = [
      endedRun('run-final', 100, ids, 1, `Resolve 1 blocked node. ${reason}`),
    ]
    const jobs = [
      job('job-final', 'run-final', 'final', null, 'blocked', null, 120, {
        terminalReason: reason,
      }),
    ]
    // Once the run has ended, the blocked job no longer paints the subjects.
    const projected = projectSubjectRuntimeStatus(
      ids.map(finishedExceptReport),
      runs,
      jobs,
    )

    // The readiness order reads as its fact.
    expect(cohortStageWait(projected, runs, jobs)).toEqual({
      subjectCount: 2,
      stepKey: 'final',
      state: 'blocked',
      reason:
        'Structural data aggregation has no current receipt for R analysis.',
    })
  })

  it('withholds a reason the run cannot attribute to the stage', () => {
    const ids = ['sub-001']
    const subjects = ids.map(finishedExceptReport)
    // Two blocked nodes: the summary's first reason may belong to either.
    const ambiguous = [
      endedRun(
        'run-a',
        100,
        ids,
        2,
        `Resolve 2 blocked nodes. ${METADATA_REASON}`,
      ),
    ]
    expect(
      cohortStageWait(
        subjects,
        ambiguous,
        [],
        [manifest('run-a', 100, [['final', 'blocked']])],
      ),
    ).toMatchObject({ stepKey: 'final', state: 'blocked', reason: null })

    // A machine tag is not operator prose.
    const withheld = [endedRun('run-b', 100, ids, 1, 'fixture')]
    const jobs = [
      job('job-final', 'run-b', 'final', null, 'withheld', null, 120, {
        terminalReason: 'failure_policy_withheld',
      }),
    ]
    expect(cohortStageWait(subjects, withheld, jobs)).toMatchObject({
      stepKey: 'final',
      state: 'withheld',
      reason: null,
    })
  })

  it('states what R reported for a failed R analysis job, not a missing input', () => {
    // The R analysis adapter records the missing-input remedy for any file
    // R cannot open, here a read-only report template.
    const ids = ['sub-001', 'sub-002']
    const runs = [endedRun('run-final', 100, ids, 0, 'fixture')]
    const jobs = [
      job('job-final', 'run-final', 'final', null, 'failed', 110, 120, {
        terminalReason: 'Provide every structural CSV and metadata.csv input.',
      }),
    ]
    const projected = projectSubjectRuntimeStatus(
      ids.map(finishedExceptReport),
      runs,
      jobs,
    )
    expect(cohortStageWait(projected, runs, jobs)).toEqual({
      subjectCount: 2,
      stepKey: 'final',
      state: 'failed',
      reason:
        'R could not open a file it reads; the job log names the file and the cause.',
    })
  })

  it('keeps the fact a run states when its blocked node records no reason', () => {
    const ids = ['sub-001']
    // The sidecar states a missing reason after the resolve lead-in.
    const runs = [
      endedRun(
        'run-final',
        100,
        ids,
        1,
        'Resolve 1 blocked node. The blocked node records no reason.',
      ),
    ]
    expect(
      cohortStageWait(
        ids.map(finishedExceptReport),
        runs,
        [],
        [manifest('run-final', 100, [['final', 'blocked']])],
      ),
    ).toMatchObject({
      stepKey: 'final',
      state: 'blocked',
      reason: 'The blocked job records no reason.',
    })
  })

  it('reports a stage as not run when no newer run left it unfinished', () => {
    const subjects = [finishedExceptReport('sub-001')]
    expect(cohortStageWait(subjects, [], [])).toEqual({
      subjectCount: 1,
      stepKey: 'final',
      state: null,
      reason: null,
    })

    // A newer run finished R analysis for another cohort; the older block is no
    // longer the stage's outcome.
    const runs = [
      endedRun(
        'run-old',
        100,
        ['sub-001'],
        1,
        `Resolve 1 blocked node. ${METADATA_REASON}`,
      ),
      endedRun('run-new', 200, ['sub-009'], 0, 'fixture'),
    ]
    expect(
      cohortStageWait(
        subjects,
        runs,
        [],
        [
          manifest('run-old', 100, [['final', 'blocked']]),
          manifest('run-new', 200, [['final', 'done']]),
        ],
      ),
    ).toMatchObject({ stepKey: 'final', state: null, reason: null })
  })

  it('counts only Partly done subjects whose subject-scope stages are done', () => {
    const untouched = subject('sub-001', 'pending')
    const reconOnly = subject('sub-002', 'pending')
    reconOnly.cells[0] = { ...emptyCell(), st: 'done' }
    const failed = finishedExceptReport('sub-003')
    failed.cells[0] = { ...emptyCell(), st: 'failed' }
    const done = subject('sub-004', 'done')
    const brainFovQueued = finishedExceptReport('sub-005')
    brainFovQueued.stepStates = { brainfov: 'queued' }
    // A QC-failed subject is outside the analysis cohort that cohort stages
    // run on, so it waits on none of them.
    const qcExcluded = {
      ...finishedExceptReport('sub-007'),
      qc: 'fail' as const,
    }
    const waiting = finishedExceptReport('sub-006')

    expect(
      cohortStageWait([untouched, failed, done, qcExcluded], [], []),
    ).toBeNull()
    expect(
      cohortStageWait(
        [
          untouched,
          reconOnly,
          failed,
          done,
          brainFovQueued,
          qcExcluded,
          waiting,
        ],
        [],
        [],
      ),
    ).toEqual({
      subjectCount: 2,
      stepKey: 'enigma',
      state: null,
      reason: null,
    })
  })

  it.each([
    ['failed', 'failed'],
    ['interrupted', 'interrupted'],
    ['cancelled', 'cancelled'],
  ] as const)(
    'states a cohort stage that ended %s when no subject finished its own stages',
    (status, state) => {
      // With every subject's own work unfinished, an R analysis that ended badly
      // is still the cohort wait, not only a matrix cell and a Runs row.
      const source = finishedExceptReport('sub-001')
      source.cells[0] = { ...emptyCell(), st: 'pending' }
      const runs = [endedRun('run-final', 100, [source.id], 0, 'fixture')]
      const jobs = [
        job('job-final', 'run-final', 'final', null, status, 110, 120, {
          terminalReason: 'R analysis exited with status 1.',
        }),
      ]

      expect(cohortStageWait([source], runs, jobs)).toEqual({
        subjectCount: 0,
        stepKey: 'final',
        state,
        reason: 'R analysis exited with status 1.',
      })
    },
  )

  it('names no stage a run blocked when no subject finished its own stages', () => {
    // A blocked or withheld cohort stage follows an earlier failure that the
    // subject rows already state.
    const failed = finishedExceptReport('sub-001')
    failed.cells[0] = { ...emptyCell(), st: 'failed' }
    const runs = [endedRun('run-final', 100, [failed.id], 1, 'fixture')]
    const manifests = [manifest('run-final', 100, [['final', 'blocked']])]

    expect(cohortStageWait([failed], runs, [], manifests)).toBeNull()
    // A subject outside the analysis cohort does not wait on cohort stages.
    const excluded = { ...failed, qc: 'fail' as const }
    const jobs = [job('job-final', 'run-final', 'final', null, 'failed', 110)]
    expect(cohortStageWait([excluded], runs, jobs)).toBeNull()
  })

  it('names a stage that needs attention ahead of an earlier stage not yet run', () => {
    const source = subject('sub-001', 'done')
    for (const index of [4, 5, 6, 7, 8, 9]) {
      source.cells[index] = { ...emptyCell(), st: 'pending' }
    }
    const runs = [
      endedRun(
        'run-a',
        100,
        ['sub-001'],
        1,
        `Resolve 1 blocked node. ${METADATA_REASON}`,
      ),
    ]
    const manifests = [manifest('run-a', 100, [['final', 'blocked']])]

    expect(cohortStageWait([source], runs, [], manifests)).toMatchObject({
      stepKey: 'final',
      state: 'blocked',
    })
    expect(cohortStageWait([source], [], [])).toMatchObject({
      stepKey: 'features',
      state: null,
    })
  })
})

/** A project configuration with these stages turned off. */
function stagesOff(...keys: StepKey[]): ProjectConfig {
  const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
  for (const key of keys) {
    cfg.steps[key] = { ...cfg.steps[key], enabled: false }
  }
  return cfg
}

/**
 * Build a subject whose every column but PyBrainAge, Statistics, and Report
 * finished, as a project with those stages off leaves each subject once
 * Run all finished every enabled stage.
 */
function finishedWithoutAgeStages(id: string): Subject {
  const source = subject(id, 'done')
  for (const column of ['pba', 'stats', 'rep']) {
    const index = MATRIX_STEPS.findIndex((step) => step.key === column)
    source.cells[index] = { ...emptyCell(), st: 'pending' }
  }
  source.stepStates = {
    recon: 'done',
    enigma: 'done',
    outliers: 'done',
    features: 'done',
    age: 'done',
    pybrainage: 'pending',
    clinical: 'pending',
    brainpad: 'pending',
    aggregate: 'done',
    final: 'pending',
  }
  return source
}

describe('skipDisabledStages', () => {
  const AGE_STAGES_OFF = stagesOff(
    'pybrainage',
    'clinical',
    'brainpad',
    'final',
  )

  it('counts a subject Done once every enabled stage finished (PyBrainAge off)', () => {
    // With PyBrainAge, Clinical merge, Brain-PAD statistics, and R analysis
    // off, no subject waits on PyBrainAge prediction.
    const subjects = ['sub-101', 'sub-901', 'sub-902', 'sub-906'].map(
      finishedWithoutAgeStages,
    )
    expect(subjects.map(subjectDisplayBucket)).toEqual(Array(4).fill('partial'))
    expect(cohortStageWait(subjects, [], [])?.stepKey).toBe('pybrainage')

    const skipped = skipDisabledStages(subjects, AGE_STAGES_OFF)

    expect(skipped.map(subjectDisplayBucket)).toEqual(Array(4).fill('done'))
    expect(
      skipped[0]!.cells.map((cell, index) => [
        MATRIX_STEPS[index]!.key,
        cell.st,
      ]),
    ).toEqual([
      ['recon', 'done'],
      ['qcsub', 'done'],
      ['qcic', 'done'],
      ['qcec', 'done'],
      ['feat', 'done'],
      ['pba', 'skipped'],
      // BrainCharts is off, but this subject's finished output stays done.
      ['norm', 'done'],
      ['stats', 'skipped'],
      ['agg', 'done'],
      ['rep', 'skipped'],
    ])
    expect(skipped[0]!.stepStates).toMatchObject({
      pybrainage: 'skipped',
      clinical: 'skipped',
      brainpad: 'skipped',
      final: 'skipped',
      aggregate: 'done',
    })
    // No subject waits on a stage that never runs.
    expect(cohortStageWait(skipped, [], [], [], AGE_STAGES_OFF)).toBeNull()
    // The input stays as discovery read it.
    expect(subjects.map(subjectDisplayBucket)).toEqual(Array(4).fill('partial'))
  })

  it('still waits on an enabled cohort stage and never on one turned off', () => {
    const waiting = finishedWithoutAgeStages('sub-101')
    const agg = MATRIX_STEPS.findIndex((step) => step.key === 'agg')
    waiting.cells[agg] = { ...emptyCell(), st: 'pending' }
    waiting.stepStates = { ...waiting.stepStates, aggregate: 'pending' }

    const skipped = skipDisabledStages([waiting], AGE_STAGES_OFF)

    expect(subjectDisplayBucket(skipped[0]!)).toBe('partial')
    expect(cohortStageWait(skipped, [], [], [], AGE_STAGES_OFF)).toMatchObject({
      subjectCount: 1,
      stepKey: 'aggregate',
      state: null,
    })
  })

  it('keeps finished output and owned work, and drops old outcomes of a stage turned off', () => {
    const source = finishedWithoutAgeStages('sub-101')
    const pba = MATRIX_STEPS.findIndex((step) => step.key === 'pba')
    const stats = MATRIX_STEPS.findIndex((step) => step.key === 'stats')
    const rep = MATRIX_STEPS.findIndex((step) => step.key === 'rep')
    source.cells[pba] = { ...emptyCell(), st: 'done', rc: 0 }
    source.cells[stats] = { ...emptyCell(), st: 'running', progress: 40 }
    source.cells[rep] = {
      ...emptyCell(),
      st: 'failed',
      rc: 1,
      err: 'R analysis failed before it was turned off.',
    }
    source.stepStates = {
      ...source.stepStates,
      pybrainage: 'done',
      brainpad: 'running',
      final: 'failed',
    }

    const [skipped] = skipDisabledStages([source], AGE_STAGES_OFF)

    expect(skipped!.cells[pba]!.st).toBe('done')
    expect(skipped!.cells[stats]!).toMatchObject({
      st: 'running',
      progress: 40,
    })
    expect(skipped!.cells[rep]!).toMatchObject({
      st: 'skipped',
      rc: null,
      err: null,
    })
    expect(skipped!.stepStates).toMatchObject({
      pybrainage: 'done',
      brainpad: 'running',
      final: 'skipped',
    })
    expect(subjectDisplayBucket(skipped!)).toBe('running')
  })

  it('lets the later stage still on decide a column two stages advance', () => {
    // Discovery lets age metadata integration, the later of the two stages
    // that advance Feature extraction, decide the cell; with it off, the
    // cell read pending although feature extraction finished.
    const source = finishedWithoutAgeStages('sub-101')
    const feat = MATRIX_STEPS.findIndex((step) => step.key === 'feat')
    source.cells[feat] = { ...emptyCell(), st: 'pending' }
    source.stepStates = { ...source.stepStates, age: 'pending' }
    const cfg = stagesOff('age', 'pybrainage', 'clinical', 'brainpad', 'final')

    const [skipped] = skipDisabledStages([source], cfg)

    expect(skipped!.cells[feat]).toMatchObject({ st: 'done', rc: 0 })
    expect(skipped!.stepStates?.age).toBe('skipped')
    expect(subjectDisplayBucket(skipped!)).toBe('done')

    // A failed feature extraction still decides the column.
    source.stepStates = { ...source.stepStates, features: 'failed' }
    expect(skipDisabledStages([source], cfg)[0]!.cells[feat]!.st).toBe('failed')
  })

  it('returns every subject unchanged when every stage is on', () => {
    const allOn = structuredClone(DEFAULT_PROJECT_CONFIG)
    for (const key of Object.keys(allOn.steps) as StepKey[]) {
      allOn.steps[key] = { ...allOn.steps[key], enabled: true }
    }
    const subjects = [finishedWithoutAgeStages('sub-101')]
    subjects[0]!.stepStates = { ...subjects[0]!.stepStates, deface: 'pending' }
    const result = skipDisabledStages(subjects, allOn)
    expect(result).not.toBe(subjects)
    expect(result[0]).toBe(subjects[0])
    expect(stageEnabled(allOn, 'pybrainage')).toBe(true)
    expect(stageEnabled(AGE_STAGES_OFF, 'pybrainage')).toBe(false)
    // Defacing is off by default; its unrun state reads skipped, and the
    // matrix, which it does not advance, is unchanged.
    const [defaults] = skipDisabledStages(subjects, DEFAULT_PROJECT_CONFIG)
    expect(defaults!.stepStates?.deface).toBe('skipped')
    expect(defaults!.cells).toEqual(subjects[0]!.cells)
  })

  it('counts a subject with skipped and out-of-date cells as Out of date', () => {
    const [skipped] = skipDisabledStages(
      [finishedWithoutAgeStages('sub-101')],
      AGE_STAGES_OFF,
    )
    const agg = MATRIX_STEPS.findIndex((step) => step.key === 'agg')
    skipped!.cells[agg] = { ...skipped!.cells[agg]!, st: 'outdated' }
    expect(subjectDisplayBucket(skipped!)).toBe('outdated')
  })
})

describe('blockedRunSummaryReason', () => {
  it.each([
    [
      'Resolve 2 blocked nodes. Reconstruction was blocked, so this step did not run. 1 more reason applies.',
      'Reconstruction was blocked, so this step did not run. 1 more reason applies.',
    ],
    [
      'This pass runs 3 nodes (1 waiting on dependencies); 1 blocked node will not run. Add the clinical metadata file.',
      'Add the clinical metadata file.',
    ],
    [
      'Resolve 1 blocked node. Reconstruction was interrupted, so this step did not run.',
      'Reconstruction was interrupted, so this step did not run.',
    ],
    ['Resolve 1 blocked node. ', ''],
  ])('states the reason of %j', (message, reason) => {
    expect(blockedRunSummaryReason(message)).toBe(reason)
  })
})

describe('nameBlockedStage', () => {
  it('names the one blocked stage in place of "this step" and keeps the count', () => {
    expect(
      nameBlockedStage(
        'Reconstruction failed, so this step did not run. 2 more reasons apply.',
        ['ENIGMA QC'],
      ),
    ).toBe(
      'ENIGMA QC did not run because Reconstruction failed. 2 more reasons apply.',
    )
  })

  it.each([[['ENIGMA QC', 'R analysis']], [[]]])(
    'leaves a blocked-dependency reason to the caller for stages %j',
    (stages) => {
      expect(
        nameBlockedStage(
          'Reconstruction was blocked, so this step did not run.',
          stages,
        ),
      ).toBeNull()
    },
  )

  it('keeps any other reason whole', () => {
    expect(
      nameBlockedStage('Add the clinical metadata file.', ['R analysis']),
    ).toBe('Add the clinical metadata file.')
  })
})
