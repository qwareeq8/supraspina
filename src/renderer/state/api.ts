/**
 * Resolves the real Electron bridge or installs the browser and test mock.
 * Import this accessor in screens instead of reading `window` directly.
 */

import type { SupraspinaApi } from '../../shared/contract'
import { installMockSupraspina } from '../ipc/mock'

/**
 * Get the active IPC API, and fall back to the mock when no bridge is present.
 */
export function getApi(): SupraspinaApi {
  return window.supraspina ?? installMockSupraspina()
}

/**
 * Detect whether the real Electron bridge is present.
 *
 * @returns True when the real Electron bridge is present.
 */
export function hasNativeBridge(): boolean {
  const api = window.supraspina as
    | (SupraspinaApi & { __mock?: true })
    | undefined
  return Boolean(api && !api.__mock)
}
