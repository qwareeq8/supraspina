/**
 * The forest models of a v2 result, drawn by the same forest plot as v1:
 *
 * - a term's forest: one row per measure with the term's effect (d,
 *   partial r, or partial eta squared) and its corrected p;
 * - a battery forest: one group per measure and one row per test, every
 *   test on the common partial r scale with its 95% CI;
 * - a stratified forest: one group per measure, the pooled row and each
 *   stratum's, with the heterogeneity p in the group heading.
 *
 * Marks that do not rely on color: a filled square survives the
 * correction, "\u2020" marks a sensitivity row outside the family (its p is
 * uncorrected), and "\u2021" a pairwise row whose omnibus test was not
 * significant.
 */

import type {
  GroupAnalysisResultV2,
  GroupAnalysisRowV2,
  GroupAnalysisTerm,
} from '../../shared/group-analysis'
import {
  correctionText,
  rowEffect,
  rowSize,
  termEffect,
  termTest,
  termTitle,
  type TermEffect,
} from '../screens/analysis/v2/terms'
import {
  CORRECTION_SHORT,
  correctedFloor,
  familyLabel,
  formatEstimate,
  formatP,
  formatPRelation,
  measureShortLabel,
  measureTitleName,
} from './format'
import {
  FOREST_ROWS_PER_PAGE,
  type ForestGroup,
  type ForestModel,
  type ForestRow,
} from './forest-model'
import type { Rich } from './rich'

/** The mark of a sensitivity row outside the correction family. */
export const OUTSIDE_MARK = '\u2020'
/** The mark of a pairwise row after a non-significant omnibus test. */
export const GATED_MARK = '\u2021'

/** The forest's effect axis and column header per effect. */
const EFFECT_AXIS: Readonly<
  Record<TermEffect, { header: Rich; axis: Rich; digits: number }>
> = {
  d: {
    header: [{ i: 'd' }, ' (95% CI)'],
    axis: ['Adjusted standardized difference, ', { i: 'd' }],
    digits: 2,
  },
  r: {
    header: [{ i: 'r' }, ' (95% CI)'],
    axis: ['Partial correlation, ', { i: 'r' }],
    digits: 2,
  },
  eta2: {
    header: ['Partial ', { i: '\u03b7' }, '\u00b2'],
    axis: ['Partial ', { i: '\u03b7' }, '\u00b2'],
    digits: 3,
  },
}

/**
 * Format a row's p for a forest or grid: the corrected p in the family, the
 * uncorrected p with the sensitivity mark outside it, and the gate mark.
 */
export function rowPText(
  result: GroupAnalysisResultV2,
  row: GroupAnalysisRowV2,
): string {
  const { correction, permutations } = result.spec.inference
  const text =
    row.pCorrected !== null
      ? formatP(row.pCorrected, correctedFloor(correction, permutations))
      : `${formatP(row.p)}${row.inFamily ? '' : OUTSIDE_MARK}`
  return row.gated ? `${text}${GATED_MARK}` : text
}

function marksNote(rows: readonly GroupAnalysisRowV2[]): Rich[] {
  const notes: string[] = []
  if (rows.some((row) => !row.inFamily)) {
    notes.push(`${OUTSIDE_MARK} sensitivity, outside the family (uncorrected)`)
  }
  if (rows.some((row) => row.gated)) {
    notes.push(`${GATED_MARK} omnibus test not significant`)
  }
  return notes.length > 0 ? [[notes.join('; ')]] : []
}

function pHeader(result: GroupAnalysisResultV2): Rich {
  const short = CORRECTION_SHORT[result.spec.inference.correction]
  return short ? [`${short} `, { i: 'p' }] : [{ i: 'p' }]
}

function sampleLine(
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
  rows: readonly GroupAnalysisRowV2[],
): Rich {
  const first = rows[0]
  if (term.pair && first?.nFocal !== null && first?.nReference !== null) {
    return [
      `${term.pair.focal} (`,
      { i: 'n' },
      ` = ${first?.nFocal ?? 0}) vs ${term.pair.reference} (`,
      { i: 'n' },
      ` = ${first?.nReference ?? 0})`,
    ]
  }
  const n = Math.max(0, ...rows.map((row) => row.nTotal))
  return [`${termTitle(result, term)}, `, { i: 'n' }, ` = ${n}`]
}

