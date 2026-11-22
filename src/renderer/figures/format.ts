/**
 * Number, p-value, tick, and label formatting shared by the Analysis table
 * and figures. Negative numbers use the typographic minus sign (U+2212), and
 * a permutation p at its resolution floor reads "<= 1/(B+1)" with the
 * less-than-or-equal sign (U+2264).
 */

import {
  DK_METRIC_LABELS,
  DK_REGIONS,
  measureLabel,
  measureUnit,
  type MeasureUnit,
} from '../../shared/brain-atlas'
import { BUILT_IN_ATLASES } from '../../shared/atlas-labeling'
import {
  parseMeasureId,
  type Correction,
  type DkMetric,
} from '../../shared/group-analysis'

/** The typographic minus sign. */
export const MINUS = '\u2212'
/** The less-than-or-equal sign. */
export const LE = '\u2264'

/**
 * Format a number with fixed decimals, a typographic minus, and no negative
 * zero.
 *
 * @param digits - The decimal places.
 * @param plus - Whether to prefix positive values with a plus sign, as the
 *   forest columns do.
 */
export function formatFixed(
  value: number,
  digits: number,
  plus = false,
): string {
  if (!Number.isFinite(value)) return MINUS
  const rounded = Number(value.toFixed(digits))
  const text = Math.abs(rounded).toFixed(digits)
  if (rounded < 0) return `${MINUS}${text}`
  return plus && rounded > 0 ? `+${text}` : text
}

/**
 * Format a confidence interval as every figure prints it, for example
 * `\u22121.12 to \u22120.24`, with each bound signed as its estimate is.
 *
 * @param digits - The decimal places.
 * @param signed - Whether positive bounds carry a plus sign: true for an
 *   effect of either sign, false for one that cannot be negative, such as a
 *   partial eta squared.
 * @returns The interval, or null without both bounds.
 */
export function formatInterval(
  low: number | null,
  high: number | null,
  digits: number,
  signed = true,
): string | null {
  if (low === null || high === null) return null
  return `${formatFixed(low, digits, signed)} to ${formatFixed(high, digits, signed)}`
}

/**
 * Format an estimate with its confidence interval, for example
 * `\u22120.68 (\u22121.12 to \u22120.24)`, or the estimate alone without
 * both bounds.
 *
 * @param digits - The decimal places.
 * @param signed - Whether positive values carry a plus sign; see
 *   {@link formatInterval}.
 */
export function formatEstimate(
  value: number,
  low: number | null,
  high: number | null,
  digits: number,
  signed = true,
): string {
  const point = formatFixed(value, digits, signed)
  const interval = formatInterval(low, high, digits, signed)
  return interval === null ? point : `${point} (${interval})`
}

/**
 * Format a number with thousands separators, as axis ticks of volumes read.
 *
 * @param digits - The decimal places.
 */
export function formatGrouped(value: number, digits = 0): string {
  const rounded = Number(value.toFixed(digits))
  const text = Math.abs(rounded).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return rounded < 0 ? `${MINUS}${text}` : text
}

/**
 * Format a measure value for a table cell or hover line: grouped for large
 * magnitudes, three significant decimals for small ones.
 */
export function formatValue(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1000) return formatGrouped(value, 0)
  if (abs >= 100) return formatFixed(value, 1)
  if (abs >= 1) return formatFixed(value, 2)
  return formatFixed(value, 3)
}

/**
 * The smallest p a permutation test with `permutations` draws can report.
 *
 * @param permutations - B, the number of permutations.
 * @returns 1/(B+1), or null without permutations.
 */
export function permutationFloor(permutations: number): number | null {
  return permutations > 0 ? 1 / (permutations + 1) : null
}

function significant(value: number, digits: number): string {
  // Round first, so 0.0000999 reads 0.0001, not 0.00010; toPrecision alone
  // can switch to exponent form.
  const rounded = Number(value.toPrecision(digits))
  const places = Math.max(0, digits - 1 - Math.floor(Math.log10(rounded)))
  return rounded.toFixed(places)
}

/**
 * Format a p value: two decimals from 0.1, two significant digits below it,
 * "< 0.001" below 0.001, and "<= 1/(B+1)" at a permutation floor.
 *
 * @param floor - The permutation floor 1/(B+1) when the p value came from
 *   permutations; null for a parametric p.
 * @returns The text without the "p" symbol, for example "0.022",
 *   "\u2264 0.0002", or "< 0.001".
 */
