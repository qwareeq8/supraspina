/**
 * Use `Hint` for the one standing line a pane needs, and `InfoTip` for
 * explanation a reader looks up on demand.
 */

import { useId, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { FONTS, type Theme } from '../theme/tokens'
import { Ico } from './icons'
import { ICONS } from './icon-set'

/** Content and presentation for visible guidance. */
export interface HintProps {
  t: Theme
  children: ReactNode
  style?: CSSProperties
}

/**
 * Render guidance that remains visible without pointer or keyboard action.
 * Guidance is prose, so it is always sans; set a path inside it with
 * InlineCode.
 */
export function Hint({ t, children, style }: HintProps): ReactNode {
  return (
    <p
      style={{
        margin: 0,
        fontFamily: FONTS.sans,
        fontSize: 11.5,
        lineHeight: 'var(--ss-line-tight)',
        color: t.dimText,
        ...style,
      }}
    >
      {children}
    </p>
  )
}

/** Widest tooltip in CSS pixels. */
const TIP_MAX_WIDTH = 280

/** Space in CSS pixels a tooltip keeps from the edge that would clip it. */
const TIP_EDGE_MARGIN = 8

/** Where a tooltip opens around its glyph. */
interface TipPlacement {
  horizontal: 'center' | 'start' | 'end'
  below: boolean
}

/**
 * Choose the side a tooltip opens on so the window and the nearest scrolling
 * pane do not clip it: centered above the glyph by default, aligned to the
 * glyph near a side edge, and below it near the top.
 */
function tipPlacement(anchor: HTMLElement, text: string): TipPlacement {
  const rect = anchor.getBoundingClientRect()
  const center = rect.left + rect.width / 2
  const half = TIP_MAX_WIDTH / 2 + TIP_EDGE_MARGIN
  const horizontal =
    center + half > window.innerWidth
      ? 'end'
      : center - half < 0
        ? 'start'
        : 'center'
  let top = 0
  for (let el = anchor.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden') {
      top = Math.max(top, el.getBoundingClientRect().top)
    }
  }
  // Estimate the height from the text: about 44 characters to a line.
  const height = Math.ceil(text.length / 44) * 16 + 14
  return { horizontal, below: rect.top - top < height + TIP_EDGE_MARGIN }
}

/** Content and presentation for a compact explanation. */
export interface InfoTipProps {
  t: Theme
  text: string
  label?: string
  style?: CSSProperties
  /** The tooltip's element ID, for a caller's own `aria-describedby`. */
  tooltipId?: string
}

/**
 * Expose the explanation on hover, focus, and activation. Keep the tooltip in
 * the accessibility tree while visually collapsed, and dismiss it with Escape.
 * Keep the button's short name distinct from its longer description.
 */
export function InfoTip({
  t,
  text,
  label = 'More information',
  style,
  tooltipId: givenTooltipId,
}: InfoTipProps): ReactNode {
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const tooltipId = givenTooltipId ?? `info-tip-${generatedId}`
  const [placement, setPlacement] = useState<TipPlacement | null>(null)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const open = placement !== null
  const setOpen = (next: boolean | ((value: boolean) => boolean)): void =>
    setPlacement((current) => {
      const value = typeof next === 'function' ? next(current !== null) : next
      if (!value) return null
      if (current) return current
      return anchorRef.current
        ? tipPlacement(anchorRef.current, text)
        : { horizontal: 'center', below: false }
    })

  return (
    <span
      ref={anchorRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
        position: 'relative',
        ...style,
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={tooltipId}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
          }
        }}
        style={{
          width: 24,
          height: 24,
          minWidth: 24,
          minHeight: 24,
          padding: 0,
          margin: -5,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: t.dim,
          cursor: 'help',
          borderRadius: 4,
          border: '1px solid transparent',
          background: 'transparent',
        }}
      >
        <Ico d={ICONS.info} />
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        style={
          placement
            ? {
                position: 'absolute',
                zIndex: 100,
                ...(placement.below
                  ? { top: 'calc(100% + 7px)' }
                  : { bottom: 'calc(100% + 7px)' }),
                ...(placement.horizontal === 'center'
                  ? { left: '50%', transform: 'translateX(-50%)' }
                  : placement.horizontal === 'end'
                    ? { right: -6 }
                    : { left: -6 }),
                width: 'max-content',
                maxWidth: TIP_MAX_WIDTH,
                padding: '6px 8px',
                borderRadius: 4,
                border: `1px solid ${t.border}`,
                background: t.surface4,
                color: t.text,
                boxShadow: '0 6px 18px rgba(0, 0, 0, 0.28)',
                fontFamily: FONTS.sans,
                fontSize: 11.5,
                fontWeight: 400,
                lineHeight: 1.35,
                whiteSpace: 'normal',
                pointerEvents: 'auto',
                userSelect: 'text',
              }
            : {
                position: 'absolute',
                width: 1,
                height: 1,
                padding: 0,
                margin: -1,
                overflow: 'hidden',
                clip: 'rect(0, 0, 0, 0)',
                whiteSpace: 'nowrap',
                border: 0,
              }
        }
      >
        {text}
      </span>
    </span>
  )
}
