/**
 * Mounts the one app-level stage-currency read that the top bar, the
 * Dashboard, Subjects, and Runs share, so each trigger causes one inventory
 * read instead of one per screen.
 */

import { useMemo, type ReactNode } from 'react'
import { useApp } from './context'
import { useRuntime } from './runtime-state'
import {
  StageCurrencyContext,
  cohortConfigKey,
  useStageCurrency,
} from './stage-currency'

/**
 * Read the open project's stage currency once for every screen below.
 *
 * Mount it inside the app and runtime providers. The read waits until the
 * workflow service has answered for the open project's runtime, and then
 * follows the project's subjects and runs; {@link useProjectStageCurrency}
 * returns it, and it reads again when a save changes which subjects or T1
 * files the saved configuration selects. The sidecar answers one request at
 * a time, and the runtime bootstrap is already queued when the cohort
 * appears, so a read made then lands after the bootstrap anyway. A read made
 * before the bootstrap would
 * fail while the service starts, or be dropped when hydration begins, and
 * only delay the bootstrap. Until the read lands,
 * {@link StageCurrencyRead.checked} holds the counts it can change.
 */
export function StageCurrencyProvider({
  children,
}: {
  children: ReactNode
}): ReactNode {
  const { projectRef, subjects, savedCfg } = useApp()
  const runtime = useRuntime()
  const configKey = useMemo(() => cohortConfigKey(savedCfg), [savedCfg])
  const value = useStageCurrency({
    project: projectRef,
    subjects,
    runs: runtime.runs,
    configKey,
    // Read once the service has answered for the runtime, whether it
    // verified it or not; never while it starts or before its bootstrap.
    enabled:
      !runtime.hydrating &&
      runtime.authorityState !== 'pending' &&
      runtime.authorityState !== 'unavailable',
  })
  return <StageCurrencyContext value={value}>{children}</StageCurrencyContext>
}
