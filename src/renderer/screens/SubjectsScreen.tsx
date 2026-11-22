import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Btn,
  CohortNotice,
  CohortWaitNotice,
  EmptyState as EmptyStateAtom,
  ErrorState as ErrorStateAtom,
  FONTS,
  Hint,
  Ico,
  ICONS,
  ICON_SIZE,
  IconButton,
  RefreshButton,
  SCROLL_HINT_GUTTER,
  ScrollEdgeHints,
  InfoTip,
  LoadingState as LoadingStateAtom,
  Page,
  Segments,
  stateLineStyle,
  StatusCell,
  ChipGlyph,
  StatusLegend,
  TextInput,
  cellStateLabel,
  formatAgeYears,
  formatRunTime,
  FreshnessStamp,
  FreshnessStampReserve,
  matrixCellStates,
  recentSubjectStepLabel,
  recentSubjectStepLabelLines,
  recentSubjectStepWidth,
  statusColor,
  statusSoft,
  subjectEdgeColor,
  useHiddenEdges,
  NoticeGlyph,
} from '../ui'
import type { Density, Theme } from '../ui'
import { useApp, type SubjectFilter } from '../state/context'
import { useRuntime } from '../state/runtime-state'
import {
  CURRENCY_BUCKETS,
  CURRENCY_CHECKING_FACT,
  describeSubjectBuckets,
  SUBJECT_BUCKET_LABEL,
  shownSubjectBuckets,
  tallySubjectBuckets,
  type SubjectBucketCounts,
} from '../state/subject-buckets'
import {
  applyStageCurrency,
  outdatedColumnReason,
  stageCurrencyNotice,
  useProjectStageCurrency,
} from '../state/stage-currency'
import { MatchingRuleFields } from './MatchingRuleFields'
import { SetSiteDialog } from './SetSiteDialog'
import {
  SITE_HELP,
  siteConfoundFacts,
  siteCountsText,
  siteHeldText,
  siteMixedText,
  summarizeSites,
  type SiteSummary,
} from '../state/site-facts'
import { patternError } from './matching-rules'
import { getApi } from '../state/api'
import { shownMatrixColumns, type MatrixColumn } from '../state/matrix-columns'
import {
  subjectUpdatedAt,
  type Cell,
  type CellState,
  type ChipStatus,
  type RunManifest,
  type Subject,
} from '../../shared/types'
import {
  ATTENTION_BUCKETS,
  cohortStageWait,
  skipDisabledStages,
  subjectAttention,
  subjectAuxiliaryDisplayStatus,
  subjectDisplayBucket,
  type SubjectAttentionBucket,
  type SubjectDisplayBucket,
} from '../state/subject-runtime-status'
import { cancelledRetryTarget, recoveryTarget } from '../state/recovery-target'
import {
  MATRIX_STEPS,
  pipelineStep,
  type MatrixStepKey,
} from '../../shared/steps'
import {
  AIS_HELP,
  COHORT_HELP,
  COHORT_LABEL,
  GLOSSARY,
  MATRIX_STEP_HELP,
  spelledOutStepName,
} from '../../shared/help'
import type { ProjectConfig } from '../../shared/project-schema'
import {
  analysisIneligibilityReason,
  isAnalysisEligible,
} from '../../shared/analysis-cohort'

/** Cohort, selection, filtering, and navigation state for Subjects. */
export interface SubjectsScreenProps {
  cfg?: ProjectConfig
  subjects?: Subject[]
  selection?: Set<string>
  onSelectionChange?: (next: Set<string>) => void
  activeSubjectId?: string | null
  onActiveSubjectChange?: (id: string) => void
  refresh?: () => void
}

const COL_CHECK = 28
const COL_SUBJECT = 90
const COL_AGESEX = 70
const COL_COHORT = 172
const COL_AIS = 50
// Shown only once some subject has a site, so a project without sites keeps a
// matrix without a Site column.
const COL_SITE = 96
const COL_UPDATED = 64
// The Notes column's floor: its longest tag that keeps its whole word, the
// Excluded dot and word, with the cell padding. Longer notes truncate.
const COL_NOTES_MIN = 72
// Width of the pinned selection and Subject columns, which keep every
// scrolled row's name in view.
const COL_PINNED = COL_CHECK + COL_SUBJECT
// Row width without the status columns: the fixed columns plus the 2 px row
// edge, so row backgrounds and the pinned columns span the whole scrolled
// width.
const MATRIX_FIXED_WIDTH =
  COL_PINNED +
  COL_AGESEX +
  COL_COHORT +
  COL_AIS +
  COL_NOTES_MIN +
  COL_UPDATED +
  2

/** The site filter values that are not labels (labels start alphanumeric). */
const SITE_FILTER_ALL = ' all'
const SITE_FILTER_NONE = ' none'

const SEARCH_W_COMPACT = 160
const SEARCH_W_ROOMY = 200
const COMPACT_ROW_H = 26

const CELL_POPOVER_WIDTH = 240
const CELL_POPOVER_GAP = 4
const CELL_POPOVER_VIEWPORT_MARGIN = 8

/**
 * Format an epoch-millisecond timestamp as a short relative-time string
 * (`now`, `5 min`, `3 h`, `2 d`). Return a dash when no time exists.
 */
function relativeTime(ms: number | null | undefined, now: number): string {
  // Treat a nonpositive timestamp as never run.
  if (ms == null || ms <= 0) return '-'
  const delta = Math.max(0, now - ms)
  const sec = Math.floor(delta / 1000)
  if (sec < 60) return 'now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} h`
  const day = Math.floor(hr / 24)
  return `${day} d`
}

/**
 * A 16 px selection box. Its label keeps the 24 px target, and the minimums
 * replace the 24 px floor the global checkbox style sets.
 */
const SMALL_CHECKBOX: CSSProperties = {
  width: 16,
  height: 16,
  minWidth: 16,
  minHeight: 16,
}

/** The tooltip on a discovered subject that carries no registry record. */
const UNREGISTERED_HELP =
  'No registry record holds the age, sex, and cohort of this subject yet. The Registry tab registers it.'

/**
 * The fact each matrix run state states in cell names, tooltips, and
 * popovers. Every state carries one, so a new state fails the type check
 * until it has a meaning.
 */
const CELL_STATE_MEANING: Record<CellState, string> = {
  done: 'This step finished successfully for this subject.',
  failed: 'This step failed for this subject; its log gives the reason.',
  running: 'This step is running now for this subject.',
  pending: 'This step has not run yet for this subject.',
  skipped:
    'This step is off in the project configuration, so it does not run for this subject.',
  planned: 'This step is planned for this subject in the current run.',
  waiting: 'This step is waiting on an earlier step for this subject.',
  queued: 'This step is queued to start for this subject.',
  cancelling: 'This step is being canceled for this subject.',
  cancelled: 'This step was canceled for this subject before it finished.',
  blocked: 'This step is blocked for this subject; Runs gives the reason.',
  withheld:
    'The run withheld this step for this subject after another job failed.',
  interrupted: 'This step was interrupted for this subject before it finished.',
  stale: 'The run state of this step is unknown for this subject.',
  outdated:
    "This step's output is out of date for this subject. Run all reruns it.",
}

function statusMeaning(st: CellState): string {
  return CELL_STATE_MEANING[st]
}

function auxiliaryStateLabel(state: CellState): string {
  return `${state.charAt(0).toUpperCase()}${state.slice(1)}`
}

/**
 * The tooltip of a status column header. It opens with the visible column
 * name, which is also the header's accessible name, and keeps the machine
 * step for the tooltip alone.
 */
function stepHeaderTooltip(key: MatrixStepKey, machineName: string): string {
  return `${recentSubjectStepLabel(key)}: ${MATRIX_STEP_HELP[key]}\nMachine step: ${machineName}`
}

function cellTooltip(
  key: MatrixStepKey,
  machineName: string,
  st: CellState,
  meaning: string,
  rerun?: Cell['rerun'],
): string {
  const rerunLine = rerun ? `\n${rerun.fact}.` : ''
  return `${MATRIX_STEP_HELP[key]}\nStatus ${cellStateLabel(st)}: ${meaning}${rerunLine}\nMachine step: ${machineName}`
}

/** Track whether a subject has a failed, interrupted, or canceled step. */
function needsAttention(s: Subject): boolean {
  return subjectAttention(s) !== null
}

const DISPLAY_BUCKET_RANK: Record<SubjectDisplayBucket, number> = {
  failed: 0,
  interrupted: 1,
  cancelled: 2,
  running: 3,
  partial: 4,
  pending: 5,
  outdated: 6,
  done: 7,
  excluded: 8,
}

