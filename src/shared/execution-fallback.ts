/**
 * The record of a Reconstruction that recon-all reran with added flags after
 * a known FreeSurfer failure. The sidecar keeps it on the job
 * (`executionFallback`) and in the receipt record, outside the signed
 * payload; sidecar/supraspina_sidecar/run_store.py `execution_fallback_valid`
 * defines the same exact shape.
 */

/** One rerun of a composed record, in the order the reruns ran. */
export interface ExecutionFallbackRerun {
  kind: string
  /** The one flag this rerun added, such as `-no-fix-ga`. */
  addedArguments: string[]
  reason: string
  /** The exit code of the attempt that showed this failure. */
  attemptExitCode: number
}

/**
 * The reruns of one Reconstruction. A single rerun has the four summary
 * fields; composed reruns add `reruns`, which the summary fields restate: the
 * joined kinds, every added flag, the reasons in order, and the first
 * attempt's exit code.
 */
export interface ExecutionFallback {
  kind: string
  addedArguments: string[]
  reason: string
  firstAttemptExitCode: number
  reruns?: ExecutionFallbackRerun[]
}

const MAX_KIND_LENGTH = 256
const MAX_REASON_LENGTH = 8_192
const MAX_RERUNS = 16
const FLAG = /^-[a-z0-9][a-z0-9-]{0,62}$/
const SUMMARY_KEYS = [
  'kind',
  'addedArguments',
  'reason',
  'firstAttemptExitCode',
] as const
const RERUN_KEYS = [
  'kind',
  'addedArguments',
  'reason',
  'attemptExitCode',
] as const

function invalid(label: string): TypeError {
  return new TypeError(`Provide a valid ${label}.`)
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => own.includes(key))
}

function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) {
    throw invalid(label)
  }
  return value
}

function exitCode(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid(label)
  }
  return value
}

function flags(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_RERUNS ||
    !value.every((flag) => typeof flag === 'string' && FLAG.test(flag))
  ) {
    throw invalid(label)
  }
  return [...(value as string[])]
}

function parseRerun(value: unknown, label: string): ExecutionFallbackRerun {
  if (!hasExactKeys(value, RERUN_KEYS)) throw invalid(label)
  const added = flags(value.addedArguments, label)
  if (added.length !== 1) throw invalid(label)
  return {
    kind: text(value.kind, MAX_KIND_LENGTH, label),
    addedArguments: added,
    reason: text(value.reason, MAX_REASON_LENGTH, label),
    attemptExitCode: exitCode(value.attemptExitCode, label),
  }
}

/**
 * Parse one untrusted execution-fallback record, keeping its exact shape.
 *
 * @param value - The record from a job or a receipt projection.
 * @param label - What the record belongs to, for the error message.
 * @returns The record, copied.
 * @throws TypeError when a field is missing, extra, unbounded, or a composed
 *   record's summary does not restate its reruns.
 */
export function parseExecutionFallback(
  value: unknown,
  label = 'execution fallback',
): ExecutionFallback {
  const composed = hasExactKeys(value, [...SUMMARY_KEYS, 'reruns'])
  if (!composed && !hasExactKeys(value, SUMMARY_KEYS)) throw invalid(label)
  const record = value as Record<string, unknown>
  const parsed: ExecutionFallback = {
    kind: text(record.kind, MAX_KIND_LENGTH, label),
    addedArguments: flags(record.addedArguments, label),
    reason: text(record.reason, MAX_REASON_LENGTH * MAX_RERUNS, label),
    firstAttemptExitCode: exitCode(record.firstAttemptExitCode, label),
  }
  if (!composed) {
    if (parsed.reason.length > MAX_REASON_LENGTH) throw invalid(label)
    return parsed
  }
  const reruns = record.reruns
  // A single rerun keeps the four-field shape.
  if (
    !Array.isArray(reruns) ||
    reruns.length < 2 ||
    reruns.length > MAX_RERUNS
  ) {
    throw invalid(label)
  }
  const entries = reruns.map((entry) => parseRerun(entry, label))
  const added = entries.map((entry) => entry.addedArguments[0] ?? '')
  if (
    new Set(added).size !== added.length ||
    added.join('\n') !== parsed.addedArguments.join('\n') ||
    parsed.kind !== entries.map((entry) => entry.kind).join('+') ||
    parsed.reason !== entries.map((entry) => entry.reason).join(' ') ||
    parsed.firstAttemptExitCode !== entries[0]?.attemptExitCode
  ) {
    throw invalid(label)
  }
  parsed.reruns = entries
  return parsed
}

/**
 * State which flags a Reconstruction reran with, as a fact.
 *
 * @example
 * executionFallbackFact({ addedArguments: ['-no-fix-ga'], ... })
 * // 'Reran with -no-fix-ga'
 */
export function executionFallbackFact(
  fallback: Pick<ExecutionFallback, 'addedArguments'>,
): string {
  const added = fallback.addedArguments
  const listed =
    added.length <= 1
      ? added.join('')
      : `${added.slice(0, -1).join(', ')} and ${added[added.length - 1]}`
  return `Reran with ${listed}`
}

/**
 * State why a Reconstruction reran and how its first attempt ended, as
 * sentences.
 */
export function executionFallbackDetail(fallback: ExecutionFallback): string {
  const reason = /[.!?]$/.test(fallback.reason)
    ? fallback.reason
    : `${fallback.reason}.`
  return `${reason} The first attempt exited with code ${fallback.firstAttemptExitCode}.`
}
