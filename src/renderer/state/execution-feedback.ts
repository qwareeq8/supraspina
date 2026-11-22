import type { WorkflowResult, WorkflowTarget } from '../../shared/contract'
import type { ProjectConfig } from '../../shared/project-schema'
import { REVIEW_AGAIN_ACTION, isPlanStaleError } from '../../shared/rpc-errors'
import { PIPELINE_STEPS, pipelineStep, type StepKey } from '../../shared/steps'
import type { Job, JobStatus, Subject } from '../../shared/types'
import { runSummaryText } from './terminal-reason'

/** One renderer-owned execution failure with a typed recovery action. */
export interface ExecutionFailure {
  error: Error
  reviewAgain: {
    label: string
    run: () => void
  } | null
}

type FeedbackSetter<T> = (value: T | null) => void

/**
 * A workflow action the operator canceled in the plan review or the recovery
 * dialog, including the automatic cancel when the project changes under an
 * open dialog. Canceling is a normal choice, not a failure.
 *
 * Only the renderer throws it and it never crosses the context bridge, so
 * `instanceof` identifies it reliably.
 */
export class ExecutionCanceled extends Error {
  override name = 'ExecutionCanceled'
}

/** Return whether a rejection is an operator cancellation. */
export function isExecutionCanceled(
  cause: unknown,
): cause is ExecutionCanceled {
  return cause instanceof ExecutionCanceled
}

/** The successful blocker action rendered as an execution control. */
export const NORMALIZE_RECONSTRUCTION_COHORT_ACTION =
  'normalize-reconstruction-cohort'

/** The blocker action that sends the operator to the Registry screen. */
export const OPEN_REGISTRY_ACTION = 'open-registry'

/** Return whether a successful blocked result offers cohort normalization. */
export function canNormalizeReconstructionCohort(
  result: WorkflowResult | null,
): boolean {
  return (
    result?.disposition === 'blocked' &&
    result.plan.blockers.some(
      (blocker) => blocker.action === NORMALIZE_RECONSTRUCTION_COHORT_ACTION,
    )
  )
}

/**
 * Preserve a bounded typed failure while normalizing non-Error rejections.
 *
 * @param repeat - The optional stale-plan recovery action.
 */
export function executionFailure(
  cause: unknown,
  fallbackMessage: string,
  repeat?: () => void,
): ExecutionFailure {
  const error = cause instanceof Error ? cause : new Error(fallbackMessage)
  return {
    error,
    // Recover the action from the shared constant because context isolation
    // rebuilds each rejection as a plain Error.
    reviewAgain:
      isPlanStaleError(error) && repeat
        ? { label: REVIEW_AGAIN_ACTION.label, run: repeat }
        : null,
  }
}

/**
 * The facts for the summaries the sidecar gives a plan with no nodes, keyed by
 * the exact text `sidecar/supraspina_sidecar/workflow.py` writes: an explicit
 * workflow target with no subject selected, and any other plan left without a
 * node, such as a subject stage over an empty selection. The summary enters
 * the plan's digest, so the sidecar keeps its text and it is restated for
 * display here; `sidecar/tests/test_plan_outcome_restatement.py` keeps the
 * keys equal to what the sidecar writes. Only an exact match is restated.
 */
const ZERO_NODE_PLAN_FACTS: ReadonlyMap<string, string> = new Map([
  [
    'Keep the explicit empty workflow target as a no-op.',
    'No work is scheduled: the selection is empty.',
  ],
  [
    'Review plan totals: planned 0; waiting 0; blocked 0; skipped 0.',
    'No work is scheduled: the plan has no jobs.',
  ],
])

/**
 * The summary the sidecar gives a live run it started, as
 * `sidecar/supraspina_sidecar/workflow_manager.py` (`run`) writes it, with the
 * run id. It counts the run's nodes planned or waiting when the run
 * starts. It ends with an order. Only an exact match is restated.
 */
const RUN_STARTED_SUMMARY =
  /^Started run (\S+): \d+ jobs? queued\. Watch In flight here and the output in Logs\.$/

/** Plan node states the run schedules; each becomes one of the run's jobs. */
const RUNNABLE_NODE_STATES: ReadonlySet<string> = new Set([
  'planned',
  'waiting',
  'queued',
])

