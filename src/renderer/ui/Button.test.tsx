import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Btn, type BtnProps } from './Button'
import { THEMES, highContrastTheme, type Theme } from '../theme/tokens'

type Tone = Pick<
  BtnProps,
  'primary' | 'secondary' | 'ghost' | 'danger' | 'success'
>

const TONES: Tone[] = [
  {},
  { secondary: true },
  { ghost: true },
  { danger: true },
  { success: true },
]

/** One tone with the pressed look it should take and the look it replaces. */
interface ToneCase {
  tone: Tone
  fill: string
  label: string
  /** The unpressed fill, or the surface a transparent ghost button shows. */
  backdrop: string
}

function toneCases(t: Theme): ToneCase[] {
  return [
    { tone: {}, fill: t.text, label: t.surface, backdrop: t.surface2 },
    {
      tone: { secondary: true },
      fill: t.accent,
      label: t.accentInk,
      backdrop: t.surface2,
    },
    {
      tone: { ghost: true },
      fill: t.text,
      label: t.surface,
      backdrop: t.surface,
    },
    {
      tone: { danger: true },
      fill: t.failed,
      label: t.surface,
      backdrop: t.failedSoft,
    },
    {
      tone: { success: true },
      fill: t.done,
      label: t.accentInk,
      backdrop: t.doneSoft,
    },
  ]
}

function renderToggle(
  t: Theme,
  tone: Tone,
  ariaPressed: boolean | undefined,
  extra: Partial<BtnProps> = {},
): HTMLButtonElement {
  // Leave the prop out entirely for a plain, non-toggle button.
  const pressed = ariaPressed === undefined ? {} : { ariaPressed }
  const { unmount } = render(
    <Btn t={t} label="Toggle" {...pressed} {...tone} {...extra} />,
  )
  const button = screen.getByRole('button', { name: 'Toggle' })
  const snapshot = button.cloneNode(true) as HTMLButtonElement
  unmount()
  return snapshot
}

/** Render a pressed toggle under the pointer and return its hover fill. */
function hoverFill(t: Theme, tone: Tone): string {
  const { unmount } = render(<Btn t={t} label="Toggle" ariaPressed {...tone} />)
  const button = screen.getByRole('button', { name: 'Toggle' })
  fireEvent.mouseEnter(button)
  const fill = button.style.background
  unmount()
  return fill
}

type Rgb = [number, number, number]

/** Read an opaque `#rrggbb` token or an `rgb()` value as channels. */
function rgb(color: string): Rgb {
  const fn = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
  const hex = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  const [r, g, b] = fn
    ? fn.slice(1, 4).map(Number)
    : (hex?.slice(1, 4).map((pair) => parseInt(pair, 16)) ?? [])
  if (r === undefined || g === undefined || b === undefined) {
    throw new Error(`Supply an opaque color, not ${color}.`)
  }
  return [r, g, b]
}

/** Calculate the WCAG 2.2 contrast ratio between two opaque colors. */
function contrast(a: Rgb, b: Rgb): number {
  const lum = ([r, g, b2]: Rgb): number => {
    const f = (c: number): number => {
      const s = c / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b2)
  }
  const hi = Math.max(lum(a), lum(b))
  const lo = Math.min(lum(a), lum(b))
  return (hi + 0.05) / (lo + 0.05)
}

/** Resolve `color-mix(in srgb, a p%, b)` with two opaque colors to channels. */
function resolveMix(value: string): Rgb {
  const parts = value.match(
    /^color-mix\(in srgb, (rgb\([^)]*\)) (\d+)%, (rgb\([^)]*\))\)$/,
  )
  if (!parts?.[1] || !parts[2] || !parts[3]) {
    throw new Error(`Supply an sRGB color-mix of two colors, not ${value}.`)
  }
  const share = Number(parts[2]) / 100
  const b = rgb(parts[3])
  return rgb(parts[1]).map(
    (c, i) => c * share + (b[i] ?? 0) * (1 - share),
  ) as Rgb
}

