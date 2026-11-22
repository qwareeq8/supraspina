import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { version as APP_VERSION } from '../../../package.json'
import type {
  HostState,
  ProvisionStatus,
  RunSnapshot,
  RuntimeEvent,
  RuntimeSnapshot,
  WorkflowSummary,
} from '../../shared/contract'
import type { Job, JobStatus, ProjectRef } from '../../shared/types'
import { RuntimeProvider } from './runtime-context'
import { useRuntime } from './runtime-state'

const mocks = vi.hoisted(() => ({
  app: null as unknown,
  bootstrap: vi.fn(),
  onEvent: vi.fn(),
  listeners: new Set<(event: unknown) => void>(),
}))

vi.mock('./context', () => ({ useApp: () => mocks.app }))
vi.mock('./api', () => ({
  getApi: () => ({
    runtime: {
      bootstrap: mocks.bootstrap,
      onEvent: mocks.onEvent,
    },
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
  started: 0,
  waiting: 0,
  blocked: 0,
  skipped: 0,
  message: 'Review the durable runtime snapshot.',
}

interface Projection {
  runIds: string[]
  runStatuses: string[]
  jobIds: string[]
  activeRunIds: string[]
  activeJobIds: string[]
  activeCount: number
  hydrating: boolean
  error: string | null
  authoritativeRuntimeKnown: boolean
  authorityState: string
}

function hostState(generation = 4): HostState {
  return {
    mode: 'electron',
    platform: 'linux',
    captionMode: 'custom',
    sidecar: {
      state: 'ready',
      generation,
      productVersion: APP_VERSION,
      protocolVersion: '1',
      persistenceVersions: {
        project: 1,
        runState: 1,
        manifest: 1,
        receipt: 1,
      },
      capabilities: [],
      runtimeId: `runtime-${generation}`,
      projectAttached: true,
      retryable: false,
      detail: null,
    },
  }
}

function runtimeApp(project: ProjectRef | null, generation = 4) {
  return { projectRef: project, hostState: hostState(generation) }
}

function runSnapshot(
  runId: string,
  overrides: Partial<RunSnapshot> = {},
): RunSnapshot {
  return {
    runId,
    projectId: PROJECT_A.projectId,
    projectEpoch: PROJECT_A.epoch,
    status: 'done',
    startedAt: 1,
    endedAt: 2,
    dryRun: false,
    durable: true,
    acknowledgements: {
      includeDeferredAndUnreviewedQc: false,
      acknowledgeMemoryAdvisory: false,
    },
    summary: SUMMARY,
    ...overrides,
  }
}

function jobSnapshot(
  id: string,
  status: JobStatus,
  overrides: Partial<Job> = {},
): Job {
  return {
    id,
    runId: `run-${id}`,
    stepKey: 'recon',
    subjectId: null,
    startedAt: status === 'running' ? 1 : null,
    endedAt: status === 'done' ? 2 : null,
    exitCode: status === 'done' ? 0 : null,
    cmd: 'recon-all',
    stdoutPath: '/logs/stdout',
    stderrPath: '/logs/stderr',
    envSnapshotPath: '/logs/env',
    configSnapshotPath: '/logs/config',
    status,
    ...overrides,
  }
}

function runtimeSnapshot(
  project: ProjectRef,
  options: {
    generation?: number
    sequence?: number
    runs?: RunSnapshot[]
    jobs?: Job[]
    provision?: ProvisionStatus | null
  } = {},
): RuntimeSnapshot {
  return {
    project,
    sidecarGeneration: options.generation ?? 4,
    sequence: options.sequence ?? 1,
    runs: options.runs ?? [],
    jobs: options.jobs ?? [],
    logTail: [],
    provision: options.provision ?? null,
  }
}

function runEvent(
  run: RunSnapshot,
  options: Partial<
    Omit<Extract<RuntimeEvent, { kind: 'run' }>, 'kind' | 'run'>
  > = {},
): RuntimeEvent {
  return {
    kind: 'run',
    projectId: PROJECT_A.projectId,
    projectEpoch: PROJECT_A.epoch,
    sidecarGeneration: 4,
    sequence: 2,
    runId: run.runId,
    at: 10,
    run,
    ...options,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function anonymousJobSnapshot(id: string, status: JobStatus): Job {
  const job = jobSnapshot(id, status)
  delete job.runId
  return job
}

function RuntimeProbe() {
  const runtime = useRuntime()
  const projection: Projection = {
    runIds: runtime.runs.map((run) => run.runId),
    runStatuses: runtime.runs.map((run) => run.status),
    jobIds: runtime.jobs.map((job) => job.id),
    activeRunIds: runtime.activeRuns.map((run) => run.runId),
    activeJobIds: runtime.activeJobs.map((job) => job.id),
    activeCount: runtime.activeCount,
    hydrating: runtime.hydrating,
    error: runtime.error,
    authoritativeRuntimeKnown: runtime.authoritativeRuntimeKnown,
    authorityState: runtime.authorityState,
  }
  return (
    <output data-testid="runtime-state">{JSON.stringify(projection)}</output>
  )
}

function projection(): Projection {
  return JSON.parse(
    screen.getByTestId('runtime-state').textContent ?? '{}',
  ) as Projection
}

function emit(event: RuntimeEvent): void {
  act(() => {
    for (const listener of mocks.listeners) listener(event)
  })
}

function renderRuntime() {
  return render(
    <RuntimeProvider>
      <RuntimeProbe />
    </RuntimeProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listeners.clear()
  mocks.app = runtimeApp(PROJECT_A)
  mocks.bootstrap.mockResolvedValue(runtimeSnapshot(PROJECT_A))
  mocks.onEvent.mockImplementation((listener: (event: unknown) => void) => {
    mocks.listeners.add(listener)
    return () => mocks.listeners.delete(listener)
  })
})

describe('project-scoped durable runtime projection', () => {
  it('stays inert without an active project', () => {
    mocks.app = runtimeApp(null)

    renderRuntime()

    expect(projection()).toMatchObject({
      runIds: [],
      jobIds: [],
      activeCount: 0,
      hydrating: false,
      error: null,
      authoritativeRuntimeKnown: true,
      authorityState: 'not-applicable',
    })
    expect(mocks.bootstrap).not.toHaveBeenCalled()
    expect(mocks.onEvent).not.toHaveBeenCalled()
  })

  it('counts noncancellable unsettled provisioning as active work', async () => {
    mocks.bootstrap.mockResolvedValue(
      runtimeSnapshot(PROJECT_A, {
        provision: {
          envReady: false,
          modelReady: false,
          pythonExecutable: null,
          modelPath: null,
          scalerPath: null,
          projectId: PROJECT_A.projectId,
          projectEpoch: PROJECT_A.epoch,
          configRevision: 3,
          operationId: 'provision-unsettled',
          phase: 'running',
          cancellable: false,
          error: 'Recover prior process ownership.',
        },
      }),
    )

    renderRuntime()

    await waitFor(() => expect(projection().activeCount).toBe(1))
    expect(projection().authoritativeRuntimeKnown).toBe(true)
  })

  it('accepts only the active project, epoch, generation, and forward sequence', async () => {
    mocks.bootstrap.mockResolvedValue(
      runtimeSnapshot(PROJECT_A, {
        sequence: 10,
        runs: [runSnapshot('run-old')],
      }),
    )
    renderRuntime()
    await waitFor(() => expect(projection().runIds).toEqual(['run-old']))

    expect(mocks.bootstrap).toHaveBeenCalledWith({
      project: PROJECT_A,
      runLimit: 100,
      logLimit: 2_000,
    })
    emit(
      runEvent(runSnapshot('run-wrong-project'), {
        projectId: PROJECT_B.projectId,
        sequence: 11,
      }),
    )
    emit(
      runEvent(runSnapshot('run-wrong-epoch'), {
        projectEpoch: PROJECT_A.epoch + 1,
        sequence: 11,
      }),
    )
    emit(
      runEvent(runSnapshot('run-stale-generation'), {
        sidecarGeneration: 3,
        sequence: 99,
      }),
    )
    emit(runEvent(runSnapshot('run-stale-sequence'), { sequence: 10 }))
    expect(projection().runIds).toEqual(['run-old'])

    emit(runEvent(runSnapshot('run-current'), { sequence: 11 }))
    expect(projection().runIds).toEqual(['run-current', 'run-old'])
  })

  it('replaces a launch-time queued run with the running snapshot the sidecar emits at job start', async () => {
    mocks.bootstrap.mockResolvedValue(
      runtimeSnapshot(PROJECT_A, {
        runs: [runSnapshot('run-live', { status: 'queued', endedAt: null })],
      }),
    )
    renderRuntime()
    await waitFor(() => expect(projection().runStatuses).toEqual(['queued']))

    emit(
      runEvent(runSnapshot('run-live', { status: 'running', endedAt: null })),
    )

    expect(projection()).toMatchObject({
      runIds: ['run-live'],
      runStatuses: ['running'],
      activeRunIds: ['run-live'],
    })
  })

  it('rejects a bootstrap response whose full project identity does not match', async () => {
    const pending = deferred<RuntimeSnapshot>()
    mocks.bootstrap.mockReturnValue(pending.promise)
    renderRuntime()
    await waitFor(() => expect(projection().hydrating).toBe(true))

    pending.resolve(
      runtimeSnapshot(
        { ...PROJECT_A, root: '/different-project-root' },
        {
          runs: [runSnapshot('run-foreign')],
        },
      ),
    )

    await waitFor(() => expect(projection().hydrating).toBe(false))
    expect(projection()).toMatchObject({
      runIds: [],
      activeCount: 1,
      authoritativeRuntimeKnown: false,
      authorityState: 'rejected',
      error:
        'The previous runtime snapshot identified another project than the current one.',
    })
  })

  it('rehydrates durable history when the sidecar generation advances', async () => {
    mocks.bootstrap
      .mockResolvedValueOnce(
        runtimeSnapshot(PROJECT_A, {
          generation: 4,
          sequence: 10,
          runs: [runSnapshot('run-history')],
        }),
      )
      .mockResolvedValueOnce(
        runtimeSnapshot(PROJECT_A, {
          generation: 5,
          sequence: 2,
          runs: [runSnapshot('run-restarted'), runSnapshot('run-history')],
        }),
      )
    renderRuntime()
    await waitFor(() => expect(projection().runIds).toEqual(['run-history']))

    emit(
      runEvent(runSnapshot('run-restarted'), {
        sidecarGeneration: 5,
        sequence: 1,
      }),
    )

    await waitFor(() => expect(mocks.bootstrap).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(projection().runIds).toEqual(['run-restarted', 'run-history']),
    )
    expect(mocks.listeners.size).toBe(1)

    emit(
      runEvent(runSnapshot('run-old-generation'), {
        sidecarGeneration: 4,
        sequence: 100,
      }),
    )
    expect(projection().runIds).toEqual(['run-restarted', 'run-history'])
  })

  it('rejects a late bootstrap from a project that has been replaced', async () => {
    const projectABootstrap = deferred<RuntimeSnapshot>()
    mocks.bootstrap.mockImplementation(
      ({ project }: { project: ProjectRef }) =>
        project.projectId === PROJECT_A.projectId
          ? projectABootstrap.promise
          : Promise.resolve(
              runtimeSnapshot(PROJECT_B, {
                runs: [
                  runSnapshot('run-project-b', {
                    projectId: PROJECT_B.projectId,
                    projectEpoch: PROJECT_B.epoch,
                  }),
                ],
              }),
            ),
    )
    const view = renderRuntime()
    await waitFor(() => expect(mocks.bootstrap).toHaveBeenCalledOnce())

    mocks.app = runtimeApp(PROJECT_B)
    view.rerender(
      <RuntimeProvider>
        <RuntimeProbe />
      </RuntimeProvider>,
    )
    await waitFor(() => expect(projection().runIds).toEqual(['run-project-b']))
    expect(mocks.listeners.size).toBe(1)

    await act(async () => {
      projectABootstrap.resolve(
        runtimeSnapshot(PROJECT_A, { runs: [runSnapshot('run-project-a')] }),
      )
      await projectABootstrap.promise
    })
    expect(projection().runIds).toEqual(['run-project-b'])
  })

  it('does not count ended dry-run projections as active work', async () => {
    mocks.bootstrap.mockResolvedValue(
      runtimeSnapshot(PROJECT_A, {
        runs: [
          runSnapshot('run-preview', {
            status: 'planned',
            dryRun: true,
            endedAt: 20,
          }),
          runSnapshot('run-live', {
            status: 'running',
            endedAt: null,
          }),
        ],
        jobs: [
          jobSnapshot('preview', 'planned', {
            runId: 'run-preview',
            dryRun: true,
            endedAt: 20,
          }),
          jobSnapshot('live', 'running', { runId: 'run-live' }),
          anonymousJobSnapshot('anonymous', 'queued'),
        ],
      }),
    )
    renderRuntime()

    await waitFor(() => expect(projection().runIds).toHaveLength(2))
    expect(projection()).toMatchObject({
      activeRunIds: ['run-live'],
      activeJobIds: ['live', 'anonymous'],
      activeCount: 2,
      authoritativeRuntimeKnown: true,
    })
  })

  it('counts unknown-only durable work as active even when it has an end timestamp', async () => {
    mocks.bootstrap.mockResolvedValue(
      runtimeSnapshot(PROJECT_A, {
        runs: [
          runSnapshot('run-unknown', {
            status: 'unknown',
            endedAt: 99,
          }),
        ],
        jobs: [
          jobSnapshot('unknown', 'unknown', {
            runId: 'run-unknown',
            endedAt: 99,
          }),
        ],
      }),
    )
    renderRuntime()

    await waitFor(() =>
      expect(projection().authoritativeRuntimeKnown).toBe(true),
    )
    expect(projection()).toMatchObject({
      activeRunIds: ['run-unknown'],
      activeJobIds: ['unknown'],
      activeCount: 1,
    })
  })

  it('never projects a pending or rejected bootstrap for an open project as idle', async () => {
    const pending = deferred<RuntimeSnapshot>()
    mocks.bootstrap.mockReturnValueOnce(pending.promise)
    renderRuntime()

    await waitFor(() => expect(projection().hydrating).toBe(true))
    expect(projection()).toMatchObject({
      authoritativeRuntimeKnown: false,
      authorityState: 'pending',
      activeCount: 1,
    })

    await act(async () => {
      pending.resolve(
        runtimeSnapshot(PROJECT_A, {
          generation: 3,
        }),
      )
      await pending.promise
    })
    await waitFor(() => expect(projection().hydrating).toBe(false))
    expect(projection()).toMatchObject({
      authoritativeRuntimeKnown: false,
      authorityState: 'rejected',
      activeCount: 1,
    })
  })
})
