import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { version as APP_VERSION } from '../../package.json'
import type { SidecarHostState } from '../shared/contract'
import { REQUIRED_SIDECAR_CAPABILITIES } from '../shared/contract'
import { PlanStaleError } from '../shared/rpc-errors'

export { PlanStaleError } from '../shared/rpc-errors'

/** One validated notification from a sidecar generation. */
export interface SidecarNotification {
  method: string
  params: unknown
  generation: number
}

interface PendingCall {
  generation: number
  method: string
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface HandshakeResult {
  productVersion: string
  protocolVersion: string
  persistenceVersions: NonNullable<SidecarHostState['persistenceVersions']>
  capabilities: string[]
  runtimeId: string
  projectAttached: boolean
  supervisorGeneration: number
}

type ProcessOperationKind = 'workflow' | 'provision'

interface ProcessOwnerRegistration {
  schemaVersion: 1
  claimId: string
  generation: number
  operationKind: ProcessOperationKind
  ownerId: string
  projectId: string
  projectEpoch: number
  runId: string | null
  jobId: string | null
  operationId: string | null
}

interface OwnedScientificProcess extends ProcessOwnerRegistration {
  pid: number
  pgid: number
  startIdentity: string
}

interface ActiveScientificJob {
  generation: number
  status: 'queued' | 'running' | 'cancelling'
  projectId: string | null
  projectEpoch: number | null
  runId: string | null
}

/** Sidecar timeouts, restart limits, and test probes. */
export interface SidecarOptions {
  handshakeTimeoutMs?: number
  callTimeoutMs?: number
  /** Bound on the liveness probe sent after a bounded call times out. */
  livenessTimeoutMs?: number
  shutdownTimeoutMs?: number
  maxAutomaticRestarts?: number
  restartBackoffMs?: readonly number[]
  maxProtocolLineBytes?: number
  /** @internal Inject a deterministic platform for ownership tests. */
  processPlatform?: NodeJS.Platform
  /** @internal Inject a deterministic process-identity probe for ownership tests. */
  processIdentityProbe?: ProcessIdentityProbe
}

const PROTOCOL_VERSION = '1'
const PERSISTENCE_VERSIONS = {
  project: 1,
  runState: 1,
  manifest: 1,
  receipt: 1,
} as const
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 8_000
const DEFAULT_CALL_TIMEOUT_MS = 60_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 12_000
const DEFAULT_RESTART_BACKOFF_MS = [250, 1_000, 2_500] as const
const DEFAULT_MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BUFFER_BYTES = 16 * 1024
const MAX_DIAGNOSTIC_CHARS = 1_024
/**
 * A ceiling for the read-only calls below, not a target: it only detects a hung
 * runtime, so a slow but working call keeps its spinner instead of losing the
 * runtime mid-call.
 */
const LONG_RUNNING_CALL_TIMEOUT_MS = 600_000
/**
 * The only bounded calls: fixed-cost control calls whose latency is diagnostic.
 * They answer immediately on a healthy runtime, so a slow response means the
 * runtime is stuck.
 *
 * Every other call reads or plans over the project, and its cost scales with
 * the cohort and its artifacts: environment probes cold-start external
 * interpreters, detector-backed reads re-verify receipt identity, and ENIGMA QC
 * re-hashes 60 bound gallery PNGs per subject. Holding such a call to the
 * ordinary timeout would end the whole sidecar generation, restart it in a
 * loop, and leave the cohort undiscovered.
 *
 * The fast calls are listed instead of the slow ones because the slow set
 * grows with the product. Keep the fast set small, closed, and obvious on
 * inspection.
 */
const BOUNDED_CONTROL_CALLS: ReadonlySet<string> = new Set([
  'ping',
  'system.handshake',
  'system.shutdown',
  'system.detachProject',
  'system.acceptProcessClaim',
  'schema.validate',
  'pipeline.listSteps',
  'pipeline.previewCommand',
  'provision.status',
  'provision.cancel',
  'managedResource.cancel',
  'registry.upsert',
  'registry.importCsv',
  'registry.remove',
  'registry.setSite',
])
/**
 * The probe that tells a busy runtime from a hung one. The sidecar answers it
 * on its stdin reader thread, ahead of the queue of ordinary requests, so a
 * bounded call that timed out behind a long request (a cohort-wide
 * `results.list`, say) does not tear down a live runtime and every scientific
 * job it owns.
 */
const LIVENESS_METHOD = 'system.liveness'
const DEFAULT_LIVENESS_TIMEOUT_MS = 10_000
const MAX_OPERATOR_ERROR_CHARS = 512
const RESTART_BUDGET_RESET_MS = 30_000
const ACTIVE_SCIENTIFIC_JOB_STATES = new Set([
  'queued',
  'running',
  'cancelling',
])

/** A report that the scientific runtime is not ready for requests. */
export class SidecarAvailabilityError extends Error {
  readonly code = 'SIDECAR_UNAVAILABLE'

  constructor(message = 'Wait for the scientific runtime to become ready.') {
    super(message)
    this.name = 'SidecarAvailabilityError'
  }
}

/** A bounded JSON-RPC call timeout. */
export class SidecarTimeoutError extends Error {
  readonly code = 'SIDECAR_TIMEOUT'

  constructor(method: string) {
    super(`Retry the timed-out scientific runtime request (${method}).`)
    this.name = 'SidecarTimeoutError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function publicRpcError(method: string, error: Record<string, unknown>): Error {
  const data = error.data
  if (
    isRecord(data) &&
    data.code === 'PLAN_STALE' &&
    isRecord(data.action) &&
    data.action.id === 'reviewAgain' &&
    data.action.label === 'Review again'
  ) {
    return new PlanStaleError()
  }
  // Preserve a refusal that the runtime authored for the operator. Replace
  // every other failure with the generic sentence because an incidental
  // exception message can carry paths and subject identifiers that must not
  // reach the window.
  if (
    isRecord(data) &&
    data.code === 'OPERATOR' &&
    typeof error.message === 'string' &&
    error.message.length > 0 &&
    error.message.length <= MAX_OPERATOR_ERROR_CHARS
  ) {
    return new Error(error.message)
  }
  return new Error(`Retry the scientific runtime request (${method}).`)
}

type ProcessProbe = 'alive' | 'dead' | 'unknown'
interface ProcessIdentity {
  state: ProcessProbe
  identity: string | null
}
type ProcessIdentityProbe = (
  pid: number,
  platform: NodeJS.Platform,
) => ProcessIdentity
type IdentityCommand = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8'
    env: NodeJS.ProcessEnv
    timeout: number
    windowsHide: boolean
  },
) => string

const runIdentityCommand: IdentityCommand = (file, args, options) =>
  execFileSync(file, args, options)

