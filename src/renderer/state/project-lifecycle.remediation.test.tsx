import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BoundaryRequest,
  ProvisionStatus,
  RunSnapshot,
  RuntimeSnapshot,
  WorkflowSummary,
} from '../../shared/contract'
import { BOUNDARY_EXPIRED_MESSAGE } from '../../shared/rpc-errors'
import type { Job, ProjectRef } from '../../shared/types'
import { THEMES } from '../theme/tokens'
import { ProjectLifecycleProvider } from './project-lifecycle'
import { useProjectLifecycle } from './project-lifecycle-state'
import type { RuntimeState } from './runtime-state'

const mocks = vi.hoisted(() => ({
  app: null as unknown,
  runtime: null as unknown,
  lifecycleDirty: false,
  lifecycleListener: null as ((request: BoundaryRequest) => void) | null,
  saveProject: vi.fn(),
  discardChanges: vi.fn(),
  onBoundaryRequested: vi.fn(),
  respondBoundary: vi.fn(),
  closeProject: vi.fn(),
  cancelRun: vi.fn(),
  bootstrap: vi.fn(),
  cancelProvision: vi.fn(),
  provisionStatus: vi.fn(),
  retrySidecar: vi.fn(),
  retryHydration: vi.fn(),
  refreshHostState: vi.fn(),
  mutationSnapshot: { pendingCount: 0, failedCount: 0 },
  flushMutations: vi.fn(),
  discardMutations: vi.fn(),
  closeWindow: vi.fn(),
  installUpdateNow: vi.fn(),
}))

vi.mock('./context', () => ({ useApp: () => mocks.app }))
vi.mock('./runtime-state', () => ({ useRuntime: () => mocks.runtime }))
vi.mock('./durable-mutations-state', () => ({
  useDurableMutations: () => ({
    revision: 0,
    snapshot: () => mocks.mutationSnapshot,
    flush: mocks.flushMutations,
    discard: mocks.discardMutations,
  }),
}))
vi.mock('./api', () => ({
  getApi: () => ({
    lifecycle: {
      onBoundaryRequested: mocks.onBoundaryRequested,
      respondBoundary: mocks.respondBoundary,
    },
    project: { close: mocks.closeProject },
    pipeline: { cancelRun: mocks.cancelRun },
    runtime: { bootstrap: mocks.bootstrap },
    provision: {
      cancel: mocks.cancelProvision,
      status: mocks.provisionStatus,
    },
    host: { retrySidecar: mocks.retrySidecar },
    window: { close: mocks.closeWindow },
    update: { installNow: mocks.installUpdateNow },
  }),
}))

const PROJECT_A: ProjectRef = {
  projectId: 'project-a',
  root: '/project-a',
  configPath: '/project-a/supraspina.project.json',
  epoch: 7,
}

const PROJECT_B: ProjectRef = {
  projectId: 'project-b',
  root: '/project-b',
  configPath: '/project-b/supraspina.project.json',
  epoch: 11,
}

const SUMMARY: WorkflowSummary = {
  planned: 0,
  started: 1,
  waiting: 0,
  blocked: 0,
  skipped: 0,
  message: 'Review runtime state.',
}

function runSnapshot(
  runId: string,
  status: RunSnapshot['status'] = 'running',
): RunSnapshot {
  const terminal = status === 'done' || status === 'cancelled'
  return {
    runId,
    projectId: PROJECT_A.projectId,
    projectEpoch: PROJECT_A.epoch,
    status,
    startedAt: 1,
    endedAt: terminal ? 2 : null,
    dryRun: false,
    durable: true,
    acknowledgements: {
      includeDeferredAndUnreviewedQc: false,
      acknowledgeMemoryAdvisory: false,
    },
    summary: SUMMARY,
  }
}

function jobSnapshot(
  id: string,
  runId: string,
  status: Job['status'] = 'running',
): Job {
  const terminal = status === 'done' || status === 'cancelled'
  return {
    id,
    runId,
    stepKey: 'recon',
    subjectId: null,
    startedAt: 1,
    endedAt: terminal ? 2 : null,
    exitCode: terminal ? 0 : null,
    cmd: 'recon-all',
    stdoutPath: '/logs/stdout',
    stderrPath: '/logs/stderr',
    envSnapshotPath: '/logs/env',
    configSnapshotPath: '/logs/config',
    status,
  }
}

