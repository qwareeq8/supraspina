// @vitest-environment jsdom

import { createElement } from 'react'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MOCK_ANALYSIS_RESULT,
  mockAnalysisCatalog,
  mockMeasureDetail,
} from '../ipc/mock-group-analysis'
import {
  MAX_EXPORT_FIGURES,
  MAX_EXPORT_REQUEST_BYTES,
  assertExportFits,
  exportFigureBytes,
  buildExportFigures,
  exportFigureCount,
  forestPageStem,
  forestPages,
  measureFigureStem,
} from './figure-export'
import {
  LE,
  MINUS,
  fileSlug,
  formatFixed,
  formatGrouped,
  formatP,
  formatPRelation,
  formatTick,
  measureShortLabel,
  measureTitleName,
  niceTicks,
  permutationFloor,
} from './format'
import { ForestPlot } from './forest'
import {
  FOREST_ROWS_PER_PAGE,
  forestHeight,
  forestModel,
  topForestRows,
} from './forest-model'
import {
  crc32,
  pngPixelSize,
  rasterizeSvg,
  readPngInfo,
  withPngDpi,
} from './png-export'
import { AdjustedScatter } from './scatter'
import { scatterHeight, scatterModel } from './scatter-model'
import { FIGURE_COLORS, PRINT_PALETTE, mmToPt, screenPalette } from './style'
import { THEMES, highContrastTheme } from '../theme/tokens'
import { beeswarm, swarmUnit } from './swarm'
import {
  MAX_PDF_SVG_BYTES,
  externalReferences,
  facesUsed,
  figureSvg,
} from './svg-export'

/** A 1x1 PNG without a pHYs chunk. */
const TINY_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('number formatting', () => {
  it('prints negative numbers with the typographic minus sign', () => {
    expect(formatFixed(-0.4819, 2)).toBe(`${MINUS}0.48`)
    expect(formatFixed(0.0049, 2, true)).toBe('0.00')
    expect(formatFixed(-0.004, 2)).toBe('0.00')
    expect(formatFixed(0.13, 2, true)).toBe('+0.13')
    expect(formatGrouped(-21400)).toBe(`${MINUS}21,400`)
    expect(formatTick(-2, 1)).toBe(`${MINUS}2`)
    expect(formatTick(24000, 3000)).toBe('24,000')
    expect(formatTick(2.25, 0.25)).toBe('2.25')
    expect(formatTick(-0.5, 0.5)).toBe(`${MINUS}0.5`)
  })

  it('floors a permutation p at 1/(B+1)', () => {
    const floor = permutationFloor(5000)!
    expect(floor).toBeCloseTo(1 / 5001, 12)
    expect(formatP(1 / 5001, floor)).toBe(`${LE} 0.0002`)
    expect(formatP(0.00001, permutationFloor(10000))).toBe(`${LE} 0.0001`)
    expect(formatP(0.0009, permutationFloor(1000))).toBe(`${LE} 0.001`)
    expect(formatPRelation(1 / 5001, floor)).toBe(`${LE} 0.0002`)
    expect(formatP(0.0199960008, floor)).toBe('0.020')
    expect(permutationFloor(0)).toBeNull()
  })

  it('rounds p values to the printed precision', () => {
    expect(formatP(0.0227413)).toBe('0.023')
    expect(formatP(0.0582)).toBe('0.058')
    expect(formatP(0.123)).toBe('0.12')
    expect(formatP(0.9971)).toBe('1.00')
    expect(formatP(0.0004)).toBe('< 0.001')
    expect(formatPRelation(0.022)).toBe('= 0.022')
    expect(formatPRelation(0.0004)).toBe('< 0.001')
  })

  it('names measures for figures and files', () => {
    expect(measureShortLabel('dk:lh:precentral:ThickAvg')).toBe(
      'Precentral, left',
    )
    expect(measureShortLabel('aseg:bi:Thalamus')).toBe('Thalamus')
    expect(measureTitleName('aseg:Brain-Stem')).toBe('Brainstem')
    expect(measureTitleName('dk:bi:precentral:ThickAvg')).toBe(
      'Precentral thickness',
    )
    expect(fileSlug('SCI vs controls!')).toBe('sci-vs-controls')
    expect(measureFigureStem('aseg:Brain-Stem')).toBe('measure-aseg-brain-stem')
  })
})

