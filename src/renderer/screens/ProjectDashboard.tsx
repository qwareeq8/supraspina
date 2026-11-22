/**
 * Gives the operator an at-a-glance project home with clickable cohort totals,
 * recently updated subjects, recent runs, and failed-step attention items.
 *
 * Missing data is bootstrapped through {@link getApi}. Shared shell state is
 * preferred when supplied.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Btn,
  Card,
  CohortNotice,
  CohortWaitNotice,
  EmptyState,
  ErrorState,
  IconButton,
  RefreshButton,
  SCROLL_HINT_GUTTER,
  ScrollEdgeHints,
  Ico,
  ICONS,
  ICON_SIZE,
  Page,
  FONTS,
  statusColor,
  formatRunTime,
  FreshnessStamp,
  StatusCell,
  StatusGlyph,
  StatusLegend,
  cellStateLabel,
  failureReasonText,
  statusGlyphColor,
  matrixCellStates,
  recentSubjectStepLabel,
  recentSubjectStepLabelLines,
  recentSubjectStepWidth,
  subjectEdgeColor,
  TEXT_GAP,
  useHiddenEdges,
  type Density,
  type Theme,
} from '../ui'
import { balancedColumns } from '../ui/balanced-columns'
import { QC_FAIL_EXCLUSION_REASON } from '../../shared/analysis-cohort'
import { MATRIX_STEP_HELP, spelledOutStepName } from '../../shared/help'
import { useApp } from '../state/context'
import type { RunPlanRecords, SubjectFilter } from '../state/context'
import { getApi } from '../state/api'
import { shownMatrixColumns, type MatrixColumn } from '../state/matrix-columns'
import type { ProjectConfig } from '../../shared/project-schema'
import { pipelineStep } from '../../shared/steps'
import type { MatrixStepKey } from '../../shared/steps'
import type {
  CellState,
  ChipStatus,
  Job,
  ManifestStepStatus,
  RunManifest,
  Subject,
} from '../../shared/types'
import { subjectUpdatedAt } from '../../shared/types'
import type { RunSnapshot } from '../../shared/contract'
import { useRuntime } from '../state/runtime-state'
import {
  applyStageCurrency,
  cohortCurrencySubjectIds,
  stageCurrencyNotice,
  useProjectStageCurrency,
} from '../state/stage-currency'
import {
  ATTENTION_BUCKETS,
  blockedRunSummaryReason,
  cohortStageWait,
  nameBlockedStage,
  skipDisabledStages,
  subjectAttention,
  subjectAuxiliaryDisplayStatus,
  subjectDisplayBucket,
  type SubjectAttention,
  type SubjectDisplayBucket,
} from '../state/subject-runtime-status'
import {
  nameBlockedSubjects,
  type NotRunRecord,
} from '../state/terminal-reason'
import {
  CURRENCY_BUCKETS,
  CURRENCY_CHECKING_FACT,
  SUBJECT_BUCKET_LABEL,
  SUBJECT_BUCKETS,
  shownSubjectBuckets,
  tallySubjectBuckets,
} from '../state/subject-buckets'

/** Project, cohort, runtime, and navigation state for the dashboard. */
export interface ProjectDashboardProps {
  cfg?: ProjectConfig
  subjects?: Subject[]
  /**
   * Whether the shell is still discovering the cohort, which holds the
   * loading state.
   */
  loading?: boolean
  runtimeRuns?: readonly RunSnapshot[]
  selection?: ReadonlySet<string>
  onSelectionChange?: (next: ReadonlySet<string>) => void
  activeSubjectId?: string | null
  onActiveSubjectChange?: (id: string) => void
  dirty?: boolean
  refresh?: () => void
}

interface StatTile {
  key: string
  value: number
  label: string
  onClick: () => void
  ariaAction: string
  status?: ChipStatus
  /**
   * Disambiguate a whole-subject roll-up from the adjacent per-step cells in the
   * tooltip and accessible name.
   */
  hint?: string
  /** A tooltip-only definition of the bucket. */
  tip?: string
  /**
   * Whether the count waits on the stage-currency read, which may still move
   * subjects between Done and Out of date.
   */
  checking?: boolean
  /**
   * The subjects of this tile's kind that another tile counts: a short note
   * beside the number and the sentence that explains it.
   */
  elsewhere?: { note: string; fact: string }
}

/** What a bucket's tile says about its subjects. */
interface BucketTile {
  ariaAction: string
  status: ChipStatus
  hint?: string
  /** A tooltip-only definition for a bucket whose label says enough aloud. */
  tip?: string
}

/**
 * The tile of each subject bucket. A hint states what the bucket holds where
 * its label alone could be misread.
 */
const BUCKET_TILE: Record<SubjectDisplayBucket, BucketTile> = {
  done: {
    ariaAction: 'Open done subjects.',
    status: 'done',
    hint: 'Every enabled pipeline step is complete for these subjects.',
  },
  outdated: {
    ariaAction: 'Open out-of-date subjects.',
    status: 'warn',
    hint: 'Every step finished for these subjects, and at least one step is out of date. Run all reruns the out-of-date steps.',
  },
  partial: {
    ariaAction: 'Open partly done subjects.',
    status: 'pending',
    hint: 'These subjects have finished steps and at least one step still to run.',
  },
  running: {
    ariaAction: 'Open running subjects.',
    status: 'running',
    tip: 'At least one step is running or queued now.',
  },
  failed: {
    ariaAction: 'Open failed subjects.',
    status: 'failed',
    tip: 'At least one step failed, was blocked, or was withheld.',
  },
  interrupted: {
    ariaAction: 'Open interrupted subjects.',
    status: 'interrupted',
    hint: 'A step of these subjects was interrupted before it finished, and none failed.',
  },
  cancelled: {
    ariaAction: 'Open canceled subjects.',
    status: 'cancelled',
    hint: 'A step of these subjects was canceled before it finished, and none failed or was interrupted.',
  },
  pending: {
    ariaAction: 'Open pending subjects.',
    status: 'pending',
    tip: 'No step has finished for these subjects.',
  },
  excluded: {
    ariaAction: 'Open excluded subjects.',
    status: 'exclude',
    hint: QC_FAIL_EXCLUSION_REASON,
  },
}

const SUBJECT_PREVIEW_LIMIT = 10
const RUN_PREVIEW_LIMIT = 3
const ATTENTION_PREVIEW_LIMIT = 5
const SUBJECT_COLUMN_WIDTH = 80
const SUBJECT_TABLE_ROW_PADDING = 12
const DASHBOARD_ROW_HEIGHT = 36
const DASHBOARD_ROW_GAP = 4
const DASHBOARD_ROW_PADDING = '3px 8px'
const DASHBOARD_ROW_RADIUS = 5
const DASHBOARD_ICON_BOX_SIZE = 24
/**
 * Draw a list row's focus ring inside its border. The Recent runs and Needs
 * attention lists scroll on their own, and their scroll box would clip the top
 * of a ring drawn outside the first row.
 */
const DASHBOARD_ROW_FOCUS_OFFSET = -2

function attentionStepLabel(key: MatrixStepKey): string {
  return recentSubjectStepLabel(key)
}

function fixedPreviewListHeight(
  limit: number,
  rowHeight: number,
  gap: number,
): number {
  return limit * rowHeight + Math.max(0, limit - 1) * gap
}

/** The later of two ISO 8601 times, or the one that is set. */
function latestTimestamp(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return Date.parse(b) > Date.parse(a) ? b : a
}

function recentSubjects(subjects: Subject[]): Subject[] {
  return [...subjects].sort((a, b) => subjectUpdatedAt(b) - subjectUpdatedAt(a))
}

/** One Needs attention row: a subject and the step that needs attention. */
interface AttentionItem {
  subject: Subject
  attention: SubjectAttention
}

/**
 * List the subjects with a step that ended without finishing: failed first,
 * then interrupted, then canceled, each newest first.
 */
function needsAttention(subjects: Subject[]): AttentionItem[] {
  const items: AttentionItem[] = []
  for (const subject of subjects) {
    const attention = subjectAttention(subject)
    if (attention) items.push({ subject, attention })
  }
  return items.sort(
    (a, b) =>
      ATTENTION_BUCKETS.indexOf(a.attention.bucket) -
        ATTENTION_BUCKETS.indexOf(b.attention.bucket) ||
      subjectUpdatedAt(b.subject) - subjectUpdatedAt(a.subject),
  )
}

