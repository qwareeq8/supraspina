/**
 * The advisory surface-registration check: its RPC result contracts and the
 * wording QC review shows for them.
 *
 * The sidecar resamples each reconstructed hemisphere's sulcal depth to
 * fsaverage through the subject's own `?h.sphere.reg` and correlates it with
 * fsaverage's, over the whole cortex and over a dorsal frontoparietal region
 * set. A hemisphere far below the cohort is flagged. The check never sets a
 * QC verdict and never blocks work.
 */

/** One hemisphere of a subject. */
export type RegistrationHemisphere = 'lh' | 'rh'

/** Where one hemisphere's check stands. */
export type RegistrationHemisphereState =
  | 'checked'
  | 'pending'
  | 'failed'
  | 'missing'

/** The measure that deviates most for one hemisphere. */
export type RegistrationMeasure = 'dfp' | 'cortex'

/** The check result of one hemisphere. */
export interface RegistrationHemisphereResult {
  hemisphere: RegistrationHemisphere
  state: RegistrationHemisphereState
  rCortex: number | null
  rDfp: number | null
  flagged: boolean
  measure: RegistrationMeasure | null
  z: number | null
  message: string | null
}

/** The check results of one subject, both hemispheres in order. */
export interface RegistrationSubjectResult {
  subjectId: string
  flagged: boolean
  hemispheres: RegistrationHemisphereResult[]
}

/** One measure's median and robust scale. */
export interface RegistrationMeasureReference {
  median: number
  scale: number
}

/**
 * The reference each hemisphere is compared with. The cohort is its own
 * reference only once every hemisphere is checked; until then, and while a
 * check runs, the reference of the last complete check holds, or the
 * calibration reference before the first one, so flags never come and go.
 */
export interface RegistrationReference {
  /** `cohort` for a complete set of at least 20 hemispheres, else the calibration. */
  source: 'cohort' | 'builtin'
  /** The complete set a cohort reference comes from; for the calibration, the hemispheres checked. */
  hemispheres: number
  cortex: RegistrationMeasureReference
  dfp: RegistrationMeasureReference
}

/** The project's running or last check. */
export interface RegistrationOperation {
  operationId: string
  state: 'running' | 'done' | 'cancelled' | 'failed'
  total: number
  completed: number
  failed: number
  startedAt: string
  finishedAt: string | null
  message: string | null
}

/** The counts QC review summarizes. */
export interface RegistrationCounts {
  subjects: number
  checked: number
  pending: number
  failed: number
  missing: number
  flaggedSubjects: number
  flaggedHemispheres: number
}

/** The result of `surfaceRegistration.status`. */
export interface SurfaceRegistrationStatus {
  configRevision: number
  method: string
  available: boolean
  unavailableReason: string | null
  rule: { zLimit: number; floor: number; minCohortHemispheres: number }
  reference: RegistrationReference
  operation: RegistrationOperation | null
  subjects: RegistrationSubjectResult[]
  counts: RegistrationCounts
}

/** The result of `surfaceRegistration.check`. */
export interface SurfaceRegistrationCheckResult {
  operation: RegistrationOperation
  started: boolean
}

/** The result of `surfaceRegistration.cancel`. */
export interface SurfaceRegistrationCancelResult {
  operationId: string
  stopped: boolean
}

const MAX_SUBJECTS = 5_000
const MAX_MESSAGE = 512
const MAX_METHOD = 128
const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** The operation IDs the sidecar issues. */
export const REGISTRATION_OPERATION_ID = /^srg-[a-f0-9]{16}$/
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const HEMISPHERES: readonly RegistrationHemisphere[] = ['lh', 'rh']
const STATES = new Set<string>(['checked', 'pending', 'failed', 'missing'])
const OPERATION_STATES = new Set<string>([
  'running',
  'done',
  'cancelled',
  'failed',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  ) {
    throw new TypeError(`Provide a valid ${label}.`)
  }
  return value
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Provide a valid ${label}.`)
  }
  return value as number
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Provide a valid ${label}.`)
  }
  return value
}

function correlation(value: unknown, label: string): number | null {
  if (value === null) return null
  const parsed = finite(value, label)
  if (parsed < -1 || parsed > 1)
    throw new TypeError(`Provide a valid ${label}.`)
  return parsed
}

function text(
  value: unknown,
  label: string,
  maximum = MAX_MESSAGE,
): string | null {
  if (value === null) return null
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new TypeError(`Provide a valid ${label}.`)
  }
  return value
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ISO_MILLISECONDS.test(value)) {
    throw new TypeError(`Provide a valid ${label}.`)
  }
  return value
}