describe('ticks', () => {
  it('cover the range with round steps and halfway minor ticks', () => {
    const ticks = niceTicks(-1.18, 0.26, 5)
    expect(ticks.step).toBe(0.5)
    expect(ticks.ticks).toEqual([-1.5, -1, -0.5, 0, 0.5])
    expect(ticks.minor).toEqual([-1.25, -0.75, -0.25, 0.25])
    const volumes = niceTicks(17_400, 25_900, 4)
    expect(volumes.step).toBe(2500)
    expect(volumes.ticks[0]).toBeLessThanOrEqual(17_400)
    expect(volumes.ticks.at(-1)).toBeGreaterThanOrEqual(25_900)
  })

  it('survive a flat or invalid range', () => {
    expect(niceTicks(3, 3).ticks.length).toBeGreaterThan(1)
    expect(niceTicks(NaN, 1).ticks).toEqual([0, 1])
  })
})

describe('beeswarm', () => {
  it('never lets two markers overlap and keeps each at its value', () => {
    const values = Array.from({ length: 120 }, (_, i) =>
      Math.round(100 + 30 * Math.sin(i * 1.7) + (i % 7)),
    )
    const diameter = 5
    const points = beeswarm(values, diameter)
    expect(points).toHaveLength(values.length)
    points.forEach((point, i) => expect(point.y).toBe(values[i]))
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const a = points[i]!
        const b = points[j]!
        expect(Math.hypot(a.dx - b.dx, a.y - b.y)).toBeGreaterThanOrEqual(
          diameter - 1e-6,
        )
      }
    }
  })

  it('keeps a lone marker on the center line and balances ties', () => {
    expect(beeswarm([10], 4)[0]!.dx).toBe(0)
    const tied = beeswarm([10, 10, 10], 4).map((p) => p.dx)
    expect(tied.sort((a, b) => a - b)).toEqual([-4, 0, 4])
  })
})

describe('forest plot', () => {
  const model = forestModel(MOCK_ANALYSIS_RESULT)

  it('groups rows by family and prints the effect and corrected p', () => {
    expect(model.groups.map((g) => g.heading)).toEqual([
      'Thickness',
      'Gray-matter volume',
      'Area',
      'Subcortical and brainstem volume',
      'Whole brain',
    ])
    const brainstem = model.groups
      .flatMap((g) => g.rows)
      .find((r) => r.measureId === 'aseg:Brain-Stem')!
    expect(brainstem.effect).toMatch(new RegExp(`^${MINUS}0\\.48 \\(${MINUS}`))
    expect(brainstem.significant).toBe(false)
    expect(model.direction).toBe('\u2190 smaller in SCI')
    expect(forestHeight(model)).toBeGreaterThan(200)
  })

  it('draws an accessible figure with filled squares for significant rows', () => {
    const { container, getByRole } = render(
      <ForestPlot
        model={model}
        width={400}
        mode="screen"
        title="Forest plot: test"
      />,
    )
    const svg = getByRole('img', { name: 'Forest plot: test' })
    expect(svg.querySelector('desc')?.textContent).toMatch(
      /1 significant after FWE correction/,
    )
    const filled = [...container.querySelectorAll('rect')].filter(
      (rect) => rect.getAttribute('fill') === '#111111',
    )
    expect(filled).toHaveLength(1)
    expect(container.textContent).toContain(MINUS)
    expect(container.textContent).not.toMatch(/(^|[\s(])-\d/)
  })

  it('selects a row on click on screen', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <ForestPlot
        model={model}
        width={400}
        mode="screen"
        onSelect={onSelect}
      />,
    )
    const row = container.querySelector(
      '[data-measure-id="aseg:Brain-Stem"] text',
    )!
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onSelect).toHaveBeenCalledWith('aseg:Brain-Stem')
  })

  it('drops the effect column at a narrow export width', () => {
    const { container } = render(
      <ForestPlot
        model={model}
        width={mmToPt(85)}
        mode="export"
        widthMm={85}
      />,
    )
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('85mm')
    expect(container.textContent).not.toContain('(95% CI)')
    expect(container.querySelector('[data-measure-id]')).toBeNull()
  })
})

