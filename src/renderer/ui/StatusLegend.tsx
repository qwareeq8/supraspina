/**
 * Draws each legend sample with the matrix cell's own glyph, and stays
 * outside the fast-refresh-friendly status helper module.
 */

import type { ReactNode } from 'react'
import type { CellState } from '../../shared/types'
import { StatusGlyph } from './StatusCell'
import { cellStateLabel } from './status'
import { FONTS, type Theme } from '../theme/tokens'

/**
 * Whether the legend always lists a state or only while a matrix cell shows
 * it, in legend order. Run states such as waiting or blocked appear only
 * during or after a run, so listing them always would crowd the legend.
 * Every state carries a tier, so a new state fails the type check until the
 * legend knows it.
 */
const LEGEND_TIER: Record<CellState, 'always' | 'when-shown'> = {
  done: 'always',
  failed: 'always',
  running: 'always',
  pending: 'always',
  skipped: 'always',
  outdated: 'always',
  planned: 'when-shown',
  waiting: 'when-shown',
  queued: 'when-shown',
  cancelling: 'when-shown',
  cancelled: 'when-shown',
  blocked: 'when-shown',
  withheld: 'when-shown',
  interrupted: 'when-shown',
  stale: 'when-shown',
}

const LEGEND_ORDER = Object.keys(LEGEND_TIER) as CellState[]

/** Name a legend entry the way cell names state it, in sentence case. */
function legendLabel(st: CellState): string {
  const label = cellStateLabel(st)
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`
}

/** The theme and the states the matrix beside the legend shows. */
export interface StatusLegendProps {
  t: Theme
  /**
   * The cell states the matrix shows. The legend always lists the core
   * states and adds any other state found here.
   */
  states?: Iterable<CellState> | undefined
}

/** Render the canonical matrix-status legend. */
export function StatusLegend({ t, states }: StatusLegendProps): ReactNode {
  const shown = new Set(states ?? [])
  const items = LEGEND_ORDER.filter(
    (st) => LEGEND_TIER[st] === 'always' || shown.has(st),
  )
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        columnGap: 10,
        rowGap: 4,
      }}
    >
      {items.map((st) => (
        <span
          key={st}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontFamily: FONTS.sans,
            fontSize: 11,
            fontWeight: 400,
            // Keep small legend labels above the readable contrast floor.
            color: t.textSoft,
            whiteSpace: 'nowrap',
          }}
        >
          <span
            aria-hidden="true"
            data-legend-glyph={st}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 11,
            }}
          >
            <StatusGlyph st={st} t={t} progress={50} animate={false} />
          </span>
          {legendLabel(st)}
        </span>
      ))}
    </span>
  )
}
