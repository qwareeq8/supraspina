/**
 * Verifies external dependencies, groups and filters their checks, recommends
 * the highest-priority fix, and gates every installation behind Allow live runs.
 * Accepts shell-owned state and actions, or falls back to {@link getApi}.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import {
  Btn,
  Card,
  ConfirmDialog,
  RefreshButton,
  Chip,
  ChipGlyph,
  Code,
  EmptyState as EmptyStateAtom,
  ErrorState,
  FONTS,
  Hint,
  Ico,
  ICONS,
  ICON_SIZE,
  InfoTip,
  LoadingState,
  Page,
  formatRunTime,
  statusColor,
  statusSoft,
  STATUS_LABEL,
  type Theme,
} from '../ui'
import { useApp } from '../state/context'
import { getApi } from '../state/api'
import type { EnvApplicability } from '../state/env-applicability'
import { envApplicability, requiredCheckIds } from '../state/env-applicability'
import { effectiveEnigmaBackend } from '../state/stage-blockers'
import { useCopyFeedback } from '../state/useCopyFeedback'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { ProjectConfig } from '../../shared/project-schema'
import { consequenceFor } from '../../shared/help'
import type {
  EnvCheck,
  EnvCreateDirResult,
  EnvGroup,
  EnvReport,
  ProjectRef,
} from '../../shared/types'
import {
  GateNotice,
  GroupSection,
  PybrainageSetupDialog,
  PybrainageSetupProgress,
  ScientificAssetsRebuild,
  applyProvisionedPaths,
  buildInstallPlan,
  detectedRuntime,
  groupCountSummary,
  groupSignature,
  installGate,
  needsAttention,
  offlineAssetRebuild,
  pickTopFix,
  reportSummary,
  rollupGroup,
  rollupLabel,
  seedExpansion,
  statusMeaning,
  useEnvInstall,
  usePybrainageSetup,
  VERDICT_ORDER,
} from './env'
import { ScientificResourcesPanel } from './ScientificResourcesPanel'

/**
 * Generous interpreter cold-start time allowed before treating an unanswered
 * environment check as stalled.
 */
const STALLED_CHECK_MS = 45_000

/** The plain-language name of each ENIGMA QC execution backend. */
const BACKEND_NAMES: Record<'matlab' | 'mcr', string> = {
  matlab: 'source MATLAB',
  mcr: 'MATLAB Runtime',
}

/**
 * Describe the ENIGMA QC backend the saved configuration selects.
 *
 * A pinned `matlab` or `mcr` choice names its backend immediately, before any
 * environment report exists. Automatic selection names no backend until a
 * report resolves one, because the resolution depends on what the host has.
 *
 * @param resolved - The resolved backend, or null while it is unknown.
 */
function backendSelectionLabel(
  configured: string,
  resolved: 'matlab' | 'mcr' | null,
): string {
  if (configured === 'matlab' || configured === 'mcr')
    return `Selected backend: ${BACKEND_NAMES[configured]}`
  if (!resolved) return 'Selected backend: auto (not checked yet)'
  return `Selected backend: auto, resolves to ${BACKEND_NAMES[resolved]}`
}

/** Project and environment state for Diagnostics. */
export interface DiagnosticsScreenProps {
  cfg?: ProjectConfig
  report?: EnvReport
  safeExecution?: boolean
  onSafeExecutionChange?: (next: boolean) => void
  refresh?: () => void
  /**
   * Receive every completed project-scoped report so the shell's run gate
   * reads the environment the operator just repaired, not the report taken
   * when the project opened.
   */
  onReport?: (report: EnvReport) => void
}

/** Render environment diagnostics and gated repair actions. */
export function DiagnosticsScreen(
  props: DiagnosticsScreenProps = {},
): ReactNode {
  const { projectRef, projectEpoch, configRevision } = useApp()
  const identity = `${projectEpoch}:${projectRef?.projectId ?? 'none'}:${configRevision}`
  return <DiagnosticsScreenContent key={identity} {...props} />
}

