/**
 * A zoom-safe modal scrim and dialog for every full-screen modal.
 *
 * The scrim stays scrollable when the larger-text setting applies CSS `zoom` to
 * `#root`. A `min-height: 100%` wrapper centers the card so an over-tall card
 * and its footer stay reachable at every density and text scale.
 *
 * The WAI-ARIA APG modal-dialog role, focus trap, open focus, close focus
 * restoration, and backdrop dismissal live here. Escape, arrow, and Enter key
 * behavior stays with each caller through `onKeyDown`.
 */

import { useEffect, useRef } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from 'react'
import type { Theme } from '../theme/tokens'
import { trapTab } from './focusTrap'

interface InertRecord {
  count: number
  inert: boolean
  ariaHidden: string | null
}

const INERTED = new WeakMap<HTMLElement, InertRecord>()

function acquireInert(element: HTMLElement): void {
  const existing = INERTED.get(element)
  if (existing) {
    existing.count += 1
    return
  }
  INERTED.set(element, {
    count: 1,
    inert: element.inert,
    ariaHidden: element.getAttribute('aria-hidden'),
  })
  element.inert = true
  element.setAttribute('aria-hidden', 'true')
}

function releaseInert(element: HTMLElement): void {
  const record = INERTED.get(element)
  if (!record) return
  record.count -= 1
  if (record.count > 0) return
  element.inert = record.inert
  if (record.ariaHidden === null) element.removeAttribute('aria-hidden')
  else element.setAttribute('aria-hidden', record.ariaHidden)
  INERTED.delete(element)
}

/** The scrim padding around the card, in CSS pixels, for each placement. */
const MODAL_PADDING = {
  center: { top: 32, bottom: 32 },
  start: { top: 80, bottom: 32 },
} as const

/**
 * Bound the card to the real window height under the larger-text zoom.
 *
 * `#root` applies `zoom: var(--ss-zoom)`, which scales `vh` and the scrim
 * padding with everything else, so an unbounded card at 135% text grew taller
 * than the window and scrolled its title away. Dividing `100vh` by the zoom
 * restores the window height before the zoom scales it back, and the scrim
 * padding is subtracted so the title and actions both stay in view.
 *
 * @param align - The card placement, which sets the scrim padding.
 * @returns The CSS `max-height` for the dialog card.
 */
function modalCardMaxHeight(align: 'center' | 'start'): string {
  const { top, bottom } = MODAL_PADDING[align]
  return `calc(100vh / var(--ss-zoom, 1) - ${top + bottom}px)`
}

/**
 * Any focus target that exposes a readable `current` element. Keep the
 * property read-only to accept specific caller refs without a cast.
 */
type FocusRef = { readonly current: HTMLElement | null }

/** Configuration for {@link Modal}. */
export interface ModalProps {
  /** Provide the active theme tokens. */
  t: Theme
  /** Handle a backdrop dismissal request. */
  onDismiss: () => void
  /** Provide the dialog heading ID for `aria-labelledby`. */
  labelledBy?: string
  /** Provide an accessible name when no visible heading exists. */
  label?: string
  /** Provide the descriptive text ID for `aria-describedby`. */
  describedBy?: string
  /** Choose centered or top-anchored vertical placement. */
  align?: 'center' | 'start'
  /** Choose the initial focus target, or default to the dialog card. */
  initialFocusRef?: FocusRef
  /** Handle modal-specific keys after trapping Tab here. */
  onKeyDown?: (e: ReactKeyboardEvent) => void
  /** Override card layout styles. */
  cardStyle?: CSSProperties
  /** Provide the dialog body. */
  children: ReactNode
}

/** Render a zoom-safe, scrollable, focus-trapped modal. */
export function Modal({
  t,
  onDismiss,
  labelledBy,
  label,
  describedBy,
  align = 'center',
  initialFocusRef,
  onKeyDown,
  cardStyle,
  children,
}: ModalProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)

  // Make every DOM sibling outside this modal's ancestor path inert. Use
  // reference counting to prevent nested dialogs from restoring it early.
  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return undefined
    const acquired: HTMLElement[] = []
    let branch: HTMLElement = overlay
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue
        acquireInert(sibling)
        acquired.push(sibling)
      }
      branch = branch.parentElement
    }
    return () => {
      for (const element of acquired.reverse()) releaseInert(element)
    }
  }, [])

  // Move focus into the dialog on open, and restore it to the opener on close.
  // Defer the initial move until after the mount paint.
  useEffect(() => {
    const previouslyFocused = document.activeElement
    const id = window.setTimeout(() => {
      const target = initialFocusRef?.current ?? dialogRef.current
      target?.focus()
    }, 0)
    return () => {
      window.clearTimeout(id)
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [initialFocusRef])

  const handleKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Tab') {
      trapTab(e, dialogRef.current)
      return
    }
    onKeyDown?.(e)
  }

  const padding = MODAL_PADDING[align]

  return (
    <div
      ref={overlayRef}
      role="presentation"
      onClick={onDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        background: t.scrim,
        zIndex: 1000,
        overflowY: 'auto',
        display: 'flex',
      }}
    >
      {/* Let the wrapper grow beyond the zoomed viewport, and keep the scrim scrollable. */}
      <div
        style={{
          minHeight: '100%',
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
          // Use `safe center` to center a fitting card and preserve the start
          // edge when text zoom makes the card taller than the viewport.
          alignItems: align === 'center' ? 'safe center' : 'flex-start',
          padding: `${padding.top}px 16px ${padding.bottom}px`,
          boxSizing: 'border-box',
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
          style={{
            display: 'flex',
            flexDirection: 'column',
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 10,
            boxShadow: t.shadow,
            outline: 'none',
            maxHeight: modalCardMaxHeight(align),
            overflow: 'auto',
            ...cardStyle,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
