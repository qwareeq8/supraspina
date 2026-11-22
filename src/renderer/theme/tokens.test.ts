/// <reference types="node" />

/**
 * Tests for theme token derivations, covering the high-contrast transformation
 * while preserving status and accent hues.
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChipStatus } from '../../shared/types'
import {
  DENSITY,
  FONTS,
  STATUS_LABEL,
  THEMES,
  highContrastTheme,
  statusColor,
  statusSoft,
} from './tokens'

const globalCss = readFileSync('src/renderer/theme/global.css', 'utf8')

function productionRendererSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return productionRendererSources(path)
    if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.test\./.test(entry.name)) {
      return []
    }
    return [readFileSync(path, 'utf8')]
  })
}

const rendererSource = productionRendererSources('src/renderer').join('\n')

const REVIEWED_FONT_SHA256 = {
  'WebCM Mono 10 Bold.woff2':
    'df5f801c10d7067e8cf923113f5fea4c478dcd17b2898dc61147671ce4cc989e',
  'WebCM Mono 10 BoldOblique.woff2':
    'ab3a719692fb15552cd246fb2f67d6ffa24ea7737a89c418273c22422fb404db',
  'WebCM Mono 10 Book.woff2':
    '480bcec325d29c39ae57d43f7b3bf94bae5e890ffe77de96320237c99af2fb92',
  'WebCM Mono 10 BookItalic.woff2':
    '390df3a19dacf637f75d58d9dcc8a99d512b55c0a6844c08f73821d43f948c5a',
  'WebCM Mono 10 Italic.woff2':
    '51251813b73c35fe41dce801838815d3120d86b5ea26a4ec4ce195e482c039a3',
  'WebCM Mono 10 Regular.woff2':
    'a68b4033487b8d774c672bb5ea7d499748b3e69b85131c1ece613df3cebadcf8',
  'WebCM Sans 10 Bold.woff2':
    'aba4b53df9a50c3b08891d015dd57c72947552e8fdcd91b62aeff39d1a613984',
  'WebCM Sans 10 BoldOblique.woff2':
    'ac8efeddc070c13b63e97927522a94dd06dd85bf0e72027e7202450991f66bc6',
  'WebCM Sans 10 Book.woff2':
    '0c9c992f9100224cfeb3712975511bb7bdaed87f1a9d9141dcb6264244c811a5',
  'WebCM Sans 10 BookOblique.woff2':
    '9e65bd2f5af9bd0ca80123d81a5979d3ee9978c43d97d8f225ee0b0702bdb09e',
  'WebCM Sans 10 Oblique.woff2':
    'f8cadfa91b7bbaddeebdb86372a8602b792893fee1be5360dfb477936c4497f9',
  'WebCM Sans 10 Regular.woff2':
    'fb95d6a36695bd00ad46b05bd6833bd3100378ddf289fd4335209cf506d0fb44',
  'WebCM Serif 10 Bold.woff2':
    '4d3194bb90a947d86989e72a6bae1e6f6dfbc09299132618cc9f1dbed8a7bb0f',
  'WebCM Serif 10 BoldItalic.woff2':
    '4de21f5ec7985d7b07fd49f40883b0dd7a8c3f803231a336dba29a4f72341ed2',
  'WebCM Serif 10 Book.woff2':
    '51f24087b66a4129a7ac16fe60495303c242fc560c7a0c79e3e1de987ebf406f',
  'WebCM Serif 10 BookItalic.woff2':
    '11075ecf479837a9f9f8956113e626492f32462b212c051513ffda32bfa491d4',
  'WebCM Serif 10 Italic.woff2':
    'b9cf3e2dc2b054bba752a759b54e3622cc1db45fd1aa08a90da6c9ef6d94f102',
  'WebCM Serif 10 Regular.woff2':
    'a760441705fafd40b1dcdb40e1eb29d65c7e649e9ce9d168738b924ac0916ccb',
} as const

describe('bundled typography contract', () => {
  it('declares the exact eighteen local faces and disables synthesis', () => {
    const faces = [...globalCss.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(
      (match) => match[1] ?? '',
    )
    expect(faces).toHaveLength(18)
    for (const face of faces) {
      expect(face).toMatch(
        /src:\s*url\('\.\.\/assets\/fonts\/WebCM (?:Sans|Serif|Mono) 10 [A-Za-z]+\.woff2'\)\s+format\('woff2'\)/,
      )
      expect(face).toContain('font-display: swap')
      expect(face).not.toMatch(/https?:|local\(/i)
    }
    expect(globalCss).toContain('font-synthesis: none')
    for (const family of ['WebCM Sans 10', 'WebCM Serif 10', 'WebCM Mono 10']) {
      expect(faces.filter((face) => face.includes(`'${family}'`))).toHaveLength(
        6,
      )
    }
    const fontFiles = readdirSync('src/renderer/assets/fonts')
      .filter((name) => name.endsWith('.woff2'))
      .sort()
    expect(fontFiles).toHaveLength(18)
    expect(readdirSync('src/renderer/assets/fonts').sort()).toEqual(
      expect.arrayContaining(['GUST-FONT-LICENSE.txt', 'MANIFEST-WebCM.txt']),
    )
  })

  it('keeps every reviewed face byte-for-byte exact', () => {
    expect(
      readdirSync('src/renderer/assets/fonts')
        .filter((name) => name.endsWith('.woff2'))
        .sort(),
    ).toEqual(Object.keys(REVIEWED_FONT_SHA256).sort())
    for (const [name, expected] of Object.entries(REVIEWED_FONT_SHA256)) {
      const bytes = readFileSync(join('src/renderer/assets/fonts', name))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected)
    }
  })

  it('maps each semantic stack to its exact family and local fallbacks', () => {
    expect(FONTS.sans).toMatch(/^'WebCM Sans 10'.*sans-serif$/)
    expect(FONTS.serif).toMatch(/^'WebCM Serif 10'.*serif$/)
    expect(FONTS.mono).toMatch(/^'WebCM Mono 10'.*monospace$/)
  })

  it('maps 400/500/700 normal and italic and activates every face', () => {
    const faces = [...globalCss.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(
      (match) => match[1] ?? '',
    )
    const declaredFaces = new Set(
      faces.map((face) => {
        const family = face.match(/font-family:\s*'([^']+)'/)?.[1]
        const weight = face.match(/font-weight:\s*(\d+)/)?.[1]
        const style = face.match(/font-style:\s*(\w+)/)?.[1]
        return `${family}:${weight}:${style}`
      }),
    )

    for (const family of ['WebCM Sans 10', 'WebCM Serif 10', 'WebCM Mono 10']) {
      for (const weight of [400, 500, 700]) {
        expect(declaredFaces).toContain(`${family}:${weight}:normal`)
        expect(declaredFaces).toContain(`${family}:${weight}:italic`)
      }
    }
    expect(rendererSource).toContain('data-font-activation="fonts-18"')
    expect(rendererSource).toContain('fontWeight: face.weight')
    expect(rendererSource).toContain('fontStyle: face.style')
    expect(rendererSource).toMatch(/fontWeight:\s*500/)
  })
})

/** Parse a supported color into RGBA channels. */
function parse(color: string): [number, number, number, number] {
  const rgba = color.match(/rgba?\(([^)]+)\)/i)
  if (rgba && rgba[1]) {
    const [r, g, b, a] = rgba[1].split(',').map((p) => Number(p.trim()))
    return [r ?? 0, g ?? 0, b ?? 0, a ?? 1]
  }
  let h = color.replace('#', '')
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    1,
  ]
}

