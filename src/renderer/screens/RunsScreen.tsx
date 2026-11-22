/**
 * Launches and monitors stage-level pipeline execution for the whole cohort or
 * the current selection. Exposes cohort actions, all 12 stage cards, and a live
 * job list driven by `pipeline.onJobUpdate`.
 *
 * Missing configuration and cohort data are bootstrapped through
 * {@link getApi}. Shell-owned shared state is preferred when supplied.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Page,
  Card,
  Bar,
  Btn,
  Code,
  ConfirmDialog,
  Toggle,
  Collapsible,
  Divider,
  EmptyState,
  LoadingState,
  ErrorState,
  ExecutionOutcomeNotice,
  NORMALIZE_RECONSTRUCTION_COHORT_LABEL,
  Hint,
  Ico,
  ICONS,
  ICON_SIZE,
  RefreshButton,
  ScopeChip,
  FONTS,
  statusColor,
  formatRunTime,
  FreshnessStamp,
  failureReasonText,
  errorMessageText,
  recentSubjectStepLabel,
  cellStateLabel,
  STATUS_LABEL,
  StateLine,
  type Theme,
  NoticeGlyph,
} from '../ui'
import { JobStatusChip } from '../ui/JobStatusChip'
import { useApp, type LaunchOrigin } from '../state/context'
import { useReducedMotion } from '../state/reduced-motion'
import { useRuntime } from '../state/runtime-state'
import {
  RETRY_CANCELED_NODES_LABEL,
  SAFE_EXECUTION_OFF_CLEANUP,
  useExecutionService,
} from '../state/execution-service'
import {
  CANCELLATION_REQUESTED_NOTICE,
  QC_SCOPE_ACKNOWLEDGEMENT_LABEL,
  REVIEW_PLAN_LABEL,
  canNormalizeReconstructionCohort,
  canceledRunNotice,
  executionFailure,
  memoryAcknowledgementHint,
  memoryAcknowledgementLabel,
  planOutcomeText,
  qcAcknowledgementGatesStage,
  ACKNOWLEDGEMENT_NEEDED_TITLE,
  qcScopeAcknowledgementHint,
  qcScopeRows,
  reviewNextSentence,
  runExecutionAction,
  safeExecutionNoticeState,
  stagePlanLine,
  stageScopeSentence,
  statesCanceledRun,
  canceledRunId,
  withoutPlanOutcome,
  workflowScopeSentence,
  type ExecutionFailure,
  type SafeExecutionNoticeState,
} from '../state/execution-feedback'
import { getApi } from '../state/api'
import {
  cropInventory,
  cropsAwaitingApproval,
  useCropInventoryGeneration,
} from '../state/crop-inventory'
import {
  cancelledRetryTarget,
  newestRun,
  recoveredByLaterRun,
  recoveryTarget,
} from '../state/recovery-target'
import {
  analysisCohortCause,
  useProjectStageCurrency,
} from '../state/stage-currency'
import { missingAssetCheckIds } from '../state/stage-blockers'
import { STAGE_OFF_SKIP_REASON } from '../state/plan-node-facts'
import { snapshotRunLabel } from '../state/run-label'
import {
  nameBlockedSubjects,
  type NotRunRecord,
  terminalReasonText,
} from '../state/terminal-reason'
import {
  COHORT_LOADING_TITLE,
  knownCohortSize,
  targetRunButtonLabel,
  targetScopePillLabel,
} from '../run-scope'
import {
  computeDependencyBlockers,
  mergeBlockedByStep,
} from '../state/dependency-blockers'
import {
  blockedRunSummaryReason,
  nameBlockedStage,
  projectSubjectRuntimeStatus,
} from '../state/subject-runtime-status'
import {
  EnvInstallView,
  GateNotice,
  installGate,
  offlineAssetRebuild,
  useEnvInstall,
} from './env'
import {
  MATRIX_STEPS,
  PIPELINE_STEPS,
  PIPELINE_STEPS_IN_DISPLAY_ORDER,
} from '../../shared/steps'
import type {
  StepKey,
  MatrixStepKey,
  ArtifactRef,
  StepScope,
} from '../../shared/steps'
import { STEP_HELP, STEP_NAME_SPELLED_OUT } from '../../shared/help'
import type { ProjectConfig } from '../../shared/project-schema'
import type { InputFovItem } from '../../shared/scientific-contracts'
import type {
  EnvReport,
  Subject,
  Job,
  CellState,
  ChipStatus,
  ManifestStep,
  ProjectRef,
  StageBlocker,
} from '../../shared/types'
import type {
  ResultAnalysisCohortChange,
  ResultStageCurrency,
  RunSnapshot,
  WorkflowNode,
  WorkflowResult,
  WorkflowSummary,
} from '../../shared/contract'
import { unitReuseFact, type UnitReuseSummary } from '../../shared/unit-reuse'
import {
  analysisEligibleSubjects,
  emptyAnalysisCohortReason,
} from '../../shared/analysis-cohort'

interface LiveJob {
  id: string
  runId: string
  subjectId: string | null
  stepKey: StepKey
  status: Job['status']
  startedAt: number | null
}

/** Keep a job announcement in the accessibility tree without showing it. */
const OFFSCREEN_ANNOUNCEMENT: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

/** The most job changes announced individually before a count replaces them. */
const MAX_ANNOUNCED_JOB_CHANGES = 3

/** Name one live job the way the in-flight row shows it. */
function describeJob(job: LiveJob): string {
  return `${stageName(job.stepKey)} for ${job.subjectId ?? 'the cohort'}`
}

/**
 * State a live job's status in the word its In flight chip shows, for the
 * sentence that announces a change. The chip marks an unknown state with a
 * warning, which the sentence states as a fact instead.
 */
function liveJobStateText(status: LiveJob['status']): string {
  if (status === 'unknown') return 'in an unknown state'
  return STATUS_LABEL[chipStatusOf(status)].toLowerCase()
}

/**
 * State why In flight lists no job: no run is active, or the active runs'
 * jobs have not reached the renderer yet.
 */
function inFlightEmptyText(activeRuns: number): string {
  if (activeRuns === 0) return 'No job is in flight.'
  return activeRuns === 1
    ? 'A run is active; its jobs have not appeared yet.'
    : `${activeRuns} runs are active; their jobs have not appeared yet.`
}

/** The run states in which a run still holds or waits for work. */
const ACTIVE_RUN_STATUSES: ReadonlySet<RunSnapshot['status']> = new Set([
  'planned',
  'waiting',
  'queued',
  'running',
  'cancelling',
  'unknown',
])

/**
 * The run states in which a run still schedules the nodes of its plan; a run
 * being canceled cancels the nodes that have no job yet.
 */
const SCHEDULING_RUN_STATUSES: ReadonlySet<RunSnapshot['status']> = new Set([
  'planned',
  'waiting',
  'queued',
  'running',
])

/** The plan node states that a run turns into jobs. */
const RUNNABLE_NODE_STATUSES: ReadonlySet<WorkflowNode['status']> = new Set([
  'planned',
  'waiting',
  'queued',
])

/**
 * Return the newest run with a job of the stage, which the stage card's View
 * log opens in Logs, or null when no job of the stage is restored.
 */
function newestStageRunId(
  runs: readonly RunSnapshot[],
  jobs: readonly Job[],
  stepKey: StepKey,
): string | null {
  const stageRunIds = new Set(
    jobs.filter((job) => job.stepKey === stepKey).map((job) => job.runId),
  )
  let newest: RunSnapshot | null = null
  for (const run of runs) {
    if (!stageRunIds.has(run.runId)) continue
    if (newest === null || (run.startedAt ?? 0) > (newest.startedAt ?? 0)) {
      newest = run
    }
  }
  return newest?.runId ?? null
}

/**
 * State how a run that cancellation was requested for ended: canceled with
 * its job counts, or, when it settled before the request reached it, as it
 * ended.
 */
function settledRunSentence(run: RunSnapshot, jobs: readonly Job[]): string {
  switch (run.status) {
    case 'cancelled':
      return canceledRunNotice(run.runId, jobs)
    case 'done':
      return `Run ${run.runId} finished.`
    case 'failed':
    case 'interrupted':
    case 'persistence-error':
      return runEndedSentence(run.runId, run.status)
    case 'blocked':
      return `Run ${run.runId} ended with jobs that did not run.`
    default:
      return `Run ${run.runId} ended.`
  }
}

/** State how a run that did not finish ended, as its Runs notice opens. */
function runEndedSentence(
  runId: string,
  status: 'failed' | 'interrupted' | 'persistence-error',
): string {
  switch (status) {
    case 'failed':
      return `Run ${runId} failed.`
    case 'interrupted':
      return `Run ${runId} was interrupted.`
    case 'persistence-error':
      return `Run ${runId} stopped because Supraspina could not persist its state.`
  }
}

/**
 * State that later runs finished the work a failed, interrupted, or
 * persistence-error run left, in place of its alert: the run's end, then the
 * later run that did the work, or "later runs" when more than one finished
 * jobs after it.
 *
 * @param run - The run that did not finish, which later runs recovered.
 * @param ended - How the run ended, as its alert opened.
 * @param runs - The retained runtime runs.
 * @param jobs - The retained runtime jobs of every run.
 * @example
 * recoveredRunNotice(failed, 'Run run-1 failed.', runs, jobs)
 * // "Run run-1 failed; run-2 finished the work it left."
 */
function recoveredRunNotice(
  run: RunSnapshot,
  ended: string,
  runs: readonly RunSnapshot[],
  jobs: readonly Job[],
): string {
  const startedAt = run.startedAt ?? 0
  const later = new Set(
    runs
      .filter(
        (candidate) =>
          candidate.runId !== run.runId &&
          !candidate.dryRun &&
          (candidate.startedAt ?? 0) > startedAt,
      )
      .map((candidate) => candidate.runId),
  )
  const finishing = new Set(
    jobs
      .filter(
        (job) =>
          job.runId !== undefined &&
          later.has(job.runId) &&
          !job.dryRun &&
          job.status === 'done',
      )
      .map((job) => job.runId),
  )
  const [only] = finishing
  const by = finishing.size === 1 && only ? only : 'later runs'
  return `${ended.replace(/\.$/, '')}; ${by} finished the work it left.`
}

/**
 * The node and job states a run summary counts as blocked: the work did not
 * run. See `_state_summary` in the sidecar workflow manager.
 */
const NOT_RUN_STATUSES: ReadonlySet<string> = new Set([
  'blocked',
  'withheld',
  'stale',
])

/**
 * Name the stages a blocked run did not run, in pipeline order: the nodes its
 * plan blocked, which never become jobs; the jobs the scheduler blocked while
 * the run went on; and the stages its manifest records as not run. Only the
 * manifest holds nodes the run blocked or withheld without a job, such as the
 * Reconstruction nodes a FastSurfer fallback blocks on an output conflict and
 * the waiting nodes withheld after it.
 *
 * @param runId - The run the notice follows.
 * @param planNodes - The nodes of the plan that started the run.
 * @param jobs - The runtime jobs of every run.
 * @param manifestSteps - The stages of the run's manifest, or none when it
 *   could not be read.
 * @returns The stage names, each once.
 */
function blockedRunStageNames(
  runId: string,
  planNodes: readonly WorkflowNode[],
  jobs: readonly Job[],
  manifestSteps: readonly ManifestStep[] = [],
): string[] {
  const keys = new Set<StepKey>()
  for (const node of planNodes) {
    if (NOT_RUN_STATUSES.has(node.status)) keys.add(node.stepKey)
  }
  for (const job of jobs) {
    if (job.runId === runId && NOT_RUN_STATUSES.has(job.status)) {
      keys.add(job.stepKey)
    }
  }
  for (const step of manifestSteps) {
    if (NOT_RUN_STATUSES.has(step.status)) keys.add(step.key)
  }
  return PIPELINE_STEPS_IN_DISPLAY_ORDER.filter((step) =>
    keys.has(step.key),
  ).map((step) => step.name)
}

/**
 * Read the stages of a run's manifest, which the sidecar rewrites with every
 * state change it commits before announcing the run.
 *
 * @returns The manifest's stages, or none when there is no project or the
 *   manifest cannot be read; the notice then names the stages the plan and
 *   the jobs show.
 */
async function readManifestSteps(
  project: ProjectRef | null,
  runId: string,
): Promise<readonly ManifestStep[]> {
  if (!project) return []
  try {
    const manifest = await getApi().manifest.forRun({ project, runId })
    return Array.isArray(manifest.steps) ? manifest.steps : []
  } catch {
    return []
  }
}

/**
 * State the blocked-run notice: how many jobs finished and how many nodes did
 * not run, then why. The notice names a run, not a stage, so the summary's
 * lead-in is dropped and a blocked-dependency reason names the stage that did
 * not run in place of "this step"; when the reason belongs to one of several
 * blocked stages, or the summary gives none, the notice lists the stages.
 * Any other reason, such as the Reconstruction output conflict, reads as
 * recorded after the stage and subjects whose nodes or jobs record it.
 *
 * @param runId - The run that ended blocked.
 * @param finished - The number of the run's jobs that finished.
 * @param stages - The names of the stages the run blocked.
 * @param records - The nodes of the plan that started the run and the run's
 *   jobs, to name the subjects of the reason.
 * @example
 * blockedRunNotice('run-1', 0, { ...summary, blocked: 1, message:
 *   'Resolve 1 blocked node. Reconstruction was blocked, so this step did not run.',
 * }, ['ENIGMA QC'], [])
 * // "Run run-1 ended with no job finished and 1 job that did not run.
 * //  ENIGMA QC did not run because Reconstruction was blocked."
 */
function blockedRunNotice(
  runId: string,
  finished: number,
  summary: WorkflowSummary,
  stages: readonly string[],
  records: readonly NotRunRecord[],
): string {
  const jobs =
    finished === 0 ? 'no job' : `${finished} job${finished === 1 ? '' : 's'}`
  const notRun = `${summary.blocked} job${summary.blocked === 1 ? '' : 's'}`
  const ended = `Run ${runId} ended with ${jobs} finished and ${notRun} that did not run.`
  const reason = blockedRunSummaryReason(summary.message)
  const named = reason === '' ? null : nameBlockedStage(reason, stages)
  const stated =
    (named === reason ? nameBlockedSubjects(reason, records) : named) ??
    blockedStagesSentence(stages)
  return stated === '' ? ended : `${ended} ${stated}`
}

/**
 * The plan nodes and run jobs whose reasons the blocked-run notice reads: the
 * plan's blocked nodes never become jobs, and a job the scheduler blocked
 * records its reason as its terminal reason.
 */
function blockedRunRecords(
  runId: string,
  planNodes: readonly WorkflowNode[],
  jobs: readonly Job[],
): NotRunRecord[] {
  return [
    ...planNodes,
    ...jobs
      .filter((job) => job.runId === runId)
      .map((job) => ({
        stepKey: job.stepKey,
        subjectId: job.subjectId,
        status: job.status,
        reason: job.terminalReason,
      })),
  ]
}

/**
 * State which stages a blocked run did not run, when its reason cannot be
 * attributed to one of them. A list follows a colon because stage names such
 * as "Histogram and outlier review" contain "and".
 */
function blockedStagesSentence(stages: readonly string[]): string {
  if (stages.length === 0) return ''
  if (stages.length === 1) return `${stages[0]} did not run.`
  return `These stages did not run: ${stages.join(', ')}.`
}

/**
 * State one failed job for the failed-run notice: its exit and, when one was
 * recorded, its reason, with a known reason code read as a fact. A
 * Reconstruction's cause from its own output stands in for recon-all's
 * closing line.
 */
function failedJobLine(job: Job): string {
  const exit =
    job.exitCode === null
      ? 'failed with no recorded exit code'
      : `exited with code ${job.exitCode}`
  const reason = terminalReasonText(job.failureCause ?? job.terminalReason)
  const stated = reason && !/[.!?]$/.test(reason) ? `${reason}.` : reason
  return `${stageName(job.stepKey)} for ${job.subjectId ?? 'the cohort'} ${exit}${
    stated ? `: ${stated}` : '.'
  }`
}

