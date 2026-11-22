import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupraspinaApi } from '../shared/contract'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc'
import { DEFAULT_PROJECT_CONFIG } from '../shared/project-schema'
import { STEP_KEYS, STEP_SCOPES } from '../shared/steps'

const mocks = vi.hoisted(() => {
  const listeners = new Map<
    string,
    Set<(event: unknown, message: unknown) => void>
  >()
  return {
    listeners,
    exposeInMainWorld: vi.fn(),
    invoke: vi.fn(
      async (channel: string, request: unknown): Promise<unknown> => {
        void channel
        void request
        return 'result'
      },
    ),
    on: vi.fn(
      (
        channel: string,
        listener: (event: unknown, message: unknown) => void,
      ) => {
        const set = listeners.get(channel) ?? new Set()
        set.add(listener)
        listeners.set(channel, set)
      },
    ),
    removeListener: vi.fn(
      (
        channel: string,
        listener: (event: unknown, message: unknown) => void,
      ) => {
        listeners.get(channel)?.delete(listener)
      },
    ),
  }
})

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: mocks.invoke,
    on: mocks.on,
    removeListener: mocks.removeListener,
  },
}))

async function loadApi(): Promise<SupraspinaApi> {
  vi.resetModules()
  await import('./index')
  expect(mocks.exposeInMainWorld).toHaveBeenCalledOnce()
  expect(mocks.exposeInMainWorld.mock.calls[0]![0]).toBe('supraspina')
  return mocks.exposeInMainWorld.mock.calls[0]![1] as SupraspinaApi
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listeners.clear()
})

const DISPLAY_ID = 'display-000000000000000000000000'
const OTHER_DISPLAY_ID = 'display-111111111111111111111111'
const STEP_IDS = [-1, 0, 1, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 5.5, 9.5] as const

function validStepDescriptors() {
  return STEP_KEYS.map((key, index) => ({
    id: STEP_IDS[index],
    key,
    name: `Stage ${key}`,
    goal: `Validate ${key}.`,
    scope: STEP_SCOPES[key],
    dependencies: [],
  }))
}

function validWorkflowResult() {
  const summary = {
    planned: 0,
    started: 0,
    waiting: 0,
    blocked: 0,
    skipped: 0,
    message: 'No work is required.',
  }
  return {
    runId: null,
    disposition: 'planned',
    plan: {
      planId: 'plan-012345abcdef',
      analysisCohort: { subjectIds: [], sha256: 'a'.repeat(64) },
      selectedSubset: { subjectIds: [], sha256: 'b'.repeat(64) },
      nodes: [],
      blockers: [],
      summary,
    },
    summary,
  }
}

