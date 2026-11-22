/** Projects durable runtime jobs onto discovered subjects for display only. */

import { isAnalysisEligible } from '../../shared/analysis-cohort'
import type { RunSnapshot } from '../../shared/contract'
import {
  executionFallbackDetail,
  executionFallbackFact,
} from '../../shared/execution-fallback'
import type { ProjectConfig } from '../../shared/project-schema'
import {
  advancedColumns,
  MATRIX_STEPS,
  STEP_KEYS,
  STEP_SCOPES,
  type MatrixStepKey,
  type StepKey,
} from '../../shared/steps'
import type {
  Cell,
  CellState,
  Job,
  JobStatus,
  RunManifest,
  Subject,
} from '../../shared/types'
import { restateRecordedReasons, terminalReasonText } from './terminal-reason'

/**
 * The mutually exclusive state buckets shown by the top bar, the Dashboard,
 * and Subjects.
 */
export type SubjectDisplayBucket =
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'running'
  | 'done'
  | 'outdated'
  | 'partial'
  | 'pending'
  | 'excluded'

/**
 * The buckets of subjects with a step that ended without finishing: Failed,
 * Interrupted, and Canceled, most severe first.
 */
export type SubjectAttentionBucket = Extract<
  SubjectDisplayBucket,
  'failed' | 'interrupted' | 'cancelled'
>

/**
 * The cell states that decide each attention bucket, most severe first. A
 * step blocked, withheld, or of unknown state still counts as failed; an
 * interrupted or canceled step did not fail, and Resume or Retry canceled
 * continues it.
 */
const ATTENTION_BUCKET_STATES: readonly (readonly [
  SubjectAttentionBucket,
  ReadonlySet<CellState>,
])[] = [
  ['failed', new Set<CellState>(['failed', 'blocked', 'withheld', 'stale'])],
  ['interrupted', new Set<CellState>(['interrupted'])],
  ['cancelled', new Set<CellState>(['cancelled'])],
]

/** The attention buckets, most severe first. */
export const ATTENTION_BUCKETS: readonly SubjectAttentionBucket[] =
  ATTENTION_BUCKET_STATES.map(([bucket]) => bucket)

/** Matrix columns that subject-scope stages advance, such as recon-all. */
const SUBJECT_SCOPE_COLUMNS: ReadonlySet<MatrixStepKey> = new Set(
  STEP_KEYS.filter((key) => STEP_SCOPES[key] === 'subject').flatMap((key) =>
    advancedColumns(key),
  ),
)

/** Why a subject is in an attention bucket. */
export interface SubjectAttention {
  bucket: SubjectAttentionBucket
  /** The cell or stage state that decided the bucket. */
  state: CellState
  /** The first matrix column in that state, or null when only a stage is. */
  column: MatrixStepKey | null
  /** The cell in that state, which carries its recorded reason. */
  cell: Cell | null
  /** The stage in that state when no matrix column is, such as Brain FOV. */
  stepKey: StepKey | null
}

/**
 * Name the most severe step of a subject that ended without finishing.
 *
 * Read the matrix cells first, in column order, then the precise per-stage
 * states, which also cover stages without a column, such as Brain FOV
 * preparation. A failed, blocked, withheld, or unknown step decides Failed
 * ahead of an interrupted one, and an interrupted step decides Interrupted
 * ahead of a canceled one.
 *
 * Read subject-scope stages only. A cohort-scope stage runs one job for the
 * whole analysis cohort, so its outcome is a fact about the cohort, not about
 * any subject's own work: one failed R analysis read as every subject
 * failed. Its cells still show that outcome and keep the subject out of Done,
 * and the cohort notices and Runs state it once.
 *
 * A QC Fail subject needs no attention: it is Excluded whatever its steps
 * show (see {@link subjectDisplayBucket}), so Needs attention and the
 * failure counts agree with the Failed tile.
 *
 * @returns The deciding bucket, state, and step, or null when the subject is
 *   QC Fail or every subject-scope step finished, runs, or waits to run.
 * @example
 * subjectAttention(subject)?.bucket // 'cancelled'
 */
