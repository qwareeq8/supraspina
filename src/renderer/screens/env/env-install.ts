/** Shares the authorized opt-in install flow across Diagnostics and Setup. */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useApp } from '../../state/context'
import { getApi } from '../../state/api'
import type { EnvInstallState } from '../../../shared/contract'
import type { ProjectConfig } from '../../../shared/project-schema'
import type { EnvCheck, ProjectRef } from '../../../shared/types'

/** Whether one installation has settled. */
export function isInstallSettled(state: EnvInstallState): boolean {
  return state.phase === 'done' || state.phase === 'error'
}

/** What a screen supplies to host the shared install flow. */
export interface UseEnvInstallOptions {
  safeExecution: boolean
  /** Supply the configuration and revision each install request carries. */
  request: { cfg: ProjectConfig; configRevision: number }
  /** Refuse to start while the hosting screen's own gate is closed. */
  blocked?: boolean
  /** Run after an installation succeeds, normally to reprobe the environment. */
  onInstalled?: (() => void) | undefined
}

/** The install state and action the hook returns. */
export interface EnvInstall {
  /** The latest installation per check id, running or settled. */
  states: Record<string, EnvInstallState>
  /** The check id of the unsettled installation, or null when none runs. */
  running: string | null
  /** Authorize and start one check's installer. */
  start: (check: EnvCheck) => void
}

/**
 * Host the authorized opt-in install flow for one screen.
 *
 * The sidecar owns the installation: `start` authorizes it, receives an
 * operation identity, and then follows `env.onInstallProgress` until the
 * installation settles. A screen that remounts while an installation runs
 * reattaches to it through `env.installStatus`, and a settled installation
 * stays inspectable with its exit code and captured output.
 */
export function useEnvInstall(options: UseEnvInstallOptions): EnvInstall {
  const { projectRef } = useApp()
  const [states, setStates] = useState<Record<string, EnvInstallState>>({})
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  })

  const identityRef = useRef<ProjectRef | null>(null)
  useLayoutEffect(() => {
    identityRef.current = projectRef
    return () => {
      identityRef.current = null
    }
  }, [projectRef])

  const owns = useCallback((captured: ProjectRef): boolean => {
    const latest = identityRef.current
    return (
      latest?.projectId === captured.projectId &&
      latest.epoch === captured.epoch
    )
  }, [])

  const record = useCallback((state: EnvInstallState): void => {
    setStates((prev) => ({ ...prev, [state.checkId]: state }))
  }, [])

  // Follow every installation of the open project, and reattach to one that is
  // still running after this screen remounts.
  useEffect(() => {
    if (!projectRef) return undefined
    const captured = projectRef
    const off = getApi().env.onInstallProgress((ev) => {
      if (
        !owns(captured) ||
        ev.projectId !== captured.projectId ||
        ev.projectEpoch !== captured.epoch
      ) {
        return
      }
      record(ev)
      if (ev.phase === 'done') optionsRef.current.onInstalled?.()
    })
    void getApi()
      .env.installStatus({ project: captured })
      .then(({ operations }) => {
        if (!owns(captured)) return
        // Adopt only unsettled work: a settled installation belongs to the
        // screen that started it, not to this fresh mount.
        for (const operation of operations) {
          if (!isInstallSettled(operation)) record(operation)
        }
      })
      .catch(() => {
        // Leave the screen idle when the sidecar cannot report prior work.
      })
    return off
  }, [owns, projectRef, record])

  const start = useCallback(
    (check: EnvCheck): void => {
      const { safeExecution, blocked, request } = optionsRef.current
      if (!safeExecution || blocked || !projectRef) return
      const captured = projectRef
      const startedAt = Date.now()
      // Show the operation before the authorization round trip answers. The
      // identity stays empty until the sidecar names the started operation.
      record({
        operationId: '',
        checkId: check.id,
        projectId: captured.projectId,
        projectEpoch: captured.epoch,
        phase: 'queued',
        startedAt,
        updatedAt: startedAt,
        output: '',
        rc: null,
        stdout: '',
        stderr: '',
      })
      const api = getApi()
      void api.execution
        .authorize({
          project: captured,
          configRevision: request.configRevision,
          purpose: 'opt-in-install',
        })
        .then((authorization) =>
          api.env.optInInstall({
            project: captured,
            cfg: request.cfg,
            configRevision: request.configRevision,
            checkId: check.id,
            authorization,
          }),
        )
        .catch((cause: unknown) => {
          if (!owns(captured)) return
          setStates((prev) => {
            const current = prev[check.id]
            // Keep a started operation's own reporting; report only a failure
            // that stopped this request before the sidecar took ownership.
            if (current && current.operationId !== '') return prev
            return {
              ...prev,
              [check.id]: {
                operationId: '',
                checkId: check.id,
                projectId: captured.projectId,
                projectEpoch: captured.epoch,
                phase: 'error',
                startedAt,
                updatedAt: Date.now(),
                output: '',
                rc: -1,
                stdout: '',
                stderr: cause instanceof Error ? cause.message : String(cause),
              },
            }
          })
        })
    },
    [owns, projectRef, record],
  )

  const running =
    Object.values(states).find((state) => !isInstallSettled(state))?.checkId ??
    null

  return { states, running, start }
}