export function formatP(p: number, floor: number | null = null): string {
  if (!Number.isFinite(p)) return MINUS
  if (floor !== null && p <= floor * (1 + 1e-9)) {
    return `${LE} ${significant(floor, 1)}`
  }
  if (p >= 0.995) return '1.00'
  if (p >= 0.1) return p.toFixed(2)
  if (p < 0.001) return '< 0.001'
  return significant(p, 2)
}

/**
 * Format a p value after its symbol: "= 0.022", "\u2264 0.0002", "< 0.001".
 *
 * @param floor - The permutation floor, or null.
 * @returns The relation and value.
 */
export function formatPRelation(
  p: number,
  floor: number | null = null,
): string {
  const text = formatP(p, floor)
  return /^[<\u2264]/.test(text) ? text : `= ${text}`
}

/** The short name of each correction, as a p column header reads it. */
export const CORRECTION_SHORT: Readonly<Record<Correction, string>> = {
  'maxt-fwe': 'FWE',
  holm: 'Holm',
  bonferroni: 'Bonferroni',
  'bh-fdr': 'FDR',
  none: '',
}

/** The long name of each correction, as the controls and summary read it. */
export const CORRECTION_LABEL: Readonly<Record<Correction, string>> = {
  'maxt-fwe': 'Permutation max-T FWE',
  holm: 'Holm',
  bonferroni: 'Bonferroni',
  'bh-fdr': 'Benjamini-Hochberg FDR',
  none: 'None',
}

/**
 * The permutation floor of the corrected p: only max-T FWE p values come
 * from permutations.
 *
 * @param permutations - B, the number of permutations.
 * @returns 1/(B+1) for max-T FWE, else null.
 */
export function correctedFloor(
  correction: Correction,
  permutations: number,
): number | null {
  return correction === 'maxt-fwe' ? permutationFloor(permutations) : null
}

/** Axis ticks with the step that produced them. */
export interface Ticks {
  ticks: number[]
  /** Minor ticks halfway between major ones. */
  minor: number[]
  step: number
  min: number
  max: number
}

/**
 * Choose round tick values that cover a range: steps of 1, 2, 2.5, or 5
 * times a power of ten, about `count` of them, and a domain padded to whole
 * steps.
 *
 * @param count - The wanted number of intervals.
 * @returns The ticks, halfway minor ticks, step, and padded domain.
 */
export function niceTicks(lo: number, hi: number, count = 5): Ticks {
  let min = Math.min(lo, hi)
  let max = Math.max(lo, hi)
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { ticks: [0, 1], minor: [0.5], step: 1, min: 0, max: 1 }
  }
  if (max - min < 1e-12) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1
    min -= pad
    max += pad
  }
  const raw = (max - min) / Math.max(1, count)
  const power = 10 ** Math.floor(Math.log10(raw))
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw * 0.999) ??
    10 * power
  const first = Math.floor(min / step + 1e-9) * step
  const last = Math.ceil(max / step - 1e-9) * step
  const ticks: number[] = []
  for (let v = first; v <= last + step * 1e-6; v += step) {
    ticks.push(Number(v.toFixed(12)))
  }
  const minor = ticks
    .slice(0, -1)
    .map((v) => Number((v + step / 2).toFixed(12)))
  return { ticks, minor, step, min: first, max: last }
}

/**
 * Format one tick with just enough decimals for its step.
 *
 * @returns The label with a typographic minus and thousands grouping.
 */
export function formatTick(value: number, step: number): string {
  const exact = String(Number(step.toFixed(10)))
  const digits = exact.includes('.') ? exact.split('.')[1]!.length : 0
  return Math.abs(value) >= 1000
    ? formatGrouped(value, digits)
    : formatFixed(value, digits)
}

const REGION_LABEL = new Map(DK_REGIONS.map((r) => [r.name, r.label]))