/**
 * State a started run by the jobs it started with: the runnable nodes of the
 * approved plan, which the result carries as planned. Any other summary, or
 * a plan without a runnable node, reads as written.
 *
 * @returns The fact, or null when the summary is not the start summary or
 *   the plan does not count the run's jobs.
 * @example
 * runStartedText(startedResult)
 * // "Run run-af76d30e46dd started with 6 jobs; In flight and Logs show
 * // their progress."
 */
function runStartedText(result: WorkflowResult): string | null {
  const runId = RUN_STARTED_SUMMARY.exec(result.summary.message)?.[1]
  if (runId === undefined) return null
  const jobs = result.plan.nodes.filter((node) =>
    RUNNABLE_NODE_STATES.has(node.status),
  ).length
  if (jobs === 0) return null
  const one = jobs === 1
  return `Run ${runId} started with ${jobs} ${one ? 'job' : 'jobs'}; In flight and Logs show ${one ? 'its' : 'their'} progress.`
}

/**
 * State a workflow result's outcome as its notice shows it: the summary, with
 * the order that opens the summary of a pass in which nothing runs read as a
 * fact (see {@link runSummaryText}), and the summary of a plan with no nodes
 * read as the fact it stands for (see {@link ZERO_NODE_PLAN_FACTS}). A
 * started run reads by the jobs of its approved plan (see
 * {@link runStartedText}). A blocked reason that names no subject, such as
 * the Reconstruction output conflict, reads after the stage and subjects of
 * the plan nodes that record it. The result keeps the summary as the sidecar
 * wrote it, since the plan's digest covers it.
 *
 * @example
 * planOutcomeText(blockedResult)
 * // "No work is scheduled: 1 job is blocked. Reconstruction failed, so this
 * // step did not run."
 * planOutcomeText(emptySelectionResult)
 * // "No work is scheduled: the selection is empty."
 */
export function planOutcomeText(result: WorkflowResult): string {
  const message = result.summary.message
  return (
    ZERO_NODE_PLAN_FACTS.get(message) ??
    runStartedText(result) ??
    runSummaryText(message, result.plan.nodes)
  )
}

/**
 * Run one reviewed workflow operation with separate success and failure state.
 *
 * Reinvoke the service after `PLAN_STALE` so authoritative planning and exact-plan
 * review run again. An {@link ExecutionCanceled} rejection ends the action
 * neutrally: pending clears and no failure, notice, or result is left behind.
 */
export function runExecutionAction(
  operation: () => Promise<WorkflowResult>,
  fallbackMessage: string,
  setFailure: FeedbackSetter<ExecutionFailure>,
  setNotice: FeedbackSetter<string>,
  setResult?: FeedbackSetter<WorkflowResult>,
  setPending?: (pending: boolean) => void,
): void {
  const repeat = (): void => {
    runExecutionAction(
      operation,
      fallbackMessage,
      setFailure,
      setNotice,
      setResult,
      setPending,
    )
  }
  const settleRejection = (cause: unknown): void => {
    setPending?.(false)
    setNotice(null)
    setResult?.(null)
    setFailure(
      isExecutionCanceled(cause)
        ? null
        : executionFailure(cause, fallbackMessage, repeat),
    )
  }
  setFailure(null)
  setNotice(null)
  setResult?.(null)
  setPending?.(true)

  let pending: Promise<WorkflowResult>
  try {
    pending = operation()
  } catch (cause: unknown) {
    settleRejection(cause)
    return
  }

  void pending
    .then((result) => {
      setPending?.(false)
      setFailure(null)
      setNotice(planOutcomeText(result))
      setResult?.(result)
    })
    .catch(settleRejection)
}

/**
 * Name the stage in the page line of a stage plan's outcome.
 *
 * The stage card repeats the outcome silently, so the page line is its only
 * announcement; without the name a screen reader hears "the 1 node is
 * current" and not which stage. A leading "Label: detail" becomes
 * "label; detail", so the line keeps one colon, after the stage name.
 *
 * @example
 * stagePlanLine('ENIGMA QC', 'No work is scheduled: the 1 node is current.')
 * // 'ENIGMA QC: no work is scheduled; the 1 node is current.'
 */