function linuxProcessIdentity(pid: number): {
  state: ProcessProbe
  identity: string | null
} {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', {
      encoding: 'ascii',
    })
      .slice(0, 128)
      .trim()
    const stat = readFileSync(`/proc/${pid}/stat`, { encoding: 'utf8' }).slice(
      0,
      4096,
    )
    const close = stat.lastIndexOf(')')
    const fields =
      close >= 0
        ? stat
            .slice(close + 1)
            .trim()
            .split(/\s+/)
        : []
    const startTicks = fields[19]
    if (!bootId || !startTicks || !/^\d+$/.test(startTicks)) {
      return { state: 'unknown', identity: null }
    }
    return {
      state: 'alive',
      identity: `linux:${bootId}:${startTicks}`,
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ESRCH') {
      return { state: 'dead', identity: null }
    }
    return { state: 'unknown', identity: null }
  }
}

/**
 * Read the start identity used by the sidecar on non-Linux POSIX hosts.
 *
 * @param platform - The current platform, never Windows.
 */
export function posixProcessIdentity(
  pid: number,
  platform: NodeJS.Platform,
  execute: IdentityCommand = runIdentityCommand,
): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 1 || platform === 'win32') {
    return { state: 'unknown', identity: null }
  }
  try {
    const output = execute('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
      timeout: 2_000,
      windowsHide: true,
    })
    const value = output.trim().split(/\s+/).join(' ')
    if (!value) return { state: 'dead', identity: null }
    return { state: 'alive', identity: `${platform}:${value}` }
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) {
      return { state: 'dead', identity: null }
    }
    return { state: 'unknown', identity: null }
  }
}

/**
 * Read the Windows creation FILETIME without opening a kill-capable handle.
 *
 * @param probe - The read-only process existence probe.
 */
export function windowsProcessIdentity(
  pid: number,
  execute: IdentityCommand = runIdentityCommand,
  probe: typeof process.kill = process.kill.bind(process),
): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return { state: 'unknown', identity: null }
  }
  const command =
    "$ErrorActionPreference='Stop';" +
    `$p=[System.Diagnostics.Process]::GetProcessById(${pid});` +
    '[Console]::Out.Write($p.StartTime.ToUniversalTime().ToFileTimeUtc())'
  try {
    const output = execute(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      {
        encoding: 'utf8',
        env: {
          PATH:
            process.env['PATH'] ??
            'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
          SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows',
        },
        timeout: 2_000,
        windowsHide: true,
      },
    ).trim()
    if (!/^[1-9]\d*$/.test(output)) {
      return { state: 'unknown', identity: null }
    }
    return { state: 'alive', identity: `windows:${output}` }
  } catch {
    try {
      probe(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return { state: 'dead', identity: null }
      }
    }
    return { state: 'unknown', identity: null }
  }
}

function processIdentity(
  pid: number,
  platform: NodeJS.Platform,
): ProcessIdentity {
  if (platform === 'linux') return linuxProcessIdentity(pid)
  if (platform === 'win32') return windowsProcessIdentity(pid)
  return posixProcessIdentity(pid, platform)
}

/**
 * Redact path, subject, credential, URL, and control-byte detail before logging.
 *
 * @returns A fixed, path-free diagnostic.
 */
export function redactSidecarDiagnostic(value: unknown): string {
  void value
  return 'Review the redacted sidecar diagnostic.'
}

function resolveCommand(
  repoRoot: string,
  packaged: boolean,
): { cmd: string; args: string[]; cwd: string } {
  if (packaged) {
    const binName =
      process.platform === 'win32'
        ? 'supraspina-sidecar.exe'
        : 'supraspina-sidecar'
    const binPath = join(process.resourcesPath, 'sidecar', binName)
    if (existsSync(binPath)) {
      return { cmd: binPath, args: [], cwd: process.resourcesPath }
    }
    throw new SidecarAvailabilityError(
      'Install or restore the bundled scientific runtime.',
    )
  }
  const override = process.env['SUPRASPINA_SIDECAR']
  if (override) return { cmd: override, args: [], cwd: repoRoot }
  const sidecarDir = join(repoRoot, 'sidecar')
  const venvPython =
    process.platform === 'win32'
      ? join(sidecarDir, '.venv', 'Scripts', 'python.exe')
      : join(sidecarDir, '.venv', 'bin', 'python')
  const python = existsSync(venvPython)
    ? venvPython
    : process.platform === 'win32'
      ? 'python'
      : 'python3'
  return { cmd: python, args: ['-m', 'supraspina_sidecar'], cwd: sidecarDir }
}

function initialHealth(): SidecarHostState {
  return {
    state: 'booting',
    generation: 0,
    productVersion: null,
    protocolVersion: null,
    persistenceVersions: null,
    capabilities: [],
    runtimeId: null,
    projectAttached: false,
    retryable: false,
    detail: 'Supraspina is preparing the scientific runtime.',
  }
}

/** The detail while a restart relaunches and verifies the runtime. */
const RELAUNCH_DETAIL =
  'Supraspina is restarting and verifying the scientific runtime.'

function fixedDetail(state: SidecarHostState['state']): string | null {
  switch (state) {
    case 'booting':
      return 'Supraspina is preparing the scientific runtime.'
    case 'starting':
      return 'Supraspina is starting and verifying the scientific runtime.'
    case 'degraded':
      return 'Retry after the scientific runtime disconnects.'
    case 'restarting':
      return 'The scientific runtime restarts after a short delay.'
    case 'stopping':
      return 'Supraspina is stopping scientific work and saving runtime state.'
    case 'unavailable':
      return 'Retry after the scientific runtime becomes available, or quit.'
    case 'ready':
      return null
  }
}

function validateHandshake(
  value: unknown,
  generation: number,
): HandshakeResult {
  if (!isRecord(value)) throw new Error('Provide a valid readiness response.')
  if (value.productVersion !== APP_VERSION) {
    throw new Error('Provide a compatible product version.')
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('Provide a compatible protocol version.')
  }
  if (!isRecord(value.persistenceVersions)) {
    throw new Error('Provide persistence compatibility.')
  }
  for (const [name, expected] of Object.entries(PERSISTENCE_VERSIONS)) {
    if (value.persistenceVersions[name] !== expected) {
      throw new Error('Provide a compatible persistence version.')
    }
  }
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.some((item) => typeof item !== 'string')
  ) {
    throw new Error('Provide a valid capability declaration.')
  }
  const capabilities = value.capabilities as string[]
  if (
    REQUIRED_SIDECAR_CAPABILITIES.some(
      (capability) => !capabilities.includes(capability),
    )
  ) {
    throw new Error('Enable every required scientific runtime capability.')
  }
  if (
    typeof value.runtimeId !== 'string' ||
    value.runtimeId.length === 0 ||
    value.runtimeId.length > 128 ||
    typeof value.projectAttached !== 'boolean' ||
    value.supervisorGeneration !== generation
  ) {
    throw new Error('Provide a valid runtime identity and generation.')
  }
  return {
    productVersion: APP_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    persistenceVersions: { ...PERSISTENCE_VERSIONS },
    capabilities: [...new Set(capabilities)].sort(),
    runtimeId: value.runtimeId,
    projectAttached: value.projectAttached,
    supervisorGeneration: generation,
  }
}

