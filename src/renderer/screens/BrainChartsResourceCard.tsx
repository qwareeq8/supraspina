import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import gplText from '../../../licenses/GPL-3.0.txt?raw'
import type { ProvisionProgress } from '../../shared/contract'
import type { EnvCheck, EnvReport, ProjectRef } from '../../shared/types'
import { getApi } from '../state/api'
import { useApp } from '../state/context'
import { useRuntime } from '../state/runtime-state'
import { Btn, Chip, ConfirmDialog, FONTS, Hint } from '../ui'
import type { InstallGate } from './env/install-gate'
import {
  BRAINCHARTS_CITATION,
  BRAINCHARTS_NOTICE,
  BRAINCHARTS_CHECK_IDS,
  brainChartsReadiness,
} from './env/braincharts-setup'

/** The sidecar's terminal sentence for a setup the operator canceled. */
const CANCELED_MESSAGE = 'BrainCharts setup was canceled.'

/**
 * The BrainCharts operation each project started in this window, so a card
 * that remounts while the setup runs reattaches to it.
 */
const startedOperations = new Map<string, string>()

/** One BrainCharts setup the card follows. */
interface Operation {
  operationId: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  message: string
  percent: number | null
  lastLine: string | null
}

function operationFromProgress(
  operationId: string,
  event: ProvisionProgress,
  lastLine: string | null,
): Operation {
  const status =
    event.phase === 'done'
      ? 'done'
      : event.phase === 'error'
        ? event.message === CANCELED_MESSAGE
          ? 'cancelled'
          : 'error'
        : 'running'
  return {
    operationId,
    status,
    message: event.message,
    percent: event.percent,
    lastLine,
  }
}

/** The props the scientific-resources panel passes to the card. */
export interface BrainChartsResourceCardProps {
  safeExecution: boolean
  /** The panel's Allow live runs and saved-project refusal, or null. */
  operationGate: InstallGate | null
  /**
   * The environment report a host screen already holds (null while it
   * loads). With it the card reads `bcenv` and `bcmodel` from that report and
   * asks the host to recheck after a setup, instead of checking on its own.
   */
  report?: EnvReport | null | undefined
  /** Recheck the host's environment report after a setup finishes. */
  onRecheck?: (() => void) | undefined
}

/**
 * Set up the BrainCharts lifespan model and its runtime from Diagnostics.
 *
 * The license notice comes first; only "Accept and download" authorizes the
 * download, and the request carries `licenseAccepted: true`.
 */
