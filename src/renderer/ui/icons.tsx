/**
 * Renders path or shape children as an inline SVG through {@link Ico}, using
 * the shared semantic icon set from icon-set.tsx without an icon font or
 * sprite.
 */

import type { CSSProperties, ReactNode } from 'react'
import { ICON_SIZE } from './icon-set'

/** Configuration for the {@link Ico} icon wrapper. */
export interface IcoProps {
  /** Provide the SVG path or shape children, drawn on a 24-unit grid. */
  d: ReactNode
  /** Set the pixel width and height; name an `ICON_SIZE` entry. */
  size?: number
  /** Set the stroke color, or default to `currentColor`. */
  stroke?: string
  /** Name the status shape the icon draws, as `data-glyph-shape`. */
  glyphShape?: string
  /** Provide additional inline styles. */
  style?: CSSProperties
}

/** Render an inline SVG icon from path children. */
export function Ico({
  d,
  size = ICON_SIZE.inline,
  stroke = 'currentColor',
  glyphShape,
  style,
}: IcoProps): ReactNode {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-glyph-shape={glyphShape}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={{ flexShrink: 0, ...style }}
      fill="none"
      stroke={stroke}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {d}
    </svg>
  )
}
