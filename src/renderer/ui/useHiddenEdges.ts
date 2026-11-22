/**
 * Tracks which sides of a horizontal scroll area hide content, for the shared
 * ScrollEdgeHints overlay.
 */

import { useLayoutEffect, useState } from 'react'

/** Sides of a horizontal scroll area that hold columns scrolled out of view. */
export interface HiddenEdges {
  left: boolean
  right: boolean
}

/** The horizontal scroll metrics of a scroll area, in its own CSS pixels. */
export interface HorizontalScrollMetrics {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

/**
 * Distance in CSS pixels a scroll area may stop short of either end and still
 * read as at that end. `scrollWidth` and `clientWidth` are whole pixels, each
 * rounded by up to half a pixel, and `scrollLeft` snaps to a device pixel,
 * which spans up to one CSS pixel at any zoom of 100% or more. At a fractional
 * zoom such as the 135% text scale these add up to more than one pixel at the
 * far end.
 */
export const HIDDEN_EDGE_TOLERANCE = 2

const NO_HIDDEN_EDGES: HiddenEdges = { left: false, right: false }

/**
 * Report which sides of a horizontal scroll area hide content.
 *
 * @returns Whether content is hidden past each side.
 */
export function hiddenEdgesOf(metrics: HorizontalScrollMetrics): HiddenEdges {
  const { scrollLeft, scrollWidth, clientWidth } = metrics
  return {
    left: scrollLeft > HIDDEN_EDGE_TOLERANCE,
    right: scrollWidth - clientWidth - scrollLeft > HIDDEN_EDGE_TOLERANCE,
  }
}

/**
 * Track which sides of a horizontal scroll area hide content. Attach the
 * returned callback ref to the scrolling element; the edges update on
 * scroll and on resize. A callback ref lets the element mount after the
 * owning component, such as once a loading state ends. Keep the element free
 * of a reserved `scrollbar-gutter`: `clientWidth` excludes the gutter, so the
 * far end never reads as reached, and with both edges reserved the last
 * columns cannot scroll fully into view.
 */
export function useHiddenEdges(): [
  HiddenEdges,
  (el: HTMLElement | null) => void,
] {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [edges, setEdges] = useState<HiddenEdges>(NO_HIDDEN_EDGES)

  useLayoutEffect(() => {
    if (!el) return undefined
    const update = (): void => {
      const { left, right } = hiddenEdgesOf(el)
      setEdges((prev) =>
        prev.left === left && prev.right === right ? prev : { left, right },
      )
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [el])

  return [edges, setEl]
}
