/**
 * Draws a round status dot beside a status word, which carries the meaning
 * without color. Only active work pulses.
 */

import type { ReactNode } from 'react'
import type { ChipStatus } from '../../shared/types'
import { type Theme, statusColor } from '../theme/tokens'

/** The state and size for a status glyph. */
export interface StatusDotProps {
  t: Theme
  status: ChipStatus
  size?: number
  /**
   * Whether the glyph holds still even for active work: a wait that may last
   * a minute, such as the startup cohort load, keeps the compositor idle.
   */
  still?: boolean
}

/** Render a status glyph with state-specific shape and motion. */
export function StatusDot({
  t,
  status,
  size = 6,
  still = false,
}: StatusDotProps): ReactNode {
  const pulse = !still && (status === 'running' || status === 'queued')
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        background: statusColor(t, status),
        borderRadius: '50%',
        animation: pulse ? 'sciwPulse 1.3s ease-in-out infinite' : 'none',
        flexShrink: 0,
      }}
    />
  )
}
