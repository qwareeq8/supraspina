/**
 * Announces failures through one `role="alert"` block, with status tokens and
 * a consistent retry affordance across every screen.
 */

import type { ReactNode } from 'react'
import { FONTS, statusColor, statusSoft, type Theme } from '../theme/tokens'
import { Btn } from './Button'
import { CodeText } from './CodeText'
import { NoticeGlyph } from './Chip'

/** An error message and its optional retry and dismiss actions. */
export interface ErrorStateProps {
  t: Theme
  title: string
  /**
   * A sentence that explains the failure, set in sans with its paths in
   * inline mono.
   */
  detail?: string | undefined
  /**
   * Whether the detail is raw tool output, stderr or a machine message, set
   * whole in mono.
   */
  mono?: boolean
  onRetry?: (() => void) | undefined
  retryLabel?: string
  /**
   * The handler of a Dismiss control that removes the failure; without it,
   * no Dismiss shows.
   */
  onDismiss?: (() => void) | undefined
}

/**
 * Render a failure statement, diagnostic detail, and optional retry and
 * dismiss actions.
 */
export function ErrorState({
  t,
  title,
  detail,
  mono = false,
  onRetry,
  retryLabel = 'Retry',
  onDismiss,
}: ErrorStateProps): ReactNode {
  const failed = statusColor(t, 'failed')
  // Callers often pass one raw message as both slots; announce it once.
  const shownDetail = detail?.trim() === title.trim() ? undefined : detail
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 'var(--ss-card-pad)',
        borderRadius: 5,
        background: statusSoft(t, 'failed'),
        border: `1px solid ${failed}`,
        borderLeft: `3px solid ${failed}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: failed,
          fontFamily: FONTS.sans,
          fontSize: 12,
          fontWeight: 700,
          // Wrap unbreakable error titles without widening fixed columns.
          minWidth: 0,
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        <NoticeGlyph t={t} tone="failed" />
        {title}
      </div>
      {shownDetail && (
        <span
          style={{
            fontFamily: mono ? FONTS.mono : FONTS.sans,
            fontSize: 11,
            color: t.dim,
            wordBreak: 'break-word',
          }}
        >
          {mono ? shownDetail : <CodeText text={shownDetail} />}
        </span>
      )}
      {(onRetry || onDismiss) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {onRetry && (
            <Btn t={t} small ghost label={retryLabel} onClick={onRetry} />
          )}
          {onDismiss && (
            <Btn
              t={t}
              small
              ghost
              label="Dismiss"
              ariaLabel="Dismiss the failure"
              onClick={onDismiss}
            />
          )}
        </div>
      )}
    </div>
  )
}
