/**
 * Encodes status through the ringed glyph's color and shape, the same glyphs
 * the status matrix draws. The label uses the neutral body token to preserve
 * WCAG contrast on every soft fill.
 */

import type { ReactNode } from 'react'
import type { CellState, ChipStatus } from '../../shared/types'
import { FONTS } from '../theme/tokens'
import {
  type Theme,
  STATUS_LABEL,
  statusColor,
  statusSoft,
} from '../theme/tokens'
import { ICONS } from './icon-set'
import { Ico } from './icons'
import { StatusGlyph } from './StatusCell'

/** Status content and presentation for a chip. */
export interface ChipProps {
  t: Theme
  status: ChipStatus
  label?: string
  /** Whether the label is a key or a code, such as `rc=1`; words stay sans. */
  mono?: boolean
  small?: boolean
  title?: string | undefined
  /**
   * The glyph to draw in place of the status glyph, such as the status
   * legend's glyph of a job state; `fill` then sets the matching tint.
   */
  glyph?: ReactNode
  /** The chip's fill in place of the status tint. */
  fill?: string | undefined
}

/**
 * The ring icon of each status that is not a matrix cell state. A cell state
 * draws its matrix glyph instead, so a chip and a cell never disagree.
 */
const RING_ICON: Partial<Record<ChipStatus, string>> = {
  found: 'circleCheck',
  ok: 'circleCheck',
  pass: 'circleCheck',
  missing: 'circleX',
  fail: 'circleX',
  // A ringed exclamation: the check needs attention but does not fail.
  warn: 'circleAlert',
  wrong: 'circleAlert',
  // Pause bars, as QC review draws a deferred verdict.
  review: 'circlePause',
  partial: 'circleHalf',
  exclude: 'circleMinus',
  unreviewed: 'ring',
  na: 'ring',
}

/** The chip statuses that are matrix cell states. */
const CELL_STATES: ReadonlySet<ChipStatus> = new Set<CellState>([
  'pending',
  'planned',
  'waiting',
  'queued',
  'running',
  'cancelling',
  'done',
  'failed',
  'cancelled',
  'blocked',
  'withheld',
  'interrupted',
  'stale',
  'skipped',
  'outdated',
])

/** Render a status's ringed glyph in the chip's tone; readers skip it. */
export function ChipGlyph({
  t,
  status,
}: {
  t: Theme
  status: ChipStatus
}): ReactNode {
  const color = statusColor(t, status)
  if (CELL_STATES.has(status)) {
    return (
      <StatusGlyph
        st={status as CellState}
        t={t}
        color={color}
        animate={status === 'running'}
      />
    )
  }
  const icon = RING_ICON[status] ?? 'ring'
  return <Ico d={ICONS[icon]} stroke={color} glyphShape={icon} />
}

/** The tone of a notice banner: a routine fact, or a status's tone. */
export type NoticeTone = ChipStatus | 'info'

/**
 * Render a notice banner's ringed glyph: the ringed info mark for a routine
 * fact, and the status chip's ringed glyph for any other tone, so a banner
 * and the chips around it draw the same marks. A `color` replaces the
 * status tone where the banner sits on its own palette.
 */
export function NoticeGlyph({
  t,
  tone,
  color,
}: {
  t: Theme
  tone: NoticeTone
  color?: string | undefined
}): ReactNode {
  if (tone === 'info') {
    return <Ico d={ICONS.info} stroke={color ?? t.dimText} glyphShape="info" />
  }
  if (color === undefined) return <ChipGlyph t={t} status={tone} />
  const icon = RING_ICON[tone] ?? 'circleAlert'
  return <Ico d={ICONS[icon]} stroke={color} glyphShape={icon} />
}

/** Render a status chip with redundant color and shape cues. */
export function Chip({
  t,
  status,
  label,
  mono,
  small,
  title,
  glyph,
  fill,
}: ChipProps): ReactNode {
  const lbl = label ?? STATUS_LABEL[status] ?? status
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: small ? '1px 6px' : '2px 8px',
        borderRadius: 3,
        background: fill ?? statusSoft(t, status),
        color: t.text,
        fontFamily: mono ? FONTS.mono : FONTS.sans,
        fontSize: small ? 10 : 11,
        fontWeight: 400,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
      }}
    >
      {glyph ?? <ChipGlyph t={t} status={status} />}
      {lbl}
    </span>
  )
}