describe('Btn pressed-state contrast (WCAG 2.2 SC 1.4.3 and 1.4.11)', () => {
  const themes = {
    dark: THEMES.dark,
    light: THEMES.light,
    'high-contrast dark': highContrastTheme(THEMES.dark),
    'high-contrast light': highContrastTheme(THEMES.light),
  }
  for (const [themeName, t] of Object.entries(themes)) {
    it(`keeps the label and the state change legible in the ${themeName} theme`, () => {
      for (const { tone, backdrop } of toneCases(t)) {
        const pressed = renderToggle(t, tone, true)
        const unpressed = renderToggle(t, tone, false)
        const fill = rgb(pressed.style.backgroundColor)
        const label = rgb(pressed.style.color)
        const hover = resolveMix(hoverFill(t, tone))
        // Measure the drawn unpressed fill; a transparent ghost button shows
        // the surface under it.
        const offFill = tone.ghost
          ? rgb(backdrop)
          : rgb(unpressed.style.backgroundColor)
        expect(offFill).toEqual(rgb(backdrop))
        expect(contrast(label, fill)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(label, hover)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(fill, offFill)).toBeGreaterThanOrEqual(3)
        expect(
          contrast(rgb(unpressed.style.color), offFill),
        ).toBeGreaterThanOrEqual(4.5)
      }
    })
  }
})

describe('Btn pressed state', () => {
  for (const [themeName, t] of Object.entries(THEMES)) {
    describe(`${themeName} theme`, () => {
      it('keeps aria-pressed as the caller sets it', () => {
        expect(renderToggle(t, {}, true)).toHaveAttribute(
          'aria-pressed',
          'true',
        )
        expect(renderToggle(t, {}, false)).toHaveAttribute(
          'aria-pressed',
          'false',
        )
        expect(renderToggle(t, {}, undefined)).not.toHaveAttribute(
          'aria-pressed',
        )
      })

      it('draws an unpressed toggle exactly like a plain button', () => {
        for (const tone of TONES) {
          const plain = renderToggle(t, tone, undefined)
          const unpressed = renderToggle(t, tone, false)
          expect(unpressed.getAttribute('style')).toBe(
            plain.getAttribute('style'),
          )
          expect(unpressed.style.boxShadow).toBe('')
        }
      })

      it('fills a pressed toggle with its tone and draws an inset keyline', () => {
        for (const { tone, fill, label } of toneCases(t)) {
          const pressed = renderToggle(t, tone, true)
          const unpressed = renderToggle(t, tone, false)
          expect(pressed).toHaveStyle({
            background: fill,
            color: label,
            border: `1px solid ${fill}`,
          })
          expect(pressed.style.boxShadow).toMatch(
            /^inset 0 0 0 1px currentcolor$/i,
          )
          expect(pressed.style.background).not.toBe(unpressed.style.background)
          expect(pressed.style.color).not.toBe(unpressed.style.color)
        }
      })

      it('keeps a neutral pressed toggle off the accent', () => {
        // A pressed Defer verdict must not read as a green Pass.
        const pressed = renderToggle(t, {}, true)
        expect(pressed).not.toHaveStyle({ background: t.accent })
      })

      it('keeps the pressed toggle the same size as the unpressed one', () => {
        for (const small of [false, true]) {
          for (const tone of TONES) {
            const on = renderToggle(t, tone, true, { small }).style
            const off = renderToggle(t, tone, false, { small }).style
            expect(on.height).toBe(off.height)
            expect(on.padding).toBe(off.padding)
            expect(on.borderWidth).toBe(off.borderWidth)
            expect(on.fontSize).toBe(off.fontSize)
            expect(on.fontWeight).toBe(off.fontWeight)
          }
        }
      })

      it('marks a pressed ghost toggle as an audited component boundary', () => {
        expect(
          renderToggle(t, { ghost: true }, false).dataset.componentBoundary,
        ).toBeUndefined()
        expect(
          renderToggle(t, { ghost: true }, true).dataset.componentBoundary,
        ).toBe('button')
      })

      it('keeps a doubled edge on a disabled pressed toggle', () => {
        const pressed = renderToggle(t, {}, true, { disabled: true })
        expect(pressed).toHaveStyle({ background: t.surface2, color: t.dim })
        expect(pressed.style.boxShadow).toBe(`inset 0 0 0 1px ${t.dim}`)
      })

      it('shifts the pressed fill on hover', () => {
        render(<Btn t={t} label="Toggle" ghost ariaPressed />)
        const button = screen.getByRole('button', { name: 'Toggle' })
        const resting = button.style.background
        fireEvent.mouseEnter(button)
        expect(button.style.background).toContain('color-mix')
        expect(button.style.background).not.toBe(resting)
        fireEvent.mouseLeave(button)
        expect(button.style.background).toBe(resting)
      })
    })
  }
})

