/** Tests for the figure number formatting. */

import { describe, expect, it } from 'vitest'
import { formatEstimate, formatInterval, signAlignedParts } from './format'

describe('formatEstimate', () => {
  it('prints an estimate and its interval as the forest does', () => {
    expect(formatEstimate(-0.684, -1.121, -0.239, 2)).toBe(
      '\u22120.68 (\u22121.12 to \u22120.24)',
    )
    expect(formatEstimate(0.31, -0.2, 0.82, 2)).toBe(
      '+0.31 (\u22120.20 to +0.82)',
    )
    expect(formatEstimate(0.31, null, 0.82, 2)).toBe('+0.31')
  })

  it('leaves an effect that cannot be negative unsigned', () => {
    expect(formatEstimate(0.123, 0.01, 0.25, 3, false)).toBe(
      '0.123 (0.010 to 0.250)',
    )
    expect(formatInterval(0.01, 0.25, 3, false)).toBe('0.010 to 0.250')
    expect(formatInterval(null, 0.25, 3)).toBeNull()
  })
})

describe('signAlignedParts', () => {
  it('shifts each unsigned number by one sign width', () => {
    expect(signAlignedParts('0.00 (\u22120.44 to +0.44)')).toEqual([
      { text: '0.00 (\u22120.44 to +0.44)', shift: 1 },
    ])
    expect(signAlignedParts('+0.31 (\u22120.20 to 0.00)')).toEqual([
      { text: '+0.31 (\u22120.20 to ', shift: 0 },
      { text: '0.00)', shift: 1 },
    ])
  })

  it('leaves signed and empty texts whole', () => {
    expect(signAlignedParts('+0.31 (\u22120.20 to +0.82)')).toEqual([
      { text: '+0.31 (\u22120.20 to +0.82)', shift: 0 },
    ])
    expect(signAlignedParts('\u2212')).toEqual([{ text: '\u2212', shift: 0 }])
  })
})
