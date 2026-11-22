/**
 * Guides an operator from nothing to a runnable project in five linear steps:
 * project basics, input data layout, environment check, pipeline configuration,
 * and a review-and-finish summary. One working {@link ProjectConfig} carries
 * across steps. Back preserves every value, Next is gated on current-step
 * validity, and the configuration is written before routing to the dashboard.
 *
 * Accepts shell-owned configuration and actions, or falls back to `getApi()`.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { flushSync } from 'react-dom'
import {
  Btn,
  Card,
  Chip,
  ConfirmDialog,
  Field,
  FONTS,
  Hint,
  IconButton,
  Ico,
  ICONS,
  ICON_SIZE,
  LoadingState,
  PageTitle,
  PathInput,
  TextInput,
  recentSubjectStepLabel,
  statusColor,
  type Theme,
  NoticeGlyph,
} from '../ui'
import { getApi, hasNativeBridge } from '../state/api'
import { useApp } from '../state/context'
import { useCopyFeedback } from '../state/useCopyFeedback'
import {
  loadRecentProjects,
  rememberRecentProject,
} from '../state/recent-projects'
import {
  DEFAULT_PROJECT_CONFIG,
  type ProjectConfig,
} from '../../shared/project-schema'
import {
  flattenConfig,
  isAbsoluteProjectRoot,
  resolveTemplate,
  unresolvedPaths,
} from '../../shared/template'
import {
  MATRIX_STEPS,
  WIZARD_STEP_LABELS as STEP_LABELS,
  WIZARD_STEP_COUNT as STEP_COUNT,
} from '../../shared/steps'
import { GLOSSARY, MATRIX_STEP_HELP } from '../../shared/help'
import type { EnvCheck, EnvCheckAction, EnvReport } from '../../shared/types'
import type { EnvInstallState, ProjectOpenResult } from '../../shared/contract'
import type { EnvApplicability } from '../state/env-applicability'
import { envApplicability } from '../state/env-applicability'
import {
  GroupSection,
  PybrainageSetupDialog,
  PybrainageSetupProgress,
  applyProvisionedPaths,
  groupSignature,
  seedExpansion,
  tallyEnv,
  useEnvInstall,
  usePybrainageSetup,
  type PybrainageSetupState,
} from './env'
import { MatchingRuleFields } from './MatchingRuleFields'

/**
 * Deep-clone the seed configuration so each wizard run remains isolated from
 * the shared `DEFAULT_PROJECT_CONFIG` singleton.
 */
function cloneDefaultConfig(): ProjectConfig {
  return structuredClone(DEFAULT_PROJECT_CONFIG)
}

const PROJECT_PATH_KEYS: ReadonlyArray<keyof ProjectConfig['paths']> = [
  'rawdataDir',
  'derivativesDir',
  'outputDir',
  'metadataDir',
  'clinicalMetadataFile',
  'ageMetadataFile',
  'qcOutputDir',
]

const PROJECT_OUTPUT_KEYS: ReadonlyArray<keyof ProjectConfig['outputs']> = [
  'rootDir',
  'runDir',
  'manifestPath',
]

/** Resolve only path/output template strings, preserving the rest of cfg. */
function resolveProjectTemplates(cfg: ProjectConfig): ProjectConfig {
  let flat = flattenConfig(cfg)
  const paths = { ...cfg.paths }
  for (const key of PROJECT_PATH_KEYS) {
    const value = paths[key]
    if (typeof value === 'string') paths[key] = resolveTemplate(value, flat)
  }

  const withPaths: ProjectConfig = { ...cfg, paths }
  flat = flattenConfig(withPaths)
  const outputs = { ...cfg.outputs }
  for (const key of PROJECT_OUTPUT_KEYS) {
    const value = outputs[key]
    outputs[key] = resolveTemplate(value, flat)
  }

  return { ...withPaths, outputs }
}

/** Build the concrete default path/output values for a specific project root. */
function resolvedDefaultsForRoot(root: string): ProjectConfig {
  return resolveProjectTemplates({
    ...cloneDefaultConfig(),
    paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: root },
  })
}

/**
 * Apply a project root and refresh only fields still carrying default-derived
 * values. Preserve custom rawdata and output choices.
 */
function applyProjectRoot(cfg: ProjectConfig, root: string): ProjectConfig {
  const oldRoot = cfg.paths.projectRoot
  const oldDefaults = resolvedDefaultsForRoot(oldRoot)
  const newDefaults = resolvedDefaultsForRoot(root)
  const paths = { ...cfg.paths, projectRoot: root }

  for (const key of PROJECT_PATH_KEYS) {
    const value = paths[key]
    if (typeof value !== 'string') continue
    if (value.includes('${') || value === oldDefaults.paths[key]) {
      const replacement = newDefaults.paths[key]
      if (typeof replacement === 'string') paths[key] = replacement
    }
  }

  const outputs = { ...cfg.outputs }
  for (const key of PROJECT_OUTPUT_KEYS) {
    const value = outputs[key]
    if (value.includes('${') || value === oldDefaults.outputs[key]) {
      outputs[key] = newDefaults.outputs[key]
    }
  }

  return { ...cfg, paths, outputs }
}

/** Project setup state and persistence actions for the wizard. */
export interface SetupWizardProps {
  cfg?: ProjectConfig
  onCfgChange?: (next: ProjectConfig) => void
  onCreate?: (at: string, cfg: ProjectConfig) => Promise<ProjectOpenResult>
  refresh?: () => void
  /**
   * The environment report the application shell already holds. The
   * Environment step reuses it instead of rerunning the check while it is
   * current for the configuration revision, and the review reads it when this
   * visit has not run its own check. Omit it in standalone mode.
   */
  envReport?: EnvReport | null
}

function defaultReconThreads(): number {
  return DEFAULT_PROJECT_CONFIG.runtime.threads
}

/**
 * Seed reconstruction threads from the incoming configuration. Fall back to the
 * model default when the persisted runtime setting is unusable.
 */
function initialReconThreads(cfg: ProjectConfig | undefined): string {
  const fromRuntime = cfg?.runtime.threads
  if (typeof fromRuntime === 'number') return String(fromRuntime)
  return String(defaultReconThreads())
}

