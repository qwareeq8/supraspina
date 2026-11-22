import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { THEMES } from '../theme/tokens'
import { RecoveryReviewProvider } from './recovery-review'
import { useRecoveryReview } from './recovery-review-state'

vi.mock('./context', () => ({
  useApp: () => ({ t: THEMES.dark, projectEpoch: 3 }),
}))

function Probe({
  onResult,
  remainingSubjectCount = 3,
}: {
  onResult: (choice: string) => void
  remainingSubjectCount?: number
}): ReactNode {
  const review = useRecoveryReview()
  return (
    <button
      type="button"
      onClick={() => {
        void review
          .choose(['sub-001', 'sub-012'], remainingSubjectCount)
          .then(onResult)
      }}
    >
      Recover
    </button>
  )
}

describe('recovery acknowledgment review', () => {
  it('shows exact source-scope IDs and returns each explicit choice', async () => {
    const onResult = vi.fn()
    render(
      <RecoveryReviewProvider>
        <Probe onResult={onResult} />
      </RecoveryReviewProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Recover' }))
    const dialog = screen.getByRole('dialog', {
      name: 'Choose how to handle subjects without a Pass verdict',
    })
    // The dialog leads with the fact, not an order or internal terms.
    expect(dialog).toHaveAccessibleDescription(
      /^These subjects of the run have no Pass verdict; each is Defer or unreviewed:\s*sub-001, sub-012/,
    )
    expect(dialog).not.toHaveTextContent(/source-run|fresh QC recovery/)
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Cancel recovery' }),
      ).toHaveFocus()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Include and re-plan' }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('include'))

    fireEvent.click(screen.getByRole('button', { name: 'Recover' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Exclude and continue' }),
    )
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith('exclude'))
  })

  it('offers Exclude and continue while reviewed Pass subjects would remain', () => {
    render(
      <RecoveryReviewProvider>
        <Probe onResult={vi.fn()} remainingSubjectCount={1} />
      </RecoveryReviewProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Recover' }))

    expect(
      screen.getByRole('button', { name: 'Exclude and continue' }),
    ).toBeEnabled()
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Include and re-plan keeps them in the plan. Exclude and continue keeps only the 1 subject with a Pass verdict.',
    )
  })

  it('disables Exclude and continue with its reason when no subject would remain', () => {
    const onResult = vi.fn()
    render(
      <RecoveryReviewProvider>
        <Probe onResult={onResult} remainingSubjectCount={0} />
      </RecoveryReviewProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Recover' }))

    const exclude = screen.getByRole('button', { name: 'Exclude and continue' })
    expect(exclude).toBeDisabled()
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Include and re-plan keeps them in the plan. Exclude and continue is unavailable because no subject with a Pass verdict would remain.',
    )
    expect(
      screen.getByRole('button', { name: 'Include and re-plan' }),
    ).toBeEnabled()
    fireEvent.click(exclude)
    expect(onResult).not.toHaveBeenCalled()
  })

  it('treats Escape as canceling recovery', async () => {
    const onResult = vi.fn()
    render(
      <RecoveryReviewProvider>
        <Probe onResult={onResult} />
      </RecoveryReviewProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Recover' }))

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    await waitFor(() => expect(onResult).toHaveBeenCalledWith('cancel'))
  })
})
