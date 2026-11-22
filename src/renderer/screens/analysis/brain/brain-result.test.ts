import { describe, expect, it } from 'vitest'
import {
  MOCK_BATTERY_RESULT,
  MOCK_OMNIBUS_RESULT,
} from '../../../ipc/mock-analysis-v2'
import { MOCK_ANALYSIS_RESULT } from '../../../ipc/mock-group-analysis'
import { brainResultText } from './brain-result'

describe('brain result text', () => {
  it('reads a v1 contrast', () => {
    const text = brainResultText(MOCK_ANALYSIS_RESULT)
    expect(text.negative).toBe('Smaller in SCI')
    expect(text.positive).toBe('Larger in SCI')
    expect(text.contrast[0]).toBe('SCI (')
    expect(text.correction[0]).toBe('outlined: ')
  })

  it('reads a v2 term: an association, a subgroup, and a pair', () => {
    const battery = brainResultText(MOCK_BATTERY_RESULT)
    expect([battery.negative, battery.positive]).toEqual([
      'Negative association',
      'Positive association',
    ])
    expect(battery.contrast).toEqual([
      'Time since injury, ',
      { i: 'n' },
      ` = ${MOCK_BATTERY_RESULT.sample.included}`,
    ])
    // The battery opens on its sensitivity term, which nothing outlines.
    expect(battery.correction).toEqual([
      'not outlined: a sensitivity term, outside the correction family',
    ])
    const log = MOCK_BATTERY_RESULT.terms.find((t) => t.termId === 'term-2')!
    expect(brainResultText(MOCK_BATTERY_RESULT, log, 12).correction).toEqual([
      'outlined: ',
      'FDR ',
      { i: 'p' },
      ' < 0.05 over the 12 measures of this term',
    ])
    const ais = MOCK_BATTERY_RESULT.terms.find((t) => t.testId === 'ais')!
    expect(brainResultText(MOCK_BATTERY_RESULT, ais, 1).negative).toBe(
      'Smaller in AIS A',
    )
    const pair = MOCK_OMNIBUS_RESULT.terms.find((t) => t.pair !== null)!
    expect(brainResultText(MOCK_OMNIBUS_RESULT, pair).positive).toBe(
      `Larger in ${pair.pair!.focal}`,
    )
    const omnibus = MOCK_OMNIBUS_RESULT.terms.find((t) => t.kind === 'F')!
    expect(brainResultText(MOCK_OMNIBUS_RESULT, omnibus).negative).toBe(
      'Negative',
    )
  })

  it('says when a v2 result is uncorrected', () => {
    const uncorrected = {
      ...MOCK_BATTERY_RESULT,
      spec: {
        ...MOCK_BATTERY_RESULT.spec,
        inference: {
          ...MOCK_BATTERY_RESULT.spec.inference,
          correction: 'none' as const,
        },
      },
    }
    expect(brainResultText(uncorrected).correction).toEqual([
      'outlined: ',
      { i: 'p' },
      ' < 0.05 uncorrected',
    ])
  })
})