/**
 * Render one row per subject and one {@link StatusCell} per matrix step. Add a
 * filter toolbar, a conditional failure banner, and a dense CSS-grid table so
 * an operator can spot failures across an 80x9 grid at a glance.
 *
 * Bootstrap missing data through {@link getApi}. Prefer shell-owned cohort and
 * selection state when supplied.
 */
export function SubjectsScreen(props: SubjectsScreenProps = {}): ReactNode {
  const { projectEpoch } = useApp()
  return <ProjectSubjects key={projectEpoch} {...props} />
}

function ProjectSubjects(props: SubjectsScreenProps): ReactNode {
  const app = useApp()
  const {
    t,
    density,
    tweaks,
    setRoute,
    subjectsFilter,
    setSubjectsFilter,
    projectRef,
    configRevision,
  } = app

  const cfg = props.cfg ?? app.cfg

  const [discovered, setDiscovered] = useState<Subject[] | null>(() =>
    projectRef ? null : [],
  )
  // Capture one reference time per discovery to keep relative labels stable and
  // render-pure.
  const [now, setNow] = useState(() => Date.now())
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Keep the filter in shared context so dashboard drill-downs arrive
  // prefiltered.
  const filter = subjectsFilter
  const [query, setQuery] = useState('')
  // Preserve the selected sort for Notice and Whisper. Prioritize failures in
  // Triage.
  type SubjectSort = 'state' | 'id' | 'updated'
  const [sortKey, setSortKey] = useState<SubjectSort>('id')
  const [dismissed, setDismissed] = useState(false)
  const [openCellKey, setOpenCellKey] = useState<string | null>(null)
  const [columnsHelpOpen, setColumnsHelpOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [localSelection, setLocalSelection] = useState<Set<string>>(
    () => new Set(),
  )
  const [siteFilter, setSiteFilter] = useState(SITE_FILTER_ALL)
  const [siteDialog, setSiteDialog] = useState<string[] | null>(null)

  const propsSubjects = props.subjects
  const propsCfg = props.cfg
  useEffect(() => {
    if (propsSubjects) return
    if (!projectRef) return
    let live = true
    getApi()
      .subjects.discover({
        project: projectRef,
        cfg: propsCfg ?? app.cfg,
        configRevision,
      })
      .then((rows) => {
        if (live) {
          setDiscovered(rows)
          setNow(Date.now())
          setLastUpdated(new Date().toISOString())
          setLoadError(null)
        }
      })
      .catch((err: unknown) => {
        if (live) {
          setLoadError(err instanceof Error ? err.message : String(err))
        }
      })
    return () => {
      live = false
    }
  }, [propsSubjects, propsCfg, projectRef, configRevision, app.cfg])

  // The shell supplies an empty list until its discovery answers; until then
  // the cohort is loading, not empty, so the matrix states the wait and no
  // count reads 0.
  const shellLoading =
    propsSubjects !== undefined && projectRef !== null && !app.discoveryAnswered
  const loaded = shellLoading ? null : (propsSubjects ?? discovered)
  const cohortLoading = loaded == null
  const runtime = useRuntime()
  const discoveredSubjects = useMemo(() => loaded ?? [], [loaded])
  // Mark the cells of stages Run all would repeat before counting, sorting,
  // filtering, and drawing, so Subjects agrees with the Dashboard and Runs.
  const currency = useProjectStageCurrency({
    project: projectRef,
    subjects: discoveredSubjects,
    runs: runtime.runs,
    enabled: loaded != null && !runtime.hydrating,
  })
  // A stage turned off in the configuration never runs: its cells read
  // skipped, so a subject whose enabled stages finished counts as Done.
  const enabledSubjects = useMemo(
    () => skipDisabledStages(discoveredSubjects, cfg),
    [discoveredSubjects, cfg],
  )
  const subjects = useMemo(
    () => applyStageCurrency(enabledSubjects, currency),
    [enabledSubjects, currency],
  )
  // Run manifests record cohort stages blocked at planning, which never
  // become jobs, so the cohort wait reads them as the Dashboard does.
  const [manifestReload, setManifestReload] = useState(0)
  const [manifestRead, setManifestRead] = useState<{
    key: number
    phase: 'ready' | 'error'
    items: RunManifest[]
  } | null>(() => (projectRef ? null : { key: 0, phase: 'ready', items: [] }))
  useEffect(() => {
    if (!projectRef) return undefined
    let live = true
    const key = manifestReload
    getApi()
      .manifest.list({ project: projectRef, limit: 20 })
      .then((page) => {
        if (live) setManifestRead({ key, phase: 'ready', items: page.items })
      })
      .catch(() => {
        if (live) setManifestRead({ key, phase: 'error', items: [] })
      })
    return () => {
      live = false
    }
  }, [projectRef, configRevision, manifestReload])
  const manifestsReady =
    manifestRead?.phase === 'ready' &&
    (!projectRef || manifestRead.key === manifestReload)
  // Name the cohort stage the subjects wait on, or a failed one: subject
  // buckets count only a subject's own stages, so without this a Run all
  // that failed at R analysis would leave no notice here, only red Report cells.
  const cohortWait = useMemo(
    () =>
      manifestsReady
        ? cohortStageWait(
            enabledSubjects,
            runtime.runs,
            runtime.jobs,
            manifestRead.items,
            cfg,
          )
        : null,
    [
      manifestsReady,
      enabledSubjects,
      runtime.runs,
      runtime.jobs,
      manifestRead,
      cfg,
    ],
  )
  const currencyNotice = useMemo(
    () => stageCurrencyNotice(discoveredSubjects, currency),
    [discoveredSubjects, currency],
  )
  const outdatedReasons = useMemo(
    () =>
      Object.fromEntries(
        MATRIX_STEPS.map((step) => [
          step.key,
          outdatedColumnReason(step.key, currency),
        ]),
      ) as Record<MatrixStepKey, string>,
    [currency],
  )
  const suppliedSelection = props.selection ?? localSelection
  const selection = useMemo(() => {
    const eligibleIds = new Set(
      subjects.filter(isAnalysisEligible).map((subject) => subject.id),
    )
    return new Set([...suppliedSelection].filter((id) => eligibleIds.has(id)))
  }, [subjects, suppliedSelection])

  // Prefer an explicit discovery time: this screen's own, or the shell's when
  // it supplies the subjects. The latest cohort activity is only a fallback
  // before any discovery answers; used after one, Re-discover would never
  // move the stamp.
  const discoveredAt = propsSubjects ? app.subjectsDiscoveredAt : lastUpdated
  const discovering = propsSubjects
    ? app.subjectsDiscovering
    : projectRef !== null && discovered === null && loadError === null
  const lastUpdatedDisplay = useMemo(() => {
    if (discoveredAt) return discoveredAt
    const latest = subjects.reduce(
      (max, s) => Math.max(max, subjectUpdatedAt(s)),
      0,
    )
    return latest > 0 ? new Date(latest).toISOString() : null
  }, [discoveredAt, subjects])

  function applySelection(next: Set<string>): void {
    if (props.onSelectionChange) props.onSelectionChange(next)
    else setLocalSelection(next)
  }

  // Count with the shared classifier, so each filter names and counts the
  // same set of subjects as the Dashboard tile and the top bar.
  const counts = useMemo<SubjectsFilterCounts>(
    () => ({ all: subjects.length, ...tallySubjectBuckets(subjects) }),
    [subjects],
  )

  const sorted = useMemo(() => {
    // Break every sort tie by ascending subject identifier.
    const byId = (a: Subject, b: Subject): number => a.id.localeCompare(b.id)
    const comparators: Record<SubjectSort, (a: Subject, b: Subject) => number> =
      {
        state: (a, b) => {
          const d =
            DISPLAY_BUCKET_RANK[subjectDisplayBucket(a)] -
            DISPLAY_BUCKET_RANK[subjectDisplayBucket(b)]
          return d !== 0 ? d : byId(a, b)
        },
        id: byId,
        updated: (a, b) => {
          const d = subjectUpdatedAt(b) - subjectUpdatedAt(a)
          return d !== 0 ? d : byId(a, b)
        },
      }
    return [...subjects].sort((a, b) => {
      if (tweaks.failureEmphasis === 'triage') {
        const failurePriority =
          Number(needsAttention(b)) - Number(needsAttention(a))
        if (failurePriority !== 0) return failurePriority
      }
      return comparators[sortKey](a, b)
    })
  }, [subjects, sortKey, tweaks.failureEmphasis])

  // Until the stage-currency read lands, a finished subject may still move
  // between Done and Out of date, so those two filters hold their rows
  // rather than list a subject or report none. Every other filter is final.
  const heldByCurrency =
    !currency.checked &&
    subjects.length > 0 &&
    filter !== 'all' &&
    CURRENCY_BUCKETS.has(filter)

  const siteSummary = useMemo(
    () =>
      summarizeSites(
        subjects
          .filter((subject) => subject.registered !== false)
          .map((subject) => ({
            id: subject.id,
            site: subject.site,
            role: subject.cohortRole,
          })),
      ),
    [subjects],
  )
  // Held sites stay out of the summary's counts, as planning leaves them out,
  // but the strip still states them.
  const heldSites = useMemo(
    () =>
      subjects.filter((subject) => subject.registered === false && subject.site)
        .length,
    [subjects],
  )
  const showSites = siteSummary.sites.length > 0 || heldSites > 0
  // A filter on a label that no subject holds any more shows every site.
  const activeSiteFilter =
    showSites &&
    (siteFilter === SITE_FILTER_NONE
      ? siteSummary.unset.length > 0
      : siteSummary.sites.some((count) => count.site === siteFilter))
      ? siteFilter
      : SITE_FILTER_ALL

  const visible = useMemo(() => {
    if (heldByCurrency) return []
    const q = query.trim().toLowerCase()
    return sorted.filter((s) => {
      if (q && !s.id.toLowerCase().includes(q)) return false
      if (
        activeSiteFilter !== SITE_FILTER_ALL &&
        (activeSiteFilter === SITE_FILTER_NONE
          ? Boolean(s.site) || s.registered === false
          : // A held site counts once its subject is registered, as the
            // summary does.
            s.registered === false || s.site !== activeSiteFilter)
      ) {
        return false
      }
      return filter === 'all' || subjectDisplayBucket(s) === filter
    })
  }, [sorted, query, filter, heldByCurrency, activeSiteFilter])

  const eligibleVisible = useMemo(
    () => visible.filter(isAnalysisEligible),
    [visible],
  )
  // List the run states the visible rows show beside the core legend states.
  const visibleStates = useMemo(() => matrixCellStates(visible), [visible])
  const allVisibleSelected =
    eligibleVisible.length > 0 &&
    eligibleVisible.every((subject) => selection.has(subject.id))

  function toggleOne(id: string): void {
    const subject = subjects.find((row) => row.id === id)
    if (!subject || !isAnalysisEligible(subject)) return
    const next = new Set(selection)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    applySelection(next)
  }

  function toggleAllVisible(): void {
    const next = new Set(selection)
    if (allVisibleSelected) {
      for (const subject of eligibleVisible) next.delete(subject.id)
    } else {
      for (const subject of eligibleVisible) next.add(subject.id)
    }
    applySelection(next)
  }

  function openInQc(id: string): void {
    props.onActiveSubjectChange?.(id)
    setRoute('qc')
  }

  function refreshAll(): void {
    currency.reload()
    setManifestReload((key) => key + 1)
    if (props.refresh) {
      props.refresh()
      return
    }
    setDiscovered(null)
    setLoadError(null)
    if (!projectRef) return
    getApi()
      .subjects.discover({ project: projectRef, cfg, configRevision })
      .then((rows) => {
        setDiscovered(rows)
        setNow(Date.now())
        setLastUpdated(new Date().toISOString())
      })
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : String(err)),
      )
  }

  // An optional stage's column shows only while the stage is on or holds a
  // result, such as BrainCharts.
  const columns = useMemo(
    () => shownMatrixColumns(cfg, subjects),
    [cfg, subjects],
  )
  const gridTemplate = useMemo(() => {
    // Give each status column at least the width of the shared wrapped
    // header, and spread them over the spare width.
    const stepCols = columns.map(
      ({ step }) => `minmax(${recentSubjectStepWidth(step.key)}px, 1fr)`,
    )
    return [
      `${COL_CHECK}px`,
      `${COL_SUBJECT}px`,
      `${COL_AGESEX}px`,
      `${COL_COHORT}px`,
      ...(showSites ? [`${COL_SITE}px`] : []),
      `${COL_AIS}px`,
      ...stepCols,
      // The note column keeps room for the Excluded tag, so the tag never
      // runs into Updated.
      `minmax(${COL_NOTES_MIN}px, 120px)`,
      `${COL_UPDATED}px`,
    ].join(' ')
  }, [showSites, columns])
  const matrixMinWidth =
    MATRIX_FIXED_WIDTH +
    columns.reduce(
      (sum, { step }) => sum + recentSubjectStepWidth(step.key),
      0,
    ) +
    (showSites ? COL_SITE : 0)

  const eligibleAttention = useMemo(
    () =>
      subjects.filter(
        (subject) => isAnalysisEligible(subject) && needsAttention(subject),
      ),
    [subjects],
  )
  // The filters count every subject, so a subject left out of the analysis
  // for another reason than QC Fail, with a failed step, is in Failed but
  // not in the banner, which counts what Resume and Runs act on. The banner
  // says so when the two differ. A QC Fail subject needs no attention and is
  // Excluded in the filters too, so it opens no such gap.
  const excludedAttentionCount = useMemo(
    () =>
      subjects.filter(
        (subject) => !isAnalysisEligible(subject) && needsAttention(subject),
      ).length,
    [subjects],
  )
  // Resume recovers only the newest run, and only while it failed, was
  // interrupted, or hit a persistence error; the run dock and Runs apply the
  // same rule, so the banner's action never offers what they refuse.
  const recovery = useMemo(
    () => recoveryTarget(runtime.runs, runtime.jobs),
    [runtime.runs, runtime.jobs],
  )
  // Runs' Retry canceled acts on this run; the banner names that path when
  // nothing resumes and a subject has a canceled step.
  const cancelledRetry = useMemo(
    () => cancelledRetryTarget(runtime.runs, runtime.jobs),
    [runtime.runs, runtime.jobs],
  )
  const showBanner =
    eligibleAttention.length > 0 &&
    tweaks.failureEmphasis !== 'whisper' &&
    !dismissed

  // The title row holds only page-wide actions, as on the Dashboard and Runs;
  // the controls that narrow and order the list share the filter row below.
  const right = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {/* The stamp appears once the cohort loads, which at 135% text would
          push the header onto a second row. Its slot holds the width of the
          widest stamp from the start, so the header keeps its rows. */}
      <span style={{ display: 'inline-grid', alignItems: 'center' }}>
        <FreshnessStampReserve />
        {lastUpdatedDisplay && (
          <span
            style={{ gridArea: '1 / 1', justifySelf: 'end', display: 'flex' }}
          >
            <FreshnessStamp
              t={t}
              at={lastUpdatedDisplay}
              title={`The cohort was last updated at ${formatRunTime(lastUpdatedDisplay)}.`}
            />
          </span>
        )}
      </span>
      <div style={{ position: 'relative' }}>
        <Btn
          t={t}
          ghost
          small
          label="Matching rules"
          icon={<Ico d={ICONS.filter} size={ICON_SIZE.nav} />}
          ariaLabel="Edit the subject and T1 matching rules"
          title="Edit the subject folder and T1 file name patterns"
          ariaPressed={rulesOpen}
          onClick={() => setRulesOpen((open) => !open)}
          disabled={!projectRef}
        />
        {rulesOpen && (
          <MatchingRulesEditor
            t={t}
            subjectGlob={cfg.patterns.subjectGlob}
            t1Pattern={cfg.patterns.t1Pattern}
            dirty={app.dirty}
            onSave={(patterns) => app.saveProject({ ...cfg, patterns })}
            onClose={() => setRulesOpen(false)}
          />
        )}
      </div>
      <RefreshButton
        t={t}
        ariaLabel="Re-discover the cohort"
        title="Re-discover the cohort"
        busy={discovering}
        busyLabel="Re-discovering the cohort..."
        onClick={refreshAll}
      />
    </div>
  )

  return (
    <Page t={t} title="Subjects" right={right}>
      {/* One toolbar runs edge to edge: state filters, a search box that
          takes the free width, and sort at the trailing edge. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 8,
        }}
      >
        <FilterBar
          t={t}
          filter={filter}
          counts={cohortLoading ? null : counts}
          checked={currency.checked}
          onChange={setSubjectsFilter}
        />
        <div
          style={{
            flex: '1 1 0',
            minWidth:
              density.row > COMPACT_ROW_H ? SEARCH_W_ROOMY : SEARCH_W_COMPACT,
          }}
        >
          <TextInput
            t={t}
            value={query}
            onChange={setQuery}
            placeholder="Filter subjects"
            ariaLabel="Filter subjects by ID"
          />
        </div>
        {/* The count shows only while a filter narrows the list. */}
        {!cohortLoading &&
          (heldByCurrency || visible.length !== subjects.length) && (
            <span
              style={stateLineStyle(t, { color: t.dim })}
              // A held filter has no count yet, as on the Dashboard tiles.
              {...(heldByCurrency ? { title: CURRENCY_CHECKING_FACT } : {})}
            >
              {`${heldByCurrency ? '--' : visible.length} of ${subjects.length}`}
            </span>
          )}
        <Segments
          t={t}
          small
          value={sortKey}
          ariaLabel="Sort"
          options={[
            { value: 'state', label: 'Worst first' },
            { value: 'id', label: 'Subject' },
            { value: 'updated', label: 'Updated' },
          ]}
          onChange={(v) => setSortKey(v as SubjectSort)}
        />
        <span
          // Announce this element's own text without a redundant live-region name.
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
          {cohortLoading
            ? ''
            : currency.checked
              ? `${describeSubjectBuckets(counts)} subjects.`
              : `${describeSubjectBuckets(counts, false)} subjects. ${CURRENCY_CHECKING_FACT}`}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusLegend t={t} states={visibleStates} />
          <div style={{ position: 'relative' }}>
            <IconButton
              t={t}
              d={ICONS.info}
              ariaLabel="Explain these columns"
              title="Review the workflow status columns."
              onClick={() => setColumnsHelpOpen((v) => !v)}
            />
            {columnsHelpOpen && (
              <ColumnsHelp
                t={t}
                columns={columns}
                onClose={() => setColumnsHelpOpen(false)}
              />
            )}
          </div>
        </div>
      </div>

      {/*
        The cohort wait keeps its own row, so the failure banner's action
        reads as acting on the failures alone.
      */}
      {!cohortLoading && cohortWait && (
        <div style={{ marginBottom: 12 }}>
          <CohortWaitNotice
            t={t}
            wait={cohortWait}
            onOpenRuns={() => setRoute('runs')}
          />
        </div>
      )}

      {currencyNotice && (
        <div style={{ marginBottom: 12 }}>
          <CohortNotice
            t={t}
            attention
            headline={currencyNotice.headline}
            detail={currencyNotice.detail}
            actionTitle="Open Runs to review and rerun the out-of-date stages."
            onOpenRuns={() => setRoute('runs')}
          />
        </div>
      )}

      {showBanner && (
        <FailureBanner
          t={t}
          counts={tallySubjectBuckets(eligibleAttention)}
          excludedCount={excludedAttentionCount}
          resumable={recovery.run !== null}
          retryCancelled={cancelledRetry.run !== null}
          onOpenRuns={() => setRoute('runs')}
          onResume={() => {
            // Select the subjects Resume continues: a canceled step waits
            // for Retry canceled instead.
            applySelection(
              new Set(
                eligibleAttention
                  .filter(
                    (subject) => subjectDisplayBucket(subject) !== 'cancelled',
                  )
                  .map((subject) => subject.id),
              ),
            )
            setRoute('runs')
          }}
          onDismiss={() => setDismissed(true)}
        />
      )}

      {showSites && loaded != null && (
        <SiteStrip
          t={t}
          summary={siteSummary}
          held={heldSites}
          filter={activeSiteFilter}
          onFilter={setSiteFilter}
          onSetSite={
            projectRef
              ? () => {
                  const chosen = [...selection]
                  setSiteDialog(
                    chosen.length > 0
                      ? chosen
                      : siteSummary.mode === 'mixed'
                        ? siteSummary.unset
                        : [],
                  )
                }
              : undefined
          }
        />
      )}
      {siteDialog && projectRef && (
        <SetSiteDialog
          t={t}
          project={projectRef}
          initialSelection={siteDialog}
          discovered={discoveredSubjects}
          onDismiss={() => setSiteDialog(null)}
          onDone={(result, subjectIds) => {
            setSiteDialog(null)
            if (result.updated === 0) return
            // Show the written site at once: the rediscovery below takes
            // many seconds on a large cohort, and until it answers the site
            // summary would keep the old counts. Without shell subjects the
            // screen rediscovers from an empty matrix instead.
            if (propsSubjects) {
              app.applySiteWrite(projectRef, subjectIds, result.site)
            }
            refreshAll()
          }}
        />
      )}

      {loadError != null ? (
        <ErrorStateAtom
          t={t}
          title="Could not discover subjects."
          detail={loadError}
          onRetry={refreshAll}
        />
      ) : loaded == null ? (
        <LoadingStateAtom t={t} label="Discovering subjects..." block />
      ) : heldByCurrency ? (
        // The bucket summary above already announces the checking fact.
        <LoadingStateAtom
          t={t}
          label={CURRENCY_CHECKING_FACT}
          block
          live={false}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          t={t}
          hasSubjects={subjects.length > 0}
          filter={filter}
          query={query}
          siteFiltered={activeSiteFilter !== SITE_FILTER_ALL}
          onShowAll={() => {
            setSubjectsFilter('all')
            setQuery('')
            setSiteFilter(SITE_FILTER_ALL)
          }}
        />
      ) : (
        <MatrixScroller t={t} rowCount={visible.length + 1}>
          <HeaderRow
            t={t}
            columns={columns}
            gridTemplate={gridTemplate}
            minWidth={matrixMinWidth}
            showSite={showSites}
            allSelected={allVisibleSelected}
            eligibleCount={eligibleVisible.length}
            onToggleAll={toggleAllVisible}
          />
          {visible.map((s, rowIdx) => (
            <SubjectRow
              key={s.id}
              t={t}
              density={density}
              subject={s}
              rowIndex={rowIdx}
              now={now}
              columns={columns}
              gridTemplate={gridTemplate}
              minWidth={matrixMinWidth}
              showSite={showSites}
              selected={isAnalysisEligible(s) && selection.has(s.id)}
              eligible={isAnalysisEligible(s)}
              ineligibilityReason={analysisIneligibilityReason(s)}
              outdatedReasons={outdatedReasons}
              openCellKey={openCellKey}
              onToggle={() => toggleOne(s.id)}
              onOpenQc={() => openInQc(s.id)}
              onSetOpenCell={setOpenCellKey}
            />
          ))}
        </MatrixScroller>
      )}
    </Page>
  )
}