/**
 * Build the forest of one term: families in first-appearance order, rows
 * in result order.
 *
 * @param rows - The rows to draw (for example the top rows).
 * @param tested - How many rows the term has in all.
 */
export function termForestModel(
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
  rows: readonly GroupAnalysisRowV2[],
  tested: number = rows.length,
): ForestModel {
  const effect = termEffect(result, term)
  const axis = EFFECT_AXIS[effect]
  const byFamily = new Map<string, ForestRow[]>()
  for (const row of rows) {
    const value = rowEffect(row, effect)
    if (value.value === null) continue
    const list = byFamily.get(row.family) ?? []
    list.push({
      measureId: row.measureId,
      label: measureShortLabel(row.measureId),
      estimate: value.value,
      low: value.low,
      high: value.high,
      significant: row.significant,
      effect: formatEstimate(
        value.value,
        value.low,
        value.high,
        axis.digits,
        effect !== 'eta2',
      ),
      p: rowPText(result, row),
    })
    byFamily.set(row.family, list)
  }
  const groups: ForestGroup[] = [...byFamily.entries()].map(
    ([family, list]) => ({ heading: familyLabel(family), rows: list }),
  )
  const drawn = groups.reduce((sum, group) => sum + group.rows.length, 0)
  const significant = rows.filter((row) => row.significant).length
  const subtitle: Rich[] = [
    sampleLine(result, term, rows),
    [`Filled: significant; ${correctionText(result, term)}`],
    ...marksNote(rows),
  ]
  if (drawn < tested) {
    subtitle.push([
      `${drawn} of the ${tested} measures: every significant one and the largest effects`,
    ])
  }
  const test = termTest(result, term)
  const focal =
    effect === 'd' ? (term.pair?.focal ?? test?.factor?.focal ?? null) : null
  return {
    groups,
    subtitle,
    effectHeader: axis.header,
    pHeader: pHeader(result),
    xLabel: axis.axis,
    direction: focal ? `\u2190 smaller in ${focal}` : null,
    provisional: result.provisional,
    summary: `Forest plot of ${drawn} ${drawn === 1 ? 'measure' : 'measures'} for ${termTitle(result, term)}; ${significant} significant. The results table lists every value.`,
    page: null,
    scaleRows: null,
  }
}

/**
 * Choose the rows of a shortened term forest: every significant measure and
 * the `count` others with the largest statistic, in result order.
 *
 * @param count - How many of the largest to keep.
 */
export function topTermRows(
  rows: readonly GroupAnalysisRowV2[],
  count: number = FOREST_ROWS_PER_PAGE,
): GroupAnalysisRowV2[] {
  const largest = new Set(
    [...rows]
      .sort((a, b) => rowSize(b) - rowSize(a))
      .slice(0, count)
      .map((row) => row.measureId),
  )
  return rows.filter((row) => row.significant || largest.has(row.measureId))
}

/**
 * Build the battery forest: per measure, every t test of the result on the
 * partial r scale with its CI. F terms have no signed r and are left out,
 * as are pairwise, stratum, and heterogeneity terms.
 *
 * @param measureIds - The measures, in order.
 * @returns The model, or null when fewer than two tests qualify.
 */
export function batteryForestModel(
  result: GroupAnalysisResultV2,
  rowsOf: (termId: string) => readonly GroupAnalysisRowV2[],
  measureIds: readonly string[],
): ForestModel | null {
  const terms = result.terms.filter(
    (term) => term.role === 'effect' && term.kind === 't' && !term.stratum,
  )
  if (terms.length < 2) return null
  const byTerm = new Map(
    terms.map((term) => [
      term.termId,
      new Map(rowsOf(term.termId).map((row) => [row.measureId, row])),
    ]),
  )
  const groups: ForestGroup[] = []
  const all: GroupAnalysisRowV2[] = []
  for (const measureId of measureIds) {
    const rows: ForestRow[] = []
    for (const term of terms) {
      const row = byTerm.get(term.termId)?.get(measureId)
      if (!row || row.partialR === null) continue
      all.push(row)
      rows.push({
        measureId,
        rowKey: `${term.termId}:${measureId}`,
        label: term.label,
        estimate: row.partialR,
        low: row.partialRLow,
        high: row.partialRHigh,
        significant: row.significant,
        effect: formatEstimate(
          row.partialR,
          row.partialRLow,
          row.partialRHigh,
          2,
        ),
        p: rowPText(result, row),
      })
    }
    if (rows.length > 0) {
      groups.push({ heading: measureTitleName(measureId), rows })
    }
  }
  const omitted = result.terms.some(
    (term) => term.role === 'effect' && term.kind === 'F' && !term.stratum,
  )
  const significant = all.filter((row) => row.significant).length
  return {
    groups,
    subtitle: [
      [
        `${terms.length} tests on the partial correlation scale, `,
        { i: 'n' },
        ` = ${Math.max(0, ...all.map((row) => row.nTotal))}`,
      ],
      [
        `Filled: significant; ${correctionText(result, terms.find((term) => term.family !== null) ?? terms[0]!)}`,
      ],
      ...marksNote(all),
      ...(omitted ? [['F tests have no signed r and are not drawn']] : []),
    ],
    effectHeader: EFFECT_AXIS.r.header,
    pHeader: pHeader(result),
    xLabel: EFFECT_AXIS.r.axis,
    direction: null,
    provisional: result.provisional,
    summary: `Forest plot of ${terms.length} tests over ${groups.length} ${groups.length === 1 ? 'measure' : 'measures'} as partial correlations; ${significant} significant. The results table lists every value.`,
    page: null,
    scaleRows: null,
  }
}

