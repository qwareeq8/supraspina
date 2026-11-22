import type { RunSnapshot } from '../../shared/contract'
import type { Job } from '../../shared/types'

/** Run statuses that Resume and Clean up and retry can recover. */
const RECOVERABLE_STATUSES: ReadonlySet<RunSnapshot['status']> = new Set([
  'failed',
  'interrupted',
  'persistence-error',
])

const SHORT_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}

/** The run that recovery acts on, or why no run qualifies. */
export type RecoveryTarget =
  | { run: RunSnapshot; reason: null }
  | { run: null; reason: string }

/**
 * Return the run that started last, or null when there is none.
 *
 * @param runs - The retained runtime runs in any order.
 * @returns The newest run by start time.
 */
export function newestRun(runs: readonly RunSnapshot[]): RunSnapshot | null {
  return runs.reduce<RunSnapshot | null>(
    (best, run) =>
      best === null || (run.startedAt ?? 0) > (best.startedAt ?? 0)
        ? run
        : best,
    null,
  )
}

function shortTime(value: number | null): string {
  if (value === null) return 'an unrecorded time'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'an unrecorded time'
  return new Intl.DateTimeFormat(undefined, SHORT_TIME_FORMAT).format(date)
}

function recoverableRunPhrase(run: RunSnapshot): string {
  const started = shortTime(run.startedAt)
  return run.status === 'persistence-error'
    ? `the run of ${started} that hit a persistence error`
    : `the ${run.status} run of ${started}`
}

function laterRunVerb(run: RunSnapshot): string {
  if (run.endedAt === null) return 'started'
  return run.status === 'done' ? 'finished' : 'ended'
}

/**
 * Job states whose node the run summary counts as started. The sidecar's
 * summary counts running, done, failed, canceled, and unknown nodes; a job
 * that is canceling still belongs to a running node.
 */
const STARTED_NODE_JOB_STATUSES: ReadonlySet<Job['status']> = new Set([
  'running',
  'cancelling',
  'done',
  'failed',
  'cancelled',
  'unknown',
])

/** Identify the stage and subject a job did its work for. */
function jobIdentity(job: Job): string {
  return `${job.stepKey}\0${job.subjectId ?? ''}`
}

/**
 * Count the started nodes of a run that no retained job accounts for.
 *
 * Canceling a run cancels its planned and waiting nodes without creating a
 * job for them, and the run summary counts those nodes as started. The
 * runtime names neither their stage nor their subject.
 */
function joblessStartedNodes(run: RunSnapshot, own: readonly Job[]): number {
  const started = run.summary?.started
  if (typeof started !== 'number' || !Number.isFinite(started)) return 0
  const withJob = new Set(
    own
      .filter((job) => STARTED_NODE_JOB_STATUSES.has(job.status))
      .map(jobIdentity),
  )
  return Math.max(0, started - withJob.size)
}

/** Tell whether a job did work for the run's subjects or for the cohort. */
function inRunCohort(run: RunSnapshot, job: Job): boolean {
  if (job.subjectId === null) return true
  const subjects = [
    ...(run.selectedSubjectIds ?? []),
    ...(run.analysisSubjectIds ?? []),
  ]
  return subjects.length === 0 || subjects.includes(job.subjectId)
}

/**
 * Tell whether later runs finished the work a run left unfinished.
 *
 * A later run is a live run that started after this one; a later dry run did
 * no work. Every retained job of the run that did not finish must have a job
 * for the same stage and subject that finished in a later run. A node that
 * the run canceled before it had a job ({@link joblessStartedNodes}) has no
 * stage or subject to match, so later runs must also have finished at least
 * as many jobs, for the run's subjects or for the cohort, that the run has no
 * job for. The runtime keeps a bounded job history, so a run with no retained
 * job left to account for counts as recovered once a later run has finished.
 *
 * @param run - The failed, interrupted, or canceled run.
 * @param runs - The retained runtime runs in any order.
 * @param jobs - The retained runtime jobs of every run.
 * @returns True when no work the run left is still undone.
 */