function capital(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

/**
 * Name a measure's correction family for a forest heading, for example
 * "Thickness" or "Subcortical and brainstem volume".
 *
 * @param family - The family key, for example `dk:ThickAvg`.
 */
export function familyLabel(family: string): string {
  if (family.startsWith('dk:')) {
    const metric = family.slice(3) as DkMetric
    return capital(DK_METRIC_LABELS[metric] ?? metric)
  }
  switch (family) {
    case 'aseg':
      return 'Subcortical and brainstem volume'
    case 'global':
      return 'Whole brain'
    case 'brainage':
      return 'Brain age'
  }
  // The v2 atlas families: parc:<atlas>:<metric> and vol:<atlas>.
  const [namespace, atlasId, metric] = family.split(':')
  const atlas = BUILT_IN_ATLASES.find((item) => item.atlasId === atlasId)
  const name = atlas?.label ?? atlasId
  if (namespace === 'parc' && atlasId && metric) {
    const label =
      metric === 'GWC'
        ? 'gray-white contrast'
        : (DK_METRIC_LABELS[metric as DkMetric] ?? metric)
    return `${capital(label)}, ${name}`
  }
  if (namespace === 'vol' && atlasId) return `Volume, ${name}`
  return family
}

/**
 * Name a measure under its family heading: the region or structure, with the
 * hemisphere when it is one side.
 *
 * @returns The short name, for example "Precentral, left".
 */
export function measureShortLabel(id: string): string {
  const parsed = parseMeasureId(id)
  if (!parsed) return id
  switch (parsed.source) {
    case 'dk': {
      const region = REGION_LABEL.get(parsed.region) ?? parsed.region
      if (parsed.hemisphere === 'bi') return region
      return `${region}, ${parsed.hemisphere === 'lh' ? 'left' : 'right'}`
    }
    case 'aseg':
      return measureLabel(id)
        .replace(/ volume \(bilateral mean\)$/, '')
        .replace(/ volume$/, '')
    default:
      return measureLabel(id)
  }
}

/**
 * Name a measure for a figure title, for example "Precentral thickness" or
 * "Brainstem".
 */
export function measureTitleName(id: string): string {
  const parsed = parseMeasureId(id)
  if (!parsed) return id
  if (parsed.source === 'dk') {
    const region = REGION_LABEL.get(parsed.region) ?? parsed.region
    const metric = DK_METRIC_LABELS[parsed.metric]
    if (parsed.hemisphere === 'bi') return `${region} ${metric}`
    const side = parsed.hemisphere === 'lh' ? 'Left' : 'Right'
    return `${side} ${region.charAt(0).toLowerCase()}${region.slice(1)} ${metric}`
  }
  return measureShortLabel(id)
}

/** The printed form of each measure unit. */
export const UNIT_TEXT: Readonly<Record<MeasureUnit, string>> = {
  mm: 'mm',
  mm2: 'mm\u00b2',
  mm3: 'mm\u00b3',
  '1/mm': '1/mm',
  '1/mm2': '1/mm\u00b2',
  count: 'vertices',
  index: 'index',
  percent: '%',
  years: 'years',
}

/**
 * Give a measure's printed unit.
 *
 * @returns The unit text, or an empty string for an invalid ID.
 */
export function measureUnitText(id: string): string {
  return parseMeasureId(id) ? UNIT_TEXT[measureUnit(id)] : ''
}

/**
 * Turn text into a lowercase file-name stem of `[a-z0-9-]`.
 *
 * @returns The stem, at most 48 characters, or "analysis".
 */
export function fileSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug || 'analysis'
}

/** One run of a signed-number text and the sign width to leave before it. */
export interface SignAlignedPart {
  text: string
  /** How many sign widths of space come before the run (0 or 1). */
  shift: number
}

/**
 * Split a text of signed numbers, such as `0.00 (\u22120.44 to +0.44)`, at
 * each unsigned number, which then takes a sign's width of space before it.
 * A column of such texts lines up, because the plus and minus signs share one
 * width, and the runs joined are the text unchanged.
 *
 * @returns The runs in order.
 */
export function signAlignedParts(text: string): SignAlignedPart[] {
  const parts: SignAlignedPart[] = []
  let last = 0
  let shift = 0
  for (const match of text.matchAll(/(^|[^\d.+\u2212])(\d)/g)) {
    const at = (match.index ?? 0) + (match[1]?.length ?? 0)
    if (at > last) {
      parts.push({ text: text.slice(last, at), shift })
      last = at
    }
    shift = 1
  }
  parts.push({ text: text.slice(last), shift })
  return parts
}
