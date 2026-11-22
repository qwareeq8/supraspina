/**
 * The measure figure of one term of a v2 result, drawn by the v1 adjusted
 * scatter: a k-group beeswarm with adjusted means for a group term (two
 * groups, an omnibus test, or a pair); the adjusted values against the
 * tested variable with the fitted line and its 95% band for an
 * association; and one line and band per group, in the groups' Okabe-Ito
 * colors, for a slope difference, with each group's simple slope in the
 * legend (descriptive).
 */

import type {
  GroupAnalysisMeasureDetailV2,
  GroupAnalysisResultV2,
  GroupAnalysisTerm,
  TestVariable,
} from '../../shared/group-analysis'
import {
  OUTSIDE_FAMILY_TEXT,
  termEffect,
  termTest,
  termTitle,
} from '../screens/analysis/v2/terms'
import {
  CORRECTION_SHORT,
  correctedFloor,
  formatEstimate,
  formatFixed,
  formatPRelation,
  formatValue,
  measureTitleName,
  measureUnitText,
} from './format'
import { richText, type Rich } from './rich'
import {
  scatterGroups,
  type ScatterFit,
  type ScatterModel,
} from './scatter-model'
import { FIGURE_COLORS } from './style'

/**
 * Name a tested variable or moderator with its transform; a derived
 * variable reads its label.
 *
 * @param variable - The variable, or null.
 * @param result - The v2 result, for derived labels.
 * @returns The axis label, such as "log(1 + Time since SCI)".
 */
export function variableAxisLabel(
  variable: TestVariable | null,
  result: GroupAnalysisResultV2,
): string {
  if (!variable) return ''
  const { ref } = variable
  const name =
    ref.source === 'derived'
      ? (result.spec.variables.derived.find((item) => item.id === ref.column)
          ?.label ?? ref.column)
      : ref.column
  if (variable.transform === 'log1p') return `log(1 + ${name})`
  if (variable.transform === 'standardize') return `${name} (SD units)`
  return name
}

/**
 * Build the measure figure of one term.
 *
 * @param options - `termLine: false` leaves out the term line, for a view
 *   that names the term itself.
 */
export function scatterModelV2(
  detail: GroupAnalysisMeasureDetailV2,
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
  { termLine = true }: { termLine?: boolean } = {},
): ScatterModel {
  const { row } = detail
  const test = termTest(result, term)
  const effect = termEffect(result, term)
  const name = measureTitleName(detail.measureId)
  const unit = measureUnitText(detail.measureId)
  const association =
    detail.fit.length > 0 || detail.subjects.some((s) => s.x !== null)
  const { groups, legend } = scatterGroups(detail, association)
  const colorOf = new Map(groups.map((group) => [group.label, group.color]))
  const fits: ScatterFit[] = detail.fit.map((line) => ({
    group: line.group,
    color:
      line.group === null
        ? FIGURE_COLORS.focal
        : (colorOf.get(line.group) ?? FIGURE_COLORS.focal),
    x: line.x,
    y: line.y,
    low: line.low,
    high: line.high,
  }))
  if (association) {
    for (const slope of detail.simpleSlopes) {
      legend.push({
        shape: 'line',
        color: colorOf.get(slope.group) ?? FIGURE_COLORS.focal,
        label: `${slope.group} slope ${formatValue(slope.slope)} (${formatValue(slope.low)} to ${formatValue(slope.high)})`,
      })
    }
    if (detail.simpleSlopes.length === 0 && fits.length > 0) {
      legend.push({
        shape: 'line',
        color: FIGURE_COLORS.focal,
        label: 'fitted line and 95% band',
      })
    }
  }
  const { correction, permutations } = result.spec.inference
  const short = CORRECTION_SHORT[correction]
  const pLine: Rich =
    row.pCorrected !== null
      ? [
          `${short} `,
          { i: 'p' },
          ` ${formatPRelation(row.pCorrected, correctedFloor(correction, permutations))}${row.gated ? ', omnibus test not significant' : ''}`,
        ]
      : [
          { i: 'p' },
          ` ${formatPRelation(row.p)}, uncorrected${row.inFamily ? '' : ` (${OUTSIDE_FAMILY_TEXT.toLowerCase()})`}`,
        ]
  let statLine: Rich
  if (row.F !== null) {
    statLine = [
      { i: 'F' },
      `(${row.df1}, ${Math.round(row.df2)}) = ${formatFixed(row.F, 2)}, partial `,
      { i: '\u03b7' },
      `\u00b2 = ${formatFixed(row.partialEta2, 3)}`,
    ]
  } else if (effect === 'd' && row.d !== null) {
    statLine = [
      { i: 'd' },
      ` = ${formatEstimate(row.d, row.dLow, row.dHigh, 2)}`,
    ]
  } else if (row.partialR !== null) {
    statLine = [
      { i: 't' },
      `(${Math.round(row.df2)}) = ${formatFixed(row.t ?? NaN, 2)}, `,
      { i: 'r' },
      ` = ${formatEstimate(row.partialR, row.partialRLow, row.partialRHigh, 2)}`,
    ]
  } else {
    statLine = [
      { i: 't' },
      `(${Math.round(row.df2)}) = ${formatFixed(row.t ?? NaN, 2)}`,
    ]
  }
  const pct = row.pctOfReference
  const title: Rich =
    !association && effect === 'd' && pct !== null
      ? [
          `${name} ${Math.abs(pct).toFixed(1)}% ${pct < 0 ? 'smaller' : 'larger'}`,
        ]
      : [name]
  const stats: Rich[] = [
    ...(termLine ? [[termTitle(result, term)] as Rich] : []),
    statLine,
    pLine,
  ]
  const xLabel =
    test?.kind === 'interaction'
      ? variableAxisLabel(test.moderator, result)
      : variableAxisLabel(test?.variable ?? null, result)
  return {
    kind: association ? 'association' : 'groups',
    title,
    stats,
    yLabel: `${name}, adjusted${unit ? ` (${unit})` : ''}`,
    xLabel,
    groups,
    legend,
    fits,
    provisional: result.provisional,
    summary: `${richText(title)}. ${stats.map(richText).join('; ')}. ${detail.subjects.length} subjects. The results table lists the model values.`,
  }
}