function DiagnosticsScreenContent(props: DiagnosticsScreenProps): ReactNode {
  const {
    t,
    projectRef,
    configRevision,
    savedRevision,
    savedCfg,
    dirty,
    cfg: appCfg,
    setCfg,
    setRoute,
    refreshToolStatus,
    refreshHostState,
    saveProject,
  } = useApp()
  const { onSafeExecutionChange, refresh, onReport } = props
  const safeExecution = props.safeExecution ?? false
  // Offer the controls that enable a gated operation beside every refusal, so
  // the operator never has to find them elsewhere on the screen.
  const enableSafeExecution = onSafeExecutionChange
    ? () => onSafeExecutionChange(true)
    : undefined
  const saveForGate = useCallback(() => saveProject(), [saveProject])

  const cfg = useMemo<ProjectConfig>(
    () => props.cfg ?? appCfg ?? DEFAULT_PROJECT_CONFIG,
    [props.cfg, appCfg],
  )
  const latestIdentityRef = useRef<{
    projectRef: ProjectRef | null
    configRevision: number
    savedRevision: number
  } | null>(null)
  const checkRequestRef = useRef(0)

  useLayoutEffect(() => {
    latestIdentityRef.current = { projectRef, configRevision, savedRevision }
    return () => {
      latestIdentityRef.current = null
    }
  }, [projectRef, configRevision, savedRevision])

  const [fetched, setFetched] = useState<EnvReport | null>(null)
  const [loading, setLoading] = useState(props.report === undefined)
  // Track whether the in-flight check has outlived any plausible cold start.
  const [checkStalled, setCheckStalled] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const { copiedKey: copied, copy: copyFeedback } = useCopyFeedback(1600)
  const [pendingInstall, setPendingInstall] = useState<EnvCheck | null>(null)
  const [creatingDir, setCreatingDir] = useState<string | null>(null)
  const [createOutcomes, setCreateOutcomes] = useState<
    Record<string, EnvCreateDirResult>
  >({})
  const [pendingCreateDir, setPendingCreateDir] = useState<EnvCheck | null>(
    null,
  )
  const setup = usePybrainageSetup({
    safeExecution,
    onApplyProvisioned: (capturedCfg, paths) =>
      setCfg(applyProvisionedPaths(capturedCfg, paths)),
    onFinalized: refresh,
  })

  // Prefer a shell-provided report during render. Avoid prop-to-state mirroring.
  const report = props.report ?? fetched

  // Derive one pipeline-aware requirement projection and read every rollup,
  // count, plan, and recommendation from it.
  const applicability = useMemo<EnvApplicability>(
    () => (report ? envApplicability(report, cfg) : new Map()),
    [report, cfg],
  )

  // Expand groups with required failures and collapse the rest. Re-expand a
  // group when a recheck changes its rollup to failing.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    seedExpansion(report?.groups ?? [], applicability),
  )
  const seededSig = useRef(groupSignature(report?.groups ?? [], applicability))
  const currentSig = groupSignature(report?.groups ?? [], applicability)
  if (currentSig !== seededSig.current) {
    seededSig.current = currentSig
    setExpanded(seedExpansion(report?.groups ?? [], applicability))
  }

  const runCheck = useCallback(async (): Promise<void> => {
    const captured = projectRef
    const capturedRevision = configRevision
    const requestToken = checkRequestRef.current + 1
    checkRequestRef.current = requestToken
    setLoading(true)
    setError(null)
    try {
      // Without a project, run the host-scoped check: read-only probes with
      // no config; project-scoped checks report as skipped.
      const next = captured
        ? await getApi().env.check({
            project: captured,
            cfg,
            configRevision: capturedRevision,
          })
        : await getApi().env.check({})
      const latest = latestIdentityRef.current
      if (
        checkRequestRef.current !== requestToken ||
        latest?.configRevision !== capturedRevision ||
        latest.projectRef?.projectId !== captured?.projectId ||
        latest.projectRef?.epoch !== captured?.epoch
      ) {
        return
      }
      setFetched(next)
      if (captured) onReport?.(next)
      // Refresh shell-owned environment state after disk changes so top-bar
      // status cannot contradict this report.
      refreshToolStatus()
    } catch (err) {
      const latest = latestIdentityRef.current
      if (
        checkRequestRef.current === requestToken &&
        latest?.configRevision === capturedRevision &&
        latest.projectRef?.projectId === captured?.projectId &&
        latest.projectRef?.epoch === captured?.epoch
      ) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      const latest = latestIdentityRef.current
      if (
        checkRequestRef.current === requestToken &&
        latest?.configRevision === capturedRevision &&
        latest.projectRef?.projectId === captured?.projectId &&
        latest.projectRef?.epoch === captured?.epoch
      ) {
        setLoading(false)
      }
    }
  }, [cfg, configRevision, projectRef, refreshToolStatus, onReport])

  // Fetch only when the shell omits a report.
  useEffect(() => {
    if (props.report !== undefined) return
    void runCheck()
  }, [props.report, runCheck])

  // Mark a check as stalled once it has run well past any honest cold start, so
  // the spinner stops being the whole story.
  useEffect(() => {
    if (!loading) {
      setCheckStalled(false)
      return undefined
    }
    const timer = window.setTimeout(
      () => setCheckStalled(true),
      STALLED_CHECK_MS,
    )
    return () => window.clearTimeout(timer)
  }, [loading])

  const recoverRuntime = useCallback(async (): Promise<void> => {
    setRecovering(true)
    setError(null)
    try {
      await getApi().host.retrySidecar()
      refreshHostState()
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Retry recovering the scientific runtime.',
      )
    } finally {
      setRecovering(false)
    }
    await runCheck()
  }, [refreshHostState, runCheck])

  const copy = useCallback(
    async (text: string, token: string): Promise<void> => {
      const ok = await copyFeedback(token, text)
      if (!ok)
        setError('Grant clipboard permission, then copy the command again.')
    },
    [copyFeedback],
  )

  const openExternal = useCallback((url: string): void => {
    // Report a refused destination instead of leaving the control silent.
    getApi()
      .external.openWeb({ url, purpose: 'download' })
      .catch(() => {
        setError('Open this download link manually; Supraspina refused it.')
      })
  }, [])

  const chooseFreesurferHome = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const picked = await getApi().fs.chooseDir({})
      if (!picked) return
      setCfg({
        ...cfg,
        tools: { ...cfg.tools, freesurferHome: picked },
      })
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      setError(`Choose the FreeSurfer installation root again: ${detail}`)
    }
  }, [cfg, setCfg])

  const chooseFreesurferLicense = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      // FreeSurfer reads license.txt or .license; All files reaches a
      // license saved under any other name. The Linux dialog still hides
      // .license, a dotfile, until Ctrl+H and ignores showHiddenFiles, so
      // the license hint states that instead.
      const picked = await getApi().fs.chooseFile({
        filters: [
          { name: 'FreeSurfer license', extensions: ['txt', 'license'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
      if (!picked) return
      setCfg({
        ...cfg,
        tools: { ...cfg.tools, freesurferLicense: picked },
      })
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      setError(`Choose the FreeSurfer license again: ${detail}`)
    }
  }, [cfg, setCfg])

  const setEnigmaParam = useCallback(
    (name: 'matlabExecutable' | 'mcrRoot', value: string): void => {
      setCfg({
        ...cfg,
        steps: {
          ...cfg.steps,
          enigma: {
            ...cfg.steps.enigma,
            params: { ...cfg.steps.enigma.params, [name]: value },
          },
        },
      })
    },
    [cfg, setCfg],
  )

  const chooseMatlabExecutable = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const picked = await getApi().fs.chooseFile({})
      if (!picked) return
      setEnigmaParam('matlabExecutable', picked)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      setError(`Choose the MATLAB executable again: ${detail}`)
    }
  }, [setEnigmaParam])

  const chooseMcrRoot = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const picked = await getApi().fs.chooseDir({})
      if (!picked) return
      setEnigmaParam('mcrRoot', picked)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      setError(`Choose the MATLAB Runtime root again: ${detail}`)
    }
  }, [setEnigmaParam])

  // Require Allow live runs, a saved configuration, and explicit confirmation
  // before every opt-in install. The sidecar owns the running installation and
  // reports it; reprobe the environment once it succeeds.
  const install = useEnvInstall({
    safeExecution,
    request: { cfg: savedCfg, configRevision: savedRevision },
    blocked: dirty,
    onInstalled: () => {
      void runCheck()
    },
  })

  /**
   * Require Allow live runs, a saved configuration, and explicit confirmation
   * before the typed create-directory action. Send only the check id; the
   * sidecar derives the path from the saved configuration.
   */
  const createDir = useCallback(
    async (check: EnvCheck): Promise<void> => {
      if (!safeExecution || !projectRef || dirty) return
      const captured = projectRef
      const capturedRevision = savedRevision
      setCreatingDir(check.id)
      try {
        const authorization = await getApi().execution.authorize({
          project: captured,
          configRevision: capturedRevision,
          purpose: 'opt-in-install',
        })
        const res = await getApi().env.createOutputDir({
          project: captured,
          cfg: savedCfg,
          configRevision: capturedRevision,
          checkId: check.id,
          authorization,
        })
        const latest = latestIdentityRef.current
        if (
          latest?.savedRevision === capturedRevision &&
          latest.projectRef?.projectId === captured.projectId &&
          latest.projectRef.epoch === captured.epoch
        ) {
          setCreateOutcomes((prev) => ({ ...prev, [check.id]: res }))
          if (res.ok) await runCheck()
        }
      } catch (err) {
        const latest = latestIdentityRef.current
        if (
          latest?.savedRevision === capturedRevision &&
          latest.projectRef?.projectId === captured.projectId &&
          latest.projectRef.epoch === captured.epoch
        ) {
          setCreateOutcomes((prev) => ({
            ...prev,
            [check.id]: {
              ok: false,
              detail: err instanceof Error ? err.message : String(err),
            },
          }))
        }
      } finally {
        const latest = latestIdentityRef.current
        if (
          latest?.savedRevision === capturedRevision &&
          latest.projectRef?.projectId === captured.projectId &&
          latest.projectRef.epoch === captured.epoch
        ) {
          setCreatingDir(null)
        }
      }
    },
    [safeExecution, projectRef, dirty, savedRevision, savedCfg, runCheck],
  )

  const summary = reportSummary(report, applicability)
  const groups = useMemo(() => report?.groups ?? [], [report])
  // Read the pinned backend from the saved parameter instead of the resolved
  // one, so the selection marker cannot follow a default before the first
  // report and then move once the result arrives. Automatic selection has no
  // selected backend until a report resolves it.
  const configuredBackend = String(cfg.steps.enigma.params['backend'] ?? 'auto')
  const pinnedBackend =
    configuredBackend === 'matlab' || configuredBackend === 'mcr'
      ? configuredBackend
      : null
  const enigmaBackend =
    pinnedBackend ?? (report ? effectiveEnigmaBackend(cfg, report) : null)
  const backendSelection = backendSelectionLabel(
    configuredBackend,
    enigmaBackend,
  )
  const matlabExecutableConfigured =
    String(cfg.steps.enigma.params['matlabExecutable'] ?? '').trim().length > 0
  const mcrRootConfigured =
    String(cfg.steps.enigma.params['mcrRoot'] ?? '').trim().length > 0
  // Mirror the sidecar backend rule: a backend is ready only when its check
  // reports exactly `found`; the unselected backend is reported as `skipped`.
  const backendStatus = useMemo(() => {
    const status = new Map<string, EnvCheck['status']>()
    for (const group of report?.groups ?? []) {
      for (const check of group.checks) status.set(check.id, check.status)
    }
    return status
  }, [report])
  // Report the runtime the probe resolved on its own, because a blank
  // `mcrRoot` still runs against a runtime found in a default location or on
  // PATH. Only an undetected runtime is genuinely unconfigured.
  const detectedMcr = useMemo(() => {
    for (const group of report?.groups ?? [])
      for (const check of group.checks)
        if (check.id === 'mcr') return detectedRuntime(check)
    return null
  }, [report])
  const mcrRootLabel = mcrRootConfigured
    ? 'Configured'
    : detectedMcr === null
      ? 'Not configured'
      : detectedMcr.path
        ? `Detected at ${detectedMcr.path}${
            detectedMcr.version ? ` (${detectedMcr.version})` : ''
          }`
        : 'Detected (default location)'

  const backendChip = (id: 'matlab' | 'mcr', name: string): ReactNode => {
    const selected = enigmaBackend === id
    const status = backendStatus.get(id)
    const ready = status === 'found'
    const readiness =
      status === undefined ? 'not checked' : ready ? 'ready' : 'not ready'
    return (
      <Chip
        t={t}
        status={
          status === undefined
            ? 'skipped'
            : ready
              ? 'found'
              : selected
                ? 'missing'
                : 'skipped'
        }
        label={`${name}${selected ? ' (selected)' : ''}: ${readiness}`}
      />
    )
  }
  // List the groups that need attention first so a failing check shows
  // without scrolling. The report and the install plan keep their own order.
  const orderedGroups = useMemo(() => {
    const rank = { missing: 0, warn: 1, found: 2 } as const
    return groups
      .map((group, index) => ({
        group,
        index,
        rank: rank[rollupGroup(group, applicability)],
      }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.group)
  }, [groups, applicability])
  const visibleGroups = useMemo(
    () =>
      activeGroup
        ? orderedGroups.filter((g) => g.name === activeGroup)
        : orderedGroups,
    [orderedGroups, activeGroup],
  )

  const toggleGroup = useCallback((name: string): void => {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }))
  }, [])

  /**
   * Open a group when activating its filter. Clear the active filter on a second
   * click without changing disclosure state.
   */
  const onFilterToggle = useCallback(
    (name: string): void => {
      const activating = activeGroup !== name
      setActiveGroup(activating ? name : null)
      if (activating) {
        setExpanded((prev) => (prev[name] ? prev : { ...prev, [name]: true }))
      }
    },
    [activeGroup],
  )
  // Offer the dedicated provisioning flow for PyBrainAge environment or model
  // failures.
  const needsPybrainage = useMemo(() => {
    const ids = new Set(['pyenv', 'modelfile', 'scalerfile'])
    for (const group of report?.groups ?? []) {
      for (const check of group.checks) {
        if (ids.has(check.id) && needsAttention(check, applicability))
          return true
      }
    }
    return false
  }, [applicability, report])

  // Offer the offline rebuild of the acquired scientific assets as one
  // prominent action; its row keeps the same flow further down.
  const assetRebuild = useMemo(() => offlineAssetRebuild(report), [report])
  const rebuildRunning =
    assetRebuild !== null && install.running === assetRebuild.check.id
  const rebuildGate =
    assetRebuild && !rebuildRunning
      ? installGate({
          action: 'rebuild the scientific assets',
          projectOpen: projectRef !== null,
          safeExecution,
          dirty,
          busy: install.running !== null,
        })
      : null
  // Report the rebuild's progress in its card only, so one operation never
  // announces itself twice.
  const rowInstalls = useMemo(() => {
    if (!assetRebuild) return install.states
    const { [assetRebuild.check.id]: _shownInCard, ...rest } = install.states
    void _shownInCard
    return rest
  }, [assetRebuild, install.states])
  const setupRunning = setup.state?.status === 'running'
  const setupGate = setupRunning
    ? null
    : installGate({
        action: 'set up PyBrainAge',
        projectOpen: projectRef !== null,
        safeExecution,
        dirty,
        busy: false,
      })

  const installPlan = useMemo(
    () => buildInstallPlan(report, applicability),
    [applicability, report],
  )
  const hasInstallPlan = installPlan.trim().length > 0
  // Name the top issue in the callout; its grouped row owns the actions.
  const topFix = useMemo(() => {
    if (!report) return undefined
    return pickTopFix(report, requiredCheckIds(applicability))
  }, [applicability, report])

  // Reveal and expand the owning group, then move focus onto the check row.
  const showCheck = useCallback(
    (check: EnvCheck): void => {
      const owner = groups.find((group) =>
        group.checks.some((entry) => entry.id === check.id),
      )
      if (owner) {
        // A group filter for another group would hide the row; clear it.
        setActiveGroup((current) => (current === owner.name ? current : null))
        setExpanded((prev) => ({ ...prev, [owner.name]: true }))
      }
      window.requestAnimationFrame(() => {
        const row = document.getElementById(`env-check-${check.id}`)
        if (!row) return
        if (typeof row.scrollIntoView === 'function') {
          row.scrollIntoView({ block: 'center' })
        }
        row.focus()
      })
    },
    [groups],
  )

  // Match the shared header refresh affordance. Reserve the labeled Re-check
  // action for places where rerunning the probes is the primary action.
  const recheckBtn = (
    <RefreshButton
      t={t}
      ariaLabel="Re-check environment"
      title="Re-check environment"
      busy={loading}
      busyLabel="Checking the environment..."
      onClick={() => {
        refresh?.()
        void runCheck()
      }}
    />
  )

  const capturedAt = report?.capturedAt ?? null

  const header = (
    <>
      <Chip t={t} status={summary.status} label={summary.label} />
      {capturedAt && (
        <span
          aria-live="polite"
          title={capturedAt}
          style={{
            fontFamily: FONTS.sans,
            fontSize: 11,
            color: t.dim,
            whiteSpace: 'nowrap',
          }}
        >
          Last updated {formatRunTime(capturedAt)}
        </span>
      )}
      {recheckBtn}
    </>
  )

  return (
    <Page t={t} title="Diagnostics" right={header}>
      {!projectRef && (
        <Card t={t} style={{ marginBottom: 16 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{ fontFamily: FONTS.sans, fontSize: 12.5, color: t.text }}
            >
              No project is open. Supraspina reports host-level tools now;
              project-scoped checks and configuration panels activate after you
              create or open a project.
            </span>
            <span style={{ flex: 1 }} />
            <Btn
              t={t}
              small
              label="Back to Setup"
              icon={<Ico d={ICONS.chevron} size={ICON_SIZE.nav} />}
              onClick={() => setRoute('wizard')}
            />
          </div>
        </Card>
      )}
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorState t={t} title={error} onRetry={() => void runCheck()} />
        </div>
      )}

      {loading && !report ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <LoadingState t={t} label="Checking the environment..." block />
          {/* Treat this unanswered check as stalled. Offer runtime recovery explicitly. */}
          {checkStalled && (
            <ErrorState
              t={t}
              title="The environment check is not responding."
              detail="Every check runs in the scientific runtime. Recover the runtime if it does not answer."
              onRetry={() => void recoverRuntime()}
              retryLabel={
                recovering ? 'Recovering the runtime...' : 'Recover runtime'
              }
            />
          )}
        </div>
      ) : groups.length === 0 ? (
        <EmptyStateAtom
          t={t}
          icon="doctor"
          message="No checks were reported for this configuration."
          action={
            <Btn
              t={t}
              label="Re-check"
              icon={<Ico d={ICONS.refresh} size={ICON_SIZE.nav} />}
              onClick={() => void runCheck()}
            />
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {topFix ? (
            <RecommendedFix
              t={t}
              check={topFix}
              onShow={() => showCheck(topFix)}
            />
          ) : (
            <AllSatisfiedBanner t={t} />
          )}

          {assetRebuild && (
            <ScientificAssetsRebuild
              t={t}
              rebuild={assetRebuild}
              gate={rebuildGate}
              running={rebuildRunning}
              install={install.states[assetRebuild.check.id]}
              onRebuild={() => setPendingInstall(assetRebuild.check)}
              onEnableSafeExecution={enableSafeExecution}
              onSave={saveForGate}
            />
          )}

          <SummaryBand
            t={t}
            groups={orderedGroups}
            applicability={applicability}
            activeGroup={activeGroup}
            onToggle={onFilterToggle}
          />

          <ActionsBar
            t={t}
            legend={<VerdictLegend t={t} />}
            safeExecution={safeExecution}
            {...(onSafeExecutionChange ? { onSafeExecutionChange } : {})}
            hasInstallPlan={hasInstallPlan}
            planCopied={copied === '__plan__'}
            onCopyPlan={() => void copy(installPlan, '__plan__')}
          />

          {projectRef !== null && needsPybrainage && (
            <div
              role="group"
              aria-label="PyBrainAge setup"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: 'var(--ss-card-pad)',
                borderRadius: 6,
                border: `1px solid ${t.border}`,
                background: t.surface2,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: t.text,
                  }}
                >
                  Set up PyBrainAge
                </span>
                <span style={{ flex: 1 }} />
                <Btn
                  t={t}
                  primary={setupGate === null && !setupRunning}
                  label={
                    setupRunning
                      ? 'Setting up PyBrainAge...'
                      : 'Set up PyBrainAge'
                  }
                  icon={<Ico d={ICONS.env} size={ICON_SIZE.nav} />}
                  disabled={setupGate !== null || setupRunning}
                  {...(setupGate ? { title: setupGate.reason } : {})}
                  onClick={() => setup.setPending(true)}
                />
              </div>
              <span
                style={{ fontFamily: FONTS.sans, fontSize: 11.5, color: t.dim }}
              >
                Creates the pinned PyBrainAge environment and downloads its
                model and scaler (about 108 MB).
              </span>
              {setupGate && (
                <GateNotice
                  t={t}
                  gate={setupGate}
                  onEnableSafeExecution={enableSafeExecution}
                  onSave={saveForGate}
                />
              )}
              {setup.state && (
                <PybrainageSetupProgress t={t} state={setup.state} />
              )}
            </div>
          )}

          <div
            role="group"
            aria-label="Environment check groups"
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            {visibleGroups.map((group) => (
              <GroupSection
                key={group.name}
                t={t}
                group={group}
                applicability={applicability}
                open={expanded[group.name] ?? false}
                onToggle={() => toggleGroup(group.name)}
                safeExecution={safeExecution}
                projectOpen={projectRef !== null}
                dirty={dirty}
                installing={install.running}
                copiedToken={copied}
                installs={rowInstalls}
                actionRunning={creatingDir}
                createOutcomes={createOutcomes}
                onCopyFix={(check) => {
                  if (check.recommendedCmd) {
                    void copy(check.recommendedCmd, check.id)
                  }
                }}
                onGetIt={(check) => {
                  if (check.downloadUrl) {
                    openExternal(check.downloadUrl)
                  }
                }}
                setupRunning={setupRunning}
                onInstall={(check) => setPendingInstall(check)}
                onEnableSafeExecution={enableSafeExecution}
                onSaveProject={saveForGate}
                onAction={(check) => {
                  if (check.action?.kind === 'setup-pybrainage') {
                    setup.setPending(true)
                  } else {
                    setPendingCreateDir(check)
                  }
                }}
              />
            ))}
          </div>
        </div>
      )}
      {pendingInstall && (
        <ConfirmDialog
          t={t}
          title={
            pendingInstall.offlineInstall
              ? `Confirm the rebuild of ${pendingInstall.label}`
              : `Confirm installation of ${pendingInstall.label}`
          }
          message={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span>
                {pendingInstall.offlineInstall
                  ? 'This rebuild runs on this host once authorized. It re-creates the scientific assets from the verified files already on this machine, checks every file against the reviewed SHA-256, and downloads nothing.'
                  : 'This installer command runs on this host once authorized.'}
              </span>
              {pendingInstall.recommendedCmd && (
                <Code
                  t={t}
                  value={pendingInstall.recommendedCmd}
                  kind="command"
                />
              )}
            </div>
          }
          onDismiss={() => setPendingInstall(null)}
          actions={[
            {
              label: 'Cancel',
              initialFocus: true,
              onSelect: () => setPendingInstall(null),
            },
            {
              label: pendingInstall.offlineInstall
                ? 'Authorize rebuild'
                : 'Authorize install',
              tone: 'primary',
              disabled: !safeExecution || !projectRef || dirty,
              onSelect: () => {
                const check = pendingInstall
                setPendingInstall(null)
                install.start(check)
              },
            },
          ]}
        />
      )}
      {pendingCreateDir && (
        <ConfirmDialog
          t={t}
          title={`Confirm directory creation for ${pendingCreateDir.label}`}
          message={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span>
                This creates the output directory on this host. Supraspina
                derives the exact path from the saved project configuration and
                refuses symlinks and existing files. The equivalent command is:
              </span>
              {pendingCreateDir.recommendedCmd && (
                <Code
                  t={t}
                  value={pendingCreateDir.recommendedCmd}
                  kind="command"
                />
              )}
            </div>
          }
          onDismiss={() => setPendingCreateDir(null)}
          actions={[
            {
              label: 'Cancel',
              initialFocus: true,
              onSelect: () => setPendingCreateDir(null),
            },
            {
              label: 'Authorize directory creation',
              tone: 'primary',
              disabled: !safeExecution || !projectRef,
              onSelect: () => {
                const check = pendingCreateDir
                setPendingCreateDir(null)
                void createDir(check)
              },
            },
          ]}
        />
      )}
      {setup.pending && (
        <PybrainageSetupDialog
          t={t}
          cfg={cfg}
          authorizeDisabled={!safeExecution || !projectRef}
          onCancel={() => setup.setPending(false)}
          onAuthorize={() => {
            setup.setPending(false)
            setup.run()
          }}
        />
      )}
      {projectRef && (
        <ScientificResourcesPanel
          safeExecution={safeExecution}
          onSafeExecutionChange={onSafeExecutionChange}
          envReport={report ?? null}
          onEnvRecheck={() => {
            refresh?.()
            void runCheck()
          }}
        />
      )}
      {projectRef && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns:
              'repeat(auto-fit, minmax(min(100%, 420px), 1fr))',
            gap: 16,
            alignItems: 'start',
          }}
        >
          <Card t={t} title="FreeSurfer configuration">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div
                role="group"
                aria-label="FreeSurfer installation root"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: 140, flex: 1 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      color: t.text,
                      fontFamily: FONTS.sans,
                      fontSize: 12.5,
                      fontWeight: 700,
                    }}
                  >
                    Installation root
                    <InfoTip
                      t={t}
                      text="The FreeSurfer 8.x folder. Saved with the project."
                      label="About installation root"
                    />
                  </div>
                </div>
                <Chip
                  t={t}
                  status={
                    cfg.tools.freesurferHome.trim().length > 0
                      ? 'found'
                      : 'missing'
                  }
                  label={
                    cfg.tools.freesurferHome.trim().length > 0
                      ? 'Configured'
                      : 'Not configured'
                  }
                />
                <Btn
                  t={t}
                  small
                  label={
                    cfg.tools.freesurferHome.trim().length > 0
                      ? 'Replace...'
                      : 'Choose...'
                  }
                  ariaLabel={`${
                    cfg.tools.freesurferHome.trim().length > 0
                      ? 'Replace installation root'
                      : 'Choose installation root'
                  } for FreeSurfer`}
                  onClick={() => void chooseFreesurferHome()}
                />
              </div>
              <div
                role="group"
                aria-label="FreeSurfer license configuration"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: 140, flex: 1 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      color: t.text,
                      fontFamily: FONTS.sans,
                      fontSize: 12.5,
                      fontWeight: 700,
                    }}
                  >
                    License file
                    <InfoTip
                      t={t}
                      text="Only the path is saved; Supraspina never reads the license. Press Ctrl+H in the file dialog to show a hidden .license file."
                      label="About license file"
                    />
                  </div>
                </div>
                <Chip
                  t={t}
                  status={
                    cfg.tools.freesurferLicense.trim().length > 0
                      ? 'found'
                      : 'missing'
                  }
                  label={
                    cfg.tools.freesurferLicense.trim().length > 0
                      ? 'Configured'
                      : 'Not configured'
                  }
                />
                <Btn
                  t={t}
                  small
                  label={
                    cfg.tools.freesurferLicense.trim().length > 0
                      ? 'Replace...'
                      : 'Choose...'
                  }
                  ariaLabel={`${
                    cfg.tools.freesurferLicense.trim().length > 0
                      ? 'Replace license file'
                      : 'Choose license file'
                  } for FreeSurfer`}
                  onClick={() => void chooseFreesurferLicense()}
                />
              </div>
            </div>
          </Card>
          <Card t={t} title="ENIGMA QC configuration">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div
                role="group"
                aria-label="ENIGMA QC backend selection and readiness"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: 140, flex: 1 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      color: t.text,
                      fontFamily: FONTS.sans,
                      fontSize: 12.5,
                      fontWeight: 700,
                    }}
                  >
                    Backend
                    <InfoTip
                      t={t}
                      text="Set in the ENIGMA QC step on the Pipeline screen."
                      label="About backend"
                    />
                  </div>
                  <div
                    style={{
                      color: t.dim,
                      fontFamily: FONTS.sans,
                      fontSize: 11,
                      marginTop: 3,
                    }}
                  >
                    {backendSelection}
                  </div>
                </div>
                {backendChip('matlab', 'Source MATLAB')}
                {backendChip('mcr', 'MATLAB Runtime')}
              </div>
              <div
                role="group"
                aria-label="MATLAB executable configuration"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: 140, flex: 1 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      color: t.text,
                      fontFamily: FONTS.sans,
                      fontSize: 12.5,
                      fontWeight: 700,
                    }}
                  >
                    MATLAB executable
                    <InfoTip
                      t={t}
                      text="Leave unset to use matlab on PATH."
                      label="About MATLAB executable"
                    />
                  </div>
                </div>
                <Chip
                  t={t}
                  status={matlabExecutableConfigured ? 'found' : 'skipped'}
                  label={
                    matlabExecutableConfigured ? 'Configured' : 'Detect on PATH'
                  }
                />
                <Btn
                  t={t}
                  small
                  label={
                    matlabExecutableConfigured ? 'Replace...' : 'Choose...'
                  }
                  ariaLabel={`${
                    matlabExecutableConfigured
                      ? 'Replace MATLAB executable'
                      : 'Choose MATLAB executable'
                  } for ENIGMA QC`}
                  onClick={() => void chooseMatlabExecutable()}
                />
              </div>
              <div
                role="group"
                aria-label="MATLAB Runtime root configuration"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: 140, flex: 1 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      color: t.text,
                      fontFamily: FONTS.sans,
                      fontSize: 12.5,
                      fontWeight: 700,
                    }}
                  >
                    MATLAB Runtime root
                    <InfoTip
                      t={t}
                      text="The R2019b (9.7) runtime folder. Leave unset to use a detected one."
                      label="About MATLAB Runtime root"
                    />
                  </div>
                </div>
                <Chip
                  t={t}
                  status={
                    mcrRootConfigured || detectedMcr !== null
                      ? 'found'
                      : 'missing'
                  }
                  label={mcrRootLabel}
                />
                <Btn
                  t={t}
                  small
                  label={mcrRootConfigured ? 'Replace...' : 'Choose...'}
                  ariaLabel={`${
                    mcrRootConfigured
                      ? 'Replace Runtime root'
                      : 'Choose Runtime root'
                  } for ENIGMA QC`}
                  onClick={() => void chooseMcrRoot()}
                />
              </div>
            </div>
          </Card>
        </div>
      )}
    </Page>
  )
}