export function subjectAttention(subject: Subject): SubjectAttention | null {
  if (subject.qc === 'fail') return null
  for (const [bucket, states] of ATTENTION_BUCKET_STATES) {
    const index = subject.cells.findIndex((cell, position) => {
      const column = MATRIX_STEPS[position]?.key
      return (
        column !== undefined &&
        SUBJECT_SCOPE_COLUMNS.has(column) &&
        states.has(cell.st)
      )
    })
    const cell = index >= 0 ? subject.cells[index] : undefined
    const column = index >= 0 ? MATRIX_STEPS[index]?.key : undefined
    if (cell && column) {
      return { bucket, state: cell.st, column, cell, stepKey: null }
    }
    for (const stepKey of STEP_KEYS) {
      if (STEP_SCOPES[stepKey] !== 'subject') continue
      const state = subject.stepStates?.[stepKey]
      if (state !== undefined && states.has(state)) {
        return { bucket, state, column: null, cell: null, stepKey }
      }
    }
  }
  return null
}

const TERMINAL_ATTENTION_STATES: ReadonlySet<CellState> = new Set([
  'failed',
  'cancelled',
  'blocked',
  'withheld',
  'interrupted',
  'stale',
])

const ACTIVE_DISPLAY_STATES: ReadonlySet<CellState> = new Set([
  'running',
  'cancelling',
])

const ACTIVE_RUN_STATES: ReadonlySet<RunSnapshot['status']> = new Set([
  'planned',
  'waiting',
  'queued',
  'running',
  'cancelling',
])

const AUXILIARY_DISPLAY_STATE_RANK: Readonly<
  Partial<Record<CellState, number>>
> = {
  failed: 0,
  cancelled: 0,
  blocked: 0,
  withheld: 0,
  interrupted: 0,
  stale: 0,
  running: 1,
  cancelling: 1,
  queued: 2,
  waiting: 3,
  planned: 3,
}

/** One noteworthy state for a stage without a Subjects matrix column. */
export interface SubjectAuxiliaryDisplayStatus {
  stepKey: StepKey
  state: CellState
}

interface JobProjection {
  job: Job
  index: number
}

/** A job that may decide a subject's stage, with the run it belongs to. */
interface JobCandidate extends JobProjection {
  run: RunSnapshot
  /** Whether the job's run still owns current work. */
  active: boolean
}

/**
 * Classify one subject into exactly one operator-facing display bucket.
 *
 * A QC Fail subject is Excluded whatever its steps show: it never joins the
 * analysis cohort, so neither its failures nor its active work are the
 * cohort's. Otherwise give a subject-scope step that ended without
 * finishing, in the matrix or the precise per-stage map, precedence over
 * active work: Failed for a failed, blocked, withheld, or unknown step, then
 * Interrupted, then Canceled (see {@link subjectAttention}). A cohort-scope stage that ended without
 * finishing leaves its cells unfinished, so the subject reads Partly done,
 * as for a cohort stage not yet run. Mark a subject Done only after every
 * matrix cell is done or skipped, and at least one is done: a skipped cell
 * belongs to a stage turned off in the project configuration (see
 * {@link skipDisabledStages}), which never runs. Keep auxiliary detector
 * states from redefining receipt-backed matrix completion. Mark a subject
 * whose every cell is done, out of date, or skipped Out of date
 * (`outdated`): its outputs all exist and only Run all's rerun is left. Mark
 * a subject with other done or out-of-date cells Partly done (`partial`),
 * and every other combination Pending.
 *
 * @returns The subject's mutually exclusive display bucket.
 */
