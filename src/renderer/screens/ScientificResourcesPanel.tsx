import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type {
  ManagedResourceProgress,
  ManagedResourceRuntime,
  ManagedResourceStatus,
} from '../../shared/contract'
import type { ManagedResourceSelector } from '../../shared/scientific-contracts'
import type { EnvReport } from '../../shared/types'
import { getApi, hasNativeBridge } from '../state/api'
import { useApp } from '../state/context'
import {
  Btn,
  Chip,
  CodeText,
  ConfirmDialog,
  FONTS,
  Hint,
  InfoTip,
  LoadingState,
  RefreshButton,
  StateLine,
} from '../ui'
import { BrainChartsResourceCard } from './BrainChartsResourceCard'
import { GateNotice } from './env/GateNotice'
import { installGate } from './env/install-gate'

interface ResourceDefinition {
  selector: ManagedResourceSelector
  title: string
  description: string
}

const RESOURCES: readonly ResourceDefinition[] = [
  {
    selector: { resource: 'synthstrip', variant: 'cpu' },
    title: 'SynthStrip CPU',
    description: 'Brain masks and field-of-view crop.',
  },
  {
    selector: { resource: 'fastsurfer', variant: 'cpu' },
    title: 'FastSurfer CPU',
    description: 'FastSurfer reconstruction without a GPU.',
  },
  {
    selector: { resource: 'fastsurfer', variant: 'cuda' },
    title: 'FastSurfer CUDA',
    description: 'FastSurfer reconstruction on an NVIDIA GPU.',
  },
]

type PendingAction =
  | { kind: 'provision'; definition: ResourceDefinition }
  | { kind: 'import'; definition: ResourceDefinition; sourcePath: string }

function keyOf(selector: ManagedResourceSelector): string {
  return `${selector.resource}:${selector.variant}`
}

function resourceStatusChip(
  status: ManagedResourceStatus,
): 'done' | 'running' | 'warn' | 'failed' | 'pending' {
  if (['queued', 'pulling', 'importing', 'verifying'].includes(status.phase)) {
    return 'running'
  }
  if (status.phase === 'error' || status.state === 'invalid') return 'failed'
  if (status.state === 'ready') return 'done'
  if (status.state === 'unavailable' || status.phase === 'cancelled') {
    return 'warn'
  }
  return 'pending'
}

function resourceStatusLabel(status: ManagedResourceStatus): string {
  switch (status.phase) {
    case 'queued':
      return 'Queued'
    case 'pulling':
      return 'Downloading'
    case 'importing':
      return 'Importing'
    case 'verifying':
      return 'Verifying'
    case 'error':
      return 'Failed'
    case 'cancelled':
      return 'Canceled'
    case 'done':
      return status.state === 'ready' ? 'Ready' : 'Finished'
    case 'idle':
      break
  }
  switch (status.state) {
    case 'ready':
      return 'Ready'
    case 'invalid':
      return 'Verification failed'
    case 'unavailable':
      return 'Unavailable'
    case 'missing':
      return 'Not installed'
  }
}

/** The page the installation guide names as the Apptainer source. */
const APPTAINER_RELEASES_URL = 'https://github.com/apptainer/apptainer/releases'

/** Describe the detected Apptainer: its release and where it was found. */
function runtimeEvidence(runtime: ManagedResourceRuntime): string {
  if (!runtime.found) {
    return 'No Apptainer executable was found on PATH.'
  }
  if (runtime.version === null) {
    return `Apptainer at ${runtime.path} did not report a release.`
  }
  return `Apptainer ${runtime.version} at ${runtime.path}.`
}

/** State the release the pinned images were built with, for the tooltip. */
function runtimeExpectation(runtime: ManagedResourceRuntime): string {
  return `Online provisioning reproduces the pinned SIFs only with Apptainer ${runtime.expectedVersion}.`
}

