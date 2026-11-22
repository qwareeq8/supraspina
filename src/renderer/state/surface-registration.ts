/**
 * Follows the advisory surface-registration check for QC review.
 *
 * The hook reads the check's status when QC review opens and starts a check
 * once when reconstructed hemispheres have no current result. The check runs
 * in the sidecar's background; the hook reads its progress while it runs and
 * leaves it running when QC review closes. A project change stops it in the
 * sidecar. After FreeSurfer stops a check as a whole, QC review starts no
 * other on its own until the saved FreeSurfer settings change.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getApi } from './api'
import { useApp } from './context'
import type { ProjectConfig } from '../../shared/project-schema'
import type { ProjectRef } from '../../shared/types'
import type {
  RegistrationOperation,
  SurfaceRegistrationCheckResult,
  SurfaceRegistrationStatus,
} from '../../shared/surface-registration'

/** How often a running check's progress is read. */
export const REGISTRATION_POLL_MS = 1_500

/**
 * Name the saved settings that decide which FreeSurfer and which license a
 * check runs with: the install root and the license path. The sidecar reads
 * the saved configuration, so an unsaved edit changes nothing it would do.
 */
function registrationSetupKey(cfg: ProjectConfig): string {
  return JSON.stringify([cfg.tools.freesurferHome, cfg.tools.freesurferLicense])
}

/** The number of operations whose settings the app remembers. */
const REMEMBERED_OPERATIONS = 8

/**
 * The saved FreeSurfer settings each check started under, by operation ID,
 * oldest first. It outlives a QC review visit, so a check that FreeSurfer
 * stopped is not started again on every visit; it ends with the app.
 */
const setupByOperation = new Map<string, string>()

function rememberSetup(operationId: string, setup: string): void {
  setupByOperation.delete(operationId)
  setupByOperation.set(operationId, setup)
  while (setupByOperation.size > REMEMBERED_OPERATIONS) {
    const oldest = setupByOperation.keys().next().value
    if (oldest === undefined) break
    setupByOperation.delete(oldest)
  }
}

/**
 * Remember the settings a check call ran under. A call that found a check
 * already running keeps what that check started under.
 */
function recordCheck(
  result: SurfaceRegistrationCheckResult,
  setup: string,
): void {
  const { operationId } = result.operation
  if (result.started || !setupByOperation.has(operationId)) {
    rememberSetup(operationId, setup)
  }
}

/**
 * Say whether the last check stopped as a whole, a rejected license or a
 * FreeSurfer that cannot start, under the current saved settings: another
 * check would stop the same way. A failed check that QC review did not start
 * counts as one started under the current settings.
 */
function setupFailureStands(
  operation: RegistrationOperation | null,
  setup: string,
): boolean {
  if (operation?.state !== 'failed') return false
  const startedUnder = setupByOperation.get(operation.operationId)
  if (startedUnder === undefined) {
    rememberSetup(operation.operationId, setup)
    return true
  }
  return startedUnder === setup
}

/** The check's state and the two actions QC review offers. */
export interface SurfaceRegistrationState {
  status: SurfaceRegistrationStatus | null
  error: string | null
  /** A start or stop request is in flight. */
  busy: boolean
  /** Check every hemisphere without a current result, and failed ones again. */
  check: () => void
  /** Stop the running check; finished hemispheres keep their results. */
  stop: () => void
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

/**
 * Read, start, and follow the project's surface-registration check.
 *
 * @param projectRef - The open project, or null for none.
 * @param reloadKey - A value that changes when the screen reloads.
 */
export function useSurfaceRegistration(
  projectRef: ProjectRef | null,
  reloadKey = 0,
): SurfaceRegistrationState {
  const [status, setStatus] = useState<SurfaceRegistrationStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [readKey, setReadKey] = useState(0)
  const setup = registrationSetupKey(useApp().savedCfg)
  const autoStarted = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!projectRef) return
    let current = true
    const api = getApi().surfaceRegistration
    void api.status({ project: projectRef }).then(
      async (next) => {
        if (!current) return
        setStatus(next)
        setError(null)
        if (
          autoStarted.current ||
          !next.available ||
          next.counts.pending === 0 ||
          next.operation?.state === 'running' ||
          setupFailureStands(next.operation, setup)
        ) {
          return
        }
        // Start once per visit; a stopped check waits for the explicit action.
        autoStarted.current = true
        try {
          recordCheck(await api.check({ project: projectRef }), setup)
          if (current) setReadKey((key) => key + 1)
        } catch (cause: unknown) {
          if (current) {
            setError(messageOf(cause, 'Retry the surface registration check.'))
          }
        }
      },
      (cause: unknown) => {
        if (current) {
          setError(
            messageOf(cause, 'Retry reading the surface registration check.'),
          )
        }
      },
    )
    return () => {
      current = false
    }
  }, [projectRef, reloadKey, readKey, setup])

  const running = status?.operation?.state === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setTimeout(
      () => setReadKey((key) => key + 1),
      REGISTRATION_POLL_MS,
    )
    return () => clearTimeout(timer)
  }, [running, status])

  const check = useCallback(() => {
    if (!projectRef) return
    setBusy(true)
    void getApi()
      .surfaceRegistration.check({ project: projectRef, retryFailed: true })
      .then(
        (result) => {
          recordCheck(result, setup)
          if (!mounted.current) return
          setError(null)
          setReadKey((key) => key + 1)
        },
        (cause: unknown) => {
          if (mounted.current) {
            setError(messageOf(cause, 'Retry the surface registration check.'))
          }
        },
      )
      .finally(() => {
        if (mounted.current) setBusy(false)
      })
  }, [projectRef, setup])

  const operation = status?.operation ?? null
  const stop = useCallback(() => {
    if (!projectRef || operation?.state !== 'running') return
    setBusy(true)
    void getApi()
      .surfaceRegistration.cancel({
        project: projectRef,
        operationId: operation.operationId,
      })
      .then(
        () => {
          if (mounted.current) setReadKey((key) => key + 1)
        },
        (cause: unknown) => {
          if (mounted.current) {
            setError(messageOf(cause, 'Retry stopping the check.'))
          }
        },
      )
      .finally(() => {
        if (mounted.current) setBusy(false)
      })
  }, [projectRef, operation])

  return { status, error, busy, check, stop }
}
