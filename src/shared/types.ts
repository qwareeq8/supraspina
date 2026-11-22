import type { BuildKind } from './build-identity'
import type { ExecutionFallback } from './execution-fallback'
import type { UnitReuseSummary } from './unit-reuse'
import type { StepKey, StepScope } from './steps'

/** One open project and its current generation. */
export interface ProjectRef {
  projectId: string
  root: string
  configPath: string
  epoch: number
}

/** Registry cohorts restricted to accepted canonical values. */
export type RegistryCohort = 'CTRL' | 'SCI_nNP' | 'SCI_P'
/** Unresolved cohort membership included in renderer state. */
export type Cohort = RegistryCohort | 'UNKNOWN'

/** A classification of cohort membership by analysis meaning. */
export type CohortRole =
  | 'healthy'
  | 'sci-no-neuropathic-pain'
  | 'sci-neuropathic-pain'
  | 'ambiguous'

/** Stored injury grades restricted to accepted AIS values. */
export type AisGrade = 'A' | 'B' | 'C' | 'D'

/** Stored sex values restricted to accepted registry codes. */
export type Sex = 'M' | 'F' | 'O'

/** One subject-matrix cell lifecycle state. */
export type CellState =
  | 'pending'
  | 'planned'
  | 'waiting'
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'withheld'
  | 'interrupted'
  | 'stale'
  | 'skipped'
  /**
   * A finished cell whose stage the planner would run again. The renderer
   * marks it from stage currency for display; the sidecar never reports it.
   */
  | 'outdated'

/** One explicit QC review verdict. */
export type QcVerdict = 'pass' | 'fail' | 'defer'

/** One visual status-chip treatment. */
export type ChipStatus =
  | 'found'
  | 'missing'
  | 'wrong'
  | 'warn'
  | 'skipped'
  | 'done'
  | 'running'
  | 'failed'
  | 'pending'
  | 'queued'
  | 'pass'
  | 'fail'
  | 'review'
  | 'exclude'
  | 'unreviewed'
  | 'ok'
  | 'na'
  | 'partial'
  | 'planned'
  | 'waiting'
  | 'blocked'
  | 'withheld'
  | 'cancelled'
  | 'cancelling'
  | 'interrupted'
  | 'stale'
  /**
   * A finished matrix cell the renderer marks out of date from stage
   * currency; the sidecar never reports it.
   */
  | 'outdated'

/** One subject-matrix cell and its execution evidence. */
export interface Cell {
  st: CellState
  startedAt: number | null
  finishedAt: number | null
  progress: number | null
  rc: number | null
  err: string | null
  /**
   * The rerun the cell's job made after a known failure, such as "Reran with
   * -no-fix-ga", with its reason, or absent when it made none.
   */
  rerun?: { fact: string; detail: string }
}

/** One discovered subject and its current workflow state. */
export interface Subject {
  id: string
  /** The age at scan in years, or null when it is unknown or unregistered. */
  age: number | null
  sex: Sex
  cohort: Cohort
  ais: AisGrade | null
  tSinceSci: number | null
  cells: Cell[]
  stepStates?: Partial<Record<StepKey, CellState>>
  qc: QcVerdict | null
  recordedQcVerdict?: QcVerdict | null
  qcReviewEvidencePresent?: boolean
  notes: string
  qcTags?: string[]
  qcRevision?: number
  /** The source cohort value before semantic alias resolution. */
  sourceCohortLabel?: string
  cohortRole?: CohortRole
  t1Availability?: 'available' | 'missing' | 'ambiguous'
  analysisEligible: boolean
  unavailableReason?: string | null
  integrityErrors?: string[]
  /** Whether the subject carries a registry record of its own. */
  registered: boolean
  /** The registry site (scanner plus protocol), or null when unset. */
  site?: string | null
}

/** Create one pending subject-matrix cell without runtime evidence. */
export function emptyCell(): Cell {
  return {
    st: 'pending',
    startedAt: null,
    finishedAt: null,
    progress: null,
    rc: null,
    err: null,
  }
}

/**
 * One typed in-app remediation an environment check offers. The renderer sends
 * back only the owning check's id; the sidecar derives every path and argument
 * from the saved configuration when the gated operation runs.
 */
export interface EnvCheckAction {
  /** The gated product operation this check offers. */
  kind: 'create-directory' | 'setup-pybrainage'
  /** The action-button label naming the operation. */
  label: string
}

/** One environment dependency check. */
export interface EnvCheck {
  id: string
  /** The display label. */
  label: string
  status: 'found' | 'missing' | 'wrong' | 'warn' | 'skipped'
  detail?: string
  recommendedCmd?: string
  installable?: boolean
  /**
   * Whether the in-app installer only rebuilds verified files already on this
   * machine and downloads nothing. The sidecar sets it only on a runnable
   * installer.
   */
  offlineInstall?: boolean
  downloadUrl?: string
  action?: EnvCheckAction
}

/** A group of related environment dependency checks. */
export interface EnvGroup {
  name: string
  checks: EnvCheck[]
}

/** One complete timestamped environment report. */
export interface EnvReport {
  groups: EnvGroup[]
  availableMemoryGB: number | null
  capturedAt: string
}

/** The outcome of one gated output-directory creation. */
export interface EnvCreateDirResult {
  /** Whether the directory now exists as a verified writable directory. */
  ok: boolean
  /** The outcome sentence naming the sidecar-resolved directory. */
  detail: string
}

/**
 * One concise scientific-tool status item. Report `na` for a tool the saved
 * pipeline configuration does not use, and for a check the sidecar skipped.
 */
