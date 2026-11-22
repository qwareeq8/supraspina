/**
 * The forest plot's model: measures grouped by family with their effect,
 * CI, and corrected p as the figure prints them, and the plot's height.
 */

import type {
  GroupAnalysisResult,
  GroupAnalysisRow,
} from '../../shared/group-analysis'
import {
  CORRECTION_SHORT,
  correctedFloor,
  familyLabel,
  formatEstimate,
  formatFixed,
  formatP,
  measureShortLabel,
} from './format'
import { FIGURE_FONT_PT } from './style'
import type { Rich } from './rich'

/** One plotted measure. */
export interface ForestRow {
  measureId: string
  /**
   * The row's own key where one measure has several rows (a battery or
   * stratified forest); the measure ID otherwise.
   */
  rowKey?: string
  label: string
  estimate: number
  low: number | null
  high: number | null
  significant: boolean
  effect: string
  p: string
}

/** A family heading and its rows. */
export interface ForestGroup {
  heading: string
  rows: ForestRow[]
}

/** Everything the forest plot draws, independent of size. */
export interface ForestModel {
  groups: ForestGroup[]
  subtitle: Rich[]
  effectHeader: Rich
  pHeader: Rich
  xLabel: Rich
  /** "<- smaller in SCI", or null for an association. */
  direction: string | null
  provisional: boolean
  summary: string
  /** The page of a forest split over several figures, or null for one. */
  page: { index: number; count: number } | null
  /**
   * Every row of the whole forest, so each page of a split forest keeps
   * the same columns and axis; null when the model holds every row.
   */
  scaleRows: ForestRow[] | null
}

/** The rows one exported forest page holds; longer forests continue. */
export const FOREST_ROWS_PER_PAGE = 60

/**
 * Give a result figure's subtitle: the contrast with its group sizes, then
 * which marks survive the correction and over which measures.
 *
 * @param marked - How a significant measure is marked, such as "filled".
 */
export function resultSubtitle(
  result: GroupAnalysisResult,
  marked: string,
): Rich[] {
  const { spec } = result
  const { correction, alpha } = spec.inference
  const short = CORRECTION_SHORT[correction]
  const counts = new Map(result.sample.groups.map((g) => [g.label, g.n]))
  const lines: Rich[] = []
  if (spec.contrast.type === 'groups') {
    const { focal, reference } = spec.contrast
    lines.push([
      `${focal} (`,
      { i: 'n' },
      ` = ${counts.get(focal) ?? 0}) vs ${reference} (`,
      { i: 'n' },
      ` = ${counts.get(reference) ?? 0})`,
    ])
  } else {
    lines.push([`Association, `, { i: 'n' }, ` = ${result.sample.included}`])
  }
  // The correction runs over every measure of the result, drawn or not.
  const tested = result.rows.length
  const family =
    spec.inference.family === 'per-family'
      ? 'within each measure family'
      : `over the ${tested} ${tested === 1 ? 'measure' : 'measures'}`
  lines.push(
    correction === 'none'
      ? [`${marked}: `, { i: 'p' }, ` < ${alpha} uncorrected`]
      : [`${marked}: `, `${short} `, { i: 'p' }, ` < ${alpha} ${family}`],
  )
  return lines
}

/**
 * Build the forest model of a result: families in first-appearance order,
 * rows in result order.
 *
 * @param rows - The rows to draw, for example after a filter; defaults to every
 *   row.
 */