/**
 * Count the attention rows by state, most severe first, for example "4
 * failed, 2 canceled".
 */
function attentionCountPhrase(items: readonly AttentionItem[]): string {
  return ATTENTION_BUCKETS.map((bucket) => {
    const count = items.filter(
      (item) => item.attention.bucket === bucket,
    ).length
    return count > 0
      ? `${count} ${SUBJECT_BUCKET_LABEL[bucket].toLowerCase()}`
      : null
  })
    .filter((phrase): phrase is string => phrase !== null)
    .join(', ')
}

/**
 * Name the step that needs attention and its state, for example "recon-all
 * canceled" or, for a stage without a matrix column, "Brain FOV preparation
 * interrupted".
 */
function attentionStepText(attention: SubjectAttention): string {
  const step = attention.column
    ? attentionStepLabel(attention.column)
    : attention.stepKey
      ? pipelineStep(attention.stepKey).name
      : null
  const state = cellStateLabel(attention.state)
  return step ? `${step} ${state}` : state
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * State the subjects with an out-of-date step that another tile counts. Each
 * subject counts in one tile, and a canceled, failed, or unfinished step
 * decides its tile ahead of an out-of-date one, so after a canceled run the
 * Out of date tile could read 0 beside the notice that counts those subjects.
 * A subject has an out-of-date step when a matrix cell is out of date or
 * when the notice counts it, since an out-of-date cohort stage without a
 * matrix column, or whose cell the run left canceled, marks no cell.
 *
 * @param rows - The subjects with the currency projection.
 * @returns The note beside the Out of date count, such as "3 under
 *   Canceled", and the sentence that explains it, or null when every subject
 *   with an out-of-date step is in the Out of date tile.
 */
function outdatedElsewhere(
  rows: readonly Subject[],
  noticeSubjectIds: ReadonlySet<string>,
): { note: string; fact: string } | null {
  const byBucket = new Map<SubjectDisplayBucket, number>()
  for (const subject of rows) {
    if (
      !noticeSubjectIds.has(subject.id) &&
      !subject.cells.some((cell) => cell.st === 'outdated')
    ) {
      continue
    }
    const bucket = subjectDisplayBucket(subject)
    if (bucket === 'outdated') continue
    byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1)
  }
  if (byBucket.size === 0) return null
  const buckets = SUBJECT_BUCKETS.filter((bucket) => byBucket.has(bucket))
  const total = buckets.reduce(
    (n, bucket) => n + (byBucket.get(bucket) ?? 0),
    0,
  )
  const labels = buckets.map((bucket) => SUBJECT_BUCKET_LABEL[bucket])
  const only = buckets.length === 1 ? labels[0] : undefined
  return {
    note: `${total} under ${only ?? 'other tiles'}`,
    fact: `${countLabel(total, 'subject')} with an out-of-date step ${
      total === 1 ? 'is' : 'are'
    } counted under ${
      only ??
      `${labels.slice(0, -1).join(', ')}${labels.length > 2 ? ',' : ''} and ${labels[labels.length - 1]}`
    }, since each subject counts in one tile.`,
  }
}

/**
 * Count the subjects a run covered. A cohort stage counts one node, so read the
 * manifest's selected subset, then its analysis cohort, as the QC run selector
 * does; fall back to the largest per-stage count only for manifests that record
 * neither.
 */
function runSubjectCount(run: RunManifest): number {
  const scoped =
    run.selectedSubset?.subjectIds ?? run.analysisCohort?.subjectIds
  if (scoped) return scoped.length
  return Math.max(0, ...run.steps.map((step) => step.subjects))
}

/**
 * The icon of a Recent runs row: a settled outcome draws the matrix legend's
 * glyph and tone for its state, so a failed run carries the Failed cross and
 * a blocked run the Blocked sign. A run in progress keeps the pulsing dot,
 * since the legend's Running glyph is a progress track, and a run whose
 * state could not be stored keeps the warning sign; the legend has neither.
 * A dry-run plan, in which nothing ran, draws a neutral ring.
 */
type RunIcon = CellState | 'in-progress' | 'dry-run' | 'storage-error'

interface RunDisplay {
  icon: RunIcon
  /** The outcome and the start time, by which Logs and QC review name a run. */
  title: string
  detail: string
  iconLabel: string
  /** When the run ended, once it has, or an empty string. */
  timing: string
}

/**
 * Name a run by its outcome and its start time, as the Logs Run list it opens
 * and QC review's current ENIGMA run name it, and say that the time is the
 * start, for example "Failed, started Sep 22, 2:17 PM", so it cannot read
 * as the time the run failed. A run that has only started reads "Started
 * <time>".
 */
function runTitle(label: string, startedAt: string | null): string {
  if (!startedAt) return `${label}, start time not recorded`
  const at = formatRunTime(startedAt)
  return label === 'Started' ? `Started ${at}` : `${label}, started ${at}`
}

/**
 * State when a run ended, once it has, in the row's tooltip and accessible
 * name; its title already states when it started.
 */
function runTiming(endedAt: string | null): string {
  return endedAt ? `Ended ${formatRunTime(endedAt)}` : ''
}

function runtimeTimestamp(
  value: number | null,
  fallback: string | null,
): string | null {
  return value !== null && Number.isFinite(value)
    ? new Date(value).toISOString()
    : fallback
}

function manifestRunDetail(run: RunManifest): {
  failedText: string
  subjectText: string
} {
  const failed = run.steps.reduce((n, step) => n + step.failed, 0)
  const subjects = runSubjectCount(run)
  return {
    failedText: failed > 0 ? countLabel(failed, 'failure') : '',
    subjectText: subjects > 0 ? countLabel(subjects, 'subject') : '',
  }
}

/** Name the stages of a run with one outcome, in manifest order. */
function stepNamesWith(
  run: RunManifest,
  status: 'blocked' | 'withheld',
): string[] {
  return run.steps
    .filter((step) => step.status === status)
    .map((step) => pipelineStep(step.key).name)
}

/**
 * Name every stage a run did not run: the stages it blocked, then those its
 * failure policy withheld, as the Runs notice counts both.
 */
function notRunStepNames(run: RunManifest): string[] {
  return [...stepNamesWith(run, 'blocked'), ...stepNamesWith(run, 'withheld')]
}

/** Whether a run's manifest holds a stage that it blocked or withheld. */
function heldBackStages(run: RunManifest): boolean {
  return run.steps.some(
    (step) => step.status === 'blocked' || step.status === 'withheld',
  )
}

/**
 * Name the stages a run blocked and withheld, e.g. "Reconstruction blocked;
 * ENIGMA QC, R analysis withheld".
 */
function blockedStepsDetail(run: RunManifest): string {
  const parts = [
    [stepNamesWith(run, 'blocked'), 'blocked'],
    [stepNamesWith(run, 'withheld'), 'withheld'],
  ] as const
  const named = parts
    .filter(([names]) => names.length > 0)
    .map(([names, outcome]) => `${names.join(', ')} ${outcome}`)
  return named.length === 0 ? 'stage blocked' : named.join('; ')
}

/**
 * The first sentence of a message. A sentence ends at a terminator followed by
 * whitespace and an uppercase letter, or by the end of the text, so a period
 * inside a path or file name such as `metadata.csv` does not end it.
 */
const FIRST_SENTENCE = /^.*?[.!?](?=\s+[A-Z]|\s*$)/s

/**
 * Prefer the sidecar's own blocked reason when the snapshot carries one, and
 * drop its lead-in, whether it counts the work that runs or the blocked nodes
 * to resolve, so a blocked run names its own cause.
 *
 * A run row names a run, not a stage, so a blocked-dependency reason names
 * the stage that did not run in place of "this step". The summary quotes only
 * its first reason, which may belong to any stage the run blocked or
 * withheld, so a run that held back several stages names them instead. Any
 * other reason, such as the Reconstruction output conflict, names no subject,
 * so it reads after the stage and subjects whose plan nodes or jobs record
 * it, as the Runs notice states it; without such a record it reads as
 * recorded.
 */
