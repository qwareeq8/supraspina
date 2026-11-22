import type { ReactNode } from 'react'
import { FONTS, type Theme } from '../theme/tokens'
import { Ico } from './icons'
import { ICONS, ICON_SIZE } from './icon-set'

/** The content and presentation for an empty state. */
export interface EmptyStateProps {
  t: Theme
  /**
   * Hide this decorative icon from assistive technology. Omit it for a
   * text-only empty state.
   */
  icon?: keyof typeof ICONS | ReactNode
  message: string
  hint?: ReactNode
  action?: ReactNode
  /** Size to the content and fill a flex column, for a card sized by its row. */
  compact?: boolean
}

/** Render the centered empty state. */
export function EmptyState({
  t,
  icon,
  message,
  hint,
  action,
  compact = false,
}: EmptyStateProps): ReactNode {
  const iconNode =
    typeof icon === 'string' ? ICONS[icon] : (icon as ReactNode | undefined)
  // Callers may derive both slots from one cause; state it once.
  const shownHint = hint === message ? undefined : hint
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 8,
        ...(compact
          ? { flex: 1, padding: 'var(--ss-card-pad)' }
          : {
              minHeight: 140,
              padding: 'calc(var(--ss-card-pad) * 2) var(--ss-card-pad)',
            }),
      }}
    >
      {iconNode != null && (
        <span aria-hidden style={{ color: t.dimmer, display: 'inline-flex' }}>
          <Ico d={iconNode} size={ICON_SIZE.empty} />
        </span>
      )}
      <span
        style={{
          fontFamily: FONTS.sans,
          fontSize: 13.5,
          fontWeight: 400,
          color: t.text,
          maxWidth: 360,
        }}
      >
        {message}
      </span>
      {shownHint != null && (
        <span
          style={{
            fontFamily: FONTS.sans,
            fontSize: 11.5,
            lineHeight: 'var(--ss-line-tight)',
            color: t.dimText,
            maxWidth: 360,
          }}
        >
          {shownHint}
        </span>
      )}
      {action != null && <div style={{ marginTop: 2 }}>{action}</div>}
    </div>
  )
}