interface SummaryBandProps {
  t: Theme
  groups: EnvGroup[]
  applicability: EnvApplicability
  activeGroup: string | null
  onToggle: (name: string) => void
}

function SummaryBand({
  t,
  groups,
  applicability,
  activeGroup,
  onToggle,
}: SummaryBandProps): ReactNode {
  return (
    <div
      role="group"
      aria-label="Filter checks by group"
      style={{
        display: 'grid',
        // Size a tile to hold its status and counts on at most two lines.
        gridTemplateColumns: `repeat(auto-fill, minmax(${SUMMARY_TILE_MIN_WIDTH}px, 1fr))`,
        gap: 8,
      }}
    >
      {groups.map((group) => (
        <SummaryTile
          key={group.name}
          t={t}
          group={group}
          applicability={applicability}
          active={activeGroup === group.name}
          onToggle={onToggle}
        />
      ))}
    </div>
  )
}

/**
 * Narrowest width in CSS pixels of a group summary tile. It holds "All required
 * dependencies satisfied" on one line above the check counts.
 */
const SUMMARY_TILE_MIN_WIDTH = 240

interface SummaryTileProps {
  t: Theme
  group: EnvGroup
  applicability: EnvApplicability
  active: boolean
  onToggle: (name: string) => void
}

function SummaryTile({
  t,
  group,
  applicability,
  active,
  onToggle,
}: SummaryTileProps): ReactNode {
  const [hover, setHover] = useState(false)
  const roll = rollupGroup(group, applicability)
  const color = statusColor(t, roll)
  const label = active
    ? `Clear filter (${group.name})`
    : `Show only ${group.name}`
  // Lift an unselected tile on hover so that it reads as clickable.
  const background = active
    ? statusSoft(t, roll)
    : hover
      ? t.surface2
      : t.surface
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      onClick={() => onToggle(group.name)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={label}
      style={{
        // Fill the stretched grid cell so that every tile has the same height.
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 56,
        textAlign: 'left',
        padding: '8px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        background,
        border: `1px solid ${active ? color : t.borderSoft}`,
        color: t.text,
      }}
    >
      <span
        style={{
          display: 'flex',
          // Align the status glyph with the first title line when a name wraps.
          alignItems: 'flex-start',
          gap: 7,
        }}
      >
        <span aria-hidden="true" style={{ display: 'flex', flexShrink: 0 }}>
          <ChipGlyph t={t} status={roll} />
        </span>
        <span
          style={{
            fontFamily: FONTS.sans,
            fontSize: 12,
            fontWeight: 700,
            lineHeight: 1.3,
            color: t.text,
          }}
        >
          {group.name}
        </span>
      </span>
      <span
        style={{
          // Pin the status rows to the card bottom so they share one baseline
          // across all tiles regardless of title line count. The counts take
          // their own line, so a short status leaves no blank line above it.
          marginTop: 'auto',
          display: 'block',
          lineHeight: 1.35,
          fontFamily: FONTS.sans,
          fontSize: 11,
          color: t.dim,
        }}
      >
        <span style={{ display: 'block', color }}>{rollupLabel(roll)}</span>
        <span style={{ display: 'block', whiteSpace: 'nowrap' }}>
          {groupCountSummary(group, applicability)}
        </span>
      </span>
    </button>
  )
}

