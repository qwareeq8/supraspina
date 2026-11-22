const SHA256 = /^[a-f0-9]{64}$/
const SUBJECT_ID = /^sub-[A-Za-z0-9][A-Za-z0-9._-]{0,123}$/
const SESSION_ID = /^ses-[A-Za-z0-9][A-Za-z0-9._-]{0,123}$/
const ACQUISITION_ID = /^acq-[A-Za-z0-9][A-Za-z0-9._-]{0,123}$/
const ARTIFACT_ID = /^input-fov-qc:[a-f0-9]{64}$/
const QC_DISPLAY_PATH = /^supraspina-brainfov\/[A-Za-z0-9._/-]+$/
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_ITEMS = 5_000
const MAX_DISPLAY_PATH = 1_024
const MAX_ERROR = 512
const MAX_VERSION = 64
const MAX_RUNTIME_PATH = 4_096
/**
 * Accept only a bounded numeric release triple so a detected Apptainer version
 * can never carry captured subprocess output across the boundary.
 */
const RELEASE_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/

/** An input-FOV review restricted to an explicit approval or rejection. */
export type InputFovDecision = 'approved' | 'rejected'

/** One revision-bound input-FOV review decision. */
export interface InputFovReview {
  decision: InputFovDecision
  revision: number
  configRevision: number
  reviewedAt: string
  decisionSignature: string
  current: boolean
}

/** One validated input-FOV publication and review state. */
export interface InputFovItem {
  subjectId: string
  sessionId: string | null
  acquisitionId: string | null
  preflightSignature: string
  sourceSha256: string
  outputSha256: string
  passThrough: boolean
  requiresReview: boolean
  qcArtifactId: string
  qcDisplayPath: string
  review: InputFovReview | null
}

/** A bounded input-FOV inventory for one config revision. */
export interface InputFovListResult {
  configRevision: number
  items: InputFovItem[]
}

/** The identity and decision fields for an input-FOV review. */
export interface InputFovReviewFields {
  subjectId: string
  sessionId: string | null
  acquisitionId: string | null
  preflightSignature: string
  sourceSha256: string
  outputSha256: string
  expectedRevision: number
  decision: InputFovDecision
}

/** One supported managed scientific resource variant. */
export type ManagedResourceSelector =
  | { resource: 'synthstrip'; variant: 'cpu' }
  | { resource: 'fastsurfer'; variant: 'cpu' | 'cuda' }

/** The verified availability of a managed resource. */
export type ManagedResourceState =
  | 'missing'
  | 'ready'
  | 'invalid'
  | 'unavailable'

/** The current managed-resource operation phase. */
export type ManagedResourcePhase =
  | 'idle'
  | 'queued'
  | 'pulling'
  | 'importing'
  | 'verifying'
  | 'done'
  | 'error'
  | 'cancelled'

/** One bounded managed-resource lifecycle snapshot. */
export type ManagedResourceStatus = ManagedResourceSelector & {
  version: string
  state: ManagedResourceState
  phase: ManagedResourcePhase
  operationId: string | null
  percent: number | null
  cancellable: boolean
  error: string | null
}

/**
 * The Apptainer readiness backing an online managed-resource pull. `ready` is
 * true only when the resolved executable reports exactly `expectedVersion`,
 * because the reviewed release is an exact pin rather than a floor. `detail`
 * carries the operator-facing reason whenever the runtime is not ready.
 */
export interface ManagedResourceRuntime {
  found: boolean
  path: string | null
  version: string | null
  expectedVersion: string
  ready: boolean
  detail: string | null
}

/** One managed-resource status response with its host Apptainer readiness. */
export type ManagedResourceStatusResult = ManagedResourceStatus & {
  runtime: ManagedResourceRuntime
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`Remove unexpected fields from ${label}.`)
  }
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`Set ${label} to a non-negative safe integer.`)
  }
  return Number(value)
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`Set ${label} to a lowercase SHA-256.`)
  }
  return value
}

function subjectId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !SUBJECT_ID.test(value) ||
    value === '.' ||
    value === '..' ||
    value.includes('..')
  ) {
    throw new TypeError('Provide a valid input-FOV subject ID.')
  }
  return value
}

function acquisitionId(value: unknown): string | null {
  if (value === null) return null
  if (
    typeof value !== 'string' ||
    !ACQUISITION_ID.test(value) ||
    value.includes('..')
  ) {
    throw new TypeError('Provide a valid input-FOV acquisition ID.')
  }
  return value
}

