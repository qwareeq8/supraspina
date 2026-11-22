/**
 * The shared style of a status or state sentence and of a count line, such as
 * "Dry run is off; commands execute on this host." or "0 done of 4". These are
 * prose, so they take the sans face.
 */

import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import type { Theme } from '../theme/tokens'
import { stateLineStyle, type StateLineStyle } from './state-line'

/** Configuration for {@link StateLine}. */
export interface StateLineProps
  extends
    StateLineStyle,
    Omit<HTMLAttributes<HTMLSpanElement>, 'color' | 'style'> {
  t: Theme
  style?: CSSProperties
  children: ReactNode
}

/** Render a status or state sentence, or a count line, in sans. */
export function StateLine({
  t,
  size,
  color,
  style,
  children,
  ...rest
}: StateLineProps): ReactNode {
  return (
    <span {...rest} style={{ ...stateLineStyle(t, { size, color }), ...style }}>
      {children}
    </span>
  )
}