export function stagePlanLine(stageName: string, message: string): string {
  const sentence = message.replace(/^([^:.;]+): /, '$1; ')
  // Lowercase an ordinary leading word, never an acronym such as ENIGMA.
  const lead = /^[A-Z][a-z]/.test(sentence)
    ? `${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`
    : sentence
  return `${stageName}: ${lead}`
}

/** The part of the Runs launch feedback that a plan outcome sets. */
interface PlanOutcomeFeedback {
  notice: string | null
  outcome: WorkflowResult | null
  stageOutcome: { message: string } | null
}

/**
 * Drop the plan outcome from the Runs launch feedback: the page line, the
 * retained result, and the stage card's copy of the same outcome. A card's
 * refusal and an error are separate and stay.
 *
 * @returns The feedback without the plan outcome.
 */
export function withoutPlanOutcome<T extends PlanOutcomeFeedback>(
  feedback: T,
): T {
  // The card holds the outcome as its notice shows it.
  const message = feedback.outcome
    ? planOutcomeText(feedback.outcome)
    : undefined
  return {
    ...feedback,
    notice: null,
    outcome: null,
    stageOutcome:
      feedback.stageOutcome?.message === message ? null : feedback.stageOutcome,
  }
}

/**
 * Drop a plan outcome that found no work, for when the operator leaves Runs.
 * A no-work outcome is neutral, as the dock's is on a tab change; a blocked
 * or started outcome stays until it is dismissed or replaced.
 *
 * @returns The feedback without a no-work outcome, or unchanged.
 */
export function withoutNoWorkOutcome<T extends PlanOutcomeFeedback>(
  feedback: T,
): T {
  return feedback.outcome?.disposition === 'noop'
    ? withoutPlanOutcome(feedback)
    : feedback
}

/** The primary action of every launch confirmation: it opens the plan review. */
export const REVIEW_PLAN_LABEL = 'Review plan'

/** What every launch confirmation says happens after Review plan. */

/**
 * Say what the confirmation leads to, so the review dialog does not surprise
 * the operator and the button is not read as the start of execution. A plan
 * with nothing to run opens no review, only its outcome line, so the sentence
 * holds for an empty plan too.
 */
export function reviewNextSentence(
  dryRun: boolean,
  safeExecution: boolean,
): string {
  if (dryRun) {
    return 'If anything would run, the plan opens for review. Dry run is on, so nothing executes.'
  }
  return safeExecution
    ? 'If anything would run, the plan opens for review; nothing starts until you authorize it.'
    : 'If anything would run, the plan opens read-only, because Allow live runs is off.'
}

/**
 * The Defer checkbox of every launch confirmation. The Runs dialogs and the
 * run dock share it so the same acknowledgement never reads two ways.
 */
export const QC_SCOPE_ACKNOWLEDGEMENT_LABEL =
  'Include Defer and unreviewed subjects (QC Fail subjects stay excluded)'

/** The analysis cohort's rows without a Pass verdict, by verdict. */
export interface QcScopeRows {
  /** Rows with a Defer verdict. */
  defer: number
  /** Rows without a verdict. */
  unreviewed: number
}

/**
 * Count the analysis cohort's Defer and unreviewed rows, which a plan with
 * cohort work includes only after the acknowledgement.
 */
export function qcScopeRows(
  analysisSubjects: readonly Pick<Subject, 'qc'>[],
): QcScopeRows {
  return {
    defer: analysisSubjects.filter((subject) => subject.qc === 'defer').length,
    unreviewed: analysisSubjects.filter((subject) => subject.qc === null)
      .length,
  }
}

/**
 * Whether a stage's plan waits for the Defer acknowledgement. The planner
 * asks for it before any plan while the analysis cohort holds Defer or
 * unreviewed rows, but only a cohort stage reads the cohort: a per-subject
 * stage produces what QC review judges, and its plan and receipts are the
 * same with or without it.
 *
 * @example
 * qcAcknowledgementGatesStage('enigma') // true
 */
export function qcAcknowledgementGatesStage(stepKey: StepKey): boolean {
  return pipelineStep(stepKey).scope === 'cohort'
}

