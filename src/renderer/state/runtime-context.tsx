import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  RunSnapshot,
  RuntimeEvent,
  RuntimeSnapshot,
  WorkflowSummary,
} from '../../shared/contract'
import type { Job } from '../../shared/types'
import type { ProjectRef } from '../../shared/types'
import { getApi } from './api'
import { useApp } from './context'
import {
  RuntimeContext,
  logReplayCoverage,
  type LogReplayCoverage,
  type RuntimeState,
} from './runtime-state'

function upsertById<T extends { runId: string }>(rows: T[], next: T): T[] {
  return [next, ...rows.filter((row) => row.runId !== next.runId)]
}

function upsertJob(rows: Job[], next: Job): Job[] {
  return [next, ...rows.filter((row) => row.id !== next.id)]
}

function activeStatus(run: RunSnapshot): boolean {
  return (
    !run.dryRun &&
    (run.status === 'unknown' ||
      (run.endedAt === null &&
        ['planned', 'waiting', 'queued', 'running', 'cancelling'].includes(
          run.status,
        )))
  )
}

function sameProject(left: ProjectRef, right: ProjectRef): boolean {
  return (
    left.projectId === right.projectId &&
    left.root === right.root &&
    left.configPath === right.configPath &&
    left.epoch === right.epoch
  )
}

/**
 * Hydrate and project the durable runtime exactly once for the active project.
 */
export function RuntimeProvider({
  children,
}: {
  children: ReactNode
}): ReactNode {
  const { projectRef, hostState } = useApp()
  const readyGeneration =
    hostState?.sidecar.state === 'ready' && hostState.sidecar.projectAttached
      ? hostState.sidecar.generation
      : null
  const projectKey = projectRef
    ? `${projectRef.projectId}\0${projectRef.root}\0${projectRef.configPath}\0${projectRef.epoch}`
    : 'no-project'
  return (
    <RuntimeProjection
      key={projectKey}
      projectRef={projectRef}
      readyGeneration={readyGeneration}
    >
      {children}
    </RuntimeProjection>
  )
}

