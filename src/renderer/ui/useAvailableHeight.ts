/**
 * Fits a scrolling element to the space left below it in its page's scroll
 * area, so a list scrolls by itself instead of running past the fold.
 */

import { useCallback, useLayoutEffect, useRef } from 'react'

/** Options for {@link useAvailableHeight}. */
export interface AvailableHeightOptions {
  /** The least height in CSS pixels, kept on a very short window. */
  minHeight: number
  /**
   * CSS pixels that sit below the element inside the scroll area's padding,
   * such as the bottom border of the card that holds it.
   */
  trailing?: number
}

/** Return the nearest ancestor that scrolls vertically, or null. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    // Read the shorthand too: jsdom reports only the declared shorthand and
    // leaves overflowY at its initial value.
    const { overflowY, overflow } = getComputedStyle(node)
    if ([overflowY, overflow].some((v) => v === 'auto' || v === 'scroll')) {
      return node
    }
  }
  return null
}

/**
 * Measure the height that fits the element between its own top and the bottom
 * of its scroll area, taken at scroll position 0.
 *
 * Rectangles are read in viewport pixels and divided by the scroll area's
 * rendered-to-layout ratio, so the result stays in the element's own CSS
 * pixels under the text-scale zoom.
 *
 * @param options - The minimum height and the trailing space.
 * @returns The fitted height, or null when the page has no layout.
 */
export function measureAvailableHeight(
  el: HTMLElement,
  options: AvailableHeightOptions,
): number | null {
  const scroller = scrollParent(el)
  if (!scroller || scroller.clientHeight <= 0) return null
  const scrollerRect = scroller.getBoundingClientRect()
  const zoom =
    scroller.offsetHeight > 0 && scrollerRect.height > 0
      ? scrollerRect.height / scroller.offsetHeight
      : 1
  const top =
    (el.getBoundingClientRect().top - scrollerRect.top) / zoom -
    scroller.clientTop +
    scroller.scrollTop
  const paddingBottom =
    Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0
  const available =
    scroller.clientHeight - top - paddingBottom - (options.trailing ?? 0)
  return Math.max(options.minHeight, Math.floor(available))
}

/**
 * Keep an element's maximum height fitted to the rest of its scroll area.
 *
 * The height is written to the element's style before paint on every commit
 * of the calling component, so content that moves the element (a banner
 * above it) is followed, and again when the scroll area or the window
 * resizes, which covers the run dock, a compacted page header, and the
 * text-scale zoom. The element keeps no maximum height when the page has no
 * layout. Leave `maxHeight` out of the element's style prop.
 *
 * @param options - The minimum height and the trailing space.
 * @returns The callback ref for the element to fit.
 */
export function useAvailableHeight<T extends HTMLElement>(
  options: AvailableHeightOptions,
): (el: T | null) => (() => void) | undefined {
  const elRef = useRef<T | null>(null)
  const { minHeight, trailing = 0 } = options

  const fit = useCallback(() => {
    const el = elRef.current
    if (!el) return
    const height = measureAvailableHeight(el, { minHeight, trailing })
    el.style.maxHeight = height === null ? '' : `${height}px`
  }, [minHeight, trailing])

  // Follow content that moved the element since the last commit.
  useLayoutEffect(fit)

  return useCallback(
    (el: T | null) => {
      elRef.current = el
      if (!el) return undefined
      fit()
      window.addEventListener('resize', fit)
      const scroller = scrollParent(el)
      const observer =
        typeof ResizeObserver === 'undefined' || !scroller
          ? null
          : new ResizeObserver(fit)
      if (observer && scroller) observer.observe(scroller)
      return () => {
        window.removeEventListener('resize', fit)
        observer?.disconnect()
        elRef.current = null
      }
    },
    [fit],
  )
}
