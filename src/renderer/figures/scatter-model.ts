/**
 * The adjusted per-subject figure's model: groups in reference, focal, other
 * order with their subjects' adjusted values and marker shapes, the legend,
 * the title such as "Brainstem 5.7% smaller", and the effect and p lines.
 */

import type {
  GroupAnalysisMeasureDetail,
  GroupAnalysisResult,
} from '../../shared/group-analysis'
import {
  CORRECTION_SHORT,
  correctedFloor,
  formatEstimate,
  formatFixed,
  formatPRelation,
  measureTitleName,
  measureUnitText,
} from './format'
import { richText, type Rich } from './rich'
import { FIGURE_COLORS, MARKER_SHAPES, type MarkerShape } from './style'

/** One subject's marker. */
export interface ScatterPoint {
  subjectId: string
  value: number
  x: number | null
  shape: MarkerShape
  color: string
}

/** One group's swarm and adjusted mean. */
export interface ScatterGroup {
  label: string
  role: 'focal' | 'reference' | 'other'
  color: string
  n: number
  mean: number | null
  low: number | null
  high: number | null
  points: ScatterPoint[]
}

/** One legend entry: a marker, the mean-and-CI cross, or a fitted line. */
export interface ScatterLegendEntry {
  shape: MarkerShape | 'cross' | 'line'
  color: string
  label: string
}

/** One fitted line with its 95% band, drawn under the markers. */
export interface ScatterFit {
  /** The group of an interaction's per-group line; null for one line. */
  group: string | null
  color: string
  x: readonly number[]
  y: readonly number[]
  low: readonly number[]
  high: readonly number[]
}

/** Everything the figure draws, independent of size. */
export interface ScatterModel {
  kind: 'groups' | 'association'
  title: Rich
  stats: Rich[]
  yLabel: string
  xLabel: string
  groups: ScatterGroup[]
  legend: ScatterLegendEntry[]
  /** The fitted lines of an association or interaction (v2). */
  fits?: ScatterFit[]
  provisional: boolean
  summary: string
}

const ROLE_ORDER = { reference: 0, focal: 1, other: 2 } as const

/** The swarms and legend of one measure's subjects. */
export interface ScatterGroups {
  groups: ScatterGroup[]
  legend: ScatterLegendEntry[]
}

/**
 * Lay out a measure's subjects: groups in reference, focal, other order
 * with their Okabe-Ito colors and adjusted means, one marker shape per
 * source label, and the legend (with the mean-and-CI cross unless
 * `association`).
 *
 * @param association - Whether the figure plots against a variable.
 */
export function scatterGroups(
  detail: Pick<GroupAnalysisMeasureDetail, 'groupMeans' | 'subjects'>,
  association: boolean,
): ScatterGroups {
  const means = [...detail.groupMeans].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role],
  )
  let other = 0
  const colorOf = new Map<string, string>()
  for (const mean of means) {
    colorOf.set(
      mean.label,
      mean.role === 'reference'
        ? FIGURE_COLORS.reference
        : mean.role === 'focal'
          ? FIGURE_COLORS.focal
          : FIGURE_COLORS.others[other++ % FIGURE_COLORS.others.length]!,
    )
  }
  const groupOrder = means.map((m) => m.label)
  const shapeOf = new Map<string, MarkerShape>()
  const legend: ScatterLegendEntry[] = []
  // Within a group, the larger source label takes the filled shape first, as
  // SCI with pain (triangles) and without pain (open squares) do.
  const labelCount = new Map<string, number>()
  for (const s of detail.subjects) {
    const key = s.sourceLabel ?? s.group ?? ''
    labelCount.set(key, (labelCount.get(key) ?? 0) + 1)
  }
  const count = (s: { sourceLabel: string | null; group: string | null }) =>
    labelCount.get(s.sourceLabel ?? s.group ?? '') ?? 0
  const sources = [...detail.subjects].sort(
    (a, b) =>
      groupOrder.indexOf(a.group ?? '') - groupOrder.indexOf(b.group ?? '') ||
      count(b) - count(a) ||
      (a.sourceLabel ?? '').localeCompare(b.sourceLabel ?? ''),
  )
  for (const subject of sources) {
    const key = subject.sourceLabel ?? subject.group ?? 'All subjects'
    if (shapeOf.has(key)) continue
    const shape = MARKER_SHAPES[shapeOf.size % MARKER_SHAPES.length]!
    shapeOf.set(key, shape)
    legend.push({
      shape,
      color: colorOf.get(subject.group ?? '') ?? FIGURE_COLORS.reference,
      label: key,
    })
  }
  const groups: ScatterGroup[] = means.map((mean) => ({
    label: mean.label,
    role: mean.role,
    color: colorOf.get(mean.label)!,
    n: mean.n,
    mean: mean.mean,
    low: mean.low,
    high: mean.high,
    points: [],
  }))
  if (groups.length === 0) {
    groups.push({
      label: 'All subjects',
      role: 'reference',
      color: FIGURE_COLORS.reference,
      n: detail.subjects.length,
      mean: null,
      low: null,
      high: null,
      points: [],
    })
  }
  for (const subject of detail.subjects) {
    const group = groups.find((g) => g.label === subject.group) ?? groups[0]!
    const key = subject.sourceLabel ?? subject.group ?? 'All subjects'
    group.points.push({
      subjectId: subject.subjectId,
      value: subject.adjusted,
      x: subject.x,
      shape: shapeOf.get(key) ?? 'circle',
      color: group.color,
    })
  }
  if (!association && means.length > 0) {
    legend.push({
      shape: 'cross',
      color: FIGURE_COLORS.ink,
      label: 'adjusted mean and 95% CI',
    })
  }
  return { groups, legend }
}

