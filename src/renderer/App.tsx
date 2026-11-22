/** Assembles the Supraspina shell from shared application state and global controls. */

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  SetStateAction,
} from 'react'
import {
  Brandmark,
  Btn,
  Chip,
  ConfirmDialog,
  ErrorState,
  ExecutionOutcomeNotice,
  Ico,
  ICONS,
  ICON_SIZE,
  ScopeChip,
  ChipGlyph,
  TextPill,
  NoticeGlyph,
} from './ui'
import { FONTS, Hint, Kbd, LoadingState, Modal, errorMessageText } from './ui'
import { FirstRunDialog } from './screens/FirstRunDialog'
import { navFitCount } from './nav-fit'
import { statusColor, statusSoft, type Theme } from './theme/tokens'
import { AppProvider, useApp } from './state/context'
import { RuntimeProvider } from './state/runtime-context'
import { DurableMutationsProvider } from './state/durable-mutations'
import { WorkflowReviewProvider } from './state/workflow-review'
import { RecoveryReviewProvider } from './state/recovery-review'
import { useRuntime } from './state/runtime-state'
import {
  isInputLimitReason,
  restateRecordedReasons,
} from './state/terminal-reason'
import { recoveryTarget } from './state/recovery-target'
import {
  projectSubjectRuntimeStatus,
  skipDisabledStages,
  type SubjectDisplayBucket,
} from './state/subject-runtime-status'
import {
  CURRENCY_BUCKETS,
  CURRENCY_CHECKING_FACT,
  describeSubjectBuckets,
  SUBJECT_BUCKETS,
  tallySubjectBuckets,
  type SubjectBucketCounts,
} from './state/subject-buckets'
import { ProjectLifecycleProvider } from './state/project-lifecycle'
import { StageCurrencyProvider } from './state/stage-currency-context'
import {
  applyStageCurrency,
  useProjectStageCurrency,
} from './state/stage-currency'
import { useProjectLifecycle } from './state/project-lifecycle-state'
import { useExecutionService } from './state/execution-service'
import {
  CANCELLATION_REQUESTED_NOTICE,
  QC_SCOPE_ACKNOWLEDGEMENT_LABEL,
  REVIEW_PLAN_LABEL,
  executionFailure,
  memoryAcknowledgementHint,
  memoryAcknowledgementLabel,
  ACKNOWLEDGEMENT_NEEDED_TITLE,
  qcScopeAcknowledgementHint,
  qcScopeRows,
  reviewNextSentence,
  runExecutionAction,
  safeExecutionNoticeState,
  withoutNoWorkOutcome,
  workflowScopeSentence,
  type ExecutionFailure,
} from './state/execution-feedback'
import type { Route } from './state/context'
import { getApi } from './state/api'
import {
  COHORT_LOADING_TITLE,
  cohortCutTitle,
  knownCohortSize,
  targetRunButtonLabel,
  targetScopePillLabel,
} from './run-scope'
import {
  PROJECT_FILE_FILTER,
  loadRecentProjects,
} from './state/recent-projects'
import type { RecentProject } from './state/recent-projects'
import type { ProjectConfig } from '../shared/project-schema'
import type { RunSnapshot, WorkflowResult } from '../shared/contract'
import type {
  ChipStatus,
  EnvReport,
  StageBlocker,
  Subject,
  ToolStatusItem,
} from '../shared/types'
import {
  computeStageBlockers,
  unavailableEnigmaBackends,
} from './state/stage-blockers'
import { STATUS_MEANING } from '../shared/help'
import {
  analysisEligibleSubjects,
  emptyAnalysisCohortReason,
} from '../shared/analysis-cohort'
import {
  ProjectDashboard,
  SubjectsScreen,
  RunsScreen,
  LogsScreen,
  QcReviewScreen,
  InputQcScreen,
  DiagnosticsScreen,
  PipelineScreen,
  ResultsScreen,
  AnalysisScreen,
  RegistryScreen,
  SettingsScreen,
  SetupWizard,
} from './screens'
import { SafeExecutionNotice } from './screens/RunsScreen'

/**
 * Keep transient UI state bound to the project epoch that created it.
 *
 * Ignore completions from older epochs after a newer epoch writes state. Project
 * the safe initial value immediately when a project opens to avoid racing the
 * operator's first interaction with delayed cleanup.
 */
function useEpochState<T>(
  initialValue: T,
  epoch: number,
): [T, Dispatch<SetStateAction<T>>] {
  const [entry, setEntry] = useState({ epoch, value: initialValue })
  const value = entry.epoch === epoch ? entry.value : initialValue
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      setEntry((previous) => {
        if (previous.epoch > epoch) return previous
        const current = previous.epoch === epoch ? previous.value : initialValue
        const next =
          typeof action === 'function'
            ? (action as (value: T) => T)(current)
            : action
        return { epoch, value: next }
      })
    },
    [epoch, initialValue],
  )
  return [value, setValue]
}

/** Width in CSS pixels of one caption button in the custom control cluster. */
const CAPTION_BUTTON_WIDTH = 46

/** Width in CSS pixels reserved by the three non-shrinking caption buttons. */
export const CAPTION_CONTROLS_WIDTH = CAPTION_BUTTON_WIDTH * 3

/**
 * Horizontal padding in CSS pixels on each side of the full-layout top bar.
 * The caption controls take the place of the right padding where they are
 * drawn.
 */
const FULL_BAR_PADDING_X = 14

/**
 * Border-box width in CSS pixels the top bar's full layout needs beside the
 * caption controls: 1,040 px of content and the full layout's padding on both
 * sides. Below this the bar switches to its compact layout, which is what
 * keeps the caption controls reachable at the minimum window width. The bar
 * measures its border box, which neither layout's padding changes, so both
 * layouts judge the same width and neither selects the other.
 */
export const FULL_BAR_BUDGET = 1_040 + 2 * FULL_BAR_PADDING_X

/**
 * Extra room in CSS pixels the full layout needs for each attention-only tool
 * item its tool chip counts: about the width of "Scientific assets" and a
 * gap. The bar stays compact until it has that room as well, so the chip
 * never pushes the caption controls off screen.
 */
export const ATTENTION_CHIP_ALLOWANCE = 100

/**
 * Narrowest width in CSS pixels the full-layout command palette button accepts.
 * The button keeps its preferred width whenever the bar has room and gives the
 * difference back when it does not, so the top bar reflows instead of pushing
 * the page into a horizontal scroll. This floor still holds the search icon, a
 * readable hint, and the keyboard shortcut.
 */
export const PALETTE_BUTTON_MIN_WIDTH = 132

/**
 * Most subject matches the command palette renders at once. The palette
 * searches every subject and bounds only the rendered rows, so a long cohort
 * stays responsive and a narrower query reaches any subject.
 */
export const PALETTE_SUBJECT_LIMIT = 50

/** One entry in the top navigation bar. */
interface RailEntry {
  route: Route
  icon: keyof typeof ICONS
  label: string
}

/** Every application route reachable from the rail. */
const RAIL_ROUTES: readonly RailEntry[] = [
  { route: 'wizard', icon: 'sliders', label: 'Setup' },
  { route: 'project', icon: 'project', label: 'Dashboard' },
  { route: 'subjects', icon: 'subjects', label: 'Subjects' },
  { route: 'runs', icon: 'runs', label: 'Runs' },
  { route: 'logs', icon: 'logs', label: 'Logs' },
  { route: 'qc', icon: 'qc', label: 'QC review' },
  { route: 'inputQc', icon: 'inputQc', label: 'Input QC' },
  { route: 'pipeline', icon: 'pipeline', label: 'Pipeline' },
  { route: 'results', icon: 'results', label: 'Results' },
  { route: 'analysis', icon: 'chart', label: 'Analysis' },
  { route: 'registry', icon: 'registry', label: 'Registry' },
  { route: 'diagnostics', icon: 'doctor', label: 'Diagnostics' },
  { route: 'settings', icon: 'settings', label: 'Settings' },
]

/** Spacing shared by the navigation tabs and the probe that measures them. */
const RAIL_GAP = 2
const RAIL_FONT_SIZE = 11.5
const RAIL_TAB_GAP = 7
const RAIL_TAB_PADDING = '0 8px'
const RAIL_TRIGGER_GAP = 5
const RAIL_TRIGGER_PADDING = '0 10px'

/** Digit-key shortcuts mapped to the seven supported routes. */
const DIGIT_ROUTES: Readonly<Record<string, Route>> = {
  '1': 'subjects',
  '2': 'runs',
  '3': 'logs',
  '4': 'qc',
  '5': 'registry',
  '6': 'settings',
  '7': 'diagnostics',
}

/** Roll-up counts for the top-bar cohort cluster. */
interface CohortStats {
  total: number
  counts: SubjectBucketCounts
}

/** Derive cohort roll-up statistics from the shared subjects. */
function deriveCohortStats(subjects: Subject[]): CohortStats {
  return { total: subjects.length, counts: tallySubjectBuckets(subjects) }
}

/**
 * Summarize the cohort across the shared subject buckets in a compact
 * stacked bar, named and counted as the Dashboard tiles and Subjects are.
 *
 * Until the stage-currency read lands, the bar leaves the Done and Out of
 * date share blank and the count reads `--`: the Done count before the read
 * still includes subjects the read may put out of date, so showing it would
 * claim work done that the read then withdraws.
 */
function CohortBar({
  t,
  stats,
  checked,
  compact = false,
}: {
  t: Theme
  stats: CohortStats
  /** Whether the stage-currency read for the open project has landed. */
  checked: boolean
  compact?: boolean
}): ReactNode {
  const { counts } = stats
  const color: Record<SubjectDisplayBucket, string> = {
    done: t.done,
    // Out of date draws in the warning tone of its matrix glyph.
    outdated: t.warning,
    // Partly done means some steps are done: hatch the Done green over the
    // track, so it reads apart from solid Done and keeps 3:1 stripes.
    partial: `repeating-linear-gradient(135deg, ${t.done} 0 2px, transparent 2px 4px)`,
    // Keep in-progress blue distinct from completion green and warning amber.
    running: t.running,
    failed: t.failed,
    // Interrupted and canceled work did not fail: amber and gray, as their
    // Dashboard tiles draw them.
    interrupted: t.warning,
    cancelled: t.skipped,
    pending: t.pending,
    // Excluded subjects are out of the cohort, not failed: the muted gray.
    excluded: t.skipped,
  }
  const detail = describeSubjectBuckets(counts, checked)
  const subjects = stats.total === 1 ? 'subject' : 'subjects'
  return (
    <span
      role="img"
      aria-label={
        checked
          ? `Cohort progress: ${detail} of ${stats.total} ${subjects}`
          : `Cohort progress, checking stage currency: ${detail} of ${stats.total} ${subjects}`
      }
      title={
        checked
          ? `${counts.done} of ${stats.total} ${subjects} done. ${detail}.`
          : `${stats.total} ${subjects}. ${CURRENCY_CHECKING_FACT} ${detail}.`
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: compact ? 5 : 8,
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          width: compact ? 72 : 120,
          height: 8,
          display: 'flex',
          gap: 1,
          borderRadius: 999,
          overflow: 'hidden',
          background: t.surface3,
          border: `1px solid ${t.border}`,
        }}
      >
        {SUBJECT_BUCKETS.map((bucket) =>
          counts[bucket] > 0 ? (
            <span
              key={bucket}
              style={{
                flexGrow: counts[bucket],
                flexBasis: 0,
                // Leave the unsettled share as bare track until the read.
                background:
                  checked || !CURRENCY_BUCKETS.has(bucket)
                    ? color[bucket]
                    : 'transparent',
              }}
            />
          ) : null,
        )}
      </span>
      <span
        style={{
          fontFamily: FONTS.sans,
          fontVariantNumeric: 'tabular-nums',
          fontSize: 11.5,
          color: t.dim,
          whiteSpace: 'nowrap',
        }}
      >
        {compact
          ? `${checked ? counts.done : '--'}/${stats.total} done`
          : `${checked ? counts.done : '--'} of ${stats.total} done`}
      </span>
    </span>
  )
}

