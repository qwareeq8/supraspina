/**
 * Owns shared renderer state for presentation, navigation, projects, execution,
 * cohorts, QC, and the host. Main validates and persists machine-local preferences.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import {
  DENSITY,
  THEMES,
  highContrastTheme,
  type Density,
  type Theme,
} from '../theme/tokens'
import { getApi } from './api'
import type { ExecutionFailure } from './execution-feedback'
import type { SubjectDisplayBucket } from './subject-runtime-status'
import { NOT_RUN_STATUSES, type NotRunRecord } from './terminal-reason'
import { loadRecentProjects, rememberRecentProject } from './recent-projects'
import {
  DEFAULT_PROJECT_CONFIG,
  validateProjectConfig,
} from '../../shared/project-schema'
import type { ProjectConfig } from '../../shared/project-schema'
import type {
  HostState,
  ProjectOpenResult,
  ProjectSaveResult,
  QcWriteResult,
  SupraspinaApi,
  WorkflowResult,
  WorkflowTarget,
} from '../../shared/contract'
import type { ProjectRef, Subject, ToolStatus } from '../../shared/types'
import { WIZARD_LAST_STEP, type StepKey } from '../../shared/steps'
import {
  effectiveQcVerdict,
  isAnalysisEligible,
  normalizeAnalysisEligibility,
  normalizeAnalysisSubjects,
  subjectsInConfigScope,
} from '../../shared/analysis-cohort'
import {
  DEFAULT_MACHINE_PREFERENCES,
  sanitizeMachinePreferences,
  validateMachinePreferencesPatch,
  type MachinePreferences,
  type MachinePreferencesState,
  type ResolvedTheme,
} from '../../shared/preferences'

function sameProjectRef(left: ProjectRef | null, right: ProjectRef): boolean {
  return (
    left?.projectId === right.projectId &&
    left.root === right.root &&
    left.configPath === right.configPath &&
    left.epoch === right.epoch
  )
}

/** Validate an untrusted project response before publishing any of its state. */
function requireProjectOpenResult(value: unknown): ProjectOpenResult {
  if (value === null || typeof value !== 'object') {
    throw new Error('The host returned an invalid project response.')
  }
  const candidate = value as Partial<ProjectOpenResult>
  const project = candidate.project
  if (
    !project ||
    typeof project.projectId !== 'string' ||
    typeof project.root !== 'string' ||
    typeof project.configPath !== 'string' ||
    typeof project.epoch !== 'number' ||
    typeof candidate.configSha256 !== 'string'
  ) {
    throw new Error('The host returned an invalid project identity.')
  }
  const validation = validateProjectConfig(candidate.cfg)
  if (!validation.ok || !validation.data) {
    throw new Error(
      validation.errors[0] ?? 'The host returned an invalid project config.',
    )
  }
  return {
    project,
    cfg: validation.data,
    configSha256: candidate.configSha256,
  }
}

/** The routes addressable from the left rail. */
export type Route =
  | 'project'
  | 'subjects'
  | 'diagnostics'
  | 'pipeline'
  | 'runs'
  | 'logs'
  | 'qc'
  | 'inputQc'
  | 'results'
  | 'analysis'
  | 'registry'
  | 'settings'
  | 'wizard'

/**
 * The subject filter used by dashboard deep links and the Subjects screen:
 * every subject, or one shared display bucket.
 */
export type SubjectFilter = 'all' | SubjectDisplayBucket

/** An alias of the validated main-owned preference fields for the renderer. */
export type Tweaks = Omit<MachinePreferences, 'schemaVersion'>

/** The application context value. */
/** The launch feedback the Runs screen keeps across route changes. */
export interface RunsFeedback {
  error: ExecutionFailure | null
  notice: string | null
  outcome: WorkflowResult | null
  stageOutcome: { stepKey: StepKey; message: string } | null
}

const EMPTY_RUNS_FEEDBACK: RunsFeedback = {
  error: null,
  notice: null,
  outcome: null,
  stageOutcome: null,
}

/**
 * The plan nodes that did not run, with their reasons, of each run Supraspina
 * started for the open project, by run. A node the plan already blocked
 * never becomes a job, so the plan is the only record of the subjects its
 * reason belongs to, and the Runs feedback keeps only the latest outcome.
 */
export type RunPlanRecords = ReadonlyMap<string, readonly NotRunRecord[]>

const EMPTY_RUN_PLAN_RECORDS: RunPlanRecords = new Map()

/** How many runs' plan records the shell keeps, as the runtime lists runs. */
const RUN_PLAN_RECORD_LIMIT = 100

/** The Runs card that started a launch. */
export type LaunchOrigin =
  | { kind: 'workflow' | 'resume' | 'retry-cancelled' | 'clean-retry' }
  | { kind: 'stage'; stepKey: StepKey }

/**
 * A launch whose plan Supraspina is preparing. One pending plan holds the run
 * dock, the shortcuts, the command palette, every Runs launch control, and
 * the Logs node retry, whichever of them started it.
 */
export interface PendingPlan {
  /** The progress line shown while the plan is prepared. */
  label: string
  /** The reason every other launch and recovery control waits. */
  waitReason: string
  /**
   * The Runs card that started the plan, which repeats the progress line, or
   * null for the dock, a shortcut, the palette, or a Logs node retry.
   */
  card: LaunchOrigin | null
  /**
   * Whether the plan leaves the Runs feedback in place: true for a Logs node
   * retry, whose outcome Logs reports, so Runs keeps following the failed
   * run until a later run recovers it.
   */
  keepsRunsFeedback?: boolean
}

export interface AppState {
  t: Theme
  resolvedTheme: ResolvedTheme
  density: Density
  tweaks: Tweaks
  route: Route
  setRoute: (route: Route) => void
  subjectsFilter: SubjectFilter
  setSubjectsFilter: (filter: SubjectFilter) => void
  /**
   * Focus Results on the first artifact produced by this stage. Set this target from
   * the finished-stage action, and clear it with null.
   */
  resultsStage: StepKey | null
  setResultsStage: (stage: StepKey | null) => void
  /**
   * Focus Logs on this run once. The Dashboard's Recent runs sets it before
   * opening Logs, and Logs clears it with null after focusing the run, so a
   * later visit opens on its default run.
   */
  logsFocusRunId: string | null
  /**
   * The stage whose newest job of the handed-over run Logs selects, as a
   * Runs stage card's View log hands it over; null selects the run's first
   * listed job.
   */
  logsFocusStepKey: StepKey | null
  /** Hand a run, and optionally one of its stages, over to Logs once. */
  setLogsFocusRunId: (runId: string | null, stepKey?: StepKey | null) => void
  setTweaks: (patch: Partial<Tweaks>) => void
  resetTweaks: () => void
  hostState: HostState | null
  refreshHostState: () => void

