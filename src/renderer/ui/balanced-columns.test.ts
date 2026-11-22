/** Tests for the balanced tile-band column count. */

import { describe, expect, it } from 'vitest'
import { balancedColumns } from './balanced-columns'

describe('balancedColumns', () => {
  it('keeps every tile on one row when the band fits them', () => {
    expect(balancedColumns(1172, 8, 136, 12)).toBe(8)
  })

  it('splits a wrapped band into even rows', () => {
    // 7 fit at the 1100 px minimum window and 6 at 1000 px: 4 + 4, not
    // 7 + 1 or 6 + 2.
    expect(balancedColumns(1039, 8, 136, 12)).toBe(4)
    expect(balancedColumns(900, 8, 136, 12)).toBe(4)
    expect(balancedColumns(1039, 9, 136, 12)).toBe(5)
  })

  it('draws at least one column', () => {
    expect(balancedColumns(50, 8, 136, 12)).toBe(1)
    expect(balancedColumns(1000, 0, 136, 12)).toBe(1)
  })
})
