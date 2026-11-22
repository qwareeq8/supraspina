/**
 * Name every icon-only action through `aria-label` and `title`.
 */

import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { FONTS, type Theme, statusColor } from '../theme/tokens'
import { ICON_SIZE } from './icon-set'
import { Ico } from './icons'

/** The icon, behavior, and accessible text for an icon-only action. */
export interface IconButtonProps {
  t: Theme
  d: ReactNode
  ariaLabel: string
  title?: string
  onClick?: (() => void) | undefined
  disabled?: boolean
  /**
   * Announce busy state and tint the glyph with the running token, drawn
   * still as LoadingState is: a refresh can wait many seconds, and a pulse
   * keeps the compositor repainting for that long. Let the caller decide
   * whether busy state also disables the control.
   */
  busy?: boolean
  size?: number
  iconSize?: number
  style?: CSSProperties
}

/** Render an accessible icon-only action. */
export function IconButton({
  t,
  d,
  ariaLabel,
  title,
  onClick,
  disabled,
  busy,
  size = 28,
  iconSize = ICON_SIZE.nav,
  style,
}: IconButtonProps): ReactNode {
  const [hover, setHover] = useState(false)
  const inactive = disabled || !onClick

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      title={title ?? ariaLabel}
      onClick={onClick}
      disabled={inactive}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: size,
        height: size,
        padding: 0,
        borderRadius: 5,
        border: '1px solid transparent',
        background: !inactive && hover ? t.surface2 : 'transparent',
        color: busy
          ? statusColor(t, 'running')
          : inactive
            ? t.dimmer
            : hover
              ? t.text
              : t.dim,
        fontFamily: FONTS.sans,
        cursor: busy ? 'progress' : inactive ? 'not-allowed' : 'pointer',
        display: 'grid',
        placeItems: 'center',
        opacity: inactive && !busy ? 0.55 : 1,
        ...style,
      }}
    >
      <Ico d={d} size={iconSize} />
    </button>
  )
}
