/** Shared layout atoms for cards, pages, dividers, bars, code, paths, and segments. */

import { useRef } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { FONTS, type Theme } from '../theme/tokens'
import { Ico } from './icons'
import { ICONS } from './icon-set'
import { useFieldControlSemantics } from './field-semantics'

/** Configuration for {@link Card}. */
export interface CardProps {
  t: Theme
  title?: string
  sub?: string
  /**
   * Whether the sub is a code-like value, such as a file path, set in mono.
   * A sub is a sentence or a count by default and stays in sans.
   */
  subMono?: boolean
  action?: ReactNode
  children: ReactNode
  padded?: boolean
  style?: CSSProperties
  /**
   * Whether the title row grows with its content instead of keeping the
   * fixed card-header height. The title stays on one line, and an action
   * too wide to sit beside it wraps onto rows below it inside the header.
   */
  wrapHeader?: boolean
  /**
   * Whether a long title and sub break across lines inside a growing title
   * row, for a title such as a file name or path that can outgrow the card.
   * The title and sub share the row's free width, and the action keeps to the
   * right edge, also after it wraps onto a row of its own. It implies
   * `wrapHeader`.
   */
  wrapTitle?: boolean
}

/**
 * Vertical padding and row gap of a growing title row, in CSS pixels. A single
 * row stays within the fixed card-header height, and wrapped rows keep clear
 * of the card's top border, the header rule, and each other.
 */
const CARD_HEADER_WRAP_SPACE = 4

/**
 * Narrowest width in CSS pixels a breaking title and sub keep beside the
 * action. Below it the action wraps onto a row of its own.
 */
const CARD_TITLE_MIN_WIDTH = 220

/** Render a surface block with an optional title row. */
export function Card({
  t,
  title,
  sub,
  subMono = false,
  action,
  children,
  padded = true,
  style,
  wrapHeader = false,
  wrapTitle = false,
}: CardProps): ReactNode {
  const grow = wrapHeader || wrapTitle
  // A one-line title keeps its words together; a breaking title may split a
  // long path anywhere.
  const textFlow: CSSProperties = wrapTitle
    ? { minWidth: 0, overflowWrap: 'anywhere' }
    : wrapHeader
      ? { whiteSpace: 'nowrap' }
      : {}
  const heading = (
    <h2
      style={{
        margin: 0,
        fontSize: 11,
        color: t.dim,
        fontFamily: FONTS.sans,
        letterSpacing: 0.2,
        fontWeight: 700,
        ...textFlow,
      }}
    >
      {title}
    </h2>
  )
  const subTag = sub ? (
    <span
      style={{
        fontSize: 11,
        color: t.dimText,
        fontFamily: subMono ? FONTS.mono : FONTS.sans,
        ...textFlow,
      }}
    >
      {sub}
    </span>
  ) : null
  return (
    <div
      style={{
        background: t.surface,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        ...style,
      }}
    >
      {(title || action) && (
        <div
          style={{
            ...(grow
              ? {
                  minHeight: 'var(--ss-card-header)',
                  padding: `${CARD_HEADER_WRAP_SPACE}px 12px`,
                  flexWrap: 'wrap',
                  rowGap: CARD_HEADER_WRAP_SPACE,
                  columnGap: 10,
                }
              : {
                  height: 'var(--ss-card-header)',
                  padding: '0 12px',
                  gap: 10,
                }),
            display: 'flex',
            alignItems: 'center',
            borderBottom: `1px solid ${t.borderSoft}`,
            flexShrink: 0,
          }}
        >
          {wrapTitle ? (
            <>
              <div
                style={{
                  flex: `1 1 ${CARD_TITLE_MIN_WIDTH}px`,
                  minWidth: 0,
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'baseline',
                  gap: '2px 10px',
                }}
              >
                {heading}
                {subTag}
              </div>
              {action && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginLeft: 'auto',
                  }}
                >
                  {action}
                </div>
              )}
            </>
          ) : (
            <>
              {heading}
              {subTag}
              <span style={{ flex: 1 }} />
              {action}
            </>
          )}
        </div>
      )}
      <div
        style={{
          padding: padded ? 'var(--ss-card-pad)' : 0,
          flex: 1,
          minHeight: 0,
        }}
      >
        {children}
      </div>
    </div>
  )
}

