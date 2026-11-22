/**
 * Draws review states with the ringed status glyphs of the matrix, so the QC
 * review and Input QC screens read like the rest of the app. Each glyph keeps
 * the tone its status dot drew, and a word beside it carries the meaning.
 */

import type { ReactNode } from 'react'
import type { ChipStatus } from '../../shared/types'
import { type Theme, statusColor } from '../theme/tokens'
import { Chip } from './Chip'
import { ICONS } from './icon-set'
import { Ico } from './icons'

/** A review state on the QC review or Input QC screen. */
export type ReviewState =
  | 'pass'
  | 'fail'
  | 'review'
  | 'unreviewed'
  | 'stale'
  | 'incomplete'

/** The ring icon and the status tone of each review state. */
const REVIEW_GLYPH: Record<ReviewState, { icon: string; tone: ChipStatus }> = {
  pass: { icon: 'circleCheck', tone: 'pass' },
  fail: { icon: 'circleX', tone: 'fail' },
  // Pause bars: the reviewer holds the verdict back for another look.
  review: { icon: 'circlePause', tone: 'review' },
  // An empty ring, as a step that has not started draws.
  unreviewed: { icon: 'ring', tone: 'unreviewed' },
  // A rerun arrow, as out-of-date output draws: the review needs repeating.
  stale: { icon: 'circleRerun', tone: 'warn' },
  // An ellipsis: some items still wait on an approval.
  incomplete: { icon: 'circleEllipsis', tone: 'warn' },
}

/** Return the status tone a review state draws in. */
export function reviewTone(state: ReviewState): ChipStatus {
  return REVIEW_GLYPH[state].tone
}

/** Return the name of the ring icon a review state draws. */
export function reviewIcon(state: ReviewState): string {
  return REVIEW_GLYPH[state].icon
}

/** Render the ringed glyph of a review state; it is hidden from readers. */
export function ReviewGlyph({
  t,
  state,
}: {
  t: Theme
  state: ReviewState
}): ReactNode {
  const { icon, tone } = REVIEW_GLYPH[state]
  return <Ico d={ICONS[icon]} stroke={statusColor(t, tone)} glyphShape={icon} />
}

/** The review state and word for a {@link ReviewChip}. */
export interface ReviewChipProps {
  t: Theme
  state: ReviewState
  label: string
  small?: boolean | undefined
  title?: string | undefined
}

/** Render a status chip that leads its word with the review glyph. */
export function ReviewChip({
  t,
  state,
  label,
  small,
  title,
}: ReviewChipProps): ReactNode {
  return (
    <Chip
      t={t}
      status={reviewTone(state)}
      label={label}
      small={small ?? false}
      title={title}
      glyph={<ReviewGlyph t={t} state={state} />}
    />
  )
}