/** Render one row in the {@link OpenMenu} dropdown. */
function OpenMenuItem({
  t,
  onClick,
  title,
  children,
}: {
  t: Theme
  onClick: () => void
  title?: string
  children: ReactNode
}): ReactNode {
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(false)
  return (
    <button
      type="button"
      role="menuitem"
      className="sm-menu-item"
      tabIndex={-1}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '7px 8px',
        border: 'none',
        borderRadius: 4,
        background: hover || focused ? t.surface2 : 'transparent',
        color: t.text,
        cursor: 'pointer',
        fontFamily: FONTS.sans,
        fontSize: 12,
      }}
    >
      {children}
    </button>
  )
}

/** Combine the native project picker and recent-project list in one Open menu. */
function OpenMenu({
  t,
  onBrowse,
  onOpenRecent,
}: {
  t: Theme
  onBrowse: () => void
  onOpenRecent: (path: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [hover, setHover] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const initialFocusRef = useRef<'first' | 'last'>('first')

  const restoreTriggerFocus = useCallback((): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  // Follow the APG menu-button pattern. Move focus into the menu, restore it on
  // Escape, and dismiss the menu after an outside click.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const items =
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]',
        )
      if (!items || items.length === 0) return
      const target =
        initialFocusRef.current === 'last'
          ? items.item(items.length - 1)
          : items.item(0)
      initialFocusRef.current = 'first'
      target.focus()
    })
    const onDocPointer = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      restoreTriggerFocus()
    }
    document.addEventListener('mousedown', onDocPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('mousedown', onDocPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, restoreTriggerFocus])

  // Refresh the recent list from storage each time the menu opens, so a project
  // created or opened since the last open shows up.
  const toggle = (): void => {
    setOpen((prev) => {
      const next = !prev
      if (next) {
        initialFocusRef.current = 'first'
        setRecents(loadRecentProjects())
      }
      return next
    })
  }
  const openFromKeyboard = (edge: 'first' | 'last'): void => {
    initialFocusRef.current = edge
    setRecents(loadRecentProjects())
    setOpen(true)
  }
  const choose = (fn: () => void): void => {
    setOpen(false)
    fn()
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open a saved project"
        title="Open a saved or recent project."
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          openFromKeyboard(event.key === 'ArrowUp' ? 'last' : 'first')
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          height: 24,
          padding: '0 8px',
          borderRadius: 5,
          // Match the small Btn beside it so New, Open, and Save read as one
          // group.
          background: hover || open ? t.surface3 : t.surface2,
          color: t.text,
          border: `1px solid ${t.dim}`,
          fontFamily: FONTS.sans,
          fontSize: 11,
          fontWeight: 400,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        Open
        <Ico
          d={ICONS.chevron}
          size={ICON_SIZE.nav}
          style={{ transform: 'rotate(90deg)' }}
        />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Open project"
          onKeyDown={(event) => {
            const items = Array.from(
              menuRef.current?.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]',
              ) ?? [],
            )
            const current = items.indexOf(
              document.activeElement as HTMLButtonElement,
            )
            let next: number | null = null
            if (event.key === 'ArrowDown') next = (current + 1) % items.length
            if (event.key === 'ArrowUp')
              next = (current - 1 + items.length) % items.length
            if (event.key === 'Home') next = 0
            if (event.key === 'End') next = items.length - 1
            if (event.key === 'Tab') setOpen(false)
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              restoreTriggerFocus()
              return
            }
            const nextItem = next === null ? undefined : items[next]
            if (nextItem) {
              event.preventDefault()
              nextItem.focus()
            }
          }}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 50,
            minWidth: 230,
            maxWidth: 340,
            padding: 4,
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <OpenMenuItem t={t} onClick={() => choose(onBrowse)}>
            <Ico d={ICONS.folder} size={ICON_SIZE.nav} />
            <span>Open project file...</span>
          </OpenMenuItem>
          {recents.length > 0 && (
            <>
              <div
                aria-hidden
                style={{
                  padding: '6px 8px 2px',
                  fontFamily: FONTS.sans,
                  fontSize: 10,
                  letterSpacing: 0.2,
                  color: t.dimText,
                }}
              >
                Recent
              </div>
              {recents.map((project) => (
                <OpenMenuItem
                  key={project.path}
                  t={t}
                  title={project.path}
                  onClick={() => choose(() => onOpenRecent(project.path))}
                >
                  <Ico d={ICONS.file} size={ICON_SIZE.nav} />
                  <span
                    style={{
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        color: t.text,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {project.name}
                    </span>
                    <span
                      style={{
                        fontFamily: FONTS.mono,
                        fontSize: 10,
                        color: t.dim,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {project.path}
                    </span>
                  </span>
                </OpenMenuItem>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** A failed toolbar action and the project state it failed on. */
interface ProjectActionFailure {
  action: 'open' | 'save'
  message: string
  /** The edit count when the action started; any later edit clears it. */
  revision: number
  /** Whether the project had unsaved changes when the action started. */
  dirty: boolean
}

/** The fact each failed toolbar action states before its reason. */
const PROJECT_ACTION_FAILED: Record<ProjectActionFailure['action'], string> = {
  open: 'The project was not opened.',
  save: 'The project was not saved.',
}

/** Configuration for the {@link ProjectToolbar}. */
interface ProjectToolbarProps {
  /** Report that Open... or Save failed, with the state it started on. */
  onFailure: (failure: ProjectActionFailure) => void
  /** Clear the last failure when another Open... or Save starts. */
  onAttempt: () => void
}

/** Group New, Open, and Save project actions in one toolbar. */
function ProjectToolbar({
  onFailure,
  onAttempt,
}: ProjectToolbarProps): ReactNode {
  const {
    t,
    dirty,
    hasProject,
    configRevision,
    openProject,
    newProject,
    saveProject,
    saveState,
  } = useApp()
  const lifecycle = useProjectLifecycle()

  // Report a failed Open... (for example, for a moved or corrupt project
  // file) or Save so the click never fails silently. The shell states it in
  // a row below the toolbar: in this nav, which does not shrink, it would
  // squeeze the Primary navigation to clipped labels.
  const openSaved = useCallback(async (): Promise<void> => {
    const started = { revision: configRevision, dirty }
    onAttempt()
    try {
      const picked = await getApi().fs.chooseFile({
        filters: PROJECT_FILE_FILTER,
      })
      if (picked) {
        lifecycle.requestBoundary('open-project', () => openProject(picked))
      }
    } catch (e) {
      onFailure({
        action: 'open',
        message: errorMessageText(e instanceof Error ? e.message : String(e)),
        ...started,
      })
    }
  }, [openProject, lifecycle, configRevision, dirty, onAttempt, onFailure])

  const save = useCallback(async (): Promise<void> => {
    const started = { revision: configRevision, dirty }
    onAttempt()
    try {
      await saveProject()
    } catch (cause) {
      onFailure({
        action: 'save',
        message: errorMessageText(
          cause instanceof Error ? cause.message : String(cause),
        ),
        ...started,
      })
    }
  }, [saveProject, configRevision, dirty, onAttempt, onFailure])

  return (
    <nav
      aria-label="Project actions"
      className="sm-no-drag"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
      }}
    >
      <Btn
        t={t}
        small
        label="New"
        onClick={() =>
          lifecycle.requestBoundary('new-project', () => newProject())
        }
        title="Start a new project"
      />
      <OpenMenu
        t={t}
        onBrowse={() => void openSaved()}
        onOpenRecent={(path) =>
          lifecycle.requestBoundary('open-recent', () => openProject(path))
        }
      />
      <Btn
        t={t}
        small
        label="Save"
        onClick={() => void save()}
        disabled={!dirty || !hasProject || saveState.phase === 'saving'}
        title={
          !hasProject
            ? 'Create or open a project first.'
            : !dirty
              ? 'The project has no unsaved changes.'
              : 'Save the project.'
        }
      />
    </nav>
  )
}

/** Configuration for the {@link ProjectActionError}. */
interface ProjectActionErrorProps {
  t: Theme
  failure: ProjectActionFailure
  onDismiss: () => void
}

/**
 * State a failed toolbar action in a row of its own below the toolbar. The
 * message wraps, so a long reason never takes width from the navigation.
 */
function ProjectActionError({
  t,
  failure,
  onDismiss,
}: ProjectActionErrorProps): ReactNode {
  const failed = statusColor(t, 'failed')
  return (
    <div
      style={{
        flexShrink: 0,
        margin: '6px 14px 0',
        padding: '4px 6px 4px 10px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 10,
        rowGap: 6,
        borderRadius: 5,
        background: statusSoft(t, 'failed'),
        border: `1px solid ${failed}`,
        borderLeft: `3px solid ${failed}`,
        fontFamily: FONTS.sans,
        fontSize: 12,
        lineHeight: 1.4,
        color: t.text,
      }}
    >
      <div
        role="alert"
        style={{
          flex: '1 1 16em',
          minWidth: 0,
          padding: '3px 0',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 6,
          overflowWrap: 'anywhere',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: '1.4em',
            flexShrink: 0,
          }}
        >
          <NoticeGlyph t={t} tone="failed" />
        </span>
        <span>
          <strong style={{ color: failed }}>
            {PROJECT_ACTION_FAILED[failure.action]}
          </strong>{' '}
          {failure.message}
        </span>
      </div>
      <Btn
        t={t}
        small
        ghost
        label="Dismiss"
        ariaLabel={`Dismiss the project ${failure.action} error`}
        onClick={onDismiss}
      />
    </div>
  )
}

/** Configuration for the {@link TopBar}. */
interface TopBarProps {
  onOpenPalette: () => void
}

/**
 * Tool-status item ids that draw a chip in the full top bar only while they
 * need attention. The full chip row has no room for a sixth permanent chip at
 * the narrow end of the full layout, so a found or unused item of this kind
 * folds into the summary: the compact count and the button's accessible name
 * still include it. The sidecar lists BrainCharts only while the project
 * turns that stage on.
 */
const ATTENTION_ONLY_TOOL_ITEMS: ReadonlySet<string> = new Set([
  'assets',
  'braincharts',
])

/**
 * Summarize the unresolved tool items in one chip whose label states the
 * problem in words, such as "R packages missing" or "2 tools need setup", and
 * whose tooltip names each item and its meaning.
 */
function ToolAttentionChip({
  t,
  items,
}: {
  t: Theme
  items: readonly ToolStatusItem[]
}): ReactNode {
  const allMissing = items.every((item) => item.status === 'missing')
  const status = items.some((item) => item.status === 'missing')
    ? 'missing'
    : 'warn'
  const label =
    items.length === 1
      ? `${items[0]?.label ?? 'Tool'} ${allMissing ? 'missing' : 'needs setup'}`
      : `${items.length} tools ${allMissing ? 'missing' : 'need setup'}`
  const title = items
    .map((item) => {
      const chipStatus = item.status === 'warn' ? 'warn' : 'missing'
      return `${item.label}: ${
        UNRESOLVED_TOOL_ITEM_MEANING[item.id] ??
        STATUS_MEANING[chipStatus] ??
        item.status
      }`
    })
    .join(' ')
  return <Chip t={t} status={status} label={label} small title={title} />
}

/** Report whether a tool-status item still needs the operator's attention. */
function toolItemUnresolved(item: ToolStatusItem): boolean {
  return item.status === 'missing' || item.status === 'warn'
}

/**
 * Tooltip text for an unresolved headline item that no install fixes, keyed by
 * tool-status item id. The reviewed scientific assets come back through the
 * rebuild or the acquisition that Diagnostics offers.
 */
const UNRESOLVED_TOOL_ITEM_MEANING: Readonly<Record<string, string>> = {
  assets:
    'The reviewed scientific assets are missing or do not verify. Open Diagnostics to restore them.',
  braincharts:
    'The BrainCharts model or runtime is not set up. Open Diagnostics to set it up under Scientific resources.',
}

/**
 * Name the header tool-status button by what Diagnostics offers: a review when
 * every applicable tool is found, or a fix for the rest.
 */
function toolButtonLabel(
  summary: { ok: number; total: number } | null,
): string {
  if (!summary || summary.total === 0) {
    return 'Open Diagnostics to review pipeline tools, none required'
  }
  const unresolved = summary.total - summary.ok
  const found = `${summary.ok} of ${summary.total} found`
  return unresolved === 0
    ? `Open Diagnostics to review pipeline tools, ${found}`
    : `Open Diagnostics to fix ${unresolved} pipeline ${unresolved === 1 ? 'tool' : 'tools'}, ${found}`
}

/** Append a keyboard shortcut to a tooltip, after any reason it states. */
function withShortcut(reason: string | undefined, keys: string): string {
  return reason ? `${reason} Shortcut: ${keys}.` : `Shortcut: ${keys}.`
}

/** Render the compact top bar for project identity, cohort progress, and search. */
function TopBar({ onOpenPalette }: TopBarProps): ReactNode {
  const {
    t,
    cfg,
    subjects,
    dirty,
    toolStatus,
    route,
    setRoute,
    projectRef,
    hostState: host,
  } = useApp()
  const runtime = useRuntime()
  // Read the shared stage currency, so a subject whose finished stages Run all
  // would repeat counts as out of date here as it does on the Dashboard.
  const currency = useProjectStageCurrency({
    project: projectRef,
    subjects,
    runs: runtime.runs,
    enabled: !runtime.hydrating,
  })
  // Count as the Dashboard tiles do: a stage turned off reads skipped.
  const displaySubjects = useMemo(
    () =>
      applyStageCurrency(
        skipDisabledStages(
          projectSubjectRuntimeStatus(subjects, runtime.runs, runtime.jobs),
          cfg,
        ),
        currency,
      ),
    [subjects, runtime.runs, runtime.jobs, cfg, currency],
  )
  // Count every discovered subject, as the Dashboard tiles do, so the bar's
  // total matches the Subjects tile and its Excluded share draws.
  const stats = useMemo(
    () => deriveCohortStats(displaySubjects),
    [displaySubjects],
  )
  const projectTitle = cfg.project.name.trim() || 'Untitled project'
  const [compact, setCompact] = useState(false)
  const topBarRef = useRef<HTMLElement | null>(null)
  // Use this bar as the frameless title bar, and draw the custom window
  // controls inside it.
  const showWindowControls =
    host?.mode === 'electron' && host.captionMode === 'custom'
  // The caption controls replace the right padding, so they add only the rest
  // of their width to the border box the full layout needs.
  const captionAllowance = showWindowControls
    ? CAPTION_CONTROLS_WIDTH - FULL_BAR_PADDING_X
    : 0
  // Draw a chip only for an item that needs attention, and widen the
  // full-layout budget while an attention-only item draws one.
  const chipItems = useMemo(
    () => (toolStatus?.items ?? []).filter(toolItemUnresolved),
    [toolStatus],
  )
  const barBudget =
    FULL_BAR_BUDGET +
    chipItems.filter((item) => ATTENTION_ONLY_TOOL_ITEMS.has(item.id)).length *
      ATTENTION_CHIP_ALLOWANCE

  useEffect(() => {
    const node = topBarRef.current
    if (!node) return undefined
    // The caption controls never shrink, so exclude the width they reserve
    // before comparing the remaining room against the full-layout budget.
    // Judge the border box: the two layouts pad the bar differently, so a
    // content width would select a layout whose own padding selects the other.
    const update = (width: number): void => {
      if (width > 0) setCompact(width - captionAllowance < barBudget)
    }
    update(node.offsetWidth)
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        update(entry.borderBoxSize?.[0]?.inlineSize ?? node.offsetWidth)
      }
    })
    observer.observe(node, { box: 'border-box' })
    return () => observer.disconnect()
  }, [captionAllowance, barBudget])

  // Count only the tools the saved pipeline configuration uses, so a stage the
  // project disabled cannot shrink the compact ratio or darken its chip.
  const compactToolStatus = useMemo(() => {
    if (!toolStatus || toolStatus.items.length === 0) return null
    const applicable = toolStatus.items.filter((item) => item.status !== 'na')
    const ok = applicable.filter((item) => item.status === 'ok').length
    const status = applicable.some((item) => item.status === 'missing')
      ? 'missing'
      : applicable.some((item) => item.status === 'warn')
        ? 'warn'
        : applicable.length > 0
          ? 'found'
          : 'na'
    return {
      ok,
      status: status as 'found' | 'warn' | 'missing' | 'na',
      total: applicable.length,
    }
  }, [toolStatus])

  // Distinguish a live process from a responsive runtime. Report an unreadable
  // authoritative snapshot instead of inferring readiness from process state.
  const workflowUnverified =
    host?.sidecar.state === 'ready' &&
    host.sidecar.projectAttached &&
    projectRef !== null &&
    !runtime.authoritativeRuntimeKnown
  const workflowStatus: ChipStatus | null = host
    ? workflowUnverified
      ? 'warn'
      : host.sidecar.state === 'ready' && host.sidecar.projectAttached
        ? 'found'
        : host.sidecar.state === 'ready'
          ? 'warn'
          : host.sidecar.state === 'unavailable'
            ? 'missing'
            : host.sidecar.state === 'degraded'
              ? 'warn'
              : 'running'
    : null
  const workflowLabel = host
    ? workflowUnverified
      ? 'Workflow unverified'
      : host.sidecar.state === 'ready' && !host.sidecar.projectAttached
        ? 'No project open'
        : `Workflow ${host.sidecar.state}`
    : null
  // The normal state shows no status; only a problem draws the button. Setup
  // without a project is normal too, since the wizard is how one opens.
  const workflowQuiet =
    host?.sidecar.state === 'ready' &&
    (host.sidecar.projectAttached ? !workflowUnverified : route === 'wizard')
  const toolChipShown = compact
    ? compactToolStatus !== null &&
      compactToolStatus.ok < compactToolStatus.total
    : chipItems.length > 0

  return (
    <header
      ref={topBarRef}
      data-layout={compact ? 'compact' : 'full'}
      className="sm-drag"
      style={{
        height: 'var(--ss-bar-h)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 8 : 12,
        // Let the custom window controls reach the right corner where they are
        // shown.
        paddingLeft: compact ? 10 : FULL_BAR_PADDING_X,
        paddingRight: showWindowControls ? 0 : FULL_BAR_PADDING_X,
        background: t.surface,
        borderBottom: `1px solid ${t.border}`,
      }}
    >
      <span
        style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}
      >
        <Brandmark size={26} />
        <span
          style={{
            fontFamily: FONTS.sans,
            fontSize: 15,
            letterSpacing: 0.2,
            color: t.textStrong,
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ fontWeight: 700 }}>Supraspina</span>
        </span>
      </span>
      <span
        className="sm-no-drag"
        role="group"
        title={projectTitle}
        aria-label={`Current project: ${projectTitle}`}
        style={{
          minWidth: 0,
          // Space, not a rule, separates the app name from the project.
          marginLeft: compact ? 0 : 12,
          // Keep the project name in the compact bar; the operator has to
          // know which project is open more than they need the full label
          // widths, so it yields room by truncating instead of vanishing.
          flex: compact ? '0 1 160px' : '1 1 auto',
          maxWidth: compact ? 160 : undefined,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: FONTS.sans,
          fontSize: 14,
          fontWeight: 500,
          color: t.textSoft,
        }}
      >
        {projectTitle}
      </span>

      {stats.total > 0 && (
        <CohortBar
          t={t}
          stats={stats}
          checked={currency.checked}
          compact={compact}
        />
      )}

      <span style={{ flex: 1 }} />

      {host && workflowStatus && workflowLabel && !workflowQuiet && (
        <button
          type="button"
          className="sm-no-drag"
          onClick={() => setRoute('diagnostics')}
          aria-label={`Review ${workflowLabel.toLowerCase()} status in Diagnostics`}
          title={
            workflowUnverified
              ? (runtime.error ??
                'The workflow service could not read the current project state.')
              : (host.sidecar.detail ??
                (host.sidecar.state === 'ready' && !host.sidecar.projectAttached
                  ? 'The workflow service is ready, and no project is attached.'
                  : `Workflow service: ${host.sidecar.state}`))
          }
          style={{
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 10px 0 6px',
            border: 'none',
            background: 'transparent',
            color: t.textSoft,
            fontFamily: FONTS.sans,
            fontSize: 11,
            fontWeight: 400,
            lineHeight: 1,
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          }}
        >
          <ChipGlyph t={t} status={workflowStatus} />
          <span>{workflowLabel}</span>
        </button>
      )}

      {toolStatus && toolChipShown && (
        <button
          type="button"
          className="sm-no-drag"
          onClick={() => setRoute('diagnostics')}
          aria-label={toolButtonLabel(compactToolStatus)}
          title="Review detected pipeline tools in Diagnostics."
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 4px',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          {compact && compactToolStatus ? (
            <Chip
              t={t}
              status={compactToolStatus.status}
              label={
                compactToolStatus.total > 0
                  ? `Tools ${compactToolStatus.ok}/${compactToolStatus.total}`
                  : 'Tools not required'
              }
              small
            />
          ) : (
            <ToolAttentionChip t={t} items={chipItems} />
          )}
        </button>
      )}

      {dirty && <TextPill t={t} label="Unsaved" color={t.warning} />}

      <button
        type="button"
        className="sm-no-drag"
        onClick={onOpenPalette}
        aria-label="Open command palette"
        style={{
          width: compact ? 34 : 240,
          // Reserve the preferred width, and yield it back when the bar runs
          // short at a large text scale. The hint text truncates first because
          // it is the only child that shrinks.
          minWidth: compact ? undefined : PALETTE_BUTTON_MIN_WIDTH,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: compact ? 0 : '0 10px',
          border: `1px solid ${t.border}`,
          borderRadius: 6,
          background: t.surface2,
          color: t.dim,
          cursor: 'pointer',
          fontFamily: FONTS.sans,
          fontSize: 12,
          flexShrink: compact ? 0 : 1,
          justifyContent: compact ? 'center' : undefined,
        }}
      >
        <Ico d={ICONS.search} size={ICON_SIZE.nav} />
        {!compact && (
          <>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                textAlign: 'left',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              Search or run...
            </span>
            <Kbd t={t} muted>
              Ctrl+K
            </Kbd>
          </>
        )}
      </button>

      {showWindowControls && <WindowControls t={t} />}
    </header>
  )
}

/** Render one caption button in the custom window-control cluster. */
function WinBtn({
  t,
  ariaLabel,
  onClick,
  danger,
  children,
}: {
  t: Theme
  ariaLabel: string
  onClick: () => void
  danger?: boolean
  children: ReactNode
}): ReactNode {
  const [hover, setHover] = useState(false)
  const background = hover
    ? danger
      ? t.failedSoft
      : t.surface2
    : 'transparent'
  const color = hover && danger ? t.failed : t.dim
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: CAPTION_BUTTON_WIDTH,
        height: 'var(--ss-bar-h)',
        display: 'grid',
        placeItems: 'center',
        border: 'none',
        background,
        color,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

/** Render native-style caption controls for frameless Windows and Linux windows. */
function WindowControls({ t }: { t: Theme }): ReactNode {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let alive = true
    void getApi()
      .window.isMaximized()
      .then((m) => {
        if (alive) setMaximized(m)
      })
      .catch(() => undefined)
    const unsub = getApi().window.onMaximizeChange(setMaximized)
    return () => {
      alive = false
      unsub()
    }
  }, [])
  return (
    <span
      className="sm-no-drag"
      style={{ display: 'inline-flex', alignItems: 'stretch', flexShrink: 0 }}
    >
      <WinBtn
        t={t}
        ariaLabel="Minimize"
        onClick={() => void getApi().window.minimize()}
      >
        <Ico d={ICONS.dash} size={ICON_SIZE.nav} />
      </WinBtn>
      <WinBtn
        t={t}
        ariaLabel={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void getApi().window.toggleMaximize()}
      >
        {maximized ? (
          <Ico d={ICONS.restore} size={ICON_SIZE.nav} />
        ) : (
          <Ico d={ICONS.maximize} size={ICON_SIZE.nav} />
        )}
      </WinBtn>
      <WinBtn
        t={t}
        ariaLabel="Close"
        danger
        onClick={() => void getApi().window.close()}
      >
        <Ico d={ICONS.x} size={ICON_SIZE.nav} />
      </WinBtn>
    </span>
  )
}