describe('large forest export', () => {
  const template = MOCK_ANALYSIS_RESULT.rows[0]!
  const rows = mockAnalysisCatalog()
    .measures.slice(0, 646)
    .map((m, index) => ({
      ...template,
      measureId: m.measureId,
      family: m.family,
      d: ((index % 23) - 11) / 10,
      significant: index % 97 === 0,
    }))
  const large = { ...MOCK_ANALYSIS_RESULT, rows }

  it('splits a forest into numbered pages of 60 rows', () => {
    const pages = forestPages(large)
    expect(pages).toHaveLength(Math.ceil(646 / FOREST_ROWS_PER_PAGE))
    const counts = pages.map((p) =>
      p.groups.reduce((sum, g) => sum + g.rows.length, 0),
    )
    expect(counts.slice(0, -1).every((n) => n === FOREST_ROWS_PER_PAGE)).toBe(
      true,
    )
    expect(counts.reduce((a, b) => a + b, 0)).toBe(646)
    expect(pages[0]!.subtitle.at(-1)).toEqual(['Page 1 of 11'])
    expect(pages[1]!.subtitle[0]).toEqual(['Figure continued, page 2 of 11'])
    expect(pages[1]!.groups[0]!.heading).toMatch(/ \(continued\)$/)
    expect(pages.every((p) => p.scaleRows?.length === 646)).toBe(true)
    expect(forestPageStem(1, 11)).toBe('forest-p01')
    expect(forestPageStem(11, 11)).toBe('forest-p11')
    expect(forestPageStem(1, 1)).toBe('forest')
  })

  it('keeps each page inside the 1000 mm figure limit at every width', async () => {
    for (const widthMm of [85, 174] as const) {
      const figures = await buildExportFigures(large, {
        forest: true,
        measure: null,
        formats: { svg: true, pdf: true, png: false },
        widthMm,
        dpi: 300,
      })
      expect(figures.map((f) => f.stem)).toEqual(
        Array.from({ length: 11 }, (_, i) => forestPageStem(i + 1, 11)),
      )
      expect(figures.length).toBeLessThanOrEqual(MAX_EXPORT_FIGURES)
      for (const figure of figures) {
        const svg = figure.kind === 'svg' ? figure.svg : ''
        const height = Number(/height="([\d.]+)mm"/.exec(svg)?.[1])
        expect(height).toBeGreaterThan(1)
        expect(height).toBeLessThanOrEqual(1000)
        expect(new TextEncoder().encode(svg).length).toBeLessThan(
          MAX_PDF_SVG_BYTES,
        )
      }
    }
  })

  it('keeps every significant measure and the largest effects in a top forest', () => {
    const top = topForestRows(large)
    const significant = rows.filter((r) => r.significant)
    expect(significant.every((r) => top.includes(r))).toBe(true)
    expect(top.length).toBeLessThanOrEqual(
      FOREST_ROWS_PER_PAGE + significant.length,
    )
    const smallest = Math.min(
      ...top.filter((r) => !r.significant).map((r) => Math.abs(r.d!)),
    )
    const left = rows.filter((r) => !top.includes(r))
    expect(left.every((r) => Math.abs(r.d!) <= smallest)).toBe(true)
    const model = forestModel(large, top)
    expect(model.subtitle.at(-1)).toEqual([
      `${top.length} of the 646 measures: every significant one and the largest effects`,
    ])
    expect(forestPages(large, 'top').length).toBeLessThanOrEqual(2)
  })

  it('counts the figures an export sends', () => {
    const formats = { svg: true, pdf: true, png: true }
    expect(exportFigureCount(12, formats)).toBe(24)
    expect(exportFigureCount(12, { ...formats, png: false }, true)).toBe(13)
  })
})