/**
 * State the nodes a run that did not finish left without an outcome, from
 * its summary and the node count of the plan it ran (the run copies the
 * plan's nodes). The summary counts every blocked, withheld, or stale node,
 * which did not run, including nodes the failure policy withheld before
 * they had a job: the run's jobs miss those, and its manifest states one
 * status per stage, so a stage that also failed hides them. The summary
 * counts every other node status except interrupted, so the plan's nodes
 * it does not count are the interrupted ones. An interruption marks
 * running and never-started nodes alike, and neither the summary nor the
 * bounded job list proves which one started, so interrupted nodes are
 * counted apart from those that did not run.
 *
 * @param planNodes - The number of nodes in the plan the run ran.
 * @returns The sentence, or an empty string when no node was left without
 *   an outcome or the plan does not account for the summary's counts.
 * @example
 * unfinishedNodesSentence(
 *   { planned: 0, started: 1, waiting: 0, blocked: 1, skipped: 0, message: '' },
 *   5,
 * ) // "3 nodes were interrupted and 1 node did not run."
 */
function unfinishedNodesSentence(
  summary: WorkflowSummary,
  planNodes: number,
): string {
  const counted =
    summary.planned + summary.started + summary.blocked + summary.skipped
  // A plan with fewer nodes than the summary counts does not describe this
  // run; a count of the nodes that did not run could then leave some out.
  if (planNodes < counted) return ''
  const interrupted = planNodes - counted
  const parts: string[] = []
  if (interrupted > 0) {
    parts.push(
      interrupted === 1
        ? '1 job was interrupted'
        : `${interrupted} jobs were interrupted`,
    )
  }
  if (summary.blocked > 0) {
    parts.push(
      `${summary.blocked} job${summary.blocked === 1 ? '' : 's'} did not run`,
    )
  }
  return parts.length === 0 ? '' : `${parts.join(' and ')}.`
}

/** The most failed jobs the failed-run notice names; it counts the rest. */
const FAILED_RUN_NOTICE_JOB_LIMIT = 3

/**
 * State the failed jobs of a failed-run notice: the first few, then how many
 * more failed, as a sentence in the form a run summary uses for its further
 * reasons ("1 more reason applies."). Logs lists every failed job.
 *
 * @param failed - The run's failed jobs, newest first.
 * @returns The sentences, or an empty string when no job failed.
 * @example
 * failedJobsDetail(fourFailedJobs)
 * // "Reconstruction for sub-004 exited with code 1. ... 1 more job failed."
 */
function failedJobsDetail(failed: readonly Job[]): string {
  const shown = failed.slice(0, FAILED_RUN_NOTICE_JOB_LIMIT).map(failedJobLine)
  const more = failed.length - shown.length
  if (more === 1) shown.push('1 more job failed.')
  else if (more > 1) shown.push(`${more} more jobs failed.`)
  return shown.join(' ')
}

/**
 * Describe what changed between two in-flight job projections.
 *
 * Report job entry, removal, and status changes only, so assistive technology
 * hears the difference instead of the whole list. A cohort-wide launch enters
 * many jobs at once, so more than {@link MAX_ANNOUNCED_JOB_CHANGES} changes
 * collapse into a count.
 *
 * @returns The announcement, or an empty string when nothing changed.
 */
function describeJobChanges(
  previous: ReadonlyMap<string, LiveJob>,
  current: ReadonlyMap<string, LiveJob>,
): string {
  const changes: string[] = []
  for (const [id, job] of current) {
    const before = previous.get(id)
    if (before === undefined) {
      changes.push(`Added ${describeJob(job)}.`)
    } else if (before.status !== job.status) {
      changes.push(
        `${describeJob(job)} is now ${liveJobStateText(job.status)}.`,
      )
    }
  }
  for (const [id, job] of previous) {
    if (!current.has(id)) changes.push(`Removed ${describeJob(job)}.`)
  }
  if (changes.length === 0) return ''
  if (changes.length > MAX_ANNOUNCED_JOB_CHANGES) {
    return `Updated ${changes.length} in-flight jobs.`
  }
  return changes.join(' ')
}

/** Execution, cohort, and runtime state for Runs. */
export interface RunsScreenProps {
  cfg?: ProjectConfig
  subjects?: Subject[]
  selection?: string[]
  onSelectionChange?: (ids: string[]) => void
  dirty?: boolean
  refresh?: () => void
  blockers?: readonly StageBlocker[]
  envReport?: EnvReport | null
  /** Replace the shell's report when an asset rebuild here re-checks it. */
  onEnvReport?: (report: EnvReport) => void
}

const MATRIX_INDEX: Record<string, number> = (() => {
  const out: Record<string, number> = {}
  MATRIX_STEPS.forEach((m, i) => {
    out[m.key] = i
  })
  return out
})()

/** Format an elapsed millisecond span as mm:ss. */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** Subject counts one stage card shows. */
interface StageAggregate {
  done: number
  /** Subjects whose output exists but whose receipt the planner would not reuse. */
  outdated: number
  running: number
  /** Subjects whose job is planned, waiting, or queued in a live run. */
  queued: number
  /**
   * Subjects whose node the active run planned but has no job for yet, such
   * as a cohort stage that waits for an earlier stage of the same run.
   */
  planned: number
  failed: number
  blocked: number
  /** Subjects whose job the operator canceled; they did not fail. */
  cancelled: number
  /** Subjects whose job an app or host stop interrupted. */
  interrupted: number
  /** Subjects whose job's process state Supraspina could not confirm. */
  stale: number
  total: number
}

/**
 * The states of a job that neither finished nor failed, which a stage card
 * counts apart, each only when a subject is in it. None of them is a failure,
 * so the card gives them no failure line.
 */
const UNFINISHED_STATES = ['cancelled', 'interrupted', 'stale'] as const

/**
 * Key a stage's job for one subject, or for the cohort when `subjectId` is
 * null, as {@link liveFinishedStages} and {@link aggregate} match them.
 */
function stageJobKey(stepKey: StepKey, subjectId: string | null): string {
  return `${stepKey}\0${subjectId ?? ''}`
}

/**
 * Collect the stages that jobs of the given runs finished, per subject or
 * for the cohort.
 *
 * @param jobs - The runtime jobs of every run.
 * @param runIds - The runs whose finished jobs count.
 * @returns The {@link stageJobKey} of each finished job.
 */
function liveFinishedStages(
  jobs: readonly Job[],
  runIds: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    jobs
      .filter(
        (job) =>
          job.status === 'done' &&
          !job.dryRun &&
          job.runId !== undefined &&
          runIds.has(job.runId),
      )
      .map((job) => stageJobKey(job.stepKey, job.subjectId)),
  )
}

/** The job states of work a live run holds and has not finished. */
const LIVE_JOB_STATES: ReadonlySet<string> = new Set([
  'running',
  'cancelling',
  'planned',
  'waiting',
  'queued',
])

/**
 * Count subjects in each stage state. Prefer precise per-stage state because a
 * later producer can overwrite a shared matrix column. Treat a missing precise
 * state as pending. Count a finished subject as out of date, not done, when
 * the planner would run the stage again for it: the detector sees outputs on
 * disk, but a stale receipt means Run all would not reuse them. A job the
 * live run finished wrote a current receipt after the currency was read, so
 * its subject counts done. A node the active run planned has no job, and so
 * no state, until the stages it depends on finish; its subject counts as
 * planned rather than by the state an earlier run left.
 */
function aggregate(
  subjects: Subject[],
  stepKey: StepKey,
  scope: StepScope,
  currency?: ResultStageCurrency,
  liveFinished: ReadonlySet<string> = new Set(),
  scheduled: ReadonlySet<string> = new Set(),
): StageAggregate {
  const outdatedIds =
    currency?.state === 'outdated' && scope === 'subject'
      ? new Set(currency.outdatedSubjectIds)
      : null
  const cohortOutdated = currency?.state === 'outdated' && scope === 'cohort'
  let done = 0
  let outdated = 0
  let running = 0
  let queued = 0
  let planned = 0
  let failed = 0
  let blocked = 0
  let cancelled = 0
  let interrupted = 0
  let stale = 0
  for (const s of subjects) {
    const best = s.stepStates?.[stepKey] ?? null
    if (
      (best === null || !LIVE_JOB_STATES.has(best)) &&
      scheduled.has(stageJobKey(stepKey, scope === 'cohort' ? null : s.id))
    ) {
      planned += 1
      continue
    }
    if (best === 'done') {
      const finishedLive = liveFinished.has(
        stageJobKey(stepKey, scope === 'cohort' ? null : s.id),
      )
      if (!finishedLive && (cohortOutdated || outdatedIds?.has(s.id))) {
        outdated += 1
      } else done += 1
    } else if (best === 'running' || best === 'cancelling') running += 1
    // A job that has not started yet is queued work, not a stage that never
    // ran: counting it as not run read "Not run yet" for a stage whose
    // output exists and waits to be redone.
    else if (best === 'planned' || best === 'waiting' || best === 'queued')
      queued += 1
    // A stage that never ran because an earlier stage failed is blocked, not
    // failed; counting it as failed made one reconstruction failure read as
    // sixty-one ENIGMA QC failures.
    else if (best === 'blocked' || best === 'withheld') blocked += 1
    // A canceled or interrupted stage did not fail: counting it as failed
    // read one Cancel all as a failed subject beside no failure reason.
    else if (best === 'failed') failed += 1
    else if (best === 'cancelled') cancelled += 1
    else if (best === 'interrupted') interrupted += 1
    else if (best === 'stale') stale += 1
  }
  return {
    done,
    outdated,
    running,
    queued,
    planned,
    failed,
    blocked,
    cancelled,
    interrupted,
    stale,
    total: subjects.length,
  }
}

/**
 * The subjects a stage card counts: the whole analysis cohort, the Runs
 * target's selection, or, while a run holds jobs of the stage, that run's
 * subjects for it.
 */
type CountScope = 'cohort' | 'selected' | 'run'

/**
 * Name the subjects a stage card counts, so cards with different scopes
 * never read "0 running of 7" beside "0 running of 100".
 *
 * @returns The phrase that follows "of".
 * @example
 * countScopePhrase(7, 'selected') // 'the 7 selected'
 */
function countScopePhrase(total: number, scope: CountScope): string {
  if (scope === 'selected') return `the ${total} selected`
  if (scope === 'run') return `the ${total} in the active run`
  return `${total} ${total === 1 ? 'subject' : 'subjects'}`
}

/**
 * Collect the distinct failure reasons across the columns advanced by one
 * stage, each stated as Logs states it and as a sentence. Deduplicate on the
 * displayed text, so two codes that read alike show once, and leave out a
 * reason with no letter or digit.
 */
function failureTags(
  subjects: Subject[],
  columns: readonly string[],
): string[] {
  const seen = new Set<string>()
  for (const s of subjects) {
    for (const col of columns) {
      const idx = MATRIX_INDEX[col]
      if (idx === undefined) continue
      const cell = s.cells[idx]
      if (cell?.st !== 'failed') continue
      const reason = failureReasonText(cell.err)
      if (reason) seen.add(/[.!?]$/.test(reason) ? reason : `${reason}.`)
    }
  }
  return [...seen]
}

/** The subjects a stage card's rerun line names before it counts the rest. */
const STAGE_RERUN_SUBJECT_LIMIT = 6

/**
 * State the reruns of a stage after a known failure, one sentence per set of
 * added flags, naming the subjects, for example "Reran with -no-fix-ga:
 * sub-101, sub-155." Each sentence's tooltip states the reasons.
 */
function rerunLines(
  subjects: readonly Subject[],
  columns: readonly string[],
): Array<{ text: string; detail: string }> {
  const byFact = new Map<
    string,
    { subjectIds: string[]; details: Set<string> }
  >()
  for (const s of subjects) {
    for (const col of columns) {
      const idx = MATRIX_INDEX[col]
      if (idx === undefined) continue
      const rerun = s.cells[idx]?.rerun
      if (!rerun) continue
      const entry = byFact.get(rerun.fact) ?? {
        subjectIds: [],
        details: new Set<string>(),
      }
      if (!entry.subjectIds.includes(s.id)) entry.subjectIds.push(s.id)
      entry.details.add(rerun.detail)
      byFact.set(rerun.fact, entry)
    }
  }
  return [...byFact].map(([fact, { subjectIds, details }]) => {
    const shown = subjectIds.slice(0, STAGE_RERUN_SUBJECT_LIMIT)
    const more = subjectIds.length - shown.length
    return {
      text: `${fact}: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`,
      detail: [...details].join(' '),
    }
  })
}

/**
 * Most distinct failure reasons a stage card's failure line states, as the
 * failed-run notice names at most three failed jobs. The line counts the rest
 * and its tooltip lists them all.
 */
const STAGE_FAILURE_REASON_LIMIT = 3

/**
 * State a stage card's failure line: the first distinct reasons, then how many
 * more apply, in the words a run summary uses for its uncounted reasons.
 *
 * @param reasons - The stage's distinct failure reasons, as sentences.
 * @example
 * failureLine(['A.', 'B.', 'C.', 'D.']) // 'A. B. C. 1 more reason applies.'
 */
function failureLine(reasons: readonly string[]): string {
  const shown = reasons.slice(0, STAGE_FAILURE_REASON_LIMIT)
  const more = reasons.length - shown.length
  if (more === 1) shown.push('1 more reason applies.')
  else if (more > 1) shown.push(`${more} more reasons apply.`)
  return shown.join(' ')
}

function Row({
  children,
  gap = 8,
  justify,
  wrap,
  style,
}: {
  children: ReactNode
  gap?: number
  justify?: CSSProperties['justifyContent']
  wrap?: boolean
  style?: CSSProperties
}): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap,
        justifyContent: justify,
        flexWrap: wrap ? 'wrap' : 'nowrap',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function Stack({
  children,
  gap = 8,
  style,
}: {
  children: ReactNode
  gap?: number
  style?: CSSProperties
}): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>
      {children}
    </div>
  )
}

/**
 * Why a recovery card is disabled while the runtime restore has not answered:
 * whether a run waits for recovery is then unknown, not absent.
 */
const RUN_HISTORY_NOT_RESTORED = 'The run history has not been restored.'

/** What a live launch does while Allow live runs is off. */
const LIVE_READ_ONLY_REASON =
  'Allow live runs is off, so a live plan opens read-only and cannot be authorized. Turn it on to execute, or turn on Dry run first to preview.'

/** Render workflow launch and runtime monitoring. */
export function RunsScreen(props: RunsScreenProps = {}): ReactNode {
  const { projectEpoch } = useApp()
  return <ProjectRuns key={projectEpoch} {...props} />
}