function recommendedReconThreads(cpuCount: number | null): number {
  const fallback = defaultReconThreads()
  if (!cpuCount || !Number.isFinite(cpuCount)) return fallback
  const cores = Math.max(1, Math.trunc(cpuCount))
  if (cores <= 4) return Math.max(1, Math.floor(cores / 2))
  return Math.min(8, Math.max(4, Math.floor(cores / 4)))
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

function subjectMatchesPattern(id: string, pattern: string): boolean {
  const value = id.trim()
  const rule = pattern.trim()
  if (!value || !rule) return false
  return globToRegex(rule).test(value)
}

function subjectExampleFromPattern(pattern: string): string {
  const rule = pattern.trim()
  if (!rule) return 'participant-001'
  return rule.replace(/\*/g, '001').replace(/\?/g, '1')
}

export function SetupWizard(props: SetupWizardProps = {}): ReactNode {
  const { onCfgChange, onCreate, refresh } = props
  const {
    t,
    setRoute,
    saveProject,
    safeExecution,
    setSafeExecution,
    hasProject,
    projectRef,
    configRevision,
    markProjectCreated,
    reserveCreateEpoch,
    wizardStep: step,
    setWizardStep: setStep,
    wizardMaxReached: maxReached,
    setWizardMaxReached: setMaxReached,
  } = useApp()

  const [cfg, setCfgState] = useState<ProjectConfig>(
    () => props.cfg ?? cloneDefaultConfig(),
  )

  // Focus the stable heading after step changes so keyboard and screen-reader
  // users receive the new context. Skip only a genuine first paint at step 0.
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const wizardRef = useRef<HTMLDivElement | null>(null)
  const hasMountedRef = useRef(step !== 0)
  const [validationAttempt, setValidationAttempt] = useState(0)
  // A required field left empty is marked only after the user leaves it
  // or tries to continue, so a fresh form opens without error borders.
  const [touched, setTouched] = useState<ReadonlySet<RequiredField>>(
    () => new Set(),
  )
  const markTouched = useCallback((field: RequiredField): void => {
    setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)))
  }, [])
  const showRequired = (field: RequiredField): boolean =>
    validationAttempt > 0 || touched.has(field)

  const [projectRoot, setProjectRoot] = useState(
    () => props.cfg?.paths.projectRoot ?? '',
  )
  const [threads, setThreads] = useState(() => initialReconThreads(props.cfg))
  const [subjectDraft, setSubjectDraft] = useState('')
  const [subjectIds, setSubjectIds] = useState<string[]>(
    () => props.cfg?.subjects.include ?? [],
  )
  const [excludeDraft, setExcludeDraft] = useState('')
  const [excludeIds, setExcludeIds] = useState<string[]>(
    () => props.cfg?.subjects.exclude ?? [],
  )
  const [rawDataExists, setRawDataExists] = useState<boolean | null>(null)

  const [envReport, setEnvReport] = useState<EnvReport | null>(null)
  const [envError, setEnvError] = useState<string | null>(null)
  const { copiedKey: copiedEnvFix, copy: copyEnvFixText } = useCopyFeedback()
  const [pendingEnvInstall, setPendingEnvInstall] = useState<EnvCheck | null>(
    null,
  )

  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const nativeBridge = hasNativeBridge()

  const patchCfg = useCallback(
    (next: ProjectConfig): void => {
      // A step commit that reproduces the current values must not publish a
      // new revision, or moving between steps would mark a saved project as
      // unsaved without an edit.
      if (JSON.stringify(next) === JSON.stringify(cfg)) return
      setCfgState(next)
      onCfgChange?.(next)
    },
    [cfg, onCfgChange],
  )

  // Reuse the shell's environment report while it is current, meaning it
  // arrived at this configuration revision of this project, so a later visit
  // does not rerun the full check. The shell clears its report one render
  // after a configuration change, so a report first seen at an earlier
  // revision is stale. A manual recheck or a finished install declines it.
  const shellEnvReport = props.envReport ?? null
  const [shellEnvSeen, setShellEnvSeen] = useState(() => ({
    report: shellEnvReport,
    revision: configRevision,
    project: projectRef,
  }))
  if (shellEnvReport !== shellEnvSeen.report) {
    setShellEnvSeen({
      report: shellEnvReport,
      revision: configRevision,
      project: projectRef,
    })
  }
  const [shellEnvDeclined, setShellEnvDeclined] = useState(false)
  const stepEnvReport =
    envReport ??
    (!shellEnvDeclined &&
    shellEnvSeen.revision === configRevision &&
    shellEnvSeen.project === projectRef
      ? shellEnvReport
      : null)

  // Run the environment check on first entry without a current report and
  // after a manual reset. Guard every asynchronous state write.
  useEffect(() => {
    if (step !== 2) return
    if (!projectRef) return
    if (stepEnvReport !== null || envError !== null) return
    let alive = true
    void getApi()
      .env.check({ project: projectRef, cfg, configRevision })
      .then((report) => {
        if (alive) setEnvReport(report)
      })
      .catch((err: unknown) => {
        if (alive) setEnvError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [step, stepEnvReport, envError, cfg, projectRef, configRevision])

  const envLoading =
    step === 2 &&
    projectRef !== null &&
    stepEnvReport === null &&
    envError === null

  // Wait for the new step DOM before moving focus to its stable heading.
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true
      return
    }
    const id = setTimeout(() => {
      headingRef.current?.focus()
    }, 0)
    return () => clearTimeout(id)
  }, [step])

  const recheckEnv = useCallback((): void => {
    setEnvReport(null)
    setEnvError(null)
    setShellEnvDeclined(true)
  }, [])

  // Host the shared PyBrainAge setup flow. Apply verified paths onto the live
  // draft so later wizard commits and Save keep them, then reprobe.
  const setup = usePybrainageSetup({
    safeExecution,
    onApplyProvisioned: (_capturedCfg, paths) =>
      patchCfg(applyProvisionedPaths(cfg, paths)),
    onFinalized: recheckEnv,
  })

  const copyEnvFix = useCallback(
    async (check: EnvCheck): Promise<void> => {
      if (!check.recommendedCmd) return
      const ok = await copyEnvFixText(check.id, check.recommendedCmd)
      if (!ok)
        setEnvError('Grant clipboard permission, then copy the command again.')
    },
    [copyEnvFixText],
  )

  const openEnvDownload = useCallback((check: EnvCheck): void => {
    if (!check.downloadUrl) return
    // Report a refused destination instead of leaving the control silent.
    getApi()
      .external.openWeb({ url: check.downloadUrl, purpose: 'download' })
      .catch(() => {
        setEnvError('Open this download link manually; Supraspina refused it.')
      })
  }, [])

  // Host the shared install flow. The sidecar owns the running installation
  // and reports it; reprobe the environment once it succeeds.
  const envInstall = useEnvInstall({
    safeExecution,
    request: { cfg, configRevision },
    onInstalled: recheckEnv,
  })

  // Fall back to the shell's report, so an environment this session already
  // verified stays verified in a later wizard visit that skips the Environment
  // step. The Environment step reads only a current report, so a recheck there
  // still shows its loading and error states.
  const knownEnvReport = stepEnvReport ?? props.envReport ?? null

  // Read the same pipeline-aware requirement projection Diagnostics reads, so
  // both screens agree about which checks this configuration requires.
  const envApplicable = useMemo<EnvApplicability>(
    () => (knownEnvReport ? envApplicability(knownEnvReport, cfg) : new Map()),
    [knownEnvReport, cfg],
  )

  const envTally = useMemo(
    () => (knownEnvReport ? tallyEnv(knownEnvReport, envApplicable) : null),
    [knownEnvReport, envApplicable],
  )

  // Match Diagnostics disclosure defaults. Re-expand a group when a recheck
  // changes it from passing to failing.
  const [envExpanded, setEnvExpanded] = useState<Record<string, boolean>>(() =>
    seedExpansion(stepEnvReport?.groups ?? [], envApplicable),
  )
  const currentEnvSig = groupSignature(
    stepEnvReport?.groups ?? [],
    envApplicable,
  )
  // Re-seed during render, the supported way to adjust state from a changed
  // input, so the new disclosure state paints without an extra commit.
  const [seededEnvSig, setSeededEnvSig] = useState(currentEnvSig)
  if (currentEnvSig !== seededEnvSig) {
    setSeededEnvSig(currentEnvSig)
    setEnvExpanded(seedExpansion(stepEnvReport?.groups ?? [], envApplicable))
  }

  const toggleEnvGroup = useCallback((name: string): void => {
    setEnvExpanded((prev) => ({ ...prev, [name]: !prev[name] }))
  }, [])

  const subjectDraftValid = subjectMatchesPattern(
    subjectDraft,
    cfg.patterns.subjectGlob,
  )
  const subjectDraftDuplicate = subjectIds.includes(subjectDraft.trim())
  const subjectDraftConflict = excludeIds.includes(subjectDraft.trim())
  const subjectIdsValid = subjectIds.every((id) =>
    subjectMatchesPattern(id, cfg.patterns.subjectGlob),
  )
  const excludeDraftValid = subjectMatchesPattern(
    excludeDraft,
    cfg.patterns.subjectGlob,
  )
  const excludeDraftDuplicate = excludeIds.includes(excludeDraft.trim())
  const excludeDraftConflict = subjectIds.includes(excludeDraft.trim())
  const excludeIdsValid = excludeIds.every((id) =>
    subjectMatchesPattern(id, cfg.patterns.subjectGlob),
  )

  const stepValid = useMemo((): boolean => {
    switch (step) {
      case 0:
        // Block relative and `~`-prefixed roots before they reach project creation.
        return (
          cfg.project.name.trim().length > 0 &&
          isAbsoluteProjectRoot(projectRoot, cfg.platform.pathStyle)
        )
      case 1:
        return (
          cfg.paths.rawdataDir.trim().length > 0 &&
          subjectIdsValid &&
          excludeIdsValid
        )
      case 2:
        // Allow setup after the check completes. Defer missing-tool blocking to
        // per-stage preflight.
        return projectRef === null || (!envLoading && stepEnvReport !== null)
      case 3:
        return Number.isInteger(Number(threads)) && Number(threads) >= 1
      case 4:
        return !creating
      default:
        return false
    }
  }, [
    step,
    cfg.project.name,
    cfg.paths.rawdataDir,
    cfg.platform.pathStyle,
    projectRoot,
    envLoading,
    stepEnvReport,
    projectRef,
    threads,
    subjectIdsValid,
    excludeIdsValid,
    creating,
  ])

  /**
   * Explain why the next action is disabled. Return an empty string when the
   * step is valid.
   */
  const nextBlockReason = useMemo((): string => {
    if (stepValid) return ''
    switch (step) {
      case 0:
        if (cfg.project.name.trim().length === 0)
          return 'Enter a project name to continue.'
        if (projectRoot.trim().length === 0)
          return 'Choose a project root directory to continue.'
        // The project root field states the absolute-path rule; point there
        // instead of restating it.
        return 'Fix the project root path to continue.'
      case 1:
        if (cfg.paths.rawdataDir.trim().length === 0)
          return 'Choose the input data folder to continue.'
        return 'Remove subjects that no longer match the subject folder pattern.'
      case 2:
        // The step blocks only while the check runs or after it rejected; a
        // rejected check shows its failure and a Retry, not a running check.
        return envLoading
          ? 'The environment check is still running.'
          : 'The environment check failed; retry it to continue.'
      case 3:
        return 'Enter an integer thread count of 1 or more.'
      case 4:
        return 'Supraspina is creating the project.'
      default:
        return ''
    }
  }, [
    stepValid,
    step,
    cfg.project.name,
    cfg.paths.rawdataDir,
    projectRoot,
    envLoading,
  ])

  const isLast = step === STEP_COUNT - 1

  /**
   * Announce the current blocker and focus the first invalid field after a
   * rejected forward move.
   */
  const reportInvalidProgression = useCallback((): void => {
    // Render the field errors this attempt reveals before looking for the
    // first one to focus.
    flushSync(() => setValidationAttempt((attempt) => attempt + 1))
    const invalid = wizardRef.current?.querySelector<HTMLElement>(
      '[aria-invalid="true"]',
    )
    const focusTarget = invalid ?? headingRef.current
    focusTarget?.focus()
  }, [])

  const commitPipeline = useCallback((): void => {
    const reconThreads = Math.max(1, Math.trunc(Number(threads)) || 1)
    const next: ProjectConfig = {
      ...cfg,
      runtime: { ...cfg.runtime, threads: reconThreads },
    }
    patchCfg(next)
  }, [cfg, threads, patchCfg])

  const commitSubjects = useCallback((): void => {
    patchCfg({
      ...cfg,
      subjects: {
        ...cfg.subjects,
        include: [...subjectIds],
        exclude: [...excludeIds],
      },
    })
  }, [cfg, subjectIds, excludeIds, patchCfg])

  const commitStep = useCallback(
    (from: number): void => {
      if (from === 0) patchCfg(applyProjectRoot(cfg, projectRoot.trim()))
      if (from === 1) commitSubjects()
      if (from === 3) commitPipeline()
    },
    [cfg, projectRoot, patchCfg, commitSubjects, commitPipeline],
  )

  const goNext = useCallback((): void => {
    if (!stepValid) {
      reportInvalidProgression()
      return
    }
    if (isLast) return
    commitStep(step)
    setValidationAttempt(0)
    setStep((s) => Math.min(STEP_COUNT - 1, s + 1))
    setMaxReached((m) => Math.max(m, step + 1))
  }, [
    stepValid,
    isLast,
    step,
    commitStep,
    reportInvalidProgression,
    setStep,
    setMaxReached,
  ])

  const goBack = useCallback((): void => {
    setValidationAttempt(0)
    setStep((s) => Math.max(0, s - 1))
  }, [setStep])

  /**
   * Allow jumps to cleared steps and the valid immediate next step. Commit a
   * forward jump exactly like Next.
   */
  const goToStep = useCallback(
    (target: number): void => {
      if (target === step) return
      // Apply the Next gate to every forward jump. Prevent the stepper from
      // committing invalid working values.
      if (target > step && !stepValid) {
        reportInvalidProgression()
        return
      }
      const forwardByOne = target === step + 1 && stepValid
      if (target > maxReached && !forwardByOne) return
      if (target > step) commitStep(step)
      setValidationAttempt(0)
      setStep(target)
      setMaxReached((m) => Math.max(m, target))
    },
    [
      step,
      maxReached,
      stepValid,
      commitStep,
      reportInvalidProgression,
      setStep,
      setMaxReached,
    ],
  )

  const addSubject = useCallback((): void => {
    const id = subjectDraft.trim()
    if (
      !subjectMatchesPattern(id, cfg.patterns.subjectGlob) ||
      subjectIds.includes(id) ||
      excludeIds.includes(id)
    ) {
      return
    }
    setSubjectIds((ids) => [...ids, id])
    setSubjectDraft('')
  }, [subjectDraft, cfg.patterns.subjectGlob, subjectIds, excludeIds])

  const removeSubject = useCallback((id: string): void => {
    setSubjectIds((ids) => ids.filter((x) => x !== id))
  }, [])

  const addExcluded = useCallback((): void => {
    const id = excludeDraft.trim()
    if (
      !subjectMatchesPattern(id, cfg.patterns.subjectGlob) ||
      excludeIds.includes(id) ||
      subjectIds.includes(id)
    ) {
      return
    }
    setExcludeIds((ids) => [...ids, id])
    setExcludeDraft('')
  }, [excludeDraft, cfg.patterns.subjectGlob, excludeIds, subjectIds])

  const removeExcluded = useCallback((id: string): void => {
    setExcludeIds((ids) => ids.filter((x) => x !== id))
  }, [])

  const browseRoot = useCallback(async (): Promise<void> => {
    const dir = await getApi().fs.chooseDir()
    if (dir) setProjectRoot(dir)
  }, [])

  /**
   * Browse for the rawdata directory. Defer project-scoped content validation to
   * discovery.
   */
  const browseRawData = useCallback(async (): Promise<void> => {
    const dir = await getApi().fs.chooseDir()
    if (!dir) return
    setRawDataExists(true)
    patchCfg({ ...cfg, paths: { ...cfg.paths, rawdataDir: dir } })
  }, [cfg, patchCfg])

  /**
   * Compose every step's working values into the configuration. Both the
   * create and the save path need this because the free stepper can reach
   * Review without committing intermediate steps.
   */
  const composeWorkingConfig = useCallback((): ProjectConfig => {
    const reconThreads = Math.max(1, Math.trunc(Number(threads)) || 1)
    const next = applyProjectRoot(cfg, projectRoot.trim())
    return {
      ...next,
      subjects: {
        ...next.subjects,
        include: [...subjectIds],
        exclude: [...excludeIds],
      },
      runtime: { ...next.runtime, threads: reconThreads },
    }
  }, [cfg, projectRoot, subjectIds, excludeIds, threads])

  const finish = useCallback(async (): Promise<void> => {
    setCreating(true)
    setCreateError(null)
    try {
      // Validate before composing: applyProjectRoot rewrites placeholder path
      // values to root defaults, which would mask an unresolved reference the
      // operator must resolve deliberately.
      const residual = unresolvedPaths(cfg)
      if (residual.length > 0) {
        const names = residual.map((r) => `paths.${r.field}`).join(', ')
        throw new Error(
          `Set concrete values for ${names} before creating the project; remove every unresolved ` +
            '${...} placeholder.',
        )
      }
      const composed = composeWorkingConfig()
      // Reserve the create epoch immediately before the attempt. Avoid sending a
      // stale React generation after a failed open.
      const result = onCreate
        ? await onCreate(projectRoot, composed)
        : await getApi().project.create({
            at: projectRoot,
            cfg: composed,
            epoch: reserveCreateEpoch(),
          })
      markProjectCreated(result)
      // Add the created project to the toolbar's Recent list.
      rememberRecentProject(loadRecentProjects(), result.cfg, projectRoot)
      refresh?.()
      setRoute('project')
    } catch (err) {
      // Strip Electron's IPC wrapper before showing the failure.
      const raw = err instanceof Error ? err.message : String(err)
      const message = raw
        .replace(/^Error invoking remote method '[^']*':\s*/, '')
        .replace(/^Error:\s*/, '')
      setCreateError(message)
      setCreating(false)
    }
  }, [
    onCreate,
    projectRoot,
    cfg,
    composeWorkingConfig,
    refresh,
    reserveCreateEpoch,
    setRoute,
    markProjectCreated,
  ])

  /** Save an existing project from the same composed working values. */
  const saveChanges = useCallback(async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      await saveProject(composeWorkingConfig())
      setRoute('project')
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const message = raw
        .replace(/^Error invoking remote method '[^']*':\s*/, '')
        .replace(/^Error:\s*/, '')
      setSaveError(message)
    } finally {
      setSaving(false)
    }
  }, [composeWorkingConfig, saveProject, setRoute])

  const onCardKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      if (e.key !== 'Enter') return
      const target = e.target as HTMLElement
      if (target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA') return
      if (!isLast) {
        e.preventDefault()
        goNext()
      }
    },
    [isLast, goNext],
  )

  return (
    <div
      style={{
        height: '100%',
        minHeight: 0,
        overflow: 'auto',
        background: t.bg,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 20px',
      }}
    >
      <div
        ref={wizardRef}
        role="group"
        aria-label="Project setup wizard"
        onKeyDown={onCardKeyDown}
        style={{ width: '100%', maxWidth: 720 }}
      >
        <Card t={t} padded={false}>
          <WizardHeader t={t} step={step} headingRef={headingRef} />
          <ProgressStrip
            t={t}
            step={step}
            maxReached={maxReached}
            stepValid={stepValid}
            onGoTo={goToStep}
          />
          <div
            style={{
              padding: '20px 24px',
              maxWidth: 620,
              margin: '0 auto',
              width: '100%',
              boxSizing: 'border-box',
            }}
          >
            {step === 0 && (
              <StepWelcome
                t={t}
                name={cfg.project.name}
                onName={(v) =>
                  patchCfg({
                    ...cfg,
                    project: { ...cfg.project, name: v },
                  })
                }
                root={projectRoot}
                pathStyle={cfg.platform.pathStyle}
                onRoot={setProjectRoot}
                onBrowseRoot={nativeBridge ? browseRoot : undefined}
                showNameRequired={showRequired('name')}
                showRootRequired={showRequired('root')}
                onTouched={markTouched}
              />
            )}
            {step === 1 && (
              <StepData
                t={t}
                rawData={cfg.paths.rawdataDir}
                onRawData={(v) => {
                  setRawDataExists(null)
                  patchCfg({ ...cfg, paths: { ...cfg.paths, rawdataDir: v } })
                }}
                onBrowseRawData={nativeBridge ? browseRawData : undefined}
                showRawDataRequired={showRequired('rawData')}
                onTouched={markTouched}
                rawDataExists={rawDataExists}
                subjectGlob={cfg.patterns.subjectGlob}
                onSubjectGlob={(v) =>
                  patchCfg({
                    ...cfg,
                    patterns: { ...cfg.patterns, subjectGlob: v },
                  })
                }
                t1Pattern={cfg.patterns.t1Pattern}
                onT1Pattern={(v) =>
                  patchCfg({
                    ...cfg,
                    patterns: { ...cfg.patterns, t1Pattern: v },
                  })
                }
                subjectDraft={subjectDraft}
                onSubjectDraft={setSubjectDraft}
                subjectDraftValid={subjectDraftValid}
                subjectDraftDuplicate={subjectDraftDuplicate}
                subjectDraftConflict={subjectDraftConflict}
                subjectIds={subjectIds}
                subjectIdsValid={subjectIdsValid}
                onAddSubject={addSubject}
                onRemoveSubject={removeSubject}
                exclude={{
                  draft: excludeDraft,
                  onDraft: setExcludeDraft,
                  draftValid: excludeDraftValid,
                  draftDuplicate: excludeDraftDuplicate,
                  draftConflict: excludeDraftConflict,
                  ids: excludeIds,
                  idsValid: excludeIdsValid,
                  onAdd: addExcluded,
                  onRemove: removeExcluded,
                }}
              />
            )}
            {step === 2 && !projectRef && (
              <div style={stepBodyStyle()}>
                <StepIntro
                  t={t}
                  text="Host-level tools can be checked on the Diagnostics screen now; project-scoped checks run after this project is created."
                />
                <div>
                  <Btn
                    t={t}
                    small
                    label="Open Diagnostics"
                    icon={<Ico d={ICONS.doctor} size={ICON_SIZE.nav} />}
                    onClick={() => setRoute('diagnostics')}
                  />
                </div>
                <Hint t={t}>
                  Setup can continue without tool status at this draft stage,
                  and the draft keeps your entries while you visit Diagnostics.
                </Hint>
              </div>
            )}
            {step === 2 && projectRef && (
              <StepEnvironment
                t={t}
                loading={envLoading}
                error={envError}
                report={stepEnvReport}
                applicability={envApplicable}
                tally={envTally}
                expanded={envExpanded}
                onToggleGroup={toggleEnvGroup}
                onRecheck={recheckEnv}
                safeExecution={safeExecution}
                onSafeExecution={setSafeExecution}
                copiedFix={copiedEnvFix}
                installingFix={envInstall.running}
                installs={envInstall.states}
                setupState={setup.state}
                setupRunning={setup.state?.status === 'running'}
                onCopyFix={(check) => void copyEnvFix(check)}
                onGetIt={openEnvDownload}
                onInstall={setPendingEnvInstall}
                onSetupAction={() => setup.setPending(true)}
                onOpenEnvironment={() => setRoute('diagnostics')}
              />
            )}
            {step === 3 && (
              <StepPipeline t={t} threads={threads} onThreads={setThreads} />
            )}
            {step === 4 && (
              <StepReview
                t={t}
                name={cfg.project.name}
                root={projectRoot}
                rawData={cfg.paths.rawdataDir}
                envChecked={knownEnvReport !== null}
                envMissing={envTally ? envTally.missing : 0}
                hasProject={hasProject}
                threads={threads}
                subjectCount={subjectIds.length}
                excludedCount={excludeIds.length}
                busy={hasProject ? saving : creating}
                error={hasProject ? saveError : createError}
              />
            )}
          </div>
          <WizardFooter
            t={t}
            step={step}
            isLast={isLast}
            stepValid={stepValid}
            creating={creating}
            hasProject={hasProject}
            saving={saving}
            blockReason={nextBlockReason}
            blockPending={envLoading}
            validationAttempt={validationAttempt}
            onBack={goBack}
            onNext={goNext}
            onFinish={() => void finish()}
            onSave={() => void saveChanges()}
          />
        </Card>
      </div>
      {pendingEnvInstall && (
        <ConfirmDialog
          t={t}
          title={`Confirm installation of ${pendingEnvInstall.label}`}
          message={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span>
                This installer command runs on this host once authorized.
              </span>
              {pendingEnvInstall.recommendedCmd && (
                <code style={{ fontFamily: FONTS.mono, fontSize: 11 }}>
                  {pendingEnvInstall.recommendedCmd}
                </code>
              )}
            </div>
          }
          onDismiss={() => setPendingEnvInstall(null)}
          actions={[
            {
              label: 'Cancel',
              initialFocus: true,
              onSelect: () => setPendingEnvInstall(null),
            },
            {
              label: 'Authorize install',
              tone: 'primary',
              disabled: !safeExecution || !projectRef,
              onSelect: () => {
                const check = pendingEnvInstall
                setPendingEnvInstall(null)
                envInstall.start(check)
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
    </div>
  )
}

interface WizardHeaderProps {
  t: Theme
  step: number
  headingRef: RefObject<HTMLHeadingElement | null>
}

/** Keep one stable title and put the per-step name only in the progress strip. */
function WizardHeader(props: WizardHeaderProps): ReactNode {
  const { t, step, headingRef } = props
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        padding: '18px 24px 14px',
        borderBottom: `1px solid ${t.borderSoft}`,
      }}
    >
      <PageTitle t={t} headingRef={headingRef} tabIndex={-1}>
        Set up your project
      </PageTitle>
      {/* The stepper below shows the position; keep the count for screen
          readers only. */}
      <span
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        Step {step + 1} of {STEP_COUNT}
      </span>
    </div>
  )
}

interface ProgressStripProps {
  t: Theme
  step: number
  maxReached: number
  stepValid: boolean
  onGoTo: (i: number) => void
}

/** Preserve step gates while allowing navigation to reached steps. */
function ProgressStrip(props: ProgressStripProps): ReactNode {
  const { t, step, maxReached, stepValid, onGoTo } = props
  return (
    <ol
      aria-label="Setup progress"
      style={{
        listStyle: 'none',
        margin: 0,
        padding: '14px 24px 4px',
        display: 'grid',
        gridTemplateColumns: `repeat(${STEP_COUNT}, 1fr)`,
        gap: 6,
        borderBottom: `1px solid ${t.borderSoft}`,
      }}
    >
      {STEP_LABELS.map((label, i) => {
        const done = i < step
        const current = i === step
        const barColor = done ? t.done : current ? t.accent : t.surface4
        const reachable = i <= maxReached || (i === step + 1 && stepValid)
        return (
          <li
            key={label}
            aria-current={current ? 'step' : undefined}
            style={{ minWidth: 0 }}
          >
            <button
              type="button"
              onClick={() => onGoTo(i)}
              disabled={!reachable}
              aria-label={`Step ${i + 1}: ${label}`}
              title={reachable ? undefined : 'Finish the current step first.'}
              style={{
                display: 'block',
                width: '100%',
                padding: 0,
                border: 'none',
                background: 'none',
                font: 'inherit',
                color: 'inherit',
                cursor: reachable && !current ? 'pointer' : 'default',
              }}
            >
              <div
                style={{
                  height: 6,
                  borderRadius: 3,
                  background: barColor,
                  border:
                    current && !done
                      ? `1px solid ${t.accent}`
                      : '1px solid transparent',
                  boxSizing: 'border-box',
                  opacity: done || current ? 1 : 0.5,
                }}
              />
              <div
                style={{
                  marginTop: 5,
                  marginBottom: 8,
                  fontFamily: FONTS.sans,
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: current ? t.text : done ? t.textSoft : t.dim,
                  textAlign: 'center',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {i + 1} {label}
              </div>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

interface WizardFooterProps {
  t: Theme
  step: number
  isLast: boolean
  stepValid: boolean
  creating: boolean
  hasProject: boolean
  saving: boolean
  blockReason: string
  /**
   * Whether the blocker is work in progress, such as the environment check,
   * rather than an entry to fix. Such a blocker reads as neutral progress.
   */
  blockPending: boolean
  validationAttempt: number
  onBack: () => void
  onNext: () => void
  onFinish: () => void
  onSave: () => void
}

function WizardFooter(props: WizardFooterProps): ReactNode {
  const {
    t,
    step,
    isLast,
    stepValid,
    creating,
    hasProject,
    saving,
    blockReason,
    blockPending,
    validationAttempt,
    onBack,
    onNext,
    onFinish,
    onSave,
  } = props
  // Name the blocker on the disabled button so its grayed state is explained
  // on hover; once enabled the tooltip is dropped so it reads as a plain
  // action. After a rejected attempt the visible footer message owns the
  // text, so the tooltip yields to avoid announcing it twice. The message is
  // an alert for an entry to fix and a polite status for work in progress.
  const messageVisible =
    validationAttempt > 0 && !stepValid && Boolean(blockReason)
  const reason = messageVisible ? undefined : blockReason || undefined
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 24px',
        borderTop: `1px solid ${t.border}`,
      }}
    >
      <Btn t={t} label="Back" ghost disabled={step === 0} onClick={onBack} />
      <div style={{ flex: 1 }} />
      {messageVisible && (
        <span
          key={validationAttempt}
          role={blockPending ? 'status' : 'alert'}
          style={{
            maxWidth: 300,
            marginRight: 10,
            color: blockPending ? t.dim : t.failed,
            fontFamily: FONTS.sans,
            fontSize: 11,
            lineHeight: 1.35,
          }}
        >
          {blockReason}
        </span>
      )}
      {isLast ? (
        // Save an existing project in place. Create only a new project.
        hasProject ? (
          <Btn
            t={t}
            label={saving ? 'Saving...' : 'Save changes'}
            primary
            icon={<Ico d={ICONS.check} size={ICON_SIZE.nav} />}
            disabled={!stepValid || saving}
            title={reason}
            onClick={onSave}
          />
        ) : (
          <Btn
            t={t}
            label={creating ? 'Creating...' : 'Create project'}
            primary
            icon={<Ico d={ICONS.check} size={ICON_SIZE.nav} />}
            disabled={!stepValid || creating}
            title={reason}
            onClick={onFinish}
          />
        )
      ) : (
        <Btn
          t={t}
          label="Next"
          primary
          disabled={!stepValid}
          title={reason}
          onClick={onNext}
        />
      )}
    </div>
  )
}

function stepBodyStyle(): CSSProperties {
  return { display: 'flex', flexDirection: 'column', gap: 18 }
}

function StepIntro(props: { t: Theme; text: string }): ReactNode {
  const { t, text } = props
  return (
    <p
      style={{
        margin: 0,
        fontFamily: FONTS.sans,
        fontSize: 12.5,
        lineHeight: 1.5,
        color: t.dim,
      }}
    >
      {text}
    </p>
  )
}

interface StepWelcomeProps {
  t: Theme
  name: string
  onName: (v: string) => void
  root: string
  pathStyle: ProjectConfig['platform']['pathStyle']
  onRoot: (v: string) => void
  onBrowseRoot?: (() => void) | undefined
  /** Whether an empty project name is marked as an error yet. */
  showNameRequired: boolean
  /** Whether an empty project root is marked as an error yet. */
  showRootRequired: boolean
  /** Report that the user left a required field. */
  onTouched: (field: RequiredField) => void
}

/**
 * Keep project opening in the top-bar Open menu. Use this step only to configure
 * project basics.
 */
function StepWelcome(props: StepWelcomeProps): ReactNode {
  const {
    t,
    name,
    onName,
    root,
    pathStyle,
    onRoot,
    onBrowseRoot,
    showNameRequired,
    showRootRequired,
    onTouched,
  } = props
  return (
    <div style={stepBodyStyle()}>
      <WhatIsSupraspina t={t} />
      <Field
        t={t}
        label="Project name"
        error={
          showNameRequired && name.trim().length === 0
            ? 'Enter a project name.'
            : ''
        }
      >
        <TextInput
          t={t}
          value={name}
          onChange={onName}
          placeholder="example-study"
          ariaLabel="Project name"
          invalid={showNameRequired && name.trim().length === 0}
          onBlur={() => onTouched('name')}
        />
      </Field>
      <Field
        t={t}
        label="Project root directory"
        error={
          root.trim().length > 0 && !isAbsoluteProjectRoot(root, pathStyle)
            ? 'Enter an absolute path. Use Browse or type the full path instead of ~, e.g. /data/projects/example-study.'
            : showRootRequired && root.trim().length === 0
              ? 'Enter the project root directory.'
              : ''
        }
      >
        <PathInput
          t={t}
          value={root}
          onChange={onRoot}
          onBrowse={onBrowseRoot}
          placeholder="/path/to/example-study"
          ariaLabel="Project root directory"
          // A typed root that is not absolute is wrong at once; an empty
          // one only after the user leaves it or tries to continue.
          invalid={
            !isAbsoluteProjectRoot(root, pathStyle) &&
            (showRootRequired || root.trim().length > 0)
          }
          onBlur={() => onTouched('root')}
        />
      </Field>
    </div>
  )
}

/** State the research-use limit in one quiet line. */
function WhatIsSupraspina(props: { t: Theme }): ReactNode {
  const { t } = props
  return (
    <Hint t={t}>
      For research use only; not for diagnosis or clinical decisions.
    </Hint>
  )
}

interface StepDataProps {
  t: Theme
  rawData: string
  onRawData: (v: string) => void
  onBrowseRawData?: (() => void) | undefined
  /** Whether an empty input data folder is marked as an error yet. */
  showRawDataRequired: boolean
  /** Report that the user left a required field. */
  onTouched: (field: RequiredField) => void
  rawDataExists: boolean | null
  subjectGlob: string
  onSubjectGlob: (v: string) => void
  t1Pattern: string
  onT1Pattern: (v: string) => void
  subjectDraft: string
  onSubjectDraft: (v: string) => void
  subjectDraftValid: boolean
  subjectDraftDuplicate: boolean
  /** Whether the include draft is already in the exclude list. */
  subjectDraftConflict: boolean
  subjectIds: string[]
  subjectIdsValid: boolean
  onAddSubject: () => void
  onRemoveSubject: (id: string) => void
  exclude: SubjectListState
}

/** The required Setup fields that open empty on a new project. */
type RequiredField = 'name' | 'root' | 'rawData'

function rawDataHint(value: string, exists: boolean | null): string {
  if (value.trim().length === 0) return 'Required'
  if (exists === false) return 'Choose a path that exists on this host.'
  return 'Supraspina searches inside this folder.'
}

function StepData(props: StepDataProps): ReactNode {
  const {
    t,
    rawData,
    onRawData,
    onBrowseRawData,
    showRawDataRequired,
    onTouched,
    rawDataExists,
    subjectGlob,
    onSubjectGlob,
    t1Pattern,
    onT1Pattern,
    subjectDraft,
    onSubjectDraft,
    subjectDraftValid,
    subjectDraftDuplicate,
    subjectDraftConflict,
    subjectIds,
    subjectIdsValid,
    onAddSubject,
    onRemoveSubject,
    exclude,
  } = props
  const [rulesOpen, setRulesOpen] = useState(false)
  return (
    <div style={stepBodyStyle()}>
      <StepIntro
        t={t}
        text="Choose the folder that contains your subject image files. The rules below find subjects and T1 scans."
      />
      <Field
        t={t}
        label="Input data folder"
        hint={rawDataHint(rawData, rawDataExists)}
      >
        <PathInput
          t={t}
          value={rawData}
          onChange={onRawData}
          onBrowse={onBrowseRawData}
          placeholder="/path/to/example-study/rawdata"
          ariaLabel="Input data folder"
          invalid={showRawDataRequired && rawData.trim().length === 0}
          onBlur={() => onTouched('rawData')}
        />
      </Field>
      <MatchingSummary t={t} subjectGlob={subjectGlob} t1Pattern={t1Pattern} />
      <SubjectListEditor
        t={t}
        copy={INCLUDE_LIST_COPY}
        draft={subjectDraft}
        onDraft={onSubjectDraft}
        draftValid={subjectDraftValid}
        draftDuplicate={subjectDraftDuplicate}
        draftConflict={subjectDraftConflict}
        ids={subjectIds}
        idsValid={subjectIdsValid}
        subjectGlob={subjectGlob}
        onAdd={onAddSubject}
        onRemove={onRemoveSubject}
      />
      <SubjectListEditor
        t={t}
        copy={EXCLUDE_LIST_COPY}
        {...exclude}
        subjectGlob={subjectGlob}
        overlap={subjectIds.filter((id) => exclude.ids.includes(id))}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* A disclosure, not a toggle: a constant label, a chevron, and the
            same look open or closed. The region stays in the DOM, hidden while
            closed, so aria-controls always resolves. */}
        <Btn
          t={t}
          label="Advanced matching rules"
          ariaExpanded={rulesOpen}
          ariaControls="setup-data-matching-rules"
          onClick={() => setRulesOpen((open) => !open)}
          style={{ alignSelf: 'flex-start' }}
        />
        <div
          id="setup-data-matching-rules"
          hidden={!rulesOpen}
          style={{
            display: rulesOpen ? 'flex' : 'none',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {rulesOpen && (
            <MatchingRuleFields
              t={t}
              subjectGlob={subjectGlob}
              onSubjectGlob={onSubjectGlob}
              t1Pattern={t1Pattern}
              onT1Pattern={onT1Pattern}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function MatchingSummary(props: {
  t: Theme
  subjectGlob: string
  t1Pattern: string
}): ReactNode {
  const { t, subjectGlob, t1Pattern } = props
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 6,
        border: `1px solid ${t.borderSoft}`,
        background: t.surface2,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: t.textStrong,
          fontFamily: FONTS.sans,
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        <Ico d={ICONS.search} />
        Supraspina search rules
      </div>
      <MatchRuleRow
        t={t}
        label="Subject folders"
        value={subjectGlob}
        text="Matches folder names inside the input data folder."
      />
      <MatchRuleRow
        t={t}
        label="T1 scans"
        value={t1Pattern}
        text="Matches files anywhere inside each subject folder."
      />
      <p
        style={{
          margin: 0,
          color: t.dim,
          fontFamily: FONTS.sans,
          fontSize: 11.5,
          lineHeight: 1.45,
        }}
      >
        Standard sub-* folders and custom folders that follow the selected
        naming rules both work.
      </p>
    </div>
  )
}

function MatchRuleRow(props: {
  t: Theme
  label: string
  value: string
  text: string
}): ReactNode {
  const { t, label, value, text } = props
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '130px minmax(0, 1fr)',
        gap: 10,
        alignItems: 'baseline',
      }}
    >
      <span
        style={{
          color: t.dim,
          fontFamily: FONTS.sans,
          fontSize: 11.5,
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: t.text,
          fontFamily: FONTS.sans,
          fontSize: 11.5,
          minWidth: 0,
        }}
      >
        <code
          style={{
            fontFamily: FONTS.mono,
            fontSize: 11,
            color: t.textStrong,
            background: t.bg,
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 3,
            padding: '1px 4px',
            marginRight: 6,
          }}
        >
          {value || '(empty)'}
        </code>
        {text}
      </span>
    </div>
  )
}

function formatCheckedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Check time unknown.'
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const time = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
  if (sameDay) return `Checked at ${time}.`
  const day = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date)
  return `Checked ${day} at ${time}.`
}

interface StepEnvironmentProps {
  t: Theme
  loading: boolean
  error: string | null
  report: EnvReport | null
  /** The pipeline-aware requirement state of every check. */
  applicability: EnvApplicability
  tally: {
    found: number
    warn: number
    missing: number
    criticals: EnvCheck[]
  } | null
  expanded: Record<string, boolean>
  onToggleGroup: (name: string) => void
  onRecheck: () => void
  safeExecution: boolean
  onSafeExecution: (next: boolean) => void
  copiedFix: string | null
  /** The check id of the unsettled installation, or null when none runs. */
  installingFix: string | null
  /** The latest installation per check id, running or settled. */
  installs: Record<string, EnvInstallState>
  /** The live PyBrainAge setup progress, or null before the first run. */
  setupState: PybrainageSetupState | null
  /** Whether the shared PyBrainAge setup flow is currently running. */
  setupRunning: boolean
  onCopyFix: (check: EnvCheck) => void
  onGetIt: (check: EnvCheck) => void
  onInstall: (check: EnvCheck) => void
  /** Open the PyBrainAge setup confirmation from an action-carrying row. */
  onSetupAction: () => void
  onOpenEnvironment: () => void
}

/** The typed action kinds the wizard wires on environment rows. */
const WIZARD_ACTION_KINDS: ReadonlySet<EnvCheckAction['kind']> = new Set([
  'setup-pybrainage',
])

function StepEnvironment(props: StepEnvironmentProps): ReactNode {
  const {
    t,
    loading,
    error,
    report,
    applicability,
    tally,
    expanded,
    onToggleGroup,
    onRecheck,
    safeExecution,
    onSafeExecution,
    copiedFix,
    installingFix,
    installs,
    setupState,
    setupRunning,
    onCopyFix,
    onGetIt,
    onInstall,
    onSetupAction,
    onOpenEnvironment,
  } = props

  if (loading) {
    return (
      <div style={stepBodyStyle()}>
        <StepIntro t={t} text="Checking the environment..." />
        <LoadingState t={t} label="Running the environment check..." />
      </div>
    )
  }

  if (error) {
    return (
      <div style={stepBodyStyle()}>
        <div
          role="alert"
          style={{
            fontFamily: FONTS.sans,
            fontSize: 12.5,
            color: t.failed,
            background: t.failedSoft,
            border: `1px solid ${t.failed}`,
            borderRadius: 8,
            padding: '10px 12px',
          }}
        >
          The environment check failed: <RawError error={error} />
        </div>
        <Btn
          t={t}
          label="Retry"
          icon={<Ico d={ICONS.refresh} size={ICON_SIZE.nav} />}
          onClick={onRecheck}
        />
      </div>
    )
  }

  if (!tally) {
    return (
      <div style={stepBodyStyle()}>
        <StepIntro
          t={t}
          text="No environment check has run for this project yet."
        />
        <Btn
          t={t}
          label="Run check"
          icon={<Ico d={ICONS.refresh} size={ICON_SIZE.nav} />}
          onClick={onRecheck}
        />
      </div>
    )
  }

  const groups = report?.groups ?? []
  return (
    <div style={stepBodyStyle()}>
      <StepIntro
        t={t}
        text="Lists the tools each pipeline stage needs. Setup can continue while tools are missing, and they can be installed later. All-green groups stay collapsed until opened."
      />
      <SetupEnvSummary t={t} tally={tally} />
      {tally.missing > 0 && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            background: t.surface2,
            border: `1px solid ${t.border}`,
            borderLeft: `3px solid ${t.warning}`,
            borderRadius: 8,
            padding: '10px 12px',
          }}
        >
          <span style={{ display: 'inline-flex', marginTop: 1, flexShrink: 0 }}>
            <NoticeGlyph t={t} tone="warn" />
          </span>
          <span
            style={{
              fontFamily: FONTS.sans,
              fontSize: 12.5,
              lineHeight: 1.5,
              color: t.textSoft,
            }}
          >
            {tally.missing} tool{tally.missing === 1 ? ' is' : 's are'} missing.
            Setup can continue now; each dependent pipeline stage stays blocked
            until its tool is installed.
          </span>
        </div>
      )}
      {/* The summary above states whether all required checks passed. */}
      <Card t={t} title="Required before running" padded={false}>
        <div
          role="list"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '10px 12px',
          }}
        >
          {groups.map((group) => (
            <GroupSection
              key={group.name}
              t={t}
              group={group}
              applicability={applicability}
              idPrefix="wizard"
              open={expanded[group.name] ?? false}
              onToggle={() => onToggleGroup(group.name)}
              safeExecution={safeExecution}
              installing={installingFix}
              copiedToken={copiedFix}
              installs={installs}
              setupRunning={setupRunning}
              onCopyFix={onCopyFix}
              onGetIt={onGetIt}
              onInstall={onInstall}
              onAction={() => onSetupAction()}
              actionKinds={WIZARD_ACTION_KINDS}
            />
          ))}
        </div>
        {setupState && (
          <div style={{ padding: '0 12px 10px' }}>
            <PybrainageSetupProgress t={t} state={setupState} />
          </div>
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            padding: '10px 12px',
            borderTop: `1px solid ${t.borderSoft}`,
          }}
        >
          {!safeExecution && (
            <Btn
              t={t}
              label="Allow live runs"
              small
              secondary
              onClick={() => onSafeExecution(true)}
            />
          )}
          <Btn
            t={t}
            label="Open Diagnostics"
            small
            ghost
            icon={<Ico d={ICONS.external} size={ICON_SIZE.nav} />}
            onClick={onOpenEnvironment}
          />
        </div>
      </Card>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <Btn
          t={t}
          label="Re-check"
          small
          icon={<Ico d={ICONS.refresh} size={ICON_SIZE.nav} />}
          onClick={onRecheck}
        />
        {report?.capturedAt && (
          <span
            aria-live="polite"
            title={report.capturedAt}
            style={{
              fontFamily: FONTS.sans,
              fontSize: 11.5,
              color: t.dim,
              background: t.surface2,
              border: `1px solid ${t.borderSoft}`,
              borderRadius: 4,
              padding: '4px 7px',
            }}
          >
            {formatCheckedAt(report.capturedAt)}
          </span>
        )}
      </div>
    </div>
  )
}

function SetupEnvSummary(props: {
  t: Theme
  tally: {
    found: number
    warn: number
    missing: number
    criticals: EnvCheck[]
  }
}): ReactNode {
  const { t, tally } = props
  const ready = tally.criticals.length === 0
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        padding: '9px 11px',
        borderRadius: 6,
        background: ready ? t.doneSoft : t.surface2,
        border: `1px solid ${ready ? `color-mix(in srgb, ${t.done} 33%, transparent)` : t.borderSoft}`,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          fontFamily: FONTS.sans,
          fontSize: 12.5,
          fontWeight: 700,
          color: ready ? t.done : t.text,
        }}
      >
        <Ico d={ready ? ICONS.circleCheck : ICONS.circleAlert} />
        {ready
          ? 'All required checks passed.'
          : 'Some required checks need setup.'}
      </span>
      <span style={{ flex: 1 }} />
      <SetupEnvCount t={t} label="Ready" value={tally.found} color={t.done} />
      <SetupEnvCount
        t={t}
        label="Warnings"
        value={tally.warn}
        color={statusColor(t, 'warn')}
      />
      <SetupEnvCount
        t={t}
        label="Needs setup"
        value={tally.missing}
        color={t.failed}
      />
    </div>
  )
}

