/**
 * The style of a status or state sentence and of a count line, shared by the
 * StateLine component and by elements that cannot be one, such as a select.
 */

import type { CSSProperties } from 'react'
import { FONTS, type Theme } from '../theme/tokens'

/** Size and color of a state line. */
export interface StateLineStyle {
  /** The font size in CSS pixels; 11 by default. */
  size?: number | undefined
  /** The text color; the theme's dim text color by default. */
  color?: string | undefined
}

/**
 * Return the style of a state line for an element that is not a
 * StateLine, such as a list item or a select.
 *
 * @returns The font family, size, and color.
 */
export function stateLineStyle(
  t: Theme,
  { size = 11, color }: StateLineStyle = {},
): CSSProperties {
  return { fontFamily: FONTS.sans, fontSize: size, color: color ?? t.dimText }
}