export function subjectDisplayBucket(subject: Subject): SubjectDisplayBucket {
  if (subject.qc === 'fail') return 'excluded'
  const attention = subjectAttention(subject)
  if (attention) return attention.bucket
  const preciseStageStates = Object.values(subject.stepStates ?? {})
  if (
    subject.cells.some((cell) => ACTIVE_DISPLAY_STATES.has(cell.st)) ||
    preciseStageStates.some((state) => ACTIVE_DISPLAY_STATES.has(state))
  ) {
    return 'running'
  }
  if (
    subject.cells.some((cell) => cell.st === 'done') &&
    subject.cells.every((cell) => cell.st === 'done' || cell.st === 'skipped')
  ) {
    return 'done'
  }
  // Nothing failed, runs, or waits to run for this subject; only stages whose
  // output Run all would repeat keep it out of Done. Counting it Partly done
  // would read as work under way while nothing ran.
  if (
    subject.cells.some((cell) => cell.st === 'outdated') &&
    subject.cells.every(
      (cell) =>
        cell.st === 'done' || cell.st === 'outdated' || cell.st === 'skipped',
    )
  ) {
    return 'outdated'
  }
  // A subject with finished stages but an unfinished tail is in progress, not
  // untouched; after a long reconstruction pass "pending" would read as no
  // work done.
  // An out-of-date cell finished once and Run all repeats it, so it counts as
  // finished work here but keeps the subject out of Done.
  if (
    subject.cells.some((cell) => cell.st === 'done' || cell.st === 'outdated')
  ) {
    return 'partial'
  }
  return 'pending'
}

/**
 * Return the highest-priority noteworthy state that lacks a matrix column.
 *
 * Keep detector `pending`, `done`, and `skipped` values quiet. Show runtime planned,
 * queued, active, and terminal attention states for auxiliary stages such as Brain
 * FOV preparation, defacing, and outlier review. Break equal-priority ties with
 * stable pipeline order.
 *
 * @returns One auxiliary-stage row status, or null when none needs display.
 */
export function subjectAuxiliaryDisplayStatus(
  subject: Subject,
): SubjectAuxiliaryDisplayStatus | null {
  let selected: SubjectAuxiliaryDisplayStatus | null = null
  let selectedRank = Number.POSITIVE_INFINITY
  for (const stepKey of STEP_KEYS) {
    if (advancedColumns(stepKey).length > 0) continue
    const state = subject.stepStates?.[stepKey]
    if (state === undefined) continue
    const rank = AUXILIARY_DISPLAY_STATE_RANK[state]
    if (rank === undefined || rank >= selectedRank) continue
    selected = { stepKey, state }
    selectedRank = rank
  }
  return selected
}

/** Return a stable chronology value for a durable run snapshot. */
function runTime(run: RunSnapshot): number {
  return run.startedAt ?? run.endedAt ?? 0
}

/**
 * Job states of work that never ran: the run decided not to start it, or it
 * was still scheduled when the run ended. Once the run has ended such a job
 * says nothing about the subject's output.
 */
const NEVER_RAN_STATES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'blocked',
  'withheld',
  'planned',
  'waiting',
  'queued',
])

/** Track whether a run still owns current work or unresolved process state. */
function runIsActive(run: RunSnapshot): boolean {
  return (
    run.status === 'unknown' ||
    (run.endedAt === null && ACTIVE_RUN_STATES.has(run.status))
  )
}

/** Return the latest known transition time for retry precedence. */
function jobTime(job: Job): number {
  return Math.max(job.plannedAt ?? 0, job.startedAt ?? 0, job.endedAt ?? 0)
}

/** Track whether a candidate job is newer than the current projection for a cell. */
function isNewerJob(candidate: JobProjection, current: JobProjection): boolean {
  const timeDifference = jobTime(candidate.job) - jobTime(current.job)
  if (timeDifference !== 0) return timeDifference > 0
  const attemptDifference =
    (candidate.job.attemptOrdinal ?? 0) - (current.job.attemptOrdinal ?? 0)
  if (attemptDifference !== 0) return attemptDifference > 0
  return candidate.index > current.index
}

/** Map runtime-only statuses into the persisted cell-state grammar. */
function cellStateForJob(status: JobStatus): CellState {
  if (status === 'persistence-error') return 'failed'
  if (status === 'unknown') return 'stale'
  return status
}

/**
 * Project one durable job into a display-only matrix cell. A failed
 * Reconstruction's cause from its own output, when the sidecar read one, is
 * the cell's error instead of recon-all's closing line, and a Reconstruction
 * that reran after a known failure states the rerun whatever its outcome.
 */
