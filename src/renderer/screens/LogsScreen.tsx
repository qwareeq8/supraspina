import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CSSProperties, ReactNode, Ref, UIEvent } from 'react'
import type {
  DebugBundlePreview,
  RunSnapshot,
  RuntimeLogLine,
  WorkflowResult,
} from '../../shared/contract'
import {
  describeProductVersion,
  parseBuildIdentity,
  shortBuildCommit,
} from '../../shared/build-identity'
import { formatAppVersion } from '../../../scripts/app-version.mjs'
import {
  executionFallbackDetail,
  executionFallbackFact,
} from '../../shared/execution-fallback'
import { unitReuseFact } from '../../shared/unit-reuse'
import type { ProjectConfig } from '../../shared/project-schema'
import { pipelineStep } from '../../shared/steps'
import type {
  Job,
  JobStatus,
  LogLevel,
  ProjectRef,
  RunManifest,
  Subject,
  ToolStatus,
} from '../../shared/types'
import { getApi } from '../state/api'
import { useApp } from '../state/context'
import { useExecutionService } from '../state/execution-service'
import { runTimestampLabel } from '../state/run-label'
import { restateLogLine, terminalReasonText } from '../state/terminal-reason'
import {
  canNormalizeReconstructionCohort,
  executionFailure,
  runExecutionAction,
  type ExecutionFailure,
} from '../state/execution-feedback'
import { logReplayKey, useRuntime } from '../state/runtime-state'
import { useCopyFeedback } from '../state/useCopyFeedback'
import {
  NORMALIZE_RECONSTRUCTION_COHORT_LABEL,
  Btn,
  Card,
  ChipGlyph,
  CodeText,
  Collapsible,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  ExecutionOutcomeNotice,
  FONTS,
  FreshnessStamp,
  Hint,
  Ico,
  IconButton,
  ICONS,
  ICON_SIZE,
  InlineCode,
  LoadingState,
  PageTitle,
  RefreshButton,
  Segments,
  StateLine,
  stateLineStyle,
  statusColor,
  TEXT_GAP,
  type Theme,
} from '../ui'
import { JobStatusChip } from '../ui/JobStatusChip'
import { keepRowInView } from '../ui/keepRowInView'

const TAIL_THRESHOLD_PX = 40
const LOGS_WIDE_MIN_PX = 900
/** Keep the stacked log view readable however short the workspace gets. */
const STACKED_STREAM_MIN_PX = 240
/** Show the top of the stacked panels so the operator sees there is more. */
const STACKED_CONTROLS_PEEK_PX = 96
const LEVELS: readonly LogLevel[] = ['INFO', 'WARN', 'ERROR']
/**
 * Time gutter, level marker, and the message column that takes the rest. The
 * gutter is sized in characters of the stream's monospace font so a 12-hour
 * clock ("10:19:54 PM") fits on one line at every density.
 */
const LOG_LINE_COLS = '12ch 40px minmax(0, 1fr)'

const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
}

/**
 * The word Logs uses for a job or run status wherever it shows or announces
 * one: a job's badge, its row's accessible name and tooltip, and a run's
 * outcome in the Run list.
 */
const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  planned: 'Planned',
  waiting: 'Waiting',
  queued: 'Queued',
  running: 'Running',
  cancelling: 'Canceling',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Canceled',
  blocked: 'Blocked',
  withheld: 'Withheld',
  interrupted: 'Interrupted',
  stale: 'Stale',
  // The Dashboard's word for the same state, and short enough for the Run
  // list at 135% text.
  'persistence-error': 'Storage error',
  unknown: 'Unknown',
}

type LogScope = 'all' | 'selected'

const LOG_SCOPE_OPTIONS = [
  { value: 'all', label: 'All jobs' },
  { value: 'selected', label: 'Selected job' },
] as const

/** What the stream shows at each level threshold. */
const LEVEL_MEANING: Record<LogLevel, string> = {
  INFO: 'The stream shows routine progress, warnings, and errors.',
  WARN: 'The stream shows warnings and errors only.',
  ERROR: 'The stream shows errors only.',
}

/** The level filter's options, each explained in its tooltip. */
const LEVEL_OPTIONS: readonly {
  value: LogLevel
  label: string
  title: string
}[] = [
  { value: 'INFO', label: 'Info', title: LEVEL_MEANING.INFO },
  { value: 'WARN', label: 'Warn', title: LEVEL_MEANING.WARN },
  { value: 'ERROR', label: 'Error', title: LEVEL_MEANING.ERROR },
]

/** What the footer says the stream shows at each level. */
const LEVEL_SCOPE: Record<LogLevel, string> = {
  INFO: 'Info and above',
  WARN: 'Warn and above',
  ERROR: 'Error only',
}

/** Count log lines with the right plural. */
function lineCount(count: number): string {
  return `${count} ${count === 1 ? 'line' : 'lines'}`
}

/** Shorten a long identifier to its two ends around an ellipsis. */
function middleEllipsis(text: string, head = 10, tail = 8): string {
  return text.length <= head + tail + 3
    ? text
    : `${text.slice(0, head)}...${text.slice(-tail)}`
}

type SectionKey = 'active' | 'dryRun' | 'completed' | 'attention' | 'blocked'

const SECTION_ORDER: readonly {
  key: SectionKey
  label: string
  hint?: string
}[] = [
  { key: 'active', label: 'Active' },
  { key: 'dryRun', label: 'Dry-run plans' },
  { key: 'attention', label: 'Needs attention' },
  {
    key: 'blocked',
    label: 'Blocked',
    // A bare count reads as a failure tally; say what the rows are.
    hint: 'Jobs this run did not start because an upstream stage is missing, failed, or withheld. Selecting one shows its reason.',
  },
  { key: 'completed', label: 'Completed' },
]

/**
 * The groups that read as current work, so a superseded run's plans and
 * failures in them contradict the run the operator is watching.
 */
// A blocked node belongs to the run that decided not to start it, so an
// operator watching the current run is not shown dozens of blocked rows from
// runs that ended hours ago. Completed work stays visible because the output
// it produced is still on disk.
const RUN_SCOPED_SECTIONS: readonly SectionKey[] = [
  'dryRun',
  'attention',
  'blocked',
]

/** Project, runtime, and log focus state for Logs. */
export interface LogsScreenProps {
  cfg?: ProjectConfig
  subjects?: Subject[]
  toolStatus?: ToolStatus | null
  refresh?: () => void
}

function sameProject(left: ProjectRef | null, right: ProjectRef): boolean {
  return (
    left?.projectId === right.projectId &&
    left.root === right.root &&
    left.configPath === right.configPath &&
    left.epoch === right.epoch
  )
}

/** Whether a job's status is still active, dry run or live. */
function jobIsActive(job: Job): boolean {
  return ['planned', 'waiting', 'queued', 'running', 'cancelling'].includes(
    job.status,
  )
}

function sectionFor(job: Job): SectionKey {
  if (job.dryRun) return 'dryRun'
  if (jobIsActive(job)) return 'active'
  const { status } = job
  if (status === 'done') return 'completed'
  if (status === 'blocked' || status === 'withheld') return 'blocked'
  return 'attention'
}

function runOrderAt(run: RunSnapshot): number {
  return run.startedAt ?? run.endedAt ?? 0
}

/** Return the newest durable run, which is the run the operator watches. */
function latestDurableRunId(runs: readonly RunSnapshot[]): string | null {
  let latest: RunSnapshot | null = null
  for (const run of runs) {
    if (!run.durable) continue
    if (!latest || runOrderAt(run) > runOrderAt(latest)) latest = run
  }
  return latest?.runId ?? null
}

/** Order jobs by when they last changed, the key the sidecar replays by. */
function jobOrderAt(job: Job): number {
  return job.endedAt ?? job.startedAt ?? job.plannedAt ?? 0
}

/** Return the newest of the jobs; a tie keeps the earlier job. */
function newestJob(jobs: readonly Job[]): Job | null {
  let newest: Job | null = null
  for (const job of jobs) {
    if (!newest || jobOrderAt(job) > jobOrderAt(newest)) newest = job
  }
  return newest
}

/** Whether a job is live work the operator watches before selecting one. */
function isRunningJob(job: Job): boolean {
  return (
    !job.dryRun && (job.status === 'running' || job.status === 'cancelling')
  )
}

/**
 * Pick the job Logs shows before the operator selects one: the running job
 * that started last, else the newest job of the newest durable run, else the
 * newest job. The snapshot lists jobs in no particular order, so its first
 * job can belong to a run that ended days ago.
 */
function defaultJobId(
  jobs: readonly Job[],
  runs: readonly RunSnapshot[],
): string | null {
  const running = newestJob(jobs.filter(isRunningJob))
  if (running) return running.id
  const runId = latestDurableRunId(runs)
  const ofRun = runId
    ? newestJob(jobs.filter((job) => job.runId === runId))
    : null
  return (ofRun ?? newestJob(jobs))?.id ?? null
}

/**
 * Return the earliest time a line of this job can carry. A live line is
 * stamped when the job writes it, after the job started; a line replayed on
 * restart is stamped from the job's order time onward.
 */
function earliestLineAt(job: Job): number {
  return job.startedAt ?? jobOrderAt(job)
}

function groupJobs(
  jobs: Job[],
  focusRunId: string | null,
): Record<SectionKey, Job[]> {
  const grouped: Record<SectionKey, Job[]> = {
    active: [],
    dryRun: [],
    completed: [],
    attention: [],
    blocked: [],
  }
  for (const job of jobs) {
    const section = sectionFor(job)
    // A job without a run identity cannot be attributed to a superseded run,
    // so keep it rather than hide work the operator has no other view of.
    const superseded =
      focusRunId !== null &&
      RUN_SCOPED_SECTIONS.includes(section) &&
      Boolean(job.runId) &&
      job.runId !== focusRunId
    if (superseded) continue
    grouped[section].push(job)
  }
  for (const rows of Object.values(grouped)) {
    rows.sort((left, right) => jobOrderAt(right) - jobOrderAt(left))
  }
  return grouped
}

/**
 * List the durable runs the rail can focus, newest first. Focusing a run
 * selects one of its jobs, so a run with no retained job is left out.
 */
function focusableRuns(
  runs: readonly RunSnapshot[],
  jobs: readonly Job[],
): RunSnapshot[] {
  const withJobs = new Set(jobs.map((job) => job.runId))
  return runs
    .filter((run) => run.durable && withJobs.has(run.runId))
    .sort((left, right) => runOrderAt(right) - runOrderAt(left))
}

const RUN_OPTION_TIME: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}

/**
 * Name a run's start in the Run list without seconds, and without the year
 * when the run started this year, so the closed list keeps its outcome in
 * view in the narrow rail at 135% text.
 */