interface MatrixScrollerProps {
  t: Theme
  /** Header row plus visible subject rows. */
  rowCount: number
  children: ReactNode
}

/**
 * Hold the subjects matrix in a horizontal scroll area that shows where
 * columns are hidden, beside the pinned Subject column and at the right
 * edge. Keep the edge state here so a scroll only re-renders this frame,
 * not every row.
 */
function MatrixScroller({
  t,
  rowCount,
  children,
}: MatrixScrollerProps): ReactNode {
  const [edges, scrollRef] = useHiddenEdges()
  return (
    // While columns are hidden to the right, reserve a gutter for the scroll
    // chevron, so it never covers the Notes column. The matrix keeps its full
    // width when it fits.
    <div
      style={{
        position: 'relative',
        maxWidth: '100%',
        paddingRight: edges.right ? SCROLL_HINT_GUTTER : 0,
      }}
    >
      <div
        ref={scrollRef}
        role="table"
        aria-label="Subjects matrix"
        aria-rowcount={rowCount}
        tabIndex={0}
        style={{
          border: `1px solid ${t.border}`,
          borderRadius: 8,
          maxWidth: '100%',
          overflow: 'auto',
          position: 'relative',
        }}
      >
        {children}
      </div>
      <ScrollEdgeHints
        t={t}
        edges={edges}
        ground={t.bg}
        pinnedWidth={COL_PINNED}
        inset={1}
        radius={7}
        gutter={SCROLL_HINT_GUTTER}
      />
    </div>
  )
}