function parseHemisphere(
  value: unknown,
  expected: RegistrationHemisphere,
): RegistrationHemisphereResult {
  const row = exactKeys(
    value,
    [
      'hemisphere',
      'state',
      'rCortex',
      'rDfp',
      'flagged',
      'measure',
      'z',
      'message',
    ],
    'registration hemisphere',
  )
  if (row.hemisphere !== expected || !STATES.has(String(row.state))) {
    throw new TypeError('Provide a valid registration hemisphere.')
  }
  const state = row.state as RegistrationHemisphereState
  const rCortex = correlation(row.rCortex, 'whole-cortex correlation')
  const rDfp = correlation(row.rDfp, 'frontoparietal correlation')
  if (typeof row.flagged !== 'boolean') {
    throw new TypeError('Provide a valid registration flag.')
  }
  if (
    row.measure !== null &&
    row.measure !== 'dfp' &&
    row.measure !== 'cortex'
  ) {
    throw new TypeError('Provide a valid registration measure.')
  }
  const z = row.z === null ? null : finite(row.z, 'registration z')
  const checked = state === 'checked'
  if (
    checked !== (rCortex !== null && rDfp !== null && z !== null) ||
    checked !== (row.measure !== null) ||
    (!checked && row.flagged)
  ) {
    throw new TypeError('Provide a consistent registration hemisphere.')
  }
  return {
    hemisphere: expected,
    state,
    rCortex,
    rDfp,
    flagged: row.flagged,
    measure: row.measure,
    z,
    message: text(row.message, 'registration message'),
  }
}

function parseSubject(value: unknown): RegistrationSubjectResult {
  const row = exactKeys(
    value,
    ['subjectId', 'flagged', 'hemispheres'],
    'registration subject',
  )
  if (typeof row.subjectId !== 'string' || !SUBJECT_ID.test(row.subjectId)) {
    throw new TypeError('Provide a valid registration subject ID.')
  }
  if (
    !Array.isArray(row.hemispheres) ||
    row.hemispheres.length !== HEMISPHERES.length
  ) {
    throw new TypeError('Provide both registration hemispheres.')
  }
  const hemispheres = HEMISPHERES.map((hemi, index) =>
    parseHemisphere((row.hemispheres as unknown[])[index], hemi),
  )
  if (row.flagged !== hemispheres.some((item) => item.flagged)) {
    throw new TypeError('Provide a consistent registration subject flag.')
  }
  return { subjectId: row.subjectId, flagged: row.flagged, hemispheres }
}

function parseMeasureReference(
  value: unknown,
  label: string,
): RegistrationMeasureReference {
  const row = exactKeys(value, ['median', 'scale'], label)
  const median = finite(row.median, label)
  const scale = finite(row.scale, label)
  if (median < -1 || median > 1 || scale <= 0) {
    throw new TypeError(`Provide a valid ${label}.`)
  }
  return { median, scale }
}

/**
 * Validate the operation a status, check, or cancel call returns.
 *
 * @throws TypeError when a field is missing, extra, or out of range.
 */
export function parseRegistrationOperation(
  value: unknown,
): RegistrationOperation {
  const row = exactKeys(
    value,
    [
      'operationId',
      'state',
      'total',
      'completed',
      'failed',
      'startedAt',
      'finishedAt',
      'message',
    ],
    'registration check operation',
  )
  if (
    typeof row.operationId !== 'string' ||
    !REGISTRATION_OPERATION_ID.test(row.operationId) ||
    !OPERATION_STATES.has(String(row.state))
  ) {
    throw new TypeError('Provide a valid registration check operation.')
  }
  const total = count(row.total, 'registration check total')
  const completed = count(row.completed, 'registration check progress')
  const failed = count(row.failed, 'registration check failures')
  if (completed > total || failed > completed) {
    throw new TypeError('Provide consistent registration check progress.')
  }
  return {
    operationId: row.operationId,
    state: row.state as RegistrationOperation['state'],
    total,
    completed,
    failed,
    startedAt: timestamp(row.startedAt, 'registration check start'),
    finishedAt:
      row.finishedAt === null
        ? null
        : timestamp(row.finishedAt, 'registration check end'),
    message: text(row.message, 'registration check message'),
  }
}

/**
 * Validate the result of `surfaceRegistration.status`.
 *
 * @throws TypeError when the result breaks the contract.
 */