/** A supervisor for the frozen scientific runtime and its owned process trees. */
export class Sidecar {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private generation = 0
  private readonly pending = new Map<number, PendingCall>()
  private readonly ownedProcesses = new Map<string, OwnedScientificProcess>()
  private readonly processOwners = new Map<string, ProcessOwnerRegistration>()
  private readonly activeScientificJobs = new Map<string, ActiveScientificJob>()
  private readonly settledScientificJobs = new Set<string>()
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private notificationHandler: (n: SidecarNotification) => void = () =>
    undefined
  private stateHandler: (state: SidecarHostState) => void = () => undefined
  private health = initialHealth()
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartBudgetResetTimer: ReturnType<typeof setTimeout> | null = null
  private automaticRestarts = 0
  private failedGeneration = 0
  private intentionalStop = false
  private unprovedScientificWork = false
  private livenessProbe: {
    generation: number
    answered: Promise<boolean>
  } | null = null
  private readonly handshakeTimeoutMs: number
  private readonly callTimeoutMs: number
  private readonly livenessTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly maxAutomaticRestarts: number
  private readonly restartBackoffMs: readonly number[]
  private readonly maxProtocolLineBytes: number
  private readonly processPlatform: NodeJS.Platform
  private readonly processIdentityProbe: ProcessIdentityProbe

  constructor(
    private readonly repoRoot: string,
    private readonly packaged: boolean,
    options: SidecarOptions = {},
  ) {
    this.handshakeTimeoutMs =
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.livenessTimeoutMs =
      options.livenessTimeoutMs ??
      Math.min(DEFAULT_LIVENESS_TIMEOUT_MS, this.callTimeoutMs)
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    this.restartBackoffMs =
      options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
    this.maxAutomaticRestarts =
      options.maxAutomaticRestarts ?? this.restartBackoffMs.length
    this.maxProtocolLineBytes =
      options.maxProtocolLineBytes ?? DEFAULT_MAX_PROTOCOL_LINE_BYTES
    this.processPlatform = options.processPlatform ?? process.platform
    this.processIdentityProbe = options.processIdentityProbe ?? processIdentity
  }

  setNotificationHandler(handler: (n: SidecarNotification) => void): void {
    this.notificationHandler = handler
  }

  setStateHandler(handler: (state: SidecarHostState) => void): void {
    this.stateHandler = handler
    this.publishState()
  }

  getState(): SidecarHostState {
    return {
      ...this.health,
      persistenceVersions: this.health.persistenceVersions
        ? { ...this.health.persistenceVersions }
        : null,
      capabilities: [...this.health.capabilities],
    }
  }

  isReady(): boolean {
    return this.health.state === 'ready' && this.child !== null
  }

  setProjectAttached(projectAttached: boolean): void {
    if (
      this.health.state !== 'ready' ||
      this.health.projectAttached === projectAttached
    ) {
      return
    }
    this.health = { ...this.health, projectAttached }
    this.publishState()
  }

  /** Spawn and handshake the initial sidecar generation. */
  start(): Promise<void> {
    if (this.isReady()) return Promise.resolve()
    if (this.unprovedScientificWork || this.ownedProcesses.size > 0) {
      return Promise.reject(
        new SidecarAvailabilityError(
          'Resolve prior scientific process ownership before starting duplicate execution.',
        ),
      )
    }
    if (this.stopPromise || this.intentionalStop) {
      return Promise.reject(
        new SidecarAvailabilityError(
          'Wait for the scientific runtime to stop.',
        ),
      )
    }
    if (this.startPromise) return this.startPromise
    this.startPromise = this.launchGeneration('starting').finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  /** Retry explicitly after exhausting bounded automatic restarts. */
  async retry(): Promise<void> {
    if (this.unprovedScientificWork) {
      throw new SidecarAvailabilityError(
        'Resolve prior scientific process ownership before starting duplicate execution.',
      )
    }
    if (this.stopPromise) {
      throw new SidecarAvailabilityError(
        'Wait for the scientific runtime to stop.',
      )
    }
    // A failed stop leaves the intentional-stop flag set while advertising a
    // retryable state, so treat this explicit retry as the end of that stop.
    this.intentionalStop = false
    if (this.isReady()) return
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.restartBudgetResetTimer) {
      clearTimeout(this.restartBudgetResetTimer)
      this.restartBudgetResetTimer = null
    }
    this.automaticRestarts = 0
    if (this.startPromise) return this.startPromise
    const stale = this.child
    this.child = null
    if (stale && !(await this.terminateTree(stale, false))) {
      this.transition(
        'unavailable',
        this.generation,
        'Resolve the possibly active prior runtime process before retrying.',
      )
      throw new SidecarAvailabilityError(
        'Prove that the prior runtime process exited before retrying.',
      )
    }
    if (!(await this.terminateOwnedProcesses())) {
      this.transition(
        'unavailable',
        this.generation,
        'Resolve the possibly active prior scientific work before retrying.',
      )
      throw new SidecarAvailabilityError(
        'Prove that prior scientific processes exited before retrying.',
      )
    }
    await this.start()
  }

  async restartAfterStop(): Promise<void> {
    const stopping = this.stopPromise
    if (!stopping || !this.intentionalStop) {
      throw new SidecarAvailabilityError(
        'Stop the scientific runtime through this supervisor before restarting it.',
      )
    }
    await stopping
    if (this.unprovedScientificWork || this.ownedProcesses.size > 0) {
      throw new SidecarAvailabilityError(
        'Resolve prior scientific process ownership before starting duplicate execution.',
      )
    }
    if (this.stopPromise !== stopping) {
      throw new SidecarAvailabilityError(
        'Keep the scientific runtime stop state stable until restart.',
      )
    }
    this.stopPromise = null
    this.intentionalStop = false
    await this.start()
  }