function ProjectRuns({
  cfg: cfgProp,
  subjects: subjectsProp,
  selection: selectionProp,
  dirty = false,
  refresh,
  blockers = [],
  envReport = null,
  onEnvReport,
}: RunsScreenProps): ReactNode {
  const app = useApp()
  const { t, setRoute, setResultsStage, setLogsFocusRunId } = app
  const reducedMotion = useReducedMotion()
  const runtime = useRuntime()
  const execution = useExecutionService()
  // Keep the launch feedback in the app shell so it survives a visit to Logs
  // or Results while a run is still going.
  const { runsFeedback, setRunsFeedback } = app
  const { error, notice, outcome, stageOutcome } = runsFeedback
  const setError = useCallback(
    (next: ExecutionFailure | null) =>
      setRunsFeedback((prev) => ({ ...prev, error: next })),
    [setRunsFeedback],
  )
  const setNotice = useCallback(
    (next: string | null) =>
      setRunsFeedback((prev) => ({ ...prev, notice: next })),
    [setRunsFeedback],
  )
  const setOutcome = useCallback(
    (next: WorkflowResult | null) =>
      setRunsFeedback((prev) => ({ ...prev, outcome: next })),
    [setRunsFeedback],
  )
  const setStageOutcome = useCallback(
    (next: { stepKey: StepKey; message: string } | null) =>
      setRunsFeedback((prev) => ({ ...prev, stageOutcome: next })),
    [setRunsFeedback],
  )
  // Open Logs on a run, as the Dashboard's Recent runs does: Logs focuses
  // that run and gives keyboard focus to its Run list, since the control
  // that opened it leaves with this screen. A stage card also hands over its
  // stage, so Logs selects the run's newest job of that stage rather than the
  // run's first listed job. Without a run, Logs opens on its default run.
  const openRunLogs = useCallback(
    (runId: string | null, stepKey: StepKey | null = null): void => {
      if (runId !== null) setLogsFocusRunId(runId, stepKey)
      setRoute('logs')
    },
    [setLogsFocusRunId, setRoute],
  )
  // The launch in progress is shared with the shell, so a plan started from
  // the dock, a shortcut, or the palette holds this screen too, and a plan
  // started here holds the dock after a tab change. Its label shows while
  // planning and starting can take a while on a large cohort.
  const { pendingPlan, trackPlan } = app
  const pendingLabel = pendingPlan?.label ?? null
  // The card that started the launch repeats its progress, so the page
  // banner the operator may have scrolled past is not the only place.
  const launchOrigin = pendingPlan?.card ?? null
  const pendingFor = useCallback(
    (label: string, origin: LaunchOrigin) =>
      trackPlan({
        label,
        waitReason: `Supraspina is planning ${launchOriginName(origin)}.`,
        card: origin,
      }),
    [trackPlan],
  )
  // Every other launch and recovery control waits for the plan in progress,
  // and says which plan it waits for.
  const pendingReason = pendingPlan?.waitReason ?? null
  const [pendingConfirm, setPendingConfirm] = useState<
    | 'workflow'
    | 'resume'
    | 'cancel'
    | 'retry-cancelled'
    | 'clean-retry'
    | 'asset-rebuild'
    | null
  >(null)
  const [pendingStage, setPendingStage] = useState<StepKey | null>(null)
  const [acknowledgeQcScope, setAcknowledgeQcScope] = useState(false)
  const [acknowledgeMemoryAdvisory, setAcknowledgeMemoryAdvisory] =
    useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [openStages, setOpenStages] = useState<Record<string, boolean>>({})
  const toggleStage = useCallback((key: string): void => {
    setOpenStages((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const rootRef = useRef<HTMLDivElement | null>(null)

  const cfg = cfgProp ?? app.cfg
  const subjects = useMemo<Subject[]>(
    () => subjectsProp ?? app.subjects,
    [subjectsProp, app.subjects],
  )
  // Re-read the inventory whenever a run ends or a QC verdict changes, so a
  // rerun stage reads done again and a stage that the new verdicts make out
  // of date says so without leaving the screen. The app shares this read
  // with the top bar, the Dashboard, and Subjects.
  const {
    producedStepKeys: detectedResultStages,
    stageCurrency,
    analysisCohortChange,
    reload: reloadStageCurrency,
  } = useProjectStageCurrency({
    project: app.projectRef,
    subjects,
    runs: runtime.runs,
    enabled: !runtime.hydrating,
  })
  const analysisSubjects = useMemo(
    () => analysisEligibleSubjects(subjects),
    [subjects],
  )
  // The shell passes Runs its subjects with the live run's jobs overlaid, so
  // the states discovered before the run are the shell's own subjects; a
  // queued cohort job has not replaced that output yet.
  const discoveredAnalysisSubjects = useMemo(() => {
    const discovered = new Map(
      app.subjects.map((subject) => [subject.id, subject] as const),
    )
    return analysisSubjects.map(
      (subject) => discovered.get(subject.id) ?? subject,
    )
  }, [app.subjects, analysisSubjects])
  const statusAnalysisSubjects = useMemo(
    () =>
      analysisEligibleSubjects(
        projectSubjectRuntimeStatus(subjects, runtime.runs, runtime.jobs),
      ),
    [runtime.jobs, runtime.runs, subjects],
  )
  const analysisSubjectIds = useMemo(
    () => new Set(analysisSubjects.map((subject) => subject.id)),
    [analysisSubjects],
  )
  // Count the cohort only once discovery has answered, as the run dock does:
  // before that an empty list is a cohort still loading, so the header target
  // holds the placeholder and the page states the wait instead of an empty
  // cohort's banner and run cards.
  const cohortSize = knownCohortSize(
    app.discoveryAnswered,
    analysisSubjects.length,
  )
  const loading = runtime.hydrating || cohortSize === null
  // The run dock hides its run controls here, so the page names the wait as
  // the dock does: the cohort load only while the cohort is unknown, then
  // the runtime restore of the durable runs and jobs.
  const loadingLabel =
    cohortSize === null ? 'Loading the cohort...' : 'Restoring run history...'
  const jobs = useMemo<LiveJob[]>(
    () =>
      runtime.activeJobs.flatMap((job) =>
        job.runId
          ? [
              {
                id: job.id,
                runId: job.runId,
                subjectId: job.subjectId,
                stepKey: job.stepKey,
                status: job.status,
                // Only a started job has an elapsed time; a queued job that
                // counted from its planning time would look like a stalled
                // process with a Stop button beside it.
                startedAt:
                  job.status === 'running' || job.status === 'cancelling'
                    ? (job.startedAt ?? null)
                    : null,
              },
            ]
          : [],
      ),
    [runtime.activeJobs],
  )
  const [jobAnnouncement, setJobAnnouncement] = useState('')
  const announcedJobsRef = useRef<ReadonlyMap<string, LiveJob> | null>(null)

  // Announce only what entered, left, or changed status in the job list. Take
  // the first authoritative projection as the state on arrival, not a change.
  const authoritativeRuntimeKnown = runtime.authoritativeRuntimeKnown
  useEffect(() => {
    if (!authoritativeRuntimeKnown) {
      announcedJobsRef.current = null
      return
    }
    const current = new Map(jobs.map((job) => [job.id, job]))
    const previous = announcedJobsRef.current
    announcedJobsRef.current = current
    if (previous === null) return
    const announcement = describeJobChanges(previous, current)
    if (announcement !== '') setJobAnnouncement(announcement)
  }, [authoritativeRuntimeKnown, jobs])

  const activeRunIds = useMemo(() => {
    const ids = new Set(runtime.activeRuns.map((run) => run.runId))
    for (const job of runtime.activeJobs) {
      if (job.runId) ids.add(job.runId)
    }
    return ids
  }, [runtime.activeRuns, runtime.activeJobs])
  const displayedError = error?.error.message ?? runtime.error

  // The stage currency is read again only when a run ends, so mid-run it
  // still lists a subject whose stage job the live run has just finished,
  // and that job wrote a current receipt. Count such a subject done while its
  // run has not ended and, once it ends, until the read its end triggered
  // lands; the currency read then is the authority again. A run counts as
  // ended when it has an end time, as it does for that read.
  const unendedRunIds = useMemo(
    () =>
      new Set(
        runtime.runs
          .filter((run) => run.endedAt === null)
          .map((run) => run.runId),
      ),
    [runtime.runs],
  )
  const [endedRuns, setEndedRuns] = useState<{
    runIds: ReadonlySet<string>
    readBeforeEnd: typeof stageCurrency
  } | null>(null)
  const seenUnendedRunIdsRef = useRef(unendedRunIds)
  useEffect(() => {
    const previous = seenUnendedRunIdsRef.current
    seenUnendedRunIdsRef.current = unendedRunIds
    const ended = [...previous].filter((runId) => !unendedRunIds.has(runId))
    if (ended.length === 0) return
    setEndedRuns((prior) => ({
      runIds: new Set([
        ...(prior?.readBeforeEnd === stageCurrency ? prior.runIds : []),
        ...ended,
      ]),
      readBeforeEnd: stageCurrency,
    }))
  }, [unendedRunIds, stageCurrency])
  const liveFinished = useMemo(() => {
    const runIds = new Set(unendedRunIds)
    if (endedRuns?.readBeforeEnd === stageCurrency) {
      for (const runId of endedRuns.runIds) runIds.add(runId)
    }
    return liveFinishedStages(runtime.jobs, runIds)
  }, [unendedRunIds, endedRuns, stageCurrency, runtime.jobs])

  // The nodes of the active run launched here that have no job yet: a node
  // waiting on an earlier stage of the same run becomes a job only when that
  // stage finishes, so neither the subjects' states nor the runtime jobs show
  // it. The approved plan the launch kept lists it. Stage cards count it as
  // planned and In flight lists it as not started.
  const scheduledNodes = useMemo<WorkflowNode[]>(() => {
    const runId = outcome?.runId
    if (!runId || outcome.disposition !== 'started') return []
    const run = runtime.runs.find((candidate) => candidate.runId === runId)
    if (
      !run ||
      run.dryRun ||
      run.endedAt !== null ||
      !SCHEDULING_RUN_STATUSES.has(run.status)
    ) {
      return []
    }
    const withJob = new Set(
      runtime.jobs
        .filter((job) => job.runId === runId)
        .map((job) => stageJobKey(job.stepKey, job.subjectId)),
    )
    return outcome.plan.nodes.filter(
      (node) =>
        RUNNABLE_NODE_STATUSES.has(node.status) &&
        !withJob.has(stageJobKey(node.stepKey, node.subjectId)),
    )
  }, [outcome, runtime.runs, runtime.jobs])
  const scheduled = useMemo(
    () =>
      new Set(
        scheduledNodes.map((node) => stageJobKey(node.stepKey, node.subjectId)),
      ),
    [scheduledNodes],
  )
  const scheduledRunId =
    scheduledNodes.length > 0 ? (outcome?.runId ?? null) : null
  // The subjects each per-subject stage's active run holds, from its jobs and
  // its nodes without a job yet, so a stage card counts the run's scope
  // rather than whatever the target selects meanwhile.
  const stageRunSubjectIds = useMemo(() => {
    const byStage = new Map<StepKey, Set<string>>()
    const add = (stepKey: StepKey, subjectId: string | null): void => {
      if (subjectId === null) return
      const ids = byStage.get(stepKey) ?? new Set<string>()
      ids.add(subjectId)
      byStage.set(stepKey, ids)
    }
    for (const job of runtime.jobs) {
      if (job.runId !== undefined && activeRunIds.has(job.runId)) {
        add(job.stepKey, job.subjectId)
      }
    }
    for (const node of scheduledNodes) add(node.stepKey, node.subjectId)
    return byStage
  }, [runtime.jobs, activeRunIds, scheduledNodes])

  // Stamp freshness after cohort and configuration state settle.
  useEffect(() => {
    if (loading) return
    const id = setTimeout(() => setLastUpdatedAt(new Date().toISOString()), 0)
    return () => clearTimeout(id)
  }, [loading, cfg, subjects, runtime.runs, runtime.activeJobs])

  const handleRefresh = useCallback(() => {
    setLastUpdatedAt(new Date().toISOString())
    refresh?.()
    reloadStageCurrency()
  }, [refresh, reloadStageCurrency])

  // Tick elapsed timers once per second while work remains active.
  useEffect(() => {
    if (jobs.length === 0) return
    if (reducedMotion) {
      // Refresh the clock once without a motion-producing ticker.
      const once = setTimeout(() => setNow(Date.now()), 0)
      return () => clearTimeout(once)
    }
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [jobs.length, reducedMotion])

  const target = useMemo(() => {
    const requested = selectionProp
      ? { mode: 'explicit' as const, subjectIds: selectionProp }
      : app.executionTarget
    if (requested.mode === 'all') return requested
    return {
      mode: 'explicit' as const,
      subjectIds: [
        ...new Set(
          requested.subjectIds.filter((id) => analysisSubjectIds.has(id)),
        ),
      ].sort(),
    }
  }, [selectionProp, app.executionTarget, analysisSubjectIds])

  // Input QC's crop reviews, read while the Reconstruction card can use them:
  // Brain FOV preparation feeds Reconstruction and Reconstruction is not done
  // for every subject in scope. The card then names the crops the planner
  // still holds. One read serves every visit until the saved revision
  // changes or a run ends, since a run that prepares crops changes it.
  const reconWaiting = useMemo(
    () =>
      cfg.steps.brainfov?.enabled === true &&
      statusAnalysisSubjects.some(
        (subject) =>
          (target.mode === 'all' || target.subjectIds.includes(subject.id)) &&
          subject.stepStates?.recon !== 'done',
      ),
    [cfg.steps.brainfov?.enabled, statusAnalysisSubjects, target],
  )
  const endedRunIds = useMemo(
    () =>
      runtime.runs
        .filter((run) => run.endedAt !== null)
        .map((run) => run.runId)
        .join('|'),
    [runtime.runs],
  )
  // Wait for the restored run history, whose ended runs are part of the key,
  // so arriving on Runs reads once rather than before and after the restore.
  const cropGeneration = useCropInventoryGeneration()
  const cropReadKey =
    app.projectRef && reconWaiting && !dirty && !runtime.hydrating
      ? JSON.stringify([
          app.projectRef.projectId,
          app.projectRef.root,
          app.projectRef.epoch,
          app.savedRevision,
          endedRunIds,
          cropGeneration,
        ])
      : null
  const [cropRead, setCropRead] = useState<{
    key: string
    items: readonly InputFovItem[]
  } | null>(null)
  useEffect(() => {
    const project = app.projectRef
    if (cropReadKey === null || project === null) return undefined
    let active = true
    const revision = app.savedRevision
    const cfgForRead = app.savedCfg
    void cropInventory(cropReadKey, async () => {
      const result = await getApi().inputFov.list({
        project,
        cfg: cfgForRead,
        configRevision: revision,
      })
      if (result.configRevision !== revision) {
        throw new Error('The inventory answered for another revision.')
      }
      return result.items
    })
      .then((items) => {
        if (active) setCropRead({ key: cropReadKey, items })
      })
      .catch(() => {
        // Without the inventory the card states only the other blockers;
        // the plan still names each crop that waits.
        if (active) setCropRead(null)
      })
    return () => {
      active = false
    }
  }, [cropReadKey, app.projectRef, app.savedCfg, app.savedRevision])
  const cropsWaiting = useMemo(
    () =>
      cropRead === null || cropRead.key !== cropReadKey
        ? null
        : cropsAwaitingApproval(cropRead.items),
    [cropRead, cropReadKey],
  )
  const targetLabel =
    target.mode === 'explicit'
      ? `${target.subjectIds.length} selected subject${target.subjectIds.length === 1 ? '' : 's'} for per-subject work; cohort stages still use the full analysis cohort`
      : `whole analysis cohort (${analysisSubjects.length} subject${analysisSubjects.length === 1 ? '' : 's'})`
  const targetChipLabel = targetScopePillLabel(target, cohortSize)
  const runAllLabel = targetRunButtonLabel(target, cohortSize)
  // The execution service shows a live plan read-only while Allow live runs
  // is off, so say so beside the switch and in the launch dialogs.
  const liveReadOnly = !cfg.runtime.dryRun && !app.safeExecution
  // Only a live launch with Allow live runs on can start work after review.
  const launchStarts = !cfg.runtime.dryRun && app.safeExecution
  const safeExecutionNotice = safeExecutionNoticeState(
    cfg.runtime.dryRun,
    app.safeExecution,
    dirty,
  )
  // Block every run entry point for an empty analysis cohort, and while it
  // loads. Prevent unresolved `${subject}` templates from reaching dispatch.
  // The banner stating the empty cohort waits for the load to end.
  const cohortEmpty = analysisSubjects.length === 0
  const cohortEmptyReason = emptyAnalysisCohortReason(subjects)
  const allSubjectsQcFailed =
    subjects.length > 0 && subjects.every((subject) => subject.qc === 'fail')

  // Compose environment and dependency blockers per stage. Prefer a missing-tool
  // reason when both apply.
  const blockedByStep = useMemo(
    () =>
      mergeBlockedByStep(
        blockers,
        computeDependencyBlockers(analysisSubjects, target, cfg),
      ),
    [blockers, analysisSubjects, target, cfg],
  )

  const qcRows = useMemo(
    () => qcScopeRows(analysisSubjects),
    [analysisSubjects],
  )
  const needsQcAcknowledgement = qcRows.defer + qcRows.unreviewed > 0
  // A per-subject stage's plan is the same with or without the Defer
  // acknowledgement, so only a cohort stage asks for it.
  const stageNeedsQcAcknowledgement =
    needsQcAcknowledgement &&
    pendingStage !== null &&
    qcAcknowledgementGatesStage(pendingStage)
  // Review plan stays disabled until each acknowledgement is ticked, so say
  // so beside the box instead of leaving a disabled button unexplained.
  const qcAcknowledgementReason = qcScopeAcknowledgementHint(qcRows)
  const memoryAcknowledgementReason = memoryAcknowledgementHint(
    cfg.runtime.memoryWarningGB,
  )
  const memoryAcknowledgement = memoryAcknowledgementLabel(
    envReport?.availableMemoryGB ?? 0,
    cfg.runtime.memoryWarningGB,
  )
  const needsMemoryAcknowledgement =
    envReport?.availableMemoryGB !== null &&
    envReport?.availableMemoryGB !== undefined &&
    envReport.availableMemoryGB < cfg.runtime.memoryWarningGB

  const acknowledgements = useCallback(
    () => ({
      includeDeferredAndUnreviewedQc: acknowledgeQcScope,
      acknowledgeMemoryAdvisory,
    }),
    [acknowledgeQcScope, acknowledgeMemoryAdvisory],
  )

  const runStage = useCallback(
    (step: StepKey) => {
      // Name every refusal on the stage card the operator activated.
      if (dirty) {
        setStageOutcome({
          stepKey: step,
          message: 'Save the project before starting a run.',
        })
        return
      }
      if (cohortEmpty) {
        setStageOutcome({
          stepKey: step,
          message: 'Change subject eligibility before starting a run.',
        })
        return
      }
      const staticBlocker = blockedByStep.get(step)
      if (staticBlocker !== undefined) {
        setStageOutcome({ stepKey: step, message: staticBlocker })
        return
      }
      // The planner asks for the Defer acknowledgement before any plan; a
      // per-subject stage gives it, as its plan does not depend on it.
      const capturedAcknowledgements = qcAcknowledgementGatesStage(step)
        ? acknowledgements()
        : { ...acknowledgements(), includeDeferredAndUnreviewedQc: true }
      setStageOutcome(null)
      const planning = pendingFor(
        launchStarts
          ? `Planning and starting ${stageName(step)}...`
          : `Planning ${stageName(step)}...`,
        { kind: 'stage', stepKey: step },
      )
      runExecutionAction(
        () => execution.runStage(step, capturedAcknowledgements, planning),
        'Retry running the stage.',
        setError,
        // The page line announces the outcome, so it names the stage.
        (message) =>
          setNotice(
            message === null ? null : stagePlanLine(stageName(step), message),
          ),
        (result) => {
          setOutcome(result)
          // Attribute a successful blocked or empty plan to its initiating card,
          // in the words of the page line.
          setStageOutcome(
            result &&
              (result.disposition === 'blocked' ||
                result.disposition === 'noop')
              ? { stepKey: step, message: planOutcomeText(result) }
              : null,
          )
        },
        planning,
      )
    },
    [
      dirty,
      cohortEmpty,
      blockedByStep,
      execution,
      acknowledgements,
      pendingFor,
      launchStarts,
    ],
  )

  // Resume and Clean up and retry act only on the newest run, and only while
  // it is failed, interrupted, or in a persistence error, as the run dock does.
  const recovery = useMemo(
    () => recoveryTarget(runtime.runs, runtime.jobs),
    [runtime.runs, runtime.jobs],
  )
  const retryableRun = recovery.run
  // Whether a run waits for recovery is the runtime restore's answer. Until
  // a snapshot for this project is accepted it is unknown, not absent, so the
  // recovery cards do not say there is nothing to resume, retry, or clean up,
  // as the run dock does not.
  const runtimeKnown = !runtime.hydrating && runtime.authoritativeRuntimeKnown

  const runAll = useCallback(
    (resumeRunId: string | null) => {
      // Name every refusal instead of returning silently.
      if (dirty) {
        setError(
          executionFailure(
            new Error('Save the project before starting a run.'),
            'Save the project before starting a run.',
          ),
        )
        return
      }
      if (cohortEmpty) {
        setError(
          executionFailure(
            new Error('Change subject eligibility before starting a run.'),
            'Change subject eligibility before starting a run.',
          ),
        )
        return
      }
      const capturedAcknowledgements = acknowledgements()
      setStageOutcome(null)
      const planning = resumeRunId
        ? pendingFor('Planning the resume...', { kind: 'resume' })
        : pendingFor(
            launchStarts
              ? 'Planning and starting the workflow...'
              : 'Planning the workflow...',
            { kind: 'workflow' },
          )
      runExecutionAction(
        () =>
          resumeRunId
            ? execution.resume(resumeRunId, capturedAcknowledgements, planning)
            : execution.runAll(capturedAcknowledgements, planning),
        'Retry starting the workflow.',
        setError,
        setNotice,
        setOutcome,
        planning,
      )
    },
    [dirty, cohortEmpty, execution, acknowledgements, pendingFor, launchStarts],
  )
  // The stage outcome stores only its message, so read a no-op from the
  // workflow result that produced it; a refusal or blocker stays amber.
  const stageOutcomeTone: 'info' | 'warning' =
    stageOutcome !== null &&
    outcome?.disposition === 'noop' &&
    planOutcomeText(outcome) === stageOutcome.message
      ? 'info'
      : 'warning'
  // A planned stage's outcome also sets the page line, which announces it
  // with the stage name; the card then repeats it without a second live
  // region. A refusal only the card shows stays live there.
  const stageOutcomeOnPage =
    stageOutcome !== null &&
    notice ===
      stagePlanLine(stageName(stageOutcome.stepKey), stageOutcome.message)
  const planPending = pendingPlan !== null
  const resumeDisabled =
    dirty || cohortEmpty || planPending || retryableRun === null
  const resumeDisabledReason =
    pendingReason ??
    (retryableRun === null
      ? runtimeKnown
        ? `Nothing to resume: ${recovery.reason}`
        : RUN_HISTORY_NOT_RESTORED
      : undefined)
  // A run can end blocked before any job starts, which leaves the start-time
  // notice claiming the run is queued. Follow the started run into its blocked
  // outcome and show the reason the sidecar recorded in its summary.
  // Follow it into every terminal state as well, so a run that fails seconds
  // after approval is reported here rather than only in Logs.
  useEffect(() => {
    const runId = outcome?.runId
    if (!runId) return undefined
    const run = runtime.runs.find((candidate) => candidate.runId === runId)
    if (!run) return undefined
    let update: (() => void) | Promise<() => void> | null = null
    if (run.status === 'blocked') {
      // Say what finished before naming what did not run; the plan-time
      // summary alone reads as if nothing happened, and its lead-in, whether
      // "This pass runs ..." or "Resolve N blocked nodes.", is no longer
      // true once the run has ended.
      const finished = runtime.jobs.filter(
        (job) => job.runId === runId && job.status === 'done',
      ).length
      const { summary } = run
      const planNodes = outcome?.plan.nodes ?? []
      const jobs = runtime.jobs
      update = readManifestSteps(app.projectRef, runId).then((steps) => {
        const message = blockedRunNotice(
          runId,
          finished,
          summary,
          blockedRunStageNames(runId, planNodes, jobs, steps),
          blockedRunRecords(runId, planNodes, jobs),
        )
        return () => setNotice(message)
      })
    } else if (
      (run.status === 'failed' ||
        run.status === 'interrupted' ||
        run.status === 'persistence-error') &&
      recoveredByLaterRun(run, runtime.runs, runtime.jobs)
    ) {
      // A later run finished the work this one left, as a Logs retry of its
      // failed node does, and that run was not launched here, so this screen
      // does not follow it. The failure no longer needs the operator, so its
      // alert gives way to the recovery, as it does after a Resume from Runs.
      const message = recoveredRunNotice(
        run,
        runEndedSentence(runId, run.status),
        runtime.runs,
        runtime.jobs,
      )
      update = () => {
        setError(null)
        setNotice(message)
      }
    } else if (
      run.status === 'failed' ||
      run.status === 'interrupted' ||
      run.status === 'persistence-error'
    ) {
      const ownJobs = runtime.jobs.filter((job) => job.runId === runId)
      const failed = ownJobs.filter((job) => job.status === 'failed')
      const completed = ownJobs.filter((job) => job.status === 'done').length
      const detail =
        failedJobsDetail(failed) ||
        (completed > 0
          ? `${completed} job${completed === 1 ? '' : 's'} completed before the run ended.`
          : 'No job completed.')
      // Name the work the run left without an outcome too: a node withheld
      // after a failure, or interrupted before it started, often has no job,
      // so no job surface shows it.
      const unfinished = unfinishedNodesSentence(
        run.summary,
        (outcome?.plan.nodes ?? []).length,
      )
      const message = `${runEndedSentence(runId, run.status)} ${detail}${
        unfinished ? ` ${unfinished}` : ''
      } Open Logs for the captured output.`
      update = () => {
        setNotice(null)
        setError({
          error: new Error(message),
          reviewAgain: { label: 'Open Logs', run: () => openRunLogs(runId) },
        })
      }
    } else if (run.status === 'done' && !run.dryRun) {
      // A finished run's summary only restates that it finished; say it once.
      update = () => setNotice(`Run ${runId} finished.`)
    } else if (run.status === 'cancelled') {
      // A run canceled from the in-flight Stop control, the run dock, or Logs
      // ended as the operator chose; state it as the outcome, not a failure.
      const message = canceledRunNotice(runId, runtime.jobs)
      update = () => setNotice(message)
    }
    if (!update) return undefined
    const pending = update
    let active = true
    // A blocked run's notice waits for its manifest; a later runtime change
    // or a new launch discards a notice that is still being read.
    void Promise.resolve(pending).then((apply) => {
      if (active) apply()
    })
    return () => {
      active = false
    }
  }, [runtime.runs, runtime.jobs, outcome, openRunLogs, app.projectRef])

  // Retry canceled acts on the newest canceled run whose unfinished work no
  // later run finished; a canceled run retried to completion is not offered.
  const cancelledRetry = useMemo(
    () => cancelledRetryTarget(runtime.runs, runtime.jobs),
    [runtime.runs, runtime.jobs],
  )
  const cancelledRun = cancelledRetry.run

  const retryCancelled = useCallback(() => {
    if (!cancelledRun) return
    const capturedAcknowledgements = acknowledgements()
    setStageOutcome(null)
    const planning = pendingFor('Planning the retry...', {
      kind: 'retry-cancelled',
    })
    runExecutionAction(
      () =>
        execution.retry(cancelledRun.runId, {
          includeCancelled: true,
          acknowledgements: capturedAcknowledgements,
          planning,
        }),
      'Retry the canceled run.',
      setError,
      setNotice,
      setOutcome,
      planning,
    )
  }, [acknowledgements, cancelledRun, execution, pendingFor])

  const cleanIncompleteRetry = useCallback(() => {
    if (!retryableRun) return
    const capturedAcknowledgements = acknowledgements()
    setStageOutcome(null)
    const planning = pendingFor('Planning the cleanup and retry...', {
      kind: 'clean-retry',
    })
    runExecutionAction(
      () =>
        execution.retry(retryableRun.runId, {
          cleanIncomplete: true,
          acknowledgements: capturedAcknowledgements,
          planning,
        }),
      'Retry cleaning and rerunning incomplete work.',
      setError,
      setNotice,
      setOutcome,
      planning,
    )
  }, [acknowledgements, retryableRun, execution, pendingFor])

  // Offer the offline rebuild of the scientific assets on each stage card the
  // failing asset checks block, through the same Allow live runs and one-use
  // opt-in authorization as Diagnostics. It starts only from its confirm.
  const assetRebuild = useMemo(
    () => offlineAssetRebuild(envReport),
    [envReport],
  )
  const rebuildStages = useMemo(() => {
    const stages = new Set<StepKey>()
    if (!assetRebuild || !envReport) return stages
    const restored = new Set([
      assetRebuild.check.id,
      ...assetRebuild.restores.map((check) => check.id),
    ])
    for (const meta of PIPELINE_STEPS) {
      if (
        missingAssetCheckIds(meta.key, envReport, cfg).some((id) =>
          restored.has(id),
        )
      ) {
        stages.add(meta.key)
      }
    }
    return stages
  }, [assetRebuild, envReport, cfg])
  // The card that opened the rebuild shows its progress and outcome.
  const [rebuildOrigin, setRebuildOrigin] = useState<StepKey | null>(null)
  const identityRef = useRef<{
    projectRef: ProjectRef | null
    configRevision: number
  } | null>(null)
  useLayoutEffect(() => {
    identityRef.current = {
      projectRef: app.projectRef,
      configRevision: app.configRevision,
    }
    return () => {
      identityRef.current = null
    }
  }, [app.projectRef, app.configRevision])
  // Re-check the environment after a rebuild, as Diagnostics does, so the
  // stage cards and the top bar read the restored assets.
  const recheckEnvironment = useCallback(async (): Promise<void> => {
    const captured = app.projectRef
    if (!captured) return
    const capturedRevision = app.configRevision
    try {
      const next = await getApi().env.check({
        project: captured,
        cfg,
        configRevision: capturedRevision,
      })
      const latest = identityRef.current
      if (
        latest?.configRevision !== capturedRevision ||
        latest.projectRef?.projectId !== captured.projectId ||
        latest.projectRef.epoch !== captured.epoch
      ) {
        return
      }
      onEnvReport?.(next)
    } catch {
      // Keep the current report; the stage card still names its blocker and
      // Diagnostics can re-check.
    }
    app.refreshToolStatus()
  }, [app, cfg, onEnvReport])
  const install = useEnvInstall({
    safeExecution: app.safeExecution,
    request: { cfg: app.savedCfg, configRevision: app.savedRevision },
    blocked: dirty,
    onInstalled: () => {
      void recheckEnvironment()
    },
  })
  const rebuildRunning =
    assetRebuild !== null && install.running === assetRebuild.check.id
  const rebuildState = assetRebuild
    ? install.states[assetRebuild.check.id]
    : undefined
  const rebuildGate =
    assetRebuild && !rebuildRunning
      ? installGate({
          action: 'rebuild the scientific assets',
          projectOpen: app.projectRef !== null,
          safeExecution: app.safeExecution,
          dirty,
          busy: install.running !== null,
        })
      : null

  // The runs the last Cancel all asked to cancel, so the notice that the
  // cancellation was requested can give way to how each run ended.
  const [cancelRequest, setCancelRequest] = useState<readonly string[] | null>(
    null,
  )
  const cancelRunning = useCallback(() => {
    const runIds = [...activeRunIds]
    if (runIds.length === 0) return
    setError(null)
    setNotice(null)
    setOutcome(null)
    setStageOutcome(null)
    setCancelRequest(runIds)
    void Promise.all(runIds.map((runId) => execution.cancel(runId)))
      .then(() => setNotice(CANCELLATION_REQUESTED_NOTICE))
      .catch((cause: unknown) =>
        setError(executionFailure(cause, 'Retry canceling active work.')),
      )
  }, [execution, activeRunIds])

  // Replace the request notice once every run it covered has ended, with how
  // each ended. The notice outlives a visit to another screen, and this
  // screen's record of the request does not; a new launch clears the notice,
  // so the runs it covered are then the newest run.
  useEffect(() => {
    if (notice !== CANCELLATION_REQUESTED_NOTICE) return
    const newest = newestRun(runtime.runs)
    const requested = cancelRequest ?? (newest ? [newest.runId] : [])
    const runs = requested.flatMap((runId) => {
      const run = runtime.runs.find((candidate) => candidate.runId === runId)
      return run ? [run] : []
    })
    if (
      runs.length === 0 ||
      runs.length < requested.length ||
      runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))
    ) {
      return
    }
    setNotice(
      runs.map((run) => settledRunSentence(run, runtime.jobs)).join(' '),
    )
  }, [notice, cancelRequest, runtime.runs, runtime.jobs, setNotice])

  const normalizeReconstructionCohort = useCallback(() => {
    const capturedAcknowledgements = acknowledgements()
    setStageOutcome(null)
    runExecutionAction(
      () =>
        execution.run(
          {
            kind: 'stage',
            stepKey: 'recon',
            target: { mode: 'all' },
          },
          capturedAcknowledgements,
          undefined,
          // A read-only review names this flow's own button.
          NORMALIZE_RECONSTRUCTION_COHORT_LABEL,
        ),
      'Retry planning full-cohort reconstruction normalization.',
      setError,
      setNotice,
      setOutcome,
    )
  }, [acknowledgements, execution])

  const runCohort = useCallback(() => {
    if (dirty || cohortEmpty || planPending) return
    app.selectAllSubjects()
    setAcknowledgeQcScope(false)
    setAcknowledgeMemoryAdvisory(false)
    setPendingConfirm('workflow')
  }, [app, dirty, cohortEmpty, planPending])

  const stopJob = useCallback(
    (runId: string) => {
      void execution
        .cancel(runId)
        .catch((cause: unknown) =>
          setError(executionFailure(cause, 'Retry stopping the run.')),
        )
    },
    [execution],
  )

  // Apply R, Shift+R, and C shortcuts only when the screen owns focus.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (document.querySelector('[role="dialog"]')) return
      const el = document.activeElement
      const tag = el?.tagName.toLowerCase()
      if (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        (el instanceof HTMLElement &&
          (el.isContentEditable || el.closest('[role="dialog"]')))
      )
        return
      // The shell defers these keys to this screen while it is the route, so
      // accept them from the chrome around it too, such as the navigation
      // button that opened the screen; editable targets and dialogs were
      // excluded above.
      if (e.key === 'r') {
        if (dirty || cohortEmpty || planPending) return
        e.preventDefault()
        setAcknowledgeQcScope(false)
        setAcknowledgeMemoryAdvisory(false)
        setPendingConfirm('workflow')
      } else if (e.key === 'R') {
        if (resumeDisabled) return
        e.preventDefault()
        setPendingConfirm('resume')
      } else if (e.key === 'c') {
        if (activeRunIds.size === 0) return
        e.preventDefault()
        setPendingConfirm('cancel')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dirty, cohortEmpty, planPending, resumeDisabled, activeRunIds])

  const right = (
    <Row gap={14}>
      <Row gap={6}>
        <span
          style={{
            fontFamily: FONTS.sans,
            fontSize: 10.5,
            letterSpacing: 0.2,
            color: t.dimText,
          }}
        >
          Target
        </span>
        {/* The shell draws no run dock on Runs, so this chip carries
            the same clear control. */}
        <ScopeChip
          t={t}
          target={target}
          label={targetChipLabel}
          {...(cohortSize === null ? { title: COHORT_LOADING_TITLE } : {})}
          onClearSelection={app.clearSelection}
          onSelectAll={app.selectAllSubjects}
        />
      </Row>
      <Row gap={6}>
        {lastUpdatedAt && (
          <FreshnessStamp
            t={t}
            at={lastUpdatedAt}
            title={`Cohort and run state refreshed at ${formatRunTime(
              lastUpdatedAt,
            )}.`}
          />
        )}
        <RefreshButton
          t={t}
          ariaLabel="Refresh cohort and run state"
          title="Refresh cohort and run state."
          onClick={handleRefresh}
          disabled={!refresh}
        />
      </Row>
      {/* The shell draws no run dock on Runs, so its Add subject is here. */}
      <Btn
        t={t}
        icon={<Ico d={ICONS.plus} size={ICON_SIZE.nav} />}
        label="Add subject"
        ghost
        small
        onClick={() => setRoute('registry')}
      />
    </Row>
  )

  return (
    <Page t={t} title="Runs" right={right}>
      <div ref={rootRef} tabIndex={-1} style={{ outline: 'none' }}>
        <Stack gap={16}>
          {pendingLabel && <LoadingState t={t} label={pendingLabel} />}
          {displayedError && (
            <ErrorState
              t={t}
              title={errorMessageText(displayedError)}
              detail={displayedError}
              // The detail is the raw message behind the readable title.
              mono
              // A failed runtime restore is retried, not the cohort discovery.
              {...(error?.reviewAgain
                ? {
                    onRetry: error.reviewAgain.run,
                    retryLabel: error.reviewAgain.label,
                  }
                : runtime.error
                  ? { onRetry: runtime.retryHydration }
                  : {})}
              // A launch or run failure is dismissed with the run it follows,
              // so the next runtime change does not raise it again; a runtime
              // error clears only when the runtime recovers.
              {...(error
                ? {
                    onDismiss: () =>
                      setRunsFeedback((prev) => ({
                        ...withoutPlanOutcome(prev),
                        error: null,
                      })),
                  }
                : {})}
            />
          )}
          {notice && (
            <ExecutionOutcomeNotice
              t={t}
              message={notice}
              {...(outcome
                ? {
                    blockers: outcome.plan.blockers,
                    nodes: outcome.plan.nodes,
                    onOpenRegistry: () => setRoute('registry'),
                  }
                : {})}
              {...(canNormalizeReconstructionCohort(outcome)
                ? {
                    onNormalizeReconstructionCohort:
                      normalizeReconstructionCohort,
                  }
                : {})}
              // Logs lists each job of a canceled run with its outcome.
              {...(statesCanceledRun(notice)
                ? { onOpenLogs: () => openRunLogs(canceledRunId(notice)) }
                : {})}
              // A no-work outcome clears when the operator leaves Runs; any
              // other outcome stays until it is dismissed here or replaced.
              onDismiss={() => setRunsFeedback(withoutPlanOutcome)}
            />
          )}

          {dirty && (
            // The invariant's key stays machine-readable here; the banner
            // itself states only the fact.
            <div
              role="status"
              data-invariant="no-run-while-dirty"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderRadius: 5,
                background: t.warningSoft,
                border: `1px solid color-mix(in srgb, ${t.warning} 27%, transparent)`,
              }}
            >
              <NoticeGlyph t={t} tone="warn" />
              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 12,
                  color: t.warning,
                }}
              >
                The configuration has unsaved changes, and runs start only after
                it is saved.
              </span>
            </div>
          )}

          {cohortSize !== null && cohortEmpty && (
            <div
              role="status"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderRadius: 5,
                background: t.warningSoft,
                border: `1px solid color-mix(in srgb, ${t.warning} 27%, transparent)`,
              }}
            >
              <NoticeGlyph t={t} tone="warn" />
              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 12,
                  color: t.warning,
                }}
              >
                {cohortEmptyReason}
              </span>
            </div>
          )}

          {loading ? (
            <LoadingState t={t} label={loadingLabel} />
          ) : (
            <>
              <Card t={t} title="Execution controls">
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'flex-start',
                    gap: '8px 24px',
                  }}
                >
                  <Stack gap={2}>
                    <span title="Prints each command to Logs without executing it.">
                      <Toggle
                        t={t}
                        checked={cfg.runtime.dryRun}
                        onChange={(dryRun) =>
                          app.setCfg({
                            ...cfg,
                            runtime: { ...cfg.runtime, dryRun },
                          })
                        }
                        label="Dry run first"
                      />
                    </span>
                    {!cfg.runtime.dryRun && (
                      <StateLine t={t}>
                        Commands execute on this host.
                      </StateLine>
                    )}
                  </Stack>
                  {/* The explanation lives in the tooltip, as on the other
                      toggles; only the blocked live run states a line. */}
                  <Stack gap={2} style={{ maxWidth: 520 }}>
                    <span title="Off keeps runs dry. On lasts for this session and resets to off on every launch.">
                      <Toggle
                        t={t}
                        checked={app.safeExecution}
                        onChange={app.setSafeExecution}
                        label="Allow live runs"
                      />
                    </span>
                    {liveReadOnly && (
                      <StateLine t={t} color={t.warning}>
                        {LIVE_READ_ONLY_REASON}
                      </StateLine>
                    )}
                  </Stack>
                  {/* Keep this remediation beside planner blockers for partial
                      output. */}
                  <Stack gap={2}>
                    <span title="Replaces partial output from an interrupted stage instead of keeping it for inspection.">
                      <Toggle
                        t={t}
                        checked={cfg.runtime.rerunIncomplete}
                        onChange={(rerunIncomplete) =>
                          app.setCfg({
                            ...cfg,
                            runtime: { ...cfg.runtime, rerunIncomplete },
                          })
                        }
                        label="Rerun incomplete output"
                      />
                    </span>
                    {cfg.runtime.rerunIncomplete && (
                      <StateLine t={t}>
                        A rerun replaces partial output.
                      </StateLine>
                    )}
                  </Stack>
                </div>
              </Card>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: 12,
                }}
              >
                <ActionCard
                  t={t}
                  icon={ICONS.play}
                  title={
                    target.mode === 'explicit' ? 'Run all selected' : 'Run all'
                  }
                  shortcut="R"
                  desc={`Runs every stage for the ${targetLabel}.`}
                  disabled={dirty || cohortEmpty || planPending}
                  disabledReason={pendingReason ?? undefined}
                  pending={
                    launchOrigin?.kind === 'workflow'
                      ? (pendingLabel ?? undefined)
                      : undefined
                  }
                  action={
                    <Btn
                      t={t}
                      primary
                      label={runAllLabel}
                      disabled={dirty || cohortEmpty || planPending}
                      onClick={() => {
                        setAcknowledgeQcScope(false)
                        setAcknowledgeMemoryAdvisory(false)
                        setPendingConfirm('workflow')
                      }}
                    />
                  }
                />
                <ActionCard
                  t={t}
                  icon={ICONS.resume}
                  title="Resume failed work"
                  shortcut="Shift+R"
                  desc="Reruns failed subjects."
                  disabled={resumeDisabled}
                  disabledReason={resumeDisabledReason}
                  quietReason={
                    pendingReason === null &&
                    retryableRun === null &&
                    runtimeKnown
                  }
                  pending={
                    launchOrigin?.kind === 'resume'
                      ? (pendingLabel ?? undefined)
                      : undefined
                  }
                  action={
                    <Btn
                      t={t}
                      label="Resume"
                      disabled={resumeDisabled}
                      onClick={() => setPendingConfirm('resume')}
                    />
                  }
                />
                <ActionCard
                  t={t}
                  icon={ICONS.stop}
                  title="Cancel running"
                  shortcut="C"
                  desc="Stops every active job."
                  disabled={activeRunIds.size === 0}
                  action={
                    <Btn
                      t={t}
                      danger
                      label="Cancel all"
                      disabled={activeRunIds.size === 0}
                      onClick={() => setPendingConfirm('cancel')}
                    />
                  }
                />
                <ActionCard
                  t={t}
                  icon={ICONS.resume}
                  title="Retry canceled"
                  desc="Reruns work a canceled run left unfinished."
                  disabled={!cancelledRun || planPending}
                  quietReason={
                    pendingReason === null &&
                    cancelledRun === null &&
                    runtimeKnown
                  }
                  disabledReason={
                    pendingReason ??
                    (cancelledRun === null
                      ? runtimeKnown
                        ? `Nothing to retry: ${cancelledRetry.reason}`
                        : RUN_HISTORY_NOT_RESTORED
                      : undefined)
                  }
                  pending={
                    launchOrigin?.kind === 'retry-cancelled'
                      ? (pendingLabel ?? undefined)
                      : undefined
                  }
                  action={
                    <Btn
                      t={t}
                      label="Retry canceled..."
                      disabled={!cancelledRun || planPending}
                      onClick={() => setPendingConfirm('retry-cancelled')}
                    />
                  }
                />
                <ActionCard
                  t={t}
                  icon={ICONS.warn}
                  title="Clean up and retry"
                  desc="Deletes incomplete outputs, then retries. Needs live runs allowed."
                  disabled={!retryableRun || !app.safeExecution || planPending}
                  quietReason={
                    pendingReason === null && !retryableRun && runtimeKnown
                  }
                  disabledReason={
                    pendingReason ??
                    (!retryableRun
                      ? runtimeKnown
                        ? `Nothing to clean up: ${recovery.reason}`
                        : RUN_HISTORY_NOT_RESTORED
                      : !app.safeExecution
                        ? SAFE_EXECUTION_OFF_CLEANUP
                        : undefined)
                  }
                  pending={
                    launchOrigin?.kind === 'clean-retry'
                      ? (pendingLabel ?? undefined)
                      : undefined
                  }
                  action={
                    <Btn
                      t={t}
                      danger
                      label="Clean up and retry..."
                      disabled={
                        !retryableRun || !app.safeExecution || planPending
                      }
                      onClick={() => setPendingConfirm('clean-retry')}
                    />
                  }
                />
                {/* Without an explicit selection the first card already runs
                    the whole cohort, so this card shows only beside one. */}
                {target.mode === 'explicit' && (
                  <ActionCard
                    t={t}
                    icon={ICONS.play}
                    title="Run whole cohort"
                    desc="Runs every stage for all eligible subjects, ignoring the selection."
                    disabled={dirty || cohortEmpty || planPending}
                    disabledReason={
                      dirty
                        ? 'Save the project before starting a run.'
                        : cohortEmpty
                          ? 'Change subject eligibility before starting a run.'
                          : (pendingReason ?? undefined)
                    }
                    action={
                      <Btn
                        t={t}
                        label="Run cohort..."
                        disabled={dirty || cohortEmpty || planPending}
                        onClick={runCohort}
                      />
                    }
                  />
                )}
              </div>

              <Divider t={t} label="Stages" />

              {analysisSubjects.length === 0 ? (
                <Card t={t}>
                  {/* The cohort banner above owns the cause; state only the
                      local consequence here. */}
                  <EmptyState
                    t={t}
                    icon="subjects"
                    message="No eligible subjects to run."
                    action={
                      <Btn
                        t={t}
                        small
                        ghost
                        icon={
                          <Ico
                            d={allSubjectsQcFailed ? ICONS.qc : ICONS.sliders}
                            size={ICON_SIZE.nav}
                          />
                        }
                        label={
                          allSubjectsQcFailed
                            ? 'Open QC review'
                            : 'Open Setup wizard'
                        }
                        onClick={() =>
                          setRoute(allSubjectsQcFailed ? 'qc' : 'wizard')
                        }
                      />
                    }
                  />
                </Card>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      'repeat(auto-fill, minmax(280px, 1fr))',
                    gap: 12,
                  }}
                >
                  {PIPELINE_STEPS_IN_DISPLAY_ORDER.map((meta) => {
                    // A per-subject stage counts the subjects its active
                    // run holds, then the target's selection; a cohort stage
                    // counts the analysis cohort.
                    const runSubjectIds =
                      meta.scope === 'subject'
                        ? stageRunSubjectIds.get(meta.key)
                        : undefined
                    const countScope: CountScope =
                      runSubjectIds !== undefined
                        ? 'run'
                        : meta.scope === 'cohort' || target.mode === 'all'
                          ? 'cohort'
                          : 'selected'
                    const stageSubjects =
                      countScope === 'cohort'
                        ? statusAnalysisSubjects
                        : statusAnalysisSubjects.filter((subject) =>
                            runSubjectIds !== undefined
                              ? runSubjectIds.has(subject.id)
                              : target.mode === 'explicit' &&
                                target.subjectIds.includes(subject.id),
                          )
                    const off = !cfg.steps[meta.key]?.enabled
                    // Reconstruction waits for each prepared crop's
                    // approval in Input QC; name those subjects, and block
                    // Run when no subject in scope could start.
                    const cropWaiting =
                      meta.key === 'recon' && cropsWaiting
                        ? stageSubjects.filter(
                            (subject) =>
                              subject.stepStates?.brainfov === 'done' &&
                              cropsWaiting.has(subject.id),
                          )
                        : []
                    const dependencyReason = blockedByStep.get(meta.key)
                    const cropReason =
                      cropWaiting.length > 0 &&
                      (dependencyReason !== undefined ||
                        cropWaiting.length === stageSubjects.length)
                        ? cropApprovalReason(cropWaiting.map((s) => s.id))
                        : null
                    const stageBlocker =
                      cropReason === null
                        ? dependencyReason
                        : dependencyReason === undefined
                          ? cropReason
                          : `${dependencyReason} ${cropReason}`
                    const logRunId = newestStageRunId(
                      runtime.runs,
                      runtime.jobs,
                      meta.key,
                    )
                    return (
                      <StageCard
                        key={meta.key}
                        t={t}
                        stepKey={meta.key}
                        unitReuse={stageUnitReuse(runtime.jobs, meta.key)}
                        name={meta.name}
                        advances={
                          meta.advances === null
                            ? []
                            : Array.isArray(meta.advances)
                              ? meta.advances
                              : [meta.advances]
                        }
                        outputs={meta.outputs}
                        subjects={stageSubjects}
                        coverageSubjects={
                          meta.scope === 'cohort'
                            ? discoveredAnalysisSubjects
                            : undefined
                        }
                        liveFinished={liveFinished}
                        scheduled={scheduled}
                        scheduledRunId={scheduledRunId}
                        hasResults={detectedResultStages.has(meta.key)}
                        currency={stageCurrency[meta.key]}
                        analysisCohortChange={analysisCohortChange}
                        dirty={dirty}
                        off={off}
                        blocked={
                          off
                            ? `Turn on ${meta.name} in the project configuration.`
                            : (pendingReason ?? stageBlocker)
                        }
                        outcome={
                          stageOutcome?.stepKey === meta.key
                            ? stageOutcome.message
                            : undefined
                        }
                        outcomeTone={stageOutcomeTone}
                        outcomeLive={!stageOutcomeOnPage}
                        pending={
                          launchOrigin?.kind === 'stage' &&
                          launchOrigin.stepKey === meta.key
                            ? (pendingLabel ?? undefined)
                            : undefined
                        }
                        remedy={
                          cropReason !== null && pendingReason === null ? (
                            <Row>
                              <Btn
                                t={t}
                                small
                                ghost
                                label="Open Input QC"
                                icon={<Ico d={ICONS.qc} size={ICON_SIZE.nav} />}
                                onClick={() => setRoute('inputQc')}
                              />
                            </Row>
                          ) : assetRebuild && rebuildStages.has(meta.key) ? (
                            <Stack gap={6}>
                              <Row>
                                <Btn
                                  t={t}
                                  small
                                  label={
                                    rebuildRunning
                                      ? 'Rebuilding assets...'
                                      : 'Rebuild assets...'
                                  }
                                  icon={
                                    <Ico d={ICONS.play} size={ICON_SIZE.nav} />
                                  }
                                  disabled={
                                    install.running !== null || planPending
                                  }
                                  {...(rebuildRunning
                                    ? {}
                                    : {
                                        ariaLabel: `Rebuild assets for ${meta.name}`,
                                      })}
                                  title="Rebuild the scientific assets from the verified files on this machine."
                                  onClick={() => {
                                    setRebuildOrigin(meta.key)
                                    setPendingConfirm('asset-rebuild')
                                  }}
                                />
                              </Row>
                              {rebuildOrigin === meta.key && rebuildState && (
                                <EnvInstallView
                                  t={t}
                                  label={assetRebuild.check.label}
                                  state={rebuildState}
                                  rebuild
                                />
                              )}
                            </Stack>
                          ) : undefined
                        }
                        scope={meta.scope}
                        countScope={countScope}
                        open={openStages[meta.key] ?? false}
                        onToggle={() => toggleStage(meta.key)}
                        onRun={() => {
                          setAcknowledgeQcScope(false)
                          setAcknowledgeMemoryAdvisory(false)
                          setPendingStage(meta.key)
                        }}
                        onViewResults={() => {
                          setResultsStage(meta.key)
                          setRoute('results')
                        }}
                        viewLogTitle={
                          logRunId === null
                            ? `Opens Logs on its default run; ${meta.name} has no job in any restored run.`
                            : `Opens Logs on the newest run in which ${meta.name} has a job.`
                        }
                        onViewLog={() => openRunLogs(logRunId, meta.key)}
                      />
                    )
                  })}
                </div>
              )}

              <Divider t={t} label="In flight" />

              {/* Announce only job entry, removal, and status changes, through
                  the offscreen live region below. The visible list stays out
                  of the live region so it is never re-read wholesale, and the
                  per-second elapsed clock stays hidden from assistive
                  technology. */}
              <Card t={t}>
                {/* Position the wrapper so the offscreen announcer is laid out
                    inside this scrolling column. An absolutely positioned
                    element with no positioned ancestor is placed against the
                    document at its scrolled-away offset and extends the page. */}
                <div style={{ position: 'relative' }}>
                  <span
                    data-testid="in-flight-announcement"
                    aria-live="polite"
                    aria-atomic="true"
                    style={OFFSCREEN_ANNOUNCEMENT}
                  >
                    {jobAnnouncement}
                  </span>
                </div>
                <div>
                  {jobs.length === 0 && scheduledNodes.length === 0 ? (
                    <Stack gap={4}>
                      <span
                        style={{
                          fontFamily: FONTS.sans,
                          fontSize: 12,
                          color: t.dim,
                        }}
                      >
                        {inFlightEmptyText(activeRunIds.size)}
                      </span>
                      <Hint t={t}>
                        Launched stages appear here while they run. A dry run
                        writes its commands to the Logs tab without creating a
                        long-lived job.
                      </Hint>
                    </Stack>
                  ) : (
                    <Stack gap={8}>
                      {jobs.map((j) => (
                        <Row key={j.id} gap={10} justify="space-between">
                          <Row gap={8}>
                            {/* A subject ID is code-like; the cohort
                                fallback is a word. */}
                            <span
                              style={{
                                fontFamily:
                                  j.subjectId === null
                                    ? FONTS.sans
                                    : FONTS.mono,
                                fontSize: 12,
                                color: t.text,
                              }}
                            >
                              {j.subjectId ?? 'Cohort'}
                            </span>
                            <JobStatusChip
                              t={t}
                              status={j.status}
                              label={STATUS_LABEL[chipStatusOf(j.status)]}
                            />
                            <StateLine t={t} color={t.dim}>
                              {stageName(j.stepKey)}
                            </StateLine>
                          </Row>
                          <Row gap={8}>
                            <span
                              aria-hidden="true"
                              style={{
                                // Elapsed time stays mono; the word does not.
                                fontFamily:
                                  j.startedAt === null
                                    ? FONTS.sans
                                    : FONTS.mono,
                                fontSize: 12,
                                color: t.dim,
                              }}
                            >
                              {/* The chip names the state of a job that has
                                  not started; this column states only that
                                  it has no elapsed time yet. */}
                              {j.startedAt === null
                                ? 'Not started'
                                : fmtElapsed(now - j.startedAt)}
                            </span>
                            {j.startedAt !== null && (
                              <Btn
                                t={t}
                                danger
                                small
                                label="Stop"
                                onClick={() => stopJob(j.runId)}
                              />
                            )}
                          </Row>
                        </Row>
                      ))}
                      {scheduledNodes.map((node) => (
                        <Row
                          key={`plan:${node.nodeId}`}
                          gap={10}
                          justify="space-between"
                        >
                          <Row gap={8}>
                            {/* A subject ID is code-like; the cohort
                                fallback is a word. */}
                            <span
                              style={{
                                fontFamily:
                                  node.subjectId === null
                                    ? FONTS.sans
                                    : FONTS.mono,
                                fontSize: 12,
                                color: t.text,
                              }}
                            >
                              {node.subjectId ?? 'Cohort'}
                            </span>
                            <JobStatusChip
                              t={t}
                              status="planned"
                              label={STATUS_LABEL.planned}
                            />
                            <StateLine t={t} color={t.dim}>
                              {stageName(node.stepKey)}
                            </StateLine>
                          </Row>
                          {/* A planned node has no job yet, so it has no
                              elapsed time and nothing to stop. */}
                          <StateLine
                            t={t}
                            size={12}
                            color={t.dim}
                            aria-hidden="true"
                          >
                            Not started
                          </StateLine>
                        </Row>
                      ))}
                    </Stack>
                  )}
                </div>
              </Card>
            </>
          )}
        </Stack>
      </div>
      {pendingConfirm === 'workflow' && (
        <ConfirmDialog
          t={t}
          title="Review the run plan?"
          message={
            <>
              {safeExecutionNotice && (
                <SafeExecutionNotice
                  t={t}
                  state={safeExecutionNotice}
                  onTurnOn={() => app.setSafeExecution(true)}
                  onSave={() => app.saveProject()}
                />
              )}
              <p style={{ margin: '0 0 10px' }}>
                {workflowScopeSentence(
                  cfg.steps,
                  target,
                  analysisSubjects.length,
                )}{' '}
                {reviewNextSentence(cfg.runtime.dryRun, app.safeExecution)}
              </p>
              {needsQcAcknowledgement && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minHeight: 24,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={acknowledgeQcScope}
                    onChange={(event) =>
                      setAcknowledgeQcScope(event.currentTarget.checked)
                    }
                  />
                  {QC_SCOPE_ACKNOWLEDGEMENT_LABEL}
                </label>
              )}
              {needsQcAcknowledgement && (
                <Hint t={t} style={{ marginTop: 4 }}>
                  {qcAcknowledgementReason}
                </Hint>
              )}
              {needsMemoryAcknowledgement && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minHeight: 24,
                    marginTop: 10,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={acknowledgeMemoryAdvisory}
                    onChange={(event) =>
                      setAcknowledgeMemoryAdvisory(event.currentTarget.checked)
                    }
                  />
                  {memoryAcknowledgement}
                </label>
              )}
              {needsMemoryAcknowledgement && (
                <Hint t={t} style={{ marginTop: 4 }}>
                  {memoryAcknowledgementReason}
                </Hint>
              )}
            </>
          }
          onDismiss={() => setPendingConfirm(null)}
          actions={[
            {
              label: 'Cancel',
              initialFocus: true,
              onSelect: () => setPendingConfirm(null),
            },
            {
              label: REVIEW_PLAN_LABEL,
              tone: 'primary',
              disabled:
                (needsQcAcknowledgement && !acknowledgeQcScope) ||
                (needsMemoryAcknowledgement && !acknowledgeMemoryAdvisory),
              ...((needsQcAcknowledgement && !acknowledgeQcScope) ||
              (needsMemoryAcknowledgement && !acknowledgeMemoryAdvisory)
                ? { title: ACKNOWLEDGEMENT_NEEDED_TITLE }
                : {}),
              onSelect: () => {
                setPendingConfirm(null)
                runAll(null)
              },
            },
          ]}
        />
      )}
      {pendingStage && (
        <ConfirmDialog
          t={t}
          title={`Confirm the ${stageName(pendingStage)} launch`}
          message={
            <>
              {safeExecutionNotice && (
                <SafeExecutionNotice
                  t={t}
                  state={safeExecutionNotice}
                  onTurnOn={() => app.setSafeExecution(true)}
                  onSave={() => app.saveProject()}
                />
              )}
              <p style={{ margin: '0 0 10px' }}>
                {stageScopeSentence(
                  pendingStage,
                  target,
                  analysisSubjects.length,
                )}
              </p>
              <p style={{ margin: 0 }}>
                {reviewNextSentence(cfg.runtime.dryRun, app.safeExecution)}
              </p>
              {stageNeedsQcAcknowledgement && (
                <label style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <input
                    type="checkbox"
                    checked={acknowledgeQcScope}
                    onChange={(event) =>
                      setAcknowledgeQcScope(event.currentTarget.checked)
                    }
                  />
                  {QC_SCOPE_ACKNOWLEDGEMENT_LABEL}
                </label>
              )}
              {stageNeedsQcAcknowledgement && (
                <Hint t={t} style={{ marginTop: 4 }}>
                  {qcAcknowledgementReason}
                </Hint>
              )}
              {needsMemoryAcknowledgement && (
                <label style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <input
                    type="checkbox"
                    checked={acknowledgeMemoryAdvisory}
                    onChange={(event) =>
                      setAcknowledgeMemoryAdvisory(event.currentTarget.checked)
                    }
                  />
                  {memoryAcknowledgement}
                </label>
              )}
              {needsMemoryAcknowledgement && (
                <Hint t={t} style={{ marginTop: 4 }}>
                  {memoryAcknowledgementReason}
                </Hint>
              )}
            </>
          }
          onDismiss={() => setPendingStage(null)}
          actions={[
            {
              label: 'Cancel',
              initialFocus: true,
              onSelect: () => setPendingStage(null),
            },
            {
              label: REVIEW_PLAN_LABEL,
              tone: 'primary',
              disabled:
                (stageNeedsQcAcknowledgement && !acknowledgeQcScope) ||
                (needsMemoryAcknowledgement && !acknowledgeMemoryAdvisory),
              onSelect: () => {
                const step = pendingStage
                setPendingStage(null)
                runStage(step)
              },
            },
          ]}
        />
      )}
      {pendingConfirm === 'cancel' && (
        <ConfirmDialog
          t={t}
          title="Confirm cancellation of active runs"
          message={`Cancel jobs requests cancellation for ${activeRunIds.size} active ${activeRunIds.size === 1 ? 'run' : 'runs'}. Cancellation is complete only once each job acknowledges it.`}
          onDismiss={() => setPendingConfirm(null)}
          actions={[
            {
              label: 'Keep running',
              initialFocus: true,
              onSelect: () => setPendingConfirm(null),
            },
            {
              label: 'Cancel jobs',
              tone: 'danger',
              onSelect: () => {
                setPendingConfirm(null)
                cancelRunning()
              },
            },
          ]}
        />
      )}
      {pendingConfirm === 'retry-cancelled' && cancelledRun && (
        <ConfirmDialog
          t={t}
          title="Confirm retrying canceled work"
          message={
            // A retry plans like every other launch, so it says the same
            // about Allow live runs and the review that follows.
            <>
              {safeExecutionNotice && (
                <SafeExecutionNotice
                  t={t}
                  state={safeExecutionNotice}
                  onTurnOn={() => app.setSafeExecution(true)}
                  onSave={() => app.saveProject()}
                />
              )}
              <p style={{ margin: '0 0 10px' }}>
                Only canceled outstanding jobs from the{' '}
                {snapshotRunLabel(cancelledRun)} are retried. Successful jobs
                stay skipped.
              </p>
              <p style={{ margin: 0 }}>
                {reviewNextSentence(cfg.runtime.dryRun, app.safeExecution)}
              </p>
            </>
          }
          onDismiss={() => setPendingConfirm(null)}
          actions={[
            {
              label: 'Stay canceled',
              initialFocus: true,
              onSelect: () => setPendingConfirm(null),
            },
            {
              label: RETRY_CANCELED_NODES_LABEL,
              tone: 'primary',
              onSelect: () => {
                setPendingConfirm(null)
                retryCancelled()
              },
            },
          ]}
        />
      )}
      {pendingConfirm === 'resume' && retryableRun && (
        <ConfirmDialog
          t={t}
          title="Confirm resuming the run"
          message={
            <>
              {safeExecutionNotice && (
                <SafeExecutionNotice
                  t={t}
                  state={safeExecutionNotice}
                  onTurnOn={() => app.setSafeExecution(true)}
                  onSave={() => app.saveProject()}
                />
              )}
              <p style={{ margin: '0 0 10px' }}>
                Resume runs the outstanding jobs from the{' '}
                {snapshotRunLabel(retryableRun)}. Successful jobs stay skipped.
              </p>
              <p style={{ margin: 0 }}>
                {reviewNextSentence(cfg.runtime.dryRun, app.safeExecution)}
              </p>
            </>
          }
          onDismiss={() => setPendingConfirm(null)}
          actions={[
            {
              label: 'Cancel',
              initialFocus: true,
              onSelect: () => setPendingConfirm(null),
            },
            {
              label: REVIEW_PLAN_LABEL,
              tone: 'primary',
              onSelect: () => {
                setPendingConfirm(null)
                runAll(retryableRun.runId)
              },
            },
          ]}
        />
      )}
      {pendingConfirm === 'clean-retry' && retryableRun && (
        <ConfirmDialog
          t={t}
          title="Confirm deleting incomplete outputs before retrying"
          message={`Only backend-identified incomplete outputs for the ${snapshotRunLabel(retryableRun)} are removed, and then outstanding jobs are retried. Completed outputs are preserved. ${
            app.safeExecution
              ? 'Approving the plan grants one-use cleanup authorization.'
              : 'Once Allow live runs is on, approving the plan grants one-use cleanup authorization.'
          }`}
          onDismiss={() => setPendingConfirm(null)}
          actions={[
            {
              label: 'Keep outputs',
              initialFocus: true,
              onSelect: () => setPendingConfirm(null),
            },
            {
              label: 'Delete incomplete and retry',
              tone: 'danger',
              disabled: !app.safeExecution,
              onSelect: () => {
                setPendingConfirm(null)
                cleanIncompleteRetry()
              },
            },
          ]}
        />
      )}
      {pendingConfirm === 'asset-rebuild' && assetRebuild && (
        <ConfirmDialog
          t={t}
          title={`Confirm the rebuild of ${assetRebuild.check.label}`}
          message={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span>
                This rebuild runs on this host once authorized. It re-creates
                the scientific assets from the verified files already on this
                machine, checks every file against the reviewed SHA-256, and
                downloads nothing.
              </span>
              {assetRebuild.restores.length > 0 && (
                <span>
                  Restores{' '}
                  {assetRebuild.restores.map((check) => check.label).join(', ')}
                  .
                </span>
              )}
              {rebuildGate && (
                <GateNotice
                  t={t}
                  gate={rebuildGate}
                  onEnableSafeExecution={() => app.setSafeExecution(true)}
                  onSave={() => app.saveProject()}
                />
              )}
              {assetRebuild.check.recommendedCmd && (
                <Code t={t} value={assetRebuild.check.recommendedCmd} />
              )}
            </div>
          }
          onDismiss={() => setPendingConfirm(null)}
          actions={[
            {
              label: 'Cancel',
              initialFocus: true,
              onSelect: () => setPendingConfirm(null),
            },
            {
              label: 'Authorize rebuild',
              tone: 'primary',
              disabled: rebuildGate !== null || install.running !== null,
              onSelect: () => {
                setPendingConfirm(null)
                install.start(assetRebuild.check)
              },
            },
          ]}
        />
      )}
    </Page>
  )
}

