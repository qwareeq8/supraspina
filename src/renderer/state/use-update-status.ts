/**
 * Live in-app update state, shared by every surface that reflects it.
 *
 * The current {@link UpdateState} arrives through `update.getStatus()`, and
 * pushed transitions are tracked through `update.onStatus`. Returns null
 * until the first state resolves, and tolerates partial test mocks that omit
 * the `update` namespace.
 */

import { useEffect, useState } from 'react'
import { getApi } from './api'
import type { UpdateState } from '../../shared/contract'

/**
 * Subscribe to live update state, and return null until the first state resolves.
 *
 * @returns The latest update state, or null before initialization.
 */
export function useUpdateStatus(): UpdateState | null {
  const [status, setStatus] = useState<UpdateState | null>(null)
  useEffect(() => {
    let alive = true
    const api = getApi()
    void api.update?.getStatus?.()?.then((s) => {
      if (alive) setStatus(s)
    })
    const off = api.update?.onStatus?.((s) => {
      if (alive) setStatus(s)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [])
  return status
}