/** The subject count behind each filter. */
type SubjectsFilterCounts = SubjectBucketCounts & { all: number }

interface FilterBarProps {
  t: Theme
  filter: SubjectFilter
  /** The bucket counts, or null while the cohort loads: no filter counts. */
  counts: SubjectsFilterCounts | null
  /**
   * Whether the stage-currency read has landed. Until then Done and Out of
   * date show no count, as on the Dashboard tiles.
   */
  checked: boolean
  onChange: (f: SubjectFilter) => void
}

function FilterBar(props: FilterBarProps): ReactNode {
  const { t, filter, counts, checked, onChange } = props
  const options = [
    { value: 'all', label: counts === null ? 'All' : `All ${counts.all}` },
    // Interrupted and Canceled show only while a subject is in them, or
    // while they are the selected filter.
    ...shownSubjectBuckets(counts, filter === 'all' ? undefined : filter).map(
      (bucket) => ({
        value: bucket,
        label:
          counts !== null && (checked || !CURRENCY_BUCKETS.has(bucket))
            ? `${SUBJECT_BUCKET_LABEL[bucket]} ${counts[bucket]}`
            : SUBJECT_BUCKET_LABEL[bucket],
      }),
    ),
  ]
  return (
    <Segments
      t={t}
      value={filter}
      options={options}
      small
      ariaLabel="Filter subjects by state"
      onChange={(v) => onChange(v as SubjectFilter)}
    />
  )
}