/** Render a disclosure button and return a detached snapshot of it. */
function renderDisclosure(
  t: Theme,
  tone: Tone,
  expanded: boolean,
  extra: Partial<BtnProps> = {},
): HTMLButtonElement {
  const { unmount } = render(
    <Btn
      t={t}
      label="Details"
      ariaExpanded={expanded}
      ariaControls="details-region"
      {...tone}
      {...extra}
    />,
  )
  const button = screen.getByRole('button', { name: 'Details' })
  const snapshot = button.cloneNode(true) as HTMLButtonElement
  unmount()
  return snapshot
}

describe('Btn disclosure', () => {
  for (const [themeName, t] of Object.entries(THEMES)) {
    describe(`${themeName} theme`, () => {
      it('reports expansion and the controlled region, never a pressed state', () => {
        for (const expanded of [false, true]) {
          const button = renderDisclosure(t, { ghost: true }, expanded)
          expect(button).toHaveAttribute('aria-expanded', String(expanded))
          expect(button).toHaveAttribute('aria-controls', 'details-region')
          expect(button).not.toHaveAttribute('aria-pressed')
          // A stray ariaPressed never turns a disclosure into a toggle.
          const stray = renderDisclosure(t, { ghost: true }, expanded, {
            ariaPressed: true,
          })
          expect(stray).not.toHaveAttribute('aria-pressed')
          expect(stray.getAttribute('style')).toBe(button.getAttribute('style'))
        }
      })

      it('keeps the tone unpressed look in both states', () => {
        for (const tone of TONES) {
          const plain = renderToggle(t, tone, undefined)
          const closed = renderDisclosure(t, tone, false)
          const open = renderDisclosure(t, tone, true)
          expect(closed.getAttribute('style')).toBe(plain.getAttribute('style'))
          expect(open.getAttribute('style')).toBe(plain.getAttribute('style'))
          expect(open.style.boxShadow).toBe('')
        }
      })

      it('turns a leading chevron down while the region shows', () => {
        const closed = renderDisclosure(t, { ghost: true }, false)
        const open = renderDisclosure(t, { ghost: true }, true)
        const closedChevron = closed.querySelector('svg')
        const openChevron = open.querySelector('svg')
        expect(closed.firstElementChild).toBe(closedChevron)
        expect(closedChevron).toHaveAttribute('aria-hidden', 'true')
        expect(closedChevron?.style.transform).toBe('none')
        expect(openChevron?.style.transform).toBe('rotate(90deg)')
        expect(open.textContent).toBe(closed.textContent)
      })

      it('leaves a plain button without disclosure attributes or chevron', () => {
        const plain = renderToggle(t, { ghost: true }, undefined)
        expect(plain).not.toHaveAttribute('aria-expanded')
        expect(plain).not.toHaveAttribute('aria-controls')
        expect(plain.querySelector('svg')).toBeNull()
      })
    })
  }
})