function stageName(key: StepKey): string {
  const meta = PIPELINE_STEPS.find((m) => m.key === key)
  return meta ? meta.name : key
}

/** Name the plan in progress for the reason other controls give. */
function launchOriginName(origin: LaunchOrigin): string {
  switch (origin.kind) {
    case 'stage':
      return stageName(origin.stepKey)
    case 'workflow':
      return 'the workflow'
    case 'resume':
      return 'the resume'
    case 'retry-cancelled':
      return 'the retry'
    case 'clean-retry':
      return 'the cleanup and retry'
  }
}

/**
 * Map every job status to a renderable {@link ChipStatus}, even though the live
 * list normally contains only queued and running work.
 */
function chipStatusOf(s: Job['status']): ChipStatus {
  switch (s) {
    case 'planned':
      return 'planned'
    case 'waiting':
      return 'waiting'
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'cancelling':
      return 'cancelling'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'blocked':
      return 'blocked'
    case 'withheld':
      return 'withheld'
    case 'interrupted':
      return 'interrupted'
    case 'stale':
      return 'stale'
    case 'persistence-error':
      return 'failed'
    case 'unknown':
      return 'warn'
  }
}

function ActionCard({
  t,
  icon,
  title,
  shortcut,
  desc,
  disabled,
  disabledReason,
  quietReason = false,
  pending,
  action,
}: {
  t: Theme
  icon: ReactNode
  title: string
  /** The keyboard shortcut, named in the action's tooltip. */
  shortcut?: string
  desc: string
  disabled: boolean
  disabledReason?: string | undefined
  /**
   * Whether the reason only says there is nothing to act on. Such a reason
   * stays in the tooltip; a reason the operator can resolve also shows.
   */
  quietReason?: boolean
  /** The progress of the plan this card started, shown in place of a reason. */
  pending?: string | undefined
  action: ReactNode
}): ReactNode {
  const reason = disabled ? disabledReason : undefined
  const tooltip = [reason, shortcut ? `Shortcut: ${shortcut}.` : undefined]
    .filter(Boolean)
    .join(' ')
  return (
    <Card t={t} style={{ height: '100%' }}>
      <Stack gap={8} style={{ height: '100%' }}>
        <Row gap={8}>
          <Ico d={icon} stroke={t.accent} />
          <span
            style={{
              fontFamily: FONTS.sans,
              fontSize: 13,
              fontWeight: 700,
              color: t.text,
            }}
          >
            {title}
          </span>
        </Row>
        <span style={{ fontFamily: FONTS.sans, fontSize: 11.5, color: t.dim }}>
          {desc}
        </span>
        {/* Pin every action to the card's bottom edge, with any progress or
            reason above it. */}
        <Stack gap={6} style={{ marginTop: 'auto' }}>
          {/* Repeat the progress beside the control that started it, so the
              page banner the operator may have scrolled past is not the only
              place it shows. The page banner announces it; this repeat is
              silent. */}
          {pending && <LoadingState t={t} label={pending} live={false} />}
          {/* Screen-level causes (unsaved config, empty cohort) are stated
              once in the banners above; show only card-specific reasons. */}
          {!pending && reason && !quietReason && (
            <span
              style={{
                fontFamily: FONTS.sans,
                fontSize: 10.5,
                color: t.dimText,
              }}
            >
              {reason}
            </span>
          )}
          <span title={tooltip || undefined} style={{ display: 'flex' }}>
            {action}
          </span>
        </Stack>
      </Stack>
    </Card>
  )
}