/** Render the horizontal navigation bar that reaches all thirteen routes. */
function TopNav(): ReactNode {
  const { t, route, setRoute, subjects } = useApp()
  const [hovered, setHovered] = useState<Route | null>(null)
  const [fitCount, setFitCount] = useState(RAIL_ROUTES.length)
  const [moreOpen, setMoreOpen] = useState(false)
  const navRef = useRef<HTMLElement | null>(null)
  const probeRef = useRef<HTMLSpanElement | null>(null)
  const moreRegionRef = useRef<HTMLDivElement | null>(null)
  const moreButtonRef = useRef<HTMLButtonElement | null>(null)
  const moreMenuRef = useRef<HTMLDivElement | null>(null)
  const moreInitialFocusRef = useRef<'first' | 'last'>('first')
  const fitCountRef = useRef(RAIL_ROUTES.length)
  const failedCount = useMemo(
    () =>
      analysisEligibleSubjects(subjects).filter((subject) =>
        subject.cells.some((cell) => cell.st === 'failed'),
      ).length,
    [subjects],
  )
  // Show as many tabs as fit, in order, and move the rest to the More menu.
  // The widths come from a hidden probe that holds every label, so the count
  // follows the row width and the text size alone: it does not depend on the
  // tabs drawn now or on the active one, and cannot oscillate at a boundary.
  const measureFit = useCallback((): number => {
    const node = navRef.current
    const probe = probeRef.current
    if (!node || !probe) return RAIL_ROUTES.length
    const widths = (kind: string): number[] =>
      Array.from(
        probe.querySelectorAll<HTMLElement>(`[data-nav-probe="${kind}"]`),
        (element) => element.getBoundingClientRect().width,
      )
    // Every tab reserves its bold label width, so measure the bold labels.
    const strong = widths('strong')
    const tabChrome = widths('tab')[0] ?? 0
    const triggerChrome = widths('trigger')[0] ?? 0
    return navFitCount({
      available: node.getBoundingClientRect().width,
      tabs: strong.map((width) => (width > 0 ? tabChrome + width : 0)),
      gap: RAIL_GAP,
      trigger: triggerChrome + Math.max(0, ...strong, ...widths('more')),
    })
  }, [])
  const applyFit = useCallback(
    (beforePaint: boolean): void => {
      const next = measureFit()
      if (next === fitCountRef.current) return
      fitCountRef.current = next
      const commit = (): void => {
        setFitCount(next)
        if (next === RAIL_ROUTES.length) setMoreOpen(false)
      }
      // A resize callback runs before the frame paints; commit inside it so
      // no frame shows the old tab count at the new width.
      if (beforePaint) flushSync(commit)
      else commit()
    },
    [measureFit],
  )
  useEffect(() => {
    const node = navRef.current
    const probe = probeRef.current
    let active = true
    // A late font swap changes the label widths without resizing the row.
    void document.fonts?.ready.then(() => {
      if (active) applyFit(false)
    })
    if (!node || !probe || typeof ResizeObserver === 'undefined') {
      return () => {
        active = false
      }
    }
    const observer = new ResizeObserver(() => applyFit(true))
    observer.observe(node)
    observer.observe(probe)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [applyFit])
  // Measure once before the first paint.
  useLayoutEffect(() => {
    applyFit(false)
  }, [applyFit])
  // Focus synchronously in the commit that renders the menu: a
  // requestAnimationFrame callback is throttled while the window is occluded,
  // and the real-Electron keyboard check reads the focused element
  // immediately.
  useLayoutEffect(() => {
    if (!moreOpen) return
    const items =
      moreMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      )
    if (!items || items.length === 0) return
    const target =
      moreInitialFocusRef.current === 'last'
        ? items.item(items.length - 1)
        : items.item(0)
    moreInitialFocusRef.current = 'first'
    target.focus()
  }, [moreOpen])
  useEffect(() => {
    if (!moreOpen) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !moreRegionRef.current?.contains(event.target)
      ) {
        setMoreOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setMoreOpen(false)
      moreButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [moreOpen])
  const [moreFocused, setMoreFocused] = useState<string | null>(null)
  const visibleRoutes = RAIL_ROUTES.slice(0, fitCount)
  const overflowRoutes = RAIL_ROUTES.slice(fitCount)
  const overflowActive = overflowRoutes.some((item) => item.route === route)

  return (
    <nav
      ref={navRef}
      aria-label="Primary"
      style={{
        // Let the action-navigation row own the background and bottom border.
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'flex-start',
        alignItems: 'stretch',
        gap: RAIL_GAP,
        overflow: 'visible',
        position: 'relative',
      }}
    >
      {/*
        Hold every label off screen so the fit never depends on what is drawn.
        The text comes from a CSS attribute, so no query or reader finds it.
      */}
      <span
        ref={probeRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          height: 0,
          overflow: 'hidden',
          display: 'flex',
          visibility: 'hidden',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          fontFamily: FONTS.sans,
          fontSize: RAIL_FONT_SIZE,
        }}
      >
        {RAIL_ROUTES.map((item) => (
          <Fragment key={item.route}>
            <span
              className="sm-nav-probe"
              data-nav-probe="strong"
              data-label={item.label}
              style={{ flex: 'none', fontWeight: 700 }}
            />
          </Fragment>
        ))}
        <span
          className="sm-nav-probe"
          data-nav-probe="more"
          data-label="More"
          style={{ flex: 'none', fontWeight: 400 }}
        />
        {/* The parts of a tab and of the trigger that are not label text. */}
        <span
          data-nav-probe="tab"
          style={{
            flex: 'none',
            display: 'inline-flex',
            gap: RAIL_TAB_GAP,
            padding: RAIL_TAB_PADDING,
          }}
        >
          <span style={{ width: 16, flexShrink: 0 }} />
          <span />
        </span>
        <span
          data-nav-probe="trigger"
          style={{
            flex: 'none',
            display: 'inline-flex',
            gap: RAIL_TRIGGER_GAP,
            padding: RAIL_TRIGGER_PADDING,
          }}
        >
          <span />
          <span style={{ width: 12, flexShrink: 0 }} />
        </span>
      </span>
      {visibleRoutes.map((item) => {
        const active = route === item.route
        const showFailedDot = item.route === 'subjects' && failedCount > 0
        return (
          <button
            key={item.route}
            type="button"
            aria-label={item.label}
            // The failure dot states its count in words: the tooltip shows it
            // and readers get it as the tab's description, which keeps the
            // tab's name stable.
            title={
              showFailedDot
                ? `${failedCount} subject${failedCount === 1 ? ' has' : 's have'} a failed step.`
                : undefined
            }
            aria-current={active ? 'page' : undefined}
            onClick={() => setRoute(item.route)}
            onMouseEnter={() => setHovered(item.route)}
            onMouseLeave={() =>
              setHovered((h) => (h === item.route ? null : h))
            }
            style={{
              position: 'relative',
              flex: '0 1 auto',
              minWidth: 0,
              height: 'var(--ss-bar-h)',
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: RAIL_TAB_GAP,
              padding: RAIL_TAB_PADDING,
              border: 'none',
              background:
                !active && hovered === item.route ? t.surface2 : 'transparent',
              color: active
                ? t.textStrong
                : hovered === item.route
                  ? t.text
                  : t.dim,
              cursor: 'pointer',
              transition: 'background .12s, color .12s',
            }}
          >
            <span
              style={{
                position: 'relative',
                display: 'inline-flex',
                flexShrink: 0,
              }}
            >
              <Ico
                d={ICONS[item.icon]}
                size={ICON_SIZE.nav}
                stroke={active ? t.accent : 'currentColor'}
              />
              {showFailedDot && (
                <span
                  aria-hidden
                  style={{
                    position: 'absolute',
                    top: -3,
                    right: -3,
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: t.failed,
                    // Cut the dot out of the icon stroke beneath it.
                    boxShadow: `0 0 0 2px ${t.surface}`,
                  }}
                />
              )}
            </span>
            {/* Every tab reserves its bold label width, so the tabs after
                the active one never shift when the route changes. The
                reserving copy comes from a CSS attribute, so no query or
                reader finds it. */}
            <span
              style={{
                display: 'inline-grid',
                minWidth: 0,
                fontFamily: FONTS.sans,
                fontSize: RAIL_FONT_SIZE,
              }}
            >
              <span
                style={{
                  gridArea: '1 / 1',
                  fontWeight: active ? 700 : 400,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  minWidth: 0,
                }}
              >
                {item.label}
              </span>
              <span
                aria-hidden="true"
                className="sm-nav-probe"
                data-label={item.label}
                style={{
                  gridArea: '1 / 1',
                  fontWeight: 700,
                  visibility: 'hidden',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  minWidth: 0,
                  height: 0,
                }}
              />
            </span>
            {active && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 8,
                  right: 8,
                  bottom: 0,
                  height: 2,
                  borderRadius: 2,
                  background: t.accent,
                }}
              />
            )}
          </button>
        )
      })}
      {overflowRoutes.length > 0 && (
        <div
          ref={moreRegionRef}
          style={{ position: 'relative', flexShrink: 0 }}
        >
          <button
            ref={moreButtonRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            // The open menu marks the current route on its own item, so the
            // trigger yields aria-current while the menu is expanded and
            // exactly one element stays current.
            aria-current={overflowActive && !moreOpen ? 'page' : undefined}
            onClick={() => {
              moreInitialFocusRef.current = 'first'
              setMoreOpen((open) => !open)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              moreInitialFocusRef.current =
                event.key === 'ArrowUp' ? 'last' : 'first'
              setMoreOpen(true)
            }}
            style={{
              height: 'var(--ss-bar-h)',
              padding: RAIL_TRIGGER_PADDING,
              border: 'none',
              borderBottom: overflowActive ? `2px solid ${t.accent}` : 'none',
              background: moreOpen ? t.surface2 : 'transparent',
              color: overflowActive ? t.textStrong : t.dim,
              fontFamily: FONTS.sans,
              fontSize: RAIL_FONT_SIZE,
              fontWeight: overflowActive ? 700 : 400,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: RAIL_TRIGGER_GAP,
            }}
          >
            {overflowRoutes.find((item) => item.route === route)?.label ??
              'More'}
            <Ico
              d={ICONS.chevron}
              size={ICON_SIZE.nav}
              style={{ transform: 'rotate(90deg)' }}
            />
          </button>
          {moreOpen && (
            <div
              ref={moreMenuRef}
              role="menu"
              aria-label="More workspaces"
              onKeyDown={(event) => {
                const items = Array.from(
                  moreMenuRef.current?.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]',
                  ) ?? [],
                )
                const current = items.indexOf(
                  document.activeElement as HTMLButtonElement,
                )
                let next: number | null = null
                if (event.key === 'ArrowDown')
                  next = (current + 1) % items.length
                if (event.key === 'ArrowUp') {
                  next = (current - 1 + items.length) % items.length
                }
                if (event.key === 'Home') next = 0
                if (event.key === 'End') next = items.length - 1
                if (event.key === 'Tab') setMoreOpen(false)
                const nextItem = next === null ? undefined : items[next]
                if (nextItem) {
                  event.preventDefault()
                  nextItem.focus()
                }
              }}
              style={{
                position: 'absolute',
                zIndex: 30,
                top: '100%',
                right: 0,
                minWidth: 180,
                padding: 4,
                border: `1px solid ${t.border}`,
                borderRadius: 6,
                background: t.surface,
                boxShadow: t.shadow,
              }}
            >
              {overflowRoutes.map((item) => (
                <button
                  key={item.route}
                  type="button"
                  role="menuitem"
                  className="sm-menu-item"
                  tabIndex={-1}
                  aria-current={route === item.route ? 'page' : undefined}
                  onClick={() => {
                    setRoute(item.route)
                    setMoreOpen(false)
                  }}
                  onFocus={() => setMoreFocused(item.route)}
                  onBlur={() => setMoreFocused(null)}
                  style={{
                    width: '100%',
                    minHeight: 28,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 8px',
                    border: 'none',
                    borderRadius: 4,
                    background:
                      route === item.route
                        ? t.accentSoft
                        : moreFocused === item.route
                          ? t.surface2
                          : 'transparent',
                    color: route === item.route ? t.textStrong : t.text,
                    fontFamily: FONTS.sans,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  <Ico d={ICONS[item.icon]} size={ICON_SIZE.nav} />
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </nav>
  )
}

/** Configuration for {@link MainPane}. */
interface MainPaneProps {
  /** Provide the latest environment report for option gating. */
  envReport: EnvReport | null
  /** Replace that report when a Diagnostics re-check completes. */
  onEnvReport: (report: EnvReport) => void
}

function MainPane({ envReport, onEnvReport }: MainPaneProps): ReactNode {
  const {
    cfg,
    setCfg,
    dirty,
    subjects,
    discoveryAnswered,
    refreshSubjects,
    selection,
    setSelection,
    activeSubjectId,
    setActiveSubjectId,
    safeExecution,
    setSafeExecution,
    toolStatus,
    route,
    setRoute,
    resultsStage,
  } = useApp()
  const runtime = useRuntime()
  // The Dashboard and Subjects mark out-of-date cells from the shared stage
  // currency themselves; Runs counts per-stage states instead of these cells.
  const displaySubjects = useMemo(
    () => projectSubjectRuntimeStatus(subjects, runtime.runs, runtime.jobs),
    [subjects, runtime.runs, runtime.jobs],
  )

  const onSetSelection = useCallback(
    (next: ReadonlySet<string>) => setSelection(next),
    [setSelection],
  )
  const onActiveSubjectChange = useCallback(
    (id: string) => setActiveSubjectId(id),
    [setActiveSubjectId],
  )
  const onCfgChange = useCallback(
    (next: ProjectConfig) => setCfg(next),
    [setCfg],
  )
  const goToQc = useCallback(() => setRoute('qc'), [setRoute])

  // Offer only QC backends that the host can run.
  const disabledBackends = useMemo(
    () => unavailableEnigmaBackends(envReport),
    [envReport],
  )
  // Share environment-derived stage blockers with the run dock and Runs screen.
  const stageBlockers = useMemo(
    () => computeStageBlockers(envReport, cfg),
    [envReport, cfg],
  )

  let screen: ReactNode
  switch (route) {
    case 'project':
      screen = (
        <ProjectDashboard
          cfg={cfg}
          subjects={displaySubjects}
          // Until discovery answers, an empty list is a cohort still loading;
          // the tiles hold "--" instead of counting "Subjects 0".
          loading={runtime.hydrating || !discoveryAnswered}
          runtimeRuns={runtime.runs}
          selection={selection}
          onSelectionChange={onSetSelection}
          activeSubjectId={activeSubjectId}
          onActiveSubjectChange={onActiveSubjectChange}
          dirty={dirty}
          refresh={refreshSubjects}
        />
      )
      break
    case 'subjects':
      screen = (
        <SubjectsScreen
          cfg={cfg}
          subjects={displaySubjects}
          selection={selection}
          onSelectionChange={onSetSelection}
          activeSubjectId={activeSubjectId}
          onActiveSubjectChange={(id) => {
            onActiveSubjectChange(id)
            goToQc()
          }}
          refresh={refreshSubjects}
        />
      )
      break
    case 'runs':
      screen = (
        <RunsScreen
          cfg={cfg}
          subjects={displaySubjects}
          dirty={dirty}
          refresh={refreshSubjects}
          blockers={stageBlockers}
          envReport={envReport}
          onEnvReport={onEnvReport}
        />
      )
      break
    case 'logs':
      screen = (
        <LogsScreen
          cfg={cfg}
          subjects={subjects}
          toolStatus={toolStatus}
          refresh={refreshSubjects}
        />
      )
      break
    case 'qc':
      screen = (
        <QcReviewScreen
          cfg={cfg}
          subjects={subjects}
          activeSubjectId={activeSubjectId}
          onActiveSubjectChange={onActiveSubjectChange}
          refresh={refreshSubjects}
        />
      )
      break
    case 'inputQc':
      screen = <InputQcScreen />
      break
    case 'diagnostics':
      screen = (
        <DiagnosticsScreen
          cfg={cfg}
          {...(envReport ? { report: envReport } : {})}
          safeExecution={safeExecution}
          onSafeExecutionChange={setSafeExecution}
          refresh={refreshSubjects}
          onReport={onEnvReport}
        />
      )
      break
    case 'pipeline':
      screen = (
        <PipelineScreen
          cfg={cfg}
          onCfgChange={onCfgChange}
          dirty={dirty}
          disabledChoiceOptions={{ 'enigma.backend': disabledBackends }}
        />
      )
      break
    case 'results':
      screen = (
        <ResultsScreen
          cfg={cfg}
          subjects={subjects}
          toolStatus={toolStatus}
          refresh={refreshSubjects}
          {...(resultsStage ? { focusStepKey: resultsStage } : {})}
        />
      )
      break
    case 'analysis':
      screen = <AnalysisScreen />
      break
    case 'registry':
      screen = <RegistryScreen refresh={refreshSubjects} />
      break
    case 'settings':
      screen = (
        <SettingsScreen
          cfg={cfg}
          safeExecution={safeExecution}
          onSafeExecutionChange={setSafeExecution}
          dirty={dirty}
        />
      )
      break
    case 'wizard':
      screen = (
        <SetupWizard
          cfg={cfg}
          onCfgChange={onCfgChange}
          refresh={refreshSubjects}
          envReport={envReport}
        />
      )
      break
    default:
      screen = null
  }

  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {screen}
    </main>
  )
}

/** Configuration for the density-aware {@link RunDock}. */
interface RunDockProps {
  blockers: StageBlocker[]
  runningJobIds: ReadonlySet<string>
  canResume: boolean
  /**
   * What the failed run's failures are when every one is an input limit,
   * which Resume repeats on the same input, or null. Resume then stays
   * available but is not the primary action.
   */
  resumeInputLimit?: string | null
  /**
   * The reason a launch in progress holds Run all, Run step..., and Resume
   * failed, or null when no plan is pending. Cancel keeps its own rule.
   */
  pendingReason: string | null
  onRunAll: () => void
  onResumeFailed: () => void
  onCancel: () => void
  /**
   * Draw the run buttons without the accent on a route whose screen owns the
   * view's one primary action, such as Approve on Input QC.
   */
  demoteRun?: boolean
}

/** Why the dock holds Run all while a live run is active. */
const RUN_ACTIVE_TITLE =
  'A run is active, and another starts only after it ends.'

/** Render the bottom run dock outside the QC route. */
function RunDock({
  blockers,
  runningJobIds,
  canResume,
  resumeInputLimit = null,
  pendingReason,
  onRunAll,
  onResumeFailed,
  onCancel,
  demoteRun = false,
}: RunDockProps): ReactNode {
  const {
    t,
    executionTarget,
    dirty,
    subjects,
    discoveryAnswered,
    setRoute,
    clearSelection,
    selectAllSubjects,
    hostState,
    cfg,
  } = useApp()
  const runtime = useRuntime()
  const analysisSubjects = useMemo(
    () => analysisEligibleSubjects(subjects),
    [subjects],
  )
  const stats = useMemo(
    () => deriveCohortStats(analysisSubjects),
    [analysisSubjects],
  )
  // Count the cohort only once discovery has answered: before that the chip
  // holds the loading placeholder and Run all names no count, so neither
  // states an empty cohort for a project whose subjects are still loading.
  const cohortSize = knownCohortSize(discoveryAnswered, stats.total)
  // Share one canonical scope string among the pill, button, and Runs screen.
  const scopeLabel = targetScopePillLabel(executionTarget, cohortSize)
  const runLabel = targetRunButtonLabel(executionTarget, cohortSize)
  // The dock counts the analysis cohort, which the Dashboard tiles and the
  // top bar exceed by the excluded subjects; name that cut where it shows.
  const cohortCut = cohortCutTitle(
    cohortSize,
    subjects.length,
    subjects.filter((s) => s.qc === 'fail').length,
  )
  const reconBlocked = blockers.some((b) => b.key === 'recon')
  // Block runs until the analysis cohort contains subjects. Keep this state
  // separate from unsaved project changes. While discovery is still
  // answering, the cohort is unknown rather than empty: say so instead of
  // telling the operator to add subjects to a project that has them.
  const cohortLoading = cohortSize === null
  const cohortEmpty = !cohortLoading && stats.total === 0
  // The runtime restore reads the durable runs, jobs and log tail and settles
  // whether a run is still active; until then no run may start. The cohort is
  // already counted by then, so the line names the restore, not the cohort.
  const hydrating = runtime.hydrating
  const dockWait = cohortLoading
    ? 'Loading the cohort...'
    : hydrating && !cohortEmpty
      ? 'Restoring run history...'
      : null
  const serviceBlocked =
    hostState?.sidecar.state !== 'ready' || !hostState.sidecar.projectAttached
  const runDisabled =
    pendingReason !== null ||
    dirty ||
    reconBlocked ||
    cohortEmpty ||
    serviceBlocked ||
    cohortLoading ||
    hydrating
  // The dock status line and the disabled buttons' tooltips state the same
  // empty-cohort reason.
  const emptyReason =
    subjects.length === 0
      ? 'Add subjects to run.'
      : emptyAnalysisCohortReason(subjects)
  // A pending plan leads because it clears by itself and explains why a click
  // just taken disabled the controls.
  const runTooltip =
    pendingReason ??
    (serviceBlocked
      ? (hostState?.sidecar.detail ??
        (hostState?.sidecar.state === 'ready'
          ? 'Retry project attachment because the workflow service has not attached this project.'
          : `Restore the workflow service from ${hostState?.sidecar.state ?? 'unavailable'} before running.`))
      : dirty
        ? 'Save the project before running (no run while unsaved).'
        : reconBlocked
          ? (blockers.find((b) => b.key === 'recon')?.reason ?? '')
          : cohortEmpty
            ? emptyReason
            : undefined)
  const cancelDisabled = runningJobIds.size === 0
  // The sidecar refuses a live workflow while another run of the project is
  // active, so Run all holds until that run ends instead of opening a launch
  // confirmation for a start that fails after planning. A dry run only plans
  // and may start beside it. Run step... only opens Runs and stays live.
  const liveRunActive = !cancelDisabled && !cfg.runtime.dryRun
  const runAllTooltip =
    runTooltip ?? (liveRunActive ? RUN_ACTIVE_TITLE : undefined)
  // Whether a failure waits or a run is active is the runtime restore's
  // answer. Until a snapshot for this project is accepted it is unknown, not
  // absent, so neither title claims there is nothing to resume or cancel:
  // the dock status states the load, the Workflow chip an unverified
  // restore, and Resume failed keeps only the Run tooltip's cause.
  const runtimeKnown = !runtime.hydrating && runtime.authoritativeRuntimeKnown
  // A disarmed Resume failed states the reason the Runs Resume card gives,
  // from the same recovery rule, rather than an order with nothing to choose.
  const resumeUnavailableReason = useMemo(() => {
    if (!runtimeKnown) return null
    const recovery = recoveryTarget(runtime.runs, runtime.jobs)
    return recovery.run === null
      ? `Nothing to resume: ${recovery.reason}`
      : null
  }, [runtimeKnown, runtime.runs, runtime.jobs])
  const dockBtnStyle = { height: 'var(--ss-input-h)' }
  const resumeLeads = canResume && resumeInputLimit === null

  return (
    <footer
      style={{
        height: 'var(--ss-dock-h)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--ss-gap)',
        padding: '0 14px',
        background: t.surface,
        borderTop: `1px solid ${t.border}`,
      }}
    >
      <ScopeChip
        t={t}
        target={executionTarget}
        label={cohortEmpty ? 'No subjects' : scopeLabel}
        title={
          cohortSize === null
            ? COHORT_LOADING_TITLE
            : cohortCut === null
              ? scopeLabel
              : executionTarget.mode === 'all'
                ? cohortCut
                : `${scopeLabel}. ${cohortCut}`
        }
        onClearSelection={clearSelection}
        onSelectAll={selectAllSubjects}
      />

      {/* A routine load draws the shared loading row; an empty cohort draws
          one neutral line that names the fix. */}
      {dockWait !== null && <LoadingState t={t} label={dockWait} />}
      {cohortEmpty && (
        <span
          role="status"
          style={{
            fontFamily: FONTS.sans,
            fontSize: 11.5,
            color: t.dim,
          }}
        >
          {emptyReason}
        </span>
      )}

      <span style={{ flex: 1 }} />

      <Btn
        t={t}
        icon={<Ico d={ICONS.plus} size={ICON_SIZE.nav} />}
        label="Add subject"
        ghost
        onClick={() => setRoute('registry')}
        style={dockBtnStyle}
      />
      <Btn
        t={t}
        icon={<Ico d={ICONS.stop} size={ICON_SIZE.nav} />}
        label="Cancel"
        danger
        disabled={cancelDisabled}
        title={withShortcut(
          cancelDisabled && runtimeKnown ? 'No run is active.' : undefined,
          'C',
        )}
        onClick={onCancel}
        style={dockBtnStyle}
      />
      <Btn
        t={t}
        icon={<Ico d={ICONS.resume} size={ICON_SIZE.nav} />}
        label="Resume failed"
        primary={resumeLeads && !demoteRun}
        disabled={runDisabled || !canResume}
        title={withShortcut(
          pendingReason ??
            (!canResume
              ? (resumeUnavailableReason ?? runTooltip)
              : (runTooltip ?? resumeInputLimit ?? undefined)),
          'Shift+R',
        )}
        onClick={onResumeFailed}
        style={dockBtnStyle}
      />
      <Btn
        t={t}
        icon={<Ico d={ICONS.pipeline} size={ICON_SIZE.nav} />}
        label="Run step..."
        disabled={runDisabled}
        title={runTooltip}
        onClick={() => setRoute('runs')}
        style={dockBtnStyle}
      />
      {/* One accent button: Resume failed while a failed run waits,
              otherwise Run all, at the trailing edge, unless the screen
              owns the view's primary action. */}
      <Btn
        t={t}
        icon={<Ico d={ICONS.play} size={ICON_SIZE.nav} />}
        label={runLabel}
        primary={!resumeLeads && !demoteRun}
        disabled={runDisabled || liveRunActive}
        title={withShortcut(runAllTooltip, 'R')}
        onClick={onRunAll}
        style={dockBtnStyle}
      />
    </footer>
  )
}

/** One actionable palette row. */
interface PaletteItem {
  id: string
  kind: 'verb' | 'nav' | 'subject'
  label: string
  run: () => void
}

/** Configuration for the mounted {@link CommandPalette}. */
interface CommandPaletteProps {
  onClose: () => void
  onRunAll: () => void
  onResumeFailed: () => void
  onCancel: () => void
  activeCount: number
  canResume: boolean
}

/** Render the mounted Cmd/Ctrl+K command palette. */
function CommandPalette({
  onClose,
  onRunAll,
  onResumeFailed,
  onCancel,
  activeCount,
  canResume,
}: CommandPaletteProps): ReactNode {
  const { t, subjects, setRoute, setActiveSubjectId, hasProject } = useApp()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const hasAnalysisCohort = useMemo(
    () => analysisEligibleSubjects(subjects).length > 0,
    [subjects],
  )

  const items = useMemo<PaletteItem[]>(() => {
    // Offer only the always-safe Setup and project-free Diagnostics routes
    // before a project is loaded.
    if (!hasProject) {
      const setupEntry = RAIL_ROUTES.find((r) => r.route === 'wizard')
      const setupLabel = setupEntry?.label ?? 'Setup'
      return [
        {
          id: 'nav-wizard',
          kind: 'nav',
          label: `Go to ${setupLabel}`,
          run: () => setRoute('wizard'),
        },
        {
          id: 'nav-diagnostics',
          kind: 'nav',
          label: 'Go to Diagnostics',
          run: () => setRoute('diagnostics'),
        },
      ]
    }
    // Withhold run verbs until the analysis cohort is non-empty. Keep Cancel
    // available for in-flight work.
    const runVerbs: PaletteItem[] = hasAnalysisCohort
      ? [
          { id: 'verb-run', kind: 'verb', label: 'Run all', run: onRunAll },
          ...(canResume
            ? [
                {
                  id: 'verb-resume',
                  kind: 'verb' as const,
                  label: 'Resume failed',
                  run: onResumeFailed,
                },
              ]
            : []),
        ]
      : []
    const verbs: PaletteItem[] = [
      ...runVerbs,
      ...(activeCount > 0
        ? [
            {
              id: 'verb-cancel',
              kind: 'verb' as const,
              label: `Cancel ${activeCount} active ${activeCount === 1 ? 'run' : 'runs'}`,
              run: onCancel,
            },
          ]
        : []),
    ]
    const nav: PaletteItem[] = RAIL_ROUTES.map((r) => ({
      id: `nav-${r.route}`,
      kind: 'nav',
      label: `Go to ${r.label}`,
      run: () => setRoute(r.route),
    }))
    const subs: PaletteItem[] = subjects.map((s) => ({
      id: `sub-${s.id}`,
      kind: 'subject',
      label: `Open ${s.id}`,
      run: () => {
        setActiveSubjectId(s.id)
        setRoute('qc')
      },
    }))
    return [...verbs, ...nav, ...subs]
  }, [
    hasProject,
    hasAnalysisCohort,
    subjects,
    setRoute,
    setActiveSubjectId,
    onRunAll,
    onResumeFailed,
    onCancel,
    activeCount,
    canResume,
  ])

  // Match against every item, then bound only the rendered subject rows. The
  // cursor and the listbox both use the bounded list.
  const { filtered, matchCount, subjectMatchCount } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = q
      ? items.filter((i) => i.label.toLowerCase().includes(q))
      : items
    const subjectMatches = matches.filter((i) => i.kind === 'subject')
    return {
      filtered: [
        ...matches.filter((i) => i.kind !== 'subject'),
        ...subjectMatches.slice(0, PALETTE_SUBJECT_LIMIT),
      ],
      matchCount: matches.length,
      subjectMatchCount: subjectMatches.length,
    }
  }, [items, query])
  const subjectsTruncated = subjectMatchCount > PALETTE_SUBJECT_LIMIT
  const truncationNote = subjectsTruncated
    ? `Showing ${PALETTE_SUBJECT_LIMIT} of ${subjectMatchCount} matching subjects. Type more of the ID.`
    : null

  // Derive the effective cursor so it always stays within the filtered range
  // without a clamping effect (no setState during render).
  const maxCursor = Math.max(0, filtered.length - 1)
  const activeCursor = Math.min(cursor, maxCursor)

  // Mount a fresh palette only while open. Delegate focus movement and Tab
  // trapping to the shared Modal atom.
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(Math.min(activeCursor + 1, maxCursor))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(Math.max(activeCursor - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = filtered[activeCursor]
      if (item) {
        item.run()
        onClose()
      }
    }
  }

  const sectionLabels: Record<PaletteItem['kind'], string> = {
    verb: 'Verbs',
    nav: 'Navigation',
    subject: 'Subjects',
  }
  const activeId = filtered[activeCursor]?.id
  // Group kind-ordered results under the valid APG listbox structure.
  const groups: {
    kind: PaletteItem['kind']
    items: [PaletteItem, number][]
  }[] = []
  filtered.forEach((item, idx) => {
    const last = groups[groups.length - 1]
    if (last && last.kind === item.kind) last.items.push([item, idx])
    else groups.push({ kind: item.kind, items: [[item, idx]] })
  })

  return (
    <Modal
      t={t}
      onDismiss={onClose}
      label="Command palette"
      align="start"
      initialFocusRef={inputRef}
      onKeyDown={onKeyDown}
      cardStyle={{ width: 540, maxHeight: '60vh', overflow: 'hidden' }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type a command, route, or subject..."
        aria-label="Command palette query"
        role="combobox"
        aria-expanded={filtered.length > 0}
        aria-controls="palette-listbox"
        aria-activedescendant={activeId ? `palette-opt-${activeId}` : undefined}
        aria-autocomplete="list"
        style={{
          border: 'none',
          borderBottom: `1px solid ${t.border}`,
          background: t.surface,
          color: t.text,
          padding: '12px 14px',
          fontFamily: FONTS.sans,
          fontSize: 14,
        }}
      />
      {/* Announce the changing result count politely under WCAG 2.2 SC 4.1.3. */}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {matchCount === 0
          ? 'No results match this query.'
          : `${matchCount} result${matchCount === 1 ? '' : 's'}.${truncationNote ? ` ${truncationNote}` : ''}`}
      </div>
      <div
        id="palette-listbox"
        role="listbox"
        aria-label="Results"
        style={{ overflowY: 'auto' }}
      >
        {filtered.length === 0 && (
          <div
            style={{
              padding: 14,
              fontFamily: FONTS.sans,
              fontSize: 13,
              color: t.dim,
            }}
          >
            No results match this query.
          </div>
        )}
        {groups.map((group) => (
          <div
            key={group.kind}
            role="group"
            aria-label={sectionLabels[group.kind]}
          >
            <div
              aria-hidden="true"
              style={{
                padding: '8px 14px 4px',
                fontFamily: FONTS.sans,
                fontSize: 10,
                letterSpacing: 0.2,
                color: t.dimText,
              }}
            >
              {sectionLabels[group.kind]}
            </div>
            {group.items.map(([item, idx]) => {
              const selected = idx === activeCursor
              return (
                <button
                  key={item.id}
                  id={`palette-opt-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => {
                    item.run()
                    onClose()
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 14px',
                    border: 'none',
                    background: selected ? t.surface2 : 'transparent',
                    color: t.text,
                    cursor: 'pointer',
                    fontFamily:
                      item.kind === 'subject' ? FONTS.mono : FONTS.sans,
                    fontSize: 13,
                  }}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      {truncationNote && (
        <p
          style={{
            margin: 0,
            padding: '8px 14px',
            borderTop: `1px solid ${t.border}`,
            fontFamily: FONTS.sans,
            fontSize: 12,
            color: t.dim,
          }}
        >
          {truncationNote}
        </p>
      )}
    </Modal>
  )
}

/** Detect whether a keydown event originates from an editable element. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  )
}

/** Prevent run verbs from crossing an open modal boundary. */
function hasOpenDialog(): boolean {
  return (
    document.querySelector(
      'dialog[open], [role="dialog"], [role="alertdialog"]',
    ) !== null
  )
}

const FONT_FACE_PROBES = [
  ...[400, 500, 700].flatMap((weight) =>
    ['normal', 'italic'].map((style) => ({
      family: FONTS.sans,
      name: `sans-${weight}-${style}`,
      style,
      weight,
    })),
  ),
  ...[400, 500, 700].flatMap((weight) =>
    ['normal', 'italic'].map((style) => ({
      family: FONTS.serif,
      name: `serif-${weight}-${style}`,
      style,
      weight,
    })),
  ),
  ...[400, 500, 700].flatMap((weight) =>
    ['normal', 'italic'].map((style) => ({
      family: FONTS.mono,
      name: `mono-${weight}-${style}`,
      style,
      weight,
    })),
  ),
] as const

/**
 * Request every bundled face in the real renderer. Give visual and package
 * tests a stable activation target through the one-pixel, aria-hidden specimen.
 * Use Book and bold-italic emphasis in their normal semantic roles.
 */
function FontActivationProbe(): ReactNode {
  return (
    <div
      aria-hidden="true"
      data-font-activation="fonts-18"
      style={{
        position: 'fixed',
        width: 1,
        height: 1,
        overflow: 'hidden',
        clipPath: 'inset(50%)',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {FONT_FACE_PROBES.map((face) => (
        <span
          key={face.name}
          data-font-face={face.name}
          style={{
            fontFamily: face.family,
            fontStyle: face.style,
            fontWeight: face.weight,
          }}
        >
          Supraspina 0123456789
        </span>
      ))}
    </div>
  )
}

/**
 * Why the dock's controls wait while a workflow launch is planned, stated as
 * what Supraspina is doing.
 */
const WORKFLOW_PLAN_WAIT_REASON = 'Supraspina is planning the workflow.'

/** Why the dock's controls wait while a resume is planned. */
const RESUME_PLAN_WAIT_REASON = 'Supraspina is planning the resume.'

/** Compose the application shell. */
function Shell(): ReactNode {
  const {
    t,
    tweaks,
    resolvedTheme,
    density,
    route,
    setRoute,
    cfg,
    subjects,
    discoveryAnswered,
    firstRun,
    hasProject,
    projectRef,
    projectEpoch,
    configRevision,
    executionTarget,
    pendingPlan,
    trackPlan,
    safeExecution,
    setSafeExecution,
    saveProject,
    dirty,
    setRunsFeedback,
  } = useApp()
  const runtime = useRuntime()
  const execution = useExecutionService()
  const [paletteOpen, setPaletteOpen] = useEpochState(false, projectEpoch)
  const [confirmCohortRun, setConfirmCohortRun] = useEpochState(
    false,
    projectEpoch,
  )
  const [acknowledgeQcScope, setAcknowledgeQcScope] = useEpochState(
    false,
    projectEpoch,
  )
  const [acknowledgeMemoryAdvisory, setAcknowledgeMemoryAdvisory] =
    useEpochState(false, projectEpoch)
  const [env, setEnv] = useState<EnvReport | null>(null)
  // A failed toolbar Open... or Save stays stated until it is dismissed,
  // another attempt starts, or the state it failed on changes: an edit, a
  // save from elsewhere, or another project.
  const [projectActionFailure, setProjectActionFailure] =
    useEpochState<ProjectActionFailure | null>(null, projectEpoch)
  const clearProjectActionFailure = useCallback(
    () => setProjectActionFailure(null),
    [setProjectActionFailure],
  )
  const shownProjectActionFailure =
    projectActionFailure &&
    projectActionFailure.revision === configRevision &&
    projectActionFailure.dirty === dirty
      ? projectActionFailure
      : null
  const [runNotice, setRunNotice] = useEpochState<string | null>(
    null,
    projectEpoch,
  )
  const [runFailure, setRunFailure] = useEpochState<ExecutionFailure | null>(
    null,
    projectEpoch,
  )
  // Retain the whole result: its summary reports totals only, so the blockers
  // stay reachable from the notice after the run.
  const [runOutcome, setRunOutcome] = useEpochState<WorkflowResult | null>(
    null,
    projectEpoch,
  )
  // Name the launch in progress next to the dock, so a click on Run all is
  // answered before the plan review opens, and hold the dock's run controls
  // until the plan settles. The plan is shared with Runs, so a plan started
  // on either holds the other.
  // Clear a neutral outcome when the operator changes tabs. Keep an outcome
  // with blockers until it is dismissed or replaced, so View blockers stays
  // reachable. Reset during render rather than from an effect.
  const [outcomeRoute, setOutcomeRoute] = useState(route)
  if (outcomeRoute !== route) {
    setOutcomeRoute(route)
    if (runNotice !== null && (runOutcome?.plan.blockers.length ?? 0) === 0) {
      setRunNotice(null)
      setRunOutcome(null)
    }
  }
  // Runs keeps its launch feedback in the app state across tabs. Clear a
  // Runs plan that found no work once the operator leaves Runs, as the dock
  // does for its own; an error and any other outcome stay until dismissed or
  // replaced. The feedback lives in the provider, so clear it from an effect.
  const feedbackRouteRef = useRef(route)
  useEffect(() => {
    const leftRuns = feedbackRouteRef.current === 'runs' && route !== 'runs'
    feedbackRouteRef.current = route
    if (leftRuns) setRunsFeedback(withoutNoWorkOutcome)
  }, [route, setRunsFeedback])
  // Clear the shell's launch feedback when a Runs card starts a plan, so the
  // pending line is the only launch feedback in view. The shell's own
  // launches clear it before they publish their plan.
  const [feedbackPlan, setFeedbackPlan] = useState(pendingPlan)
  if (feedbackPlan !== pendingPlan) {
    setFeedbackPlan(pendingPlan)
    if (pendingPlan !== null && pendingPlan.card !== null) {
      setRunFailure(null)
      setRunNotice(null)
      setRunOutcome(null)
    }
  }
  const shellContentRef = useRef<HTMLDivElement | null>(null)

  // Keep the latest route state for the imperative keymap and run handlers.
  // Update the ref inside an effect to prevent concurrent-render tearing.
  const stateRef = useRef({ route, hasProject })
  useEffect(() => {
    stateRef.current = { route, hasProject }
  }, [route, hasProject])

  useEffect(() => {
    document.documentElement.style.setProperty('--ss-accent', t.accent)
    document.documentElement.style.setProperty('--ss-accent-ink', t.accentInk)
    document.documentElement.style.setProperty('--ss-ring', t.accent)
    document.documentElement.style.setProperty('--ss-placeholder', t.dimText)
    document.documentElement.style.setProperty('--ss-control-border', t.dim)
    document.documentElement.style.setProperty('--ss-control-bg', t.surface)
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.style.colorScheme = resolvedTheme
    document.body.style.background = t.bg
    document.body.style.color = t.text
  }, [resolvedTheme, t])

  // Apply density variables to the document. Let shared atoms read these values
  // through var(--ss-*) so each density preset recompresses every screen.
  useEffect(() => {
    const r = document.documentElement.style
    r.setProperty('--ss-gap', `${density.gap}px`)
    r.setProperty('--ss-section-gap', `${density.sectionGap}px`)
    r.setProperty('--ss-card-pad', `${density.cardPad}px`)
    r.setProperty('--ss-card-header', `${density.cardHeader}px`)
    r.setProperty('--ss-header-pad-y', `${density.headerPadY}px`)
    r.setProperty('--ss-body-pad-y', `${density.bodyPadY}px`)
    r.setProperty('--ss-row-min-h', `${density.rowMinH}px`)
    r.setProperty('--ss-input-h', `${density.inputH}px`)
    r.setProperty('--ss-divider-margin', `${density.dividerMargin}px`)
    r.setProperty('--ss-line-tight', `${density.lineTight}`)
    r.setProperty('--ss-bar-h', `${density.barH}px`)
    r.setProperty('--ss-dock-h', `${density.dockH}px`)
  }, [density])

  // Zoom the pixel-based UI for "Larger text", and force the reduced-motion CSS
  // freeze regardless of the operating-system preference.
  useEffect(() => {
    const zoom =
      tweaks.textScale === '135'
        ? '1.35'
        : tweaks.textScale === '115'
          ? '1.15'
          : '1'
    document.documentElement.style.setProperty('--ss-zoom', zoom)
    document.documentElement.setAttribute(
      'data-reduced-motion',
      String(tweaks.reducedMotion),
    )
  }, [tweaks.textScale, tweaks.reducedMotion])

  useEffect(() => {
    if (!projectRef) {
      let active = true
      void Promise.resolve().then(() => {
        if (active) setEnv(null)
      })
      return () => {
        active = false
      }
    }
    let active = true
    const captured = projectRef
    // Clear the previous report before starting the guarded request. Keep both
    // operations in one microtask chain to prevent project-epoch cleanup from
    // erasing a newer response after it commits.
    void Promise.resolve().then(() => {
      if (!active) return
      setEnv(null)
      void getApi()
        .env.check({ project: captured, cfg, configRevision })
        .then((report) => {
          if (active) setEnv(report)
        })
        .catch(() => {
          if (active) setEnv(null)
        })
    })
    return () => {
      active = false
    }
  }, [cfg, configRevision, projectRef])

  const blockers = useMemo(() => computeStageBlockers(env, cfg), [env, cfg])
  const analysisSubjects = useMemo(
    () => analysisEligibleSubjects(subjects),
    [subjects],
  )
  const cohortEmptyReason = emptyAnalysisCohortReason(subjects)
  const activeRunIds = useMemo(() => {
    const ids = new Set(runtime.activeRuns.map((run) => run.runId))
    for (const job of runtime.activeJobs) {
      if (job.runId) ids.add(job.runId)
    }
    return ids
  }, [runtime.activeRuns, runtime.activeJobs])
  // Offer Resume only for the newest run. An older failed run that a later
  // run superseded would keep the button armed while the Dashboard reports
  // no failures.
  const resumableRun = useMemo(() => {
    const newest = runtime.runs.reduce<RunSnapshot | null>(
      (best, run) =>
        best === null || (run.startedAt ?? 0) > (best.startedAt ?? 0)
          ? run
          : best,
      null,
    )
    return newest &&
      ['failed', 'interrupted', 'persistence-error'].includes(newest.status)
      ? newest
      : null
  }, [runtime.runs])
  // A failure that follows from the input itself, such as a source image
  // that truncates the brain, fails the same way on Resume, so the dock does
  // not offer Resume as the next step and says why.
  const resumeInputLimit = useMemo(() => {
    if (resumableRun === null) return null
    const failed = runtime.jobs.filter(
      (job) => job.runId === resumableRun.runId && job.status === 'failed',
    )
    if (
      failed.length === 0 ||
      !failed.every((job) => isInputLimitReason(job.terminalReason))
    ) {
      return null
    }
    const reasons = [
      ...new Set(failed.map((job) => job.terminalReason?.trim() ?? '')),
    ]
    const cause =
      reasons.length === 1
        ? restateRecordedReasons(reasons[0] ?? '')
        : `${failed.length} jobs failed on input limits.`
    return `Input limit: ${cause} Resume repeats the same check on the same input.`
  }, [resumableRun, runtime.jobs])

  // Confirm cohort-wide runs through the themed dialog before launching the
  // recon stage, and present the caveat consistently with the application chrome.
  const performWorkflow = useCallback(
    (
      includeDeferredAndUnreviewedQc: boolean,
      memoryAdvisoryAcknowledged: boolean,
    ) => {
      const acknowledgements = {
        includeDeferredAndUnreviewedQc,
        acknowledgeMemoryAdvisory: memoryAdvisoryAcknowledged,
      }
      // Only a live launch with Allow live runs on can start work after review.
      const label =
        !cfg.runtime.dryRun && safeExecution
          ? 'Planning and starting the workflow...'
          : 'Planning the workflow...'
      const planning = trackPlan({
        label,
        waitReason: WORKFLOW_PLAN_WAIT_REASON,
        card: null,
      })
      runExecutionAction(
        () => execution.runAll(acknowledgements, planning),
        'Retry starting the workflow.',
        setRunFailure,
        setRunNotice,
        setRunOutcome,
        planning,
      )
    },
    [
      cfg.runtime.dryRun,
      safeExecution,
      execution,
      setRunFailure,
      setRunNotice,
      setRunOutcome,
      trackPlan,
    ],
  )

  const qcRows = useMemo(
    () => qcScopeRows(analysisSubjects),
    [analysisSubjects],
  )
  const needsQcAcknowledgement = qcRows.defer + qcRows.unreviewed > 0

  const needsMemoryAcknowledgement =
    env?.availableMemoryGB !== null &&
    env?.availableMemoryGB !== undefined &&
    env.availableMemoryGB < cfg.runtime.memoryWarningGB
  const safeExecutionNotice = safeExecutionNoticeState(
    cfg.runtime.dryRun,
    safeExecution,
    dirty,
  )

  const runAll = useCallback(() => {
    // Refuse a second launch from the shortcuts or the palette while a plan
    // is pending; the dock already holds its own controls.
    if (pendingPlan) return
    // While the cohort loads the dock states the wait beside its held
    // controls; an empty-cohort notice would be false for a project whose
    // subjects are still loading, and any notice would outlive the load.
    if (!discoveryAnswered) return
    if (analysisSubjects.length === 0) {
      setRunFailure(null)
      setRunOutcome(null)
      setRunNotice(cohortEmptyReason)
      return
    }
    // The dock holds Run all while a live run is active; the shortcut and
    // the palette state that hold instead of confirming a start the sidecar
    // refuses. A dry run only plans and may start beside it.
    if (activeRunIds.size > 0 && !cfg.runtime.dryRun) {
      setRunFailure(null)
      setRunOutcome(null)
      setRunNotice(RUN_ACTIVE_TITLE)
      return
    }
    if (
      executionTarget.mode === 'explicit' &&
      executionTarget.subjectIds.length === 0
    ) {
      performWorkflow(false, false)
      return
    }
    setAcknowledgeQcScope(false)
    setAcknowledgeMemoryAdvisory(false)
    setConfirmCohortRun(true)
  }, [
    activeRunIds,
    analysisSubjects.length,
    cfg.runtime.dryRun,
    cohortEmptyReason,
    discoveryAnswered,
    executionTarget,
    performWorkflow,
    pendingPlan,
    setAcknowledgeMemoryAdvisory,
    setAcknowledgeQcScope,
    setConfirmCohortRun,
    setRunFailure,
    setRunNotice,
    setRunOutcome,
  ])

  const resumeFailed = useCallback(() => {
    if (pendingPlan) return
    if (!resumableRun) {
      setRunOutcome(null)
      setRunNotice('Select a durable failed or interrupted run to resume.')
      return
    }
    setRunNotice(null)
    const runId = resumableRun.runId
    const planning = trackPlan({
      label: 'Planning the resume...',
      waitReason: RESUME_PLAN_WAIT_REASON,
      card: null,
    })
    runExecutionAction(
      () => execution.resume(runId, undefined, planning),
      'Retry resuming the run.',
      setRunFailure,
      setRunNotice,
      setRunOutcome,
      planning,
    )
  }, [
    execution,
    resumableRun,
    pendingPlan,
    setRunFailure,
    setRunNotice,
    setRunOutcome,
    trackPlan,
  ])

  const cancelRunning = useCallback(() => {
    if (activeRunIds.size === 0) return
    setRunFailure(null)
    setRunOutcome(null)
    setRunNotice(null)
    void Promise.all([...activeRunIds].map((runId) => execution.cancel(runId)))
      .then(() => setRunNotice(CANCELLATION_REQUESTED_NOTICE))
      .catch((cause: unknown) =>
        setRunFailure(executionFailure(cause, 'Retry canceling active work.')),
      )
  }, [execution, activeRunIds, setRunFailure, setRunNotice, setRunOutcome])

  // Rebind before paint when the project epoch changes. Avoid handling the
  // operator's first shortcut with guarded setters from the previous epoch.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Handle Escape and Cmd/Ctrl+K even while editing.
      if (e.key === 'Escape') {
        setPaletteOpen(false)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      if (isEditableTarget(e.target)) return
      // Let a modal own the keyboard. Exempt a shortcut explicitly if one
      // ever needs to work behind a dialog.
      if (hasOpenDialog()) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === '/') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      // Before a project loads, allow only the project-free Diagnostics
      // route; ignore every other route and run shortcut.
      if (!stateRef.current.hasProject) {
        if (DIGIT_ROUTES[e.key] === 'diagnostics') setRoute('diagnostics')
        return
      }
      // Let QC and Runs own their local shortcuts, and prevent double dispatch.
      const onQc = stateRef.current.route === 'qc'
      const onRuns = stateRef.current.route === 'runs'
      if (!onRuns) {
        if (e.key === 'r') {
          runAll()
          return
        }
        if (e.key === 'R') {
          resumeFailed()
          return
        }
        if (e.key === 'c') {
          cancelRunning()
          return
        }
      }
      if (!onQc) {
        const target = DIGIT_ROUTES[e.key]
        if (target) {
          setRoute(target)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runAll, resumeFailed, cancelRunning, setPaletteOpen, setRoute])

  // Mark shell content inert while a modal is open to contain keyboard and
  // screen-reader navigation.
  useEffect(() => {
    const node = shellContentRef.current
    if (node) node.inert = paletteOpen || confirmCohortRun || firstRun
  }, [paletteOpen, confirmCohortRun, firstRun])

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: t.bg,
        color: t.text,
      }}
    >
      <FontActivationProbe />
      <div
        ref={shellContentRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <TopBar onOpenPalette={() => setPaletteOpen(true)} />
        <div
          style={{
            flexShrink: 0,
            height: 'var(--ss-bar-h)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            paddingLeft: 8,
            paddingRight: 8,
            background: t.surface,
            borderBottom: `1px solid ${t.border}`,
          }}
        >
          <ProjectToolbar
            onFailure={setProjectActionFailure}
            onAttempt={clearProjectActionFailure}
          />
          {/* Space, not a rule, separates the project actions from the tabs. */}
          {hasProject && (
            <span aria-hidden="true" style={{ width: 12, flexShrink: 0 }} />
          )}
          {hasProject && <TopNav />}
        </div>
        {shownProjectActionFailure && (
          <ProjectActionError
            t={t}
            failure={shownProjectActionFailure}
            onDismiss={clearProjectActionFailure}
          />
        )}

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <MainPane envReport={env} onEnvReport={setEnv} />
          {/* Runs owns its run controls, target, and Add subject. */}
          {hasProject &&
            route !== 'qc' &&
            route !== 'wizard' &&
            route !== 'runs' && (
              <RunDock
                blockers={blockers}
                runningJobIds={activeRunIds}
                canResume={resumableRun !== null}
                resumeInputLimit={resumeInputLimit}
                pendingReason={pendingPlan?.waitReason ?? null}
                onRunAll={runAll}
                onResumeFailed={resumeFailed}
                onCancel={cancelRunning}
                // These screens own the view's primary action.
                demoteRun={route === 'inputQc' || route === 'registry'}
              />
            )}
          {/* Runs shows the pending plan in its own banner. */}
          {pendingPlan && route !== 'runs' && (
            <div style={{ padding: '6px 14px 0' }}>
              <LoadingState t={t} label={pendingPlan.label} />
            </div>
          )}
          {runFailure && (
            <div style={{ padding: '6px 14px 0' }}>
              <ErrorState
                t={t}
                title={errorMessageText(runFailure.error.message)}
                detail={runFailure.error.message}
                // The detail is the raw message behind the readable title.
                mono
                {...(runFailure.reviewAgain
                  ? {
                      onRetry: runFailure.reviewAgain.run,
                      retryLabel: runFailure.reviewAgain.label,
                    }
                  : {})}
              />
            </div>
          )}
          {runNotice && (
            <div style={{ padding: '4px 14px' }}>
              <ExecutionOutcomeNotice
                t={t}
                message={runNotice}
                {...(runOutcome
                  ? {
                      blockers: runOutcome.plan.blockers,
                      nodes: runOutcome.plan.nodes,
                      onOpenRegistry: () => setRoute('registry'),
                    }
                  : {})}
                onDismiss={() => {
                  setRunNotice(null)
                  setRunOutcome(null)
                }}
              />
            </div>
          )}
        </div>
      </div>

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onRunAll={runAll}
          onResumeFailed={resumeFailed}
          onCancel={cancelRunning}
          activeCount={activeRunIds.size}
          canResume={resumableRun !== null}
        />
      )}

      {confirmCohortRun && (
        <ConfirmDialog
          t={t}
          title="Review the run plan?"
          message={
            <>
              {/* The same notice as the Runs confirmation, so the first live
                  launch after a relaunch can turn Allow live runs on from
                  either one. */}
              {safeExecutionNotice && (
                <SafeExecutionNotice
                  t={t}
                  state={safeExecutionNotice}
                  onTurnOn={() => setSafeExecution(true)}
                  onSave={() => saveProject()}
                />
              )}
              {/* One standing sentence; what Review plan does next is its
                  tooltip. */}
              <p style={{ margin: '0 0 10px' }}>
                {workflowScopeSentence(
                  cfg.steps,
                  executionTarget,
                  analysisSubjects.length,
                )}
              </p>
              {needsQcAcknowledgement && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minHeight: 24,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={acknowledgeQcScope}
                    onChange={(event) =>
                      setAcknowledgeQcScope(event.currentTarget.checked)
                    }
                  />
                  {QC_SCOPE_ACKNOWLEDGEMENT_LABEL}
                </label>
              )}
              {/* The same hints as the Runs confirmations, so a disabled
                  Review plan is explained in either one. */}
              {needsQcAcknowledgement && (
                <Hint t={t} style={{ marginTop: 4 }}>
                  {qcScopeAcknowledgementHint(qcRows)}
                </Hint>
              )}
              {needsMemoryAcknowledgement && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minHeight: 24,
                    marginTop: 10,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={acknowledgeMemoryAdvisory}
                    onChange={(event) =>
                      setAcknowledgeMemoryAdvisory(event.currentTarget.checked)
                    }
                  />
                  {memoryAcknowledgementLabel(
                    env?.availableMemoryGB ?? 0,
                    cfg.runtime.memoryWarningGB,
                  )}
                </label>
              )}
              {needsMemoryAcknowledgement && (
                <Hint t={t} style={{ marginTop: 4 }}>
                  {memoryAcknowledgementHint(cfg.runtime.memoryWarningGB)}
                </Hint>
              )}
            </>
          }
          onDismiss={() => setConfirmCohortRun(false)}
          actions={[
            {
              label: 'Cancel',
              onSelect: () => setConfirmCohortRun(false),
              initialFocus: true,
            },
            {
              label: REVIEW_PLAN_LABEL,
              tone: 'primary',
              disabled:
                (needsQcAcknowledgement && !acknowledgeQcScope) ||
                (needsMemoryAcknowledgement && !acknowledgeMemoryAdvisory),
              title:
                (needsQcAcknowledgement && !acknowledgeQcScope) ||
                (needsMemoryAcknowledgement && !acknowledgeMemoryAdvisory)
                  ? ACKNOWLEDGEMENT_NEEDED_TITLE
                  : reviewNextSentence(cfg.runtime.dryRun, safeExecution),
              onSelect: () => {
                setConfirmCohortRun(false)
                performWorkflow(acknowledgeQcScope, acknowledgeMemoryAdvisory)
              },
            },
          ]}
        />
      )}

      {firstRun && <FirstRunDialog />}
    </div>
  )
}

/** Render the root component. */
export default function App(): ReactNode {
  return (
    <AppProvider>
      <RuntimeProvider>
        <StageCurrencyProvider>
          <DurableMutationsProvider>
            <ProjectLifecycleProvider>
              <RecoveryReviewProvider>
                <WorkflowReviewProvider>
                  <Shell />
                </WorkflowReviewProvider>
              </RecoveryReviewProvider>
            </ProjectLifecycleProvider>
          </DurableMutationsProvider>
        </StageCurrencyProvider>
      </RuntimeProvider>
    </AppProvider>
  )
}
