import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { StatusCell, StatusGlyph } from './StatusCell'
import { StatusLegend } from './StatusLegend'
import {
  cellStateLabel,
  statusGlyphColor,
  statusGlyphShape,
  statusGlyphSoft,
} from './status'
import {
  DENSITY,
  highContrastTheme,
  statusColor,
  THEMES,
  type Theme,
} from '../theme/tokens'
import { emptyCell, type CellState } from '../../shared/types'

const density = DENSITY.cozy

/** Light, dark, and the high-contrast variant of each. */
const FOUR_THEMES: readonly Theme[] = [
  THEMES.light,
  THEMES.dark,
  highContrastTheme(THEMES.light),
  highContrastTheme(THEMES.dark),
]

/** Every cell state; the record fails the type check when a state is added. */
const ALL_STATES = Object.keys({
  pending: true,
  planned: true,
  waiting: true,
  queued: true,
  running: true,
  cancelling: true,
  done: true,
  failed: true,
  cancelled: true,
  blocked: true,
  withheld: true,
  interrupted: true,
  stale: true,
  skipped: true,
  outdated: true,
} satisfies Record<CellState, true>) as CellState[]

/** The states the legend lists whatever the matrix shows. */
const CORE_STATES: readonly CellState[] = [
  'done',
  'failed',
  'running',
  'pending',
  'skipped',
  'outdated',
]

function renderCell(st: CellState, t: Theme = THEMES.dark): HTMLElement {
  const { container } = render(
    <StatusCell
      cell={{ ...emptyCell(), st, progress: 40 }}
      density={density}
      t={t}
      stepLabel="recon-all"
    />,
  )
  return container.querySelector('[role="img"]') as HTMLElement
}

/** Parse a #rrggbb color into channels. */
function rgb(hex: string): [number, number, number] {
  const value = /^#([0-9a-f]{6})$/i.exec(hex)?.[1]
  if (!value) throw new Error(`Use a #rrggbb color, not ${hex}.`)
  return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ]
}

/**
 * Composite a #rrggbb or rgba() fill over an opaque #rrggbb base, returning
 * the #rrggbb color the eye sees.
 */
