/**
 * Follows the WAI-ARIA disclosure pattern with a native button, controlled
 * expansion state, and an `aria-controls` relationship. Collapsed status
 * information stays in the caller-provided header.
 */

import type { CSSProperties, ReactNode } from 'react'
import { useState } from 'react'
import { type Theme } from '../theme/tokens'
import { Ico } from './icons'
import { ICONS } from './icon-set'

/** State and content for an accessible disclosure. */
export interface CollapsibleProps {
  t: Theme
  id: string
  open: boolean
  onToggle: () => void
  header: ReactNode
  children: ReactNode
  style?: CSSProperties
}

/** Render an accessible disclosure. */
export function Collapsible({
  t,
  id,
  open,
  onToggle,
  header,
  children,
  style,
}: CollapsibleProps): ReactNode {
  const [hover, setHover] = useState(false)
  return (
    <div style={style}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: '100%',
          minHeight: 'var(--ss-row-min-h)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          border: 'none',
          background: hover ? t.surface2 : 'transparent',
          color: t.text,
          cursor: 'pointer',
          textAlign: 'left',
          font: 'inherit',
        }}
      >
        <Ico
          d={ICONS.chevron}
          stroke={t.dim}
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform .15s',
          }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>{header}</span>
      </button>
      {open && <div id={id}>{children}</div>}
    </div>
  )
}