/** Show a next step above the full check list when every dependency passes. */
function AllSatisfiedBanner({ t }: { t: Theme }): ReactNode {
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 6,
        background: statusSoft(t, 'found'),
        border: `1px solid ${statusColor(t, 'found')}`,
        fontFamily: FONTS.sans,
      }}
    >
      <ChipGlyph t={t} status="found" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: statusColor(t, 'found'),
          }}
        >
          The environment is ready.
        </span>
        {/* The dim hint color measures 4.25:1 on this tinted success
            background, so use the regular text color here. */}
        <Hint t={t} style={{ color: t.text }}>
          Every required pipeline tool is detected and usable. Open Pipeline to
          configure a run, or open Subjects to start one.
        </Hint>
      </div>
    </div>
  )
}

interface RecommendedFixProps {
  t: Theme
  check: EnvCheck
  /** Reveal and focus the owning check row. */
  onShow: () => void
}

/**
 * Surface the highest-priority failure with its blocked stage and consequence,
 * then hand off to the owning check row, which renders the detail, commands,
 * and gated actions exactly once.
 */
function RecommendedFix({ t, check, onShow }: RecommendedFixProps): ReactNode {
  const accent = statusColor(t, check.status)
  const soft = statusSoft(t, check.status)

  return (
    <section
      aria-label="Recommended fix"
      style={{
        background: soft,
        borderRadius: 6,
        border: `1px solid ${accent}`,
        borderLeft: `3px solid ${accent}`,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontFamily: FONTS.sans,
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: 0.2,
            color: accent,
          }}
        >
          Recommended fix
        </span>
        <Chip
          t={t}
          status={check.status}
          label={STATUS_LABEL[check.status]}
          small
          title={statusMeaning(check.status)}
        />
      </div>

      <div
        style={{
          fontFamily: FONTS.sans,
          fontSize: 15,
          fontWeight: 700,
          color: t.textStrong,
        }}
      >
        {check.label}
      </div>

      <div style={{ fontFamily: FONTS.sans, fontSize: 13, color: t.textSoft }}>
        {consequenceFor(check)}
      </div>

      <div>
        <Btn
          t={t}
          small
          label="Go to check"
          icon={<Ico d={ICONS.chevron} size={ICON_SIZE.nav} />}
          onClick={onShow}
          ariaLabel={`Go to the ${check.label} check`}
        />
      </div>
    </section>
  )
}