/**
 * Build the figure model of one measure.
 *
 * @param detail - The measure detail with per-subject values.
 */
export function scatterModel(
  detail: GroupAnalysisMeasureDetail,
  result: GroupAnalysisResult,
): ScatterModel {
  const { spec } = result
  const { row } = detail
  const name = measureTitleName(detail.measureId)
  const unit = measureUnitText(detail.measureId)
  const association = spec.contrast.type === 'association'
  const { groups, legend } = scatterGroups(detail, association)
  const { correction, permutations } = spec.inference
  const short = CORRECTION_SHORT[correction]
  const familySize =
    spec.inference.family === 'per-family'
      ? result.rows.filter((r) => r.family === row.family).length
      : result.rows.length
  const pLine: Rich =
    row.pCorrected !== null
      ? [
          `${short} `,
          { i: 'p' },
          ` ${formatPRelation(row.pCorrected, correctedFloor(correction, permutations))} (${familySize} ${familySize === 1 ? 'measure' : 'measures'})`,
        ]
      : [{ i: 'p' }, ` ${formatPRelation(row.p)} (uncorrected)`]
  const pct = row.pctOfReference
  const title: Rich =
    !association && pct !== null
      ? [
          `${name} ${Math.abs(pct).toFixed(1)}% ${pct < 0 ? 'smaller' : 'larger'}`,
        ]
      : [name]
  const stats: Rich[] =
    !association && row.d !== null
      ? [
          [{ i: 'd' }, ` = ${formatEstimate(row.d, row.dLow, row.dHigh, 2)}`],
          pLine,
        ]
      : [
          [{ i: 't' }, `(${Math.round(row.df)}) = ${formatFixed(row.t, 2)}`],
          pLine,
        ]
  const variable =
    spec.contrast.type === 'association' ? spec.contrast.variable.column : ''
  return {
    kind: association ? 'association' : 'groups',
    title,
    stats,
    yLabel: `${name}, adjusted${unit ? ` (${unit})` : ''}`,
    xLabel: variable,
    groups,
    legend,
    provisional: result.provisional,
    summary: `${richText(title)}. ${stats.map(richText).join('; ')}. ${detail.subjects.length} subjects. The results table lists the model values.`,
  }
}

/** The narrowest width, in points, at which the figure keeps its least height. */
export const SCATTER_COMPACT_WIDTH_PT = 257

/**
 * The height of the figure at a width, in points.
 *
 * @param width - The width in points.
 */
export function scatterHeight(width: number): number {
  return Math.round(Math.min(Math.max(width * 0.78, 200), 330))
}
