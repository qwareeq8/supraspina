import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { BrainChartsResourceCard } from './BrainChartsResourceCard'
import {
  BRAINCHARTS_CITATION,
  BRAINCHARTS_NOTICE,
  brainChartsReadiness,
} from './env/braincharts-setup'
import { ScientificResourcesPanel } from './ScientificResourcesPanel'
import { AppProvider, useApp } from '../state/context'
import { getApi } from '../state/api'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { EnvCheck, EnvReport } from '../../shared/types'
import type { ProvisionProgress } from '../../shared/contract'

const PROJECT = {
  projectId: 'braincharts-project',
  root: '/projects/braincharts',
  configPath: '/projects/braincharts/supraspina.project.json',
  epoch: 1,
}
const CONFIG = {
  ...DEFAULT_PROJECT_CONFIG,
  paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: PROJECT.root },
}
const OPERATION_ID = 'provision-0123456789ab'

function Bootstrap({ children }: { children: ReactNode }): ReactNode {
  const app = useApp()
  const booted = useRef(false)
  useLayoutEffect(() => {
    if (booted.current) return
    booted.current = true
    app.markProjectCreated({
      project: PROJECT,
      cfg: CONFIG,
      configSha256: '0'.repeat(64),
    })
  }, [app])
  return children
}

function renderCard(safeExecution: boolean): void {
  render(
    <AppProvider>
      <Bootstrap>
        <BrainChartsResourceCard
          safeExecution={safeExecution}
          operationGate={
            safeExecution
              ? null
              : {
                  kind: 'safe-execution',
                  action: 'provision or import a resource',
                  reason: 'Allow live runs to provision or import a resource.',
                }
          }
        />
      </Bootstrap>
    </AppProvider>,
  )
}

function report(checks: EnvCheck[]): EnvReport {
  return {
    capturedAt: '2026-09-30T00:00:00.000Z',
    availableMemoryGB: 24,
    groups: [{ name: 'BrainCharts', checks }],
  }
}

const MISSING = report([
  { id: 'bcenv', label: 'BrainCharts runtime', status: 'missing' },
  { id: 'bcmodel', label: 'BrainCharts lifespan model', status: 'missing' },
])
const READY = report([
  { id: 'bcenv', label: 'BrainCharts runtime', status: 'found' },
  { id: 'bcmodel', label: 'BrainCharts lifespan model', status: 'found' },
])