/** Configuration for {@link Page}. */
export interface PageProps {
  t: Theme
  title: string
  right?: ReactNode
  hideHeader?: boolean
  children: ReactNode
}

/**
 * Render a one-row screen header above a scrollable body: the title at the
 * leading edge and the screen's actions at the trailing edge.
 */
export function Page({
  t,
  title,
  right,
  hideHeader = false,
  children,
}: PageProps): ReactNode {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {!hideHeader && (
        <div
          style={{
            padding: 'var(--ss-header-pad-y) 20px',
            display: 'flex',
            // Wrap the actions onto their own row in a narrow window.
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '8px 16px',
            borderBottom: `1px solid ${t.borderSoft}`,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              // Match the control height so a header without actions is as
              // tall as one with them.
              minHeight: 'var(--ss-input-h)',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <PageTitle t={t}>{title}</PageTitle>
          </div>
          {right && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
                marginLeft: 'auto',
              }}
            >
              {right}
            </div>
          )}
        </div>
      )}
      <div
        style={{
          flex: 1,
          // Contain absolutely positioned descendants, such as visually
          // hidden text, so they scroll with the body instead of extending
          // the document.
          position: 'relative',
          overflow: 'auto',
          scrollbarGutter: 'stable both-edges',
          padding: 'var(--ss-body-pad-y) 20px 24px',
        }}
      >
        {children}
      </div>
    </div>
  )
}

/** Configuration for {@link PageTitle}. */
export interface PageTitleProps {
  t: Theme
  children: ReactNode
  style?: CSSProperties
  /** Provide an optional ID for `aria-labelledby` relationships. */
  id?: string
  /**
   * Provide an optional tab index. Pass -1 to let keyboard and screen-reader
   * flows move focus to the heading under WCAG 2.2 SC 2.4.3.
   */
  tabIndex?: number
  /** Provide an optional heading reference for programmatic focus. */
  headingRef?: RefObject<HTMLHeadingElement | null>
}

/**
 * Render the shared serif display heading for screen titles.
 * Reserve serif type for display headings and reading surfaces. Keep dense UI,
 * tables, controls, and labels in sans serif. Centralize the style here to keep
 * every screen title consistent.
 */
export function PageTitle({
  t,
  children,
  style,
  id,
  tabIndex,
  headingRef,
}: PageTitleProps): ReactNode {
  return (
    <h1
      ref={headingRef}
      id={id}
      tabIndex={tabIndex}
      style={{
        margin: 0,
        fontFamily: FONTS.serif,
        fontWeight: 400,
        fontSize: 20,
        letterSpacing: -0.3,
        color: t.textStrong,
        // Suppress the interactive focus ring on this non-control focus target.
        outline: 'none',
        ...style,
      }}
    >
      {children}
    </h1>
  )
}

/** Configuration for {@link Divider}. */
export interface DividerProps {
  t: Theme
  label?: string
  style?: CSSProperties
}

/**
 * Render a horizontal rule, or with a label a section heading set off by
 * space alone. Separate items in a row with space instead of a vertical rule.
 */
export function Divider({ t, label, style }: DividerProps): ReactNode {
  if (label) {
    return (
      <h3
        style={{
          margin: '16px 0 4px',
          fontSize: 10,
          color: t.dimText,
          fontFamily: FONTS.sans,
          fontWeight: 600,
          letterSpacing: 0.2,
          ...style,
        }}
      >
        {label}
      </h3>
    )
  }
  return (
    <div
      style={{
        height: 1,
        background: t.borderSoft,
        margin: 'var(--ss-divider-margin) 0',
        ...style,
      }}
    />
  )
}

/** Configuration for {@link Bar}. */
export interface BarProps {
  t: Theme
  value: number
  max?: number
  color?: string
  height?: number
}