interface ColumnsHelpProps {
  t: Theme
  /** The status columns the matrix shows. */
  columns: readonly MatrixColumn[]
  onClose: () => void
}

interface MatchingRulesEditorProps {
  t: Theme
  subjectGlob: string
  t1Pattern: string
  /** Whether the configuration holds other unsaved changes. */
  dirty: boolean
  /** Save the project with the new patterns and reject with the reason. */
  onSave: (patterns: {
    subjectGlob: string
    t1Pattern: string
  }) => Promise<unknown>
  onClose: () => void
}

/**
 * Edit and save the matching patterns without reopening Setup.
 *
 * Save writes the whole current configuration, so the editor names any other
 * unsaved changes before the operator commits them together. A successful save
 * bumps the configuration revision, which triggers discovery again.
 */
function MatchingRulesEditor(props: MatchingRulesEditorProps): ReactNode {
  const { t, dirty, onSave, onClose } = props
  const ref = useRef<HTMLDivElement | null>(null)
  const [subjectGlob, setSubjectGlob] = useState(props.subjectGlob)
  const [t1Pattern, setT1Pattern] = useState(props.t1Pattern)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid =
    patternError(subjectGlob) === null && patternError(t1Pattern) === null
  const changed =
    subjectGlob !== props.subjectGlob || t1Pattern !== props.t1Pattern
  useEffect(() => {
    const previouslyFocused = document.activeElement
    const id = window.setTimeout(() => ref.current?.focus(), 0)
    return () => {
      window.clearTimeout(id)
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [])
  const save = async (): Promise<void> => {
    if (!valid || !changed || saving) return
    setSaving(true)
    setError(null)
    try {
      await onSave({ subjectGlob, t1Pattern })
      onClose()
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : 'Retry saving the patterns.',
      )
      setSaving(false)
    }
  }
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Edit the subject and T1 matching rules"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
      style={{
        position: 'absolute',
        top: 30,
        right: 0,
        zIndex: 20,
        width: 360,
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        padding: 12,
        boxShadow: t.shadow,
        outline: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <MatchingRuleFields
        t={t}
        subjectGlob={subjectGlob}
        onSubjectGlob={setSubjectGlob}
        t1Pattern={t1Pattern}
        onT1Pattern={setT1Pattern}
        validate
      />
      {dirty && (
        <Hint t={t}>
          Saving the patterns also saves the other unsaved configuration
          changes.
        </Hint>
      )}
      {error && (
        <span
          role="alert"
          style={{ fontFamily: FONTS.sans, fontSize: 11.5, color: t.failed }}
        >
          {error}
        </span>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Btn t={t} ghost small label="Cancel" onClick={onClose} />
        <Btn
          t={t}
          primary
          small
          label={saving ? 'Saving...' : 'Save and re-discover'}
          disabled={!valid || !changed || saving}
          onClick={() => void save()}
        />
      </div>
    </div>
  )
}

function ColumnsHelp(props: ColumnsHelpProps): ReactNode {
  const { t, columns, onClose } = props
  const ref = useRef<HTMLDivElement | null>(null)
  // Move focus into this nonmodal APG dialog and restore it on close. Let Tab
  // leave the popover, and close it on Escape.
  useEffect(() => {
    const previouslyFocused = document.activeElement
    const id = window.setTimeout(() => ref.current?.focus(), 0)
    return () => {
      window.clearTimeout(id)
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [])
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Workflow status columns"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
      style={{
        position: 'absolute',
        top: 30,
        right: 0,
        zIndex: 20,
        width: 340,
        maxHeight: 420,
        overflowY: 'auto',
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        padding: 12,
        boxShadow: t.shadow,
        outline: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: t.text }}>
          The {columns.length} status columns are workflow milestones.
        </span>
        <IconButton
          t={t}
          d={ICONS.x}
          ariaLabel="Close columns help"
          title="Close"
          size={24}
          iconSize={ICON_SIZE.inline}
          onClick={onClose}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {columns.map(({ step }) => (
          <div key={step.key}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 6,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 11.5, fontWeight: 700, color: t.text }}>
                {step.label}
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: t.dim,
                  fontFamily: FONTS.mono,
                }}
              >
                {step.long}
              </span>
            </div>
            <Hint t={t} style={{ marginTop: 2 }}>
              {MATRIX_STEP_HELP[step.key]}
            </Hint>
          </div>
        ))}
      </div>
    </div>
  )
}

interface FailureBannerProps {
  t: Theme
  /** The bucket counts of the subjects with a step that did not finish. */
  counts: SubjectBucketCounts
  /**
   * How many subjects excluded from analysis also have such a step. The
   * filters count them and the banner does not.
   */
  excludedCount: number
  /** Whether Resume applies to the newest run, as on Runs and the dock. */
  resumable: boolean
  /** Whether a canceled run waits for Retry canceled on Runs. */
  retryCancelled: boolean
  onResume: () => void
  onOpenRuns: () => void
  onDismiss: () => void
}

/** The banner's words for a step in each attention bucket. */
const ATTENTION_STEP: Record<SubjectAttentionBucket, string> = {
  failed: 'a failed step',
  interrupted: 'an interrupted step',
  cancelled: 'a canceled step',
}

/**
 * State how many subjects have a step that did not finish, by state: a
 * failed, an interrupted, or a canceled step, or several kinds at once.
 */
function failureBannerText(
  counts: SubjectBucketCounts,
  included = false,
): {
  count: number
  text: string
} {
  const present = ATTENTION_BUCKETS.filter((bucket) => counts[bucket] > 0)
  const count = present.reduce((sum, bucket) => sum + counts[bucket], 0)
  const noun = included ? 'included subject' : 'subject'
  const have = count === 1 ? `${noun} has` : `${noun}s have`
  const only = present.length === 1 ? present[0] : undefined
  if (only) return { count, text: `${have} ${ATTENTION_STEP[only]}.` }
  const parts = present.map(
    (bucket) =>
      `${counts[bucket]} ${SUBJECT_BUCKET_LABEL[bucket].toLowerCase()}`,
  )
  const listed =
    parts.length <= 2
      ? parts.join(' and ')
      : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
  return { count, text: `${have} a step that did not finish: ${listed}.` }
}

/**
 * Count the subjects with a step that did not finish and offer the path that
 * applies. Resume appears only while the newest run can be resumed; otherwise
 * the banner opens Runs, which retries a canceled run or reruns the rest.
 */
function FailureBanner(props: FailureBannerProps): ReactNode {
  const {
    t,
    counts,
    excludedCount,
    resumable,
    retryCancelled,
    onResume,
    onOpenRuns,
    onDismiss,
  } = props
  // Name the population only while it differs from the filter counts.
  const { count, text } = failureBannerText(counts, excludedCount > 0)
  const excludedFact =
    excludedCount === 0
      ? undefined
      : `${excludedCount} ${excludedCount === 1 ? 'subject' : 'subjects'} excluded from analysis also ${excludedCount === 1 ? 'has' : 'have'} a step that did not finish. The filters count every subject.`
  const retryOnRuns = retryCancelled && counts.cancelled > 0
  // A failure keeps the failure tone; interrupted or canceled work alone
  // did not fail, so the banner takes that state's tone instead.
  const tone: ChipStatus =
    counts.failed > 0
      ? 'failed'
      : counts.interrupted > 0
        ? 'interrupted'
        : 'cancelled'
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        minHeight: 44,
        boxSizing: 'border-box',
        padding: '6px 12px',
        marginBottom: 12,
        background: statusSoft(t, tone),
        borderRadius: 8,
        borderLeft: `2px solid ${statusColor(t, tone)}`,
      }}
    >
      <NoticeGlyph t={t} tone={tone} />
      <span
        title={excludedFact}
        style={{ fontFamily: FONTS.sans, fontSize: 13, color: t.text, flex: 1 }}
      >
        <strong>{count}</strong> {text}
      </span>
      {resumable ? (
        <Btn
          t={t}
          label="Resume failed work"
          icon={<Ico d={ICONS.resume} size={ICON_SIZE.nav} />}
          primary
          small
          onClick={onResume}
        />
      ) : (
        // Name the action taken on Runs: the out-of-date notice above keeps
        // "Open Runs", and two buttons of one name read as the same action.
        <Btn
          t={t}
          label={retryOnRuns ? 'Retry in Runs' : 'Rerun in Runs'}
          small
          title={
            retryOnRuns
              ? 'Open Runs to retry the canceled run.'
              : 'Open Runs to rerun the steps that did not finish.'
          }
          onClick={onOpenRuns}
        />
      )}
      <Btn t={t} label="Dismiss" ghost small onClick={onDismiss} />
    </div>
  )
}

