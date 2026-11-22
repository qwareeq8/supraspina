import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  ReviewChip,
  ReviewGlyph,
  reviewIcon,
  reviewTone,
  type ReviewState,
} from './ReviewGlyph'
import {
  highContrastTheme,
  statusColor,
  statusSoft,
  THEMES,
  type Theme,
} from '../theme/tokens'

/** Light, dark, and the high-contrast variant of each. */
const FOUR_THEMES: readonly Theme[] = [
  THEMES.light,
  THEMES.dark,
  highContrastTheme(THEMES.light),
  highContrastTheme(THEMES.dark),
]

/** Every review state; the record fails the type check when one is added. */
const ALL_STATES = Object.keys({
  pass: true,
  fail: true,
  review: true,
  unreviewed: true,
  stale: true,
  incomplete: true,
} satisfies Record<ReviewState, true>) as ReviewState[]

/** Parse a #rrggbb or rgba() color into channels and alpha. */
function parse(color: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1]
  if (hex) {
    const [r, g, b] = [0, 2, 4].map((at) =>
      parseInt(hex.slice(at, at + 2), 16),
    ) as [number, number, number]
    return [r, g, b, 1]
  }
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color)
  if (!rgba) throw new Error(`Use #rrggbb or rgba(), not ${color}.`)
  return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])]
}

/** Composite a color over an opaque base and return the seen channels. */
function over(fill: string, base: string): [number, number, number] {
  const [r, g, b, a] = parse(fill)
  const [br, bg, bb] = parse(base)
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)]
}

/** Calculate the WCAG contrast ratio of two channel triples. */
function contrast(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const lum = (c: [number, number, number]): number => {
    const [r, g, bl] = c.map((channel) => {
      const s = channel / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe('ReviewGlyph', () => {
  it('draws the agreed ring for each review state', () => {
    expect(
      Object.fromEntries(ALL_STATES.map((s) => [s, reviewIcon(s)])),
    ).toEqual({
      pass: 'circleCheck',
      fail: 'circleX',
      review: 'circlePause',
      unreviewed: 'ring',
      stale: 'circleRerun',
      incomplete: 'circleEllipsis',
    })
  })

  it('keeps the tone of the status dot it replaces and hides from readers', () => {
    const t = THEMES.light
    for (const state of ALL_STATES) {
      const { container, unmount } = render(<ReviewGlyph t={t} state={state} />)
      const glyph = container.querySelector('svg')
      expect(glyph).toHaveAttribute('aria-hidden', 'true')
      expect(glyph).toHaveAttribute('data-glyph-shape', reviewIcon(state))
      expect(glyph).toHaveAttribute('stroke', statusColor(t, reviewTone(state)))
      unmount()
    }
  })

  it('leads a chip word with the glyph on its tone tint', () => {
    render(<ReviewChip t={THEMES.dark} state="stale" label="Stale review" />)
    const chip = screen.getByText('Stale review')
    expect(chip.querySelector('svg')).toHaveAttribute(
      'data-glyph-shape',
      'circleRerun',
    )
  })

  it('keeps every glyph at 3:1 or better on its tint and on bare rail fills', () => {
    for (const t of FOUR_THEMES) {
      for (const state of ALL_STATES) {
        const tone = reviewTone(state)
        const glyph = parse(statusColor(t, tone)).slice(0, 3) as [
          number,
          number,
          number,
        ]
        for (const base of [t.bg, t.surface, t.surface2]) {
          expect(
            contrast(glyph, over(statusSoft(t, tone), base)),
            `${state} on its tint over ${base}`,
          ).toBeGreaterThanOrEqual(3)
          expect(
            contrast(glyph, over(base, base)),
            `${state} on ${base}`,
          ).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })
})
