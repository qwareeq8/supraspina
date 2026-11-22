/**
 * Announces loading politely through one `role="status"` row. The running
 * status token is reused across every screen, drawn still: a load is a wait,
 * not active work, and a pulse would keep the compositor repainting for as
 * long as the wait lasts (up to a minute at startup on a large project, where
 * the repaints would slow the sidecar's startup work). A row that repeats a
 * line another region already announces renders the same way without a live
 * region, so a screen reader hears the line once.
 */

import type { ReactNode } from 'react'
import { FONTS, type Theme } from '../theme/tokens'
import { StatusDot } from './StatusDot'

/** The presentation for a polite loading announcement. */
export interface LoadingStateProps {
  t: Theme
  label: string
  block?: boolean
  /**
   * Whether the row is a polite live region. False for a visible repeat of
   * a line that another live region announces. Defaults to true.
   */
  live?: boolean
}

/** Render a polite loading announcement, or its silent repeat. */
export function LoadingState({
  t,
  label,
  block,
  live = true,
}: LoadingStateProps): ReactNode {
  return (
    <div
      {...(live ? { role: 'status', 'aria-live': 'polite' as const } : {})}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: block ? 'center' : 'flex-start',
        gap: 8,
        color: t.dim,
        fontFamily: FONTS.sans,
        fontSize: 12,
        padding: block ? 'calc(var(--ss-card-pad) * 2)' : '6px 0',
        ...(block ? { minHeight: 120 } : {}),
      }}
    >
      <StatusDot t={t} status="running" size={8} still />
      {label}
    </div>
  )
}