  cfg: ProjectConfig
  setCfg: (next: ProjectConfig) => void
  /**
   * Track whether this session created or opened a real project. Gate navigation and
   * execution on this value. Do not derive it from `paths.projectRoot` because an
   * in-progress wizard can set a root before writing a project.
   */
  hasProject: boolean
  projectRef: ProjectRef | null
  projectEpoch: number
  configRevision: number
  /**
   * Reserve the generation for a new `project.create` request. Validate the response
   * against this exact reservation so a stale wizard epoch cannot be adopted.
   */
  reserveCreateEpoch: () => number
  savedRevision: number
  /**
   * Preserve the exact configuration that main last persisted. Send it with
   * {@link savedRevision} to saved-revision-scoped methods instead of sending a draft.
   */
  savedCfg: ProjectConfig
  getLifecycleSnapshot: () => { project: ProjectRef | null; dirty: boolean }
  configSha256: string
  openProject: (path: string) => Promise<void>
  markProjectCreated: (result: ProjectOpenResult) => void
  newProject: () => Promise<void>
  dirty: boolean
  saveProject: (candidate?: ProjectConfig) => Promise<ProjectSaveResult>
  discardChanges: () => Promise<void>
  saveState: {
    phase: 'idle' | 'validating' | 'saving' | 'error'
    error: string | null
  }
  safeExecution: boolean
  setSafeExecution: (next: boolean) => void
  selection: Set<string>
  executionTarget: WorkflowTarget
  selectAllSubjects: () => void
  setSelection: (next: ReadonlySet<string>) => void
  toggleSelection: (id: string) => void
  clearSelection: () => void
  /**
   * Return an explicit selection to the full analysis cohort once a live run
   * has started for exactly those subjects, so a later plan does not carry
   * the launched subjects without the operator choosing them again.
   */
  releaseLaunchSelection: (launchedSubjectIds: readonly string[]) => void
  subjects: Subject[]
  /**
   * Whether subject discovery has answered for the open project, with rows
   * or with an error. False from adopting a project until that answer, so an
   * empty {@link subjects} list then is a cohort still loading, not an empty
   * cohort. A later rediscovery keeps it true and keeps the previous rows.
   */
  discoveryAnswered: boolean
  /**
   * Whether a cohort rediscovery is in flight, so a Re-discover control can
   * show its busy state for the many seconds a large cohort takes.
   */
  subjectsDiscovering: boolean
  /**
   * When the last full discovery answered with rows (ISO 8601), or null
   * before one has. A single-subject refresh or a QC write leaves it alone.
   */
  subjectsDiscoveredAt: string | null
  refreshSubjects: () => void
  refreshSubject: (id: string) => Promise<void>
  /**
   * Publish a committed QC write on its subject row without detecting the
   * subject again, since a QC write changes no detector state. A write for
   * another project or an older revision than the row holds changes nothing,
   * and a refresh of that subject started before the write no longer lands.
   */
  applyQcWrite: (project: ProjectRef, result: QcWriteResult) => void
  /**
   * Publish a committed Set site write on the subjects it changed, so the
   * site summary moves at once instead of after the rediscovery that follows
   * it. A write for another project changes nothing, and a refresh of those
   * subjects started before the write no longer lands.
   */
  applySiteWrite: (
    project: ProjectRef,
    subjectIds: readonly string[],
    site: string | null,
  ) => void
  activeSubjectId: string | null
  setActiveSubjectId: (id: string | null) => void
  toolStatus: ToolStatus | null
  refreshToolStatus: () => void
  firstRun: boolean
  markFirstRunDone: () => void
  /**
   * Preserve the Setup wizard step across route changes and wizard remounts.
   */
  wizardStep: number
  setWizardStep: (next: number | ((prev: number) => number)) => void
  /**
   * Preserve the furthest reached wizard step across remounts. Reset it with
   * {@link wizardStep} after creating, opening, or starting a project.
   */
  wizardMaxReached: number
  setWizardMaxReached: (next: number | ((prev: number) => number)) => void
  /**
   * Keep the Runs screen's last launch feedback (failure, notice, outcome,
   * and the card it belongs to) while the operator visits other screens, so
   * a run that ends after they left is still reported when they return.
   */
  runsFeedback: RunsFeedback
  setRunsFeedback: Dispatch<SetStateAction<RunsFeedback>>
  /** The launch whose plan is being prepared, or null when none is. */
  pendingPlan: PendingPlan | null
  /**
   * Return the pending callback for one launch. It publishes the plan while
   * it is pending and clears it when that plan settles, leaving any other
   * plan and any newer project in place. Publishing a plan also clears the
   * project's Runs feedback, so the previous outcome never shows beside it,
   * unless the plan keeps it (a Logs node retry).
   */
  trackPlan: (plan: PendingPlan) => (pending: boolean) => void
  /** The not-run plan nodes of the runs started for the open project. */
  runPlanRecords: RunPlanRecords
  /**
   * Keep the not-run plan nodes of a started run for the open project; a
   * result without a run, or from an earlier project, leaves them alone.
   */
  recordRunPlan: (result: WorkflowResult) => void
}

/**
 * The defaults applied to each new profile. Lead with compact density while meeting
 * the WCAG 2.2 target and text-size floors. Let the first-run dialog and Settings
 * select roomier density. Keep this constant private, and expose reset through the
 * provider.
 */
const { schemaVersion: _defaultSchemaVersion, ...DEFAULT_TWEAKS } =
  DEFAULT_MACHINE_PREFERENCES
void _defaultSchemaVersion

/**
 * A dedicated local-storage sentinel marking completion of the first-run dialog.
 * Keep this sentinel independent from preferences so a preference reset does not
 * reopen the dialog.
 */
const FIRST_RUN_STORAGE_KEY = 'supraspinaFirstRunDone'

/**
 * The renderer epoch floor retained in local storage across reloads and recreated
 * windows. Keep it aligned with main and supervised-runtime tombstones. Accept a
 * higher floor across a full restart because main accepts every newer safe integer.
 */
const PROJECT_EPOCH_STORAGE_KEY = 'supraspina:projectEpoch:v1'

function storedEpoch(storage: Storage, key: string): number {
  const value = Number(storage.getItem(key))
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function persistedProjectEpoch(): number {
  try {
    return storedEpoch(localStorage, PROJECT_EPOCH_STORAGE_KEY)
  } catch {
    // Preserve mount-local monotonicity when storage is unavailable.
    return 0
  }
}

function persistProjectEpoch(epoch: number): void {
  try {
    localStorage.setItem(PROJECT_EPOCH_STORAGE_KEY, String(epoch))
  } catch {
    // Preserve mount-local monotonicity through refs when storage is unavailable.
  }
}

/** Reserve and synchronously persist a strictly newer bounded epoch. */
function reserveProjectEpoch(...localFloors: number[]): number {
  const floor = Math.max(persistedProjectEpoch(), ...localFloors)
  if (!Number.isSafeInteger(floor) || floor >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      'Restart Supraspina before creating another project generation.',
    )
  }
  const epoch = floor + 1
  persistProjectEpoch(epoch)
  return epoch
}

function discoveryFingerprint(project: ProjectRef, cfg: ProjectConfig): string {
  return JSON.stringify({
    projectId: project.projectId,
    epoch: project.epoch,
    projectRoot: cfg.paths.projectRoot,
    rawdataDir: cfg.paths.rawdataDir,
    derivativesDir: cfg.paths.derivativesDir,
    subjectGlob: cfg.patterns.subjectGlob,
    t1Pattern: cfg.patterns.t1Pattern,
    include: cfg.subjects.include,
    exclude: cfg.subjects.exclude,
  })
}