function over(fill: string, base: string): string {
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(fill)
  if (!rgba) return fill
  const alpha = Number(rgba[4])
  const under = rgb(base)
  return `#${[1, 2, 3]
    .map((at, index) =>
      Math.round(Number(rgba[at]) * alpha + (under[index] ?? 0) * (1 - alpha))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/** Calculate the WCAG contrast ratio of two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r, g, bl] = rgb(hex).map((channel) => {
      const s = channel / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ]
  return (hi + 0.05) / (lo + 0.05)
}

describe('StatusGlyph shapes', () => {
  it('gives every cell state a shape of its own', () => {
    const shapes = ALL_STATES.map(statusGlyphShape)
    expect(new Set(shapes).size).toBe(ALL_STATES.length)
  })

  it('draws each state with its named shape and distinct markup', () => {
    const markup = new Map<string, CellState>()
    for (const st of ALL_STATES) {
      const cell = renderCell(st)
      const glyph = cell.querySelector('[data-glyph-shape]')
      expect(glyph).toHaveAttribute('data-glyph-shape', statusGlyphShape(st))
      // Compare the drawing without the shape name, so two states cannot
      // pass by naming the same drawing differently.
      const drawing = cell.innerHTML.replace(/ data-glyph-shape="[^"]*"/g, '')
      expect(markup.get(drawing)).toBeUndefined()
      markup.set(drawing, st)
    }
    expect(markup.size).toBe(ALL_STATES.length)
  })

  it('draws a state shape in a given color in place of its tone', () => {
    const t = THEMES.light
    const { container } = render(
      <StatusGlyph st="planned" t={t} color={t.dim} />,
    )
    const ring = container.querySelector('[data-glyph-shape="dashed-ring"]')
    expect(ring).toHaveAttribute('stroke', t.dim)
    expect(t.dim).not.toBe(statusGlyphColor(t, 'planned'))
  })

  it('names every state and marks every cell for the non-text contrast audit', () => {
    for (const st of ALL_STATES) {
      const cell = renderCell(st)
      expect(cell).toHaveAccessibleName(`recon-all: ${cellStateLabel(st)}`)
      expect(cell).toHaveAttribute('data-nontext-contrast', 'status-glyph')
    }
  })

  it('draws interrupted in the amber its tile, progress segment, and row edge use', () => {
    // The legend, the matrix cells, and Recent runs draw the bolt in the
    // same amber as the tile, the header segment, and the row edges.
    for (const t of FOUR_THEMES) {
      expect(statusGlyphColor(t, 'interrupted')).toBe(t.warning)
      expect(statusGlyphColor(t, 'interrupted')).toBe(
        statusColor(t, 'interrupted'),
      )
      expect(statusGlyphColor(t, 'interrupted')).not.toBe(t.failed)
    }
  })

  it('keeps every glyph at 3:1 or better on its badge tint over the Logs fills', () => {
    // A Logs badge draws the glyph on its tone's tint, over the page (the
    // rail), a panel (the Selected job card), or the selected row.
    for (const t of FOUR_THEMES) {
      for (const base of [t.bg, t.surface, t.surface2]) {
        for (const st of ALL_STATES) {
          const tint = over(statusGlyphSoft(t, st), base)
          expect(
            contrast(statusGlyphColor(t, st), tint),
            `${st} on ${statusGlyphSoft(t, st)} over ${base}`,
          ).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })

  it('keeps every glyph color at 3:1 or better on the matrix row fills', () => {
    for (const t of FOUR_THEMES) {
      for (const fill of [t.bg, t.surface, t.surface2, t.accentSoft]) {
        for (const st of ALL_STATES) {
          expect(
            contrast(statusGlyphColor(t, st), fill),
            `${st} on ${fill}`,
          ).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })
})

describe('StatusLegend entries', () => {
  it('lists the core states and adds a run state only while a cell shows it', () => {
    const { container, rerender } = render(<StatusLegend t={THEMES.dark} />)
    const listed = (): string[] =>
      [...container.querySelectorAll('[data-legend-glyph]')].map(
        (sample) => sample.getAttribute('data-legend-glyph') ?? '',
      )
    expect(listed()).toEqual(CORE_STATES)

    rerender(
      <StatusLegend t={THEMES.dark} states={['done', 'stale', 'waiting']} />,
    )
    expect(listed()).toEqual([...CORE_STATES, 'waiting', 'stale'])
  })

  it.each(ALL_STATES)(
    'draws the %s sample with the glyph and name its cell uses',
    (st) => {
      const { container } = render(
        <StatusLegend t={THEMES.light} states={[st]} />,
      )
      const sample = container.querySelector(`[data-legend-glyph="${st}"]`)
      const cell = renderCell(st, THEMES.light)
      expect(sample).not.toBeNull()
      if (st === 'running') {
        // The sample keeps the ring still at a fixed half-filled arc.
        expect(sample?.querySelector('[data-glyph-shape]')).toHaveAttribute(
          'data-glyph-shape',
          'progress-ring',
        )
      } else {
        expect(sample?.innerHTML).toBe(cell.innerHTML)
      }
      const label = cellStateLabel(st)
      expect(
        within(sample?.parentElement as HTMLElement).getByText(
          `${label.charAt(0).toUpperCase()}${label.slice(1)}`,
        ),
      ).toBeInTheDocument()
    },
  )

  it('names the unknown state as the cells do', () => {
    render(<StatusLegend t={THEMES.dark} states={['stale', 'cancelling']} />)
    expect(screen.getByText('Status unknown')).toBeInTheDocument()
    expect(screen.getByText('Canceling')).toBeInTheDocument()
  })
})