function cellForJob(cell: Cell, job: Job): Cell {
  const state = cellStateForJob(job.status)
  const attention = TERMINAL_ATTENTION_STATES.has(state)
  const projected: Cell = {
    ...cell,
    st: state,
    startedAt: job.startedAt,
    finishedAt: job.endedAt,
    progress: null,
    rc: job.exitCode,
    err: attention ? (job.failureCause ?? job.terminalReason ?? null) : null,
  }
  // An earlier job's rerun does not describe this one.
  delete projected.rerun
  if (job.executionFallback) {
    projected.rerun = {
      fact: executionFallbackFact(job.executionFallback),
      detail: executionFallbackDetail(job.executionFallback),
    }
  }
  return projected
}

/**
 * Track whether a candidate job decides a stage ahead of the current one: a
 * job of a run that still owns current work comes first, even when its times
 * are absent or older than a finished run's, then the newer job.
 */
function decidesAhead(candidate: JobCandidate, current: JobCandidate): boolean {
  if (candidate.active !== current.active) return candidate.active
  return isNewerJob(candidate, current)
}

/** Resolve the exact subject targets for one job of its run. */
function jobSubjectIds(job: Job, run: RunSnapshot): readonly string[] {
  if (job.subjectId !== null) return [job.subjectId]
  return run.analysisSubjectIds ?? []
}

/**
 * Overlay each subject's newest job across the retained non-dry runs onto
 * cloned subjects.
 *
 * Discovery reads the matrix from disk when the project opens and when the
 * cohort is rediscovered, not when a run ends, so a stage keeps the state of
 * the newest job that decided it, whichever run that was: a subject that a
 * newer run left alone keeps the outcome of the run that last touched it.
 * Decide a subject-scope stage by the subject's newest job for it, and a
 * cohort-scope stage, whose output is one table for the whole cohort, by the
 * stage's newest job, projected onto that run's analysis cohort. Let a job of
 * a run that still owns current work decide ahead of finished runs. Once a
 * run has ended, skip its jobs that never ran (blocked, withheld, or still
 * scheduled): they say nothing about what is on disk.
 *
 * Change only cloned display cells and cloned per-step states. Leave every input
 * object untouched. Target subject jobs by their explicit subject ID. Fail cohort
 * jobs closed when the run snapshot lacks its immutable `analysisSubjectIds` scope,
 * and prevent full-cohort state from reaching the wrong subjects.
 *
 * @param runs - The durable runtime snapshots in any order.
 * @param jobs - The bounded durable job projections in any order.
 * @returns Cloned subjects with each stage's deciding job state overlaid.
 */
export function projectSubjectRuntimeStatus(
  subjects: readonly Subject[],
  runs: readonly RunSnapshot[],
  jobs: readonly Job[],
): Subject[] {
  const projected = subjects.map((subject) => ({
    ...subject,
    cells: subject.cells.map((cell) => ({ ...cell })),
    stepStates: { ...subject.stepStates },
  }))
  const liveRuns = new Map(
    runs.filter((run) => !run.dryRun).map((run) => [run.runId, run] as const),
  )
  if (liveRuns.size === 0) return projected

  const subjectById = new Map(
    projected.map((subject) => [subject.id, subject] as const),
  )
  // The job that decides each stage: per subject and stage for subject-scope
  // stages, per stage for cohort-scope stages.
  const deciding = new Map<string, JobCandidate>()
  jobs.forEach((job, index) => {
    if (job.dryRun || job.runId === undefined) return
    const run = liveRuns.get(job.runId)
    if (!run) return
    const active = runIsActive(run)
    // A job that never ran says nothing about what is on disk once its run
    // has ended: a cohort stage blocked behind two failed reconstructions
    // must not paint every subject's finished ENIGMA, outlier, or feature
    // output as blocked, nor hide the outcome of the run before it. While the
    // run is active the same states still describe work this run will not do.
    if (!active && NEVER_RAN_STATES.has(job.status)) return
    const key =
      job.subjectId !== null ? `${job.subjectId}\0${job.stepKey}` : job.stepKey
    const candidate = { job, index, run, active }
    const current = deciding.get(key)
    if (!current || decidesAhead(candidate, current)) {
      deciding.set(key, candidate)
    }
  })

  const newestByCell = new Map<string, JobCandidate>()
  const newestByStep = new Map<string, JobCandidate>()
  for (const candidate of deciding.values()) {
    const { job, run } = candidate
    const columns = advancedColumns(job.stepKey)
    for (const subjectId of jobSubjectIds(job, run)) {
      if (!subjectById.has(subjectId)) continue
      newestByStep.set(`${subjectId}\0${job.stepKey}`, candidate)
      // Two stages can advance one column, such as feature extraction and
      // age metadata integration; the newer job decides the cell.
      for (const column of columns) {
        const cellKey = `${subjectId}\0${column}`
        const current = newestByCell.get(cellKey)
        if (!current || decidesAhead(candidate, current)) {
          newestByCell.set(cellKey, candidate)
        }
      }
    }
  }

  for (const [key, projection] of newestByCell) {
    const [subjectId, column] = key.split('\0') as [string, MatrixStepKey]
    const subject = subjectById.get(subjectId)
    if (!subject) continue
    const columnIndex = matrixColumnIndex(column)
    const cell = subject.cells[columnIndex]
    if (!cell) continue
    subject.cells[columnIndex] = cellForJob(cell, projection.job)
  }
  for (const [key, projection] of newestByStep) {
    const [subjectId, stepKey] = key.split('\0') as [string, StepKey]
    const subject = subjectById.get(subjectId)
    if (!subject) continue
    subject.stepStates = {
      ...subject.stepStates,
      [stepKey]: cellStateForJob(projection.job.status),
    }
  }
  return projected
}