export interface ToolStatusItem {
  id: string
  label: string
  status: 'ok' | 'warn' | 'missing' | 'na'
}

/** A summary of the scientific tools required by a project. */
export interface ToolStatus {
  items: ToolStatusItem[]
  summary: 'ok' | 'warn' | 'missing'
  capturedAt: string
}

/** One condition that blocks a pipeline stage. */
export interface StageBlocker {
  key: StepKey
  reason: string
  kind?:
    | 'config'
    | 'environment'
    | 'dependency'
    | 'cohort'
    | 'input-qc'
    | 'safety'
    | 'persistence'
    /** A runtime detector or readiness failure found while planning. */
    | 'runtime'
    /** A derivative integrity failure found while planning. */
    | 'integrity'
  action?: string
  /** Every subject the reason applies to, including those its prose samples. */
  subjects?: string[]
  /** The count of affected subjects, equal to the length of `subjects`. */
  subjectCount?: number
}

/** One durable scientific-job lifecycle state. */
export type JobStatus =
  | 'planned'
  | 'waiting'
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'withheld'
  | 'interrupted'
  | 'stale'
  | 'persistence-error'
  | 'unknown'

/** A classification of one published runtime log line. */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

/** The reconstruction backend used by a job. */
export type ReconstructionJobBackend = 'freesurfer' | 'fastsurfer'

/** A classification of a reconstruction attempt within its fallback chain. */
export type ReconstructionJobRole =
  | 'primary'
  | 'superseded-primary'
  | 'fallback'

/** One planned or durable scientific job. */
export interface Job {
  id: string
  runId?: string
  nodeId?: string
  projectId?: string
  projectEpoch?: number
  sidecarGeneration?: number
  stepKey: StepKey
  subjectId: string | null
  scope?: StepScope
  startedAt: number | null
  plannedAt?: number
  endedAt: number | null
  exitCode: number | null
  cmd: string
  stdoutPath: string
  stderrPath: string
  envSnapshotPath: string
  configSnapshotPath: string
  status: JobStatus
  dryRun?: boolean
  durable?: boolean
  persistenceStatus?: 'pending' | 'durable' | 'error'
  terminalReason?: string | null
  /**
   * The cause the sidecar read from a failed Reconstruction's own output, for
   * example "label-cortex failed: found no voxels matching id 1", which
   * recon-all's closing line in the terminal reason does not state.
   */
  failureCause?: string
  /**
   * The flags a FreeSurfer Reconstruction reran with after a known failure,
   * and why; present once the first rerun starts, whatever the job's outcome.
   */
  executionFallback?: ExecutionFallback
  /**
   * Which subjects a cohort stage with per-subject units computes and which
   * keep verified earlier output; present once the launch has decided.
   */
  unitReuse?: UnitReuseSummary
  backend?: ReconstructionJobBackend
  attemptOrdinal?: number
  role?: ReconstructionJobRole
  supersedesJobId?: string
  fallbackReasonTag?: string
}

/**
 * Every state reported for a pipeline stage in a durable run manifest. A stage
 * reports `skipped` when the run skipped every one of its nodes.
 */
export type ManifestStepStatus = JobStatus | 'skipped'

/** A summary of one pipeline stage in a durable run manifest. */
export interface ManifestStep {
  id: number
  key: StepKey
  status: ManifestStepStatus
  subjects: number
  failed: number
  durationSec: number
}

/** The reproducibility manifest for one workflow run. */
export interface RunManifest {
  schemaVersion?: number
  runId: string
  project?: ProjectRef
  startedAt: string
  endedAt: string | null
  user: string
  host: string
  /**
   * The product version that wrote the manifest and how its build relates to
   * that version's release tag. A manifest may omit the product or its build.
   */
  product?: { name: string; version: string; build?: BuildKind }
  /**
   * The build's source commit and whether tracked files differed from it, or
   * an empty `sha` when the build recorded no commit.
   */
  git: { repo: string; sha: string; dirty: boolean }
  configSha256: string
  intent?: 'workflow' | 'stage' | 'resume' | 'retry'
  analysisCohort?: { subjectIds: string[]; sha256: string }
  selectedSubset?: { subjectIds: string[]; sha256: string }
  dryRun?: boolean
  graph?: {
    nodes: number
    edges: number
    terminal: number
    blocked: number
  }
  failurePolicy?: {
    stopOnError: boolean
    continueIndependentAfterError: boolean
  }
  recovery?: {
    state: 'current' | 'interrupted' | 'reconciled' | 'unknown'
    detail?: string
  }
  steps: ManifestStep[]
  tools: Record<string, string>
}

/** Rank failed, active, pending, and complete subjects for state sorting. */
export function subjectStateScore(subject: Subject): 0 | 1 | 2 | 3 {
  if (
    subject.cells.some((cell) =>
      ['failed', 'blocked', 'withheld', 'interrupted', 'stale'].includes(
        cell.st,
      ),
    )
  ) {
    return 0
  }
  if (
    subject.cells.some((cell) =>
      ['planned', 'waiting', 'queued', 'running', 'cancelling'].includes(
        cell.st,
      ),
    )
  ) {
    return 1
  }
  if (subject.cells.every((cell) => cell.st === 'done')) return 3
  return 2
}

/**
 * Return the latest recorded matrix-cell timestamp for a subject.
 *
 * @returns The latest timestamp, or zero when none exists.
 */
export function subjectUpdatedAt(subject: Subject): number {
  return Math.max(
    0,
    ...subject.cells.map((c) => c.finishedAt ?? c.startedAt ?? 0),
  )
}
