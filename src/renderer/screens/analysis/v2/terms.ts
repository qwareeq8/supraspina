/**
 * What the v2 results view reads from a result's terms: how to name and
 * group them for the term selector, which effect each one shows (d,
 * partial r, or partial eta squared), its sibling terms (an omnibus test's
 * pairs, a stratified test's strata), and the text of its correction.
 */

import {
  type AnalysisTest,
  type GroupAnalysisResultV2,
  type GroupAnalysisRowV2,
  type GroupAnalysisTerm,
} from '../../../../shared/group-analysis'
import { CORRECTION_SHORT } from '../../../figures/format'

/** The text a sensitivity row carries in place of a corrected p. */
export const OUTSIDE_FAMILY_TEXT = 'Sensitivity, outside the family'

/** The effect a term's cells, forest, and grid show. */
export type TermEffect = 'd' | 'r' | 'eta2'

/**
 * Find the test a term belongs to.
 *
 * @returns The test, or null when the spec lacks it.
 */
export function termTest(
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
): AnalysisTest | null {
  return result.spec.tests.find((test) => test.id === term.testId) ?? null
}

/**
 * Give the effect a term shows: partial eta squared for an F term, d for a
 * two-group or pairwise contrast, and partial r otherwise (an association,
 * a slope difference, or a heterogeneity test). Main's grid CSV decides
 * the same way.
 */
export function termEffect(
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
): TermEffect {
  if (term.kind === 'F') return 'eta2'
  if (term.role === 'pairwise') return 'd'
  if (term.role === 'heterogeneity') return 'r'
  return termTest(result, term)?.kind === 'two-group' ? 'd' : 'r'
}

/** One effect with its 95% CI, when it has one. */
export interface EffectValue {
  value: number | null
  low: number | null
  high: number | null
}

/**
 * Read a row's effect.
 *
 * @returns The value and its CI; partial eta squared has no CI.
 */
export function rowEffect(
  row: GroupAnalysisRowV2,
  effect: TermEffect,
): EffectValue {
  if (effect === 'd' && row.d !== null) {
    return { value: row.d, low: row.dLow, high: row.dHigh }
  }
  if (effect === 'eta2') {
    return { value: row.partialEta2, low: null, high: null }
  }
  return { value: row.partialR, low: row.partialRLow, high: row.partialRHigh }
}

/**
 * Give a row's test statistic: t for a t row, F for an F row.
 *
 * @returns The statistic, or NaN when the row lacks it.
 */
export function rowStat(row: GroupAnalysisRowV2): number {
  return row.t ?? row.F ?? Number.NaN
}

/**
 * Size a row's effect for ranking (the top rows of a forest or brain map).
 *
 * @returns |t|, or sqrt(F) for an F row.
 */
export function rowSize(row: GroupAnalysisRowV2): number {
  if (row.t !== null) return Math.abs(row.t)
  return row.F !== null ? Math.sqrt(Math.max(0, row.F)) : 0
}

/** True when the result reruns its tests per stratum. */
export function isStratified(result: GroupAnalysisResultV2): boolean {
  return result.spec.stratify !== null
}

/**
 * Name a term within its test: the stratum, the pair, "Omnibus", or the
 * heterogeneity test.
 *
 * @returns The short name, for example "SCI_P vs CTRL, North".
 */
export function termShortLabel(
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
): string {
  const where = term.stratum ?? (isStratified(result) ? 'pooled' : null)
  const suffix = where ? `, ${where}` : ''
  if (term.role === 'heterogeneity') return 'Heterogeneity across strata'
  if (term.role === 'pairwise' && term.pair) {
    return `${term.pair.focal} vs ${term.pair.reference}${suffix}`
  }
  const test = termTest(result, term)
  if (test?.kind === 'omnibus') return `Omnibus${suffix}`
  if (test?.kind === 'interaction' && term.kind === 'F') {
    return `Slope difference${suffix}`
  }
  return `${term.label}${suffix}`
}

/**
 * Name a term in full: its test and, when the test has several terms, the
 * term within it.
 *
 * @returns The name, for example "Cohort: SCI_P vs CTRL".
 */
export function termTitle(
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
): string {
  const siblings = result.terms.filter((item) => item.testId === term.testId)
  const testLabel = termTest(result, term)?.label ?? term.label
  if (siblings.length <= 1) return testLabel
  const short = termShortLabel(result, term)
  return short.startsWith(testLabel) ? short : `${testLabel}: ${short}`
}

