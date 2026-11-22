import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  HIDDEN_EDGE_TOLERANCE,
  hiddenEdgesOf,
  useHiddenEdges,
} from './useHiddenEdges'

/** Build a scroll area whose horizontal metrics the test controls. */
function scrollArea(scrollWidth: number, clientWidth: number): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth })
  Object.defineProperty(el, 'clientWidth', { value: clientWidth })
  return el
}

describe('hiddenEdgesOf', () => {
  it('reports hidden content past each side of a scroll area', () => {
    expect(
      hiddenEdgesOf({ scrollLeft: 0, scrollWidth: 628, clientWidth: 483 }),
    ).toEqual({ left: false, right: true })
    expect(
      hiddenEdgesOf({ scrollLeft: 60, scrollWidth: 628, clientWidth: 483 }),
    ).toEqual({ left: true, right: true })
    expect(
      hiddenEdgesOf({ scrollLeft: 145, scrollWidth: 628, clientWidth: 483 }),
    ).toEqual({ left: true, right: false })
  })

  it('reads a far end short by fractional-zoom rounding as reached', () => {
    // At the 135% text scale on a 1x display, one device pixel is 0.74 CSS
    // pixels and both widths round to whole pixels, so the end can stop 1.7
    // pixels short of the rounded maximum.
    expect(
      hiddenEdgesOf({
        scrollLeft: 143.26,
        scrollWidth: 628,
        clientWidth: 483,
      }),
    ).toEqual({ left: true, right: false })
    expect(
      hiddenEdgesOf({ scrollLeft: 1.48, scrollWidth: 628, clientWidth: 483 }),
    ).toEqual({ left: false, right: true })
  })

  it('keeps the end hint while more than the tolerance stays hidden', () => {
    const scrollLeft = 145 - HIDDEN_EDGE_TOLERANCE - 0.5
    expect(
      hiddenEdgesOf({ scrollLeft, scrollWidth: 628, clientWidth: 483 }).right,
    ).toBe(true)
  })
})

describe('useHiddenEdges', () => {
  it('updates the edges from the attached element on scroll', () => {
    const el = scrollArea(628, 483)
    const { result } = renderHook(() => useHiddenEdges())
    expect(result.current[0]).toEqual({ left: false, right: false })

    act(() => result.current[1](el))
    expect(result.current[0]).toEqual({ left: false, right: true })

    act(() => {
      el.scrollLeft = 144
      el.dispatchEvent(new Event('scroll'))
    })
    expect(result.current[0]).toEqual({ left: true, right: false })
  })
})
