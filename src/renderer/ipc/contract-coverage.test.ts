/**
 * Classifies every `SupraspinaApi` method in the renderer contract.
 * `createMockApi()` is the typed runtime witness. The surface is partitioned
 * into native, sidecar, and event methods through `ipc-surface.json`, and the
 * companion tests bind the same map to each implementation.
 */

import { describe, expect, it } from 'vitest'
import surface from '../../shared/ipc-surface.json'
import { createMockApi } from './mock'

/** Collect every function-valued `domain.method` on the mock API. */
function contractSurface(): string[] {
  const api = createMockApi() as unknown as Record<
    string,
    Record<string, unknown>
  >
  const out: string[] = []
  for (const [domain, methods] of Object.entries(api)) {
    for (const [name, value] of Object.entries(methods)) {
      if (typeof value === 'function') out.push(`${domain}.${name}`)
    }
  }
  return out.sort()
}

describe('IPC contract coverage', () => {
  const native = surface.native as string[]
  const sidecar = surface.sidecar as string[]
  const event = surface.event as string[]

  it('classifies every SupraspinaApi method exactly once', () => {
    const actual = contractSurface()
    const declared = [...native, ...sidecar, ...event].sort()

    // Require an exact partition without missing or stale methods.
    expect(declared).toEqual(actual)
  })

  it('keeps the three partitions disjoint', () => {
    const all = [...native, ...sidecar, ...event]
    expect(new Set(all).size).toBe(all.length)
  })

  it('classifies exactly the on* subscriptions as events', () => {
    const onStar = contractSurface()
      .filter((method) => method.split('.')[1]?.startsWith('on'))
      .sort()
    expect([...event].sort()).toEqual(onStar)
  })
})
