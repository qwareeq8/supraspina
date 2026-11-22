import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AppProvider } from '../state/context'
import { FirstRunDialog } from './FirstRunDialog'

function renderDialog(): ReturnType<typeof render> {
  return render(
    <AppProvider>
      <FirstRunDialog />
    </AppProvider>,
  )
}

afterEach(() => localStorage.clear())

describe('FirstRunDialog', () => {
  it('focuses its heading and applies display/accessibility choices live', async () => {
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: 'Welcome to Supraspina' })
    const heading = screen.getByRole('heading', {
      name: 'Welcome to Supraspina',
    })
    await waitFor(() => expect(heading).toHaveFocus())

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Comfortable' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Triage' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Notebook' }))
    fireEvent.click(screen.getByRole('radio', { name: '135%' }))
    fireEvent.click(
      screen.getByRole('switch', { name: 'Pipeline command previews' }),
    )
    fireEvent.click(screen.getByRole('switch', { name: 'Reduced motion' }))
    fireEvent.click(screen.getByRole('switch', { name: 'High contrast' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Allow live runs' }))

    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('radio', { name: '135%' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(
      screen.getByRole('switch', { name: 'Reduced motion' }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(dialog).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(localStorage.getItem('supraspinaFirstRunDone')).toBe('1')
  })

  it('groups Allow live runs under its own Running heading', () => {
    renderDialog()
    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent)
    expect(headings).toEqual([
      'Display and behavior',
      'Accessibility',
      'Running',
    ])
  })

  it('uses defaults and dismisses without forcing onboarding choices', () => {
    localStorage.setItem(
      'supraspinaMockMachinePreferences',
      JSON.stringify({ theme: 'light', textScale: '135', highContrast: true }),
    )
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Use defaults' }))
    expect(localStorage.getItem('supraspinaFirstRunDone')).toBe('1')
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('radio', { name: '100%' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('supports Escape and backdrop dismissal through the shared modal', () => {
    const first = renderDialog()
    const firstDialog = screen.getByRole('dialog', {
      name: 'Welcome to Supraspina',
    })
    fireEvent.keyDown(firstDialog, { key: 'ArrowDown' })
    expect(localStorage.getItem('supraspinaFirstRunDone')).toBeNull()
    fireEvent.keyDown(firstDialog, { key: 'Escape' })
    expect(localStorage.getItem('supraspinaFirstRunDone')).toBe('1')
    first.unmount()

    localStorage.removeItem('supraspinaFirstRunDone')
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: 'Welcome to Supraspina' })
    fireEvent.click(dialog.parentElement!.parentElement!)
    expect(localStorage.getItem('supraspinaFirstRunDone')).toBe('1')
  })
})