/** The terms of one test, for an option group of the term selector. */
export interface TermGroup {
  testId: string
  /** The test's label, or null for a test with one term. */
  label: string | null
  terms: GroupAnalysisTerm[]
}

/**
 * Group a result's terms by test, in term order.
 *
 * @returns One group per test.
 */
export function termGroups(result: GroupAnalysisResultV2): TermGroup[] {
  const groups: TermGroup[] = []
  for (const term of result.terms) {
    let group = groups.find((item) => item.testId === term.testId)
    if (!group) {
      group = { testId: term.testId, label: null, terms: [] }
      groups.push(group)
    }
    group.terms.push(term)
  }
  for (const group of groups) {
    if (group.terms.length > 1) {
      group.label =
        result.spec.tests.find((test) => test.id === group.testId)?.label ??
        group.terms[0]!.label
    }
  }
  return groups
}

/**
 * List the pairwise terms after an omnibus test, in the same stratum.
 *
 * @returns The pairs; empty for a test without them.
 */
export function pairTerms(
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
): GroupAnalysisTerm[] {
  return result.terms.filter(
    (item) =>
      item.testId === term.testId &&
      item.role === 'pairwise' &&
      item.stratum === term.stratum,
  )
}

/**
 * Find the omnibus (effect) term a pairwise term follows.
 *
 * @returns The effect term of the same test and stratum, or null.
 */
export function effectTermOf(
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
): GroupAnalysisTerm | null {
  return (
    result.terms.find(
      (item) =>
        item.testId === term.testId &&
        item.role === 'effect' &&
        item.stratum === term.stratum,
    ) ?? null
  )
}

/** A stratified test's terms: the pooled one, each stratum, heterogeneity. */
export interface StrataTerms {
  pooled: GroupAnalysisTerm | null
  strata: GroupAnalysisTerm[]
  heterogeneity: GroupAnalysisTerm | null
}

/**
 * List the terms a stratified test's view compares: for the term's role and
 * pair, the pooled term and each stratum's, with the test's heterogeneity
 * term.
 *
 * @returns The terms; no strata outside a stratified result.
 */
export function strataTerms(
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
): StrataTerms {
  const role = term.role === 'heterogeneity' ? 'effect' : term.role
  const same = (item: GroupAnalysisTerm): boolean =>
    item.testId === term.testId &&
    item.role === role &&
    (item.pair?.focal ?? null) === (term.pair?.focal ?? null) &&
    (item.pair?.reference ?? null) === (term.pair?.reference ?? null)
  return {
    pooled: result.terms.find((item) => same(item) && !item.stratum) ?? null,
    strata: isStratified(result)
      ? result.terms.filter((item) => same(item) && item.stratum !== null)
      : [],
    heterogeneity:
      result.terms.find(
        (item) => item.testId === term.testId && item.role === 'heterogeneity',
      ) ?? null,
  }
}

/** The correction family settings, as a phrase after the correction name. */
const FAMILY_TEXT = {
  'all-tests': 'one family over the tests',
  'per-test': 'within each test',
  'per-measure-family': 'within each measure family',
  'per-test-and-measure-family': 'within each test and measure family',
} as const

/**
 * Say how a term's p values are corrected.
 *
 * @returns A phrase such as "FDR, one family over the tests", or the
 *   sensitivity text for a term outside the family.
 */
export function correctionText(
  result: GroupAnalysisResultV2,
  term: GroupAnalysisTerm,
): string {
  const { correction, family } = result.spec.inference
  if (term.family === null) return OUTSIDE_FAMILY_TEXT
  if (correction === 'none') return 'Uncorrected'
  const short = CORRECTION_SHORT[correction]
  if (term.role === 'pairwise') return `${short}, over the pairs`
  if (term.role === 'heterogeneity') return `${short}, over the measures`
  return `${short}, ${FAMILY_TEXT[family]}`
}

/**
 * Choose the term a result opens on: the kept term when the result has it,
 * else the first.
 *
 * @returns The term ID, or null for a result without terms.
 */
export function initialTerm(
  result: GroupAnalysisResultV2,
  current: string | null,
): string | null {
  if (current && result.terms.some((term) => term.termId === current)) {
    return current
  }
  return result.terms[0]?.termId ?? null
}
