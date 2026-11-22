/** Tests the tone of the PyBrainAge setup status line. */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { THEMES } from '../../theme/tokens'
import { statusColor } from '../../ui'
import { PybrainageSetupProgress } from './PybrainageSetup'

const t = THEMES.light

describe('PybrainageSetupProgress', () => {
  it('draws a canceled setup in the canceled tone, not the failed one', () => {
    render(
      <PybrainageSetupProgress
        t={t}
        state={{
          message: 'PyBrainAge setup was canceled.',
          percent: null,
          status: 'cancelled',
          lines: [],
        }}
      />,
    )
    const line = screen.getByRole('status')
    expect(line).toHaveTextContent('PyBrainAge setup was canceled.')
    expect(line).toHaveStyle({ color: statusColor(t, 'cancelled') })
    expect(line).not.toHaveStyle({ color: t.failed })
  })

  it('keeps a failed setup in the failed tone', () => {
    render(
      <PybrainageSetupProgress
        t={t}
        state={{
          message: 'Fetching the model archive failed: HTTP 503',
          percent: null,
          status: 'error',
          lines: [],
        }}
      />,
    )
    expect(screen.getByRole('status')).toHaveStyle({ color: t.failed })
  })
})