  /** Call only a fully handshaken sidecar generation. */
  call(method: string, params: unknown): Promise<unknown> {
    if (!this.isReady() || this.child === null) {
      return Promise.reject(new SidecarAvailabilityError())
    }
    return this.rawCall(
      this.child,
      this.generation,
      method,
      params,
      this.timeoutFor(method),
    )
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.intentionalStop = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.restartBudgetResetTimer) {
      clearTimeout(this.restartBudgetResetTimer)
      this.restartBudgetResetTimer = null
    }
    this.transition('stopping')
    const stopping = this.performStop()
    this.stopPromise = stopping
    // A failed stop leaves termination work outstanding, so forget the
    // rejected attempt and let a later stop repeat that work.
    stopping.catch(() => {
      if (this.stopPromise === stopping) this.stopPromise = null
    })
    return stopping
  }

  private async launchGeneration(
    state: 'starting' | 'restarting',
  ): Promise<void> {
    const generation = ++this.generation
    this.failedGeneration = 0
    this.stdoutBuffer = ''
    this.stderrBuffer = ''
    // A restart's delay has passed once it relaunches, so state the relaunch
    // and its readiness check rather than the wait.
    this.transition(
      state,
      generation,
      state === 'restarting' ? RELAUNCH_DETAIL : undefined,
    )
    let command: ReturnType<typeof resolveCommand>
    try {
      command = resolveCommand(this.repoRoot, this.packaged)
    } catch (error) {
      this.transition(
        'unavailable',
        generation,
        'Install or restore the bundled scientific runtime.',
        false,
      )
      throw error
    }
    const { cmd, args, cwd } = command
    const child = spawn(cmd, args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(generation, chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.onStderr(generation, chunk))
    child.on('error', (error) => void this.failGeneration(generation, error))
    // Use `close` after stdio closure so all flushed ownership and job notifications
    // are parsed before an unexpected generation is reconciled.
    child.on('close', (code, signal) => {
      const reason =
        code === 0
          ? new Error('Keep the scientific runtime running until shutdown.')
          : new Error(
              `Keep the scientific runtime running until shutdown (${code ?? signal ?? 'unknown'}).`,
            )
      void this.failGeneration(generation, reason)
    })

    try {
      const result = await this.rawCall(
        child,
        generation,
        'system.handshake',
        [
          {
            productVersion: APP_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            generation,
          },
        ],
        this.handshakeTimeoutMs,
      )
      const handshake = validateHandshake(result, generation)
      if (
        this.child !== child ||
        this.generation !== generation ||
        this.intentionalStop
      ) {
        throw new Error('Return readiness for the current runtime generation.')
      }
      this.health = {
        state: 'ready',
        generation,
        productVersion: handshake.productVersion,
        protocolVersion: handshake.protocolVersion,
        persistenceVersions: handshake.persistenceVersions,
        capabilities: handshake.capabilities,
        runtimeId: handshake.runtimeId,
        projectAttached: handshake.projectAttached,
        retryable: false,
        detail: null,
      }
      this.restartBudgetResetTimer = setTimeout(() => {
        if (this.health.state === 'ready' && this.generation === generation) {
          this.automaticRestarts = 0
        }
        this.restartBudgetResetTimer = null
      }, RESTART_BUDGET_RESET_MS)
      this.publishState()
    } catch (error) {
      await this.failGeneration(
        generation,
        error instanceof Error
          ? error
          : new Error('Complete the readiness check successfully.'),
      )
      throw new SidecarAvailabilityError(
        'Pass all scientific runtime readiness checks.',
      )
    }
  }

  private rawCall(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (child !== this.child || generation !== this.generation) {
      return Promise.reject(
        new SidecarAvailabilityError(
          'Use the current scientific runtime generation.',
        ),
      )
    }
    const id = this.nextId
    let payload: string
    try {
      payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    } catch {
      return Promise.reject(
        new Error('Provide a JSON-serializable JSON-RPC request.'),
      )
    }
    if (Buffer.byteLength(payload, 'utf8') > this.maxProtocolLineBytes) {
      return Promise.reject(
        new Error('Keep JSON-RPC requests within the protocol byte limit.'),
      )
    }
    this.nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        reject(new SidecarTimeoutError(method))
        // The probe's own waiter decides the generation's fate, so a probe
        // timeout never starts another probe.
        if (method !== LIVENESS_METHOD) {
          void this.onCallTimeout(child, generation, method)
        }
      }, timeoutMs)
      this.pending.set(id, { generation, method, resolve, reject, timer })
      const failWrite = (error: Error): void => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        reject(
          new SidecarAvailabilityError(
            'Keep the scientific runtime transport connected.',
          ),
        )
        void this.failGeneration(generation, error)
      }
      try {
        child.stdin.write(payload, (error) => {
          if (error) failWrite(error)
        })
      } catch (error) {
        failWrite(
          error instanceof Error
            ? error
            : new Error('Keep the scientific runtime transport connected.'),
        )
      }
    })
  }

  private timeoutFor(method: string): number {
    return BOUNDED_CONTROL_CALLS.has(method)
      ? this.callTimeoutMs
      : Math.max(this.callTimeoutMs, LONG_RUNNING_CALL_TIMEOUT_MS)
  }

  /**
   * Fail the generation only when a timed-out call shows a hung runtime.
   *
   * The sidecar runs ordinary requests one at a time, so a bounded call can
   * time out queued behind a legitimately long one. Probe liveness first for a
   * bounded call on a ready generation and keep a runtime that answers. Fail
   * directly for the long-running ceiling, the handshake, and shutdown, whose
   * timeouts keep their meaning.
   */
  private async onCallTimeout(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    method: string,
  ): Promise<void> {
    const probe =
      BOUNDED_CONTROL_CALLS.has(method) &&
      method !== 'system.handshake' &&
      !this.intentionalStop &&
      this.health.state === 'ready' &&
      this.health.generation === generation &&
      this.child === child
    if (probe && (await this.probeLiveness(child, generation))) {
      process.stderr.write(
        `[sidecar] Kept the busy scientific runtime: ${method} timed out behind an earlier request, but the liveness probe answered.\n`,
      )
      return
    }
    if (
      generation !== this.generation ||
      this.failedGeneration === generation ||
      this.intentionalStop
    ) {
      return
    }
    this.reportTimeoutFailure(
      generation,
      probe
        ? `${method} timed out and the liveness probe did not answer`
        : `${method} timed out`,
    )
    await this.failGeneration(
      generation,
      new Error('Complete the request within its bounded timeout.'),
    )
  }

  /** Share one in-flight liveness probe per generation among timed-out calls. */
  private probeLiveness(
    child: ChildProcessWithoutNullStreams,
    generation: number,
  ): Promise<boolean> {
    if (this.livenessProbe?.generation === generation) {
      return this.livenessProbe.answered
    }
    const answered = this.rawCall(
      child,
      generation,
      LIVENESS_METHOD,
      [],
      this.livenessTimeoutMs,
    )
      .then(
        (result) => result === 'alive',
        () => false,
      )
      .finally(() => {
        if (this.livenessProbe?.answered === answered) this.livenessProbe = null
      })
    this.livenessProbe = { generation, answered }
    return answered
  }

  private reportTimeoutFailure(generation: number, cause: string): void {
    let activeJobs = 0
    for (const job of this.activeScientificJobs.values()) {
      if (job.generation === generation) activeJobs += 1
    }
    process.stderr.write(
      `[sidecar] Failing scientific runtime generation ${generation}: ${cause}; stopping ${activeJobs} active scientific job(s).\n`,
    )
  }

  private onData(generation: number, chunk: string): void {
    if (generation !== this.generation) return
    this.stdoutBuffer += chunk
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const rawLine = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (Buffer.byteLength(rawLine, 'utf8') > this.maxProtocolLineBytes) {
        this.stdoutBuffer = ''
        void this.failGeneration(
          generation,
          new Error('Keep protocol lines within the byte limit.'),
        )
        return
      }
      const line = rawLine.trim()
      if (line) this.dispatch(generation, line)
      if (this.failedGeneration === generation) {
        this.stdoutBuffer = ''
        return
      }
      newline = this.stdoutBuffer.indexOf('\n')
    }
    if (
      Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.maxProtocolLineBytes
    ) {
      this.stdoutBuffer = ''
      void this.failGeneration(
        generation,
        new Error('Keep protocol lines within the byte limit.'),
      )
    }
  }

  private dispatch(generation: number, line: string): void {
    if (generation !== this.generation) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      process.stderr.write(
        `[sidecar] Review the discarded malformed protocol line (${Buffer.byteLength(line, 'utf8')} bytes).\n`,
      )
      void this.failGeneration(
        generation,
        new Error('Return a well-formed protocol response.'),
      )
      return
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0') {
      void this.failGeneration(
        generation,
        new Error('Provide a valid protocol response.'),
      )
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending || pending.generation !== generation) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (isRecord(message.error)) {
        pending.reject(publicRpcError(pending.method, message.error))
      } else if ('result' in message) {
        pending.resolve(message.result)
      } else {
        pending.reject(
          new Error('Return a valid response from the scientific runtime.'),
        )
      }
      return
    }
    if (typeof message.method === 'string') {
      this.handleNotification(generation, message.method, message.params)
      return
    }
    void this.failGeneration(
      generation,
      new Error('Return a classifiable protocol response.'),
    )
  }

  private handleNotification(
    generation: number,
    method: string,
    params: unknown,
  ): void {
    if (method === 'pipeline.jobUpdate') {
      this.trackScientificJob(generation, params)
    }
    if (method === 'system.projectAttachment') {
      if (!isRecord(params) || typeof params.attached !== 'boolean') {
        void this.failGeneration(
          generation,
          new Error('Provide a valid project attachment event.'),
        )
        return
      }
      this.setProjectAttached(params.attached)
      return
    }
    if (method === 'system.processOwnerRegistered') {
      const owner = this.parseProcessOwner(params, generation)
      if (!owner || !this.registrationAllowed(owner)) {
        void this.failGeneration(
          generation,
          new Error('Provide a valid process-owner registration.'),
        )
        return
      }
      const ownerKey = this.processOwnerKey(owner)
      if (
        [...this.ownedProcesses.values()].some(
          (processInfo) =>
            this.processOwnerKey(processInfo) === ownerKey &&
            processInfo.claimId !== owner.claimId,
        )
      ) {
        void this.failGeneration(
          generation,
          new Error(
            'Release the existing live process-owner claim before creating another.',
          ),
        )
        return
      }
      this.processOwners.set(ownerKey, owner)
      return
    }
    if (method === 'system.processStarted') {
      const owned = this.parseOwnedProcess(params, generation)
      const registration = owned
        ? this.processOwners.get(this.processOwnerKey(owned))
        : undefined
      if (
        !owned ||
        !registration ||
        !this.sameRegistration(owned, registration) ||
        !this.claimIdentityCurrent(owned) ||
        [...this.ownedProcesses.values()].some(
          (value) =>
            this.processOwnerKey(value) === this.processOwnerKey(owned),
        )
      ) {
        void this.failGeneration(
          generation,
          new Error('Provide a valid process-ownership event.'),
        )
        return
      }
      this.ownedProcesses.set(this.processClaimKey(owned), owned)
      if (owned.jobId) {
        this.settledScientificJobs.delete(
          this.scientificJobKey(generation, owned.jobId),
        )
      }
      this.sendProcessClaimAcceptance(generation, owned)
      return
    }
    if (method === 'system.processSettled') {
      const claim = this.parseOwnedProcess(params, generation)
      const registration = claim
        ? this.processOwners.get(this.processOwnerKey(claim))
        : undefined
      const owned = claim
        ? this.ownedProcesses.get(this.processClaimKey(claim))
        : undefined
      if (
        !claim ||
        !registration ||
        !this.sameRegistration(claim, registration) ||
        (owned !== undefined && !this.sameClaim(claim, owned))
      ) {
        void this.failGeneration(
          generation,
          new Error('Provide a valid process-ownership event.'),
        )
        return
      }
      if (!isRecord(params) || params.provedStopped !== true) return
      this.ownedProcesses.delete(this.processClaimKey(claim))
      if (claim.jobId) {
        this.settledScientificJobs.add(
          this.scientificJobKey(generation, claim.jobId),
        )
      }
      if (claim.operationKind === 'workflow') {
        this.processOwners.delete(this.processOwnerKey(claim))
      }
      return
    }
    if (method === 'system.processOwnerReleased') {
      const owner = this.parseProcessOwner(params, generation)
      const key = owner ? this.processOwnerKey(owner) : ''
      const registered = owner ? this.processOwners.get(key) : undefined
      const stillOwned = owner
        ? [...this.ownedProcesses.values()].some(
            (processInfo) => this.processOwnerKey(processInfo) === key,
          )
        : true
      if (
        !owner ||
        !registered ||
        !this.sameRegistration(owner, registered) ||
        stillOwned
      ) {
        void this.failGeneration(
          generation,
          new Error('Provide a valid process-owner release.'),
        )
        return
      }
      this.processOwners.delete(key)
      return
    }
    if (this.intentionalStop) return
    try {
      this.notificationHandler({ method, params, generation })
    } catch (error) {
      void error
      this.writeDiagnostic('Resolve the failed notification handler.')
    }
  }

  private scientificJobKey(generation: number, jobId: string): string {
    return `${generation}\0${jobId}`
  }

  private processOwnerKey(owner: ProcessOwnerRegistration): string {
    return `${owner.generation}\0${owner.operationKind}\0${owner.ownerId}`
  }

  private processClaimKey(owner: OwnedScientificProcess): string {
    return `${this.processOwnerKey(owner)}\0${owner.claimId}`
  }

  private parseProcessOwner(
    value: unknown,
    generation: number,
  ): ProcessOwnerRegistration | null {
    if (!isRecord(value) || value.generation !== generation) return null
    const operationKind = value.operationKind
    const ownerId = value.ownerId
    const projectId = value.projectId
    const projectEpoch = value.projectEpoch
    const claimId = value.claimId
    const runId = value.runId
    const jobId = value.jobId
    const operationId = value.operationId
    if (
      value.schemaVersion !== 1 ||
      (operationKind !== 'workflow' && operationKind !== 'provision') ||
      typeof ownerId !== 'string' ||
      ownerId.length === 0 ||
      ownerId.length > 256 ||
      /[\0\r\n]/.test(ownerId) ||
      typeof projectId !== 'string' ||
      projectId.length === 0 ||
      projectId.length > 256 ||
      /[\0\r\n]/.test(projectId) ||
      typeof projectEpoch !== 'number' ||
      !Number.isSafeInteger(projectEpoch) ||
      projectEpoch < 0 ||
      typeof claimId !== 'string' ||
      !claimId.startsWith('claim-') ||
      claimId.length > 128 ||
      /[\0\r\n]/.test(claimId) ||
      (runId !== null &&
        (typeof runId !== 'string' ||
          runId.length === 0 ||
          runId.length > 128 ||
          /[\0\r\n]/.test(runId))) ||
      (jobId !== null &&
        (typeof jobId !== 'string' ||
          jobId.length === 0 ||
          jobId.length > 256 ||
          /[\0\r\n]/.test(jobId))) ||
      (operationId !== null &&
        (typeof operationId !== 'string' ||
          operationId.length === 0 ||
          operationId.length > 256 ||
          /[\0\r\n]/.test(operationId)))
    ) {
      return null
    }
    if (
      (operationKind === 'workflow' &&
        (jobId !== ownerId || runId === null || operationId !== null)) ||
      (operationKind === 'provision' &&
        (operationId !== ownerId || runId !== null || jobId !== null))
    ) {
      return null
    }
    return {
      schemaVersion: 1,
      claimId,
      generation,
      operationKind,
      ownerId,
      projectId,
      projectEpoch,
      runId,
      jobId,
      operationId,
    }
  }

  private parseOwnedProcess(
    value: unknown,
    generation: number,
  ): OwnedScientificProcess | null {
    const owner = this.parseProcessOwner(value, generation)
    if (!owner || !isRecord(value)) return null
    const pid = value.pid
    const pgid = value.pgid
    const startIdentity = value.startIdentity
    if (
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      typeof pgid !== 'number' ||
      !Number.isSafeInteger(pgid) ||
      pgid !== pid ||
      typeof startIdentity !== 'string' ||
      startIdentity.length === 0 ||
      startIdentity.length > 256 ||
      /[\0\r\n]/.test(startIdentity) ||
      !this.platformStartIdentityValid(startIdentity)
    ) {
      return null
    }
    return {
      ...owner,
      pid,
      pgid,
      startIdentity,
    }
  }

  private registrationAllowed(owner: ProcessOwnerRegistration): boolean {
    if (owner.operationKind === 'provision') return true
    const job = this.activeScientificJobs.get(
      this.scientificJobKey(owner.generation, owner.jobId ?? ''),
    )
    return (
      job !== undefined &&
      (job.status === 'running' || job.status === 'cancelling') &&
      (job.projectId === null || job.projectId === owner.projectId) &&
      (job.projectEpoch === null || job.projectEpoch === owner.projectEpoch) &&
      (job.runId === null || job.runId === owner.runId)
    )
  }

  private sameRegistration(
    left: ProcessOwnerRegistration,
    right: ProcessOwnerRegistration,
  ): boolean {
    return (
      left.schemaVersion === right.schemaVersion &&
      left.claimId === right.claimId &&
      left.generation === right.generation &&
      left.operationKind === right.operationKind &&
      left.ownerId === right.ownerId &&
      left.projectId === right.projectId &&
      left.projectEpoch === right.projectEpoch &&
      left.runId === right.runId &&
      left.jobId === right.jobId &&
      left.operationId === right.operationId
    )
  }

  private sameClaim(
    left: OwnedScientificProcess,
    right: OwnedScientificProcess,
  ): boolean {
    return (
      this.sameRegistration(left, right) &&
      left.claimId === right.claimId &&
      left.pid === right.pid &&
      left.pgid === right.pgid &&
      left.startIdentity === right.startIdentity
    )
  }

  private claimIdentityCurrent(owner: OwnedScientificProcess): boolean {
    if (
      process.env['NODE_ENV'] === 'test' &&
      owner.startIdentity.startsWith('test:')
    ) {
      return true
    }
    const current = this.processIdentityProbe(owner.pid, this.processPlatform)
    return current.state === 'alive' && current.identity === owner.startIdentity
  }

  private platformStartIdentityValid(startIdentity: string): boolean {
    if (
      process.env['NODE_ENV'] === 'test' &&
      /^test:[1-9]\d*:[^\0\r\n]+$/.test(startIdentity)
    ) {
      return true
    }
    if (this.processPlatform === 'linux') {
      return /^linux:[^:\0\r\n]{1,128}:[1-9]\d*$/.test(startIdentity)
    }
    if (this.processPlatform === 'win32') {
      return /^windows:[1-9]\d*$/.test(startIdentity)
    }
    return (
      startIdentity.startsWith(`${this.processPlatform}:`) &&
      startIdentity.length > this.processPlatform.length + 1
    )
  }

  private sendProcessClaimAcceptance(
    generation: number,
    owner: OwnedScientificProcess,
  ): void {
    const child = this.child
    if (!child || generation !== this.generation) return
    const payload = `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'system.acceptProcessClaim',
      params: [{ ...owner, accepted: true }],
    })}\n`
    const failWrite = (error: Error): void => {
      void this.failGeneration(generation, error)
    }
    try {
      child.stdin.write(payload, (error) => {
        if (error) failWrite(error)
      })
    } catch (error) {
      failWrite(
        error instanceof Error
          ? error
          : new Error('Acknowledge the process claim successfully.'),
      )
    }
  }

  private trackScientificJob(generation: number, params: unknown): void {
    if (!isRecord(params)) return
    const jobId = String(params.id ?? '')
    const status = String(params.status ?? '')
    if (!jobId || jobId.length > 256) return
    const key = this.scientificJobKey(generation, jobId)
    if (ACTIVE_SCIENTIFIC_JOB_STATES.has(status)) {
      this.activeScientificJobs.set(key, {
        generation,
        status: status as ActiveScientificJob['status'],
        projectId:
          typeof params.projectId === 'string' ? params.projectId : null,
        projectEpoch: Number.isSafeInteger(params.projectEpoch)
          ? Number(params.projectEpoch)
          : null,
        runId: typeof params.runId === 'string' ? params.runId : null,
      })
      return
    }
    this.activeScientificJobs.delete(key)
    this.settledScientificJobs.delete(key)
  }

  private onStderr(generation: number, chunk: string): void {
    if (generation !== this.generation || this.intentionalStop) return
    this.stderrBuffer += chunk
    if (
      Buffer.byteLength(this.stderrBuffer, 'utf8') > MAX_STDERR_BUFFER_BYTES
    ) {
      this.writeDiagnostic('Review the truncated sidecar stderr buffer.')
      this.stderrBuffer = ''
      return
    }
    let newline = this.stderrBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.stderrBuffer.slice(0, newline)
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1)
      if (line.trim()) {
        process.stderr.write(
          `[sidecar] Review the redacted stderr content (${Math.min(Buffer.byteLength(line, 'utf8'), MAX_DIAGNOSTIC_CHARS)} bytes).\n`,
        )
      }
      newline = this.stderrBuffer.indexOf('\n')
    }
  }

  private writeDiagnostic(line: unknown): void {
    void line
    process.stderr.write('[sidecar] Review the redacted runtime diagnostic.\n')
  }

  private async failGeneration(
    generation: number,
    error: Error,
  ): Promise<void> {
    if (
      generation !== this.generation ||
      this.failedGeneration === generation
    ) {
      return
    }
    if (this.intentionalStop) {
      this.rejectGeneration(
        generation,
        new SidecarAvailabilityError(
          'Keep the scientific runtime running until shutdown.',
        ),
      )
      return
    }
    this.failedGeneration = generation
    if (this.restartBudgetResetTimer) {
      clearTimeout(this.restartBudgetResetTimer)
      this.restartBudgetResetTimer = null
    }
    const child = this.child
    this.child = null
    this.rejectGeneration(generation, new SidecarAvailabilityError())
    const runningWithoutOwnership = this.hasRunningWithoutOwnership(generation)
    const childStopped = child ? await this.terminateTree(child, false) : true
    const scientificWorkStopped = await this.terminateOwnedProcesses(generation)
    this.clearScientificJobState(generation)
    this.transition('degraded', generation)
    this.writeDiagnostic(error)
    if (runningWithoutOwnership) {
      this.unprovedScientificWork = true
      this.transition(
        'unavailable',
        generation,
        'Restore scientific process ownership because it is incomplete; block duplicate execution until then.',
        false,
      )
      return
    }
    if (!childStopped || !scientificWorkStopped) {
      this.transition(
        'unavailable',
        generation,
        'Resolve the possibly active prior scientific work before retrying.',
      )
      return
    }
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.intentionalStop || this.restartTimer) return
    if (this.automaticRestarts >= this.maxAutomaticRestarts) {
      this.transition('unavailable')
      return
    }
    const attempt = this.automaticRestarts++
    const delay =
      this.restartBackoffMs[
        Math.min(attempt, this.restartBackoffMs.length - 1)
      ] ?? DEFAULT_RESTART_BACKOFF_MS.at(-1)!
    this.transition('restarting')
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.intentionalStop) return
      this.startPromise = this.launchGeneration('restarting').finally(() => {
        this.startPromise = null
      })
      void this.startPromise.catch(() => undefined)
    }, delay)
  }

  private rejectGeneration(generation: number, reason: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(reason)
    }
  }

  private rejectAll(reason: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pending.clear()
  }

  private transition(
    state: SidecarHostState['state'],
    generation = this.generation,
    detail = fixedDetail(state),
    retryable?: boolean,
  ): void {
    this.health = {
      state,
      generation,
      productVersion: null,
      protocolVersion: null,
      persistenceVersions: null,
      capabilities: [],
      runtimeId: null,
      projectAttached: false,
      retryable:
        retryable ??
        (state === 'degraded' ||
          state === 'restarting' ||
          state === 'unavailable'),
      detail,
    }
    this.publishState()
  }

  private publishState(): void {
    try {
      this.stateHandler(this.getState())
    } catch (error) {
      void error
      this.writeDiagnostic('Resolve the failed state handler.')
    }
  }

  private async performStop(): Promise<void> {
    const child = this.child
    if (!child) {
      this.rejectAll(
        new SidecarAvailabilityError(
          'Keep the scientific runtime running until shutdown.',
        ),
      )
      if (
        this.unprovedScientificWork ||
        !(await this.terminateOwnedProcesses())
      ) {
        this.transition(
          'unavailable',
          this.generation,
          'Resolve the possibly active prior scientific work before quitting.',
        )
        throw new SidecarAvailabilityError(
          'Prove that the scientific process exited before continuing.',
        )
      }
      this.transition('unavailable')
      this.clearScientificJobState()
      return
    }
    const generation = this.generation
    this.rejectGeneration(
      generation,
      new SidecarAvailabilityError('Wait for the scientific runtime to stop.'),
    )
    let gracefulWorkStopped = false
    try {
      const result = await this.rawCall(
        child,
        generation,
        'system.shutdown',
        [{ timeoutMs: this.shutdownTimeoutMs }],
        this.shutdownTimeoutMs,
      )
      gracefulWorkStopped =
        isRecord(result) &&
        result.ok === true &&
        result.closing === true &&
        Number(result.activeJobs ?? 0) === 0 &&
        Number(result.activeProvisioning ?? 0) === 0 &&
        Number(result.activeManagedResources ?? 0) === 0
    } catch {
      // Let the bounded tree termination below remain authoritative.
    }
    const runningWithoutOwnership = this.hasRunningWithoutOwnership(generation)
    this.child = null
    const childStopped = await this.terminateTree(child, true)
    const scientificWorkStopped = await this.terminateOwnedProcesses(generation)
    this.clearScientificJobState(generation)
    this.rejectAll(
      new SidecarAvailabilityError(
        'Keep the scientific runtime running until shutdown.',
      ),
    )
    if (
      (!gracefulWorkStopped && runningWithoutOwnership) ||
      !childStopped ||
      !scientificWorkStopped
    ) {
      if (!gracefulWorkStopped && runningWithoutOwnership) {
        this.unprovedScientificWork = true
      }
      this.transition(
        'unavailable',
        generation,
        'Resolve the possibly active prior scientific work before quitting.',
        !this.unprovedScientificWork,
      )
      throw new SidecarAvailabilityError(
        'Prove that the scientific process exited before continuing.',
      )
    }
    this.transition('unavailable')
  }

  private clearScientificJobState(generation?: number): void {
    for (const [key, job] of this.activeScientificJobs) {
      if (generation === undefined || job.generation === generation) {
        this.activeScientificJobs.delete(key)
      }
    }
    const prefix = generation === undefined ? null : `${generation}\0`
    for (const key of this.settledScientificJobs) {
      if (prefix === null || key.startsWith(prefix)) {
        this.settledScientificJobs.delete(key)
      }
    }
    for (const [key, owner] of this.processOwners) {
      if (
        (generation === undefined || owner.generation === generation) &&
        ![...this.ownedProcesses.values()].some(
          (processInfo) => this.processOwnerKey(processInfo) === key,
        )
      ) {
        this.processOwners.delete(key)
      }
    }
  }

  private hasRunningWithoutOwnership(generation: number): boolean {
    const ownedJobs = new Set(
      [...this.ownedProcesses.values()]
        .filter((processInfo) => processInfo.generation === generation)
        .flatMap((processInfo) =>
          processInfo.jobId
            ? [this.scientificJobKey(generation, processInfo.jobId)]
            : [],
        ),
    )
    return [...this.activeScientificJobs].some(
      ([key, job]) =>
        job.generation === generation &&
        (job.status === 'running' || job.status === 'cancelling') &&
        !this.settledScientificJobs.has(key) &&
        !ownedJobs.has(key),
    )
  }

  private async terminateTree(
    child: ChildProcessWithoutNullStreams,
    graceful: boolean,
  ): Promise<boolean> {
    const pid = child.pid
    if (pid && process.platform !== 'win32') {
      if (!this.processGroupAlive(pid)) return true
      if (graceful) {
        await this.waitForExit(child, 300)
        if (!this.processGroupAlive(pid)) return true
      }
      this.signalTree(child, 'SIGTERM')
      if (
        await this.waitForProcessGroupExit(
          pid,
          Math.min(this.shutdownTimeoutMs, 3_000),
        )
      ) {
        return true
      }
      this.signalTree(child, 'SIGKILL')
      return this.waitForProcessGroupExit(pid, 1_000)
    }
    if (child.exitCode !== null || child.signalCode !== null) return true
    if (graceful && (await this.waitForExit(child, 300))) return true
    this.signalTree(child, 'SIGTERM')
    if (
      await this.waitForExit(child, Math.min(this.shutdownTimeoutMs, 3_000))
    ) {
      return true
    }
    this.signalTree(child, 'SIGKILL')
    return this.waitForExit(child, 1_000)
  }

  private processGroupAlive(pgid: number): boolean {
    try {
      process.kill(-pgid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  private async waitForProcessGroupExit(
    pgid: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.processGroupAlive(pgid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return !this.processGroupAlive(pgid)
  }

  private async terminateOwnedProcesses(generation?: number): Promise<boolean> {
    const targets = [...this.ownedProcesses.entries()].filter(
      ([, processInfo]) =>
        generation === undefined || processInfo.generation === generation,
    )
    if (targets.length === 0) return true
    for (const [, processInfo] of targets) {
      if (this.ownedProcessState(processInfo) === 'alive') {
        this.signalOwnedProcess(processInfo, false)
      }
    }
    await this.waitForOwnedProcesses(targets, 750)
    const remaining = targets.filter(
      ([, processInfo]) => this.ownedProcessState(processInfo) !== 'dead',
    )
    for (const [, processInfo] of remaining) {
      if (this.ownedProcessState(processInfo) === 'alive') {
        this.signalOwnedProcess(processInfo, true)
      }
    }
    await this.waitForOwnedProcesses(remaining, 1_000)
    let proved = true
    for (const [key, processInfo] of targets) {
      if (this.ownedProcessState(processInfo) !== 'dead') {
        proved = false
      } else {
        this.ownedProcesses.delete(key)
        this.processOwners.delete(this.processOwnerKey(processInfo))
        if (processInfo.jobId) {
          this.settledScientificJobs.add(
            this.scientificJobKey(processInfo.generation, processInfo.jobId),
          )
        }
      }
    }
    return proved
  }

  private signalOwnedProcess(
    processInfo: OwnedScientificProcess,
    force: boolean,
  ): void {
    if (process.platform !== 'win32') {
      try {
        process.kill(-processInfo.pgid, force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        // Let verification below distinguish an exited process from an unproved one.
      }
      return
    }
    try {
      const taskkill = spawn(
        'taskkill.exe',
        ['/pid', String(processInfo.pid), '/T', ...(force ? ['/F'] : [])],
        { stdio: 'ignore', windowsHide: true },
      )
      taskkill.unref()
    } catch {
      // Let the verification below remain authoritative.
    }
  }

  private processGroupState(pgid: number): ProcessProbe {
    try {
      process.kill(-pgid, 0)
      return 'alive'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return 'dead'
      return 'unknown'
    }
  }

  private ownedProcessState(processInfo: OwnedScientificProcess): ProcessProbe {
    const identityPrefix =
      this.processPlatform === 'win32' ? 'windows:' : `${this.processPlatform}:`
    if (processInfo.startIdentity.startsWith(identityPrefix)) {
      const identity = this.processIdentityProbe(
        processInfo.pid,
        this.processPlatform,
      )
      if (
        identity.state === 'alive' &&
        identity.identity !== processInfo.startIdentity
      ) {
        return 'dead'
      }
      if (identity.state === 'unknown') return 'unknown'
      if (this.processPlatform === 'win32') return identity.state
      return this.processGroupState(processInfo.pgid)
    }
    if (process.platform !== 'win32') {
      return this.processGroupState(processInfo.pgid)
    }
    try {
      process.kill(processInfo.pid, 0)
      return 'alive'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return 'dead'
      return 'unknown'
    }
  }

  private async waitForOwnedProcesses(
    targets: Array<[string, OwnedScientificProcess]>,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (
      targets.some(
        ([, processInfo]) => this.ownedProcessState(processInfo) === 'alive',
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  private signalTree(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void {
    const pid = child.pid
    if (pid && process.platform !== 'win32') {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // Fall back to the immediate process if the group already disappeared.
      }
    }
    if (pid && process.platform === 'win32') {
      try {
        const taskkill = spawn(
          'taskkill.exe',
          ['/pid', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
          { stdio: 'ignore', windowsHide: true },
        )
        taskkill.unref()
        return
      } catch {
        // Fall back to ChildProcess.kill below.
      }
    }
    try {
      child.kill(signal)
    } catch {
      // Treat a concurrently exited child as already settled.
    }
  }

  private waitForExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null)
      return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (exited: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off('exit', onExit)
        resolve(exited)
      }
      const onExit = (): void => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      child.once('exit', onExit)
    })
  }
}
