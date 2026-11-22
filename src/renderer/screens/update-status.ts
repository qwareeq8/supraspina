/** Holds the update status wording and the manual check action of Updates. */

import { useCallback, useState } from 'react'
import { getApi } from '../state/api'
import type { UpdateState } from '../../shared/contract'
import { formatAppVersion } from '../../../scripts/app-version.mjs'

function versionName(status: UpdateState): string {
  return status.version
    ? `Version ${formatAppVersion(status.version)}`
    : 'A newer version'
}

/** Summarize the current update phase in one plain-language line. */
export function updateStatusLine(status: UpdateState): string {
  switch (status.phase) {
    case 'checking':
      return 'Checking for updates...'
    case 'available':
      return status.capability === 'full'
        ? `${versionName(status)} is available.`
        : `${versionName(status)} is available on its release page.`
    case 'downloading':
      return status.percent == null
        ? 'Downloading the update...'
        : `Downloading the update: ${Math.round(status.percent)}%.`
    case 'downloaded':
      return `${versionName(status)} installs when you quit.`
    case 'error':
      // The main process sends only a remedy sentence, so name no single step.
      return status.error
        ? `The update failed. ${status.error}`
        : 'The update failed without an error detail.'
    case 'not-available':
      return 'Supraspina is up to date.'
    case 'idle':
      return 'No update check has run yet.'
  }
}

/**
 * Say whether a phase offers the operator something to act on.
 *
 * @returns True while a newer version is offered, downloading, or ready.
 */
export function updateIsPending(status: UpdateState | null): boolean {
  return (
    status != null &&
    (status.phase === 'available' ||
      status.phase === 'downloading' ||
      status.phase === 'downloaded')
  )
}

/**
 * Run a manual update check, tracking whether one is in flight.
 *
 * The main process publishes a failed check as the error phase, so the
 * returned action does not reject.
 */
export function useUpdateCheck(): { checking: boolean; check: () => void } {
  const [checking, setChecking] = useState(false)
  const check = useCallback((): void => {
    setChecking(true)
    void Promise.resolve()
      .then(() => getApi().update.check())
      .catch(() => undefined)
      .finally(() => setChecking(false))
  }, [])
  return { checking, check }
}