function SetupEnvCount(props: {
  t: Theme
  label: string
  value: number
  color: string
}): ReactNode {
  const { t, label, value, color } = props
  // Dim zero counts. Apply the status color only to live nonzero counts.
  const valueColor = value === 0 ? t.dimText : color
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 4,
        fontFamily: FONTS.sans,
        fontSize: 11.5,
        color: t.dim,
        whiteSpace: 'nowrap',
      }}
    >
      <strong
        style={{
          fontFamily: FONTS.sans,
          fontSize: 12,
          color: valueColor,
          fontWeight: 700,
        }}
      >
        {value}
      </strong>
      {label}
    </span>
  )
}

interface StepPipelineProps {
  t: Theme
  threads: string
  onThreads: (v: string) => void
}

function StepPipeline(props: StepPipelineProps): ReactNode {
  const { t, threads, onThreads } = props
  const [cpuCount, setCpuCount] = useState<number | null>(null)
  const threadsValid = Number.isInteger(Number(threads)) && Number(threads) >= 1
  const recommendedThreads = recommendedReconThreads(cpuCount)

  useEffect(() => {
    let cancelled = false
    getApi()
      .platform.cpuCount()
      .then((count) => {
        if (!cancelled) setCpuCount(count)
      })
      .catch(() => {
        if (!cancelled) setCpuCount(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div style={stepBodyStyle()}>
      <StepIntro
        t={t}
        text="New projects start with the standard workflow. Advanced step choices are set in Pipeline after setup."
      />
      <StandardWorkflowList t={t} />
      <Field
        t={t}
        label="Processing power per subject"
        info={`CPU threads are the parallel work units a processor can run at once. ${GLOSSARY.FreeSurfer}`}
        error={threadsValid ? '' : 'Enter an integer of 1 or more.'}
        hint={
          threadsValid
            ? 'The FreeSurfer CPU threads for each subject. A higher value finishes one subject faster but leaves less capacity for other subjects. Some steps split work across the left and right sides of the brain.'
            : ''
        }
      >
        <TextInput
          t={t}
          value={threads}
          onChange={onThreads}
          mono
          placeholder="4"
          ariaLabel="Processing power per subject"
          invalid={!threadsValid}
        />
      </Field>
      <ThreadRecommendation
        t={t}
        cpuCount={cpuCount}
        recommendedThreads={recommendedThreads}
      />
    </div>
  )
}

/**
 * Explain the ten Subjects milestones from the shared help map, each under
 * the name its Subjects column header shows. Keep the list collapsed by
 * default.
 */
function StandardWorkflowList(props: { t: Theme }): ReactNode {
  const { t } = props
  const [open, setOpen] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* A disclosure with a constant label that names the list it shows. */}
      <Btn
        t={t}
        label="Workflow milestones in Subjects"
        ariaExpanded={open}
        ariaControls="setup-standard-workflow-list"
        onClick={() => setOpen((v) => !v)}
        style={{ alignSelf: 'flex-start' }}
      />
      <div id="setup-standard-workflow-list" hidden={!open}>
        {open && (
          <ol
            aria-label="Workflow status milestones"
            style={{
              listStyle: 'none',
              margin: 0,
              padding: '12px 14px',
              borderRadius: 6,
              border: `1px solid ${t.borderSoft}`,
              background: t.surface2,
              display: 'flex',
              flexDirection: 'column',
              gap: 9,
            }}
          >
            {MATRIX_STEPS.map((mstep, i) => (
              <li
                key={mstep.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '20px minmax(0, 1fr)',
                  gap: 9,
                  alignItems: 'baseline',
                }}
              >
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 11,
                    fontWeight: 700,
                    color: t.dim,
                  }}
                >
                  {i + 1}
                </span>
                <span
                  style={{
                    fontFamily: FONTS.sans,
                    fontSize: 11.5,
                    lineHeight: 1.45,
                    color: t.text,
                    minWidth: 0,
                  }}
                >
                  <strong
                    style={{ color: t.textStrong, fontWeight: 700 }}
                  >{`${recentSubjectStepLabel(mstep.key)}. `}</strong>
                  {MATRIX_STEP_HELP[mstep.key]}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function ThreadRecommendation(props: {
  t: Theme
  cpuCount: number | null
  recommendedThreads: number
}): ReactNode {
  const { t, cpuCount, recommendedThreads } = props
  const threads = recommendedThreads === 1 ? 'thread' : 'threads'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '9px 10px',
        borderRadius: 6,
        border: `1px solid ${t.borderSoft}`,
        background: t.bg,
        color: t.text,
        fontFamily: FONTS.sans,
        fontSize: 12,
        lineHeight: 1.35,
      }}
    >
      <NoticeGlyph t={t} tone="info" color={t.text} />
      <span>
        {cpuCount
          ? `Recommended: ${recommendedThreads} CPU ${threads} per subject on this ${cpuCount}-thread workstation.`
          : `Recommended: ${recommendedThreads} CPU ${threads} per subject.`}
      </span>
    </div>
  )
}

/** The working values and handlers of one subject ID list in the Data step. */
interface SubjectListState {
  draft: string
  onDraft: (v: string) => void
  draftValid: boolean
  draftDuplicate: boolean
  /** Whether the draft is already in the other list. */
  draftConflict: boolean
  ids: string[]
  idsValid: boolean
  onAdd: () => void
  onRemove: (id: string) => void
}

/** The wording that tells the include and the exclude list apart. */
interface SubjectListCopy {
  label: string
  inputLabel: string
  listLabel: string
  /** The accessible name of Add; undefined keeps the visible label. */
  addLabel: string | undefined
  /** The accessible name of a remove button for one ID. */
  removeLabel: (id: string) => string
  conflictError: string
  emptyHint: (example: string) => string
  emptyText: string
}

const INCLUDE_LIST_COPY: SubjectListCopy = {
  label: 'Subjects to run (optional)',
  inputLabel: 'Subjects to run',
  listLabel: 'Included subjects',
  addLabel: undefined,
  removeLabel: (id) => `Remove ${id}`,
  conflictError: 'Already in Subjects to exclude',
  emptyHint: (example) =>
    `An empty list includes every matching subject; added subjects, for example ${example}, limit the run to those.`,
  emptyText: 'No subjects are listed, so the run includes every match.',
}

const EXCLUDE_LIST_COPY: SubjectListCopy = {
  label: 'Subjects to exclude (optional)',
  inputLabel: 'Subjects to exclude',
  listLabel: 'Excluded subjects',
  addLabel: 'Add excluded subject',
  removeLabel: (id) => `Remove ${id} from the excluded subjects`,
  conflictError: 'Already in Subjects to run',
  emptyHint: (example) =>
    `Added subjects, for example ${example}, are left out of every run and of the analysis cohort.`,
  emptyText: 'No subjects are excluded.',
}

interface SubjectListEditorProps extends SubjectListState {
  t: Theme
  copy: SubjectListCopy
  subjectGlob: string
  /** IDs in both lists, from a project file edited outside Setup. */
  overlap?: string[]
}

function SubjectListEditor(props: SubjectListEditorProps): ReactNode {
  const {
    t,
    copy,
    draft,
    onDraft,
    draftValid,
    draftDuplicate,
    draftConflict,
    ids,
    idsValid,
    subjectGlob,
    onAdd,
    onRemove,
    overlap = [],
  } = props
  const showError =
    draft.trim().length > 0 && (!draftValid || draftDuplicate || draftConflict)
  const canAdd = draftValid && !draftDuplicate && !draftConflict
  const example = subjectExampleFromPattern(subjectGlob)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Field
        t={t}
        label={copy.label}
        error={
          showError
            ? draftDuplicate
              ? 'Already added'
              : draftConflict
                ? copy.conflictError
                : `Match ${subjectGlob || 'the subject folder pattern'}.`
            : ''
        }
        hint={showError ? '' : ids.length === 0 ? copy.emptyHint(example) : ''}
      >
        <div style={{ display: 'flex', gap: 6 }}>
          <TextInput
            t={t}
            value={draft}
            onChange={onDraft}
            mono
            placeholder={example}
            ariaLabel={copy.inputLabel}
            invalid={showError}
          />
          <Btn
            t={t}
            label="Add"
            {...(copy.addLabel ? { ariaLabel: copy.addLabel } : {})}
            icon={<Ico d={ICONS.plus} size={ICON_SIZE.nav} />}
            disabled={!canAdd}
            onClick={onAdd}
            style={{ flexShrink: 0 }}
          />
        </div>
      </Field>
      {ids.length === 0 ? (
        <div
          style={{
            fontFamily: FONTS.sans,
            fontSize: 12,
            color: t.dim,
          }}
        >
          {copy.emptyText}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <ul
            aria-label={copy.listLabel}
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
            }}
          >
            {ids.map((id) => {
              const matches = subjectMatchesPattern(id, subjectGlob)
              return (
                <li key={id}>
                  <span
                    title={
                      matches
                        ? undefined
                        : `Match the subject folder pattern (${subjectGlob || 'unset'}) before continuing.`
                    }
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      background: matches ? t.surface2 : t.failedSoft,
                      border: `1px solid ${matches ? t.border : t.failed}`,
                      borderRadius: 999,
                      padding: '3px 4px 3px 10px',
                      fontFamily: FONTS.mono,
                      fontSize: 11.5,
                      color: matches ? t.text : t.failed,
                    }}
                  >
                    {id}
                    <IconButton
                      t={t}
                      d={ICONS.x}
                      ariaLabel={copy.removeLabel(id)}
                      onClick={() => onRemove(id)}
                      size={24}
                      iconSize={ICON_SIZE.inline}
                      style={{ borderRadius: 999 }}
                    />
                  </span>
                </li>
              )
            })}
          </ul>
          {!idsValid && (
            <div
              role="alert"
              style={{
                fontFamily: FONTS.sans,
                fontSize: 12,
                color: t.failed,
              }}
            >
              Remove subjects that no longer match the subject folder pattern.
            </div>
          )}
          {overlap.length > 0 && (
            <div
              style={{
                fontFamily: FONTS.sans,
                fontSize: 12,
                color: t.dim,
              }}
            >
              {overlap.join(', ')} {overlap.length === 1 ? 'is' : 'are'} also in
              Subjects to run; exclusion takes precedence, so{' '}
              {overlap.length === 1 ? 'it does' : 'they do'} not run.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface StepReviewProps {
  t: Theme
  name: string
  root: string
  rawData: string
  /** Whether any environment check the application knows about has finished. */
  envChecked: boolean
  envMissing: number
  hasProject: boolean
  threads: string
  subjectCount: number
  excludedCount: number
  busy: boolean
  error: string | null
}

function ReviewItem(props: {
  t: Theme
  title: string
  text: string
  detail?: string
  /** Whether the detail is a path, set in mono, or a sentence in sans. */
  detailPath?: boolean
  titleAccessory?: ReactNode
}): ReactNode {
  const { t, title, text, detail, detailPath = false, titleAccessory } = props
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '12px 0',
        borderTop: `1px solid ${t.borderSoft}`,
      }}
    >
      <div
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
            fontFamily: FONTS.sans,
            fontSize: 12.5,
            fontWeight: 700,
            color: t.textStrong,
          }}
        >
          {title}
          {titleAccessory}
        </div>
        <div
          style={{
            fontFamily: FONTS.sans,
            fontSize: 12,
            lineHeight: 1.45,
            color: t.text,
          }}
        >
          {text}
        </div>
        {detail && (
          <div
            style={{
              fontFamily: detailPath ? FONTS.mono : FONTS.sans,
              fontSize: 11.5,
              lineHeight: 1.45,
              color: t.dim,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={detail}
          >
            {detail}
          </div>
        )}
      </div>
    </div>
  )
}

function StepReview(props: StepReviewProps): ReactNode {
  const {
    t,
    name,
    root,
    rawData,
    envChecked,
    envMissing,
    hasProject,
    threads,
    subjectCount,
    excludedCount,
    busy,
    error,
  } = props
  const envText = !envChecked
    ? 'The required tools are not checked yet; the Environment step checks them.'
    : envMissing === 0
      ? 'The required environment checks passed.'
      : `${envMissing} tool${envMissing === 1 ? ' is' : 's are'} missing. Every dependent stage stays blocked until installation finishes.`
  const includeText =
    subjectCount === 0
      ? 'Runs include every subject found by the Data step.'
      : `Runs include only the ${subjectCount} subject${subjectCount === 1 ? '' : 's'} added in Data.`
  const subjectText =
    excludedCount === 0
      ? includeText
      : `${includeText} The ${excludedCount === 1 ? 'subject' : `${excludedCount} subjects`} excluded in Data ${excludedCount === 1 ? 'stays' : 'stay'} out of every run and the analysis cohort.`
  const threadText = `${threads} CPU thread${threads === '1' ? '' : 's'} per subject`
  // Setup never changes stage choices, so only a new project is known to
  // carry the standard workflow.
  const pipelineText = hasProject
    ? `Stage choices stay as set in Pipeline and run with ${threadText}.`
    : `The standard workflow runs with ${threadText}.`
  return (
    <div style={stepBodyStyle()}>
      <StepIntro
        t={t}
        text={
          hasProject
            ? 'A summary of the project. Save changes writes these settings to the project file and returns to the dashboard.'
            : 'A summary of your choices. Create project creates the project, saves these settings, and opens its dashboard.'
        }
      />
      <div
        style={{
          border: `1px solid ${t.borderSoft}`,
          borderRadius: 6,
          background: t.surface,
          padding: '0 12px',
        }}
      >
        <div style={{ marginTop: -1 }}>
          <ReviewItem
            t={t}
            title={name || 'Untitled project'}
            text={
              hasProject
                ? 'The setup is saved to this project folder.'
                : 'This project folder is created, and the setup is saved there.'
            }
            detail={root || '(project folder not set)'}
            detailPath={root !== ''}
          />
          <ReviewItem
            t={t}
            title="Input data"
            text={subjectText}
            detail={rawData || '(input folder not set)'}
            detailPath={rawData !== ''}
          />
          <ReviewItem
            t={t}
            title="Environment"
            text={envText}
            titleAccessory={
              <Chip
                t={t}
                status={
                  !envChecked ? 'pending' : envMissing === 0 ? 'done' : 'warn'
                }
                label={
                  !envChecked
                    ? 'Not checked'
                    : envMissing === 0
                      ? 'Passed'
                      : 'Needs setup'
                }
                small
                title={
                  !envChecked
                    ? 'The environment is not checked yet.'
                    : envMissing === 0
                      ? 'Environment checks passed.'
                      : 'Environment setup is not finished.'
                }
              />
            }
          />
          <ReviewItem t={t} title="Pipeline" text={pipelineText} />
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          background: t.surface2,
          border: `1px solid ${t.border}`,
          borderRadius: 8,
          padding: '10px 12px',
        }}
      >
        <span style={{ display: 'inline-flex', marginTop: 1 }}>
          <NoticeGlyph t={t} tone="warn" />
        </span>
        <span
          style={{
            fontFamily: FONTS.sans,
            fontSize: 12,
            lineHeight: 1.5,
            color: t.textSoft,
          }}
        >
          Any installation or command that changes files needs Allow live runs,
          which is set in Settings.
        </span>
      </div>
      {error && (
        <div
          role="alert"
          style={{
            fontFamily: FONTS.sans,
            fontSize: 12.5,
            color: t.failed,
            background: t.failedSoft,
            border: `1px solid ${t.failed}`,
            borderRadius: 8,
            padding: '10px 12px',
          }}
        >
          {hasProject
            ? 'These changes could not be saved:'
            : 'The project could not be created:'}{' '}
          <RawError error={error} />
        </div>
      )}
      {busy && (
        <LoadingState
          t={t}
          label={
            hasProject ? 'Saving the changes...' : 'Creating the project...'
          }
        />
      )}
    </div>
  )
}

/**
 * The raw message of a failed step on its own line in mono, below the sans
 * sentence that introduces it.
 */
function RawError({ error }: { error: string }): ReactNode {
  return (
    <span
      style={{
        display: 'block',
        marginTop: 4,
        fontFamily: FONTS.mono,
        fontSize: 11.5,
        overflowWrap: 'anywhere',
      }}
    >
      {error}
    </span>
  )
}