export function BrainChartsResourceCard({
  safeExecution,
  operationGate,
  report,
  onRecheck,
}: BrainChartsResourceCardProps): ReactNode {
  const { t, projectRef, savedRevision, savedCfg, dirty } = useApp()
  const runtime = useRuntime()
  const [ownChecks, setOwnChecks] = useState<EnvCheck[] | null>(null)
  const hostReport = report !== undefined
  const checks =
    report === undefined
      ? ownChecks
      : report === null
        ? null
        : report.groups.flatMap((group) => group.checks)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [licenseOpen, setLicenseOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [canceling, setCanceling] = useState(false)
  const [operation, setOperation] = useState<Operation | null>(null)
  const operationRef = useRef<Operation | null>(null)
  const projectRefRef = useRef<ProjectRef | null>(projectRef)
  // Progress can arrive before provision.braincharts returns its ID.
  const earlyEvents = useRef(new Map<string, ProvisionProgress>())
  const lastLines = useRef(new Map<string, string>())
  const checkRequest = useRef(0)
  // Subscriptions read the latest callbacks without resubscribing, so a host
  // that passes a new onRecheck each render never reorders the listeners.
  const onRecheckRef = useRef(onRecheck)
  const refreshRef = useRef<() => Promise<void>>(async () => undefined)

  // Reattach to a setup this window started that is still running.
  const remembered = projectRef
    ? startedOperations.get(projectRef.projectId)
    : undefined
  const provision = runtime.provision
  const shown: Operation | null =
    operation ??
    (remembered &&
    provision?.phase === 'running' &&
    provision.operationId === remembered
      ? {
          operationId: remembered,
          status: 'running',
          message: 'BrainCharts setup is running.',
          percent: null,
          lastLine: null,
        }
      : null)

  const refreshChecks = useCallback(async (): Promise<void> => {
    const token = checkRequest.current + 1
    checkRequest.current = token
    if (hostReport) {
      onRecheckRef.current?.()
      return
    }
    if (!projectRef || dirty) return
    try {
      const report = await getApi().env.check({
        project: projectRef,
        cfg: savedCfg,
        configRevision: savedRevision,
        ids: [...BRAINCHARTS_CHECK_IDS],
      })
      if (checkRequest.current !== token) return
      setOwnChecks(report.groups.flatMap((group) => group.checks))
      setCheckError(null)
    } catch (cause: unknown) {
      if (checkRequest.current !== token) return
      setCheckError(
        cause instanceof Error
          ? cause.message
          : 'The BrainCharts setup could not be checked.',
      )
    }
  }, [dirty, hostReport, projectRef, savedCfg, savedRevision])

  useLayoutEffect(() => {
    projectRefRef.current = projectRef
    operationRef.current = shown
    onRecheckRef.current = onRecheck
    refreshRef.current = refreshChecks
  })

  useEffect(() => {
    if (hostReport) return
    void Promise.resolve().then(refreshChecks)
    return () => {
      checkRequest.current += 1
    }
  }, [hostReport, refreshChecks])

  useEffect(() => {
    const api = getApi()
    const matches = (event: {
      projectId: string
      projectEpoch: number
    }): boolean => {
      const current = projectRefRef.current
      return (
        current !== null &&
        event.projectId === current.projectId &&
        event.projectEpoch === current.epoch
      )
    }
    const offLog = api.provision.onLog((event) => {
      if (!matches(event)) return
      if (lastLines.current.size > 32) lastLines.current.clear()
      lastLines.current.set(event.operationId, event.line)
      setOperation((current) =>
        current && current.operationId === event.operationId
          ? { ...current, lastLine: event.line }
          : current,
      )
    })
    const offProgress = api.provision.onProgress((event) => {
      if (!matches(event)) return
      const current = operationRef.current
      if (!current || current.operationId !== event.operationId) {
        if (earlyEvents.current.size > 32) earlyEvents.current.clear()
        earlyEvents.current.set(event.operationId, event)
        return
      }
      const next = operationFromProgress(
        event.operationId,
        event,
        lastLines.current.get(event.operationId) ?? current.lastLine,
      )
      operationRef.current = next
      setOperation(next)
      if (next.status !== 'running') void refreshRef.current()
    })
    return () => {
      offLog()
      offProgress()
    }
  }, [])

  const start = useCallback(async (): Promise<void> => {
    const captured = projectRef
    if (!captured || !safeExecution || dirty || starting) return
    setStarting(true)
    setStartError(null)
    try {
      const api = getApi()
      const authorization = await api.execution.authorize({
        project: captured,
        configRevision: savedRevision,
        purpose: 'provision',
      })
      const { operationId } = await api.provision.braincharts({
        project: captured,
        cfg: savedCfg,
        configRevision: savedRevision,
        authorization,
        licenseAccepted: true,
      })
      startedOperations.set(captured.projectId, operationId)
      const early = earlyEvents.current.get(operationId)
      earlyEvents.current.clear()
      const next: Operation = early
        ? operationFromProgress(
            operationId,
            early,
            lastLines.current.get(operationId) ?? null,
          )
        : {
            operationId,
            status: 'running',
            message: 'BrainCharts setup is starting.',
            percent: 0,
            lastLine: null,
          }
      operationRef.current = next
      setOperation(next)
      setLicenseOpen(false)
      if (next.status !== 'running') void refreshChecks()
    } catch (cause: unknown) {
      setStartError(
        cause instanceof Error
          ? cause.message
          : 'BrainCharts setup could not start.',
      )
    } finally {
      setStarting(false)
    }
  }, [
    dirty,
    projectRef,
    refreshChecks,
    safeExecution,
    savedCfg,
    savedRevision,
    starting,
  ])

  const cancel = useCallback(async (): Promise<void> => {
    const current = operationRef.current
    if (!projectRef || !current || current.status !== 'running') return
    setCanceling(true)
    try {
      const result = await getApi().provision.cancel({
        project: projectRef,
        operationId: current.operationId,
      })
      if (!result.accepted && !result.terminal) {
        setStartError('The cancellation was not accepted; the setup continues.')
      }
    } catch (cause: unknown) {
      setStartError(
        cause instanceof Error ? cause.message : 'The cancellation failed.',
      )
    } finally {
      setCanceling(false)
    }
  }, [projectRef])

  const readiness = brainChartsReadiness(checks)
  const running = shown?.status === 'running'
  const blockedReason = !projectRef
    ? 'Open a saved project to set up BrainCharts.'
    : readiness.unavailable
      ? (readiness.detail ??
        'The BrainCharts runtime is available on Linux x86_64 only.')
      : (operationGate?.reason ?? null)

  return (
    <>
      <article
        aria-labelledby="braincharts-resource-title"
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
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3
              id="braincharts-resource-title"
              style={{
                margin: 0,
                color: t.textStrong,
                fontFamily: FONTS.sans,
                fontSize: 12.5,
              }}
            >
              BrainCharts lifespan model
            </h3>
            <span
              style={{
                color: t.dim,
                fontFamily: FONTS.mono,
                fontSize: 10.5,
                overflowWrap: 'anywhere',
              }}
            >
              lifespan_57K_82sites, pcntoolkit 0.35.0, GPL-3.0
            </span>
          </div>
          <Chip
            t={t}
            status={running ? 'running' : readiness.chip}
            label={running ? 'Setting up' : readiness.label}
            small
          />
        </div>
        <Hint t={t}>Normative z-scores per region. Linux x86_64 only.</Hint>
        {readiness.detail && !running && (
          <span style={{ color: t.text, fontSize: 11 }}>
            {readiness.detail}
          </span>
        )}
        {checkError && (
          <span role="alert" style={{ color: t.failed, fontSize: 11 }}>
            {checkError}
          </span>
        )}
        {shown && (
          <div
            role="status"
            aria-live="polite"
            style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            {running && (
              <progress
                max={100}
                {...(shown.percent === null ? {} : { value: shown.percent })}
                aria-label="BrainCharts setup progress"
                style={{ width: '100%', accentColor: t.accent }}
              />
            )}
            <span
              style={{
                color: shown.status === 'error' ? t.failed : t.text,
                fontSize: 11,
              }}
            >
              {shown.percent === null || !running
                ? shown.message
                : `${Math.round(shown.percent)}% ${shown.message}`}
            </span>
            {running && shown.lastLine && (
              <span
                style={{
                  color: t.dim,
                  fontFamily: FONTS.mono,
                  fontSize: 10.5,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={shown.lastLine}
              >
                {shown.lastLine}
              </span>
            )}
          </div>
        )}
        {startError && !licenseOpen && (
          <span role="alert" style={{ color: t.failed, fontSize: 11 }}>
            {startError}
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
          {running ? (
            <Btn
              t={t}
              small
              danger
              label={canceling ? 'Canceling...' : 'Cancel'}
              ariaLabel="Cancel BrainCharts setup"
              disabled={canceling}
              onClick={() => void cancel()}
            />
          ) : readiness.chip === 'done' ? (
            <Btn
              t={t}
              small
              ghost
              label="Recheck BrainCharts"
              disabled={!projectRef || dirty}
              onClick={() => void refreshChecks()}
            />
          ) : (
            <Btn
              t={t}
              small
              primary={safeExecution}
              label="Download"
              ariaLabel="Download from GitHub"
              disabled={blockedReason !== null}
              title={
                blockedReason ??
                'Downloads the model (2.8 MB) from GitHub and builds a runtime of about 2 GB in the project output directory.'
              }
              onClick={() => {
                setStartError(null)
                setLicenseOpen(true)
              }}
            />
          )}
        </div>
      </article>

      {licenseOpen && (
        <ConfirmDialog
          t={t}
          title="BrainCharts license notice"
          message={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span>
                The BrainCharts model and the pcntoolkit runtime are licensed
                under the GNU General Public License version 3 (GPL-3.0).
                Supraspina does not bundle them: this setup downloads them from
                their official sources into this project&apos;s output
                directory.
              </span>
              <div>
                <strong style={{ color: t.textStrong }}>
                  Repository NOTICE
                </strong>
                <pre
                  style={{
                    margin: '4px 0 0',
                    padding: 8,
                    borderRadius: 4,
                    background: t.surface2,
                    border: `1px solid ${t.border}`,
                    fontFamily: FONTS.mono,
                    fontSize: 11,
                    whiteSpace: 'pre-wrap',
                    color: t.text,
                  }}
                >
                  {BRAINCHARTS_NOTICE}
                </pre>
              </div>
              <div>
                <strong style={{ color: t.textStrong }}>Citation</strong>
                <div style={{ marginTop: 4 }}>{BRAINCHARTS_CITATION}</div>
              </div>
              <details>
                <summary style={{ cursor: 'pointer', color: t.textStrong }}>
                  GPL-3.0 license text
                </summary>
                <pre
                  aria-label="GPL-3.0 license text"
                  tabIndex={0}
                  style={{
                    margin: '6px 0 0',
                    padding: 8,
                    maxHeight: 220,
                    overflowY: 'auto',
                    borderRadius: 4,
                    background: t.surface2,
                    border: `1px solid ${t.border}`,
                    fontFamily: FONTS.mono,
                    fontSize: 10.5,
                    whiteSpace: 'pre-wrap',
                    color: t.text,
                  }}
                >
                  {gplText}
                </pre>
              </details>
            </div>
          }
          footnote={
            operationGate
              ? operationGate.reason
              : 'Accepting starts the download from GitHub and the runtime build.'
          }
          error={startError}
          busy={starting}
          onDismiss={() => {
            setLicenseOpen(false)
            setStartError(null)
          }}
          actions={[
            {
              label: 'Cancel',
              initialFocus: true,
              onSelect: () => {
                setLicenseOpen(false)
                setStartError(null)
              },
            },
            {
              label: 'Accept and download',
              tone: 'primary',
              disabled: operationGate !== null || !safeExecution,
              describedByFootnote: operationGate !== null,
              onSelect: () => void start(),
            },
          ]}
        />
      )}
    </>
  )
}