/**
 * Build the stratified forest of a term: per measure, the pooled row and
 * each stratum's, with the heterogeneity p (corrected over the measures)
 * in the heading.
 *
 * @param pooled - The pooled term, or null.
 * @param heterogeneity - The heterogeneity term, or null.
 * @param measureIds - The measures, in order.
 */
export function strataForestModel(
  result: GroupAnalysisResultV2,
  pooled: GroupAnalysisTerm | null,
  strata: readonly GroupAnalysisTerm[],
  heterogeneity: GroupAnalysisTerm | null,
  rowsOf: (termId: string) => readonly GroupAnalysisRowV2[],
  measureIds: readonly string[],
): ForestModel {
  const terms = [...strata, ...(pooled ? [pooled] : [])]
  const first = terms[0]!
  const effect = termEffect(result, first)
  const axis = EFFECT_AXIS[effect]
  const index = (termId: string) =>
    new Map(rowsOf(termId).map((row) => [row.measureId, row]))
  const byTerm = new Map(terms.map((term) => [term.termId, index(term.termId)]))
  const hetero = heterogeneity ? index(heterogeneity.termId) : null
  const { correction, permutations } = result.spec.inference
  const floor = correctedFloor(correction, permutations)
  const groups: ForestGroup[] = []
  const all: GroupAnalysisRowV2[] = []
  for (const measureId of measureIds) {
    const rows: ForestRow[] = []
    for (const term of terms) {
      const row = byTerm.get(term.termId)?.get(measureId)
      if (!row) continue
      const value = rowEffect(row, effect)
      if (value.value === null) continue
      all.push(row)
      rows.push({
        measureId,
        rowKey: `${term.termId}:${measureId}`,
        label: term.stratum ?? 'Pooled',
        estimate: value.value,
        low: value.low,
        high: value.high,
        significant: row.significant,
        effect: formatEstimate(
          value.value,
          value.low,
          value.high,
          axis.digits,
          effect !== 'eta2',
        ),
        p: rowPText(result, row),
      })
    }
    if (rows.length === 0) continue
    const het = hetero?.get(measureId)
    const hetText = het
      ? `, heterogeneity p ${formatPRelation(het.pCorrected ?? het.p, het.pCorrected === null ? null : floor)}`
      : ''
    groups.push({ heading: `${measureTitleName(measureId)}${hetText}`, rows })
  }
  const significant = all.filter((row) => row.significant).length
  return {
    groups,
    subtitle: [
      [
        `${termTest(result, first)?.label ?? first.label}${first.pair ? `, ${first.pair.focal} vs ${first.pair.reference}` : ''}, per stratum`,
      ],
      [`Filled: significant; ${correctionText(result, first)}`],
      ...(heterogeneity
        ? [[`Heterogeneity: ${correctionText(result, heterogeneity)}`] as Rich]
        : []),
      ...marksNote(all),
    ],
    effectHeader: axis.header,
    pHeader: pHeader(result),
    xLabel: axis.axis,
    direction: null,
    provisional: result.provisional,
    summary: `Stratified forest plot of ${groups.length} ${groups.length === 1 ? 'measure' : 'measures'} over ${strata.length} strata; ${significant} significant. The results table lists every value.`,
    page: null,
    scaleRows: null,
  }
}