interface HeaderRowProps {
  t: Theme
  /** The status columns shown, each with its cell index. */
  columns: readonly MatrixColumn[]
  gridTemplate: string
  /** The row width: the fixed columns plus the row edge. */
  minWidth: number
  /** Whether the Site column shows. */
  showSite: boolean
  allSelected: boolean
  eligibleCount: number
  onToggleAll: () => void
}

function HeaderRow(props: HeaderRowProps): ReactNode {
  const {
    t,
    columns,
    gridTemplate,
    minWidth,
    showSite,
    allSelected,
    eligibleCount,
    onToggleAll,
  } = props
  const head: CSSProperties = {
    fontSize: 10,
    letterSpacing: 0.2,
    color: t.dim,
    fontFamily: FONTS.sans,
    display: 'flex',
    alignItems: 'center',
    padding: '6px 4px',
  }
  // Keep pinned headings opaque and full height over scrolled columns.
  const pinned: CSSProperties = {
    position: 'sticky',
    zIndex: 1,
    alignSelf: 'stretch',
    background: t.surface2,
  }
  // Wrap dense status headings within their shared dashboard column widths.
  const stepHead: CSSProperties = {
    fontSize: 9.5,
    fontWeight: 700,
    color: t.dim,
    fontFamily: FONTS.sans,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    lineHeight: 1.05,
    padding: '6px 2px',
  }
  return (
    <div
      role="row"
      style={{
        display: 'grid',
        gridTemplateColumns: gridTemplate,
        alignItems: 'center',
        position: 'sticky',
        top: 0,
        zIndex: 2,
        minWidth,
        background: t.surface2,
        borderBottom: `1px solid ${t.border}`,
      }}
    >
      <div
        role="columnheader"
        style={{
          ...head,
          ...pinned,
          left: 0,
          justifyContent: 'center',
        }}
      >
        <label
          title={
            eligibleCount === 0
              ? 'Resolve subject eligibility before selecting all visible subjects.'
              : 'Select all visible subjects that are eligible for analysis.'
          }
          style={{
            width: 24,
            minWidth: 24,
            height: 24,
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center',
            cursor: eligibleCount === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={allSelected}
            disabled={eligibleCount === 0}
            onChange={onToggleAll}
            aria-label={
              eligibleCount === 0
                ? 'Resolve eligibility before selecting visible subjects.'
                : 'Select all visible eligible subjects.'
            }
            title={
              eligibleCount === 0
                ? 'Resolve subject eligibility before selecting all visible subjects.'
                : 'Select all visible subjects that are eligible for analysis.'
            }
            style={{
              ...SMALL_CHECKBOX,
              cursor: eligibleCount === 0 ? 'not-allowed' : 'pointer',
            }}
          />
        </label>
      </div>
      <div role="columnheader" style={{ ...head, ...pinned, left: COL_CHECK }}>
        Subject
      </div>
      <div role="columnheader" style={head}>
        Age and sex
      </div>
      {/* Name the identity headers by their visible label: the closed InfoTip
          stays in the accessibility tree, so the computed name would read the
          whole tip. The tip's button stays reachable inside the header. */}
      <div role="columnheader" aria-label="Cohort" style={{ ...head, gap: 3 }}>
        Cohort
        <InfoTip
          t={t}
          label="About cohort"
          text="Cohort is the configured study group. The analysis recognizes control for the control cohort, shown here as the registry code CTRL, plus SCI_nNP for spinal cord injury without pain and SCI_P for spinal cord injury with pain."
        />
      </div>
      {showSite && (
        <div role="columnheader" aria-label="Site" style={{ ...head, gap: 3 }}>
          Site
          <InfoTip t={t} label="About site" text={SITE_HELP} />
        </div>
      )}
      <div role="columnheader" aria-label="AIS" style={{ ...head, gap: 3 }}>
        AIS
        <InfoTip
          t={t}
          label="About AIS"
          text={`${GLOSSARY.AIS} A blank value means the source metadata provides no grade.`}
        />
      </div>
      {columns.map(({ step }) => (
        <div
          role="columnheader"
          key={step.key}
          title={stepHeaderTooltip(step.key, step.long)}
          // Name the header by its visible lines, which the flex column would
          // otherwise run together; the tooltip is its description.
          aria-label={recentSubjectStepLabel(step.key)}
          style={stepHead}
        >
          {recentSubjectStepLabelLines(step.key).map((line) => (
            <span key={line} style={{ whiteSpace: 'nowrap' }}>
              {line}
            </span>
          ))}
        </div>
      ))}
      {/* The column holds the Excluded tag, auxiliary step status, and
          integrity warnings. It may shrink to nothing, so the name clips. */}
      <div
        role="columnheader"
        aria-label="Notes"
        style={{ ...head, minWidth: 0, overflow: 'hidden' }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          Notes
        </span>
      </div>
      <div role="columnheader" style={{ ...head, justifyContent: 'flex-end' }}>
        Updated
      </div>
    </div>
  )
}

interface SubjectRowProps {
  t: Theme
  density: Density
  subject: Subject
  rowIndex: number
  now: number
  /** The status columns shown, each with its cell index. */
  columns: readonly MatrixColumn[]
  gridTemplate: string
  /** The row width: the fixed columns plus the row edge. */
  minWidth: number
  /** Whether the Site column shows. */
  showSite: boolean
  selected: boolean
  eligible: boolean
  ineligibilityReason: string
  /** Why each column's out-of-date cells are out of date. */
  outdatedReasons: Readonly<Record<MatrixStepKey, string>>
  openCellKey: string | null
  onToggle: () => void
  onOpenQc: () => void
  onSetOpenCell: (key: string | null) => void
}

/**
 * Keep the row noninteractive and expose one focusable subject-name button for
 * opening QC. Reveal hover and focus with a lifted background and chevron.
 * Preserve double-click anywhere on the row for pointer users.
 */
function SubjectRow(props: SubjectRowProps): ReactNode {
  const {
    t,
    density,
    subject: s,
    rowIndex,
    now,
    columns,
    gridTemplate,
    minWidth,
    showSite,
    selected,
    eligible,
    ineligibilityReason,
    outdatedReasons,
    openCellKey,
    onToggle,
    onOpenQc,
    onSetOpenCell,
  } = props
  const [hovered, setHovered] = useState(false)
  // A subject discovered on disk but absent from the registry has no recorded
  // age, sex, or cohort, so name that state instead of printing placeholders.
  const registered = s.registered !== false
  const edge = subjectEdgeColor(t, s)
  const auxiliaryStatus = subjectAuxiliaryDisplayStatus(s)
  const auxiliaryStep = auxiliaryStatus
    ? pipelineStep(auxiliaryStatus.stepKey)
    : null
  const zebra = rowIndex % 2 === 1 ? t.surface2 : 'transparent'
  const integrityDetail = [
    ...(!eligible ? [ineligibilityReason] : []),
    ...(s.integrityErrors ?? []),
  ].join(' ')
  // Let selection override the hover and focus surface.
  const bg = selected ? t.accentSoft : hovered ? t.surface2 : zebra
  const cellStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    fontFamily: FONTS.mono,
    fontSize: density.font,
    color: t.text,
    padding: '0 4px',
    minWidth: 0,
  }
  // Paint pinned cells with the solid color the row shows over the page
  // ground so they stay opaque above the columns scrolled beneath them.
  // Row surface tokens are opaque, so a transparent row shows the ground.
  // Keep it a plain color: contrast checkers cannot measure text over a
  // background image.
  const pinned: CSSProperties = {
    position: 'sticky',
    zIndex: 1,
    alignSelf: 'stretch',
    backgroundColor: bg === 'transparent' ? t.bg : bg,
  }
  return (
    <div
      role="row"
      onDoubleClick={onOpenQc}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: gridTemplate,
        alignItems: 'center',
        height: density.row,
        minWidth,
        background: bg,
        borderBottom: `1px solid ${t.borderSoft}`,
        // Every row reserves the state edge, so checkboxes and text share
        // one left edge whether or not the row draws it.
        borderLeft: `2px solid ${edge}`,
        marginLeft: -2,
        cursor: 'pointer',
      }}
    >
      <div
        role="cell"
        style={{
          ...cellStyle,
          ...pinned,
          left: 0,
          justifyContent: 'center',
          padding: 0,
        }}
      >
        <label
          title={eligible ? `Select ${s.id}` : ineligibilityReason}
          style={{
            width: 24,
            minWidth: 24,
            height: 24,
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center',
            cursor: eligible ? 'pointer' : 'not-allowed',
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            disabled={!eligible}
            onChange={onToggle}
            onClick={(e) => e.stopPropagation()}
            aria-label={
              eligible
                ? `Select ${s.id}`
                : `Select ${s.id}. ${ineligibilityReason}`
            }
            style={{
              ...SMALL_CHECKBOX,
              cursor: eligible ? 'pointer' : 'not-allowed',
            }}
          />
        </label>
      </div>
      <div
        role="rowheader"
        style={{ ...cellStyle, ...pinned, left: COL_CHECK, padding: 0 }}
      >
        <button
          type="button"
          aria-label={`Open ${s.id} in QC review`}
          onClick={(e) => {
            e.stopPropagation()
            onOpenQc()
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            onOpenQc()
          }}
          title={`Open ${s.id} in QC review`}
          style={{
            ...cellStyle,
            width: '100%',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            minHeight: 24,
            overflow: 'hidden',
            color: t.text,
          }}
        >
          <span
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {s.id}
          </span>
        </button>
      </div>
      <div role="cell" style={cellStyle}>
        {registered ? (
          <>
            {formatAgeYears(s.age)} / {s.sex}
          </>
        ) : (
          '-'
        )}
      </div>
      <div
        role="cell"
        data-cohort={registered ? (s.cohort ?? '') : ''}
        style={{ ...cellStyle, fontFamily: FONTS.sans }}
        title={
          registered
            ? s.cohort && COHORT_HELP[s.cohort]
              ? `${s.cohort}: ${COHORT_HELP[s.cohort]}`
              : `Cohort: ${s.cohort || 'unknown'}`
            : UNREGISTERED_HELP
        }
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {registered
            ? (s.cohort && COHORT_LABEL[s.cohort]) || s.cohort
            : 'Not registered'}
        </span>
      </div>
      {showSite && (
        <div
          role="cell"
          data-site={s.site ?? ''}
          style={{
            ...cellStyle,
            ...(s.site ? {} : { color: t.dimText }),
          }}
          title={
            registered
              ? s.site
                ? `Site: ${s.site}`
                : 'No site is set for this subject.'
              : s.site
                ? `Site: ${s.site}, held until the subject is registered.`
                : UNREGISTERED_HELP
          }
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {s.site ? s.site : '-'}
          </span>
        </div>
      )}
      <div
        role="cell"
        style={{ ...cellStyle, justifyContent: 'center' }}
        title={
          s.ais && AIS_HELP[s.ais]
            ? AIS_HELP[s.ais]
            : 'No AIS grade: the source metadata provides none.'
        }
      >
        {s.ais ?? '-'}
      </div>
      {columns.map(({ step, index }) => {
        const cell: Cell | undefined = s.cells[index]
        const key = `${s.id}:${step.key}`
        return (
          <div
            role="cell"
            key={step.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
            }}
          >
            {cell ? (
              <CellButton
                t={t}
                density={density}
                cell={cell}
                meaning={
                  cell.st === 'outdated'
                    ? outdatedReasons[step.key]
                    : statusMeaning(cell.st)
                }
                stepKey={step.key}
                stepName={recentSubjectStepLabel(step.key)}
                stepLabel={step.long}
                subjectId={s.id}
                open={openCellKey === key}
                onOpen={() => onSetOpenCell(openCellKey === key ? null : key)}
                onClose={() => onSetOpenCell(null)}
              />
            ) : (
              <span style={{ color: t.dimText }}>-</span>
            )}
          </div>
        )
      })}
      <div
        role="cell"
        style={{
          display: 'flex',
          alignItems: 'center',
          // The note sits beside the last status column.
          justifyContent: 'flex-start',
          gap: 4,
          minWidth: 0,
          padding: '0 4px',
        }}
      >
        {auxiliaryStatus && auxiliaryStep && (
          <span
            // Keep the full visible text as the accessible name despite visual
            // truncation.
            title={`${spelledOutStepName(auxiliaryStep.key)}: ${auxiliaryStateLabel(auxiliaryStatus.state)}`}
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: statusColor(t, auxiliaryStatus.state),
              fontSize: 10,
              fontWeight: 700,
              fontFamily: FONTS.sans,
            }}
          >
            {auxiliaryStep.name}: {auxiliaryStateLabel(auxiliaryStatus.state)}
          </span>
        )}
        {!eligible && (
          // A short tag keeps the row quiet; the tooltip states the reason.
          <span
            title={integrityDetail}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              flexShrink: 0,
              whiteSpace: 'nowrap',
              color: t.dim,
              fontSize: 11,
              fontFamily: FONTS.sans,
            }}
          >
            <ChipGlyph t={t} status="exclude" />
            Excluded
          </span>
        )}
        {eligible && integrityDetail && (
          <span
            title={integrityDetail}
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: t.warning,
              fontSize: 10,
              fontFamily: FONTS.sans,
            }}
          >
            {integrityDetail}
          </span>
        )}
        <span aria-hidden>
          <Ico
            d={ICONS.chevron}
            stroke={t.dim}
            style={{
              opacity: selected || hovered ? 1 : 0,
              transition: 'opacity .12s',
            }}
          />
        </span>
      </div>
      <div
        role="cell"
        style={{
          ...cellStyle,
          justifyContent: 'flex-end',
          color: t.dim,
          fontFamily: FONTS.sans,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: 0,
        }}
      >
        {relativeTime(subjectUpdatedAt(s), now)}
      </div>
    </div>
  )
}

