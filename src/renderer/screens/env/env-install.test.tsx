/**
 * Tests for the shared opt-in install hook. Cover reattachment to unsettled
 * sidecar work after a remount and the rejection paths that report a request
 * that never reached the sidecar.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEnvInstall } from './env-install'
import { AppProvider, useApp } from '../../state/context'
import { getApi } from '../../state/api'
import { DEFAULT_PROJECT_CONFIG } from '../../../shared/project-schema'
import type { EnvInstallState } from '../../../shared/contract'
import type { EnvCheck } from '../../../shared/types'

const INSTALL_PROJECT = {
  projectId: 'install-project',
  root: '/projects/install',
  configPath: '/projects/install/supraspina.project.json',
  epoch: 1,
}

const INSTALL_CONFIG = {
  ...DEFAULT_PROJECT_CONFIG,
  paths: {
    ...DEFAULT_PROJECT_CONFIG.paths,
    projectRoot: INSTALL_PROJECT.root,
  },
}

const RSCRIPT: EnvCheck = {
  id: 'rscript',
  label: 'Rscript',
  status: 'missing',
  recommendedCmd: 'install-rscript',
}

/** Build one installation snapshot for the project this harness renders. */
function installState(
  checkId: string,
  patch: Partial<EnvInstallState> = {},
): EnvInstallState {
  return {
    operationId: 'install-0123456789ab',
    checkId,
    projectId: INSTALL_PROJECT.projectId,
    projectEpoch: INSTALL_PROJECT.epoch,
    phase: 'running',
    startedAt: 1,
    updatedAt: 2,
    output: '',
    rc: null,
    stdout: '',
    stderr: '',
    ...patch,
  }
}

function Bootstrap({ children }: { children: ReactNode }): ReactNode {
  const app = useApp()
  const booted = useRef(false)
  useLayoutEffect(() => {
    if (booted.current) return
    booted.current = true
    app.markProjectCreated({
      project: INSTALL_PROJECT,
      cfg: INSTALL_CONFIG,
      configSha256: '0'.repeat(64),
    })
  }, [app])
  return children
}

/** Surface the hook's install state as readable rows. */
function Harness({
  safeExecution = true,
}: {
  safeExecution?: boolean
}): ReactNode {
  const install = useEnvInstall({
    safeExecution,
    request: { cfg: INSTALL_CONFIG, configRevision: 3 },
  })
  return (
    <div>
      <button type="button" onClick={() => install.start(RSCRIPT)}>
        Install Rscript
      </button>
      <span>running:{install.running ?? 'none'}</span>
      <ul>
        {Object.values(install.states).map((state) => (
          <li key={state.checkId}>
            {`${state.checkId}|${state.phase}|${state.operationId || 'unnamed'}|${state.stderr}`}
          </li>
        ))}
      </ul>
    </div>
  )
}

function renderHarness(safeExecution = true): ReturnType<typeof render> {
  return render(
    <AppProvider>
      <Bootstrap>
        <Harness safeExecution={safeExecution} />
      </Bootstrap>
    </AppProvider>,
  )
}

/** Take over the install progress channel so the test publishes the phases. */
function mockProgress(): (state: EnvInstallState) => void {
  const listeners = new Set<(ev: EnvInstallState) => void>()
  vi.spyOn(getApi().env, 'onInstallProgress').mockImplementation((cb) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  })
  return (state) => {
    act(() => {
      for (const listener of [...listeners]) listener(state)
    })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useEnvInstall reattachment', () => {
  it('adopts an unsettled installation reported after a remount', async () => {
    mockProgress()
    vi.spyOn(getApi().env, 'installStatus').mockResolvedValue({
      operations: [installState('rscript', { phase: 'running' })],
    })
    renderHarness()
    expect(
      await screen.findByText('rscript|running|install-0123456789ab|'),
    ).toBeInTheDocument()
    expect(screen.getByText('running:rscript')).toBeInTheDocument()
  })

  it('leaves a settled installation to the screen that started it', async () => {
    mockProgress()
    vi.spyOn(getApi().env, 'installStatus').mockResolvedValue({
      operations: [
        installState('rscript', { phase: 'done', rc: 0 }),
        installState('mcr', { phase: 'error', rc: 1 }),
        installState('freesurfer', { phase: 'queued' }),
      ],
    })
    renderHarness()
    expect(await screen.findByText(/^freesurfer\|queued\|/)).toBeInTheDocument()
    expect(screen.queryByText(/^rscript\|/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^mcr\|/)).not.toBeInTheDocument()
    expect(screen.getByText('running:freesurfer')).toBeInTheDocument()
  })

  it('stays idle when the sidecar cannot report prior work', async () => {
    mockProgress()
    vi.spyOn(getApi().env, 'installStatus').mockRejectedValue(
      new Error('The sidecar is not attached.'),
    )
    renderHarness()
    await waitFor(() =>
      expect(screen.getByText('running:none')).toBeInTheDocument(),
    )
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })
})

describe('useEnvInstall rejection', () => {
  it('reports a request that failed before the sidecar took ownership', async () => {
    mockProgress()
    vi.spyOn(getApi().env, 'installStatus').mockResolvedValue({
      operations: [],
    })
    vi.spyOn(getApi().execution, 'authorize').mockRejectedValue(
      new Error('Allow live runs is off.'),
    )
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'Install Rscript' }))
    expect(
      await screen.findByText('rscript|error|unnamed|Allow live runs is off.'),
    ).toBeInTheDocument()
    expect(screen.getByText('running:none')).toBeInTheDocument()
  })

  it('keeps a started operation reporting for itself when the request rejects late', async () => {
    const publish = mockProgress()
    vi.spyOn(getApi().env, 'installStatus').mockResolvedValue({
      operations: [],
    })
    let reject: (cause: unknown) => void = () => undefined
    vi.spyOn(getApi().env, 'optInInstall').mockReturnValue(
      new Promise((_resolve, settle) => {
        reject = settle
      }),
    )
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'Install Rscript' }))
    expect(
      await screen.findByText(/^rscript\|queued\|unnamed\|/),
    ).toBeInTheDocument()

    publish(installState('rscript', { phase: 'running' }))
    await act(async () => {
      reject(new Error('The channel closed.'))
      await Promise.resolve()
    })

    expect(
      screen.getByText('rscript|running|install-0123456789ab|'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/The channel closed\./)).not.toBeInTheDocument()
  })

  it('does not start while safe execution is off', async () => {
    mockProgress()
    const optIn = vi.spyOn(getApi().env, 'optInInstall')
    vi.spyOn(getApi().env, 'installStatus').mockResolvedValue({
      operations: [],
    })
    renderHarness(false)
    fireEvent.click(screen.getByRole('button', { name: 'Install Rscript' }))
    await waitFor(() =>
      expect(screen.getByText('running:none')).toBeInTheDocument(),
    )
    expect(optIn).not.toHaveBeenCalled()
  })
})