export function parseSurfaceRegistrationStatus(
  value: unknown,
): SurfaceRegistrationStatus {
  const row = exactKeys(
    value,
    [
      'configRevision',
      'method',
      'available',
      'unavailableReason',
      'rule',
      'reference',
      'operation',
      'subjects',
      'counts',
    ],
    'surface registration status',
  )
  if (typeof row.available !== 'boolean') {
    throw new TypeError('Provide a valid registration availability.')
  }
  const method = text(row.method, 'registration method', MAX_METHOD)
  if (method === null) throw new TypeError('Provide a registration method.')
  const rule = exactKeys(
    row.rule,
    ['zLimit', 'floor', 'minCohortHemispheres'],
    'registration rule',
  )
  const reference = exactKeys(
    row.reference,
    ['source', 'hemispheres', 'cortex', 'dfp'],
    'registration reference',
  )
  if (reference.source !== 'cohort' && reference.source !== 'builtin') {
    throw new TypeError('Provide a valid registration reference source.')
  }
  if (!Array.isArray(row.subjects) || row.subjects.length > MAX_SUBJECTS) {
    throw new TypeError('Provide a bounded registration subject list.')
  }
  const subjects = row.subjects.map(parseSubject)
  if (
    new Set(subjects.map((item) => item.subjectId)).size !== subjects.length
  ) {
    throw new TypeError('Provide each registration subject once.')
  }
  const counts = exactKeys(
    row.counts,
    [
      'subjects',
      'checked',
      'pending',
      'failed',
      'missing',
      'flaggedSubjects',
      'flaggedHemispheres',
    ],
    'registration counts',
  )
  const parsedCounts: RegistrationCounts = {
    subjects: count(counts.subjects, 'registration subject count'),
    checked: count(counts.checked, 'registration checked count'),
    pending: count(counts.pending, 'registration pending count'),
    failed: count(counts.failed, 'registration failed count'),
    missing: count(counts.missing, 'registration missing count'),
    flaggedSubjects: count(counts.flaggedSubjects, 'registration flag count'),
    flaggedHemispheres: count(
      counts.flaggedHemispheres,
      'registration flag count',
    ),
  }
  if (
    parsedCounts.subjects !== subjects.length ||
    parsedCounts.flaggedSubjects !==
      subjects.filter((item) => item.flagged).length
  ) {
    throw new TypeError('Provide consistent registration counts.')
  }
  const available = row.available
  const unavailableReason = text(row.unavailableReason, 'registration reason')
  if (available === (unavailableReason !== null)) {
    throw new TypeError('Provide a consistent registration availability.')
  }
  return {
    configRevision: count(row.configRevision, 'config revision'),
    method,
    available,
    unavailableReason,
    rule: {
      zLimit: finite(rule.zLimit, 'registration z limit'),
      floor: finite(rule.floor, 'registration floor'),
      minCohortHemispheres: count(
        rule.minCohortHemispheres,
        'registration cohort minimum',
      ),
    },
    reference: {
      source: reference.source,
      hemispheres: count(reference.hemispheres, 'registration reference size'),
      cortex: parseMeasureReference(reference.cortex, 'cortex reference'),
      dfp: parseMeasureReference(reference.dfp, 'frontoparietal reference'),
    },
    operation:
      row.operation === null ? null : parseRegistrationOperation(row.operation),
    subjects,
    counts: parsedCounts,
  }
}

/**
 * Validate the result of `surfaceRegistration.check`.
 *
 * @returns The operation and whether this call started it.
 * @throws TypeError when the result breaks the contract.
 */
export function parseSurfaceRegistrationCheckResult(
  value: unknown,
): SurfaceRegistrationCheckResult {
  const row = exactKeys(
    value,
    ['operation', 'started'],
    'registration check result',
  )
  if (typeof row.started !== 'boolean') {
    throw new TypeError('Provide a valid registration check result.')
  }
  return {
    operation: parseRegistrationOperation(row.operation),
    started: row.started,
  }
}

/**
 * Validate the result of `surfaceRegistration.cancel`.
 *
 * @returns The operation ID and whether a running check stopped.
 * @throws TypeError when the result breaks the contract.
 */