interface CellButtonProps {
  t: Theme
  density: Density
  cell: Cell
  /** The fact the cell's state states, such as why it is out of date. */
  meaning: string
  stepKey: MatrixStepKey
  /** The visible column name, which names the cell and its actions. */
  stepName: string
  /** The machine step, shown only in the tooltip and the actions. */
  stepLabel: string
  subjectId: string
  open: boolean
  onOpen: () => void
  onClose: () => void
}

/**
 * Wrap each {@link StatusCell} in a button with a 24px minimum target. Keep the
 * status glyph unpadded and legible at compact density.
 */
function CellButton(props: CellButtonProps): ReactNode {
  const {
    t,
    density,
    cell,
    meaning,
    stepKey,
    stepName,
    stepLabel,
    subjectId,
    open,
    onOpen,
    onClose,
  } = props
  const { projectRef, refreshSubject } = useApp()
  const stateLabel = cellStateLabel(cell.st)
  const triggerSize = Math.max(24, density.cell)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const popoverId = `subject-status-actions-${generatedId}`

  function closeAndRestoreFocus(): void {
    onClose()
    triggerRef.current?.focus()
  }

  /**
   * Open the log at subject scope because this matrix uses
   * {@link MatrixStepKey}, not pipeline `StepKey`.
   */
  function viewLog(): void {
    if (projectRef) {
      void getApi().subjects.openLog({ project: projectRef, subjectId })
    }
    closeAndRestoreFocus()
  }

  function openFolder(): void {
    if (projectRef) {
      void getApi().subjects.openFolder({ project: projectRef, subjectId })
    }
    closeAndRestoreFocus()
  }

  function recheckSubject(): void {
    void refreshSubject(subjectId).catch(() => undefined)
    closeAndRestoreFocus()
  }

  // Dismiss this lightweight button group on outside pointer or focus activity
  // and on document-level Escape. Do not expose it as an APG menu.
  useEffect(() => {
    if (!open) return
    function isInsideCell(target: Node): boolean {
      return Boolean(
        popoverRef.current?.contains(target) ||
        triggerRef.current?.contains(target),
      )
    }
    function onDocMouseDown(e: MouseEvent): void {
      const target = e.target as Node
      if (!isInsideCell(target)) onClose()
    }
    function onDocFocusIn(e: FocusEvent): void {
      const target = e.target as Node
      if (!isInsideCell(target)) onClose()
    }
    function onDocKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('focusin', onDocFocusIn)
    document.addEventListener('keydown', onDocKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('focusin', onDocFocusIn)
      document.removeEventListener('keydown', onDocKeyDown, true)
    }
  }, [open, onClose])

  // Use viewport-relative positioning so the horizontally scrolling table does
  // not clip late-column popovers. Flip above bottom rows and clamp both axes to
  // a small viewport margin. Recalculate as the window or table scrolls.
  useLayoutEffect(() => {
    if (!open) return
    function positionPopover(): void {
      const trigger = triggerRef.current
      const popover = popoverRef.current
      if (!trigger || !popover) return
      const triggerRect = trigger.getBoundingClientRect()
      const popoverRect = popover.getBoundingClientRect()
      const popoverWidth = popoverRect.width || CELL_POPOVER_WIDTH
      const popoverHeight = popoverRect.height
      const maxLeft = Math.max(
        CELL_POPOVER_VIEWPORT_MARGIN,
        window.innerWidth - popoverWidth - CELL_POPOVER_VIEWPORT_MARGIN,
      )
      const left = Math.min(
        Math.max(triggerRect.left, CELL_POPOVER_VIEWPORT_MARGIN),
        maxLeft,
      )
      const below = triggerRect.bottom + CELL_POPOVER_GAP
      const above = triggerRect.top - CELL_POPOVER_GAP - popoverHeight
      const maxTop = Math.max(
        CELL_POPOVER_VIEWPORT_MARGIN,
        window.innerHeight - popoverHeight - CELL_POPOVER_VIEWPORT_MARGIN,
      )
      const top =
        below + popoverHeight >
          window.innerHeight - CELL_POPOVER_VIEWPORT_MARGIN &&
        above >= CELL_POPOVER_VIEWPORT_MARGIN
          ? above
          : Math.min(Math.max(below, CELL_POPOVER_VIEWPORT_MARGIN), maxTop)

      popover.style.left = `${left}px`
      popover.style.top = `${top}px`
      popover.style.visibility = 'visible'
    }

    positionPopover()
    window.addEventListener('resize', positionPopover)
    window.addEventListener('scroll', positionPopover, true)
    return () => {
      window.removeEventListener('resize', positionPopover)
      window.removeEventListener('scroll', positionPopover, true)
    }
  }, [open])

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={`${stepName} for ${subjectId}: ${stateLabel}, ${meaning}${
          cell.rerun ? ` ${cell.rerun.fact}.` : ''
        }`}
        title={cellTooltip(stepKey, stepLabel, cell.st, meaning, cell.rerun)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: triggerSize,
          height: triggerSize,
          background: 'transparent',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        {/* The glyph takes no pointer, so hovering it shows the button's
            tooltip with the machine step rather than the glyph's own title. */}
        <span style={{ display: 'contents', pointerEvents: 'none' }}>
          <StatusCell
            cell={cell}
            density={density}
            t={t}
            stepLabel={stepName}
          />
        </span>
      </button>
      {open && (
        <div
          id={popoverId}
          ref={popoverRef}
          role="group"
          aria-label={`${stepName} actions for ${subjectId}`}
          style={{
            position: 'fixed',
            top: CELL_POPOVER_VIEWPORT_MARGIN,
            left: CELL_POPOVER_VIEWPORT_MARGIN,
            zIndex: 30,
            width: CELL_POPOVER_WIDTH,
            maxWidth: `calc(100vw - ${CELL_POPOVER_VIEWPORT_MARGIN * 2}px)`,
            maxHeight: `calc(100vh - ${CELL_POPOVER_VIEWPORT_MARGIN * 2}px)`,
            boxSizing: 'border-box',
            overflowY: 'auto',
            visibility: 'hidden',
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: 8,
            padding: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            boxShadow: t.shadow,
          }}
        >
          <div style={{ padding: '2px 4px 4px' }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: t.text,
                fontFamily: FONTS.sans,
              }}
            >
              {stepName}
            </div>
            <div
              style={{
                fontSize: 10,
                color: t.dim,
                fontFamily: FONTS.mono,
                marginTop: 1,
              }}
            >
              {stepLabel}
            </div>
            <Hint t={t} style={{ marginTop: 4 }}>
              {MATRIX_STEP_HELP[stepKey]}
            </Hint>
            <Hint t={t} style={{ marginTop: 4 }}>
              Status <strong>{stateLabel}</strong>: {meaning}
              {cell.st === 'failed'
                ? ' View log below shows the failure reason.'
                : ''}
            </Hint>
            {cell.rerun && (
              <Hint t={t} style={{ marginTop: 4 }}>
                <strong>{cell.rerun.fact}.</strong> {cell.rerun.detail}
              </Hint>
            )}
          </div>
          <Btn
            t={t}
            label="Re-check this subject"
            icon={<Ico d={ICONS.refresh} size={ICON_SIZE.nav} />}
            small
            ghost
            onClick={recheckSubject}
            title="Rediscover this subject's state from disk."
          />
          <Btn
            t={t}
            label="View log"
            icon={<Ico d={ICONS.logs} size={ICON_SIZE.nav} />}
            small
            ghost
            onClick={viewLog}
            title="Open this subject's run log, where any failure reason is recorded."
          />
          <Btn
            t={t}
            label="Open folder"
            icon={<Ico d={ICONS.folder} size={ICON_SIZE.nav} />}
            small
            ghost
            onClick={openFolder}
          />
        </div>
      )}
    </div>
  )
}