/**
 * State in a launch dialog that a live run cannot be authorized yet, and
 * offer the Allow live runs switch while it is off. Turning it on leaves the
 * project unsaved on purpose, so the notice then asks for the save.
 */
export function SafeExecutionNotice({
  t,
  state,
  onTurnOn,
  onSave,
}: {
  t: Theme
  state: SafeExecutionNoticeState
  onTurnOn: () => void
  onSave: () => Promise<unknown>
}): ReactNode {
  // The toolbar Save sits behind this modal, so the notice offers the save it
  // asks for; otherwise the operator must cancel, save, and relaunch.
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      await onSave()
    } catch (cause) {
      setSaveError(
        errorMessageText(
          cause instanceof Error ? cause.message : String(cause),
        ),
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '8px 10px',
        margin: '0 0 10px',
        borderRadius: 5,
        background: t.warningSoft,
        border: `1px solid color-mix(in srgb, ${t.warning} 27%, transparent)`,
      }}
    >
      <NoticeGlyph t={t} tone="warn" />
      <Stack gap={6} style={{ minWidth: 0 }}>
        <span style={{ fontFamily: FONTS.sans, fontSize: 12, color: t.text }}>
          {state === 'off'
            ? 'Allow live runs is off for this session. Turn it on, then save the project to authorize and run live.'
            : 'Allow live runs is on for this session. Save the project to run live.'}
        </span>
        {state === 'off' && (
          <Row>
            <Btn
              t={t}
              small
              secondary
              label="Allow live runs"
              onClick={onTurnOn}
            />
          </Row>
        )}
        {state === 'unsaved' && (
          <Row>
            <Btn
              t={t}
              small
              secondary
              label={saving ? 'Saving...' : 'Save project'}
              disabled={saving}
              onClick={() => void save()}
            />
          </Row>
        )}
        {saveError && (
          <span
            role="alert"
            style={{ fontFamily: FONTS.sans, fontSize: 12, color: t.failed }}
          >
            {saveError}
          </span>
        )}
      </Stack>
    </div>
  )
}