export function parseSurfaceRegistrationCancelResult(
  value: unknown,
): SurfaceRegistrationCancelResult {
  const row = exactKeys(
    value,
    ['operationId', 'stopped'],
    'registration cancel result',
  )
  if (
    typeof row.operationId !== 'string' ||
    !REGISTRATION_OPERATION_ID.test(row.operationId) ||
    typeof row.stopped !== 'boolean'
  ) {
    throw new TypeError('Provide a valid registration cancel result.')
  }
  return { operationId: row.operationId, stopped: row.stopped }
}

// -- Wording --------------------------------------------------------------------

/** What the check does, for the QC review help tip. */
export const SURFACE_REGISTRATION_HELP =
  "An advisory check. Each hemisphere's sulcal depth, resampled to fsaverage through its surface registration (?h.sphere.reg), is correlated with fsaverage's over the whole cortex and over the dorsal frontoparietal regions. A hemisphere more than 3 robust standard deviations below the cohort median, or below 0.70, is flagged. Until every hemisphere is checked, the median of the last complete check or of a reference cohort stands in, and flags are provisional. The check never sets a verdict."

/** The sentence that marks flags stated before every hemisphere is checked. */
export const PROVISIONAL_FLAGS =
  'Flags are provisional until every hemisphere is checked.'

/**
 * Say whether the flags may still change: a check is running or some
 * hemisphere has no current result, so the cohort's own median is not yet
 * the reference.
 *
 * @returns True while the flags are provisional.
 */
export function registrationProvisional(
  status: SurfaceRegistrationStatus,
): boolean {
  return status.operation?.state === 'running' || status.counts.pending > 0
}

const SIDE: Record<RegistrationHemisphere, string> = {
  lh: 'Left hemisphere',
  rh: 'Right hemisphere',
}

const MEASURE_TEXT: Record<RegistrationMeasure, string> = {
  dfp: 'dorsal frontoparietal sulcal correlation',
  cortex: 'whole-cortex sulcal correlation',
}

/**
 * Word one hemisphere's advisory for the verdict rail.
 *
 * @returns The advisory, or null when the hemisphere needs none.
 */