function RuntimeProjection({
  children,
  projectRef,
  readyGeneration,
}: {
  children: ReactNode
  projectRef: ProjectRef | null
  readyGeneration: number | null
}): ReactNode {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null)
  // Project the replay coverage once per bootstrap: live events replace the
  // snapshot's jobs, but which jobs had finished at the snapshot must stay
  // the snapshot's own answer until the next bootstrap.
  const [logReplay, setLogReplay] = useState<LogReplayCoverage>(() =>
    logReplayCoverage(null),
  )
  const [summary, setSummary] = useState<WorkflowSummary | null>(null)
  const [hydrating, setHydrating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const cursorRef = useRef({ generation: -1, sequence: -1 })

  useEffect(() => {
    if (!projectRef || readyGeneration === null) return undefined

    let active = true
    const api = getApi()
    const hydrate = (minimumGeneration = -1): void => {
      void (async () => {
        await Promise.resolve()
        if (!active) return
        setHydrating(true)
        try {
          const next = await api.runtime.bootstrap({
            project: projectRef,
            runLimit: 100,
            logLimit: 2_000,
          })
          if (!active) return
          if (!sameProject(next.project, projectRef)) {
            setError(
              'The previous runtime snapshot identified another project than the current one.',
            )
            return
          }
          if (next.sidecarGeneration < minimumGeneration) {
            setError(
              'Retry runtime verification with the current supervisor generation.',
            )
            return
          }
          const cursor = cursorRef.current
          if (
            next.sidecarGeneration < cursor.generation ||
            (next.sidecarGeneration === cursor.generation &&
              next.sequence < cursor.sequence)
          ) {
            return
          }
          cursorRef.current = {
            generation: next.sidecarGeneration,
            sequence: next.sequence,
          }
          setSnapshot(next)
          setLogReplay(logReplayCoverage(next))
          setError(null)
        } catch (cause: unknown) {
          if (!active) return
          setError(
            cause instanceof Error
              ? cause.message
              : 'Runtime state could not be restored.',
          )
        } finally {
          if (active) setHydrating(false)
        }
      })()
    }
    hydrate(readyGeneration)

    const off = api.runtime.onEvent((event: RuntimeEvent) => {
      if (!active) return
      if (
        event.projectId !== projectRef.projectId ||
        event.projectEpoch !== projectRef.epoch
      ) {
        return
      }
      const cursor = cursorRef.current
      if (event.sidecarGeneration < cursor.generation) return
      if (event.sidecarGeneration > cursor.generation) {
        // Rehydrate the durable run store after a supervisor restart invalidates the
        // in-memory cursor. Do not replace history with one event.
        setSummary(null)
        hydrate(event.sidecarGeneration)
        return
      }
      if (
        event.sidecarGeneration === cursor.generation &&
        event.sequence <= cursor.sequence
      ) {
        return
      }
      cursorRef.current = {
        generation: event.sidecarGeneration,
        sequence: event.sequence,
      }
      setSnapshot((current) => {
        if (!current || current.sidecarGeneration !== event.sidecarGeneration) {
          return current
        }
        const base = current
        switch (event.kind) {
          case 'job':
            return {
              ...base,
              sidecarGeneration: event.sidecarGeneration,
              sequence: event.sequence,
              jobs: upsertJob(base.jobs, event.job),
            }
          case 'run':
            return {
              ...base,
              sidecarGeneration: event.sidecarGeneration,
              sequence: event.sequence,
              runs: upsertById(base.runs, event.run),
            }
          case 'log':
            return {
              ...base,
              sidecarGeneration: event.sidecarGeneration,
              sequence: event.sequence,
              logTail: [...base.logTail, event.log].slice(-2_000),
            }
          case 'provision':
            return {
              ...base,
              sidecarGeneration: event.sidecarGeneration,
              sequence: event.sequence,
              provision: event.provision,
            }
          case 'summary':
            setSummary(event.summary)
            return {
              ...base,
              sidecarGeneration: event.sidecarGeneration,
              sequence: event.sequence,
            }
        }
      })
    })

    return () => {
      active = false
      off()
    }
  }, [projectRef, readyGeneration, retryNonce])

  const value = useMemo<RuntimeState>(() => {
    const runs = snapshot?.runs ?? []
    const jobs = snapshot?.jobs ?? []
    const activeRuns = runs.filter(activeStatus)
    const activeJobs = jobs.filter(
      (job) =>
        !job.dryRun &&
        (job.status === 'unknown' ||
          (job.endedAt === null &&
            ['planned', 'waiting', 'queued', 'running', 'cancelling'].includes(
              job.status,
            ))),
    )
    const activeProvision = snapshot?.provision?.phase === 'running' ? 1 : 0
    const activeOperationIds = new Set(activeRuns.map((run) => run.runId))
    let anonymousActiveJobs = 0
    for (const job of activeJobs) {
      if (job.runId) activeOperationIds.add(job.runId)
      else anonymousActiveJobs += 1
    }
    const authoritativeRuntimeKnown =
      projectRef === null ||
      (readyGeneration !== null &&
        snapshot !== null &&
        sameProject(snapshot.project, projectRef) &&
        snapshot.sidecarGeneration === readyGeneration)
    const authorityState: RuntimeState['authorityState'] =
      projectRef === null
        ? 'not-applicable'
        : authoritativeRuntimeKnown
          ? 'known'
          : error
            ? 'rejected'
            : readyGeneration === null
              ? 'unavailable'
              : 'pending'
    const projectedActiveCount =
      activeOperationIds.size + anonymousActiveJobs + activeProvision
    return {
      runs,
      jobs,
      logs: snapshot?.logTail ?? [],
      logReplay,
      provision: snapshot?.provision ?? null,
      summary,
      hydrating: readyGeneration === null ? false : hydrating,
      error,
      authoritativeRuntimeKnown,
      authorityState,
      retryHydration: () => setRetryNonce((current) => current + 1),
      activeRuns,
      activeJobs,
      // Never project an open, unverified project as idle.
      activeCount:
        projectRef && !authoritativeRuntimeKnown
          ? Math.max(1, projectedActiveCount)
          : projectedActiveCount,
    }
  }, [
    snapshot,
    logReplay,
    summary,
    hydrating,
    error,
    projectRef,
    readyGeneration,
  ])

  return <RuntimeContext value={value}>{children}</RuntimeContext>
}
