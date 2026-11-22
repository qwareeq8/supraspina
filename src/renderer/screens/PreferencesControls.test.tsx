import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react'
import { THEMES } from '../theme/tokens'
import type { Tweaks } from '../state/context'
import type { UpdateState, WindowPlacementState } from '../../shared/contract'

const h = vi.hoisted(() => ({
  placement: { current: null as WindowPlacementState | null },
  setPreference: vi.fn(async () => null as WindowPlacementState | null),
  openExternal: vi.fn(async () => undefined),
  check: vi.fn(async () => ({
    available: false,
    version: null,
    releaseNotes: null,
  })),
  download: vi.fn(async () => undefined),
  installNow: vi.fn(async () => undefined),
  state: { current: null as UpdateState | null },
}))

vi.mock('../state/api', () => ({
  getApi: () => ({
    external: { openWeb: h.openExternal },
    update: {
      check: h.check,
      download: h.download,
      installNow: h.installNow,
      getStatus: async () => h.state.current,
      onStatus: () => () => undefined,
    },
    windowPlacement: {
      getState: async () => h.placement.current,
      setPreference: h.setPreference,
      onTopologyChanged: () => () => undefined,
    },
  }),
}))

const {
  AccessibilityControls,
  SafeExecutionControls,
  UpdatesControls,
  WindowPlacementControls,
} = await import('./PreferencesControls')

const t = THEMES.dark
const tweaks = { autoUpdateCheck: true } as unknown as Tweaks
const RELEASES_URL = 'https://github.com/qwareeq8/supraspina/releases'
const VERSION = '20261122.905.0'
const SHOWN = '2026-11-22 09:05 UTC'

function st(patch: Partial<UpdateState>): UpdateState {
  return {
    phase: 'idle',
    version: null,
    releaseNotes: null,
    percent: null,
    error: null,
    capability: 'full',
    ...patch,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.current = null
  h.placement.current = null
  localStorage.clear()
})

describe('WindowPlacementControls', () => {
  it('states the primary-display fallback as a fact', async () => {
    h.placement.current = {
      preference: { mode: 'display', displayId: 'display-2' },
      displays: [
        {
          id: 'display-1',
          number: 1,
          primary: true,
          resolution: { width: 1920, height: 1080 },
          workArea: { width: 1920, height: 1040 },
          scaleFactor: 1,
        },
      ],
      resolvedDisplayId: 'display-1',
      fallbackReason: 'selected-display-unavailable',
      unavailableDisplayLabel: 'Display 2',
    }
    render(<WindowPlacementControls t={t} />)

    expect(
      await screen.findByText(
        'Reconnect Display 2 to use it again. Supraspina uses the primary display until it returns.',
      ),
    ).toBeInTheDocument()
  })

  it('describes the startup placement in its info tip', async () => {
    render(<WindowPlacementControls t={t} />)

    expect(
      await screen.findByRole('combobox', {
        name: 'Startup window placement',
      }),
    ).toHaveAccessibleDescription('Where the window opens at launch.')
    expect(
      screen.getByRole('button', { name: 'About Startup placement' }),
    ).toBeInTheDocument()
  })

  it('offers one option for the only connected display', async () => {
    const display = (
      number: number,
    ): WindowPlacementState['displays'][number] => ({
      id: `display-${number}`,
      number,
      primary: number === 1,
      resolution: { width: 1920, height: 1080 },
      workArea: { width: 1920, height: 1040 },
      scaleFactor: 1,
    })
    // The stored preference names the display that is now the only one.
    h.placement.current = {
      preference: { mode: 'display', displayId: 'display-1' },
      displays: [display(1)],
      resolvedDisplayId: 'display-1',
    } as WindowPlacementState
    const one = render(<WindowPlacementControls t={t} />)
    const select = screen.getByRole('combobox', {
      name: 'Startup window placement',
    })
    await waitFor(() => expect(select).toHaveValue('primary'))
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Remember last position', 'Primary display'])
    // Showing the stored choice under another name writes nothing back.
    expect(h.setPreference).not.toHaveBeenCalled()
    one.unmount()

    h.placement.current = {
      preference: { mode: 'display', displayId: 'display-2' },
      displays: [display(1), display(2)],
      resolvedDisplayId: 'display-2',
    } as WindowPlacementState
    render(<WindowPlacementControls t={t} />)
    const both = screen.getByRole('combobox', {
      name: 'Startup window placement',
    })
    await waitFor(() => expect(both).toHaveValue('display-2'))
    expect(
      within(both)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Remember last position',
      'Primary display',
      'Display 1',
      'Display 2',
    ])
  })

  it('draws display tiles only when several displays are connected', async () => {
    const display = (
      number: number,
    ): WindowPlacementState['displays'][number] => ({
      id: `display-${number}`,
      number,
      primary: number === 1,
      resolution: { width: 1920, height: 1080 },
      workArea: { width: 1920, height: 1040 },
      scaleFactor: 1,
    })
    h.placement.current = {
      preference: { mode: 'remember' },
      displays: [display(1)],
      resolvedDisplayId: 'display-1',
    } as WindowPlacementState
    const one = render(<WindowPlacementControls t={t} />)
    await screen.findByRole('option', { name: 'Primary display' })
    expect(
      screen.queryByRole('list', { name: 'Connected displays' }),
    ).toBeNull()
    one.unmount()

    h.placement.current = {
      preference: { mode: 'remember' },
      displays: [display(1), display(2)],
      resolvedDisplayId: 'display-1',
    } as WindowPlacementState
    render(<WindowPlacementControls t={t} />)
    const list = await screen.findByRole('list', { name: 'Connected displays' })
    expect(list).toHaveTextContent('Display 1 (primary)')
    expect(list).toHaveTextContent('1920 x 1080 px, 1x scale')
    expect(list.firstElementChild).toHaveAttribute(
      'title',
      'Work area 1920 x 1040 px',
    )
    expect(
      screen.getByRole('button', { name: 'Move window now' }),
    ).toBeEnabled()
  })
})

