import { act, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAvailableHeight } from './useAvailableHeight'

/** The mocked layout of the scroll area and the list, in viewport pixels. */
interface Layout {
  /** The scroll area's layout height in CSS pixels (clientHeight). */
  clientHeight: number
  /** The rendered-to-layout ratio of the text-scale zoom. */
  zoom: number
  scrollerTop: number
  scrollTop: number
  /** The list's top at scroll position 0, in viewport pixels. */
  listTop: number
}

let layout: Layout

function Harness(): ReactNode {
  const listRef = useAvailableHeight<HTMLDivElement>({
    minHeight: 200,
    trailing: 1,
  })
  return createElement(
    'div',
    {
      'data-testid': 'scroller',
      style: { overflow: 'auto', paddingBottom: '24px' },
    },
    createElement('div', { 'data-testid': 'list', ref: listRef }),
  )
}

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: 320,
    bottom: top + height,
    width: 320,
    height,
    toJSON: () => ({}),
  }
}

function resize(next: Partial<Layout>): void {
  layout = { ...layout, ...next }
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
}

beforeEach(() => {
  layout = {
    clientHeight: 558,
    zoom: 1,
    scrollerTop: 164,
    scrollTop: 0,
    listTop: 200,
  }
  const isScroller = (el: Element): boolean =>
    el instanceof HTMLElement && el.dataset.testid === 'scroller'
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      return isScroller(this) ? layout.clientHeight : 0
    },
  )
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      return isScroller(this) ? layout.clientHeight : 0
    },
  )
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(
    function (this: HTMLElement) {
      return isScroller(this) ? layout.scrollTop : 0
    },
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element) {
      if (isScroller(this)) {
        return rect(layout.scrollerTop, layout.clientHeight * layout.zoom)
      }
      // The list moves up with the page scroll, in rendered pixels.
      return rect(layout.listTop - layout.scrollTop * layout.zoom, 100)
    },
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useAvailableHeight', () => {
  it('fits the list to the scroll area and follows a resize', () => {
    render(createElement(Harness))
    const list = screen.getByTestId('list')
    // 558 visible, minus the 36 px above the list, the 24 px bottom padding,
    // and the 1 px trailing border.
    expect(list.style.maxHeight).toBe('497px')

    resize({ clientHeight: 400 })
    expect(list.style.maxHeight).toBe('339px')
  })

  it('keeps the minimum height on a short window', () => {
    render(createElement(Harness))
    resize({ clientHeight: 150 })
    expect(screen.getByTestId('list').style.maxHeight).toBe('200px')
  })

  it('measures from scroll position 0 while the page is scrolled', () => {
    layout.scrollTop = 120
    render(createElement(Harness))
    expect(screen.getByTestId('list').style.maxHeight).toBe('497px')
  })

  it('stays in CSS pixels under the text-scale zoom', () => {
    // At 135% text, 400 layout pixels render as 540, and the list starts
    // 107 rendered (79.3 layout) pixels below the scroll area's top.
    layout = {
      clientHeight: 400,
      zoom: 1.35,
      scrollerTop: 165.875,
      scrollTop: 0,
      listTop: 272.90625,
    }
    render(createElement(Harness))
    expect(screen.getByTestId('list').style.maxHeight).toBe('295px')
  })

  it('sets no maximum height when the page has no layout', () => {
    layout.clientHeight = 0
    render(createElement(Harness))
    expect(screen.getByTestId('list').style.maxHeight).toBe('')
  })
})
