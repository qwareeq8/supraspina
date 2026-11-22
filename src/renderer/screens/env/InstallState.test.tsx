/** Tests the announcement channel of one settled environment installation. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { AppProvider } from '../../state/context'
import { THEMES } from '../../theme/tokens'
import { EnvInstallView } from './InstallState'
import type { EnvInstallState } from '../../../shared/contract'

/** Stub matchMedia so the OS reports the requested reduced-motion preference. */
function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches: reduce && media === '(prefers-reduced-motion: reduce)',
      media,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })),
  )
}

/** Build one running installation snapshot started a minute ago. */
function running(startedAt: number): EnvInstallState {
  return {
    operationId: 'op-1',
    checkId: 'r-packages',
    projectId: 'study',
    projectEpoch: 1,
    phase: 'running',
    startedAt,
    updatedAt: startedAt,
    output: '',
    rc: null,
    stdout: '',
    stderr: '',
  }
}

/** Build one settled installation snapshot in the requested phase. */
function settled(phase: 'done' | 'error', rc: number): EnvInstallState {
  return {
    operationId: 'op-1',
    checkId: 'r-packages',
    projectId: 'study',
    projectEpoch: 1,
    phase,
    startedAt: 1_000,
    updatedAt: 4_000,
    output: '',
    rc,
    stdout: '',
    stderr: '',
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('EnvInstallView', () => {
  it('stops the elapsed ticker when the OS asks for reduced motion', () => {
    stubReducedMotion(true)
    vi.useFakeTimers()
    const startedAt = Date.now()
    render(
      <AppProvider>
        <EnvInstallView
          t={THEMES.dark}
          label="R packages"
          state={running(startedAt)}
        />
      </AppProvider>,
    )
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(screen.getByText('00:00')).toBeInTheDocument()
  })

  it('ticks the elapsed clock once a second without a reduced-motion preference', () => {
    stubReducedMotion(false)
    vi.useFakeTimers()
    const startedAt = Date.now()
    render(
      <AppProvider>
        <EnvInstallView
          t={THEMES.dark}
          label="R packages"
          state={running(startedAt)}
        />
      </AppProvider>,
    )
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(screen.getByText('00:05')).toBeInTheDocument()
  })

  it('announces a failed installation assertively', () => {
    render(
      <AppProvider>
        <EnvInstallView
          t={THEMES.dark}
          label="R packages"
          state={settled('error', 1)}
        />
      </AppProvider>,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('The installation of R packages failed.')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('names the live output and the captured streams by what they hold', () => {
    const live = render(
      <AppProvider>
        <EnvInstallView
          t={THEMES.dark}
          label="R packages"
          state={{ ...running(Date.now()), output: 'installing writexl' }}
        />
      </AppProvider>,
    )
    // The live tail combines both streams, so it is not labeled stdout.
    expect(
      screen.getByRole('group', { name: 'Command output' }),
    ).toHaveTextContent('installing writexl')
    live.unmount()

    render(
      <AppProvider>
        <EnvInstallView
          t={THEMES.dark}
          label="R packages"
          state={{
            ...settled('error', 1),
            stdout: 'fetched 3 packages',
            stderr: 'compilation failed',
          }}
        />
      </AppProvider>,
    )
    expect(
      screen.getByRole('group', { name: 'Standard output' }),
    ).toHaveTextContent('fetched 3 packages')
    expect(
      screen.getByRole('group', { name: 'Standard error' }),
    ).toHaveTextContent('compilation failed')
    expect(screen.queryByRole('group', { name: /command$/ })).toBeNull()
  })

  it('keeps a successful installation on the polite channel', () => {
    render(
      <AppProvider>
        <EnvInstallView
          t={THEMES.dark}
          label="R packages"
          state={settled('done', 0)}
        />
      </AppProvider>,
    )
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Installed R packages.')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