function validRegistryRecord() {
  return {
    subjectId: 'sub-001',
    age: 42,
    sex: 'F',
    sourceCohortLabel: 'CTRL',
    cohortRole: 'healthy',
    ais: null,
    tSinceSci: null,
    t1Availability: 'available',
    runnable: true,
    unavailableReason: null,
    qc: null,
    qcNote: '',
    qcTags: [],
    revision: 0,
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
}

function validSidecarResult(domain: string, method: string): unknown {
  const key = `${domain}.${method}`
  if (key === 'env.check') {
    return { groups: [], availableMemoryGB: null, capturedAt: 'now' }
  }
  if (key === 'env.optInInstall') {
    return { operationId: 'install-012345abcdef' }
  }
  if (key === 'env.installStatus') {
    return { operations: [] }
  }
  if (key === 'env.createOutputDir') {
    return { ok: true, detail: 'Created the output directory.' }
  }
  if (key === 'env.toolStatus') {
    return { items: [], summary: 'ok', capturedAt: 'now' }
  }
  if (
    [
      'provision.pybrainage',
      'provision.braincharts',
      'provision.synthstrip',
      'provision.fastsurfer',
    ].includes(key)
  ) {
    return { operationId: 'provision-012345abcdef' }
  }
  if (key === 'provision.status') {
    return {
      envReady: false,
      modelReady: false,
      pythonExecutable: null,
      modelPath: null,
      scalerPath: null,
      projectId: 'project-1',
      projectEpoch: 1,
      configRevision: 0,
      operationId: null,
      phase: 'idle',
      cancellable: false,
      error: null,
    }
  }
  if (key === 'provision.cancel' || key === 'managedResource.cancel') {
    return {
      operationId:
        key === 'provision.cancel'
          ? 'provision-012345abcdef'
          : 'resource-012345abcdef',
      accepted: true,
      terminal: false,
    }
  }
  if (key === 'managedResource.importOffline') {
    return { operationId: 'resource-012345abcdef' }
  }
  if (key === 'surfaceRegistration.status') {
    return {
      configRevision: 0,
      method: 'sulc-fsaverage-pearson-v1',
      available: true,
      unavailableReason: null,
      rule: { zLimit: -3, floor: 0.7, minCohortHemispheres: 20 },
      reference: {
        source: 'builtin',
        hemispheres: 0,
        cortex: { median: 0.8342, scale: 0.0198 },
        dfp: { median: 0.8556, scale: 0.0235 },
      },
      operation: null,
      subjects: [],
      counts: {
        subjects: 0,
        checked: 0,
        pending: 0,
        failed: 0,
        missing: 0,
        flaggedSubjects: 0,
        flaggedHemispheres: 0,
      },
    }
  }
  if (key === 'surfaceRegistration.check') {
    return {
      operation: {
        operationId: 'srg-0123456789abcdef',
        state: 'done',
        total: 0,
        completed: 0,
        failed: 0,
        startedAt: '2026-09-25T06:00:00.000Z',
        finishedAt: '2026-09-25T06:00:00.000Z',
        message: null,
      },
      started: true,
    }
  }
  if (key === 'surfaceRegistration.cancel') {
    return { operationId: 'srg-0123456789abcdef', stopped: false }
  }
  if (key === 'registry.list') return []
  if (key === 'registry.upsert') return validRegistryRecord()
  if (key === 'registry.importCsv') {
    return {
      applied: true,
      imported: 1,
      updated: 0,
      skipped: 0,
      errors: [],
      warnings: [],
      errorTotal: 0,
      warningTotal: 0,
    }
  }
  if (key === 'registry.remove') return null
  if (key === 'registry.setSite') return { site: 'Prisma', updated: 2 }
  if (key === 'pipeline.listSteps') return validStepDescriptors()
  if (key === 'pipeline.previewCommand') return 'command --preview'
  if (
    [
      'pipeline.planWorkflow',
      'pipeline.runWorkflow',
      'pipeline.resumeWorkflow',
      'pipeline.retryWorkflow',
    ].includes(key)
  ) {
    return validWorkflowResult()
  }
  if (key === 'pipeline.cancelRun') {
    return {
      runId: 'run-1',
      accepted: true,
      terminal: false,
      pendingJobIds: [],
      message: 'Cancellation requested.',
    }
  }
  if (key === 'runtime.bootstrap') {
    return {
      project: {
        projectId: 'project-1',
        root: '/project',
        configPath: '/project/supraspina.project.json',
        epoch: 1,
      },
      sidecarGeneration: 1,
      sequence: 0,
      runs: [],
      jobs: [],
      logTail: [],
      provision: null,
    }
  }
  const manifest = {
    runId: 'run-1',
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: null,
    user: 'operator',
    host: 'host',
    git: { repo: '', sha: '', dirty: false },
    configSha256: 'c'.repeat(64),
    steps: [],
    tools: {},
  }
  if (key === 'manifest.forRun') return manifest
  if (key === 'manifest.list') return { items: [manifest], nextCursor: null }
  if (key === 'manifest.previewDebug') {
    return {
      runId: 'run-1',
      categories: [],
      totalFiles: 0,
      estimatedBytes: 0,
      redactionPolicy: 'Redact private paths.',
      truncated: false,
    }
  }
  if (key === 'manifest.bundleDebug') {
    return { artifactId: 'debug-1', displayPath: 'debug.zip' }
  }
  if (key === 'results.list') {
    return { items: [], nextCursor: null, truncated: false }
  }
  return 'result'
}

function validDisplay() {
  return {
    id: DISPLAY_ID,
    number: 1,
    primary: true,
    resolution: { width: 1920, height: 1080 },
    workArea: { width: 1920, height: 1040 },
    scaleFactor: 1,
  }
}

function validPlacementState() {
  return {
    preference: { mode: 'remember' as const },
    displays: [validDisplay()],
    resolvedDisplayId: DISPLAY_ID,
    fallbackReason: null,
  }
}

function validPreferencesState() {
  return {
    preferences: {
      schemaVersion: 1 as const,
      theme: 'system' as const,
      density: 'compact' as const,
      failureEmphasis: 'notice' as const,
      qcTone: 'notebook' as const,
      showCommandHints: true,
      textScale: '100' as const,
      reducedMotion: false,
      highContrast: false,
      autoUpdateCheck: true,
    },
    resolvedTheme: 'dark' as const,
  }
}

function validRuntimeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    runId: 'run-1',
    nodeId: 'node-1',
    projectId: 'project-1',
    projectEpoch: 1,
    sidecarGeneration: 1,
    stepKey: 'recon',
    subjectId: 'sub-001',
    scope: 'subject',
    plannedAt: 1,
    startedAt: 2,
    endedAt: null,
    exitCode: null,
    cmd: 'recon --synthetic',
    stdoutPath: '/project/logs/job-1.log',
    stderrPath: '/project/logs/job-1.log',
    envSnapshotPath: '',
    configSnapshotPath: '/project/state.json',
    status: 'running',
    dryRun: false,
    durable: true,
    persistenceStatus: 'durable',
    terminalReason: null,
    ...overrides,
  }
}

function validRuntimeEvent() {
  return {
    projectId: 'project-1',
    projectEpoch: 1,
    sidecarGeneration: 1,
    sequence: 4,
    runId: 'run-1',
    at: 3,
    kind: 'job',
    job: validRuntimeJob(),
  }
}