function sessionId(value: unknown): string | null {
  if (value === null) return null
  if (
    typeof value !== 'string' ||
    !SESSION_ID.test(value) ||
    value.includes('..')
  ) {
    throw new TypeError('Provide a valid input-FOV session ID.')
  }
  return value
}

function decision(value: unknown): InputFovDecision {
  if (value !== 'approved' && value !== 'rejected') {
    throw new TypeError('Provide a valid input-FOV decision.')
  }
  return value
}

/**
 * Parse the identity fields carried by a revision-bound input-FOV review.
 *
 * @throws TypeError when the request violates the review contract.
 */
export function parseInputFovReviewRequest(
  value: unknown,
): InputFovReviewFields {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid input-FOV review request.')
  }
  exactKeys(
    value,
    [
      'subjectId',
      'sessionId',
      'acquisitionId',
      'preflightSignature',
      'sourceSha256',
      'outputSha256',
      'expectedRevision',
      'decision',
    ],
    'the input-FOV review request',
  )
  return {
    subjectId: subjectId(value.subjectId),
    sessionId: sessionId(value.sessionId),
    acquisitionId: acquisitionId(value.acquisitionId),
    preflightSignature: digest(
      value.preflightSignature,
      'the input-FOV preflight digest',
    ),
    sourceSha256: digest(value.sourceSha256, 'the input-FOV source SHA-256'),
    outputSha256: digest(value.outputSha256, 'the input-FOV output SHA-256'),
    expectedRevision: safeInteger(
      value.expectedRevision,
      'the input-FOV expected revision',
    ),
    decision: decision(value.decision),
  }
}

function parseInputFovReview(value: unknown): InputFovReview | null {
  if (value === null) return null
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid input-FOV review result.')
  }
  exactKeys(
    value,
    [
      'decision',
      'revision',
      'configRevision',
      'reviewedAt',
      'decisionSignature',
      'current',
    ],
    'the input-FOV review result',
  )
  if (
    typeof value.reviewedAt !== 'string' ||
    !ISO_MILLISECONDS.test(value.reviewedAt) ||
    Number.isNaN(Date.parse(value.reviewedAt))
  ) {
    throw new TypeError('Provide a valid input-FOV review timestamp.')
  }
  if (typeof value.current !== 'boolean') {
    throw new TypeError('Provide a valid input-FOV review currentness value.')
  }
  return {
    decision: decision(value.decision),
    revision: safeInteger(value.revision, 'the input-FOV review revision'),
    configRevision: safeInteger(
      value.configRevision,
      'the input-FOV review config revision',
    ),
    reviewedAt: value.reviewedAt,
    decisionSignature: digest(
      value.decisionSignature,
      'the input-FOV decision digest',
    ),
    current: value.current,
  }
}

/**
 * Parse the decision returned by `inputFov.review`.
 *
 * @throws TypeError when the result violates the review contract.
 */
export function parseInputFovReviewResult(value: unknown): InputFovReview {
  const review = parseInputFovReview(value)
  if (review === null) {
    throw new TypeError('Provide a valid input-FOV review result.')
  }
  return review
}

function parseInputFovItem(value: unknown): InputFovItem {
  if (!isRecord(value)) {
    throw new TypeError('Remove the invalid item from the input-FOV list.')
  }
  exactKeys(
    value,
    [
      'subjectId',
      'sessionId',
      'acquisitionId',
      'preflightSignature',
      'sourceSha256',
      'outputSha256',
      'passThrough',
      'requiresReview',
      'qcArtifactId',
      'qcDisplayPath',
      'review',
    ],
    'the input-FOV list item',
  )
  if (
    typeof value.passThrough !== 'boolean' ||
    typeof value.requiresReview !== 'boolean' ||
    value.requiresReview === value.passThrough
  ) {
    throw new TypeError('Keep the input-FOV crop policy result consistent.')
  }
  if (
    typeof value.qcArtifactId !== 'string' ||
    !ARTIFACT_ID.test(value.qcArtifactId)
  ) {
    throw new TypeError('Provide a valid input-FOV montage identity.')
  }
  if (
    typeof value.qcDisplayPath !== 'string' ||
    value.qcDisplayPath.length === 0 ||
    value.qcDisplayPath.length > MAX_DISPLAY_PATH ||
    !QC_DISPLAY_PATH.test(value.qcDisplayPath) ||
    value.qcDisplayPath
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError('Provide a valid input-FOV montage display path.')
  }
  return {
    subjectId: subjectId(value.subjectId),
    sessionId: sessionId(value.sessionId),
    acquisitionId: acquisitionId(value.acquisitionId),
    preflightSignature: digest(
      value.preflightSignature,
      'the input-FOV preflight digest',
    ),
    sourceSha256: digest(value.sourceSha256, 'the input-FOV source SHA-256'),
    outputSha256: digest(value.outputSha256, 'the input-FOV output SHA-256'),
    passThrough: value.passThrough,
    requiresReview: value.requiresReview,
    qcArtifactId: value.qcArtifactId,
    qcDisplayPath: value.qcDisplayPath,
    review: parseInputFovReview(value.review),
  }
}