/** Capture the provision event listeners so a test can publish events. */
function provisionEvents(): {
  progress: (
    event: Omit<ProvisionProgress, 'projectId' | 'projectEpoch'>,
  ) => void
  log: (operationId: string, line: string) => void
} {
  const api = getApi()
  const progress = new Set<(event: ProvisionProgress) => void>()
  const log = new Set<
    (event: {
      projectId: string
      projectEpoch: number
      operationId: string
      at: number
      line: string
    }) => void
  >()
  vi.spyOn(api.provision, 'onProgress').mockImplementation((cb) => {
    progress.add(cb)
    return () => progress.delete(cb)
  })
  vi.spyOn(api.provision, 'onLog').mockImplementation((cb) => {
    log.add(cb)
    return () => log.delete(cb)
  })
  return {
    progress: (event) => {
      act(() => {
        for (const listener of [...progress]) {
          listener({
            ...event,
            projectId: PROJECT.projectId,
            projectEpoch: PROJECT.epoch,
          })
        }
      })
    },
    log: (operationId, line) => {
      act(() => {
        for (const listener of [...log]) {
          listener({
            projectId: PROJECT.projectId,
            projectEpoch: PROJECT.epoch,
            operationId,
            at: Date.now(),
            line,
          })
        }
      })
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('brainChartsReadiness', () => {
  it('reads the two checks as ready, not set up, failed, or unavailable', () => {
    expect(brainChartsReadiness(null).label).toBe('Not checked')
    expect(brainChartsReadiness([]).label).toBe('Not set up')
    expect(brainChartsReadiness(READY.groups[0]!.checks)).toEqual({
      chip: 'done',
      label: 'Ready',
      detail: null,
      unavailable: false,
    })
    expect(
      brainChartsReadiness([
        { id: 'bcenv', label: 'Runtime', status: 'found' },
        {
          id: 'bcmodel',
          label: 'Model',
          status: 'wrong',
          detail: 'The BrainCharts model files changed after setup.',
        },
      ]),
    ).toMatchObject({
      chip: 'failed',
      detail: 'The BrainCharts model files changed after setup.',
    })
    expect(
      brainChartsReadiness([
        {
          id: 'bcenv',
          label: 'Runtime',
          status: 'skipped',
          detail: 'The BrainCharts runtime is available on Linux x86_64 only.',
        },
      ]),
    ).toMatchObject({ chip: 'warn', unavailable: true })
  })
})

describe('BrainChartsResourceCard', () => {
  it('refuses the download without Allow live runs and states why', async () => {
    vi.spyOn(getApi().env, 'check').mockResolvedValue(MISSING)
    const start = vi.spyOn(getApi().provision, 'braincharts')
    renderCard(false)

    const button = await screen.findByRole('button', {
      name: 'Download from GitHub',
    })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute(
      'title',
      'Allow live runs to provision or import a resource.',
    )
    expect(await screen.findByText('Not set up')).toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()
  })

  it('shows the license notice first and downloads only after acceptance', async () => {
    const api = getApi()
    const check = vi.spyOn(api.env, 'check').mockResolvedValue(MISSING)
    const events = provisionEvents()
    const authorize = vi.spyOn(api.execution, 'authorize')
    const start = vi
      .spyOn(api.provision, 'braincharts')
      .mockResolvedValue({ operationId: OPERATION_ID })
    renderCard(true)
    await waitFor(() =>
      expect(check).toHaveBeenCalledWith(
        expect.objectContaining({ ids: ['bcenv', 'bcmodel'] }),
      ),
    )

    // One line states the resource; the download details sit in the title.
    expect(
      screen.getByText('Normative z-scores per region. Linux x86_64 only.'),
    ).toBeInTheDocument()
    const download = await screen.findByRole('button', {
      name: 'Download from GitHub',
    })
    expect(download).toHaveTextContent(/^Download$/)
    expect(download).toHaveAttribute(
      'title',
      'Downloads the model (2.8 MB) from GitHub and builds a runtime of about 2 GB in the project output directory.',
    )
    fireEvent.click(download)
    const dialog = screen.getByRole('dialog', {
      name: 'BrainCharts license notice',
    })
    expect(
      within(dialog).getByText(/licensed under the GNU General Public License/),
    ).toBeVisible()
    const notice = within(dialog).getByText(/This software redistributes/)
    expect(notice.textContent).toBe(BRAINCHARTS_NOTICE)
    expect(within(dialog).getByText(BRAINCHARTS_CITATION)).toBeInTheDocument()
    expect(
      within(dialog).getByLabelText('GPL-3.0 license text').textContent,
    ).toContain('GNU GENERAL PUBLIC LICENSE')
    expect(start).not.toHaveBeenCalled()

    // Dismissing the notice starts nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(authorize).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', { name: 'Download from GitHub' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Accept and download' }))
    await waitFor(() => expect(start).toHaveBeenCalledOnce())
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'provision' }),
    )
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        project: PROJECT,
        licenseAccepted: true,
        configRevision: expect.any(Number),
      }),
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )

    events.progress({
      operationId: OPERATION_ID,
      phase: 'download',
      percent: 38,
      message: 'Downloading the BrainCharts model from GitHub...',
    })
    events.log(OPERATION_ID, 'Collecting torch==2.14.1+cpu')
    expect(
      screen.getByText('38% Downloading the BrainCharts model from GitHub...'),
    ).toBeInTheDocument()
    expect(screen.getByText('Collecting torch==2.14.1+cpu')).toBeInTheDocument()
    expect(
      screen.getByRole('progressbar', { name: 'BrainCharts setup progress' }),
    ).toBeInTheDocument()

    // Another operation's events never move this card.
    events.progress({
      operationId: 'provision-ffffffffffff',
      phase: 'error',
      percent: null,
      message: 'PyBrainAge setup was canceled.',
    })
    expect(screen.getByText('Setting up')).toBeInTheDocument()

    check.mockResolvedValue(READY)
    events.progress({
      operationId: OPERATION_ID,
      phase: 'done',
      percent: 100,
      message: 'BrainCharts setup is complete.',
    })
    expect(
      screen.getByText('BrainCharts setup is complete.'),
    ).toBeInTheDocument()
    expect(await screen.findByText('Ready')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Recheck BrainCharts' }),
    ).toBeEnabled()
  })

  it('cancels a running setup and reads the cancellation as canceled', async () => {
    const api = getApi()
    vi.spyOn(api.env, 'check').mockResolvedValue(MISSING)
    const events = provisionEvents()
    vi.spyOn(api.provision, 'braincharts').mockResolvedValue({
      operationId: OPERATION_ID,
    })
    const cancel = vi.spyOn(api.provision, 'cancel').mockResolvedValue({
      operationId: OPERATION_ID,
      accepted: true,
      terminal: false,
    })
    renderCard(true)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download from GitHub' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Accept and download' }))

    fireEvent.click(
      await screen.findByRole('button', { name: 'Cancel BrainCharts setup' }),
    )
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith({
        project: PROJECT,
        operationId: OPERATION_ID,
      }),
    )
    events.progress({
      operationId: OPERATION_ID,
      phase: 'error',
      percent: null,
      message: 'BrainCharts setup was canceled.',
    })
    expect(
      screen.getByText('BrainCharts setup was canceled.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Download from GitHub' }),
    ).toBeEnabled()
  })

  it('keeps progress that arrives before the operation ID returns', async () => {
    // The mock sidecar publishes every step before provision.braincharts
    // resolves, as a fast real setup can.
    renderCard(true)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download from GitHub' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Accept and download' }))

    expect(
      await screen.findByText('BrainCharts setup is complete.'),
    ).toBeInTheDocument()
    expect(await screen.findByText('Ready')).toBeInTheDocument()
  })

  it('states the platform limit where the runtime cannot run', async () => {
    const detail = 'The BrainCharts runtime is available on Linux x86_64 only.'
    vi.spyOn(getApi().env, 'check').mockResolvedValue(
      report([
        { id: 'bcenv', label: 'Runtime', status: 'skipped', detail },
        { id: 'bcmodel', label: 'Model', status: 'skipped', detail },
      ]),
    )
    renderCard(true)

    expect(await screen.findByText('Unavailable')).toBeInTheDocument()
    expect(screen.getByText(detail)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Download from GitHub' }),
    ).toHaveAttribute('title', detail)
    expect(
      screen.getByRole('button', { name: 'Download from GitHub' }),
    ).toBeDisabled()
  })

  it('reads a host report and asks the host to recheck after a setup', async () => {
    const api = getApi()
    const check = vi.spyOn(api.env, 'check')
    const events = provisionEvents()
    vi.spyOn(api.provision, 'braincharts').mockResolvedValue({
      operationId: OPERATION_ID,
    })
    const onRecheck = vi.fn()
    render(
      <AppProvider>
        <Bootstrap>
          <BrainChartsResourceCard
            safeExecution
            operationGate={null}
            report={MISSING}
            onRecheck={onRecheck}
          />
        </Bootstrap>
      </AppProvider>,
    )
    expect(await screen.findByText('Not set up')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Download from GitHub' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Accept and download' }))
    await screen.findByRole('button', { name: 'Cancel BrainCharts setup' })
    events.progress({
      operationId: OPERATION_ID,
      phase: 'done',
      percent: 100,
      message: 'BrainCharts setup is complete.',
    })
    expect(onRecheck).toHaveBeenCalledOnce()
    expect(check).not.toHaveBeenCalled()
  })

  it('appears in the scientific resources panel', async () => {
    vi.spyOn(getApi().env, 'check').mockResolvedValue(MISSING)
    render(
      <AppProvider>
        <Bootstrap>
          <ScientificResourcesPanel safeExecution={false} />
        </Bootstrap>
      </AppProvider>,
    )
    expect(
      await screen.findByRole('heading', {
        name: 'BrainCharts lifespan model',
      }),
    ).toBeInTheDocument()
  })
})