function runOptionTime(startedAt: number, now: Date): string {
  const started = new Date(startedAt)
  if (!Number.isFinite(started.getTime())) return 'No start time'
  const options =
    started.getFullYear() === now.getFullYear()
      ? RUN_OPTION_TIME
      : { ...RUN_OPTION_TIME, year: 'numeric' as const }
  return new Intl.DateTimeFormat(undefined, options).format(started)
}

/**
 * Name how a run ended in the words of the job badges, so a run that ended
 * canceled reads "Canceled" in the Run list as its jobs do in the rail. A dry
 * run ends planned, so its outcome is its kind, as the rail's Dry-run plans
 * group names it.
 */
function runOutcome(run: RunSnapshot): string {
  if (run.dryRun && run.status === 'planned') return 'Dry-run plan'
  const label = JOB_STATUS_LABEL[run.status]
  return run.dryRun ? `${label}${TEXT_GAP}dry run` : label
}

/**
 * Name a run in the Run list by a short start time and its outcome;
 * {@link runOptionTitle} holds the full start time.
 *
 * @param now - The current time, which decides whether the year is shown.
 * @returns The label, for example "Sep 21, 8:34 PM" and "Interrupted"
 * joined by TEXT_GAP.
 */
function runOptionLabel(run: RunSnapshot, now: Date): string {
  // Keep the start time first, as the pickers of Results and QC review do.
  // The scope is left out: the rail is narrow, and a clipped label should lose
  // as little as possible.
  const started =
    run.startedAt === null ? 'No start time' : runOptionTime(run.startedAt, now)
  return `${started}${TEXT_GAP}${runOutcome(run)}`
}

/**
 * Name a run in full for the Run list's tooltips: the start time with its
 * year and seconds, so same-minute runs stay apart, then the outcome.
 */
function runOptionTitle(run: RunSnapshot): string {
  const started =
    run.startedAt === null
      ? 'Start time not recorded'
      : `Started ${runTimestampLabel(run.startedAt)}`
  return `${started}${TEXT_GAP}${runOutcome(run)}`
}

/**
 * Return the job that heads the rail once the run is in focus: its first row
 * in section order, so a run whose jobs all failed or were blocked opens on
 * a job that needs attention.
 */
function firstRailJob(jobs: readonly Job[], runId: string): Job | null {
  const grouped = groupJobs(
    jobs.filter((job) => job.runId === runId),
    runId,
  )
  for (const section of SECTION_ORDER) {
    const first = grouped[section.key][0]
    if (first) return first
  }
  return null
}

function shortStep(job: Job): string {
  try {
    return pipelineStep(job.stepKey).name
  } catch {
    return job.stepKey
  }
}

/**
 * Keep the raw identifiers of a log line reachable through its tooltip when
 * the owning job is no longer retained; nothing else can attribute the line.
 */
function jobRunIdentity(jobId: string, runId: string | null): string {
  return `Job ${jobId}; run ${runId ?? 'not assigned'}`
}

function jobIdentityLabel(job: Job): string {
  return `${job.subjectId ?? 'cohort'} / ${shortStep(job)}`
}

/** The bounded-tail caveat under an empty log view that is neither a search nor an absent job. */
const BOUNDED_TAIL_NOTE =
  'This view shows the bounded durable tail. Complete logs remain in backend-owned storage.'

/**
 * Describe a selected job that has no line in the retained tail: a job whose
 * log is empty says so, and any other job's lines are older than the tail.
 */
function absentJobCopy(
  job: Job,
  wroteNothing: boolean,
  retainedLines: number,
): { message: string; hint: string } {
  const label = jobIdentityLabel(job)
  if (wroteNothing && sectionFor(job) === 'active') {
    return {
      message: `${label} has written no log lines yet.`,
      hint: 'Its lines appear here as it writes them.',
    }
  }
  if (wroteNothing) {
    return {
      message: `${label} wrote no log lines.`,
      hint:
        job.startedAt === null
          ? 'It did not start, so it has no log.'
          : 'Its log file is empty.',
    }
  }
  return {
    message: `No lines from ${label} are in the retained log tail.`,
    hint: `The tail keeps only the newest ${retainedLines} ${retainedLines === 1 ? 'line' : 'lines'} across all jobs. The complete job log remains in backend-owned storage.`,
  }
}

function jobClockLabel(job: Job): string {
  if (job.endedAt !== null) return `finished ${formatClock(job.endedAt)}`
  if (job.startedAt !== null) return `started ${formatClock(job.startedAt)}`
  if (job.plannedAt !== undefined) {
    return `planned ${formatClock(job.plannedAt)}`
  }
  return 'not started'
}

function backendLabel(job: Job): string | null {
  if (job.backend === 'fastsurfer') return 'FastSurfer'
  if (job.backend === 'freesurfer') return 'FreeSurfer'
  return null
}

function runClockLabel(
  run: RunSnapshot | null,
  job: Job | null,
): string | null {
  if (run) {
    return run.startedAt !== null
      ? `run ${formatClock(run.startedAt)}`
      : 'run not started'
  }
  return job ? 'run not retained' : null
}

/** One job's consecutive log lines, presented under a single header. */
interface LogGroup {
  key: string
  job: Job | null
  run: RunSnapshot | null
  identity: string | null
  lines: RuntimeLogLine[]
}

/**
 * Collect consecutive lines of one job into a single block.
 *
 * @param lines - The filtered log lines, in stream order.
 */
function groupLogLines(
  lines: readonly RuntimeLogLine[],
  jobsById: Map<string, Job>,
  runsById: Map<string, RunSnapshot>,
): LogGroup[] {
  const groups: LogGroup[] = []
  for (const line of lines) {
    const current = groups[groups.length - 1]
    const head = current?.lines[0]
    if (head && head.jobId === line.jobId && head.runId === line.runId) {
      current?.lines.push(line)
      continue
    }
    const job = jobsById.get(line.jobId) ?? null
    groups.push({
      key: line.id,
      job,
      run: runsById.get(line.runId) ?? null,
      identity: job ? null : jobRunIdentity(line.jobId, line.runId),
      lines: [line],
    })
  }
  return groups
}

/**
 * The text a log line shows and is searched by. The sidecar's error marker for
 * a job that ended in an error status opens with an order and quotes the
 * job's recorded reason, so it reads as the outcome and the reason the
 * Terminal reason field states; another error line reads a recorded order as
 * its fact. A progress or failure line that a stage tool wrote as an order,
 * such as "Process 82 discovered subjects.", reads as its fact, and any other
 * line is shown as written (see {@link restateLogLine}). The line's identity and recorded text
 * stay as the sidecar sent them.
 */
function logLineText(line: RuntimeLogLine): string {
  return restateLogLine(line.line, line.level)
}