/** Composite a translucent foreground over an opaque background. */
function over(fg: string, bg: string): [number, number, number] {
  const [fr, fgr, fb, a] = parse(fg)
  const [br, bg2, bb] = parse(bg)
  return [fr * a + br * (1 - a), fgr * a + bg2 * (1 - a), fb * a + bb * (1 - a)]
}

/** Calculate WCAG relative luminance for an RGB triple. */
function lum([r, g, b]: [number, number, number]): number {
  const f = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** Calculate the WCAG contrast ratio between two RGB triples. */
function contrast(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const la = lum(a)
  const lb = lum(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

describe('highContrastTheme', () => {
  it('promotes de-emphasized text and strengthens borders for both themes', () => {
    for (const name of ['dark', 'light'] as const) {
      const base = THEMES[name]
      const hc = highContrastTheme(base)
      // Promote body and soft text to the strongest text color.
      expect(hc.text).toBe(base.textStrong)
      expect(hc.textSoft).toBe(base.textStrong)
      // Promote dim text tokens to full-strength body text.
      expect(hc.dim).toBe(base.text)
      expect(hc.dimText).toBe(base.text)
      // Strengthen every border tier to reveal structural boundaries.
      expect(hc.borderSoft).toBe(base.borderStrong)
      expect(hc.border).toBe(base.dim)
      expect(hc.borderStrong).toBe(base.text)
    }
  })

  it('preserves status + accent hues so state coding stays legible', () => {
    const base = THEMES.dark
    const hc = highContrastTheme(base)
    expect(hc.accent).toBe(base.accent)
    expect(hc.failed).toBe(base.failed)
    expect(hc.done).toBe(base.done)
    expect(hc.running).toBe(base.running)
  })
})

describe('DENSITY presets', () => {
  const ORDER = ['compact', 'cozy', 'comfortable'] as const

  for (const name of ORDER) {
    it(`keeps the ${name} preset above the WCAG 2.2 font and target floors`, () => {
      const density = DENSITY[name]
      // SC 1.4.4 keeps the dense table font readable at 12 px or larger.
      expect(density.font).toBeGreaterThanOrEqual(12)
      // SC 2.5.8 keeps every pointer target at 24 px or larger.
      expect(density.cell).toBeGreaterThanOrEqual(24)
      expect(density.rowMinH).toBeGreaterThanOrEqual(24)
      expect(density.inputH).toBeGreaterThanOrEqual(24)
      expect(density.row).toBeGreaterThanOrEqual(24)
    })
  }

  it('adds space at every step from compact through comfortable', () => {
    const metrics = [
      'row',
      'font',
      'cell',
      'cellGap',
      'pad',
      'gap',
      'sectionGap',
      'cardPad',
      'cardHeader',
      'headerPadY',
      'bodyPadY',
      'rowMinH',
      'inputH',
      'barH',
      'dockH',
      'dividerMargin',
      'lineTight',
    ] as const
    for (const metric of metrics) {
      expect(DENSITY.cozy[metric]).toBeGreaterThanOrEqual(
        DENSITY.compact[metric],
      )
      expect(DENSITY.comfortable[metric]).toBeGreaterThanOrEqual(
        DENSITY.cozy[metric],
      )
    }
    // Keep the presets distinguishable rather than merely non-decreasing.
    expect(DENSITY.comfortable.row).toBeGreaterThan(DENSITY.compact.row)
    expect(DENSITY.comfortable.pad).toBeGreaterThan(DENSITY.compact.pad)
  })

  it('offers exactly the three named presets', () => {
    expect(Object.keys(DENSITY).sort()).toEqual([...ORDER].sort())
  })
})

/** Every supported chip status, so no value escapes the contrast gates. */
const ALL_STATUSES = Object.keys(STATUS_LABEL) as ChipStatus[]

describe('Chip label contrast (WCAG 2.2 SC 1.4.3)', () => {
  // Verify neutral chip labels at 4.5:1 or better on every supported fill and
  // surface while the colored dot carries the status hue.
  const STATUSES = ALL_STATUSES
  for (const name of ['dark', 'light'] as const) {
    const t = THEMES[name]
    const surfaces = [t.bg, t.surface, t.surface2, t.surface3]
    for (const status of STATUSES) {
      it(`keeps the ${status} chip label at 4.5:1 or better in ${name}`, () => {
        const text = parse(t.text).slice(0, 3) as [number, number, number]
        for (const surface of surfaces) {
          const fill = over(statusSoft(t, status), surface)
          expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5)
        }
      })
    }
  }
})

describe('Status glyph contrast (WCAG 2.2 SC 1.4.11)', () => {
  const STATUSES = ALL_STATUSES
  for (const name of ['dark', 'light'] as const) {
    const t = THEMES[name]
    for (const status of STATUSES) {
      it(`keeps the ${status} status glyph at 3:1 or better on its ${name} tint`, () => {
        const glyph = parse(statusColor(t, status)).slice(0, 3) as [
          number,
          number,
          number,
        ]
        const fill = over(statusSoft(t, status), t.surface)
        expect(contrast(glyph, fill)).toBeGreaterThanOrEqual(3)
      })
    }
  }
})