/** Why Review plan waits while an acknowledgement box is unchecked. */
export const ACKNOWLEDGEMENT_NEEDED_TITLE = 'Check the box above to continue.'

/**
 * Say beside the Defer checkbox which rows it covers and why Review plan
 * waits for it, so a disabled button is never left unexplained.
 *
 * @param rows - The Defer and unreviewed subjects in the analysis cohort.
 * @returns The hint below the checkbox.
 * @example
 * qcScopeAcknowledgementHint({ defer: 14, unreviewed: 7 })
 * // '14 Defer and 7 unreviewed subjects are in the analysis cohort. ...'
 */
export function qcScopeAcknowledgementHint(rows: QcScopeRows): string {
  const parts = [
    rows.defer > 0 ? `${rows.defer} Defer` : null,
    rows.unreviewed > 0 ? `${rows.unreviewed} unreviewed` : null,
  ].filter((part): part is string => part !== null)
  const one = rows.defer + rows.unreviewed === 1
  return `${parts.join(' and ')} ${one ? 'subject is' : 'subjects are'} in the analysis cohort. Check the box to continue.`
}

/**
 * Label the memory checkbox of a launch confirmation: the checkbox continues
 * the launch, and the label states the shortfall it continues past.
 */
export function memoryAcknowledgementLabel(
  availableGB: number,
  advisoryGB: number,
): string {
  return `Continue although available host memory (${availableGB.toFixed(1)} GB) is below this project's ${advisoryGB} GB memory advisory threshold.`
}

/**
 * Say beside the memory checkbox why Review plan waits for it.
 *
 * @returns The hint below the checkbox.
 */
export function memoryAcknowledgementHint(advisoryGB: number): string {
  return `Review plan needs this acknowledgement while available host memory is below ${advisoryGB} GB.`
}

/**
 * What Runs and the run dock say once cancellation is requested: a job ends
 * only when it acknowledges the request, so the runs are not yet canceled.
 */
export const CANCELLATION_REQUESTED_NOTICE =
  'Cancellation is requested; Supraspina waits for each active job to acknowledge it.'

/**
 * The job outcomes a canceled run's notice counts, in the order it names
 * them. A storage error counts as failed, as on the Dashboard; a blocked or
 * withheld job did not run; a job whose process state Supraspina could not
 * confirm has an unknown status, as the Subjects matrix names it.
 */
const CANCELED_RUN_JOB_OUTCOMES: readonly {
  statuses: ReadonlySet<JobStatus>
  outcome: string
}[] = [
  { statuses: new Set(['done']), outcome: 'finished' },
  { statuses: new Set(['cancelled']), outcome: 'canceled' },
  { statuses: new Set(['failed', 'persistence-error']), outcome: 'failed' },
  { statuses: new Set(['interrupted']), outcome: 'interrupted' },
  { statuses: new Set(['blocked', 'withheld']), outcome: 'did not run' },
  {
    statuses: new Set(['stale', 'unknown']),
    outcome: 'with an unknown status',
  },
]

/**
 * State that a run ended canceled and how its jobs ended, so the notice that
 * cancellation was requested gives way to what happened.
 *
 * @param jobs - The runtime jobs of every run.
 * @example
 * canceledRunNotice('run-19ac40eacf50', jobs)
 * // "Run run-19ac40eacf50 was canceled: 1 job finished, 1 canceled."
 */
export function canceledRunNotice(runId: string, jobs: readonly Job[]): string {
  const own = jobs.filter((job) => job.runId === runId)
  const counts = CANCELED_RUN_JOB_OUTCOMES.flatMap(({ statuses, outcome }) => {
    const n = own.filter((job) => statuses.has(job.status)).length
    return n > 0 ? [{ n, outcome }] : []
  })
  const [first, ...rest] = counts
  if (!first) return `Run ${runId} was canceled before any job started.`
  const lead = `${first.n} ${first.n === 1 ? 'job' : 'jobs'} ${first.outcome}`
  const parts = [lead, ...rest.map(({ n, outcome }) => `${n} ${outcome}`)]
  return `Run ${runId} was canceled: ${parts.join(', ')}.`
}

/** How {@link canceledRunNotice} opens, wherever a notice names the run. */
const CANCELED_RUN_OPENING = /(?:^|\. )Run (\S+) was canceled\b/