export function forestModel(
  result: GroupAnalysisResult,
  rows: readonly GroupAnalysisRow[] = result.rows,
): ForestModel {
  const { spec } = result
  const groupsContrast = spec.contrast.type === 'groups'
  const focal = spec.contrast.type === 'groups' ? spec.contrast.focal : null
  const { correction, permutations } = spec.inference
  const floor = correctedFloor(correction, permutations)
  const short = CORRECTION_SHORT[correction]
  const byFamily = new Map<string, ForestRow[]>()
  for (const row of rows) {
    const plotted = groupsContrast && row.d !== null
    const estimate = plotted ? row.d! : row.t
    const list = byFamily.get(row.family) ?? []
    list.push({
      measureId: row.measureId,
      label: measureShortLabel(row.measureId),
      estimate,
      low: plotted ? row.dLow : null,
      high: plotted ? row.dHigh : null,
      significant: row.significant,
      effect: plotted
        ? formatEstimate(estimate, row.dLow, row.dHigh, 2)
        : formatFixed(row.t, 2, true),
      p: formatP(
        row.pCorrected ?? row.p,
        row.pCorrected === null ? null : floor,
      ),
    })
    byFamily.set(row.family, list)
  }
  const groups = [...byFamily.entries()].map(([family, list]) => ({
    heading: familyLabel(family),
    rows: list,
  }))
  const subtitle: Rich[] = [...resultSubtitle(result, 'filled')]
  const tested = result.rows.length
  if (rows.length < tested) {
    subtitle.push([
      `${rows.length} of the ${tested} measures: every significant one and the largest effects`,
    ])
  }
  const significant = rows.filter((row) => row.significant).length
  return {
    groups,
    subtitle,
    effectHeader: groupsContrast ? [{ i: 'd' }, ' (95% CI)'] : [{ i: 't' }],
    pHeader: short ? [`${short} `, { i: 'p' }] : [{ i: 'p' }],
    xLabel: groupsContrast
      ? ['Adjusted standardized difference, ', { i: 'd' }]
      : [{ i: 't' }, ' statistic of the slope'],
    direction: focal ? `\u2190 smaller in ${focal}` : null,
    provisional: result.provisional,
    summary: `Forest plot of ${rows.length} ${rows.length === 1 ? 'measure' : 'measures'}; ${significant} significant${correction === 'none' ? '' : ` after ${short} correction`}. The results table lists every value.`,
    page: null,
    scaleRows: null,
  }
}

/**
 * Choose the rows of a shortened forest: every significant measure and the
 * `count` others with the largest effect (|d|, or |t| without d), in
 * result order.
 *
 * @param count - How many of the largest effects to keep.
 */
export function topForestRows(
  result: GroupAnalysisResult,
  count: number = FOREST_ROWS_PER_PAGE,
): GroupAnalysisRow[] {
  const size = (row: GroupAnalysisRow): number => Math.abs(row.d ?? row.t)
  const largest = new Set(
    [...result.rows]
      .sort((a, b) => size(b) - size(a))
      .slice(0, count)
      .map((row) => row.measureId),
  )
  return result.rows.filter(
    (row) => row.significant || largest.has(row.measureId),
  )
}

/**
 * Split a forest into pages of at most `perPage` rows, so an export stays
 * printable and inside main's figure size limit. A family that continues
 * onto a page repeats its heading with "(continued)", later pages say
 * "Figure continued", and every page keeps the whole forest's columns and
 * axis.
 *
 * @returns One model per page; the model itself when it fits one.
 */
export function paginateForest(
  model: ForestModel,
  perPage: number = FOREST_ROWS_PER_PAGE,
): ForestModel[] {
  const all = model.groups.flatMap((g) => g.rows)
  if (all.length <= perPage) return [model]
  const pages: ForestGroup[][] = []
  let page: ForestGroup[] = []
  let used = 0
  for (const group of model.groups) {
    let current: ForestGroup | null = null
    for (const [index, row] of group.rows.entries()) {
      if (used === perPage) {
        pages.push(page)
        page = []
        used = 0
        current = null
      }
      if (!current) {
        current = {
          heading: index > 0 ? `${group.heading} (continued)` : group.heading,
          rows: [],
        }
        page.push(current)
      }
      current.rows.push(row)
      used += 1
    }
  }
  pages.push(page)
  const count = pages.length
  return pages.map((groups, index) => ({
    ...model,
    groups,
    subtitle:
      index === 0
        ? [...model.subtitle, [`Page 1 of ${count}`]]
        : [
            [`Figure continued, page ${index + 1} of ${count}`],
            ...model.subtitle,
          ],
    page: { index: index + 1, count },
    scaleRows: all,
  }))
}

export const FOREST_ROW = 2.05
export const FOREST_HEADING = 1.9

/**
 * Compute the height a forest plot takes at a width.
 *
 * @returns The height in points.
 */
export function forestHeight(model: ForestModel): number {
  const fs = FIGURE_FONT_PT
  const rows = model.groups.reduce((sum, g) => sum + g.rows.length, 0)
  const top = 4 + model.subtitle.length * fs * 1.35 + fs * 0.9 + fs * 1.8
  const body =
    model.groups.length * fs * FOREST_HEADING + rows * fs * FOREST_ROW
  const axis = fs * 5.2
  return Math.ceil(top + body + axis)
}
