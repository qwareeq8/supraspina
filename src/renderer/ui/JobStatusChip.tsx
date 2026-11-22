/**
 * Draws a job's status badge with the status legend's ringed glyph, so Logs
 * and the Runs In flight list show a job state the same way.
 */

import type { ReactNode } from 'react'
import type { CellState, JobStatus } from '../../shared/types'
import type { Theme } from '../theme/tokens'
import { Chip } from './Chip'
import { ICONS } from './icon-set'
import { Ico } from './icons'
import { StatusGlyph } from './StatusCell'
import { statusGlyphSoft } from './status'

/**
 * The status legend state each job status draws, so a job keeps the glyph
 * and tone its run shows in Recent runs and its cell shows in the matrix. A
 * job whose state could not be stored has no legend state and draws the
 * Recent runs warning sign; an unknown state draws the legend's unknown
 * state, as Recent runs does.
 */
export const JOB_LEGEND_STATE: Record<JobStatus, CellState | null> = {
  planned: 'planned',
  waiting: 'waiting',
  queued: 'queued',
  running: 'running',
  cancelling: 'cancelling',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  blocked: 'blocked',
  withheld: 'withheld',
  interrupted: 'interrupted',
  stale: 'stale',
  'persistence-error': null,
  unknown: 'stale',
}

/**
 * Draw a job status as the status legend draws its state: the glyph in the
 * state's tone. Only a running job's ring pulses.
 */
export function JobStatusGlyph({
  t,
  status,
}: {
  t: Theme
  status: JobStatus
}): ReactNode {
  const state = JOB_LEGEND_STATE[status]
  if (state === null) {
    // Drawn at the size of the legend's glyphs, as Recent runs draws it.
    return <Ico d={ICONS.circleAlert} stroke={t.warning} />
  }
  return <StatusGlyph st={state} t={t} animate={state === 'running'} />
}

/** A job's status badge: its legend glyph and word on a tint of its tone. */
export function JobStatusChip({
  t,
  status,
  label,
}: {
  t: Theme
  status: JobStatus
  /** The screen's word for the status. */
  label: string
}): ReactNode {
  const state = JOB_LEGEND_STATE[status]
  return (
    <Chip
      t={t}
      // The glyph and the fill below replace the chip's own dot and tint.
      status="na"
      label={label}
      small
      glyph={<JobStatusGlyph t={t} status={status} />}
      fill={state === null ? t.warningSoft : statusGlyphSoft(t, state)}
    />
  )
}
