/**
 * Tests for the shared stage-blocker list. Cover the singular and plural
 * disclosure labels, the collapsed-occurrence count, the restated readiness
 * reasons, and the Registry recovery action a blocker can offer.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { StageBlockerList } from './StageBlockerList'
import { OPEN_REGISTRY_ACTION } from '../state/execution-feedback'
import type { ReviewBlockerLine } from '../state/workflow-review-state'
import { pipelineStep } from '../../shared/steps'
import { THEMES } from '../theme/tokens'

const t = THEMES.dark

/** Build one deduplicated blocker line. */
function line(patch: Partial<ReviewBlockerLine> = {}): ReviewBlockerLine {
  return {
    key: 'recon',
    reason: 'Recon-all needs a defaced input.',
    count: 1,
    subjects: [],
    ...patch,
  }
}

describe('StageBlockerList', () => {
  it('names one affected subject in the singular', () => {
    render(
      <StageBlockerList t={t} lines={[line({ subjects: ['sub-0001'] })]} />,
    )
    expect(screen.getByText('Show the affected subject')).toBeInTheDocument()
    expect(screen.queryByText(/Show all/)).not.toBeInTheDocument()
  })

  it('counts the affected subjects when more than one is blocked', () => {
    render(
      <StageBlockerList
        t={t}
        lines={[line({ subjects: ['sub-0001', 'sub-0002', 'sub-0003'] })]}
      />,
    )
    expect(screen.getByText('Show all 3 subjects')).toBeInTheDocument()
  })

  it('lists every affected subject behind the disclosure', () => {
    render(
      <StageBlockerList
        t={t}
        lines={[line({ subjects: ['sub-0001', 'sub-0002'] })]}
      />,
    )
    fireEvent.click(screen.getByText('Show all 2 subjects'))
    const list = screen.getByRole('list', {
      name: `Subjects blocked in ${pipelineStep('recon').name}`,
    })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['sub-0001', 'sub-0002'])
  })

  it('omits the disclosure when no subject is named', () => {
    render(<StageBlockerList t={t} lines={[line()]} />)
    expect(screen.getByText(line().reason)).toBeInTheDocument()
    expect(screen.queryByText(/^Show /)).not.toBeInTheDocument()
  })

  // The readiness check's reasons name stages by their registry keys. They
  // reach plan.blockers and the plan digest, so the list restates only the
  // text it shows, as Logs, Runs and the Dashboard do.
  it.each([
    [
      'features',
      'Rerun recon before features because no matching current provenance receipt exists.',
      'Reconstruction has no current receipt for FreeSurfer feature extraction.',
    ],
    [
      'enigma',
      'Restore current recon->enigma required artifacts.',
      'The Reconstruction output that ENIGMA QC requires does not match its receipt.',
    ],
  ] as const)(
    'states the %s readiness blocker as the fact Logs shows',
    (key, reason, fact) => {
      render(
        <StageBlockerList
          t={t}
          lines={[line({ key, reason, subjects: ['sub-0001'] })]}
        />,
      )
      const [item] = screen.getAllByRole('listitem')
      expect(item).toHaveTextContent(`${pipelineStep(key).name} ${fact}`)
      expect(item).not.toHaveTextContent(reason)
    },
  )

  it('shows a reason that is no recorded order as written', () => {
    const reason =
      'Choose a fresh derivatives namespace because complete Reconstruction output has no matching current receipt.'
    render(<StageBlockerList t={t} lines={[line({ reason })]} />)
    expect(screen.getByText(reason)).toBeInTheDocument()
  })

  it('reports the collapsed job count only above one', () => {
    const { rerender } = render(<StageBlockerList t={t} lines={[line()]} />)
    expect(screen.queryByText(/jobs\)/)).not.toBeInTheDocument()
    rerender(<StageBlockerList t={t} lines={[line({ count: 4 })]} />)
    expect(screen.getByText(/\(4 jobs\)/)).toBeInTheDocument()
  })

  it('offers the Registry only when the blocker names it and a handler exists', () => {
    const onOpenRegistry = vi.fn()
    const registryLine = line({ action: OPEN_REGISTRY_ACTION })
    const { rerender } = render(
      <StageBlockerList t={t} lines={[registryLine]} />,
    )
    expect(
      screen.queryByRole('button', { name: 'Open Registry' }),
    ).not.toBeInTheDocument()

    rerender(
      <StageBlockerList
        t={t}
        lines={[registryLine]}
        onOpenRegistry={onOpenRegistry}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open Registry' }))
    expect(onOpenRegistry).toHaveBeenCalledOnce()

    rerender(
      <StageBlockerList
        t={t}
        lines={[line()]}
        onOpenRegistry={onOpenRegistry}
      />,
    )
    expect(
      screen.queryByRole('button', { name: 'Open Registry' }),
    ).not.toBeInTheDocument()
  })
})
