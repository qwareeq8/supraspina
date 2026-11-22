/** Measured widths the navigation row needs to decide how many tabs fit. */
export interface NavFitMeasure {
  /** The width available to the tabs and the overflow trigger. */
  readonly available: number
  /** The width of each tab in order, which reserves its bold label. */
  readonly tabs: readonly number[]
  /** The gap between neighboring items. */
  readonly gap: number
  /** The width of the overflow trigger at its widest label. */
  readonly trigger: number
}

/**
 * Count the leading tabs that fit before the rest move to the overflow menu.
 *
 * The count depends only on the measures, never on which tab is active or on
 * how many tabs are drawn now, so one width always gives one count and a
 * boundary width cannot oscillate.
 *
 * @param measure - The measured widths in one coordinate space.
 * @returns The number of tabs to draw, from one to all of them.
 */
export function navFitCount(measure: NavFitMeasure): number {
  const { available, tabs, gap, trigger } = measure
  // A row that was never laid out has no widths to compare; draw every tab.
  if (!(available > 0) || tabs.some((width) => !(width > 0))) {
    return tabs.length
  }
  // Half a pixel absorbs subpixel rounding between the two measurements.
  const budget = available + 0.5
  const all =
    tabs.reduce((sum, width) => sum + width, 0) +
    gap * Math.max(0, tabs.length - 1)
  if (all <= budget) return tabs.length
  let used = trigger
  let count = 0
  for (const width of tabs) {
    // Each drawn tab is followed by a gap before the next item or the trigger.
    used += width + gap
    if (used > budget) break
    count += 1
  }
  return Math.max(1, Math.min(count, tabs.length - 1))
}
