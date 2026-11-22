/**
 * The grid of a v2 result, laid out as a results table: one line per test (or
 * pair, or stratum) and one per measure, each cell the term's effect with its
 * 95% CI, the uncorrected p, and the corrected p. Cells are tinted on the
 * ColorBrewer RdBu hues (blue negative, red positive, deeper for larger
 * effects); a cell that survives the correction is bold, and the marks of the
 * forest (\u2020 outside the family, \u2021 gated) repeat, so nothing relies on
 * color alone.
 *
 * The Grid tab draws this model as an HTML table on the theme surface; an
 * export draws it as an SVG table on the print paper.
 */

import type {
  GroupAnalysisResultV2,
  GroupAnalysisRowV2,
  GroupAnalysisTerm,
} from '../../shared/group-analysis'
import { DIVERGING_STOPS } from '../screens/analysis/brain/brain-map'
import {
  correctionText,
  isStratified,
  rowEffect,
  termEffect,
  termShortLabel,
  termTitle,
  type TermEffect,
} from '../screens/analysis/v2/terms'
import {
  CORRECTION_SHORT,
  correctedFloor,
  formatFixed,
  formatInterval,
  formatP,
  measureTitleName,
} from './format'
import { GATED_MARK, OUTSIDE_MARK } from './forest-model-v2'
import type { Rich } from './rich'

/** Which terms form the grid's lines. */
export type GridTerms = 'tests' | 'pairs' | 'strata'

/** The effect each term kind shows, by its printed symbol. */
export const EFFECT_SYMBOL: Readonly<Record<TermEffect, string>> = {
  d: 'd',
  r: 'r',
  eta2: '\u03b7\u00b2',
}

/**
 * The effect that tints a cell fully: |d| 1, |r| 0.5, and partial eta
 * squared 0.25 (|r| 0.5 squared).
 */
export const EFFECT_FULL: Readonly<Record<TermEffect, number>> = {
  d: 1,
  r: 0.5,
  eta2: 0.25,
}

/**
 * Give a cell's tint position: -1 (full blue) to 1 (full red); partial eta
 * squared has no sign and tints red on the r scale.
 *
 * @returns The position, clamped.
 */
export function effectTone(effect: TermEffect, value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0
  const unit =
    effect === 'eta2'
      ? Math.sqrt(Math.max(0, value)) / Math.sqrt(EFFECT_FULL.eta2)
      : value / EFFECT_FULL[effect]
  return Math.max(-1, Math.min(1, unit))
}