/** Name every verdict; each chip's tooltip gives its plain-language meaning. */
function VerdictLegend({ t }: { t: Theme }): ReactNode {
  return (
    <div
      role="group"
      aria-label="Status word meanings"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          fontFamily: FONTS.sans,
          fontSize: 11,
          color: t.dim,
        }}
      >
        Status key
      </span>
      {VERDICT_ORDER.map((status) => (
        <Chip
          key={status}
          t={t}
          status={status}
          label={STATUS_LABEL[status]}
          small
          title={statusMeaning(status)}
        />
      ))}
    </div>
  )
}

interface ActionsBarProps {
  t: Theme
  safeExecution: boolean
  onSafeExecutionChange?: (next: boolean) => void
  hasInstallPlan: boolean
  planCopied: boolean
  onCopyPlan: () => void
  /** The status key, set at the row's trailing edge. */
  legend?: ReactNode
}

function ActionsBar({
  t,
  safeExecution,
  onSafeExecutionChange,
  hasInstallPlan,
  planCopied,
  onCopyPlan,
  legend,
}: ActionsBarProps): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px 10px',
        flexWrap: 'wrap',
      }}
    >
      <>
        <Btn
          t={t}
          label={planCopied ? 'Copied' : 'Copy install plan'}
          icon={<Ico d={ICONS.copy} size={ICON_SIZE.nav} />}
          onClick={onCopyPlan}
          disabled={!hasInstallPlan}
          title={
            hasInstallPlan
              ? 'Copies a bash script with every fix below. Review it, then paste it into a terminal.'
              : 'Every dependency is already satisfied, so the install plan is empty.'
          }
          ariaLabel="Copy install plan"
        />
        <span
          style={{
            fontFamily: FONTS.sans,
            fontSize: 11.5,
            color: safeExecution ? statusColor(t, 'found') : t.dim,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
          title={
            safeExecution
              ? 'Installs can run from this screen, and each one asks first.'
              : 'Installs from this screen need Allow live runs, and each one asks first.'
          }
        >
          <ChipGlyph t={t} status={safeExecution ? 'found' : 'skipped'} />
          Allow live runs: {safeExecution ? 'on' : 'off'}
        </span>
        {!safeExecution && onSafeExecutionChange && (
          <Btn
            t={t}
            secondary
            label="Allow live runs"
            onClick={() => onSafeExecutionChange(true)}
            ariaLabel="Allow live runs"
          />
        )}
      </>
      {legend && (
        <>
          <span style={{ flex: 1 }} />
          {legend}
        </>
      )}
    </div>
  )
}