function blockedRunReason(
  run: RunManifest,
  snapshot: RunSnapshot,
  records: readonly NotRunRecord[],
): string {
  const summary = snapshot.summary?.message
  const message =
    summary === undefined ? undefined : blockedRunSummaryReason(summary)
  const firstSentence = message?.match(FIRST_SENTENCE)?.[0]?.trim()
  if (!message || !firstSentence) return blockedStepsDetail(run)
  const named = nameBlockedStage(firstSentence, notRunStepNames(run))
  if (named === null) return blockedStepsDetail(run)
  if (named !== firstSentence) return named
  // Attribute the whole reason, which may run past its first sentence, and
  // keep the first sentence of the attributed text.
  const attributed = nameBlockedSubjects(message, records)
  return attributed === message
    ? firstSentence
    : (attributed.match(FIRST_SENTENCE)?.[0]?.trim() ?? firstSentence)
}

/**
 * State a dry-run plan as settled: a dry run only plans, so it ends planned
 * with nothing run, and Logs names it by its kind.
 */
function dryRunPlanDisplay(
  startedAt: string | null,
  endedAt: string | null,
  subjectText: string,
): RunDisplay {
  return {
    icon: 'dry-run',
    title: runTitle('Dry-run plan', startedAt),
    detail: subjectText,
    iconLabel: 'Dry-run plan: nothing ran',
    timing: runTiming(endedAt),
  }
}

function manifestRunDisplay(run: RunManifest): RunDisplay {
  const { failedText, subjectText } = manifestRunDetail(run)
  const timing = runTiming(run.endedAt)
  if (run.dryRun) {
    return dryRunPlanDisplay(run.startedAt, run.endedAt, subjectText)
  }
  const hasStep = (status: ManifestStepStatus): boolean =>
    run.steps.some((step) => step.status === status)
  /** State a run whose outcome no stage recorded, as a runtime row does. */
  const unrecorded = (
    status: 'unknown' | 'persistence-error' | 'stale',
  ): RunDisplay => ({
    ...RUN_STATUS_ICON[status],
    title: runTitle(runtimeStatusLabel(status), run.startedAt),
    detail: [failedText, runtimeAttentionDetail(status), subjectText]
      .filter(Boolean)
      .join(TEXT_GAP),
    timing,
  })
  // A stage whose state is unknown makes the run's unknown, whether or not
  // it ended, as the sidecar settles a run.
  if (hasStep('unknown')) return unrecorded('unknown')
  // Work withheld after a failure reads with that failure below; withheld
  // without one did not run either, so it reads as blocked.
  const failedSteps = run.steps.some(
    (step) => step.status === 'failed' || step.failed > 0,
  )
  const blocked = hasStep('blocked') || (!failedSteps && hasStep('withheld'))
  // Keep blocked work out of the in-progress state even when it has no end
  // time, since it never launched a tool.
  if (!run.endedAt && !blocked) {
    return {
      ...RUN_STATUS_ICON.running,
      title: runTitle('Started', run.startedAt),
      detail: subjectText,
      timing,
    }
  }
  // A failure reads before a cancellation, a cancellation before a blocked
  // stage, and a blocked stage before an interruption, as the sidecar ranks
  // a settled run's status. A stage whose state could not be stored or went
  // stale reads next, so such a run never reads as completed. Every title
  // states the outcome with the start time; its detail counts the failures.
  if (failedSteps) {
    return {
      ...RUN_STATUS_ICON.failed,
      title: runTitle('Failed', run.startedAt),
      detail: [failedText, subjectText].filter(Boolean).join(TEXT_GAP),
      timing,
    }
  }
  if (hasStep('cancelled')) {
    return {
      ...RUN_STATUS_ICON.cancelled,
      title: runTitle(runtimeStatusLabel('cancelled'), run.startedAt),
      detail: subjectText,
      timing,
    }
  }
  if (blocked) {
    return {
      ...RUN_STATUS_ICON.blocked,
      title: runTitle('Blocked', run.startedAt),
      detail: [blockedStepsDetail(run), subjectText]
        .filter(Boolean)
        .join(TEXT_GAP),
      timing,
    }
  }
  if (hasStep('interrupted')) {
    return {
      ...RUN_STATUS_ICON.interrupted,
      title: runTitle(runtimeStatusLabel('interrupted'), run.startedAt),
      detail: subjectText,
      timing,
    }
  }
  if (hasStep('persistence-error')) return unrecorded('persistence-error')
  if (hasStep('stale')) return unrecorded('stale')
  return {
    ...RUN_STATUS_ICON.done,
    title: runTitle('Done', run.startedAt),
    detail: subjectText,
    timing,
  }
}

/**
 * The icon of a run in each status and its name, which states the outcome.
 * A settled run draws the matrix legend state of the same name; a status the
 * runtime could not determine draws the legend's unknown run state.
 */
const RUN_STATUS_ICON: Record<
  RunSnapshot['status'],
  Pick<RunDisplay, 'icon' | 'iconLabel'>
> = {
  planned: { icon: 'in-progress', iconLabel: 'Run in progress' },
  waiting: { icon: 'in-progress', iconLabel: 'Run in progress' },
  queued: { icon: 'in-progress', iconLabel: 'Run in progress' },
  running: { icon: 'in-progress', iconLabel: 'Run in progress' },
  cancelling: { icon: 'in-progress', iconLabel: 'Run in progress' },
  done: { icon: 'done', iconLabel: 'Run completed' },
  failed: { icon: 'failed', iconLabel: 'Run failed' },
  cancelled: { icon: 'cancelled', iconLabel: 'Run canceled' },
  interrupted: { icon: 'interrupted', iconLabel: 'Run interrupted' },
  blocked: { icon: 'blocked', iconLabel: 'Run blocked' },
  withheld: { icon: 'withheld', iconLabel: 'Run withheld' },
  stale: { icon: 'stale', iconLabel: 'Run state is stale' },
  unknown: { icon: 'stale', iconLabel: 'Run status unknown' },
  'persistence-error': {
    icon: 'storage-error',
    iconLabel: 'Run storage error',
  },
}

const ACTIVE_RUN_STATUSES: ReadonlySet<RunSnapshot['status']> = new Set([
  'planned',
  'waiting',
  'queued',
  'running',
  'cancelling',
])

const BLOCKED_RUN_STATUSES: ReadonlySet<RunSnapshot['status']> = new Set([
  'blocked',
  'withheld',
])

function runtimeStatusLabel(status: RunSnapshot['status']): string {
  switch (status) {
    case 'planned':
      return 'Planned'
    case 'waiting':
      return 'Waiting'
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Started'
    case 'cancelling':
      return 'Canceling'
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Canceled'
    case 'blocked':
      return 'Blocked'
    case 'withheld':
      return 'Withheld'
    case 'interrupted':
      return 'Interrupted'
    case 'stale':
      return 'Stale'
    case 'persistence-error':
      return 'Storage error'
    case 'unknown':
      return 'Unknown'
  }
}

/**
 * State what a run's title leaves out about how it ended. A canceled or
 * interrupted run's title already names its outcome, so its detail holds
 * only its counts.
 */
function runtimeAttentionDetail(status: RunSnapshot['status']): string {
  switch (status) {
    case 'cancelled':
    case 'interrupted':
      return ''
    case 'stale':
      return 'stale runtime state'
    case 'persistence-error':
      return 'runtime storage error'
    case 'unknown':
      return 'runtime status unknown'
    default:
      return 'needs review'
  }
}

/**
 * Override stale manifest status and timestamps with a matching live snapshot.
 * Keep manifest subject and failure counts as supporting detail. The run's
 * plan nodes and jobs at hand name the subjects of a blocked reason.
 */
