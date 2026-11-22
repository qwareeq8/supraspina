import { describe, expect, it } from 'vitest'
import {
  BOUNDARY_EXPIRED_MESSAGE,
  BoundaryExpiredError,
  PLAN_STALE_MESSAGE,
  PlanStaleError,
  isBoundaryExpiredError,
  isPlanStaleError,
  parsePublicRpcError,
  serializePublicRpcError,
} from './rpc-errors'

describe('public RPC recovery errors', () => {
  it('round-trips the bounded PLAN_STALE action through Electron text', () => {
    const serialized = serializePublicRpcError(new PlanStaleError())
    const parsed = parsePublicRpcError(
      `Error invoking remote method: Error: ${serialized}`,
    )

    expect(parsed).toMatchObject({
      name: 'PlanStaleError',
      code: 'PLAN_STALE',
      action: { id: 'reviewAgain', label: 'Review again' },
    })
  })

  it('round-trips BOUNDARY_EXPIRED without leaking transport wording', () => {
    const serialized = serializePublicRpcError(new BoundaryExpiredError())
    const parsed = parsePublicRpcError(
      `Error invoking remote method 'supraspina:invoke': Error: ${serialized}`,
    )

    expect(parsed).toMatchObject({
      name: 'BoundaryExpiredError',
      code: 'BOUNDARY_EXPIRED',
      message: 'Retry the confirmation because it expired before an answer.',
    })
    expect(parsed).toBeInstanceOf(BoundaryExpiredError)
  })

  it('rejects malformed, unknown, and appended recovery payloads', () => {
    expect(parsePublicRpcError('token=private')).toBeNull()
    expect(
      parsePublicRpcError(
        'SUPRASPINA_RPC_ERROR:{"code":"BOUNDARY_EXPIRED","secret":"private"}',
      ),
    ).toBeNull()
    expect(
      parsePublicRpcError(
        'SUPRASPINA_RPC_ERROR:{"code":"PLAN_STALE","action":{"id":"openPath","label":"/private"}}',
      ),
    ).toBeNull()
    expect(
      parsePublicRpcError(
        'SUPRASPINA_RPC_ERROR:{"code":"PLAN_STALE","action":{"id":"reviewAgain","label":"Review again"},"secret":"private"}',
      ),
    ).toBeNull()
  })

  it('refuses an embedded, prefixed, or spoofed public-error marker', () => {
    const serialized = serializePublicRpcError(new BoundaryExpiredError())

    // Embedded inside an internal failure that echoes attacker-influenced text.
    expect(
      parsePublicRpcError(`ENOENT: no such file '/tmp/${serialized}'`),
    ).toBeNull()
    // Prefixed by unrelated wording rather than the fixed Electron wrapper.
    expect(
      parsePublicRpcError(`Scientific runtime failed: ${serialized}`),
    ).toBeNull()
    // Trailing content after the frame.
    expect(parsePublicRpcError(`${serialized} /private/path`)).toBeNull()
    // Multiline payload carrying private detail on another line.
    expect(parsePublicRpcError(`Internal failure\n${serialized}`)).toBeNull()
    expect(parsePublicRpcError(`${serialized}\n/private/path`)).toBeNull()
    // Nested cause repeating the marker.
    expect(
      parsePublicRpcError(
        `Error invoking remote method 'supraspina:invoke': Error: ${serialized} caused by ${serialized}`,
      ),
    ).toBeNull()
    // Oversized payload beyond the bounded frame.
    const oversized =
      'SUPRASPINA_RPC_ERROR:{"code":"BOUNDARY_EXPIRED","pad":"' +
      'x'.repeat(300) +
      '"}'
    expect(parsePublicRpcError(oversized)).toBeNull()
    // Non-object and non-JSON payloads.
    expect(
      parsePublicRpcError('SUPRASPINA_RPC_ERROR:"BOUNDARY_EXPIRED"'),
    ).toBeNull()
    expect(parsePublicRpcError('SUPRASPINA_RPC_ERROR:')).toBeNull()
    expect(parsePublicRpcError('SUPRASPINA_RPC_ERROR:{oops}')).toBeNull()

    // The exact frame and the exact wrapped frame still parse.
    expect(parsePublicRpcError(serialized)).toBeInstanceOf(BoundaryExpiredError)
    expect(
      parsePublicRpcError(
        `Error invoking remote method 'supraspina:invoke': Error: ${serialized}`,
      ),
    ).toBeInstanceOf(BoundaryExpiredError)
  })

  it('recognizes both recovery errors after the preload bridge flattens them', () => {
    // Rebuild the rejected error from its message and stack across context isolation
    // so the renderer never sees the class or code property.
    const bridged = (message: string): Error => {
      const error = new Error(message)
      error.name = 'Error'
      return error
    }

    expect(isBoundaryExpiredError(bridged(BOUNDARY_EXPIRED_MESSAGE))).toBe(true)
    expect(isPlanStaleError(bridged(PLAN_STALE_MESSAGE))).toBe(true)
    expect(isBoundaryExpiredError(new BoundaryExpiredError())).toBe(true)
    expect(isPlanStaleError(new PlanStaleError())).toBe(true)

    expect(isBoundaryExpiredError(bridged(PLAN_STALE_MESSAGE))).toBe(false)
    expect(isPlanStaleError(bridged(BOUNDARY_EXPIRED_MESSAGE))).toBe(false)
    expect(isBoundaryExpiredError(bridged('something else'))).toBe(false)
    expect(isBoundaryExpiredError(BOUNDARY_EXPIRED_MESSAGE)).toBe(false)
    expect(isPlanStaleError(null)).toBe(false)
  })

  it('refuses to serialize any non-allowlisted error', () => {
    expect(() => serializePublicRpcError(new Error('/private'))).toThrow(
      /allowlisted for public serialization/,
    )
  })
})
