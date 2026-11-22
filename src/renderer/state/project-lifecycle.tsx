import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { isBoundaryExpiredError } from '../../shared/rpc-errors'
import type { ProjectRef } from '../../shared/types'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { getApi } from './api'
import { useApp } from './context'
import { useDurableMutations } from './durable-mutations-state'
import {
  ProjectLifecycleContext,
  type ProjectLifecycleValue,
  type RendererBoundaryIntent,
} from './project-lifecycle-state'
import { useRuntime } from './runtime-state'

interface PendingBoundary {
  intent: RendererBoundaryIntent
  requestId?: string
  proceed: () => Promise<void> | void
  phase:
    | 'dirty'
    | 'mutations'
    | 'runtime'
    | 'active'
    | 'proceeding'
    | 'crossing'
    | 'expired'
  /** Defer native discard until main commits the boundary transaction. */
  allowExistingDirty?: boolean
}

/** Retrigger only native boundaries that the renderer may request again. */
function retriggerBoundary(
  intent: RendererBoundaryIntent,
): (() => Promise<void>) | null {
  if (intent === 'window-close') return () => getApi().window.close()
  if (intent === 'update-install') return () => getApi().update.installNow()
  return null
}

/** Describe the intended native boundary in plain language. */
function boundaryAction(intent: RendererBoundaryIntent): string {
  return intent === 'app-quit'
    ? 'quit'
    : intent === 'renderer-reload'
      ? 'reload its window'
      : intent === 'update-install'
        ? 'install the update'
        : 'close'
}

/** Explain an expired native boundary to the operator. */
function expiredBoundaryMessage(intent: RendererBoundaryIntent): string {
  const action = boundaryAction(intent)
  const again = retriggerBoundary(intent)
    ? 'Ask again to answer a fresh confirmation.'
    : `Request that ${intent === 'app-quit' ? 'quit' : 'reload'} again when you are ready to answer a fresh confirmation.`
  return `The request for Supraspina to ${action} expired. Supraspina stays open and the project is unchanged. ${again}`
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      window.setTimeout(
        () =>
          reject(
            new Error('Retry cancellation until it reaches a terminal state.'),
          ),
        ms,
      )
    }),
  ])
}

const ACTIVE_JOB_STATUSES = new Set([
  'planned',
  'waiting',
  'queued',
  'running',
  'cancelling',
  'unknown',
])

const APPROVED_UNLOAD_TTL_MS = 15_000

async function waitForTerminalRuns(
  project: ProjectRef,
  runIds: ReadonlySet<string>,
): Promise<void> {
  while (true) {
    const snapshot = await getApi().runtime.bootstrap({
      project,
      runLimit: 100,
      logLimit: 0,
    })
    const pendingJob = snapshot.jobs.some(
      (job) =>
        job.runId !== undefined &&
        runIds.has(job.runId) &&
        ACTIVE_JOB_STATUSES.has(job.status),
    )
    const pendingRun = snapshot.runs.some(
      (run) => runIds.has(run.runId) && ACTIVE_JOB_STATUSES.has(run.status),
    )
    if (!pendingJob && !pendingRun) return
    await new Promise<void>((resolve) => window.setTimeout(resolve, 200))
  }
}

async function waitForProvisionTerminal(project: ProjectRef): Promise<void> {
  while (true) {
    const status = await getApi().provision.status({ project })
    if (status.phase !== 'running') return
    await new Promise<void>((resolve) => window.setTimeout(resolve, 200))
  }
}