function runtimeRunDisplay(
  run: RunManifest,
  snapshot: RunSnapshot,
  records: readonly NotRunRecord[],
): RunDisplay {
  const { failedText, subjectText } = manifestRunDetail(run)
  const startedAt = runtimeTimestamp(snapshot.startedAt, run.startedAt)
  const endedAt = runtimeTimestamp(snapshot.endedAt, run.endedAt)
  const label = runtimeStatusLabel(snapshot.status)
  // A run is named by its start time in every state, as Logs names it; the
  // end time is part of its timing.
  const at = startedAt
  const icon = RUN_STATUS_ICON[snapshot.status]
  const timing = runTiming(
    ACTIVE_RUN_STATUSES.has(snapshot.status) ? null : endedAt,
  )

  // A dry run ends planned; its plan is its outcome, not work in progress.
  if (snapshot.dryRun && snapshot.status === 'planned') {
    return dryRunPlanDisplay(startedAt, endedAt, subjectText)
  }
  if (ACTIVE_RUN_STATUSES.has(snapshot.status)) {
    return {
      ...icon,
      title: runTitle(label, at),
      detail: [failedText, subjectText].filter(Boolean).join(TEXT_GAP),
      timing,
    }
  }
  if (BLOCKED_RUN_STATUSES.has(snapshot.status)) {
    const manifestReason = heldBackStages(run)
      ? blockedRunReason(run, snapshot, records)
      : snapshot.status
    return {
      ...icon,
      title: runTitle(label, at),
      detail: [failedText, manifestReason, subjectText]
        .filter(Boolean)
        .join(TEXT_GAP),
      timing,
    }
  }
  if (snapshot.status === 'done') {
    return {
      ...icon,
      title: runTitle(label, at),
      detail: [failedText, subjectText].filter(Boolean).join(TEXT_GAP),
      timing,
    }
  }
  return {
    ...icon,
    title: runTitle(label, at),
    detail: [failedText || runtimeAttentionDetail(snapshot.status), subjectText]
      .filter(Boolean)
      .join(TEXT_GAP),
    timing,
  }
}

function runDisplay(
  run: RunManifest,
  snapshot: RunSnapshot | undefined,
  records: readonly NotRunRecord[],
): RunDisplay {
  return snapshot
    ? runtimeRunDisplay(run, snapshot, records)
    : manifestRunDisplay(run)
}

/**
 * Collect, by run, the plan nodes and jobs that may name the subjects of a
 * blocked run's reason, as the Runs notice reads them: the not-run nodes of
 * each plan Supraspina started while the project is open, since plan-time
 * blocked nodes never become jobs, and every run's jobs, which record the
 * reason the scheduler blocked them for. A run with no plan at hand, such as
 * one started before the project was opened or Supraspina relaunched, reads the
 * nodes its snapshot lists behind the quoted reason from the run's record.
 */
function notRunRecordsByRun(
  planRecords: RunPlanRecords,
  jobs: readonly Job[],
  runs: readonly RunSnapshot[],
): ReadonlyMap<string, readonly NotRunRecord[]> {
  const byRun = new Map<string, NotRunRecord[]>()
  const add = (runId: string, record: NotRunRecord): void => {
    const records = byRun.get(runId)
    if (records) records.push(record)
    else byRun.set(runId, [record])
  }
  for (const [runId, records] of planRecords) {
    for (const record of records) add(runId, record)
  }
  for (const run of runs) {
    if (planRecords.has(run.runId)) continue
    for (const record of run.quotedReasonNodes ?? []) add(run.runId, record)
  }
  for (const job of jobs) {
    if (job.runId === undefined) continue
    add(job.runId, {
      stepKey: job.stepKey,
      subjectId: job.subjectId,
      status: job.status,
      reason: job.terminalReason,
    })
  }
  return byRun
}

export function ProjectDashboard(props: ProjectDashboardProps = {}): ReactNode {
  const { projectEpoch } = useApp()
  return <ProjectDashboardProject key={projectEpoch} {...props} />
}

