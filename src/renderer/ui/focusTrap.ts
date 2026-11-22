/**
 * Keeps Tab focus cycling within every modal under the WAI-ARIA APG pattern, so
 * keyboard and screen-reader users cannot reach inert background content.
 */

/** Selector for the natively focusable descendants of a dialog. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), ' +
  'textarea:not([disabled]), select:not([disabled]), ' +
  'details > summary:first-of-type, ' +
  '[tabindex]:not([tabindex="-1"]):not(:disabled)'

/**
 * Tab focus cycling within a modal dialog.
 *
 * @param root - The dialog root; null does nothing.
 */
interface TabEvent {
  shiftKey: boolean
  preventDefault(): void
}

/**
 * Keep Tab focus within the supplied modal root.
 *
 * @param root - The modal root; null does nothing.
 */
export function trapTab(e: TabEvent, root: HTMLElement | null): void {
  if (!root) return
  // Exclude native controls whose explicit tabIndex=-1 removes them from
  // sequential navigation. Prevent programmatic-only targets from becoming
  // false boundaries of the focus trap.
  const focusables = Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => element.tabIndex >= 0 && !element.matches(':disabled'))
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (!first || !last) return
  const active = document.activeElement
  if (e.shiftKey) {
    if (active === first || !root.contains(active)) {
      e.preventDefault()
      last.focus()
    }
  } else if (active === last || !root.contains(active)) {
    e.preventDefault()
    first.focus()
  }
}