/** Resolve a matrix column's canonical cell-array index. */
function matrixColumnIndex(column: MatrixStepKey): number {
  return MATRIX_STEPS.findIndex((step) => step.key === column)
}

/**
 * Track whether a stage runs under a project configuration. Only an explicit
 * `enabled: false` turns a stage off, so a configuration that omits a stage
 * never hides its cells.
 *
 * @returns False only for a stage the configuration turns off.
 */
export function stageEnabled(
  cfg: Pick<ProjectConfig, 'steps'>,
  key: StepKey,
): boolean {
  return cfg.steps[key]?.enabled !== false
}

/** The stages that advance each matrix column, in pipeline order. */
const COLUMN_PRODUCERS: ReadonlyMap<MatrixStepKey, readonly StepKey[]> =
  new Map(
    MATRIX_STEPS.map((step) => [
      step.key,
      STEP_KEYS.filter((key) => advancedColumns(key).includes(step.key)),
    ]),
  )

/** States of work a run still owns; a stage turned off since keeps them. */
const OWNED_STATES: ReadonlySet<CellState> = new Set([
  'planned',
  'waiting',
  'queued',
  'running',
  'cancelling',
])

/** Track whether a state of a stage turned off still says something. */
function keptWhenOff(state: CellState): boolean {
  return state === 'done' || state === 'outdated' || OWNED_STATES.has(state)
}

/**
 * Mark the matrix cells and stage states of stages turned off in the project
 * configuration as skipped, so a subject whose enabled stages all finished
 * counts as Done and no subject waits on a stage that never runs.
 *
 * A column that only stages turned off advance reads skipped, unless it holds
 * finished output, which stays done, or work a run still owns. Its outcome
 * from before the stage was turned off, such as a failure, no longer counts:
 * no run repeats it while the stage is off. Discovery lets the later of two
 * stages that advance one column decide the cell, so when only one of them
 * is off, the cell takes the state of the later stage still on, such as
 * Feature extraction for the Feature extraction column with age metadata
 * integration off. The state of a stage turned off reads skipped on the same
 * terms. Subjects without such a stage come back unchanged.
 *
 * @returns A new array in which each changed subject is a copy; the input is
 *   never changed.
 */
