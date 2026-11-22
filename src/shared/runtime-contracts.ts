import type {
  EnvInstallState,
  ProvisionLogLine,
  ProvisionProgress,
  ProvisionStatus,
  QuotedReasonNode,
  RunSnapshot,
  RuntimeEvent,
  RuntimeLogLine,
  RuntimeLogReplay,
  RuntimeSnapshot,
  WorkflowAcknowledgements,
  WorkflowSummary,
} from './contract'
import { parseExecutionFallback } from './execution-fallback'
import { parseUnitReuseSummary } from './unit-reuse'
import { STEP_KEYS, type StepKey } from './steps'
import type { Job, JobStatus, ProjectRef } from './types'

const MAX_ID_LENGTH = 256
const MAX_PATH_LENGTH = 16_384
const MAX_COMMAND_LENGTH = 65_536
const MAX_LINE_LENGTH = 65_536
const MAX_MESSAGE_LENGTH = 8_192
const MAX_SUBJECTS = 20_000
// Mirror the sidecar install manager's output bounds.
const MAX_INSTALL_TAIL_LENGTH = 8_192
const MAX_INSTALL_OUTPUT_LENGTH = 65_536

const JOB_STATUSES = new Set<JobStatus>([
  'planned',
  'waiting',
  'queued',
  'running',
  'cancelling',
  'done',
  'failed',
  'cancelled',
  'blocked',
  'withheld',
  'interrupted',
  'stale',
  'persistence-error',
  'unknown',
])
const STEP_KEY_SET = new Set<string>(STEP_KEYS)

/** One validated pipeline stdout notification. */
export interface PipelineStdoutEvent {
  jobId: string
  line: string
  lev: 'INFO' | 'WARN' | 'ERROR'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new TypeError(`Provide a bounded ${label}.`)
  }
  return value
}

function identifier(value: unknown, label: string): string {
  return boundedString(value, label, MAX_ID_LENGTH)
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : identifier(value, label)
}

function nullableText(
  value: unknown,
  label: string,
  maximum = MAX_MESSAGE_LENGTH,
): string | null {
  return value === null ? null : boundedString(value, label, maximum, true)
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`Set ${label} to a non-negative safe integer.`)
  }
  return Number(value)
}