/**
 * Return what the newest finished job of a stage computed and reused, when it
 * recorded per-subject reuse.
 */
function stageUnitReuse(
  jobs: readonly Job[],
  stepKey: StepKey,
): UnitReuseSummary | null {
  let newest: Job | null = null
  for (const job of jobs) {
    if (job.stepKey !== stepKey || job.status !== 'done' || !job.unitReuse) {
      continue
    }
    if (!newest || (job.endedAt ?? 0) > (newest.endedAt ?? 0)) newest = job
  }
  return newest?.unitReuse ?? null
}

/**
 * Show aggregate status, declared outputs, matrix consumers, controls, and an
 * explicit blocker on each stage card.
 */
function StageCard({
  t,
  stepKey,
  name,
  advances,
  outputs,
  subjects,
  coverageSubjects,
  liveFinished,
  scheduled,
  scheduledRunId,
  hasResults,
  currency,
  analysisCohortChange,
  dirty,
  off,
  blocked,
  outcome,
  outcomeTone = 'warning',
  outcomeLive = true,
  pending,
  remedy,
  scope,
  countScope = 'cohort',
  open,
  onToggle,
  onRun,
  onViewResults,
  onViewLog,
  viewLogTitle,
  unitReuse,
}: {
  t: Theme
  stepKey: StepKey
  name: string
  advances: readonly MatrixStepKey[]
  outputs: readonly ArtifactRef[]
  subjects: Subject[]
  /**
   * The same subjects as discovered, before the live run's jobs overlay them,
   * for the output a queued cohort job has not replaced yet.
   */
  coverageSubjects?: Subject[] | undefined
  /** The {@link stageJobKey} of each stage job the live run finished. */
  liveFinished: ReadonlySet<string>
  /** The {@link stageJobKey} of each node the active run has no job for yet. */
  scheduled: ReadonlySet<string>
  /** The active run whose nodes {@link scheduled} holds, or null. */
  scheduledRunId: string | null
  hasResults: boolean
  /** Receipt currency judged the way the planner judges reuse. */
  currency?: ResultStageCurrency | undefined
  /** How the analysis cohort changed since the newest run, or null. */
  analysisCohortChange?: ResultAnalysisCohortChange | null
  dirty: boolean
  /**
   * Whether the project configuration turns the stage off. No run includes
   * it then, so the card states it as off where it would say not run.
   */
  off: boolean
  blocked?: string | undefined
  outcome?: string | undefined
  /** Neutral for a plan with no work; amber for a refusal or blocker. */
  outcomeTone?: 'info' | 'warning'
  /**
   * Whether the outcome is a live region. False when the page line already
   * announces the same outcome, so a screen reader hears it once.
   */
  outcomeLive?: boolean
  pending?: string | undefined
  /** The action that clears the blocker, shown under its reason. */
  remedy?: ReactNode
  scope: StepScope
  /** Where the counted subjects come from; see {@link CountScope}. */
  countScope?: CountScope
  open: boolean
  onToggle: () => void
  onRun: () => void
  onViewResults: () => void
  onViewLog: () => void
  /** What View log opens, stated as a fact for its tooltip. */
  viewLogTitle: string
  /** What the stage's newest finished job computed and reused, if recorded. */
  unitReuse?: UnitReuseSummary | null | undefined
}): ReactNode {
  const tracks =
    advances.length > 0 ||
    subjects.some((subject) => subject.stepStates?.[stepKey] !== undefined)
  const agg = tracks
    ? aggregate(subjects, stepKey, scope, currency, liveFinished, scheduled)
    : null
  // A queued or planned cohort job has not replaced the stage's output yet,
  // so its card still states the output found before the run.
  const coverage =
    agg &&
    coverageSubjects &&
    scope === 'cohort' &&
    (agg.queued > 0 || agg.planned > 0)
      ? aggregate(coverageSubjects, stepKey, scope, currency)
      : null
  // Subjects with no done, out-of-date, running, queued, or ended state have
  // not run this stage; after the cohort grows they are the newly added
  // subjects.
  const notRun = agg
    ? agg.total -
      agg.done -
      agg.outdated -
      agg.running -
      agg.queued -
      agg.planned -
      agg.failed -
      agg.blocked -
      UNFINISHED_STATES.reduce((sum, state) => sum + agg[state], 0)
    : 0
  // State each distinct failure reason once, as a sentence.
  const failTags =
    tracks && (agg?.failed ?? 0) > 0 ? failureTags(subjects, advances) : []
  const reruns = tracks ? rerunLines(subjects, advances) : []
  // A stage that is off never runs, so "Not run yet" would read as work still
  // to come; the card says it is off instead and counts only the output it
  // has. A stage that ran for some subjects counts the rest as not run.
  const subjectNotRunLabel =
    agg && scope === 'subject' && notRun > 0 && (off || notRun >= agg.total)
      ? off
        ? STAGE_OFF_LABEL
        : 'Not run yet'
      : null
  const countParts: CountPart[] = agg
    ? [
        { status: 'done', n: agg.done },
        ...(agg.outdated > 0
          ? [
              {
                status: 'outdated' as const,
                n: agg.outdated,
                title:
                  scope === 'cohort'
                    ? `The output of ${name} for ${agg.outdated === 1 ? 'this subject' : 'these subjects'} no longer matches its current inputs, so the next run repeats it.`
                    : `The next run repeats ${name} for ${agg.outdated === 1 ? 'this subject because its provenance receipt no longer matches' : 'these subjects because their provenance receipts no longer match'} the current inputs.`,
              },
            ]
          : []),
        ...(notRun > 0 && notRun < agg.total
          ? [
              {
                status: 'pending' as const,
                n: notRun,
                label: 'not run',
                title: `${name} has not run for ${notRun} of ${countScopePhrase(agg.total, countScope)}.`,
              },
            ]
          : []),
        { status: 'running', n: agg.running },
        ...(agg.queued > 0
          ? [{ status: 'queued' as const, n: agg.queued }]
          : []),
        ...(agg.planned > 0
          ? [{ status: 'planned' as const, n: agg.planned }]
          : []),
        {
          status: 'failed',
          n: agg.failed,
          reasons: failTags.length > 0 ? failTags.join(' ') : undefined,
        },
        ...(agg.blocked > 0
          ? [{ status: 'blocked' as const, n: agg.blocked }]
          : []),
        ...UNFINISHED_STATES.flatMap((state) =>
          agg[state] > 0 ? [{ status: state, n: agg[state] }] : [],
        ),
      ]
    : []
  // The line states only counts above zero. A stage that is off also states
  // no not-run count, which reads as work still to come.
  const shownCountParts = countParts.filter(
    (part) => part.n > 0 && !(off && part.status === 'pending'),
  )
  // One status line per card: the counts already say "15 not run", and
  // "Done for all 20 subjects" already says "20 done of 20 subjects".
  const cohortStatus = agg && scope === 'cohort' ? cohortJobState(agg) : null
  const countsCoverState =
    cohortStatus === 'pending' && !off && shownCountParts.length > 0
  const stateCoversCounts =
    cohortStatus === 'done' &&
    shownCountParts.every((part) => part.status === 'done')
  // Say why a finished cohort stage is out of date when the only change is
  // the analysis cohort, which no card input shows.
  const cohortCause =
    agg &&
    scope === 'cohort' &&
    agg.outdated > 0 &&
    currency?.cause === 'analysis-cohort'
      ? analysisCohortCause(analysisCohortChange ?? null, 'this stage')
      : null
  const canViewResults =
    hasResults || (agg?.done ?? 0) > 0 || (agg?.outdated ?? 0) > 0
  const frac = agg && agg.total > 0 ? (agg.done / agg.total) * 100 : 0

  const help = STEP_HELP[stepKey]
  const feedsLabels = advances.map((col) => recentSubjectStepLabel(col))
  const producesLabels = outputs.map((o) => o.label)

  // Block Run for unsaved configuration, missing tools, or unavailable
  // upstream inputs. The screen-level banner owns the unsaved-configuration
  // reason; each card states only its own blocker.
  const disabledReason = dirty ? null : (blocked ?? null)
  const isDisabled = dirty || blocked !== undefined

  return (
    <Card t={t} padded={false} style={{ height: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Collapse stage detail by default to keep the grid compact. */}
        <Collapsible
          t={t}
          id={`stage-${stepKey}`}
          open={open}
          onToggle={onToggle}
          header={
            <Row gap={7}>
              <span
                title={STEP_NAME_SPELLED_OUT[stepKey]}
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 13,
                  fontWeight: 700,
                  color: t.text,
                }}
              >
                {name}
              </span>
              <StateLine t={t} size={10} style={{ letterSpacing: 0.2 }}>
                {scope === 'subject' ? 'Subject' : 'Cohort'}
              </StateLine>
            </Row>
          }
        >
          <Stack gap={8} style={{ padding: '0 12px 8px 34px' }}>
            {/* The stage's goal says what its guidance says in other words,
                so the card leads with the guidance alone, which also states
                what an output does not establish. */}
            <span
              style={{ fontFamily: FONTS.sans, fontSize: 11.5, color: t.dim }}
            >
              {help}
            </span>
            {feedsLabels.length > 0 && (
              <Hint t={t}>
                This stage shows in the {feedsLabels.join(', ')} column
                {feedsLabels.length === 1 ? '' : 's'} of the Subjects matrix.
              </Hint>
            )}
            {producesLabels.length > 0 && (
              <Hint t={t}>
                This stage produces these outputs: {producesLabels.join('; ')}.
              </Hint>
            )}
            <Hint t={t}>
              This stage&apos;s parameters are edited on the Pipeline tab.
            </Hint>
          </Stack>
        </Collapsible>

        {/* Keep status and controls in one fixed order. Pin progress and Run to the
            card baseline. */}
        <Stack gap={6} style={{ padding: '4px 12px 12px', flex: 1 }}>
          {agg ? (
            <Row gap={10} wrap>
              {scope === 'cohort' && !countsCoverState && (
                <CohortJobState
                  t={t}
                  agg={agg}
                  coverage={coverage}
                  stageName={name}
                  off={off}
                  scheduledRunId={scheduledRunId}
                />
              )}
              {subjectNotRunLabel && (
                <StateLine
                  t={t}
                  size={11.5}
                  title={
                    off
                      ? stageOffTitle(name)
                      : `${name} has not run for ${notRun} of ${countScopePhrase(agg.total, countScope)}.`
                  }
                >
                  {subjectNotRunLabel}
                </StateLine>
              )}
              {shownCountParts.length > 0 && !stateCoversCounts && (
                <CountLine
                  t={t}
                  parts={shownCountParts}
                  stageName={name}
                  total={agg.total}
                  scope={countScope}
                />
              )}
            </Row>
          ) : (
            <StateLine t={t} size={11.5}>
              Progress for this stage shows in Results.
            </StateLine>
          )}
          {cohortCause && (
            <span
              style={{
                fontFamily: FONTS.sans,
                fontSize: 11.5,
                color: t.textSoft,
              }}
            >
              {cohortCause}
            </span>
          )}
          {agg && agg.failed > 0 && failTags.length > 0 && (
            <span
              style={{ fontFamily: FONTS.sans, fontSize: 11, color: t.failed }}
              title={
                failTags.length > STAGE_FAILURE_REASON_LIMIT
                  ? failTags.join(' ')
                  : undefined
              }
            >
              {failureLine(failTags)}
            </span>
          )}
          {unitReuse && (
            <span
              data-testid="stage-unit-reuse"
              style={{
                fontFamily: FONTS.sans,
                fontSize: 11,
                color: t.textSoft,
                overflowWrap: 'anywhere',
              }}
            >
              {/* The card also shows the stage's current state, and the
                  record is the newest finished job's, so say which run the
                  counts describe. */}
              Last completed run: {unitReuseFact(unitReuse, 'past')}
            </span>
          )}
          {reruns.map((rerun) => (
            <span
              key={rerun.text}
              data-testid="stage-rerun"
              style={{
                fontFamily: FONTS.sans,
                fontSize: 11,
                color: t.textSoft,
                overflowWrap: 'anywhere',
              }}
              title={rerun.detail}
            >
              {rerun.text}
            </span>
          ))}
          {/* Use success green for completion. Reserve blue for active work. */}
          {/* Pin the action row to the card's bottom edge, with any reason
              or progress above it, so the rows of a grid row line up. */}
          <Stack gap={6} style={{ marginTop: 'auto' }}>
            {disabledReason && (
              <span
                style={{
                  fontFamily: FONTS.sans,
                  fontSize: 10.5,
                  color: t.dimText,
                }}
              >
                {disabledReason}
              </span>
            )}
            {remedy}
            {/* Show launch progress where the operator started the run; the
                page line announces it, so this repeat is silent. */}
            {pending && <LoadingState t={t} label={pending} live={false} />}
            {/* Repeat the no-work reason where the operator started the run;
                announce it here only when the page line does not. */}
            {outcome && (
              <div
                {...(outcomeLive ? { role: 'status' } : {})}
                data-tone={outcomeTone}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 6,
                  padding: '6px 8px',
                  borderRadius: 4,
                  background:
                    outcomeTone === 'info' ? t.surface2 : t.warningSoft,
                  border:
                    outcomeTone === 'info'
                      ? `1px solid ${t.borderSoft}`
                      : `1px solid color-mix(in srgb, ${t.warning} 27%, transparent)`,
                }}
              >
                <NoticeGlyph
                  t={t}
                  tone={outcomeTone === 'info' ? 'info' : 'warn'}
                  color={outcomeTone === 'info' ? t.dim : undefined}
                />
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 10.5,
                    color: t.text,
                    minWidth: 0,
                  }}
                >
                  {outcome}
                </span>
              </div>
            )}
            {agg && <Bar t={t} value={frac} color={t.done} />}
            {/* Keep Run as the only launch action. Expose ghost actions only for
                inspection. Run stays outlined: the Run all card holds the
                view's one accent button. */}
            <Row gap={6} wrap>
              <Btn
                t={t}
                small
                label="Run"
                disabled={isDisabled}
                onClick={onRun}
                ariaLabel={`Run ${name}`}
                {...(disabledReason ? { title: disabledReason } : {})}
              />
              {canViewResults && (
                <Btn
                  t={t}
                  small
                  ghost
                  label="View results"
                  icon={<Ico d={ICONS.results} size={ICON_SIZE.nav} />}
                  onClick={onViewResults}
                  ariaLabel={`View results for ${name}`}
                  title={`Open Results focused on ${name}.`}
                />
              )}
              <Btn
                t={t}
                small
                ghost
                label="View log"
                icon={<Ico d={ICONS.logs} size={ICON_SIZE.nav} />}
                onClick={onViewLog}
                ariaLabel={`View log for ${name}`}
                title={viewLogTitle}
              />
            </Row>
          </Stack>
        </Stack>
      </div>
    </Card>
  )
}