/** Guard every project, window, application, and update boundary. */
export function ProjectLifecycleProvider({
  children,
}: {
  children: ReactNode
}): ReactNode {
  const app = useApp()
  const runtime = useRuntime()
  const mutations = useDurableMutations()
  const mutationSnapshot = mutations.snapshot(app.projectRef)
  const hasUnknownOwnership =
    runtime.activeRuns.some((run) => run.status === 'unknown') ||
    runtime.activeJobs.some((job) => job.status === 'unknown') ||
    (runtime.provision?.phase === 'running' &&
      !runtime.provision.cancellable &&
      runtime.provision.error !== null)
  const [pending, setPending] = useState<PendingBoundary | null>(null)
  // Retain a native boundary declined by this window so the refusal remains visible.
  const [refusedIntent, setRefusedIntent] =
    useState<RendererBoundaryIntent | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const transitionInFlightRef = useRef(false)
  const approvedUnloadRef = useRef<{
    requestId: string
    timer: number
  } | null>(null)
  const appRef = useRef(app)
  const runtimeRef = useRef(runtime)
  const mutationsRef = useRef(mutations)
  useLayoutEffect(() => {
    appRef.current = app
    runtimeRef.current = runtime
    mutationsRef.current = mutations
  }, [app, mutations, runtime])

  const releaseBoundary = useCallback(() => {
    transitionInFlightRef.current = false
    setPending(null)
    setBusy(false)
    setError(null)
  }, [])

  const disarmApprovedUnload = useCallback((requestId?: string) => {
    const approval = approvedUnloadRef.current
    if (!approval || (requestId && approval.requestId !== requestId)) return
    window.clearTimeout(approval.timer)
    approvedUnloadRef.current = null
  }, [])

  const armApprovedUnload = useCallback(
    (requestId: string) => {
      disarmApprovedUnload()
      const timer = window.setTimeout(() => {
        if (approvedUnloadRef.current?.requestId === requestId) {
          approvedUnloadRef.current = null
        }
      }, APPROVED_UNLOAD_TTL_MS)
      approvedUnloadRef.current = { requestId, timer }
    },
    [disarmApprovedUnload],
  )

  const consumeApprovedUnload = useCallback((): boolean => {
    const approval = approvedUnloadRef.current
    if (!approval) return false
    window.clearTimeout(approval.timer)
    approvedUnloadRef.current = null
    return true
  }, [])

  const showExpiredBoundary = useCallback(
    (boundary: PendingBoundary) => {
      if (boundary.requestId) disarmApprovedUnload(boundary.requestId)
      setPending({ ...boundary, phase: 'expired' })
      setBusy(false)
      setError(null)
    },
    [disarmApprovedUnload],
  )

  const showCrossingFailure = useCallback(
    (boundary: PendingBoundary, cause: unknown) => {
      if (boundary.requestId) disarmApprovedUnload(boundary.requestId)
      setPending({
        intent: boundary.intent,
        proceed: boundary.proceed,
        phase: 'crossing',
      })
      setBusy(false)
      setError(
        cause instanceof Error
          ? cause.message
          : 'The requested boundary could not be completed.',
      )
    },
    [disarmApprovedUnload],
  )

  useEffect(
    () => () => {
      disarmApprovedUnload()
    },
    [disarmApprovedUnload],
  )

  const recheckGuards = useCallback(
    (
      boundary: PendingBoundary,
      settled?: {
        runIds: ReadonlySet<string>
        provisionOperationId: string | null
      },
      allowExistingDirty = boundary.allowExistingDirty ?? false,
    ): boolean => {
      if (!allowExistingDirty && app.getLifecycleSnapshot().dirty) {
        setPending({ ...boundary, phase: 'dirty' })
        setError('Review project changes again before crossing this boundary.')
        return false
      }
      const project = app.getLifecycleSnapshot().project
      if (project && mutationsRef.current.snapshot(project).pendingCount > 0) {
        setPending({ ...boundary, phase: 'mutations' })
        setError(
          'Finish persistent project writes before crossing this boundary.',
        )
        return false
      }
      const latest = runtimeRef.current
      if (
        app.getLifecycleSnapshot().project &&
        !latest.authoritativeRuntimeKnown
      ) {
        setPending({ ...boundary, phase: 'runtime' })
        setError(
          latest.error ??
            'Verify the current project runtime authoritatively before continuing.',
        )
        return false
      }
      const hasActive = settled
        ? latest.activeRuns.some((run) => !settled.runIds.has(run.runId)) ||
          latest.activeJobs.some(
            (job) => !job.runId || !settled.runIds.has(job.runId),
          ) ||
          (latest.provision?.phase === 'running' &&
            (!settled.provisionOperationId ||
              latest.provision.operationId !== settled.provisionOperationId))
        : latest.activeCount > 0
      if (hasActive) {
        setPending({ ...boundary, phase: 'active' })
        setError('Review active work again before crossing this boundary.')
        return false
      }
      return true
    },
    [app],
  )

  const finish = useCallback(
    async (
      boundary: PendingBoundary,
      decision: 'proceed' | 'cancel',
      settled?: {
        runIds: ReadonlySet<string>
        provisionOperationId: string | null
      },
      allowExistingDirty = false,
    ) => {
      if (decision === 'proceed') {
        if (
          !recheckGuards(
            boundary,
            settled,
            allowExistingDirty || boundary.allowExistingDirty === true,
          )
        )
          return
        await boundary.proceed()
      }
      if (boundary.requestId) {
        if (decision === 'proceed') armApprovedUnload(boundary.requestId)
        try {
          await getApi().lifecycle.respondBoundary({
            requestId: boundary.requestId,
            decision,
            ...(error ? { reason: error } : {}),
          })
        } catch (cause: unknown) {
          disarmApprovedUnload(boundary.requestId)
          if (isBoundaryExpiredError(cause)) {
            // Release an expired cancellation because Stay was already requested.
            // Explain only an expired approval.
            if (decision === 'proceed') showExpiredBoundary(boundary)
            else releaseBoundary()
          } else if (decision === 'proceed') {
            showCrossingFailure(boundary, cause)
          } else {
            releaseBoundary()
          }
          return
        }
      }
      releaseBoundary()
    },
    [
      armApprovedUnload,
      disarmApprovedUnload,
      error,
      recheckGuards,
      releaseBoundary,
      showCrossingFailure,
      showExpiredBoundary,
    ],
  )

  const requestBoundary = useCallback<ProjectLifecycleValue['requestBoundary']>(
    (intent, proceed) => {
      if (transitionInFlightRef.current) return
      transitionInFlightRef.current = true
      if (app.dirty) {
        setPending({ intent, proceed, phase: 'dirty' })
      } else if (mutationSnapshot.pendingCount > 0) {
        setPending({ intent, proceed, phase: 'mutations' })
      } else if (app.projectRef && !runtime.authoritativeRuntimeKnown) {
        setPending({ intent, proceed, phase: 'runtime' })
      } else if (runtime.activeCount > 0) {
        setPending({ intent, proceed, phase: 'active' })
      } else {
        const boundary: PendingBoundary = {
          intent,
          proceed,
          phase: 'proceeding',
        }
        setPending(boundary)
        void Promise.resolve()
          .then(() => {
            if (!recheckGuards(boundary)) return false
            return Promise.resolve(proceed()).then(() => true)
          })
          .then((completed) => {
            if (!completed) return
            releaseBoundary()
          })
          .catch((cause: unknown) => {
            setPending({ ...boundary, phase: 'crossing' })
            setError(
              cause instanceof Error
                ? cause.message
                : 'Retry the project boundary.',
            )
          })
      }
    },
    [
      app.dirty,
      app.projectRef,
      mutationSnapshot.pendingCount,
      runtime.activeCount,
      runtime.authoritativeRuntimeKnown,
      recheckGuards,
      releaseBoundary,
    ],
  )

  useEffect(() => {
    const off = getApi().lifecycle.onBoundaryRequested((request) => {
      if (transitionInFlightRef.current) {
        void getApi().lifecycle.respondBoundary({
          requestId: request.requestId,
          decision: 'cancel',
          reason: 'An earlier lifecycle boundary decision is still pending.',
        })
        // Explain this refusal so Close never appears inert while an earlier boundary
        // remains unresolved.
        setRefusedIntent(request.intent)
        return
      }
      transitionInFlightRef.current = true
      // Let main own the native crossing and invalidate project authority within that
      // transaction. Keep this renderer attached until main proves the crossing can
      // succeed.
      const proceed = async (): Promise<void> => undefined
      if (appRef.current.getLifecycleSnapshot().dirty) {
        setPending({ ...request, proceed, phase: 'dirty' })
      } else if (
        mutationsRef.current.snapshot(
          appRef.current.getLifecycleSnapshot().project,
        ).pendingCount > 0
      ) {
        setPending({ ...request, proceed, phase: 'mutations' })
      } else if (
        appRef.current.getLifecycleSnapshot().project &&
        !runtimeRef.current.authoritativeRuntimeKnown
      ) {
        setPending({ ...request, proceed, phase: 'runtime' })
      } else if (runtimeRef.current.activeCount > 0) {
        setPending({ ...request, proceed, phase: 'active' })
      } else {
        const boundary: PendingBoundary = {
          ...request,
          proceed,
          phase: 'proceeding',
        }
        setPending(boundary)
        void finish(boundary, 'proceed')
      }
    })
    return off
  }, [finish])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (consumeApprovedUnload()) return
      if (
        !app.dirty &&
        mutationSnapshot.pendingCount === 0 &&
        (!app.projectRef || runtime.authoritativeRuntimeKnown) &&
        runtime.activeCount === 0
      )
        return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [
    app.dirty,
    consumeApprovedUnload,
    mutationSnapshot.pendingCount,
    runtime.activeCount,
    runtime.authoritativeRuntimeKnown,
    app.projectRef,
  ])

  const cancelPending = useCallback(() => {
    const boundary = pending
    if (!boundary || busy) return
    // Release an expired confirmation because no response token remains.
    if (boundary.phase === 'expired') {
      releaseBoundary()
      return
    }
    void finish(boundary, 'cancel').catch((cause: unknown) => {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Retry the boundary dismissal.',
      )
    })
  }, [pending, busy, finish, releaseBoundary])

  const askBoundaryAgain = useCallback(() => {
    const boundary = pending
    if (!boundary || busy || boundary.phase !== 'expired') return
    const trigger = retriggerBoundary(boundary.intent)
    if (!trigger) return
    releaseBoundary()
    void trigger().catch((cause: unknown) => {
      // Let a fresh confirmation take over the flow. Report only a request that never
      // became a confirmation.
      if (transitionInFlightRef.current) return
      setPending({ ...boundary, phase: 'expired' })
      setError(
        cause instanceof Error
          ? cause.message
          : 'Retry the confirmation request.',
      )
    })
  }, [busy, pending, releaseBoundary])

  const afterDirty = useCallback(async () => {
    const boundary = pending
    if (!boundary) return
    const project = appRef.current.getLifecycleSnapshot().project
    if (project && mutationsRef.current.snapshot(project).pendingCount > 0) {
      setPending({ ...boundary, phase: 'mutations' })
      return
    }
    if (project && !runtimeRef.current.authoritativeRuntimeKnown) {
      setPending({ ...boundary, phase: 'runtime' })
      return
    }
    if (runtimeRef.current.activeCount > 0) {
      setPending({ ...boundary, phase: 'active' })
      return
    }
    await finish(boundary, 'proceed')
  }, [pending, finish])

  const afterMutations = useCallback(async () => {
    const boundary = pending
    if (!boundary) return
    if (
      !boundary.allowExistingDirty &&
      appRef.current.getLifecycleSnapshot().dirty
    ) {
      setPending({ ...boundary, phase: 'dirty' })
      return
    }
    if (
      appRef.current.getLifecycleSnapshot().project &&
      !runtimeRef.current.authoritativeRuntimeKnown
    ) {
      setPending({ ...boundary, phase: 'runtime' })
      return
    }
    if (runtimeRef.current.activeCount > 0) {
      setPending({ ...boundary, phase: 'active' })
      return
    }
    await finish(boundary, 'proceed')
  }, [finish, pending])

  const saveAndContinue = useCallback(() => {
    if (!pending) return
    setBusy(true)
    setError(null)
    void app
      .saveProject()
      .then(afterDirty)
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : 'Retry saving the project.',
        )
      })
      .finally(() => setBusy(false))
  }, [pending, app, afterDirty])

  const discardAndContinue = useCallback(() => {
    const boundary = pending
    if (!boundary) return
    // Preserve the draft before a native boundary so authority and edits remain usable
    // if main rejects the crossing. Restore the persisted snapshot before invoking a
    // renderer-local project-switch callback.
    setBusy(true)
    const nativeBoundary = boundary.requestId
      ? { ...boundary, allowExistingDirty: true }
      : boundary
    const project = app.projectRef
    const continuation = boundary.requestId
      ? project && mutationsRef.current.snapshot(project).pendingCount > 0
        ? Promise.resolve(setPending({ ...nativeBoundary, phase: 'mutations' }))
        : finish(nativeBoundary, 'proceed', undefined, true)
      : app.discardChanges().then(afterDirty)
    void continuation
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Retry the boundary.')
      })
      .finally(() => setBusy(false))
  }, [app, pending, afterDirty, finish])

  const saveMutationsAndContinue = useCallback(() => {
    const boundary = pending
    const project = app.projectRef
    if (!boundary || !project) return
    setBusy(true)
    setError(null)
    void mutations
      .flush(project)
      .then(afterMutations)
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Retry saving persistent project edits.',
        )
      })
      .finally(() => setBusy(false))
  }, [afterMutations, app.projectRef, mutations, pending])

  const discardMutationsAndContinue = useCallback(() => {
    const boundary = pending
    const project = app.projectRef
    if (!boundary || !project) return
    setBusy(true)
    setError(null)
    void mutations
      .discard(project)
      .then(afterMutations)
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Retry discarding persistent project edits.',
        )
      })
      .finally(() => setBusy(false))
  }, [afterMutations, app.projectRef, mutations, pending])

  const cancelWorkAndContinue = useCallback(() => {
    const boundary = pending
    const project = app.projectRef
    if (!boundary || !project) return
    setBusy(true)
    setError(null)
    const runIds = new Set([
      ...runtime.activeRuns.map((run) => run.runId),
      ...runtime.activeJobs.flatMap((job) => (job.runId ? [job.runId] : [])),
    ])
    const cancellations = [...runIds].map((runId) =>
      getApi()
        .pipeline.cancelRun({ project, runId })
        .then((result) => {
          if (!result.accepted && !result.terminal)
            throw new Error(result.message)
        }),
    )
    const provisioningActive =
      runtime.provision?.phase === 'running' &&
      runtime.provision.cancellable &&
      runtime.provision.operationId
    if (provisioningActive) {
      const operationId = provisioningActive
      cancellations.push(
        getApi()
          .provision.cancel({ project, operationId })
          .then((result) => {
            if (!result.accepted && !result.terminal) {
              throw new Error(
                'Retry provisioning cancellation until it is acknowledged.',
              )
            }
          }),
      )
    }
    void withTimeout(
      Promise.all(cancellations).then(() =>
        Promise.all([
          waitForTerminalRuns(project, runIds),
          ...(provisioningActive ? [waitForProvisionTerminal(project)] : []),
        ]).then(() => undefined),
      ),
      10_000,
    )
      .then(() =>
        finish(boundary, 'proceed', {
          runIds,
          provisionOperationId: provisioningActive || null,
        }),
      )
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Retry canceling active work.',
        )
      })
      .finally(() => setBusy(false))
  }, [
    pending,
    app.projectRef,
    runtime.activeRuns,
    runtime.activeJobs,
    runtime.provision,
    finish,
  ])

  const retryRuntimeVerification = useCallback(() => {
    if (
      !pending ||
      busy ||
      (pending.phase !== 'runtime' &&
        !(pending.phase === 'active' && hasUnknownOwnership))
    )
      return
    setError(null)
    runtime.retryHydration()
  }, [busy, hasUnknownOwnership, pending, runtime])

  const recoverRuntime = useCallback(() => {
    if (
      !pending ||
      busy ||
      (pending.phase !== 'runtime' &&
        !(pending.phase === 'active' && hasUnknownOwnership))
    )
      return
    setBusy(true)
    setError(null)
    void withTimeout(getApi().host.retrySidecar(), 10_000)
      .then(() => {
        app.refreshHostState()
        runtime.retryHydration()
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Retry scientific runtime recovery.',
        )
      })
      .finally(() => setBusy(false))
  }, [app, busy, hasUnknownOwnership, pending, runtime])

  useEffect(() => {
    const boundary = pending
    if (
      !boundary ||
      boundary.phase !== 'runtime' ||
      busy ||
      !runtime.authoritativeRuntimeKnown
    ) {
      return undefined
    }
    const timer = window.setTimeout(() => {
      const proceeding = { ...boundary, phase: 'proceeding' as const }
      setPending(proceeding)
      void finish(proceeding, 'proceed').catch((cause: unknown) => {
        showCrossingFailure(proceeding, cause)
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [
    busy,
    finish,
    pending,
    runtime.authoritativeRuntimeKnown,
    showCrossingFailure,
  ])

  useEffect(() => {
    const boundary = pending
    if (
      !boundary ||
      boundary.phase !== 'active' ||
      busy ||
      !runtime.authoritativeRuntimeKnown ||
      runtime.activeCount !== 0
    ) {
      return undefined
    }
    const timer = window.setTimeout(() => {
      const proceeding = { ...boundary, phase: 'proceeding' as const }
      setPending(proceeding)
      void finish(proceeding, 'proceed').catch((cause: unknown) => {
        showCrossingFailure(proceeding, cause)
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [
    busy,
    finish,
    pending,
    runtime.activeCount,
    runtime.authoritativeRuntimeKnown,
    showCrossingFailure,
  ])

  const value = useMemo<ProjectLifecycleValue>(
    () => ({ requestBoundary }),
    [requestBoundary],
  )

  return (
    <ProjectLifecycleContext value={value}>
      {children}
      {pending?.phase === 'dirty' && (
        <ConfirmDialog
          t={app.t}
          title="Choose how to handle project changes"
          message="This boundary would replace or close the active project. Save keeps the current revision, Discard returns to the last persisted snapshot, and Cancel stays in the project."
          error={error}
          busy={busy}
          onDismiss={cancelPending}
          actions={[
            { label: 'Cancel', onSelect: cancelPending, initialFocus: true },
            { label: 'Discard', onSelect: discardAndContinue, tone: 'danger' },
            { label: 'Save', onSelect: saveAndContinue, tone: 'primary' },
          ]}
        />
      )}
      {pending?.phase === 'active' && (
        <ConfirmDialog
          t={app.t}
          title={
            hasUnknownOwnership
              ? 'Choose how to recover scientific work'
              : 'Confirm canceling active work'
          }
          message={
            hasUnknownOwnership
              ? 'Scientific process ownership needs recovery before Supraspina continues. Supraspina keeps the project active and blocks duplicate work and project boundaries until recovery proves the old process tree is gone.'
              : `${runtime.activeCount} active ${runtime.activeCount === 1 ? 'operation' : 'operations'} must reach a terminal state before Supraspina continues.`
          }
          error={error}
          busy={busy}
          onDismiss={cancelPending}
          actions={
            hasUnknownOwnership
              ? [
                  {
                    label: 'Stay',
                    onSelect: cancelPending,
                    initialFocus: true,
                  },
                  { label: 'Retry', onSelect: retryRuntimeVerification },
                  {
                    label: 'Recover',
                    onSelect: recoverRuntime,
                    tone: 'primary',
                  },
                ]
              : [
                  {
                    label: 'Stay',
                    onSelect: cancelPending,
                    initialFocus: true,
                  },
                  {
                    label: 'Cancel jobs and continue',
                    onSelect: cancelWorkAndContinue,
                    tone: 'danger',
                  },
                ]
          }
        />
      )}
      {refusedIntent !== null && !pending && (
        <ConfirmDialog
          t={app.t}
          title="Finish the current change"
          message={`The earlier project change is still in progress, so Supraspina cannot ${boundaryAction(refusedIntent)} yet. Finish or answer that change, then ask again. The current project stays open and unchanged in the meantime.`}
          onDismiss={() => setRefusedIntent(null)}
          actions={[
            {
              label: 'OK',
              onSelect: () => setRefusedIntent(null),
              initialFocus: true,
            },
          ]}
        />
      )}
      {pending?.phase === 'runtime' && (
        <ConfirmDialog
          t={app.t}
          title="Verify runtime state"
          message="Supraspina cannot prove that the current project is idle. Retry repeats the exact-project bootstrap, Recover recovers the supervised runtime, and Stay keeps the project as it is. Supraspina keeps every project, reload, close, quit, and update boundary blocked until a current same-project snapshot is accepted."
          error={
            error ??
            runtime.error ??
            (runtime.authorityState === 'unavailable'
              ? 'Recover the supervised runtime before verification.'
              : null)
          }
          busy={busy}
          onDismiss={cancelPending}
          actions={[
            { label: 'Stay', onSelect: cancelPending, initialFocus: true },
            { label: 'Retry', onSelect: retryRuntimeVerification },
            {
              label: 'Recover',
              onSelect: recoverRuntime,
              tone: 'primary',
            },
          ]}
        />
      )}
      {pending?.phase === 'mutations' && (
        <ConfirmDialog
          t={app.t}
          title="Choose how to handle pending project writes"
          message={`${mutationSnapshot.pendingCount} pending persistent ${mutationSnapshot.pendingCount === 1 ? 'edit is' : 'edits are'} not saved yet. Save or discard ${mutationSnapshot.pendingCount === 1 ? 'it' : 'them'}, or stay in the current project.`}
          error={error}
          busy={busy}
          onDismiss={cancelPending}
          actions={[
            { label: 'Cancel', onSelect: cancelPending, initialFocus: true },
            {
              label: 'Discard',
              onSelect: discardMutationsAndContinue,
              tone: 'danger',
            },
            {
              label: mutationSnapshot.failedCount > 0 ? 'Retry save' : 'Save',
              onSelect: saveMutationsAndContinue,
              tone: 'primary',
            },
          ]}
        />
      )}
      {pending?.phase === 'expired' && (
        <ConfirmDialog
          t={app.t}
          title="Retry the expired confirmation"
          message={expiredBoundaryMessage(pending.intent)}
          error={error}
          onDismiss={cancelPending}
          actions={
            retriggerBoundary(pending.intent)
              ? [
                  {
                    label: 'Stay',
                    onSelect: cancelPending,
                    initialFocus: true,
                  },
                  {
                    label:
                      pending.intent === 'update-install'
                        ? 'Install again'
                        : 'Close again',
                    onSelect: askBoundaryAgain,
                    tone: 'primary',
                  },
                ]
              : [{ label: 'Stay', onSelect: cancelPending, initialFocus: true }]
          }
        />
      )}
      {pending?.phase === 'crossing' && (
        <ConfirmDialog
          t={app.t}
          title="Retry this boundary"
          message="The boundary failed. Resolve the error before retrying it; the active project stays open."
          error={error}
          onDismiss={cancelPending}
          actions={[
            { label: 'Stay', onSelect: cancelPending, initialFocus: true },
          ]}
        />
      )}
    </ProjectLifecycleContext>
  )
}