describe('adjusted scatter', () => {
  const detail = mockMeasureDetail('aseg:Brain-Stem')!
  const model = scatterModel(detail, MOCK_ANALYSIS_RESULT)

  it('titles the figure with the adjusted difference and effect', () => {
    expect(model.title).toEqual([
      expect.stringMatching(/^Brainstem \d+\.\d% smaller$/),
    ])
    expect(model.stats[0]).toEqual([
      { i: 'd' },
      expect.stringMatching(new RegExp(`^ = ${MINUS}0\\.48 \\(${MINUS}`)),
    ])
    expect(model.stats[1]).toEqual([
      'FWE ',
      { i: 'p' },
      expect.stringMatching(/\(20 measures\)$/),
    ])
    expect(model.groups.map((g) => [g.label, g.color])).toEqual([
      ['CTRL', '#0072B2'],
      ['SCI', '#D55E00'],
    ])
    // The larger SCI label takes the filled triangle; the smaller the open square.
    expect(model.legend.map((e) => [e.label, e.shape])).toEqual([
      ['CTRL', 'circle'],
      ['SCI_P', 'triangle'],
      ['SCI_nNP', 'square-open'],
      ['adjusted mean and 95% CI', 'cross'],
    ])
  })

  it('stands each mean bar beside its own swarm and centers the label under both', () => {
    expect(swarmUnit(100, 20, 6, 4, true)).toEqual({ swarm: 92, cross: 122 })
    expect(swarmUnit(100, 20, 6, 4, false)).toEqual({ swarm: 100, cross: null })
    const { container } = render(
      <AdjustedScatter model={model} width={300} mode="export" />,
    )
    const fs = 7
    for (const group of model.groups) {
      // Markers in the plot, not the legend along the bottom.
      const plotBottom = scatterHeight(300) - fs * 4
      const xs = [
        ...container.querySelectorAll(
          `[fill="${group.color}"], [stroke="${group.color}"]`,
        ),
      ].flatMap((el) => {
        const pairs =
          el.tagName === 'circle'
            ? [[el.getAttribute('cx'), el.getAttribute('cy')]]
            : el.tagName === 'rect'
              ? [[el.getAttribute('x'), el.getAttribute('y')]]
              : (el.getAttribute('points') ?? '')
                  .trim()
                  .split(/\s+/)
                  .map((p) => p.split(','))
        return pairs
          .map(([x, y]) => [Number(x), Number(y)] as const)
          .filter(([x, y]) => Number.isFinite(x) && y < plotBottom)
          .map(([x]) => x)
      })
      const right = Math.max(...xs)
      const left = Math.min(...xs)
      const label = [...container.querySelectorAll('text')].find(
        (el) => el.textContent === group.label,
      )!
      const crosses = [...container.querySelectorAll('g[stroke="#111111"]')]
      const cross = crosses
        .map((g) => Number(g.querySelector('line')!.getAttribute('x1')))
        .find((x) => x > right && x - right < fs * 3)
      expect(cross).toBeDefined()
      const labelX = Number(label.getAttribute('x'))
      expect(Math.abs(labelX - (left + cross! + fs * 0.9) / 2)).toBeLessThan(
        fs * 0.8,
      )
    }
  })

  it('reports the hovered subject on screen and never names one in an export', () => {
    const onHover = vi.fn()
    const onPick = vi.fn()
    const { container, getByRole } = render(
      <AdjustedScatter
        model={model}
        width={360}
        mode="screen"
        onHover={onHover}
        onPick={onPick}
      />,
    )
    expect(
      getByRole('img', { name: 'Adjusted values per subject' }),
    ).toBeInTheDocument()
    const marker = container.querySelector(
      'svg g circle, svg g polygon, svg g rect[width]',
    )!
    marker.parentElement!.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true }),
    )
    expect(onHover).toHaveBeenCalledWith(expect.stringMatching(/^sub-\d{3}$/))
    marker.parentElement!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    expect(onPick).toHaveBeenCalled()
    const exported = render(
      <AdjustedScatter model={model} width={360} mode="export" widthMm={85} />,
    )
    expect(exported.container.innerHTML).not.toMatch(/sub-\d{3}/)
  })
})

