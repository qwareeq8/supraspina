import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { version as APP_VERSION } from '../../package.json'
import { REQUIRED_SIDECAR_CAPABILITIES } from '../shared/contract'

interface FakeStream extends EventEmitter {
  setEncoding(encoding: string): void
}

interface FakeChild extends EventEmitter {
  stdout: FakeStream
  stderr: FakeStream
  stdin: { write(payload: string, cb: (error?: Error | null) => void): void }
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  writes: string[]
  kills: NodeJS.Signals[]
  kill(signal?: NodeJS.Signals): boolean
  emitExit(code?: number): void
}

let nextPid = 900_000
let spawnQueue: FakeChild[] = []
let savedSidecarOverride: string | undefined
let tempRoots: string[] = []
const spawn = vi.fn(() => {
  const child = spawnQueue.shift()
  if (!child) throw new Error('Queue a fake child before spawning.')
  return child
})
const execFileSync = vi.fn()

vi.mock('node:child_process', () => ({
  execFileSync,
  spawn,
  default: { execFileSync, spawn },
}))

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter() as FakeStream
  child.stderr = new EventEmitter() as FakeStream
  child.stdout.setEncoding = () => undefined
  child.stderr.setEncoding = () => undefined
  child.pid = nextPid++
  child.exitCode = null
  child.signalCode = null
  child.writes = []
  child.kills = []
  child.stdin = {
    write(payload, cb): void {
      child.writes.push(payload)
      cb(null)
    },
  }
  child.kill = (signal = 'SIGTERM'): boolean => {
    child.kills.push(signal)
    if (child.signalCode === null && child.exitCode === null) {
      child.signalCode = signal
      child.emit('exit', null, signal)
      child.emit('close', null, signal)
    }
    return true
  }
  child.emitExit = (code = 0): void => {
    if (child.signalCode !== null || child.exitCode !== null) return
    child.exitCode = code
    child.emit('exit', code, null)
    child.emit('close', code, null)
  }
  return child
}

const CAPABILITIES = [
  'workflow-v1',
  'run-store-v1',
  'project-identity-v1',
  'runtime-events-v1',
  'artifact-resolution-v1',
  'cancellable-provision-v1',
  'input-fov-review-v1',
  'managed-scientific-resources-v1',
  'cohort-analysis-v1',
  'cohort-analysis-v2',
  'atlas-labeling-v1',
]

function response(child: FakeChild, id: number, result: unknown): void {
  child.stdout.emit(
    'data',
    `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`,
  )
}

function errorResponse(
  child: FakeChild,
  id: number,
  error: Record<string, unknown>,
): void {
  child.stdout.emit(
    'data',
    `${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`,
  )
}

function notification(child: FakeChild, method: string, params: unknown): void {
  child.stdout.emit(
    'data',
    `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`,
  )
}

function workflowClaim(
  jobId: string,
  pid: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    claimId: `claim-${jobId}-${pid}`,
    generation: 1,
    operationKind: 'workflow',
    ownerId: jobId,
    projectId: 'project-ownership',
    projectEpoch: 1,
    runId: 'run-12345678',
    jobId,
    operationId: null,
    pid,
    pgid: pid,
    startIdentity: `test:${pid}:1`,
    ...overrides,
  }
}

function provisionClaim(
  operationId: string,
  pid: number,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    claimId: `claim-${operationId}-${pid}`,
    generation: 1,
    operationKind: 'provision',
    ownerId: operationId,
    projectId: 'project-ownership',
    projectEpoch: 1,
    runId: null,
    jobId: null,
    operationId,
    pid,
    pgid: pid,
    startIdentity: `test:${pid}:1`,
  }
}

function registerProcessClaim(
  child: FakeChild,
  claim: Record<string, unknown>,
): void {
  notification(child, 'system.processOwnerRegistered', claim)
  notification(child, 'system.processStarted', claim)
}

function handshakeResult(
  generation: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    productVersion: APP_VERSION,
    protocolVersion: '1',
    persistenceVersions: { project: 1, runState: 1, manifest: 1, receipt: 1 },
    capabilities: CAPABILITIES,
    runtimeId: `runtime-${generation}`,
    supervisorGeneration: generation,
    sidecarGeneration: generation,
    projectAttached: false,
    attachedProjects: [],
    ...overrides,
  }
}

async function startReady(
  sidecar: { start(): Promise<void> },
  child: FakeChild,
  generation = 1,
): Promise<void> {
  const started = sidecar.start()
  expect(child.writes).toHaveLength(1)
  const request = JSON.parse(child.writes[0]!)
  expect(request.method).toBe('system.handshake')
  expect(request.params).toEqual([
    { productVersion: APP_VERSION, protocolVersion: '1', generation },
  ])
  response(child, request.id, handshakeResult(generation))
  await started
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  spawnQueue = []
  tempRoots = []
  savedSidecarOverride = process.env['SUPRASPINA_SIDECAR']
  delete process.env['SUPRASPINA_SIDECAR']
})