describe('sandbox preload bridge', () => {
  it('rejects malformed sidecar results and accepts a later valid response', async () => {
    const api = await loadApi()
    mocks.invoke.mockResolvedValueOnce(null).mockResolvedValueOnce({
      groups: [],
      availableMemoryGB: null,
      capturedAt: '2026-08-01T00:00:00Z',
    })

    await expect(api.env.check({} as never)).rejects.toThrow(
      /environment report/,
    )
    await expect(api.env.check({} as never)).resolves.toEqual({
      groups: [],
      availableMemoryGB: null,
      capturedAt: '2026-08-01T00:00:00Z',
    })
  })

  it('passes typed setup actions through the environment report intact', async () => {
    const api = await loadApi()
    const report = {
      groups: [
        {
          name: 'Python / conda',
          checks: [
            {
              id: 'pyenv',
              label: 'PyBrainAge environment',
              status: 'missing',
              action: { kind: 'setup-pybrainage', label: 'Set up PyBrainAge' },
            },
          ],
        },
      ],
      availableMemoryGB: null,
      capturedAt: '2026-08-01T00:00:00Z',
    }
    mocks.invoke.mockResolvedValueOnce(report)
    await expect(api.env.check({} as never)).resolves.toEqual(report)
  })

  it('exposes no arbitrary filesystem or shell primitives', async () => {
    const api = await loadApi()
    expect(Object.keys(api.fs).sort()).toEqual([
      'chooseDir',
      'chooseFile',
      'chooseSavePath',
    ])
    expect(api.fs).not.toHaveProperty('readText')
    expect(api.fs).not.toHaveProperty('exists')
    expect(api.fs).not.toHaveProperty('openExternal')
    expect(api).not.toHaveProperty('shell')
    expect(api).not.toHaveProperty('ipcRenderer')
  })

  it('uses the one invoke channel with exact domain/method envelopes', async () => {
    const api = await loadApi()
    const project = {
      projectId: 'project-1',
      root: '/project',
      configPath: '/project/supraspina.project.json',
      epoch: 4,
    }
    await api.host.retrySidecar()
    await api.project.close({ project })
    await api.execution.authorize({
      project,
      configRevision: 2,
      purpose: 'live-workflow',
    })
    await api.subjects.refreshOne({
      project,
      cfg: DEFAULT_PROJECT_CONFIG,
      configRevision: 2,
      subjectId: 'sub-007',
    })
    await api.qc.authoritativeRun({ project })
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, IPC_CHANNELS.invoke, {
      domain: 'host',
      method: 'retrySidecar',
      args: [],
    })
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, IPC_CHANNELS.invoke, {
      domain: 'project',
      method: 'close',
      args: [{ project }],
    })
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, IPC_CHANNELS.invoke, {
      domain: 'execution',
      method: 'authorize',
      args: [{ project, configRevision: 2, purpose: 'live-workflow' }],
    })
    expect(mocks.invoke).toHaveBeenNthCalledWith(4, IPC_CHANNELS.invoke, {
      domain: 'subjects',
      method: 'refreshOne',
      args: [
        {
          project,
          cfg: DEFAULT_PROJECT_CONFIG,
          configRevision: 2,
          subjectId: 'sub-007',
        },
      ],
    })
    expect(mocks.invoke).toHaveBeenNthCalledWith(5, IPC_CHANNELS.invoke, {
      domain: 'qc',
      method: 'authoritativeRun',
      args: [{ project }],
    })
  })

  it('reconstructs the typed PLAN_STALE action from the bounded IPC error', async () => {
    mocks.invoke.mockRejectedValueOnce(
      new Error(
        'Error invoking remote method: Error: SUPRASPINA_RPC_ERROR:{"code":"PLAN_STALE","action":{"id":"reviewAgain","label":"Review again"}}',
      ),
    )
    const api = await loadApi()

    await expect(api.pipeline.runWorkflow({} as never)).rejects.toMatchObject({
      name: 'PlanStaleError',
      code: 'PLAN_STALE',
      action: { id: 'reviewAgain', label: 'Review again' },
    })
  })

  it('passes the typed QC-absence answer through without an error', async () => {
    const answer = {
      runId: null,
      unavailable: {
        reason: 'noCurrentGallery',
        message:
          'Run ENIGMA QC under the saved project configuration to review galleries.',
      },
    }
    mocks.invoke.mockResolvedValueOnce(answer)
    const api = await loadApi()

    await expect(
      api.qc.authoritativeRun({ project: {} as never }),
    ).resolves.toEqual(answer)
  })

  it('keeps an internal failure that merely quotes the public marker internal', async () => {
    mocks.invoke.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'supraspina:invoke': Error: ENOENT: no such " +
          'file \'/private/subject/SUPRASPINA_RPC_ERROR:{"code":"BOUNDARY_EXPIRED"}\'',
      ),
    )
    const api = await loadApi()

    const rejection = await api.pipeline.runWorkflow({} as never).then(
      () => null,
      (error: unknown) => error,
    )

    // Main owns redaction; preload must simply refuse to promote this to a
    // trusted public recovery error.
    expect((rejection as Error).name).not.toBe('BoundaryExpiredError')
    expect((rejection as { code?: unknown }).code).toBeUndefined()
    expect((rejection as Error).message).not.toBe(
      'Retry the confirmation because it expired before an answer.',
    )
  })

  it('removes the Electron transport wrapper from an ordinary rejection', async () => {
    mocks.invoke.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'supraspina:invoke': Error: Scientific " +
          'runtime request failed (pipeline.retryWorkflow).',
      ),
    )
    const api = await loadApi()

    await expect(api.pipeline.retryWorkflow({} as never)).rejects.toThrow(
      'Scientific runtime request failed (pipeline.retryWorkflow).',
    )
  })

  it('keeps a rejection that carries no transport wrapper unchanged', async () => {
    const original = new Error('Fail the local file operation.')
    mocks.invoke.mockRejectedValueOnce(original)
    const api = await loadApi()

    await expect(api.pipeline.retryWorkflow({} as never)).rejects.toBe(original)
  })

  it('forwards every exposed command through its exact allowlisted envelope', async () => {
    const api = await loadApi()
    const marker = { marker: true }
    const preferencesState = validPreferencesState()
    const placementState = {
      preference: { mode: 'remember' },
      displays: [
        {
          id: 'display-000000000000000000000000',
          number: 1,
          primary: true,
          resolution: { width: 1920, height: 1080 },
          workArea: { width: 1920, height: 1040 },
          scaleFactor: 1,
        },
      ],
      resolvedDisplayId: 'display-000000000000000000000000',
      fallbackReason: null,
    }
    const managedRequest = {
      ...marker,
      resource: 'fastsurfer',
      variant: 'cpu',
    }
    const managedStatus = {
      resource: 'fastsurfer',
      variant: 'cpu',
      version: '2.5.4',
      state: 'missing',
      phase: 'idle',
      operationId: null,
      percent: null,
      cancellable: false,
      error: null,
      runtime: {
        found: true,
        path: '/usr/bin/apptainer',
        version: '1.5.3',
        expectedVersion: '1.5.3',
        ready: true,
        detail: null,
      },
    }
    const inputFovReview = {
      ...marker,
      subjectId: 'sub-001',
      sessionId: 'ses-baseline',
      acquisitionId: 'acq-prisma',
      preflightSignature: 'a'.repeat(64),
      sourceSha256: 'b'.repeat(64),
      outputSha256: 'c'.repeat(64),
      expectedRevision: 0,
      decision: 'approved',
    }
    const inputFovReviewResult = {
      decision: 'approved',
      revision: 1,
      configRevision: 0,
      reviewedAt: '2026-07-30T12:00:00.000Z',
      decisionSignature: 'd'.repeat(64),
      current: true,
    }
    mocks.invoke.mockImplementation(
      async (_channel: string, rawRequest: unknown) => {
        const request = rawRequest as { domain?: string; method?: string }
        return request.domain === 'managedResource' &&
          request.method === 'status'
          ? managedStatus
          : request.domain === 'inputFov' && request.method === 'list'
            ? { configRevision: 0, items: [] }
            : request.domain === 'inputFov' && request.method === 'review'
              ? inputFovReviewResult
              : request.domain === 'preferences'
                ? preferencesState
                : request.domain === 'windowPlacement' &&
                    request.method !== 'identifyDisplays'
                  ? placementState
                  : validSidecarResult(
                      String(request.domain ?? ''),
                      String(request.method ?? ''),
                    )
      },
    )
    const invokeCases: Array<[keyof SupraspinaApi, string, unknown[]]> = [
      ['project', 'create', [marker]],
      ['project', 'open', [marker]],
      ['project', 'close', [marker]],
      ['project', 'save', [marker]],
      ['project', 'validate', [marker]],
      ['host', 'getState', []],
      ['host', 'retrySidecar', []],
      ['preferences', 'get', []],
      ['preferences', 'patch', [marker]],
      ['preferences', 'reset', []],
      ['windowPlacement', 'getState', []],
      ['windowPlacement', 'setPreference', [{ mode: 'remember' }]],
      ['windowPlacement', 'moveNow', []],
      ['windowPlacement', 'identifyDisplays', []],
      ['platform', 'detect', []],
      ['platform', 'cpuCount', []],
      ['platform', 'toNative', ['source-path']],
      ['platform', 'fromNative', ['native-path']],
      ['fs', 'chooseDir', [marker]],
      ['fs', 'chooseFile', [marker]],
      ['fs', 'chooseSavePath', [marker]],
      ['external', 'openWeb', [marker]],
      ['external', 'openThirdPartyNotices', []],
      ['execution', 'authorize', [marker]],
      ['artifact', 'open', [marker]],
      ['artifact', 'reveal', [marker]],
      ['artifact', 'list', [marker]],
      ['artifact', 'readText', [marker]],
      ['artifact', 'previewImage', [marker]],
      ['qc', 'authoritativeRun', [marker]],
      ['env', 'check', [marker]],
      ['env', 'optInInstall', [marker]],
      ['env', 'installStatus', [marker]],
      ['env', 'createOutputDir', [marker]],
      ['env', 'toolStatus', [marker]],
      ['provision', 'pybrainage', [marker]],
      ['provision', 'braincharts', [marker]],
      ['provision', 'synthstrip', [marker]],
      ['provision', 'fastsurfer', [marker]],
      ['provision', 'status', [marker]],
      ['provision', 'cancel', [marker]],
      ['managedResource', 'status', [managedRequest]],
      ['managedResource', 'cancel', [managedRequest]],
      ['managedResource', 'importOffline', [managedRequest]],
      ['inputFov', 'list', [marker]],
      ['inputFov', 'review', [inputFovReview]],
      ['subjects', 'discover', [marker]],
      ['subjects', 'refreshOne', [marker]],
      ['subjects', 'openFolder', [marker]],
      ['subjects', 'openLog', [marker]],
      ['subjects', 'exportCsv', [marker]],
      ['subjects', 'markQc', [marker]],
      ['surfaceRegistration', 'status', [marker]],
      ['surfaceRegistration', 'check', [marker]],
      ['surfaceRegistration', 'cancel', [marker]],
      ['registry', 'list', [marker]],
      ['registry', 'upsert', [marker]],
      ['registry', 'chooseImportCsv', [marker]],
      ['registry', 'importCsv', [marker]],
      ['registry', 'saveExampleCsv', [marker]],
      ['registry', 'remove', [marker]],
      ['registry', 'setSite', [marker]],
      ['pipeline', 'listSteps', []],
      ['pipeline', 'previewCommand', [marker, 'recon', 'sub-001']],
      ['pipeline', 'planWorkflow', [marker]],
      ['pipeline', 'runWorkflow', [marker]],
      ['pipeline', 'resumeWorkflow', [marker]],
      ['pipeline', 'retryWorkflow', [marker]],
      ['pipeline', 'cancelRun', [marker]],
      ['runtime', 'bootstrap', [marker]],
      ['manifest', 'forRun', [marker]],
      ['manifest', 'list', [marker]],
      ['manifest', 'previewDebug', [marker]],
      ['manifest', 'bundleDebug', [marker]],
      ['results', 'list', [marker]],
      ['lifecycle', 'respondBoundary', [marker]],
      ['window', 'minimize', []],
      ['window', 'toggleMaximize', []],
      ['window', 'close', []],
      ['window', 'isMaximized', []],
      ['update', 'check', []],
      ['update', 'download', []],
      ['update', 'installNow', []],
      ['update', 'getStatus', []],
    ]

    for (const [domain, method, args] of invokeCases) {
      const domainApi = api[domain] as unknown as Record<string, unknown>
      const command = domainApi[method] as (...values: unknown[]) => unknown
      await command(...args)
    }

    expect(mocks.invoke).toHaveBeenCalledTimes(invokeCases.length)
    for (const [index, [domain, method, args]] of invokeCases.entries()) {
      expect(mocks.invoke).toHaveBeenNthCalledWith(
        index + 1,
        IPC_CHANNELS.invoke,
        { domain, method, args },
      )
    }
  })

  it('routes every typed event topic and removes every subscription', async () => {
    const api = await loadApi()
    const callbacks = {
      host: vi.fn(),
      envInstall: vi.fn(),
      provision: vi.fn(),
      provisionLog: vi.fn(),
      managedResource: vi.fn(),
      job: vi.fn(),
      stdout: vi.fn(),
      runtime: vi.fn(),
      boundary: vi.fn(),
      maximize: vi.fn(),
      preferences: vi.fn(),
      placement: vi.fn(),
      update: vi.fn(),
    }
    const unsubscribes = [
      api.host.onState(callbacks.host),
      api.env.onInstallProgress(callbacks.envInstall),
      api.provision.onProgress(callbacks.provision),
      api.provision.onLog(callbacks.provisionLog),
      api.managedResource.onProgress(callbacks.managedResource),
      api.pipeline.onJobUpdate(callbacks.job),
      api.pipeline.onStdout(callbacks.stdout),
      api.runtime.onEvent(callbacks.runtime),
      api.lifecycle.onBoundaryRequested(callbacks.boundary),
      api.window.onMaximizeChange(callbacks.maximize),
      api.preferences.onChanged(callbacks.preferences),
      api.windowPlacement.onTopologyChanged(callbacks.placement),
      api.update.onStatus(callbacks.update),
    ]
    const listeners = [
      ...(mocks.listeners.get(IPC_CHANNELS.event) ?? new Set()),
    ]
    expect(listeners).toHaveLength(unsubscribes.length)

    const emit = (topic: string, payload: unknown): void => {
      for (const listener of listeners) listener({}, { topic, payload })
    }
    const payloads = {
      host: { sidecar: { state: 'ready' } },
      envInstall: {
        operationId: 'install-012345abcdef',
        checkId: 'rpkgs',
        projectId: 'project-1',
        projectEpoch: 1,
        phase: 'running',
        startedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_001_000,
        output: 'Collecting dplyr\n',
        rc: null,
        stdout: '',
        stderr: '',
      },
      provision: {
        phase: 'download',
        percent: 50,
        message: 'Downloading the pinned archive.',
        projectId: 'project-1',
        projectEpoch: 1,
        operationId: 'provision-1',
      },
      managedResource: {
        resource: 'synthstrip',
        variant: 'cpu',
        version: '1.8',
        state: 'missing',
        phase: 'pulling',
        operationId: 'resource-012345abcdef',
        percent: null,
        cancellable: true,
        error: null,
        projectId: 'project-1',
        projectEpoch: 1,
      },
      job: validRuntimeJob(),
      runtime: validRuntimeEvent(),
      boundary: { requestId: 'request-1', intent: 'window-close' },
      update: { phase: 'disabled', capability: 'disabled' },
      preferences: validPreferencesState(),
      placement: {
        preference: { mode: 'remember' },
        displays: [
          {
            id: 'display-000000000000000000000000',
            number: 1,
            primary: true,
            resolution: { width: 1920, height: 1080 },
            workArea: { width: 1920, height: 1040 },
            scaleFactor: 1,
          },
        ],
        resolvedDisplayId: 'display-000000000000000000000000',
        fallbackReason: null,
      },
    }
    emit(IPC_EVENTS.hostState, payloads.host)
    emit(IPC_EVENTS.envInstallProgress, payloads.envInstall)
    emit(IPC_EVENTS.provisionProgress, payloads.provision)
    const provisionLog = {
      projectId: 'project-1',
      projectEpoch: 1,
      operationId: 'provision-012345abcdef',
      at: 1_700_000_000_000,
      line: 'Transaction finished',
    }
    emit(IPC_EVENTS.provisionLog, provisionLog)
    emit(IPC_EVENTS.provisionLog, { ...provisionLog, line: 42 })
    emit(IPC_EVENTS.managedResourceProgress, payloads.managedResource)
    emit(IPC_EVENTS.jobUpdate, payloads.job)
    emit(IPC_EVENTS.stdout, {
      jobId: 'job-1',
      line: 'safe output',
      lev: 'INFO',
    })
    emit(IPC_EVENTS.runtimeEvent, payloads.runtime)
    emit(IPC_EVENTS.lifecycleBoundary, payloads.boundary)
    emit(IPC_EVENTS.windowMaximize, 1)
    emit(IPC_EVENTS.preferencesChanged, payloads.preferences)
    emit(IPC_EVENTS.preferencesChanged, {
      ...payloads.preferences,
      stored: true,
    })
    emit(IPC_EVENTS.windowPlacementChanged, payloads.placement)
    emit(IPC_EVENTS.updateStatus, payloads.update)

    expect(callbacks.host).toHaveBeenCalledWith(payloads.host)
    expect(callbacks.envInstall).toHaveBeenCalledWith(payloads.envInstall)
    expect(callbacks.provision).toHaveBeenCalledWith(payloads.provision)
    expect(callbacks.provisionLog).toHaveBeenCalledOnce()
    expect(callbacks.provisionLog).toHaveBeenCalledWith(provisionLog)
    expect(callbacks.managedResource).toHaveBeenCalledWith(
      payloads.managedResource,
    )
    expect(callbacks.job).toHaveBeenCalledWith(payloads.job)
    expect(callbacks.stdout).toHaveBeenCalledWith(
      'job-1',
      'safe output',
      'INFO',
    )
    expect(callbacks.runtime).toHaveBeenCalledWith(payloads.runtime)
    expect(callbacks.boundary).toHaveBeenCalledWith(payloads.boundary)
    expect(callbacks.maximize).toHaveBeenCalledWith(true)
    expect(callbacks.preferences).toHaveBeenCalledWith(payloads.preferences)
    expect(callbacks.preferences).toHaveBeenCalledOnce()
    expect(callbacks.placement).toHaveBeenCalledWith(payloads.placement)
    expect(callbacks.update).toHaveBeenCalledWith(payloads.update)

    for (const unsubscribe of unsubscribes) unsubscribe()
    expect(mocks.listeners.get(IPC_CHANNELS.event)?.size).toBe(0)
    expect(mocks.removeListener).toHaveBeenCalledTimes(unsubscribes.length)
  })

  it('drops malformed/wrong-topic events and unsubscribes the exact listener', async () => {
    const api = await loadApi()
    const callback = vi.fn()
    const unsubscribe = api.host.onState(callback)
    const listener = [...(mocks.listeners.get(IPC_CHANNELS.event) ?? [])][0]!
    listener({}, null)
    listener({}, [])
    listener({}, { topic: 7, payload: {} })
    listener({}, { topic: IPC_EVENTS.hostState })
    listener({}, { topic: 'pipeline.stdout', payload: { secret: true } })
    expect(callback).not.toHaveBeenCalled()
    const state = { mode: 'electron', platform: 'linux' }
    listener({}, { topic: IPC_EVENTS.hostState, payload: state })
    expect(callback).toHaveBeenCalledWith(state)
    unsubscribe()
    expect(mocks.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.event,
      listener,
    )
    expect(mocks.listeners.get(IPC_CHANNELS.event)).not.toContain(listener)
  })

  it('drops malformed scientific events before renderer callbacks run', async () => {
    const api = await loadApi()
    const callbacks = {
      provision: vi.fn(),
      managed: vi.fn(),
      envInstall: vi.fn(),
      job: vi.fn(),
      stdout: vi.fn(),
      runtime: vi.fn(),
    }
    api.provision.onProgress(callbacks.provision)
    api.managedResource.onProgress(callbacks.managed)
    api.env.onInstallProgress(callbacks.envInstall)
    api.pipeline.onJobUpdate(callbacks.job)
    api.pipeline.onStdout(callbacks.stdout)
    api.runtime.onEvent(callbacks.runtime)
    const listeners = [
      ...(mocks.listeners.get(IPC_CHANNELS.event) ?? new Set()),
    ]
    const emit = (topic: string, payload: unknown): void => {
      for (const listener of listeners) listener({}, { topic, payload })
    }

    expect(() => {
      emit(IPC_EVENTS.provisionProgress, null)
      emit(IPC_EVENTS.managedResourceProgress, [])
      // A settled installation without an exit code violates the contract.
      emit(IPC_EVENTS.envInstallProgress, {
        operationId: 'install-012345abcdef',
        checkId: 'rpkgs',
        projectId: 'project-1',
        projectEpoch: 1,
        phase: 'done',
        startedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_001_000,
        output: '',
        rc: null,
        stdout: '',
        stderr: '',
      })
      emit(IPC_EVENTS.jobUpdate, { id: 'job-1', status: 'running' })
      emit(IPC_EVENTS.stdout, { jobId: 'job-1', line: 'missing level' })
      emit(IPC_EVENTS.stdout, {
        jobId: 'job-1',
        line: 'x'.repeat(65_537),
        lev: 'INFO',
      })
      emit(IPC_EVENTS.runtimeEvent, {
        ...validRuntimeEvent(),
        sequence: -1,
      })
    }).not.toThrow()

    for (const callback of Object.values(callbacks)) {
      expect(callback).not.toHaveBeenCalled()
    }

    emit(IPC_EVENTS.jobUpdate, {
      ...validRuntimeJob(),
      privateRuntimeState: 'must not cross the bridge',
    })
    expect(callbacks.job).toHaveBeenCalledWith(validRuntimeJob())
    expect(callbacks.job.mock.calls[0]![0]).not.toHaveProperty(
      'privateRuntimeState',
    )
  })

  it('rejects every malformed display projection before it reaches the renderer', async () => {
    const api = await loadApi()
    let response: unknown = validPlacementState()
    mocks.invoke.mockImplementation(async () => response)

    for (const preference of [
      null,
      [],
      { mode: 'remember', displayId: DISPLAY_ID },
      { mode: 'display', displayId: '1' },
      { mode: 'floating' },
    ]) {
      await expect(
        api.windowPlacement.setPreference(preference as never),
      ).rejects.toThrow(/Provide a valid window placement preference\./)
    }

    const base = validPlacementState()
    const face = validDisplay()
    const malformed: unknown[] = [
      null,
      {},
      { ...base, surprise: true },
      { ...base, preference: null },
      { ...base, displays: null },
      { ...base, displays: [] },
      { ...base, resolvedDisplayId: 7 },
      { ...base, resolvedDisplayId: 'native-1' },
      { ...base, fallbackReason: 'missing' },
      { ...base, unavailableDisplayLabel: '' },
      { ...base, unavailableDisplayLabel: 'Panel\u0007' },
      { ...base, unavailableDisplayLabel: 'x'.repeat(81) },
      { ...base, displays: [null] },
      { ...base, displays: [{ ...face, surprise: true }] },
      { ...base, displays: [{ ...face, id: '1' }] },
      {
        ...base,
        displays: [face, { ...face, number: 2, primary: false }],
      },
      { ...base, displays: [{ ...face, number: 0 }] },
      { ...base, displays: [{ ...face, number: 1.5 }] },
      {
        ...base,
        displays: [
          face,
          {
            ...face,
            id: OTHER_DISPLAY_ID,
            number: 1,
            primary: false,
          },
        ],
      },
      { ...base, displays: [{ ...face, primary: 'yes' }] },
      { ...base, displays: [{ ...face, resolution: null }] },
      { ...base, displays: [{ ...face, resolution: { width: 0, height: 1 } }] },
      {
        ...base,
        displays: [{ ...face, resolution: { width: 1, height: 0 } }],
      },
      { ...base, displays: [{ ...face, workArea: { width: 1 } }] },
      { ...base, displays: [{ ...face, scaleFactor: '1' }] },
      {
        ...base,
        displays: [{ ...face, scaleFactor: Number.POSITIVE_INFINITY }],
      },
      { ...base, displays: [{ ...face, scaleFactor: 0 }] },
      { ...base, displays: [{ ...face, scaleFactor: 17 }] },
      { ...base, displays: [{ ...face, label: '' }] },
      { ...base, displays: [{ ...face, label: 'Panel\u007f' }] },
      { ...base, displays: [{ ...face, primary: false }] },
      {
        ...base,
        displays: [
          face,
          {
            ...face,
            id: OTHER_DISPLAY_ID,
            number: 2,
          },
        ],
      },
      { ...base, resolvedDisplayId: OTHER_DISPLAY_ID },
      {
        ...base,
        fallbackReason: 'selected-display-unavailable',
      },
      { ...base, unavailableDisplayLabel: 'Disconnected panel' },
    ]
    for (const candidate of malformed) {
      response = candidate
      await expect(api.windowPlacement.getState()).rejects.toThrow(
        /Return valid display information from the desktop host\./,
      )
    }

    response = {
      ...base,
      preference: { mode: 'display', displayId: OTHER_DISPLAY_ID },
      displays: [{ ...face, label: 'Connected panel' }],
      fallbackReason: 'selected-display-unavailable',
      unavailableDisplayLabel: 'Disconnected panel',
    }
    await expect(api.windowPlacement.getState()).resolves.toEqual(response)
  })

  it('accepts only the exact current machine-preferences state', async () => {
    const api = await loadApi()
    let response: unknown = validPreferencesState()
    mocks.invoke.mockImplementation(async () => response)

    await expect(api.preferences.get()).resolves.toEqual(response)

    response = { ...validPreferencesState(), stored: true }
    await expect(api.preferences.get()).rejects.toThrow(
      /Return valid machine preferences from the desktop host\./,
    )

    response = null
    await expect(api.preferences.get()).rejects.toThrow(
      /Return valid machine preferences from the desktop host\./,
    )
  })

  it('sends exact PNG bytes and validates the analysis export result', async () => {
    const api = await loadApi()
    const project = {
      projectId: 'project-0',
      root: '/p',
      configPath: '/p/supraspina.project.json',
      epoch: 1,
    }
    const backing = new Uint8Array(4096)
    backing.set([1, 2, 3, 4], 100)
    const png = backing.subarray(100, 104)
    let response: unknown = {
      displayPath: '/p/exports/analysis/2026-09-30-x-2',
      folderName: '2026-09-30-x-2',
      files: [{ name: 'forest.pdf', bytes: 4, sha256: 'a'.repeat(64) }],
      provisional: false,
    }
    mocks.invoke.mockImplementation(async () => response)
    const request = {
      project,
      destinationId: 'd',
      resultId: 'gar-0123456789abcdef',
      folderName: '2026-09-30-x',
      subjectCsv: false,
      figures: [
        { kind: 'png' as const, stem: 'brain', png },
        { kind: 'svg' as const, stem: 'forest', svg: '<svg/>', pdf: true },
      ],
    }
    await expect(api.groupAnalysis.writeExport(request)).resolves.toEqual(
      response,
    )
    const [channel, envelope] = mocks.invoke.mock.calls[0]! as [
      string,
      { domain: string; method: string; args: [typeof request] },
    ]
    expect(channel).toBe(IPC_CHANNELS.invoke)
    expect(envelope.domain).toBe('groupAnalysis')
    expect(envelope.method).toBe('writeExport')
    const sent = envelope.args[0].figures[0] as { png: Uint8Array }
    expect([...sent.png]).toEqual([1, 2, 3, 4])
    // Only the view's bytes travel, not the 4 KiB backing buffer.
    expect(sent.png.buffer.byteLength).toBe(4)
    expect(envelope.args[0].figures[1]).toBe(request.figures[1])

    for (const name of [
      'forest.exe',
      '../forest.pdf',
      'Forest.pdf',
      'forest',
    ]) {
      response = {
        displayPath: '/p/x',
        folderName: 'x',
        files: [{ name, bytes: 1, sha256: 'a'.repeat(64) }],
        provisional: false,
      }
      await expect(api.groupAnalysis.writeExport(request)).rejects.toThrow(
        /export result/,
      )
    }
    response = {
      displayPath: '/p/x',
      files: [
        { name: 'a.csv', bytes: 1, sha256: 'a'.repeat(64) },
        { name: 'a.csv', bytes: 1, sha256: 'a'.repeat(64) },
      ],
      provisional: false,
    }
    await expect(api.groupAnalysis.writeExport(request)).rejects.toThrow(
      /export result/,
    )
    // The created folder name follows the request's name rule.
    for (const folderName of [undefined, '../x', 'X']) {
      response = {
        displayPath: '/p/x',
        folderName,
        files: [{ name: 'a.csv', bytes: 1, sha256: 'a'.repeat(64) }],
        provisional: false,
      }
      await expect(api.groupAnalysis.writeExport(request)).rejects.toThrow(
        /export result/,
      )
    }
  })

  it('forwards the v2 analysis and atlas methods and validates native results', async () => {
    const api = await loadApi()
    const project = {
      projectId: 'project-0',
      root: '/p',
      configPath: '/p/supraspina.project.json',
      epoch: 1,
    }
    let response: unknown = null
    mocks.invoke.mockImplementation(async () => response)
    await expect(
      api.groupAnalysis.chooseVariablesCsv({ project }),
    ).resolves.toBe(null)
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.invoke, {
      domain: 'groupAnalysis',
      method: 'chooseVariablesCsv',
      args: [{ project }],
    })
    response = { tableId: 'x' }
    await expect(
      api.groupAnalysis.chooseVariablesCsv({ project }),
    ).rejects.toThrow(/imported variables table/)
    response = 'yes'
    await expect(
      api.groupAnalysis.removeVariables({
        project,
        tableId: 'var-0123456789abcdef',
      }),
    ).rejects.toThrow(/variables removal/)
    response = true
    await expect(
      api.groupAnalysis.removeVariables({
        project,
        tableId: 'var-0123456789abcdef',
      }),
    ).resolves.toBe(true)
    response = null
    await expect(
      api.groupAnalysis.chooseAtlasFiles({
        project,
        recipeId: 'user-gcs',
        label: 'Schaefer',
        license: { name: 'MIT', url: null },
        externalSourceId: 'schaefer2018',
      }),
    ).resolves.toBeNull()
    response = { atlas: { atlasId: 'Bad' } }
    await expect(
      api.groupAnalysis.chooseLabelsFolder({ project, atlasId: 'thalamic' }),
    ).rejects.toThrow(/labels import result/)

    for (const [method, args] of [
      ['termRows', [{ project, resultId: 'r', termId: 't', offset: 0 }]],
      ['atlases', [{ project }]],
      ['labelStatus', [{ project, atlasId: null }]],
      ['labelCancel', [{ project, operationId: 'o' }]],
    ] as const) {
      response = { forwarded: method }
      const domainApi = api.groupAnalysis as unknown as Record<
        string,
        (...values: unknown[]) => Promise<unknown>
      >
      // The shared sidecar-result contract refuses the stand-in result.
      await expect(domainApi[method]!(...args)).rejects.toThrow(TypeError)
      expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.invoke, {
        domain: 'groupAnalysis',
        method,
        args,
      })
    }
    response = { forwarded: 'measureDetail' }
    await api.groupAnalysis
      .measureDetail({
        project,
        resultId: 'r',
        measureId: 'aseg:Brain-Stem',
        termId: 'term-1',
      })
      .catch(() => undefined)
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.invoke, {
      domain: 'groupAnalysis',
      method: 'measureDetail',
      args: [
        {
          project,
          resultId: 'r',
          measureId: 'aseg:Brain-Stem',
          termId: 'term-1',
        },
      ],
    })

    response = { cacheDisplayPath: '/u/atlases', sources: [] }
    await expect(api.atlasSources.list()).resolves.toEqual(response)
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.invoke, {
      domain: 'atlasSources',
      method: 'list',
      args: [],
    })
    response = { operation: { operationId: 'bad' } }
    await expect(api.atlasSources.status()).rejects.toThrow(
      /atlas download status/,
    )
    response = { operationId: 'adl-0123456789abcdef', stopped: true }
    await expect(
      api.atlasSources.cancel({ operationId: 'adl-0123456789abcdef' }),
    ).resolves.toEqual(response)
    response = { anything: true }
    await expect(
      api.atlasSources.openPage({ sourceId: 'schaefer2018', kind: 'license' }),
    ).resolves.toBeUndefined()
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.invoke, {
      domain: 'atlasSources',
      method: 'openPage',
      args: [{ sourceId: 'schaefer2018', kind: 'license' }],
    })
    const calls = mocks.invoke.mock.calls.length
    for (const bad of [
      { sourceId: 'schaefer2018' },
      { sourceId: 'schaefer2018', kind: 'citation' },
      { sourceId: 'schaefer2018', kind: 'page', url: 'https://x.org' },
      { sourceId: 7, kind: 'page' },
    ]) {
      await expect(
        api.atlasSources.openPage(
          bad as unknown as Parameters<typeof api.atlasSources.openPage>[0],
        ),
      ).rejects.toThrow(/atlas page request/)
    }
    expect(mocks.invoke.mock.calls.length).toBe(calls)
    response = 42
    await expect(api.atlasSources.chooseSubregionsPython()).rejects.toThrow(
      /interpreter path/,
    )
    response = '/opt/py312/bin/python'
    await expect(api.atlasSources.chooseSubregionsPython()).resolves.toBe(
      '/opt/py312/bin/python',
    )
    await expect(api.atlasSources.clearSubregionsPython()).resolves.toBe(
      undefined,
    )
  })

  it('forwards the gallery and analysis commands through their envelopes', async () => {
    const api = await loadApi()
    const marker = { marker: true }
    mocks.invoke.mockImplementation(async () => ({ forwarded: true }))
    const cases: ReadonlyArray<readonly [keyof typeof api, string]> = [
      ['qc', 'galleryImages'],
      ['qc', 'attestGalleryView'],
      ...(
        [
          'catalog',
          'inputs',
          'start',
          'status',
          'cancel',
          'list',
          'result',
          'saveSpec',
          'deleteSpec',
          'saveSet',
          'lockSet',
          'deleteSet',
          'chooseSetCsv',
          'chooseExportFolder',
          'labelStart',
          'clearLabels',
        ] as const
      ).map((method) => ['groupAnalysis', method] as const),
    ]
    for (const [domain, method] of cases) {
      const domainApi = api[domain] as unknown as Record<
        string,
        (...values: unknown[]) => Promise<unknown>
      >
      // A method with a sidecar-result contract refuses the stand-in result;
      // the envelope is what this test pins.
      await domainApi[method]!(marker).catch(() => undefined)
      expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.invoke, {
        domain,
        method,
        args: [marker],
      })
    }
  })

  it('forwards brain viewer reads and accepts only binary asset bytes', async () => {
    const api = await loadApi()
    const project = {
      projectId: 'project-0',
      root: '/p',
      configPath: '/p/supraspina.project.json',
      epoch: 1,
    }
    let response: unknown = {
      assetId: 'fsaverage/mri/brain.mgz',
      sha256: 'b'.repeat(64),
      data: new Uint8Array([0x1f, 0x8b]),
    }
    mocks.invoke.mockImplementation(async () => response)
    await expect(
      api.brainViewer.readAsset({
        project,
        assetId: 'fsaverage/mri/brain.mgz',
      }),
    ).resolves.toEqual(response)
    expect(mocks.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.invoke, {
      domain: 'brainViewer',
      method: 'readAsset',
      args: [{ project, assetId: 'fsaverage/mri/brain.mgz' }],
    })
    response = {
      assetId: 'fsaverage/mri/brain.mgz',
      sha256: 'b'.repeat(64),
      data: [0x1f, 0x8b],
    }
    await expect(
      api.brainViewer.readAsset({
        project,
        assetId: 'fsaverage/mri/brain.mgz',
      }),
    ).rejects.toThrow(/valid brain asset/)
    response = {
      available: true,
      unavailableReason: null,
      subjectId: null,
      assets: [{ assetId: '../etc/passwd', bytes: 1 }],
    }
    await expect(api.brainViewer.assets({ project })).rejects.toThrow(
      /brain asset entry/,
    )
  })
})