/** The WCAG contrast ratio of two `#rrggbb` colors. */
function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('figure palettes', () => {
  const themes = [
    ['light', THEMES.light],
    ['dark', THEMES.dark],
    ['light', highContrastTheme(THEMES.light)],
    ['dark', highContrastTheme(THEMES.dark)],
  ] as const
  const series = [
    FIGURE_COLORS.reference,
    FIGURE_COLORS.focal,
    ...FIGURE_COLORS.others,
  ]

  it('keeps text at 4.5:1 and marks at 3:1 on every theme surface', () => {
    for (const [name, t] of themes) {
      const palette = screenPalette(t, name)
      expect(palette.paper).toBe(t.surface)
      for (const text of [palette.ink, palette.muted, palette.provisional]) {
        expect(contrastRatio(text, palette.paper)).toBeGreaterThanOrEqual(4.5)
      }
      for (const mark of [palette.rule, ...series.map(palette.series)]) {
        expect(contrastRatio(mark, palette.paper)).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('keeps each series color distinct and the print colors in print', () => {
    for (const [name, t] of themes) {
      const drawn = series.map(screenPalette(t, name).series)
      expect(new Set(drawn).size).toBe(series.length)
    }
    expect(series.map(PRINT_PALETTE.series)).toEqual(series)
    expect(PRINT_PALETTE.paper).toBe('#ffffff')
    expect(PRINT_PALETTE.ink).toBe('#111111')
  })

  it('draws an on-screen forest in the theme and an export in print', () => {
    const t = THEMES.dark
    const model = forestModel(MOCK_ANALYSIS_RESULT)
    const screen = render(
      <ForestPlot
        model={{ ...model, provisional: true }}
        width={400}
        mode="screen"
        palette={screenPalette(t, 'dark')}
        selectedId="aseg:Brain-Stem"
      />,
    )
    const html = screen.container.innerHTML
    expect(html).not.toMatch(/#111111|#ffffff|#555555|#777777/i)
    expect(screen.container.querySelector('rect')?.getAttribute('fill')).toBe(
      t.surface,
    )
    expect(html).toContain(`fill="${t.accentSoft}"`)
    expect(html).toContain(`fill="${t.warning}"`)
    const exported = render(
      <ForestPlot model={model} width={400} mode="export" />,
    )
    expect(exported.container.querySelector('rect')?.getAttribute('fill')).toBe(
      '#ffffff',
    )
    expect(exported.container.innerHTML).not.toContain(t.surface)
  })

  it('draws an on-screen measure figure in the theme series colors', () => {
    const t = THEMES.light
    const palette = screenPalette(t, 'light')
    const model = scatterModel(
      mockMeasureDetail('aseg:Brain-Stem')!,
      MOCK_ANALYSIS_RESULT,
    )
    const others = {
      ...model,
      groups: model.groups.map((g) => ({
        ...g,
        points: g.points.map((p) => ({ ...p, color: FIGURE_COLORS.others[2] })),
      })),
    }
    const { container } = render(
      <AdjustedScatter
        model={others}
        width={360}
        mode="screen"
        palette={palette}
      />,
    )
    const html = container.innerHTML
    expect(html).not.toContain(FIGURE_COLORS.others[2])
    expect(html).toContain(palette.series(FIGURE_COLORS.others[2]))
    expect(html).toContain(`fill="${t.text}"`)
    expect(html).not.toMatch(/#111111/)
  })
})

describe('export request size', () => {
  it('measures figures as main does and refuses an oversized export', () => {
    const png = new Uint8Array(new ArrayBuffer(1000), 0, 10)
    expect(
      exportFigureBytes([
        { kind: 'svg', stem: 'forest', svg: 'a\u2212', pdf: true },
        { kind: 'png', stem: 'brain', png },
      ]),
    ).toBe(4 + 1000)
    expect(() =>
      assertExportFits([
        { kind: 'png', stem: 'brain', png: new Uint8Array(1024) },
      ]),
    ).not.toThrow()
    const big = new Uint8Array(MAX_EXPORT_REQUEST_BYTES - 1024)
    expect(() =>
      assertExportFits([{ kind: 'png', stem: 'brain', png: big }]),
    ).toThrow(/one export can write\. Export fewer figures or formats/)
  })
})

describe('SVG export', () => {
  it('writes a self-contained file with the serif embedded', async () => {
    const svg = await figureSvg(
      createElement(ForestPlot, {
        model: forestModel(MOCK_ANALYSIS_RESULT),
        width: mmToPt(114),
        mode: 'export',
        widthMm: 114,
      }),
    )
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg')).toBe(
      true,
    )
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('width="114mm"')
    expect(svg).toMatch(
      /@font-face\{font-family:'SupraspinaFigureSerif';src:url\(data:font\/woff2;base64,/,
    )
    expect(svg.match(/@font-face/g)).toHaveLength(3)
    expect(externalReferences(svg)).toEqual([])
    expect(svg).toContain(MINUS)
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(parsed.querySelector('parsererror')).toBeNull()
    expect(parsed.documentElement.getAttribute('role')).toBe('img')
  })

  it('embeds only the faces the drawing sets text in', async () => {
    const scatter = await figureSvg(
      createElement(AdjustedScatter, {
        model: scatterModel(
          mockMeasureDetail('aseg:Brain-Stem')!,
          MOCK_ANALYSIS_RESULT,
        ),
        width: mmToPt(85),
        mode: 'export',
        widthMm: 85,
      }),
    )
    expect(scatter.match(/@font-face/g)).toHaveLength(2)
    expect(scatter).not.toContain('font-weight:700')
    expect(facesUsed('<svg><text>a</text></svg>')).toEqual(['regular'])
    expect(scatter).not.toMatch(/<!(?:DOCTYPE|ENTITY)/i)
  })

  it('keeps a forest of every catalog measure small enough for PDF', async () => {
    const template = MOCK_ANALYSIS_RESULT.rows[0]!
    const rows = mockAnalysisCatalog()
      .measures.slice(0, 646)
      .map((m, index) => ({
        ...template,
        measureId: m.measureId,
        family: m.family,
        significant: index % 17 === 0,
      }))
    const svg = await figureSvg(
      createElement(ForestPlot, {
        model: forestModel({ ...MOCK_ANALYSIS_RESULT, rows }),
        width: mmToPt(174),
        mode: 'export',
        widthMm: 174,
      }),
    )
    expect(new TextEncoder().encode(svg).length).toBeLessThan(MAX_PDF_SVG_BYTES)
  })

  it('names any reference outside the file', () => {
    expect(
      externalReferences(
        '<svg><image href="https://example.org/a.png"/><style>@import "x.css"; a{fill:url(#g)}</style><use href="#a"/></svg>',
      ),
    ).toEqual(['https://example.org/a.png', '@import "x.css"'])
  })
})

describe('PNG export', () => {
  it('sizes a figure by its physical width and resolution', () => {
    expect(pngPixelSize(85, 60, 300)).toEqual({ width: 1004, height: 709 })
    expect(pngPixelSize(174, 100, 600)).toEqual({ width: 4110, height: 2362 })
  })

  it('records the resolution in a valid pHYs chunk', () => {
    const png = withPngDpi(TINY_PNG, 600)
    expect(readPngInfo(png)).toEqual({ width: 1, height: 1, dpi: 600 })
    const at = 8 + 25
    expect(String.fromCharCode(...png.subarray(at + 4, at + 8))).toBe('pHYs')
    const view = new DataView(png.buffer)
    expect(view.getUint32(at + 17)).toBe(crc32(png.subarray(at + 4, at + 17)))
    // Setting it again replaces the chunk rather than adding one.
    expect(withPngDpi(png, 300).length).toBe(png.length)
    expect(readPngInfo(withPngDpi(png, 300)).dpi).toBe(300)
    expect(() => withPngDpi(new Uint8Array([1, 2, 3]), 300)).toThrow(TypeError)
  })

  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('rasterizes an SVG at the requested pixel size', async () => {
    const drawn: number[][] = []
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        decoding = 'auto'
        set src(value: string) {
          expect(value.startsWith('data:image/svg+xml;base64,')).toBe(true)
          queueMicrotask(() => this.onload?.())
        }
      },
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement) {
        return {
          fillRect: () => undefined,
          drawImage: (
            _image: unknown,
            x: number,
            y: number,
            w: number,
            h: number,
          ) => drawn.push([x, y, w, h]),
          set fillStyle(_value: string) {},
        } as unknown as CanvasRenderingContext2D
      } as never,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback) => callback(new Blob([TINY_PNG], { type: 'image/png' })),
    )
    const png = await rasterizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      { width: 1004, height: 709 },
      300,
    )
    expect(drawn).toEqual([[0, 0, 1004, 709]])
    expect(readPngInfo(png).dpi).toBe(300)
  })

  it('builds PNG figures at the export resolution', async () => {
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null
        set src(_value: string) {
          queueMicrotask(() => this.onload?.())
        }
      },
    )
    const sizes: number[][] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement) {
        sizes.push([this.width, this.height])
        return {
          fillRect: () => undefined,
          drawImage: () => undefined,
        } as unknown as CanvasRenderingContext2D
      } as never,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback) => callback(new Blob([TINY_PNG], { type: 'image/png' })),
    )
    const figures = await buildExportFigures(MOCK_ANALYSIS_RESULT, {
      forest: true,
      measure: mockMeasureDetail('aseg:Brain-Stem'),
      formats: { svg: false, pdf: false, png: true },
      widthMm: 85,
      dpi: 600,
    })
    expect(figures.map((f) => [f.kind, f.stem])).toEqual([
      ['png', 'forest'],
      ['png', 'measure-aseg-brain-stem'],
    ])
    expect(sizes.map(([w]) => w)).toEqual([2008, 2008])
    for (const figure of figures) {
      expect(figure.kind === 'png' && readPngInfo(figure.png).dpi).toBe(600)
    }
  })
})