/**
 * Whether a Runs notice states how a canceled run ended, so it offers Logs,
 * which lists each job with its outcome.
 *
 * @returns True when the notice holds a {@link canceledRunNotice} sentence.
 * @example
 * statesCanceledRun('Run run-1 was canceled: 1 job canceled.') // true
 */
export function statesCanceledRun(notice: string): boolean {
  return CANCELED_RUN_OPENING.test(notice)
}

/**
 * Return the run a canceled-run notice names, so its Open Logs opens that run.
 *
 * @returns The run id, or null when the notice states no canceled run.
 * @example
 * canceledRunId('Run run-1 was canceled: 1 job canceled.') // 'run-1'
 */
export function canceledRunId(notice: string): string | null {
  return CANCELED_RUN_OPENING.exec(notice)?.[1] ?? null
}

/** Whether a live launch waits for Allow live runs or for a save. */
export type SafeExecutionNoticeState = 'off' | 'unsaved'

/**
 * Return what a launch dialog says about Allow live runs, if anything.
 *
 * Allow live runs resets to off on every launch, so the first live launch
 * after a relaunch cannot be authorized. The dialog names that and offers to
 * turn it on; the switch stays bound to a save, so once it is on the dialog
 * asks for the save instead. A dry run needs neither.
 *
 * @returns The notice state, or null when a live plan can be authorized.
 * @example
 * safeExecutionNoticeState(false, false, false) // 'off'
 */
export function safeExecutionNoticeState(
  dryRun: boolean,
  safeExecution: boolean,
  dirty: boolean,
): SafeExecutionNoticeState | null {
  if (dryRun) return null
  if (!safeExecution) return 'off'
  return dirty ? 'unsaved' : null
}

/** Join stage names as prose: "A", "A and B", or "A, B, and C". */
function proseList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, -1).join(', ')}, and ${names.slice(-1).join('')}`
}

/** Name the subjects a per-subject stage runs for under the target. */
function subjectScope(target: WorkflowTarget, cohortSize: number): string {
  if (target.mode === 'explicit') {
    const count = target.subjectIds.length
    return `the ${count} selected subject${count === 1 ? '' : 's'}`
  }
  return cohortSize === 1
    ? 'the 1 subject in the analysis cohort'
    : `all ${cohortSize} subjects in the analysis cohort`
}

/**
 * State what a whole-workflow launch runs, by stage name and for enabled
 * stages only, so the confirmation never names a stage that is off.
 *
 * Per-subject stages follow the execution target. Every cohort-wide stage
 * reads the full analysis cohort and waits until each subject in it has
 * finished its per-subject stages, so a selection never produces a
 * partial-cohort analysis.
 */
export function workflowScopeSentence(
  steps: ProjectConfig['steps'],
  target: WorkflowTarget,
  cohortSize: number,
): string {
  const enabled = PIPELINE_STEPS.filter((step) => steps[step.key]?.enabled)
  const perSubject = enabled
    .filter((step) => step.scope === 'subject')
    .map((step) => step.name)
  const cohortWide = enabled.some((step) => step.scope === 'cohort')
  if (perSubject.length === 0) {
    return cohortWide
      ? 'Each enabled cohort-wide stage runs once over the analysis cohort.'
      : 'No stage is enabled, so the plan has nothing to run.'
  }
  const one = perSubject.length === 1
  const subjects = `${proseList(perSubject)} ${one ? 'runs' : 'run'} for ${subjectScope(target, cohortSize)}`
  if (!cohortWide) return `${subjects}.`
  return `${subjects}; cohort-wide stages run once after them.`
}

/**
 * State what a stage launch runs: a cohort-wide stage covers the full
 * analysis cohort, and a per-subject stage follows the execution target.
 */
export function stageScopeSentence(
  stepKey: StepKey,
  target: WorkflowTarget,
  cohortSize: number,
): string {
  const step = PIPELINE_STEPS.find((candidate) => candidate.key === stepKey)
  const name = step?.name ?? stepKey
  return step?.scope === 'cohort'
    ? `${name} runs once over the full analysis cohort.`
    : `${name} runs for ${subjectScope(target, cohortSize)}.`
}