describe('SafeExecutionControls', () => {
  it('labels the switch and explains Off in its info tip', () => {
    render(<SafeExecutionControls t={t} value={false} onChange={() => {}} />)

    const note =
      'Off keeps runs as dry runs and blocks installs. Each live action still asks first.'
    expect(
      screen.getByRole('button', { name: 'About Allow live runs' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Allow live runs')).toBeVisible()
    expect(
      screen.getByRole('switch', { name: 'Allow live runs' }),
    ).toHaveAccessibleDescription(note)
  })
})

describe('AccessibilityControls', () => {
  it('states that high contrast leaves status colors unchanged', () => {
    const accessibility = {
      textScale: '100',
      reducedMotion: false,
      highContrast: false,
    } as unknown as Tweaks
    render(
      <AccessibilityControls
        t={t}
        tweaks={accessibility}
        onChange={() => {}}
      />,
    )

    expect(
      screen.getByRole('switch', { name: 'High contrast' }),
    ).toHaveAccessibleDescription('Raises text and border contrast.')
    // A preference without an explanation draws no info tip.
    expect(
      screen.queryByRole('button', { name: 'About Larger text' }),
    ).toBeNull()
  })
})

describe('UpdatesControls', () => {
  it('offers the release page of a newer version on the notify path', async () => {
    h.state.current = st({
      capability: 'notify',
      phase: 'available',
      version: VERSION,
    })
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)

    expect(
      await screen.findByText(
        `Version ${SHOWN} is available on its release page.`,
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open release page' }))
    expect(h.openExternal).toHaveBeenCalledWith({
      url: `${RELEASES_URL}/tag/v${VERSION}`,
      purpose: 'releases',
    })
    expect(screen.queryByRole('button', { name: 'Download update' })).toBeNull()
  })

  it('checks manually on the notify path and reports up to date', async () => {
    h.state.current = st({ capability: 'notify', phase: 'not-available' })
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)

    expect(
      await screen.findByText('Supraspina is up to date.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open release page' }),
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await waitFor(() => expect(h.check).toHaveBeenCalledOnce())
  })

  it('claims no newer-version result before a check has run', async () => {
    h.state.current = st({ capability: 'full', phase: 'idle' })
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)

    expect(
      await screen.findByText('No update check has run yet.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Supraspina is up to date.')).toBeNull()
  })

  it('downloads an offered AppImage update only when the operator asks', async () => {
    h.state.current = st({
      capability: 'full',
      phase: 'available',
      version: VERSION,
    })
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)

    expect(
      await screen.findByText(`Version ${SHOWN} is available.`),
    ).toBeInTheDocument()
    expect(h.download).not.toHaveBeenCalled()
    const download = screen.getByRole('button', { name: 'Download update' })
    expect(download).toHaveAttribute(
      'title',
      'Downloads the AppImage from GitHub Releases and verifies its SHA-512 checksum.',
    )
    fireEvent.click(download)
    await waitFor(() => expect(h.download).toHaveBeenCalledOnce())
  })

  it('states a downloaded update as installing on quit and offers a restart', async () => {
    h.state.current = st({
      capability: 'full',
      phase: 'downloaded',
      version: VERSION,
    })
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)

    expect(
      await screen.findByText(`Version ${SHOWN} installs when you quit.`),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restart and install' }))
    await waitFor(() => expect(h.installNow).toHaveBeenCalled())
    expect(
      screen.queryByRole('button', { name: 'Skip this version' }),
    ).toBeNull()
  })

  it('states an update failure as a fact followed by its recorded remedy', async () => {
    h.state.current = st({
      capability: 'full',
      phase: 'error',
      error: 'Retry the update download, or open Releases in your browser.',
    })
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)

    // A failure is marked as an alert in the fail color, not a quiet status.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The update failed. Retry the update download, or open Releases in your browser.',
    )
    expect(screen.getByRole('alert')).toHaveStyle({ color: t.failed })
  })

  it('shows download progress in place of the actions', async () => {
    h.state.current = st({
      capability: 'full',
      phase: 'downloading',
      version: VERSION,
      percent: 19.6,
      releaseNotes: 'Fixes the export.',
    })
    const progress = render(
      <UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />,
    )
    expect(
      await screen.findByText('Downloading the update: 20%.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Check for updates' }),
    ).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Download update' })).toBeNull()
    // The notes stay, so the card keeps its height through the download.
    expect(screen.getByText('Fixes the export.')).toBeInTheDocument()
    progress.unmount()

    h.state.current = st({ capability: 'full', phase: 'downloading' })
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)
    expect(
      await screen.findByText('Downloading the update...'),
    ).toBeInTheDocument()
  })

  it('reports a missing-detail error and keeps the check enabled', async () => {
    h.state.current = st({ capability: 'full', phase: 'error', error: null })
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)
    expect(
      await screen.findByText('The update failed without an error detail.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Check for updates' }),
    ).toBeEnabled()
  })

  it('states the update check in flight and disables a second one', async () => {
    h.state.current = st({ capability: 'full', phase: 'checking' })
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)
    expect(
      await screen.findByText('Checking for updates...'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Check for updates' }),
    ).toBeDisabled()
  })

  it('toggles automatic checks and describes them', async () => {
    h.state.current = st({ capability: 'full', phase: 'idle' })
    const onChange = vi.fn()
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={onChange} />)

    const toggle = await screen.findByRole('switch', {
      name: 'Check for updates automatically',
    })
    expect(toggle).toHaveAccessibleDescription(
      'Checks GitHub Releases once a day at startup.',
    )
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledWith({ autoUpdateCheck: false })
    expect(h.check).not.toHaveBeenCalled()
  })

  it('keeps the manual check while automatic checks are off', async () => {
    h.state.current = st({ capability: 'full', phase: 'idle' })
    render(
      <UpdatesControls
        t={t}
        tweaks={{ ...tweaks, autoUpdateCheck: false }}
        onChange={() => {}}
      />,
    )
    expect(
      await screen.findByRole('switch', {
        name: 'Check for updates automatically',
      }),
    ).not.toBeChecked()
    expect(h.check).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    await waitFor(() => expect(h.check).toHaveBeenCalledOnce())
  })

  it('shows release notes and sanitizes a non-Error download failure', async () => {
    h.state.current = st({
      capability: 'full',
      phase: 'available',
      version: VERSION,
      releaseNotes: 'Review the validated release notes.',
    })
    h.download.mockRejectedValueOnce('download unavailable')
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)

    expect(
      await screen.findByText('Review the validated release notes.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'download unavailable',
    )
  })

  it('does not persist a skip when an offer has no version', async () => {
    localStorage.setItem('supraspinaSkippedVersion', 'previous')
    h.state.current = st({
      capability: 'full',
      phase: 'available',
      version: null,
    })
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)

    expect(
      await screen.findByText('A newer version is available.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Skip this version' }))
    expect(localStorage.getItem('supraspinaSkippedVersion')).toBe('previous')
  })

  it('explains the no-op in development and offers no network action', async () => {
    h.state.current = st({ capability: 'noop', phase: 'idle' })
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)
    expect(
      await screen.findByText(/Development builds get updates outside the app/),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Check for updates' }),
    ).toBeNull()
    expect(h.check).not.toHaveBeenCalled()
  })

  it('shows a failed install crossing and restores the Restart action', async () => {
    h.state.current = st({
      capability: 'full',
      phase: 'downloaded',
      version: VERSION,
    })
    h.installNow.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'update:install-now': Error: runtime restore failed",
      ),
    )
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)
    const restart = await screen.findByRole('button', {
      name: 'Restart and install',
    })

    fireEvent.click(restart)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'runtime restore failed',
    )
    await waitFor(() => expect(restart).toBeEnabled())
  })

  it('skips a version, persisting it and dropping the update offer', async () => {
    h.state.current = st({
      capability: 'full',
      phase: 'available',
      version: VERSION,
    })
    render(<UpdatesControls t={t} tweaks={tweaks} onChange={() => {}} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Skip this version' }),
    )
    expect(localStorage.getItem('supraspinaSkippedVersion')).toBe(VERSION)
    expect(screen.queryByRole('button', { name: 'Download update' })).toBeNull()
  })
})
