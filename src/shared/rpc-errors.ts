const PUBLIC_RPC_ERROR_PREFIX = 'SUPRASPINA_RPC_ERROR:'
const MAX_PUBLIC_RPC_ERROR_CHARS = 256
/**
 * Accept only the exact framed representation this module serializes, either
 * on its own or behind Electron's fixed `ipcRenderer.invoke` rejection wrapper.
 *
 * The frame must occupy the whole remainder of a single-line message. An
 * internal failure that quotes or echoes the marker (inside a path, a nested
 * cause, or an attacker-influenced string) stays internal and is redacted like
 * every other unexpected error.
 */
const PUBLIC_RPC_ERROR_FRAME = new RegExp(
  `^(?:Error invoking remote method(?: '[^'\\n]{0,128}')?: Error: )?` +
    `${PUBLIC_RPC_ERROR_PREFIX}(\\{[^\\n]{1,${MAX_PUBLIC_RPC_ERROR_CHARS}}\\})$`,
)

/** The fixed recovery action for a stale plan. */
export interface ReviewAgainAction {
  id: 'reviewAgain'
  label: 'Review again'
}

/** The fixed recovery action for a stale plan. */
export const REVIEW_AGAIN_ACTION: ReviewAgainAction = {
  id: 'reviewAgain',
  label: 'Review again',
}

/** The stable public message for stale workflow plans. */
export const PLAN_STALE_MESSAGE =
  'Review the workflow plan again because the approved plan changed.'
/** The stable public message for expired lifecycle boundaries. */
export const BOUNDARY_EXPIRED_MESSAGE =
  'Retry the confirmation because it expired before an answer.'

/**
 * A report that the approved execution plan no longer matches current safety inputs.
 */
export class PlanStaleError extends Error {
  readonly code = 'PLAN_STALE'
  readonly action: ReviewAgainAction = REVIEW_AGAIN_ACTION

  constructor() {
    super(PLAN_STALE_MESSAGE)
    this.name = 'PlanStaleError'
  }
}

/**
 * A report that the lifecycle confirmation no longer awaits this answer. Treat
 * a timed-out, superseded, or answered confirmation as inapplicable, and
 * preserve all open, loaded, updated, and retained state.
 */
export class BoundaryExpiredError extends Error {
  readonly code = 'BOUNDARY_EXPIRED'

  constructor() {
    super(BOUNDARY_EXPIRED_MESSAGE)
    this.name = 'BoundaryExpiredError'
  }
}

/** Public RPC failures restricted to reviewed recovery errors. */
export type PublicRpcError = PlanStaleError | BoundaryExpiredError

/**
 * Recognize one allowlisted recovery error on either side of the preload
 * bridge.
 *
 * Do not use `instanceof` in the renderer. Account for context isolation
 * rebuilding every rejected error from its message and stack, which removes
 * the prototype and `code` property. Account also for main, preload, and
 * renderer bundling separate copies of these classes. Compare the canonical
 * message that crosses intact against the shared constants above.
 */
function isPublicRpcErrorOf(
  value: unknown,
  code: string,
  message: string,
): boolean {
  if (!(value instanceof Error)) return false
  return (
    (value as { code?: unknown }).code === code || value.message === message
  )
}

/** Identify the PLAN_STALE recovery error. */
export function isPlanStaleError(value: unknown): boolean {
  return isPublicRpcErrorOf(value, 'PLAN_STALE', PLAN_STALE_MESSAGE)
}

/** Identify the BOUNDARY_EXPIRED recovery error. */
export function isBoundaryExpiredError(value: unknown): boolean {
  return isPublicRpcErrorOf(value, 'BOUNDARY_EXPIRED', BOUNDARY_EXPIRED_MESSAGE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

/**
 * Serialize one allowlisted recovery error for the context bridge.
 *
 * @throws Error when the error is not allowlisted.
 */
export function serializePublicRpcError(error: unknown): string {
  if (error instanceof PlanStaleError) {
    return (
      PUBLIC_RPC_ERROR_PREFIX +
      JSON.stringify({
        code: error.code,
        action: error.action,
      })
    )
  }
  if (error instanceof BoundaryExpiredError) {
    return PUBLIC_RPC_ERROR_PREFIX + JSON.stringify({ code: error.code })
  }
  throw new Error('Use an RPC error allowlisted for public serialization.')
}

/**
 * Parse one allowlisted payload from an Electron rejection message.
 *
 * @returns The recovered public error, or null when invalid.
 */
export function parsePublicRpcError(message: unknown): PublicRpcError | null {
  if (typeof message !== 'string' || message.length > 4_096) return null
  const framed = PUBLIC_RPC_ERROR_FRAME.exec(message)
  if (framed === null) return null
  const payload = framed[1] ?? ''
  // Reject a second marker anywhere in the message, so no crafted payload can
  // ride along behind the anchored frame.
  if (
    payload.length === 0 ||
    message.indexOf(PUBLIC_RPC_ERROR_PREFIX) !==
      message.lastIndexOf(PUBLIC_RPC_ERROR_PREFIX)
  ) {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if (value.code === 'BOUNDARY_EXPIRED') {
    return hasExactKeys(value, ['code']) ? new BoundaryExpiredError() : null
  }
  if (
    !hasExactKeys(value, ['code', 'action']) ||
    value.code !== 'PLAN_STALE' ||
    !isRecord(value.action) ||
    !hasExactKeys(value.action, ['id', 'label']) ||
    value.action.id !== 'reviewAgain' ||
    value.action.label !== 'Review again'
  ) {
    return null
  }
  return new PlanStaleError()
}