interface SiteStripProps {
  t: Theme
  summary: SiteSummary
  /** The unregistered subjects whose site is held until registration. */
  held: number
  /** The site filter: a label, or one of the SITE_FILTER_* values. */
  filter: string
  onFilter: (value: string) => void
  /** Open the site dialog, or undefined without a project. */
  onSetSite: (() => void) | undefined
}

/**
 * State the cohort's sites above the matrix, filter the rows by site, and
 * offer the bulk site action. Shown only once some subject has a site.
 */
function SiteStrip(props: SiteStripProps): ReactNode {
  const { t, summary, held, filter, onFilter, onSetSite } = props
  const counts = [siteCountsText(summary), siteHeldText(held)]
    .filter((sentence) => sentence !== null)
    .join(' ')
  const mixed = siteMixedText(summary)
  const facts = siteConfoundFacts(summary)
  const text: CSSProperties = {
    fontFamily: FONTS.sans,
    fontSize: 12,
    lineHeight: 1.4,
    color: t.textSoft,
  }
  return (
    <div
      role="group"
      aria-label="Sites"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px 12px',
        marginBottom: 12,
      }}
    >
      <Segments
        t={t}
        small
        value={filter}
        ariaLabel="Filter subjects by site"
        onChange={onFilter}
        options={[
          { value: SITE_FILTER_ALL, label: 'All sites' },
          // The sentence beside the filter states the counts.
          ...summary.sites.map((count) => ({
            value: count.site,
            label: count.site,
          })),
          ...(summary.unset.length > 0
            ? [{ value: SITE_FILTER_NONE, label: 'No site' }]
            : []),
        ]}
      />
      <span style={{ ...text, flex: '1 1 220px', minWidth: 0 }}>
        {counts}
        {mixed && <span style={{ color: t.warning }}>{` ${mixed}`}</span>}
        {facts.map((fact) => (
          <span key={fact} style={{ color: t.warning }}>{` ${fact}`}</span>
        ))}
      </span>
      {onSetSite && (
        <Btn
          t={t}
          ghost
          small
          label="Set site..."
          title="Set or clear the site of the selected subjects, or of subjects without one"
          onClick={onSetSite}
        />
      )}
    </div>
  )
}

interface EmptyStateProps {
  t: Theme
  hasSubjects: boolean
  filter: SubjectFilter
  query: string
  /** Whether a site filter hides subjects. */
  siteFiltered: boolean
  onShowAll: () => void
}

const FILTER_LABEL: Record<SubjectFilter, string> = {
  all: 'all',
  ...SUBJECT_BUCKET_LABEL,
}

/**
 * The fact for a bucket filter that matches no subject. The bucket names are
 * lowercase inside the sentence, as in the bucket summary; the Failed bucket
 * uses the failure banner's wording.
 */
const EMPTY_BUCKET_FACT: Record<Exclude<SubjectFilter, 'all'>, string> = {
  done: 'No subjects are done.',
  outdated: 'No subjects are out of date.',
  partial: 'No subjects are partly done.',
  running: 'No subjects are running.',
  failed: 'No subjects have a failed step.',
  interrupted: 'No subjects have an interrupted step.',
  cancelled: 'No subjects have a canceled step.',
  pending: 'No subjects are pending.',
  excluded: 'No subjects are excluded.',
}

function EmptyState(props: EmptyStateProps): ReactNode {
  const { t, hasSubjects, filter, query, siteFiltered, onShowAll } = props
  const filtered = filter !== 'all'
  const searched = query.trim().length > 0
  const hiding = hasSubjects && (filtered || searched || siteFiltered)
  const what = filtered
    ? `the "${FILTER_LABEL[filter]}" filter and the ID search "${query.trim()}"`
    : `the ID search "${query.trim()}"`
  // A filter or a search that matches nothing states that fact; the Show all
  // subjects action below is the remedy.
  const message = !hasSubjects
    ? 'No subjects are discovered in this project.'
    : searched
      ? `No subjects match ${what}.`
      : filter !== 'all' && !siteFiltered
        ? EMPTY_BUCKET_FACT[filter]
        : 'No subjects match the current view.'
  return (
    <EmptyStateAtom
      t={t}
      icon="subjects"
      message={message}
      {...(hasSubjects
        ? {}
        : {
            hint: 'Add subjects to the configured data root, then re-discover the cohort.',
          })}
      action={
        hiding ? (
          <Btn
            t={t}
            label="Show all subjects"
            icon={<Ico d={ICONS.x} size={ICON_SIZE.nav} />}
            small
            ghost
            onClick={onShowAll}
          />
        ) : undefined
      }
    />
  )
}
