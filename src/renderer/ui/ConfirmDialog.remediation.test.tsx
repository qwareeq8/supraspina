import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { THEMES } from '../theme/tokens'
import { ConfirmDialog } from './ConfirmDialog'

const t = THEMES.dark

describe('ConfirmDialog modal behavior', () => {
  it('names and describes the dialog and focuses the designated safe action', async () => {
    render(
      <ConfirmDialog
        t={t}
        title="Confirm generated-output deletion"
        message="Confirm permanent deletion before continuing."
        onDismiss={vi.fn()}
        actions={[
          { label: 'Stay', onSelect: vi.fn(), initialFocus: true },
          { label: 'Delete', onSelect: vi.fn(), tone: 'danger' },
        ]}
      />,
    )

    const dialog = screen.getByRole('dialog', {
      name: 'Confirm generated-output deletion',
    })
    const descriptionId = dialog.getAttribute('aria-describedby')
    expect(descriptionId).not.toBeNull()
    expect(document.getElementById(descriptionId ?? '')).toHaveTextContent(
      'Confirm permanent deletion before continuing.',
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Stay' })).toHaveFocus(),
    )
  })

  it('sets the title in the serif display face at 18 px', () => {
    render(
      <ConfirmDialog
        t={t}
        title="Run all 4 subjects?"
        message="Review the plan before it runs."
        onDismiss={vi.fn()}
        actions={[{ label: 'Cancel', onSelect: vi.fn() }]}
      />,
    )

    const title = screen.getByRole('heading', { name: 'Run all 4 subjects?' })
    expect(title.style.fontFamily).toContain('WebCM Serif 10')
    expect(title.style.fontSize).toBe('18px')
    expect(title.style.fontWeight).toBe('400')
  })

  it('leaves room below the message for sub-pixel text under zoom', () => {
    // At 135% text a message that fits can overflow by a fraction of a pixel
    // (scrollHeight 289 against clientHeight 288) and show a scroll track.
    // jsdom does no layout, so this checks the pixel that absorbs it.
    render(
      <ConfirmDialog
        t={t}
        title="Confirm the workflow launch"
        message="The plan is computed next."
        onDismiss={vi.fn()}
        actions={[{ label: 'Cancel', onSelect: vi.fn(), initialFocus: true }]}
      />,
    )

    const body = screen
      .getByText('The plan is computed next.')
      .closest('[data-dialog-body]') as HTMLElement
    expect(body.style.overflowY).toBe('auto')
    expect(body.style.paddingBottom).toBe('1px')
  })

  it('describes the dialog by a named part of a long message and an action by the footnote', () => {
    render(
      <ConfirmDialog
        t={t}
        title="Review the exact workflow plan."
        message={
          <>
            <p id="plan-lead">The plan is shown read-only.</p>
            <p>Every node, blocker, and resource of the plan.</p>
          </>
        }
        descriptionId="plan-lead"
        footnote="Authorize is unavailable because Allow live runs is off."
        onDismiss={vi.fn()}
        actions={[
          { label: 'Close', onSelect: vi.fn(), initialFocus: true },
          {
            label: 'Authorize',
            onSelect: vi.fn(),
            tone: 'primary',
            disabled: true,
            describedByFootnote: true,
          },
        ]}
      />,
    )

    const dialog = screen.getByRole('dialog', {
      name: 'Review the exact workflow plan.',
    })
    // Only the lead describes the dialog, not the whole plan or the footnote.
    expect(dialog).toHaveAccessibleDescription('The plan is shown read-only.')
    expect(
      screen.getByRole('button', { name: 'Authorize' }),
    ).toHaveAccessibleDescription(
      'Authorize is unavailable because Allow live runs is off.',
    )
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveAttribute(
      'aria-describedby',
    )
  })

  it('dismisses on Escape and backdrop clicks but not card clicks', () => {
    const onDismiss = vi.fn()
    render(
      <ConfirmDialog
        t={t}
        title="Confirm project exit"
        message="Review unsaved changes before leaving."
        onDismiss={onDismiss}
        actions={[{ label: 'Stay', onSelect: vi.fn(), initialFocus: true }]}
      />,
    )

    const dialog = screen.getByRole('dialog', {
      name: 'Confirm project exit',
    })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.click(dialog)
    expect(onDismiss).toHaveBeenCalledOnce()

    const backdrop = document.querySelector('[role="presentation"]')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop as HTMLElement)
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })

  it('traps keyboard focus and restores the opener when closed', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'Open confirmation'
    document.body.appendChild(opener)
    opener.focus()
    const view = render(
      <ConfirmDialog
        t={t}
        title="Confirm action"
        message="Choose an action."
        onDismiss={vi.fn()}
        actions={[
          { label: 'Stay', onSelect: vi.fn(), initialFocus: true },
          { label: 'Continue', onSelect: vi.fn(), tone: 'primary' },
        ]}
      />,
    )
    const stay = screen.getByRole('button', { name: 'Stay' })
    const proceed = screen.getByRole('button', { name: 'Continue' })
    await waitFor(() => expect(stay).toHaveFocus())

    proceed.focus()
    fireEvent.keyDown(proceed, { key: 'Tab' })
    expect(stay).toHaveFocus()
    fireEvent.keyDown(stay, { key: 'Tab', shiftKey: true })
    expect(proceed).toHaveFocus()

    view.unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('blocks dismissal and every action while busy', () => {
    const onDismiss = vi.fn()
    const onStay = vi.fn()
    const onContinue = vi.fn()
    render(
      <ConfirmDialog
        t={t}
        title="Confirm canceling active work"
        message="Wait for a terminal state."
        busy
        onDismiss={onDismiss}
        actions={[
          { label: 'Stay', onSelect: onStay, initialFocus: true },
          { label: 'Continue', onSelect: onContinue, tone: 'danger' },
        ]}
      />,
    )

    const dialog = screen.getByRole('dialog', {
      name: 'Confirm canceling active work',
    })
    const stay = screen.getByRole('button', { name: 'Stay' })
    const proceed = screen.getByRole('button', { name: 'Continue' })
    expect(stay).toBeDisabled()
    expect(proceed).toBeDisabled()
    fireEvent.click(stay)
    fireEvent.click(proceed)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.click(
      document.querySelector('[role="presentation"]') as HTMLElement,
    )

    expect(onStay).not.toHaveBeenCalled()
    expect(onContinue).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
