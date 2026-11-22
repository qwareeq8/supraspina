/**
 * Centralizes status presentation in the shared UI layer, keeping the Subjects,
 * Runs, Setup, and Dashboard screens consistent through one implementation.
 */

import type { MatrixStepKey } from '../../shared/steps'
import type { CellState, Subject } from '../../shared/types'
import { subjectDisplayBucket } from '../state/subject-runtime-status'
import { terminalReasonText } from '../state/terminal-reason'
import type { Theme } from '../theme/tokens'
import { statusColor } from '../theme/tokens'

/** The theme colors a status glyph draws in. */
type GlyphToken = 'dim' | 'running' | 'warning' | 'done' | 'failed' | 'skipped'

/** The theme color each cell state draws its glyph in. */
const STATE_TOKEN: Record<CellState, GlyphToken> = {
  pending: 'dim',
  planned: 'running',
  waiting: 'running',
  queued: 'running',
  running: 'running',
  cancelling: 'warning',
  done: 'done',
  failed: 'failed',
  cancelled: 'skipped',
  blocked: 'warning',
  withheld: 'warning',
  // Interrupted work did not fail and resumes: amber, as its Dashboard tile,
  // progress segment, and row edge draw it. Red stays for failures.
  interrupted: 'warning',
  stale: 'warning',
  skipped: 'skipped',
  outdated: 'warning',
}

/** The name of a status glyph's shape. */
export type StatusGlyphShape =
  | 'ring'
  | 'dashed-ring'
  | 'ellipsis-ring'
  | 'clock'
  | 'progress-ring'
  | 'dashed-stop-ring'
  | 'check-ring'
  | 'cross-ring'
  | 'stop-ring'
  | 'prohibited'
  | 'pause'
  | 'bolt'
  | 'question'
  | 'minus-ring'
  | 'rerun'

/**
 * The shape each cell state draws: the same ring with a mark of its own, so
 * every glyph has one size and outline, and states that share a color, such
 * as the blue planned, waiting, queued, and running states, still read apart
 * without color (WCAG 1.4.1).
 */
const STATE_SHAPE: Record<CellState, StatusGlyphShape> = {
  pending: 'ring',
  planned: 'dashed-ring',
  waiting: 'ellipsis-ring',
  queued: 'clock',
  running: 'progress-ring',
  cancelling: 'dashed-stop-ring',
  done: 'check-ring',
  failed: 'cross-ring',
  cancelled: 'stop-ring',
  blocked: 'prohibited',
  withheld: 'pause',
  interrupted: 'bolt',
  stale: 'question',
  skipped: 'minus-ring',
  outdated: 'rerun',
}

/**
 * Return the shape a cell state draws, shared by matrix cells and the legend.
 *
 * @returns The shape name; no two states share one.
 * @example
 * statusGlyphShape('waiting') // 'ellipsis-ring'
 */
export function statusGlyphShape(st: CellState): StatusGlyphShape {
  return STATE_SHAPE[st]
}

/** Return the color a cell state draws its glyph in. */
export function statusGlyphColor(t: Theme, st: CellState): string {
  return t[STATE_TOKEN[st]]
}

/** The soft fill of each glyph tone, for a badge that carries the glyph. */
const SOFT_TOKEN: Record<GlyphToken, keyof Theme> = {
  dim: 'pendingSoft',
  running: 'runningSoft',
  warning: 'warningSoft',
  done: 'doneSoft',
  failed: 'failedSoft',
  skipped: 'skippedSoft',
}

/**
 * Return the soft fill of a cell state's glyph tone, so a badge that draws the
 * legend glyph sits on a tint of the same tone. The glyph keeps 3:1 or better
 * on it over the page, panel, and selected-row fills.
 *
 * @example
 * statusGlyphSoft(theme, 'interrupted') // theme.warningSoft
 */
export function statusGlyphSoft(t: Theme, st: CellState): string {
  return t[SOFT_TOKEN[STATE_TOKEN[st]]]
}

/** Fixed status-column widths for the wrapped headers. */
export const RECENT_SUBJECT_STEP_WIDTHS: Record<MatrixStepKey, number> = {
  recon: 80,
  qcsub: 62,
  qcic: 60,
  qcec: 60,
  feat: 64,
  pba: 62,
  norm: 70,
  stats: 58,
  agg: 64,
  rep: 50,
}

/** Readable, wrappable header lines for each matrix step. */
export const RECENT_SUBJECT_STEP_LABEL_LINES: Record<
  MatrixStepKey,
  readonly string[]
> = {
  recon: ['Reconstruction'],
  qcsub: ['Subcortical', 'QC'],
  qcic: ['Internal', 'cortical', 'QC'],
  qcec: ['External', 'cortical', 'QC'],
  feat: ['Feature', 'extraction'],
  pba: ['PyBrainAge'],
  norm: ['BrainCharts'],
  stats: ['Statistics'],
  agg: ['Aggregation'],
  rep: ['Report'],
}

/** The readable name of each matrix cell state in titles and names. */
const CELL_STATE_LABEL: Record<CellState, string> = {
  pending: 'pending',
  planned: 'planned',
  waiting: 'waiting',
  queued: 'queued',
  running: 'running',
  cancelling: 'canceling',
  done: 'done',
  failed: 'failed',
  cancelled: 'canceled',
  blocked: 'blocked',
  withheld: 'withheld',
  interrupted: 'interrupted',
  stale: 'status unknown',
  skipped: 'skipped',
  outdated: 'out of date',
}