/**
 * Describe one cohort-wide stage as a single job. Counting its subjects would
 * make one running ENIGMA QC job read as "48 running".
 */
function CohortJobState({
  t,
  agg,
  coverage,
  stageName,
  off,
  scheduledRunId,
}: {
  t: Theme
  agg: StageAggregate
  /** The stage's output before the live run, while its job is queued. */
  coverage: StageAggregate | null
  stageName: string
  /** Whether the project configuration turns the stage off. */
  off: boolean
  /** The active run that planned the stage without a job yet, or null. */
  scheduledRunId: string | null
}): ReactNode {
  const status = cohortJobState(agg)
  // A cohort stage that has not run for every subject still shows the
  // coverage its detector found on disk. Saying only "Not run yet" next to
  // "48 done of 52" reads as a contradiction, so name what is already there.
  // Output whose receipt the planner would not reuse is out of date, not
  // done: Run all runs the stage again, and a run of only a dependent stage
  // is refused until then. A stage that is off never runs, so it reads as
  // off rather than as not run yet.
  const offPending = off && status === 'pending'
  const label = offPending
    ? STAGE_OFF_LABEL
    : status === 'done'
      ? `Done for all ${agg.total} subjects`
      : status === 'outdated'
        ? 'Out of date'
        : status === 'pending'
          ? (notRunLabel(agg.total - agg.done, agg.total) ?? 'Not run yet')
          : status === 'queued' || status === 'planned'
            ? liveJobLabel(status, coverage)
            : COHORT_JOB_LABEL[status]
  return (
    <StateLine
      t={t}
      size={11.5}
      color={status === 'pending' ? t.dimText : statusColor(t, status)}
      title={
        offPending
          ? stageOffTitle(stageName)
          : status === 'outdated'
            ? `One cohort job: ${stageName} no longer matches its current inputs, so the next run repeats it.`
            : status === 'planned'
              ? `One cohort job: ${stageName} is planned${
                  scheduledRunId === null ? '' : ` in run ${scheduledRunId}`
                } and has no job yet.`
              : `One cohort job: ${stageName} ${COHORT_JOB_TITLE[status]}.`
      }
    >
      {label}
    </StateLine>
  )
}