function hexRgb(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (!match) return null
  const value = Number.parseInt(match[1]!, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function hex(rgb: readonly number[]): string {
  return `#${rgb
    .map((channel) =>
      Math.round(Math.max(0, Math.min(255, channel)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/** The deepest tint a cell takes on the light paper or theme. */
export const LIGHT_CELL_ALPHA = 0.5
/** The deepest tint a cell takes on the dark theme's surface. */
export const DARK_CELL_ALPHA = 0.7

/**
 * Give the deepest tint for a paper: the dark ceiling on a dark surface
 * (relative luminance below 0.2), the light one otherwise.
 *
 * @param paper - The paper or surface color (`#rrggbb`).
 */
export function cellAlpha(paper: string): number {
  const rgb = hexRgb(paper)
  if (!rgb) return LIGHT_CELL_ALPHA
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  return luminance < 0.2 ? DARK_CELL_ALPHA : LIGHT_CELL_ALPHA
}

/**
 * Give a cell's fill: the paper mixed toward the RdBu end of the effect's
 * sign, by its size. The light ceiling keeps dark ink at 4.5:1 or more,
 * and the dark ceiling keeps light ink there too.
 *
 * @param tone - The tint position, -1 to 1.
 * @param paper - The paper or surface color (`#rrggbb`).
 * @returns The fill as `#rrggbb`.
 */
export function cellFill(
  tone: number,
  paper: string,
  maxAlpha: number,
): string {
  const base = hexRgb(paper) ?? [255, 255, 255]
  const end = tone < 0 ? DIVERGING_STOPS[0]! : DIVERGING_STOPS.at(-1)!
  const alpha = Math.min(1, Math.abs(tone)) * maxAlpha
  return hex(
    base.map((channel, index) => channel + (end[index]! - channel) * alpha),
  )
}

/** One cell of the grid. */
export interface GridCell {
  measureId: string
  termId: string
  effect: TermEffect
  /** The effect, with a plus sign when positive. */
  value: string
  /** The 95% CI, or null (partial eta squared has none). */
  ci: string | null
  /** The uncorrected p, with the sensitivity mark outside the family. */
  p: string
  /** The corrected p with the gate mark, or null outside the family. */
  pCorrected: string | null
  significant: boolean
  tone: number
}

/** One line of the grid's term or measure axis. */
export interface GridLine {
  id: string
  label: string
  /** A short second line: the effect symbol, or the hemisphere. */
  detail: string
}

/** Everything the grid draws. */
export interface GridModel {
  terms: GridLine[]
  measures: GridLine[]
  /** The cells, by term then measure; null where a term has no row. */
  cells: (GridCell | null)[][]
  /** The corrected p's label, such as "FDR"; empty without a correction. */
  correctedLabel: string
  subtitle: Rich[]
  notes: string[]
  provisional: boolean
  summary: string
  /** The significant-cell count alone, for the line above the screen grid. */
  significantText: string
}

/**
 * List the terms each grid choice shows.
 *
 * @returns The term lists; empty lists are not offered.
 */
export function gridTermChoices(
  result: GroupAnalysisResultV2,
): Record<GridTerms, GroupAnalysisTerm[]> {
  return {
    tests: result.terms.filter(
      (term) => term.role === 'effect' && term.stratum === null,
    ),
    pairs: result.terms.filter(
      (term) => term.role === 'pairwise' && term.stratum === null,
    ),
    strata: isStratified(result)
      ? result.terms.filter(
          (term) => term.stratum !== null || term.role === 'heterogeneity',
        )
      : [],
  }
}

/**
 * Build the grid model.
 *
 * @param terms - The terms, in line order.
 * @param measureIds - The measures, in order.
 */
export function gridModel(
  result: GroupAnalysisResultV2,
  terms: readonly GroupAnalysisTerm[],
  rowsOf: (termId: string) => readonly GroupAnalysisRowV2[],
  measureIds: readonly string[],
): GridModel {
  const { correction, permutations } = result.spec.inference
  const floor = correctedFloor(correction, permutations)
  const label = (term: GroupAnalysisTerm): string =>
    terms.every((item) => item.testId === term.testId)
      ? termShortLabel(result, term)
      : termTitle(result, term)
  const all: GroupAnalysisRowV2[] = []
  const cells = terms.map((term) => {
    const effect = termEffect(result, term)
    const digits = effect === 'eta2' ? 3 : 2
    const byMeasure = new Map(
      rowsOf(term.termId).map((row) => [row.measureId, row]),
    )
    return measureIds.map((measureId): GridCell | null => {
      const row = byMeasure.get(measureId)
      if (!row) return null
      all.push(row)
      const value = rowEffect(row, effect)
      const signed = effect !== 'eta2'
      const interval = formatInterval(value.low, value.high, digits, signed)
      return {
        measureId,
        termId: term.termId,
        effect,
        value:
          value.value === null
            ? '\u2212'
            : formatFixed(value.value, digits, signed),
        // The cell reads "value (low to high)", as the forest's column does.
        ci: interval === null ? null : `(${interval})`,
        p: `${formatP(row.p)}${row.inFamily ? '' : OUTSIDE_MARK}`,
        pCorrected:
          row.pCorrected === null
            ? null
            : `${formatP(row.pCorrected, floor)}${row.gated ? GATED_MARK : ''}`,
        significant: row.significant,
        tone: effectTone(effect, value.value),
      }
    })
  })
  const notes = ['Bold: significant after correction.']
  if (all.some((row) => !row.inFamily)) {
    notes.push(
      `${OUTSIDE_MARK} Sensitivity, outside the family: the p is uncorrected.`,
    )
  }
  if (all.some((row) => row.gated)) {
    notes.push(`${GATED_MARK} The omnibus test was not significant.`)
  }
  notes.push(
    'Blue: negative, red: positive; full at |d| 1, |r| 0.5, or partial \u03b7\u00b2 0.25.',
  )
  const significant = all.filter((row) => row.significant).length
  const reference = terms.find((term) => term.family !== null) ?? terms[0]
  return {
    terms: terms.map((term) => ({
      id: term.termId,
      label: label(term),
      detail: EFFECT_SYMBOL[termEffect(result, term)],
    })),
    measures: measureIds.map((measureId) => ({
      id: measureId,
      label: measureTitleName(measureId),
      detail: '',
    })),
    cells,
    correctedLabel: CORRECTION_SHORT[correction],
    subtitle: [
      [
        `${terms.length} ${terms.length === 1 ? 'term' : 'terms'} by ${measureIds.length} ${measureIds.length === 1 ? 'measure' : 'measures'}`,
      ],
      ...(reference
        ? [[`Corrected p: ${correctionText(result, reference)}`] as Rich]
        : []),
    ],
    notes,
    provisional: result.provisional,
    summary: `Grid of ${terms.length} terms by ${measureIds.length} measures; ${significant} of ${all.length} cells significant after correction.`,
    significantText: `${significant} of ${all.length} cells significant after correction.`,
  }
}