function provisionStatus(
  phase: ProvisionStatus['phase'],
  operationId: string | null = 'provision-1',
): ProvisionStatus {
  return {
    envReady: phase === 'done',
    modelReady: phase === 'done',
    pythonExecutable: null,
    modelPath: null,
    scalerPath: null,
    projectId: PROJECT_A.projectId,
    projectEpoch: PROJECT_A.epoch,
    configRevision: 3,
    operationId,
    phase,
    cancellable: phase === 'running',
    error: null,
  }
}

function runtimeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    runs: [],
    jobs: [],
    logs: [],
    logReplay: { entries: new Map(), snapshotJobs: new Map() },
    provision: null,
    summary: null,
    hydrating: false,
    error: null,
    activeRuns: [],
    activeJobs: [],
    activeCount: 0,
    authoritativeRuntimeKnown: true,
    authorityState: 'known',
    retryHydration: mocks.retryHydration,
    ...overrides,
  }
}

function appState(project: ProjectRef | null, dirty: boolean) {
  return {
    t: THEMES.dark,
    projectRef: project,
    dirty,
    getLifecycleSnapshot: () => ({
      project,
      dirty: mocks.lifecycleDirty,
    }),
    saveProject: mocks.saveProject,
    discardChanges: mocks.discardChanges,
    refreshHostState: mocks.refreshHostState,
  }
}

function durableSnapshot(runs: RunSnapshot[], jobs: Job[]): RuntimeSnapshot {
  return {
    project: PROJECT_A,
    sidecarGeneration: 4,
    sequence: 20,
    runs,
    jobs,
    logTail: [],
    provision: null,
  }
}

