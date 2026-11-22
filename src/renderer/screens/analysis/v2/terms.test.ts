/** Tests for the v2 term helpers. */

import { describe, expect, it } from 'vitest'
import {
  MOCK_BATTERY_RESULT,
  MOCK_OMNIBUS_RESULT,
  MOCK_STRATIFIED_RESULT,
  mockTermRows,
} from '../../../ipc/mock-analysis-v2'
import {
  OUTSIDE_FAMILY_TEXT,
  correctionText,
  effectTermOf,
  initialTerm,
  isStratified,
  pairTerms,
  rowEffect,
  rowSize,
  rowStat,
  strataTerms,
  termEffect,
  termGroups,
  termShortLabel,
  termTitle,
} from './terms'

const term = (result: typeof MOCK_BATTERY_RESULT, id: string) =>
  result.terms.find((item) => item.termId === id)!
const rows = (result: typeof MOCK_BATTERY_RESULT, id: string) =>
  mockTermRows(result.resultId, id, 0).rows

describe('term effects', () => {
  it('shows eta squared for F, d for group terms, and r otherwise', () => {
    expect(
      termEffect(MOCK_OMNIBUS_RESULT, term(MOCK_OMNIBUS_RESULT, 'term-1')),
    ).toBe('eta2')
    expect(
      termEffect(MOCK_OMNIBUS_RESULT, term(MOCK_OMNIBUS_RESULT, 'term-2')),
    ).toBe('d')
    // The `ais` test compares two groups; `tsi` is an association.
    expect(
      termEffect(MOCK_BATTERY_RESULT, term(MOCK_BATTERY_RESULT, 'term-3')),
    ).toBe('d')
    expect(
      termEffect(MOCK_BATTERY_RESULT, term(MOCK_BATTERY_RESULT, 'term-1')),
    ).toBe('r')
    const hetero = MOCK_STRATIFIED_RESULT.terms.find(
      (t) => t.role === 'heterogeneity',
    )!
    expect(termEffect(MOCK_STRATIFIED_RESULT, hetero)).toBe('r')
  })

  it('reads a row effect, its statistic, and its size', () => {
    const [f] = rows(MOCK_OMNIBUS_RESULT, 'term-1')
    expect(rowEffect(f!, 'eta2')).toEqual({
      value: f!.partialEta2,
      low: null,
      high: null,
    })
    expect(rowStat(f!)).toBe(f!.F)
    expect(rowSize(f!)).toBeCloseTo(Math.sqrt(f!.F!))
    const [d] = rows(MOCK_OMNIBUS_RESULT, 'term-2')
    expect(rowEffect(d!, 'd')).toEqual({
      value: d!.d,
      low: d!.dLow,
      high: d!.dHigh,
    })
    expect(rowSize(d!)).toBe(Math.abs(d!.t!))
    const [r] = rows(MOCK_BATTERY_RESULT, 'term-1')
    expect(rowEffect(r!, 'r').value).toBe(r!.partialR)
  })
})

describe('term names and groups', () => {
  it('names omnibus, pair, stratum, and heterogeneity terms', () => {
    expect(
      termShortLabel(MOCK_OMNIBUS_RESULT, term(MOCK_OMNIBUS_RESULT, 'term-1')),
    ).toBe('Omnibus')
    expect(
      termShortLabel(MOCK_OMNIBUS_RESULT, term(MOCK_OMNIBUS_RESULT, 'term-2')),
    ).toBe('SCI_P vs CTRL')
    expect(
      termTitle(MOCK_OMNIBUS_RESULT, term(MOCK_OMNIBUS_RESULT, 'term-2')),
    ).toBe('SCI_P, SCI_nNP, and CTRL: SCI_P vs CTRL')
    const [pooled, female] = MOCK_STRATIFIED_RESULT.terms
    expect(termShortLabel(MOCK_STRATIFIED_RESULT, pooled!)).toBe(
      'SCI vs CTRL, pooled',
    )
    expect(termTitle(MOCK_STRATIFIED_RESULT, female!)).toBe(
      'SCI vs CTRL, Female',
    )
    const hetero = MOCK_STRATIFIED_RESULT.terms.find(
      (t) => t.role === 'heterogeneity',
    )!
    expect(termShortLabel(MOCK_STRATIFIED_RESULT, hetero)).toBe(
      'Heterogeneity across strata',
    )
    // A battery test has one term and is named by its test.
    expect(
      termTitle(MOCK_BATTERY_RESULT, term(MOCK_BATTERY_RESULT, 'term-3')),
    ).toBe('AIS A vs B-D')
  })

  it('groups terms by test, labeling only tests with several terms', () => {
    const battery = termGroups(MOCK_BATTERY_RESULT)
    expect(battery).toHaveLength(5)
    expect(battery.every((group) => group.label === null)).toBe(true)
    const [omnibus] = termGroups(MOCK_OMNIBUS_RESULT)
    expect(omnibus!.label).toBe('SCI_P, SCI_nNP, and CTRL')
    expect(omnibus!.terms.map((t) => t.termId)).toEqual([
      'term-1',
      'term-2',
      'term-3',
      'term-4',
    ])
  })

  it('finds pairs, the omnibus term, and the strata of a term', () => {
    const pair = term(MOCK_OMNIBUS_RESULT, 'term-3')
    expect(pairTerms(MOCK_OMNIBUS_RESULT, pair).map((t) => t.termId)).toEqual([
      'term-2',
      'term-3',
      'term-4',
    ])
    expect(effectTermOf(MOCK_OMNIBUS_RESULT, pair)?.termId).toBe('term-1')
    expect(isStratified(MOCK_OMNIBUS_RESULT)).toBe(false)
    expect(strataTerms(MOCK_OMNIBUS_RESULT, pair).strata).toEqual([])
    const female = MOCK_STRATIFIED_RESULT.terms[1]!
    const strata = strataTerms(MOCK_STRATIFIED_RESULT, female)
    expect(strata.pooled?.termId).toBe('term-1')
    expect(strata.strata.map((t) => t.stratum)).toEqual(['Female', 'Male'])
    expect(strata.heterogeneity?.termId).toBe('term-4')
  })

  it('opens on the kept term, else the first', () => {
    expect(initialTerm(MOCK_OMNIBUS_RESULT, 'term-3')).toBe('term-3')
    expect(initialTerm(MOCK_OMNIBUS_RESULT, 'term-9')).toBe('term-1')
    expect(initialTerm(MOCK_OMNIBUS_RESULT, null)).toBe('term-1')
  })
})

describe('correction text', () => {
  it('names the correction and family, or the sensitivity fact', () => {
    expect(
      correctionText(MOCK_BATTERY_RESULT, term(MOCK_BATTERY_RESULT, 'term-1')),
    ).toBe(OUTSIDE_FAMILY_TEXT)
    expect(
      correctionText(MOCK_BATTERY_RESULT, term(MOCK_BATTERY_RESULT, 'term-2')),
    ).toBe('FDR, one family over the tests')
    expect(
      correctionText(MOCK_OMNIBUS_RESULT, term(MOCK_OMNIBUS_RESULT, 'term-2')),
    ).toBe('FWE, over the pairs')
    const hetero = MOCK_STRATIFIED_RESULT.terms.find(
      (t) => t.role === 'heterogeneity',
    )!
    expect(correctionText(MOCK_STRATIFIED_RESULT, hetero)).toBe(
      'FWE, over the measures',
    )
  })
})
