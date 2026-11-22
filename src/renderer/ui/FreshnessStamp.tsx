/**
 * Announces the last refresh time politely. Each screen decides whether to
 * show a missing timestamp.
 */

import type { ReactNode } from 'react'
import { FONTS, type Theme } from '../theme/tokens'
import { formatRunTime } from './status'

/** The timestamp and presentation for a freshness announcement. */
export interface FreshnessStampProps {
  t: Theme
  at: string | null
  title?: string | undefined
  color?: string | undefined
}

/** Render a polite last-updated timestamp. */
export function FreshnessStamp({
  t,
  at,
  title,
  color,
}: FreshnessStampProps): ReactNode {
  return (
    <span
      aria-live="polite"
      title={title}
      style={{
        fontFamily: FONTS.sans,
        fontSize: 11,
        color: color ?? t.dim,
        whiteSpace: 'nowrap',
      }}
    >
      Last updated {formatRunTime(at)}
    </span>
  )
}

/**
 * Discovery times whose "Last updated" stamps are as wide as any: each
 * month's short name with a two-digit day and hour, so the widest month of
 * the locale and font is among them.
 */
const STAMP_WIDTH_SAMPLES: readonly string[] = Array.from(
  { length: 12 },
  (_, month) => new Date(2026, month, 28, 12, 58).toISOString(),
)

/**
 * Hold the width of the widest "Last updated" stamp in a slot that shows a
 * {@link FreshnessStamp} once a time is known, so the header around it keeps
 * its rows while the time loads. Place it in the slot's first grid cell; it
 * neither shows nor announces anything.
 *
 * @example
 * <span style={{ display: 'inline-grid' }}>
 *   <FreshnessStampReserve />
 *   {at && <FreshnessStamp t={theme} at={at} />}
 * </span>
 */
export function FreshnessStampReserve(): ReactNode {
  return (
    <span
      aria-hidden
      style={{
        gridArea: '1 / 1',
        display: 'grid',
        visibility: 'hidden',
        fontFamily: FONTS.sans,
        fontSize: 11,
        whiteSpace: 'nowrap',
      }}
    >
      {STAMP_WIDTH_SAMPLES.map((at) => (
        <span key={at} style={{ gridArea: '1 / 1' }}>
          Last updated {formatRunTime(at)}
        </span>
      ))}
    </span>
  )
}
