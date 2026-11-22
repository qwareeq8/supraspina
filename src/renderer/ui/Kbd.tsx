/** A keyboard key or chord, such as "Ctrl+K" or "J/K", set as a mono key cap. */

import type { ReactNode } from 'react'
import { FONTS, type Theme } from '../theme/tokens'

/** Configuration for {@link Kbd}. */
export interface KbdProps {
  t: Theme
  /** Dim the key, as inside a control whose label already carries the text. */
  muted?: boolean
  children: ReactNode
}

/** Render a keyboard shortcut as an outlined mono key cap. */
export function Kbd({ t, muted = false, children }: KbdProps): ReactNode {
  return (
    <kbd
      style={{
        fontFamily: FONTS.mono,
        fontSize: 10,
        padding: '1px 5px',
        border: `1px solid ${t.border}`,
        borderRadius: 4,
        color: muted ? t.dim : t.text,
        flexShrink: 0,
      }}
    >
      {children}
    </kbd>
  )
}
