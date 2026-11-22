import { describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Modal } from './Modal'
import { THEMES } from '../theme/tokens'

/**
 * Verify the shared modal contract. Cover accessible naming, guarded backdrop
 * dismissal, Tab trapping, focus movement, and zoom-safe scrolling.
 */

const t = THEMES.dark

/** Read the inert flag as a boolean, since jsdom does not reflect it. */
function isInert(element: HTMLElement): boolean {
  return element.inert === true
}

describe('Modal', () => {
  it('should render an accessible modal dialog with the given name', () => {
    render(
      <Modal t={t} onDismiss={vi.fn()} label="Test dialog">
        <button>Inside</button>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Test dialog' })
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('should dismiss on a backdrop click but not on a click inside the card', () => {
    const onDismiss = vi.fn()
    render(
      <Modal t={t} onDismiss={onDismiss} label="D">
        <button>Inside</button>
      </Modal>,
    )
    fireEvent.click(screen.getByRole('dialog'))
    expect(onDismiss).not.toHaveBeenCalled()
    const scrim = document.querySelector('[role="presentation"]') as HTMLElement
    fireEvent.click(scrim)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('should forward non-Tab keys to onKeyDown but handle Tab internally', () => {
    const onKeyDown = vi.fn()
    render(
      <Modal t={t} onDismiss={vi.fn()} label="D" onKeyDown={onKeyDown}>
        <button>Inside</button>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.keyDown(dialog, { key: 'Enter' })
    fireEvent.keyDown(dialog, { key: 'Tab' })
    const keys = onKeyDown.mock.calls.map((call) => call[0].key)
    expect(keys).toContain('Escape')
    expect(keys).toContain('Enter')
    expect(keys).not.toContain('Tab')
  })

  it('should make the scrim a scrollable fixed layer so a zoomed over-tall card stays reachable', () => {
    render(
      <Modal t={t} onDismiss={vi.fn()} label="D">
        <button>Inside</button>
      </Modal>,
    )
    const scrim = document.querySelector('[role="presentation"]') as HTMLElement
    const wrapper = scrim.firstElementChild as HTMLElement
    expect(scrim.style.overflowY).toBe('auto')
    expect(scrim.style.position).toBe('fixed')
    expect(wrapper.style.alignItems).toBe('safe center')
  })

  it('should bound the card to the real window height under text zoom', () => {
    const { unmount } = render(
      <Modal t={t} onDismiss={vi.fn()} label="Centered">
        <button>Inside</button>
      </Modal>,
    )
    const centered = screen.getByRole('dialog', { name: 'Centered' })
    // The zoomed root scales vh and the 32 px scrim padding alike, so divide
    // the window height by the zoom and subtract the unzoomed padding.
    expect(centered.style.maxHeight).toBe(
      'calc(100vh / var(--ss-zoom, 1) - 64px)',
    )
    expect(centered.style.overflow).toBe('auto')
    unmount()

    render(
      <Modal t={t} onDismiss={vi.fn()} label="Anchored" align="start">
        <button>Inside</button>
      </Modal>,
    )
    expect(
      screen.getByRole('dialog', { name: 'Anchored' }).style.maxHeight,
    ).toBe('calc(100vh / var(--ss-zoom, 1) - 112px)')
  })

  it('should let a caller card style replace the default bound', () => {
    render(
      <Modal
        t={t}
        onDismiss={vi.fn()}
        label="Palette"
        align="start"
        cardStyle={{ maxHeight: '60vh', overflow: 'hidden' }}
      >
        <button>Inside</button>
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Palette' })
    expect(dialog.style.maxHeight).toBe('60vh')
    expect(dialog.style.overflow).toBe('hidden')
  })

  it('should focus the initialFocusRef target on open', async () => {
    function Harness(): ReturnType<typeof Modal> {
      const ref = useRef<HTMLButtonElement | null>(null)
      return (
        <Modal t={t} onDismiss={vi.fn()} label="D" initialFocusRef={ref}>
          <button ref={ref}>Focus me</button>
          <button>Other</button>
        </Modal>
      )
    }
    render(<Harness />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Focus me' })).toHaveFocus(),
    )
  })

  it('should wrap around an explicitly tab-indexed disabled control', () => {
    render(
      <Modal t={t} onDismiss={vi.fn()} label="D">
        <button>First</button>
        <button disabled tabIndex={0}>
          Disabled boundary
        </button>
        <button>Last</button>
      </Modal>,
    )
    const first = screen.getByRole('button', { name: 'First' })
    const last = screen.getByRole('button', { name: 'Last' })
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
  })

  it('should make outside siblings inert and aria-hidden while open', () => {
    const outside = document.createElement('div')
    outside.textContent = 'Outside'
    document.body.appendChild(outside)
    const { unmount } = render(
      <Modal t={t} onDismiss={vi.fn()} label="D">
        <button>Inside</button>
      </Modal>,
    )
    expect(isInert(outside)).toBe(true)
    expect(outside).toHaveAttribute('aria-hidden', 'true')
    unmount()
    expect(isInert(outside)).toBe(false)
    expect(outside).not.toHaveAttribute('aria-hidden')
    outside.remove()
  })

  it('should restore a sibling to its own prior inert and aria-hidden values', () => {
    const outside = document.createElement('div')
    outside.inert = true
    outside.setAttribute('aria-hidden', 'false')
    document.body.appendChild(outside)
    const { unmount } = render(
      <Modal t={t} onDismiss={vi.fn()} label="D">
        <button>Inside</button>
      </Modal>,
    )
    expect(outside).toHaveAttribute('aria-hidden', 'true')
    unmount()
    expect(isInert(outside)).toBe(true)
    expect(outside).toHaveAttribute('aria-hidden', 'false')
    outside.remove()
  })

  it('should keep a sibling inert until the last nested modal closes', () => {
    const outside = document.createElement('div')
    outside.textContent = 'Outside'
    document.body.appendChild(outside)
    const outer = render(
      <Modal t={t} onDismiss={vi.fn()} label="Outer">
        <button>Outer body</button>
      </Modal>,
    )
    const inner = render(
      <Modal t={t} onDismiss={vi.fn()} label="Inner">
        <button>Inner body</button>
      </Modal>,
    )
    expect(isInert(outside)).toBe(true)
    inner.unmount()
    // The outer modal still needs the outside content inert.
    expect(isInert(outside)).toBe(true)
    expect(outside).toHaveAttribute('aria-hidden', 'true')
    outer.unmount()
    expect(isInert(outside)).toBe(false)
    expect(outside).not.toHaveAttribute('aria-hidden')
    outside.remove()
  })

  it('should leave the modal content itself reachable', () => {
    render(
      <Modal t={t} onDismiss={vi.fn()} label="D">
        <button>Inside</button>
      </Modal>,
    )
    const scrim = document.querySelector('[role="presentation"]') as HTMLElement
    expect(isInert(scrim)).toBe(false)
    expect(scrim).not.toHaveAttribute('aria-hidden')
    expect(screen.getByRole('button', { name: 'Inside' })).toBeInTheDocument()
  })

  it('should restore focus to the opener on unmount', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'opener'
    document.body.appendChild(opener)
    opener.focus()
    expect(opener).toHaveFocus()
    const { unmount } = render(
      <Modal t={t} onDismiss={vi.fn()} label="D">
        <button>Inside</button>
      </Modal>,
    )
    await waitFor(() => expect(opener).not.toHaveFocus())
    unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })
})
