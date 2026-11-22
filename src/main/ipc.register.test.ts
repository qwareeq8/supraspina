import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { version as APP_VERSION } from '../../package.json'
import { DEFAULT_PROJECT_CONFIG } from '../shared/project-schema'
import type {
  ExecutionAuthorization,
  ProjectOpenResult,
  WorkflowRequest,
} from '../shared/contract'
import { MATRIX_STEP_COUNT, STEP_KEYS, STEP_SCOPES } from '../shared/steps'
import { emptyCell } from '../shared/types'

type InvokeHandler = (event: unknown, request: unknown) => Promise<unknown>

let invokeHandler: InvokeHandler | null = null
const removeHandler = vi.fn()
const send = vi.fn()
const showOpenDialog = vi.fn()
const showSaveDialog = vi.fn()
const netFetch = vi.fn()
const frame = { url: 'file:///app/index.html' }
const sender = {
  id: 17,
  mainFrame: frame,
  getURL: () => frame.url,
  send,
}
const trustedRenderer = {
  url: frame.url,
  webContentsId: sender.id,
}
const fakeWindow = { webContents: sender }
const mainLog = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}

vi.mock('electron-log', () => ({ default: mainLog }))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (candidate: unknown) =>
      candidate === sender ? fakeWindow : null,
    getAllWindows: () => [fakeWindow],
  },
  dialog: {
    showOpenDialog,
    showSaveDialog,
  },
  net: { fetch: netFetch },
  ipcMain: {
    handle: (_channel: string, handler: InvokeHandler) => {
      invokeHandler = handler
    },
    removeHandler,
  },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
  },
}))

const READY_STATE = {
  state: 'ready' as const,
  generation: 1,
  productVersion: APP_VERSION,
  protocolVersion: '1',
  persistenceVersions: { project: 1, runState: 1, manifest: 1, receipt: 1 },
  capabilities: [
    'workflow-v1',
    'run-store-v1',
    'project-identity-v1',
    'runtime-events-v1',
    'artifact-resolution-v1',
    'cancellable-provision-v1',
  ],
  runtimeId: 'runtime-1',
  projectAttached: false,
  retryable: false,
  detail: null,
}

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

let notify:
  | ((notification: {
      method: string
      params: unknown
      generation: number
    }) => void)
  | null
let stateChanged: (() => void) | null

function makeSidecar() {
  return {
    call: vi.fn(async (method: string, args: unknown[]): Promise<unknown> => {
      void args
      if (method === 'pipeline.listSteps') return validStepDescriptors()
      if (
        [
          'pipeline.planWorkflow',
          'pipeline.runWorkflow',
          'pipeline.resumeWorkflow',
          'pipeline.retryWorkflow',
        ].includes(method)
      ) {
        return validWorkflowResult()
      }
      return 'sidecar-result'
    }),
    getState: vi.fn(() => READY_STATE),
    retry: vi.fn(async () => undefined),
    setProjectAttached: vi.fn(),
    setNotificationHandler: vi.fn((handler) => {
      notify = handler
    }),
    setStateHandler: vi.fn((handler) => {
      stateChanged = handler
    }),
  }
}

function trustedEvent() {
  return { sender, senderFrame: frame }
}

/** Mirror main's canonical config digest, which inventories are matched on. */
function canonicalConfigDigest(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item === null || typeof item !== 'object') return item
    const record = item as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, normalize(record[key])]),
    )
  }
  return createHash('sha256')
    .update(JSON.stringify(normalize(value)))
    .digest('hex')
}

