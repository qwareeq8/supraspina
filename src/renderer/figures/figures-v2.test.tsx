// @vitest-environment jsdom
/** Tests for the v2 figures: grid, pairwise matrix, forests, and scatter. */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { GroupAnalysisRowV2 } from '../../shared/group-analysis'
import {
  MOCK_BATTERY_RESULT,
  MOCK_OMNIBUS_RESULT,
  MOCK_STRATIFIED_RESULT,
  mockMeasureDetailV2,
  mockTermRows,
} from '../ipc/mock-analysis-v2'
import { THEMES, highContrastTheme } from '../theme/tokens'
import {
  buildExportFiguresV2,
  drawingCountV2,
  exportFigureCountV2,
  matrixStem,
  pageStem,
} from './figure-export-v2'
import { familyLabel } from './format'
import { ForestPlot } from './forest'
import {
  GATED_MARK,
  OUTSIDE_MARK,
  batteryForestModel,
  rowPText,
  strataForestModel,
  termForestModel,
  topTermRows,
} from './forest-model-v2'
import { GridFigure } from './grid'
import { gridHeight, gridTransposed, paginateGrid } from './grid-layout'
import {
  DARK_CELL_ALPHA,
  LIGHT_CELL_ALPHA,
  cellAlpha,
  cellFill,
  effectTone,
  gridModel,
  gridTermChoices,
} from './grid-model'
import { PairwiseMatrix } from './pairwise-matrix'
import { pairwiseMatrixModel } from './pairwise-matrix-model'
import { richText } from './rich'
import { AdjustedScatter } from './scatter'
import { scatterModelV2, variableAxisLabel } from './scatter-model-v2'
import { PRINT_PALETTE, mmToPt, screenPalette } from './style'

const rowsOf =
  (resultId: string) =>
  (termId: string): GroupAnalysisRowV2[] =>
    mockTermRows(resultId, termId, 0).rows

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

