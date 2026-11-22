import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { trapTab } from './focusTrap'

/**
 * Verify the modal focus trap with attached controls and synthetic Tab events.
 * Remove appended nodes after every test to preserve isolation.
 */

const appended: HTMLElement[] = []

/** Build a root element with three focusable buttons. */
function mountRoot(): {
  root: HTMLDivElement
  buttons: [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement]
} {
  const root = document.createElement('div')
  const make = (i: number): HTMLButtonElement => {
    const button = document.createElement('button')
    button.textContent = `btn-${i}`
    root.appendChild(button)
    return button
  }
  const buttons: [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement] = [
    make(0),
    make(1),
    make(2),
  ]
  document.body.appendChild(root)
  appended.push(root)
  return { root, buttons }
}

/** Build a synthetic Tab event stub. */
function tabEvent(shiftKey: boolean): {
  event: ReactKeyboardEvent
  preventDefault: ReturnType<typeof vi.fn>
} {
  const preventDefault = vi.fn()
  const event = {
    key: 'Tab',
    shiftKey,
    preventDefault,
  } as unknown as ReactKeyboardEvent
  return { event, preventDefault }
}

afterEach(() => {
  while (appended.length > 0) {
    const node = appended.pop()
    node?.remove()
  }
})

describe('trapTab', () => {
  it('should return without throwing when root is null', () => {
    const { event, preventDefault } = tabEvent(false)
    expect(() => trapTab(event, null)).not.toThrow()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('should return early when the root has no focusables', () => {
    const root = document.createElement('div')
    root.appendChild(document.createElement('span'))
    document.body.appendChild(root)
    appended.push(root)
    const { event, preventDefault } = tabEvent(false)
    expect(() => trapTab(event, root)).not.toThrow()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('should wrap forward Tab from the last focusable to the first', () => {
    const { root, buttons } = mountRoot()
    buttons[2].focus()
    expect(document.activeElement).toBe(buttons[2])
    const { event, preventDefault } = tabEvent(false)
    trapTab(event, root)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(buttons[0])
  })

  it('should not act on forward Tab when focus is not on the last focusable', () => {
    const { root, buttons } = mountRoot()
    buttons[1].focus()
    const { event, preventDefault } = tabEvent(false)
    trapTab(event, root)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(buttons[1])
  })

  it('should ignore programmatic-only controls when finding the Tab boundary', () => {
    const { root, buttons } = mountRoot()
    buttons[1].tabIndex = -1
    buttons[2].tabIndex = -1
    buttons[0].focus()
    const { event, preventDefault } = tabEvent(false)
    trapTab(event, root)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(buttons[0])
  })

  it('should treat a disclosure summary as a Tab boundary', () => {
    const { root, buttons } = mountRoot()
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = 'Technical details'
    details.appendChild(summary)
    root.insertBefore(details, buttons[0])
    summary.focus()
    expect(document.activeElement).toBe(summary)
    const { event, preventDefault } = tabEvent(true)
    trapTab(event, root)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(buttons[2])
  })

  it('should wrap backward Shift+Tab from the first focusable to the last', () => {
    const { root, buttons } = mountRoot()
    buttons[0].focus()
    expect(document.activeElement).toBe(buttons[0])
    const { event, preventDefault } = tabEvent(true)
    trapTab(event, root)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(buttons[2])
  })

  it('should not act on backward Shift+Tab when focus is not on the first focusable', () => {
    const { root, buttons } = mountRoot()
    buttons[1].focus()
    const { event, preventDefault } = tabEvent(true)
    trapTab(event, root)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(buttons[1])
  })

  it('should wrap backward to the last focusable when the active element is outside the root', () => {
    const { root, buttons } = mountRoot()
    const outside = document.createElement('button')
    outside.textContent = 'outside'
    document.body.appendChild(outside)
    appended.push(outside)
    outside.focus()
    expect(document.activeElement).toBe(outside)
    const { event, preventDefault } = tabEvent(true)
    trapTab(event, root)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(buttons[2])
  })

  it('should wrap forward to the first focusable when the active element is outside the root', () => {
    const { root, buttons } = mountRoot()
    const outside = document.createElement('button')
    outside.textContent = 'outside'
    document.body.appendChild(outside)
    appended.push(outside)
    outside.focus()
    expect(document.activeElement).toBe(outside)
    const { event, preventDefault } = tabEvent(false)
    trapTab(event, root)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(buttons[0])
  })
})