function ProjectDashboardProject(props: ProjectDashboardProps): ReactNode {
  const app = useApp()
  const {
    t,
    density,
    setRoute,
    setSubjectsFilter,
    setLogsFocusRunId,
    projectRef,
    configRevision,
  } = app
  const cfg = props.cfg ?? app.cfg

  const [fetchedSubjects, setFetchedSubjects] = useState<Subject[] | null>(
    () => (projectRef ? null : []),
  )
  const [runs, setRuns] = useState<RunManifest[]>([])
  // Track run-history loading independently from cohort loading. Distinguish a
  // failed or unread history from a valid empty history.
  const [runsPhase, setRunsPhase] = useState<{
    key: number
    phase: 'loading' | 'ready' | 'error'
  }>(() => ({ key: 0, phase: projectRef ? 'loading' : 'ready' }))
  const [error, setError] = useState<string | null>(null)
  const [runsExpanded, setRunsExpanded] = useState(false)
  const [attentionExpanded, setAttentionExpanded] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // Derive shell-supplied values during render to avoid mirroring props through
  // an effect.
  const subjects = props.subjects ?? fetchedSubjects

  // Bootstrap cohort, manifest, and tool state only when the shell does not
  // provide it. Keep state updates after the first await.
  useEffect(() => {
    if (!projectRef) return undefined
    let live = true
    const captured = projectRef
    const api = getApi()
    if (props.subjects === undefined) {
      api.subjects
        .discover({ project: captured, cfg, configRevision })
        .then((rows) => {
          if (live) {
            setFetchedSubjects(rows)
            setLastUpdatedAt(new Date().toISOString())
          }
        })
        .catch((e: unknown) => {
          if (live) setError(e instanceof Error ? e.message : String(e))
        })
    }
    api.manifest
      .list({ project: captured, limit: 20 })
      .then((page) => {
        if (live) {
          setRuns(page.items)
          setRunsPhase({ key: reloadKey, phase: 'ready' })
          setLastUpdatedAt(new Date().toISOString())
        }
      })
      .catch(() => {
        if (live) {
          setRuns([])
          setRunsPhase({ key: reloadKey, phase: 'error' })
        }
      })
    return () => {
      live = false
    }
  }, [cfg, props.subjects, reloadKey, projectRef, configRevision])

  // Treat a superseded history phase as loading until the current read resolves.
  const runHistoryPhase =
    runsPhase.key === reloadKey ? runsPhase.phase : 'loading'
  const loading = props.loading === true || subjects === null
  const discoveredRows = useMemo(() => subjects ?? [], [subjects])
  // A stage turned off in the configuration never runs: its cells read
  // skipped, so a subject whose enabled stages finished counts as Done.
  const rows = useMemo(
    () => skipDisabledStages(discoveredRows, cfg),
    [discoveredRows, cfg],
  )
  const visibleRuns = runs
  const runtimeRunById = useMemo(
    () => new Map(props.runtimeRuns?.map((run) => [run.runId, run]) ?? []),
    [props.runtimeRuns],
  )
  const runtime = useRuntime()
  const runtimeRuns = props.runtimeRuns ?? runtime.runs
  // Until the runtime restore answers, the run history is unknown: an empty
  // manifest list then reads as loading, not as no runs recorded.
  const recentRunsLoading =
    runHistoryPhase === 'loading' ||
    (runHistoryPhase === 'ready' && runs.length === 0 && runtime.hydrating)
  const { runPlanRecords } = app
  const notRunRecords = useMemo(
    () => notRunRecordsByRun(runPlanRecords, runtime.jobs, runtimeRuns),
    [runPlanRecords, runtime.jobs, runtimeRuns],
  )
  // Logs focuses a run through one of its jobs, as its Run list does, so only
  // a durable run with a retained job opens there.
  const logsRunIds = useMemo(() => {
    const withJobs = new Set(runtime.jobs.map((job) => job.runId))
    return new Set(
      runtimeRuns
        .filter((run) => run.durable && withJobs.has(run.runId))
        .map((run) => run.runId),
    )
  }, [runtime.jobs, runtimeRuns])
  // Name the cohort stage that finished subjects wait on; without it a blocked
  // R analysis would leave every finished subject reading "Partly done". Manifests
  // carry plan-time blocks, so wait until the history is read.
  const cohortWait = useMemo(
    () =>
      runHistoryPhase === 'ready'
        ? cohortStageWait(rows, runtimeRuns, runtime.jobs, runs, cfg)
        : null,
    [rows, runtimeRuns, runtime.jobs, runs, runHistoryPhase, cfg],
  )
  // Say when Run all would repeat finished cohort stages, such as after QC
  // verdicts change the analysis cohort. The app shares one inventory read;
  // on its own the screen reads once the cohort and the history have loaded,
  // so the read never holds up the tiles.
  const currency = useProjectStageCurrency({
    project: projectRef,
    subjects: discoveredRows,
    runs: runtimeRuns,
    enabled: !loading && runHistoryPhase !== 'loading',
  })
  const reloadStageCurrency = currency.reload
  const currencyNotice = useMemo(
    () => stageCurrencyNotice(discoveredRows, currency),
    [discoveredRows, currency],
  )
  // Count, list, and flag subjects with out-of-date cells as unfinished, so
  // the tiles and Recent subjects agree with the notice and Runs. The wait
  // notice above keeps the unprojected rows: an out-of-date stage is not a
  // stage the subjects wait on.
  const displayRows = useMemo(
    () => applyStageCurrency(rows, currency),
    [rows, currency],
  )
  const counts = useMemo(() => tallySubjectBuckets(displayRows), [displayRows])
  const elsewhere = useMemo(
    () =>
      outdatedElsewhere(
        displayRows,
        cohortCurrencySubjectIds(discoveredRows, currency),
      ),
    [displayRows, discoveredRows, currency],
  )
  const recent = useMemo(() => recentSubjects(displayRows), [displayRows])
  // An optional stage's column shows only while the stage is on or holds a
  // result, as on Subjects.
  const matrixColumns = useMemo(
    () => shownMatrixColumns(cfg, displayRows),
    [cfg, displayRows],
  )
  const attention = useMemo(() => needsAttention(displayRows), [displayRows])

  const refresh = useCallback((): void => {
    if (props.refresh) props.refresh()
    else setReloadKey((n) => n + 1)
    reloadStageCurrency()
  }, [props, reloadStageCurrency])

  // With shell-owned subjects the stamp also moves when a rediscovery
  // answers, and the control shows that rediscovery's busy state.
  const shellOwned = props.subjects !== undefined
  const stampAt = latestTimestamp(
    lastUpdatedAt,
    shellOwned ? app.subjectsDiscoveredAt : null,
  )
  const refreshing = shellOwned
    ? app.subjectsDiscovering
    : subjects === null || runHistoryPhase === 'loading'

  const openSubjects = (filter: SubjectFilter): void => {
    setSubjectsFilter(filter)
    setRoute('subjects')
  }
  const tiles: StatTile[] = [
    {
      key: 'total',
      value: displayRows.length,
      label: 'Subjects',
      onClick: () => openSubjects('all'),
      ariaAction: 'Open all subjects.',
    },
    // Interrupted and Canceled get a tile only while a subject is in them.
    ...shownSubjectBuckets(counts).map((bucket) => {
      const tile = BUCKET_TILE[bucket]
      return {
        key: bucket,
        value: counts[bucket],
        label: SUBJECT_BUCKET_LABEL[bucket],
        // Open the Subjects filter of the same bucket, so its count matches.
        onClick: () => openSubjects(bucket),
        ariaAction: tile.ariaAction,
        status: tile.status,
        ...(tile.hint ? { hint: tile.hint } : {}),
        ...(tile.tip ? { tip: tile.tip } : {}),
        checking: !currency.checked && CURRENCY_BUCKETS.has(bucket),
        ...(bucket === 'outdated' && elsewhere ? { elsewhere } : {}),
      }
    }),
  ]

  const openSubjectQc = (id: string): void => {
    props.onActiveSubjectChange?.(id)
    setRoute('qc')
  }
  const openRunLogs = (runId: string): void => {
    setLogsFocusRunId(runId)
    setRoute('logs')
  }
  const headerActions = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        flexShrink: 0,
      }}
    >
      {stampAt && <FreshnessStamp t={t} at={stampAt} />}
      <RefreshButton
        t={t}
        ariaLabel="Refresh project"
        title={
          props.refresh
            ? 'Refresh project.'
            : 'Rediscover the cohort and runs from disk.'
        }
        busy={refreshing && !error}
        busyLabel="Refreshing the project..."
        onClick={refresh}
      />
    </span>
  )

  return (
    <Page t={t} title="Dashboard" right={headerActions}>
      {error ? (
        <ErrorState
          t={t}
          title="Could not load the dashboard."
          detail={error}
          onRetry={refresh}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* An empty project has nothing to count. */}
          {(loading || displayRows.length > 0) && (
            <StatBand t={t} tiles={tiles} loading={loading} />
          )}
          {!loading && cohortWait && (
            <CohortWaitNotice
              t={t}
              wait={cohortWait}
              onOpenRuns={() => setRoute('runs')}
            />
          )}
          {!loading && currencyNotice && (
            <CohortNotice
              t={t}
              attention
              headline={currencyNotice.headline}
              detail={currencyNotice.detail}
              actionTitle="Open Runs to review and rerun the out-of-date stages."
              onOpenRuns={() => setRoute('runs')}
            />
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1.6fr) minmax(320px, 1fr)',
              gap: 16,
              // Stretch both columns to one row, so they end level. Cap each
              // panel internally so spare height remains quiet background.
              alignItems: 'stretch',
            }}
          >
            <SubjectsPreview
              t={t}
              density={density}
              loading={loading}
              subjects={recent}
              columns={matrixColumns}
              activeSubjectId={props.activeSubjectId ?? null}
              onOpen={openSubjectQc}
              onViewAll={() => setRoute('subjects')}
              onOpenSetup={() => setRoute('wizard')}
            />

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
                minHeight: 0,
              }}
            >
              <RecentRuns
                t={t}
                loading={recentRunsLoading}
                failed={runHistoryPhase === 'error'}
                onRetry={refresh}
                runs={visibleRuns}
                runtimeRunById={runtimeRunById}
                notRunRecords={notRunRecords}
                logsRunIds={logsRunIds}
                onOpenRun={openRunLogs}
                onOpenRuns={() => setRoute('runs')}
                expanded={runsExpanded}
                onExpandedChange={setRunsExpanded}
                fill={!loading && recent.length === 0}
              />
              <NeedsAttention
                t={t}
                loading={loading}
                items={attention}
                onOpen={openSubjectQc}
                expanded={attentionExpanded}
                onExpandedChange={setAttentionExpanded}
                fill={!loading && recent.length === 0}
              />
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}

interface StatBandProps {
  t: Theme
  tiles: StatTile[]
  loading: boolean
}

/** The narrowest stat tile (px) and the gap between tiles (px). */
const STAT_TILE_MIN = 136
const STAT_TILE_GAP = 12

function StatBand({ t, tiles, loading }: StatBandProps): ReactNode {
  // The band holds 7 to 9 tiles. When they do not fit one row, wrap them into
  // even rows rather than leaving an orphaned tile beside empty space.
  const bandRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const node = bandRef.current
    if (!node) return undefined
    setWidth(node.clientWidth)
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const columns =
    width > 0
      ? `repeat(${balancedColumns(width, tiles.length, STAT_TILE_MIN, STAT_TILE_GAP)}, minmax(0, 1fr))`
      : `repeat(auto-fit, minmax(${STAT_TILE_MIN}px, 1fr))`
  return (
    <div
      ref={bandRef}
      style={{
        display: 'grid',
        gridTemplateColumns: columns,
        gap: STAT_TILE_GAP,
      }}
    >
      {tiles.map((tile) => (
        <StatTileButton key={tile.key} t={t} tile={tile} loading={loading} />
      ))}
      <span
        // Announce this element's own text without adding a redundant live-region
        // name.
        aria-live="polite"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {loading
          ? 'Subject status counts are loading.'
          : tiles
              .map(
                (tile) =>
                  `${tile.label} ${tile.checking ? 'checking' : tile.value}`,
              )
              .join(', ')}
      </span>
    </div>
  )
}

interface StatTileButtonProps {
  t: Theme
  tile: StatTile
  loading: boolean
}