function validRegistryRecord(overrides: Record<string, unknown> = {}) {
  return {
    subjectId: 'sub-0001',
    age: 40,
    sex: 'F',
    sourceCohortLabel: 'CTRL',
    cohortRole: 'healthy',
    ais: null,
    tSinceSci: null,
    t1Availability: 'available',
    runnable: true,
    unavailableReason: null,
    qc: 'pass',
    qcNote: '',
    qcTags: [],
    revision: 1,
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
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

function validRuntimeEvent(job = validRuntimeJob()) {
  return {
    projectId: 'project-1',
    projectEpoch: 1,
    sidecarGeneration: 1,
    sequence: 4,
    runId: 'run-1',
    at: 3,
    kind: 'job',
    job,
  }
}

function validProvisionProgress() {
  return {
    phase: 'download',
    percent: 50,
    message: 'Downloading the pinned archive.',
    projectId: 'project-1',
    projectEpoch: 1,
    operationId: 'provision-1',
  }
}

function validProvisionLog() {
  return {
    projectId: 'project-1',
    projectEpoch: 1,
    operationId: 'provision-1',
    at: 1_700_000_000_000,
    line: 'Transaction finished',
  }
}

function validManagedResourceRuntime(overrides: Record<string, unknown> = {}) {
  return {
    found: true,
    path: '/usr/bin/apptainer',
    version: '1.5.3',
    expectedVersion: '1.5.3',
    ready: true,
    detail: null,
    ...overrides,
  }
}

function validManagedResourceStatusResult(
  overrides: Record<string, unknown> = {},
) {
  return {
    resource: 'fastsurfer',
    variant: 'cpu',
    version: '2.5.4',
    state: 'missing',
    phase: 'idle',
    operationId: null,
    percent: null,
    cancellable: false,
    error: null,
    runtime: validManagedResourceRuntime(),
    ...overrides,
  }
}

function validManagedResourceProgress() {
  return {
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
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  frame.url = trustedRenderer.url
  invokeHandler = null
  notify = null
  stateChanged = null
})

afterEach(() => vi.restoreAllMocks())

describe('registerIpc trust and dispatch', () => {
  it('rejects malformed sidecar results and recovers for the next request', async () => {
    const { registerIpc } = await import('./ipc')
    const sidecar = makeSidecar()
    sidecar.call.mockResolvedValueOnce(null)
    registerIpc(sidecar as never, { trustedRenderer })

    const request = {
      domain: 'pipeline',
      method: 'listSteps',
      args: [],
    }
    await expect(invokeHandler!(trustedEvent(), request)).rejects.toThrow(
      /every pipeline step/,
    )
    await expect(invokeHandler!(trustedEvent(), request)).resolves.toEqual(
      validStepDescriptors(),
    )
  })

  it('routes exact native and sidecar allowlists only from the owning main frame', async () => {
    const { registerIpc } = await import('./ipc')
    const sidecar = makeSidecar()
    registerIpc(sidecar as never, { trustedRenderer })

    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'platform',
        method: 'detect',
        args: [],
      }),
    ).resolves.toMatch(/^(?:linux|wsl)$/)
    expect(sidecar.call).not.toHaveBeenCalled()

    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'pipeline',
        method: 'listSteps',
        args: [],
      }),
    ).resolves.toEqual(validStepDescriptors())
    expect(sidecar.call).toHaveBeenCalledWith('pipeline.listSteps', [])

    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'totally',
        method: 'unknown',
        args: [],
      }),
    ).rejects.toThrow(/allowlisted/)

    await expect(
      invokeHandler!(
        { sender, senderFrame: { url: frame.url } },
        {
          domain: 'platform',
          method: 'detect',
          args: [],
        },
      ),
    ).rejects.toThrow(/trusted renderer frame/)
  })

  it('keeps brain-FOV montage paths internal and injects trusted resource storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-scientific-ipc-'))
    const userDataPath = await mkdtemp(
      join(tmpdir(), 'supraspina-scientific-user-data-'),
    )
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Scientific IPC'
      cfg.project.createdAt = '2026-07-30T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const signature = 'a'.repeat(64)
      const qcPath = join(
        root,
        'derivatives',
        'supraspina-brainfov',
        'sub-001',
        'anat',
        `sub-001_desc-brainfov${signature.slice(0, 16)}_qc.png`,
      )
      await mkdir(join(qcPath, '..'), { recursive: true })
      await writeFile(qcPath, Buffer.from('\u0089PNG\r\n\u001a\n', 'latin1'))
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(
        async (method: string): Promise<unknown> => {
          if (method === 'inputFov.list') {
            return {
              configRevision: 0,
              items: [
                {
                  subjectId: 'sub-001',
                  sessionId: null,
                  acquisitionId: 'acq-prisma',
                  preflightSignature: signature,
                  sourceSha256: 'b'.repeat(64),
                  outputSha256: 'c'.repeat(64),
                  passThrough: false,
                  requiresReview: true,
                  qcArtifactId: `input-fov-qc:${signature}`,
                  qcDisplayPath: `supraspina-brainfov/sub-001/anat/sub-001_desc-brainfov${signature.slice(0, 16)}_qc.png`,
                  qcPath,
                  review: null,
                },
              ],
            }
          }
          if (method === 'inputFov.review') {
            return {
              decision: 'approved',
              revision: 1,
              configRevision: 0,
              reviewedAt: '2026-07-30T12:00:00.000Z',
              decisionSignature: 'd'.repeat(64),
              current: true,
            }
          }
          if (method === 'managedResource.status') {
            return validManagedResourceStatusResult()
          }
          if (method === 'pipeline.planWorkflow') return validWorkflowResult()
          if (method === 'results.list') {
            return { items: [], nextCursor: null, truncated: false }
          }
          return 'sidecar-result'
        },
      )
      registerIpc(sidecar as never, {
        trustedRenderer,
        userDataPath,
      })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      const projectRequest = {
        project: opened.project,
        cfg,
        configRevision: 0,
      }

      const listed = (await invokeHandler!(trustedEvent(), {
        domain: 'inputFov',
        method: 'list',
        args: [projectRequest],
      })) as { items: Array<Record<string, unknown>> }

      expect(listed.items[0]).not.toHaveProperty('qcPath')
      expect(listed.items[0]?.qcArtifactId).toBe(`input-fov-qc:${signature}`)
      const reviewRequest = {
        ...projectRequest,
        subjectId: 'sub-001',
        sessionId: 'ses-baseline',
        acquisitionId: 'acq-prisma',
        preflightSignature: signature,
        sourceSha256: 'b'.repeat(64),
        outputSha256: 'c'.repeat(64),
        expectedRevision: 0,
        decision: 'approved',
      }
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'inputFov',
          method: 'review',
          args: [reviewRequest],
        }),
      ).resolves.toMatchObject({ revision: 1, current: true })
      expect(sidecar.call).toHaveBeenLastCalledWith('inputFov.review', [
        reviewRequest,
      ])
      const incompleteReviewRequest: Partial<typeof reviewRequest> = {
        ...reviewRequest,
      }
      delete incompleteReviewRequest.sessionId
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'inputFov',
          method: 'review',
          args: [incompleteReviewRequest],
        }),
      ).rejects.toThrow(/unexpected fields/)
      expect(sidecar.call).toHaveBeenLastCalledWith('inputFov.review', [
        reviewRequest,
      ])
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'inputFov',
          method: 'review',
          args: [{ ...reviewRequest, acquisitionId: 'prisma' }],
        }),
      ).rejects.toThrow(/acquisition ID/)
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'inputFov',
          method: 'review',
          args: [{ ...reviewRequest, sessionId: 'baseline' }],
        }),
      ).rejects.toThrow(/session ID/)
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'artifact',
          method: 'previewImage',
          args: [
            {
              project: opened.project,
              artifactId: `input-fov-qc:${signature}`,
            },
          ],
        }),
      ).resolves.toMatchObject({ mimeType: 'image/png' })

      await invokeHandler!(trustedEvent(), {
        domain: 'managedResource',
        method: 'status',
        args: [
          {
            ...projectRequest,
            resource: 'fastsurfer',
            variant: 'cpu',
          },
        ],
      })
      expect(sidecar.call).toHaveBeenLastCalledWith('managedResource.status', [
        {
          ...projectRequest,
          resource: 'fastsurfer',
          variant: 'cpu',
          userDataPath,
        },
      ])
      const workflowRequest = {
        ...projectRequest,
        intent: { kind: 'workflow', target: { mode: 'all' } },
        acknowledgements: {
          includeDeferredAndUnreviewedQc: false,
          acknowledgeMemoryAdvisory: false,
        },
      }
      await invokeHandler!(trustedEvent(), {
        domain: 'pipeline',
        method: 'planWorkflow',
        args: [workflowRequest],
      })
      expect(sidecar.call).toHaveBeenLastCalledWith('pipeline.planWorkflow', [
        {
          ...workflowRequest,
          runtimeContext: { userDataPath },
        },
      ])
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'pipeline',
          method: 'planWorkflow',
          args: [
            {
              ...workflowRequest,
              runtimeContext: { userDataPath: '/renderer-controlled' },
            },
          ],
        }),
      ).rejects.toThrow(/Remove runtimeContext/)
      // The inventory signs receipts with the same managed-resource runtime
      // the planner used, so it needs the app's user-data path as well.
      await invokeHandler!(trustedEvent(), {
        domain: 'results',
        method: 'list',
        args: [{ project: opened.project }],
      })
      expect(sidecar.call).toHaveBeenLastCalledWith('results.list', [
        expect.objectContaining({
          project: opened.project,
          runtimeContext: { userDataPath },
        }),
      ])
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'results',
          method: 'list',
          args: [
            {
              project: opened.project,
              runtimeContext: { userDataPath: '/renderer-controlled' },
            },
          ],
        }),
      ).rejects.toThrow(/Remove runtimeContext/)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('signs the QC gallery authority search with trusted resource storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-qc-authority-'))
    const userDataPath = await mkdtemp(
      join(tmpdir(), 'supraspina-qc-authority-user-data-'),
    )
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'QC Authority'
      cfg.project.createdAt = '2026-07-30T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(
        async (method: string): Promise<unknown> => {
          if (method === 'manifest.list') {
            return {
              items: [{ runId: 'run-12345678', steps: [{ key: 'enigma' }] }],
              nextCursor: null,
            }
          }
          if (method === 'results.list') {
            return {
              items: [],
              nextCursor: null,
              truncated: false,
              runId: 'run-12345678',
              configSha256: '0'.repeat(64),
            }
          }
          return 'sidecar-result'
        },
      )
      registerIpc(sidecar as never, { trustedRenderer, userDataPath })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult

      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'qc',
          method: 'authoritativeRun',
          args: [{ project: opened.project }],
        }),
      ).resolves.toMatchObject({ runId: null })
      // The main process signs its own inventory calls like renderer ones.
      expect(sidecar.call).toHaveBeenCalledWith('results.list', [
        expect.objectContaining({
          runId: 'run-12345678',
          runtimeContext: { userDataPath },
        }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('relays managed-resource runtime readiness and rejects a malformed one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-managed-status-'))
    const userDataPath = await mkdtemp(
      join(tmpdir(), 'supraspina-managed-status-user-data-'),
    )
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Managed Status'
      cfg.project.createdAt = '2026-07-30T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      registerIpc(sidecar as never, { trustedRenderer, userDataPath })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      const statusRequest = {
        domain: 'managedResource',
        method: 'status',
        args: [
          {
            project: opened.project,
            cfg,
            configRevision: 0,
            resource: 'fastsurfer',
            variant: 'cpu',
          },
        ],
      }

      const ready = validManagedResourceStatusResult()
      sidecar.call.mockResolvedValueOnce(ready)
      await expect(
        invokeHandler!(trustedEvent(), statusRequest),
      ).resolves.toEqual(ready)

      sidecar.call.mockResolvedValueOnce(
        validManagedResourceStatusResult({
          runtime: validManagedResourceRuntime({ ready: false }),
        }),
      )
      await expect(
        invokeHandler!(trustedEvent(), statusRequest),
      ).rejects.toThrow(/consistent managed-resource runtime/)

      const lifecycleOnly: Record<string, unknown> =
        validManagedResourceStatusResult()
      delete lifecycleOnly.runtime
      sidecar.call.mockResolvedValueOnce(lifecycleOnly)
      await expect(
        invokeHandler!(trustedEvent(), statusRequest),
      ).rejects.toThrow(/valid managed-resource runtime/)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('binds privileged IPC to the exact renderer WebContents and full path', async () => {
    const { isTrustedIpcSender } = await import('./ipc')

    expect(isTrustedIpcSender(trustedEvent() as never, trustedRenderer)).toBe(
      true,
    )
    expect(
      isTrustedIpcSender(trustedEvent() as never, {
        ...trustedRenderer,
        url: 'file:///app/other.html',
      }),
    ).toBe(false)
    expect(
      isTrustedIpcSender(trustedEvent() as never, {
        ...trustedRenderer,
        webContentsId: trustedRenderer.webContentsId + 1,
      }),
    ).toBe(false)
    expect(
      isTrustedIpcSender(
        { sender, senderFrame: { url: frame.url } } as never,
        trustedRenderer,
      ),
    ).toBe(false)
  })

  it('rejects malformed, oversized, and event-classified invoke envelopes', async () => {
    const { registerIpc } = await import('./ipc')
    registerIpc(makeSidecar() as never, { trustedRenderer })
    await expect(invokeHandler!(trustedEvent(), null)).rejects.toThrow(
      /envelope/,
    )
    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'pipeline',
        method: 'onStdout',
        args: [],
      }),
    ).rejects.toThrow(/allowlisted/)
    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'pipeline',
        method: 'listSteps',
        args: ['x'.repeat(2 * 1024 * 1024 + 1)],
      }),
    ).rejects.toThrow(/Reduce the IPC request/)
  })

  it('lets an analysis spec of 20,000 long measure IDs through the IPC cap', async () => {
    const { registerIpc } = await import('./ipc')
    const sidecar = makeSidecar()
    registerIpc(sidecar as never, { trustedRenderer })
    // Every ID at the 160-character limit: 3.26 MB of JSON.
    const measures = Array.from({ length: 20_000 }, (_, index) => {
      const tail = String(index)
      return `vol:user-0123abcd:mid:${'x'.repeat(138 - tail.length)}${tail}`
    })
    expect(measures.every((id) => id.length === 160)).toBe(true)
    const invoke = (method: string, size: number) =>
      invokeHandler!(trustedEvent(), {
        domain: 'groupAnalysis',
        method,
        args: [
          {
            project: { projectId: 'stale' },
            spec: { measures },
            pad: 'x'.repeat(size),
          },
        ],
      })
    // Past the size check, the request fails on its stale project instead.
    await expect(invoke('inputs', 0)).rejects.toThrow(/stale or unknown/)
    await expect(invoke('start', 0)).rejects.toThrow(/stale or unknown/)
    // The rest of a maximal spec (subset levels, derived labels, tests, and
    // a quoted name, all escaped) adds about 0.2 MB.
    await expect(invoke('saveSpec', 512 * 1024)).rejects.toThrow(
      /stale or unknown/,
    )
    await expect(invoke('inputs', 1024 * 1024)).rejects.toThrow(
      /Reduce the IPC request/,
    )
    await expect(invoke('list', 0)).rejects.toThrow(/Reduce the IPC request/)
    expect(sidecar.call).not.toHaveBeenCalled()
  })

  it('requires project identity before project-scoped sidecar calls', async () => {
    const { registerIpc } = await import('./ipc')
    const sidecar = makeSidecar()
    registerIpc(sidecar as never, { trustedRenderer })
    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'results',
        method: 'list',
        args: [{ project: { projectId: 'stale' } }],
      }),
    ).rejects.toThrow(/stale or unknown/)
    expect(sidecar.call).not.toHaveBeenCalled()
  })

  it('forwards a project-free env.check as a validated host-scoped request', async () => {
    const { registerIpc } = await import('./ipc')
    const sidecar = makeSidecar()
    const report = {
      capturedAt: '2026-01-01T00:00:00.000Z',
      availableMemoryGB: 8,
      groups: [],
    }
    sidecar.call.mockResolvedValue(report)
    registerIpc(sidecar as never, { trustedRenderer })

    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'env',
        method: 'check',
        args: [{}],
      }),
    ).resolves.toEqual(report)
    expect(sidecar.call).toHaveBeenCalledWith('env.check', [{}])

    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'env',
        method: 'check',
        args: [{ ids: ['rscript'] }],
      }),
    ).resolves.toEqual(report)
    expect(sidecar.call).toHaveBeenCalledWith('env.check', [
      { ids: ['rscript'] },
    ])

    // Without a project, nothing except a bounded ids filter may cross.
    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'env',
        method: 'check',
        args: [{ cfg: { paths: {} } }],
      }),
    ).rejects.toThrow(/invalid fields in the env\.check request/)
    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'env',
        method: 'check',
        args: [{ ids: ['../escape'] }],
      }),
    ).rejects.toThrow(/valid check ids/)
    // A request that names a project keeps the full project envelope.
    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'env',
        method: 'check',
        args: [{ project: { projectId: 'stale' } }],
      }),
    ).rejects.toThrow(/stale or unknown/)
    expect(sidecar.call).toHaveBeenCalledTimes(2)
  })

  it('gates registry CSV import on the saved project and injects trusted config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-registry-import-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Registry import routing'
      cfg.project.createdAt = '2026-08-01T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(async (method: string) =>
        method === 'registry.importCsv'
          ? {
              applied: true,
              imported: 1,
              updated: 0,
              skipped: 0,
              errors: [],
              warnings: [],
              errorTotal: 0,
              warningTotal: 0,
            }
          : 'sidecar-result',
      )
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      const csvText =
        'subjectId,age,sex,sourceCohortLabel,ais,tSinceSci\nsub-0001,40,F,CTRL,,\n'

      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'registry',
          method: 'importCsv',
          args: [{ project: opened.project, csvText: 42, onExisting: 'skip' }],
        }),
      ).rejects.toThrow(/bounded CSV text/)
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'registry',
          method: 'importCsv',
          args: [
            {
              project: opened.project,
              csvText: 'a'.repeat(512 * 1024 + 1),
              onExisting: 'skip',
            },
          ],
        }),
      ).rejects.toThrow(/bounded CSV text/)
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'registry',
          method: 'importCsv',
          args: [{ project: opened.project, csvText, onExisting: 'merge' }],
        }),
      ).rejects.toThrow(/skip or update/)
      expect(sidecar.call).not.toHaveBeenCalledWith(
        'registry.importCsv',
        expect.anything(),
      )

      await invokeHandler!(trustedEvent(), {
        domain: 'registry',
        method: 'importCsv',
        args: [{ project: opened.project, csvText, onExisting: 'skip' }],
      })
      expect(sidecar.call).toHaveBeenCalledWith('registry.importCsv', [
        expect.objectContaining({
          project: opened.project,
          csvText,
          onExisting: 'skip',
          configRevision: 0,
          configSha256: opened.configSha256,
        }),
      ])

      await writeFile(
        join(root, 'supraspina.project.json'),
        '{"tampered": true}\n',
      )
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'registry',
          method: 'importCsv',
          args: [{ project: opened.project, csvText, onExisting: 'skip' }],
        }),
      ).rejects.toThrow(/changed on disk/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('validates registry.setSite fields and forwards the normalized request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-registry-site-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Registry site routing'
      cfg.project.createdAt = '2026-09-30T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(async (method: string) =>
        method === 'registry.setSite'
          ? { site: 'Ingenia', updated: 2 }
          : 'sidecar-result',
      )
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      const fields = {
        subjectIds: ['sub-101', 'sub-102'],
        site: ' Ingenia ',
        expectedRevisions: { 'sub-101': 1, 'sub-102': 4 },
      }
      for (const [request, message] of [
        [{ ...fields, extra: true }, /Correct the invalid fields/],
        [{ ...fields, site: 'Ingenia!' }, /Use a site label of 1 to 64/],
        [{ ...fields, subjectIds: [] }, /Select 1 to 20,000 subjects/],
        [
          { ...fields, expectedRevisions: { 'sub-101': 1 } },
          /saved revision of every subject/,
        ],
      ] as const) {
        await expect(
          invokeHandler!(trustedEvent(), {
            domain: 'registry',
            method: 'setSite',
            args: [{ project: opened.project, ...request }],
          }),
        ).rejects.toThrow(message)
      }
      expect(sidecar.call).not.toHaveBeenCalledWith(
        'registry.setSite',
        expect.anything(),
      )

      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'registry',
          method: 'setSite',
          args: [{ project: opened.project, ...fields }],
        }),
      ).resolves.toEqual({ site: 'Ingenia', updated: 2 })
      expect(sidecar.call).toHaveBeenCalledWith('registry.setSite', [
        expect.objectContaining({
          project: opened.project,
          subjectIds: ['sub-101', 'sub-102'],
          site: 'Ingenia',
          expectedRevisions: { 'sub-101': 1, 'sub-102': 4 },
          configRevision: 0,
          configSha256: opened.configSha256,
        }),
      ])

      await writeFile(
        join(root, 'supraspina.project.json'),
        '{"tampered": true}\n',
      )
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'registry',
          method: 'setSite',
          args: [{ project: opened.project, ...fields }],
        }),
      ).rejects.toThrow(/changed on disk/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires the license acceptance and a provision grant for BrainCharts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-braincharts-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'BrainCharts provisioning routing'
      cfg.project.createdAt = '2026-09-30T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(async (method: string) =>
        method === 'provision.braincharts'
          ? { operationId: 'provision-0123456789ab' }
          : 'sidecar-result',
      )
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'save',
        args: [
          {
            project: opened.project,
            cfg,
            configRevision: 1,
            safeExecution: true,
            expectedSha256: opened.configSha256,
          },
        ],
      })
      const authorization = (await invokeHandler!(trustedEvent(), {
        domain: 'execution',
        method: 'authorize',
        args: [
          { project: opened.project, configRevision: 1, purpose: 'provision' },
        ],
      })) as ExecutionAuthorization
      const base = {
        project: opened.project,
        cfg,
        configRevision: 1,
        authorization,
      }
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'provision',
          method: 'braincharts',
          args: [base],
        }),
      ).rejects.toThrow(/Correct the invalid fields/)
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'provision',
          method: 'braincharts',
          args: [{ ...base, licenseAccepted: false }],
        }),
      ).rejects.toThrow(/Accept the BrainCharts license notice/)
      expect(sidecar.call).not.toHaveBeenCalledWith(
        'provision.braincharts',
        expect.anything(),
      )

      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'provision',
          method: 'braincharts',
          args: [{ ...base, licenseAccepted: true }],
        }),
      ).resolves.toEqual({ operationId: 'provision-0123456789ab' })
      expect(sidecar.call).toHaveBeenCalledWith('provision.braincharts', [
        expect.objectContaining({
          project: opened.project,
          configRevision: 1,
          licenseAccepted: true,
        }),
      ])
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'provision',
          method: 'braincharts',
          args: [{ ...base, licenseAccepted: true }],
        }),
      ).rejects.toThrow(/fresh matching execution authorization/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('routes the surface-registration check with the saved config and exact fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-registration-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Registration routing'
      cfg.project.createdAt = '2026-09-25T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const operation = {
        operationId: 'srg-0123456789abcdef',
        state: 'running',
        total: 2,
        completed: 0,
        failed: 0,
        startedAt: '2026-09-25T06:00:00.000Z',
        finishedAt: null,
        message: null,
      }
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(async (method: string) =>
        method === 'surfaceRegistration.check'
          ? { operation, started: true }
          : method === 'surfaceRegistration.cancel'
            ? { operationId: operation.operationId, stopped: true }
            : 'sidecar-result',
      )
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult

      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'surfaceRegistration',
          method: 'status',
          args: [{ project: opened.project, cfg: { forged: true } }],
        }),
      ).rejects.toThrow(/invalid fields/)
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'surfaceRegistration',
          method: 'check',
          args: [{ project: opened.project, retryFailed: 'yes' }],
        }),
      ).rejects.toThrow(/true or false/)
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'surfaceRegistration',
          method: 'cancel',
          args: [{ project: opened.project, operationId: '../run' }],
        }),
      ).rejects.toThrow(/operation ID/)
      expect(sidecar.call).not.toHaveBeenCalledWith(
        expect.stringMatching(/^surfaceRegistration\./),
        expect.anything(),
      )

      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'surfaceRegistration',
          method: 'check',
          args: [{ project: opened.project, retryFailed: true }],
        }),
      ).resolves.toEqual({ operation, started: true })
      expect(sidecar.call).toHaveBeenCalledWith('surfaceRegistration.check', [
        {
          project: opened.project,
          retryFailed: true,
          cfg: expect.objectContaining({
            paths: expect.objectContaining({ projectRoot: root }),
          }),
          configRevision: 0,
          configSha256: opened.configSha256,
        },
      ])
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'surfaceRegistration',
          method: 'cancel',
          args: [
            { project: opened.project, operationId: operation.operationId },
          ],
        }),
      ).resolves.toEqual({ operationId: operation.operationId, stopped: true })
      // The result contract applies before anything reaches the renderer.
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'surfaceRegistration',
          method: 'status',
          args: [{ project: opened.project }],
        }),
      ).rejects.toThrow(/surface registration status/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('routes group analysis with the saved config, exact fields, and result contracts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-analysis-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Analysis routing'
      cfg.project.createdAt = '2026-09-30T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const catalog = {
        configRevision: 0,
        measures: [],
        variables: [],
        variableTables: [],
        inputs: [],
      }
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(async (method: string) =>
        method === 'groupAnalysis.catalog' ? catalog : 'sidecar-result',
      )
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      const call = (method: string, request: Record<string, unknown>) =>
        invokeHandler!(trustedEvent(), {
          domain: method.split('.')[0],
          method: method.split('.')[1],
          args: [{ project: opened.project, ...request }],
        })

      await expect(
        call('groupAnalysis.status', { cfg: { forged: true } }),
      ).rejects.toThrow(/invalid fields/)
      await expect(
        call('groupAnalysis.start', {
          spec: { schema: 'other' },
          stageCurrency: { aggregate: 'current', pybrainage: 'current' },
        }),
      ).rejects.toThrow(/analysis field/)
      await expect(
        call('groupAnalysis.cancel', { operationId: '../run' }),
      ).rejects.toThrow(/operation ID/)
      expect(sidecar.call).not.toHaveBeenCalledWith(
        expect.stringMatching(/^groupAnalysis\./),
        expect.anything(),
      )

      await expect(call('groupAnalysis.catalog', {})).resolves.toEqual(catalog)
      expect(sidecar.call).toHaveBeenCalledWith('groupAnalysis.catalog', [
        {
          project: opened.project,
          cfg: expect.objectContaining({
            paths: expect.objectContaining({ projectRoot: root }),
          }),
          configRevision: 0,
          configSha256: opened.configSha256,
        },
      ])
      // The result contract applies before anything reaches the renderer.
      await expect(call('groupAnalysis.list', {})).rejects.toThrow(
        /group-analysis list/,
      )

      await expect(
        call('brainViewer.readAsset', { assetId: '../../etc/passwd' }),
      ).rejects.toThrow(/allowlisted brain asset/)
      await expect(
        call('brainViewer.readAsset', {
          assetId: 'subject/mri/brain.mgz',
        }),
      ).rejects.toThrow(/subject volumes only/)
      const report = (await call('brainViewer.assets', {})) as {
        available: boolean
        unavailableReason: string | null
        subjectId: string | null
      }
      expect(report.subjectId).toBeNull()
      expect(report.available).toBe(report.unavailableReason === null)
      await expect(
        call('groupAnalysis.chooseExportFolder', { defaultName: '../x' }),
      ).rejects.toThrow(/export folder/)
      await expect(
        call('groupAnalysis.writeExport', {
          destinationId: 'unknown',
          resultId: 'gar-0123456789abcdef',
          folderName: '2026-09-30-sci-vs-ctrl',
          subjectCsv: false,
          figures: [],
        }),
      ).rejects.toThrow(/save destination/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('routes the v2 and labeling methods with exact fields and machine tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-atlases-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Atlas routing'
      cfg.project.createdAt = '2026-09-30T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const atlasCatalog = {
        configRevision: 0,
        revision: 0,
        atlases: [],
        tools: [],
        subregionsPython: null,
        labeling: null,
      }
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(async (method: string) =>
        method === 'groupAnalysis.atlases' ? atlasCatalog : 'sidecar-result',
      )
      registerIpc(sidecar as never, {
        trustedRenderer,
        userDataPath: join(root, 'user-data'),
      })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      const call = (method: string, request: Record<string, unknown>) =>
        invokeHandler!(trustedEvent(), {
          domain: method.split('.')[0],
          method: method.split('.')[1],
          args: [{ project: opened.project, ...request }],
        })

      await expect(
        call('groupAnalysis.atlases', {
          machine: { subregionsPython: '/x' },
          reconOutdatedSubjectIds: [],
        }),
      ).rejects.toThrow(/invalid fields/)
      await expect(
        call('groupAnalysis.labelStart', {
          atlasId: 'brainstem-ss',
          subjects: 'missing',
          jobs: 9,
          stageCurrency: { aggregate: 'current', pybrainage: 'current' },
        }),
      ).rejects.toThrow(/1 to 8 parallel/)
      await expect(
        call('groupAnalysis.labelStart', {
          atlasId: 'brainstem-ss',
          subjects: ['sub-101', 'sub-101'],
          jobs: 1,
          stageCurrency: { aggregate: 'current', pybrainage: 'current' },
        }),
      ).rejects.toThrow(/each once/)
      await expect(
        call('groupAnalysis.labelStart', {
          atlasId: 'brainstem-ss',
          subjects: 'missing',
          jobs: 1,
          stageCurrency: {
            aggregate: 'current',
            pybrainage: 'current',
            recon: { state: 'outdated', outdatedSubjectIds: ['../x'] },
          },
        }),
      ).rejects.toThrow(/reconstruction currency/)
      await expect(
        call('groupAnalysis.clearLabels', {
          atlasId: 'brainstem-ss',
          subjects: 'missing',
          expectedRevision: 0,
        }),
      ).rejects.toThrow(/each once/)
      await expect(
        call('groupAnalysis.labelStatus', { atlasId: 'Brainstem' }),
      ).rejects.toThrow(/atlas ID/)
      await expect(
        call('groupAnalysis.termRows', {
          resultId: 'gar-0123456789abcdef',
          termId: 'term-1',
          offset: -1,
        }),
      ).rejects.toThrow(/row offset/)
      expect(sidecar.call).not.toHaveBeenCalledWith(
        expect.stringMatching(/^groupAnalysis\./),
        expect.anything(),
      )

      await expect(
        call('groupAnalysis.atlases', { reconOutdatedSubjectIds: ['sub-1'] }),
      ).resolves.toEqual(atlasCatalog)
      expect(sidecar.call).toHaveBeenCalledWith('groupAnalysis.atlases', [
        {
          project: opened.project,
          reconOutdatedSubjectIds: ['sub-1'],
          machine: {
            subregionsPython: null,
            atlasCacheRoot: join(root, 'user-data', 'atlases'),
          },
          cfg: expect.objectContaining({
            paths: expect.objectContaining({ projectRoot: root }),
          }),
          configRevision: 0,
          configSha256: opened.configSha256,
        },
      ])
      // The labeling status carries no machine tools.
      await expect(
        call('groupAnalysis.labelStatus', { atlasId: null }),
      ).rejects.toThrow(/labeling status/)
      expect(sidecar.call).toHaveBeenLastCalledWith(
        'groupAnalysis.labelStatus',
        [expect.not.objectContaining({ machine: expect.anything() })],
      )

      await expect(
        call('groupAnalysis.chooseAtlasFiles', {
          recipeId: 'user-volume',
          label: 'Navigator',
          license: { name: 'NITRC', url: 'http://insecure' },
          externalSourceId: null,
        }),
      ).rejects.toThrow(/license/)
      await expect(
        call('groupAnalysis.chooseAtlasFiles', {
          recipeId: 'brainstem-ss',
          label: 'Navigator',
          license: { name: 'NITRC', url: null },
          externalSourceId: null,
        }),
      ).rejects.toThrow(/gcs, annot, or volume/)
      await expect(
        call('groupAnalysis.chooseLabelsFolder', { atlasId: '../x' }),
      ).rejects.toThrow(/atlas ID/)
      await expect(
        call('groupAnalysis.removeVariables', { tableId: 'var-x' }),
      ).rejects.toThrow(/variables table ID/)

      const atlasSources = (method: string, args: unknown[]) =>
        invokeHandler!(trustedEvent(), {
          domain: 'atlasSources',
          method,
          args,
        })
      const listed = (await atlasSources('list', [])) as {
        sources: { source: { sourceId: string }; downloadable: boolean }[]
      }
      expect(
        listed.sources
          .filter((item) => item.downloadable)
          .map((item) => item.source.sourceId),
      ).toEqual(['schaefer2018'])
      await expect(
        atlasSources('download', [
          { sourceId: 'schaefer2018', licenseAcknowledged: false },
        ]),
      ).rejects.toThrow(/Acknowledge the atlas license/)
      await expect(
        atlasSources('download', [
          { sourceId: 'brainnetome', licenseAcknowledged: true },
        ]),
      ).rejects.toThrow(/no verified download/)
      // The download runs over Electron's net.fetch; a refusal fails it.
      netFetch.mockResolvedValueOnce(new Response('no', { status: 503 }))
      const started = (await atlasSources('download', [
        { sourceId: 'schaefer2018', licenseAcknowledged: true },
      ])) as { started: boolean; operation: { operationId: string } }
      expect(started.started).toBe(true)
      await vi.waitFor(async () => {
        const status = (await atlasSources('status', [])) as {
          operation: { state: string; message: string }
        }
        expect(status.operation).toMatchObject({
          state: 'failed',
          message: expect.stringMatching(/answered 503 for LICENSE.md/),
        })
      })
      expect(netFetch).toHaveBeenCalledWith(
        expect.stringMatching(
          /^https:\/\/raw\.githubusercontent\.com\/ThomasYeoLab\/CBIG\//,
        ),
        expect.objectContaining({ redirect: 'error' }),
      )
      const { shell } = await import('electron')
      await atlasSources('openPage', [
        { sourceId: 'schaefer2018', kind: 'license' },
      ])
      expect(shell.openExternal).toHaveBeenLastCalledWith(
        'https://github.com/ThomasYeoLab/CBIG/blob/master/LICENSE.md',
      )
      await atlasSources('openPage', [{ sourceId: 'jhu', kind: 'page' }])
      expect(shell.openExternal).toHaveBeenLastCalledWith(
        'https://fsl.fmrib.ox.ac.uk/fsl/docs/other/datasets.html',
      )
      await expect(
        atlasSources('openPage', [{ sourceId: 'elsewhere', kind: 'page' }]),
      ).rejects.toThrow(/listed atlas source/)
      await expect(
        atlasSources('openPage', [{ sourceId: 'schaefer2018', kind: 'cite' }]),
      ).rejects.toThrow(/page or license/)
      await expect(
        atlasSources('openPage', [{ sourceId: 'schaefer2018' }]),
      ).rejects.toThrow(/atlas page request/)
      await expect(
        atlasSources('openPage', [
          {
            sourceId: 'schaefer2018',
            kind: 'license',
            url: 'https://example.org',
          },
        ]),
      ).rejects.toThrow(/atlas page request/)
      await expect(
        atlasSources('cancel', [{ operationId: 'alb-0123456789abcdef' }]),
      ).rejects.toThrow(/download operation ID/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'stores a subregions interpreter only after it checks as Python 3.12',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'supraspina-subregions-'))
      try {
        const good = join(root, 'good-python')
        const old = join(root, 'old-python')
        await writeFile(
          good,
          '#!/bin/sh\necho \'{"version": "3.12", "missing": []}\'\n',
          { mode: 0o755 },
        )
        await writeFile(
          old,
          '#!/bin/sh\necho \'{"version": "3.8", "missing": []}\'\n',
          { mode: 0o755 },
        )
        const preferences = {
          onStateChanged: vi.fn(() => () => undefined),
          getSubregionsPython: vi.fn(() => null),
          setSubregionsPython: vi.fn(),
        }
        const { registerIpc } = await import('./ipc')
        registerIpc(makeSidecar() as never, {
          trustedRenderer,
          preferences: preferences as never,
        })
        const choose = () =>
          invokeHandler!(trustedEvent(), {
            domain: 'atlasSources',
            method: 'chooseSubregionsPython',
            args: [],
          })
        showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
        await expect(choose()).resolves.toBeNull()
        showOpenDialog.mockResolvedValueOnce({
          canceled: false,
          filePaths: [old],
        })
        await expect(choose()).rejects.toThrow(/chosen one is Python 3.8/)
        expect(preferences.setSubregionsPython).not.toHaveBeenCalled()
        showOpenDialog.mockResolvedValueOnce({
          canceled: false,
          filePaths: [good],
        })
        await expect(choose()).resolves.toBe(good)
        expect(preferences.setSubregionsPython).toHaveBeenCalledWith(good)
        await expect(
          invokeHandler!(trustedEvent(), {
            domain: 'atlasSources',
            method: 'clearSubregionsPython',
            args: [],
          }),
        ).resolves.toBeUndefined()
        expect(preferences.setSubregionsPython).toHaveBeenLastCalledWith(null)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('hands only checked dialog picks to the analysis imports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-analysis-imports-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Analysis imports'
      cfg.project.createdAt = '2026-09-30T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const table = {
        tableId: 'var-0123456789abcdef',
        name: 'clinical.csv',
        idColumn: 'subject_id',
        sha256: 'a'.repeat(64),
        importedAt: '2026-09-30T00:00:00Z',
        rows: 2,
        unmatched: 0,
        columns: [{ column: 'UEMS', kind: 'numeric', n: 2, levels: [] }],
      }
      const atlas = {
        atlasId: 'user-0123abcd',
        label: 'Navigator',
        tier: 'B',
        kind: 'surface',
        origin: 'added',
        namespace: 'parc',
        recipeId: 'user-gcs',
        externalSourceId: null,
        available: true,
        unavailableReason: null,
        counts: {
          total: 2,
          withFiles: 0,
          labeled: 0,
          stale: 0,
          failed: 0,
          reconOutdated: 0,
        },
        estimateSeconds: 180,
        license: { name: 'MIT', url: null, acknowledgedAt: null },
        citation: null,
      }
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(async (method: string) => {
        if (method === 'groupAnalysis.importVariables') return table
        if (method === 'groupAnalysis.importAtlas') return { atlas }
        if (method === 'groupAnalysis.importAtlasLabels') {
          return { atlasId: 'brainstem-ss', imported: 2, unrecognized: [] }
        }
        return 'sidecar-result'
      })
      registerIpc(sidecar as never, {
        trustedRenderer,
        userDataPath: join(root, 'user-data'),
      })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      const call = (method: string, request: Record<string, unknown> = {}) =>
        invokeHandler!(trustedEvent(), {
          domain: 'groupAnalysis',
          method,
          args: [{ project: opened.project, ...request }],
        })
      const pick = (...filePaths: string[]) =>
        showOpenDialog.mockResolvedValueOnce({
          canceled: filePaths.length === 0,
          filePaths,
        })
      const picks = join(root, 'picks')
      await mkdir(join(picks, 'outputs'), { recursive: true })
      for (const name of [
        'clinical.csv',
        'clinical.xlsx',
        'lh.x.gcs',
        'rh.x.gcs',
      ]) {
        await writeFile(join(picks, name), 'subject_id,UEMS\n')
      }
      const imports = () =>
        sidecar.call.mock.calls
          .map(([method]) => method as string)
          .filter((method) => /^groupAnalysis\.import/.test(method))

      pick()
      await expect(call('chooseVariablesCsv')).resolves.toBeNull()
      pick(join(picks, 'clinical.xlsx'))
      await expect(call('chooseVariablesCsv')).rejects.toThrow(/ending in .csv/)
      expect(imports()).toEqual([])
      pick(join(picks, 'clinical.csv'))
      await expect(call('chooseVariablesCsv')).resolves.toEqual(table)
      expect(sidecar.call).toHaveBeenLastCalledWith(
        'groupAnalysis.importVariables',
        [
          expect.objectContaining({
            project: opened.project,
            path: join(picks, 'clinical.csv'),
            configSha256: opened.configSha256,
          }),
        ],
      )

      const atlasRequest = {
        recipeId: 'user-gcs',
        label: 'Navigator',
        license: { name: 'MIT', url: null },
        externalSourceId: null,
      }
      pick(join(picks, 'clinical.csv'))
      await expect(call('chooseAtlasFiles', atlasRequest)).rejects.toThrow(
        /ending in .gcs/,
      )
      pick(join(picks, 'lh.x.gcs'), join(picks, 'rh.x.gcs'))
      await expect(call('chooseAtlasFiles', atlasRequest)).resolves.toEqual({
        atlas,
      })
      expect(sidecar.call).toHaveBeenLastCalledWith(
        'groupAnalysis.importAtlas',
        [
          expect.objectContaining({
            paths: [join(picks, 'lh.x.gcs'), join(picks, 'rh.x.gcs')],
            recipeId: 'user-gcs',
            machine: {
              subregionsPython: null,
              atlasCacheRoot: join(root, 'user-data', 'atlases'),
            },
          }),
        ],
      )

      await symlink(join(picks, 'outputs'), join(picks, 'linked'))
      pick(join(picks, 'linked'))
      await expect(
        call('chooseLabelsFolder', { atlasId: 'brainstem-ss' }),
      ).rejects.toThrow(/not a link/)
      pick(join(picks, 'outputs'))
      await expect(
        call('chooseLabelsFolder', { atlasId: 'brainstem-ss' }),
      ).resolves.toEqual({
        atlasId: 'brainstem-ss',
        imported: 2,
        unrecognized: [],
      })
      expect(imports()).toEqual([
        'groupAnalysis.importVariables',
        'groupAnalysis.importAtlas',
        'groupAnalysis.importAtlasLabels',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('caps the export request structurally and every other request at 2 MiB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-analysis-size-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Analysis size caps'
      cfg.project.createdAt = '2026-09-30T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      const png = (bytes: number) => {
        const data = new Uint8Array(bytes)
        data.set([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49,
          0x48, 0x44, 0x52,
        ])
        return data
      }
      const writeExport = (figures: unknown[]) =>
        invokeHandler!(trustedEvent(), {
          domain: 'groupAnalysis',
          method: 'writeExport',
          args: [
            {
              project: opened.project,
              destinationId: 'unknown',
              resultId: 'gar-0123456789abcdef',
              folderName: '2026-09-30-sci-vs-ctrl',
              subjectCsv: false,
              figures,
            },
          ],
        })

      // A 3 MiB figure passes the size cap and stops at the grant check.
      await expect(
        writeExport([
          { kind: 'png', stem: 'brain', png: png(3 * 1024 * 1024) },
        ]),
      ).rejects.toThrow(/save destination/)
      await expect(
        writeExport([
          { kind: 'png', stem: 'brain', png: png(33 * 1024 * 1024) },
        ]),
      ).rejects.toThrow(/below the size limit/)
      await expect(
        writeExport([{ kind: 'png', stem: 'brain', png: new Map() }]),
      ).rejects.toThrow(/JSON-serializable/)
      // Every other method keeps the serialized 2 MiB cap.
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'registry',
          method: 'list',
          args: [{ project: opened.project, pad: 'x'.repeat(3 * 1024 * 1024) }],
        }),
      ).rejects.toThrow(/below the size limit/)
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'brainViewer',
          method: 'readAsset',
          args: [
            {
              project: opened.project,
              assetId: 'fsaverage/mri/brain.mgz',
              pad: new Uint8Array(3 * 1024 * 1024),
            },
          ],
        }),
      ).rejects.toThrow(/below the size limit/)
      expect(sidecar.call).not.toHaveBeenCalledWith(
        'registry.list',
        expect.anything(),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves durable reconstruction lineage in runtime snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-runtime-lineage-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Runtime lineage'
      cfg.project.createdAt = '2026-07-30T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const durableJob = {
        id: '#fallback',
        runId: 'run-12345678',
        nodeId: 'recon:sub-001:fallback',
        projectId: '',
        projectEpoch: 1,
        sidecarGeneration: 1,
        stepKey: 'recon',
        subjectId: 'sub-001',
        startedAt: 20,
        endedAt: 40,
        exitCode: 0,
        cmd: 'run_fastsurfer.sh --fsaparc',
        stdoutPath: '',
        stderrPath: '',
        envSnapshotPath: '',
        configSnapshotPath: '',
        status: 'done',
        backend: 'fastsurfer',
        attemptOrdinal: 2,
        role: 'fallback',
        supersedesJobId: '#primary',
        fallbackReasonTag: 'freesurfer_topology_failure',
      }
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(
        async (method: string, args: unknown[]): Promise<unknown> => {
          if (method === 'runtime.bootstrap') {
            const request = args[0] as { project: ProjectOpenResult['project'] }
            return {
              project: request.project,
              sidecarGeneration: 1,
              sequence: 1,
              runs: [],
              jobs: [
                {
                  ...durableJob,
                  projectId: request.project.projectId,
                  projectEpoch: request.project.epoch,
                },
              ],
              logTail: [],
              provision: null,
            }
          }
          return 'sidecar-result'
        },
      )
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult

      const result = (await invokeHandler!(trustedEvent(), {
        domain: 'runtime',
        method: 'bootstrap',
        args: [{ project: opened.project, runLimit: 100, logLimit: 2_000 }],
      })) as { jobs: Array<Record<string, unknown>> }

      expect(result.jobs[0]).toMatchObject({
        backend: 'fastsurfer',
        attemptOrdinal: 2,
        role: 'fallback',
        supersedesJobId: '#primary',
        fallbackReasonTag: 'freesurfer_topology_failure',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('strictly validates subject eligibility and preserves refresh request identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-subject-response-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Subject response validation'
      cfg.project.createdAt = '2026-07-22T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const validSubject = {
        id: 'sub-007',
        age: 42,
        sex: 'O',
        cohort: 'UNKNOWN',
        ais: null,
        tSinceSci: null,
        cells: Array.from({ length: MATRIX_STEP_COUNT }, () => emptyCell()),
        qc: 'fail',
        notes: '',
        registered: true,
        cohortRole: 'ambiguous',
        t1Availability: 'available',
        analysisEligible: true,
        unavailableReason: null,
      }
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      let refreshedSubjectId = 'sub-007'
      let discoveredSubject: unknown = {
        ...validSubject,
        analysisEligible: 'false',
      }
      sidecar.call.mockImplementation(
        async (method: string): Promise<unknown> => {
          if (method === 'subjects.discover') {
            return [discoveredSubject]
          }
          if (method === 'subjects.refreshOne') {
            return { ...validSubject, id: refreshedSubjectId }
          }
          return 'sidecar-result'
        },
      )
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      const request = {
        project: opened.project,
        cfg,
        configRevision: 0,
      }

      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'subjects',
          method: 'discover',
          args: [request],
        }),
      ).rejects.toThrow(/invalid subject/)

      const discover = (): Promise<unknown> =>
        invokeHandler!(trustedEvent(), {
          domain: 'subjects',
          method: 'discover',
          args: [request],
        })
      const invalidCell = (field: string, value: unknown): unknown[] => {
        const cells: unknown[] = Array.from({ length: MATRIX_STEP_COUNT }, () =>
          emptyCell(),
        )
        cells[0] = {
          ...(cells[0] as Record<string, unknown>),
          [field]: value,
        }
        return cells
      }
      const invalidSubjects: Array<[unknown, RegExp]> = [
        [null, /invalid subject/],
        [{ ...validSubject, id: '../sub-007' }, /invalid subject/],
        [{ ...validSubject, id: 'x'.repeat(129) }, /invalid subject/],
        [{ ...validSubject, age: Number.NaN }, /invalid subject/],
        [{ ...validSubject, registered: 'yes' }, /invalid subject/],
        [{ ...validSubject, sex: 'X' }, /invalid subject/],
        [{ ...validSubject, cohort: 'OTHER' }, /invalid subject/],
        [{ ...validSubject, ais: 'E' }, /invalid subject/],
        [
          { ...validSubject, tSinceSci: Number.POSITIVE_INFINITY },
          /invalid subject/,
        ],
        [{ ...validSubject, cells: null }, /invalid subject/],
        [{ ...validSubject, cells: [emptyCell()] }, /invalid subject/],
        [
          { ...validSubject, cells: invalidCell('st', 'unknown') },
          /invalid subject/,
        ],
        [
          { ...validSubject, cells: invalidCell('startedAt', Number.NaN) },
          /invalid subject/,
        ],
        [
          { ...validSubject, cells: invalidCell('finishedAt', 'now') },
          /invalid subject/,
        ],
        [
          { ...validSubject, cells: invalidCell('progress', {}) },
          /invalid subject/,
        ],
        [{ ...validSubject, cells: invalidCell('rc', []) }, /invalid subject/],
        [{ ...validSubject, cells: invalidCell('err', 7) }, /invalid subject/],
        [{ ...validSubject, qc: 'unknown' }, /invalid subject/],
        [{ ...validSubject, notes: 7 }, /invalid subject/],
        [{ ...validSubject, cohortRole: 'other' }, /subject role/],
        [{ ...validSubject, stepStates: [] }, /step states/],
        [{ ...validSubject, stepStates: { unknown: 'done' } }, /step states/],
        [{ ...validSubject, stepStates: { recon: 'unknown' } }, /step states/],
        [{ ...validSubject, qcTags: 'motion' }, /QC tags/],
        [{ ...validSubject, qcTags: [7] }, /QC tags/],
        [{ ...validSubject, qcRevision: -1 }, /QC revision/],
        [{ ...validSubject, qcRevision: 1.5 }, /QC revision/],
        [{ ...validSubject, t1Availability: 'unknown' }, /T1 availability/],
        [{ ...validSubject, unavailableReason: 7 }, /eligibility reason/],
        [{ ...validSubject, site: ' Prisma' }, /valid site/],
        [{ ...validSubject, site: 7 }, /valid site/],
      ]
      for (const [candidate, expected] of invalidSubjects) {
        discoveredSubject = candidate
        await expect(discover()).rejects.toThrow(expected)
      }
      for (const site of [null, 'Prisma']) {
        discoveredSubject = { ...validSubject, site }
        await expect(discover()).resolves.toMatchObject([{ site }])
      }

      discoveredSubject = { not: 'an array' }
      sidecar.call.mockImplementationOnce(async () => discoveredSubject)
      await expect(discover()).rejects.toThrow(/invalid subject list/)

      discoveredSubject = { ...validSubject, sourceCohortLabel: false }
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'subjects',
          method: 'discover',
          args: [request],
        }),
      ).rejects.toThrow(/source cohort label/)

      const callsBeforeInvalidId = sidecar.call.mock.calls.length
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'subjects',
          method: 'refreshOne',
          args: [{ ...request, subjectId: true }],
        }),
      ).rejects.toThrow(/valid subject ID for subjects\.refreshOne/)
      expect(sidecar.call).toHaveBeenCalledTimes(callsBeforeInvalidId)

      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'subjects',
          method: 'refreshOne',
          args: [{ ...request, subjectId: 'sub-007' }],
        }),
      ).resolves.toMatchObject({
        id: 'sub-007',
        qc: 'fail',
        analysisEligible: false,
      })
      expect(sidecar.call).toHaveBeenCalledWith('subjects.refreshOne', [
        expect.objectContaining({
          project: opened.project,
          configRevision: 0,
          subjectId: 'sub-007',
        }),
      ])

      refreshedSubjectId = 'sub-008'
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'subjects',
          method: 'refreshOne',
          args: [{ ...request, subjectId: 'sub-007' }],
        }),
      ).rejects.toThrow(/requested subject identity/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('validates draft project configuration without calling the sidecar', async () => {
    const { registerIpc } = await import('./ipc')
    const sidecar = makeSidecar()
    sidecar.call.mockRejectedValue(
      new Error('Reject an unexpected sidecar call.'),
    )
    registerIpc(sidecar as never, { trustedRenderer })

    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'validate',
        args: [DEFAULT_PROJECT_CONFIG],
      }),
    ).resolves.toMatchObject({
      errors: expect.arrayContaining([
        expect.stringMatching(/paths\.projectRoot.*non-empty path/),
      ]),
      warnings: [],
    })
    const rooted = structuredClone(DEFAULT_PROJECT_CONFIG)
    rooted.paths.projectRoot = '/tmp/supraspina-project'
    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'validate',
        args: [rooted],
      }),
    ).resolves.toMatchObject({
      errors: [],
      warnings: expect.arrayContaining([
        'Set the FreeSurfer folder in Diagnostics before running reconstruction.',
      ]),
    })
    await expect(
      invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'validate',
        args: [{ paths: { projectRoot: 42 } }],
      }),
    ).resolves.toMatchObject({
      errors: expect.arrayContaining([expect.stringMatching(/paths/)]),
      warnings: [],
    })
    expect(sidecar.call).not.toHaveBeenCalled()
  })

  it('validates the command preview step key and subject before forwarding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-command-preview-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Command preview'
      cfg.project.createdAt = '2026-08-01T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      registerIpc(sidecar as never, { trustedRenderer })
      await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })
      const preview = (args: unknown[]): Promise<unknown> =>
        invokeHandler!(trustedEvent(), {
          domain: 'pipeline',
          method: 'previewCommand',
          args,
        })

      // An unknown key reaches ADAPTERS[key] in the runtime as a raw KeyError.
      await expect(preview([cfg, 'not-a-step'])).rejects.toThrow(
        /valid step key for the command preview/,
      )
      await expect(preview([cfg, 'recon', '../escape'])).rejects.toThrow(
        /valid subject ID for the command preview/,
      )
      expect(sidecar.call).not.toHaveBeenCalledWith(
        'pipeline.previewCommand',
        expect.anything(),
      )

      await expect(preview([cfg, 'recon', 'sub-001'])).resolves.toBe(
        'sidecar-result',
      )
      await expect(preview([cfg, 'recon'])).resolves.toBe('sidecar-result')
      expect(sidecar.call).toHaveBeenCalledWith('pipeline.previewCommand', [
        cfg,
        'recon',
        'sub-001',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('redacts local filesystem details from renderer-facing errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-private-path-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Private path error test'
      cfg.project.createdAt = '2026-07-22T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const missing = join(
        root,
        'derivatives',
        'participant-X9-private-result.txt',
      )
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(
        async (method: string): Promise<unknown> =>
          method === 'results.resolveArtifact'
            ? { path: missing, kind: 'file', exists: true }
            : 'sidecar-result',
      )
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult

      let caught: unknown
      try {
        await invokeHandler!(trustedEvent(), {
          domain: 'artifact',
          method: 'readText',
          args: [{ project: opened.project, artifactId: 'missing-private' }],
        })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toMatch(
        /retry the local file operation/,
      )
      expect((caught as Error).message).not.toContain(root)
      expect((caught as Error).message).not.toContain('participant-X9')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('enforces saved-config, one-use authorization, and removed-method backstops', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-dispatch-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Live authorization test'
      cfg.project.createdAt = '2026-07-22T00:00:00.000Z'
      cfg.paths.projectRoot = root
      cfg.runtime.dryRun = false
      const planDigest = 'a'.repeat(64)
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      for (const purpose of [
        'live-workflow',
        'provision',
        'opt-in-install',
        'cleanup',
      ] as const) {
        await expect(
          invokeHandler!(trustedEvent(), {
            domain: 'execution',
            method: 'authorize',
            args: [
              {
                project: opened.project,
                configRevision: 0,
                purpose,
                ...(['live-workflow', 'cleanup'].includes(purpose)
                  ? { planDigest }
                  : {}),
              },
            ],
          }),
        ).rejects.toThrow(/Turn on and save Allow live runs/i)
      }
      const saved = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'save',
        args: [
          {
            project: opened.project,
            cfg,
            configRevision: 1,
            safeExecution: true,
            expectedSha256: opened.configSha256,
          },
        ],
      })) as { sha256: string }
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'project',
          method: 'save',
          args: [
            {
              project: opened.project,
              cfg,
              configRevision: 1,
              safeExecution: false,
              expectedSha256: saved.sha256,
            },
          ],
        }),
      ).rejects.toThrow(/configRevision.*execution posture/)
      const base: WorkflowRequest = {
        project: opened.project,
        cfg,
        configRevision: 1,
        intent: { kind: 'workflow', target: { mode: 'all' } },
        acknowledgements: {
          includeDeferredAndUnreviewedQc: false,
          acknowledgeMemoryAdvisory: false,
        },
        approvedPlan: {
          planId: 'run-abcdef123456',
          digest: planDigest,
        },
      }

      const unreviewedBase = structuredClone(base)
      delete unreviewedBase.approvedPlan
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'pipeline',
          method: 'runWorkflow',
          args: [unreviewedBase],
        }),
      ).rejects.toThrow(/exact workflow plan/)
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'pipeline',
          method: 'runWorkflow',
          args: [base],
        }),
      ).rejects.toThrow(/one-use execution authorization/)

      const authorization = (await invokeHandler!(trustedEvent(), {
        domain: 'execution',
        method: 'authorize',
        args: [
          {
            project: opened.project,
            configRevision: 1,
            purpose: 'live-workflow',
            planDigest,
          },
        ],
      })) as ExecutionAuthorization
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'pipeline',
          method: 'runWorkflow',
          args: [{ ...base, liveExecutionAuthorization: authorization }],
        }),
      ).resolves.toEqual(validWorkflowResult())
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'pipeline',
          method: 'runWorkflow',
          args: [{ ...base, liveExecutionAuthorization: authorization }],
        }),
      ).rejects.toThrow(/fresh matching execution authorization/)

      const cleanup = (await invokeHandler!(trustedEvent(), {
        domain: 'execution',
        method: 'authorize',
        args: [
          {
            project: opened.project,
            configRevision: 1,
            purpose: 'cleanup',
            planDigest,
          },
        ],
      })) as ExecutionAuthorization
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'pipeline',
          method: 'runWorkflow',
          args: [{ ...base, liveExecutionAuthorization: cleanup }],
        }),
      ).rejects.toThrow(/fresh matching execution authorization/)

      const staleCfg = structuredClone(cfg)
      staleCfg.project.name = 'Unsaved bytes'
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'pipeline',
          method: 'runWorkflow',
          args: [{ ...base, cfg: staleCfg }],
        }),
      ).rejects.toThrow(/Save the current project revision/)
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'pipeline',
          method: 'run',
          args: [cfg, 'recon', {}],
        }),
      ).rejects.toThrow(/allowlisted IPC method/)
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'pipeline',
          method: 'cancel',
          args: ['job-1'],
        }),
      ).rejects.toThrow(/allowlisted IPC method/)

      const diskChecked = (await invokeHandler!(trustedEvent(), {
        domain: 'execution',
        method: 'authorize',
        args: [
          {
            project: opened.project,
            configRevision: 1,
            purpose: 'live-workflow',
            planDigest,
          },
        ],
      })) as ExecutionAuthorization
      await writeFile(opened.project.configPath, '{}\n')
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'pipeline',
          method: 'runWorkflow',
          args: [{ ...base, liveExecutionAuthorization: diskChecked }],
        }),
      ).rejects.toThrow(/changed on disk/)
      expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('gates env.createOutputDir behind a one-use opt-in-install authorization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-createdir-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Create directory gate test'
      cfg.project.createdAt = '2026-07-22T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(async (method: string) =>
        method === 'env.createOutputDir'
          ? { ok: true, detail: 'Created the output directory.' }
          : 'sidecar-result',
      )
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'save',
        args: [
          {
            project: opened.project,
            cfg,
            configRevision: 1,
            safeExecution: true,
            expectedSha256: opened.configSha256,
          },
        ],
      })
      const authorize = async () =>
        (await invokeHandler!(trustedEvent(), {
          domain: 'execution',
          method: 'authorize',
          args: [
            {
              project: opened.project,
              configRevision: 1,
              purpose: 'opt-in-install',
            },
          ],
        })) as ExecutionAuthorization
      const base = {
        project: opened.project,
        cfg,
        configRevision: 1,
        checkId: 'subjdir',
      }

      // Refuse any renderer-supplied path or other extra field.
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'env',
          method: 'createOutputDir',
          args: [{ ...base, path: '/tmp/evil', authorization: {} }],
        }),
      ).rejects.toThrow(/env.createOutputDir request/)

      // Refuse a malformed check id before consuming any token.
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'env',
          method: 'createOutputDir',
          args: [{ ...base, checkId: '../escape', authorization: {} }],
        }),
      ).rejects.toThrow(/valid check ID/)

      // Refuse an absent or empty authorization envelope.
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'env',
          method: 'createOutputDir',
          args: [{ ...base, authorization: {} }],
        }),
      ).rejects.toThrow(/fresh matching execution authorization/)

      // Refuse a wrong-purpose token.
      const provisionAuthorization = (await invokeHandler!(trustedEvent(), {
        domain: 'execution',
        method: 'authorize',
        args: [
          {
            project: opened.project,
            configRevision: 1,
            purpose: 'provision',
          },
        ],
      })) as ExecutionAuthorization
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'env',
          method: 'createOutputDir',
          args: [{ ...base, authorization: provisionAuthorization }],
        }),
      ).rejects.toThrow(/fresh matching execution authorization/)

      // Forward exactly once for a fresh matching token; refuse its replay.
      const authorization = await authorize()
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'env',
          method: 'createOutputDir',
          args: [{ ...base, authorization }],
        }),
      ).resolves.toEqual({ ok: true, detail: 'Created the output directory.' })
      const forwarded = sidecar.call.mock.calls.filter(
        ([method]) => method === 'env.createOutputDir',
      )
      expect(forwarded).toHaveLength(1)
      const forwardedRequest = (forwarded[0]?.[1] as unknown[])[0] as Record<
        string,
        unknown
      >
      expect(Object.keys(forwardedRequest).sort()).toEqual([
        'authorization',
        'cfg',
        'checkId',
        'configRevision',
        'project',
      ])
      expect(forwardedRequest.checkId).toBe('subjdir')
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'env',
          method: 'createOutputDir',
          args: [{ ...base, authorization }],
        }),
      ).rejects.toThrow(/fresh matching execution authorization/)

      // Refuse unsaved configuration bytes.
      const staleCfg = structuredClone(cfg)
      staleCfg.project.name = 'Unsaved bytes'
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'env',
          method: 'createOutputDir',
          args: [{ ...base, cfg: staleCfg, authorization: await authorize() }],
        }),
      ).rejects.toThrow(/Save the current project revision/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds an external debug artifact to the consumed exact destination', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'supraspina-debug-'))
    try {
      const projectRoot = join(outer, 'project')
      await mkdir(projectRoot)
      const bundlePath = join(outer, 'bundle.zip')
      const untrustedDisplayPath = join(outer, 'neighbor.txt')
      await writeFile(untrustedDisplayPath, 'neighbor secret')
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Debug grant test'
      cfg.project.createdAt = '2026-07-22T00:00:00.000Z'
      cfg.paths.projectRoot = projectRoot
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(
        async (method: string, args: unknown[]) => {
          if (method === 'manifest.bundleDebug') {
            const request = args[0] as { destinationPath: string }
            await writeFile(request.destinationPath, 'redacted debug bundle')
            return { artifactId: 'debug-1', displayPath: untrustedDisplayPath }
          }
          return 'sidecar-result'
        },
      )
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: projectRoot, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      showSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: bundlePath,
      })
      const destination = (await invokeHandler!(trustedEvent(), {
        domain: 'fs',
        method: 'chooseSavePath',
        args: [
          {
            purpose: 'debug-bundle',
            project: opened.project,
            defaultPath: bundlePath,
          },
        ],
      })) as { destinationId: string }
      await invokeHandler!(trustedEvent(), {
        domain: 'manifest',
        method: 'bundleDebug',
        args: [
          {
            project: opened.project,
            runId: 'run-1',
            categoryIds: ['logs'],
            destinationId: destination.destinationId,
            consent: true,
            redaction: 'required',
          },
        ],
      })
      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'artifact',
          method: 'readText',
          args: [{ project: opened.project, artifactId: 'debug-1' }],
        }),
      ).resolves.toEqual({ text: 'redacted debug bundle', truncated: false })
      expect(sidecar.call).not.toHaveBeenCalledWith(
        'results.resolveArtifact',
        expect.anything(),
      )
    } finally {
      await rm(outer, { recursive: true, force: true })
    }
  })

  it('rejects a project-scoped sidecar result that finishes after replacement', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'supraspina-stale-rpc-'))
    try {
      const aRoot = join(outer, 'a')
      const bRoot = join(outer, 'b')
      await mkdir(aRoot)
      await mkdir(bRoot)
      const cfgA = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfgA.project.name = 'Project A'
      cfgA.project.createdAt = '2026-07-22T00:00:00.000Z'
      cfgA.paths.projectRoot = aRoot
      const cfgB = structuredClone(cfgA)
      cfgB.project.name = 'Project B'
      cfgB.paths.projectRoot = bRoot
      await writeFile(
        join(bRoot, 'supraspina.project.json'),
        `${JSON.stringify(cfgB)}\n`,
      )
      let finishResults!: (value: unknown) => void
      const delayedResults = new Promise<unknown>((resolve) => {
        finishResults = resolve
      })
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(
        async (method: string): Promise<unknown> => {
          if (method === 'results.list') return delayedResults
          if (method === 'system.detachProject') {
            return { detached: true, projectAttached: false }
          }
          return 'sidecar-result'
        },
      )
      registerIpc(sidecar as never, { trustedRenderer })
      const openedA = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: aRoot, cfg: cfgA, epoch: 1 }],
      })) as ProjectOpenResult
      const pending = invokeHandler!(trustedEvent(), {
        domain: 'results',
        method: 'list',
        args: [{ project: openedA.project }],
      })
      await vi.waitFor(() =>
        expect(sidecar.call).toHaveBeenCalledWith('results.list', [
          expect.objectContaining({ project: openedA.project }),
        ]),
      )
      await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'open',
        args: [{ path: bRoot, epoch: 2 }],
      })
      finishResults({ items: [], nextCursor: null, truncated: false })

      await expect(pending).rejects.toThrow(/stale or unknown/)
    } finally {
      await rm(outer, { recursive: true, force: true })
    }
  })
  it('forgets the cached QC authority when runs or the sidecar change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-qc-cache-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'QC Cache'
      cfg.project.createdAt = '2026-07-30T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      const runs: Array<Record<string, unknown>> = [
        { runId: 'run-33333333', steps: [{ key: 'enigma', status: 'done' }] },
        { runId: 'run-11111111', steps: [{ key: 'enigma', status: 'done' }] },
      ]
      let digest = ''
      sidecar.call.mockImplementation(
        async (method: string, args: unknown[]): Promise<unknown> => {
          if (method === 'manifest.list') {
            return { items: runs.map((run) => ({ ...run })), nextCursor: null }
          }
          if (method === 'results.list') {
            const { runId, currentConfigSha256, galleryPresence } = args[0] as {
              runId: string
              currentConfigSha256?: string
              galleryPresence?: boolean
            }
            const page = {
              items: [
                ['subcortical', 'Subcortical QC gallery'],
                ['internal', 'Cortical-internal QC gallery'],
                ['external', 'Cortical-external QC gallery'],
              ].map(([tab, label]) => ({
                artifactId: `artifact-${runId}-${tab}`,
                label,
                stepKey: 'enigma',
                subjectId: null,
                kind: 'html',
                presence: 'produced',
                displayPath: join(root, runId, `${tab}.html`),
                exists: true,
                openable: true,
                revealable: true,
                runId,
                producerNodeId: 'enigma:cohort',
                receiptSha256: '1'.repeat(64),
                provenance: 'current',
              })),
              nextCursor: null,
              truncated: false,
              runId,
              // The newer run was produced under an earlier configuration.
              configSha256: runId === 'run-33333333' ? 'f'.repeat(64) : digest,
            }
            // Mirror the sidecar's answer for a run under another
            // configuration: its digest, and its rows' presence when asked.
            if (
              currentConfigSha256 === undefined ||
              page.configSha256 === currentConfigSha256
            ) {
              return page
            }
            return {
              ...page,
              items: [],
              ...(galleryPresence
                ? {
                    galleryPresence: page.items.map(
                      ({
                        label,
                        stepKey,
                        subjectId,
                        kind,
                        presence,
                        exists,
                      }) => ({
                        label,
                        stepKey,
                        subjectId,
                        kind,
                        presence,
                        exists,
                      }),
                    ),
                  }
                : {}),
            }
          }
          return 'sidecar-result'
        },
      )
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      digest = canonicalConfigDigest(opened.cfg)
      const authority = () =>
        invokeHandler!(trustedEvent(), {
          domain: 'qc',
          method: 'authoritativeRun',
          args: [{ project: opened.project }],
        })
      const listings = () =>
        sidecar.call.mock.calls.filter(([method]) => method === 'manifest.list')
          .length
      const inventories = (probes: boolean) =>
        sidecar.call.mock.calls
          .filter(([method]) => method === 'results.list')
          .map(([, args]) => (args as [Record<string, unknown>])[0])
          .filter((request) => 'galleryPresence' in request !== probes)
          .map((request) => request.runId)
      // Count inventory requests; a run behind the newest rejected gallery set
      // is first probed for its configuration digest alone.
      const inventoried = () => inventories(false)

      await expect(authority()).resolves.toMatchObject({
        runId: 'run-11111111',
      })
      expect(inventoried()).toEqual(['run-33333333', 'run-11111111'])
      expect(inventories(true)).toEqual(['run-11111111'])
      const firstListings = listings()

      // Output lines cannot change the answer.
      notify!({ method: 'pipeline.stdout', params: {}, generation: 1 })
      await authority()
      expect(listings()).toBe(firstListings)
      expect(inventoried()).toHaveLength(2)

      // Run activity forces a fresh look at the runs, which reuses the
      // verdicts of unchanged runs.
      notify!({ method: 'pipeline.jobUpdate', params: {}, generation: 1 })
      await authority()
      expect(listings()).toBe(firstListings + 1)
      expect(inventoried()).toHaveLength(2)

      // A new run keeps the rejected run's verdict. The authority is read
      // again, because a newer run can rewrite ENIGMA QC's inputs.
      runs.unshift({
        runId: 'run-44444444',
        steps: [{ key: 'recon', status: 'running' }],
      })
      notify!({ method: 'runtime.event', params: {}, generation: 1 })
      await authority()
      expect(inventoried().slice(2)).toEqual(['run-11111111'])

      // A managed-resource change can re-sign every receipt.
      notify!({
        method: 'managedResource.progress',
        params: {},
        generation: 1,
      })
      await authority()
      expect(inventoried().slice(3)).toEqual(['run-33333333', 'run-11111111'])

      // So can a restarted sidecar.
      stateChanged!()
      await authority()
      expect(inventoried().slice(5)).toEqual(['run-33333333', 'run-11111111'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('registerIpc event relay and disposal', () => {
  it('relays only declared sidecar topics and host state', async () => {
    const { registerIpc } = await import('./ipc')
    const { IPC_CHANNELS, IPC_EVENTS } = await import('../shared/ipc')
    registerIpc(makeSidecar() as never, { trustedRenderer })

    const job = validRuntimeJob()
    const stdout = { jobId: 'job-1', line: 'safe output', lev: 'INFO' }
    const runtime = validRuntimeEvent()
    const provision = validProvisionProgress()
    const provisionLog = validProvisionLog()
    const managed = validManagedResourceProgress()
    const cases = [
      ['pipeline.jobUpdate', IPC_EVENTS.jobUpdate, job],
      ['pipeline.stdout', IPC_EVENTS.stdout, stdout],
      ['runtime.event', IPC_EVENTS.runtimeEvent, runtime],
      ['provision.progress', IPC_EVENTS.provisionProgress, provision],
      ['provision.log', IPC_EVENTS.provisionLog, provisionLog],
      ['managedResource.progress', IPC_EVENTS.managedResourceProgress, managed],
    ] as const
    for (const [method, , params] of cases) {
      notify!({ method, params, generation: 1 })
    }
    const runtimeLineageEvent = validRuntimeEvent(
      validRuntimeJob({
        id: '#fallback',
        backend: 'fastsurfer',
        attemptOrdinal: 2,
        role: 'fallback',
        supersedesJobId: '#primary',
        fallbackReasonTag: 'freesurfer_topology_failure',
      }),
    )
    notify!({
      method: 'runtime.event',
      params: runtimeLineageEvent,
      generation: 1,
    })
    const relayedBeforeMalformed = send.mock.calls.length
    for (const [method, params] of [
      ['pipeline.jobUpdate', null],
      ['pipeline.stdout', { jobId: 'job-1' }],
      ['runtime.event', { ...runtime, kind: 'unsupported' }],
      ['provision.progress', { ...provision, percent: 101 }],
      ['provision.log', { ...provisionLog, line: 42 }],
      ['managedResource.progress', { ...managed, projectEpoch: -1 }],
    ] as const) {
      notify!({ method, params, generation: 1 })
    }
    expect(send).toHaveBeenCalledTimes(relayedBeforeMalformed)
    notify!({ method: 'system.processStarted', params: {}, generation: 1 })
    stateChanged!()

    for (const [, topic, payload] of cases) {
      expect(send).toHaveBeenCalledWith(IPC_CHANNELS.event, {
        topic,
        payload,
      })
    }
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.event, {
      topic: IPC_EVENTS.runtimeEvent,
      payload: runtimeLineageEvent,
    })
    expect(send).toHaveBeenCalledWith(
      IPC_CHANNELS.event,
      expect.objectContaining({
        topic: IPC_EVENTS.hostState,
        payload: expect.objectContaining({ sidecar: READY_STATE }),
      }),
    )
    expect(send).toHaveBeenCalledTimes(cases.length + 2)
  })

  it('does not relay privileged state after the renderer leaves the trusted path', async () => {
    const { registerIpc } = await import('./ipc')
    registerIpc(makeSidecar() as never, { trustedRenderer })

    frame.url = 'file:///app/other.html'
    notify!({
      method: 'pipeline.jobUpdate',
      params: { state: 'running' },
      generation: 1,
    })
    stateChanged!()

    expect(send).not.toHaveBeenCalled()
  })

  it('logs which registry row failed its contract without its content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-registry-contract-'))
    try {
      const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
      cfg.project.name = 'Registry contract logging'
      cfg.project.createdAt = '2026-08-01T00:00:00.000Z'
      cfg.paths.projectRoot = root
      const { registerIpc } = await import('./ipc')
      const sidecar = makeSidecar()
      sidecar.call.mockImplementation(async (method: string) =>
        method === 'registry.list'
          ? [
              validRegistryRecord(),
              validRegistryRecord({
                subjectId: 'sub-0002',
                qc: 'unreviewed',
              }),
            ]
          : 'sidecar-result',
      )
      registerIpc(sidecar as never, { trustedRenderer })
      const opened = (await invokeHandler!(trustedEvent(), {
        domain: 'project',
        method: 'create',
        args: [{ at: root, cfg, epoch: 1 }],
      })) as ProjectOpenResult
      mainLog.error.mockClear()

      await expect(
        invokeHandler!(trustedEvent(), {
          domain: 'registry',
          method: 'list',
          args: [{ project: opened.project }],
        }),
      ).rejects.toThrow('Provide a supported QC verdict.')

      expect(mainLog.error).toHaveBeenCalledTimes(1)
      const line = String(mainLog.error.mock.calls[0]?.[0])
      expect(line).toContain('registry.list')
      expect(line).toContain('row 1')
      expect(line).toContain('Provide a supported QC verdict.')
      expect(line).not.toContain('sub-0002')
      expect(line).not.toContain('unreviewed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes the invoke handler and listeners through its disposer', async () => {
    const { registerIpc } = await import('./ipc')
    const { IPC_CHANNELS } = await import('../shared/ipc')
    const sidecar = makeSidecar()
    const dispose = registerIpc(sidecar as never, { trustedRenderer })
    dispose()
    expect(removeHandler).toHaveBeenCalledWith(IPC_CHANNELS.invoke)
    expect(sidecar.setNotificationHandler).toHaveBeenCalledTimes(2)
    expect(sidecar.setStateHandler).toHaveBeenCalledTimes(2)
  })

  it('relays preference and display topology changes and removes both listeners', async () => {
    const { registerIpc } = await import('./ipc')
    const { IPC_CHANNELS, IPC_EVENTS } = await import('../shared/ipc')
    let preferenceChanged: ((state: unknown) => void) | null = null
    let topologyChanged: ((state: unknown) => void) | null = null
    const disposePreferences = vi.fn()
    const disposePlacement = vi.fn()
    const preferences = {
      onStateChanged: vi.fn((listener: (state: unknown) => void) => {
        preferenceChanged = listener
        return disposePreferences
      }),
    }
    const windowPlacement = {
      onStateChanged: vi.fn((listener: (state: unknown) => void) => {
        topologyChanged = listener
        return disposePlacement
      }),
    }
    const dispose = registerIpc(makeSidecar() as never, {
      trustedRenderer,
      preferences: preferences as never,
      windowPlacement: windowPlacement as never,
    })
    const preferenceState = { resolvedTheme: 'light' }
    const placementState = { fallbackReason: null }
    ;(preferenceChanged as ((state: unknown) => void) | null)?.(preferenceState)
    ;(topologyChanged as ((state: unknown) => void) | null)?.(placementState)
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.event, {
      topic: IPC_EVENTS.preferencesChanged,
      payload: preferenceState,
    })
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.event, {
      topic: IPC_EVENTS.windowPlacementChanged,
      payload: placementState,
    })
    dispose()
    expect(disposePreferences).toHaveBeenCalledOnce()
    expect(disposePlacement).toHaveBeenCalledOnce()
  })
})