/**
 * Parse the bounded response returned by `inputFov.list`.
 *
 * @throws TypeError when the result violates the list contract.
 */
export function parseInputFovListResult(value: unknown): InputFovListResult {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid input-FOV list result.')
  }
  exactKeys(value, ['configRevision', 'items'], 'the input-FOV list result')
  if (!Array.isArray(value.items) || value.items.length > MAX_ITEMS) {
    throw new TypeError('Keep the input-FOV list within its item limit.')
  }
  return {
    configRevision: safeInteger(
      value.configRevision,
      'the input-FOV list config revision',
    ),
    items: value.items.map(parseInputFovItem),
  }
}

/**
 * Parse a valid managed-resource and variant pair.
 *
 * @throws TypeError when the selector violates the resource contract.
 */
export function parseManagedResourceRequest(
  value: unknown,
): ManagedResourceSelector {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid managed-resource selector.')
  }
  exactKeys(value, ['resource', 'variant'], 'the managed-resource selector')
  if (value.resource === 'synthstrip' && value.variant === 'cpu') {
    return { resource: 'synthstrip', variant: 'cpu' }
  }
  if (
    value.resource === 'fastsurfer' &&
    (value.variant === 'cpu' || value.variant === 'cuda')
  ) {
    return { resource: 'fastsurfer', variant: value.variant }
  }
  throw new TypeError('Provide a valid managed-resource variant.')
}

/**
 * Parse a bounded managed-resource lifecycle snapshot.
 *
 * @throws TypeError when the status violates the lifecycle contract.
 */
export function parseManagedResourceStatus(
  value: unknown,
): ManagedResourceStatus {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid managed-resource status.')
  }
  exactKeys(
    value,
    [
      'resource',
      'variant',
      'version',
      'state',
      'phase',
      'operationId',
      'percent',
      'cancellable',
      'error',
    ],
    'the managed-resource status',
  )
  const selector = parseManagedResourceRequest({
    resource: value.resource,
    variant: value.variant,
  })
  const states: readonly ManagedResourceState[] = [
    'missing',
    'ready',
    'invalid',
    'unavailable',
  ]
  const phases: readonly ManagedResourcePhase[] = [
    'idle',
    'queued',
    'pulling',
    'importing',
    'verifying',
    'done',
    'error',
    'cancelled',
  ]
  if (
    typeof value.version !== 'string' ||
    value.version.length === 0 ||
    value.version.length > MAX_VERSION ||
    !states.includes(value.state as ManagedResourceState) ||
    !phases.includes(value.phase as ManagedResourcePhase) ||
    typeof value.cancellable !== 'boolean' ||
    (value.error !== null &&
      (typeof value.error !== 'string' || value.error.length > MAX_ERROR))
  ) {
    throw new TypeError('Provide a valid managed-resource status.')
  }
  const operationId =
    value.operationId === null
      ? null
      : typeof value.operationId === 'string' &&
          /^resource-[a-f0-9]{12}$/.test(value.operationId)
        ? value.operationId
        : undefined
  if (
    operationId === undefined ||
    (value.phase === 'idle' && operationId !== null) ||
    (value.phase !== 'idle' && operationId === null)
  ) {
    throw new TypeError('Provide a valid managed-resource operation identity.')
  }
  const percent =
    value.percent === null
      ? null
      : typeof value.percent === 'number' &&
          Number.isFinite(value.percent) &&
          value.percent >= 0 &&
          value.percent <= 100
        ? value.percent
        : undefined
  if (percent === undefined) {
    throw new TypeError(
      'Provide valid managed-resource progress from 0 through 100, or null.',
    )
  }
  if (
    value.cancellable !==
    (operationId !== null &&
      ['queued', 'pulling', 'importing', 'verifying'].includes(
        value.phase as string,
      ))
  ) {
    throw new TypeError('Provide a valid managed-resource cancellation state.')
  }
  return {
    ...selector,
    version: value.version,
    state: value.state as ManagedResourceState,
    phase: value.phase as ManagedResourcePhase,
    operationId,
    percent,
    cancellable: value.cancellable,
    error: value.error as string | null,
  }
}