afterEach(async () => {
  if (savedSidecarOverride === undefined)
    delete process.env['SUPRASPINA_SIDECAR']
  else process.env['SUPRASPINA_SIDECAR'] = savedSidecarOverride
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('Sidecar readiness and protocol', () => {
  it('normalizes the non-Linux POSIX process start identity from the bounded ps probe', async () => {
    const { posixProcessIdentity } = await import('./sidecar')
    const execute = vi.fn(() => ' Thu   Jul  23 03:04:05 2026 \n')

    expect(posixProcessIdentity(42, 'darwin', execute)).toEqual({
      state: 'alive',
      identity: 'darwin:Thu Jul 23 03:04:05 2026',
    })
    expect(execute).toHaveBeenCalledWith(
      '/bin/ps',
      ['-o', 'lstart=', '-p', '42'],
      expect.objectContaining({ timeout: 2_000, windowsHide: true }),
    )
  })

  it('distinguishes a dead non-Linux POSIX PID from an unprovable identity', async () => {
    const { posixProcessIdentity } = await import('./sidecar')
    const dead = vi.fn(() => {
      throw Object.assign(new Error('gone'), { status: 1 })
    })
    const unknown = vi.fn(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })

    expect(posixProcessIdentity(42, 'darwin', dead)).toEqual({
      state: 'dead',
      identity: null,
    })
    expect(posixProcessIdentity(42, 'darwin', unknown)).toEqual({
      state: 'unknown',
      identity: null,
    })
  })

  it('reads the Windows creation FILETIME and fails closed when it is unprovable', async () => {
    const { windowsProcessIdentity } = await import('./sidecar')
    const execute = vi.fn(() => '1337000001\n')
    const probe = vi.fn(() => true) as unknown as typeof process.kill

    expect(windowsProcessIdentity(42, execute, probe)).toEqual({
      state: 'alive',
      identity: 'windows:1337000001',
    })
    expect(execute).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']),
      expect.objectContaining({ timeout: 2_000, windowsHide: true }),
    )

    const denied = vi.fn(() => {
      throw new Error('denied')
    })
    expect(windowsProcessIdentity(42, denied, probe)).toEqual({
      state: 'unknown',
      identity: null,
    })
  })

  it('rejects calls until the strict handshake succeeds', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })

    await expect(sidecar.call('pipeline.listSteps', [])).rejects.toMatchObject({
      code: 'SIDECAR_UNAVAILABLE',
    })
    await startReady(sidecar, child)
    expect(sidecar.getState()).toMatchObject({
      state: 'ready',
      generation: 1,
      productVersion: APP_VERSION,
      protocolVersion: '1',
      projectAttached: false,
      runtimeId: 'runtime-1',
    })
  })

  it.each([
    ['shape', null],
    ['missing product version', { productVersion: undefined }],
    ['mismatched product version', { productVersion: '999.0.0' }],
    ['malformed product version', { productVersion: 302 }],
    ['protocol', { protocolVersion: '2' }],
    ['persistence declaration', { persistenceVersions: null }],
    [
      'persistence',
      {
        persistenceVersions: {
          project: 1,
          runState: 2,
          manifest: 1,
          receipt: 1,
        },
      },
    ],
    ['capability declaration', { capabilities: 'workflow-v1' }],
    ['capability item', { capabilities: [...CAPABILITIES, 7] }],
    ['empty runtime identity', { runtimeId: '' }],
    ['oversized runtime identity', { runtimeId: 'x'.repeat(129) }],
    ['attachment state', { projectAttached: 'false' }],
    ['generation', { supervisorGeneration: 99 }],
  ])('rejects incompatible %s readiness', async (_label, overrides) => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    const started = sidecar.start()
    const id = JSON.parse(child.writes[0]!).id
    response(
      child,
      id,
      overrides === null ? null : handshakeResult(1, overrides),
    )
    await expect(started).rejects.toMatchObject({
      code: 'SIDECAR_UNAVAILABLE',
    })
    expect(sidecar.getState().state).toBe('unavailable')
  })

  it.each([...REQUIRED_SIDECAR_CAPABILITIES])(
    'rejects readiness that omits the %s capability',
    async (capability) => {
      const child = makeChild()
      spawnQueue.push(child)
      const { Sidecar } = await import('./sidecar')
      const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
      const started = sidecar.start()
      const id = JSON.parse(child.writes[0]!).id
      response(
        child,
        id,
        handshakeResult(1, {
          capabilities: CAPABILITIES.filter((item) => item !== capability),
        }),
      )
      await expect(started).rejects.toMatchObject({
        code: 'SIDECAR_UNAVAILABLE',
      })
      expect(sidecar.getState().state).toBe('unavailable')
    },
  )

  it('fails promptly on a malformed protocol line without logging its content', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    const call = sidecar.call('pipeline.listSteps', [])
    child.stdout.emit('data', 'secret=/private/path sub-secret not-json\n')
    await expect(call).rejects.toMatchObject({ code: 'SIDECAR_UNAVAILABLE' })
    expect(sidecar.getState().state).toBe('unavailable')
    const written = stderr.mock.calls.flat().join(' ')
    expect(written).not.toContain('/private/path')
    expect(written).not.toContain('sub-secret')
  })

  it('rejects a pending call when a partial response dies with its generation', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    const call = sidecar.call('results.list', [])
    child.stdout.emit('data', '{"jsonrpc":"2.0","id":2')
    child.emitExit(3)
    await expect(call).rejects.toMatchObject({ code: 'SIDECAR_UNAVAILABLE' })
  })

  it('frames calls and resolves only the matching response', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    const call = sidecar.call('results.list', [{ project: 'p' }])
    const request = JSON.parse(child.writes[1]!)
    expect(request).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      method: 'results.list',
      params: [{ project: 'p' }],
    })
    response(child, 99, 'stale')
    response(child, 2, { items: [] })
    await expect(call).resolves.toEqual({ items: [] })
  })

  it('preserves only the allowlisted PLAN_STALE recovery contract', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    const call = sidecar.call('pipeline.runWorkflow', [])
    const request = JSON.parse(child.writes.at(-1)!)

    errorResponse(child, request.id, {
      code: -32603,
      message: 'PlanStaleError: operation failed',
      data: {
        code: 'PLAN_STALE',
        action: { id: 'reviewAgain', label: 'Review again' },
      },
    })

    await expect(call).rejects.toMatchObject({
      name: 'PlanStaleError',
      code: 'PLAN_STALE',
      action: { id: 'reviewAgain', label: 'Review again' },
      message:
        'Review the workflow plan again because the approved plan changed.',
    })
    expect(sidecar.getState().state).toBe('ready')
  })

  it('redacts unknown or malformed JSON-RPC error data', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    const call = sidecar.call('pipeline.runWorkflow', [])
    const request = JSON.parse(child.writes.at(-1)!)

    errorResponse(child, request.id, {
      code: -32603,
      message: '/private/data/sub-secret',
      data: {
        code: 'PLAN_STALE',
        action: { id: 'openPath', label: '/private/data' },
        secret: 'token=private',
      },
    })

    await expect(call).rejects.toMatchObject({
      message: 'Retry the scientific runtime request (pipeline.runWorkflow).',
    })
    await expect(call).rejects.not.toThrow(/private|secret/)
    expect(sidecar.getState().state).toBe('ready')
  })

  it('bounds each protocol line rather than a chunk of valid messages', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      maxAutomaticRestarts: 0,
      maxProtocolLineBytes: 1024,
    })
    const received = vi.fn()
    sidecar.setNotificationHandler(received)
    await startReady(sidecar, child)
    const messages = Array.from({ length: 12 }, (_, index) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'runtime.event',
        params: { index },
      }),
    ).join('\n')
    child.stdout.emit('data', `${messages}\n`)
    expect(received).toHaveBeenCalledTimes(12)
    expect(sidecar.getState().state).toBe('ready')
  })

  it.each([
    ['complete', `${'x'.repeat(1025)}\n`],
    ['partial', 'x'.repeat(1025)],
  ])('rejects an oversized %s protocol frame', async (_label, frame) => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      maxAutomaticRestarts: 0,
      maxProtocolLineBytes: 1024,
    })
    await startReady(sidecar, child)

    child.stdout.emit('data', frame)

    await vi.waitFor(() => expect(sidecar.getState().state).toBe('unavailable'))
  })

  it('rejects an oversized request before writing or degrading readiness', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      maxAutomaticRestarts: 0,
      maxProtocolLineBytes: 1024,
    })
    await startReady(sidecar, child)
    const writesBefore = child.writes.length

    await expect(
      sidecar.call('results.list', [{ value: 'x'.repeat(1024) }]),
    ).rejects.toThrow('Keep JSON-RPC requests within the protocol byte limit.')

    expect(child.writes).toHaveLength(writesBefore)
    expect(sidecar.getState().state).toBe('ready')

    const call = sidecar.call('results.list', [])
    const request = JSON.parse(child.writes.at(-1)!)
    response(child, request.id, { items: [] })
    await expect(call).resolves.toEqual({ items: [] })
  })

  it('ignores empty protocol frames without degrading readiness', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)

    child.stdout.emit('data', '\n   \n')

    expect(sidecar.getState().state).toBe('ready')
  })

  it('rejects synchronous transport write failures without leaking a pending call', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    child.stdin.write = (): never => {
      throw new Error('Expose the transport secret.')
    }
    await expect(sidecar.call('results.list', [])).rejects.toMatchObject({
      code: 'SIDECAR_UNAVAILABLE',
    })
  })

  it('rejects asynchronous transport write failures without leaking a pending call', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    child.stdin.write = (_payload, callback): void => {
      callback(new Error('Expose the transport secret.'))
    }

    await expect(sidecar.call('results.list', [])).rejects.toMatchObject({
      code: 'SIDECAR_UNAVAILABLE',
    })
  })

  it('ignores a late transport callback after its response has already settled', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    let callback: ((error?: Error | null) => void) | null = null
    child.stdin.write = (payload, next): void => {
      child.writes.push(payload)
      callback = next
    }

    const call = sidecar.call('results.list', [])
    const request = JSON.parse(child.writes.at(-1)!)
    response(child, request.id, { items: [] })
    await expect(call).resolves.toEqual({ items: [] })
    callback!(new Error('Deliver the late transport callback.'))

    expect(sidecar.getState().state).toBe('ready')
  })

  it('holds project reads past the ordinary bound and still bounds control calls', async () => {
    // Allow receipt re-verification to exceed the ordinary control-call bound.
    vi.useFakeTimers()
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      callTimeoutMs: 10,
      maxAutomaticRestarts: 0,
    })
    await startReady(sidecar, child)

    for (const method of [
      'runtime.bootstrap',
      'env.check',
      'env.toolStatus',
      'project.validate',
      'manifest.list',
      'manifest.forRun',
      'results.list',
      'subjects.discover',
      'inputFov.list',
      'registry.list',
      'pipeline.planWorkflow',
      'qc.somethingAddedLater',
    ]) {
      const call = sidecar.call(method, [])
      await vi.advanceTimersByTimeAsync(11)
      expect(sidecar.getState().state).toBe('ready')
      const request = JSON.parse(child.writes.at(-1)!)
      response(child, request.id, { ok: true })
      await expect(call).resolves.toEqual({ ok: true })
    }

    const bounded = sidecar.call('pipeline.previewCommand', [])
    const timedOut = expect(bounded).rejects.toMatchObject({
      code: 'SIDECAR_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(11)
    await timedOut
    await vi.waitFor(() => expect(sidecar.getState().state).toBe('unavailable'))
  })

  it('rejects unserializable requests before writing to the transport', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    await expect(sidecar.call('results.list', cyclic)).rejects.toThrow(
      /Provide a JSON-serializable JSON-RPC request/,
    )
    expect(child.writes).toHaveLength(1)
    expect(sidecar.getState().state).toBe('ready')
  })

  it('times out a bounded call and degrades that exact generation', async () => {
    vi.useFakeTimers()
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      callTimeoutMs: 10,
      maxAutomaticRestarts: 0,
    })
    await startReady(sidecar, child)

    const call = sidecar.call('pipeline.previewCommand', [])
    const timedOut = expect(call).rejects.toMatchObject({
      code: 'SIDECAR_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(11)
    await timedOut
    await vi.waitFor(() => expect(sidecar.getState().state).toBe('unavailable'))
  })

  it('keeps a busy runtime whose liveness probe answers after a bounded timeout', async () => {
    // A bounded call queued behind a long request can time out; the
    // supervisor must not then recycle a live runtime with its running jobs.
    vi.useFakeTimers()
    const child = makeChild()
    const replacement = makeChild()
    spawnQueue.push(child, replacement)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      callTimeoutMs: 10,
      livenessTimeoutMs: 50,
      restartBackoffMs: [1],
      maxAutomaticRestarts: 1,
    })
    await startReady(sidecar, child)
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)

    const slow = sidecar.call('results.list', [])
    const slowId = JSON.parse(child.writes.at(-1)!).id
    const preview = sidecar.call('pipeline.previewCommand', [])
    const previewId = JSON.parse(child.writes.at(-1)!).id
    const upsert = sidecar.call('registry.upsert', [])
    const previewTimedOut = expect(preview).rejects.toMatchObject({
      code: 'SIDECAR_TIMEOUT',
    })
    const upsertTimedOut = expect(upsert).rejects.toMatchObject({
      code: 'SIDECAR_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(11)
    await previewTimedOut
    await upsertTimedOut

    const probes = child.writes
      .map((line) => JSON.parse(line))
      .filter((request) => request.method === 'system.liveness')
    expect(probes).toHaveLength(1)
    response(child, probes[0].id, 'alive')
    await vi.advanceTimersByTimeAsync(100)

    expect(sidecar.getState()).toMatchObject({ state: 'ready', generation: 1 })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('the liveness probe answered'),
    )
    response(child, previewId, 'late')
    response(child, slowId, { ok: true })
    await expect(slow).resolves.toEqual({ ok: true })
    expect(sidecar.getState()).toMatchObject({ state: 'ready', generation: 1 })
  })

  it('restarts a runtime whose liveness probe fails after a bounded timeout', async () => {
    vi.useFakeTimers()
    const child = makeChild()
    const replacement = makeChild()
    spawnQueue.push(child, replacement)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      callTimeoutMs: 10,
      livenessTimeoutMs: 50,
      restartBackoffMs: [1],
      maxAutomaticRestarts: 1,
    })
    await startReady(sidecar, child)
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)

    const preview = sidecar.call('pipeline.previewCommand', [])
    const timedOut = expect(preview).rejects.toMatchObject({
      code: 'SIDECAR_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(11)
    await timedOut
    expect(sidecar.getState()).toMatchObject({ state: 'ready', generation: 1 })
    expect(
      child.writes.filter(
        (line) => JSON.parse(line).method === 'system.liveness',
      ),
    ).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60)
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'pipeline.previewCommand timed out and the liveness probe did not answer',
      ),
    )
    await vi.waitFor(() => expect(replacement.writes).toHaveLength(1))
    response(
      replacement,
      JSON.parse(replacement.writes[0]!).id,
      handshakeResult(2),
    )
    await vi.waitFor(() =>
      expect(sidecar.getState()).toMatchObject({
        state: 'ready',
        generation: 2,
      }),
    )
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['primitive JSON', '7'],
    ['wrong protocol', JSON.stringify({ jsonrpc: '1.0' })],
    ['unclassifiable response', JSON.stringify({ jsonrpc: '2.0' })],
  ])('fails closed on an invalid %s message', async (_label, line) => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)

    child.stdout.emit('data', `${line}\n`)
    await vi.waitFor(() => expect(sidecar.getState().state).toBe('unavailable'))
  })

  it('rejects a matching response that contains neither result nor error', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    const call = sidecar.call('results.list', [])
    const id = JSON.parse(child.writes.at(-1)!).id

    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id })}\n`)
    await expect(call).rejects.toThrow(
      /Return a valid response from the scientific runtime/,
    )
    expect(sidecar.getState().state).toBe('ready')
  })
})

describe('Sidecar restart and ownership', () => {
  it('coalesces concurrent starts, then makes ready start and retry idempotent', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })

    const first = sidecar.start()
    const repeated = sidecar.start()
    expect(repeated).toBe(first)
    response(child, JSON.parse(child.writes[0]!).id, handshakeResult(1))
    await first
    await expect(sidecar.start()).resolves.toBeUndefined()
    await expect(sidecar.retry()).resolves.toBeUndefined()
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('uses an explicit sidecar command only in development', async () => {
    process.env['SUPRASPINA_SIDECAR'] = '/opt/supraspina/frozen-sidecar'
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)

    expect(spawn).toHaveBeenCalledWith(
      '/opt/supraspina/frozen-sidecar',
      [],
      expect.objectContaining({ cwd: '/repo' }),
    )
  })

  it('prefers the packaged frozen binary when it exists in platform resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-sidecar-package-'))
    tempRoots.push(root)
    const resourcesPath = join(root, 'resources')
    const binary = join(resourcesPath, 'sidecar', 'supraspina-sidecar')
    await mkdir(join(resourcesPath, 'sidecar'), { recursive: true })
    await writeFile(binary, 'fixture')
    const priorResourcesPath = Reflect.get(process, 'resourcesPath')
    Reflect.set(process, 'resourcesPath', resourcesPath)
    try {
      process.env['SUPRASPINA_SIDECAR'] = '/tmp/developer-sidecar'
      const child = makeChild()
      spawnQueue.push(child)
      const { Sidecar } = await import('./sidecar')
      const sidecar = new Sidecar('/repo', true, { maxAutomaticRestarts: 0 })
      await startReady(sidecar, child)

      expect(spawn).toHaveBeenCalledWith(
        binary,
        [],
        expect.objectContaining({ cwd: resourcesPath }),
      )
    } finally {
      if (priorResourcesPath === undefined)
        Reflect.deleteProperty(process, 'resourcesPath')
      else Reflect.set(process, 'resourcesPath', priorResourcesPath)
    }
  })

  it('fails closed when a packaged frozen binary is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-sidecar-missing-'))
    tempRoots.push(root)
    const resourcesPath = join(root, 'resources')
    await mkdir(resourcesPath, { recursive: true })
    const priorResourcesPath = Reflect.get(process, 'resourcesPath')
    Reflect.set(process, 'resourcesPath', resourcesPath)
    process.env['SUPRASPINA_SIDECAR'] = '/tmp/developer-sidecar'
    try {
      const { Sidecar } = await import('./sidecar')
      const sidecar = new Sidecar('/repo', true, {
        maxAutomaticRestarts: 0,
      })

      await expect(sidecar.start()).rejects.toMatchObject({
        code: 'SIDECAR_UNAVAILABLE',
        message: 'Install or restore the bundled scientific runtime.',
      })
      expect(spawn).not.toHaveBeenCalled()
      expect(sidecar.getState()).toMatchObject({
        state: 'unavailable',
        retryable: false,
        detail: 'Install or restore the bundled scientific runtime.',
      })
    } finally {
      if (priorResourcesPath === undefined)
        Reflect.deleteProperty(process, 'resourcesPath')
      else Reflect.set(process, 'resourcesPath', priorResourcesPath)
    }
  })

  it('prefers the repository virtualenv for a development sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supraspina-sidecar-venv-'))
    tempRoots.push(root)
    const python = join(root, 'sidecar', '.venv', 'bin', 'python')
    await mkdir(join(root, 'sidecar', '.venv', 'bin'), { recursive: true })
    await writeFile(python, 'fixture')
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar(root, false)
    await startReady(sidecar, child)

    expect(spawn).toHaveBeenCalledWith(
      python,
      ['-m', 'supraspina_sidecar'],
      expect.objectContaining({ cwd: join(root, 'sidecar') }),
    )
  })

  it('lets an explicit retry preempt a delayed automatic restart', async () => {
    vi.useFakeTimers()
    const first = makeChild()
    const second = makeChild()
    spawnQueue.push(first, second)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      restartBackoffMs: [1_000],
      maxAutomaticRestarts: 1,
    })
    await startReady(sidecar, first)
    first.emitExit(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(sidecar.getState().state).toBe('restarting')

    const retried = sidecar.retry()
    await Promise.resolve()
    await Promise.resolve()
    expect(second.writes).toHaveLength(1)
    response(second, JSON.parse(second.writes[0]!).id, handshakeResult(2))
    await retried
    await vi.advanceTimersByTimeAsync(1_001)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(sidecar.getState()).toMatchObject({ state: 'ready', generation: 2 })
  })

  it('states each transient runtime state as a fact, not an order', async () => {
    vi.useFakeTimers()
    const first = makeChild()
    const second = makeChild()
    spawnQueue.push(first, second)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      restartBackoffMs: [1_000],
      maxAutomaticRestarts: 1,
    })
    // The detail is the workflow chip's and the run dock's tooltip.
    const details = new Map<string, string | null>()
    sidecar.setStateHandler((state) => details.set(state.state, state.detail))
    expect(sidecar.getState()).toMatchObject({
      state: 'booting',
      detail: 'Supraspina is preparing the scientific runtime.',
    })

    await startReady(sidecar, first)
    first.emitExit(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(sidecar.getState().state).toBe('restarting')
    const retried = sidecar.retry()
    await Promise.resolve()
    await Promise.resolve()
    response(second, JSON.parse(second.writes[0]!).id, handshakeResult(2))
    await retried
    const stopping = sidecar.stop()
    const shutdown = JSON.parse(second.writes.at(-1)!)
    response(second, shutdown.id, {
      ok: true,
      closing: true,
      activeJobs: 0,
      activeProvisioning: 0,
      activeManagedResources: 0,
    })
    second.emitExit(0)
    await stopping

    expect(Object.fromEntries(details)).toMatchObject({
      starting: 'Supraspina is starting and verifying the scientific runtime.',
      restarting: 'The scientific runtime restarts after a short delay.',
      stopping:
        'Supraspina is stopping scientific work and saving runtime state.',
    })
  })

  it('shares an in-flight readiness attempt with explicit retry', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    const starting = sidecar.start()
    const retrying = sidecar.retry()

    response(child, JSON.parse(child.writes[0]!).id, handshakeResult(1))
    await Promise.all([starting, retrying])
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('publishes defensive state snapshots and attachment transitions', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    const states: Array<ReturnType<typeof sidecar.getState>> = []
    sidecar.setStateHandler((state) => states.push(state))
    await startReady(sidecar, child)

    const snapshot = sidecar.getState()
    snapshot.capabilities.splice(0)
    if (snapshot.persistenceVersions) snapshot.persistenceVersions.project = 99
    expect(sidecar.getState().capabilities).toEqual(CAPABILITIES.slice().sort())
    expect(sidecar.getState().persistenceVersions?.project).toBe(1)

    sidecar.setProjectAttached(true)
    const count = states.length
    sidecar.setProjectAttached(true)
    expect(states).toHaveLength(count)
    expect(sidecar.getState().projectAttached).toBe(true)

    sidecar.setStateHandler(() => {
      throw new Error('/private/state/path')
    })
    expect(stderr.mock.calls.flat().join(' ')).not.toContain(
      '/private/state/path',
    )
  })

  it('validates project attachment notifications and keeps them supervisor-owned', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    const notify = vi.fn()
    sidecar.setNotificationHandler(notify)
    await startReady(sidecar, child)

    child.stdout.emit(
      'data',
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'system.projectAttachment',
        params: { attached: true },
      })}\n`,
    )
    expect(sidecar.getState().projectAttached).toBe(true)
    expect(notify).not.toHaveBeenCalled()

    notification(child, 'system.projectAttachment', { attached: false })
    expect(sidecar.getState().projectAttached).toBe(false)

    child.stdout.emit(
      'data',
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'system.projectAttachment',
        params: { attached: 'true' },
      })}\n`,
    )
    await vi.waitFor(() => expect(sidecar.getState().state).toBe('unavailable'))
  })

  it.each([
    {
      label: 'non-record payload',
      params: null,
      activeStatus: null,
      activeJobId: null,
    },
    {
      label: 'non-numeric pid',
      params: { generation: 1, jobId: 'job-a', pid: 'bad', pgid: 90_001 },
      activeStatus: 'running',
      activeJobId: 'job-a',
    },
    {
      label: 'reserved pid',
      params: { generation: 1, jobId: 'job-b', pid: 1, pgid: 1 },
      activeStatus: 'running',
      activeJobId: 'job-b',
    },
    {
      label: 'non-numeric process group',
      params: { generation: 1, jobId: 'job-c', pid: 90_003, pgid: 'bad' },
      activeStatus: 'running',
      activeJobId: 'job-c',
    },
    {
      label: 'reserved process group',
      params: { generation: 1, jobId: 'job-d', pid: 90_004, pgid: 1 },
      activeStatus: 'running',
      activeJobId: 'job-d',
    },
    {
      label: 'empty job identity',
      params: { generation: 1, jobId: '', pid: 90_005, pgid: 90_005 },
      activeStatus: null,
      activeJobId: null,
    },
    {
      label: 'oversized job identity',
      params: {
        generation: 1,
        jobId: 'j'.repeat(257),
        pid: 90_006,
        pgid: 90_006,
      },
      activeStatus: null,
      activeJobId: null,
    },
    {
      label: 'wrong supervisor generation',
      params: { generation: 2, jobId: 'job-g', pid: 90_007, pgid: 90_007 },
      activeStatus: 'running',
      activeJobId: 'job-g',
    },
    {
      label: 'forged nonleader process group',
      params: { generation: 1, jobId: 'job-h', pid: 90_008, pgid: 90_009 },
      activeStatus: 'running',
      activeJobId: 'job-h',
    },
    {
      label: 'missing active job',
      params: { generation: 1, jobId: 'job-i', pid: 90_010, pgid: 90_010 },
      activeStatus: null,
      activeJobId: null,
    },
    {
      label: 'queued rather than executing job',
      params: { generation: 1, jobId: 'job-j', pid: 90_011, pgid: 90_011 },
      activeStatus: 'queued',
      activeJobId: 'job-j',
    },
  ])('rejects a $label process ownership claim', async (testCase) => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    if (testCase.activeStatus && testCase.activeJobId) {
      notification(child, 'pipeline.jobUpdate', {
        id: testCase.activeJobId,
        status: testCase.activeStatus,
      })
    }

    notification(child, 'system.processStarted', testCase.params)

    await vi.waitFor(() => expect(sidecar.getState().state).toBe('unavailable'))
  })

  it.each([
    ['non-record payload', null],
    [
      'wrong supervisor generation',
      { generation: 2, jobId: 'job-settle', pid: 91_001, pgid: 91_001 },
    ],
    [
      'unknown owned process',
      { generation: 1, jobId: 'job-settle', pid: 91_001, pgid: 91_001 },
    ],
  ])('rejects a %s process-settlement claim', async (_label, params) => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)

    notification(child, 'system.processSettled', params)

    await vi.waitFor(() => expect(sidecar.getState().state).toBe('unavailable'))
  })

  it('rejects settlement for a different process group than the proved claim', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    notification(child, 'pipeline.jobUpdate', {
      id: 'job-settle-group',
      status: 'running',
    })
    const claim = workflowClaim('job-settle-group', 91_002)
    registerProcessClaim(child, claim)

    notification(child, 'system.processSettled', {
      ...claim,
      pgid: 91_003,
      provedStopped: true,
    })

    await vi.waitFor(() => expect(sidecar.getState().state).toBe('unavailable'))
  })

  it('tracks only bounded active job identities and clears terminal updates', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    const notify = vi.fn()
    sidecar.setNotificationHandler(notify)
    await startReady(sidecar, child)

    for (const params of [
      null,
      { id: '', status: 'running' },
      { id: 'j'.repeat(257), status: 'running' },
      { id: 'job-lifecycle', status: 'queued' },
      { id: 'job-lifecycle', status: 'running' },
      { id: 'job-lifecycle', status: 'cancelling' },
      { id: 'job-lifecycle', status: 'failed' },
    ]) {
      notification(child, 'pipeline.jobUpdate', params)
    }
    expect(notify).toHaveBeenCalledTimes(7)

    child.emitExit(2)
    await vi.waitFor(() =>
      expect(sidecar.getState()).toMatchObject({
        state: 'unavailable',
        retryable: true,
      }),
    )
  })

  it('accepts ownership for a canceling job and removes it after proved settlement', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    notification(child, 'pipeline.jobUpdate', {
      id: 'job-cancelling',
      status: 'cancelling',
    })
    const claim = workflowClaim('job-cancelling', 91_004)
    registerProcessClaim(child, claim)
    notification(child, 'system.processSettled', {
      ...claim,
      provedStopped: true,
    })

    const stopping = sidecar.stop()
    const shutdown = JSON.parse(child.writes.at(-1)!)
    response(child, shutdown.id, {
      ok: true,
      closing: true,
      activeJobs: 0,
      activeProvisioning: 0,
      activeManagedResources: 0,
    })
    child.emitExit(0)
    await stopping
    expect(kill).not.toHaveBeenCalledWith(-91_004, expect.anything())
  })

  it('registers, acknowledges, settles, and releases a provision operation without a workflow job', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    const claim = provisionClaim('provision-12345678', 91_005)

    registerProcessClaim(child, claim)

    const acceptance = JSON.parse(child.writes.at(-1)!)
    expect(acceptance).toMatchObject({
      method: 'system.acceptProcessClaim',
      params: [{ ...claim, accepted: true }],
    })
    notification(child, 'system.processSettled', {
      ...claim,
      provedStopped: true,
    })
    notification(child, 'system.processOwnerReleased', claim)

    const stopping = sidecar.stop()
    const shutdown = JSON.parse(child.writes.at(-1)!)
    response(child, shutdown.id, {
      ok: true,
      closing: true,
      activeJobs: 0,
      activeProvisioning: 0,
      activeManagedResources: 0,
    })
    child.emitExit(0)
    await stopping
  })

  it.each([
    ['darwin' as const, 'darwin:Thu Jul 23 03:04:05 2026'],
    ['win32' as const, 'windows:1337000001'],
  ])(
    'accepts a %s process claim only after its start identity matches',
    async (platform, startIdentity) => {
      const child = makeChild()
      spawnQueue.push(child)
      const processIdentityProbe = vi.fn(() => ({
        state: 'alive' as const,
        identity: startIdentity,
      }))
      const { Sidecar } = await import('./sidecar')
      const sidecar = new Sidecar('/repo', false, {
        maxAutomaticRestarts: 0,
        processPlatform: platform,
        processIdentityProbe,
      })
      await startReady(sidecar, child)
      const claim = workflowClaim(`job-${platform}-identity`, 91_050, {
        startIdentity,
      })
      notification(child, 'pipeline.jobUpdate', {
        id: `job-${platform}-identity`,
        status: 'running',
      })

      registerProcessClaim(child, claim)

      expect(processIdentityProbe).toHaveBeenCalledWith(91_050, platform)
      expect(JSON.parse(child.writes.at(-1)!)).toMatchObject({
        method: 'system.acceptProcessClaim',
        params: [{ ...claim, accepted: true }],
      })
      notification(child, 'system.processSettled', {
        ...claim,
        provedStopped: true,
      })
      notification(child, 'system.processOwnerReleased', claim)

      const stopping = sidecar.stop()
      const shutdown = JSON.parse(child.writes.at(-1)!)
      response(child, shutdown.id, {
        ok: true,
        closing: true,
        activeJobs: 0,
        activeProvisioning: 0,
        activeManagedResources: 0,
      })
      child.emitExit(0)
      await stopping
    },
  )

  it.each([
    ['darwin' as const, 'darwin:Thu Jul 23 03:04:05 2026'],
    ['win32' as const, 'windows:1337000001'],
  ])(
    'rejects a reused %s PID before accepting its process claim',
    async (platform, startIdentity) => {
      const child = makeChild()
      spawnQueue.push(child)
      const { Sidecar } = await import('./sidecar')
      const sidecar = new Sidecar('/repo', false, {
        maxAutomaticRestarts: 0,
        processPlatform: platform,
        processIdentityProbe: () => ({
          state: 'alive',
          identity: `${platform}:different-start`,
        }),
      })
      await startReady(sidecar, child)
      const claim = workflowClaim(`job-${platform}-reused`, 91_051, {
        startIdentity,
      })
      notification(child, 'pipeline.jobUpdate', {
        id: `job-${platform}-reused`,
        status: 'running',
      })
      notification(child, 'system.processOwnerRegistered', claim)

      notification(child, 'system.processStarted', claim)

      await vi.waitFor(() =>
        expect(sidecar.getState().state).toBe('unavailable'),
      )
      expect(
        child.writes.some((payload) =>
          payload.includes('system.acceptProcessClaim'),
        ),
      ).toBe(false)
    },
  )

  it.each([
    ['darwin' as const, 'darwin:Thu Jul 23 03:04:05 2026'],
    ['win32' as const, 'windows:1337000001'],
  ])(
    'does not signal a reused %s process group during crash reconciliation',
    async (platform, startIdentity) => {
      const child = makeChild()
      spawnQueue.push(child)
      let currentIdentity = startIdentity
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const { Sidecar } = await import('./sidecar')
      const sidecar = new Sidecar('/repo', false, {
        maxAutomaticRestarts: 0,
        processPlatform: platform,
        processIdentityProbe: () => ({
          state: 'alive',
          identity: currentIdentity,
        }),
      })
      await startReady(sidecar, child)
      const pid = 91_052
      const claim = workflowClaim(`job-${platform}-crash`, pid, {
        startIdentity,
      })
      notification(child, 'pipeline.jobUpdate', {
        id: `job-${platform}-crash`,
        status: 'running',
      })
      registerProcessClaim(child, claim)
      currentIdentity = `${platform}:reused-process`

      const provedStopped = await (
        sidecar as unknown as {
          terminateOwnedProcesses(generation?: number): Promise<boolean>
        }
      ).terminateOwnedProcesses(1)

      expect(provedStopped).toBe(true)
      expect(kill).not.toHaveBeenCalledWith(-pid, expect.anything())
    },
  )

  it('rejects a process start that does not exactly match its registration', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    notification(child, 'pipeline.jobUpdate', {
      id: 'job-exact-claim',
      status: 'running',
    })
    const claim = workflowClaim('job-exact-claim', 91_006)
    notification(child, 'system.processOwnerRegistered', claim)

    notification(child, 'system.processStarted', {
      ...claim,
      claimId: 'claim-substituted-after-registration',
    })

    await vi.waitFor(() => expect(sidecar.getState().state).toBe('unavailable'))
  })

  it.each([
    ['string project epoch', { projectEpoch: '1' }],
    ['boolean project epoch', { projectEpoch: true }],
    ['numeric owner id', { ownerId: 42 }],
    ['numeric project id', { projectId: 42 }],
    ['missing nullable run id', { runId: undefined }],
    ['control byte in claim id', { claimId: 'claim-bad\nvalue' }],
  ])(
    'rejects a process-owner registration with a %s',
    async (_label, patch) => {
      const child = makeChild()
      spawnQueue.push(child)
      const { Sidecar } = await import('./sidecar')
      const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
      await startReady(sidecar, child)
      notification(child, 'pipeline.jobUpdate', {
        id: 'job-strict-registration',
        status: 'running',
        projectId: 'project-ownership',
        projectEpoch: 1,
        runId: 'run-12345678',
      })

      notification(
        child,
        'system.processOwnerRegistered',
        workflowClaim('job-strict-registration', 91_007, patch),
      )

      await vi.waitFor(() =>
        expect(sidecar.getState().state).toBe('unavailable'),
      )
    },
  )

  it.each([
    ['numeric-string pid', { pid: '91008', pgid: '91008' }],
    ['boolean pid', { pid: true, pgid: true }],
    ['numeric-string process group', { pgid: '91008' }],
    ['non-platform start identity', { startIdentity: 'opaque:91008:1' }],
  ])('rejects a process claim with a %s', async (_label, patch) => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    const claim = workflowClaim('job-strict-claim', 91_008)
    notification(child, 'pipeline.jobUpdate', {
      id: 'job-strict-claim',
      status: 'running',
      projectId: 'project-ownership',
      projectEpoch: 1,
      runId: 'run-12345678',
    })
    notification(child, 'system.processOwnerRegistered', claim)

    notification(child, 'system.processStarted', { ...claim, ...patch })

    await vi.waitFor(() => expect(sidecar.getState().state).toBe('unavailable'))
  })

  it('blocks direct restart while an owned process is unknown and retries only after proved death', async () => {
    const first = makeChild()
    const second = makeChild()
    spawnQueue.push(first, second)
    const claimPid = 91_009
    let claimUnknown = true
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -claimPid && signal === 0 && claimUnknown) {
        const error = new Error('permission denied') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, first)
    const claim = workflowClaim('job-unknown-owner', claimPid)
    notification(first, 'pipeline.jobUpdate', {
      id: 'job-unknown-owner',
      status: 'running',
    })
    registerProcessClaim(first, claim)

    first.emitExit(2)
    await vi.waitFor(() =>
      expect(sidecar.getState()).toMatchObject({
        state: 'unavailable',
        detail: expect.stringMatching(/possibly active prior scientific work/i),
      }),
    )
    await expect(sidecar.start()).rejects.toThrow(
      /Resolve prior scientific process ownership/,
    )
    expect(spawn).toHaveBeenCalledOnce()

    claimUnknown = false
    const retrying = sidecar.retry()
    await vi.waitFor(() => expect(second.writes).toHaveLength(1))
    const handshake = JSON.parse(second.writes[0]!)
    response(second, handshake.id, handshakeResult(2))
    await retrying
    expect(sidecar.getState()).toMatchObject({ state: 'ready', generation: 2 })
  })

  it('redacts notification-handler failures without degrading the runtime', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    sidecar.setNotificationHandler(() => {
      throw new Error('/private/notification/path')
    })
    await startReady(sidecar, child)

    child.stdout.emit(
      'data',
      `${JSON.stringify({ jsonrpc: '2.0', method: 'runtime.event', params: {} })}\n`,
    )
    expect(sidecar.getState().state).toBe('ready')
    expect(stderr.mock.calls.flat().join(' ')).not.toContain(
      '/private/notification/path',
    )
  })

  it('accepts only proved process-settlement notifications', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    const jobId = 'job-settled'
    const pid = 820_001
    const claim = workflowClaim(jobId, pid)
    for (const [method, params] of [
      ['pipeline.jobUpdate', { id: jobId, status: 'running' }],
      ['system.processOwnerRegistered', claim],
      ['system.processStarted', claim],
      ['system.processSettled', { ...claim, provedStopped: false }],
      ['system.processSettled', { ...claim, provedStopped: true }],
    ] as const) {
      child.stdout.emit(
        'data',
        `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`,
      )
    }

    const stopping = sidecar.stop()
    const shutdown = JSON.parse(child.writes.at(-1)!)
    response(child, shutdown.id, {
      ok: true,
      closing: true,
      activeJobs: 0,
      activeProvisioning: 0,
      activeManagedResources: 0,
    })
    child.emitExit(0)
    await stopping
    expect(kill).not.toHaveBeenCalledWith(-pid, expect.anything())
  })
  it('restarts with a new generation and ignores late old-child events', async () => {
    vi.useFakeTimers()
    const first = makeChild()
    const second = makeChild()
    spawnQueue.push(first, second)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      restartBackoffMs: [5],
      maxAutomaticRestarts: 1,
    })
    await startReady(sidecar, first)
    first.emitExit(2)
    await vi.advanceTimersByTimeAsync(10)
    expect(second.writes).toHaveLength(1)
    const handshake = JSON.parse(second.writes[0]!)
    response(second, handshake.id, handshakeResult(2))
    await vi.runAllTimersAsync()
    await Promise.resolve()
    expect(sidecar.getState()).toMatchObject({ state: 'ready', generation: 2 })

    const notify = vi.fn()
    sidecar.setNotificationHandler(notify)
    notification(first, 'runtime.event', { late: true })
    first.emit(
      'error',
      new Error('Deliver the late callback from the old generation.'),
    )
    expect(notify).not.toHaveBeenCalled()
    expect(sidecar.getState()).toMatchObject({ state: 'ready', generation: 2 })
  })

  it('states the relaunch, not the wait, once the restart delay has passed', async () => {
    // Once the delay has passed, "restarts after a short delay" would be
    // wrong for the relaunch and its readiness check.
    vi.useFakeTimers()
    const first = makeChild()
    const second = makeChild()
    spawnQueue.push(first, second)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      restartBackoffMs: [5],
      maxAutomaticRestarts: 1,
    })
    await startReady(sidecar, first)
    first.emitExit(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(sidecar.getState()).toMatchObject({
      state: 'restarting',
      detail: 'The scientific runtime restarts after a short delay.',
    })

    await vi.advanceTimersByTimeAsync(10)
    expect(second.writes).toHaveLength(1)
    expect(sidecar.getState()).toMatchObject({
      state: 'restarting',
      generation: 2,
      detail: 'Supraspina is restarting and verifying the scientific runtime.',
    })

    response(second, JSON.parse(second.writes[0]!).id, handshakeResult(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(sidecar.getState()).toMatchObject({
      state: 'ready',
      generation: 2,
      detail: null,
    })
  })

  it('keeps one notification callback across restart', async () => {
    vi.useFakeTimers()
    const first = makeChild()
    const second = makeChild()
    spawnQueue.push(first, second)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      restartBackoffMs: [1],
      maxAutomaticRestarts: 1,
    })
    const received: string[] = []
    sidecar.setNotificationHandler((notification) =>
      received.push(notification.method),
    )
    await startReady(sidecar, first)
    first.stdout.emit(
      'data',
      `${JSON.stringify({ jsonrpc: '2.0', method: 'runtime.event', params: {} })}\n`,
    )
    first.emitExit(1)
    await vi.advanceTimersByTimeAsync(2)
    const request = JSON.parse(second.writes[0]!)
    response(second, request.id, handshakeResult(2))
    await Promise.resolve()
    second.stdout.emit(
      'data',
      `${JSON.stringify({ jsonrpc: '2.0', method: 'runtime.event', params: {} })}\n`,
    )
    expect(received).toEqual(['runtime.event', 'runtime.event'])
  })

  it('bounds repeated handshake-then-crash failures before the stability window', async () => {
    vi.useFakeTimers()
    const first = makeChild()
    const second = makeChild()
    const third = makeChild()
    spawnQueue.push(first, second, third)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      restartBackoffMs: [1, 1],
      maxAutomaticRestarts: 2,
    })
    await startReady(sidecar, first)

    first.emitExit(1)
    await vi.advanceTimersByTimeAsync(2)
    response(second, JSON.parse(second.writes[0]!).id, handshakeResult(2))
    await Promise.resolve()
    second.emitExit(1)
    await vi.advanceTimersByTimeAsync(2)
    response(third, JSON.parse(third.writes[0]!).id, handshakeResult(3))
    await Promise.resolve()
    third.emitExit(1)
    await Promise.resolve()
    await Promise.resolve()

    expect(spawn).toHaveBeenCalledTimes(3)
    expect(sidecar.getState()).toMatchObject({
      state: 'unavailable',
      retryable: true,
    })
  })

  it('tracks process groups internally and does not relay ownership metadata', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    let scientificGroupAlive = true
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -800001 && signal === 0 && scientificGroupAlive) return true
      if (pid === -800001 && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        scientificGroupAlive = false
        return true
      }
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    const notify = vi.fn()
    sidecar.setNotificationHandler(notify)
    await startReady(sidecar, child)
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'pipeline.jobUpdate',
        params: { id: 'job-1', status: 'running' },
      })}\n`,
    )
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'system.processOwnerRegistered',
        params: workflowClaim('job-1', 800001),
      })}\n`,
    )
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'system.processStarted',
        params: workflowClaim('job-1', 800001),
      })}\n`,
    )
    const stopping = sidecar.stop()
    const shutdown = JSON.parse(child.writes.at(-1)!)
    response(child, shutdown.id, { ok: true, closing: true })
    child.emitExit(0)
    await stopping
    expect(notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'system.processStarted' }),
    )
    expect(kill).toHaveBeenCalledWith(-800001, 'SIGTERM')
  })

  it('blocks restart when a running job had no process ownership handoff', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      maxAutomaticRestarts: 1,
      restartBackoffMs: [1],
    })
    await startReady(sidecar, child)
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'pipeline.jobUpdate',
        params: { id: 'job-gap', status: 'running' },
      })}\n`,
    )

    child.emitExit(1)
    await vi.waitFor(() =>
      expect(sidecar.getState()).toMatchObject({
        state: 'unavailable',
        retryable: false,
        detail: expect.stringMatching(/ownership.*incomplete/i),
      }),
    )
    expect(spawn).toHaveBeenCalledOnce()
    await expect(sidecar.start()).rejects.toThrow(
      /Resolve prior scientific process ownership/,
    )
    await expect(sidecar.retry()).rejects.toThrow(
      /Resolve prior scientific process ownership/,
    )
  })

  it('rejects a process group claim that is not the reported session leader', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'pipeline.jobUpdate',
        params: { id: 'job-forged', status: 'running' },
      })}\n`,
    )
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'system.processStarted',
        params: {
          generation: 1,
          jobId: 'job-forged',
          pid: 810001,
          pgid: 810002,
        },
      })}\n`,
    )

    await vi.waitFor(() => expect(sidecar.getState().state).toBe('unavailable'))
    expect(kill).not.toHaveBeenCalledWith(-810002, expect.anything())
    await expect(sidecar.retry()).rejects.toThrow(
      /Resolve prior scientific process ownership/,
    )
  })

  it('terminates a surviving sidecar process group after its leader exits', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    let groupAlive = true
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== -child.pid) return true
      if (signal === 0) {
        if (groupAlive) return true
        const error = new Error('gone') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      }
      if (signal === 'SIGTERM' || signal === 'SIGKILL') groupAlive = false
      return true
    })
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    child.emitExit(2)
    await vi.waitFor(() => expect(sidecar.getState().state).toBe('unavailable'))
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
    expect(groupAlive).toBe(false)
  })
})

describe('Sidecar shutdown and diagnostics', () => {
  it('stops safely before launch and refuses starts during intentional shutdown', async () => {
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })

    await expect(sidecar.restartAfterStop()).rejects.toThrow(
      /Stop the scientific runtime through this supervisor/,
    )
    const stopping = sidecar.stop()
    await expect(sidecar.start()).rejects.toThrow(
      /Wait for the scientific runtime to stop/,
    )
    await expect(sidecar.retry()).rejects.toThrow(
      /Wait for the scientific runtime to stop/,
    )
    await stopping
    expect(sidecar.getState()).toMatchObject({
      state: 'unavailable',
      retryable: true,
    })
  })

  it('fails closed when a graceful stop reports unowned running work', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      maxAutomaticRestarts: 0,
      shutdownTimeoutMs: 25,
    })
    await startReady(sidecar, child)
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'pipeline.jobUpdate',
        params: { id: 'job-unowned', status: 'cancelling' },
      })}\n`,
    )

    const stopping = sidecar.stop()
    const shutdown = JSON.parse(child.writes.at(-1)!)
    response(child, shutdown.id, {
      ok: false,
      closing: true,
      activeJobs: 1,
      activeProvisioning: 0,
      activeManagedResources: 0,
    })
    child.emitExit(0)

    await expect(stopping).rejects.toThrow(
      /Prove that the scientific process exited/,
    )
    expect(sidecar.getState()).toMatchObject({
      state: 'unavailable',
      retryable: false,
    })
    await expect(sidecar.restartAfterStop()).rejects.toThrow(
      /Stop the scientific runtime through this supervisor/,
    )
    await expect(sidecar.retry()).rejects.toThrow(
      /Resolve prior scientific process ownership/,
    )
  })

  it('repeats termination work on the stop after a failed stop', async () => {
    vi.useFakeTimers()
    const child = makeChild()
    spawnQueue.push(child)
    let scientificGroupAlive = true
    let signalsTerminate = false
    const gone = (): never => {
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    }
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== -800301) return gone()
      if (signal === 0) return scientificGroupAlive ? true : gone()
      if (signalsTerminate) scientificGroupAlive = false
      return true
    })
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      maxAutomaticRestarts: 0,
      shutdownTimeoutMs: 25,
    })
    await startReady(sidecar, child)
    notification(child, 'pipeline.jobUpdate', {
      id: 'job-stuck',
      status: 'running',
    })
    registerProcessClaim(child, workflowClaim('job-stuck', 800301))

    const failing = sidecar.stop()
    const firstShutdown = JSON.parse(child.writes.at(-1)!)
    response(child, firstShutdown.id, {
      ok: true,
      closing: true,
      activeJobs: 0,
      activeProvisioning: 0,
      activeManagedResources: 0,
    })
    child.emitExit(0)
    const failed = expect(failing).rejects.toThrow(
      /Prove that the scientific process exited/,
    )
    await vi.advanceTimersByTimeAsync(3_000)
    await failed
    expect(sidecar.getState()).toMatchObject({
      state: 'unavailable',
      retryable: true,
    })

    signalsTerminate = true
    kill.mockClear()
    const stopping = sidecar.stop()
    expect(stopping).not.toBe(failing)
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(stopping).resolves.toBeUndefined()
    expect(kill).toHaveBeenCalledWith(-800301, 'SIGTERM')
    expect(sidecar.getState().state).toBe('unavailable')
  })

  it('honors the advertised retry after a recoverable stop failure', async () => {
    vi.useFakeTimers()
    const first = makeChild()
    const second = makeChild()
    spawnQueue.push(first, second)
    let scientificGroupAlive = true
    const gone = (): never => {
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    }
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== -800401) return gone()
      if (signal === 0) return scientificGroupAlive ? true : gone()
      return true
    })
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      maxAutomaticRestarts: 0,
      shutdownTimeoutMs: 25,
    })
    await startReady(sidecar, first)
    notification(first, 'pipeline.jobUpdate', {
      id: 'job-lingering',
      status: 'running',
    })
    registerProcessClaim(first, workflowClaim('job-lingering', 800401))

    const failing = sidecar.stop()
    const shutdown = JSON.parse(first.writes.at(-1)!)
    response(first, shutdown.id, {
      ok: true,
      closing: true,
      activeJobs: 0,
      activeProvisioning: 0,
      activeManagedResources: 0,
    })
    first.emitExit(0)
    const failed = expect(failing).rejects.toThrow(
      /Prove that the scientific process exited/,
    )
    await vi.advanceTimersByTimeAsync(3_000)
    await failed
    expect(sidecar.getState()).toMatchObject({
      state: 'unavailable',
      retryable: true,
    })

    scientificGroupAlive = false
    const retried = sidecar.retry()
    await vi.advanceTimersByTimeAsync(10)
    response(second, JSON.parse(second.writes.at(-1)!).id, handshakeResult(2))
    await retried
    expect(sidecar.getState()).toMatchObject({ state: 'ready', generation: 2 })
  })

  it('truncates oversized stderr and ignores late or blank diagnostics', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)

    child.stderr.emit('data', '\n   \n')
    child.stderr.emit('data', 'x'.repeat(17 * 1024))
    child.stderr.emit('data', 'safe-sized diagnostic\n')
    expect(stderr.mock.calls.flat().join(' ')).toContain(
      'Review the redacted runtime diagnostic.',
    )
    expect(stderr.mock.calls.flat().join(' ')).toContain(
      'Review the redacted stderr content',
    )

    const writes = stderr.mock.calls.length
    const stopping = sidecar.stop()
    const shutdown = JSON.parse(child.writes.at(-1)!)
    response(child, shutdown.id, { ok: true, closing: true })
    child.stderr.emit('data', '/private/late/path\n')
    child.emitExit(0)
    await stopping
    expect(stderr.mock.calls).toHaveLength(writes)
  })

  it('restarts a generation only after a completed proved stop', async () => {
    const first = makeChild()
    const second = makeChild()
    spawnQueue.push(first, second)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, first)

    const stopping = sidecar.stop()
    const shutdown = JSON.parse(first.writes.at(-1)!)
    response(first, shutdown.id, { ok: true, closing: true, activeJobs: 0 })
    first.emitExit(0)
    await stopping

    const restarting = sidecar.restartAfterStop()
    await vi.waitFor(() => expect(second.writes).toHaveLength(1))
    const handshake = JSON.parse(second.writes[0]!)
    response(second, handshake.id, handshakeResult(2))
    await restarting
    expect(sidecar.getState()).toMatchObject({
      state: 'ready',
      generation: 2,
      runtimeId: 'runtime-2',
    })
  })

  it('performs a fast graceful, bounded, idempotent shutdown', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const { Sidecar } = await import('./sidecar')
    const sidecar = new Sidecar('/repo', false, {
      maxAutomaticRestarts: 0,
      shutdownTimeoutMs: 50,
    })
    await startReady(sidecar, child)
    const notify = vi.fn()
    sidecar.setNotificationHandler(notify)
    const first = sidecar.stop()
    const second = sidecar.stop()
    expect(second).toBe(first)
    notification(child, 'runtime.event', { during: 'shutdown' })
    expect(notify).not.toHaveBeenCalled()
    const request = JSON.parse(child.writes.at(-1)!)
    expect(request.method).toBe('system.shutdown')
    response(child, request.id, { ok: true, closing: true, activeJobs: 0 })
    child.emitExit(0)
    await expect(first).resolves.toBeUndefined()
    expect(sidecar.getState().state).toBe('unavailable')
    await expect(sidecar.call('pipeline.listSteps', [])).rejects.toMatchObject({
      code: 'SIDECAR_UNAVAILABLE',
    })
  })

  it('redacts bounded stderr diagnostics and JSON-RPC errors', async () => {
    const child = makeChild()
    spawnQueue.push(child)
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
    const { Sidecar } = await import('./sidecar')

    const sidecar = new Sidecar('/repo', false, { maxAutomaticRestarts: 0 })
    await startReady(sidecar, child)
    child.stderr.emit(
      'data',
      'failed sub-secret at /data/private/raw API_TOKEN=hunter2\n',
    )
    const call = sidecar.call('results.list', [])
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        error: { message: 'sub-secret /data/private/raw API_TOKEN=hunter2' },
      })}\n`,
    )
    await expect(call).rejects.not.toThrow(/sub-secret|private|hunter2/)
    const output = stderr.mock.calls.flat().join(' ')
    expect(output).not.toMatch(/sub-secret|private|hunter2/)
  })
})