/** Render a decorative bar beside the caller's numeric progress text. */
export function Bar({
  t,
  value,
  max = 100,
  color,
  height = 4,
}: BarProps): ReactNode {
  const pct = Math.min(100, Math.max(0, (value / max) * 100))
  return (
    <div
      aria-hidden="true"
      style={{
        width: '100%',
        height,
        background: t.surface3,
        borderRadius: height / 2,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${pct}%`,
          background: color ?? t.accent,
          transition: 'width .3s',
        }}
      />
    </div>
  )
}

/** The kind of text a {@link Code} block holds. */
export type CodeKind =
  | 'command'
  | 'json-config'
  | 'output'
  | 'stdout'
  | 'stderr'
  | 'paths'

/**
 * The visible tag and the accessible name of each {@link CodeKind}. Tags are
 * set as shown: Bash is a name, not an acronym, so it keeps its own case.
 */
const CODE_KIND: Record<CodeKind, { tag: string; name: string }> = {
  command: { tag: 'Bash', name: 'Shell command' },
  'json-config': { tag: 'JSON', name: 'JSON configuration' },
  output: { tag: 'OUTPUT', name: 'Command output' },
  stdout: { tag: 'STDOUT', name: 'Standard output' },
  stderr: { tag: 'STDERR', name: 'Standard error' },
  paths: { tag: 'PATHS', name: 'File locations' },
}

/** Configuration for {@link Code}. */
export interface CodeProps {
  t: Theme
  value: string
  /** What the block holds, which sets its tag and its accessible name. */
  kind?: CodeKind
  maxHeight?: number
}

/** Render a monospace code block under a tag that names its kind. */
export function Code({
  t,
  value,
  kind = 'command',
  maxHeight,
}: CodeProps): ReactNode {
  const { tag, name } = CODE_KIND[kind]
  // A capped block can scroll, so give keyboard users a way to reach and move
  // it, named by what it holds. An uncapped block never scrolls and must not
  // add a tab stop.
  const scrollable =
    maxHeight === undefined
      ? {}
      : { tabIndex: 0, role: 'group', 'aria-label': name }
  return (
    <div
      {...scrollable}
      style={{
        background: t.bg,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 4,
        fontFamily: FONTS.mono,
        fontSize: 11.5,
        color: t.text,
        maxHeight,
        overflow: 'auto',
      }}
    >
      <div
        style={{
          padding: '4px 9px',
          borderBottom: `1px solid ${t.borderSoft}`,
          color: t.dimText,
          fontSize: 10,
          letterSpacing: 0.8,
        }}
      >
        {tag}
      </div>
      <pre
        style={{
          margin: 0,
          padding: '8px 10px',
          // Wrap long lines to prevent horizontal growth. Preserve newlines and
          // spaces, and break otherwise unbreakable path or flag tokens.
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          lineHeight: 'var(--ss-line-tight)',
        }}
      >
        {value}
      </pre>
    </div>
  )
}

/** Configuration for {@link PathRow}. */
export interface PathRowProps {
  t: Theme
  value: string
  copyable?: boolean
  onCopy?: () => void
}

/**
 * Use a monospace path display that truncates from the left with a copy affordance.
 */
export function PathRow({
  t,
  value,
  copyable = true,
  onCopy,
}: PathRowProps): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: t.bg,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 4,
        padding: '4px 8px',
        fontFamily: FONTS.mono,
        fontSize: 11.5,
        color: t.text,
        direction: 'rtl',
        textAlign: 'left',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
      }}
    >
      <span
        style={{
          direction: 'ltr',
          unicodeBidi: 'bidi-override',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flex: 1,
        }}
      >
        {value}
      </span>
      {copyable && (
        <button
          type="button"
          aria-label="Copy path"
          onClick={onCopy}
          style={{
            direction: 'ltr',
            color: t.dim,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            display: 'inline-flex',
          }}
        >
          <Ico d={ICONS.copy} />
        </button>
      )}
    </div>
  )
}

/** One {@link Segments} option. */
export type SegmentOption =
  | string
  | { value: string; label: string; title?: string }

/** Configuration for {@link Segments}. */
export interface SegmentsProps {
  t: Theme
  value: string
  options: readonly SegmentOption[]
  onChange?: (value: string) => void
  small?: boolean
  ariaLabel?: string
  /** Provide hint or error IDs that describe this radio group. */
  ariaDescribedBy?: string | undefined
  /**
   * List option values that must remain visible but unavailable. Keep disabled
   * options focusable and announced with `aria-disabled` under the APG. Skip
   * them during arrow navigation, and ignore click or Enter activation.
   */
  disabledOptions?: readonly string[] | undefined
}

/**
 * Use an accessible single-select segmented control (radiogroup + arrow keys).
 */
export function Segments({
  t,
  value,
  options,
  onChange,
  small,
  ariaLabel,
  ariaDescribedBy,
  disabledOptions,
}: SegmentsProps): ReactNode {
  const semantics = useFieldControlSemantics({
    ariaDescribedBy,
    invalid: false,
  })
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const values = options.map((o) => (typeof o === 'string' ? o : o.value))
  const isDisabled = (v: string): boolean =>
    disabledOptions?.includes(v) ?? false
  const selectedIndex = values.indexOf(value)
  const fallbackFocusIndex = values.findIndex(
    (candidate) => !isDisabled(candidate),
  )

  const move = (delta: number): void => {
    const n = values.length
    const current = values.indexOf(value)
    for (let step = 1; step <= n; step++) {
      const next = (((current + delta * step) % n) + n) % n
      const nextValue = values[next]
      if (nextValue !== undefined && !isDisabled(nextValue)) {
        onChange?.(nextValue)
        refs.current[next]?.focus()
        return
      }
    }
  }

  return (
    <div
      id={semantics.id}
      role="radiogroup"
      aria-label={semantics.labelledBy ? undefined : ariaLabel}
      aria-labelledby={semantics.labelledBy}
      aria-describedby={semantics.describedBy}
      data-component-boundary="segmented-control"
      style={{
        display: 'inline-flex',
        // Hug the options in a column-flex or grid parent instead of
        // stretching an empty track across it.
        width: 'fit-content',
        maxWidth: '100%',
        justifySelf: 'start',
        // Wrap the options onto further rows in a narrow column instead of
        // squeezing them until their labels wrap and clip.
        flexWrap: 'wrap',
        background: t.surface2,
        border: `1px solid ${t.dim}`,
        borderRadius: 5,
        padding: 2,
        gap: 2,
      }}
    >
      {options.map((o, i) => {
        const v = typeof o === 'string' ? o : o.value
        const lbl = typeof o === 'string' ? o : o.label
        const tip = typeof o === 'string' ? undefined : o.title
        const active = value === v
        const disabled = isDisabled(v)
        return (
          <button
            key={v}
            type="button"
            role="radio"
            title={tip}
            aria-checked={active}
            aria-disabled={disabled || undefined}
            data-component-boundary={
              active && !disabled ? 'segmented-control-selection' : undefined
            }
            ref={(el) => {
              refs.current[i] = el
            }}
            tabIndex={
              active || (selectedIndex === -1 && i === fallbackFocusIndex)
                ? 0
                : -1
            }
            onClick={() => {
              if (!disabled) onChange?.(v)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                move(1)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                move(-1)
              } else if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault()
                const available = values
                  .map((candidate, index) => ({ candidate, index }))
                  .filter(({ candidate }) => !isDisabled(candidate))
                const target =
                  e.key === 'Home' ? available[0] : available.at(-1)
                if (target) {
                  onChange?.(target.candidate)
                  refs.current[target.index]?.focus()
                }
              }
            }}
            style={{
              // Keep the 24 px target floor while letting a taller text scale
              // grow the option, and keep each label on one line so it is never
              // split mid-phrase. The width floor covers one-letter labels.
              minHeight: 24,
              minWidth: 24,
              whiteSpace: 'nowrap',
              padding: small ? '0 7px' : '0 10px',
              // Mark the selection with a solid accent fill rather than an
              // outline; the fill holds 3:1 against the track. Keep the
              // transparent border so the option keeps its size.
              border: '1px solid transparent',
              borderRadius: 3,
              background: active ? t.accent : 'transparent',
              color: disabled ? t.dim : active ? t.accentInk : t.dim,
              opacity: disabled ? 0.45 : 1,
              fontFamily: FONTS.sans,
              fontSize: small ? 10.5 : 11.5,
              fontWeight: active ? 700 : 400,
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            {lbl}
          </button>
        )
      })}
    </div>
  )
}