export function skipDisabledStages(
  subjects: readonly Subject[],
  cfg: Pick<ProjectConfig, 'steps'>,
): Subject[] {
  const off = new Set(STEP_KEYS.filter((key) => !stageEnabled(cfg, key)))
  if (off.size === 0) return [...subjects]
  return subjects.map((subject) => {
    let changed = false
    const stepStates = { ...subject.stepStates }
    for (const key of off) {
      const state = stepStates[key]
      if (state === undefined || state === 'skipped' || keptWhenOff(state)) {
        continue
      }
      stepStates[key] = 'skipped'
      changed = true
    }
    const cells = subject.cells.map((cell, index) => {
      const column = MATRIX_STEPS[index]?.key
      const producers = column ? (COLUMN_PRODUCERS.get(column) ?? []) : []
      if (!producers.some((key) => off.has(key))) return cell
      if (OWNED_STATES.has(cell.st)) return cell
      const on = producers.filter((key) => !off.has(key))
      if (on.length === 0) {
        if (cell.st === 'skipped' || keptWhenOff(cell.st)) return cell
        changed = true
        return {
          ...cell,
          st: 'skipped' as const,
          progress: null,
          rc: null,
          err: null,
        }
      }
      // The later stage still on decides, as discovery lets the later stage
      // decide when every stage is on.
      const state = [...on]
        .reverse()
        .map((key) => subject.stepStates?.[key])
        .find((value) => value !== undefined)
      if (state === undefined || state === cell.st) return cell
      changed = true
      return {
        ...cell,
        st: state,
        progress: null,
        rc: state === 'done' ? 0 : null,
        err: null,
      }
    })
    return changed ? { ...subject, cells, stepStates } : subject
  })
}

/**
 * The cohort stage that subjects with finished subject-scope work still wait
 * on, with that stage's outcome in the newest run that recorded it.
 */
export interface CohortStageWait {
  /**
   * Count analysis-eligible Partly done subjects whose subject-scope stages
   * are all done. Zero when none is, yet the stage failed, was interrupted,
   * or was canceled in its newest run.
   */
  subjectCount: number
  stepKey: StepKey
  /**
   * Give the stage's unfinished outcome in the newest run that recorded it.
   * Use null when no run recorded one for these subjects: the stage never
   * ran, or it finished for another cohort.
   */
  state: CellState | null
  /** Give the recorded reason for `state`, or null when none is attributable. */
  reason: string | null
}

/** Outcomes of a cohort stage that ran and did not finish. */
const COHORT_ENDED_BADLY: ReadonlySet<CellState> = new Set([
  'failed',
  'interrupted',
  'cancelled',
])

const SCHEDULED_STATES: ReadonlySet<CellState> = new Set([
  'planned',
  'waiting',
  'queued',
])

/**
 * The plan-time lead-in of a run summary; the blocked reason follows it.
 * See `_state_summary` in the sidecar workflow manager.
 */
export const SUMMARY_LEAD_IN =
  /^(?:This pass runs [^.]*\.|Resolve \d+ blocked (?:nodes?|jobs?)\.)\s*/

/**
 * The blocked-dependency reason a dependent node records: it names the stage
 * it depends on and that stage's outcome, and calls the node itself "this
 * step" (see `blocked_dependency_reason` in
 * `sidecar/supraspina_sidecar/workflow.py`). The second group keeps the count of further reasons a run summary appends, such
 * as " 1 more reason applies.".
 */
const DEPENDENCY_REASON = /^(.+?), so this step did not run\.(.*)$/s

/**
 * State the blocked reason a run summary gives once the run has ended: drop
 * its lead-in, whether it counts the work that runs or the blocked nodes to
 * resolve, and restate a recorded order as its fact.
 *
 * @returns The reason and any count of further reasons, or an empty string
 *   when the summary states no reason after its lead-in.
 * @example
 * blockedRunSummaryReason(
 *   'Resolve 1 blocked node. Reconstruction was blocked, so this step did not run.',
 * ) // "Reconstruction was blocked, so this step did not run."
 */
export function blockedRunSummaryReason(message: string): string {
  return restateRecordedReasons(message).replace(SUMMARY_LEAD_IN, '').trim()
}

/**
 * Name the stage that did not run in a blocked run's reason, for a line that
 * names the run rather than a stage: a blocked-dependency reason calls that
 * stage "this step", which has no referent there. A run summary quotes only
 * its first reason, which may belong to any stage the run blocked, so the
 * stage is named only when the run blocked exactly one.
 *
 * @param reason - A blocked run's reason, as {@link blockedRunSummaryReason}
 *   states it; any count of further reasons that follows it is kept.
 * @param blockedStages - The names of the stages the run blocked.
 * @returns The reason with the stage named; any other reason unchanged; or
 *   null for a blocked-dependency reason of a run that blocked several stages
 *   or none, which the caller names by its stages instead.
 * @example
 * nameBlockedStage('Reconstruction failed, so this step did not run.', [
 *   'ENIGMA QC',
 * ]) // "ENIGMA QC did not run because Reconstruction failed."
 */