function toolFingerprint(project: ProjectRef, cfg: ProjectConfig): string {
  return JSON.stringify({
    projectId: project.projectId,
    epoch: project.epoch,
    platform: cfg.platform,
    tools: cfg.tools,
    pybrain: cfg.pybrain,
    enigmaBackend: cfg.steps.enigma?.params['backend'],
    pybrainOverrides: cfg.steps.pybrainage?.params,
    renderFinalReport: cfg.steps.final?.params['renderReport'],
  })
}

/** Track whether this is the very first launch (no first-run sentinel persisted). */
function readFirstRun(): boolean {
  try {
    return localStorage.getItem(FIRST_RUN_STORAGE_KEY) === null
  } catch {
    // Suppress the dialog when sandbox or test storage is unavailable.
    return false
  }
}

/** Resolve System synchronously so the first renderer paint matches Chromium. */
function resolveRendererTheme(theme: Tweaks['theme']): ResolvedTheme {
  if (theme !== 'system') return theme
  return typeof matchMedia === 'function' &&
    matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

const AppContext = createContext<AppState | null>(null)

/** Provide application state to the tree. */
export function AppProvider({ children }: { children: ReactNode }): ReactNode {
  const [tweaks, setTweaksState] = useState<Tweaks>(DEFAULT_TWEAKS)
  const tweaksRef = useRef(tweaks)
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveRendererTheme(DEFAULT_TWEAKS.theme),
  )
  const [route, setRoute] = useState<Route>('wizard')
  const [subjectsFilter, setSubjectsFilter] = useState<SubjectFilter>('all')
  // Share the stage target between finished Runs cards and Results artifact focus.
  const [resultsStage, setResultsStage] = useState<StepKey | null>(null)
  // Hand a run, and optionally a stage of it, to Logs, which reads the
  // hand-off once and clears it.
  const [logsFocus, setLogsFocus] = useState<{
    runId: string
    stepKey: StepKey | null
  } | null>(null)
  const logsFocusRunId = logsFocus?.runId ?? null
  const logsFocusStepKey = logsFocus?.stepKey ?? null
  const setLogsFocusRunId = useCallback(
    (runId: string | null, stepKey: StepKey | null = null): void =>
      setLogsFocus(runId === null ? null : { runId, stepKey }),
    [],
  )

  const [cfg, setCfgState] = useState<ProjectConfig>(DEFAULT_PROJECT_CONFIG)
  const cfgRef = useRef(cfg)
  const [projectRef, setProjectRef] = useState<ProjectRef | null>(null)
  const projectRefRef = useRef<ProjectRef | null>(null)
  // Reserve once during renderer bootstrap. Make the first Create request newer than
  // every project accepted before a reload.
  const [projectEpoch, setProjectEpoch] = useState(() => reserveProjectEpoch(0))
  const projectEpochRef = useRef(projectEpoch)
  const projectRequestEpochRef = useRef(projectEpoch)
  const projectOpenInFlightRef = useRef(false)
  const projectLoadTokenRef = useRef(0)
  const subjectsRequestTokenRef = useRef(0)
  const subjectRequestTokensRef = useRef<Map<string, number>>(new Map())
  const toolRequestTokenRef = useRef(0)
  const lastDiscoveryFingerprintRef = useRef('')
  const lastToolFingerprintRef = useRef('')
  const reattachGenerationRef = useRef('')
  const reattachFailureCountRef = useRef(0)
  const reattachRetryTimerRef = useRef<number | null>(null)
  const [reattachRetryTick, setReattachRetryTick] = useState(0)
  const [configRevision, setConfigRevision] = useState(0)
  const configRevisionRef = useRef(0)
  const [savedRevision, setSavedRevision] = useState(0)
  const savedRevisionRef = useRef(0)
  const [savedCfg, setSavedCfgState] = useState<ProjectConfig>(
    DEFAULT_PROJECT_CONFIG,
  )
  const savedCfgRef = useRef<ProjectConfig>(DEFAULT_PROJECT_CONFIG)
  const [configSha256, setConfigSha256] = useState('')
  const configSha256Ref = useRef('')
  const [saveState, setSaveState] = useState<AppState['saveState']>({
    phase: 'idle',
    error: null,
  })
  const savePromiseRef = useRef<Promise<ProjectSaveResult> | null>(null)
  const dirty = configRevision !== savedRevision
  // Preserve the Setup step in the shell across route changes.
  const [wizardStep, setWizardStep] = useState<number>(0)
  // Preserve the furthest reached step so remounts do not relock completed steps.
  const [wizardMaxReached, setWizardMaxReached] = useState<number>(0)
  // Bind the Runs feedback to the project generation so a new project never
  // shows the previous project's run outcome.
  const [runsFeedbackEntry, setRunsFeedbackEntry] = useState<{
    epoch: number
    value: RunsFeedback
  }>({ epoch: 0, value: EMPTY_RUNS_FEEDBACK })
  const runsFeedback =
    runsFeedbackEntry.epoch === projectEpoch
      ? runsFeedbackEntry.value
      : EMPTY_RUNS_FEEDBACK
  const setRunsFeedback = useCallback<Dispatch<SetStateAction<RunsFeedback>>>(
    (action) => {
      setRunsFeedbackEntry((previous) => {
        // A launch from an earlier project can settle after a newer project
        // opened; its result must not replace the newer project's feedback.
        if (previous.epoch > projectEpoch) return previous
        const current =
          previous.epoch === projectEpoch ? previous.value : EMPTY_RUNS_FEEDBACK
        const next = typeof action === 'function' ? action(current) : action
        return { epoch: projectEpoch, value: next }
      })
    },
    [projectEpoch],
  )
  // Share the pending plan between the shell and Runs, bound to the project
  // generation: a plan that settles after the project changed leaves the
  // newer project's state alone.
  const [pendingPlanEntry, setPendingPlanEntry] = useState<{
    epoch: number
    value: PendingPlan | null
  }>({ epoch: 0, value: null })
  const pendingPlan =
    pendingPlanEntry.epoch === projectEpoch ? pendingPlanEntry.value : null
  const trackPlan = useCallback(
    (plan: PendingPlan) => (pending: boolean) => {
      setPendingPlanEntry((previous) => {
        if (previous.epoch > projectEpoch) return previous
        const current = previous.epoch === projectEpoch ? previous.value : null
        const next = pending ? plan : current === plan ? null : current
        return { epoch: projectEpoch, value: next }
      })
      // A plan whose outcome Runs shows replaces the previous Runs outcome
      // whichever control started it, so Runs never shows a finished result
      // beside the pending line. A Logs retry reports in Logs; clearing here
      // would drop the failed run Runs follows, so its alert would vanish
      // on a closed review and never give way to the recovery notice.
      if (pending && !plan.keepsRunsFeedback) {
        setRunsFeedback(EMPTY_RUNS_FEEDBACK)
      }
    },
    [projectEpoch, setRunsFeedback],
  )
  // Keep what each started run's plan recorded apart from the Runs feedback,
  // which the next plan clears, bound to the project generation like it.
  const [runPlanRecordsEntry, setRunPlanRecordsEntry] = useState<{
    epoch: number
    value: RunPlanRecords
  }>({ epoch: 0, value: EMPTY_RUN_PLAN_RECORDS })
  const runPlanRecords =
    runPlanRecordsEntry.epoch === projectEpoch
      ? runPlanRecordsEntry.value
      : EMPTY_RUN_PLAN_RECORDS
  const recordRunPlan = useCallback(
    (result: WorkflowResult) => {
      const { runId } = result
      if (!runId) return
      const records: NotRunRecord[] = result.plan.nodes
        .filter((node) => NOT_RUN_STATUSES.has(node.status) && node.reason)
        .map(({ stepKey, subjectId, status, reason }) => ({
          stepKey,
          subjectId,
          status,
          reason,
        }))
      if (records.length === 0) return
      setRunPlanRecordsEntry((previous) => {
        if (previous.epoch > projectEpoch) return previous
        const current =
          previous.epoch === projectEpoch
            ? previous.value
            : EMPTY_RUN_PLAN_RECORDS
        const next = new Map(current)
        next.delete(runId)
        next.set(runId, records)
        for (const oldest of next.keys()) {
          if (next.size <= RUN_PLAN_RECORD_LIMIT) break
          next.delete(oldest)
        }
        return { epoch: projectEpoch, value: next }
      })
    },
    [projectEpoch],
  )
  const [safeExecution, setSafeExecutionState] = useState<boolean>(false)
  const safeExecutionRef = useRef(false)
  const savedSafeExecutionRef = useRef(false)
  const [selection, setSelectionState] = useState<Set<string>>(
    () => new Set<string>(),
  )
  const selectionRef = useRef<Set<string>>(selection)
  const [selectionMode, setSelectionMode] = useState<'all' | 'explicit'>('all')
  const selectionModeRef = useRef<'all' | 'explicit'>('all')
  const [subjects, setSubjects] = useState<Subject[]>([])
  const subjectsRef = useRef<Subject[]>(subjects)
  const [discoveryAnswered, setDiscoveryAnswered] = useState(false)
  const [subjectsDiscovering, setSubjectsDiscovering] = useState(false)
  const [subjectsDiscoveredAt, setSubjectsDiscoveredAt] = useState<
    string | null
  >(null)
  const [activeSubjectId, setActiveSubjectId] = useState<string | null>(null)
  const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null)
  // Read once during mount, and let `markFirstRunDone()` drive the transition.
  const [firstRun, setFirstRun] = useState<boolean>(readFirstRun)
  const [hostState, setHostState] = useState<HostState | null>(null)
  const preferenceMutationRef = useRef(0)

  const applyPreferenceState = useCallback(
    (state: MachinePreferencesState): void => {
      const { schemaVersion: _schemaVersion, ...next } = state.preferences
      void _schemaVersion
      tweaksRef.current = next
      setTweaksState(next)
      setResolvedTheme(state.resolvedTheme)
    },
    [],
  )

  const setTweaks = useCallback(
    (patch: Partial<Tweaks>): void => {
      let safePatch: Partial<Tweaks>
      try {
        safePatch = validateMachinePreferencesPatch(patch)
      } catch {
        return
      }
      const { schemaVersion: _schemaVersion, ...next } =
        sanitizeMachinePreferences({
          ...tweaksRef.current,
          ...safePatch,
        })
      void _schemaVersion
      tweaksRef.current = next
      setTweaksState(next)
      setResolvedTheme(resolveRendererTheme(next.theme))
      const request = ++preferenceMutationRef.current
      const preferences = (
        getApi() as SupraspinaApi & {
          preferences?: SupraspinaApi['preferences']
        }
      ).preferences
      if (!preferences) return
      void preferences
        .patch(safePatch)
        .then((state) => {
          if (request === preferenceMutationRef.current) {
            applyPreferenceState(state)
          }
        })
        .catch(() => {
          if (request !== preferenceMutationRef.current) return
          void preferences
            .get()
            .then(applyPreferenceState)
            .catch(() => undefined)
        })
    },
    [applyPreferenceState],
  )

  const resetTweaks = useCallback((): void => {
    const { schemaVersion: _schemaVersion, ...defaults } =
      DEFAULT_MACHINE_PREFERENCES
    void _schemaVersion
    tweaksRef.current = defaults
    setTweaksState(defaults)
    setResolvedTheme(resolveRendererTheme(defaults.theme))
    const request = ++preferenceMutationRef.current
    const preferences = (
      getApi() as SupraspinaApi & { preferences?: SupraspinaApi['preferences'] }
    ).preferences
    if (!preferences) return
    void preferences
      .reset()
      .then((state) => {
        if (request === preferenceMutationRef.current) {
          applyPreferenceState(state)
        }
      })
      .catch(() => {
        if (request !== preferenceMutationRef.current) return
        void preferences
          .get()
          .then(applyPreferenceState)
          .catch(() => undefined)
      })
  }, [applyPreferenceState])

  const refreshHostState = useCallback(() => {
    void getApi()
      .host.getState()
      .then(setHostState)
      .catch(() => setHostState(null))
  }, [])

  useEffect(() => {
    refreshHostState()
    return getApi().host.onState(setHostState)
  }, [refreshHostState])

  const markFirstRunDone = useCallback(() => {
    setFirstRun(false)
    try {
      localStorage.setItem(FIRST_RUN_STORAGE_KEY, '1')
    } catch {
      // Keep the dismissal session-local when storage is unavailable.
    }
  }, [])

  // Reset project-scoped state after adopting a project. Land later Setup visits on
  // Review, keep every completed step reachable, and show the save action.
  const resetProjectScopedState = useCallback(() => {
    const emptySelection = new Set<string>()
    selectionRef.current = emptySelection
    setSelectionState(emptySelection)
    selectionModeRef.current = 'all'
    setSelectionMode('all')
    subjectsRef.current = []
    setSubjects([])
    setDiscoveryAnswered(false)
    setSubjectsDiscovering(false)
    setSubjectsDiscoveredAt(null)
    subjectsRequestTokenRef.current += 1
    subjectRequestTokensRef.current.clear()
    setActiveSubjectId(null)
    setSubjectsFilter('all')
    setResultsStage(null)
    setLogsFocus(null)
    setToolStatus(null)
    safeExecutionRef.current = false
    savedSafeExecutionRef.current = false
    setSafeExecutionState(false)
    setSaveState({ phase: 'idle', error: null })
    lastDiscoveryFingerprintRef.current = ''
    lastToolFingerprintRef.current = ''
    reattachGenerationRef.current = ''
    reattachFailureCountRef.current = 0
    if (reattachRetryTimerRef.current !== null) {
      window.clearTimeout(reattachRetryTimerRef.current)
      reattachRetryTimerRef.current = null
    }
  }, [])

  const reserveCreateEpoch = useCallback((): number => {
    const epoch = reserveProjectEpoch(
      projectEpochRef.current,
      projectRequestEpochRef.current,
    )
    projectRequestEpochRef.current = epoch
    return epoch
  }, [])

  const adoptProject = useCallback(
    (untrusted: ProjectOpenResult) => {
      const result = requireProjectOpenResult(untrusted)
      const reservedEpoch = projectRequestEpochRef.current
      if (reservedEpoch > 0 && result.project.epoch !== reservedEpoch) {
        throw new Error(
          'Retry project creation within the current project generation.',
        )
      }
      const epoch = result.project.epoch
      projectRequestEpochRef.current = Math.max(
        projectRequestEpochRef.current,
        epoch,
      )
      persistProjectEpoch(epoch)
      const ref = result.project
      projectEpochRef.current = epoch
      projectRefRef.current = ref
      cfgRef.current = result.cfg
      configRevisionRef.current = 0
      configSha256Ref.current = result.configSha256
      setProjectEpoch(epoch)
      setProjectRef(ref)
      setCfgState(result.cfg)
      savedCfgRef.current = result.cfg
      setSavedCfgState(result.cfg)
      setConfigRevision(0)
      setSavedRevision(0)
      savedRevisionRef.current = 0
      setConfigSha256(result.configSha256)
      resetProjectScopedState()
      setWizardStep(WIZARD_LAST_STEP)
      setWizardMaxReached(WIZARD_LAST_STEP)
    },
    [resetProjectScopedState],
  )

  const markProjectCreated = useCallback(
    (result: ProjectOpenResult) => {
      adoptProject(result)
    },
    [adoptProject],
  )

  // Start a fresh project, reset its configuration, and open the wizard.
  const newProject = useCallback(async (): Promise<void> => {
    if (projectOpenInFlightRef.current) {
      throw new Error(
        'Finish the current project boundary before starting another.',
      )
    }
    projectOpenInFlightRef.current = true
    try {
      const previous = projectRefRef.current
      if (previous) {
        await getApi().project.close({ project: previous })
        const current = projectRefRef.current
        if (
          !current ||
          current.projectId !== previous.projectId ||
          current.epoch !== previous.epoch
        ) {
          throw new Error('Retry closing the current project.')
        }
      }
      const epoch = reserveProjectEpoch(
        projectEpochRef.current,
        projectRequestEpochRef.current,
      )
      projectRequestEpochRef.current = epoch
      projectEpochRef.current = epoch
      projectRefRef.current = null
      cfgRef.current = DEFAULT_PROJECT_CONFIG
      configRevisionRef.current = 0
      configSha256Ref.current = ''
      setProjectEpoch(epoch)
      setProjectRef(null)
      setCfgState(DEFAULT_PROJECT_CONFIG)
      savedCfgRef.current = DEFAULT_PROJECT_CONFIG
      setSavedCfgState(DEFAULT_PROJECT_CONFIG)
      setConfigRevision(0)
      setSavedRevision(0)
      savedRevisionRef.current = 0
      setConfigSha256('')
      resetProjectScopedState()
      setWizardStep(0)
      setWizardMaxReached(0)
      setRoute('wizard')
    } finally {
      projectOpenInFlightRef.current = false
    }
  }, [resetProjectScopedState])

  const setCfg = useCallback((next: ProjectConfig) => {
    cfgRef.current = next
    const revision = configRevisionRef.current + 1
    configRevisionRef.current = revision
    setCfgState(next)
    setConfigRevision(revision)
    setSaveState({ phase: 'idle', error: null })
  }, [])

  const setSafeExecution = useCallback((next: boolean): void => {
    if (safeExecutionRef.current === next) return
    safeExecutionRef.current = next
    setSafeExecutionState(next)
    if (!projectRefRef.current) return
    const revision = configRevisionRef.current + 1
    configRevisionRef.current = revision
    setConfigRevision(revision)
    setSaveState({ phase: 'idle', error: null })
  }, [])

  const saveProject = useCallback(
    (candidate?: ProjectConfig): Promise<ProjectSaveResult> => {
      if (savePromiseRef.current) return savePromiseRef.current
      const operation = (async (): Promise<ProjectSaveResult> => {
        const project = projectRefRef.current
        if (!project) throw new Error('Open or create a project before saving.')
        const next = candidate ?? cfgRef.current
        if (candidate && candidate !== cfgRef.current) setCfg(next)
        const revision = configRevisionRef.current
        const capturedSafeExecution = safeExecutionRef.current
        const epoch = project.epoch
        setSaveState({ phase: 'validating', error: null })
        try {
          const validation = await getApi().project.validate(next)
          if (validation.errors.length > 0) {
            throw new Error(
              validation.errors[0] ??
                'Resolve the project configuration before continuing.',
            )
          }
          if (projectEpochRef.current !== epoch) {
            throw new Error('Retry validation against the current project.')
          }
          setSaveState({ phase: 'saving', error: null })
          const result = await getApi().project.save({
            project,
            cfg: next,
            configRevision: revision,
            safeExecution: capturedSafeExecution,
            expectedSha256: configSha256Ref.current,
          })
          if (projectEpochRef.current !== epoch) {
            throw new Error('Retry saving the current project.')
          }
          if (
            result.project.projectId !== project.projectId ||
            result.project.epoch !== project.epoch
          ) {
            throw new Error(
              'The save response belongs to another project generation.',
            )
          }
          savedCfgRef.current = next
          setSavedCfgState(next)
          savedSafeExecutionRef.current = capturedSafeExecution
          setSavedRevision(result.configRevision)
          savedRevisionRef.current = result.configRevision
          configSha256Ref.current = result.sha256
          setConfigSha256(result.sha256)
          setSaveState({ phase: 'idle', error: null })
          return result
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Retry saving the project.'
          if (projectEpochRef.current === epoch) {
            setSaveState({ phase: 'error', error: message })
          }
          throw error
        }
      })()
      savePromiseRef.current = operation
      void operation
        .finally(() => {
          if (savePromiseRef.current === operation)
            savePromiseRef.current = null
        })
        .catch(() => undefined)
      return operation
    },
    [setCfg],
  )

  const discardChanges = useCallback(async (): Promise<void> => {
    const project = projectRefRef.current
    if (!project) return
    const saving = savePromiseRef.current
    if (saving) await saving.catch(() => undefined)
    if (!sameProjectRef(projectRefRef.current, project)) return
    const persistedCfg = savedCfgRef.current
    const persistedRevision = savedRevisionRef.current
    cfgRef.current = persistedCfg
    configRevisionRef.current = persistedRevision
    setCfgState(persistedCfg)
    setConfigRevision(persistedRevision)
    safeExecutionRef.current = savedSafeExecutionRef.current
    setSafeExecutionState(savedSafeExecutionRef.current)
    setSaveState({ phase: 'idle', error: null })
  }, [])

  /**
   * Publish normalized rows, mark discovery answered for the open project,
   * and prune only an explicit selection.
   */
  const commitSubjects = useCallback((next: Subject[]): void => {
    subjectsRef.current = next
    setSubjects(next)
    setDiscoveryAnswered(true)
    if (selectionModeRef.current !== 'explicit') return
    const eligibleIds = new Set(
      next.filter(isAnalysisEligible).map((subject) => subject.id),
    )
    const current = selectionRef.current
    const pruned = new Set([...current].filter((id) => eligibleIds.has(id)))
    if (pruned.size === current.size) return
    selectionRef.current = pruned
    setSelectionState(pruned)
  }, [])

  const setSelection = useCallback((next: ReadonlySet<string>) => {
    const eligibleIds = new Set(
      subjectsRef.current
        .filter(isAnalysisEligible)
        .map((subject) => subject.id),
    )
    const accepted = new Set([...next].filter((id) => eligibleIds.has(id)))
    selectionRef.current = accepted
    setSelectionState(accepted)
    selectionModeRef.current = 'explicit'
    setSelectionMode('explicit')
  }, [])

  const toggleSelection = useCallback((id: string) => {
    const subject = subjectsRef.current.find((row) => row.id === id)
    if (!subject || !isAnalysisEligible(subject)) return
    const next = new Set(selectionRef.current)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    selectionRef.current = next
    setSelectionState(next)
    selectionModeRef.current = 'explicit'
    setSelectionMode('explicit')
  }, [])

  const clearSelection = useCallback(() => {
    const empty = new Set<string>()
    selectionRef.current = empty
    setSelectionState(empty)
    selectionModeRef.current = 'explicit'
    setSelectionMode('explicit')
  }, [])

  const selectAllSubjects = useCallback(() => {
    const empty = new Set<string>()
    selectionRef.current = empty
    setSelectionState(empty)
    selectionModeRef.current = 'all'
    setSelectionMode('all')
  }, [])

  const releaseLaunchSelection = useCallback(
    (launchedSubjectIds: readonly string[]) => {
      // A selection changed since the launch is a new choice and stays.
      if (selectionModeRef.current !== 'explicit') return
      const current = selectionRef.current
      const launched = new Set(launchedSubjectIds)
      if (
        current.size !== launched.size ||
        [...current].some((id) => !launched.has(id))
      )
        return
      selectAllSubjects()
    },
    [selectAllSubjects],
  )

  const executionTarget = useMemo<WorkflowTarget>(
    () =>
      selectionMode === 'all'
        ? { mode: 'all' }
        : { mode: 'explicit', subjectIds: [...selection].sort() },
    [selection, selectionMode],
  )

  // Read current configuration through refs in refresh callbacks. Tolerate partial
  // test mocks by skipping missing methods and wrapping results with `Promise.resolve`.
  const applySiteWrite = useCallback(
    (
      project: ProjectRef,
      subjectIds: readonly string[],
      site: string | null,
    ): void => {
      if (!sameProjectRef(projectRefRef.current, project)) return
      const written = new Set(subjectIds)
      let changed = false
      const next = subjectsRef.current.map((subject) => {
        if (!written.has(subject.id)) return subject
        // A refresh of this subject that started before the write may carry
        // the site from before it; it must not replace the written row.
        subjectRequestTokensRef.current.set(
          subject.id,
          (subjectRequestTokensRef.current.get(subject.id) ?? 0) + 1,
        )
        if ((subject.site ?? null) === site) return subject
        changed = true
        return { ...subject, site }
      })
      if (changed) commitSubjects(next)
    },
    [commitSubjects],
  )

  const refreshSubjectsRef = useRef<() => void>(() => undefined)
  const refreshSubjects = useCallback(() => {
    const project = projectRefRef.current
    if (!project) return
    const discover = getApi().subjects?.discover
    if (typeof discover !== 'function') return
    const revision = configRevisionRef.current
    const token = subjectsRequestTokenRef.current + 1
    subjectsRequestTokenRef.current = token
    setSubjectsDiscovering(true)
    void Promise.resolve(
      discover({ project, cfg: cfgRef.current, configRevision: revision }),
    )
      .then((next) => {
        if (
          projectEpochRef.current !== project.epoch ||
          projectRefRef.current?.projectId !== project.projectId ||
          subjectsRequestTokenRef.current !== token
        ) {
          return
        }
        if (configRevisionRef.current !== revision) {
          // The configuration moved while discovery ran, for example an
          // Allow live runs toggle right after a save. Discovering again with the
          // current configuration replaces this stale answer; leaving the
          // list as it was would show the previous cohort until the next
          // edit.
          refreshSubjectsRef.current()
          return
        }
        commitSubjects(normalizeAnalysisSubjects(next))
        setSubjectsDiscoveredAt(new Date().toISOString())
        setSubjectsDiscovering(false)
      })
      .catch(() => {
        if (
          projectEpochRef.current !== project.epoch ||
          projectRefRef.current?.projectId !== project.projectId ||
          subjectsRequestTokenRef.current !== token
        ) {
          return
        }
        if (configRevisionRef.current !== revision) {
          // As for a stale answer, discover again with the current
          // configuration: dropping this failure would leave a first
          // discovery unanswered, and the cohort loading, until the next
          // rediscovery.
          refreshSubjectsRef.current()
          return
        }
        commitSubjects([])
        setSubjectsDiscovering(false)
      })
  }, [commitSubjects])

  const refreshSubject = useCallback(
    async (id: string): Promise<void> => {
      const project = projectRefRef.current
      const current = subjectsRef.current.find((subject) => subject.id === id)
      const refreshOne = getApi().subjects?.refreshOne
      if (!project || !current || typeof refreshOne !== 'function') return

      const capturedProject = { ...project }
      const capturedCfg = cfgRef.current
      const capturedRevision = configRevisionRef.current
      const capturedDiscoveryToken = subjectsRequestTokenRef.current
      const token = (subjectRequestTokensRef.current.get(id) ?? 0) + 1
      subjectRequestTokensRef.current.set(id, token)
      const refreshed = await Promise.resolve(
        refreshOne({
          project: capturedProject,
          cfg: capturedCfg,
          configRevision: capturedRevision,
          subjectId: id,
        }),
      )
      if (
        !sameProjectRef(projectRefRef.current, capturedProject) ||
        configRevisionRef.current !== capturedRevision ||
        subjectsRequestTokenRef.current !== capturedDiscoveryToken ||
        subjectRequestTokensRef.current.get(id) !== token
      ) {
        return
      }
      if (refreshed.id !== id) {
        throw new Error(
          'The refresh response identified another subject than the selected one.',
        )
      }
      const index = subjectsRef.current.findIndex(
        (subject) => subject.id === id,
      )
      if (index < 0) return
      const next = [...subjectsRef.current]
      next[index] = normalizeAnalysisEligibility(refreshed)
      commitSubjects(next)
    },
    [commitSubjects],
  )

  const applyQcWrite = useCallback(
    (project: ProjectRef, result: QcWriteResult): void => {
      if (!sameProjectRef(projectRefRef.current, project)) return
      const id = result.subjectId
      const index = subjectsRef.current.findIndex(
        (subject) => subject.id === id,
      )
      const current = subjectsRef.current[index]
      if (!current) return
      if (result.revision < (current.qcRevision ?? 0)) return
      // A refresh of this subject that started before the write may carry the
      // record from before it; it must not replace the written row.
      subjectRequestTokensRef.current.set(
        id,
        (subjectRequestTokensRef.current.get(id) ?? 0) + 1,
      )
      const verdict = result.verdict
      const effective = effectiveQcVerdict(result)
      // Mirror the sidecar's subject record, whose eligibility needs the T1
      // availability discovery reported and no effective Fail. A row without
      // T1 availability keeps the eligibility it had apart from its QC Fail.
      const inputsEligible =
        current.t1Availability === undefined
          ? current.analysisEligible || current.qc === 'fail'
          : current.t1Availability === 'available'
      const next = [...subjectsRef.current]
      next[index] = normalizeAnalysisEligibility({
        ...current,
        qc: effective,
        recordedQcVerdict:
          verdict === 'pass' || verdict === 'fail' || verdict === 'defer'
            ? verdict
            : null,
        qcReviewEvidencePresent: result.reviewEvidence != null,
        notes: result.note,
        qcTags: [...result.tags],
        qcRevision: result.revision,
        analysisEligible: inputsEligible && effective !== 'fail',
      })
      commitSubjects(next)
    },
    [commitSubjects],
  )

  const refreshToolStatus = useCallback(() => {
    const project = projectRefRef.current
    if (!project) return
    const toolStatusFn = getApi().env?.toolStatus
    if (typeof toolStatusFn !== 'function') return
    const revision = configRevisionRef.current
    const token = toolRequestTokenRef.current + 1
    toolRequestTokenRef.current = token
    void Promise.resolve(
      toolStatusFn({
        project,
        cfg: cfgRef.current,
        configRevision: revision,
      }),
    )
      .then((status) => {
        if (
          status &&
          projectEpochRef.current === project.epoch &&
          projectRefRef.current?.projectId === project.projectId &&
          configRevisionRef.current === revision &&
          toolRequestTokenRef.current === token
        ) {
          setToolStatus(status)
        }
      })
      .catch(() => {
        if (
          projectEpochRef.current === project.epoch &&
          projectRefRef.current?.projectId === project.projectId &&
          configRevisionRef.current === revision &&
          toolRequestTokenRef.current === token
        ) {
          setToolStatus(null)
        }
      })
  }, [])

  // Adopt a saved project without marking it dirty. Reload recent projects before
  // updating the list so a concurrent wizard open remains intact.
  const openProject = useCallback(
    async (path: string): Promise<void> => {
      if (projectOpenInFlightRef.current) {
        throw new Error(
          'Finish opening the current project before opening another.',
        )
      }
      projectOpenInFlightRef.current = true
      const epoch = reserveProjectEpoch(
        projectEpochRef.current,
        projectRequestEpochRef.current,
      )
      projectRequestEpochRef.current = epoch
      const loadToken = projectLoadTokenRef.current + 1
      projectLoadTokenRef.current = loadToken
      try {
        const loaded = requireProjectOpenResult(
          await getApi().project.open({ path, epoch }),
        )
        if (projectLoadTokenRef.current !== loadToken) return
        if (loaded.project.epoch !== epoch) {
          throw new Error(
            'The open response belongs to another project generation.',
          )
        }
        // Publish the exact main-authoritative identity before starting any refresh.
        adoptProject(loaded)
        const ref = loaded.project
        lastDiscoveryFingerprintRef.current = discoveryFingerprint(
          ref,
          loaded.cfg,
        )
        lastToolFingerprintRef.current = toolFingerprint(ref, loaded.cfg)
        rememberRecentProject(loadRecentProjects(), loaded.cfg, path)
        setRoute('project')

        const request = { project: ref, cfg: loaded.cfg, configRevision: 0 }
        const [subjectsResult, toolsResult] = await Promise.allSettled([
          getApi().subjects.discover(request),
          getApi().env.toolStatus(request),
        ])
        if (
          projectLoadTokenRef.current !== loadToken ||
          !sameProjectRef(projectRefRef.current, ref)
        ) {
          return
        }
        if (subjectsResult.status === 'fulfilled') {
          commitSubjects(normalizeAnalysisSubjects(subjectsResult.value))
          setSubjectsDiscoveredAt(new Date().toISOString())
        } else {
          // A failed discovery answers with no rows, as refreshSubjects does,
          // so the shell does not wait on a load that has ended.
          commitSubjects([])
        }
        if (toolsResult.status === 'fulfilled') {
          setToolStatus(toolsResult.value)
        }
        const failed: string[] = []
        if (subjectsResult.status === 'rejected')
          failed.push('subject discovery')
        if (toolsResult.status === 'rejected') failed.push('tool status')
        if (failed.length > 0) {
          throw new Error(
            `Retry ${failed.join(' and ')} from the project screen after opening the project.`,
          )
        }
      } finally {
        if (projectLoadTokenRef.current === loadToken) {
          projectOpenInFlightRef.current = false
        }
      }
    },
    [adoptProject, commitSubjects],
  )

  // Reopen the project the operator last worked in when the packaged app
  // starts without one, so a relaunch does not land in the setup wizard while
  // the recent list knows the project; a failed reopen keeps the wizard.
  const autoReopenAttemptedRef = useRef(false)
  useEffect(() => {
    if (autoReopenAttemptedRef.current) return
    if (
      hostState?.mode !== 'electron' ||
      hostState.sidecar?.state !== 'ready'
    ) {
      return
    }
    if (projectRef) {
      autoReopenAttemptedRef.current = true
      return
    }
    const recent = loadRecentProjects()[0]
    if (!recent) {
      autoReopenAttemptedRef.current = true
      return
    }
    autoReopenAttemptedRef.current = true
    void openProject(recent.path).catch(() => undefined)
  }, [hostState, projectRef, openProject])

  // Reattach the active project after each sidecar generation starts detached. Send
  // one scoped request per exact project and generation. Let main mark attachment only
  // after sidecar acceptance, then unlock the generation-scoped runtime bootstrap.
  useEffect(() => {
    const sidecar = hostState?.sidecar
    if (!projectRef || sidecar?.state !== 'ready' || sidecar.projectAttached) {
      if (sidecar?.projectAttached) {
        reattachGenerationRef.current = ''
        reattachFailureCountRef.current = 0
        if (reattachRetryTimerRef.current !== null) {
          window.clearTimeout(reattachRetryTimerRef.current)
          reattachRetryTimerRef.current = null
        }
      }
      return
    }
    const discover = getApi().subjects?.discover
    if (typeof discover !== 'function') return
    const generationKey = `${projectRef.projectId}\0${projectRef.epoch}\0${sidecar.generation}`
    if (reattachGenerationRef.current === generationKey) return
    reattachGenerationRef.current = generationKey

    const capturedProject = projectRef
    const capturedRevision = configRevisionRef.current
    const capturedCfg = cfgRef.current
    const token = subjectsRequestTokenRef.current + 1
    subjectsRequestTokenRef.current = token
    void Promise.resolve(
      discover({
        project: capturedProject,
        cfg: capturedCfg,
        configRevision: capturedRevision,
      }),
    )
      .then((next) => {
        if (
          !sameProjectRef(projectRefRef.current, capturedProject) ||
          subjectsRequestTokenRef.current !== token
        ) {
          return
        }
        if (configRevisionRef.current !== capturedRevision) {
          // This request superseded every earlier discovery, so dropping its
          // stale answer would leave the cohort loading; discover again with
          // the current configuration, as refreshSubjects does.
          refreshSubjectsRef.current()
          return
        }
        commitSubjects(normalizeAnalysisSubjects(next))
        setSubjectsDiscoveredAt(new Date().toISOString())
        // This answer superseded any Re-discover still in flight.
        setSubjectsDiscovering(false)
        reattachFailureCountRef.current = 0
        refreshHostState()
      })
      .catch(() => {
        // A superseded Re-discover never answers, so end its busy state here.
        if (subjectsRequestTokenRef.current === token) {
          setSubjectsDiscovering(false)
        }
        // Retry rejected attachment with bounded backoff. Do not consume the generation
        // permanently or spin host and discovery IPC.
        if (reattachGenerationRef.current !== generationKey) return
        reattachGenerationRef.current = ''
        reattachFailureCountRef.current += 1
        const delay = Math.min(
          250 * 2 ** (reattachFailureCountRef.current - 1),
          5_000,
        )
        if (reattachRetryTimerRef.current !== null) {
          window.clearTimeout(reattachRetryTimerRef.current)
        }
        reattachRetryTimerRef.current = window.setTimeout(() => {
          reattachRetryTimerRef.current = null
          setReattachRetryTick((value) => value + 1)
        }, delay)
      })
  }, [
    hostState,
    projectRef,
    reattachRetryTick,
    refreshHostState,
    commitSubjects,
  ])

  useEffect(
    () => () => {
      if (reattachRetryTimerRef.current !== null) {
        window.clearTimeout(reattachRetryTimerRef.current)
      }
    },
    [],
  )

  // Hydrate the main-owned preference record.
  useEffect(() => {
    const preferences = (
      getApi() as unknown as {
        preferences?: SupraspinaApi['preferences']
      }
    ).preferences
    if (!preferences) return undefined
    let live = true
    const unsubscribe = preferences.onChanged((state) => {
      if (live) applyPreferenceState(state)
    })
    const requestAtStart = preferenceMutationRef.current
    void preferences
      .get()
      .then((state) => {
        if (!live || requestAtStart !== preferenceMutationRef.current) return
        applyPreferenceState(state)
      })
      .catch(() => undefined)
    return () => {
      live = false
      unsubscribe()
    }
  }, [applyPreferenceState])

  // Resolve System directly in browser previews. Mirror Electron's native-theme
  // transition while its event crosses IPC.
  useEffect(() => {
    if (tweaks.theme !== 'system' || typeof matchMedia !== 'function') return
    const query = matchMedia('(prefers-color-scheme: dark)')
    const update = (): void =>
      setResolvedTheme(query.matches ? 'dark' : 'light')
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [tweaks.theme])

  // Drive rediscovery with stable committed keys instead of callback identities. Keep
  // the latest closures in refs so parameter edits do not trigger redundant discovery
  // and tool-status round trips.
  const refreshToolStatusRef = useRef(refreshToolStatus)
  useEffect(() => {
    refreshSubjectsRef.current = refreshSubjects
    refreshToolStatusRef.current = refreshToolStatus
  }, [refreshSubjects, refreshToolStatus])

  // Discovery applies the configured include and exclude lists, but a save
  // that excludes a subject answers only after rediscovery; until then the
  // rows held from the previous discovery would still count the excluded
  // subject on the run dock, the Runs target, and the launch confirmation.
  const scopedSubjects = useMemo(
    () => subjectsInConfigScope(subjects, cfg.subjects),
    [subjects, cfg.subjects],
  )

  // Discover the cohort on mount and after discovery-relevant inputs change. Ignore
  // unrelated parameter edits.
  const discoveryKey = projectRef ? discoveryFingerprint(projectRef, cfg) : ''
  useEffect(() => {
    if (!projectRef) return
    if (lastDiscoveryFingerprintRef.current === discoveryKey) return
    lastDiscoveryFingerprintRef.current = discoveryKey
    refreshSubjectsRef.current()
  }, [discoveryKey, projectRef])

  // Refresh top-bar tool status on mount and only after tool inputs change.
  const toolKey = projectRef ? toolFingerprint(projectRef, cfg) : ''
  useEffect(() => {
    if (!projectRef) return
    if (lastToolFingerprintRef.current === toolKey) return
    lastToolFingerprintRef.current = toolKey
    refreshToolStatusRef.current()
  }, [toolKey, projectRef])

  const getLifecycleSnapshot = useCallback(
    (): { project: ProjectRef | null; dirty: boolean } => ({
      project: projectRefRef.current,
      dirty: configRevisionRef.current !== savedRevisionRef.current,
    }),
    [],
  )

  const value = useMemo<AppState>(() => {
    const base = THEMES[resolvedTheme]
    const t = tweaks.highContrast ? highContrastTheme(base) : base
    // Fall back to cozy density before any unknown value reaches downstream fields.
    const density = DENSITY[tweaks.density] ?? DENSITY.cozy
    return {
      t,
      resolvedTheme,
      density,
      tweaks,
      route,
      setRoute,
      subjectsFilter,
      setSubjectsFilter,
      resultsStage,
      setResultsStage,
      logsFocusRunId,
      logsFocusStepKey,
      setLogsFocusRunId,
      setTweaks,
      resetTweaks,
      hostState,
      refreshHostState,
      cfg,
      setCfg,
      hasProject: projectRef !== null,
      projectRef,
      projectEpoch,
      configRevision,
      reserveCreateEpoch,
      savedRevision,
      savedCfg,
      getLifecycleSnapshot,
      configSha256,
      openProject,
      markProjectCreated,
      newProject,
      dirty,
      saveProject,
      discardChanges,
      saveState,
      safeExecution,
      setSafeExecution,
      selection,
      executionTarget,
      selectAllSubjects,
      setSelection,
      toggleSelection,
      clearSelection,
      releaseLaunchSelection,
      subjects: scopedSubjects,
      discoveryAnswered,
      subjectsDiscovering,
      subjectsDiscoveredAt,
      refreshSubjects,
      refreshSubject,
      applyQcWrite,
      applySiteWrite,
      activeSubjectId,
      setActiveSubjectId,
      toolStatus,
      refreshToolStatus,
      firstRun,
      markFirstRunDone,
      wizardStep,
      setWizardStep,
      wizardMaxReached,
      setWizardMaxReached,
      runsFeedback,
      setRunsFeedback,
      pendingPlan,
      trackPlan,
      runPlanRecords,
      recordRunPlan,
    }
  }, [
    tweaks,
    resolvedTheme,
    setTweaks,
    resetTweaks,
    route,
    subjectsFilter,
    resultsStage,
    logsFocusRunId,
    logsFocusStepKey,
    setLogsFocusRunId,
    hostState,
    refreshHostState,
    cfg,
    setCfg,
    openProject,
    markProjectCreated,
    newProject,
    projectRef,
    projectEpoch,
    configRevision,
    reserveCreateEpoch,
    savedRevision,
    savedCfg,
    getLifecycleSnapshot,
    configSha256,
    dirty,
    saveProject,
    discardChanges,
    saveState,
    safeExecution,
    setSafeExecution,
    selection,
    executionTarget,
    selectAllSubjects,
    setSelection,
    toggleSelection,
    clearSelection,
    releaseLaunchSelection,
    scopedSubjects,
    discoveryAnswered,
    subjectsDiscovering,
    subjectsDiscoveredAt,
    refreshSubjects,
    refreshSubject,
    applyQcWrite,
    applySiteWrite,
    activeSubjectId,
    toolStatus,
    refreshToolStatus,
    firstRun,
    markFirstRunDone,
    wizardStep,
    setWizardStep,
    wizardMaxReached,
    setWizardMaxReached,
    runsFeedback,
    setRunsFeedback,
    pendingPlan,
    trackPlan,
    runPlanRecords,
    recordRunPlan,
  ])

  return <AppContext value={value}>{children}</AppContext>
}

/**
 * Consume the application context, and throw outside {@link AppProvider}. Keep this
 * hook beside its provider because editing the provider already requires a full reload.
 *
 * @throws Throw when no {@link AppProvider} wraps the caller.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useApp(): AppState {
  const value = useContext(AppContext)
  if (!value) {
    throw new Error('Render useApp only within an AppProvider.')
  }
  return value
}
