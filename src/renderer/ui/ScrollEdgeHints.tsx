/**
 * Shared horizontal-scroll edge cues for wide status matrices, driven by
 * useHiddenEdges.
 */

import type { CSSProperties, ReactNode } from 'react'
import type { Theme } from '../theme/tokens'
import { Ico } from './icons'
import { ICONS } from './icon-set'
import type { HiddenEdges } from './useHiddenEdges'

/** Width a scroll area can reserve at its right for the chevron (px). */
export const SCROLL_HINT_GUTTER = 16

export interface ScrollEdgeHintsProps {
  t: Theme
  edges: HiddenEdges
  /** Surface behind the scroll area, which the right-edge fade blends into. */
  ground: string
  /** Width of the pinned leading columns; the left shade starts after them. */
  pinnedWidth?: number
  /** Border width of the scroll area, kept clear of the overlays. */
  inset?: number
  /** Inner corner radius of the scroll area, matched by the right fade. */
  radius?: number
  /**
   * Width the wrapper reserves at its right with padding (px). The chevron
   * sits in that gutter instead of over the last visible column.
   */
  gutter?: number
}

/**
 * Mark the sides of a horizontal scroll area that hide columns. Overlay
 * scrollbars stay invisible until hover, so a shaded edge beside the pinned
 * columns and a fade with a chevron at the right edge show where more
 * columns sit. The chevron carries the cue without relying on color.
 * Render inside a relatively positioned wrapper around the scroll area.
 */
export function ScrollEdgeHints({
  t,
  edges,
  ground,
  pinnedWidth = 0,
  inset = 0,
  radius = 0,
  gutter = 0,
}: ScrollEdgeHintsProps): ReactNode {
  const chevron = <Ico d={ICONS.chevron} stroke={t.textSoft} />
  const overlay: CSSProperties = {
    position: 'absolute',
    top: inset,
    bottom: inset,
    pointerEvents: 'none',
    zIndex: 3,
  }
  return (
    <>
      {edges.left && (
        <div
          aria-hidden="true"
          data-scroll-edge="left"
          style={{
            ...overlay,
            left: inset + pinnedWidth,
            width: 10,
            background: `linear-gradient(to right, ${t.scrim}, transparent)`,
          }}
        />
      )}
      {edges.right && (
        <div
          aria-hidden="true"
          data-scroll-edge="right"
          style={{
            ...overlay,
            right: inset + gutter,
            width: 32,
            borderRadius: radius > 0 ? `0 ${radius}px ${radius}px 0` : 0,
            background: `linear-gradient(to right, transparent, ${ground})`,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'flex-start',
            paddingTop: 18,
            paddingRight: 2,
            color: t.textSoft,
          }}
        >
          {gutter === 0 && chevron}
        </div>
      )}
      {edges.right && gutter > 0 && (
        <div
          aria-hidden="true"
          data-scroll-edge="right-chevron"
          style={{
            ...overlay,
            right: 0,
            width: gutter,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-start',
            paddingTop: 18,
          }}
        >
          {chevron}
        </div>
      )}
    </>
  )
}
