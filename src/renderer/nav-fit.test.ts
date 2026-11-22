import { describe, expect, it } from 'vitest'
import { navFitCount } from './nav-fit'

const TABS = [90, 90, 90, 90, 90, 90]
const base = { tabs: TABS, gap: 2, trigger: 80 }

describe('navFitCount', () => {
  it('draws every tab when the whole row fits without a trigger', () => {
    // Six tabs and five gaps need 550.
    expect(navFitCount({ ...base, available: 550 })).toBe(6)
    expect(navFitCount({ ...base, available: 2_000 })).toBe(6)
  })

  it('reserves the trigger as soon as one tab has to move', () => {
    // Five tabs with their gaps and the trigger need 540.
    expect(navFitCount({ ...base, available: 549 })).toBe(5)
    expect(navFitCount({ ...base, available: 540 })).toBe(5)
    expect(navFitCount({ ...base, available: 539 })).toBe(4)
  })

  it('never grows as the row narrows and keeps one tab at the least', () => {
    let previous = TABS.length
    for (let available = 700; available > 0; available -= 1) {
      const count = navFitCount({ ...base, available })
      expect(count).toBeLessThanOrEqual(previous)
      expect(count).toBeGreaterThanOrEqual(1)
      previous = count
    }
    expect(previous).toBe(1)
  })

  it('draws every tab while the row has no measured layout', () => {
    expect(navFitCount({ ...base, available: 0 })).toBe(6)
    expect(navFitCount({ ...base, tabs: [0, 0, 0], available: 500 })).toBe(3)
  })
})
