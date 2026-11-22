/**
 * The model of the k x k pairwise matrix of one measure after an omnibus
 * test: the cells (d above the diagonal, the corrected p below it, n on it)
 * and the figure's height.
 */

import type {
  AnalysisTest,
  GroupAnalysisResultV2,
  GroupAnalysisRowV2,
  GroupAnalysisTerm,
} from '../../shared/group-analysis'
import { pairTerms, termTest } from '../screens/analysis/v2/terms'
import {
  CORRECTION_SHORT,
  correctedFloor,
  formatFixed,
  formatInterval,
  formatP,
  measureTitleName,
} from './format'
import { GATED_MARK, OUTSIDE_MARK } from './forest-model-v2'
import { effectTone } from './grid-model'
import type { Rich } from './rich'
import { FIGURE_FONT_PT } from './style'

/** One cell of the matrix. */
export interface MatrixCell {
  kind: 'd' | 'p' | 'group' | 'untested'
  text: Rich
  /** The second line: the CI, the uncorrected p, or empty. */
  sub: Rich
  significant: boolean
  tone: number
}

/** Everything the matrix draws. */
export interface PairwiseMatrixModel {
  groups: { label: string; n: number | null }[]
  cells: MatrixCell[][]
  title: Rich
  subtitle: Rich[]
  notes: Rich[]
  provisional: boolean
  summary: string
}

/**
 * Say whether a term's test has pairwise terms, so its measures have a
 * matrix.
 *
 * @returns The omnibus test, or null.
 */
export function matrixTest(
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
): AnalysisTest | null {
  const test = termTest(result, term)
  return test?.kind === 'omnibus' &&
    test.factor &&
    pairTerms(result, term).length > 0
    ? test
    : null
}

/**
 * Build the matrix of one measure.
 *
 * @param term - A term of the omnibus test (its stratum is used).
 * @returns The model, or null for a test without pairs.
 */
export function pairwiseMatrixModel(
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
  rowsOf: (termId: string) => readonly GroupAnalysisRowV2[],
  measureId: string,
): PairwiseMatrixModel | null {
  const test = matrixTest(result, term)
  if (!test?.factor) return null
  const labels = test.factor.grouping.groups.map((group) => group.label)
  const { correction, permutations } = result.spec.inference
  const floor = correctedFloor(correction, permutations)
  const short = CORRECTION_SHORT[correction]
  const counts = new Map<string, number>()
  const pairs = pairTerms(result, term).flatMap((pair) => {
    const row = rowsOf(pair.termId).find((item) => item.measureId === measureId)
    if (!row || !pair.pair) return []
    if (row.nFocal !== null) counts.set(pair.pair.focal, row.nFocal)
    if (row.nReference !== null) counts.set(pair.pair.reference, row.nReference)
    return [{ pair: pair.pair, row }]
  })
  const find = (a: string, b: string) => {
    const direct = pairs.find(
      (item) => item.pair.focal === a && item.pair.reference === b,
    )
    if (direct) return { row: direct.row, sign: 1 }
    const reversed = pairs.find(
      (item) => item.pair.focal === b && item.pair.reference === a,
    )
    return reversed ? { row: reversed.row, sign: -1 } : null
  }
  const mark = (row: GroupAnalysisRowV2): string =>
    `${row.significant ? '*' : ''}${row.gated ? GATED_MARK : ''}`
  let tested = 0
  let survived = 0
  const cells = labels.map((rowLabel, i) =>
    labels.map((columnLabel, j): MatrixCell => {
      if (i === j) {
        const n = counts.get(rowLabel)
        return {
          kind: 'group',
          text: [rowLabel],
          sub: n === undefined ? [] : [{ i: 'n' }, ` = ${n}`],
          significant: false,
          tone: 0,
        }
      }
      const found = find(rowLabel, columnLabel)
      if (!found) {
        return {
          kind: 'untested',
          text: ['Not tested'],
          sub: [],
          significant: false,
          tone: 0,
        }
      }
      const { row, sign } = found
      if (i < j) {
        tested += 1
        if (row.significant) survived += 1
        const d = row.d === null ? null : sign * row.d
        const low =
          row.dLow === null || row.dHigh === null
            ? null
            : sign > 0
              ? row.dLow
              : -row.dHigh
        const high =
          row.dLow === null || row.dHigh === null
            ? null
            : sign > 0
              ? row.dHigh
              : -row.dLow
        const interval = formatInterval(low, high, 2)
        return {
          kind: 'd',
          text: [
            `${d === null ? '\u2212' : formatFixed(d, 2, true)}${mark(row)}`,
          ],
          // The interval has a line of its own below d, so it needs no
          // parentheses, and it is as wide as the bracketed form was.
          sub: interval === null ? [] : [interval],
          significant: row.significant,
          tone: effectTone('d', d),
        }
      }
      return {
        kind: 'p',
        text:
          row.pCorrected === null
            ? [
                { i: 'p' },
                ` ${formatP(row.p)}${row.inFamily ? '' : OUTSIDE_MARK}${mark(row)}`,
              ]
            : [
                `${short} `,
                { i: 'p' },
                ` ${formatP(row.pCorrected, floor)}${mark(row)}`,
              ],
        sub: row.pCorrected === null ? [] : [{ i: 'p' }, ` ${formatP(row.p)}`],
        significant: row.significant,
        tone: 0,
      }
    }),
  )
  const notes: Rich[] = [
    [
      'Above the diagonal: ',
      { i: 'd' },
      ', row minus column [95% CI]; below: ',
      ...(short ? [`${short} `] : []),
      { i: 'p' },
      '.',
    ],
    ['* and bold: significant after correction.'],
  ]
  if (pairs.some(({ row }) => row.gated)) {
    notes.push([`${GATED_MARK} The omnibus test was not significant.`])
  }
  if (pairs.some(({ row }) => !row.inFamily)) {
    notes.push([`${OUTSIDE_MARK} Sensitivity, outside the family.`])
  }
  const name = measureTitleName(measureId)
  return {
    groups: labels.map((label) => ({ label, n: counts.get(label) ?? null })),
    cells,
    title: [name],
    subtitle: [
      [
        `${test.label}: ${tested} ${tested === 1 ? 'pair' : 'pairs'}${term.stratum ? `, ${term.stratum}` : ''}`,
      ],
    ],
    notes,
    provisional: result.provisional,
    summary: `Pairwise matrix of ${name} over ${labels.length} groups; ${survived} of ${tested} pairs significant after correction.`,
  }
}

/**
 * Compute the matrix figure's height at a width.
 *
 * @returns The height in points.
 */
export function matrixHeight(model: PairwiseMatrixModel): number {
  const fs = FIGURE_FONT_PT
  const k = model.groups.length
  return Math.ceil(
    4 +
      fs * 1.6 +
      model.subtitle.length * fs * 1.35 +
      fs * 2.2 +
      k * fs * 3.2 +
      fs * 0.8 +
      model.notes.length * fs * 1.3,
  )
}