function matchesLogSearch(
  line: RuntimeLogLine,
  job: Job | null,
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return true
  const backend = job ? backendLabel(job) : null
  const searchable = [
    logLineText(line),
    line.jobId,
    line.runId,
    job?.subjectId,
    job?.stepKey,
    job ? shortStep(job) : null,
    job?.backend,
    backend,
    job?.attemptOrdinal === undefined ? null : `attempt ${job.attemptOrdinal}`,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase()
  return terms.every((term) => searchable.includes(term))
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Count debug files, such as "1 file" or "8 files". */
function fileCountText(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

/**
 * Return the newest job a later run holds for this job's stage and subject,
 * or null when no later run scheduled that node again. A dry run schedules
 * nothing, so its jobs do not count.
 */
function laterRunJob(job: Job, jobs: readonly Job[]): Job | null {
  if (!job.runId) return null
  const at = jobOrderAt(job)
  return newestJob(
    jobs.filter(
      (other) =>
        other.id !== job.id &&
        !other.dryRun &&
        Boolean(other.runId) &&
        other.runId !== job.runId &&
        other.stepKey === job.stepKey &&
        (other.subjectId ?? null) === (job.subjectId ?? null) &&
        jobOrderAt(other) > at,
    ),
  )
}

/** State why a job that a later run superseded offers no retry. */
function supersededRetryReason(job: Job, laterRun: RunSnapshot | null): string {
  const run =
    laterRun?.startedAt != null
      ? `A later run, started ${runTimestampLabel(laterRun.startedAt)},`
      : 'A later run'
  return `${run} scheduled ${shortStep(job)} for ${job.subjectId ?? 'the cohort'} again, so this older job cannot be retried.`
}

/**
 * Move a hex color part of the way toward another hex color; a color in any
 * other form is returned unchanged.
 */
function mixHex(color: string, toward: string, weight: number): string {
  const channels = (value: string): number[] | null => {
    const match = /^#([0-9a-f]{6})$/i.exec(value)
    if (!match?.[1]) return null
    const hex = match[1]
    return [0, 2, 4].map((index) =>
      Number.parseInt(hex.slice(index, index + 2), 16),
    )
  }
  const from = channels(color)
  const to = channels(toward)
  if (!from || !to) return color
  return `#${from
    .map((value, index) =>
      Math.round(value + ((to[index] ?? value) - value) * weight)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/**
 * De-emphasized text on the failure tint of an ERROR line or a failed job's
 * Terminal outcome: the theme's gray moved a fifth of the way toward the body
 * text. On the light tint the plain grays fall short of 4.5:1 (the time
 * gutter's 4.02:1, the outcome labels' 3.89:1); moved, they hold 5.1:1 and
 * 4.9:1 and stay quieter than the text beside them. The dark and
 * high-contrast themes pass either way and gain a little.
 */
function onFailureTint(t: Theme, gray: string): string {
  return mixHex(gray, t.text, 0.2)
}

/**
 * The retry action of each job outcome that has one; the panel's status chip
 * already names the outcome. A job in any other state, such as a blocked,
 * withheld or finished one,
 * offers none: nothing it could become would enable a retry.
 */
const RETRY_LABEL: Partial<Record<Job['status'], string>> = {
  failed: 'Retry job',
  interrupted: 'Retry job',
  cancelled: 'Retry job',
}

/**
 * Where a node retry started from Logs is: planning until its plan is on
 * screen, in review while the plan is open, and retrying from approval until
 * the launch settles.
 */
type RetryPhase = 'planning' | 'review' | 'retrying'

/** The progress line of a node retry's plan, on the button and the dock. */
const RETRY_PLANNING_LABEL = 'Planning the retry...'

/** The retry button's label while planning and after approval. */
const RETRY_BUSY_LABEL: Partial<Record<RetryPhase, string>> = {
  planning: RETRY_PLANNING_LABEL,
  retrying: 'Retrying...',
}

function canRetry(job: Job): boolean {
  return (
    Boolean(job.runId && job.nodeId) && RETRY_LABEL[job.status] !== undefined
  )
}

function hasTerminalStatus(job: Job): boolean {
  return [
    'done',
    'failed',
    'cancelled',
    'blocked',
    'withheld',
    'interrupted',
    'stale',
    'persistence-error',
  ].includes(job.status)
}

/** Render retained logs, manifests, and redacted debug exports. */
export function LogsScreen(props: LogsScreenProps = {}): ReactNode {
  const { projectEpoch } = useApp()
  return <ProjectLogs key={projectEpoch} {...props} />
}

function ProjectLogs(props: LogsScreenProps): ReactNode {
  const {
    t,
    density,
    projectRef,
    setRoute,
    logsFocusRunId,
    logsFocusStepKey,
    setLogsFocusRunId,
    pendingPlan,
    trackPlan,
  } = useApp()
  const runtime = useRuntime()
  const execution = useExecutionService()
  const latestProjectRef = useRef(projectRef)
  useLayoutEffect(() => {
    latestProjectRef.current = projectRef
    return () => {
      latestProjectRef.current = null
    }
  }, [projectRef])

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  // The run a hand-off from another screen focused, so it applies once.
  const [appliedFocusRunId, setAppliedFocusRunId] = useState<string | null>(
    null,
  )
  const runFocusRef = useRef<HTMLSelectElement | null>(null)
  // The job rail and its rows, to bring a job selected from outside the rail
  // into view.
  const railRef = useRef<HTMLElement | null>(null)
  const railRowsRef = useRef(new Map<string, HTMLButtonElement>())
  // Each request is a new object, so selecting the same job again reveals it
  // again, and the effect runs once per request.
  const [revealRequest, setRevealRequest] = useState<{ jobId: string } | null>(
    null,
  )
  const [scope, setScope] = useState<LogScope>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [level, setLevel] = useState<LogLevel>('INFO')
  const [tailing, setTailing] = useState(true)
  const tailingRef = useRef(true)
  const streamRef = useRef<HTMLDivElement | null>(null)
  const [manifestState, setManifestState] = useState<{
    runId: string
    manifest: RunManifest | null
    error: string | null
  } | null>(null)
  const [manifestNonce, setManifestNonce] = useState(0)
  const [actionError, setActionError] = useState<ExecutionFailure | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [actionOutcome, setActionOutcome] = useState<WorkflowResult | null>(
    null,
  )
  const [workspaceLayout, setWorkspaceLayout] = useState<
    'three-pane' | 'stacked-controls'
  >('three-pane')
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const [runDetailsOpen, setRunDetailsOpen] = useState(false)
  const [retryPhase, setRetryPhase] = useState<RetryPhase | null>(null)
  // The run a node retry started, until the runtime lists its job.
  const [launchedRetry, setLaunchedRetry] = useState<{
    jobId: string
    runId: string
  } | null>(null)
  const [debugPreview, setDebugPreview] = useState<DebugBundlePreview | null>(
    null,
  )
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugLoading, setDebugLoading] = useState(false)
  const [debugBusy, setDebugBusy] = useState(false)
  const [categoryIds, setCategoryIds] = useState<Set<string>>(new Set())
  const [bundleResult, setBundleResult] = useState<{
    artifactId: string
    displayPath: string
  } | null>(null)
  const { copiedKey, copy } = useCopyFeedback(1400)

  useEffect(() => {
    tailingRef.current = tailing
  }, [tailing])

  useLayoutEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return undefined
    const updateLayout = (width: number): void => {
      if (width <= 0) return
      setWorkspaceLayout(
        width < LOGS_WIDE_MIN_PX ? 'stacked-controls' : 'three-pane',
      )
    }
    updateLayout(workspace.clientWidth)
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => {
      if (entry) updateLayout(entry.contentRect.width)
    })
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [])

  const fallbackJobId = useMemo(
    () => defaultJobId(runtime.jobs, runtime.runs),
    [runtime.jobs, runtime.runs],
  )
  const effectiveSelectedJobId =
    selectedJobId && runtime.jobs.some((job) => job.id === selectedJobId)
      ? selectedJobId
      : fallbackJobId

  const selectedJob = useMemo(
    () => runtime.jobs.find((job) => job.id === effectiveSelectedJobId) ?? null,
    [runtime.jobs, effectiveSelectedJobId],
  )
  const selectedRun = useMemo(
    () =>
      selectedJob?.runId
        ? (runtime.runs.find((run) => run.runId === selectedJob.runId) ?? null)
        : null,
    [runtime.runs, selectedJob],
  )
  // The stream is live while the shown run, or any run when none is shown,
  // still has an active job.
  const streamLive = useMemo(
    () =>
      runtime.jobs.some(
        (job) =>
          jobIsActive(job) &&
          (!selectedJob?.runId || job.runId === selectedJob.runId),
      ),
    [runtime.jobs, selectedJob],
  )
  // A retry replays the node from the job's own run: the sidecar reruns an
  // explicitly selected failed or canceled node even when a later run left a
  // current receipt for it, and scopes cohort stages to that run's cohort
  // intersected with today's eligible subjects. For a job a later run
  // scheduled again, that would redo settled work under an older cohort,
  // so the retry is offered only on the newest job of a stage and subject.
  // A job with no retry, such as a done one, needs no reason.
  const retryBlockedReason = useMemo(() => {
    if (!selectedJob || !canRetry(selectedJob)) return null
    const later = laterRunJob(selectedJob, runtime.jobs)
    if (!later) return null
    return supersededRetryReason(
      selectedJob,
      runtime.runs.find((run) => run.runId === later.runId) ?? null,
    )
  }, [runtime.jobs, runtime.runs, selectedJob])

  useEffect(() => {
    const project = projectRef
    const runId = selectedJob?.runId
    if (!project || !runId) return undefined
    let active = true
    void getApi()
      .manifest.forRun({ project, runId })
      .then((next) => {
        if (!active || next.runId !== runId) return
        setManifestState({ runId, manifest: next, error: null })
      })
      .catch((cause: unknown) => {
        if (!active) return
        setManifestState({
          runId,
          manifest: null,
          error:
            cause instanceof Error
              ? cause.message
              : 'The run manifest could not be loaded.',
        })
      })
    return () => {
      active = false
    }
  }, [projectRef, selectedJob?.runId, manifestNonce])

  const manifestRunId = selectedJob?.runId ?? null
  const manifest =
    manifestRunId && manifestState?.runId === manifestRunId
      ? manifestState.manifest
      : null
  const manifestError =
    manifestRunId && manifestState?.runId === manifestRunId
      ? manifestState.error
      : null

  const jobsById = useMemo(
    () => new Map(runtime.jobs.map((job) => [job.id, job])),
    [runtime.jobs],
  )
  const runsById = useMemo(
    () => new Map(runtime.runs.map((run) => [run.runId, run])),
    [runtime.runs],
  )
  // Follow the job the operator picked. Before that, follow the running job
  // Logs shows, whose run can be older than the newest run (a later launch
  // can end blocked while it runs), and otherwise the newest durable run. The
  // Run list, Selected job, Run manifest, and the All jobs stream then name
  // one run, and the rail never reports plans and failures that a later run
  // superseded.
  const selectedRailJob = selectedJobId
    ? (jobsById.get(selectedJobId) ?? null)
    : null
  const fallbackJob = fallbackJobId
    ? (jobsById.get(fallbackJobId) ?? null)
    : null
  const runningRunId =
    fallbackJob && isRunningJob(fallbackJob) ? fallbackJob.runId : null
  const focusRunId =
    selectedRailJob?.runId ?? runningRunId ?? latestDurableRunId(runtime.runs)
  const searchTerms = useMemo(
    () => searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [searchQuery],
  )
  // All jobs streams the lines of the run in focus, so a chosen older run is
  // not interleaved with the lines of later runs. A line with no run identity
  // belongs to no other run and stays.
  const runLogs = useMemo(
    () =>
      focusRunId === null
        ? runtime.logs
        : runtime.logs.filter(
            (line) => !line.runId || line.runId === focusRunId,
          ),
    [runtime.logs, focusRunId],
  )
  const visibleLogs = useMemo(() => {
    const threshold = LEVELS.indexOf(level)
    return (scope === 'all' ? runLogs : runtime.logs).filter((line) => {
      if (
        scope === 'selected' &&
        (!effectiveSelectedJobId || line.jobId !== effectiveSelectedJobId)
      )
        return false
      if (LEVELS.indexOf(line.level) < threshold) return false
      return matchesLogSearch(
        line,
        jobsById.get(line.jobId) ?? null,
        searchTerms,
      )
    })
  }, [
    runLogs,
    runtime.logs,
    scope,
    effectiveSelectedJobId,
    level,
    jobsById,
    searchTerms,
  ])

  // The run in focus with no line at any level is absent from the bounded
  // tail, so a level change cannot reveal anything for it either.
  const runAbsentFromTail =
    scope === 'all' && runtime.logs.length > 0 && runLogs.length === 0
  // A selected job with no line at any level is absent from the bounded tail,
  // so a level change cannot reveal anything for it.
  const selectedJobAbsentFromTail = useMemo(
    () =>
      scope === 'selected' &&
      effectiveSelectedJobId !== null &&
      runtime.logs.length > 0 &&
      !runtime.logs.some((line) => line.jobId === effectiveSelectedJobId),
    [runtime.logs, scope, effectiveSelectedJobId],
  )
  // Say a job wrote nothing only when that is known. A job that never started
  // has no log. A job that had finished at the bootstrap snapshot reaches the
  // tail only through the replay, which stops at a line budget and a file
  // limit, so its log is empty only when the replay read the whole file and
  // found no line. A job that was running then and has finished since mixes
  // replayed and live lines, so nothing is claimed for it.
  const selectedJobWroteNothing = useMemo(() => {
    if (!selectedJobAbsentFromTail || !selectedJob) return false
    if (selectedJob.startedAt === null) return true
    const key = logReplayKey(selectedJob.runId, selectedJob.id)
    const finishedAtSnapshot = runtime.logReplay.snapshotJobs.get(key)
    if (finishedAtSnapshot === true) {
      const coverage = runtime.logReplay.entries.get(key)
      return coverage?.complete === true && coverage.lines === 0
    }
    if (finishedAtSnapshot === false && sectionFor(selectedJob) !== 'active') {
      return false
    }
    // Any other job writes live lines with real times, and the tail drops
    // lines oldest first: when the job started after the oldest retained
    // line, any line it wrote would still be here.
    const oldestRetainedAt = runtime.logs.reduce(
      (oldest, line) => Math.min(oldest, line.at),
      Number.POSITIVE_INFINITY,
    )
    return earliestLineAt(selectedJob) > oldestRetainedAt
  }, [runtime.logs, runtime.logReplay, selectedJob, selectedJobAbsentFromTail])
  const absentCopy =
    selectedJobAbsentFromTail && selectedJob
      ? absentJobCopy(selectedJob, selectedJobWroteNothing, runtime.logs.length)
      : null

  const logGroups = useMemo(
    () => groupLogLines(visibleLogs, jobsById, runsById),
    [visibleLogs, jobsById, runsById],
  )

  // Follow every change to the visible tail, not only a change in its length:
  // once the bounded tail is full each new line evicts the oldest, the count
  // stays put, and a length-keyed follow would stop moving. Running before
  // paint keeps the stream from ever presenting a not-at-bottom position that
  // the scroll handler would read as the operator pausing.
  useLayoutEffect(() => {
    if (!tailingRef.current) return
    const viewport = streamRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [visibleLogs])

  const onStreamScroll = useCallback((event: UIEvent<HTMLDivElement>): void => {
    const viewport = event.currentTarget
    const distance =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    const nextTailing = distance <= TAIL_THRESHOLD_PX
    // Update the effect guard during this event to prevent paused streams from
    // jumping after an immediate filter change.
    tailingRef.current = nextTailing
    setTailing(nextTailing)
  }, [])

  const jumpToLatest = (): void => {
    tailingRef.current = true
    setTailing(true)
    const viewport = streamRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }

  // A started retry settles before the runtime reports the run's job, which
  // then supersedes the retried one; until then the retry still reads as
  // retrying, so the button never offers the job again in between. A run
  // that ended without that job releases it too.
  const awaitingLaunchedRun =
    launchedRetry !== null &&
    selectedJob?.id === launchedRetry.jobId &&
    !runtime.jobs.some(
      (other) =>
        other.runId === launchedRetry.runId &&
        other.stepKey === selectedJob.stepKey &&
        (other.subjectId ?? null) === (selectedJob.subjectId ?? null),
    ) &&
    !runtime.runs.some(
      (run) => run.runId === launchedRetry.runId && run.endedAt !== null,
    )
  const effectiveRetryPhase: RetryPhase | null =
    retryPhase ?? (awaitingLaunchedRun ? 'retrying' : null)
  // Another launch's plan in progress holds this retry, as it holds every
  // launch control, and names the plan it waits for. This retry's own line
  // shows as its phase instead.
  const planWaitReason =
    effectiveRetryPhase === null ? (pendingPlan?.waitReason ?? null) : null

  const retrySelected = (): void => {
    const job = selectedJob
    if (
      !job?.runId ||
      !job.nodeId ||
      !canRetry(job) ||
      retryBlockedReason ||
      planWaitReason ||
      effectiveRetryPhase !== null
    ) {
      return
    }
    const runId = job.runId
    const nodeId = job.nodeId
    const includeCancelled = job.status === 'cancelled'
    // A read-only review names this job's own retry as the way back.
    const relaunchLabel = RETRY_LABEL[job.status]
    // Publish the planning line every launch shares, as a Runs retry does,
    // so the run dock and Runs state the plan and hold their launches. The
    // Runs failure alert stays until a later run recovers the failed work.
    const line = trackPlan({
      label: RETRY_PLANNING_LABEL,
      waitReason: 'Supraspina is planning the retry.',
      card: null,
      keepsRunsFeedback: true,
    })
    runExecutionAction(
      async () => {
        setRetryPhase('planning')
        setLaunchedRetry(null)
        try {
          const result = await execution.retry(runId, {
            nodeIds: [nodeId],
            includeCancelled,
            ...(relaunchLabel !== undefined ? { relaunchLabel } : {}),
            // The service releases the planning line once the plan is on
            // screen and holds it again from approval until the launch
            // settles; that final release leaves the retry retrying.
            planning: (pending) => {
              line(pending)
              setRetryPhase((phase) =>
                pending ? 'retrying' : phase === 'planning' ? 'review' : phase,
              )
            },
          })
          if (result.disposition === 'started' && result.runId !== null) {
            setLaunchedRetry({ jobId: job.id, runId: result.runId })
          }
          return result
        } finally {
          setRetryPhase(null)
        }
      },
      'Retry the job.',
      setActionError,
      setActionNotice,
      setActionOutcome,
      line,
    )
  }

  const normalizeReconstructionCohort = (): void => {
    runExecutionAction(
      () =>
        execution.run(
          {
            kind: 'stage',
            stepKey: 'recon',
            target: { mode: 'all' },
          },
          undefined,
          undefined,
          // A read-only review names this flow's own button.
          NORMALIZE_RECONSTRUCTION_COHORT_LABEL,
        ),
      'Retry planning full-cohort reconstruction normalization.',
      setActionError,
      setActionNotice,
      setActionOutcome,
    )
  }

  const prepareDebugBundle = async (): Promise<void> => {
    const project = projectRef
    const runId = selectedJob?.runId
    if (!project || !runId) return
    setDebugLoading(true)
    setActionError(null)
    setActionNotice(null)
    setActionOutcome(null)
    setBundleResult(null)
    try {
      const preview = await getApi().manifest.previewDebug({ project, runId })
      if (!sameProject(latestProjectRef.current, project)) return
      if (preview.runId !== runId) {
        throw new Error('Reload the debug preview for this run.')
      }
      setDebugPreview(preview)
      setCategoryIds(new Set())
      setDebugOpen(true)
    } catch (cause) {
      if (!sameProject(latestProjectRef.current, project)) return
      setActionError(
        executionFailure(cause, 'Retry previewing the debug bundle.'),
      )
    } finally {
      if (sameProject(latestProjectRef.current, project)) setDebugLoading(false)
    }
  }

  const createDebugBundle = async (): Promise<void> => {
    const project = projectRef
    const preview = debugPreview
    const selected = [...categoryIds]
    if (!project || !preview || selected.length === 0) return
    setDebugBusy(true)
    setActionError(null)
    setActionNotice(null)
    setActionOutcome(null)
    try {
      const destination = await getApi().fs.chooseSavePath({
        purpose: 'debug-bundle',
        project,
        defaultPath: `supraspina-${preview.runId}-debug.zip`,
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
      })
      if (!destination || !sameProject(latestProjectRef.current, project))
        return
      const result = await getApi().manifest.bundleDebug({
        project,
        runId: preview.runId,
        categoryIds: selected,
        destinationId: destination.destinationId,
        consent: true,
        redaction: 'required',
      })
      if (!sameProject(latestProjectRef.current, project)) return
      setBundleResult(result)
      setDebugOpen(false)
    } catch (cause) {
      if (!sameProject(latestProjectRef.current, project)) return
      setActionError(
        executionFailure(cause, 'Retry creating the debug bundle.'),
      )
    } finally {
      if (sameProject(latestProjectRef.current, project)) setDebugBusy(false)
    }
  }

  const revealBundle = async (): Promise<void> => {
    const project = projectRef
    const bundle = bundleResult
    if (!project || !bundle) return
    setActionError(null)
    setActionNotice(null)
    setActionOutcome(null)
    try {
      await getApi().artifact.reveal({
        project,
        artifactId: bundle.artifactId,
      })
    } catch (cause) {
      if (!sameProject(latestProjectRef.current, project)) return
      setActionError(
        executionFailure(cause, 'Retry revealing the debug bundle.'),
      )
    }
  }

  const grouped = useMemo(
    () => groupJobs(runtime.jobs, focusRunId),
    [runtime.jobs, focusRunId],
  )
  const runOptions = useMemo(
    () => focusableRuns(runtime.runs, runtime.jobs),
    [runtime.runs, runtime.jobs],
  )
  // Focus a run through its first job, so the rail, the selected job, and the
  // run manifest all follow one run, and a run with no completed job is
  // reachable without a row of it to click first. A hand-off that names a
  // stage selects the run's newest job of that stage instead, when it has
  // one.
  const focusRun = (
    runId: string,
    stepKey: Job['stepKey'] | null = null,
  ): void => {
    const job =
      (stepKey === null
        ? null
        : newestJob(
            runtime.jobs.filter(
              (candidate) =>
                candidate.runId === runId && candidate.stepKey === stepKey,
            ),
          )) ?? firstRailJob(runtime.jobs, runId)
    if (job) {
      setSelectedJobId(job.id)
      setRevealRequest({ jobId: job.id })
    }
  }
  // Another screen hands a run over once, as the Dashboard's Recent runs
  // does, and a Runs stage card's View log with its stage. Focus it as the
  // Run list would, during render so the default run never shows first, as
  // soon as the rail lists a job of that run, and of the stage when one is
  // named; then clear the hand-off so a later visit opens on the default run.
  // Until then it stays pending: a hand-off that arrives before the runtime
  // lists the run's jobs would otherwise select nothing and be lost.
  if (
    logsFocusRunId !== null &&
    !runtime.hydrating &&
    appliedFocusRunId !== logsFocusRunId &&
    runtime.jobs.some(
      (job) =>
        job.runId === logsFocusRunId &&
        (logsFocusStepKey === null || job.stepKey === logsFocusStepKey),
    )
  ) {
    setAppliedFocusRunId(logsFocusRunId)
    focusRun(logsFocusRunId, logsFocusStepKey)
    // A stage's View log asks for that stage's log, so the stream shows the
    // selected job rather than the run's other jobs.
    if (logsFocusStepKey !== null) setScope('selected')
  }
  // The job the Run list or a hand-off selected can sit below the rail's
  // fold, as a stage's newest job does in a long run. Scroll only the rail,
  // and at once, so the page stays in place and nothing animates.
  // The rail can still change height after the reveal, as the page settles
  // its layout on arrival (a rail can shrink from 360 to 304 px), so reveal the
  // row again on each resize until the operator moves the rail.
  useLayoutEffect(() => {
    if (revealRequest === null) return undefined
    const rail = railRef.current
    const reveal = (): void => {
      const row = railRowsRef.current.get(revealRequest.jobId)
      if (rail && row) keepRowInView(rail, row, null)
    }
    reveal()
    if (rail === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(reveal)
    observer.observe(rail)
    const release = (): void => observer.disconnect()
    const moves = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const
    for (const move of moves) {
      rail.addEventListener(move, release, { passive: true })
    }
    return () => {
      observer.disconnect()
      for (const move of moves) rail.removeEventListener(move, release)
    }
  }, [revealRequest])
  // The control that handed the run over, such as a Recent runs row, left
  // with its screen and dropped keyboard focus to the page body. Give it to
  // the Run list, which names the run handed over; focus the operator placed
  // elsewhere meanwhile stays, and an ordinary visit moves none. The Run list
  // sits at the top of the rail, so a plain focus would scroll the rail back
  // up and hide the job row revealed above.
  useEffect(() => {
    if (logsFocusRunId === null || appliedFocusRunId !== logsFocusRunId) {
      return
    }
    const active = document.activeElement
    if (active === null || active === document.body) {
      runFocusRef.current?.focus({ preventScroll: true })
    }
    setLogsFocusRunId(null)
  }, [appliedFocusRunId, logsFocusRunId, setLogsFocusRunId])
  // The stamp measures the newest change Logs holds: a job's plan, start or
  // end, or a retained line. A job can end after the newest retained line,
  // as a statistics job that writes no line after the tail's last one does.
  const freshestChange = Math.max(
    runtime.logs.reduce((latest, line) => Math.max(latest, line.at), 0),
    runtime.jobs.reduce((latest, job) => Math.max(latest, jobOrderAt(job)), 0),
  )

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
        background: t.bg,
        color: t.text,
      }}
    >
      {/* One row, as the shared Page header: the title and the controls. */}
      <header
        style={{
          padding: 'var(--ss-header-pad-y) 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          borderBottom: `1px solid ${t.borderSoft}`,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 'var(--ss-input-h)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <PageTitle t={t}>Logs</PageTitle>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TailChip
            t={t}
            tailing={tailing}
            live={streamLive}
            lineCount={visibleLogs.length}
          />
          {!tailing && (
            <Btn
              t={t}
              small
              label="Jump to latest"
              icon={<Ico d={ICONS.latest} size={ICON_SIZE.nav} />}
              onClick={jumpToLatest}
            />
          )}
          <FreshnessStamp
            t={t}
            at={
              freshestChange > 0 ? new Date(freshestChange).toISOString() : null
            }
            title={
              freshestChange > 0
                ? `The newest job change or log line in Logs is from ${runTimestampLabel(freshestChange)}.`
                : undefined
            }
          />
          <RefreshButton
            t={t}
            ariaLabel="Refresh run manifest"
            title="Refresh run manifest"
            onClick={() => {
              props.refresh?.()
              setManifestState(null)
              setManifestNonce((value) => value + 1)
            }}
            disabled={!projectRef || !selectedJob?.runId}
          />
        </div>
      </header>

      <div
        ref={workspaceRef}
        data-testid="logs-workspace"
        data-layout={workspaceLayout}
        data-wide-min-px={LOGS_WIDE_MIN_PX}
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateAreas:
            workspaceLayout === 'three-pane'
              ? '"jobs stream controls"'
              : '"jobs stream" "controls controls"',
          gridTemplateColumns:
            workspaceLayout === 'three-pane'
              ? 'minmax(190px, 230px) minmax(360px, 1fr) minmax(260px, 310px)'
              : 'minmax(190px, 230px) minmax(0, 1fr)',
          // Stacked, the log view fills the workspace except for a strip that
          // shows the top of the panels below, and the workspace scrolls to
          // give those panels their full height. An auto row would instead
          // shrink the panels to the leftover strip, because the controls and
          // their cards set a zero minimum height.
          gridTemplateRows:
            workspaceLayout === 'three-pane'
              ? 'minmax(0, 1fr)'
              : `max(${STACKED_STREAM_MIN_PX}px, calc(100% - ${STACKED_CONTROLS_PEEK_PX}px)) max-content`,
          minHeight: 0,
          overflow: 'auto',
        }}
      >
        {/* The job list scrolls on its own, so keep the region reachable by
            keyboard even while it holds no focusable job rows. */}
        <aside
          ref={railRef}
          aria-label="Jobs"
          data-layout-region="jobs"
          tabIndex={0}
          style={{
            // Make the rail its rows' offset parent for keepRowInView.
            position: 'relative',
            gridArea: 'jobs',
            minWidth: 0,
            borderRight: `1px solid ${t.border}`,
            overflow: 'auto',
            padding: density.pad,
            display: 'flex',
            flexDirection: 'column',
            gap: density.gap,
          }}
        >
          {runtime.hydrating && <RailSkeleton t={t} />}
          {!runtime.hydrating &&
            focusRunId !== null &&
            runOptions.length > 0 && (
              <RunFocusControl
                t={t}
                selectRef={runFocusRef}
                focusRunId={focusRunId}
                focusedRun={runsById.get(focusRunId) ?? null}
                runs={runOptions}
                onFocus={focusRun}
              />
            )}
          {!runtime.hydrating && runtime.jobs.length === 0 && (
            <EmptyState
              t={t}
              icon="logs"
              message="No durable job exists yet."
              hint="Start a workflow from Pipeline or Runs."
            />
          )}
          {!runtime.hydrating &&
            SECTION_ORDER.map((section) => {
              const rows = grouped[section.key]
              // A run-scoped group with nothing in it says nothing, so leave
              // it out rather than announce an empty count.
              if (
                rows.length === 0 &&
                focusRunId !== null &&
                RUN_SCOPED_SECTIONS.includes(section.key)
              ) {
                return null
              }
              return (
                <div key={section.key}>
                  <RailHeader
                    t={t}
                    label={section.label}
                    count={rows.length}
                    {...(section.hint && rows.length > 0
                      ? { hint: section.hint }
                      : {})}
                  />
                  {rows.map((job) => (
                    <JobRow
                      key={job.id}
                      t={t}
                      job={job}
                      active={job.id === effectiveSelectedJobId}
                      onSelect={() => setSelectedJobId(job.id)}
                      rowRef={(el) => {
                        if (el) railRowsRef.current.set(job.id, el)
                        else railRowsRef.current.delete(job.id)
                      }}
                    />
                  ))}
                </div>
              )
            })}
        </aside>

        <section
          aria-label="Log stream"
          data-layout-region="stream"
          style={{
            gridArea: 'stream',
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div
            role="group"
            aria-label="Log scope and search"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              padding: '7px 12px',
              borderBottom: `1px solid ${t.border}`,
              background: t.surface,
            }}
          >
            <Segments
              t={t}
              value={scope}
              options={LOG_SCOPE_OPTIONS}
              onChange={(value) => setScope(value as LogScope)}
              ariaLabel="Log job scope"
              disabledOptions={
                effectiveSelectedJobId ? undefined : ['selected']
              }
              small
            />
            <Segments
              t={t}
              value={level}
              options={LEVEL_OPTIONS}
              onChange={(value) => setLevel(value as LogLevel)}
              ariaLabel="Minimum level"
              small
            />
            <div
              role="search"
              aria-label="Search retained logs"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                flex: '1 1 260px',
                minWidth: 180,
              }}
            >
              <span aria-hidden="true" style={{ color: t.dim }}>
                <Ico d={ICONS.search} />
              </span>
              <input
                type="search"
                aria-label="Search logs"
                value={searchQuery}
                placeholder="Message, subject, step, job, run, backend..."
                onChange={(event) => setSearchQuery(event.target.value)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 24,
                  padding: '0 8px',
                  border: `1px solid ${t.dim}`,
                  borderRadius: 4,
                  background: t.bg,
                  color: t.text,
                  fontFamily: FONTS.sans,
                  fontSize: 11,
                }}
              />
              <Btn
                t={t}
                small
                ghost
                label="Clear"
                ariaLabel="Clear log search"
                icon={<Ico d={ICONS.x} size={ICON_SIZE.nav} />}
                onClick={() => setSearchQuery('')}
                disabled={searchQuery.length === 0}
              />
            </div>
            <span
              role="status"
              aria-live="polite"
              aria-label={`Showing ${visibleLogs.length} of ${runtime.logs.length} retained log lines`}
              style={{
                ...stateLineStyle(t, { size: 10.5, color: t.dim }),
                whiteSpace: 'nowrap',
              }}
            >
              {/* The counter shows only while a search or the level hides
                  lines. */}
              {visibleLogs.length === runtime.logs.length
                ? ''
                : `${visibleLogs.length} of ${lineCount(runtime.logs.length)}`}
            </span>
          </div>
          <div
            ref={streamRef}
            data-testid="log-stream"
            tabIndex={0}
            role="log"
            aria-label="Log stream output"
            onScroll={onStreamScroll}
            style={{
              flex: 1,
              overflow: 'auto',
              // While following, the stream owns its scroll position. Browser
              // scroll anchoring would otherwise shift it when the oldest lines
              // are evicted and fire a scroll that reads as a pause; a paused
              // reader keeps anchoring so the line in view stays put.
              overflowAnchor: tailing ? 'none' : 'auto',
              minHeight: 0,
              fontFamily: FONTS.mono,
              fontSize: density.font,
            }}
          >
            {runtime.hydrating ? (
              <div style={{ padding: 24 }}>
                <LoadingState t={t} label="Restoring runtime logs..." />
              </div>
            ) : visibleLogs.length === 0 ? (
              <EmptyState
                t={t}
                icon="logs"
                // The title states what matched nothing; the hint carries the
                // remedy, so no title opens with an order.
                message={
                  searchQuery.trim()
                    ? `No log lines match "${searchQuery.trim()}".`
                    : runtime.logs.length === 0
                      ? 'The log tail has no lines yet.'
                      : scope === 'selected' && selectedJob
                        ? absentCopy
                          ? absentCopy.message
                          : `No ${level}+ lines exist for ${jobIdentityLabel(selectedJob)}.`
                        : runAbsentFromTail
                          ? 'No lines from this run are in the retained log tail.'
                          : `No ${level}+ log lines appear in this scope.`
                }
                hint={
                  searchQuery.trim()
                    ? 'Clear the search or change the scope or level threshold.'
                    : absentCopy
                      ? absentCopy.hint
                      : runtime.logs.length === 0
                        ? BOUNDED_TAIL_NOTE
                        : scope === 'selected' && selectedJob
                          ? `Choose a lower level threshold to show its other lines. ${BOUNDED_TAIL_NOTE}`
                          : runAbsentFromTail
                            ? `The tail keeps only the newest ${runtime.logs.length} ${runtime.logs.length === 1 ? 'line' : 'lines'} across all runs. Choose another run in the Run list to see its lines. The complete job logs remain in backend-owned storage.`
                            : `Change the scope or level threshold. ${BOUNDED_TAIL_NOTE}`
                }
              />
            ) : (
              logGroups.map((group) => (
                <LogGroupBlock
                  key={group.key}
                  t={t}
                  group={group}
                  // The selected-job scope repeats one job's own header on
                  // every block, so the gutter and the message carry it alone.
                  showHeader={scope !== 'selected'}
                />
              ))
            )}
          </div>
          <footer
            style={{
              flexShrink: 0,
              borderTop: `1px solid ${t.border}`,
              padding: '5px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              ...stateLineStyle(t, { color: t.dim }),
            }}
          >
            <span>
              {lineCount(visibleLogs.length)}, {LEVEL_SCOPE[level]}
              {searchQuery.trim() ? `, matching "${searchQuery.trim()}"` : ''}
            </span>
            <span style={{ flex: 1 }} />
            <span aria-live="polite">{tailing ? '' : 'Paused'}</span>
          </footer>
        </section>

        <aside
          aria-label="Controls"
          data-layout-region="controls"
          style={{
            gridArea: 'controls',
            minWidth: 0,
            minHeight: 0,
            borderLeft:
              workspaceLayout === 'three-pane'
                ? `1px solid ${t.border}`
                : 'none',
            borderTop:
              workspaceLayout === 'three-pane'
                ? 'none'
                : `1px solid ${t.border}`,
            overflow: workspaceLayout === 'three-pane' ? 'auto' : 'visible',
            padding: density.pad,
            display: workspaceLayout === 'three-pane' ? 'flex' : 'grid',
            flexDirection:
              workspaceLayout === 'three-pane' ? 'column' : undefined,
            gridTemplateColumns:
              workspaceLayout === 'stacked-controls'
                ? 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))'
                : undefined,
            alignItems:
              workspaceLayout === 'stacked-controls' ? 'start' : undefined,
            gap: density.gap,
          }}
        >
          <Card t={t} title="Selected job" style={{ flexShrink: 0 }}>
            {selectedJob ? (
              <JobDetails
                t={t}
                job={selectedJob}
                run={selectedRun}
                supersededJob={
                  selectedJob.supersedesJobId
                    ? (jobsById.get(selectedJob.supersedesJobId) ?? null)
                    : null
                }
                copied={copiedKey === selectedJob.id}
                retryPhase={effectiveRetryPhase}
                retryBlockedReason={retryBlockedReason}
                planWaitReason={planWaitReason}
                onCopy={() => void copy(selectedJob.id, selectedJob.cmd)}
                onRetry={() => void retrySelected()}
              />
            ) : (
              <Hint t={t}>
                Selecting a durable job shows its command and provenance.
              </Hint>
            )}
          </Card>

          <Card t={t} padded={false} style={{ flexShrink: 0 }}>
            <Collapsible
              t={t}
              id="logs-run-details"
              open={runDetailsOpen}
              onToggle={() => setRunDetailsOpen((open) => !open)}
              header={
                <span
                  style={{
                    fontSize: 11,
                    color: t.dim,
                    fontFamily: FONTS.sans,
                    letterSpacing: 0.2,
                    fontWeight: 700,
                  }}
                >
                  Run details
                </span>
              }
            >
              <div style={{ padding: '0 12px 12px' }}>
                <ManifestSummary
                  t={t}
                  manifest={manifest}
                  error={manifestError}
                  runId={selectedJob?.runId ?? null}
                  copied={copiedKey === 'manifest-identifiers'}
                  onCopy={() => {
                    if (!manifest) return
                    void copy(
                      'manifest-identifiers',
                      manifestIdentifiers(manifest),
                    )
                  }}
                />
              </div>
            </Collapsible>
          </Card>

          <Card t={t} title="Debug bundle" style={{ flexShrink: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Btn
                t={t}
                small
                label={
                  debugLoading
                    ? 'Preparing the preview...'
                    : 'Export debug bundle...'
                }
                title="Previews the categories first, applies the required redaction, and writes only to a destination you approve."
                icon={<Ico d={ICONS.folder} size={ICON_SIZE.nav} />}
                onClick={() => void prepareDebugBundle()}
                disabled={!projectRef || !selectedJob?.runId || debugLoading}
                style={{ alignSelf: 'flex-start' }}
              />
              {bundleResult && (
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                >
                  <span
                    role="status"
                    style={{
                      ...stateLineStyle(t, { size: 10.5, color: t.done }),
                      wordBreak: 'break-word',
                    }}
                  >
                    {'Created the diagnostic bundle at '}
                    <InlineCode>{bundleResult.displayPath}</InlineCode>
                    {'.'}
                  </span>
                  <Btn
                    t={t}
                    small
                    ghost
                    label="Reveal bundle"
                    onClick={() => void revealBundle()}
                    style={{ alignSelf: 'flex-start' }}
                  />
                </div>
              )}
            </div>
          </Card>

          {(runtime.error || actionError) && (
            <ErrorState
              t={t}
              title={
                runtime.error
                  ? 'Could not recover runtime state.'
                  : 'The action failed.'
              }
              detail={runtime.error ?? actionError?.error.message}
              // A failed runtime restore is retried, as on Runs.
              {...(actionError?.reviewAgain
                ? {
                    onRetry: actionError.reviewAgain.run,
                    retryLabel: actionError.reviewAgain.label,
                  }
                : runtime.error
                  ? { onRetry: runtime.retryHydration }
                  : {})}
            />
          )}
          {actionNotice && (
            <ExecutionOutcomeNotice
              t={t}
              message={actionNotice}
              {...(actionOutcome
                ? {
                    blockers: actionOutcome.plan.blockers,
                    nodes: actionOutcome.plan.nodes,
                    onOpenRegistry: () => setRoute('registry'),
                  }
                : {})}
              {...(canNormalizeReconstructionCohort(actionOutcome)
                ? {
                    onNormalizeReconstructionCohort:
                      normalizeReconstructionCohort,
                  }
                : {})}
            />
          )}
        </aside>
      </div>

      {debugOpen && debugPreview && (
        <ConfirmDialog
          t={t}
          title="Confirm creation of a redacted debug bundle"
          message={
            <DebugCategorySelection
              t={t}
              preview={debugPreview}
              selected={categoryIds}
              onToggle={(id) => {
                setCategoryIds((current) => {
                  const next = new Set(current)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }}
            />
          }
          actions={[
            {
              label: 'Cancel',
              initialFocus: true,
              onSelect: () => setDebugOpen(false),
            },
            {
              label: 'Choose destination and create',
              tone: 'primary',
              disabled: categoryIds.size === 0,
              onSelect: () => void createDebugBundle(),
            },
          ]}
          onDismiss={() => setDebugOpen(false)}
          error={actionError?.error.message ?? null}
          busy={debugBusy}
        />
      )}
    </div>
  )
}

/**
 * State whether the stream follows its newest line. Following a live run
 * draws the running tone; following a run with no active job is only at the
 * latest line, so it stays neutral.
 */
function TailChip({
  t,
  tailing,
  live,
  lineCount,
}: {
  t: Theme
  tailing: boolean
  /** Whether the shown run still has an active job. */
  live: boolean
  lineCount: number
}): ReactNode {
  const following = tailing && live
  const label = following ? 'Tailing' : tailing ? 'At latest' : 'Paused'
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`${label}, ${lineCount} lines`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 3,
        fontFamily: FONTS.sans,
        fontSize: 11,
        background: following ? t.runningSoft : t.surface2,
        color: following ? t.text : t.dim,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          color: following ? t.running : t.dim,
        }}
      >
        {/* Ringed marks, as every status badge draws them. */}
        {following ? (
          <ChipGlyph t={t} status="running" />
        ) : (
          <Ico d={tailing ? ICONS.circleCheck : ICONS.circlePause} />
        )}
      </span>
      {label}
    </span>
  )
}

const RUN_FOCUS_ID = 'logs-run-focus'
const RUN_FOCUS_HINT_ID = 'logs-run-focus-hint'

/**
 * Name the run the rail's run-scoped groups follow, and focus another one.
 * The value is always the run in focus, so selecting a job of another run
 * moves it too; a focus run with no retained job keeps its own option.
 */
function RunFocusControl({
  t,
  selectRef,
  focusRunId,
  focusedRun,
  runs,
  onFocus,
}: {
  t: Theme
  /** The Run list, which takes focus when another screen hands a run over. */
  selectRef: Ref<HTMLSelectElement>
  focusRunId: string
  focusedRun: RunSnapshot | null
  runs: readonly RunSnapshot[]
  onFocus: (runId: string) => void
}): ReactNode {
  const listed = runs.some((run) => run.runId === focusRunId)
  const now = new Date()
  const focusedLabel = focusedRun
    ? runOptionLabel(focusedRun, now)
    : 'Run outside the loaded run history'
  const focusedTitle = focusedRun ? runOptionTitle(focusedRun) : focusedLabel
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label
        htmlFor={RUN_FOCUS_ID}
        style={{
          fontFamily: FONTS.sans,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.2,
          color: t.dim,
        }}
      >
        Run
      </label>
      <select
        ref={selectRef}
        id={RUN_FOCUS_ID}
        value={focusRunId}
        onChange={(event) => onFocus(event.target.value)}
        aria-describedby={RUN_FOCUS_HINT_ID}
        // The closed value is short enough for the rail at 135% text; the
        // tooltip adds the year and the seconds.
        title={focusedTitle}
        style={{
          height: 'var(--ss-input-h)',
          width: '100%',
          minWidth: 0,
          // At 1214 x 768 and 135% text the select is about 208 px wide
          // beside the rail's scrollbar, which a real run history shows
          // (215 px without one). A short start time of this year and the
          // longest outcome, "Storage error", need 187 px there; a run of
          // another year adds its year and can clip, and the tooltip keeps
          // the full label.
          padding: '0 4px',
          border: `1px solid ${t.dim}`,
          borderRadius: 4,
          background: t.bg,
          color: t.text,
          fontFamily: FONTS.sans,
          fontSize: 10.5,
          textOverflow: 'ellipsis',
        }}
      >
        {!listed && (
          <option value={focusRunId} title={focusedTitle}>
            {focusedLabel}
          </option>
        )}
        {runs.map((run) => (
          <option key={run.runId} value={run.runId} title={runOptionTitle(run)}>
            {runOptionLabel(run, now)}
          </option>
        ))}
      </select>
      <span id={RUN_FOCUS_HINT_ID} style={SR_ONLY}>
        Dry-run plans, Needs attention, and Blocked list the jobs of this run.
        Choosing a run selects its first job in the list.
      </span>
    </div>
  )
}

function RailHeader({
  t,
  label,
  count,
  hint,
}: {
  t: Theme
  label: string
  count: number
  hint?: string
}): ReactNode {
  const heading = (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}
    >
      <span
        style={{
          fontFamily: FONTS.sans,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.2,
          color: t.dim,
        }}
      >
        {label}
      </span>
      <StateLine t={t} size={10}>
        {count}
      </StateLine>
    </div>
  )
  if (!hint) return heading
  return (
    <>
      {heading}
      <div
        style={{
          fontFamily: FONTS.sans,
          fontSize: 10,
          lineHeight: 1.35,
          color: t.dim,
          margin: '-2px 0 4px',
        }}
      >
        {hint}
      </div>
    </>
  )
}

function JobRow({
  t,
  job,
  active,
  onSelect,
  rowRef,
}: {
  t: Theme
  job: Job
  active: boolean
  onSelect: () => void
  /** Register the row's button with the rail, or drop it (null). */
  rowRef: (el: HTMLButtonElement | null) => void
}): ReactNode {
  // Name the status as the badge does, so a canceled job is not announced
  // with the sidecar's spelling "cancelled".
  const accessibleLabel = `${job.subjectId ?? 'Cohort'}, ${shortStep(job)}, ${JOB_STATUS_LABEL[job.status]}, ${jobClockLabel(job)}.`
  const style: CSSProperties = {
    width: '100%',
    textAlign: 'left',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px',
    minHeight: 32,
    borderRadius: 5,
    border: `1px solid ${active ? t.border : 'transparent'}`,
    background: active ? t.surface2 : 'transparent',
    color: t.text,
    cursor: 'pointer',
  }
  return (
    <button
      ref={rowRef}
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      style={style}
    >
      {/* The status badge at the trailing edge is the row's only status
          mark, so the glyph and its word sit together once. */}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            // A subject ID is code-like; the cohort fallback is a word.
            fontFamily: job.subjectId === null ? FONTS.sans : FONTS.mono,
            fontSize: 11,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {job.subjectId ?? 'cohort'}
        </span>
        <span
          style={{
            display: 'block',
            fontFamily: FONTS.sans,
            fontSize: 10,
            color: t.dim,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {shortStep(job)}
        </span>
        <span
          aria-hidden="true"
          style={{
            display: 'block',
            // A state and its time read as a phrase, so both take the sans
            // face.
            fontFamily: FONTS.sans,
            fontSize: 9,
            color: t.dimText,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {jobClockLabel(job)}
        </span>
      </span>
      <JobStatusChip
        t={t}
        status={job.status}
        label={JOB_STATUS_LABEL[job.status]}
      />
    </button>
  )
}

function LogGroupBlock({
  t,
  group,
  showHeader,
}: {
  t: Theme
  group: LogGroup
  showHeader: boolean
}): ReactNode {
  const lines = group.lines.map((line) => (
    <LogLine key={line.id} t={t} line={line} />
  ))
  if (!showHeader) return <>{lines}</>
  const headerId = `log-group-${group.key}`
  return (
    <div role="group" aria-labelledby={headerId}>
      <LogGroupHeader id={headerId} t={t} group={group} />
      {lines}
    </div>
  )
}

function LogGroupHeader({
  id,
  t,
  group,
}: {
  id: string
  t: Theme
  group: LogGroup
}): ReactNode {
  const { job, run, identity } = group
  const meta = [
    runClockLabel(run, job),
    job ? backendLabel(job) : null,
    job?.attemptOrdinal === undefined ? null : `attempt ${job.attemptOrdinal}`,
  ].filter((entry): entry is string => Boolean(entry))
  return (
    <div
      id={id}
      // The header stays in view while its own block scrolls, so a long job
      // keeps naming the subject and step its lines belong to.
      {...(identity ? { title: identity } : {})}
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 1,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: 8,
        padding: '3px 12px',
        borderTop: `1px solid ${t.border}`,
        borderBottom: `1px solid ${t.borderSoft}`,
        background: t.surface2,
        fontFamily: FONTS.sans,
        fontSize: 10.5,
        color: t.dim,
      }}
    >
      {/* Keep the raw identifiers of an unattributed block in hidden text and
          the tooltip only; nothing else can attribute those lines. */}
      {identity && <span style={SR_ONLY}>{identity}</span>}
      <span
        style={{
          // A subject ID is code-like; the fallback words are not.
          fontFamily: job?.subjectId ? FONTS.mono : FONTS.sans,
          fontSize: 11,
          fontWeight: 700,
          color: t.textSoft,
        }}
      >
        {job ? (job.subjectId ?? 'cohort') : 'unattributed'}
      </span>
      {job && <span>{shortStep(job)}</span>}
      {meta.map((entry) => (
        <span key={entry} style={{ color: t.dimText }}>
          {entry}
        </span>
      ))}
    </div>
  )
}

function LogLine({ t, line }: { t: Theme; line: RuntimeLogLine }): ReactNode {
  const isError = line.level === 'ERROR'
  const isWarn = line.level === 'WARN'
  return (
    <div
      data-level={line.level}
      data-job-id={line.jobId}
      data-run-id={line.runId}
      style={{
        display: 'grid',
        gridTemplateColumns: LOG_LINE_COLS,
        gap: 8,
        padding: '1px 12px 1px 10px',
        borderLeft: `2px solid ${isError ? t.failed : isWarn ? t.warning : 'transparent'}`,
        background: isError ? t.failedSoft : 'transparent',
        lineHeight: 1.5,
      }}
    >
      <span
        data-testid="log-line-clock"
        style={{
          color: isError ? onFailureTint(t, t.dimText) : t.dimText,
          whiteSpace: 'nowrap',
        }}
      >
        {formatClock(line.at)}
      </span>
      {/* Only a warning or an error earns a marker; routine lines keep the
          column empty so the messages stay aligned. */}
      <span
        style={{
          color: statusColor(t, isError ? 'failed' : 'warn'),
          fontWeight: 700,
        }}
      >
        {isError || isWarn ? line.level : ''}
      </span>
      <span
        style={{
          color: isError ? t.failed : t.text,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {logLineText(line)}
      </span>
    </div>
  )
}

function RailSkeleton({ t }: { t: Theme }): ReactNode {
  return (
    <div
      aria-hidden="true"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      {[0, 1, 2].map((key) => (
        <div
          key={key}
          style={{
            height: 32,
            borderRadius: 5,
            background: t.surface2,
            opacity: 0.6,
          }}
        />
      ))}
    </div>
  )
}

function JobDetails({
  t,
  job,
  run,
  supersededJob,
  copied,
  retryPhase,
  retryBlockedReason,
  planWaitReason,
  onCopy,
  onRetry,
}: {
  t: Theme
  job: Job
  run: RunSnapshot | null
  supersededJob: Job | null
  copied: boolean
  /** Where a retry started from Logs is, or null when none is. */
  retryPhase: RetryPhase | null
  /** Why a job a later run superseded offers no retry, or null. */
  retryBlockedReason: string | null
  /** The plan another launch is preparing, which the retry waits for. */
  planWaitReason: string | null
  onCopy: () => void
  onRetry: () => void
}): ReactNode {
  // An ended job states its reason in the terminal outcome below.
  const activeReason = hasTerminalStatus(job)
    ? null
    : terminalReasonText(job.terminalReason)
  const retryLabel = RETRY_LABEL[job.status]
  // While its plan is open the retry reads as itself: nothing has started,
  // and the review holds every other control.
  const retryBusyLabel =
    retryPhase === null ? undefined : RETRY_BUSY_LABEL[retryPhase]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <JobStatusChip
          t={t}
          status={job.status}
          label={JOB_STATUS_LABEL[job.status]}
        />
        <StateLine t={t} size={10.5} color={t.dim}>
          {job.subjectId === null ? (
            jobIdentityLabel(job)
          ) : (
            <>
              <InlineCode>{job.subjectId}</InlineCode>
              {` / ${shortStep(job)}`}
            </>
          )}
        </StateLine>
      </div>
      {/* The normal case needs no sentence; only an unusual run states
          itself. */}
      {(!job.runId || !run || run.dryRun) && (
        <Hint t={t}>
          {job.runId
            ? run
              ? 'This run is a dry run.'
              : 'The run of this job is outside the loaded run history.'
            : 'This job has no durable run identity.'}
        </Hint>
      )}
      {activeReason && <Hint t={t}>{activeReason}</Hint>}
      <TerminalOutcomeDetails t={t} job={job} />
      <ReconstructionAttemptProvenance
        t={t}
        job={job}
        supersededJob={supersededJob}
      />
      <div
        role="group"
        aria-label="Selected job actions"
        data-layout-region="selected-job-actions"
        style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
      >
        {retryLabel !== undefined && (
          <Btn
            t={t}
            small
            label={retryBusyLabel ?? retryLabel}
            icon={<Ico d={ICONS.play} size={ICON_SIZE.nav} />}
            onClick={onRetry}
            // A superseded job keeps no retry: see retryBlockedReason.
            disabled={
              !canRetry(job) ||
              retryBusyLabel !== undefined ||
              retryBlockedReason !== null ||
              planWaitReason !== null
            }
            title={
              !job.nodeId
                ? 'This job has no durable workflow identity.'
                : (retryBlockedReason ?? planWaitReason ?? undefined)
            }
            style={{ alignSelf: 'flex-start' }}
          />
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span
            style={{
              fontFamily: FONTS.sans,
              fontSize: 10.5,
              fontWeight: 700,
              color: t.dim,
            }}
          >
            Command
          </span>
          <IconButton
            t={t}
            d={copied ? ICONS.check : ICONS.copy}
            ariaLabel={copied ? 'Copied' : 'Copy command'}
            title={copied ? 'Copied' : 'Copy command'}
            onClick={onCopy}
            disabled={!job.cmd}
            size={24}
            iconSize={ICON_SIZE.inline}
          />
        </div>
      </div>
      {retryBlockedReason && <Hint t={t}>{retryBlockedReason}</Hint>}
      {job.cmd ? (
        <pre
          // The command block scrolls, so give it a tab stop and a name; the
          // global :focus-visible rule supplies its focus ring. A bare pre has
          // no implicit role, which prohibits aria-label, so name a group.
          role="group"
          tabIndex={0}
          aria-label="Job command"
          style={{
            margin: 0,
            padding: '7px 8px',
            maxHeight: 180,
            overflow: 'auto',
            background: t.bg,
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 4,
            fontFamily: FONTS.mono,
            fontSize: 10.5,
            color: t.text,
            whiteSpace: 'pre-wrap',
          }}
        >
          {/* Wrap only at whitespace: a hyphen is a line-break opportunity,
              which split "-openmp" and "sub-001" across lines. A token wider
              than the block scrolls instead. The text stays exact for
              selection. */}
          {job.cmd.split(/(\s+)/).map((part, index) =>
            index % 2 === 1 || part === '' ? (
              part
            ) : (
              <span key={index} style={{ whiteSpace: 'nowrap' }}>
                {part}
              </span>
            ),
          )}
        </pre>
      ) : (
        <Hint t={t}>This job has no recorded command.</Hint>
      )}
    </div>
  )
}

function TerminalOutcomeDetails({ t, job }: { t: Theme; job: Job }): ReactNode {
  if (!hasTerminalStatus(job)) return null
  const failed = job.status === 'failed'
  const label = failed ? onFailureTint(t, t.dim) : t.dim
  const reason = terminalReasonText(job.terminalReason)
  return (
    <section
      aria-labelledby="job-terminal-outcome-heading"
      style={{
        padding: '7px 8px',
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 4,
        background: failed ? t.failedSoft : t.surface2,
      }}
    >
      <h3
        id="job-terminal-outcome-heading"
        style={{
          margin: '0 0 6px',
          color: failed ? t.failed : t.text,
          fontFamily: FONTS.sans,
          fontSize: 10.5,
          fontWeight: 700,
        }}
      >
        Result
      </h3>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr)',
          gap: '4px 8px',
          margin: 0,
          fontSize: 10.5,
        }}
      >
        <dt style={{ color: label, fontFamily: FONTS.sans }}>Exit code</dt>
        <dd
          style={{
            margin: 0,
            color:
              job.exitCode !== null && job.exitCode !== 0 ? t.failed : t.text,
            fontFamily: job.exitCode === null ? FONTS.sans : FONTS.mono,
          }}
        >
          {job.exitCode ?? 'Not recorded'}
        </dd>
        {/* A clean exit with no recorded reason needs no Reason row. */}
        {(reason !== null || job.exitCode !== 0) && (
          <>
            <dt style={{ color: label, fontFamily: FONTS.sans }}>Reason</dt>
            <dd
              style={{
                margin: 0,
                color: t.text,
                fontFamily: FONTS.sans,
                overflowWrap: 'anywhere',
              }}
            >
              {reason ?? 'Not recorded'}
            </dd>
          </>
        )}
        {job.failureCause && (
          <>
            <dt style={{ color: label, fontFamily: FONTS.sans }}>Cause</dt>
            <dd
              style={{
                margin: 0,
                color: t.text,
                fontFamily: FONTS.sans,
                overflowWrap: 'anywhere',
              }}
            >
              {/[.!?]$/.test(job.failureCause)
                ? job.failureCause
                : `${job.failureCause}.`}
            </dd>
          </>
        )}
        {job.executionFallback && (
          <>
            <dt style={{ color: label, fontFamily: FONTS.sans }}>Rerun</dt>
            <dd
              style={{
                margin: 0,
                color: t.text,
                fontFamily: FONTS.sans,
                overflowWrap: 'anywhere',
              }}
            >
              <span style={{ display: 'block', fontWeight: 600 }}>
                {executionFallbackFact(job.executionFallback)}.
              </span>
              <span style={{ display: 'block', color: t.textSoft }}>
                {executionFallbackDetail(job.executionFallback)}
              </span>
            </dd>
          </>
        )}
        {job.unitReuse && (
          <>
            <dt style={{ color: label, fontFamily: FONTS.sans }}>Subjects</dt>
            <dd
              style={{
                margin: 0,
                color: t.text,
                fontFamily: FONTS.sans,
                overflowWrap: 'anywhere',
              }}
            >
              {unitReuseFact(
                job.unitReuse,
                job.status === 'done' ? 'past' : 'present',
              )}
            </dd>
          </>
        )}
      </dl>
    </section>
  )
}

function supersededAttemptLabel(superseded: Job | null): string {
  if (!superseded) return 'an earlier attempt in this run'
  const backend = backendLabel(superseded)
  const attempt =
    superseded.attemptOrdinal !== undefined
      ? `attempt ${superseded.attemptOrdinal}`
      : 'an earlier attempt'
  return backend ? `${attempt} (${backend})` : attempt
}

function ReconstructionAttemptProvenance({
  t,
  job,
  supersededJob,
}: {
  t: Theme
  job: Job
  supersededJob: Job | null
}): ReactNode {
  const entries: Array<{
    label: string
    value: string
    mono?: boolean
  }> = []
  if (job.backend) {
    entries.push({
      label: 'Backend',
      value: job.backend === 'fastsurfer' ? 'FastSurfer' : 'FreeSurfer',
    })
  }
  if (job.attemptOrdinal !== undefined) {
    entries.push({ label: 'Attempt', value: String(job.attemptOrdinal) })
  }
  if (job.role) {
    const roleLabel = {
      primary: 'Primary',
      'superseded-primary': 'Superseded primary',
      fallback: 'Fallback',
    }[job.role]
    entries.push({ label: 'Role', value: roleLabel })
  }
  if (job.supersedesJobId) {
    entries.push({
      label: 'Supersedes',
      value: supersededAttemptLabel(supersededJob),
    })
  }
  if (job.fallbackReasonTag) {
    entries.push({
      label: 'Fallback reason',
      value: job.fallbackReasonTag,
      mono: true,
    })
  }
  if (entries.length === 0) return null

  return (
    <section
      aria-labelledby="job-reconstruction-provenance-heading"
      style={{
        padding: '7px 8px',
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 4,
        background: t.surface2,
      }}
    >
      <h3
        id="job-reconstruction-provenance-heading"
        style={{
          margin: '0 0 6px',
          color: t.text,
          fontFamily: FONTS.sans,
          fontSize: 10.5,
          fontWeight: 700,
        }}
      >
        Reconstruction attempt provenance
      </h3>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr)',
          gap: '4px 8px',
          margin: 0,
          fontSize: 10.5,
        }}
      >
        {entries.map((entry) => (
          <Fragment key={entry.label}>
            <dt style={{ color: t.dim, fontFamily: FONTS.sans }}>
              {entry.label}
            </dt>
            <dd
              style={{
                margin: 0,
                color: t.text,
                fontFamily: entry.mono ? FONTS.mono : FONTS.sans,
                overflowWrap: 'anywhere',
              }}
            >
              {entry.value}
            </dd>
          </Fragment>
        ))}
      </dl>
    </section>
  )
}

/**
 * Name the product version that wrote a manifest, with its build when the
 * manifest records one; a manifest from before build identities names the
 * version alone.
 */
function manifestProductLabel(
  product: NonNullable<RunManifest['product']>,
  git: RunManifest['git'],
): string {
  if (product.build === undefined) {
    return `${product.name} ${formatAppVersion(product.version)}`
  }
  const build = manifestBuild(product.build, git)
  return `${product.name} ${describeProductVersion(product.version, build)}`
}

/** The build identity a run manifest records for its product. */
function manifestBuild(
  kind: NonNullable<NonNullable<RunManifest['product']>['build']>,
  git: RunManifest['git'],
): ReturnType<typeof parseBuildIdentity> {
  return parseBuildIdentity({ kind, commit: git.sha, dirty: git.dirty })
}

/** The commit hash inside {@link manifestProductLabel}, to set in mono. */
function manifestShortCommit(
  product: NonNullable<RunManifest['product']>,
  git: RunManifest['git'],
): string[] {
  if (product.build === undefined) return []
  const commit = shortBuildCommit(manifestBuild(product.build, git))
  return commit === null ? [] : [commit]
}

/**
 * Build the copyable identifier block for a run manifest.
 *
 * @returns One identifier per line, omitting unknown identities.
 */
function manifestIdentifiers(manifest: RunManifest): string {
  const lines = [`run ${manifest.runId}`, `config ${manifest.configSha256}`]
  if (manifest.product) {
    lines.push(
      `version ${manifestProductLabel(manifest.product, manifest.git)}`,
    )
  }
  if (manifest.git.sha) {
    lines.push(`git ${manifest.git.sha}${manifest.git.dirty ? ' (dirty)' : ''}`)
  }
  return lines.join('\n')
}

/**
 * State a run manifest's scope: how many subjects its run selected, or that
 * the manifest records no selection.
 *
 * @returns The scope, such as "1 subject", "82 subjects", or "Not recorded".
 */
function manifestScopeText(manifest: RunManifest): string {
  const count = manifest.selectedSubset?.subjectIds.length
  if (count === undefined) return 'Not recorded'
  return `${count} subject${count === 1 ? '' : 's'}`
}

function ManifestSummary({
  t,
  manifest,
  error,
  runId,
  copied,
  onCopy,
}: {
  t: Theme
  manifest: RunManifest | null
  error: string | null
  runId: string | null
  copied: boolean
  onCopy: () => void
}): ReactNode {
  if (error)
    return (
      <ErrorState t={t} title="Could not load the manifest." detail={error} />
    )
  if (!runId)
    return <Hint t={t}>No job with a durable run identity is selected.</Hint>
  if (!manifest) return <LoadingState t={t} label="Loading the manifest..." />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '5px 8px',
          margin: 0,
          fontSize: 10.5,
        }}
      >
        <dt style={{ color: t.dim, fontFamily: FONTS.sans }}>Run</dt>
        <dd
          style={{
            margin: 0,
            color: t.text,
            fontFamily: FONTS.mono,
            wordBreak: 'break-word',
          }}
        >
          {manifest.runId}
        </dd>
        <dt style={{ color: t.dim, fontFamily: FONTS.sans }}>Config</dt>
        <dd
          title={manifest.configSha256}
          style={{
            margin: 0,
            color: t.text,
            fontFamily: FONTS.mono,
            whiteSpace: 'nowrap',
          }}
        >
          {middleEllipsis(manifest.configSha256)}
        </dd>
        {manifest.product ? (
          <>
            <dt style={{ color: t.dim, fontFamily: FONTS.sans }}>Version</dt>
            <dd style={{ margin: 0, color: t.text, fontFamily: FONTS.sans }}>
              <CodeText
                text={manifestProductLabel(manifest.product, manifest.git)}
                code={manifestShortCommit(manifest.product, manifest.git)}
              />
            </dd>
          </>
        ) : null}
        {manifest.git.sha ? (
          <>
            <dt style={{ color: t.dim, fontFamily: FONTS.sans }}>Git</dt>
            <dd
              title={manifest.git.sha}
              style={{
                margin: 0,
                color: t.text,
                fontFamily: FONTS.mono,
                whiteSpace: 'nowrap',
              }}
            >
              {middleEllipsis(manifest.git.sha)}
              {manifest.git.dirty ? ' (dirty)' : ''}
            </dd>
          </>
        ) : null}
        <dt style={{ color: t.dim, fontFamily: FONTS.sans }}>Scope</dt>
        <dd style={{ margin: 0, color: t.text, fontFamily: FONTS.sans }}>
          {manifestScopeText(manifest)}
        </dd>
      </dl>
      <Btn
        t={t}
        small
        ghost
        label={copied ? 'Copied' : 'Copy identifiers'}
        icon={<Ico d={ICONS.copy} size={ICON_SIZE.nav} />}
        onClick={onCopy}
        style={{ alignSelf: 'flex-start' }}
      />
    </div>
  )
}

function DebugCategorySelection({
  t,
  preview,
  selected,
  onToggle,
}: {
  t: Theme
  preview: DebugBundlePreview
  selected: Set<string>
  onToggle: (id: string) => void
}): ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ margin: 0 }}>
        The bundle includes the selected categories. Creating it confirms
        consent to export them under the required redaction policy.
      </p>
      <div
        style={{
          padding: 8,
          border: `1px solid ${t.borderSoft}`,
          borderRadius: 5,
          background: t.surface2,
        }}
      >
        <strong>Redaction policy:</strong> {preview.redactionPolicy}
      </div>
      {preview.categories.length === 0 ? (
        <span style={{ color: t.dim }}>
          This run has no exportable debug categories.
        </span>
      ) : (
        preview.categories.map((category) => (
          <label
            key={category.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '18px 1fr',
              gap: 8,
              alignItems: 'start',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={selected.has(category.id)}
              onChange={() => onToggle(category.id)}
            />
            <span>
              <strong>{category.label}</strong>
              <span style={{ display: 'block', color: t.dim, fontSize: 11 }}>
                {fileCountText(category.fileCount)},{' '}
                {formatBytes(category.estimatedBytes)}
                {category.truncated ? ', preview truncated' : ''}
              </span>
              {category.redactions.length > 0 && (
                <span style={{ display: 'block', color: t.dim, fontSize: 11 }}>
                  Redacts: {category.redactions.join(', ')}
                </span>
              )}
            </span>
          </label>
        ))
      )}
      <span style={{ color: t.dim, fontSize: 11 }}>
        Preview total: {fileCountText(preview.totalFiles)},{' '}
        {formatBytes(preview.estimatedBytes)}
        {preview.truncated ? ' (truncated)' : ''}.
      </span>
    </div>
  )
}