describe('grid cells', () => {
  it('tones d, r, and eta squared on their own scales', () => {
    expect(effectTone('d', -2)).toBe(-1)
    expect(effectTone('d', 0.5)).toBe(0.5)
    expect(effectTone('r', 0.25)).toBe(0.5)
    expect(effectTone('eta2', 0.0625)).toBeCloseTo(0.5)
    expect(effectTone('r', null)).toBe(0)
  })

  it('keeps cell text at 4.5:1 on every theme and on paper', () => {
    const papers = [
      [PRINT_PALETTE.paper, PRINT_PALETTE.ink],
      ...[
        THEMES.light,
        THEMES.dark,
        highContrastTheme(THEMES.light),
        highContrastTheme(THEMES.dark),
      ].map((t) => [t.surface, t.text] as const),
    ] as const
    for (const [paper, ink] of papers) {
      const alpha = cellAlpha(paper)
      for (const tone of [-1, -0.6, -0.2, 0, 0.3, 0.7, 1]) {
        expect(
          contrastRatio(ink, cellFill(tone, paper, alpha)),
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
    expect(cellAlpha(THEMES.dark.surface)).toBe(DARK_CELL_ALPHA)
    expect(cellAlpha(THEMES.light.surface)).toBe(LIGHT_CELL_ALPHA)
  })

  it('tints negative cells blue and positive cells red', () => {
    const [r, , b] = [1, 3, 5].map((i) =>
      Number.parseInt(cellFill(-1, '#ffffff', 0.5).slice(i, i + 2), 16),
    )
    expect(b!).toBeGreaterThan(r!)
    const [r2, , b2] = [1, 3, 5].map((i) =>
      Number.parseInt(cellFill(1, '#ffffff', 0.5).slice(i, i + 2), 16),
    )
    expect(r2!).toBeGreaterThan(b2!)
    expect(cellFill(0, '#15171c', 0.7)).toBe('#15171c')
  })
})

describe('the grid model', () => {
  const result = MOCK_BATTERY_RESULT
  const choices = gridTermChoices(result)

  it('offers tests, pairs, and strata as the result has them', () => {
    expect(choices.tests).toHaveLength(5)
    expect(choices.pairs).toEqual([])
    expect(gridTermChoices(MOCK_OMNIBUS_RESULT).pairs).toHaveLength(3)
    const strata = gridTermChoices(MOCK_STRATIFIED_RESULT).strata
    expect(strata.map((t) => t.stratum ?? t.role)).toEqual([
      'Female',
      'Male',
      'heterogeneity',
      'Female',
      'Male',
      'heterogeneity',
    ])
  })

  it('fills cells with the effect, CI, p, corrected p, and marks', () => {
    const model = gridModel(
      result,
      choices.tests,
      rowsOf(result.resultId),
      result.spec.measures,
    )
    expect(model.terms.map((line) => line.detail)).toEqual([
      'r',
      'r',
      'd',
      'd',
      'r',
    ])
    const tsi = model.cells[0]![0]!
    // The sensitivity test has no corrected p and marks its p.
    expect(tsi.pCorrected).toBeNull()
    expect(tsi.p.endsWith(OUTSIDE_MARK)).toBe(true)
    const medulla = model.cells[1]![0]!
    expect(medulla.significant).toBe(true)
    expect(medulla.value.startsWith('\u2212')).toBe(true)
    // The grid cell reads as the forest column does, with signed bounds.
    expect(medulla.ci).toMatch(/^\(\u2212\d\.\d\d to [+\u2212]?\d\.\d\d\)$/)
    expect(model.correctedLabel).toBe('FDR')
    expect(model.notes.some((note) => note.startsWith(OUTSIDE_MARK))).toBe(true)
    expect(model.summary).toMatch(/^Grid of 5 terms by 4 measures; \d+ of 20/)
    // The screen line states the count alone, matching the summary's.
    expect(model.significantText).toMatch(
      /^\d+ of 20 cells significant after correction\.$/,
    )
    expect(model.summary.endsWith(`; ${model.significantText}`)).toBe(true)
  })

  it('marks gated pairs and leaves an F cell without a CI', () => {
    const omnibus = MOCK_OMNIBUS_RESULT
    const model = gridModel(
      omnibus,
      [omnibus.terms[0]!, ...gridTermChoices(omnibus).pairs],
      rowsOf(omnibus.resultId),
      omnibus.spec.measures,
    )
    expect(model.terms[0]!.detail).toBe('\u03b7\u00b2')
    expect(model.cells[0]![0]!.ci).toBeNull()
    const gated = model.cells
      .slice(1)
      .flat()
      .filter((cell) => cell?.pCorrected?.endsWith(GATED_MARK))
    expect(gated.length).toBeGreaterThan(0)
    expect(model.notes.some((note) => note.startsWith(GATED_MARK))).toBe(true)
  })

  it('turns more than eight measures into rows and pages them', () => {
    const stratified = MOCK_STRATIFIED_RESULT
    const terms = gridTermChoices(stratified).tests
    const model = gridModel(
      stratified,
      terms,
      rowsOf(stratified.resultId),
      stratified.spec.measures,
    )
    expect(gridTransposed(model)).toBe(true)
    const pages = paginateGrid(model, mmToPt(174))
    expect(pages).toHaveLength(1)
    expect(pages[0]!.transposed).toBe(true)
    const many = {
      ...model,
      measures: Array.from({ length: 60 }, (_, i) => model.measures[i % 12]!),
      cells: model.cells.map((row) =>
        Array.from({ length: 60 }, (_, i) => row[i % 12]!),
      ),
    }
    const split = paginateGrid(many, mmToPt(174))
    expect(split.map((page) => page.model.measures.length)).toEqual([28, 28, 4])
    expect(split.every((page) => page.model.terms.length === 2)).toBe(true)
    expect(gridHeight(split[0]!.model, true)).toBeGreaterThan(
      gridHeight(split[2]!.model, true),
    )
  })

  it('draws an inert SVG table with bold survivors', () => {
    const model = gridModel(
      result,
      choices.tests,
      rowsOf(result.resultId),
      result.spec.measures,
    )
    const { container } = render(
      <GridFigure
        model={model}
        width={mmToPt(174)}
        mode="export"
        widthMm={174}
      />,
    )
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('174mm')
    expect(
      container.querySelectorAll('text[font-weight="700"]').length,
    ).toBeGreaterThan(5)
    expect(svg.querySelector('desc')?.textContent).toBe(model.summary)
  })
})

describe('the pairwise matrix', () => {
  const result = MOCK_OMNIBUS_RESULT
  const omnibus = result.terms[0]!

  it('puts d above the diagonal, corrected p below, and n on it', () => {
    const model = pairwiseMatrixModel(
      result,
      omnibus,
      rowsOf(result.resultId),
      'aseg:Brain-Stem',
    )!
    expect(model.groups.map((g) => [g.label, g.n])).toEqual([
      ['SCI_P', 22],
      ['SCI_nNP', 12],
      ['CTRL', 48],
    ])
    expect(model.cells[0]![0]!.kind).toBe('group')
    expect(richText(model.cells[0]![0]!.sub)).toBe('n = 22')
    // SCI_P (row) minus CTRL (column) is the SCI_P vs CTRL pair as stored.
    const pair = rowsOf(result.resultId)('term-2').find(
      (row) => row.measureId === 'aseg:Brain-Stem',
    )!
    const upper = model.cells[0]![2]!
    expect(upper.kind).toBe('d')
    expect(richText(upper.text).startsWith('\u2212')).toBe(pair.d! < 0)
    expect(upper.significant).toBe(pair.significant)
    expect(richText(model.cells[2]![0]!.text)).toMatch(/^FWE p /)
    // SCI_P (row) minus SCI_nNP (column) flips the stored SCI_nNP vs SCI_P.
    const flipped = rowsOf(result.resultId)('term-4').find(
      (row) => row.measureId === 'aseg:Brain-Stem',
    )!
    expect(model.cells[0]![1]!.tone).toBeCloseTo(effectTone('d', -flipped.d!))
  })

  it('says a pair was not tested, and is null without pairs', () => {
    const versus = {
      ...result,
      terms: result.terms.filter((term) => term.termId !== 'term-4'),
    }
    const model = pairwiseMatrixModel(
      versus,
      omnibus,
      rowsOf(result.resultId),
      'aseg:Brain-Stem',
    )!
    expect(model.cells[0]![1]!.kind).toBe('untested')
    expect(
      pairwiseMatrixModel(
        MOCK_BATTERY_RESULT,
        MOCK_BATTERY_RESULT.terms[0]!,
        rowsOf(MOCK_BATTERY_RESULT.resultId),
        'aseg:Brain-Stem',
      ),
    ).toBeNull()
  })

  it('draws on the theme surface on screen', () => {
    const model = pairwiseMatrixModel(
      result,
      omnibus,
      rowsOf(result.resultId),
      'aseg:Brain-Stem',
    )!
    const palette = screenPalette(THEMES.dark, 'dark')
    const { container } = render(
      <PairwiseMatrix
        model={model}
        width={300}
        mode="screen"
        palette={palette}
      />,
    )
    expect(container.querySelector('rect')?.getAttribute('fill')).toBe(
      THEMES.dark.surface,
    )
  })
})

describe('the v2 forests', () => {
  it('draws a term with its effect, corrected p, and marks', () => {
    const result = MOCK_BATTERY_RESULT
    const tsi = result.terms[0]!
    const rows = rowsOf(result.resultId)(tsi.termId)
    const model = termForestModel(result, tsi, rows)
    expect(richText(model.effectHeader)).toBe('r (95% CI)')
    const first = model.groups[0]!.rows[0]!
    expect(first.p.endsWith(OUTSIDE_MARK)).toBe(true)
    expect(model.subtitle.map(richText)).toContain(
      `${OUTSIDE_MARK} sensitivity, outside the family (uncorrected)`,
    )
    const ais = result.terms[2]!
    const aisModel = termForestModel(
      result,
      ais,
      rowsOf(result.resultId)(ais.termId),
    )
    expect(aisModel.direction).toBe('\u2190 smaller in AIS A')
    expect(
      rowPText(result, rowsOf(result.resultId)(ais.termId)[0]!),
    ).not.toMatch(OUTSIDE_MARK)
  })

  it('draws an F term without intervals and notes a shortened forest', () => {
    const result = MOCK_OMNIBUS_RESULT
    const f = result.terms[0]!
    const rows = rowsOf(result.resultId)(f.termId)
    const model = termForestModel(result, f, rows.slice(0, 2), rows.length)
    expect(
      model.groups.flatMap((g) => g.rows).every((r) => r.low === null),
    ).toBe(true)
    expect(richText(model.subtitle.at(-1)!)).toBe(
      '2 of the 3 measures: every significant one and the largest effects',
    )
    expect(topTermRows(rows, 1).length).toBeGreaterThanOrEqual(1)
  })

  it('draws every t test of a battery on the partial r scale', () => {
    const result = MOCK_BATTERY_RESULT
    const model = batteryForestModel(
      result,
      rowsOf(result.resultId),
      result.spec.measures,
    )!
    expect(model.groups).toHaveLength(4)
    expect(model.groups[0]!.rows.map((r) => r.label)).toEqual(
      result.terms.map((t) => t.label),
    )
    expect(
      new Set(model.groups.flatMap((g) => g.rows.map((r) => r.rowKey))).size,
    ).toBe(20)
    expect(
      batteryForestModel(
        MOCK_OMNIBUS_RESULT,
        rowsOf(MOCK_OMNIBUS_RESULT.resultId),
        MOCK_OMNIBUS_RESULT.spec.measures,
      ),
    ).toBeNull()
    const { container } = render(
      <ForestPlot model={model} width={480} mode="export" />,
    )
    expect(container.querySelectorAll('[data-measure-id]')).toHaveLength(0)
  })

  it('draws strata and the pooled term with the heterogeneity p', () => {
    const result = MOCK_STRATIFIED_RESULT
    const [pooled, female, male, hetero] = result.terms
    const model = strataForestModel(
      result,
      pooled!,
      [female!, male!],
      hetero!,
      rowsOf(result.resultId),
      result.spec.measures.slice(0, 2),
    )
    expect(model.groups[0]!.heading).toMatch(
      /^Brainstem, heterogeneity p (= \d|\u2264 )/,
    )
    expect(model.groups[0]!.rows.map((r) => r.label)).toEqual([
      'Female',
      'Male',
      'Pooled',
    ])
    expect(richText(model.subtitle[0]!)).toBe('SCI vs CTRL, per stratum')
  })
})

describe('the v2 measure figure', () => {
  it('draws an association with its fitted line and band', () => {
    const result = MOCK_BATTERY_RESULT
    const term = result.terms[1]!
    const detail = mockMeasureDetailV2(
      result.resultId,
      'vol:brainstem-ss:mid:Medulla',
      term.termId,
    )!
    const model = scatterModelV2(detail, result, term)
    expect(model.kind).toBe('association')
    expect(model.fits).toHaveLength(1)
    expect(model.xLabel).toBe('log(1 + Time since SCI (years))')
    expect(richText(model.stats[0]!)).toBe('Time since injury, log(1 + x)')
    expect(richText(model.stats[1]!)).toMatch(/^t\(\d+\) = .*, r = /)
    expect(model.legend.at(-1)!.shape).toBe('line')
    const screen = scatterModelV2(detail, result, term, { termLine: false })
    expect(screen.stats).toHaveLength(2)
    const { container } = render(
      <AdjustedScatter model={model} width={300} mode="export" />,
    )
    expect(container.querySelectorAll('polygon[fill-opacity]')).toHaveLength(1)
    expect(container.querySelectorAll('polyline')).toHaveLength(1)
  })

  it('draws one line per group with simple slopes for a slope difference', () => {
    const result = MOCK_STRATIFIED_RESULT
    const term = result.terms.find((t) => t.testId === 'age-slope')!
    const detail = mockMeasureDetailV2(
      result.resultId,
      'aseg:Brain-Stem',
      term.termId,
    )!
    const model = scatterModelV2(detail, result, term)
    expect(model.fits?.map((fit) => fit.group)).toEqual(['SCI', 'CTRL'])
    expect(new Set(model.fits?.map((fit) => fit.color)).size).toBe(2)
    expect(model.legend.filter((e) => e.shape === 'line')).toHaveLength(2)
    expect(model.xLabel).toBe('age')
  })

  it('draws an omnibus beeswarm with an F line', () => {
    const result = MOCK_OMNIBUS_RESULT
    const term = result.terms[0]!
    const detail = mockMeasureDetailV2(
      result.resultId,
      'aseg:Brain-Stem',
      term.termId,
    )!
    const model = scatterModelV2(detail, result, term, { termLine: false })
    expect(model.kind).toBe('groups')
    expect(model.groups.map((g) => g.label)).toEqual([
      'CTRL',
      'SCI_P',
      'SCI_nNP',
    ])
    expect(richText(model.stats[0]!)).toMatch(/^F\(2, 76\) = .*, partial /)
    expect(richText(model.stats[1]!)).toMatch(/^FWE p /)
  })

  it('names a derived variable by its label', () => {
    expect(
      variableAxisLabel(
        {
          ref: { source: 'derived', column: 'dv-motor' },
          transform: 'standardize',
        },
        MOCK_BATTERY_RESULT,
      ),
    ).toBe('ISNCSCI motor score (SD units)')
  })
})

describe('v2 export figures', () => {
  it('names pages, matrices, and counts drawings', () => {
    expect(pageStem('grid', 1, 1)).toBe('grid')
    expect(pageStem('grid', 2, 12)).toBe('grid-p02')
    expect(matrixStem('aseg:Brain-Stem')).toBe('pairs-aseg-brain-stem')
    const result = MOCK_OMNIBUS_RESULT
    const forest = termForestModel(
      result,
      result.terms[1]!,
      rowsOf(result.resultId)('term-2'),
    )
    const request = {
      forest: { model: forest, title: 'Forest' },
      grid: null,
      matrix: true,
      measure: false,
      widthMm: 174 as const,
    }
    expect(drawingCountV2(request)).toBe(2)
    expect(
      exportFigureCountV2(request, { svg: true, pdf: true, png: true }, true),
    ).toBe(5)
  })

  it('builds the forest, grid, matrix, and measure figure as SVG', async () => {
    const result = MOCK_OMNIBUS_RESULT
    const rows = rowsOf(result.resultId)
    const matrix = pairwiseMatrixModel(
      result,
      result.terms[0]!,
      rows,
      'aseg:Brain-Stem',
    )!
    const detail = mockMeasureDetailV2(
      result.resultId,
      'aseg:Brain-Stem',
      'term-2',
    )!
    const grid = gridModel(
      result,
      gridTermChoices(result).pairs,
      rows,
      result.spec.measures,
    )
    const figures = await buildExportFiguresV2({
      forest: {
        model: termForestModel(result, result.terms[1]!, rows('term-2')),
        title: 'Forest plot',
      },
      grid: { model: grid, transposed: false, title: 'Grid' },
      matrix: { model: matrix, measureId: 'aseg:Brain-Stem', title: 'Pairs' },
      measure: {
        model: scatterModelV2(detail, result, result.terms[1]!),
        measureId: 'aseg:Brain-Stem',
        stem: 'measure-aseg-brain-stem-term-2',
      },
      formats: { svg: true, pdf: false, png: false },
      widthMm: 114,
      dpi: 300,
    })
    expect(figures.map((f) => [f.kind, f.stem])).toEqual([
      ['svg', 'forest'],
      ['svg', 'grid'],
      ['svg', 'pairs-aseg-brain-stem'],
      ['svg', 'measure-aseg-brain-stem-term-2'],
    ])
    for (const figure of figures) {
      expect(figure.kind === 'svg' && figure.svg).toMatch(/width="114mm"/)
      // Exports draw on the print paper.
      expect(figure.kind === 'svg' && figure.svg).toMatch(/fill="#ffffff"/)
    }
  })
})

describe('v2 family labels', () => {
  it('names atlas families by metric and atlas', () => {
    expect(familyLabel('parc:a2009s:ThickAvg')).toMatch(/^Thickness, /)
    expect(familyLabel('parc:schaefer400-7:GWC')).toBe(
      'Gray-white contrast, schaefer400-7',
    )
    expect(familyLabel('vol:brainstem-ss')).toMatch(/^Volume, /)
    expect(familyLabel('aseg')).toBe('Subcortical and brainstem volume')
  })
})