function StatTileButton({ t, tile, loading }: StatTileButtonProps): ReactNode {
  const [hover, setHover] = useState(false)
  const base: CSSProperties = {
    display: 'flex',
    gap: 8,
    alignItems: 'baseline',
    justifyContent: 'space-between',
    textAlign: 'left',
    padding: '8px 12px',
    minHeight: 44,
    borderRadius: 6,
    border: `1px solid ${hover ? t.borderStrong : t.borderSoft}`,
    background: hover ? t.surface2 : t.surface,
    cursor: 'pointer',
    transition: 'background .12s, border-color .12s',
  }
  // Tint nonzero status totals consistently. Keep zero and neutral totals
  // de-emphasized.
  const pending = loading || tile.checking === true
  // A subject count the tile does not hold is stated only once it is read.
  const elsewhere = pending ? undefined : tile.elsewhere
  const numberColor = pending
    ? t.dimText
    : tile.value === 0
      ? t.dimText
      : tile.status
        ? tile.status === 'pending'
          ? t.dimText
          : statusColor(t, tile.status)
        : t.textStrong
  return (
    <button
      type="button"
      onClick={tile.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // While the cohort loads the name says so instead of counting the
      // empty list the tile draws as "--".
      aria-label={`${tile.ariaAction.slice(0, -1)} (${tile.label}: ${
        loading
          ? 'loading'
          : tile.checking
            ? 'checking stage currency'
            : tile.value
      }).${tile.hint ? ` ${tile.hint}` : ''}${
        tile.checking ? ` ${CURRENCY_CHECKING_FACT}` : ''
      }${elsewhere ? ` ${elsewhere.fact}` : ''}`}
      title={[
        tile.ariaAction,
        tile.hint ?? tile.tip,
        tile.checking ? CURRENCY_CHECKING_FACT : undefined,
        elsewhere?.fact,
      ]
        .filter(Boolean)
        .join(' ')}
      style={base}
    >
      <span
        style={{
          fontFamily: FONTS.sans,
          fontSize: 12,
          fontWeight: 700,
          color: t.text,
          whiteSpace: 'nowrap',
        }}
      >
        {tile.label}
      </span>
      <span
        style={{
          display: 'flex',
          alignItems: 'baseline',
          flexDirection: 'row-reverse',
          gap: 8,
          minWidth: 0,
        }}
      >
        {/* A count reads as prose, so it takes the sans face. */}
        <span
          style={{
            fontFamily: FONTS.sans,
            fontSize: 20,
            lineHeight: '26px',
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            color: numberColor,
          }}
        >
          {pending ? '--' : tile.value}
        </span>
        {elsewhere && (
          // The fact is in the tile's name and tooltip; the note shows it.
          <span
            aria-hidden
            style={{
              minWidth: 0,
              fontFamily: FONTS.sans,
              fontSize: 11,
              color: t.dim,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {elsewhere.note}
          </span>
        )}
      </span>
    </button>
  )
}

interface SubjectsPreviewProps {
  t: Theme
  density: Density
  loading: boolean
  subjects: Subject[]
  /** The status columns shown, each with its cell index. */
  columns: readonly MatrixColumn[]
  activeSubjectId: string | null
  onOpen: (id: string) => void
  onViewAll?: () => void
  onOpenSetup?: (() => void) | undefined
}

interface DashboardPanelProps {
  t: Theme
  title: string
  sub?: string | undefined
  action?: ReactNode | undefined
  expanded: boolean
  canExpand: boolean
  expandLabel: string
  collapseLabel: string
  onExpandedChange: (next: boolean) => void
  children: ReactNode
  bodyStyle?: CSSProperties | undefined
  fill?: boolean | undefined
  /** Whether the header grows and wraps its action below the title. */
  wrapHeader?: boolean | undefined
}

function DashboardPanel({
  t,
  title,
  sub,
  action,
  expanded,
  canExpand,
  expandLabel,
  collapseLabel,
  onExpandedChange,
  children,
  bodyStyle,
  fill,
  wrapHeader,
}: DashboardPanelProps): ReactNode {
  const expandAction = canExpand ? (
    <IconButton
      t={t}
      d={expanded ? ICONS.dash : ICONS.plus}
      ariaLabel={expanded ? collapseLabel : expandLabel}
      onClick={() => onExpandedChange(!expanded)}
    />
  ) : null
  const headerAction =
    action || expandAction ? (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {action}
        {expandAction}
      </span>
    ) : undefined

  return (
    <Card
      t={t}
      title={title}
      padded={false}
      {...(sub ? { sub } : {})}
      {...(headerAction ? { action: headerAction } : {})}
      {...(fill ? { style: { flex: 1, minHeight: 0 } } : {})}
      {...(wrapHeader ? { wrapHeader } : {})}
    >
      <div
        style={{
          padding: 12,
          minHeight: 0,
          // The card body is a block, so take its height to center a child.
          ...(fill
            ? {
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                boxSizing: 'border-box',
              }
            : {}),
          ...bodyStyle,
        }}
      >
        {children}
      </div>
    </Card>
  )
}

/** The tone of a Recent runs row's icon. */
function runIconColor(t: Theme, icon: RunIcon): string {
  switch (icon) {
    case 'in-progress':
      return t.running
    case 'dry-run':
      return t.dim
    case 'storage-error':
      return t.warning
    default:
      return statusGlyphColor(t, icon)
  }
}

/** The glyph of a Recent runs row's icon, drawn in its tone. */
function runIconGlyph(t: Theme, icon: RunIcon, color: string): ReactNode {
  switch (icon) {
    case 'in-progress':
      // The legend's running ring, pulsing because the run is live.
      return <StatusGlyph st="running" t={t} color={color} />
    case 'dry-run':
      // The legend's planned ring in the neutral tone: the plan holds a place
      // for each node, and none of them runs.
      return <StatusGlyph st="planned" t={t} animate={false} color={color} />
    case 'storage-error':
      // Drawn at the size of the legend's glyphs beside it.
      return <Ico d={ICONS.circleAlert} stroke={color} />
    default:
      return <StatusGlyph st={icon} t={t} animate={false} />
  }
}

/**
 * Draw a Recent runs row's icon: a settled outcome as the matrix legend draws
 * its state, a run in progress as a pulsing dot, a dry-run plan as a neutral
 * ring, and a storage error as a warning sign.
 */
function RunStatusIcon(props: {
  t: Theme
  icon: RunIcon
  label: string
}): ReactNode {
  const { t, icon, label } = props
  const color = runIconColor(t, icon)
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-nontext-contrast="status-glyph"
      style={{
        width: DASHBOARD_ICON_BOX_SIZE,
        height: DASHBOARD_ICON_BOX_SIZE,
        display: 'grid',
        placeItems: 'center',
        color,
        flexShrink: 0,
      }}
    >
      {runIconGlyph(t, icon, color)}
    </span>
  )
}

function SubjectsPreview({
  t,
  density,
  loading,
  subjects,
  columns,
  activeSubjectId,
  onOpen,
  onViewAll,
  onOpenSetup,
}: SubjectsPreviewProps): ReactNode {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const visible = subjects.slice(0, SUBJECT_PREVIEW_LIMIT)
  const rowHeight = DASHBOARD_ROW_HEIGHT
  const statusColumnWidths = columns.map(({ step }) =>
    recentSubjectStepWidth(step.key),
  )
  const tableMinWidth =
    SUBJECT_COLUMN_WIDTH +
    statusColumnWidths.reduce((sum, width) => sum + width, 0) +
    SUBJECT_TABLE_ROW_PADDING
  // Bound the subject column so the first status sits near the names, and
  // spread the status columns evenly over the remaining width.
  const cols = [
    `minmax(${SUBJECT_COLUMN_WIDTH}px, 200px)`,
    ...statusColumnWidths.map((width) => `minmax(${width}px, 1fr)`),
  ].join(' ')
  const sub = loading ? 'loading' : undefined
  const [edges, scrollRef] = useHiddenEdges()
  // Pin the Subject column so every row keeps its name while the status
  // columns scroll beneath it at narrow window widths.
  const pinnedCell: CSSProperties = {
    position: 'sticky',
    left: 0,
    zIndex: 1,
    alignSelf: 'stretch',
  }
  return (
    <DashboardPanel
      t={t}
      title="Recent subjects"
      sub={sub}
      {...(visible.length > 0
        ? {
            action: <StatusLegend t={t} states={matrixCellStates(visible)} />,
          }
        : {})}
      // The legend does not fit beside the title and the loading tag at
      // narrow widths and 135% text, so the header grows and wraps the
      // legend below the title.
      wrapHeader
      // An empty project stretches the card to the side column's height.
      fill={!loading && subjects.length === 0}
      expanded={false}
      canExpand={false}
      expandLabel="Show more recent subjects."
      collapseLabel="Show fewer recent subjects."
      onExpandedChange={() => undefined}
    >
      {loading ? (
        <Skeleton t={t} lines={6} />
      ) : subjects.length === 0 ? (
        <EmptyState
          t={t}
          icon="subjects"
          message="No subjects found yet."
          hint="Point Setup at a BIDS or derivatives folder."
          action={
            onOpenSetup ? (
              <Btn
                t={t}
                small
                ghost
                icon={<Ico d={ICONS.sliders} size={ICON_SIZE.nav} />}
                label="Open Setup"
                title="Open the Setup wizard to set where your data lives, then refresh."
                onClick={onOpenSetup}
              />
            ) : undefined
          }
          compact
        />
      ) : (
        <>
          {/* While columns are hidden to the right, reserve a gutter for
              the scroll chevron, so it never covers the last visible column.
              The table keeps its full width when it fits. */}
          <div
            style={{
              position: 'relative',
              maxWidth: '100%',
              paddingRight: edges.right ? SCROLL_HINT_GUTTER : 0,
            }}
          >
            <div
              ref={scrollRef}
              role="region"
              aria-label="Recent subjects table"
              tabIndex={0}
              // Reserve no scrollbar gutter here: a gutter on both edges keeps
              // the last column out of reach and the end hint over it.
              style={{
                overflowY: 'auto',
                overflowX: 'auto',
                paddingBottom: 2,
              }}
            >
              <div
                role="table"
                aria-label="Recent subjects status matrix"
                style={{
                  width: `max(100%, ${tableMinWidth}px)`,
                  minWidth: tableMinWidth,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: DASHBOARD_ROW_GAP,
                }}
              >
                <div
                  role="row"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: cols,
                    alignItems: 'center',
                    minHeight: 48,
                    fontFamily: FONTS.sans,
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: t.dim,
                    padding: '0 6px 5px 8px',
                    position: 'sticky',
                    top: 0,
                    // Stay above the pinned row cells when rows scroll up.
                    zIndex: 2,
                    background: t.surface,
                    borderBottom: `1px solid ${t.borderSoft}`,
                  }}
                >
                  <span
                    role="columnheader"
                    style={{
                      ...pinnedCell,
                      display: 'flex',
                      alignItems: 'center',
                      background: t.surface,
                    }}
                  >
                    Subject
                  </span>
                  {columns.map(({ step }) => (
                    <span
                      key={step.key}
                      role="columnheader"
                      aria-label={recentSubjectStepLabel(step.key)}
                      title={MATRIX_STEP_HELP[step.key]}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minHeight: 40,
                        textAlign: 'center',
                        whiteSpace: 'normal',
                        lineHeight: 1.05,
                      }}
                    >
                      {recentSubjectStepLabelLines(step.key).map((line) => (
                        <span key={line} style={{ whiteSpace: 'nowrap' }}>
                          {line}
                        </span>
                      ))}
                    </span>
                  ))}
                </div>
                {visible.map((subject) => {
                  const edge = subjectEdgeColor(t, subject)
                  const active = subject.id === activeSubjectId
                  const highlighted = active || hoveredId === subject.id
                  // Keep the pinned cell opaque over the columns scrolled
                  // beneath it, matching the row's highlight.
                  const rowBackground = highlighted ? t.surface2 : t.surface
                  const auxiliaryStatus = subjectAuxiliaryDisplayStatus(subject)
                  const auxiliaryStep = auxiliaryStatus
                    ? pipelineStep(auxiliaryStatus.stepKey)
                    : null
                  return (
                    <div
                      key={subject.id}
                      role="row"
                      onDoubleClick={() => onOpen(subject.id)}
                      onMouseEnter={() => setHoveredId(subject.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: cols,
                        alignItems: 'center',
                        height: rowHeight,
                        borderLeft: `2px solid ${edge}`,
                        padding: DASHBOARD_ROW_PADDING,
                        background: highlighted ? t.surface2 : 'transparent',
                        cursor: 'pointer',
                        borderRadius: DASHBOARD_ROW_RADIUS,
                      }}
                    >
                      <span
                        role="rowheader"
                        style={{
                          ...pinnedCell,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 5,
                          minWidth: 0,
                          background: rowBackground,
                        }}
                      >
                        <button
                          type="button"
                          aria-label={`Open ${subject.id} in QC review`}
                          title={`Open ${subject.id} in QC review`}
                          onClick={() => onOpen(subject.id)}
                          onFocus={() => setHoveredId(subject.id)}
                          onBlur={() => setHoveredId(null)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 5,
                            minWidth: 0,
                            minHeight: 24,
                            width: '100%',
                            background: 'transparent',
                            border: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            textAlign: 'left',
                            fontFamily: FONTS.mono,
                            fontSize: 12.5,
                            color: t.text,
                          }}
                        >
                          <span
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {subject.id}
                          </span>
                          {auxiliaryStatus && auxiliaryStep && (
                            <span
                              role="img"
                              aria-label={`${auxiliaryStep.name}: ${cellStateLabel(auxiliaryStatus.state)}`}
                              title={`${spelledOutStepName(auxiliaryStep.key)}: ${cellStateLabel(auxiliaryStatus.state)}`}
                              // Draw the matrix glyph of the state, so a stage
                              // without a column reads like its cells do.
                              data-nontext-contrast="status-glyph"
                              style={{
                                width: 18,
                                height: 18,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 2,
                                flexShrink: 0,
                                color: statusGlyphColor(
                                  t,
                                  auxiliaryStatus.state,
                                ),
                              }}
                            >
                              <StatusGlyph st={auxiliaryStatus.state} t={t} />
                            </span>
                          )}
                          <Ico
                            d={ICONS.chevron}
                            stroke={t.dim}
                            style={{
                              flexShrink: 0,
                              opacity:
                                active || hoveredId === subject.id ? 1 : 0,
                              transition: 'opacity .12s',
                            }}
                          />
                        </button>
                      </span>
                      {columns.map(({ step, index }) => {
                        const cell = subject.cells[index]
                        return (
                          <span
                            key={step.key}
                            role="cell"
                            style={{
                              display: 'flex',
                              justifyContent: 'center',
                            }}
                          >
                            {cell ? (
                              <StatusCell
                                cell={cell}
                                density={density}
                                t={t}
                                stepLabel={recentSubjectStepLabel(step.key)}
                              />
                            ) : null}
                          </span>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>
            <ScrollEdgeHints
              t={t}
              edges={edges}
              ground={t.surface}
              pinnedWidth={SUBJECT_COLUMN_WIDTH}
              gutter={SCROLL_HINT_GUTTER}
            />
          </div>
          {onViewAll && subjects.length > SUBJECT_PREVIEW_LIMIT && (
            <Btn
              t={t}
              ghost
              small
              onClick={onViewAll}
              label={`View all ${subjects.length} subjects`}
              icon={<Ico d={ICONS.chevron} size={ICON_SIZE.nav} />}
              style={{ alignSelf: 'flex-start', marginTop: 8 }}
            />
          )}
        </>
      )}
    </DashboardPanel>
  )
}

interface RecentRunsProps {
  t: Theme
  loading: boolean
  failed: boolean
  onRetry: () => void
  runs: RunManifest[]
  runtimeRunById: ReadonlyMap<string, RunSnapshot>
  /** The plan nodes and jobs at hand for each run; see notRunRecordsByRun. */
  notRunRecords: ReadonlyMap<string, readonly NotRunRecord[]>
  /** The runs Logs can focus: durable runs with a retained job. */
  logsRunIds: ReadonlySet<string>
  /** Open Logs focused on a run. */
  onOpenRun: (runId: string) => void
  /** Open Runs from the empty history. */
  onOpenRuns: () => void
  expanded: boolean
  onExpandedChange: (next: boolean) => void
  /** Share the column's height in an empty project; see NeedsAttention. */
  fill?: boolean
}

function RecentRuns({
  t,
  loading,
  failed,
  onRetry,
  runs,
  runtimeRunById,
  notRunRecords,
  logsRunIds,
  onOpenRun,
  onOpenRuns,
  expanded,
  onExpandedChange,
  fill,
}: RecentRunsProps): ReactNode {
  const visible = expanded ? runs : runs.slice(0, RUN_PREVIEW_LIMIT)
  const canExpand = runs.length > RUN_PREVIEW_LIMIT
  const listHeight = fixedPreviewListHeight(
    RUN_PREVIEW_LIMIT,
    DASHBOARD_ROW_HEIGHT,
    DASHBOARD_ROW_GAP,
  )
  const sub = loading ? 'loading' : undefined
  return (
    <DashboardPanel
      t={t}
      title="Recent runs"
      sub={sub}
      expanded={expanded}
      canExpand={canExpand}
      expandLabel="Show more recent runs."
      collapseLabel="Show fewer recent runs."
      onExpandedChange={onExpandedChange}
      fill={fill}
    >
      {loading ? (
        <Skeleton t={t} lines={3} />
      ) : failed ? (
        <ErrorState
          t={t}
          title="Could not read the run history."
          detail="The run history is unknown, so this panel may not be empty."
          onRetry={onRetry}
        />
      ) : runs.length === 0 ? (
        <EmptyState
          t={t}
          icon="runs"
          message="No runs yet."
          action={
            <Btn
              t={t}
              small
              ghost
              label="Open Runs"
              title="Open Runs to plan and start the first run."
              onClick={onOpenRuns}
            />
          }
          compact
        />
      ) : (
        <div
          role="list"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: DASHBOARD_ROW_GAP,
            height: listHeight,
            overflowY: 'auto',
            scrollbarGutter: 'stable both-edges',
          }}
        >
          {visible.map((run) => (
            <RecentRunRow
              key={run.runId}
              t={t}
              display={runDisplay(
                run,
                runtimeRunById.get(run.runId),
                notRunRecords.get(run.runId) ?? [],
              )}
              {...(logsRunIds.has(run.runId)
                ? { onOpen: () => onOpenRun(run.runId) }
                : {})}
            />
          ))}
        </div>
      )}
    </DashboardPanel>
  )
}

/**
 * One Recent runs row. A run that Logs can focus is a button that opens it
 * there; any other run, such as one blocked while planning, which has no job,
 * reads the same without an action.
 */
function RecentRunRow({
  t,
  display,
  onOpen,
}: {
  t: Theme
  display: RunDisplay
  onOpen?: () => void
}): ReactNode {
  const [hover, setHover] = useState(false)
  const summary = [display.title, display.detail].filter(Boolean).join(TEXT_GAP)
  const timing = display.timing
  const row: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: DASHBOARD_ROW_PADDING,
    height: DASHBOARD_ROW_HEIGHT,
    border: `1px solid ${hover ? t.borderStrong : t.borderSoft}`,
    borderRadius: DASHBOARD_ROW_RADIUS,
    background: t.surface2,
  }
  const content = (
    <>
      <RunStatusIcon t={t} icon={display.icon} label={display.iconLabel} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span
          style={{
            display: 'block',
            fontFamily: FONTS.sans,
            fontSize: 12,
            lineHeight: 1.1,
            fontWeight: 700,
            color: t.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {display.title}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 1,
            fontFamily: FONTS.sans,
            fontSize: 10.5,
            lineHeight: 1.1,
            color: t.dim,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {display.detail}
        </span>
      </span>
    </>
  )
  if (!onOpen) {
    return (
      <div
        role="listitem"
        title={[summary, timing].filter(Boolean).join('. ')}
        aria-label={[display.title, timing, display.detail]
          .filter(Boolean)
          .join('. ')}
        style={row}
      >
        {content}
      </div>
    )
  }
  return (
    <div role="listitem">
      <button
        type="button"
        onClick={onOpen}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-label={`Open this run in Logs (${[
          display.title,
          timing,
          display.detail,
        ]
          .filter(Boolean)
          .join('. ')}).`}
        title={`${[summary, timing].filter(Boolean).join('. ')}. Open this run in Logs.`}
        style={{
          ...row,
          width: '100%',
          margin: 0,
          textAlign: 'left',
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
          transition: 'border-color .12s',
          outlineOffset: DASHBOARD_ROW_FOCUS_OFFSET,
        }}
      >
        {content}
      </button>
    </div>
  )
}

interface NeedsAttentionProps {
  t: Theme
  loading: boolean
  items: AttentionItem[]
  onOpen: (id: string) => void
  expanded: boolean
  onExpandedChange: (next: boolean) => void
  /**
   * Split the side column's height with the other side card. An empty project
   * sets it, so the two short cards end level with Recent subjects.
   */
  fill?: boolean
}

function NeedsAttention({
  t,
  loading,
  items,
  onOpen,
  expanded,
  onExpandedChange,
  fill,
}: NeedsAttentionProps): ReactNode {
  const rowId = useId()
  const visible = expanded ? items : items.slice(0, ATTENTION_PREVIEW_LIMIT)
  const canExpand = items.length > ATTENTION_PREVIEW_LIMIT
  const listHeight = fixedPreviewListHeight(
    ATTENTION_PREVIEW_LIMIT,
    DASHBOARD_ROW_HEIGHT,
    DASHBOARD_ROW_GAP,
  )
  // Grow the list to five rows, then scroll internally. Avoid both page growth
  // for many failures and excess panel height for a short list.
  const listSizing: CSSProperties = { maxHeight: listHeight }
  // Count by state: an interrupted or canceled step did not fail.
  const counted = attentionCountPhrase(items)
  const sub = loading
    ? 'loading'
    : items.length === 0
      ? undefined
      : canExpand && !expanded
        ? `${visible.length} of ${items.length} shown: ${counted}`
        : counted
  return (
    <DashboardPanel
      t={t}
      title="Needs attention"
      sub={sub}
      expanded={expanded}
      canExpand={canExpand}
      expandLabel="Show more subjects needing attention."
      collapseLabel="Show fewer subjects needing attention."
      onExpandedChange={onExpandedChange}
      fill={fill}
    >
      {loading ? (
        <Skeleton t={t} lines={3} />
      ) : items.length === 0 ? (
        <EmptyState
          t={t}
          icon="check"
          message="No subjects need attention."
          compact
        />
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: DASHBOARD_ROW_GAP,
            ...listSizing,
            overflowY: 'auto',
            scrollbarGutter: 'stable both-edges',
          }}
        >
          {visible.map(({ subject, attention }, index) => {
            const tone = statusColor(t, BUCKET_TILE[attention.bucket].status)
            const failed = attention.bucket === 'failed'
            const step = attention.column
              ? attentionStepLabel(attention.column)
              : attention.stepKey
                ? pipelineStep(attention.stepKey).name
                : null
            const stepId = `${rowId}-${index}`
            // State the reason as Logs does; the ellipsized line keeps the
            // whole sentence in its title.
            const reason = failureReasonText(attention.cell?.err)
            return (
              <button
                key={subject.id}
                type="button"
                onClick={() => onOpen(subject.id)}
                aria-label={`Open ${subject.id} in QC review`}
                aria-describedby={stepId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  width: '100%',
                  textAlign: 'left',
                  padding: DASHBOARD_ROW_PADDING,
                  height: DASHBOARD_ROW_HEIGHT,
                  borderRadius: DASHBOARD_ROW_RADIUS,
                  border: `1px solid ${t.borderSoft}`,
                  borderLeft: `2px solid ${tone}`,
                  background: t.surface2,
                  cursor: 'pointer',
                  outlineOffset: DASHBOARD_ROW_FOCUS_OFFSET,
                }}
              >
                <span
                  style={{
                    fontFamily: FONTS.mono,
                    fontSize: 11.5,
                    color: t.text,
                    flexShrink: 0,
                  }}
                >
                  {subject.id}
                </span>
                <span
                  id={stepId}
                  title={attentionStepText(attention)}
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 10.75,
                    color: t.dim,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {step && <span>{step}</span>}
                  {step && ' '}
                  <span style={{ color: t.text }}>
                    {cellStateLabel(attention.state)}
                  </span>
                </span>
                {reason && (
                  <span
                    title={reason}
                    style={{
                      fontFamily: FONTS.sans,
                      fontSize: 10.5,
                      // Only a failure reason reads in the failure color.
                      color: failed ? t.failed : t.dim,
                      flex: 1,
                      minWidth: 0,
                      textAlign: 'right',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {reason}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </DashboardPanel>
  )
}

interface SkeletonProps {
  t: Theme
  lines: number
}

/** Keep the loading placeholder static for reduced-motion safety. */
function Skeleton({ t, lines }: SkeletonProps): ReactNode {
  return (
    <div
      role="status"
      aria-label="Loading"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          style={{
            height: 14,
            width: `${90 - i * 8}%`,
            background: t.surface3,
            borderRadius: 4,
          }}
        />
      ))}
    </div>
  )
}