/** The states a cohort stage card states for its one job. */
type CohortJobStatus =
  | 'running'
  | 'queued'
  | 'planned'
  | 'failed'
  | (typeof UNFINISHED_STATES)[number]
  | 'outdated'
  | 'done'
  | 'blocked'
  | 'pending'

/**
 * Pick the one state a cohort stage card states for its job, the one that
 * most needs the operator first.
 */
function cohortJobState(agg: StageAggregate): CohortJobStatus {
  if (agg.running > 0) return 'running'
  if (agg.queued > 0) return 'queued'
  if (agg.planned > 0) return 'planned'
  if (agg.failed > 0) return 'failed'
  const unfinished = UNFINISHED_STATES.find((state) => agg[state] > 0)
  if (unfinished) return unfinished
  if (agg.outdated > 0) return 'outdated'
  if (agg.total > 0 && agg.done === agg.total) return 'done'
  if (agg.blocked > 0) return 'blocked'
  return 'pending'
}

/** A cohort job's state as its card names it, where a word suffices. */
const COHORT_JOB_LABEL: Record<
  Exclude<
    CohortJobStatus,
    'done' | 'outdated' | 'pending' | 'queued' | 'planned'
  >,
  string
> = {
  running: 'Running for the cohort',
  failed: 'Failed',
  cancelled: 'Canceled',
  interrupted: 'Interrupted',
  stale: 'Status unknown',
  blocked: 'Blocked',
}

/** What a cohort job's tooltip says happened to it. */
const COHORT_JOB_TITLE: Record<
  Exclude<CohortJobStatus, 'outdated' | 'planned'>,
  string
> = {
  running: 'is running',
  queued: 'is queued',
  failed: 'failed',
  cancelled: 'was canceled',
  interrupted: 'was interrupted',
  stale: 'has an unknown status',
  done: 'is done',
  blocked: 'is blocked',
  pending: 'is pending',
}

/**
 * State a queued cohort job, or a node the active run planned without a job
 * yet, with the output the stage had before the run, which the run has not
 * replaced yet.
 *
 * @param status - Whether the job is queued or the node only planned.
 * @param coverage - The stage's counts before the live run, or null.
 * @example
 * liveJobLabel('queued', coverage) // 'Queued; out of date for 3 of 3 subjects'
 * liveJobLabel('planned', coverage) // 'Planned; out of date for 3 of 3 subjects'
 */
function liveJobLabel(
  status: 'queued' | 'planned',
  coverage: StageAggregate | null,
): string {
  const state = status === 'queued' ? 'Queued' : 'Planned'
  if (!coverage || coverage.total === 0) return `${state} for the cohort`
  const { total } = coverage
  const noun = total === 1 ? 'subject' : 'subjects'
  if (coverage.outdated > 0) {
    return `${state}; out of date for ${coverage.outdated} of ${total} ${noun}`
  }
  if (coverage.done === total) return `${state}; done for all ${total} ${noun}`
  if (coverage.done > 0) {
    return `${state}; done for ${coverage.done} of ${total} ${noun}`
  }
  return `${state} for the cohort`
}

/**
 * State which prepared crops Reconstruction waits for, as the planner's
 * per-subject blocker does, with the place that clears it.
 *
 * @param subjectIds - The subjects in scope whose crop is not approved.
 * @returns The reason for the Reconstruction card.
 * @example
 * cropApprovalReason(['sub-001']) // 'The Brain FOV crop of sub-001 ...'
 */
function cropApprovalReason(subjectIds: readonly string[]): string {
  return subjectIds.length === 1
    ? `The Brain FOV crop of ${subjectIds[0]} waits for approval in Input QC.`
    : `The Brain FOV crops of ${subjectIds.length} subjects wait for approval in Input QC.`
}

/**
 * Name the subjects a cohort stage's job has not run for.
 *
 * @param notRun - The counted subjects with no run of the stage.
 * @returns The label, or null when the stage covers every subject.
 * @example
 * notRunLabel(28, 82) // 'Not run for 28 of 82 subjects'
 */
function notRunLabel(notRun: number, total: number): string | null {
  if (notRun <= 0) return null
  if (notRun >= total) return 'Not run yet'
  return `Not run for ${notRun} of ${countScopePhrase(total, 'cohort')}`
}

/**
 * The status of a stage card whose stage is off, in the words the plan
 * review uses for the nodes of such a stage.
 */
const STAGE_OFF_LABEL = STAGE_OFF_SKIP_REASON.replace(/\.$/, '')

/**
 * State why a stage that is off has no run, for its card's status tooltip.
 *
 * @example
 * stageOffTitle('Optional defacing')
 * // 'Optional defacing is off in the project configuration, so no run
 * //   includes it.'
 */
function stageOffTitle(stageName: string): string {
  return `${stageName} is off in the project configuration, so no run includes it.`
}

/**
 * State a stage-card count as a fact about its subjects, or nothing for a
 * zero count, which the count itself already states.
 *
 * @param status - The state the count covers.
 * @param n - The subjects in that state.
 * @returns The tooltip, or null for zero.
 * @example
 * countTitle('failed', 6, 'Reconstruction')
 * // '6 subjects failed in Reconstruction.'
 */
function countTitle(
  status: CellState,
  n: number,
  stageName: string,
): string | null {
  if (n === 0) return null
  const one = n === 1
  const state =
    status === 'failed'
      ? 'failed'
      : status === 'cancelled' || status === 'interrupted'
        ? `${one ? 'was' : 'were'} ${cellStateLabel(status)}`
        : status === 'stale'
          ? `${one ? 'has' : 'have'} an unknown status`
          : `${one ? 'is' : 'are'} ${cellStateLabel(status)}`
  return `${n} ${one ? 'subject' : 'subjects'} ${state} in ${stageName}.`
}

/**
 * Pair a stage count with its state's name and color, as the Subjects matrix
 * names the state. A zero count is dimmed and has no tooltip; a failed count's
 * tooltip adds the failure reasons. {@link CountLine} states what it counts.
 */
function Count({
  t,
  status,
  n,
  stageName,
  reasons,
  label,
  title: titleOverride,
}: {
  t: Theme
  status: CellState
  n: number
  stageName: string
  /** The failed subjects' distinct reasons, as sentences. */
  reasons?: string | undefined
  /** The count's name where the state's own name does not fit it. */
  label?: string | undefined
  /** The tooltip where the state's own tooltip does not fit the count. */
  title?: string | undefined
}): ReactNode {
  const title =
    n === 0 ? null : (titleOverride ?? countTitle(status, n, stageName))
  return (
    <StateLine
      t={t}
      size={11.5}
      color={n === 0 ? t.dimText : statusColor(t, status)}
      {...(title
        ? {
            title:
              status === 'failed' && reasons ? `${title} ${reasons}` : title,
          }
        : {})}
    >
      {`${n} ${label ?? cellStateLabel(status)}`}
    </StateLine>
  )
}

/** One count of a stage card's count line. */
interface CountPart {
  status: CellState
  n: number
  reasons?: string | undefined
  label?: string | undefined
  title?: string | undefined
}

/**
 * State a stage card's counts as one line with one named denominator, such
 * as "6 done, 0 running, 1 failed of the 7 selected". Every subject the card
 * counts is in the denominator, so a grown cohort shows the subjects the
 * stage has not covered yet.
 */
function CountLine({
  t,
  parts,
  stageName,
  total,
  scope,
}: {
  t: Theme
  parts: readonly CountPart[]
  stageName: string
  total: number
  scope: CountScope
}): ReactNode {
  return (
    <StateLine t={t} size={11.5} data-stage-counts="">
      {parts.map((part, index) => (
        <Fragment key={part.status}>
          {index > 0 && ', '}
          <Count
            t={t}
            status={part.status}
            n={part.n}
            stageName={stageName}
            reasons={part.reasons}
            label={part.label}
            title={part.title}
          />
        </Fragment>
      ))}
      {` of ${countScopePhrase(total, scope)}`}
    </StateLine>
  )
}