function nullableTimestamp(value: unknown, label: string): number | null {
  return value === null ? null : nonNegativeInteger(value, label)
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Set ${label} to true or false.`)
  }
  return value
}

function oneOf<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  label: string,
): T {
  if (typeof value !== 'string' || !values.has(value as T)) {
    throw new TypeError(`Provide a supported ${label}.`)
  }
  return value as T
}

function jobStatus(value: unknown): JobStatus {
  return oneOf(value, JOB_STATUSES, 'job status')
}

function stepKey(value: unknown): StepKey {
  if (typeof value !== 'string' || !STEP_KEY_SET.has(value)) {
    throw new TypeError('Provide a supported pipeline step key.')
  }
  return value as StepKey
}

function nullableExitCode(value: unknown): number | null {
  if (value === null) return null
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < -65_535 ||
    Number(value) > 65_535
  ) {
    throw new TypeError('Provide a bounded integer process exit code.')
  }
  return Number(value)
}

function optionalIdentifier(
  source: Record<string, unknown>,
  key: string,
  target: Record<string, unknown>,
): void {
  if (key in source) target[key] = identifier(source[key], key)
}

function subjectList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_SUBJECTS) {
    throw new TypeError(`Provide a bounded ${label}.`)
  }
  return value.map((entry) => identifier(entry, `${label} entry`))
}

/**
 * Parse and project one untrusted scientific-job notification.
 *
 * Unknown fields are intentionally omitted so Python-only state cannot cross
 * the renderer boundary without becoming part of this contract.
 */
export function parseRuntimeJob(value: unknown): Job {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid scientific-job event.')
  }
  const parsed: Job = {
    id: identifier(value.id, 'job ID'),
    stepKey: stepKey(value.stepKey),
    subjectId: nullableIdentifier(value.subjectId, 'subject ID'),
    startedAt: nullableTimestamp(value.startedAt, 'job start time'),
    endedAt: nullableTimestamp(value.endedAt, 'job end time'),
    exitCode: nullableExitCode(value.exitCode),
    cmd: boundedString(
      value.cmd,
      'job command projection',
      MAX_COMMAND_LENGTH,
      true,
    ),
    stdoutPath: boundedString(
      value.stdoutPath,
      'stdout path',
      MAX_PATH_LENGTH,
      true,
    ),
    stderrPath: boundedString(
      value.stderrPath,
      'stderr path',
      MAX_PATH_LENGTH,
      true,
    ),
    envSnapshotPath: boundedString(
      value.envSnapshotPath,
      'environment snapshot path',
      MAX_PATH_LENGTH,
      true,
    ),
    configSnapshotPath: boundedString(
      value.configSnapshotPath,
      'configuration snapshot path',
      MAX_PATH_LENGTH,
      true,
    ),
    status: jobStatus(value.status),
  }
  const target = parsed as unknown as Record<string, unknown>
  for (const key of ['runId', 'nodeId', 'projectId'] as const) {
    optionalIdentifier(value, key, target)
  }
  if ('projectEpoch' in value) {
    parsed.projectEpoch = nonNegativeInteger(
      value.projectEpoch,
      'job project epoch',
    )
  }
  if ('sidecarGeneration' in value) {
    parsed.sidecarGeneration = nonNegativeInteger(
      value.sidecarGeneration,
      'job sidecar generation',
    )
  }
  if ('scope' in value) {
    parsed.scope = oneOf(
      value.scope,
      new Set(['subject', 'cohort'] as const),
      'job scope',
    )
  }
  if ('plannedAt' in value) {
    parsed.plannedAt = nonNegativeInteger(value.plannedAt, 'job plan time')
  }
  if ('dryRun' in value) parsed.dryRun = booleanValue(value.dryRun, 'dryRun')
  if ('durable' in value) {
    parsed.durable = booleanValue(value.durable, 'durable')
  }
  if ('persistenceStatus' in value) {
    parsed.persistenceStatus = oneOf(
      value.persistenceStatus,
      new Set(['pending', 'durable', 'error'] as const),
      'job persistence status',
    )
  }
  if ('terminalReason' in value) {
    parsed.terminalReason = nullableText(
      value.terminalReason,
      'terminal reason',
    )
  }
  if ('failureCause' in value) {
    parsed.failureCause = boundedString(
      value.failureCause,
      'failure cause',
      MAX_MESSAGE_LENGTH,
    )
  }
  if ('executionFallback' in value) {
    parsed.executionFallback = parseExecutionFallback(
      value.executionFallback,
      'job execution fallback',
    )
  }
  if ('unitReuse' in value) {
    parsed.unitReuse = parseUnitReuseSummary(
      value.unitReuse,
      'job per-subject reuse',
    )
  }
  if ('backend' in value) {
    parsed.backend = oneOf(
      value.backend,
      new Set(['freesurfer', 'fastsurfer'] as const),
      'reconstruction backend',
    )
  }
  if ('attemptOrdinal' in value) {
    const ordinal = nonNegativeInteger(value.attemptOrdinal, 'attempt ordinal')
    if (ordinal < 1) throw new TypeError('Start attempt ordinals at one.')
    parsed.attemptOrdinal = ordinal
  }
  if ('role' in value) {
    parsed.role = oneOf(
      value.role,
      new Set(['primary', 'superseded-primary', 'fallback'] as const),
      'reconstruction role',
    )
  }
  if ('supersedesJobId' in value) {
    parsed.supersedesJobId = identifier(
      value.supersedesJobId,
      'superseded job ID',
    )
  }
  if ('fallbackReasonTag' in value) {
    parsed.fallbackReasonTag = identifier(
      value.fallbackReasonTag,
      'fallback reason tag',
    )
  }
  return parsed
}

/** Parse one bounded pipeline stdout notification. */
export function parsePipelineStdout(value: unknown): PipelineStdoutEvent {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid pipeline stdout event.')
  }
  return {
    jobId: identifier(value.jobId, 'stdout job ID'),
    line: boundedString(value.line, 'stdout line', MAX_LINE_LENGTH, true),
    lev: oneOf(
      value.lev,
      new Set(['INFO', 'WARN', 'ERROR'] as const),
      'stdout level',
    ),
  }
}

/** Parse one bounded PyBrainAge provisioning progress notification. */
export function parseProvisionProgress(value: unknown): ProvisionProgress {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid provisioning progress event.')
  }
  const percent = value.percent
  if (
    percent !== null &&
    (!Number.isInteger(percent) || Number(percent) < 0 || Number(percent) > 100)
  ) {
    throw new TypeError('Keep provisioning progress between 0 and 100.')
  }
  return {
    phase: oneOf(
      value.phase,
      new Set([
        'env',
        'download',
        'verify',
        'validate',
        'done',
        'error',
      ] as const),
      'provisioning phase',
    ),
    percent: percent === null ? null : Number(percent),
    message: boundedString(
      value.message,
      'provisioning message',
      MAX_MESSAGE_LENGTH,
      true,
    ),
    projectId: identifier(value.projectId, 'provisioning project ID'),
    projectEpoch: nonNegativeInteger(
      value.projectEpoch,
      'provisioning project epoch',
    ),
    operationId: identifier(value.operationId, 'provisioning operation ID'),
  }
}

/** Parse one bounded provisioning log line. */
export function parseProvisionLog(value: unknown): ProvisionLogLine {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid provisioning log line.')
  }
  return {
    projectId: identifier(value.projectId, 'provisioning project ID'),
    projectEpoch: nonNegativeInteger(
      value.projectEpoch,
      'provisioning project epoch',
    ),
    operationId: identifier(value.operationId, 'provisioning operation ID'),
    at: nonNegativeInteger(value.at, 'provisioning log time'),
    line: boundedString(
      value.line,
      'provisioning log line',
      MAX_MESSAGE_LENGTH,
      true,
    ),
  }
}

/**
 * Parse one bounded environment-installation snapshot.
 *
 * Enforce the sidecar's lifecycle invariants so the screens cannot show a
 * finished installation without an exit code, or a successful one whose
 * installer reported a failure.
 */
export function parseEnvInstallState(value: unknown): EnvInstallState {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid installation state.')
  }
  const phase = oneOf(
    value.phase,
    new Set(['queued', 'running', 'done', 'error'] as const),
    'installation phase',
  )
  const rc = nullableExitCode(value.rc)
  const terminal = phase === 'done' || phase === 'error'
  if (terminal !== (rc !== null) || (phase === 'done' && rc !== 0)) {
    throw new TypeError(
      'Provide an installation exit code that matches its phase.',
    )
  }
  return {
    operationId: identifier(value.operationId, 'installation operation ID'),
    checkId: identifier(value.checkId, 'installation check ID'),
    projectId: identifier(value.projectId, 'installation project ID'),
    projectEpoch: nonNegativeInteger(
      value.projectEpoch,
      'installation project epoch',
    ),
    phase,
    startedAt: nonNegativeInteger(value.startedAt, 'installation start time'),
    updatedAt: nonNegativeInteger(value.updatedAt, 'installation update time'),
    output: boundedString(
      value.output,
      'installation output tail',
      MAX_INSTALL_TAIL_LENGTH,
      true,
    ),
    rc,
    stdout: boundedString(
      value.stdout,
      'installation stdout',
      MAX_INSTALL_OUTPUT_LENGTH,
      true,
    ),
    stderr: boundedString(
      value.stderr,
      'installation stderr',
      MAX_INSTALL_OUTPUT_LENGTH,
      true,
    ),
  }
}

export function parseWorkflowSummary(value: unknown): WorkflowSummary {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid workflow summary.')
  }
  return {
    planned: nonNegativeInteger(value.planned, 'planned workflow count'),
    started: nonNegativeInteger(value.started, 'started workflow count'),
    waiting: nonNegativeInteger(value.waiting, 'waiting workflow count'),
    blocked: nonNegativeInteger(value.blocked, 'blocked workflow count'),
    skipped: nonNegativeInteger(value.skipped, 'skipped workflow count'),
    message: boundedString(
      value.message,
      'workflow summary message',
      MAX_MESSAGE_LENGTH,
      true,
    ),
  }
}

export function parseAcknowledgements(
  value: unknown,
): WorkflowAcknowledgements {
  if (!isRecord(value)) {
    throw new TypeError('Provide valid workflow acknowledgements.')
  }
  return {
    includeDeferredAndUnreviewedQc: booleanValue(
      value.includeDeferredAndUnreviewedQc,
      'includeDeferredAndUnreviewedQc',
    ),
    acknowledgeMemoryAdvisory: booleanValue(
      value.acknowledgeMemoryAdvisory,
      'acknowledgeMemoryAdvisory',
    ),
  }
}

/** How many quoted-reason nodes one run snapshot may list. */
const MAX_QUOTED_REASON_NODES = 256

const QUOTED_REASON_NODE_STATUSES = new Set<QuotedReasonNode['status']>([
  'blocked',
  'withheld',
  'stale',
])

function parseQuotedReasonNodes(value: unknown): QuotedReasonNode[] {
  if (!Array.isArray(value) || value.length > MAX_QUOTED_REASON_NODES) {
    throw new TypeError('Provide a bounded quoted-reason node list.')
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new TypeError('Provide a valid quoted-reason node.')
    }
    return {
      stepKey: stepKey(entry.stepKey),
      subjectId: nullableIdentifier(entry.subjectId, 'quoted-reason subject'),
      status: oneOf(
        entry.status,
        QUOTED_REASON_NODE_STATUSES,
        'quoted-reason node status',
      ),
      reason: boundedString(entry.reason, 'quoted reason', MAX_MESSAGE_LENGTH),
    }
  })
}

export function parseRunSnapshot(value: unknown): RunSnapshot {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid runtime run snapshot.')
  }
  const parsed: RunSnapshot = {
    runId: identifier(value.runId, 'run ID'),
    projectId: identifier(value.projectId, 'run project ID'),
    projectEpoch: nonNegativeInteger(value.projectEpoch, 'run project epoch'),
    status: jobStatus(value.status),
    startedAt: nullableTimestamp(value.startedAt, 'run start time'),
    endedAt: nullableTimestamp(value.endedAt, 'run end time'),
    dryRun: booleanValue(value.dryRun, 'run dryRun'),
    durable: booleanValue(value.durable, 'run durable'),
    acknowledgements: parseAcknowledgements(value.acknowledgements),
    summary: parseWorkflowSummary(value.summary),
  }
  if ('analysisSubjectIds' in value) {
    parsed.analysisSubjectIds = subjectList(
      value.analysisSubjectIds,
      'analysis subject list',
    )
  }
  if ('selectedSubjectIds' in value) {
    parsed.selectedSubjectIds = subjectList(
      value.selectedSubjectIds,
      'selected subject list',
    )
  }
  if ('quotedReasonNodes' in value) {
    parsed.quotedReasonNodes = parseQuotedReasonNodes(value.quotedReasonNodes)
  }
  return parsed
}

export function parseRuntimeLogLine(value: unknown): RuntimeLogLine {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid runtime log event.')
  }
  return {
    id: identifier(value.id, 'runtime log ID'),
    runId: identifier(value.runId, 'runtime log run ID'),
    jobId: identifier(value.jobId, 'runtime log job ID'),
    at: nonNegativeInteger(value.at, 'runtime log time'),
    level: oneOf(
      value.level,
      new Set(['INFO', 'WARN', 'ERROR'] as const),
      'runtime log level',
    ),
    line: boundedString(value.line, 'runtime log line', MAX_LINE_LENGTH, true),
  }
}

export function parseProvisionStatus(value: unknown): ProvisionStatus {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid provisioning status event.')
  }
  return {
    envReady: booleanValue(value.envReady, 'environment readiness'),
    modelReady: booleanValue(value.modelReady, 'model readiness'),
    pythonExecutable: nullableText(
      value.pythonExecutable,
      'Python executable path',
      MAX_PATH_LENGTH,
    ),
    modelPath: nullableText(value.modelPath, 'model path', MAX_PATH_LENGTH),
    scalerPath: nullableText(value.scalerPath, 'scaler path', MAX_PATH_LENGTH),
    projectId: identifier(value.projectId, 'provisioning status project ID'),
    projectEpoch: nonNegativeInteger(
      value.projectEpoch,
      'provisioning status project epoch',
    ),
    configRevision: nonNegativeInteger(
      value.configRevision,
      'provisioning config revision',
    ),
    operationId: nullableIdentifier(
      value.operationId,
      'provisioning status operation ID',
    ),
    phase: oneOf(
      value.phase,
      new Set(['idle', 'running', 'done', 'error', 'cancelled'] as const),
      'provisioning status phase',
    ),
    cancellable: booleanValue(value.cancellable, 'provisioning cancellable'),
    error: nullableText(value.error, 'provisioning error'),
  }
}

function parseProjectRef(value: unknown): ProjectRef {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid runtime project identity.')
  }
  return {
    projectId: identifier(value.projectId, 'runtime project ID'),
    root: boundedString(value.root, 'runtime project root', MAX_PATH_LENGTH),
    configPath: boundedString(
      value.configPath,
      'runtime configuration path',
      MAX_PATH_LENGTH,
    ),
    epoch: nonNegativeInteger(value.epoch, 'runtime project epoch'),
  }
}

/**
 * The most job logs one bootstrap replay opens, mirroring the runtime's
 * `_REPLAY_LOG_FILE_LIMIT`; the replay reports at most one entry per log.
 */
export const MAX_LOG_REPLAY_ENTRIES = 512

function parseRuntimeLogReplay(value: unknown): RuntimeLogReplay {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid runtime log replay entry.')
  }
  return {
    runId: identifier(value.runId, 'log replay run ID'),
    jobId: identifier(value.jobId, 'log replay job ID'),
    lines: nonNegativeInteger(value.lines, 'log replay line count'),
    complete: booleanValue(value.complete, 'log replay completeness'),
  }
}

/**
 * Parse the bootstrap replay coverage. An absent field parses as no coverage and is left out, so no job log reads as empty.
 */
function parseRuntimeLogReplayList(
  value: unknown,
): RuntimeLogReplay[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_LOG_REPLAY_ENTRIES) {
    throw new TypeError('Provide bounded runtime log replay coverage.')
  }
  return value.map(parseRuntimeLogReplay)
}

/** Parse and project one complete runtime bootstrap snapshot. */
export function parseRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  if (
    !isRecord(value) ||
    !Array.isArray(value.runs) ||
    value.runs.length > 5_000 ||
    !Array.isArray(value.jobs) ||
    value.jobs.length > 20_000 ||
    !Array.isArray(value.logTail) ||
    value.logTail.length > 20_000
  ) {
    throw new TypeError('Provide a bounded runtime bootstrap snapshot.')
  }
  const parsed: RuntimeSnapshot = {
    project: parseProjectRef(value.project),
    sidecarGeneration: nonNegativeInteger(
      value.sidecarGeneration,
      'runtime sidecar generation',
    ),
    sequence: nonNegativeInteger(value.sequence, 'runtime sequence'),
    runs: value.runs.map(parseRunSnapshot),
    jobs: value.jobs.map(parseRuntimeJob),
    logTail: value.logTail.map(parseRuntimeLogLine),
    provision:
      value.provision === null ? null : parseProvisionStatus(value.provision),
  }
  const logReplay = parseRuntimeLogReplayList(value.logReplay)
  if (logReplay !== undefined) parsed.logReplay = logReplay
  for (const run of parsed.runs) {
    assertRuntimeIdentity(
      {
        projectId: parsed.project.projectId,
        projectEpoch: parsed.project.epoch,
        sidecarGeneration: parsed.sidecarGeneration,
        runId: run.runId,
      },
      run,
    )
  }
  for (const job of parsed.jobs) {
    if (
      (job.projectId !== undefined &&
        job.projectId !== parsed.project.projectId) ||
      (job.projectEpoch !== undefined &&
        job.projectEpoch !== parsed.project.epoch) ||
      (job.sidecarGeneration !== undefined &&
        job.sidecarGeneration !== parsed.sidecarGeneration)
    ) {
      throw new TypeError('Keep bootstrap job identity consistent.')
    }
  }
  if (parsed.provision !== null) {
    assertRuntimeIdentity(
      {
        projectId: parsed.project.projectId,
        projectEpoch: parsed.project.epoch,
        sidecarGeneration: parsed.sidecarGeneration,
        runId: null,
      },
      parsed.provision,
    )
  }
  return parsed
}

function assertRuntimeIdentity(
  event: {
    projectId: string
    projectEpoch: number
    sidecarGeneration: number
    runId: string | null
  },
  nested: {
    projectId?: string
    projectEpoch?: number
    sidecarGeneration?: number
    runId?: string
  },
): void {
  if (
    (nested.projectId !== undefined && nested.projectId !== event.projectId) ||
    (nested.projectEpoch !== undefined &&
      nested.projectEpoch !== event.projectEpoch) ||
    (nested.sidecarGeneration !== undefined &&
      nested.sidecarGeneration !== event.sidecarGeneration) ||
    (nested.runId !== undefined && nested.runId !== event.runId)
  ) {
    throw new TypeError('Keep nested runtime identity consistent.')
  }
}

/** Parse and project one sequence-bound runtime event. */
export function parseRuntimeEvent(value: unknown): RuntimeEvent {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid runtime event.')
  }
  const base = {
    projectId: identifier(value.projectId, 'runtime project ID'),
    projectEpoch: nonNegativeInteger(
      value.projectEpoch,
      'runtime project epoch',
    ),
    sidecarGeneration: nonNegativeInteger(
      value.sidecarGeneration,
      'runtime sidecar generation',
    ),
    sequence: nonNegativeInteger(value.sequence, 'runtime sequence'),
    runId: nullableIdentifier(value.runId, 'runtime run ID'),
    at: nonNegativeInteger(value.at, 'runtime event time'),
  }
  if (value.kind === 'job') {
    const job = parseRuntimeJob(value.job)
    assertRuntimeIdentity(base, job)
    return { ...base, kind: 'job', job }
  }
  if (value.kind === 'run') {
    const run = parseRunSnapshot(value.run)
    assertRuntimeIdentity(base, run)
    return { ...base, kind: 'run', run }
  }
  if (value.kind === 'log') {
    const log = parseRuntimeLogLine(value.log)
    assertRuntimeIdentity(base, log)
    return { ...base, kind: 'log', log }
  }
  if (value.kind === 'provision') {
    const provision = parseProvisionStatus(value.provision)
    assertRuntimeIdentity(base, provision)
    return { ...base, kind: 'provision', provision }
  }
  if (value.kind === 'summary') {
    return {
      ...base,
      kind: 'summary',
      summary: parseWorkflowSummary(value.summary),
    }
  }
  throw new TypeError('Provide a supported runtime event kind.')
}