/** Rebuild the rejected error as context isolation does, without its class or code. */
function bridgedBoundaryExpiry(): Error {
  return new Error(BOUNDARY_EXPIRED_MESSAGE)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function LifecycleProbe({ proceed }: { proceed: () => Promise<void> | void }) {
  const lifecycle = useProjectLifecycle()
  return (
    <button
      type="button"
      onClick={() => lifecycle.requestBoundary('open-project', proceed)}
    >
      Cross boundary
    </button>
  )
}

function renderLifecycle(proceed: () => Promise<void> | void) {
  return render(
    <ProjectLifecycleProvider>
      <LifecycleProbe proceed={proceed} />
    </ProjectLifecycleProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.lifecycleDirty = false
  mocks.lifecycleListener = null
  mocks.app = appState(PROJECT_A, false)
  mocks.runtime = runtimeState()
  mocks.onBoundaryRequested.mockImplementation(
    (listener: (request: BoundaryRequest) => void) => {
      mocks.lifecycleListener = listener
      return () => {
        if (mocks.lifecycleListener === listener) mocks.lifecycleListener = null
      }
    },
  )
  mocks.respondBoundary.mockResolvedValue(undefined)
  mocks.closeProject.mockResolvedValue(undefined)
  mocks.saveProject.mockImplementation(async () => {
    mocks.lifecycleDirty = false
    return {
      project: PROJECT_A,
      configRevision: 4,
      sha256: 'saved-sha',
    }
  })
  mocks.discardChanges.mockImplementation(async () => {
    mocks.lifecycleDirty = false
  })
  mocks.cancelRun.mockResolvedValue({
    runId: 'run-1',
    accepted: true,
    terminal: true,
    pendingJobIds: [],
    message: 'The run reached a terminal state.',
  })
  mocks.bootstrap.mockResolvedValue(
    durableSnapshot(
      [runSnapshot('run-1', 'done')],
      [jobSnapshot('job-1', 'run-1', 'done')],
    ),
  )
  mocks.cancelProvision.mockResolvedValue({
    operationId: 'provision-1',
    accepted: true,
    terminal: true,
  })
  mocks.provisionStatus.mockResolvedValue(provisionStatus('done'))
  mocks.retrySidecar.mockResolvedValue(undefined)
  mocks.mutationSnapshot = { pendingCount: 0, failedCount: 0 }
  mocks.flushMutations.mockImplementation(async () => {
    mocks.mutationSnapshot = { pendingCount: 0, failedCount: 0 }
  })
  mocks.discardMutations.mockImplementation(async () => {
    mocks.mutationSnapshot = { pendingCount: 0, failedCount: 0 }
  })
  mocks.closeWindow.mockReturnValue(new Promise<void>(() => undefined))
  mocks.installUpdateNow.mockReturnValue(new Promise<void>(() => undefined))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('guarded project lifecycle boundaries', () => {
  it('fails closed until an exact-project runtime bootstrap becomes authoritative', async () => {
    mocks.runtime = runtimeState({
      authoritativeRuntimeKnown: false,
      authorityState: 'pending',
      activeCount: 1,
    })
    const proceed = vi.fn()
    const view = renderLifecycle(proceed)

    fireEvent.click(screen.getByRole('button', { name: 'Cross boundary' }))
    expect(
      screen.getByRole('dialog', { name: 'Verify runtime state' }),
    ).toHaveTextContent(
      'Supraspina cannot prove that the current project is idle. Retry repeats the exact-project bootstrap, Recover recovers the supervised runtime, and Stay keeps the project as it is. Supraspina keeps every project, reload, close, quit, and update boundary blocked until a current same-project snapshot is accepted.',
    )
    expect(proceed).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mocks.retryHydration).toHaveBeenCalledOnce()
    expect(proceed).not.toHaveBeenCalled()

    mocks.runtime = runtimeState()
    view.rerender(
      <ProjectLifecycleProvider>
        <LifecycleProbe proceed={proceed} />
      </ProjectLifecycleProvider>,
    )
    await waitFor(() => expect(proceed).toHaveBeenCalledOnce())
  })

  it('offers bounded recovery without crossing an unverified runtime boundary', async () => {
    mocks.runtime = runtimeState({
      authoritativeRuntimeKnown: false,
      authorityState: 'rejected',
      activeCount: 1,
      error: 'bootstrap rejected',
    })
    const proceed = vi.fn()
    renderLifecycle(proceed)

    fireEvent.click(screen.getByRole('button', { name: 'Cross boundary' }))
    expect(screen.getByRole('alert')).toHaveTextContent('bootstrap rejected')
    fireEvent.click(screen.getByRole('button', { name: 'Recover' }))

    await waitFor(() => expect(mocks.retrySidecar).toHaveBeenCalledOnce())
    expect(mocks.refreshHostState).toHaveBeenCalledOnce()
    expect(mocks.retryHydration).toHaveBeenCalledOnce()
    expect(proceed).not.toHaveBeenCalled()
  })

  it.each([
    'window-close',
    'renderer-reload',
    'app-quit',
    'update-install',
  ] as const)(
    'rejects native %s while runtime authority is unknown',
    async (intent) => {
      mocks.runtime = runtimeState({
        authoritativeRuntimeKnown: false,
        authorityState: 'unavailable',
        activeCount: 1,
      })
      renderLifecycle(vi.fn())

      act(() => {
        mocks.lifecycleListener?.({
          requestId: `boundary-${intent}`,
          intent,
        })
      })
      expect(
        screen.getByRole('dialog', { name: 'Verify runtime state' }),
      ).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
      await waitFor(() =>
        expect(mocks.respondBoundary).toHaveBeenCalledWith({
          requestId: `boundary-${intent}`,
          decision: 'cancel',
        }),
      )
    },
  )

  it('explains an expired native close and asks again', async () => {
    mocks.respondBoundary.mockRejectedValueOnce(bridgedBoundaryExpiry())
    renderLifecycle(vi.fn())

    act(() => {
      mocks.lifecycleListener?.({
        requestId: 'boundary-expired-close',
        intent: 'window-close',
      })
    })

    const dialog = await screen.findByRole('dialog', {
      name: 'Retry the expired confirmation',
    })
    expect(dialog).toHaveTextContent(
      'The request for Supraspina to close expired.',
    )
    expect(dialog).toHaveTextContent(
      'Supraspina stays open and the project is unchanged.',
    )
    expect(dialog.textContent).not.toContain('supraspina:invoke')
    expect(dialog.textContent).not.toContain('token')
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Close again' }))
    await waitFor(() => expect(mocks.closeWindow).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers no renderer retry for an expired quit it cannot ask for again', async () => {
    mocks.respondBoundary.mockRejectedValueOnce(bridgedBoundaryExpiry())
    renderLifecycle(vi.fn())

    act(() => {
      mocks.lifecycleListener?.({
        requestId: 'boundary-expired-quit',
        intent: 'app-quit',
      })
    })

    const dialog = await screen.findByRole('dialog', {
      name: 'Retry the expired confirmation',
    })
    expect(dialog).toHaveTextContent('Request that quit again')
    expect(screen.queryByRole('button', { name: 'Close again' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mocks.closeWindow).not.toHaveBeenCalled()
    expect(mocks.respondBoundary).toHaveBeenCalledOnce()
  })

  it('treats an expired confirmation declined by the operator as already withdrawn', async () => {
    mocks.lifecycleDirty = true
    mocks.app = appState(PROJECT_A, true)
    mocks.respondBoundary.mockRejectedValueOnce(bridgedBoundaryExpiry())
    renderLifecycle(vi.fn())

    act(() => {
      mocks.lifecycleListener?.({
        requestId: 'boundary-expired-cancel',
        intent: 'window-close',
      })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mocks.closeWindow).not.toHaveBeenCalled()
  })

  it('keeps unknown-only scientific work active with bounded retry and recovery', async () => {
    const run = runSnapshot('run-unknown', 'unknown')
    const job = jobSnapshot('job-unknown', run.runId, 'unknown')
    mocks.runtime = runtimeState({
      runs: [run],
      jobs: [job],
      activeRuns: [run],
      activeJobs: [job],
      activeCount: 1,
    })
    const proceed = vi.fn()
    renderLifecycle(proceed)

    fireEvent.click(screen.getByRole('button', { name: 'Cross boundary' }))
    expect(
      screen.getByRole('dialog', {
        name: 'Choose how to recover scientific work',
      }),
    ).toHaveTextContent(
      'Scientific process ownership needs recovery before Supraspina continues. Supraspina keeps the project active and blocks duplicate work and project boundaries until recovery proves the old process tree is gone.',
    )
    expect(
      screen.queryByRole('button', { name: 'Cancel jobs and continue' }),
    ).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(mocks.retryHydration).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Recover' }))
    await waitFor(() => expect(mocks.retrySidecar).toHaveBeenCalledOnce())
    expect(mocks.refreshHostState).toHaveBeenCalledOnce()
    expect(mocks.retryHydration).toHaveBeenCalledTimes(2)
    expect(proceed).not.toHaveBeenCalled()
  })

  it('offers recovery instead of cancellation for unsettled provisioning', async () => {
    const provision = {
      ...provisionStatus('running'),
      cancellable: false,
      error: 'Recover prior provisioning ownership.',
    }
    mocks.runtime = runtimeState({
      provision,
      activeCount: 1,
    })
    const proceed = vi.fn()
    renderLifecycle(proceed)

    fireEvent.click(screen.getByRole('button', { name: 'Cross boundary' }))

    expect(
      screen.getByRole('dialog', {
        name: 'Choose how to recover scientific work',
      }),
    ).toHaveTextContent('Scientific process ownership needs recovery')
    expect(
      screen.queryByRole('button', { name: 'Cancel jobs and continue' }),
    ).toBeNull()
    expect(mocks.cancelProvision).not.toHaveBeenCalled()
    expect(proceed).not.toHaveBeenCalled()
  })

  it('requires an explicit decision for accepted persistent writes', async () => {
    mocks.mutationSnapshot = { pendingCount: 2, failedCount: 0 }
    const proceed = vi.fn()
    renderLifecycle(proceed)

    fireEvent.click(screen.getByRole('button', { name: 'Cross boundary' }))
    expect(
      screen.getByRole('dialog', {
        name: 'Choose how to handle pending project writes',
      }),
    ).toHaveTextContent(
      '2 pending persistent edits are not saved yet. Save or discard them',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(proceed).not.toHaveBeenCalled()
    expect(mocks.flushMutations).not.toHaveBeenCalled()
    expect(mocks.discardMutations).not.toHaveBeenCalled()
  })

  it('flushes pending writes before crossing and keeps the project on failure', async () => {
    mocks.mutationSnapshot = { pendingCount: 1, failedCount: 1 }
    mocks.flushMutations.mockRejectedValueOnce(new Error('revision conflict'))
    const proceed = vi.fn()
    renderLifecycle(proceed)

    fireEvent.click(screen.getByRole('button', { name: 'Cross boundary' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'revision conflict',
    )
    expect(proceed).not.toHaveBeenCalled()

    mocks.mutationSnapshot = { pendingCount: 1, failedCount: 1 }
    mocks.flushMutations.mockImplementationOnce(async () => {
      mocks.mutationSnapshot = { pendingCount: 0, failedCount: 0 }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))
    await waitFor(() => expect(proceed).toHaveBeenCalledOnce())
    expect(mocks.flushMutations).toHaveBeenCalledTimes(2)
  })

  it('waits for a just-clicked write before an approved native close', async () => {
    mocks.mutationSnapshot = { pendingCount: 1, failedCount: 0 }
    const flushing = deferred<void>()
    mocks.flushMutations.mockImplementationOnce(async () => {
      await flushing.promise
      mocks.mutationSnapshot = { pendingCount: 0, failedCount: 0 }
    })
    renderLifecycle(vi.fn())

    act(() => {
      mocks.lifecycleListener?.({
        requestId: 'boundary-pending-write',
        intent: 'window-close',
      })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(mocks.respondBoundary).not.toHaveBeenCalled()

    await act(async () => {
      flushing.resolve()
      await flushing.promise
    })
    await waitFor(() =>
      expect(mocks.respondBoundary).toHaveBeenCalledWith({
        requestId: 'boundary-pending-write',
        decision: 'proceed',
      }),
    )
  })

  it('keeps the project open when a dirty boundary is canceled', async () => {
    mocks.lifecycleDirty = true
    mocks.app = appState(PROJECT_A, true)
    const proceed = vi.fn()
    renderLifecycle(proceed)

    fireEvent.click(screen.getByRole('button', { name: 'Cross boundary' }))
    expect(
      screen.getByRole('dialog', {
        name: 'Choose how to handle project changes',
      }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'Choose how to handle project changes',
        }),
      ).not.toBeInTheDocument(),
    )
    expect(proceed).not.toHaveBeenCalled()
    expect(mocks.saveProject).not.toHaveBeenCalled()
    expect(mocks.discardChanges).not.toHaveBeenCalled()
  })

  it('saves dirty state before crossing the boundary', async () => {
    mocks.lifecycleDirty = true
    mocks.app = appState(PROJECT_A, true)
    const proceed = vi.fn()
    renderLifecycle(proceed)

    fireEvent.click(screen.getByRole('button', { name: 'Cross boundary' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(proceed).toHaveBeenCalledOnce())
    expect(mocks.saveProject).toHaveBeenCalledOnce()
    expect(mocks.discardChanges).not.toHaveBeenCalled()
  })

  it('discards dirty state before crossing the boundary', async () => {
    mocks.lifecycleDirty = true
    mocks.app = appState(PROJECT_A, true)
    const proceed = vi.fn()
    renderLifecycle(proceed)

    fireEvent.click(screen.getByRole('button', { name: 'Cross boundary' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    await waitFor(() => expect(proceed).toHaveBeenCalledOnce())
    expect(mocks.discardChanges).toHaveBeenCalledOnce()
    expect(mocks.saveProject).not.toHaveBeenCalled()
  })

  it('delegates native invalidation to main for the project adopted after listener registration', async () => {
    mocks.app = appState(null, false)
    const proceed = vi.fn()
    const view = renderLifecycle(proceed)
    expect(mocks.lifecycleListener).not.toBeNull()

    mocks.app = appState(PROJECT_B, false)
    view.rerender(
      <ProjectLifecycleProvider>
        <LifecycleProbe proceed={proceed} />
      </ProjectLifecycleProvider>,
    )
    act(() => {
      mocks.lifecycleListener?.({
        requestId: 'boundary-1',
        intent: 'window-close',
      })
    })

    await waitFor(() =>
      expect(mocks.respondBoundary).toHaveBeenCalledWith({
        requestId: 'boundary-1',
        decision: 'proceed',
      }),
    )
    expect(mocks.closeProject).not.toHaveBeenCalled()
  })

  it('retains a discarded draft and project authority when native crossing fails', async () => {
    mocks.lifecycleDirty = true
    mocks.app = appState(PROJECT_A, true)
    mocks.respondBoundary.mockRejectedValueOnce(new Error('close failed'))
    const proceed = vi.fn()
    renderLifecycle(proceed)

    act(() => {
      mocks.lifecycleListener?.({
        requestId: 'boundary-failed-cross',
        intent: 'window-close',
      })
    })
    expect(
      screen.getByRole('dialog', {
        name: 'Choose how to handle project changes',
      }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    await waitFor(() =>
      expect(mocks.respondBoundary).toHaveBeenCalledWith({
        requestId: 'boundary-failed-cross',
        decision: 'proceed',
      }),
    )
    const failed = await screen.findByRole('dialog', {
      name: 'Retry this boundary',
    })
    expect(failed).toHaveTextContent('close failed')
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )
    expect(mocks.lifecycleDirty).toBe(true)
    expect(mocks.discardChanges).not.toHaveBeenCalled()
    expect(mocks.closeProject).not.toHaveBeenCalled()
  })

  it('surfaces a stale native response and releases the latch after dismissal', async () => {
    mocks.respondBoundary
      .mockRejectedValueOnce(new Error('boundary request expired'))
      .mockResolvedValue(undefined)
    const proceed = vi.fn()
    renderLifecycle(proceed)
    expect(mocks.lifecycleListener).not.toBeNull()

    act(() => {
      mocks.lifecycleListener?.({
        requestId: 'boundary-stale',
        intent: 'window-close',
      })
    })
    await waitFor(() =>
      expect(mocks.respondBoundary).toHaveBeenCalledWith({
        requestId: 'boundary-stale',
        decision: 'proceed',
      }),
    )
    expect(
      await screen.findByRole('dialog', { name: 'Retry this boundary' }),
    ).toHaveTextContent('boundary request expired')
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )

    act(() => {
      mocks.lifecycleListener?.({
        requestId: 'boundary-current',
        intent: 'window-close',
      })
    })
    await waitFor(() =>
      expect(mocks.respondBoundary).toHaveBeenCalledWith({
        requestId: 'boundary-current',
        decision: 'proceed',
      }),
    )
    expect(mocks.closeProject).not.toHaveBeenCalled()
    expect(mocks.respondBoundary).not.toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'boundary-current',
        decision: 'cancel',
      }),
    )
  })

  it('allows one approved native unload and vetoes the next dirty unload', async () => {
    mocks.lifecycleDirty = true
    mocks.app = appState(PROJECT_A, true)
    const response = deferred<void>()
    mocks.respondBoundary.mockReturnValueOnce(response.promise)
    renderLifecycle(vi.fn())

    act(() => {
      mocks.lifecycleListener?.({
        requestId: 'boundary-approved-unload',
        intent: 'window-close',
      })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() =>
      expect(mocks.respondBoundary).toHaveBeenCalledWith({
        requestId: 'boundary-approved-unload',
        decision: 'proceed',
      }),
    )

    const approved = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(approved)
    expect(approved.defaultPrevented).toBe(false)

    const unapproved = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unapproved)
    expect(unapproved.defaultPrevented).toBe(true)

    await act(async () => {
      response.resolve(undefined)
      await response.promise
    })
  })

  it('continues after exact active work reaches an authoritative terminal state', async () => {
    const run = runSnapshot('run-1')
    const job = jobSnapshot('job-1', run.runId)
    const provision = provisionStatus('running')
    mocks.runtime = runtimeState({
      runs: [run],
      jobs: [job],
      provision,
      activeRuns: [run],
      activeJobs: [job],
      activeCount: 2,
    })
    mocks.cancelProvision.mockResolvedValue({
      operationId: 'provision-1',
      accepted: false,
      terminal: true,
    })
    const proceed = vi.fn()
    renderLifecycle(proceed)

    fireEvent.click(screen.getByRole('button', { name: 'Cross boundary' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel jobs and continue' }),
    )

    await waitFor(() => expect(proceed).toHaveBeenCalledOnce())
    expect(mocks.cancelRun).toHaveBeenCalledOnce()
    expect(mocks.cancelRun).toHaveBeenCalledWith({
      project: PROJECT_A,
      runId: 'run-1',
    })
    expect(mocks.cancelProvision).toHaveBeenCalledWith({
      project: PROJECT_A,
      operationId: 'provision-1',
    })
    expect(mocks.bootstrap).toHaveBeenCalled()
    expect(mocks.provisionStatus).toHaveBeenCalledWith({ project: PROJECT_A })
  })

  it('reblocks the boundary when unrelated work appears during cancellation', async () => {
    const originalRun = runSnapshot('run-original')
    mocks.runtime = runtimeState({
      runs: [originalRun],
      activeRuns: [originalRun],
      activeCount: 1,
    })
    mocks.cancelRun.mockResolvedValue({
      runId: originalRun.runId,
      accepted: true,
      terminal: false,
      pendingJobIds: [],
      message: 'Wait for cancellation to finish.',
    })
    const terminalBootstrap = deferred<RuntimeSnapshot>()
    mocks.bootstrap.mockReturnValue(terminalBootstrap.promise)
    const proceed = vi.fn()
    const view = renderLifecycle(proceed)

    fireEvent.click(screen.getByRole('button', { name: 'Cross boundary' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel jobs and continue' }),
    )
    await waitFor(() => expect(mocks.bootstrap).toHaveBeenCalledOnce())

    const unrelatedRun = runSnapshot('run-unrelated')
    mocks.runtime = runtimeState({
      runs: [unrelatedRun],
      activeRuns: [unrelatedRun],
      activeCount: 1,
    })
    view.rerender(
      <ProjectLifecycleProvider>
        <LifecycleProbe proceed={proceed} />
      </ProjectLifecycleProvider>,
    )
    terminalBootstrap.resolve(
      durableSnapshot([runSnapshot(originalRun.runId, 'cancelled')], []),
    )

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Review active work again before crossing this boundary.',
      ),
    )
    expect(proceed).not.toHaveBeenCalled()
    expect(
      screen.getByRole('dialog', {
        name: 'Confirm canceling active work',
      }),
    ).toBeInTheDocument()
  })

  it('keeps the boundary blocked when cancellation does not settle in time', async () => {
    vi.useFakeTimers()
    const run = runSnapshot('run-timeout')
    mocks.runtime = runtimeState({
      runs: [run],
      activeRuns: [run],
      activeCount: 1,
    })
    mocks.cancelRun.mockResolvedValue({
      runId: run.runId,
      accepted: true,
      terminal: false,
      pendingJobIds: ['job-timeout'],
      message: 'Wait for cancellation to finish.',
    })
    mocks.bootstrap.mockReturnValue(
      new Promise<RuntimeSnapshot>(() => undefined),
    )
    const proceed = vi.fn()
    renderLifecycle(proceed)

    fireEvent.click(screen.getByRole('button', { name: 'Cross boundary' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel jobs and continue' }),
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.bootstrap).toHaveBeenCalledOnce()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Retry cancellation until it reaches a terminal state.',
    )
    expect(proceed).not.toHaveBeenCalled()
    expect(
      screen.getByRole('dialog', {
        name: 'Confirm canceling active work',
      }),
    ).toBeInTheDocument()
  })
})
