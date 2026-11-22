/**
 * The height left for a result view down to the bottom of the page's scroll
 * area, and the measure figure's size in it, so a figure or the brain
 * canvas shows whole without scrolling.
 */

import { useEffect, useLayoutEffect, useState } from 'react'
import {
  SCATTER_COMPACT_WIDTH_PT,
  scatterHeight,
} from '../../figures/scatter-model'
import { SCREEN_PX_PER_PT } from '../../figures/style'
import { measureAvailableHeight } from '../../ui/useAvailableHeight'

/**
 * Track the height left for an element down to the bottom of its scroll
 * area, in CSS pixels, following banners above it and window resizes.
 *
 * @returns The height (null before layout) and the element's ref.
 */
export function useFitHeight(
  minHeight: number,
): [number | null, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  // Measure after every commit, which follows banners that move the
  // element; an unchanged height does not render again.
  useLayoutEffect(() => {
    if (!el) return
    const update = (): void =>
      setHeight(measureAvailableHeight(el, { minHeight }))
    update()
  })
  useEffect(() => {
    if (!el) return undefined
    const update = (): void =>
      setHeight(measureAvailableHeight(el, { minHeight }))
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [el, minHeight])
  return [height, setEl]
}

/** The paper's padding and border around a figure, in CSS pixels. */
const PAPER_CHROME = 30
/**
 * Size the measure figure to its frame and the height left on the page: at
 * most 480 px wide, and, when the page is short, drawn at its most compact
 * width and scaled so that it fits without scrolling.
 *
 * @param frameWidth - The figure frame's width in CSS pixels.
 * @param available - The height left for the paper, or null.
 * @returns The drawing width in points and the CSS width.
 */
export function measureFigureSize(
  frameWidth: number,
  available: number | null,
): { widthPt: number; cssWidth: number } {
  const cssMax = Math.min(frameWidth, 480)
  const widthPt = cssMax / SCREEN_PX_PER_PT
  const room = available === null ? null : available - PAPER_CHROME
  if (room === null || scatterHeight(widthPt) * SCREEN_PX_PER_PT <= room) {
    return { widthPt, cssWidth: cssMax }
  }
  const compact = Math.min(widthPt, SCATTER_COMPACT_WIDTH_PT)
  return {
    widthPt: compact,
    cssWidth: Math.min(cssMax, (room / scatterHeight(compact)) * compact),
  }
}

/**
 * Measure a figure frame's width in CSS pixels, before paint and on resize.
 *
 * @returns The width (640 before layout) and the frame's ref.
 */
export function useFrameWidth(): [number, (el: HTMLDivElement | null) => void] {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(640)
  useLayoutEffect(() => {
    if (!el) return undefined
    const update = (): void => {
      if (el.clientWidth > 0) setWidth(el.clientWidth)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return [width, setEl]
}