/**
 * Return the readable name of a matrix cell state, shared by the matrix
 * cells of Subjects and the Dashboard.
 *
 * @returns The lowercase state name, such as `out of date`.
 */
export function cellStateLabel(st: CellState): string {
  return CELL_STATE_LABEL[st]
}

/** Return a single-line label for a matrix step. */
export function recentSubjectStepLabel(key: MatrixStepKey): string {
  return RECENT_SUBJECT_STEP_LABEL_LINES[key].join(' ')
}

/** Return header lines that fit narrow status columns. */
export function recentSubjectStepLabelLines(
  key: MatrixStepKey,
): readonly string[] {
  return RECENT_SUBJECT_STEP_LABEL_LINES[key]
}

/**
 * Return the fixed width for a status column.
 *
 * @returns The status-column width in pixels.
 */
export function recentSubjectStepWidth(key: MatrixStepKey): number {
  return RECENT_SUBJECT_STEP_WIDTHS[key]
}

/**
 * Format an age at scan as whole years for display. The registry keeps the
 * value as entered, for example two decimals from a CSV import, and the
 * analyses use it unrounded; lists show completed years so every subject
 * reads alike.
 *
 * @param age - The age in years, or null when unrecorded.
 * @returns The completed years, or the unknown text.
 */
export function formatAgeYears(age: number | null, unknown = '-'): string {
  if (age === null || !Number.isFinite(age)) return unknown
  return String(Math.floor(age))
}

/**
 * Format a run timestamp for status rows.
 *
 * @param value - The timestamp, or null when unavailable.
 * @returns The localized run time or the unknown-time fallback.
 */
export function formatRunTime(value: string | null): string {
  if (!value) return 'unknown time'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'unknown time'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

/** Collect the cell states a status matrix shows, for its legend. */
export function matrixCellStates(
  subjects: readonly Subject[],
): ReadonlySet<CellState> {
  const states = new Set<CellState>()
  for (const subject of subjects) {
    for (const cell of subject.cells) states.add(cell.st)
  }
  return states
}

/**
 * Return the left-edge color for a subject row. Use `failed` for failed rows,
 * the `interrupted` and `cancelled` status colors for interrupted and canceled
 * rows, `running` for actively running rows, and `transparent` otherwise.
 * Keep the running edge blue so it cannot read as done. Share this mapping
 * between the Subjects matrix and the Dashboard preview.
 */
export function subjectEdgeColor(t: Theme, subject: Subject): string {
  const bucket = subjectDisplayBucket(subject)
  if (bucket === 'failed') return statusColor(t, 'failed')
  if (bucket === 'interrupted') return statusColor(t, 'interrupted')
  if (bucket === 'cancelled') return statusColor(t, 'cancelled')
  if (bucket === 'running') return statusColor(t, 'running')
  return 'transparent'
}

/**
 * Map a raw failure tag to readable display text. Preserve the raw token in the
 * element title for debugging.
 */
export function humanizeError(raw: string): string {
  const known: Record<string, string> = {
    oom_killed: 'Out of memory',
    out_of_memory: 'Out of memory',
    timeout: 'Timed out',
    timed_out: 'Timed out',
    cancelled: 'Canceled',
    canceled: 'Canceled',
    no_space: 'Out of disk space',
    permission_denied: 'Permission denied',
  }
  // Own keys only: a tag such as `constructor` must not read the prototype.
  const key = raw.trim().toLowerCase()
  const hit = Object.hasOwn(known, key) ? known[key] : undefined
  if (hit) return hit
  const spaced = raw.trim().replace(/_+/g, ' ').replace(/\s+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** A bare machine tag such as `oom_killed`, as opposed to recorded prose. */
const MACHINE_TAG = /^[A-Za-z0-9_]+$/

/**
 * State a failed cell's recorded reason the way Logs states it. A job's
 * reason code reads as its sentence, any other bare machine tag is humanized,
 * and recorded prose reads as recorded, so a path or command name keeps its
 * underscores. A reason with no letter or digit, such as a line of dashes,
 * reads as no reason.
 *
 * @returns The text to show, or null when there is no reason to show.
 * @example
 * failureReasonText('operator_cancelled') // "Canceled at the operator's request."
 * failureReasonText('oom_killed') // 'Out of memory'
 * failureReasonText('------') // null
 */
export function failureReasonText(
  raw: string | null | undefined,
): string | null {
  const text = terminalReasonText(raw)
  // A mapped code is already a sentence; humanize only a tag left unmapped.
  if (text === null || !MACHINE_TAG.test(text)) return text
  return humanizeError(text)
}

/**
 * State a free-form error message as an error title or line, the way
 * {@link failureReasonText} states a recorded reason: a reason code reads as
 * its sentence, a bare machine tag is humanized, and any other message reads
 * as written, so a path or tool name such as `mri_surf2surf` keeps its
 * underscores. A message with no letter or digit reads as written.
 *
 * @param message - The error message, usually an `Error`'s message.
 * @example
 * errorMessageText('oom_killed') // 'Out of memory'
 * errorMessageText('mri_surf2surf ended with exit code 255.')
 * // 'mri_surf2surf ended with exit code 255.'
 */
export function errorMessageText(message: string): string {
  return failureReasonText(message) ?? message
}