export function nameBlockedStage(
  reason: string,
  blockedStages: readonly string[],
): string | null {
  const dependency = reason.match(DEPENDENCY_REASON)
  if (!dependency) return reason
  const [, cause, more] = dependency
  return blockedStages.length === 1
    ? `${blockedStages[0]} did not run because ${cause}.${more}`
    : null
}

interface RunRecord {
  runId: string
  at: number
  snapshot?: RunSnapshot
  manifest?: RunManifest
}

interface StageOutcome {
  state: CellState | null
  reason: string | null
}

/** Track whether a subject is Partly done only because of cohort stages. */
function finishedOwnStages(subject: Subject): boolean {
  // Cohort stages run on the analysis cohort alone; an excluded subject does
  // not wait on them.
  if (!isAnalysisEligible(subject)) return false
  if (subjectDisplayBucket(subject) !== 'partial') return false
  const ownColumnsDone = MATRIX_STEPS.every(
    (step, index) =>
      !SUBJECT_SCOPE_COLUMNS.has(step.key) ||
      subject.cells[index]?.st === 'done' ||
      subject.cells[index]?.st === 'skipped',
  )
  const ownStagesSettled = STEP_KEYS.every((key) => {
    const state = subject.stepStates?.[key]
    return (
      STEP_SCOPES[key] !== 'subject' ||
      state === undefined ||
      !SCHEDULED_STATES.has(state)
    )
  })
  return ownColumnsDone && ownStagesSettled
}

/** Order live runs newest first, joining snapshots to their manifests. */
function liveRunHistory(
  runs: readonly RunSnapshot[],
  manifests: readonly RunManifest[],
): RunRecord[] {
  const dryRunIds = new Set(
    runs.filter((run) => run.dryRun).map((run) => run.runId),
  )
  const byId = new Map<string, RunRecord>()
  for (const run of runs) {
    if (run.dryRun) continue
    byId.set(run.runId, { runId: run.runId, at: runTime(run), snapshot: run })
  }
  for (const manifest of manifests) {
    if (manifest.dryRun === true || dryRunIds.has(manifest.runId)) continue
    const known = byId.get(manifest.runId)
    if (known) {
      known.manifest = manifest
      continue
    }
    const startedAt = Date.parse(manifest.startedAt)
    byId.set(manifest.runId, {
      runId: manifest.runId,
      at: Number.isFinite(startedAt) ? startedAt : 0,
      manifest,
    })
  }
  // Array sort is stable, so equal times keep snapshot order.
  return [...byId.values()].sort((a, b) => b.at - a.at)
}

/** Drop machine tags such as `failure_policy_withheld`; keep operator prose. */
function operatorReason(reason: string | null | undefined): string | null {
  const text = reason?.trim()
  if (!text || /^[a-z0-9_]+$/.test(text)) return null
  // Read recorded prose the way Logs does, so a readiness order names the
  // stage instead of its key.
  return terminalReasonText(text)
}

/**
 * Attribute a run summary's blocked reason to a stage only when the run
 * blocked exactly one node: the summary names its first reason alone.
 */
function soleBlockedReason(snapshot: RunSnapshot | undefined): string | null {
  if (!snapshot || snapshot.summary.blocked !== 1) return null
  return operatorReason(snapshot.summary.message.replace(SUMMARY_LEAD_IN, ''))
}

/**
 * Read one cohort stage's outcome from the newest live run that recorded it.
 *
 * Prefer the stage's newest job, which carries its terminal reason. Fall back
 * to the run manifest: a node blocked at planning never becomes a job.
 */