export function hemisphereAdvisory(
  result: RegistrationHemisphereResult,
  reference: RegistrationReference,
  provisional = false,
): string | null {
  const side = SIDE[result.hemisphere]
  if (result.state === 'failed') {
    return `${side}: the surface registration check could not run. ${result.message ?? ''}`.trim()
  }
  if (result.state !== 'checked' || !result.flagged || !result.measure) {
    return null
  }
  const value = result.measure === 'dfp' ? result.rDfp : result.rCortex
  const median = reference[result.measure].median
  const center =
    reference.source === 'cohort' ? 'cohort median' : 'reference median'
  const advisory = `${side}: the surface registration fits the atlas poorly (${MEASURE_TEXT[result.measure]} ${(value ?? 0).toFixed(2)}; ${center} ${median.toFixed(2)}). The parcel labels may be shifted; check the External cortical gallery.`
  return provisional ? `${advisory} ${PROVISIONAL_FLAGS}` : advisory
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * Count a running check's progress over every hemisphere with reconstructed
 * surfaces. The operation's own counts cover only the hemispheres it set out
 * to check, so a check that continues after a stop would count from zero
 * against the rest; the kept results count as checked instead. A hemisphere
 * that could not be checked stays in the total, which then holds still while
 * the check runs.
 */
function checkProgress(counts: RegistrationCounts): {
  checked: number
  total: number
} {
  return {
    checked: counts.checked,
    total: counts.checked + counts.pending + counts.failed,
  }
}

/**
 * The sidecar's reasons the check cannot run, restated as the short cause the
 * queue header gives in parentheses. The rail keeps the full sentence.
 */
const UNAVAILABLE_CAUSE: Readonly<Record<string, string>> = {
  'The check needs FreeSurfer, and no FreeSurfer install root is set.':
    'FreeSurfer install root not set',
  'The check needs mri_surf2surf, which FreeSurfer did not provide.':
    'mri_surf2surf not found',
  'The check needs fsaverage, which the FreeSurfer install lacks.':
    'fsaverage not found',
  'The check needs the FreeSurfer license, and the license file was not found; choose it in Diagnostics.':
    'FreeSurfer license not found',
  'The check needs the FreeSurfer license, and the license file is empty or not readable; choose a readable one in Diagnostics.':
    'FreeSurfer license not readable',
}

/**
 * The openings of the sidecar's messages for a check that FreeSurfer stopped
 * as a whole, with the short cause the queue header gives for each. A probe
 * failure and a failed start carry a detail after the opening.
 */
const STOP_CAUSE: readonly (readonly [string, string])[] = [
  [
    'FreeSurfer did not accept its license file',
    'FreeSurfer did not accept its license',
  ],
  [
    'mri_surf2surf could not load its shared libraries',
    'mri_surf2surf could not load its libraries',
  ],
  [
    'mri_surf2surf also failed to resample fsaverage onto itself',
    'mri_surf2surf also failed on fsaverage',
  ],
  ['mri_surf2surf could not start', 'mri_surf2surf could not start'],
]

/**
 * Say why hemispheres stay unchecked when that is a problem: the check cannot
 * run, or the last check stopped by itself. Hemispheres waiting for the
 * automatic start, or left by a stop the operator chose, are not.
 */
function uncheckedCause(status: SurfaceRegistrationStatus): string | null {
  if (status.counts.pending === 0) return null
  if (!status.available) {
    return (
      UNAVAILABLE_CAUSE[status.unavailableReason ?? ''] ??
      'the check cannot run'
    )
  }
  if (status.operation?.state !== 'failed') return null
  const message = status.operation.message ?? ''
  const cause = STOP_CAUSE.find(([opening]) => message.startsWith(opening))
  return cause
    ? `the last check stopped: ${cause[1]}`
    : 'the last check stopped'
}

/**
 * Word the one-line state of the check for the queue header, which stays in
 * view when the verdict rail's Surface registration section is below its
 * fold.
 *
 * @returns The line while a check runs, while hemispheres stay unchecked
 *   because the check cannot run or stopped by itself, or while subjects are
 *   flagged; else null.
 */
export function registrationQueueLine(
  status: SurfaceRegistrationStatus,
  flaggedInQueue: number,
): string | null {
  const { operation } = status
  const flagged = plural(flaggedInQueue, 'subject', 'subjects')
  if (operation?.state === 'running') {
    const { checked, total } = checkProgress(status.counts)
    const progress = `Surface registration: ${checked} of ${total} checked`
    return flaggedInQueue > 0 ? `${progress}, ${flagged} flagged` : progress
  }
  const cause = uncheckedCause(status)
  if (cause !== null) {
    const { checked, total } = checkProgress(status.counts)
    const progress =
      checked === 0 ? 'not checked' : `${checked} of ${total} checked`
    const line = `Surface registration: ${progress} (${cause})`
    return flaggedInQueue > 0 ? `${line}, ${flagged} flagged` : line
  }
  if (flaggedInQueue === 0) return null
  return `Surface registration: ${flagged} flagged${registrationProvisional(status) ? ' (provisional)' : ''}`
}

/**
 * Word the cohort summary of the check for the verdict rail.
 *
 * @returns One to three short sentences, each a fact.
 */
export function registrationSummary(status: SurfaceRegistrationStatus): string {
  const { counts, operation } = status
  if (operation?.state === 'running') {
    const { checked, total } = checkProgress(counts)
    const progress = `${checked} of ${plural(total, 'hemisphere', 'hemispheres')} checked.`
    return counts.flaggedSubjects > 0
      ? `${progress} ${plural(counts.flaggedSubjects, 'subject is', 'subjects are')} flagged so far. ${PROVISIONAL_FLAGS}`
      : progress
  }
  if (counts.subjects === 0) {
    return status.available
      ? 'No subject has reconstructed surfaces yet.'
      : (status.unavailableReason ?? 'The check needs FreeSurfer.')
  }
  const parts: string[] = []
  if (counts.flaggedSubjects > 0) {
    parts.push(
      `${plural(counts.flaggedSubjects, 'subject fits', 'subjects fit')} the atlas poorly.`,
    )
  } else if (counts.checked > 0) {
    parts.push(
      `No checked hemisphere is flagged (${plural(counts.checked, 'hemisphere', 'hemispheres')} checked).`,
    )
  }
  if (counts.pending > 0) {
    parts.push(
      `${plural(counts.pending, 'hemisphere is', 'hemispheres are')} not checked.`,
    )
    if (counts.flaggedSubjects > 0) parts.push(PROVISIONAL_FLAGS)
  }
  if (counts.failed > 0) {
    parts.push(
      `${plural(counts.failed, 'hemisphere', 'hemispheres')} could not be checked.`,
    )
  }
  if (!status.available && status.unavailableReason) {
    parts.push(status.unavailableReason)
  }
  if (operation?.state === 'failed' && operation.message) {
    parts.push(`The last check stopped: ${operation.message}`)
  }
  return parts.join(' ')
}
