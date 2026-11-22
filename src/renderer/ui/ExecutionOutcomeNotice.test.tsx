/**
 * Tests for the shared workflow outcome notice. Cover the optional Dismiss
 * control, which renders only for a caller that can remove the outcome and
 * stays outside the blocked-workflow action group, the optional Open Logs
 * action, and the blockers View blockers lists.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ExecutionOutcomeNotice } from './ExecutionOutcomeNotice'
import type { StageBlocker } from '../../shared/types'
import { THEMES } from '../theme/tokens'

const t = THEMES.dark

const BLOCKER: StageBlocker = {
  key: 'recon',
  kind: 'cohort',
  reason: 'Recon-all needs a defaced input.',
}

describe('ExecutionOutcomeNotice', () => {
  it('omits the Dismiss control when the caller cannot remove the outcome', () => {
    render(
      <ExecutionOutcomeNotice
        t={t}
        message="No work is scheduled: all 4 nodes are current."
      />,
    )
    expect(
      screen.getByText('No work is scheduled: all 4 nodes are current.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Dismiss/ }),
    ).not.toBeInTheDocument()
  })

  it('dismisses the outcome through the caller when Dismiss is clicked', () => {
    const onDismiss = vi.fn()
    render(
      <ExecutionOutcomeNotice
        t={t}
        message="Planned 2 jobs; 1 stage is blocked."
        blockers={[BLOCKER]}
        onDismiss={onDismiss}
      />,
    )
    const dismiss = screen.getByRole('button', {
      name: 'Dismiss the workflow outcome',
    })
    expect(dismiss).toHaveTextContent('Dismiss')
    // Dismiss removes the notice; it is not a recovery action for the blockers.
    const actions = screen.getByRole('group', {
      name: 'Blocked workflow actions',
    })
    expect(
      within(actions).getByRole('button', { name: 'View blockers' }),
    ).toBeInTheDocument()
    expect(actions).not.toContainElement(dismiss)

    fireEvent.click(dismiss)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('offers Open Logs only to a caller that can open Logs', () => {
    const message = 'Run run-1 was canceled: 1 job finished, 1 canceled.'
    const onOpenLogs = vi.fn()
    const { rerender } = render(
      <ExecutionOutcomeNotice t={t} message={message} />,
    )
    expect(screen.queryByRole('button', { name: 'Open Logs' })).toBeNull()

    rerender(
      <ExecutionOutcomeNotice
        t={t}
        message={message}
        onOpenLogs={onOpenLogs}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open Logs' }))
    expect(onOpenLogs).toHaveBeenCalledTimes(1)
    // The action sits beside the message, outside its live region.
    expect(screen.getByRole('status')).toHaveTextContent(message)
    expect(screen.getByRole('status')).not.toContainElement(
      screen.getByRole('button', { name: 'Open Logs' }),
    )
  })

  it('lists the blocked subjects of a blocker reported without them', () => {
    // The sidecar's blocker names no subject; the blocked plan node that
    // records the reason names sub-902.
    const conflict =
      'Choose a fresh derivatives namespace because detector-complete Reconstruction output has no matching current receipt; preserve the existing tree.'
    render(
      <ExecutionOutcomeNotice
        t={t}
        message={`Run run-1 ended with 1 job finished and 1 node that did not run. Reconstruction for sub-902: ${conflict}`}
        blockers={[{ key: 'recon', kind: 'safety', reason: conflict }]}
        nodes={[
          {
            nodeId: '000-recon-sub-901',
            stepKey: 'recon',
            scope: 'subject',
            subjectId: 'sub-901',
            status: 'planned',
            dependencies: [],
          },
          {
            nodeId: '001-recon-sub-902',
            stepKey: 'recon',
            scope: 'subject',
            subjectId: 'sub-902',
            status: 'blocked',
            dependencies: [],
            reason: conflict,
          },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'View blockers' }))
    const subjects = screen.getByRole('list', {
      name: 'Subjects blocked in Reconstruction',
      hidden: true,
    })
    expect(
      within(subjects)
        .getAllByRole('listitem', { hidden: true })
        .map((item) => item.textContent),
    ).toEqual(['sub-902'])
  })

  it('states the dependency wait and readiness blockers as facts', () => {
    // The real planner's blockers when Registry roles are missing, and the
    // readiness blocker _sync_runtime_blockers adds. Each enters the plan
    // digest, so the sidecar keeps the order it records.
    const cause =
      'Prepare Clinical merge. Assign registry roles to sub-missing. Resolve ambiguous registry roles for sub-ambiguous.'
    render(
      <ExecutionOutcomeNotice
        t={t}
        message="This pass runs 2 nodes; 3 blocked nodes will not run."
        blockers={[
          {
            key: 'clinical',
            kind: 'cohort',
            reason: cause,
            subjects: ['sub-ambiguous', 'sub-missing'],
          },
          {
            key: 'brainpad',
            kind: 'dependency',
            reason: `Wait for Clinical merge, which is blocked: ${cause}`,
          },
          {
            key: 'features',
            kind: 'runtime',
            reason:
              'Rerun recon before features because no matching current provenance receipt exists.',
          },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'View blockers' }))
    const lines = Array.from(
      screen.getByRole('dialog', { hidden: true }).querySelectorAll('li'),
      (item) => item.textContent ?? '',
    )
    expect(lines).toContain(
      `Brain-PAD statistics Depends on Clinical merge, which is blocked: ${cause}`,
    )
    expect(lines).toContain(
      'FreeSurfer feature extraction Reconstruction has no current receipt for FreeSurfer feature extraction.',
    )
    expect(lines.filter((line) => /Wait for|Rerun recon/.test(line))).toEqual(
      [],
    )
  })
})