function cohortStageOutcome(
  stepKey: StepKey,
  history: readonly RunRecord[],
  jobs: readonly Job[],
): StageOutcome {
  for (const record of history) {
    let newest: JobProjection | null = null
    for (const [index, job] of jobs.entries()) {
      if (job.dryRun || job.runId !== record.runId) continue
      if (job.stepKey !== stepKey) continue
      const candidate = { job, index }
      if (!newest || isNewerJob(candidate, newest)) newest = candidate
    }
    if (newest) {
      const { job } = newest
      const state = cellStateForJob(job.status)
      return state === 'done'
        ? { state: null, reason: null }
        : { state, reason: operatorReason(job.terminalReason) }
    }
    const step = record.manifest?.steps.find((item) => item.key === stepKey)
    if (!step) continue
    if (step.status === 'done' || step.status === 'skipped') {
      return { state: null, reason: null }
    }
    const state = cellStateForJob(step.status)
    return {
      state,
      reason: state === 'blocked' ? soleBlockedReason(record.snapshot) : null,
    }
  }
  return { state: null, reason: null }
}

/**
 * Name the cohort stage that Partly done subjects wait on after their own work.
 *
 * Keep the Done bucket unchanged: it still requires every matrix cell done or
 * skipped. Count analysis-eligible Partly done subjects whose subject-scope
 * stages are all done, and consider each cohort stage that advances one of
 * their unfinished columns and that the project configuration leaves on: a
 * stage turned off never runs, so no subject waits on it. Choose the first
 * such stage, in pipeline order, whose newest outcome needs attention
 * (blocked, withheld, failed, and similar), then the first with any recorded
 * outcome, then the first overall. When no subject qualifies, consider the
 * unfinished columns of every analysis-eligible subject and name only a stage
 * that failed, was interrupted, or was canceled, with a subject count of zero.
 *
 * @param subjects - The runtime-projected subjects, with the cells of stages
 *   turned off marked by {@link skipDisabledStages}.
 * @param runs - The durable runtime snapshots in any order.
 * @param jobs - The bounded durable job projections in any order.
 * @param manifests - The run manifests; they record plan-time blocks.
 * @param cfg - The stage switches of this configuration; omit it to treat every
 *   stage as on.
 * @returns The waiting cohort stage, or null when no subject waits on one and
 *   no cohort stage ended badly.
 */
export function cohortStageWait(
  subjects: readonly Subject[],
  runs: readonly RunSnapshot[],
  jobs: readonly Job[],
  manifests: readonly RunManifest[] = [],
  cfg: Pick<ProjectConfig, 'steps'> | null = null,
): CohortStageWait | null {
  const waiting = subjects.filter(finishedOwnStages)
  // With no subject counted, still state a cohort stage that itself ended
  // badly for the analysis cohort: an out-of-date subject cell otherwise
  // leaves the failure stated only in matrix cells and Runs. A blocked or
  // withheld stage follows an earlier failure that the subject rows state.
  const considered =
    waiting.length > 0 ? waiting : subjects.filter(isAnalysisEligible)
  const unfinished = new Set<MatrixStepKey>()
  for (const subject of considered) {
    MATRIX_STEPS.forEach((step, index) => {
      const state = subject.cells[index]?.st
      if (state !== 'done' && state !== 'skipped') unfinished.add(step.key)
    })
  }
  const history = liveRunHistory(runs, manifests)
  const outcomes = STEP_KEYS.filter(
    (key) =>
      STEP_SCOPES[key] === 'cohort' &&
      (cfg === null || stageEnabled(cfg, key)) &&
      advancedColumns(key).some((column) => unfinished.has(column)),
  ).map((stepKey) => ({
    stepKey,
    ...cohortStageOutcome(stepKey, history, jobs),
  }))
  const attention = outcomes.find(
    (outcome) =>
      outcome.state !== null && TERMINAL_ATTENTION_STATES.has(outcome.state),
  )
  if (waiting.length === 0) {
    const ended = outcomes.find(
      (outcome) =>
        outcome.state !== null && COHORT_ENDED_BADLY.has(outcome.state),
    )
    return ended ? { subjectCount: 0, ...ended } : null
  }
  const chosen =
    attention ??
    outcomes.find((outcome) => outcome.state !== null) ??
    outcomes[0]
  if (!chosen) return null
  return { subjectCount: waiting.length, ...chosen }
}