/**
 * Parse a bounded Apptainer readiness report.
 *
 * @throws TypeError when the readiness violates the runtime contract.
 */
export function parseManagedResourceRuntime(
  value: unknown,
): ManagedResourceRuntime {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid managed-resource runtime.')
  }
  exactKeys(
    value,
    ['found', 'path', 'version', 'expectedVersion', 'ready', 'detail'],
    'the managed-resource runtime',
  )
  if (
    typeof value.found !== 'boolean' ||
    typeof value.ready !== 'boolean' ||
    typeof value.expectedVersion !== 'string' ||
    !RELEASE_RE.test(value.expectedVersion) ||
    (value.version !== null &&
      (typeof value.version !== 'string' || !RELEASE_RE.test(value.version)))
  ) {
    throw new TypeError('Provide a valid managed-resource runtime.')
  }
  if (value.found) {
    if (
      typeof value.path !== 'string' ||
      value.path.length === 0 ||
      value.path.length > MAX_RUNTIME_PATH ||
      value.path.includes('\0')
    ) {
      throw new TypeError('Provide the resolved managed-resource runtime path.')
    }
  } else if (value.path !== null || value.version !== null) {
    throw new TypeError('Provide a consistent managed-resource runtime.')
  }
  // A ready runtime is exactly one that was found at the reviewed release, so
  // the readiness flag can never contradict the evidence beside it.
  if (
    value.ready !== (value.found && value.version === value.expectedVersion)
  ) {
    throw new TypeError('Provide a consistent managed-resource runtime.')
  }
  if (
    value.ready
      ? value.detail !== null
      : typeof value.detail !== 'string' ||
        value.detail.length === 0 ||
        value.detail.length > MAX_ERROR
  ) {
    throw new TypeError('Provide a managed-resource runtime readiness reason.')
  }
  return {
    found: value.found,
    path: value.path as string | null,
    version: value.version as string | null,
    expectedVersion: value.expectedVersion,
    ready: value.ready,
    detail: value.detail as string | null,
  }
}

/**
 * Parse a managed-resource status response and its host Apptainer readiness.
 *
 * @throws TypeError when either half violates its contract.
 */
export function parseManagedResourceStatusResult(
  value: unknown,
): ManagedResourceStatusResult {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid managed-resource status.')
  }
  const { runtime, ...lifecycle } = value
  return {
    ...parseManagedResourceStatus(lifecycle),
    runtime: parseManagedResourceRuntime(runtime),
  }
}

/** Parse managed-resource progress with its project-generation identity. */
export function parseManagedResourceProgress(
  value: unknown,
): ManagedResourceStatus & { projectId: string; projectEpoch: number } {
  if (!isRecord(value)) {
    throw new TypeError('Provide valid managed-resource progress.')
  }
  exactKeys(
    value,
    [
      'resource',
      'variant',
      'version',
      'state',
      'phase',
      'operationId',
      'percent',
      'cancellable',
      'error',
      'projectId',
      'projectEpoch',
    ],
    'managed-resource progress',
  )
  if (
    typeof value.projectId !== 'string' ||
    value.projectId.length === 0 ||
    value.projectId.length > 256 ||
    value.projectId.includes('\0')
  ) {
    throw new TypeError('Provide a bounded managed-resource project ID.')
  }
  return {
    ...parseManagedResourceStatus({
      resource: value.resource,
      variant: value.variant,
      version: value.version,
      state: value.state,
      phase: value.phase,
      operationId: value.operationId,
      percent: value.percent,
      cancellable: value.cancellable,
      error: value.error,
    }),
    projectId: value.projectId,
    projectEpoch: safeInteger(
      value.projectEpoch,
      'the managed-resource project epoch',
    ),
  }
}
