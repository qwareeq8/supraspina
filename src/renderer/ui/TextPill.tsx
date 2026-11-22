/**
 * A text-only marker for a message that should not compete with status glyphs.
 */

import type { ReactNode } from 'react'
import { FONTS, type Theme } from '../theme/tokens'

/** The text and color for a compact marker. */
export interface TextPillProps {
  t: Theme
  label: string
  color: string
  ariaLabel?: string
}

/** Render a compact text-only marker. */
export function TextPill({
  t,
  label,
  color,
  ariaLabel,
}: TextPillProps): ReactNode {
  return (
    <span
      role="status"
      aria-label={ariaLabel ?? label}
      style={{
        minHeight: 24,
        padding: '0 7px',
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 4,
        border: `1px solid ${color}`,
        color,
        fontFamily: FONTS.sans,
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: 0,
        whiteSpace: 'nowrap',
        background: t.surface,
      }}
    >
      {label}
    </span>
  )
}