export function recoveredByLaterRun(
  run: RunSnapshot,
  runs: readonly RunSnapshot[],
  jobs: readonly Job[],
): boolean {
  const startedAt = run.startedAt ?? 0
  const later = runs.filter(
    (candidate) =>
      candidate.runId !== run.runId &&
      !candidate.dryRun &&
      (candidate.startedAt ?? 0) > startedAt,
  )
  if (later.length === 0) return false
  const own = jobs.filter((job) => job.runId === run.runId)
  const unfinished = own.filter((job) => job.status !== 'done')
  // A run whose jobs all left the bounded history names no work at all.
  const jobless = own.length === 0 ? 0 : joblessStartedNodes(run, own)
  if (unfinished.length === 0 && jobless === 0) {
    return later.some((candidate) => candidate.status === 'done')
  }
  const laterIds = new Set(later.map((candidate) => candidate.runId))
  const finishedLater = jobs.filter(
    (job) =>
      job.runId !== undefined &&
      laterIds.has(job.runId) &&
      !job.dryRun &&
      job.status === 'done',
  )
  const finishedIdentities = new Set(finishedLater.map(jobIdentity))
  if (!unfinished.every((job) => finishedIdentities.has(jobIdentity(job)))) {
    return false
  }
  if (jobless === 0) return true
  const ownIdentities = new Set(own.map(jobIdentity))
  const redone = new Set(
    finishedLater
      .filter((job) => !ownIdentities.has(jobIdentity(job)))
      .filter((job) => inRunCohort(run, job))
      .map(jobIdentity),
  )
  return redone.size >= jobless
}

/**
 * Pick the run that Resume and Clean up and retry recover.
 *
 * Recovery acts only on the newest run by start time, and only while that run
 * is failed, interrupted, or in a persistence error; the run dock's Resume
 * failed applies the same rule. An older failure that a later run superseded
 * is not recovered, and the reason names the later run, unless later runs
 * already finished the work it left ({@link recoveredByLaterRun}); such a
 * failure is not cited.
 *
 * @param runs - The retained runtime runs in any order.
 * @param jobs - The retained runtime jobs of every run.
 * @returns The target run, or a reason clause when none qualifies.
 */
export function recoveryTarget(
  runs: readonly RunSnapshot[],
  jobs: readonly Job[],
): RecoveryTarget {
  const newest = newestRun(runs)
  if (newest && RECOVERABLE_STATUSES.has(newest.status)) {
    return { run: newest, reason: null }
  }
  const superseded = newestRun(
    runs.filter(
      (run) =>
        RECOVERABLE_STATUSES.has(run.status) &&
        !recoveredByLaterRun(run, runs, jobs),
    ),
  )
  if (newest && superseded) {
    return {
      run: null,
      reason: `${newest.runId} ${laterRunVerb(newest)} after ${recoverableRunPhrase(superseded)}.`,
    }
  }
  return {
    run: null,
    reason: 'no failed or interrupted run is waiting for recovery.',
  }
}

/**
 * Pick the canceled run that Retry canceled retries.
 *
 * The target is the newest canceled run whose unfinished work no later run
 * finished ({@link recoveredByLaterRun}), so a run already retried to
 * completion, or redone by a later run, is not offered again. A later run
 * that redid only the canceled jobs leaves the stages the run canceled before
 * they had a job, so the run is still offered.
 *
 * @param runs - The retained runtime runs in any order.
 * @param jobs - The retained runtime jobs of every run.
 * @returns The canceled run, or a reason clause when none qualifies.
 */
export function cancelledRetryTarget(
  runs: readonly RunSnapshot[],
  jobs: readonly Job[],
): RecoveryTarget {
  const run = newestRun(
    runs.filter(
      (candidate) =>
        candidate.status === 'cancelled' &&
        !recoveredByLaterRun(candidate, runs, jobs),
    ),
  )
  return run
    ? { run, reason: null }
    : { run: null, reason: 'no canceled run is waiting for a retry.' }
}
