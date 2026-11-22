import type { RunSnapshot } from '../../shared/contract'
import type { JobStatus, RunManifest } from '../../shared/types'
import { TEXT_GAP } from '../ui/text-gap'

const RUN_TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
}

const INTENT_LABEL: Record<NonNullable<RunManifest['intent']>, string> = {
  workflow: 'workflow',
  stage: 'stage',
  resume: 'resume',
  retry: 'retry',
}

/** Lowercase status nouns for naming a run inside dialog and hint prose. */
const RUN_STATUS_NOUN: Record<JobStatus, string> = {
  planned: 'planned',
  waiting: 'waiting',
  queued: 'queued',
  running: 'running',
  cancelling: 'canceling',
  done: 'completed',
  failed: 'failed',
  cancelled: 'canceled',
  blocked: 'blocked',
  withheld: 'withheld',
  interrupted: 'interrupted',
  stale: 'stale',
  'persistence-error': 'storage-error',
  unknown: 'unresolved',
}

function subjectCount(count: number): string {
  return `${count} subject${count === 1 ? '' : 's'}`
}

/**
 * Format a run timestamp with seconds so same-minute runs stay apart.
 *
 * @param value - An ISO string, epoch milliseconds, or null.
 * @returns The localized timestamp or the unknown-time fallback.
 */
export function runTimestampLabel(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined || value === '') {
    return 'an unrecorded time'
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'an unrecorded time'
  return new Intl.DateTimeFormat(undefined, RUN_TIMESTAMP_FORMAT).format(date)
}

/**
 * Derive how a durable run ended from the stage states it recorded.
 *
 * A manifest carries no run-level status, so read the terminal state from
 * its stages. Keep blocked work out of the completed state even when the run
 * reached a terminal timestamp without launching a tool.
 *
 * @returns The lowercase status noun for this run.
 */
export function manifestRunStatus(manifest: RunManifest): string {
  const steps = manifest.steps ?? []
  if (steps.some((step) => step.status === 'blocked')) {
    return RUN_STATUS_NOUN.blocked
  }
  if (steps.some((step) => step.status === 'withheld')) {
    return RUN_STATUS_NOUN.withheld
  }
  if (manifest.recovery?.state === 'interrupted') {
    return RUN_STATUS_NOUN.interrupted
  }
  if (steps.some((step) => step.status === 'cancelled')) {
    return RUN_STATUS_NOUN.cancelled
  }
  if (steps.some((step) => step.status === 'failed' || step.failed > 0)) {
    return RUN_STATUS_NOUN.failed
  }
  if (!manifest.endedAt) return RUN_STATUS_NOUN.running
  return RUN_STATUS_NOUN.done
}

/**
 * Build the shared human run-picker label without the raw run identifier.
 *
 * @returns The run window, status, intent, scope, and dry-run label.
 */
export function manifestRunLabel(manifest: RunManifest): string {
  // Keep the start time first so a label sorts the same way the picker does.
  const started = runTimestampLabel(manifest.startedAt)
  const window = manifest.endedAt
    ? `${started} to ${runTimestampLabel(manifest.endedAt)}`
    : started
  const parts = [window, manifestRunStatus(manifest)]
  if (manifest.intent) parts.push(INTENT_LABEL[manifest.intent])
  const subjects = manifest.selectedSubset?.subjectIds.length
  if (subjects !== undefined) parts.push(subjectCount(subjects))
  if (manifest.dryRun) parts.push('dry run')
  return parts.join(TEXT_GAP)
}

/**
 * Name a durable run inside prose without the raw run identifier.
 *
 * @returns The phrase "run started ..." for sentence composition.
 */
export function manifestRunPhrase(manifest: RunManifest): string {
  const dryRun = manifest.dryRun ? ' (dry run)' : ''
  return `run started ${runTimestampLabel(manifest.startedAt)}${dryRun}`
}

/**
 * Name a runtime run by status, start time, and scope for dialog prose.
 *
 * @returns The phrase "<status> run started ..." with its scope.
 */
export function snapshotRunLabel(snapshot: RunSnapshot): string {
  const scope: string[] = []
  const subjects =
    snapshot.selectedSubjectIds?.length ?? snapshot.analysisSubjectIds?.length
  if (subjects !== undefined) scope.push(subjectCount(subjects))
  if (snapshot.dryRun) scope.push('dry run')
  const scopeSuffix = scope.length > 0 ? ` (${scope.join(', ')})` : ''
  const started = runTimestampLabel(snapshot.startedAt)
  return `${RUN_STATUS_NOUN[snapshot.status]} run started ${started}${scopeSuffix}`
}