/** The Apptainer releases the runtime lines set as inline code. */
function runtimeVersions(runtime: ManagedResourceRuntime): string[] {
  return [
    runtime.expectedVersion,
    ...(runtime.version === null ? [] : [runtime.version]),
  ]
}

function fallbackStatus(definition: ResourceDefinition): ManagedResourceStatus {
  return {
    ...definition.selector,
    version: definition.selector.resource === 'synthstrip' ? '1.8' : '2.5.4',
    state: 'missing',
    phase: 'idle',
    operationId: null,
    percent: null,
    cancellable: false,
    error: null,
  }
}

/** Project authority and safety posture for scientific resources. */
export interface ScientificResourcesPanelProps {
  safeExecution: boolean
  /** Turn on Allow live runs from the refusal; omit where the host has none. */
  onSafeExecutionChange?: ((next: boolean) => void) | undefined
  /**
   * The host's environment report (null while it loads), which the
   * BrainCharts card reads instead of checking on its own.
   */
  envReport?: EnvReport | null | undefined
  /** Recheck the host's environment report after a BrainCharts setup. */
  onEnvRecheck?: (() => void) | undefined
}

/** Manage verified machine-local scientific containers from Diagnostics. */
export function ScientificResourcesPanel({
  safeExecution,
  onSafeExecutionChange,
  envReport,
  onEnvRecheck,
}: ScientificResourcesPanelProps): ReactNode {
  const {
    t,
    projectRef,
    configRevision,
    savedRevision,
    savedCfg,
    dirty,
    hostState,
    saveProject,
  } = useApp()
  const statusSidecar =
    hostState?.mode === 'electron' ? hostState.sidecar : null
  const nativeHostStatePending = hostState === null && hasNativeBridge()
  const statusSidecarIdentity = statusSidecar
    ? `${statusSidecar.state}:${statusSidecar.generation}:${statusSidecar.projectAttached ? 'attached' : 'detached'}`
    : null
  const statusSidecarReady =
    !nativeHostStatePending &&
    (statusSidecar === null ||
      (statusSidecar.state === 'ready' && statusSidecar.projectAttached))
  const [statuses, setStatuses] = useState<
    Record<string, ManagedResourceStatus>
  >({})
  // Hold the host Apptainer readiness apart from the per-resource lifecycle:
  // only the status response reports it, and progress events never do.
  const [runtime, setRuntime] = useState<ManagedResourceRuntime | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [canceling, setCanceling] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const statusBlockedMessage = !projectRef
    ? 'Open a saved project to check scientific resources.'
    : dirty
      ? 'Save the project to check scientific resources.'
      : !statusSidecarReady
        ? 'The scientific runtime is not ready yet.'
        : null
  const showStatusPlaceholder =
    Object.keys(statuses).length === 0 && statusBlockedMessage !== null
  const latestIdentityRef = useRef({
    projectRef,
    configRevision,
    savedRevision,
    dirty,
    statusSidecarIdentity,
  })
  const statusRequestRef = useRef(0)

  useLayoutEffect(() => {
    latestIdentityRef.current = {
      projectRef,
      configRevision,
      savedRevision,
      dirty,
      statusSidecarIdentity,
    }
  }, [projectRef, configRevision, savedRevision, dirty, statusSidecarIdentity])

  const refresh = useCallback(async (): Promise<void> => {
    const captured = projectRef
    const capturedRevision = configRevision
    const capturedSavedRevision = savedRevision
    const capturedSavedCfg = savedCfg
    const capturedSidecarIdentity = statusSidecarIdentity
    const requestToken = statusRequestRef.current + 1
    statusRequestRef.current = requestToken
    const requestIsCurrent = (): boolean => {
      const latest = latestIdentityRef.current
      return (
        statusRequestRef.current === requestToken &&
        !latest.dirty &&
        latest.configRevision === capturedRevision &&
        latest.savedRevision === capturedSavedRevision &&
        latest.statusSidecarIdentity === capturedSidecarIdentity &&
        latest.projectRef?.projectId === captured?.projectId &&
        latest.projectRef?.epoch === captured?.epoch
      )
    }

    setError(null)
    if (!captured || dirty || !statusSidecarReady) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const next = await Promise.all(
        RESOURCES.map(async (definition) =>
          getApi().managedResource.status({
            project: captured,
            cfg: capturedSavedCfg,
            configRevision: capturedSavedRevision,
            ...definition.selector,
          }),
        ),
      )
      if (!requestIsCurrent()) return
      setStatuses(
        Object.fromEntries(next.map((status) => [keyOf(status), status])),
      )
      // Every response probes the one host runtime, so the first is enough.
      setRuntime(next[0]?.runtime ?? null)
    } catch (cause: unknown) {
      if (!requestIsCurrent()) return
      setError(
        cause instanceof Error
          ? cause.message
          : 'Scientific resources could not be inspected.',
      )
    } finally {
      if (requestIsCurrent()) setLoading(false)
    }
  }, [
    configRevision,
    dirty,
    projectRef,
    savedCfg,
    savedRevision,
    statusSidecarIdentity,
    statusSidecarReady,
  ])

  useEffect(() => {
    let active = true
    const api = getApi()
    const off = api.managedResource.onProgress(
      (event: ManagedResourceProgress) => {
        if (
          !active ||
          !projectRef ||
          event.projectId !== projectRef.projectId ||
          event.projectEpoch !== projectRef.epoch
        ) {
          return
        }
        setStatuses((current) => ({
          ...current,
          [keyOf(event)]: event,
        }))
      },
    )
    void Promise.resolve().then(refresh)
    return () => {
      active = false
      statusRequestRef.current += 1
      off()
    }
  }, [projectRef, refresh])

  const readyCount = useMemo(
    () =>
      RESOURCES.filter(
        (definition) => statuses[keyOf(definition.selector)]?.state === 'ready',
      ).length,
    [statuses],
  )

  // Refuse provisioning and import with a stated reason until a saved project
  // turns on Allow live runs; the authorization is bound to the saved project,
  // so an unsaved edit would otherwise let Authorize do nothing.
  const operationGate = installGate({
    action: 'download or import a resource',
    projectOpen: projectRef !== null,
    safeExecution,
    dirty,
    busy: false,
  })

  // Gate only the online pull. Offline import verifies an existing SIF with
  // the same size and SHA-256 checks and never invokes Apptainer.
  const runtimeBlockReason =
    runtime && !runtime.ready
      ? `Install Apptainer ${runtime.expectedVersion} to provision resources online, or import a verified SIF instead.`
      : null

  const openApptainerReleases = useCallback((): void => {
    // Report a refused destination instead of leaving the control silent.
    getApi()
      .external.openWeb({ url: APPTAINER_RELEASES_URL, purpose: 'download' })
      .catch(() => {
        setError(
          'Open the Apptainer releases page manually; Supraspina refused it.',
        )
      })
  }, [])

  const chooseOffline = useCallback(
    async (definition: ResourceDefinition): Promise<void> => {
      setError(null)
      try {
        const sourcePath = await getApi().fs.chooseFile({
          filters: [{ name: 'Apptainer image', extensions: ['sif'] }],
        })
        if (sourcePath) {
          setActionError(null)
          setPending({ kind: 'import', definition, sourcePath })
        }
      } catch (cause: unknown) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Choose the offline SIF again.',
        )
      }
    },
    [],
  )

  const runPending = useCallback(async (): Promise<void> => {
    const action = pending
    const captured = projectRef
    const capturedRevision = savedRevision
    const capturedCfg = savedCfg
    if (!action || !captured || !safeExecution || actionBusy || dirty) return
    setActionBusy(true)
    setActionError(null)
    setNotice(null)
    try {
      const api = getApi()
      const authorization = await api.execution.authorize({
        project: captured,
        configRevision: capturedRevision,
        purpose: 'provision',
      })
      const result =
        action.kind === 'import'
          ? await api.managedResource.importOffline({
              project: captured,
              cfg: capturedCfg,
              configRevision: capturedRevision,
              ...action.definition.selector,
              sourcePath: action.sourcePath,
              authorization,
            })
          : action.definition.selector.resource === 'synthstrip'
            ? await api.provision.synthstrip({
                project: captured,
                cfg: capturedCfg,
                configRevision: capturedRevision,
                authorization,
              })
            : await api.provision.fastsurfer({
                project: captured,
                cfg: capturedCfg,
                configRevision: capturedRevision,
                variant: action.definition.selector.variant,
                authorization,
              })
      setStatuses((current) => {
        const resourceKey = keyOf(action.definition.selector)
        const existing =
          current[resourceKey] ?? fallbackStatus(action.definition)
        if (existing.operationId !== null) return current
        return {
          ...current,
          [resourceKey]: {
            ...existing,
            phase: action.kind === 'import' ? 'importing' : 'queued',
            operationId: result.operationId,
            percent: 0,
            cancellable: true,
            error: null,
          },
        }
      })
      setNotice(
        `${
          action.kind === 'import' ? 'Offline verification' : 'Provisioning'
        } of ${action.definition.title} is running.`,
      )
      setPending(null)
    } catch (cause: unknown) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : 'Retry the resource operation.',
      )
    } finally {
      setActionBusy(false)
    }
  }, [
    actionBusy,
    dirty,
    pending,
    projectRef,
    safeExecution,
    savedCfg,
    savedRevision,
  ])

  const cancel = useCallback(
    async (
      definition: ResourceDefinition,
      status: ManagedResourceStatus,
    ): Promise<void> => {
      if (!projectRef || !status.operationId || !status.cancellable) return
      const resourceKey = keyOf(definition.selector)
      setCanceling(resourceKey)
      setError(null)
      try {
        const result = await getApi().managedResource.cancel({
          project: projectRef,
          cfg: savedCfg,
          configRevision: savedRevision,
          ...definition.selector,
          operationId: status.operationId,
        })
        setNotice(
          result.terminal
            ? `${definition.title} provisioning is canceled.`
            : `Cancellation of ${definition.title} provisioning is requested; Supraspina waits for provisioning to acknowledge it.`,
        )
        if (result.terminal) void refresh()
      } catch (cause: unknown) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Retry the cancellation request.',
        )
      } finally {
        setCanceling(null)
      }
    },
    [projectRef, refresh, savedCfg, savedRevision],
  )

  return (
    <>
      <section
        role="group"
        aria-label="Scientific resources"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          // The panel follows the environment checks on Diagnostics.
          margin: '24px 0 16px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              minWidth: 0,
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            {/* A page-level section heading takes the serif display face;
                card titles and dividers stay sans. */}
            <h2
              style={{
                margin: 0,
                color: t.textStrong,
                fontFamily: FONTS.serif,
                fontSize: 16,
                fontWeight: 400,
              }}
            >
              Scientific resources
            </h2>
            <InfoTip
              t={t}
              text="Container images (SIF files) are stored on this computer, outside the app. Download needs Apptainer; importing a file does not."
              label="About scientific resources"
            />
          </div>
          <Chip
            t={t}
            status={
              !showStatusPlaceholder && readyCount === RESOURCES.length
                ? 'done'
                : 'warn'
            }
            label={
              showStatusPlaceholder
                ? dirty
                  ? 'save to check'
                  : 'waiting to check'
                : `${readyCount}/${RESOURCES.length} ready`
            }
          />
          <RefreshButton
            t={t}
            ariaLabel="Refresh scientific resources"
            title={statusBlockedMessage ?? 'Refresh scientific resources'}
            disabled={statusBlockedMessage !== null}
            busy={loading}
            busyLabel="Refreshing scientific resources..."
            onClick={() => void refresh()}
          />
        </div>

        {error && (
          <div role="alert" style={{ color: t.failed, fontSize: 12 }}>
            {error}
          </div>
        )}
        {notice && (
          <div
            role="status"
            aria-live="polite"
            style={{ color: t.text, fontSize: 12 }}
          >
            {notice}
          </div>
        )}
        {runtime && (
          <article
            aria-labelledby="scientific-resources-runtime"
            style={{
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <h3
                id="scientific-resources-runtime"
                style={{
                  margin: 0,
                  color: t.textStrong,
                  fontFamily: FONTS.sans,
                  fontSize: 12.5,
                }}
              >
                Apptainer runtime
              </h3>
              <span
                style={{
                  color: t.dim,
                  fontFamily: FONTS.sans,
                  fontSize: 11,
                  overflowWrap: 'anywhere',
                  minWidth: 0,
                }}
              >
                <CodeText
                  text={runtimeEvidence(runtime)}
                  code={runtimeVersions(runtime)}
                />
              </span>
              <Chip
                t={t}
                status={runtime.ready ? 'done' : 'warn'}
                label={runtime.ready ? 'Ready' : 'Not ready'}
                title={runtimeExpectation(runtime)}
                small
              />
              {!runtime.ready && (
                <Btn
                  t={t}
                  small
                  ghost
                  label="Open Apptainer releases"
                  ariaLabel="Open the Apptainer releases download page"
                  onClick={openApptainerReleases}
                />
              )}
            </div>
            {runtime.detail && (
              <span role="status" style={{ color: t.text, fontSize: 11 }}>
                <CodeText
                  text={runtime.detail}
                  code={runtimeVersions(runtime)}
                />
              </span>
            )}
          </article>
        )}
        {!showStatusPlaceholder &&
          !(loading && Object.keys(statuses).length === 0) &&
          operationGate && (
            <GateNotice
              t={t}
              gate={operationGate}
              onEnableSafeExecution={
                onSafeExecutionChange
                  ? () => onSafeExecutionChange(true)
                  : undefined
              }
              onSave={() => saveProject()}
            />
          )}
        {showStatusPlaceholder && projectRef && dirty ? (
          // Offer the save the disabled refresh waits for.
          <GateNotice
            t={t}
            gate={{
              kind: 'unsaved',
              action: 'check scientific resources',
              reason: 'Save the project to check scientific resources.',
            }}
            onSave={() => saveProject()}
          />
        ) : showStatusPlaceholder ? (
          <div role="status" style={{ color: t.dim, fontSize: 12 }}>
            {statusBlockedMessage}
          </div>
        ) : loading && Object.keys(statuses).length === 0 ? (
          <LoadingState t={t} label="Checking scientific resources..." />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
              gap: 10,
            }}
          >
            {RESOURCES.map((definition) => {
              const resourceKey = keyOf(definition.selector)
              const status = statuses[resourceKey] ?? fallbackStatus(definition)
              const active = status.cancellable
              const gated = operationGate !== null
              const unavailable = status.state === 'unavailable'
              return (
                <article
                  key={resourceKey}
                  style={{
                    minWidth: 0,
                    padding: 'var(--ss-card-pad)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    border: `1px solid ${t.border}`,
                    borderRadius: 6,
                    background: t.surface2,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <h3
                        style={{
                          margin: 0,
                          color: t.textStrong,
                          fontFamily: FONTS.sans,
                          fontSize: 12.5,
                        }}
                      >
                        {definition.title}
                      </h3>
                      <span
                        style={{
                          color: t.dim,
                          fontFamily: FONTS.mono,
                          fontSize: 10.5,
                        }}
                      >
                        v{status.version}
                      </span>
                    </div>
                    <Chip
                      t={t}
                      status={resourceStatusChip(status)}
                      label={resourceStatusLabel(status)}
                      small
                    />
                  </div>
                  <Hint t={t}>{definition.description}</Hint>
                  {status.phase !== 'idle' && (
                    <div
                      role="status"
                      aria-live="polite"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                      }}
                    >
                      <progress
                        max={100}
                        {...(status.percent === null
                          ? {}
                          : { value: status.percent })}
                        aria-label={`${definition.title} progress`}
                        style={{ width: '100%', accentColor: t.accent }}
                      />
                      <StateLine
                        t={t}
                        size={10.5}
                        color={status.phase === 'error' ? t.failed : t.dim}
                      >
                        {status.percent === null
                          ? resourceStatusLabel(status)
                          : `${Math.round(status.percent)}% ${resourceStatusLabel(status)}`}
                      </StateLine>
                    </div>
                  )}
                  {status.error && (
                    <span
                      role="alert"
                      style={{ color: t.failed, fontSize: 11 }}
                    >
                      {status.error}
                    </span>
                  )}
                  <div
                    style={{
                      display: 'flex',
                      gap: 6,
                      flexWrap: 'wrap',
                      marginTop: 'auto',
                    }}
                  >
                    {active ? (
                      <Btn
                        t={t}
                        small
                        danger
                        label={
                          canceling === resourceKey ? 'Canceling...' : 'Cancel'
                        }
                        ariaLabel={`Cancel ${definition.title} provisioning`}
                        disabled={canceling !== null}
                        onClick={() => void cancel(definition, status)}
                      />
                    ) : (
                      <>
                        <Btn
                          t={t}
                          small
                          primary={safeExecution}
                          label="Download"
                          ariaLabel={
                            runtimeBlockReason
                              ? `Provision ${definition.title}, unavailable: ${runtimeBlockReason}`
                              : `Provision ${definition.title}`
                          }
                          disabled={
                            gated || unavailable || runtimeBlockReason !== null
                          }
                          title={
                            unavailable
                              ? 'This resource is not supported on the current platform.'
                              : (operationGate?.reason ??
                                runtimeBlockReason ??
                                undefined)
                          }
                          onClick={() => {
                            setActionError(null)
                            setPending({ kind: 'provision', definition })
                          }}
                        />
                        <Btn
                          t={t}
                          small
                          ghost
                          label="Import file..."
                          ariaLabel={`Import ${definition.title} SIF`}
                          disabled={gated || unavailable}
                          title={
                            unavailable
                              ? 'This resource is not supported on the current platform.'
                              : operationGate?.reason
                          }
                          onClick={() => void chooseOffline(definition)}
                        />
                      </>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
        {projectRef && (
          <BrainChartsResourceCard
            safeExecution={safeExecution}
            operationGate={operationGate}
            report={envReport}
            onRecheck={onEnvRecheck}
          />
        )}
      </section>

      {pending && (
        <ConfirmDialog
          t={t}
          title={
            pending.kind === 'import'
              ? `Confirm import of ${pending.definition.title} SIF`
              : `Confirm provisioning of ${pending.definition.title}`
          }
          message={
            pending.kind === 'import' ? (
              <span>
                Import verifies the selected offline SIF with the same size and
                SHA-256 checks used for downloads before atomic activation, and
                it rejects a partial or tampered image.
              </span>
            ) : (
              <span>
                Provisioning pulls the pinned image by immutable OCI digest with
                the machine&apos;s Apptainer installation, builds the
                reproducible SIF, verifies its exact size and SHA-256, and
                activates it atomically in the machine-local cache.
              </span>
            )
          }
          error={actionError}
          busy={actionBusy}
          onDismiss={() => {
            setPending(null)
            setActionError(null)
          }}
          actions={[
            {
              label: 'Cancel',
              initialFocus: true,
              onSelect: () => {
                setPending(null)
                setActionError(null)
              },
            },
            {
              label:
                pending.kind === 'import'
                  ? 'Authorize import'
                  : 'Authorize provision',
              tone: 'primary',
              disabled: operationGate !== null,
              onSelect: () => void runPending(),
            },
          ]}
        />
      )}
    </>
  )
}
